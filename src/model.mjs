// ---------------------------------------------------------------------------
// model.mjs - the stat engine.
//
// Everything here was read out of the game's own compiled code (hlboot.dat
// ships HashLink bytecode v4 with full debug info), not inferred from the
// shape of the data. Each formula carries the function index and source line
// it came from, so a future patch can be re-checked against the same place.
//
// The four load-bearing facts:
//
//   1. One function drives every stat curve in the game
//      (HAttributes.field#6, @src/const/HAttributes.hx:15-24):
//
//         budget(L, min, max) = min * (max/min) ^ ((L-1) / (EarlyMaxLevel-1))
//
//      with EarlyMaxLevel = 50, taken from the `constant` sheet - never
//      hardcoded, because the level cap is 25 today and will move.
//
//   2. Rating -> percent (ent.Unit.getAtbScaling, findex 4801,
//      @src/ent/Unit.hx:1383):
//
//         contribution = (rating / budget(L, min, max)) * target
//
//      and the `scale` field sitting next to it is NEVER READ on this path.
//      CritChanceRating's scale of 0.1 and FervorRating's 0.05 are dead data;
//      a naive `scale * rating` is off by about 7.5x. Because min and max are
//      the level-1 and level-50 rating budgets, a full budget yields exactly
//      `target` percentage points at any level - rating is exactly linear at
//      a fixed level, and loses (1000/150)^(1/49) ~= 3.8% of its value per
//      level gained.
//
//   3. Armor and MagicArmor bypass their authored start/end entirely. The
//      same function hardcodes those two attribute indices and returns the
//      algebraic inverse of the mitigation formula instead (field#5):
//
//         resistFor(L, red) = red * (a + b*L) / (1 - red)
//
//      with [a,b] = ResistanceScalableReductionFormula = [385, 100], and
//      `red` the mean of the character's aptitudes' props.armorReduction.
//      So armor is authored as design intent ("this class takes 40% less"),
//      not as a number. Interpolating the authored Armor columns instead is
//      wrong at every level except 1 and 50.
//
//   4. Composition (ent.Unit.atb, findex 4796):
//
//         atb = (stored + scaling + flat) * (modAdd * modMul)
//
//      Nothing ever writes a computed value back into storage, which is why
//      the promoted per-attribute fields in memory read zero for gear-derived
//      stats: they are the stored layer, not the sheet.
// ---------------------------------------------------------------------------

export const STAT_GROUPS = ['primary', 'vitality', 'armor', 'ratings'];

// --- the universal curve ---------------------------------------------------

// HAttributes.field#6. Returns 0 for the degenerate row the game also guards
// against (min ~ 0 with max 0), so an unauthored budget contributes nothing
// rather than producing NaN.
export function budget(level, min, max, maxLevel) {
  if (min == null || max == null) return 0;
  if (Math.abs(min) < 1e-10 && max === 0) return 0;
  if (Math.abs(min) < 1e-10) return 0;
  const step = Math.pow(max / min, 1 / (maxLevel - 1));
  return min * Math.pow(step, level - 1);
}

// HAttributes.field#5 - the inverse of the mitigation curve, used as the
// Armor/MagicArmor budget.
export function resistForReduction(level, red, [a, b]) {
  if (!(red > 0) || red >= 1) return 0;
  return (red * (a + b * level)) / (1 - red);
}

// ent.GameObject.getAffinityDamageReduction (findex 4510,
// @src/ent/GameObject.hx:748-802). Note the level is the ATTACKER's, the flat
// affinity reductions are added to the resulting fraction rather than to the
// resist pool, and the result is floored at 0 but never capped at 1.
export function damageReduction({ resist, penetrationPct, attackerLevel, flatReduction = 0, formula }) {
  const [a, b] = formula;
  const pen = Math.min(100, Math.max(0, penetrationPct ?? 0));
  const r = (resist ?? 0) * (1 - pen / 100);
  let red = r / (r + a + b * attackerLevel);
  red += flatReduction;
  return Math.max(0, red);
}

// --- the attribute table ---------------------------------------------------

