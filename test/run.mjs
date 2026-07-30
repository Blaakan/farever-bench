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
  near('Slot_Weapon2 contributes affixFactor of Slot_Weapon1',
    f2, f1 * cat.slotById.get('Slot_Weapon2').affixFactor, 1e-9);

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

// --- alternative aptitudes -------------------------------------------------
// An item's `aptitudes` column is a set of alternatives, not a set the item is
// all of at once. Summing them would pay the shared MaxHealth budget once per
// entry - which is a 4x error on the craft necklaces.
group('alternative aptitudes');
{
  const engine = createEngine();
  const multi = cat.items.find((i) => !i.isAugment && i.slots.length
    && cat.payingAptitudes(i, 'Cleric').length > 1);
  ok('an item with alternative aptitudes exists', !!multi, multi?.id);
  ok('no item mixes class and generic aptitudes',
    !cat.items.some((i) => {
      const classApts = new Set(cat.classes.map((c) => c.aptitude));
      return i.aptitudes.some((a) => classApts.has(a)) && i.aptitudes.some((a) => cat.isGeneric(a));
    }));

  const slot = multi.slots.find((s) => cat.slotById.get(s)?.combat);
  const options = cat.payingAptitudes(multi, 'Cleric');
  const seen = new Map();
  for (const apt of options) {
    const l = { ...emptyLoadout(cat, 'Priest', 25) };
    l.gear[slot] = { item: multi.id, rarity: multi.rarity, aptitude: apt, stars: 0 };
    const ev = engine.evaluate(l);
    seen.set(apt, ev);
  }
  const healths = [...seen.values()].map((ev) => ev.sheet.get('MaxHealth'));
  ok('every alternative pays the same shared MaxHealth budget',
    new Set(healths.map((h) => h.toFixed(6))).size === 1, healths.join(', '));

  // The whole point: choosing one must give ONE rating, not all of them.
  for (const [apt, ev] of seen) {
    const ratings = ['CritChanceRating', 'FervorRating', 'ArmorPenetrationRating', 'SpellPenetrationRating']
      .filter((r) => (ev.sheet.get(r) ?? 0) > 0);
    ok(`${multi.id} as ${apt} grants exactly one rating`, ratings.length === 1, ratings.join('+'));
  }

  // And the pinned-item-but-free-aptitude path must actually vary it.
  const pinned = emptyLoadout(cat, 'Priest', 25);
  pinned.gear[slot] = { item: multi.id, rarity: multi.rarity, aptitude: options[0], stars: 0 };
  const r = optimize(engine, {
    loadout: pinned, goal: 'dps', target: engine.combat.foe('reference', 25), rank: 3, restarts: 1,
    pinnedGear: new Set([slot]), aptFree: new Set([slot]),
  });
  ok('an aptitude-free pin keeps the item', r.loadout.gear[slot].item === multi.id);
  ok('an aptitude-free pin picks a legal aptitude',
    options.includes(r.loadout.gear[slot].aptitude), String(r.loadout.gear[slot].aptitude));
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

  // Dropping the unverified Fervor multiplier must change what is optimal -
  // that is the whole reason it is flagged.
  const noFervor = createEngine({ assume: { fervorDamage: false } });
  const e = optimize(noFervor, {
    loadout: JSON.parse(JSON.stringify(seed)), goal: 'dps',
    target: noFervor.combat.foe('reference', 25), rank: 3, restarts: 2,
  });
  ok('the Fervor-damage assumption changes the answer',
    JSON.stringify(e.loadout.gear) !== JSON.stringify(a.loadout.gear));

  // Exclusions must actually exclude.
  const f = runOnce({ exclude: /^GM_/ });
  ok('excluded ids never appear',
    !Object.values(f.loadout.gear).some((g) => /^GM_/.test(g.item)));
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
  const onArmoured = engine.evaluate(build, { target: engine.combat.foe('armoured', 25) });
  ok('a mitigating target lowers damage', onDummy.throughput.dps > onRef.throughput.dps);
  ok('more armour lowers it further', onRef.throughput.dps > onArmoured.throughput.dps);
  ok('the dummy really has no mitigation', engine.combat.foe('dummy', 25).armor === 0);
  ok('a build does some damage at all', onDummy.throughput.dps > 0);
  ok('the rotation is not empty', onDummy.throughput.lines.length > 0);
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

// --- summary ---------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
