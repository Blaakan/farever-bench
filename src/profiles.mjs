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
 * Named corners. `groups` scales each group's full-set budget; `rating`
 * concentrates the whole ratings budget into one attribute instead of
 * splitting it; `primary` redirects the primary budget to another attribute.
 *
 * Deliberately few. Every one of them answers a question - how much gear, which
 * rating, which primary - and a corner nobody can name the question for is a
 * row of numbers pretending to be a result.
 */
export const PROFILES = [
  {
    id: 'naked', label: 'naked',
    desc: 'base stats only - the level curve and nothing else',
    groups: { Primary: 0, Vitality: 0, Armor: 0, Ratings: 0 },
  },
  {
    id: 'half', label: 'half-geared',
    desc: 'half of every budget, ratings split evenly',
    groups: { Primary: 0.5, Vitality: 0.5, Armor: 0.5, Ratings: 0.5 },
  },
  {
    id: 'full', label: 'fully geared',
    desc: 'a complete set, ratings split evenly across the three this class can wear',
    groups: { Primary: 1, Vitality: 1, Armor: 1, Ratings: 1 },
  },
  { id: 'crit', label: 'crit', desc: 'fully geared, the whole ratings budget in CritChance', rating: 'CritChanceRating' },
  { id: 'armorpen', label: 'armour penetration', desc: 'fully geared, the whole ratings budget in ArmorPenetration', rating: 'ArmorPenetrationRating' },
  { id: 'spellpen', label: 'spell penetration', desc: 'fully geared, the whole ratings budget in SpellPenetration', rating: 'SpellPenetrationRating' },
  { id: 'fervor', label: 'fervor', desc: 'fully geared, the whole ratings budget in Fervor', rating: 'FervorRating' },
  { id: 'strength', label: 'strength', desc: 'fully geared, the primary budget in Strength', primary: 'Strength' },
  { id: 'dexterity', label: 'dexterity', desc: 'fully geared, the primary budget in Dexterity', primary: 'Dexterity' },
  { id: 'intellect', label: 'intellect', desc: 'fully geared, the primary budget in Intellect', primary: 'Intellect' },
  { id: 'faith', label: 'faith', desc: 'fully geared, the primary budget in Faith', primary: 'Faith' },
];

const FULL = { Primary: 1, Vitality: 1, Armor: 1, Ratings: 1 };

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
    const scale = { ...FULL, ...(spec.groups ?? {}) };
    for (const k of Object.keys(scale)) scale[k] *= mult;
    const inject = new Map();
    const notes = [];
    const add = (atb, v) => { if (v) inject.set(atb, (inject.get(atb) ?? 0) + v); };

    // Primary. Redirecting it to another class's stat is a hypothetical, and a
    // useful one: it answers whether a weapon's kit scales off that stat at all.
    if (b.primary && scale.Primary) {
      const atb = spec.primary ?? b.primary.atb;
      if (spec.primary && spec.primary !== b.primary.atb) {
        if (!allPrimaries.has(spec.primary)) throw new Error(`no aptitude pays ${spec.primary} as a primary`);
        notes.push(`${spec.primary} is not attainable on a ${b.cls.unit}: an item pays the WEARER's aptitude, `
          + `and ${b.cls.aptitude} pays ${b.primary.atb}. This corner is a probe, not a build.`);
      }
      add(atb, b.primary.amount * scale.Primary);
    }
    if (b.vitality && scale.Vitality) add(b.vitality.atb, b.vitality.amount * scale.Vitality);
    if (b.armor && scale.Armor) add(b.armor.atb, b.armor.amount * scale.Armor);

    // Ratings. One budget, and which rating it lands in is the whole decision -
    // faction decides it, and a Demon augment can convert 40 of it at a time.
    if (scale.Ratings) {
      const total = (b.ratings[0]?.amount ?? 0) * scale.Ratings;
      if (spec.rating) {
        if (!allRatings.has(spec.rating)) throw new Error(`no aptitude pays ${spec.rating}`);
        const own = b.ratings.find((r) => r.atb === spec.rating);
        if (!own) {
          notes.push(`${spec.rating} is not attainable on a ${b.cls.unit} from gear: no faction pays it for `
            + `${b.cls.aptitude}. A Demon augment converts 40 rating at a time, so part of it is reachable.`);
        }
        add(spec.rating, total);
      } else {
        // Split evenly across what this class can actually wear, which is the
        // honest reading of "geared, no particular faction".
        for (const r of b.ratings) add(r.atb, total / b.ratings.length);
      }
    }

    return {
      id: spec.id, label: spec.label, desc: spec.desc, notes, scale: mult,
      unit: b.cls.unit, level, inject, budgets: b,
    };
  }

  return { list: () => PROFILES, resolve, budgetsFor, groups: GROUPS };
}
