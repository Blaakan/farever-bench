// ---------------------------------------------------------------------------
// icons.mjs - the icon/asset half of the UI server (see ui/API.md, sections
// /asset and /icon/dds).
//
// The game stores every icon reference as a CastleDB gfx cell
// `{file, size, x, y, width?, height?}` where the pixel rect is
// (x*size, y*size, (width??1)*size, (height??1)*size) - size varies PER ROW
// within one atlas file, so it is always multiplied out here, never assumed
// per file. Whether a file is a croppable PNG sheet or a BC7 DDS is decided by
// sniffing its magic bytes once (extensions lie: everything under
// UI/Portraits/ is DDS even when named .png, and since the September 30
// update so are the 96px skill atlases and the 28px stats strip under
// UI/icons/). Real PNGs become {kind:'tile'} refs the client crops with CSS;
// DDS become {kind:'dds'} URLs that this module decodes server-side,
// disk-cached under <benchRoot>/.cache/ui-icons/ with a small in-memory LRU
// on top:
//
//   * a gfx cell that IS the texture (a portrait) -> `?px=N`: parseDds ->
//     smallest mip >= px -> decodeBc7 -> encodePng;
//   * a gfx cell that is one tile of a DDS SHEET -> `?rect=x,y,w,h`: the 4x4
//     blocks under that pixel rect are sliced out of mip 0 and decoded alone,
//     so the client still gets one PNG per icon and never the whole sheet.
//
// The cache key carries a stamp of the file it was decoded from (size + mtime
// of res.pak, or of the loose atlas), so a patch that repaints an icon under
// the same pak path is a cache miss rather than a stale tile forever.
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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPak } from './lib/pak.mjs';
import { parseDds } from './lib/dds.mjs';
import { decodeBc7 } from './lib/bc7.mjs';
import { encodePng } from './lib/png.mjs';

const PNG_MAGIC = 0x89504e47;        // '\x89PNG'
const ATLAS_CELL = 64;               // px per atlas cell
const LRU_MAX = 512;                 // decoded PNGs held in memory
const IMMUTABLE = 'public, max-age=31536000, immutable';

