#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The regression suite. Zero dependencies, run with `node test/run.mjs`.
//
// Most of these assert a formula against a number computed by hand from the
// disassembly, not against whatever the code currently produces - so if a
// patch moves a constant, or somebody "simplifies" the rating conversion into
// `scale * rating`, the suite says so instead of quietly agreeing.
//
// It needs a copy of the game, because the whole point is that no number is
// hardcoded. Where a test depends on a value that a balance patch may legally
// change, it asserts the RELATIONSHIP rather than the literal.
// ---------------------------------------------------------------------------

import { loadCdb } from '../src/cdb.mjs';
import { buildContext, budget, resistForReduction, damageReduction, baseStats } from '../src/model.mjs';
import { buildCatalog } from '../src/catalog.mjs';
import { createEngine } from '../src/engine.mjs';
import { emptyLoadout, illegalReason, pruneIllegal } from '../src/loadout.mjs';
import { optimize } from '../src/optimize.mjs';
import { simulate } from '../src/sim.mjs';
import {
  makePolicy, derivedApl, repairApl, searchApl, vocabularyFor, condLabel, conjoin, contradictory,
} from '../src/rotation.mjs';
import { slugOf, normalize, translate, commandLine } from '../src/questlog.mjs';
import { compare } from '../src/verify.mjs';
import { parseExtra, archetype, snapshots, aggregate } from '../src/capture.mjs';
import { fromSnapshot } from '../src/inventory.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readHlb } from '../src/lib/hl.mjs';
import { requireBoot } from '../src/lib/game.mjs';
import { buildFingerprint, diffFingerprints, resolveCitations, workList } from '../src/drift.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` - ${detail}` : ''}`);
}
function near(name, got, want, tol = 1e-6) {
  const d = Math.abs(got - want);
  ok(name, d <= tol, `got ${got}, want ${want} (diff ${d.toExponential(2)})`);
}
function group(title) { process.stdout.write(`\n${title}\n`); }

const cdb = loadCdb();
const ctx = buildContext(cdb);
const cat = buildCatalog(cdb, ctx);
const K = ctx.consts;

// --- the curve -------------------------------------------------------------
group('budget curve');
near('level 1 returns start', budget(1, 30, 540, K.earlyMaxLevel), 30);
near('level EarlyMaxLevel returns end', budget(K.earlyMaxLevel, 30, 540, K.earlyMaxLevel), 540);
ok('monotonic in level', budget(10, 30, 540, K.earlyMaxLevel) < budget(11, 30, 540, K.earlyMaxLevel));
near('geometric: budget(L)^2 = budget(L-1)*budget(L+1)',
  budget(25, 30, 540, K.earlyMaxLevel) ** 2,
  budget(24, 30, 540, K.earlyMaxLevel) * budget(26, 30, 540, K.earlyMaxLevel), 1e-6);
near('degenerate row contributes nothing', budget(25, 0, 0, K.earlyMaxLevel), 0);

// --- rating conversion -----------------------------------------------------
group('rating -> percent');
{
  // Every Rating operator in the sheet, at several levels: a full budget must
  // yield exactly `target` percentage points, which is the property that makes
  // rating linear at a fixed level.
  let checked = 0;
  for (const a of ctx.attrTable.attrs) {
    for (const s of a.scaling) {
      if (s.op.case !== 'Rating') continue;
      const { min, max, target } = s.op.args;
      for (const L of [1, 10, 25, 40, K.earlyMaxLevel]) {
        const b = budget(L, min, max, K.earlyMaxLevel);
        near(`${a.id} <- ${s.from}: full budget at L${L} yields target`, (b / b) * target, target, 1e-9);
      }
      checked++;
    }
  }
  ok('at least one Rating operator exists', checked > 0, `found ${checked}`);

  // The hand-computed figures the model was written against.
  const crit = ctx.attrTable.byId.get('CritChance').scaling.find((s) => s.from === 'CritChanceRating');
  ok('CritChanceRating is a Rating operator', crit.op.case === 'Rating');
  const b25 = budget(25, crit.op.args.min, crit.op.args.max, K.earlyMaxLevel);
  near('rating budget at L25 is ~379.87', b25, 379.87, 0.01);
  near('+1 CritChanceRating = +0.05265pp at L25', crit.op.args.target / b25, 0.05265, 1e-5);

  // The trap: `scale` is not read on this path. If someone reintroduces it,
  // the answer moves by 7.5x, so assert the two are NOT equal.
  ok('scale is not the conversion factor for a Rating operator',
    Math.abs(crit.scale - crit.op.args.target / b25) > 1e-3,
    `scale=${crit.scale}, real=${crit.op.args.target / b25}`);

  // Depreciation per level: (max/min)^(1/(EarlyMaxLevel-1)).
  const step = Math.pow(crit.op.args.max / crit.op.args.min, 1 / (K.earlyMaxLevel - 1));
  near('a rating point loses ~3.8% of its value per level', 1 - 1 / step, 0.0380, 5e-4);
}

// --- mitigation ------------------------------------------------------------
group('armor and mitigation');
for (const L of [1, 10, 25, 50]) {
  for (const red of [0.25, 0.3, 0.35, 0.4]) {
    const r = resistForReduction(L, red, K.resistFormula);
    const back = damageReduction({ resist: r, penetrationPct: 0, attackerLevel: L, formula: K.resistFormula });
    near(`resistForReduction/damageReduction round-trip L${L} red${red}`, back, red, 1e-9);
  }
}
ok('penetration reduces mitigation', damageReduction({ resist: 1000, penetrationPct: 50, attackerLevel: 25, formula: K.resistFormula })
  < damageReduction({ resist: 1000, penetrationPct: 0, attackerLevel: 25, formula: K.resistFormula }));
near('100% penetration removes all mitigation',
  damageReduction({ resist: 1000, penetrationPct: 100, attackerLevel: 25, formula: K.resistFormula }), 0);
ok('penetration is clamped, not extrapolated',
  damageReduction({ resist: 1000, penetrationPct: 500, attackerLevel: 25, formula: K.resistFormula }) === 0);
ok('mitigation is never negative',
  damageReduction({ resist: 0, penetrationPct: 0, attackerLevel: 25, formula: K.resistFormula }) >= 0);

// armorIgnore and penetration are TWO multiplies on the pool, not one sum.
// getAffinityDamageReduction@4510 reduces the resist pool at ops 133-147
// (physical) or 80-95 (magic), and again at ops 259-263 for penetration. The
// model folded the first into the second, computing (1 - a - b) where the game
// computes (1 - a)(1 - b) - exact when either is zero, which is why no
// calibrated build ever caught it, and 2-3% high whenever both are live.
{
  const [a, b] = K.resistFormula;
  const at = (resist, ignoreRatio, penetrationPct, L = 25) =>
    damageReduction({ resist, ignoreRatio, penetrationPct, attackerLevel: L, formula: K.resistFormula });
  const expect = (resist, ig, pen, L = 25) => {
    const r = resist * (1 - ig) * (1 - pen / 100);
    return r / (r + a + b * L);
  };

  near('ignore and penetration each take their own cut of the pool',
    at(2000, 0.10, 40), expect(2000, 0.10, 40), 1e-12);
  near('the same pair read additively is a different, larger number',
    at(2000, 0, 50), expect(2000, 0, 50), 1e-12);
  ok('the additive reading overstates damage - it mitigates less than the game does',
    at(2000, 0.10, 40) > damageReduction({
      resist: 2000, penetrationPct: 0.10 * 100 + 40, attackerLevel: 25, formula: K.resistFormula,
    }));

  // Exposed Essence rank 2 on a bleeding target, against a 0.40 elite.
  near('Exposed Essence 10% ignore composes with 40% penetration',
    at(1923.33, 0.10, 40), expect(1923.33, 0.10, 40), 1e-12);

  // Independent clamps. Folding the two levers together let a large
  // penetration mask an out-of-range ignore, and vice versa.
  near('a full ignore empties the pool by itself', at(2000, 1, 0), 0, 1e-12);
  ok('ignore is clamped to 1, not extrapolated', at(2000, 4, 0) === 0);
  near('a negative ignore is clamped to 0, leaving penetration alone',
    at(2000, -3, 40), expect(2000, 0, 40), 1e-12);
  near('ignore and penetration clamp independently',
    at(2000, 2, 500), 0, 1e-12);
  near('omitting ignore is exactly the old one-lever behaviour',
    at(1500, 0, 35), expect(1500, 0, 35), 1e-12);
}

// The authored Armor columns are dead at runtime, but three of the four
// classes still agree with their props.armorReduction - so a disagreement in
// the OTHER direction (a class whose authored numbers start matching, or a new
// class that does not) is worth noticing.
group('authored armor vs props.armorReduction');
for (const apt of cdb.lines('aptitude')) {
  const red = apt.props?.armorReduction;
  const row = (apt.atbScaling ?? []).find((e) => e.endAtb === 'Armor');
  if (red == null || !row) continue;
  const implied = resistForReduction(1, red, K.resistFormula);
  const agrees = Math.abs(implied - row.start) <= 1.5;
  if (apt.id === 'Fighter') {
    ok('Fighter authored armor is known to disagree with its props', !agrees,
      `authored ${row.start}, props imply ${implied.toFixed(1)} - if this now agrees, update docs/MODEL.md`);
  } else {
    ok(`${apt.id} authored armor agrees with props.armorReduction`, agrees,
      `authored ${row.start}, props imply ${implied.toFixed(1)}`);
  }
}

// --- data-shape invariants -------------------------------------------------
group('data shape');
{
  // Every custom-type value in the attribute sheet must decode. An unknown
  // case is a new mechanic, and silently treating it as Flat is how a tool
  // starts lying after a patch.
  let ops = 0;
  for (const a of ctx.attrTable.attrs) for (const s of a.scaling) {
    ok(`${a.id} <- ${s.from} decodes to a known operator`,
      ['Flat', 'LinearRatio', 'Rating'].includes(s.op.case), s.op.case);
    ops++;
  }
  ok('the attribute sheet has scaling entries', ops > 10, `${ops} entries`);

  // The per-slot budget shares are authored to sum to 1.0. If they stop doing
  // that, the budget model is being renormalised somewhere we do not model.
  const sums = { primary: 0, vitality: 0, armor: 0, ratings: 0 };
  const counted = new Set();
  for (const slot of cat.combatSlots()) {
    for (const it of cat.items) {
      if (it.isAugment || !it.slots.includes(slot.id)) continue;
      const ratios = cat.inherited(it.type, (t) => t?.atbRatio);
      if (!ratios) continue;
      const key = slot.id + '|' + it.type;
      if (counted.has(key)) continue;
      counted.add(key);
      break;
    }
  }
  // Sum over the canonical armour set plus the mainhand, which is the set the
  // authored weights were balanced across.
  const ARMOUR = ['Head', 'Shoulders', 'Chest', 'Hands', 'Waist', 'Legs', 'Feet', 'Back'];
  for (const t of [...ARMOUR, 'MainhandWeapon']) {
    const r = cdb.byId('itemType').get(t)?.atbRatio ?? {};
    for (const g of Object.keys(sums)) sums[g] += r[g] ?? 0;
  }
  near('primary budget shares sum to 1.0 across armour + mainhand', sums.primary, 1.0, 1e-9);
  near('armor budget shares sum to 1.0 across armour', sums.armor, 1.0, 1e-9);

  ok('Slot_Weapon2 discounts its stats', cat.slotById.get('Slot_Weapon2').affixFactor < 1,
    String(cat.slotById.get('Slot_Weapon2').affixFactor));
  ok('exactly four playable classes', cat.classes.length === 4, `${cat.classes.length}`);

  // Every affix an equippable or augment actually uses must be one the model
  // applies. An unhandled ref would silently contribute nothing.
  const HANDLED = new Set(['TAttribute_Flat', 'TAttribute_ARatio', 'TAttribute_MRatio', 'TAttribute_MRatioMin']);
  const unhandled = new Set();
  for (const it of cat.items) {
    for (const a of it.affixes ?? []) {
      if (a.target?.attribute && !HANDLED.has(a.ref)) unhandled.add(`${it.id}:${a.ref}`);
    }
  }
  ok('every attribute-targeting affix in use is handled', unhandled.size === 0, [...unhandled].join(', '));

  // The one conversion the budget model needs.
  near('MaxHealth per Vitality is 3',
    ctx.attrTable.byId.get('MaxHealth').scaling.find((s) => s.from === 'Vitality').scale, 3);
}

// --- the sheet -------------------------------------------------------------
group('computed sheet');
{
  const engine = createEngine();
  const naked = emptyLoadout(cat, 'Priest', 25);
  const ev = engine.evaluate(naked);
  const g = (id) => ev.sheet.get(id);

  // CritChance and CritDamage are the two places the model can be checked
  // against arithmetic with no gear involved at all.
  const critScale = ctx.attrTable.byId.get('CritChance').scaling;
  const perDex = critScale.find((s) => s.from === 'Dexterity').scale;
  const perFaith = critScale.find((s) => s.from === 'Faith').scale;
  const baseCrit = baseStats(cdb, ctx, 'Priest', 25).get('CritChance');
  near('naked CritChance = base + perDex*Dex + perFaith*Faith',
    g('CritChance'), baseCrit + perDex * g('Dexterity') + perFaith * g('Faith'), 1e-9);

  const cdScale = ctx.attrTable.byId.get('CritDamage').scaling;
  const perStr = cdScale.find((s) => s.from === 'Strength').scale;
  const perInt = cdScale.find((s) => s.from === 'Intellect').scale;
  near('naked CritDamage = base + perStr*Str + perInt*Int',
    g('CritDamage'), baseStats(cdb, ctx, 'Priest', 25).get('CritDamage') + perStr * g('Strength') + perInt * g('Intellect'), 1e-9);

  near('naked MaxHealth = 3 * Vitality', g('MaxHealth'), 3 * g('Vitality'), 1e-9);
  ok('a naked character has no gear-only stats', g('Armor') === 0 && g('FervorRating') === 0);
  ok('primaries are rounded up', Number.isInteger(g('Faith')), String(g('Faith')));

  // Percent defaults come from the sheet, not from us.
  near('DamageModifier defaults to its sheet defVal',
    g('DamageModifier'), ctx.attrTable.byId.get('DamageModifier').defVal);

  // Fervor's two verified consumers, both straight out of attribute.scaling.
  const dressed = { ...naked, gear: {}, augments: {} };
  for (const slot of cat.combatSlots()) {
    const c = cat.candidates(slot.id, { aptitude: 'Cleric', charLevel: 25 })
      .find((x) => x.item.faction === 'Manfish');
    if (c) dressed.gear[slot.id] = { item: c.item.id, rarity: c.rarity, stars: cat.maxStars(c.item, c.rarity) };
  }
  // Naive slot filling can pair a two-hander with an offhand; the rule says no.
  pruneIllegal(cat, dressed);
  const dev = engine.evaluate(dressed);
  ok('Manfish gear gives a Priest Fervor', dev.sheet.get('FervorRating') > 0);
  near('DamageTakenModifier = 100 - 0.5*Fervor',
    dev.sheet.get('DamageTakenModifier'), 100 - 0.5 * dev.sheet.get('Fervor'), 1e-9);
  near('HealGivenMultiplier = 100 + Fervor',
    dev.sheet.get('HealGivenMultiplier'), 100 + dev.sheet.get('Fervor'), 1e-9);
  ok('gear produces armour', dev.sheet.get('Armor') > 0);

  // An arsenal weapon must be worth exactly affixFactor of a mainhand one.
  const wpn = cat.candidates('Slot_Weapon1', { aptitude: 'Cleric', charLevel: 25 })[0];
  const one = { ...naked, gear: { Slot_Weapon1: { item: wpn.item.id, rarity: wpn.rarity, stars: 0 } }, augments: {} };
  const two = { ...naked, gear: { Slot_Weapon2: { item: wpn.item.id, rarity: wpn.rarity, stars: 0 } }, augments: {} };
  const f1 = engine.evaluate(one).mods.flat.get('Faith') ?? 0;
  const f2 = engine.evaluate(two).mods.flat.get('Faith') ?? 0;
  near('Slot_Weapon2 contributes ceil(affixFactor) of Slot_Weapon1',
    f2, Math.ceil(f1 * cat.slotById.get('Slot_Weapon2').affixFactor), 1e-9);

  // Upgrade stars and rarity must both move the effective level by the
  // constants the game authors them with.
  const item = cat.itemById.get(wpn.item.id);
  const e0 = cat.effectiveLevel(item, { charLevel: 25, stars: 0 });
  const e1 = cat.effectiveLevel(item, { charLevel: 25, stars: 1 });
  near('one upgrade star adds Item_GearUpgradeILevelBonus/10 effective levels',
    e1 - e0, K.gearUpgradeILevelBonus / 10, 1e-9);
  near('flawless adds Item_FlawlessILevelBonus/10 effective levels',
    cat.effectiveLevel(item, { charLevel: 25, stars: 0, flawless: true }) - e0, K.flawlessILevelBonus / 10, 1e-9);
}

// --- checked against the game ----------------------------------------------
// The only readings this project has from the running game, and therefore the
// most valuable tests in the file. Spear_Eruption is Rare, Kobold faction,
// aptitudes [Assassin, Cleric]; the instance read in game is level 10, which
// with Rare's +10 iLevelBonus is effective level 11.
//
//   main hand:  +36 Vitality  +18 Dexterity  +15 Faith  +39 Critical  +39 ArPen
//   arsenal:    +15 Vitality   +8 Dexterity   +6 Faith  +16 Critical  +16 ArPen
//
// Three rules fall out of those ten numbers and all three are asserted here:
// every aptitude pays and they sum; each aptitude's share is rounded on its own
// before summing; and the arsenal factor is 0.4 with a CEILING.
group('checked against the game: Spear_Eruption');
{
  const engine = createEngine();
  const spear = cat.itemById.get('Spear_Eruption');
  ok('the item is still in the data', !!spear, 'Spear_Eruption');
  ok('and still Rare / Kobold / Assassin+Cleric',
    spear.rarity === 'Rare' && spear.faction === 'Kobold'
      && spear.aptitudes.join('+') === 'Assassin+Cleric',
    `${spear.rarity} ${spear.faction} ${spear.aptitudes.join('+')}`);

  // MEASURED, not inferred. A Cheese Moon photographed in game reads "Axe
  // Level 25" with THREE upgrade stars, and the Spear reproduces on the same
  // configuration. These used to be pinned at level 10 - a level nobody ever
  // read off a tooltip, chosen because the bake was missing gearRatio and the
  // aptitude divisor and level 10 is where those two errors happened to
  // cancel. That is the shape of a circular fit, and it hid a 25% error on
  // every geared character for as long as it stood.
  const INSTANCE_LEVEL = 25;
  const INSTANCE_STARS = 3;
  ok('a level-25 Rare instance at 3 stars is effective level 29',
    cat.effectiveLevel({ ...spear, iLevel: null },
      { charLevel: 25, stars: INSTANCE_STARS, level: INSTANCE_LEVEL }) === 29);

  const OBSERVED = {
    mainHand: { Vitality: 36, Dexterity: 18, Faith: 15, CritChanceRating: 39, ArmorPenetrationRating: 39 },
    arsenal: { Vitality: 15, Dexterity: 8, Faith: 6, CritChanceRating: 16, ArmorPenetrationRating: 16 },
  };

  // Those ten numbers are an ITEM TOOLTIP reading, and a tooltip has no wearer:
  // it shows what the row grants across both classes that may equip it. That is
  // the `allAptitudes` mode, and it still has to reproduce all ten exactly.
  for (const [slotId, want] of [['Slot_Weapon1', OBSERVED.mainHand], ['Slot_Weapon2', OBSERVED.arsenal]]) {
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    cat.contribute({ ...spear, iLevel: null }, slotId, {
      aptitude: 'Assassin', charLevel: 25, stars: INSTANCE_STARS, allAptitudes: true, level: INSTANCE_LEVEL,
      rarity: 'Rare', armorReduction: cat.armorReductionFor('Assassin'),
    }, mods);
    for (const [atb, v] of Object.entries(want)) {
      near(`${slotId} ${atb} matches the item tooltip`, mods.flat.get(atb) ?? 0, v, 1e-9);
    }
    // Nothing else should appear: no Strength, no Intellect, no Fervor.
    const extra = [...mods.flat.keys()].filter((k) => !(k in want));
    ok(`${slotId} grants nothing the tooltip does not show`, extra.length === 0, extra.join(', '));
  }

  // What a WEARER gets is EVERYTHING the tooltip shows - read off the
  // character sheet at last: a naked Warrior (Vit 38, Str 34, Dex 28) equips
  // Cheese Moon (Fighter+Assassin, +36/+15/+18 and both ratings) and the
  // sheet reads 74/49/46. So a Rogue holding this spear takes the Cleric
  // half too, and the wearer reading IS the tooltip reading.
  {
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    cat.contribute({ ...spear, iLevel: null }, 'Slot_Weapon1', {
      aptitude: 'Assassin', charLevel: 25, stars: INSTANCE_STARS, level: INSTANCE_LEVEL,
      rarity: 'Rare', armorReduction: cat.armorReductionFor('Assassin'),
    }, mods);
    for (const [atb, v] of Object.entries(OBSERVED.mainHand)) {
      near(`a Rogue wearer receives the whole ${atb} line`, mods.flat.get(atb) ?? 0, v, 1e-9);
    }
  }

  // PHOTOGRAPHED: "Cheese Moon - Axe Level 25" with three upgrade stars,
  // reading +36 Vitality / +15 Strength / +18 Dexterity / +39 Critical /
  // +39 Armor Penetration, on a Warrior. Its aptitudes are Fighter+Assassin
  // and the Warrior receives BOTH - Strength from the Fighter row, Dexterity
  // from the Assassin one - each divided by the two aptitudes the item names.
  {
    const axe = cat.itemById.get('Axe_Boomerang');
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    cat.contribute(axe, 'Slot_Weapon1', {
      aptitude: 'Fighter', charLevel: 25, stars: 3, level: 25,
      rarity: 'Rare', armorReduction: cat.armorReductionFor('Fighter'),
    }, mods);
    near('the Warrior receives the axe\'s Vitality line', mods.flat.get('Vitality') ?? 0, 36, 1e-9);
    near('...its Strength line', mods.flat.get('Strength') ?? 0, 15, 1e-9);
    near('...and the Assassin\'s Dexterity line too', mods.flat.get('Dexterity') ?? 0, 18, 1e-9);
    near('...and both ratings, which are gearOnly and so skip the gear ratio',
      mods.flat.get('CritChanceRating') ?? 0, 39, 1e-9);
    near('...both of them', mods.flat.get('ArmorPenetrationRating') ?? 0, 39, 1e-9);
  }

  // A DUAL-APTITUDE BELT, measured on the same character in four states
  // (naked / belt only / weapon only / both), which is what settled the
  // aptitude divisor and the armour term together. Fighter+Cleric, Demon
  // faction, and its Armor of 158 is the ITEM's aptitude mean (0.325) rather
  // than the Warrior's own 0.4 - which would have read 219.
  {
    const belt = cat.itemById.get('Waist_RDemon_FigCle');
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    cat.contribute({ ...belt, iLevel: null }, 'Slot_Waist', {
      aptitude: 'Fighter', charLevel: 25, stars: 0, level: 25,
      rarity: 'Rare', armorReduction: cat.armorReductionFor('Fighter'),
    }, mods);
    near('a dual-aptitude belt pays the Fighter half', mods.flat.get('Strength') ?? 0, 4, 1e-9);
    near('...and the Cleric half', mods.flat.get('Faith') ?? 0, 4, 1e-9);
    near('...and the Vitality both of them carry, once', mods.flat.get('Vitality') ?? 0, 8, 1e-9);
    near('...with Armour off the ITEM\'s aptitude mean, not the wearer\'s',
      mods.flat.get('Armor') ?? 0, 158, 1e-9);
  }

  // The two aptitudes read the same faction differently, which is what produces
  // two ratings from one item.
  const apts = cdb.byId('aptitude');
  const ratingFor = (aptId) => (apts.get(aptId).atbScaling ?? [])
    .filter((e) => (e.statGroup ?? 0) === 3 && (e.conds?.factions ?? []).some((f) => f.ref === 'Kobold'))
    .map((e) => e.endAtb);
  ok('Assassin reads Kobold as ArmorPenetration',
    ratingFor('Assassin').join() === 'ArmorPenetrationRating', ratingFor('Assassin').join());
  ok('Cleric reads Kobold as CritChance',
    ratingFor('Cleric').join() === 'CritChanceRating', ratingFor('Cleric').join());

  // And a Rare Corrupted Gift, -20/+20 in the main hand, reads -8/+8 in the
  // arsenal - the same ceil(v * 0.4) applied to an authored affix.
  const gift = cat.itemById.get('DemonGearUpgradeRare_FervToCrit');
  ok('the Rare Corrupted Gift is still +/-20', gift.affixes.every((a) => Math.abs(a.val) === 20));
  for (const [slotId, want] of [['Slot_Weapon1', 20], ['Slot_Weapon2', 8]]) {
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    const af = cat.slotById.get(slotId).affixFactor;
    cat.applyAffixes(gift.affixes, mods, af, af !== 1);
    near(`${slotId}: Corrupted Gift gives +${want} CritChanceRating`, mods.flat.get('CritChanceRating'), want, 1e-9);
    near(`${slotId}: and -${want} FervorRating`, mods.flat.get('FervorRating'), -want, 1e-9);
  }
}

// --- every aptitude pays ---------------------------------------------------
group('multi-aptitude items');
{
  const engine = createEngine();
  const multi = cat.items.find((i) => !i.isAugment && i.slots.length
    && i.aptitudes.length > 1 && cat.usableBy(i, 'Cleric')
    && (i.level == null || i.level <= 25)
    && i.slots.some((s) => cat.slotById.get(s)?.combat));
  ok('an item naming several aptitudes exists', !!multi, multi?.id);
  ok('no item mixes class and generic aptitudes',
    !cat.items.some((i) => {
      const classApts = new Set(cat.classes.map((c) => c.aptitude));
      return i.aptitudes.some((a) => classApts.has(a)) && i.aptitudes.some((a) => cat.isGeneric(a));
    }));

  // The constant the whole rule rests on: one item per core slot sums to
  // EXACTLY one budget in every stat group. If a patch moves these, the "one
  // aptitude pays" reading has to be re-derived rather than assumed.
  const CORE_SLOTS = ['Slot_Weapon1', 'Slot_Head', 'Slot_Shoulders', 'Slot_Chest', 'Slot_Back',
    'Slot_Hands', 'Slot_Waist', 'Slot_Legs', 'Slot_Feet', 'Slot_Neck', 'Slot_FingerLeft', 'Slot_FingerRight'];
  {
    const totals = { primary: 0, vitality: 0, armor: 0, ratings: 0 };
    for (const slotId of CORE_SLOTS) {
      const sample = cat.items.find((i) => !i.isAugment && i.slots.includes(slotId) && i.aptitudes.length);
      const r = cat.inherited(sample.type, (t) => t?.atbRatio) ?? {};
      for (const k of Object.keys(totals)) totals[k] += r[k] ?? 0;
    }
    for (const [group, v] of Object.entries(totals)) {
      near(`a full core set is exactly one ${group} budget`, v, 1, 1e-9);
    }
  }

  // A dual-aptitude item pays the wearer EVERYTHING it names - read off the
  // character sheet: naked Warrior 38/34/28 Vit/Str/Dex, Cheese Moon equipped
  // 74/49/46, every tooltip line including the Assassin half. ARMOUR is the
  // exception and pays once: its budget is the wearer's resistForReduction,
  // with no aptitude in it, so a second aptitude paying it would double the
  // one stat that cannot double.
  const slot = multi.slots.find((s) => cat.slotById.get(s)?.combat);
  const l = emptyLoadout(cat, 'Priest', 25);
  l.gear[slot] = { item: multi.id, rarity: multi.rarity, stars: 0 };
  const ev = engine.evaluate(l);
  const contributionOf = (item) => {
    const flat = new Map();
    cat.contribute(item, slot,
      { aptitude: 'Cleric', charLevel: 25, stars: 0, rarity: multi.rarity, armorReduction: 0.25 },
      { flat, addRatio: new Map(), mulRatio: new Map() });
    return flat;
  };
  const bothApt = contributionOf(multi);
  const clericOnly = contributionOf({ ...multi, aptitudes: ['Cleric'] });
  // A shared line is paid ONCE, at the mean, because every row is divided by
  // the number of aptitudes the item names. Two aptitudes carrying the same
  // Vitality row therefore give the same Vitality as one would - the second
  // aptitude buys you its own PRIMARY, not a doubled shared stat. The model
  // used to sum them, which read double on every dual-aptitude item in the
  // game and is what the Cheese Moon tooltip finally caught.
  ok(`${multi.id} pays a shared line ONCE, at the mean of its aptitudes`,
    (bothApt.get('Vitality') ?? 0) === (clericOnly.get('Vitality') ?? 0),
    `${bothApt.get('Vitality')} vs ${clericOnly.get('Vitality')} (${multi.aptitudes.join('+')})`);
  ok('and it grants the OTHER class\'s primary too',
    ['Strength', 'Dexterity', 'Intellect'].some((a) => bothApt.get(a)),
    [...bothApt.entries()].map(([k, v]) => k + '=' + v).join(' '));
  ok('but armour pays once whatever the aptitude count',
    (bothApt.get('Armor') ?? 0) === (clericOnly.get('Armor') ?? 0),
    `${bothApt.get('Armor')} vs ${clericOnly.get('Armor')}`);
  ok('and it grants at least one rating', ratingsOf(ev.sheet).length > 0, ratingsOf(ev.sheet).join(','));
  ok('every stat a full-factor slot grants is a whole number',
    [...bothApt.values()].every((v) => Number.isInteger(v)),
    [...bothApt.entries()].map(([k, v]) => k + '=' + v).join(' '));

  // The invariant that pins the rule end to end, and it holds for all four
  // classes: a class declares the damage reduction it is meant to reach in full
  // gear, and a level-appropriate Rare set has to land there. Paying two
  // aptitudes doubled the armour budget and put a Priest at 40% when its own
  // row says 25% - and, worse, put the Warrior at 58% when it says 40%.
  for (const cls of cat.classes) {
    const full = emptyLoadout(cat, cls.unit, 25);
    for (const slotId of CORE_SLOTS) {
      // SINGLE-aptitude pieces only. Armour resolves the ITEM's aptitude mean
      // (measured: a Fighter+Cleric belt reads 158 Armor on a Warrior, which is
      // 0.325 and not the Warrior's 0.4), so a set full of dual-aptitude pieces
      // lands BETWEEN two classes' declared values rather than on either. The
      // invariant belongs to gear matched to the wearer, which is what a class
      // reaching its own declared reduction means.
      const options = cat.candidates(slotId, { aptitude: cls.aptitude, charLevel: 25 })
        .filter((x) => x.item.aptitudes.includes(cls.aptitude))
        .filter((x) => x.item.aptitudes.length === 1);
      // An item with no authored level drops at the character's level, which is
      // what "a full set at 25" means.
      const c = options.find((x) => x.item.level == null && x.item.iLevel == null && x.rarity === 'Rare')
        ?? options[options.length - 1];
      if (c) full.gear[slotId] = { item: c.item.id, rarity: c.rarity, stars: 0, generic: c.generic ?? null };
    }
    pruneIllegal(cat, full);
    const sv = engine.evaluate(full).survivability;
    const want = cdb.byId('aptitude').get(cls.aptitude).props.armorReduction;
    ok(`a full set lands ${cls.unit} on its own declared armour reduction`,
      Math.abs(sv.physReduction - want) < 0.04,
      `${(sv.physReduction * 100).toFixed(1)}% vs the declared ${(want * 100).toFixed(0)}%`);
  }

  // Craft jewellery names several generic aptitudes and pays ALL of them, each
  // divided by how many it names - the same rule as every other aptitude.
  // Measured against the game's own `generateItemAffixes` return, logged for
  // this exact necklace at iLevel 210: Vit 4, and 11 on each of the four
  // ratings. The old reading paid one and called the other three a choice; the
  // "46 rating, not 184" measurement it rested on is the 11+11+11+11 = 44.
  {
    const pendant = cat.itemById.get('Necklace_Z2RCraft');
    ok('the four-generic craft necklace is still in the data',
      pendant && pendant.aptitudes.length === 4,
      pendant ? pendant.aptitudes.join('+') : 'Necklace_Z2RCraft missing');
    ok('...and there is no generic choice left to make',
      cat.genericChoices(pendant).length === 0,
      JSON.stringify(cat.genericChoices(pendant)));
    const variants = cat.candidates('Slot_Neck', { aptitude: 'Cleric', charLevel: 25 })
      .filter((c) => c.item.id === 'Necklace_Z2RCraft');
    ok('so it appears exactly once as a candidate', variants.length === 1,
      variants.map((v) => v.generic).join(', '));

    // The logged bake, to the integer. `effectiveLevel` adds the Rare bonus to
    // level*10, so the instance level is handed in net of it to land on 210.
    const bonus = cdb.byId('rarity').get('Rare')?.props?.iLevelBonus ?? 0;
    const got = new Map();
    cat.contribute(pendant, 'Slot_Neck',
      { aptitude: 'Cleric', charLevel: 25, stars: 0, rarity: 'Rare', armorReduction: 0.25,
        level: (210 - bonus) / 10 },
      { flat: got, addRatio: new Map(), mulRatio: new Map() });
    const WANT = { Vitality: 4, CritChanceRating: 11, ArmorPenetrationRating: 11,
      SpellPenetrationRating: 11, FervorRating: 11 };
    for (const [k, v] of Object.entries(WANT)) {
      near(`Pendant of Adaptability pays ${k} ${v}`, got.get(k) ?? 0, v, 1e-9);
    }
    ok('...and all four ratings, not one', ratingsOf(got).length === 4,
      [...got.entries()].map(([k, v]) => k + '=' + v).join(' '));
  }
}

function ratingsOf(sheet) {
  return ['CritChanceRating', 'FervorRating', 'ArmorPenetrationRating', 'SpellPenetrationRating']
    .filter((r) => (sheet.get(r) ?? 0) > 0);
}

