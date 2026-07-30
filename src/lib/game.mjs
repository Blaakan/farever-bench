// ---------------------------------------------------------------------------
// game.mjs - find the Farever install, on somebody else's machine.
//
// Copied from Blaakan/farever-mods (tools/lib/game.mjs), same MIT licence, with
// only the cache path changed for this repo's layout. Kept as a copy rather
// than a dependency so this repo clones and runs on its own.
//
// Every tool here needs the same answer to the same question, and each one
// used to guess at it separately with its own list of drive letters. That
// works on exactly one computer. This is the single place that knows how to
// look, so a tool that finds the game finds it for all of them.
//
// The order is deliberate: anything the user said explicitly beats anything
// we worked out, and anything we worked out from Steam's own records beats a
// guess at a path.
//
//   1. --game <path> on the command line
//   2. FAREVER_DIR in the environment
//   3. .cache/game-path.txt, remembered from the last successful find
//   4. Steam's own library list, found through the registry
//   5. Steam's library list at the two default install paths
//   6. a short list of common paths, as a last resort
//
// A find is remembered (3) so the answer survives to the next tool, and so a
// user with an unusual install answers the question once.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
         statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '..', '..', '.cache', 'game-path.txt');

// What makes a directory the game rather than a directory. hlboot.dat is the
// bytecode every scanner reads and Farever.exe is what the host installs
// next to, so a folder without both is not the one we want - a leftover
// depot or a half-deleted install would otherwise pass.
export function isGameDir(dir) {
  if (!dir) return false;
  try {
    return existsSync(join(dir, 'hlboot.dat')) &&
           existsSync(join(dir, 'Farever.exe'));
  } catch {
    return false;
  }
}

// A path the user typed, which may point at the folder or at a file in it.
function normalise(p) {
  if (!p) return null;
  let dir = resolve(p);
  try {
    if (existsSync(dir) && statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    return null;
  }
  return dir;
}

function fromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--game' && argv[i + 1]) return normalise(argv[i + 1]);
    if (argv[i].startsWith('--game=')) return normalise(argv[i].slice(7));
  }
  return null;
}

// Where Steam itself says it is. The 32-bit view is where the installer
// writes it; the per-user key is the one that survives a reinstall onto
// another drive.
function steamRoots() {
  const roots = [];

  // Through PowerShell rather than reg.exe. `reg query` writes in the
  // console's OEM code page - CP850 here - so a Steam installed under
  // `C:\Jeux\Stèam` or any accented path comes back with replacement
  // characters, the directory check fails, and the root is silently dropped.
  // Decoding it needs the active code page, which is one more thing to get
  // wrong; PowerShell hands back UTF-8 and answers all three keys in one
  // process, which is also cheaper than three `reg` spawns.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "@(",
    " (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath",
    " (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam').InstallPath",
    " (Get-ItemProperty 'HKLM:\\SOFTWARE\\Valve\\Steam').InstallPath",
    ") | Where-Object { $_ } | ForEach-Object { $_ }",
  ].join('; ');
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-OutputEncoding', 'utf8', '-Command', script],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }
    );
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p) roots.push(p.replace(/\\/g, '/'));
    }
  } catch {
    // No PowerShell, no Steam, or no such key. All ordinary, and the
    // defaults below cover the common installs regardless.
  }

  const pf = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  roots.push(join(pf, 'Steam').replace(/\\/g, '/'));
  roots.push('C:/Program Files/Steam');
  return [...new Set(roots)];
}

// Steam records every library folder it knows, including the ones on drives
// no guess would reach. The file is Valve's own key-value format; the only
// thing wanted from it is each library's path.
function steamLibraries() {
  const libs = [];
  for (const root of steamRoots()) {
    for (const name of ['libraryfolders.vdf', 'steamapps/libraryfolders.vdf']) {
      const vdf = join(root, name);
      if (!existsSync(vdf)) continue;
      let txt = '';
      try {
        txt = readFileSync(vdf, 'utf8');
      } catch {
        continue;
      }
      for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g))
        libs.push(m[1].replace(/\\\\/g, '/').replace(/\\/g, '/'));
    }
    libs.push(root);   // the default library lives under Steam itself
  }
  return [...new Set(libs)];
}

