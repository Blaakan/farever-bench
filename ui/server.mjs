// ---------------------------------------------------------------------------
// server.mjs - the one HTTP process behind the bench UI.
//
// Three route families and nothing else: /api/* is api.mjs, /asset/* and
// /icon/* are the icon service, and everything left is a static file out of
// ui/web. The Electron shell imports startServer and owns the port; run
// standalone with `node ui/server.mjs [--port N]` for a browser dev loop.
//
// WHO MAY CALL /api/. The server listens on loopback, and that alone does not
// keep other pages out: any web page the user has open can aim a request at
// http://127.0.0.1:<port>, and a page on a name that resolves to 127.0.0.1
// (DNS rebinding) is even same-origin with it as far as the browser knows. A
// route that imports a file, sends a fight to the project's pCloud folder or
// asks for one's deletion, or lists the receipts that ask for it must not
// answer such a page. So before any route runs (`guard`):
//
//   Host     every /api/ request must be addressed to THIS server by one of
//            its own names - 127.0.0.1, localhost, [::1] at its port, plus
//            the --host value when that is another loopback address. A
//            rebinding page sends its own name, and is refused here. This is
//            checked on GETs too: /api/bootstrap names the install folder,
//            which on Windows carries the user's account name.
//   method   each route answers one method; anything else is a 405, an
//            OPTIONS preflight included, so a cross-site JSON request never
//            gets the CORS answer it would need to be sent.
//   Origin   on a POST, when the browser sends one, it must be this server's
//            own origin, http://<the Host it was addressed to>.
//   type     a POST body must be application/json. A plain HTML form or a
//            "simple" fetch can only send text/plain or a form encoding
//            without a preflight; refusing those is what makes the preflight
//            above unavoidable.
//   size     40 MB for the two routes that take a file (/api/import and
//            /api/submit/preview), 1 MB for every other (bodyCapFor). A body
//            over its cap is READ TO THE END AND THROWN AWAY, then answered
//            413 with a sentence: closing the socket mid-upload left the
//            client a connection reset instead of the reason (the old
//            readBody did that, with a 400).
//
// SEND A FIGHT IS LOOPBACK ONLY. On a bind beyond loopback (`--host
// 0.0.0.0`, a LAN address) the Host check above cannot be made, and a
// request with no Origin - curl from any machine on the network - passes
// the Origin check. For the rest of /api/ that exposes the install and
// the CPU; for /api/submit/ it would lend the player's machine to the
// network: sending fights to the project's pCloud folder from their
// address, listing the kept receipts with their delete tokens, and asking
// for those fights' deletion. So on such a bind every /api/submit/ route is
// refused (403, `submitOffFor`), before its body is read, and bootstrap
// carries the same sentence for the dialog. On loopback the guard keeps
// out other pages, not other programs: anything running on this machine
// can call the server as curl does (no Origin) - /receipts and its delete
// tokens included, whatever the receipt files' modes (api.mjs) - which is
// one more reason the bind stays on loopback.
//
// The refusals are sentences like every other error here, so the page and a
// person with curl both learn what was wrong.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApi } from './api.mjs';

const MB = 1024 * 1024;
// 1 MB is generous for a loadout or a tooltip question; a file - a character
// sheet the user picked, or the logs of a fight to send - comes base64'd or
// as text inside JSON, so the routes that take one take 40 MB.
const BODY_CAP = 1 * MB;
const FILE_BODY_CAP = 40 * MB;
// The routes that take a file. Every other submit route takes an id, a flag
// or a receipt, and buffering 40 MB of JSON for one is 40 MB for nothing.
const FILE_ROUTES = new Set(['/api/import', '/api/submit/preview']);

/** The body cap of a route: 40 MB for one that takes a file, else 1 MB. */
export function bodyCapFor(pathname) {
  return FILE_ROUTES.has(pathname) ? FILE_BODY_CAP : BODY_CAP;
}

const mbText = (bytes) => `${Math.round((bytes / MB) * 10) / 10} MB`;

