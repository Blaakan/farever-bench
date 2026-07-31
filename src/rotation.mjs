// ---------------------------------------------------------------------------
// rotation.mjs - search for a rotation, rather than deriving one.
//
// WHAT IS BEING SEARCHED, AND WHY IT IS NOT A SEQUENCE.
//
// The obvious reading of "find the best rotation" is "find the best sequence of
// casts". It is the wrong object. A sequence is optimal for one build against
// one deterministic fight and transfers to nothing; it also learns to dump every
// cooldown in the last twenty seconds, because a cooldown that never comes back
// before the bell is free. Neither is a rotation anyone can play.
//
// So what is searched is a POLICY, in the shape SimulationCraft calls an Action
// Priority List: an ordered list of (skill, condition). At every moment the
// player can act, walk it top to bottom and press the first entry that is ready
// and whose condition holds; if nothing matches, swing. That object is
// stationary - it cannot exploit the end of the fight - and its conditions are
// re-evaluated against whatever build is wearing it, so it transfers.
//
// SimulationCraft has a community writing these by hand, per specialisation.
// Nobody writes them for this game, so this searches for one.
//
// WHAT A CONDITION MAY SAY. Only things the fight already tracks, because a
// condition it cannot evaluate is a rotation nobody can execute:
//
//   always                 press it whenever it is ready
//   buff.<id>.up/.down     a self-buff the rotation can put up
//   debuff.<id>.up/.down   a status this build applies to the target
//   rage>=<n>              a resource pool, at a threshold some cast actually
//                          costs - inventing thresholds just widens the search
//   ready.<id>             another skill is off cooldown  (pair two cooldowns)
//   holding.<id>           another skill is ON cooldown   (fill the gap)
//
// THE SEARCH. Steepest-ascent hill climbing over four move types - reorder,
// relocate, re-condition, drop/restore - with seeded random restarts. Every
// neighbour is one full fight, which costs about a third of a millisecond, so a
// few hundred thousand simulated fights is minutes rather than hours. Restart 0
// starts from the order the model derives, so the search can never return
// something worse than what it already had.
//
// AND IT IS SCORED AGAINST THE DERIVED ORDER. The number that matters is not
// the searched rotation's dps, it is the gap: how much a real rotation is worth
// over pressing whatever is ready. That gap is the honest measure of how much
// sequencing this game's numbers actually reward.
// ---------------------------------------------------------------------------

// Deterministic, like every other search here: a result a user shares has to
// re-derive.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

export const ALWAYS = { kind: 'always' };

/** A condition as a short string, which is also how it is printed. */
export function condLabel(c, nameOf = (x) => x) {
  switch (c.kind) {
    case 'always': return '';
    case 'buff': return `buff.${nameOf(c.id)}.${c.want ? 'up' : 'down'}`;
    case 'debuff': return `debuff.${nameOf(c.id)}.${c.want ? 'up' : 'down'}`;
    case 'resource': return `${c.atb.toLowerCase()}>=${c.min}`;
    case 'ready': return `ready.${nameOf(c.id)}`;
    case 'holding': return `holding.${nameOf(c.id)}`;
    case 'charges': return `charges>=${c.min}`;
    case 'and': return c.all.map((x) => condLabel(x, nameOf)).join(' & ');
    default: return '?';
  }
}

const condKey = (c) => JSON.stringify(c);

// How many atoms one entry's condition may AND together. Real priority lists
// use two constantly - `buff.x.up & rage>=10` - and three occasionally; past
// that a list stops being something a person can follow, and every extra term
// multiplies the neighbourhood.
export const MAX_TERMS = 3;

const terms = (c) => (c.kind === 'and' ? c.all : c.kind === 'always' ? [] : [c]);

/** Build a condition from atoms, normalised so `condKey` compares properly. */
export function conjoin(atoms) {
  const flat = [];
  const seen = new Set();
  for (const a of atoms.flatMap(terms)) {
    const k = condKey(a);
    if (!seen.has(k)) { seen.add(k); flat.push(a); }
  }
  if (!flat.length) return ALWAYS;
  if (flat.length === 1) return flat[0];
  // A stable order, so `buff & rage` and `rage & buff` are ONE candidate rather
  // than two the search evaluates separately.
  flat.sort((a, b) => (condKey(a) < condKey(b) ? -1 : 1));
  return { kind: 'and', all: flat };
}

