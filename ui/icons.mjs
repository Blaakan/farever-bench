// ---------------------------------------------------------------------------
// icons.mjs - the icon/asset half of the UI server (see ui/API.md, sections
// /asset and /icon/dds).
//
// The game stores every icon reference as a CastleDB gfx cell
// `{file, size, x, y, width?, height?}` where the pixel rect is
// (x*size, y*size, (width??1)*size, (height??1)*size) - size varies PER ROW
// within one atlas file, so it is always multiplied out here, never assumed
// per file. Whether a file is a croppable PNG sheet or a BC7 DDS portrait is
// decided by sniffing its magic bytes once (extensions lie: everything under
// UI/Portraits/ is DDS even when named .png). Real PNGs become
// {kind:'tile'} refs the client crops with CSS; DDS become {kind:'dds'} URLs
// that this module decodes server-side (parseDds -> smallest mip >= px ->
// decodeBc7 -> encodePng), disk-cached under <benchRoot>/.cache/ui-icons/
// with a small in-memory LRU on top.
//
// /icon/dds also accepts the path `atlas:<cell>` for the loose
// farever-atlas-icons.dds next to Farever.exe (single-mip BC7, 148-byte
// header, 32 columns of 64px cells): cell N is the 16x16 block rectangle at
// (N%32, N>>5), sliced and decoded without touching the rest of the sheet.
// atlasFor(id) reads the sibling farever-atlas.tsv (columns: category id
// name rarity icon desc acquire track tags) for acquire prose and map pins;
// both files are modkit output and optional - when absent, atlasFor returns
// null and atlas: cells 404, nothing crashes.
//
// handle() never throws: bad input is a 404 {error}, a genuine bug is a 500
// {error}. Zero dependencies, Node 18+.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPak } from './lib/pak.mjs';
import { parseDds } from './lib/dds.mjs';
import { decodeBc7 } from './lib/bc7.mjs';
import { encodePng } from './lib/png.mjs';

const PNG_MAGIC = 0x89504e47;        // '\x89PNG'
const ATLAS_CELL = 64;               // px per atlas cell
const ATLAS_BLOCKS = ATLAS_CELL / 4; // BC7 blocks per cell edge (16)
const LRU_MAX = 512;                 // decoded PNGs held in memory
const IMMUTABLE = 'public, max-age=31536000, immutable';