// The 413 sentence. Sizes are rounded to a tenth of a MB, so a body a few
// bytes over the cap would read "40 MB, and ... takes at most 40 MB" - a
// refusal that contradicts itself. Where the two round alike it says "more
// than" instead.
export const overCapSentence = (size, cap, pathname) => {
  const said = mbText(size) === mbText(cap) ? `more than ${mbText(cap)}` : mbText(size);
  return `the request body is ${said}, and ${pathname} takes at most ${mbText(cap)} - none of it was read`;
};

// A bind address that only this machine can reach. Anything else - 0.0.0.0,
// ::, a LAN address, a host name - is reached by names the server cannot
// list, so the Host rule cannot be applied there (see `guard`).
const isLoopback = (h) => {
  const x = String(h ?? '').toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return x === 'localhost' || x === '::1' || /^127(\.\d{1,3}){3}$/.test(x) || /^::ffff:127(\.\d{1,3}){3}$/.test(x);
};
// How a bind address reads in a Host header: an IPv6 literal in brackets.
const asHostName = (h) => {
  const x = String(h).toLowerCase();
  return x.includes(':') && !x.startsWith('[') ? `[${x}]` : x;
};

/**
 * Why "Send a fight" is off on a server bound to `host`, or null on a
 * loopback bind (see the header): the sentence every /api/submit/ route is
 * refused with there, and that bootstrap hands the page.
 */
export function submitOffFor(host) {
  if (isLoopback(host)) return null;
  return `Send a fight is off on this server: it listens on ${host}, beyond this machine, where anything on the network could `
    + 'send fights to the project\'s folder from your address, read the receipts this bench keeps and ask for those fights\' deletion. '
    + 'Run it on 127.0.0.1 (the default) to send, or use bench submit';
}

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

// Reads the whole body. One over `cap` is still read to its end - kept
// nothing of, just drained - and comes back as {raw: null, size}, so the
// caller can answer 413 on a connection the client is still listening on. A
// Content-Length that already says "over" skips the buffering from the first
// byte.
function readBody(req, cap) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const declared = Number(req.headers['content-length']);
    let chunks = Number.isFinite(declared) && declared > cap ? null : [];
    req.on('data', (c) => {
      size += c.length;
      if (chunks && size > cap) chunks = null;
      if (chunks) chunks.push(c);
    });
    req.on('end', () => resolvePromise({ raw: chunks ? Buffer.concat(chunks) : null, size }));
    req.on('error', reject);
  });
}

/**
 * The server, bound to `host` (127.0.0.1 by default): every rule above is
 * that bind's. `listen` is where it actually listens - `host` itself, unless
 * it is given a loopback address, and nothing wider: ui/lib/check-api.mjs
 * starts one configured as bound beyond this machine (`host: '0.0.0.0'`)
 * that listens on 127.0.0.1, to hold every /api/submit/ route to its 403
 * without a port open to the network.
 */
