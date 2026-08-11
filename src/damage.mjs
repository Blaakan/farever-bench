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
  // The floor on how fast a chain link swings. THERE IS NONE, and the 0.70s
  // that stood here was the largest error in the model.
  //
  // It came from two stopwatch readings - Cheese Moon, 10 chains in 28s;
  // Judgement, 10 in ~30s - and Judgement agreed because its authored durations
  // already sit at 0.70-0.85. The fast axe's authored 0.25-0.55 were read as
  // "hit timings that under-run the watch", and the difference was papered over
  // with a floor rather than chased.
  //
  // An instrumented capture settled it: 4,916 logged damage events over an
  // 88-second dummy session, of which 12 uninterrupted Cheese Moon cycles have
  // a MEDIAN OF 1903ms (1820-1972) against the floored model's 2850ms - a ratio
  // of 1.498 - with individual links landing 210-640ms apart, well under the
  // floor that was supposed to bound them. The authored durations sum to
  // 1810ms, within 5% of the measured median, so they were right all along and
  // the stopwatch was measuring interrupted chains.
  //
  // Every throughput number in the tool inherited that 1.5x. `--swing-floor`
  // still moves it, and 0.7 restores the old reading for comparison.
  const swingFloor = Number.isFinite(assume.swingFloor) ? assume.swingFloor : 0;
  const skills = cdb.byId('skill');
  const affinities = cdb.byId('affinity');
  const effectNames = cdb.enumValues('skill@steps@effects', 'effect');
  const skillTypeNames = cdb.enumValues('skill', 'type');
  const skillNatureNames = cdb.enumValues('skill', 'nature');
  const stepTypeNames = cdb.enumValues('skill@steps', 'type');
  const stepOnNames = cdb.enumValues('skill@steps', 'on');

  // Does a statusType carry the DoT (bit 0) or HoT (bit 3) flag, its parent
  // chain included - Hemorage carries DoT itself AND parents to Bleed, and
  // hasStatusFlag@20821 walks the chain, so this does too.
  const statusTypeById = new Map(cdb.lines('statusType').map((r) => [r.id, r]));
  function statusTypeDotOrHot(typeId) {
    let cur = statusTypeById.get(typeId);
    for (let hop = 0; cur && hop < 8; hop++) {
      const f = cur.flags ?? 0;
      if ((f & 1) || (f & 8)) return true;
      cur = cur.parent ? statusTypeById.get(cur.parent) : null;
    }
    return false;
  }
  const PROJECTILE_HIT = stepOnNames.indexOf('ProjectileHit');
  // Which step types hit everything in a shape rather than one target.
  //
  // A `Mono` step carrying a props.area does NOT cleave, and that is settled
  // rather than assumed: AreaStep.areaHit@5972 pins hitCount to 1 for Mono, the
  // priority hit decrements it, and the function returns at L1893 before the
  // shape query runs. With no priority target the sweep runs and is then
  // trimmed to the single nearest object (L1970-1974). Mono IS an AreaStep at
  // runtime - isAreaStep@5961 is true for type 0 - so the cone is real; it
  // decides WHICH enemy, never how many. See the audit for the full read.
  //
  // The step-level `props.hitCount` is the one override, and all six of its
  // occurrences in the sheet hold 1. The tripwire below exists so that a patch
  // authoring anything else stops being silently single-target.
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
  function runeDamage(s, rank, runes, vars) {
    if (!s?.script) return [];
    const key = s.id + '@' + rank + '@' + (runes?.size ? [...runes].sort().join('+') : '-');
    let hit = runeDmgCache.get(key);
    if (hit) return hit;
    hit = [];
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const m of body.matchAll(/\w+\.(dmgMult|critDmgMult)\s*\+=\s*vars\.([A-Za-z0-9_]+)/g)) {
      const field = m[1];
      const before = body.slice(0, m.index);
      const line = before.slice(before.lastIndexOf('function'));

      // A RUNE guard still has to be satisfied by a slotted rune.
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (rune && !runes?.has(rune)) continue;
      const runeVars = rune ? (s.mastery ?? []).find((x) => x.id === rune)?.vars ?? null : null;
      // `vars` is the RANK-RESOLVED set - `props.rankOverride` restates them and
      // Domination's 0.15 becomes 0.25 from rank 2. Reading `s.vars` here would
      // understate it by 1.67x at every rank bench actually uses.
      const amount = vars?.[m[2]] ?? runeVars?.[m[2]];
      if (typeof amount !== 'number' || amount <= 0) continue;

      // A RANK guard is a question about the build, not about live state, so it
      // is answered here rather than refused. Bonethrow's rank-3 +20% crit
      // damage is the case: `if (rank >= 3) hit.critDmgMult += vars.var2`, with
      // no live condition anywhere in it.
      //
      // Only when the guard is a plain conjunction. Domination reads
      // `Stun || Root || Slow || (rank >= 3 && isCCImmune())`, where the rank
      // clause belongs to ONE alternative - vetoing the whole rider on it
      // silenced a +25% that fires on the stun path at any rank.
      if (!/\|\|/.test(line)) {
        let rankOk = true;
        for (const r of line.matchAll(/\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g)) {
          const n = Number(r[2]);
          rankOk = rankOk && (r[1] === '>=' ? rank >= n : r[1] === '<=' ? rank <= n
            : r[1] === '>' ? rank > n : r[1] === '<' ? rank < n
              : r[1] === '==' ? rank === n : rank !== n);
        }
        if (!rankOk) continue;
      }

      // A TARGET-STATE guard the fight can answer. `hasStatusType(Bleed)` is
      // the combo's +20%; the Stun/Root/Slow trio is Domination's. Anything
      // else stays a refusal.
      const gate = /hasStatusType\s*\(\s*(?:StatusType\.)?Bleed\s*\)/.test(line) ? 'bleeding'
        : /hasStatusType\s*\(\s*(?:StatusType\.)?(?:Stun|Root|Slow)\s*\)/.test(line) ? 'cc'
          : null;

      // Everything the guard says beyond what is stripped here is a condition
      // this cannot answer, and it must refuse rather than approximate.
      const singleTarget = /totalHits\s*==\s*1/.test(line);
      const rest = line
        .replace(/function\s+on\w+\s*\([^)]*\)/g, ' ')
        .replace(/hasMastery\s*\([^)]*\)/g, ' ')
        .replace(/hasStatusType\s*\([^)]*\)/g, ' ')
        .replace(/\w+\.isCCImmune\s*\(\s*\)/g, ' ')
        .replace(/\brank\s*(?:>=|<=|==|!=|>|<)\s*\d+/g, ' ')
        .replace(/\w+\.ctx\.totalHits\s*==\s*1/g, ' ')
        .replace(/\w+\.(?:dmgMult|critDmgMult)\s*\+=\s*vars\.\w+\s*;?/g, ' ')
        .replace(/\b(?:if|hit|dmg|ctx|var|target)\b/g, ' ')
        .replace(/[\s{}()&|!,;.=+]/g, '');
      if (rest.length) continue;
      hit.push({ amount, singleTarget, rune: rune ?? null, field, gate });
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
        //
        // A SPREAD loop divides by the game's own count - initTicks@5882 sets
        // baseExpectedTicks = floor(duration / tick), with no start-tick +1
        // whatever the flags say - and RayOfSpark is the row that shows the
        // difference: dur 1 at tick 0.25 with DIRECT_START read 5 here while
        // the game divides (and fires) 4. Every 2s-tick status row lands on
        // the same number under both formulas, which is how the +1 hid.
        ticks = spread
          ? Math.max(1, Math.floor(span / tick + 1e-9))
          : Math.floor((span - first) / tick + 1e-9) + 1;
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
    //
    // It restates VARS as well, and that half was missing. `updateSkillInf@20788`
    // (HSkill.hx:368-373) loops the overrides and, for every one whose minRank
    // the rank clears, calls BOTH `applyProps(r.props)` at ops 54-56 AND
    // `applyVars(r.vars)` at ops 57-59; the anonymous fn@20790 (HSkill.hx:357) Reflect-sets each
    // field onto the accumulated vars, so a later override wins. 98 rows carry
    // override vars, and Domination is the one that shows the cost: GA_Craft_
    // _Passive is `var1: 0.15` with `rankOverride [{minRank: 2, vars: {var1:
    // 0.25}}]`, so every read of it below rank 2 understates the rider by 1.67x
    // - and `bench`'s default rank is weaponSkillMaxRank, where the override is
    // always in scope.
    let props = s.props ?? {};
    let vars = s.vars ?? {};
    for (const ov of (s.props?.rankOverride ?? []).slice().sort((a, b) => (a.minRank ?? 0) - (b.minRank ?? 0))) {
      if ((ov.minRank ?? 0) > rank) continue;
      props = { ...props, ...(ov.props ?? {}) };
      vars = { ...vars, ...(ov.vars ?? {}) };
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
    // Steps the CAST does not play.
    //
    // `skill@steps.on` has a `Code` case, and it means exactly what it says: the
    // step is played by `playStep(Steps.<id>)` from the row's own script and by
    // nothing else. 158 steps in the sheet declare it, 72 of them carry a real
    // amount, and every single one was being folded into its skill's cast
    // output - so a rider the game rolls at 15% per swing was billed in full on
    // every combo finisher.
    //
    // GA_Craft_FinalCombo is the case that shows the shape. Its Area step is
    // 1.43 x Strength on Start - the tooltip's 133 - and its Mono step is 0.3 x
    // Strength with `id: "Attack"` and `on: Code`, played by
    //
    //   function onInflictHit(hit) {
    //     if( rank >= 3 && hit.isBaseAttack) {
    //       if(checkProba(vars.chance)) { playStep(Steps.Attack, hit.target); }
    //     }
    //   }
    //
    // with vars.chance = 0.15, which is the tooltip's "all your attacks have a
    // 15% chance to deal an additional 28" in as many words. So the cast is
    // worth 133, not 161, and the 28 is a separate rider on a separate clock -
    // which is what the model's own audit had flagged as a knowingly-wrong
    // schedule and what `skills.mjs` now reschedules through the same trigger
    // machinery every other proc uses.
    //
    // `Steps.<name>` is the step's own `id` column, not its type: 139 of the
    // 141 playStep call sites in the sheet name a step id on their own row.
    const scripted = [];
    // Amounts a script hands to a `dynVal` effect, keyed by the step it plays.
    const dynFills = scriptDynVals(s, runes);
    for (const st of s.steps ?? []) {
      if (!stepLives(st)) continue;
      // ...on a SKILL row. A status row is a different animal: it is a thing
      // that runs a script for as long as it is up, and its script-played steps
      // ARE its payload - Priest_Talent_Sunlight_Status declares nothing else at
      // all. So the split is drawn where it means something: a cast plays its
      // steps once and demonstrably does not play these, while a status has no
      // cast to exclude them from. What a status's own guard says is a separate
      // question and it is already named in the audit.
      // A STATUS row's Code steps are its tick payload only when the status
      // actually ticks - a looping status plays its step per tick and the dot
      // pricing consumes it folded. A status with NO loop that plays Code
      // steps is a different creature: an event rider worn as a buff.
      // Sunlight's status deals 0.6x Faith on the combo finisher and Purging
      // Strikes' 0.15x Faith per swing, and folding those into `effects` left
      // them in a bucket nothing reads - the one place damage still vanished
      // without a word.
      const rowLoops = (s.steps ?? []).some((x) => x.props?.loop?.tick != null);
      // 'Trigger' (on: 8) steps are event-played like 'Code' ones, not part
      // of the cast: DuplicatePoison_Skill1's 0.35xDex Trigger step was
      // folded into every press while the capture shows ten presses, ten
      // host hits and no such lattice anywhere - a phantom worth +10% on the
      // row. The other rows carrying one are monster skills and a defensive.
      const stepOnName = stepOnNames[st.on ?? -1] ?? null;
      const playedByScript = (stepOnName === 'Code' || stepOnName === 'Trigger')
        && (!s.props?.status || !rowLoops);

      const stepType = stepTypeNames[st.type ?? -1] ?? null;
      const hits = hitsOf(s, st, stepType, ownDuration, stepLives);
      const area = st.props?.area;
      // The tripwire. `props.hitCount` is read AFTER the Mono default inside
      // areaHit, so it WINS - and it is a countdown that the priority hit
      // decrements, so `hitCount: N` means N hits in total, not N extra. On
      // this build the disjunct matches nothing (all six authored values are
      // 1), so every number is byte-identical; on a patch that authors a real
      // one, the model starts cleaving instead of quietly under-reporting.
      const isArea = AREA_STEP_TYPES.has(stepType)
        || (stepType === 'Mono' && st.props?.hitCount != null && st.props.hitCount !== 1);
      const shape = area?.shape ? cdb.custom('AreaShape', area.shape) : null;

      if (st.props?.status?.ref) statusRefs.push({ ref: st.props.status.ref, on: stepOnNames[st.on ?? -1] ?? null, target: st.props.status.target ?? null });

      const into = playedByScript ? [] : effects;
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
        into.push({
          kind,
          // The step the effect rides on, by the id scripts name it with -
          // the detector split below needs to tell an Area pulse from the
          // LastOrbArea one, and nothing else carried the distinction.
          stepId: st.id ?? null,
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
            // The SECOND cap, which nothing read. `applyHitStrategy@5973`
            // (SkillStep.hx:1999-2008) keeps `ceil(len x clamp(p, 0, 1))` of
            // the entities the sweep found, chosen at random. One authored row
            // exists - SuperEliteDemon_Bomb, Proportion(0.3) - so no player
            // number moves; it belongs beside maxTargets because it is the same
            // kind of cap and the next patch may put one on a player skill.
            hitStrategy: area?.hitStrategy
              ? cdb.custom('AreaHitStrategy', area.hitStrategy) : null,
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
      // A script-played step is kept, whole, under the id the script names it
      // by - so `skills.mjs` can read the guard in front of `playStep` and put
      // the step on the clock the game actually gives it.
      if (playedByScript && into.length) scripted.push({ stepId: st.id ?? null, effects: into });
    }

    // The tick schedule of a status skill, which is what makes it a DoT rather
    // than a lump. `ticks` and `spread` are already resolved per effect, so
    // this only has to carry the lifetime the uptime arithmetic needs.
    // A looping step makes this a DoT whatever the lifetime turns out to be:
    // 36 statuses get their duration from the step that APPLIES them rather
    // than declaring one, so gating on `ownDuration` here made the fallback in
    // skills.mjs unreachable and dropped those statuses entirely.
    const looping = (s.steps ?? []).find((st) => st.props?.loop?.tick != null);
    // A DETECTOR loop is not a payout clock. Depth Shield's orb status loops
    // at 0.1s, but the looping step carries NO effects - it exists to notice a
    // foe - and the script consumes one of the status's own stacks per hit,
    // playing an Area step that carries the real damage. Pricing that as a
    // 0.1s-tick DoT spread 0.55x Faith over a lifetime of detector polls and
    // printed 0.7 a tick against the game's 152 a strike.
    const detector = !!looping
      && !(looping.effects ?? []).length
      && new RegExp(`consumeStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?${s.id}\\b`)
        .test(String(s.script ?? ''));
    if (detector) {
      // The pulse count is the stack count - THROUGH rankOverride, which
      // restates maxStacks at the top level of the override's props (shallow,
      // exactly how the fold above merged it). The orb row authors 3 and
      // overrides to 4 at rank >= 2; the capture shows 4 pulses in 23 of 23
      // bursts at the evaluated rank.
      const pulses = Math.max(1, props.maxStacks ?? s.props?.status?.maxStacks ?? 1);
      // WHICH step each pulse plays is in the script, not the step list: the
      // onHit shape consumes a stack, then plays the loop step while stacks
      // remain and the last step once - so the loop step fires pulses-1 times
      // and the last exactly once. The last pulse can also carry a rider:
      //   var ctx = playStep(Steps.Last); if (rank >= R) ctx.dmgMult += N
      // and that += lands on the SkillContext's dmgMult, the SAME scalar
      // initVars@5150 seeds with the carrier's (1 + fervor + mastery) - the
      // live final/plain ratio across 297 players sits at 1.77-2.0, the
      // signature of +1 diluting inside that bracket, not a clean x2. The
      // rider rides `ctxDmgAdd` into castOutput's bracket for that reason.
      const sc = String(s.script ?? '');
      const split = new RegExp(
        'if\\s*\\(\\s*hasStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?' + s.id
        + '\\s*\\)\\s*\\)\\s*\\{\\s*playStep\\s*\\(\\s*Steps\\.(\\w+)\\s*\\)[\\s\\S]*?'
        + 'else\\s*\\{\\s*(?:var\\s+(\\w+)\\s*=\\s*)?playStep\\s*\\(\\s*Steps\\.(\\w+)\\s*\\)').exec(sc);
      const rider = split?.[2]
        ? new RegExp('if\\s*\\(\\s*rank\\s*>=\\s*(\\d+)\\s*\\)\\s*\\{\\s*'
          + split[2] + '\\.dmgMult\\s*\\+=\\s*([\\d.]+|vars\\.\\w+)').exec(sc)
        : null;
      const riderAdd = rider && rank >= Number(rider[1])
        ? (rider[2].startsWith('vars.') ? num(vars[rider[2].slice(5)]) : Number(rider[2]))
        : 0;
      if (split) {
        for (const e of effects) {
          if (e.kind !== 'Damage' && e.kind !== 'Heal') continue;
          if (e.stepId === split[1]) e.hits = (e.hits || 1) * Math.max(0, pulses - 1);
          else if (e.stepId === split[3]) {
            e.hits = e.hits || 1;
            if (riderAdd > 0) e.ctxDmgAdd = riderAdd;
          }
        }
      } else {
        // No readable guard shape: the even split, as before, stated not hidden.
        const pulseSteps = Math.max(1, (s.steps ?? [])
          .filter((x) => (stepOnNames[x.on ?? -1] ?? null) === 'Code' && (x.effects ?? []).length).length);
        for (const e of effects) {
          if (e.kind === 'Damage' || e.kind === 'Heal') e.hits = (e.hits || 1) * pulses / pulseSteps;
        }
      }
    }
    const periodic = (looping && !detector)
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
      // A row that IS a status prices as a status tick: no attacker
      // fervor/mastery bracket (the tick's SkillContext belongs to the
      // carrier). See castOutput.
      isStatusTick: !!s.props?.status,
      // WHETHER ITS TICKS CAN CRIT is a narrower rule than "it is a status",
      // and the model over-generalised it for its whole life. initVars@5150
      // zeroes ctx.critChance only for statuses whose statusType carries the
      // DoT or HoT flag - Bleed, Burn, Poison, Hemorage-via-parent,
      // HealOverTime - walked through the type's parent chain. Everything
      // else rolls the CARRIER's crit chance: PurgingStrikes crits at 11.6%
      // live, Demondash's aura at 12.7%, and the model priced both flat.
      // A Buff carried by its own caster ticks with the player's crit; a
      // status worn by the enemy ticks with the enemy's (~0), which is why
      // enemy-worn debuff steps still read as good as flat.
      tickCanCrit: !!s.props?.status
        && !(s.props.status.types ?? []).some((t) => statusTypeDotOrHot(t.type)),
      tickCarrierSelf: !!s.props?.status
        && (s.props.status.types ?? []).some((t) => t.type === 'Buff')
        && !(s.props.status.types ?? []).some((t) => t.type === 'Debuff'),
      // HOW the tick is fired decides which BY-TYPE crit bonus its roll
      // inherits. PurgingStrikes' status plays its damage step synchronously
      // inside onInflictDamage, gated on the swing being a base attack or the
      // combo finisher - the tick lands 0-1ms after the swing, in the swing's
      // hit context, so a talent that says "+8 crit on your attacks"
      // (ZealousFighter) prices the tick too. The status row's own cdb type
      // is undefined, so keying the bonus on it dropped the credit on the
      // floor: swings priced 15.5% crit, their ticks 7.5%, live both ~16%.
      // Read narrowly - the exact guard-then-playStep shape, nothing looser.
      tickOnSwing: (() => {
        if (!s.props?.status || !s.script) return null;
        const m = /function\s+onInflictDamage\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\.(isBaseAttack|isFinalCombo)(?:\s*\|\|\s*\1\.(isBaseAttack|isFinalCombo))?\s*\)\s*\{\s*playStep\s*\(/
          .exec(String(s.script));
        if (!m) return null;
        const flags = new Set([m[2], m[3]].filter(Boolean));
        if (flags.has('isBaseAttack') && flags.has('isFinalCombo')) return 'attack-or-combo';
        return flags.has('isFinalCombo') ? 'combo' : 'attack';
      })(),
      // The row's vars WITH every rankOverride the build's rank clears already
      // folded in, so a reader never has to remember to do it. `s.vars` is the
      // unresolved row and is the wrong thing to read at a rank.
      vars,
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
      runeDamage: runeDamage(s, rank, runes, vars),
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
      // Steps this cast does NOT play - see the note where they are collected.
      scripted,
    };
    profileCache.set(key, p);
    if (profileCache.size > 20000) profileCache.delete(profileCache.keys().next().value);
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
  //   * Physical and magical reduction are equal on every real foe EXCEPT the
  //     golems. Golem_Base declares an Armor multiplier of 1.6 and no
  //     MagicArmor, so all 17 golems are harder to hit than to burn - 0.4068
  //     against 0.30 off a W_Base parent, 0.4628 off a Unique one, 0.5161 off
  //     an Elite. The dev punching bags also split, deliberately
  //     (PunchingBagArmor is 0.5/0, PunchingBagMagicRes is 0/0.5).
  //     So ArmorPenetration and SpellPenetration are worth the same against
  //     everything in the game but golems, and against a golem physical
  //     penetration is worth materially more.
  //
  //     This paragraph used to say they were equal everywhere. That was an
  //     artefact of following only the first `inherit` entry, which found the
  //     archetype base and never Golem_Base.
  //   * `Armor_ExpectedReduction` (0.25) is well below what you actually fight.
  //     At level 25, 50% penetration is worth +14% damage against 0.25 and +25%
  //     against a 0.40 boss, so a reference target understates penetration by
  //     nearly half against the content that matters.
  const units = cdb.byId('unit');

  // A unit's effective `stats`, resolved the way the game resolves them.
  //
  // `DataCache.initUnits@18912` builds the closure at @18967 and runs it over
  // every unit row. That closure iterates EVERY entry of `inherit` (ops 12-17),
  // not just the first - and 305 of the 516 unit rows declare two or three.
  // The shape is consistently (archetype, species): Boar_Z2W_2 inherits
  // [W_Base, Boar_Z1W], so following only the first parent finds the world-trash
  // base and never the boar.
  //
  // Each parent is resolved first (op 51 recurses), then merged field-wise:
  //
  //   no matching attribute        -> deep-copy the parent's row      (ops 129-136)
  //   the child's row is a MODIFIER-ONLY stub - no value, no
  //   levelScaling, no specScaling - -> drop the stub, take the parent's
  //                                   row, and MULTIPLY the two
  //                                   multipliers together             (ops 137-171)
  //   otherwise                    -> the child's row stands, except
  //                                   that a null multiplier or
  //                                   levelMultiplier is filled from
  //                                   the parent                       (ops 179-192)
  //
  // Because the merge only ever fills what is still null, a child beats its
  // parents and an earlier `inherit` entry beats a later one.
  const statsCache = new Map();
  function mergedStats(id, seen = new Set()) {
    const hit = statsCache.get(id);
    if (hit) return hit;
    const u = units.get(id);
    if (!u) return [];
    // The game throws on a unit inheriting itself (ops 32-39). Cycles through
    // a longer path are not checked there and would hang here, so they stop.
    if (seen.has(id)) return (u.stats ?? []).map((s) => ({ ...s }));
    seen.add(id);

    const out = (u.stats ?? []).map((s) => ({ ...s }));
    for (const inh of u.inherit ?? []) {
      // A text-only parent contributes names and descriptions, never stats
      // (ops 52-57 jump past the whole numeric merge).
      if (inh?.textOnly) continue;
      if (!inh?.ref) continue;
      for (const ps of mergedStats(inh.ref, seen)) {
        const at = out.findIndex((x) => x.attribute === ps.attribute);
        if (at < 0) { out.push({ ...ps }); continue; }
        const existing = out[at];
        const modifierOnly = existing.value == null
          && (existing.levelScaling ?? []).length === 0
          && existing.specScaling == null;
        if (modifierOnly) {
          const copy = { ...ps };
          copy.multiplier = (ps.multiplier ?? 1) * (existing.multiplier ?? 1);
          if (copy.levelMultiplier == null && existing.levelMultiplier != null) {
            copy.levelMultiplier = existing.levelMultiplier;
          }
          out[at] = copy;
        } else {
          if (existing.multiplier == null && ps.multiplier != null) existing.multiplier = ps.multiplier;
          if (existing.levelMultiplier == null && ps.levelMultiplier != null) {
            existing.levelMultiplier = ps.levelMultiplier;
          }
        }
      }
    }
    seen.delete(id);
    statsCache.set(id, out);
    return out;
  }

  // ARMOUR IS A SUM OVER THE WHOLE INHERITANCE CLOSURE, not one nearest row.
  //
  // Re-derived 2026-08-11 from two independent fits plus an adversarial
  // judge, all three landing on the same law: a child's armour row does NOT
  // shadow its parent's - every reduction-carrying row in the closure
  // contributes red/(1-red) to the pool coefficient, and the pool is
  // S x (385 + 100 x spawnLevel). Nearest-row is refuted by the dungeon
  // ladder inversion (adds authored 0.25 taking LESS per hit than the boss
  // authored 0.30 - impossible under nearest-wins, exact under the sum:
  // Kobold_Z1D = 0.25/0.75 + inherited 0.30/0.70 = 0.762 vs Reblochonk's
  // bare 0.30/0.70 = 0.429) and by pooled log-SSE 14.4 vs 1.0 on 27 rows.
  //
  // A modifier-only stub (Golem_Base's Armor x1.6: no value, no scaling)
  // composes its multiplier onto the FIRST reduction-carrying row of its
  // attribute in merge order - the same attachment mergedStats performs -
  // which reproduces the previously verified golem number exactly for every
  // single-row family (m·r/(1-r) equals scaledReduction re-expressed) and
  // splits from x1.6-on-everything only on Golem_Z2W_E, flagged untested.
  function chainArmour(unitId) {
    const hit = chainArmourCache.get(unitId);
    if (hit) return hit;
    const rows = { Armor: [], MagicArmor: [] };
    const walk = (id, seen) => {
      const u = units.get(id);
      if (!u || seen.has(id)) return;
      seen.add(id);
      for (const s of u.stats ?? []) {
        if (s.attribute !== 'Armor' && s.attribute !== 'MagicArmor') continue;
        const red = s.attribute === 'Armor'
          ? s.specScaling?.armorReduction ?? null
          : s.specScaling?.magicReduction ?? null;
        const modifierOnly = s.value == null
          && (s.levelScaling ?? []).length === 0 && s.specScaling == null;
        rows[s.attribute].push({ red, mult: s.multiplier ?? null, stub: modifierOnly });
      }
      for (const inh of u.inherit ?? []) {
        if (inh?.textOnly || !inh?.ref) continue;
        walk(inh.ref, seen);
      }
    };
    walk(unitId, new Set());
    const sum = (fam) => {
      let stubMult = 1;
      for (const r of fam) if (r.stub && r.mult != null) stubMult *= r.mult;
      let S = 0;
      let first = true;
      let declared = false;
      for (const r of fam) {
        // A row authoring reduction ZERO (the Dummy's) still DECLARES the
        // family - the unit is a target that mitigates nothing, which is not
        // the same as a unit with no armour intent at all.
        if (!r.stub && r.red != null) declared = true;
        if (r.stub || !(r.red > 0)) continue;
        const m = (first ? stubMult : 1) * (r.mult ?? 1);
        S += (m * r.red) / (1 - r.red);
        first = false;
      }
      return { S, declared };
    };
    const p = sum(rows.Armor);
    const m2 = sum(rows.MagicArmor);
    const out = { physS: p.S, magS: m2.S, physDeclared: p.declared, magDeclared: m2.declared };
    chainArmourCache.set(unitId, out);
    return out;
  }
  const chainArmourCache = new Map();

  // What a unit actually mitigates: the summed coefficients, plus the
  // level-parity DISPLAY reduction S/(1+S) for humans and headers.
  function armourIntent(unitId) {
    const c = chainArmour(unitId);
    return {
      physS: c.physS, magS: c.magS,
      phys: c.physDeclared ? c.physS / (1 + c.physS) : null,
      mag: c.magDeclared ? c.magS / (1 + c.magS) : null,
    };
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

  // `level` is the ATTACKER's level; `targetLevel` is the level the foe
  // actually spawned at, and they are separate dials because the game's
  // formula uses both. getResistanceLevelScaling@20663 builds the resist POOL
  // from the authored reduction at the TARGET's level - R = red*(385+100*L)/
  // (1-red) - and getAffinityDamageReduction@4510 divides by 385+100*striker.
  // So "authored 0.40" only means 40% at level parity, which is the default
  // here because it matches every calibration to date, and because the boss
  // rows' own `lvl` column is contradicted by measurement: Ratsar's row says
  // 10, and inverting the clean magic channel of a real fight puts him at
  // ~18-25 - world bosses spawn at zone level, set by world data the model
  // does not read. A caller who knows the spawn level passes it.
  // Fitted spawn levels, per world family: parity (target = attacker) is
  // refuted in every boss window tested, and these are the joint fits with
  // their windows in MODEL.md. The zone level RE-ROLLS between dungeon runs
  // (9.7-12.5 observed), so --target-level always wins when given.
  const FITTED_LEVELS = [
    { re: /_Rift|^Ratsar$|Kobold_Ratsar/, level: 6.9, label: 'rift-R1 fit' },
    { re: /^Phrixes/, level: 7.9, label: 'arena fit' },
    { re: /_Z1D|^Reblochonk$/, level: 12, label: 'dungeon-Z1D fit (re-rolls 9.7-12.5 per run)' },
  ];
  function foe(name, level, targetLevel = null) {
    let S, label, unitId = null;
    const named = NAMED[name];
    if (named?.unit) {
      unitId = named.unit;
      const i = armourIntent(named.unit);
      S = { phys: i.physS, mag: i.magS };
      label = `${named.label} (${named.unit}: S ${i.physS.toFixed(2)}/${i.magS.toFixed(2)})`;
    } else if (named) {
      // The designers' own reference constant, still a single-row intent.
      S = { phys: named.phys / (1 - named.phys), mag: named.mag / (1 - named.mag) };
      label = `${name} (${named.label})`;
    } else if (targetsByUnit.has(name)) {
      unitId = name;
      const i = targetsByUnit.get(name);
      S = { phys: i.physS, mag: i.magS };
      label = `${name} (S ${i.physS.toFixed(2)}/${i.magS.toFixed(2)})`;
    } else {
      throw new Error(
        `unknown target "${name}". Named: ${Object.keys(NAMED).join(', ')}. ` +
        'Any unit id with a declared armour intent also works - see `bench targets`.'
      );
    }
    // Spawn level: explicit wins; a fitted world family beats the parity
    // guess; parity remains only for reference foes and the unfitted rest.
    let at = targetLevel;
    let lvlNote = targetLevel != null ? ` @L${targetLevel}` : '';
    if (at == null && unitId) {
      const fit = FITTED_LEVELS.find((f) => f.re.test(unitId));
      if (fit) { at = fit.level; lvlNote = ` @L${fit.level} (${fit.label})`; }
    }
    if (at == null) at = level;
    const [a, b] = ctx.consts.resistFormula;
    return {
      name: label + lvlNote,
      physReduction: S.phys / (1 + S.phys), magicReduction: S.mag / (1 + S.mag),
      level, spawnLevel: at,
      armor: S.phys * (a + b * at),
      magicArmor: S.mag * (a + b * at),
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
      // The script-side spelling of DamageTakenModifier: Death Mark's status
      // has no affix at all, just `dmg.dmgMult += 0.15` for the instigator's
      // hits while it is worn. Read by statusesOf into `scriptTaken`; folded
      // here exactly where an affix saying the same thing would land.
      if (d.scriptTaken) taken *= 1 + d.scriptTaken * (d.stacks ?? 1);
    }
    return { armor: Math.max(0, armor), magicArmor: Math.max(0, magicArmor), taken: Math.max(0, taken) };
  }

  function mitigate(effect, sheet, target, foe = NO_DEBUFF, mods = NO_MODS, attackerLevel = null) {
    const aff = affinityOf(effect.affinity);
    // Raw bypasses EVERYTHING on the receiving side too: computeDamage@4841
    // ops 83-87 skips DamageTakenModifier for the Raw affinity and
    // getAffinityDamageReduction@4510 returns 0 outright.
    if (aff.root === 'Raw') return 1;
    if (!aff.resist) return foe.taken;
    const resist = (aff.resist === 'MagicArmor' ? target.magicArmor * foe.magicArmor : target.armor * foe.armor);
    // `armorIgnore` is NOT penetration by another name. Exposed Essence ignores
    // 5% of a bleeding enemy's armour on its own multiply, and penetration
    // takes its cut of what is left - getAffinityDamageReduction@4510 reduces
    // the pool at ops 133-147 (physical) or 80-95 (magic) and again at ops
    // 259-263, each with its own clamp. Adding them into one lever overstates
    // damage by 2-3% wherever a build carries both.
    const ignoreRatio = mods.armorIgnore?.[aff.root] ?? 0;
    const pen = aff.pen ? (sheet.get(aff.pen) ?? 0) : 0;
    const red = damageReduction({
      resist,
      penetrationPct: pen,
      ignoreRatio,
      // The STRIKER's level feeds the divisor (getAffinityDamageReduction@4510
      // op 237), not the target's. Identical at level parity - every reference
      // foe sits at the character's level - and wrong off-level.
      attackerLevel: attackerLevel ?? target.level,
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
    let hitCount = 0, hitCountPhysical = 0;
    let critPhysical = 0, critMagic = 0;
    let totalPhysical = 0, totalMagic = 0;
    // The crit decomposition, so a rolled fight can roll the crit instead of
    // taking its mean. `damage` above stays the EXPECTED value, which is what
    // every deterministic path reads; this is the extra information a die needs.
    //
    // Everything on this cast shares one crit chance and one crit multiplier -
    // the category bonuses are keyed on `prof`, not on the effect - so the whole
    // cast decomposes as `fixed + base x (1 + p(cd-1))`, and rolling k crits out
    // of n independent hits gives `fixed + base x (1 + (k/n)(cd-1))`. The mean of
    // that over the binomial is exactly `damage`, which is the property that
    // lets --fights report a spread without moving the answer.
    const critRoll = {
      p: 0, cd: 1, hits: 0,
      base: 0, basePhysical: 0, baseMagic: 0,
      fixed: 0, fixedPhysical: 0, fixedMagic: 0,
    };
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
      // WHICH scaling channel this effect's attributes read is per-effect,
      // because Raw is priced pure: the Raw-affinity weapon-granted tick
      // (Daggers_DuplicatePoison_Skill1_Status) lands at exactly the whole
      // attribute live - 4 x Dex 166 - where the mix would say 159.
      const effRoot = affinityOf(e.affinity).root;
      const mixFlats = opts.weaponMix?.ids?.has(prof.id) ? opts.weaponMix.flats
        : (effRoot !== 'Raw' && opts.tickScaling?.mixIds?.has(prof.id)) ? opts.tickScaling.flats
          : null;
      // The TRINKET channel, measured on Trinket_Demon_Status to the integer
      // over 2,407 rows: a status granted by a non-weapon item ticks its
      // authored amount IN FULL every tick (the capture's three equal pulses
      // per application), priced off the standing weaponless floored
      // primaries rather than the combat sheet. The spread division below is
      // undone by counting the ticks back in, and the basis map is fixed at
      // the resting build so buffed application states cannot reprice it.
      const standing = opts.tickScaling?.standingIds?.has(prof.id) ? opts.tickScaling.standing : null;
      const priceSheet = standing ? { get: (k) => standing.get(k) ?? sheet.get(k) } : sheet;
      const spreadUndo = standing && e.spread ? Math.max(1, e.ticks ?? 1) : 1;
      const raw = amountOf(e, priceSheet, opts.swingAttrs ?? null, mixFlats)
        * (e.hits ?? 1) * spreadUndo;
      if (!raw) continue;
      // Only an Area or Aura step reaches the crowd, and `props.hitCount` is a
      // target cap when the row sets one. `ignoreMainTarget` takes the enemy
      // you hit out of the count, so at one target such a step lands on nobody.
      // The caps compose in the game's own order: the shape's own hitCount
      // first, then the proportion strategy over what the sweep kept, then the
      // main target is taken out of the count.
      let targets = 1;
      if (e.area) {
        let n = Math.min(wantTargets, e.area.maxTargets ?? Infinity);
        const p = e.area.hitStrategy?.case === 'Proportion' ? e.area.hitStrategy.args.prop : null;
        if (p != null) n = Math.ceil(n * Math.min(1, Math.max(0, p)));
        // A position-cast area is anchored to the ground - the aim target
        // standing in it is hit like anyone else, whatever the row authors.
        targets = Math.max(0, n - (e.area.ignoreMainTarget && !e.atPosition ? 1 : 0));
      }
      // A script rider whose site guards `target != ctx.aimTarget` lands only
      // on targets other than the one aimed at - none against a lone dummy.
      // (At several targets this clamps to the non-area single-hit count and
      // under-credits the splash; the flag rides area steps too when one
      // appears, and until then the single-target case is the verified one.)
      if (e.notAimTarget) targets = Math.max(0, Math.min(targets, wantTargets - 1));
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
        // A SKILL'S OWN SCRIPT RIDERS, read off its `onDamageEval` /
        // `onInflictDamageEval` body. `opts.gates` says which live-state guards
        // hold; a gate with no answer is worth nothing rather than a guess.
        // The three the capture proved live are all here: the combo's +20% vs
        // a bleeding target, Bonethrow's rank-3 +20% crit damage, and
        // Domination's +25% inside a stun window.
        const gateOn = (g) => g == null || (opts.gates?.[g] ?? 0) > 0;
        const gateVal = (g) => (g == null ? 1 : (opts.gates?.[g] ?? 0));
        let scriptCritDmg = 0;
        for (const rd of prof.runeDamage ?? []) {
          if (rd.field !== 'critDmgMult') continue;
          if (rd.singleTarget && wantTargets !== 1) continue;
          if (!gateOn(rd.gate)) continue;
          scriptCritDmg += rd.amount * gateVal(rd.gate);
        }
        // A swing-triggered status tick rolls inside the swing's hit context,
        // so its by-type key is the SWING's category, not the status row's
        // (which has none - `cat` is null for every status row). ZealousFighter
        // writes its +8 under both Attack and AttackCombo, so either key pays.
        const tickCat = prof.isStatusTick === true && prof.tickOnSwing
          ? (prof.tickOnSwing === 'combo' ? 'AttackCombo' : 'Attack')
          : cat;
        const critBonus = (mods.critDamageByType?.[tickCat] ?? 0) + scriptCritDmg;
        const chanceBonus = mods.critChanceByType?.[tickCat] ?? 0;
        // WHICH status ticks crit is the statusType's DoT/HoT flag, not the
        // fact of being a status: initVars@5150 zeroes ctx.critChance only for
        // flagged types, and everything else rolls the CARRIER's chance
        // (criticalRoll@6211). A self-carried Buff aura ticks with the
        // player's crit; an enemy-worn status ticks with the enemy's, which
        // against a dummy is as good as none. A talent that gives a bleed its
        // own crit chance is a script hook and rides poolScale, not this path.
        const rawAff = aff.root === 'Raw';
        const statusTick = prof.isStatusTick === true;
        const tickCrits = statusTick && prof.tickCanCrit === true && prof.tickCarrierSelf === true;
        const localCrit = statusTick && !tickCrits ? 1
          : (critBonus || chanceBonus)
            ? 1 + Math.min(1, critChance + chanceBonus)
              * ((sheet.get('CritDamage') ?? 100) / 100 + critBonus - 1)
            : critMult;
        // Raw damage bypasses every global multiplier: getDamageScale@5146
        // returns 1 for Raw before fervor, mastery or DamageModifier enter.
        let m = (rawAff ? 1 : dmgMod) * localCrit * mitigate(e, sheet, target, foe, mods, opts.attackerLevel ?? null);
        // EVERY dmgMult RIDER SUMS INTO ONE BRACKET. They used to compound, one
        // multiplication per line. `computeDamage@4841` (Unit.hx:2000-2031) op 8
        // runs the hooks, op 14 seeds `modMult` from `hitData.dmgMult` - a
        // single scalar that starts at 1 and that every rider only ever `+=`s -
        // and op 165 applies it once. Two +20% riders give x1.40, not x1.44.
        //
        // Measured three ways in the 2026-08-02 v2 capture: the one
        // deterministic double-rider hit (Rage Strike 352 under Berserk and
        // Domination) fits 1 + 0.20 + 0.25 = 1.45 to -0.23% where 1.20 x 1.25
        // misses by +3.2%; a 42-hit least-squares prefers additive at rms 0.26%
        // over 0.66%; and Berserk-added-INTO-the-fervor-bracket is excluded by
        // the GA ratio window [1.1903, 1.1954].
        //
        // A scoped damage bonus: by affinity (Magic Conduction), by skill type
        // (a weapon-skill bonus), or across the board.
        let riders = 0;
        for (const rd of prof.runeDamage ?? []) {
          if (rd.field === 'critDmgMult') continue;   // handled at `critBonus`
          if (rd.singleTarget && wantTargets !== 1) continue;
          if (!gateOn(rd.gate)) continue;
          riders += rd.amount * gateVal(rd.gate);
        }
        riders += (mods.damageByAffinity?.[aff.root] ?? 0)
          + (mods.damageByAffinity?.all ?? 0)
          + (prof.type === "WeaponSkill" ? (mods.damageByAffinity?.WeaponSkill ?? 0) : 0);
        // BASIC attacks only. `isBasicAttack` is skill types Attack..Attack4
        // (BaseSkill.isBasicAttack@6045) and the combo finisher is AttackCombo,
        // a type outside that set - so a rider that says "your basic attacks"
        // must not reach the swing that ends the chain. `prof.isFiller` is the
        // wrong test here: it covers the finisher too.
        if (mods.basicAttack && /^Attack[234]?$/.test(prof.type ?? '')) riders += mods.basicAttack;
        // The behind perks land in the same additive bracket the game uses -
        // `hit.dmgMult +=` into computeDamage's one modMult scalar - already
        // scaled by the assumed behind-fraction at the engine.
        if (mods.basicAttackBehind && /^Attack[234]?$/.test(prof.type ?? '')) riders += mods.basicAttackBehind;
        // A talent rider naming this one skill (Authority's +20% on Smite),
        // and the owner-carried-tick rider (Radiance's +25%) on self-worn
        // status ticks. Same additive bracket as every other hook.
        riders += mods.bySkill?.[prof.id] ?? 0;
        if (statusTick && prof.tickCarrierSelf === true) riders += mods.ownStatusTick ?? 0;
        // The detector's last-pulse `ctx.dmgMult += 1` sums HERE, with the
        // hook riders: the live final/plain ratio is 2.25/1.25 on a build
        // whose only other rider is Radiance's 0.25 - the +1 and the talent
        // share one bracket, and the carrier's fervor bracket cancels out of
        // the ratio entirely.
        riders += e.ctxDmgAdd ?? 0;
        m *= 1 + riders;
        // Fervor and the matching mastery share ONE additive bracket -
        // getDamageRatio@4505: (1 + fervor + mastery) x DamageModifier - and
        // it belongs to the CARRIER: initVars@5150 seeds every SkillContext's
        // physical/magicDmgMult from the status's owner. For a status the FOE
        // wears, the carrier is the foe and the bracket is as good as 1 - the
        // exclusion this branch always priced. But a self-carried Buff's
        // carrier is the player, and the player's own fervor and mastery ride
        // every tick: Demondash's aura reads x1.27 live against the bare
        // model, and the flat-1.27 was state-independent across sessions -
        // the same over-generalisation the tick-crit rule had, fixed the same
        // way, keyed on the same flag.
        if (!rawAff && (!statusTick || prof.tickCarrierSelf === true)) {
          const fervorAdd = fervorHere ? fervor : 0;
          const masteryAdd = opts.assume.mastery
            ? (aff.root === 'Physical' ? physMastery : aff.root === 'Magic' ? magicMastery : 0)
            : 0;
          m *= 1 + fervorAdd + masteryAdd;
        }
        damage += raw * m * targets;
        singleTargetDamage += raw * m;
        // HOW MANY DAMAGE EVENTS this cast produces, which is what a damage
        // meter counts and what the capture logs a row for. `critRoll.hits` is
        // not it: that one only counts CRITTABLE hits, so a status tick - which
        // can never crit - contributes nothing to it. A SPREAD channel logs
        // one row per tick - RayOfSpark's cast is four 84s, not one 368 - so
        // its event count is the tick count, not the effect's single "hit".
        hitCount += (e.spread ? Math.max(1, e.ticks ?? 1) : (e.hits ?? 1)) * targets;
        // Physical, non-tick events specifically: that is what a stack counter
        // keyed on `!dmg.isDoT && dmg.isPhysical` arms on.
        if (aff.root === 'Physical' && !statusTick) hitCountPhysical += (e.hits ?? 1) * targets;
        // Split this effect into the part a die can move and the part it
        // cannot. `localCrit` is 1 for a status tick, which is exactly the
        // "cannot" case, so the test is the multiplier itself.
        {
          const whole = raw * m * targets;
          const base = localCrit > 0 ? whole / localCrit : whole;
          if (localCrit > 1) {
            critRoll.p = Math.min(1, critChance + chanceBonus);
            critRoll.cd = (sheet.get('CritDamage') ?? 100) / 100 + critBonus;
            critRoll.hits += e.hits ?? 1;
            critRoll.base += base;
            if (dmgMod > 0) {
              if (aff.root === 'Physical') critRoll.basePhysical += base / dmgMod;
              else if (aff.root === 'Magic') critRoll.baseMagic += base / dmgMod;
            }
          } else {
            critRoll.fixed += whole;
            if (dmgMod > 0) {
              if (aff.root === 'Physical') critRoll.fixedPhysical += whole / dmgMod;
              else if (aff.root === 'Magic') critRoll.fixedMagic += whole / dmgMod;
            }
          }
        }
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
    return {
      damage, heal, shield, singleTargetDamage, gains,
      hits: hitCount, hitsPhysical: hitCountPhysical,
      critPhysical, critMagic, totalPhysical, totalMagic,
      critRoll: critRoll.hits > 0 ? critRoll : null,
    };
  }

  /**
   * The same cast with its crits ROLLED rather than averaged.
   *
   * `--fights N` exists to say how much of a build's damage is luck, and until
   * now the only die in the fight was the ±10% on a plain swing: crit stayed at
   * its expectation, so a crit-bleed build - the one whose whole damage profile
   * is "did the crit land" - reported a spread of almost exactly zero. That read
   * as a claim about the build and was a fact about the model.
   *
   * One roll per hit, at the cast's own crit chance. The mean over the binomial
   * is the deterministic value, so nothing about the default answer moves.
   */
  function rollCrit(out, rand) {
    const c = out.critRoll;
    if (!c || !(c.hits > 0) || !(c.cd > 1) || !(c.p > 0)) return out;
    let k = 0;
    for (let i = 0; i < c.hits; i++) if (rand() < c.p) k++;
    const share = k / c.hits;
    const mult = 1 + share * (c.cd - 1);
    const damage = c.fixed + c.base * mult;
    // What fed a pool has to follow the same die. Hemorrhage takes 35% of every
    // physical CRITICAL strike, so a fight that rolled no crit this swing must
    // feed it nothing - averaging the feed while rolling the damage would put
    // the spread back where it was.
    const critPhysical = c.basePhysical * share * c.cd;
    const critMagic = c.baseMagic * share * c.cd;
    return {
      ...out,
      damage,
      singleTargetDamage: out.damage > 0 ? out.singleTargetDamage * (damage / out.damage) : out.singleTargetDamage,
      critPhysical,
      critMagic,
      totalPhysical: c.fixedPhysical + c.basePhysical * mult,
      totalMagic: c.fixedMagic + c.baseMagic * mult,
    };
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
      // A talent scoped to a status TYPE reaches an authored dot too, not only
      // a pool one. `Bloodletting` is +10% on anything ticking and
      // `Lethal Dose` +10%/+20% on anything typed Poison; both were computed,
      // matched against the pool dots, and then never offered to the dots the
      // fight actually schedules. The match walks the statusType parent chain,
      // so a Bleed guard covers a Hemorage dot and not the other way round.
      // ...but not a RAW one. Raw bypasses the pipeline those hooks ride -
      // getDamageScale@5146 returns 1 for Raw before any modifier enters -
      // and the capture agrees twice over: Trinket_Demon_Status ticks a
      // constant 45.00 through the whole rotation and DuplicatePoison's
      // Skill1 status exactly the whole attribute, both Poison-typed, both
      // with poison-scoped talents ranked on the build.
      const dmgEffects = (d.prof.effects ?? []).filter((e) => e.kind === 'Damage');
      const rawOnly = dmgEffects.length > 0
        && dmgEffects.every((e) => affinityOf(e.affinity).root === 'Raw');
      let m = 1, critCh = 0;
      if (!rawOnly) for (const mod of dotScoped) {
        if (!coveredBy(mod.statusType, d.types)) continue;
        if (mod.field === 'dmgMult') m += mod.amount;
        else if (mod.field === 'critChance') critCh += mod.amount;
      }
      // A tick cannot crit on its own (initVars@5150 zeroes it); a talent that
      // gives it one is a script hook, and this is where it lands.
      if (critCh > 0) m *= 1 + critCh * ((sheet.get('CritDamage') ?? 100) / 100 - 1);
      return { damage: (whole.damage / ticks) * m, heal: whole.heal / ticks };
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
      // The plan can know a cap the sheet cannot: the Combo Ruler mastery's
      // permanent State carries a MaxComboPoint affix that exists only while
      // the status instance does, so no sheet the model builds ever holds it.
      // The larger of the two wins - a sheet that already reads the full cap
      // is not bumped twice.
      const override = rotation.resources?.capOverride?.[atb] ?? 0;
      const max = a.maxAtb ? Math.max(sheet.get(a.maxAtb) ?? 0, override) : Infinity;
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
    // The same list, seen from the authored-dot side. `dotOutput` reads it (it
    // is a closure and `simulate` runs after every const here is bound).
    const dotScoped = bleedScoped ?? [];
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
      rotation, cast, dotOutput, rollCrit, cdr, cdrWeaponSkill, resources, poolMultiplier,
      sparkGauge: rotation.sparkGauge ?? null,
      poolScale: bleedScoped ? poolScale : null,
      poolFactor,
      goal: live?.goal ?? null,
      chainResets: opts.assume?.chainResets ?? true,
      empowerments: opts.empowerments ?? [],
      // Priced with the sheet, so the profile and its output are resolved here
      // and the sim only has to multiply by the count it measured.
      stackProcs: (opts.stackProcs ?? []).map((sp) => {
        const prof = profile(sp.skill, opts.rank ?? 1);
        return prof
          ? { ...sp, prof, out: castOutput(prof, sheet, target, opts, NO_DEBUFF, live?.mods ?? NO_MODS) }
          : sp;
      }).filter((sp) => sp.prof),
      // A mark's lump is the STATUS row's scripted step, priced with the
      // status-tick conventions its wearer dictates: an enemy-worn Debuff, so
      // no crit and no carrier bracket - the capture's 51 rows are one
      // constant integer with zero crits.
      markProcs: (opts.markProcs ?? []).map((mp) => {
        const sp = profile(mp.status, opts.rank ?? 1);
        const step = (sp?.scripted ?? []).find((x) => x.stepId === mp.step);
        if (!sp || !step?.effects?.length) return mp;
        const prof = {
          ...sp, effects: step.effects,
          occupancy: 0, cooldown: 0, charges: 1, costs: [], isFiller: false, isCombo: false,
          scripted: [],
        };
        return { ...mp, prof, out: castOutput(prof, sheet, target, opts, NO_DEBUFF, live?.mods ?? NO_MODS) };
      }).filter((mp) => mp.prof),
      comboWindow: cdb.byId('constant').get('ComboWindow')?.v?.float ?? 0.6,
      swingVariance: cdb.byId('constant').get('WeaponAttack_RandomRange')?.v?.float ?? 0.1,
      poolHealShare: bleedMods.healShare ?? 0,
      critChance: Math.min(1, Math.max(0, (sheet.get('CritChance') ?? 0) / 100)),
      timedBuffs: live?.timedBuffs ?? [],
      fight: opts.fight ?? 200,
      chainFeeds: opts.chainFeeds ?? [],
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
    // Resilience multiplies what a hero takes from anyone but themselves -
    // computeDamage@4841 ops 102-146 - and it was missing here.
    const resil = 1 - (sheet.get('Resilience') ?? 0) / 100;
    const takenPhys = Math.max(1e-6, (1 - phys) * dtm * resil);
    const takenMagic = Math.max(1e-6, (1 - magic) * dtm * resil);
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
    // READ FROM THE BYTECODE (getStepEffectItemScaling@20780 / fn@20784, HSkill.hx): the flat is
    // 0.4 x the SUM over the item's aptitudes of each aptitude's primary
    // budget at the ITEM's own level. No handedness factor exists anywhere in
    // the damage path - the measured 1H/2H asymmetry is the authored per-type
    // swing ratios (Axe 0.13, GreatAxe 0.7, GreatSword 0.95, DualSwords
    // 0.205...) times the aptitude count (dual-aptitude one-handers sum two
    // budgets). The 0.4 is `WeaponPowerRatio.MainhandWeaponSkill`, clamped in
    // getStepEffectScaling@20778, and rarity/stars/iLevel bonuses never enter
    // (fn@20784 consumes only aptitudes, atbScaling bounds and item level).
    // Every measured tooltip flat reproduces: Beefury 13 = 0.13 x 0.4 x
    // (123.6+123.6), Wingsabers 22 = 0.205 x 0.4 x (123.6+148.3), Judgement
    // 0.4 x 123.6. The attribute half - the MEAN of the item's aptitude
    // primaries - is added at consumption in amountOf.
    let sum = 0;
    for (const aptId of item.aptitudes ?? []) {
      const a2 = cdb.byId('aptitude').get(aptId);
      const p2 = (a2?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0);
      if (p2) sum += budget(loadout.level, p2.start, p2.end, ctx.consts.earlyMaxLevel);
    }
    // No aptitudes, no WeaponPower - the sum IS the formula. The old fallback
    // substituted the class primary's budget and handed a butterfly net the
    // exact WeaponPower of a Legendary greatsword (0.4 x 123.6 = 49.43, found
    // by pinning Net_Basic as mainhand and reading the sheet). fn@20784
    // consumes only the item's own aptitudes; an empty list sums to zero.
    return 0.4 * sum;
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
    { severity: 'verified', what: 'Fervor and the matching mastery share ONE additive bracket, on everything except Raw damage and status ticks',
      why: 'Read from getDamageRatio@4505: ratio = (1 + fervor + mastery) x DamageModifier - additive ' +
           'with each other, multiplicative with the rest - applied to every affinity except Raw ' +
           '(getDamageScale@5146 returns 1 outright) and never to a status tick, whose SkillContext ' +
           'belongs to the CARRIER (initVars@5150). Also measured live: finisher 133 -> 151 = ' +
           'x(1 + 0.12 + 0.0158) exactly. --fervor-scope and --no-mastery remain as toggles.' },
    { severity: 'verified', what: 'WeaponPower = 0.4 x the SUM of the item\'s aptitude primary budgets at the item\'s level, plus the MEAN of those attributes',
      why: 'Read from the bytecode (getStepEffectItemScaling@20780, fn@20784, convertWeaponPowerScaling@20782): no handedness factor ' +
           'exists anywhere in the damage path - the measured 1H/2H asymmetry is the authored per-type ' +
           'swing ratio (Axe 0.13, DualSwords 0.205, GreatAxe 0.7, GreatSword 0.95) times the aptitude ' +
           'count, since a dual-aptitude one-hander SUMS two budgets where Judgement has one. The 0.4 ' +
           'is WeaponPowerRatio.MainhandWeaponSkill, every weapon type inherits MainhandWeapon, and ' +
           'rarity/stars/iLevel bonuses never enter the flat. Every measured tooltip reproduces: ' +
           'Beefury 13 = 0.13 x 0.4 x (123.6+123.6), Wingsabers 22 = 0.205 x 0.4 x (123.6+148.3). ' +
           'The level is the gear row\'s own - assumed equal to yours for an unpinned item.' },
    { severity: 'verified', what: 'a weapon skill\'s attribute scaling is 60% attribute + 40% of that attribute\'s own budget curve - from either hand',
      why: 'Read from getStepEffectItemScaling@20780 and getStepEffectScaling@20778: itemRatio = ' +
           'WeaponPowerRatio.MainhandWeaponSkill (0.4) for every weapon, the attribute keeps ' +
           '1 - 0.4, and the flat is that attribute\'s own budget at the item\'s level. The gate is ' +
           'isWeaponBased@6057 - a set of skill TYPES with no slot check - so the ARSENAL\'s weapon ' +
           'skills mix identically and class skills (type 9) stay pure attribute. Ten measured ' +
           'integers reproduce (Rampage 233/371/556, Brutal Frenzy 133 + 28, Tear 75 through ' +
           'Dexterity\'s own 148.3 curve), and the expanded tooltips render the rule outright.' },
    { severity: 'verified', what: 'an item pays every aptitude it names, each divided by how many it names',
      why: 'Read off the character sheet and then off three tooltips. A Warrior equipping Cheese Moon ' +
           '(Fighter+Assassin) receives BOTH primaries - +15 Strength from the Fighter row and +18 ' +
           'Dexterity from the Assassin one - so the old own-half rule was wrong. But each row is ' +
           'DIVIDED by item.aptitudes.length, so a line both aptitudes carry is paid ONCE at their ' +
           'mean rather than summed: what the second aptitude buys is its own primary, not a doubled ' +
           'shared stat. The model summed them and read double on every dual-aptitude item in the ' +
           'game. Armour is the same rule with one extra twist - it resolves the ITEM\'s aptitude ' +
           'mean, not the wearer\'s: a Fighter+Cleric belt reads 158 Armor on a Warrior, which is ' +
           '0.325, where the Warrior\'s own 0.4 would read 219. Generic jewellery still pays exactly ' +
           'one named row.' },
    { severity: 'verified', what: 'the gear bake, landed: gear ratio, aptitude divisor, and the item\'s own armour mean',
      why: 'generateItemAffixes@20747 (HItem.hx:349-499) read end to end and now implemented. Three ' +
           'terms were missing and they only reconcile TOGETHER - each alone makes the other two look ' +
           'wrong, which is why a first attempt at the gear ratio by itself was reverted. (1) The ' +
           'level curve runs a SECOND time on GearStatsRatio_Scaling_Bounds (0.5 -> 0.9) and ' +
           'multiplies every row not flagged gearOnly; armour and the ratings ARE gearOnly, which is ' +
           'what lets them pin an item\'s level independently of the term under test. (2) Every row ' +
           'is divided by the number of aptitudes the ITEM names. (3) Armour takes the item\'s ' +
           'aptitude mean. And the level is a drop at YOUR level, not the authored row level: a ' +
           'Cheese Moon photographed in game is "Axe Level 25" with three stars, iLevel 290. ' +
           'MEASURED against one level-25 Warrior in four equip states, three items, twelve integers, ' +
           'all exact: GS_Nova Rare 0-star (1 aptitude) +25 Str / +32 Vit / +69 Crit; ' +
           'Waist_RDemon_FigCle (2 aptitudes) +4 Str / +4 Faith / +8 Vit / 158 Armor; Axe_Boomerang ' +
           'Rare 3-star (2 aptitudes) +36 Vit / +15 Str / +18 Dex / +39 Crit / +39 ArPen - with the ' +
           'naked control, which contains no item at all, still exact on all sixteen attributes. On ' +
           'the fully geared character the sheet went from Vit 226 / Armor 1576 to the measured ' +
           'Vit 213 / Armor 1949. Still open from the same trace: the Uncommon statGroup rules ' +
           '(Vitality dropped off a dual-aptitude Uncommon, Primary off a single-aptitude one), which ' +
           'no measurement here touches.' },
    { severity: 'verified', what: 'a damage-over-time ticks once per stack, and the count is live',
      why: 'Read from getStackFactor@20772, which runs as the LAST line of getStepEffectVal@20775 - ' +
           'after the scaling, after the spread division, after the damage variance - and multiplies ' +
           'the value by Status.stacks whenever the running skill is a Status that is EITHER a DoT ' +
           '(its statusType, or an ancestor of it through the parent chain, carries the DoT flag) OR ' +
           'carries the ScaleWithStacks effect flag. It is an OR evaluated once, so a status that is ' +
           'both - Daggers_Demondash_Passive_Status is typed Burn AND flagged - is multiplied exactly ' +
           'once. The count is READ AT EVERY TICK, so the per-tick value snapshots and the multiplier ' +
           'does not. The cap comes off getMaxStacks@14459: props.status.maxStacks, DEFAULT 1 rather ' +
           'than unlimited, replaced by any props.rankOverride at or below the applying skill\'s rank, ' +
           'plus one script path (Lethal Poison reads getStatusMaxStacks(b) = b + ' +
           'getTalentRank(Rogue_Talent_ImprovedMixture)). Applications add exactly one stack - ' +
           'props.status.stacks is authored on none of the 100 Status steps - and nothing decrements a ' +
           'stack on a timer: the whole status expires at once. Five stacks of Lethal Poison were ' +
           'being priced as one, which is where the Rogue\'s 324 -> 385 came from.' },
    { severity: 'assumption', what: 'an UNCAPPED stacking dot is held at one stack, and named',
      why: 'maxStacks <= 0 means uncapped (seven rows author -1), and over a 200-second fight an ' +
           'every-swing application would reach two hundred stacks and print a number that grows with ' +
           'the fight length rather than with the build. Every uncapped dot in the sheet today is a ' +
           'POOL dot, whose fed/owed ledger already IS the stack count expressed as damage, so nothing ' +
           'is currently scored at the floor - but the guard is there and it says so by name rather ' +
           'than letting the multiplier run. The same -1 used to reach the affix scale through a bare ' +
           '`?? 1`, i.e. a buff worth MINUS its own value; only a foe status carries affixes among the ' +
           'seven, so nothing was visibly wrong, which is the kind of bug that waits for a patch.' },
    { severity: 'verified', what: 'a weapon-upgrade script proc can be read - the double-attack one is',
      why: 'Twelve of the twenty `<Type>_Upgrade` rows carry a script instead of affixes and were refused ' +
           'wholesale. One shape among them is entirely in the data: GreatSword_Upgrade is vars.chance ' +
           '0.04 and `onSkillProc(ctx) { if (ctx.skill?.isBasicAttack() && checkProba(vars.chance)) ' +
           'ctx.skill.playStep(null, ctx.skill.getExecStep().index, ...); }` - replaying the executing ' +
           'step IS the hit again, so the whole payload is x(1 + chance) on basic attacks. ' +
           '`isBasicAttack` is skill types Attack..Attack4 (BaseSkill.isBasicAttack@6045), which EXCLUDES ' +
           'the combo finisher, so the rider must not reach the swing that ends the chain - `isFiller` ' +
           'would have, since it covers the finisher too. None of these rows carries a cooldown and none ' +
           'uses the game\'s internal-cooldown idiom, so the rate is plain Bernoulli with nothing to ' +
           'saturate. The upgrade RANK is the star count, not the rarity index: Staff_Upgrade at ' +
           'minRank 3 is CooldownReduction +4, and a real 3-star Censer tooltip reads "Cooldown ' +
           'Reduction increased by 4%".' },
    { severity: 'verified', what: 'what you socket raises the host item\'s gear level',
      why: 'Read from Gear.getILevel@8123 (src/st/item/Gear.hx:48-51), which is three lines: the base ' +
           'iLevel plus the rarity bonus (and the flawless bonus, in Item.getILevel@7787), then ' +
           'round(upgradeLevel x Item_GearUpgradeILevelBonus) for the stars, then - the line nothing ' +
           'read - `for (s in this.slots) lvl += Data.item.byId.get(s)?.iLevel ?? 0`. Every socketed ' +
           'item adds its OWN iLevel to the host. Twelve items in the game do it and they are all ' +
           'AugmentDemon: the EPIC Corrupted Gifts declare iLevel 10, so socketing one is worth a ' +
           'whole effective level of stats on top of the affixes it swaps - every line on the weapon ' +
           'moves, including the ones the gift does not mention. The RARE Corrupted Gifts declare no ' +
           'iLevel, and neither does any enchant, jewel or sigil, so those add nothing. Reported from ' +
           'play ("using a demonic gift on a weapon slightly increases its stats") before the code was ' +
           'read, and worth 1-2% on all four baselines because the search already takes the Epic gift.' },
    { severity: 'verified', what: 'a conduit fires when Spark is spent from above the gauge, and they all fire together',
      why: 'Read from Mage_Conduit_SparkBounds ([0.5, 0.5, 0.5], and the test is `bound < ratio`, so ' +
           'all three tiers are the same number and the Low/Medium/High tiering is inert): a conduit ' +
           'fires when Spark is SPENT while the pool BEFORE the spend was strictly above half of ' +
           'MaxSpark, and every equipped conduit fires at once - so conduit damage is a SUM over the ' +
           'ones you slotted. The model used to refuse all of them as "no trigger rate can be derived ' +
           'from the data"; it was derivable, and it needed the Spark pool simulated rather than a ' +
           'rate invented. "One per weapon skill" would have been badly wrong: in-combat regen is ' +
           '0.65/s against roughly 5/s of spend, so a full pool buys a handful of triggers and the ' +
           'gauge then sits under the threshold for the rest of the fight. MEASURED IN GAME ' +
           '2026-08-02 on a naked Censer Mage, both halves of it: starved of Spark, Conduit: Power ' +
           'stacked to exactly FIVE and stopped - 100/90/80/70/60 are above 50 and the sixth spend ' +
           'starts at 50, which is not - and fed Spark it reached the full twenty for +10% ' +
           'MagicMastery. The threshold is exact to the integer. The finisher\'s flat 10 ' +
           '(Mage_Spark_SpellCDCost_FinalCombo) is spent but still does not GATE the chain.' },
    { severity: 'verified', what: 'a proc-applied buff that blocks its own renewal never saturates',
      why: 'StoneOfPower rolls `checkProba(vars.chance) && !owner.hasStatus(<the status this very call ' +
           'applies>)` on every damage instance you deal. That guard is not a question about live ' +
           'state - it is the applier declining to renew its own buff - so the buff is an ALTERNATING ' +
           'RENEWAL process: on for its whole duration, then off until the next success, uptime ' +
           'rD/(1+rD). At one damage instance a second that is 34%, at five it is 72%, and it never ' +
           'reaches the cap. A refresh-and-stack buff is 1-e^(-rD) instead, which does saturate; ' +
           'reading one as the other is a third of the answer. Read as unreadable, all four trinket ' +
           'Stones scored exactly ZERO. Both closed forms are Monte-Carlo checked against the game\'s ' +
           'own addStacks/refresh semantics. They are applied as closed forms rather than as events in ' +
           'the fight on purpose: the fight thins applications evenly, one every 1/p events, and even ' +
           'spacing is not a renewal process - for a blocked buff whose duration sits near the mean ' +
           'gap it gives ~95% uptime where the real geometric process gives ~49%, which is the ' +
           'flattering direction. The event RATE is estimated from the rotation\'s own swing cadence ' +
           'rather than from the true damage-instance count (a multi-hit cast and a bleed tick both ' +
           'raise onInflictDamage), so the number is a floor. Enchant_Zealot and Enchant_Devote are ' +
           'held frozen at the cap by id: the measured cost of that is under 1% in a filler-heavy ' +
           'fight and up to ~40% at a quarter swing clock.' },
    { severity: 'unmodelled', what: 'a stat buff is still counted at its cap, not at a tracked count',
      why: 'The stack channel landed on the DAMAGE side - a dot\'s ticks now follow a live count - and ' +
           'not yet on the AFFIX side, where applyAffixes@6083 multiplies each affix by ' +
           'getAffixMultiplier() = stacks. A buff is still credited at full stacks, which is right for ' +
           'a weapon enchant refreshed off a proc every few swings (Enchant_Zealot saturates) and ' +
           'wrong for one whose income the fight cannot derive. The `restat` cache is keyed on ' +
           'status#stacks, so a fractional mean has to be quantised before it can go in, or a bounded ' +
           'cache of integer states becomes an unbounded one of float states.' },
    { severity: 'verified', what: 'a step whose `on` is Code is played by the script, not by the cast',
      why: '`skill@steps.on` has a Code case and it means exactly that: the step is played by ' +
           '`playStep(Steps.<id>)` from the row\'s own script and by nothing else - `Steps.<name>` being ' +
           'the step\'s `id` column, which 139 of the 141 playStep call sites in the sheet name on their ' +
           'own row. 158 steps declare it and 72 carry a real amount, and every one of them used to be ' +
           'folded into its skill\'s cast. Brutal Frenzy is the case that shows the size of it: the cast ' +
           'is the 1.43 x Strength Area step, the measured 133, while the 0.3 x Strength Mono step is ' +
           '`id: "Attack", on: Code` played by `if (rank >= 3 && hit.isBaseAttack) if ' +
           '(checkProba(vars.chance)) playStep(Steps.Attack, hit.target)` at vars.chance 0.15 - the ' +
           'tooltip\'s "all your attacks have a 15% chance to deal an additional 28" in as many words. ' +
           'So the cast prices 133 rather than 161, and the 28 goes on the base-attack clock through the ' +
           'same trigger machinery every other proc uses. A rider whose hook the fight cannot raise ' +
           '(onGameBeat, onReceiveDamage, onAreaExited, onStop, onStacksChange) or whose guard asks live ' +
           'state is refused with the hook named. A rider on the host\'s OWN cast - onDamage, onHit, ' +
           'onStart, onAreaElapsed - is folded back into the cast at its chance, because its schedule IS ' +
           'the cast\'s and separating them would leave a delayed detonation like Staff_Censer_Skill2 ' +
           'with no parent to hang off.' },
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
    { severity: 'verified', what: 'basic swings vary ±10% over their WHOLE value; nothing else varies at all',
      why: 'Read from getEffectRange@20779 (HSkill.hx:192-201): WeaponAttack_RandomRange (0.1) applies only to ' +
           'Damage effects on skill types Attack..Attack4 - the combo finisher, weapon skills, class ' +
           'skills and status ticks all roll nothing, which is why the finisher read a constant 133 in ' +
           'game - and the band covers flat plus attribute (getStepEffectItemScaling@20780 adds the ' +
           'scaling first, then rolls). Deterministic mode keeps the mean; --fights N rolls the swings.' },
    { severity: 'verified', what: '--fights rolls the crit too, one die per hit, without moving the mean',
      why: 'Crit used to stay at its expectation while everything else rolled, so a crit-bleed build - the ' +
           'one whose whole damage profile is "did the crit land" - reported a spread of essentially zero, ' +
           'which read as a claim about the build and was a fact about the model. A cast decomposes as ' +
           '`fixed + base x (1 + p(cd-1))` because its crit chance and crit multiplier are properties of the ' +
           'SKILL, not of the effect - the category riders (Sever, Master-at-arms) key on prof.type - so ' +
           'rolling k crits out of n hits gives `fixed + base x (1 + (k/n)(cd-1))`, whose binomial mean is ' +
           'exactly the deterministic number. What fed a pool follows the same die: Hemorrhage takes a share ' +
           'of physical CRITICAL damage, so a swing that rolled no crit feeds it nothing. Deterministic ' +
           'output is untouched to the last decimal; only the spread changes, and on a crit corner it went ' +
           'from 0.2% to 2.5%.' },
    { severity: 'verified', what: 'a status tick cannot crit and skips the attacker\'s fervor/mastery bracket',
      why: 'Read from initVars@5150: ctx.critChance is zeroed for damage-carrying statuses, and the ' +
           'context is built from the status OWNER - the carrier, not the attacker - so the ' +
           '(1 + fervor + mastery) bracket never reaches a tick. What DOES move a running tick is the ' +
           'attacker\'s script hooks (onInflictDamageEval), which is the mechanism behind the measured ' +
           'Berserk tick jump; the averaged DamageModifier this model applies to pool ticks stands in ' +
           'for exactly those hooks, and a bleed-crit talent (Exsanguination) is such a hook too.' },
    { severity: 'verified', what: 'displayed damage is the ceiling of the raw float; health loses the float',
      why: 'Read from applyDamage@4835: heroes display ceil (Hero.flattenAtbScaling@7448), foes floor, ' +
           'and the HP subtraction uses the un-rounded value. The tooltip renderer ' +
           '(skillEffectValText@20949) dispatches through the same virtual on the live Hero, so a ' +
           'weapon tooltip\'s range endpoints ceil too. Back-inferring from a displayed integer ' +
           'means raw is in (display-1, display].' },
    { severity: 'verified', what: 'a chain link swings at its authored duration - there is no floor',
      why: 'The 0.70s floor that stood here was the largest error in the model, and it was calibrated ' +
           'from two stopwatches: ten Cheese Moon chains timed at 28s against authored durations summing ' +
           'to 1.81s, and ten Judgement chains at ~30s, which agreed only because Judgement\'s authored ' +
           'links already sit at 0.70-0.85. The axe\'s fast 0.25-0.55 were written off as "hit timings, ' +
           'not swing periods" and the gap was papered over with a floor rather than chased. An ' +
           'INSTRUMENTED CAPTURE settled it: 4,916 logged damage events over an 88-second dummy session, ' +
           'of which 12 uninterrupted Cheese Moon cycles have a median of 1903ms (1820-1972) against the ' +
           'floored model\'s 2850ms - a ratio of 1.498 - with individual links landing 210-640ms apart, ' +
           'well under the floor that was meant to bound them. The authored durations sum to 1810ms, ' +
           'within 5% of the measured median: they were right all along and the stopwatch was timing ' +
           'interrupted chains. Every throughput number inherited that 1.5x on any weapon whose links ' +
           'are faster than 0.7s - the Rogue moved 307 -> 358 and the Mage 223 -> 239, while the Warrior ' +
           'and Priest did not move at all because their chains are authored above the old floor. ' +
           '--swing-floor 0.7 restores the old reading for comparison. The residual 5% is unexplained ' +
           'and named: see docs/GROUND-TRUTH.md.' },
  ];

  return {
    profile, foe, foes: Object.keys(NAMED), namedTargets: NAMED, targetsByUnit, armourIntent,
    castOutput, throughput, survivability, affinityOf, weaponPowerFor, primaryAtbFor,
    primaryBudgetFor, attributeBudgets, audit,
  };
}
