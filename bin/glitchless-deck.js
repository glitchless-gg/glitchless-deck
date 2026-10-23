#!/usr/bin/env node
// glitchless-deck: send a game to a Steam Deck on the local network, start it, and measure it.
//
//   glitchless-deck pair                 # once per Deck (approve it on the Deck's screen)
//   glitchless-deck send                 # build, send, add to the Deck's library
//   glitchless-deck launch               # start it on the Deck
//   glitchless-deck measure --save baseline
//   glitchless-deck measure              # after a change: compared with baseline, exit 1 on a regression

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as deck from '../src/index.js';
import { startUi, UI_PORT } from '../src/ui.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const HELP = `glitchless-deck ${PKG.version}: send a game to your Steam Deck, start it, measure it.

Set up
  pair [name|address]          pair with a Deck in Developer Mode (approve it on the Deck)
  init [--engine E] [--id ID]  write glitchless.deck.json for the project in this folder
  add <file> | forget <file>   list another project's glitchless.deck.json (or deck_delivery.json)
  status                       is the Deck there, is Steam running, what's on it
  games                        the games this computer can send

Play
  send [game]                  build, send, add to the library ("Devkit Game: <id>")
    --no-build                   send what is already built
    --launch                     start it once it's there
    --glitchless                 report to the Glitchless server on this computer
    --glitchless-intake=URL      report to another Glitchless server
    --transfer rsync|tar         how files travel (default: rsync if installed, else tar)
  launch [game]                start it on the Deck
  stop [game]                  close it
  logs [game] [--lines N]      what its last run printed (--all: earlier runs and engine logs too)
  art [game]                   set its library artwork again
  remove [game] [--yes]        take it off the Deck: files, library entry, artwork

Measure (Unity, Godot and Unreal builds with the Glitchless SDK)
  measure [game]               play it on the Deck and record frame times
    --seconds S --warmup W       how long (default 10 after 3)
    --save NAME                  save the run as NAME (e.g. baseline)
    --compare NAME               compare with a saved run (default: baseline, when saved)
    --glitchless                 also report the run to Glitchless
    -- <args>                    extra arguments for the game (e.g. -- --level=3)
  compare [game] A B           compare two saved runs

