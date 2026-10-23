// Mirroring a build folder to ~/devkit-game/<id>/ on the Deck, sending only what changed.
//
//   rsync  where it is installed (macOS and Linux have it): rsync -a --delete over ssh.
//   tar    everywhere else, Windows included: both sides list their files with a hash, then the changed
//          files go as one tar stream into the Deck's tar over ssh, and files the build no longer has are
//          removed. The tar is written here in plain Node, so nothing needs installing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { files, writeJson } from './config.js';
import { inspectBinary } from './checks.js';
import { destination, helper, rsyncShell, sshOptions, sshProgram } from './ssh.js';
import { run, which, shq, formatBytes, Problem } from './util.js';
import { spawn } from 'node:child_process';

// Files glitchless-deck writes into the game's folder on the Deck; a send never deletes them.
export const PROTECTED = ['.glitchless-run.sh', '.glitchless-kiosk.sh', '.glitchless-kiosk.py'];

export function transferMode(given, { platform = process.platform } = {}) {
  if (given === 'tar' || given === 'rsync') return given;
  if (given) throw new Problem(`--transfer is rsync or tar (got ${given}).`);
  return platform !== 'win32' && which('rsync') ? 'rsync' : 'tar';
}

// ─── What is in the build folder ───

/** Every file, link and folder under root, with POSIX relative paths. */
export function walk(root) {
  const out = { files: [], links: [], dirs: [] };
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) out.links.push({ rel, full, target: fs.readlinkSync(full) });
      else if (entry.isDirectory()) {
        out.dirs.push({ rel, full, mtime: fs.statSync(full).mtimeMs });
        visit(full);
      } else if (entry.isFile()) {
        const st = fs.statSync(full);
        out.files.push({ rel, full, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777 });
      }
    }
  };
  visit(root);
  return out;
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Hashes for every file, reusing the last send's where size and time are unchanged. */
export async function hashFiles(id, list) {
  const cacheFile = path.join(files().hashes, `${id}.json`);
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {}
  const fresh = {};
  for (const f of list) {
    const known = cache[f.rel];
    f.hash = known && known[0] === f.size && known[1] === f.mtime ? known[2] : await sha1File(f.full);
    fresh[f.rel] = [f.size, f.mtime, f.hash];
  }
  writeJson(cacheFile, fresh);
  return list;
}

/** Unix permissions for a file: its own on macOS and Linux; on Windows, executable when it is a program. */
export function modeFor(f, platform = process.platform) {
  if (platform !== 'win32') return f.mode || 0o644;
  const kind = inspectBinary(f.full).kind;
  return kind === 'elf' || kind === 'script' ? 0o755 : 0o644;
}

/** What has to change on the Deck so its copy matches the build. */
export function plan(local, remote) {
  const send = local.files.filter((f) => {
    const there = remote.files[f.rel];
    return !there || there[0] !== f.size || there[1] !== f.hash;
  });
  const links = local.links.filter((l) => remote.links[l.rel] !== l.target);
  const wanted = new Set([...local.files.map((f) => f.rel), ...local.links.map((l) => l.rel)]);
  const localDirs = new Set(local.dirs.map((d) => d.rel));
  const remove = [
    ...Object.keys(remote.files).filter((rel) => !wanted.has(rel)),
    // A link that became a file (or the other way round) is removed first, then sent again.
    ...Object.keys(remote.links).filter((rel) => !wanted.has(rel) || !local.links.some((l) => l.rel === rel)),
    ...remote.dirs.filter((rel) => wanted.has(rel)),
  ];
  for (const l of links) if (remote.files[l.rel] && !remove.includes(l.rel)) remove.push(l.rel);
  const dirs = local.dirs.filter((d) => !remote.dirs.includes(d.rel));
  return { send, links, dirs, remove: [...new Set(remove)], keepDirs: [...localDirs] };
}

// ─── A tar stream, POSIX ustar with pax records for long names ───

function octal(n, width) {
  return `${Math.floor(n).toString(8).padStart(width - 1, '0')}\0`;
}

function rawHeader({ name, size = 0, mode = 0o644, mtime = Date.now() / 1000, type = '0', linkname = '' }) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

/** The header block(s) for one entry: a pax record first when a name or size doesn't fit ustar. */
export function tarHeader(entry) {
  const long = (s) => Buffer.byteLength(s) > 99 || /[^\x20-\x7e]/.test(s);
  const pax = [];
  if (long(entry.name)) pax.push(paxRecord('path', entry.name));
  if (entry.linkname && long(entry.linkname)) pax.push(paxRecord('linkpath', entry.linkname));
  if ((entry.size || 0) > 0o77777777777) pax.push(paxRecord('size', entry.size));
  const main = rawHeader({ ...entry, name: long(entry.name) ? entry.name.replace(/[^\x20-\x7e]/g, '_').slice(-99) : entry.name, linkname: entry.linkname && long(entry.linkname) ? '' : entry.linkname, size: Math.min(entry.size || 0, 0o77777777777) });
  if (!pax.length) return main;
  const data = Buffer.from(pax.join(''), 'utf8');
  return Buffer.concat([rawHeader({ name: 'PaxHeader', size: data.length, type: 'x', mtime: entry.mtime }), data, pad(data.length), main]);
}

