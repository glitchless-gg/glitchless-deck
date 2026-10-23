// Starting, stopping and inspecting a game that is already on the Deck, and taking it off.
//
// A launch asks Steam to start the library entry ("run-game", as Valve's steam-devkit-rpc sends it), so
// the game runs as players see it: in Gaming Mode, under gamescope, with the Steam overlay. Linux builds
// start through a wrapper that keeps what they print, which `logs` reads back with the engine's own log.

import { MEASURE_SUFFIX } from './config.js';
import { reach } from './deck.js';
import { helper } from './ssh.js';
import { Problem } from './util.js';

async function onDeck(deck, game) {
  const hello = await helper(deck, { do: 'hello' });
  if (hello.error) throw new Problem(hello.error);
  if (!hello.games.includes(game.id)) throw new Problem(`${game.id} is not on the Deck yet. Send it first: glitchless-deck send ${game.id}`);
  if (!hello.steam) throw new Problem('Steam is not running on the Deck. Wake it, wait for Gaming Mode, and try again.');
  return hello;
}

export async function launch(game, { which, log = console.log, settle = 4000 } = {}) {
  const deck = await reach(which, { log });
  log(`Asking Steam on ${deck.name} to start ${game.id}...`);
  await onDeck(deck, game);
  const stopped = await helper(deck, { do: 'stop', gameid: game.id });
  if (stopped.stopped) log(`Closed the ${game.id} that was running.`);
  const answer = await helper(deck, { do: 'steam', command: 'run-game/', params: { gameid: game.id }, wait: 20 });
  if (answer.error) throw new Problem(`Steam did not start ${game.id}: ${answer.error}`);
  // A game that dies at once (a missing library, a bad flag) is worth knowing about now.
  await new Promise((r) => setTimeout(r, settle));
  const running = await helper(deck, { do: 'running', gameid: game.id });
  const up = !running.error && running.pids.length > 0;
  // Proton's processes don't all run from the game's folder, so not finding one there proves nothing.
  if (game.proton && !up) log(`Steam started ${game.id} on ${deck.name} through Proton.`);
  else log(up ? `${game.id} is running on ${deck.name}. glitchless-deck logs ${game.id} shows what it prints.` : `Steam started ${game.id}, but it is not running ${Math.round(settle / 1000)} seconds later. See why: glitchless-deck logs ${game.id}`);
  return { game: game.id, deck: deck.name, running: game.proton && !up ? null : up, steam: answer.success };
}

export async function stop(game, { which, log = console.log } = {}) {
  const deck = await reach(which, { log });
  const answer = await helper(deck, { do: 'stop', gameid: game.id });
  if (answer.error) throw new Problem(answer.error);
  log(answer.stopped ? `Closed ${game.id}${answer.forced ? ' (it had to be forced)' : ''}.` : `${game.id} was not running.`);
  return answer;
}

export async function logs(game, { which, lines = 80, all = false, log = console.log } = {}) {
  const deck = await reach(which, { log: () => {} });
  const answer = await helper(deck, { do: 'logs', gameid: game.id, engine: game.engine, proton: !!game.proton, lines, all });
  if (answer.error) throw new Problem(answer.error);
  if (!answer.logs.length) {
    log(game.proton ? `No logs from ${game.id} yet. A Proton build keeps its own: add "env": { "PROTON_LOG": "1" } to the game, send it and play it again.` : `No logs from ${game.id} yet: launch it first.`);
  }
  for (const l of answer.logs) log(`── ${l.path} (${new Date(l.modified * 1000).toLocaleString()}) ──\n${l.text}\n`);
  return answer.logs;
}

export async function remove(game, { which, log = console.log } = {}) {
  const deck = await reach(which, { log });
  const answer = await helper(deck, { do: 'remove', gameid: game.id });
  if (answer.error) throw new Problem(answer.error);
  for (const w of answer.warnings) log(w);
  log(answer.removed.length ? `Took ${game.id} off ${deck.name}: its files, its library entry${answer.removed.some((p) => p.endsWith(MEASURE_SUFFIX)) ? ', its measure entry' : ''} and its artwork.` : `${game.id} was not on ${deck.name}.`);
  return answer;
}