// Steam names the install folder in the app's manifest, so a library whose
// folder is not literally "Farever" still resolves. Falling back to a scan
// of steamapps/common covers a manually moved install.
function inLibrary(lib) {
  const common = join(lib, 'steamapps', 'common');
  const found = [];
  const direct = join(common, 'Farever');
  if (isGameDir(direct)) found.push(direct);

  try {
    for (const f of readdirSync(join(lib, 'steamapps'))) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      const txt = readFileSync(join(lib, 'steamapps', f), 'utf8');
      if (!/"name"\s+"Farever"/i.test(txt)) continue;
      const m = txt.match(/"installdir"\s+"([^"]+)"/);
      if (m) {
        const dir = join(common, m[1]);
        if (isGameDir(dir)) found.push(dir);
      }
    }
  } catch {
    // No steamapps here.
  }

  if (!found.length) {
    try {
      for (const d of readdirSync(common)) {
        if (!/farever/i.test(d)) continue;
        const dir = join(common, d);
        if (isGameDir(dir)) found.push(dir);
      }
    } catch {
      // No common folder here.
    }
  }
  return found;
}

function commonGuesses() {
  const out = [];
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  out.push(join(pf86, 'Steam/steamapps/common/Farever'));
  out.push('C:/Program Files/Steam/steamapps/common/Farever');
  for (const d of 'CDEFGH')
    out.push(`${d}:/SteamLibrary/steamapps/common/Farever`);
  for (const d of 'CDEFGH') out.push(`${d}:/Games/Farever`);
  return out;
}

function readCache() {
  try {
    const dir = readFileSync(CACHE, 'utf8').trim();
    return isGameDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

function writeCache(dir) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, dir + '\n');
  } catch {
    // Remembering is a convenience; failing to is not an error.
  }
}

// The whole search, in order. Returns the directory containing Farever.exe,
// or null. `argv` defaults to this process's arguments so a tool gets
// --game support by doing nothing.
export function findGame(argv = process.argv.slice(2)) {
  const explicit = fromArgv(argv) || normalise(process.env.FAREVER_DIR);
  if (explicit) {
    if (isGameDir(explicit)) return explicit;
    // Somebody who named a path meant that path. Falling through to a guess
    // would "work" while reading a different install than the one asked
    // for - and on a machine with two, that is a bug you never see.
    console.error('');
    console.error(`Not a Farever install: ${explicit}`);
    console.error('  (no hlboot.dat and Farever.exe in it)');
    console.error('');
    process.exit(1);
  }

  const cached = readCache();
  if (cached) return cached;

  for (const lib of steamLibraries()) {
    for (const dir of inLibrary(lib)) {
      writeCache(dir);
      return dir;
    }
  }
  for (const c of commonGuesses()) {
    if (isGameDir(c)) {
      writeCache(c);
      return c;
    }
  }
  return null;
}

// For tools that cannot do anything without the game. Prints the one message
// worth printing - what to do about it - and stops.
export function requireGame(argv = process.argv.slice(2)) {
  const dir = findGame(argv);
  if (dir) return dir;
  console.error('');
  console.error('Farever install not found.');
  console.error('');
  console.error('Looked in: the --game argument, FAREVER_DIR, every Steam');
  console.error('library folder Steam itself knows about, and the usual paths.');
  console.error('');
  console.error('Point at it directly with either:');
  console.error('  node tools/<tool>.mjs --game "D:\\SteamLibrary\\steamapps\\common\\Farever"');
  console.error('  set FAREVER_DIR=D:\\SteamLibrary\\steamapps\\common\\Farever');
  console.error('');
  console.error('That folder is the one containing Farever.exe and hlboot.dat.');
  console.error('');
  process.exit(1);
}

// The bytecode, which is what the scanners actually read. A path given
// positionally still wins, because that is how these tools were always
// driven and a bytecode file can legitimately live outside an install.
export function findBoot(argv = process.argv.slice(2)) {
  const positional = argv.find((a) => /hlboot\.dat$/i.test(a));
  if (positional && existsSync(positional)) return positional;
  const dir = findGame(argv);
  return dir ? join(dir, 'hlboot.dat') : null;
}

export function requireBoot(argv = process.argv.slice(2)) {
  const boot = findBoot(argv);
  if (boot && existsSync(boot)) return boot;
  requireGame(argv);           // prints the message and exits
  return null;                 // unreachable
}
