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
// A pure data function that happens to live next to the printer: which secondary
// rating a piece pays THIS class, out of the cross of its faction with the
// wearer's own aptitude. The search needs it for the same reason the output
// prints it - see `themeSeeds`.
import { ratingGiven } from './format.mjs';

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
    // An authored rotation to score every candidate against, instead of the
    // derived one. `bench rotation` alternates: search the kit with the best
    // rotation held fixed, then search the rotation with the best kit held
    // fixed. Without this the kit is always chosen against a rotation nobody
    // ends up playing.
    policy = null,
  } = spec;

  const pinnedGear = spec.pinnedGear ?? new Set();
  const pinnedAug = spec.pinnedAug ?? new Set();
  // Skill pools the user chose by hand.
  const pinnedSkills = spec.pinnedSkills ?? new Set();
  const pinnedRunes = spec.pinnedRunes ?? new Set();

  // The objective the FIGHT maximises. A single goal is handed through so the
  // derived rotation plays for it; a blend keeps the fight's everything-counts
  // criterion, because the fight cannot see the blend's normalisation.
  const simGoal = (weights && Object.keys(weights).length) || goal === 'mixed' ? 'mixed' : goal;
  // The reference used to normalise a weighted blend: the seed as given, so
  // the numbers a user reads are relative to where they started.
  const refEval = engine.evaluate(spec.loadout, { target, rank, mix, goal: simGoal });
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
      generic: c.generic ?? null,
      stars: stars === 'max' ? cat.maxStars(c.item, c.rarity) : Math.min(stars, cat.maxStars(c.item, c.rarity)),
    })).filter((c) => !(slotId === 'Slot_Weapon1' && offhandPinnedFull && !cat.allowsOffhand(cat.itemById.get(c.item))));
    if (allowEmpty || slotId === 'Slot_OffhandWeapon') list.push(null);
    candidates.set(slotId, list);
  }
  // "You pinned a shield and now nothing one-handed is left to put in the other
  // hand" - which is only a question when the mainhand is still being CHOSEN.
  // Pinning both hands took this branch too, because a pinned slot has no
  // candidate list at all and `undefined?.some()` is falsy: pinning a legal
  // one-hander and a shield together was refused by name, on the grounds that
  // no legal one-hander existed. The genuinely illegal pairing - a two-hander
  // and a shield - is caught above, where both are known.
  if (offhandPinnedFull && candidates.has('Slot_Weapon1')
    && !candidates.get('Slot_Weapon1').some(Boolean)) {
    throw new Error('the pinned offhand leaves no legal one-handed mainhand for this class and level');
  }

  const augCandidates = new Map();
  function augOptions(type) {
    let l = augCandidates.get(type);
    if (!l) {
      l = cat.augmentCandidates(type, { exclude: spec.exclude })
        // A sigil grants a talent, and a talent belongs to exactly one class.
        // All twelve fit the socket; only this class's three are legal to wear
        // meaningfully, and offering the rest let the search pin a Warrior
        // talent into a Priest tree.
        .filter((a) => type !== 'AugmentDemonSigil'
          || (a.skills ?? []).some((s) => treeNodes.has(s)))
        .map((a) => a.id);
      l.push(null); // leaving a socket empty is a legitimate choice
      augCandidates.set(type, l);
    }
    return l;
  }

  // --- the talent tree, inside the search ----------------------------------
  // Talents used to be allocated once, AFTER the gear search had converged, so
  // every weapon was compared against a build with an empty tree. That is
  // backwards in both directions: Sharp Mind's CooldownReduction is worth more
  // on a weapon whose skills have long cooldowns, and a DemonSigil is worth a
  // whole tier-4 node that the gear search could not see. So the tree is
  // allocated as part of the build and re-allocated whenever what feeds it -
  // the sigils - changes.
  const treeNodes = new Set(engine.talents.treeFor(spec.loadout.class).nodes.map((n) => n.skill));

  /** The tier-4 talents this build's sigils hand over for free. */
  function grantedTalents(loadout) {
    const granted = new Set();
    for (const [key, augId] of Object.entries(loadout.augments ?? {})) {
      if (!key.endsWith('/AugmentDemonSigil') || !augId) continue;
      for (const sk of cat.itemById.get(augId)?.skills ?? []) {
        // A sigil grants a talent, and a talent belongs to exactly one class.
        // Without this check a Warrior sigil lands on a Priest and inserts a
        // node into a tree it is not part of.
        if (treeNodes.has(sk)) granted.add(sk);
      }
    }
    return granted;
  }

  function allocateTalents(loadout, { byObjective = false } = {}) {
    if (spec.pinnedTalents) return null;
    const granted = grantedTalents(loadout);
    // Ranking a point by the REAL objective costs one evaluation per candidate
    // per point. That is worth paying once the gear has settled, and not worth
    // paying inside every pass, so the search allocates by the cheap heuristic
    // while it moves and re-allocates by the objective when it stops.
    // The value of a point is the DELTA it buys, not the score of the build
    // that holds it - `suggest` stops when the best remaining point is worth
    // nothing, and an absolute score is never zero.
    const at = (ranks, extra) => {
      const trial = clone(loadout);
      trial.talents = { ...Object.fromEntries(ranks), ...extra };
      try { return scoreOf(trial).score; } catch { return -Infinity; }
    };
    const value = byObjective
      ? (id, atRank, ranks) => at(ranks, { [id]: atRank }) - at(ranks, {})
      : null;
    const alloc = engine.talents.suggest(loadout.class, {
      level: loadout.level, points: spec.talentPoints ?? null, granted, value,
    });
    loadout.talents = alloc.ranks;
    return { ...alloc, granted: [...granted] };
  }

  /**
   * Coordinate ascent on the ALLOCATION itself: move one point from where it is
   * to somewhere it is worth more, keep the move if the objective agrees, and
   * repeat until nothing moves.
   *
   * A greedy that walks tiers in order cannot revisit a decision, and on a tree
   * with thresholds it does not get a second chance: taking a tier-1 node opens
   * a branch, so the first few points decide which seven nodes are even
   * reachable. On the Warrior that showed up as one point in the wrong place
   * being worth 3% - the branch spends four points to open tier 3 and the
   * greedy had already committed them elsewhere.
   *
   * Every candidate is checked against the real rules before it is scored, so
   * nothing here can produce an allocation a character could not have.
   */
  function refineTalents(loadout, granted) {
    if (spec.pinnedTalents) return false;
    const tree = engine.talents.treeFor(loadout.class);
    const points = engine.talents.pointsAt(loadout.level, spec.talentPoints ?? null);
    if (!points) return false;
    let best = scoreOf(loadout);
    let moved = false;
    for (let round = 0; round < 6; round++) {
      let bestMove = null;
      const ranks = { ...(loadout.talents ?? {}) };
      const held = Object.keys(ranks).filter((id) => !granted.has(id));
      for (const from of held) {
        for (const node of tree.nodes) {
          if (granted.has(node.skill)) continue;
          if (node.skill === from) continue;
          const trial = { ...ranks };
          if ((trial[from] ?? 0) <= 1) delete trial[from]; else trial[from] -= 1;
          trial[node.skill] = (trial[node.skill] ?? 0) + 1;
          if (engine.talents.illegalAllocation(loadout.class, trial, {
            level: loadout.level, points, granted,
          })) continue;
          const probe = clone(loadout);
          probe.talents = trial;
          let got;
          try { got = scoreOf(probe); } catch { continue; }
          if (better(got, best) && (!bestMove || better(got, bestMove.score))) {
            bestMove = { ranks: trial, score: got };
          }
        }
      }
      if (!bestMove) break;
      loadout.talents = bestMove.ranks;
      best = bestMove.score;
      moved = true;
    }
    return moved;
  }

  let counter = 0;
  const evalCache = new Map();
  function scoreOf(loadout) {
    // Only the decisions matter, so key on them rather than the whole object.
    const key = cat.combatSlots().map((s) => {
      const g = loadout.gear[s.id];
      return g ? `${s.id}=${g.item}/${g.rarity ?? ''}:${g.stars ?? 0}${g.flawless ? 'f' : ''}~${g.generic ?? ''}` : '';
    }).join('|')
      + '#' + Object.entries(loadout.augments).filter(([, v]) => v).sort().map(([k, v]) => k + '=' + v).join('|')
      + '$' + Object.entries(loadout.skills ?? {}).sort().map(([k, v]) => k + '=' + v.join('+')).join('|')
      + '&' + Object.entries(loadout.runes ?? {}).filter(([, x]) => x).sort().join('|')
      + '%' + Object.entries(loadout.talents ?? {}).sort().map(([k, v]) => k + ':' + v).join('|');
    let v = evalCache.get(key);
    if (v === undefined) {
      const ev = engine.evaluate(loadout, { target, rank, mix, policy, goal: simGoal });
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
      // Third rung of the ladder: a DemonSigil hands over a whole tier-4 talent
      // for nothing, and most of those talents declare no affix, no effect and
      // no status - so the objective and the stat tiebreak are both blind to
      // them and the socket stayed empty. An empty socket is never better than
      // a free talent, so "how many talents did this build get for free" breaks
      // the tie, and the output says the pick is not scoreable rather than
      // presenting it as a considered choice.
      const grants = Object.entries(loadout.augments ?? {})
        .filter(([k, v2]) => v2 && k.endsWith('/AugmentDemonSigil'))
        .reduce((n, [, v2]) => n + (cat.itemById.get(v2)?.skills ?? []).filter((s) => treeNodes.has(s)).length, 0);
      v = { score: scorer.scoreFrom(ev), tie, grants };
      evalCache.set(key, v);
      counter++;
      if (onProgress && counter % 500 === 0) onProgress(counter);
    }
    return v;
  }

  // Lexicographic: objective, then stat magnitude, then free talents.
  const EPS = 1e-9;
  const better = (a, b) => {
    if (a.score > b.score + EPS) return true;
    if (a.score < b.score - EPS) return false;
    if (a.tie > b.tie + EPS) return true;
    if (a.tie < b.tie - EPS) return false;
    return (a.grants ?? 0) > (b.grants ?? 0);
  };

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
    // The tree is part of the build from the first evaluation onward, so every
    // weapon is compared against a character who has one.
    allocateTalents(cur);
    let best = scoreOf(cur);

    for (let pass = 0; pass < maxPasses; pass++) {
      let improved = false;

      // Gear first: it decides which augment sockets even exist.
      for (const slotId of shuffled(freeSlots, rand)) {
        let bestPick = cur.gear[slotId] ?? null;
        let bestScore = best;
        for (const pick of candidates.get(slotId)) {
          const trial = clone(cur);
          if (pick) trial.gear[slotId] = { item: pick.item, rarity: pick.rarity, stars: pick.stars, generic: pick.generic };
          else delete trial.gear[slotId];
          pruneAugments(trial);
          const s = scoreOf(trial);
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; }
        }
        if (better(bestScore, best)) {
          if (bestPick) cur.gear[slotId] = { item: bestPick.item, rarity: bestPick.rarity, stars: bestPick.stars, generic: bestPick.generic };
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

      // Then runes: one of three per skill you have. Only some of the 84 gate a
      // step, suppress one, gate an affix or override a prop, so many
      // comparisons tie and the tiebreak settles them - which is the honest
      // outcome rather than a hidden preference. `bench talents` counts them
      // live. The pool comes from the LOADOUT, never from the resolved
      // rotation: a rune-gated step is exactly what can give a skill its first
      // damage effect, and a skill with no damage effect never reaches the
      // rotation - so asking the rotation meant such a rune could never be
      // found.
      if (!pinnedRunes.size) {
        const pools = engine.talents.runePools(cur);
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
          // A SIGIL is not scored by what it carries - it carries nothing. It
          // grants a tier-4 talent, and the node arrives in `loadout.talents`
          // only on the next allocation, so comparing two sigils by the score
          // of the trial compared two identical builds and every sigil tied.
          // The grant costs no point, so putting it straight into the trial is
          // the exact comparison: `Infused Wound` is a second bleed and the
          // ones next to it declare nothing, which is a difference the search
          // could not see and now can.
          if (sock.type === 'AugmentDemonSigil') {
            for (const g of grantedTalents(cur)) delete trial.talents[g];
            for (const g of grantedTalents(trial)) trial.talents[g] = 1;
          }
          const s = scoreOf(trial);
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; }
        }
        if (better(bestScore, best)) {
          // The trial that won carried the swapped grant; `cur` must carry it
          // too, or the accepted build keeps the OLD sigil's free node next
          // to the new sigil - a seventeen-point allocation no character can
          // hold, exported with a straight face.
          const oldGrants = sock.type === 'AugmentDemonSigil' ? grantedTalents(cur) : null;
          if (bestPick) cur.augments[sock.key] = bestPick;
          else delete cur.augments[sock.key];
          if (oldGrants) {
            for (const g of oldGrants) delete cur.talents[g];
            for (const g of grantedTalents(cur)) cur.talents[g] = 1;
          }
          best = bestScore;
          improved = true;
        }
      }

      // Sigils are augments, and a sigil changes which tier-4 node is already
      // yours - which changes what the remaining 16 points should buy. So the
      // tree is re-allocated after the augment pass, not before it.
      //
      // KEPT ONLY IF IT WINS. The in-pass allocation is the cheap heuristic
      // one, and it used to be written over whatever was there and the new
      // score taken whether or not it was better - so a pass could lower the
      // build and the loop would carry on from the lower one. It also meant the
      // objective-ranked allocation the search finishes with could not be
      // polished: re-entering the loop threw it away on the first pass.
      const before = best;
      const heldRanks = { ...(cur.talents ?? {}) };
      const hadRanks = Object.keys(heldRanks).length > 0;
      allocateTalents(cur);
      const after = scoreOf(cur);
      if (better(after, before) || !hadRanks) {
        best = after;
        if (better(after, before)) improved = true;
      } else {
        cur.talents = heldRanks;
      }

      if (!improved) {
        // Nothing else moves - so now re-cut the tree against the REAL
        // objective, and if that moves the build, let the loop carry on so the
        // gear can answer.
        //
        // This is the difference between a search and a two-stage guess. The
        // cheap heuristic ranks a point by the size of the numbers on it, which
        // on the Warrior tree lands 28 dps below what the objective picks - and
        // every gear comparison the ascent made was made against that tree. It
        // used to be re-cut once, after all the restarts, at which point
        // nothing could respond to it. One objective allocation per convergence
        // is a few hundred cached evaluations, and it is what makes the search
        // find the penetration build it had been walking past.
        const held = { ...(cur.talents ?? {}) };
        const alloc = allocateTalents(cur, { byObjective: true });
        if (alloc) {
          const after2 = scoreOf(cur);
          if (better(after2, best)) { best = after2; continue; }
          cur.talents = held;
        }
        return { loadout: cur, score: best, passes: pass + 1 };
      }
    }
    return { loadout: cur, score: best, passes: maxPasses };
  }

  /**
   * One seed per secondary rating the class can wear, with every free slot
   * filled by the best piece that pays it.
   *
   * A random restart cannot find these, and coordinate ascent cannot walk to
   * them: penetration has INCREASING returns. Damage through armour is
   * `K / (R(1 - p) + K)`, so each point of ArmorPenetration is worth more than
   * the last, and a build wearing crit gear loses by swapping one slot to
   * penetration even when swapping all nine wins. The Warrior is the live case
   * - a crit set and a penetration set differ by 3% and every single-slot step
   * between them is downhill.
   *
   * Faction is what decides this, which is why the answer is not a stat weight:
   * the same Manfish chest pays a Warrior ArmorPenetration and a Priest Fervor,
   * so "which rating do I build for" is a decision about which factions to
   * wear. Seeding one coherent set per rating asks that question directly, and
   * it costs a handful of deterministic restarts rather than a search.
   */
  function themeSeeds() {
    const best = new Map();  // rating -> Map(slotId -> candidate)
    // ARMOUR AND JEWELLERY ONLY. A weapon is chosen for the kit it grants, not
    // for its faction, and theming the weapon slots picked the highest-level
    // piece that happened to pay the right rating - a sword over the great axe
    // the class actually wants, and a shield in the offhand, which then forbids
    // every two-hander for the whole restart. The theme is about which
    // secondary rating the SET pays; the weapon is a separate question and the
    // ascent asks it first anyway.
    const themable = freeSlots.filter((id) => !/^Slot_(Weapon1|Weapon2|OffhandWeapon)$/.test(id));
    for (const slotId of themable) {
      const level = (c) => {
        const item = cat.itemById.get(c.item);
        try {
          return cat.effectiveLevel(item, {
            charLevel: spec.loadout.level, stars: c.stars ?? 0, rarity: c.rarity ?? null,
          });
        } catch { return 0; }
      };
      for (const c of candidates.get(slotId) ?? []) {
        if (!c) continue;
        const item = cat.itemById.get(c.item);
        if (!item) continue;
        let rating;
        try { rating = ratingGiven(cat, item, cls.aptitude, c.rarity, c.generic); } catch { continue; }
        if (!rating) continue;
        if (!best.has(rating)) best.set(rating, new Map());
        const m = best.get(rating);
        const cur = m.get(slotId);
        if (!cur || level(c) > level(cur)) m.set(slotId, c);
      }
    }
    return [...best.entries()].map(([rating, picks]) => ({ rating, picks }));
  }

  // Restart 0 starts from the seed as the user gave it; later restarts start
  // from a random legal fill, which is what escapes a local optimum, and the
  // last few start from a coherent rating theme, which is what escapes the one
  // random fills cannot.
  let winner = null;
  const trace = [];
  const themes = themeSeeds();
  const total = Math.max(1, restarts) + themes.length;
  for (let r = 0; r < total; r++) {
    const theme = r >= Math.max(1, restarts) ? themes[r - Math.max(1, restarts)] : null;
    const rand = rng(0x9e3779b9 + r * 2654435761);
    let seed = clone(spec.loadout);
    engine.plan.pruneSelection(seed);
    if (theme) {
      for (const [slotId, pick] of theme.picks) {
        seed.gear[slotId] = { item: pick.item, rarity: pick.rarity, stars: pick.stars, generic: pick.generic };
      }
      pruneAugments(seed);
    } else if (r > 0) {
      for (const slotId of freeSlots) {
        const list = candidates.get(slotId).filter(Boolean);
        if (!list.length) continue;
        const pick = list[Math.floor(rand() * list.length)];
        seed.gear[slotId] = { item: pick.item, rarity: pick.rarity, stars: pick.stars, generic: pick.generic };
      }
      pruneAugments(seed);
    }
    const got = ascend(seed, rand);
    trace.push({ restart: theme ? theme.rating : r, score: got.score.score, passes: got.passes });
    if (!winner || better(got.score, winner.score)) winner = got;
  }

  // One last allocation, this time ranking each point by the REAL objective
  // rather than by the size of the numbers on it. The gear has stopped moving,
  // so it is worth the evaluations here and not inside every pass. Nodes the
  // model cannot read still score flat, so the heuristic and the branch
  // `promise` continue to order those - the search does not invent a
  // preference it does not have.
  const scoreBeforeObjectiveTalents = winner.score.score;
  const heuristicRanks = { ...(winner.loadout.talents ?? {}) };
  winner.talentAlloc = allocateTalents(winner.loadout, { byObjective: true });
  if (winner.talentAlloc) {
    const after = scoreOf(winner.loadout);
    // A greedy is a greedy either way round. Ranking by the objective is a
    // better ordering on average and not a guaranteed one, so the allocation it
    // produces has to WIN to be kept - otherwise the last thing the search does
    // is throw away a build it had already found.
    if (better(after, winner.score)) winner.score = after;
    else {
      // Put the heuristic allocation back - and re-derive its DESCRIPTOR too,
      // not just its ranks. Leaving `talentAlloc` null here handed the printer
      // a build with sixteen points spent and nothing to say about them.
      winner.loadout.talents = heuristicRanks;
      winner.talentAlloc = allocateTalents(winner.loadout);
      winner.loadout.talents = heuristicRanks;
    }
  }

  // Then move the points around. A greedy over a tree with tier thresholds
  // commits its first four points to a branch before it can see what the branch
  // holds, and it never revisits them; one point in the wrong place was worth 3%
  // on the Warrior. This is the same coordinate ascent the gear gets, applied to
  // the allocation, and every candidate is checked against the real rules.
  if (refineTalents(winner.loadout, new Set(grantedTalents(winner.loadout)))) {
    winner.score = scoreOf(winner.loadout);
  }

  // ...and the gear has to be allowed to answer. Coordinate ascent may not stop
  // on the pass that moved something big: the tree has just been re-cut against
  // the real objective, and the sixteen points it holds decide what the ratings
  // on your gear are worth. So the loop is re-entered from the build that came
  // out - one more ascent from a good starting point, not another restart - and
  // kept only if it improves.
  for (let round = 0; round < 3; round++) {
    const polished = ascend(clone(winner.loadout), rng(0x9e3779b9));
    let cur = better(polished.score, winner.score)
      ? { ...winner, loadout: polished.loadout, score: polished.score } : null;
    const base = cur ?? winner;
    const ranks = { ...(base.loadout.talents ?? {}) };
    const alloc = allocateTalents(base.loadout, { byObjective: true });
    if (alloc) {
      const after = scoreOf(base.loadout);
      if (better(after, base.score)) { base.score = after; base.talentAlloc = alloc; cur = base; }
      else base.loadout.talents = ranks;
    }
    if (refineTalents(base.loadout, new Set(grantedTalents(base.loadout)))) {
      const after = scoreOf(base.loadout);
      if (better(after, base.score)) { base.score = after; cur = base; }
    }
    if (!cur) break;
    winner = cur;
  }

  const finalEval = engine.evaluate(winner.loadout, { target, rank, mix, policy, goal: simGoal });

  return {
    loadout: winner.loadout,
    score: scorer.scoreFrom(finalEval),
    scoreBeforeTalents: scoreBeforeObjectiveTalents,
    indifferent: indifferentSlots(winner.loadout, winner.score),
    evaluation: finalEval,
    reference: refEval,
    talentAlloc: winner.talentAlloc ?? null,
    talentCoverage: engine.talents.coverage(winner.loadout.class, winner.loadout.talents ?? {},
      { granted: grantedTalents(winner.loadout) }),
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
  const simGoal = (weights && Object.keys(weights).length) || goal === 'mixed' ? 'mixed' : goal;
  const refEval = engine.evaluate(loadout, { target, rank, mix, goal: simGoal });
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
      gear: { ...loadout.gear, [slotId]: { item: it.id, rarity: cand.rarity, stars: st, generic: cand.generic ?? null } },
      augments: { ...loadout.augments },
    };
    // A different host item may not host the same augments, and a different
    // weapon offers a different skill pool.
    const live = new Set(engine.socketsOf(trial).map((s) => s.key));
    for (const k of Object.keys(trial.augments)) if (!live.has(k)) delete trial.augments[k];
    trial.skills = Object.fromEntries(Object.entries(trial.skills ?? {}).map(([k, v]) => [k, v.slice()]));
    engine.plan.pruneSelection(trial);
    const ev = engine.evaluate(trial, { target, rank, mix, goal: simGoal });
    const score = scorer.scoreFrom(ev);
    rows.push({
      item: it,
      rarity: cand.rarity,
      chance: cand.chance,
      generic: cand.generic ?? null,
      stars: st,
      score,
      // A delta needs something to be relative to. With the slot empty the
      // baseline is near zero and a percentage is meaningless, so it is null
      // and the caller shows the absolute score instead.
      delta: baseScore > 1e-9 ? score / baseScore - 1 : null,
      equipped: loadout.gear[slotId]?.item === it.id
        && (loadout.gear[slotId]?.rarity ?? it.rarity) === cand.rarity
        && (loadout.gear[slotId]?.generic ?? null) === (cand.generic ?? null),
      evaluation: ev,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return { rows, baseScore, reference: refEval };
}
