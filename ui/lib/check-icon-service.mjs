#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-icon-service.mjs - self-test for ui/icons.mjs against the real game.
//
// Boots the service the way ui/server.mjs will, then walks the whole exported
// surface: gfx-row sniffing (tile vs DDS, per-row size multiplication,
// width/height 2 rects, a DDS SHEET cell vs a DDS portrait), the /asset
// whitelist + PNG-magic gate, the /icon/dds mip picker (px=64 must come off
// the 64px mip, px=256 off mip 0), the rect slicer (one sheet cell, pixel for
// pixel what a full decode cropped would give, and a 404 for every bad rect),
// the atlas:<cell> form, the build stamp in the disk-cache name, plus the
// farever-atlas.tsv lookups (acquire prose, map pins, runes). Decoded PNGs
// land in the temp directory for eyeballs.
//
// The disk cache this run decodes into is ITS OWN - a fresh directory under
// the temp dir, named through FAREVER_BENCH_CACHE exactly as the packaged
// shell names one - so the decode path really runs and nobody's real cache
// (<bench>/.cache/ui-icons) is wiped to make it run.
//
// Runs standalone:  node ui/lib/check-icon-service.mjs [<game dir> | --game <dir>]
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
         writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIconService, cacheName, fileStamp, parseRect,
         sliceRectRgba } from '../icons.mjs';
import { openPak } from './pak.mjs';
import { parseDds } from './dds.mjs';
import { decodeBc7 } from './bc7.mjs';
import { encodePng } from './png.mjs';
import { loadCdb } from '../../src/cdb.mjs';
import { buildContext } from '../../src/model.mjs';
import { buildCatalog } from '../../src/catalog.mjs';

const BENCH = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT = join(tmpdir(), 'farever-bench-checks', 'icon-service-check');
const CACHE_ROOT = join(OUT, 'cache');
const CACHE = join(CACHE_ROOT, 'ui-icons');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPng = (buf) => buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47;
const pngDims = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

mkdirSync(OUT, { recursive: true });
rmSync(CACHE_ROOT, { recursive: true, force: true });   // exercise the decode path
process.env.FAREVER_BENCH_CACHE = CACHE_ROOT;

// The install to read: named on the command line (a bare path, or --game
// <path>), else the one the engine finds the same way every other tool here
// does.
const cdb = loadCdb({
  game: process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null,
});
const GAME = cdb.meta.game;
const cat = buildCatalog(cdb, buildContext(cdb));
const svc = await createIconService({ benchRoot: BENCH, game: GAME });
const pak = openPak(join(GAME, 'res.pak'));

// A tiny fake req/res pair that captures what handle() writes.
function call(url) {
  const u = new URL(url, 'http://bench');
  let status = 0, headers = {};
  const chunks = [];
  const res = {
    writeHead: (s, h) => { status = s; headers = h ?? {}; },
    end: (b) => { if (b) chunks.push(Buffer.from(b)); },
  };
  const handled = svc.handle({ url, method: 'GET' }, res, u.pathname,
                             u.searchParams);
  return { handled, status, headers, body: Buffer.concat(chunks) };
}

// What a pak file is, read the way the service reads it but independently of
// it: {kind:'png'|'dds'|null, w, h}.
const fileKinds = new Map();
function fileKind(file) {
  let k = fileKinds.get(file);
  if (k) return k;
  const e = pak.find(file);
  k = { kind: null };
  if (e) {
    const buf = pak.read(e);
    if (isPng(buf)) k = { kind: 'png', w: pngDims(buf)[0], h: pngDims(buf)[1] };
    else if (buf.toString('ascii', 0, 4) === 'DDS ')
      k = { kind: 'dds', w: buf.readUInt32LE(16), h: buf.readUInt32LE(12) };
  }
  fileKinds.set(file, k);
  return k;
}
const cellOf = (g) => {
  const size = g.size ?? 1;
  return [(g.x ?? 0) * size, (g.y ?? 0) * size,
          (g.width ?? 1) * size, (g.height ?? 1) * size];
};
const b64 = (path) => Buffer.from(path, 'utf8').toString('base64url');

// --- iconRef ----------------------------------------------------------------

check('iconRef(null) is null', svc.iconRef(null) === null);
check('iconRef({}) is null', svc.iconRef({}) === null);

