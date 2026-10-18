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
// What is NOT shipped as data is the composition order that turns that into a
// number on screen. That half is read from the bytecode: the receiving side
// in ent.Unit.computeDamage@4920, the attacker's bracket in
// ent.GameObject.getDamageRatio@4577, and how one scaling entry is priced in
// $HSkill.getStepEffectScaling@21777. ent.Unit.applyDamage@4914 can no longer
// be read at all: since build 25782799 the client ships it, together with
// ent.Unit.receiveDamage@4913 and ent.Unit.applyEffect@4912, as a three-op
// `throw "!isServer"` stub, so a rule taken from those bodies on an earlier
// build is cited as history where it is used. Three consequences, all of
// them visible in the audit this module returns rather than hidden:
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
//   * WeaponPower has no scaling entry and no atbScaling group, and nothing
//     grants it: the scaler resolves the id by NAME, into the equipped
//     weapon's own aptitudes (see `scalingValue` and `weaponPowerFor`). The
//     rule changed in build 25782799 and the new one is read, not measured -
//     the audit says which reading settles it. `AllAttributes` is the second
//     attribute resolved that way.
//
// Because absolute numbers rest on those three, the CLI reports throughput as
// a relative score and refuses to call it DPS.
// ---------------------------------------------------------------------------

import { budget, resistForReduction, damageReduction } from './model.mjs';
import { simulate } from './sim.mjs';
import { enclosingBlock } from './skills.mjs';
import { buildSources } from './sources.mjs';

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
  // hasStatusFlag@21820 walks the chain, so this does too.
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
  // WHICH statusTypes a script may name as crowd control, for the typed gate
  // in `runeDamage` (`hasStatusType(StatusType.Slow)`,
  // `getStatusTypeCount(StatusType.Slow) > 0`): the rows carrying the
  // CrowdControl flag, their own or a parent's - the flag
  // GameObject.isUnderAnyCC@4635 asks for through hasStatusFlag@21820(inf, 1),
  // decoded by NAME. The reader used to spell three of them out (Stun, Root,
  // Slow); the sheet has five on build 25782799 (Silence and Grounded too),
  // and a guard naming one of those would have gone unread. Built on first
  // use, so a sheet without the flag fails where the gate is asked for.
  let ccTypeRes = null;
  const ccTypeGuards = () => {
    if (!ccTypeRes) {
      const bit = cdb.enumValues('statusType', 'flags').indexOf('CrowdControl');
      if (bit < 0) {
        throw new Error('statusType.flags no longer has a "CrowdControl" case - which status types a typed '
          + 'crowd-control guard may name cannot be read');
      }
      const flagged = (id) => {
        let cur = statusTypeById.get(id);
        for (let hop = 0; cur && hop < 8; hop++) {
          if (((cur.flags ?? 0) >> bit) & 1) return true;
          cur = cur.parent ? statusTypeById.get(cur.parent) : null;
        }
        return false;
      };
      const ids = [...statusTypeById.keys()].filter((id) => /^\w+$/.test(String(id)) && flagged(id));
      const alt = ids.length ? ids.join('|') : '(?!)';
      ccTypeRes = {
        ids,
        count: new RegExp(String.raw`(\w+(?:\.\w+)*)\.getStatusTypeCount\s*\(\s*(?:StatusType\.)?(${alt})\s*\)\s*>\s*0`),
        named: new RegExp(String.raw`hasStatusType\s*\(\s*(?:StatusType\.)?(${alt})\s*\)`),
      };
    }
    return ccTypeRes;
  };
  const PROJECTILE_HIT = stepOnNames.indexOf('ProjectileHit');
  // Which step types hit everything in a shape rather than one target.
  //
  // A `Mono` step carrying a props.area does NOT cleave, and that is settled
  // rather than assumed: AreaStep.areaHit@6077 pins hitCount to 1 for Mono, the
  // priority hit decrements it, and the function returns at L2034-2035 (ops
  // 84-87; source lines of build 25959898) before the shape query runs. With no
  // priority target the sweep runs and is then trimmed to the single nearest
  // object (L2067-2071, ops 226-271, the farthest removed while more than
  // hitCount remain). Mono IS an AreaStep at
  // runtime - isAreaStep@6066 is true for type 0 - so the cone is real; it
  // decides WHICH enemy, never how many. See the audit for the full read.
  //
  // The step-level `props.hitCount` is the one override, and all six of its
  // occurrences in the sheet hold 1. The tripwire below exists so that a patch
  // authoring anything else stops being silently single-target.
  const AREA_STEP_TYPES = new Set(['Area', 'Aura']);

  // `skill@steps@props@status.target` - who a Status step's status goes to.
  // Resolved by name, and loud about a value the enum does not have: the two
  // cases the model acts on must still exist, whatever else the column holds.
  const statusTargetNames = cdb.enumValues('skill@steps@props@status', 'target');
  for (const need of ['Self', 'Target']) {
    if (!statusTargetNames.includes(need)) {
      throw new Error(`skill@steps@props@status.target has no ${need} case (${statusTargetNames.join(', ')}) - `
        + 'the status reader decodes it by name and cannot run without it');
    }
  }
  const statusTargetName = (v) => {
    const name = statusTargetNames[v];
    if (name == null) throw new Error(`skill@steps@props@status.target holds ${v}, which the enum does not name`);
    return name;
  };

  // `skill@steps@props@area.hitFilter` - whom an area's sweep may hit. The
  // column borrows its definition (`structRef`), the flag set a step's own
  // `cond.alignment` declares, and the game tests it bit by bit:
  // AreaStep.canHitTarget@6074 ops 40-48 hand it to
  // BaseSkill.checkAlignment@6184, where an ABSENT filter is "enemies only"
  // (ops 10-13), bit 1 an enemy, bit 2 an ally who is not the source (ops
  // 24-33) and bit 4 the source itself (ops 35-42). Resolved by name, loud
  // without the one case this reads.
  const hitFilterNames = (() => {
    const col = cdb.column('skill@steps@props@area', 'hitFilter');
    const at = String(col.structRef ?? '').lastIndexOf('@');
    return col.typeStr ? cdb.enumValues('skill@steps@props@area', 'hitFilter')
      : at > 0 ? cdb.enumValues(col.structRef.slice(0, at), col.structRef.slice(at + 1)) : [];
  })();
  if (!hitFilterNames.includes('Self')) {
    throw new Error(`skill@steps@props@area.hitFilter has no Self flag (${hitFilterNames.join(', ')}) - `
      + 'the reader of a hit that lands on its own caster cannot run without it');
  }
  const filterAdmitsSelf = (bits) => bits != null && !!((bits >> hitFilterNames.indexOf('Self')) & 1);

  // `skill@props@enableCond.flags` - when the skill may be used at all.
  const enableCondNames = cdb.enumValues('skill@props@enableCond', 'flags');
  // WHAT A USE DOES TO THE SKILL ALREADY RUNNING. `props.interruptStyle` is
  // an enum three cases long, and the game asks it in one place:
  // st.skill.Skill.canInterruptOnUse@9638 - the skill being USED against the
  // one RUNNING. Ops 21-26: never its own kind. Ops 27-32: a row that authors
  // no interruptStyle interrupts nothing (`== null -> false`). Op 39, the
  // switch: `All` interrupts whatever runs; `AllButSelf` likewise (its own
  // kind was already refused); `WeaponAttacks` only a running base attack
  // (skill types 0-3, ops 59-63, or 4, ops 71-76). The one other way in is
  // ops 14-20: the running skill is mid-CAST and may be cancelled
  // (canCastCancel@9574 - a Cast step, which no base attack has). The skill
  // that is interrupted stops there (requestInterrupt@9637: stop(), unless
  // its row's flags carry bit 0x800000), so a step it had not started yet is
  // never started; a use that interrupts nothing waits for the running skill
  // to end (the queue: Const.Controls.SkillQueueTime).
  //
  // Thirteen rows of build 25782799 author it - the three blocks (Parry,
  // Withstand, Block), the Dash, five weapon skills (Apix Dash, Shadow Jump,
  // Gaping Wound, Infernal Plunge, Chaotic Distorsion), the Rogue's Finisher
  // and three class skills (Charge, Shadowstep, Blink) - and every other
  // skill a player presses waits. MEASURED 2026-10-13 (Rogue, 48 rotation segments, the
  // `go_state` and `skill_end` rows): Infernal Plunge (AllButSelf), Gaping
  // Wound (All) and the Finisher (All) opened their Skill state inside a
  // running chain link on 480 of 492 uses, and the link then wrote no
  // skill_end; Death Mark, Knives Tempest and Urge to Kill (none authored)
  // did so on 0 of 107 - 89 of them opened 6-17 ms after a link's skill_end,
  // one frame, the rest after another cast. Decoded by NAME.
  const interruptStyleNames = (() => {
    try { return cdb.enumValues('skill@props', 'interruptStyle') ?? []; } catch { return []; }
  })();
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
  // Whether a `sideEffects.knockBack` entry carries a force: a push or a lift
  // that is not zero. Both columns are optional floats; a pull and a slam are
  // negative ones.
  const knockForce = (kb) => !!kb && (num(kb.pushForce) !== 0 || num(kb.knockUpForce) !== 0);

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
  /**
   * A STATUS THAT PLAYS A DAMAGE STEP ON ITS WEARER'S SWINGS, read off the
   * one shape the scripts write it in:
   *
   *   function onInflictDamage(hit) {            // or onInflictHit
   *     if (hit.isBaseAttack || hit.isFinalCombo) {
   *       [ if (checkProba(vars.chance) && hit.skillId != skill.kind) { ]
   *         playStep(Steps.<S>, hit.target);
   *
   * Purging Strikes and Swarmstrike Accord are the bare form; Abyssal Fury is
   * the one with the inner guard - "giving all your [Attack]s a chance to
   * blast", 30% and 40% from rank 2 - and Blessing spells the predicate
   * `isAttack`. Returned: which swings (`on`), the step, the hook, the var
   * the roll reads (null: every time) and whether the script keeps the step's
   * own hit from playing it again.
   *
   * WHICH SWINGS is the game's own reach, not the word's: isBaseAttack and
   * isAttack are skill types 0-4, the finisher included (BaseSkill.isBaseAttack@6153,
   * get_isAttack@5192); BaseSkill.isBasicAttack@6152 stops at 3; get_isFinalCombo@5191
   * and BaseSkill.isFinalAttack@6154 are type 4. So a bare `hit.isBaseAttack` is every
   * swing and the finisher.
   *
   * `hit.skillId != skill.kind` is the status excluding its own step: the
   * step it plays belongs to the status row, and Abyssal Fury's carries the
   * BaseAttack step flag (SkillStep.isBaseAttack@6027 op 4-9, "Blasted damage
   * is considered as an [Attack]"), so without the test a blast would roll
   * for another. It is a rule of the row, not a condition on the swing.
   *
   * Both hooks are raised per hit: onInflictHit from BaseSkill.onHit@6233
   * (ops 114-119, no step-origin test) and onInflictDamage per damage
   * instance (its dispatcher is server-side and gone from this client; the
   * accepted-build capture's application clock only reconciles per hit).
   * Anything else in front of the playStep - a rank, a count, a status - is
   * not this shape, and null says so.
   */
  function swingPlayOf(s) {
    if (!s?.props?.status || !s.script) return null;
    const src = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const P = '(?:isBaseAttack|isAttack|isBasicAttack|isFinalCombo|isFinalAttack)';
    const head = new RegExp('function\\s+(onInflictDamage|onInflictHit)\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\{\\s*'
      + 'if\\s*\\(\\s*(\\2\\.' + P + '(?:\\s*\\|\\|\\s*\\2\\.' + P + ')*)\\s*\\)\\s*\\{\\s*').exec(src);
    if (!head) return null;
    let rest = src.slice(head.index + head[0].length);
    let chanceVar = null, notSelf = false;
    const inner = /^if\s*\(([^{]*)\)\s*\{\s*/.exec(rest);
    if (inner) {
      for (const term of inner[1].split('&&').map((x) => x.trim())) {
        const roll = /^checkProba\s*\(\s*vars\.(\w+)\s*\)$/.exec(term);
        if (roll) chanceVar = roll[1];
        else if (new RegExp('^' + head[2] + '\\.skillId\\s*!=\\s*skill\\.kind$').test(term)) notSelf = true;
        else return null;
      }
      rest = rest.slice(inner[0].length);
    }
    const play = /^playStep\s*\(\s*Steps\.(\w+)[^;]*;\s*/.exec(rest);
    if (!play) return null;
    // ...and whether each swing SPENDS a stack of the status: Blessing's body
    // goes on `if (dmg.isFirstHit) { consumeStatus(owner, <this status>, 1);`
    // - one stack per swing, on its first hit - which makes its stack count
    // the number of swings it empowers.
    const spend = /^if\s*\(\s*\w+\.isFirstHit\s*\)\s*\{\s*consumeStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)\s*,\s*1\s*\)/
      .exec(rest.slice(play[0].length));
    const isSelf = (name) => name === s.id
      || new RegExp('\\bvar\\s+' + name + '\\s*=\\s*Skill\\.' + s.id + '\\s*;').test(src);
    const spendsSelf = !!spend && isSelf(spend[1]);
    // ...or the swing spends the WHOLE status: Sunlight's goes on `if (owner
    // != status.instigator || !hasSkill(Skill.Priest_Talent_SolarDevotion)) {
    // owner.tryConsumeStatus(<this status>, status.instigator); }` - "The next
    // [ComboAttack] consum[es] Sunlight" - with the one skill that keeps it
    // ("You can trigger Sunlight effects without consuming it anymore") named
    // in the guard. `keptBy` is that skill, for the owner's own status.
    const whole = /^(?:if\s*\(([^{]*)\)\s*\{\s*)?(?:owner\.)?(?:tryConsumeStatus|consumeStatus)\s*\(\s*(?:owner\s*,\s*)?(?:Skill\.)?(\w+)\s*(?:,\s*status\.instigator\s*)?\)/
      .exec(rest.slice(play[0].length));
    const spendsWhole = !!whole && isSelf(whole[2]);
    const keptBy = spendsWhole ? /!\s*hasSkill\s*\(\s*Skill\.(\w+)\s*\)/.exec(whole[1] ?? '')?.[1] ?? null : null;
    const wide = /\.(?:isBaseAttack|isAttack)\b/.test(head[3]);
    const basic = /\.isBasicAttack\b/.test(head[3]);
    const fin = /\.(?:isFinalCombo|isFinalAttack)\b/.test(head[3]);
    return {
      on: wide || (basic && fin) ? 'attack-or-combo' : fin ? 'combo' : 'attack',
      stepId: play[1], hook: head[1], chanceVar, notSelf, consumesPerSwing: spendsSelf,
      consumesWhole: spendsWhole, keptBy,
    };
  }

  //
  // `flags` answers script-level booleans the CALLER knows: a recast skill
  // keeps one that says which of its two presses this is (`firstCast`,
  // `recasting`), and a clause behind it is that press's own. Without an
  // answer such a clause is refused, as any unknown name is.
  const runeDmgCache = new Map();
  function runeDamage(s, rank, runes, vars, flags = null) {
    if (!s?.script) return [];
    const key = s.id + '@' + rank + '@' + (runes?.size ? [...runes].sort().join('+') : '-')
      + (flags ? '@' + Object.entries(flags).map(([k, v]) => k + '=' + v).join('&') : '');
    let hit = runeDmgCache.get(key);
    if (hit) return hit;
    hit = [];
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    // `critChance` rides the same eval-time family: evalDamage@6124 runs the
    // skill's own hooks BEFORE criticalRoll@6320, so `hit.critChance += x`
    // raises landed crit in fraction space, and `hit.critChance = 100` is a
    // guaranteed crit (the literal is percent; the roll is a fraction).
    // Blazing Beam measured 93/93 at rank >= 2 with the tooltip saying so.
    for (const m of body.matchAll(/\w+\.critChance\s*=\s*100\b/g)) {
      const before = body.slice(0, m.index);
      const line = before.slice(before.lastIndexOf('function'));
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (rune && !runes?.has(rune)) continue;
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
      hit.push({ field: 'critChance', amount: 1, forced: true, gate: null, targetHealth: null, singleTarget: false });
    }
    // A LITERAL WRITE ON ONE STEP OF THE ROW'S OWN. Two rows spell a step's
    // special rule as an assignment in onInflictDamageEval behind exactly
    //
    //   if (<hit>.skillId == skill.kind && <hit>.stepId == Steps.<Step>)
    //
    // "this is my own damage, and it is that step" - Seals of Atonement's
    // Smite (`hit.critChance = 1`; Infusion_Crimson_Support.
    // Infusion_Crimson_Support.onInflictDamageEval@45102 ops 0-23) and Unstable Bomblets' golden one
    // (`dmg.critChance = 1; dmg.armorIgnore = 1`; Infusion_Kobold_DPS.
    // Infusion_Kobold_DPS.onInflictDamageEval@45091 ops 0-25). A crit chance of 1 is every time:
    // criticalRoll@6320 ops 9-13 crit whenever critChance >= random, the same
    // test that makes the percent-spelled 100 above certain. An armour ignore
    // of 1 leaves no pool: getAffinityDamageReduction@4582 ops 133-147
    // multiply the resist by 1 - clamp(armorIgnore, 0, 1) (ops 82-105 the
    // magic twin).
    //
    // The hook is the owner-wide one, but this guard hands the write to one
    // step of this row and to no other hit, so the entry carries `stepId` -
    // the field an additive rider narrowed to one step carries too (the
    // RIDER reader below) - and the pricing site applies it to that step's
    // effects alone. `set` says it is an assignment, not a `+=`.
    //
    // READ NARROWLY, on purpose. The same literals behind any other guard -
    // a status that has to be up (Rage Strike's Surge, Mass Grab's proc),
    // another row's id (the Censer's Hidden Power), a register written in
    // onSkillProc (Domination) - are a question about live state or about
    // someone else's hits, and each has, or needs, a reader of its own. A
    // census of every `critChance = <literal>` / `armorIgnore = <literal>` in
    // the sheet finds this guard on those two rows and nowhere else.
    for (const m of body.matchAll(/if\s*\(\s*(\w+)\.skillId\s*==\s*skill\.kind\s*&&\s*\1\.stepId\s*==\s*Steps\.(\w+)\s*\)\s*(\{[^{}]*\}|[^;{}]*;)/g)) {
      const hook = /function\s+(\w+)\s*\([^)]*\)\s*\{\s*$/.exec(body.slice(0, m.index))?.[1] ?? null;
      if (hook !== 'onInflictDamageEval' && hook !== 'onDamageEval') continue;
      for (const w of m[3].matchAll(/(\w+)\.(critChance|armorIgnore|magicArmorIgnore)\s*=\s*(\d*\.?\d+)\s*;/g)) {
        if (w[1] !== m[1]) continue;
        const v = Number(w[3]);
        if (w[2] === 'critChance') {
          // Only the certain one. A literal below 1 would REPLACE the sheet's
          // chance for the step, which no row does and nothing here prices.
          if (v >= 1) hit.push({ field: 'critChance', amount: 1, forced: true, stepId: m[2], set: true, gate: null, targetHealth: null, singleTarget: false });
        } else if (v > 0) {
          hit.push({ field: w[2], amount: Math.min(1, v), stepId: m[2], set: true, gate: null, targetHealth: null, singleTarget: false });
        }
      }
    }
    // ANCHORED for the same reason `ONE_SKILL` is, and this reader could not
    // have caught the case any other way: the `rest` refusal below is built
    // from `body.slice(0, m.index)` - the text BEFORE the match - so anything
    // to the RIGHT of the captured `vars.X` is invisible to it. A rider
    // written `dmgMult += vars.X * <a count>` therefore booked `vars.X` alone
    // and nothing anywhere said a count had been dropped. Requiring the
    // statement to END at the var is the only place that can see it.
    //
    // The right-hand side is a var, or ONE other thing: an attribute of the
    // owner. Hive Assault's rank-2 clause is `hit.dmgMult +=
    // owner.atb(Attribute.CritChance) / 100` - "your critical chance, as
    // damage" - and `atb()` is the attribute in points (the unscaled value;
    // ScriptBase.getAtb@6650 is the x0.01 spelling of the same read, through
    // GameObject.atbVal@4571), so a sheet at 30 CritChance adds 0.30. Carried
    // as `fromAtb` and priced off the sheet the cast is priced on.
    const RIDER = /\w+\.(dmgMult|critDmgMult|critChance)\s*\+=\s*(?:vars\.([A-Za-z0-9_]+)|owner\.atb\s*\(\s*Attribute\.(\w+)\s*\)\s*\/\s*100|getAtb\s*\(\s*owner\s*,\s*Attribute\.(\w+)\s*\))\s*(?=[;}])/g;
    // `<hit>.skillId == skill.kind` (or the row's own id spelled out) is not
    // a condition on anything this reader has to answer: every entry here is
    // only ever applied to the row's own profile, or - marked `ownerWide` -
    // to everything its owner lands. The test picks the first of the two. It
    // is how an owner-wide hook is narrowed back to the row's own hits, and
    // left in the guard it refused Honey Crush's one-target +25% and both of
    // Hiveborn Blossom's clauses for "a condition this cannot answer".
    const SELF_REF = new RegExp('\\b\\w+\\.skillId\\s*==\\s*(?:skill\\.kind|Skill\\.' + s.id + ')\\b', 'g');
    for (const m of body.matchAll(RIDER)) {
      const field = m[1];
      const before = body.slice(0, m.index);
      // THE GUARD IS THE BLOCKS THAT ENCLOSE THE STATEMENT, not everything the
      // function wrote before it. Hiveborn Blossom's body is two sibling
      // blocks - `if (!firstCast) { ... }` and then `if (rank >= 3) { if
      // (hit.targetUnit.healthRatio > vars.threshold) hit.dmgMult +=
      // vars.var2; }` - and read as one run of text the second inherited the
      // first's `!firstCast` and was refused on a condition it does not have.
      const line = enclosingBlock(before.slice(before.lastIndexOf('function')));
      // WHICH HOOK the clause is written in decides whose hits it rides.
      // A proxy hook (onProxyDamageEval, new on build 25782799) is raised for
      // hits the owner's SUMMONS deal and never for the owner's own -
      // evalDamage@6124 ops 9-13 - so it is not this skill's rider at all.
      const hook = /^function\s+(\w+)/.exec(line)?.[1] ?? null;
      if (/^onProxyDamage/.test(hook ?? '')) continue;

      // A RUNE guard still has to be satisfied by a slotted rune.
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (rune && !runes?.has(rune)) continue;
      const runeVars = rune ? (s.mastery ?? []).find((x) => x.id === rune)?.vars ?? null : null;
      // `vars` is the RANK-RESOLVED set - `props.rankOverride` restates them
      // (Domination's 0.15 became 0.25 from rank 2 until build 25782799 gave
      // the row one flat 0.25; Shockwave's dur1 still goes 3 -> 4). Reading
      // `s.vars` here would understate every such rider at the ranks bench
      // actually uses.
      //
      // THE SLOTTED RUNE GOES ON TOP OF IT, which is the other way round from
      // how this read until the health clause made the difference observable.
      // `updateSkillInf@21787` runs applyVars per slotted mastery ON TOP of the
      // row's own, so the rune wins wherever both name a key - the same
      // resolution `scriptGapsOf` in skills.mjs already applies, and the same
      // reason: a var read only inside a clause gated on the rune that
      // overrides it has no observable base value at all. Exactly one rider in
      // the sheet can tell the two orders apart, and it is Execution: its own
      // row says damage 0.5 under threshold 0.2, its rune says 0.25 under 0.35,
      // and the tooltip says 25% under 35%. Reading the row would have priced
      // this rune at DOUBLE its printed value in a window it does not have.
      // (Concentrated Impact is the other rune-gated rider and its `damage`
      // lives only on the rune, so the old fallback already reached it.)
      const varOf = (name) => (runeVars && name in runeVars ? runeVars[name] : vars?.[name]);
      const fromAtb = m[3] ?? m[4] ?? null;
      const amount = fromAtb ? 0 : varOf(m[2]);
      if (!fromAtb && (typeof amount !== 'number' || amount <= 0)) continue;
      if (fromAtb && !ctx.attrTable.byId.has(fromAtb)) continue;
      const selfRef = line.search(SELF_REF) >= 0;
      // `<hit>.stepId == Steps.<X>` on the row's own hits narrows the rider
      // to the hits of its step X (Hive Assault's is its Area step, not the
      // darts the same row throws).
      const ownStep = (hook === 'onDamageEval' || selfRef)
        ? /\b\w+\.stepId\s*==\s*Steps\.(\w+)/.exec(line) : null;
      const stepId = ownStep && (s.steps ?? []).some((x) => x.id === ownStep[1]) ? ownStep[1] : null;

      // A RANK guard is a question about the build, not about live state, so it
      // is answered here rather than refused. Bonethrow's rank-3 +20% crit
      // damage is the case: `if (rank >= 3) hit.critDmgMult += vars.var2`, with
      // no live condition anywhere in it.
      //
      // Only when the guard is a plain conjunction. Domination read
      // `Stun || Root || Slow || (rank >= 3 && isCCImmune())` on the accepted
      // build, where the rank clause belonged to ONE alternative - vetoing the
      // whole rider on it silenced a +25% that fired on the stun path at any
      // rank. (On build 25782799 the same row is `rank >= 3 &&
      // isCrowdControlled(hit.target)`, a plain conjunction, so the rank IS
      // the gate: nothing at ranks 1 and 2.)
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
      // the combo's +20%; anything else stays a refusal.
      //
      // CROWD CONTROL has two questions, and they are opposite.
      // `isCrowdControlled(hit.target)` is Domination's on build 25782799
      // (SkillScript.isCrowdControlled@6918 -> GameObject.isUnderAnyCC@4635:
      // any status whose type carries the CrowdControl flag,
      // hasStatusFlag@21820(inf, 1), parents walked) - the Stun/Root/Slow trio
      // the accepted build's script spelled out is the same gate by name.
      // `<target>.isUnderAnyCC()` is that same function called without the
      // wrapper (isCrowdControlled@6918 is three ops: null-check, call
      // isUnderAnyCC@4635, return), and one
      // player row writes it that way: Chaotic Distorsion's rank-2 +40%
      // (Halos_Demon_Skill1.onDamageEval@44841 ops 2-9: `rank < 2` or
      // `!hit.target.isUnderAnyCC()` returns). Accepting only the wrapper left
      // that clause refused as "which this reader cannot answer" beside a gate
      // that holds exactly its answer.
      // `<target>.isCCImmune()` is Shockwave's and Iron Cyclone's rank-3
      // clause: Foe.isCCImmune@7071, the unit's Boss, Miniboss or Elite flag.
      // It used to be STRIPPED, on the grounds of the old Domination guard
      // where it was one arm of an `||`; with that guard gone the strip left
      // both riders unconditional - +50% and +30% credited on a training dummy
      // that is not immune to anything. It is a gate now, answered by the
      // target, and only in a plain conjunction: as one arm of an `||` it is
      // left in `rest` and the rider refused.
      //
      // WHOSE crowd control, for the direct spelling: the method is called on
      // an object, and only the thing being hit is the gate the fight prices
      // (the same rule as the health clause below - the owner's own state is
      // not the target's). Anything else stays in `rest` and is refused.
      //
      // ONE NAMED TYPE is a narrower question than "any crowd control".
      // `hit.target.hasStatusType(StatusType.Slow)` is Riptide's +25% and
      // `dmg.target.getStatusTypeCount(StatusType.Slow) > 0` is Pyroclasm's
      // +30% - the same test in two spellings (the second counts the
      // statuses of that type and asks for at least one) - and a stunned
      // target is not a slowed one: no CrowdControl type has a parent in the
      // statusType sheet. So the rider carries the type it names (`ccType`)
      // and is priced on the share of the fight the target spends under THAT
      // type. The count spelling was not read at all ("which this reader
      // cannot answer"), and against a Boss, Miniboss or Elite both are
      // simply zero: GameObject.canReceiveStatus@4634 refuses every CrowdControl-flagged
      // status there and Slow carries the flag.
      const directCC = /(\w+(?:\.\w+)*)\.isUnderAnyCC\s*\(\s*\)/.exec(line);
      const directOnTarget = !!directCC && /target/i.test(directCC[1]);
      // WHICH type names count is the sheet's answer (`ccTypeGuards`), asked
      // only of a line that uses one of the two spellings.
      const typed = /\b(?:hasStatusType|getStatusTypeCount)\s*\(/.test(line) ? ccTypeGuards() : null;
      const typeCount = typed ? typed.count.exec(line) : null;
      const countOnTarget = !!typeCount && /target/i.test(typeCount[1]);
      const typeNamed = (typed ? typed.named.exec(line)?.[1] : null)
        ?? (countOnTarget ? typeCount[2] : null);
      const ccGuard = /\bisCrowdControlled\s*\(\s*\w+(?:\.\w+)*\s*\)/.test(line)
        || directOnTarget
        || typeNamed != null;
      const immuneGuard = !/\|\|/.test(line) && /\w+(?:\.\w+)*\.isCCImmune\s*\(\s*\)/.test(line);
      // Both at once can never hold: GameObject.canReceiveStatus@4634 refuses every
      // CrowdControl-flagged status on a target whose isCCImmune() is true.
      if (ccGuard && immuneGuard) continue;
      // A NEGATED predicate is the opposite gate, and `rest` below cannot
      // tell: it drops punctuation, the `!` with it. No row negates one of
      // these three today; the day one does, the clause is refused here (and
      // so named as a gap) rather than read as its own inverse.
      if (/!\s*(?:isCrowdControlled\s*\(|\w+(?:\.\w+)*\.(?:isUnderAnyCC|isCCImmune)\s*\()/.test(line)) continue;
      // ANY OTHER TYPE is a state the fight holds, and it is a gate too.
      // `hit.target.hasStatusType(StatusType.Burn)` is Scorch's rank-3 +25%
      // critical chance (the Apprentice's Grimoire's finisher), and
      // GameObject.hasStatusType@4626 is what it says: some status on that
      // object whose type is the one named (Status.isType@15821; ops 26-29
      // narrow it to one instigator only when a second argument is passed, and
      // the script passes none). The name was stripped from the guard with
      // every other hasStatusType(...), so a type that is neither a bleed nor
      // a crowd control left NO gate and the rider was paid on every hit:
      // Scorch crit 25 points more often against a target nothing had set
      // alight. It is carried as `typed` with the type it names and paid by
      // the fight while one of the build's own statuses of that type stands
      // (`whileTyped`, the mechanism Finish the Job's poison test already
      // uses); castOutput has no answer for it and adds nothing. Only on the
      // thing being hit, only for a type the sheet has, only un-negated, and
      // only for the two fields the fight's typed riders carry - anything
      // else stays in `rest` and is refused.
      const typedGuard = (() => {
        const t = /(!\s*)?(\w+(?:\.\w+)*)\.hasStatusType\s*\(\s*(?:StatusType\.)?(\w+)\s*\)/.exec(line);
        if (!t || t[3] === 'Bleed' || typeNamed === t[3]) return null;
        const ok = !t[1] && /target/i.test(t[2]) && statusTypeById.has(t[3])
          && (field === 'critChance' || field === 'dmgMult') && !/\|\|/.test(line);
        return { type: t[3], ok, text: t[0] };
      })();
      const gate = /hasStatusType\s*\(\s*(?:StatusType\.)?Bleed\s*\)/.test(line) ? 'bleeding'
        : ccGuard ? 'cc'
          : immuneGuard ? 'ccImmune'
            : typedGuard?.ok ? 'typed'
              : null;

      // THE TARGET'S HEALTH, which is not a question about live state at all -
      // it is a fact about the fight the CALLER STATES, exactly the class of
      // input `--targets` already is. `Execution` is the shape:
      //
      //   if (hasMastery(Mastery.Warrior_RageStrike_M3)
      //       && hit.targetUnit.healthRatio <= vars.threshold)   // 0.35
      //     hit.dmgMult += vars.damage;                          // 0.25
      //
      // The COMPARISON is recorded here and never its answer. `profile()` is
      // memoised on skill+rank+runes and its cache outlives every evaluation
      // the process runs, so a rider that banked a verdict would freeze the
      // first health the engine was asked about into every later answer. The
      // number arrives at the pricing site instead, where `opts.targetHealth`
      // is per-evaluation - which is also why nothing about these caches had
      // to change.
      //
      // THE SUBJECT HAS TO BE THE THING BEING HIT. Six scripts in the sheet
      // read `owner.healthRatio` - Hive Bite, Tide Warlord, Flamie, Fanatical
      // Fury, RobinHoof_Summon, Infused Tusk - and your own health over a
      // fight is not something this model tracks. Reading one of those as the
      // target's would hand a full-health Warrior a boss's execute bonus.
      const th = (() => {
        const h = /(\w+(?:\.\w+)*)\.healthRatio\s*(<=|>=|<|>)\s*vars\.([A-Za-z0-9_]+)/.exec(line);
        if (!h || !/target/i.test(h[1])) return null;
        const t = varOf(h[3]);
        // No number, no reading: the clause stays in `rest` below and the whole
        // rider is refused, rather than being silently stripped to nothing.
        return typeof t === 'number' ? { op: h[2], threshold: t, text: h[0] } : null;
      })();

      // Everything the guard says beyond what is stripped here is a condition
      // this cannot answer, and it must refuse rather than approximate.
      const singleTarget = /totalHits\s*==\s*1/.test(line);
      // A local the guard never reads is not a condition on anything.
      // Riptide's onDamageEval opens with `var totems = getSummons(...)` and
      // never mentions `totems` again; left in `rest` it refused the rider,
      // and the gap reader - which looks at the `if` alone - took the clause
      // for read, so "+25% to slowed enemies" was in neither list.
      const unusedLocals = (text) => text.replace(/\bvar\s+(\w+)\s*=\s*[^;]*;/g,
        (decl, name, at) => (new RegExp(`\\b${name}\\b`).test(text.slice(at + decl.length)) ? decl : ' '));
      // A flag the caller answered: the clause holds or it does not.
      let flagOff = false;
      let lineF = line;
      for (const [name, value] of Object.entries(flags ?? {})) {
        lineF = lineF.replace(new RegExp('(!\\s*)?\\b' + name + '\\b(?!\\s*[=(])', 'g'), (whole, neg) => {
          if ((!neg) !== (value === true)) flagOff = true;
          return ' ';
        });
      }
      if (flagOff) continue;
      const rest = unusedLocals(lineF)
        .replace(/function\s+on\w+\s*\([^)]*\)/g, ' ')
        .replace(SELF_REF, ' ')
        .replace(stepId ? new RegExp('\\b\\w+\\.stepId\\s*==\\s*Steps\\.' + stepId + '\\b', 'g') : /(?!)/g, ' ')
        .replace(/hasMastery\s*\([^)]*\)/g, ' ')
        // A type test this reader has an answer for is taken out; one it has
        // none for (see `typedGuard`) is left standing and refuses the rider.
        .replace(typedGuard && !typedGuard.ok ? /(?!)/g : /hasStatusType\s*\([^)]*\)/g, ' ')
        .replace(countOnTarget ? new RegExp(typed.count.source, 'g') : /(?!)/g, ' ')
        .replace(/\bisCrowdControlled\s*\(\s*\w+(?:\.\w+)*\s*\)/g, ' ')
        .replace(directOnTarget ? /\w+(?:\.\w+)*\.isUnderAnyCC\s*\(\s*\)/g : /(?!)/g, ' ')
        .replace(immuneGuard ? /\w+(?:\.\w+)*\.isCCImmune\s*\(\s*\)/g : /(?!)/g, ' ')
        .replace(/\brank\s*(?:>=|<=|==|!=|>|<)\s*\d+/g, ' ')
        .replace(/\w+\.ctx\.totalHits\s*==\s*1/g, ' ')
        .replace(th ? new RegExp(th.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /(?!)/g, ' ')
        // `hit.targetUnit != null` is not a condition on anything: either there
        // is a unit being hit or there is no hit to price. Demonic Bite writes
        // it beside its health clause and nothing else, so refusing on it would
        // leave that rider unread for a reason that is not a reason.
        .replace(/\w+(?:\.\w+)*\.(?:targetUnit|target)\s*!=\s*null/g, ' ')
        .replace(/\w+\.(?:dmgMult|critDmgMult)\s*\+=\s*vars\.\w+\s*;?/g, ' ')
        .replace(/\b(?:if|hit|dmg|ctx|var|target)\b/g, ' ')
        .replace(/[\s{}()&|!,;.=+]/g, '');
      if (rest.length) continue;
      hit.push({
        amount, singleTarget, rune: rune ?? null, field, gate,
        // The one crowd-control type the guard names, when it names one.
        ...(gate === 'cc' && typeNamed ? { ccType: typeNamed } : {}),
        // ...and the one status type a `typed` gate waits for on the target.
        ...(gate === 'typed' ? { statusType: typedGuard.type } : {}),
        // An amount that is the owner's attribute x `scale`, read off the
        // sheet at the pricing site; and the one step of the row it rides.
        ...(fromAtb ? { fromAtb, scale: 0.01 } : {}),
        ...(stepId ? { stepId } : {}),
        targetHealth: th ? { op: th.op, threshold: th.threshold } : null,
        // WHOSE HITS the clause rides, which is the hook's and not the row's.
        // evalDamage@6124 ops 0-5 run the HITTING skill's own onDamageEval
        // (script slot 15); ops 71-123 then run onInflictDamageEval (slot 17,
        // through BaseSkill.onInflictDamageEval@6126) on EVERY skill and
        // status the instigator carries. So a rider in onDamageEval is this
        // skill's own hits, and one in onInflictDamageEval is every hit its
        // owner lands for as long as the row is owned. Per ENTRY: Raging Smash
        // declares both hooks and its one rider sits in onDamageEval.
        //
        // ...unless the clause itself says `skillId == skill.kind`, which is
        // an owner-wide hook narrowed back to this row's own hits.
        ownerWide: hook === 'onInflictDamageEval' && !selfRef,
      });
    }
    runeDmgCache.set(key, hit);
    return hit;
  }

  /**
   * Whether a skill's own hits SKIP the target's resistance pool.
   *
   *   function onDamageEval(hit) { if( rank >= 2 ) hit.ignoreResistance = true; }
   *
   * That is the whole of Groundswell Strike's rank-2 "Ignores [Armor]." and of
   * Aimed Shot's, and the field has exactly one reader:
   * getAffinityDamageReduction@4582 ops 8-11 jump past the entire
   * `resistances` loop (ops 12-43) when the hit carries it, so the pool stays
   * 0 whatever the target wears and whatever was shredded or penetrated; only
   * the affinity's flat `reductions` (ops 289-319) are still added. It is a
   * boolean on the hit and not a multiplier, so it is not a `runeDamage` entry
   * - nothing about it belongs in the dmgMult bracket - and `mitigate` takes
   * the answer directly.
   *
   * Read as narrowly as every other script reader here. The write has to sit
   * in the skill's OWN `onDamageEval` (an owner-global hook would be about
   * every hit the owner lands, which is a different rider), and its guard may
   * ask for a rank and a slotted rune and nothing else. A looser shape reads
   * false - the hit keeps its armour, the under-read direction - and the
   * regression suite fails on any script in the sheet that writes the field
   * in a shape this does not answer, so it cannot go quiet.
   */
  function ignoresResistance(s, rank, runes) {
    // No cache of its own: `profile()` is the only caller and it is memoised
    // on the same skill, rank and runes.
    if (!s?.script || !/\.ignoreResistance\b/.test(s.script)) return false;
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const m of body.matchAll(/\b\w+\.ignoreResistance\s*=\s*true\b/g)) {
      const before = body.slice(0, m.index);
      const line = before.slice(before.lastIndexOf('function'));
      const head = /^function\s+onDamageEval\s*\(\s*(\w+)\s*\)/.exec(line);
      if (!head) continue;
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (rune && !runes?.has(rune)) continue;
      let rankOk = true;
      for (const r of line.matchAll(/\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g)) {
        const n = Number(r[2]);
        rankOk = rankOk && (r[1] === '>=' ? rank >= n : r[1] === '<=' ? rank <= n
          : r[1] === '>' ? rank > n : r[1] === '<' ? rank < n
            : r[1] === '==' ? rank === n : rank !== n);
      }
      if (!rankOk) continue;
      // Whatever the guard says beyond a rank and a rune is a condition this
      // cannot answer. `||` goes with it: a rank inside one alternative is
      // not a rank on the write.
      const rest = line.slice(head[0].length)
        .replace(/hasMastery\s*\([^)]*\)/g, ' ')
        .replace(/\brank\s*(?:>=|<=|==|!=|>|<)\s*\d+/g, ' ')
        .replace(new RegExp(`\\b(?:if|${head[1]})\\b`, 'g'), ' ')
        .replace(/[\s{}()&;]/g, '');
      if (rest.length) continue;
      return true;
    }
    return false;
  }

  /**
   * Armour a script takes off the hits of ONE NAMED SKILL.
   *
   *   // Staff_Censer_Passive ("Hidden Power"), rank text "Ignores [MagicArmor]."
   *   function onInflictDamageEval(hit) {
   *     if (rank >= 2 && hit.skillId == Skill.Staff_Censer_Ultimate) {
   *       hit.magicArmorIgnore = 1;
   *     }
   *   }
   *
   *   // Daggers_Demondash_Skill1 ("Infernal Plunge")
   *   function onDamageEval(hit) {
   *     if (rank >= 2) { hit.armorIgnore = vars.var1; hit.magicArmorIgnore = vars.var1; }
   *   }
   *
   * The two fields have one reader each, in getAffinityDamageReduction@4582:
   * ops 80-95 scale a MAGIC hit's resistance pool by
   * 1 - clamp(hit.magicArmorIgnore, 0, 1), ops 133-147 a PHYSICAL hit's by
   * 1 - clamp(hit.armorIgnore, 0, 1) - before penetration takes its own cut.
   * The talent reader in skills.mjs takes the `= vars.X` spelling on TALENT
   * rows and applies it by damage category; a non-talent row's write was
   * dropped on the floor (engine.mjs lets only the cooldown field through
   * from a non-talent source), and a literal on the right was matched by
   * nothing at all. So the Censer's Ultimate was priced through the boss's
   * full magic armour at every rank - 396 where the row says 661.
   *
   * WHOSE HITS is the hook's and the guard's: a write in the skill's own
   * `onDamageEval` is that skill's hits (evalDamage@6124 ops 0-5); one in
   * `onInflictDamageEval` rides every hit its owner lands (ops 71-123) and
   * is read here only where its guard names the one skill it is for -
   * `hit.skillId == Skill.X`, or `== skill.kind` for the row itself. An
   * owner-wide write that names no skill is the category reader's, not
   * this one's. The guard may also ask for a rank and a slotted rune;
   * anything else and the write is not read - the hit keeps its armour, the
   * under-read direction, and the gap reader names the clause.
   */
  function armourIgnoresOf(s, rank, runes, vars) {
    if (!s?.script || !/\.(?:armorIgnore|magicArmorIgnore)\b/.test(s.script)) return [];
    const body = String(s.script).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const out = [];
    const WRITE = /\b\w+\.(armorIgnore|magicArmorIgnore)\s*(\+=|=)\s*(?:vars\.([A-Za-z0-9_]+)|(\d*\.?\d+))\s*;/g;
    for (const m of body.matchAll(WRITE)) {
      const before = body.slice(0, m.index);
      const line = before.slice(before.lastIndexOf('function'));
      const head = /^function\s+(onDamageEval|onInflictDamageEval)\s*\(\s*(\w+)\s*\)/.exec(line);
      if (!head) continue;
      const rune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(line)?.[1];
      if (rune && !runes?.has(rune)) continue;
      const runeVars = rune ? (s.mastery ?? []).find((x) => x.id === rune)?.vars ?? null : null;
      const amount = m[3] ? (runeVars && m[3] in runeVars ? runeVars[m[3]] : vars?.[m[3]]) : Number(m[4]);
      if (!(typeof amount === 'number' && amount > 0)) continue;
      let rankOk = true;
      for (const r of line.matchAll(/\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g)) {
        const n = Number(r[2]);
        rankOk = rankOk && (r[1] === '>=' ? rank >= n : r[1] === '<=' ? rank <= n
          : r[1] === '>' ? rank > n : r[1] === '<' ? rank < n
            : r[1] === '==' ? rank === n : rank !== n);
      }
      if (!rankOk) continue;
      const NAMED = new RegExp(`\\b${head[2]}\\.skillId\\s*==\\s*(?:Skill\\.(\\w+)|skill\\.kind)`);
      const named = NAMED.exec(line);
      const skill = named ? (named[1] ?? s.id) : head[1] === 'onDamageEval' ? s.id : null;
      if (!skill) continue;
      // Whatever the guard says beyond a rank, a rune and the skill it names
      // is a condition this cannot answer; `||` and `!` go with it, since
      // neither a rank nor a skill test inside one of those is THE gate.
      const rest = line.slice(head[0].length)
        .replace(/hasMastery\s*\([^)]*\)/g, ' ')
        .replace(/\brank\s*(?:>=|<=|==|!=|>|<)\s*\d+/g, ' ')
        .replace(NAMED, ' ')
        .replace(new RegExp(WRITE.source, 'g'), ' ')
        .replace(new RegExp(`\\b(?:if|${head[2]})\\b`, 'g'), ' ')
        .replace(/[\s{}()&;]/g, '');
      if (rest.length) continue;
      out.push({
        field: m[1], root: m[1] === 'armorIgnore' ? 'Physical' : 'Magic',
        amount, set: m[2] === '=', skill,
      });
    }
    return out;
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
        if (r != null) fill = { scaling: [{ atb: 'MaxHealth', ratio: r, fromScript: true }] };
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

  // WHICH AREA STEPS ARE INSTANTIATED - given an object of their own in the
  // world (a SkillArea), which is what lands a hit at spawn and counts its
  // expected ticks by rounding. $AreaStep.__constructor__@15276, whole:
  //
  //   canInstantiate  = type == Area                               (ops 5-13)
  //   isTicking       = loop.tick != null && duration != 0         (ops 47-69)
  //   avoidInstance   = area.follow == Self
  //                     && (area.blocking || duration < 0)         (ops 70-102)
  //   isInstantiated  = canInstantiate && (area.telegraph != null
  //                     || area.travelTime > 0 || area.follow == Target
  //                     || props.multi != null
  //                     || (isTicking && !avoidInstance))          (ops 103-119)
  //
  // So a looping area that follows its owner for as long as the row lives
  // (duration -1) is NOT one: it is the step's own loop, which lands
  // floor(duration / tick) events and none at the start. Every aura a status
  // wraps its wearer in is written that way.
  // MEASURED 2026-10-13 (Priest, block D-skills-cycle1): Hive Swarm - ten
  // seconds, one tick a second - logged its first row 0.95 s after the press
  // that applied it and ten rows in all; Swirling Embers, eight seconds,
  // eight rows. Priced with a spawn hit each was read 11/10 and 9/8 too
  // large a tick, because the fight schedules floor(duration / tick) ticks
  // and divides the row's whole by that count: 49.2 and 109.0 a tick against
  // logged 44 and 95, and 43.9 and 95.0 without it. The spawn hit itself is
  // measured where the area IS instantiated (Wild Whirlwind follows its owner
  // for a fixed three seconds: 13 or 14 events where the loop alone gives 12).
  const followNames = cdb.enumValues('skill@steps@props@area', 'follow');
  for (const need of ['Target', 'Self']) {
    if (!followNames.includes(need)) {
      throw new Error(`skill@steps@props@area.follow has no ${need} case (${followNames.join(', ')}) - `
        + 'which looping areas are instantiated cannot be read without it');
    }
  }
  function areaInstantiated(skill, step, stepTypeName) {
    if (stepTypeName !== 'Area') return false;
    const area = step.props?.area ?? {};
    const follow = area.follow != null ? followNames[area.follow] ?? null : null;
    if (area.telegraph != null || skillVal(area.travelTime, skill, 0) > 0) return true;
    if (follow === 'Target' || step.props?.multi != null) return true;
    const duration = step.duration == null ? 0 : skillVal(step.duration, skill, 0);
    const ticking = step.props?.loop?.tick != null && duration !== 0;
    return ticking && !(follow === 'Self' && (area.blocking === true || duration < 0));
  }

  function hitsOf(skill, step, stepTypeName, ownDuration, stepLives) {
    const loop = step.props?.loop;
    let ticks = 1;
    let spread = false;
    let spreadMult = 1;
    if (loop && (loop.tick != null)) {
      spread = !!((loop.flags ?? 0) & LOOP_SPREAD) || stepTypeName === 'SelfEffect';
      const tick = skillVal(loop.tick, skill, 0.5); // the column's own default
      let span = skillVal(step.duration, skill, 0);
      // -1 means "until the owner ends", which for a status is its lifetime.
      if (span < 0 || span === 0) span = ownDuration;
      if (tick > 0 && span > 0) {
        // The interval schedule is the same N whichever way the loop starts:
        // SkillStep.start@5988 ops 113-133 applies a DIRECT_START at t=0 and
        // then schedules from 1.05 x tick, while a plain loop starts at
        // 0.95 x tick - both land floor(span/tick) interval events. The old
        // `+1` for DIRECT_START priced every such loop one tick high (all 9
        // authored DIRECT_START non-spread rows are foe skills, so it was a
        // tripwire, not a live error). The epsilon is not cosmetic: 9/3 can
        // float to 2.9999... and silently drop a third of the DoT.
        const N = Math.max(1, Math.floor(span / tick + 1e-9));
        // An INSTANTIATED area fires one extra hit AT SPAWN, before the loop:
        // SkillArea.startHit__impl@5263 ops 58-59, skipped only by
        // props.area.skipFirstTick. MEASURED on GS_Nova_Skill1 - 13/14 events
        // in the capture where the loop alone says 12 - and every looping
        // player area without a targetCooldown was short that hit. Only an
        // instantiated one (`areaInstantiated`): that hit is the SkillArea's,
        // and a loop that is the step's own has no object to land it.
        const instantiated = areaInstantiated(skill, step, stepTypeName);
        const spawnHit = instantiated && !step.props?.area?.skipFirstTick ? 1 : 0;
        ticks = N + spawnHit;
        // targetCooldown gates the SPAWN hit and the re-hits alike: the same
        // target may be touched at t=0 and then once per window, and a window
        // closing exactly at the step's end pays nothing (Smite ticks fifteen
        // times and touches each enemy once).
        const tc = step.props?.area?.targetCooldown;
        if (tc > 0) ticks = Math.min(ticks, 1 + Math.floor(span / tc - 1e-9));
        ticks = Math.max(0, ticks);
        // A SPREAD loop divides the declared TOTAL by the game's own divisor
        // ($HSkill.getStepEffectVal@21774 ops 121-138: v / max(1,
        // step.getExpectedTicks())), and every EVENT pays a share, the spawn
        // hit included. WHICH divisor is the step's class:
        //
        //   an instantiated Area   round(dur/tick), read at
        //                          AreaStep.getExpectedTicks@6076 op 40. So an
        //                          area spread loop pays (N + 1)/N x the
        //                          declared total (Radiant Verdict 1.25x,
        //                          Blazing Beam 13/12x).
        //   every other step       floor(dur/tick) - SkillStep.initTicks@5985
        //                          ops 31-35 write `baseExpectedTicks` with
        //                          std.math_floor, and AreaStep.initTicks@6070
        //                          leaves that to it unless the area is
        //                          instantiated, which only a type-Area step
        //                          can be ($AreaStep.__constructor__@15276 ops
        //                          5-13). The same N the loop lands, so the
        //                          declared total is paid exactly once.
        //
        // One rounding for both used to stand here, and it is a different
        // number wherever dur/tick ends in a half: Gash runs 9 s on a 2 s tick,
        // lands 4 ticks and was priced at 4/5 of its 0.35 x Dexterity.
        // MEASURED 2026-10-13 (Rogue, dummy, no talents): one stack ticks 17
        // with one other status on the target and 20 with three, five stacks
        // 82 and 90 - 0.35 x the mixed Dexterity over FOUR ticks to the
        // integer, where five reads 14, 16, 66 and 72. Six rows in the sheet
        // sit on a half (two a player's: Gash and Sharpen Arrow's status).
        const expected = instantiated ? Math.round(span / tick) : N;
        if (spread) spreadMult = ticks / Math.max(1, expected);
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
    return { ticks, spread, projectiles, mult: (spread ? spreadMult : ticks) * projectiles };
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

  // Where the cooldown clock, the resource cost and the charge actually
  // anchor: the EXEC STEP's start, not the button press. getCDStyle@9582 picks
  // "on exec-step start" for every player skill that has one; Skill.onStartStep@9630
  // fires tryConsumeCharge@9631 when the started step IS the exec step, which
  // triggers the cooldown and pays the cost. MEASURED 2026-08-21: GA_Demon_
  // Skill1 pressed on cooldown cycles at impact + 20.000s (48ms spread, n=6),
  // an exec delay of ~0.72s per cast the press-anchored model never billed -
  // cast-bar weapon skills cycle 9-16% slower in game than a press anchor
  // says.
  //
  // Selection lives in BaseSkill.getExecStep@6139 on build 25782799
  // (initSteps@6138 ops 57-58 only store its answer): the FIRST step, in
  // authored order, that is a candidate AND passes its static conditions
  // (ops 19-30: `(props.flags & 2 || isSkillExecutionStep(s.inf)) &&
  // s.checkStaticConds()`). A candidate is a step carrying the "TriggerCD"
  // bit, or one passing isSkillExecutionStep@21769: never Trigger/Code `on`,
  // never a rank/mastery-conditioned step (hasSkillConds@21767 - which does
  // NOT count `cond.weapons`); then by TYPE - the instant payload types
  // qualify, Channel qualifies, Cast only when castFlags & 4 (channelled);
  // Dash, Visuals, Summon, SelfEffect do not.
  //
  // The accepted build chose differently - its initSteps ran the test inline
  // (read on the 2026-08-11 build; initSteps@6138 is another body now, the one
  // cited above), a flagged step ALWAYS overwrote (last flagged wins) and
  // nothing looked at conditions. The two rules pick the same offset on
  // every row in the sheet today (three rows carry the bit at all); the
  // suite pins that, so the first row that separates them names itself.
  const EXEC_TYPES = new Set(['Mono', 'Status', 'Area', 'CastSkill', 'EffectTarget',
    'Projectile', 'Teleport', 'ItemEffect', 'Aura', 'SkillObject']);

  // Whether pressing this skill takes CONTROL of the hero - reported from
  // play (Swirling Embers and Depth Shield cast during autos; Eruption and
  // Hive's Sunder stop the combo cold) and read from the bytecode: goState
  // stays UseSkill until no PLANNED step is running or pending
  // (isInRecovery@6242 / isPreventingStop@5996 / isPlanned@5994), and only
  // planned `on`s - Start, CastEnd, a StepEnd chain - hold it. Event steps
  // (Hit, Code, ProjectileHit) never do. A skill whose planned span is zero -
  // a bare Status application, a pure script - never leaves Idle in any way
  // the swing chain can feel: it costs no clock and the chain plays on.
  // Nor does a row flagged NonInterupting, whatever its steps: the press goes
  // through ent.GameObject.doUseSkill@4651, whose ops 0-10 stop the running
  // skill unless that flag is set and whose ops 20-32 - since build 25959898 -
  // put the hero in the Skill state (set_goState) unless it is set too, so
  // the skill already running stays the hero's active one.
  const NON_INTERRUPTING = cdb.enumValues('skill', 'flags').indexOf('NonInterupting');
  function takesControlOf(skill) {
    if (NON_INTERRUPTING >= 0 && (((skill.flags ?? 0) >> NON_INTERRUPTING) & 1)) return false;
    const steps = skill.steps ?? [];
    if (steps.some((st) => typeof st.cond?.castHoldStep === 'number')) return true;
    const onCastEnd = stepOnNames.indexOf('CastEnd');
    const onStepEnd = stepOnNames.indexOf('StepEnd');
    let span = 0;
    for (const st of steps) {
      const on = st.on ?? 0;
      if (on !== 0 && on !== onCastEnd && on !== onStepEnd) continue;
      const tn = stepTypeNames[st.type ?? -1] ?? '';
      const start = Math.max(0, skillVal(st.delay, skill, 0));
      // A lingering step holds the hero only until it SPAWNS; its lifetime
      // runs unattended (an Area expires on its own, a Status just sits).
      const hold = LINGERING_STEPS.has(tn) ? 0 : Math.max(0, skillVal(st.duration, skill, 0));
      span = Math.max(span, start + hold);
    }
    return span > 1e-9;
  }
  // AN INSTANT CAST of the same row costs less clock, and three client
  // functions say how much less. BaseSkill.start@6145 ops 5-22: when the
  // skill's playInstantly (Skill.playInstantly@9626, the script's own
  // `shouldPlayInstantly`) or the caller's config says so, the cast's context
  // gets `castTimeFactor = 0`. Then
  //   * SkillStep.get_duration@5998 ops 21-41: a step of type Cast (enum
  //     index 3, the only type tested) lasts duration x
  //     getSpellCastTimeModifier x castTimeFactor - nothing;
  //   * SkillStep.canStart@5993 ops 16-47: on such a context
  //     (get_isInstantCast@5236) a Visuals step authored on Start and any
  //     step carrying `cond.skipWhenInstant` do not start at all;
  //   * Skill.evalDuration@9569 ops 1-19: the row's own duration loses the
  //     cast step's - the first step isCastStep@21823 accepts (Cast or
  //     Channel), in authored order.
  // Decoded by NAME: the suite pins that the three literals the bytecode
  // compares are still the cases named here.
  const instantSkips = (st) => st.cond?.skipWhenInstant === true
    || ((stepOnNames[st.on ?? 0] ?? '') === 'Start' && (stepTypeNames[st.type ?? -1] ?? '') === 'Visuals');
  const stepHold = (st, skill, instant) => (instant && (stepTypeNames[st.type ?? -1] ?? '') === 'Cast'
    ? 0 : Math.max(0, skillVal(st.duration, skill, 0)));
  function execOffsetOf(skill, staticOk = () => true, instant = false) {
    const steps = skill.steps ?? [];
    const onStart = 0;
    const onCastEnd = stepOnNames.indexOf('CastEnd');
    const onTrigger = stepOnNames.indexOf('Trigger');
    const onCode = stepOnNames.indexOf('Code');
    const conded = (st) => {
      const c = st.cond ?? {};
      return c.minRank != null || c.maxRank != null || c.equalRank != null
        || c.mastery != null || c.masteryExclude != null;
    };
    let exec = null;
    for (const st of steps) {
      let candidate = ((st.props?.flags ?? 0) & 2) !== 0;
      if (!candidate) {
        const on = st.on ?? 0;
        if (on === onTrigger || on === onCode || conded(st)) continue;
        const tn = stepTypeNames[st.type ?? -1] ?? '';
        const castFlags = st.props?.castFlags ?? 0;
        candidate = EXEC_TYPES.has(tn) || tn === 'Channel' || (tn === 'Cast' && (castFlags & 4) !== 0);
      }
      if (!candidate || !staticOk(st)) continue;
      exec = st;
      break;
    }
    if (!exec) return { offset: 0, anchor: 'press' };
    const delay = Math.max(0, skillVal(exec.delay, skill, 0));
    if ((exec.on ?? 0) === onCastEnd) {
      // The offset is the cast bar itself plus the exec step's own delay.
      let castEnd = 0;
      for (const st of steps) {
        if ((st.on ?? 0) !== onStart || conded(st) || !staticOk(st)) continue;
        const tn = stepTypeNames[st.type ?? -1] ?? '';
        if (tn !== 'Cast' && tn !== 'Channel') continue;
        castEnd = Math.max(castEnd,
          Math.max(0, skillVal(st.delay, skill, 0)) + stepHold(st, skill, instant));
      }
      return { offset: castEnd + delay, anchor: 'cast-end' };
    }
    return { offset: delay, anchor: 'exec-step' };
  }
  function occupancyOf(skill, typeName, wieldOk = () => true, instant = false) {
    let end = 0, lingering = 0;
    for (const st of skill.steps ?? []) {
      // A step the wielded weapon rules out is never started
      // (BaseSkill.start@6145 ops 55-58 gate each step on checkStaticConds),
      // so it cannot hold the hero: the Rogue's Finisher authors a ranged-only
      // 0.55s Wait that set the MELEE cast's span.
      if (!wieldOk(st)) continue;
      if (instant && instantSkips(st)) continue;
      const t = skillVal(st.delay, skill, 0) + stepHold(st, skill, instant);
      if (LINGERING_STEPS.has(stepTypeNames[st.type ?? -1] ?? '')) {
        if (t > lingering) lingering = t;
        continue;
      }
      if (t > end) end = t;
    }
    // The row's own duration, less the cast step's on an instant cast.
    let own = skillVal(skill.duration, skill, 0);
    if (instant && own > 0) {
      const castStep = (skill.steps ?? [])
        .find((st) => ['Cast', 'Channel'].includes(stepTypeNames[st.type ?? -1] ?? ''));
      const cast = castStep ? skillVal(castStep.duration, skill, 0) : 0;
      if (cast > 0) own -= cast;
    }
    // When a skill has NOTHING but lingering steps and declares no duration,
    // the area IS the cast - dropping to the 0.1s floor would make it free.
    if (end <= 0 && !(own > 0)) end = lingering;
    const span = Math.max(own, end, 0.1);
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
  //
  // `wield` is what the hero HOLDS, for the one step condition that asks:
  // `cond.weapons.isRanged`, new on build 25782799, is compared with the
  // main hand's moveSet (SkillStep.checkStaticConds@5991 ops 58-89:
  // `ownerUnit.getMoveSet().props.range`; Hero.getMoveSet@7830 is
  // activeWeapon.inf.type.moveSet and get_activeWeapon@7720 is get_weapon1,
  // slot "Slot_Weapon1"). Absent, the hero is read as holding nothing ranged -
  // which is what the game reads with an empty main hand (a null moveSet
  // casts to false at op 86). `wieldOf(loadout)` builds it.
  function profile(skillId, rank, runes = null, wield = null) {
    const ranged = wield?.ranged === true;
    const key = skillId + '@' + rank + (runes && runes.size ? '@' + [...runes].sort().join('+') : '')
      + (ranged ? '@ranged' : '');
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
    // It restates VARS as well, and that half was missing. `updateSkillInf@21787`
    // (HSkill.hx:374-382) loops the overrides and, for every one whose minRank
    // the rank clears, calls BOTH `applyProps(r.props)` at ops 54-56 AND
    // `applyVars(r.vars)` at ops 57-59; the anonymous fn@21789 (HSkill.hx:365-371,
    // bound at op 29) Reflect-sets each
    // field onto the accumulated vars, so a later override wins. About a
    // hundred rows carry override vars, and Domination is the one that shows
    // the cost: its register GA_Craft_Passive_Proc is `damage: 0.1` with
    // `rankOverride [{minRank: 2, vars: {damage: 0.15}}]` (on the accepted
    // build the passive itself was 0.15 -> 0.25 the same way), so every read
    // of the bare row understates it from rank 2 up - and `bench`'s default
    // rank is weaponSkillMaxRank, where the override is always in scope.
    let props = s.props ?? {};
    let vars = s.vars ?? {};
    // What the overrides and the slotted runes RESTATE, kept apart from the
    // row's own props: the override's props are their own four-field type
    // (cooldown, duration, maxStacks, charges - r43 in updateSkillInf@21787)
    // and `duration` exists only there. Four mob rows carry a stray
    // `props.duration` (a pasted step) that the game's props type cannot see.
    let restated = {};
    // AUTHORED order, not minRank order: updateSkillInf@21787 loops the array
    // as written and Reflect-merges every entry the rank clears, so a later
    // authored entry wins per-field whatever its minRank says. Every current
    // row is authored ascending, so the two orders agree today - this is the
    // order that keeps agreeing when one is not. Measured 2026-08-21:
    // GA_Demon_Skill1 cycles at exactly its rank-2 override (20s, not the
    // authored 25) - press-to-press = impact + 20.000s.
    for (const ov of s.props?.rankOverride ?? []) {
      if ((ov.minRank ?? 0) > rank) continue;
      props = { ...props, ...(ov.props ?? {}) };
      restated = { ...restated, ...(ov.props ?? {}) };
      vars = { ...vars, ...(ov.vars ?? {}) };
    }
    // A slotted rune's props win over the skill's own - and so do its VARS:
    // updateSkillInf@21787 ops 62-106 walk the slotted masteries and call,
    // for each, the same two appliers the rank overrides went through (op
    // 102 the props, op 105 applyVars, fn@21789), before any step's duration
    // or tick is resolved (ops 353 on). Six runes restate a key their row
    // also holds, and where a step reads that key the row's own value is
    // unobservable: Radiant Verdict's consecrated floor exists only under
    // Consecration, which says `dur2: 6` over the row's 8.
    // MEASURED 2026-10-13 (Priest, seven casts): the floor logs four rows a
    // cast - 0.34 s after the press, then 2, 4 and 6 s later - of 41 each at
    // Faith 141 with nothing else up, which is 0.8 x Faith over round(6 / 2)
    // = 3 expected ticks, paid at the spawn and at each of the three; read
    // at 8 s it was five rows of 31.
    const slotted = [];
    for (const m of s.mastery ?? []) {
      if (!runes?.has(m.id)) continue;
      slotted.push(m.id);
      props = { ...props, ...(m.props ?? {}) };
      restated = { ...restated, ...(m.props ?? {}) };
      if (m.vars && Object.keys(m.vars).length) vars = { ...vars, ...m.vars };
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

    // The columns typed `skillVal` resolve against the vars AS THE RANK LEFT
    // THEM, not the row's: updateSkillInf@21787 ops 277-322 copy the
    // accumulated vars onto the inf first and only then run every step's
    // `duration` (ops 353-355), `range` (356-358), `props.loop.tick`
    // (371-373) and every effect's `duration` (407-409) through evalVar
    // (fn@21790). Righteous Resolve's heal area loops on `tick: "dur1"`, 3
    // and 2 from rank 2; read against the bare row it ticked every 3 seconds
    // at every rank. (A stun step's `duration: "dur1"` was already resolved
    // at its rank, by the crowd-control reader's own lookup.)
    const sv = vars === s.vars ? s : { ...s, vars };

    // A status skill's own `duration` is its LIFETIME, which is the window its
    // looping steps tick over. For everything else it is the cast length.
    //
    // `props.rankOverride` restates it like any other prop: the same function,
    // ops 189-203, is `if (props.duration != null) inf.duration =
    // props.duration`, beside the cooldown at 156-170. Four player statuses
    // author one - Swarmstrike Accord 8s and 12 from rank 3, Abyssal Fury 8
    // and 10 from rank 2 - and the lifetime read off the row's own column was
    // the rank-1 value at every rank.
    const ownDuration = skillVal(restated.duration ?? s.duration, sv, 0);

    // THE WEAPON CONDITION. `cond.weapons.isRanged` picks between two
    // versions of a step by what is in the main hand: the Rogue's Finisher
    // authors a melee Area and a ranged Projectile, each 1 x Dexterity, and
    // the game starts exactly one of them (BaseSkill.start@6145 ops 55-58
    // call checkStaticConds@5991 per step; ops 58-89 are this test). Read
    // without it, both were summed and every Finisher hit twice.
    const wieldOk = (st) => {
      const w = st.cond?.weapons?.isRanged;
      return w == null || w === ranged;
    };
    // The STATIC conditions - the ones checkStaticConds@5991 answers once,
    // from the build: rank, mastery, and the weapon. They are what the
    // exec-step picker asks (getExecStep@6139 op 28); `stepLives` below adds
    // the play-time one.
    const staticOk = (st) => {
      const c = st.cond ?? {};
      // RANK ZERO BYPASSES THE RANK BLOCK ENTIRELY: matchesEffectConds@21780
      // ops 4-6 run the minRank/maxRank/equalRank tests only `if (0 <
      // viewRank)`. A status with no instigator skill views rank 0 and SUMS
      // rows that are mutually exclusive at any real rank (the Halos passive
      // reads 0.7 + 0.875 Int that way). profile(id, 0) is that reading;
      // callers pricing talent- or script-applied statuses should ask for it.
      if (rank > 0) {
        if (c.minRank != null && rank < c.minRank) return false;
        if (c.maxRank != null && rank > c.maxRank) return false;
        if (c.equalRank != null && rank !== c.equalRank) return false;
      }
      // Rune-gated: the step exists only while that rune is slotted.
      if (c.mastery && !runes?.has(c.mastery)) return false;
      if (c.masteryExclude && runes?.has(c.masteryExclude)) return false;
      return wieldOk(st);
    };
    // One gate, used both to pick which steps run and to count how many
    // projectiles a projectile-hit step is answering for.
    const stepLives = (st) => {
      const c = st.cond ?? {};
      if (typeof c.castHoldStep === 'number' && c.castHoldStep !== maxHold) return false;
      return staticOk(st);
    };

    const effects = [];
    const statusRefs = [];
    // Steps the CAST does not play.
    //
    // `skill@steps.on` has a `Code` case, and it means exactly what it says: the
    // step is played by `playStep(Steps.<id>)` from the row's own script and by
    // nothing else. Many steps of the sheet declare it, about half of them
    // with an amount of their own (the audit entry counts both off the
    // installed sheet), and every single one was being folded into its skill's cast
    // output - so a rider the game rolls on a chance was billed in full on
    // every combo finisher.
    //
    // GA_Craft_FinalCombo is the case that shows the shape. Its Area step is
    // 1.43 x Strength on Start - the tooltip's 133 - and its Mono step, `id:
    // "Attack"` and `on: Code`, is played by
    //
    //   function onInflictHit(hit) {
    //     if( rank >= 3 && hit.isFinalCombo) {
    //       if(checkProba(vars.chance)) { playStep(Steps.Attack, hit.target); }
    //     }
    //   }
    //
    // On build 25782799 that step is 0.9 x Strength and vars.chance is 0.25 -
    // the tooltip's "has a 25% chance to deal an additional" amount, on the
    // finisher. Until this build it was 0.3 x Strength at 0.15 behind
    // `hit.isBaseAttack`, "all your attacks have a 15% chance to deal an
    // additional 28", and that is the reading the measured 133-not-161 comes
    // from. Either way the cast is the Area step alone and the Attack step is
    // a separate rider on a separate clock - which is what the model's own
    // audit had flagged as a knowingly-wrong schedule and what `skills.mjs`
    // now reschedules through the same trigger machinery every other proc
    // uses. The ratio, the chance and the guard are all read off the row, so
    // the retune needed no change here.
    //
    // `Steps.<name>` is the step's own `id` column, not its type: 139 of the
    // 141 playStep call sites in the sheet name a step id on their own row.
    const scripted = [];
    // The steps of this row whose hit lands on its own caster - see below.
    const casterHits = [];
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
      // ...and on a looping status, only the Code steps the status's OWN
      // script plays. Lethal Poison's status (build 25782799) authors a loop
      // and a second step, `id: "Blast"`, `on: Code`, 1.5 x Dexterity
      // Physical - and its own script is empty. The step is played from
      // another row (`poison.playStep(Steps.Blast)` in the talent's
      // onTryAddStatus, compiled as a call to BaseSkill.playStep@6214 on the
      // Status with the string "Blast" - the callee is a server-only stub on
      // this client, the call and its argument are what is read), once per
      // re-application. Folded into `effects` it
      // would have been divided over the ten ticks by `dotOutput` and paid on
      // every one of them, in a second affinity: 0.55 x Dexterity a tick for
      // 0.4. Every other looping status row with a Code step names that step
      // in its own script (the water orbs, the firebreath reflect, the bee's
      // area), so they keep the folding they had.
      const ownScriptPlays = (id) => !!id && new RegExp('playStep\\s*\\(\\s*Steps\\.' + id + '\\b')
        .test(String(s.script ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '));
      const playedByScript = (stepOnName === 'Code' || stepOnName === 'Trigger')
        && (!s.props?.status || !rowLoops || !ownScriptPlays(st.id));

      const stepType = stepTypeNames[st.type ?? -1] ?? null;
      const hits = hitsOf(sv, st, stepType, ownDuration, stepLives);
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

      // A HIT OF THIS ROW THAT LANDS ON WHOEVER PLAYED IT. Two step shapes
      // make one: a SelfEffect step (SkillStep.doApply@6002 case 12, ops
      // 527-532: `hitEntity(baseSkill.owner)`) and an area whose filter
      // admits its own source (`filterAdmitsSelf`). Neither needs an effect
      // to be a hit - Blessing of Fervor's area carries none and its `on:
      // Hit` Status step still runs off it - and a hit is what raises onHit
      // and onInflictHit (hitEntity@6061 ops 130-137 -> BaseSkill.newHit@6237 ->
      // BaseSkill.onHit@6233), where a status applied by a script's
      // `addStatus(owner, ...)` or by a Status step (doApply case 1 ->
      // applyStatus@5999) raises neither. `lasts` is how long the step keeps
      // landing: a looping area hits again every tick for its duration.
      // Kept per step, with who plays it, so a caller can ask about the cast
      // or about one script-played step.
      if (stepType === 'SelfEffect' || (AREA_STEP_TYPES.has(stepType) && filterAdmitsSelf(area?.hitFilter))) {
        const tick = st.props?.loop?.tick != null ? skillVal(st.props.loop.tick, sv, 0.5) : 0;
        const every = Math.max(tick, area?.targetCooldown > 0 ? area.targetCooldown : 0);
        casterHits.push({
          stepId: st.id ?? null,
          by: playedByScript ? 'script' : 'cast',
          lasts: hits.ticks > 1 && every > 0 ? (hits.ticks - 1) * every : 0,
        });
      }

      // WHO the status goes to is an enum, and it travels as its NAME: read
      // by position, a case added or removed ahead of `Target` (the column
      // has grown a fourth, `SkillTarget`, since this was written) silently
      // turns every "applied to what was hit" into something else.
      if (st.props?.status?.ref) {
        statusRefs.push({
          ref: st.props.status.ref, on: stepOnNames[st.on ?? -1] ?? null,
          target: st.props.status.target == null ? null : statusTargetName(st.props.status.target),
        });
      }

      const into = playedByScript ? [] : effects;
      for (const e of st.effects ?? []) {
        const kind = effectNames[e.effect ?? -1] ?? null;
        if (!kind) continue;
        // A status carried by an EFFECT rides the hit: it lands on what was hit.
        if (e.status) statusRefs.push({ ref: e.status, on: stepOnNames[st.on ?? -1] ?? null, target: 'Target' });
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
          // ...and by its place in the row: two effects of ONE step are one
          // hit that deals two damage instances (see `landings` in castOutput).
          stepAt: s.steps.indexOf(st),
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
            range: skillVal(st.range, sv, 0),
            targetRange: area?.rangeScale?.targetRange ?? null,
            maxTargets: st.props?.hitCount ?? null,
            // The SECOND cap, which nothing read. `applyHitStrategy@6079`
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
          // The effect knocks what it hits (`sideEffects.knockBack`). Worth
          // nothing to the hit itself; a script can ride the knock
          // (onApplyKnockback), and the fight counts them off this.
          //
          // Only an entry that carries a FORCE - a push or a lift, of either
          // sign (Infernal Plunge slams down: knockUpForce -30 and no push).
          // A few entries author none: a two-handed sword's first two swings
          // write both as 0, Static Nova writes neither. Whether the server
          // raises the hook for a knock that moves nothing cannot be read -
          // the dispatcher, ent.Unit.applyKnock@4949, is a server-only stub
          // in this client, and the half that is left plays the knocked
          // animation only for a push above zero (ent.Unit.rpcApplyKnock__impl@4952
          // ops 66-74) - so those are kept apart, named, and not counted.
          knockBack: knockForce(e.sideEffects?.knockBack),
          knockNoForce: !!e.sideEffects?.knockBack && !knockForce(e.sideEffects.knockBack),
        });
      }
      // A script-played step is kept, whole, under the id the script names it
      // by - so `skills.mjs` can read the guard in front of `playStep` and put
      // the step on the clock the game actually gives it.
      if (playedByScript && into.length) scripted.push({ stepId: st.id ?? null, on: stepOnName, effects: into });
    }

    // `props.startSteps` chains: SkillStep.apply@6001 ops 9-46 play every
    // step an applied step's startSteps names, on the SAME event, after its
    // own payload. Crescent_FlowerSpiral's script plays StartBaseArea whose
    // startSteps carry BaseArea - the child's effects sat in `scripted` under
    // the child's own id, where no playStep site names them, so the whole
    // press payload priced at zero as "no rate". Re-keying a chained child
    // under the ROOT the script actually plays gives it the root's clock and
    // guard; chains resolve transitively.
    {
      const byStepId = new Map();
      for (const st of s.steps ?? []) if (st.id) byStepId.set(st.id, st);
      // Seed from EVERY named step, not just the ones that carry effects: the
      // played root can be a bare launcher (StartBaseArea has no payload of
      // its own), and it is the root's id a playStep site names.
      const queue = [...byStepId.keys()].map((id) => ({ rootKey: id, from: id }));
      const seenChain = new Set();
      while (queue.length) {
        const { rootKey, from } = queue.shift();
        const parent = from ? byStepId.get(from) : null;
        for (const entry of parent?.props?.startSteps ?? []) {
          const childId = entry?.step ?? entry;
          const key = rootKey + '>' + childId;
          if (seenChain.has(key)) continue;
          seenChain.add(key);
          const donor = scripted.find((x) => x.stepId === childId);
          if (donor?.effects?.length) scripted.push({ stepId: rootKey, effects: donor.effects, viaStartStep: childId });
          queue.push({ rootKey, from: childId });
        }
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
      // SkillContext.initVars@5241 seeds with its source's (1 + fervor + mastery) - the
      // orb is worn by the character who applied it, so carrier and
      // instigator are one unit here and the build change is moot - the
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
        tick: skillVal(looping.props.loop.tick, sv, 0.5),
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

    const swingPlay = swingPlayOf(s);

    p = {
      id: skillId,
      name: s.texts?.name ?? skillId,
      type: typeName,
      nature: natureName,
      cooldown: num(props.cooldown, num(s.cooldown)),
      occupancy: occupancyOf(sv, typeName, wieldOk),
      // The cooldown/cost anchor - see execOffsetOf. The press-to-press cycle
      // of a cooldown skill is execOffset + cooldown, never cooldown alone.
      ...(() => { const e = execOffsetOf(sv, staticOk); return { execOffset: e.offset, execAnchor: e.anchor }; })(),
      // What the same press costs when the game plays it INSTANTLY - see
      // `instantSkips`. Only on a row whose script declares
      // shouldPlayInstantly; WHEN that holds is the rotation's to read. Read
      // against the rank's vars (`sv`), like the press it is the other form of.
      instant: /\bfunction\s+shouldPlayInstantly\b/.test(s.script ?? '')
        ? { occupancy: occupancyOf(sv, typeName, wieldOk, true), execOffset: execOffsetOf(sv, staticOk, true).offset }
        : null,
      // Whether the press takes the hero's control - see takesControlOf. A
      // control-free cast rides alongside the swing chain: zero occupancy,
      // no chain reset.
      takesControl: takesControlOf(s),
      // Whether using it interrupts the skill already running, and which
      // ('All' | 'AllButSelf' | 'WeaponAttacks'), or null: it waits for that
      // skill to end. See `interruptStyleNames`.
      interrupts: props.interruptStyle == null ? null : (interruptStyleNames[props.interruptStyle] ?? null),
      // A row that IS a status prices as a status tick: its hits run in the
      // STATUS's own SkillContext, built once when the status starts, and
      // WHOSE sheet seeds that context is the question castOutput answers
      // (the instigator's on this build - see `tickSource` there).
      isStatusTick: !!s.props?.status,
      // WHETHER ITS TICKS CAN CRIT is a narrower rule than "it is a status",
      // and the model over-generalised it for its whole life. SkillContext.initVars@5241
      // zeroes ctx.critChance only for statuses whose statusType carries the
      // DoT or HoT flag - Bleed, Burn, Poison, Hemorage-via-parent,
      // HealOverTime - walked through the type's parent chain (ops 3-33).
      // Everything else rolls the crit chance of the context's SOURCE (ops
      // 34-43). Measured on the 2026-08-11 build, when the source was the
      // carrier: Purging Strikes, self-worn, crits at 11.6% live and Infernal
      // Plunge's aura at 12.7%, while the Luon Mark on a dummy logged 51
      // lumps and no crit. Which unit the source is moved in build 25782799
      // and is priced in castOutput; this flag is only the type rule.
      tickCanCrit: !!s.props?.status
        && !(s.props.status.types ?? []).some((t) => statusTypeDotOrHot(t.type)),
      // Whether the unit WEARING the status is the build's own character: a
      // Buff, and not also a Debuff. Two things still read it - the
      // owner-carried script rider (`mods.ownStatusTick`, a hook on statuses
      // the owner wears, nothing to do with the context) and the accepted
      // build's carrier rule under `--tick-source carrier`.
      tickCarrierSelf: !!s.props?.status
        && (s.props.status.types ?? []).some((t) => t.type === 'Buff')
        && !(s.props.status.types ?? []).some((t) => t.type === 'Debuff'),
      // WHICH swing fires the tick - PurgingStrikes' status plays its damage
      // step synchronously inside onInflictDamage, gated on the swing being a
      // base attack or the combo finisher, and lands 0-1ms after it. Read
      // narrowly - the exact guard-then-playStep shape, nothing looser
      // (`swingPlayOf`, which also says which step, behind which roll).
      tickOnSwing: swingPlay?.on ?? null,
      swingPlay,
      // ...and whether the played step is itself AN ATTACK to a script that
      // asks `hit.isBaseAttack`. ScriptHitData.get_isBaseAttack@6292 asks the
      // hit's STEP (ops 0-3), and SkillStep.isBaseAttack@6027 answers with
      // the step's own BaseAttack flag (ops 0-9) or else its base skill's
      // type (ops 10-13) - and the base skill of a status's step is the
      // status, which has no type. So a rider written "on your attacks"
      // (Zealous Fighter: `if (hit.isBaseAttack || hit.isFinalCombo)
      // hit.critChance += vars.chance`) reaches a swing-played step only
      // where the step carries the flag, as Abyssal Fury's blast does.
      // MEASURED 2026-10-13 (Priest, Zealous Fighter 2 for +8, a sheet of
      // 7.5% and Crusader's +10 a fifth of the time): the sword's swings crit
      // 82 times in 538 (15.2%) and Purging Strikes' hits 30 in 302 (9.9%).
      // HISTORY: this keyed every swing-played tick on its swing's category,
      // on the accepted 2026-08-11 build's capture ("swings 15.5%, their
      // ticks live ~16%"). That reading is that build's.
      tickStepIsAttack: !!swingPlay && cdb.flagNames('skill@steps@props', 'flags',
        (s.steps ?? []).find((x) => x.id === swingPlay.stepId)?.props?.flags ?? 0).includes('BaseAttack'),
      // Which of its steps hit the hero who plays them, and for how long.
      casterHits,
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
      // Its own hits skip the target's resistance pool - see the reader.
      ignoresResistance: ignoresResistance(s, rank, runes),
      // Armour its script takes off one named skill's hits - its own, or the
      // one an owner-wide hook names. The rotation gathers these from every
      // row the build owns and the pricing site looks its own skill up.
      armorIgnores: armourIgnoresOf(s, rank, runes, vars),
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
      // (Whether this cast applies crowd control to what it hits used to be
      // a flag here, read off `statusRefs` alone. It is `opts.ccOwn` now -
      // one reader, `crowdControlOf` in skills.mjs, which also sees the
      // script routes this could not. See where `castOutput` asks.)
      // Steps this cast does NOT play - see the note where they are collected.
      scripted,
    };
    profileCache.set(key, p);
    if (profileCache.size > 20000) profileCache.delete(profileCache.keys().next().value);
    return p;
  }

  // --- reference targets ---------------------------------------------------
  // Foes express armour the same way classes do: as a target damage REDUCTION,
  // in `unit.stats[].specScaling.armorReduction` / `.magicReduction`. The game
  // turns that intent into a resist POOL at the unit's level -
  // $HAttributes.getResistanceLevelScaling@21638 ops 2-34:
  // red x (a + b x L) / (1 - red), [a, b] = ResistanceScalableReductionFormula -
  // and divides it at the STRIKER's (getAffinityDamageReduction@4582). So a
  // target is fully described by the coefficient S = red / (1 - red) and the
  // level it stands at, and both come out of the data, not out of this file.
  //
  // The archetype ladder most of the world inherits from, as each row authors
  // it - and, because a unit's own row replaces its parent's (armourIntent
  // below), as each one resolves:
  //
  //   W_Assassin 0.20  <  W_Base_Small / D_Base_Small 0.25  <  W_Base 0.30
  //     <  W_Base_Big / W_Base_Unique / D_Base_Big 0.35  <  W_Base_Elite 0.40
  //     =  every boss that authors its own row
  //
  // Two things worth knowing, both straight out of that table:
  //
  //   * Physical and magical reduction are equal on every real foe EXCEPT the
  //     golems and one boss. Golem_Base declares an Armor multiplier of 1.6
  //     and no MagicArmor, so every golem that inherits it is harder to hit
  //     than to burn - 0.4068 against 0.30 off a W_Base parent, 0.4628 off a
  //     Unique one, 0.5161 off an Elite. The rest author their split
  //     outright: the dev punching bags, deliberately (PunchingBagArmor is
  //     0.5/0, PunchingBagMagicRes is 0/0.5), and R1KoboldBoss_Sparkling
  //     ("Snack of Ratsar"), whose own Armor row is `value: 0` under a W_Base
  //     parent - the one Armor row it is left with, scaling to nothing, so it
  //     is 0 physical against 0.30 magical. So ArmorPenetration and
  //     SpellPenetration are worth the same against everything else in the
  //     game; against a golem physical penetration is worth materially more,
  //     and against that boss it is worth nothing.
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
  // `DataCache.initUnits@19817` builds a closure (fn@19874; ops 22-29 capture
  // the mode, the cache and the closure itself for the recursion) and runs it
  // over every unit row. That closure iterates EVERY entry of `inherit` (ops
  // 12-17), not just the first - and most unit rows declare two or three.
  // The shape is consistently (archetype, species):
  // Boar_Z2W_2 inherits [W_Base, Boar_Z1W], so following only the first parent
  // finds the world-trash base and never the boar.
  //
  // Each parent is resolved first (op 51 recurses), then merged field-wise:
  //
  //   a row of the child whose `heroic`
  //   is set and is not the mode   -> removed before anything merges (ops 85-110)
  //   no matching attribute        -> deep-copy the parent's row      (ops 155-162)
  //   the child's row is a MODIFIER-ONLY stub - no value, no
  //   levelScaling, no specScaling - -> drop the stub, take the parent's
  //                                   row, and MULTIPLY the two
  //                                   multipliers together             (ops 163-204)
  //   otherwise                    -> the child's row stands, except
  //                                   that a null multiplier or
  //                                   levelMultiplier is filled from
  //                                   the parent                       (ops 205-218)
  //   two rows of one attribute
  //   left on the child            -> the game THROWS "Unit <id> has <n>
  //                                   lines for attribute <atb> in its
  //                                   stats, there can only be one!"   (ops 219-264)
  //
  // Because the merge only ever fills what is still null, a child beats its
  // parents and an earlier `inherit` entry beats a later one.
  //
  // `heroic` is three-state on a row: absent = both modes, false = normal
  // only, true = heroic only. The mode itself is `difficulty == 2`
  // (st.GameLayer.isHeroicMode@7661 ops 0-8, the index of Heroic in the
  // customType ActivityDifficulty), and the whole unit table is re-merged for
  // it ($DataCache.reload@19820 op 16 hands the mode to initUnits). The
  // game's filter sits inside the inherit loop, so a unit with no parent
  // would keep every row; no unit that carries a heroic-keyed row is one (a
  // test holds that), so filtering every unit here is the same thing.
  // A MODIFIER-ONLY stub: a stat row that authors no value, no levelScaling
  // and no specScaling (closure ops 163-172), so all it can carry is a
  // multiplier for the row it lands on.
  const isModifierOnly = (row) => row.value == null
    && (row.levelScaling ?? []).length === 0
    && row.specScaling == null;
  const statsCache = new Map();
  function mergedStats(id, heroic = false, seen = new Set()) {
    const key = heroic ? `${id}@heroic` : id;
    const hit = statsCache.get(key);
    if (hit) return hit;
    const u = units.get(id);
    if (!u) return [];
    const inMode = (rows) => (rows ?? [])
      .filter((s) => s.heroic == null || s.heroic === heroic).map((s) => ({ ...s }));
    // The game throws on a unit inheriting itself (ops 32-39). Cycles through
    // a longer path are not checked there and would hang here, so they stop.
    if (seen.has(id)) return inMode(u.stats);
    seen.add(id);

    const out = inMode(u.stats);
    for (const inh of u.inherit ?? []) {
      // A text-only parent contributes names and descriptions, never stats
      // (ops 52-57 jump past the whole numeric merge).
      if (inh?.textOnly) continue;
      if (!inh?.ref) continue;
      for (const ps of mergedStats(inh.ref, heroic, seen)) {
        const at = out.findIndex((x) => x.attribute === ps.attribute);
        if (at < 0) { out.push({ ...ps }); continue; }
        const existing = out[at];
        if (isModifierOnly(existing)) {
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
    statsCache.set(key, out);
    return out;
  }

  // A unit's `flags` are merged too: every bit a non-text parent carries is
  // OR-ed into the child (the same closure, ops 266-289), so a flag is read
  // off the whole inheritance closure and never off the row alone.
  const flagsCache = new Map();
  function mergedFlags(id, seen = new Set()) {
    const hit = flagsCache.get(id);
    if (hit != null) return hit;
    const u = units.get(id);
    if (!u || seen.has(id)) return 0;
    seen.add(id);
    let bits = u.flags ?? 0;
    for (const inh of u.inherit ?? []) {
      if (inh?.textOnly || !inh?.ref) continue;
      bits |= mergedFlags(inh.ref, seen);
    }
    seen.delete(id);
    flagsCache.set(id, bits);
    return bits;
  }

  // Crowd-control immunity is three unit flags. `ent.Foe.isCCImmune@7071` is
  // `inf.flags & 16 || inf.flags & 32 || inf.flags & 8` (ops 0-22; anything
  // else falls to ent.GameObject.isCCImmune@4643, a constant false), and bits
  // 4, 5 and 3 of `unit.flags` are Boss, Miniboss and Elite on this build.
  // They are found by NAME here, so a patch that reorders the column moves
  // the mask with it, and one that drops a name fails loudly instead of
  // testing somebody else's bit.
  const unitFlagNames = cdb.enumValues('unit', 'flags');
  const CC_IMMUNE_FLAGS = ['Elite', 'Boss', 'Miniboss'];
  const ccImmuneMask = CC_IMMUNE_FLAGS.reduce((mask, name) => {
    const bit = unitFlagNames.indexOf(name);
    if (bit < 0) {
      throw new Error(`unit.flags no longer has a "${name}" case - crowd-control immunity `
        + '(ent.Foe.isCCImmune) cannot be read off the unit rows (game data changed?)');
    }
    return mask | (1 << bit);
  }, 0);
  const ccFlagsOf = (id) => CC_IMMUNE_FLAGS.filter((n) => mergedFlags(id) & (1 << unitFlagNames.indexOf(n)));

  // isCCImmune is NOT the whole of "can crowd control land". A status is
  // admitted by ent.Unit.canReceiveStatus@4922 - the override every Foe runs
  // (it is the only override of ent.GameObject.canReceiveStatus@4634) - and
  // that function turns a STUN away on more units than isCCImmune names. In
  // order:
  //
  //   ops 0-57   `inf.flags & 524288` (bit 19 of unit.flags, NoStun) and the
  //              status carries a type that is, or descends from, the
  //              statusType "Stun" (the string op 7 loads; the parent chain
  //              is walked at ops 41-51)                 -> refused, whoever
  //                                                         applies it
  //   ops 58-64  `inf.type == "Critter"`                 -> EVERY status is
  //                                                         refused
  //   ops 65-76  `inf.flags & 32768` (bit 15, Invulnerable), the source is
  //              not the unit itself and not its ally
  //              (proto 132 = isAllyWith)                -> every status is
  //                                                         refused
  //   op 77      ent.GameObject.canReceiveStatus@4634: the source is someone
  //              else, the status type carries the statusType flag
  //              CrowdControl ($HSkill.hasStatusFlag@21820, bit 1, parents
  //              walked) and isCCImmune() (proto 154)    -> refused
  //
  // So a unit that is none of Elite / Boss / Miniboss can still be one no
  // stun stands on - and that is the common case for the heavy trash: most
  // of what is built from W_Base_Big and D_Base_Big carries NoStun, and an
  // immunity flag far more rarely. A root or a slow lands on those; a stun
  // does not.
  //
  // The names are looked up, never the bits: the two flags in unit.flags,
  // the type among the types the unit rows carry, and whether Stun itself is
  // crowd control in statusType.flags. One that is gone is a loud failure,
  // because the game's test would then be reading something this function
  // is not.
  const unitFlagBit = (name, reads) => {
    const bit = unitFlagNames.indexOf(name);
    if (bit < 0) {
      throw new Error(`unit.flags no longer has a "${name}" case - ${reads} cannot be read off the unit rows (game data changed?)`);
    }
    return 1 << bit;
  };
  const noStunMask = unitFlagBit('NoStun', 'which units refuse a stun (ent.Unit.canReceiveStatus)');
  const invulnerableMask = unitFlagBit('Invulnerable', 'which units refuse every status (ent.Unit.canReceiveStatus)');
  const STATUS_DEAF_TYPE = 'Critter';
  if (!cdb.lines('unit').some((u) => u.type === STATUS_DEAF_TYPE)) {
    throw new Error(`no unit row is of type "${STATUS_DEAF_TYPE}" any more - the unit type that refuses every status `
      + '(ent.Unit.canReceiveStatus) cannot be read off the unit rows (game data changed?)');
  }
  const stunIsCrowdControl = (() => {
    const types = cdb.byId('statusType');
    if (!types.has('Stun')) {
      throw new Error('the statusType sheet no longer has a "Stun" row - which statuses a NoStun unit refuses '
        + '(ent.Unit.canReceiveStatus) cannot be read (game data changed?)');
    }
    const ccBit = cdb.enumValues('statusType', 'flags').indexOf('CrowdControl');
    if (ccBit < 0) {
      throw new Error('statusType.flags no longer has a "CrowdControl" case - what a crowd-control immune unit refuses '
        + '(ent.GameObject.canReceiveStatus) cannot be read (game data changed?)');
    }
    const seen = new Set();
    for (let t = types.get('Stun'); t && !seen.has(t.id); t = types.get(t.parent)) {
      if ((t.flags ?? 0) & (1 << ccBit)) return true;
      seen.add(t.id);
    }
    return false;
  })();
  // A unit's type is its own; the merge takes a parent's only where the row
  // has none (fn@19874 ops 58-63), which no row is on this build.
  const mergedType = (id, seen = new Set()) => {
    const u = units.get(id);
    if (!u || seen.has(id)) return null;
    if (u.type != null) return u.type;
    seen.add(id);
    for (const inh of u.inherit ?? []) {
      if (inh?.textOnly || !inh?.ref) continue;
      const t = mergedType(inh.ref, seen);
      if (t != null) return t;
    }
    return null;
  };
  // Why a stun another unit applies is refused on this unit - every reason
  // that holds, in the order the game tests them; empty when it lands.
  const stunRefusalsOf = (id) => {
    const flags = mergedFlags(id);
    const out = [];
    if (flags & noStunMask) out.push('NoStun');
    if (mergedType(id) === STATUS_DEAF_TYPE) out.push(`type ${STATUS_DEAF_TYPE}`);
    if (flags & invulnerableMask) out.push('Invulnerable');
    const immune = stunIsCrowdControl ? ccFlagsOf(id) : [];
    if (immune.length) out.push(`crowd-control immune (${immune.join(', ')})`);
    return out;
  };

  // Who inherits whom, for the two questions only the whole sheet can answer:
  // is this row an archetype other units are built from, and what do the
  // units built from it look like.
  const childrenOf = new Map();
  for (const u of cdb.lines('unit')) {
    for (const inh of u.inherit ?? []) {
      if (inh?.textOnly || !inh?.ref) continue;
      if (!childrenOf.has(inh.ref)) childrenOf.set(inh.ref, []);
      childrenOf.get(inh.ref).push(u.id);
    }
  }
  function heirsOf(id) {
    const out = new Set();
    const walk = (x) => {
      for (const c of childrenOf.get(x) ?? []) {
        if (out.has(c)) continue;
        out.add(c);
        walk(c);
      }
    };
    walk(id);
    return [...out];
  }
  // Who SUMMONS whom, for the level a summoned unit stands at (spawnLevelOf
  // below). Every summon path in the client ends in
  // ent.GameObject.spawnFoe@4698, which hands world.World.spawnFoe@10518 the
  // summoner's own level (ops 28-30: `level = this.get_level()`, proto 110)
  // - so a summon never rolls its level off its row. Three things reach it,
  // and all three are in data.cdb:
  //
  //   a skill step       `skill.steps[].props.summon.unit`: the skill's
  //                      owner summons it (st.skill.SkillStep.doApply@6002
  //                      ops 1082-1151 -> ent.GameObject.summonFoe@4699)
  //   a skill script     `requestSummonFoe(Unit.X, ...)` / `spawnFoe(Unit.X,
  //                      ...)`: the skill's owner unless the call names
  //                      another source, which none does on this build
  //                      (script.SkillScript.requestSummonFoe@6899 ops 16-37,
  //                      script.SkillScript.spawnFoe@6900 ops 16-36)
  //   a unit script      `summonFoe(Unit.X, ...)`: that unit
  //                      (script.UnitScript.summonFoe@15676)
  //
  // The summoner of a skill's summon is whoever carries the skill: a unit row
  // through `skills` - which a row with none takes whole from its first
  // parent that has some (the unit merge, fn@19874 ops 72-79) - or a hero,
  // through a class row or an item. Skills started by other skills
  // (`targetSkill`, a status) are not followed: whose level such a summon
  // takes was not read, and no unit with an armour intent is summoned only
  // that way on this build.
  const SUMMON_CALL = /\b(?:requestSummonFoe|summonFoe|spawnFoe)\s*\(\s*Unit\.([A-Za-z_]\w*)/g;
  const summonedUnits = new Set();
  const summonersOf = new Map();
  {
    const summonsOfSkill = new Map();
    const note = (map, key, value) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(value);
    };
    for (const s of cdb.lines('skill')) {
      for (const st of s.steps ?? []) {
        if (st?.props?.summon?.unit) note(summonsOfSkill, s.id, st.props.summon.unit);
      }
      for (const m of String(s.script ?? '').matchAll(SUMMON_CALL)) note(summonsOfSkill, s.id, m[1]);
    }
    const skillsOf = (id, seen = new Set()) => {
      const u = units.get(id);
      if (!u || seen.has(id)) return [];
      const own = (u.skills ?? []).map((k) => k?.skill).filter(Boolean);
      if (own.length) return own;
      seen.add(id);
      for (const inh of u.inherit ?? []) {
        if (inh?.textOnly || !inh?.ref) continue;
        const inherited = skillsOf(inh.ref, seen);
        if (inherited.length) return inherited;
      }
      return [];
    };
    for (const set of summonsOfSkill.values()) for (const id of set) summonedUnits.add(id);
    for (const u of cdb.lines('unit')) {
      for (const s of skillsOf(u.id)) {
        for (const id of summonsOfSkill.get(s) ?? []) note(summonersOf, id, u.id);
      }
      for (const m of String(u.script ?? '').matchAll(SUMMON_CALL)) {
        summonedUnits.add(m[1]);
        note(summonersOf, m[1], u.id);
      }
    }
  }
  // The hero units - the same shape the catalog reads its classes off. A
  // hero's summon stands at the hero's level, which here is the striker's.
  const isHeroUnit = (id) => (units.get(id)?.props?.aptitudes ?? []).length > 0 && !units.get(id)?.props?.foe;

  // An ARCHETYPE BASE: a row that authors no level of its own, that other
  // units inherit (W_Base, D_Base_Big, Golem_Base ...) and that nothing
  // summons. Nothing spawns it; it is a template, so the bench stands it at
  // the attacker's level and reads its crowd-control immunity as a census of
  // its heirs, stated as such.
  const isArchetypeBase = (id) => units.get(id)?.lvl == null && childrenOf.has(id) && !summonedUnits.has(id);

  // ARMOUR IS ONE ROW - the unit's own when it authors one, the nearest
  // inherited otherwise. It is NOT a sum over the inheritance closure.
  //
  // The client says so twice. The merge above keeps a child's reduction row
  // and only fills its null multiplier / levelMultiplier from the parent; a
  // parent's row is copied only when the child has none for that attribute or
  // carries a modifier-only stub; and two surviving rows of one attribute are
  // a thrown error. And the read is of a single row:
  // $DataCache.getStatInfo@19835 builds an IntMap keyed by attribute (ops
  // 25-45, a later row overwrites), and ent.Unit.getAtbLevelScaling@4882
  // takes that one row's specScaling (ops 11, 49-102), runs it through
  // getResistanceLevelScaling at the unit's level (136-148), multiplies by
  // the row's multiplier (149-159) and by the levelMultiplier entry for that
  // level (160-204), and ROUNDS (205).
  //
  // The pre-patch capture says so too. For one hero and one skill, two
  // archetypes logged at the SAME target level share the level factor, so
  // only S differs; and wherever the two readings ORDER a pair oppositely - a
  // unit with its own 0.25 or 0.20 row under an inherited 0.30, against a
  // plain 0.30 unit - the direction of the observed ratio decides, whatever
  // the striker's level and penetration were. Non-crit single hits from hero
  // sources over the 562,531 rows that carry tlvl (2026-08-22 .. 08-28): 201
  // such pairs with no Elite / Boss / Miniboss / Unique unit on either side,
  // 186 of them softer as the single row says, 10 harder as a sum would have
  // it, 5 ties; median ratio 1.073 where one row predicts 1.071 at parity and
  // the sum 0.811.
  //
  // What stood here until the 2026-10 build was the sum - every reduction row
  // of the closure adding red/(1-red) - fitted on 2026-08-11 to boss windows,
  // jointly with a spawn level per family. The 83 pairs with a boss or an
  // elite on one side show where that came from: there the special unit takes
  // MORE than either reading allows (53 of 83). INFERRED, not read: everyone
  // in the party is shredding the thing everyone is hitting, the target's
  // live armour was never logged, and a sum and a fitted level between them
  // absorbed it.
  // Stated limits of the evidence: 19 heroes; the target's debuff state is
  // not in the log; and the 0.35 tier reads softer than its row (at level 25
  // a plain 0.30 unit takes 0.973x what an own-0.35-under-0.30 one does over
  // 27 pairs, where one row says 1.077 and the sum said 1.377 - closer to
  // the row, on neither). One clean swing in game is still owed - see the
  // audit.
  //
  // A modifier-only stub (Golem_Base's Armor x1.6: no value, no scaling)
  // lands its multiplier on the one row the merge leaves - the golem numbers
  // in the header are m x red / (1 - red) re-expressed as a reduction.
  const intentCache = new Map();
  function armourIntent(unitId, heroic = false) {
    const key = heroic ? `${unitId}@heroic` : unitId;
    const hit = intentCache.get(key);
    if (hit) return hit;
    const rows = mergedStats(unitId, heroic);
    const side = (atb, field) => {
      let row = null;
      for (const s of rows) if (s.attribute === atb) row = s;
      if (!row) return { S: 0, declared: false, levelMultiplier: null };
      // A row with no reduction - R1KoboldBoss_Sparkling ("Snack of Ratsar")
      // authors Armor `value: 0` under a W_Base parent - still DECLARES the
      // attribute: it is the unit's one row, and it scales to nothing
      // (getResistanceLevelScaling returns 0 for a missing reduction, ops
      // 2, 35-36). So does a row authoring reduction zero (the punching
      // bags): a target that mitigates nothing is not the same as a unit
      // with no armour intent at all.
      const red = row.specScaling?.[field];
      const declared = red != null || row.value != null;
      const S = red > 0 ? ((row.multiplier ?? 1) * red) / (1 - red) : 0;
      // A flat `value` other than 0 is armour this function does not turn
      // into a pool - no unit authors one on this build, and where the game
      // adds it to the scaled part was not read. Carried so that foe() can
      // refuse such a unit by name instead of pricing it as unarmoured.
      return { S, declared, levelMultiplier: row.levelMultiplier ?? null, flat: row.value ?? 0 };
    };
    const p = side('Armor', 'armorReduction');
    const m2 = side('MagicArmor', 'magicReduction');
    const out = {
      physS: p.S, magS: m2.S,
      // The level-parity DISPLAY reduction S/(1+S), for humans and headers.
      phys: p.declared ? p.S / (1 + p.S) : null,
      mag: m2.declared ? m2.S / (1 + m2.S) : null,
      physLevelMultiplier: p.levelMultiplier, magLevelMultiplier: m2.levelMultiplier,
      physFlat: p.flat ?? 0, magFlat: m2.flat ?? 0,
    };
    intentCache.set(key, out);
    return out;
  }

  // Every unit whose intent is declared or inherited, so `--target <unitId>`
  // works for anything in the world.
  const targetsByUnit = new Map();
  for (const u of cdb.lines('unit')) {
    const i = armourIntent(u.id);
    if (i.phys == null && i.mag == null) continue;
    targetsByUnit.set(u.id, i);
  }

  // The units whose physical and magical reduction DIFFER, by why they do -
  // found by shape, never by id, so a renamed or a second stub row is still
  // found. `stubOwners` are the rows that author a modifier-only Armor or
  // MagicArmor row with no equal twin on the other school (Golem_Base: Armor
  // x1.6 and nothing for MagicArmor); `byStub` the split units built from one
  // of them; `authored` the split units that are not, whose own rows say two
  // different things outright.
  const armourSplits = (() => {
    const stubOf = (u, atb) => (u.stats ?? [])
      .find((s) => s.attribute === atb && s.heroic !== true && s.multiplier != null && isModifierOnly(s));
    const stubOwners = cdb.lines('unit').filter((u) => {
      const p = stubOf(u, 'Armor');
      const m2 = stubOf(u, 'MagicArmor');
      return (p || m2) && p?.multiplier !== m2?.multiplier;
    }).map((u) => u.id);
    const builtFromStub = (id, seen = new Set()) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return stubOwners.includes(id) || (units.get(id)?.inherit ?? [])
        .some((inh) => !inh?.textOnly && inh?.ref && builtFromStub(inh.ref, seen));
    };
    const split = [...targetsByUnit].filter(([, i]) => i.phys != null && i.mag != null && i.phys !== i.mag).map(([id]) => id);
    return {
      stubOwners,
      byStub: split.filter((id) => builtFromStub(id)),
      authored: split.filter((id) => !builtFromStub(id)),
    };
  })();

  // The difficulty a target is fought at, under the game's own names
  // (customType ActivityDifficulty: Normal, Veteran, Heroic on this build).
  // Two things hang off it and nothing else that a target carries:
  //
  //   * WHICH ROWS: Heroic reads the heroic stat rows (mergedStats).
  //   * WHICH LEVEL: in Veteran and in Heroic every foe a spawner creates is
  //     made at round(Const.Hero.MaxLevel) whatever its row says -
  //     ent.FoeGenerator.spawnUnit@7528 ops 40-76 (`difficulty == 1`, or
  //     heroic), the same test in world.World.spawnFoe@10518 for scripted
  //     summons and in st.Activity.getLevel@10293.
  //
  // `scaled` is not a difficulty. It is an activity flagged DynamicScaling
  // (activity@props.flags, bit 7): ent.GameObject.receiveHit@4540 ops 0-15
  // then stamps the hit with the INSTIGATOR's level, and
  // ent.Unit.computeDamage@4920 ops 59-68 runs the whole reduction inside
  // target.asLevel(that level) - the pool is built at the striker's level,
  // whatever the unit spawned at. The activity rows are not in data.cdb (the
  // sheet is empty there; they ship in the level prefabs, where the three
  // rift activities carry the flag - read 2026-10-08, and not something this
  // tool opens), so the bench cannot know which unit stands in one: it is
  // something the caller says.
  const difficultyCases = (cdb.customTypes.get('ActivityDifficulty')?.cases ?? []).map((c) => c.name);
  const MODES = {
    normal: { name: 'Normal', heroicRows: false, levelFrom: 'row' },
    veteran: { name: 'Veteran', heroicRows: false, levelFrom: 'max' },
    heroic: { name: 'Heroic', heroicRows: true, levelFrom: 'max' },
    scaled: { name: 'dynamic scaling', heroicRows: false, levelFrom: 'striker' },
  };
  function modeOf(token) {
    const mode = MODES[token];
    if (!mode) {
      throw new Error(`unknown target mode "@${token}". Modes: ${Object.keys(MODES).map((m) => '@' + m).join(', ')}.`);
    }
    if (mode.levelFrom === 'max' && !difficultyCases.includes(mode.name)) {
      throw new Error(`this build's ActivityDifficulty has no ${mode.name} case `
        + `(it reads ${difficultyCases.join(', ') || 'nothing'}) - "@${token}" cannot be resolved (game data changed?)`);
    }
    return mode;
  }

  // The level a unit stands at when nothing else is said - Normal difficulty,
  // no dynamic scaling. A spawner passes its own `props.level` or -1
  // (spawnUnit@7528 ops 28-39), and at -1 the unit constructor rolls
  // `lvl + floor(random x (max(lvl, maxLvl) - lvl + 1))` with `lvl` and
  // `maxLvl` defaulting to 1 (ent.$Unit.__constructor__@15927 ops 135-165).
  // `lvl` is the unit's own: the merge above never copies it from a parent.
  //
  //   the row authors lvl          -> that level, the middle of lvl..maxLvl
  //                                   when the row has a range (the pool is
  //                                   linear in the level, so the middle of
  //                                   the range is the mean pool)
  //   an archetype base            -> the attacker's level (it is a template)
  //   a row without lvl that
  //   something summons            -> its SUMMONER's level: a summon is
  //                                   never handed -1 (the summon graph
  //                                   above). Each summoner is resolved by
  //                                   these same rules; several at different
  //                                   levels give a span, and the unit
  //                                   stands in the middle of it. A hero's
  //                                   summon, and one whose summoner no unit
  //                                   row accounts for, stands at the
  //                                   attacker's level and says so.
  //   any other row without lvl    -> 1, the constructor's default
  //
  // The log agrees wherever it looked: of the 300 unit archetypes the
  // pre-patch capture carries a target level for, 296 were only ever logged
  // at their row's lvl..maxLvl, at their summoners' levels or at 25
  // (Veteran). The Dummy - no lvl, nothing summons it, five spawners in the
  // two hubs, none of which names a level - was logged at level 1 on all
  // 5,013 rows; the two level-less summons it met were logged at 25 and 24,
  // where the faerie casters that open a Chaotic Portal stand (ChaoticPortal
  // on 3,180 rows, and ImpDemon_Summoned, which that portal summons in its
  // turn, on 2,291), and never at 1. The four left over are two hero rows
  // and two units logged at 20 against a row of 18.
  //
  // Two things this still cannot see. The seven spawners in the game that DO
  // name a level are prefab data. And a row that authors a level AND is
  // summoned is priced at its row, though a summoned copy of it takes its
  // summoner's level like any other: such a row may also be placed in the
  // world, which is prefab data again, and where the two levels differ the
  // audit names the unit. A caller who knows better passes the level.
  //
  // What stood here before was a table of FITTED levels per family (rift
  // 6.9, arena 7.9, dungeon-Z1D 12), fitted jointly with the armour sum and
  // retired with it: the logged levels contradict every one they match
  // (Ratsar 10 on 525 rows, the rift units 25 on 75k), and `^Phrixes` had
  // started matching five units this build added.
  //
  // `levelSpanOf` answers with a span or with "the attacker's level"; the
  // `seen` set stops a summon loop, which says nothing about a level.
  function levelSpanOf(unitId, seen = new Set()) {
    const u = units.get(unitId);
    if (u?.lvl != null) return { lo: u.lvl, hi: Math.max(u.lvl, u.maxLvl ?? 1), from: 'row' };
    if (isHeroUnit(unitId)) return { striker: true, from: 'hero' };
    if (isArchetypeBase(unitId)) return { striker: true, from: 'base' };
    if (!summonedUnits.has(unitId)) return { lo: 1, hi: 1, from: 'default' };
    const hosts = [...(summonersOf.get(unitId) ?? [])].filter((h) => !seen.has(h));
    seen.add(unitId);
    let lo = Infinity;
    let hi = -Infinity;
    const placed = [];
    const atStriker = [];
    for (const h of hosts) {
      const span = levelSpanOf(h, seen);
      if (span.striker) { atStriker.push(h); continue; }
      placed.push(h);
      lo = Math.min(lo, span.lo);
      hi = Math.max(hi, span.hi);
    }
    seen.delete(unitId);
    // Summoners that disagree in KIND - a hero and a placed foe - leave no
    // span to stand in the middle of; neither do no summoners at all.
    if (!placed.length || atStriker.length) return { striker: true, from: 'summon', hosts, placed, atStriker };
    return { lo, hi, from: 'summon', hosts };
  }
  function spawnLevelOf(unitId) {
    const span = levelSpanOf(unitId);
    const list = (ids) => (ids.length > 3 ? `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more` : ids.join(', '));
    if (span.from === 'row') {
      return {
        at: (span.lo + span.hi) / 2,
        note: span.hi > span.lo ? ` @L${span.lo}-${span.hi} (unit row)` : ` @L${span.lo} (unit row)`,
        why: 'unit row',
      };
    }
    if (span.from === 'base') return { at: null, note: '', why: 'archetype base, at your level' };
    if (span.from === 'hero') return { at: null, note: '', why: 'a hero, at your level' };
    if (span.from === 'summon' && span.striker) {
      return {
        at: null, summoned: true, note: '',
        why: !span.hosts.length
          ? 'summoned, and no unit row carries the skill that summons it (a hero does, through a class or an item, or nothing): at your level'
          : span.placed.length
            ? `summoned at your level by ${list(span.atStriker)} and at another by ${list(span.placed)}: taken at your level`
            : `summoned by ${list(span.atStriker)}, at your level`,
      };
    }
    if (span.from === 'summon') {
      return {
        at: (span.lo + span.hi) / 2, summoned: true,
        note: span.hi > span.lo ? ` @L${span.lo}-${span.hi} (its summoners')` : ` @L${span.lo} (its summoner's)`,
        why: `summoned: its summoner's level - ${list(span.hosts)}, level ${span.hi > span.lo ? `${span.lo} to ${span.hi}` : span.lo}`,
      };
    }
    return {
      at: 1, note: ' @L1 (no lvl on the row)',
      why: 'no lvl on the row and nothing summons it: level 1, the unit constructor\'s default',
    };
  }

  // The heroic bosses of this build: the units that author a heroic loot
  // table (unit.props.heroicLootTable) in a dungeon whose Heroic is released.
  // The column alone stopped saying the second half on build 25959898: it
  // linked the four `_HM` tables that had been authored ahead of their mode,
  // and two of those dungeons (Chakram's Chapel, Honeyzabeth's Hivetrunk)
  // still mark heroicReleaseStatus Development in the install's level
  // prefabs - and their bosses carry no heroic stat row. The release is read
  // where the loot side reads it (sources.mjs heroicOf: the dungeon's activity
  // row beside the spawner that names the boss, judged by
  // $HData.checkStatus@21563). A boss that gate keeps shut is held apart; one
  // the level files cannot place, or no level file at all, keeps its place,
  // because "not released" cannot be said without them.
  const heroicAuthored = cdb.lines('unit').filter((u) => u.props?.heroicLootTable).map((u) => u.id);
  const heroicGate = heroicAuthored.length ? buildSources(cdb).heroicOf : null;
  const heroicState = new Map(heroicAuthored.map((id) => [id, heroicGate(id)]));
  const heroicAhead = heroicAuthored.filter((id) => heroicState.get(id).known && heroicState.get(id).open === false)
    .map((id) => ({ id, why: heroicState.get(id).why }));
  const heroicUnjudged = heroicAuthored.filter((id) => !heroicState.get(id).known)
    .map((id) => ({ id, why: heroicState.get(id).why }));
  const heroicBosses = heroicAuthored.filter((id) => !heroicAhead.some((x) => x.id === id));
  // `heroic` names what those bosses resolve to in Heroic. They agree today
  // (0.40 / 0.40, most of them on a row they only have in that mode - the
  // audit counts them); the shortcut
  // stands on the most common resolution and says how many share it, so the
  // day one of them diverges the label stops claiming to speak for all.
  const heroicNamed = (() => {
    const groups = new Map();
    for (const id of heroicBosses) {
      const i = armourIntent(id, true);
      const k = `${i.physS}/${i.magS}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(id);
    }
    const best = [...groups.values()].sort((x, y) => y.length - x.length)[0];
    return best ? { unit: best[0], share: best.length, of: heroicBosses.length } : null;
  })();

  const expected = cdb.constant('Armor_ExpectedReduction');
  // Named shortcuts, each pointing at a real unit rather than a made-up
  // number - except the two that are not units at all: `reference` stays
  // because it is the designers' own constant, and `none` is the target that
  // mitigates nothing, stated as a number so that "unmitigated" never again
  // means "whatever the Dummy row says this month".
  //
  // `parity` on an entry is a statement of intent: this shortcut means the
  // archetype AT YOUR LEVEL, which is where Veteran, Heroic and a rift put a
  // max-level character's target anyway. A shortcut without it stands where
  // its unit row puts it.
  const NAMED = {
    none: { phys: 0, mag: 0, label: 'no mitigation' },
    // The training dummy is a unit like any other, and since the 2026-10
    // build its row authors 0.40 / 0.40 (it was 0 / 0, and every "0-armour
    // dummy" calibration before that build stood on it). It also has no lvl,
    // so it stands at level 1: a pool of 323 against a level-25 striker's
    // 2,885 is 10%, not 40% and not zero.
    dummy: { unit: 'Dummy', label: 'training dummy' },
    reference: { phys: expected, mag: expected, label: `Armor_ExpectedReduction ${expected}` },
    trash: { unit: 'W_Base', label: 'world trash', parity: true },
    small: { unit: 'W_Base_Small', label: 'small world mob', parity: true },
    big: { unit: 'W_Base_Big', label: 'big world mob', parity: true },
    elite: { unit: 'W_Base_Elite', label: 'world elite', parity: true },
    // The authored boss intent, 0.40/0.40, at YOUR level.
    //
    // `boss` used to point at Ratsar under a fitted spawn level of 6.9, and
    // because the resist POOL is built at the target's level while the
    // divisor uses the striker's, that froze the default's armour at 1,177
    // while a level-25 character's divisor grew to 2,885. The tool's own
    // headline target mitigated 29%, SOFTER than world trash at 30%, which
    // quietly priced penetration at roughly half its worth against the
    // content anyone is actually gearing for.
    //
    // Ulserous is a named boss that authors the 0.40 row itself and inherits
    // no archetype at all, so nothing about the ladder can move it. Its row
    // says level 13; the shortcut says parity. `--target Ulserous` and
    // `--target Ratsar` name the units where their rows put them.
    boss: { unit: 'Ulserous', label: 'named boss', parity: true },
    dungeon: { unit: 'D_Base_Big', label: 'dungeon mob', parity: true },
    ...(heroicNamed ? { heroic: { unit: heroicNamed.unit, label: 'heroic dungeon boss', mode: 'heroic' } } : {}),
  };

  // `level` is the ATTACKER's level; the level the foe stands at is a
  // separate dial because the game's formula uses both: the pool is built at
  // the target's level and divided at the striker's, so "authored 0.40" is
  // 40% only when the two agree. In order: an explicit `targetLevel` wins;
  // then the mode (`name@veteran`, `name@heroic`, `name@scaled`); then the
  // shortcut's own parity; then the unit row (spawnLevelOf).
  function foe(name, level, targetLevel = null) {
    let base = String(name);
    let modeToken = null;
    const cut = base.lastIndexOf('@');
    if (cut > 0) { modeToken = base.slice(cut + 1); base = base.slice(0, cut); }
    const named = Object.hasOwn(NAMED, base) ? NAMED[base] : null;
    modeToken ??= named?.mode ?? 'normal';
    const mode = modeOf(modeToken);

    let S, label, unitId = null, intent = null;
    const unitIntent = !named && units.has(base) ? armourIntent(base, mode.heroicRows) : null;
    if (named?.unit) {
      unitId = named.unit;
      intent = armourIntent(unitId, mode.heroicRows);
      S = { phys: intent.physS, mag: intent.magS };
      label = `${named.label} (${unitId}: S ${S.phys.toFixed(2)}/${S.mag.toFixed(2)})`;
    } else if (named) {
      // An intent stated as a number - the designers' reference constant, or
      // nothing at all - and not a unit: no row, no flags, no rounding.
      S = { phys: named.phys / (1 - named.phys), mag: named.mag / (1 - named.mag) };
      label = base === 'none' ? named.label : `${base} (${named.label})`;
    } else if (unitIntent && (unitIntent.phys != null || unitIntent.mag != null)) {
      unitId = base;
      intent = unitIntent;
      S = { phys: intent.physS, mag: intent.magS };
      label = `${unitId} (S ${S.phys.toFixed(2)}/${S.mag.toFixed(2)})`;
    } else {
      throw new Error(
        `unknown target "${base}". Named: ${Object.keys(NAMED).join(', ')}. ` +
        'Any unit id with a declared armour intent also works, and any target takes a mode ' +
        `(${Object.keys(MODES).filter((m) => m !== 'normal').map((m) => '@' + m).join(', ')}) - see \`bench targets\`.`
      );
    }
    // Refused rather than priced as unarmoured: a merged row that authors a
    // flat armour VALUE is armour the pool below does not contain.
    if (intent && (intent.physFlat || intent.magFlat)) {
      throw new Error(`target "${unitId}" authors a flat armour value on its unit row `
        + `(Armor ${intent.physFlat}, MagicArmor ${intent.magFlat}), which the target model does not read - `
        + 'only a reduction intent (specScaling) is turned into a pool. Name another unit, or `none`.');
    }

    let at, levelWhy, lvlNote;
    if (targetLevel != null) {
      at = targetLevel;
      levelWhy = 'given';
      lvlNote = ` @L${targetLevel}${mode.heroicRows ? ` (${mode.name} rows)` : ''}`;
    } else if (mode.levelFrom === 'max') {
      at = Math.round(ctx.consts.maxLevel);
      levelWhy = `${mode.name}: MaxLevel`;
      lvlNote = ` @L${at} (${mode.name})`;
    } else if (mode.levelFrom === 'striker') {
      at = level;
      levelWhy = 'dynamic scaling: built at the striker\'s level';
      lvlNote = ` @L${at} (dynamic scaling)`;
    } else if (unitId && !named?.parity) {
      const sp = spawnLevelOf(unitId);
      at = sp.at ?? level;
      levelWhy = sp.why;
      lvlNote = sp.at == null && sp.summoned ? ` @L${level} (a summon, at your level)` : sp.note;
    } else {
      at = level;
      levelWhy = 'at your level';
      lvlNote = '';
    }

    // The pool. A unit's is what Unit.getAtbLevelScaling@4882 returns: the row's
    // multiplier is already in S, the levelMultiplier entry is the LAST one
    // whose level the unit has reached (ops 160-204), and the result is
    // rounded (op 205) - 323, not 323.33, on the level-1 Dummy. An intent
    // that is not a unit has no row to round.
    const [a, b] = ctx.consts.resistFormula;
    const pool = (coef, levelMultiplier) => {
      let v = coef * (a + b * at);
      if (!unitId) return v;
      let last = null;
      for (const e of levelMultiplier ?? []) { if (at >= e.level) last = e; else break; }
      if (last?.multiplier != null) v *= last.multiplier;
      return Math.round(v);
    };

    // Crowd-control immunity: read off the unit's merged flags when the
    // target is a unit that spawns, and a CENSUS of its heirs when it is an
    // archetype base, whose own flags are empty by construction - the flag
    // sits on the leaves. `elite` is the case that matters: W_Base_Elite
    // carries no flag and most, not all, of the units built from it do, so
    // its immunity is an assumption about which elite you meant and is
    // labelled as one.
    //
    // `stunImmune` is the other half (stunRefusalsOf above): whether a STUN
    // someone else applies is refused. It is true wherever ccImmune is, as
    // long as Stun is itself crowd control in statusType.flags, and true
    // besides on every unit that carries NoStun - so ccImmune false does NOT
    // mean every crowd control lands, and `big` and `dungeon` are the
    // shortcuts where the two part: nearly all of their heirs carry NoStun
    // and a minority, or none, an immunity flag.
    let ccImmune = false;
    let ccImmuneWhy = 'not a unit: no flags, so crowd control lands';
    let stunImmune = false;
    let stunImmuneWhy = 'not a unit: no flags and no type, so a stun lands';
    if (unitId && isArchetypeBase(unitId)) {
      const heirs = heirsOf(unitId);
      const flagged = heirs.filter((h) => mergedFlags(h) & ccImmuneMask).length;
      ccImmune = flagged * 2 > heirs.length;
      ccImmuneWhy = `assumed from its heirs: ${flagged} of the ${heirs.length} units built from ${unitId} `
        + `carry ${CC_IMMUNE_FLAGS.join(', ')}`;
      const refusing = heirs.filter((h) => stunRefusalsOf(h).length > 0).length;
      const noStun = heirs.filter((h) => mergedFlags(h) & noStunMask).length;
      stunImmune = refusing * 2 > heirs.length;
      stunImmuneWhy = `assumed from its heirs: ${refusing} of the ${heirs.length} units built from ${unitId} `
        + `refuse a stun (${noStun} carry NoStun)`;
    } else if (unitId) {
      const has = ccFlagsOf(unitId);
      ccImmune = has.length > 0;
      ccImmuneWhy = has.length ? `unit flags: ${has.join(', ')}` : `unit flags: none of ${CC_IMMUNE_FLAGS.join(', ')}`;
      const refusals = stunRefusalsOf(unitId);
      stunImmune = refusals.length > 0;
      stunImmuneWhy = refusals.length
        ? `unit row: ${refusals.join(', ')}`
        : `unit row: no NoStun, not type ${STATUS_DEAF_TYPE}, not Invulnerable, none of ${CC_IMMUNE_FLAGS.join(', ')}`;
    }

    return {
      name: label + lvlNote,
      unit: unitId,
      mode: modeToken,
      physReduction: S.phys / (1 + S.phys), magicReduction: S.mag / (1 + S.mag),
      level, spawnLevel: at, levelWhy,
      armor: pool(S.phys, intent?.physLevelMultiplier),
      magicArmor: pool(S.mag, intent?.magLevelMultiplier),
      // `ccImmune` is ent.Foe.isCCImmune and nothing wider: what a skill
      // script gets when it asks `target.isCCImmune()`, and the units that
      // refuse EVERY CrowdControl-flagged status someone else applies
      // (ent.GameObject.canReceiveStatus@4634 ops 0-7). False is not "all
      // crowd control lands": `stunImmune` says whether a stun does
      // (ent.Unit.canReceiveStatus@4922 ops 0-76 on top of the above), and a
      // rider that pays for a stun standing on the target wants that one.
      // Both are always booleans; the `Why` strings say read or assumed.
      ccImmune, ccImmuneWhy,
      stunImmune, stunImmuneWhy,
      // Hero-sourced damage is also cut by (1 - target Resilience/100), with
      // NO Raw guard - computeDamage@4920 ops 88-115. Exactly one unit row
      // in the game authors Resilience (BaseHero, 70) and its heirs are the
      // four classes and Dummy_Support ("Ally dummy"), so this reads 0
      // against every foe - the term is here so the first patch that gives
      // a foe Resilience moves the answer instead of silently not.
      resilience: unitId
        ? (mergedStats(unitId, mode.heroicRows).find((s) => s.attribute === 'Resilience')?.value ?? 0)
        : 0,
    };
  }

  // --- one cast ------------------------------------------------------------
  // How ONE scaling entry is priced is $HSkill.getStepEffectScaling@21777,
  // and three numbers in it come out of the data rather than out of here:
  //
  //   itemRatio      ops 2-35: clamp01(Const.Skills.WeaponPowerRatio.
  //                  MainhandWeaponSkill) when the granting item's type chain
  //                  reaches MainhandWeapon, 1 under GearTrinket, else 0. The
  //                  constant's own description: "Percent of AP/SP scaling
  //                  that are replaced by a flat amount coming from the 'base
  //                  damage' of the weapon".
  //   the keep       ops 92-118: an attribute whose row is flagged ItemScaling
  //                  keeps clamp01(1 - itemRatio) of its ratio; the other
  //                  itemRatio arrives as a flat off the item
  //                  (getStepEffectItemScaling@21779).
  //   the selectors  two attribute ids are resolved by NAME and never off the
  //                  sheet: "AllAttributes" (ops 119-188) and "WeaponPower"
  //                  (ops 189-200). See `scalingValue`.
  //
  // The constant not resolving is a loud failure, not a default of 0.4.
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const itemRatio = (() => {
    const v = (cdb.row('constant', 'WeaponPowerRatio').v?.group ?? [])
      .find((g) => g.id === 'MainhandWeaponSkill')?.v?.float;
    if (typeof v !== 'number') {
      throw new Error('cdb: constant WeaponPowerRatio has no MainhandWeaponSkill ratio (game data changed?)');
    }
    return clamp01(v);
  })();
  const attrKeep = clamp01(1 - itemRatio);
  // The two attribute flags this pricing turns on are tested by NAME on each
  // row below, so a row that really drops one follows the game. A flag CASE
  // that is renamed or removed is a different event and must not look like
  // it: every row would then test false at once, and without a word
  // `weaponPowerFor` hands every weapon a flat of 0 (ItemScaling) or every
  // AllAttributes scaling prices 0 (MainAttribute). So the names resolve
  // against the column here, loudly, the way `equipConditionBit` does.
  for (const name of ['ItemScaling', 'MainAttribute']) {
    if (!cdb.enumValues('attribute', 'flags').includes(name)) {
      throw new Error(`cdb: attribute.flags has no ${name} case (game data changed?)`);
    }
  }
  // The WeaponPower ROW carries ItemScaling since build 25782799 (flags 0 ->
  // 512, nothing else on the row changed), so its attribute half takes the
  // keep like any other item-scaled attribute. Read off the flag by name, so
  // a build whose row drops it prices the accepted rule's full mean again.
  const weaponPowerKeep = ctx.attrTable.byId.get('WeaponPower')?.flags.has('ItemScaling') ? attrKeep : 1;
  // "AllAttributes" expands to the attributes flagged MainAttribute (ops
  // 122-153 filter Data.attribute.all on bit 8192, the flag's position;
  // decoded here by name). Strength, Dexterity, Faith and Intellect today.
  const mainAttributes = ctx.attrTable.attrs.filter((a) => a.flags.has('MainAttribute')).map((a) => a.id);

  /**
   * What one scaling entry's attribute is WORTH - the number its ratio
   * multiplies. Three branches, in the game's order:
   *
   *   AllAttributes  the MEAN of the MainAttribute-flagged attributes, read
   *                  off the source's sheet: `v += src.atb(a) * (1/n) * ratio`
   *                  per attribute (ops 154-181). Nothing grants the stat -
   *                  no affix row targets it and the row has no scaling - so
   *                  the sheet's own `AllAttributes` is 0 and reading it
   *                  priced all 19 scalings that name it at nothing. Its row
   *                  carries no ItemScaling, so it takes no item share
   *                  whatever grants the skill.
   *   WeaponPower    the weapon's flat (`weaponPowerFor`, already on the
   *                  sheet) plus the mean of the ITEM's aptitude primaries at
   *                  the keep: convertWeaponPowerScaling@21781 divides the
   *                  ratio by the aptitude count (ops 51-55) and sums
   *                  src.atb(primary) x that (ops 69-77), and the ratio it is
   *                  handed has already been through ops 92-118.
   *                  HISTORY: on the accepted 2026-08-11 build the row had no
   *                  ItemScaling flag and the mean was added WHOLE. The
   *                  expanded tooltips of that build render the old rule -
   *                  Beefury (Fighter+Cleric) "(13 + 6.5% Strength + 6.5%
   *                  Faith)", Wingsabers "(22 + 10.25% Strength + 10.25%
   *                  Intellect)" - and Judgement swung 78-95. The same
   *                  tooltips read "(6 + 3.9% + 3.9%)" and "(11 + 6.15% +
   *                  6.15%)" under this rule; nobody has read them on this
   *                  build yet, which is what the audit entry asks for.
   *   anything else  the sheet's value - and, for a WEAPON skill's
   *                  item-scaled attribute, the keep of it plus itemRatio of
   *                  THAT ATTRIBUTE's own budget curve. The flat being
   *                  per-attribute is what Tear settled: 0.45 x (0.6x49 +
   *                  0.4x123.6[Strength curve]) + 0.45 x (0.6x46 +
   *                  0.4x148.3[Dexterity curve]) = 74.6 against a measured
   *                  75, where one shared Strength flat prices 70.5. Measured
   *                  on the accepted build: Rampage 233/371/556, Brutal
   *                  Frenzy 133, Tear 75. This branch did not change.
   *                  `itemShare` is the item ratio of whatever granted the
   *                  skill: the constant for a weapon (the default), 1 for a
   *                  TRINKET (getStepEffectScaling@21777 ops 27-35), whose
   *                  item-scaled attributes therefore keep nothing of the
   *                  wearer's sheet and price off the item's level alone.
   *
   * `sheet` is anything with a Map-shaped `get`. Exported, because ui/api.mjs
   * prices tooltips off raw rows and must not carry a second copy of this.
   */
  function scalingValue(atb, sheet, swingAttrs = null, weaponMixFlats = null, itemShare = itemRatio) {
    if (atb === 'AllAttributes') {
      if (!mainAttributes.length) return 0;
      let sum = 0;
      for (const id of mainAttributes) sum += sheet.get(id) ?? 0;
      return sum / mainAttributes.length;
    }
    let v = sheet.get(atb) ?? 0;
    if (atb === 'WeaponPower' && swingAttrs?.length) {
      let sum = 0;
      for (const id of swingAttrs) sum += sheet.get(id) ?? 0;
      return v + weaponPowerKeep * (sum / swingAttrs.length);
    }
    if (weaponMixFlats) {
      const f = weaponMixFlats.get(atb);
      if (f) v = clamp01(1 - itemShare) * v + itemShare * f;
    }
    return v;
  }

  function amountOf(effect, sheet, swingAttrs = null, weaponMixFlats = null, itemShare = itemRatio) {
    let a = effect.baseVal;
    // An AUTHORED row whose FIRST scaling entry is MaxHealth reads the HIT
    // TARGET's sheet for every entry: getStepEffectVal@21774 ops 40-60 set
    // scaleSource to hit.target instead of the instigator's proxy. So what it
    // prices depends on who is hit, and that splits by effect kind:
    //
    //   Damage   lands on the foe, and a foe carries no player-style sheet
    //            here. All 11 such rows are environment or trap damage
    //            (Burning, Drowning, Bleeding, Poisoned, the two Trap rows,
    //            the geysers and cliff defenders) that no build deals, so
    //            they price zero WITH THIS NOTE rather than reading the
    //            caster's health as the victim's.
    //   Heal /   lands on whoever the step targets, and in a solo fight
    //   Shield   that is the caster: Spark Shield is a Status step with
    //            `target: Self` and reads "::ref1_var2%:: of your
    //            [MaxHealth]", Rage Shield is `addStatus(owner, ...)`. The
    //            target IS the caster, so the caster's sheet is the right
    //            one. 15 effects (8 Shield, 7 Heal). Seven of them sit on
    //            rows nothing a hero owns refers to (foe skills such as
    //            Chaos Shield, and an ore affix) and would read the hero's
    //            sheet if profiled directly - no build reaches them.
    //
    // The gate used to cover all three kinds on the claim that every such
    // row was foe or environment damage. That was false - Heal and Shield
    // rows have that shape too - and it priced Spark Shield, Rage Shield
    // and Chrono Reset's rune heal at a silent zero. The regression suite
    // walks the references from every hero-owned row and fails the day one
    // of them reaches a Damage row of this shape. The script-derived fills
    // (`owner.maxHealth * vars.x`) are caster-sourced by construction and
    // carry fromScript to stay that way.
    const targetSourced = effect.kind === 'Damage'
      && effect.scaling[0]?.atb === 'MaxHealth' && !effect.scaling[0]?.fromScript;
    for (const s of effect.scaling) {
      if (targetSourced) continue;
      // An ORDINARY entry is added only when its ratio is strictly positive
      // (getStepEffectScaling@21777 ops 201-203: `0 < ratio` gates the
      // generic add). The two named branches above it are not behind that
      // test. One row in today's data authors a zero (a foe skill,
      // Reblochonk_CheeseShot's FoePower) and none a negative - this guard
      // is for the patch that authors one on a player row, so the bench
      // skips it exactly where the game does.
      const named = s.atb === 'AllAttributes' || (s.atb === 'WeaponPower' && swingAttrs?.length);
      if (!named && !(s.ratio > 0) && s.ratio != null) continue;
      a += s.ratio * scalingValue(s.atb, sheet, swingAttrs, weaponMixFlats, itemShare);
    }
    return a;
  }

  // What the target is currently wearing. A debuff on the enemy is the other
  // half of a rotation's dependency order: `GA_Demon_Skill1_Status` strips a
  // quarter of its Armor AND its MagicArmor, `Priest_BeaconOfHope_Status_Debuff`
  // makes it take 10% more, and until the fight could hold state, every one of
  // those was worth exactly zero.
  const NO_DEBUFF = { armor: 1, magicArmor: 1, taken: 1, scriptAdd: 0 };
  // Per-category damage multipliers a talent confers, which are not stats and
  // so cannot live on the sheet. Empty by default, so a build with none of them
  // computes exactly what it did before.
  const NO_MODS = { critDamageByType: null, critChanceByType: null, damageByAffinity: null, armorIgnore: null, bleed: null };
  function targetState(active) {
    if (!active || !active.length) return NO_DEBUFF;
    // ARatio armour debuffs SUM into one bracket - the extracted pool law is
    // Armor x (1 + SUM ARatio) x (1 - ignore) x (1 - pen/100) - so Tear
    // Reality's -25% and a -25% shred together are x0.50, not x0.5625. One
    // debuff composes identically either way, which is how the multiply hid
    // through every single-debuff window. mulRatio rows keep their own
    // sheet-declared composition, applied after the summed bracket.
    const add = { Armor: 0, MagicArmor: 0, DamageTakenModifier: 0 };
    const mul = { Armor: 1, MagicArmor: 1, DamageTakenModifier: 1 };
    let scriptAdd = 0;
    for (const d of active) {
      for (const a of d.affixes ?? []) {
        const atb = a.target?.attribute;
        if (!(atb in add)) continue;
        const v = (a.val ?? 0) * (d.stacks ?? 1);
        const kind = ctx.affix.kindOf(a.ref);
        if (kind === 'addRatio') add[atb] += v;
        else if (kind === 'mulRatio') mul[atb] = ctx.affix.composeMul(a.ref, mul[atb], v);
      }
      // The script-side spelling of DamageTakenModifier: Death Mark's status
      // has no affix at all, just `dmg.dmgMult += 0.15` for the instigator's
      // hits while it is worn. Read by statusesOf into `scriptTaken` - and it
      // is NOT the same channel as the attribute. computeDamage@4920 seeds
      // modMult from dmg.dmgMult at op 11, BEFORE the Raw gate at ops 69-73;
      // only the DamageTakenModifier ATTRIBUTE read is gated. So a script
      // rider reaches a Raw Hemorrhage tick where an affix saying the same
      // thing would not - which is why it accumulates separately here.
      //
      // ...and as an ADDITION, because that is what the statement is: one
      // more `+=` into the same dmgMult the attacker's own riders add to, so
      // it SUMS with them (`scriptAdd`, joined to the rider bracket in
      // castOutput). It used to multiply the finished hit, which is the same
      // number only on a hit with no other rider.
      // MEASURED 2026-10-13 (Rogue, Death Mark's 0.15): a five-point Finisher
      // (+1.5) logs 456 without the mark and 484 with it - x1.061, which is
      // 2.65 / 2.5, where a factor of 1.15 reads 524; an armed Infernal
      // Plunge (+0.25) 205 and 229-234 (1.40 / 1.25); the trinket's curse
      // under Powerful Toxins (+0.2) 44 and 49 (1.35 / 1.2). Alone on a hit
      // it is the plain x1.15: Gaping Wound 172 -> 197.
      if (d.scriptTaken) scriptAdd += d.scriptTaken * (d.stacks ?? 1);
    }
    // A composed multiplier may be a {mul,min} pair once an MRatioMin row
    // has entered the chain - resolve to its product either way.
    const rm = (x) => (typeof x === 'number' ? x : x.mul * x.min);
    return {
      armor: Math.max(0, (1 + add.Armor) * rm(mul.Armor)),
      magicArmor: Math.max(0, (1 + add.MagicArmor) * rm(mul.MagicArmor)),
      taken: Math.max(0, (1 + add.DamageTakenModifier) * rm(mul.DamageTakenModifier)),
      scriptAdd,
    };
  }

  function mitigate(effect, sheet, target, foe = NO_DEBUFF, mods = NO_MODS, attackerLevel = null, ignoreResistance = false, skillIgnore = null) {
    const aff = affinityOf(effect.affinity);
    // Hero-sourced damage is cut by (1 - target Resilience/100) with NO Raw
    // guard - computeDamage@4920 ops 88-115 - so it multiplies every branch
    // below, the Raw one included. Zero against every current foe.
    const resil = 1 - Math.min(100, Math.max(0, target.resilience ?? 0)) / 100;
    // Raw bypasses the ATTRIBUTE side of the receiving pipeline:
    // computeDamage@4920 ops 69-73 skip the DamageTakenModifier attribute for
    // the Raw affinity and getAffinityDamageReduction@4582 returns 0 outright.
    // Script taken-riders are seeded before that gate (op 11), so Death Mark's
    // +15% still lands on a Raw tick - through the rider bracket, where
    // castOutput adds `foe.scriptAdd` for every affinity.
    if (aff.root === 'Raw') return resil;
    if (!aff.resist) return foe.taken * resil;
    // A hit flagged `ignoreResistance` never builds the pool at all
    // (getAffinityDamageReduction@4582 ops 8-11), so armour, its debuffs, the
    // ignore riders and penetration all have nothing to act on. What survives
    // is the affinity's flat `reductions`, which a reference foe does not
    // carry, and everything computeDamage applies outside the reduction.
    if (ignoreResistance) return foe.taken * resil;
    const resist = (aff.resist === 'MagicArmor' ? target.magicArmor * foe.magicArmor : target.armor * foe.armor);
    // `armorIgnore` is NOT penetration by another name. Exposed Essence ignores
    // 5% of a bleeding enemy's armour on its own multiply, and penetration
    // takes its cut of what is left - getAffinityDamageReduction@4582 reduces
    // the pool at ops 133-147 (physical) or 80-95 (magic) and again at ops
    // 259-263, each with its own clamp. Adding them into one lever overstates
    // damage by 2-3% wherever a build carries both.
    //
    // ...plus what a script takes off THIS skill's hits by name (see
    // `armourIgnoresOf`): a `+=` joins the category riders, an `=` sets the
    // field, and which of two hooks wrote last is not read - the larger
    // stands. The game clamps the field to [0, 1] where it reads it.
    let ignoreRatio = mods.armorIgnore?.[aff.root] ?? 0;
    {
      const own = skillIgnore?.[aff.root];
      if (own) ignoreRatio = Math.max(ignoreRatio + (own.add ?? 0), own.set ?? 0);
      ignoreRatio = Math.min(1, Math.max(0, ignoreRatio));
    }
    const pen = aff.pen ? (sheet.get(aff.pen) ?? 0) : 0;
    const red = damageReduction({
      resist,
      penetrationPct: pen,
      ignoreRatio,
      // The STRIKER's level feeds the divisor (getAffinityDamageReduction@4582
      // op 237), not the target's: `target.level` is the level the foe was
      // built AGAINST, and its pool was built at `target.spawnLevel`, which
      // is a different number for any unit named at its own row (the
      // level-1 Dummy, a level-10 Ratsar).
      attackerLevel: attackerLevel ?? target.level,
      flatReduction: 0, // the target's own flat reductions; a reference foe has none
      formula: ctx.consts.resistFormula,
    });
    return Math.max(0, 1 - red) * foe.taken * resil;
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
  function castOutput(prof, sheet, target, opts, foe = NO_DEBUFF, mods = NO_MODS, extraRider = 0) {
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

    // WHOSE SHEET A STATUS TICK READS. A status's hits run in the status's
    // own SkillContext, built once when it starts (Status.postInit@15818 ->
    // BaseSkill.start@6145 op 19 -> SkillContext.initVars@5241), and initVars seeds that
    // context - crit chance, crit damage and both getDamageRatio brackets -
    // from `this.skill.getSourceObject()` (ops 0-2). For a Status that is its
    // INSTIGATOR (Status.getSourceObject@15807 is `return this.instigator`);
    // for anything else, the owner's proxy (BaseSkill.getSourceObject@6116).
    // So the tick of a status this build applied is priced off the build's
    // own sheet wherever the status is worn.
    //
    // HISTORY, and why this is a switch. On the accepted 2026-08-11 build the
    // same ops read `baseSkill.owner` - the unit WEARING the status - and the
    // captures agreed: a foe-worn tick took no bracket and never crit (the
    // Luon Mark's 51 lumps, one integer, no crit) while a self-worn Buff took
    // both (Infernal Plunge's aura at x1.27, Purging Strikes at 11.6% crit).
    // Build 25782799 changed the op. That read is not in doubt; what it does to
    // the NUMBER is, because the code that multiplies a hit by the context's
    // bracket (ent.Unit.applyEffect@4912, old op 298) is a server-only stub
    // in this client and no tick has been measured since. So the read is
    // scored, `--tick-source carrier` prices the accepted rule beside it,
    // and the audit names the measurement that decides.
    const statusTick = prof.isStatusTick === true;
    const tickFromPlayer = statusTick
      && (opts.assume.tickSource !== 'carrier' || prof.tickCarrierSelf === true);

    const wantTargets = Math.max(1, opts.targets ?? 1);
    // The per-press rider, in its two shapes - see `cast` in throughput():
    // a bare number is a spent stack BANK (first target only); an object may
    // also carry `add`, a context-level dmgMult every hit of the cast takes,
    // and `crit`, a context-level forced critical strike.
    // ...and `critAdd`, a crit CHANCE a hook adds to this cast's hits for a
    // reason only the fight can answer (a talent's "against a poisoned
    // target", when something poisoned is actually there).
    // ...and `bracket`, by affinity root: what a script added to the cast's
    // own damage-ratio bracket at the press (`ctx.magicDmgMult += x` in
    // onUseSkill). That field is not the dmgMult accumulator: SkillContext.initVars@5241
    // ops 47-52 seed it with the caster's GameObject.getDamageRatio@4577 -
    // (1 + mastery + Fervor) x DamageModifier - and getDamageScale@5238 hands
    // it back for every affinity whose root is Magic, so the amount is added
    // to that PRODUCT and each such hit of the cast carries it.
    const xr = typeof extraRider === 'number'
      ? { bank: extraRider, add: 0, crit: false, critAdd: 0, bracket: null }
      : {
        bank: extraRider?.bank ?? 0, add: extraRider?.add ?? 0, crit: extraRider?.crit === true,
        critAdd: extraRider?.critAdd ?? 0, bracket: extraRider?.bracket ?? null,
      };

    let damage = 0, heal = 0, shield = 0;
    let singleTargetDamage = 0;
    let riderSum;
    let hitCount = 0, hitCountPhysical = 0;
    // HITS, as against damage instances. A step that hits is one hit on each
    // target however many effects it carries: Demonic Bite's one step deals a
    // Physical and a Magic effect, which is two rows in the log and one
    // HitData. `hitCount` counts the rows; this counts the hits, per step.
    const landingsByStep = new Map();
    let critPhysical = 0, critMagic = 0;
    // How many Magic damage EVENTS of this cast are expected to crit - what
    // an owner-wide "your Magic critical strikes" hook rolls on.
    let magicCrits = 0;
    // ...and how many such events there are to crit at all. The pair is the
    // per-event crit chance (magicCrits / magicCritHits), which "at least one
    // of them crits AND passes its roll" needs: 1 - (1 - q x c)^n is not
    // 1 - (1 - c)^(n x q) unless q is 1.
    let magicCritHits = 0;
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
      // WHICH scaling channel this effect's attributes read is the granting
      // ITEM's, whatever the affinity: $HSkill.getStepEffectVal@21774 ops
      // 64-106 hand getStepEffectScaling@21777 the source item when the row
      // BaseSkill.isWeaponBased@6164, or its source skill is (a status asks its
      // instigator skill, Status.getSourceSkill@15829), and no op on the way
      // looks at the effect's affinity. So a weapon-granted status tick takes
      // the 0.6 / 0.4 mix when it is Raw too.
      // MEASURED 2026-10-13 (Rogue, Dexterity 175): Gaping Wound's bleed -
      // Raw, 4 x Dexterity over four ticks - logs 165 on every plain tick and
      // 250 on a critical one, which is ceil(0.6 x 175 + 0.4 x 148.3 = 164.3)
      // and ceil(164.3 x 1.5196); the bare attribute would read 175 / 266.
      // HISTORY: this used to be priced pure for Raw, on the accepted
      // 2026-08-11 build's capture ("4 x Dex 166 where the mix would say
      // 159"). That reading is that build's and is not reproduced here.
      const mixFlats = opts.weaponMix?.ids?.has(prof.id) ? opts.weaponMix.flats
        : opts.tickScaling?.mixIds?.has(prof.id) ? opts.tickScaling.flats
          : null;
      // The TRINKET channel is the same function with the item share at 1:
      // getStepEffectScaling@21777 ops 27-35 set itemRatio to 1 when the
      // source item's type is GearTrinket (getStepEffectVal@21774 ops 86-106
      // hand a trinket's item on whatever the skill's type), so every
      // item-scaled attribute keeps clamp01(1 - 1) = 0 of the wearer's sheet
      // (ops 92-118) and arrives as the item's own flat at the instance's
      // level (`itemBudgets`). The spread over the ticks is the ordinary one:
      // a SelfEffect loop always spreads (SkillStep.isEffectSpreadOverTicks@6044 ops
      // 15-19).
      // MEASURED 2026-10-13 (Rogue, level-25 Finger of Sukuna'Maatata): the
      // curse - 0.2 x each of the four main attributes, Raw, three ticks -
      // logs 37 on every plain tick and 56 on a critical one over the whole
      // no-talent capture: ceil(0.2 x (123.58 + 148.30 + 123.58 + 148.30) / 3
      // = 36.25) and ceil(36.25 x 1.5196).
      // HISTORY: the accepted 2026-08-11 build's capture read this status at a
      // constant 45.00 a tick, undivided, which fitted 0.2 x the wearer's
      // standing weaponless primaries; that rule stood here until this build's
      // rows refused it (45.0 priced, 37 logged).
      const itemFlats = !mixFlats ? (opts.tickScaling?.itemFlats?.get(prof.id) ?? null) : null;
      const raw = (itemFlats
        ? amountOf(e, sheet, opts.swingAttrs ?? null, itemFlats, 1)
        : amountOf(e, sheet, opts.swingAttrs ?? null, mixFlats))
        * (e.hits ?? 1);
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
        // Domination's +25% inside a stun window (captured on the accepted
        // build, where it paid at every rank; it is rank 3 only now, and the
        // owner's rather than a cast's own - see `scriptRiders` below).
        // A cast that applies its own crowd control satisfies the cc gate
        // for its own hits - the CC lands before the damage evaluates - unless
        // the target is immune to it, in which case nothing lands at all
        // (GameObject.canReceiveStatus@4634 ops 0-7).
        //
        // WHICH hits is the reader's answer and not this function's:
        // `opts.ccOwn(id)` is `plan.ownCrowdControlOf` - '*' when every hit
        // of the row lands inside its own control (a Status step or effect
        // the cast plays, measured on Charge; a script that stuns in its own
        // onHit, which runs before the hit's damage - Iron Cyclone), a set of
        // step ids when only those steps' hits do (a script that applies it
        // behind `hit.stepId == Steps.X`), null when none is counted. It is
        // the SAME list the gate's share and the stun-armed register are
        // built from; a flag kept here off the step rows alone called Iron
        // Cyclone a stunner for the fight and not for itself. With no
        // `ccOwn` handed in, no cast is taken to control its own target.
        // Asked only when a rider behind the gate is actually being priced:
        // most casts carry none, and the answer is a lookup per effect.
        const ccImmune = (opts.gates?.ccImmune ?? 0) > 0;
        let ccSelfIs;
        const ccSelf = () => {
          if (ccSelfIs === undefined) {
            const ccOwn = ccImmune ? null : (opts.ccOwn?.(prof.id) ?? null);
            ccSelfIs = ccOwn === '*' || (ccOwn instanceof Set && ccOwn.has(e.stepId));
          }
          return ccSelfIs;
        };
        const gateOn = (g) => g == null || (g === 'cc' && ccSelf()) || (opts.gates?.[g] ?? 0) > 0;
        const gateVal = (g) => (g == null ? 1 : (g === 'cc' && ccSelf()) ? 1 : (opts.gates?.[g] ?? 0));
        // A rider that asks for ONE crowd-control type reads that type's own
        // share (`gates['cc:Slow']`). The cast's own control is not
        // consulted for it: `ccOwn` does not say which type a row applies,
        // so a cast that slows and reads the slow on the same hit is
        // under-read by that hit.
        const gk = (rd) => (rd.gate === 'cc' && rd.ccType ? `cc:${rd.ccType}` : rd.gate);
        // ...AND THE RIDERS ITS OWNER CARRIES FOR EVERY HIT. A clause written
        // in `onInflictDamageEval` on a row that is never itself cast - a
        // weapon passive - rides everything the owner lands (evalDamage@6124
        // ops 71-123 walk the instigator's skills and statuses). Domination's
        // rank-3 +25% is the one in the sheet, and until this it was read,
        // reported as scored, and applied to NOTHING: `prof.runeDamage` is
        // only ever the profile being priced, and a passive is never priced.
        // They take the same gates as the cast's own, this cast's own
        // `ccSelf()` included. A SUMMON's hit is not the owner's: it is routed
        // to onProxyDamageEval (ops 9-70) and takes none of them.
        const scriptRiders = opts.ownerRiders?.length && prof.proxied !== true
          ? [...(prof.runeDamage ?? []), ...opts.ownerRiders.filter((rd) => rd.from !== prof.id)]
          : (prof.runeDamage ?? []);
        // ...and the one live-state guard that is not a guess, because it is
        // STATED. `opts.targetHealth` is the fraction of its health the target
        // is standing at, and the comparison is answered EXACTLY against it:
        // no assumption that the fight is a kill, none that damage is even,
        // none that a share of the fight is spent below the line.
        //
        // `<` and `<=` therefore differ only exactly AT the boundary - at 0.35
        // stated, `<= 0.35` fires and `< 0.35` does not - which is all the
        // precision a single stated number can carry, and it is not rounded to
        // hide that. At the default of full health an execute clause is simply
        // OFF and an above-threshold clause is ON. Both are the right answer
        // for the fight that was described, not a missing feature.
        const health = opts.targetHealth ?? 1;
        const healthOk = (th) => th == null
          || (th.op === '<=' ? health <= th.threshold
            : th.op === '<' ? health < th.threshold
              : th.op === '>=' ? health >= th.threshold : health > th.threshold);
        let scriptCritDmg = 0;
        // ...and crit CHANCE riders, the family evalDamage@6124 runs before
        // the roll (criticalRoll@6320: critChance >= random()). Ten live
        // writers in the sheet do `hit.critChance += vars.x` in fraction
        // space, and Blazing Beam simply assigns 100: MEASURED 93/93 crits
        // at rank >= 2, and the tooltip prints "Always critically strikes".
        // These were dropped whole - up to +43% missing on one skill.
        // A register that wrote `ctx.critChance = 1` at the press forces every
        // hit of this cast the same way - $BaseSkillContext.copy@5232 ops 18-19 carry
        // ctx.critChance into each hit, and criticalRoll@6320 ops 9-13 crit
        // whenever critChance >= random.
        let scriptCritCh = xr.critAdd, forcedCrit = xr.crit;
        // A rider can be for ONE step of its row (`stepId`) - it reaches that
        // step's effects and no other hit - and its amount can be an
        // attribute of the owner rather than a var (`fromAtb`, read off the
        // sheet this cast is priced on) - see `runeDamage`.
        const riderStep = (rd) => rd.stepId == null || rd.stepId === e.stepId;
        const riderAmount = (rd) => (rd.fromAtb ? (sheet.get(rd.fromAtb) ?? 0) * (rd.scale ?? 1) : rd.amount);
        // An armour ignore a script ASSIGNS on one step's hits (a literal
        // write behind the step's own test, see runeDamage), by affinity root.
        let stepIgnore = null;
        for (const rd of scriptRiders) {
          if (!riderStep(rd)) continue;
          if (rd.field === 'armorIgnore' || rd.field === 'magicArmorIgnore') {
            // The hit's own ignore, ASSIGNED by the script: it sets the
            // field, it does not add to it.
            const root = rd.field === 'armorIgnore' ? 'Physical' : 'Magic';
            (stepIgnore ??= {})[root] = Math.max(stepIgnore[root] ?? 0, rd.amount);
            continue;
          }
          if (rd.field !== 'critDmgMult' && rd.field !== 'critChance') continue;
          // A TALENT's clause can name the kind of cast and the affinity of
          // the hit it rides (Bullying the Weak: weapon skills, crit chance
          // on Physical hits, damage on Magic ones). A status tick has no
          // skill type, so a type-scoped clause never reaches one.
          if (rd.types && !rd.types.includes(prof.type)) continue;
          if (rd.affinity && rd.affinity !== aff.root) continue;
          if (rd.singleTarget && wantTargets !== 1) continue;
          if (!gateOn(gk(rd))) continue;
          if (!healthOk(rd.targetHealth)) continue;
          if (rd.field === 'critDmgMult') scriptCritDmg += riderAmount(rd) * gateVal(gk(rd));
          else if (rd.forced) forcedCrit = true;
          else scriptCritCh += riderAmount(rd) * gateVal(gk(rd));
        }
        // A swing-played status step takes the Attack key only where the step
        // itself is flagged a base attack (`tickStepIsAttack`, with the read
        // and the measurement); otherwise it has the status row's category,
        // which is none.
        const tickCat = prof.isStatusTick === true && prof.tickOnSwing && prof.tickStepIsAttack
          ? 'Attack'
          : cat;
        const critBonus = (mods.critDamageByType?.[tickCat] ?? 0) + scriptCritDmg;
        const chanceBonus = mods.critChanceByType?.[tickCat] ?? 0;
        // WHICH status ticks crit is the statusType's DoT/HoT flag, not the
        // fact of being a status: SkillContext.initVars@5241 zeroes ctx.critChance only for
        // flagged types, and everything else rolls the chance of the
        // context's source (criticalRoll@6320) - the player's, whoever wears
        // the status, when the build applied it (`tickFromPlayer` above). A
        // talent that gives a bleed its own crit chance is a script hook and
        // rides poolScale, not this path.
        const rawAff = aff.root === 'Raw';
        const tickCrits = statusTick && prof.tickCanCrit === true && tickFromPlayer;
        const pLocal = forcedCrit ? 1 : Math.min(1, critChance + chanceBonus + scriptCritCh);
        const localCrit = statusTick && !tickCrits ? 1
          : (critBonus || chanceBonus || scriptCritCh || forcedCrit)
            ? 1 + pLocal * ((sheet.get('CritDamage') ?? 100) / 100 + critBonus - 1)
            : critMult;
        // What a script takes off THIS cast's hits: by the skill's name
        // (`armourIgnoresOf`, keyed by the cast's own row), and an ignore
        // assigned on this step alone. ONE rule for both, the one `mitigate`
        // states: an assignment sets the field, which of two hooks wrote last
        // is not read, and the larger of it and the riders stands. (At the
        // one step-scoped literal in the sheet, 1, that is the whole pool
        // either way.)
        const ownIgnore = (() => {
          const bySkill = mods.armorIgnoreBySkill?.[String(prof.id).split('#')[0]] ?? null;
          if (!stepIgnore) return bySkill;
          const own = { ...(bySkill ?? {}) };
          for (const [root, v] of Object.entries(stepIgnore)) {
            own[root] = { add: own[root]?.add ?? 0, set: Math.max(own[root]?.set ?? 0, v) };
          }
          return own;
        })();
        // Raw damage bypasses every global multiplier: getDamageScale@5238
        // returns 1 for Raw before fervor, mastery or DamageModifier enter.
        let m = (rawAff ? 1 : dmgMod) * localCrit
          * mitigate(e, sheet, target, foe, mods, opts.attackerLevel ?? null, prof.ignoresResistance === true, ownIgnore);
        // EVERY dmgMult RIDER SUMS INTO ONE BRACKET. They used to compound, one
        // multiplication per line. `computeDamage@4920` (Unit.hx:2102-2133) op 5
        // runs the hooks, op 11 seeds `modMult` from `hitData.dmgMult` - a
        // single scalar that starts at 1 and that every rider only ever `+=`s -
        // and ops 134-147 apply it once. Two +20% riders give x1.40, not x1.44.
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
        for (const rd of scriptRiders) {
          if (rd.field === 'critDmgMult' || rd.field === 'critChance') continue;   // handled at the crit bracket
          if (rd.field === 'armorIgnore' || rd.field === 'magicArmorIgnore') continue;   // ...and these at the reduction
          if (rd.types && !rd.types.includes(prof.type)) continue;
          if (rd.affinity && rd.affinity !== aff.root) continue;
          if (rd.singleTarget && wantTargets !== 1) continue;
          if (!riderStep(rd)) continue;
          if (!gateOn(gk(rd))) continue;
          if (!healthOk(rd.targetHealth)) continue;
          riders += riderAmount(rd) * gateVal(gk(rd));
        }
        // ...including the CATEGORY keys. The engine routes attack- and
        // combo-scoped dmgMult modifiers into damageByAffinity under
        // 'Attack'/'AttackCombo', and this read never consulted them - an
        // answerable attack-scoped rider priced at zero. tickCat is the same
        // category key the crit brackets use, so a swing-triggered tick pays
        // under its swing's category here too.
        riders += (mods.damageByAffinity?.[aff.root] ?? 0)
          + (mods.damageByAffinity?.all ?? 0)
          + (tickCat ? (mods.damageByAffinity?.[tickCat] ?? 0) : 0);
        // BASIC attacks only. `isBasicAttack` is skill types Attack..Attack4
        // (BaseSkill.isBasicAttack@6152) and the combo finisher is AttackCombo,
        // a type outside that set - so a rider that says "your basic attacks"
        // must not reach the swing that ends the chain. `prof.isFiller` is the
        // wrong test here: it covers the finisher too.
        //
        // `mods.basicAttack` is the chance of the weapon upgrade's "attack
        // twice", and it is NOT one of these riders: the script replays the
        // swing's executing step (`ctx.skill.playStep(null,
        // ctx.activeSkill.getExecStep().index, ...)`), which is a second HIT -
        // its own row in the log, its own crit roll, every rider of the first
        // on it again - not a bigger first one. Booked as +chance in this
        // bracket it gave the right total only while the bracket was empty,
        // and a per-hit figure that much too high every time: the 2026-10-13
        // capture's sword swings (Legendary, 7%) logged 15.25 against a model
        // of 15.03 x 1.07. It is counted as hits below (`again`).
        const again = mods.basicAttack && /^Attack[234]?$/.test(prof.type ?? '') ? mods.basicAttack : 0;
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
        // A rider the FIGHT knows and the sheet cannot: a bank of stacks the
        // build fills and this press spends. It joins the same bracket as
        // everything above because that is where the game puts it -
        // computeDamage@4920 op 11 seeds ONE modMult scalar from hit.dmgMult
        // and every rider only `+=`s it. Multiplying the finished cast instead
        // would compound the bank against the other riders: at +500% next to a
        // 4% rider that is 3.3% high, all of it in the flattering direction.
        // ...but only the FIRST resolved target of an area takes it.
        // `onDamage` runs `removeStatus` per hit and
        // `AreaStep.areaHit@6077` loops its targets in-frame, so target two
        // evaluates a count of zero. Spread over the step's target count, that
        // is one empowered hit and N-1 bare ones - measured, of 93 multi-target
        // Clawdius casts at three stacks or more, 82 have exactly one empowered
        // hit, 11 have none, and not one has two.
        riders += xr.bank / Math.max(1, targets);
        // A CONTEXT-level rider is the other per-press kind, and it is NOT
        // spread: a register spent in `onSkillProc` writes `ctx.dmgMult`
        // once, before the cast's hits exist, and every ScriptHitData the
        // cast then makes copies it ($ScriptHitData.__constructor__@6318 op 10
        // -> $BaseSkillContext.copy@5232 ops 4-5), so each hit on each target
        // carries the whole amount in this same bracket.
        riders += xr.add;
        // ...and what a status the TARGET wears adds to the hits it receives
        // (Death Mark's `dmg.dmgMult += 0.15` in onReceiveDamageEval): the
        // same accumulator, so the same bracket - see `targetState`.
        riders += foe.scriptAdd ?? 0;
        m *= 1 + riders;
        // The bracket is handed on with the cast (`riders`), for the one
        // caller that has more to add to it: a status hit's own hooks
        // (`statusHit` in throughput). Only when every damage effect of the
        // cast carries the same sum; a cast that mixes two is told so.
        if (riderSum === undefined) riderSum = riders;
        else if (riderSum !== null && Math.abs(riderSum - riders) > 1e-12) riderSum = null;
        // Fervor and the matching mastery share ONE additive bracket -
        // GameObject.getDamageRatio@4577: (1 + fervor + mastery) x DamageModifier - and
        // it belongs to whoever SEEDS the hit's context: SkillContext.initVars@5241 ops
        // 47-52 take both brackets off the source object. A cast's source is
        // the caster. A status tick's is the unit that applied it, so the
        // player's fervor and mastery ride every tick of a status the build
        // applies (`tickFromPlayer`); under `--tick-source carrier` only a
        // self-worn Buff takes them, which is the accepted build's rule and
        // what Infernal Plunge's aura measured there (x1.27,
        // state-independent across sessions).
        if (!rawAff && (!statusTick || tickFromPlayer)) {
          const fervorAdd = fervorHere ? fervor : 0;
          const masteryAdd = opts.assume.mastery
            ? (aff.root === 'Physical' ? physMastery : aff.root === 'Magic' ? magicMastery : 0)
            : 0;
          // What the press wrote into this root's bracket (`xr.bracket`) is
          // added to the finished product, DamageModifier included - `m`
          // already holds that factor, hence the division.
          // MEASURED 2026-10-13 (Mage, Fervor 7.476, no mastery up): Queen's
          // Decree's +1 took Static Nova from a priced 233.1 to a logged 451
          // on three presses, Spark Beam's tick from 79 to 151 and Demonic
          // Discharge's bolt from 31 to 59 - x(2.07476 / 1.07476) = x1.930
          // each time, where a x2 on the finished hit would log 467, 157, 61.
          const ctxAdd = dmgMod > 0 ? (xr.bracket?.[aff.root] ?? 0) / dmgMod : 0;
          m *= 1 + fervorAdd + masteryAdd + ctxAdd;
        }
        // The replayed swing: `again` more hits of the same worth on the same
        // targets. Folded into the target count from here on, so damage,
        // events and what feeds the pools all carry it alike; the bank and
        // the context riders above were divided and applied before it.
        const landed = targets * (1 + again);
        damage += raw * m * landed;
        singleTargetDamage += raw * m * (1 + again);
        // HOW MANY DAMAGE EVENTS this cast produces, which is what a damage
        // meter counts and what the capture logs a row for. `critRoll.hits` is
        // not it: that one only counts CRITTABLE hits, so a status tick - which
        // can never crit - contributes nothing to it. A SPREAD channel logs
        // one row per tick - RayOfSpark's cast is four 84s, not one 368 - so
        // its event count is the tick count, not the effect's single "hit".
        hitCount += (e.spread ? Math.max(1, e.ticks ?? 1) : (e.hits ?? 1)) * landed;
        {
          // An effect that does not say its step (a profile built by hand) is
          // a hit of its own, as it always was.
          const step = e.stepAt ?? e;
          const events = (e.spread ? Math.max(1, e.ticks ?? 1) : (e.hits ?? 1)) * landed;
          if (events > (landingsByStep.get(step) ?? 0)) landingsByStep.set(step, events);
        }
        // Physical, non-tick events specifically: that is what a stack counter
        // keyed on `!dmg.isDoT && dmg.isPhysical` arms on.
        if (aff.root === 'Physical' && !statusTick) hitCountPhysical += (e.hits ?? 1) * landed;
        if (aff.root === 'Magic' && localCrit > 1) {
          const events = (e.spread ? Math.max(1, e.ticks ?? 1) : (e.hits ?? 1)) * landed;
          magicCrits += events * pLocal;
          magicCritHits += events;
        }
        // Split this effect into the part a die can move and the part it
        // cannot. `localCrit` is 1 for a status tick, which is exactly the
        // "cannot" case, so the test is the multiplier itself.
        {
          const whole = raw * m * landed;
          const base = localCrit > 0 ? whole / localCrit : whole;
          if (localCrit > 1) {
            critRoll.p = pLocal;
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
          const banked = (raw * m * landed) / dmgMod;
          if (aff.root === 'Physical') totalPhysical += banked;
          else if (aff.root === 'Magic') totalMagic += banked;
          if (localCrit > 0) {
            const pEff = pLocal;
            const cdEff = (sheet.get('CritDamage') ?? 100) / 100 + critBonus;
            const critShare = (raw * m * landed) * (pEff * cdEff) / localCrit / dmgMod;
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
    // A HEAL A SCRIPT SIZES AS A SHARE OF THIS ROW'S HITS (`mods.healBySkill`:
    // Soothing Rays hands back 30% of what Sunlight deals, to whoever wears
    // that Sunlight). The script writes `setDynVal(n, dmg.amount * vars.x)`
    // and plays a step whose one effect is a heal of that dynVal - the amount
    // is the damage as it LANDED, crit and mitigation in, so it is this
    // total's share. Priced AT the share, with no heal multiplier on top, as
    // the share a bleed hands back is (sim.mjs, Bloodfeast): whether the
    // server then runs a dynVal heal through HealGivenMultiplier is not read
    // - the Heal step's dispatch is server-side - and the audit says so.
    {
      const back = mods.healBySkill?.[String(prof.id).split('#')[0]] ?? 0;
      if (back > 0) heal += damage * back;
    }
    return {
      damage, heal, shield, singleTargetDamage, gains,
      hits: hitCount, hitsPhysical: hitCountPhysical,
      critPhysical, critMagic, totalPhysical, totalMagic, magicCrits, magicCritHits,
      critRoll: critRoll.hits > 0 ? critRoll : null,
      // The dmgMult bracket's sum on this cast's damage, 0 when its effects
      // do not share one (see where it is summed).
      riders: riderSum ?? 0,
      // How many HITS the cast lands - what onInflictHit is raised for - where
      // `hits` is how many damage instances (onInflictDamage, and the log).
      landings: [...landingsByStep.values()].reduce((n, x) => n + x, 0),
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
  function throughput(rotation0, sheet, target, opts, live = null) {
    // A rider whose playStep sits behind a stated-health test (`rule.
    // targetHealth`, read in skills.mjs scriptedRiders) fires only where the
    // health this evaluation states satisfies it. The rotation is structure
    // and is cached across evaluations, so the answer is taken here.
    //
    // The same for a rider that needs a crowd-control status to LAND on the
    // target (`rule.needsCC` - the hit Ram Trap's root deals when it ends):
    // a target that refuses crowd control never wears the status.
    const rotation = (() => {
      const health = opts.targetHealth ?? 1;
      const ccImmune = (opts.gates?.ccImmune ?? 0) > 0;
      const ok = (rule) => {
        const th = rule?.targetHealth;
        if (rule?.needsCC && ccImmune) return false;
        return th == null
          || (th.op === '<=' ? health <= th.threshold : th.op === '<' ? health < th.threshold
            : th.op === '>=' ? health >= th.threshold : health > th.threshold);
      };
      // ...and a cooldown mutation behind a stated TARGET COUNT
      // (`needsTargets`: Blinding Light's "if 2 or more enemies are hit").
      const want = Math.max(1, opts.targets ?? 1);
      const enough = (mu) => !mu.needsTargets
        || (mu.needsTargets.op === '>=' ? want >= mu.needsTargets.n
          : mu.needsTargets.op === '>' ? want > mu.needsTargets.n : want === mu.needsTargets.n);
      const trigOk = (rotation0.triggered ?? []).every((tr) => ok(tr.rule));
      const muOk = (rotation0.cdMutations ?? []).every(enough);
      return trigOk && muOk ? rotation0 : {
        ...rotation0,
        triggered: trigOk ? rotation0.triggered : rotation0.triggered.filter((tr) => ok(tr.rule)),
        cdMutations: muOk ? rotation0.cdMutations : rotation0.cdMutations.filter(enough),
      };
    })();
    // The stat MULTIPLIES the cooldown by (1 - v/100), floored at zero -
    // GameObject.getCooldownModifier@4600 is literally `max(0, 1 - atbVal(21))`,
    // and 100 CooldownReduction means no cooldown at all. This used to divide
    // by (1 + v/100), which is the same thing only at v = 0: at 30 CDR the
    // divide leaves cooldowns 9.9% too long, and it penalises the stat at
    // every value, so the optimizer's CDR gradient pointed the wrong way.
    // Measured 2026-08-21: GA_Demon_Skill1 at rank-2 cooldown 20s pressed on
    // cooldown cycles at exactly impact + 20.000s - the multiply, not the
    // divide, and not the authored 25 either (rank overrides are separate).
    const cooldownMult = Math.max(0, 1 - (sheet.get('CooldownReduction') ?? 0) / 100);
    // Cooldown earned back by an EVENT rather than carried as a stat, and only
    // for the skills the event names. `Red Tempo` cuts a second off your weapon
    // skills on a 12% roll per bleed tick, which at one tick every two seconds
    // is 0.06 seconds of cooldown earned back per second - that one IS a
    // divisor on the period, and it applies to WeaponSkills alone, so it
    // rides beside the stat rather than folding into it.
    const weaponSkillRefund = live?.mods?.cooldown?.weaponSkill ?? 0;
    const restat = live?.restat ?? (() => sheet);
    // ...AND THAT MULTIPLIER IS THE SHEET'S AS IT STANDS WHEN A COOLDOWN
    // STARTS (sim.mjs `cdScaleOf`, with the read and the four measured
    // cooldowns): the same rule against whatever timed status is up, asked
    // by the fight at each start. `cooldownMult` above is the resting answer
    // - the sheet the fight starts from holds nothing timed - and this is
    // the one a status that carries Cooldown Reduction moves while it is on
    // the hero: Mystic Empowerment's +30, Crusader's +10, Dark Gift's.
    // Memoised on the state's key, like a cast's price.
    const cdFactorCache = new Map();
    const cooldownFactor = (state) => {
      if (!state?.self?.length) return cooldownMult;
      let f = cdFactorCache.get(state.key);
      if (f == null) {
        f = Math.max(0, 1 - (restat(state.self).get('CooldownReduction') ?? 0) / 100);
        cdFactorCache.set(state.key, f);
      }
      return f;
    };
    // A cast is priced AT THE MOMENT IT IS CAST, against whatever is up. That is
    // the whole difference between a priority list and a rotation: with a fixed
    // price, stripping a quarter of the target's armour first is worth nothing
    // and so is saving a cooldown for a damage window.
    //
    // The cache key is the state, not the clock. A fight cycles through a
    // handful of distinct (buffs up, debuffs up) combinations thousands of
    // times, so pricing is memoised on that signature rather than recomputed.
    const castCache = new Map();
    // `extraRider` is a per-PRESS additive rider - a stack bank spent by this
    // cast - and it goes in the CACHE KEY rather than being applied after the
    // lookup, so the bracket stays exact. It is an integer count times a fixed
    // per-stack amount, so it takes at most `maxStacks + 1` values and the
    // cache stays bounded.
    //
    // It may also be an OBJECT `{ bank, add, crit }` for the riders a
    // next-cast register writes onto the cast's context at the press - an
    // additive dmgMult every hit carries, a forced crit. Those are authored
    // constants of the build, so the key space stays as small.
    const cast = (prof, state, extraRider = 0) => {
      const xk = !extraRider ? ''
        : typeof extraRider === 'number' ? `|+${extraRider}`
          : `|+${extraRider.bank ?? 0}c${extraRider.add ?? 0}${extraRider.crit ? '!' : ''}`
            + (extraRider.critAdd ? `k${extraRider.critAdd}` : '')
            + (extraRider.bracket
              ? 'b' + Object.keys(extraRider.bracket).sort().map((r) => `${r}${extraRider.bracket[r]}`).join(',') : '');
      const key = (state ? state.key : '') + xk;
      let byState = castCache.get(prof);
      if (!byState) { byState = new Map(); castCache.set(prof, byState); }
      let hit = byState.get(key);
      if (!hit) {
        hit = castOutput(prof, state ? restat(state.self) : sheet, target, opts,
          state ? targetState(state.target) : NO_DEBUFF, live?.mods ?? NO_MODS, extraRider);
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
    // A DoT SNAPSHOTS - on the applier's side. Its per-tick value is priced
    // from the state it is handed, and the fight hands it the applier's buffs
    // as they stood at the application: they do not follow the buffs that
    // come and go while it ticks. That is what SimulationCraft does and it is
    // the convention this model follows; nothing in the CDB states it either
    // way, so it is in the audit as an assumption. The TARGET's side is not
    // snapshot: the fight re-prices a tick against what the target wears when
    // it lands (sim.mjs `tickOutput`, with the measurement).
    const dotOutput = (d, state) => {
      const whole = cast(d.prof, state);
      const ticks = Number.isFinite(d.duration) && d.tick > 0
        ? Math.max(1, Math.floor(d.duration / d.tick + 1e-9)) : 1;
      // A talent scoped to a status TYPE reaches an authored dot too, not only
      // a pool one. `Bloodletting` is +10% on anything ticking and
      // `Powerful Toxins` +10%/+20% on anything typed Poison; both were computed,
      // matched against the pool dots, and then never offered to the dots the
      // fight actually schedules. The match walks the statusType parent chain,
      // so a Bleed guard covers a Hemorage dot and not the other way round.
      // A RAW one too - see `statusHit` for what changed and the measurement.
      //
      // The crit decomposition travels with the tick (sim.mjs splitAdd): a
      // tick that rolls the source's crit hands on the cast's own `critRoll`,
      // scaled like its damage; one a HOOK gives a chance to carries that
      // hook's roll (the plain tick is the base, the hook's chance and the
      // context's CritDamage the die); one that cannot crit at all says so
      // (`critFree`). A tick with BOTH an own roll and a hook's is two dice on
      // one hit and carries no word.
      //
      // `plain` is the tick before any status hook and `riders` the dmgMult
      // bracket the priced tick already carries: what the fight needs to
      // re-price the tick against live state (`statusHit.parts`).
      const parts = statusHit.parts(d, 0, 0, whole.riders ?? 0);
      const crit = parts.p > 0 ? 1 + parts.p * (parts.cd - 1) : 1;
      const per = parts.mult * crit / ticks;
      const cr = whole.critRoll;
      return {
        damage: whole.damage * per, heal: whole.heal / ticks,
        plain: whole.damage / ticks, riders: whole.riders ?? 0, ownCrit: !!cr,
        ...(parts.p > 0
          ? (cr ? {} : { critRoll: { p: parts.p, cd: parts.cd, hits: 1, base: whole.damage * parts.mult / ticks, fixed: 0 } })
          : cr ? { critRoll: { ...cr, base: cr.base * per, fixed: cr.fixed * per } }
            : { critFree: true }),
      };
    };
    // WHAT THE HOOKS ADD TO ONE HIT OF A STATUS, as one factor: the dmgMult
    // riders in their one additive bracket, times the crit expectation the
    // hooks gave a hit that starts with none (SkillContext.initVars@5241 zeroes a
    // DoT-typed status's crit chance; every `critChance +=` after that is a
    // script's, and the multiplier is the context's CritDamage - the
    // instigator's on this build).
    //
    // `add` and `critAdd` are what the FIGHT knows and the plan cannot: how
    // many poisons are on the target at this tick, how many stacks a counter
    // holds, whether a crit-granting status is up. They join the status-type
    // talents here, in the same bracket, because every one of them is a
    // `dmg.dmgMult +=` / `dmg.critChance +=` on the same hit. `prof` is the
    // hit being priced when it is not the tick (a status's re-apply step).
    //
    // `riders` is the dmgMult bracket the priced hit ALREADY carries
    // (castOutput's `riders`: a rider naming the skill, the +0.15 of a mark
    // on the target). The hooks here are more `+=` into that same scalar, so
    // they are added to it and not multiplied on top: the factor returned is
    // (1 + riders + hooks) / (1 + riders).
    //
    // A RAW hit takes all of it. Raw skips two things and only two - the
    // context bracket (getDamageScale@5238 returns 1 for Raw) and the
    // reduction with the DamageTakenModifier attribute (computeDamage@4920
    // ops 69-73) - and both sit AFTER the hooks: op 11 seeds modMult from
    // dmg.dmgMult and ops 33-46 multiply a critical hit before the Raw test.
    // MEASURED 2026-10-13 (Rogue, dummy), on the trinket's Raw, Poison-typed
    // curse, 36.25 a tick by the read: 37 with no talent, 44 from the step
    // Powerful Toxins reached rank 2 (x1.2), 45 / 46 and 47 / 48 with Intent
    // to Kill at one and two points and two / three poisons on the target
    // (1.2 + 0.02n, 1.2 + 0.04n), 49 under Death Mark (1.2 + 0.15); and its
    // critical ticks while Gaping Wound's bleed is on the target, 56 and 67
    // (x1.5196). Gaping Wound's own Raw bleed: 165, 250 critical, 171 under
    // Intent to Kill.
    // HISTORY: Raw was exempt here, on the accepted 2026-08-11 build's
    // capture (the same curse at a constant 45.00 with poison talents
    // ranked). That is that build's rule; this build's rows refuse it.
    const statusHit = {
      // The two halves of what the hooks do to one hit of status `d`: the
      // bracket's factor, and the crit they give it (chance and multiplier).
      parts: (d, add = 0, critAdd = 0, riders = 0) => {
        let hooks = add, critCh = critAdd;
        for (const mod of dotScoped) {
          if (!coveredBy(mod.statusType, d.types)) continue;
          if (mod.field === 'dmgMult') hooks += mod.amount;
          else if (mod.field === 'critChance') critCh += mod.amount;
        }
        // A tick cannot crit on its own (SkillContext.initVars@5241 zeroes it); a talent
        // that gives it one is a script hook, and this is where it lands.
        return {
          mult: (1 + riders + hooks) / (1 + riders),
          p: Math.min(1, Math.max(0, critCh)),
          cd: (sheet.get('CritDamage') ?? 100) / 100,
        };
      },
      scale: (d, add = 0, critAdd = 0, riders = 0) => {
        const x = statusHit.parts(d, add, critAdd, riders);
        return x.p > 0 ? x.mult * (1 + x.p * (x.cd - 1)) : x.mult;
      },
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
      // Passive regen, from `attribute.regenAtbs`: each entry names the stat
      // that carries the rate and a factor on it. Entries with conds are
      // states this fight is never in - Rage's decay waits for 3s OUT of
      // combat, Spark's fast lane needs 1s out of combat - so only the
      // condition-free entries pay here. For Spark that is SparkRegen x 1.3,
      // and SparkRegen is itself 0.005 x MaxSpark, so a 100-cap Mage earns
      // 0.65/s. MEASURED 2026-08-21: +1.95 per 3.0s tick, depletion-then-idle
      // 0 -> 76.05 = exactly 39 lumps over 116.63s, ticking during casts,
      // whole-rotation conservation exact - this income was the largest
      // missing term in the Mage baseline. The 3s lump rides the game's own
      // tick; the sim pays it on the same 3s clock so gauge thresholds (the
      // conduit gate at half pool) cross in steps, not smoothly.
      const raw = cdb.byId('attribute').get(atb);
      let regen = 0;
      for (const r of raw?.regenAtbs ?? []) {
        if (r.conds && Object.keys(r.conds).length) continue;
        regen += (sheet.get(r.atb) ?? 0) * (r.factor ?? 1);
      }
      resources[atb] = {
        max,
        start: typeof opts.poolStart?.[atb] === 'number'
          ? Math.max(0, Math.min(max, opts.poolStart[atb]))
          : a.flags.has('NoAutoFill') ? 0 : max,
        factor: factor > 0 ? factor : 1,
        gainAtb: a.gainAtb ?? null,
        regen: regen > 0 ? regen : 0,
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
    // A POOL TICK IS A HIT OF ITS OWN, and the ledger above is only its
    // AMOUNT. The feeding script banks a share of a finished hit as stacks
    // (`addStatus(dmg.target, <status>, dmg.amount * vars.x)`), the status
    // row's `baseVal: 1` Damage effect ticks that count back out
    // (getStackFactor@21771), and each tick then runs the same two stages
    // any other hit does - under the tick's OWN affinity:
    //
    //   the context bracket  getDamageScale@5238: 1 for Raw, else the
    //                        status context's GameObject.getDamageRatio@4577 - ops
    //                        0-12, (1 + fervor + mastery) x DamageModifier,
    //                        the INSTIGATOR's on this build (see
    //                        `tickFromPlayer` in castOutput), the wearer's
    //                        on the accepted one, which for a foe is as good
    //                        as 1. BOTH halves are priced, and the
    //                        DamageModifier here is a SECOND copy, not the
    //                        one `poolMultiplier` carries. That one belongs
    //                        to the hit that was banked: the script banks
    //                        `dmg.amount`, a finished hit with its own
    //                        modifier inside, and the ledger takes it with
    //                        the modifier divided out so the ticks can put
    //                        it back at its fight average. This one is the
    //                        tick's own context. A build with +20% up all
    //                        fight bleeds x1.44 of the bare ledger under the
    //                        instigator rule and x1.2 under the carrier one.
    //   the reduction        computeDamage@4920 ops 47-68: the target's
    //                        armour against the instigator's penetration,
    //                        nothing for Raw. This stage does not depend on
    //                        whose context the tick runs in.
    //
    // That every Damage effect takes both was read on the accepted build,
    // in ent.Unit.applyEffect (ops 281-329 of that build's body: scale by
    // the context, then receiveDamage); ent.Unit.applyEffect@4912 is a
    // server-only stub now and only computeDamage's half can be re-read.
    //
    // Three of the five pool statuses are Raw (Hemorrhage, Virulent
    // Contamination and the nameless Burn row Daggers_Demondash_Passive_
    // _Status) and both stages are exactly 1 for them - every pool tick
    // this model was calibrated on is Hemorrhage's. Bonethrow's bleed is
    // Physical and Spark Hemorrhage Magic: those two take both. The one
    // reading of a non-Raw pool is the 2026-08-02 capture's "bleed tick
    // ratio 0.1023-0.1028, not 0.100" (GROUND-TRUTH.md) - 0.100 being 0.4
    // over Bonethrow's four ticks, so that bleed by inference - and it was
    // taken on the accepted build's zero-armour Dummy, where the reduction
    // is nothing and the wearer's bracket is 1: it could not see either
    // stage. Both are read, neither is measured, and the audit says how one
    // Bonethrow on this build's Dummy settles them.
    //
    // Priced at REST: the reduction is the undebuffed target's against the
    // resting sheet's penetration, and the context - bracket and
    // DamageModifier both - is the averaged sheet's. An armour shred up
    // while a pool ticks is therefore not credited to the ticks (the
    // under-read direction), and a context that is really a snapshot taken
    // when the status started is read at the fight's mean, which is not
    // certainly either direction: what a refresh does to it is unreadable
    // (the audit entry says so).
    //
    // The context's DamageModifier is the tempting thing to drop here, as a
    // double count against `poolMultiplier`. It is not one - the two copies
    // are different facts (above) - and GameObject.getDamageRatio@4577 op 11 leaves no
    // way to take the bracket without it.
    //
    // The stages are kept apart, not only multiplied, so the line this dot
    // prints can name each one beside the ledger it scales (below).
    const avgSheet = live?.averagedSheet ?? sheet;
    const poolTick = (d) => {
      const e = (d.prof?.effects ?? []).find((x) => x.kind === 'Damage');
      const root = e ? affinityOf(e.affinity).root : 'Raw';
      const t = { root, through: 1, bracket: 1, context: 1, scale: 1 };
      if (root === 'Raw') return t;
      t.through = mitigate(e, sheet, target, NO_DEBUFF, live?.mods ?? NO_MODS, opts.attackerLevel ?? null);
      if (opts.assume.tickSource !== 'carrier') {
        const fervorAdd = opts.assume.fervorScope !== 'none' ? (avgSheet.get('Fervor') ?? 0) / 100 : 0;
        const masteryAdd = opts.assume.mastery
          ? (avgSheet.get(root === 'Physical' ? 'PhysicalMastery' : 'MagicMastery') ?? 0) / 100 : 0;
        t.bracket = 1 + fervorAdd + masteryAdd;
        t.context = avgDmgMod;
      }
      t.scale = t.through * t.bracket * t.context;
      return t;
    };
    // Per pool dot, always: the tick's own stages are a property of the
    // status's affinity, so one shared multiplier cannot carry them. A build
    // with no scoped talent keeps the unscoped bleed modifiers it had.
    const poolScale = new Map();
    for (const d of rotation.dots ?? []) {
      if (!d.pool) continue;
      const stages = poolTick(d);
      const tick = stages.scale;
      if (!bleedScoped) {
        if (tick !== 1) {
          poolScale.set(d.status, { mult: poolMultiplier * tick, healShare: bleedMods.healShare ?? 0, tick: stages });
        }
        continue;
      }
      let dmgMult = 0, critCh = 0, healShare = 0;
      for (const mod of bleedScoped) {
        if (!coveredBy(mod.statusType, d.types)) continue;
        if (mod.field === 'dmgMult') dmgMult += mod.amount;
        else if (mod.field === 'critChance') critCh += mod.amount;
        else if (mod.field === 'healShare') healShare += mod.amount;
      }
      poolScale.set(d.status, {
        mult: avgDmgMod * (1 + dmgMult)
          * (1 + critCh * ((sheet.get('CritDamage') ?? 100) / 100 - 1)) * tick,
        healShare,
        tick: stages,
      });
    }
    // WHAT THE POOL LINE SAYS ABOUT THOSE STAGES. The fight writes the line's
    // derivation from its own ledger - "40% of 1212 damage dealt by itself
    // ... 75 of it was still owed" - and a reader multiplies that out. The
    // product is the line only while every stage above is 1: a Physical
    // bleed against 40% armour pays about x0.6 of it, and a line that does
    // not say so cannot be checked by hand. The stages are this module's, so
    // it names them here, each with its factor, after the fight has written
    // the rest. A Raw pool has none and its line is the fight's sentence
    // untouched.
    const tickStagesWhy = (t) => {
      const parts = [];
      if (t.through !== 1) {
        parts.push(`x${t.through.toFixed(4)} through the target's armour, a second pass (the hit it banked had paid it once)`);
      }
      if (t.bracket !== 1) {
        parts.push(`x${t.bracket.toFixed(4)} for your (1 + Fervor + ${t.root}Mastery) bracket`);
      }
      if (t.context !== 1) {
        parts.push(`x${t.context.toFixed(4)} for your DamageModifier in the tick's own context, a second time`);
      }
      return parts.length ? `; each tick is then a ${t.root} hit of its own: ${parts.join(', ')}` : '';
    };

    // A talent rider on your own casts that holds only while the target wears
    // a status of some type, for the types this fight tracks as statuses of
    // the build's own: which statuses count is the parent-chain match the
    // dots already use, so a dose (Poison_Dose, no parent) is not a Poison.
    const whileTyped = (live?.mods?.whileTyped ?? []).map((r) => ({
      ...r,
      statuses: (rotation.dots ?? []).filter((d) => coveredBy(r.statusType, d.types)).map((d) => d.status),
    })).filter((r) => r.statuses.length);
    // THE TWO TYPED READERS OF A STATUS'S OWN HITS, asked of that same list
    // for the same reason: it is the fight's, and the plan's is the build's
    // alone. A set attached to the armour puts statuses on the foe that no
    // plan knows of (engine.mjs joins them to `rotation.dots`), and the
    // game's two tests do not ask whose a status is:
    //
    //   * the count of one type on the target (Intent to Kill:
    //     `dmg.target.getStatusesCount(s -> s.isType(StatusType.Poison))`;
    //     ent.GameObject.getStatusesCount@4632, 32 ops, walks this.statuses
    //     and counts what the predicate accepts - op 27 the call, op 29 the
    //     increment, no instigator compared);
    //   * the crit chance a status on the target hands the status hits its
    //     wearer RECEIVES (Gaping Wound's onReceiveDamageEval behind
    //     `dmg.isStatusType(...)`; BaseSkillAccess.isStatusType@5188 asks the
    //     hitting skill, a Status, for its own type - Status.isType@15821).
    //
    // So Hive Venom, typed Poison, is one more poison to the first and one
    // more Poison-typed status hit to the second. Both were bound by the plan
    // to the plan's own dots, where Finish the Job (above) was already
    // answered here - three readers of one type, two answers in one fight,
    // and 14.7 dps of the default Rogue optimum (1,054.2 before, 1,068.9 with
    // both answered, the same build). On the target means worn by
    // it: a status the owner wears (`to: 'Self'`) is on neither side of
    // either test. A pool is the granter of nothing and takes no live rider
    // (the plan's rule, and a floor the audit names).
    //
    // The plan's rotation is cached across builds that differ only in armour
    // and a set's dots are the reader's own rows, so nothing is written onto
    // either: the fight is handed a rotation of its own where one differs.
    const typedRot = (() => {
      const onFoe = (rotation.dots ?? []).filter((d) => d.to !== 'Self');
      const dotRiders = (rotation.dotRiders ?? []).map((r) => {
        const typed = onFoe.filter((d) => coveredBy(r.statusType, d.types));
        return { ...r, statuses: typed.map((d) => d.status), names: typed.map((d) => d.name) };
      }).filter((r) => r.statuses.length);
      const granters = onFoe.filter((g) => g.grantsCrit && !g.pool);
      let moved = false;
      const dots = (rotation.dots ?? []).map((d) => {
        if (!granters.length || d.pool || d.to === 'Self') return d;
        const from = granters.filter((g) => g.grantsCrit.types.some((t) => coveredBy(t, d.types))).map((g) => g.status);
        const had = d.critFrom ?? [];
        if (from.length === had.length && from.every((s) => had.includes(s))) return d;
        moved = true;
        return { ...d, critFrom: from };
      });
      return { ...rotation, dotRiders, ...(moved ? { dots } : {}) };
    })();

    const fought = simulate({
      rotation: typedRot, cast, dotOutput, rollCrit, cooldownMult, cooldownFactor, weaponSkillRefund, resources, poolMultiplier,
      statusHitScale: statusHit, whileTyped,
      // Inner Demon's register, with its shield priced here where the sheet
      // is: the shield equals the life paid, health x lifeFrac, and the
      // resting claim is current ~ max.
      wsReset: rotation.wsReset ? {
        ...rotation.wsReset,
        shieldAmount: rotation.wsReset.shieldFrac > 0
          ? rotation.wsReset.shieldFrac * (sheet.get('MaxHealth') ?? 0) : 0,
      } : null,
      sparkGauge: rotation.sparkGauge ?? null,
      poolScale: poolScale.size ? poolScale : null,
      poolFactor,
      goal: live?.goal ?? null,
      chainResets: opts.assume?.chainResets ?? true,
      // The share of a passive's drops the hero walks into (--pickups).
      pickupShare: Math.max(0, Math.min(1, opts.assume?.pickupShare ?? 1)),
      empowerments: opts.empowerments ?? [],
      // Priced with the sheet, so the profile and its output are resolved here
      // and the sim only has to multiply by the count it measured.
      stackProcs: (opts.stackProcs ?? []).map((sp) => {
        const prof = profile(sp.skill, opts.rank ?? 1);
        return prof
          ? { ...sp, prof, out: castOutput(prof, sheet, target, opts, NO_DEBUFF, live?.mods ?? NO_MODS) }
          : sp;
      }).filter((sp) => sp.prof),
      // A mark's lump is the STATUS row's scripted step, so it is priced as a
      // status tick: in the mark's own context, seeded by whoever applied it.
      // On the accepted build that context was the wearer's - an enemy-worn
      // Debuff, so no crit and no bracket, and the capture's 51 rows were one
      // constant integer with zero crits. On this build it is the player's
      // (see `tickSource` in castOutput): a mark is not DoT-typed, so its
      // lump now rolls the player's crit and takes the bracket. Unmeasured.
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
      // A detonating mark's step, priced at ONE stack the same way (it is the
      // status row's own step); the fight multiplies by the stacks it spends.
      detonations: (opts.detonations ?? []).map((dt) => {
        const sp = profile(dt.status, opts.rank ?? 1);
        const step = (sp?.scripted ?? []).find((x) => x.stepId === dt.step);
        if (!sp || !step?.effects?.length) return dt;
        const prof = {
          ...sp, effects: step.effects,
          occupancy: 0, cooldown: 0, charges: 1, costs: [], isFiller: false, isCombo: false,
          scripted: [],
        };
        return { ...dt, prof, out: castOutput(prof, sheet, target, opts, NO_DEBUFF, live?.mods ?? NO_MODS) };
      }).filter((dt) => dt.prof),
      comboWindow: cdb.byId('constant').get('ComboWindow')?.v?.float ?? 0.6,
      swingVariance: cdb.byId('constant').get('WeaponAttack_RandomRange')?.v?.float ?? 0.1,
      poolHealShare: bleedMods.healShare ?? 0,
      critChance: Math.min(1, Math.max(0, (sheet.get('CritChance') ?? 0) / 100)),
      timedBuffs: live?.timedBuffs ?? [],
      fight: opts.fight ?? 200,
      chainFeeds: opts.chainFeeds ?? [],
      holdChain: opts.holdChain === true,
      fights: opts.fights ?? 1,
      lookahead: opts.lookahead ?? 0,
      seed: opts.seed ?? 0x9e3779b9,
      // An authored rotation, when one is being tested rather than derived.
      policy: live?.policy ?? null,
    });
    for (const l of fought.lines ?? []) {
      const stages = l.pool ? poolScale.get(l.id)?.tick : null;
      if (stages && typeof l.why === 'string') l.why += tickStagesWhy(stages);
    }
    return fought;
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
    // computeDamage@4920 ops 88-115 - and it was missing here.
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
  // to come from the weapon. This function is the FLAT half - what
  // getStepEffectItemScaling@21779 returns for a `WeaponPower` entry - and
  // `scalingValue` adds the attribute half at consumption.
  //
  // HISTORY of how it was found, on the accepted 2026-08-11 build: a real
  // Cheese Moon on a 0-armor dummy read "18-21 Physical damage" in the bag
  // and swung 19-24 naked, where swing 1's authored 0.13 x WeaponPower needs
  // ~150-165. The old slot-share reading (x0.28) priced the same swing at
  // 4.5-5.7, four times low on every base attack in the game. Those two
  // readings fitted that build's rule (the SUM of the budgets, see below)
  // and are not readings of this one.
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
  //
  // `aptitude.props.flags` has one case today, EquipCondition, and the flat's
  // closure tests it by position (bit 0). Resolved by name, loudly: a silent
  // miss here would zero every base attack in the game.
  const equipConditionBit = (() => {
    const i = cdb.enumValues('aptitude@props', 'flags').indexOf('EquipCondition');
    if (i < 0) throw new Error('cdb: aptitude@props.flags has no EquipCondition case (game data changed?)');
    return 1 << i;
  })();
  function weaponPowerFor(cat, loadout, cls) {
    const apt = cdb.byId('aptitude').get(cls.aptitude);
    const primary = (apt?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0);
    if (!primary) return 0;
    const g = loadout.gear.Slot_Weapon1;
    if (!g?.item) return 0;
    const item = cat.itemById.get(g.item);
    if (!item) return 0;
    // READ FROM THE BYTECODE, op by op, on build 25782799:
    //
    //   getStepEffectScaling@21777 ops 2-25   itemRatio is the constant only
    //       when the item's type chain reaches MainhandWeapon, and ops 36-47
    //       ask for the flat only when it is above zero.
    //   getStepEffectItemScaling@21779 ops 44-93   for a `WeaponPower` entry,
    //       collect ONE primary attribute per aptitude the item names (the
    //       first atbScaling row with statGroup 0), then ops 94-115 call the
    //       closure once per primary with `factor = 1 / count`.
    //   fn@21783 (the closure)   ops 5-9 return unless the attribute is
    //       flagged ItemScaling; ops 15-149 take the item's aptitudes that
    //       carry EquipCondition (every such aptitude when it names none);
    //       op 152 is getExpectedAttributeAtAptitudesLevel@21643 - the MEAN
    //       start and the mean end of the rows paying that attribute across
    //       those aptitudes, through the level curve at the ITEM's level -
    //       and ops 153-159 multiply it by s.ratio, by itemRatio, and by
    //       `factor`.
    //
    // So the flat is itemRatio x the MEAN over the item's aptitudes of each
    // primary's budget: 0.4 x 123.6 for single-aptitude Judgement, 0.4 x
    // (123.6 + 148.3) / 2 for Cheese Moon. Rarity, stars and iLevel bonuses
    // never enter, and no handedness factor exists anywhere in the damage
    // path - the 1H/2H asymmetry is the authored per-type swing ratios.
    //
    // HISTORY: the last multiply is new. The accepted build's closure (the
    // function that is fn@21783 today; 172 ops then, 173 now) unpacked `factor` at ops
    // 0-3 and never used it, so a dual-aptitude weapon SUMMED its two
    // budgets, and every tooltip flat of that build reproduces on the sum -
    // Beefury 13 = 0.13 x 0.4 x (123.6 + 123.6), Wingsabers 22 = 0.205 x 0.4
    // x (123.6 + 148.3). Op 159 `r34 = r34 * r3` is the one op the patch
    // added to that function. A single-aptitude weapon's flat did not move.
    if (!item.chain?.includes('MainhandWeapon')) return 0;
    const aptRows = cdb.byId('aptitude');
    const equips = (a) => ((a?.props?.flags ?? 0) & equipConditionBit) !== 0;
    const own = (item.aptitudes ?? []).map((id) => aptRows.get(id)).filter(Boolean);
    const primaries = own
      .map((a) => (a.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0)?.endAtb)
      .filter(Boolean);
    // No aptitudes, no WeaponPower. An earlier fallback substituted the class
    // primary's budget and handed a butterfly net the exact WeaponPower of a
    // Legendary greatsword (0.4 x 123.6 = 49.43, found by pinning Net_Basic
    // as mainhand and reading the sheet). The outer loop is over the item's
    // OWN aptitudes; an empty list calls the closure zero times.
    if (!primaries.length) return 0;
    let paying = own.filter(equips);
    if (!paying.length) paying = cdb.lines('aptitude').filter(equips);
    let sum = 0;
    for (const atb of primaries) {
      if (!ctx.attrTable.byId.get(atb)?.flags.has('ItemScaling')) continue;
      let start = 0, end = 0, n = 0;
      for (const a of paying) {
        for (const row of a.atbScaling ?? []) {
          if (row.endAtb !== atb) continue;
          start += row.start ?? 0; end += row.end ?? 0; n++;
        }
      }
      if (n) sum += budget(loadout.level, start / n, end / n, ctx.consts.earlyMaxLevel);
    }
    return itemRatio * sum / primaries.length;
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

  /**
   * What ONE ITEM pays, per attribute, to a skill it grants - the flat
   * getStepEffectItemScaling@21779 hands back for an ordinary scaling entry
   * before the ratio and the item share multiply it. READ, on build 25782799,
   * in its closure fn@21783:
   *
   *   ops 5-9      nothing for an attribute not flagged ItemScaling;
   *   ops 15-149   the aptitudes asked are the ITEM's own that carry
   *                EquipCondition - and every aptitude in the sheet that
   *                does, when the item names none (a trinket's aptitude is a
   *                stat line such as Crit, which carries no such flag);
   *   op 152       $HAttributes.getExpectedAttributeAtAptitudesLevel@21643:
   *                the MEAN start and the mean end of every row of those
   *                aptitudes that pays the attribute (any stat group), through
   *                the level curve at `item.level` - the instance's level
   *                (Gear.updateInf@9757 writes it into the item's def).
   *
   * `item` is a catalog item, `level` its instance level. Returns a Map of
   * attribute id -> flat, holding only attributes some asked aptitude pays.
   */
  function itemBudgets(item, level) {
    const flats = new Map();
    const aptRows = cdb.byId('aptitude');
    const equips = (a) => ((a?.props?.flags ?? 0) & equipConditionBit) !== 0;
    let paying = (item?.aptitudes ?? []).map((id) => aptRows.get(id)).filter(equips);
    if (!paying.length) paying = cdb.lines('aptitude').filter(equips);
    const sums = new Map();
    for (const a of paying) {
      for (const row of a.atbScaling ?? []) {
        if (!row.endAtb || !ctx.attrTable.byId.get(row.endAtb)?.flags.has('ItemScaling')) continue;
        const s = sums.get(row.endAtb) ?? { start: 0, end: 0, n: 0 };
        s.start += row.start ?? 0; s.end += row.end ?? 0; s.n++;
        sums.set(row.endAtb, s);
      }
    }
    for (const [atb, s] of sums) {
      flats.set(atb, budget(level, s.start / s.n, s.end / s.n, ctx.consts.earlyMaxLevel));
    }
    return flats;
  }

  // THE AUDIT PRINTS A PRICING RULE WITH THE NUMBERS THE PRICING READ. The
  // item ratio, the keep and the attributes the MainAttribute flag names all
  // come out of the data above, so the sentences that state those rules take
  // them from the same place: a patch that moves the constant or flags a
  // fifth attribute then moves the printed rule with the number, where a
  // typed "0.4 x budget + 0.6 x attribute" would go on asserting the old one.
  const shown = (x) => String(+(+x).toFixed(4));
  const shownPct = (x) => shown(100 * x);
  const atbName = (id) => cdb.byId('attribute').get(id)?.name ?? id;
  const listOf = (names) => (names.length < 2 ? names.join('')
    : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);
  const wpItemScaled = ctx.attrTable.byId.get('WeaponPower')?.flags.has('ItemScaling') === true;
  const mainNames = mainAttributes.length
    ? listOf(mainAttributes.map(atbName))
    : 'no attribute at all (no row carries the MainAttribute flag)';
  // The WeaponPower entry's worked tooltip, from the rows it names: Cheese
  // Moon's first swing (the row's own WeaponPower ratio) and the primary
  // curve of each aptitude the item names, at the WEAPON level the protocol
  // asks for. `mean` is this build's closure, `sum` the accepted build's
  // (the one multiply apart - see `weaponPowerFor`). A tooltip shows the flat
  // to the NEAREST integer: the accepted build's 12.85 read 13 on Beefury and
  // its 22.30 read 22 on Wingsabers, which neither a ceiling nor a floor does.
  // `twin` is the trap the precondition exists for: a weapon level below the
  // protocol's at which the accepted rule's own flat displays this rule's
  // number - the flat is the WEAPON's level through the curve (fn@21783 ops
  // 12-14 and 150-152), so a part-trained weapon reads low under either rule.
  const wpWorked = (() => {
    const level = 25;
    const item = cdb.byId('item').get('Axe_Boomerang');
    const swing = (item?.skills ?? []).map((x) => cdb.byId('skill').get(x.skill))
      .find((s) => s && cdb.enumName('skill', 'type', s.type ?? -1) === 'Attack');
    const ratio = (swing?.steps ?? []).flatMap((st) => st.effects ?? []).flatMap((e) => e.scaling ?? [])
      .find((sc) => sc.atb === 'WeaponPower')?.ratio;
    const curves = (item?.aptitudes ?? [])
      .map((a) => (cdb.byId('aptitude').get(a.ref)?.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0));
    if (!(ratio > 0) || curves.length < 2 || curves.some((c) => !c?.endAtb)) return null;
    const flat = (lvl, rule) => {
      const sum = curves.reduce((s, c) => s + budget(lvl, c.start, c.end, ctx.consts.earlyMaxLevel), 0);
      return ratio * itemRatio * (rule === 'sum' ? sum : sum / curves.length);
    };
    const mean = Math.round(flat(level, 'mean'));
    let twin = null;
    for (let lvl = level - 1; lvl >= 1 && twin == null; lvl--) if (Math.round(flat(lvl, 'sum')) === mean) twin = lvl;
    return {
      name: item.texts?.name ?? item.id, level, twin,
      mean, sum: Math.round(flat(level, 'sum')),
      kept: shownPct(ratio * weaponPowerKeep / curves.length), whole: shownPct(ratio / curves.length),
      atbs: curves.map((c) => atbName(c.endAtb)),
    };
  })();

  // What the audit says about targets is COUNTED off the rows it describes:
  // the entry this replaces listed the September PTR's heroic rows by hand
  // ("ten rows on six foes", "Ratsar Vitality x50") and was wrong about the
  // build that shipped.
  const targetFacts = (() => {
    const rows = cdb.lines('unit');
    const heroicOn = rows.filter((u) => (u.stats ?? []).some((s) => s.heroic === true));
    const count = (pred) => rows.reduce((n, u) => n + (u.stats ?? []).filter(pred).length, 0);
    const isArmour = (s) => s.attribute === 'Armor' || s.attribute === 'MagicArmor';
    // Bosses whose armour intent exists ONLY in Heroic: their Normal row is
    // an inherited one.
    const heroicOnlyArmour = heroicBosses.filter((id) => (units.get(id).stats ?? []).some((s) => s.heroic === true && isArmour(s))
      && !(units.get(id).stats ?? []).some((s) => s.heroic !== true && isArmour(s)));
    const otherHeroicArmour = heroicOn.filter((u) => !heroicBosses.includes(u.id)
      && u.stats.some((s) => s.heroic === true && isArmour(s))).map((u) => u.id);
    const dungeonBit = unitFlagNames.indexOf('Dungeon');
    const split = [...armourSplits.byStub, ...armourSplits.authored];
    const [a, b] = ctx.consts.resistFormula;
    const max = Math.round(ctx.consts.maxLevel);
    const through = (t) => 1 - t.armor / (t.armor + a + b * max);
    return {
      heroicTrue: count((s) => s.heroic === true), heroicFalse: count((s) => s.heroic === false),
      heroicUnits: heroicOn.map((u) => u.id), heroicOnlyArmour, otherHeroicArmour,
      dungeonUnits: dungeonBit < 0 ? null : rows.filter((u) => mergedFlags(u.id) & (1 << dungeonBit)).length,
      splitGolems: split.filter((id) => armourSplits.byStub.includes(id)),
      splitOther: split.filter((id) => !armourSplits.byStub.includes(id)),
      max, through, pct: (x) => `${(100 * x).toFixed(1)}%`,
      constant: (id) => { try { return cdb.constant(id); } catch { return null; } },
    };
  })();
  const heroicAudit = () => {
    const tf = targetFacts;
    if (!NAMED.heroic) {
      return { severity: 'info', what: 'no heroic target on this build',
        why: heroicAuthored.length
          ? `${heroicAuthored.length} unit rows author props.heroicLootTable and no dungeon of theirs has Heroic released (${heroicAhead.map((x) => `${x.id}: ${x.why}`).join('; ')}), so there is no heroic boss to stand a target on.`
          : 'No unit row authors props.heroicLootTable, so there is no heroic boss to stand a target on.' };
    }
    const h = foe('heroic', tf.max);
    const d = foe('dummy', tf.max);
    const red = (x) => x.toFixed(2);
    return { severity: 'assumption', what: 'a heroic target is the unit\'s heroic stat rows at MaxLevel - read from the client, not yet measured in game',
      why: 'Heroic is the third ActivityDifficulty (st.GameLayer.isHeroicMode@7661: difficulty == 2). A unit stat row is ' +
           'three-state - no `heroic` key applies in both modes, false in Normal only, true in Heroic only (the unit merge, ' +
           'DataCache.initUnits@19817 closure fn@19874 ops 85-110) - and on this build ' +
           `${tf.heroicTrue} rows on ${tf.heroicUnits.length} units carry true (${tf.heroicUnits.join(', ')}) and ${tf.heroicFalse} carry false. ` +
           'Every foe a spawner makes in Veteran or Heroic is created at MaxLevel whatever its row says ' +
           '(ent.FoeGenerator.spawnUnit@7528 ops 40-76). `--target <unit>@heroic` reads exactly that, and `heroic` is what the ' +
           `${heroicBosses.length} bosses that author a heroic loot table in a dungeon whose Heroic is released resolve to: ${heroicNamed.share} of ${heroicNamed.of} at ` +
           `${red(h.physReduction)} / ${red(h.magicReduction)}, a pool of ${h.armor} at level ${h.spawnLevel}` +
           (tf.heroicOnlyArmour.length
             ? ` - ${tf.heroicOnlyArmour.length} of them (${tf.heroicOnlyArmour.join(', ')}) on an Armor / MagicArmor row they only have in Heroic, ` +
               'so their Normal selves mitigate what their archetype does. '
             : '. ') +
           (heroicAhead.length
             ? `${heroicAhead.length} more author a heroic loot table and are not heroic targets: ${heroicAhead.map((x) => x.why.replace(/^Heroic is not released for /, `${x.id}, Heroic not released for `)).join('; ')}. `
             : '') +
           (heroicUnjudged.length
             ? `${heroicUnjudged.length} that author one are kept although their release could not be read: ${heroicUnjudged.map((x) => `${x.id} (${x.why})`).join('; ')}. `
             : '') +
           'The same flag sits on foe skill rows (effects, step conditions, heroicData overrides); none of those is hosted by ' +
           'a class row or an item on this build, so nothing on the damage side reads it. Health (Vitality) and FoePower rows ' +
           'change too and are not inputs of this model. To settle in game: one non-crit base swing on a heroic boss against the ' +
           `same swing on the training dummy - ${(tf.through(h) / tf.through(d)).toFixed(3)} of the dummy's number if both rows are read right ` +
           '(solo, or the party\'s armour shreds are in it).' };
  };
  const dummyAudit = () => {
    const tf = targetFacts;
    const d = foe('dummy', tf.max);
    const parity = foe('dummy', tf.max, tf.max);
    return { severity: 'verified', what: `the training dummy is not a zero-mitigation target - it lets ${tf.pct(tf.through(d))} through at level ${tf.max}, read and measured on this build`,
      why: `The Dummy unit authors armorReduction ${units.get('Dummy')?.stats?.find((s) => s.attribute === 'Armor')?.specScaling?.armorReduction ?? '?'} ` +
           `and magicReduction ${units.get('Dummy')?.stats?.find((s) => s.attribute === 'MagicArmor')?.specScaling?.magicReduction ?? '?'} since the 2026-10 build ` +
           '(both were 0, which is what every "0-armour dummy" calibration before it stood on). Its row has no lvl, the five spawners ' +
           'that place it (three in zone Z2_Azuram_Hub, two in Z1_Primevalley_Hub - read 2026-10-08 in the install\'s level ' +
           'prefabs, which the bench does not open) name none, and the unit constructor then makes it level 1 ' +
           '(ent.$Unit.__constructor__@15927 ops 135-165) - the level all 5,013 pre-patch hits on it were logged at. So the pool is ' +
           `${d.armor}, built at level ${d.spawnLevel} and divided at yours. \`--target none\` is the target that mitigates nothing; ` +
           '`--target dummy` is this unit. To settle in game: a level-' + tf.max + ' character\'s white non-crit base attacks on the dummy against the ' +
           `same swing's tooltip mid-range. ${tf.through(d).toFixed(3)} is this reading; ${tf.through(parity).toFixed(3)} means the pool is built at the ` +
           'striker\'s level; 1.000 means the server\'s row is not this one. Hit it with a pet as well: a summon takes its owner\'s ' +
           'level (ent.GameObject.spawnFoe@4698 ops 28-30) and which level divides a pet\'s hit was invisible on a dummy with no armour. ' +
           'MEASURED 2026-10-13 (probe v10, build 25782799, the three yard dummies in Tyrna): all 18,665 hits the four ' +
           'characters logged on them carry tlvl=1, and hits that do not vary land on this pool to the integer - a level-25 Warrior ' +
           'at 48.3% penetration (0.9453 through) logs Raging Smash at 248 for a priced 247.4, Rampage at full charge 853 for 852.5, ' +
           'Worldsplitter\'s Tear Reality 324 for 323.0, Charge 232 for 231.9, each the ceiling of the figure. A pool built at the ' +
           'striker\'s level would read them 21% lower and no armour 6% higher. Still to settle: the pet half (no summon was ' +
           'measured against a figure here).' };
  };
  const ccOf = (name) => {
    const t = foe(name, targetFacts.max);
    return `\`${name}\` ${t.ccImmune ? 'is immune' : 'is not'} (${t.ccImmuneWhy})`;
  };
  const stunOf = (name) => {
    const t = foe(name, targetFacts.max);
    return `\`${name}\` ${t.stunImmune ? 'refuses a stun' : 'takes one'} (${t.stunImmuneWhy})`;
  };
  // The census behind "ccImmune false is not every crowd control landing":
  // units a stun is refused on though isCCImmune says they are not immune.
  const stunFacts = (() => {
    const rows = cdb.lines('unit');
    const noStun = rows.filter((u) => mergedFlags(u.id) & noStunMask);
    return {
      noStun: noStun.length,
      noStunNotImmune: noStun.filter((u) => !(mergedFlags(u.id) & ccImmuneMask)).length,
      deafType: rows.filter((u) => mergedType(u.id) === STATUS_DEAF_TYPE).length,
      invulnerable: rows.filter((u) => mergedFlags(u.id) & invulnerableMask).length,
    };
  })();
  // What the levels entry says about summons, counted off the rows: the
  // level-less targets a summoner's level was found for, the ones left at the
  // striker's, the ones nothing summons, and the summoned rows whose own lvl
  // is not where their summoners stand.
  const summonFacts = (() => {
    const byHosts = [];
    const atStriker = [];
    const rowDiffers = [];
    let atOne = 0;
    const range = (lo, hi) => (hi > lo ? `${lo}-${hi}` : `${lo}`);
    for (const id of targetsByUnit.keys()) {
      const span = levelSpanOf(id);
      if (span.from === 'summon') (span.striker ? atStriker : byHosts).push(id);
      if (span.from === 'default') atOne++;
      if (span.from !== 'row' || !summonedUnits.has(id)) continue;
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of summonersOf.get(id) ?? []) {
        const s = levelSpanOf(h);
        if (s.striker) continue;
        lo = Math.min(lo, s.lo);
        hi = Math.max(hi, s.hi);
      }
      if (lo !== Infinity && (span.hi < lo || span.lo > hi)) {
        rowDiffers.push(`${id} ${range(span.lo, span.hi)} under ${[...summonersOf.get(id)].join(', ')} at ${range(lo, hi)}`);
      }
    }
    return { byHosts, atStriker, rowDiffers, atOne };
  })();
  // The one swing that would settle the armour law in game, written off the
  // rows it names: a unit with its own row under a parent's, against a unit
  // on that parent's row alone, at the same row level - the pair the capture
  // contrast leaned on hardest (15 and 10 of its 201 pairs). At equal levels
  // and no penetration what gets through is 1 / (1 + S), so the two readings
  // predict different ratios and opposite sides of 1.
  const armourLawSwing = () => {
    const [A, B] = ['ImpDemon_Rift', 'Demon_Rift_Claws'];
    const ua = units.get(A);
    const ub = units.get(B);
    const ownReds = (id, seen = new Set()) => {
      const u = units.get(id);
      if (!u || seen.has(id)) return [];
      seen.add(id);
      return [
        ...(u.stats ?? []).filter((s) => s.attribute === 'Armor' && s.heroic !== true && s.specScaling?.armorReduction > 0)
          .map((s) => s.specScaling.armorReduction),
        ...(u.inherit ?? []).filter((i) => !i?.textOnly && i?.ref).flatMap((i) => ownReds(i.ref, seen)),
      ];
    };
    const ra = ownReds(A);
    const rb = ownReds(B);
    if (!ua || !ub || ua.lvl == null || ua.lvl !== ub.lvl || ra.length < 2 || rb.length !== 1 || !(ra[0] < rb[0])) {
      return 'Still owed, solo: the same swing on two units of one level, one with its own row under a parent\'s and one on ' +
             'that parent\'s row alone - the pair this entry used to name no longer has that shape in the data.';
    }
    const sumS = (reds) => reds.reduce((s, r) => s + r / (1 - r), 0);
    const one = (1 + armourIntent(B).physS) / (1 + armourIntent(A).physS);
    const summed = (1 + sumS(rb)) / (1 + sumS(ra));
    const nm = (id) => units.get(id)?.texts?.name ?? id;
    return `Still owed, solo: one swing on a ${nm(A)} (${A}, own ${ra[0]} under ${ra.slice(1).join(' / ')}) against the same swing on a ` +
           `${nm(B)} (${B}, ${rb[0]} alone), both level ${ua.lvl} - for a level-${ua.lvl} character with no penetration on the ` +
           `sheet, about ${one.toFixed(2)} confirms one row and ${summed.toFixed(2)} would be the sum.`;
  };

  // The rows that interrupt the running skill when they are used, as the
  // sheet has them today, by name (see `interruptStyleNames`).
  const interrupterRows = cdb.lines('skill').filter((s) => s.props?.interruptStyle != null);
  const interrupters = [...new Set(interrupterRows.map((s) => s.texts?.name ?? s.id))];

  // THE ROW COUNTS THE ENTRIES BELOW QUOTE, TAKEN OFF THE SHEET AS THE LIST IS
  // BUILT. They were typed in on the 2026-08-11 data and then printed as
  // facts about whatever build is installed: on build 25782799 the audit
  // still said "427 of 962 skills carry hscript" (508 of 1,098), "authored
  // on 11 of 250 status rows ... only four statuses declare it" (13 of 318,
  // six), "seven rows author -1" (eleven), "158 steps declare it" (214),
  // "Thirteen skills carry a type-23 Summon step" (seventeen). Each count is
  // one filter over the rows, written here once; a sentence that leans on a
  // count ("only a foe status carries affixes among the seven") is built
  // from the same rows instead of beside them.
  const census = (() => {
    const rows = cdb.lines('skill');
    const nameOf = (s) => s.texts?.name ?? s.id;
    const skillTypes = cdb.enumValues('skill', 'type');
    const policies = (() => { try { return cdb.enumValues('skill@props@status', 'stackingPolicy'); } catch { return []; } })();
    const statusRows = rows.filter((s) => s.props?.status != null);
    const byPolicy = new Map(policies.map((p) => [p, []]));
    for (const s of statusRows) {
      const p = policies[s.props.status.stackingPolicy ?? -1];
      if (p) byPolicy.get(p).push(s);
    }
    const steps = rows.flatMap((s) => (s.steps ?? []).map((st) => ({ s, st })));
    const typed = (name) => steps.filter((x) => stepTypeNames[x.st.type] === name);
    // A step that carries an amount of its own: some effect with a base value
    // or a ratio that is not zero.
    const hasAmount = (st) => (st.effects ?? []).some((e) => (e.baseVal ?? 0) !== 0 || (e.scaling ?? []).some((x) => (x.ratio ?? 0) !== 0));
    const codeSteps = steps.filter((x) => stepOnNames[x.st.on] === 'Code');
    // `playStep(Steps.<id>, ...)` and `playStep(null, Steps.<id>, ...)`, the
    // two spellings the sheet's scripts use, against the ids of the row's
    // own steps.
    let playSites = 0, playOwn = 0;
    for (const s of rows) {
      if (typeof s.script !== 'string') continue;
      const own = new Set((s.steps ?? []).map((st) => st.id).filter(Boolean));
      for (const m of s.script.matchAll(/playStep\(\s*(?:null\s*,\s*)?Steps\.([A-Za-z0-9_]+)/g)) {
        playSites++;
        if (own.has(m[1])) playOwn++;
      }
    }
    const statusSteps = typed('Status');
    const summonSteps = typed('Summon');
    const uncapped = statusRows.filter((s) => s.props.status.maxStacks === -1);
    const upgrades = rows.filter((s) => /_Upgrade$/.test(s.id));
    // What is socketed and declares an item level of its own.
    const types = cdb.byId('itemType');
    const isAugment = (t) => { for (let x = t, n = 0; x && n < 12; x = types.get(x)?.inherit, n++) if (x === 'Augment') return true; return false; };
    const levelled = cdb.lines('item').filter((i) => isAugment(i.type) && (i.iLevel ?? 0) !== 0);
    // A loop whose duration over its tick ends in a half, on a step that
    // deals or heals something and is not an instantiated area.
    const halfLoops = steps.filter(({ s, st }) => {
      const tick = st.props?.loop?.tick;
      const dur = st.duration > 0 ? st.duration : st.duration === -1 ? s.duration : null;
      return tick > 0 && dur > 0 && (st.effects ?? []).length && stepTypeNames[st.type] !== 'Area'
        && Math.abs((dur / tick) % 1 - 0.5) < 1e-9;
    });
    const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
    // The rows with a DAMAGE effect scaled on MaxHealth.
    const effectKinds = cdb.enumValues('skill@steps@effects', 'effect');
    const maxHealthDamage = rows.filter((s) => (s.steps ?? []).some((st) => (st.effects ?? []).some((e) => effectKinds[e.effect] === 'Damage'
      && (e.scaling ?? []).some((sc) => sc.atb === 'MaxHealth'))));
    // A script line that writes a stack count into a damage field: `dmgMult`
    // assigned from getStatusCount(...) or from a `stacks` value.
    const countWrites = rows.filter((s) => typeof s.script === 'string'
      && /\bdmgMult\s*(?:\+=|\*=|=)[^;\n]*\b(?:getStatus(?:es|Type)?Count|stacks)\b/.test(s.script));
    // Which other rows name an uncapped row that carries affixes, in their
    // script or in a step (the two places a row applies a status from).
    const uncappedWithAffixes = uncapped.filter((s) => (s.affixes ?? []).length);
    const named = uncappedWithAffixes.length ? new RegExp(`\\b(?:${uncappedWithAffixes.map((u) => u.id).join('|')})\\b`) : null;
    const uncappedAffixAppliers = named ? rows.filter((s) => !uncappedWithAffixes.includes(s)
      && (named.test(typeof s.script === 'string' ? s.script : '') || ((s.steps ?? []).length && named.test(JSON.stringify(s.steps))))).map((s) => s.id) : [];
    return {
      nameOf, count,
      skills: rows.length,
      scripted: rows.filter((s) => typeof s.script === 'string' && s.script.trim()).length,
      statusRows: statusRows.length,
      policyRows: [...byPolicy.values()].reduce((n, l) => n + l.length, 0),
      policy: (p) => byPolicy.get(p) ?? [],
      uncapped, uncappedWithAffixes, uncappedAffixAppliers,
      codeSteps: codeSteps.length,
      codeStepsWithAmount: codeSteps.filter((x) => hasAmount(x.st)).length,
      playSites, playOwn,
      statusSteps: statusSteps.length,
      statusStepsWithStacks: statusSteps.filter((x) => x.st.props?.status?.stacks != null).length,
      summonSteps: summonSteps.length,
      summonSkills: new Set(summonSteps.map((x) => x.s.id)).size,
      subSkills: rows.filter((s) => skillTypes[s.type] === 'WeaponSubSkill'),
      upgrades: upgrades.length,
      upgradesScripted: upgrades.filter((s) => typeof s.script === 'string' && s.script.trim()).length,
      levelledAugments: levelled,
      halfLoops, maxHealthDamage, countWrites,
    };
  })();

  const audit = [
    heroicAudit(),
    { severity: 'unmodelled', what: 'heroic dungeon trash - the server rescales it, and the client does not say how',
      why: 'ent.Foe.init@6948 ops 1-29 calls setHeroicScaling on every unit flagged Dungeon' +
           (targetFacts.dungeonUnits != null ? ` (${targetFacts.dungeonUnits} units after the merge)` : '') +
           ' when it simulates the server, and ent.Foe.setHeroicScaling@7094 is a three-op "!isServer" stub in this client. ' +
           `Dungeon_Heroic_HealthScaling (${targetFacts.constant('Dungeon_Heroic_HealthScaling')}) and Dungeon_Heroic_FoePowerScaling ` +
           `(${targetFacts.constant('Dungeon_Heroic_FoePowerScaling')}) are written at static init and read by no client function, so which ` +
           'attribute each one multiplies, and how, is UNKNOWN - the names say health and foe power and nothing here confirms it. ' +
           'Neither is an input of this model; armour is, and ' +
           (targetFacts.otherHeroicArmour.length
             ? `besides the bosses only ${targetFacts.otherHeroicArmour.join(', ')} author a heroic Armor or MagicArmor row, `
             : 'no unit but the bosses authors a heroic Armor or MagicArmor row, ') +
           'so heroic trash is priced on its normal row at MaxLevel (`--target <unit>@heroic`). To settle: the health number of one ' +
           'Dungeon-flagged unit in Veteran against the same unit in Heroic - both stand at MaxLevel, so the ratio is the ' +
           'server\'s health scaling.' },
    { severity: 'verified', what: 'a unit\'s armour is ONE row - its own, else the nearest inherited - and not a sum over its parents',
      why: 'Read from the client: the unit merge keeps a child\'s reduction row and throws if two rows of one attribute survive ' +
           '(DataCache.initUnits@19817 closure fn@19874 ops 155-264), and ent.Unit.getAtbLevelScaling@4882 builds the pool from the ' +
           'single row DataCache.getStatInfo@19835 returns, times its multiplier, rounded. Held by the pre-patch capture: for one ' +
           'hero and one skill, a unit with its own 0.25 or 0.20 row under an inherited 0.30 takes MORE than a plain 0.30 unit at ' +
           'the same logged level in 186 of 201 pairs (median 1.073; one row predicts 1.071, a sum 0.811). Until the 2026-10 build ' +
           'the ladder printed the sum, fitted to boss windows in which the boss took more than either reading allows (party ' +
           'armour shreds, inferred - the target\'s live armour was never logged), and it read 12 to 18 points of mitigation too ' +
           'hard wherever a unit has a parent with a row (on that data: small 43% where its row says 25%, big 49% for 35%, elite ' +
           'and the inheriting bosses 52% for 40%). Limits: 19 heroes, the target\'s debuff state is not logged, and the 0.35 ' +
           'tier reads softer than its row. ' + armourLawSwing() },
    { severity: 'assumption', what: 'a target stands at its unit row\'s level; Veteran, Heroic and dynamic scaling are things you say',
      why: 'The pool is built at the TARGET\'s level and divided at yours, so the level is half the answer. Read from the client: ' +
           'a spawner passes its own level or none (ent.FoeGenerator.spawnUnit@7528 ops 28-39), the unit constructor then takes the ' +
           'row\'s lvl..maxLvl or 1 (ent.$Unit.__constructor__@15927 ops 135-165), Veteran and Heroic override it with MaxLevel ' +
           '(spawnUnit ops 40-76), and in an activity flagged DynamicScaling the pool is rebuilt at the STRIKER\'s level ' +
           '(ent.GameObject.receiveHit@4540 ops 0-15, ent.Unit.computeDamage@4920 ops 59-68). A SUMMONED unit never takes that ' +
           'roll: every summon path hands the constructor its summoner\'s level (ent.GameObject.spawnFoe@4698 ops 28-30), and who ' +
           'summons whom is in data.cdb (skill steps, skill scripts, unit scripts). So a row with no lvl that something summons ' +
           `stands where its summoners do - ${summonFacts.byHosts.length} such targets on this build` +
           (summonFacts.byHosts.length ? ` (${summonFacts.byHosts.join(', ')})` : '') +
           (summonFacts.atStriker.length
             ? `, and ${summonFacts.atStriker.length} more (${summonFacts.atStriker.join(', ')}) at your level, because no unit row carries the skill that summons them`
             : '') +
           ` - and only a row with no lvl that nothing summons stands at 1 (${summonFacts.atOne} targets, the training dummy among them). ` +
           'Held by the pre-patch capture: 296 of the 300 unit archetypes it logged a level for were only ever at their row\'s ' +
           'level, their summoners\' or at 25; the two level-less summons it met (ChaoticPortal, ImpDemon_Summoned) were logged at ' +
           '25 and 24 over 5,471 rows and never at 1. What the bench cannot see is which of those you are in - the activity rows ' +
           'and the few spawners that name a level ship in the level prefabs, not in data.cdb - so a unit id is priced at its row ' +
           '(Normal), and `@veteran`, `@heroic`, `@scaled` (a rift) or --target-level say otherwise. ' +
           (summonFacts.rowDiffers.length
             ? `${summonFacts.rowDiffers.length} summoned rows author a level other than their summoner's (${summonFacts.rowDiffers.join('; ')}) ` +
               'and are priced at the row: such a row may also be placed in the world, which the prefabs say and data.cdb does not. '
             : '') +
           'The named shortcuts (trash ... boss) are archetypes at YOUR level by declaration. The per-family fitted ' +
           'levels that stood here (rift 6.9, arena 7.9, dungeon 12) are gone with the armour sum they were fitted with: the logged ' +
           'levels contradict each one they match.' },
    dummyAudit(),
    { severity: 'assumption', what: 'crowd-control immunity is read off the unit\'s flags, and on an archetype it is a census',
      why: `ent.Foe.isCCImmune@7071 is the unit flags ${CC_IMMUNE_FLAGS.join(' / ')} and nothing else, and flags merge down the ` +
           'inheritance chain (fn@19874 ops 266-289), so a target that is a unit carries the game\'s own answer: ' +
           `${ccOf('boss')}, ${ccOf('dummy')}. An archetype base carries no flag itself - the flag sits on the units built from ` +
           `it - so its immunity is a majority vote of its heirs and an assumption about which one you meant: ${ccOf('elite')}, ` +
           `${ccOf('trash')}. Name the unit to get its own flags. \`none\` and \`reference\` are not units and can always be ` +
           'crowd-controlled. An immune unit refuses every status flagged CrowdControl that someone else applies ' +
           '(ent.GameObject.canReceiveStatus@4634), so no stun, root or slow ever stands on it. The converse does not hold: a ' +
           'unit that is not immune can still refuse a stun (ent.Unit.canReceiveStatus@4922 ops 0-57) - the next entry.' },
    { severity: 'assumption', what: 'a target that is not crowd-control immune can still refuse a stun - `stunImmune` is read off the unit row, and on an archetype it is a census',
      why: '`ccImmune` false does not mean every crowd control lands. The function that admits a status on a foe is ' +
           'ent.Unit.canReceiveStatus@4922, and before it reaches the immunity test it refuses a Stun-typed status on any unit ' +
           'flagged NoStun (ops 0-57: unit.flags bit 19, the status type or a parent of it being "Stun"), every status on a unit ' +
           'of type Critter (ops 58-64) and every status from a non-ally on a unit flagged Invulnerable (ops 65-76). On this ' +
           `build ${stunFacts.noStun} units carry NoStun after the merge and ${stunFacts.noStunNotImmune} of them are none of ` +
           `${CC_IMMUNE_FLAGS.join(' / ')} - a root or a slow lands on those and a stun does not; ${stunFacts.deafType} units are ` +
           `Critter-typed and ${stunFacts.invulnerable} Invulnerable. A target carries both answers: \`ccImmune\` is isCCImmune ` +
           'exactly (what a skill script reads), `stunImmune` is whether a stun someone else applies is refused, for any of ' +
           `those reasons or because the unit is immune outright. ${stunOf('boss')}, ${stunOf('dummy')}; and by census ` +
           `${stunOf('big')}, ${stunOf('dungeon')}, ${stunOf('elite')}, ${stunOf('trash')}. Not modelled: the Critter and ` +
           'Invulnerable refusals take every other status with them, damage over time included, and this model still prices a ' +
           'bleed, a burn or a poison on such a unit if you name one as the target.' },
    { severity: 'verified', what: 'Fervor and the matching mastery share ONE additive bracket, on everything except Raw damage',
      why: 'Read from GameObject.getDamageRatio@4577: ratio = (1 + fervor + mastery) x DamageModifier - additive ' +
           'with each other, multiplicative with the rest - applied to every affinity except Raw ' +
           '(getDamageScale@5238 returns 1 outright; that body was re-read on build 25782799, while ' +
           'the place it is applied per effect, Unit.applyEffect, was read on the 2026-08-11 build and ' +
           'is a server-only stub since). Measured live on the accepted build: finisher ' +
           '133 -> 151 = x(1 + 0.12 + 0.0158) exactly. WHOSE bracket a status tick takes is its own ' +
           'entry below, because that half changed in build 25782799 and is not measured. ' +
           '--fervor-scope and --no-mastery remain as toggles.' },
    { severity: 'verified', what: 'a base attack scales on R x MEAN over the weapon\'s aptitudes of ' +
           `(${shown(itemRatio)} x budget + ${shown(weaponPowerKeep)} x attribute) - read on build 25782799 and measured on its dummy`,
      why: (wpItemScaled
        ? `That is the ordinary ${shownPct(attrKeep)}/${shownPct(itemRatio)} weapon-skill mix, averaged over the aptitudes the weapon names, and `
        : 'The WeaponPower row carries no ItemScaling flag in this data, so the attribute half is added whole, and ') +
           'it is NOT the rule the accepted build measured. Read on this build: getStepEffectScaling@21777 ' +
           'ops 92-118 make an attribute flagged ItemScaling keep 1 - itemRatio of its ratio, and the ' +
           (wpItemScaled ? 'WeaponPower row carries that flag' : 'WeaponPower row does NOT carry that flag in this data') +
           '; convertWeaponPowerScaling@21781 then spreads that ratio ' +
           'over the item\'s aptitude primaries (ratio / count, ops 51-55); and the flat is ' +
           'getStepEffectItemScaling@21779 through its closure fn@21783, which multiplies each ' +
           'primary\'s budget by the ratio, by itemRatio and by 1 / count. itemRatio is ' +
           `WeaponPowerRatio.MainhandWeaponSkill (${shown(itemRatio)}); every weapon type inherits MainhandWeapon; no ` +
           'handedness factor exists anywhere in the damage path; rarity, stars and iLevel bonuses ' +
           'never enter the flat; the level is the WEAPON\'s own (fn@21783 ops 12-14 read item.level and ' +
           'ops 150-152 hand it to the budget curve), priced here at the character\'s, a weapon being ' +
           'trained up to it. ' +
           'ON THE ACCEPTED 2026-08-11 BUILD the rule was R x (0.4 x the SUM of the budgets + the full ' +
           'MEAN of the attributes), and every reading of that build fits it: Beefury 13 = 0.13 x 0.4 x ' +
           '(123.6+123.6), Wingsabers 22 = 0.205 x 0.4 x (123.6+148.3), Judgement 78-95 a swing. Two ' +
           'things changed and both can be seen without the game. The closure gained ONE op: op 159 ' +
           'multiplies the 1 / count factor its predecessor unpacked and never used (a pre-patch dump of ' +
           'that function, 172 ops then, differs from today\'s fn@21783 in exactly that op). And the WeaponPower ' +
           'attribute row gained ItemScaling: its accepted hash is reproduced only by today\'s row with ' +
           'flags 0. The authored swing ratios did not move to compensate (GreatSword went 0.95 -> 0.7 ' +
           'and the Halos swings changed; the other 57 base-attack rows hash as they did), so a ' +
           'dual-aptitude swing prices about 0.53x what it did and a single-aptitude one about 0.76x. ' +
           'WHAT SETTLES IT: the expanded tooltip of a dual-aptitude weapon\'s first swing, WITH THE ' +
           'WEAPON\'S OWN LEVEL READ OFF THE SAME TOOLTIP. The flat follows the weapon\'s level and not ' +
           'the character\'s, so a weapon still being trained reads a smaller flat under either rule ' +
           'and the flats below only line up on a weapon at the level named. ' +
           (wpWorked
             ? `On a naked level-${wpWorked.level} Warrior with ${wpWorked.name} trained to weapon level ` +
               `${wpWorked.level}, the first swing reads (${wpWorked.mean} + ` +
               wpWorked.atbs.map((a) => `${wpWorked.kept}% ${a}`).join(' + ') + ') under this rule and (' +
               `${wpWorked.sum} + ` + wpWorked.atbs.map(() => `${wpWorked.whole}%`).join(' + ') +
               `) under the accepted one; ${wpWorked.mean} with ${wpWorked.whole}% terms would mean only ` +
               `the new op is live, ${wpWorked.sum} with ${wpWorked.kept}% only the flag` +
               (wpWorked.twin != null
                 ? ` - and ${wpWorked.mean} with ${wpWorked.whole}% is also exactly what the ACCEPTED rule ` +
                   `shows on a ${wpWorked.name} at weapon level ${wpWorked.twin}, which is why the level ` +
                   'has to be read. '
                 : '. ')
             : 'Under this rule the flat is R x itemRatio x the mean of the aptitude budgets at that level ' +
               'and each attribute term is R x the keep / the aptitude count; under the accepted one the ' +
               'flat is R x itemRatio x their SUM and each term R / the count. ') +
           'A tooltip is the CLIENT running the very function this was ' +
           'read from, so it checks the reading and not the server: on this client the tooltip ' +
           '(HText.skillEffectValText@21951) is the only caller the scaler has left, the damage-side ' +
           'caller of getStepEffectVal@21774 being server code that is no longer shipped. The hit that ' +
           'checks the server: one basic swing and one class skill of the same affinity on the same ' +
           'Dummy - the ratio of the two cancels the Dummy\'s armour (it authors 40% now, so no single ' +
           'swing reads either rule\'s number) and differs 1.89x between the rules on a dual-aptitude ' +
           'one-hander. ' +
           'MEASURED 2026-10-13 (probe v10, build 25782799), sixty seconds of the chain alone on each of four ' +
           'weapons, ordinary hits only, each in the buff state the block was in and the log\'s ceiling ' +
           'allowed for: Judgement (one aptitude) priced 112.3 against a mean of 112.1 over 64 swings in ' +
           'one fixed state, range 102-124 = ceil(0.9 x) .. ceil(1.1 x); Beefury (Fighter + Cleric) 14.6 ' +
           'against 15.0-15.1 over 82; Silhouette of Almaz (one aptitude), whose block was in TWO states, ' +
           '26.5 against a mean of 27.1 over the 14 swings without the +10 MagicMastery its finisher\'s ' +
           'rank-3 clause gives for 10s, and 28.9 against 29.0 over the 28 with it (the ceiling allowed ' +
           'for: -0.5% and +1.4%). Over the whole block its mean of 28.4 reads 3.2% under the 28.8 the ' +
           'model prices there, half a point up for the ceiling, and that is the block and not the rule: ' +
           'the buff stood 66% of those sixty seconds - 7 applications in 76 finisher rows - where the ' +
           'model prices 93% from the roll the row gives at rank 3 (0.2 a finisher row), a rate the whole ' +
           'capture bears out at 52 in 276; ' +
           'Nibsham\'s Liberators (Assassin + Wizard) 14.4 against 15.0 over 69 from the front and 18.1 ' +
           'against 18.4-19.1 over 100 from behind, the two daggers\' upgrade perks apart. Beefury also ' +
           'moved by exactly the half share this rule gives one of two aptitudes: +10 Faith from its ' +
           'trinket status raised the swing by 0.43 where 0.6 x 10 / 2 x the ratio prices 0.40. The accepted ' +
           'rule prices these swings 1.3x to 1.9x higher. What the earlier ledgers showed as +5..12% on ' +
           'base attacks was the window, not the rule: a model fight pressing cooldowns the block never ' +
           'pressed, crits averaged at another rate, and whole numbers compared with floats.' },
    { severity: 'verified', what: 'a weapon skill\'s attribute scaling is 60% attribute + 40% of that attribute\'s own budget curve - from either hand',
      why: 'Read from getStepEffectItemScaling@21779 and getStepEffectScaling@21777: itemRatio = ' +
           'WeaponPowerRatio.MainhandWeaponSkill (0.4) for every weapon, the attribute keeps ' +
           '1 - 0.4, and the flat is that attribute\'s own budget at the item\'s level. The gate is ' +
           'BaseSkill.isWeaponBased@6164 - a set of skill TYPES with no slot check - so the ARSENAL\'s weapon ' +
           'skills mix identically and class skills (type 9) stay pure attribute. Ten measured ' +
           'integers reproduce (Rampage 233/371/556, Brutal Frenzy 133 + its old 28 rider, Tear 75 through ' +
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
      why: 'generateItemAffixes@21736 (HItem.hx:349-499) read end to end and now implemented. Three ' +
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
      why: 'Read from getStackFactor@21771, which runs as the LAST line of getStepEffectVal@21774 - ' +
           'after the scaling, after the spread division, after the damage variance - and multiplies ' +
           'the value by Status.stacks whenever the running skill is a Status that is EITHER a DoT ' +
           '(its statusType, or an ancestor of it through the parent chain, carries the DoT flag) OR ' +
           'carries the ScaleWithStacks effect flag. It is an OR evaluated once, so a status that is ' +
           'both - Daggers_Demondash_Passive_Status is typed Burn AND flagged - is multiplied exactly ' +
           'once. The count is READ AT EVERY TICK, so the per-tick value snapshots and the multiplier ' +
           'does not. The cap comes off getMaxStacks@15831: props.status.maxStacks, DEFAULT 1 rather ' +
           'than unlimited, replaced by any props.rankOverride at or below the applying skill\'s rank. ' +
           'The game also asks the status\'s own script for the cap (getStatusMaxStacks) and the ' +
           'reader still follows that path, but no row declares the hook on build 25782799 - the ' +
           'accepted build\'s Lethal Poison did (b + the points in Improved Mixture), and it is a ' +
           'one-stack status now. Applications add exactly one stack - ' +
           `props.status.stacks is authored on ${census.statusStepsWithStacks ? `${census.statusStepsWithStacks} of` : 'none of'} the ` +
           `${census.statusSteps} Status steps - and nothing decrements a ` +
           'stack on a timer: the whole status expires at once. Measured on the accepted build, where ' +
           'five stacks of that Lethal Poison were being priced as one (the Rogue\'s 324 -> 385); the ' +
           'stacking dot a Rogue runs today is Gash.' },
    { severity: 'verified', what: 'Lethal Poison is applied by a COUNT of doses and re-applying it deals a direct hit',
      why: 'Build 25782799 rebuilt it. The talent\'s onInflictHitNewTarget lays one hidden, one-stack ' +
           'dose per skill category the first time a cast of that category hits a target - weapon ' +
           'skill, class skill, Final Combo Attack (the base chain\'s last link, skill type ' +
           'AttackCombo - not the signature) and signature - and when vars.var1 of them are held they ' +
           'are consumed for one application of the status (Rogue_Talent_LethalPoison.onInflictHitNewTarget@45254, checkDoses@45258; the ' +
           'hook is raised by BaseSkill.onHit@6233 ops 18-78, before onInflictHit). The status is one ' +
           'stack, 20s, and its loop is flagged SpreadEffects, so the authored 4 x Dexterity is the ' +
           'total over ten ticks. Applying it to a target that already wears it plays its "Blast" ' +
           'step, 1.5 x Dexterity Physical, as a hit of the status itself: no crit chance of its own ' +
           '(a DoT-typed status starts at zero), the applier\'s bracket. What the client could not say ' +
           '(GameObject.addStatus@4636 and Status.refresh@15820 are server-only stubs) the dummy did. ' +
           'MEASURED 2026-10-13 (Rogue, probe v10, build 25782799), with the root talent held: ' +
           '(1) WHICH CASTS LAY A DOSE - only one that lands a hit of its own. 27 presses of Death Mark ' +
           'and 25 of Urge to Kill laid none; Shadowstep 18 of 18 and Knives Tempest 83 of 85 the ' +
           'class-skill dose; Infernal Plunge 223 of 269 the weapon-skill dose and Gaping Wound, ' +
           'pressed 0.7 s after it in every cycle, 23 of 103 (the category was already dosed); 279 of ' +
           '680 final combos the Final-Combo dose and never another; 3,661 basic hits none. Sixty ' +
           'seconds of the chain alone lay one dose and the poison never appears. Smoke Bomb was never ' +
           'pressed. (2) THE FIRST APPLICATION DOES NOT BLAST: the status went on 24 times (a status_on ' +
           'row of hers; the dose counter emptied 272 times, those 24 and 248 re-applications) and not ' +
           'once with a Physical row in that millisecond or within five of it; all 248 Physical rows ' +
           'fall on a target that already wore it, 246 of them within 2 ms of a dose row (97 in the ' +
           'same millisecond). (3) A RE-APPLICATION restarts the ' +
           '20 s and keeps the tick cadence: ticks 2.0 s apart straight across the Blast, the status ' +
           'ending 20.0 s after it. (4) THE AMOUNTS, at Dexterity 175 and 9.5% Fervor against the ' +
           'level-1 Dummy: a tick 69 (68.95 priced; 71 under Chaos Scorch\'s armour break, 70.01), a ' +
           'Blast 272 under that break (271.06 priced). In a rotation one Blast about every six seconds and the ' +
           'poison never drops. What a verify ledger shows for them: the tick and the Blast are one ' +
           'skill id in the log and are compared apart, by affinity.' },
    { severity: 'verified', what: 'what rides Lethal Poison\'s hits is read per talent and summed in one bracket - measured talent by talent; Opportunity Strike does nothing',
      why: 'Every rider is a `+=` hook on the hit, so they add. MEASURED 2026-10-13 (Rogue, dummy; one ' +
           'talent point at a time, three 27.6 s rotations a step): POWERFUL TOXINS x1.10 / x1.20 on ' +
           'the tick (69 -> 76 -> 83) AND the Blast (272 -> 301 -> 327), and on the trinket\'s Raw ' +
           'curse (37 -> 44) - nothing that is not a Poison-typed status hit moved. DEADLY POISON: ' +
           'Blasts critical 5 of 96 without it (Gaping Wound\'s grant alone), 73 of 140 at rank 2 ' +
           '(priced 57%: 0.5 plus the grant\'s share). VENOM INFUSION: one stack a Blast, 45 s, 2.5% a ' +
           'stack in the same bracket (tick 85 at none, 104-107 at twelve: (1.2 + 0.30) / 1.2); a step ' +
           'of the capture starts from none and reaches 11-17, which is why a ledger of one step ' +
           'wants --fight at the step\'s own length. INTENT TO KILL: +2% / +4% per Poison-typed status ' +
           'on the target on every periodic hit - the status itself counted, doses and Venom Infusion ' +
           'not (Gash at five stacks 115 with one poison up and 125 with two; the curse 45 / 46 and ' +
           '47 / 48). ENVENOM: 1,412 rows for 2,910 basic hits (48.5%, the row says 50%), 61 a hit ' +
           '(60.33 priced), 1,411 of the rows beside a basic attack and none beside a finisher alone. NOXIOUS STRATAGEM: Gaping Wound\'s taps 16.9 s after ' +
           'its last press - 1.1 s short of the cooldown - fired 0 of 19 without the talent and 18 of ' +
           '24 at rank 2, where 30% of the 9-13 Lethal Poison damage instances in between (ticks and ' +
           'Blasts) giving 0.5 s each predicts two in three. What the client left open: ' +
           '(a) IMPROVED MIXTURE banks one stack per NEW dose and the next Final Combo Attack ' +
           'spends them inside its additive bracket. Its script listens on onInflictStatus, raised ' +
           'only when a Status starts (GameObject.onApplyStatus@4602 ops 15-19, from ' +
           'Status.start@15819 op 3), so a cast of a category that is ALREADY dosed banks nothing. ' +
           'MEASURED: 262 stacks gained, each in the millisecond of a dose row, against 262 dose rows ' +
           'in all (a dose laid on a second target banks too); a combo against a target that already ' +
           'holds the Final-Combo dose leaves the bank empty; all 138 spends fall in the millisecond ' +
           'of a final combo, holding one to five stacks, none beside a Finisher; and the finisher ' +
           'spends before its own dose banks the next one. Its hit: 73 bare, 96 at one stack of rank 2, 140 at ' +
           'three, 162 at four, and under Death Mark 106 / 128 / 150 - the bank and the mark in one ' +
           'sum. The Finisher is not touched (the glossary line under the node says "next Signature ' +
           'Skill"; the rows follow the talent\'s text). ' +
           '(b) VENOMOUS ASSASSIN gives the Finisher 1s back per final combo, and 2s when the ' +
           'Final-Combo dose is NOT on the target after the hit\'s dose pass - the combo that completes ' +
           'the set, or a build with no root talent at all. The tooltip says "2s if it applies a new ' +
           'Lethal Dose", which is a different rule. MEASURED on the Finisher\'s own taps (the key ' +
           'trace gives each to the millisecond): 224 taps judged, this rule wrong on none; the ' +
           'tooltip\'s wrong on 21 (nine taps 5.5 s after a Finisher with one new dose laid in between ' +
           'did not fire - 2 s back, not 3; twelve with no root talent fired - 4 s back, not 2); ' +
           '"always 1 s" wrong on 13, "always 2 s" on 26. ' +
           '(c) OPPORTUNITY STRIKE is not scored, and the capture says there is nothing to score: 187 ' +
           'Envenom rows with the talent held, not one followed by a second row of the swing that ' +
           'carried it (30% would be 56), Envenom\'s rate 49.1% against 48.4% before, no new id or ' +
           'status. Its guard needs Lethal Poison to have been applied FROM a basic attack, and ' +
           'Envenom\'s `refresh(null)` hands the hook no skill. ' +
           '(d) ACIDIC SPLATTER rolls vars.chance x the Combo Points held when the Finisher is USED: since ' +
           'build 25959898 its script reads them in onUseSkill, before the Finisher\'s ConsumeCP step, and ' +
           'rolls on the Finisher\'s first hit or on its projectile\'s first (`hit.projectile != null && ' +
           'hit.hitCount == 0`), then zeroes them - the patch notes\' fix for the ranged Finisher, whose ' +
           'shuriken lands after the spend and which, they say, the talent did not work with. On build ' +
           '25782799 it read the points at the first hit; a melee Finisher hits 0.02 s before its ' +
           'ConsumeCP step, so those were the points that press found too, and the roll is played at ' +
           'them. MEASURED there (melee) over ten rotations, on the dummy being fought, by the points ' +
           'each Finisher\'s own hit shows: 2 applications in 7 Finishers at one point, 2 in 5 at two, ' +
           '9 in 15 at three, 20 in 23 at four, 64 in 64 at five - 97 of 114, where 0.2 x n expects ' +
           '94.8. Its tick is 105 with Powerful Toxins at two points (104.48 priced), every 2.0 s, and ' +
           'it lands on every enemy in its area - the two far dummies took it too, 494 ticks beside the ' +
           '247 on the one fought, which a ledger held to that one leaves out. NOT MEASURED: the read at ' +
           'the use, and the ranged Finisher at all - it is priced on the points found, like the melee ' +
           'one: 20 Finishers at 5 points from range with a ranged main hand should apply it 20 times.' },
    { severity: 'verified', what: 'a crit chance a status on the target hands other statuses\' hits reaches every one of them, Raw included; a pool\'s ticks are still not credited',
      why: 'Gaping Wound\'s status (build 25782799) runs onReceiveDamageEval on its wearer: every hit ' +
           'from a Bleed-, Poison- or Burn-typed status takes the APPLIER\'s CritChance for as long as ' +
           'it is on the target. The fight reads whether it is up at each tick and each Blast, at the ' +
           'resting sheet\'s crit chance. A RAW tick takes it like any other: computeDamage@4920 ops ' +
           '33-46 multiply a critical hit before the Raw test at ops 69-73. MEASURED 2026-10-13 ' +
           '(Rogue, CritChance 17.2%, CritDamage 151.96%): Gaping Wound\'s own Raw bleed 165 and 250 ' +
           'critical (51 of 389 ticks in the rotations); the trinket\'s Raw curse 37 and 56 (32 of ' +
           '517); Gash 20 and 30 (65 of 968); Lethal Poison\'s tick 69 and 105 (72 of 1,278); its Blast ' +
           '272 and 416 with no Deadly Poison; and not one critical tick of the 92 in the two ' +
           'sixty-second blocks that never pressed Gaping Wound. A FLOOR remains: a POOL\'s ticks are ' +
           'settled after the fight and take no live rider - Chaos Scorch\'s burn logged 17 and 26 ' +
           'critical under the grant (53 of 661 in the rotations), and Intent to Kill would reach it ' +
           'too. The script carries no rank guard though the tooltip lists the ' +
           'effect at rank 3; it is priced at every rank, and only rank 3 was measured. The same ' +
           'fight answers a talent that asks whether the target wears a status of some type (Finish ' +
           'the Job: a Poison) per swing, off its own statuses - one point of it (+5%) cannot be told ' +
           'from none in a step (19% of 194 basic hits critical against 13-23% in the fourteen steps ' +
           'before); a Bleed guard keeps the older reading (credited whole while the build runs a ' +
           'bleed at all).' },
    { severity: 'verified', what: 'a spread loop is divided by the ticks its STEP expects: floor(duration / tick), and round only for an instantiated area',
      why: 'A loop flagged SpreadEffects, and every SelfEffect loop, declares the TOTAL it deals and the ' +
           'game divides it over the ticks: $HSkill.getStepEffectVal@21774 ops 121-138, v / max(1, ' +
           'step.getExpectedTicks()). That count is the step class\'s own. SkillStep.initTicks@5985 ops ' +
           '31-35 store floor(duration / tick); AreaStep.getExpectedTicks@6076 answers round(duration / ' +
           'tick) instead, but only for an instantiated area, which only a step of type Area can be ' +
           '($AreaStep.__constructor__@15276 ops 5-13). The bench rounded for both, which is a ' +
           `different number wherever duration / tick ends in a half - ${census.count(census.halfLoops.length, 'step')} of the sheet ` +
           'that deal something, two of them a player\'s: Gash (9 s on a 2 s tick) and Sharpen Arrow\'s status. Gash lands four ' +
           'ticks and was priced at four fifths of its 0.35 x Dexterity. MEASURED 2026-10-13 (Rogue, ' +
           'Dexterity 175, the level-1 Dummy): one stack ticked 17 with one other status of hers on ' +
           'the target and 20 with three - 16.17 and 19.11 priced over four ticks, where five reads ' +
           '13 and 16.' },
    { severity: 'verified', what: 'a status is scaled through the item that granted it, whatever its affinity; a trinket\'s status is its item\'s alone',
      why: '$HSkill.getStepEffectVal@21774 ops 64-106 hand getStepEffectScaling@21777 the source item ' +
           'when the row whose step hits BaseSkill.isWeaponBased@6164, or its source skill is (a status asks its ' +
           'instigator skill, Status.getSourceSkill@15829), or the item is a GearTrinket - and nothing ' +
           'on the way asks the effect\'s affinity. So (1) a RAW tick a weapon\'s skill laid takes the ' +
           '0.6 / 0.4 weapon mix like any other of that weapon\'s ticks. MEASURED 2026-10-13: Gaping ' +
           'Wound\'s bleed, 4 x Dexterity over four ticks, logged 165 on every plain tick and 250 on a ' +
           'critical one at Dexterity 175 - 164.32 and 249.7 priced, where the bare attribute reads ' +
           '175. (2) Under a TRINKET the item share is 1 (getStepEffectScaling@21777 ops 27-35), so an ' +
           'item-scaled attribute keeps nothing of the wearer\'s sheet (ops 92-118) and arrives as the ' +
           'item\'s own flat: the mean row of the aptitudes that carry EquipCondition - every such ' +
           'aptitude, a trinket\'s own being a stat line that carries none - through the level curve ' +
           'at the INSTANCE\'s level (getStepEffectItemScaling@21779, fn@21783, ' +
           'getExpectedAttributeAtAptitudesLevel@21643). MEASURED: the Finger of Sukuna\'Maatata\'s ' +
           'curse, 0.2 x each of the four main attributes over three ticks, logged 37 on every plain ' +
           'tick of the no-talent capture and 56 on a critical one: 0.2 x (123.58 + 148.30 + 123.58 + ' +
           '148.30) / 3 = 36.25, and x 1.5196. HISTORY: on the accepted 2026-08-11 build both were ' +
           'measured differently - the bleed at the bare attribute, the curse at a constant 45.00 a ' +
           'tick, undivided, which fitted the wearer\'s standing weaponless primaries - and the bench ' +
           'carried those two rules until this build\'s rows refused them (175 and 45.0 priced). Only ' +
           'the curse is a trinket status this model prices; the rule is the read\'s and would price ' +
           'any other the same way, unmeasured. The UI\'s tooltip for a trinket\'s status still prints ' +
           'the wearer\'s attributes.' },
    { severity: 'verified', what: 'what a status on the target adds to the hits it receives sums with the attacker\'s own riders',
      why: 'Death Mark\'s status has no affix: its script is `dmg.dmgMult += vars.var1` in ' +
           'onReceiveDamageEval, for hits from whoever applied it. That is one more addition to the ' +
           'scalar every rider of the attacker\'s adds to (computeDamage@4920 op 11 seeds modMult from ' +
           'it, before the Raw test at ops 69-73), so it SUMS with them and reaches a Raw hit. The ' +
           'bench multiplied the finished hit by it, the same number only on a hit with no other ' +
           'rider. MEASURED 2026-10-13 (Rogue, 0.15): a five-point Finisher (+1.5 for its points) 456 ' +
           'without the mark and 484 with it - x1.061, 2.65 / 2.5, where a factor reads 524; an armed ' +
           'Infernal Plunge (+0.25) 205 and 229-234 (1.40 / 1.25); the bank of Improved Mixture on a ' +
           'final combo 96 / 140 and 106 / 150; the trinket\'s Raw curse under Powerful Toxins 44 and ' +
           '49 (1.35 / 1.2). Alone on a hit it is the plain x1.15: Gaping Wound 172 -> 197, the curse ' +
           '37 -> 42. Every status read this way (`scriptTaken`) is priced so; Sentence is another.' },
    { severity: 'assumption', what: 'Nibsham\'s Liberators: the Chaos Mark, Chaotic Flames and the armour break are in the fight as read and measured; the fight still presses Infernal Plunge too eagerly',
      why: 'Three readings of this weapon\'s kit were wrong and are measured now (2026-10-13, Rogue). ' +
           '(1) THE CHAOS MARK is laid by the chain\'s own finisher - Demonic Bite\'s hit effect carries ' +
           'the status - as well as by Void Fangs; it stands six seconds, the target holds one, and ' +
           'Infernal Plunge\'s hit consumes it and resets its 12 s cooldown. The fight banked a mark on ' +
           'presses only, so a rotation that swings was reset by nothing: 14 Infernal Plunges landed ' +
           'in 91 s with Void Fangs never pressed, each after a finisher. (2) CHAOTIC FLAMES is handed ' +
           'out on the third Infernal Plunge inside five seconds (the script keeps the use times and ' +
           'counts them); it was put up by every cast, twenty dps of it. In 16,000 damage rows it ' +
           'never appeared: the counter under it reached 2 stacks 162 times and never 3. (3) CHAOS ' +
           'SCORCH\'s rank-3 armour break (-15% Armor and MagicArmor) has no duration; its script ' +
           'stops it when the burn beside it is gone, so it stands exactly as long as the burn does. ' +
           'It was named and in no number; it rides the burn now (a Lethal Poison tick 71 inside it ' +
           'and 69 outside, 70.01 and 68.95 priced). WHAT IS STILL A FLOOR: the fight presses ' +
           'Infernal Plunge the moment it is ready, so after a reset the next one lands on an ' +
           'unmarked target, unarmed by Demonic Bite, and waits out the cooldown - about half its ' +
           'casts. A player who holds the press for the next finisher never does: of the 200 plain ' +
           'Infernal Plunges of the capture\'s rotations 28 were unarmed (166-169, or 191-194 under ' +
           'Death Mark, against 205-211 and 229-234). Its line reads about 9% low per hit for that, ' +
           'and the weapon\'s rotation more.' },
    { severity: 'assumption', what: 'the Finisher is pressed whenever it is ready, at the points the pool holds then; Urge to Kill is in no number',
      why: 'The Finisher adds vars.var1 per Combo Point it finds (`consumed = getCp(); damageBonus = ' +
           'consumed * vars.var1`, then `hit.dmgMult += damageBonus`) and consumes them all; nothing in its ' +
           'row asks for a number of points. So the fight presses it like any other skill - when it is ready ' +
           '- and prices it at what the pool holds. The points are Combo Points\' own rule: a weapon skill or ' +
           'a final combo pays when it is ANOTHER skill than the last one that paid (the row\'s text: ' +
           '"different from the last action"; its script keeps one memory, written only when it pays, so a ' +
           'class skill or the Finisher between two final combos changes nothing), one more on a critical ' +
           'first hit with the mastery, against a memory of its own; and a cast that returns one (Knives ' +
           'Tempest). WHEN to press it is the rotation\'s choice and this is one: every point is consumed ' +
           'whenever it is pressed and each is worth the same, so pressing sooner loses no point and lands ' +
           'more bare hits - a rotation that holds it for a full bar is another rotation. MEASURED ' +
           '2026-10-13 (Rogue, the +10 penetration of Gash\'s passive up): 181 with no point, then 237 / 290 ' +
           '/ 344 / 398 / 452 with one to five - the bare hit x (1 + 0.3n); without the passive 179 and, at ' +
           'five, 448 (178.9 and 447.3 priced). Over sixteen rotations the capture\'s 182 Finishers held 740 ' +
           'points, 4.07 each (10 at one, 17 at two, 24 at three, 31 at four, 100 at five, none at zero). ' +
           'Replayed over the rows, the rule gives the logged count on 157-160 of 181 Finishers (725-730 ' +
           'points against 735); paying every weapon skill and every final combo, which is what stood here ' +
           'with a press held for the full bar, gives it on 100-107 (842-866) and read the Finisher +10.4% a ' +
           'hit (501.7 against 454.5). With the capture\'s own presses replayed (48 segments) the fight ' +
           'prices its Finishers at 449.4 a hit against 455.0 logged. URGE TO KILL (the Finisher\'s cooldown ' +
           'is 1 s and a point arrives every second for ten) is not a cast the fight makes: all 66 Finisher ' +
           'taps inside one of its 31 windows fired, 4.1-5.5 s apart where the cooldown alone allows none, ' +
           'the later ones at full bars. It is the largest thing missing from this Rogue\'s rate: in its own ' +
           'play of those sixteen builds the fight asks for a point 895 times, is paid 386, and its 240 ' +
           'Finishers find 508 points, 2.12 each, where the capture\'s 20 presses of Urge to Kill are up to ' +
           'ten points apiece on top of the same rule. What Acidic Splatter rolls on is short by the same ' +
           'points.' },
    { severity: 'verified', what: 'a status a Hit step of a cast lays is on the target for that cast\'s own hit',
      why: 'A Status step authored `on: Hit` runs with the hit that triggers it, ahead of that hit\'s ' +
           `damage. Knives Tempest's Shred (a rune's step, -20% Armor for ${skills.get('Rogue_KnivesTempest_Status2')?.duration ?? '?'} s on this build, 3 s when it was measured) is the one such row ` +
           'that moves its own cast\'s damage. MEASURED 2026-10-13: its hit, 1 x Dexterity, logged 182 ' +
           'on all five plain hits of the isolated presses with the Shred row written in the same ' +
           'millisecond ahead of it - 181.3 priced through the shredded armour, 178.9 through the ' +
           'bare target. A status a SCRIPT lays in onInflictDamage comes after the hit that laid it ' +
           '(Chaos Scorch\'s break: Infernal Plunge alone logged 164, 163.4 priced bare), and Tear ' +
           'Reality\'s armour break is no Hit step either (324 logged against a bare 323.0).' },
    { severity: 'assumption', what: 'an UNCAPPED stacking dot is held at one stack, and named',
      why: `maxStacks <= 0 means uncapped (${census.count(census.uncapped.length, 'row authors', 'rows author')} -1), and over a 200-second fight an ` +
           'every-swing application would reach two hundred stacks and print a number that grows with ' +
           'the fight length rather than with the build. Every uncapped dot a build of this install was ' +
           'found to hold is a POOL dot, whose fed/owed ledger already IS the stack count expressed as ' +
           'damage (checked on build 25782799 over every class, each main hand at weapon rank 3 and each ' +
           'talent alone: no dot came out held at one stack), so nothing is currently scored at the floor ' +
           '- but the guard is there and it says so by name rather than letting the multiplier run. The ' +
           'same -1 used to reach the affix scale through a bare `?? 1`, i.e. a buff worth MINUS its own ' +
           `value; ${census.uncappedWithAffixes.length ? `of those rows ${census.uncappedWithAffixes.length} carry affixes ` +
             `(${census.uncappedWithAffixes.map((s) => (s.texts?.name ? `${s.texts.name}, ${s.id}` : s.id)).join('; ')}) and ` +
             (census.uncappedAffixAppliers.length
               ? `${census.uncappedAffixAppliers.join(', ')} name one of them in a script or a step - read those before trusting the scale`
               : 'no skill row names any of them in a script or a step, so no hero\'s row applies one')
             : 'none of those rows carries an affix'}, ` +
           'so nothing was visibly wrong, which is the kind of bug that waits for a patch.' },
    { severity: 'verified', what: 'a weapon-upgrade script proc can be read - the double-attack one is',
      why: `${census.upgradesScripted} of the ${census.upgrades} \`<Type>_Upgrade\` rows carry a script instead of affixes and were refused ` +
           'wholesale. One shape among them is entirely in the data: GreatSword_Upgrade is vars.chance ' +
           '0.04 and `onSkillProc(ctx) { if (ctx.skill?.isBasicAttack() && checkProba(vars.chance)) ' +
           'ctx.skill.playStep(null, ctx.skill.getExecStep().index, ...); }` - replaying the executing ' +
           'step IS the hit again, so the whole payload is x(1 + chance) on basic attacks - as that ' +
           'many more HITS, each with its own row, crit roll and riders, not as a bigger first one ' +
           '(measured 2026-10-13: a Legendary sword\'s swings log the same 15 per hit a model without ' +
           'the perk prices, where +7% in the hit itself would read 16). ' +
           '`isBasicAttack` is skill types Attack..Attack4 (BaseSkill.isBasicAttack@6152), which EXCLUDES ' +
           'the combo finisher, so the rider must not reach the swing that ends the chain - `isFiller` ' +
           'would have, since it covers the finisher too. None of these rows carries a cooldown and none ' +
           'uses the game\'s internal-cooldown idiom, so the rate is plain Bernoulli with nothing to ' +
           'saturate. The upgrade RANK is the ROLLED RARITY INDEX, not the star count - stars only ' +
           'decide whether the skill attaches at all, at GearUpgrades.SkillUnlockLevel (3). This line ' +
           'used to say the opposite and was stale: the code has read rarity since the bytecode ' +
           'settled it (Weapon.getWeaponUpgradeSkill@9837 sets rank from the instance rarity that ' +
           'Weapon.updateInf@9829 has already overwritten with the roll). Every earlier measurement was ' +
           'degenerate between the two rules - a 3-star Rare and a 4-star Epic read the same rank ' +
           'either way, which is how the wrong reading survived a tooltip that agreed with it. The ' +
           'discriminators are Emsey\'s 3-star EPIC daggers reading rank 3 where stars-1 says 2, and ' +
           'a Censer whose CooldownReduction is FLAT across 3/4/5 stars and steps once per rarity: ' +
           'Rare 3, Epic 4, Legendary 5. One consequence worth knowing: the rank-1 and rank-5 rows of ' +
           'every `<Type>_Upgrade` are unreachable, because the 3-star unlock floors the rank at the ' +
           'Rare index and no rarity indexes past Legendary.' },
    { severity: 'verified', what: 'what you socket raises the host item\'s gear level',
      why: 'Read from Gear.getILevel@9760 (src/st/item/Gear.hx:48-51), which is three lines: the base ' +
           'iLevel plus the rarity bonus (and the flawless bonus, in Item.getILevel@8739), then ' +
           'round(upgradeLevel x Item_GearUpgradeILevelBonus) for the stars, then - the line nothing ' +
           'read - `for (s in this.slots) lvl += Data.item.byId.get(s)?.iLevel ?? 0`. Every socketed ' +
           `item adds its OWN iLevel to the host. ${census.count(census.levelledAugments.length, 'item')} in the game ` +
           `${census.levelledAugments.length === 1 ? 'does' : 'do'} it, of type ${[...new Set(census.levelledAugments.map((i) => i.type))].join(', ') || '-'} ` +
           `and rarity ${[...new Set(census.levelledAugments.map((i) => i.rarity))].join(', ') || '-'}` +
           `: the EPIC Corrupted Gifts declare iLevel ${[...new Set(census.levelledAugments.map((i) => i.iLevel))].join(' / ') || '-'}, so socketing one is worth a ` +
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
           '(Mage_Spark_SpellCDCost_FinalCombo) is spent but still does not GATE the chain. ' +
           'MEASURED AGAIN 2026-10-13 on build 25782799 (a Mage with three Power conduits): held ' +
           'finishers took Spark 35.8 -> 27.75 -> 19.7 -> 11.65 -> 3.6, the flat 10 less three regen ' +
           'ticks of 0.65, and not one conduit fired on the way - every spend started under 50; with ' +
           'Spark above it each weapon skill and each finisher added three stacks of Conduit: Power in ' +
           'one millisecond (36 times), and Spark Beam, Static Nova, Spark Shield, Mystic Empowerment ' +
           'and Blink added none - they spend no Spark. That build showed two things the model had ' +
           'wrong and now has: a conduit slotted n times adds n stacks a trigger, and the stacks of a ' +
           'buffing conduit follow the trigger EVENTS, which the fight now counts itself - the cadence ' +
           'used to be read off a damage conduit\'s line, so slots holding only Conduit: Power ramped ' +
           'nothing. STILL AVERAGED: the buff is priced at its mean stack count over the fight, so a ' +
           'window that opens with no stack reads a few percent high on every MagicMastery-scaled line ' +
           '(the first seventy seconds of that Mage\'s rotation: +3 to +8% on ordinary hits). And ' +
           'SPARK IS SPENT, NEVER REQUIRED: getSparkCost@9623 is called by the spend hook ' +
           '(Mage_SparkMaster.onPreSkillProc@45397 op 81) and by the tooltip, and by no enable check; ' +
           'on that capture Summon: Vile Imps pressed at 17.4 of its 19 summoned its imps and Swarmstrike ' +
           'Accord at 5.85 and 1.95 of its 29 put its status up, the pool reading 0 plus regen at the ' +
           'next row. The fight had been holding such a press back until the pool could pay.' },
    { severity: 'verified', what: 'a looping area lands a hit at spawn only when it is instantiated, and an aura that follows its wearer for the row\'s life is not',
      why: 'READ: $AreaStep.__constructor__@15276 - isInstantiated = type Area && (telegraph || travelTime > 0 || ' +
           'follow == Target || multi || (a loop with a duration && !(follow == Self && (blocking || duration < ' +
           '0)))). The spawn hit is the instantiated area\'s (SkillArea.startHit__impl@5263 ops 58-59) and so is ' +
           'the rounded tick count (AreaStep.getExpectedTicks@6076); a loop that is not instantiated is the ' +
           'step\'s own and lands floor(duration / tick) events, none at the start. The bench gave the spawn hit ' +
           'to every step carrying area props. For a status priced as a dot that put (N + 1) ticks into a ' +
           'whole the fight divides by N. MEASURED 2026-10-13 (Priest, Strength 57, Dexterity 40, Faith 141, ' +
           'Fervor 9.16, MagicMastery 4, Radiance 2; block D-skills-cycle1): Hive Swarm logged its first row ' +
           '0.95s after the press and ten rows in ten seconds, 44 each (45 while Hive\'s Sunder stood on the ' +
           'dummy); Swirling Embers eight rows, 95 each and 145 on a critical one. Priced 43.9 and 95.0 by ' +
           'the row\'s ratio in the weapon mix, the bracket, the dummy\'s reduction and Radiance\'s +25%; with ' +
           'the spawn hit that block read 48.6 and 106.8 (+10.4% and +12.4% on the first ledgers). The spawn ' +
           'hit itself stands where the area is instantiated: Radiant Verdict\'s floor logged a row 0.34s ' +
           'after the press and three more, and Wild Whirlwind 13 or 14 events for a loop of 12 on the ' +
           'accepted build. Three rows a build can hold lose the spawn hit by it: Hive Swarm (11 events ' +
           'to 10), Swirling Embers (9 to 8) and the Infusion aura Pestilential Aura (7 to 6). Cinder Coat ' +
           'does not move: its area row already says skipFirstTick, so it never had that hit. Pyrh Blessed ' +
           'loses it too (41 to 40) and is in no build: it is the status an affixed gathering node puts on ' +
           'whoever gathers it (OreAffix_Fire, onOwnerGathered). One row GAINS a hit: Brood Leap\'s floor ' +
           '(Pocket Hive), 6 events to 7 - an Area step with a loop and a duration and no area props, ' +
           'which the constructor instantiates and the old "carries area props" test passed over. That ' +
           'one is unmeasured; it is the shape of Radiant Verdict\'s floor, which is.' },
    { severity: 'verified', what: 'a slotted rune restates the row\'s vars, and a step that reads one reads the rune\'s',
      why: 'READ: $HSkill.updateSkillInf@21787 ops 62-106 walk the slotted masteries and apply each one\'s props ' +
           '(op 102) and vars (op 105) on top of the rank overrides, before a step\'s duration, range or tick ' +
           'is resolved (ops 353 on). The bench merged the props and not the vars. Six runes restate a key ' +
           'their row holds; one is read by a step: Consecration says dur2 = 6 over Radiant Verdict\'s 8, and ' +
           'the floor it enables lasts dur2. MEASURED 2026-10-13 (Priest, seven casts): four rows of the floor ' +
           'a cast, at +0.34s, +2.3s, +4.3s and +6.3s, 41 each at Faith 141 - 0.8 x Faith over round(6 / 2) = ' +
           '3 expected ticks, paid at the spawn and at each tick (40.4 priced); read at 8s it had been five ' +
           'rows of 31. The direct hit beside them logged 182 and 277 on a critical one (181.96 and 276.0 ' +
           'priced).' },
    { severity: 'verified', what: 'a status step a swing plays is "an attack" only where the step carries the BaseAttack flag',
      why: 'READ: ScriptHitData.get_isBaseAttack@6292 asks the hit\'s step, and SkillStep.isBaseAttack@6027 ' +
           'answers with the step\'s own flag (ops 0-9) or its base skill\'s type (ops 10-13); the base skill of ' +
           'a status\'s step is the status, which has no type. So a rider written "hit.isBaseAttack || ' +
           'hit.isFinalCombo" (Zealous Fighter\'s crit chance, and Might of the Executioner\'s crit damage ' +
           'behind the same test) does not reach Purging ' +
           'Strikes\' or Sunlight\'s hit, and does reach Abyssal Fury\'s blast, whose step is flagged. The ' +
           'bench keyed every swing-played status step on its swing\'s category - the accepted 2026-08-11 ' +
           'build\'s capture read "swings 15.5%, their ticks about 16%". MEASURED 2026-10-13 on build 25782799 ' +
           '(Priest, sheet 7.5% CritChance, Zealous Fighter 2 for +8, Crusader\'s +10 up about a fifth of the ' +
           'rotation): the sword\'s base attacks crit 83 times in 544 (15.3%), Purging Strikes\' hits 30 in ' +
           '302 (9.9%), Sunlight\'s 9 in 65. Priced 17.6%, 9.9% and 10.4%; with the swing\'s key the two ' +
           'statuses had been 17.9% and 18.4%.' },
    { severity: 'verified', what: 'a passive\'s own cooldown opens the fight ready and takes Cooldown Reduction',
      why: 'Inner Demon hands the next weapon skill its cooldown back on its own cooldown (30s, 20 from rank 2). ' +
           'The fight used to wait a full cooldown before the first one and ran the clock unreduced. MEASURED ' +
           '2026-10-13 (Mage, Cooldown Reduction 4): its ready marker was up at the first weapon skill of every ' +
           'block and came back 19.26-19.74s after each of twelve spends, on a marker polled every half ' +
           'second - 19.2s, where an unreduced 20 could not show under 20.0. Queen\'s Decree\'s marker reads ' +
           'the same way (19.0-19.5s; 13.0-13.5s under Mystic Empowerment\'s +30).' },
    { severity: 'verified', what: 'Chaos Bolts rolls its reset once per bolt',
      why: 'The finisher\'s onDamage rolls vars.chance (0.15, 0.2 from rank 2) to reset Summon: Vile Imps and, at ' +
           'rank 3, put up its MagicMastery status; onDamage is raised per damage instance and the finisher ' +
           'is four bolts. MEASURED 2026-10-13 (Mage, rank 3): 67 finishers, 268 bolts, 47 applications of the ' +
           'status - 17.5% a bolt - and 35 finishers with at least one (52%), where one roll a finisher would ' +
           'give 20% and four give 59%.' },
    { severity: 'assumption', what: 'the fight presses between swings: a skill that interrupts is never pressed inside one',
      why: 'READ: st.skill.Skill.canInterruptOnUse@9638 - a skill used while another runs interrupts it only ' +
           'when its own row authors props.interruptStyle (All, AllButSelf or WeaponAttacks; ops 27-41), or ' +
           'the running one is mid-cast and may be cancelled (ops 14-20); any other use waits for the ' +
           `running skill to end. ${interrupterRows.length} rows of this build author it (${interrupters.join(', ')}). ` +
           'For every other skill, pressing between swings is the game\'s own rule. For those it is a ' +
           'choice the fight makes for the player: such a press ' +
           'inside a swing starts at once and the swing stops there - before its hit step it deals nothing ' +
           'and the chain stays on that link, after it the hit stands and the rest of the swing is saved. ' +
           'The fight never voids a swing and never saves a tail. It is not a ceiling: a press timed just ' +
           'after each hit beats it. MEASURED 2026-10-13 (Rogue, a fixed 670 ms key cycle, 48 rotation ' +
           'segments, 1,402 s): of 3,145 chain links started, 480 were closed by Infernal Plunge, Gaping ' +
           'Wound or the Finisher - 338 before their hit (10.7% of the links started and 19% of the final ' +
           'combos; 47.3 s spent in them, 3.4% of the time) and 142 after it (8.8 s of tail saved, 0.6%); ' +
           '"closed before the link\'s authored hit step means no damage row" holds on 461 of the 480. Death ' +
           'Mark, Knives Tempest and Urge to Kill, which author no interruptStyle, closed none in 107 uses: ' +
           '89 began 6-17 ms after a link\'s end, the rest after another cast. What rides the final combo ' +
           'pays most for that play: the combo, Venomous Assassin\'s seconds, Improved Mixture\'s bank, the ' +
           'dose it lays. `verify --replay` plays the rule on the recorded presses, from where the recorded ' +
           'sitting opens (its first skill state): over those 48 segments it cuts 413 swings, 242 before ' +
           'their hit, and lands 484 final combos where the capture landed 411 and the same replay without ' +
           'the rule 545. What is left of that difference is the clock (the Free state before every link, in ' +
           'the entry on the chain\'s round) and the 46 recorded presses the fight refuses as not ready: 35 ' +
           'Finishers, 22 of them inside an Urge to Kill window, and 11 Gaping Wounds. NOT PLAYED, in the ' +
           'fight or in a replay: a press of an interrupting skill inside another CAST, which stops that ' +
           'cast the same way.' },
    { severity: 'verified', what: 'a damaging status rolled in a damage hook with no predicate is rolled on every damage instance you land',
      why: 'The Finger of Sukuna\'Maatata reads `function onInflictDamage(dmg) { if (checkProba(vars.chance) && ' +
           '!hasStatus(dmg.target, <its curse>)) addStatus(...) }`, vars.chance 0.03: no test of what dealt the ' +
           'damage, and no roll while the curse stands. The fight had no such event and put the roll on swings ' +
           'and finishers, as a floor. It now counts the damage instances it lands - each row of a press, of a ' +
           'swing and of what they play, each tick of a status and each direct hit a status deals - and rolls ' +
           'on each, not at all while the curse stands: a cycle of its six seconds plus 1 / (0.03 x the ' +
           'instances a second). MEASURED 2026-10-13 (Rogue, sixteen rotations, the pressed dummy): 131 ' +
           'applications in the 3,844 damage rows landed while the curse was absent, 3.41% a row (on swings and ' +
           'finishers alone it would have to be 7.9%), several in a millisecond that holds only a status tick ' +
           'or a proc row; 370 ticks in 1,458 s, 25.4 per 100 s, where the floor gave 16.6. NOT COUNTED: a ' +
           'summon\'s swings (another hook, onProxyDamage), a detonation, and what the fight prices after the ' +
           'bell (a stack proc, a use rider\'s step). Only a ROLL is read this way, and only for a status that ' +
           'deals damage: one row of the sheet today. A buff or a debuff the reader files the same way (the ' +
           'four Stones\' buffs, priced in closed form on an estimate of that rate; Scatterbloom\'s Ravenous ' +
           'Sprout, on the swing clock) keeps the rate it had, and an application with no roll in front of it ' +
           'is still refused.' },
    { severity: 'verified', what: 'a status rolled behind another status\'s id is applied by that status\'s hits, not by swings',
      why: 'Swarm Lord\'s rank-3 poison is `if (dmg.skillId == Skill.Sword_Swarm_Passive_Swarm) { if ' +
           '(checkProba(vars.chance) && rank >= 3) addStatus(dmg.target, ...)` - a 25% roll on each hit of ' +
           'Hive Swarm. The reader took the roll and not the test in front of it, and put the poison on ' +
           '"every damage instance, floored to the swing and finisher clock". MEASURED 2026-10-13 (Priest): ' +
           'sixty seconds of the sword\'s chain with no weapon skill pressed logged 132 hits and not one ' +
           'poison row; a block of lone presses with no swing logged 29 hits of Hive Swarm and 10 of the ' +
           'poison (24 each, 23.5 priced); over the session 107 poison ticks for 249 of the swarm, where ' +
           'the fight now gives 94 for 184. Only a roll is read this way: an unconditional application ' +
           'behind such a test (Melting Faith on Sunlight\'s hit) keeps the reader it had.' },
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
           'not yet on the AFFIX side, where the game multiplies each affix by getAffixMultiplier() - ' +
           'the status\'s stacks (Status.getAffixMultiplier@15810, still in the client; the multiply was ' +
           'read in applyAffixes on the 2026-08-11 build, and BaseSkill.applyAffixes@6190 is a server-only ' +
           'stub since build 25782799). A buff is still credited at full stacks, which is right for ' +
           'a weapon enchant refreshed off a proc every few swings (Enchant_Zealot saturates) and ' +
           'wrong for one whose income the fight cannot derive. The `restat` cache is keyed on ' +
           'status#stacks, so a fractional mean has to be quantised before it can go in, or a bounded ' +
           'cache of integer states becomes an unbounded one of float states.' },
    { severity: 'verified', what: 'a step whose `on` is Code is played by the script, not by the cast',
      why: '`skill@steps.on` has a Code case and it means exactly that: the step is played by ' +
           '`playStep(Steps.<id>)` from the row\'s own script and by nothing else - `Steps.<name>` being ' +
           `the step's \`id\` column, which ${census.playOwn} of the ${census.playSites} \`playStep(Steps.<id>\` call sites in the sheet name on their ` +
           `own row. ${census.count(census.codeSteps, 'step declares', 'steps declare')} it and ${census.codeStepsWithAmount} carry an amount of their own ` +
           '(an effect with a base value or a ratio), and every one of them used to be ' +
           'folded into its skill\'s cast. Brutal Frenzy is the case that shows the size of it: the cast ' +
           'is the 1.43 x Strength Area step, the measured 133, while the Mono step `id: "Attack", on: ' +
           'Code` is played by `if (rank >= 3 && hit.isFinalCombo) if (checkProba(vars.chance)) ' +
           'playStep(Steps.Attack, hit.target)` - on build 25782799 a 0.9 x Strength step on a 25% roll ' +
           'per finisher, the tooltip\'s "has a 25% chance to deal an additional" amount (it was 0.3 x ' +
           'Strength on a 15% roll per base attack until this build, the measured "additional 28"; the ' +
           'new amount is read off the row and has not been read off the tooltip in game; and the new ' +
           'guard is one the played strike satisfies itself - it is a hit of the same finisher row - so ' +
           'whether it can re-roll its own 25% is open: about 0.25 secondary hits per finisher over 200 ' +
           'finishers is this reading, about 0.33 means it chains). So the cast ' +
           'prices 133 rather than adding the step in, and the step goes on the finisher\'s clock through ' +
           'the same trigger machinery every other proc uses. A rider whose hook the fight cannot raise ' +
           '(onGameBeat, onReceiveDamage, onAreaExited, onStop, onStacksChange) or whose guard asks live ' +
           'state is refused with the hook named. A rider on the host\'s OWN cast - onDamage, onHit, ' +
           'onStart, onAreaElapsed - is folded back into the cast at its chance, because its schedule IS ' +
           'the cast\'s and separating them would leave a delayed detonation like Staff_Censer_Skill2 ' +
           'with no parent to hang off. The one Code step that is NOT refused on its hook is a SUMMON: ' +
           'a pet swings on its own clock for as long as it lives, so what the hook has to supply is a ' +
           'rate rather than a schedule, and the entry below says how each of the two shapes gets one.' },
    { severity: 'assumption', what: 'a step played from onProc is the press, and one played per status you have out is priced at the one the build keeps - a floor',
      why: 'onProc is the pressed skill\'s own hook: Skill.tryConsumeCharge@9631 runs once per use and ' +
           'ops 122-124 call it on the skill\'s script right after onSkillProc has gone round the owner\'s ' +
           'rows. Heat Emission moved its Burst (0.7 x Faith, reach 6) there on build 25782799, inside ' +
           '`for (flamie in getInflictedStatuses(Skill.Scepter_Flamie_Flamie))` with ' +
           '`ctx.dmgMult = flamie.stacks` - one burst for every Flamie you have out, centred on whoever ' +
           'wears it. How many are out is live state, except one: Flame of Argol\'s own passive keeps a ' +
           'Flamie on its wielder for good (a Status step on Refresh with duration -1), and a Flamie ' +
           'holds one stack (no props.status.maxStacks; Status.getMaxStacks@15831 defaults to 1). So ' +
           'wherever the build OWNS that passive - the weapon in the main hand, or in the arsenal with ' +
           'the passive given one of the arsenal\'s skill slots - the fight prices exactly one burst per ' +
           'press and says it is a floor; with Heat Emission slotted from the arsenal and the passive ' +
           'left out, nothing keeps a Flamie up and it refuses the step for the count. ' +
           'NOT READ: where you stand - the burst is centred on you, so it reaches a target ' +
           'only within 6 - and whether Hot, hot, hot! puts a SECOND Flamie on a caster who already ' +
           'wears the permanent one (addStatus is a server-only stub in this client). ' +
           'WHAT SETTLES IT: solo on the Dummy, (1) Heat Emission pressed next to it and again from ' +
           'ten units away: one hit of 0.7 x Faith adjacent and none at range is this reading; ' +
           '(2) stand in your own Hot, hot, hot! and press again: two separate hits means the zone ' +
           'made a second Flamie and the floor is low by one burst for those 8 seconds; one hit means ' +
           'the floor is the solo truth.' },
    { severity: 'verified', what: 'a damage multiplier scaled by a status COUNT is a bank, and the fight now keeps one',
      why: 'Tide Rising Uppercut is the shape and it was worth NOTHING - not refused, not named, absent '
        + 'from every channel at once. DMG_FIELD is the only regex that finds a damage rider in a '
        + 'script and it demands a bare vars.X on the right of the +=; this clause reads '
        + '`hit.dmgMult += getStatusCount(owner, Skill.Fists_WaterUppercut_S3)*vars.var2`, so nothing '
        + 'matched, scriptGapsOf returned an empty list, and a weapon skill worth SIX TIMES its base '
        + `hit at the cap priced at exactly its base hit. ${census.count(census.countWrites.length, 'script')} in the sheet `
        + `${census.countWrites.length === 1 ? 'writes' : 'write'} a stack count into dmgMult `
        + `(${census.countWrites.map((s) => s.texts?.name ?? s.id).join(', ')}). The runtime, read op by op: `
        + 'onSkillProc fires once per skill USE (tryConsumeCharge@9631, latched by triggeredCD and '
        + 'cleared by Skill.reset@9627 from BaseSkill.start@6145); ctx.isSkill is '
        + '`isWeaponSkill() || isClassSkill() || isSignature()` (get_isSkill@5193), which is skill '
        + 'types 7, 8, 9 and 17-20 on build 25782799 - the fight\'s ACTIVE set plus the WeaponSubSkill '
        + 'BaseSkill.isWeaponSkill@6161 now admits (a recast\'s use is not banked here; see the sub-skill entry) '
        + '- so the four base attacks and the combo finisher bank NOTHING; onDamageEval runs strictly before onDamage '
        + '(read in receiveDamage on the 2026-08-11 build: its op 36 called computeDamage and its op 93 '
        + 'script.SkillScript.onDamage@6742; Unit.receiveDamage@4913 is a server-only stub since build 25782799 and that order '
        + 'cannot be re-read, while the Eval half still can - computeDamage@4920 op 5 -> evalDamage@6124 -> '
        + 'SkillScript.onDamageEval@6731), so the bonus is real and not self-cancelling; '
        + 'GameObject.getStatusCount@4630 returns the STACK count of one status; SkillScript.removeStatus@6890 clears the '
        + 'lot; and hit.dmgMult is ONE ADDITIVE BRACKET - computeDamage@4920 op 14 seeds a single '
        + 'modMult scalar from it and every rider only +=s that, which is why the bank is entered as '
        + 'a rider rather than multiplied onto the finished cast (at +500% beside a 4% rider the '
        + 'shortcut reads 3.3% high). Only the FIRST resolved target takes it: onDamage runs '
        + 'removeStatus per hit and AreaStep.areaHit@6077 loops its targets in-frame, so target two '
        + 'evaluates a count of zero - measured, of 93 multi-target Clawdius casts at three stacks or '
        + 'more, 82 have exactly one empowered hit, 11 have none, and not one has two.' },
    { severity: 'assumption', what: 'the stack bank is simulated, because its DURATION binds and not its cap',
      why: 'The counter refreshes on every application onto ONE shared timer (read in Status.refresh on '
        + 'the 2026-08-11 build; Status.refresh@15820 is a server-only stub since build 25782799. '
        + 'Tide Rising declares no stackingPolicy, so policy 0), so what limits it is the longest GAP '
        + 'between qualifying presses, not the cast rate. A Rogue at rank 2 has the same 0.335 presses '
        + 'a second as at rank 1 and banks three fewer stacks, because its gaps fall either side of '
        + 'the six seconds - min(cap, rate x cooldown) gets rank 3 about right and rank 2 wrong by '
        + 'three, which is the difference between a weapon worth pressing and one that is not. So the '
        + 'bank is an event in the fight like every other, filled by each active press and emptied by '
        + 'the one that spends it. THE CAPTURE IS THE REFEREE, on 206 other players\' Clawdius: the '
        + 'multiplier is exactly 1 + 0.5k, confirmed against live server output at every k from 1 to '
        + '10 (one dummy-parse reads 78.44 base -> 470 at ten stacks, x6.000 to three decimals); the '
        + 'combo finisher really does bank nothing (1,497 presses -> 9 applications, 0.6%, against '
        + '0.945-1.000 for the actives); and across 1,357 real spends (status_off reason=ForceEnd, '
        + 'which is this script\'s own removeStatus) the mean is 4.69 stacks, x3.34. This model reads '
        + '5.4 on a Rogue dummy, ABOVE live, and the gap is the fight: a dummy has no downtime, no '
        + 'target switch and no deaths, while 57.6% of real banks expire unspent. The rank-3 stun '
        + 'rider on slowed targets is separately real (a 6.8x lift on stunned-after-uppercut in the '
        + 'capture) and carries no damage, so it stays unmodelled. What no capture can settle here is '
        + 'a per-fight TOTAL: Clawdius appears in zero of the capture\'s 9,073 snap_gear rows, so '
        + 'bench verify has no ledger to fold this against.' },
    { severity: 'verified', what: 'a summon can be hosted on a status or on a proc, not only on a cast',
      why: `${census.count(census.summonSkills, 'skill carries', 'skills carry')} a type-${stepTypeNames.indexOf('Summon')} Summon step ` +
           `(${census.summonSteps} such steps), and three shapes host one. CAST-HOSTED (Start or ` +
           'CastEnd) is the Silhouette of Almaz and Tidal Totem, and the cast schedules it. STATUS-HOSTED ' +
           'is Pocket Hive: Mad Buzz rolls checkProba(0.2) on every damage event to stack Buzzing, whose ' +
           'onStacksChange summons an Angry Bee at its tenth stack and then consumes the lot - the step ' +
           'is `on: Code` and lives on the STATUS, not on the passive that applies it. SELF-HOSTED AND ' +
           'SCRIPT-PLAYED is Eternal Flower Heart, 5% per weapon-skill cast. The last two were both wrong ' +
           'before: Mad Buzz was refused whole as "the foe is passive" because its script mentions ' +
           'onReceiveDamage, though its onInflictDamage half fires on every hit you land ' +
           '(receiveDamage raised it on the INSTIGATOR at ops 97-114 of the 2026-08-11 build\'s body; ' +
           'Unit.receiveDamage@4913 is a server-only stub since build 25782799); and the trinket, being a ' +
           'payload-less Passive reclaimed into the rotation, was PRESSED, so its bee opened a window on ' +
           'a GCD instead of on a 5% roll. A pet\'s damage is the OWNER\'s: getStepEffectVal@21774 reads ' +
           'GameObject.resolveProxy@4618, and Foe.getSkillProxy@6996 returns summonOwner whenever that owner is ' +
           'a Hero, so the bolt\'s 0.8 x Faith is YOUR Faith, and SkillContext.initVars@5241 hands the pet your ' +
           'CritChance, CritDamage, Fervor, mastery and DamageModifier too. Being a Totem changes none of ' +
           'it - Unit.type has no call site in the damage chain. The receiving side resolves the same ' +
           'proxy (computeDamage@4920 ops 30-32), so a pet\'s hit also takes YOUR penetration and ' +
           'level, and counts as hero-sourced for the target\'s Resilience.' },
    { severity: 'assumption', what: 'a stack-driven summon is priced as a run of successes, not a plain count',
      why: 'The counter refreshes on every application rather than ageing per stack (Status.refresh kept ' +
           'one timer on the 2026-08-11 build - Status.refresh@15820 is a server-only stub since build ' +
           '25782799; Buzzing declares no props.status.stackingPolicy and absent is policy 0), so ' +
           'a gap longer than the row\'s own duration loses the WHOLE climb. Reaching ten stacks therefore ' +
           'needs nine consecutive procs inside ten seconds, whose expected wait is the classic ' +
           'E = (1 - q^r)/(q^r (1 - q)) with q = 1 - e^(-rho x window). At a high event rate q tends to 1 ' +
           'and E to r, so it collapses to "one bee per ten procs" exactly where that is right, and ' +
           'stretches where a thin build really does time the counter out. A counter is rarely fed by ' +
           'ONE thing, and reading only the roll halved this bee: GM_MassGrab_Combo\'s ' +
           'onFirstHit adds TWO stacks per Honey Crush with no rank gate and no roll, which is 0.28 ' +
           'stacks/s against the roll\'s 0.44, so the cap arrives every 14 seconds rather than every 26. ' +
           'Only an UNGUARDED feed on a per-cast hook is counted; one behind a roll, a rank gate or a ' +
           'status test is a rate this reader does not have, and stays out. Three clauses around it are ' +
           'READ AND REFUSED rather than credited, each in the flattering direction: the onReceiveDamage ' +
           'half of the roll, real in game and worth zero against a foe that never attacks, which makes ' +
           'the rate a FLOOR; the rank-2 enrage - on build 25782799 a `dmg.dmgMult += vars.damage` ' +
           '(+50%) in Mad Buzz\'s own onProxyDamageEval, for a bee wearing the status Brood Leap\'s ' +
           'rank-2 area puts on a bee standing in it (the status carried it as a x1.5 DamageModifier ' +
           'affix until this build) - which is a position this fight does not have; and the rank-3 extension, which extendSummonDuration@6916 scopes to one Status ' +
           'INSTANCE (BaseSkill.getSummons@6247 filters summonSourceSkill == this) while every cycle consumes and ' +
           'rebuilds that instance, so the set it extends is empty. THE CAPTURE CHECKS WHAT IT CAN, on ' +
           'other players\' Pocket Hives: 190 distinct Buzzing owners, 3,470 applications against 3,374 ' +
           'removals, and 9,616 Summon_Bee bolts. Two readings come straight out of it. The bee\'s ' +
           'cadence: 9,063 gaps between consecutive bolts from one bee, median 2.066s, against the 2.0 ' +
           'this model takes - the SLOWEST of the three numbers the bee\'s own row authors, steps, ' +
           'cooldown and duration, chosen because the Foe AI loop that would settle it is not read, and ' +
           'vindicated. And the REFRESH semantics the run-of-successes formula rests on: 22,193 ' +
           'status_refresh rows against 3,470 status_on, so re-application overwhelmingly renews one ' +
           'timer rather than opening a second. What the capture cannot check is a per-fight TOTAL - no ' +
           'character in the modkit\'s inventory dumps owns Pocket Hive, so bench verify has no ledger ' +
           'to fold this against, and live bolts-per-bee is depressed by combat ending rather than by ' +
           'the schedule, which makes it a bound and not a correction.' },
    { severity: 'verified', what: 'a summon\'s hit reaches its owner\'s scripts through the proxy hooks, once per damage event',
      why: 'Build 25782799 split "damage I deal" in two. READ: BaseSkill.evalDamage@6124 ops 9-13 test ' +
           '`instigator != instigator.resolveProxy()`, and for such a hit ops 14-70 raise onProxyDamageEval ' +
           '(script slot 29) on every skill and status of the proxy-resolved OWNER, while ' +
           'BaseSkill.onInflictDamageEval@6126 ops 5-16 send the summon\'s own rows through slot 29 as well - so a ' +
           'pet\'s hit is evaluated by its owner\'s onProxyDamageEval and by nobody\'s onInflictDamageEval, ' +
           'and a clause in a proxy hook never touches what the owner casts. `hit.sourceUnit` is the OWNER ' +
           'on such a hit (ScriptHitData.get_source@6294 resolves the proxy); the pet is ' +
           '`hit.instigatorUnit` or `hit.skill.ownerUnit`. Three kits moved onto the hooks and are read ' +
           'there: the Silhouette of Almaz\'s imp crit rider (onProxyDamageEval, priced on the pets line), ' +
           'Mad Buzz\'s bee enrage (onProxyDamageEval, read and refused - see the stack-driven summon ' +
           'entry) and three post-damage feeds on onProxyDamage: Demonic Discharge\'s charge per pet hit, ' +
           'Mad Buzz\'s Buzzing roll on its bees\' bolts, and Swarmstrike Accord\'s bonus hit on a ' +
           'summon\'s hit. NOT READ, and this is the assumption: WHEN onProxyDamage (slot 30) fires. Its ' +
           'dispatcher sat in Unit.receiveDamage@4913 / applyDamage@4914, which are `throw "!isServer"` ' +
           'stubs in this client, and no client function calls the slot. All three feeds are priced at ' +
           'one fire per damage event a summon lands, which is what each script\'s one-for-one move from ' +
           'onInflictDamage says (the Almaz feed was `onInflictDamage` + `dmg.sourceUnit != owner` on the ' +
           'accepted build, calibrated then at 14.9 charges per press) and what the three tooltips say. ' +
           'MEASURED 2026-10-13 (Mage, Silhouette of Almaz at weapon rank 3, so the combat timer runs ' +
           'beside it): of the imps\' 56 swings, 45 came with a charge of Demonic Discharge inside the same ' +
           '3 ms and 8 landed with the bank already at twenty - one charge a pet hit, 45 of the 48 that ' +
           'had room; the timer\'s own charges arrived 2.96s apart. The swings themselves are logged ' +
           'under the pet\'s skill with the OWNER as source by probe v10, which is where the ledger now ' +
           'compares them: 31.1 priced an ordinary swing against a logged mean of 31.2 (28-33, the ' +
           'swing band), 47.9 against 47.3 critical, and 23 critical of 56 at a priced 37.1% - the ' +
           'sheet\'s 22.1% plus the script\'s 15%, added to the chance (it was a factor on the finished ' +
           'swing). The dummy\'s level-1 pool holds for a pet\'s hit as for its owner\'s. Swarmstrike ' +
           'Accord\'s bonus hit on a summon\'s swing and Mad Buzz\'s roll were not in the capture.' },
    { severity: 'unmodelled', what: 'most of what a rune or a talent does, pending the script kernel',
      why: 'Most talent nodes and most runes declare nothing this model reads, but they DO ship hscript ' +
           'bodies calling a small, closed set of host functions - so the gap is the script kernel, not ' +
           'missing data. `bench talents` prints the live counts rather than repeating them here, ' +
           'because a hardcoded coverage figure goes stale the moment the model improves.' },
    { severity: 'assumption', what: 'a weapon SUB-skill is a weapon skill: its hits by a read, its USE by a bridge',
      why: 'READ: on build 25782799 BaseSkill.isWeaponSkill@6161 ops 5-11 are `type == 7 || type == 8` - ' +
           'WeaponSkill or WeaponSubSkill; it tested 7 alone on the accepted build - and ' +
           'BaseSkillAccess.get_isSkill@5193 is that plus isClassSkill and isSignature, so 7, 8, 9 and ' +
           '17-20. BaseSkill.isActiveSkill@6156 did NOT widen (its switch is still 7, 9 and 17), so the Mage chain ' +
           `counter ignores a sub-skill. ${census.count(census.subSkills.length, 'row is', 'rows are')} type 8, each a weapon's: ` +
           `${census.subSkills.map((s) => s.texts?.name
             ?? (/_Recast$/.test(s.id) && cdb.byId('skill').get(s.id.replace(/_Recast$/, ''))?.texts?.name
               ? `${cdb.byId('skill').get(s.id.replace(/_Recast$/, '')).texts.name}'s recast` : s.id)).join(', ')}. What follows from ` +
           'the read alone is per HIT, and is priced: a guard written `dmg.isWeaponSkill` - Sever\'s +20% ' +
           'crit damage, a weapon-skill-scoped pool - now holds on a sub-skill\'s hits, and the modifier ' +
           'scope \'weaponSkill\' is routed to both types. What follows per USE rests on a bridge that is ' +
           'INFERRED: that a recast is started like any pressed skill, so tryConsumeCharge@9631 - which ' +
           'has no skill-type gate (ops 0-7 test only triggeredCD and the cooldown style) - raises ' +
           'onPreSkillProc and onSkillProc for it. On that bridge the fight raises one weapon-skill event ' +
           'per recast it plays (a combo point for the Rogue, a per-weapon-skill proc roll), and does NOT ' +
           'yet take the three further consequences: a recast paying Spark and spending a Mage chain arm ' +
           '(Mage_SparkMaster.onPreSkillProc gates both on isWeaponSkill), a recast spending a ' +
           'next-weapon-skill register, and one banking a Tide Rising stack. The two ultimates (Anger ' +
           'Release, Hidden Power) are priced after the fight, off a counter, so their uses raise no ' +
           'event at all. ONE MEASUREMENT settles the bridge: a Mage with the weapon that grants Expulse, ' +
           'Spark gauge in view - press the skill, then its recast. Spark dropping on the recast is this ' +
           'reading (and means the three consequences above are owed); Spark unchanged means a recast is ' +
           'not a use, and the event the fight raises for it should go.' },
    { severity: 'assumption', what: 'Domination: a stun arms a certain-crit weapon skill (measured), and its rank-3 bonus is paid at the controlled SHARE of the fight (an average)',
      why: 'Build 25782799 rewrote Judgement\'s passive into two mechanisms, both read; the 2026-10-13 capture measured ' +
           'the first and the part of the second a cast does to itself. ' +
           'MEASURED (probe v10, a level-25 rank-3 Warrior on one dummy, each press alone): Rampage at full charge logs 853 ' +
           'with nothing up (9 of 9, one natural crit at 1310) and 1507 after a Charge (10 of 10 critical) - x1.767, the ' +
           'crit multiplier 1.5366 times 1.150, the register\'s +0.15 alone in the bracket because Charge\'s one-second stun ' +
           'had ended 2.6s before the hit. The same x1.15 at the two shorter charges (628 / 356, 1005 / 569). Shockwave, which ' +
           'stuns what it hits, logs 320 unarmed and 551 armed: 320 already holds the rank-3 +0.25 on its own hit, and ' +
           '(1 + 0.25 + 0.15) / (1 + 0.25) x 1.5366 = 1.721 is the 551. Worldsplitter\'s Tear Reality - the OTHER weapon\'s ' +
           'skill - spends it too (571 against 324, x1.762). Surging Force and Shockwave arm it like Charge; Raging Smash ' +
           'and a debuff that is no stun do not; 35 base attacks and finishers under it did not spend it; it was still up ' +
           '82.9s after the stun that armed it; Shockwave spends it at the press and re-arms it with its own stun. A cast ' +
           'that stuns takes the +0.25 on its own hit: Charge 232 = 186 x 0.9453 x 1.25 x 1.0553, Surging Force 154. All of ' +
           'that is how the fight plays it. WHAT THE CAPTURE ALSO SHOWS and the fight only averages: the +0.25 on OTHER ' +
           'casts is per hit - Raging Smash outside any stun logs a bare 248 - where the fight pays every hit 0.25 x the ' +
           'share of its own length a stun stood (a Raging Smash priced 262.7 in a fight whose stuns cover a quarter of ' +
           'it, +5.9% on a hit that was outside one and -15% on one inside). Right on average while hits fall evenly ' +
           'across the fight; a three-second charge pressed straight after its own stunner never lands inside it. ' +
           'THE READ, as it stood before the capture: ' +
           'THE REGISTER, at every rank. READ: GA_Craft_Passive.onTryAddStatus@44727 ops 1-3 return unless ' +
           'the status being applied is "Stun", op 17 addStatus(owner, "GA_Craft_Passive_Proc"); ' +
           'GA_Craft_Passive_Proc.onSkillProc@44730 op 3 BaseSkill.isWeaponSkill@6161 (skill type 7 or 8), ops 5-6 ' +
           '`ctx.critChance = 1`, ops 7-17 `ctx.dmgMult += vars.damage`, op 19 stop. onSkillProc is raised ' +
           'once per skill USE (tryConsumeCharge@9631 ops 90 and 120, before any hit exists), every hit of ' +
           'the cast copies the context ($ScriptHitData.__constructor__@6318 op 10 -> $BaseSkillContext.copy@5232), and ' +
           'criticalRoll@6320 ops 9-13 crit whenever critChance >= random - so the next weapon-skill press ' +
           'is priced as a certain critical strike with the amount in the one additive dmgMult bracket. The ' +
           'amount is the status row at the rank it was applied at: 0.10, and 0.15 from weapon rank 2 ' +
           '(props.rankOverride; Status.get_rank@15802 takes the instigator skill\'s rank and ' +
           'SkillScript.addStatus@6879 ops 13-16 pass the passive as instigator). Every cast in the build ' +
           'that applies the Stun row arms it - the fight spends before it arms, so a stunning weapon skill ' +
           'arms the NEXT press and never itself. NOT READ: the hook\'s dispatcher. ' +
           'GameObject.addStatus@4636 is a `throw "!isServer"` stub in this client and nothing here calls ' +
           'the script slot, so "it fires on whoever applies the status, once per attempt, whether or not ' +
           'it lands" is the hook\'s name, its (status, target) signature and the tooltip - "After applying ' +
           'a [Stun], even if the target is immune" - and that sentence is the ONLY authority for arming ' +
           'against a boss, which is the default target. A stun that only lands on a roll (a weapon-upgrade ' +
           'proc) would arm it too and is named on the plan rather than counted. THE RANK-3 BONUS. READ: ' +
           'GA_Craft_Passive.onInflictDamageEval@44728 ops 2-4 return below rank 3, op 7 isCrowdControlled@6918 -> ' +
           'GameObject.isUnderAnyCC@4635 -> hasStatusFlag@21820(inf, 1), ops 9-19 `hit.dmgMult += ' +
           'vars.var1` (0.25). It is the OWNER\'s rider (evalDamage@6124 ops 71-123 run onInflictDamageEval ' +
           'on every skill and status of whoever lands the hit), so it rides every hit you deal and not ' +
           'the passive\'s own - a routing the accepted build needed too and did not have: its rider was ' +
           'read, listed as scored and applied to no cast. It is priced at 1 on the hits of a cast that ' +
           'applies its own crowd control (MEASURED 2026-08-21 on the old script, same hook: five clean-' +
           'dummy Charges at exactly x1.25; WHICH hits of which casts is the next entry) and at the ' +
           'controlled share of the fight on everything else - ' +
           'each applier\'s duration over the interval the fight played it at, windows taken as ' +
           'independent. Against a target immune to crowd control it is ZERO: GameObject.canReceiveStatus@4634 refuses ' +
           'every CrowdControl-flagged status there, so such a target is never "under any CC". The flag is ' +
           'on Slow, Silence, Stun, Root and Grounded; the tooltip says "enemies affected by a [Stun]". TWO ' +
           'MEASUREMENTS settle what is not read. (1) Judgement in the main hand, any Elite or Boss: Charge ' +
           'or Shockwave, then Rampage, ten times. Every Rampage a critical strike at x1.10 (weapon rank 1) ' +
           'or x1.15 (rank 2+) over a plain crit is this reading; a Rampage that does not always crit there ' +
           'means the register is not armed by a stun the target refuses, and it is worth nothing on the ' +
           'default target. (2) Rank-3 Judgement with the Thundersmash rune on a training dummy, no stun ' +
           'used: base attacks inside Raging Smash\'s 3s slow against base attacks outside it. x1.25 ' +
           'inside is the code\'s reading (any crowd control); x1.00 is the tooltip\'s (Stun only).' },
    { severity: 'assumption', what: 'crowd control has one reader: what a cast applies, for how long, and which of its own hits land inside it',
      why: 'Three things ask whether a cast controls what it hits - the share of the fight a crowd-control ' +
           'rider is priced at, whether the cast pays that rider on its OWN hits, and whether it arms ' +
           'Domination\'s register - and they are answered from one list (crowdControlOf in skills.mjs). ' +
           'TWO riders read the gate: Domination\'s owner-wide rank-3 bonus (the entry above) and Chaotic ' +
           'Distorsion\'s rank-2 +40% on its own hits. READ: Halos_Demon_Skill1.onDamageEval@44841 ops 2-9 ' +
           'return below rank 2 or unless `hit.target.isUnderAnyCC()` - the function Domination\'s wrapper ' +
           'calls - and ops 10-20 add vars.damage to dmgMult. That clause was refused as unanswerable until ' +
           'the direct spelling was read; it is scored now and has never been measured. OWN HITS. A Status ' +
           'step or an effect the cast itself plays covers every hit of the cast: measured on the ' +
           'Status-step shape (Charge), taken the same way and NOT measured where one effect carries both ' +
           'the damage and the status (Luon Shackles). A stun the script adds in its own onHit covers the ' +
           'hit that raised it too. READ: st.skill.SkillStep.hitEntity@6061 op 137 hands newHit a closure ' +
           '(fn@48280) that calls ' +
           'st.skill.BaseSkill.onHit@6233 at op 10 (ops 80-91 run the script\'s onFirstHit, then onHit, on ' +
           'the server) and ent.GameObject.receiveHit@4540, where the hit\'s damage is applied, at op 13; a ' +
           'projectile\'s closure fn@34678 hands receiveHit to onHit as the callback it runs after the ' +
           'script. So Iron Cyclone\'s four hits each take the rider whole, and behind `hit.stepId == ' +
           'Steps.X` only step X\'s hits do (Blazing Beam\'s Blast, Ram Trap\'s Explode). A control added ' +
           'anywhere else - onDamage, an owner-wide hook - is counted for the fight and not for the later ' +
           'hits of the cast that raised it: a floor. A Status step the cast does not play is read where ' +
           'its script plays it: Eruption stuns from rank 3 (it was read as stunning at rank 1). NOT ' +
           'COUNTED, and named on the plan wherever a rider reads the gate: a control the script reaches ' +
           'from an event this fight does not produce. Deceiver Trick stuns an enemy that LEAVES its area; ' +
           'Blinding Light slows whatever enters its area for as long as it stays. TWO MEASUREMENTS. (1) ' +
           'Twin Pillars of Justice with Judgement in the arsenal at weapon rank 3, a training dummy, ' +
           'nothing else that stuns and no damage buff up: the four hits of one Iron Cyclone, with and ' +
           'without Domination slotted. All four at x1.25 is this reading; the first at x1.00 means the ' +
           'stun lands after the hit that applies it. (2) Mirrors of the Nightgoddesses at weapon rank 2 or ' +
           '3 with Luon Shackles in the arsenal: Chaotic Distorsion pressed inside the stun and outside it. ' +
           'x1.40 inside is this reading.' },
    { severity: 'assumption', what: 'a rider that asks for a Slow is priced on the share of the fight the target is slowed, not on any crowd control',
      why: 'Riptide adds its var to its own hits behind `hit.target.hasStatusType(StatusType.Slow)` and ' +
           'Pyroclasm, from weapon rank 2, to every hit its owner lands behind ' +
           '`dmg.target.getStatusTypeCount(StatusType.Slow) > 0` - one question in two spellings. Slow ' +
           'carries the CrowdControl flag and has no parent type, so a Boss, Miniboss or Elite refuses ' +
           'it (GameObject.canReceiveStatus@4634) and a stun does not answer it. The share is the union of the ' +
           'Slow-typed controls the fight plays, each at duration / interval - the same arithmetic as ' +
           'the any-control share, restricted to the type. A cast that both slows and reads the slow ' +
           'on the same hit is not credited on that hit. A Slow applied by something the fight does ' +
           'not play (Power of the Tides erupting at a totem) is not in the share. ' +
           'WHAT SETTLES IT: Radiance at weapon rank 3 on the Dummy - a Pyroclasm pressed inside the ' +
           '6 seconds after a Blazing Beam\'s final blast against one pressed outside them; x1.30 ' +
           'inside is this reading.' },
    { severity: 'assumption', what: 'a rider that waits for a status type on the target (Scorch against a burning one) is paid while one of your own statuses of that type stands - read, not measured',
      why: 'Scorch, the finisher of the Apprentice\'s Grimoire, adds 25 points of critical chance from ' +
           'weapon rank 3 behind `hit.target.hasStatusType(StatusType.Burn)`. READ: ' +
           'SkillScript.hasStatusType@6885 calls GameObject.hasStatusType@4626 with no instigator, ' +
           'which answers true for any status on the target whose type is the one named ' +
           '(Status.isType@15821). Burn is neither a crowd control nor a bleed, and the reader of a ' +
           'cast\'s own riders knew only those two answers - it took the test out of the guard and ' +
           'paid the rider on EVERY Scorch: 21.7 critical finishers of 61 in the Grimoire\'s 200 s fight ' +
           'on the named boss at rank 3. It is paid now on the finishers that land while a Burn of the ' +
           'build\'s own stands (Pyroball\'s Light Burn, 10 s a cast): 41 of the 61, 16.7 critical, the Scorch ' +
           'line 28.8 -> 27.8 dps and the build 98.0 -> 96.9. With no status of the type in the build ' +
           'the clause is listed as read and off. A FLOOR, the talent spelling included (Finish the ' +
           'Job against a poisoned target): the fight pays these on presses and on the links of the ' +
           'chain, and a step a script plays off a swing - Spark Shot\'s extra hit, a hit of the ' +
           'finisher\'s row in game - is priced without them (16 damage of that line\'s 2,549 on Horns ' +
           'of the Wind under the poison tree). NOT MEASURED - the 2026-10-13 capture holds no ' +
           'Grimoire - and a Burn somebody else applied would answer the test in game too. WHAT ' +
           'SETTLES IT: the Grimoire at weapon rank 3 on the Dummy, the chain alone and then with ' +
           'Pyroball kept up - Scorch\'s critical share is the sheet\'s in the first block and 25 points ' +
           'over it in the second.' },
    { severity: 'assumption', what: 'a mark a weapon skill\'s hit leaves on the target is spent by the next finisher hit - read, not measured',
      why: 'Thrill of the Hunter (Horns of the Wind) is one hook: onInflictHit adds vars.damage to the ' +
           'hit\'s dmgMult and consumes the mark when the hit is the finisher\'s and the target wears ' +
           'it, and otherwise puts the mark on whatever a weapon skill hits ' +
           '(Bow_BigGame_Passive.onInflictHit@44944). Build 25782799 doubled the amount (+100%, +150% ' +
           'from weapon rank 2) and took the spend away from plain swings. The fight marks the target ' +
           'on every weapon-skill cast that lands a hit, for the mark\'s own 10 seconds, and the next ' +
           'finisher takes the amount in the additive bracket on one hit - the mark is consumed in ' +
           'the same call, so the finisher\'s script-played extra hit does not find it. The mark is ' +
           'not crowd control and an immune target wears it. NOT PRICED, and said on the build: its ' +
           'rank-3 crit chance for the spending hit against a target under 35% health. ' +
           'WHAT SETTLES IT: on the Dummy at weapon rank 2 - Hunter Net, then a full chain: the ' +
           'finisher\'s arrow reads x2.5 a plain one, and the finisher after it x1.0.' },
    { severity: 'assumption', what: 'Flower Spiral spends its petals for one more spin each, and the fight keeps the bank - read, not measured',
      why: 'Every step of Flower Spiral is played by its own onStart: one spin whatever it holds, and one ' +
           'more (the same 0.24 x Dexterity + 0.24 x Faith) for every Psychoactive Petal, all of which ' +
           'it consumes. Petals arrive from the skill\'s own script - one per vars.time seconds of ' +
           'combat (4, and 3 from weapon rank 2) and one from the finisher\'s first hit - to the ' +
           'status\'s six, and a petal\'s ten seconds are refreshed by every arrival, so none is lost. ' +
           'The press is priced as its own spin times (1 + petals held). The script is all `on: Code` ' +
           'steps, so by the rule this model reads off the client the cast never takes control of the ' +
           'hero and costs no clock; if it does hold you, each petal adds its 0.15s. At weapon rank 3 ' +
           'Nectar-infused Blade rides it: the passive\'s whole block runs on a swing OR on a hit of ' +
           'a rank-3 Flower Spiral (`dmg.isBaseAttack || (dmg.skill.inf.id == Skill.<Flower Spiral> ' +
           '&& spinSkill.rank >= 3)` - the spin skill\'s rank-3 text is "Triggers the effects of" ' +
           'it), so every spin hit lands the passive\'s 0.08 x Dexterity + 0.08 x Faith as well, and ' +
           'every spin hit that crits gives back the passive\'s 1s of Flower Spiral\'s cooldown; both ' +
           'are on the fight\'s count of the cast\'s hits. NOT PRICED, and said on the build: the ' +
           'passive\'s rank-2 x1.3 on its own hit against a target under 35% health (written as ' +
           '`dmgMult *=`). ' +
           'WHAT SETTLES IT: on the Dummy, wait out of combat until no petal shows, pull, count petals ' +
           'for 12 seconds (three from the timer at rank 1, plus one per finisher) and press: the log ' +
           'shows one hit more than the petals shown.' },
    { severity: 'unmodelled', what: 'Expulse (Book of Mi\'Mizan) is priced at ONE orb a press; the real count is the spheres it pulled in',
      why: 'Expulse deals nothing itself. It pulls in the Water Spheres Abyssal Rise left on the ground - ' +
           'eight at most, each lying six seconds - one charge per sphere, and its recast throws one ' +
           '0.6 x Intellect + 0.6 x Faith orb per charge. Abyssal Rise spawns one sphere plus one per ' +
           'Tide it holds (to ten: one every four seconds of combat, and one or, from weapon rank 2, ' +
           'two per finisher), so a press made right after a Rise throws several orbs, not one. That ' +
           'chain - Tide into spheres, spheres into charges, charges into orbs - is three banks with a ' +
           'lifetime between them, and this fight keeps none: it presses Expulse for its recast, ' +
           'prices one orb, and says so on the line. With Abyssal Rise not slotted it prices nothing. ' +
           'By the row\'s own numbers the line is low by about the number of spheres a Rise spawns. ' +
           'WHAT SETTLES IT: on the Dummy, Abyssal Rise after ten seconds of swinging, then Expulse ' +
           'and its recast: the orbs thrown are the spheres that were on the ground, eight at most.' },
    { severity: 'verified', what: 'Cooldown Reduction is read when a cooldown STARTS and held for that cooldown - so a timed status that carries it shortens the cooldowns begun under it',
      why: 'READ: Skill.onTriggerCD@9634 ops 0-8 write the field cooldownDuration = ' +
           'getEffectiveCooldown(), the row\'s cooldown times GameObject.getCooldownModifier@4600 (max(0, ' +
           '1 - CooldownReduction), off the owner as it stands at that instant); Skill.update@9639 ops ' +
           '18-21 advance the charge by dt / getCooldown(), and getCooldown@9604 returns that field. ' +
           'Nothing rewrites it while the cooldown runs; the next use of the skill does. MEASURED ' +
           '2026-10-13 on the captured Mage (Cooldown Reduction 4; Queen\'s Decree\'s and Inner Demon\'s 20 ' +
           's clocks, each read off its ready marker, polled every half second; Mystic Empowerment\'s +30 ' +
           'for 15 s): a cooldown begun UNDER the status, with the status gone 4.9 s in, came back in ' +
           '13.03 s, and one that ran its whole length under it in 13.50 (20 x 0.66 = 13.2; a rate that ' +
           'followed the status would make the first 17.0); three begun BEFORE it, with the status ' +
           'arriving 9.9, 3.1 and 8.2 s in, took 18.99, 19.68 and 19.26 s (19.2; a rate that followed it ' +
           'would make them 16.3, 14.2 and 15.8); the 21 that never met it took 18.98 to 19.74. The ' +
           'fight used to hold one multiplier, off the sheet it starts from, for every cooldown of the ' +
           'fight - so the Cooldown Reduction on a timed status was worth nothing at all. It now asks ' +
           'the sheet as it stands when each cooldown starts (a press, a passive\'s own clock, a use ' +
           'rider\'s), and a skill with several charges is latched again by each of its presses, the ' +
           'charge on its way going on at the new length. What a cooldown is worth in Spark follows the ' +
           'same latch (getSparkCost reads the field onTriggerCD has just written). ASSUMED: a press\'s ' +
           'OWN status is not up when its own cooldown starts. That is read for Mystic Empowerment - its ' +
           'row has no execution step, so its charge is consumed in Skill.start@9625 ops 1-2 before any ' +
           'step runs, and the step that hands the status out waits 0.25 s (the status row follows the ' +
           'press by 0.28 to 0.36 s in the capture) - and it is an assumption, and a floor, for a cast ' +
           'whose status goes on with the press. WHAT IT MOVES: every build that holds such a status - ' +
           // Counted off the sheet: a status row with a life and a positive
           // Cooldown Reduction row at some rank.
           (() => {
             const rows = cdb.lines('skill').filter((s) => s.props?.status != null && s.duration > 0
               && (s.affixes ?? []).some((a) => a.target?.attribute === 'CooldownReduction' && a.val > 0));
             const names = [...new Set(rows.map((s) => s.texts?.name ?? s.id))];
             return `${rows.length} timed status rows of the sheet carry Cooldown Reduction (${names.join(', ')})`;
           })() +
           ' - and such a build presses on other seconds than it did, which this fight is sensitive to: ' +
           'the same presses a second apart can read a few percent apart where a window rides them.' },
    { severity: 'assumption', what: 'a status a script hands to the caster\'s whole party is the caster\'s - Mystic Empowerment is priced, and placed by the order, not chosen',
      why: 'Mystic Empowerment hands its status to every hero getPartyHeroesWithinRange returns for the ' +
           'caster, and that list leaves nobody out: SkillScript.getPartyHeroesWithinRange@6861 walks ' +
           'hero.player.group.players (the loop is ops 36-84) and pushes each player\'s hero inside the ' +
           'range (op 79 the distance test, op 83 the push); the hero it was handed is compared with ' +
           'nobody. MEASURED 2026-10-13: 39 rows of the status, 33 on the hero who cast it - one for ' +
           'each of the 33 casts - and 6 on another player; the bench\'s own Mage, alone, pressed it five ' +
           'times and wore it after each. So in this fight of one hero it is a timed status of hers: +30 ' +
           'Cooldown Reduction for 15 s, shortening the cooldowns that start under it (the entry above). ' +
           'A build was first told it goes "to an ally or a summon", then that it lands on the party ' +
           'with the caster in it and is not priced. ITS RUNES: the one that extends the status each ' +
           'time a weapon skill gets a charge back is played as that event - half a second when a charge ' +
           'returns with the status still up (the captured Mage slots it, and her status stood 15.0, ' +
           '15.5 and 16.0 s in a rotation that left its weapon skills waiting; on other players it stood ' +
           'up to 28.0 s. A fight that presses every weapon skill as it comes back extends it far more ' +
           'than hers did, and the line of the press says how often); the one that swaps the status for its twin on half the casts is priced as ' +
           'the two rows blended at that share, the Cooldown Reduction both carry on every cast; the one ' +
           'that shortens the skill\'s own cooldown is the row\'s prop. ASSUMED, AND NOT A RULE OF THE ' +
           'GAME: where the press falls. It deals nothing, so the order files it last and it is pressed ' +
           'when nothing else is ready - the skills it finds on cooldown come back inside its window and ' +
           'start their next one under it. Ranked first instead, on the cooldowns it would shorten, it ' +
           'read LOWER on the build it was tried on (the default Mage search of 2026-10-14, level 25, ' +
           'named boss: 685.5 against 700.3, twice pressed either way; 675.1 with the skill off the ' +
           'bar). A player who times it against the long cooldowns can do better than either. NOT ' +
           'PRICED: what it does for the other heroes of a party. WHAT WOULD MEASURE THE PRICE: the Mage ' +
           'on the dummy, one fixed rotation with the skill pressed at a fixed second and again without ' +
           'it - the presses of each weapon skill per minute, against the model\'s.' },
    { severity: 'unmodelled', what: 'a heal handed to whoever wears a shield has no rate: Water Veil',
      why: 'Water Veil (Book of Mi\'Mizan) hands its heal over time to `s.owner` in onShield - the wearer ' +
           'of the shield that was applied, on a roll each time. MEASURED 2026-10-13: 70 rows, 70 on the ' +
           'hero who applied the shield. The amount is in the row; the fight raises no event when a ' +
           'shield goes on, so it has no rate and is in no number - a Mage or a Priest holding the Book ' +
           'reads no healing from it at any goal, and is told "no rate". What would price it: a count of ' +
           'the shields the build applies in a fight, by the press or the proc that applies each.' },
    { severity: 'assumption', what: 'a mark that detonates is banked one stack per hit and spent whole by the next Magic weapon skill - read, not measured',
      why: 'Void Bomblet (Mirrors of the Nightgoddesses): each of the finisher\'s two bolts leaves a ' +
           'stack on the target, to four, for twelve seconds; the status\'s onReceiveDamage plays its ' +
           'own AOE step - a Damage effect flagged ScaleWithStacks, 0.3 x Intellect + 0.3 x Faith a ' +
           'stack, 0.375 + 0.375 from weapon rank 2 - and stops itself when the wearer takes damage ' +
           'that is a weapon skill\'s and Magic. isMagic is the affinity\'s damage type ' +
           '($HSkill.isMagic@21765), so Light, Water and Chaos weapon skills detonate it too. The ' +
           'fight banks a stack per hit of the finisher and spends the bank on the next weapon-skill ' +
           'cast that lands Magic damage, once: the status is gone before that cast\'s second hit. ' +
           'NOT READ: the hook\'s dispatch (receiveDamage is a server-only stub in this client), so ' +
           '"it fires on the hit that detonates, before the stacks that hit would add" is the ' +
           'script\'s order, not a read. The rank-3 stun on detonation (15%) is not priced. ' +
           'WHAT SETTLES IT: on the Dummy, two finishers and then Chaotic Distorsion: one extra hit ' +
           'beside it worth four times the tooltip\'s per-stack number, and a second Chaotic ' +
           'Distorsion straight after with none.' },
    { severity: 'assumption', what: 'a hit a status deals when it ENDS is priced once per target it was put on, and never on a target that refuses the status',
      why: 'Ram Trap\'s root (4 seconds) plays its own Damage step from onStop at weapon rank 3 - "Deals ' +
           'an additional ... when the immobilization effect ends", 0.6 x Dexterity + 0.6 x Intellect ' +
           'on whoever wore it. One application ends once, so the hit rides each Ram Trap that lands - ' +
           'once for every target it roots: the script roots whatever its Explode step hits ' +
           '(`if (hit.stepId == Steps.Explode) addStatus(hit.target, ...)`), Explode is an Area step, ' +
           'and the end-hit takes that step\'s reach, so `--targets 3` is three of them a cast. ' +
           'The root is crowd control: GameObject.canReceiveStatus@4634 refuses a CrowdControl-flagged ' +
           'status on a unit Foe.isCCImmune@7071 answers for (Boss, Miniboss, Elite), so against such a ' +
           'target the root never lands and the hit is zero, said as such. INFERRED, not read: that ' +
           'the server\'s addStatus asks canReceiveStatus (its only caller is a server-only stub in ' +
           'this client), and that a trap is always stepped on. ' +
           'WHAT SETTLES IT: at weapon rank 3, a Ram Trap under a dungeon boss and one under the ' +
           'Dummy, and the log four seconds after each explosion: a second hit on the Dummy and none ' +
           'on the boss is this reading; one on both means the hit does not need the root.' },
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
           'release and impact is not billed. ' +
           'MEASURED AGAIN 2026-10-13 on build 25782799: the three levels log 356 / 569 / 853 (ratios 1.60 and ' +
           '2.40, the authored 4 / 2.5 and 6 / 2.5); which one lands goes by the time from press to hit - ' +
           'under 2.24s the first, 2.245s to 3.2s the second, and the cast releases itself at 3.22s for the ' +
           'third, which is the 3.15s this model bills (the 3s hold and the hit step\'s 0.15s delay); the ' +
           'cooldown runs 12.0s from the HIT (the script consumes it on the hit step), as priced.' },
    { severity: 'assumption', what: 'a cooldown reset that "makes it instant" hands back an instant cast - read, not measured',
      why: 'Three rows reset a weapon skill and put up the status that skill\'s own shouldPlayInstantly ' +
           'waits for: Deadeye Focus (Aimed Shot), Pyroclasm (itself) and Smite (Ram Veil). ' +
           'BaseSkill.start@6145 ops 5-22 give such a cast castTimeFactor 0; SkillStep.get_duration@5998 ops 21-41 ' +
           'then make its Cast step last nothing, canStart@5993 ops 16-47 do not start a Start-time ' +
           'Visuals step or one marked skipWhenInstant, and Skill.evalDuration@9569 takes the cast ' +
           'step\'s duration off the row\'s own. The fight plays the reset-granted press at that cost ' +
           '(Aimed Shot 0.25s for 1s) while the status lasts, and one use ends it. Since build 25782799 ' +
           'Deadeye Focus keeps the reset in its STATUS\'s onStart - read one hop from the passive that ' +
           'applies it - and from weapon rank 3 that status adds +25% to the cast it speeds up, in the ' +
           'cast\'s additive dmgMult bracket. NOT READ: whether a re-application of a status still worn ' +
           're-runs onStart (Status.refresh is a server-only stub in this client) - it decides nothing ' +
           'here, the status being worn only while the skill is already ready. The roll is taken once ' +
           'per swing; a swing that lands two damage instances rolls twice in game. ' +
           'WHAT SETTLES IT: Credence on the Dummy at weapon rank 3 - when Deadeye Focus appears, Aimed ' +
           'Shot is off cooldown at once, fires with no cast bar, and hits for 1.25x a plain one.' },
    { severity: 'assumption', what: 'a cooldown a script hands back on "your Magic critical strikes" or on "a use" is put on the events the fight raises - a floor for the first',
      why: 'A script names its own row as `skill.kind`, a bare `kind`, or with an empty argument list; ' +
           'all three are read. Pyroclasm\'s rank-3 reset is owner-wide - onInflictDamage, any Magic ' +
           'damage instance that crits, a 20% roll - so the fight takes the Magic damage events of ' +
           'each cast and swing it prices, at their crit chance q, and prices "at least one of the n ' +
           'crits and passes the roll" - 1 - (1 - q x 0.2)^n - as a reset (a Blazing Beam, forced to ' +
           'crit from rank 2, is fourteen rolls and one reset: Pyroclasm cannot be pressed inside the ' +
           'channel). Triggered lines, conduits and ticks are not counted, so the rate is a floor. Shiv\'s "Your [ComboAttack] resets the cooldown" is onSkillProc - every ' +
           'use of a skill by its owner (tryConsumeCharge@9631 ops 67-121) - behind the finisher test, ' +
           'so each finisher hands it back. Riptide\'s rank-3 refund is onHitNewTarget, once per enemy ' +
           'a cast had not hit yet (BaseSkill.onHit@6233 ops 17-22), counted once per cast. Blinding ' +
           'Light\'s refund asks how many enemies the cast hit and is answered by --targets. ' +
           'WHAT SETTLES IT: Radiance at weapon rank 3 on the Dummy, one Blazing Beam with Pyroclasm ' +
           'on cooldown: Pyroclasm lit and instant when the beam ends in about 19 of 20 tries.' },
    { severity: 'unmodelled', what: 'skill scripts, beyond the links and guards read out of them',
      why: `${census.scripted.toLocaleString('en-US')} of ${census.skills.toLocaleString('en-US')} skills carry hscript bodies this build does not execute. Four things ARE read out ` +
           'of the text, because the data records them nowhere else: the status a skill applies ' +
           '(addStatus, through a local alias if it uses one), the event that applies it (isWeaponSkill, ' +
           'isBaseAttack, isFinalCombo), the roll that guards it (checkProba(vars.chance)), and the proc ' +
           'rate vars.chance itself. Everything else - a magnitude passed as a third addStatus argument, ' +
           'a setDynVal injection, a conditional rider - is not, and a status whose whole payload is a ' +
           'script-set dynVal is named as unmodelled rather than counted at zero without comment.' },
    { severity: 'verified', what: 'how a re-applied status composes is read from props.status.stackingPolicy',
      why: `Additive | DurationBased | Override, authored on ${census.policyRows} of ${census.statusRows} status rows. DurationBased CARRIES ` +
           'THE REMAINDER - checked in game on Hemorrhage, where a 200 crit banks 70 damage over 8s and a ' +
           'second crit for 100 two ticks later adds the 35 still owed to the new 35 - and ' +
           `${census.count(census.policy('DurationBased').length, 'status declares', 'statuses declare')} it ` +
           `(${census.policy('DurationBased').map((s) => (s.texts?.name ? `${s.texts.name}, ${s.id}` : s.id)).join('; ') || 'none'}); ` +
           `${census.policy('Additive').length} declare Additive and ${census.policy('Override').length} Override. ` +
           'A row that authors none refreshes, losing the overflow. Guessing which dots pool ' +
           'from "is the declared amount a total" instead matched nearly every dot in the game and took ' +
           'the answer to 44,000 dps, which is what the column is for.' },
    { severity: 'assumption', what: 'a pool DoT BANKS the share of what fed it and pays the bank out tick by tick - each tick a hit of the status\'s own affinity',
      why: 'Warrior_Hemorrhage takes 35% of every physical critical strike (vars.damage, handed to ' +
           'addStatus as a third argument) and its status is DurationBased with unlimited stacks, so no ' +
           'damage is ever dropped while the fight runs. WHICH damage feeds a pool is read off the ' +
           'script\'s hook: `onInflictDamage` is owner-global (Hemorrhage, Infused Wound), a skill\'s own ' +
           '`onDamage` sees only that skill\'s hits (Bonethrow banks 40% of what BONETHROW deals - ' +
           'reading it as global fed it from the whole rotation\'s crits and invented ~18% of a Warrior\'s ' +
           'headline). The share is what is BANKED, not always what is dealt: the status row ticks the ' +
           'bank back out as Damage of its own affinity, and that tick is a hit. A Raw pool (Hemorrhage, ' +
           'Virulent Contamination) pays what it banked. A pool that is not Raw - Bonethrow\'s Physical ' +
           'bleed, Spark Hemorrhage\'s Magic one - takes the target\'s armour again on every tick, the ' +
           'banked hit having paid it once already, and on this build\'s read the applier\'s (1 + Fervor ' +
           '+ mastery) x DamageModifier as well: against an armoured target Bonethrow\'s bleed is its ' +
           '40% cut by that armour a second time, not 40% of the hit. Those stages, why they are read ' +
           'and not measured, and the one Bonethrow that measures them are the status-tick entry ' +
           'below; the pool\'s own line prints each stage with its factor beside the ledger. ' +
           'The bank pays out over the dot\'s own tick schedule, DurationBased-style - each ' +
           'feed redistributes what is still owed over a fresh window - so what the bell catches ' +
           'un-ticked is dropped, which is what a damage meter would have missed too. Red Tempo earns ' +
           'its cooldown back per tick and Cracking Blood rolls against each one. What is still assumed ' +
           'is Magic Conduction\'s and Exposed Essence\'s "while the target is bleeding", which are ' +
           'credited whole rather than at the bleed\'s uptime.' },
    { severity: 'info', what: 'physical and magical reduction are equal on every foe except the golems' +
        (targetFacts.splitOther.length ? ` and the ${targetFacts.splitOther.length} rows that author a split outright` : ''),
      why: `${targetFacts.splitGolems.length} units are built from ${armourSplits.stubOwners.join(' / ') || 'no row'}, whose Armor row is a bare multiplier with no MagicArmor twin, so a golem ` +
           'is harder to hit than to burn' +
           (targetFacts.splitGolems.length
             ? ` (${targetFacts.splitGolems[0]}: ${targetsByUnit.get(targetFacts.splitGolems[0]).phys.toFixed(2)} physical / ` +
               `${targetsByUnit.get(targetFacts.splitGolems[0]).mag.toFixed(2)} magical)`
             : '') +
           ' and physical penetration is worth more against it than magical. ' +
           (targetFacts.splitOther.length
             ? 'The only other rows that split them author it on their own stat rows: ' +
               `${targetFacts.splitOther.map((id) => `${id} ("${units.get(id)?.texts?.name ?? '?'}", ` +
                 `${targetsByUnit.get(id).phys.toFixed(2)} / ${targetsByUnit.get(id).mag.toFixed(2)})`).join(', ')}. `
             : 'No other row splits them. ') +
           'Against everything else ArmorPenetration and SpellPenetration are worth the same, and which one you want is decided ' +
           'by your class and your gear\'s faction, not by the target.' },
    { severity: 'verified', what: 'basic swings vary ±10% over their WHOLE value; nothing else varies at all',
      why: 'Read from getEffectRange@21778 (HSkill.hx:193-202): WeaponAttack_RandomRange (0.1) applies only to ' +
           'Damage effects on skill types Attack..Attack4 - the combo finisher, weapon skills, class ' +
           'skills and status ticks all roll nothing, which is why the finisher read a constant 133 in ' +
           'game - and the band covers flat plus attribute (getStepEffectItemScaling@21779 adds the ' +
           'scaling first, then rolls). Deterministic mode keeps the mean; --fights N rolls the swings. ' +
           'Measured again 2026-10-13 on build 25782799: Judgement\'s swings in one fixed buff state, priced ' +
           '112.3, logged every integer from 102 to 124 over 64 hits and nothing outside; its finisher 230 ' +
           'every plain time; the sword\'s finisher moved only with its stacks.' },
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
    { severity: 'assumption', what: assume.tickSource === 'carrier'
      ? 'a status tick is priced off the unit WEARING it - the accepted build\'s rule (--tick-source carrier)'
      : 'a status tick is priced off the unit that APPLIED it - read on build 25782799, and measured on one foe-worn poison',
      why: 'A status\'s hits run in the status\'s own SkillContext, built once when it starts ' +
           '(Status.postInit@15818 -> BaseSkill.start@6145), and SkillContext.initVars@5241 seeds that context\'s crit ' +
           'chance, crit damage and (1 + fervor + mastery) x DamageModifier brackets from ' +
           'skill.getSourceObject() - which for a Status is its INSTIGATOR (Status.getSourceObject@15807), ' +
           'not the unit wearing it. So every tick of a status this build applies takes the build\'s own ' +
           'bracket unless it is Raw (getDamageScale@5238 returns 1), and rolls the build\'s own crit ' +
           'unless its statusType carries the DoT or HoT flag (initVars zeroes the chance for those, ' +
           'which is every bleed, burn and poison). A pool dot\'s tick is such a hit too: a non-Raw one ' +
           '(Bonethrow\'s bleed, Spark Hemorrhage) takes the WHOLE context ratio - GameObject.getDamageRatio@4577 ' +
           'is (1 + fervor + mastery) x DamageModifier, so the DamageModifier reaches such a bleed ' +
           'twice, once inside the finished hit the script banked (dmg.amount) and once in the tick\'s ' +
           'own context - and under either rule the ' +
           'target\'s armour on its own pass - the share it banked was already cut once, in the hit - ' +
           'where the three Raw pools take neither. ' +
           'ON THE ACCEPTED 2026-08-11 BUILD the same ops read the status OWNER, and the captures agreed: ' +
           'a foe-worn tick took no bracket and never crit (the Luon Mark, 51 lumps, one integer, no ' +
           'crit), a self-worn Buff took both (the Chaotic Flames aura of Infernal Plunge x1.27, Purging ' +
           'Strikes 11.6% crit). ' +
           'What is READ on this build is the context. What is NOT readable is its consumer: the old ' +
           'client multiplied the hit by the context\'s bracket in ent.Unit.applyEffect@4912, which is a ' +
           'server-only stub now, and the capture probe does not load on this build yet - so no tick has ' +
           'been measured since the change. The context is a SNAPSHOT of the moment the status started: ' +
           'a dot applied inside a Fervor or crit window keeps it for its whole life, which a steady ' +
           'state cannot show and this model prices at the averaged sheet; whether a refresh re-seeds it ' +
           'is unreadable too (Status.refresh@15820 is a stub). ' +
           'WHAT SETTLES IT, on the training Dummy, three readings. (1) One Bonethrow with no damage ' +
           'buff up: the bleed\'s tick total divided by the hit that banked it is 0.4 x (1 + Fervor + ' +
           'PhysicalMastery) x (1 - the Dummy\'s physical reduction after your penetration) under this ' +
           'rule, 0.4 x that reduction term alone under the accepted one, and exactly 0.4 if a pool ' +
           'tick took neither stage; the three separate because the Dummy now authors 40% armour. ' +
           '(With a DamageModifier above 100% on the sheet this rule\'s figure is that much higher ' +
           'again, and repeating the throw under such a buff checks the second copy by itself: the ' +
           'ratio rises by the buff under this rule and does not move under the accepted one.) ' +
           '(2) Pyroball, any rank: a Light Burn tick, compared with what ' +
           'this tool prints for it under --tick-source instigator and --tick-source carrier - the two ' +
           'differ by exactly (1 + Fervor + MagicMastery). If a stat is changed between readings, let ' +
           'the old Light Burn EXPIRE first: a refreshed one may still tick on the first application\'s ' +
           'snapshot and read a false "no change". (3) Fifty Luon Marks at 10% CritChance or more: one ' +
           'critical lump means the instigator\'s crit is live, none (a 0.5% chance if it is) means ' +
           'it is not. The control for all three is a Raw tick - Hemorrhage, or the Finger of ' +
           'Sukuna\'Maatata\'s - which must not move. What DOES move a running tick under either rule ' +
           'is the attacker\'s script hooks (onInflictDamageEval), the mechanism behind the measured ' +
           'Berserk tick jump (Berserk is `hit.dmgMult += vars.damage` in that hook, not a ' +
           'DamageModifier). This model does not replay those hooks on a pool\'s ticks: a rider reaches ' +
           'the bank through the hit it rode, and the averaged DamageModifier every pool tick carries ' +
           'is the banked hit\'s own, put back at its fight average - so a rider up while a pool ticks ' +
           'under-reads. A bleed-crit talent (Exsanguination) is such a hook too, and that one is priced. ' +
           'MEASURED 2026-10-13 (probe v10, build 25782799): Swarm, the poison of Beefury\'s passive - a DoT-typed status ' +
           'worn by the dummy, applied by the Priest - ticked 25.5 on average over 107 ticks with not one critical strike. ' +
           'This rule prices it 25.3; the accepted one (--tick-source carrier) 21.7, short by the Priest\'s whole ' +
           '(1 + Fervor + mastery) bracket, x1.166 in that fight. So the instigator\'s bracket is live on a foe-worn tick, ' +
           'and a DoT-typed one does not roll the instigator\'s 15.6% crit (107 in a row at that chance is one in 10^8). ' +
           'Not settled by it: a pool dot\'s tick (the Warrior measured had no bleed talent), the snapshot question (the ' +
           'sheet did not change inside a tick\'s life), and whether a refresh re-seeds the context.' },
    { severity: 'assumption', what: `a scaling on AllAttributes reads the MEAN of ${mainNames} - read; other players' rows are the size of a mean, and no sheet of theirs is logged`,
      why: 'AllAttributes is a new attribute row that nothing grants: no affix targets it and it has no ' +
           'scaling of its own, so the sheet\'s value for it is 0. It is a SELECTOR. ' +
           'getStepEffectScaling@21777 ops 119-188 test the scaling\'s attribute id against the string ' +
           '"AllAttributes", collect every attribute flagged MainAttribute (the rows named above, read ' +
           'off the flag, which is new in this patch), and add source.atb(a) x ratio / count for each. ' +
           'The row carries no ' +
           'ItemScaling flag, so it takes no weapon or trinket share whatever grants the skill. 19 ' +
           'scaling entries on 13 Infusion skill rows use it and all of them read 0 before. Two of ' +
           'those rows are the Nightling summons\' own attacks: by the pet rule (the scale source is the ' +
           'instigator\'s proxy, the owner) they read YOUR main attributes. Whether an ' +
           'Infusion skill FIRES, and on what clock, is a separate reading; this is only the amount. ' +
           'WHAT SETTLES IT: any Infusion effect\'s tooltip on a character whose main attributes are ' +
           'known - Unstable Bomblets reads 0.25 x their mean before mitigation - with the same caveat ' +
           'as every tooltip, that the client is evaluating the function this was read from; a hit of ' +
           'the same effect on the Dummy, divided by its 40% armour, checks the server. ' +
           'BRACKETED, not measured, by the 2026-10-13 capture. None of the four characters it snapshots ' +
           'wears an Infusion, but eight other players in the log wear Seals of Atonement, whose on-attack ' +
           'row is 0.3 x AllAttributes: it reads 18 to 24 non-critical on seven of them and 31 to 33 on ' +
           'the eighth, on targets from the level-1 training dummy to level-25 monsters. The four ' +
           'snapshotted characters, all level 25, hold main attributes that average 64 to 77 and total 255 ' +
           'to 307: 0.3 x a mean is 19 to 23 before the brackets and the target\'s resistance, 0.3 x a sum ' +
           '77 to 92. So the rows are the size of a mean and a quarter of a sum. INFERRED, and that is ' +
           'why this stays an assumption: no sheet of a wearer is in the log, so nothing rules out eight ' +
           'characters with a quarter of the attributes.' },
    { severity: 'assumption', what: 'a heal or shield scaled on MaxHealth reads YOUR MaxHealth',
      why: 'A row whose first scaling entry is MaxHealth takes its scale source from the HIT TARGET ' +
           '(getStepEffectVal@21774 ops 40-60). For a heal or a shield in a solo fight the target is ' +
           'the caster - Spark Shield\'s step is a Status with target Self and its text says "of your ' +
           '[MaxHealth]", Rage Shield is addStatus(owner, ...) - so those read the caster\'s sheet. ' +
           `For DAMAGE the target is the foe, whose health this model does not carry: the ${census.maxHealthDamage.length} such ` +
           `rows (${census.maxHealthDamage.map((s) => s.id).join(', ')}) are environment and trap damage no build deals, and they stay at zero. A group heal ` +
           'landing on somebody else would read THEIR health, which a solo fight never asks.' },
    { severity: 'assumption', what: 'a hit that sets ignoreResistance takes none of the target\'s armour - read, not measured',
      why: 'Groundswell Strike and Aimed Shot both carry `if (rank >= 2) hit.ignoreResistance = true` in ' +
           'their own onDamageEval, under the rank text "Ignores [Armor].". The field has one reader: ' +
           'getAffinityDamageReduction@4582 ops 8-11 skip the whole resistance loop when it is set, so ' +
           'the pool is 0 before any debuff, ignore rider or penetration could act on it. The ' +
           'affinity\'s flat reductions still apply (none on a reference foe), and so does everything ' +
           'computeDamage@4920 does outside the reduction. Against the default 0.40 boss that is x1.67 ' +
           'on those two skills before penetration. Only this exact shape is read - the write in the ' +
           'skill\'s own onDamageEval, guarded by a rank or a slotted rune and nothing else. ' +
           'WHAT SETTLES IT: the same skill at rank 1 and rank 2 on the Dummy, same sheet; the ratio ' +
           'of the two hits is 1 / (1 - the Dummy\'s physical reduction after your penetration).' },
    { severity: 'assumption', what: 'armour a script takes off ONE named skill\'s hits is priced on that skill - read, not measured',
      why: 'Hidden Power (the Censer\'s passive) writes `hit.magicArmorIgnore = 1` behind `rank >= 2 && ' +
           'hit.skillId == Skill.Staff_Censer_Ultimate` - its rank text "Ignores [MagicArmor]." - and ' +
           'Infernal Plunge writes `hit.armorIgnore = vars.var1` and the magic twin on its own hits ' +
           'from rank 2. getAffinityDamageReduction@4582 scales a magic hit\'s pool by ' +
           '1 - clamp(magicArmorIgnore, 0, 1) at ops 80-95 and a physical one\'s by the armorIgnore ' +
           'twin at ops 133-147, before penetration. The write is read where it sits in the skill\'s ' +
           'own onDamageEval, or in an owner-wide onInflictDamageEval that names the one skill it is ' +
           'for; its guard may ask for a rank and a slotted rune and nothing else. A write this does ' +
           'not answer keeps the armour and is listed as a clause not read (Hiveborn Blossom\'s, ' +
           'behind a script local). Two hooks writing the same field: the larger stands, the order ' +
           'is not read. Against the default 0.40 boss the Ultimate is x1.67 from rank 2. ' +
           'WHAT SETTLES IT: the Censer\'s Ultimate at weapon rank 1 and rank 2 on the Dummy, same ' +
           'sheet; the ratio of the two hits is 1 / (1 - the Dummy\'s magic reduction after your ' +
           'spell penetration).' },
    { severity: 'verified', what: 'displayed damage is the ceiling of the raw float; health loses the float',
      why: 'Read from applyDamage on the 2026-08-11 build (ent.Unit.applyDamage@4914 is a server-only ' +
           'stub since build 25782799 and cannot be re-read): heroes display ceil ' +
           '(Hero.flattenAtbScaling@7829), foes floor, ' +
           'and the HP subtraction uses the un-rounded value. The tooltip renderer ' +
           '(skillEffectValText@21951) dispatches through the same virtual on the live Hero, so a ' +
           'weapon tooltip\'s range endpoints ceil too. Back-inferring from a displayed integer ' +
           'means raw is in (display-1, display]. ' +
           'THE LOG CEILS TOO, and bench verify allows for it: a hero\'s direct hit reaches the capture as a ' +
           'whole number. Checked 2026-10-13 on build 25782799 against lines that do not vary: Judgement\'s ' +
           'finisher priced 229.3 and logged 230, its second strike 144.3 -> 145, its critical strike 352.4 ' +
           '-> 353, and under Worldsplitter\'s +30% 298.1 -> 299 and 187.6 -> 188 - five ceilings, where ' +
           'rounding misses four and flooring all five. A line of 15 a hit reads 3% low against a float ' +
           'model for this reason alone, so a whole-number line is compared with the model plus the ' +
           'ceiling\'s expected half point (verify.mjs INTEGER_STREAM).' },
    { severity: 'verified', what: 'an augment socketed in the ARSENAL weapon grants no skill - its enchant does nothing',
      why: 'st.item.Gear.getSkills@9762 adds the skills of what is socketed in an equipped piece from two loops, and ' +
           'the arsenal weapon passes neither: ops 4-75 run only when the piece\'s equip slot is not the string ' +
           '"Slot_Weapon2", and ops 76-133 only when canGiveSlotSkills(hero) - which ' +
           'st.item.Weapon.canGiveSlotSkills@9839 answers false for hero.secondaryWeapon. An enchant is exactly such a ' +
           'skill (a Passive its formula item grants), so one in the arsenal\'s socket is inert; the stat lines of a ' +
           'socketed augment are affixes, another path, and stay. MEASURED 2026-10-13 (probe v10, build 25782799): a Rogue ' +
           'with Devote in the arsenal daggers and Flaming Weapon in the main-hand pair logged 1,531 Flaming Weapon hits ' +
           'and not one Devote stack in 15,489 damage rows; a Warrior and a Priest with Devote in the main hand logged ' +
           '223 and 326 stack rows. The model had been paying that Rogue five stacks - +30 FervorRating, about 1.4% on ' +
           'every line - and the search had been free to put a second enchant where it does nothing.' },
    { severity: 'verified', what: 'a cooldown-gated passive can carry a finisher bonus and a cooldown its swings shorten - Worldsplitter\'s does',
      why: 'Resilience of the Unkillable Demon King is the "first finisher after each cooldown" shape with two more ' +
           'clauses on the same cooldown, read off its script: onUseSkill adds vars.damage (0.30) to the context of a ' +
           'finisher pressed while the passive is OFF cooldown, and onInflictDamage shortens the cooldown on the first ' +
           'hit of every base attack and finisher - by vars.time (2s) from rank 2 and by vars.dur1 (6s) more on a ' +
           'critical one from rank 3. The finisher that spends it shortens nothing: its script calls consumeCooldown ' +
           'from a wait(0), after that hit\'s reduceCooldown found no cooldown to reduce. The bonus is in the cast\'s ' +
           'context, so a step the finisher\'s own script plays (Brutal Frenzy\'s second strike) copies it. Until the ' +
           '2026-10-13 capture the passive was priced as a heal every 30s and nothing else. MEASURED there (rank 3, two ' +
           'sixty-second chains): its status returns 5.5-7.5s after the finisher that spent it, 14 of 39 finishers found ' +
           'it up, and those log 299 against 230 and 188 against 145 on the second strike - x1.30 both. Only this ' +
           'spelling is read here; Queen\'s Decree (DS_Bladeleaf_Passive) gates a different event on its cooldown and has ' +
           'a reader of its own (the next entry).' },
    { severity: 'verified', what: 'a passive that runs its own cooldown as a clock: Queen\'s Decree adds to the next magic skill\'s damage-ratio bracket, and strikes on your critical hits while the cooldown runs',
      why: 'READ (build 25782799): DS_Bladeleaf_Passive.onUseSkill@44612 - when a weapon, class or signature skill is ' +
           'used (ops 0-12) whose own row holds an effect of a Magic affinity (op 14, canDoMagicDamage@6930: a status ' +
           'the cast applies does not count) and the passive is not on cooldown (ops 16-17), it adds vars.damage (1) ' +
           'to the cast\'s magicDmgMult (ops 18-28) and starts its cooldown (op 29). That field is the cast\'s ' +
           'damage-ratio bracket, seeded by SkillContext.initVars@5241 ops 50-52 with GameObject.getDamageRatio@4577 = (1 + mastery + Fervor) ' +
           'x DamageModifier - so "+100%" is +1 inside that bracket, not x2. Its onInflictDamage plays the Damage ' +
           'step (0.1 x Strength + 0.1 x Intellect, Magic, off the weapon mix) on every critical damage instance of ' +
           'another skill of the owner while the cooldown runs, from rank 3. ' +
           'MEASURED 2026-10-13 (Mage, Fervor 7.476, Cooldown Reduction 4; blocks D-skills-cycle1a/1b/2-3 and ' +
           'D-key-G-adjacent): Static Nova 451 on three presses and 694 on a critical one, priced 450.0 and 693.0 ' +
           '(233.1 without); Spark Beam 151 / 232 a tick priced 150.0 / 231.0 (79 / 122 without, priced 77.7 / 119.7); ' +
           'Demonic Discharge 59 / 90 a bolt on nineteen bolts of twenty, priced 58.4 / 89.9, and 31 on the other ' +
           'one. THAT ONE BOLT, READ AND MEASURED: a logged row\'s hits= is the counter of the context its hit was ' +
           'made on ($DamageResult.__constructor__@15281 ops 42-45 take hit.ctx.hitCount; BaseSkill.onHit@6233 ops ' +
           '1-5 add to it; the one other function that writes a context\'s counter, a projectile\'s hit closure at ' +
           'Projectile.hx:1545, takes one off just before it calls onHit; nothing starts it over), and exactly one bolt of each of the ' +
           'eight Demonic Discharge presses of the capture reads 1 while the others run on one counter - its hit ' +
           'is on a context that had landed nothing. On the four presses that spent the Decree that bolt alone is ' +
           'priced without the bracket: 31, 31 and 48 critical at twenty charges, 58 critical against 68 / 104 at ' +
           'three. INFERRED: that it is the last missile shot, and that the script stopping the cast when the last ' +
           'charge is shot (checkStop: toCast--, then stop(true)) is why it gets a context of its own. It lands ' +
           '20th, 19th and 20th of twenty, and not after the cast - fourteen, twelve and thirteen bracketed bolts ' +
           'land after skill_end on those three presses, one of them after it. What would read it is the function that ' +
           'builds a projectile\'s hit context once the cast\'s own is released, which is not read. ' +
           'The marker status went off inside half a second of 13 of 13 ' +
           'presses of those three skills that found it up and stayed up through 22 presses of Swarmstrike Accord, ' +
           'Summon: Vile Imps, Spark Shield, Mystic Empowerment and Blink; it came back 19.0-19.5s later (20s at ' +
           'rank 2, x0.96), 13.0-13.5s under Mystic Empowerment. The step: 41 rows, one for each of the 40 critical ' +
           'hits of her own landed while the cooldown ran and one on the cast that spent it; 23 plain and 35 critical ' +
           'with no mastery up, priced 22.4 and 34.4; none on 12 critical hits of her imps. ' +
           'NOT MODELLED: the step is priced against the build\'s resting sheet, not the buffs standing at each ' +
           'critical hit; and a conduit\'s volley is a signature-typed use the script might let spend the cooldown - ' +
           'the fight lets only pressed skills.' },
    { severity: 'assumption', what: 'the Raclette Pan\'s stacks are priced as +0.5 CritChance each - and the capture did not see them',
      why: 'Trinket_Kobold_Status is `TAttribute_Flat CritChance 0.5`, ten stacks, applied by every base attack; the ' +
           'model folds +5 CritChance in while the chain is swung. MEASURED 2026-10-13, over every row of the Warrior ' +
           'wearing it: AT TEN STACKS, with Battle Shout down, 62 critical strikes in 385 base-attack and finisher rows, ' +
           '16.1% (+-1.9) - base attacks 46 of 267, finisher rows 16 of 118 (a finisher\'s rows roll apart: 9 of its 28 ' +
           'casts of several rows mix critical and plain) - against ' +
           'a sheet of 16.7% without the trinket and 21.7% with it. That is 2.7 standard deviations under the priced ' +
           'figure and 0.3 under the sheet without it; the rows favour "no effect" about forty to one. Over every ' +
           'stack count with Battle Shout down, 88 of 507 (17.4%); under Battle Shout, whose row is the same ' +
           'attribute at +20, 9 of 26 (34.6%) - that lift does show. The read is kept, by this model\'s rule that a constant ' +
           'is not fitted to one capture, and both numbers are here. WHAT IT COSTS IF THE ROWS ARE RIGHT: five points ' +
           'of chance at a critical multiplier near x1.54 are about 2.5% on every line that can crit, and the ' +
           'default `bench optimize` picks this trinket for the Warrior and for the Rogue. The row\'s text prints ' +
           'the value as "::ref_val1%:: [CritChanceRating]", which fits neither a rating nor half a point cleanly. ' +
           'WHAT SETTLES IT: the character sheet\'s Critical Chance read before a fight and again at ten stacks - ' +
           'one screenshot each, no statistics; failing that, about six hundred more swings at ten stacks.' },
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
           '--swing-floor 0.7 restores the old reading for comparison. The 5% that session was left over its ' +
           'authored round was not explained then; it is what the next entry measures. MEASURED AGAIN ' +
           '2026-10-13, on build 25782799 (a Rogue holding the button on Nibsham\'s Liberators, whose five ' +
           'links author 200 / 310 / 490 / 250 / 600 ms), off the hero\'s own state rows: a link stays in its ' +
           'Skill state 206 / 316 / 496 / 256 / 619 ms in the second session (n 402-635 a link) and 211 / ' +
           '321 / 502 / 255 / 632 ms in the first (n 60) - its authored time and 5 to 12 ms, 19 and 32 for ' +
           'the final combo. No floor on this build either. What the ROUND is longer by is not in the links: ' +
           'the next entry.' },
    { severity: 'assumption', what: 'the links of a chain follow one another with nothing between them - in game a Free state sits before every link, and the round is 5% to 8% longer',
      why: 'The fight starts each link where the last one ended, so a round of the chain is the sum of its ' +
           'links\' authored durations. That is measured FALSE. 2026-10-13 (the same Rogue and weapon, the ' +
           'go_state and skill_end rows): between a link\'s skill_end and the next link\'s Skill state the ' +
           'hero is Free for 10 ms in the second session (median 9, n 2,569) and 17 ms in the first (n 299). ' +
           'Five Skill states and five such gaps ARE the round, to the millisecond: 1,892 + 49 = 1,941 ms ' +
           'from link 1 to link 1 in the second session (n 224; 1,939 in its chain-only blocks, n 150) and ' +
           '1,920 + 84 = 2,005 in the first (n 59), against 1,850 authored - 4.9% and 8.3% over. Every line ' +
           'that rides the chain is over-rated by that much in RATE, none of it per hit. INFERRED, not read: ' +
           'the two sizes follow how far apart the client writes its rows - 8-9 ms in the second session, ' +
           '17-21 ms in the first - which reads as one frame of the sitting at each link\'s end and one ' +
           'before the next; the final combo\'s 19 and 32 ms are not a clean two. That is the machine\'s and ' +
           'the sitting\'s, not the install\'s, so NOTHING IS PRICED FOR IT: a constant here would be this ' +
           'capture\'s. Measured on one weapon on this build (the pre-patch Cheese Moon read 5% over its ' +
           'authored round the same way), not on every class. WHAT WOULD SETTLE IT: the same chain-only ' +
           'block recorded at two frame rates - the gap following the frame time is this reading, and then a ' +
           'frame time the reader states could be priced.' },
    { severity: 'assumption', what: 'RATE against the capture, like for like: the Rogue\'s own rotation reads +4.5% a second on the dummy it fought - its hits -4.1% in size, +9.0% in number',
      why: 'A ledger\'s PER-HIT says nothing about how often a line lands. `bench verify` prints that as well ' +
           '(the capture\'s damage a second over its time in play beside the model\'s, and RATE per line), ' +
           'with the rows held to the instance being fought: a unit is not one target. MEASURED 2026-10-13 ' +
           '(Rogue, sixteen talent steps of three 30 s rotations, against the model\'s own rotation of the ' +
           'same presses over 92 s): the capture dealt 505.7 a second on the dummy it pressed, and 36.5 more ' +
           'on the two beside it - 505 rows of Acidic Splatter and of the curse it rolled, which a model of ' +
           'one target has no line for and a ledger on "Dummy" used to read - against the model\'s 528.5: ' +
           '+4.5%, step by step from +11.8% to -5.8%. At the capture\'s own hit counts the model\'s hits are ' +
           '-4.1% in size and +9.0% in number. BY CAUSE, in rows per 100 s, model / capture. (1) SWINGS: ' +
           'final-combo rows 76.9 / 57.7 (+33%, 14.7 a second), base attacks +2% to +8%, Envenom 82.7 / 75.5 ' +
           '- the capture\'s key cycle stopped 10.7% of its links before their hit where the fight presses ' +
           'between swings, and a round of the chain is 4.9% longer in game than its links\' authored sum ' +
           '(the two entries on those). (2) THE FINISHER\'S POINTS: 16.3 / 12.6 Finishers, at 2.12 points ' +
           'against 4.07 - the hit that much smaller, and it is the points and not the formula that its ' +
           'PER-HIT reads - and Acidic Splatter\'s ticks, rolled on them, 11.0 / 16.7 (-34%, -6.8 a second): ' +
           'Urge to Kill, which the fight does not cast (the entry on the Finisher). (3) WHAT RIDES THOSE: ' +
           'Lethal Poison\'s direct hit 16.4 / 14.0 (+17%, 10.4 a second), its doses laid by the final combo ' +
           'and the Finisher, which both come more often. (4) NOT SEPARATED: three sittings of 30 s cut the ' +
           'tail of every status three times where one fight of 92 s cuts it once, and each sitting opens on ' +
           'what the last left on the dummy (Gaping Wound\'s bleed 22.8 / 20.2 on casts that agree, 6.0 / ' +
           '5.8). The trinket\'s curse, 25.0 / 25.5, and Lethal Poison\'s ticks, 48.9 / 48.0, agree. WHAT ' +
           'WOULD SETTLE THE REST: one sitting of that rotation as long as the model\'s fight, opened on a ' +
           'clean dummy, with Urge to Kill left unpressed.' },
  ];

  return {
    profile, foe, foes: Object.keys(NAMED), namedTargets: NAMED, targetsByUnit, armourIntent, armourSplits,
    // The target side's own reads, for `bench targets` and for anything that
    // has to ask what a unit is: its merged stat rows per mode, its merged
    // flags by name, the modes a target name can carry, the heroic bosses.
    unitStats: (id, heroic = false) => mergedStats(id, heroic),
    unitFlags: (id) => cdb.flagNames('unit', 'flags', mergedFlags(id)),
    // The unit rows that summon this one (the summon graph); empty for a unit
    // nothing summons, and for one only a hero's skill does.
    summonersOf: (id) => [...(summonersOf.get(id) ?? [])],
    // Where Normal difficulty stands a unit, as { lo, hi } - its row, its
    // summoners' rows, or 1 - or null when that is the striker's own level
    // (an archetype base, a hero, a summon no unit row accounts for).
    normalLevelSpan: (id) => {
      if (!units.has(id)) return null;
      const span = levelSpanOf(id);
      return span.striker ? null : { lo: span.lo, hi: span.hi };
    },
    targetModes: Object.keys(MODES), heroicBosses, heroicNamed, heroicAhead, heroicUnjudged,
    // The riders of one row with script flags answered - see `runeDamage`.
    riderDamage: (skillId, rank, runes = null, flags = null) => {
      const s = skills.get(skillId);
      return s ? runeDamage(s, rank, runes, profile(skillId, rank, runes)?.vars ?? s.vars ?? {}, flags) : [];
    },
    castOutput, throughput, survivability, affinityOf, weaponPowerFor, primaryAtbFor,
    primaryBudgetFor, attributeBudgets, itemBudgets, audit,
    // The one pricing of a scaling entry, and the data-derived numbers in it,
    // for the readers that walk raw rows (ui/api.mjs) and for the suite.
    scalingValue, scaling: { itemRatio, attrKeep, weaponPowerKeep, mainAttributes },
    // Whether a `sideEffects.knockBack` entry carries a force - the test the
    // profile's `knockBack` / `knockNoForce` are built with, for the audit's
    // census of the rows that author none.
    knockForce,
  };
}
