// Measuring a game on the Deck. Unity, Godot (and Unreal, with its plugin) builds with the Glitchless
// SDK measure themselves when started with --glitchless-measure=SECONDS: they write frame-time stats as
// JSON and quit. On the Deck the game has to be started by Steam to run as players see it (Gaming Mode,
// gamescope, the Deck's own frame limiter), so the measure run is a second library entry,
// "Devkit Game: <id>_measure", pointing at the same files with the measure flags added.
//
// Each run is saved in the project as .glitchless/deck/<id>/<name>.json, and compared with a saved run
// by glitchless-playtest's compareRuns, so the verdict uses the same thresholds as playtest bots.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareRuns } from 'glitchless-playtest';
import { MEASURE_SUFFIX } from './config.js';
import { reach } from './deck.js';
import { resolveArgv } from './engines.js';
import { intakeFlags } from './glitchless.js';
import { install, isKiosk } from './send.js';
import { helper } from './ssh.js';
import { Problem } from './util.js';

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

export const runsDir = (game) => path.join(game._root, '.glitchless', 'deck', game.id);

export function saveRun(game, name, run) {
  if (!NAME.test(name)) throw new Problem(`Run name "${name}" must be 1-64 letters, digits, dots, dashes or underscores.`);
  fs.mkdirSync(runsDir(game), { recursive: true });
  const file = path.join(runsDir(game), `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...run, name }, null, 2));
  return file;
}

export function loadRun(game, nameOrFile) {
  const file = nameOrFile.endsWith('.json') ? path.resolve(nameOrFile) : path.join(runsDir(game), `${nameOrFile}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function listRuns(game) {
  try {
    return fs.readdirSync(runsDir(game)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

function gitInfo(dir) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return { sha, dirty };
  } catch {
    return null;
  }
}

const p50 = (x) => (x && typeof x === 'object' ? (x.p50 ?? null) : (x ?? null));
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// The same error in two builds: messages carry numbers that change every run, and an edit above the
// line that raised it moves its line number.
export const errorType = (e) => `${e.kind || ''}|${String(e.message || '').replace(/\d+/g, '#')}|${String(e.location || '').replace(/:\d+/g, '')}`;

/** A saved Deck measurement in the shape glitchless-playtest compares. */
export function toRun(saved) {
  const m = saved.measure || {};
  return {
    name: saved.name,
    created: saved.created,
    service: saved.game,
    git: saved.git,
    machine: { gpu: `Steam Deck (${saved.deck?.name || 'deck'})`, browser: m.sdk || m.renderer || '' },
    scenarios: [{ params: { seconds: m.seconds, warmup: saved.warmup, args: saved.args }, finished: true }],
    summary: {
      pct_frames_over_budget: m.pct_frames_over_budget ?? null,
      frame_p95: m.frame_ms?.p95 ?? null,
      render_cpu_ms: p50(m.render_cpu_ms),
      update_cpu_ms: p50(m.update_cpu_ms ?? m.process_ms),
      draw_calls: m.draw_calls && typeof m.draw_calls === 'object' ? m.draw_calls.avg : (m.draw_calls ?? null),
      hitches_per_min: m.seconds ? round((m.hitch_count || 0) / (m.seconds / 60)) : null,
      errors_per_session: m.new_errors ?? null,
      crashes: 0,
      errors: (m.errors || []).map((e) => ({ fingerprint: errorType(e), message: e.message, location: e.location, count: e.count, sessions: 1 })),
      levels: {},
    },
  };
}

const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? String(round(v, 2)) : String(v));

export function measureReport(saved, comparison, baseline) {
  const m = saved.measure;
  const out = [`## Steam Deck measure: ${saved.game}${comparison ? ` (${comparison.verdict === 'fail' ? `FAIL, ${comparison.regressions.length} regression${comparison.regressions.length === 1 ? '' : 's'}` : 'PASS'})` : ''}`, ''];
  out.push(`\`${saved.name}\` on ${saved.deck.name}, ${m.seconds}s after ${saved.warmup}s warm-up, ${saved.created.slice(0, 16).replace('T', ' ')} UTC${saved.git ? `, ${saved.git.sha}${saved.git.dirty ? ' + uncommitted changes' : ''}` : ''}.`);
  out.push('', '| Measure | Value |', '| --- | ---: |');
  const rows = [
    ['Frames per second', m.fps],
    ['Frame time p50 / p95 / p99 (ms)', m.frame_ms ? `${fmt(m.frame_ms.p50)} / ${fmt(m.frame_ms.p95)} / ${fmt(m.frame_ms.p99)}` : null],
    ['Worst frame (ms)', m.frame_ms?.worst],
    ['Frame budget (ms)', m.frame_budget_ms],
    ['Slow frames (% over budget)', m.pct_frames_over_budget],
    ['Hitches', m.hitch_count],
    ['Render CPU p50 (ms)', p50(m.render_cpu_ms)],
    ['Update CPU p50 (ms)', p50(m.update_cpu_ms ?? m.process_ms)],
    ['GPU p50 (ms)', p50(m.gpu_ms)],
    ['Draw calls per frame', m.draw_calls?.avg ?? m.draw_calls],
    ['New errors', m.new_errors],
  ];
  for (const [k, v] of rows) if (v != null) out.push(`| ${k} | ${fmt(v)} |`);
  if (m.errors?.length) {
    out.push('', 'Errors while measuring:');
    for (const e of m.errors) out.push(`- \`${e.message}\` at ${e.location || 'unknown location'}: ${e.count}×`);
  }
  if (comparison) {
    out.push('', `Compared with \`${baseline.name}\` (${baseline.created.slice(0, 16).replace('T', ' ')} UTC):`);
    const table = (list) => ['| Metric | Before | After | Change |', '| --- | ---: | ---: | ---: |', ...list.map((c) => `| ${c.label}${c.scope === 'all levels' ? '' : `, ${c.scope}`} | ${fmt(c.before)} | ${fmt(c.after)} | ${c.change_pct == null ? '' : `${c.change_pct > 0 ? '+' : ''}${c.change_pct}%`} |`)].join('\n');
    if (comparison.regressions.length) out.push('', '### Regressions', '', table(comparison.regressions));
    if (comparison.new_errors.length) out.push('', '### New errors', '', ...comparison.new_errors.map((e) => `- \`${e.message}\` at ${e.location || 'unknown location'}`));
    if (comparison.warnings.length) out.push('', '### Warnings', '', table(comparison.warnings));
    if (comparison.improvements.length) out.push('', '### Improvements', '', table(comparison.improvements));
    const same = comparison.checks.filter((c) => c.status === 'same');
    if (same.length) out.push('', `Unchanged: ${same.map((c) => c.label).join(', ')}.`);
    for (const note of comparison.notes) out.push('', `> ${note}`);
  }
  return out.join('\n');
}

/** Compares two saved runs of a game. */
export function compareSaved(game, a, b) {
  const baseline = loadRun(game, a);
  const candidate = loadRun(game, b);
  if (!baseline || !candidate) throw new Problem(`Saved runs needed: ${[!baseline && a, !candidate && b].filter(Boolean).join(', ')} not in ${runsDir(game)}. Saved: ${listRuns(game).join(', ') || 'none'}.`);
  const comparison = compareRuns(toRun(baseline), toRun(candidate));
  return { verdict: comparison.verdict, comparison, report: measureReport(candidate, comparison, baseline), baseline, candidate };
}

export async function measure(game, { which, seconds = 10, warmup = 3, saveAs, compareTo, args = [], glitchless = false, intake, log = console.log } = {}) {
  if (isKiosk(game)) throw new Problem('A web game measures itself in the browser, not from the command line: use glitchless-playtest, or the glitchless_measure tool over WebMCP.');
  if (compareTo && !loadRun(game, compareTo)) throw new Problem(`No saved run called ${compareTo}. Saved: ${listRuns(game).join(', ') || 'none'}.`);
  const deck = await reach(which, { log });
  const hello = await helper(deck, { do: 'hello' });
  if (hello.error) throw new Problem(hello.error);
  if (!hello.games.includes(game.id)) throw new Problem(`${game.id} is not on the Deck yet. Send it first: glitchless-deck send ${game.id}`);
  const gameid = game.id + MEASURE_SUFFIX;
  const out = `${hello.home}/.local/share/glitchless-deck/measure/${game.id}.json`;
  const glitch = glitchless || intake ? await intakeFlags(deck, { intake, log }) : null;
  const flags = [...args, ...(glitch?.flags || []), `--glitchless-measure=${seconds}`, `--glitchless-warmup=${warmup}`, `--glitchless-out=${out}`];
  // One game at a time: a copy already running would share the GPU with the one being measured.
  const stopped = await helper(deck, { do: 'stop', gameid: game.id });
  if (stopped.stopped) log(`Closed the ${game.id} that was running.`);
  await helper(deck, { do: 'clear', paths: [out] });
  await install(deck, game, { gameid, argv: resolveArgv(game), extra: flags, linkTo: game.id });
  log(`Measuring ${game.id} on ${deck.name} for ${seconds}s after ${warmup}s warm-up (it opens on the Deck as ${gameid}).`);
  const started = await helper(deck, { do: 'steam', command: 'run-game/', params: { gameid }, wait: 20 });
  if (started.error) throw new Problem(`Steam did not start ${gameid}: ${started.error}`);
  // Proton's processes don't all run from the game's folder, so only a Linux build is watched for quitting early.
  const got = await helper(deck, { do: 'wait_file', path: out, timeout: warmup + seconds + 90, gameid, watch: !game.proton }, { timeout: (warmup + seconds + 120) * 1000 });
  if (got.error || !got.content) {
    await helper(deck, { do: 'stop', gameid: game.id });
    const why = got.error === 'quit' ? 'quit without writing a measurement' : 'did not write a measurement';
    throw new Problem(`${game.id} ${why}. Does the build have the Glitchless SDK (Unity, Godot or Unreal), and does it start without needing input?${got.log ? `\nLast lines it printed:\n${got.log}` : ''}`);
  }
  const line = got.content.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  const result = JSON.parse(line).glitchless_measure;
  if (!result || result.error) throw new Problem(`The measurement came back empty: ${result?.error || 'no glitchless_measure in it'}`);
  const saved = { created: new Date().toISOString(), game: game.id, deck: { name: deck.name, address: deck.address }, warmup, args: flags.filter((f) => !f.startsWith('--glitchless-out=')), git: gitInfo(game._root), intake: glitch?.url || null, measure: result };
  const files = { latest: saveRun(game, 'latest', saved) };
  if (saveAs) files[saveAs] = saveRun(game, saveAs, saved);
  saved.name = saveAs || 'latest';
  const target = compareTo ?? (saveAs === 'baseline' ? null : listRuns(game).includes('baseline') ? 'baseline' : null);
  if (!target) return { verdict: 'none', report: `${measureReport(saved)}\n\n${saveAs ? `Saved as \`${saveAs}\`.` : 'Nothing to compare with yet: save one with --save baseline before a change.'}`, run: saved, files };
  const baseline = loadRun(game, target);
  const comparison = compareRuns(toRun(baseline), toRun(saved));
  return { verdict: comparison.verdict, report: measureReport(saved, comparison, baseline), comparison, run: saved, baseline, files };
}
