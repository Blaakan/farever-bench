// ---------------------------------------------------------------------------
// profiles.mjs - a character whose stats are STATED, not earned.
//
// WHY THIS EXISTS. The best rotation depends on the weapon, the talents, the
// runes and the stats; the best gear depends on the rotation. Searched together
// that is one problem with two moving halves, and the gear half is the
// expensive one - twenty thousand loadouts, where a rotation search wants
// thousands of fights per loadout.
//
// A profile cuts the knot by PINNING every stat to a flat number. Then a
// rotation, or a weapon, can be compared with nothing else moving.
//
// THE NUMBERS ARE ARBITRARY, AND THAT IS THE POINT. 50 is not half of anything
// and it is not what any character wears; it is a fixed rig, the same for every
// weapon and every class, so that two weapons differ only in the kit they grant
// and the coefficients they scale by. A profile denominated in budget fractions
// cannot do that - a Warrior's full primary budget is 123.6 and a Rogue's is
// 148.3, so "half a budget" is a different number per class and the comparison
// carries the budget's shape with it.
//
// FORCED, NOT ADDED. The values REPLACE whatever the level curve, the gear and
// the weapon produce, so a weapon that happens to be a better stat stick does
// not win on that. `computeSheet` applies them inside its topological walk, so
// everything downstream is computed from the forced number: pin Dexterity and
// the CritChance that scales off it moves with it.
//
// So `crit` minus `mid` is exactly "+50 CritChanceRating and nothing else
// moved" - the comparison that isolates a stat.
// ---------------------------------------------------------------------------

import { budget, resistForReduction } from './model.mjs';

// The rig. Every stat sits here, and one profile raises one of them.
export const BASE_VALUE = 50;
export const PEAK_VALUE = 100;

/**
 * Which attributes a profile pins.
 *
 * The four primaries, the two health/armour stats, and the four ratings - the
 * inputs the damage model actually reads. Everything else on the sheet is
 * DERIVED from these (CritChance off Dexterity and Faith, CritDamage off
 * Strength and Intellect, MaxHealth off Vitality) and is deliberately left to be
 * computed, because pinning a derived stat as well would let the two disagree.
 */
export const PINNED = [
  'Strength', 'Dexterity', 'Intellect', 'Faith',
  'Vitality', 'Armor', 'MagicArmor',
  'CritChanceRating', 'ArmorPenetrationRating', 'SpellPenetrationRating', 'FervorRating',
];

// The ten single-stat corners, plus the two flat ones.
const PEAKS = [
  ['strength', 'Strength'],
  ['dexterity', 'Dexterity'],
  ['intellect', 'Intellect'],
  ['faith', 'Faith'],
  ['vitality', 'Vitality'],
  ['armor', 'Armor'],
  ['magicarmor', 'MagicArmor'],
  ['crit', 'CritChanceRating'],
  ['armorpen', 'ArmorPenetrationRating'],
  ['spellpen', 'SpellPenetrationRating'],
  ['fervor', 'FervorRating'],
];

export const PROFILES = [
  { id: 'zero', label: 'everything at 0', desc: 'every stat pinned to 0', base: 0 },
  { id: 'mid', label: `everything at ${BASE_VALUE}`, desc: `every stat pinned to ${BASE_VALUE}` },
  ...PEAKS.map(([id, atb]) => ({
    id,
    label: `${atb} at ${PEAK_VALUE}`,
    desc: `every stat pinned to ${BASE_VALUE}, ${atb} to ${PEAK_VALUE}`,
    peak: atb,
  })),
];

export function buildProfiles(cdb, ctx, cat) {
  const aptitudes = cdb.byId('aptitude');
  const groupNames = cdb.enumValues('aptitude@atbScaling', 'statGroup');
  const byId = new Map(PROFILES.map((p) => [p.id, p]));

  /**
   * What a complete set of real gear would deliver, per stat group.
   *
   * A profile does NOT use this - its numbers are stated, not earned - but
   * `bench profiles` prints it beside them, because "50 CritChanceRating" means
   * nothing until you know a full set delivers 380.
   */
  function budgetsFor(unitId, level) {
    const cls = cat.classes.find((c) => c.unit === unitId || c.aptitude === unitId);
    if (!cls) throw new Error(`unknown class "${unitId}"`);
    const apt = aptitudes.get(cls.aptitude);
    if (!apt) throw new Error(`no aptitude row "${cls.aptitude}"`);

    const out = { cls, primary: null, vitality: null, armor: null, ratings: [] };
    for (const row of apt.atbScaling ?? []) {
      const group = groupNames[row.statGroup ?? 0] ?? null;
      const isArmor = row.endAtb === 'Armor' || row.endAtb === 'MagicArmor';
      const total = isArmor
        ? resistForReduction(level, cat.armorReductionFor(cls.aptitude), ctx.consts.resistFormula)
        : budget(level, row.start, row.end, ctx.consts.earlyMaxLevel);
      if (!total) continue;
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

  /**
   * @param base  what every stat is pinned to      (default 50)
   * @param peak  what the profile's one stat is pinned to  (default 100)
   */
  function resolve(name, unitId, level, { base = BASE_VALUE, peak = PEAK_VALUE } = {}) {
    const spec = byId.get(name);
    if (!spec) {
      throw new Error(`unknown profile "${name}". Known: ${PROFILES.map((p) => p.id).join(', ')}`);
    }
    if (!(base >= 0) || !(peak >= 0)) throw new Error('profile values must be zero or more');
    const at = spec.base != null ? spec.base : base;
    const force = new Map();
    for (const atb of PINNED) {
      if (!ctx.attrTable.byId.has(atb)) continue;   // a patch renamed it; do not invent
      force.set(atb, spec.peak === atb ? peak : at);
    }
    const b = budgetsFor(unitId, level);
    return {
      id: spec.id,
      label: spec.label,
      desc: spec.desc,
      unit: b.cls.unit,
      level,
      base: at,
      peak: spec.peak ? peak : null,
      peakAtb: spec.peak ?? null,
      force,
      budgets: b,
      // One sentence, on every result that used one. A stat sheet nobody can
      // wear produces a dps nobody will see, and the number is only ever a
      // COMPARISON between weapons or rotations on the same rig.
      notes: [
        'these stats are pinned to flat values, not earned from gear - the number is a '
        + 'comparison between builds on the same rig, never a dps anyone will read in game',
      ],
    };
  }

  return { list: () => PROFILES, resolve, budgetsFor, pinned: PINNED };
}

