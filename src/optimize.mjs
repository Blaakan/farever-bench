// ---------------------------------------------------------------------------
// optimize.mjs - fill the slots you did not pin with the best thing that fits.
//
// The search is coordinate ascent with exhaustive per-slot enumeration:
// repeatedly walk the free decisions, and for each one try every legal option
// while everything else is held fixed, keeping whichever scores best. Stop
// when a full pass changes nothing.
//
// Why that and not stat weights: the objective is not linear in the stats.
// CritChance scales off Dexterity AND Faith while CritDamage scales off
// Strength AND Intellect, so the two cross over at a computable crit level
// (about 35% for a weapon that scales equally off both). Mitigation is a
// hyperbola in Armor. A rating point loses 3.8% of its value per character
// level. Any fixed weight vector gets some of those backwards. Evaluating the
// real objective for every candidate costs more and cannot.
//
// Why it is fast enough anyway: a slot has 2-27 candidates, a build has ~15
// slots and up to ~10 augment sockets, and convergence takes 3-5 passes. That
// is a few thousand full evaluations - well under a second - so exhaustive
// beats clever.
//
// Two structural notes:
//
//   * Augment sockets are not fixed. A socket only exists while an item that
//     hosts it is equipped, so the decision set is recomputed every pass. That
//     is also why gear is optimised before augments in each pass.
//
//   * Coordinate ascent finds a local optimum. The interactions here are real
//     (an armour piece's faction decides which rating it can carry, and the
//     Demon augments convert one rating into another), so the search restarts
//     from several seeds and keeps the best. `--restarts` controls how many.
// ---------------------------------------------------------------------------

import { socketsOf, pruneIllegal, illegalReason } from './loadout.mjs';

// A tiny deterministic PRNG. Restarts must be reproducible: a build a user
// shares has to be re-derivable, so nothing here touches Math.random.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param engine
 * @param spec {
 *   loadout,                 // seed: class, level, and any pinned gear
 *   pinnedGear:  Set<slotId>,      // slots the user fixed (including to empty)
 *   pinnedAug:   Set<socketKey>,   // sockets the user fixed (including to none)
 *   goal, weights, target, rank, mix,
 *   rarities:    Set<rarityId>|null,
 *   stars:       'max' | number,
 *   allowEmpty:  boolean,          // may a slot be left empty
 *   restarts, maxPasses,
 *   onProgress
 * }
 */
