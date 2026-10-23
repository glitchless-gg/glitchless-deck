// Engine recipes. "engine" in a game's entry fills in what the entry leaves out: where the build goes,
// how it starts, and a build step that makes something the Deck runs (Linux x86-64, or Windows x64
// through Proton). Anything the entry sets itself wins, and "build": false skips the build step.
//
//   godot   Linux export with the project's Linux preset
//   unity   Linux64 player in batch mode
//   unreal  Win64 played through Proton (built on Windows), or Linux (built on Linux, or on Windows
//           with Epic's cross-compile toolchain). A Mac can't make either: send a build made elsewhere.
//   web     the web build served on the Deck and shown in a browser in kiosk mode, or with
//           "web": { "mode": "electron" } an Electron app packaged for Linux x64

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, run, Problem } from './util.js';
import { inspectBinary } from './checks.js';

export const ENGINES = ['godot', 'unity', 'unreal', 'web'];
// The kiosk launcher is written into the game's folder on the Deck when it is sent (see remote.js).
export const KIOSK_RUN = './.glitchless-kiosk.sh';

export const webMode = (game) => (game.web?.mode === 'electron' ? 'electron' : 'kiosk');
export const unrealTarget = (game, platform = process.platform) => (game.unreal?.target || (platform === 'win32' ? 'win64' : 'linux')).toLowerCase();

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function uprojectIn(game, root) {
  if (game.unreal?.project) return path.resolve(root, game.unreal.project);
  try {
    const found = fs.readdirSync(root).find((f) => f.endsWith('.uproject'));
    return found ? path.join(root, found) : null;
  } catch {
    return null;
  }
}

export function engineDefaults(game, { root = '.', platform = process.platform } = {}) {
  switch (game.engine) {
    case 'godot':
    case 'unity':
      return { folder: 'build/deck', run: `./${game.id}.x86_64` };
    case 'unreal': {
      const uproject = uprojectIn(game, root);
      const name = uproject ? path.basename(uproject, '.uproject') : game.id;
      return unrealTarget(game, platform) === 'win64'
        ? { folder: 'build/deck', run: `./Windows/${name}.exe`, proton: true }
        : { folder: 'build/deck', run: `./Linux/${name}.sh` };
    }
    case 'web': {
      if (webMode(game) === 'kiosk') return { folder: 'dist', run: KIOSK_RUN };
      const pkg = readPackage(root) || {};
      const name = pkg.productName || pkg.name || game.id;
      const forge = pkg.devDependencies?.['@electron-forge/cli'] || pkg.dependencies?.['@electron-forge/cli'];
      // Electron's sandbox helper needs to be setuid root, which a copied folder never is.
      return { folder: forge ? `out/${name}-linux-x64` : 'dist/linux-unpacked', run: `./${pkg.name || name} --no-sandbox` };
    }
  }
  return {};
}

/**
 * The start command as it will run on the Deck. Unreal and Electron builds name their files in ways the
 * entry can't always know ahead (UE4's WindowsNoEditor, an Electron binary named after productName), so
 * when the default isn't there, look for what is.
 */
export function resolveArgv(game) {
  const argv = [...game._argv];
  const there = (rel) => fs.existsSync(path.resolve(game._folder, rel));
  if (there(argv[0]) || game.run !== engineDefaults(game, { root: game._root }).run) return argv;
  if (game.engine === 'unreal') {
    const alt = argv[0].replace(/^\.\/(Windows|Linux)\//, (_, p) => `./${p}NoEditor/`);
    if (there(alt)) argv[0] = alt;
  } else if (game.engine === 'web' && webMode(game) === 'electron' && fs.existsSync(game._folder)) {
    const skip = /^(chrome-sandbox|chrome_crashpad_handler)$|\.so(\.|$)/;
    const bins = fs.readdirSync(game._folder).filter((f) => !skip.test(f) && fs.statSync(path.join(game._folder, f)).isFile() && inspectBinary(path.join(game._folder, f)).kind === 'elf');
    if (bins.length === 1) argv[0] = `./${bins[0]}`;
  }
  return argv;
}

/** What `send` does before sending, or null when there is nothing to build. */
export function buildStep(game, { platform = process.platform } = {}) {
  if (game.build === false) return null;
  if (typeof game.build === 'string' && game.build.trim()) {
    return { label: game.build, go: (log) => shellBuild(game, game.build, log) };
  }
  switch (game.engine) {
    case 'godot':
      return { label: 'Godot Linux export', go: (log) => buildGodot(game, log, platform) };
    case 'unity':
      return { label: 'Unity Linux64 build', go: (log) => buildUnity(game, log, platform) };
    case 'unreal':
      return { label: `Unreal ${unrealTarget(game, platform) === 'win64' ? 'Win64' : 'Linux'} build`, go: (log) => buildUnreal(game, log, platform) };
    case 'web': {
      const pkg = readPackage(game._root);
      if (webMode(game) === 'electron') return { label: 'Electron Linux x64 package', go: (log) => buildElectron(game, pkg, log) };
      if (pkg?.scripts?.build) return { label: 'npm run build', go: (log) => shellBuild(game, 'npm run build', log) };
      return null;
    }
  }
  return null;
}

async function shellBuild(game, command, log) {
  const r = await run(command, [], { cwd: game._root, shell: true, onLine: log });
  if (r.code !== 0) throw new Problem(`The build failed (exit ${r.code}); nothing was sent.`);
}

const logFileFor = (game) => path.join(path.dirname(game._folder), `${path.basename(game._folder)}-build.log`);

function tail(file, lines = 15) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ─── Godot ───

export function godotPresets(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, 'export_presets.cfg'), 'utf8');
  } catch {
    return [];
  }
  const presets = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\[preset\.(\d+)(\.options)?\]/);
    if (section) {
      current = section[2] ? presets.find((p) => p.index === section[1]) : { index: section[1] };
      if (!section[2]) presets.push(current);
      continue;
    }
    const kv = line.match(/^([\w/.]+)="?(.*?)"?$/);
    if (current && kv) {
      if (kv[1] === 'name') current.name = kv[2];
      if (kv[1] === 'platform') current.platform = kv[2];
      if (kv[1] === 'binary_format/architecture') current.arch = kv[2];
    }
  }
  return presets;
}