Other
  ui [--port N]                a page to do all of this (http://localhost:${UI_PORT})
  skill [--install]            print the agent skill, or copy it where Claude Code, Codex and Cursor look
  guide                        the full reference (README)
  --deck NAME                  which paired Deck (default: the last one paired)
  --json                       print results as JSON

[game] can be left out when the project in this folder has one game.
Exit codes: 0 done, 1 a measure found a regression, 2 something went wrong.`;

function parseArgs(argv) {
  const out = { _: [], extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.extra = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq < 0 ? undefined : eq);
      if (eq >= 0) out[key] = a.slice(eq + 1);
      else if (['deck', 'transfer', 'port', 'seconds', 'warmup', 'save', 'compare', 'lines', 'engine', 'id', 'name', 'glitchless-intake'].includes(key) && argv[i + 1] != null && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
      else out[key] = true;
    } else if (a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const SKILL_HOMES = ['.claude', '.codex', '.cursor'].map((d) => path.join(os.homedir(), d, 'skills'));

function skill(install, log) {
  const text = fs.readFileSync(path.join(HERE, '..', 'SKILL.md'), 'utf8');
  if (!install) return log(text);
  let wrote = 0;
  for (const home of SKILL_HOMES) {
    if (!fs.existsSync(home)) continue;
    fs.mkdirSync(path.join(home, 'glitchless-deck'), { recursive: true });
    fs.writeFileSync(path.join(home, 'glitchless-deck', 'SKILL.md'), text);
    log(`Skill: ${path.join(home, 'glitchless-deck', 'SKILL.md')}`);
    wrote++;
  }
  if (!wrote) log(`No skills folder found (${SKILL_HOMES.join(', ')}). Copy SKILL.md wherever your agent reads skills: glitchless-deck skill > SKILL.md`);
}

async function main(argv) {
  const o = parseArgs(argv);
  const [command, ...rest] = o._;
  const json = !!o.json;
  // With --json, progress goes to stderr and the result alone to stdout.
  const log = json ? (m) => process.stderr.write(`${m}\n`) : (m) => console.log(m);
  const which = typeof o.deck === 'string' ? o.deck : undefined;
  const game = () => deck.gameNamed(rest[0]);
  const show = (result, text) => (json ? console.log(JSON.stringify(result, null, 2)) : text && console.log(text));
  if (o.version || command === 'version') return console.log(`glitchless-deck ${PKG.version}`), 0;
  if (!command || o.help || command === 'help') return console.log(HELP), command || o.help ? 0 : 2;

  switch (command) {
    case 'pair':
      show(await deck.pair(rest[0], { log }));
      return 0;
    case 'init':
      show(await deck.initProject(process.cwd(), { id: o.id, engine: o.engine, name: o.name, force: !!o.force, log }));
      return 0;
    case 'add':
    case 'forget':
      if (!rest[0]) throw new deck.Problem(`${command} needs the project's glitchless.deck.json (or its folder).`);
      if (command === 'add') deck.addProject(rest[0], { log });
      else deck.forgetProject(rest[0], { log });
      return 0;
    case 'games': {
      const games = deck.loadGames();
      if (json) return show(games.map((g) => ({ id: g.id, name: g.name || g.id, engine: g.engine || null, folder: g._folder, run: g.run, file: g._file }))), 0;
      if (!games.length) log('No games yet. In a project folder: glitchless-deck init');
      for (const g of games) log(`${g.id.padEnd(22)} ${(g.engine || '').padEnd(7)} ${g._folder}  (from ${g._file})`);
      return 0;
    }
    case 'status': {
      const s = await deck.status({ which, log });
      if (json) return show(s), 0;
      if (!s.paired) {
        log(`Not paired. Decks in Developer Mode on this network: ${s.found.map((d) => `${d.name} (${d.address})`).join(', ') || 'none found'}`);
        log('Pair one: glitchless-deck pair');
        return 0;
      }
      log(`${s.deck.name} at ${s.deck.address}: ${s.login ? (s.steam ? 'ready' : 'awake, but Steam is not running') : s.reachable ? 'answering, but this computer cannot log in (pair again)' : 'not answering (asleep or off this network)'}`);
      if (s.on_deck.length) log(`On it: ${s.on_deck.join(', ')}`);
      if (s.decks.length > 1) log(`Paired: ${s.decks.map((d) => d.name).join(', ')} (--deck NAME picks one)`);
      return 0;
    }
    case 'send': {
      const g = game();
      const intake = typeof o['glitchless-intake'] === 'string' ? o['glitchless-intake'] : undefined;
      const r = await deck.send(g, { which, build: !o['no-build'], transfer: typeof o.transfer === 'string' ? o.transfer : undefined, glitchless: !!o.glitchless, intake, log });
      if (o.launch) r.launch = await deck.launch(g, { which, log });
      show(json ? r : null);
      return 0;
    }
    case 'launch':
      show(await deck.launch(game(), { which, log }));
      return 0;
    case 'stop':
      show(await deck.stop(game(), { which, log }));
      return 0;
    case 'logs':
      show(await deck.logs(game(), { which, lines: Number(o.lines) || 80, all: !!o.all, log }));
      return 0;
    case 'art': {
      const g = game();
      const d = await deck.reach(which, { log });
      if (!g.artwork) throw new deck.Problem(`${g.id} has no "artwork" in ${g._file}.`);
      show(await deck.setArtwork(d, g, { log }));
      return 0;
    }
    case 'remove': {
      let g;
      try {
        g = game();
      } catch (err) {
        // A game no project lists (sent from elsewhere) can still be taken off, when asked twice.
        if (!rest[0] || !o.yes) throw new deck.Problem(`${err.message}${rest[0] ? `\nTo take ${rest[0]} off the Deck anyway: glitchless-deck remove ${rest[0]} --yes` : ''}`);
        g = { id: rest[0] };
      }
      show(await deck.remove(g, { which, log }));
      return 0;
    }
    case 'measure': {
      const g = game();
      const r = await deck.measure(g, { which, seconds: Number(o.seconds) || 10, warmup: o.warmup != null ? Number(o.warmup) : 3, saveAs: typeof o.save === 'string' ? o.save : undefined, compareTo: typeof o.compare === 'string' ? o.compare : undefined, args: o.extra, glitchless: !!o.glitchless, intake: typeof o['glitchless-intake'] === 'string' ? o['glitchless-intake'] : undefined, log });
      show(json ? { verdict: r.verdict, run: r.run, comparison: r.comparison, files: r.files } : null, r.report);
      return r.verdict === 'fail' ? 1 : 0;
    }
    case 'compare': {
      const [maybeGame, a, b] = rest.length >= 3 ? rest : [undefined, ...rest];
      if (!a || !b) throw new deck.Problem('compare needs two saved runs, e.g. glitchless-deck compare baseline latest');
      const r = deck.compareSaved(deck.gameNamed(maybeGame), a, b);
      show(json ? { verdict: r.verdict, comparison: r.comparison } : null, r.report);
      return r.verdict === 'fail' ? 1 : 0;
    }
    case 'ui':
      await startUi({ port: Number(o.port) || UI_PORT, log });
      return null;
    case 'skill':
      skill(!!o.install, log);
      return 0;
    case 'guide':
      console.log(fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8'));
      return 0;
    default:
      console.log(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code != null) process.exitCode = code;
  },
  (err) => {
    if (err instanceof deck.Problem) console.error(err.message);
    else console.error(`glitchless-deck: ${err.stack || err.message}`);
    process.exitCode = 2;
  },
);