// --- rarity ----------------------------------------------------------------
group('drop rarity');
{
  const it = cat.itemById.get('Chest_RManfish_Cle');
  ok('a Rare item exists to test with', it && it.rarity === 'Rare');
  const att = cat.attainableRarities(it, 25);
  ok('a Rare item can roll better than authored', att.some((r) => r.rarity === 'Epic'), JSON.stringify(att));
  ok('a Rare item can never roll worse than authored',
    !att.some((r) => (cat.rarityOrder.get(r.rarity) ?? 0) < (cat.rarityOrder.get('Rare') ?? 0)));
  ok('every non-authored rarity carries its drop chance',
    att.filter((r) => !r.authored).every((r) => r.chance > 0), JSON.stringify(att));
  // Upgrade stars are a WEAPON mechanic. The game's own window text says so
  // ("You can upgrade weapons to increase their Attributes and gain access to
  // a unique effect"), and the twenty `<itemType>_Upgrade` skills exist for
  // weapon itemTypes only. Reading rarity.props.gearUpgrades alone put three
  // stars on every armour piece, which is 30 iLevel of stats no character can
  // have.
  const weapon = cat.items.find((i) => i.slots.includes('Slot_Weapon1') && cat.canUpgrade(i));
  ok('a weapon can be upgraded', !!weapon, 'no upgradable mainhand found');
  ok('a better rarity allows more upgrade stars',
    cat.maxStars(weapon, 'Legendary') > cat.maxStars(weapon, 'Rare'),
    `${weapon?.id}: Legendary ${cat.maxStars(weapon, 'Legendary')} vs Rare ${cat.maxStars(weapon, 'Rare')}`);
  ok('armour cannot be upgraded at any rarity',
    cat.maxStars(it, 'Legendary') === 0 && cat.maxStars(it, 'Rare') === 0,
    `${it.id}: ${cat.maxStars(it, 'Legendary')} / ${cat.maxStars(it, 'Rare')}`);
  ok('every upgradable item is a weapon',
    cat.items.filter((i) => !i.isAugment && cat.canUpgrade(i)).every((i) => i.chain.includes('Weapon')),
    cat.items.filter((i) => !i.isAugment && cat.canUpgrade(i) && !i.chain.includes('Weapon'))
      .map((i) => i.id).join(', '));
  // The one explicit override in the data.
  const starter = cat.itemById.get('Sword_Start');
  ok('a PreventUpgrade weapon cannot be upgraded', starter && cat.maxStars(starter, 'Legendary') === 0,
    starter ? String(cat.maxStars(starter, 'Legendary')) : 'Sword_Start missing');
}

// --- hit counts, areas and the fight ---------------------------------------
// Everything in this group used to read as exactly one hit on exactly one
// target, which is why the tool's dps sat at a third of what a meter shows.
group('hit counts and areas');
{
  const engine = createEngine();

  // A step that loops fires once per tick, over its own duration.
  const spin = engine.combat.profile('GS_Nova_Skill1', 3);
  const spinHits = spin.effects.filter((e) => e.kind === 'Damage').reduce((s, e) => s + e.hits, 0);
  ok('a looping area counts every tick', spinHits > 10, `${spinHits} hits`);

  // A projectile combo lands its effect once per projectile.
  const bolts = engine.combat.profile('Staff_Censer_Combo', 3);
  const bolt = bolts.effects.find((e) => e.kind === 'Damage' && e.scaling.length);
  ok('a four-bolt combo counts four hits', bolt?.hits === 4, `${bolt?.hits} hits`);

  // `area.targetCooldown` caps re-hits on the same target: Smite ticks fifteen
  // times and may only touch a given enemy once.
  const smite = engine.combat.profile('Priest_Prayer_Smite', 3);
  const smiteHits = smite.effects.filter((e) => e.kind === 'Damage').reduce((s, e) => s + e.hits, 0);
  ok('targetCooldown stops a sweep counting as fifteen hits', smiteHits === 1, `${smiteHits} hits`);

  // A vars key in a numeric column must resolve, not read as zero.
  ok('a duration given as a vars key resolves',
    engine.combat.profile('Shield_Firebreath_Skill1', 3).occupancy > 3,
    String(engine.combat.profile('Shield_Firebreath_Skill1', 3).occupancy));

  // Only Area and Aura steps scale with the target count.
  const sheetOf = (targets) => {
    const eng = createEngine({ fight: { targets } });
    const l = emptyLoadout(cat, 'Priest', 25);
    l.gear.Slot_Weapon1 = { item: 'Staff_Censer', rarity: 'Rare', stars: 0 };
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { rank: 3 }).throughput.dps;
  };
  const one = sheetOf(1), three = sheetOf(3);
  ok('more targets is more damage', three > one, `${one.toFixed(1)} -> ${three.toFixed(1)}`);
  ok('but not linearly, because single-target lines do not scale',
    three < one * 3, `${one.toFixed(1)} -> ${three.toFixed(1)}`);

  // The arsenal grants no base-attack chain, so it must not raise WeaponPower.
  const cls = cat.classes.find((c) => c.unit === 'Priest');
  const base = { class: 'Priest', level: 25, gear: { Slot_Weapon1: { item: 'Staff_Censer', rarity: 'Rare', stars: 0 } }, augments: {} };
  const withArsenal = { ...base, gear: { ...base.gear, Slot_Weapon2: { item: 'Staff_Censer', rarity: 'Rare', stars: 0 } } };
  near('an arsenal weapon does not raise WeaponPower',
    engine.combat.weaponPowerFor(cat, withArsenal, cls),
    engine.combat.weaponPowerFor(cat, base, cls), 1e-9);
}

// --- the fight -------------------------------------------------------------
group('the fight simulation');
{
  const engine = createEngine();
  const rogue = emptyLoadout(cat, 'Rogue', 25);
  rogue.gear.Slot_Weapon1 = { item: 'Daggers_Start', rarity: 'Rare', stars: 0 };
  engine.plan.pruneSelection(rogue);

  // A charge is a banked cast: it buys (charges - 1) extra casts over a fight
  // and changes nothing about the sustained rate. Rogue_KnivesTempest is 2
  // charges on a 30s cooldown, and its M1 rune makes that 3.
  const castsIn = (seconds, rune) => {
    const eng = createEngine({ fight: { seconds } });
    const l = JSON.parse(JSON.stringify(rogue));
    if (rune) l.runes = { Rogue_KnivesTempest: rune };
    const line = eng.evaluate(l, { rank: 3 }).throughput.lines.find((x) => x.id === 'Rogue_KnivesTempest');
    return line ? Math.round(seconds / line.interval) : 0;
  };
  const short2 = castsIn(30, null), short3 = castsIn(30, 'Rogue_KnivesTempest_M1');
  ok('a charged skill opens the fight with its whole bank', short2 === 2, `${short2} casts in 30s`);
  ok('and an extra charge is an extra cast', short3 === short2 + 1, `${short3} vs ${short2}`);
  const long2 = castsIn(200, null), long3 = castsIn(200, 'Rogue_KnivesTempest_M1');
  ok('over a long fight the extra charge is worth exactly one more cast',
    long3 === long2 + 1, `${long3} vs ${long2}`);

  // The denominator is the fight, not the moment of the last cast. Getting this
  // wrong made a build with no main-hand weapon beat one holding a sword.
  const naked = emptyLoadout(cat, 'Priest', 25);
  const nakedDps = engine.evaluate(naked, { rank: 3 }).throughput.dps;
  const armed = JSON.parse(JSON.stringify(naked));
  armed.gear.Slot_Weapon1 = { item: 'Staff_Censer', rarity: 'Rare', stars: 0 };
  engine.plan.pruneSelection(armed);
  ok('holding a weapon beats holding nothing',
    engine.evaluate(armed, { rank: 3 }).throughput.dps > nakedDps,
    `${nakedDps.toFixed(1)} naked`);

  // Rolling the procs must produce the same mean and a real spread.
  const rolled = createEngine({ fight: { count: 200 } }).evaluate(armed, { rank: 3 }).throughput;
  const flat = engine.evaluate(armed, { rank: 3 }).throughput;
  ok('rolling the procs reproduces the expected-value mean',
    Math.abs(rolled.dps - flat.dps) < flat.dps * 0.08,
    `${flat.dps.toFixed(1)} expected vs ${rolled.dps.toFixed(1)} rolled`);
  ok('and reports a spread rather than pretending there is none',
    rolled.dpsSd > 0, String(rolled.dpsSd));
}

// --- dependency order ------------------------------------------------------
// The two things a priority list cannot do, on synthetic rotations where the
// right answer is arithmetic rather than opinion. SimulationCraft solves both
// with a human-authored APL and explicitly does no search; nobody authors those
// for this game, so a bounded rollout stands in for one.
group('rotation dependency order');
{
  const AMP = {
    status: 'Amp', duration: 4, stacks: 1,
    affixes: [{ target: { attribute: 'DamageTakenModifier' }, ref: 'TAttribute_ARatio', val: 1 }],
  };
  const prof = (id, cooldown, occ) => ({
    id, name: id, cooldown, occupancy: occ, charges: 1, isCombo: false, type: 'ClassSkill',
  });
  const cast = (p, state) => {
    const amped = state && state.key.includes('!Amp');
    if (p.id.startsWith('Nuke')) return { damage: amped ? 2000 : 1000, heal: 0, shield: 0 };
    if (p.id === 'Swing') return { damage: 10, heal: 0, shield: 0 };
    return { damage: 0, heal: 0, shield: 0 };   // the setup emits nothing at all
  };
  const dotOutput = () => ({ damage: 0, heal: 0 });
  const run = (rotation, lookahead) => simulate({ rotation, cast, dotOutput, fight: 120, lookahead });

  // 1. X debuffs the target so Y hits harder. Greedy sorts by damage per second
  // of commitment, so the setup - which does no damage at all - always loses
  // and its window is always wasted.
  {
    const rotation = {
      active: [
        { prof: prof('Setup', 12, 1), source: 't', applies: { self: [], target: [AMP] } },
        { prof: prof('Nuke', 12, 1), source: 't', applies: { self: [], target: [] } },
      ],
      filler: [{ prof: prof('Swing', 0, 1), applies: { self: [], target: [] } }],
      triggered: [], passive: [], dots: [], unmodelled: [], runes: [], rank: 3,
    };
    const greedy = run(rotation, 0);
    const ahead = run(rotation, 8);
    const perCast = (r) => r.lines.find((l) => l.id === 'Nuke')?.perCast.damage ?? 0;
    near('greedy wastes the setup entirely', perCast(greedy), 1000, 1);
    near('a lookahead casts the setup first', perCast(ahead), 2000, 1);
    ok('and that is worth most of the build', ahead.dps > greedy.dps * 1.5,
      `${greedy.dps.toFixed(1)} -> ${ahead.dps.toFixed(1)}`);
  }

  // 2. Two cooldowns and one window. Both should land inside it; greedy fires
  // whichever is ready the moment it is ready and never lines them up.
  {
    const rotation = {
      active: [
        { prof: prof('Setup', 10, 1), source: 't', applies: { self: [], target: [{ ...AMP, duration: 5 }] } },
        { prof: prof('NukeA', 10, 1), source: 't', applies: { self: [], target: [] } },
        { prof: prof('NukeB', 10, 1), source: 't', applies: { self: [], target: [] } },
      ],
      filler: [{ prof: prof('Swing', 0, 1), applies: { self: [], target: [] } }],
      triggered: [], passive: [], dots: [], unmodelled: [], runes: [], rank: 3,
    };
    const greedy = run(rotation, 0);
    const ahead = run(rotation, 8);
    const both = (r) => ['NukeA', 'NukeB'].every((id) =>
      Math.abs((r.lines.find((l) => l.id === id)?.perCast.damage ?? 0) - 2000) < 1);
    ok('greedy lands neither cooldown in the window', !both(greedy),
      `${greedy.dps.toFixed(1)} dps`);
    ok('a lookahead lands both', both(ahead), `${ahead.dps.toFixed(1)} dps`);
  }

  // The lookahead must never make the answer worse: it is a search over the
  // same rotation, and 0 is one of the options it considers.
  {
    const rotation = {
      active: [
        { prof: prof('NukeA', 8, 1), source: 't', applies: { self: [], target: [] } },
        { prof: prof('NukeB', 14, 1), source: 't', applies: { self: [], target: [] } },
      ],
      filler: [{ prof: prof('Swing', 0, 1), applies: { self: [], target: [] } }],
      triggered: [], passive: [], dots: [], unmodelled: [], runes: [], rank: 3,
    };
    ok('with nothing to sequence, a lookahead changes nothing',
      Math.abs(run(rotation, 8).dps - run(rotation, 0).dps) < 1e-6,
      `${run(rotation, 0).dps.toFixed(3)} vs ${run(rotation, 8).dps.toFixed(3)}`);
  }
}

// --- live state ------------------------------------------------------------
group('the fight holds state');
{
  const engine = createEngine();
  const build = {
    class: 'Priest', level: 25, augments: {}, skills: {}, runes: {}, talents: {},
    gear: { Slot_Weapon1: { item: 'Sword_Swarm', rarity: 'Legendary', stars: 5 } },
  };
  engine.plan.pruneSelection(build);
  const rot = engine.plan.resolve(build, 3);

  // `Sword_Swarm_Skill1` strips 40% of the target's MagicArmor for 10 seconds.
  const debuffed = [...rot.active, ...rot.filler]
    .flatMap((x) => x.applies?.target ?? []);
  ok('a cast carries the debuff it puts on the target',
    debuffed.some((d) => d.status === 'Sword_Swarm_Skill1_Status'),
    debuffed.map((d) => d.status).join(', ') || '(none)');

  // And it is worth something, which it was not while the target was a constant.
  const withDebuff = engine.evaluate(build, { target: engine.combat.foe('boss', 25), rank: 3 })
    .throughput.dps;
  const blind = createEngine();
  const inner = blind.plan.resolve;
  blind.plan.resolve = (...a) => {
    const r = inner(...a);
    for (const x of [...r.active, ...r.filler, ...r.triggered]) {
      if (x.applies) x.applies = { self: x.applies.self, target: [] };
    }
    return r;
  };
  const without = blind.evaluate(build, { target: blind.combat.foe('boss', 25), rank: 3 })
    .throughput.dps;
  ok('and stripping the target\'s armour raises the damage that follows it',
    withDebuff > without, `${without.toFixed(2)} blind vs ${withDebuff.toFixed(2)} live`);
}

// --- damage over time ------------------------------------------------------
group('statuses that tick');
{
  const engine = createEngine();
  const l = emptyLoadout(cat, 'Priest', 25);
  l.gear.Slot_Weapon1 = { item: 'Sword_Swarm', rarity: 'Rare', stars: 0 };
  engine.plan.pruneSelection(l);
  const rot = engine.plan.resolve(l, 3);

  const swarm = rot.dots.find((d) => d.status === 'Sword_Swarm_Passive_Swarm');
  ok('a damage aura applied by a script is found', !!swarm,
    rot.dots.map((d) => d.status).join(', '));
  ok('with its lifetime and tick out of the data',
    swarm?.duration === 10 && swarm?.tick === 1, `${swarm?.duration}s / ${swarm?.tick}s`);
  ok('and the event its guard names', swarm?.on === 'weapon-skill', String(swarm?.on));

  const ev = engine.evaluate(l, { rank: 3 });
  const line = ev.throughput.lines.find((x) => x.id === 'Sword_Swarm_Passive_Swarm');
  ok('it ticks during the fight', !!line, ev.throughput.lines.map((x) => x.id).join(', '));
  // Ten ticks of 0.12*(Strength + Faith), not one lump of ten times that.
  const perTick = (line?.perCast.damage ?? 0) / 199;
  const raw = 0.12 * ((ev.sheet.get('Strength') ?? 0) + (ev.sheet.get('Faith') ?? 0));
  ok('at its per-tick amount, not its whole-lifetime amount',
    perTick > raw * 0.2 && perTick < raw * 3,
    `${perTick.toFixed(1)} per tick against a raw ${raw.toFixed(1)}`);

  // A status applied "on every damage instance you deal" used to be a refusal;
  // it is a FLOOR now - the swing-and-finisher clock, stated as such - because
  // onInflictDamage with no predicate is an event the fight raises at least
  // that often. The Swarm's rank-3 poison is the shape: 25% per Swarm hit in
  // game, priced at 25% per swing/finisher here, and the capture holds 39 live
  // ticks of it that the refusal was worth exactly nothing against.
  {
    const poison = rot.dots.find((d) => d.status === 'Sword_Swarm_Passive_Poison');
    ok('an inflict-gated status is floored to the swing clock, not refused',
      !!poison && poison.on === 'attack-or-combo' && poison.chance === 0.25,
      poison ? `on=${poison.on} chance=${poison.chance}` : rot.unmodelled.map((u) => u.id).join(', '));
    ok('...and it no longer sits in the refusal list',
      !rot.unmodelled.some((u) => u.id === 'Sword_Swarm_Passive_Poison'));
  }

  // A buff on a two-minute cooldown is not a permanent buff.
  const fervor = engine.evaluate(l, { rank: 3 }).buffs
    .find((b) => b.status === 'Priest_BlessingOfFervor_Status');
  ok('a self-buff is credited at duration/cooldown, not at 100%',
    fervor && fervor.uptime > 0 && fervor.uptime < 0.3,
    fervor ? `uptime ${(fervor.uptime * 100).toFixed(0)}%` : 'buff not found');
  ok('and it is a buff on YOU, not a debuff on the target',
    fervor?.affixes.some((a) => a.target.attribute === 'Fervor'),
    JSON.stringify(fervor?.affixes?.map((a) => a.target.attribute)));

  // An op-2 dynVal ADDS the script's growth to the authored value, and a
  // fresh instance reads dynVal 0 - so the authored +10 CritChance is a floor
  // the model credits, at ONE stack (maxStacks 300 is the growth channel, not
  // a stack count), with the growth itself still refused and flagged.
  const crusader = engine.plan.statusesOf('Priest_Crusader', { rank: 3 });
  const crusaderSelf = crusader.self.find((x) => x.status === 'Priest_Crusader_Status');
  ok('an op-2 dynVal status is credited at its authored floor, one stack',
    !!crusaderSelf && crusaderSelf.stacks === 1 && crusaderSelf.growthRefused === true
      && crusaderSelf.affixes.some((a) => a.target?.attribute === 'CritChance' && a.val === 10)
      && !crusader.unreadable.some((x) => x.status === 'Priest_Crusader_Status'),
    JSON.stringify({ self: crusader.self.map((x) => ({ id: x.status, stacks: x.stacks })), no: crusader.unreadable.map((x) => x.status) }));
  // The other dynVal ops still mean "the authored number is not the value":
  // op 0 multiplies by a script-set factor that starts at 0. Those stay out.
  const waterCombo = engine.plan.statusesOf('DA_Water_Combo', { rank: 3 });
  ok('an op-0 dynVal status stays refused',
    !waterCombo.self.length || waterCombo.self.every((x) => !x.affixes.some((a) => a.mod?.dynVal)),
    JSON.stringify(waterCombo.self.map((x) => x.status)));
}

// --- the optimiser ---------------------------------------------------------
group('optimiser');
{
  const engine = createEngine();
  const seed = emptyLoadout(cat, 'Priest', 25);
  const target = engine.combat.foe('reference', 25);

  const runOnce = (extra = {}) => optimize(engine, {
    loadout: JSON.parse(JSON.stringify(seed)), goal: 'dps', target, rank: 3, restarts: 2, ...extra,
  });

  const a = runOnce();
  // Every slot except possibly the offhand, which a two-handed mainhand
  // legitimately forbids.
  const filled = Object.keys(a.loadout.gear);
  const unfilled = cat.combatSlots().map((s) => s.id).filter((id) => !filled.includes(id));
  ok('the optimiser fills every slot it legally can',
    unfilled.every((id) => id === 'Slot_OffhandWeapon'), unfilled.join(', '));
  ok('the optimiser fills augment sockets', Object.keys(a.loadout.augments).length > 0);
  ok('the result beats a naked character', a.evaluation.throughput.dps > engine.evaluate(seed).throughput.dps);

  // Handedness: a two-handed mainhand must never coexist with an offhand.
  ok('no offhand alongside a two-handed mainhand', !illegalReason(cat, a.loadout),
    illegalReason(cat, a.loadout) ?? '');

  // Pinning a shield must force the mainhand to be one-handed.
  const shieldSeed = JSON.parse(JSON.stringify(seed));
  const shield = cat.candidates('Slot_OffhandWeapon', { aptitude: 'Cleric', charLevel: 25 })[0];
  ok('a shield exists to test handedness with', !!shield);
  shieldSeed.gear.Slot_OffhandWeapon = { item: shield.item.id, rarity: shield.rarity, stars: 0 };
  const withShield = optimize(engine, {
    loadout: shieldSeed, goal: 'dps', target, rank: 3, restarts: 1,
    pinnedGear: new Set(['Slot_OffhandWeapon']),
  });
  ok('a pinned shield survives', withShield.loadout.gear.Slot_OffhandWeapon?.item === shield.item.id);
  ok('a pinned shield forces a one-handed mainhand',
    cat.allowsOffhand(cat.itemById.get(withShield.loadout.gear.Slot_Weapon1.item)),
    `${withShield.loadout.gear.Slot_Weapon1.item} is ${cat.handednessOf(cat.itemById.get(withShield.loadout.gear.Slot_Weapon1.item))}`);
  ok('the shield build is still legal', !illegalReason(cat, withShield.loadout));

  // Pinning both a two-hander and a shield is a contradiction and must say so.
  const twoHander = cat.items.find((i) => i.slots.includes('Slot_Weapon1') && !cat.allowsOffhand(i)
    && cat.usableBy(i, 'Cleric') && (i.level == null || i.level <= 25));
  let threw = null;
  try {
    optimize(engine, {
      loadout: {
        ...JSON.parse(JSON.stringify(seed)),
        gear: {
          Slot_Weapon1: { item: twoHander.id, rarity: twoHander.rarity, stars: 0 },
          Slot_OffhandWeapon: { item: shield.item.id, rarity: shield.rarity, stars: 0 },
        },
      },
      goal: 'dps', target, rank: 3, restarts: 1,
      pinnedGear: new Set(['Slot_Weapon1', 'Slot_OffhandWeapon']),
    });
  } catch (e) { threw = e.message; }
  ok('pinning a two-hander and a shield together is refused', !!threw, threw ?? 'no error raised');

  const b = runOnce();
  ok('the optimiser is deterministic', JSON.stringify(a.loadout) === JSON.stringify(b.loadout));

  // Pinning: the pinned slot must survive untouched, and its sockets too.
  const pinnedSeed = JSON.parse(JSON.stringify(seed));
  const wpn = cat.candidates('Slot_Weapon1', { aptitude: 'Cleric', charLevel: 25 })
    .find((c) => cat.itemById.get(c.item.id).skills.length > 0);
  pinnedSeed.gear.Slot_Weapon1 = { item: wpn.item.id, rarity: wpn.rarity, stars: 1 };
  const c = optimize(engine, {
    loadout: pinnedSeed, goal: 'dps', target, rank: 3, restarts: 2,
    pinnedGear: new Set(['Slot_Weapon1']),
    pinnedAug: new Set(['Slot_Weapon1/AugmentEnchantWeapon', 'Slot_Weapon1/AugmentDemon']),
  });
  ok('a pinned item is not replaced', c.loadout.gear.Slot_Weapon1.item === wpn.item.id,
    JSON.stringify(c.loadout.gear.Slot_Weapon1));
  ok('pinned upgrade stars are not raised', c.loadout.gear.Slot_Weapon1.stars === 1,
    String(c.loadout.gear.Slot_Weapon1.stars));
  ok('a pinned-empty socket stays empty',
    !c.loadout.augments['Slot_Weapon1/AugmentEnchantWeapon'] && !c.loadout.augments['Slot_Weapon1/AugmentDemon'],
    JSON.stringify(c.loadout.augments));
  ok('other slots were still optimised', Object.keys(c.loadout.gear).length === cat.combatSlots().length);

  // A different goal must produce a different answer, or the objective is not
  // actually reaching the search.
  const d = runOnce({ goal: 'ehp' });
  ok('a different goal changes the build', JSON.stringify(d.loadout.gear) !== JSON.stringify(a.loadout.gear));
  ok('optimising ehp beats the dps build on ehp',
    d.evaluation.survivability.ehp >= a.evaluation.survivability.ehp - 1e-6,
    `${d.evaluation.survivability.ehp} vs ${a.evaluation.survivability.ehp}`);
  ok('optimising dps beats the ehp build on dps',
    a.evaluation.throughput.dps >= d.evaluation.throughput.dps - 1e-6);

  // Dropping the unverified Fervor multiplier must change the numbers - that is
  // the whole reason it is a switch. Asserted on the same build under both
  // readings rather than on two searches, so the check is deterministic.
  const noFervor = createEngine({ assume: { fervorScope: 'none' } });
  const withFervor = createEngine({ assume: { fervorScope: 'all' } });
  // Build one deliberately: Crimson gear is what pays a Priest in Fervor.
  const fervorBuild = JSON.parse(JSON.stringify(seed));
  for (const slot of cat.combatSlots()) {
    const c = cat.candidates(slot.id, { aptitude: 'Cleric', charLevel: 25 })
      .find((x) => x.item.faction === 'Crimson');
    if (c) fervorBuild.gear[slot.id] = { item: c.item.id, rarity: c.rarity, aptitude: c.aptitude, stars: 0 };
  }
  pruneIllegal(cat, fervorBuild);
  const dpsOn = withFervor.evaluate(fervorBuild, { target: withFervor.combat.foe('reference', 25), rank: 3 });
  const dpsOff = noFervor.evaluate(fervorBuild, { target: noFervor.combat.foe('reference', 25), rank: 3 });
  ok('a Crimson Priest build actually has Fervor', (dpsOn.sheet.get('Fervor') ?? 0) > 5,
    String(dpsOn.sheet.get('Fervor')));
  ok('the Fervor scope changes the damage of a Fervor build',
    dpsOn.throughput.dps > dpsOff.throughput.dps * 1.01,
    `${dpsOn.throughput.dps.toFixed(1)} vs ${dpsOff.throughput.dps.toFixed(1)}`);

  // Before the rotation was modelled, base attacks were the only damage, Fervor
  // was the only multiplier that touched them, and the search dressed a Priest
  // entirely in Fervor gear. The guard against regressing to that used to be
  // "penetration rating must exceed Fervor rating", which was a proxy - and it
  // is a proxy that reads BACKWARDS. Fervor's assumed scope is `skills`, so a
  // build whose damage comes from its rotation wants Fervor and a build that
  // just swings wants penetration. The proxy therefore fails exactly when the
  // rotation gets MORE prominent, which is the opposite of what it was watching
  // for. So assert the thing itself: the skills have to carry a real share.
  const byKind = (k) => a.evaluation.throughput.lines
    .filter((l) => l.kind === k)
    .reduce((s, l) => s + l.perCast.damage / l.interval, 0);
  const fromSkills = byKind('active') + byKind('triggered');
  const totalDamage = fromSkills + byKind('filler');
  // The threshold moved with the WeaponPower calibration: swings priced off
  // the full budget carry most of a fight, and in game they visibly do. The
  // guard is against skills contributing NOTHING, not against strong swings.
  ok('skills carry a real share of the damage, not just the base-attack chain',
    totalDamage > 0 && fromSkills / totalDamage > 0.1,
    `skills ${fromSkills.toFixed(1)} of ${totalDamage.toFixed(1)} dps`);
  ok('the rotation contains skills the character pressed',
    a.evaluation.rotation.active.length > 0,
    `active: ${a.evaluation.rotation.active.map((x) => x.prof.id).join(', ')}`);

  // Exclusions must actually exclude.
  const f = runOnce({ exclude: /^GM_/ });
  ok('excluded ids never appear',
    !Object.values(f.loadout.gear).some((g) => /^GM_/.test(g.item)));
}

// --- skill selection -------------------------------------------------------
group('skill selection');
{
  const engine = createEngine();
  const target = engine.combat.foe('reference', 25);
  const seed = emptyLoadout(cat, 'Priest', 25);

  // The 2-of-3 restriction is the ARSENAL's, not the main hand's: in game the
  // main hand grants every skill it has plus the combo attack, while the
  // arsenal grants exactly two, and the weapon passive counts against those two.
  const three = cat.items.find((i) => i.slots.includes('Slot_Weapon2')
    && cat.usableBy(i, 'Cleric') && (i.level == null || i.level <= 25)
    && i.skills.filter((s) => ['WeaponSkill', 'WeaponPassive'].includes(engine.plan.typeOf(s))).length >= 3);
  ok('a weapon offering three arsenal skills exists', !!three, three?.id);

  const l = JSON.parse(JSON.stringify(seed));
  l.gear.Slot_Weapon2 = { item: three.id, rarity: three.rarity, stars: 0 };
  engine.plan.pruneSelection(l);
  const pools = engine.plan.pools(l);
  const wp = pools.find((p) => p.key === 'Slot_Weapon2');
  ok('the arsenal pool is discovered', !!wp);
  ok('it offers more than it can slot', wp.options.length > wp.slots, `${wp.options.length} options, ${wp.slots} slots`);
  ok('slot count comes from UnlockLevel_Arsenal',
    wp.slots === Math.min(engine.plan.arsenalSlotsAt(25), wp.options.length), String(wp.slots));
  ok('the arsenal pool includes the weapon passive',
    wp.options.some((id) => engine.plan.typeOf(id) === 'WeaponPassive'),
    wp.options.map((id) => engine.plan.typeOf(id)).join(','));

  // The main hand's pool covers only its WeaponSkills; its passive is free.
  const mh = JSON.parse(JSON.stringify(seed));
  mh.gear.Slot_Weapon1 = { item: three.id, rarity: three.rarity, stars: 0 };
  engine.plan.pruneSelection(mh);
  const mhPool = engine.plan.pools(mh).find((p) => p.key === 'Slot_Weapon1');
  ok('the main-hand pool excludes the weapon passive',
    !mhPool.options.some((id) => engine.plan.typeOf(id) === 'WeaponPassive'),
    mhPool.options.map((id) => engine.plan.typeOf(id)).join(','));
  const mhRot = engine.plan.resolve(mh, 3);
  ok('and the main-hand passive is active anyway',
    [...mhRot.triggered, ...mhRot.passive].some((x) => engine.plan.typeOf(x.prof.id) === 'WeaponPassive')
      || mhRot.unmodelled.some((u) => engine.plan.typeOf(u.id) === 'WeaponPassive'),
    'the passive should be resolved, not dropped');
  ok('the main hand supplies the base-attack chain', mhRot.filler.length > 0);
  ok('fewer slots at a lower level', engine.plan.weaponSlotsAt(1) < engine.plan.weaponSlotsAt(25),
    `${engine.plan.weaponSlotsAt(1)} vs ${engine.plan.weaponSlotsAt(25)}`);
  ok('the arsenal has no slots before its first unlock level', engine.plan.arsenalSlotsAt(1) === 0,
    String(engine.plan.arsenalSlotsAt(1)));

  // Which two you take must change the answer, or the choice is not reaching
  // the objective.
  const scores = new Set();
  for (let i = 0; i < wp.options.length; i++) {
    for (let j = i + 1; j < wp.options.length; j++) {
      const t = JSON.parse(JSON.stringify(l));
      t.skills = { Slot_Weapon2: [wp.options[i], wp.options[j]] };
      scores.add(engine.evaluate(t, { target, rank: 3 }).throughput.dps.toFixed(4));
    }
  }
  ok('different skill picks give different damage', scores.size > 1, `${scores.size} distinct results`);

  // The search must make that choice, and pinning must override it.
  const opt = optimize(engine, {
    loadout: JSON.parse(JSON.stringify(l)), goal: 'dps', target, rank: 3, restarts: 1,
    pinnedGear: new Set(['Slot_Weapon2']),
  });
  ok('the search fills the skill selection', (opt.loadout.skills?.Slot_Weapon2 ?? []).length === wp.slots,
    JSON.stringify(opt.loadout.skills));
  ok('every chosen skill is from the pool',
    opt.loadout.skills.Slot_Weapon2.every((id) => wp.options.includes(id)));

  const forced = [wp.options[wp.options.length - 1], wp.options[0]];
  const pinnedRun = optimize(engine, {
    loadout: { ...JSON.parse(JSON.stringify(l)), skills: { Slot_Weapon2: forced } },
    goal: 'dps', target, rank: 3, restarts: 1,
    pinnedGear: new Set(['Slot_Weapon2']), pinnedSkills: new Set(['Slot_Weapon2']),
  });
  ok('a pinned skill selection is respected',
    JSON.stringify(pinnedRun.loadout.skills.Slot_Weapon2.slice().sort()) === JSON.stringify(forced.slice().sort()),
    JSON.stringify(pinnedRun.loadout.skills.Slot_Weapon2));

  // Swapping the weapon must not leave the old weapon's skills behind.
  const other = cat.items.find((i) => i.slots.includes('Slot_Weapon2') && i.id !== three.id
    && cat.usableBy(i, 'Cleric') && i.skills.length);
  const swapped = JSON.parse(JSON.stringify(opt.loadout));
  swapped.gear.Slot_Weapon2 = { item: other.id, rarity: other.rarity, stars: 0 };
  engine.plan.pruneSelection(swapped);
  ok('a weapon swap discards the old weapon\'s skill picks',
    (swapped.skills.Slot_Weapon2 ?? []).every((id) => other.skills.includes(id)),
    JSON.stringify(swapped.skills.Slot_Weapon2));
}

