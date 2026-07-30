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
// A DemonSigil grants one tier-4 talent outright: 16 points PLUS that node
// already slotted. Confirmed in game - it costs no point, and no point may be
// spent on that talent afterwards even where the thresholds would allow it,
// because it is already yours. Whether it counts toward its branch's
// thresholds is untestable today: it is always a tier-4 node and there is no
// tier 5 for it to unlock. Treated as not counting, which is the conservative
// reading.
//
// The tree ROOT costs a point, also confirmed, and it is the way in - nothing
// else in the tree is reachable without it.
//
// One worked example of what a purely-scripted node is doing, so the shape is
// on record. Priest_Talent_SolarDevotion says "You can trigger [Sunlight]
// effects without consuming it anymore". Sunlight is a buff that is normally
// CONSUMED by the next final combo attack to deal extra damage; the talent
// stops the consumption so the buff persists. Nothing in the status row
// expresses "consumed on trigger" - that lives in the script layer, which is
// exactly why the kernel is the thing standing between this model and the
// other 64 nodes.
//
// HOW MUCH OF IT CAN BE SCORED IS THE PROBLEM.
//
// Across all four classes there are 88 talent nodes, and only some declare a
// value in ordinary data columns - a stat affix, a self-buff status, a damage
// effect, or a skill granted through `props.subskills`.
//
// The rest are NOT in game code, which an earlier reading of this file claimed.
// **72 of them ship an hscript body**, and between them those scripts call just
// 63 distinct names - of which about twenty are entry-point hooks (onHit,
// onInflictDamage, onKill, onSkillProc, ...) and a handful are built-ins. The
// real host surface for the entire talent layer is roughly 39 functions:
//
//   addAtb addResource addStatus addStatusDuration applyHeal atb checkProba
//   enforceStatus forAllWeaponSkills forceTriggerAllConduits getAtb getCustom
//   getDamageStepIndex getShield getStatusCount getTimeInCombat hasStatus
//   hasStatusApplied hasStatusMaxStacked hasStatusType hasTalent isActiveSkill
//   isAlly isBaseAttack isBasicAttack isFinalAttack isSkillFromPrayer
//   isStatusType isType isWeaponSkill playStep playStepIndexOnSkill
//   reduceCooldown reduceWeaponsCooldown removeStatus resetCooldown setDynVal
//   setStatus wait
//
// So the talent trees are not blocked on a world model. They are blocked on the
// same ~40-function kernel the rest of the script work needs, plus a status
// system - and every one of the 88 nodes carries a texts.desc, so there is a
// readable statement of intent to check any implementation against.
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

  // Points available. The unlock level is declared; the rate is not, so the
  // total is the one number that had to be told to us: 16 at the current cap,
  // confirmed in game.
  //
  // Deliberately NOT interpolated for the levels in between. A half-built tree
  // is not what anyone gears against, and a made-up rate would be a number this
  // tool invented sitting in a column next to numbers it read. Below the unlock
  // level you have none; at or above it you get the full allowance.
  // `--talent-points` overrides if a partial build is what you want to see.
  const DEFAULT_POINTS_AT_CAP = 16;
  function pointsAt(level, override = null) {
    if (override != null) return override;
    return level < unlockLevel ? 0 : DEFAULT_POINTS_AT_CAP;
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
    // Two data links hand a talent something it does not declare itself, and
    // one tempting third that must NOT be followed.
    //
    //   props.subskills          - the Mage conduit talents grant a whole skill
    //   steps[].props.status.ref - a Status step APPLIES that status, which is
    //                              how Priest_Talent_Sunlight comes to be worth
    //                              0.6x Faith Light damage on a 6s buff
    //
    // NOT texts.refs.ref. That is the placeholder that fills ::ref_name:: and
    // ::ref_dmg:: in a description, so it points at whatever the text MENTIONS.
    // 13 different Rogue talents reference Rogue_Talent_LethalPoison_Status and
    // 11 Priest talents reference Priest_Talent_Sunlight_Status - they modify
    // it, they do not each grant it. Following it would count one status's
    // damage thirteen times and would take "readable" from 24 to 59, which is
    // exactly the kind of large, wrong, flattering number worth refusing.
    const granted = [
      ...(s?.props?.subskills ?? []).map((x) => x.skill),
      ...(s?.steps ?? [])
        .filter((st) => st.props?.status?.ref)
        .map((st) => st.props.status.ref),
    ].filter((x, i, arr) => x && arr.indexOf(x) === i);
    const effects = [...(prof?.effects ?? [])];
    for (const g of granted) {
      const gp = combat.profile(g, 3);
      for (const eff of gp?.effects ?? []) effects.push(eff);
      for (const a of (skills.get(g)?.affixes ?? [])) if (a.target?.attribute) affixes.push(a);
    }
    v = {
      affixes, buffs, effects, granted,
      readable: affixes.length > 0 || buffs.length > 0 || effects.length > 0,
      kind: affixes.length ? 'affix' : buffs.length ? 'status'
        : granted.length && effects.length ? 'grants a skill' : effects.length ? 'effect' : 'none',
      // `props.talent.maxPoints` caps how many points a single node takes. Every
      // node that declares it says 1, so one point per node - but it is read
      // rather than assumed, in case a patch introduces a multi-point node.
      maxPoints: s?.props?.talent?.maxPoints ?? 1,
      hasScript: !!s?.script,
      desc: s?.texts?.desc ?? '',
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

    // Greedy over every node that is LEGAL RIGHT NOW, one point at a time.
    //
    // A tier-by-tier walk that commits to one branch leaves points unspent as
    // soon as that branch runs out - a Priest spent 8 of 16 and stopped. This
    // instead re-derives the legal set after every point, so filling one
    // branch to tier 4 and then spilling the remainder into the next-best is
    // the natural outcome rather than a special case.
    //
    // The ordering problem underneath: a readable node is almost always gated
    // behind unreadable ones. Every tree root declares nothing, so ranking by
    // readable value alone picks nothing at all. Each candidate is therefore
    // scored as its own readable value FIRST, and as a tiebreak by how much
    // readable value still sits behind it in its branch - so the points that
    // only open a tier at least open the tier worth opening. Those are marked
    // blind and counted, never presented as considered picks.
    const blind = [];

    // Readable value still unclaimed in a branch, which is what a gate point
    // is really buying.
    const promise = (branchIndex, taken) => tree.nodes
      .filter((n) => n.branchIndex === branchIndex && !taken.has(n.skill))
      .reduce((sum, n) => sum + weight(n.skill), 0);

    const taken = new Set(picked);

    // The root costs a point, and it is the way in. Confirmed in game: it is a
    // node like any other, tier 0 in its own Root branch, and you pay for it.
    // Taken first because nothing else in the tree is reachable without it.
    const rootNode = tree.nodes.find((n) => n.tier === 0);
    if (rootNode && !taken.has(rootNode.skill) && spent < budget) {
      picked.push(rootNode.skill);
      taken.add(rootNode.skill);
      if (!readableValue(rootNode.skill).readable) blind.push(rootNode.skill);
      perBranch.set(rootNode.branchIndex, (perBranch.get(rootNode.branchIndex) ?? 0) + 1);
      spent++;
    }

    while (spent < budget) {
      const legal = tree.nodes.filter((n) => {
        if (taken.has(n.skill)) return false;
        // A talent a sigil handed you cannot also be bought, even where the
        // thresholds would allow it - confirmed in game. It is already yours.
        if (granted.has(n.skill)) return false;
        return (perBranch.get(n.branchIndex) ?? 0) >= tierThreshold(n.tier);
      });
      if (!legal.length) break;

      legal.sort((a, b) => {
        const d = weight(b.skill) - weight(a.skill);
        if (Math.abs(d) > 1e-9) return d;
        // Both unreadable (or equally readable): favour the branch with the
        // most readable value still locked behind it, then the shallower
        // node, then the id so a shared build is reproducible.
        const p = promise(b.branchIndex, taken) - promise(a.branchIndex, taken);
        if (Math.abs(p) > 1e-9) return p;
        if (a.tier !== b.tier) return a.tier - b.tier;
        return a.skill < b.skill ? -1 : 1;
      });

      const n = legal[0];
      // Nothing readable is reachable any more and nothing is locked behind
      // what is left: stop rather than spend the rest at random.
      if (!weight(n.skill) && promise(n.branchIndex, taken) <= 0) break;

      picked.push(n.skill);
      taken.add(n.skill);
      if (!readableValue(n.skill).readable) blind.push(n.skill);
      perBranch.set(n.branchIndex, (perBranch.get(n.branchIndex) ?? 0) + 1);
      spent++;
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