/**
 * Is this conjunction self-defeating? Two atoms that can never hold at once
 * make the entry dead, and a dead entry is a fight spent finding that out.
 */
function contradictory(c) {
  const list = terms(c);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.kind === b.kind && a.id && a.id === b.id) {
        if ((a.kind === 'buff' || a.kind === 'debuff') && a.want !== b.want) return true;
        if (a.kind !== b.kind) continue;
      }
      if (a.id && a.id === b.id
        && ((a.kind === 'ready' && b.kind === 'holding') || (a.kind === 'holding' && b.kind === 'ready'))) return true;
    }
  }
  return false;
}

/**
 * Every condition worth trying, built from what THIS build can actually
 * produce. A vocabulary taken from the whole game would be mostly conditions
 * that are never true, and every one of them costs a fight to find that out.
 */
export function vocabularyFor(rot) {
  const out = [ALWAYS];
  const seen = new Set([condKey(ALWAYS)]);
  const push = (c) => { const k = condKey(c); if (!seen.has(k)) { seen.add(k); out.push(c); } };

  const selfBuffs = new Set();
  const targetDebuffs = new Set();
  const entries = [...rot.active, ...(rot.filler ?? []), ...(rot.triggered ?? [])];
  for (const e of entries) {
    for (const b of e.applies?.self ?? []) selfBuffs.add(b.status);
    for (const d of e.applies?.target ?? []) targetDebuffs.add(d.status);
  }
  // A dot on the target is a window too - refreshing one early is the classic
  // thing a priority list gets wrong.
  for (const d of rot.dots ?? []) if (d.to !== 'Self') targetDebuffs.add(d.status);

  for (const id of selfBuffs) { push({ kind: 'buff', id, want: true }); push({ kind: 'buff', id, want: false }); }
  for (const id of targetDebuffs) { push({ kind: 'debuff', id, want: true }); push({ kind: 'debuff', id, want: false }); }

  // Resource thresholds, at the amounts something actually costs. `Rage >= 10`
  // is a real decision because Raging Smash costs 10; `Rage >= 7` is noise.
  const costs = new Map();
  for (const e of rot.active) {
    for (const c of e.prof.costs ?? []) {
      if (!(c.amount > 0)) continue;
      if (!costs.has(c.atb)) costs.set(c.atb, new Set());
      costs.get(c.atb).add(Math.round(c.amount));
    }
  }
  for (const [atb, amounts] of costs) {
    for (const a of amounts) {
      push({ kind: 'resource', atb, min: a });
      push({ kind: 'resource', atb, min: a * 2 });
    }
  }

  // Pairing and gap-filling, against the other casts in this rotation.
  for (const e of rot.active) {
    push({ kind: 'ready', id: e.prof.id });
    push({ kind: 'holding', id: e.prof.id });
  }

  // "Do not spend the last charge." A banked charge is the one resource the
  // fight already tracks per skill, and it is the entry's OWN charges that
  // matter - `ready.X` above asks about somebody else's.
  let maxCharges = 1;
  for (const e of rot.active) maxCharges = Math.max(maxCharges, e.prof.charges ?? 1);
  for (let n = 2; n <= maxCharges; n++) push({ kind: 'charges', min: n });
  return out;
}

/**
 * Compile an APL into the function `sim.mjs` asks for.
 *
 * The list is AUTHORITATIVE: a skill with no entry is never pressed. That is
 * what makes "drop this cast entirely" a move the search can make, and dropping
 * a cast is a real rotation decision - a 40-second cooldown worth less per
 * second than a swing should not be pressed at all.
 */