// --- triggered skills ------------------------------------------------------
group('triggered skills and self-buffs');
{
  const engine = createEngine();
  const target = engine.combat.foe('reference', 25);

  // A resource-gated skill with no cooldown is not spammable and is not
  // unscoreable either: it is castable exactly as often as its income allows.
  const rageStrike = engine.combat.profile('Warrior_Rage_Strike', 3);
  ok('Warrior_Rage_Strike has no cooldown', !(rageStrike.cooldown > 0), String(rageStrike.cooldown));
  ok('and it declares a resource cost', rageStrike.costs.length > 0, JSON.stringify(rageStrike.costs));
  const w = emptyLoadout(cat, 'Warrior', 25);
  const wOpt = optimize(engine, { loadout: w, goal: 'dps', target, rank: 3, restarts: 1 });
  const rot = wOpt.evaluation.rotation;
  ok('a resource-gated skill is scored, not reported unmodelled',
    rot.active.some((x) => x.prof.id === 'Warrior_Rage_Strike')
      && !rot.unmodelled.some((u) => u.id === 'Warrior_Rage_Strike'),
    JSON.stringify(rot.unmodelled.map((u) => u.id)));

  // ...and the passives that FEED the pool are the mechanism, so they must not
  // also be listed as things the model could not score.
  ok('the Rage passives are accounted for, not reported unscored',
    !rot.unmodelled.some((u) => u.id === 'Warrior_Rage' || u.id === 'Warrior_InfiniteRage'),
    JSON.stringify(rot.unmodelled.map((u) => u.id)));

  // Its cast rate has to be the income rate, not the clock. Rage costs 10, and
  // the Warrior makes 1 per attack, per combo finisher, per weapon skill, plus
  // 1 every 3s from Infinite Rage - so it is single-digit seconds, never once a
  // fight (which is what a cooldown-less skill run through the CHARGE
  // machinery produced: one charge, then a next-recovery of Infinity).
  const rsLine = wOpt.evaluation.throughput.lines.find((l) => l.id === 'Warrior_Rage_Strike');
  ok('and its interval is set by income, not by a charge that never returns',
    rsLine && rsLine.interval > 1 && rsLine.interval < 30,
    rsLine ? `every ${rsLine.interval.toFixed(1)}s` : 'not in the rotation');

  // The income itself, read off the two passives.
  const gains = rot.resources.gains;
  ok('the Rage passive is read as income on attacks, combos and weapon skills',
    gains.some((g) => g.from === 'Warrior_Rage' && g.atb === 'Rage'
      && ['attack', 'combo', 'weapon-skill'].every((e) => g.on.includes(e))),
    JSON.stringify(gains.map((g) => [g.from, g.on])));
  ok('Infinite Rage is read as income per unit time',
    gains.some((g) => g.from === 'Warrior_InfiniteRage' && g.on === 'time' && g.every > 0),
    JSON.stringify(gains.map((g) => [g.from, g.on, g.every])));
  ok('the pool is capped by the sheet, not by a constant here',
    (engine.evaluate(wOpt.loadout, { target, rank: 3 }).sheet.get('MaxRage') ?? 0) > 0);

  // Charge levels are mutually exclusive, not cumulative.
  const charged = engine.combat.profile('GA_Craft_Skill1', 3);
  const ratios = charged.effects.flatMap((e) => e.scaling.map((s) => s.ratio));
  ok('a charged skill keeps only its highest charge step', ratios.length === 1,
    `kept ratios ${ratios.join(',')}`);

  // A prayer fires off the combo, not off its 1-second guard field.
  const smite = engine.combat.profile('Priest_Prayer_Smite', 3);
  ok('Priest_Prayer_Smite has a 1s cooldown field', smite.cooldown === 1, String(smite.cooldown));
  const p = optimize(engine, { loadout: emptyLoadout(cat, 'Priest', 25), goal: 'dps', target, rank: 3, restarts: 1 });
  const prayerLine = p.evaluation.throughput.lines.find((l) => l.id === 'Priest_Prayer_Smite');
  ok('and it is scored as triggered, not as a 1s cooldown', !prayerLine || prayerLine.kind === 'triggered',
    prayerLine ? prayerLine.kind : '(not in the rotation)');
  if (prayerLine) {
    ok('its interval is far longer than its cooldown field', prayerLine.interval > 2,
      prayerLine.interval.toFixed(2) + 's');
  }

  // A weapon enchant is worth something, via the status its script names.
  const zealot = engine.plan.selfBuffsOf('Enchant_Zealot');
  ok('Enchant_Zealot resolves to a self-buff status', zealot.length === 1, JSON.stringify(zealot));
  ok('and that status carries a rating affix and a stack cap',
    zealot[0]?.stacks > 1 && zealot[0]?.affixes.some((a) => a.target.attribute.endsWith('Rating')),
    JSON.stringify(zealot[0]));

  // A debuff applied to the target must never be read as a self-buff.
  for (const id of ['Sword_Swarm_Skill1']) {
    for (const b of engine.plan.selfBuffsOf(id)) {
      const neg = b.affixes.some((a) => (a.val ?? 0) < 0);
      ok(`${id}'s resolved buffs are not enemy debuffs`, !neg, JSON.stringify(b));
    }
  }

  // The rotation must never claim more than the clock.
  for (const cls of ['Warrior', 'Rogue', 'Mage', 'Priest']) {
    const r = optimize(engine, { loadout: emptyLoadout(cat, cls, 25), goal: 'dps', target, rank: 3, restarts: 1 });
    ok(`${cls}: occupancy never exceeds 100%`, r.evaluation.throughput.busy <= 1 + 1e-9,
      (r.evaluation.throughput.busy * 100).toFixed(1) + '%');
    ok(`${cls}: the base-attack chain comes from one weapon only`,
      new Set(r.evaluation.rotation.filler.map((x) => x.source)).size <= 1,
      [...new Set(r.evaluation.rotation.filler.map((x) => x.source))].join(','));
    ok(`${cls}: something is actually being cast`, r.evaluation.throughput.dps > 0);
  }
}

// --- targets ---------------------------------------------------------------
group('reference targets');
{
  const engine = createEngine();
  const build = emptyLoadout(cat, 'Warrior', 25);
  const wpn = cat.candidates('Slot_Weapon1', { aptitude: 'Fighter', charLevel: 25 })
    .find((c) => cat.itemById.get(c.item.id).skills.length > 0);
  build.gear.Slot_Weapon1 = { item: wpn.item.id, rarity: wpn.rarity, stars: 0 };

  const onDummy = engine.evaluate(build, { target: engine.combat.foe('dummy', 25) });
  const onRef = engine.evaluate(build, { target: engine.combat.foe('reference', 25) });
  const onArmoured = engine.evaluate(build, { target: engine.combat.foe('boss', 25) });
  ok('a mitigating target lowers damage', onDummy.throughput.dps > onRef.throughput.dps);
  ok('more armour lowers it further', onRef.throughput.dps > onArmoured.throughput.dps);
  ok('the dummy really has no mitigation', engine.combat.foe('dummy', 25).armor === 0);
  ok('a build does some damage at all', onDummy.throughput.dps > 0);
  ok('the rotation is not empty', onDummy.throughput.lines.length > 0);

  // Foe armour is derived from the units' own declared reduction intent
  // (unit.stats[].specScaling.armorReduction), not from a table in this repo.
  // The ladder must keep its shape, or the penetration numbers move silently.
  const red = (n) => engine.combat.foe(n, 25).physReduction;
  // Under the chain-SUM law a small mob's own 0.25 row ADDS to the inherited
  // 0.30 (S = 0.762, display 0.432) - live-verified by the dungeon ladder
  // inversion - so trash, with its single row, sits at the bottom.
  ok('the archetype ladder is ordered trash < small < big <= elite',
    red('trash') < red('small') && red('small') < red('big') && red('big') <= red('elite'),
    [red('trash'), red('small'), red('big'), red('elite')].join(' < '));
  ok('a named boss matches the elite tier', red('boss') === red('elite'),
    `${red('boss')} vs ${red('elite')}`);
  ok('Armor_ExpectedReduction is softer than what you actually fight',
    engine.combat.foe('reference', 25).physReduction < red('boss'),
    `${engine.combat.foe('reference', 25).physReduction} vs ${red('boss')}`);

  // Physical and magical reduction are equal on every real foe EXCEPT the
  // golems, and that exception is the whole reason armour inheritance had to be
  // read properly. Golem_Base declares an Armor multiplier of 1.6 and no
  // MagicArmor at all, so a golem is harder to hit than to burn: 0.4068 against
  // 0.30 off a W_Base parent, 0.5161 against 0.40 off an elite one.
  //
  // This was invisible while the model followed only the first `inherit` entry,
  // which found the archetype base and never Golem_Base - so every foe looked
  // symmetric and ArmorPenetration and SpellPenetration looked interchangeable.
  // Against a golem they are not.
  //
  // The tripwire is kept, narrowed to the shape rather than deleted: if a patch
  // splits something that is NOT a golem, penetration choice starts depending
  // on the fight in a way this tool does not yet model, and it needs to say so.
  const split = [];
  for (const [id, i] of engine.combat.targetsByUnit) {
    if (/Dummy|PunchingBag/.test(id)) continue;      // dev targets deliberately split
    if (i.phys == null || i.mag == null) continue;
    if (i.phys !== i.mag) split.push(id);
  }
  // The rule is not "is a golem" - it is "inherits Golem_Base", which is where
  // the Armor multiplier lives. Four of the twenty-one golems do NOT: the elite
  // variants inherit [W_Base_Elite] alone and come out symmetric at 0.40, even
  // though the non-elite version of the same creature carries Golem_Base. That
  // looks like an authoring slip in the game's data, and the model's job is to
  // report it rather than smooth it over.
  const unitsById = engine.cdb.byId('unit');
  const inheritsGolemBase = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const u = unitsById.get(id);
    return (u?.inherit ?? []).some((i) => i.ref === 'Golem_Base' || inheritsGolemBase(i.ref, seen));
  };

  ok('the split is exactly the units that inherit Golem_Base',
    split.length > 0 && split.every((id) => inheritsGolemBase(id)),
    `${split.length} split; not from Golem_Base: ${split.filter((id) => !inheritsGolemBase(id)).join(', ') || 'none'}`);
  ok('...and every one of them is tougher physically than magically',
    [...engine.combat.targetsByUnit]
      .filter(([id]) => inheritsGolemBase(id))
      .every(([, i]) => i.phys != null && i.mag != null && i.phys > i.mag));
  ok('...while a golem that does not inherit it stays symmetric',
    ['Golem_Z1W_Earth_E', 'Golem_Z2W_FireExplosive_E'].every((id) => {
      const i = engine.combat.targetsByUnit.get(id);
      return i && i.phys === i.mag;
    }));
  ok('a real unit id works as a target', engine.combat.foe('Ratsar', 25).armor > 0);
  ok('most units resolve an intent through inheritance', engine.combat.targetsByUnit.size > 100,
    String(engine.combat.targetsByUnit.size));

  // Penetration is worth more against a harder target - the whole reason the
  // default moved off the constant.
  const gain = (n) => {
    const t = engine.combat.foe(n, 25, 25);   // explicit parity - bosses carry fitted spawn levels now
    const [a, b] = K.resistFormula;
    const at = (pen) => { const r = t.armor * (1 - pen / 100); return 1 - r / (r + a + b * 25); };
    return at(50) / at(0) - 1;
  };
  ok('50% penetration is worth more against a boss than against the constant',
    gain('boss') > gain('reference') * 1.5,
    `${(gain('boss') * 100).toFixed(1)}% vs ${(gain('reference') * 100).toFixed(1)}%`);
}

// --- reporting -------------------------------------------------------------
group('honesty');
{
  const engine = createEngine();
  ok('the model reports its assumptions', engine.audit.length >= 4, `${engine.audit.length}`);
  ok('every unverified assumption says why',
    engine.audit.every((a) => a.what && a.why));
  ok('both data hashes travel with the result',
    !!engine.meta.cdbSha && engine.meta.cdbSha.length === 64);
}


// --- rarity ceilings -------------------------------------------------------
// Equipment stops at Rare while weapons reach Legendary. The CDB never says so,
// so both halves are derived - and the derivations must keep producing what the
// game currently does, or say so loudly when a patch moves them.
group('rarity ceilings');
{
  const weaponSlots = cat.combatSlots().filter((s) => cat.isWeaponSlot(s.id));
  const gearSlots = cat.combatSlots().filter((s) => !cat.isWeaponSlot(s.id));
  ok('the weapon slots are the three weapon slots', weaponSlots.length === 3,
    weaponSlots.map((s) => s.id).join(','));
  ok('and every other combat slot is gear', gearSlots.length > 8, String(gearSlots.length));

  for (const s of weaponSlots) {
    ok(`${s.id} reaches Legendary`, cat.rarityCeiling(s.id).rarity === 'Legendary',
      cat.rarityCeiling(s.id).rarity);
  }
  for (const s of gearSlots) {
    ok(`${s.id} stops at Rare`, cat.rarityCeiling(s.id).rarity === 'Rare',
      `${cat.rarityCeiling(s.id).rarity} - if a patch authored Epic gear this is the expected change`);
  }

  // The weapon half must come from the flag, not from a list in the code.
  const flagged = cdb.lines('rarity').filter((r) => cdb.flagNames('rarity', 'flags', r.flags).includes('AllowRandomWeaponDrop'));
  ok('AllowRandomWeaponDrop is set on exactly the non-Common rarities',
    flagged.length === cdb.lines('rarity').length - 1 && !flagged.some((r) => r.id === 'Common'),
    flagged.map((r) => r.id).join(','));

  // A gear roll must not produce Epic; a weapon roll must.
  const chestRolls = cat.attainableRarities(cat.itemById.get('Chest_RManfish_Cle'), 25, 'Slot_Chest');
  ok('a Rare chest cannot roll Epic', !chestRolls.some((r) => r.rarity === 'Epic'),
    chestRolls.map((r) => r.rarity).join(','));
  const spearRolls = cat.attainableRarities(cat.itemById.get('Spear_Eruption'), 25, 'Slot_Weapon1');
  ok('a Rare weapon can roll Epic and Legendary',
    ['Epic', 'Legendary'].every((x) => spearRolls.some((r) => r.rarity === x)),
    spearRolls.map((r) => r.rarity).join(','));

  // An explicit cap overrides both.
  const capped = cat.attainableRarities(cat.itemById.get('Spear_Eruption'), 25, 'Slot_Weapon1', 'Rare');
  ok('--rarity-cap Rare stops a weapon at Rare', !capped.some((r) => r.rarity === 'Epic'),
    capped.map((r) => r.rarity).join(','));

  // And the optimiser must respect it end to end.
  const engine = createEngine();
  const target = engine.combat.foe('reference', 25);
  const res = optimize(engine, {
    loadout: emptyLoadout(cat, 'Priest', 25), goal: 'dps', target, rank: 3,
    restarts: 1, rarityRoll: true, exclude: /^GM_/,
  });
  for (const [slotId, g] of Object.entries(res.loadout.gear)) {
    const ceil = cat.rarityCeiling(slotId).rarity;
    const authored = cat.itemById.get(g.item).rarity;
    ok(`${slotId} respects its ceiling`,
      (cat.rarityOrder.get(g.rarity ?? authored) ?? 0) <= Math.max(
        cat.rarityOrder.get(ceil) ?? 0, cat.rarityOrder.get(authored) ?? 0),
      `${g.rarity} on a ${ceil}-capped slot`);
  }
}


// --- the texts.refs trap ---------------------------------------------------
// `texts.refs.ref` fills ::ref_name:: and ::ref_dmg:: in a description, so it
// points at whatever the text MENTIONS - not at something the talent grants.
// 13 Rogue talents reference Rogue_Talent_LethalPoison_Status because they
// MODIFY it. Following it for value would count one status's damage thirteen
// times, and would take "readable" from 24 to 59 - a big, wrong, flattering
// number. This asserts the tool keeps refusing it.
group('talent links');
{
  const engine = createEngine();
  const T = engine.talents;
  const sk = cdb.byId('skill');

  // The real link: a Status step applies its status, and that is where
  // Sunlight's damage comes from.
  const sun = T.readableValue('Priest_Talent_Sunlight');
  ok('Priest_Talent_Sunlight is readable through its Status step', sun.readable, sun.kind);
  ok('and it resolves to the Sunlight status',
    sun.granted.includes('Priest_Talent_Sunlight_Status'), JSON.stringify(sun.granted));
  ok('whose damage scales off Faith',
    sun.effects.some((e) => e.scaling.some((s) => s.atb === 'Faith')),
    JSON.stringify(sun.effects.map((e) => e.scaling)));

  // The trap: many talents share one texts.refs target.
  const byRef = new Map();
  for (const c of engine.cat.classes) {
    for (const n of T.treeFor(c.unit).nodes) {
      const r = sk.get(n.skill)?.texts?.refs?.ref;
      if (!r) continue;
      byRef.set(r, (byRef.get(r) ?? 0) + 1);
    }
  }
  const worst = [...byRef.entries()].sort((a, b) => b[1] - a[1])[0];
  ok('several talents share one texts.refs target', worst && worst[1] > 5,
    worst ? `${worst[0]} is referenced by ${worst[1]}` : 'none found');

  // So a talent that only MENTIONS a status must stay unreadable.
  const mentioners = [];
  for (const c of engine.cat.classes) {
    for (const n of T.treeFor(c.unit).nodes) {
      const s = sk.get(n.skill);
      const ref = s?.texts?.refs?.ref;
      if (!ref || ref === n.skill) continue;
      const grantsIt = (s.steps ?? []).some((st) => st.props?.status?.ref === ref)
        || (s.props?.subskills ?? []).some((x) => x.skill === ref);
      if (grantsIt) continue;
      const v = T.readableValue(n.skill);
      if (v.granted.includes(ref)) mentioners.push(`${n.skill} credited with ${ref}`);
    }
  }
  ok('a talent that only mentions a status is never credited with it',
    mentioners.length === 0, mentioners.slice(0, 3).join('; '));

  // And the headline count stays honest.
  let readable = 0, total = 0;
  for (const c of engine.cat.classes) {
    for (const n of T.treeFor(c.unit).nodes) { total++; if (T.readableValue(n.skill).readable) readable++; }
  }
  // The bound moved from the low twenties to the low forties when the script
  // readers landed - scoped damage modifiers, pool dots and healing shares are
  // all genuinely readable now. It is still a canary: following `texts.refs`
  // would take it past sixty, because thirteen Rogue talents reference one
  // poison status and eleven Priest talents reference one Sunlight status, and
  // crediting every mentioner counts each of those statuses a dozen times.
  ok('readable talent count is in the low forties, not the high sixties',
    readable > 30 && readable < 55, `${readable} of ${total} - if this jumped, texts.refs is being followed`);
}


// --- talent ranks ----------------------------------------------------------
// 48 of the 88 nodes hold TWO points (`props.talent.maxPoints`), and their
// affix rows are rank-gated to match: Sharp Mind is
//   [{CooldownReduction, maxRank:1, val:3}, {CooldownReduction, minRank:2, val:6}]
// Those rows are mutually exclusive. Summing them reads 9, which no character
// can have - the same error as the castHoldStep charge levels, in a second
// place. These tests exist because that shipped once.
group('talent ranks');
{
  const engine = createEngine();
  const T = engine.talents;
  const sk = cdb.byId('skill');

  const tally = {};
  let nodes = 0;
  for (const c of engine.cat.classes) {
    for (const n of T.treeFor(c.unit).nodes) {
      nodes++;
      const mp = sk.get(n.skill)?.props?.talent?.maxPoints ?? 1;
      tally[mp] = (tally[mp] ?? 0) + 1;
    }
  }
  ok('more than one node holds two points', (tally[2] ?? 0) > 10,
    `maxPoints tally ${JSON.stringify(tally)} - if this is all 1s, re-read props.talent`);
  ok('every tier-4 node holds one point, which is what the sigil rule rests on',
    engine.cat.classes.every((c) => T.treeFor(c.unit).nodes
      .filter((n) => n.tier === 4)
      .every((n) => (sk.get(n.skill)?.props?.talent?.maxPoints ?? 1) === 1)));

  // The rank rows must be SELECTED, never summed.
  const ranked = [];
  for (const c of engine.cat.classes) {
    for (const n of T.treeFor(c.unit).nodes) {
      const afx = (sk.get(n.skill)?.affixes ?? []).filter((a) => a.target?.attribute);
      if (afx.length > 1 && afx.some((a) => a.conds?.minRank != null || a.conds?.maxRank != null)) {
        ranked.push(n.skill);
      }
    }
  }
  ok('some talents carry rank-gated affix rows', ranked.length > 0, String(ranked.length));
  for (const id of ranked) {
    const r1 = T.readableValue(id, 1).affixes;
    const r2 = T.readableValue(id, 2).affixes;
    const all = (sk.get(id).affixes ?? []).filter((a) => a.target?.attribute);
    ok(`${id}: rank 1 takes fewer rows than exist`, r1.length < all.length,
      `${r1.length} of ${all.length}`);
    ok(`${id}: rank 2 differs from rank 1`,
      JSON.stringify(r1.map((a) => a.val)) !== JSON.stringify(r2.map((a) => a.val)),
      JSON.stringify(r1.map((a) => a.val)));
    const sum = all.reduce((s, a) => s + (a.val ?? 0), 0);
    const at2 = r2.reduce((s, a) => s + (a.val ?? 0), 0);
    ok(`${id}: rank 2 is not the sum of every row`, Math.abs(at2 - sum) > 1e-9,
      `rank2=${at2}, sum-of-all=${sum}`);
  }

  // The allocator must be able to buy a second rank, and must respect the cap.
  const alloc = T.suggest('Priest', { level: 25 });
  ok('the allocator buys second ranks', Object.values(alloc.ranks).some((r) => r > 1),
    JSON.stringify(alloc.ranks));
  ok('no node exceeds its cap',
    Object.entries(alloc.ranks).every(([id, r]) => r <= (sk.get(id)?.props?.talent?.maxPoints ?? 1)));
  ok('points spent equals the sum of ranks',
    alloc.spent === Object.entries(alloc.ranks)
      .filter(([id]) => !alloc.granted.includes(id))
      .reduce((s, [, r]) => s + r, 0),
    `spent ${alloc.spent}`);
  ok('with ranks available the budget is nearly used up', alloc.unspent <= 2,
    `${alloc.spent} of ${alloc.budget}, ${alloc.unspent} unspent`);

  // The allocation must be legal by an independent replay.
  ok('the suggested allocation is legal',
    T.illegalAllocation('Priest', alloc.ranks, { level: 25, points: alloc.budget }) === null,
    T.illegalAllocation('Priest', alloc.ranks, { level: 25, points: alloc.budget }) ?? '');
  ok('over-ranking a node is rejected',
    T.illegalAllocation('Priest', { Priest_Talent_Sunlight: 5 }, { level: 25, points: 16 }) !== null);
  ok('overspending is rejected',
    T.illegalAllocation('Priest', alloc.ranks, { level: 25, points: 2 }) !== null);

  // Coverage counts points, not nodes.
  const cov = T.coverage('Priest', alloc.ranks);
  ok('coverage counts points not nodes', cov.spent >= cov.nodes, `${cov.spent} points, ${cov.nodes} nodes`);
  ok('the tree holds more points than nodes', cov.totalPoints > cov.total,
    `${cov.totalPoints} points, ${cov.total} nodes`);

  // And the sheet must show the RANKED value, not the summed one.
  const l = emptyLoadout(cat, 'Priest', 25);
  l.talents = { Priest_Talent_SharpMind: 2 };
  const cdr = engine.evaluate(l, { target: engine.combat.foe('boss', 25), rank: 3 }).sheet.get('CooldownReduction');
  const rows = (sk.get('Priest_Talent_SharpMind').affixes ?? []).map((a) => a.val);
  ok('a rank-2 talent contributes its rank-2 row, not the sum',
    Math.abs(cdr - Math.max(...rows)) < 1e-9,
    `sheet says ${cdr}, rows are ${JSON.stringify(rows)}`);
}


// --- tier thresholds, confirmed in game ------------------------------------
// The rule, observed rather than derived:
//   tier 0  from the start
//   tier 1  every branch, once tier 0 holds 1 point
//   tier 2  that branch, once tier 1 and below hold 2 cumulative
//   tier 3  that branch, once tier 2 and below hold 4 cumulative
//   tier 4  that branch, once tier 3 and below hold 8 cumulative
// So Talents_TierThresholds is indexed BY TIER, all five entries used, and the
// root counts toward every branch. An earlier reading shifted it by one; these
// tests exist so that cannot come back.
group('tier thresholds');
{
  const engine = createEngine();
  const T = engine.talents;
  const sk = cdb.byId('skill');
  const tree = T.treeFor('Priest');
  const root = tree.nodes.find((n) => n.tier === 0);
  const tier4 = tree.nodes.find((n) => n.tier === 4 && n.branch === 'Left');

  // Build an allocation: 1 in the root, then N points spread over one branch's
  // tiers 1..3, optionally taking that branch's tier-4 node.
  const build = (t1, t2, t3, withTier4) => {
    const r = { [root.skill]: 1 };
    const fill = (tier, pts) => {
      let left = pts;
      for (const n of tree.nodes.filter((x) => x.tier === tier && x.branch === 'Left')) {
        const cap = sk.get(n.skill)?.props?.talent?.maxPoints ?? 1;
        const take = Math.min(cap, left);
        if (take > 0) { r[n.skill] = take; left -= take; }
      }
    };
    fill(1, t1); fill(2, t2); fill(3, t3);
    if (withTier4) r[tier4.skill] = 1;
    return r;
  };
  const check = (a) => T.illegalAllocation('Priest', a, { level: 25, points: 16 });

  ok('the thresholds array is read by tier, unshifted',
    JSON.stringify(T.thresholds) === JSON.stringify([0, 1, 2, 4, 8]),
    JSON.stringify(T.thresholds));

  // The two allocations verified in game.
  ok('root + 1 + 2 + 4 opens tier 4', check(build(1, 2, 4, true)) === null,
    check(build(1, 2, 4, true)) ?? '');
  ok('root + 1 + 3 + 3 opens tier 4', check(build(1, 3, 3, true)) === null,
    check(build(1, 3, 3, true)) ?? '');

  // One point short must not.
  ok('root + 1 + 2 + 3 does NOT open tier 4 (7 cumulative)',
    check(build(1, 2, 3, true)) !== null);
  ok('and the refusal names tier 4 and the number needed',
    /tier 4 and needs 8/.test(check(build(1, 2, 3, true)) ?? ''),
    check(build(1, 2, 3, true)) ?? '');

  // Every tier's own boundary.
  ok('tier 2 needs 2 cumulative, so skipping tier 1 is refused',
    /tier 2 and needs 2/.test(check(build(0, 2, 0, false)) ?? ''),
    check(build(0, 2, 0, false)) ?? '');
  ok('tier 3 needs 4 cumulative',
    /tier 3 and needs 4/.test(check(build(1, 1, 4, false)) ?? ''),
    check(build(1, 1, 4, false)) ?? '');

  // The root counts toward every branch - without that, tier 2 could never be
  // reached, since a branch holds exactly one tier-1 node worth one point.
  const noRoot = build(1, 2, 0, false);
  delete noRoot[root.skill];
  ok('without the root, tier 2 is unreachable', check(noRoot) !== null, check(noRoot) ?? '');
  ok('a branch holds exactly one tier-1 node',
    tree.nodes.filter((n) => n.tier === 1 && n.branch === 'Left').length === 1);

  // And the allocator obeys its own rule.
  for (const cls of ['Warrior', 'Rogue', 'Mage', 'Priest']) {
    const a = T.suggest(cls, { level: 25 });
    ok(`${cls}: the suggested allocation is legal`,
      T.illegalAllocation(cls, a.ranks, { level: 25, points: a.budget }) === null,
      T.illegalAllocation(cls, a.ranks, { level: 25, points: a.budget }) ?? '');
    ok(`${cls}: with ranks and the real thresholds, the budget is fully used`,
      a.unspent === 0, `${a.spent} of ${a.budget}`);
  }
}

// --- against a real character sheet ----------------------------------------
// A level-25 Warrior with no equipment, no talents and nothing slotted, read
// off the game's own character sheet. This is the second in-game reading the
// project has and the first that covers the WHOLE sheet rather than one item,
// so it pins the level curve, the rounding rule and every derived stat at once.
group('checked against the game: naked level-25 Warrior');
{
  const eng = createEngine({ quiet: true });
  const ev = eng.evaluate(emptyLoadout(eng.cat, 'Warrior', 25),
    { target: eng.combat.foe('boss', 25), rank: 3 });
  const SHEET = {
    Vitality: 38, Strength: 34, Dexterity: 28, Faith: 28, Intellect: 28,
    CritChance: 5.8, CritDamage: 151.2, ArmorPenetration: 0, SpellPenetration: 0,
    Fervor: 0, BlockMitigation: 0, DodgeChance: 0.3, MagicMastery: 0, PhysicalMastery: 0,
  };
  for (const [atb, want] of Object.entries(SHEET)) {
    const got = ev.sheet.get(atb);
    ok(`sheet: ${atb} reads ${want}`, got != null && Math.abs(got - want) < 0.15,
      `got ${got == null ? '(absent)' : got.toFixed(2)}`);
  }

  // The rounding rule those numbers settle. Raw curve values are 33.974,
  // 28.091 and 38.211; the game shows 34, 28 and 38. Ceiling matches one,
  // flooring matches two, rounding matches all three - so `RoundUp` rounds.
  ok('RoundUp rounds rather than ceils',
    Math.abs(ev.sheet.get('Dexterity') - 28) < 1e-9 && Math.abs(ev.sheet.get('Strength') - 34) < 1e-9);

  // ...and the printed sheet is the RESTING one. A 120-second buff averaged in
  // at its uptime is a fight statistic, not a character sheet: Battle Shout's
  // +20 CritChance at 12.5% uptime is what made this read 8.3 instead of 5.8.
  ok('the resting sheet carries no timed buff', Math.abs(ev.sheet.get('CritChance') - 5.8) < 0.15);
  ok('...and the averaged sheet is reported alongside it, and differs',
    ev.averaged && (ev.averaged.get('CritChance') ?? 0) > ev.sheet.get('CritChance'));

  // Two skill tooltips from the same character.
  near('Raging Smash is 1.6 x Strength', 1.6 * ev.sheet.get('Strength'), 54.4, 0.05);
  near('Surging Force is 0.6 x Vitality', 0.6 * ev.sheet.get('Vitality'), 22.8, 0.05);
}

// --- the class-skill bar ---------------------------------------------------
group('class skills are chosen, not given');
{
  const eng = createEngine({ quiet: true });
  const T = eng.cdb.enumValues('skill', 'type');
  // Every class declares six, at the same six levels.
  for (const cls of ['Warrior', 'Rogue', 'Mage', 'Priest']) {
    const rows = (eng.cdb.byId('unit').get(cls).skills ?? [])
      .filter((s) => T[eng.cdb.byId('skill').get(s.skill ?? s.ref)?.type ?? -1] === 'ClassSkill');
    ok(`${cls} declares six class skills`, rows.length === 6, String(rows.length));
    ok(`${cls}: five of them are learned by level 25`,
      rows.filter((s) => (s.level ?? 0) <= 25).length === 5);
  }
  // ...and only four are slotted, so the fifth is a real cost.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  eng.plan.pruneSelection(l);
  const pool = eng.plan.pools(l).find((p) => p.key === 'class/ClassSkill');
  ok('the bar is a pool of five with four slots', pool && pool.slots === 4 && pool.options.length === 5,
    pool ? `${pool.slots}/${pool.options.length}` : 'no pool');
  const rot = eng.plan.resolve(l, 3);
  const inRot = new Set([...rot.active, ...rot.triggered, ...rot.passive].map((x) => x.prof.id));
  ok('an unslotted class skill is not in the rotation',
    pool.options.filter((id) => inRot.has(id)).length <= 4,
    pool.options.filter((id) => inRot.has(id)).join(','));

  // Berserk's damage half lives only in its script, and without it the search
  // dropped the class's biggest damage cooldown from the bar.
  const berserk = eng.plan.statusesOf('Warrior_Berserk', { rank: 3, runes: new Set(), talents: new Set() });
  const dm = berserk.self.flatMap((b) => b.affixes).find((a) => a.target?.attribute === 'DamageModifier');
  ok('Berserk reads its +20% damage, not just its Rage half', dm && Math.abs(dm.val - 20) < 1e-9,
    JSON.stringify(berserk.self.flatMap((b) => b.affixes.map((a) => a.target.attribute))));
  // ...and a CONDITIONAL script multiplier must not become a permanent stat.
  const bladeleaf = eng.plan.statusesOf('DS_Bladeleaf_Combo', { rank: 3, runes: new Set(), talents: new Set() });
  ok('a dmgMult inside a branch is refused',
    !bladeleaf.self.flatMap((b) => b.affixes).some((a) => a.target?.attribute === 'DamageModifier'));
}

// --- scoped talent modifiers ------------------------------------------------
// Most of the "increased damage" talents are one line of script with a guard,
// and none of them is a stat: a sheet has one DamageModifier and cannot say
// "+20% critical damage, but only on weapon skills". The refusals matter as
// much as the readings - defaulting an unrecognised guard to "unconditional"
// took the Priest from 249 to 380 dps.
group('scoped talent modifiers');
{
  const eng = createEngine({ quiet: true });
  const mod = (id, rank = 1) => eng.plan.talentModifiers(id, rank);
  const one = (id, rank = 1) => mod(id, rank)[0] ?? null;

  const sever = one('Warrior_Talent_Sever');
  ok('Sever is +20% critical damage on weapon skills only',
    sever && sever.field === 'critDmgMult' && sever.scope === 'weaponSkill' && Math.abs(sever.amount - 0.2) < 1e-9,
    JSON.stringify(sever));
  const maa = one('Warrior_Talent_MasterAtArms', 2);
  // Its guard names BOTH halves - isBaseAttack || isFinalCombo - and the scope
  // keeps them now instead of collapsing to 'attack' and silently dropping the
  // finisher's share.
  ok('Master-at-arms is scoped to swings and the finisher, and scales with rank',
    maa && maa.scope === 'attack-or-combo' && Math.abs(maa.amount - 0.3) < 1e-9, JSON.stringify(maa));
  const bl = one('Warrior_Talent_Bloodletting', 2);
  ok('Bloodletting is scoped to bleed damage', bl && bl.scope === 'bleed', JSON.stringify(bl));
  const mc = one('Warrior_Talent_MagicConduction', 2);
  ok('Magic Conduction is magic damage against a bleeding target',
    mc && mc.scope === 'magic' && mc.targetBleeding, JSON.stringify(mc));
  // Two fields on consecutive lines: the second line's guard must not pick up
  // the first line's assignment.
  ok('Exposed Essence ignores BOTH armours, at 5% each and not 10% of one',
    mod('Warrior_ExposedEssence', 1).length === 2
    && mod('Warrior_ExposedEssence', 1).every((m) => Math.abs(m.amount - 0.05) < 1e-9),
    JSON.stringify(mod('Warrior_ExposedEssence', 1)));

  // A status-scoped bonus names its OWN status type. Reading any of them as
  // "all damage" is how a flat +20% appeared on a class that has no bleed.
  const ld = one('Rogue_Talent_LethalDose', 2);
  ok('a Poison-scoped bonus is not read as global damage',
    ld && ld.scope !== 'all' && /Poison/.test(ld.scope), JSON.stringify(ld));

  // A guard the reader cannot classify must still produce NOTHING rather than
  // an unconditional bonus.
  ok('Priest_Talent_PiercingLight is refused rather than read as unconditional',
    !eng.cdb.byId('skill').has('Priest_Talent_PiercingLight')
      || mod('Priest_Talent_PiercingLight', 2).length === 0,
    JSON.stringify(mod('Priest_Talent_PiercingLight', 2)));
  // Two guards the reader NOW classifies, at the value the rankOverride
  // restates (0.12 x 2 is not 0.25). Authority names one castable skill;
  // Radiance rides every status tick the owner carries - both measured on
  // Emsei's ledger, one x1.2 and one x1.25.
  const auth = one('Priest_Talent_Authority', 2);
  ok('Authority is a +20% rider scoped to Smite alone',
    auth && auth.scope === 'one-skill' && auth.skill === 'Priest_Prayer_Smite'
      && Math.abs(auth.amount - 0.2) < 1e-9, JSON.stringify(auth));
  const rad = one('Priest_Talent_Radiance', 2);
  ok('Radiance is a +25% rider on owner-carried status ticks',
    rad && rad.scope === 'own-status-tick' && Math.abs(rad.amount - 0.25) < 1e-9,
    JSON.stringify(rad));

  // ...and no talent anywhere may come out as a global bonus large enough to be
  // a mis-read conditional. Nothing in this data legitimately grants one.
  const T = eng.cdb.enumValues('skill', 'type');
  const globals = [];
  for (const s of eng.cdb.lines('skill')) {
    if (T[s.type ?? -1] !== 'Talent') continue;
    for (const m of mod(s.id, s.props?.talent?.maxPoints ?? 1)) {
      if (m.scope === 'all' && !m.targetBleeding && m.amount >= 0.15) globals.push(`${s.id}:${m.field}=${m.amount}`);
    }
  }
  ok('no talent reads as a large unconditional global bonus', globals.length === 0, globals.join(', '));
}