export function optimize(engine, spec) {
  const { cat } = engine;
  const {
    goal = 'dps', weights = null, target, rank = 1, mix = 0.5,
    rarities = null, stars = 'max', allowEmpty = true,
    restarts = 3, maxPasses = 12, onProgress = null,
  } = spec;

  const pinnedGear = spec.pinnedGear ?? new Set();
  const pinnedAug = spec.pinnedAug ?? new Set();
  // Skill pools the user chose by hand.
  const pinnedSkills = spec.pinnedSkills ?? new Set();
  const pinnedRunes = spec.pinnedRunes ?? new Set();

  // The reference used to normalise a weighted blend: the seed as given, so
  // the numbers a user reads are relative to where they started.
  const refEval = engine.evaluate(spec.loadout, { target, rank, mix });
  const scorer = engine.makeScorer({ goal, weights, target, rank, mix, ref: refEval });

  const freeSlots = cat.combatSlots()
    .map((s) => s.id)
    .filter((id) => !pinnedGear.has(id));

  // Candidate lists are stable for the whole run, so build them once.
  const cls = cat.classes.find((c) => c.unit === spec.loadout.class);
  // Handedness couples two slots, so resolve it once at candidate-build time
  // rather than discovering it inside the search:
  //   * an offhand pinned to a real item forbids two-handed mainhands
  //   * a mainhand pinned to a two-hander forbids any offhand
  const offhandPinnedFull = pinnedGear.has('Slot_OffhandWeapon') && !!spec.loadout.gear.Slot_OffhandWeapon?.item;
  const pinnedMain = pinnedGear.has('Slot_Weapon1') ? spec.loadout.gear.Slot_Weapon1 : null;
  const pinnedMainBlocksOffhand = !!pinnedMain?.item && !cat.allowsOffhand(cat.itemById.get(pinnedMain.item));
  if (offhandPinnedFull && pinnedMainBlocksOffhand) {
    throw new Error(`pinned ${pinnedMain.item} uses both hands, so the pinned offhand cannot be equipped`);
  }

  const candidates = new Map();
  for (const slotId of freeSlots) {
    if (slotId === 'Slot_OffhandWeapon' && pinnedMainBlocksOffhand) {
      candidates.set(slotId, [null]);
      continue;
    }
    const list = cat.candidates(slotId, {
      aptitude: cls.aptitude, charLevel: spec.loadout.level,
      rarities, exclude: spec.exclude, rarityRoll: spec.rarityRoll, rarityCap: spec.rarityCap,
    }).map((c) => ({
      item: c.item.id,
      rarity: c.rarity,
      chance: c.chance,
      stars: stars === 'max' ? cat.maxStars(c.item, c.rarity) : Math.min(stars, cat.maxStars(c.item, c.rarity)),
    })).filter((c) => !(slotId === 'Slot_Weapon1' && offhandPinnedFull && !cat.allowsOffhand(cat.itemById.get(c.item))));
    if (allowEmpty || slotId === 'Slot_OffhandWeapon') list.push(null);
    candidates.set(slotId, list);
  }
  if (offhandPinnedFull && !candidates.get('Slot_Weapon1')?.some(Boolean)) {
    throw new Error('the pinned offhand leaves no legal one-handed mainhand for this class and level');
  }

  const augCandidates = new Map();
  function augOptions(type) {
    let l = augCandidates.get(type);
    if (!l) {
      l = cat.augmentCandidates(type, { exclude: spec.exclude }).map((a) => a.id);
      l.push(null); // leaving a socket empty is a legitimate choice
      augCandidates.set(type, l);
    }
    return l;
  }

  let counter = 0;
  const evalCache = new Map();
  function scoreOf(loadout) {
    // Only the decisions matter, so key on them rather than the whole object.
    const key = cat.combatSlots().map((s) => {
      const g = loadout.gear[s.id];
      return g ? `${s.id}=${g.item}/${g.rarity ?? ''}:${g.stars ?? 0}${g.flawless ? 'f' : ''}` : '';
    }).join('|')
      + '#' + Object.entries(loadout.augments).filter(([, v]) => v).sort().map(([k, v]) => k + '=' + v).join('|')
      + '$' + Object.entries(loadout.skills ?? {}).sort().map(([k, v]) => k + '=' + v.join('+')).join('|')
      + '&' + Object.entries(loadout.runes ?? {}).filter(([, x]) => x).sort().join('|')
      + '%' + Object.entries(loadout.talents ?? {}).sort().map(([k, v]) => k + ':' + v).join('|');
    let v = evalCache.get(key);
    if (v === undefined) {
      const ev = engine.evaluate(loadout, { target, rank, mix });
      // Ties are common and they are not noise: a shield's atbRatio is
      // `{armor: 0.337}` and nothing else, so for a dps goal every offhand -
      // and no offhand at all - scores identically, and whichever one a restart
      // happened to seed would stick. That reads as a considered choice when it
      // is a coin flip. So the comparison is lexicographic: the objective
      // first, then the total magnitude of everything the build grants. A
      // Legendary shield beats a Rare one and both beat an empty slot, even
      // when the goal cannot tell them apart - which is what a player expects
      // and is never worse. `indifferent` below then NAMES the slots where this
      // happened, so the output says "makes no difference" rather than quietly
      // asserting a preference.
      let tie = 0;
      for (const x of ev.mods.flat.values()) tie += Math.abs(x);
      v = { score: scorer.scoreFrom(ev), tie };
      evalCache.set(key, v);
      counter++;
      if (onProgress && counter % 500 === 0) onProgress(counter);
    }
    return v;
  }

  // Lexicographic: objective, then tiebreak.
  const EPS = 1e-9;
  const better = (a, b) => (a.score > b.score + EPS) || (Math.abs(a.score - b.score) <= EPS && a.tie > b.tie + EPS);

  /**
   * Slots whose contents make no difference to the goal - emptying them scores
   * the same. A shield on a dps build is the honest example: it grants armour
   * and nothing else, so the tool has an opinion about it only through the
   * tiebreak. Saying so is worth more than presenting the pick as a result.
   */
  function indifferentSlots(loadout, at) {
    const out = [];
    for (const slotId of cat.combatSlots().map((x) => x.id)) {
      if (!loadout.gear[slotId] || pinnedGear.has(slotId)) continue;
      const trial = clone(loadout);
      delete trial.gear[slotId];
      pruneAugments(trial);
      let got;
      try { got = scoreOf(trial); } catch { continue; }
      if (Math.abs(got.score - at.score) <= EPS) out.push(slotId);
    }
    return out;
  }

  function clone(l) {
    return {
      ...l,
      gear: { ...l.gear },
      augments: { ...l.augments },
      skills: Object.fromEntries(Object.entries(l.skills ?? {}).map(([k, v]) => [k, v.slice()])),
      runes: { ...(l.runes ?? {}) },
      talents: { ...(l.talents ?? {}) },
    };
  }

  // Drop anything the current gear no longer supports: augments whose host is
  // gone, an offhand a two-handed mainhand has just made illegal, and skill
  // choices belonging to a weapon that is no longer equipped.
  function pruneAugments(l) {
    if (!pinnedGear.has('Slot_OffhandWeapon')) pruneIllegal(cat, l);
    const live = new Set(socketsOf(cat, l).map((s) => s.key));
    for (const k of Object.keys(l.augments)) {
      if (!live.has(k) && !pinnedAug.has(k)) delete l.augments[k];
    }
    engine.plan.pruneSelection(l);
  }

  // --- skill choices -------------------------------------------------------
  // Every way to fill one pool: C(options, slots). Weapons offer three and give
  // two, so this is three combinations - cheap enough to enumerate exactly.
  function combinations(options, k) {
    if (k >= options.length) return [options.slice()];
    const out = [];
    const walk = (start, acc) => {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let i = start; i < options.length; i++) { acc.push(options[i]); walk(i + 1, acc); acc.pop(); }
    };
    walk(0, []);
    return out;
  }

  function ascend(start, rand) {
    let cur = clone(start);
    pruneAugments(cur);
    let best = scoreOf(cur);

    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;

      // Gear first: it decides which augment sockets even exist.
      for (const slotId of shuffled(freeSlots, rand)) {
        let bestPick = cur.gear[slotId] ?? null;
        let bestScore = best;
        for (const pick of candidates.get(slotId)) {
          const trial = clone(cur);
          if (pick) trial.gear[slotId] = { item: pick.item, rarity: pick.rarity, stars: pick.stars };
          else delete trial.gear[slotId];
          pruneAugments(trial);
          const s = scoreOf(trial);
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; }
        }
        if (better(bestScore, best)) {
          if (bestPick) cur.gear[slotId] = { item: bestPick.item, rarity: bestPick.rarity, stars: bestPick.stars };
          else delete cur.gear[slotId];
          pruneAugments(cur);
          best = bestScore;
          improved = true;
        }
      }

      // Then which skills to slot. This has to come after gear, because the
      // pool is whatever the equipped weapon offers, and before augments, since
      // an enchant's value depends on what it is procking off.
      for (const pool of shuffled(engine.plan.pools(cur), rand)) {
        if (pinnedSkills.has(pool.key)) continue;
        const opts = combinations(pool.options, pool.slots);
        if (opts.length < 2) continue;
        let bestPick = cur.skills[pool.key];
        let bestScore = best;
        for (const pick of opts) {
          const trial = clone(cur);
          trial.skills[pool.key] = pick;
          const s = scoreOf(trial);
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; }
        }
        if (better(bestScore, best)) {
          cur.skills[pool.key] = bestPick.slice();
          best = bestScore;
          improved = true;
        }
      }

      // Then runes: one of three per skill you have. Only 17 of the 84 gate a
      // step or override a prop, so most comparisons tie and the tiebreak
      // settles them - which is the honest outcome rather than a hidden
      // preference. `bench talents` says which ones are inert.
      if (!pinnedRunes.size) {
        const pools = engine.talents.runePools(engine.evaluate(cur, { target, rank, mix }).rotation);
        for (const pool of shuffled(pools, rand)) {
          let bestPick = cur.runes[pool.skill] ?? null;
          let bestScore = best;
          for (const pick of [...pool.options.map((r) => r.id), null]) {
            const trial = clone(cur);
            if (pick) trial.runes[pool.skill] = pick; else delete trial.runes[pool.skill];
            const got = scoreOf(trial);
            if (better(got, bestScore)) { bestScore = got; bestPick = pick; }
          }
          if (better(bestScore, best)) {
            if (bestPick) cur.runes[pool.skill] = bestPick; else delete cur.runes[pool.skill];
            best = bestScore;
            improved = true;
          }
        }
      }

      // Then augments, against whatever gear now exists.
      for (const sock of shuffled(socketsOf(cat, cur), rand)) {
        if (pinnedAug.has(sock.key)) continue;
        let bestPick = cur.augments[sock.key] ?? null;
        let bestScore = best;
        for (const pick of augOptions(sock.type)) {
          const trial = clone(cur);
          if (pick) trial.augments[sock.key] = pick;
          else delete trial.augments[sock.key];
          const s = scoreOf(trial);
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; }
        }
        if (better(bestScore, best)) {
          if (bestPick) cur.augments[sock.key] = bestPick;
          else delete cur.augments[sock.key];
          best = bestScore;
          improved = true;
        }
      }

      if (!improved) return { loadout: cur, score: best, passes: pass + 1 };
    }
    return { loadout: cur, score: best, passes: maxPasses };
  }

  // Restart 0 starts from the seed as the user gave it; later restarts start
  // from a random legal fill, which is what escapes a local optimum.
  let winner = null;
  const trace = [];
  for (let r = 0; r < Math.max(1, restarts); r++) {
    const rand = rng(0x9e3779b9 + r * 2654435761);
    let seed = clone(spec.loadout);
    engine.plan.pruneSelection(seed);
    if (r > 0) {
      for (const slotId of freeSlots) {
        const list = candidates.get(slotId).filter(Boolean);
        if (!list.length) continue;
        const pick = list[Math.floor(rand() * list.length)];
        seed.gear[slotId] = { item: pick.item, rarity: pick.rarity, stars: pick.stars };
      }
      pruneAugments(seed);
    }
    const got = ascend(seed, rand);
    trace.push({ restart: r, score: got.score.score, passes: got.passes });
    if (!winner || better(got.score, winner.score)) winner = got;
  }

  // Talents last. They do not interact with the gear the way skills do, and 66
  // of the 88 nodes declare nothing a model can read, so a greedy legal
  // allocation over the 22 that do is as much as can be justified - spending
  // the rest on nodes it cannot tell apart would be inventing a recommendation.
  // `granted` is the tier-4 talent a DemonSigil hands over for free.
  if (!spec.pinnedTalents) {
    const granted = new Set();
    for (const [key, augId] of Object.entries(winner.loadout.augments ?? {})) {
      if (!key.endsWith('/AugmentDemonSigil') || !augId) continue;
      for (const sk of cat.itemById.get(augId)?.skills ?? []) granted.add(sk);
    }
    const alloc = engine.talents.suggest(winner.loadout.class, {
      level: winner.loadout.level, points: spec.talentPoints ?? null, granted,
    });
    winner.loadout.talents = alloc.ranks;
    winner.talentAlloc = { ...alloc, granted: [...granted] };
  }

  const finalEval = engine.evaluate(winner.loadout, { target, rank, mix });

  // Talents are attached after the gear search converges, so `winner.score` is
  // the PRE-talent number. Reporting it beside an evaluation that includes them
  // printed two figures for one build that did not agree with each other.
  return {
    loadout: winner.loadout,
    score: scorer.scoreFrom(finalEval),
    scoreBeforeTalents: winner.score.score,
    indifferent: indifferentSlots(winner.loadout, winner.score),
    evaluation: finalEval,
    reference: refEval,
    talentAlloc: winner.talentAlloc ?? null,
    talentCoverage: engine.talents.coverage(winner.loadout.class, winner.loadout.talents ?? {},
      { granted: new Set(winner.talentAlloc?.granted ?? []) }),
    evaluations: counter,
    trace,
    goal, weights,
  };
}

