// ---------------------------------------------------------------------------
// sim.mjs - a fight, played out second by second.
//
// The model this replaces was a steady state: every cooldown was assumed to be
// pressed exactly on cooldown, the base-attack chain filled whatever fraction
// of the clock was left, and if the cooldowns oversubscribed the clock they
// were all slowed down together to fit. That is a closed form, it is fast, and
// it is wrong in three ways a player would notice:
//
//   * It has no clock, so it cannot spend a BANKED CHARGE. `charges` was read
//     out of the data and then never used, because "(charges - 1) extra casts
//     over the fight" is not a sentence a steady state can say.
//   * It has no priority. When cooldowns oversubscribe, a real player drops the
//     weakest skill; the steady state slowed all of them down, which is the one
//     thing no player does.
//   * It has no memory, so a damage-over-time effect had nowhere to tick and a
//     buff had nowhere to expire. Both were simply absent.
//
// So this plays the fight instead. One decision loop over the timeline, a
// priority order the simulator derives from what each cast is actually worth,
// cooldowns and charges tracked per skill, and statuses that tick and expire.
//
// DETERMINISTIC BY DEFAULT. Procs are folded in at their expected rate, which
// is the mean of the distribution and therefore the number you would converge
// to by averaging - so the default answer is the average, without paying for
// repeated rolls. `fights > 1` rolls them for real with a seeded PRNG and
// reports the mean and the spread, which is the honest way to show how much of
// a build's damage is luck.
// ---------------------------------------------------------------------------

// What the fight is FOR. The derived player model - which skill is worth
// pressing, which of the two played fights is reported - used to maximise
// dps+hps+sps whatever the caller asked, so a dps query on a Priest spent
// GCDs on heals and could keep the branch that healed more and damaged less.
// A single goal weights the objective; a blend keeps everything, because the
// fight cannot see the caller's normalisation.
function goalWeights(goal) {
  return goal === 'dps' ? [1, 0, 0]
    : goal === 'hps' ? [0, 1, 0]
      : goal === 'sps' ? [0, 0, 1]
        : [1, 1, 1];
}

// Reproducibility matters: a build a user shares has to re-derive. Nothing here
// touches Math.random.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * @param spec {
 *   rotation,          // as resolved by skills.mjs
 *   cast(prof),        // -> { damage, heal, shield, singleTargetDamage }
 *   dotOutput(dot),    // -> { damage, heal } for ONE tick of a status
 *   cdr,               // 1 + CooldownReduction/100
 *   fight,             // seconds
 *   fights,            // how many to roll; 1 = deterministic expected value
 *   seed,
 * }
 */
export function simulate(spec) {
  // An AUTHORED rotation is played as authored. `policy` is a function the
  // caller supplies that picks the cast, so the fight stops deriving an order
  // and executes one instead - which is the only way to ask "is THIS rotation
  // better than that one". Playing it against the derived orders as well would
  // answer a different question and quietly report the better of the three.
  if (spec.policy) return runFight({ ...spec, lookahead: 0 });
  // Play it both ways when a lookahead is asked for, and keep the better. See
  // the note above `rolls` for why: the rollout is myopic and can lose to plain
  // priority order, and a model that reports the worse of two rotations it can
  // both execute is reporting a number nobody would play.
  if (spec.lookahead > 0) {
    const greedy = runFight({ ...spec, lookahead: 0 });
    const ahead = runFight(spec);
    // Judged on the caller's goal, not on everything at once - a dps query
    // must never keep the branch that healed more and damaged less.
    const [wd, wh, ws] = goalWeights(spec.goal);
    const total = (r) => r.dps * wd + r.hps * wh + r.sps * ws;
    const best = total(ahead) > total(greedy) + 1e-9 ? ahead : greedy;
    best.rotationSearched = {
      lookahead: spec.lookahead,
      greedy: total(greedy),
      sequenced: total(ahead),
      won: best === ahead ? 'sequenced' : 'greedy',
    };
    return best;
  }
  return runFight(spec);
}