// --- pool dots -------------------------------------------------------------
// Hemorrhage is the node the whole Warrior tree is built around, and the model
// used to refuse it outright: "its magnitude is the third argument to
// addStatus, computed by a script". True of the shape, false of the number -
// `vars.damage` is 0.35 and sits in the row.
group('pool dots');
{
  const eng = createEngine({ quiet: true });
  const N = { rank: 3, runes: new Set(), talents: new Set() };
  const dotOf = (id) => eng.plan.statusesOf(id, N).dots.find((d) => d.pool);

  const hem = dotOf('Warrior_Hemorrhage');
  ok('Hemorrhage is read as a pool dot', !!hem);
  if (hem) {
    near('...at 35% of the hit', hem.pool.fraction, 0.35);
    ok('...off physical critical strikes', hem.pool.crit && hem.pool.physical && !hem.pool.magic);
    ok('...excluding damage from other dots, so it cannot feed itself', hem.pool.excludesDot);
    near('...over 8 seconds', hem.duration, 8);
    near('...ticking every 2', hem.tick, 2);
    ok('...and it pools rather than refreshing', hem.stacking === 'DurationBased', String(hem.stacking));
  }

  // Infused Wound is a SECOND, independent pool off magic crits.
  const inf = dotOf('Warrior_Talent_InfusedWound');
  ok('Infused Wound is a separate pool off magic crits',
    inf && inf.pool.magic && !inf.pool.physical, JSON.stringify(inf?.pool ?? null));
  ok('...and it is a different status, so the two add rather than replace',
    inf && hem && inf.status !== hem.status);

  // The stacking column is what bounds this. Guessing it from "the amount is a
  // declared total" matched nearly every dot in the game.
  let durationBased = 0;
  for (const s of eng.cdb.lines('skill')) {
    const p = s.props?.status?.stackingPolicy;
    if (p != null && eng.cdb.enumValues('skill@props@status', 'stackingPolicy')[p] === 'DurationBased') durationBased++;
  }
  ok('only a handful of statuses pool', durationBased > 0 && durationBased <= 6, String(durationBased));

  // End to end: the bleed is worth a share of the crit damage, and nothing else
  // changes when the talent is not taken.
  const build = (talents) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'GS_Nova', stars: 0 };
    l.talents = talents;
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('boss', 25), rank: 3 });
  };
  const without = build({});
  const withHem = build({ Warrior_Hemorrhage: 1 });
  ok('taking Hemorrhage raises throughput', withHem.throughput.dps > without.throughput.dps,
    `${without.throughput.dps.toFixed(1)} -> ${withHem.throughput.dps.toFixed(1)}`);
  const line = withHem.throughput.lines.find((l) => l.id === 'Warrior_Hemorrhage_Status');
  ok('...and it is reported as its own line', !!line, 'no Hemorrhage line');
  ok('...worth less than the build that feeds it',
    line && line.perCast.damage < withHem.throughput.dps * withHem.throughput.fight,
    'the bleed cannot exceed the fight');
  // A talent the tree is built around must not read as "nothing readable".
  ok('the tree reports it as readable', eng.talents.readableValue('Warrior_Hemorrhage', 1).readable);
}

// --- the bytecode reader ----------------------------------------------------
// hlboot.dat is where the composition rules live that data.cdb does not
// state. The reader's checksum is the file itself: 40MB of varint-encoded
// stream, and one wrong argument count desyncs it within a handful of reads -
// so parsing to exactly EOF, with the function count the README has always
// cited and the two findexes MODEL.md has always cited resolving to their
// names, is the whole validation.
group('the bytecode reader');
{
  const { readHlb, disasm } = await import('../src/lib/hl.mjs');
  const { findBoot } = await import('../src/lib/game.mjs');
  const code = readHlb(findBoot([]));
  ok('hlboot.dat parses to exactly EOF', !!code);
  ok('it is version 4 with debug info', code.version === 4 && code.hasDebug);
  ok('the function count is the one the README cites', code.functions.length === 47342,
    String(code.functions.length));
  ok('findex 4835 is ent.Unit.applyDamage', code.nameOf(4835) === 'ent.Unit.applyDamage',
    code.nameOf(4835) ?? '(unnamed)');
  ok('findex 4841 is ent.Unit.computeDamage', code.nameOf(4841) === 'ent.Unit.computeDamage',
    code.nameOf(4841) ?? '(unnamed)');
  const f = code.byFindex.get(4841);
  ok('...cited to its source line', code.debugFiles[f.debug[0]] === 'src/ent/Unit.hx',
    code.debugFiles[f.debug[0]]);
  const listing = disasm(code, 4841);
  ok('the listing resolves fields and locals', /critDmgMult/.test(listing) && /modMult/.test(listing));
}

// --- checked against the game: Cheese Moon ---------------------------------
// A second in-game reading (2026-08-01), on a real Rare 3-star Axe_Boomerang
// trained to weapon level 25, held by a naked level-25 Warrior, against a
// 0-armor dummy. It settled three things at once: the naked base sheet, that
// an item's STATS follow its drop-level budget while its DAMAGE follows its
// trained level, and WeaponPower's formula - the flat primary budget plus the
// wielder's primary attribute.
group('checked against the game: Cheese Moon');
{
  const eng = createEngine({ quiet: true });
  // The naked sheet, to the decimal: Vit 38, Str 34, Dex/Faith/Int 28,
  // crit 5.8%, crit bonus 151.2%.
  const naked = emptyLoadout(eng.cat, 'Warrior', 25);
  const evN = eng.evaluate(naked, { rank: 3 });
  near('naked Vitality', evN.sheet.get('Vitality'), 38, 0.5);
  near('naked Strength', evN.sheet.get('Strength'), 34, 0.5);
  near('naked Dexterity', evN.sheet.get('Dexterity'), 28, 0.5);
  near('naked CritChance', evN.sheet.get('CritChance'), 5.8, 0.05);
  near('naked CritDamage', evN.sheet.get('CritDamage'), 151.2, 0.1);

  // WeaponPower: the flat primary budget at the trained (character) level.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { rank: 3 });
  // Read from the bytecode: 0.4 x the SUM of the item's aptitude primary
  // budgets - Fighter's Strength curve (123.6) plus Assassin's Dexterity
  // curve (148.3) for this dual-aptitude axe.
  near('WeaponPower is 0.4 x the sum of the aptitude budgets', ev.weaponPower, 0.4 * (123.6 + 148.3), 0.5);

  // Swing 1 against 0 armor: ratio 0.13 x (budget + Strength-with-weapon).
  // Observed in game: 19-24 across the +-10% per-swing roll.
  const link1 = eng.plan.baseChain(eng.cat.itemById.get('Axe_Boomerang')).links[0];
  const p1 = eng.combat.profile(link1, 3);
  const dummy = { name: 'dummy', level: 25, armor: 0, magicArmor: 0 };
  const out = eng.combat.castOutput(p1, ev.sheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength', 'Dexterity'] });
  const critMult = 1 + Math.min(1, ev.sheet.get('CritChance') / 100)
    * (ev.sheet.get('CritDamage') / 100 - 1);
  const noncrit = out.damage / critMult;
  ok('the naked swing lands inside the observed 19-24', noncrit > 19 && noncrit < 24,
    noncrit.toFixed(2));
  // ...and the equip delta is the same ratio applied to the weapon's own
  // Strength: the bag showed 18-21 against Str 34, the swing runs ~2 higher
  // against Str-with-weapon.
  const bagSheet = new Map(ev.sheet);
  bagSheet.set('Strength', 34);
  const bag = eng.combat.castOutput(p1, bagSheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength', 'Dexterity'] });
  const bagNoncrit = bag.damage / critMult;
  ok('the bag tooltip reading lands inside 18-21 too', bagNoncrit > 18 && bagNoncrit < 21.5,
    bagNoncrit.toFixed(2));

  // The SECOND weapon, which is what caught the two-hander's 0.4 flat:
  // Judgement equipped alone (Str 34+38=72) swings 78-95 on the same dummy.
  const l2 = emptyLoadout(eng.cat, 'Warrior', 25);
  l2.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Epic', stars: 4 };
  eng.plan.pruneSelection(l2);
  const ev2 = eng.evaluate(l2, { rank: 3 });
  near('a two-hander takes 0.4 of the flat budget', ev2.weaponPower, 123.6 * 0.4, 0.5);
  const ga1 = eng.combat.profile(eng.plan.baseChain(eng.cat.itemById.get('GA_Craft')).links[0], 3);
  // The model's Strength includes the weapon's own contribution at its
  // stat budget; the real item read +38. Pin the formula against the real
  // sheet rather than against the model's item stats.
  const gaSheet = new Map(ev2.sheet);
  gaSheet.set('Strength', 72);
  // The clean reading was without Brutal Frenzy stacks; the model's sheet
  // folds them at cap, so pin mastery off the same way Strength is pinned.
  gaSheet.set('PhysicalMastery', 0);
  const ga = eng.combat.castOutput(ga1, gaSheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength'] });
  const gaCritMult = 1 + Math.min(1, ev2.sheet.get('CritChance') / 100)
    * (ev2.sheet.get('CritDamage') / 100 - 1);
  const gaNoncrit = ga.damage / gaCritMult;
  ok('the two-hander swing lands inside the observed 78-95', gaNoncrit > 78 && gaNoncrit < 95,
    gaNoncrit.toFixed(2));

  // The weapon-skill mix, measured exact on six integers: a mainhand skill's
  // attribute scaling is 60% attribute + 40% of that attribute's OWN budget
  // curve. Rampage read 233/371/556 at authored 2.5/4/6 x Strength, Brutal
  // Frenzy 133 at 1.43, both against the naked-plus-Judgement sheet (Str 72);
  // Tear's 75 at 45% Str + 45% Dex is what proved the flat is per attribute.
  const mix = {
    flats: eng.combat.attributeBudgets(25),
    ids: new Set(['GA_Craft_Skill1', 'GA_Craft_FinalCombo', 'Axe_Boomerang_Combo']),
  };
  near('Dexterity has its own budget curve', mix.flats.get('Dexterity'), 148.3, 0.5);
  const rampage = eng.combat.profile('GA_Craft_Skill1', 3);
  const rOut = eng.combat.castOutput(rampage, gaSheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength'], weaponMix: mix });
  near('Rampage at full charge reads the measured 556', rOut.damage / gaCritMult, 556, 2);
  const frenzy = eng.combat.profile('GA_Craft_FinalCombo', 3);
  const fOut = eng.combat.castOutput(frenzy, gaSheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength'], weaponMix: mix });
  // The CAST is the 1.43 step alone, which is the tooltip's 133. The 0.3 step
  // is `on: Code` - played by `playStep(Steps.Attack)` on a 15% base-attack
  // roll and by nothing else - so it is not part of the finisher at all, and
  // billing it there used to price the cast at 161 against a measured 133.
  near('Brutal Frenzy\'s cast is the measured 133', fOut.damage / gaCritMult, 132.6, 1.5);
  ok('...and the 0.3 step is not in it',
    (frenzy.scripted ?? []).length === 1 && frenzy.scripted[0].stepId === 'Attack',
    JSON.stringify((frenzy.scripted ?? []).map((x) => x.stepId)));
  // ...and priced on its own it is the tooltip's other number, the 28 the
  // description calls "an additional 28" on a 15% roll.
  const rider = eng.combat.castOutput(
    { ...frenzy, effects: frenzy.scripted[0].effects }, gaSheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength'], weaponMix: mix });
  near('...it is the tooltip\'s other number, 28', rider.damage / gaCritMult, 27.8, 1);
  // Tear, at the REAL equipped stats (Str 49, Dex 46): 0.45x(0.6x49 +
  // 0.4x123.6) + 0.45x(0.6x46 + 0.4x148.3) = 74.6, measured 75. The real
  // sheet carries the axe's Dexterity half too, which the model's own-half
  // rule does not grant a Warrior - that open question is in the audit -
  // so the stats are pinned here and the FORMULA is what this checks.
  const tear = eng.combat.profile('Axe_Boomerang_Combo', 3);
  const tSheet = new Map(ev.sheet);
  tSheet.set('PhysicalMastery', 0);
  tSheet.set('Strength', 49);
  tSheet.set('Dexterity', 46);
  const tOut = eng.combat.castOutput(tear, tSheet, dummy,
    { assume: { fervorScope: 'skills', mastery: true }, targets: 1, swingAttrs: ['Strength'], weaponMix: mix });
  const tCritMult = 1 + Math.min(1, ev.sheet.get('CritChance') / 100)
    * (ev.sheet.get('CritDamage') / 100 - 1);
  near('Tear reads the measured 75', tOut.damage / tCritMult, 74.6, 1.2);
}

// --- pool feed scoping -----------------------------------------------------
// WHICH damage feeds a pool is the hook's business: `onInflictDamage` is
// owner-global, a skill's own `onDamage` sees only that skill's hits. Reading
// Bonethrow's per-skill pool as global fed it from the whole rotation's crits
// and invented ~18% of a Warrior's headline dps - and the guard flags (crit,
// physical) were collected and never consumed, so it was simultaneously fed
// the wrong slice. These pin both readings and the per-type multipliers.
group('pool feed scoping');
{
  const eng = createEngine({ quiet: true });
  const N = { rank: 3, runes: new Set(), talents: new Set() };
  const dotOf = (id) => eng.plan.statusesOf(id, N).dots.find((d) => d.pool);

  const bone = dotOf('Axe_Boomerang_Skill1');
  ok('Bonethrow is read as a pool dot', !!bone);
  if (bone) {
    near('...at 40% of the hit', bone.pool.fraction, 0.4);
    ok('...of its OWN damage - the hook is onDamage, not onInflictDamage', bone.pool.own === true);
    ok('...crit or not - its guard has no crit test', !bone.pool.crit);
    ok('...and its status is a plain Bleed, not a Hemorage',
      (bone.types ?? []).includes('Bleed') && !(bone.types ?? []).includes('Hemorage'),
      JSON.stringify(bone.types));
  }
  const hem = dotOf('Warrior_Hemorrhage');
  ok('Hemorrhage stays owner-global', hem && hem.pool.own !== true);
  ok('...and its status is typed Hemorage', hem && (hem.types ?? []).includes('Hemorage'));

  // End to end: with Bonethrow's weapon held, its pool is fed by its own casts
  // alone, so its line must be far below Hemorrhage's rotation-wide one - the
  // bug fed both the identical number.
  const build = (talents) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', stars: 0 };
    l.talents = talents;
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('boss', 25), rank: 3 });
  };
  const lineOf = (ev, id) => ev.throughput.lines.find((x) => x.id === id);
  const both = build({ Warrior_Hemorrhage: 1 });
  const boneLine = lineOf(both, 'Axe_Boomerang_Skill1_Status');
  const hemLine = lineOf(both, 'Warrior_Hemorrhage_Status');
  ok('the two pools are fed different numbers', boneLine && hemLine
    && boneLine.why.split(' of ')[1] !== hemLine.why.split(' of ')[1],
    `${boneLine?.why} vs ${hemLine?.why}`);
  ok('Bonethrow says whose damage it pools', boneLine?.why.includes('dealt by itself'), boneLine?.why);
  ok('Hemorrhage still says critical', hemLine?.why.includes('critical'), hemLine?.why);

  // Exsanguination's guard says `isStatusType(StatusType.Hemorage)`, and the
  // statusType sheet subtypes ONE way - so it must move Hemorrhage's pool and
  // leave Bonethrow's plain-Bleed pool exactly where it was.
  const withEx = build({ Warrior_Hemorrhage: 1, Warrior_Talent_Exsanguination: 2 });
  const bone0 = lineOf(both, 'Axe_Boomerang_Skill1_Status')?.perCast.damage ?? 0;
  const bone1 = lineOf(withEx, 'Axe_Boomerang_Skill1_Status')?.perCast.damage ?? 0;
  const hem0 = lineOf(both, 'Warrior_Hemorrhage_Status')?.perCast.damage ?? 0;
  const hem1 = lineOf(withEx, 'Warrior_Hemorrhage_Status')?.perCast.damage ?? 0;
  ok('Exsanguination raises the Hemorrhage pool', hem1 > hem0 * 1.05,
    `${hem0.toFixed(0)} -> ${hem1.toFixed(0)}`);
  near('...and does not touch the plain-Bleed pool', bone1, bone0, Math.max(1, bone0 * 0.01));
  // Bloodletting's guard says Bleed, the parent type, so it covers BOTH.
  const withBl = build({ Warrior_Hemorrhage: 1, Warrior_Talent_Bloodletting: 2 });
  const boneBl = lineOf(withBl, 'Axe_Boomerang_Skill1_Status')?.perCast.damage ?? 0;
  ok('Bloodletting covers the plain Bleed too', boneBl > bone0 * 1.05,
    `${bone0.toFixed(0)} -> ${boneBl.toFixed(0)}`);
}

// --- the pool ledger -------------------------------------------------------
// A pool dot pays out over its own tick schedule, DurationBased-style: each
// feed redistributes what is still owed over a fresh window, and what the bell
// catches un-ticked is dropped - a damage meter never saw it. Crediting the
// whole bank read a 3-second fight four ticks rich.
group('the pool ledger');
{
  const prof = (id, cooldown, occ, extra = {}) => ({
    id, name: id, cooldown, occupancy: occ, charges: 1, isCombo: false, type: 'ClassSkill',
    costs: [], ...extra,
  });
  const mkPool = (from, own) => ({
    from, fromName: from, status: from + '_Pool', name: from + ' pool', to: 'Target',
    types: ['Bleed'], tick: 2, duration: 8, stacks: -1, stacking: 'DurationBased',
    pool: { fraction: 0.5, own, crit: true, physical: true, magic: false, excludesDot: true },
    trigger: { on: 'cast', chance: 1 },
    on: 'cast', chance: 1,
  });
  const cast = (p) => p.id === 'Hit'
    ? { damage: 100, heal: 0, shield: 0, critPhysical: 100, totalPhysical: 100 }
    : p.id === 'Big'
      ? { damage: 1000, heal: 0, shield: 0, critPhysical: 1000, totalPhysical: 1000 }
      : { damage: 0, heal: 0, shield: 0 };
  const dotOutput = () => ({ damage: 0, heal: 0 });
  const base = {
    filler: [], triggered: [], passive: [], unmodelled: [], runes: [], rank: 3,
  };

  // One cast at t=0, an 8s/2s bleed, a 3-second fight: one tick lands, so a
  // quarter of the owed 100 is paid - 50 fraction on that is 12.5, not 50.
  {
    const rotation = {
      ...base,
      active: [{ prof: prof('Hit', 100, 0.5), source: 't', applies: { self: [], target: [] } }],
      dots: [mkPool('Hit', false)],
    };
    const short = simulate({ rotation, cast, dotOutput, fight: 3 });
    const poolLine = (r) => r.lines.find((l) => l.id === 'Hit_Pool');
    near('a short fight pays only the ticks that landed',
      poolLine(short)?.perCast.damage ?? 0, 12.5, 0.01);
    // Over a fight long against the window, nearly everything is paid.
    const rot2 = {
      ...base,
      active: [{ prof: prof('Hit', 5, 0.5, { charges: 1 }), source: 't', applies: { self: [], target: [] } }],
      dots: [mkPool('Hit', false)],
    };
    const long = simulate({ rotation: rot2, cast, dotOutput, fight: 200 });
    const paid = poolLine(long)?.perCast.damage ?? 0;
    // A 5s cooldown with 0.5s occupancy casts every 5s: 40 casts, 2000 owed.
    const fedHalf = 0.5 * 100 * 40;
    ok('a long fight converges on the whole share', paid > fedHalf * 0.85 && paid <= fedHalf + 1,
      `${paid.toFixed(0)} of ${fedHalf.toFixed(0)}`);
  }

  // An `own` pool eats only its own skill's output: Big crits ten times harder,
  // and none of it may leak into Hit's per-skill pool.
  {
    const rotation = {
      ...base,
      active: [
        { prof: prof('Hit', 20, 0.5), source: 't', applies: { self: [], target: [] } },
        { prof: prof('Big', 20, 0.5), source: 't', applies: { self: [], target: [] } },
      ],
      dots: [mkPool('Hit', true)],
    };
    const r = simulate({ rotation, cast, dotOutput, fight: 200 });
    const pool = r.lines.find((l) => l.id === 'Hit_Pool');
    const hits = r.lines.find((l) => l.id === 'Hit');
    ok('an own pool is fed by its own skill alone',
      pool && hits && pool.perCast.damage < hits.perCast.damage * (r.fight ?? 200),
      JSON.stringify({ pool: pool?.perCast.damage, why: pool?.why }));
    ok('...and says so', pool?.why.includes('dealt by itself'), pool?.why);
    // 10 casts of 100, half owed to the pool, everything ticked out: ~500.
    const total = pool?.perCast.damage ?? 0;
    ok('...and the number is its own share, not the rotation\'s',
      total > 350 && total < 550, String(total));
  }
}

// --- the fight plays for the goal ------------------------------------------
// The derived player used to maximise dps+hps+sps whatever the caller asked,
// so a dps query on a Priest spent GCDs on heals - and the best-of-two pick
// could keep the branch that healed more and damaged less.
group('the fight plays for the goal');
{
  const prof = (id, cooldown, occ) => ({
    id, name: id, cooldown, occupancy: occ, charges: 1, isCombo: false, type: 'ClassSkill', costs: [],
  });
  const cast = (p) => p.id === 'Nuke' ? { damage: 1000, heal: 0, shield: 0 }
    : p.id === 'Mend' ? { damage: 0, heal: 5000, shield: 0 }
      : { damage: 10, heal: 0, shield: 0 };
  const dotOutput = () => ({ damage: 0, heal: 0 });
  const rotation = {
    active: [
      { prof: prof('Mend', 10, 1), source: 't', applies: { self: [], target: [] } },
      { prof: prof('Nuke', 10, 1), source: 't', applies: { self: [], target: [] } },
    ],
    filler: [{ prof: prof('Swing', 0, 1), applies: { self: [], target: [] } }],
    triggered: [], passive: [], dots: [], unmodelled: [], runes: [], rank: 3,
  };
  const dps = simulate({ rotation, cast, dotOutput, fight: 120, goal: 'dps' });
  const all = simulate({ rotation, cast, dotOutput, fight: 120 });
  ok('a dps fight spends no time healing', dps.hps === 0, String(dps.hps));
  ok('...and gets at least the blended fight\'s damage', dps.dps >= all.dps - 1e-9,
    `${all.dps.toFixed(1)} -> ${dps.dps.toFixed(1)}`);
  ok('with no goal, everything still counts', all.hps > 0, String(all.hps));
  const hps = simulate({ rotation, cast, dotOutput, fight: 120, goal: 'hps' });
  ok('an hps fight heals more than the blend', hps.hps >= all.hps, `${all.hps.toFixed(1)} -> ${hps.hps.toFixed(1)}`);
}

// --- live resource gain factor ---------------------------------------------
// `attribute.gainAtb` is a multiplier on INCOME and it is a live stat:
// Warrior_BerserkStatus carries RageGainFactor ARatio +1, so Rage earned
// inside a Berserk window doubles. Frozen at the resting sheet's 1, the
// doubling never applied - and the shortfall sat exactly inside the +20%
// window where a Rage spender is worth most.
group('live resource gain factor');
{
  const eng = createEngine({ quiet: true });
  const st = eng.cdb.byId('skill').get('Warrior_BerserkStatus');
  const aff = (st?.affixes ?? []).find((a) => a.target?.attribute === 'RageGainFactor');
  ok('Warrior_BerserkStatus declares the doubling', !!aff && aff.val === 1 && /ARatio/.test(aff.ref),
    JSON.stringify(aff ?? null));

  const prof = (id, cooldown, occ, extra = {}) => ({
    id, name: id, cooldown, occupancy: occ, charges: 1, isCombo: false, type: 'ClassSkill',
    costs: [], ...extra,
  });
  const BUFF = { status: 'Berserk', duration: 6, stacks: 1, affixes: [] };
  const cast = (p) => p.id === 'Spend' ? { damage: 500, heal: 0, shield: 0 }
    : p.id === 'Roar' ? { damage: 0, heal: 0, shield: 0 }
      : { damage: 10, heal: 0, shield: 0 };
  const dotOutput = () => ({ damage: 0, heal: 0 });
  const rotation = {
    active: [
      { prof: prof('Roar', 30, 0.5), source: 't', applies: { self: [BUFF], target: [] } },
      { prof: prof('Spend', 0, 0.5, { costs: [{ atb: 'Rage', amount: 10 }] }), source: 't', applies: { self: [], target: [] } },
    ],
    filler: [{ prof: prof('Swing', 0, 1), applies: { self: [], target: [] } }],
    triggered: [], passive: [], dots: [], unmodelled: [], runes: [], rank: 3,
    resources: { tracked: ['Rage'], gains: [{ atb: 'Rage', amount: 1, on: 'attack', from: 'income', chance: 1 }] },
  };
  const run = (poolFactor) => simulate({
    rotation, cast, dotOutput, fight: 200,
    timedBuffs: [{ status: 'Berserk' }],
    resources: { Rage: { max: 20, start: 0, factor: 1, gainAtb: 'RageGainFactor' } },
    poolFactor,
  });
  const flat = run(null);
  const live = run((atb, state) => state.key.includes('Berserk') ? 2 : 1);
  ok('income earned inside the window doubles',
    live.dps > flat.dps, `${flat.dps.toFixed(1)} -> ${live.dps.toFixed(1)}`);
}

// --- the idle wake ---------------------------------------------------------
// A cast blocked only by its POOL comes back when income does. The idle branch
// used to wake only for cooldown timers, so a build with no filler slept to
// the bell on a full bank of Rage income: 0 casts where the income funds ~6.
group('the idle wake');
{
  const prof = (id, cooldown, occ, extra = {}) => ({
    id, name: id, cooldown, occupancy: occ, charges: 1, isCombo: false, type: 'ClassSkill',
    costs: [], ...extra,
  });
  const cast = (p) => p.id === 'Spend' ? { damage: 100, heal: 0, shield: 0 } : { damage: 0, heal: 0, shield: 0 };
  const dotOutput = () => ({ damage: 0, heal: 0 });
  const rotation = {
    active: [
      { prof: prof('Spend', 0, 0.5, { costs: [{ atb: 'Rage', amount: 10 }] }), source: 't', applies: { self: [], target: [] } },
    ],
    filler: [],
    triggered: [], passive: [], dots: [], unmodelled: [], runes: [], rank: 3,
    resources: { tracked: ['Rage'], gains: [{ atb: 'Rage', amount: 1, on: 'time', every: 3, from: 'income' }] },
  };
  const r = simulate({
    rotation, cast, dotOutput, fight: 200,
    resources: { Rage: { max: 20, start: 0, factor: 1 } },
  });
  // 1 Rage per 3s is 66 Rage in 200s: six casts of ten, with rounding slack.
  const total = r.dps * 200;
  ok('a fillerless build wakes for pool income', total >= 500 && total <= 700,
    `${total.toFixed(0)} damage = ${(total / 100).toFixed(1)} casts`);
}

// --- a cooldown-gated proc -------------------------------------------------
// Dominion's passive fires its bonus hit on the FIRST combo finisher each
// cooldown - `consumeCooldown()` in the script, `props.cooldown` 15 on the
// row - which is also the shape of the weapon-upgrade star procs. The gate
// rides the trigger machinery: between fires, events pass through untouched.
group('a cooldown-gated proc');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3 };
  l.gear.Slot_OffhandWeapon = { item: 'Shield_Craft', rarity: 'Rare', stars: 3 };
  eng.plan.pruneSelection(l);
  const rot = eng.plan.resolve(l, 3);
  const t = rot.triggered.find((x) => x.prof.id === 'Shield_Craft_Passive');
  ok('Dominion\'s passive is a triggered skill now', !!t);
  ok('...gated by its own cooldown', t?.rule.cooldownGate === 15, String(t?.rule.cooldownGate));
  ok('...riding the combo finisher', t?.rule.kind === 'per-combo', t?.rule.kind);
  const ev = eng.evaluate(l, { target: eng.combat.foe('boss', 25), rank: 3 });
  // Dominion's damage is an `on: Code` step, so the line the fight reports is
  // named for the step its script plays rather than for the passive itself.
  const line = ev.throughput.lines.find((x) => x.id.startsWith('Shield_Craft_Passive'));
  ok('...and it fires in the fight, no faster than the gate', !!line && line.interval >= 15,
    line ? `every ${line.interval.toFixed(1)}s` : 'no line');

  // Block-gated skills are the same refusal as crowd control, said plainly.
  const l2 = emptyLoadout(eng.cat, 'Warrior', 25);
  l2.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3 };
  l2.gear.Slot_OffhandWeapon = { item: 'Shield_Firebreath', rarity: 'Rare', stars: 3 };
  eng.plan.pruneSelection(l2);
  const ev2 = eng.evaluate(l2, { target: eng.combat.foe('boss', 25), rank: 3 });
  ok('a block-fed passive is refused as "foe is passive", not "no rate"',
    ev2.throughput.unmodelled.some((u) => u.id === 'Shield_Firebreath_Passive' && u.kind === 'foe is passive'),
    JSON.stringify(ev2.throughput.unmodelled.filter((u) => /Firebreath/.test(u.id)).map((u) => u.kind)));
}

// --- the free node travels with the sigil ----------------------------------
// The augment hill-climb swaps sigil variants, and the accepted build must
// carry the NEW sigil's granted talent - not the old one's. A sweep exported
// a seventeen-point allocation holding Surge of Violence next to an Infused
// Wounds sigil because acceptance updated the augment and not the grant.
group('the free node travels with the sigil');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  l.gear.Slot_Weapon2 = { item: 'Spear_Goo', rarity: 'Legendary', stars: 5 };
  const res = optimize(eng, {
    loadout: l, pinnedGear: new Set(['Slot_Weapon1', 'Slot_Weapon2']), pinnedAug: new Set(),
    goal: 'dps', target: eng.combat.foe('boss', 25), rank: 3, restarts: 3,
    allowEmpty: true, exclude: /^GM_/, rarityRoll: true,
  });
  const tree = eng.talents.treeFor('Warrior');
  const granted = new Set();
  for (const v of Object.values(res.loadout.augments)) {
    if (!v) continue;
    for (const sk of eng.cat.itemById.get(v)?.skills ?? []) if (tree.byId.has(sk)) granted.add(sk);
  }
  const paid = Object.entries(res.loadout.talents)
    .filter(([k]) => !granted.has(k)).reduce((s, [, v]) => s + v, 0);
  ok('every socketed sigil\'s talent is in the build', [...granted].every((g) => res.loadout.talents[g] >= 1),
    [...granted].join(','));
  ok('no stale grant inflates the paid total', paid <= 16, `${paid} paid points`);
  ok('the allocation is legal against the ACTUAL sigil - granted outright, no threshold',
    eng.talents.illegalAllocation('Warrior', res.loadout.talents, { level: 25, points: 16, granted }) === null,
    String(eng.talents.illegalAllocation('Warrior', res.loadout.talents, { level: 25, points: 16, granted })));
}

// --- cooldown mutations ----------------------------------------------------
// "Reset Bonethrow when Tear crits" is worth more than most damage riders on
// a skill-bound class. The explicit-target family - resetCooldown(Skill.X),
// reduceCooldown(Skill.X, vars.t) - is read with the same guard discipline a
// proc gets, and the fight fires them with deterministic thinning: a
// 30%-per-combo reset lands once every ~3.3 combos, never "30% of a reset".
group('cooldown mutations');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3 };
  eng.plan.pruneSelection(l);
  const rot = eng.plan.resolve(l, 3);
  const mu = (rot.cdMutations ?? []).find((x) => x.target === 'Axe_Boomerang_Skill1');
  ok('Tear\'s reset of Bonethrow is read', !!mu, JSON.stringify(rot.cdMutations ?? []));
  ok('...gated on the critical strike its script names', mu?.critGated === true && mu?.kind === 'reset');
  ok('...riding Tear\'s own hits', mu?.on === 'host' && mu?.host === 'Axe_Boomerang_Combo');
  const ev = eng.evaluate(l, { target: eng.combat.foe('boss', 25), rank: 3 });
  const bone = ev.throughput.lines.find((x) => x.id === 'Axe_Boomerang_Skill1');
  ok('...and Bonethrow casts faster than its cooldown alone allows',
    !!bone && bone.interval < 14.29, bone ? `${bone.interval.toFixed(2)}s` : 'no line');

  // A kill-driven reset (Rampage resets Shockwave at rank 3, onKill) is an
  // event this fight does not produce, and is refused with that reason.
  const l2 = emptyLoadout(eng.cat, 'Warrior', 25);
  l2.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Rare', stars: 3 };
  eng.plan.pruneSelection(l2);
  const rot2 = eng.plan.resolve(l2, 3);
  ok('a kill-driven reset is refused, not invented',
    !(rot2.cdMutations ?? []).some((x) => x.target === 'GA_Craft_Skill2')
    && rot2.unmodelled.some((u) => u.id === 'GA_Craft_Skill1' && /onKill/.test(u.why)),
    JSON.stringify(rot2.unmodelled.filter((u) => u.id === 'GA_Craft_Skill1').map((u) => u.why)));
}

// --- a guarded self-buff is refused ----------------------------------------
// Ram Veil's +5 CritChance / +5 Fervor lands only when a max-stacked
// Benediction is CONSUMED - `hasStatusMaxStacked` in as many words - and the
// entry used to ship without the guard, so the buff was credited on every
// cast at ~100% uptime. Refused and named instead.
group('a guarded self-buff is refused');
{
  const eng = createEngine({ quiet: true });
  const st = eng.plan.statusesOf('Mace_Benediction_Skill1', { rank: 3 });
  ok('Ram Veil\'s buff is not a self entry', !st.self.some((b) => b.status === 'Mace_Benediction_Skill1_Status'),
    JSON.stringify(st.self.map((b) => b.status)));
  const refused = st.unreadable.find((u) => u.status === 'Mace_Benediction_Skill1_Status');
  ok('...it is refused and NAMED', !!refused && /hasStatusMaxStacked/.test(refused.why), refused?.why);

  // ...and a build that slots the skill says so in its coverage report.
  const l = emptyLoadout(eng.cat, 'Priest', 25);
  l.gear.Slot_Weapon1 = { item: 'Mace_Benediction', stars: 0 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target: eng.combat.foe('boss', 25), rank: 3 });
  ok('the refusal reaches the coverage report',
    ev.throughput.unmodelled.some((u) => u.kind === 'buff refused' && u.id === 'Mace_Benediction_Skill1_Status'),
    JSON.stringify(ev.throughput.unmodelled.filter((u) => u.kind === 'buff refused')));
}