/**
 * Rank every candidate for one slot against the loadout as it stands. This is
 * the "what should go here" question, and unlike a stat-weight table it is
 * exact, because each row is a full re-evaluation.
 */
export function rankSlot(engine, loadout, slotId, spec = {}) {
  const { cat } = engine;
  const { goal = 'dps', weights = null, target, rank = 1, mix = 0.5, rarities = null, stars = 'max' } = spec;
  const cls = cat.classes.find((c) => c.unit === loadout.class);
  const refEval = engine.evaluate(loadout, { target, rank, mix });
  const scorer = engine.makeScorer({ goal, weights, target, rank, mix, ref: refEval });
  const baseScore = scorer.scoreFrom(refEval);

  const rows = [];
  const cands = cat.candidates(slotId, {
    aptitude: cls.aptitude, charLevel: loadout.level, rarities,
    exclude: spec.exclude, rarityRoll: spec.rarityRoll, rarityCap: spec.rarityCap,
  });
  for (const cand of cands) {
    const it = cand.item;
    const st = stars === 'max' ? cat.maxStars(it, cand.rarity) : Math.min(stars, cat.maxStars(it, cand.rarity));
    const trial = {
      ...loadout,
      gear: { ...loadout.gear, [slotId]: { item: it.id, rarity: cand.rarity, stars: st } },
      augments: { ...loadout.augments },
    };
    // A different host item may not host the same augments, and a different
    // weapon offers a different skill pool.
    const live = new Set(engine.socketsOf(trial).map((s) => s.key));
    for (const k of Object.keys(trial.augments)) if (!live.has(k)) delete trial.augments[k];
    trial.skills = Object.fromEntries(Object.entries(trial.skills ?? {}).map(([k, v]) => [k, v.slice()]));
    engine.plan.pruneSelection(trial);
    const ev = engine.evaluate(trial, { target, rank, mix });
    const score = scorer.scoreFrom(ev);
    rows.push({
      item: it,
      rarity: cand.rarity,
      chance: cand.chance,
      stars: st,
      score,
      // A delta needs something to be relative to. With the slot empty the
      // baseline is near zero and a percentage is meaningless, so it is null
      // and the caller shows the absolute score instead.
      delta: baseScore > 1e-9 ? score / baseScore - 1 : null,
      equipped: loadout.gear[slotId]?.item === it.id
        && (loadout.gear[slotId]?.rarity ?? it.rarity) === cand.rarity,
      evaluation: ev,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return { rows, baseScore, reference: refEval };
}
