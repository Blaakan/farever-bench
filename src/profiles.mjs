// ---------------------------------------------------------------------------
// profiles.mjs - a character with no gear on, at a stated corner of the stat
// space.
//
// WHY THIS EXISTS. The best rotation depends on the weapon, the talents, the
// runes and the stats; the best gear depends on the rotation. Searched together
// that is one problem with two moving halves, and the gear search is the
// expensive one - twenty thousand loadouts, where a rotation search wants
// thousands of fights per loadout.
//
// A profile cuts the knot by replacing the gear with a FIXED, NAMED stat sheet.
// Then a rotation can be searched over (profile x weapon x skills x talents x
// runes) with nothing else moving, and if the winner is the same rotation at
// every corner it is a rotation for the build rather than for one gear set -
// at which point the gear search runs once, with the rotation held fixed.
//
// NOTHING HERE IS INVENTED. "High" has a data-defined meaning:
//
//   * `aptitude.atbScaling` gives each stat group's `start`/`end`, and
//     `budget(level, start, end)` is the curve every other number in this
//     project comes off.
//   * `itemType.atbRatio` sums to EXACTLY 1.0 per stat group over one item per
//     core slot - mainhand, the eight armour pieces, neck and two fingers - a
//     fact the test suite asserts. So one full budget IS a complete set, and a
//     profile is denominated in fractions of it.
//   * Armor takes the same treatment it does everywhere else: not the authored
//     columns, but `resistForReduction(level, props.armorReduction)`.
//
// So `full` is a character wearing a perfect set of the named rating and
// nothing else is guessed. `naked` is the character the model is already
// checked against in game, to the point.
//
// WHAT IS NOT ATTAINABLE IS SAID SO. Gear pays the wearer's own aptitude, so a
// Warrior cannot get Faith from a chestpiece and cannot get SpellPenetration
// from any faction - `conds.factions` on the Fighter's rating rows lists
// Manfish/Bee/World/Craft for ArmorPenetration, Kobold/Starter for CritChance
// and Crimson/Demon for Fervor, and no row at all for SpellPenetration. Those
// corners are still worth probing, because they answer "does this weapon's kit
// care about that stat" - but they are hypotheticals and the output says so.
// ---------------------------------------------------------------------------

import { budget, resistForReduction } from './model.mjs';

// The four stat groups, as `aptitude@atbScaling.statGroup` enumerates them.
const GROUPS = ['Primary', 'Vitality', 'Armor', 'Ratings'];

/**
 * THE SHAPE OF THE SET, AND WHY IT IS THIS SHAPE.
 *
 * Every stat sits at the same fraction of ITS OWN full-set budget, and one of
 * them is raised to the top. So `crit` minus `mid` is exactly "half a budget
 * more CritChance and nothing else has moved", which is the comparison that
 * isolates a stat. A corner that instead poured the whole ratings budget into
 * one rating and left the others empty changed two things at once - more crit
 * AND no penetration - and a difference with two causes measures neither.
 *
 *   zero          nothing. The level curve and the weapon, and that is all.
 *   mid           every stat at half of a full set of it.
 *   full          every stat at a full set of it.
 *   <stat>        `mid`, with that one stat at a full set.
 *
 * `mid` and every peak profile are DELIBERATELY UNATTAINABLE, and say so: three
 * ratings at half a budget each is one and a half budgets, and gear delivers
 * one. That is the point of a probe - it holds nine stats still and moves the
 * tenth, which no real set can do, and it is the only way to read a stat's
 * effect without the rest of the build answering back.
 */
const PEAKS = [
  ['strength', 'Strength', 'primary'],
  ['dexterity', 'Dexterity', 'primary'],
  ['intellect', 'Intellect', 'primary'],
  ['faith', 'Faith', 'primary'],
  ['vitality', 'Vitality', 'vitality'],
  ['armor', 'Armor', 'armor'],
  ['crit', 'CritChanceRating', 'rating'],
  ['armorpen', 'ArmorPenetrationRating', 'rating'],
  ['spellpen', 'SpellPenetrationRating', 'rating'],
  ['fervor', 'FervorRating', 'rating'],
];