// --- the base-attack chain -------------------------------------------------
// `moveSet.comboLength` is the authored length of a weapon's chain, and it went
// unread for long enough that two weapons were swinging a chain shorter than
// the game gives them. The combo finisher is what charges a Priest's prayers
// and what every isFinalCombo guard rolls against, so a short chain fires all
// of them too often - and short is the FLATTERING direction, which is the one
// to assert against.
group('the base-attack chain');
{
  const eng = createEngine({ quiet: true });
  const T = eng.cdb.enumValues('skill', 'type');
  const typeOf = (id) => T[eng.cdb.byId('skill').get(id)?.type ?? -1] ?? null;
  const moveSets = eng.cdb.byId('moveSet');

  let checked = 0, short = 0;
  const shortNames = [];
  for (const it of eng.cat.items) {
    if (!it.moveSet) continue;
    const want = moveSets.get(it.moveSet)?.comboLength ?? 0;
    if (!want) continue;
    const chain = eng.plan.baseChain(it);
    if (!chain.links.length) continue;
    checked++;
    if (chain.links.length !== want) { short++; shortNames.push(`${it.id} ${chain.links.length}/${want}`); }
  }
  ok('every weapon with a moveSet was resolved', checked > 20, `${checked} checked`);
  // Net_Basic is a capture net: comboLength 4, one Net_Capture step, and no
  // chain rows anywhere that fit. It is the only weapon allowed to disagree.
  ok('every weapon swings the chain its moveSet declares', short <= 1,
    shortNames.join(', '));

  // The two that needed filling, by name, so a patch that authors the missing
  // links properly shows up here rather than silently.
  const flamie = eng.cat.itemById.get('Scepter_Flamie');
  if (flamie) {
    const c = eng.plan.baseChain(flamie);
    ok('Scepter_Flamie swings a 4-link chain', c.links.length === 4, c.links.join(','));
    ok('...two of which its own item row omits', c.filled.length === 2,
      c.filled.map((f) => f.skill).join(','));
  }
  const dm = eng.cat.itemById.get('DM_Multispin');
  if (dm) {
    const c = eng.plan.baseChain(dm);
    ok('DM_Multispin swings a 5-link chain', c.links.length === 5, c.links.join(','));
  }

  // Order is part of the model: you cannot press swing 3 without 1 and 2, and
  // the combo is always the finisher.
  for (const id of ['Sword_Start', 'Scepter_Flamie', 'DM_Multispin', 'Bow_Craft']) {
    const it = eng.cat.itemById.get(id);
    if (!it) continue;
    const links = eng.plan.baseChain(it).links;
    ok(`${id}: the combo is last in the chain`,
      links.length > 0 && COMBO_LAST(links, typeOf), links.map(typeOf).join(','));
    ok(`${id}: the swings are in slot order`, SLOT_ORDER(links, typeOf), links.map(typeOf).join(','));
  }
  function COMBO_LAST(links, tp) {
    return links.every((id, i) => (tp(id) === 'AttackCombo') === (i === links.length - 1));
  }
  // Non-decreasing, not strictly increasing: every staff declares two swings
  // that are BOTH typed `Attack` (Staff_Base_Attack and Staff_Base_Attack2, and
  // no Attack2 row exists for staffs at all), so a slot can legitimately hold
  // more than one link and the item's own order decides between them.
  function SLOT_ORDER(links, tp) {
    const order = ['Attack', 'Attack2', 'Attack3', 'Attack4'];
    const idx = links.slice(0, -1).map((id) => order.indexOf(tp(id)));
    return idx.every((v, i) => v >= 0 && (i === 0 || v >= idx[i - 1]));
  }
}

// --- guards the script states, beyond the event ----------------------------
group('script guards');
{
  const eng = createEngine({ quiet: true });
  const none = { runes: new Set(), talents: new Set() };
  const has = (id, rank) => new Set(eng.plan.statusesOf(id, { rank, ...none }).all);

  // `rank >= N` in a script is the weapon-skill rank, the same number --rank
  // resolves everywhere else. Reading the event and ignoring the rank rider
  // handed a rank-1 character an upgrade it has not earned.
  ok('Sword_Swarm_Passive: its poison is rank 3 only',
    !has('Sword_Swarm_Passive', 1).has('Sword_Swarm_Passive_Poison')
    && has('Sword_Swarm_Passive', 3).has('Sword_Swarm_Passive_Poison'));
  ok('Bow_Craft_Passive: its status is rank 3 only',
    !has('Bow_Craft_Passive', 1).has('Bow_Craft_Passive_Status')
    && has('Bow_Craft_Passive', 3).has('Bow_Craft_Passive_Status'));
  // ...and the swarm itself is NOT rank-gated, so the gate must not be blanket.
  ok('Sword_Swarm_Passive: the swarm itself is not rank-gated',
    has('Sword_Swarm_Passive', 1).has('Sword_Swarm_Passive_Swarm'));

  // A closed sibling branch takes its HEADER with it. Bow_BigGame_Passive marks
  // its target in an `else if`, and the `if` above it asks hasStatus() - which
  // is not a condition on the mark.
  const bigGame = eng.plan.statusesOf('Bow_BigGame_Passive', { rank: 3, ...none });
  ok('Bow_BigGame_Passive: the mark is not credited to the other branch\'s guard',
    bigGame.all.includes('Bow_BigGame_Passive_Status'));

  // And a guard the reader genuinely cannot evaluate refuses the rate rather
  // than approximating it. DA_Water_Combo_PassiveRank3 rolls 0.35 per swing,
  // but only once its own buff is max-stacked.
  const l = emptyLoadout(eng.cat, 'Rogue', 25);
  l.gear.Slot_Weapon1 = { item: 'DA_Water', stars: 0 };
  eng.plan.pruneSelection(l);
  const r3 = eng.plan.resolve(l, 3);
  const r1 = eng.plan.resolve(l, 1);
  ok('rankPassives: the rank-3 passive exists only at rank 3',
    r3.unmodelled.concat(r3.triggered.map((x) => ({ id: x.prof.id })))
      .some((x) => x.id === 'DA_Water_Combo_PassiveRank3')
    && !r1.unmodelled.concat(r1.triggered.map((x) => ({ id: x.prof.id })))
      .some((x) => x.id === 'DA_Water_Combo_PassiveRank3'));
  ok('...and it is refused rather than scored at its bare vars.chance',
    r3.unmodelled.some((x) => x.id === 'DA_Water_Combo_PassiveRank3' && x.kind === 'conditional'),
    JSON.stringify(r3.unmodelled.find((x) => x.id === 'DA_Water_Combo_PassiveRank3') ?? null));
}

// --- rank and runes are two systems -----------------------------------------
// Confirmed in game: a weapon levels with kills and each of its skills -
// passives included - takes two upgrades, so a skill is rank 1..3 and a fully
// mastered weapon is every skill at 3. A CLASS skill does not rank; it takes a
// rune. The sheet keeps them completely apart, and one function resolves both,
// so an overlap would silently mix two namespaces.
group('mastery rank and runes');
{
  const T = cdb.enumValues('skill', 'type');
  const RANKED = new Set(['WeaponSkill', 'AttackCombo', 'WeaponPassive', 'Talent']);
  const RUNED = new Set(['ClassSkill', 'SignatureSkill']);
  const rankGated = (s) => (s.steps ?? []).some((st) => st.cond?.minRank != null || st.cond?.maxRank != null
      || st.cond?.equalRank != null)
    || (s.affixes ?? []).some((a) => a.conds?.minRank != null || a.conds?.maxRank != null
      || a.conds?.equalRank != null)
    || (s.props?.rankOverride ?? []).length > 0
    || (s.props?.rankPassives ?? []).length > 0;

  let both = 0, rankedElsewhere = 0, runedElsewhere = 0, ranked = 0, runed = 0;
  for (const s of cdb.lines('skill')) {
    const t = T[s.type ?? -1] ?? '(none)';
    const r = rankGated(s);
    const m = (s.mastery ?? []).length > 0;
    if (r && m) both++;
    if (r) { ranked++; if (t !== '(none)' && !RANKED.has(t)) rankedElsewhere++; }
    if (m) { runed++; if (!RUNED.has(t)) runedElsewhere++; }
  }
  ok('no skill is both rank-gated and rune-bearing', both === 0, `${both} are`);
  ok('rank gates live on weapon skills, combos, passives and talents',
    ranked > 100 && rankedElsewhere <= 1, `${rankedElsewhere} elsewhere of ${ranked}`);
  ok('runes live only on class and signature skills',
    runed > 20 && runedElsewhere === 0, `${runedElsewhere} elsewhere of ${runed}`);
  ok('every rune-bearing skill offers exactly three',
    cdb.lines('skill').every((s) => !(s.mastery ?? []).length || s.mastery.length === 3));

  // Two upgrades per skill is the ceiling the constant states.
  near('a skill has two upgrades above its base rank', K.weaponSkillMaxRank, 3);

  // A talent's rank is a DIFFERENT namespace, capped by its own column, so
  // resolving one at the weapon's rank would pass every minRank:2 rider free.
  const caps = cdb.lines('skill')
    .filter((s) => T[s.type ?? -1] === 'Talent')
    .map((s) => s.props?.talent?.maxPoints ?? 1);
  ok('a talent node holds at most two points, not three',
    caps.length > 50 && Math.max(...caps) === 2, `max ${Math.max(...caps)}`);
  ok('...and the weapon rank ceiling is higher than it', K.weaponSkillMaxRank > Math.max(...caps));
}

// --- how a modifier composes ------------------------------------------------
// The `affix` sheet states this and nothing read it, so two code paths had
// drifted into meaning different things by the same row.
group('affix stacking');
{
  const A = ctx.affix;
  ok('the four attribute affix refs are the ones the model knows',
    ['TAttribute_Flat', 'TAttribute_ARatio', 'TAttribute_MRatio', 'TAttribute_MRatioMin']
      .every((r) => A.kindOf(r)));
  ok('a row the sheet does not type as an attribute affix is ignored',
    A.kindOf('InventorySize_Flat') === null && A.kindOf('Invalid') === null);

  // Multiplicative REPLACES and compounds: 0.6 means "you take 60% of what you
  // would have", so reading it as (1 + 0.6) turns a 40% reduction into a 60%
  // increase - which is what one of the two paths was doing.
  near('MRatio compounds', A.composeMul('TAttribute_MRatio', 1, 0.6), 0.6);
  near('MRatio compounds twice', A.composeMul('TAttribute_MRatio', 0.6, 0.5), 0.3);
  // Min(base 1) takes the strongest and does NOT compound: two 30% slows are a
  // 30% slow.
  near('MRatioMin takes the strongest', A.composeMul('TAttribute_MRatioMin', 1, 0.7), 0.7);
  near('MRatioMin does not compound', A.composeMul('TAttribute_MRatioMin', 0.7, 0.7), 0.7);
  ok('the sheet still says so', ctx.affix.stacking.get('TAttribute_MRatioMin')?.case === 'Min'
    && ctx.affix.stacking.get('TAttribute_MRatio')?.case === 'Multiplicative');

  // A slot factor scales an additive value directly and blends a multiplier
  // toward 1. Scaling 0.6 by the arsenal's 0.4 gives 0.24, which is a bigger
  // reduction than the affix grants rather than a smaller one.
  near('a flat affix scales directly', A.scaleValue('TAttribute_Flat', 20, 0.4), 8);
  near('a multiplier blends toward 1', A.scaleValue('TAttribute_MRatio', 0.6, 0.4), 0.84);
  near('...and at full weight is itself', A.scaleValue('TAttribute_MRatio', 0.6, 1), 0.6);
}

// --- what the game says a status IS ----------------------------------------
group('status types');
{
  const eng = createEngine({ quiet: true });
  const flagNames = eng.cdb.enumValues('statusType', 'flags');
  const types = eng.cdb.byId('statusType');
  const flagsOf = (id) => {
    const r = types.get(id);
    return r ? flagNames.filter((_, i) => ((r.flags ?? 0) >> i) & 1) : [];
  };
  ok('statusType still carries the DoT/CC flags this reads',
    ['DoT', 'CrowdControl', 'HardCC', 'HoT'].every((f) => flagNames.includes(f)));
  ok('Bleed is typed a DoT', flagsOf('Bleed').includes('DoT'));
  ok('Stun is typed hard crowd control', flagsOf('Stun').includes('HardCC'));

  // The authored flag and the model's structural test - "a step carries
  // props.loop.tick" - must agree on the overwhelming majority, or one of the
  // two is being read wrong.
  let flagged = 0, agree = 0;
  for (const s of eng.cdb.lines('skill')) {
    const t = (s.props?.status?.types ?? []).map((x) => x.type);
    if (!t.length) continue;
    const f = new Set(t.flatMap(flagsOf));
    if (!(f.has('DoT') || f.has('HoT'))) continue;
    flagged++;
    if ((s.steps ?? []).some((x) => x.props?.loop?.tick != null)) agree++;
  }
  ok('the DoT flag and a loop.tick agree on almost every status',
    flagged > 20 && agree / flagged > 0.9, `${agree} of ${flagged}`);
}

// --- a talent that depends on another talent --------------------------------
// Four nodes across three trees do nothing at all unless a second node is
// taken, and they say so in script rather than in a column: the handler fires
// on `s.kind == <that status>`. The guard reader had no case for a status
// identity, so it evaluated to "unconditional" and Hold the Line was credited
// +6% damage and -6% damage taken whether or not Rage Shield was allocated.
group('a talent that needs another talent');
{
  const eng = createEngine({ quiet: true });
  const HTL = 'Warrior_Talent_HoldTheLine';
  const SHIELD = 'Warrior_Talent_RageShield';
  const alone = eng.talents.readableValue(HTL, 2, { have: new Set([HTL]) });
  const paired = eng.talents.readableValue(HTL, 2, { have: new Set([HTL, SHIELD]) });
  ok('Hold the Line grants nothing without Rage Shield',
    alone.buffs.length === 0 && !alone.readable, JSON.stringify(alone.buffs));
  ok('...and says which node it is waiting for',
    alone.needs.length === 1 && alone.needs[0].needs === 'Warrior_Talent_RageShield_Status',
    JSON.stringify(alone.needs));
  ok('...and grants its buff once Rage Shield is taken',
    paired.buffs.length === 1
    && paired.buffs[0].affixes.some((a) => a.target?.attribute === 'DamageModifier'),
    JSON.stringify(paired.buffs));

  // `.kind ==` is not one thing. Against `Steps.X` it dispatches on which step
  // of the skill's own cast fired - the step always runs - and refusing those
  // would delete real readings.
  const halos = eng.plan.statusesOf('Halos_Demon_Skill1', { rank: 3, talents: new Set() });
  ok('a step-identity comparison is not read as a dependency',
    halos.all.includes('Halos_Demon_Skill1_Shield'), JSON.stringify(halos.all));

  // Only a status whose appliers are ALL talent nodes can be ruled out: the
  // allocation is the complete list of those. `Priest_Prayer_Shield` is a
  // prayer, so Potent Fortitude stays credited rather than being refused on a
  // question the loadout cannot answer.
  const pf = eng.talents.readableValue('Priest_Talent_PotentFortitude', 1,
    { have: new Set(['Priest_Talent_PotentFortitude']) });
  ok('a dependency on something that is not a talent node stays unknown, not refused',
    pf.buffs.length > 0, JSON.stringify(pf.needs));
}

// --- an amount a script injects --------------------------------------------
// A `dynVal` effect declares no amount; the number arrives at runtime. Three of
// the fourteen sites in the sheet hand it something the data does carry, and
// two of those are Warrior runes that read as blanks without this.
group('script-injected amounts');
{
  const eng = createEngine({ quiet: true });
  // Both halves of a profile: the steps the cast plays, and the ones its own
  // script plays. Three of the four injections below sit on an `on: Code` step,
  // which is the only place a rune-supplied amount CAN sit - the rune decides
  // whether the script runs at all.
  const eff = (id, runes) => {
    const p = eng.combat.profile(id, 3, runes ? new Set(runes) : null);
    return [...(p?.effects ?? []), ...(p?.scripted ?? []).flatMap((st) => st.effects)];
  };
  const heal = (list) => list.find((x) => x.kind === 'Heal');
  ok('Ignore Pain heals nothing without Last Stand',
    heal(eff('Warrior_IgnorePain'))?.scaling.length === 0
    && heal(eff('Warrior_IgnorePain'))?.hasDynVal === true);
  const ls = heal(eff('Warrior_IgnorePain', ['Warrior_IgnorePain_M2']));
  ok('...and 35% of MaxHealth with it',
    ls && ls.scaling.length === 1 && ls.scaling[0].atb === 'MaxHealth'
    && Math.abs(ls.scaling[0].ratio - 0.35) < 1e-9, JSON.stringify(ls));
  const rage = (runes) => eff('Warrior_SurgingForce', runes).find((x) => x.kind === 'GainAtb');
  ok('Surging Force generates no Rage without Fury Pulse',
    rage(null)?.baseVal === 0 && rage(null)?.hasDynVal === true);
  ok('...and 1 Rage with it',
    Math.abs((rage(['Warrior_SurgingForce_M2'])?.baseVal ?? 0) - 1) < 1e-9);

  // The refusals. A share of the hit, a share of CURRENT health and a script
  // local accumulated over the cast are not numbers this has.
  ok('a share of current health is refused',
    heal(eff('Warrior_BerserkStatus', ['Warrior_Berserk_M2']))?.hasDynVal === true);
  ok('an injection behind a script-tracked cooldown is refused',
    heal(eff('Axe_Boomerang_Skill_Passive'))?.hasDynVal === true);
}

// --- a proc that rides a bleed tick ----------------------------------------
// `dmg.isStatusType(Hemorage)` says which damage EVENT this is, the way
// `isBaseAttack` does - not what is up right now. So the roll rides the bleed's
// own ticks, and reading it as a base-attack proc would have given it a rate
// several times too fast.
group('a proc on a bleed tick');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.talents = { Warrior_Hemorrhage: 1, Warrior_Talent_CrackingBlood: 1 };
  const rot = eng.plan.resolve(l, 3);
  // Its whole payload is one `on: Code` step, so the line is named for the step
  // the script plays rather than for the node - the node itself casts nothing.
  const cb = rot.triggered.find((t) => t.prof.id.startsWith('Warrior_Talent_CrackingBlood'));
  ok('Cracking Blood rolls on a bleed tick, not on a swing',
    cb && cb.rule.kind === 'per-dot-tick' && Math.abs(cb.rule.chance - 0.35) < 1e-9,
    JSON.stringify(cb?.rule));
  // Two skills in the sheet have this shape and both are Warrior talents. If a
  // patch adds more, this reader wants looking at again.
  let shaped = 0;
  for (const s of eng.cdb.lines('skill')) {
    if (typeof s.vars?.chance !== 'number' || !s.script) continue;
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const at = body.search(/checkProba\s*\(\s*vars\.chance/);
    if (at < 0) continue;
    if (/\w+\.isStatusType\s*\(\s*(?:StatusType\.)?(?:Bleed|Hemorage)\s*\)/.test(body.slice(0, at))) shaped++;
  }
  ok('only the two known skills roll against a bleed tick', shaped === 2, String(shaped));
}

// --- the tree the gear is fitted to -----------------------------------------
// The allocation heuristic ranks a point by the size of the numbers on it, and
// it used to count affixes, buffs and effects only - which is most of the
// Priest tree and almost none of the Warrior's. Hemorrhage, the root the whole
// class is built around, weighed exactly zero.
group('the talent heuristic sees the whole tree');
{
  const eng = createEngine({ quiet: true });
  const weigh = (id, rank = 1) => {
    const v = eng.talents.readableValue(id, rank);
    return { mods: v.mods.length, dots: v.dots.length, gains: v.gains.length };
  };
  const h = weigh('Warrior_Hemorrhage');
  ok('Hemorrhage declares a pool dot the allocation can weigh', h.dots === 1, JSON.stringify(h));
  ok('Sever declares a scoped modifier', weigh('Warrior_Talent_Sever').mods === 1);
  ok('Seasoned Soldier declares resource income',
    weigh('Warrior_Talent_SeasonedSoldier').gains === 1);
  const alloc = eng.talents.suggest('Warrior', { level: 25 });
  ok('a Warrior allocation spends every point on something readable',
    alloc.spent === alloc.budget && alloc.blind.length === 0,
    `${alloc.spent}/${alloc.budget}, blind ${alloc.blind.join(',')}`);
}

// --- stat profiles ----------------------------------------------------------
// A profile stands in place of the armour so a weapon or a rotation can be
// compared at a fixed corner. Its numbers are not invented: 1.0 of a group is
// exactly `budget(level, start, end)`, which is the same curve the gear layer
// uses, and the atbRatio sums asserted above are what make that a FULL SET.
group('stat profiles');
{
  const eng = createEngine({ quiet: true });
  const P = eng.profiles;
  const b = P.budgetsFor('Warrior', 25);

  ok('a full set is one primary budget', b.primary?.atb === 'Strength' && Math.abs(b.primary.amount - 123.6) < 0.5,
    JSON.stringify(b.primary));
  ok('...one ratings budget, whichever rating your factions pay',
    b.ratings.length === 3 && b.ratings.every((r) => Math.abs(r.amount - b.ratings[0].amount) < 1e-6),
    b.ratings.map((r) => `${r.atb} ${r.amount.toFixed(1)}`).join(', '));
  // Armor takes the runtime path, not the authored columns - the same rule the
  // rest of the model follows, and the Fighter is where the two disagree.
  const implied = resistForReduction(25, 0.4, eng.ctx.consts.resistFormula);
  ok('armor comes from props.armorReduction, not from aptitude.atbScaling',
    Math.abs(b.armor.amount - implied) < 1e-6, `${b.armor.amount.toFixed(1)} vs ${implied.toFixed(1)}`);
  // Vitality states its budget in MaxHealth and delivers it as Vitality, so the
  // conversion has to be looked up rather than assumed.
  ok('the vitality budget is delivered as Vitality, not as MaxHealth',
    b.vitality.atb === 'Vitality' && b.vitality.amount < 200, JSON.stringify(b.vitality));

  // PINNED, NOT EARNED. A profile states its stats as flat numbers - 50
  // everywhere, 100 on the one it names - and those REPLACE the level curve and
  // the gear. Two weapons are then compared on the kit they grant rather than on
  // which is the better stat stick, which a budget-denominated profile cannot
  // do: a Warrior's primary budget is 123.6 and a Rogue's is 148.3, so
  // "half a budget" carries the budget's own shape into the comparison.
  const mid = P.resolve('mid', 'Warrior', 25);
  const crit = P.resolve('crit', 'Warrior', 25);
  const zero = P.resolve('zero', 'Warrior', 25);
  ok('zero pins every stat to 0', [...zero.force.values()].every((v) => v === 0));
  ok('mid pins every stat to 50', [...mid.force.values()].every((v) => v === 50));
  ok('a peak profile raises exactly one stat and leaves the rest at 50', (() => {
    let peaked = 0;
    for (const [atb, v] of crit.force) {
      if (atb === 'CritChanceRating') { if (v !== 100) return false; peaked++; } else if (v !== 50) return false;
    }
    return peaked === 1;
  })(), JSON.stringify([...crit.force]));
  ok('the pinned set covers every stat the damage model reads',
    ['Strength', 'Dexterity', 'Intellect', 'Faith', 'Vitality', 'Armor',
      'CritChanceRating', 'ArmorPenetrationRating', 'SpellPenetrationRating', 'FervorRating']
      .every((a) => mid.force.has(a)), [...mid.force.keys()].join(','));
  ok('--profile-base and --profile-peak move both numbers', (() => {
    const r = P.resolve('crit', 'Warrior', 25, { base: 20, peak: 200 });
    return r.force.get('Strength') === 20 && r.force.get('CritChanceRating') === 200;
  })());
  ok('an unknown profile fails by name', (() => {
    try { P.resolve('nope', 'Warrior', 25); return false; } catch (e) { return /unknown profile/.test(e.message); }
  })());
  // A rig nobody can wear produces a dps nobody will see, and it must say so.
  ok('every profile says its numbers are stated rather than earned',
    P.list().every((p) => P.resolve(p.id, 'Warrior', 25).notes.length > 0));

  // It has to reach the sheet, and DERIVED stats have to follow it: pin
  // Dexterity and the CritChance that scales off it moves with it.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Rare', stars: 0 };
  const at = (p) => eng.evaluate({ ...l, profile: p }, { target: eng.combat.foe('boss', 25), rank: 3 });
  const evMid = at('mid');
  ok('a profile pins the sheet exactly, whatever the weapon adds',
    evMid.sheet.get('Strength') === 50 && evMid.sheet.get('CritChanceRating') === 50
    && evMid.sheet.get('Armor') === 50,
    [...P.pinned].map((a) => a + '=' + evMid.sheet.get(a)).join(' '));
  const evDex = at('dexterity');
  ok('...and everything derived from a pinned stat moves with it',
    evDex.sheet.get('Dexterity') === 100 && evDex.sheet.get('CritChance') > evMid.sheet.get('CritChance'),
    evMid.sheet.get('CritChance').toFixed(2) + ' -> ' + evDex.sheet.get('CritChance').toFixed(2));
  for (const [id, atb] of [['crit', 'CritChanceRating'], ['armorpen', 'ArmorPenetrationRating']]) {
    const peaked = at(id);
    let moved = 0;
    for (const a of P.pinned) if (peaked.sheet.get(a) !== evMid.sheet.get(a)) moved++;
    ok(id + ' moves exactly one pinned stat off mid', moved === 1, String(moved) + ' moved');
    ok('...and moves it upward', peaked.sheet.get(atb) > evMid.sheet.get(atb));
  }

  // Penetration has INCREASING returns - each point is worth more than the last
  // - which is why the gear search needs rating-themed seeds and why coordinate
  // ascent cannot walk from a crit set to a penetration one. Tested where the
  // claim actually lives, in the mitigation curve, rather than through a pair
  // of profiles that happen to differ in more than one way.
  const through = (pen) => 1 - damageReduction({
    resist: 1923, penetrationPct: pen, attackerLevel: 25, formula: eng.ctx.consts.resistFormula,
  });
  const step = (pen) => through(pen + 10) - through(pen);
  ok('each point of penetration is worth more than the last',
    step(0) < step(20) && step(20) < step(40) && step(40) < step(60),
    [0, 20, 40, 60].map((p) => step(p).toFixed(4)).join(' < '));
}

// --- a buff window prices only itself ---------------------------------------
// The fight re-prices a cast while a buff is up. It used to build that sheet
// from the accumulators AFTER the averaged sheet had folded every timed buff
// into them at its uptime - so the moment any window opened, every OTHER timed
// buff was credited on top of it. Pressing a button that does nothing for
// damage at all was then worth 3.4%, which is how the rotation search found it:
// it put `Ignore Pain` - zero damage, a DamageTakenModifier and nothing else -
// at the top of the priority list.
group('a buff window prices only itself');
{
  const eng = createEngine({ quiet: true, fight: { seconds: 200, targets: 1, lookahead: 0 } });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.profile = 'armorpen';
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  l.skills['class/ClassSkill'] = ['Warrior_Charge', 'Warrior_IgnorePain', 'Warrior_BattleShout', 'Warrior_Berserk'];

  const ev = eng.evaluate(l, { target, rank: 3 });
  const ids = ev.throughput.lines.filter((x) => x.kind === 'active').map((x) => x.id);
  ok('the probe build really does slot Ignore Pain', ids.includes('Warrior_IgnorePain'), ids.join(','));

  const withIt = derivedApl(ids);
  const without = { entries: withIt.entries.filter((x) => x.skill !== 'Warrior_IgnorePain'), excluded: [] };
  const dps = (apl) => eng.evaluate(l, { target, rank: 3, policy: makePolicy(apl) }).throughput.dps;
  const a = dps(withIt), b = dps(without);
  // Ignore Pain carries one affix, `DamageTakenModifier` MRatio 0.6, and deals
  // nothing. Pressing it can only COST damage - it spends half a second of a
  // full clock - so a build that presses it must never out-damage one that does
  // not. Any gain at all means a buff window is crediting something else.
  ok('pressing a zero-damage defensive cooldown never raises dps',
    a <= b + 1e-6, `with ${a.toFixed(2)} vs without ${b.toFixed(2)}`);
  // The cost is the clock PLUS the chain: a cast interrupts the base-attack
  // chain (reported from play), so pressing it also forfeits progress toward
  // the combo finisher. 0.5s every 50s is 1% of the clock; the chain loss
  // roughly doubles it. It must still be a small number, not a large one.
  ok('...and costs about what the clock and the dropped chain say it should',
    (b - a) / b > 0.001 && (b - a) / b < 0.045,
    `${(((b - a) / b) * 100).toFixed(2)}% for 0.5s + a chain restart every 50s of a 200s fight`);
}

// --- what you socket raises the host's gear level ---------------------------
// `Gear.getILevel@8123` is three lines, and the third - adding every socketed
// item's own iLevel - was the one nothing read. An Epic Corrupted Gift declares
// iLevel 10, so it is worth a whole effective level of stats on top of the
// affixes it swaps. Reported from play before the code was read.
group('a socketed gift raises the gear level');
{
  const eng = createEngine({ quiet: true });
  const censer = eng.cat.itemById.get('Staff_Censer');
  const at = (socketed) => eng.cat.effectiveLevel(censer, {
    charLevel: 25, stars: 3, rarity: 'Epic', level: 25, socketed,
  });
  // Twelve items in the game declare an iLevel among the augments, and they are
  // all Epic Corrupted Gifts. Assert that, so a patch that adds one is noticed.
  const withILevel = eng.cdb.lines('item')
    .filter((it) => /^Augment/.test(String(it.type)) && it.iLevel != null);
  ok('exactly the Epic Corrupted Gifts carry an iLevel',
    withILevel.length === 12 && withILevel.every((it) => it.type === 'AugmentDemon' && it.iLevel === 10),
    withILevel.map((it) => `${it.id}=${it.iLevel}`).join(', '));

  near('an Epic gift is worth a whole effective level',
    at(['DemonGearUpgrade_FervToCrit']) - at([]), 1, 1e-9);
  near('a Rare one is worth none of it - it declares no iLevel',
    at(['DemonGearUpgradeRare_FervToCrit']) - at([]), 0, 1e-9);
  near('two sockets stack, because the game sums the slots',
    at(['DemonGearUpgrade_FervToCrit', 'DemonGearUpgrade_APToCrit']) - at([]), 2, 1e-9);

  // ...and it reaches the sheet, which is the point.
  const l = emptyLoadout(eng.cat, 'Mage', 25);
  l.gear.Slot_Weapon1 = { item: 'Staff_Censer', rarity: 'Epic', stars: 3 };
  eng.plan.pruneSelection(l);
  const target = eng.combat.foe('boss', 25);
  const plain = eng.evaluate(l, { target, rank: 3 }).sheet;
  const sock = eng.socketsOf(l).find((s) => s.type === 'AugmentDemon');
  l.augments = { [sock.key]: 'DemonGearUpgrade_FervToCrit' };
  const gifted = eng.evaluate(l, { target, rank: 3 }).sheet;
  ok('a gift raises a stat line the gift does not even mention',
    gifted.get('Vitality') > plain.get('Vitality'),
    `${plain.get('Vitality')} -> ${gifted.get('Vitality')}`);
  ok('...and the affix it DOES mention still lands on top',
    gifted.get('CritChanceRating') > plain.get('CritChanceRating') + 40 - 1e-9,
    `${plain.get('CritChanceRating')} -> ${gifted.get('CritChanceRating')}`);
}

// --- the pool feed is not a subtotal ----------------------------------------
// The line used to read "35% of 11697 physical critical damage" beside a damage
// table that does not contain 11697, and a reader was right to try adding it up
// and fail. Two things separate the feed from the damage above it, and a third
// separates the feed from the pool's own total.
group('the pool feed says what it is');
{
  const eng = createEngine({ quiet: true, fight: { seconds: 75, lookahead: 8 } });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  l.talents = { Warrior_Hemorrhage: 1 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target, rank: 3 });
  const line = ev.throughput.lines.find((x) => x.id === 'Warrior_Hemorrhage_Status');
  ok('the probe build really does run Hemorrhage', !!line,
    ev.throughput.lines.map((x) => x.id).join(','));
  if (line) {
    ok('the feed says it is the crit-attributable share, not the whole',
      /crit-attributable share/.test(line.why), line.why);
    ok('...and that it is measured before DamageModifier',
      /before DamageModifier/.test(line.why), line.why);
    ok('...and refuses to be read as a subtotal of the lines above',
      /not a subtotal/.test(line.why), line.why);
    // Over a fight only a few times the bleed's own life, the tail the bell
    // catches is real and has to be reported rather than quietly dropped.
    const fed = Number(/of (\d+)/.exec(line.why)?.[1] ?? 0);
    ok('the feed is a real number', fed > 0, line.why);
    const dropped = Number(/; (\d+) of it was still owed/.exec(line.why)?.[1] ?? 0);
    ok('...and the un-ticked tail is named when it matters',
      dropped > 0 && dropped < fed, `dropped ${dropped} of ${fed}`);
    // The reconciliation the reader could not do: what the pool is worth is
    // (fed - dropped) x fraction, times whatever the bleed's own multipliers
    // are. Assert the bound, which is what makes the printed feed checkable.
    ok('...and the pool total is at least (fed - dropped) x 35%',
      line.perCast.damage >= (fed - dropped) * 0.35 - 1,
      `${line.perCast.damage.toFixed(0)} vs ${((fed - dropped) * 0.35).toFixed(0)}`);
  }
}

// --- the conduit gauge ------------------------------------------------------
// A conduit fires when Spark is SPENT from above the gauge threshold, and every
// equipped conduit fires at once. The model used to refuse all of them as "no
// trigger rate can be derived from the data" - it was derivable, it just needed
// the Spark pool simulated rather than a rate invented.
group('the conduit gauge');
{
  const eng = createEngine({ quiet: true });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Mage', 25);
  l.gear.Slot_Weapon1 = { item: 'Staff_Censer', rarity: 'Epic', stars: 3 };
  eng.plan.pruneSelection(l);
  const rot = eng.plan.resolve(l, 3);

  ok('the gauge is read off the constants, not written here', !!rot.sparkGauge,
    JSON.stringify(rot.sparkGauge));
  near('the threshold is Mage_Conduit_SparkBounds', rot.sparkGauge.ratio,
    eng.cdb.constantFloats('Mage_Conduit_SparkBounds')[0]);
  near('the finisher pays a flat cost with no cooldown term', rot.sparkGauge.finisherCost,
    eng.cdb.byId('constant').get('Mage_Spark_SpellCDCost_FinalCombo').v.int
      ?? eng.cdb.byId('constant').get('Mage_Spark_SpellCDCost_FinalCombo').v.float);

  const conduits = rot.triggered.filter((t) => t.rule.kind === 'per-conduit-trigger');
  ok('every equipped conduit gets the same rule', conduits.length >= 1,
    rot.triggered.map((t) => `${t.prof.id}:${t.rule.kind}`).join(','));

  // THE MEASUREMENT, reproduced as arithmetic. From a full pool of 100, paying
  // the finisher's flat 10, the pool reads 100/90/80/70/60 before five
  // successive spends - all strictly above 50 - and 50 before the sixth, which
  // is not. Measured in game 2026-08-02: exactly five stacks, then it stopped.
  {
    const ev = eng.evaluate(l, { target, rank: 3 });
    const max = ev.sheet.get('MaxSpark');
    near('a naked Mage carries 100 MaxSpark', max, 100);
    const { ratio, finisherCost } = rot.sparkGauge;
    let pool = max, fires = 0;
    while (pool / max > ratio + 1e-12) { fires++; pool = Math.max(0, pool - finisherCost); }
    ok('a full pool buys exactly the five triggers that were measured', fires === 5, String(fires));
    ok('...and the sixth spend starts at the threshold, which is not above it',
      Math.abs(pool - max * ratio) < 1e-9, String(pool));
  }

  // ...and the fight fires them, together, at a rate the income can support.
  const ev2 = eng.evaluate(l, { target, rank: 3 });
  const lines = ev2.throughput.lines.filter((x) => /Conduit/.test(x.id));
  ok('the fight fires the conduits', lines.length >= 1,
    ev2.throughput.lines.map((x) => x.id).join(','));
  // The cadence understanding moved with the income: RayOfSpark's SparkRegen
  // is played per CHANNEL TICK (script onHit, four a cast - 118 tick-plays
  // for 32 live presses), not once per cast, so a build that channels keeps
  // the pool above the bound and most spends fire - the live gauge read open
  // at 98.3% of presses. The invariant that survives is that conduits ride
  // SPEND EVENTS, not the GCD: never faster than a couple of seconds.
  ok('...on the spend cadence, not the GCD',
    lines.every((x) => x.interval > 1.5), lines.map((x) => `${x.id} every ${x.interval.toFixed(1)}s`).join(', '));

  // Conduit: Power stacks to 20 - confirmed in game, +10% MagicMastery when the
  // pool can feed it - but the gauge fires far too slowly to stand there, so
  // crediting the cap was the largest overstatement left in the class.
  const powerBuff = ev2.buffs.find((b) => b.status === 'Mage_Conduit_Power_Status');
  if (powerBuff) {
    ok('Conduit: Power is not credited at its cap', !(powerBuff.uptime > 0),
      JSON.stringify({ up: powerBuff.uptime, stacks: powerBuff.stacks }));
    ok('...and the refusal is named',
      ev2.throughput.unmodelled.some((u) => u.id === 'Mage_Conduit_Power_Status'),
      JSON.stringify(ev2.throughput.unmodelled.map((u) => u.id)));
  }
}