function runFight(spec) {
  const {
    rotation, cast, dotOutput, rollCrit = null, cdr = 1, cdrWeaponSkill = null, fight = 200, fights = 1,
    timedBuffs = [], lookahead = 0, seed = 0x9e3779b9, resources = null,
    poolMultiplier = 1, poolHealShare = 0, critChance = 0, policy = null,
    poolScale = null, poolFactor = null, goal = null, chainResets = true,
    swingVariance = 0, comboWindow = 0.6, empowerments = [], stackProcs = [], markProcs = [],
  } = spec;
  // The objective the derived player maximises - see `goalWeights`.
  const [wDmg, wHeal, wShield] = goalWeights(goal);
  const worth = (dmg, heal, shield) => dmg * wDmg + heal * wHeal + shield * wShield;
  // Every metric here is a total over the fight length, so a non-positive one
  // is a division by zero and a sheet full of NaN. The CLI guards it; the
  // library entry point has to guard it too.
  if (!(fight > 0)) throw new Error(`simulate: fight length must be positive, got ${fight}`);

  // --- live state -----------------------------------------------------------
  // What is up right now, on you and on the target. Everything the fight prices
  // is priced against this, and its `key` is what the pricing cache is keyed on:
  // a fight cycles through a handful of distinct combinations, not hundreds.
  function makeState() {
    return { self: [], target: [], key: '' };
  }
  const rekey = (st) => {
    st.key = st.self.map((b) => b.status).concat(st.target.map((d) => '!' + d.status)).sort().join(',');
    return st;
  };
  const stateOf = (selfUp, targetUp) => rekey({ self: selfUp, target: targetUp, key: '' });

  // --- resource pools -------------------------------------------------------
  // A resource is a second kind of cooldown: instead of waiting for a timer you
  // wait for income. Both halves are in the data and only one of them was ever
  // read - `props.costs` says a cast takes 10 Rage, and `Warrior_Rage`'s script
  // says you make 1 from every attack, combo finisher and weapon skill while
  // `Warrior_InfiniteRage` adds 1 every 3 seconds. So the rate IS derivable, and
  // a skill gated on a pool is no longer "unmodelled" - it is castable exactly
  // as often as the fight can pay for it.
  //
  // Caps come from the sheet (`MaxRage` 20, `MaxComboPoint` 4). A pool starts
  // EMPTY where the attribute is flagged NoAutoFill, which is what Rage,
  // ComboPoint and SpecialEnergy all declare - you walk into a fight with no
  // Rage, and that is worth a cast or two over a short one.
  const pools = new Map();
  for (const [atb, spec] of Object.entries(resources ?? {})) {
    pools.set(atb, {
      max: spec.max ?? Infinity,
      start: spec.start ?? 0,
      value: spec.start ?? 0,
      factor: spec.factor ?? 1,
      gainAtb: spec.gainAtb ?? null,
    });
  }
  const tracked = (atb) => pools.has(atb);
  const canPay = (prof) => (prof.costs ?? []).every((c) => {
    const p = pools.get(c.atb);
    return !p || p.value >= c.amount - 1e-9;
  });
  const pay = (prof, share = 1) => {
    for (const c of prof.costs ?? []) {
      const p = pools.get(c.atb);
      if (p) p.value = Math.max(0, p.value - c.amount * share);
    }
  };
  // What is up right now, for the gain factor below. The fight sets this to
  // its live state as it runs; the rollout deliberately does not - it is a
  // bounded heuristic and keeps the frozen resting factor.
  const stateRef = { now: null };
  const earn = (atb, amount) => {
    const p = pools.get(atb);
    if (!p || !(amount > 0)) return;
    // `attribute.gainAtb` is a multiplier on INCOME, and it is a live stat:
    // `Warrior_BerserkStatus` carries RageGainFactor ARatio +1, so Rage earned
    // inside a Berserk window doubles. Read against what is up when the income
    // arrives, not against the resting sheet the fight started from.
    let f = p.factor;
    if (poolFactor && p.gainAtb && stateRef.now) {
      const live = poolFactor(p.gainAtb, stateRef.now);
      if (live > 0) f = live;
    }
    p.value = Math.min(p.max, p.value + amount * f);
  };
  // What each event pays, pre-bucketed the way the fight raises them. `cast` is
  // keyed BY SKILL, not pooled: a gain whose guard names no event fires when
  // its own skill goes off, so `Warrior_Charge` with Juggernaut pays 5 Rage per
  // Charge - pooling it paid 5 Rage per cast of anything and filled a 20-point
  // bar roughly nine times faster than the game does.
  const income = { attack: [], combo: [], 'weapon-skill': [], time: [] };
  const onCastGain = new Map();
  for (const g of rotation.resources?.gains ?? []) {
    if (!tracked(g.atb)) continue;
    if (g.on === 'time') { income.time.push(g); continue; }
    for (const ev of Array.isArray(g.on) ? g.on : [g.on]) {
      if (ev === 'cast') {
        if (!onCastGain.has(g.from)) onCastGain.set(g.from, []);
        onCastGain.get(g.from).push(g);
      } else if (income[ev]) income[ev].push(g);
    }
  }
  const hasIncome = onCastGain.size > 0 || Object.values(income).some((l) => l.length);

  // --- what the character can press ----------------------------------------
  // A cooldown skill is worth pressing at all only if it emits something. One
  // that does not is not "zero dps in the rotation", it is not in the rotation.
  //
  // A skill that emits NOTHING but puts a debuff up is a different case and it
  // is the one a priority list gets wrong: it is worth exactly what it makes
  // everything else worth. Those are kept, marked, and the lookahead is what
  // decides whether pressing one pays.
  const bare = makeState();
  // A weapon skill's cooldown can run faster than everything else's: `Red
  // Tempo` gives a second back per bleed tick and its own text says "the
  // cooldown of all your [WeaponSkill]s". A single sheet-wide CooldownReduction
  // cannot say that, so the divisor is per skill.
  const isWeaponSkill = (prof) => prof.type === 'WeaponSkill' || prof.type === 'WeaponSubSkill';
  const cdrFor = (prof) => (cdrWeaponSkill != null && isWeaponSkill(prof) ? cdrWeaponSkill : cdr);
  const actives = [];
  for (const { prof, source, applies } of rotation.active) {
    const out = cast(prof, bare);
    const setsUp = (applies?.self?.length ?? 0) + (applies?.target?.length ?? 0);
    // A cast whose entire payload is a DOT is worth pressing even though the
    // cast itself outputs nothing: Swirling Embers deals zero on the press and
    // 0.25x(Dex+Faith) per second for eight seconds after it. The dot fires
    // off this skill's own cast event, so dropping the cast dropped the dot
    // with it - a quarter of the Priest's recorded damage, refused as "nothing
    // gives it a rate" while the rate was its own cooldown.
    const appliesDot = (rotation.dots ?? []).some((d) => d.from === prof.id && d.on === 'cast');
    // Worth nothing TOWARD THE GOAL and sets nothing up: not in this rotation.
    // A dps fight does not spend GCDs on a pure heal; an hps fight does not
    // spend them on a nuke. A buff-applier stays - the lookahead prices it.
    if (!worth(out.damage, out.heal, out.shield) && !setsUp && !appliesDot) continue;
    const cooldown = Math.max(prof.cooldown / cdrFor(prof), 0);
    actives.push({
      prof, source, out, applies,
      cooldown,
      occupancy: Math.max(prof.occupancy, 0.05),
      maxCharges: prof.charges ?? 1,
      // A skill with no cooldown that costs a resource is gated by the POOL,
      // not by a charge. Running it through the charge machinery spends its one
      // charge and then sets the next recovery to Infinity, so it fires once
      // per fight - `Warrior_Rage_Strike` read one cast in 200 seconds when its
      // income supports one every eight.
      poolGated: cooldown <= 0 && (prof.costs ?? []).some((c) => pools.has(c.atb)),
      // The base priority: what a second of your time buys toward the goal,
      // before anything is up. With a lookahead this is only the tiebreak;
      // without one it is the whole player model.
      density: worth(out.damage, out.heal, out.shield) / Math.max(prof.occupancy, 0.05),
      casts: 0, damage: 0, heal: 0, shield: 0,
    });
  }
  actives.sort((a, b) => b.density - a.density);

  // The base-attack chain is one cycle: you cannot press swing 3 without 1 and
  // 2, so it advances a step at a time and wraps.
  const chain = rotation.filler.map(({ prof, applies }) => ({
    prof, applies, occupancy: Math.max(prof.occupancy, 0.05),
  }));
  const chainTime = chain.reduce((s, x) => s + x.occupancy, 0);

  // --- statuses that tick ---------------------------------------------------
  // Every damage-over-time this rotation can apply, with what applies it. A DoT
  // is not scored per cast: it is applied, it ticks, and re-applying it before
  // it expires REFRESHES rather than stacks, so the overflow is lost. That
  // clamp is the whole difference between a 10-second bleed on a 10-second
  // cooldown (100% of it lands) and the same bleed on a 40-second cooldown.
  // A proc-applied DoT is rolled for real when the run repeats, and thinned
  // deterministically when it does not.
  //
  // The thing that is NOT allowed is scaling the tick by the chance. A status's
  // value is uptime-gated, and uptime SATURATES: `Daggers_DuplicatePoison`
  // lands on 20% of swings, but at 1.4 swings a second against a 9-second
  // bleed it is up ~94% of the fight, at full strength. Multiplying the tick by
  // 0.2 instead gave 100% uptime at a fifth of the damage and read 4.6x low -
  // and because the optimiser scores every candidate that way, it undervalued
  // every proc-applied DoT in the search. Thinning the APPLICATIONS converges
  // to the rolled mean; thinning the magnitude cannot.
  const rolled = Math.max(1, fights | 0) > 1;
  // A POOL dot is a share of the damage that triggered it, and because it is
  // `DurationBased` with unlimited stacks nothing is ever lost - every
  // re-application carries the remainder forward. So its total over the fight
  // is exactly `fraction x the damage that fed it`, and the fight can accumulate
  // that instead of tracking individual bleed instances. Hemorrhage is the case:
  // 35% of every physical critical strike, excluding damage from other dots so
  // a bleed cannot feed itself.
  // Its TOTAL needs no schedule, but things ride its ticks - `Cracking Blood`
  // rolls 35% every time the bleed hurts the target - so the fight tracks when
  // it is up and when it ticks even though the damage is settled at the end.
  // Feeding it refreshes its life, which is what a `DurationBased` status does.
  const poolDots = (rotation.dots ?? []).filter((d) => d.pool)
    .map((d) => ({
      ...d, fed: 0, damage: 0, heal: 0, ticks: 0, expires: -1, nextTick: 0,
      // The payout ledger. `DurationBased` redistributes what is still OWED
      // plus the new amount over a fresh window - that is the in-game reading,
      // a second crit two ticks in adds the 35 still owed to the new 35 - so
      // each feed resets the per-tick rate and each tick pays it down. What
      // the bell catches un-paid is the tail a damage meter never saw.
      owed: 0, paid: 0, perTick: 0,
      lifeTicks: d.tick > 0
        ? Math.max(1, Math.round((Number.isFinite(d.duration) ? d.duration : fight) / d.tick))
        : 1,
    }));
  const dots = (rotation.dots ?? []).filter((d) => !d.pool).map((d) => ({
    ...d, out: dotOutput(d, bare), damage: 0, heal: 0, ticks: 0, credit: 0,
  })).filter((d) => d.out.damage || d.out.heal);
  // A status is applied by an EVENT, and which event is read off the guard in
  // front of the `addStatus` call: `Sword_Swarm_Passive` puts its swarm up on
  // every weapon skill you press, not on its own cast - it has no cast. Each
  // bucket below is an event this fight already produces, so nothing here needs
  // a rate the model invented.
  const onCast = new Map();     // applier id -> dots
  const onWeaponSkill = [];
  const onAttack = [];
  const onCombo = [];
  // A dot may be fed by several appliers at once - the same status instance,
  // refreshed and stacked from every channel its build gives it. Each channel
  // is a wrapper around the ONE descriptor, carrying its own chance and its
  // own thinning credit; the dot's identity, tally and stacks stay single.
  const dotChannels = [];
  const channel = (d, on, chance) => {
    const w = { d, chance: chance ?? 1, credit: 0 };
    dotChannels.push(w);
    if (on === 'attack') onAttack.push(w);
    else if (on === 'combo') onCombo.push(w);
    else if (on === 'weapon-skill') onWeaponSkill.push(w);
    else if (on === 'attack-or-combo') { onAttack.push(w); onCombo.push(w); }
    return w;
  };
  for (const d of dots) {
    if (d.on === 'weapon-skill' || d.on === 'attack' || d.on === 'combo' || d.on === 'attack-or-combo') {
      channel(d, d.on, d.chance);
    } else {
      if (!onCast.has(d.from)) onCast.set(d.from, []);
      onCast.get(d.from).push(d);
    }
    for (const c of d.coAppliers ?? []) channel(d, c.on, c.chance);
  }
  const weaponSkillIds = new Set(rotation.active
    .filter((a) => a.prof.type === 'WeaponSkill' || a.prof.type === 'WeaponSubSkill')
    .map((a) => a.prof.id));

  // --- things that fire at you ---------------------------------------------
  // A proc is an event inside the fight, not a rate applied to it afterwards.
  // Handling it in the loop is what lets `fights > 1` roll it for real: with
  // the rate applied afterwards, repeating the fight produced the same answer
  // every time and the spread was always exactly zero.
  const triggers = [];
  for (const tr of rotation.triggered) {
    const out = cast(tr.prof);
    if (!out.damage && !out.heal && !out.shield) continue;
    triggers.push({
      prof: tr.prof, source: tr.source, out, rule: tr.rule,
      // Which event this rides. A follow-up rides its parent's cast, which is
      // neither a swing nor a combo - collapsing every rule to those two put it
      // on the base-attack rate and read it several times too fast.
      on: tr.rule.kind === 'per-parent-cast' ? 'parent'
        : tr.rule.kind === 'per-combo' ? 'combo'
          : tr.rule.kind === 'per-dot-tick' ? 'dot-tick'
            : tr.rule.kind === 'per-weapon-skill' ? 'weapon-skill'
              : tr.rule.kind === 'per-conduit-trigger' ? 'conduit'
                : tr.rule.kind === 'per-attack-or-combo' ? 'attack-or-combo' : 'attack',
      parent: tr.rule.parent ?? null,
      // A crit gate is a rate, not a mystery: the fight already computes a crit
      // expectation for every hit it prices, so a rider that only plays on a
      // critical strike fires that fraction as often.
      chance: (tr.rule.chance ?? 1) / Math.max(1, tr.rule.divisor ?? 1)
        * (tr.rule.critGated ? critChance : 1),
      // A dot-tick rider knows which ticks it rides. `isStatusType(Bleed)` is
      // the pool-dot event only; `isDoT()` and onInflictStatusEval are every
      // tick of everything; `status.kind == Skill.X` is that one status's
      // ticks and no other's - Virulent Magic rides Lethal Poison alone.
      bleedOnly: !!tr.rule.bleedOnly,
      statusFilter: tr.rule.status ?? null,
      // "The first <event> after each cooldown" - Dominion fires its bonus hit
      // on the first combo finisher every 20s. The gate is the authored
      // cooldown; between fires the events pass through untouched.
      gate: tr.rule.cooldownGate ?? 0, nextReady: 0,
      fires: 0, damage: 0, heal: 0, shield: 0,
    });
  }

  // Cooldown mutations: "reset Bonethrow when Tear crits". Resolved to the
  // active they mutate; one whose target is not in the rotation is inert.
  // Deterministic runs thin the applications the way `put` thins a proc dot -
  // a 30%-per-combo reset fires once every ~3.3 combos, never "30% of a
  // reset" - and rolled runs roll.
  const cdMutations = (rotation.cdMutations ?? [])
    .map((m) => ({ ...m, targetIdx: actives.findIndex((a) => a.prof.id === m.target), credit: 0 }))
    .filter((m) => m.targetIdx >= 0);

  // Statuses the fight puts up itself, rather than ones already averaged into
  // the sheet it started from.
  const timedIds = new Set(timedBuffs.map((b) => b.status));
  // How long each one actually lasts, which is NOT always what the buff object
  // reached by `applies.self` says. `timedBuffs` is the resolved list - the one
  // the engine has already extended for a build whose own script adds time back
  // while the status runs (Battle Fury) - and it is a DIFFERENT object from the
  // one the rotation entry carries, because the two are built under different
  // statusesOf keys. Reading the entry's own field is how an extension that was
  // computed correctly changed nothing at all.
  // Only the EXTENDED ones override. The two objects agree on duration in every
  // other case, and preferring the resolved list wholesale would quietly change
  // which of two copies wins wherever they ever disagreed for some other
  // reason - a much wider blast radius than this fix is entitled to.
  const timedDur = new Map(timedBuffs.filter((b) => b.extended).map((b) => [b.status, b.duration]));
  const lifeOf = (b) => {
    const d = timedDur.get(b.status) ?? b.duration;
    return d > 0 ? d : fight;
  };

  /**
   * What the next `lookahead` seconds are worth if you press `pick` now, then
   * fall back to plain priority order.
   *
   * This is where SimulationCraft and this model part company. SimC does no
   * search at all: it walks a human-authored Action Priority List top to bottom
   * and casts the first available entry, and its wiki says so outright - "there
   * is no lookahead or optimization of action orderings". That works because a
   * community writes and tunes the list per specialisation, with conditions
   * like `buff.x.up` and `debuff.y.remains` doing the sequencing by hand.
   *
   * Nobody writes those lists for this game, so the choice is between a greedy
   * order that cannot see a setup cast and a short rollout that can. A rollout
   * it is - bounded, deterministic, and cheap because the pricing cache is keyed
   * on state rather than on time.
   *
   * `pick = -1` means "swing instead", which is how holding a cooldown for a
   * window is expressed.
   */
  function rollout(pick, t0, state0, self0, foe0, live0, chainIdx0 = 0, timeCursors = null) {
    const horizon = Math.min(t0 + lookahead, fight);
    // Cheap copies: the horizon is short and these are all small.
    const cd = state0.map((s) => ({ charges: s.charges, nextCharge: s.nextCharge }));
    // ...including the pools. Without them the rollout believes it can spend a
    // resource it does not have and scores a rotation nobody can play.
    const bank = new Map([...pools].map(([k, p]) => [k, p.value]));
    const affordable = (prof) => (prof.costs ?? []).every((c) => !bank.has(c.atb)
      || bank.get(c.atb) >= c.amount - 1e-9);
    const spend = (prof) => {
      for (const c of prof.costs ?? []) {
        if (bank.has(c.atb)) bank.set(c.atb, Math.max(0, bank.get(c.atb) - c.amount));
      }
    };
    const gain = (atb, amount) => {
      const p = pools.get(atb);
      if (!p || !(amount > 0)) return;
      bank.set(atb, Math.min(p.max, (bank.get(atb) ?? 0) + amount * p.factor));
    };
    const awardTo = (list, isSig) => {
      for (const g of list) {
        if (g.excludeSignature && isSig) continue;
        gain(g.atb, g.amount * (g.chance ?? 1) * (g.critGated ? critChance : 1));
      }
    };
    const self = new Map(self0), foe = new Map(foe0);
    const dotsUp = new Map();
    for (const [d, st] of live0) {
      dotsUp.set(d, {
        expires: st.expires, nextTick: st.nextTick, out: st.out, stacks: st.stacks ?? 1,
      });
    }
    // Income from the clock keeps arriving inside the horizon too - without it
    // the rollout judged a Rage-funded cast unaffordable that the real loop
    // would fund - and the chain continues from where the fight actually IS,
    // not from link 1: which swing comes next decides where the finisher lands.
    const cursors = timeCursors ? timeCursors.map((e) => ({ g: e.g, next: e.next })) : null;
    const advanceClock = (until) => {
      if (!cursors) return;
      for (const e of cursors) {
        while (e.next <= until) { gain(e.g.atb, e.g.amount); e.next += e.g.every; }
      }
    };

    let t = t0, total = 0, idx = chainIdx0, first = true;
    // The lookahead runs the same one-clock rule as the fight. It used to
    // assume any cast reset the chain, which made a setup cast look free.
    let lastSwingEnd = t0;
    let dirty = true, st = null;
    const at = () => {
      for (const [b, e] of self) if (e <= t) { self.delete(b); dirty = true; }
      for (const [d, e] of foe) if (e <= t) { foe.delete(d); dirty = true; }
      if (dirty) { st = stateOf([...self.keys()], [...foe.keys()]); dirty = false; }
      return st;
    };
    const putUp = (applies) => {
      for (const b of applies?.self ?? []) {
        if (timedIds.has(b.status)) { self.set(b, t + lifeOf(b)); dirty = true; }
      }
      for (const d of applies?.target ?? []) { foe.set(d, t + (d.duration > 0 ? d.duration : fight)); dirty = true; }
    };
    // Everything already ticking keeps ticking, at the value it snapshot.
    const tick = (until) => {
      for (const [d, s] of dotsUp) {
        const k = d.scaleByStacks ? s.stacks : 1;
        while (s.nextTick <= Math.min(until, s.expires)) {
          total += worth(s.out.damage * k, s.out.heal * k, 0);
          s.nextTick += d.tick;
        }
        if (s.expires <= until) dotsUp.delete(d);
      }
    };
    const startDots = (skillId) => {
      for (const d of onCast.get(skillId) ?? []) {
        const out = dotOutput(d, st ?? at());
        const e = t + (Number.isFinite(d.duration) ? d.duration : fight);
        const cur = dotsUp.get(d);
        if (cur) {
          cur.expires = e;
          cur.out = out;
          cur.stacks = Math.min(d.stacks ?? 1, (cur.stacks ?? 1) + 1);
        } else dotsUp.set(d, { expires: e, nextTick: t + d.tick, out, stacks: 1 });
      }
    };

    while (t < horizon) {
      at();
      let chose = -1;
      if (first && pick >= 0) chose = pick;
      else if (!(first && pick < 0)) {
        for (let i = 0; i < actives.length; i++) {
          if (cd[i].charges <= 0) continue;
          if (t + actives[i].occupancy > horizon) continue;
          if (!affordable(actives[i].prof)) continue;
          chose = i; break;
        }
      }
      first = false;

      if (chose >= 0) {
        const a = actives[chose];
        if (!a.poolGated) {
          if (cd[chose].charges === a.maxCharges) cd[chose].nextCharge = t + (a.cooldown > 0 ? a.cooldown : Infinity);
          cd[chose].charges--;
        }
        spend(a.prof);
        const out = cast(a.prof, st);
        total += worth(out.damage, out.heal, out.shield);
        for (const g of out.gains ?? []) gain(g.atb, g.amount);
        if (hasIncome) {
          const isSig = a.prof.type === 'SignatureSkill';
          if (weaponSkillIds.has(a.prof.id)) awardTo(income['weapon-skill'], isSig);
          awardTo(onCastGain.get(a.prof.id) ?? [], isSig);
        }
        putUp(a.applies);
        startDots(a.prof.id);
        const end = Math.min(t + a.occupancy, horizon);
        tick(end); advanceClock(end);
        t = end;
      } else if (chain.length) {
        if (chainResets && t - lastSwingEnd > comboWindow) idx = 0;
        const link = chain[idx++ % chain.length];
        const out = cast(link.prof, st);
        total += worth(out.damage, out.heal, out.shield);
        for (const g of out.gains ?? []) gain(g.atb, g.amount);
        if (hasIncome) awardTo(link.prof.isCombo ? income.combo : income.attack, false);
        putUp(link.applies);
        startDots(link.prof.id);
        const end = Math.min(t + link.occupancy, horizon);
        tick(end); advanceClock(end);
        t = end;
        lastSwingEnd = end;
      } else {
        tick(horizon); advanceClock(horizon);
        break;
      }
      for (let i = 0; i < actives.length; i++) {
        while (cd[i].charges < actives[i].maxCharges && cd[i].nextCharge <= t) {
          cd[i].charges++;
          cd[i].nextCharge += actives[i].cooldown > 0 ? actives[i].cooldown : Infinity;
        }
      }
    }
    tick(horizon);
    return total;
  }

  function runOne(rand) {
    // Crit is a die like any other, and until this it was the one die the
    // repeated fight did not throw: procs rolled, the ±10% swing band rolled,
    // and crit stayed at its expectation - so a build whose entire damage
    // profile is "did the crit land" reported a spread of essentially zero.
    // `rollCrit` re-rolls one cast's crits without disturbing its mean, so the
    // deterministic answer is untouched and only the SPREAD changes.
    //
    // The pricing cache in damage.mjs is keyed on state, so the roll has to
    // happen here rather than inside `cast` - a cached roll is the same roll
    // every time, which is how a die stops being one.
    const hit = rand && rollCrit ? (prof, st) => rollCrit(cast(prof, st), rand) : cast;
    for (const a of actives) { a.casts = 0; a.hits = 0; a.damage = 0; a.heal = 0; a.shield = 0; }
    for (const d of dots) { d.damage = 0; d.heal = 0; d.ticks = 0; d.credit = 0; }
    for (const w of dotChannels) w.credit = 0;
    for (const g of triggers) { g.fires = 0; g.damage = 0; g.heal = 0; g.shield = 0; g.nextReady = 0; }
    for (const mu of cdMutations) { mu.credit = 0; mu.bank = 0; }
    for (const p of poolDots) {
      p.fed = 0; p.damage = 0; p.heal = 0; p.ticks = 0; p.expires = -1; p.nextTick = 0;
      p.owed = 0; p.paid = 0; p.perTick = 0;
    }

    // A skill opens the fight with its full bank of charges - that is exactly
    // what a charge is - and regains one per cooldown thereafter.
    const state = actives.map((a) => ({ charges: a.maxCharges, nextCharge: a.cooldown }));
    const live = new Map();   // dot -> { expires, nextTick, out }
    const upSelf = new Map(); // buff -> expires
    const upFoe = new Map();  // debuff -> expires
    let t = 0;
    let chainIndex = 0;
    // The end of the last COMPLETED basic attack. The chain clock runs from
    // here to the start of the next one, and nothing else refreshes it.
    let lastSwingEnd = -Infinity;

    // A NEXT-CAST REGISTER, carried as the PROBABILITY that it is armed rather
    // than as a coin - the same convention crit already uses, whose binomial
    // mean is the deterministic number. A finisher arms it with probability
    // `chance` and a proc that lands while it is already armed is WASTED, so
    // the update is `p += (1 - p) * chance` and never saturates past 1.
    //
    // Spending it is ONE event, not two. The cost check runs at press and the
    // forced-crit check at damage eval, which looks like it should let a second
    // press slip in free while the first cast is still running - but
    // `GameObject.doUseSkill@4576` op 2 calls `stopActiveSkill@4580` as its
    // FIRST action, and that is `BaseSkill.stop@6093` on the running skill,
    // which runs `onStop` and removes the status before the new cast evaluates
    // anything. Pressing again cannot outrun its own stop. Queueing cannot
    // either: a queued press resolves when the current cast ENDS, which is the
    // same removal. So one arm buys exactly one free critical cast.
    const emp = new Map();   // skill id -> { chance, p }
    // A register the COMBO FINISHER itself consumes, re-armed by a cast
    // counter rather than by the finisher: HighVoltage's status forces the
    // next finisher critical and is planted on every mage chain cast, which
    // the Chaincast talent raises every `armEveryActiveCasts` active casts.
    const comboRegs = [];
    for (const e of empowerments ?? []) {
      if (e.consume === 'combo') {
        comboRegs.push({
          chance: e.chance, every: e.armEveryActiveCasts ?? 0,
          firesConduits: !!e.firesConduits, p: 0,
        });
      } else emp.set(e.skill, { chance: e.chance, p: 0 });
    }
    const armAll = () => { for (const r of emp.values()) r.p += (1 - r.p) * r.chance; };
    let activeCasts = 0;
    let swings = 0, combos = 0, busy = 0, fillerTime = 0;
    // Non-DoT physical damage EVENTS, which is what a stack counter arms on.
    let physicalHits = 0;

    // The state everything is priced against, rebuilt only when it changes.
    let now = bare;
    stateRef.now = bare;
    let stateDirty = false;
    const refresh = (at) => {
      for (const [b, exp] of upSelf) if (exp <= at) { upSelf.delete(b); stateDirty = true; }
      for (const [d, exp] of upFoe) if (exp <= at) { upFoe.delete(d); stateDirty = true; }
      if (stateDirty) { now = stateOf([...upSelf.keys()], [...upFoe.keys()]); stateDirty = false; stateRef.now = now; }
      return now;
    };
    // What a cast puts up. Only the TIMED buffs: the permanent ones are already
    // in the sheet the fight started from, and applying them again would count
    // them twice.
    const setUp = (applies, at) => {
      for (const b of applies?.self ?? []) {
        if (!timedIds.has(b.status)) continue;
        upSelf.set(b, at + lifeOf(b));
        stateDirty = true;
      }
      for (const d of applies?.target ?? []) {
        upFoe.set(d, at + (d.duration > 0 ? d.duration : fight));
        stateDirty = true;
      }
    };

    // Income that comes from the clock rather than from an event -
    // `Warrior_InfiniteRage`'s 1 Rage every 3 seconds. Reset per run, and
    // advanced wherever the clock is.
    for (const p of pools.values()) p.value = p.start;
    const timeIncome = income.time.map((g) => ({ g, next: g.every }));
    const advanceIncome = (until) => {
      for (const e of timeIncome) {
        while (e.next <= until) { earn(e.g.atb, e.g.amount); e.next += e.g.every; }
      }
    };


    // Feed the pool dots from what this cast landed. WHO may feed a pool is
    // the hook's rule, read in skills.mjs: an `onInflictDamage` pool eats the
    // whole rotation's matching damage (Hemorrhage), an `own` pool only its
    // own skill's (Bonethrow). WHICH slice is the guard's rule: a crit-guarded
    // pool takes the crit share, an unguarded one takes everything. Feeding
    // also (re)applies the dot - starting and refreshing its tick schedule -
    // and banks the amount into the ledger the ticks pay down.
    const feedPools = (out, at, fromId, scale = 1) => {
      for (const p of poolDots) {
        if (p.pool.own && p.from !== fromId) continue;
        // A weapon-skill-scoped pool eats weapon-skill hits ONLY - the guard
        // is `dmg.isWeaponSkill`, which is skill type 7 exactly - so swings,
        // finishers and class casts must not feed it. Demondash's Burn was
        // fed from the whole rotation, an overcount that happened to cancel
        // its under-read fraction until a better arsenal moved the two apart.
        // A script rider's `host#step` id feeds as its host: the duplicate
        // hits are the weapon skill's own damage in the game's eyes.
        if (p.pool.weaponSkill) {
          const host = fromId?.includes('#') ? fromId.slice(0, fromId.indexOf('#')) : fromId;
          if (!weaponSkillIds.has(host)) continue;
        }
        const src = scale * (p.pool.crit
          ? (p.pool.magic ? (out.critMagic ?? 0)
            : p.pool.physical ? (out.critPhysical ?? 0)
              : (out.critPhysical ?? 0) + (out.critMagic ?? 0))
          : (p.pool.magic ? (out.totalMagic ?? 0)
            : p.pool.physical ? (out.totalPhysical ?? 0)
              : (out.totalPhysical ?? 0) + (out.totalMagic ?? 0)));
        if (!(src > 0)) continue;
        p.fed += src;
        p.owed += src;
        p.perTick = p.owed / p.lifeTicks;
        // The loop RESTARTS on every application, not only on expiry: the
        // live lattice shows a 2s-tick status silent through sub-2s spam and
        // each tick landing ~1.9s after the last feed - the refresh resets
        // the clock (dur=6;refresh_dur=6 on every status_on). But only where
        // the SIM's feeds are discrete events too: a crit-gated pool is fed
        // the EXPECTED crit share of every swing - a continuous smear where
        // the game feeds one event per actual crit - and resetting on the
        // smear stalls the clock forever. Discrete live, discrete in the sim:
        // reset. Smeared in the sim: expiry-anchored, as before.
        if (p.pool.crit) {
          if (p.expires <= at) p.nextTick = at + p.tick;
        } else {
          p.nextTick = at + p.tick;
        }
        // max(new window, remaining) - a refresh never shortens the status
        // (Status.refresh@14446).
        p.expires = Math.max(p.expires, at + (Number.isFinite(p.duration) ? p.duration : fight));
      }
    };

    // Advance every live status up to `until`, crediting each tick that lands.
    // A DoT ticks at the value it SNAPSHOT when it was applied, not at the
    // current one - that is SimulationCraft's convention and the one this model
    // follows, and it is why `out` is stored per instance rather than read off
    // the dot.
    const tickTo = (until) => {
      for (const [d, st] of live) {
        while (st.nextTick <= Math.min(until, st.expires) && st.nextTick <= fight) {
          // THE STACK COUNT IS LIVE, not snapshot. `getStackFactor@20772` reads
          // `Status.stacks` at every tick, downstream of everything else the
          // value went through - so the per-tick amount is the snapshot times
          // however many stacks are on the target RIGHT NOW. The value snapshots;
          // the multiplier does not.
          const k = d.scaleByStacks ? st.stacks : 1;
          // The count-scaled companion rider (Gash): +x per OTHER status the
          // owner has on the wearer AT TICK TIME. The count is this fight's
          // own live state - every other running dot plus every debuff window
          // still open - which undercounts multi-instance statuses (the live
          // decode reached k=7 with stacked Burn instances; this map holds
          // one entry per descriptor) and marks, and says so here rather
          // than inflating the ratio to compensate.
          let om = 1;
          if (d.perOtherStatus) {
            let others = 0;
            for (const [od, os] of live) if (od !== d && os.expires > st.nextTick) others++;
            for (const exp of upFoe.values()) if (exp > st.nextTick) others++;
            om = 1 + d.perOtherStatus * others;
          }
          d.damage += st.out.damage * k * om;
          d.heal += st.out.heal * k;
          d.ticks++;
          // A regular dot's tick is an event too. Riders that asked for a
          // bleed skip these - `fireDotTick` filters - but an any-dot or
          // status-filtered rider fires here, which is where Virulent Magic
          // lives: on Lethal Poison's own ticks.
          fireDotTick(d.status, false, k);
          st.nextTick += d.tick;
        }
        if (st.expires <= until) live.delete(d);
      }
      // A pool dot's own ticks. Each one pays down the ledger - so the tail
      // still owed when the bell goes is dropped, exactly what a damage meter
      // would have missed - and each is an EVENT: a proc guarded on
      // `isStatusType(Bleed)` rides it rather than riding a swing.
      for (const p of poolDots) {
        if (!(p.tick > 0)) continue;
        while (p.nextTick <= Math.min(until, p.expires) && p.nextTick <= fight) {
          const pay = Math.min(p.owed, p.perTick);
          // A tick that pays nothing is not a tick: the live log records no
          // row for an empty bank, and counting one diluted the per-hit mean
          // the ledger prints.
          if (pay > 0) {
            p.ticks++;
            p.paid += pay;
            p.owed -= pay;
            fireDotTick(p.status ?? null, true);
          }
          p.nextTick += p.tick;
        }
      }
    };
    // THE CONDUIT GAUGE. A conduit fires when Spark is SPENT while the pool
    // BEFORE the spend was strictly above the threshold - all three tiers of
    // `Mage_Conduit_SparkBounds` are 0.5, so it is all-or-nothing - and when it
    // fires, EVERY equipped conduit fires at once.
    //
    // This is why "one trigger per weapon skill" would have been badly wrong.
    // In-combat Spark income is 0.65/s against roughly 5/s of spend, so a full
    // pool buys a handful of triggers at the start of a fight and then the
    // gauge sits under the threshold for the rest of it. Measured in game: five
    // triggers from a full 100, and the sixth spend starts at exactly 50, which
    // is not strictly above it.
    const gauge = spec.sparkGauge ?? null;
    const gaugePool = gauge ? pools.get(gauge.atb) : null;
    const conduitTriggers = triggers.filter((g) => g.on === 'conduit');
    const fireConduits = (at) => {
      for (const g of conduitTriggers) {
        const out = hit(g.prof, now);
        g.fires += 1;
        g.damage += out.damage;
        g.heal += out.heal;
        g.shield += out.shield;
      }
    };
    /** Spend, then fire if the pool was above the gauge BEFORE the spend. */
    const spendAndGauge = (amount, at) => {
      if (!gaugePool || !(amount > 0)) return;
      const before = gaugePool.value;
      gaugePool.value = Math.max(0, before - amount);
      if (conduitTriggers.length && gaugePool.max > 0
        && before / gaugePool.max > gauge.ratio + 1e-12) fireConduits(at);
    };

    // What a tick sets off. Deterministic runs credit the expected fraction of
    // a fire, rolled ones roll - the same treatment every other proc gets, and
    // priced against whatever is up at the time.
    //
    // Which tick matters. A bleed-gated rider (isStatusType(Bleed)) rides pool
    // dots only, which was all any dot-tick rider could do until the poison
    // family arrived; an any-dot rider (isDoT, onInflictStatusEval) rides every
    // tick of every status; a status-filtered one rides exactly the status its
    // script named.
    const fireDotTick = (statusId = null, isPool = true, stacks = 1) => {
      for (const g of triggers) {
        if (g.on !== 'dot-tick') continue;
        if (g.bleedOnly && !isPool) continue;
        if (g.statusFilter && g.statusFilter !== statusId) continue;
        // A stacked dot's tick raises onInflictStatusEval once PER STACK, not
        // once per logged row: Virulent Magic recorded exactly five procs per
        // Lethal Poison tick at five stacks, against the model's one. Applied
        // only to riders that NAME their status - the per-stack evidence is
        // exactly there, and widening it to every any-dot rider without its
        // own measurement would be the flattering guess this file refuses.
        const mult = g.statusFilter && !isPool ? Math.max(1, stacks) : 1;
        let share = (rand ? (rand() < g.chance ? 1 : 0) : g.chance) * mult;
        if (!share) continue;
        const out = hit(g.prof, now);
        g.fires += share;
        g.damage += out.damage * share;
        g.heal += out.heal * share;
        g.shield += out.shield * share;
      }
    };

    const put = (list, at) => {
      for (const entry of list) {
        // A channel wrapper carries its own chance and its own thinning
        // credit; the descriptor underneath is shared, so every channel feeds
        // the SAME live status instance - which is the whole point.
        const d = entry.d ?? entry;
        const p = entry.chance ?? d.chance ?? 1;
        if (p < 1) {
          if (rand) {
            if (rand() >= p) continue;
          } else {
            // Deterministic thinning: let one application through every 1/p
            // events, which reproduces the same mean gap between applications
            // as the roll does without sampling.
            entry.credit += p;
            if (entry.credit < 1) continue;
            entry.credit -= 1;
          }
        }
        const st = live.get(d);
        const expires = at + (Number.isFinite(d.duration) ? d.duration : fight);
        // Snapshot at application, from whatever is up right now.
        let out = dotOutput(d, now);
        // How a re-application composes is AUTHORED, in
        // `props.status.stackingPolicy`. Absent, or `Override`, and it refreshes:
        // the overflow of what was already running is lost, which is the whole
        // difference between a 10-second bleed on a 10-second cooldown and the
        // same bleed on a 40-second one.
        //
        // `DurationBased` CARRIES THE REMAINDER, and that is on record from the
        // game: a 200 crit banks 70 damage over 8s (four ticks of 17.5), and a
        // second crit for 100 two ticks later ADDS the 35 still owed to the new
        // 35, redistributing 70 over a fresh 8s. Four statuses declare it, all
        // of them ticking. Reading it off the column rather than guessing from
        // "is the declared amount a total" is what keeps it to those four -
        // the guess matched nearly every dot in the game, including ones
        // applied on every swing, and took the answer to 44,000 dps.
        if (st) {
          // One more stack, up to the cap. Read from `addStacks@4562`: the
          // count carried forward is the current one, EXCEPT under
          // `DurationBased`, where it is `ceil(stacks x durationProgress)` -
          // sampled at the moment of application and never continuously, which
          // is why a stack table needs no per-tick decay. Nothing anywhere
          // decrements a stack on a timer; the whole status expires at once.
          //
          // Every data-driven application is exactly ONE stack:
          // `props.status.stacks` is authored on none of the 100 Status steps,
          // so `?? 1` at SkillStep.hx:262 is what every one of them uses.
          const carried = d.stacking === 'DurationBased'
            ? Math.ceil(st.stacks * Math.max(0, (st.expires - at) / Math.max(1e-9, st.window)))
            : st.stacks;
          st.stacks = Math.min(d.stacks ?? 1, carried + 1);
          st.window = Math.max(expires, st.expires) - at;
          if (d.stacking === 'DurationBased') {
            const ticks = Math.max(1, Math.round(
              (Number.isFinite(d.duration) ? d.duration : fight) / d.tick));
            const left = Math.max(0, Math.min(ticks, Math.ceil((st.expires - at) / d.tick - 1e-9)));
            out = {
              damage: out.damage + (st.out.damage * left) / ticks,
              heal: out.heal + (st.out.heal * left) / ticks,
            };
          }
          // Status.refresh@14446: the window is max(new duration, what was
          // left) - a refresh never SHORTENS a status.
          st.expires = Math.max(expires, st.expires);
          st.out = out;
        } else {
          live.set(d, {
            expires, nextTick: at + d.tick, out,
            // A fresh status lands at one stack: `Status.__constructor__` never
            // sets the field, so `addStacks(1)` takes it from 0 to 1.
            stacks: 1,
            // The window a DurationBased carry-over is measured against.
            window: expires - at,
          });
        }
      }
    };
    const applyDots = (skillId, at, ev = {}) => {
      const { weaponSkill = false, attack = false, combo = false, cast: wasCast = false } = ev;
      put(onCast.get(skillId) ?? [], at);
      if (weaponSkill) put(onWeaponSkill, at);
      if (attack) put(onAttack, at);
      if (combo) put(onCombo, at);
      // Resources ride the same events. `excludeSignature` is the Warrior's own
      // rule: a signature skill does not generate the Rage it spends.
      if (hasIncome) {
        const isSig = ev.signature === true;
        const award = (list) => {
          for (const g of list) {
            if (g.excludeSignature && isSig) continue;
            // A crit-gated gain pays on the fraction of hits that crit.
            earn(g.atb, g.amount * (g.chance ?? 1) * (g.critGated ? critChance : 1));
          }
        };
        if (weaponSkill) award(income['weapon-skill']);
        if (attack) award(income.attack);
        if (combo) award(income.combo);
        if (wasCast) award(onCastGain.get(skillId) ?? []);
      }
      // Cooldown riders fire off the same events - the value of "reset
      // Bonethrow when Tear crits" IS the extra casts the reset buys.
      for (const mu of cdMutations) {
        // Bank a mark whenever a supplier lands a cast; a supply-gated reset
        // spends one, and without one it simply does not fire. Ungated, the
        // dash pressed at three times the rate its marks could arrive.
        if (mu.supply && wasCast && mu.supply.includes(skillId)) mu.bank++;
        const hit = mu.on === 'host' ? (skillId === mu.host)
          : mu.on === 'attack' ? attack
            : mu.on === 'combo' ? combo
              : mu.on === 'attack-or-combo' ? (attack || combo)
                : weaponSkill;
        if (!hit) continue;
        const p = mu.chance * (mu.critGated ? critChance : 1);
        if (!(p > 0)) continue;
        let fire = false;
        if (rand) fire = rand() < p;
        else { mu.credit += p; if (mu.credit >= 1) { mu.credit -= 1; fire = true; } }
        if (!fire) continue;
        if (mu.supply) { if (mu.bank <= 0) continue; mu.bank--; }
        const stT = state[mu.targetIdx];
        const aT = actives[mu.targetIdx];
        if (stT.charges >= aT.maxCharges) continue;   // nothing to give back
        if (mu.kind === 'reset') {
          if (stT.nextCharge > at) stT.nextCharge = at;
        } else {
          stT.nextCharge -= mu.seconds;
        }
      }
      // Procs ride the same events. Deterministic runs credit the expected
      // fraction of a fire; rolled ones roll. Priced against live state too.
      for (const g of triggers) {
        // A dot-tick proc is raised by `tickTo`, not by a cast or a swing.
        const fires = g.on === 'dot-tick' || g.on === 'conduit' ? false
          : g.on === 'parent' ? (wasCast && g.parent === skillId)
            : g.on === 'weapon-skill' ? weaponSkill
              : g.on === 'attack-or-combo' ? (attack || combo)
                : g.on === 'attack' ? attack : combo;
        if (!fires) continue;
        if (g.gate > 0) {
          if (at < g.nextReady) continue;
          g.nextReady = at + g.gate;
        }
        const share = rand ? (rand() < g.chance ? 1 : 0) : g.chance;
        if (!share) continue;
        const out = hit(g.prof, now);
        g.fires += share;
        g.damage += out.damage * share;
        g.heal += out.heal * share;
        g.shield += out.shield * share;
        // NOTE deliberately absent: a status a TRIGGER applies. No triggered
        // entry ships an `applies` today, and wiring one through casually
        // would hand a 10%-per-hit proc buff ~100% uptime in deterministic
        // mode (the damage is chance-scaled; an application is not). When the
        // data grows one, thin the applications like `put` does - never put
        // the buff up on every eligible event.
      }
    };

    while (t < fight) {
      // Recharge anything whose timer has come round.
      for (let i = 0; i < actives.length; i++) {
        const a = actives[i], st = state[i];
        while (st.charges < a.maxCharges && st.nextCharge <= t) {
          st.charges++;
          st.nextCharge += a.cooldown > 0 ? a.cooldown : Infinity;
        }
      }

      refresh(t);

      // Which casts are ready and still fit before the bell. "Ready" now means
      // the charge is back AND the pool can pay for it.
      const ready = [];
      for (let i = 0; i < actives.length; i++) {
        if (state[i].charges <= 0) continue;
        if (t + actives[i].occupancy > fight) continue;
        if (!canPay(actives[i].prof)) continue;
        ready.push(i);
      }

      // Pick one. Without a lookahead this is the priority order, which is what
      // a first-available list does. With one, each candidate is scored by what
      // the next `lookahead` seconds are worth if you press it - which is the
      // only way a cast that emits nothing itself can win, and the only way
      // holding a cooldown for a window can beat spending it now.
      let pressed = -1;
      if (policy) {
        // An authored order. The policy sees exactly what a player can: what is
        // ready, what is up on them and on the target, what is in the pools,
        // and how long until anything else comes back. It returns an index into
        // `actives`, or -1 for "swing and keep them".
        pressed = policy({
          ready,
          actives,
          t,
          buffs: upSelf,
          debuffs: upFoe,
          pools,
          charges: (i) => state[i].charges,
          remains: (i) => Math.max(0, state[i].nextCharge - t),
        });
        if (pressed >= 0 && !ready.includes(pressed)) pressed = -1;
      } else if (ready.length === 1 || (!lookahead && ready.length)) {
        pressed = ready[0];
      } else if (ready.length) {
        let best = -Infinity;
        for (const i of ready) {
          const v = rollout(i, t, state, upSelf, upFoe, live, chainIndex, timeIncome);
          if (v > best + 1e-9) { best = v; pressed = i; }
        }
        // Waiting is a move. If every ready cast is worth less over the horizon
        // than swinging and saving them, swing - that is what "do not spend both
        // weapon skills inside one window" looks like from the inside.
        if (chain.length && rollout(-1, t, state, upSelf, upFoe, live, chainIndex, timeIncome) > best + 1e-9) pressed = -1;
      }

      if (pressed >= 0) {
        const a = actives[pressed], st = state[pressed];
        if (!a.poolGated) {
          if (st.charges === a.maxCharges) st.nextCharge = t + (a.cooldown > 0 ? a.cooldown : Infinity);
          st.charges--;
        }
        // Pay BEFORE the cast pays you, so a skill can never fund itself out of
        // its own gain in the same instant.
        const sparkBefore = gaugePool ? gaugePool.value : 0;
        const sparkCost = gaugePool
          ? (a.prof.costs ?? []).reduce((s, c) => (c.atb === gauge.atb ? s + c.amount : s), 0) : 0;
        // An armed register makes this cast free with probability p, so the
        // expected spend is `cost x (1 - p)`.
        const reg = emp.get(a.prof.id);
        pay(a.prof, reg ? 1 - reg.p : 1);
        if (sparkCost > 0 && conduitTriggers.length && gaugePool.max > 0
          && sparkBefore / gaugePool.max > gauge.ratio + 1e-12) fireConduits(t);
        // ...and a GUARANTEED critical strike with the same probability. The
        // cast decomposes as `fixed + base x (1 + p(cd-1))`, so lifting the
        // effective crit chance to `p + (1-p) x base` is exactly what a forced
        // crit is worth in expectation. Spending clears the register whether or
        // not it was armed - the status is one-shot either way.
        let out = hit(a.prof, now);
        if (reg && reg.p > 0 && out.critRoll) {
          // The cast already decomposes as `fixed + base x (1 + p(cd-1))`, so a
          // guaranteed crit is that same expression at p = 1 and needs no
          // second pricing. Blending at the register's probability gives
          // `(1-p) x rolled + p x forced`, and the pool feed follows the same
          // die - Hemorrhage takes a share of physical CRITICAL damage, so a
          // forced crit feeds it too.
          const cr = out.critRoll;
          const forced = cr.fixed + cr.base * cr.cd;
          out = {
            ...out,
            damage: out.damage * (1 - reg.p) + forced * reg.p,
            critRoll: { ...cr, p: reg.p + (1 - reg.p) * cr.p },
          };
        }
        if (reg) reg.p = 0;   // one-shot, spent whether or not it was armed
        // Every ACTIVE cast advances the chain counter; each `every`-th one
        // raises a chain cast, which re-plants the combo registers.
        if (comboRegs.length) {
          activeCasts++;
          for (const r of comboRegs) {
            if (r.every > 0 && activeCasts % r.every === 0) {
              r.p += (1 - r.p) * r.chance;
              // The chain cast raising this arm also force-fires every
              // equipped conduit (Chaincast's own onMageChainCast).
              if (r.firesConduits && conduitTriggers.length) fireConduits(t);
            }
          }
        }
        a.casts++;
        a.hits = (a.hits ?? 0) + (out.hits ?? 0);
        physicalHits += out.hitsPhysical ?? 0;
        a.damage += out.damage;
        a.heal += out.heal;
        a.shield += out.shield;
        // A GainAtb effect on the skill itself - Warrior_SurgingForce returns
        // Rage, Mage_RayOfSpark returns a share of MaxSpark - which is authored
        // in ordinary columns and needs the sheet, so it arrives with the cast.
        for (const g of out.gains ?? []) earn(g.atb, g.amount);
        feedPools(out, t, a.prof.id);
        setUp(a.applies, t);
        applyDots(a.prof.id, t, {
          cast: true,
          weaponSkill: weaponSkillIds.has(a.prof.id),
          signature: a.prof.type === 'SignatureSkill',
        });
        const end = t + a.occupancy;
        tickTo(end); advanceIncome(end);
        busy += a.occupancy;
        t = end;
        continue;
      }

      // ONE CUMULATIVE CLOCK, from the END of the last completed basic to the
      // START of the next. `Hero.update@7495` / `isWithinAttackCombo@7459` keep
      // a single timestamp and never refresh it on a skill's end, so casts,
      // idle, and RUNS of short casts all break the chain by the same measure.
      // The model used to ask two separate questions - is THIS cast longer than
      // the window, did I stand still longer than the window - and neither sees
      // two 0.4s Rage Strikes back to back, which break the chain in game.
      //
      // The v2 capture predicts 52/52 basic-chain casts on this rule. Literal
      // start-to-start scores 18/52; a banked finisher scores 50/52 and both
      // its misses are mid-chain links surviving casts, which banking cannot
      // produce. The anchor is the double-Rage-Strike reset: a basic pressed
      // 13ms after the second one ended still reset, because 854ms had passed
      // since the last BASIC's end. Measured bracket [597, 854)ms contains the
      // authored 600.
      if (chainResets && t - lastSwingEnd > comboWindow) chainIndex = 0;

      // Nothing to press: swing. One step of the chain at a time, so the combo
      // finisher only ever lands after the swings that lead to it.
      const link = chain.length ? chain[chainIndex % chain.length] : null;
      if (!link || t + link.occupancy > fight) {
        // No filler, or no room for the next swing: stand there until the next
        // cooldown comes back, and let the statuses keep ticking. Breaking out
        // here instead would end the fight early and divide the damage by a
        // shorter clock - which is how a build with NO MAIN-HAND WEAPON came
        // out ahead of one holding a sword.
        let next = fight;
        for (let i = 0; i < actives.length; i++) {
          if (state[i].charges > 0) continue;
          if (state[i].nextCharge > t && state[i].nextCharge < next) next = state[i].nextCharge;
        }
        // A cast blocked only by its POOL comes back when income does, not
        // when a timer does. A pool-gated skill never spends a charge, so the
        // scan above never wakes for it - and a build with no filler slept to
        // the bell on a full bank of Rage income. Wake at the next time-income
        // event and re-ask; each step is strictly forward, so this cannot spin.
        if (timeIncome.length && actives.some((a, i) => state[i].charges > 0
          && t + a.occupancy <= fight && !canPay(a.prof))) {
          for (const e of timeIncome) if (e.next > t && e.next < next) next = e.next;
        }
        if (!(next > t)) next = fight;
        const stood = next - t;
        tickTo(next); advanceIncome(next);
        t = next;
        continue;
      }
      chainIndex++;
      if (link.prof.isCombo) combos++; else swings++;
      // The finisher arms every register the build carries. `isFinalAttack@6047`
      // is `inf.type == 4` (AttackCombo), which is exactly `isCombo` here.
      if (link.prof.isCombo && emp.size) armAll();
      // The finisher's flat Spark cost. The chain is NOT gated on it - a Mage
      // with an empty pool keeps swinging, which is what the game does - but
      // the spend is real, and on a naked Mage it is the spend that drives the
      // gauge: five finishers take a full 100 to 50, and 50 is not strictly
      // above the threshold.
      if (link.prof.isCombo && gauge?.finisherCost > 0) spendAndGauge(gauge.finisherCost, t);
      let swingOut = hit(link.prof, now);
      // The combo registers spend HERE: the finisher's own cast is the
      // consumer (onUseSkill isFinalAttack -> critChance += 1, consume). Same
      // expectation blend the active-cast registers use, cleared either way.
      if (link.prof.isCombo && comboRegs.length) {
        for (const r of comboRegs) {
          if (r.p > 0 && swingOut.critRoll) {
            const cr = swingOut.critRoll;
            const forced = cr.fixed + cr.base * cr.cd;
            swingOut = {
              ...swingOut,
              damage: swingOut.damage * (1 - r.p) + forced * r.p,
              critRoll: { ...cr, p: r.p + (1 - r.p) * cr.p },
            };
          }
          r.p = 0;
        }
      }
      // WeaponAttack_RandomRange: observed in play as a symmetric ~±10% on
      // WeaponPower-scaled swings (19-24, 78-95 around their means) - and as
      // NOTHING on the Strength-scaled combo finisher, which read a constant
      // 133 every time. So the roll rides the plain swings only; the
      // deterministic fight keeps the mean either way.
      const roll = rand && swingVariance > 0 && !link.prof.isCombo
        ? 1 + (rand() * 2 - 1) * swingVariance : 1;
      link.hits = (link.hits ?? 0) + (swingOut.hits ?? 0);
      physicalHits += swingOut.hitsPhysical ?? 0;
      link.fires = (link.fires ?? 0) + 1;
      link.damage = (link.damage ?? 0) + swingOut.damage * roll;
      link.heal = (link.heal ?? 0) + swingOut.heal * roll;
      link.shield = (link.shield ?? 0) + swingOut.shield * roll;
      feedPools(swingOut, t, link.prof.id, roll);
      setUp(link.applies, t);
      applyDots(link.prof.id, t, { attack: !link.prof.isCombo, combo: link.prof.isCombo });
      const end = t + link.occupancy;
      tickTo(end); advanceIncome(end);
      fillerTime += link.occupancy;
      t = end;
      lastSwingEnd = end;
    }
    tickTo(fight); advanceIncome(fight);

    // The pool dots settle at the end, on what their ticks actually PAID
    // before the bell - the un-ticked tail is dropped, which is what a damage
    // meter would report. Over a fight many times the status's own duration
    // that tail is a fraction of a percent; over a short one it is not, and
    // crediting it in full read a 3-second fight four ticks rich. The
    // multiplier is per dot: a Hemorage-scoped talent covers Hemorrhage and
    // Infused Wound, not Bonethrow's plain Bleed.
    for (const p of poolDots) {
      const scale = poolScale?.get(p.status) ?? { mult: poolMultiplier, healShare: poolHealShare };
      const settled = p.tick > 0 ? p.paid : p.fed;
      p.damage = settled * p.pool.fraction * scale.mult;
      // A share of what the bleed dealt, handed back as healing (Bloodfeast).
      p.heal = p.damage * scale.healShare;
    }

    // The denominator is the FIGHT, not the moment the last cast happened - a
    // damage meter divides by the clock, and so must this.
    return { swings, combos, busy, fillerTime, physicalHits, elapsed: fight };
  }

  // --- run it ---------------------------------------------------------------
  // A rollout is a HEURISTIC, not an optimum, and a myopic one: it maximises
  // what lands inside the horizon, and the cost of spending a long cooldown
  // early falls outside it. On two of the four classes that made the answer
  // WORSE than plain priority order - a Warrior lost 1.2% and a Rogue 1.4% -
  // which is the one thing a "smarter" rotation may never do.
  //
  // So the fight is played BOTH ways and the better one is kept. That is not a
  // fudge: both are rotations the simulator can actually execute, so the higher
  // of the two is a lower bound on what a player can get, and the lower one
  // never was. It is also what a SimulationCraft user does by hand when they
  // A/B two action lists. `rotationSearched` reports which won.
  const rolls = Math.max(1, fights | 0);
  const rand = rolls > 1 ? rng(seed) : null;
  const totals = [];
  let last = null;
  const acc = { active: new Map(), filler: new Map(), dot: new Map(), trig: new Map(), pool: new Map() };
  for (const link of chain) link.total = { damage: 0, heal: 0, shield: 0, hits: 0, fires: 0 };
  for (let i = 0; i < rolls; i++) {
    for (const link of chain) { link.damage = 0; link.heal = 0; link.shield = 0; link.hits = 0; link.fires = 0; }
    last = runOne(rand);
    let damage = 0, heal = 0, shield = 0;
    for (const a of actives) {
      damage += a.damage; heal += a.heal; shield += a.shield;
      const e = acc.active.get(a) ?? { casts: 0, hits: 0, damage: 0, heal: 0, shield: 0 };
      e.casts += a.casts; e.hits += a.hits ?? 0;
      e.damage += a.damage; e.heal += a.heal; e.shield += a.shield;
      acc.active.set(a, e);
    }
    for (const link of chain) {
      damage += link.damage; heal += link.heal; shield += link.shield;
      link.total.damage += link.damage; link.total.heal += link.heal; link.total.shield += link.shield;
      link.total.hits += link.hits ?? 0; link.total.fires += link.fires ?? 0;
    }
    for (const d of dots) {
      damage += d.damage; heal += d.heal;
      const e = acc.dot.get(d) ?? { ticks: 0, damage: 0, heal: 0 };
      e.ticks += d.ticks; e.damage += d.damage; e.heal += d.heal;
      acc.dot.set(d, e);
    }
    for (const p of poolDots) {
      damage += p.damage; heal += p.heal ?? 0;
      const e = acc.pool.get(p) ?? { damage: 0, fed: 0, paid: 0, heal: 0, ticks: 0 };
      e.damage += p.damage; e.fed += p.fed; e.heal += p.heal ?? 0; e.ticks += p.ticks ?? 0;
      // What the ticks actually PAID OUT before the bell, as against what was
      // banked. The difference is the tail a damage meter never saw either, and
      // it is one of the two reasons the printed feed does not tie out against
      // the printed damage.
      e.paid += p.tick > 0 ? p.paid : p.fed;
      acc.pool.set(p, e);
    }
    for (const g of triggers) {
      damage += g.damage; heal += g.heal; shield += g.shield;
      const e = acc.trig.get(g) ?? { fires: 0, damage: 0, heal: 0, shield: 0 };
      e.fires += g.fires; e.damage += g.damage; e.heal += g.heal; e.shield += g.shield;
      acc.trig.set(g, e);
    }
    totals.push({ damage, heal, shield, ...last });
  }

  const mean = (pick) => totals.reduce((s, x) => s + pick(x), 0) / totals.length;
  const sd = (pick) => {
    if (totals.length < 2) return 0;
    const m = mean(pick);
    return Math.sqrt(totals.reduce((s, x) => s + (pick(x) - m) ** 2, 0) / (totals.length - 1));
  };

  const elapsed = mean((x) => x.elapsed);
  const swingRate = mean((x) => x.swings) / elapsed;
  const comboRate = mean((x) => x.combos) / elapsed;

  const triggeredLines = [];
  for (const g of triggers) {
    const e = acc.trig.get(g);
    if (!e || !e.fires) continue;
    const fires = e.fires / rolls;
    triggeredLines.push({
      id: g.prof.id, name: g.prof.name, kind: 'triggered', source: g.source,
      perCast: g.out, interval: elapsed / fires, share: 0, why: g.rule.why,
      total: {
        damage: (e.damage ?? 0) / rolls,
        heal: (e.heal ?? 0) / rolls,
        shield: (e.shield ?? 0) / rolls,
      },
      hits: fires * ((g.out?.hits ?? 0) || 1),
    });
  }

  // --- lines ---------------------------------------------------------------
  const lines = [];
  for (const a of actives) {
    const e = acc.active.get(a);
    if (!e || !e.casts) continue;
    const casts = e.casts / rolls;
    // What a cast was WORTH ON AVERAGE over the fight, not what it would be
    // worth standing still. With live state those differ: the same skill is
    // worth more inside a window than outside one, and the average is the
    // number that actually adds up to the reported dps.
    lines.push({
      id: a.prof.id, name: a.prof.name, kind: 'active', source: a.source,
      perCast: { damage: e.damage / e.casts, heal: e.heal / e.casts, shield: e.shield / e.casts },
      // What it dealt over the WHOLE fight. `perCast x fight/interval` is not a
      // substitute: for the chain those two disagree by the share of the clock
      // the chain actually gets, and a reader adding the column up was right to
      // find it 30% over.
      total: { damage: e.damage / rolls, heal: e.heal / rolls, shield: e.shield / rolls },
      // Damage EVENTS, not casts: a multi-hit skill and a cleave both land more
      // than one, and that is what a meter counts and what the capture logs a
      // row for.
      hits: (e.hits ?? 0) / rolls,
      interval: elapsed / casts, share: (casts * a.occupancy) / elapsed,
      casts,
    });
  }
  // A STACK COUNTER, priced AFTER the fight rather than played inside it.
  //
  // The rate is `qualifying events / maxStacks`, and the fight counts its own
  // events - so this needs no new castable and, deliberately, gives the
  // rotation search nothing to reorder around. Injecting it as a pressable
  // instead was measured to send the search to WORSE plans (436 -> 413/423),
  // the same local-optimum failure the talent search shows, so the price is
  // landed analytically on a line of its own.
  //
  // THE FIGHT STARTS COLD - no banked stacks. `GS_Nova_Passive_Stack` has no
  // authored duration, so in game its stacks survive the pull and a meter can
  // show twice the steady-state rate on a warm character. `floor` is what makes
  // the cold start honest: 99 stacks at the bell are 99 stacks nobody spent,
  // the same convention the pool dots' un-ticked tail already follows.
  const physicalHits = mean((x) => x.physicalHits ?? 0);
  for (const sp of stackProcs ?? []) {
    // The timed shape's clock is combat time, not an event count: a pickup
    // every period/cap seconds, cap pickups to arm.
    const fires = sp.on === 'timer'
      ? Math.floor(elapsed / (sp.period > 0 ? sp.period : Infinity))
      : Math.floor(physicalHits / sp.cap);
    if (!(fires > 0)) continue;
    const prof = sp.prof;
    const out = sp.out;
    if (!prof || !out) continue;
    lines.push({
      id: prof.id, name: prof.name, kind: 'triggered', source: sp.from,
      perCast: { damage: out.damage, heal: out.heal, shield: out.shield },
      total: { damage: out.damage * fires, heal: out.heal * fires, shield: out.shield * fires },
      hits: (out.hits ?? 1) * fires,
      interval: fires > 0 ? elapsed / fires : Infinity, share: 0,
      postHoc: true,
      why: sp.on === 'timer'
        ? `one per ${sp.period}s of combat - a pickup every ${sp.period / sp.cap}s, ${sp.cap} to arm - from a cold start`
        : `one per ${sp.cap} physical hits (${Math.round(physicalHits)} in this fight), `
          + 'from a cold start - no stacks carried in',
    });
  }

  // A MARK fires its lump once per `per` applications - the second stack
  // consumes it - so its rate is the fight's own cast counts over the skills
  // that apply it. The finisher-consume path in the mark's script only
  // accelerates the same alternation and is deliberately not double-counted.
  for (const mp of markProcs ?? []) {
    if (!mp.prof || !mp.out) continue;
    let apps = 0;
    for (const [a, e] of acc.active) if (mp.appliers.includes(a.prof.id)) apps += e.casts;
    for (const link of chain) if (mp.appliers.includes(link.prof.id)) apps += link.total.fires;
    apps /= rolls;
    const fires = Math.floor(apps / (mp.per > 0 ? mp.per : 2));
    if (!(fires > 0)) continue;
    lines.push({
      id: mp.prof.id, name: mp.prof.name, kind: 'triggered', source: mp.appliers.join('+'),
      perCast: { damage: mp.out.damage, heal: mp.out.heal, shield: mp.out.shield },
      total: { damage: mp.out.damage * fires, heal: mp.out.heal * fires, shield: mp.out.shield * fires },
      hits: (mp.out.hits ?? 1) * fires,
      interval: fires > 0 ? elapsed / fires : Infinity, share: 0,
      postHoc: true,
      why: `one per ${mp.per} applications (${Math.round(apps)} in this fight) - the second stack consumes the mark`,
    });
  }

  const fillerTime = mean((x) => x.fillerTime);
  if (chainTime > 0 && fillerTime > 0) {
    const cycles = Math.max(1e-9, fillerTime / chainTime) * rolls;
    // ONE LINE PER LINK, not one for the chain. The aggregate row hid a named
    // ability: a damage meter listed "Mania" among the top rows and the model
    // appeared not to have it at all, when `GS_Nova_Combo` is the fourth link of
    // the greatsword chain and had been scored the whole time - 52 hits, 62.7
    // dps - with no way to see it. A reconciliation against a meter is a
    // per-ROW exercise, and this is the row it could not find.
    //
    // Each link fires once per cycle, so its recurrence IS the cycle time and
    // its share of the clock is its own occupancy over the cycle. The shares
    // still sum to `fillerTime / elapsed`, and the totals to what the aggregate
    // carried.
    for (const link of chain) {
      const dmg = (link.total?.damage ?? 0) / rolls;
      const heal = (link.total?.heal ?? 0) / rolls;
      const shield = (link.total?.shield ?? 0) / rolls;
      const fires = link.total?.fires ?? 0;
      if (!(dmg > 0 || heal > 0 || shield > 0)) continue;
      lines.push({
        id: link.prof.id, name: link.prof.name, kind: 'filler', source: link.source,
        // Its OWN count, not the cycle's. The links do not fire equally often:
        // a chain broken partway through pays link 1 more than link 4, which is
        // the whole reason a finisher is worth talking about separately.
        perCast: {
          damage: fires > 0 ? (link.total?.damage ?? 0) / fires : 0,
          heal: fires > 0 ? (link.total?.heal ?? 0) / fires : 0,
          shield: fires > 0 ? (link.total?.shield ?? 0) / fires : 0,
        },
        total: { damage: dmg, heal, shield },
        hits: (link.total?.hits ?? 0) / rolls,
        interval: fires > 0 ? elapsed / (fires / rolls) : chainTime,
        share: (link.prof.occupancy * (fires / rolls)) / elapsed,
        chainLink: true,
      });
    }
  }
  for (const d of dots) {
    const e = acc.dot.get(d);
    if (!e || !e.ticks) continue;
    const ticks = e.ticks / rolls;
    // What a tick was WORTH ON AVERAGE, which since stacks landed is not the
    // snapshot amount: a tick of Lethal Poison is its own value times however
    // many stacks were on the target, so printing the one-stack figure beside a
    // total six times larger reads as an arithmetic error in the tool.
    const perTick = ticks > 0 ? (e.damage / rolls) / ticks : 0;
    // Back-derived from damage, the mean can drift past the cap: with several
    // appliers the per-application SNAPSHOT varies (whatever was up at each
    // application), so damage/ticks is not per-stack x stacks exactly. The cap
    // is enforced where stacks live; the report must not un-enforce it.
    const meanStacks = Math.min(d.stacks ?? 1,
      d.out.damage > 0 ? perTick / d.out.damage : 1);
    lines.push({
      id: d.status, name: d.name, kind: 'over time', source: d.from,
      perCast: { damage: e.damage / rolls, heal: e.heal / rolls, shield: 0 },
      // A status's `perCast` IS its whole-fight figure - its interval is the
      // fight - so the two agree here by construction.
      total: { damage: e.damage / rolls, heal: e.heal / rolls, shield: 0 },
      hits: ticks,   // a tick IS the damage event
      interval: elapsed, share: 0,
      why: `${ticks.toFixed(0)} ticks of ${perTick.toFixed(0)} every ${d.tick}s from ${d.fromName}`
        + (d.scaleByStacks && meanStacks > 1.02
          ? ` - ${d.out.damage.toFixed(0)} a stack, ${meanStacks.toFixed(1)} stacks on average of ${d.stacks}`
          : ''),
    });
  }
  for (const p of poolDots) {
    const e = acc.pool.get(p);
    if (!e || !e.damage) continue;
    lines.push({
      id: p.status, name: p.name, kind: 'over time', source: p.from,
      perCast: { damage: e.damage / rolls, heal: (e.heal ?? 0) / rolls, shield: 0 },
      total: { damage: e.damage / rolls, heal: (e.heal ?? 0) / rolls, shield: 0 },
      hits: (e.ticks ?? 0) / rolls,
      // A pool feed is not a SUBSET of the lines above it - it is a share of
      // their crits, paid out again on its own schedule - so it belongs in the
      // repartition and the column closes on the reported total with it in.
      //
      // WHOSE damage feeds it travels with the line: a GLOBAL pool's per-tick
      // magnitude is share x rotation-dps x tick-interval - a rate, not a
      // per-event constant - and verify's per-hit test is meaningless against
      // it (it inherits the whole rotation's rate difference, the exact thing
      // per-hit exists to be immune to). An own-fed pool's tick is set by the
      // one cast that banked it and keeps its per-hit meaning.
      pool: { own: !!p.pool.own },
      interval: (e.ticks ?? 0) > 0 ? elapsed / ((e.ticks ?? 0) / rolls) : elapsed, share: 0,
      // Say what the guard actually says: Hemorrhage pools physical CRITICAL
      // damage from everyone, Bonethrow pools its OWN damage, crit or not.
      //
      // ...and say what the FEED NUMBER IS, because it is not a subtotal of the
      // damage above it and a reader was right to try adding it up and fail.
      // Two things separate them:
      //
      //   * it is the CRIT-ATTRIBUTABLE share of that damage, not the whole of
      //     it - a guard that says `dmg.critical` only ever sees the part that
      //     crit, which at 36% crit and 154% crit damage is under half the total;
      //   * it is measured BEFORE DamageModifier, because a pool banks base
      //     damage and each tick is multiplied by whatever is up when it lands.
      //     That is on record from play: a bleed already ticking at 100 goes to
      //     120 the moment Berserk is pressed, with no new crit.
      //
      // And a third if the bell catches it: what was still owed is dropped.
      why: (() => {
        const fed = e.fed / rolls;
        const paid = (e.paid ?? fed) / rolls;
        const dropped = Math.max(0, fed - paid);
        return Math.round(p.pool.fraction * 100) + '% of ' + Math.round(fed) + ' '
          + (p.pool.magic ? 'magic ' : p.pool.physical ? 'physical ' : '')
          + (p.pool.crit ? 'critical ' : '') + 'damage'
          + (p.pool.own ? ' dealt by itself' : '') + ', pooled by ' + p.fromName
          + (e.ticks ? `, ticking ${Math.round(e.ticks / rolls)} times` : '')
          + ' - that feed is the '
          + (p.pool.crit ? 'crit-attributable share of your damage, ' : '')
          + 'measured before DamageModifier because the ticks carry it, so it is not a subtotal '
          + 'of the lines above'
          + (dropped > Math.max(1, fed * 0.01)
            ? `; ${Math.round(dropped)} of it was still owed when the bell went and is dropped` : '');
      })(),
    });
  }
  lines.push(...triggeredLines);

  const busy = mean((x) => x.busy) / elapsed;
  const idle = Math.max(0, 1 - busy - fillerTime / elapsed);
  // The post-hoc lines are real damage and belong in the headline, or the
  // repartition would not close on it. They are added here rather than inside
  // the run because they are priced from the run's own event count.
  const extra = lines.filter((l) => l.postHoc)
    .reduce((a, l) => ({
      damage: a.damage + (l.total?.damage ?? 0),
      heal: a.heal + (l.total?.heal ?? 0),
      shield: a.shield + (l.total?.shield ?? 0),
    }), { damage: 0, heal: 0, shield: 0 });

  return {
    dps: (mean((x) => x.damage) + extra.damage) / elapsed,
    hps: (mean((x) => x.heal) + extra.heal) / elapsed,
    sps: (mean((x) => x.shield) + extra.shield) / elapsed,
    dpsSd: sd((x) => x.damage) / elapsed,
    busy,
    idle,
    fillerShare: fillerTime / elapsed,
    lines,
    attackRate: swingRate,
    comboRate,
    // The steady state used to report "cooldowns exceed the clock, so all of
    // them are slowed to fit". A simulation cannot get into that state - it
    // presses what is ready in priority order - so what it reports instead is
    // that nothing was left for the base-attack chain. That is only true if the
    // clock was actually FULL: a fight too short for any single action also
    // leaves the chain unused, and saying "the cooldowns fill the whole clock"
    // beside "100% idle" is a contradiction on one screen.
    oversubscribed: chain.length > 0 && fillerTime <= 0 && idle <= 1e-9,
    fight, fights: rolls, elapsed,
    unmodelled: rotation.unmodelled,
  };
}