const MID = 0.5;

export const PROFILES = [
  { id: 'zero', label: 'nothing', desc: 'no gear at all - the level curve and the weapon', base: 0 },
  { id: 'mid', label: 'half of everything', desc: 'every stat at half of a full set of it', base: MID },
  { id: 'full', label: 'all of everything', desc: 'every stat at a full set of it', base: 1 },
  ...PEAKS.map(([id, atb, group]) => ({
    id,
    label: id,
    desc: `every stat at half, ${atb.replace('Rating', '')} at a full set`,
    base: MID,
    peak: { atb, group },
  })),
];

export function buildProfiles(cdb, ctx, cat) {
  const aptitudes = cdb.byId('aptitude');
  const groupNames = cdb.enumValues('aptitude@atbScaling', 'statGroup');

  /**
   * What a complete set delivers to this class, per group, at this level.
   *
   * The rating rows are returned WITH their faction gates, because that is what
   * says whether a corner is reachable: the Fighter has three rating rows and
   * none of them is SpellPenetration, so a Warrior in spellpen gear is a
   * hypothetical however good it looks.
   */
  function budgetsFor(unitId, level) {
    const cls = cat.classes.find((c) => c.unit === unitId || c.aptitude === unitId);
    if (!cls) throw new Error(`unknown class "${unitId}"`);
    const apt = aptitudes.get(cls.aptitude);
    if (!apt) throw new Error(`no aptitude row "${cls.aptitude}"`);

    const out = { cls, primary: null, vitality: null, armor: null, ratings: [] };
    for (const row of apt.atbScaling ?? []) {
      const group = groupNames[row.statGroup ?? 0] ?? null;
      // Armor is design intent, not a number: the same inverse the whole model
      // uses, off props.armorReduction rather than the authored columns.
      const isArmor = row.endAtb === 'Armor' || row.endAtb === 'MagicArmor';
      const total = isArmor
        ? resistForReduction(level, cat.armorReductionFor(cls.aptitude), ctx.consts.resistFormula)
        : budget(level, row.start, row.end, ctx.consts.earlyMaxLevel);
      if (!total) continue;
      // `{endAtb: MaxHealth, sourceAtb: Vitality}` states its budget in
      // MaxHealth and delivers it as Vitality, so divide by what one Vitality
      // buys. Same lookup the gear layer does, never a constant.
      const atb = row.sourceAtb ?? row.endAtb;
      const amount = total / sourceConversion(row.endAtb, row.sourceAtb);
      const entry = { atb, amount, factions: (row.conds?.factions ?? []).map((f) => f.ref) };
      if (group === 'Primary') out.primary = entry;
      else if (group === 'Vitality') out.vitality = entry;
      else if (group === 'Armor') out.armor = entry;
      else if (group === 'Ratings') out.ratings.push(entry);
    }
    return out;
  }

  function sourceConversion(endAtb, sourceAtb) {
    if (!sourceAtb || sourceAtb === endAtb) return 1;
    const end = ctx.attrTable.byId.get(endAtb);
    const hit = end?.scaling.find((s) => s.from === sourceAtb && s.op.case !== 'Rating');
    if (!hit?.scale) {
      throw new Error(`aptitude.atbScaling maps ${sourceAtb} -> ${endAtb} but the conversion factor is unknown`);
    }
    return hit.scale;
  }

  /** Every rating any aptitude in this build can pay, class or generic. */
  const allRatings = (() => {
    const s = new Set();
    for (const apt of cdb.lines('aptitude')) {
      for (const row of apt.atbScaling ?? []) {
        if ((groupNames[row.statGroup ?? 0] ?? null) === 'Ratings') s.add(row.endAtb);
      }
    }
    return s;
  })();

  const allPrimaries = (() => {
    const s = new Set();
    for (const apt of cdb.lines('aptitude')) {
      for (const row of apt.atbScaling ?? []) {
        if ((groupNames[row.statGroup ?? 0] ?? null) === 'Primary') s.add(row.sourceAtb ?? row.endAtb);
      }
    }
    return s;
  })();

  const byId = new Map(PROFILES.map((p) => [p.id, p]));

  /**
   * Resolve a profile into the flat injections a sheet needs, plus whatever the
   * output has to say about it.
   */
  /**
   * @param mult  fraction of a full set. 1.0 is exactly one authored budget,
   *              which is the DESIGNERS' unit and not the ceiling: a maxed
   *              build runs above it, because a Legendary roll puts an item's
   *              effective level above the character's, augments add on top of
   *              the budget rather than inside it, and the arsenal contributes
   *              0.4 of a second weapon. A level-25 Warrior the optimiser
   *              dressed reads 469 ArmorPenetrationRating against the 380 one
   *              budget delivers, so 1.0 and 1.25 bracket what is real.
   */
  function resolve(name, unitId, level, mult = 1) {
    const spec = byId.get(name);
    if (!spec) {
      throw new Error(`unknown profile "${name}". Known: ${PROFILES.map((p) => p.id).join(', ')}`);
    }
    if (!(mult >= 0)) throw new Error(`profile scale must be zero or more, got ${mult}`);
    const b = budgetsFor(unitId, level);
    const base = (spec.base ?? 1) * mult;
    const peak = spec.peak ? 1 * mult : null;
    const inject = new Map();
    const notes = [];
    const add = (atb, v) => { if (v) inject.set(atb, (inject.get(atb) ?? 0) + v); };
    const at = (atb) => (spec.peak?.atb === atb ? peak : base);

    // EVERY stat this class's aptitude can pay, each at its own fraction of its
    // own full-set budget. All four ratings appear, not just the three a
    // Fighter's factions grant: raising SpellPenetration on a Warrior is a
    // question worth asking - does this weapon's kit care - even though no
    // faction pays it.
    const primaryAmount = b.primary?.amount ?? 0;
    for (const atb of allPrimaries) {
      // Only the class's own primary is on by default; another class's is paid
      // only when it is the one being probed, at the same magnitude, so
      // "the same amount of primary stat, in a different stat" is the reading.
      if (atb !== b.primary?.atb && spec.peak?.atb !== atb) continue;
      add(atb, primaryAmount * at(atb));
    }
    if (b.vitality) add(b.vitality.atb, b.vitality.amount * at(b.vitality.atb));
    if (b.armor) add(b.armor.atb, b.armor.amount * at(b.armor.atb));

    const ratingAmount = b.ratings[0]?.amount ?? 0;
    for (const atb of allRatings) add(atb, ratingAmount * at(atb));

    // What no real set can deliver. Said plainly, because a probe presented as
    // a build is the one thing this whole file exists to avoid.
    const over = [...allRatings].reduce((s, atb) => s + at(atb), 0);
    if (over > 1 + 1e-9) {
      notes.push(`the ratings here total ${over.toFixed(2)} full budgets and gear delivers ONE, `
        + 'so this corner holds the other stats still while it moves one. A probe, not a build.');
    }
    if (spec.peak?.group === 'rating' && !b.ratings.some((r) => r.atb === spec.peak.atb)) {
      notes.push(`${spec.peak.atb} is paid by no faction for ${b.cls.aptitude}, so a ${b.cls.unit} `
        + 'cannot reach it from gear at all. A Demon augment converts 40 rating at a time.');
    }
    if (spec.peak?.group === 'primary' && spec.peak.atb !== b.primary?.atb) {
      notes.push(`${spec.peak.atb} is not attainable on a ${b.cls.unit}: an item pays the WEARER's `
        + `aptitude, and ${b.cls.aptitude} pays ${b.primary?.atb}.`);
    }

    return {
      id: spec.id, label: spec.label, desc: spec.desc, notes, scale: mult,
      base, peak: spec.peak ?? null,
      unit: b.cls.unit, level, inject, budgets: b,
    };
  }

  return { list: () => PROFILES, resolve, budgetsFor, groups: GROUPS };
}