export function makePolicy(apl, { appendUnlisted = false } = {}) {
  let cachedActives = null;
  let index = null;
  const excluded = new Set(apl.excluded ?? []);
  return (ctx) => {
    if (ctx.actives !== cachedActives) {
      cachedActives = ctx.actives;
      index = new Map(ctx.actives.map((a, i) => [a.prof.id, i]));
    }
    // `self` is the index of the entry being tested, because `charges>=n` asks
    // about the skill on that line rather than about somebody else's.
    const holds = (c, self) => {
      switch (c.kind) {
        case 'always': return true;
        case 'and': {
          for (const x of c.all) if (!holds(x, self)) return false;
          return true;
        }
        case 'buff': {
          let up = false;
          for (const b of ctx.buffs.keys()) if (b.status === c.id) { up = true; break; }
          return up === c.want;
        }
        case 'debuff': {
          let up = false;
          for (const d of ctx.debuffs.keys()) if (d.status === c.id) { up = true; break; }
          return up === c.want;
        }
        case 'resource': return (ctx.pools.get(c.atb)?.value ?? 0) >= c.min - 1e-9;
        case 'ready': {
          const i = index.get(c.id);
          return i !== undefined && ctx.charges(i) > 0;
        }
        case 'holding': {
          const i = index.get(c.id);
          return i !== undefined && ctx.charges(i) <= 0;
        }
        case 'charges': return ctx.charges(self) >= c.min;
        default: return false;
      }
    };
    // A skill may appear MORE THAN ONCE, under different conditions. That is
    // the commonest idiom in a real priority list - `Rampage if the armour is
    // stripped` near the top, and a bare `Rampage` further down as the fallback
    // - and a list that allows one entry per skill cannot say it at all.
    for (const e of apl.entries) {
      const i = index.get(e.skill);
      if (i === undefined) continue;
      if (!ctx.ready.includes(i)) continue;
      if (!holds(e.cond, i)) continue;
      return i;
    }
    // A skill the list does not mention. During the APL search that is a
    // deliberate silence and the answer is "swing"; during a KIT search it is
    // usually a skill the kit has only just gained, and leaving it unpressed
    // would make the search reject every change that adds one. So the caller
    // says which of the two it is, and an EXPLICIT drop is remembered either way.
    if (appendUnlisted) {
      const listed = new Set(apl.entries.map((e) => e.skill));
      for (const i of ctx.ready) {
        const id = ctx.actives[i].prof.id;
        if (listed.has(id) || excluded.has(id)) continue;
        return i;
      }
    }
    return -1;
  };
}

/**
 * The order the model derives, as an APL. This is restart 0, so the search
 * starts from what the tool already reported and can only improve on it.
 *
 * `rot.active` is not in priority order - the fight sorts it by density itself -
 * so the caller passes the sorted ids out of the evaluation it just ran.
 */
export function derivedApl(order) {
  return { entries: order.map((skill) => ({ skill, cond: ALWAYS })), excluded: [] };
}

/**
 * Drop entries for skills this build no longer has, and append the ones it has
 * gained. Needed because the kit search moves underneath the APL: change which
 * two weapon skills are slotted and the old list names a skill that is gone and
 * omits one that is new, and an omitted skill is one the policy never presses.
 */
export function repairApl(apl, ids) {
  const have = new Set(ids);
  // Duplicates survive: a skill listed twice under different conditions is the
  // point, not an error to be collapsed.
  const entries = apl.entries.filter((e) => have.has(e.skill));
  const listed = new Set(entries.map((e) => e.skill));
  const excluded = (apl.excluded ?? []).filter((id) => have.has(id));
  for (const id of ids) if (!listed.has(id) && !excluded.includes(id)) entries.push({ skill: id, cond: ALWAYS });
  return { entries, excluded };
}

/**
 * Search for the best APL for one fixed build.
 *
 * @param score  (apl) -> number. One fight. The caller owns what "better"
 *               means, so this works for any goal.
 */