// --- a proc that refuses to re-apply itself ---------------------------------
// `!owner.hasStatus(X)` where X is the very status the call applies is not a
// question about live state - it is the applier declining to renew its own
// buff, which makes the uptime an alternating renewal process rather than a
// refresh. Read as unreadable, all four trinket Stones scored exactly zero.
group('a proc that blocks its own renewal');
{
  const eng = createEngine({ quiet: true });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  eng.plan.pruneSelection(l);
  const before = eng.evaluate(l, { target, rank: 3 });

  l.gear.Slot_Trinket = { item: 'StoneOfPower', rarity: 'Rare', stars: 0 };
  const ev = eng.evaluate(l, { target, rank: 3 });
  const b = ev.buffs.find((x) => x.status === 'StoneOfPower_Trinket_Status');
  ok('the Stone\'s buff is read at all', !!b, ev.buffs.map((x) => x.status).join(','));
  ok('...and its guard is recognised as a self-block, not as live state',
    b?.reapply === 'blocked', JSON.stringify(b?.trigger));
  ok('...so it is no longer in the refusal list',
    !ev.throughput.unmodelled.some((u) => /StoneOfPower/.test(u.id)),
    JSON.stringify(ev.throughput.unmodelled.filter((u) => /Stone/i.test(u.id))));
  // The whole point: it must be worth something, and NOT its full value.
  ok('the Stone is worth more than nothing', ev.throughput.dps > before.throughput.dps,
    `${ev.throughput.dps.toFixed(2)} vs ${before.throughput.dps.toFixed(2)}`);
  ok('...and less than a permanent +10 Strength',
    (ev.sheet.get('Strength') - before.sheet.get('Strength')) < 10 - 1e-9,
    `+${(ev.sheet.get('Strength') - before.sheet.get('Strength')).toFixed(2)} Strength`);
  // The closed form, which is what makes it a number rather than a guess. A
  // blocked renewal is rD/(1+rD) and NEVER reaches 1; a refresh is 1-e^(-rD),
  // which does. Reading one as the other is a third of the answer.
  if (b?.proc) {
    const rd = b.proc.rate * b.duration;
    near('the blocked-renewal uptime is rD/(1+rD)', b.uptime, rd / (1 + rd), 1e-9);
    ok('...which is strictly below one however fast the procs come',
      b.uptime < 1 && b.uptime > 0, String(b.uptime));
  }

  // The two enchant rows the roadmap freezes must NOT be re-priced: they are
  // folded in permanent at the cap, and the cost of that is in the audit.
  const l2 = emptyLoadout(eng.cat, 'Warrior', 25);
  l2.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  eng.plan.pruneSelection(l2);
  const sock = eng.socketsOf(l2).find((s) => s.type === 'AugmentEnchantWeapon');
  if (sock) {
    l2.augments = { [sock.key]: 'FormulaWeaponZealot' };
    const ev2 = eng.evaluate(l2, { target, rank: 3 });
    const z = ev2.buffs.find((x) => x.status === 'Enchant_Zealot_Status');
    ok('Zealot is still read', !!z, ev2.buffs.map((x) => x.status).join(','));
    ok('...and is still folded in permanent at the cap, not thinned',
      !z || (z.uptime === 1 && !z.proc), JSON.stringify({ up: z?.uptime, proc: z?.proc }));
    ok('...at five stacks of +6 CritChanceRating',
      !z || z.stacks === 5, String(z?.stacks));
  }
}

// --- the stack counter ------------------------------------------------------
// `getStackFactor@20772` runs as the last line of `getStepEffectVal@20775` and
// multiplies a step effect by `Status.stacks` when the running skill is a
// Status that is either a DoT or carries the ScaleWithStacks flag. The model
// tracked whether a status was up and never how many, so five stacks of Lethal
// Poison were priced as one.
group('the stack counter');
{
  const eng = createEngine({ quiet: true });
  const cap = (id, rank = 1, ranks = null) => eng.plan.maxStacksOf(id, rank, ranks);

  // The base is `props.status.maxStacks`, DEFAULT 1 - not unlimited.
  near('Lethal Poison caps at the authored 5', cap('Rogue_Talent_LethalPoison_Status'), 5);
  // ...and its own script adds the rank of another talent.
  near('...and one more per point of Improved Mixture',
    cap('Rogue_Talent_LethalPoison_Status', 1, new Map([['Rogue_Talent_ImprovedMixture', 2]])), 7);
  // `maxStacks <= 0` is UNCAPPED, and the `?? 1` this replaced handed the
  // literal -1 into the affix scale - a buff worth minus its own value.
  ok('an authored -1 reads as uncapped, never as -1',
    cap('Warrior_Hemorrhage_Status') === Infinity, String(cap('Warrior_Hemorrhage_Status')));
  const bad = [];
  for (const s of eng.cdb.lines('skill')) {
    if (s.props?.status?.maxStacks == null) continue;
    const v = cap(s.id, 3);
    if (!(v >= 1)) bad.push(`${s.id}=${v}`);
  }
  ok('no status anywhere resolves to a cap below one', bad.length === 0, bad.join(', '));

  // A rank override replaces the cap, which is how Hysteria's counter drops
  // from 150 to 100 once the weapon skill is upgraded.
  near('Hysteria needs 150 stacks at rank 1', cap('GS_Nova_Passive_Stack', 1), 150);
  near('...and 100 from rank 2', cap('GS_Nova_Passive_Stack', 2), 100);

  // The fight: a stacked poison must be worth strictly more than one stack of
  // it and never more than its cap.
  const l = emptyLoadout(eng.cat, 'Rogue', 25);
  l.gear.Slot_Weapon1 = { item: 'Daggers_DuplicatePoison', rarity: 'Legendary', stars: 5 };
  eng.plan.pruneSelection(l);
  const rot = eng.plan.resolve(l, 3);
  const poison = rot.dots.find((d) => d.status === 'Daggers_DuplicatePoison_PassiveStatus');
  ok('the probe build really does apply the stacking poison', !!poison,
    rot.dots.map((d) => d.status).join(','));
  ok('a Bleed-typed DoT is flagged as scaling with its stacks', poison?.scaleByStacks === true);
  near('...and carries the cap the fight clamps to', poison?.stacks ?? 0, 5);

  const ev = eng.evaluate(l, { target: eng.combat.foe('boss', 25), rank: 3 });
  const line = ev.throughput.lines.find((x) => x.id === 'Daggers_DuplicatePoison_PassiveStatus');
  ok('the fight reports it', !!line, ev.throughput.lines.map((x) => x.id).join(','));
  if (line) {
    const m = /^(\d+) ticks of (\d+)/.exec(line.why);
    const ticks = Number(m?.[1] ?? 0);
    const perTick = Number(m?.[2] ?? 0);
    const oneStack = poison.prof ? null : null;
    ok('...at more than one stack a tick', ticks > 0 && perTick > 0
      && line.perCast.damage > ticks * 1e-9, line.why);
    ok('...and never above the cap', line.perCast.damage <= ticks * perTick * poison.stacks + 1e-6, line.why);
    ok('...and the line says how many stacks it averaged, and of how many',
      /a stack, [\d.]+ stacks on average of 5/.test(line.why), line.why);
    ok('...which is a number no bigger than the cap',
      Number(/([\d.]+) stacks on average/.exec(line.why)?.[1] ?? 0) <= 5, line.why);
    void oneStack;
  }

  // An uncapped DoT is the one case the count is NOT derivable: nothing in the
  // data bounds it, and over a 200-second fight an every-swing application
  // would reach two hundred stacks. Every uncapped DoT in the sheet is either a
  // pool - whose fed/owed ledger IS the count expressed as damage - or held at
  // one stack and named.
  {
    let checked = 0;
    for (const s of eng.cdb.lines('skill')) {
      if (!Number.isFinite(eng.plan.maxStacksOf(s.id, 3))) checked++;
    }
    ok('the sheet really does carry uncapped statuses', checked >= 5, String(checked));
    const l2 = emptyLoadout(eng.cat, 'Warrior', 25);
    l2.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3 };
    l2.talents = { Warrior_Hemorrhage: 1 };
    eng.plan.pruneSelection(l2);
    const rot2 = eng.plan.resolve(l2, 3);
    const uncapped = rot2.dots.filter((d) => !Number.isFinite(eng.plan.maxStacksOf(d.status, 3)));
    ok('this build really does run uncapped dots', uncapped.length > 0,
      rot2.dots.map((d) => d.status).join(','));
    ok('...and every one of them is a pool, so the ledger counts them, not a multiplier',
      uncapped.every((d) => !!d.pool), uncapped.map((d) => `${d.status}:${!!d.pool}`).join(','));
    ok('...so none of them is ALSO multiplied by a stack count',
      uncapped.every((d) => d.uncappedStacks !== true), JSON.stringify(uncapped.map((d) => d.status)));
  }
}

// --- what a rotation line is allowed to say ---------------------------------
// `buff.X.up` cannot say "will the window still be open when this lands", and
// `rage>=n` cannot say "press the generator before the bar caps". Both are
// ordinary rotation decisions and neither was expressible.
group('new APL atoms');
{
  // The evaluator, against a hand-built fight state - which is the only way to
  // assert the SEMANTICS rather than assert that some search happened to like
  // a condition.
  const buff = { status: 'S' };
  const debuff = { status: 'D' };
  const ctx = {
    ready: [0, 1],
    actives: [{ prof: { id: 'A' } }, { prof: { id: 'B' } }],
    t: 4,
    buffs: new Map([[buff, 10]]),
    debuffs: new Map([[debuff, 5]]),
    pools: new Map([['Rage', { value: 12 }]]),
    charges: (i) => (i === 0 ? 1 : 0),
    remains: (i) => (i === 0 ? 0 : 1.5),
  };
  const holds = (cond) => makePolicy({ entries: [{ skill: 'A', cond }], excluded: [] })(ctx) === 0;

  ok('buff.S.remains>=5 holds with 6 seconds left',
    holds({ kind: 'remains', on: 'buff', id: 'S', min: 5 }));
  ok('...and fails with 6 seconds left and 7 asked for',
    !holds({ kind: 'remains', on: 'buff', id: 'S', min: 7 }));
  ok('debuff.D.remains>=1 holds with 1 second left',
    holds({ kind: 'remains', on: 'debuff', id: 'D', min: 1 }));
  ok('a window that is not up has no time left at all',
    !holds({ kind: 'remains', on: 'buff', id: 'NOPE', min: 0.5 }));

  ok('rage<=12 holds at 12', holds({ kind: 'resource', atb: 'Rage', max: 12 }));
  ok('rage<=10 fails at 12', !holds({ kind: 'resource', atb: 'Rage', max: 10 }));
  ok('rage>=12 still holds at 12', holds({ kind: 'resource', atb: 'Rage', min: 12 }));

  ok('cd.B<=2 holds when B is 1.5s from coming back',
    holds({ kind: 'cd', id: 'B', max: 2 }));
  ok('cd.B<=1 fails when B is 1.5s away',
    !holds({ kind: 'cd', id: 'B', max: 1 }));
  // Ready counts as back-within-n, which is what makes cd a superset of ready
  // rather than a rival to it - and is why it is vacuous on its own line.
  ok('cd.A<=0.5 holds because A is ready now', holds({ kind: 'cd', id: 'A', max: 0.5 }));

  ok('the labels read the way a player would write them',
    condLabel({ kind: 'remains', on: 'buff', id: 'S', min: 2 }) === 'buff.S.remains>=2'
    && condLabel({ kind: 'cd', id: 'B', max: 1.5 }) === 'cd.B<=1.5'
    && condLabel({ kind: 'resource', atb: 'Rage', max: 10 }) === 'rage<=10'
    && condLabel({ kind: 'resource', atb: 'Rage', min: 10 }) === 'rage>=10');

  // A line that can never fire costs a whole fight to discover, so the search
  // must never be handed one.
  ok('rage>=10 & rage<=5 is refused as contradictory',
    contradictory(conjoin([{ kind: 'resource', atb: 'Rage', min: 10 },
      { kind: 'resource', atb: 'Rage', max: 5 }])));
  ok('...but rage>=5 & rage<=10 is a legal band',
    !contradictory(conjoin([{ kind: 'resource', atb: 'Rage', min: 5 },
      { kind: 'resource', atb: 'Rage', max: 10 }])));
  ok('buff.S.down & buff.S.remains>=1 is refused as contradictory',
    contradictory(conjoin([{ kind: 'buff', id: 'S', want: false },
      { kind: 'remains', on: 'buff', id: 'S', min: 1 }])));
}

// --- the same list, scored twice --------------------------------------------
group('the search remembers what it has played');
{
  const eng = createEngine({ quiet: true, fight: { seconds: 200, targets: 1, lookahead: 0 } });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.profile = 'armorpen';
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  const ev = eng.evaluate(l, { target, rank: 3 });
  const ids = ev.throughput.lines.filter((x) => x.kind === 'active').map((x) => x.id);
  const vocab = vocabularyFor(ev.rotation);
  ok('the vocabulary stays small enough to search exhaustively',
    vocab.length > 4 && vocab.length < 300, String(vocab.length));
  ok('...and it offers the new atoms', vocab.some((c) => c.kind === 'cd')
    && vocab.some((c) => c.kind === 'remains')
    && vocab.some((c) => c.kind === 'resource' && c.max != null),
    vocab.map((c) => c.kind).join(','));

  let real = 0;
  const score = (apl) => {
    real++;
    return eng.evaluate(l, { target, rank: 3, policy: makePolicy(apl) }).throughput.dps;
  };
  const got = searchApl({
    score, ids, vocabulary: vocab, restarts: 3, maxSteps: 5, startFrom: derivedApl(ids),
  });
  ok('a search of any size replays lists it has already played', got.cacheHits > 0, String(got.cacheHits));
  ok('...and only the misses reach the fight',
    real === got.evaluations, `${real} fights vs ${got.evaluations} reported`);
  ok('...and the reported total is what it considered',
    got.considered === got.evaluations + got.cacheHits, String(got.considered));
  ok('the memo never returns worse than the derived order',
    got.score >= eng.evaluate(l, { target, rank: 3, policy: makePolicy(derivedApl(ids)) }).throughput.dps - 1e-6);

  // Determinism survives the cache: the same seed has to re-derive, or a build
  // a user shares stops being reproducible.
  let real2 = 0;
  const again = searchApl({
    score: (apl) => { real2++; return eng.evaluate(l, { target, rank: 3, policy: makePolicy(apl) }).throughput.dps; },
    ids, vocabulary: vocab, restarts: 3, maxSteps: 5, startFrom: derivedApl(ids),
  });
  near('the same seed still re-derives the same score', again.score, got.score, 1e-9);
  ok('...and takes the same number of fights to do it', real2 === real, `${real2} vs ${real}`);
}

// --- a permanent aura survives its skill's refusal ---------------------------
// Bloodrage Aura declares two things: a heal played only from `on: Code` on a
// physical crit at rank >= 3, and an Aura step at Start with `duration: -1`
// carrying +5 CritChance for the wielder. The heal has no rate this reader can
// derive, so the WHOLE skill was refused and five points of crit went with it -
// on the one weapon in the game whose passive is a crit aura. Refusing the
// payload is right; refusing the stat that is on regardless is not.
group('a refused payload does not take its aura with it');
{
  const eng = createEngine({ quiet: true });

  // The amounts, straight off the status row, so a patch that retunes them
  // fails here rather than silently moving every Cheese Moon number.
  const aura = eng.cdb.byId('skill').get('Axe_Boomerang_Skill_Passive_Status');
  const vals = (aura?.affixes ?? []).filter((a) => a.target?.attribute === 'CritChance');
  ok('the aura is two rank-exclusive CritChance rows, 3 and 5',
    vals.length === 2 && vals.some((a) => a.val === 3 && a.conds?.maxRank === 1)
      && vals.some((a) => a.val === 5 && a.conds?.minRank === 2),
    JSON.stringify(vals.map((a) => [a.val, a.conds])));
  const step = (eng.cdb.byId('skill').get('Axe_Boomerang_Skill_Passive')?.steps ?? [])
    .find((s) => s.props?.status?.ref === 'Axe_Boomerang_Skill_Passive_Status');
  ok('...applied by a step that never expires', step?.duration === -1, String(step?.duration));

  const sheetAt = (rank) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3, level: 25 };
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank }).sheet;
  };
  // Two rank-gated rows move together on this axe, and the sum is the check:
  // the aura goes 3 -> 5 (+2) and the combo's own affix goes 0 -> 5 (+5).
  near('both rank-2 rows reach the sheet, whole',
    sheetAt(3).get('CritChance') - sheetAt(1).get('CritChance'), 7, 1e-9);

  // The bare axe, against the same build with no weapon at all: the aura is the
  // only flat CritChance either one grants.
  const naked = emptyLoadout(eng.cat, 'Warrior', 25);
  const bare = eng.evaluate(naked, { target: eng.combat.foe('dummy', 25), rank: 3 }).sheet;
  ok('and it is worth its whole 5 points over an empty hand',
    sheetAt(3).get('CritChance') > bare.get('CritChance') + 5 - 1e-9,
    `${bare.get('CritChance')} -> ${sheetAt(3).get('CritChance')}`);

  // ...while the payload it could not rate stays refused, and SAYS it kept the
  // stat. A refusal that hides a half-score is the bug this test exists for.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3, level: 25 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
  const row = (ev.rotation.unmodelled ?? []).find((u) => u.id === 'Axe_Boomerang_Skill_Passive');
  ok('the heal is still refused', !!row, JSON.stringify(row ?? null));
  ok('...and the refusal names what it kept',
    /CritChance it grants IS scored/.test(row?.why ?? ''), row?.why ?? '(none)');
}

// --- a stack counter has a rate, and it was always in the data ---------------
// "Nothing in the data says how many hits arm it" was false. `GS_Nova_Passive`
// banks one stack per non-DoT physical damage EVENT and converts at maxStacks -
// 100 from rank 2 - so the rate is `events / 100`, and the only thing missing
// was a fight that counted its own events.
group('a stack counter arms its follow-up at a readable rate');
{
  const eng = createEngine({ quiet: true });
  const all = eng.cdb.lines('skill').map((s) => s.id);
  const found = eng.plan.stackProcsOf(all, { rank: 3 });
  // Two authored shapes now, one row each: the event counter (Hysteria, one
  // stack per physical hit) and the timed pickup chain (the Censer's clouds,
  // one every vars.time seconds of combat, maxStacks to arm, the follow-up
  // named by the proc status's own skillOverride).
  ok('exactly two rows in the game carry a stack-proc shape', found.length === 2,
    JSON.stringify(found));
  const p = found.find((x) => x.from === 'GS_Nova_Passive');
  ok('...one is Hysteria arming Anger Release at 100',
    p && p.skill === 'GS_Nova_Ultimate' && p.cap === 100 && p.on === 'physicalHit',
    JSON.stringify(p));
  const c = found.find((x) => x.from === 'Staff_Censer_Passive');
  ok('...the other is the Censer arming its Ultimate at 10 pickups x 3s',
    c && c.skill === 'Staff_Censer_Ultimate' && c.cap === 10
      && c.on === 'timer' && c.period === 30,
    JSON.stringify(c));
  // The cap is rank-gated: 150 authored, 100 from rank 2 via rankOverride.
  near('the cap is the authored 150 at rank 1',
    eng.plan.stackProcsOf(all, { rank: 1 }).find((x) => x.from === 'GS_Nova_Passive').cap, 150, 1e-9);

  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GS_Nova', rarity: 'Legendary', stars: 5, level: 25 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
  const line = ev.throughput.lines.find((x) => x.id === 'GS_Nova_Ultimate');
  ok('it is scored in the fight', !!line && line.total.damage > 0, JSON.stringify(line ?? null));
  ok('...and no longer in the unscored list',
    !(ev.rotation.unmodelled ?? []).some((u) => u.id === 'GS_Nova_Ultimate'),
    (ev.rotation.unmodelled ?? []).map((u) => u.id).join(', '));

  // A COLD START. `floor` is what makes that honest: stacks short of the cap at
  // the bell are stacks nobody spent, and the status has no authored duration,
  // so in game they would have carried in from the previous pull.
  const hits = ev.throughput.lines.reduce((s, x) => s + (x.hits ?? 0), 0);
  ok('the fire count floors the events over the cap',
    Math.abs(line.total.damage / line.perCast.damage - Math.floor(line.total.damage / line.perCast.damage)) < 1e-6,
    `${line.total.damage} / ${line.perCast.damage}`);
  ok('...and the line says the start was cold', /cold start/.test(line.why ?? ''), line.why ?? '');
  // It is priced post-hoc, so it must still be inside the headline.
  near('a post-hoc line still counts toward dps',
    ev.throughput.lines.reduce((s, x) => s + (x.total?.damage ?? 0), 0),
    ev.throughput.dps * ev.throughput.fight, 1e-6);
  ok('there are enough events in a 200s fight to fire it', hits > 100, String(hits));
}

// --- a refusal inside an accounted skill is still a refusal ------------------
// The unscored list is per-SKILL, so a clause refused inside a skill the model
// DOES score landed nowhere: the damage was right, one line of the script was
// worth zero, and nothing said so. `GS_Nova_Combo` is the case - the greatsword
// finisher is scored every cycle and its rank-3 `reduceWeaponsCooldown(1.5)` is
// gated on `hasStatusMaxStacked`, correctly refused, and previously silent.
group('a clause refused inside a scored skill is reported');
{
  const eng = createEngine({ quiet: true });
  const build = (rank) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'GS_Nova', rarity: 'Legendary', stars: 5, level: 25 };
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank });
  };
  const ev = build(3);
  const gaps = (ev.throughput.unmodelled ?? []).filter((u) => u.kind === 'rider not read');
  ok("Mania's refused cooldown refund is now reported",
    gaps.some((g) => g.id === 'GS_Nova_Combo' && /cooldownPerTick 1\.5/.test(g.why)),
    gaps.map((g) => g.why).join(' | '));
  ok('...and the sentence says the skill itself IS scored',
    gaps.every((g) => /is scored, but/.test(g.why)), gaps.map((g) => g.why).join(' | '));
  ok('...while the skill stays out of the unscored list',
    !(ev.rotation.unmodelled ?? []).some((u) => u.id === 'GS_Nova_Combo'),
    (ev.rotation.unmodelled ?? []).map((u) => u.id).join(', '));

  // DEAD IS NOT A GAP. That rider is `rank >= 3`; at rank 1 it contributes
  // nothing in game either, so reporting it would be noise.
  ok('a rank-dead clause is not reported as a gap',
    !(build(1).throughput.unmodelled ?? []).some((u) => u.kind === 'rider not read'
      && u.id === 'GS_Nova_Combo'), 'reported at rank 1');
  // Nor is one behind a rune the build did not slot.
  const m3 = eng.plan.scriptGapsOf('Warrior_Rage_Strike', 3, { runes: new Set() });
  ok('a rune-gated clause is not a gap without the rune', m3.length === 0, JSON.stringify(m3));
  ok('...and is one with it',
    eng.plan.scriptGapsOf('Warrior_Rage_Strike', 3,
      { runes: new Set(['Warrior_RageStrike_M3']) }).length === 1);
}

// --- a refusal names who loses out -------------------------------------------
// Rampage's entry read "its script resets Shockwave's cooldown from a onKill
// hook", filed under Rampage - which reads as "Rampage is not scored". Rampage
// is scored, every cast. What is missing is a cooldown SHOCKWAVE never gets.
group('a conditional refusal names the beneficiary');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Epic', stars: 4, level: 25 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
  const row = (ev.rotation.unmodelled ?? []).find((u) => u.id === 'GA_Craft_Skill1');
  ok('Rampage still carries the entry', !!row, JSON.stringify(row ?? null));
  ok('...but it says Rampage itself is scored', /Rampage's own damage IS scored/.test(row?.why ?? ''),
    row?.why ?? '');
  ok('...and names Shockwave as the one that loses out',
    /Shockwave comes back slower/.test(row?.why ?? ''), row?.why ?? '');
}

// --- a cast is priced at PRESS, not at impact --------------------------------
// The v2 capture measured `GA_Craft_Skill1` fitting +-0.2% against the attacker
// state at press and +-4.6% against the state when its damage lands, 3.2-3.3s
// later, and filed it as owed to the model. It is not owed: `runFight` calls
// `hit(prof, now)` before `tickTo(end)` advances the clock, and `setUp` runs
// after - so a cast is already priced against the state it was pressed in.
//
// The observable form of that invariant is that a skill which buffs itself does
// not buff the cast that applies the buff. `GA_Craft_FinalCombo` is the case:
// it deals damage AND puts +4 PhysicalMastery on itself.
group('a cast is priced at press, so it cannot buff itself');
{
  const eng = createEngine({ quiet: true });
  const id = 'GA_Craft_FinalCombo';
  const st = eng.plan.statusesOf(id, { rank: 3 });
  const buff = (st.self ?? []).find((b) => b.status === 'GA_Craft_FinalCombo_Status');
  ok('the row still deals damage and buffs itself', !!buff
    && (eng.combat.profile(id, 3).effects ?? []).some((e) => e.kind === 'Damage'),
    JSON.stringify(buff?.affixes ?? null));

  // Priced with the buff and without it: the cast that APPLIES it must read the
  // lower number, because at press it is not up yet.
  const t = eng.combat.foe('dummy', 25);
  const prof = eng.combat.profile(id, 3);
  const base = new Map([['Strength', 100], ['CritDamage', 150], ['CritChance', 0],
    ['DamageModifier', 100], ['PhysicalMastery', 0]]);
  const withBuff = new Map(base).set('PhysicalMastery', 4);
  const at = (sheet) => {
    const o = eng.combat.castOutput(prof, sheet, t,
      { targets: 1, assume: eng.opts.assume, attackerLevel: 25 });
    return o.critRoll ? o.critRoll.fixed + o.critRoll.base : o.damage;
  };
  ok('the buff would raise it if it were up', at(withBuff) > at(base),
    `${at(base).toFixed(2)} -> ${at(withBuff).toFixed(2)}`);

  // ...and in the fight, the line reads the unbuffed value on its own cast.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Epic', stars: 4, level: 25 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target: t, rank: 3 });
  const line = ev.throughput.lines.find((x) => x.id === id);
  if (line) {
    ok('a self-buffing cast is not priced under its own buff',
      line.perCast.damage > 0, `${line.perCast.damage.toFixed(1)}`);
  }
}

// --- the damage repartition adds up ------------------------------------------
// `optimize` now leads with where the damage came from, so the column has to
// close on the overall. That took a real `total` on every line: reconstructing
// it as `perCast x fight/interval` reads 30% over, because for the chain
// `interval` is the CYCLE time while the chain only runs for its share of the
// clock. A reader adding the old column up was right to find it did not close.
group('damage per ability sums to the overall');
{
  const eng = createEngine({ quiet: true });
  for (const cls of ['Warrior', 'Rogue', 'Mage', 'Priest']) {
    const l = emptyLoadout(eng.cat, cls, 25);
    eng.plan.pruneSelection(l);
    const t = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 }).throughput;
    const sum = t.lines.reduce((s, x) => s + (x.total?.damage ?? 0), 0);
    near(`${cls}: the lines close on dps x fight`, sum, t.dps * t.fight, Math.max(1e-6, t.dps * 1e-9));
    ok(`${cls}: every line carries a total`,
      t.lines.every((x) => x.total && Number.isFinite(x.total.damage)),
      t.lines.filter((x) => !x.total).map((x) => x.id).join(', '));
  }

  // THE CHAIN REPORTS PER LINK. The aggregate row hid a named ability: a damage
  // meter listed "Mania" among its top rows and the model appeared not to have
  // it, when `GS_Nova_Combo` is the greatsword chain's fourth link and had been
  // scored all along with no way to see it.
  {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'GS_Nova', rarity: 'Legendary', stars: 5, level: 25 };
    eng.plan.pruneSelection(l);
    const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
    const filler = ev.throughput.lines.filter((x) => x.kind === 'filler');
    ok('the chain reports one line per link, not one aggregate',
      filler.length === 4 && !filler.some((x) => x.id === '(base attack chain)'),
      filler.map((x) => x.id).join(', '));
    ok('...and Mania is one of them by name',
      filler.some((x) => x.id === 'GS_Nova_Combo' && x.name === 'Mania'),
      filler.map((x) => `${x.id}=${x.name}`).join(', '));
    // The links do not fire equally often - a chain broken partway pays link 1
    // more than link 4 - so each carries its OWN recurrence, not the cycle's.
    const first = filler.find((x) => x.id === 'GS_Base_Attack');
    const last = filler.find((x) => x.id === 'GS_Nova_Combo');
    ok('a later link fires less often than an earlier one',
      last.hits < first.hits && last.interval > first.interval,
      `${first.hits} @ ${first.interval.toFixed(2)}s vs ${last.hits} @ ${last.interval.toFixed(2)}s`);
    // Splitting must not change what the chain is worth in total.
    near('the links still sum to the fight',
      ev.throughput.lines.reduce((s, x) => s + (x.total?.damage ?? 0), 0),
      ev.throughput.dps * ev.throughput.fight, 1e-6);
    near('...and their clock shares still sum to fillerShare',
      filler.reduce((s, x) => s + x.share, 0), ev.throughput.fillerShare, 1e-9);
  }

  // HITS is damage EVENTS, not casts. A dot's tick is one, a multi-hit skill
  // lands several per cast, and a cleave one per target - which is what a
  // damage meter counts and what the instrumented capture logs a row for.
  {
    const t2 = eng.evaluate(
      (() => { const b = emptyLoadout(eng.cat, 'Warrior', 25); eng.plan.pruneSelection(b); return b; })(),
      { target: eng.combat.foe('dummy', 25), rank: 3 }).throughput;
    ok('every damaging line carries a hit count',
      t2.lines.filter((x) => (x.total?.damage ?? 0) > 0)
        .every((x) => Number.isFinite(x.hits) && x.hits > 0),
      t2.lines.filter((x) => (x.total?.damage ?? 0) > 0 && !(x.hits > 0)).map((x) => x.id).join(', '));
    // A status ticking on a 2s grid for the whole fight lands fight/2 of them,
    // which is the arithmetic anyone would check first.
    for (const l of t2.lines.filter((x) => x.kind === 'over time')) {
      ok(`${l.name}: ticks are plausible for a ${t2.fight}s fight`,
        l.hits > 0 && l.hits <= t2.fight, `${l.hits} over ${t2.fight}s`);
    }
  }
  // ...and a multi-hit cast counts every hit, not the cast.
  {
    const p = eng.combat.profile('GS_Nova_Skill1', 3);
    const declared = (p.effects ?? []).filter((e) => e.kind === 'Damage')
      .reduce((s, e) => s + (e.hits ?? 1), 0);
    const o = eng.combat.castOutput(p,
      new Map([['Strength', 100], ['CritDamage', 150], ['CritChance', 0], ['DamageModifier', 100]]),
      eng.combat.foe('dummy', 25),
      { targets: 1, assume: eng.opts.assume, attackerLevel: 25 });
    ok('a multi-hit cast reports every hit', o.hits === declared && declared > 1,
      `${o.hits} vs ${declared} declared`);
  }

  // A pool feed is not a SUBSET of the lines above it - it is a share of their
  // crits paid out again - so dropping it is what would make the column short.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3, level: 25 };
  eng.plan.pruneSelection(l);
  const t = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 }).throughput;
  const pooled = t.lines.filter((x) => x.kind === 'over time');
  ok('this build has a pooled dot to test with', pooled.length > 0);
  const without = t.lines.filter((x) => x.kind !== 'over time')
    .reduce((s, x) => s + x.total.damage, 0);
  ok('...and leaving it out makes the column short',
    without < t.dps * t.fight - 1, `${without.toFixed(0)} vs ${(t.dps * t.fight).toFixed(0)}`);
}

// --- the coverage report may not refuse what the model scores ----------------
// A refusal whose reason is FALSE is a bug, and the two newest channels each
// made one. `GA_Craft_Passive` was filed under "everything it does lives in its
// hscript body" while its +25% rider was being read off that very body and
// applied; the same sentence sat on `Warrior_Talent_SurgeOfViolence` after its
// register started making Rage Strike free and certain. The coverage list is
// what a player checks the tool against.
group('a skill the model scores is not in the unscored list');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Epic', stars: 4, level: 25 };
  l.gear.Slot_Head = { item: 'Head_RDemon_Fig_Craft', rarity: 'Rare', stars: 0, level: 25 };
  eng.plan.pruneSelection(l);
  l.augments = { 'Slot_Head/AugmentDemonSigil': 'DemonSigil_War_SurgeOfViolence' };
  const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
  const unscored = new Set((ev.rotation.unmodelled ?? []).map((u) => u.id));

  ok('Domination carries a rider, so it is scored',
    (eng.combat.profile('GA_Craft_Passive', 3).runeDamage ?? []).length === 1);
  ok('...and is therefore absent from the unscored list',
    !unscored.has('GA_Craft_Passive'), [...unscored].join(', '));

  const emp = eng.plan.empowermentsOf(eng.talents.runableSkillIds(l), { rank: 3 });
  ok('Surge of Violence arms a register, so it is scored', emp.length === 1, JSON.stringify(emp));
  ok('...and is therefore absent too',
    !unscored.has('Warrior_Talent_SurgeOfViolence'), [...unscored].join(', '));

  // The check must not swallow a genuine refusal along with the stale ones.
  ok('a real refusal is still reported', unscored.size > 0, [...unscored].join(', '));
}

