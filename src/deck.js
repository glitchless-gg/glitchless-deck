// Pairing with a Deck, finding it again when its address changes, and asking how it is.
//
// Pairing posts this computer's public key, followed by the marker phrase Valve's client appends, to
// the devkit service on port 32000; the person approves it on the Deck's screen, and from then on this
// computer logs in over ssh. That is full control of the Deck, the same as Valve's own tool.

import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import { files, loadDecks, saveDeck, pairedDeck, Problem } from './config.js';
import { findDecks } from './mdns.js';
import { canLogIn, helper } from './ssh.js';
import { run } from './util.js';

export const DEVKIT_PORT = 32000;
// GLITCHLESS_DECK_DEVKIT_PORT moves it (the tests' pretend Deck listens on a free port).
const devkitPort = () => Number(process.env.GLITCHLESS_DECK_DEVKIT_PORT) || DEVKIT_PORT;
// What Valve's client appends to the key it registers; the service checks for it.
export const MAGIC_PHRASE = '900b919520e4cf601998a71eec318fec';

async function getJson(url, timeout = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return r.json();
}

export async function deckLogin(address) {
  try {
    return String((await getJson(`http://${address}:${devkitPort()}/properties.json`)).login || 'deck');
  } catch {
    return 'deck';
  }
}

export async function devkitAnswers(address) {
  try {
    await getJson(`http://${address}:${devkitPort()}/properties.json`, 2500);
    return true;
  } catch {
    return false;
  }
}

async function ensureKey() {
  const { dir, key } = files();
  if (fs.existsSync(key)) return fs.readFileSync(`${key}.pub`, 'utf8').trim();
  fs.mkdirSync(dir, { recursive: true });
  const comment = `devkit-client:${os.userInfo().username}@${os.hostname()}`;
  const r = await run('ssh-keygen', ['-q', '-t', 'rsa', '-b', '2048', '-N', '', '-C', comment, '-f', key]).catch((err) => ({ code: 1, stderr: err.message }));
  if (r.code !== 0) throw new Problem(`Could not make an ssh key with ssh-keygen: ${r.stderr.trim()}. Is OpenSSH installed? (Windows: Settings > Optional features > OpenSSH Client.)`);
  return fs.readFileSync(`${key}.pub`, 'utf8').trim();
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** Which Deck to pair with when several answer: ask at a terminal, otherwise say how to choose. */
export async function chooseDeck(decks, { interactive = process.stdin.isTTY && process.stdout.isTTY, log = console.log } = {}) {
  if (decks.length === 1) return decks[0];
  const list = decks.map((d, i) => `  ${i + 1}. ${d.name} (${d.address})`).join('\n');
  if (!interactive) throw new Problem(`${decks.length} Decks answered:\n${list}\nPick one: glitchless-deck pair <name or address>`);
  log(`${decks.length} Decks answered:\n${list}`);
  const answer = (await ask(`Which one? (1-${decks.length}) `)).trim();
  const pick = decks[Number(answer) - 1] || decks.find((d) => d.name === answer || d.address === answer);
  if (!pick) throw new Problem('No Deck picked.');
  return pick;
}

export async function pair(given, { log = console.log, interactive } = {}) {
  let found = null;
  let address = given || '';
  if (!address || !/^[\d.]+$|:/.test(address)) {
    log('Looking for a Deck in Developer Mode...');
    const decks = await findDecks();
    const named = address ? decks.filter((d) => d.name.toLowerCase() === address.toLowerCase() || d.host.toLowerCase() === address.toLowerCase()) : decks;
    if (!named.length) {
      throw new Problem(address ? `No Deck called ${address} answered. Give its address instead (Settings > Internet on the Deck).` : 'No Deck answered. Is it awake, on this network, with Developer Mode on (Settings > System)? Its address is under Settings > Internet: glitchless-deck pair <address>');
    }
    found = await chooseDeck(named, { interactive, log });
    address = found.address;
    log(`Found ${found.name} at ${address}.`);
  }
  if (!(await devkitAnswers(address))) {
    throw new Problem(`${address} is not taking devkit connections (port ${devkitPort()}). Turn on Developer Mode: Settings > System > Enable Developer Mode.`);
  }
  const publicKey = await ensureKey();
  log("Asking the Deck to pair. Approve it on the Deck's screen (Settings > Developer > Pair new host must be showing).");
  let reply;
  try {
    reply = await fetch(`http://${address}:${devkitPort()}/register`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `${publicKey} ${MAGIC_PHRASE}\n`, signal: AbortSignal.timeout(180000) });
  } catch (err) {
    throw new Problem(`The Deck did not answer the pairing request (${err.cause?.message || err.message}).`);
  }
  if (!reply.ok) throw new Problem(`The Deck turned the pairing down (${reply.status}). Open Settings > Developer > Pair new host on the Deck and try again.`);
  // Paired by address: its name on the network is nicer to pick it by later.
  if (!found) found = (await findDecks({ timeout: 1500 })).find((d) => d.address === address) || null;
  const login = found?.login || (await deckLogin(address));
  const deck = { name: found?.name || address, host: found?.host || '', address, login, paired: new Date().toISOString() };
  if (!(await canLogIn(deck))) throw new Problem("The Deck took the request but this computer still cannot log in. Was it approved on the Deck's screen?");
  saveDeck(deck);
  log(`Paired with ${deck.name} at ${address} (user ${login}).`);
  return deck;
}

/**
 * The Deck, ready to log in to. The router may have given it a new address since pairing: when the
 * saved one is silent, look for it on the network again and remember where it is now.
 */
export async function reach(which, { log = () => {} } = {}) {
  const deck = pairedDeck(which);
  if (await canLogIn(deck)) return deck;
  const decks = await findDecks();
  const candidates = [...decks.filter((d) => d.name === deck.name), ...decks.filter((d) => d.name !== deck.name)];
  for (const found of candidates) {
    if (found.address === deck.address) continue;
    const moved = { ...deck, address: found.address, host: found.host || deck.host };
    if (await canLogIn(moved)) {
      saveDeck(moved, { makeCurrent: loadDecks().current === deck.name });
      log(`${deck.name} is at ${moved.address} now.`);
      return moved;
    }
  }
  throw new Problem(`Cannot reach the Deck (${deck.name}, last seen at ${deck.address}). Is it awake and on this network?`);
}

export async function status({ which, log = () => {} } = {}) {
  const { decks } = loadDecks();
  const state = { paired: decks.length > 0 && fs.existsSync(files().key), decks: decks.map((d) => ({ name: d.name, address: d.address })), deck: null, login: false, reachable: false, steam: null, on_deck: [], registered: null };
  if (!state.paired) {
    state.found = await findDecks();
    return state;
  }
  const saved = pairedDeck(which);
  state.deck = { name: saved.name, address: saved.address };
  let deck;
  try {
    deck = await reach(which, { log });
  } catch {
    state.reachable = (await devkitAnswers(saved.address)) || false;
    return state;
  }
  state.deck = { name: deck.name, address: deck.address };
  state.login = state.reachable = true;
  const hello = await helper(deck, { do: 'hello', shortcuts: true });
  if (!hello.error) {
    state.steam = hello.steam;
    state.on_deck = hello.games;
    state.registered = hello.registered ?? null;
  }
  return state;
}
