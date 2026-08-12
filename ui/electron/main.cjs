// ---------------------------------------------------------------------------
// Electron shell: find the game, start the bench UI server in-process, open a
// window on it.
//
// The server owns every engine import; this file decides two things - where
// the bench root is, and where Farever is. Packaged builds carry src/ and bin/
// under resources/bench (see package.json extraResources), a dev run walks up
// from ui/electron/.
//
// Two facts shape everything below, both learned the hard way:
//
//  - src/lib/game.mjs is written for a CLI: given an install it cannot use it
//    prints to stderr and calls process.exit(1). In a window that is not an
//    error, it is a double-click that does nothing at all. So the install is
//    resolved HERE, with findGame() (never requireGame()), and FAREVER_DIR -
//    the supported override, checked before any guessing - is set from the
//    answer before the server is imported. The optimizer child process
//    inherits it, which is why it is an env var and not just an argument.
//
//  - the portable exe unpacks to a NEW temp directory on every launch, so
//    nothing written next to the bundled bench survives. The answer to "where
//    is your Farever?" therefore lives in Electron's userData directory, and
//    the bundled .cache is pointed at userData too so the BC7 icon cache is
//    decoded once in the life of the machine rather than once per launch.
//
// `--setup` (or FAREVER_BENCH_SETUP=1) skips the remembered path and asks
// again - for a moved install, or a second one.
// ---------------------------------------------------------------------------
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BENCH_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'bench')
  : path.join(__dirname, '..', '..');

// pathToFileURL, not string surgery: the packaged root is a temp path and the
// dev root is wherever the repo is cloned - either can contain a space.
const importBench = (rel) => import(pathToFileURL(path.join(BENCH_ROOT, rel)).href);

const SETUP_PAGE = path.join(BENCH_ROOT, 'ui', 'web', 'setup.html');
const FORCE_SETUP = process.argv.includes('--setup')
  || process.env.FAREVER_BENCH_SETUP === '1';

let mainWindow = null;
let setupWindow = null;
let pickResolve = null;
// Between the setup window closing and the sheet opening there is a moment
// with no windows at all; quitting on it would end the launch it is part of.
let booting = true;

// --- what the user told us last time ----------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function rememberGame(dir) {
  try {
    const now = readSettings();
    if (now.gamePath === dir) return;
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(),
      JSON.stringify({ ...now, gamePath: dir }, null, 2) + '\n');
  } catch {
    // Remembering is a convenience; failing to is not a reason to stop.
  }
}

// The engine's own test, kept in step with src/lib/game.mjs isGameDir(): a
// folder without both files is a leftover depot or a half-deleted install,
// and accepting it only moves the failure somewhere less explainable.
function isGameDir(dir) {
  try {
    return !!dir && fs.existsSync(path.join(dir, 'hlboot.dat'))
      && fs.existsSync(path.join(dir, 'Farever.exe'));
  } catch {
    return false;
  }
}

// A path from the environment may name Farever.exe rather than its folder.
function normalise(p) {
  if (!p) return null;
  try {
    const abs = path.resolve(p);
    return fs.existsSync(abs) && fs.statSync(abs).isFile() ? path.dirname(abs) : abs;
  } catch {
    return null;
  }
}

// benchRoot/.cache is where BOTH halves of the bench keep state: ui/icons.mjs
// decodes portraits into .cache/ui-icons, and src/lib/game.mjs memoises the
// install path in .cache/game-path.txt. Both derive that directory from
// benchRoot alone, so a junction is the only redirect available from here -
// and it is enough, because everything under it is regenerable.
function persistCache() {
  if (!app.isPackaged) return;         // a dev run already has a real .cache
  const link = path.join(BENCH_ROOT, '.cache');
  // NOT userData/cache: Windows paths are case-insensitive and Chromium's own
  // disk cache is userData/Cache, so that name lands the bench's state inside
  // a directory the browser engine considers its own to empty.
  const target = path.join(app.getPath('userData'), 'bench-cache');
  try {
    fs.mkdirSync(target, { recursive: true });
    if (fs.existsSync(link)) return;
    fs.symlinkSync(target, link, 'junction');
  } catch {
    // No junction: the icon cache is rebuilt each launch. Slower first paint,
    // nothing broken.
  }
}

// --- finding the game -------------------------------------------------------

function savedGame() {
  const dir = normalise(readSettings().gamePath);
  return isGameDir(dir) ? dir : null;
}

function envGame() {
  const dir = normalise(process.env.FAREVER_DIR);
  if (isGameDir(dir)) return dir;
  // An unusable FAREVER_DIR cannot just be ignored: findGame() reads it as an
  // explicit answer and exits the process rather than falling through to a
  // guess. Clearing it turns "the app dies" into "the app looks properly".
  if (process.env.FAREVER_DIR) delete process.env.FAREVER_DIR;
  return null;
}

async function autoDetect() {
  try {
    const { findGame } = await importBench('src/lib/game.mjs');
    // Empty argv on purpose: Electron's own switches must never be read as
    // --game, and this process's arguments are not the CLI's.
    return findGame([]) || null;
  } catch {
    return null;
  }
}

// --- the setup window -------------------------------------------------------

function closeSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy();
  setupWindow = null;
}

// Resolves with a validated install directory, or null if the user gave up.
function askForGame(problem) {
  return new Promise((resolve) => {
    pickResolve = resolve;
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.webContents.send('setup:problem', problem ?? '');
      setupWindow.focus();
      return;
    }
    setupWindow = new BrowserWindow({
      width: 620,
      height: 400,
      resizable: false,
      backgroundColor: '#cfc0b4',
      title: 'Farever Bench',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    setupWindow.on('closed', () => {
      setupWindow = null;
      // Closing the window IS the answer "not now".
      const done = pickResolve;
      pickResolve = null;
      if (done) done(null);
    });
    setupWindow.loadFile(SETUP_PAGE, { query: { problem: problem ?? '' } })
      .catch((e) => {
        // No setup page (a build that forgot web/**): fall back to the native
        // picker so the app is still usable rather than merely honest.
        // Claim the resolver BEFORE destroying the window - 'closed' would
        // otherwise answer null and the fallback would never be seen.
        const done = pickResolve;
        pickResolve = null;
        closeSetup();
        if (done) done(nativePick(problem, e));
      });
  });
}

// The folder picker, used from the setup window's button and as the fallback
// when that window cannot be shown at all.
async function browseForGame() {
  const parent = setupWindow && !setupWindow.isDestroyed() ? setupWindow : null;
  const opts = {
    title: 'Select your Farever folder',
    properties: ['openDirectory'],
    defaultPath: savedGame() || app.getPath('home'),
  };
  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (canceled || !filePaths?.length) return { ok: false, why: '' };

  const dir = normalise(filePaths[0]);
  if (!isGameDir(dir)) {
    return {
      ok: false,
      why: `${dir}\n\nis not a Farever install - it has no hlboot.dat and `
        + 'Farever.exe in it. Pick the folder those two files are in.',
    };
  }
  const done = pickResolve;
  pickResolve = null;
  if (done) done(dir);
  return { ok: true, dir };
}

function nativePick(problem, why) {
  const detail = [problem, why ? String(why?.message ?? why) : '']
    .filter(Boolean).join('\n\n');
  const { response } = dialog.showMessageBoxSync({
    type: 'question',
    title: 'Farever Bench',
    message: 'Farever Bench needs your Farever install.',
    detail: detail || 'Pick the folder that has Farever.exe and hlboot.dat in it.',
    buttons: ['Choose folder…', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;
  const picked = dialog.showOpenDialogSync({
    title: 'Select your Farever folder',
    properties: ['openDirectory'],
    defaultPath: app.getPath('home'),
  });
  const dir = normalise(picked?.[0]);
  return isGameDir(dir) ? dir : nativePick(`${dir} is not a Farever install.`, null);
}

// --- the app ----------------------------------------------------------------

async function startBench(game) {
  const { startServer } = await importBench('ui/server.mjs');
  // FAREVER_BENCH_PORT pins the port (useful for scripted checks); default
  // is an ephemeral one so two instances never fight.
  const fixed = parseInt(process.env.FAREVER_BENCH_PORT || '', 10);
  return startServer({
    benchRoot: BENCH_ROOT, host: '127.0.0.1', game,
    port: Number.isFinite(fixed) ? fixed : 0,
  });
}

async function openSheet(port) {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#cfc0b4',
    title: 'Farever Bench',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // External links (questlog, map pins) go to the real browser, not our window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

async function boot() {
  persistCache();
  ipcMain.handle('setup:browse', () => browseForGame());
  ipcMain.on('setup:quit', () => app.quit());

  let game = FORCE_SETUP ? null : (savedGame() || envGame() || await autoDetect());
  let problem = (game || FORCE_SETUP) ? ''
    : 'No Farever install found - not in Steam\'s library list, and not in the '
      + 'usual places. Point Farever Bench at it once and it will remember.';

  for (;;) {
    if (!game) {
      game = await askForGame(problem);
      if (!game) { booting = false; app.quit(); return; }
    }
    try {
      process.env.FAREVER_DIR = game;      // before the server, for the worker
      const { port } = await startBench(game);
      rememberGame(game);
      closeSetup();
      await openSheet(port);
      booting = false;
      return;
    } catch (e) {
      const why = String(e?.message ?? e);
      // A folder that IS an install and still fails is a different problem -
      // a partial download, or nothing to do with the game at all (a taken
      // port). Say so, and let them decide whether the picker is the answer.
      if (isGameDir(game) && !setupWindow) {
        const { response } = await dialog.showMessageBox({
          type: 'error',
          title: 'Farever Bench',
          message: 'Farever Bench could not start.',
          detail: `${why}\n\nInstall it tried to read:\n${game}`,
          buttons: ['Choose another folder…', 'Quit'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response !== 0) { booting = false; app.quit(); return; }
      }
      problem = `That install could not be read:\n${why}`;
      game = null;
    }
  }
}

app.whenReady().then(boot).catch((e) => {
  dialog.showErrorBox('Farever Bench failed to start', String(e?.stack || e));
  app.quit();
});

app.on('window-all-closed', () => { if (!booting) app.quit(); });
