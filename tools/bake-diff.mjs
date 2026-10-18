// Diff the model's per-item bake against the game's OWN logged bake.
//
//   node tools/bake-diff.mjs [<bakes.csv>] [--game <dir>] [--all]
//
// The probe's bake log (hlx/logs/bench-probe-bakes.csv in the install) is a
// postfix on $HItem.generateItemAffixes@21736: item id, the iLevel it was
// called with, and every affix line that came back. That is not a tooltip
// reading - it is the function's return value - so any disagreement is the
// model's.
//
// WHICH ROWS. The log is append-only across boots and across patches (223 MB
// from August to October 2026), and a signature here is item@rarity@iLevel
// with the last row winning - so the whole file holds today's model against
// bakes of every build it was ever appended on, and cannot say which. From
// schema v10 the probe opens each boot's rows with a `session` row naming
// the hlboot.dat they were recorded against. So by default this reads the
// install's own log, and of it only the rows after the LAST session row: one
// boot, one build. It says which boot that was and whether it is the
// hlboot.dat in the install now. A log with no session row (an older probe)
// is read whole, and that is said too; --all forces the whole file.
import { createEngine } from '../src/engine.mjs';
import { lastSession } from '../src/drift.mjs';
import { findGame } from '../src/lib/game.mjs';
import fs from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const positional = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--game');
const game = findGame(argv);
const CSV = positional ?? (game ? join(game, 'hlx', 'logs', 'bench-probe-bakes.csv') : null);
if (!CSV || !fs.existsSync(CSV)) {
  console.error(CSV
    ? `no bake log at ${CSV} - the probe writes it on the first login after it is installed`
    : 'no Farever install found and no csv given: node tools/bake-diff.mjs <bakes.csv> | --game <dir>');
  process.exit(1);
}
const eng = createEngine({ quiet: true });
const { cat } = eng;

// The window: where the last boot's rows start, and which boot that was.
const session = lastSession(CSV);
const from = !ALL && session?.found ? session.next : 0;
const day = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : '?');
if (ALL || !session?.found) {
  console.log(`${CSV}: reading the WHOLE log${ALL ? ' (--all)' : ' - it has no session row (written by a probe older than v10)'}. `
    + 'Rows of every build it was appended on are mixed, the last one written winning per item@rarity@iLevel.');
} else {
  const bootPath = game ? join(game, 'hlboot.dat') : null;
  const boot = bootPath && fs.existsSync(bootPath) ? fs.statSync(bootPath) : null;
  // The probe reads the file's mtime in whole seconds.
  const same = boot && session.bootBytes === boot.size && Math.abs(session.bootMtimeMs - boot.mtimeMs) < 2000;
  console.log(`${CSV}: the rows after its last session row (probe v${session.probe ?? '?'}, ${day(session.ts)}), recorded against a hlboot.dat of `
    + `${session.bootBytes} bytes dated ${day(session.bootMtimeMs)} - `
    + (boot ? (same ? 'the hlboot.dat in this install.' : 'NOT the hlboot.dat in this install now: another build\'s bakes against this build\'s data.')
      : 'no install here to compare it with.'));
}

// Lines from an offset, read in chunks: the log does not fit a string.
function* linesFrom(path, start) {
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    const dec = new StringDecoder('utf8');
    let rest = '';
    for (let pos = start; ;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const parts = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      yield* parts;
    }
    if (rest) yield rest;
  } finally { fs.closeSync(fd); }
}

