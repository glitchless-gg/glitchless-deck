// `glitchless-deck init`: a glitchless.deck.json for the project in this folder, with the engine read
// from what is there (project.godot, a Unity ProjectSettings folder, a .uproject, a package.json).

import fs from 'node:fs';
import path from 'node:path';
import { GAME_ID, PROJECT_FILES, projectFileIn, readProject, Problem } from './config.js';

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** { engine, name, web? } for the project in dir, or null. */
export function detectEngine(dir) {
  const godot = read(path.join(dir, 'project.godot'));
  if (godot != null) return { engine: 'godot', name: godot.match(/config\/name="([^"]*)"/)?.[1] || path.basename(dir) };
  if (fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'))) {
    const settings = read(path.join(dir, 'ProjectSettings', 'ProjectSettings.asset')) || '';
    return { engine: 'unity', name: settings.match(/^\s*productName:\s*(.+)$/m)?.[1]?.trim() || path.basename(dir) };
  }
  const uproject = fs.readdirSync(dir).find((f) => f.endsWith('.uproject'));
  if (uproject) return { engine: 'unreal', name: path.basename(uproject, '.uproject') };
  const pkg = read(path.join(dir, 'package.json'));
  if (pkg != null) {
    const p = JSON.parse(pkg);
    const electron = !!({ ...p.dependencies, ...p.devDependencies }).electron;
    return { engine: 'web', name: p.productName || p.name || path.basename(dir), ...(electron ? { web: { mode: 'electron' } } : {}) };
  }
  return null;
}

/** A Deck name from a project name: letters, digits, _ and ., starting with a letter. */
export function idFrom(name) {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  let id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!/^[A-Za-z_]/.test(id)) id = `Game${id}`;
  return GAME_ID.test(id) ? id : 'MyGame';
}

export function initProject(dir, { id, engine, name, force = false, log = console.log } = {}) {
  const existing = projectFileIn(dir);
  if (existing && !force) throw new Problem(`${existing} is already there (glitchless-deck games lists what it holds). Use --force to write a new one.`);
  const found = detectEngine(dir);
  if (!found && !engine) throw new Problem(`No Godot, Unity, Unreal or web project in ${dir}. Run init in the project's folder, or give --engine.`);
  const game = { id: id || idFrom(name || found?.name || path.basename(dir)), name: name || found?.name || path.basename(dir), engine: engine || found.engine, ...(found?.web && !engine ? { web: found.web } : {}) };
  if (!GAME_ID.test(game.id)) throw new Problem(`"${game.id}" can't be a Deck name: letters, digits, _ and ., starting with a letter.`);
  const file = existing || path.join(dir, PROJECT_FILES[0]);
  fs.writeFileSync(file, `${JSON.stringify({ games: [game] }, null, 2)}\n`);
  const [read] = readProject(file);
  log(`Wrote ${file}: ${game.id} (${game.engine}), built into ${read.folder}, started with ${read.run}.`);
  log(`Add ${read.folder}/ and .glitchless/ to .gitignore. Then: glitchless-deck send`);
  return read;
}
