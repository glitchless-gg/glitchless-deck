// Checks before anything is sent: the folder is a build and not the project, and its start file is
// something the Deck can run (Linux x86-64, or Windows x64 when it goes through Proton).

import fs from 'node:fs';
import path from 'node:path';
import { Problem } from './util.js';

/** What kind of program a file is, from its first bytes. */
export function inspectBinary(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(512);
    const n = fs.readSync(fd, head, 0, 512, 0);
    fs.closeSync(fd);
    head = head.subarray(0, n);
  } catch {
    return { kind: 'missing' };
  }
  if (head.length >= 20 && head.readUInt32BE(0) === 0x7f454c46) {
    const bits = head[4] === 2 ? 64 : 32;
    const little = head[5] !== 2;
    const machine = little ? head.readUInt16LE(18) : head.readUInt16BE(18);
    const arch = { 0x3e: 'x86_64', 0x03: 'x86', 0xb7: 'arm64', 0x28: 'arm' }[machine] || `machine 0x${machine.toString(16)}`;
    return { kind: 'elf', bits, arch };
  }
  if (head.length >= 4 && [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe].includes(head.readUInt32BE(0))) return { kind: 'macho' };
  if (head.length >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
    const pe = head.readUInt32LE(0x3c);
    let arch = 'unknown';
    try {
      const buf = Buffer.alloc(6);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, 6, pe);
      fs.closeSync(fd);
      if (buf.readUInt32BE(0) === 0x50450000) arch = { 0x8664: 'x86_64', 0x14c: 'x86', 0xaa64: 'arm64' }[buf.readUInt16LE(4)] || 'unknown';
    } catch {}
    return { kind: 'pe', arch };
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
    const first = head.toString('latin1').split('\n')[0];
    return { kind: 'script', crlf: first.endsWith('\r'), interpreter: first.slice(2).trim() };
  }
  return { kind: head.length ? 'unknown' : 'empty' };
}

// Signs that a folder is a project rather than a build of one.
const PROJECT_MARKERS = ['.git', 'project.godot', 'ProjectSettings', 'glitchless.deck.json', 'deck_delivery.json'];

export function checkFolder(game) {
  const folder = game._folder;
  const rel = path.relative(folder, game._root);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Problem(`${game.id}'s folder is the project itself (${folder}). Send only the build: set "folder" to where the build goes, such as build/deck.`);
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory() || !fs.readdirSync(folder).length) {
    throw new Problem(`Nothing to send: ${folder} is missing or empty. Build it first.`);
  }
  const entries = fs.readdirSync(folder);
  const marker = entries.find((f) => PROJECT_MARKERS.includes(f) || f.endsWith('.uproject') || (f === 'node_modules' && entries.includes('package.json')));
  if (marker) throw new Problem(`${folder} holds ${marker}, so it looks like a project, not a build. Send only the build folder.`);
}

/** The start file has to exist and be something the Deck runs; returns what it is. */
export function checkStart(game, argv, { kiosk = false } = {}) {
  if (kiosk) {
    if (!fs.existsSync(path.join(game._folder, 'index.html'))) throw new Problem(`${game._folder} has no index.html, so it is not a web build. Build it first (or set "folder").`);
    return { kind: 'web' };
  }
  const start = path.resolve(game._folder, argv[0]);
  const rel = path.relative(game._folder, start);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Problem(`"run" has to start a file inside the folder (${argv[0]}).`);
  const what = inspectBinary(start);
  const where = `${argv[0]} (in ${game._folder})`;
  if (what.kind === 'missing') throw new Problem(`${argv[0]} is not in ${game._folder}; check the game's "run" in ${game._file}.`);
  if (what.kind === 'empty') throw new Problem(`${where} is empty: the build did not finish.`);
  if (game.proton) {
    if (what.kind === 'elf') throw new Problem(`"proton" is on, but ${where} is a Linux program. Turn "proton" off for a Linux build.`);
    if (what.kind !== 'pe') throw new Problem(`"proton" is on, but ${where} is not a Windows program (.exe).`);
    if (what.arch === 'arm64') throw new Problem(`${where} is a Windows build for ARM; the Deck needs x64.`);
    return what;
  }
  if (what.kind === 'pe') throw new Problem(`${where} is a Windows program. Set "proton": true to play it through Proton, or send a Linux build.`);
  if (what.kind === 'macho') throw new Problem(`${where} is a macOS program. The Deck needs a Linux x86-64 build (export or build for Linux).`);
  if (what.kind === 'elf' && what.arch !== 'x86_64') throw new Problem(`${where} is a Linux build for ${what.arch}; the Deck needs x86-64.`);
  if (what.kind === 'script' && what.crlf) throw new Problem(`${where} has Windows line endings, so Linux cannot run it. Save it with LF line endings.`);
  if (what.kind === 'unknown') throw new Problem(`${where} is not a Linux program (no ELF header or #! line).`);
  return what;
}