export async function createIconService({ benchRoot, game }) {
  const pak = openPak(join(game, 'res.pak'));
  const cacheDir = join(benchRoot, '.cache', 'ui-icons');
  let cacheDirMade = false;

  // --- magic sniffing, once per pak path ------------------------------------

  // path -> {kind:'png', sheet:[w,h]} | {kind:'dds'} | {kind:null}
  const sniffed = new Map();

  function sniff(path) {
    let s = sniffed.get(path);
    if (s) return s;
    const entry = pak.find(path);
    if (!entry) {
      s = { kind: null };
    } else {
      const buf = pak.read(entry);
      if (buf.length >= 24 && buf.readUInt32BE(0) === PNG_MAGIC)
        // IHDR width/height live at bytes 16-23 big-endian; no full decode.
        s = { kind: 'png', sheet: [buf.readUInt32BE(16), buf.readUInt32BE(20)] };
      else if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'DDS ')
        s = { kind: 'dds' };
      else
        s = { kind: null };
    }
    sniffed.set(path, s);
    return s;
  }

  // --- gfx row -> API icon ref ----------------------------------------------

  function iconRef(gfx) {
    if (!gfx || !gfx.file) return null;
    const s = sniff(gfx.file);
    if (s.kind === 'png') {
      const size = gfx.size ?? 1;
      return {
        kind: 'tile',
        file: gfx.file,
        px: [(gfx.x ?? 0) * size, (gfx.y ?? 0) * size,
             (gfx.width ?? 1) * size, (gfx.height ?? 1) * size],
        sheet: s.sheet,
      };
    }
    if (s.kind === 'dds') {
      const b64 = Buffer.from(gfx.file, 'utf8').toString('base64url');
      return { kind: 'dds', url: `/icon/dds/${b64}.png?px=64` };
    }
    return null;   // missing from the pak, or neither PNG nor DDS
  }

  // --- the loose atlas (modkit output; optional) ----------------------------

  let atlas;   // undefined = not tried, null = absent, else {data, cols, rows}

  function loadAtlas() {
    if (atlas !== undefined) return atlas;
    const path = join(game, 'farever-atlas-icons.dds');
    if (!existsSync(path)) return (atlas = null);
    const dds = parseDds(readFileSync(path));
    atlas = {
      data: dds.mips[0].data,
      cols: dds.width / ATLAS_CELL,
      rows: dds.height / ATLAS_CELL,
    };
    return atlas;
  }

  // Slice cell N's 16x16 BC7 blocks out of the single-mip sheet and decode
  // just that 64x64 cell. Block row r of cell (cx,cy) starts at block
  // (cy*16+r)*blocksPerAtlasRow + cx*16, 16 bytes per block.
  function atlasCellPng(n) {
    const a = loadAtlas();
    if (!a || !Number.isInteger(n) || n < 0 || n >= a.cols * a.rows) return null;
    const bpr = a.cols * ATLAS_BLOCKS;
    const cx = n % a.cols, cy = Math.floor(n / a.cols);
    const cell = Buffer.alloc(ATLAS_BLOCKS * ATLAS_BLOCKS * 16);
    for (let r = 0; r < ATLAS_BLOCKS; r++) {
      const src = ((cy * ATLAS_BLOCKS + r) * bpr + cx * ATLAS_BLOCKS) * 16;
      a.data.copy(cell, r * ATLAS_BLOCKS * 16, src, src + ATLAS_BLOCKS * 16);
    }
    return encodePng(decodeBc7(cell, ATLAS_CELL, ATLAS_CELL),
                     ATLAS_CELL, ATLAS_CELL);
  }

  // --- the loose TSV (modkit output; optional) ------------------------------

  let tsvById;   // undefined = not tried, null = absent, else Map id -> row

  function loadTsv() {
    if (tsvById !== undefined) return tsvById;
    const path = join(game, 'farever-atlas.tsv');
    if (!existsSync(path)) return (tsvById = null);
    tsvById = new Map();
    // Columns: category id name rarity icon desc acquire track tags; the
    // header line starts with '#'. First row wins on a duplicate id.
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length < 8 || tsvById.has(f[1])) continue;
      const cell = Number(f[4]);
      const track = [];
      for (const seg of (f[7] ?? '').split(';')) {
        // 'label@x,y,z[,onceId]'; onceId 'q:*' marks quest pins - never
        // navigable, dropped here.
        const at = seg.lastIndexOf('@');
        if (at < 0) continue;
        const parts = seg.slice(at + 1).split(',');
        if (parts[3]?.startsWith('q:')) continue;
        const [x, y, z] = parts.map(Number);
        if (![x, y, z].every(Number.isFinite)) continue;
        track.push({ label: seg.slice(0, at), x, y, z });
      }
      tsvById.set(f[1], {
        acquire: f[6] ?? '',
        track,
        desc: f[5] ?? '',
        cell: Number.isInteger(cell) && cell >= 0 ? cell : null,
      });
    }
    return tsvById;
  }

  function atlasFor(id) {
    const map = loadTsv();
    return map ? map.get(id) ?? null : null;
  }

  // --- decoded-PNG caches ---------------------------------------------------

  const lru = new Map();   // '<path>#<px>' -> PNG Buffer, insertion = recency

  function lruGet(key) {
    const hit = lru.get(key);
    if (hit) { lru.delete(key); lru.set(key, hit); }
    return hit ?? null;
  }

  function lruPut(key, png) {
    lru.delete(key);
    lru.set(key, png);
    if (lru.size > LRU_MAX) lru.delete(lru.keys().next().value);
  }

  const diskPath = (key) =>
    join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.png`);

  // --- HTTP -----------------------------------------------------------------

  function fail(res, status, error) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  }

  function servePng(res, png) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': IMMUTABLE,
    });
    res.end(png);
  }

  // GET /asset/<path>: raw bytes from res.pak, real PNGs only. The whitelist
  // keeps this to art (UI/, Font/) - and the magic check keeps the
  // DDS-disguised-as-.png portraits out; those go through /icon/dds.
  function serveAsset(res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname.slice('/asset/'.length)); }
    catch { return fail(res, 404, 'undecodable asset path'); }
    if (!(rel.startsWith('UI/') || rel.startsWith('Font/')) || rel.includes('..'))
      return fail(res, 404, `no such asset: ${rel}`);
    const entry = pak.find(rel);
    if (!entry) return fail(res, 404, `no such asset: ${rel}`);
    const buf = pak.read(entry);
    if (buf.length < 8 || buf.readUInt32BE(0) !== PNG_MAGIC)
      return fail(res, 404, `${rel} is not a PNG (DDS goes through /icon/dds)`);
    servePng(res, buf);
  }

  // GET /icon/dds/<b64url(pakPath)>.png?px=N - also the 'atlas:<cell>' form.
  function serveDds(res, pathname, searchParams) {
    const tail = pathname.slice('/icon/dds/'.length);
    if (!tail.endsWith('.png') || tail.length <= 4)
      return fail(res, 404, 'expected /icon/dds/<b64url>.png');
    const path = Buffer.from(tail.slice(0, -4), 'base64url').toString('utf8');
    if (!path) return fail(res, 404, 'empty pak path');

    let px = Number(searchParams?.get('px') ?? 64);
    px = Number.isFinite(px) && px >= 1 && px <= 4096 ? Math.floor(px) : 64;
    const key = `${path}#${px}`;

    let png = lruGet(key);
    if (!png && existsSync(diskPath(key))) png = readFileSync(diskPath(key));
    if (!png) {
      if (path.startsWith('atlas:')) {
        png = atlasCellPng(Number(path.slice('atlas:'.length)));
        if (!png)
          return fail(res, 404, `no atlas cell ${path.slice('atlas:'.length)}` +
                                ' (is farever-atlas-icons.dds installed?)');
      } else {
        const entry = pak.find(path);
        if (!entry) return fail(res, 404, `no ${path} in res.pak`);
        const buf = pak.read(entry);
        if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'DDS ')
          return fail(res, 404, `${path} is not a DDS`);
        const dds = parseDds(buf);
        // Smallest mip that still covers the requested size; px larger than
        // the texture falls back to mip 0.
        let mip = dds.mips[0];
        for (let i = dds.mips.length - 1; i >= 0; i--)
          if (dds.mips[i].width >= px) { mip = dds.mips[i]; break; }
        png = encodePng(decodeBc7(mip.data, mip.width, mip.height),
                        mip.width, mip.height);
      }
      if (!cacheDirMade) { mkdirSync(cacheDir, { recursive: true }); cacheDirMade = true; }
      writeFileSync(diskPath(key), png);
    }
    lruPut(key, png);
    servePng(res, png);
  }

  function handle(req, res, pathname, searchParams) {
    const mine = pathname.startsWith('/asset/') || pathname.startsWith('/icon/dds/');
    if (!mine) return false;
    try {
      if (req.method && req.method !== 'GET' && req.method !== 'HEAD')
        fail(res, 405, `${req.method} not allowed here`);
      else if (pathname.startsWith('/asset/'))
        serveAsset(res, pathname);
      else
        serveDds(res, pathname, searchParams);
    } catch (e) {
      // A bug, not bad input - but the server must keep serving.
      try { fail(res, 500, e?.message ?? String(e)); } catch { /* res is gone */ }
    }
    return true;
  }

  return {
    iconRef,
    atlasFor,
    handle,
    close: () => pak.close(),
  };
}
