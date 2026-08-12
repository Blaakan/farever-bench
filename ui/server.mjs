// ---------------------------------------------------------------------------
// server.mjs - the one HTTP process behind the bench UI.
//
// Three route families and nothing else: /api/* is api.mjs, /asset/* and
// /icon/* are the icon service, and everything left is a static file out of
// ui/web. The Electron shell imports startServer and owns the port; run
// standalone with `node ui/server.mjs [--port N]` for a browser dev loop.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApi } from './api.mjs';

const BODY_CAP = 1024 * 1024; // 1MB is generous for a loadout

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_CAP) {
        reject(Object.assign(new Error('request body over 1MB'), { status: 400 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startServer({ benchRoot, host = '127.0.0.1', port = 0, game = null } = {}) {
  const api = await createApi({ benchRoot, game });
  const icons = api.icons;
  const webRoot = resolve(benchRoot, 'ui', 'web');

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    // Resolve and re-check the prefix: the resolved path must stay under
    // web/, or a ../ walks out of the tree.
    const path = resolve(webRoot, rel);
    if (path !== webRoot && !path.startsWith(webRoot + sep)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      const data = await readFile(path);
      res.writeHead(200, {
        'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `not found: ${pathname}` }));
    }
  }

  const server = http.createServer(async (req, res) => {
    let pathname, searchParams;
    try {
      ({ pathname, searchParams } = new URL(req.url, `http://${host}`));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad url' }));
      return;
    }
    try {
      let body;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body is not JSON' }));
          return;
        }
      }
      if (api.handle(req, res, pathname, searchParams, body)) return;
      if (await icons.handle(req, res, pathname, searchParams)) return;
      await serveStatic(res, pathname);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(e.status ?? 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      } else {
        res.end();
      }
    }
  });

  // SSE streams hold sockets open past close(); track them so close() means
  // closed rather than "closed once the last optimizer watcher goes away".
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });

  return {
    port: server.address().port,
    close: () => new Promise((resolvePromise) => {
      api.close();
      for (const s of sockets) s.destroy();
      server.close(() => resolvePromise());
    }),
  };
}

// --- standalone: node ui/server.mjs [--port N] ------------------------------

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
// The third way to run the UI, next to the packaged desktop app and a dev
// loop: a plain Node process that opens your own browser. It costs no Chromium
// download, needs no code signature to get past SmartScreen, and runs wherever
// Node does - which is the only way a Linux or macOS player gets the UI at all,
// since the packaged build is a Windows binary.
export function openBrowser(url) {
  // Per-platform because there is no portable "open this URL". Failure is not
  // fatal: the URL is already on stdout, and a headless or locked-down box
  // simply has nobody to hand it to.
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no browser to open, or no opener on this box - the URL is printed */
  }
}

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'farever-bench ui - the character sheet in your own browser',
      '',
      '  node ui/server.mjs [--open] [--port N] [--game <path>] [--host H]',
      '',
      '  --open          open the default browser once the server is up',
      '  --port N        fixed port (default: any free one)',
      '  --game <path>   your Farever install, if it is not auto-detected',
      '  --host H        bind address (default 127.0.0.1, this machine only)',
      '',
      'Everything is read from your own copy of the game and nothing is sent',
      'anywhere; the server listens on localhost only unless you say otherwise.',
    ].join('\n'));
    process.exit(0);
  }
  const port = parseInt(flag('--port') ?? '', 10);
  const benchRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  startServer({
    benchRoot,
    port: Number.isFinite(port) && port > 0 ? port : 0,
    host: flag('--host') ?? '127.0.0.1',
    game: flag('--game'),
  })
    .then(({ port: p }) => {
      const url = `http://127.0.0.1:${p}/`;
      console.log(`farever-bench ui on ${url}`);
      if (args.includes('--open')) openBrowser(url);
      else console.log('  (--open launches your browser for you)');
      console.log('  press Ctrl+C to stop');
    })
    .catch((e) => {
      // A "we cannot find your game" failure is a sentence for a player, not a
      // stack for a developer: cdb.mjs and game.mjs both write one, and a
      // stack printed on top of it buries the only line that helps. Anything
      // else IS a bug and keeps its trace.
      const msg = String(e?.message ?? e);
      const isMissingGame = /res\.light\.pak|res\.pak|hlboot|Farever install|Farever\.exe/i.test(msg);
      console.error(isMissingGame ? msg : String(e?.stack ?? e));
      console.error('\nIf the game is not where it is expected, name it:'
        + '\n  node ui/server.mjs --open --game "D:\\SteamLibrary\\steamapps\\common\\Farever"');
      process.exit(1);
    });
}