// What a decoded PNG was decoded FROM, as far as a file name can say: the
// source file's size and mtime. A BC7 texture re-exported at the same
// dimensions keeps its byte size (and can keep its pak offset), so the entry
// alone cannot tell two builds apart - the archive's own stat can, and Steam
// rewrites it on every patch.
export function fileStamp(path) {
  try {
    const st = statSync(path);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch { return 'absent'; }
}

// The disk-cache file name of one decoded icon. Exported so the self-test can
// prove the stamp is IN the name rather than trust that it is.
export function cacheName(stamp, key) {
  return `${createHash('sha1').update(`${stamp}|${key}`).digest('hex')}.png`;
}

// `rect=x,y,w,h` off a query string: four plain decimal integers, extent at
// least one pixel. Null for anything else - the caller answers 404, because a
// malformed rect is bad input and not a bug.
export function parseRect(text) {
  const m = /^(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/.exec(String(text ?? ''));
  if (!m) return null;
  const r = m.slice(1).map(Number);
  return r[2] >= 1 && r[3] >= 1 ? r : null;
}

// Cut a pixel rect out of one BC7 level WITHOUT decoding the rest of it: the
// 4x4 blocks the rect touches are copied out row by row (block row r starts at
// ((by0+r) * blocksPerRow + bx0) * 16, 16 bytes per block) and decoded alone.
// Every sheet cell the game authors is block-aligned (96px, 48px x2, 28px,
// and the loose atlas's 64px), so that IS the cell. A rect that is not - the
// unit portraits author 250px on a 256px texture - is rounded OUTWARD to whole
// blocks and the decoded pixels cropped back, so either way the answer is the
// pixels a full decode would give. The caller has checked the rect is inside
// the level.
export function sliceRectRgba(data, texWidth, [x, y, w, h]) {
  const bpr = (texWidth + 3) >> 2;
  const bx0 = x >> 2, by0 = y >> 2;
  const bw = ((x + w + 3) >> 2) - bx0, bh = ((y + h + 3) >> 2) - by0;
  const cell = Buffer.alloc(bw * bh * 16);
  for (let r = 0; r < bh; r++) {
    const src = ((by0 + r) * bpr + bx0) * 16;
    data.copy(cell, r * bw * 16, src, src + bw * 16);
  }
  const rgba = decodeBc7(cell, bw * 4, bh * 4);
  const ox = x - bx0 * 4, oy = y - by0 * 4;
  if (!ox && !oy && bw * 4 === w && bh * 4 === h) return rgba;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((oy + row) * bw * 4 + ox) * 4;
    out.set(rgba.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

export async function createIconService({ benchRoot, game }) {
  const pakPath = join(game, 'res.pak');
  const pak = openPak(pakPath);
  const pakStamp = fileStamp(pakPath);
  // A packaged build has no writable bench root - the portable exe unpacks to
  // a temp directory and an AppImage mounts read-only squashfs - so the shell
  // exports FAREVER_BENCH_CACHE and this follows it. Without that the mkdir
  // below throws EROFS and EVERY portrait 500s, not just the first, because
  // cacheDirMade never flips.
  const cacheDir = process.env.FAREVER_BENCH_CACHE
    ? join(process.env.FAREVER_BENCH_CACHE, 'ui-icons')
    : join(benchRoot, '.cache', 'ui-icons');
  let cacheDirMade = false;

  // --- magic sniffing, once per pak path ------------------------------------

  // path -> {kind:'png', sheet:[w,h]} | {kind:'dds', size:[w,h]} | {kind:null}
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
      else if (buf.length >= 20 && buf.toString('ascii', 0, 4) === 'DDS ')
        // DDS_HEADER keeps height at byte 12 and width at 16, little-endian;
        // no parse. iconRef needs them to tell a portrait from a sheet.
        s = { kind: 'dds', size: [buf.readUInt32LE(16), buf.readUInt32LE(12)] };
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
    // The cell's pixel rect - one arithmetic for both containers, because the
    // game addresses a DDS sheet exactly as it addresses a PNG one.
    const size = gfx.size ?? 1;
    const px = [(gfx.x ?? 0) * size, (gfx.y ?? 0) * size,
                (gfx.width ?? 1) * size, (gfx.height ?? 1) * size];
    if (s.kind === 'png') {
      return { kind: 'tile', file: gfx.file, px, sheet: s.sheet };
    }
    if (s.kind === 'dds') {
      const b64 = Buffer.from(gfx.file, 'utf8').toString('base64url');
      // A cell that covers the texture is a portrait and keeps the mip picker.
      // Anything smaller is ONE TILE OF A SHEET and the URL has to say which:
      // without the rect the client is handed the whole 960x960 atlas as every
      // icon on it, which is what each weapon skill, class skill, status and
      // attribute showed once the game shipped those sheets as BC7.
      const whole = px[0] === 0 && px[1] === 0
        && px[2] >= s.size[0] && px[3] >= s.size[1];
      return {
        kind: 'dds',
        url: whole ? `/icon/dds/${b64}.png?px=64`
          : `/icon/dds/${b64}.png?rect=${px.join(',')}`,
      };
    }
    return null;   // missing from the pak, or neither PNG nor DDS
  }

  // --- the loose atlas (modkit output; optional) ----------------------------

  const atlasPath = join(game, 'farever-atlas-icons.dds');
  let atlas;   // undefined = not tried, null = absent, else {data, cols, rows}

  function loadAtlas() {
    if (atlas !== undefined) return atlas;
    if (!existsSync(atlasPath)) return (atlas = null);
    const dds = parseDds(readFileSync(atlasPath));
    atlas = {
      data: dds.mips[0].data,
      cols: dds.width / ATLAS_CELL,
      rows: dds.height / ATLAS_CELL,
    };
    return atlas;
  }

  // Cell N of the single-mip sheet is the 64px rect at column N%cols, row
  // floor(N/cols) - sliced and decoded alone, like any other sheet cell.
  function atlasCellPng(n) {
    const a = loadAtlas();
    if (!a || !Number.isInteger(n) || n < 0 || n >= a.cols * a.rows) return null;
    const cx = n % a.cols, cy = Math.floor(n / a.cols);
    return encodePng(
      sliceRectRgba(a.data, a.cols * ATLAS_CELL,
                    [cx * ATLAS_CELL, cy * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL]),
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

  // '<path>#<px>' or '<path>#rect=x,y,w,h' -> PNG Buffer, insertion = recency.
  // No stamp here: this map dies with the process, and the process holds the
  // pak open for as long as it lives.
  const lru = new Map();

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

  // The DISK name does carry one, and it is the stamp of whichever file the
  // key was decoded from: the modkit regenerates the loose atlas on its own
  // schedule, not the game's.
  let atlasStamp = null;
  const stampFor = (key) => (key.startsWith('atlas:')
    ? (atlasStamp ??= fileStamp(atlasPath)) : pakStamp);
  const diskPath = (key) => join(cacheDir, cacheName(stampFor(key), key));

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

  // GET /icon/dds/<b64url(pakPath)>.png?px=N | ?rect=x,y,w,h - also the
  // 'atlas:<cell>' form.
  function serveDds(res, pathname, searchParams) {
    const tail = pathname.slice('/icon/dds/'.length);
    if (!tail.endsWith('.png') || tail.length <= 4)
      return fail(res, 404, 'expected /icon/dds/<b64url>.png');
    const path = Buffer.from(tail.slice(0, -4), 'base64url').toString('utf8');
    if (!path) return fail(res, 404, 'empty pak path');

    let px = Number(searchParams?.get('px') ?? 64);
    px = Number.isFinite(px) && px >= 1 && px <= 4096 ? Math.floor(px) : 64;
    // A rect is client input and is checked in two halves: its SHAPE here,
    // before anything is read or cached under it, and its BOUNDS against the
    // texture below. Both are a 404 with a sentence - a bad rect must never
    // reach the block slicer and come back as a 500.
    const rectText = searchParams?.get('rect') ?? null;
    const rect = rectText == null ? null : parseRect(rectText);
    if (rectText != null && !rect)
      return fail(res, 404, 'rect must be x,y,w,h in whole pixels with w and h'
                            + ` at least 1, not "${rectText}"`);
    if (rect && path.startsWith('atlas:'))
      return fail(res, 404, 'an atlas cell is already one tile; rect does not apply');
    const key = `${path}#${rect ? `rect=${rect.join(',')}` : px}`;

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
        if (rect) {
          // One tile of a sheet at the size the game authors it: cut from
          // mip 0, which is the level the row's pixel rect is written in.
          // `px` does not apply.
          const [x, y, w, h] = rect;
          if (x + w > dds.width || y + h > dds.height)
            return fail(res, 404, `rect ${rect.join(',')} is outside ${path},`
                                  + ` which is ${dds.width}x${dds.height}`);
          png = encodePng(sliceRectRgba(dds.mips[0].data, dds.width, rect), w, h);
        } else {
          // Smallest mip that still covers the requested size; px larger than
          // the texture falls back to mip 0.
          let mip = dds.mips[0];
          for (let i = dds.mips.length - 1; i >= 0; i--)
            if (dds.mips[i].width >= px) { mip = dds.mips[i]; break; }
          png = encodePng(decodeBc7(mip.data, mip.width, mip.height),
                          mip.width, mip.height);
        }
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
