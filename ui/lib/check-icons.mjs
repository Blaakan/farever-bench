#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-icons.mjs - self-test for the BC7 decode path against real game data.
//
// Atlas geometry, per farever-mods/tools/gen-atlas.mjs ("icon atlas: repack
// 64px BC7 mips, no decoding"): 64px cells, 32 per row (2048px wide), height
// rows*64 for however many icons exist, written as a single-mip BC7_UNORM
// DDS with a 148-byte header (4 magic + 124 DDS_HEADER + 20 DX10, dxgiFormat
// 98). Cells are filled row-major in TSV `icon` column order. Each cell is
// the 64px mip (mip 2) of a 256x256 BC7 portrait from res.pak, copied
// block-for-block - so a decoded atlas tile and the decoded portrait mip are
// the same bytes through the same code, and the portrait's own mip chain is
// the independent cross-check: mip 2 must look like mip 0 shrunk 4x.
//
// Runs standalone:  node ui/lib/check-icons.mjs
// ---------------------------------------------------------------------------

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDds } from './dds.mjs';
import { decodeBc7 } from './bc7.mjs';
import { encodePng } from './png.mjs';
import { openPak } from './pak.mjs';

// The install to read: named on the command line, else the one the engine
// finds the same way every other tool here does.
const GAME = process.argv[2] ?? null;
const OUT = join(tmpdir(), 'farever-bench-checks') +
            '03ac7b29-54a5-4bd9-91f4-206ef2a78fbc/scratchpad/icon-check';
const PORTRAIT = 'UI/Portraits/Items/AugmentDemon/' +
                 'Items_Loot_GearAccessory_GearUpgrade_APToCrit_01.prefab.png';
const CELL = 64, COLS = 32;

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

mkdirSync(OUT, { recursive: true });

// --- the atlas --------------------------------------------------------------

const atlas = parseDds(readFileSync(join(GAME, 'farever-atlas-icons.dds')));
check('atlas format', atlas.format === 'BC7_UNORM', atlas.format);
check('atlas geometry', atlas.width === COLS * CELL && atlas.height % CELL === 0,
      `${atlas.width}x${atlas.height}, ${atlas.mipCount} mip`);

// Mode histogram straight off the compressed payload (the mode is the lowest
// set bit of a block's first byte): a plausible decode of icon art leans on
// the alpha-capable modes 4-7, and "reserved" only appears in the zero-filled
// padding cells after the last icon.
{
  const h = new Array(8).fill(0);
  let reserved = 0;
  const data = atlas.mips[0].data;
  for (let off = 0; off < data.length; off += 16) {
    const b0 = data[off];
    if (b0 === 0) { reserved++; continue; }
    let mode = 0;
    while (!((b0 >> mode) & 1)) mode++;
    h[mode]++;
  }
  console.log(`block modes: ${h.map((n, i) => `${i}:${n}`).join(' ')} ` +
              `reserved:${reserved}`);
}

const t0 = performance.now();
const atlasRgba = decodeBc7(atlas.mips[0].data, atlas.width, atlas.height);
const decodeMs = performance.now() - t0;
console.log(`atlas mip0 decode: ${atlas.width}x${atlas.height} in ` +
            `${decodeMs.toFixed(0)} ms`);

// --- pick tiles via the TSV -------------------------------------------------

// Columns: category id name rarity icon desc acquire track tags. Several
// entries can share one icon cell (the cache in gen-atlas dedupes by file),
// so the name printed is the first entry that uses the cell.
const rows = readFileSync(join(GAME, 'farever-atlas.tsv'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => l.split('\t'));
const byIcon = new Map();
let maxIcon = -1;
for (const r of rows) {
  const icon = Number(r[4]);
  if (!Number.isInteger(icon) || icon < 0) continue;
  if (icon > maxIcon) maxIcon = icon;
  if (!byIcon.has(icon)) byIcon.set(icon, r);
}
check('tsv has icons', maxIcon >= 8, `${byIcon.size} distinct cells, max ${maxIcon}`);
check('atlas holds every tsv icon',
      atlas.height / CELL >= Math.ceil((maxIcon + 1) / COLS),
      `${(atlas.height / CELL) * COLS} cells for ${maxIcon + 1}`);

const picks = [0, 1, 2, Math.floor(maxIcon / 3), Math.floor((2 * maxIcon) / 3)];

function tileOf(index) {
  const x0 = (index % COLS) * CELL;
  const y0 = Math.floor(index / COLS) * CELL;
  const tile = new Uint8Array(CELL * CELL * 4);
  for (let y = 0; y < CELL; y++) {
    const s = ((y0 + y) * atlas.width + x0) * 4;
    tile.set(atlasRgba.subarray(s, s + CELL * 4), y * CELL * 4);
  }
  return tile;
}

function stats(rgba) {
  const n = rgba.length / 4;
  const mean = [0, 0, 0, 0], m2 = [0, 0, 0, 0];
  let opaque = 0, transparent = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      mean[c] += rgba[i + c];
      m2[c] += rgba[i + c] * rgba[i + c];
    }
    if (rgba[i + 3] >= 250) opaque++;
    else if (rgba[i + 3] <= 5) transparent++;
  }
  const stddev = mean.map((s, c) =>
    Math.sqrt(Math.max(0, m2[c] / n - (s / n) * (s / n))));
  return { stddev, opaque, transparent };
}

