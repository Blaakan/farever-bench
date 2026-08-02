// Diff the model's per-item bake against the game's OWN logged bake.
//
// captures/2026-08-02-v2/bench-probe-bakes.csv is a postfix on
// $HItem.generateItemAffixes@20747: item id, the iLevel it was called with, and
// every affix line that came back. That is not a tooltip reading - it is the
// function's return value - so any disagreement is the model's.
import { createEngine } from '../src/engine.mjs';
import fs from 'node:fs';

const CSV = process.argv[2]
  ?? 'D:/Gits/farever-hlx/captures/2026-08-02-v2/bench-probe-bakes.csv';
const eng = createEngine({ quiet: true });
const { cat } = eng;

// One row per (item, rarity, iLevel); `bake` rows carry level_arg, `item_affixes`
// rows carry item_ilevel. Both name the same number.
const truth = new Map();
for (const line of fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1)) {
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
