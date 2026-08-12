#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-icon-service.mjs - self-test for ui/icons.mjs against the real game.
//
// Boots the service the way ui/server.mjs will, then walks the whole exported
// surface: gfx-row sniffing (tile vs DDS, per-row size multiplication,
// width/height 2 talent rects), the /asset whitelist + PNG-magic gate, the
// /icon/dds mip picker (px=64 must come off the 64px mip, px=256 off mip 0)
// and the atlas:<cell> form, plus the farever-atlas.tsv lookups (acquire
// prose, map pins, runes). Decoded PNGs land in the scratchpad for eyeballs;
// the disk cache is wiped first so the decode path actually runs.
//
// Runs standalone:  node ui/lib/check-icon-service.mjs
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
         writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIconService } from '../icons.mjs';
import { loadCdb } from '../../src/cdb.mjs';
import { buildContext } from '../../src/model.mjs';
import { buildCatalog } from '../../src/catalog.mjs';

// The install to read: named on the command line, else the one the engine
// finds the same way every other tool here does.
const GAME = process.argv[2] ?? null;
const BENCH = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const OUT = join(tmpdir(), 'farever-bench-checks') +
            '03ac7b29-54a5-4bd9-91f4-206ef2a78fbc/scratchpad/icon-service-check';
const CACHE = join(BENCH, '.cache', 'ui-icons');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPng = (buf) => buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47;
const pngDims = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

mkdirSync(OUT, { recursive: true });
rmSync(CACHE, { recursive: true, force: true });   // exercise the decode path

const cdb = loadCdb({ game: GAME });
const cat = buildCatalog(cdb, buildContext(cdb));
const svc = await createIconService({ benchRoot: BENCH, game: GAME });

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

// --- iconRef ----------------------------------------------------------------

check('iconRef(null) is null', svc.iconRef(null) === null);
check('iconRef({}) is null', svc.iconRef({}) === null);

const ray = svc.iconRef(cdb.row('skill', 'Mage_RayOfSpark').gfx);
check('skill gfx -> tile', ray?.kind === 'tile', JSON.stringify(ray));
check('  sheet is 960x960', same(ray?.sheet, [960, 960]),
      JSON.stringify(ray?.sheet));
check('  px rect is [0,0,96,96]', same(ray?.px, [0, 0, 96, 96]),
      JSON.stringify(ray?.px));

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
  check(`w2 h2 talent (${wide.id}) -> tile`, ref?.kind === 'tile');
  check('  px rect multiplies size per axis',
        same(ref?.px, [wide.gfx.x * 48, wide.gfx.y * 48, 96, 96]),
        JSON.stringify(ref?.px));
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

const cell0 = call(`/icon/dds/${Buffer.from('atlas:0').toString('base64url')}.png?px=64`);
check('/icon/dds atlas:0 serves a 64px cell', cell0.status === 200 &&
      isPng(cell0.body) && same(pngDims(cell0.body), [64, 64]),
      `status ${cell0.status}`);
writeFileSync(join(OUT, 'atlas-cell-0.png'), cell0.body);

const junk = call('/icon/dds/%%%.png');
check('/icon/dds bad b64 is a 404 JSON', junk.status === 404 &&
      !!JSON.parse(junk.body.toString()).error, junk.body.toString());

const cached = existsSync(CACHE) ? readdirSync(CACHE) : [];
check('disk cache populated', cached.length >= 3,
      `${cached.length} file(s) in ${CACHE}`);
const again = call(staff.url);
check('cache round-trip serves identical bytes', again.body.equals(at64.body));

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

svc.close();
console.log(failed ? `${failed} check(s) FAILED`
                   : `all checks passed - inspect PNGs in ${OUT}`);
process.exit(failed ? 1 : 0);