// One row per (item, rarity, iLevel); `bake` rows carry level_arg, `item_affixes`
// rows carry item_ilevel. Both name the same number.
const truth = new Map();
for (const raw of linesFrom(CSV, from)) {
  const line = raw.replace(/\r$/, '');
  const f = line.split(',');
  const [, event, itemId, rarity, , levelArg] = f;
  // ONLY `bake` rows. They carry the iLevel `generateItemAffixes` was actually
  // called with - including 290 for the live 3-star socketed axe against the
  // def table's 260. An `item_affixes` row reports the item's DEF iLevel while
  // carrying the live affixes, so mixing the two files 290's numbers under 260.
  if (event !== 'bake') continue;
  const iLevel = Number(levelArg);
  if (!Number.isFinite(iLevel) || !iLevel) continue;
  const affixes = new Map();
  for (const part of f.slice(8).join(',').split('|')) {
    const m = /TAttribute_(\w+):(-?[\d.]+):(?:\{attribute\s*:\s*(\w+)\}|ETAttribute\((\w+)\))/.exec(part);
    if (!m) continue;
    affixes.set(m[3] ?? m[4], Number(m[2]));
  }
  if (!affixes.size) continue;
  truth.set(`${itemId}@${rarity}@${iLevel}`, { itemId, rarity, iLevel, affixes });
}

// The model's own bake for one item at one iLevel. `contribute` writes into a
// mods bag keyed by slot; the iLevel is forced by pinning the instance level,
// since effectiveLevel() multiplies it by 10.
function modelBake(itemId, rarity, iLevel) {
  const item = cat.itemById.get(itemId);
  if (!item) return null;
  // `generateItemAffixes` returns the item's OWN lines; the arsenal's 0.4
  // discount is applied when it is equipped there. A shield lists Slot_Weapon2
  // before Slot_OffhandWeapon, so taking slots[0] prices every shield at 40%.
  const slotId = (item.slots ?? []).find((s) => (cat.slotById?.get(s)?.affixFactor ?? 1) === 1)
    ?? item.slots?.find((s) => s !== 'Slot_Weapon2') ?? item.slots?.[0];
  if (!slotId) return null;
  const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
  const sink = mods;
  // effectiveLevel() ADDS the rarity's iLevelBonus to level*10, so the instance
  // level has to be handed in net of it or the probe prices a level too high.
  const bonus = eng.cdb.byId('rarity').get(rarity)?.props?.iLevelBonus ?? 0;
  try {
    cat.contribute(item, slotId, {
      charLevel: 25, rarity, stars: 0, level: (iLevel - bonus) / 10,
      armorReduction: 0.4, aptitude: 'Fighter', allAptitudes: false,
    }, sink);
  } catch (e) { return { error: e.message }; }
  return mods.flat;
}

const ORDER = ['Vitality', 'Strength', 'Dexterity', 'Intellect', 'Faith', 'Armor', 'MagicArmor',
  'CritChanceRating', 'ArmorPenetrationRating', 'SpellPenetrationRating', 'FervorRating'];
const key = (a) => { const i = ORDER.indexOf(a); return i < 0 ? 99 : i; };

let exact = 0, off = 0, missing = 0;
const seen = new Set();
console.log('ITEM                     RAR    iLVL   ATTRIBUTE                 GAME  MODEL   d');
for (const t of [...truth.values()].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
  if (seen.has(`${t.itemId}@${t.rarity}@${t.iLevel}`)) continue;
  seen.add(`${t.itemId}@${t.rarity}@${t.iLevel}`);
  const got = modelBake(t.itemId, t.rarity, t.iLevel);
  if (!got || got.error) { console.log(`${t.itemId.padEnd(24)} ${String(t.rarity).padEnd(6)} ${String(t.iLevel).padStart(5)}   (${got?.error ?? 'no slot'})`); missing++; continue; }
  const attrs = [...new Set([...t.affixes.keys(), ...got.keys()])].sort((a, b) => key(a) - key(b));
  let first = true;
  for (const a of attrs) {
    const g = t.affixes.get(a) ?? 0;
    const m = Math.round(got.get(a) ?? 0);
    if (g === m) { exact++; continue; }
    off++;
    const head = first ? `${t.itemId.padEnd(24)} ${String(t.rarity).padEnd(6)} ${String(t.iLevel).padStart(5)}` : ' '.repeat(37);
    console.log(`${head}   ${a.padEnd(24)} ${String(g).padStart(5)} ${String(m).padStart(6)} ${String(m - g).padStart(4)}`);
    first = false;
  }
}
console.log(`\n${truth.size} logged signatures, ${seen.size} distinct  |  lines exact ${exact}, off ${off}, items unpriceable ${missing}`);
