// ---------------------------------------------------------------------------
// damage.mjs - turning a stat sheet into throughput, and a target to aim at.
//
// Every point of damage, healing and shielding in the game is emitted by a
// `skill.steps[].effects[]` entry:
//
//   { effect: Damage|Heal|Shield|GainAtb|Status,
//     affinity, baseVal, scaling: [{ ratio, atb, conds }], dynVal, flags }
//
// so the coefficient table is shipped and needs no guessing:
//
//   amount = baseVal + SUM(ratio * attributeValue(atb))
//
// What is NOT shipped is the composition order that turns that into a number
// on screen - `ent.Unit.applyDamage` (findex 4835) and `computeDamage` (4841)
// are still undisassembled. Three consequences, all of them visible in the
// audit this module returns rather than hidden:
//
//   * Fervor's offensive half lands on no attribute. Its own description says
//     it "increases the damage, healing and shielding of your Skills", but
//     `DamageModifier.scaling` is empty and nothing in the sheet takes a
//     scaling entry from Fervor except DamageTakenModifier (-0.5),
//     HealGivenMultiplier (+1) and ShieldPowerMultiplier (+1). So the
//     offensive half is a code-only path, modelled here as a multiplier and
//     flagged UNVERIFIED.
//   * PhysicalMastery and MagicMastery are the same shape of hole. They are
//     also zero from every source this build ships, so the assumption is
//     currently inert.
//   * WeaponPower has no scaling entry and no atbScaling group, so it must be
//     set from the equipped weapon. The model derives it from the weapon's own
//     share of the primary budget, which is consistent with
//     `WeaponPowerRatio`'s description, and flags it UNVERIFIED.
//
// Because absolute numbers rest on those three, the CLI reports throughput as
// a relative score and refuses to call it DPS.
// ---------------------------------------------------------------------------

import { budget, resistForReduction, damageReduction } from './model.mjs';

// Which types swing rather than cast. Only used for the recovery window; the
// filler/active/triggered split itself lives in skills.mjs.
const FILLER_TYPES = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4', 'AttackCombo']);
const COMBO_TYPES = new Set(['AttackCombo']);

