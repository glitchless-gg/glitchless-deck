// Against the pretend Deck in fake-deck.js: pairing, finding the Deck, sending (rsync, and the tar way
// Windows uses), Steam's library, launching, artwork, measuring and taking a game off again.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fakeDeck, project, ELF_X86_64 } from './fake-deck.js';
import { readProject, pairedDeck, loadDecks, Problem } from '../src/config.js';
import { pair, status, reach, chooseDeck } from '../src/deck.js';
import { findDecks } from '../src/mdns.js';
import { helper } from '../src/ssh.js';
import { send } from '../src/send.js';
import { launch, stop, logs, remove } from '../src/play.js';
import { measure, compareSaved, listRuns, errorType } from '../src/measure.js';
import { tarHeader, plan, transferMode } from '../src/transfer.js';
import { intakeFlags, lanAddressFor } from '../src/glitchless.js';
import { which } from '../src/util.js';
import http from 'node:http';

let deck;
const quiet = () => {};
before(async () => {
  deck = await fakeDeck();
});
after(async () => {
  await deck.close();
});

const gameIn = (dir) => readProject(path.join(dir, 'glitchless.deck.json'))[0];
const read = (file) => fs.readFileSync(file, 'utf8');

test('a Deck announcing itself is found, and one of several has to be picked', async () => {
  const found = await findDecks({ timeout: 800 });
  assert.deepEqual(found, [{ name: 'steamdeck', host: 'steamdeck.local', address: '127.0.0.1', port: 32000, login: 'deck', txtvers: '1' }]);
  const two = [found[0], { ...found[0], name: 'otherdeck', address: '10.0.0.9' }];
  await assert.rejects(chooseDeck(two, { interactive: false }), /2 Decks answered:[\s\S]*otherdeck \(10\.0\.0\.9\)[\s\S]*glitchless-deck pair <name or address>/);
  assert.equal((await chooseDeck([found[0]], { interactive: false })).name, 'steamdeck');
});

test('nothing is sent before pairing', async () => {
  const g = gameIn(project(deck, { id: 'Unpaired', folder: 'b', run: './x' }, { 'b/x': ELF_X86_64 }));
  await assert.rejects(send(g, { log: quiet }), /Not paired with a Deck yet/);
});

test('pairing posts the key with Valve\'s marker, and a refusal says what to do', async () => {
  deck.refusePairing = true;
  await assert.rejects(pair('steamdeck', { log: quiet, interactive: false }), /turned the pairing down \(403\)/);
  deck.refusePairing = false;
  const paired = await pair('steamdeck', { log: quiet, interactive: false });
  assert.deepEqual({ ...paired, paired: undefined }, { name: 'steamdeck', host: 'steamdeck.local', address: '127.0.0.1', login: 'deck', paired: undefined });
  assert.equal(deck.keys.length, 1);
  assert.match(deck.keys[0], / devkit-client:\S+@\S+ 900b919520e4cf601998a71eec318fec\n$/);
  assert.ok(fs.existsSync(path.join(deck.config, 'devkit_rsa')));
  assert.equal(loadDecks().current, 'steamdeck');
  // By address, it is still saved under its name on the network.
  assert.equal((await pair('127.0.0.1', { log: quiet })).name, 'steamdeck');
});

test('status: Steam, and what is on the Deck', async () => {
  const s = await status();
  assert.equal(s.login, true);
  assert.equal(s.steam, true);
  assert.deepEqual(s.deck, { name: 'steamdeck', address: '127.0.0.1' });
});

test('an unreachable Deck is said so, not retried forever', async () => {
  process.env.FAKE_DECK_DOWN = '1';
  try {
    await assert.rejects(reach(undefined, { log: quiet }), /Cannot reach the Deck \(steamdeck, last seen at 127\.0\.0\.1\)/);
  } finally {
    delete process.env.FAKE_DECK_DOWN;
  }
});

test('tar headers: checksums, long and non-ASCII names through pax records', () => {
  const h = tarHeader({ name: 'a.txt', size: 5, mode: 0o755, mtime: 1700000000 });
  assert.equal(h.length, 512);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  assert.equal(parseInt(h.toString('ascii', 148, 154), 8), sum);
  const long = tarHeader({ name: `${'d'.repeat(120)}/f.bin`, size: 1 });
  assert.equal(long.toString('ascii', 156, 157), 'x');
  assert.match(long.toString('utf8', 512, 1024), /\d+ path=d{120}\/f\.bin\n/);
});

