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

// The game's skill-type predicates, by the type NAMES the profile carries.
// They are different sets and the scripts ask for each on purpose:
//   BaseSkill.isWeaponSkill@6161   ops 5-11: type == 7 || type == 8
//                                  (WeaponSkill, WeaponSubSkill - the second
//                                  is new on build 25782799; it was 7 alone)
//   BaseSkill.isActiveSkill@6156   op 7: types 7, 9 and 17 only
//                                  (WeaponSkill, ClassSkill, SignatureSkill)
export const WEAPON_SKILL_TYPES = new Set(['WeaponSkill', 'WeaponSubSkill']);
export const ACTIVE_SKILL_TYPES = new Set(['WeaponSkill', 'ClassSkill', 'SignatureSkill']);

// THE CHANCE THAT AT LEAST ONE OF A CAST'S MAGIC CRITS PASSES ITS ROLL - what
// a reset on "your Magic critical strikes" needs of one cast or swing. Each of
// `events` Magic damage instances crits with q = crits / events and then rolls
// `chance`, independently: 1 - (1 - q x chance)^events. Taking the EXPECTED
// crit count as the exponent - 1 - (1 - chance)^crits - is the same number
// only when every event crits (Blazing Beam from rank 2); below that it is
// higher (four hits at 25% crit behind a 20% roll: 0.2000 against 0.1855),
// the wrong direction for a rate the audit calls a floor.
export function anyOf(chance, crits, events) {
  if (!(crits > 0) || !(chance > 0)) return 0;
  const n = events > 0 ? events : crits;
  return 1 - Math.pow(1 - Math.min(1, crits / n) * chance, n);
}

// A status whose applier hands it out only at a COUNT OF READY PRAYERS
// (`trigger.readyPrayers`, read in skills.mjs: Judgment's Spirited Disciple is
// `if (prayers == vars.var1) addStatus(owner, ...)`, "when you activate 3
// [Prayer]s all at once"). `ready` is what the pressing cast found; null is
// "this caller releases nothing", which never satisfies a count.
const readyAllows = (b, ready) => {
  const need = b.trigger?.readyPrayers;
  if (!need) return true;
  if (ready == null) return false;
  return need.op === '==' ? ready === need.n : need.op === '!=' ? ready !== need.n
    : need.op === '>=' ? ready >= need.n : need.op === '<=' ? ready <= need.n
      : need.op === '>' ? ready > need.n : ready < need.n;
};

// THE CRIT DECOMPOSITION OF WHAT A LINE DEALT. A capture marks every row as a
// critical strike or not, and a short window's mean is mostly which of the
// two it happened to hold - so `bench verify` compares the halves apart, and
// the fight has to keep them apart to be compared: what a line's ordinary
// hits dealt and how many there were, and the same for its critical ones, in
// EXPECTATION (a hit that crits with chance p counts p of an event on one
// side and 1 - p on the other).
//
// A priced cast already decomposes as `fixed + base x (1 + p(cd-1))`
// (damage.mjs castOutput, `critRoll`), so the halves are (1-p)(fixed+base)
// and p(fixed + base x cd) - which is what makes an ARMED press come out
// right: a register that forces the crit sets p to 1 and the press leaves the
// ordinary half entirely, as its row leaves the capture's. Whatever the
// fight multiplied onto the cast after pricing (a spent bank, a charge dump)
// scales both halves alike, which is `k`.
//
//   s        the line's running object; the tally lives on `s.split`
//   out      the priced cast
//   weight   how many times it is booked (a proc's expected share)
//   scale    what the booking multiplies its damage by
//   events   how many capture rows one booking is; default the cast's own
//
// Booked beside every `damage +=` of the four line kinds a capture row can be
// held to (a press, a chain link, a status tick, a triggered step). A site
// this does not reach leaves the tally short of the line's damage, and
// `splitOf` withholds a tally that does not add up to its line rather than
// hand over half of one.
//
// Returns the critical events it booked, in expectation: the fight's own
// `splitAdd` (in runOne) is this plus what a critical hit of the owner's
// raises while a use rider's cooldown runs.
function splitTally(s, out, weight = 1, scale = 1, events = null) {
  const sp = (s.split ??= { ncDamage: 0, ncHits: 0, cDamage: 0, cHits: 0 });
  const dmg = (out.damage ?? 0) * weight * scale;
  const n = (events ?? out.hits ?? 0) * weight;
  const cr = out.critRoll;
  const expected = cr ? cr.fixed + cr.base * (1 + cr.p * (cr.cd - 1)) : 0;
  if (!cr || !(cr.p > 0) || !(expected > 0)) { sp.ncDamage += dmg; sp.ncHits += n; return 0; }
  const k = dmg / expected;
  sp.ncDamage += (1 - cr.p) * (cr.fixed + cr.base) * k;
  sp.ncHits += (1 - cr.p) * n;
  sp.cDamage += cr.p * (cr.fixed + cr.base * cr.cd) * k;
  sp.cHits += cr.p * n;
  return cr.p * n;
}
// The tally as a line carries it - only from the deterministic fight (a
// rolled cast is one outcome of the die, not its two halves), and only when
// it accounts for the whole of the line's damage.
// The affinities a line's damage is dealt in, as the capture names them
// ("Magic", "Physical|Raw"), or null. A capture row carries one, and it is
// the only thing that tells two hits logged under one skill id apart - a
// status's tick from the step its re-application plays (verify.mjs).
function affinitiesOf(prof) {
  const ids = new Set();
  for (const e of prof?.effects ?? []) if (e.kind === 'Damage' && e.affinity) ids.add(e.affinity);
  return ids.size ? [...ids].sort().join('|') : null;
}
function splitOf(s, damage, rolls) {
  const sp = s?.split;
  if (rolls !== 1 || !sp || !(damage > 0)) return {};
  if (Math.abs(sp.ncDamage + sp.cDamage - damage) > 1e-6 * damage) return {};
  return { split: { ...sp } };
}