export function buildCombat(cdb, ctx) {
  const skills = cdb.byId('skill');
  const affinities = cdb.byId('affinity');
  const effectNames = cdb.enumValues('skill@steps@effects', 'effect');
  const skillTypeNames = cdb.enumValues('skill', 'type');
  const skillNatureNames = cdb.enumValues('skill', 'nature');

  // An affinity's mitigation contract, inherited from the nearest ancestor
  // that declares one. All 14 magic sub-schools are empty in this build, so in
  // practice there are exactly three paths: Raw, Physical, Magic.
  const affinityCache = new Map();
  function affinityOf(id) {
    if (!id) return { root: 'Raw', resist: null, pen: null, flat: [] };
    let hit = affinityCache.get(id);
    if (hit) return hit;
    let resist = null, pen = null, flat = [], root = id;
    for (let cur = affinities.get(id); cur; ) {
      root = cur.id;
      if (!resist && (cur.resistances ?? []).length) resist = cur.resistances[0].atb;
      if (!pen && (cur.resistPen ?? []).length) pen = cur.resistPen[0].atb;
      if (!flat.length && (cur.reductions ?? []).length) flat = cur.reductions.map((r) => r.atb);
      cur = cur.parent ? affinities.get(cur.parent) : null;
    }
    hit = { root, resist, pen, flat };
    affinityCache.set(id, hit);
    return hit;
  }

  // A number field that may instead hold a vars key (about 60 sites do).
  const num = (v, fallback = 0) => (typeof v === 'number' ? v : fallback);

  // How long the actor is committed to a cast. There is no player global
  // cooldown - `getSkillRecoveryTime` exists exactly once in the bytecode, as
  // ent.Foe.getSkillRecoveryTime - so occupancy is the step DAG's own span
  // plus a recovery window, and attacks recover four times faster.
  function occupancyOf(skill, typeName) {
    let end = 0;
    for (const st of skill.steps ?? []) {
      const t = num(st.delay) + num(st.duration);
      if (t > end) end = t;
    }
    end = Math.max(end, num(skill.duration), 0.1);
    const ratio = FILLER_TYPES.has(typeName) ? ctx.consts.attacksRecoveryRatio : 1;
    return end + ctx.consts.skillRecoveryTime * ratio;
  }

  // Flatten a skill into the shape the objective needs. Rank gates on effects
  // and steps are resolved against the weapon-skill rank the caller assumes.
  const profileCache = new Map();
  function profile(skillId, rank) {
    const key = skillId + '@' + rank;
    let p = profileCache.get(key);
    if (p) return p;
    const s = skills.get(skillId);
    if (!s) return null;

    const typeName = skillTypeNames[s.type ?? -1] ?? null;
    const natureName = skillNatureNames[s.nature ?? -1] ?? null;

    // `props.rankOverride` restates props at a given weapon-skill rank, and
    // cooldown is the one that matters: GA_Craft_Skill1 drops from 16s to 12s at
    // rank 2. Applying the highest matching override keeps `--rank` honest.
    let props = s.props ?? {};
    for (const ov of (s.props?.rankOverride ?? []).slice().sort((a, b) => (a.minRank ?? 0) - (b.minRank ?? 0))) {
      if ((ov.minRank ?? 0) <= rank) props = { ...props, ...(ov.props ?? {}) };
    }
    // `cond.castHoldStep` is a charge level, and the steps carrying it are
    // MUTUALLY EXCLUSIVE - Rampage declares Hit1/Hit2/Hit3 at 2.5x, 4x and 6x
    // Strength for how long you held it, and summing all three overstated the
    // skill by a factor of two. Full charge is assumed, which is the best case
    // and is stated in the audit.
    let maxHold = 0;
    for (const st of s.steps ?? []) {
      const h = st.cond?.castHoldStep;
      if (typeof h === 'number' && h > maxHold) maxHold = h;
    }

    const effects = [];
    for (const st of s.steps ?? []) {
      const c = st.cond ?? {};
      if (c.minRank != null && rank < c.minRank) continue;
      if (c.maxRank != null && rank > c.maxRank) continue;
      if (c.equalRank != null && rank !== c.equalRank) continue;
      if (typeof c.castHoldStep === 'number' && c.castHoldStep !== maxHold) continue;
      // Rune-gated. Which rune is slotted is a build axis this model does not
      // carry, so the step is left out rather than granted for free.
      if (c.mastery) continue;
      for (const e of st.effects ?? []) {
        const kind = effectNames[e.effect ?? -1] ?? null;
        if (!kind) continue;
        const scaling = [];
        for (const sc of e.scaling ?? []) {
          const cc = sc.conds ?? {};
          if (cc.minRank != null && rank < cc.minRank) continue;
          if (cc.maxRank != null && rank > cc.maxRank) continue;
          if (cc.equalRank != null && rank !== cc.equalRank) continue;
          if (sc.atb) scaling.push({ atb: sc.atb, ratio: num(sc.ratio) });
        }
        effects.push({
          kind,
          affinity: e.affinity ?? null,
          baseVal: num(e.baseVal),
          scaling,
          hasDynVal: (e.dynVal ?? 0) !== 0,
          scaleWithStacks: !!((e.flags ?? 0) & 1),
        });
      }
    }

    p = {
      id: skillId,
      name: s.texts?.name ?? skillId,
      type: typeName,
      nature: natureName,
      cooldown: num(props.cooldown, num(s.cooldown)),
      occupancy: occupancyOf(s, typeName),
      effects,
      affixes: s.affixes ?? [],
      // A skill with no cooldown but a resource cost is gated by income, not by
      // the clock. Warrior_Rage_Strike is the live case: no cooldown, 10 Rage a
      // cast, and Rage is generated inside a script this build does not run.
      // Treating it as castable every 1.4s tripled the Warrior's damage.
      costs: (props.costs ?? []).map((c) => ({ atb: c.atb, amount: c.amount })),
      hasScript: !!s.script,
      isFiller: FILLER_TYPES.has(typeName),
      isCombo: COMBO_TYPES.has(typeName),
    };
    profileCache.set(key, p);
    return p;
  }

  // --- reference targets ---------------------------------------------------
  // A target is fully described by the damage reduction it is meant to have at
  // the attacker's level: feeding resistForReduction back through the forward
  // formula returns exactly that fraction at zero penetration. The default
  // comes from the game's own `Armor_ExpectedReduction` constant, so it is the
  // designers' reference and not one this tool invented.
  const expected = cdb.constant('Armor_ExpectedReduction');
  const FOES = {
    dummy: { name: 'dummy (no mitigation)', physReduction: 0, magicReduction: 0 },
    reference: { name: `reference (Armor_ExpectedReduction ${expected})`, physReduction: expected, magicReduction: expected },
    armoured: { name: 'armoured (2x reference)', physReduction: Math.min(0.9, expected * 2), magicReduction: Math.min(0.9, expected * 2) },
  };

  function foe(name, level) {
    const f = FOES[name];
    if (!f) throw new Error(`unknown target "${name}". Known: ${Object.keys(FOES).join(', ')}`);
    return {
      ...f,
      level,
      armor: resistForReduction(level, f.physReduction, ctx.consts.resistFormula),
      magicArmor: resistForReduction(level, f.magicReduction, ctx.consts.resistFormula),
    };
  }

  // --- one cast ------------------------------------------------------------
  function amountOf(effect, sheet) {
    let a = effect.baseVal;
    for (const s of effect.scaling) a += s.ratio * (sheet.get(s.atb) ?? 0);
    return a;
  }

  function mitigate(effect, sheet, target) {
    const aff = affinityOf(effect.affinity);
    if (aff.root === 'Raw' || !aff.resist) return 1;
    const resist = aff.resist === 'MagicArmor' ? target.magicArmor : target.armor;
    const pen = aff.pen ? (sheet.get(aff.pen) ?? 0) : 0;
    const red = damageReduction({
      resist,
      penetrationPct: pen,
      attackerLevel: target.level,
      flatReduction: 0, // the target's own flat reductions; a reference foe has none
      formula: ctx.consts.resistFormula,
    });
    return Math.max(0, 1 - red);
  }

  /**
   * Expected output of one cast, split by effect kind.
   * `opts.assume` toggles the three unverified multipliers.
   */
  function castOutput(prof, sheet, target, opts) {
    const critChance = Math.min(1, Math.max(0, (sheet.get('CritChance') ?? 0) / 100));
    const critMult = 1 + critChance * ((sheet.get('CritDamage') ?? 100) / 100 - 1);
    const dmgMod = (sheet.get('DamageModifier') ?? 100) / 100;
    const healMod = (sheet.get('HealGivenMultiplier') ?? 100) / 100;
    const shieldMod = (sheet.get('ShieldPowerMultiplier') ?? 100) / 100;
    const fervor = (sheet.get('Fervor') ?? 0) / 100;
    const physMastery = (sheet.get('PhysicalMastery') ?? 0) / 100;
    const magicMastery = (sheet.get('MagicMastery') ?? 0) / 100;

    // Fervor's description says it increases the damage of your *Skills*, so by
    // default a base attack does not get it. That distinction decides whether a
    // Fervor faction or a penetration faction wins, and neither reading is
    // verified, so it is a switch rather than a decision baked in here.
    const isSkill = !prof.isFiller;
    const fervorHere = opts.assume.fervorScope === 'all'
      || (opts.assume.fervorScope === 'skills' && isSkill);

    let damage = 0, heal = 0, shield = 0;
    for (const e of prof.effects) {
      const raw = amountOf(e, sheet);
      if (!raw) continue;
      if (e.kind === 'Damage') {
        const aff = affinityOf(e.affinity);
        let m = dmgMod * critMult * mitigate(e, sheet, target);
        if (fervorHere) m *= 1 + fervor;
        if (opts.assume.mastery) {
          if (aff.root === 'Physical') m *= 1 + physMastery;
          else if (aff.root === 'Magic') m *= 1 + magicMastery;
        }
        damage += raw * m;
      } else if (e.kind === 'Heal') {
        // HealGivenMultiplier already carries Fervor - that one IS verified,
        // straight out of attribute.scaling - so it must not be applied twice.
        heal += raw * healMod;
      } else if (e.kind === 'Shield') {
        shield += raw * shieldMod;
      }
    }
    return { damage, heal, shield };
  }

  // --- throughput ----------------------------------------------------------
  /**
   * A filler-plus-cooldowns rotation. Cooldown skills are assumed to be used
   * on cooldown; whatever time is left goes to the base-attack chain. This is
   * a priority list with no conditions, which is exactly as much player model
   * as can be justified without a measured occupancy log.
   */
  function throughput(rotation, sheet, target, opts) {
    const cdr = 1 + (sheet.get('CooldownReduction') ?? 0) / 100;
    const lines = [];
    let dps = 0, hps = 0, sps = 0;
    let busy = 0;

    // --- pass 1: skills you press on cooldown -----------------------------
    // Collected first, because if the cooldowns oversubscribe the clock they all
    // have to be scaled down together - you cannot cast 130% of the time.
    const actives = [];
    for (const { prof: p, source } of rotation.active) {
      const out = castOutput(p, sheet, target, opts);
      if (!out.damage && !out.heal && !out.shield) continue;
      const effCd = Math.max(p.cooldown / cdr, p.occupancy);
      actives.push({ p, source, out, effCd, share: p.occupancy / effCd });
      busy += p.occupancy / effCd;
    }

    // Oversubscribed: hold the clock and give each skill a proportional share.
    // Reported, because it means the priority order matters and this model has
    // none - a real rotation would drop the worst skill, not slow all of them.
    const oversubscribed = busy > 1;
    const fit = oversubscribed ? 1 / busy : 1;
    for (const a of actives) {
      const interval = a.effCd / fit;
      dps += a.out.damage / interval;
      hps += a.out.heal / interval;
      sps += a.out.shield / interval;
      lines.push({
        id: a.p.id, name: a.p.name, kind: 'active', source: a.source,
        perCast: a.out, interval, share: a.share * fit,
      });
    }
    if (oversubscribed) busy = 1;

    // --- pass 2: the base-attack chain fills whatever is left --------------
    // The whole chain is one cycle: you cannot press swing 3 without 1 and 2.
    let chainDmg = 0, chainHeal = 0, chainShield = 0, chainTime = 0;
    let swings = 0, combos = 0;
    for (const { prof: p } of rotation.filler) {
      const out = castOutput(p, sheet, target, opts);
      chainDmg += out.damage;
      chainHeal += out.heal;
      chainShield += out.shield;
      chainTime += p.occupancy;
      if (p.isCombo) combos++; else swings++;
    }
    const idle = Math.max(0, 1 - busy);
    let attackRate = 0, comboRate = 0;
    if (chainTime > 0) {
      dps += (chainDmg / chainTime) * idle;
      hps += (chainHeal / chainTime) * idle;
      sps += (chainShield / chainTime) * idle;
      attackRate = (swings / chainTime) * idle;
      comboRate = (combos / chainTime) * idle;
      lines.push({
        id: '(base attack chain)', name: '(base attack chain)', kind: 'filler',
        perCast: { damage: chainDmg, heal: chainHeal, shield: chainShield },
        interval: chainTime, share: idle,
      });
    }

    // --- pass 3: things that fire at you ----------------------------------
    // These need the rates above, which is why they go last. A rule that
    // cannot be tied to one of them never reaches here - see skills.mjs.
    for (const t of rotation.triggered) {
      const out = castOutput(t.prof, sheet, target, opts);
      if (!out.damage && !out.heal && !out.shield) continue;
      let rate = 0;
      if (t.rule.kind === 'per-combo') rate = comboRate / t.rule.divisor;
      else if (t.rule.kind === 'per-attack') rate = attackRate * t.rule.chance;
      if (!(rate > 0)) continue;
      dps += out.damage * rate;
      hps += out.heal * rate;
      sps += out.shield * rate;
      lines.push({
        id: t.prof.id, name: t.prof.name, kind: 'triggered', source: t.source,
        perCast: out, interval: 1 / rate, share: 0, why: t.rule.why,
      });
    }

    return {
      dps, hps, sps, busy, idle, lines,
      attackRate, comboRate, oversubscribed,
      unmodelled: rotation.unmodelled,
    };
  }

  // --- survivability -------------------------------------------------------
  function survivability(sheet, target, mix = 0.5) {
    const hp = sheet.get('MaxHealth') ?? 0;
    const dtm = (sheet.get('DamageTakenModifier') ?? 100) / 100;
    const red = (resistAtb, penFrom, flatAtbs) => damageReduction({
      resist: sheet.get(resistAtb) ?? 0,
      penetrationPct: 0, // a reference foe brings no penetration
      attackerLevel: target.level,
      flatReduction: (flatAtbs ?? []).reduce((s, a) => s + (sheet.get(a) ?? 0) / 100, 0),
      formula: ctx.consts.resistFormula,
    });
    const phys = red('Armor', null, []);
    const magic = red('MagicArmor', null, ['MagicReduction']);
    const takenPhys = Math.max(1e-6, (1 - phys) * dtm);
    const takenMagic = Math.max(1e-6, (1 - magic) * dtm);
    return {
      maxHealth: hp,
      physReduction: phys,
      magicReduction: magic,
      ehpPhysical: hp / takenPhys,
      ehpMagical: hp / takenMagic,
      ehp: hp / (mix * takenPhys + (1 - mix) * takenMagic),
    };
  }

  // WeaponPower: not shipped as a scaling entry or a budget group, so it has
  // to come from the weapon. Modelled as the weapon slot's own share of the
  // class primary budget at the weapon's effective level.
  function weaponPowerFor(cat, loadout, cls) {
    const apt = cdb.byId('aptitude').get(cls.aptitude);
    const primary = (apt?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0);
    if (!primary) return 0;
    let total = 0;
    for (const slotId of ['Slot_Weapon1', 'Slot_Weapon2']) {
      const g = loadout.gear[slotId];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      if (!item) continue;
      const ratio = cat.inherited(item.type, (t) => t?.atbRatio)?.primary ?? 0;
      if (!ratio) continue;
      const effLevel = cat.effectiveLevel(item, {
        charLevel: loadout.level, stars: Math.min(g.stars ?? 0, cat.maxStars(item)), flawless: !!g.flawless,
      });
      const factor = cat.slotById.get(slotId)?.affixFactor ?? 1;
      total += budget(effLevel, primary.start, primary.end, ctx.consts.earlyMaxLevel) * ratio * factor;
    }
    return total;
  }

  const audit = [
    { severity: 'unverified', what: 'Fervor increases the damage of skills by its own percentage',
      why: 'Its description says "your Skills"; no attribute in the sheet carries the coefficient. ' +
           '--fervor-scope skills|all|none decides whether base attacks get it too, and the choice ' +
           'moves the answer between Fervor gear and penetration gear.' },
    { severity: 'unverified', what: 'PhysicalMastery / MagicMastery multiply matching-affinity damage',
      why: 'Both have empty scaling and are zero from every source in this build, so the assumption is currently inert.' },
    { severity: 'unverified', what: 'WeaponPower = the weapon slot\'s share of the class primary budget',
      why: 'WeaponPower has no scaling entry and no budget group. Every base attack scales off it, so absolute damage depends on this.' },
    { severity: 'assumption', what: 'charged skills are evaluated at full charge',
      why: 'Steps gated on cond.castHoldStep are mutually exclusive charge levels; the highest is used.' },
    { severity: 'unmodelled', what: 'runes (skill masteries) and talents',
      why: 'Steps gated on cond.mastery are excluded, and the 22-node talent trees are not modelled at all, ' +
           'so a build that leans on either is understated.' },
    { severity: 'unmodelled', what: 'skill scripts, statuses beyond self-buffs, and DoTs',
      why: '427 of 962 skills carry hscript bodies this build does not execute. Self-buffs named by an ' +
           'addStatus(owner, Skill.X) call are resolved; everything else in a script is not.' },
    { severity: 'unmodelled', what: 'per-swing damage variance',
      why: 'WeaponAttack_RandomRange = 0.1 exists but its only located read is a UI text path, so casts are treated as deterministic.' },
  ];

  return { profile, foe, foes: Object.keys(FOES), castOutput, throughput, survivability, affinityOf, weaponPowerFor, audit };
}
