// What this computer knows: the pairing (an ssh key and the Decks it is paired with) in
// ~/.config/glitchless-deck, and the projects whose games it can send. Each project keeps its own
// glitchless.deck.json; a Deck Delivery deck_delivery.json is read the same way.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineDefaults, ENGINES } from './engines.js';
import { Problem } from './util.js';

export { Problem };

export const PROJECT_FILES = ['glitchless.deck.json', 'deck_delivery.json'];
// Valve's client takes only these names for a devkit title.
export const GAME_ID = /^[A-Za-z_][A-Za-z0-9_.]+$/;
// The second shortcut a game gets for measuring (see measure.js).
export const MEASURE_SUFFIX = '_measure';

// GLITCHLESS_DECK_HOME moves everything somewhere else (the tests use a scratch folder).
export function configDir() {
  return process.env.GLITCHLESS_DECK_HOME || path.join(os.homedir(), '.config', 'glitchless-deck');
}

export const files = () => {
  const dir = configDir();
  return {
    dir,
    key: path.join(dir, 'devkit_rsa'),
    decks: path.join(dir, 'decks.json'),
    projects: path.join(dir, 'projects.json'),
    knownHosts: path.join(dir, 'known_hosts'),
    hashes: path.join(dir, 'hashes'),
  };
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Problem(`${file} is not valid JSON: ${err.message}`);
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
}

// ─── Decks ───

/** { current: name, decks: [{ name, address, login, host, paired }] } */
export function loadDecks() {
  const d = readJson(files().decks, {});
  return { current: d.current || null, decks: Array.isArray(d.decks) ? d.decks : [] };
}

export function saveDeck(deck, { makeCurrent = true } = {}) {
  const all = loadDecks();
  const i = all.decks.findIndex((d) => d.name === deck.name);
  if (i >= 0) all.decks[i] = { ...all.decks[i], ...deck };
  else all.decks.push(deck);
  if (makeCurrent || !all.current) all.current = deck.name;
  writeJson(files().decks, all);
  return deck;
}

/** The Deck to use: the one named (by name or address), or the current one. */
export function pairedDeck(which) {
  const { current, decks } = loadDecks();
  if (!decks.length || !fs.existsSync(files().key)) {
    throw new Problem('Not paired with a Deck yet. On the Deck: Settings > Developer > Pair new host. Then run: glitchless-deck pair');
  }
  if (which) {
    const want = String(which).toLowerCase();
    const deck = decks.find((d) => d.name.toLowerCase() === want || d.address === which || d.host?.toLowerCase() === want);
    if (!deck) throw new Problem(`No paired Deck called ${which}. Paired: ${decks.map((d) => `${d.name} (${d.address})`).join(', ')}.`);
    return deck;
  }
  return decks.find((d) => d.name === current) || decks[0];
}

// ─── Projects and their games ───

/** The project file in a folder, if it has one. */
export function projectFileIn(dir) {
  for (const name of PROJECT_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function listedProjects() {
  return readJson(files().projects, []).filter((f) => fs.existsSync(f));
}

/** Every project file this computer can send from: the one in cwd first, then the listed ones. */
export function projectFiles(cwd = process.cwd()) {
  const here = projectFileIn(cwd);
  const out = here ? [path.resolve(here)] : [];
  for (const f of listedProjects()) if (!out.includes(f)) out.push(f);
  return out;
}

export function shellWords(line) {
  const words = [];
  let word = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Problem(`Unclosed ${quote} in: ${line}`);
  if (started) words.push(word);
  return words;
}

/** A game entry with its engine's defaults filled in, checked, and its paths resolved. */
export function normalizeGame(raw, file) {
  const id = String(raw?.id ?? '');
  if (!GAME_ID.test(id) || id.toLowerCase() === 'steam') {
    throw new Problem(`${file}: a game's id is its name on the Deck: letters, digits, _ and ., starting with a letter (got ${JSON.stringify(raw?.id)}).`);
  }
  if (id.endsWith(MEASURE_SUFFIX)) throw new Problem(`${file}: ids ending in ${MEASURE_SUFFIX} are kept for measuring (${id}).`);
  if (raw.engine && !ENGINES.includes(raw.engine)) throw new Problem(`${file}: ${id} has engine ${JSON.stringify(raw.engine)}; known engines: ${ENGINES.join(', ')}.`);
  const root = path.resolve(path.dirname(file), raw.root || '.');
  const game = { ...engineDefaults({ ...raw, id }, { root }), ...raw, id, _file: file, _root: root };
  for (const key of ['folder', 'run']) {
    if (!game[key]) throw new Problem(`${file}: ${id} needs a "${key}"${raw.engine ? '' : ' (or an "engine" that fills it in)'}.`);
  }
  game._folder = path.resolve(root, game.folder);
  game._argv = Array.isArray(game.run) ? game.run.map(String) : shellWords(String(game.run));
  if (!game._argv.length) throw new Problem(`${file}: ${id} has an empty "run".`);
  return game;
}

export function readProject(file) {
  const data = readJson(file, null);
  if (!data) throw new Problem(`${file} does not exist.`);
  const games = Array.isArray(data.games) ? data.games : [];
  return games.map((g) => normalizeGame(g, path.resolve(file)));
}

export function loadGames({ cwd = process.cwd() } = {}) {
  const games = [];
  for (const file of projectFiles(cwd)) {
    for (const game of readProject(file)) {
      const twin = games.find((g) => g.id.toLowerCase() === game.id.toLowerCase());
      if (twin) throw new Problem(`Two games are called ${game.id}: one in ${twin._file}, one in ${file}. Ids are the names on the Deck, so each needs its own.`);
      games.push(game);
    }
  }
  return games;
}

export function gameNamed(name, { cwd } = {}) {
  const games = loadGames({ cwd });
  if (!games.length) {
    throw new Problem('No games yet. Give the project a glitchless.deck.json (glitchless-deck init writes one) and run from its folder, or list it: glitchless-deck add <file>.');
  }
  if (!name) {
    if (games.length === 1) return games[0];
    throw new Problem(`Which game? ${games.map((g) => g.id).join(', ')}.`);
  }
  const want = String(name).toLowerCase();
  const game = games.find((g) => g.id.toLowerCase() === want || String(g.name || '').toLowerCase() === want);
  if (!game) throw new Problem(`No game called ${JSON.stringify(name)}. Listed: ${games.map((g) => g.id).join(', ')}.`);
  return game;
}

export function addProject(given, { log = () => {} } = {}) {
  let file = path.resolve(given);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = projectFileIn(file) || path.join(file, PROJECT_FILES[0]);
  if (!fs.existsSync(file)) throw new Problem(`${file} is not a file.`);
  const listed = readProject(file);
  if (!listed.length) throw new Problem(`${file} lists no games (it needs a "games" list).`);
  // A name already taken by another file is refused before anything is written.
  for (const game of listed) {
    for (const other of listedProjects()) {
      if (other !== file && readProject(other).some((g) => g.id.toLowerCase() === game.id.toLowerCase())) {
        throw new Problem(`${game.id} is already the name of a game in ${other}. Ids are the names on the Deck, so each needs its own.`);
      }
    }
  }
  const projects = listedProjects();
  if (!projects.includes(file)) projects.push(file);
  writeJson(files().projects, projects);
  log(`Listing ${listed.map((g) => g.id).join(', ')} from ${file}.`);
  return listed;
}

export function forgetProject(given, { log = () => {} } = {}) {
  const file = path.resolve(given);
  writeJson(files().projects, listedProjects().filter((f) => f !== file && path.dirname(f) !== file));
  log(`No longer listing ${file}.`);
}