// One row per `attribute`, with its flags decoded and its scaling operators
// resolved through cdb.customTypes. Also a dependency order: an attribute is
// evaluated only after every attribute it scales from. The sheet order
// happens to already be valid, but relying on that is how a patch breaks you
// silently, so the order is computed.
export function buildAttributeTable(cdb) {
  const rows = cdb.lines('attribute');
  const flagNames = cdb.enumValues('attribute', 'flags');
  const byId = new Map();
  const attrs = rows.map((r, index) => {
    const flags = new Set(flagNames.filter((_, i) => ((r.flags ?? 0) >> i) & 1));
    const scaling = (r.scaling ?? []).map((s) => ({
      from: s.attribute,
      scale: s.scale ?? 0,
      op: cdb.custom('AttributeOperator', s.scalingOperator) ?? { case: 'Flat', args: {} },
    }));
    const a = {
      id: r.id,
      index,
      flags,
      isRating: flags.has('Rating'),
      isPercent: flags.has('Percent'),
      isResource: flags.has('Resource'),
      roundUp: flags.has('RoundUp'),
      negativeAllowed: flags.has('NegativeAllowed'),
      defVal: r.defVal ?? null,
      maxAtb: r.maxAtb ?? null,
      scaling,
    };
    byId.set(r.id, a);
    return a;
  });

  // Topological order over the scaling graph. A cycle would be a data bug;
  // report it by name rather than hanging or producing garbage.
  const order = [];
  const state = new Map(); // id -> 0 visiting, 1 done
  const visit = (a, stack) => {
    const st = state.get(a.id);
    if (st === 1) return;
    if (st === 0) throw new Error(`attribute scaling cycle: ${[...stack, a.id].join(' -> ')}`);
    state.set(a.id, 0);
    for (const s of a.scaling) {
      const dep = byId.get(s.from);
      if (dep) visit(dep, [...stack, a.id]);
    }
    state.set(a.id, 1);
    order.push(a);
  };
  for (const a of attrs) visit(a, []);

  return { attrs, byId, order };
}

// --- how a modifier composes with another of its kind ----------------------

/**
 * The `affix` sheet says how each modifier stacks, in a column nothing read.
 * `affix.stack` is an `AffixStacking` custom type:
 *
 *   TAttribute_Flat       (none)            additive
 *   TAttribute_ARatio     (none)            additive, into the modAdd sum
 *   TAttribute_MRatio     Multiplicative    the multiplier COMPOUNDS, and it
 *                                           REPLACES rather than adds: a
 *                                           DamageTakenModifier of 0.6 means
 *                                           "you take 60% of what you would",
 *                                           i.e. a 40% reduction
 *   TAttribute_MRatioMin  Min(base: 1)      the STRONGEST applies and they do
 *                                           NOT compound - two 30% slows are a
 *                                           30% slow, not 51%
 *
 * Two readings were wrong before this was read. `catalog.applyAffixes` composed
 * a multiplicative affix as `cur * (1 + v)` while `engine.applyAffix` composed
 * the same ref as `cur * v`, so the same row meant different things depending on
 * whether it arrived on an item or in a status; and `MRatioMin` was treated as
 * `MRatio` everywhere, which compounds eight slow rows that the sheet says take
 * the minimum. Neither is live today - no equippable or augment carries a
 * multiplicative affix and every MRatioMin row targets MoveSpeedFactor, which
 * nothing here scores - so this changes no number. It stops the day one is
 * authored from being a silent factor-of-two.
 */