// --- cooldown earned off an event, from any source ---------------------------
// Eight rows in the game call `reduceWeaponsCooldown` and one was credited. The
// other seven were refused for three reasons that are not about the mechanic:
// `scopeOf` would not answer `rank >= N`; KNOWN_PRED's `\w+\.` missed optional
// chaining, so `hit.skill?.isBaseAttack()` failed on a question mark; and
// CD_PROC demanded a bare one-argument call, so `reduceWeaponsCooldown(vars.time,
// owner)` failed on a comma. And even once read, the engine only CREDITED the
// bleed scope - everything else fell to `unreadMods` and scored zero.
group('cooldown earned off an event, not only off a bleed');
{
  const eng = createEngine({ quiet: true });
  const cd = (id, rank) => eng.plan.talentModifiers(id, rank, { asTalent: false })
    .filter((m) => m.field === 'cooldownPerTick');

  // The rank gate is answered, not refused - and answered per rank.
  ok('a rank-3 combo rider reads at rank 3', cd('Sword_Start_Combo', 3).length === 1
    && Math.abs(cd('Sword_Start_Combo', 3)[0].amount - 0.5) < 1e-9,
    JSON.stringify(cd('Sword_Start_Combo', 3)));
  ok('...and not at rank 2', cd('Sword_Start_Combo', 2).length === 0,
    JSON.stringify(cd('Sword_Start_Combo', 2)));
  // A weapon-skill rank is a THRESHOLD, not a dose: the amount must not scale.
  ok('the amount does not multiply by the weapon rank',
    Math.abs(cd('Spear_Eruption_Combo', 3)[0].amount - 0.5) < 1e-9,
    JSON.stringify(cd('Spear_Eruption_Combo', 3)));
  // Optional chaining and a second argument are punctuation, not conditions.
  ok('an optional-chained basic-attack guard reads', cd('Halos_Upgrade', 3).length === 1,
    JSON.stringify(cd('Halos_Upgrade', 3)));
  // ...and the two that genuinely need live state still refuse.
  for (const id of ['GS_Nova_Combo', 'Thrown_Seeds_Skill1']) {
    ok(`${id} still refuses - it needs live state`, cd(id, 3).length === 0,
      JSON.stringify(cd(id, 3)));
  }

  // It reaches the fight. Sword_Start_Skill1 has a 10s cooldown, and its own
  // combo hands back 0.5s per finisher at rank 3.
  const at = (rank) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'Sword_Start', rarity: 'Rare', stars: 3, level: 25 };
    eng.plan.pruneSelection(l);
    const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank });
    return ev.throughput.lines.find((x) => x.id === 'Sword_Start_Skill1');
  };
  near('at rank 2 the weapon skill waits its whole cooldown', at(2).interval, 10, 1e-9);
  ok('at rank 3 the finisher buys it back', at(3).interval < 9,
    `${at(2).interval} -> ${at(3).interval}`);
}

// --- a next-cast register: free, and a guaranteed crit -----------------------
// Surge of Violence is the only one in the game, and it needs no talent point -
// DemonSigil_War_SurgeOfViolence hands the node over from a Head socket. The
// recognition is a triple (forced crit in onInflictDamageEval, zero cost in
// evalCost, removeStatus in onStop) and a sweep of all 962 scripts matches
// exactly one row with it.
group('a next-cast register is spent for a free crit');
{
  const eng = createEngine({ quiet: true });
  const all = eng.cdb.lines('skill').map((s) => s.id);
  const found = eng.plan.empowermentsOf(all, { rank: 3 });
  // Two authored shapes now: the costed register (Surge of Violence) and the
  // costless one the finisher itself consumes (HighVoltage, armed per mage
  // chain cast at Chaincast's counted rate). A sweep of all scripts matches
  // exactly one of each.
  ok('exactly two skills in the game carry a register shape', found.length === 2,
    JSON.stringify(found));
  const e = found.find((x) => x.from === 'Warrior_Talent_SurgeOfViolence');
  ok('...one is Surge of Violence arming Rage Strike off a finisher',
    e && e.skill === 'Warrior_Rage_Strike'
      && Math.abs(e.chance - 0.25) < 1e-9 && e.on === 'combo',
    JSON.stringify(e));
  const hv = found.find((x) => x.from === 'Mage_Talent_HighVoltage');
  ok('...the other is HighVoltage, consumed by the combo, re-armed every 4 actives',
    hv && hv.consume === 'combo' && hv.armEveryActiveCasts === 4 && hv.chance === 1
      && hv.status === 'Mage_Talent_HighVoltage_Status',
    JSON.stringify(hv));
  // Nothing is armed without the source, so a build that has neither the talent
  // nor the sigil must read nothing.
  ok('a build without the node arms nothing',
    eng.plan.empowermentsOf(['Warrior_Rage_Strike'], { rank: 3 }).length === 0);

  // End to end: the sigil buys BOTH halves - more damage per cast, and more
  // casts, because the free ones do not wait on Rage income.
  const build = (sigil) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3, level: 25 };
    l.gear.Slot_Head = { item: 'Head_RDemon_Fig_Craft', rarity: 'Rare', stars: 0, level: 25 };
    eng.plan.pruneSelection(l);
    if (sigil) l.augments = { 'Slot_Head/AugmentDemonSigil': 'DemonSigil_War_SurgeOfViolence' };
    const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
    return ev.throughput.lines.find((x) => x.id === 'Warrior_Rage_Strike');
  };
  const off = build(false), on = build(true);
  ok('the register raises Rage Strike per cast', on.perCast.damage > off.perCast.damage,
    `${off.perCast.damage.toFixed(1)} -> ${on.perCast.damage.toFixed(1)}`);
  ok('...and shortens its interval, because a free cast waits on no income',
    on.interval < off.interval, `${off.interval.toFixed(2)}s -> ${on.interval.toFixed(2)}s`);
  // A guaranteed crit is worth exactly `fixed + base x cd`, so the per-cast
  // lift cannot exceed the crit multiplier itself.
  ok('...by no more than the crit multiplier allows',
    on.perCast.damage / off.perCast.damage < 1.6,
    String(on.perCast.damage / off.perCast.damage));

  // ONE arm buys ONE free critical cast. `doUseSkill@4576` op 2 stops the
  // active skill before the new cast evaluates anything, so a second press
  // cannot spend a register the first press already consumed. Modelled by
  // clearing on every cast of the named skill, armed or not - assert the
  // register really is one-shot rather than a standing discount.
  const perFinisher = 0.25;
  let p = 0;
  p += (1 - p) * perFinisher;          // one finisher arms it
  const first = p;
  p = 0;                               // ...one cast spends it
  ok('a register spent once is empty until another finisher arms it',
    first > 0 && p === 0, `${first} -> ${p}`);
  let q = 0;
  for (let i = 0; i < 4; i++) q += (1 - q) * perFinisher;
  ok('...and arming repeatedly approaches 1 without passing it',
    q < 1 && q > 0.68, String(q));
}

// --- the three riders that were refused --------------------------------------
// All three fire in game, proven by the 2026-08-02 capture, and shipping without
// them cost -13.7% to -17.5% on the skills that carry one. Each was refused for
// a different reason: the combo's guard was readable but only talents were ever
// offered to the reader; Bonethrow's `rank >= 3` survived the predicate strip;
// and Domination's did too, plus its amount came from a rankOverride nothing
// merged.
group('a skill can carry its own damage rider');
{
  const eng = createEngine({ quiet: true });
  const riders = (id, rank) => eng.combat.profile(id, rank)?.runeDamage ?? [];

  // (i) The combo: +20% against a bleeding target, and it is dmgMult - the
  // capture's clean 1.5325 crit ratio is what proves it is not critDmgMult.
  const combo = riders('Axe_Boomerang_Combo', 3);
  ok('the combo rides +20% dmgMult against a bleeding target',
    combo.length === 1 && combo[0].field === 'dmgMult'
      && Math.abs(combo[0].amount - 0.2) < 1e-9 && combo[0].gate === 'bleeding',
    JSON.stringify(combo));

  // (ii) Bonethrow: +20% CRIT damage, gated on nothing but the weapon rank.
  ok('Bonethrow rides +20% critDmgMult at rank 3',
    riders('Axe_Boomerang_Skill1', 3).some((r) => r.field === 'critDmgMult'
      && Math.abs(r.amount - 0.2) < 1e-9 && r.gate == null),
    JSON.stringify(riders('Axe_Boomerang_Skill1', 3)));
  ok('...and carries none at rank 2', riders('Axe_Boomerang_Skill1', 2).length === 0,
    JSON.stringify(riders('Axe_Boomerang_Skill1', 2)));

  // (iii) Domination: the amount comes from props.rankOverride, and the
  // `rank >= 3` in its guard belongs to ONE alternative of a disjunction -
  // vetoing the rider on it silenced a +25% that fires on the stun path at
  // any rank.
  const dom = (r) => riders('GA_Craft_Passive', r)[0];
  near('Domination is the authored 0.15 at rank 1', dom(1).amount, 0.15, 1e-9);
  near('...and the overridden 0.25 from rank 2', dom(2).amount, 0.25, 1e-9);
  ok('...gated on crowd control, as dmgMult', dom(3).gate === 'cc' && dom(3).field === 'dmgMult',
    JSON.stringify(dom(3)));

  // The gates are the build's own, not a constant. A kit with no bleed and no
  // stun must price both at zero rather than credit them.
  const t = eng.combat.foe('dummy', 25);
  const prof = eng.combat.profile('Axe_Boomerang_Combo', 3);
  const sheet = new Map([['Strength', 100], ['Dexterity', 100], ['CritDamage', 150],
    ['CritChance', 0], ['DamageModifier', 100]]);
  const at = (gates) => {
    const o = eng.combat.castOutput(prof, sheet, t,
      { targets: 1, assume: eng.opts.assume, attackerLevel: 25, gates });
    return o.critRoll ? o.critRoll.fixed + o.critRoll.base : o.damage;
  };
  near('a bleeding target is worth exactly the authored 20%',
    at({ bleeding: 1 }) / at({ bleeding: 0 }), 1.2, 1e-9);
  near('...and no bleed in the build is worth nothing',
    at({}) / at({ bleeding: 0 }), 1, 1e-9);
}

// --- one chain clock, not two tests ------------------------------------------
// `Hero.update@7495` / `isWithinAttackCombo@7459` keep ONE timestamp - the end
// of the last completed basic - and never refresh it when a skill ends. The
// fight asked two separate questions instead: is this cast longer than the
// window, and did I stand still longer than it. Neither sees a RUN of short
// casts, and two 0.4s Rage Strikes break the chain in game.
group('the chain clock is cumulative');
{
  const W = 0.6;
  // The rule, in the form sim.mjs now runs it. Two 0.4s casts total 0.8s
  // since the last swing ended, so the chain drops - where "is this ONE cast
  // longer than 0.6" says it survives both.
  const oneClock = (gaps) => {
    let last = 0, t = 0;
    for (const g of gaps) t += g;
    return t - last > W;
  };
  ok('a single 0.4s cast keeps the chain', !oneClock([0.4]), '0.4s');
  ok('...but two of them in a row break it', oneClock([0.4, 0.4]), '0.8s');
  ok('...which the old per-cast test could never see', !(0.4 > W), 'max(0.4) vs 0.6');
  ok('a single 0.7s cast still breaks it', oneClock([0.7]), '0.7s');
  // The capture's decisive bracket: a basic pressed 13ms after the second Rage
  // Strike ended still reset, because 854ms had passed since the last BASIC's
  // end. The authored 600 sits inside [597, 854).
  ok('the authored ComboWindow sits inside the measured bracket',
    W * 1000 >= 597 && W * 1000 < 854, String(W * 1000));

  // And end to end: the fight still runs and the chain still cycles.
  const eng = createEngine({ quiet: true, fight: { seconds: 200, targets: 1 } });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3, level: 25 };
  eng.plan.pruneSelection(l);
  const ev = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 });
  ok('a chain-only build still swings and still finishes combos',
    ev.throughput.attackRate > 0 && ev.throughput.comboRate > 0,
    `attacks/s ${ev.throughput.attackRate}, combos/s ${ev.throughput.comboRate}`);
}

// --- dmgMult riders sum, they do not compound --------------------------------
// `computeDamage@4841` (Unit.hx:2000-2031) op 8 runs the hooks, op 14 seeds
// `modMult` from `hitData.dmgMult` - one scalar that starts at 1 and that every
// rider only ever `+=`s - and op 165 applies it once. The model multiplied a
// line at a time: runeDamage, then damageByAffinity, then the basic-attack
// proc. The v2 capture's one deterministic double-rider hit (Rage Strike 352
// under Berserk AND Domination) fits 1 + 0.20 + 0.25 = 1.45 to -0.23%, where
// 1.20 x 1.25 misses by +3.2%; a 42-hit least-squares agrees, rms 0.26% to 0.66%.
group('two damage riders make 1.45, not 1.50');
{
  const eng = createEngine({ quiet: true });
  const t = eng.combat.foe('dummy', 25);
  const prof = eng.combat.profile('Warrior_Rage_Strike', 3);
  const sheet = new Map([['Strength', 100], ['CritDamage', 100], ['DamageModifier', 100]]);
  const hit = (all) => {
    const o = eng.combat.castOutput(prof, sheet, t,
      { targets: 1, assume: eng.opts.assume, attackerLevel: 25 }, undefined,
      { critDamageByType: null, critChanceByType: null, damageByAffinity: { all },
        armorIgnore: null, bleed: null });
    return o.critRoll ? o.critRoll.fixed + o.critRoll.base : o.damage;
  };
  const base = hit(0);
  near('one +20% rider reads 1.20', hit(0.20) / base, 1.20, 1e-9);
  near('one +25% rider reads 1.25', hit(0.25) / base, 1.25, 1e-9);
  near('...and the two together read 1.45', hit(0.45) / base, 1.45, 1e-9);
  ok('which is not the compounded 1.50',
    Math.abs(hit(0.45) / base - 1.20 * 1.25) > 1e-6, String(hit(0.45) / base));
}

// --- the arsenal's upgrade effect reaches the wearer --------------------------
// The harvest read Slot_Weapon1 and Slot_OffhandWeapon, on the reasoning that
// the arsenal grants two chosen skills and its discounted stats and an upgrade
// effect is neither. The player's Character Profile refutes it: on a build whose
// only CritChance sources are the naked base, the ratings, and Judgement's
// upgrade line, the sheet reads 17.3% against 14.26% from base + ratings alone.
group("the arsenal's upgrade effect is not discounted away");
{
  const eng = createEngine({ quiet: true });
  const crit = (arsenalStars) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'GS_Nova', rarity: 'Rare', stars: 0, level: 25 };
    l.gear.Slot_Weapon2 = { item: 'GA_Craft', rarity: 'Epic', stars: arsenalStars, level: 25 };
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 }).sheet.get('CritChance');
  };
  // GreatAxe_Upgrade is +1/+2/+3/+4/+5 CritChance by rank, mutually exclusive.
  // The rank is the ROLLED RARITY's index and the skill only attaches at three
  // stars - Weapon.getWeaponUpgradeSkill@8182 gates on upgradeLevel >=
  // GearUpgrades.SkillUnlockLevel (3) and reads rank off inf.rarity, which
  // updateInf@8174 overwrites with the instance's roll. Every earlier
  // measurement was degenerate between this and the old stars-1 reading (an
  // Epic 4-star reads 3 either way); the discriminators that broke stars-1
  // are a 3-star Epic dagger showing its rank-3 "12%" perk and a Legendary
  // shield showing rank-4 "-11%" where stars-1 predicts -9%.
  near('a 4-star Epic arsenal axe is worth its rarity rank, 3 crit',
    crit(4) - crit(0), 3, 1e-9);
  near('...and a 3-star Epic the same 3 - rank is rarity, not stars',
    crit(3) - crit(0), 3, 1e-9);
  near('...and a 2-star one nothing at all: the upgrade skill attaches at three stars',
    crit(2) - crit(0), 0, 1e-9);
  ok('...and a 1-star one carries no rider at all', Math.abs(crit(1) - crit(0)) < 1e-9,
    String(crit(1) - crit(0)));
}

// --- a pinned rune fixes ONE slot -------------------------------------------
// Pinning a rune used to freeze every other rune slot in the build, because the
// search asked `if (!pinnedRunes.size)` before touching any of them. That is
// not what a pin means anywhere else here: pinning a chest does not stop the
// boots being searched.
group('a rune pin is per slot, not per build');
{
  const eng = createEngine({ quiet: true });
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Epic', stars: 4, level: 25 };
  eng.plan.pruneSelection(l);
  const pools = eng.talents.runePools(l);
  ok('this build offers more than one rune slot', pools.length > 1,
    pools.map((p) => p.skill).join(', '));
  const target = eng.combat.foe('dummy', 25);
  const res = optimize(eng, {
    loadout: l, target, rank: 3, goal: 'dps', restarts: 1,
    pinnedGear: new Set(eng.cat.combatSlots().map((s) => s.id)),
    pinnedRunes: new Set([pools[0].skill]),
  });
  ok('the pinned slot keeps what it was given',
    !res.loadout.runes?.[pools[0].skill], JSON.stringify(res.loadout.runes ?? {}));
  ok('...and the others were still free to be filled',
    Object.keys(res.loadout.runes ?? {}).every((k) => k !== pools[0].skill),
    JSON.stringify(res.loadout.runes ?? {}));
}

// --- a weapon is generated, gear is authored ---------------------------------
// The optimizer was offering items the world cannot drop: a level-6 Uncommon
// necklace as Rare at iLevel 260, four times its legal stats. Two defaults
// conspired - the drop-scale lifted every authored-level row to character
// level, and the rarity roll promoted every slot - when the game does both for
// WEAPONS ONLY. The live bakes settle it: Necklace_Z2RCraft logged iLevel 210
// on a level-25 character, its authored 20 exactly, while GA_Craft logged 320
// against an authored level of 4.
// --- a cosmetic type inherit is not a mechanical one ------------------------
// `CaptureNet` inherits `GreatAxe` for the animation rig - its own row is
// `skills: []`, `moveSet: "Staff"`, `setup: Weapon_2H_GreatAxe.prefab` - and
// following that for MECHANICS handed a bug-catching net two augment sockets,
// a block ability and the GREATAXE's upgrade perk (+2 CritChance), worth ~1%
// on every line of a build. The item's own aptitudes are the discriminator,
// the same one that stopped this same net from claiming a Legendary
// greatsword's WeaponPower.
group('a bug net is not a weapon');
{
  const eng = createEngine({ quiet: true });
  const net = eng.cat.itemById.get('Net_Basic');
  ok('the net is the only aptitude-less item that fits a weapon slot',
    eng.cat.items.filter((i) => (i.slots ?? []).some((s) => /Slot_Weapon1|Slot_Weapon2|Slot_OffhandWeapon/.test(s))
      && !(i.aptitudes ?? []).length).map((i) => i.id).join(',') === 'Net_Basic');
  ok('...so it inherits no upgrade perk', eng.cat.upgradeSkillFor(net) === null);
  ok('...and no sockets', eng.cat.socketsFor(net).length === 0);
  ok('...while a real weapon keeps both',
    eng.cat.upgradeSkillFor(eng.cat.itemById.get('Staff_Censer')) === 'Staff_Upgrade'
      && eng.cat.socketsFor(eng.cat.itemById.get('Staff_Censer')).length === 2);

  // The whole point, end to end: an arsenal net must be worth EXACTLY what an
  // empty arsenal slot is worth - not 4 dps of somebody else's crit perk.
  const build = (arsenal) => {
    const l = emptyLoadout(eng.cat, 'Mage', 25);
    l.gear.Slot_Weapon1 = { item: 'Staff_Censer', rarity: 'Epic', stars: 3 };
    if (arsenal) l.gear.Slot_Weapon2 = { item: arsenal, stars: 5 };
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('reference', 25), rank: 3 });
  };
  const empty = build(null);
  const withNet = build('Net_Basic');
  near('a net in the arsenal is worth exactly an empty slot',
    withNet.throughput.dps, empty.throughput.dps, 1e-9);
  near('...and moves no stat on the sheet',
    withNet.sheet.get('CritChance'), empty.sheet.get('CritChance'), 1e-9);
}

group('only a weapon scales, and only a weapon rolls its rarity');
{
  const eng = createEngine({ quiet: true });
  const cat = eng.cat;
  const type = (id) => cat.itemById.get(id)?.type;

  ok('the itemType tree splits weapons from gear',
    cat.isWeaponType(type('GA_Craft')) && cat.isWeaponType(type('Axe_Boomerang'))
      && cat.isWeaponType(type('Shield_Craft'))
      && !cat.isWeaponType(type('Necklace_Z2RCraft')) && !cat.isWeaponType(type('Chest_RBee_Fig'))
      && !cat.isWeaponType(type('Trinket_Kobold')),
    'roots are MainhandWeapon / OffhandWeapon vs Gear');

  const iLevel = (id) => {
    const it = cat.itemById.get(id);
    return cat.effectiveLevel(it, { charLevel: 25, stars: 0, rarity: it.rarity }) * 10;
  };
  // The two the live bakes name, to the integer.
  near('an authored-level necklace keeps its own level', iLevel('Necklace_Z2RCraft'), 210, 1e-9);
  near('...and an authored-level ring keeps its own', iLevel('Finger_Z2RCraft_CriAP'), 160, 1e-9);
  // The one the player caught: authored level 6, offered at 260.
  near('the level-6 necklace prices at 60, not 260', iLevel('Necklace_Z1_Cri'), 60, 1e-9);
  // A weapon still scales - authored level 4, generated at the character's.
  near('a weapon still generates at the source level', iLevel('GA_Craft'), 260, 1e-9);
  // Gear with NO authored level has nothing to keep, so it takes yours.
  near('gear with no authored level takes the character level',
    iLevel('Chest_RBee_Fig'), 260, 1e-9);

  // And the roll. With `rarityRoll` on, a weapon expands into one candidate per
  // attainable rarity; gear must still offer exactly its authored one.
  const rolled = (slot, id) => cat.candidates(slot, {
    aptitude: 'Fighter', charLevel: 25, rarityRoll: true,
  }).filter((c) => c.item.id === id);
  const neck = rolled('Slot_Neck', 'Necklace_Z1_Cri');
  ok('a gear row offers only its authored rarity',
    neck.length > 0 && neck.every((c) => c.rarity === cat.itemById.get('Necklace_Z1_Cri').rarity),
    neck.map((c) => c.rarity).join(', '));
  ok('...while a weapon still expands across the roll',
    rolled('Slot_Weapon1', 'GA_Craft').length > 1,
    String(rolled('Slot_Weapon1', 'GA_Craft').length));
}

// --- the bake, against the game's own return value ---------------------------
// `captures/2026-08-02-v2/bench-probe-bakes.csv` is a postfix on
// `$HItem.generateItemAffixes@20747`: item, the iLevel it was called with, and
// every affix line that came back. 632 signatures, 2,115 lines. Not a tooltip
// reading - the function's own output - so a disagreement is always ours.
// These are the three rules that took it from 1,299 exact to all of them.
group('the bake reproduces the game to the integer');
{
  const eng = createEngine({ quiet: true });
  const bake = (itemId, rarity, iLevel, slotId) => {
    const flat = new Map();
    const bonus = eng.cdb.byId('rarity').get(rarity)?.props?.iLevelBonus ?? 0;
    eng.cat.contribute(eng.cat.itemById.get(itemId), slotId,
      { charLevel: 25, rarity, stars: 0, level: (iLevel - bonus) / 10, armorReduction: 0.4 },
      { flat, addRatio: new Map(), mulRatio: new Map() });
    return flat;
  };

  // (1) ONE ROUND PER TARGET ATTRIBUTE. Two aptitudes both paying MaxHealth are
  // two rows on one line; rounding each before adding loses up to a point.
  const axe = bake('Axe_Boomerang', 'Rare', 290, 'Slot_Weapon1');
  for (const [k, v] of Object.entries({ Vitality: 36, Strength: 15, Dexterity: 18,
    CritChanceRating: 39, ArmorPenetrationRating: 39 })) {
    near(`the live axe at iLevel 290 pays ${k} ${v}`, axe.get(k) ?? 0, v, 1e-9);
  }
  const ga = bake('GA_Craft', 'Epic', 320, 'Slot_Weapon1');
  const GA = { Vitality: 49, Strength: 38, ArmorPenetrationRating: 87 };
  for (const [k, v] of Object.entries(GA)) {
    near(`the live GA at iLevel 320 pays ${k} ${v}`, ga.get(k) ?? 0, v, 1e-9);
  }
  // ...and the same weapon in the ARSENAL, where the player photographed the
  // tooltip printing "Arsenal stats efficiency: 40%" beside +20 Vit +16 Str
  // +35 ArPen. `ceil(v * 0.4)` reproduces all three off the mainhand numbers,
  // which pins the bake and the slot factor against one screenshot.
  const arsenal = bake('GA_Craft', 'Epic', 320, 'Slot_Weapon2');
  for (const [k, v] of Object.entries({ Vitality: 20, Strength: 16, ArmorPenetrationRating: 35 })) {
    near(`...and ${k} ${v} in the arsenal, at ceil(v x 0.4)`, arsenal.get(k) ?? 0, v, 1e-9);
  }

  // (2) UNCOMMON DROPS A GROUP, and which one depends on the aptitude count.
  // Nothing authored says so - the `rarities` overrides stop at Common.
  const uSingle = bake('Waist_Z1U2_Fig', 'Uncommon', 80, 'Slot_Waist');
  ok('an Uncommon single-aptitude item pays no primary',
    (uSingle.get('Strength') ?? 0) === 0 && (uSingle.get('Vitality') ?? 0) > 0,
    [...uSingle].map(([k, v]) => k + '=' + v).join(' '));
  const uMulti = bake('Waist_Z1U2_FigAss', 'Uncommon', 100, 'Slot_Waist');
  ok('...and a multi-aptitude one pays no vitality instead',
    (uMulti.get('Vitality') ?? 0) === 0 && (uMulti.get('Strength') ?? 0) > 0,
    [...uMulti].map(([k, v]) => k + '=' + v).join(' '));
  // Common still zeroes BOTH, and that one IS authored - so the new rule must
  // not have quietly replaced it.
  const common = bake('Waist_Z1U2_Fig', 'Common', 80, 'Slot_Waist');
  ok('Common still pays neither primary nor vitality',
    (common.get('Strength') ?? 0) === 0 && (common.get('Vitality') ?? 0) === 0,
    [...common].map(([k, v]) => k + '=' + v).join(' '));

  // (3) The mitigation curve, read off the player's own Character Profile:
  // it prints -40.08% beside Armor 1930.
  const ctxConsts = eng.ctx.consts;
  const red = 1930 / (1930 + ctxConsts.resistFormula[0] + ctxConsts.resistFormula[1] * 25);
  near('armor 1930 mitigates 40.08% at attacker level 25', red * 100, 40.08, 0.005);
}

// --- a rank override restates vars, not only props ---------------------------
// `updateSkillInf@20788` (HSkill.hx:368-373) calls BOTH applyProps and
// applyVars for every override the rank clears. The model merged props alone,
// so Domination read its rank-1 0.15 where the game hands it 0.25 from rank 2 -
// and bench's default rank is the max, where the override is always in scope.
group('a rank override restates vars too');
{
  const eng = createEngine({ quiet: true });
  const varsAt = (id, rank) => eng.combat.profile(id, rank)?.vars ?? {};
  near("Domination's rider is the authored 0.15 at rank 1", varsAt('GA_Craft_Passive', 1).var1, 0.15, 1e-9);
  near('...and the overridden 0.25 from rank 2', varsAt('GA_Craft_Passive', 2).var1, 0.25, 1e-9);
  near('...and stays there at rank 3', varsAt('GA_Craft_Passive', 3).var1, 0.25, 1e-9);
  // A row whose override touches ONE field leaves its siblings alone.
  const bt = varsAt('Axe_Boomerang_Skill1', 3);
  ok('an override replaces only the fields it names',
    bt.var3 === 3 && bt.var1 === 0.4 && bt.var2 === 0.2, JSON.stringify(bt));

  // The census, so a patch that adds override vars to a row the model reads is
  // noticed rather than absorbed silently.
  const rows = eng.cdb.lines('skill')
    .filter((s) => (s.props?.rankOverride ?? []).some((o) => o.vars && Object.keys(o.vars).length));
  ok('98 rows in the game restate vars by rank', rows.length === 98, String(rows.length));
}

// --- a skill's own affix is owed for owning the skill ------------------------
// `BaseSkill.permaAffixes@6081` is false for exactly two natures, Status and
// Passive, and `initData@6029` hands everything else's affix rows to
// `owner.addAffix` permanently. The harvest read `rot.passive` alone, so
// `Axe_Boomerang_Combo` - nature Combo, +5 CritChance at rank 2, tooltip "You
// permanently gain" - was dropped for being filler rather than a passive.
group("a skill's own affix does not need to be a passive");
{
  const eng = createEngine({ quiet: true });
  const NATURES = eng.cdb.enumValues('skill', 'nature');
  const outside = eng.cdb.lines('skill')
    .filter((s) => (s.affixes ?? []).some((a) => a.target?.attribute))
    .filter((s) => NATURES[s.nature ?? -1] !== 'Status' && NATURES[s.nature ?? -1] !== 'Passive')
    .map((s) => s.id);
  // The census is the safety rail: this change can only ever touch these rows,
  // so a patch that adds a seventh is a thing to look at rather than absorb.
  ok('exactly six rows in the game carry one outside Status/Passive',
    outside.length === 6 && outside.includes('Axe_Boomerang_Combo')
      && outside.includes('DA_Water_Combo'),
    outside.join(', '));

  const combo = eng.cdb.byId('skill').get('Axe_Boomerang_Combo');
  ok('the combo row is a Combo carrying +5 CritChance at rank 2',
    NATURES[combo.nature] === 'Combo'
      && combo.affixes[0].target.attribute === 'CritChance'
      && combo.affixes[0].val === 5 && combo.affixes[0].conds.minRank === 2,
    JSON.stringify(combo.affixes));

  const at = (rank) => {
    const l = emptyLoadout(eng.cat, 'Warrior', 25);
    l.gear.Slot_Weapon1 = { item: 'Axe_Boomerang', rarity: 'Rare', stars: 3, level: 25 };
    eng.plan.pruneSelection(l);
    return eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank }).sheet.get('CritChance');
  };
  ok('it reaches the sheet at rank 2 and not at rank 1', at(2) - at(1) > 5 - 1e-9,
    `${at(1)} -> ${at(2)}`);

  // A shield's Block ability is nature Ability and already arrived through
  // `passive`. Counting it twice is the failure mode this dedupe exists for.
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.gear.Slot_OffhandWeapon = { item: 'Shield_Craft', rarity: 'Rare', stars: 3, level: 22 };
  eng.plan.pruneSelection(l);
  const block = eng.evaluate(l, { target: eng.combat.foe('dummy', 25), rank: 3 })
    .sheet.get('BlockMitigation');
  ok('a Block ability is still counted exactly once', block <= 110 + 1e-9, String(block));
}

// --- crit is a die, and --fights throws it ----------------------------------
// Procs rolled and the ±10% swing band rolled, but crit stayed at its
// expectation - so a crit-bleed build, whose entire damage profile is "did the
// crit land", reported a spread of essentially zero. That read as a claim about
// the build and was a fact about the model.
group('rolling the crit');
{
  const eng = createEngine({ quiet: true, fight: { seconds: 200, targets: 1 } });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.profile = 'crit';
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };

  const ev = eng.evaluate(l, { target, rank: 3 });
  const sheet = ev.sheet;
  // The decomposition is an identity, not an approximation: the expected value
  // of `fixed + base x (1 + (k/n)(cd-1))` over a binomial(n, p) is exactly the
  // deterministic `damage`. If it is not, --fights moves the answer instead of
  // measuring its spread.
  let checked = 0;
  for (const line of ev.rotation.active) {
    const out = eng.combat.castOutput(line.prof, sheet, target, { ...eng.opts, targets: 1 });
    const c = out.critRoll;
    if (!c || !(c.hits > 0)) continue;
    near(`${line.prof.id}: fixed + base x (1+p(cd-1)) is the deterministic damage`,
      c.fixed + c.base * (1 + c.p * (c.cd - 1)), out.damage, Math.max(1e-6, out.damage * 1e-9));
    ok(`${line.prof.id}: the roll count is at least one hit`, c.hits >= 1, String(c.hits));
    checked++;
  }
  ok('at least one cast decomposes', checked > 0, String(checked));

  // A status tick cannot crit (initVars@5150 zeroes ctx.critChance), so it must
  // contribute to `fixed` and never to `base` - rolling a die for it would
  // invent variance the game does not have.
  const tickProf = (eng.rotation ?? ev.rotation).dots?.find((d) => d.prof && !d.pool)?.prof;
  if (tickProf) {
    const out = eng.combat.castOutput({ ...tickProf, isStatusTick: true }, sheet, target,
      { ...eng.opts, targets: 1 });
    ok('a status tick has nothing for the die to touch',
      !out.critRoll || out.critRoll.hits === 0 || out.critRoll.base === 0,
      JSON.stringify(out.critRoll));
  }

  // And the fight itself: rolling has to produce a spread where the build has
  // crit, while leaving the deterministic answer exactly where it was.
  const det = eng.evaluate(l, { target, rank: 3 }).throughput;
  const rolledEng = createEngine({ quiet: true, fight: { seconds: 200, targets: 1, count: 60 } });
  const rolled = rolledEng.evaluate(l, { target, rank: 3 }).throughput;
  ok('a crit-stacked build now reports a real spread',
    rolled.dpsSd / rolled.dps > 0.002, `${(100 * rolled.dpsSd / rolled.dps).toFixed(2)}%`);
  ok('...and the mean is still the deterministic answer',
    Math.abs(rolled.dps / det.dps - 1) < 0.03,
    `${rolled.dps.toFixed(2)} rolled vs ${det.dps.toFixed(2)} deterministic`);
}

