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
  //
  // UNRESOLVED, and worth saying so. The implementation indexes from tier 1 -
  // [0,1,2,4,8] read as "tier 1 free, tier 2 needs 1, tier 3 needs 2, tier 4
  // needs 4". The original argument for that was that thresholds[tier] would
  // make tier 4 cost 8 points in a branch holding only 7 NODES, i.e. be
  // unreachable. That argument is dead: 48 of the 88 nodes hold two points, so
  // a branch holds ELEVEN points (1 + 2+2 + 1+2+2 + 1) and 8 is perfectly
  // reachable.
  //
  // So both readings are now internally consistent, and the other one matches
  // the constant's own wording more literally while using all five entries:
  // tier 1 needs 1 (the root, if the root counts toward a branch), tier 2 needs
  // 2, tier 3 needs 4, tier 4 needs 8. This reading is kept because it is what
  // the tool has been checked against, but it rests on nothing now and is one
  // in-game observation away from being settled: note the point total in a
  // branch at the moment its tier-4 node becomes clickable.
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

  /**
   * What a node contributes AT A GIVEN RANK.
   *
   * A talent node holds up to `props.talent.maxPoints` points, and 48 of the 88
   * nodes hold two. The affix rows are rank-gated to match, with exactly the
   * shape damage.mjs already honours for weapon-skill ranks:
   *
   *   Priest_Talent_SharpMind.affixes = [
   *     { CooldownReduction, conds: { maxRank: 1 }, val: 3 },
   *     { CooldownReduction, conds: { minRank: 2 }, val: 6 },
   *   ]
   *
   * Those two rows are MUTUALLY EXCLUSIVE - 3 at one point, 6 at two - and
   * summing them reads 9, a number no character can have. Same error as the
   * castHoldStep charge levels, in a second place.
   */
  const valueCache = new Map();
  function maxPointsOf(skillId) {
    return skills.get(skillId)?.props?.talent?.maxPoints ?? 1;
  }
  function readableValue(skillId, rank = 1) {
    const key = skillId + '@' + rank;
    let v = valueCache.get(key);
    if (v) return v;
    const s = skills.get(skillId);
    const prof = combat.profile(skillId, 3);
    const inRank = (c) => !(c?.minRank != null && rank < c.minRank)
      && !(c?.maxRank != null && rank > c.maxRank)
      && !(c?.equalRank != null && rank !== c.equalRank);
    const affixes = (s?.affixes ?? []).filter((a) => a.target?.attribute && inRank(a.conds));
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
    // A Status step can apply a DEBUFF to the enemy just as easily as a buff to
    // you, and merging the debuff's affixes into your own sheet would credit you
    // with the enemy's armour reduction. `props.status.types` says which, and a
    // status that does not declare itself a Buff is not counted.
    const isBuff = (id) => {
      const types = (skills.get(id)?.props?.status?.types ?? []).map((x) => x.type);
      return !types.length || types.includes('Buff');
    };
    const granted = [
      ...(s?.props?.subskills ?? []).map((x) => x.skill),
      ...(s?.steps ?? [])
        .filter((st) => st.props?.status?.ref && isBuff(st.props.status.ref))
        .map((st) => st.props.status.ref),
    ].filter((x, i, arr) => x && arr.indexOf(x) === i);
    const effects = [...(prof?.effects ?? [])];
    for (const g of granted) {
      const gp = combat.profile(g, 3);
      for (const eff of gp?.effects ?? []) effects.push(eff);
      for (const a of (skills.get(g)?.affixes ?? [])) if (a.target?.attribute && inRank(a.conds)) affixes.push(a);
    }
    v = {
      affixes, buffs, effects, granted,
      readable: affixes.length > 0 || buffs.length > 0 || effects.length > 0,
      kind: affixes.length ? 'affix' : buffs.length ? 'status'
        : granted.length && effects.length ? 'grants a skill' : effects.length ? 'effect' : 'none',
      // `props.talent.maxPoints` caps how many points a node takes. It is 2 on
      // 48 of the 88 nodes - every tier-2, and two thirds of tier 3 - so "one
      // point per node" was wrong for more than half the tree.
      maxPoints: maxPointsOf(skillId),
      rank,
      hasScript: !!s?.script,
      desc: s?.texts?.desc ?? '',
    };
    valueCache.set(key, v);
    return v;
  }

  /** What the NEXT point in this node buys, which is what a greedy must rank. */
  function marginalValue(skillId, currentRank) {
    const next = currentRank + 1;
    if (next > maxPointsOf(skillId)) return null;
    return { rank: next, value: readableValue(skillId, next), from: readableValue(skillId, currentRank) };
  }

  /**
   * Is this allocation legal? Returns null, or a sentence saying what is wrong.
   * `granted` is the set of nodes handed over for free by a DemonSigil.
   */
  function illegalAllocation(unitId, ranks, { level, points, granted = new Set() }) {
    const tree = treeFor(unitId);
    const entries = Object.entries(ranks ?? {});
    if (!entries.length) return null;
    if (level < unlockLevel) return `talents unlock at level ${unlockLevel}`;

    let spent = 0;
    for (const [id, rank] of entries) {
      const n = tree.byId.get(id);
      if (!n) return `${id} is not in the ${unitId} tree`;
      const cap = maxPointsOf(id);
      if (rank > cap) return `${n.name} holds at most ${cap} point${cap === 1 ? "" : "s"}, not ${rank}`;
      if (granted.has(id) && rank > 1) return `${n.name} came from a sigil; no point may be spent on it`;
      if (!granted.has(id)) spent += rank;
    }
    if (spent > points) return `${spent} points allocated but only ${points} available`;

    // Thresholds are denominated in points in that branch, so replay the
    // allocation point by point in tier order and check each one as it lands.
    const perBranch = new Map();
    const inOrder = entries
      .map(([id, rank]) => ({ n: tree.byId.get(id), rank, granted: granted.has(id) }))
      .sort((a, b) => a.n.tier - b.n.tier);
    for (const { n, rank, granted: free } of inOrder) {
      const have = perBranch.get(n.branchIndex) ?? 0;
      const need = tierThreshold(n.tier);
      if (n.tier > 0 && have < need) {
        return `${n.name} is tier ${n.tier} and needs ${need} points in ${n.branch}, but only ${have} are there`;
      }
      if (!free) perBranch.set(n.branchIndex, have + rank);
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
    const perBranch = new Map();
    let spent = 0;

    // What a point is worth, at the rank it would buy. A node holding two
    // points is two separate decisions, and the second is worth the DIFFERENCE
    // between its two rank rows - Sharp Mind is +3 CooldownReduction for the
    // first point and +3 more for the second, not +6 and not +9.
    const magnitude = (v) => {
      let w = 0;
      for (const a of v.affixes) w += Math.abs(a.val ?? 0);
      for (const b of v.buffs) for (const a of b.affixes) w += Math.abs(a.val ?? 0) * (b.stacks ?? 1);
      for (const e of v.effects) w += Math.abs(e.baseVal ?? 0) + e.scaling.reduce((s, x) => s + Math.abs(x.ratio) * 50, 0);
      return w;
    };
    const pointWeight = (id, atRank) => {
      const here = magnitude(readableValue(id, atRank));
      const before = atRank > 1 ? magnitude(readableValue(id, atRank - 1)) : 0;
      return here - before;
    };

    // An allocation is a rank per node, not a set of nodes. `perBranch` counts
    // POINTS, which is what the thresholds are denominated in.
    const ranks = new Map();
    for (const id of granted) ranks.set(id, 1);
    const blind = [];

    const addPoint = (n, atRank) => {
      ranks.set(n.skill, atRank);
      if (atRank === 1 && !readableValue(n.skill, 1).readable) blind.push(n.skill);
      perBranch.set(n.branchIndex, (perBranch.get(n.branchIndex) ?? 0) + 1);
      spent++;
    };

    // The root costs a point and is the way in - confirmed in game.
    const rootNode = tree.nodes.find((n) => n.tier === 0);
    if (rootNode && !ranks.has(rootNode.skill) && spent < budget) addPoint(rootNode, 1);

    // Readable value still unclaimed in a branch: what a gate point is buying.
    const promise = (branchIndex) => tree.nodes
      .filter((n) => n.branchIndex === branchIndex)
      .reduce((sum, n) => {
        const at = ranks.get(n.skill) ?? 0;
        let rest = 0;
        for (let r = at + 1; r <= maxPointsOf(n.skill); r++) rest += Math.max(0, pointWeight(n.skill, r));
        return sum + rest;
      }, 0);

    while (spent < budget) {
      // Every point that could legally be bought right now: a fresh node whose
      // tier is open, or a second rank in a node already held.
      const legal = [];
      for (const n of tree.nodes) {
        const at = ranks.get(n.skill) ?? 0;
        // A sigil-granted talent is already yours and takes no point, even
        // where the thresholds would allow one - confirmed in game.
        if (granted.has(n.skill)) continue;
        if (at >= maxPointsOf(n.skill)) continue;
        if (at === 0 && (perBranch.get(n.branchIndex) ?? 0) < tierThreshold(n.tier)) continue;
        legal.push({ n, next: at + 1, w: pointWeight(n.skill, at + 1) });
      }
      if (!legal.length) break;

      legal.sort((a, b) => {
        const d = b.w - a.w;
        if (Math.abs(d) > 1e-9) return d;
        const p = promise(b.n.branchIndex) - promise(a.n.branchIndex);
        if (Math.abs(p) > 1e-9) return p;
        if (a.n.tier !== b.n.tier) return a.n.tier - b.n.tier;
        return a.n.skill < b.n.skill ? -1 : 1;
      });

      const best = legal[0];
      // Nothing readable is reachable and nothing is locked behind what is
      // left: stop rather than spend the tail at random.
      if (best.w <= 0 && promise(best.n.branchIndex) <= 0) break;
      addPoint(best.n, best.next);
    }

    const picked = [...ranks.keys()];
    return {
      picked, ranks: Object.fromEntries(ranks), spent, budget,
      unspent: budget - spent, blind, granted: [...granted],
    };
  }

  /**
   * Coverage, denominated in POINTS rather than nodes - 48 of the 88 nodes
   * hold two, so counting nodes understates the spend by up to a third.
   */
  function coverage(unitId, ranks, { granted = new Set() } = {}) {
    const tree = treeFor(unitId);
    const entries = Object.entries(ranks ?? {});
    let spent = 0, readable = 0;
    for (const [id, rank] of entries) {
      if (granted.has(id)) continue;
      spent += rank;
      for (let r = 1; r <= rank; r++) if (readableValue(id, r).readable) readable++;
    }
    return {
      spent, readable, blind: spent - readable,
      granted: [...granted],
      nodes: entries.length,
      total: tree.nodes.length,
      totalPoints: tree.nodes.reduce((s, n) => s + maxPointsOf(n.skill), 0),
      totalReadable: tree.nodes.filter((n) => readableValue(n.skill, 1).readable).length,
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