let opaqueTotal = 0, transparentTotal = 0;
for (const index of picks) {
  const row = byIcon.get(index);
  const tile = tileOf(index);
  const s = stats(tile);
  opaqueTotal += s.opaque;
  transparentTotal += s.transparent;
  writeFileSync(join(OUT, `atlas-${index}.png`), encodePng(tile, CELL, CELL));
  const who = row ? `${row[2]} [${row[1]}, ${row[0]}]` : 'no tsv row';
  console.log(`  atlas-${index}.png: ${who}, ` +
              `stddev rgba ${s.stddev.map((v) => v.toFixed(1)).join('/')}`);
  check(`tile ${index} not flat`, Math.max(...s.stddev) > 8,
        `max stddev ${Math.max(...s.stddev).toFixed(1)}`);
}
check('alpha has both extremes in sample',
      opaqueTotal > 50 && transparentTotal > 50,
      `${opaqueTotal} opaque, ${transparentTotal} transparent px`);

// --- one portrait, straight from res.pak ------------------------------------

const pak = openPak(join(GAME, 'res.pak'));
const portrait = parseDds(pak.read(PORTRAIT));
pak.close();
check('portrait geometry',
      portrait.width === 256 && portrait.height === 256 && portrait.mipCount >= 3,
      `${portrait.width}x${portrait.height}, ${portrait.mipCount} mips, ` +
      portrait.format);

const mip0 = decodeBc7(portrait.mips[0].data, 256, 256);
const m64 = portrait.mips[2];
check('portrait mip2 is 64px', m64.width === 64 && m64.height === 64,
      `${m64.width}x${m64.height}`);
const mip2 = decodeBc7(m64.data, m64.width, m64.height);
writeFileSync(join(OUT, 'portrait-mip0.png'), encodePng(mip0, 256, 256));
writeFileSync(join(OUT, 'portrait-mip2-64.png'),
              encodePng(mip2, m64.width, m64.height));

// The cross-check that catches a decoder that is only approximately right:
// box-shrink the decoded 256px level by 4 and compare against the decoded
// 64px level. The game's mip chain came from a real filter, not this box
// average, so a small distance is expected - but a table or bit-order slip
// scrambles blocks and lands the mean far away.
{
  const down = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 4; dx++)
            sum += mip0[((y * 4 + dy) * 256 + x * 4 + dx) * 4 + c];
        down[(y * 64 + x) * 4 + c] = (sum + 8) >> 4;
      }
  let dist = 0, n = 0, aDist = 0;
  for (let i = 0; i < down.length; i += 4) {
    aDist += Math.abs(down[i + 3] - mip2[i + 3]);
    if (down[i + 3] < 32 || mip2[i + 3] < 32) continue;  // rgb is noise there
    const dr = down[i] - mip2[i];
    const dg = down[i + 1] - mip2[i + 1];
    const db = down[i + 2] - mip2[i + 2];
    dist += Math.sqrt(dr * dr + dg * dg + db * db);
    n++;
  }
  const meanRgb = n ? dist / n : Infinity;
  const meanA = aDist / (down.length / 4);
  check('mip0/4 matches mip2', meanRgb < 20 && meanA < 20,
        `mean rgb distance ${meanRgb.toFixed(2)} over ${n} px, ` +
        `mean alpha delta ${meanA.toFixed(2)}`);
}

console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