test('the tar way only sends what changed and removes what the build dropped', () => {
  const local = { files: [{ rel: 'a', size: 1, hash: 'x' }, { rel: 'b', size: 2, hash: 'y' }], links: [{ rel: 'l', target: 'a' }], dirs: [{ rel: 'empty' }] };
  const remote = { files: { a: [1, 'x'], b: [2, 'old'], gone: [3, 'z'] }, links: { l: 'a', old: 'x' }, dirs: ['empty', 'stale'] };
  const p = plan(local, remote);
  assert.deepEqual(p.send.map((f) => f.rel), ['b']);
  assert.deepEqual(p.links, []);
  assert.deepEqual(p.dirs, []);
  assert.deepEqual(p.remove.sort(), ['gone', 'old']);
  assert.equal(transferMode(undefined, { platform: 'win32' }), 'tar');
});

function buildFolder(dir) {
  const files = {
    'Game.x86_64': ELF_X86_64,
    'data/level1.pck': 'level one',
    [`data/${'deep/'.repeat(25)}far.txt`]: 'a long way down',
    'data/ünïcode.txt': 'names',
    'run.sh': '#!/bin/sh\necho hi\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.mkdirSync(path.join(dir, 'saves-template'), { recursive: true });
  return files;
}

test('Windows: sent as a tar stream with a hash list, executables marked, only changes on the next send', { skip: !which('tar') && 'no tar here' }, async () => {
  const dir = project(deck, { id: 'WinGame', folder: 'build', run: './Game.x86_64' });
  const files = buildFolder(path.join(dir, 'build'));
  // Windows has no executable bit: the start file and scripts must still arrive executable.
  for (const f of ['Game.x86_64', 'run.sh']) fs.chmodSync(path.join(dir, 'build', f), 0o644);
  const lines = [];
  const r = await send(gameIn(dir), { log: (l) => lines.push(l), platform: 'win32' });
  assert.equal(r.transfer.mode, 'tar');
  assert.equal(r.transfer.files, 5);
  const on = deck.gameDir('WinGame');
  for (const [rel, content] of Object.entries(files)) assert.equal(read(path.join(on, rel)), Buffer.from(content).toString('utf8'), rel);
  assert.ok(fs.statSync(path.join(on, 'saves-template')).isDirectory(), 'empty folders arrive');
  assert.ok(fs.statSync(path.join(on, 'Game.x86_64')).mode & 0o111, 'start file executable');
  assert.ok(fs.statSync(path.join(on, 'run.sh')).mode & 0o111, 'script executable');
  assert.equal(fs.statSync(path.join(on, 'data/level1.pck')).mode & 0o111, 0, 'data not executable');
  assert.match(lines.at(-1), /^Done in \d+s\. On the Deck: Library > Non-Steam > Devkit Game: WinGame$/);

  // Change one file, drop one, add one: only those move, and the wrapper Steam starts stays.
  fs.writeFileSync(path.join(dir, 'build/data/level1.pck'), 'level one, fixed');
  fs.rmSync(path.join(dir, 'build/data/ünïcode.txt'));
  fs.writeFileSync(path.join(dir, 'build/data/new.txt'), 'new');
  const again = await send(gameIn(dir), { log: quiet, platform: 'win32' });
  assert.equal(again.transfer.files, 2);
  assert.equal(again.transfer.removed, 1);
  assert.equal(read(path.join(on, 'data/level1.pck')), 'level one, fixed');
  assert.ok(!fs.existsSync(path.join(on, 'data/ünïcode.txt')));
  assert.ok(fs.existsSync(path.join(on, '.glitchless-run.sh')));
  const third = await send(gameIn(dir), { log: quiet, platform: 'win32' });
  assert.equal(third.transfer.files, 0);
});

test('macOS and Linux: rsync over the same ssh, mirroring the folder', { skip: !which('rsync') && 'no rsync here' }, async () => {
  const dir = project(deck, { id: 'RsGame', folder: 'build', run: './Game.x86_64' });
  buildFolder(path.join(dir, 'build'));
  const r = await send(gameIn(dir), { log: quiet });
  assert.equal(r.transfer.mode, 'rsync');
  assert.equal(read(path.join(deck.gameDir('RsGame'), 'data/level1.pck')), 'level one');
  fs.rmSync(path.join(dir, 'build/data/level1.pck'));
  await send(gameIn(dir), { log: quiet });
  assert.ok(!fs.existsSync(path.join(deck.gameDir('RsGame'), 'data/level1.pck')), 'mirrored: removed here, removed there');
  assert.ok(fs.existsSync(path.join(deck.gameDir('RsGame'), '.glitchless-run.sh')), 'the wrapper survives --delete');
});

test('Steam is asked to add the game, started through the wrapper, with Valve\'s settings', async () => {
  const dir = project(deck, { id: 'Lib', folder: 'build', run: './Game.x86_64 --windowed', settings: { gdbserver: '0' }, env: { MY_FLAG: '1' } }, { 'build/Game.x86_64': ELF_X86_64 });
  await send(gameIn(dir), { log: quiet, transfer: 'tar' });
  const games = path.join(deck.home, 'devkit-game');
  assert.deepEqual(JSON.parse(read(path.join(games, 'Lib-argv.json'))), ['./.glitchless-run.sh', 'Lib', './Game.x86_64', '--windowed']);
  assert.deepEqual(JSON.parse(read(path.join(games, 'Lib-settings.json'))), { steam_play: '0', compat_tool: '', gdbserver: '0' });
  assert.deepEqual(JSON.parse(read(path.join(games, 'Lib-env.json'))), { MY_FLAG: '1' });
  const add = deck.commands.filter((c) => c.command === 'create-shortcut' && c.params.gameid === 'Lib');
  assert.equal(add.length, 1);
  assert.ok(deck.shortcuts.has('Lib'));
  // The wrapper keeps what the game prints, from the game's own folder.
  const out = execFileSync('sh', [path.join(deck.gameDir('Lib'), '.glitchless-run.sh'), 'Lib', 'sh', '-c', 'pwd; echo hello'], { env: { ...process.env, HOME: deck.home }, cwd: deck.root }).toString();
  assert.equal(out, '');
  assert.equal(read(path.join(deck.home, '.local/share/glitchless-deck/logs/Lib.log')), `${deck.gameDir('Lib')}\nhello\n`);
});

test('a Windows build goes through Proton, started directly', async () => {
  const pe = Buffer.alloc(256);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt32BE(0x50450000, 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  const dir = project(deck, { id: 'WinOnly', folder: 'out', run: './Windows/Game.exe', proton: true }, { 'out/Windows/Game.exe': pe });
  await send(gameIn(dir), { log: quiet, transfer: 'tar' });
  const games = path.join(deck.home, 'devkit-game');
  assert.deepEqual(JSON.parse(read(path.join(games, 'WinOnly-argv.json'))), ['./Windows/Game.exe']);
  assert.deepEqual(JSON.parse(read(path.join(games, 'WinOnly-settings.json'))), { steam_play: '1', compat_tool: 'proton-stable' });
});

test('a web build gets the kiosk launcher and its server', async () => {
  const dir = project(deck, { id: 'WebGame', engine: 'web', web: { query: '?autoplay=1' } }, { 'dist/index.html': '<!doctype html>', 'dist/main.js': '' });
  await send(gameIn(dir), { log: quiet, transfer: 'tar' });
  assert.deepEqual(JSON.parse(read(path.join(deck.home, 'devkit-game', 'WebGame-argv.json'))), ['./.glitchless-kiosk.sh', '--query=?autoplay=1']);
  assert.ok(fs.statSync(path.join(deck.gameDir('WebGame'), '.glitchless-kiosk.sh')).mode & 0o111);
  assert.ok(fs.existsSync(path.join(deck.gameDir('WebGame'), '.glitchless-kiosk.py')));
  const empty = project(deck, { id: 'NoWeb', engine: 'web', build: false }, { 'dist/readme.txt': 'not a build' });
  await assert.rejects(send(gameIn(empty), { log: quiet }), /no index\.html/);
});

test('Steam saying no, or not running, is reported', async () => {
  const dir = project(deck, { id: 'NoSteam', folder: 'b', run: './x' }, { 'b/x': ELF_X86_64 });
  fs.renameSync(path.join(deck.home, '.steam/steam.pid'), path.join(deck.home, '.steam/steam.pid.off'));
  try {
    await assert.rejects(send(gameIn(dir), { log: quiet, transfer: 'tar' }), /Steam is not running on the Deck, so it could not be added to the library\. The files are in place\./);
  } finally {
    fs.renameSync(path.join(deck.home, '.steam/steam.pid.off'), path.join(deck.home, '.steam/steam.pid'));
  }
  const refused = await helper(pairedDeck(), { do: 'steam', command: 'no-such-thing', params: {} });
  assert.match(refused.error, /Steam refused: unknown command no-such-thing/);
});

test('artwork goes to Steam\'s grid folder under the library entry\'s appid', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const dir = project(deck, { id: 'Arty', folder: 'b', run: './x', artwork: { grid: 'art/c.png', hero: 'art/h.jpeg', logo: 'art/l.png', icon: 'art/i.png', wide: 'art/w.png' } }, { 'b/x': ELF_X86_64, 'art/c.png': png, 'art/h.jpeg': png, 'art/l.png': png, 'art/i.png': png, 'art/w.png': png });
  const r = await send(gameIn(dir), { log: quiet, transfer: 'tar' });
  const appid = deck.shortcuts.get('Arty');
  assert.equal(r.artwork.appid, appid);
  const grid = path.join(deck.userdata, 'grid');
  assert.deepEqual(fs.readdirSync(grid).sort(), [`${appid}.png`, `${appid}_hero.jpg`, `${appid}_icon.png`, `${appid}_logo.png`, `${appid}p.png`].sort());
  const missing = project(deck, { id: 'NoArt', folder: 'b', run: './x', artwork: { hero: 'nope.png' } }, { 'b/x': ELF_X86_64 });
  await assert.rejects(send(gameIn(missing), { log: quiet }), /nope\.png \(the hero artwork\) is not there/);
});

test('launch asks Steam to run the entry; stop closes what runs from its folder', async () => {
  const dir = project(deck, { id: 'Runner', folder: 'b', run: './x' }, { 'b/x': ELF_X86_64 });
  await send(gameIn(dir), { log: quiet, transfer: 'tar' });
  const r = await launch(gameIn(dir), { log: quiet, settle: 0 });
  assert.equal(r.steam, 'devkit run-game: started devkit game "Runner"');
  assert.deepEqual(deck.commands.at(-1).params.gameid, 'Runner');
  // Something running from the game's folder stands in for the game. Finding it reads /proc, which
  // the Deck (Linux) has and macOS doesn't.
  if (!fs.existsSync('/proc')) return;
  const { spawn } = await import('node:child_process');
  const sleeper = spawn('sleep', ['30'], { cwd: deck.gameDir('Runner') });
  await new Promise((res) => setTimeout(res, 200));
  const stopped = await stop(gameIn(dir), { log: quiet });
  assert.equal(stopped.stopped, 1);
  await new Promise((res) => sleeper.once('exit', res));
  const notThere = gameIn(project(deck, { id: 'NotSent', folder: 'b', run: './x' }, { 'b/x': ELF_X86_64 }));
  await assert.rejects(launch(notThere, { log: quiet, settle: 0 }), /NotSent is not on the Deck yet\. Send it first/);
});

test('logs: the last run\'s output', async () => {
  const dir = project(deck, { id: 'Talky', folder: 'b', run: './x' }, { 'b/x': ELF_X86_64 });
  await send(gameIn(dir), { log: quiet, transfer: 'tar' });
  const logsDir = path.join(deck.home, '.local/share/glitchless-deck/logs');
  fs.writeFileSync(path.join(logsDir, 'Talky.log'), 'line 1\nline 2\n');
  const got = await logs(gameIn(dir), { log: quiet, lines: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'line 2');
});

const MEASURE = { seconds: 10, frames: 600, fps: 60, frame_budget_ms: 16.67, frame_ms: { p50: 16.7, p95: 17.1, p99: 18, worst: 40 }, pct_frames_over_budget: 0.5, render_cpu_ms: { p50: 2.1, p95: 3 }, process_ms: { p50: 1.2, p95: 2 }, hitch_count: 1, draw_calls: { avg: 120, max: 140 }, new_errors: 1, errors: [{ message: 'missing row 4021', kind: 'push_error', location: '_play (demo.gd:132)', count: 1 }], sdk: 'glitchless-godot/0.1.1' };

test('measure: a second Steam entry with the measure flags, saved, then compared with the baseline', async () => {
  const dir = project(deck, { id: 'Measured', folder: 'b', run: './x --fullscreen' }, { 'b/x': ELF_X86_64 });
  const g = gameIn(dir);
  await assert.rejects(measure(g, { log: quiet }), /Measured is not on the Deck yet/);
  await send(g, { log: quiet, transfer: 'tar' });
  deck.measure = MEASURE;
  const first = await measure(g, { saveAs: 'baseline', seconds: 10, warmup: 2, args: ['--', '--level=3'], log: quiet });
  assert.equal(first.verdict, 'none');
  assert.match(first.report, /Saved as `baseline`/);
  const argv = deck.lastMeasureArgv;
  assert.deepEqual(argv.slice(0, 5), ['./.glitchless-run.sh', 'Measured_measure', './x', '--fullscreen', '--']);
  assert.ok(argv.includes('--glitchless-measure=10') && argv.includes('--glitchless-warmup=2') && argv.includes('--level=3'));
  assert.equal(fs.readlinkSync(deck.gameDir('Measured_measure')), 'Measured', 'the measure entry shares the game\'s files');
  assert.deepEqual(listRuns(g).sort(), ['baseline', 'latest']);

  // Same build: the error's numbers and line moved, which is not a new error.
  deck.measure = { ...MEASURE, errors: [{ ...MEASURE.errors[0], message: 'missing row 77', location: '_play (demo.gd:135)' }] };
  const same = await measure(g, { log: quiet });
  assert.equal(same.verdict, 'pass', same.report);
  assert.equal(errorType(MEASURE.errors[0]), errorType(deck.measure.errors[0]));

  // Slower update code: vsync keeps frame time flat, update CPU gives it away.
  deck.measure = { ...MEASURE, process_ms: { p50: 11.3, p95: 12 } };
  const slow = await measure(g, { log: quiet });
  assert.equal(slow.verdict, 'fail');
  assert.deepEqual(slow.comparison.regressions.map((c) => c.id), ['update_cpu_ms']);
  assert.match(slow.report, /FAIL, 1 regression[\s\S]*Update CPU per frame \(ms\) \| 1\.2 \| 11\.3 \| \+842%/);
  assert.equal(compareSaved(g, 'baseline', 'latest').verdict, 'fail');

  deck.measure = { error: 'No frames were drawn: the game was paused or in the background.' };
  await assert.rejects(measure(g, { log: quiet }), /came back empty: No frames were drawn/);
});

test('remove: files, both library entries and the artwork', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const dir = project(deck, { id: 'Gone', folder: 'b', run: './x', artwork: { hero: 'h.png' } }, { 'b/x': ELF_X86_64, 'h.png': png });
  const g = gameIn(dir);
  await send(g, { log: quiet, transfer: 'tar' });
  deck.measure = MEASURE;
  await measure(g, { log: quiet, warmup: 0 });
  const appid = deck.shortcuts.get('Gone');
  await remove(g, { log: quiet });
  assert.ok(!deck.shortcuts.has('Gone') && !deck.shortcuts.has('Gone_measure'));
  for (const f of ['Gone', 'Gone_measure', 'Gone-argv.json', 'Gone-settings.json', 'Gone_measure-argv.json']) assert.ok(!fs.existsSync(path.join(deck.home, 'devkit-game', f)), f);
  assert.ok(!fs.existsSync(path.join(deck.userdata, 'grid', `${appid}_hero.png`)));
  // Other games are left alone.
  assert.ok(fs.existsSync(deck.gameDir('Lib')));
});

test('Glitchless: the intake is checked from the Deck before the game is pointed at it', async () => {
  const server = http.createServer((req, res) => res.end(req.url === '/v1/health' ? '{"ok":true}' : ''));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await intakeFlags(pairedDeck(), { intake: url });
    assert.deepEqual(r.flags, ['--glitchless', `--glitchless-intake=${url}`]);
  } finally {
    server.close();
  }
  await assert.rejects(intakeFlags(pairedDeck(), { intake: url }), /The Deck cannot reach the Glitchless server/);
  const nets = [{ address: '10.8.0.5', netmask: '255.255.255.0' }, { address: '192.168.1.20', netmask: '255.255.255.0' }];
  assert.equal(lanAddressFor('192.168.1.42', nets), '192.168.1.20');
  assert.equal(lanAddressFor('172.20.1.2', nets), '10.8.0.5');
});

test('Problems are Problems', () => {
  assert.ok(new Problem('x') instanceof Error);
});