export function buildAffixRules(cdb) {
  const stacking = new Map();
  for (const a of cdb.lines('affix')) {
    stacking.set(a.id, a.stack ? cdb.custom('AffixStacking', a.stack) : null);
  }

  // Which of the three modifier accumulators a row feeds. Only these four of
  // the twelve `affix` rows target an attribute at all; the rest are inventory
  // size, craft chances and internal markers.
  const KIND = {
    TAttribute_Flat: 'flat',
    TAttribute_ARatio: 'addRatio',
    TAttribute_MRatio: 'mulRatio',
    TAttribute_MRatioMin: 'mulRatio',
  };

  /** Fold one multiplicative value into whatever is already there. */
  function composeMul(ref, current, value) {
    const st = stacking.get(ref);
    if (st?.case === 'Min') return Math.min(current, value);
    if (st?.case === 'Max') return Math.max(current, value);
    return current * value;             // Multiplicative, and the default
  }

  /**
   * Scale a modifier by a slot factor (the arsenal's 0.4) or an uptime.
   * An additive value scales directly; a MULTIPLIER cannot - scaling 0.6 by 0.4
   * gives 0.24, which is a far bigger reduction than the affix grants. What a
   * fractional share of a multiplier means is a blend toward 1.
   */
  function scaleValue(ref, value, factor) {
    if (factor === 1) return value;
    return KIND[ref] === 'mulRatio' ? 1 + (value - 1) * factor : value * factor;
  }

  return { stacking, kindOf: (ref) => KIND[ref] ?? null, composeMul, scaleValue };
}

// --- constants -------------------------------------------------------------

export function loadConstants(cdb) {
  return {
    maxLevel: cdb.constant('MaxLevel'),
    earlyMaxLevel: cdb.constant('LevelScalingFormula_EarlyMaxLevel'),
    resistFormula: cdb.constantFloats('ResistanceScalableReductionFormula'),
    gearUpgradeILevelBonus: cdb.constant('Item_GearUpgradeILevelBonus'),
    flawlessILevelBonus: cdb.constant('Item_FlawlessILevelBonus'),
    skillRecoveryTime: cdb.constant('Skill_RecoveryTime'),
    attacksRecoveryRatio: cdb.constant('Attacks_RecoveryRatio'),
    comboWindow: cdb.constant('ComboWindow'),
    weaponSkillMaxRank: cdb.constant('WeaponSkill_MaxRank'),
    groupMaxPlayers: cdb.constant('Group_MaxPlayers'),
    weaponAttackRandomRange: cdb.constant('WeaponAttack_RandomRange'),
  };
}

// --- the sheet -------------------------------------------------------------

/**
 * Evaluate every attribute for one character.
 *
 * @param ctx      {attrTable, consts}
 * @param base     Map|object of attribute id -> stored value (unit stats)
 * @param mods     {flat, addRatio, mulRatio} - each attribute id -> number,
 *                 as produced by the gear layer
 * @param level    character level, used by every Rating denominator
 */
export function computeSheet(ctx, { base, mods, level, force = null }) {
  const { attrTable, consts } = ctx;
  const out = new Map();
  const flat = mods?.flat ?? new Map();
  const addRatio = mods?.addRatio ?? new Map();
  const mulRatio = mods?.mulRatio ?? new Map();

  for (const a of attrTable.order) {
    // stored: whatever the unit itself carries, else the sheet's default.
    let stored = base.get(a.id);
    if (stored == null) stored = a.defVal ?? 0;

    // scaling: from attributes already resolved this pass.
    let scaled = 0;
    for (const s of a.scaling) {
      const src = out.get(s.from) ?? 0;
      if (s.op.case === 'Rating') {
        const { min, max, target } = s.op.args;
        const denom = budget(level, min, max, consts.earlyMaxLevel);
        if (denom > 0) scaled += (src / denom) * target;
      } else {
        // Flat, and LinearRatio - which no row in this build uses. Treated
        // the same and surfaced by auditModel() rather than guessed silently.
        scaled += src * s.scale;
      }
    }

    const f = flat.get(a.id) ?? 0;
    const mAdd = 1 + (addRatio.get(a.id) ?? 0);
    const mMul = mulRatio.get(a.id) ?? 1;

    let v = (stored + scaled + f) * mAdd * mMul;
    // `RoundUp` is the flag's NAME, not its behaviour on this path. Checked
    // against a real level-25 Warrior with no equipment and no talents, where
    // the level curve is the only thing feeding these:
    //
    //   raw 33.974 -> game 34    ceil 34   round 34   floor 33
    //   raw 28.091 -> game 28    ceil 29   round 28   floor 28
    //   raw 38.211 -> game 38    ceil 39   round 38   floor 38
    //
    // Ceiling matches one of the three, flooring matches two, ROUNDING matches
    // all three - and it is the only rule that can. Ceiling put every primary
    // one point high on a naked character, which then fed CritChance through
    // its 0.014-per-Dexterity-and-Faith scaling and moved the derived stats too.
    if (a.roundUp) v = Math.round(v);
    if (!a.negativeAllowed && v < 0) v = 0;
    // A forced value REPLACES everything - the level curve, the gear, the
    // weapon. It is how a stat profile pins a stat to a stated number so two
    // weapons can be compared on their kits rather than on their stat sticks.
    //
    // It happens INSIDE the topological walk, not afterwards, so everything
    // downstream is computed from the forced number: pin Dexterity and the
    // CritChance that scales off it moves with it. Overriding the finished
    // sheet instead would leave every derived stat quietly disagreeing with
    // the stat it derives from.
    if (force?.has(a.id)) v = force.get(a.id);
    out.set(a.id, v);
  }
  return out;
}

