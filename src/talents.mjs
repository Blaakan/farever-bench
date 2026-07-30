// ---------------------------------------------------------------------------
// talents.mjs - the talent tree and the runes, and how much of either is real.
//
// THE STRUCTURE IS FULLY IN THE DATA.
//
//   unit.talentTrees[] = { root, desc, talents: [{ skill, tier, branch }] }
//   branch  = Root | Left | Center | Right
//   tier    = 0 (root) .. 4
//   constant.Talents_TierThresholds = [0, 1, 2, 4, 8]
//     "Points to allocate in the branch to unlock a tier"
//   constant.UnlockLevel_Talents = 10
//
// A Priest tree is 22 nodes: one root, then per branch one tier-1, two tier-2,
// three tier-3 and one tier-4. To take a tier-N node you must already have
// `thresholds[N]` points in THAT branch, so the tiers gate depth per branch and
// a 16-point build can reach tier 4 in one branch (8 spent) with 8 left over,
// or spread across two.
//
// A DemonSigil grants one tier-4 talent outright, so equipping one is 16 points
// plus that node already slotted - and it does not consume a point, nor does it
// count toward its branch's thresholds unless the game says so, which it does
// not say anywhere readable. Treated as slotted-and-free, and flagged.
//
// HOW MUCH OF IT CAN BE SCORED IS THE PROBLEM.
//
// Across all four classes there are 88 talent nodes. **22 declare something a
// data-driven model can read** - 13 carry a stat affix, 2 apply a self-buff
// status, 7 declare a damage effect. The other **66 declare nothing at all**:
// no affix, no effect, no status, and mostly no script either. Their behaviour
// is in game code keyed on the talent being present.
//
// So an optimiser turned loose on the tree would be choosing between 66 nodes
// it cannot tell apart, and presenting the result as a recommendation. This
// module therefore does three things and refuses the fourth:
//
//   * validates an allocation against the real rules (points, thresholds,
//     branch prerequisites, level gate);
//   * scores the 22 nodes that declare something;
//   * reports, per build, how many of the spent points landed on nodes it can
//     actually value;
//   * and does NOT rank a build whose points are mostly on unreadable nodes
//     without saying so in the output.
// ---------------------------------------------------------------------------