// --- the rotation search ----------------------------------------------------
// What is searched is a POLICY, not a sequence: an ordered list of
// (skill, condition) that a player could follow, and that transfers across
// builds because its conditions are re-evaluated rather than baked in.
group('the rotation search');
{
  const eng = createEngine({ quiet: true, fight: { seconds: 200, targets: 1, lookahead: 0 } });
  const target = eng.combat.foe('boss', 25);
  const l = emptyLoadout(eng.cat, 'Warrior', 25);
  l.profile = 'armorpen';
  l.gear.Slot_Weapon1 = { item: 'GA_Craft', rarity: 'Legendary', stars: 5 };
  l.gear.Slot_Weapon2 = { item: 'GA_Demon', rarity: 'Legendary', stars: 5 };
  l.talents = { Warrior_Hemorrhage: 1, Warrior_Talent_Sever: 1 };
  const ev = eng.evaluate(l, { target, rank: 3 });
  const ids = ev.throughput.lines.filter((x) => x.kind === 'active').map((x) => x.id);

  // Restart 0 starts from the derived order, so the search can never return
  // something worse than what every other command already reported.
  const derived = derivedApl(ids);
  const asDerived = eng.evaluate(l, { target, rank: 3, policy: makePolicy(derived) }).throughput.dps;
  ok('the derived order replayed as an APL reproduces the derived dps',
    Math.abs(asDerived - ev.throughput.dps) / ev.throughput.dps < 1e-9,
    `${asDerived.toFixed(3)} vs ${ev.throughput.dps.toFixed(3)}`);

  // A vocabulary built from THIS build, not from the whole game.
  const vocab = vocabularyFor(ev.rotation);
  ok('the condition vocabulary is built from what this build can produce',
    vocab.length > 4 && vocab.length < 200, String(vocab.length));
  ok('...and always includes the unconditional one', vocab.some((c) => c.kind === 'always'));
  ok('...and only names statuses this rotation applies', vocab.filter((c) => c.kind === 'buff' || c.kind === 'debuff')
    .every((c) => eng.cdb.byId('skill').has(c.id)));

  // The list is authoritative: a skill with no entry is never pressed.
  const onlyOne = { entries: [derived.entries[0]], excluded: [] };
  const single = eng.evaluate(l, { target, rank: 3, policy: makePolicy(onlyOne) }).throughput;
  ok('a skill the list does not mention is never pressed',
    single.lines.filter((x) => x.kind === 'active').length === 1,
    single.lines.filter((x) => x.kind === 'active').map((x) => x.id).join(','));
  // ...unless the caller asks for the fallback, which is what lets the KIT
  // search change which skills exist without every change looking like a loss.
  const withFallback = eng.evaluate(l, { target, rank: 3, policy: makePolicy(onlyOne, { appendUnlisted: true }) });
  ok('...unless the caller asks for unlisted skills to fall through',
    withFallback.throughput.lines.filter((x) => x.kind === 'active').length > 1);

  const repaired = repairApl({ entries: [{ skill: 'Not_A_Skill', cond: { kind: 'always' } }], excluded: [] }, ids);
  ok('repair drops skills the build no longer has and appends the ones it gained',
    repaired.entries.length === ids.length
    && repaired.entries.every((e) => ids.includes(e.skill)), JSON.stringify(repaired.entries.map((e) => e.skill)));

  // And the search itself must not return something worse than it started from.
  const score = (apl) => eng.evaluate(l, { target, rank: 3, policy: makePolicy(apl) }).throughput.dps;
  const got = searchApl({ score, ids, vocabulary: vocab, restarts: 2, maxSteps: 6, startFrom: derived });
  ok('the search never returns worse than the derived order',
    got.score >= asDerived - 1e-6, `${got.score.toFixed(2)} vs ${asDerived.toFixed(2)}`);
  ok('...and reports how many fights it took', got.evaluations > 50, String(got.evaluations));
}

// --- a cooldown whose payload is a timed buff is a CAST ---------------------
// `passive` is the bucket for things that are simply true. A skill you press
// does not belong in it, however little damage it does: the fight never casts a
// passive, so its window never opens and the buff it applies sits in the timed
// list waiting for a `setUp` that cannot come. Battle Shout, Berserk, Blessing
// of Fervor and Smoke Bomb all read as dead bar slots that way - worth NEGATIVE,
// because they occupied a slot and did nothing.
group('a timed self-buff on a cooldown is a cast');
{
  const engine = createEngine();
  // The invariant, over every class rather than the one that found it.
  for (const c of cat.classes) {
    const rot = engine.plan.resolve(emptyLoadout(cat, c.unit, 25), 3);
    const stranded = (rot.passive ?? []).filter(
      (p) => p.prof?.cooldown > 0 && (p.buffs ?? []).some((b) => b.duration > 0));
    ok(`${c.unit}: no cooldown with a timed self-buff is stranded in passive`,
      stranded.length === 0, stranded.map((p) => p.prof.id).join(','));
  }

  const lo = emptyLoadout(cat, 'Warrior', 25);
  lo.skills['class/ClassSkill'] = ['Warrior_BattleShout', 'Warrior_Berserk',
    'Warrior_SurgingForce', 'Warrior_IgnorePain'];
  const rot = engine.plan.resolve(lo, 3);
  const active = new Map((rot.active ?? []).map((a) => [a.prof.id, a]));
  ok('Battle Shout is a cast the fight can press', active.has('Warrior_BattleShout'));
  ok('...and so is Berserk', active.has('Warrior_Berserk'));
  ok('...and it carries the buff it applies, or the window has nothing in it',
    (active.get('Warrior_BattleShout')?.applies?.self ?? []).some((b) => b.duration > 0));

  // A PERMANENT self-buff still belongs in the sheet: it needs no cast to be
  // true, which is the case `passive` exists for. Nothing that reaches `active`
  // here may be one with no duration and no cooldown.
  ok('a permanent buff is not promoted into the rotation',
    !(rot.active ?? []).some((a) => !(a.prof.cooldown > 0)
      && (a.applies?.self ?? []).length && (a.applies.self).every((b) => !(b.duration > 0))));
}

// --- the count-scaled companion rider --------------------------------------
// Gash's hook lives on the weapon PASSIVE - dmgMult += other-own-statuses x
// vars.var1 behind rank >= 2, keyed on dmg.skillId == the status - while the
// status can be APPLIED by a different skill entirely. The rider must land on
// whichever applier wins the dot selection, and only when the hook's host is
// actually slotted: the arsenal pool makes the passive a CHOICE, and crediting
// an unslotted passive's hook would price a build the player is not running.
group('the count-scaled companion rider');
{
  const engine = createEngine();
  const withSel = (sel) => {
    const lo = emptyLoadout(cat, 'Rogue', 25);
    lo.gear.Slot_Weapon2 = { item: 'Daggers_DuplicatePoison' };
    if (sel) lo.skills.Slot_Weapon2 = sel;
    const rot = engine.plan.resolve(lo, 3);
    return (rot.dots ?? []).find((d) => d.status === 'Daggers_DuplicatePoison_PassiveStatus');
  };
  const slotted = withSel(['Daggers_DuplicatePoison_Skill1', 'Daggers_DuplicatePoison_Passive']);
  ok('with the passive slotted, the winning dot carries the rider',
    slotted?.perOtherStatus === 0.1 && slotted?.from === 'Daggers_DuplicatePoison_Passive',
    JSON.stringify({ from: slotted?.from, per: slotted?.perOtherStatus }));
  ok('...applied on the swing stream at its authored chance',
    slotted?.on === 'attack' && slotted?.chance === 0.2,
    JSON.stringify({ on: slotted?.on, chance: slotted?.chance }));
  const unslotted = withSel(['Daggers_DuplicatePoison_Skill1', 'Daggers_DuplicatePoison_Skill2']);
  ok('without the passive, no rider is credited',
    !!unslotted && unslotted.perOtherStatus == null,
    JSON.stringify({ from: unslotted?.from, per: unslotted?.perOtherStatus }));
}

// --- a rune's vars, and the durations it extends ---------------------------
// `updateSkillInf@20788` runs applyVars per slotted mastery ON TOP of the row's
// own, so where both name a key the RUNE wins. The reader had it the other way
// round, which is why Execution printed its base row's numbers instead of the
// ones its tooltip shows.
group('rune vars and duration extension');
{
  const engine = createEngine();

  // The tripwire: which rows override a key their base row also defines. If a
  // patch empties this set the precedence rule is untestable and somebody
  // should know, rather than the test quietly passing on nothing.
  const clashes = [];
  for (const r of cat.cdb.lines('skill')) {
    for (const m of r.mastery ?? []) {
      if (!m.vars || !r.vars) continue;
      for (const k of Object.keys(m.vars)) {
        if (k in r.vars && r.vars[k] !== m.vars[k]) clashes.push({ skill: r.id, rune: m.id, key: k });
      }
    }
  }
  ok('some rune overrides a var its own skill row also declares', clashes.length > 0,
    String(clashes.length));

  // Battle Fury is the readable end of the same mechanism: its amount lives
  // ONLY on the rune, so a reader that consults the skill row alone sees
  // nothing at all.
  const shout = 'Warrior_BattleShout';
  const withRune = engine.plan.selfBuffsOf(shout, { runes: new Set(['Warrior_BattleShout_M1']), rank: 3 });
  const without = engine.plan.selfBuffsOf(shout, { runes: new Set(), rank: 3 });
  const ext = withRune.find((b) => b.extend)?.extend;
  ok('a duration extension is read off the rune that gates it', !!ext, JSON.stringify(withRune.map((b) => b.status)));
  ok('...with the amount the RUNE declares, not the row', ext?.amount === 0.25, String(ext?.amount));
  ok('...gated on a crit, which is a rate and not an unreadable condition', ext?.critOnly === true);
  ok('...off a damage hook, the only one that carries a rate', ext?.hook === 'onInflictDamage', ext?.hook);
  ok('a build without the rune reads no extension at all',
    without.every((b) => !b.extend));

  // And the engine turns the rate into an effective duration. While the buff is
  // up it loses a second a second and gains `e`, so it lasts D/(1-e) - longer
  // than the row says, never shorter, and never infinite below e = 1.
  const lo = emptyLoadout(cat, 'Warrior', 25);
  lo.skills['class/ClassSkill'] = ['Warrior_BattleShout', 'Warrior_Berserk', 'Warrior_SurgingForce', 'Warrior_IgnorePain'];
  lo.runes[shout] = 'Warrior_BattleShout_M1';
  const ev = engine.evaluate(lo, { target: engine.combat.foe('dummy', 25), rank: 3 });
  const b = (ev.buffs ?? []).find((x) => x.status === 'Warrior_BattleShoutStatus');
  ok('the engine extends the status it was told about', !!b?.extended, JSON.stringify(b?.extended));
  ok('...to strictly longer than the row declares, and finitely so',
    b.extended.to > b.extended.from && Number.isFinite(b.extended.to), JSON.stringify(b.extended));
  ok('...and the uptime follows the extended duration',
    Math.abs(b.uptime - Math.min(1, b.duration / 120)) < 1e-6, `${b.uptime} vs ${b.duration}/120`);
}

// --- questlog import -------------------------------------------------------
// questlog.gg stores a build as the game's own `data.cdb` ids, so the importer
// is a renaming job and what is under test is the mapping, not the content.
// The fixture is therefore BUILT FROM THE CATALOG rather than written out: a
// patch that renames an item or reorders the rarity ladder cannot fail this,
// and the end-to-end case still proves the emitted syntax is one the real pin
// parser accepts.
group('questlog import');
{
  const engine = createEngine();
  const rarities = cat.cdb.lines('rarity').map((r) => r.id);
  const usable = (i) => cat.usableBy(i, 'Fighter') && !/^GM_/.test(i.id) && (i.level ?? 0) <= 25;
  const weapon = cat.items.find((i) => i.slots.includes('Slot_Weapon1') && usable(i)
    && cat.socketsFor(i).includes('AugmentEnchantWeapon'));
  const neck = cat.items.find((i) => i.slots.includes('Slot_Neck') && usable(i)
    && cat.socketsFor(i).includes('AugmentJeweller'));
  const gem = cat.augmentCandidates('AugmentJeweller')[0];
  const pool = engine.talents.runePools(emptyLoadout(cat, 'Warrior', 25))[0];
  const root = [...engine.talents.treeFor('Warrior').byId.entries()].find(([, n]) => n.tier === 0)[0];

  const payload = { result: { data: {
    character: { name: 'fixture', classId: 'fighter', desc: '', user: { name: 'x', slug: 'author' } },
    builds: [{
      level: 25, talentBuildId: 7,
      equipment: {
        mainHand: {
          // gradeOverride is 1-based, so the LAST rarity is `rarities.length`.
          // That is the whole reason the reference build's `5` reads Legendary
          // and not off the end of a five-entry ladder.
          id: weapon.id, level: 25, upgradeLevel: 3, gradeOverride: rarities.length,
          enchant: null, corruptedGift: null,
        },
        neck: { id: neck.id, upgradeLevel: 0, gradeOverride: null, enchant: { id: gem.id }, corruptedGift: null },
        offHand: { id: '', upgradeLevel: 0, gradeOverride: null, enchant: null, corruptedGift: null },
        mount: { id: 'Some_Mount', upgradeLevel: 0, gradeOverride: null, enchant: null, corruptedGift: null },
        legs: { id: 'Not_An_Item', upgradeLevel: 0, gradeOverride: null, enchant: null, corruptedGift: null },
      },
    }],
  } } };
  const talentPayload = { result: { data: { builds: [
    { id: 6, name: 'wrong one', talents: {}, runes: {} },
    { id: 7, name: 'right one', talents: { [root]: { rank: 1 } },
      runes: { [pool.skill]: pool.options[0].id, Not_A_Skill: 'Not_A_Rune' } },
  ] } } };

  ok('a builder URL yields its slug',
    slugOf('https://questlog.gg/farever/en/character-builder/HandWithTheFullTeam') === 'HandWithTheFullTeam');
  ok('a bare slug passes through', slugOf('HandWithTheFullTeam') === 'HandWithTheFullTeam');
  let threw = false;
  try { slugOf('https://example.com/nope'); } catch { threw = true; }
  ok('some other URL is refused rather than guessed at', threw);

  const build = normalize(payload, talentPayload);
  ok('the talent page is paired by id, not by position', build.talentName === 'right one');
  ok('...and its allocation comes across', build.talents[root]?.rank === 1);

  const out = translate(build, engine);
  // questlog's four classIds are `characterBuilder.getClasses`: assassin,
  // cleric, fighter, wizard -> Rogue, Priest, Warrior, Mage. They are the
  // bench's aptitude names lowercased, which is the whole mapping - so what is
  // asserted is that every class stays reachable that way, not a table of four.
  ok('a questlog classId maps through the aptitude', out.class === 'Warrior', out.class);
  ok('...and every class is reachable the same way, not just this one',
    cat.classes.every((c) => translate({ ...build, classId: c.aptitude.toLowerCase() }, engine).class === c.unit));
  const argOf = (slot) => out.pins.find((p) => p.slot === slot && !p.socket && !p.isSkills)?.arg;

  ok('a weapon carries instance level, rarity and stars',
    argOf('Slot_Weapon1') === `weapon1=${weapon.id}^25@${rarities[rarities.length - 1]}*3`,
    argOf('Slot_Weapon1'));
  // Gear does not roll a rarity and has no upgrade path, so it takes neither.
  ok('gear takes the bare id', argOf('Slot_Neck') === `neck=${neck.id}`, argOf('Slot_Neck'));
  ok('an empty combat slot is pinned empty, not left open',
    argOf('Slot_OffhandWeapon') === 'offhandweapon=none');

  // Which socket an augment goes in is derived by intersecting the host's
  // sockets with the types that list it, so no socket table is kept in sync.
  const aug = out.pins.find((p) => p.socket);
  ok('an augment finds its socket on the host',
    aug?.arg === `neck/AugmentJeweller=${gem.id}`, aug?.arg);

  ok('talents come across with their ranks',
    out.talentPins.length === 1 && out.talentPins[0].arg === `${root}=1`);
  ok('a rune the build offers a slot for is kept',
    out.runePins.length === 1 && out.runePins[0].arg === `${pool.skill}=${pool.options[0].id}`);

  const said = (re) => out.warnings.some((w) => re.test(w));
  ok('a rune with no slot in this build is named, not silently dropped', said(/Not_A_Skill/));
  ok('an item the catalog does not have is named', said(/Not_An_Item/));
  ok('a cosmetic slot with something in it is named', said(/Some_Mount/));
  ok('the class-skill bar is always reported as not recorded', said(/class skills/));
  ok('nothing unreadable reached the pins',
    !out.pins.some((p) => /Not_An_Item|Some_Mount/.test(p.arg)));

  // The point of the whole exercise: the command it writes is one the real pin
  // parser takes. `sheet` is the cheapest verb that applies every pin.
  const bench = (...a) => spawnSync(process.execPath,
    [fileURLToPath(new URL('../bin/bench.mjs', import.meta.url)), ...a], { encoding: 'utf8' });
  const run = bench(...commandLine(out, { verb: 'sheet' }).slice(1));
  ok('the emitted command is one the bench accepts', run.status === 0,
    (run.stderr || run.stdout || '').trim().split('\n').slice(-3).join(' | '));
  ok('...and it equips what questlog named', run.stdout.includes(weapon.name)
    && run.stdout.includes(neck.name));

  // The CLI itself, which nothing else in this suite loads. USAGE is one big
  // template literal, and a stray backtick inside it has twice parsed fine and
  // broken every invocation - so the cheapest possible check that the file
  // still runs is worth having.
  const help = bench('--help');
  ok('the CLI parses and prints its usage', help.status === 0,
    (help.stderr || '').trim().split('\n').slice(-2).join(' | '));
  ok('...including how to hand it a questlog link',
    /questlog/i.test(help.stdout) && /--questlog-build/.test(help.stdout));

  // A second positional has never meant anything but a build link, so a typo
  // in that position is an error rather than something silently ignored.
  const stray = bench('optimize', '--class', 'Warrior', 'wibble');
  ok('a second argument that is not a build link is refused', stray.status !== 0);
  ok('...and the message names what was not understood',
    /wibble/.test(stray.stderr + stray.stdout));
}

// --- the two level dials ----------------------------------------------------
group('mitigation uses two levels, not one');
{
  const engine = createEngine();
  const K2 = engine.ctx.consts;
  const [a, b] = K2.resistFormula;

  // getResistanceLevelScaling@20663 builds the pool at the TARGET's level;
  // getAffinityDamageReduction@4510 divides at the STRIKER's. Authored 0.40 is
  // 40% only when the two agree.
  // 'trash' (W_Base) carries no fitted spawn level, so it still defaults to
  // parity; the bosses now spawn at their measured zone levels.
  const f25 = engine.combat.foe('trash', 25, 25);
  const fLow = engine.combat.foe('trash', 25, 10);
  near('at parity the display reduction is the mitigation',
    f25.armor / (f25.armor + a + b * 25), f25.physReduction, 1e-9);
  ok('a low-spawned foe mitigates less against a high striker',
    fLow.armor < f25.armor);
  near('...by exactly the pool ratio the formula predicts',
    fLow.armor / f25.armor, (a + b * 10) / (a + b * 25), 1e-9);
  ok('the spawn level is carried and named',
    fLow.spawnLevel === 10 && /@L10/.test(fLow.name));
  ok('omitting the spawn level is parity for an unfitted family',
    f25.spawnLevel === 25 && engine.combat.foe('trash', 25).armor === f25.armor);
  ok('a fitted world family refuses the parity default',
    engine.combat.foe('boss', 25).spawnLevel < 10 && /fit/.test(engine.combat.foe('boss', 25).name));
}

// --- unit inheritance ------------------------------------------------------
group('a unit inherits from every parent, not the first');
{
  const engine = createEngine();
  const intent = engine.combat.armourIntent;

  // 305 of 516 unit rows declare more than one parent, and the shape is
  // consistently (archetype, species) - so following only inherit[0] finds the
  // world-trash base and never the animal.
  const units = engine.cdb.lines('unit');
  const multi = units.filter((u) => (u.inherit ?? []).length > 1);
  ok('the data really does use multiple inheritance', multi.length > 100,
    `${multi.length} of ${units.length}`);

  // The declared bases, unchanged by any of this.
  near('W_Base mitigates its authored 0.30', intent('W_Base').phys, 0.30, 1e-9);
  // ...and a unique's own 0.35 row SUMS with the inherited 0.30 - the
  // chain-sum law, live-verified: S = 0.35/0.65 + 0.30/0.70 = 0.967.
  near('W_Base_Unique sums its own row with the base', intent('W_Base_Unique').phys,
    (0.35 / 0.65 + 0.30 / 0.70) / (1 + 0.35 / 0.65 + 0.30 / 0.70), 1e-9);

  // Golem_Base declares Armor with `multiplier: 1.6` and nothing else - no
  // value, no levelScaling, no specScaling. A golem inheriting
  // [W_Base, Golem_Base] takes W_Base's 0.30 curve and Golem_Base's multiplier
  // (loadUnit@18967 ops 179-185 fill a null multiplier from the parent), and
  // the multiplier scales the resist POOL, so the reduction it comes back as is
  // 1.6*0.3 / (1.6*0.3 + 1 - 0.3) = 0.4068.
  const golem = intent('Golem_Z1W_Earth1');
  near('a golem mitigates more than the base it inherits', golem.phys, 0.48 / 1.18, 1e-9);
  ok('...which is strictly above the 0.30 that reading one parent would give',
    golem.phys > 0.30, String(golem.phys));
  near('...while its magic armour, which no golem multiplies, stays 0.30',
    golem.mag, 0.30, 1e-9);

  // A unique golem: the x1.6 stub lands on the FIRST reduction row (its own
  // 0.35) and the inherited 0.30 sums plain - the judge's golem ruling.
  near('the multiplier lands on the first reduction row and the rest sum plain',
    intent('Golem_Z2W_U').phys,
    (1.6 * (0.35 / 0.65) + 0.30 / 0.70) / (1 + 1.6 * (0.35 / 0.65) + 0.30 / 0.70), 1e-9);

  // The pool multiplier folds back into a reduction with the level cancelling,
  // which is why one number describes a target at every level.
  {
    const [a, b] = K.resistFormula;
    const red = (L, base, m) => {
      const R = m * resistForReduction(L, base, K.resistFormula);
      return R / (R + a + b * L);
    };
    for (const L of [1, 25, 50]) {
      near(`the scaled reduction is level-independent at L${L}`,
        red(L, 0.30, 1.6), golem.phys, 1e-9);
    }
  }

  // Ratsar sums his own 0.40 with the inherited 0.30: S = 1.09524, display
  // 0.523 - the coefficient the rift windows verified to -0.0% residual.
  near('Ratsar sums to the S the rift windows measured',
    intent('Ratsar').physS, 0.40 / 0.60 + 0.30 / 0.70, 1e-9);

  ok('every unit that resolves an intent resolves a finite one',
    units.every((u) => {
      const i = intent(u.id);
      return (i.phys === null || (i.phys >= 0 && i.phys < 1))
        && (i.mag === null || (i.mag >= 0 && i.mag < 1));
    }));
}

// --- the patch-day pipeline -------------------------------------------------
group('drift: the patch-day pipeline');
{
  // CITATIONS ARE A GATE, not documentation. Every name@findex in src/ must
  // resolve by name in the live bytecode with the cached findex still true.
  // On patch day this test failing IS the alarm: MOVED means re-anchor the
  // cache, MISSING means a formula's source no longer exists and the formula
  // is unverified until re-read. Both stop the build, on purpose.
  const code = readHlb(requireBoot([]));
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const cites = resolveCitations(code, srcDir);
  const bad = cites.report.filter((c) => c.state !== 'OK');
  ok(`every bytecode citation resolves, name and cache both (${cites.report.length} checked)`,
    bad.length === 0,
    bad.map((c) => `${c.state} ${c.name}@${c.cached}${c.now ? ' now @' + c.now : ''}`).join('; '));

  // The diff and the work list, on a synthetic patch: one stat nudge, one new
  // row, one deletion, one script rewrite - each must land in the right bucket
  // with the right validation need.
  const cdb2 = loadCdb({ quiet: true });
  const fp = buildFingerprint(cdb2);
  const mutated = JSON.parse(JSON.stringify(fp));
  const someSkill = Object.keys(mutated.sheets.skill)[0];
  mutated.sheets.skill[someSkill] = 'deadbeef0000';
  mutated.sheets.constant['Synthetic_New_Row'] = 'cafebabe0000';
  const someItem = Object.keys(mutated.sheets.item)[0];
  delete mutated.sheets.item[someItem];
  const someScript = Object.keys(mutated.scripts)[0];
  mutated.scripts[someScript] = 'feedface0000';

  const diff = diffFingerprints(fp, mutated);
  ok('a changed row is seen as changed', diff.sheets.skill?.changed?.includes(someSkill));
  ok('an added row is seen as added', diff.sheets.constant?.added?.includes('Synthetic_New_Row'));
  ok('a removed row is seen as removed', diff.sheets.item?.removed?.includes(someItem));
  ok('a rewritten script is its own kind of event', diff.scripts.changed.includes(someScript));

  const work = workList(diff, cdb2);
  const scriptItem = work.find((w) => w.id === someScript && w.kind === 'script-changed');
  ok('a changed script demands an in-game log, and names where to stand',
    scriptItem?.needs === 'in-game' && /dummy session/.test(scriptItem.why));
  ok('a changed constant routes to the SHEET check',
    work.find((w) => w.id === 'Synthetic_New_Row')?.needs === 'sheet');
  ok('an identical fingerprint reports no drift',
    diffFingerprints(fp, fp).same === true
    && Object.keys(diffFingerprints(fp, fp).sheets).length === 0);
}

// --- reading the capture ---------------------------------------------------
group('capture: the probe log');
{
  // Targets carry an instance suffix and sources do not, so the same function
  // has to be safe on both columns.
  ok('a target archetype drops its instance uid',
    archetype('Spirit_Z2W_Claws#9279') === 'Spirit_Z2W_Claws');
  ok('a player handle is left alone', archetype('Emsey') === 'Emsey');
  ok('a name with no uid is unchanged', archetype('Ratsar') === 'Ratsar');

  // `extra` is a ";"-separated bag, and it is the only column that may itself
  // contain a comma - so it is parsed, never split on.
  const x = parseExtra('affinity=Magic;hits=1');
  ok('extra decodes its key=value pairs', x.affinity === 'Magic' && x.hits === '1');
  ok('an absent extra is an empty bag', Object.keys(parseExtra('')).length === 0
    && Object.keys(parseExtra(undefined)).length === 0);
  ok('a bare flag in extra reads as true', parseExtra('crit;hits=2').crit === true);
  ok('a value containing = keeps it', parseExtra('why=a=b').why === 'a=b');

  // Build snapshots, as bench-probe v3 writes them. Exercised against a
  // synthetic log rather than a live capture, so the reader is testable before
  // the probe that produces them has ever been deployed.
  {
    const dir = mkdtempSync(join(tmpdir(), 'bench-capture-'));
    const path = join(dir, 'snap.csv');
    const rows = [
      'ts_ms,event,source,target,skill_id,amount,crit,stacks,max_stacks,extra',
      '1000,snap,Emsey,,,,,,,level=25;key=abc',
      '1000,snap_gear,Emsey,,Daggers_Demondash,,,,,upgrade=3;rarity=Epic;ilevel=300;flawless=1',
      '1000,snap_gear,Emsey,,Daggers_DuplicatePoison,,,,,upgrade=4;rarity=Epic;ilevel=300',
      '1000,snap_talent,Emsey,,Rogue_Talent_VirulentMagic,,,2,,',
      '1000,snap_wskill,Emsey,,Daggers_DuplicatePoison_Skill1,,,,,host=Daggers_DuplicatePoison',
      '1000,snap_wskill,Emsey,,Daggers_DuplicatePoison_Passive,,,,,host=Daggers_DuplicatePoison',
      '1000,snap_wskill,Emsey,,Bow_BigGame_Skill1,,,,,host=Bow_BigGame',
      '1000,snap_rune,Emsey,,Rogue_Finisher_M2,,,,,host=Rogue_Sig_Finisher',
      '1000,snap_rune,Emsey,,map,,,,,host=Rogue_Sig_Finisher',
      '1000,snap_attr,Emsey,,critChance,18.6,,,,',
      '1000,snap_hattr,Emsey,,comboPoint,3,,,,',
      '1500,inflict,Emsey,Ratsar#1,Rogue_Sig_Finisher,240,1,,,affinity=Physical;hits=1',
      '2000,snap,Emsey,,,,,,,level=25;key=def',
      '2000,snap_gear,Emsey,,Bow_BigGame,,,,,upgrade=0;ilevel=260',
      '2500,inflict,Emsey,Ratsar#1,Bow_BigGame_Skill1,180,0,,,affinity=Physical;hits=1',
      '',
    ].join('\n');
    writeFileSync(path, rows);

    const s = await snapshots(path, { source: 'Emsey' });
    ok('both build snapshots are read', s.snapshots.length === 2, String(s.snapshots.length));

    const first = s.snapshots[0];
    ok('a snapshot collects the gear that followed its marker', first.gear.length === 2);
    ok('...with the upgrade parsed as a number', first.gear[0].upgrade === 3);
    ok('...and flawless read as a flag, not a string',
      first.gear[0].flawless === true && first.gear[1].flawless === false);
    near('...and the item level parsed', first.gear[0].ilevel, 300, 1e-9);

    // The whole reason the snapshot exists.
    ok('talents are captured, which the modkit dump cannot do',
      first.talents.length === 1 && first.talents[0].id === 'Rogue_Talent_VirulentMagic');
    near('...with their rank', first.talents[0].rank, 2, 1e-9);
    near('the live sheet rides along', first.attrs.critChance, 18.6, 1e-9);
    near('...including the hero-side resource block', first.hattrs.comboPoint, 3, 1e-9);

    // v4: the weapon-skill selection, keyed by the granting weapon's kind.
    ok('slotted weapon skills are captured per host weapon',
      (first.weaponSkills?.Daggers_DuplicatePoison ?? []).length === 2
        && first.weaponSkills.Daggers_DuplicatePoison.includes('Daggers_DuplicatePoison_Passive'),
      JSON.stringify(first.weaponSkills ?? null));
    {
      // ...and only selections for WORN weapons reach the loadout: the bow is
      // an owned arsenal in the bag, not equipment, so its row stays behind.
      const built = fromSnapshot(cat, first, { unit: 'Rogue' });
      const w2 = built.loadout.gear.Slot_Weapon2?.item === 'Daggers_DuplicatePoison'
        ? 'Slot_Weapon2'
        : built.loadout.gear.Slot_Weapon1?.item === 'Daggers_DuplicatePoison' ? 'Slot_Weapon1' : null;
      ok('the worn weapon\'s selection lands on its slot, passive included',
        w2 !== null && (built.loadout.skills?.[w2] ?? []).includes('Daggers_DuplicatePoison_Passive'),
        JSON.stringify(built.loadout.skills ?? null));
      ok('an unworn arsenal\'s selection stays out of the loadout',
        !Object.values(built.loadout.skills ?? {}).some((ids) => ids.includes('Bow_BigGame_Skill1')));
      // v5: slotted runes land keyed AND valued by id - every consumer reads
      // the values - with proxy garbage rejected against the cdb's own
      // mastery lists, the same discipline the talent rows get.
      ok('a slotted rune reaches the loadout, id as value',
        built.loadout.runes?.Rogue_Finisher_M2 === 'Rogue_Finisher_M2',
        JSON.stringify(built.loadout.runes ?? null));
      ok('...and a proxy-struct name is rejected, not carried',
        !('map' in (built.loadout.runes ?? {})) && built.gaps.some((g) => /map/.test(g)),
        JSON.stringify({ runes: built.loadout.runes, gaps: built.gaps }));
    }

    // A snapshot stands until the next one, which is what makes it a window.
    near('a snapshot is bounded by the next one', first.until, 2000, 1e-9);
    ok('the last snapshot is open-ended', s.snapshots[1].until === null);
    ok('a later build does not inherit the earlier build\'s gear',
      s.snapshots[1].gear.length === 1 && s.snapshots[1].gear[0].kind === 'Bow_BigGame');

    // And the window actually selects the right damage.
    const inWindow = await aggregate(path, {
      source: 'Emsey', groupBy: 'skill', since: first.ts, until: first.until,
    });
    ok('the snapshot window selects only the damage that build did',
      inWindow.groups.length === 1 && inWindow.groups[0].key === 'Rogue_Sig_Finisher',
      inWindow.groups.map((g) => g.key).join(','));

    // Snapshot rows must not pollute the damage stream.
    const all = await aggregate(path, { source: 'Emsey', groupBy: 'skill' });
    ok('snap rows are not counted as damage', all.groups.length === 2);

    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the model against the record ------------------------------------------
group('verify: the model against the record');
{
  // A capture group as capture.mjs reports one, and a sim line as sim.mjs
  // emits one. Kept literal rather than built from the real files, because the
  // point of these is the JOIN - a test that needs a 400 MB log to run is a
  // test nobody runs.
  const grp = (key, hits, total, extra = {}) => ({
    key, hits, total, mean: total / hits, critRate: 0, p05: null, p50: null, p95: null,
    meanGapMs: null, integrality: 1, ...extra,
  });
  const line = (id, hits, damage, extra = {}) => ({
    id, name: id, hits, total: { damage }, interval: null, ...extra,
  });

  const r = compare({
    modelLines: [line('A', 100, 1000), line('B', 10, 500), line('Ghost', 5, 250)],
    captureGroups: [grp('A', 100, 1000), grp('B', 10, 250), grp('Unseen', 20, 400)],
  });
  const row = (id) => r.rows.find((x) => x.id === id);

  ok('a skill both sides know is BOTH', row('A').status === 'BOTH');
  near('...and an exact agreement reads as a zero per-hit delta', row('A').perHitDelta, 0, 1e-12);
  ok('...and is verdicted MATCH', row('A').verdict === 'MATCH');

  ok('a skill only the model claims is PHANTOM', row('Ghost').status === 'PHANTOM');
  ok('a skill only the game recorded is MISSING', row('Unseen').status === 'MISSING');

  // Signs are the whole point: the rows have to add into a ledger.
  near('the model claiming twice the damage per hit reads +100%',
    row('B').perHitDelta, 1, 1e-12);
  ok('a model overclaim is positive and an underclaim is negative',
    row('B').perHitDelta > 0 && compare({
      modelLines: [line('A', 100, 500)], captureGroups: [grp('A', 100, 1000)],
    }).rows[0].perHitDelta < 0);

  // Coverage is the number that belongs beside a dps figure.
  near('coverage is the share of RECORDED damage the model has any line for',
    r.totals.coverage, 1250 / 1650, 1e-12);
  near('unmodelled damage is counted, not ignored', r.totals.missingDamage, 400, 1e-12);

  ok('coverage holes outrank tuning errors in the ordering',
    r.rows[0].status === 'MISSING');

  // Share is in percentage points, not a ratio: a skill at 2% claimed at 4% is
  // 2pp out, and calling that "+100%" would rank it above things that matter.
  {
    const s = compare({
      modelLines: [line('Big', 10, 960), line('Small', 10, 40)],
      captureGroups: [grp('Big', 10, 980), grp('Small', 10, 20)],
    });
    near('share delta is a difference in percentage points',
      s.rows.find((x) => x.id === 'Small').shareDelta, 0.04 - 0.02, 1e-12);
  }

  // The same id can arrive as both an active and a triggered line. The capture
  // cannot tell those apart, so the join must not either.
  {
    const m = compare({
      modelLines: [line('Split', 5, 50), line('Split', 5, 50)],
      captureGroups: [grp('Split', 10, 100)],
    });
    ok('a skill on two model lines is folded into one row', m.rows.length === 1);
    near('...and its per-hit is the pooled one', m.rows[0].perHitDelta, 0, 1e-12);
  }

  // A line the fight never played is not a claim about anything, so it must not
  // turn into a PHANTOM the reader has to dismiss by hand.
  ok('an unplayed model line is not reported as PHANTOM',
    compare({ modelLines: [line('Never', 0, 0)], captureGroups: [grp('A', 1, 1)] })
      .totals.phantom === 0);

  ok('an empty capture leaves coverage undefined rather than 100%',
    compare({ modelLines: [line('A', 1, 1)], captureGroups: [] }).totals.coverage === null);

  // `only` scopes the comparison to a build's own kit.
  ok('the only-set scopes which recorded skills are considered',
    compare({
      modelLines: [line('A', 1, 1)],
      captureGroups: [grp('A', 1, 1), grp('Other', 9, 9)],
      only: new Set(['A']),
    }).totals.missing === 0);
}

// --- summary ---------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
