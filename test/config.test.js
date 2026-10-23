import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProject, addProject, forgetProject, gameNamed, loadGames, shellWords, normalizeGame, Problem } from '../src/config.js';
import { engineDefaults, godotPresets, resolveArgv, buildStep } from '../src/engines.js';
import { initProject, detectEngine, idFrom } from '../src/init.js';
import { inspectBinary, checkFolder, checkStart } from '../src/checks.js';
import { ELF_X86_64 } from './fake-deck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let work;
before(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glitchless-deck-config-')));
  process.env.GLITCHLESS_DECK_HOME = path.join(work, 'config');
});

function write(rel, content) {
  const file = path.join(work, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  return file;
}

test('a game needs a Deck name, a folder and a start (or an engine that fills them in)', () => {
  for (const bad of [{ id: '9Lives', folder: 'b', run: './x' }, { id: 'My Game', folder: 'b', run: './x' }, { id: 'Steam', folder: 'b', run: './x' }, { id: 'Good', run: './x' }, { id: 'Good', folder: 'b' }, { id: 'Mine_measure', folder: 'b', run: './x' }, { id: 'Good', engine: 'gamemaker' }]) {
    assert.throws(() => readProject(write('bad/glitchless.deck.json', { games: [bad] })), Problem, JSON.stringify(bad));
  }
  const [g] = readProject(write('ok/glitchless.deck.json', { games: [{ id: 'Ok.v2', folder: 'out', run: './Ok --windowed "two words"' }] }));
  assert.equal(g._folder, path.join(work, 'ok', 'out'));
  assert.deepEqual(g._argv, ['./Ok', '--windowed', 'two words']);
});

test('engines fill in where the build goes and how it starts', () => {
  assert.deepEqual(engineDefaults({ id: 'G', engine: 'godot' }), { folder: 'build/deck', run: './G.x86_64' });
  assert.deepEqual(engineDefaults({ id: 'U', engine: 'unity' }), { folder: 'build/deck', run: './U.x86_64' });
  write('unreal/Shooter.uproject', '{}');
  assert.deepEqual(engineDefaults({ id: 'S', engine: 'unreal' }, { root: path.join(work, 'unreal'), platform: 'win32' }), { folder: 'build/deck', run: './Windows/Shooter.exe', proton: true });
  assert.deepEqual(engineDefaults({ id: 'S', engine: 'unreal' }, { root: path.join(work, 'unreal'), platform: 'linux' }), { folder: 'build/deck', run: './Linux/Shooter.sh' });
  assert.equal(engineDefaults({ id: 'W', engine: 'web' }).run, './.glitchless-kiosk.sh');
  write('electron/package.json', { name: 'blaster', devDependencies: { 'electron-builder': '1' } });
  assert.deepEqual(engineDefaults({ id: 'E', engine: 'web', web: { mode: 'electron' } }, { root: path.join(work, 'electron') }), { folder: 'dist/linux-unpacked', run: './blaster --no-sandbox' });
  // An entry's own fields win over the engine's.
  const [g] = readProject(write('own/glitchless.deck.json', { games: [{ id: 'Own', engine: 'godot', folder: 'out/linux' }] }));
  assert.equal(g.folder, 'out/linux');
  assert.equal(g.run, './Own.x86_64');
});

test('an Electron build is started by whatever binary it has', () => {
  write('el2/package.json', { name: 'pkg-name', productName: 'Nice Name' });
  write('el2/dist/linux-unpacked/nice-name', ELF_X86_64);
  write('el2/dist/linux-unpacked/chrome-sandbox', ELF_X86_64);
  write('el2/dist/linux-unpacked/libffmpeg.so', ELF_X86_64);
  const [g] = readProject(write('el2/glitchless.deck.json', { games: [{ id: 'El', engine: 'web', web: { mode: 'electron' } }] }));
  assert.deepEqual(resolveArgv(g), ['./nice-name', '--no-sandbox']);
});

test('Godot presets are read from export_presets.cfg', () => {
  write('godot/export_presets.cfg', '[preset.0]\n\nname="Web"\nplatform="Web"\n\n[preset.1]\n\nname="Deck"\nplatform="Linux"\n\n[preset.1.options]\n\nbinary_format/architecture="x86_64"\n');
  const linux = godotPresets(path.join(work, 'godot')).filter((p) => p.platform === 'Linux');
  assert.deepEqual(linux, [{ index: '1', name: 'Deck', platform: 'Linux', arch: 'x86_64' }]);
  assert.equal(buildStep(normalizeGame({ id: 'Gd', engine: 'godot' }, path.join(work, 'godot', 'x.json'))).label, 'Godot Linux export');
  assert.equal(buildStep(normalizeGame({ id: 'Gd', engine: 'godot', build: false }, path.join(work, 'godot', 'x.json'))), null);
  assert.equal(buildStep(normalizeGame({ id: 'Gd', engine: 'godot', build: 'make deck' }, path.join(work, 'godot', 'x.json'))).label, 'make deck');
});

test('Unreal will not try to build on a Mac', async () => {
  const g = normalizeGame({ id: 'Sh', engine: 'unreal' }, path.join(work, 'unreal', 'glitchless.deck.json'));
  await assert.rejects(buildStep(g, { platform: 'darwin' }).go(() => {}), /cannot make a Steam Deck build on a Mac/);
});

test('projects are listed, found by id or name, and forgotten; a Deck name belongs to one game', () => {
  const one = write('p1/glitchless.deck.json', { games: [{ id: 'Twin', name: 'The Twin', folder: 'b', run: './x' }] });
  addProject(one);
  assert.equal(gameNamed('the twin', { cwd: work }).id, 'Twin');
  assert.equal(gameNamed(undefined, { cwd: work }).id, 'Twin');
  assert.throws(() => addProject(write('p2/glitchless.deck.json', { games: [{ id: 'twin', folder: 'b', run: './x' }] })), /already the name/);
  // A Deck Delivery file is read the same way.
  addProject(write('p3/deck_delivery.json', { games: [{ id: 'Old', folder: 'b', run: './x' }] }));
  assert.deepEqual(loadGames({ cwd: work }).map((g) => g.id), ['Twin', 'Old']);
  assert.throws(() => gameNamed(undefined, { cwd: work }), /Which game\?/);
  forgetProject(one);
  forgetProject(path.join(work, 'p3'));
  assert.deepEqual(loadGames({ cwd: work }), []);
  // The project in the current folder counts without being listed.
  assert.equal(gameNamed(undefined, { cwd: path.join(work, 'p1') }).id, 'Twin');
});

test('shell words split like a shell', () => {
  assert.deepEqual(shellWords(`./Game -a "b c" 'd "e"' f\\ g`), ['./Game', '-a', 'b c', 'd "e"', 'f g']);
  assert.throws(() => shellWords('./x "open'), Problem);
});

test('init reads the engine from the project and writes a file that loads', () => {
  write('initg/project.godot', 'config_version=5\n[application]\nconfig/name="Space Jam 2"\n');
  assert.deepEqual(detectEngine(path.join(work, 'initg')), { engine: 'godot', name: 'Space Jam 2' });
  const g = initProject(path.join(work, 'initg'), { log: () => {} });
  assert.equal(g.id, 'SpaceJam2');
  assert.equal(g.engine, 'godot');
  assert.throws(() => initProject(path.join(work, 'initg'), { log: () => {} }), /already there/);
  write('initu/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.62f3\n');
  write('initu/ProjectSettings/ProjectSettings.asset', '  companyName: Me\n  productName: Fetch!\n');
  assert.deepEqual(detectEngine(path.join(work, 'initu')), { engine: 'unity', name: 'Fetch!' });
  write('initw/package.json', { name: 'zoomies', dependencies: { three: '1' } });
  assert.deepEqual(detectEngine(path.join(work, 'initw')), { engine: 'web', name: 'zoomies' });
  write('inite/package.json', { name: 'app', devDependencies: { electron: '1' } });
  assert.equal(detectEngine(path.join(work, 'inite')).web.mode, 'electron');
  assert.equal(idFrom('9 lives'), 'Game9Lives');
});

test('only a build is sent: not the project, and only something the Deck runs', () => {
  const dir = path.join(work, 'chk');
  write('chk/project.godot', '');
  write('chk/build/deck/Game.x86_64', ELF_X86_64);
  const game = (extra) => normalizeGame({ id: 'Game', folder: 'build/deck', run: './Game.x86_64', ...extra }, path.join(dir, 'glitchless.deck.json'));
  checkFolder(game());
  assert.equal(checkStart(game(), ['./Game.x86_64']).arch, 'x86_64');
  assert.throws(() => checkFolder(game({ folder: '.' })), /the project itself/);
  assert.throws(() => checkFolder(game({ folder: '..' })), /the project itself/);
  write('chk/copy/project.godot', '');
  assert.throws(() => checkFolder(game({ folder: 'copy' })), /looks like a project/);
  assert.throws(() => checkFolder(game({ folder: 'missing' })), /Nothing to send/);

  const arm = Buffer.from(ELF_X86_64);
  arm.writeUInt16LE(0xb7, 18);
  write('chk/build/deck/arm', arm);
  assert.throws(() => checkStart(game(), ['./arm']), /for arm64/);
  write('chk/build/deck/mac', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  assert.throws(() => checkStart(game(), ['./mac']), /macOS program/);
  const pe = Buffer.alloc(256);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt32BE(0x50450000, 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  write('chk/build/deck/Game.exe', pe);
  assert.deepEqual(inspectBinary(path.join(dir, 'build/deck/Game.exe')), { kind: 'pe', arch: 'x86_64' });
  assert.throws(() => checkStart(game(), ['./Game.exe']), /Set "proton": true/);
  assert.equal(checkStart(game({ proton: true }), ['./Game.exe']).kind, 'pe');
  assert.throws(() => checkStart(game({ proton: true }), ['./Game.x86_64']), /is a Linux program/);
  write('chk/build/deck/run.sh', '#!/bin/sh\r\nexec ./Game.x86_64\r\n');
  assert.throws(() => checkStart(game(), ['./run.sh']), /Windows line endings/);
  write('chk/build/deck/empty', '');
  assert.throws(() => checkStart(game(), ['./empty']), /is empty/);
  assert.throws(() => checkStart(game(), ['./nope']), /is not in/);
  assert.throws(() => checkStart(game(), ['../project.godot']), /inside the folder/);
});