// The naked character: BaseHero's flat values plus the class's own level
// curve, both out of the `unit` sheet. `levelScaling: [{val:20},{val:59}]` is
// the same geometric ramp as everything else, anchored on level 1 and
// EarlyMaxLevel.
export function baseStats(cdb, ctx, unitId, level) {
  const units = cdb.byId('unit');
  const chain = [];
  for (let cur = units.get(unitId); cur; ) {
    chain.push(cur);
    const parent = (cur.inherit ?? [])[0]?.ref;
    cur = parent ? units.get(parent) : null;
  }
  if (!chain.length) throw new Error(`no unit row "${unitId}"`);

  // Parents first, so a subclass row overrides the base.
  const base = new Map();
  for (const u of chain.reverse()) {
    for (const s of u.stats ?? []) {
      if (s.value != null) base.set(s.attribute, s.value);
      const ls = s.levelScaling ?? [];
      if (ls.length >= 2) {
        base.set(s.attribute, budget(level, ls[0].val, ls[1].val, ctx.consts.earlyMaxLevel));
      } else if (ls.length === 1) {
        base.set(s.attribute, ls[0].val);
      }
    }
  }
  return base;
}

// Things the model knows it is assuming. Printed with every result, because a
// coverage note the user can read beats a confident number they cannot check.
export function auditModel(cdb, ctx) {
  const notes = [];
  const ops = new Set();
  for (const a of ctx.attrTable.attrs) for (const s of a.scaling) ops.add(s.op.case);
  if (ops.has('LinearRatio')) {
    notes.push({
      severity: 'warn',
      what: 'AttributeOperator.LinearRatio appears in this build and is modelled as `src * scale`',
      why: 'No row used it when the model was written, so the reading is untested.',
    });
  }

  // The authored Armor budgets agree with props.armorReduction for three of
  // the four classes; the Fighter's authored numbers correspond to 0.35 while
  // its props say 0.40. The runtime uses props, so the model does too.
  for (const apt of cdb.lines('aptitude')) {
    const red = apt.props?.armorReduction;
    if (red == null) continue;
    const armor = (apt.atbScaling ?? []).find((e) => e.endAtb === 'Armor');
    if (!armor) continue;
    const implied = resistForReduction(1, red, ctx.consts.resistFormula);
    if (Math.abs(implied - armor.start) > 1.5) {
      notes.push({
        severity: 'info',
        what: `aptitude ${apt.id}: authored Armor start ${armor.start} implies armorReduction ` +
              `${(armor.start / (armor.start + ctx.consts.resistFormula[0] + ctx.consts.resistFormula[1])).toFixed(3)}, ` +
              `props.armorReduction says ${red}`,
        why: 'The runtime reads props.armorReduction, so that is what the model uses; ' +
             'the authored columns are dead for Armor/MagicArmor.',
      });
    }
  }
  return notes;
}

// One place to build the evaluation context.
export function buildContext(cdb) {
  const consts = loadConstants(cdb);
  for (const [k, v] of Object.entries(consts)) {
    if (v == null) throw new Error(`constant ${k} missing from data.cdb - the game changed shape`);
  }
  const attrTable = buildAttributeTable(cdb);
  const affix = buildAffixRules(cdb);
  return { cdb, consts, attrTable, affix };
}
