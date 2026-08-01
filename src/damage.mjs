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
//   * PhysicalMastery and MagicMastery are the same shape of hole - and they
//     are LIVE, not inert: `GA_Craft_FinalCombo_Status` (Brutal Frenzy, on the
//     Warrior's own top pick) stacks +4 PhysicalMastery to 12, so the assumed
//     multiplier moves that build ~3.6% and can flip the weapon choice.
//     `--no-mastery` is the toggle that shows the exposure.
//   * WeaponPower has no scaling entry and no atbScaling group, so it must be
//     set from the equipped weapon. The model derives it from the weapon's own
//     share of the primary budget, which is consistent with
//     `WeaponPowerRatio`'s description, and flags it UNVERIFIED.
//
// Because absolute numbers rest on those three, the CLI reports throughput as
// a relative score and refuses to call it DPS.
// ---------------------------------------------------------------------------

import { budget, resistForReduction, damageReduction } from './model.mjs';
import { simulate } from './sim.mjs';

// Which types swing rather than cast. Only used for the recovery window; the
// filler/active/triggered split itself lives in skills.mjs.
const FILLER_TYPES = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4', 'AttackCombo']);
const COMBO_TYPES = new Set(['AttackCombo']);

export function buildCombat(cdb, ctx, assume = {}) {
  // The floor on how fast a chain link swings. Two stopwatch measurements
  // (Cheese Moon, 10 chains in 28s; Judgement, 10 in ~30s) both land on ~0.70s
  // a swing: Judgement's authored durations already sit at 0.70-0.85 and match
  // the watch exactly, while the fast axe's authored 0.25-0.55 are HIT timings
  // that under-run it by a second a cycle. No constant in the sheet carries
  // the 0.7 - `Attacks_RecoveryRatio` (0.25) reproduces neither watch - so it
  // is calibrated, named in the audit, and movable with --swing-floor.
  const swingFloor = Number.isFinite(assume.swingFloor) ? assume.swingFloor : 0.7;
  const skills = cdb.byId('skill');
  const affinities = cdb.byId('affinity');
  const effectNames = cdb.enumValues('skill@steps@effects', 'effect');
  const skillTypeNames = cdb.enumValues('skill', 'type');
  const skillNatureNames = cdb.enumValues('skill', 'nature');
  const stepTypeNames = cdb.enumValues('skill@steps', 'type');
  const stepOnNames = cdb.enumValues('skill@steps', 'on');
  const PROJECTILE_HIT = stepOnNames.indexOf('ProjectileHit');
  // Which step types hit everything in a shape rather than one target. `Mono`
  // steps carry a `props.area` too and it is NOT settled whether they cleave -
  // structurally identical rows have descriptions saying "nearby enemies" and
  // "an enemy" - so Mono is treated as single-target and the ambiguity is in
  // the audit rather than silently resolved in the favourable direction.
  const AREA_STEP_TYPES = new Set(['Area', 'Aura']);

  // `skill@props@enableCond.flags` - when the skill may be used at all.
  const enableCondNames = cdb.enumValues('skill@props@enableCond', 'flags');
  const enableFlags = (bits) => (bits == null ? null
    : enableCondNames.filter((_, i) => (bits >> i) & 1));

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

  // A number field that may instead hold a vars key. About 60 sites do, and
  // silently reading those as 0 was costing real damage: `Priest_RadiantVerdict`
  // step 3 runs for `dur2` = 8 seconds at one tick every 2, and a zero duration
  // made that one tick instead of four. The columns typed `skillVal` (a step's
  // range and duration, a loop's tick) hold either a number or a key into the
  // skill's own `vars`, so resolve it there before giving up.
  const num = (v, fallback = 0) => (typeof v === 'number' ? v : fallback);
  function skillVal(v, skill, fallback = 0) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const hit = skill?.vars?.[v];
      if (typeof hit === 'number') return hit;
    }
    return fallback;
  }

  /**
   * How much a slotted rune takes off a cast's cost, out of the skill's own
   * `evalCost` hook. Only the shape the scripts actually use is read: a
   * `val -= vars.X` sitting under a `hasMastery` for a rune you have, and under
   * an attribute check naming the pool being paid. Anything else - a cost that
   * depends on live state, a flat `return 0` behind a status - is left alone,
   * because a cost this misreads shows up as a skill cast far too often.
   */
  const reliefCache = new Map();
  function costRelief(s, atb, runes) {
    if (!runes?.size || !s?.script) return 0;
    const key = s.id + '@' + atb + '@' + [...runes].sort().join('+');
    let hit = reliefCache.get(key);
    if (hit != null) return hit;
    hit = 0;
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const fn = /function\s+evalCost\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(body)?.[1];
    if (fn) {
      for (const m of fn.matchAll(/\w+\s*-=\s*vars\.([A-Za-z0-9_]+)/g)) {
        const before = fn.slice(0, m.index);
        const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(before)?.[1];
        if (!rune || !runes.has(rune)) continue;
        // The branch must be about THIS pool, or about no pool in particular.
        const named = /atb\s*==\s*(?:Attribute\.)?([A-Za-z0-9_]+)/.exec(before)?.[1];
        if (named && named !== atb) continue;
        // The number is usually on the RUNE, not on the skill: Raging Smash's
        // own vars are damage/threshold/dur1, and the `var1` its evalCost
        // subtracts belongs to Scent of Battle. Same as Juggernaut's Rage.
        const runeVars = (s.mastery ?? []).find((x) => x.id === rune)?.vars ?? null;
        const v = s.vars?.[m[1]] ?? runeVars?.[m[1]];
        if (typeof v === 'number' && v > 0) hit += v;
      }
    }
    reliefCache.set(key, hit);
    return hit;
  }

  /**
   * A damage multiplier a slotted RUNE adds to its own skill, out of that
   * skill's script. `Concentrated Impact` is the shape:
   *
   *   function onDamageEval(hit) {
   *     if (hasMastery(Mastery.Warrior_SurgingForce_M3) && hit.ctx.totalHits == 1)
   *       hit.dmgMult += vars.damage;          // 0.4
   *   }
   *
   * `totalHits == 1` is not an unreadable condition - it is a statement about
   * how many enemies you hit, which is exactly what `--targets` says. At one
   * target it holds; above one it does not, and the bonus is dropped rather
   * than averaged.
   */
  const runeDmgCache = new Map();
  function runeDamage(s, runes) {
    if (!runes?.size || !s?.script) return [];
    const key = s.id + '@' + [...runes].sort().join('+');
    let hit = runeDmgCache.get(key);
    if (hit) return hit;
    hit = [];
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const m of body.matchAll(/\w+\.dmgMult\s*\+=\s*vars\.([A-Za-z0-9_]+)/g)) {
      const before = body.slice(0, m.index);
      const line = before.slice(before.lastIndexOf('function'));
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (!rune || !runes.has(rune)) continue;
      const runeVars = (s.mastery ?? []).find((x) => x.id === rune)?.vars ?? null;
      const amount = s.vars?.[m[1]] ?? runeVars?.[m[1]];
      if (typeof amount !== 'number' || amount <= 0) continue;
      // Everything the guard says beyond the rune and the target count is a
      // condition this cannot answer, and it must refuse rather than approximate.
      const singleTarget = /totalHits\s*==\s*1/.test(line);
      const rest = line
        .replace(/function\s+on\w+\s*\([^)]*\)/g, ' ')
        .replace(/hasMastery\s*\([^)]*\)/g, ' ')
        .replace(/\w+\.ctx\.totalHits\s*==\s*1/g, ' ')
        .replace(/\w+\.dmgMult\s*\+=\s*vars\.\w+\s*;?/g, ' ')
        .replace(/\b(?:if|hit|dmg|ctx|var)\b/g, ' ')
        .replace(/[\s{}()&|!,;.=+]/g, '');
      if (rest.length) continue;
      hit.push({ amount, singleTarget, rune });
    }
    runeDmgCache.set(key, hit);
    return hit;
  }

  /**
   * The amount a script INJECTS into an effect that declares `dynVal`.
   *
   * A `dynVal` effect carries no baseVal and no scaling - the number arrives at
   * runtime - so it reads as zero, which is right for most of them and wrong
   * for the ones whose number is sitting in `vars` two lines up:
   *
   *   // Warrior_IgnorePain, "Last Stand"        vars.var2 = 0.35
   *   if (hasMastery(Mastery.Warrior_IgnorePain_M2)) {
   *     setDynVal(1, owner.maxHealth * vars.var2);
   *     playStep(Steps.SelfHeal, owner);
   *   }
   *
   * `Steps.SelfHeal` is a step of this skill with `id: "SelfHeal"` and a Heal
   * effect whose `dynVal` is 1, so the pair names both the slot and the amount.
   *
   * Fourteen sites in the sheet do this and only three are numbers. The rest
   * are a share of a hit (`dmg.amount * vars.x`, which `HEAL_SHARE` reads where
   * it can), a share of CURRENT health, or a script local accumulated over the
   * cast - none of which is a number this has. Those keep their zero, and the
   * effect stays flagged `hasDynVal` so the coverage report can name it.
   */
  const dynFillCache = new Map();
  function scriptDynVals(s, runes) {
    if (!s?.script) return null;
    const key = s.id + '@' + (runes?.size ? [...runes].sort().join('+') : '');
    let hit = dynFillCache.get(key);
    if (hit !== undefined) return hit;
    hit = null;
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const RE = /setDynVal\s*\(\s*(\d+)\s*,\s*([^;]+?)\)\s*;\s*playStep\s*\(\s*Steps\.([A-Za-z0-9_]+)/g;
    for (const m of body.matchAll(RE)) {
      const before = body.slice(0, m.index);
      const line = before.slice(before.lastIndexOf('function'));
      // A rune-gated injection only lands when that rune is slotted. An
      // unguarded one always lands.
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (rune && !runes?.has(rune)) continue;
      // Everything else in the guard has to be something that is not a
      // condition. `hit.stepId == Steps.Area` is a dispatch on which step of
      // this cast fired, and the step always fires; anything else - a status,
      // a health ratio - is live state and the injection is refused.
      const rest = line
        .replace(/function\s+on\w+\s*\([^)]*\)/g, ' ')
        .replace(/hasMastery\s*\([^)]*\)/g, ' ')
        .replace(/\w+(?:\.\w+)*\.(?:stepId|kind)\s*==\s*Steps\.\w+/g, ' ')
        .replace(/setDynVal\s*\([^;]*\)\s*;?/g, ' ')
        .replace(/playStep\s*\([^;]*\)\s*;?/g, ' ')
        .replace(/\b(?:if|hit|dmg|ctx|var|owner|s)\b/g, ' ')
        .replace(/[\s{}()&|!,;.=+]/g, '');
      if (rest.length) continue;
      const expr = m[2].replace(/\s+/g, ' ').trim();
      const varOf = (t) => {
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        const v = /^vars\.([A-Za-z0-9_]+)$/.exec(t);
        if (!v) return null;
        const n = s.vars?.[v[1]] ?? (s.mastery ?? []).find((x) => x.id === rune)?.vars?.[v[1]];
        return typeof n === 'number' ? n : null;
      };
      let fill = null;
      const flat = varOf(expr);
      if (flat != null) fill = { baseVal: flat };
      else {
        // `owner.maxHealth * vars.x` - a share of a stat the sheet carries, so
        // it becomes ordinary scaling. `owner.health` is NOT that: it is what
        // is left right now, which no sheet knows.
        const mh = /^(?:owner\.maxHealth\s*\*\s*(vars\.\w+)|(vars\.\w+)\s*\*\s*owner\.maxHealth)$/.exec(expr);
        const r = mh ? varOf(mh[1] ?? mh[2]) : null;
        if (r != null) fill = { scaling: [{ atb: 'MaxHealth', ratio: r }] };
      }
      if (!fill) continue;
      (hit ??= new Map()).set(m[3] + '#' + m[1], fill);
    }
    dynFillCache.set(key, hit);
    return hit;
  }

  // Loop flags, from `skill@steps@props@loop.flags`.
  const LOOP_SPREAD = 1;      // the declared amount is the TOTAL, divided over the ticks
  const LOOP_DIRECT_START = 2; // the first tick lands at t=0 rather than after one interval

  // How many times one step's effects land on a single target, per cast.
  //
  //   * `props.loop` replays the step every `tick` seconds for the step's
  //     duration - `GS_Nova_Skill1` spins for 3s at 0.25 and lands 12 hits, and
  //     the model was counting one.
  //   * `props.area.targetCooldown` caps how often the SAME target may be
  //     re-hit, which is what turns most looping areas back into single sweeps.
  //   * `props.projectile.generation.count` fires the step's effect once per
  //     projectile - `Staff_Censer_Combo` is four bolts and its own description
  //     says "Casts four light bolts, each dealing ...".
  //
  // With `SpreadEffects` (or a `SelfEffect` step, whose own documentation says
  // it spreads automatically) the declared amount is the TOTAL rather than the
  // per-tick amount, so the ticks must not multiply it.
  function hitsOf(skill, step, stepTypeName, ownDuration, stepLives) {
    const loop = step.props?.loop;
    let ticks = 1;
    let spread = false;
    if (loop && (loop.tick != null)) {
      spread = !!((loop.flags ?? 0) & LOOP_SPREAD) || stepTypeName === 'SelfEffect';
      const tick = skillVal(loop.tick, skill, 0.5); // the column's own default
      let span = skillVal(step.duration, skill, 0);
      // -1 means "until the owner ends", which for a status is its lifetime.
      if (span < 0 || span === 0) span = ownDuration;
      if (tick > 0 && span > 0) {
        const first = ((loop.flags ?? 0) & LOOP_DIRECT_START) ? 0 : tick;
        // The epsilon is not cosmetic: `span / tick` is a float division and a
        // duration of 9 at a tick of 3 can land at 2.9999999999999996, which
        // floors to 2 and silently drops a third of the DoT.
        ticks = Math.floor((span - first) / tick + 1e-9) + 1;
        if (step.props?.area?.skipFirstTick) ticks -= 1;
        const tc = step.props?.area?.targetCooldown;
        if (tc > 0) ticks = Math.min(ticks, 1 + Math.floor((span - first) / tc + 1e-9));
        ticks = Math.max(0, ticks);
      }
    }
    // A projectile-hit step lands once per projectile the skill generated - and
    // only per projectile the skill generated AT THIS RANK. `Scepter_Start_Combo`
    // declares two Projectile steps that are rank alternatives (maxRank 2 vs
    // minRank 3), so summing them blindly would fire a combo that shoots one
    // bolt as if it shot two.
    let projectiles = 1;
    if (step.on === PROJECTILE_HIT) {
      let n = 0;
      for (const other of skill.steps ?? []) {
        if (stepLives && !stepLives(other)) continue;
        const g = other.props?.projectile?.generation;
        if (g?.count > 0) n += g.count;
      }
      if (n > 0) projectiles = n;
    }
    return { ticks, spread, projectiles, mult: (spread ? 1 : ticks) * projectiles };
  }

  // How long the actor is committed to a cast.
  //
  // Two things were wrong here and between them they cost half the model's
  // throughput:
  //
  //   * `Skill_RecoveryTime` was added to every cast. It is a FOE-AI constant -
  //     it sits in the constant sheet between `Skill_Pick_RetryCooldown` and
  //     `Skill_RecoveryTime_Boss`, inside the SpawnTime/Aggro/Panic/PathSearch
  //     block, and its only bytecode symbol is `ent.Foe.getSkillRecoveryTime`.
  //     Charging it to the player billed a level-25 Priest 0.59 attacks per
  //     second for a chain whose own authored durations run at 2.2.
  //   * The span was `max(delay + duration)` over ALL steps, which bills you for
  //     areas that outlive the cast. `Staff_Censer_Skill2` has an authored cast
  //     of 0.35s and leaves a 3-second area behind; the model charged 4.20s and
  //     let one 20-second cooldown eat 22% of the clock.
  //
  // So the commitment is the skill's own authored `duration`, falling back to
  // the span of the steps that are part of the cast itself - a persistent Area
  // or Aura step is something you leave behind, not something you stand in.
  // `skill.duration` alone is not enough either: 40 of the 340 castable
  // damage-bearing skills declare none at all (GS_Nova_Skill1 among them) and
  // would collapse to the floor, while on 96 of them the cast steps already run
  // longer than the authored duration. So it is the larger of the two, over the
  // steps that are part of the cast.
  // A Visuals step is left behind exactly the way a persistent area is - an FX
  // that outlives the cast is not a commitment.
  const LINGERING_STEPS = new Set(['Area', 'Aura', 'Summon', 'SkillObject', 'Status', 'Visuals']);
  function occupancyOf(skill, typeName) {
    let end = 0, lingering = 0;
    for (const st of skill.steps ?? []) {
      const t = skillVal(st.delay, skill, 0) + Math.max(0, skillVal(st.duration, skill, 0));
      if (LINGERING_STEPS.has(stepTypeNames[st.type ?? -1] ?? '')) {
        if (t > lingering) lingering = t;
        continue;
      }
      if (t > end) end = t;
    }
    // When a skill has NOTHING but lingering steps and declares no duration,
    // the area IS the cast - dropping to the 0.1s floor would make it free.
    if (end <= 0 && !(skillVal(skill.duration, skill, 0) > 0)) end = lingering;
    const span = Math.max(skillVal(skill.duration, skill, 0), end, 0.1);
    // A chain link cannot swing faster than the measured swing period - see
    // `swingFloor` above. Only the base-attack chain: a weapon skill's cast
    // time is its own business.
    return FILLER_TYPES.has(typeName) ? Math.max(span, swingFloor) : span;
  }

  // Flatten a skill into the shape the objective needs. Rank gates on effects
  // and steps are resolved against the weapon-skill rank the caller assumes.
  const profileCache = new Map();
  // `runes` is the set of slotted mastery ids. A rune does two readable things:
  // it enables the steps whose `cond.mastery` names it, and it overrides props
  // (only `charges` and `cooldown` appear). Everything else a rune's text
  // promises lives in game code.
  function profile(skillId, rank, runes = null) {
    const key = skillId + '@' + rank + (runes && runes.size ? '@' + [...runes].sort().join('+') : '');
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
    // A slotted rune's props win over the skill's own.
    const slotted = [];
    for (const m of s.mastery ?? []) {
      if (!runes?.has(m.id)) continue;
      slotted.push(m.id);
      props = { ...props, ...(m.props ?? {}) };
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

    // A status skill's own `duration` is its LIFETIME, which is the window its
    // looping steps tick over. For everything else it is the cast length.
    const ownDuration = skillVal(s.duration, s, 0);

    // One gate, used both to pick which steps run and to count how many
    // projectiles a projectile-hit step is answering for.
    const stepLives = (st) => {
      const c = st.cond ?? {};
      if (c.minRank != null && rank < c.minRank) return false;
      if (c.maxRank != null && rank > c.maxRank) return false;
      if (c.equalRank != null && rank !== c.equalRank) return false;
      if (typeof c.castHoldStep === 'number' && c.castHoldStep !== maxHold) return false;
      // Rune-gated: the step exists only while that rune is slotted.
      if (c.mastery && !runes?.has(c.mastery)) return false;
      if (c.masteryExclude && runes?.has(c.masteryExclude)) return false;
      return true;
    };

    const effects = [];
    const statusRefs = [];
    // Amounts a script hands to a `dynVal` effect, keyed by the step it plays.
    const dynFills = scriptDynVals(s, runes);
    for (const st of s.steps ?? []) {
      if (!stepLives(st)) continue;

      const stepType = stepTypeNames[st.type ?? -1] ?? null;
      const hits = hitsOf(s, st, stepType, ownDuration, stepLives);
      const area = st.props?.area;
      const isArea = AREA_STEP_TYPES.has(stepType);
      const shape = area?.shape ? cdb.custom('AreaShape', area.shape) : null;

      if (st.props?.status?.ref) statusRefs.push({ ref: st.props.status.ref, on: stepOnNames[st.on ?? -1] ?? null, target: st.props.status.target ?? null });

      for (const e of st.effects ?? []) {
        const kind = effectNames[e.effect ?? -1] ?? null;
        if (!kind) continue;
        if (e.status) statusRefs.push({ ref: e.status, on: stepOnNames[st.on ?? -1] ?? null, target: 1 });
        const scaling = [];
        for (const sc of e.scaling ?? []) {
          const cc = sc.conds ?? {};
          if (cc.minRank != null && rank < cc.minRank) continue;
          if (cc.maxRank != null && rank > cc.maxRank) continue;
          if (cc.equalRank != null && rank !== cc.equalRank) continue;
          if (sc.atb) scaling.push({ atb: sc.atb, ratio: num(sc.ratio) });
        }
        // A script may have filled this effect's `dynVal` with a number the
        // data does carry - the rune that grants it, and the `vars` key beside
        // the call. `Last Stand` heals `0.35 x MaxHealth` and read zero.
        const fill = (e.dynVal ?? 0) !== 0 && st.id ? dynFills?.get(st.id + '#' + e.dynVal) : null;
        if (fill?.scaling) for (const sc of fill.scaling) scaling.push(sc);
        effects.push({
          kind,
          // WHICH attribute a GainAtb feeds. This was dropped, so the eight
          // GainAtb rows in the database read as effects with no subject and
          // the resource layer had nothing to build on: `Warrior_InfiniteRage`
          // is a SelfEffect step looping every `dur1` = 3s for a GainAtb of 1
          // Rage, which is a fully authored income rate that nothing collected.
          atb: e.target?.atb ?? null,
          affinity: e.affinity ?? null,
          baseVal: num(e.baseVal) + (fill?.baseVal ?? 0),
          scaling,
          // How many times this lands on ONE target per cast: loop ticks times
          // projectiles, unless the loop declares its amount as a total.
          hits: hits.mult,
          ticks: hits.ticks,
          spread: hits.spread,
          projectiles: hits.projectiles,
          // Whether extra targets standing in the shape also take it.
          area: isArea ? {
            shape: shape?.case ?? 'Circle',
            range: skillVal(st.range, s, 0),
            targetRange: area?.rangeScale?.targetRange ?? null,
            maxTargets: st.props?.hitCount ?? null,
            // A splash that explicitly skips the enemy you hit. At one target
            // it lands on nobody, and crediting it a full hit was worth a fifth
            // of `Mace_Benediction_Combo`'s damage against a lone boss.
            ignoreMainTarget: !!area?.ignoreMainTarget,
          } : null,
          // `dynVal` means the magnitude is injected by a script at runtime -
          // `Priest_Talent_BurningRays_Status` has no baseVal and no scaling at
          // all, only dynVal. Reading baseVal+scaling scores those zero, which
          // is right, but they must be NAMED rather than silently dropped.
          // Unless the injection itself was readable, in which case it is no
          // longer a gap and no longer belongs in the coverage report.
          hasDynVal: (e.dynVal ?? 0) !== 0 && !fill,
          scaleWithStacks: !!((e.flags ?? 0) & 1),
        });
      }
    }

    // The tick schedule of a status skill, which is what makes it a DoT rather
    // than a lump. `ticks` and `spread` are already resolved per effect, so
    // this only has to carry the lifetime the uptime arithmetic needs.
    // A looping step makes this a DoT whatever the lifetime turns out to be:
    // 36 statuses get their duration from the step that APPLIES them rather
    // than declaring one, so gating on `ownDuration` here made the fallback in
    // skills.mjs unreachable and dropped those statuses entirely.
    const looping = (s.steps ?? []).find((st) => st.props?.loop?.tick != null);
    const periodic = looping
      ? {
        tick: skillVal(looping.props.loop.tick, s, 0.5),
        duration: ownDuration > 0 ? ownDuration : Infinity,
      }
      : null;

    // A skill's own affixes are rank-gated exactly the way its steps are, and
    // they are rune-gated too. `Staff_Upgrade` is five mutually exclusive
    // CooldownReduction rows (2/3/4/5/6, one per upgrade star) and summing them
    // reads 20, a number no character can have - the same error the talent rank
    // rows already had. Five runes across the sheet are readable ONLY through
    // `affixes[].conds.mastery`, so that condition is honoured here as well.
    const inRank = (c) => !(c?.minRank != null && rank < c.minRank)
      && !(c?.maxRank != null && rank > c.maxRank)
      && !(c?.equalRank != null && rank !== c.equalRank);
    const affixes = (s.affixes ?? []).filter((a) => {
      if (!inRank(a.conds)) return false;
      if (a.conds?.mastery && !runes?.has(a.conds.mastery)) return false;
      if (a.conds?.masteryExclude && runes?.has(a.conds.masteryExclude)) return false;
      return true;
    });

    p = {
      id: skillId,
      name: s.texts?.name ?? skillId,
      type: typeName,
      nature: natureName,
      cooldown: num(props.cooldown, num(s.cooldown)),
      occupancy: occupancyOf(s, typeName),
      effects,
      affixes,
      // A skill with no cooldown but a resource cost is gated by income, not by
      // the clock. Warrior_Rage_Strike is the live case: no cooldown, 10 Rage a
      // cast, and Rage is generated inside a script this build does not run.
      // Treating it as castable every 1.4s tripled the Warrior's damage.
      // What a cast costs, AFTER the rune you slotted has had its say.
      //
      // `evalCost` is the game's own hook for this and it is one line:
      //
      //   function evalCost(val, atb) {
      //     if (hasMastery(Mastery.Warrior_RageStrike_M2))
      //       if (atb == Attribute.Rage) val -= vars.var1;      // "Scent of
      //     ...                                                 //  Battle"
      //
      // So `Raging Smash` costs 10 Rage, or 9 with that rune - which is a tenth
      // more casts of it over a fight, and the difference between two runes the
      // search could not previously tell apart.
      costs: (props.costs ?? []).map((c) => ({
        atb: c.atb,
        amount: Math.max(0, c.amount - costRelief(s, c.atb, runes)),
      })),
      hasScript: !!s.script,
      runeDamage: runeDamage(s, runes),
      // `props.enableCond` says when a skill may be used at all -
      // InCombat | InCombatOrTargetting | OutOfCombat - and nothing read it.
      // Nine rows carry it and only one matters for a fight: an OutOfCombat
      // skill can never be pressed during one, so it is not "unmodelled", it is
      // unavailable. `Mount` is the live case and it also happens to be inert,
      // which is exactly why this went unnoticed.
      enableCond: enableFlags(props.enableCond?.flags),
      isFiller: FILLER_TYPES.has(typeName),
      isCombo: COMBO_TYPES.has(typeName),
      runes: slotted,
      // A charge is a BANKED CAST, not a faster cooldown. The bytecode's event
      // for a finished cooldown is `onSkillGainCharge` (singular) and the one
      // rune that hooks it glosses it as "each time one of your WeaponSkills
      // recovers its cooldown", so one cooldown completion returns one charge
      // and the sustained rate stays 1/cooldown. What charges buy is
      // (charges - 1) extra casts at the start of a fight - which is throughput
      // only once a model has a fight length, and is why this was inert for as
      // long as the model was a steady state. The simulation spends them.
      charges: Math.max(1, props.charges ?? 1),
      // The status lifetime, for a status; the cast length otherwise.
      duration: ownDuration,
      periodic,
      statusRefs,
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
  // Foes express armour the same way classes do: as a target damage REDUCTION,
  // in `unit.stats[].specScaling.armorReduction` / `.magicReduction`. Feeding
  // that through resistForReduction and back returns exactly the fraction at
  // zero penetration, so a target is fully described by two numbers - and those
  // numbers are in the data, not invented here.
  //
  // 27 units declare one. They form an archetype ladder that most of the world
  // inherits from:
  //
  //   W_Assassin 0.20  <  W_Base_Small / D_Base_Small 0.25  <  W_Base 0.30
  //     <  W_Base_Big / W_Base_Unique / D_Base_Big 0.35  <  W_Base_Elite 0.40
  //     =  every named boss (Crabgantua, Mokshi, Ratsar, Phrixes, Cleodora,
  //        MunsterChuck, Ulserous, DemonSuperElite)
  //
  // Two things worth knowing, both straight out of that table:
  //
  //   * Physical and magical reduction are EQUAL on every real foe. Only the
  //     dev punching bags split them (PunchingBagArmor is 0.5/0, PunchingBagMagicRes
  //     is 0/0.5). So ArmorPenetration and SpellPenetration are worth the same
  //     against everything currently in the game; which one you want is decided
  //     by your class and your gear's faction, not by what you are fighting.
  //   * `Armor_ExpectedReduction` (0.25) is well below what you actually fight.
  //     At level 25, 50% penetration is worth +14% damage against 0.25 and +25%
  //     against a 0.40 boss, so a reference target understates penetration by
  //     nearly half against the content that matters.
  const units = cdb.byId('unit');
  function unitChain(id) {
    const o = [];
    for (let c = units.get(id); c;) { o.push(c); const p = (c.inherit ?? [])[0]?.ref; c = p ? units.get(p) : null; }
    return o;
  }

  // The nearest declaration up the inheritance chain, which is how a mob that
  // declares nothing still has armour.
  function armourIntent(unitId) {
    let phys = null, mag = null;
    for (const c of unitChain(unitId)) {
      for (const s of c.stats ?? []) {
        if (s.attribute === 'Armor' && phys == null && s.specScaling?.armorReduction != null) phys = s.specScaling.armorReduction;
        if (s.attribute === 'MagicArmor' && mag == null && s.specScaling?.magicReduction != null) mag = s.specScaling.magicReduction;
      }
    }
    return { phys, mag };
  }

  // Every unit whose intent is declared or inherited, so `--target <unitId>`
  // works for anything in the world.
  const targetsByUnit = new Map();
  for (const u of cdb.lines('unit')) {
    const i = armourIntent(u.id);
    if (i.phys == null && i.mag == null) continue;
    targetsByUnit.set(u.id, i);
  }

  const expected = cdb.constant('Armor_ExpectedReduction');
  // Named shortcuts, each pointing at a real archetype unit rather than a made-up
  // number. `reference` stays because it is the designers' own constant, but it
  // is now clearly the odd one out.
  const NAMED = {
    dummy: { unit: 'Dummy', label: 'training dummy, no mitigation' },
    reference: { phys: expected, mag: expected, label: `Armor_ExpectedReduction ${expected}` },
    trash: { unit: 'W_Base', label: 'world trash' },
    small: { unit: 'W_Base_Small', label: 'small world mob' },
    big: { unit: 'W_Base_Big', label: 'big world mob' },
    elite: { unit: 'W_Base_Elite', label: 'world elite' },
    boss: { unit: 'Ratsar', label: 'named boss' },
    dungeon: { unit: 'D_Base_Big', label: 'dungeon mob' },
  };

  function foe(name, level) {
    let phys, mag, label;
    const named = NAMED[name];
    if (named?.unit) {
      const i = armourIntent(named.unit);
      phys = i.phys ?? 0; mag = i.mag ?? 0;
      label = `${named.label} (${named.unit}: ${phys}/${mag})`;
    } else if (named) {
      phys = named.phys; mag = named.mag;
      label = `${name} (${named.label})`;
    } else if (targetsByUnit.has(name)) {
      const i = targetsByUnit.get(name);
      phys = i.phys ?? 0; mag = i.mag ?? 0;
      label = `${name} (${phys}/${mag})`;
    } else {
      throw new Error(
        `unknown target "${name}". Named: ${Object.keys(NAMED).join(', ')}. ` +
        'Any unit id with a declared armour intent also works - see `bench targets`.'
      );
    }
    return {
      name: label, physReduction: phys, magicReduction: mag, level,
      armor: resistForReduction(level, phys, ctx.consts.resistFormula),
      magicArmor: resistForReduction(level, mag, ctx.consts.resistFormula),
    };
  }

  // --- one cast ------------------------------------------------------------
  function amountOf(effect, sheet, swingAttrs = null, weaponMixFlats = null) {
    let a = effect.baseVal;
    for (const s of effect.scaling) {
      let v = sheet.get(s.atb) ?? 0;
      // WeaponPower is the weapon's flat base PLUS the mean of the ITEM's
      // aptitude attributes. The expanded tooltips render it outright:
      // Beefury (Fighter+Cleric) swings "(13 + 6.5% Strength + 6.5% Faith)"
      // - the type's 13% split across its two aptitude attributes -
      // Wingsabers "(22 + 10.25% Strength + 10.25% Intellect)", and the
      // single-aptitude Judgement keeps its whole 0.7 on Strength. The live
      // reads agree: the axe's equip delta and the greataxe's 78-95 both
      // price on ratio x (flat + attributes/n).
      if (s.atb === 'WeaponPower' && swingAttrs?.length) {
        let sum = 0;
        for (const atb of swingAttrs) sum += sheet.get(atb) ?? 0;
        v += sum / swingAttrs.length;
      }
      // A MAINHAND WEAPON SKILL's attribute scaling is 60% attribute and 40%
      // a flat from THAT ATTRIBUTE's own budget curve. The rule is
      // `constant.WeaponPowerRatio`'s own description - "Percent of AP/SP
      // scaling that are replaced by a flat amount coming from the weapon",
      // MainhandWeaponSkill 0.4 - and the flat being per-attribute is what
      // Tear settled: 0.45 x (0.6x49 + 0.4x123.6[Strength curve]) + 0.45 x
      // (0.6x46 + 0.4x148.3[Dexterity curve]) = 74.6 against a measured 75,
      // where one shared Strength flat prices 70.5. Six measured integers
      // reproduce exactly: Rampage 233/371/556, Brutal Frenzy 133 and its
      // 28 rider, Tear 75.
      else if (weaponMixFlats) {
        const f = weaponMixFlats.get(s.atb);
        if (f) v = 0.6 * v + 0.4 * f;
      }
      a += s.ratio * v;
    }
    return a;
  }

  // What the target is currently wearing. A debuff on the enemy is the other
  // half of a rotation's dependency order: `GA_Demon_Skill1_Status` strips a
  // quarter of its Armor AND its MagicArmor, `Priest_BeaconOfHope_Status_Debuff`
  // makes it take 10% more, and until the fight could hold state, every one of
  // those was worth exactly zero.
  const NO_DEBUFF = { armor: 1, magicArmor: 1, taken: 1 };
  // Per-category damage multipliers a talent confers, which are not stats and
  // so cannot live on the sheet. Empty by default, so a build with none of them
  // computes exactly what it did before.
  const NO_MODS = { critDamageByType: null, critChanceByType: null, damageByAffinity: null, armorIgnore: null, bleed: null };
  function targetState(active) {
    if (!active || !active.length) return NO_DEBUFF;
    let armor = 1, magicArmor = 1, taken = 1;
    for (const d of active) {
      for (const a of d.affixes ?? []) {
        const atb = a.target?.attribute;
        const v = (a.val ?? 0) * (d.stacks ?? 1);
        // A debuff states its change the same three ways an item does, and
        // composes the way the `affix` sheet says it does.
        const kind = ctx.affix.kindOf(a.ref);
        const apply = (cur) => (kind === 'addRatio' ? cur * (1 + v)
          : kind === 'mulRatio' ? ctx.affix.composeMul(a.ref, cur, v)
            : cur);
        if (atb === 'Armor') armor = apply(armor);
        else if (atb === 'MagicArmor') magicArmor = apply(magicArmor);
        else if (atb === 'DamageTakenModifier') taken = apply(taken);
      }
    }
    return { armor: Math.max(0, armor), magicArmor: Math.max(0, magicArmor), taken: Math.max(0, taken) };
  }

  function mitigate(effect, sheet, target, foe = NO_DEBUFF, mods = NO_MODS) {
    const aff = affinityOf(effect.affinity);
    if (aff.root === 'Raw' || !aff.resist) return foe.taken;
    const resist = (aff.resist === 'MagicArmor' ? target.magicArmor * foe.magicArmor : target.armor * foe.armor);
    // `armorIgnore` is penetration by another name - Exposed Essence ignores 5%
    // of a bleeding enemy's armour - so it lands on the same lever, in points
    // of percent, alongside whatever the sheet already carries.
    const ignore = (mods.armorIgnore?.[aff.root] ?? 0) * 100;
    const pen = (aff.pen ? (sheet.get(aff.pen) ?? 0) : 0) + ignore;
    const red = damageReduction({
      resist,
      penetrationPct: pen,
      attackerLevel: target.level,
      flatReduction: 0, // the target's own flat reductions; a reference foe has none
      formula: ctx.consts.resistFormula,
    });
    return Math.max(0, 1 - red) * foe.taken;
  }

  /**
   * Expected output of one cast, split by effect kind.
   *
   * `opts.assume` toggles the three unverified multipliers, and `opts.targets`
   * says how many enemies stand in an area. That last one is a USER INPUT and
   * not a derived number: the geometry is fully authored (shape, range, height,
   * an expanding `rangeScale`) but nothing anywhere says how many enemies are
   * inside it. `unitGroup` describes spawn points, and the `spawner` sheet is
   * empty because placement lives in level data. So a single-target figure is
   * the default and everything else is asked for.
   */
  function castOutput(prof, sheet, target, opts, foe = NO_DEBUFF, mods = NO_MODS) {
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

    const wantTargets = Math.max(1, opts.targets ?? 1);

    let damage = 0, heal = 0, shield = 0;
    let singleTargetDamage = 0;
    let critPhysical = 0, critMagic = 0;
    let totalPhysical = 0, totalMagic = 0;
    // What this cast puts into a resource pool. `Mage_RayOfSpark` returns
    // 0.18 * MaxSpark, so the amount needs the sheet exactly the way damage
    // does - which is why it is computed here rather than at plan time.
    let gains = null;
    for (const e of prof.effects) {
      if (e.kind === 'GainAtb') {
        if (!e.atb) continue;
        const got = amountOf(e, sheet, opts.swingAttrs ?? null) * (e.hits ?? 1);
        if (!got) continue;
        (gains ??= []).push({ atb: e.atb, amount: got });
        continue;
      }
      const raw = amountOf(e, sheet, opts.swingAttrs ?? null,
        opts.weaponMix?.ids?.has(prof.id) ? opts.weaponMix.flats : null) * (e.hits ?? 1);
      if (!raw) continue;
      // Only an Area or Aura step reaches the crowd, and `props.hitCount` is a
      // target cap when the row sets one. `ignoreMainTarget` takes the enemy
      // you hit out of the count, so at one target such a step lands on nobody.
      const targets = e.area
        ? Math.max(0, Math.min(wantTargets, e.area.maxTargets ?? Infinity) - (e.area.ignoreMainTarget ? 1 : 0))
        : 1;
      if (!targets && e.kind === 'Damage') continue;
      if (e.kind === 'Damage') {
        const aff = affinityOf(e.affinity);
        // Per-CATEGORY multipliers, which the sheet cannot express because they
        // are not stats. Most of the "increased damage" talents are one of
        // these: `Sever` is +20% critical damage on WeaponSkills only,
        // `Master-at-arms` +15% on Attacks only, `Magic Conduction` +7% on
        // Magic damage against a bleeding target. A single DamageModifier
        // cannot say any of that, so a reader that folded them into one would
        // apply a weapon-skill bonus to every swing.
        const cat = prof.isFiller ? 'Attack' : prof.type;
        const critBonus = mods.critDamageByType?.[cat] ?? 0;
        const chanceBonus = mods.critChanceByType?.[cat] ?? 0;
        const localCrit = (critBonus || chanceBonus)
          ? 1 + Math.min(1, critChance + chanceBonus)
            * ((sheet.get('CritDamage') ?? 100) / 100 + critBonus - 1)
          : critMult;
        let m = dmgMod * localCrit * mitigate(e, sheet, target, foe, mods);
        // A scoped damage bonus: by affinity (Magic Conduction), by skill type
        // (a weapon-skill bonus), or across the board.
        for (const rd of prof.runeDamage ?? []) {
          if (rd.singleTarget && wantTargets !== 1) continue;
          m *= 1 + rd.amount;
        }
        m *= 1 + (mods.damageByAffinity?.[aff.root] ?? 0)
          + (mods.damageByAffinity?.all ?? 0)
          + (prof.type === "WeaponSkill" ? (mods.damageByAffinity?.WeaponSkill ?? 0) : 0);
        if (fervorHere) m *= 1 + fervor;
        if (opts.assume.mastery) {
          if (aff.root === 'Physical') m *= 1 + physMastery;
          else if (aff.root === 'Magic') m *= 1 + magicMastery;
        }
        damage += raw * m * targets;
        singleTargetDamage += raw * m;
        // How much of that landed at all and how much as a CRITICAL strike, by
        // affinity. A pool dot is a share of the damage that triggered it -
        // Hemorrhage's trigger is a crit, so it needs the crit slice, while
        // Bonethrow's guard has no crit test and takes its whole output - so
        // the fight needs both streams. The crit fraction is `p*cd / localCrit`
        // with the CATEGORY bonuses in: Sever's +20% crit damage on weapon
        // skills raises the crit slice of those hits, and reading the base
        // p*cd/critMult against a total built with localCrit under-fed the
        // pools of exactly the crit-stacked builds the optimiser recommends.
        // ...and BEFORE DamageModifier. A pool dot banks base damage and each
        // tick is multiplied by whatever is up when it lands - checked in game:
        // a bleed already ticking at 100 goes to 120 the moment Berserk is
        // pressed, without a new crit. So the multiplier cannot be baked in at
        // the moment the pool is fed; it is applied over the ticking window.
        if (dmgMod > 0) {
          const banked = (raw * m * targets) / dmgMod;
          if (aff.root === 'Physical') totalPhysical += banked;
          else if (aff.root === 'Magic') totalMagic += banked;
          if (localCrit > 0) {
            const pEff = Math.min(1, critChance + chanceBonus);
            const cdEff = (sheet.get('CritDamage') ?? 100) / 100 + critBonus;
            const critShare = (raw * m * targets) * (pEff * cdEff) / localCrit / dmgMod;
            if (aff.root === 'Physical') critPhysical += critShare;
            else if (aff.root === 'Magic') critMagic += critShare;
          }
        }
      } else if (e.kind === 'Heal') {
        // HealGivenMultiplier already carries Fervor - that one IS verified,
        // straight out of attribute.scaling - so it must not be applied twice.
        heal += raw * healMod;
      } else if (e.kind === 'Shield') {
        shield += raw * shieldMod;
      }
    }
    return { damage, heal, shield, singleTargetDamage, gains, critPhysical, critMagic, totalPhysical, totalMagic };
  }

  // --- throughput ----------------------------------------------------------
  /**
   * Throughput is now a FIGHT, played out over `opts.fight` seconds by
   * sim.mjs, rather than a steady state. See that file for why. This function
   * is the adapter: it prices one cast and one status tick against the sheet
   * and the target, and hands both to the simulator.
   */
  function throughput(rotation, sheet, target, opts, live = null) {
    const cdr = 1 + (sheet.get('CooldownReduction') ?? 0) / 100;
    // Cooldown earned back by an EVENT rather than carried as a stat, and only
    // for the skills the event names. `Red Tempo` cuts a second off your weapon
    // skills on a 12% roll per bleed tick, which at one tick every two seconds
    // is 0.06 seconds per second - the same arithmetic as 6 points of
    // CooldownReduction, but applying to WeaponSkills alone. The sheet has one
    // CooldownReduction and cannot say that, so it rides alongside.
    const cdrWeaponSkill = cdr + (live?.mods?.cooldown?.weaponSkill ?? 0);
    const restat = live?.restat ?? (() => sheet);
    // A cast is priced AT THE MOMENT IT IS CAST, against whatever is up. That is
    // the whole difference between a priority list and a rotation: with a fixed
    // price, stripping a quarter of the target's armour first is worth nothing
    // and so is saving a cooldown for a damage window.
    //
    // The cache key is the state, not the clock. A fight cycles through a
    // handful of distinct (buffs up, debuffs up) combinations thousands of
    // times, so pricing is memoised on that signature rather than recomputed.
    const castCache = new Map();
    const cast = (prof, state) => {
      const key = state ? state.key : '';
      let byState = castCache.get(prof);
      if (!byState) { byState = new Map(); castCache.set(prof, byState); }
      let hit = byState.get(key);
      if (!hit) {
        hit = castOutput(prof, state ? restat(state.self) : sheet, target, opts,
          state ? targetState(state.target) : NO_DEBUFF, live?.mods ?? NO_MODS);
        byState.set(key, hit);
      }
      return hit;
    };
    // ONE TICK of a status. `castOutput` always returns the whole lifetime's
    // worth - a SpreadEffects step declares its total outright, and a per-tick
    // step has already been multiplied by its tick count in `profile()` - so
    // the per-tick amount is that total divided by the ticks, in both cases.
    // Getting this wrong is a factor of ten on a ten-tick aura, because the
    // simulation then ticks the whole total once a second.
    //
    // A DoT SNAPSHOTS. Its per-tick value is fixed at the moment it is applied
    // from the state that was up then, and does not follow the buffs that come
    // and go while it ticks. That is what SimulationCraft does and it is the
    // convention this model follows; nothing in the CDB states it either way,
    // so it is in the audit as an assumption.
    const dotOutput = (d, state) => {
      const whole = cast(d.prof, state);
      const ticks = Number.isFinite(d.duration) && d.tick > 0
        ? Math.max(1, Math.floor(d.duration / d.tick + 1e-9)) : 1;
      return { damage: whole.damage / ticks, heal: whole.heal / ticks };
    };
    // The pools this fight tracks, with their caps off the sheet. A resource is
    // only tracked when something in the build declares income for it that the
    // model could read - otherwise the cap alone would let a skill spend from a
    // pool nothing ever fills. `NoAutoFill` decides whether you walk into the
    // fight with it full: Rage, ComboPoint and SpecialEnergy all declare it, so
    // they start empty.
    const resources = {};
    for (const atb of rotation.resources?.tracked ?? []) {
      const a = ctx.attrTable.byId.get(atb);
      if (!a) continue;
      const max = a.maxAtb ? (sheet.get(a.maxAtb) ?? 0) : Infinity;
      if (!(max > 0)) continue;
      // `attribute.gainAtb` names a multiplier on everything you EARN into this
      // pool - Rage declares `RageGainFactor`, which the Warrior unit sets to 1
      // and `Warrior_BerserkStatus` doubles with an ARatio of +1. The resting
      // value is the default; the NAME travels too, so the fight can re-read
      // the factor against whatever is up when the income actually arrives -
      // frozen at rest, the doubling never applied and Berserk's extra Rage
      // was lost exactly inside the +20% window where it pays most.
      const factor = a.gainAtb ? (sheet.get(a.gainAtb) ?? 1) : 1;
      resources[atb] = {
        max,
        start: a.flags.has('NoAutoFill') ? 0 : max,
        factor: factor > 0 ? factor : 1,
        gainAtb: a.gainAtb ?? null,
      };
    }
    // The live gain factor for a pool, priced against the buffs that are up at
    // the moment the income arrives. Memoised on the state key the same way
    // cast pricing is; the resting sheet answers when nothing is up.
    const factorCache = new Map();
    const poolFactor = (gainAtb, state) => {
      const key = gainAtb + '|' + (state?.key ?? '');
      let f = factorCache.get(key);
      if (f == null) {
        f = restat(state?.self ?? []).get(gainAtb) ?? 1;
        if (!(f > 0)) f = 1;
        factorCache.set(key, f);
      }
      return f;
    };

    // What a pool dot's ticks are multiplied by, averaged over the fight.
    // The ticks are spread evenly across the bleed's life and a damage buff is
    // up for a known fraction of the clock, so the AVERAGED sheet - every timed
    // buff at its uptime - is exactly the right multiplier to apply to a total
    // that was banked without one.
    // ...and the talents that modify BLEED damage specifically, which is a
    // category the sheet cannot name either. `Bloodletting` is +10% per point
    // on anything ticking; `Exsanguination` lets the bleed itself critically
    // strike, which the base game does not let it do - so it is a crit chance
    // applied to a damage stream that otherwise has none.
    //
    // PER POOL DOT, matched by status type. Exsanguination's guard says
    // `isStatusType(StatusType.Hemorage)` and Bonethrow's status is a plain
    // `Bleed`; the statusType sheet subtypes them ONE way (`Hemorage` declares
    // `parent: Bleed`, nothing else declares a parent), so Bloodletting's Bleed
    // guard covers both dots and Exsanguination's Hemorage guard covers only
    // Hemorrhage and Infused Wound. One shared multiplier handed the crit
    // chance to both. That the game's isStatusType walks the parent chain is
    // an assumption - the column is in the data, the walk is not - and it is
    // the only reading under which the parent column does anything at all.
    const bleedMods = live?.mods?.bleed ?? {};
    const bleedCrit = bleedMods.critChance ?? 0;
    const avgDmgMod = ((live?.averagedSheet ?? sheet).get('DamageModifier') ?? 100) / 100;
    const poolMultiplier = avgDmgMod
      * (1 + (bleedMods.dmgMult ?? 0))
      * (1 + bleedCrit * ((sheet.get('CritDamage') ?? 100) / 100 - 1));
    const typeParent = new Map();
    for (const r of cdb.lines('statusType')) typeParent.set(r.id, r.parent ?? null);
    const coveredBy = (guardType, dotTypes) => (dotTypes ?? []).some((t) => {
      for (let cur = t, hops = 0; cur != null && hops < 8; cur = typeParent.get(cur) ?? null, hops++) {
        if (cur === guardType) return true;
      }
      return false;
    });
    const bleedScoped = live?.mods?.bleedScoped ?? null;
    const poolScale = new Map();
    if (bleedScoped) {
      for (const d of rotation.dots ?? []) {
        if (!d.pool) continue;
        let dmgMult = 0, critCh = 0, healShare = 0;
        for (const mod of bleedScoped) {
          if (!coveredBy(mod.statusType, d.types)) continue;
          if (mod.field === 'dmgMult') dmgMult += mod.amount;
          else if (mod.field === 'critChance') critCh += mod.amount;
          else if (mod.field === 'healShare') healShare += mod.amount;
        }
        poolScale.set(d.status, {
          mult: avgDmgMod * (1 + dmgMult)
            * (1 + critCh * ((sheet.get('CritDamage') ?? 100) / 100 - 1)),
          healShare,
        });
      }
    }

    return simulate({
      rotation, cast, dotOutput, cdr, cdrWeaponSkill, resources, poolMultiplier,
      poolScale: bleedScoped ? poolScale : null,
      poolFactor,
      goal: live?.goal ?? null,
      chainResets: opts.assume?.chainResets ?? true,
      swingVariance: cdb.byId('constant').get('WeaponAttack_RandomRange')?.v?.float ?? 0.1,
      poolHealShare: bleedMods.healShare ?? 0,
      critChance: Math.min(1, Math.max(0, (sheet.get('CritChance') ?? 0) / 100)),
      timedBuffs: live?.timedBuffs ?? [],
      fight: opts.fight ?? 200,
      fights: opts.fights ?? 1,
      lookahead: opts.lookahead ?? 0,
      seed: opts.seed ?? 0x9e3779b9,
      // An authored rotation, when one is being tested rather than derived.
      policy: live?.policy ?? null,
    });
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
  // to come from the weapon. It is the FULL class primary budget at the
  // weapon's TRAINED level - calibrated against a real Cheese Moon on a
  // 0-armor dummy: tooltip "18-21 Physical damage" and observed naked swings
  // of 19-24, where swing 1's authored 0.13 x WeaponPower needs ~150-165 and
  // the full budget at the trained effective level gives 148-156. The old
  // slot-share reading (x0.28) priced the same swing at 4.5-5.7, four times
  // low on every base attack in the game.
  //
  // TRAINED level, not drop level: weapons level per kills
  // (WeaponKills_PerSkillRankPoint), and the same axe whose stats still read
  // the level-11 drop budget swings with the level-25 curve once trained.
  // Assumed fully trained to the character's level, alongside the bench's
  // existing "fully mastered" default.
  //
  // ONLY the main hand. This used to sum both weapon slots at the arsenal's 0.4
  // factor, so equipping an arsenal weapon raised every base attack by ~40% -
  // for a slot that skills.mjs is explicit grants no base-attack chain and no
  // combo at all. The base attacks come from the weapon in your hands, so that
  // is the only weapon whose power they can be reading.
  function weaponPowerFor(cat, loadout, cls) {
    const apt = cdb.byId('aptitude').get(cls.aptitude);
    const primary = (apt?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0);
    if (!primary) return 0;
    const g = loadout.gear.Slot_Weapon1;
    if (!g?.item) return 0;
    const item = cat.itemById.get(g.item);
    if (!item) return 0;
    // The FLAT half of the trained level's primary budget - no rarity or star
    // iLevel bonuses, which the measured tooltips assign to the STATS, not to
    // the damage line. The primary-attribute half is added at consumption, per
    // sheet, in amountOf - it follows whatever Strength the sheet carries.
    //
    // ONE-HANDERS take the whole flat budget, TWO-HANDERS 0.4 of it - both
    // measured on a 0-armor dummy at trained level 25: Cheese Moon's swings
    // need a flat of ~116-120 (budget 123.6) through its 0.13 ratio, and
    // Judgement's need ~52 (0.4 x budget) through its 0.7. The pair is what
    // makes a two-hander a two-hander: 3-4x the swing damage, and 5x the
    // Strength scaling per point. 1.0/0.4 are the parsimonious constants
    // within the +-5% the display rounding leaves; the residuals are in the
    // audit, and `constant.WeaponPowerRatio` carrying exactly {0.4, 1} is
    // suggestive but unproven provenance.
    const twoHanded = !cat.allowsOffhand(item);
    return budget(loadout.level, primary.start, primary.end, ctx.consts.earlyMaxLevel)
      * (twoHanded ? 0.4 : 1.0);
  }

  /** The aptitude's primary attribute - what WeaponPower adds at consumption. */
  function primaryAtbFor(cls) {
    const apt = cdb.byId('aptitude').get(cls.aptitude);
    return (apt?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0)?.endAtb ?? null;
  }

  /** The flat primary budget at a level - the weapon's contribution to skills. */
  function primaryBudgetFor(cls, level) {
    const apt = cdb.byId('aptitude').get(cls.aptitude);
    const primary = (apt?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0);
    return primary ? budget(level, primary.start, primary.end, ctx.consts.earlyMaxLevel) : 0;
  }

  /**
   * Every primary attribute's own budget curve at a level, one entry per
   * aptitude - Strength 123.6 and Dexterity 148.3 at 25 are NOT the same
   * number, and Tear (45% Str + 45% Dex) is what proved each scaling mixes
   * with its own curve rather than the wielder's.
   */
  function attributeBudgets(level) {
    const flats = new Map();
    for (const apt of cdb.lines('aptitude')) {
      const primary = (apt.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0);
      if (!primary?.endAtb || flats.has(primary.endAtb)) continue;
      flats.set(primary.endAtb, budget(level, primary.start, primary.end, ctx.consts.earlyMaxLevel));
    }
    return flats;
  }

  const audit = [
    { severity: 'verified', what: 'Fervor multiplies ALL damage by its own percentage, base attacks included',
      why: 'Measured on a 0-armor dummy: a combo finisher at 133 reads exactly 133 x 1.12 x 1.016 = 151 ' +
           'under +12% PhysicalMastery and 30 FervorRating (~+1.58%); without the Fervor term it prices ' +
           '149. Its description says "your Skills", and the finisher that moved is a base-attack chain ' +
           'link - so the description undersells it and the default is all. --fervor-scope skills|none ' +
           'remain as sensitivity toggles.' },
    { severity: 'verified', what: 'PhysicalMastery / MagicMastery multiply matching-affinity damage',
      why: 'Measured on a 0-armor dummy: with 3 Brutal Frenzy stacks (+12 PhysicalMastery) swings moved ' +
           'x1.127 and the finisher x1.135 - both 1.12 x the Fervor also up at the time. The coefficient ' +
           'is 1 + mastery/100, exactly as modelled; --no-mastery remains as a sensitivity toggle.' },
    { severity: 'assumption', what: 'WeaponPower = the TRAINED level\'s flat primary budget x (1.0 one-handed, 0.4 two-handed), plus the mean of the item\'s aptitude attributes',
      why: 'Calibrated on a 0-armor dummy against two weapons at trained level 25 (Cheese Moon flat ' +
           '~116-120 vs budget 123.6 through its 0.13; Judgement ~52 = 0.4 x budget through its 0.7), ' +
           'and the attribute half is rendered outright by the expanded tooltips: Beefury swings ' +
           '"(13 + 6.5% Strength + 6.5% Faith)" - the type ratio split across the item\'s two aptitude ' +
           'attributes - Wingsabers "(22 + 10.25% Strength + 10.25% Intellect)", Judgement all 0.7 on ' +
           'Strength. Two bag reads (Beefury 16-19, Wingsabers 27-32, both Epic 0-star) imply flats of ' +
           '~100-107, consistent with weapons trained BELOW the character\'s level - the bench assumes ' +
           'fully trained, which overstates an untrained pickup and is exact for a levelled main. Their ' +
           'displayed weapon Level lines would confirm the trained-level reading.' },
    { severity: 'verified', what: 'a mainhand skill\'s attribute scaling is 60% attribute + 40% of that attribute\'s own budget curve',
      why: 'constant.WeaponPowerRatio\'s own description - "Percent of AP/SP scaling that are replaced ' +
           'by a flat amount coming from the weapon", MainhandWeaponSkill 0.4 - measured exact on ten ' +
           'integers, and the game\'s expanded tooltips RENDER the rule: Royal Severance shows ' +
           '"(30 + 30% Intellect)" and "(25 + 30% Strength)" - 0.6 x its authored 0.5 on the attribute, ' +
           '0.4 x 0.5 x each attribute\'s own level-25 curve as the flat (148.3 and 123.6) - Hive Bite ' +
           '"(48 + 29.33% x2)" is authored 0.85 x its own rank-2 +15%, and its heal "(9 + 10.35% ' +
           'Faith)" is 0.15 x 1.15. Live: Rampage 233/371/556, Brutal Frenzy 133 + 28 rider, Tear 75 ' +
           '(the two-attribute case that proved the flat is per attribute). The flats follow the ' +
           'CHARACTER\'s level even on a lower-trained weapon. Applied to skills the MAIN HAND grants; ' +
           'arsenal and class skills keep pure attribute scaling, unmeasured.' },
    { severity: 'verified', what: 'an item pays EVERY aptitude it names - except armour, which pays once',
      why: 'Read off the character sheet: a naked Warrior at 38/34/28 Vitality/Strength/Dexterity ' +
           'equips Cheese Moon (Fighter+Assassin) and reads 74/49/46 - every tooltip line, including ' +
           'the Assassin\'s +18 Dexterity the old own-half rule refused a Warrior - and Tear\'s live 75 ' +
           'prices on that Dexterity too. Armour still pays once: its budget is the wearer\'s ' +
           'resistForReduction with no aptitude in it. Generic jewellery still pays exactly one named ' +
           'row (measured separately). Consequence: dual-aptitude gear carries roughly two budgets ' +
           'of primaries and ratings, and is priced that way now.' },
    { severity: 'assumption', what: 'Brutal Frenzy\'s 0.3-ratio step is billed per finisher, not as its 15%-per-attack rider',
      why: 'The tooltip says "all your attacks have a 15% chance to deal an additional 28" - a rider ' +
           'the script rolls on every attack - while the step itself is authored unconditionally on ' +
           'the finisher. Per cast the model bills 28 x finisher rate; the rider reads 0.15 x 28 x ' +
           'attack rate. At measured swing and combo rates the two are within a few dps of each other, ' +
           'so the wrong schedule is kept knowingly rather than half-read.' },
    { severity: 'unmodelled', what: 'most of what a rune or a talent does, pending the script kernel',
      why: 'Most talent nodes and most runes declare nothing this model reads, but they DO ship hscript ' +
           'bodies calling a small, closed set of host functions - so the gap is the script kernel, not ' +
           'missing data. `bench talents` prints the live counts rather than repeating them here, ' +
           'because a hardcoded coverage figure goes stale the moment the model improves.' },
    { severity: 'assumption', what: 'every step of a granted status is counted, including script-gated ones',
      why: 'Priest_Talent_Sunlight_Status declares a Damage step AND an AreaDamage step, and its script only ' +
           'plays the second when Priest_Talent_SunHalo is also taken. Nothing in the step row says so, so ' +
           'the status reads as 1.2x Faith rather than 0.6x unless SunHalo is in the build. A talent that ' +
           'grants a status can therefore be overstated by whatever its conditional steps add.' },
    { severity: 'assumption', what: 'charged skills are evaluated at full charge, and the hold is billed',
      why: 'Steps gated on cond.castHoldStep are mutually exclusive charge levels; the highest is used ' +
           'and its hold time is charged as occupancy. Checked in game on Rampage: 233/371/556 damage at ' +
           '1s/2s/3s of hold - exactly its authored 2.5/4/6 x Strength and vars.time 3 - and a tap does ' +
           'not cast at all. What remains assumed is the CHOICE of full charge, and the ~0.3s between ' +
           'release and impact is not billed.' },
    { severity: 'unmodelled', what: 'skill scripts, beyond the links and guards read out of them',
      why: '427 of 962 skills carry hscript bodies this build does not execute. Four things ARE read out ' +
           'of the text, because the data records them nowhere else: the status a skill applies ' +
           '(addStatus, through a local alias if it uses one), the event that applies it (isWeaponSkill, ' +
           'isBaseAttack, isFinalCombo), the roll that guards it (checkProba(vars.chance)), and the proc ' +
           'rate vars.chance itself. Everything else - a magnitude passed as a third addStatus argument, ' +
           'a setDynVal injection, a conditional rider - is not, and a status whose whole payload is a ' +
           'script-set dynVal is named as unmodelled rather than counted at zero without comment.' },
    { severity: 'verified', what: 'how a re-applied status composes is read from props.status.stackingPolicy',
      why: 'Additive | DurationBased | Override, authored on 11 of 250 status rows. DurationBased CARRIES ' +
           'THE REMAINDER - checked in game on Hemorrhage, where a 200 crit banks 70 damage over 8s and a ' +
           'second crit for 100 two ticks later adds the 35 still owed to the new 35 - and only four ' +
           'statuses declare it. Everything else refreshes, losing the overflow. Guessing which dots pool ' +
           'from "is the declared amount a total" instead matched nearly every dot in the game and took ' +
           'the answer to 44,000 dps, which is what the column is for.' },
    { severity: 'assumption', what: 'a pool DoT is credited as the share of what fed it, paid out tick by tick',
      why: 'Warrior_Hemorrhage takes 35% of every physical critical strike (vars.damage, handed to ' +
           'addStatus as a third argument) and its status is DurationBased with unlimited stacks, so no ' +
           'damage is ever dropped while the fight runs. WHICH damage feeds a pool is read off the ' +
           'script\'s hook: `onInflictDamage` is owner-global (Hemorrhage, Infused Wound), a skill\'s own ' +
           '`onDamage` sees only that skill\'s hits (Bonethrow bleeds for 40% of what BONETHROW deals - ' +
           'reading it as global fed it from the whole rotation\'s crits and invented ~18% of a Warrior\'s ' +
           'headline). The bank pays out over the dot\'s own tick schedule, DurationBased-style - each ' +
           'feed redistributes what is still owed over a fresh window - so what the bell catches ' +
           'un-ticked is dropped, which is what a damage meter would have missed too. Red Tempo earns ' +
           'its cooldown back per tick and Cracking Blood rolls against each one. What is still assumed ' +
           'is Magic Conduction\'s and Exposed Essence\'s "while the target is bleeding", which are ' +
           'credited whole rather than at the bleed\'s uptime.' },
    { severity: 'info', what: 'physical and magical reduction are equal on every real foe',
      why: 'Only the dev punching bags split them, so ArmorPenetration and SpellPenetration are worth the ' +
           'same against everything currently in the game. Which one you want is decided by your class and ' +
           'your gear\'s faction, not by the target.' },
    { severity: 'verified', what: 'weapon-damage swings vary ±10% around the mean; attribute-scaled hits do not vary at all',
      why: 'WeaponAttack_RandomRange = 0.1, and both halves are measured: WeaponPower-scaled swings ran ' +
           '19-24 and 78-95 around their means, while the Strength-scaled combo finisher read a constant ' +
           '133 every time. So the roll rides the weapon damage only; deterministic mode keeps the mean ' +
           'and --fights N rolls the swings that actually vary.' },
    { severity: 'assumption', what: 'a chain link swings no faster than 0.7 seconds',
      why: 'Calibrated from two stopwatches: ten Cheese Moon chains in 28s where the authored durations ' +
           'sum to 1.81s - they are hit timings, not swing periods - and ten Judgement chains in ~30s, ' +
           'exactly the authored 3.00s, at or above the floor throughout. No located constant carries ' +
           'the 0.7 (Attacks_RecoveryRatio 0.25 reproduces neither watch), so it is measured rather ' +
           'than read, and --swing-floor moves it.' },
  ];

  return {
    profile, foe, foes: Object.keys(NAMED), namedTargets: NAMED, targetsByUnit, armourIntent,
    castOutput, throughput, survivability, affinityOf, weaponPowerFor, primaryAtbFor,
    primaryBudgetFor, attributeBudgets, audit,
  };
}
