// A pretend Steam Deck for the tests, all on this computer:
//   - a scratch folder plays the Deck's home; ssh (and rsync's ssh) go through fake-ssh.js into it
//   - Steam: ~/.steam with a live pid, a token and a "pipe" that is a plain file, and something that answers
//     what is written there the way Steam does (create-shortcut, list-shortcuts, delete-shortcut, run-game),
//     keeping shortcuts.vdf up to date, and writing a measurement when a _measure entry is started
//   - the devkit service's pairing endpoint, and an mDNS responder that announces the Deck
// Everything glitchless-deck keeps on "this computer" goes to a scratch config folder.

import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessage, encodeResponse, TYPE, SERVICE } from '../src/mdns.js';
import { MAGIC_PHRASE } from '../src/deck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const cstr = (s) => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
const int32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n | 0);
  return b;
};

/** Steam's binary shortcuts.vdf, as Steam writes it for devkit games. */
export function shortcutsVdf(list) {
  const parts = [Buffer.from([0]), cstr('shortcuts')];
  list.forEach((s, i) => {
    parts.push(Buffer.from([0]), cstr(i));
    parts.push(Buffer.from([2]), cstr('appid'), int32(s.appid));
    parts.push(Buffer.from([1]), cstr('AppName'), cstr(s.name));
    parts.push(Buffer.from([1]), cstr('Exe'), cstr(s.exe || ''));
    parts.push(Buffer.from([2]), cstr('Devkit'), int32(s.devkit ? 1 : 0));
    parts.push(Buffer.from([1]), cstr('DevkitGameID'), cstr(s.devkit || ''));
    parts.push(Buffer.from([0]), cstr('tags'), Buffer.from([8]));
    parts.push(Buffer.from([8]));
  });
  parts.push(Buffer.from([8, 8]));
  return Buffer.concat(parts);
}

export const ELF_X86_64 = (() => {
  const b = Buffer.alloc(64);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = 2; // 64-bit
  b[5] = 1; // little-endian
  b.writeUInt16LE(0x3e, 18);
  return b;
})();

