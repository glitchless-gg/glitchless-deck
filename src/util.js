// Small helpers shared by the rest: finding programs, running them, quoting for a remote shell.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Something the person at the keyboard can act on: printed as it is, without a stack. */
export class Problem extends Error {}

/** The full path of a program on the PATH, or null. */
export function which(name, { platform = process.platform, env = process.env } = {}) {
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

/** Quotes a word for a POSIX shell (the Deck's bash, or rsync's -e). */
export function shq(word) {
  const s = String(word);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs a program. Output is collected, and also passed to onLine as it comes (a carriage return ends a
 * line too, so progress bars arrive as lines). Resolves with { code, stdout, stderr }; never rejects for
 * a non-zero exit.
 */
export function run(cmd, args, { input, cwd, env, timeout = 0, onLine, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, shell, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const err = [];
    let pending = '';
    const feed = (chunk) => {
      if (!onLine) return;
      pending += chunk.toString('utf8');
      const parts = pending.split(/\r\n|\r|\n/);
      pending = parts.pop();
      for (const line of parts) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', (c) => (out.push(c), feed(c)));
    child.stderr.on('data', (c) => (err.push(c), feed(c)));
    let timer;
    if (timeout) timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? Object.assign(new Error(`${cmd} is not installed (or not on the PATH).`), { code: 'ENOENT' }) : e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (onLine && pending.trim()) onLine(pending);
      resolve({ code: code ?? (signal ? 128 : 1), signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