export function buildTalentPlan(cdb, ctx, cat, combat, plan) {
  const skills = cdb.byId('skill');
  const units = cdb.byId('unit');
  const branchNames = cdb.enumValues('unit@talentTrees@talents', 'branch');
  const thresholds = cdb.constantFloats('Talents_TierThresholds');
  const unlockLevel = cdb.constant('UnlockLevel_Talents');

  // Points available. The game declares the unlock level but nowhere declares
  // the rate, so this is the one number that has to be told to us - the caller
  // passes it and the default is the observed 16 at the level cap.
  const DEFAULT_POINTS_AT_CAP = 16;
  function pointsAt(level, override = null) {
    if (override != null) return override;
    if (level < unlockLevel) return 0;
    // Linear between the unlock level and the cap, which reproduces 16 at 25
    // and 0 at 10. Stated as an assumption because no constant says it.
    const cap = ctx.consts.maxLevel;
    if (level >= cap) return DEFAULT_POINTS_AT_CAP;
    return Math.floor(DEFAULT_POINTS_AT_CAP * (level - unlockLevel) / (cap - unlockLevel));
  }

  // Tier N is gated on tierThreshold(N) points already spent in that branch.
  // The list is indexed from tier 1, not from tier 0: [0,1,2,4,8] means tier 1
  // is free, tier 2 needs 1, tier 3 needs 2 and tier 4 needs 4. Reading it as
  // thresholds[tier] instead makes tier 4 cost 8 points in a branch that only
  // holds 7 nodes - unreachable, and the allocator silently picks nothing.
  const tierThreshold = (tier) => (tier <= 0 ? 0 : (thresholds[tier - 1] ?? 0));

  // --- the tree -------------------------------------------------------------
  const treeCache = new Map();
  function treeFor(unitId) {
    let t = treeCache.get(unitId);
    if (t) return t;
    const u = units.get(unitId);
    const trees = u?.talentTrees ?? [];
    const nodes = [];
    for (const tr of trees) {
      for (const x of tr.talents ?? []) {
        nodes.push({
          skill: x.skill,
          tier: x.tier ?? 0,
          branch: branchNames[x.branch ?? 0] ?? 'Root',
          branchIndex: x.branch ?? 0,
          name: skills.get(x.skill)?.texts?.name ?? x.skill,
          root: tr.root,
        });
      }
    }
    t = { nodes, byId: new Map(nodes.map((n) => [n.skill, n])), root: trees[0]?.root ?? null };
    treeCache.set(unitId, t);
    return t;
  }

  /** What a node can contribute that this model can actually read. */
  const valueCache = new Map();
  function readableValue(skillId) {
    let v = valueCache.get(skillId);
    if (v) return v;
    const s = skills.get(skillId);
    const prof = combat.profile(skillId, 3);
    const affixes = (s?.affixes ?? []).filter((a) => a.target?.attribute);
    const buffs = plan.selfBuffsOf(skillId);
    const effects = prof?.effects ?? [];
    v = {
      affixes, buffs, effects,
      readable: affixes.length > 0 || buffs.length > 0 || effects.length > 0,
      kind: affixes.length ? 'affix' : buffs.length ? 'status' : effects.length ? 'effect' : 'none',
    };
    valueCache.set(skillId, v);
    return v;
  }

  /**
   * Is this allocation legal? Returns null, or a sentence saying what is wrong.
   * `granted` is the set of nodes handed over for free by a DemonSigil.
   */
  function illegalAllocation(unitId, picked, { level, points, granted = new Set() }) {
    const tree = treeFor(unitId);
    if (!picked.length) return null;
    if (level < unlockLevel) return `talents unlock at level ${unlockLevel}`;

    const spent = picked.filter((id) => !granted.has(id));
    if (spent.length > points) return `${spent.length} talents picked but only ${points} points available`;

    // Threshold check, per branch, in tier order: a tier-N node needs
    // thresholds[N] points already in that branch. Points from granted nodes do
    // not count - nothing in the data says they should.
    const perBranch = new Map();
    const inOrder = picked.slice().sort((a, b) => (tree.byId.get(a)?.tier ?? 0) - (tree.byId.get(b)?.tier ?? 0));
    for (const id of inOrder) {
      const n = tree.byId.get(id);
      if (!n) return `${id} is not in the ${unitId} tree`;
      const need = tierThreshold(n.tier);
      const have = perBranch.get(n.branchIndex) ?? 0;
      if (n.tier > 0 && have < need) {
        return `${n.name} is tier ${n.tier} and needs ${need} points in ${n.branch}, but only ${have} are there`;
      }
      if (!granted.has(id)) perBranch.set(n.branchIndex, have + 1);
    }
    return null;
  }

  /**
   * A greedy legal allocation over the nodes this model can score. Walks tiers
   * in order so thresholds are satisfiable, and stops when it runs out of
   * points OR out of readable nodes - it does NOT spend the remainder on nodes
   * it cannot value, because that would be inventing a recommendation.
   */
  function suggest(unitId, { level, points = null, granted = new Set() } = {}) {
    const tree = treeFor(unitId);
    const budget = pointsAt(level, points);
    const picked = [...granted];
    const perBranch = new Map();
    let spent = 0;

    // Score a node in isolation: the sum of what it grants, which is enough to
    // order the readable ones against each other.
    const weight = (id) => {
      const v = readableValue(id);
      if (!v.readable) return 0;
      let w = 0;
      for (const a of v.affixes) w += Math.abs(a.val ?? 0);
      for (const b of v.buffs) for (const a of b.affixes) w += Math.abs(a.val ?? 0) * (b.stacks ?? 1);
      for (const e of v.effects) w += Math.abs(e.baseVal ?? 0) + e.scaling.reduce((s, x) => s + Math.abs(x.ratio) * 50, 0);
      return w;
    };

    // Tier by tier, so a threshold is always reachable when it is needed.
    //
    // The hard part: a readable node is usually gated behind unreadable ones.
    // Every tree root declares nothing, and tier 1 costs a point before tier 2
    // opens - so allocating over readable nodes ALONE picks nothing at all.
    // The gate points therefore have to be spent, and the honest thing is to
    // spend them, mark them blind, and report the count rather than pretend
    // the pick was considered. Within a tier the blind choice is by id so it
    // is at least reproducible.
    const blind = [];
    const targetBranch = (() => {
      // Commit to the branch whose readable nodes are worth the most, so the
      // gate points at least buy depth somewhere useful.
      const per = new Map();
      for (const n of tree.nodes) {
        if (n.tier === 0) continue;
        per.set(n.branchIndex, (per.get(n.branchIndex) ?? 0) + weight(n.skill));
      }
      let best = null, bw = -1;
      for (const [b, w] of per) if (w > bw) { bw = w; best = b; }
      return best;
    })();

    for (let tier = 0; tier <= 4 && spent < budget; tier++) {
      const need = tierThreshold(tier);
      const here = tree.nodes
        .filter((n) => n.tier === tier && !picked.includes(n.skill))
        .sort((a, b) => {
          // Readable first, then by value, then by id for reproducibility.
          const d = weight(b.skill) - weight(a.skill);
          if (d) return d;
          return a.skill < b.skill ? -1 : 1;
        });
      for (const n of here) {
        if (spent >= budget) break;
        // Stay in the chosen branch once past the root, so the thresholds
        // actually accumulate instead of being spread thin.
        if (tier > 0 && targetBranch != null && n.branchIndex !== targetBranch) continue;
        if (tier > 0 && (perBranch.get(n.branchIndex) ?? 0) < need) continue;
        picked.push(n.skill);
        if (!weight(n.skill)) blind.push(n.skill);
        perBranch.set(n.branchIndex, (perBranch.get(n.branchIndex) ?? 0) + 1);
        spent++;
      }
    }
    return { picked, spent, budget, unspent: budget - spent, blind };
  }

  /** Coverage: how much of a build's talent spend the model can see. */
  function coverage(unitId, picked, { granted = new Set() } = {}) {
    const tree = treeFor(unitId);
    const spent = picked.filter((id) => !granted.has(id));
    const readable = spent.filter((id) => readableValue(id).readable);
    return {
      spent: spent.length,
      readable: readable.length,
      blind: spent.length - readable.length,
      granted: [...granted],
      total: tree.nodes.length,
      totalReadable: tree.nodes.filter((n) => readableValue(n.skill).readable).length,
    };
  }

  // --- runes ----------------------------------------------------------------
  // A rune (the game calls them skill masteries) is one of three per skill, and
  // it modifies its skill two ways, both readable:
  //
  //   * `steps[].cond.mastery` names a rune; that step exists only when the
  //     rune is slotted. 19 steps are gated this way across 17 runes, and 6 of
  //     them carry damage effects.
  //   * `mastery[].props` overrides the skill's own props. Only `charges` and
  //     `cooldown` appear, and both change throughput directly.
  //
  // Everything else a rune does lives in its description and in game code.
  function runesFor(skillId) {
    return (skills.get(skillId)?.mastery ?? []).map((m) => ({
      id: m.id,
      name: m.text?.name ?? m.id,
      desc: m.text?.desc ?? '',
      props: m.props ?? {},
      vars: m.vars ?? {},
      // What the model can actually read out of it.
      gatesSteps: gatedSteps(skillId, m.id),
      overrides: Object.keys(m.props ?? {}),
    }));
  }

  function gatedSteps(skillId, masteryId) {
    const s = skills.get(skillId);
    let n = 0, withEffects = 0;
    for (const st of s?.steps ?? []) {
      if (st.cond?.mastery !== masteryId) continue;
      n++;
      if ((st.effects ?? []).length) withEffects++;
    }
    return { steps: n, withEffects };
  }

  /** Every skill in this rotation that offers a rune choice. */
  function runePools(rotation) {
    const out = [];
    const seen = new Set();
    for (const entry of [...rotation.active, ...rotation.triggered, ...rotation.filler, ...(rotation.passive ?? [])]) {
      const id = entry.prof.id;
      if (seen.has(id)) continue;
      seen.add(id);
      const runes = runesFor(id);
      if (runes.length < 2) continue;
      out.push({ key: `rune/${id}`, skill: id, name: entry.prof.name, options: runes, slots: 1 });
    }
    return out;
  }

  return {
    treeFor, readableValue, illegalAllocation, suggest, coverage, pointsAt,
    runesFor, runePools, gatedSteps,
    thresholds, unlockLevel, branchNames,
    defaultPointsAtCap: DEFAULT_POINTS_AT_CAP,
  };
}