/**
 * @param spec {
 *   rotation,          // as resolved by skills.mjs - or the engine's VIEW of
 *                      // it, which may also carry what an attached set
 *                      // passive does in a fight: `foeDebuffs` (a stacking
 *                      // debuff an event applies), `eventProcs` (a cast a
 *                      // counter of status applications arms),
 *                      // `castEvents` (by cast id: `cc`, the statuses of the
 *                      // crowd controls it attempts, `knock`, how many
 *                      // knockbacks it lands, and `noForce`, how many of its
 *                      // knocks author no force and are only tallied) and
 *                      // `foeRefuses` (the statuses this target turns away).
 *                      // All four are optional and absent from a resolved
 *                      // rotation.
 *   cast(prof),        // -> { damage, heal, shield, singleTargetDamage }
 *   dotOutput(dot),    // -> { damage, heal } for ONE tick of a status
 *   cooldownMult,      // max(0, 1 - CooldownReduction/100) - the game's rule,
 *                      // off the sheet the fight starts from
 *   cooldownFactor,    // (state) => that same multiplier against what is up:
 *                      // asked when a cooldown STARTS and held for it
 *                      // (`cdScaleOf`). Optional; without it every cooldown
 *                      // of the fight runs at cooldownMult
 *   weaponSkillRefund, // event-earned cooldown per second, WeaponSkills only
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
  // Judged on the caller's goal, not on everything at once - a dps query
  // must never keep the branch that healed more and damaged less.
  const [wd, wh, ws] = goalWeights(spec.goal);
  const total = (r) => r.dps * wd + r.hps * wh + r.sps * ws;
  // Play it both ways when a lookahead is asked for, and keep the better. See
  // the note above `rolls` for why: the rollout is myopic and can lose to plain
  // priority order, and a model that reports the worse of two rotations it can
  // both execute is reporting a number nobody would play.
  const play = (placing) => {
    const s = placing ? { ...spec, placing } : spec;
    if (!(spec.lookahead > 0)) return runFight(s);
    const greedy = runFight({ ...s, lookahead: 0 });
    const ahead = runFight(s);
    const best = total(ahead) > total(greedy) + 1e-9 ? ahead : greedy;
    best.rotationSearched = {
      lookahead: spec.lookahead,
      greedy: total(greedy),
      sequenced: total(ahead),
      won: best === ahead ? 'sequenced' : 'greedy',
    };
    return best;
  };
  const base = play(null);

  // A PRESS THAT LANDS ON ITS OWN CASTER, WHERE A RIDER WAITS FOR A LANDING
  // (`landers`, from the fight: Faithful Winds under Sunlight is the row).
  // What such a press buys is the rider's window, and two things about it the
  // priority order cannot see, because it ranks a press by what the press
  // itself deals:
  //
  //   WHEN. A lane holds the window for as long as it keeps landing, and a
  //   window is not stacked - pressed while another landing already holds it
  //   open, the seconds the two share are bought twice. Ranked by its own
  //   damage, a lane that deals a little is pressed among the first things
  //   after the pull, on top of whatever opened the window there; the same
  //   lane dealing nothing sorts last and chains with it instead. So a rune
  //   that only ADDS a hit to Faithful Winds priced a build LOWER than the
  //   empty socket did.
  //   WHETHER. A press with nothing of its own is worth its time only if the
  //   window it opens is not open already. Where something else lands on the
  //   hero at least as often as the window lasts, the press buys no fire of
  //   the rider and costs the chain its clock - and a skill slotted for
  //   nothing priced the build LOWER than the empty slot did.
  //
  // (The numbers both were found on are in the audit: engine.mjs, the entry
  // on how the rotation is derived.)
  //
  // Neither is a rule of the game. Both are orders this simulator can play,
  // like the two above, so they are PLAYED and the best kept: each lander
  // where the order ranks it, last in the order (`tail` - for one whose
  // landing lasts), and left out (`out` - for one that is in the rotation
  // for its landing alone). A hold on "the window is open" was tried as the
  // rule instead and is not one: it lowers a build whose lane is worth
  // pressing a few seconds INTO a prayer's window (565.3 as ranked and
  // 561.7 held, on the Priest build the first of the two was found on).
  //
  // EVERY way of placing them is played while there are few (`LANDER_WAYS`:
  // two landers at three and two places are six); two placings that come to
  // the same order are one fight. Past that, one lander at a time against
  // the best so far, round again until a round changes nothing - an order
  // tried, not all of them.
  const landers = (base.landers ?? []).map((l) => ({
    ...l, places: ['rank', ...(l.lasts > 0 ? ['tail'] : []), ...(l.onlyLands ? ['out'] : [])],
  })).filter((l) => l.places.length > 1);
  if (!landers.length) return base;
  const orderOf = (placing) => runFight({ ...spec, placing, lookahead: 0, orderOnly: true }).order.join('>');
  const played = new Map([[orderOf({}), { placing: {}, result: base, total: total(base) }]]);
  const tryWay = (placing) => {
    const key = orderOf(placing);
    if (!played.has(key)) { const r = play(placing); played.set(key, { placing, result: r, total: total(r) }); }
    return played.get(key);
  };
  // (A releaser that may be left out - `releases` - is not counted against
  // the budget: there is one to a class, its two places double the fights at
  // most, and a build is not to lose the exhaustive search of its other
  // landers for holding it. Counted, it took a Priest build with two lanes
  // and a heal as the only prayer past the budget, and the search missed the
  // order that leaves the releaser out AND moves a lane.)
  const ways = landers.filter((l) => !l.releases).reduce((n, l) => n * l.places.length, 1);
  if (ways <= LANDER_WAYS) {
    let all = [{}];
    for (const l of landers) all = all.flatMap((p) => l.places.map((at) => (at === 'rank' ? p : { ...p, [l.id]: at })));
    for (const p of all) tryWay(p);
  } else {
    let cur = {}, curTotal = total(base);
    for (let round = 0, moved = true; moved && round <= landers.length; round++) {
      moved = false;
      for (const l of landers) {
        for (const at of l.places) {
          if ((cur[l.id] ?? 'rank') === at) continue;
          const { [l.id]: was, ...rest } = cur;
          const p = at === 'rank' ? rest : { ...rest, [l.id]: at };
          const w = tryWay(p);
          if (w.total > curTotal + 1e-9) { cur = p; curTotal = w.total; moved = true; }
        }
      }
    }
  }
  // The first played wins a tie, and the order as ranked was played first.
  let kept = null;
  for (const w of played.values()) if (!kept || w.total > kept.total + 1e-9) kept = w;
  const best = kept.result;
  best.rotationSearched = {
    ...(best.rotationSearched ?? { lookahead: 0, greedy: kept.total, sequenced: null, won: 'greedy' }),
    // Every order played for the landers, with what it came to on the goal,
    // and the one kept: `placing` names each lander that was moved (`tail`)
    // or left out (`out`); one it does not name stood where the order ranks
    // it.
    landers: {
      of: landers.map((l) => ({ id: l.id, name: l.name, places: l.places, placed: kept.placing[l.id] ?? 'rank' })),
      played: [...played.values()].map((w) => ({ placing: w.placing, total: w.total, kept: w === kept })),
      exhaustive: ways <= LANDER_WAYS,
    },
  };
  // A press left out is a slotted skill that deals nothing and is never
  // pressed: said on the build, with the numbers it was left out on, or it
  // is a silent zero.
  const sat = landers.filter((l) => kept.placing[l.id] === 'out');
  if (sat.length) {
    const secs = (x) => `${+x.toFixed(1)}s`;
    best.unmodelled = [...(best.unmodelled ?? []), ...sat.map((l) => {
      // The best fight that PRESSED it, to hold the kept one against.
      let pressed = null;
      for (const w of played.values()) if (w.placing[l.id] !== 'out' && (!pressed || w.total > pressed.total + 1e-9)) pressed = w;
      const without = best.landings ?? [], withIt = pressed?.result.landings ?? [];
      const opens = [...new Set([...withIt, ...without].map((w) => w.name))];
      const fires = (r, w) => +r.lines.filter((x) => w.riders.includes(x.id)).reduce((sum, x) => sum + (x.hits ?? 0), 0).toFixed(1);
      const landingsOf = (x) => `${x.opens} landing${x.opens === 1 ? '' : 's'}`;
      return {
        id: l.id, name: l.name, source: l.source, kind: 'not pressed',
        why: `${l.name} is slotted and not pressed. All its press does ${l.releases ? 'toward this goal is release what lands' : 'in this build is land'} on you, which opens `
          + `${opens.join(', ') || 'a window something else already holds'}; the fight was played with the press and without it, and reads `
          + `${+pressed.total.toFixed(1)} a second with it and ${+kept.total.toFixed(1)} without. `
          + (without.length
            ? without.map((w) => {
              const was = withIt.find((x) => x.status === w.status);
              const struck = `Without it ${w.name} still plays ${fires(best, w)} times in the ${best.fight}s fight`
                + (was ? ` (${fires(pressed.result, was)} with it)` : '');
              // A window a swing spends is re-armed by each landing: who
              // lands, and how often, is all there is to say of it.
              if (w.counted) {
                return `${struck}: a swing spends it, and what else lands on you arms it again - `
                  + [...w.by].sort((x, y) => y.opens - x.opens).map((x) => `${x.name} (${landingsOf(x)})`).join(', ');
              }
              return `${struck}: its window is held open ${secs(w.seconds)}` + (was ? ` (${secs(was.seconds)} with it)` : '')
                + ' by what else lands on you - '
                + w.by.filter((x) => x.seconds > 0).sort((x, y) => y.seconds - x.seconds)
                  .map((x) => `${x.name} (${landingsOf(x)}, ${secs(x.seconds)} of it)`).join(', ');
            }).join('. ')
            : 'Nothing else opens it, and what the press would add is worth less than the time it takes'),
      };
    })];
  }
  return best;
}

// How many ways of placing a build's landers `simulate` plays in full before
// it falls back to one lander at a time. A budget of fights, not a number of
// the game's.
export const LANDER_WAYS = 8;

function runFight(spec) {
  const {
    rotation, cast, dotOutput, rollCrit = null, cooldownMult = 1, weaponSkillRefund = 0, fight = 200, fights = 1,
    timedBuffs = [], lookahead = 0, seed = 0x9e3779b9, resources = null,
    poolMultiplier = 1, poolHealShare = 0, critChance = 0, policy = null,
    poolScale = null, poolFactor = null, goal = null, chainResets = true, wsReset = null,
    swingVariance = 0, comboWindow = 0.6, empowerments = [], stackProcs = [], markProcs = [], chainFeeds = [],
    holdChain = false,
    statusHitScale = null, whileTyped = [],
    detonations = [],
    placing = null, orderOnly = false,
    pickupShare = 1, cooldownFactor = null,
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
      regen: spec.regen ?? 0,
    });
  }
  const tracked = (atb) => pools.has(atb);
  // A cost derived from a cooldown follows the EFFECTIVE cooldown, not the
  // authored one: getSparkCost@9623 reads cooldownDuration after the CDR
  // modifier, so a CDR-stacking Mage pays less Spark per weapon skill, not
  // just more often. The plan attaches the formula (`cdCost`) because it
  // cannot know the sheet; the amount resolves here, where cooldownMult is.
  // ...and it is the cooldown AS LATCHED AT THAT PRESS (`cdScaleNow`, below):
  // onTriggerCD@9634 writes cooldownDuration at op 8 and consumes the
  // resources at op 11, and getSparkCost reads the field it just wrote.
  let cdScaleNow = 1;
  const costOf = (c, prof) => (c.cdCost
    ? Math.round(Math.max(c.cdCost.min, prof.cooldown * cooldownMult * cdScaleNow * c.cdCost.ratio))
    : c.amount);
  // A cost marked `spendOnly` is taken when the cast goes off and never
  // holds it back (the Mage's Spark: see where the plan attaches it).
  // One marked `all` takes WHATEVER IS HELD and never holds the press back
  // either (the Rogue's Finisher consumes all Combo Points and asks for
  // none): its `amount` is what a full bar is, for a reader of the profile.
  const canPay = (prof) => (prof.costs ?? []).every((c) => {
    if (c.spendOnly || c.all) return true;
    const p = pools.get(c.atb);
    return !p || p.value >= costOf(c, prof) - 1e-9;
  });
  const pay = (prof, share = 1) => {
    for (const c of prof.costs ?? []) {
      const p = pools.get(c.atb);
      if (p) p.value = Math.max(0, p.value - (c.all ? p.value : costOf(c, prof)) * share);
    }
  };
  // WHAT A PRESS FINDS IN A POOL IT EMPTIES. A profile that carries a
  // `poolRider` is priced with a FULL pool (`full` points at `per` each, in
  // the cast's additive bracket), and the fight takes back what the pool was
  // short of when the press went off: the Finisher's script reads the points
  // at its Damage step (`consumed = getCp(); damageBonus = consumed * var1`,
  // then `hit.dmgMult += damageBonus`). The pool here is an EXPECTATION - a
  // critical-gated point is banked at its chance - so it is not rounded as
  // the game rounds a whole count: the amount is linear in the points and
  // the mean of the rounded counts is the mean. (To the hundredth, so the
  // pricing cache keeps a bounded key space.)
  const poolHeldBy = (prof, valueOf) => {
    const pr = prof.poolRider;
    if (!pr) return null;
    const held = Math.round(100 * Math.max(0, Math.min(pr.full, valueOf(pr.atb) ?? 0))) / 100;
    return { atb: pr.atb, held, add: -pr.per * (pr.full - held) };
  };
  // INCOME THAT PAYS A SKILL DIFFERENT FROM THE LAST ONE IT PAID (`distinct`
  // on a gain - the Rogue's Combo Points, skills.mjs where the gain is
  // declared). The memory is per gain. A plain gain remembers the last skill
  // that paid, and an event of that same skill pays nothing. A critical-gated
  // one is paid at the crit chance, so its memory is a distribution: the
  // chance that the last skill that paid was each one. An event of skill K at
  // crit chance c pays c x (1 - P[K]), after which P[K] has risen by that
  // much and every other skill's share has fallen by c of itself.
  const distinctShare = (memory, g, kind, crit) => {
    if (!g.critGated) {
      if (memory.get(g) === kind) return 0;
      memory.set(g, kind);
      return 1;
    }
    let dist = memory.get(g);
    if (!dist) { dist = new Map(); memory.set(g, dist); }
    const pK = dist.get(kind) ?? 0;
    for (const [j, pj] of dist) if (j !== kind) dist.set(j, pj * (1 - crit));
    dist.set(kind, pK + crit * (1 - pK));
    return crit * (1 - pK);
  };
  const cloneMemory = (memory) => new Map([...memory].map(([g, v]) => [g, v instanceof Map ? new Map(v) : v]));
  // The skill an event is OF: a recast entry is its row's second press.
  const kindOf = (id) => String(id).split('#')[0];
  // What is up right now, for the gain factor below. The fight sets this to
  // its live state as it runs; the rollout deliberately does not - it is a
  // bounded heuristic and keeps the frozen resting factor.
  const stateRef = { now: null };
  const earn = (atb, amount, liveFactor = true) => {
    const p = pools.get(atb);
    if (!p || !(amount > 0)) return;
    // `attribute.gainAtb` is a multiplier on INCOME, and it is a live stat:
    // `Warrior_BerserkStatus` carries RageGainFactor ARatio +1, so Rage earned
    // inside a Berserk window doubles. But only the script addAtb path reads
    // it (Unit.addAtb@4876 op 21) - Unit.addResource@4885, authored GainAtb steps
    // and passive regen take the raw stored factor, so a Berserk window
    // doubles your per-attack Rage and not the InfiniteRage trickle.
    let f = 1;
    if (liveFactor) {
      f = p.factor;
      if (poolFactor && p.gainAtb && stateRef.now) {
        const live = poolFactor(p.gainAtb, stateRef.now);
        if (live > 0) f = live;
      }
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
  // The period a skill actually cycles at: the CooldownReduction STAT
  // multiplies the base by (1 - v/100) - the game's GameObject.getCooldownModifier@4600,
  // measured live to 48ms - while an EVENT refund (`Red Tempo` earning
  // seconds back per bleed tick, WeaponSkills only) divides the period,
  // because income per second against a fixed cost is a rate, not a discount.
  const isWeaponSkill = (prof) => WEAPON_SKILL_TYPES.has(prof.type);
  const periodFor = (prof) => {
    const refund = isWeaponSkill(prof) ? weaponSkillRefund : 0;
    const period = (prof.cooldown * cooldownMult) / (1 + refund);
    // An AUTHORED zero cooldown means "pool-gated or free" and the press site
    // maps it to Infinity-after-one-charge; a cooldown REDUCED to zero by 100
    // CooldownReduction means the opposite - press at will, paced only by the
    // occupancy clock. Keep a hair of period so the two never collide.
    return prof.cooldown > 0 ? Math.max(period, 1e-3) : period;
  };
  // COOLDOWN REDUCTION IS READ WHEN A COOLDOWN STARTS, AND HELD FOR THAT
  // COOLDOWN. READ: Skill.onTriggerCD@9634 ops 0-8 write the field
  // cooldownDuration = getEffectiveCooldown() - the row's cooldown times
  // GameObject.getCooldownModifier@4600, max(0, 1 - CooldownReduction) off the
  // owner as it stands at that instant - and Skill.update@9639 ops 18-21
  // advance the charge by dt / getCooldown(), which is that field
  // (getCooldown@9604 is two ops). Nothing rewrites it while the cooldown
  // runs. MEASURED 2026-10-13 on the captured Mage (Cooldown Reduction 4; a
  // 20 s passive clock read off its ready marker, polled every half second;
  // Mystic Empowerment's +30 for 15 s): a cooldown begun UNDER the buff, with
  // the buff gone 4.9 s in, took 13.03 s (20 x 0.66 = 13.2; a rate that
  // followed the buff would be 17.0); three begun BEFORE it, with the buff
  // arriving 9.9, 3.1 and 8.2 s in, took 18.99, 19.68 and 19.26 s (19.2; a
  // rate that followed it would be 16.3, 14.2 and 15.8).
  //
  // So a timed status that carries Cooldown Reduction shortens exactly the
  // cooldowns that START while it is up, each by its whole length - which a
  // fight with one multiplier for all of it could not say: such a status was
  // worth nothing, on every row that has one. The fight asks the sheet as it
  // stands when a cooldown starts (`cooldownFactor`, priced against what is
  // up like any cast) and holds the answer as a scale on the resting period.
  // A press's OWN status is not up yet when its cooldown starts here: read
  // for a cast with no execution step (Mystic Empowerment - its charge is
  // consumed in Skill.start@9625 ops 1-2, before any step runs, and the step
  // that hands the status out waits 0.25 s), an assumption and a floor for
  // the rest. A skill holding several charges is latched again by EACH of its
  // presses, and the charge already on its way goes on at the new length
  // from there (`relatch`): the field is one per skill, and Skill.update@9639
  // divides by whatever it holds that frame.
  const cdScaleOf = (st) => {
    if (!cooldownFactor || !st || !(cooldownMult > 0)) return 1;
    const f = cooldownFactor(st);
    return f === cooldownMult ? 1 : f / cooldownMult;
  };
  // When a charge that is `was`-scaled and due at `due` comes back, once the
  // skill is latched at `now` instead: the share of it still to run, at the
  // new length.
  // The cooldown an active starts at a scale: its resting period times the
  // scale, never under the hair `periodFor` keeps (a status that takes
  // Cooldown Reduction to a hundred must not hand a free cast back in the
  // instant that spent it), and no clock at all for a row that has none.
  const scaledCooldown = (a, scale) => (a.cooldown > 0 ? Math.max(a.cooldown * scale, 1e-3) : Infinity);
  const relatch = (due, t, was, now) => (now === was || !Number.isFinite(due) || !(due > t) || !(was > 0)
    ? due : t + (due - t) * now / was);
  const actives = [];
  // The presses that land on their caster for a rider that waits for one,
  // and where this fight was told to put each (`placing`, from `simulate`).
  const landerFacts = [];
  for (const { prof, source, applies, via, recast, releases, needsReady, landsOnCaster } of rotation.active) {
    const out = cast(prof, bare);
    const setsUp = (applies?.self?.length ?? 0) + (applies?.target?.length ?? 0);
    // A cast whose entire payload is a DOT is worth pressing even though the
    // cast itself outputs nothing: Swirling Embers deals zero on the press and
    // 0.25x(Dex+Faith) per second for eight seconds after it. The dot fires
    // off this skill's own cast event, so dropping the cast dropped the dot
    // with it - a quarter of the Priest's recorded damage, refused as "nothing
    // gives it a rate" while the rate was its own cooldown.
    const appliesDot = (rotation.dots ?? []).some((d) => d.from === prof.id && d.on === 'cast');
    // A SUMMONER's worth is its pets': the cast itself emits nothing and the
    // imps swing for twelve seconds after it.
    const appliesSummon = (rotation.summons ?? []).some((sp) => sp.from === prof.id);
    // Worth nothing TOWARD THE GOAL and sets nothing up: not in this rotation.
    // A dps fight does not spend GCDs on a pure heal; an hps fight does not
    // spend them on a nuke. A buff-applier stays - the lookahead prices it.
    // ...and so is a cast that opens a WINDOW for a swing rider: Swarmstrike
    // Accord deals nothing on the press and plays a bonus hit on every attack
    // for the seconds after it.
    const opensWindow = (rotation.triggered ?? []).some((tr) => tr.rule?.window?.from === prof.id);
    // ...and so is a cast that lays a DOSE toward a gated status worth
    // something to this goal - itself, or through what rides its application.
    // An hps fight drops every nuke, and with them went the three doses that
    // apply Lethal Poison, and with the poison the heal Recovery Toxins hangs
    // on each application of it: the node read zero healing for a reason the
    // fight had manufactured.
    const laysDose = !worth(out.damage, out.heal, out.shield) && (out.hits ?? 0) > 0
      && (rotation.dots ?? []).some((d) => {
        if (d.on !== 'dose-gate' || !d.gate) return false;
        const cat = WEAPON_SKILL_TYPES.has(prof.type) ? 'weapon-skill'
          : prof.type === 'ClassSkill' ? 'class-skill' : prof.type === 'SignatureSkill' ? 'signature' : null;
        if (!cat || !d.gate.categories.some((c) => c.on === cat)) return false;
        const pays = (x) => { const o = dotOutput(x, bare); return worth(o.damage, o.heal, 0) > 0; };
        return pays(d) || (rotation.dots ?? []).some((x) => x.on === 'apply-of' && x.applyOf === d.status && pays(x));
      });
    // ...and a cast whose worth is the FOLLOW-UP it enables. Expulse deals
    // nothing itself and is the only way to its recast, which throws the
    // orbs; dropped for emitting nothing, the parent was never pressed, so the
    // follow-up never fired, and the weapon's second skill was worth zero
    // without a line saying so.
    const appliesFollowUp = (rotation.triggered ?? []).some((tr) => {
      if (tr.rule?.kind !== 'per-parent-cast' || tr.rule.parent !== prof.id) return false;
      const fo = cast(tr.prof, bare);
      return worth(fo.damage, fo.heal, fo.shield) > 0;
    });
    // ...and a cast whose whole worth is what it RELEASES - Judgment and the
    // prayers that fire off its press. The riders are the kind a follow-up
    // is, so `appliesFollowUp` above is what keeps it: for a release worth
    // something to the goal. (It used to be kept on the flag alone, and a
    // build whose only prayer heals pressed Judgment sixteen times in a dps
    // fight - 0.85 dps of swings for healing the goal does not count, where
    // every other cast worth nothing to the goal is left out.) `releasesSome`
    // says there IS something to release: its press is refused whenever none
    // of it is ready - `releases` below.
    const releasesSome = releases === true && (rotation.triggered ?? [])
      .some((tr) => tr.rule?.kind === 'per-parent-cast' && tr.rule.parent === prof.id);
    // ...and a cast whose whole worth is that it LANDS ON ITS CASTER, for a
    // build whose rider waits for exactly that (`window.opensOn.allyHit`).
    const landsForRider = !!landsOnCaster
      && (rotation.triggered ?? []).some((tr) => tr.rule?.window?.opensOn?.allyHit);
    // ...and a releaser one of whose RELEASES lands on the caster, for the
    // same rider: Prayer: Life heals nobody a dps fight counts, and its
    // landing is what puts Sunlight back up.
    const releasesForRider = releasesSome
      && (rotation.triggered ?? []).some((tr) => tr.rule?.window?.opensOn?.allyHit)
      && (rotation.triggered ?? []).some((tr) => tr.rule?.kind === 'per-parent-cast' && tr.rule.parent === prof.id
        && tr.landsOnCaster != null);
    // A releaser the game refuses to press with nothing ready, in a build
    // where nothing can ever be ready, is not a cast - not even for the status
    // a rune hangs on its press (skills.mjs `refusesEmptyPress`). Kept on the
    // strength of that status it was pressed on every cooldown for nothing:
    // sixteen presses in 200 s, each costing the chain its clock.
    if (releases === true && needsReady === true && !releasesSome) continue;
    // Kept for the statuses it puts up and for nothing else: whether those
    // can ever land is asked once every press is known (`neverLands` below).
    const beyondSetUp = !!worth(out.damage, out.heal, out.shield) || appliesDot || appliesSummon || opensWindow
      || laysDose || appliesFollowUp || releasesForRider;
    const keptForMore = beyondSetUp || setsUp > 0;
    if (!keptForMore && !landsForRider) continue;
    // A lander is one of two things to the order (see `simulate`): a press
    // whose landing LASTS, which may be asked for last, and a press kept for
    // its landing ALONE, which may be left out. The fight reports both.
    if (landsForRider && (landsOnCaster.lasts > 0 || !keptForMore)) {
      const asked = placing?.[prof.id] ?? null;
      const placed = asked === 'out' && !keptForMore ? 'out' : asked === 'tail' ? 'tail' : 'rank';
      landerFacts.push({ id: prof.id, name: prof.name, source: source ?? null, lasts: landsOnCaster.lasts ?? 0, onlyLands: !keptForMore, placed });
      if (placed === 'out') continue;
    }
    // ...and so is a RELEASER that is in the rotation for nothing but a
    // release that lands on its caster (`releasesForRider` with none of the
    // reasons above it): Judgment with Prayer: Life as its only prayer, in a
    // dps build that holds Sunlight. It was kept on that flag alone and
    // pressed on every cooldown whether or not the landing paid - with Flame
    // of Argol in the main hand, whose own area lands on the hero as often as
    // Sunlight lasts, sixteen presses for 500.6 against the 516.0 of the
    // same build with no prayer slotted (the default Priest search's build
    // with that main hand, level 25, named boss). It is the same kind of
    // press as the lander kept
    // for its landing alone, one remove away, and it is given the same
    // choice: the fight is played with it and without it (`simulate`), and
    // the better is kept and said. A status it also sets up is in that
    // comparison, not in front of it.
    if (releasesForRider && !landsForRider && !worth(out.damage, out.heal, out.shield)
      && !appliesDot && !appliesSummon && !opensWindow && !laysDose && !appliesFollowUp) {
      const placed = placing?.[prof.id] === 'out' ? 'out' : 'rank';
      landerFacts.push({ id: prof.id, name: prof.name, source: source ?? null, lasts: 0, onlyLands: true, releases: true, placed });
      if (placed === 'out') continue;
    }
    const cooldown = Math.max(periodFor(prof), 0);
    actives.push({
      prof, source, out, applies, via: via ?? null,
      cooldown,
      // A cast that never takes the hero's control (takesControl false -
      // Swirling Embers, Depth Shield) costs no clock at all: the swing chain
      // plays through it in game, so billing its occupancy both slowed the
      // fight AND broke the chain the one-clock rule was protecting.
      occupancy: prof.takesControl === false ? 0 : Math.max(prof.occupancy, 0.05),
      maxCharges: prof.charges ?? 1,
      // A skill with no cooldown that costs a resource is gated by the POOL,
      // not by a charge. Running it through the charge machinery spends its one
      // charge and then sets the next recovery to Infinity, so it fires once
      // per fight - `Warrior_Rage_Strike` read one cast in 200 seconds when its
      // income supports one every eight.
      poolGated: cooldown <= 0 && (prof.costs ?? []).some((c) => !c.spendOnly && !c.all && pools.has(c.atb)),
      // The cooldown clock starts at the EXEC STEP, not the press - measured
      // to 48ms on GA_Demon_Skill1 - so the cycle a press buys is
      // execOffset + cooldown. The cost is still paid at press here (the game
      // pays at exec too, but nothing in this fight earns inside the gap).
      execOffset: Math.max(0, prof.execOffset ?? 0),
      // The base priority: what a second of your time buys toward the goal,
      // before anything is up. With a lookahead this is only the tiebreak;
      // without one it is the whole player model.
      density: worth(out.damage, out.heal, out.shield) / Math.max(prof.occupancy, 0.05),
      casts: 0, damage: 0, heal: 0, shield: 0,
      // A releaser cannot be pressed with nothing to release (its own
      // checkEnabled refuses it), and is worth what it releases.
      releases: releasesSome,
      source: source ?? null,
      // The second press of a recast skill - see `recastOf` in skills.mjs.
      // It has no clock of its own: its first press opens it, for `window`
      // seconds, once.
      recast: recast ?? null,
      // Whether a press lands a hit of the pressed skill on the hero, and
      // for how long it keeps landing - `landsOnCaster` in skills.mjs.
      landsOnCaster: landsOnCaster ?? null,
      onlySetsUp: !beyondSetUp && !landsForRider,
    });
  }
  // A STATUS THAT CAN NEVER LAND IS NOT A SETUP, for any cast. The one shape
  // read with a condition the build can rule out is a status handed out at a
  // COUNT OF READY PRAYERS (`readyAllows`: Judgment's Spirited Disciple,
  // "when you activate 3 Prayers all at once"). How many a press can ever
  // find ready is the rows it releases that hold a charge, are priced, and
  // whose readying event this fight plays - the finisher, or a press it keeps
  // from the slot the prayer's script names - and a press is refused with
  // none (the ready test at the pick), so the counts it can find are 1 to
  // that many. With one prayer slotted, "exactly 3" is never. Counted as a
  // setup all the same, that status kept Judgment on every cooldown in a dps
  // build whose only prayer heals: sixteen presses in 200 s for a status that
  // was never up and a release the goal does not count, 46.77 dps against
  // the 47.62 of the same build without the rune.
  //
  // Such a status is said, pressed or not; and a cast kept for nothing but
  // statuses of that kind is not in the rotation. (A status that DOES land
  // and moves nothing the goal reads - the same rune row's sibling, three
  // seconds of move speed - still keeps its press: that is this fight's rule
  // for every buff, a Smoke Bomb or an Ignore Pain in a dps build alike, and
  // the audit says what it costs.)
  const neverLands = [];
  {
    const mostReady = (a) => {
      const rows = new Map();
      if (!a.releases) return rows;
      for (const tr of rotation.triggered ?? []) {
        const w = tr.rule?.window;
        if (tr.rule?.kind !== 'per-parent-cast' || tr.rule.parent !== a.prof.id || !w?.charges) continue;
        const o = w.opensOn;
        const opened = !o ? true
          : o.combo ? rotation.filler.some((f) => f.prof.isCombo === true)
            : o.sources ? actives.some((x) => x !== a && o.sources.includes(x.source) && (!o.weaponSkill || isWeaponSkill(x.prof)))
              : true;     // an opener this does not judge is not ruled out
        const made = cast(tr.prof, bare);
        if (opened && (made.damage || made.heal || made.shield)) rows.set(tr.via ?? String(tr.prof.id).split('#')[0], tr.prof.name);
      }
      return rows;
    };
    const idle = [];
    for (const a of actives) {
      const hung = [...(a.applies?.self ?? []), ...(a.applies?.target ?? [])];
      if (!hung.some((b) => b.trigger?.readyPrayers)) continue;
      const rows = mostReady(a);
      const lands = (b) => { for (let k = 1; k <= rows.size; k++) if (readyAllows(b, k)) return true; return false; };
      const dead = hung.filter((b) => b.trigger?.readyPrayers && !lands(b));
      if (!dead.length) continue;
      const out = a.onlySetsUp && dead.length === hung.length;
      if (out) idle.push(a);
      for (const b of dead) {
        const need = b.trigger.readyPrayers;
        neverLands.push({
          id: a.prof.id, name: a.prof.name, source: a.source ?? null, kind: 'off in this build',
          why: `${a.prof.name} hands out ${b.name && b.name !== b.status ? b.name : b.status} only on a press that finds `
            + `${need.op === '==' ? 'exactly' : need.op} ${need.n} prayer${need.n === 1 ? '' : 's'} ready, and this fight can make `
            + (rows.size ? `${rows.size} ready at most (${[...rows.values()].join(', ')})` : 'none ready')
            + ' - so it is never up'
            + (out ? `, and ${a.prof.name} is not pressed for it` : ''),
        });
      }
    }
    for (const a of idle) actives.splice(actives.indexOf(a), 1);
  }
  actives.sort((a, b) => b.density - a.density);

  // The base-attack chain is one cycle: you cannot press swing 3 without 1 and
  // 2, so it advances a step at a time and wraps.
  const chain = rotation.filler.map(({ prof, applies }) => ({
    prof, applies, occupancy: Math.max(prof.occupancy, 0.05),
  }));
  const chainTime = chain.reduce((s, x) => s + x.occupancy, 0);
  // A window-opener's place in the priority order. Its own cast is worth
  // nothing, so the base density above files it last, behind every filler-
  // grade cooldown; what it buys is the rider on every swing event of its
  // window, and that is what it is ranked on. Only the ORDER reads this - the
  // damage is whatever the fight then lands inside the window.
  if (chain.length && chainTime > 0) {
    let moved = false;
    for (const a of actives) {
      let w = 0;
      for (const tr of rotation.triggered ?? []) {
        // What a releaser releases, once per press.
        if (a.releases && tr.rule?.kind === 'per-parent-cast' && tr.rule.parent === a.prof.id) {
          const out = cast(tr.prof, bare);
          w += worth(out.damage, out.heal, out.shield);
          continue;
        }
        if (tr.rule?.window?.from !== a.prof.id) continue;
        const out = cast(tr.prof, bare);
        w += worth(out.damage, out.heal, out.shield) * tr.rule.window.duration * chain.length / chainTime;
      }
      if (w > 0) { a.density += w / Math.max(a.prof.occupancy, 0.05); moved = true; }
    }
    if (moved) actives.sort((a, b) => b.density - a.density);
  }
  // (A press that puts COOLDOWN REDUCTION on the hero is NOT ranked on the
  // cooldowns it shortens. It deals nothing, so it sorts last and is pressed
  // when nothing else is ready - the skills it finds on cooldown come back
  // inside its window and start their next one under it. Ranked first
  // instead - on (1 - scale) of every other press - it was tried on the
  // default Mage search's build and read LOWER: 685.5 against 700.3 with
  // Mystic Empowerment left where the order files it, twice pressed either
  // way. The audit says the press is placed by the order, not chosen.)
  // A lander asked for LAST goes behind everything the order holds - pressed
  // when nothing else is ready. The order is final from here, and a caller
  // that only wants to know it (`orderOnly`: two placings that come to one
  // order are one fight) is handed it without the fight.
  {
    const last = new Set(landerFacts.filter((l) => l.placed === 'tail').map((l) => l.id));
    if (last.size) {
      const moved = actives.filter((a) => last.has(a.prof.id));
      const rest = actives.filter((a) => !last.has(a.prof.id));
      actives.splice(0, actives.length, ...rest, ...moved);
    }
  }
  if (orderOnly) return { order: actives.map((a) => a.prof.id), landers: landerFacts };

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
  // Two events no weapon kit asked for and a set passive does. `skill` is
  // every ACTIVE press - `ctx.isSkill` in onSkillProc, the weapon, class and
  // signature skills (BaseSkillAccess.get_isSkill@5193). `status-apply` is
  // every status the build lands on the foe: the hook is onInflictStatusEval
  // and its one dispatch site is ent.GameObject.addStacks@4637 ops 23-77,
  // which run it on every skill and status of the status's INSTIGATOR, on
  // every application - a fresh one, a stack gained, a re-application at the
  // cap alike (the cap is ops 130-144, after the hooks).
  const onSkill = [];
  const onStatusApply = [];
  // ...and one that is no event of the fight's but a count: every damage
  // instance the owner lands (`damage-instance` - a roll with no predicate
  // in a damage hook; played in "the instance clock" below).
  const onInstance = [];
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
    else if (on === 'skill') onSkill.push(w);
    else if (on === 'status-apply') onStatusApply.push(w);
    else if (on === 'damage-instance') onInstance.push(w);
    return w;
  };
  // Three more appliers, each an event this fight raises itself:
  //
  //   'cast-of'    the cast of ONE named skill, whoever owns the hook - a
  //                talent that says `hit.skillId == Skill.X && hit.isFirstHit`
  //                rides X's own press (Acidic Splatter rides the signature
  //                Finisher, not the base-attack chain's combo).
  //   'dose-gate'  a counter of distinct one-stack statuses, one per skill
  //                CATEGORY, converted into the status when `need` of them
  //                are held - the build-25782799 Lethal Poison. Played below.
  //   'apply-of'   every application ATTEMPT of another status - what an
  //                onTryAddStatus hook guarded on that status's id rides.
  //   'tick-of'    every hit of another status of the build's own - a roll
  //                written behind `dmg.skillId == Skill.<that status>`
  //                (Swarm Lord's poison, on Hive Swarm's hits).
  const onCastOf = new Map();   // skill id -> channel wrappers
  const onApplyOf = new Map();  // status id -> dots
  const onTickOf = new Map();   // status id -> channel wrappers
  const gatedDots = [];
  for (const d of dots) {
    if (d.on === 'weapon-skill' || d.on === 'attack' || d.on === 'combo' || d.on === 'attack-or-combo'
      || d.on === 'skill' || d.on === 'status-apply' || d.on === 'damage-instance') {
      channel(d, d.on, d.chance);
    } else if (d.on === 'cast-of' && d.castOf) {
      if (!onCastOf.has(d.castOf)) onCastOf.set(d.castOf, []);
      onCastOf.get(d.castOf).push(channel(d, 'cast-of', d.chance));
    } else if (d.on === 'dose-gate' && d.gate) {
      gatedDots.push(d);
    } else if (d.on === 'apply-of' && d.applyOf) {
      if (!onApplyOf.has(d.applyOf)) onApplyOf.set(d.applyOf, []);
      onApplyOf.get(d.applyOf).push(d);
    } else if (d.on === 'tick-of' && d.tickOf) {
      if (!onTickOf.has(d.tickOf)) onTickOf.set(d.tickOf, []);
      onTickOf.get(d.tickOf).push(channel(d, 'tick-of', d.chance));
    } else {
      if (!onCast.has(d.from)) onCast.set(d.from, []);
      onCast.get(d.from).push(d);
    }
    for (const c of d.coAppliers ?? []) channel(d, c.on, c.chance);
  }
  const dotByStatus = new Map(dots.map((d) => [d.status, d]));
  // Which dots have riders the fight has to read off live state at each hit
  // (see `liveRiders` in the run), and which set something off when they
  // land. Constants of the build, so the tick lane pays one flag test.
  for (const d of dots) {
    d.hasLiveRiders = !!statusHitScale && (
      (d.isDoT === true && (rotation.dotRiders ?? []).length > 0)
      || !!d.stackRider || (d.critFrom ?? []).length > 0);
    d.afterHit = !!d.stackRider || (d.cooldownRiders ?? []).length > 0;
  }
  // The statuses each cast puts on the foe ITSELF, by cast id - a debuff it
  // sets up (`setUp`), a status attached to the cast (`put`). Where the plan
  // also lists one of them among that cast's crowd controls (`castEvents`) it
  // is still ONE application, counted where the fight applies it: Spark
  // Beam's rune slow is a control to `crowdControlOf` and, for its
  // MoveSpeedFactor row, a debuff to the rotation.
  const castHolds = new Map();
  if (rotation.castEvents) {
    const holds = (id, status) => {
      if (!castHolds.has(id)) castHolds.set(id, new Set());
      castHolds.get(id).add(status);
    };
    for (const e of [...rotation.active, ...rotation.filler]) {
      for (const d of e.applies?.target ?? []) holds(e.prof.id, d.status);
    }
    for (const [id, list] of onCast) for (const d of list) if (d.to !== 'Self') holds(id, d.status);
  }
  // Every weapon skill the fight PLAYS, by the game's own test
  // (BaseSkill.isWeaponSkill@6161: type 7 or 8). The sub-skills are the ones
  // that matter here and they never sit in `active`: a recast rides its
  // parent's cast in `triggered`. Built from `active` alone the set named the
  // right two types and held no row of the second.
  const weaponSkillIds = new Set([...rotation.active, ...(rotation.triggered ?? [])]
    .filter((a) => isWeaponSkill(a.prof))
    .map((a) => a.prof.id));
  // What each active is worth as the CONSUMER of an armed chain register, and
  // whether any two of them disagree about it. -1 is "cannot spend one".
  // Both are constants of the build, so the press site pays only a lookup.
  const armWorth = actives.map((a) => (weaponSkillIds.has(a.prof.id)
    ? worth(a.out.damage, a.out.heal, a.out.shield) : -1));
  const anyArmRival = armWorth.some((w, i) => w >= 0 && armWorth.some((v, j) => j !== i && v > w));

  // --- things that fire at you ---------------------------------------------
  // A proc is an event inside the fight, not a rate applied to it afterwards.
  // Handling it in the loop is what lets `fights > 1` roll it for real: with
  // the rate applied afterwards, repeating the fight produced the same answer
  // every time and the spread was always exactly zero.
  const triggers = [];
  for (const tr of rotation.triggered) {
    const out = cast(tr.prof);
    // A rider that prices nothing of its own is no line - unless its gate is
    // what a finisher's bonus hangs on (`gateComboAdd`): then the gate has to
    // be played for the finisher to read it, and `gateOnly` keeps the
    // empty rider off the report.
    const gateOnly = !out.damage && !out.heal && !out.shield;
    if (gateOnly && !(tr.rule.gateComboAdd > 0)) continue;
    triggers.push({
      prof: tr.prof, source: tr.source, out, rule: tr.rule, gateOnly,
      // Duplicate mechanic slots (two Projectile conduits) fire per instance.
      instances: tr.instances ?? 1,
      // Which event this rides. A follow-up rides its parent's cast, which is
      // neither a swing nor a combo - collapsing every rule to those two put it
      // on the base-attack rate and read it several times too fast.
      on: tr.rule.kind === 'per-parent-cast' ? 'parent'
        : tr.rule.kind === 'per-combo' ? 'combo'
          : tr.rule.kind === 'per-dot-tick' ? 'dot-tick'
            : tr.rule.kind === 'per-dot-apply' ? 'dot-apply'
              : tr.rule.kind === 'per-weapon-skill' ? 'weapon-skill'
                : tr.rule.kind === 'per-conduit-trigger' ? 'conduit'
                  // A class-skill press (`ctx.isClassSkill`, type 9), any
                  // active press (`ctx.isSkill`), and a step another piece
                  // of the fight's own state plays by name - `linked`, fired
                  // where that state changes.
                  : tr.rule.kind === 'per-class-skill' ? 'class-skill'
                  : tr.rule.kind === 'per-skill' ? 'skill'
                    : tr.rule.kind === 'linked' ? 'linked'
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
      // ticks and no other's (the accepted build's Virulent Magic rode Lethal
      // Poison alone that way).
      bleedOnly: !!tr.rule.bleedOnly,
      statusFilter: tr.rule.status ?? null,
      // "The first <event> after each cooldown" - Dominion fires its bonus hit
      // on the first combo finisher every 20s. The gate is the authored
      // cooldown; between fires the events pass through untouched.
      gate: tr.rule.cooldownGate ?? 0, nextReady: 0,
      // ...and the two clauses that can ride that cooldown (skills.mjs
      // gateClausesOf): what each swing takes off it, and what the finisher
      // that finds it ready deals on top.
      gateRelief: tr.rule.gateRelief ?? null,
      gateComboAdd: tr.rule.gateComboAdd ?? 0,
      // A rider that lives only inside a WINDOW one of the actives opens -
      // a status its cast puts on you, whose script plays this step on your
      // swings while it is worn. `perHit` is the hook's own granularity
      // (onInflictDamage is raised per damage instance), and `proxy` says the
      // same step also plays on a summon's hit.
      //
      // A window can also be opened by a KIND of press (`window.on`: every
      // weapon skill, or every class skill), be closed by another kind
      // (`window.closeOn`), and hold a counted number of swings
      // (`window.charges`): the status is applied that many stacks deep and
      // each swing spends one. `left` is what the current window still holds.
      window: tr.rule.window ?? null, perHit: !!tr.rule.perHit, proxy: !!tr.rule.proxy,
      // Per HIT of the swing rather than per damage instance of it
      // (onInflictHit: skills.mjs swingHookPerLanding).
      perLanding: !!tr.rule.perLanding,
      openUntil: -Infinity, openSeconds: 0, left: 0,
      // A rider that plays only WHILE a status this build applies is on the
      // target (`hasStatus(ctx.target, Skill.S)`), and one that refreshes
      // that status when it plays (`getStatus(...).refresh(null)`). Envenom
      // is both. The fight knows whether S is ticking, so this is a gate it
      // answers per event rather than a rate anyone has to assume.
      whileDot: tr.rule.whileStatus ?? null, refreshes: tr.rule.refreshes ?? null, refreshCredit: 0,
      // This rider's own fire may be a hit that lands on you, and so open a
      // window a hit on an ally opens (`landsOnCaster`: a prayer whose area
      // admits its caster).
      landsOnCaster: tr.landsOnCaster ?? null,
      // The row this rider is started as - a prayer priced off the status it
      // applies is still that one prayer.
      row: tr.via ?? String(tr.prof.id).split('#')[0],
      // The last press on which another rider's fire (re)applied the status
      // this one is played from - see the per-event loop.
      reappliedAt: -Infinity,
      fires: 0, damage: 0, heal: 0, shield: 0,
    });
  }
  // A STATUS'S OWN STEP, PLAYED WHEN THE STATUS IS RE-APPLIED. Lethal Poison's
  // "Blast": `onTryAddStatus(sInf, target) { if (sInf.id == Skill.S &&
  // hasStatus(target, Skill.S)) target.getStatus(Skill.S).playStep(Steps.Blast) }`
  // - a direct hit of the status itself, once per application attempt that
  // finds it already up. It is a line of its own (the capture logs a row per
  // hit) and it is raised by the applier below, never by a swing or a cast.
  for (const d of dots) {
    if (!d.reapply?.prof) continue;
    const out = cast(d.reapply.prof);
    if (!out.damage && !out.heal && !out.shield) continue;
    d.reapplyTrig = {
      prof: d.reapply.prof, source: d.source ?? null, out,
      rule: { kind: 'per-dot-reapply', why: d.reapply.why ?? null },
      instances: 1, on: 'reapply', parent: null, chance: 1,
      bleedOnly: false, statusFilter: null, gate: 0, nextReady: 0,
      window: null, perHit: false, proxy: false, openUntil: -Infinity, openSeconds: 0, left: 0,
      whileDot: null, refreshes: null, refreshCredit: 0,
      // The fields every rider carries for the windows another rider's fire
      // opens; a re-application hit opens none and holds no charge.
      landsOnCaster: null, row: String(d.reapply.prof.id).split('#')[0], reappliedAt: -Infinity,
      // Its riders are live state (see `liveRiders`), so the line prints
      // what a hit was worth on average rather than the bare price.
      meanPerCast: true,
      fires: 0, damage: 0, heal: 0, shield: 0,
    };
    triggers.push(d.reapplyTrig);
  }

  // WHO OPENS A WINDOW A LANDING ON THE HERO OPENS, AND FOR HOW LONG - kept
  // per fight so a press left out of the order for buying nothing (see
  // `simulate`) can be said with what holds the window without it. One
  // status can host several riders, each carrying the same window: the first
  // stands for it. `seconds` is what each landing ADDED - a window is not
  // stacked - so the openers' seconds sum to the window's.
  const allyWindows = new Map();
  for (const g of triggers) {
    const w = g.window;
    if (w?.opensOn?.allyHit && !allyWindows.has(w.from ?? g.prof.id)) allyWindows.set(w.from ?? g.prof.id, g);
  }
  let landingTally = new Map();
  const noteLanding = (g, opener, added) => {
    const key = g.window.from ?? g.prof.id;
    if (allyWindows.get(key) !== g) return;
    let w = landingTally.get(key);
    if (!w) {
      // `riders`: the lines that play inside this window. `counted`: a
      // window a swing SPENDS (its seconds are then what the landings armed,
      // not what stood - a spend closes it early).
      const riders = triggers.filter((x) => x.window?.opensOn?.allyHit && (x.window.from ?? x.prof.id) === key).map((x) => x.prof.id);
      w = { status: key, name: g.prof.name, riders, counted: !!g.window.charges, seconds: 0, by: new Map() };
      landingTally.set(key, w);
    }
    let b = w.by.get(opener.id);
    if (!b) { b = { id: opener.id, name: opener.name, opens: 0, seconds: 0 }; w.by.set(opener.id, b); }
    b.opens += 1; b.seconds += added; w.seconds += added;
  };

  // The order riders are taken in on one event: a rider whose fire puts
  // another rider's status up (`window.opensOn.firesOf`) goes first, so the
  // second sees what the first did to it on this very press. Everything else
  // keeps its place, and nothing but that loop reads this order.
  const openerHosts = new Set(triggers.map((g) => g.window?.opensOn?.firesOf).filter(Boolean));
  const opensAnother = (g) => (openerHosts.has(String(g.prof.id).split('#')[0]) ? 0 : 1);
  const fireOrder = openerHosts.size ? [...triggers].sort((a, b) => opensAnother(a) - opensAnother(b)) : triggers;

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
  // `b.extended.to`, not `b.duration`: the engine no longer writes the
  // extension back onto the buff, because that object is cached across
  // evaluations and feeding it its own output compounded the duration on
  // every call.
  const timedDur = new Map(timedBuffs.filter((b) => b.extended).map((b) => [b.status, b.extended.to]));
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
  function rollout(pick, t0, state0, self0, foe0, live0, chainIdx0 = 0, timeCursors = null, memory0 = null) {
    const horizon = Math.min(t0 + lookahead, fight);
    // Cheap copies: the horizon is short and these are all small.
    const cd = state0.map((s) => ({ charges: s.charges, nextCharge: s.nextCharge, cdScale: s.cdScale ?? 1 }));
    // ...including the pools. Without them the rollout believes it can spend a
    // resource it does not have and scores a rotation nobody can play.
    const bank = new Map([...pools].map(([k, p]) => [k, p.value]));
    const affordable = (prof) => (prof.costs ?? []).every((c) => c.spendOnly || c.all || !bank.has(c.atb)
      || bank.get(c.atb) >= costOf(c, prof) - 1e-9);
    const spend = (prof) => {
      for (const c of prof.costs ?? []) {
        if (bank.has(c.atb)) bank.set(c.atb, c.all ? 0 : Math.max(0, bank.get(c.atb) - costOf(c, prof)));
      }
    };
    // The income's memory goes on from where the fight's stands, on a copy.
    const memory = memory0 ? cloneMemory(memory0) : new Map();
    const gain = (atb, amount) => {
      const p = pools.get(atb);
      if (!p || !(amount > 0)) return;
      bank.set(atb, Math.min(p.max, (bank.get(atb) ?? 0) + amount * p.factor));
    };
    const awardTo = (list, isSig, skillId) => {
      for (const g of list) {
        if (g.excludeSignature && isSig) continue;
        gain(g.atb, g.amount * (g.chance ?? 1)
          * (g.distinct ? distinctShare(memory, g, kindOf(skillId), critChance) : g.critGated ? critChance : 1));
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
    // A status gated on a count of ready prayers is left out of the rollout:
    // it does not follow which prayers are ready (it fires no rider at all),
    // so it cannot say whether the press would hand the status out.
    const putUp = (applies) => {
      for (const b of applies?.self ?? []) {
        if (timedIds.has(b.status) && readyAllows(b, null)) { self.set(b, t + lifeOf(b)); dirty = true; }
      }
      for (const d of applies?.target ?? []) {
        if (!readyAllows(d, null)) continue;
        foe.set(d, t + (d.duration > 0 ? d.duration : fight)); dirty = true;
      }
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
        // (a status behind a use count is not worth anything a rollout this
        // short can promise)
        if (d.trigger?.uses) continue;
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
          // (Latched against what the rollout itself has up - `cdScaleOf`.)
          const scale = cdScaleOf(st);
          if (cd[chose].charges === a.maxCharges) {
            cd[chose].nextCharge = t + a.execOffset + scaledCooldown(a, scale);
          } else {
            cd[chose].nextCharge = relatch(cd[chose].nextCharge, t, cd[chose].cdScale ?? 1, scale);
          }
          cd[chose].cdScale = scale;
          cd[chose].charges--;
        }
        // (What it finds in a pool it empties, before it empties it.)
        const found = poolHeldBy(a.prof, (atb) => bank.get(atb));
        spend(a.prof);
        const out = found && found.add !== 0 ? cast(a.prof, st, { add: found.add }) : cast(a.prof, st);
        total += worth(out.damage, out.heal, out.shield);
        for (const g of out.gains ?? []) gain(g.atb, g.amount);
        if (hasIncome) {
          const isSig = a.prof.type === 'SignatureSkill';
          if (weaponSkillIds.has(a.prof.id)) awardTo(income['weapon-skill'], isSig, a.prof.id);
          awardTo(onCastGain.get(a.prof.id) ?? [], isSig, a.prof.id);
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
        if (hasIncome) awardTo(link.prof.isCombo ? income.combo : income.attack, false, link.prof.id);
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
          cd[i].nextCharge += scaledCooldown(actives[i], cd[i].cdScale ?? 1);
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
    const hit = rand && rollCrit
      ? (prof, st, xr) => rollCrit(cast(prof, st, xr), rand) : cast;
    // An authored order that keeps its own place - a recorded press sequence
    // has a cursor - starts over with every fight (`policy.reset`). One
    // evaluation plays the fight more than once: each roll here, and a whole
    // second pass in engine.mjs when a conduit buff or the crowd-control gate
    // is closed on the first one's schedule. A schedule left where the
    // previous fight ended is a spent one, and the fight that was RETURNED
    // pressed nothing: `verify --replay` printed every pressed line of the
    // 2026-10-13 Warrior's rotation as MISSING, beside "45/48 presses
    // replayed" - the count of the pass that was thrown away.
    if (policy?.reset) policy.reset();
    for (const a of actives) { a.casts = 0; a.hits = 0; a.damage = 0; a.heal = 0; a.shield = 0; a.instantCasts = 0; a.instantSaved = 0; a.poolPresses = 0; a.poolHeld = 0; a.split = null; }
    for (const d of dots) { d.damage = 0; d.heal = 0; d.ticks = 0; d.credit = 0; d.split = null; d.splitUnknown = false; }
    for (const w of dotChannels) w.credit = 0;
    for (const g of triggers) {
      g.fires = 0; g.damage = 0; g.heal = 0; g.shield = 0; g.nextReady = 0; g.spentAt = -Infinity; g.split = null;
      g.openUntil = -Infinity; g.openSeconds = 0; g.refreshCredit = 0; g.reappliedAt = -Infinity;
    }
    for (const mu of cdMutations) { mu.credit = 0; mu.bank = 0; mu.markUntil = -Infinity; mu.instantUntil = -Infinity; }
    landingTally = new Map();
    for (const p of poolDots) {
      p.fed = 0; p.damage = 0; p.heal = 0; p.ticks = 0; p.expires = -1; p.nextTick = 0;
      p.owed = 0; p.paid = 0; p.perTick = 0;
    }

    // Which entry is whose second press, by index, now that the order is final.
    const recastChild = new Map(), recastParent = new Map();
    actives.forEach((a, i) => {
      if (!a.recast) return;
      const pi = actives.findIndex((p) => !p.recast && p.prof.id === a.recast.of);
      if (pi >= 0) { recastChild.set(pi, i); recastParent.set(i, pi); }
    });
    // A skill opens the fight with its full bank of charges - that is exactly
    // what a charge is - and regains one per cooldown thereafter. A recast
    // opens with none: only its first press hands it one.
    const state = actives.map((a) => (a.recast
      ? { charges: 0, nextCharge: Infinity, openUntil: -Infinity }
      : { charges: a.maxCharges, nextCharge: a.cooldown }));
    const live = new Map();   // dot -> { expires, nextTick, out }
    const upSelf = new Map(); // buff -> expires
    const upFoe = new Map();  // debuff -> expires
    // How many times a returning weapon-skill charge extended a status
    // (`extendOn`), by status - for the build's report.
    const chargeExtends = new Map();
    let t = 0;
    let chainIndex = 0;
    // A USE RIDER (rotation.useRiders, skills.mjs `useRiderOf`): a passive
    // that runs its own cooldown as a clock. The next press of a row that can
    // spend it takes the amount in its damage-ratio bracket and starts the
    // cooldown (onUseSkill: `if (!isInCooldown()) { ctx.magicDmgMult += x;
    // consumeCooldown(); }`), and while that cooldown runs every critical
    // damage instance of the owner's own plays the rider's step. The clock
    // opens ready, like every cooldown of the fight, and takes the sheet's
    // Cooldown Reduction (measured: back 19.0-19.5 s after a 20 s cooldown
    // was spent at 4%, 13.0-13.5 s under +30 more).
    const useRegs = (rotation.useRiders ?? [])
      .map((u) => ({ u, spenders: new Set(u.spenders ?? []), readyAt: 0, fires: 0, crits: 0 }));
    // Every booking of a line's crit halves is also where the fight learns
    // how many critical hits it just landed: a summon's swings are booked
    // nowhere here (they are settled in closed form, and reach the owner's
    // scripts as onProxyDamage), and the rider's own step is priced after the
    // fight, so neither feeds it - which is the script's own two exclusions.
    const splitAdd = (s, out, weight = 1, scale = 1, events = null) => {
      const crits = splitTally(s, out, weight, scale, events);
      if (!(crits > 0)) return;
      for (const r of useRegs) if (r.u.critStep && t < r.readyAt) r.crits += crits;
    };
    // What each `distinct` gain last paid (see `distinctShare`), and how many
    // events asked it and how many it paid, for the line that says so.
    const incomeMemory = new Map();
    const incomeTally = new Map();
    // The end of the last COMPLETED basic attack. The chain clock runs from
    // here to the start of the next one, and nothing else refreshes it.
    let lastSwingEnd = -Infinity;
    // Seconds spent in swings a recorded press stopped before their hit
    // (a replay only - see "a recorded press inside this swing").
    let voidedTime = 0;

    // --- THE DOSE GATE, and what rides a status's own hits -------------------
    //
    // A gated status is not applied by an event; it is applied by a COUNT of
    // them. Each skill category the gate names lays one unique dose on the
    // target - the hook is onInflictHitNewTarget, raised by
    // BaseSkill.onHit@6233 ops 18-78 once per (cast context, target), so a
    // cast that lands no hit of its own lays none - and when `need` distinct
    // doses are held they are all consumed and the status is applied. Nothing
    // rolls, so nothing is thinned: the cadence is the rotation's own.
    const gates = gatedDots.map((d) => ({
      d, need: d.gate.need,
      doseOf: new Map(d.gate.categories.map((c) => [c.on, c.status])),
      held: new Set(), fires: 0,
    }));
    for (const d of gatedDots) { d.applications = 0; d.reapplications = 0; }
    // Is this dose status on the target right now?
    const doseHeld = (statusId) => gates.some((g) => {
      for (const [cat, sid] of g.doseOf) if (sid === statusId && g.held.has(cat)) return true;
      return false;
    });
    // A bank on the OWNER fed by those doses and spent by the combo finisher
    // (Improved Mixture) - see where the chain is played.
    const comboBank = rotation.comboBank
      ? { ...rotation.comboBank, value: 0, spent: 0, combos: 0 } : null;
    // Is a status this build applies on the target at `at`? A tick that lands
    // exactly as the status runs out still finds it there.
    const statusUp = (statusId, at) => {
      const d2 = dotByStatus.get(statusId);
      const s2 = d2 ? live.get(d2) : null;
      if (s2 && s2.expires >= at) return true;
      for (const p of poolDots) if (p.status === statusId && p.expires >= at && p.owed > 0) return true;
      return false;
    };
    // A debuff counter on the target that one status's own hits feed and the
    // same status's hits read (Venom Infusion: +1 per Blast, to a cap, and
    // +2.5% a stack on every hit of Lethal Poison). dot -> { stacks, expires }
    const stackOn = new Map();
    // WHAT A STATUS HIT TAKES FROM LIVE STATE, as additions to its one
    // additive dmgMult bracket and to its crit chance. All of these are
    // `+=` hooks evalDamage@6124 runs on the hit - the attacker's skills
    // (onInflictDamageEval) and the target's statuses (onReceiveDamageEval) -
    // so they sum with each other and with the status-type talents
    // `statusHit.scale` already carries:
    //
    //   * per status of a TYPE on the target (Intent to Kill: `if (dmg.isDoT)
    //     dmg.dmgMult += vars.damage * target.getStatusesCount(isType(T))` -
    //     instances, not stacks, the hitting status itself included);
    //   * per stack of a counter this status feeds (Venom Infusion);
    //   * a crit chance on one named step (Deadly Poison on the Blast);
    //   * the applier's own crit chance while a crit-granting status is on
    //     the target (Gaping Wound's onReceiveDamageEval, for the status
    //     types it names). A DoT-typed status hit starts from zero crit
    //     chance (SkillContext.initVars@5241 ops 10-30), so these are all it has.
    const NO_LIVE = { add: 0, critAdd: 0 };
    const liveRiders = (d, at, stepId = null) => {
      let add = 0, critAdd = 0;
      if (d.isDoT) {
        for (const r of rotation.dotRiders ?? []) {
          let n = 0;
          for (const sid of r.statuses) if (statusUp(sid, at)) n++;
          add += r.amount * n;
        }
      }
      const sr = d.stackRider ? stackOn.get(d) : null;
      if (sr && sr.expires >= at) add += d.stackRider.per * sr.stacks;
      if (stepId && d.reapply?.stepId === stepId) {
        critAdd += d.reapply.critAdd ?? 0;
        add += d.reapply.add ?? 0;
      }
      for (const sid of d.critFrom ?? []) if (statusUp(sid, at)) critAdd += critChance;
      return { add, critAdd };
    };
    // ...and what such a hit SETS OFF once it has landed: the counter it
    // feeds, and cooldown its owner earns back per damage instance (Noxious
    // Stratagem: a roll per hit of the status for seconds off every weapon
    // skill still on cooldown - reduceWeaponsCooldown). Expectation-priced in
    // the deterministic fight, rolled when the fight is.
    const afterStatusHit = (d, at, stepId = null) => {
      const sr = d.stackRider;
      if (sr && (sr.fedByStep == null || sr.fedByStep === stepId)) {
        const cur = stackOn.get(d);
        const held = cur && cur.expires >= at ? cur.stacks : 0;
        stackOn.set(d, { stacks: Math.min(sr.cap, held + 1), expires: at + sr.duration });
      }
      for (const r of d.cooldownRiders ?? []) {
        const give = rand ? (rand() < r.chance ? r.seconds : 0) : r.chance * r.seconds;
        if (!(give > 0)) continue;
        for (let i = 0; i < actives.length; i++) {
          if (!weaponSkillIds.has(actives[i].prof.id)) continue;
          if (state[i].charges >= actives[i].maxCharges) continue;
          state[i].nextCharge -= give;
        }
      }
    };
    // How many statuses of the OWNER's sit on the target beside `except` -
    // what a count-scaled companion rider (Gash) reads. Distinct statuses:
    // every other dot still running, every debuff window still open, each
    // dose held, a mark a reset is waiting for, a fed counter.
    //
    // WHOSE a status is, is the script's own test:
    // `s.getSourceSkill().owner == owner`. A status a script adds with
    // addStatus carries that script's skill as its source
    // (SkillScript.addStatus@6879 ops 13-16), so it is the owner's. The
    // visible Lethal Dose MARKER over the doses is not added that way:
    // enforceStatusCount@6887 passes a null source skill (op 16, handed to
    // addStatus at op 27), Status.getSourceSkill@15829 then falls back to the
    // status itself, and a status's owner is whoever wears it - the target.
    // So the doses count and the marker does not.
    // MEASURED 2026-10-13 (five stacks, the +10 penetration of the passive
    // up, nothing else on the dummy): Lethal Poison alone 82, with the Chaos
    // Mark 90, with one dose and its marker 97, with two doses 104, and a
    // dose more or the trinket's curse or a Stun 112 - one tenth a status,
    // the marker never one of them.
    //
    // ON THE TARGET is the game's own loop - `for (s in dmg.target.statuses)`
    // in Daggers_DuplicatePoison_Passive.onInflictDamageEval - so a ticking
    // status of the owner's that the OWNER wears is not in it. `live` holds
    // those too since a talent can hang a heal over time on the poison's
    // application (Recovery Toxins, `addStatus(owner, ...)`), and counting it
    // paid a self heal out as Gash damage.
    const wornByFoe = (x) => x.to == null || x.to === 'Target';
    const foeIds = new Set();   // one set for the run: this is asked at every tick of the counting dot
    const ownStatusesOnFoe = (at, except) => {
      foeIds.clear();
      for (const [od, os] of live) if (od !== except && os.expires > at && wornByFoe(od)) foeIds.add(od.status);
      for (const [b, exp] of upFoe) if (exp > at && b.status !== except.status) foeIds.add(b.status ?? b);
      for (const p of poolDots) if (p.owed > 0 && p.expires > at && wornByFoe(p)) foeIds.add(p.status);
      // A mark a cooldown reset is waiting for is a status of the owner's on
      // the target while it stands (the Chaos Mark: Demonic Bite's own hit
      // effect lays it, six seconds, and Infernal Plunge consumes it).
      for (const mu of cdMutations) {
        if (mu.mark && mu.bank > 0 && mu.markUntil > at && mu.mark.status !== except.status) foeIds.add(mu.mark.status);
      }
      for (const g of gates) {
        for (const cat of g.held) foeIds.add(g.doseOf.get(cat));
        // What the build keeps on the target while the gated status or any
        // of its doses is there (statuses a talent applies off them).
        const up = statusUp(g.d.status, at);
        for (const c of g.d.gate.companions ?? []) if (up || (c.withDoses && g.held.size)) foeIds.add(c.status);
      }
      for (const [od, sr] of stackOn) if (sr.expires > at && sr.stacks > 0) foeIds.add(od.stackRider.status);
      return foeIds.size;
    };
    // A talent rider on your own casts that holds only while the TARGET
    // wears a status of some type (`dmg.target.hasStatusType(T)`), for the
    // types the fight tracks as statuses of its own. Finish the Job is the
    // shape: +crit chance on swings and finishers against a poisoned target.
    // It used to be credited whole, with nothing poisoned in the fight.
    const scopeHolds = (scope, prof) => (scope === 'all' ? true
      : scope === 'attack' ? (prof.isFiller === true && prof.isCombo !== true)
        : scope === 'combo' ? prof.isCombo === true
          : scope === 'attack-or-combo' ? prof.isFiller === true
            : scope === 'weaponSkill' ? WEAPON_SKILL_TYPES.has(prof.type) : false);
    const typedRiders = (prof, at) => {
      let add = 0, critAdd = 0;
      for (const r of whileTyped) {
        // `row` is a cast's own clause: its hits and nobody else's.
        if (r.scope === 'row' ? prof.id !== r.row : !scopeHolds(r.scope, prof)) continue;
        let up = false;
        for (const sid of r.statuses) if (statusUp(sid, at)) { up = true; break; }
        if (!up) continue;
        if (r.field === 'critChance') critAdd += r.amount;
        else if (r.field === 'dmgMult') add += r.amount;
      }
      return { add, critAdd };
    };

    // A NEXT-CAST REGISTER, carried as the PROBABILITY that it is armed rather
    // than as a coin - the same convention crit already uses, whose binomial
    // mean is the deterministic number. A finisher arms it with probability
    // `chance` and a proc that lands while it is already armed is WASTED, so
    // the update is `p += (1 - p) * chance` and never saturates past 1.
    //
    // Spending it is ONE event, not two. The cost check runs at press and the
    // forced-crit check at damage eval, which looks like it should let a second
    // press slip in free while the first cast is still running - but
    // `GameObject.doUseSkill@4651` op 10 calls `stopActiveSkill@4655` as its
    // FIRST action (ops 0-9 skip it only for a NonInterupting row or the skill
    // already running), and that is `BaseSkill.stop@6200` on the running skill,
    // which runs `onStop` and removes the status before the new cast evaluates
    // anything. Pressing again cannot outrun its own stop. Queueing cannot
    // either: a queued press resolves when the current cast ENDS, which is the
    // same removal. So one arm buys exactly one free critical cast.
    const emp = new Map();   // skill id -> { chance, p }
    // A register the COMBO FINISHER itself consumes, re-armed by a cast
    // counter rather than by the finisher: HighVoltage's status forces the
    // next finisher critical and is planted on every mage chain cast, which
    // the Chaincast talent raises every `armEveryActiveCasts` active casts.
    // The chain is the counter's, not the crit register's: without High
    // Voltage `chance` is 0 and everything below still runs - the free
    // press, the volleys, the cooldown handed back - while the finisher
    // keeps its own roll.
    const comboRegs = [];
    for (const e of empowerments ?? []) {
      if (e.consume === 'combo') {
        comboRegs.push({
          chance: e.chance, every: e.armEveryActiveCasts ?? 0,
          firesConduits: !!e.firesConduits,
          conduitVolleys: e.conduitVolleys ?? (e.firesConduits ? 1 : 0),
          // The chain SPEND semantics: the arm is consumed by the next
          // weapon-skill press, which pays no Spark, fires every
          // onMageChainCast conduit volley, resets its own cooldown, and
          // arms the forced-crit register - all one instant, per
          // Mage_SparkMaster.onPreSkillProc@45397.
          chainSpend: e.chainSpend ?? null,
          // How long an unspent arm lasts: the arm status's own authored
          // duration, read with the register. A status that authors none
          // does not expire.
          armWindow: e.armWindow > 0 ? e.armWindow : Infinity,
          p: 0, armed: false, armedAt: -Infinity, count: 0,
        });
      } else emp.set(e.skill, { chance: e.chance, p: 0 });
    }
    const armAll = () => { for (const r of emp.values()) r.p += (1 - r.p) * r.chance; };
    let activeCasts = 0;
    let chainFeedAt = 0;
    // Is this chain arm still standing at `at`? ONE test, used by the spend,
    // the hold, the counter and Chain Strike alike - they used to carry
    // three copies of a literal 15 and one site with no expiry at all.
    const chainUp = (r, at) => !!r.chainSpend && r.armed && at - r.armedAt <= r.armWindow;
    // ONE ACTIVE-SKILL USE, as the chain counter sees it. Called from the
    // press site and from the replay feed, so a press the model never made
    // moves the same counter a modelled one does - the feed used to count
    // on its own modulus and arm without a timestamp, so its arms read as
    // expired from second 15 on.
    //
    // The counter FREEZES while an arm is banked -
    // Mage_Talent_Chaincast.onSkillProc@45436 ops 14-16 return outright when
    // the armed status is up - and the arm itself expires unspent after its
    // window. Counting modulo forever banked free chains through every
    // cooldown-starved stretch.
    const countActiveUse = (at) => {
      activeCasts++;
      for (const r of comboRegs) {
        if (!(r.every > 0)) continue;
        if (r.chainSpend) {
          if (r.armed && !chainUp(r, at)) r.armed = false;
          if (r.armed) continue;
          r.count++;
          if (r.count % r.every === 0) { r.armed = true; r.armedAt = at; }
        } else if (activeCasts % r.every === 0) {
          // A register without chain-spend semantics keeps the old arm-time
          // behaviour.
          r.p += (1 - r.p) * r.chance;
          if (r.firesConduits) fireConduits(at);
        }
      }
    };
    // --- summons, and the charge bank they feed -------------------------------
    // A summoner's cast opens a window; its pets swing on their own authored
    // period inside it, each swing crediting a pet line AND one charge; a
    // combat timer and the summon-expiry proc feed the same bank; the charge
    // dump spends the whole bank as one multiplied cast. All expectations,
    // like everything else in the deterministic fight.
    const summonState = (rotation.summons ?? []).map((sp) => {
      let out = cast(sp.petProf, bare);
      // The summoner's own script can raise its pets' crit chance - the
      // Almaz grants its imps +15% - and the guard that is unanswerable on
      // the player's casts is always TRUE on the pet line. It is a crit
      // CHANCE (`hit.critChance += vars.var2`), so it joins the chance the
      // swing already rolls rather than multiplying the finished swing: a
      // cast priced with its die re-reads `fixed + base x (1 + p(cd-1))` at
      // the raised p; one priced without takes the game's flat 1.5.
      // MEASURED 2026-10-13: the imps' swings crit 23 times in 56 (41%) on a
      // sheet of 22.1% + the rank-2 15%.
      if (sp.petCritBonus > 0) {
        const cr = out.critRoll;
        if (cr && cr.cd > 1) {
          const p = Math.min(1, cr.p + sp.petCritBonus);
          out = { ...out, damage: cr.fixed + cr.base * (1 + p * (cr.cd - 1)), critRoll: { ...cr, p } };
        } else out = { ...out, damage: out.damage * (1 + sp.petCritBonus * 0.5) };
      }
      return { sp, out, until: 0, hits: 0, damage: 0 };
    });
    const chargeBank = rotation.chargeDump ? { ...rotation.chargeDump, value: 0, spent: 0, presses: 0 } : null;
    // --- an OWN-STACK MULTIPLIER: a bank the actives fill and one press spends
    //
    // Clawdius is the shape. Every ACTIVE press banks a stack of `Tide Rising`
    // and `Tide Rising Uppercut` spends the whole bank for +50% each - x6.0 at
    // the ten-stack cap, measured in game to the integer.
    //
    // It is SIMULATED rather than closed-form because the answer is
    // spacing-sensitive, not merely rate-sensitive: the bank's own six-second
    // duration refreshes on each application, so what binds is the longest GAP
    // between presses, not the cast rate. A Rogue at rank 2 has the same
    // 0.335 presses a second as at rank 1 and banks three fewer stacks, because
    // its gaps fall either side of six seconds. min(cap, rate x cooldown) gets
    // rank 3 about right and rank 2 wrong by three stacks, which is the whole
    // difference between a weapon that is worth pressing and one that is not.
    const stackMult = rotation.stackMult
      ? { ...rotation.stackMult, value: 0, last: -Infinity, spent: 0, presses: 0 }
      : null;
    // What the bank holds NOW: the whole climb is lost, not one stack of it,
    // when the gap since the last application exceeds the status's duration.
    const bankAt = (at) => (!stackMult || at - stackMult.last > stackMult.window
      ? 0 : Math.min(stackMult.cap, stackMult.value));
    // The next-weapon-skill register: armed by the finisher, by a named cast
    // or by any cast that applies a named status, and spent by the next
    // weapon-skill press. HOW it is spent is the register's own hook:
    //
    //   level 'ctx' - written in onSkillProc, which tryConsumeCharge@9631
    //     raises once per USE before the cast's hits exist. The script writes
    //     the cast's CONTEXT (`ctx.dmgMult += x`, `ctx.critChance = 1`) and
    //     every hit the cast then makes copies it
    //     ($ScriptHitData.__constructor__@6318 op 10 -> $BaseSkillContext.copy@5232), so the
    //     whole cast is RE-PRICED with the amount in the one additive dmgMult
    //     bracket and, where the script says so, every hit a critical strike.
    //   level 'hit' - written in onInflictDamageEval with a stop() behind it
    //     (Demondash's finisher status). Kept as the straight multiplier it has
    //     always been: the cast's other riders are ~4%, so the additive-bracket
    //     exact form differs by under a point, stated not hidden.
    //
    // A build can carry more than one - a finisher-armed register on the main
    // hand and Domination on the arsenal - and each is its own status with
    // its own armer, so each keeps its own flag. A press spends every one
    // that is armed: they are separate scripts answering the same hook.
    const wsRegs = (rotation.wsRiders ?? (rotation.wsRider ? [rotation.wsRider] : []))
      .map((r) => ({ r, armed: false, fires: 0 }));
    // Who arms one: 'combo' is the finisher, anything else a set of cast ids.
    const armWs = (id, isCombo = false) => {
      for (const w of wsRegs) {
        if ((isCombo && w.r.armedBy === 'combo') || (w.r.armedBy instanceof Set && w.r.armedBy.has(id))) w.armed = true;
      }
    };
    // THE FINISHER'S MARK (rotation.comboRider): a weapon skill's hit marks
    // the target for the mark's own duration and the next finisher spends
    // it. One mark, one finisher hit.
    const comboMark = rotation.comboRider ? { r: rotation.comboRider, until: -Infinity, fires: 0 } : null;
    // DETONATING MARKS: stacks an applier's hits leave on the target, to the
    // cap, on one refreshing timer; the next weapon-skill cast that lands
    // Magic damage spends the lot for the mark's step, once per stack.
    const detoState = (detonations ?? []).filter((d) => d.prof && d.out)
      .map((d) => ({ d, value: 0, last: -Infinity, fires: 0, stacks: 0, damage: 0 }));
    // The passive's own cooldown is a cooldown like any other: it opens the
    // fight ready and it takes the sheet's Cooldown Reduction.
    // MEASURED 2026-10-13 (Inner Demon, rank 2 or more: 20s; Cooldown
    // Reduction 4): its ready marker was up at the first weapon skill of every
    // block and came back 19.26-19.74s after each of twelve spends, on a
    // marker polled every half second - a cooldown of 19.2s, where an
    // unreduced 20s could not show under 20.0.
    let wsResetReadyAt = wsReset ? 0 : Infinity;
    let wsResetShield = 0, wsResetFires = 0;
    let summonCursor = 0;
    const advanceSummons = (until) => {
      if (!(until > summonCursor)) return;
      const dt = until - summonCursor;
      if (chargeBank && chargeBank.timerPeriod > 0) {
        chargeBank.value = Math.min(chargeBank.cap, chargeBank.value + dt / chargeBank.timerPeriod);
      }
      for (const s2 of summonState) {
        const overlap = Math.max(0, Math.min(until, s2.until) - summonCursor);
        if (overlap > 0) {
          const petSwings = overlap * s2.sp.count / s2.sp.period;
          s2.hits += petSwings;
          s2.damage += petSwings * s2.out.damage;
          if (chargeBank && chargeBank.petFed) {
            chargeBank.value = Math.min(chargeBank.cap, chargeBank.value + petSwings);
          }
        }
        // The expiry proc: a chance at a charge per pet, once per window end.
        if (chargeBank && s2.sp.elapsedChargeChance > 0
          && s2.until > summonCursor && s2.until <= until) {
          chargeBank.value = Math.min(chargeBank.cap,
            chargeBank.value + s2.sp.elapsedChargeChance * s2.sp.count);
        }
      }
      summonCursor = until;
    };
    let swings = 0, combos = 0, busy = 0, fillerTime = 0;
    // Non-DoT physical damage EVENTS, which is what a stack counter arms on.
    let physicalHits = 0;
    // EVERY damage instance, of any affinity, which is what an onInflictDamage
    // hook rolls on - the same quantity engine.mjs estimates before the fight
    // to price a proc-applied buff's uptime, except that here the fight has
    // already produced it and no estimate is needed.
    let damageEvents = 0;

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
    // `ready` is how many prayers the pressing cast finds ready, for a status
    // its script hands out only at a count of them (`readyAllows`). A press
    // that releases nothing passes none, and such a status is not put up.
    const setUp = (applies, at, ready = null) => {
      for (const b of applies?.self ?? []) {
        if (!timedIds.has(b.status) || !readyAllows(b, ready)) continue;
        upSelf.set(b, at + lifeOf(b));
        stateDirty = true;
      }
      for (const d of applies?.target ?? []) {
        if (!readyAllows(d, ready)) continue;
        // A status the target turns away never stands on it (`foeRefuses`
        // below: a slow or a root on a Boss). Its window used to open all the
        // same - worth nothing itself, the rows that are refused carry only
        // MoveSpeedFactor - and whatever counts the statuses on the foe counted
        // it: Gash read one status more than the target wore.
        if (foeRefuses?.has(d.status)) continue;
        upFoe.set(d, at + (d.duration > 0 ? d.duration : fight));
        stateDirty = true;
        foeApplied(d.status, 1, at);
      }
    };

    // --- what the build lands ON THE FOE, as events --------------------------
    //
    // Four events a kit never needed and a set passive rides. Each is raised
    // where this fight already does the thing the game's hook is named for:
    //
    //   status-apply      a status of the build's lands on the foe - `put`
    //                     (a dot), `setUp` (a debuff), a pool feed, a control
    //                     the cast applies, one of the stacking debuffs below
    //   cc-apply          a cast ATTEMPTS a crowd control (onTryAddStatus)
    //   knockback         an effect of the cast knocks what it hits
    //                     (onApplyKnockback)
    //   weapon-skill-hit  a damage instance of a weapon skill
    //                     (onInflictDamage behind `dmg.isWeaponSkill`)
    //
    // The counts are EXPECTED, like every other event here - a 20% proc on a
    // two-hit swing is 0.4 of an application - and a rider takes whole
    // applications off a running credit, the way `put` thins a proc.
    //
    // A FLOOR, all four: a status the fight holds no state for (a counter on
    // the foe) and a control or a knock inside a step the cast does not play
    // itself are not counted; nor is a knock that authors no force, which is
    // only tallied (`knock-no-force`, no hook of its own - nothing can ride
    // it).
    //
    // ...and so are the statuses the fight keeps in a REGISTER OF THEIR OWN
    // rather than through `put` or `setUp`: the doses a cast lays toward a
    // gated status (`gates`: each is an addStatus on the target, and a
    // re-dose goes through GameObject.addStacks@4637, which raises the hook a
    // status-application rider is written in), the mark a weapon skill
    // leaves for the next finisher (`comboMark`), the stacks a detonating
    // mark collects (`detoState`). None of them is raised as a status landed.
    // What a dose pass CONVERTS is - the gated status goes through `put`.
    // Counted, the doses alone are some 450 more applications in a 200 s
    // fight of a poison build, and move nothing there: the one rider that
    // rides them is at its cap from the conversions already.
    //
    // A status the TARGET TURNS AWAY is not a status landed, wherever the
    // fight would have counted it (`rotation.foeRefuses`, the plan's answer
    // for this target - ent.GameObject.canReceiveStatus@4634 refuses a
    // crowd-control status on an immune unit before anything is applied).
    // The ATTEMPT is still raised: that is `cc-apply`, a different hook. What
    // the fight does with a refused debuff's own window is not changed here -
    // `setUp` opens it as it always has.
    const foeRefuses = rotation.foeRefuses ?? null;
    const eventCount = { 'status-apply': 0, 'cc-apply': 0, knockback: 0, 'weapon-skill-hit': 0, 'knock-no-force': 0 };
    // A STACKING DEBUFF AN EVENT APPLIES. One more stack per application up to
    // the cap, the whole status gone at once when its duration runs out with
    // no new application (GameObject.addStacks@4637: ops 130-144 clamp the count, ops
    // 153-156 refresh the window on every positive application; nothing
    // decrements a stack on a timer). The fight holds it as ONE object per
    // stack count, so the pricing cache keys on how many are up.
    const foeStacks = (rotation.foeDebuffs ?? []).map((fd) => ({
      fd, stacks: 0, obj: null, expires: -Infinity, credit: 0, since: 0,
      applied: 0, consumed: 0, stackSeconds: 0, upSeconds: 0,
      byStacks: Array.from({ length: fd.cap + 1 }, (_, k) => (k
        ? { status: `${fd.status}#${k}`, affixes: fd.affixes, stacks: k, duration: fd.duration } : null)),
    }));
    // Bank the time spent at the current count, and let a lapsed one go.
    const settleFoe = (fs, at) => {
      const end = Math.min(at, fs.expires, fight);
      if (fs.stacks > 0 && end > fs.since) {
        fs.stackSeconds += fs.stacks * (end - fs.since);
        fs.upSeconds += end - fs.since;
      }
      if (fs.stacks > 0 && fs.expires <= at) { fs.stacks = 0; fs.obj = null; }
      fs.since = Math.max(fs.since, Math.min(at, fight));
    };
    const applyFoeStack = (fs, at) => {
      settleFoe(fs, at);
      const fd = fs.fd;
      // A CONSUMER: at `consumeAt` stacks the application is spent instead -
      // the script takes every stack off and plays a step of its own.
      if (fd.consumeAt != null && fs.stacks >= fd.consumeAt) {
        if (fs.obj) { upFoe.delete(fs.obj); stateDirty = true; }
        fs.stacks = 0; fs.obj = null; fs.expires = -Infinity; fs.consumed++;
        fireLinked(fd.consumePlays, 1, at);
        return;
      }
      if (fs.obj) upFoe.delete(fs.obj);
      fs.stacks = Math.min(fd.cap, fs.stacks + 1);
      fs.obj = fs.byStacks[fs.stacks];
      fs.expires = Math.max(fs.expires, at + (fd.duration > 0 ? fd.duration : fight));
      upFoe.set(fs.obj, fs.expires);
      stateDirty = true;
      fs.applied++;
      foeApplied(fd.status, 1, at);
    };
    function foeEvent(name, n, at) {
      if (!(n > 0)) return;
      eventCount[name] = (eventCount[name] ?? 0) + n;
      for (const fs of foeStacks) {
        if (!fs.fd.on.includes(name)) continue;
        fs.credit += n;
        while (fs.credit >= 1 - 1e-9) { fs.credit -= 1; applyFoeStack(fs, at); }
      }
    }
    // A step the fight's own state plays by name: the rider(s) carrying that
    // key fire, and a debuff the same step leaves behind lands with it - first,
    // so what the step then deals is priced with it on (its first tick is the
    // only one that is not).
    function fireLinked(key, n, at) {
      if (!key || !(n > 0)) return;
      for (const fs of foeStacks) {
        if (!fs.fd.on.includes('linked:' + key)) continue;
        for (let i = 0; i < Math.round(n); i++) applyFoeStack(fs, at);
      }
      refresh(at);
      for (const g of triggers) {
        if (g.on !== 'linked' || g.rule.key !== key) continue;
        const share = g.chance * n;
        if (!share) continue;
        const out = hit(g.prof, now);
        g.fires += share;
        damageEvents += (out.hits ?? 0) * share;
        if (out.damage > 0) landed((out.hits ?? 0) * share);
        g.damage += out.damage * share;
        splitAdd(g, out, share);
        g.heal += out.heal * share;
        g.shield += out.shield * share;
      }
    }
    // One or more statuses landed on the foe - or would have: one the target
    // turns away is dropped here, the one place every site goes through.
    // `statusId` is the status that landed: a rider that excludes its own
    // status - `s.status.kind != Skill.<itself>` - is not fed by it.
    let applyDepth = 0;
    function foeApplied(statusId, n, at) {
      if (!(n > 0)) return;
      if (foeRefuses?.has(statusId)) return;
      eventCount['status-apply'] += n;
      // A rider's own application is an application too, and feeds the OTHER
      // riders; two that fed each other would never stop, in the game either.
      if (applyDepth > 1) return;
      applyDepth++;
      for (const w of onStatusApply) {
        if (w.d.status === statusId) continue;
        w.credit += n;
        while (w.credit >= 1 - 1e-9) { w.credit -= 1; put([w.d], at); }
      }
      // The same hook with a status NAMED: a counter that climbs once per
      // application of that one status.
      for (const c of applyCounters) if (c.status === statusId) c.count += n;
      applyDepth--;
    }
    const applyCounters = (rotation.eventProcs ?? []).map((ep) => ({ ep, status: ep.countsStatus, count: 0 }));
    // What a cast lands beyond its damage, counted off the plan: the controls
    // it attempts, the knocks, and each control as a status landed - unless
    // the target turns it away (`foeApplied` asks), or the cast holds that
    // status in this fight itself (`castHolds`), in which case `setUp` or
    // `put` has counted the application already and it is not counted twice.
    const castEvents = rotation.castEvents ?? null;
    const raiseCastEvents = (id, at, scale = 1) => {
      const ce = castEvents?.get(id);
      if (!ce) return;
      if (ce.cc.length) foeEvent('cc-apply', ce.cc.length * scale, at);
      if (ce.knock) foeEvent('knockback', ce.knock * scale, at);
      // A knock that authors no force is not a `knockback` (the plan says
      // why); it is tallied so the build can be told what was left out.
      if (ce.noForce) eventCount['knock-no-force'] += ce.noForce * scale;
      const held = castHolds.get(id);
      for (const status of ce.cc) if (!held?.has(status)) foeApplied(status, scale, at);
    };

    // Income that comes from the clock rather than from an event -
    // `Warrior_InfiniteRage`'s 1 Rage every 3 seconds. Reset per run, and
    // advanced wherever the clock is.
    for (const p of pools.values()) p.value = p.start;
    // Passive regen rides the same clock as scripted time income, on the
    // game's own 3-second tick (measured: Spark arrives as 1.95 every 3.0s,
    // during casts included, never smoothly). Lumping matters: the conduit
    // gauge asks whether the pool sits ABOVE half at the spend, and a lump
    // crosses that line at a different moment than a drip.
    const timeIncome = income.time.map((g) => ({ g, next: g.every }));
    for (const [atb, p] of pools) {
      if (p.regen > 0) timeIncome.push({ g: { atb, amount: p.regen * 3, every: 3 }, next: 3 });
    }
    const advanceIncome = (until) => {
      for (const e of timeIncome) {
        while (e.next <= until) { earn(e.g.atb, e.g.amount, false); e.next += e.g.every; }
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
        // is `dmg.isWeaponSkill`, which is skill type 7 or 8
        // (BaseSkill.isWeaponSkill@6161; 7 alone before build 25782799) - so swings,
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
        // A feed IS an application: the script banks with addStatus(target,
        // <status>, amount), once per damage instance its guard lets through -
        // every hit of the cast, or the share of them that crit.
        if (p.to !== 'Self') {
          foeApplied(p.status, (p.pool.physical ? (out.hitsPhysical ?? out.hits ?? 1) : (out.hits ?? 1))
            * (p.pool.crit ? (out.critRoll?.p ?? critChance) : 1), at);
        }
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
        // (read in Status.refresh on the 2026-08-11 build; Status.refresh@15820
        // is a server-only stub on this client).
        p.expires = Math.max(p.expires, at + (Number.isFinite(p.duration) ? p.duration : fight));
        // A debuff the same script lays beside the pool and that stops itself
        // when the pool's status is gone (skills.mjs companionDebuffOf):
        // Chaos Scorch's rank-3 armour break. Up exactly as long as the pool.
        if (p.debuff) { upFoe.set(p.debuff, p.expires); stateDirty = true; }
      }
    };

    // Advance every live status up to `until`, crediting each tick that lands.
    // A DoT ticks at the value it SNAPSHOT when it was applied, not at the
    // current one - that is SimulationCraft's convention and the one this model
    // follows, and it is why `out` is stored per instance rather than read off
    // the dot.
    //
    // ...ON THE APPLIER'S SIDE. What the TARGET is wearing is read when the
    // tick lands: a tick is a damage instance, and the target's armour and the
    // hooks of the statuses it wears are evaluated on every one.
    // MEASURED 2026-10-13 (Rogue, dummy): one application of Lethal Poison
    // ticked 71, 71, 71, 69, 71, 71, 71, 69, 69 ... as Chaos Scorch's armour
    // break came and went on the target; Gaping Wound's bleed, applied 0.8 s
    // BEFORE Death Mark landed, read 189 on all four of its ticks (165 plain,
    // x1.15); the trinket's curse 42 inside the mark and 37 outside it.
    // So a tick is re-priced when the target's side has changed since the
    // application: the applier's side as it was snapshot, the target's as it
    // stands. (A DurationBased carry is a sum of two applications and keeps
    // its snapshot.) Whether the applier's own buffs are read live too is
    // not something the capture shows - nothing on the Rogue's sheet moved
    // inside a tick's life.
    // (What is on the target AT the tick is what the fight has put there,
    // less what will have run out by then: the ticks between two decisions
    // are advanced in one go, and a debuff that lapses among them must not
    // be read by the ones after it.)
    const targetKeyOf = (s) => (s.tkey ??= s.target.map((x) => x.status).sort().join(','));
    const foeAt = [];
    const tickOutput = (d, st, at) => {
      if (!st.snap || st.fixedOut) return st.out;
      foeAt.length = 0;
      for (const [x, exp] of upFoe) if (exp > at) foeAt.push(x);
      const key = foeAt.length ? foeAt.map((x) => x.status).sort().join(',') : '';
      if (key === targetKeyOf(st.snap)) return st.out;
      if (st.liveKey !== key) {
        st.liveKey = key;
        st.liveOut = dotOutput(d, stateOf(st.snap.self, [...foeAt]));
      }
      return st.liveOut;
    };
    const tickTo = (until) => {
      advanceSummons(until);
      for (const [d, st] of live) {
        while (st.nextTick <= Math.min(until, st.expires) && st.nextTick <= fight) {
          const tOut = tickOutput(d, st, st.nextTick);
          // THE STACK COUNT IS LIVE, not snapshot. `getStackFactor@21771` reads
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
          //
          // Since build 25782799 the count is wider, and the fight holds all
          // of it: the Rogue's doses, the debuffs its talents keep on a
          // poisoned target and a mark a reset is waiting for are statuses
          // of the owner's too - and the visible marker over the doses is
          // not (`ownStatusesOnFoe`).
          //
          // ON THE WEARER: the script walks `dmg.target.statuses`, the
          // statuses on whoever this one ticks on. A status its owner wears
          // (a heal over time on YOU, which `live` holds beside the foe's
          // dots) is not among them - counted, a self-heal read as damage -
          // and `ownStatusesOnFoe` leaves those out (`wornByFoe`).
          const countAdd = d.perOtherStatus ? d.perOtherStatus * ownStatusesOnFoe(st.nextTick, d) : 0;
          if (statusHitScale) {
            // ONE additive bracket: the count rider, the live riders, the
            // status-type talents and whatever the priced tick already
            // carried (`st.out.riders`: a mark on the target, a rider naming
            // the status) are all `dmg.dmgMult +=` on the same hit. So the
            // tick is re-priced from its PLAIN value - before any hook - with
            // the whole bracket as it stands at this tick, and the crit the
            // hooks give it is a die of its own on top. Raw or not: see
            // `statusHit` in damage.mjs.
            const lr = d.hasLiveRiders ? liveRiders(d, st.nextTick) : NO_LIVE;
            const x = statusHitScale.parts(d, lr.add + countAdd, lr.critAdd, tOut.riders ?? 0);
            // (`plain` is absent from a tick priced by hand, which has no hook
            // inside it to take back out.)
            const plain = (tOut.plain ?? tOut.damage) * k * x.mult;
            const dmg = x.p > 0 ? plain * (1 + x.p * (x.cd - 1)) : plain;
            d.damage += dmg;
            // The tick's two halves. Its die is the hooks' (`x.p`) or the
            // source's own (`ownCrit`, a status that is not DoT-typed);
            // both at once are two dice on one hit, and those halves are not
            // known apart.
            if (tOut.ownCrit) {
              if (x.p > 0 || !tOut.critRoll || !(tOut.damage > 0)) d.splitUnknown = true;
              else splitAdd(d, tOut, 1, dmg / tOut.damage, 1);
            } else if (x.p > 0) {
              splitAdd(d, { damage: dmg, critRoll: { p: x.p, cd: x.cd, hits: 1, base: plain, fixed: 0 } }, 1, 1, 1);
            } else splitAdd(d, { damage: dmg }, 1, 1, 1);
          } else {
            // No hook reader handed in (a fight built by hand): the snapshot
            // and the count rider, as priced.
            d.damage += tOut.damage * k * (1 + countAdd);
            if (tOut.critRoll || tOut.critFree) splitAdd(d, tOut, 1, k * (1 + countAdd), 1);
            else d.splitUnknown = true;
          }
          d.heal += st.out.heal * k;
          d.ticks++;
          // A tick that deals damage is a damage instance of the owner's.
          if (tOut.damage > 0) landed(1);
          if (d.afterHit) afterStatusHit(d, st.nextTick, null);
          // What is rolled on this status's own hits ('tick-of').
          { const fed = onTickOf.get(d.status); if (fed) put(fed, st.nextTick); }
          // A regular dot's tick is an event too. Riders that asked for a
          // bleed skip these - `fireDotTick` filters - but an any-dot or
          // status-filtered rider fires here - where the accepted build's
          // Virulent Magic lived, on Lethal Poison's own ticks.
          fireDotTick(d.status, false, k);
          settleInstances(st.nextTick);
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
            landed(1);
            fireDotTick(p.status ?? null, true);
            settleInstances(p.nextTick);
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
    // How often the conduits were triggered, whatever they are: a build whose
    // slots hold only conduits that BUFF has no line to read the cadence off,
    // and its buff's stacks follow these events all the same.
    let conduitEvents = 0;
    const fireConduits = (at) => {
      conduitEvents++;
      for (const g of conduitTriggers) {
        for (let i = 0; i < (g.instances ?? 1); i++) {
          const out = hit(g.prof, now);
          g.fires += 1;
          damageEvents += out.hits ?? 0;
          if (out.damage > 0) landed(out.hits ?? 0);
          g.damage += out.damage;
          splitAdd(g, out);
          g.heal += out.heal;
          g.shield += out.shield;
        }
      }
      // ConduitResidues: +Spark at a chance, once per trigger EVENT (its
      // hook is onConduitTriggers, raised once by triggerAllConduits@30806).
      if (gauge?.residues > 0 && conduitTriggers.length) earn(gauge.atb, gauge.residues, false);
    };
    /** Spend, then fire if the pool was above the gauge BEFORE the spend. */
    const spendAndGauge = (amount, at) => {
      if (!gaugePool || !(amount > 0)) return;
      const before = gaugePool.value;
      gaugePool.value = Math.max(0, before - amount);
      if (gaugePool.max > 0 && before / gaugePool.max > gauge.ratio + 1e-12) fireConduits(at);
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
        // once per logged row: on the accepted build Virulent Magic recorded
        // exactly five procs per Lethal Poison tick at five stacks, against
        // the model's one (both rows were rebuilt in build 25782799). Applied
        // only to riders that NAME their status - the per-stack evidence is
        // exactly there, and widening it to every any-dot rider without its
        // own measurement would be the flattering guess this file refuses.
        const mult = g.statusFilter && !isPool ? Math.max(1, stacks) : 1;
        let share = (rand ? (rand() < g.chance ? 1 : 0) : g.chance) * mult;
        if (!share) continue;
        const out = hit(g.prof, now);
        g.fires += share;
        damageEvents += (out.hits ?? 0) * share;
        if (out.damage > 0) landed((out.hits ?? 0) * share);
        g.damage += out.damage * share;
        splitAdd(g, out, share);
        g.heal += out.heal * share;
        g.shield += out.shield * share;
      }
    };
    // The APPLICATION clock, for status-named onInflictStatusEval riders:
    // GameObject.addStacks@4637 is the hook's only dispatch site, so the
    // rider fires once per application or stack-gain of the status it names
    // and never on a tick. The accepted build's Virulent Magic showed it:
    // 71k captured procs within 5ms of Lethal Poison applications. The tick
    // lane above never sees such a rider.
    const fireDotApply = (statusId, expected = 1) => {
      if (!(expected > 0)) return;
      for (const g of triggers) {
        if (g.on !== 'dot-apply') continue;
        if (g.statusFilter && g.statusFilter !== statusId) continue;
        const share = (rand ? (rand() < g.chance ? 1 : 0) : g.chance) * expected;
        if (!share) continue;
        const out = hit(g.prof, now);
        g.fires += share;
        damageEvents += (out.hits ?? 0) * share;
        if (out.damage > 0) landed((out.hits ?? 0) * share);
        g.damage += out.damage * share;
        splitAdd(g, out, share);
        g.heal += out.heal * share;
        g.shield += out.shield * share;
      }
    };

    // THE INSTANCE CLOCK. A status whose applier rolls in onInflictDamage with
    // no predicate is rolled on every damage instance its owner lands: each
    // row of a cast, of a swing, of a rider those play, each tick of a status
    // and each hit a status deals - its own included. The fight raises no
    // such event, so the sites that land damage count it (`landed`) and the
    // count is settled where the fight's clock stands (`settleInstances`):
    // after a press or a swing and everything it set off, and after each tick.
    //
    // The deterministic fight lets one application through every 1/p
    // instances, like every other thinned application; the rolled one rolls
    // each instance. An applier that refuses to renew its own status
    // (`blocked`: `!hasStatus(dmg.target, <it>)`) does not roll while it
    // stands, so nothing accrues then and the count starts over when the
    // status ends - a cycle of the status's life plus 1/p instances, which is
    // the mean of the renewal process the game plays.
    //
    // A summon's swings are not counted: they reach the owner's scripts as
    // onProxyDamage, another hook.
    let pendingInstances = 0;
    const landed = (n) => { if (onInstance.length && n > 0) pendingInstances += n; };
    const settleInstances = (at) => {
      const n = pendingInstances;
      if (!(n > 0)) return;
      pendingInstances = 0;
      for (const w of onInstance) {
        const d = w.d;
        if (d.blocked) {
          const st = live.get(d);
          // (Standing through its own last tick: that tick is the status's.)
          if (st && st.expires >= at - 1e-9) { w.credit = 0; continue; }
        }
        let fire = false;
        if (rand) {
          const whole = Math.floor(n);
          for (let i = 0; i < whole && !fire; i++) fire = rand() < w.chance;
          if (!fire && n > whole) fire = rand() < w.chance * (n - whole);
        } else {
          w.credit += w.chance * n;
          if (w.credit >= 1 - 1e-9) { w.credit = d.blocked ? 0 : w.credit - 1; fire = true; }
        }
        if (fire) put([{ d, chance: 1, credit: 0 }], at);
      }
    };
    // A status handed out on the Nth use inside a window (`trigger.uses`,
    // skills.mjs triggerOf): the uses still inside the window, per status.
    const useLog = new Map();
    // `spent`: the pools the cast that raised this emptied, by attribute. A
    // status whose roll is per point of one (`perPoint`: Acidic Splatter's
    // `checkProba(vars.chance * cp)`, read at the Finisher's first hit, 0.02 s
    // before the points are consumed) is rolled at the points THIS cast found.
    const put = (list, at, hits = 1, spent = null) => {
      const chanceOf = (entry, d) => (d.perPoint
        ? Math.min(1, d.perPoint.chance * (spent?.[d.perPoint.atb] ?? 0))
        : entry.chance ?? d.chance ?? 1);
      for (const entry of list) {
        {
          const u = (entry.d ?? entry).trigger?.uses;
          if (u) {
            const key = entry.d ?? entry;
            const log = useLog.get(key) ?? [];
            useLog.set(key, log);
            log.push(at);
            while (log.length && at - log[0] > u.within) log.shift();
            if (log.length < u.count) continue;
            log.length = 0;
          }
        }
        // The APPLICATION CLOCK counts expected applications, per HIT: the
        // script rolls its chance on every damage instance a swing lands, so
        // a dual-dagger swing at 20% is 0.4 expected applications - and the
        // capture's 2.35 applications/s only reconciles per-hit. The status
        // instance below still applies at most once per event (the thinning
        // gate); the rider clock must not be thinned with it.
        {
          const d0 = entry.d ?? entry;
          const p0 = chanceOf(entry, d0);
          fireDotApply(d0.status, p0 * Math.max(1, hits));
          // ...and, where the FOE wears it, the same count is statuses landed
          // on the foe - a heal-over-time on yourself is not one.
          if (d0.to !== 'Self') foeApplied(d0.status, p0 * Math.max(1, hits), at);
        }
        // A channel wrapper carries its own chance and its own thinning
        // credit; the descriptor underneath is shared, so every channel feeds
        // the SAME live status instance - which is the whole point.
        const d = entry.d ?? entry;
        const p = chanceOf(entry, d);
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
          // One more stack, up to the cap. Read from `GameObject.addStacks@4637`: the
          // count carried forward is the current one, EXCEPT under
          // `DurationBased`, where it is `ceil(stacks x durationProgress)` -
          // sampled at the moment of application and never continuously, which
          // is why a stack table needs no per-tick decay. Nothing anywhere
          // decrements a stack on a timer; the whole status expires at once.
          //
          // Every data-driven application is exactly ONE stack:
          // `props.status.stacks` is authored on none of the 100 Status steps,
          // so `?? 1` at SkillStep.hx:262 is what every one of them uses.
          // `Override` STOPS the old instance and creates a fresh one (ops
          // 40-48 of addStatus on the 2026-08-11 build; GameObject.addStatus@4636
          // is a server-only stub on this client): stacks reset to the new application's
          // own, and the duration can SHORTEN - never-shorten belongs to
          // refresh. The three rows authoring it today are inert item
          // carriers, so this branch waits for the first combat Override.
          const carried = d.stacking === 'Override' ? 0
            : d.stacking === 'DurationBased'
              ? Math.ceil(st.stacks * Math.max(0, (st.expires - at) / Math.max(1e-9, st.window)))
              : st.stacks;
          st.stacks = Math.min(d.stacks ?? 1, carried + 1);
          st.window = d.stacking === 'Override' ? expires - at : Math.max(expires, st.expires) - at;
          if (d.stacking === 'DurationBased') {
            const ticks = Math.max(1, Math.round(
              (Number.isFinite(d.duration) ? d.duration : fight) / d.tick));
            const left = Math.max(0, Math.min(ticks, Math.ceil((st.expires - at) / d.tick - 1e-9)));
            // (The remainder rides in the plain tick too, and the carried
            // total is no longer the roll the fresh application handed over.)
            out = {
              ...out,
              damage: out.damage + (st.out.damage * left) / ticks,
              heal: out.heal + (st.out.heal * left) / ticks,
              ...(out.plain != null ? { plain: out.plain + ((st.out.plain ?? 0) * left) / ticks } : {}),
              critRoll: undefined, critFree: undefined,
            };
            st.fixedOut = true;
          }
          // The window is max(new duration, what was left) - a refresh never
          // SHORTENS a status (Status.refresh, read on the 2026-08-11 build;
          // Status.refresh@15820 is a server-only stub now). Override is the one
          // policy that CAN shorten, because it is a stop-and-recreate.
          st.expires = d.stacking === 'Override' ? expires : Math.max(expires, st.expires);
          st.out = out;
          st.snap = now; st.liveKey = undefined;
        } else {
          live.set(d, {
            expires, nextTick: at + d.tick, out,
            // The state it was priced in, for the ticks (see `tickOutput`).
            snap: now,
            // A fresh status lands at one stack: `Status.__constructor__` never
            // sets the field, so `addStacks(1)` takes it from 0 to 1.
            stacks: 1,
            // The window a DurationBased carry-over is measured against.
            window: expires - at,
          });
        }
        // A ticking status can carry stat rows as well, and those belong to
        // the target for as long as it wears the status. A cast's own
        // statuses arrive through `applies.target`; one a TALENT applies has
        // no cast to carry it, so it rides the application here - Acidic
        // Splatter's poison is also Armor -10% and MagicArmor -10% for its
        // six seconds, and until this the shred reached no hit at all.
        if (d.debuff) {
          upFoe.set(d.debuff, at + (d.debuff.duration > 0 ? d.debuff.duration : fight));
          stateDirty = true;
        }
      }
    };
    // THE GATE CONVERTS. The application attempt comes first and is an event
    // of its own - onTryAddStatus, which the script guards with
    // `hasStatus(target, <the status>)`: when the status is already up, its
    // re-apply step is played (the Blast) and it is refreshed; when it is
    // not, it simply starts. What else rides the attempt ('apply-of') lands
    // either way. That the attempt hook runs BEFORE the status lands - so
    // the first application plays no Blast - is the script's own hasStatus
    // test plus the tooltip ("If it is already applied, deal direct ...");
    // its raise site is in GameObject.addStatus@4636, a server-only stub on
    // this client. The refresh is the accepted one-timer reading: never
    // shortened, tick cadence kept (Status.refresh@15820, read on the
    // 2026-08-11 build and a stub now).
    const convert = (g, at) => {
      const d = g.d;
      const st = live.get(d);
      const wasUp = !!st && st.expires > at;
      if (wasUp && d.reapplyTrig) {
        const tg = d.reapplyTrig;
        const lr = liveRiders(d, at, d.reapply.stepId);
        const base = hit(tg.prof, now);
        // The same bracket and the same die as a tick of the status (above):
        // what the priced step already carries, the hooks added to it, and
        // the crit they give a hit that starts with none.
        const x = statusHitScale ? statusHitScale.parts(d, lr.add, lr.critAdd, base.riders ?? 0) : null;
        const plain = base.damage * (x ? x.mult : 1);
        const dmg = x && x.p > 0 ? plain * (1 + x.p * (x.cd - 1)) : plain;
        tg.fires += 1;
        damageEvents += base.hits ?? 0;
        if (dmg > 0) landed(base.hits ?? 0);
        tg.damage += dmg;
        if (x && x.p > 0) {
          if (base.critRoll) tg.splitUnknown = true;
          else splitAdd(tg, { damage: dmg, critRoll: { p: x.p, cd: x.cd, hits: 1, base: plain, fixed: 0 } }, 1, 1, base.hits ?? 1);
        } else splitAdd(tg, base, 1, x ? x.mult : 1);
        tg.heal += base.heal;
        tg.shield += base.shield;
        d.reapplications++;
        afterStatusHit(d, at, d.reapply.stepId);
        // A hit of a status is a damage instance like its ticks are, for
        // whatever rides those.
        fireDotTick(d.status, false, 1);
      }
      put([d], at);
      put(onApplyOf.get(d.status) ?? [], at);
      d.applications++;
      g.fires++;
    };
    // Weapon sub-skill uses a pass of the trigger loop fired, waiting to be
    // raised as weapon-skill events, and how many the fight raised in all.
    const subUses = [];
    let subSkillUses = 0;
    const applyDots = (skillId, at, ev = {}) => {
      const { weaponSkill = false, attack = false, combo = false, cast: wasCast = false } = ev;
      // A cast-attached status applies once per cast; the per-hit channels
      // roll their chance on every damage instance the event landed - a
      // dual-dagger swing rolls twice.
      const hits = Math.max(1, ev.hits ?? 1);
      if (!ev.subUse) put(onCast.get(skillId) ?? [], at);
      // ...and what rides THIS skill's cast from someone else's script. One
      // roll per cast: the guard is `skillId == Skill.X && isFirstHit`.
      if (wasCast && !ev.subUse && ev.landed !== false) put(onCastOf.get(skillId) ?? [], at, 1, ev.spent ?? null);
      if (weaponSkill) put(onWeaponSkill, at, hits);
      // A weapon skill that LANDS A HIT marks the target (a cast that deals
      // nothing marks nothing: the script arms in onInflictHit).
      if (weaponSkill && comboMark && (ev.hits ?? 1) > 0) comboMark.until = at + comboMark.r.window;
      for (const s of detoState) {
        // Spend first: a cast that both detonates and applies (none today)
        // would find the stacks it left on an earlier hit, not its own.
        if (weaponSkill && ev.magic === true && s.value > 0 && at - s.last <= s.d.window) {
          s.damage += s.d.out.damage * s.value;
          s.stacks += s.value;
          s.fires++;
          s.value = 0;
        }
        if (s.d.appliers.includes(skillId) && (ev.hits ?? 1) > 0) {
          s.value = Math.min(s.d.cap, (at - s.last > s.d.window ? 0 : s.value) + (ev.hits ?? 1));
          s.last = at;
        }
      }
      if (attack) put(onAttack, at, hits);
      if (combo) put(onCombo, at, hits);
      // The dose pass. The four predicates are separate `if`s in the script
      // and are skill TYPES, so one cast is one category: BaseSkill.isWeaponSkill@6161
      // (types 7, 8), BaseSkill.isClassSkill@6158 (9), BaseSkill.isFinalAttack@6154 (4, the
      // chain's last link - NOT the signature), BaseSkill.isSignature@6159 (17-20).
      // Only a cast that LANDED a hit of its own: the hook is raised by
      // onHit, and a class skill whose enemy-facing step is a Status step
      // (Death Mark) or that only buffs its owner goes through
      // SkillStep.applyStatus@5999, not hitEntity - no hit, no dose. Read
      // from the dispatch, not measured (the audit says what to count).
      //
      // It runs BEFORE this event's cooldown riders and procs because the
      // game runs it first: BaseSkill.onHit@6233 raises the new-target hooks at ops
      // 18-78 and onInflictHit only at ops 102-114.
      if (gates.length && ev.landed) {
        const cats = [];
        if (weaponSkill) cats.push('weapon-skill');
        if (ev.classSkill) cats.push('class-skill');
        if (combo) cats.push('combo');
        if (ev.signature) cats.push('signature');
        for (const g of gates) {
          for (const cat of cats) {
            if (!g.doseOf.has(cat)) continue;
            // One application of that category's dose. A category already
            // dosed adds nothing to the count (each dose row caps at one
            // stack) - and nothing to whatever banks on doses either. The
            // bank listens on onInflictStatus, and that hook has ONE raise
            // site on this build: GameObject.onApplyStatus@4602 ops 15-19,
            // called by Status.start@15819 op 3, called by
            // Status.postInit@15818 op 15 - once per Status object that
            // starts. Re-dosing a held category starts none: the dose is
            // found by getStackableStatus@4629 (Status.stacksWith@15830:
            // same kind, both without a duration, same instigator) and goes
            // to GameObject.addStacks@4637, which raises onInflictStatusEval (ops 46,
            // 76), the receiver's hooks (ops 99, 128, 157) and a refresh
            // (op 156), never onInflictStatus. That the found status skips
            // Status.create was read in GameObject.addStatus on the
            // 2026-08-11 build, and that a running status is not started
            // again in Status.refresh; GameObject.addStatus@4636 and
            // Status.refresh@15820 are server-only stubs on this client. So
            // the income is one stack per NEW dose: `need` of them per
            // conversion, and one per category, once, in a build whose gate
            // never fills.
            if (!g.held.has(cat) && comboBank && comboBank.feeds.includes(g.doseOf.get(cat))) {
              comboBank.value = Math.min(comboBank.cap, comboBank.value + 1);
            }
            g.held.add(cat);
            if (g.held.size >= g.need) {
              convert(g, at);
              g.held.clear();
            }
          }
        }
      }
      // An ACTIVE press - the only caller that says `cast` - is `ctx.isSkill`.
      if (wasCast && onSkill.length) put(onSkill, at);
      // What this cast lands on the foe beyond its damage (see `foeEvent`).
      if (weaponSkill) foeEvent('weapon-skill-hit', hits, at);
      if (!ev.subUse) raiseCastEvents(skillId, at);
      // Resources ride the same events. `excludeSignature` is the Warrior's own
      // rule: a signature skill does not generate the Rage it spends.
      if (hasIncome) {
        const isSig = ev.signature === true;
        const award = (list) => {
          for (const g of list) {
            if (g.excludeSignature && isSig) continue;
            // A crit-gated gain pays on the fraction of hits that crit; a
            // `distinct` one pays a skill other than the last it paid.
            let share = g.critGated ? critChance : 1;
            if (g.distinct) {
              share = distinctShare(incomeMemory, g, kindOf(skillId), critChance);
              const tl = incomeTally.get(g) ?? { asked: 0, paid: 0 };
              tl.asked++; tl.paid += share;
              incomeTally.set(g, tl);
            }
            earn(g.atb, g.amount * (g.chance ?? 1) * share, g.liveFactor !== false);
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
        // Bank a mark whenever a supplier LANDS; a supply-gated reset spends
        // one, and without one it simply does not fire. Ungated, the dash
        // pressed at three times the rate its marks could arrive.
        //
        // A supplier is a press or a link of the chain alike: Demonic Bite is
        // the finisher of Nibsham's Liberators' chain and its hit carries the
        // Chaos Mark (the effect's own `status`), so a rotation that only
        // swings still marks. Counted on presses alone, that weapon's dash was
        // reset by nothing but Void Fangs - MEASURED 2026-10-13: 14 Infernal
        // Plunges landed in 91 s against a 12 s cooldown with Void Fangs never
        // pressed, each after a finisher.
        // And the mark is a status (`mu.mark`): it runs out, and the target
        // holds no more of it than its row stacks to.
        if (mu.supply && (wasCast || combo || attack) && mu.supply.includes(skillId)) {
          if (mu.mark) {
            mu.bank = Math.min(mu.mark.stacks, (mu.markUntil > at ? mu.bank : 0) + 1);
            mu.markUntil = mu.mark.duration != null ? at + mu.mark.duration : Infinity;
          } else mu.bank++;
        }
        // 'magic-crit': every Magic damage instance of the owner's that
        // crits rolls the mutation. The cast or swing brings its expected
        // count; one success among them is all a reset needs.
        // 'skill-hit': every damage instance of ONE NAMED skill's cast rolls
        // it (Nectar-infused Blade's refund on each hit of Flower Spiral).
        // The cast brings its hit count; a reset needs one success among
        // them, a refund is paid once for each.
        const hit = mu.on === 'host' ? (skillId === mu.host)
          : mu.on === 'skill-hit' ? (wasCast && skillId === mu.of && (ev.hits ?? 1) > 0)
            : mu.on === 'magic-crit' ? (ev.magicCrits ?? 0) > 0
              : mu.on === 'attack' ? attack
                : mu.on === 'combo' ? combo
                  : mu.on === 'attack-or-combo' ? (attack || combo)
                    : weaponSkill;
        if (!hit) continue;
        const q = mu.chance * (mu.critGated ? critChance : 1);
        const perHit = mu.on === 'skill-hit';
        const p = mu.on === 'magic-crit'
          ? (mu.kind === 'reset' ? anyOf(mu.chance, ev.magicCrits, ev.magicCritHits) : mu.chance * ev.magicCrits)
          : perHit ? (mu.kind === 'reset' ? 1 - Math.pow(1 - q, hits) : q * hits)
            : q;
        if (!(p > 0)) continue;
        // How many times it fires on this event: once at most, except a
        // per-hit refund, which several hits of one cast can each pay.
        let fire = 0;
        if (perHit && mu.kind !== 'reset') {
          if (rand) { for (let i = 0; i < Math.round(hits); i++) if (rand() < q) fire++; }
          else { mu.credit += p; fire = Math.floor(mu.credit); mu.credit -= fire; }
        } else if (rand) fire = rand() < p ? 1 : 0;
        else { mu.credit += p; if (mu.credit >= 1) { mu.credit -= 1; fire = 1; } }
        if (!fire) continue;
        if (mu.supply) {
          if (mu.mark && !(mu.markUntil > at)) mu.bank = 0;   // the mark ran out unspent
          if (mu.bank <= 0) continue;
          mu.bank--;
        }
        // "...and make it instant": the status that comes with the reset is
        // applied whether or not there was a cooldown to hand back, and it
        // waits its own duration for the cast it speeds up.
        if (mu.instant) mu.instantUntil = at + mu.instant.window;
        const stT = state[mu.targetIdx];
        const aT = actives[mu.targetIdx];
        if (stT.charges >= aT.maxCharges) continue;   // nothing to give back
        if (mu.kind === 'reset') {
          if (stT.nextCharge > at) stT.nextCharge = at;
        } else {
          // The seconds can be one of two authored values, picked by whether
          // a named status is on the target at the hit (`alt`): Venomous
          // Assassin gives 1 s back, 2 s when the target does NOT carry the
          // Final-Combo dose. This runs after the dose pass above, as
          // onInflictHit runs after the new-target hooks, so the dose is
          // absent in exactly two cases: nothing in the build lays it (the
          // talent held from a sigil without the tree's root), or this very
          // hit completed the gate and the doses were just consumed.
          const secs = mu.alt && !doseHeld(mu.alt.absent) ? mu.alt.seconds : mu.seconds;
          // ...once for each time it fired on this event (`fire` is above one
          // only for a per-hit refund).
          stT.nextCharge -= secs * fire;
        }
      }
      // Procs ride the same events. Deterministic runs credit the expected
      // fraction of a fire; rolled ones roll. Priced against live state too.
      // A window the FINISHER opens (a prayer made ready by it) opens here,
      // before anything rides this event.
      if (combo) {
        for (const g of triggers) {
          if (!g.window?.opensOn?.combo) continue;
          g.openUntil = at + g.window.duration;
          if (g.window.charges) g.left = g.window.charges;
        }
      }
      for (const g of fireOrder) {
        // A dot-tick proc is raised by `tickTo`, a dot-apply one by the
        // application site, a conduit by the gauge - not by a cast or swing.
        const fires = g.on === 'dot-tick' || g.on === 'dot-apply' || g.on === 'conduit' || g.on === 'reapply' || g.on === 'linked' ? false
          : g.on === 'parent' ? (wasCast && g.parent === skillId)
            : g.on === 'class-skill' ? ev.classSkill === true
            : g.on === 'skill' ? (wasCast && !ev.subUse)
            : g.on === 'weapon-skill' ? weaponSkill
              : g.on === 'attack-or-combo' ? (attack || combo)
                : g.on === 'attack' ? attack : combo;
        if (!fires) continue;
        // Outside the window its host opened, the status is not worn and
        // its script does not run.
        if (g.window && !(at < g.openUntil)) continue;
        // ...and a rider gated on a status of the build's being ON THE
        // TARGET does not play while it is not.
        if (g.whileDot && !statusUp(g.whileDot, at)) continue;
        if (g.gate > 0) {
          if (at < g.nextReady) continue;
          g.nextReady = at + g.gate;
          g.spentAt = at;
        }
        // A counted window spends one stack per swing, on the swing's first
        // hit - so the swing that spends the LAST one plays the step for that
        // hit alone: the status is gone before its second lands.
        let swingHits = hits;
        if (g.window?.charges) {
          if (!(g.left > 0)) continue;
          g.left -= 1;
          if (g.left === 0) { swingHits = 1; g.openUntil = at; }
        }
        // ...and so does a rider whose status ANOTHER rider's fire has just
        // (re)applied on this press: it plays for one hit of it, not for all.
        // Purging Strikes on a four-bolt finisher is the measurement - four
        // rows where no Sunlight fired in the press, one row in most of the
        // presses where Sunlight did (the audit has the counts). Sunlight's
        // damage hands the status out again mid-press; why that costs the
        // other bolts their play is not read, so the one hit is a floor.
        if (g.reappliedAt === at) swingHits = 1;
        // A hook raised per HIT counts the swing's hits, which are fewer
        // than its damage instances when one step carries two effects.
        if (g.perLanding && ev.landings != null) swingHits = Math.min(swingHits, Math.max(1, ev.landings));
        const share = (rand ? (rand() < g.chance ? 1 : 0) : g.chance) * (g.perHit ? swingHits : 1);
        if (!share) continue;
        // A step the finisher's OWN script plays is a hit of that same cast,
        // so it copies what the gate wrote into the cast's context
        // (`ev.ctxAdd`, the `gateComboAdd` of the swing site): measured on
        // Brutal Frenzy's second strike, 188 under Worldsplitter's passive
        // against 145 without, the finisher's own x1.30.
        const ownStep = ev.ctxAdd > 0 && String(g.prof.id).startsWith(`${skillId}#`);
        const out = ownStep ? hit(g.prof, now, { add: ev.ctxAdd }) : hit(g.prof, now);
        g.fires += share;
        // (Its rows are damage instances of the owner's, like the press's.)
        if (out.damage > 0) landed((out.hits ?? 1) * share);
        g.damage += out.damage * share;
        splitAdd(g, out, share);
        g.heal += out.heal * share;
        g.shield += out.shield * share;
        // The same play REFRESHES that status (`status.refresh(null)`): its
        // timer goes back to its full authored life, never shorter than
        // what was left. One refresh per expected play, thinned like any
        // other application.
        if (g.refreshes) {
          g.refreshCredit += share;
          if (g.refreshCredit >= 1 - 1e-9) {
            g.refreshCredit = Math.max(0, g.refreshCredit - Math.floor(g.refreshCredit + 1e-9));
            const rd = dotByStatus.get(g.refreshes);
            const rs = rd ? live.get(rd) : null;
            if (rs && rs.expires > at && Number.isFinite(rd.duration)) {
              rs.expires = Math.max(rs.expires, at + rd.duration);
            }
          }
        }
        // What this fire opens for another rider: a status put up when THIS
        // one deals damage (`firesOf`, by the status that hosts it), or one
        // put on an ally a skill's hit lands on - a released prayer whose
        // area admits its caster, whether or not it heals. Only a WHOLE fire
        // opens that one: a hit either landed or it did not, and a rolled
        // rider's expected share is not an application.
        if (share > 0) {
          const host = String(g.prof.id).split('#')[0];
          for (const h of triggers) {
            const o = h.window?.opensOn;
            if (!o || h === g) continue;
            const lands = o.allyHit && share >= 1 ? g.landsOnCaster : null;
            const opens = (o.firesOf && o.firesOf === host && out.damage > 0) || !!lands;
            if (!opens) continue;
            const until = at + h.window.duration;
            const added = Math.max(0, Math.min(until, fight) - Math.max(at, h.openUntil));
            h.openSeconds += added;
            h.openUntil = Math.max(h.openUntil, until);
            if (lands) noteLanding(h, g.prof, added);
            if (!lands) h.reappliedAt = at;
            if (h.window.charges) h.left = h.window.charges;
          }
        }
        // ...and what this fire lands on the foe beyond its damage: the
        // controls and knocks of the step it played (see `foeEvent`).
        raiseCastEvents(g.prof.id, at, share);
        // A WEAPON SUB-SKILL'S USE IS A WEAPON-SKILL EVENT since build
        // 25782799 (BaseSkill.isWeaponSkill@6161 admits type 8), and the fight raised
        // none for it: the only `weaponSkill` event was the ACTIVE cast site,
        // and no sub-skill is ever an active. A recast that rides its parent
        // is one whole use per fire, so it is raised here - after this pass,
        // not inside it - for what rides the event: the income, the
        // per-weapon-skill procs, the cooldown riders.
        if (g.on === 'parent' && share >= 1 && isWeaponSkill(g.prof)) {
          subUses.push({ id: g.prof.id, hits: out.hits ?? 1, magic: (out.totalMagic ?? 0) > 0 });
        }
        // NOTE deliberately absent: a status a TRIGGER applies. No triggered
        // entry ships an `applies` today, and wiring one through casually
        // would hand a 10%-per-hit proc buff ~100% uptime in deterministic
        // mode (the damage is chance-scaled; an application is not). When the
        // data grows one, thin the applications like `put` does - never put
        // the buff up on every eligible event.
      }
      // The sub-skill uses this pass fired, each as its own weapon-skill
      // event. `subUse` keeps it to the event: no cast-attached status of the
      // row itself (nothing applied one before, and this is not where that
      // changes), and no second look for a follow-up of a follow-up.
      for (const u of subUses.splice(0)) {
        subSkillUses++;
        applyDots(u.id, at, { weaponSkill: true, hits: u.hits, subUse: true, landed: u.hits > 0, magic: u.magic === true });
      }
      // Everything this event landed is in: roll what rides the count.
      if (!ev.subUse) settleInstances(at);
    };

    while (t < fight) {
      // Recharge anything whose timer has come round.
      for (let i = 0; i < actives.length; i++) {
        const a = actives[i], st = state[i];
        while (st.charges < a.maxCharges && st.nextCharge <= t) {
          st.charges++;
          // A status of the hero's that its script extends each time a
          // weapon skill gets a charge back (`extendOn`, skills.mjs): the
          // time is added when the charge returns, if the status still
          // stands at that instant. A charge a RESET hands back comes
          // through here too (a reset sets the clock to now and this loop
          // hands the charge over), as it raises the hook in game.
          if (weaponSkillIds.has(a.prof.id) && !a.recast) {
            for (const [b, exp] of upSelf) {
              if (b.extendOn?.on === 'weapon-skill-charge' && exp > st.nextCharge) {
                upSelf.set(b, exp + b.extendOn.amount);
                chargeExtends.set(b.status, (chargeExtends.get(b.status) ?? 0) + 1);
              }
            }
          }
          st.nextCharge += scaledCooldown(a, st.cdScale ?? 1);
        }
      }

      refresh(t);
      // What a cooldown that starts now is latched at (`cdScaleOf`).
      cdScaleNow = cdScaleOf(now);

      // Which casts are ready and still fit before the bell. "Ready" now means
      // the charge is back AND the pool can pay for it.
      advanceSummons(t);
      // Off-model active presses (a replay feed) advance the chain counter:
      // Blink and MysticEmpowerment fed the live Mage chain while the model
      // never pressed them.
      while (chainFeedAt < chainFeeds.length && chainFeeds[chainFeedAt] <= t) {
        countActiveUse(chainFeeds[chainFeedAt]);
        chainFeedAt++;
      }
      const ready = [];
      for (let i = 0; i < actives.length; i++) {
        // A recast is there only inside the window its first press opened.
        if (actives[i].recast && !(t < state[i].openUntil)) state[i].charges = 0;
        if (state[i].charges <= 0) continue;
        // Nothing ready to release: the press is refused.
        if (actives[i].releases && !triggers.some((g) => g.on === 'parent' && g.parent === actives[i].prof.id
          && (!g.window || t < g.openUntil))) continue;
        if (t + actives[i].occupancy > fight) continue;
        if (!canPay(actives[i].prof)) continue;
        // The charge dump needs at least one banked charge - its own script's
        // checkEnabled refuses an empty press, and the capture shows one.
        // (A bank spent on top of a spin the cast always plays - `plus` -
        // needs none.)
        if (chargeBank && actives[i].prof.id === chargeBank.skill && chargeBank.value < 1 && !chargeBank.plus) continue;
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
          const v = rollout(i, t, state, upSelf, upFoe, live, chainIndex, timeIncome, incomeMemory);
          if (v > best + 1e-9) { best = v; pressed = i; }
        }
        // Waiting is a move. If every ready cast is worth less over the horizon
        // than swinging and saving them, swing - that is what "do not spend both
        // weapon skills inside one window" looks like from the inside.
        if (chain.length && rollout(-1, t, state, upSelf, upFoe, live, chainIndex, timeIncome, incomeMemory) > best + 1e-9) pressed = -1;
      }

      // HOLD THE ARM. An armed chain register is spent by the NEXT weapon-skill
      // press and hands that press a free cast (`chainSpend.resetsCooldown`
      // above), so it is a scarce resource worth a whole extra cast of whatever
      // consumes it - and nothing in the pick prices it. Spending it on the
      // cheaper weapon skill while a dearer one comes back inside this press's
      // OWN occupancy throws that free cast away; swinging instead keeps it and
      // costs only the swing. The horizon is the candidate's occupancy and
      // nothing else: it is exactly the time the press would cost you, so there
      // is no fitted window here.
      //
      // This is what let a Legendary arsenal sim BELOW an Epic one. The rider's
      // extra CooldownReduction rerouted three of a Mage's sixty-one arms off a
      // 621-damage consumer onto a 249-damage one, which cost more than the
      // whole rest of the upgrade was worth - a strictly better item scoring
      // strictly lower. The rollout could not catch it: it never models the
      // register at all, so it prices every arm at zero.
      if (pressed >= 0 && anyArmRival && chain.length && armWorth[pressed] >= 0
        && comboRegs.some((r) => chainUp(r, t))) {
        const occ = actives[pressed].occupancy, w0 = armWorth[pressed];
        for (let j = 0; j < actives.length; j++) {
          if (armWorth[j] <= w0 || state[j].charges > 0) continue;
          if (state[j].nextCharge - t <= occ) { pressed = -1; break; }
        }
      }

      if (pressed >= 0) {
        const a = actives[pressed], st = state[pressed];
        // AN INSTANT CAST: a reset that came with the status this skill's
        // shouldPlayInstantly waits for, still inside that status's window.
        // The press costs what an instant cast costs (profile().instant - no
        // cast bar, the steps an instant cast skips not started), its
        // cooldown anchors where the instant cast's exec step starts, and a
        // rider the status carries for that one cast joins the cast's
        // additive dmgMult bracket below. A cast that takes no control of the
        // hero costs no clock either way.
        const instants = a.prof.instant
          ? cdMutations.filter((mu) => mu.instant && mu.targetIdx === pressed && t <= mu.instantUntil) : [];
        const isInstant = instants.length > 0;
        let occupancy = isInstant && a.occupancy > 0 ? Math.max(a.prof.instant.occupancy, 0.05) : a.occupancy;
        const execOffset = isInstant ? Math.max(0, a.prof.instant.execOffset ?? 0) : a.execOffset;
        const instantAdd = instants.reduce((sum, mu) => sum + (mu.instant.rider?.amount ?? 0), 0);
        for (const mu of instants) if (mu.instant.consumed) mu.instantUntil = -Infinity;
        if (isInstant) { a.instantCasts = (a.instantCasts ?? 0) + 1; a.instantSaved = (a.instantSaved ?? 0) + (a.occupancy - occupancy); }
        if (a.recast) {
          // The second press: it spends itself, and the cooldown is the first
          // press's - restarted from here, and one charge poorer if a reset
          // had handed one back (doConsumeCharge@9633: max(0, charges - 1)).
          st.charges = 0;
          st.openUntil = -Infinity;
          const pi = recastParent.get(pressed);
          if (pi != null) {
            state[pi].charges = Math.max(0, state[pi].charges - 1);
            state[pi].cdScale = cdScaleNow;
            state[pi].nextCharge = t + actives[pi].execOffset
              + scaledCooldown(actives[pi], cdScaleNow);
          }
        } else if (!a.poolGated) {
          if (st.charges === a.maxCharges) {
            st.nextCharge = t + execOffset + scaledCooldown(a, cdScaleNow);
          } else {
            // A charge already on its way goes on at the length THIS press
            // latches (`relatch`): every use of the skill rewrites it.
            st.nextCharge = relatch(st.nextCharge, t, st.cdScale ?? 1, cdScaleNow);
          }
          st.cdScale = cdScaleNow;
          st.charges--;
        }
        // ...and a first press opens its recast, from the moment it lands.
        {
          const ci = recastChild.get(pressed);
          if (ci != null) {
            state[ci].charges = 1;
            state[ci].openUntil = t + execOffset + actives[ci].recast.window;
          }
        }
        // Inner Demon's register: every `every` seconds, the next
        // weapon-skill cast is handed its cooldown back - the ICD starts at
        // the consume, and the rank-3 shield (the life paid) is credited to
        // the passive's own line. The health cost itself is survivability
        // this fight does not track, and that is stated in the plan.
        if (wsReset && weaponSkillIds.has(a.prof.id) && t >= wsResetReadyAt) {
          wsResetReadyAt = t + wsReset.every * cooldownMult * cdScaleNow;
          st.nextCharge = t + execOffset;
          if (wsReset.shieldAmount > 0) wsResetShield += wsReset.shieldAmount;
          wsResetFires++;
        }
        // What the press finds in a pool it empties (`poolHeldBy`), read
        // before it is paid for: the amount it takes back from the profile's
        // full-pool rider, and the points themselves for what rolls on them.
        const found = poolHeldBy(a.prof, (atb) => pools.get(atb)?.value);
        const poolAdd = found ? found.add : 0;
        if (found) { a.poolPresses = (a.poolPresses ?? 0) + 1; a.poolHeld = (a.poolHeld ?? 0) + found.held; }
        // Pay BEFORE the cast pays you, so a skill can never fund itself out of
        // its own gain in the same instant.
        const sparkBefore = gaugePool ? gaugePool.value : 0;
        const sparkCost = gaugePool
          ? (a.prof.costs ?? []).reduce((s, c) => (c.atb === gauge.atb ? s + costOf(c, a.prof) : s), 0) : 0;
        // An armed register makes this cast free with probability p, so the
        // expected spend is `cost x (1 - p)`.
        const reg = emp.get(a.prof.id);
        // An armed MAGE CHAIN is spent by the next weapon-skill press - this
        // one, if it qualifies - and the spend rewrites the cast's whole
        // economy: zero Spark, every onMageChainCast conduit volley, the
        // cooldown handed back, and the forced-crit register planted.
        let chain = null;
        if (comboRegs.length && weaponSkillIds.has(a.prof.id)) {
          chain = comboRegs.find((r) => chainUp(r, t)) ?? null;
          if (chain) chain.armed = false;
        }
        if (chain?.chainSpend?.freeSpark) {
          for (const c of a.prof.costs ?? []) {
            // The free half: Mage_SparkMaster.onPreSkillProc@45397 ops 80-87
            // charge Spark only when !isFree.
            if (c.atb === gauge?.atb) continue;
            const p2 = pools.get(c.atb);
            if (p2) p2.value = Math.max(0, p2.value - costOf(c, a.prof) * (reg ? 1 - reg.p : 1));
          }
        } else {
          pay(a.prof, reg ? 1 - reg.p : 1);
        }
        // No spend, no spend-crossing: the gauge fire belongs to paid casts.
        if (!chain && sparkCost > 0 && gaugePool.max > 0
          && sparkBefore / gaugePool.max > gauge.ratio + 1e-12) fireConduits(t);
        if (chain) {
          for (let v = 0; v < Math.max(1, chain.conduitVolleys); v++) {
            fireConduits(t);
          }
          chain.p += (1 - chain.p) * chain.chance;
          if (chain.chainSpend.resetsCooldown && st.nextCharge > t) st.nextCharge = t;
        }
        // ...and a GUARANTEED critical strike with the same probability. The
        // cast decomposes as `fixed + base x (1 + p(cd-1))`, so lifting the
        // effective crit chance to `p + (1-p) x base` is exactly what a forced
        // crit is worth in expectation. Spending clears the register whether or
        // not it was armed - the status is one-shot either way.
        // The bank is SPENT here, before every other rider, so that the
        // empowerment register, the weapon-skill register and the charge dump
        // all compose on top of a correctly priced cast rather than on a base
        // one. `removeStatus` empties it whether or not it was full.
        let bank = 0;
        if (stackMult && a.prof.id === stackMult.skill) {
          const k = bankAt(t);
          stackMult.value = 0;
          stackMult.spent += k;
          stackMult.presses++;
          bank = stackMult.per * k;
        }
        // ...and so is an armed next-weapon-skill register. One arm buys one
        // press: the status stops itself in the same hook that spends it.
        const wsSpent = weaponSkillIds.has(a.prof.id) ? wsRegs.filter((w) => w.armed) : [];
        for (const w of wsSpent) { w.armed = false; w.fires++; }
        // A context-level register joins the bank in the press's own rider, so
        // the two share the bracket the game puts them both in.
        const ctxAdd = wsSpent.reduce((sum, w) => sum + (w.r.level === 'ctx' ? w.r.amount : 0), 0) + instantAdd + poolAdd;
        const ctxCrit = wsSpent.some((w) => w.r.level === 'ctx' && w.r.forcedCrit === true);
        const tyA = typedRiders(a.prof, t);
        // What the cast's own Hit-step statuses put on the target is there
        // for the hit that lays them (`withHit`, skills.mjs statusesOf): the
        // press is priced with them up. They are set up for everything after
        // it below, as before.
        let hitState = now;
        {
          const own = (a.applies?.target ?? []).filter((d) => d.withHit === true && !upFoe.has(d) && !d.trigger?.readyPrayers);
          if (own.length) hitState = stateOf(now.self, [...now.target, ...own]);
        }
        // A use rider that is ready is spent by this press, if its row can
        // (see `useRegs`): the amount joins the cast's own bracket for that
        // affinity root, and the rider's cooldown starts here.
        let bracket = null;
        for (const r of useRegs) {
          if (t < r.readyAt || !r.spenders.has(a.via ?? String(a.prof.id).split('#')[0])) continue;
          r.readyAt = t + r.u.every * cooldownMult * cdScaleNow;
          r.fires++;
          (bracket ??= {})[r.u.bracketRoot] = (bracket[r.u.bracketRoot] ?? 0) + r.u.amount;
        }
        const plainOut = bracket && chargeBank && a.prof.id === chargeBank.skill
          ? (ctxAdd !== 0 || ctxCrit || tyA.add || tyA.critAdd
            ? hit(a.prof, hitState, { bank, add: ctxAdd + tyA.add, crit: ctxCrit, critAdd: tyA.critAdd })
            : bank > 0 ? hit(a.prof, hitState, bank) : hit(a.prof, hitState))
          : null;
        let out = ctxAdd !== 0 || ctxCrit || tyA.add || tyA.critAdd || bracket
          ? hit(a.prof, hitState, { bank, add: ctxAdd + tyA.add, crit: ctxCrit, critAdd: tyA.critAdd, bracket })
          : bank > 0 ? hit(a.prof, hitState, bank) : hit(a.prof, hitState);
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
        for (const w of wsSpent) {
          if (w.r.level !== 'ctx') out = { ...out, damage: out.damage * (1 + w.r.amount) };
        }
        // The charge dump: one missile per banked charge, the whole bank in
        // one press - damage, hits and the physical counter all scale
        // linearly with the count consumed.
        if (chargeBank && a.prof.id === chargeBank.skill) {
          const banked = Math.min(chargeBank.cap, chargeBank.value);
          const k = banked + (chargeBank.plus ?? 0);
          chargeBank.spent += banked; chargeBank.presses++;
          // Each banked charge spaces the cast out by its own authored delay.
          if (chargeBank.perStackTime > 0 && occupancy > 0) occupancy += banked * chargeBank.perStackTime;
          chargeBank.value = 0;
          // ONE MISSILE OF A PRESS IS NOT ON THE CAST'S CONTEXT, so what the
          // press wrote there (a use rider's bracket) is not on it.
          // READ AND MEASURED: a logged row's hits= is the counter of the
          // context its hit was made on ($DamageResult.__constructor__@15281
          // ops 42-45 take hit.ctx.hitCount; BaseSkill.onHit@6233 ops 1-5
          // add to it; the one other function that writes a context's
          // counter, a projectile's hit closure at Projectile.hx:1545, takes
          // one off just before it calls onHit; nothing starts it over), and
          // on 8 of 8 presses of the 2026-10-13 capture exactly one bolt
          // reads 1 while the others run on one counter. On the four that
          // spent Queen's Decree that bolt alone is priced without the
          // bracket: 31, 31 and 48 critical against 59 (90 critical) at
          // twenty charges, 58 critical against 68 (104 critical) at three.
          // INFERRED: that it is the LAST missile shot, and that the script
          // stopping the cast when the last charge is shot (`checkStop`:
          // `toCast--; if (toCast <= 0) stop(true)`) is why it gets a
          // context of its own. It lands among the last (20th, 19th and 20th
          // of twenty) but not after the cast: fourteen, twelve and thirteen
          // bracketed bolts land after skill_end on those three presses, one
          // of them after the odd bolt. What would read it is the function that
          // builds a projectile's hit context once the cast's own is
          // released, which is not read.
          // So of the k missiles one is priced without the bracket.
          const dmgK = plainOut && out.damage > 0
            ? Math.max(0, k - 1) + Math.min(k, 1) * (plainOut.damage / out.damage) : k;
          out = {
            ...out,
            damage: out.damage * dmgK, heal: out.heal * k, shield: out.shield * k,
            hits: (out.hits ?? 0) * k,
            hitsPhysical: (out.hitsPhysical ?? 0) * k,
            totalPhysical: (out.totalPhysical ?? 0) * dmgK,
            totalMagic: (out.totalMagic ?? 0) * dmgK,
            critPhysical: (out.critPhysical ?? 0) * dmgK,
            critMagic: (out.critMagic ?? 0) * dmgK,
          };
        }
        // ...and every OTHER active press fills it. `ctx.isSkill` is
        // `isWeaponSkill() || isClassSkill() || isSignature()`
        // (BaseSkillAccess.get_isSkill@5193), which is skill types 7, 8, 9 and
        // 17-20 on build 25782799 (BaseSkill.isSignature@6159 also names the ids
        // Mage_SparkMaster and Rogue_MasterPoisoner) - the fight's ACTIVE set,
        // plus the WeaponSubSkill that BaseSkill.isWeaponSkill@6161 now admits. The four
        // base attacks and the combo finisher are types 0-4 and bank NOTHING,
        // which the capture confirms from the other side: 1,497 presses of the
        // Clawdius combo produced 9 applications, 0.6%, against 0.945-1.000
        // for the actives. A sub-skill's use is NOT banked here: it is played
        // as a triggered line, and whether a recast runs onSkillProc like a
        // press is the unread bridge the audit names.
        if (stackMult && a.prof.id !== stackMult.skill) {
          stackMult.value = bankAt(t) + 1;
          stackMult.last = t;
        }
        // A summoner's cast opens (or extends) its window.
        const sum2 = summonState.find((x) => x.sp.from === a.prof.id);
        if (sum2) sum2.until = Math.max(sum2.until, t + sum2.sp.duration);
        // Every ACTIVE cast advances the chain counter; each `every`-th one
        // ARMS the chain. The payoff waits for the next weapon-skill press -
        // the consume site above - which is also when the game raises
        // onMageChainCast; a register without chain-spend semantics keeps the
        // old arm-time behaviour.
        // The counter's own gate is `ctx.skill.isActiveSkill()`
        // (BaseSkill.isActiveSkill@6156: skill types 7, 9 and 17 - weapon,
        // class and signature skills, and NOT the WeaponSubSkill that
        // BaseSkill.isWeaponSkill@6161 now admits).
        if (comboRegs.length && ACTIVE_SKILL_TYPES.has(a.prof.type)) countActiveUse(t);
        a.casts++;
        a.hits = (a.hits ?? 0) + (out.hits ?? 0);
        physicalHits += out.hitsPhysical ?? 0;
        damageEvents += out.hits ?? 0;
        if (out.damage > 0) landed(out.hits ?? 0);
        a.damage += out.damage;
        splitAdd(a, out);
        a.heal += out.heal;
        a.shield += out.shield;
        // A GainAtb effect on the skill itself - Warrior_SurgingForce returns
        // Rage, Mage_RayOfSpark returns a share of MaxSpark - which is authored
        // in ordinary columns and needs the sheet, so it arrives with the cast.
        for (const g of out.gains ?? []) earn(g.atb, g.amount, false);
        feedPools(out, t, a.prof.id);
        // How many prayers this press finds ready - counted here, before the
        // release below spends them. One prayer can be several riders (one
        // per payload), so they are counted by the row they are released as;
        // and only a rider that HOLDS a charge is one (a prayer's window), not
        // every rider that happens to ride this press.
        const readyNow = a.releases
          ? new Set(triggers.filter((g) => g.on === 'parent' && g.parent === a.prof.id
            && g.window?.charges && t < g.openUntil).map((g) => g.row)).size
          : null;
        setUp(a.applies, t, readyNow);
        // ...and the windows it opens for a rider. Re-applying before the old
        // one is out refreshes rather than stacks, and a refresh never
        // shortens; the seconds actually covered are kept for the closed-form
        // riders that need an uptime.
        for (const g of triggers) {
          if (!g.window) continue;
          // Three ways a window names its opener: one cast (`from`), a kind
          // of press (`on` - those are opened under this press's riders,
          // further down, not here), or a description of the casts that open
          // it (`opensOn`: from which slot, weapon skills only or not - a
          // prayer's "a skill of your arsenal weapon").
          const o = g.window.opensOn;
          // "A skill of yours lands on an ally" is a HIT of the pressed row
          // that reaches you - a step that hits its caster, or an area whose
          // filter admits the caster - and nothing less: the hook behind it
          // is onInflictHit, which a status a script hands the owner does
          // not raise, and which asks `hit.isSkill` of the row whose step
          // hit, so neither does a heal landed by a STATUS the press put up.
          const lands = o?.allyHit ? a.landsOnCaster : null;
          if (o?.allyHit) {
            if (!lands) continue;
          } else if (o) {
            if (o.combo || o.firesOf || !(o.sources ?? []).includes(a.source)) continue;
            if (o.weaponSkill && !weaponSkillIds.has(a.prof.id)) continue;
          } else if (g.window.on || g.window.from !== a.prof.id) continue;
          // An area that loops lands again on every tick for as long as you
          // stand in it (`landsOnCaster.lasts`), and each landing puts the
          // status back for its full duration - so the window runs to the
          // last tick and the status's own seconds after it. That you stand
          // in your own area for its whole life is ASSUMED (the audit says
          // so): where you stand is not something this fight has.
          // MEASURED 2026-10-13 (Priest at a dummy, fifteen Faithful Winds):
          // Sunlight was refreshed every half second for the lane's ten
          // seconds after each cast and ran out 6.0 s after the last tick -
          // 15.5-16.0 s a cast. What is still not credited is a status a
          // swing SPENDS being put back by the next tick: a counted window
          // (`charges`) is armed once per press, as before.
          const until = t + g.window.duration + (lands?.lasts ?? 0);
          const added = Math.max(0, Math.min(until, fight) - Math.max(t, g.openUntil));
          g.openSeconds += added;
          g.openUntil = Math.max(g.openUntil, until);
          if (lands) noteLanding(g, a.prof, added);
          // Re-arming REPLACES what was left (the passive removes the status
          // before it adds the new stacks), it does not add to it.
          if (g.window.charges) g.left = g.window.charges;
        }
        applyDots(a.prof.id, t, {
          cast: true,
          weaponSkill: weaponSkillIds.has(a.prof.id),
          classSkill: a.prof.type === 'ClassSkill',
          signature: a.prof.type === 'SignatureSkill',
          hits: out.hits ?? 1,
          landings: out.landings ?? null,
          // Did the cast land a hit of ITS OWN on the enemy? A press whose
          // payload is a status it applies (the status is then the hitting
          // skill, and has no skill type) lands none.
          landed: a.prof.isStatusTick !== true && (out.hits ?? 0) > 0,
          magicCrits: out.magicCrits ?? 0, magicCritHits: out.magicCritHits ?? 0,
          magic: (out.totalMagic ?? 0) > 0,
          // The points this press consumed, for a status rolled on them.
          spent: found ? { [found.atb]: found.held } : null,
        });
        // A window a KIND of press opens, and another kind may close: a status
        // the build's script puts on you when you use a weapon skill and takes
        // off when you use a class skill (or the reverse); or one a passive
        // puts on you with every weapon skill, a counted number of stacks
        // deep, for your next swings to spend. The riders above have already
        // asked - a step played "when the other one is consumed" must find it
        // still up, and one the press itself opens is not worn yet - so the
        // close comes after them, and the open after the close. A close hands
        // back the seconds it cut short.
        {
          const kind = weaponSkillIds.has(a.prof.id) ? 'weapon-skill'
            : a.prof.type === 'ClassSkill' ? 'class-skill' : null;
          if (kind) {
            for (const g of triggers) {
              const w = g.window;
              if (!w?.on) continue;
              if (w.closeOn === kind && t < g.openUntil) {
                g.openSeconds -= Math.max(0, Math.min(g.openUntil, fight) - t);
                g.openUntil = t;
              }
              if (w.on === kind) {
                const until = t + w.duration;
                g.openSeconds += Math.max(0, Math.min(until, fight) - Math.max(t, g.openUntil));
                g.openUntil = Math.max(g.openUntil, until);
                // Re-arming REPLACES what was left (the passive removes the
                // status before it adds the new stacks), it does not add to it.
                if (w.charges) g.left = w.charges;
              }
            }
          }
        }
        // A register armed by an ACTIVE cast rather than the finisher -
        // Mage_Blink_M3's "your next [WeaponSkill]" is the shape.
        // ...or by ANY cast that applies the status its armer listens for:
        // Domination's onTryAddStatus arms on a Stun attempt, whoever makes
        // it. The arm lands with the cast's hits, after this press's own
        // onSkillProc has run, so a stunning weapon skill arms the NEXT one
        // and never itself - which is why the spend above comes first.
        armWs(a.prof.id);
        if (a.via) armWs(a.via);
        const end = t + occupancy;
        tickTo(end); advanceIncome(end);
        busy += occupancy;
        t = end;
        continue;
      }

      // ONE CUMULATIVE CLOCK, from the END of the last completed basic to the
      // START of the next. `ent.Hero.getNextAttackSkill@7811` ops 41-52 test
      // the last used basic's stopTime against ComboWindow when the next
      // attack is requested (the accepted build held the same test in a
      // function of its own, since removed, and reset a counter from
      // Hero.update, which no longer holds any chain logic). It is
      // a single timestamp, never refreshed on a skill's end, so casts,
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
      // `holdChain`: the fight is one in which the chain was never swung (a
      // recorded window of presses with nothing between them). It stands
      // still between casts exactly as a build with no weapon does below.
      // ...and a recorded schedule says when its sitting's first skill state
      // opened (`policy.opensAt`): the hero stood there until then.
      const notOpen = policy?.opensAt ? t < policy.opensAt() - 1e-9 : false;
      const link = chain.length && !holdChain && !notOpen ? chain[chainIndex % chain.length] : null;
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
        // An authored order that is a SCHEDULE says when it next wants to be
        // asked (`policy.nextAt`): with nothing to swing and every cooldown
        // already back, nothing above wakes the fight before the bell, and a
        // recorded press sequence replayed over a held chain pressed nothing
        // at all (0 of 4 on the 2026-10-13 Mage's first block of lone
        // presses).
        if (policy?.nextAt) {
          const want = policy.nextAt(t);
          if (want > t && want < next) next = want;
        }
        if (notOpen) {
          const opens = policy.opensAt();
          if (opens > t && opens < next) next = opens;
        }
        // ...and a charge dump waiting for its first charge comes back when
        // the combat timer banks one, not when a cooldown does: its charge
        // was never spent, so the scan above does not see it either.
        if (chargeBank && chargeBank.timerPeriod > 0 && chargeBank.value < 1 && !chargeBank.plus) {
          const due = t + (1 - chargeBank.value) * chargeBank.timerPeriod + 1e-9;
          if (due > t && due < next) next = due;
        }
        if (!(next > t)) next = fight;
        const stood = next - t;
        tickTo(next); advanceIncome(next);
        t = next;
        continue;
      }
      // A RECORDED PRESS INSIDE THIS SWING. The fight presses between swings,
      // which is the game's own rule for a skill that interrupts nothing: its
      // use waits for the running skill to end. A skill whose row authors
      // `props.interruptStyle` starts at once and stops the swing where it is
      // (`prof.interrupts`, damage.mjs: Skill.canInterruptOnUse@9638 - any of
      // its three cases interrupts a base attack), and a step the swing had
      // not started yet is never started. So when the order is a recorded
      // schedule (`policy.peek`) and its next press is such a skill, due after
      // this swing starts and before it ends:
      //   * before the swing's damage step starts (the row's exec step,
      //     `execOffset`: the first of its steps that executes it), the swing
      //     deals nothing and raises nothing. The chain is still ON this link
      //     - getNextAttackSkill@7811 ops 12-40 take the basic with the latest
      //     skillLastUse whose hit was reached - and the ComboWindow clock,
      //     which runs from the last basic's stop, is not touched;
      //   * after it, the hit stands as it was priced and the swing ends at
      //     the press: the chain advances and the clock runs from there.
      // MEASURED 2026-10-13 (Rogue, 48 rotation segments): 480 chain links
      // closed by a cast's Skill state; "cut before the link's authored
      // step delay - 110 / 230 / 410 / 165 / 400 ms - means no damage row"
      // holds on 461 of them (463 with 10 ms allowed), and 600 ms from the
      // stop of the last basic whose hit landed predicts which link plays
      // next on 3,114 of 3,145 starts. The model's own rotation is not given
      // this: it presses between swings (bench audit says what that assumes).
      let cutAt = null;
      if (policy?.peek) {
        const nx = policy.peek();
        if (nx && nx.t > t + 0.05 && nx.t < t + link.occupancy - 1e-9
          && actives.some((a) => (a.prof.id === nx.id || a.via === nx.id) && a.prof.interrupts)) {
          if (nx.t < t + Math.min(link.prof.execOffset ?? 0, link.occupancy) - 1e-9) {
            // Stopped before its hit: nothing landed, nothing was raised.
            policy.cut?.('voided', link.prof.id, nx.t - t);
            link.voided = (link.voided ?? 0) + 1;
            voidedTime += nx.t - t;
            tickTo(nx.t); advanceIncome(nx.t);
            t = nx.t;
            continue;
          }
          cutAt = nx.t;
          policy.cut?.('kept', link.prof.id, nx.t - t);
        }
      }
      chainIndex++;
      if (link.prof.isCombo) combos++; else swings++;
      armWs(link.prof.id, link.prof.isCombo === true);
      // The finisher arms every register the build carries. `BaseSkill.isFinalAttack@6154`
      // is `inf.type == 4` (AttackCombo), which is exactly `isCombo` here.
      if (link.prof.isCombo && emp.size) armAll();
      // The finisher's first hit banks a charge where the dump's script says so.
      if (link.prof.isCombo && chargeBank?.comboFed > 0) {
        chargeBank.value = Math.min(chargeBank.cap, chargeBank.value + chargeBank.comboFed);
      }
      // The finisher's flat Spark cost. The chain is NOT gated on it - a Mage
      // with an empty pool keeps swinging, which is what the game does - but
      // the spend is real, and on a naked Mage it is the spend that drives the
      // gauge: five finishers take a full 100 to 50, and 50 is not strictly
      // above the threshold.
      if (link.prof.isCombo && gauge?.finisherCost > 0) spendAndGauge(gauge.finisherCost, t);
      // Chain Strike: +dmgMult on BASE attacks while the Chaincast status is
      // up - and the game's gate is `hit.skill.isBaseAttack()`
      // (Mage_Talent_ChainStrike.onInflictDamageEval@45453 op 3), which is
      // BaseSkill.isBaseAttack@6153: skill types 0-3 OR type 4, so the combo
      // finisher is INCLUDED (BaseSkill.isBasicAttack@6152 is the 0-3 one). The status
      // the script tests is the chain arm itself, so it is read through the
      // same window as every other use of the arm - an arm that has expired
      // unspent buffs nothing.
      //
      // `hit.dmgMult +=` joins the one additive bracket every dmgMult rider
      // shares, so the swing is RE-PRICED with the amount in that bracket
      // rather than multiplied afterwards.
      const cs = rotation.chainStrike;
      const struck = !!cs && (cs.finisher || !link.prof.isCombo)
        && comboRegs.some((r) => r.chainSpend?.status === cs.status && chainUp(r, t));
      // A COMBO BANK is the same kind of write one hook earlier. Improved
      // Mixture's status reads `onSkillProc(ctx) { if
      // (ctx.skill.isFinalAttack()) { ctx.dmgMult *= (1 + vars.damage *
      // stacks); stop(); } }` - raised once per use, before the finisher's
      // hits exist (tryConsumeCharge@9631). ctx.dmgMult starts at 1
      // ($BaseSkillContext.__constructor__@5233 ops 24-25), so the `*=`
      // leaves 1 + x * stacks there; every hit of the cast then copies it
      // ($ScriptHitData.__constructor__@6318 op 10 -> $BaseSkillContext.copy@5232 ops 4-5) and
      // the hook riders `+=` into the same scalar. So the bank is +x * stacks
      // INSIDE the additive bracket, on every hit and every target of the
      // finisher - not a multiplier on the finished cast. The spend clears
      // it; the finisher's own dose lands with its hit, after this, and
      // banks toward the next one.
      let bankAdd = 0;
      if (comboBank && link.prof.isCombo) {
        const k = Math.min(comboBank.cap, comboBank.value);
        bankAdd = comboBank.per * k;
        comboBank.spent += k;
        comboBank.combos++;
        comboBank.value = 0;
      }
      // ...and the finisher's mark, spent by the first hit that finds it:
      // the same additive bracket, on ONE hit of the finisher, so the amount
      // is spread over the hits the finisher lands.
      let markAdd = 0;
      if (link.prof.isCombo && comboMark && t <= comboMark.until) {
        const plain = hit(link.prof, now);
        if ((plain.hits ?? 0) > 0) {
          markAdd = comboMark.r.amount / Math.max(1, plain.hits);
          comboMark.until = -Infinity;
          comboMark.fires++;
        }
      }
      const tyS = typedRiders(link.prof, t);
      // A COOLDOWN-GATED PASSIVE that also writes the finisher's context
      // (`gateComboAdd`, Resilience of the Unkillable Demon King): the
      // finisher pressed while it is off cooldown takes the amount in the
      // same bracket, and that same finisher's hit then spends the cooldown
      // (the trigger loop below). One script, however many lines it plays -
      // the passive and its Heal step are two riders with one gate - so the
      // amount is taken once per host.
      let gateAdd = 0;
      if (link.prof.isCombo) {
        const hosts = new Set();
        for (const g of triggers) {
          if (!(g.gateComboAdd > 0) || !(g.gate > 0) || t < g.nextReady) continue;
          const host = String(g.prof.id).split('#')[0];
          if (hosts.has(host)) continue;
          hosts.add(host);
          gateAdd += g.gateComboAdd;
        }
      }
      // Chain Strike, the bank, the mark, the gate and the typed riders are
      // all `+=` into the one scalar, so they are one sum and one re-pricing.
      const swingAdd = (struck ? cs.amount : 0) + bankAdd + markAdd + gateAdd + tyS.add;
      let swingOut = swingAdd || tyS.critAdd
        ? hit(link.prof, now, tyS.critAdd ? { add: swingAdd, critAdd: tyS.critAdd } : { add: swingAdd })
        : hit(link.prof, now);
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
      damageEvents += swingOut.hits ?? 0;
      if (swingOut.damage > 0) landed(swingOut.hits ?? 0);
      link.fires = (link.fires ?? 0) + 1;
      link.damage = (link.damage ?? 0) + swingOut.damage * roll;
      splitAdd(link, swingOut, 1, roll);
      link.heal = (link.heal ?? 0) + swingOut.heal * roll;
      link.shield = (link.shield ?? 0) + swingOut.shield * roll;
      feedPools(swingOut, t, link.prof.id, roll);
      setUp(link.applies, t);
      applyDots(link.prof.id, t, {
        attack: !link.prof.isCombo, combo: link.prof.isCombo, hits: swingOut.hits ?? 1,
        landings: swingOut.landings ?? null,
        ctxAdd: gateAdd,
        landed: (swingOut.hits ?? 0) > 0,
        magicCrits: swingOut.magicCrits ?? 0, magicCritHits: swingOut.magicCritHits ?? 0,
      });
      // ...and a gate this swing shortens (`gateRelief`): once per swing, the
      // critical amount at the swing's own crit chance. After the trigger
      // loop, because the script tests its cooldown before it reduces it -
      // and never on the swing that has just spent it, whose reduceCooldown
      // ran while there was no cooldown to reduce.
      if ((swingOut.hits ?? 0) > 0) {
        for (const g of triggers) {
          if (!g.gateRelief || !(g.gate > 0) || g.spentAt === t || !(t < g.nextReady)) continue;
          g.nextReady -= g.gateRelief.perSwing + g.gateRelief.perCrit * (swingOut.critRoll?.p ?? critChance);
        }
      }
      // (A swing a recorded press cut short after its hit ends at the press.)
      const end = cutAt ?? t + link.occupancy;
      tickTo(end); advanceIncome(end);
      fillerTime += end - t;
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

    // --- summons whose window opens on a PROC, not on a press ---------------
    //
    // A cast-hosted summon is scheduled by the cast above. One whose step is
    // `on: Code` has no press to hang off - a script plays it - so its worth is
    // closed form, the way every other rate this fight cannot enact is.
    //
    //   * `damageEvent`. A counter status stacked by a roll on every damage
    //     instance, summoning at its cap and then spending the lot. The counter
    //     REFRESHES rather than ageing per stack, so a gap longer than its own
    //     duration loses the WHOLE climb: reaching `stacks` needs `stacks - 1`
    //     consecutive procs inside `window`, which is the classic wait for a
    //     run of successes, E = (1 - q^r) / (q^r (1 - q)) with
    //     q = 1 - e^(-rho x window). At a high event rate q -> 1 and E -> r, so
    //     it collapses to "one per `stacks` procs" exactly where that is the
    //     right answer, and stretches where the counter really does time out -
    //     which is the difference between a bee every 24 seconds and a bee
    //     never, for a build whose damage is spread thin.
    //   * `weaponSkillCast`. A roll per qualifying press, counted off the
    //     fight's own weapon-skill casts.
    //
    // `floor` on the count is the same cold-start convention the stack procs
    // keep: a climb still unfinished at the bell summons nothing, and stacks
    // nobody spent are not damage.
    const dotTicks = dots.reduce((s2, d) => s2 + (d.ticks ?? 0), 0)
      + poolDots.reduce((s2, d) => s2 + (d.ticks ?? 0), 0);
    for (const s2 of summonState) {
      const tr = s2.sp.trigger;
      if (!tr || tr.on === 'cast') continue;
      // How many swings `n` summons land, over the fight.
      const swingsOf = (n) => {
        if (!(n > 0)) return 0;
        // Summoning one more can extend the ones already out - Pocket Hive's
        // rank-3 clause. Over a pet's life it gains `extend` per summon landing
        // inside it, so D' = D + extend x D'/T: the same closed form the
        // self-extending buffs use, and it only bites when pets actually overlap.
        const gap = fight / n;
        const life = s2.sp.extend > 0 && gap > s2.sp.extend
          ? s2.sp.duration / (1 - s2.sp.extend / gap)
          : s2.sp.duration;
        let petSeconds = n * life;
        // A concurrent cap the step declares: a second pet replaces the first
        // rather than doubling the line.
        if (s2.sp.limit > 0) petSeconds = Math.min(petSeconds, s2.sp.limit * fight);
        return petSeconds * s2.sp.count / s2.sp.period;
      };
      let fires = 0;
      if (tr.on === 'damageEvent') {
        // Every stack the build authors, not only the rolled ones: an
        // unguarded per-cast feed arrives on that skill's own clock.
        let fed = 0;
        for (const f of tr.feeds ?? []) {
          let casts = 0;
          for (const a of actives) if (a.prof.id === f.from) casts += a.casts ?? 0;
          for (const link of chain) if (link.prof.id === f.from) casts += link.fires ?? 0;
          for (const g of triggers) if (g.prof?.id === f.from) casts += g.fires ?? 0;
          fed += casts * f.amount;
        }
        const firesAt = (events) => {
          const rho = (events * tr.chance + fed) / fight;
          const r = Math.max(1, tr.stacks - 1);
          const q = tr.window > 0 ? 1 - Math.exp(-rho * tr.window) : 1;
          const runs = q > 1 - 1e-9 ? r : (1 - q ** r) / (q ** r * (1 - q));
          return Math.floor((fight * rho) / (1 + runs));
        };
        fires = firesAt(damageEvents + dotTicks);
        // THE SUMMONS FEED THE COUNTER TOO, where the script says so: an
        // `onProxyDamage` that runs the same roll rolls it on every damage
        // event a summon of the owner lands - this pet's own swings and any
        // other summoner's in the build (the hook names no unit). The pets'
        // swings depend on the fires and the fires on the swings, so it is a
        // fixed point; each pet adds well under one stack-cap of rolls over
        // its life, so it converges in a few rounds and the loop is bounded
        // anyway. `floor` each round, like the count it corrects.
        //
        // UNMEASURED on this build: the hook's post-damage dispatcher is not
        // in the client, so one roll per pet damage event is the script's
        // reading, not a read of the caller - the plan says so on the line.
        if (tr.alsoOnProxy) {
          const others = summonState.reduce((s3, o) => s3 + (o === s2 ? 0 : o.hits), 0);
          for (let round = 0; round < 12; round++) {
            const next = firesAt(damageEvents + dotTicks + others + swingsOf(fires));
            if (next === fires) break;
            fires = next;
          }
        }
      } else if (tr.on === 'weaponSkillCast') {
        // ...the sub-skill uses the fight raised included.
        let casts = subSkillUses;
        for (const a of actives) if (weaponSkillIds.has(a.prof.id)) casts += a.casts ?? 0;
        fires = Math.floor(casts * tr.chance);
      }
      s2.fires = fires;
      if (!(fires > 0)) continue;
      const petSwings = swingsOf(fires);
      s2.hits += petSwings;
      s2.damage += petSwings * s2.out.damage;
      if (chargeBank && chargeBank.petFed) {
        chargeBank.value = Math.min(chargeBank.cap, chargeBank.value + petSwings);
      }
    }

    // A windowed rider's PROXY half: the same step on every hit a summon of
    // the owner lands while the window is open. The pets' swings are settled
    // just above (some of them in closed form), so this is closed form too:
    // every summon swing of the fight, at the share of the fight the window
    // covered. That treats the two as independent - a summon window and a
    // rider window that the rotation lines up on purpose would do better -
    // and it rests on one onProxyDamage per summon damage event, which this
    // client cannot show (see the audit).
    for (const g of triggers) {
      if (!g.proxy || !g.window) continue;
      const fires = summonState.reduce((s3, o) => s3 + o.hits, 0) * Math.min(1, g.openSeconds / fight);
      if (!(fires > 0)) continue;
      const out = hit(g.prof, bare);
      g.fires += fires;
      g.damage += out.damage * fires;
      splitAdd(g, out, fires);
      g.heal += out.heal * fires;
      g.shield += out.shield * fires;
    }

    // The denominator is the FIGHT, not the moment the last cast happened - a
    // damage meter divides by the clock, and so must this.
    advanceSummons(fight);
    return {
      swings, combos, busy, fillerTime, voidedTime, physicalHits, elapsed: fight,
      // How often a returning charge extended each status that takes it.
      chargeExtends,
      // Each `distinct` gain: the events that asked it and what it paid.
      incomeTally: [...incomeTally].map(([g, tl]) => ({ from: g.from, atb: g.atb, critGated: g.critGated === true, asked: tl.asked, paid: tl.paid })),
      // What the build landed on the foe as events, and what each stacking
      // debuff they applied came to - so a line can say how many stacks stood
      // for how long, and a rider that never fired can say which event the
      // fight never raised.
      eventCount,
      foeDebuffs: foeStacks.map((fs) => {
        settleFoe(fs, fight);
        return {
          status: fs.fd.status, applied: fs.applied, consumed: fs.consumed,
          stackSeconds: fs.stackSeconds, upSeconds: fs.upSeconds,
        };
      }),
      applyCounts: applyCounters.map((c) => c.count),
      // The pets' own ledger: real damage, but the capture attributes it to
      // source=Summon_* rather than to the player, so it rides a flagged line
      // that source-filtered verification excludes.
      pets: summonState.map((s2) => ({
        from: s2.sp.from, unit: s2.sp.unit, prof: s2.sp.petProf,
        hits: s2.hits, damage: s2.damage, critRoll: s2.out.critRoll ?? null,
        trigger: s2.sp.trigger, fires: s2.fires ?? null, life: s2.sp.duration,
      })),
      wsReset: wsReset ? { from: wsReset.from, fires: wsResetFires, shield: wsResetShield } : null,
      // Each use rider: how many presses spent it, and how many critical
      // hits the owner landed while its cooldown ran.
      useRiders: useRegs.map((r) => ({ from: r.u.from, fires: r.fires, crits: r.crits })),
      conduitEvents,
      // Each window a landing on the hero opens: its seconds, and who opened it.
      landings: [...landingTally.values()].map((w) => ({ ...w, by: [...w.by.values()] })),
      // What the dose gates did, and what the combo bank held when it was
      // spent - for the lines that have to say so.
      gates: gates.map((g) => ({
        status: g.d.status, applications: g.d.applications, reapplications: g.d.reapplications,
      })),
      comboBank: comboBank ? { spent: comboBank.spent, combos: comboBank.combos } : null,
      // How many presses spent each armed next-weapon-skill register.
      wsFires: wsRegs.map((w) => w.fires),
      comboMarkFires: comboMark ? comboMark.fires : 0,
      detonations: detoState.map((s) => ({ status: s.d.status, fires: s.fires, stacks: s.stacks, damage: s.damage })),
      chargeBank: chargeBank ? { spent: chargeBank.spent, presses: chargeBank.presses } : null,
      // What the bank was actually worth, so the report can say it rather than
      // leaving a tripled number unexplained.
      stackMult: stackMult
        ? { skill: stackMult.skill, spent: stackMult.spent, presses: stackMult.presses,
          per: stackMult.per, cap: stackMult.cap, window: stackMult.window,
          statusName: stackMult.statusName }
        : null,
    };
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
  const acc = { active: new Map(), filler: new Map(), dot: new Map(), trig: new Map(), pool: new Map(), pet: new Map(), extended: new Map() };
  for (const link of chain) link.total = { damage: 0, heal: 0, shield: 0, hits: 0, fires: 0 };
  for (let i = 0; i < rolls; i++) {
    for (const link of chain) { link.damage = 0; link.heal = 0; link.shield = 0; link.hits = 0; link.fires = 0; link.split = null; }
    last = runOne(rand);
    for (const [status, n] of last.chargeExtends ?? []) acc.extended.set(status, (acc.extended.get(status) ?? 0) + n);
    let damage = 0, heal = 0, shield = 0;
    for (const a of actives) {
      damage += a.damage; heal += a.heal; shield += a.shield;
      const e = acc.active.get(a) ?? { casts: 0, hits: 0, damage: 0, heal: 0, shield: 0, instant: 0, saved: 0, poolPresses: 0, poolHeld: 0 };
      e.casts += a.casts; e.hits += a.hits ?? 0;
      e.instant += a.instantCasts ?? 0; e.saved += a.instantSaved ?? 0;
      e.poolPresses += a.poolPresses ?? 0; e.poolHeld += a.poolHeld ?? 0;
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
    for (const p2 of last.pets ?? []) {
      damage += p2.damage;
      const e = acc.pet.get(p2.from) ?? {
        hits: 0, damage: 0, fires: 0, prof: p2.prof, unit: p2.unit,
        trigger: p2.trigger ?? null, life: p2.life, critRoll: p2.critRoll ?? null,
      };
      e.hits += p2.hits; e.damage += p2.damage; e.fires += p2.fires ?? 0;
      acc.pet.set(p2.from, e);
    }
    if (last.stackMult) {
      const e = acc.stackMult ?? { ...last.stackMult, spent: 0, presses: 0 };
      e.spent += last.stackMult.spent; e.presses += last.stackMult.presses;
      acc.stackMult = e;
    }
    if (last.wsReset?.shield > 0) {
      shield += last.wsReset.shield;
      const e = acc.wsReset ?? { from: last.wsReset.from, fires: 0, shield: 0 };
      e.fires += last.wsReset.fires; e.shield += last.wsReset.shield;
      acc.wsReset = e;
    }
    acc.wsFires = (last.wsFires ?? []).map((n, i) => (acc.wsFires?.[i] ?? 0) + n);
    for (const g of last.gates ?? []) {
      const e = (acc.gates ??= new Map()).get(g.status) ?? { applications: 0, reapplications: 0 };
      e.applications += g.applications; e.reapplications += g.reapplications;
      acc.gates.set(g.status, e);
    }
    if (last.comboBank) {
      const e = acc.comboBank ?? { spent: 0, combos: 0 };
      e.spent += last.comboBank.spent; e.combos += last.comboBank.combos;
      acc.comboBank = e;
    }
    acc.comboMarkFires = (acc.comboMarkFires ?? 0) + (last.comboMarkFires ?? 0);
    if (last.chargeBank) {
      const e = (acc.chargeBank ??= { spent: 0, presses: 0 });
      e.spent += last.chargeBank.spent; e.presses += last.chargeBank.presses;
    }
    for (const dt of last.detonations ?? []) {
      damage += dt.damage;
      const e = (acc.deto ??= new Map()).get(dt.status) ?? { fires: 0, stacks: 0, damage: 0 };
      e.fires += dt.fires; e.stacks += dt.stacks; e.damage += dt.damage;
      acc.deto.set(dt.status, e);
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
    if (!e || !e.fires || g.gateOnly) continue;
    const fires = e.fires / rolls;
    // ONE STEP, ONE LINE. A step its script plays on two events is two
    // riders - Nectar-infused Blade's hit on a swing and, from rank 3, on
    // every hit of Flower Spiral - and one row of the meter: the second
    // joins the first, and the line says both.
    const prior = triggeredLines.find((x) => x.id === g.prof.id && x.source === g.source
      && (x.instances ?? 1) === (g.instances ?? 1));
    if (prior) {
      prior.interval = elapsed / (elapsed / prior.interval + fires);
      prior.total = {
        damage: prior.total.damage + (e.damage ?? 0) / rolls,
        heal: prior.total.heal + (e.heal ?? 0) / rolls,
        shield: prior.total.shield + (e.shield ?? 0) / rolls,
      };
      prior.hits += fires * ((g.out?.hits ?? 0) || 1);
      // Two riders on one line: the decomposition is theirs together or not
      // at all.
      {
        const mine = splitOf(g, (e.damage ?? 0) / rolls, rolls).split;
        if (prior.split && mine) for (const k of Object.keys(mine)) prior.split[k] += mine[k];
        else delete prior.split;
      }
      if (g.rule.why && !String(prior.why ?? '').includes(g.rule.why)) prior.why = [prior.why, g.rule.why].filter(Boolean).join('; ');
      continue;
    }
    triggeredLines.push({
      id: g.prof.id, name: g.prof.name, kind: 'triggered', source: g.source,
      affinity: affinitiesOf(g.prof),
      perCast: g.meanPerCast
        ? { ...g.out, damage: (e.damage ?? 0) / e.fires, heal: (e.heal ?? 0) / e.fires, shield: (e.shield ?? 0) / e.fires }
        : g.out,
      interval: elapsed / fires, share: 0, why: g.rule.why,
      // How many slots hold this option. `interval` counts every instance's
      // hit, so the cadence of the EVENT behind them is interval * instances -
      // two conduits in one slot pair fire together, they do not fire twice as
      // often.
      instances: g.instances ?? 1,
      total: {
        damage: (e.damage ?? 0) / rolls,
        heal: (e.heal ?? 0) / rolls,
        shield: (e.shield ?? 0) / rolls,
      },
      hits: fires * ((g.out?.hits ?? 0) || 1),
      ...splitOf(g, (e.damage ?? 0) / rolls, rolls),
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
      ...splitOf(a, e.damage / rolls, rolls),
      interval: elapsed / casts, share: (casts * a.occupancy - e.saved / rolls) / elapsed,
      casts,
      // A press that spent a bank on top of its own spin says how much.
      ...(rotation.chargeDump?.plus && rotation.chargeDump.skill === a.prof.id && acc.chargeBank?.presses > 0
        ? {
          bankSpent: acc.chargeBank.spent / acc.chargeBank.presses,
          why: `${(acc.chargeBank.spent / acc.chargeBank.presses).toFixed(1)} ${rotation.chargeDump.statusName ?? rotation.chargeDump.status} `
            + `spent per cast on average (it holds ${rotation.chargeDump.cap}), each one more spin beside the one every cast plays - `
            + [rotation.chargeDump.timerPeriod > 0 ? `one arrives every ${rotation.chargeDump.timerPeriod}s of combat` : null,
              rotation.chargeDump.comboFed > 0 ? 'one with each finisher' : null].filter(Boolean).join(' and '),
        }
        : {}),
      // A press that empties a pool and is priced at what it found says how
      // much that was: the per-cast figure is the average over those casts,
      // not the full-pool price a reader of the skill alone is shown.
      ...(a.prof.poolRider && e.poolPresses > 0
        ? (() => {
          const pr = a.prof.poolRider;
          const k = e.poolHeld / e.poolPresses;
          return {
            poolSpent: k,
            why: `${k.toFixed(1)} ${pr.name ?? pr.atb} consumed a cast on average (the pool holds ${pr.full}), `
              + `+${Math.round(pr.per * 100)}% each: pressed whenever it is ready, with what the pool holds then`,
          };
        })()
        : {}),
      // How many of them were played instantly, and who handed them back.
      ...(e.instant > 0
        ? (() => {
          const mus = cdMutations.filter((mu) => mu.instant && actives[mu.targetIdx] === a);
          const rider = mus.reduce((sum, mu) => sum + (mu.instant.rider?.amount ?? 0), 0);
          return {
            instantCasts: e.instant / rolls,
            why: `${+(e.instant / rolls).toFixed(1)} of its ${+casts.toFixed(1)} casts were instant - `
              + mus.map((mu) => mu.why).join('; ')
              + `. An instant cast holds you ${+Math.max(a.prof.instant.occupancy, 0.05).toFixed(2)}s where the cast bar holds `
              + `${+a.occupancy.toFixed(2)}s`
              + (rider > 0 ? ', and the per-cast figure here is the average over both kinds' : ''),
          };
        })()
        : {}),
      // A press whose status a returning charge extends says how often that
      // happened: the status's life on its row is not the life it had here.
      ...((a.applies?.self ?? []).some((b) => b.extendOn && acc.extended.get(b.status) > 0)
        ? (() => {
          const b = a.applies.self.find((x) => x.extendOn && acc.extended.get(x.status) > 0);
          const n = acc.extended.get(b.status) / rolls;
          return {
            why: `${b.name ?? b.status} was extended ${+n.toFixed(1)} times over ${+casts.toFixed(1)} presses, ${b.extendOn.amount}s each time `
              + `a weapon skill got a charge back while it stood - ${+(lifeOf(b) + n * b.extendOn.amount / Math.max(casts, 1)).toFixed(1)}s a press `
              + `where its row says ${lifeOf(b)}s`,
          };
        })()
        : {}),
      // A press whose price is a BANK owes the reader the count it spent -
      // without it the number is three times the tooltip's and nothing says
      // why.
      ...(acc.stackMult && acc.stackMult.skill === a.prof.id && acc.stackMult.presses > 0
        ? (() => {
          const k = acc.stackMult.spent / acc.stackMult.presses;
          return {
            why: `${k.toFixed(1)} stacks of ${acc.stackMult.statusName} on average, `
              + `+${Math.round(acc.stackMult.per * 100)}% each - x${(1 + acc.stackMult.per * k).toFixed(2)} `
              + `on the first target it hits. Every OTHER active press banks one, to a cap of `
              + `${acc.stackMult.cap}, and the whole bank is lost if ${acc.stackMult.window}s pass `
              + 'between presses',
          };
        })()
        : {}),
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
    // ...OF THE DROPS THE HERO WALKS INTO. The timer makes the drops; a stack
    // is one collected, and how many are is not in the data - the drop lands
    // at a random spot some units off and lies there a few seconds. The
    // fight takes the share it is told (`pickupShare`, 1 unless stated:
    // every drop, the moment it lands) and the build is told that it did.
    const fires = sp.on === 'timer'
      ? Math.floor(elapsed * pickupShare / (sp.period > 0 ? sp.period : Infinity) + 1e-9)
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
        ? `one per ${+(sp.period / pickupShare).toFixed(1)}s of combat - a pickup dropped every ${sp.period / sp.cap}s, `
          + `${pickupShare === 1 ? 'every one' : `${Math.round(pickupShare * 100)}% of them`} taken as walked into (--pickups), `
          + `${sp.cap} to arm - from a cold start`
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

  // A detonating mark: one line per mark, its stacks spent inside the fight.
  for (const dt of detonations ?? []) {
    const e = acc.deto?.get(dt.status);
    if (!dt.prof || !dt.out || !e || !(e.fires > 0)) continue;
    const fires = e.fires / rolls;
    lines.push({
      id: `${dt.status}#${dt.step}`, name: dt.name ?? dt.prof.name, kind: 'triggered', source: dt.appliers.join('+'),
      perCast: { damage: (e.damage / rolls) / fires, heal: 0, shield: 0 },
      total: { damage: e.damage / rolls, heal: 0, shield: 0 },
      hits: fires, interval: elapsed / fires, share: 0,
      why: `${+(e.stacks / e.fires).toFixed(1)} stacks on average (of ${dt.cap}) when a Magic weapon skill's hit `
        + `detonates it - one stack per hit of ${(dt.applierNames ?? dt.appliers).join(', ')}`
        + (Number.isFinite(dt.window) ? `, lost if ${dt.window}s pass without one` : '')
        + '; the step is priced per stack',
    });
  }

  // A COUNTER THE BUILD'S OWN STATUS APPLICATIONS CLIMB, arming a cast of its
  // own - priced after the fight like the stack counters above, and for the
  // same reason. The count is the applications of ONE named status the fight
  // landed (onInflictStatusEval behind `status.kind == Skill.X`); a cast the
  // counter arms may itself land that status (`selfFeeds` per fire), which is
  // a fixed point of a few rounds. `floor`, from a cold start, like the rest.
  const eventProcFacts = [];
  for (const [i, ep] of (rotation.eventProcs ?? []).entries()) {
    const count = mean((x) => x.applyCounts?.[i] ?? 0);
    let fires = Math.floor(count / ep.cap);
    for (let round = 0; round < 12 && ep.selfFeeds > 0; round++) {
      const next = Math.floor((count + fires * ep.selfFeeds) / ep.cap);
      if (next === fires) break;
      fires = next;
    }
    eventProcFacts.push({ id: ep.prof.id, counted: count, cap: ep.cap, fires });
    if (!(fires > 0)) continue;
    const out = cast(ep.prof, bare);
    lines.push({
      id: ep.prof.id, name: ep.prof.name, kind: 'triggered', source: ep.source ?? ep.from,
      perCast: { damage: out.damage, heal: out.heal, shield: out.shield },
      total: { damage: out.damage * fires, heal: out.heal * fires, shield: out.shield * fires },
      hits: (out.hits ?? 1) * fires,
      interval: elapsed / fires, share: 0,
      postHoc: true,
      why: `${ep.why} - ${Math.round(count)} counted in this fight`
        + (ep.selfFeeds > 0 ? `, plus ${ep.selfFeeds} from each cast of its own` : '')
        + ', from a cold start',
    });
  }

  // A USE RIDER'S STEP (see `useRegs` in runOne): one per critical hit the
  // owner landed while the rider's cooldown ran, counted inside the fight and
  // priced after it - the step is no press and no swing, and what it rides is
  // every line at once. Priced against the bare state: which buffs stood at
  // each of those hits is not carried over (a floor of a few percent under a
  // mastery buff the build keeps up).
  const useRiderFacts = [];
  for (const [i, u] of (rotation.useRiders ?? []).entries()) {
    const fires = mean((x) => x.useRiders?.[i]?.fires ?? 0);
    const crits = mean((x) => x.useRiders?.[i]?.crits ?? 0);
    useRiderFacts.push({ from: u.from, name: u.name, fires, crits, every: u.every, spenders: u.spenders ?? [] });
    if (!u.critStep || !(crits > 0)) continue;
    const out = cast(u.critStep.prof, bare);
    if (!(out.damage > 0)) continue;
    const tally = {};
    splitTally(tally, out, crits);
    lines.push({
      id: u.critStep.prof.id, name: u.name, kind: 'triggered', source: u.source ?? u.from,
      affinity: affinitiesOf(u.critStep.prof),
      perCast: { damage: out.damage, heal: out.heal, shield: out.shield },
      total: { damage: out.damage * crits, heal: out.heal * crits, shield: out.shield * crits },
      hits: (out.hits ?? 1) * crits,
      interval: elapsed / crits, share: 0,
      postHoc: true,
      ...(rolls === 1 ? { split: tally.split } : {}),
      why: `its ${u.critStep.stepId} step, once per critical hit of your own while its ${u.every}s cooldown runs - `
        + `${+crits.toFixed(1)} of them in this fight (a summon's critical hit plays none); `
        + `${+fires.toFixed(1)} presses spent the cooldown, each for +${Math.round(u.amount * 100)}% in its ${u.bracketRoot} bracket`,
    });
  }

  // The pets' own damage, on a FLAGGED line: real output, but the capture
  // attributes it to source=Summon_*, not the player, so source-filtered
  // verification must skip it - the flag is the skip.
  for (const [from, e] of acc.pet) {
    // A PROC-driven summon that never fired still gets its line. Zero because
    // the counter never filled is an answer, and the silent version of it is
    // the bug this whole path exists to fix: a weapon whose gimmick is worth
    // nothing in YOUR build has to say so, not vanish. A cast-hosted summoner
    // that dealt nothing keeps the old silence - it is in the rotation table
    // already, on its own press.
    const procDriven = !!e.trigger && e.trigger.on !== 'cast';
    if (!(e.damage > 0) && !procDriven) continue;
    const hits = e.hits / rolls;
    // The swings' crit halves, when every swing was priced with one die.
    const tally = {};
    if (rolls === 1 && e.critRoll && e.damage > 0) splitTally(tally, { damage: e.damage, critRoll: e.critRoll }, 1, 1, hits);
    lines.push({
      id: `${from}#pets`, name: `${e.prof?.name ?? e.unit} (summon)`, kind: 'summon', source: from,
      perCast: { damage: hits > 0 ? (e.damage / rolls) / hits : 0, heal: 0, shield: 0 },
      total: { damage: e.damage / rolls, heal: 0, shield: 0 },
      hits,
      interval: hits > 0 ? elapsed / hits : Infinity, share: 0,
      postHoc: true, petSource: true,
      // The row its swings are logged under: the pet's own attack.
      petSkill: e.prof?.id ?? null,
      affinity: affinitiesOf(e.prof),
      ...(tally.split ? { split: tally.split } : {}),
      why: `the ${e.unit}'s own swings while summoned - logged live under the pet's own skill (${e.prof?.id ?? '?'}): with the `
        + 'owner as source by probe v10, where verify compares it, and under source=the summon by older probes, where '
        + 'it cannot; the dps headline keeps it either way'
        + (e.trigger && e.trigger.on !== 'cast'
          ? `; ${Math.round(e.fires / rolls)} summoned over the fight, ${e.life}s each - `
            + (e.trigger.on === 'damageEvent'
              ? `${Math.round(e.trigger.chance * 100)}% per damage event to stack a counter `
                + `that summons at ${e.trigger.stacks} and spends the lot`
                + ((e.trigger.feeds ?? []).length
                  ? ', plus ' + e.trigger.feeds
                    .map((f) => `${f.amount} per ${f.name} cast`).join(' and ')
                  : '')
                + (e.trigger.alsoOnProxy
                  ? ', and the same roll on every hit a summon of yours lands (its onProxyDamage hook - '
                    + 'counted here at one roll per summon damage event, which is what the script says '
                    + 'and is not measured on this build)'
                  : '')
                + (e.trigger.alsoOnReceive
                  ? ', and the same roll fires when you are HIT, which this passive foe never does - '
                    + 'so this rate is a floor'
                  : '')
              : `${Math.round(e.trigger.chance * 100)}% per weapon-skill cast`)
          : ''),
    });
  }
  // Inner Demon's rank-3 shield: the life the reset costs, handed back as a
  // shield. The reset itself shows up as extra casts on the weapon-skill
  // lines; this line carries the defensive half.
  if (acc.wsReset && acc.wsReset.shield > 0) {
    const fires = acc.wsReset.fires / rolls;
    lines.push({
      id: `${acc.wsReset.from}#shield`, name: 'Inner Demon (shield)', kind: 'triggered', source: acc.wsReset.from,
      perCast: { damage: 0, heal: 0, shield: fires > 0 ? (acc.wsReset.shield / rolls) / fires : 0 },
      total: { damage: 0, heal: 0, shield: acc.wsReset.shield / rolls },
      hits: fires, interval: fires > 0 ? elapsed / fires : Infinity, share: 0, postHoc: true,
      why: 'the life the cooldown reset costs, returned as a shield at rank 3',
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
        ...splitOf(link, dmg, rolls),
        interval: fires > 0 ? elapsed / (fires / rolls) : chainTime,
        share: (link.prof.occupancy * (fires / rolls)) / elapsed,
        chainLink: true,
        // A finisher priced with a spent BANK owes the reader the count, the
        // same as a press that spends one - and so does a finisher that spent
        // marks. One finisher can carry both (a talent's bank and a weapon's
        // mark are separate registers in one bracket), so the sentences are
        // joined rather than the later spread replacing the earlier.
        ...(() => {
          if (!link.prof.isCombo) return {};
          const says = [];
          const more = {};
          if (rotation.comboBank && acc.comboBank?.combos > 0) {
            const k = acc.comboBank.spent / acc.comboBank.combos;
            const b = rotation.comboBank;
            says.push(`${k.toFixed(1)} stacks of ${b.name} spent per finisher on average, +${Math.round(b.per * 100)}% `
              + `each inside the hit's one damage bracket (cap ${b.cap}) - one stack per NEW ${b.feedName} laid `
              + '(a category already dosed lays none), the finisher\'s own included, which banks toward the next one');
          }
          if (rotation.comboRider && acc.comboMarkFires > 0) {
            more.markFires = acc.comboMarkFires / rolls;
            says.push(`${+(acc.comboMarkFires / rolls).toFixed(1)} of its ${+(fires / rolls).toFixed(1)} casts spent `
              + `${rotation.comboRider.statusName} - ${rotation.comboRider.name}'s mark, put on the target by a `
              + `weapon skill's hit${Number.isFinite(rotation.comboRider.window) ? ` and good for ${rotation.comboRider.window}s` : ''}`
              + ` - for +${Math.round(rotation.comboRider.amount * 100)}% on the hit that found it; the per-cast figure is `
              + 'the average over marked and unmarked casts');
          }
          return says.length ? { ...more, why: says.join('; ') } : {};
        })(),
      });
    }
  }
  for (const d of dots) {
    const e = acc.dot.get(d);
    if (!e || !e.ticks) continue;
    const ticks = e.ticks / rolls;
    // What a tick was WORTH ON AVERAGE, which since stacks landed is not the
    // snapshot amount: a tick of a stacking dot (Gash) is its own value times
    // however many stacks were on the target, so printing the one-stack figure beside a
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
      affinity: affinitiesOf(d.prof),
      perCast: { damage: e.damage / rolls, heal: e.heal / rolls, shield: 0 },
      // A status's `perCast` IS its whole-fight figure - its interval is the
      // fight - so the two agree here by construction.
      total: { damage: e.damage / rolls, heal: e.heal / rolls, shield: 0 },
      hits: ticks,   // a tick IS the damage event
      ...(d.splitUnknown ? {} : splitOf(d, e.damage / rolls, rolls)),
      interval: elapsed, share: 0,
      why: `${ticks.toFixed(0)} ticks of ${perTick.toFixed(0)} every ${d.tick}s from ${d.fromName}`
        + (d.scaleByStacks && meanStacks > 1.02
          ? ` - ${d.out.damage.toFixed(0)} a stack, ${meanStacks.toFixed(1)} stacks on average of ${d.stacks}`
          : '')
        // A gated status says how often its gate converted, because that
        // count is the whole schedule and nothing else on the line shows it.
        + (d.gate && acc.gates?.get(d.status)
          ? (() => {
            const g = acc.gates.get(d.status);
            const n = g.applications / rolls, re = g.reapplications / rolls;
            return ` - applied ${n.toFixed(0)} times, each time ${d.gate.need} of its `
              + `${d.gate.categories.length} doses were on the target (${d.gate.categories.map((c) => c.label).join(', ')}; `
              + `a cast lays its dose only if it lands a hit of its own); ${re.toFixed(0)} of those found it already up`;
          })()
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
  //
  // The PET line is the exception, and was double-counted from the day the
  // summoner landed: `damage += p2.damage` already folds the pets into the
  // roll's own total, so adding the line again put the Silhouette of Almaz 5.6%
  // over its own repartition. The test is arithmetic and needs no game: the
  // headline must equal the sum of every line, and it did not - it exceeded it
  // by exactly the pets.
  const extra = lines.filter((l) => l.postHoc && !l.petSource)
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
    // Income that pays a skill different from the last one it paid: per gain,
    // the events that asked and what was paid (the last fight played).
    incomeTally: last?.incomeTally ?? [],
    // The share of the fight spent in swings a recorded press stopped before
    // their hit (a replay only; it is part of `idle`, which is what is left
    // of the clock after the casts and the swings that were played).
    voidedShare: mean((x) => x.voidedTime ?? 0) / elapsed,
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
    // The next-weapon-skill register, with how often this fight spent it - a
    // register nothing ever arms is the difference between "scored" and
    // "scored at zero", and the plan has to be able to tell the two apart.
    wsRiders: (rotation.wsRiders ?? (rotation.wsRider ? [rotation.wsRider] : []))
      .map((r, i) => ({ status: r.status, from: r.from ?? null, fires: (acc.wsFires?.[i] ?? 0) / rolls })),
    // The events the fight raised on the foe (see `foeEvent`), per fight, and
    // what the event-applied stacking debuffs came to: applications, how
    // often they were consumed, the mean stack count over the WHOLE fight
    // and the share of it at least one stack stood.
    events: Object.fromEntries(Object.keys(totals[0]?.eventCount ?? {})
      .map((k) => [k, mean((x) => x.eventCount?.[k] ?? 0)])),
    foeDebuffs: (rotation.foeDebuffs ?? []).map((fd, i) => ({
      status: fd.status, name: fd.name ?? fd.status, cap: fd.cap,
      applied: mean((x) => x.foeDebuffs?.[i]?.applied ?? 0),
      consumed: mean((x) => x.foeDebuffs?.[i]?.consumed ?? 0),
      meanStacks: mean((x) => x.foeDebuffs?.[i]?.stackSeconds ?? 0) / elapsed,
      uptime: mean((x) => x.foeDebuffs?.[i]?.upSeconds ?? 0) / elapsed,
    })),
    eventProcs: eventProcFacts,
    // The use riders: presses that spent each one's cooldown, and the
    // critical hits landed while it ran.
    useRiders: useRiderFacts,
    // Conduit trigger events over the fight (every slotted conduit fires on each).
    conduitEvents: mean((x) => x.conduitEvents ?? 0),
    // The presses that land on their caster for a rider that waits for one
    // (`landerFacts`), and what the windows such landings open came to in
    // the last fight played - what `simulate` places those presses on.
    landers: landerFacts,
    landings: last?.landings ?? [],
    // ...and the statuses a press of this fight can never put up (`neverLands`).
    unmodelled: neverLands.length ? [...(rotation.unmodelled ?? []), ...neverLands] : rotation.unmodelled,
  };
}
