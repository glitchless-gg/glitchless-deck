// Talking to a paired Deck with the system's OpenSSH (macOS, Linux and Windows 10+ all ship it), with
// the key and known_hosts kept in glitchless-deck's own folder.
//
// GLITCHLESS_DECK_SSH swaps the ssh program, as a JSON array or one path: the tests use a pretend ssh
// that runs the command in a scratch folder standing in for the Deck's home.

import { files } from './config.js';
import { run, shq } from './util.js';
import { HELPER } from './remote.js';

export function sshProgram() {
  const given = process.env.GLITCHLESS_DECK_SSH;
  if (!given) return ['ssh'];
  try {
    const list = JSON.parse(given);
    if (Array.isArray(list)) return list.map(String);
  } catch {}
  return [given];
}

// OpenSSH splits some option values on spaces unless they are quoted.
const optionPath = (p) => (/\s/.test(p) ? `"${p}"` : p);

export function sshOptions() {
  const f = files();
  return ['-i', f.key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${optionPath(f.knownHosts)}`, '-o', 'LogLevel=ERROR'];
}

export const destination = (deck) => `${deck.login || 'deck'}@${deck.address}`;

/** Runs a command on the Deck (through its login shell). Resolves { code, stdout, stderr }. */
export function ssh(deck, command, { input, timeout = 60000, onLine } = {}) {
  const [cmd, ...pre] = sshProgram();
  return run(cmd, [...pre, ...sshOptions(), destination(deck), command], { input, timeout, onLine });
}

export async function canLogIn(deck) {
  try {
    return (await ssh(deck, 'true', { timeout: 15000 })).code === 0;
  } catch {
    return false;
  }
}

// The helper runs from stdin, so its arguments can be any size (artwork travels this way).
const BOOT = 'import sys,json;d=json.load(sys.stdin);exec(d["s"],{"__name__":"glitchless_deck","ARGS":d["a"]})';

/**
 * Runs one step of the helper (remote.js) on the Deck and returns what it printed, as an object.
 * A step that went wrong comes back as { error }.
 */
export async function helper(deck, args, { timeout = 60000 } = {}) {
  const r = await ssh(deck, `python3 -c ${shq(BOOT)}`, { input: JSON.stringify({ s: HELPER, a: args }), timeout });
  const last = r.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(last);
  } catch {
    const said = (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split('\n').slice(-6).join('\n');
    return { error: r.code === 255 ? `Cannot reach the Deck at ${deck.address} (${said})` : `The Deck's helper failed: ${said}`, unreachable: r.code === 255 };
  }
}

/** The ssh command rsync should use, as one string (rsync splits it the way a shell would). */
export function rsyncShell() {
  return [...sshProgram(), ...sshOptions()].map(shq).join(' ');
}
