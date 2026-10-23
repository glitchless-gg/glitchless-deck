import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUi } from '../src/ui.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'glitchless-deck.js');
let server;
let port;
let work;

before(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-deck-ui-')));
  process.env.GLITCHLESS_DECK_HOME = path.join(work, 'config');
  process.env.GLITCHLESS_DECK_MDNS = '127.0.0.1:9'; // nobody answers: status has nothing to find
  fs.writeFileSync(path.join(work, 'glitchless.deck.json'), JSON.stringify({ games: [{ id: 'PageGame', name: 'Page Game', engine: 'godot' }] }));
  server = createUi({ cwd: work, version: 'test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

function call(pathname, { host = 'localhost', method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: `${host}:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the page opens for this computer, with its brand and its state', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.data, /<title>Glitchless Deck<\/title>/);
  assert.equal((await call('/mark-dark.svg')).status, 200);
  const state = JSON.parse((await call('/api/state')).data);
  assert.equal(state.version, 'test');
  assert.deepEqual(state.games.map((g) => [g.id, g.engine, g.ready, g.builds]), [['PageGame', 'godot', false, true]]);
  assert.equal(state.deck.paired, false);
  assert.equal(state.job.running, false);
});

test('another host name is turned away', async () => {
  assert.equal((await call('/', { host: 'attacker.example' })).status, 403);
  assert.equal((await call('/api/state', { host: 'attacker.example' })).status, 403);
});

test('anything that acts needs the page\'s own header, and a real game id', async () => {
  assert.equal((await call('/api/send', { method: 'POST', body: '{"game":"PageGame"}' })).status, 403);
  assert.equal((await call('/api/nothing', { method: 'POST', body: '{}', headers: { 'X-Glitchless-Deck': '1' } })).status, 404);
  assert.equal((await call('/api/send', { method: 'POST', body: '{"game":"x; rm -rf ~"}', headers: { 'X-Glitchless-Deck': '1' } })).status, 400);
  assert.equal((await call('/../package.json')).status, 404);
});

test('a command from the page runs the CLI and keeps its output', async () => {
  const started = JSON.parse((await call('/api/launch', { method: 'POST', body: '{"game":"PageGame"}', headers: { 'X-Glitchless-Deck': '1' } })).data);
  assert.equal(started.started, true);
  let state;
  for (let i = 0; i < 100; i++) {
    state = JSON.parse((await call('/api/state')).data);
    if (!state.job.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.job.title, 'Starting PageGame');
  assert.equal(state.job.ok, false);
  assert.match(state.job.lines.join('\n'), /Not paired with a Deck yet/);
});

const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: work, env: process.env, encoding: 'utf8' });

test('the command: version, help, games, and exit codes', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(cli('--version').stdout.trim(), `glitchless-deck ${pkg.version}`);
  const none = cli();
  assert.equal(none.status, 2);
  assert.match(none.stdout, /send \[game\]/);
  assert.equal(cli('help').status, 0);
  assert.equal(cli('nonsense').status, 2);
  const games = JSON.parse(cli('games', '--json').stdout);
  assert.deepEqual(games.map((g) => [g.id, g.engine, g.run]), [['PageGame', 'godot', './PageGame.x86_64']]);
  const unpaired = cli('send', '--no-build');
  assert.equal(unpaired.status, 2);
  assert.match(unpaired.stderr, /Not paired with a Deck yet/);
  assert.match(cli('skill').stdout, /^---\nname: glitchless-deck\n/);
});