export function searchApl({
  score, ids, vocabulary, seed = 0x9e3779b9, restarts = 12, maxSteps = 60,
  onProgress = null, startFrom = null, maxEntries = null,
}) {
  // Room for roughly two lines per skill, which is what the duplicate idiom
  // needs and rather more than any readable rotation uses.
  maxEntries = maxEntries ?? ids.length * 2;
  const rand = rng(seed);
  let evaluations = 0;
  // A SIMPLER list that scores the same is a better rotation - fewer lines to
  // remember and fewer conditions on each. Without the second half of this,
  // conditions that are quietly tautologies survive to the output: `rage>=9` on
  // a line the fight only offers when it can pay, or `ready.X` on X's own line.
  // They cost nothing, so nothing pushed them out, and they made the printed
  // rotation look like it knew something it did not. The nudge is far below any
  // real difference, so it only ever breaks ties.
  const complexity = (apl) => apl.entries.length * 1e-6
    + apl.entries.reduce((n, e) => n + terms(e.cond).length, 0) * 1e-7;
  const at = (apl) => { evaluations++; return score(apl) - complexity(apl); };

  const clone = (apl) => ({
    entries: apl.entries.map((e) => ({ skill: e.skill, cond: e.cond })),
    excluded: [...(apl.excluded ?? [])],
  });

  /** Every one-step change to this list. */
  function* neighbours(apl) {
    const n = apl.entries.length;
    // Reorder: swap two entries. The cheapest way to say "press that first".
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const c = clone(apl);
        [c.entries[i], c.entries[j]] = [c.entries[j], c.entries[i]];
        yield c;
      }
    }
    // Relocate: pull one entry out and put it back somewhere else. A swap
    // cannot express "this belongs at the top", it can only trade two places.
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const c = clone(apl);
        const [e] = c.entries.splice(i, 1);
        c.entries.splice(j, 0, e);
        yield c;
      }
    }
    // A condition that asks about the line's OWN skill being off cooldown is a
    // tautology - the fight only offers a cast that is ready - and its mirror
    // is a contradiction. Neither is worth a fight to discover.
    const vacuous = (skill, c) => (c.kind === 'ready' || c.kind === 'holding') && c.id === skill;

    // Re-condition: this is where a rotation stops being a priority list.
    for (let i = 0; i < n; i++) {
      for (const cond of vocabulary) {
        if (condKey(cond) === condKey(apl.entries[i].cond)) continue;
        if (vacuous(apl.entries[i].skill, cond)) continue;
        const c = clone(apl);
        c.entries[i] = { skill: c.entries[i].skill, cond };
        yield c;
      }
    }
    // CONJOIN: add a term to a condition that already has one. `buff.x.up &
    // rage>=10` is an ordinary thing for a rotation to want and a single
    // condition per line cannot express it. Contradictions are skipped rather
    // than evaluated - an entry that can never fire costs a fight to discover.
    for (let i = 0; i < n; i++) {
      const cur = apl.entries[i].cond;
      if (terms(cur).length >= MAX_TERMS) continue;
      for (const atom of vocabulary) {
        if (atom.kind === 'always') continue;
        if (vacuous(apl.entries[i].skill, atom)) continue;
        const cond = conjoin([cur, atom]);
        if (condKey(cond) === condKey(cur)) continue;
        if (contradictory(cond)) continue;
        const c = clone(apl);
        c.entries[i] = { skill: c.entries[i].skill, cond };
        yield c;
      }
    }
    // ...and RELAX: drop one term back off again, so the climb can retreat out
    // of a condition that turned out to be too narrow.
    for (let i = 0; i < n; i++) {
      const list = terms(apl.entries[i].cond);
      if (list.length < 2) continue;
      for (let k = 0; k < list.length; k++) {
        const c = clone(apl);
        c.entries[i] = { skill: c.entries[i].skill, cond: conjoin(list.filter((_, x) => x !== k)) };
        yield c;
      }
    }
    // Drop a line, and add one. Not pressing a long cooldown worth less per
    // second than a swing is a real rotation decision, so dropping has to be a
    // move - and a skill is only EXCLUDED when its last line goes, because with
    // duplicates allowed one line of two is just a line.
    for (let i = 0; i < n; i++) {
      const c = clone(apl);
      const [gone] = c.entries.splice(i, 1);
      if (!c.entries.some((e) => e.skill === gone.skill)) c.excluded.push(gone.skill);
      yield c;
    }
    // Adding is allowed even for a skill already listed: that is how a second,
    // looser line appears underneath a tightly-conditioned one. Bounded, so the
    // list cannot grow without limit - and the tie-break prefers shorter lists,
    // so a duplicate that buys nothing is dropped again.
    if (apl.entries.length < maxEntries) {
      for (const id of ids) {
        for (let j = 0; j <= apl.entries.length; j++) {
          const c = clone(apl);
          c.excluded = c.excluded.filter((x) => x !== id);
          c.entries.splice(j, 0, { skill: id, cond: ALWAYS });
          yield c;
        }
      }
    }
  }

  function climb(start) {
    let cur = clone(start);
    let best = at(cur);
    for (let step = 0; step < maxSteps; step++) {
      let bestNext = null, bestScore = best;
      for (const cand of neighbours(cur)) {
        const s = at(cand);
        if (s > bestScore + 1e-9) { bestScore = s; bestNext = cand; }
      }
      if (!bestNext) break;
      cur = bestNext;
      best = bestScore;
      if (onProgress) onProgress({ evaluations, best });
    }
    // The TRUE score, without the shorter-list nudge. That nudge exists to
    // break ties during the climb and has no business in the number the caller
    // reports - comparing a nudged score against an un-nudged one made every
    // restart look like it had missed the winner by a hair.
    return { apl: cur, score: score(cur) };
  }

  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  /** A fresh random list, for diversification. */
  function randomList() {
    const shuffled = [...ids];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return {
      entries: shuffled.map((skill) => ({
        skill, cond: rand() < 0.25 ? pick(vocabulary) : ALWAYS,
      })),
      excluded: [],
    };
  }

  /**
   * A few random moves away from a list that is already good.
   *
   * This is the difference between random restarts and ITERATED LOCAL SEARCH,
   * and on this landscape it is a large one: climbing from a fresh random list
   * reached the best score in 1 restart out of 30, because the basin around a
   * sensible priority order is narrow and almost every random list falls into a
   * worse one. Kicking the incumbent a little and re-climbing searches the
   * neighbourhood of a good answer instead of the whole space at random.
   */
  function perturb(apl) {
    const c = clone(apl);
    const kicks = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < kicks; k++) {
      const n = c.entries.length;
      if (!n) return randomList();
      const move = Math.floor(rand() * 4);
      if (move === 0 && n > 1) {                       // swap
        const i = Math.floor(rand() * n), j = Math.floor(rand() * n);
        [c.entries[i], c.entries[j]] = [c.entries[j], c.entries[i]];
      } else if (move === 1 && n > 1) {                // relocate
        const i = Math.floor(rand() * n), j = Math.floor(rand() * n);
        const [e] = c.entries.splice(i, 1);
        c.entries.splice(j, 0, e);
      } else if (move === 2) {                         // re-condition
        const i = Math.floor(rand() * n);
        c.entries[i] = { skill: c.entries[i].skill, cond: pick(vocabulary) };
      } else if (c.entries.length < maxEntries) {      // add a line
        const id = pick(ids);
        c.excluded = c.excluded.filter((x) => x !== id);
        c.entries.splice(Math.floor(rand() * (n + 1)), 0, { skill: id, cond: ALWAYS });
      } else {                                         // drop a line
        const i = Math.floor(rand() * n);
        const [gone] = c.entries.splice(i, 1);
        if (!c.entries.some((e) => e.skill === gone.skill)) c.excluded.push(gone.skill);
      }
    }
    return c;
  }

  let winner = null;
  const trace = [];
  for (let r = 0; r < Math.max(1, restarts); r++) {
    let start;
    if (r === 0 && startFrom) start = startFrom;
    // Every third restart is a fresh random list, so the search keeps a way out
    // of the incumbent's neighbourhood if the incumbent is in the wrong place.
    else if (winner && r % 3 !== 0) start = perturb(winner.apl);
    else start = randomList();
    const got = climb(start);
    trace.push({ restart: r, score: got.score, from: r === 0 && startFrom ? 'derived' : (winner && r % 3 !== 0 ? 'perturbed' : 'random') });
    if (!winner || got.score > winner.score + 1e-9) winner = got;
    if (onProgress) onProgress({ evaluations, best: winner.score, restart: r });
  }
  return { ...winner, evaluations, trace };
}