// A class skill's tile. Its sheet was a PNG until the September 30 update and
// is a BC7 DDS since, so which KIND comes back is the install's business; what
// this asserts is the thing either kind has to deliver - the row's own 96px
// cell, and never the 960px sheet it sits on.
const rayGfx = cdb.row('skill', 'Mage_RayOfSpark').gfx;
const ray = svc.iconRef(rayGfx);
const rayCell = cellOf(rayGfx);
if (fileKind(rayGfx.file).kind === 'png') {
  check('skill gfx on a PNG sheet -> tile', ray?.kind === 'tile', JSON.stringify(ray));
  check('  px rect is the row\'s cell', same(ray?.px, rayCell), JSON.stringify(ray?.px));
  check('  sheet is the file\'s size',
        same(ray?.sheet, [fileKind(rayGfx.file).w, fileKind(rayGfx.file).h]),
        JSON.stringify(ray?.sheet));
} else {
  check('skill gfx on a DDS sheet -> dds', ray?.kind === 'dds', JSON.stringify(ray));
  check('  the url names the row\'s cell',
        ray?.url === `/icon/dds/${b64(rayGfx.file)}.png?rect=${rayCell.join(',')}`,
        ray?.url);
  const got = call(ray.url);
  check('  and serves that cell, not the sheet',
        got.status === 200 && isPng(got.body) && same(pngDims(got.body), rayCell.slice(2)),
        `status ${got.status}, ${isPng(got.body) ? pngDims(got.body).join('x') : 'not a PNG'}`);
  writeFileSync(join(OUT, 'ray-of-spark-cell.png'), got.body);
}

const staffGfx = cat.itemById.get('Staff_Censer').raw.gfx;
const staff = svc.iconRef(staffGfx);
check('item portrait gfx -> dds', staff?.kind === 'dds', JSON.stringify(staff));
check('  url shape', /^\/icon\/dds\/[\w-]+\.png\?px=64$/.test(staff?.url ?? ''),
      staff?.url);

// A talent node drawn double-size: gfx {size:48, width:2, height:2} on a
// class talent sheet. Found by scanning, so a patch moving the row still
// tests the same shape.
const wide = cdb.lines('skill').find((s) =>
  s.gfx?.size === 48 && s.gfx?.width === 2 && s.gfx?.height === 2 &&
  /talent/i.test(s.gfx?.file ?? ''));
if (!wide) {
  check('a size-48 w2 h2 talent gfx exists', false, 'none found in skill sheet');
} else {
  const ref = svc.iconRef(wide.gfx);
  const kind = fileKind(wide.gfx.file).kind;
  check(`w2 h2 talent (${wide.id}) -> ${kind === 'png' ? 'tile' : 'dds'}`,
        ref?.kind === (kind === 'png' ? 'tile' : 'dds'));
  const rect = [wide.gfx.x * 48, wide.gfx.y * 48, 96, 96];
  check('  px rect multiplies size per axis',
        kind === 'png' ? same(ref?.px, rect) : ref?.url?.endsWith(`?rect=${rect.join(',')}`),
        JSON.stringify(ref));
}

// THE SWEEP. Every gfx cell the UI can be asked to draw - skills, their
// runes, statuses, attributes, items - against what its file really is. A
// cell smaller than its DDS texture must name its rect, and the rect must be
// the row's own; a cell that covers the texture keeps the mip picker. This is
// the assertion the PNG->DDS conversion of the atlases needed: with it, a
// sheet served whole as each of its icons fails here instead of in a browser.
{
  const cells = [];
  for (const s of cdb.lines('skill')) {
    if (s.gfx?.file) cells.push([`skill ${s.id}`, s.gfx]);
    for (const m of s.mastery ?? []) if (m.gfx?.file) cells.push([`rune ${m.id}`, m.gfx]);
  }
  for (const a of cdb.lines('attribute')) if (a.gfx?.file) cells.push([`attribute ${a.id}`, a.gfx]);
  for (const t of cdb.lines('statusType')) if (t.gfx?.file) cells.push([`statusType ${t.id}`, t.gfx]);
  for (const it of cat.items) if (it.raw?.gfx?.file) cells.push([`item ${it.id}`, it.raw.gfx]);

  const wrong = [];
  const sheetUrls = new Map();   // url -> expected [w,h]
  let ddsCells = 0, sheetCells = 0;
  for (const [what, g] of cells) {
    const k = fileKind(g.file);
    if (k.kind !== 'dds') continue;
    ddsCells++;
    const cell = cellOf(g);
    const whole = cell[0] === 0 && cell[1] === 0 && cell[2] >= k.w && cell[3] >= k.h;
    const ref = svc.iconRef(g);
    const want = whole ? `/icon/dds/${b64(g.file)}.png?px=64`
      : `/icon/dds/${b64(g.file)}.png?rect=${cell.join(',')}`;
    if (ref?.kind !== 'dds' || ref.url !== want) wrong.push(`${what}: ${JSON.stringify(ref)}`);
    if (!whole) { sheetCells++; sheetUrls.set(want, cell.slice(2)); }
  }
  check(`sweep: every DDS gfx cell is addressed as what it is (${ddsCells} cells, ${sheetCells} of them sheet tiles)`,
        ddsCells > 0 && wrong.length === 0, wrong.slice(0, 3).join(' | '));

  // ...and every distinct sheet tile actually decodes to its own size.
  const bad = [];
  for (const [url, [w, h]] of sheetUrls) {
    const got = call(url);
    if (got.status !== 200 || !isPng(got.body) || !same(pngDims(got.body), [w, h]))
      bad.push(`${url} -> ${got.status} ${isPng(got.body) ? pngDims(got.body).join('x') : got.body.toString().slice(0, 80)}`);
  }
  check(`sweep: each of the ${sheetUrls.size} distinct sheet tiles serves a PNG of its own cell size`,
        bad.length === 0, bad.slice(0, 3).join(' | '));
}

