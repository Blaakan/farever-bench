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
//
//   * An infusion is not a per-slot coordinate. A set pays at 2, 4 and 6
//     pieces of the SAME infusion and nothing in between, so walking one slot
//     at a time never sees a threshold: the first piece of a set is worth
//     nothing and so is the third. Infusions are therefore assigned as a PLAN
//     over the armour the build is wearing - see `infusionPass` - and a piece
//     swapped by the gear pass keeps its slot's infusion, so a set is not
//     broken just by trying a different chest.
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
 * Hand each planned infusion set its pieces: {infusion -> count} over the
 * slots given, as {slot -> infusion}.
 *
 * WHICH pieces a set takes changes nothing about the set - any `count` pieces
 * reach the cap - and everything about the bonus lines: a piece is paid its
 * line only under an infusion of its own faction
 * (st.item.Gear.isInfusionBonusActive@9766), so a set that fills up with a
 * piece ANOTHER planned set matches leaves that set to fill up with one it
 * does not, and a line stays dark for nothing. Handing the sets their pieces
 * one set at a time did exactly that: with Hive Venom and Chain Heal at four
 * pieces each on a Mage, the Bee set took the Manfish head as its filler, the
 * Manfish set was left the Kobold legs, and the build read 479.9 where the
 * same two sets, swapped by hand, read 482.7.
 *
 * So the assignment is solved whole: of every way to give each set exactly
 * its count, the one that lights the most RATING - a chest's line is worth
 * twice a cloak's, so the piece that has to go dark is the one that pays
 * least. There are at most eight armour slots and as many sets as the
 * smallest cap divides them into, so the table is a few hundred states.
 * Ties go to the earlier slot and the larger set, which keeps the answer the
 * same from run to run.
 *
 * NOT weighed: what the rating a piece can roll is worth to the class. Two
 * assignments that light the same rating can differ there, and only the
 * fight could tell them apart.
 *
 * @param slots  slot ids, in slot order
 * @param plan   Map(infusion id -> pieces) or [[id, pieces]]
 * @param fits   (slot, infusion) -> is the piece's bonus line lit under it
 * @param worth  (slot) -> the rating a lit line pays on that piece
 * @param fill   (slot) -> the infusion a piece NO set takes is handed, or
 *               null; omitted, such a piece is left bare
 */