export async function fakeDeck({ name = 'steamdeck', refusePairing = false, steamRunning = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-deck-test-')));
  const home = path.join(root, 'deck-home');
  const config = path.join(root, 'config');
  const steamDir = path.join(home, '.steam');
  const userdata = path.join(home, '.local', 'share', 'Steam', 'userdata', '84364286', 'config');
  fs.mkdirSync(steamDir, { recursive: true });
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(path.join(steamDir, 'steam.token'), 'token123');
  fs.writeFileSync(path.join(steamDir, 'steam.pipe'), '');
  if (steamRunning) fs.writeFileSync(path.join(steamDir, 'steam.pid'), String(process.pid));
  Object.assign(process.env, {
    GLITCHLESS_DECK_HOME: config,
    GLITCHLESS_DECK_SSH: JSON.stringify([process.execPath, path.join(HERE, 'fake-ssh.js')]),
    FAKE_DECK_HOME: home,
  });
  delete process.env.FAKE_DECK_DOWN;

  const deck = { root, home, config, userdata, commands: [], shortcuts: new Map(), keys: [], refusePairing, measure: null };
  const writeVdf = () => {
    const list = [...deck.shortcuts].map(([gameid, appid]) => ({ appid, name: `Devkit Game: ${gameid}`, exe: `"${home}/devkit-game/${gameid}/./x"`, devkit: gameid }));
    fs.writeFileSync(path.join(userdata, 'shortcuts.vdf'), shortcutsVdf([{ appid: 2284959052, name: 'Google Chrome', exe: '"/usr/bin/flatpak"' }, ...list]));
  };
  writeVdf();

  // Steam reads requests off its pipe and answers in the file each one names.
  let seen = '';
  const answer = (line) => {
    const m = line.match(/^devkit-1 steam:\/\/devkit-1\/([^/]+)\/([^?]+)\?(.*)$/);
    if (!m) return;
    const [, token, command, query] = m;
    const params = Object.fromEntries(new URLSearchParams(query));
    deck.commands.push({ token, command, params });
    const respond = (text, error = false) => {
      fs.writeFileSync(`${params.response}.lock`, '');
      fs.writeFileSync(error ? `${params.response}.error` : params.response, text);
      fs.unlinkSync(`${params.response}.lock`);
    };
    if (token !== 'token123') return respond('bad token', true);
    if (command === 'create-shortcut') {
      if (!fs.existsSync(path.join(home, 'devkit-game', `${params.gameid}-argv.json`))) return respond('no argv', true);
      if (!deck.shortcuts.has(params.gameid)) deck.shortcuts.set(params.gameid, 3000000000 + deck.shortcuts.size);
      writeVdf();
      return respond('');
    }
    if (command === 'list-shortcuts') return respond(JSON.stringify({ version: 2, gameids: [...deck.shortcuts.keys()] }));
    if (command === 'delete-shortcut') {
      deck.shortcuts.delete(params.gameid);
      writeVdf();
      return respond('deleted');
    }
    if (command === 'run-game/') {
      if (!deck.shortcuts.has(params.gameid)) return respond(`unknown game ${params.gameid}`, true);
      respond(`devkit run-game: started devkit game "${params.gameid}"`);
      if (params.gameid.endsWith('_measure') && deck.measure) {
        const argv = JSON.parse(fs.readFileSync(path.join(home, 'devkit-game', `${params.gameid}-argv.json`), 'utf8'));
        deck.lastMeasureArgv = argv;
        const out = argv.find((a) => a.startsWith('--glitchless-out='))?.slice('--glitchless-out='.length);
        if (out) {
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, `${JSON.stringify({ glitchless_measure: deck.measure })}\n`);
        }
      }
      return;
    }
    respond(`unknown command ${command}`, true);
  };
  const steamTimer = setInterval(() => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(steamDir, 'steam.pipe'), 'utf8');
    } catch {}
    if (text && text !== seen) {
      seen = text;
      for (const line of text.split('\n')) if (line.trim()) answer(line.trim());
    }
  }, 30);

  // The devkit service: pairing, and the properties a client asks for.
  const devkit = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/properties.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ txtvers: 1, login: 'deck', settings: '{}', devkit1: ['devkit-1'] }));
      }
      if (req.method === 'POST' && req.url === '/register') {
        const ok = /^ssh-rsa \S+ devkit-client:\S+ 900b919520e4cf601998a71eec318fec\n$/.test(body) && body.includes(MAGIC_PHRASE);
        if (deck.refusePairing || !ok) {
          res.writeHead(403);
          return res.end('denied');
        }
        deck.keys.push(body);
        res.writeHead(200);
        return res.end('registered');
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => devkit.listen(0, '127.0.0.1', r));
  process.env.GLITCHLESS_DECK_DEVKIT_PORT = String(devkit.address().port);

  // mDNS: answers a question for the devkit service with where this Deck is.
  deck.announced = [{ name, address: '127.0.0.1', login: 'deck' }];
  const mdns = dgram.createSocket('udp4');
  mdns.on('message', (buf, rinfo) => {
    let q;
    try {
      q = decodeMessage(buf);
    } catch {
      return;
    }
    if (!q.questions.some((x) => x.name.toLowerCase() === SERVICE && x.type === TYPE.PTR)) return;
    const records = deck.announced.flatMap((d) => [
      { name: SERVICE, type: TYPE.PTR, data: `${d.name}.${SERVICE}` },
      { name: `${d.name}.${SERVICE}`, type: TYPE.SRV, data: { port: 32000, target: `${d.name}.local` } },
      { name: `${d.name}.${SERVICE}`, type: TYPE.TXT, data: { txtvers: '1', login: d.login, settings: '{}' } },
      { name: `${d.name}.local`, type: TYPE.A, data: d.address },
    ]);
    mdns.send(encodeResponse(records), rinfo.port, rinfo.address);
  });
  await new Promise((r) => mdns.bind(0, '127.0.0.1', r));
  process.env.GLITCHLESS_DECK_MDNS = `127.0.0.1:${mdns.address().port}`;

  /** Paired already, without going through pair(): a key file and the Deck saved. */
  deck.pairDirectly = () => {
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'devkit_rsa'), 'not a real key');
    fs.writeFileSync(path.join(config, 'decks.json'), JSON.stringify({ current: name, decks: [{ name, host: `${name}.local`, address: '127.0.0.1', login: 'deck' }] }));
  };
  deck.gameDir = (id) => path.join(home, 'devkit-game', id);
  deck.close = async () => {
    clearInterval(steamTimer);
    await new Promise((r) => devkit.close(r));
    mdns.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return deck;
}

/** A project with one game, in its own scratch folder. */
export function project(deck, game, files = {}) {
  const dir = path.join(deck.root, 'projects', game.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.writeFileSync(path.join(dir, 'glitchless.deck.json'), JSON.stringify({ games: [game] }));
  return dir;
}