// --- handle: /asset ---------------------------------------------------------

const slots = call('/asset/UI/icons/gear_slots.png');
check('/asset serves a real PNG',
      slots.handled && slots.status === 200 && isPng(slots.body),
      `status ${slots.status}, ${slots.body.length} bytes`);
check('  immutable cache header',
      /immutable/.test(slots.headers['Cache-Control'] ?? ''));

const disguised = call(`/asset/${staffGfx.file}`);
check('/asset refuses DDS-behind-.png', disguised.handled &&
      disguised.status === 404, `status ${disguised.status} for ${staffGfx.file}`);

const outside = call('/asset/data.cdb');
check('/asset refuses non-whitelisted prefix', outside.status === 404,
      `status ${outside.status}`);

check('handle passes on foreign routes', call('/api/bootstrap').handled === false);

// --- handle: /icon/dds ------------------------------------------------------

const at64 = call(staff.url);
check('/icon/dds px=64 serves PNG', at64.status === 200 && isPng(at64.body),
      `status ${at64.status}`);
check('  64px comes off the 64px mip (no full decode)',
      same(pngDims(at64.body), [64, 64]), pngDims(at64.body).join('x'));
writeFileSync(join(OUT, 'staff-censer-64.png'), at64.body);

const at256 = call(staff.url.replace('px=64', 'px=256'));
check('/icon/dds px=256 is mip 0', at256.status === 200 &&
      same(pngDims(at256.body), [256, 256]),
      `status ${at256.status}, ${pngDims(at256.body).join('x')}`);
writeFileSync(join(OUT, 'staff-censer-256.png'), at256.body);

const cell0 = call(`/icon/dds/${b64('atlas:0')}.png?px=64`);
check('/icon/dds atlas:0 serves a 64px cell', cell0.status === 200 &&
      isPng(cell0.body) && same(pngDims(cell0.body), [64, 64]),
      `status ${cell0.status}`);
writeFileSync(join(OUT, 'atlas-cell-0.png'), cell0.body);

const junk = call('/icon/dds/%%%.png');
check('/icon/dds bad b64 is a 404 JSON', junk.status === 404 &&
      !!JSON.parse(junk.body.toString()).error, junk.body.toString());

// --- handle: /icon/dds?rect= ------------------------------------------------
// The slice is checked against the one thing it must equal: the same pixels
// cut out of a FULL decode of mip 0. The texture is the staff's portrait
// (256px, a DDS before and after the atlas conversion), so the test does not
// depend on which sheets a patch happens to ship as DDS.
{
  const dds = parseDds(pak.read(staffGfx.file));
  const full = decodeBc7(dds.mips[0].data, dds.width, dds.height);
  const crop = ([x, y, w, h]) => {
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * dds.width + x) * 4;
      out.set(full.subarray(from, from + w * 4), row * w * 4);
    }
    return out;
  };
  const rects = [
    ['a block-aligned cell', [96, 64, 96, 96]],
    ['a 28px cell at an odd block', [140, 0, 28, 28]],
    // The unit portraits author 250px on a 256px texture: not a multiple of
    // 4 in size, and here not in origin either.
    ['an unaligned rect', [3, 5, 250, 250]],
    ['a single pixel', [255, 255, 1, 1]],
    ['the whole level', [0, 0, dds.width, dds.height]],
  ];
  for (const [what, rect] of rects) {
    const sliced = sliceRectRgba(dds.mips[0].data, dds.width, rect);
    check(`rect slice: ${what} ${rect.join(',')} equals the full decode cropped`,
          Buffer.from(sliced).equals(Buffer.from(crop(rect))));
    const got = call(`/icon/dds/${b64(staffGfx.file)}.png?rect=${rect.join(',')}`);
    check('  and /icon/dds serves exactly that',
          got.status === 200 && got.body.equals(encodePng(crop(rect), rect[2], rect[3])),
          `status ${got.status}, ${isPng(got.body) ? pngDims(got.body).join('x') : got.body.toString().slice(0, 80)}`);
  }

  // Bad rects are bad INPUT: a 404 with a sentence each, never a 500 out of
  // the block slicer and never a cached file.
  const before = existsSync(CACHE) ? readdirSync(CACHE).length : 0;
  for (const text of ['abc', '0,0,96', '0,0,0,96', '0,0,96,0', '-4,0,96,96',
                      '1.5,0,96,96', '0,0,96,96,1', '200,200,96,96',
                      '0,0,99999,99999', '']) {
    const got = call(`/icon/dds/${b64(staffGfx.file)}.png?rect=${encodeURIComponent(text)}`);
    let error = null;
    try { error = JSON.parse(got.body.toString()).error; } catch { /* not JSON */ }
    check(`rect "${text}" on a ${dds.width}px texture is a 404 with a sentence`,
          got.status === 404 && typeof error === 'string' && error.length > 0,
          `status ${got.status}: ${got.body.toString().slice(0, 90)}`);
  }
  const onAtlas = call(`/icon/dds/${b64('atlas:0')}.png?rect=0,0,64,64`);
  check('rect on an atlas cell is a 404', onAtlas.status === 404, `status ${onAtlas.status}`);
  check('  and no refused rect left a file in the cache',
        (existsSync(CACHE) ? readdirSync(CACHE).length : 0) === before);
  check('parseRect: shape only', same(parseRect('8,4,96,48'), [8, 4, 96, 48])
        && parseRect('8,4,96') === null && parseRect('8,4,0,48') === null
        && parseRect(' 8,4,96,48') === null && parseRect(null) === null);
}