function godotBinary(game, platform) {
  const given = game.godot?.binary || process.env.GODOT;
  if (given) return given;
  const found = which('godot', { platform }) || which('godot4', { platform });
  if (found) return found;
  const mac = ['/Applications/Godot.app/Contents/MacOS/Godot', '/Applications/Godot_mono.app/Contents/MacOS/Godot', path.join(os.homedir(), 'Applications/Godot.app/Contents/MacOS/Godot')];
  if (platform === 'darwin') for (const p of mac) if (fs.existsSync(p)) return p;
  throw new Problem('Godot was not found. Put it on the PATH as godot, or set GODOT=/path/to/godot (or "godot": { "binary": ... } in the game entry).');
}

async function buildGodot(game, log, platform) {
  const presets = godotPresets(game._root).filter((p) => /^linux/i.test(p.platform || ''));
  const wanted = game.godot?.preset;
  const preset = wanted ? presets.find((p) => p.name === wanted) : presets[0];
  if (!preset) {
    throw new Problem(wanted ? `The Godot project has no Linux export preset called "${wanted}" (export_presets.cfg).` : 'The Godot project has no Linux export preset. Add one: Project > Export > Add... > Linux, then save.');
  }
  if (preset.arch && preset.arch !== 'x86_64') throw new Problem(`The "${preset.name}" preset builds for ${preset.arch}; the Deck needs x86_64 (Export > Linux > Binary Format > Architecture).`);
  const bin = godotBinary(game, platform);
  const out = path.resolve(game._folder, game._argv[0]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const logFile = logFileFor(game);
  const started = Date.now();
  log(`Godot: importing, then exporting with the "${preset.name}" preset`);
  const steps = [['--headless', '--path', game._root, '--import'], ['--headless', '--path', game._root, '--export-release', preset.name, out]];
  let text = '';
  for (const args of steps) {
    const r = await run(bin, args, { cwd: game._root });
    text += r.stdout + r.stderr;
  }
  fs.writeFileSync(logFile, text);
  // An export can say it worked and make nothing: look for what it should have made.
  let made = null;
  try {
    made = fs.statSync(out);
  } catch {}
  if (!made || !made.size || made.mtimeMs < started - 2000) {
    const hint = /export template/i.test(text) ? '\nInstall the export templates: Editor > Manage Export Templates > Download and Install.' : '';
    throw new Problem(`The Godot export did not make ${path.basename(out)} (log: ${logFile}).${hint}\n${tail(logFile)}`);
  }
}

// ─── Unity ───

function unityEditor(game, root, platform) {
  const given = game.unity?.editor || process.env.UNITY;
  if (given) return { editor: given };
  let version;
  try {
    version = fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').match(/m_EditorVersion:\s*(\S+)/)[1];
  } catch {
    throw new Problem(`${root} doesn't look like a Unity project (no ProjectSettings/ProjectVersion.txt).`);
  }
  const hub = {
    darwin: [`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`, `/Applications/Unity/Hub/Editor/${version}/PlaybackEngines/LinuxStandaloneSupport`],
    win32: [`C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Unity.exe`, `C:\\Program Files\\Unity\\Hub\\Editor\\${version}\\Editor\\Data\\PlaybackEngines\\LinuxStandaloneSupport`],
    linux: [path.join(os.homedir(), `Unity/Hub/Editor/${version}/Editor/Unity`), path.join(os.homedir(), `Unity/Hub/Editor/${version}/Editor/Data/PlaybackEngines/LinuxStandaloneSupport`)],
  }[platform] || [];
  if (!hub[0] || !fs.existsSync(hub[0])) throw new Problem(`Unity ${version} (the project's version) is not installed where Unity Hub puts it. Install it with Unity Hub, or set UNITY=/path/to/Unity.`);
  if (platform !== 'linux' && !fs.existsSync(hub[1])) throw new Problem(`Unity ${version} has no Linux Build Support. Unity Hub > Installs > ${version} > Add modules > Linux Build Support (Mono).`);
  return { editor: hub[0], version };
}

async function buildUnity(game, log, platform) {
  const { editor } = unityEditor(game, game._root, platform);
  const out = path.resolve(game._folder, game._argv[0]);
  const logFile = logFileFor(game);
  fs.rmSync(game._folder, { recursive: true, force: true });
  fs.mkdirSync(game._folder, { recursive: true });
  log('Unity: Linux64 build in batch mode (the Editor must be closed on this project)');
  const r = await run(editor, ['-batchmode', '-quit', '-nographics', '-projectPath', game._root, '-buildTarget', 'Linux64', '-buildLinux64Player', out, '-logFile', logFile], { cwd: game._root });
  if (r.code !== 0 || !fs.existsSync(out)) {
    const text = tail(logFile, 400);
    const hint = /another Unity instance is running/i.test(text) ? '\nClose the Unity Editor on this project first: batch mode cannot open a project that is already open.' : '';
    throw new Problem(`The Unity build failed (log: ${logFile}).${hint}\n${tail(logFile)}`);
  }
  // Debug folders Unity leaves beside the player: the Deck does not need them.
  for (const f of fs.readdirSync(game._folder)) {
    if (/_BurstDebugInformation_DoNotShip$|_BackUpThisFolder_ButDontShipIt$/.test(f)) fs.rmSync(path.join(game._folder, f), { recursive: true, force: true });
  }
}

// ─── Unreal ───

function unrealEngine(game) {
  const given = game.unreal?.engine || process.env.UE_ROOT || process.env.UNREAL_ENGINE_ROOT;
  if (given) return given;
  const base = 'C:\\Program Files\\Epic Games';
  try {
    const versions = fs.readdirSync(base).filter((d) => /^UE_\d/.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length) return path.join(base, versions.at(-1));
  } catch {}
  throw new Problem('Unreal Engine was not found. Set UE_ROOT to the engine folder (the one with Engine/ in it), or "unreal": { "engine": ... } in the game entry.');
}

async function buildUnreal(game, log, platform) {
  const target = unrealTarget(game, platform);
  if (platform === 'darwin') {
    throw new Problem('Unreal cannot make a Steam Deck build on a Mac. Build on Windows (Win64, played through Proton) or Linux, copy the packaged folder here, and send it with "build": false and "folder" set to it.');
  }
  if (target === 'linux' && platform === 'win32' && !process.env.LINUX_MULTIARCH_ROOT) {
    throw new Problem('A Linux build on Windows needs Epic\'s Linux cross-compile toolchain (LINUX_MULTIARCH_ROOT is not set). Install it, or use "unreal": { "target": "win64" } to play the Windows build through Proton.');
  }
  const uproject = uprojectIn(game, game._root);
  if (!uproject) throw new Problem(`No .uproject in ${game._root} (or set "unreal": { "project": ... }).`);
  const engine = unrealEngine(game);
  const uat = path.join(engine, 'Engine', 'Build', 'BatchFiles', platform === 'win32' ? 'RunUAT.bat' : 'RunUAT.sh');
  if (!fs.existsSync(uat)) throw new Problem(`${uat} is not there: is UE_ROOT the engine folder?`);
  fs.rmSync(game._folder, { recursive: true, force: true });
  const args = ['BuildCookRun', `-project=${uproject}`, '-noP4', `-platform=${target === 'win64' ? 'Win64' : 'Linux'}`, `-clientconfig=${game.unreal?.config || 'Development'}`, '-build', '-cook', '-stage', '-pak', '-archive', `-archivedirectory=${game._folder}`, '-utf8output', '-unattended'];
  log(`Unreal: BuildCookRun for ${target === 'win64' ? 'Win64' : 'Linux'} (this takes a while the first time)`);
  // Node runs a .bat only through the shell, so quote what has spaces in it.
  const q = (a) => (platform === 'win32' && /\s/.test(a) ? `"${a}"` : a);
  const r = await run(q(uat), args.map(q), { cwd: game._root, shell: platform === 'win32', onLine: log });
  if (r.code !== 0) throw new Problem(`The Unreal build failed (RunUAT exit ${r.code}); nothing was sent.`);
}

// ─── Web ───

async function buildElectron(game, pkg, log) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const command = deps['electron-builder'] ? 'npx electron-builder --linux dir --x64' : deps['@electron-forge/cli'] ? 'npx electron-forge package --platform=linux --arch=x64' : null;
  if (!command) throw new Problem('Neither electron-builder nor Electron Forge is in package.json. Set "build" to the command that packages the app for Linux x64, and "folder" to where it lands.');
  await shellBuild(game, command, log);
}
