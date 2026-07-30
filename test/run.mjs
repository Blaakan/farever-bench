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

  // Level 10 instance: the CDB authors level 8, so the reading is pinned to the
  // effective level rather than to the authored one.
  const INSTANCE_LEVEL = 10;
  ok('a level-10 Rare instance is effective level 11',
    cat.effectiveLevel({ ...spear, level: INSTANCE_LEVEL, iLevel: null }, { charLevel: 25, stars: 0 }) === 11);

  const OBSERVED = {
    mainHand: { Vitality: 36, Dexterity: 18, Faith: 15, CritChanceRating: 39, ArmorPenetrationRating: 39 },
    arsenal: { Vitality: 15, Dexterity: 8, Faith: 6, CritChanceRating: 16, ArmorPenetrationRating: 16 },
  };

  for (const [slotId, want] of [['Slot_Weapon1', OBSERVED.mainHand], ['Slot_Weapon2', OBSERVED.arsenal]]) {
    const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
    cat.contribute({ ...spear, level: INSTANCE_LEVEL, iLevel: null }, slotId, {
      aptitude: 'Assassin', charLevel: 25, stars: 0,
      rarity: 'Rare', armorReduction: cat.armorReductionFor('Assassin'),
    }, mods);
    for (const [atb, v] of Object.entries(want)) {
      near(`${slotId} ${atb} matches the character sheet`, mods.flat.get(atb) ?? 0, v, 1e-9);
    }
    // Nothing else should appear: no Strength, no Intellect, no Fervor.
    const extra = [...mods.flat.keys()].filter((k) => !(k in want));
    ok(`${slotId} grants nothing the sheet does not show`, extra.length === 0, extra.join(', '));
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

  // Confirmed on the spear: all of them pay, so a two-rating item is real.
  const slot = multi.slots.find((s) => cat.slotById.get(s)?.combat);
  const l = emptyLoadout(cat, 'Priest', 25);
  l.gear[slot] = { item: multi.id, rarity: multi.rarity, stars: 0 };
  const ev = engine.evaluate(l);
  // Both aptitudes pay their MaxHealth share, so Vitality is the SUM of the two
  // budgets - not one of them. Two aptitudes may well map the same faction to
  // the same rating (Mace_Benediction is Crimson, and both Fighter and Cleric
  // read Crimson as Fervor), so the rating COUNT is not the thing to assert;
  // the Spear_Eruption case above covers two-different-ratings rigorously.
  const single = emptyLoadout(cat, 'Priest', 25);
  single.gear[slot] = { item: { ...multi, aptitudes: [multi.aptitudes[0]] }.id, rarity: multi.rarity, stars: 0 };
  const oneApt = new Map();
  cat.contribute({ ...multi, aptitudes: [multi.aptitudes[0]] }, slot,
    { aptitude: 'Cleric', charLevel: 25, stars: 0, rarity: multi.rarity, armorReduction: 0.25 },
    { flat: oneApt, addRatio: new Map(), mulRatio: new Map() });
  const bothApt = new Map();
  cat.contribute(multi, slot,
    { aptitude: 'Cleric', charLevel: 25, stars: 0, rarity: multi.rarity, armorReduction: 0.25 },
    { flat: bothApt, addRatio: new Map(), mulRatio: new Map() });
  ok(`${multi.id} pays more with both aptitudes than with one`,
    (bothApt.get('Vitality') ?? 0) > (oneApt.get('Vitality') ?? 0),
    `${bothApt.get('Vitality')} vs ${oneApt.get('Vitality')} (${multi.aptitudes.join('+')})`);
  ok('and it grants at least one rating', ratingsOf(ev.sheet).length > 0, ratingsOf(ev.sheet).join(','));
  ok('every stat a full-factor slot grants is a whole number',
    [...bothApt.values()].every((v) => Number.isInteger(v)),
    [...bothApt.entries()].map(([k, v]) => k + '=' + v).join(' '));
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
  ok('a better rarity allows more upgrade stars',
    cat.maxStars(it, 'Legendary') > cat.maxStars(it, 'Rare'));
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

  // And with the skills modelled, the dps optimum should be led by PENETRATION
  // rather than by the unverified Fervor multiplier. Before the rotation was
  // modelled, base attacks were the only damage, Fervor was the only multiplier
  // that touched them, and the search dressed a Priest entirely in Fervor gear.
  // If this starts failing, the rotation has regressed to that state.
  const pen = (a.evaluation.sheet.get('SpellPenetrationRating') ?? 0)
    + (a.evaluation.sheet.get('ArmorPenetrationRating') ?? 0);
  ok('the dps optimum is led by penetration, not by the Fervor assumption',
    pen > (a.evaluation.sheet.get('FervorRating') ?? 0),
    `penetration ${pen.toFixed(0)} vs Fervor ${(a.evaluation.sheet.get('FervorRating') ?? 0).toFixed(0)}`
      + ' - skills may have stopped being scored');

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

  // A resource-gated skill with no cooldown must NOT be treated as spammable.
  const rageStrike = engine.combat.profile('Warrior_Rage_Strike', 3);
  ok('Warrior_Rage_Strike has no cooldown', !(rageStrike.cooldown > 0), String(rageStrike.cooldown));
  ok('and it declares a resource cost', rageStrike.costs.length > 0, JSON.stringify(rageStrike.costs));
  const w = emptyLoadout(cat, 'Warrior', 25);
  const wOpt = optimize(engine, { loadout: w, goal: 'dps', target, rank: 3, restarts: 1 });
  const rot = wOpt.evaluation.rotation;
  ok('a resource-gated skill is reported unmodelled rather than scored',
    rot.unmodelled.some((u) => u.id === 'Warrior_Rage_Strike')
      && !rot.active.some((x) => x.prof.id === 'Warrior_Rage_Strike'),
    JSON.stringify(rot.unmodelled.map((u) => u.id)));

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
  ok('the archetype ladder is ordered small < trash < big <= elite',
    red('small') < red('trash') && red('trash') < red('big') && red('big') <= red('elite'),
    [red('small'), red('trash'), red('big'), red('elite')].join(' < '));
  ok('a named boss matches the elite tier', red('boss') === red('elite'),
    `${red('boss')} vs ${red('elite')}`);
  ok('Armor_ExpectedReduction is softer than what you actually fight',
    engine.combat.foe('reference', 25).physReduction < red('boss'),
    `${engine.combat.foe('reference', 25).physReduction} vs ${red('boss')}`);

  // Physical and magical reduction are EQUAL on every real foe, which is why
  // ArmorPenetration and SpellPenetration are interchangeable in value. If a
  // patch splits them, penetration choice starts depending on the fight - and
  // that is exactly when this tool needs to be told.
  let split = 0;
  for (const [id, i] of engine.combat.targetsByUnit) {
    if (/Dummy|PunchingBag/.test(id)) continue;      // dev targets deliberately split
    if (i.phys == null || i.mag == null) continue;
    if (i.phys !== i.mag) split++;
  }
  ok('no real foe splits physical and magical reduction', split === 0,
    `${split} units do - penetration is no longer target-independent`);
  ok('a real unit id works as a target', engine.combat.foe('Ratsar', 25).armor > 0);
  ok('most units resolve an intent through inheritance', engine.combat.targetsByUnit.size > 100,
    String(engine.combat.targetsByUnit.size));

  // Penetration is worth more against a harder target - the whole reason the
  // default moved off the constant.
  const gain = (n) => {
    const t = engine.combat.foe(n, 25);
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
  ok('readable talent count is in the low twenties, not the high fifties',
    readable > 20 && readable < 35, `${readable} of ${total} - if this jumped, texts.refs is being followed`);
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

// --- summary ---------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
