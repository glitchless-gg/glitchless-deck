// The page: `glitchless-deck ui` serves it at http://localhost:8791. It shows the Deck and every game this
// computer can send, and runs the same commands as the CLI (one at a time, with their output live).
//
// It answers this computer only: it listens on 127.0.0.1, a request has to name localhost as its host (so
// no other site can reach it under a name of its own), and anything that acts has to carry the page's own
// header, which a browser will not add for another site without asking first (this server never says yes).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareRuns } from 'glitchless-playtest';
import { loadDecks, loadGames } from './config.js';
import { status } from './deck.js';
import { isKiosk } from './send.js';
import { buildStep } from './engines.js';
import { loadRun, toRun } from './measure.js';
import { Problem } from './util.js';

export const UI_PORT = 8791;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'ui');
const BIN = path.join(HERE, '..', 'bin', 'glitchless-deck.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };

/** One command at a time, with what it printed. */
export class Job {
  constructor(cwd) {
    this.cwd = cwd;
    this.lines = [];
    this.running = false;
    this.title = '';
    this.ok = null;
    this.code = null;
  }

  start(title, args) {
    if (this.running) return false;
    Object.assign(this, { lines: [], running: true, title, ok: null, code: null });
    const child = spawn(process.execPath, [BIN, ...args], { cwd: this.cwd, env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: true });
    let pending = '';
    const take = (chunk) => {
      pending += chunk.toString('utf8');
      const parts = pending.split(/\r\n|\n/);
      pending = parts.pop();
      // rsync and the tar progress redraw with carriage returns: keep the last of each.
      for (const line of parts) this.lines.push(line.split('\r').pop());
      if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => {
      if (pending) this.lines.push(pending);
      Object.assign(this, { running: false, code, ok: code === 0 });
      this.onDone?.();
    });
    return true;
  }
}

function summary(run) {
  if (!run) return null;
  const m = run.measure || {};
  return { name: run.name, created: run.created, fps: m.fps ?? null, p95: m.frame_ms?.p95 ?? null, slow_pct: m.pct_frames_over_budget ?? null, hitches: m.hitch_count ?? null, update_ms: m.update_cpu_ms?.p50 ?? m.process_ms?.p50 ?? null, render_ms: m.render_cpu_ms?.p50 ?? null };
}

function gameState(g) {
  let built = 0;
  let ready = false;
  try {
    ready = fs.readdirSync(g._folder).length > 0;
    const start = path.resolve(g._folder, g._argv[0]);
    built = (fs.existsSync(start) ? fs.statSync(start) : fs.statSync(g._folder)).mtimeMs;
  } catch {}
  const latest = loadRun(g, 'latest');
  const baseline = loadRun(g, 'baseline');
  let verdict = null;
  if (latest && baseline && latest.created !== baseline.created) {
    try {
      const c = compareRuns(toRun(baseline), toRun(latest));
      verdict = { verdict: c.verdict, regressions: c.regressions.map((r) => r.label), ids: c.regressions.map((r) => r.id) };
    } catch {}
  }
  return { id: g.id, name: g.name || g.id, engine: g.engine || null, proton: !!g.proton, web: isKiosk(g), builds: !!buildStep(g), ready, built, folder: g._folder, folder_rel: path.relative(g._root, g._folder) || '.', file: g._file, artwork: !!g.artwork, latest: summary(latest), baseline: summary(baseline), verdict };
}

const ACTIONS = {
  send: (a) => [`Sending ${a.game}`, ['send', a.game, ...(a.build === false ? ['--no-build'] : []), ...(a.glitchless ? ['--glitchless'] : []), ...(a.launch ? ['--launch'] : [])]],
  launch: (a) => [`Starting ${a.game}`, ['launch', a.game]],
  stop: (a) => [`Closing ${a.game}`, ['stop', a.game]],
  logs: (a) => [`Logs of ${a.game}`, ['logs', a.game]],
  measure: (a) => [`Measuring ${a.game}`, ['measure', a.game, '--seconds', String(Math.max(3, Math.min(120, Number(a.seconds) || 10))), ...(a.save ? ['--save', String(a.save).replace(/[^A-Za-z0-9._-]/g, '')] : []), ...(a.glitchless ? ['--glitchless'] : [])]],
  remove: (a) => [`Taking ${a.game} off the Deck`, ['remove', a.game]],
  pair: (a) => ['Pairing', ['pair', ...(a.address ? [String(a.address)] : [])]],
};

export function createUi({ cwd = process.cwd(), version = '' } = {}) {
  const job = new Job(cwd);
  const deckState = { at: 0, value: null, pending: null };
  const fresh = async (force) => {
    if (!force && deckState.value && Date.now() - deckState.at < 20000) return deckState.value;
    deckState.pending ??= status().then(
      (v) => Object.assign(deckState, { value: v, at: Date.now(), pending: null }).value,
      (err) => Object.assign(deckState, { value: { paired: false, error: err.message, found: [] }, at: Date.now(), pending: null }).value,
    );
    return deckState.pending;
  };
  job.onDone = () => {
    deckState.at = 0;
  };

  const json = (res, data, code = 200) => {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  return http.createServer(async (req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return json(res, { error: 'forbidden' }, 403);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/state') {
      let games = [];
      let problem = '';
      try {
        games = loadGames({ cwd }).map(gameState);
      } catch (err) {
        problem = err.message;
      }
      const deck = await fresh(url.searchParams.has('fresh'));
      return json(res, { version, cwd, games, problem, deck, decks: loadDecks(), job: { running: job.running, title: job.title, ok: job.ok, code: job.code, lines: job.lines.slice(-200) } });
    }
    if (req.method === 'POST') {
      if (req.headers['x-glitchless-deck'] !== '1') return json(res, { error: 'forbidden' }, 403);
      const action = ACTIONS[url.pathname.replace(/^\/api\//, '')];
      if (!action) return json(res, { error: 'unknown' }, 404);
      let body = '';
      for await (const chunk of req) body += chunk;
      let asked = {};
      try {
        asked = JSON.parse(body || '{}');
      } catch {}
      if (asked.game != null && !/^[A-Za-z_][A-Za-z0-9_.]+$/.test(String(asked.game))) return json(res, { error: 'bad game' }, 400);
      const [title, args] = action(asked);
      return json(res, { started: job.start(title, args) });
    }
    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const file = path.join(ASSETS, name);
      if (fs.existsSync(file) && TYPES[path.extname(file)]) {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    json(res, { error: 'not found' }, 404);
  });
}

export function startUi({ port = UI_PORT, cwd = process.cwd(), log = console.log } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const server = createUi({ cwd, version: pkg.version });
  return new Promise((resolve, reject) => {
    server.on('error', (err) => reject(err.code === 'EADDRINUSE' ? new Problem(`Port ${port} is taken. Try glitchless-deck ui --port ${port + 1}`) : err));
    server.listen(port, '127.0.0.1', () => {
      log(`Glitchless Deck: http://localhost:${port}`);
      resolve(server);
    });
  });
}