export async function startServer({ benchRoot, host = '127.0.0.1', port = 0, game = null, listen = host } = {}) {
  if (listen !== host && !isLoopback(listen)) {
    throw new Error(`startServer: listen is ${listen} - a server listens on its own host, or on loopback alone, never wider`);
  }
  const submitOff = submitOffFor(host);
  const api = await createApi({ benchRoot, game, submitOff });
  const icons = api.icons;
  const webRoot = resolve(benchRoot, 'ui', 'web');

  // Filled in once the port is known (port 0 picks one at listen time).
  let allowedHosts = null;
  // A bind beyond loopback (`--host 0.0.0.0`, a LAN address) is reached by
  // whatever names point at this machine, which the server cannot enumerate,
  // so there the Host is NOT checked and the Origin is compared with the
  // request's own Host instead. That still stops an ordinary cross-site page
  // (its Origin is its own site), but a DNS-rebinding page sends its own name
  // as both Host and Origin and passes: binding beyond loopback gives that
  // guard up, which is one more reason `bench ui` warns about such a bind -
  // and why every /api/submit/ route is refused there (`submitOff`).
  const openBind = !isLoopback(host);

  const send = (res, status, error, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ error }));
  };

  // The checks every /api/ request passes before a route sees it (see the
  // header). Returns true when it has answered the request itself.
  function guard(req, res, pathname, method) {
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    if (!openBind && !allowedHosts.has(hostHeader)) {
      send(res, 403, `this server answers requests addressed to ${[...allowedHosts].join(', ')} - `
        + `not to ${hostHeader ? `"${hostHeader}"` : 'no host at all'}, which is how a page on another name reaches it`);
      return true;
    }
    // Before the method and the body: nothing of a submit route runs here.
    if (submitOff && pathname.startsWith('/api/submit/')) {
      send(res, 403, submitOff);
      return true;
    }
    if (!method) return false;              // no such route: api.handle says 404
    if (req.method !== method) {
      send(res, 405, `${pathname} takes ${method}, not ${req.method}`, { allow: method });
      return true;
    }
    if (method !== 'POST') return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== `http://${hostHeader}`) {
      send(res, 403, `a page from ${origin} may not call this server - only its own page, http://${hostHeader}, may`);
      return true;
    }
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      send(res, 415, `${pathname} takes a JSON body (content-type: application/json), `
        + `not ${type ? `"${type}"` : 'a body with no content type'}`);
      return true;
    }
    return false;
  }

  async function serveStatic(res, pathname) {
    // A malformed %-escape is the request's fault, not a bug: a 400 with a
    // sentence, where it used to fall through to the 500 "URI malformed".
    let rel = 'index.html';
    if (pathname !== '/') {
      try {
        rel = decodeURIComponent(pathname.slice(1));
      } catch {
        send(res, 400, `bad url: ${pathname} has a %-escape that is not one`);
        return;
      }
    }
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
      // A fixed base, not the bind address: only the path and query are read,
      // and `http://${host}` is not a URL at all for an IPv6 bind (`::`).
      ({ pathname, searchParams } = new URL(req.url, 'http://localhost'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad url' }));
      return;
    }
    try {
      let body;
      if (pathname.startsWith('/api/')) {
        const method = api.routeMethod(pathname);
        if (guard(req, res, pathname, method)) return;
        if (method === 'POST') {
          const cap = bodyCapFor(pathname);
          const { raw, size } = await readBody(req, cap);
          if (!raw) {
            send(res, 413, overCapSentence(size, cap, pathname));
            return;
          }
          try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            send(res, 400, 'body is not JSON');
            return;
          }
        }
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Icons and static files are only ever read. A POST here used to be
        // buffered and then answered with the file as if it were a GET.
        send(res, 405, `${pathname} is a file and takes GET, not ${req.method}`, { allow: 'GET, HEAD' });
        return;
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
    server.listen(port, listen, resolvePromise);
  });

  const bound = server.address().port;
  allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...(isLoopback(host) ? [asHostName(host)] : [])]
    .map((h) => `${h}:${bound}`));

  return {
    port: bound,
    // The "not the accepted build" sentence, or null - for whoever prints the
    // startup banner (this file's own main, and `bench ui`).
    notice: api.notice ?? null,
    // Why "Send a fight" is off on this bind, or null on loopback - for the
    // same banner, which should say what such a bind gives up.
    submitOff,
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
      'Everything is read from your own copy of the game, and nothing is sent',
      'anywhere but on two clicks you make in the "Send a fight" dialog:',
      'Send uploads the fight it previewed to the project\'s pCloud folder,',
      'and Delete uploads a request to delete one you sent to the same folder.',
      'The server listens on localhost only unless you say otherwise - and on',
      'any other --host, "Send a fight" is off.',
    ].join('\n'));
    process.exit(0);
  }
  const port = parseInt(flag('--port') ?? '', 10);
  const benchRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const host = flag('--host') ?? '127.0.0.1';
  startServer({
    benchRoot,
    port: Number.isFinite(port) && port > 0 ? port : 0,
    host,
    game: flag('--game'),
  })
    .then(({ port: p, notice, submitOff }) => {
      const url = `http://127.0.0.1:${p}/`;
      console.log(`farever-bench ui on ${url}`);
      if (notice) console.log(`  warning: ${notice}`);
      if (submitOff) console.log(`  warning: bound to ${host}, so anything that can reach this machine can use this UI. ${submitOff}.`);
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