/** Writes the entries as a tar stream to `out` (a writable), waiting whenever it is full. */
export async function writeTar(out, { send: sendFiles = [], links = [], dirs = [] }, { platform = process.platform, onBytes = () => {} } = {}) {
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('the connection closed'));
    if (out.write(buf)) resolve();
    else out.once('drain', resolve);
  });
  for (const d of dirs) await write(tarHeader({ name: `${d.rel}/`, type: '5', mode: 0o755, mtime: d.mtime / 1000 }));
  for (const f of sendFiles) {
    await write(tarHeader({ name: f.rel, size: f.size, mode: modeFor(f, platform), mtime: f.mtime / 1000 }));
    let sent = 0;
    for await (const chunk of fs.createReadStream(f.full)) {
      const piece = sent + chunk.length > f.size ? chunk.subarray(0, f.size - sent) : chunk;
      await write(piece);
      sent += piece.length;
      onBytes(piece.length);
      if (sent >= f.size) break;
    }
    // A file that shrank while it was read is padded to the size the header promised.
    if (sent < f.size) await write(Buffer.alloc(f.size - sent));
    await write(pad(f.size));
  }
  for (const l of links) await write(tarHeader({ name: l.rel, type: '2', linkname: l.target, mode: 0o777 }));
  await write(Buffer.alloc(1024));
}

// ─── Sending ───

export async function transfer(deck, game, { mode, log = () => {}, platform = process.platform } = {}) {
  const remote = `devkit-game/${game.id}`;
  const prepared = await helper(deck, { do: 'prepare', gameid: game.id });
  if (prepared.error) throw new Problem(`Could not make the game's folder on the Deck: ${prepared.error}`);
  const local = walk(game._folder);
  const total = local.files.reduce((n, f) => n + f.size, 0);
  mode = transferMode(mode, { platform });

  if (mode === 'rsync') {
    log(`Sending ${game.id} (${formatBytes(total)} on disk; rsync sends only what changed).`);
    const args = ['-a', '--delete', ...PROTECTED.map((p) => `--exclude=/${p}`), '-e', rsyncShell(), `${game._folder}/`, `${destination(deck)}:${remote}/`];
    const r = await run('rsync', args, { onLine: log });
    if (r.code !== 0) throw new Problem(`The transfer failed (rsync exit ${r.code}). The Deck's copy may be part updated; send again.${r.stderr.trim() ? `\n${r.stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`);
    return { mode, total, sent: null };
  }

  log(`Comparing ${game.id} with the Deck's copy (${local.files.length} files, ${formatBytes(total)})...`);
  const [remoteList] = await Promise.all([helper(deck, { do: 'manifest', gameid: game.id }, { timeout: 600000 }), hashFiles(game.id, local.files)]);
  if (remoteList.error) throw new Problem(`Could not list the Deck's copy: ${remoteList.error}`);
  const p = plan(local, remoteList);
  const bytes = p.send.reduce((n, f) => n + f.size, 0);
  if (p.send.length || p.links.length || p.dirs.length) {
    log(`Sending ${p.send.length} changed file${p.send.length === 1 ? '' : 's'} (${formatBytes(bytes)})${p.remove.length ? `, removing ${p.remove.length}` : ''}.`);
    if (p.remove.length) {
      // Removed first, so a link can become a folder or a file without tar tripping over the old one.
      const pre = await helper(deck, { do: 'prune', gameid: game.id, remove: p.remove, keep_dirs: p.keepDirs.concat(p.dirs.map((d) => d.rel)), sent: {} });
      if (pre.error) throw new Problem(`Could not remove old files on the Deck: ${pre.error}`);
    }
    await sendTar(deck, remote, p, { log, bytes, platform });
  } else {
    log(p.remove.length ? `Nothing changed; removing ${p.remove.length} file${p.remove.length === 1 ? '' : 's'} the build no longer has.` : 'Nothing changed since the last send.');
  }
  const done = await helper(deck, { do: 'prune', gameid: game.id, remove: p.send.length ? [] : p.remove, keep_dirs: p.keepDirs, sent: Object.fromEntries(p.send.map((f) => [f.rel, f.hash])) });
  if (done.error) throw new Problem(`The files are on the Deck, but tidying up failed: ${done.error}`);
  return { mode, total, sent: bytes, files: p.send.length, removed: p.remove.length };
}

function sendTar(deck, remote, p, { log, bytes, platform }) {
  return new Promise((resolve, reject) => {
    const [cmd, ...pre] = sshProgram();
    const child = spawn(cmd, [...pre, ...sshOptions(), destination(deck), `mkdir -p ${shq(remote)} && tar -xf - -C ${shq(remote)}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.stdout.on('data', () => {});
    let done = 0;
    let shown = 0;
    const started = Date.now();
    const onBytes = (n) => {
      done += n;
      if (Date.now() - shown > 1000 && bytes) {
        shown = Date.now();
        const rate = done / Math.max(0.001, (Date.now() - started) / 1000);
        log(`  ${Math.round((done / bytes) * 100)}%  ${formatBytes(done)} of ${formatBytes(bytes)}  ${formatBytes(rate)}/s`);
      }
    };
    child.on('error', (e) => reject(new Problem(`Could not start ssh: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Problem(`The transfer failed (ssh exit ${code}). Send again: only what is still different goes.${err.trim() ? `\n${err.trim().split('\n').slice(-3).join('\n')}` : ''}`));
    });
    child.stdin.on('error', () => {});
    writeTar(child.stdin, p, { platform, onBytes }).then(() => child.stdin.end(), (e) => {
      child.stdin.destroy();
      reject(new Problem(`The transfer failed: ${e.message}`));
    });
  });
}
