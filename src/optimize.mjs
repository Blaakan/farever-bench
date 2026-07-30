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
  // Slots where the ITEM is pinned but which version of it is not: craft
  // jewellery names several alternative aptitudes and only one is the piece you
  // looted, so that single decision stays in the search.
  const aptFree = spec.aptFree ?? new Set();

  // The reference used to normalise a weighted blend: the seed as given, so
  // the numbers a user reads are relative to where they started.
  const refEval = engine.evaluate(spec.loadout, { target, rank, mix });
  const scorer = engine.makeScorer({ goal, weights, target, rank, mix, ref: refEval });

  const freeSlots = cat.combatSlots()
    .map((s) => s.id)
    .filter((id) => !pinnedGear.has(id) || aptFree.has(id));

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
    // An aptitude-free pin: the only choice left is which version of the one
    // pinned item, so the candidate list is exactly that.
    if (aptFree.has(slotId)) {
      const g = spec.loadout.gear[slotId];
      const item = cat.itemById.get(g.item);
      candidates.set(slotId, cat.payingAptitudes(item, cls.aptitude).map((apt) => ({
        item: g.item, rarity: g.rarity ?? item.rarity, chance: null,
        aptitude: apt, aptitudeIsChoice: true, stars: g.stars ?? 0,
      })));
      continue;
    }
    const list = cat.candidates(slotId, {
      aptitude: cls.aptitude, charLevel: spec.loadout.level,
      rarities, exclude: spec.exclude, rarityRoll: spec.rarityRoll,
    }).map((c) => ({
      item: c.item.id,
      rarity: c.rarity,
      chance: c.chance,
      aptitude: c.aptitude,
      aptitudeIsChoice: c.aptitudeIsChoice,
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
      return g ? `${s.id}=${g.item}/${g.rarity ?? ''}/${g.aptitude ?? ''}:${g.stars ?? 0}${g.flawless ? 'f' : ''}` : '';
    }).join('|') + '#' + Object.entries(loadout.augments).filter(([, v]) => v).sort().map(([k, v]) => k + '=' + v).join('|');
    let v = evalCache.get(key);
    if (v === undefined) {
      v = scorer.score(loadout);
      evalCache.set(key, v);
      counter++;
      if (onProgress && counter % 500 === 0) onProgress(counter);
    }
    return v;
  }

  function clone(l) {
    return { ...l, gear: { ...l.gear }, augments: { ...l.augments } };
  }

  // Drop augments whose host slot no longer holds an item that can host them,
  // and any offhand a two-handed mainhand has just made illegal.
  function pruneAugments(l) {
    if (!pinnedGear.has('Slot_OffhandWeapon')) pruneIllegal(cat, l);
    const live = new Set(socketsOf(cat, l).map((s) => s.key));
    for (const k of Object.keys(l.augments)) {
      if (!live.has(k) && !pinnedAug.has(k)) delete l.augments[k];
    }
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
          if (pick) trial.gear[slotId] = { item: pick.item, rarity: pick.rarity, aptitude: pick.aptitude, stars: pick.stars };
          else delete trial.gear[slotId];
          pruneAugments(trial);
          const s = scoreOf(trial);
          if (s > bestScore + 1e-12) { bestScore = s; bestPick = pick; }
        }
        if (bestScore > best + 1e-12) {
          if (bestPick) cur.gear[slotId] = { item: bestPick.item, rarity: bestPick.rarity, aptitude: bestPick.aptitude, stars: bestPick.stars };
          else delete cur.gear[slotId];
          pruneAugments(cur);
          best = bestScore;
          improved = true;
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
          if (s > bestScore + 1e-12) { bestScore = s; bestPick = pick; }
        }
        if (bestScore > best + 1e-12) {
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
    if (r > 0) {
      for (const slotId of freeSlots) {
        const list = candidates.get(slotId).filter(Boolean);
        if (!list.length) continue;
        const pick = list[Math.floor(rand() * list.length)];
        seed.gear[slotId] = { item: pick.item, rarity: pick.rarity, aptitude: pick.aptitude, stars: pick.stars };
      }
      pruneAugments(seed);
    }
    const got = ascend(seed, rand);
    trace.push({ restart: r, score: got.score, passes: got.passes });
    if (!winner || got.score > winner.score) winner = got;
  }

  const finalEval = engine.evaluate(winner.loadout, { target, rank, mix });
  return {
    loadout: winner.loadout,
    score: winner.score,
    evaluation: finalEval,
    reference: refEval,
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
    exclude: spec.exclude, rarityRoll: spec.rarityRoll,
  });
  for (const cand of cands) {
    const it = cand.item;
    const st = stars === 'max' ? cat.maxStars(it, cand.rarity) : Math.min(stars, cat.maxStars(it, cand.rarity));
    const trial = {
      ...loadout,
      gear: { ...loadout.gear, [slotId]: { item: it.id, rarity: cand.rarity, aptitude: cand.aptitude, stars: st } },
      augments: { ...loadout.augments },
    };
    // A different host item may not host the same augments.
    const live = new Set(engine.socketsOf(trial).map((s) => s.key));
    for (const k of Object.keys(trial.augments)) if (!live.has(k)) delete trial.augments[k];
    const ev = engine.evaluate(trial, { target, rank, mix });
    const score = scorer.scoreFrom(ev);
    rows.push({
      item: it,
      rarity: cand.rarity,
      chance: cand.chance,
      aptitude: cand.aptitude,
      aptitudeIsChoice: cand.aptitudeIsChoice,
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
