// glitchless-deck: send a game build to a Steam Deck on the local network, put it in the Deck's library,
// start it, and measure it with Glitchless. Used by the glitchless-deck CLI, its page (ui.js) and the
// glitchless_deck_* MCP tools.
//
//   await send(gameNamed('MyGame'))                    // build, send, add to the library
//   await launch(gameNamed('MyGame'))
//   await measure(gameNamed('MyGame'), { saveAs: 'baseline' })
//   await measure(gameNamed('MyGame'))                 // → { verdict, report, ... } compared with baseline

export { Problem, loadGames, gameNamed, readProject, addProject, forgetProject, projectFiles, loadDecks, pairedDeck, configDir, PROJECT_FILES } from './config.js';
export { pair, reach, status, chooseDeck, DEVKIT_PORT } from './deck.js';
export { findDecks } from './mdns.js';
export { send, install, setArtwork, readArtwork } from './send.js';
export { launch, stop, logs, remove } from './play.js';
export { measure, compareSaved, listRuns, loadRun, toRun, measureReport } from './measure.js';
export { buildStep, engineDefaults, ENGINES } from './engines.js';
export { checkFolder, checkStart, inspectBinary } from './checks.js';
export { intakeFlags, lanAddressFor } from './glitchless.js';
export { transfer, transferMode } from './transfer.js';
export { initProject, detectEngine } from './init.js';