export function assignInfusionSlots(slots, plan, { fits, worth, fill = null }) {
  const sets = [...plan].filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // A plan asking for more pieces than there are is cut short from its
  // smallest set - the callers never build one, and this must not loop.
  let room = slots.length;
  const need = sets.map(([, n]) => { const c = Math.min(n, room); room -= c; return c; });
  const pays = slots.map((s) => Math.max(0, worth(s) ?? 0));
  const spare = slots.map((s) => (fill ? fill(s) ?? null : null));
  const spareLit = spare.map((id, i) => id != null && fits(slots[i], id));

  const memo = new Map();
  // The most rating slots[i..] can light with `left[j]` pieces still owed to
  // set j, and the choice at i that gets it (-1: no set takes the piece).
  const best = (i, left) => {
    if (i === slots.length) return { value: 0, pick: -1 };
    const key = `${i}:${left.join(',')}`;
    let hit = memo.get(key);
    if (hit) return hit;
    for (let j = 0; j < sets.length; j++) {
      if (!left[j]) continue;
      left[j]--;
      const value = best(i + 1, left).value + (fits(slots[i], sets[j][0]) ? pays[i] : 0);
      left[j]++;
      if (!hit || value > hit.value + 1e-9) hit = { value, pick: j };
    }
    // The piece can be left to no set only while the rest still cover what
    // the sets are owed.
    if (slots.length - i > left.reduce((a, b) => a + b, 0)) {
      const value = best(i + 1, left).value + (spareLit[i] ? pays[i] : 0);
      if (!hit || value > hit.value + 1e-9) hit = { value, pick: -1 };
    }
    memo.set(key, hit);
    return hit;
  };

  const out = new Map();
  const left = need.slice();
  for (let i = 0; i < slots.length; i++) {
    const { pick } = best(i, left);
    if (pick >= 0) { out.set(slots[i], sets[pick][0]); left[pick]--; }
    else if (spare[i]) out.set(slots[i], spare[i]);
  }
  return out;
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
  // Slots whose INFUSION is fixed as the seed states it - none stated means
  // not infused. Left unsaid, that is every pinned slot: a caller that holds a
  // piece fixed holds all of it. The CLI narrows it to the pins that carry a
  // `~` part, so pinning a chest there leaves its infusion searchable the
  // same way it leaves its sockets searchable.
  const pinnedInfusion = spec.pinnedInfusion ?? pinnedGear;
  // Which infusions the search may hand out. The default is every one this
  // install does not show to be unobtainable - a pattern whose only source is
  // a Heroic the client refuses to open is withheld, one whose source could
  // not be judged is not. `[]` turns the pass off.
  //
  // Both this and the stat policy below fall back to the ENGINE's options
  // before their own defaults: they describe the run, and bench has a dozen
  // optimize() call sites that would each have to remember to pass them.
  const infusionIds = (spec.infusions ?? engine.opts?.infusions
    ?? [...cat.infusions.keys()].filter((id) => cat.infusionSource(id)?.state !== 'unreleased'))
    .filter((id) => cat.infusions.has(id));
  // What an infused piece nobody owns is taken to have rolled. `none` prices
  // no bonus line at all - a floor, and the default, because the roll is the
  // game's and not a choice. `best` and a named rating are for asking what a
  // set COULD be worth; they only ever light a faction-matched piece, never a
  // Prismatic one.
  const statPolicy = spec.infusionStat ?? engine.opts?.infusionStat ?? 'none';

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
      includeUnreleased: spec.includeUnreleased ?? null,
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
      l = cat.augmentCandidates(type, { exclude: spec.exclude, includeUnreleased: spec.includeUnreleased ?? null })
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
      // ...and what the piece is infused with. Without it the first plan the
      // infusion pass scored would be served back for every other one.
      return g ? `${s.id}=${g.item}/${g.rarity ?? ''}:${g.stars ?? 0}${g.flawless ? 'f' : ''}~${g.generic ?? ''}`
        + `^${g.infusion ?? ''}/${g.infusionStat ?? ''}${g.prismatic ? '!' : ''}` : '';
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
      // Fourth rung, same argument: a set rank whose scripted effect this model
      // does not score is still never worse than not having it. Where six
      // pieces of one infusion and four of it come to the same number, the six
      // also light the branch behind `rank >= 3`.
      const sets = (ev.infusions?.sets ?? []).reduce((n, s) => n + s.rank, 0);
      v = { score: scorer.scoreFrom(ev), tie, grants, sets };
      evalCache.set(key, v);
      counter++;
      if (onProgress && counter % 500 === 0) onProgress(counter);
    }
    return v;
  }

  // Lexicographic: objective, then stat magnitude, then free talents, then
  // infusion set ranks.
  const EPS = 1e-9;
  const better = (a, b) => {
    if (a.score > b.score + EPS) return true;
    if (a.score < b.score - EPS) return false;
    if (a.tie > b.tie + EPS) return true;
    if (a.tie < b.tie - EPS) return false;
    if ((a.grants ?? 0) !== (b.grants ?? 0)) return (a.grants ?? 0) > (b.grants ?? 0);
    return (a.sets ?? 0) > (b.sets ?? 0);
  };

  // --- infusion ---------------------------------------------------------------
  /**
   * A gear entry with its infusion fields set to `infusionId` (or cleared).
   * The bonus stat follows `statPolicy`, and only where the piece would be
   * paid it: a rating the piece can roll, on a piece of the infusion's own
   * faction.
   */
  function dress(entry, infusionId, stat = null) {
    if (!entry) return entry;
    const { infusion, infusionStat, prismatic, ...bare } = entry;
    const item = cat.itemById.get(entry.item);
    if (!infusionId || !item || !cat.canInfuse(item)) return bare;
    const out = { ...bare, infusion: infusionId };
    if (statPolicy === 'none') return out;
    const pool = cat.infusionBonusPool(item);
    const want = stat ?? (statPolicy === 'best' ? (pool.includes(infusionStat) ? infusionStat : pool[0]) : statPolicy);
    if (want && pool.includes(want) && cat.infusionBonusActive(item, { infusion: infusionId, infusionStat: want })) {
      out.infusionStat = want;
    }
    return out;
  }

  /** The armour this build wears that can carry an infusion the search may choose. */
  const freeInfusable = (l) => cat.combatSlots().map((s) => s.id).filter((id) => {
    const g = l.gear[id];
    return g?.item && !pinnedInfusion.has(id) && cat.canInfuse(cat.itemById.get(g.item));
  });

  /**
   * Assign infusions to the armour as a PLAN, and keep it if it wins.
   *
   * A plan is a multiset of (infusion, pieces) where each piece count lands
   * exactly on a cap - pieces between two caps add nothing to the set, so no
   * plan spends them there. Every (infusion, cap) is scored alone first, which
   * is three evaluations per infusion; every plan that fits the armour worn is
   * then ranked by the SUM of those single values, and only the best few are
   * evaluated for real. The sum is an estimate (penetration has increasing
   * returns, a stat row can saturate a cap) and is used only to choose what to
   * evaluate - the plan kept is the one whose real score is best.
   *
   * Pieces a set does not need are handed an infusion of their own faction when
   * a bonus stat is being priced, because one matched piece lights its bonus
   * line whatever the set's rank.
   */
  const INFUSION_SHORTLIST = 8;
  // The largest share of a build's score any plan has added so far in this
  // run. The gear pass uses it to decide whether a piece that ADDS an
  // infusable slot is worth re-planning for - see there.
  let planGainSeen = 0;
  function infusionPass(cur, best) {
    if (!infusionIds.length) return null;
    const slots = freeInfusable(cur);
    if (!slots.length) return null;
    const caps = cat.infusionCaps;
    const itemOf = (slotId) => cat.itemById.get(cur.gear[slotId].item);
    // Pieces the user infused by pin still count towards their own set.
    const fixed = new Map();
    for (const id of pinnedInfusion) {
      const inf = cur.gear[id]?.infusion;
      if (inf) fixed.set(inf, (fixed.get(inf) ?? 0) + 1);
    }
    const matched = (slotId, infId) => cat.infusions.get(infId)?.faction === cat.factionOrigin(itemOf(slotId));

    // What a lit line pays on the piece in this slot - the rating the policy
    // asks about, or the best the piece can roll when it asks about none in
    // particular. With `--infusion-stat none` nothing of it is priced, and it
    // still decides which pieces a set takes: the build printed is the one a
    // player would infuse, and its "reads LOW by up to" line counts them.
    const lineWorth = new Map();
    const worth = (slotId) => {
      let w = lineWorth.get(slotId);
      if (w === undefined) {
        const g = cur.gear[slotId];
        const item = itemOf(slotId);
        const rarity = cat.instanceRarity(item, g);
        const levelOpts = {
          charLevel: cur.level, stars: Math.min(g.stars ?? 0, cat.maxStars(item, rarity)), rarity,
          flawless: !!g.flawless, level: g.level ?? null,
          socketed: cat.socketsFor(item).map((t) => cur.augments?.[`${slotId}/${t}`]).filter(Boolean),
        };
        const pool = cat.infusionBonusPool(item);
        const asked = statPolicy === 'none' || statPolicy === 'best' ? pool : pool.filter((st) => st === statPolicy);
        w = Math.max(0, ...asked.map((st) => cat.infusionBonus(item, st, levelOpts)));
        lineWorth.set(slotId, w);
      }
      return w;
    };

    // Turn {infusion -> pieces} into {slot -> infusion}, lighting as much
    // rating as that plan can - see assignInfusionSlots. With `fill`, the
    // pieces no set needs are handed an infusion of their own faction - only
    // ever asked for when a bonus stat is being priced.
    const assign = (plan, { fill = false } = {}) => assignInfusionSlots(slots, plan, {
      fits: matched, worth,
      fill: fill ? (slotId) => infusionIds.find((id) => matched(slotId, id)) ?? null : null,
    });
    const filling = statPolicy !== 'none';
    const build = (byslot) => {
      const trial = clone(cur);
      for (const slotId of slots) trial.gear[slotId] = dress(cur.gear[slotId], byslot.get(slotId) ?? null);
      return trial;
    };
    const tryScore = (trial) => { try { return scoreOf(trial); } catch { return null; } };

    // 1. each (infusion, cap) alone - and alone means WITHOUT the fill. The
    //    fill is worth roughly the same whatever the sets are, so scoring it
    //    inside every single made each one claim it, and the sum then ranked
    //    four two-piece sets (four claims) above the plan that actually wins.
    const none = tryScore(build(new Map()));
    if (!none) return null;
    // What one filled piece is worth, for the estimate only.
    const filled = filling ? tryScore(build(assign(new Map(), { fill: true }))) : null;
    const perFill = filled ? Math.max(0, filled.score - none.score) / slots.length : 0;
    const options = [];           // {id, n, value}
    for (const infId of infusionIds) {
      for (const cap of caps) {
        const n = cap - (fixed.get(infId) ?? 0);
        if (n <= 0 || n > slots.length) continue;
        const got = tryScore(build(assign(new Map([[infId, n]]))));
        if (got) options.push({ id: infId, n, value: got.score - none.score, rank: caps.filter((c) => c <= cap).length });
      }
    }
    // 2. every plan that fits, by the sum of its parts.
    const byId = new Map();
    for (const o of options) { if (!byId.has(o.id)) byId.set(o.id, []); byId.get(o.id).push(o); }
    const idList = [...byId.keys()];
    const plans = [];
    const walk = (i, used, acc, value, ranks) => {
      if (i === idList.length) {
        plans.push({ plan: new Map(acc), value: value + perFill * (slots.length - used), ranks });
        return;
      }
      walk(i + 1, used, acc, value, ranks);
      for (const o of byId.get(idList[i])) {
        if (used + o.n > slots.length) continue;
        acc.push([o.id, o.n]);
        walk(i + 1, used + o.n, acc, value + o.value, ranks + o.rank);
        acc.pop();
      }
    };
    walk(0, 0, [], 0, 0);
    plans.sort((a, b) => b.value - a.value || b.ranks - a.ranks);

    // 3. the shortlist, for real.
    let win = null;
    for (const p of plans.slice(0, INFUSION_SHORTLIST)) {
      const trial = build(assign(p.plan, { fill: filling }));
      const got = tryScore(trial);
      if (got && (!win || better(got, win.score))) win = { loadout: trial, score: got };
    }
    if (!win) return null;

    // 4. which rating each lit piece rolled, when the caller asked for the
    //    best one: the pool is three or four ratings per piece.
    if (statPolicy === 'best') {
      for (const slotId of slots) {
        const g = win.loadout.gear[slotId];
        if (!g?.infusionStat) continue;
        for (const stat of cat.infusionBonusPool(itemOf(slotId))) {
          if (stat === g.infusionStat) continue;
          const trial = clone(win.loadout);
          trial.gear[slotId] = dress(g, g.infusion, stat);
          const got = tryScore(trial);
          if (got && better(got, win.score)) win = { loadout: trial, score: got };
        }
      }
    }
    if (none.score > 0) planGainSeen = Math.max(planGainSeen, win.score.score / none.score - 1);
    return better(win.score, best) ? win : null;
  }

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
  // Every way to fill one pool. Weapons offer three and give two, so that is
  // three combinations - cheap enough to enumerate exactly.
  //
  // A pool that REPEATS is a multiset, not a set: a Mage may put the same
  // conduit in two slots, so three slots over two conduits is four fills
  // (SSS, SSP, SPP, PPP) rather than the one that "take every option" gives.
  // Skipping that was not a missing option but a missing answer - the search
  // could never reach the doubled conduit the live game shows, and with
  // slots >= options it did not search the pool at all.
  //
  // Order never matters: `resolve` collapses a mechanic pool's picks to counts
  // and a weapon's two skills are just slotted, so [A,B] and [B,A] are one
  // fill and enumerating both would only cost evaluations.
  const MAX_FILLS = 256;          // a runaway pool costs fights, so bound it

  function combinations(options, k, { repeats = false } = {}) {
    if (!options.length) return [[]];
    if (!Number.isFinite(k)) return [options.slice()];   // RoguePoison: unbounded
    const out = [];
    const walk = (start, acc) => {
      if (out.length >= MAX_FILLS) return;
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let i = start; i < options.length; i++) {
        acc.push(options[i]);
        walk(repeats ? i : i + 1, acc);   // `i` lets an option be taken again
        acc.pop();
      }
    };
    if (!repeats && k >= options.length) return [options.slice()];
    walk(0, []);
    return out.length ? out : [options.slice(0, k)];
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
        // THE SLOT KEEPS ITS INFUSION through a swap. A set is a count of
        // pieces, and a trial that put a bare chest where an infused one stood
        // would be charged the whole set rank for it - every alternative would
        // lose to the piece that happened to be there first. The rolled bonus
        // stat does NOT carry: it belongs to the old piece.
        const carried = pinnedInfusion.has(slotId) ? null : (cur.gear[slotId]?.infusion ?? null);
        const wear = (pick) => dress({ item: pick.item, rarity: pick.rarity, stars: pick.stars, generic: pick.generic }, carried);
        // ...AND A PIECE THAT ADDS AN INFUSABLE SLOT IS JUDGED WITH THE PLAN IT
        // MAKES POSSIBLE. Seven infusable pieces carry one rank-2 set; the
        // eighth makes room for a second, and that second set is the whole
        // value of the swap - which a trial priced as "a bare Epic piece
        // against the Rare one it replaces" never sees. The Rogue is the live
        // case: its best Rare legs beat every Epic pair by 7 dps bare, and
        // lose to them by 10 once the armour is re-planned as four and four.
        // Re-planning costs about forty fights, so it is only asked of a trial
        // that could plausibly win: one within the largest gain a plan has
        // been seen to add in this run.
        const here = cur.gear[slotId]?.item ? cat.itemById.get(cur.gear[slotId].item) : null;
        const addsSlot = (pick) => !!pick && infusionIds.length > 0 && !pinnedInfusion.has(slotId)
          && !(here && cat.canInfuse(here)) && cat.canInfuse(cat.itemById.get(pick.item));
        let bestLoadout = null;
        for (const pick of candidates.get(slotId)) {
          let trial = clone(cur);
          if (pick) trial.gear[slotId] = wear(pick);
          else delete trial.gear[slotId];
          pruneAugments(trial);
          let s = scoreOf(trial);
          let planned = false;
          if (addsSlot(pick) && planGainSeen > 0 && s.score * (1 + planGainSeen) > bestScore.score) {
            const got = infusionPass(trial, s);
            if (got) { trial = got.loadout; s = got.score; planned = true; }
          }
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; bestLoadout = planned ? trial : null; }
        }
        if (better(bestScore, best)) {
          if (bestLoadout) cur = bestLoadout;
          else if (bestPick) cur.gear[slotId] = wear(bestPick);
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
        const opts = combinations(pool.options, pool.slots, { repeats: pool.repeats });
        if (opts.length < 2) continue;
        let bestPick = cur.skills[pool.key];
        let bestScore = best;
        let bestRunes = null;
        // A SKILL NEWLY SLOTTED IS JUDGED WITH ITS BEST RUNE. The rune step
        // below only ever sees the skills already on the bar, and this step
        // used to score a newcomer with whatever its socket happened to hold
        // - nothing, for a skill the search had never slotted. A skill whose
        // worth IS its rune therefore never got onto the bar for the rune
        // step to find: with Flame of Argol pinned, Faithful Winds deals
        // nothing rune-less, ties with leaving the slot to something else,
        // and the strict `better` keeps whichever stood - so the search
        // answered 3 dps under the same build with Faithful Winds and the
        // rune that gives it a hit. Only the newcomers are re-runed here, and
        // a pinned rune stays pinned.
        const held = new Set(cur.skills[pool.key] ?? []);
        for (const pick of opts) {
          let trial = clone(cur);
          trial.skills[pool.key] = pick;
          let s = scoreOf(trial);
          const fresh = [...new Set(pick)].filter((id) => !held.has(id) && !pinnedRunes.has(id));
          if (fresh.length) {
            const runed = new Map(engine.talents.runePools(trial).map((p) => [p.skill, p]));
            for (const id of fresh) {
              for (const rune of [...(runed.get(id)?.options ?? []).map((r) => r.id), null]) {
                if ((trial.runes[id] ?? null) === rune) continue;
                const withRune = clone(trial);
                if (rune) withRune.runes[id] = rune; else delete withRune.runes[id];
                const got = scoreOf(withRune);
                if (better(got, s)) { trial = withRune; s = got; }
              }
            }
          }
          if (better(s, bestScore)) { bestScore = s; bestPick = pick; bestRunes = trial.runes; }
        }
        if (better(bestScore, best)) {
          cur.skills[pool.key] = bestPick.slice();
          if (bestRunes) cur.runes = { ...bestRunes };
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
      {
        // PER POOL, not all-or-nothing. Pinning one rune used to freeze every
        // other rune slot in the build, which is not what a pin means anywhere
        // else in this tool: pinning a chest does not stop the boots being
        // searched.
        const pools = engine.talents.runePools(cur).filter((p) => !pinnedRunes.has(p.skill));
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

      // Then the infusions, against the armour and the stats that now exist.
      // EVERY pass, not once at convergence: planning only after the gear had
      // settled was tried and was both slower and worse - the armour had
      // already been chosen for a build with no set, and each late plan
      // re-opened the whole loop (Mage 471.3 against 485.3, in half again the
      // time). A plan costs about forty fights and most are served from cache
      // once the armour stops moving.
      {
        const got = infusionPass(cur, best);
        if (got) {
          cur = got.loadout;
          best = got.score;
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

  // POINTS THAT BOUGHT NOTHING ARE HANDED BACK. The walk buys a point in a
  // node nothing reads on a PROMISE - the readable value left above it in
  // its branch (talents.mjs `suggest`) - before it knows whether the budget
  // reaches that value, and the ascents after it only ever MOVE a point to
  // where the objective is better. Where the promise is not kept the point
  // stayed: the default Mage of build 25782799 held Life Current 2/2,
  // "nothing readable", under a tier-4 conduit sixteen points do not reach,
  // and printed "16 of 16 points spent" - where `bench talents` says the
  // optimiser does not spend on nodes it cannot tell apart. So, from the
  // ranks actually kept: a point in a node that reads as nothing at the rank
  // it holds is taken back when the allocation is still one a character
  // could have without it (nothing kept stands on it) and the build scores
  // the same on every rung of `better`. One point at a time, to a fixpoint:
  // a gate can stand on another, and one point of a two-point node can be
  // the one a threshold needs. The bookkeeping below reports them unspent.
  if (winner.talentAlloc && !spec.pinnedTalents) {
    const granted = grantedTalents(winner.loadout);
    const points = engine.talents.pointsAt(winner.loadout.level, spec.talentPoints ?? null);
    const same = (a, b) => !better(a, b) && !better(b, a);
    for (let again = true; again;) {
      again = false;
      for (const [id, held] of Object.entries(winner.loadout.talents ?? {})) {
        if (granted.has(id) || engine.talents.readableValue(id, held).readable) continue;
        const trial = { ...winner.loadout.talents };
        if (held <= 1) delete trial[id]; else trial[id] = held - 1;
        if (engine.talents.illegalAllocation(winner.loadout.class, trial, {
          level: winner.loadout.level, points, granted,
        })) continue;
        const probe = clone(winner.loadout);
        probe.talents = trial;
        let got;
        try { got = scoreOf(probe); } catch { continue; }
        if (!same(got, winner.score)) continue;
        winner.loadout.talents = trial;
        again = true;
      }
    }
  }

  // THE ALLOCATION'S BOOKKEEPING, FROM THE RANKS ACTUALLY KEPT. `talentAlloc`
  // is the descriptor of whichever `allocateTalents` call last WON, and the
  // ranks do not always come from that call: the point-moving ascent rewrites
  // them, and a polish round that re-enters the gear loop brings back a
  // loadout whose tree was cut by an allocation nobody kept the descriptor
  // of. The header then printed "13 of 16 points spent, 3 unspent" above a
  // table of sixteen. Counted here, off the loadout, so the header is the
  // table's own arithmetic; `picked` and `blind` are re-derived with it.
  if (winner.talentAlloc && !spec.pinnedTalents) {
    const granted = grantedTalents(winner.loadout);
    const ranks = winner.loadout.talents ?? {};
    const budget = engine.talents.pointsAt(winner.loadout.level, spec.talentPoints ?? null);
    const spent = Object.entries(ranks).filter(([id]) => !granted.has(id)).reduce((n, [, r]) => n + r, 0);
    winner.talentAlloc = {
      ...winner.talentAlloc,
      picked: Object.keys(ranks), ranks: { ...ranks }, spent, budget, unspent: Math.max(0, budget - spent),
      // GATE POINTS: the nodes that read as nothing at the rank they hold
      // and that the allocation cannot lose a point of - a tier taken above
      // stands on them. (What else is left of such nodes after the hand-back
      // above is one the fight scores through a reader of its own; that is
      // no gate, and the table prints what the fight makes of it.)
      blind: Object.keys(ranks).filter((id) => {
        if (granted.has(id) || engine.talents.readableValue(id, ranks[id]).readable) return false;
        const trial = { ...ranks };
        if (ranks[id] <= 1) delete trial[id]; else trial[id] = ranks[id] - 1;
        return !!engine.talents.illegalAllocation(winner.loadout.class, trial, {
          level: winner.loadout.level, points: budget, granted,
        });
      }),
      granted: [...granted],
    };
  }

  const finalEval = engine.evaluate(winner.loadout, { target, rank, mix, policy, goal: simGoal });

  return {
    loadout: winner.loadout,
    score: scorer.scoreFrom(finalEval),
    scoreBeforeTalents: scoreBeforeObjectiveTalents,
    indifferent: indifferentSlots(winner.loadout, winner.score),
    evaluation: finalEval,
    reference: refEval,
    // A PINNED allocation still has to be printed. `allocateTalents` returns
    // null when the tree is pinned - it did not choose anything - and the
    // caller took that to mean there was nothing to show, so `--talent` fixed
    // an allocation and then hid it.
    talentAlloc: winner.talentAlloc ?? (spec.pinnedTalents
      ? {
        ranks: winner.loadout.talents ?? {},
        spent: Object.entries(winner.loadout.talents ?? {})
          .filter(([id]) => !grantedTalents(winner.loadout).has(id))
          .reduce((n, [, r]) => n + r, 0),
        budget: engine.talents.pointsAt(winner.loadout.level, spec.talentPoints ?? null),
        unspent: 0, blind: [], pinned: true,
        granted: [...grantedTalents(winner.loadout)],
      }
      : null),
    talentCoverage: engine.talents.coverage(winner.loadout.class, winner.loadout.talents ?? {},
      { granted: grantedTalents(winner.loadout) }),
    evaluations: counter,
    trace,
    goal, weights,
    // What the infusion search was allowed to do, for the report: which
    // infusions it could hand out, which it withheld and why, and what it took
    // an unowned piece's bonus roll to be.
    infusion: {
      offered: infusionIds,
      withheld: (spec.infusions ?? engine.opts?.infusions) ? [] : [...cat.infusions.keys()]
        .map((id) => ({ id, ...cat.infusionSource(id) })).filter((s) => s.state === 'unreleased'),
      statPolicy,
      pinned: [...pinnedInfusion],
    },
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
    includeUnreleased: spec.includeUnreleased ?? null,
  });
  // The slot's infusion goes with whatever is tried in it, as in the search:
  // a player who swaps an infused chest infuses the new one. The piece worn
  // keeps its whole entry (its rolled bonus stat is its own); any other
  // candidate that can be infused takes the infusion and no stat, and one that
  // cannot loses it - which is then a real cost of that candidate.
  const worn = loadout.gear[slotId] ?? null;
  for (const cand of cands) {
    const it = cand.item;
    const st = stars === 'max' ? cat.maxStars(it, cand.rarity) : Math.min(stars, cat.maxStars(it, cand.rarity));
    const entry = { item: it.id, rarity: cand.rarity, stars: st, generic: cand.generic ?? null };
    if (worn?.infusion && cat.canInfuse(it)) {
      entry.infusion = worn.infusion;
      if (worn.item === it.id) {
        if (worn.infusionStat) entry.infusionStat = worn.infusionStat;
        if (worn.prismatic) entry.prismatic = true;
      }
    }
    const trial = {
      ...loadout,
      gear: { ...loadout.gear, [slotId]: entry },
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