// --- the disk cache ---------------------------------------------------------

const cached = existsSync(CACHE) ? readdirSync(CACHE) : [];
check('disk cache populated', cached.length >= 3,
      `${cached.length} file(s) in ${CACHE}`);
const again = call(staff.url);
check('cache round-trip serves identical bytes', again.body.equals(at64.body));

// The cache name carries the build. The pak's stamp is in the name of the
// file the px=64 request just wrote; a different stamp is a different name;
// and a file planted under the PRE-stamp name (sha1 of '<path>#<px>' alone,
// what this service wrote before) is never read back - which is the whole
// point, since 21 such files outlived the patch that repainted their icons.
{
  const stamp = fileStamp(join(GAME, 'res.pak'));
  const key = `${staffGfx.file}#64`;
  check('cache: the pak has a stamp', /^\d+-\d+$/.test(stamp), stamp);
  check('cache: the decoded file is named by stamp + key',
        cached.includes(cacheName(stamp, key)), cacheName(stamp, key));
  check('cache: another build\'s stamp is another name',
        cacheName(`${stamp}0`, key) !== cacheName(stamp, key));
  const legacy = `${createHash('sha1').update(key).digest('hex')}.png`;
  check('cache: the pre-stamp name is not the stamped one', legacy !== cacheName(stamp, key));
  writeFileSync(join(CACHE, legacy), 'a stale decode from another build');
  const fresh = await createIconService({ benchRoot: BENCH, game: GAME });
  let body = Buffer.alloc(0);
  fresh.handle({ url: staff.url, method: 'GET' },
    { writeHead() {}, end: (b) => { if (b) body = Buffer.from(b); } },
    new URL(staff.url, 'http://bench').pathname,
    new URL(staff.url, 'http://bench').searchParams);
  fresh.close();
  check('cache: a file under the pre-stamp name is not served', body.equals(at64.body),
        `${body.length} bytes, ${isPng(body) ? 'the decoded PNG' : JSON.stringify(body.toString('latin1', 0, 32))}`);
}

// --- atlasFor ---------------------------------------------------------------

const chest = svc.atlasFor('Chest_RManfish_FigWiz');
check('atlasFor(Chest_RManfish_FigWiz) exists', !!chest);
check('  acquire prose non-empty', !!chest?.acquire, chest?.acquire);
check('  >=1 track pin with coords',
      (chest?.track?.length ?? 0) >= 1 &&
      chest.track.every((t) => t.label && Number.isFinite(t.x) &&
                        Number.isFinite(t.y) && Number.isFinite(t.z)),
      JSON.stringify(chest?.track?.[0]));

const runeRow = readFileSync(join(GAME, 'farever-atlas.tsv'), 'utf8')
  .split('\n').map((l) => l.split('\t')).find((f) => f[0] === 'runes');
if (!runeRow) {
  check('tsv has a runes row', false);
} else {
  const rune = svc.atlasFor(runeRow[1]);
  check(`atlasFor rune (${runeRow[1]}) exists`, !!rune, JSON.stringify(rune));
  check('  rune has an atlas cell', Number.isInteger(rune?.cell),
        `cell ${rune?.cell}`);
}

check('atlasFor(unknown) is null', svc.atlasFor('No_Such_Id_') === null);

pak.close();
svc.close();
console.log(failed ? `${failed} check(s) FAILED`
                   : `all checks passed - inspect PNGs in ${OUT}`);
process.exit(failed ? 1 : 0);
