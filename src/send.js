// A send: build (when the game has a build step), check what was built, mirror it to the Deck, and
// ask Steam to put it in the library as "Devkit Game: <id>", with its artwork.

import fs from 'node:fs';
import path from 'node:path';
import { pairedDeck } from './config.js';
import { checkFolder, checkStart } from './checks.js';
import { buildStep, resolveArgv, webMode, KIOSK_RUN } from './engines.js';
import { intakeFlags } from './glitchless.js';
import { reach } from './deck.js';
import { RUN_WRAPPER, KIOSK_SH, KIOSK_PY } from './remote.js';
import { helper } from './ssh.js';
import { transfer } from './transfer.js';
import { Problem } from './util.js';

export const isKiosk = (game) => game.engine === 'web' && webMode(game) === 'kiosk';

// Library artwork, by the names Steam's grid folder uses (see remote.js) and the names people use.
const ART_KINDS = { capsule: 'capsule', grid: 'capsule', portrait: 'capsule', wide: 'wide', header: 'wide', horizontal: 'wide', hero: 'hero', logo: 'logo', icon: 'icon' };

/**
 * Writes how Steam starts the game on the Deck and asks Steam to add it (or update it). Linux builds start
 * through a small wrapper that keeps what the game prints; Windows builds start directly, through Proton.
 */
export async function install(deck, game, { gameid = game.id, argv, extra = [], linkTo } = {}) {
  const kiosk = isKiosk(game);
  const files = {};
  let launch;
  if (kiosk) {
    files['.glitchless-kiosk.sh'] = KIOSK_SH;
    files['.glitchless-kiosk.py'] = KIOSK_PY;
    const web = game.web || {};
    launch = [KIOSK_RUN, ...(web.port ? [`--port=${web.port}`] : []), ...(web.query ? [`--query=${String(web.query).replace(/^\//, '')}`] : []), ...extra];
  } else if (game.proton) {
    launch = [...argv, ...extra];
  } else {
    files['.glitchless-run.sh'] = RUN_WRAPPER;
    launch = ['./.glitchless-run.sh', gameid, ...argv, ...extra];
  }
  // As Valve's client sets them: Proton for a Windows build, no compatibility tool for a Linux one.
  const runtime = game.proton ? { steam_play: '1', compat_tool: game.proton === 'experimental' ? 'proton-experimental' : 'proton-stable' } : { steam_play: '0', compat_tool: '' };
  const answer = await helper(deck, { do: 'install', gameid, link_to: linkTo, argv: launch, files, executable: kiosk ? [] : [argv[0]], settings: { ...runtime, ...game.settings }, env: game.env || {}, wait: 15 }, { timeout: 60000 });
  if (answer.error) throw new Problem(`The files are on the Deck, but: ${answer.error}`);
  return { ...answer, argv: launch };
}

export function readArtwork(game) {
  const images = {};
  for (const [key, rel] of Object.entries(game.artwork || {})) {
    const kind = ART_KINDS[key];
    if (!kind) throw new Problem(`${game._file}: unknown artwork "${key}". Use capsule (600x900), wide (920x430), hero (3840x1240), logo or icon.`);
    const file = path.resolve(game._root, rel);
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg');
    if (!['png', 'jpg'].includes(ext)) throw new Problem(`${rel}: artwork has to be a .png or .jpg.`);
    if (!fs.existsSync(file)) throw new Problem(`${rel} (the ${key} artwork) is not there.`);
    if (fs.statSync(file).size > 15 * 1048576) throw new Problem(`${rel} is over 15 MB; Steam artwork should be far smaller.`);
    images[kind] = { ext, b64: fs.readFileSync(file).toString('base64') };
  }
  return images;
}

export async function setArtwork(deck, game, { gameid = game.id, log = () => {}, clear = [] } = {}) {
  const images = readArtwork(game);
  if (!Object.keys(images).length && !clear.length) return null;
  // Steam writes a new library entry to disk a moment after adding it.
  let answer;
  for (let i = 0; i < 6; i++) {
    answer = await helper(deck, { do: 'art', gameid, images, clear });
    if (!answer.error || !/has not written/.test(answer.error)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (answer.error) throw new Problem(`The game is on the Deck, but its artwork was not set: ${answer.error}`);
  log(`Artwork: ${answer.written.join(', ') || 'cleared'}.`);
  return answer;
}

export async function send(game, { which, build = true, transfer: mode, glitchless = false, intake, log = console.log, platform = process.platform } = {}) {
  const started = Date.now();
  pairedDeck(which); // not paired: say so before building
  const step = build ? buildStep(game, { platform }) : null;
  if (step) {
    log(`Building ${game.id}: ${step.label}`);
    await step.go(log);
  }
  checkFolder(game);
  const argv = resolveArgv(game);
  const kind = checkStart(game, argv, { kiosk: isKiosk(game) });
  readArtwork(game); // a missing picture stops the send before anything moves
  const deck = await reach(which, { log });
  const glitch = glitchless || intake ? await intakeFlags(deck, { intake, log }) : null;
  const moved = await transfer(deck, game, { mode, log, platform });
  const installed = await install(deck, game, { argv, extra: glitch?.flags || [] });
  let artwork = null;
  if (game.artwork) {
    try {
      artwork = await setArtwork(deck, game, { log });
    } catch (err) {
      log(String(err.message));
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`Done in ${seconds}s. On the Deck: Library > Non-Steam > Devkit Game: ${game.id}`);
  return { game: game.id, deck: { name: deck.name, address: deck.address }, seconds, kind: kind.kind, transfer: moved, steam: installed.success, argv: installed.argv, intake: glitch?.url || null, artwork };
}
