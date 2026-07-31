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

  // Tier N opens when the points ALREADY SPENT AT LOWER TIERS reach
  // `thresholds[N]`, counting the root plus that branch. Confirmed in game:
  //
  //   tier 0  available from the start
  //   tier 1  every branch, once tier 0 holds 1 point
  //   tier 2  that branch, once tier 1 and below hold 2 cumulative
  //   tier 3  that branch, once tier 2 and below hold 4 cumulative
  //   tier 4  that branch, once tier 3 and below hold 8 cumulative
  //
  // So the array is indexed BY TIER - [0,1,2,4,8] read straight - and all five
  // entries are used. An earlier reading here shifted it by one on the grounds
  // that 8 points could not fit in a seven-node branch; that was wrong twice
  // over, because 48 of the 88 nodes hold two points, so a branch holds eleven.
  //
  // The ROOT counts toward every branch. It has to: a tier-1 node is worth one
  // point and every branch has exactly one, so tier 2 could never reach its
  // threshold of 2 from same-branch points alone. Tier 1 needing "tier 0 to
  // hold 1 point" says the same thing from the other side.
  //
  // Checked against two real allocations that both open tier 4:
  //   1 - 1 - 2 - 4  (root, tier1, tier2, tier3) = 8
  //   1 - 1 - 3 - 3                              = 8
  const tierThreshold = (tier) => (tier <= 0 ? 0 : (thresholds[tier] ?? 0));
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
  /**
   * `have` is the rest of the allocation, and it is not optional decoration:
   * four nodes across three trees do nothing at all unless another node is
   * taken. `Warrior_Talent_HoldTheLine` reads "while ::ref2_name:: is active"
   * and its script fires on `s.kind == Warrior_Talent_RageShield_Status`, so a
   * build without Rage Shield gets nothing - and without this it was scored
   * +6% damage and -6% damage taken regardless.
   */
  function readableValue(skillId, rank = 1, { have = null } = {}) {
    const key = skillId + '@' + rank + (have?.size ? '%' + [...have].sort().join('+') : '');
    let v = valueCache.get(key);
    if (v) return v;
    const s = skills.get(skillId);
    const prof = combat.profile(skillId, 3);
    const inRank = (c) => !(c?.minRank != null && rank < c.minRank)
      && !(c?.maxRank != null && rank > c.maxRank)
      && !(c?.equalRank != null && rank !== c.equalRank);
    const affixes = (s?.affixes ?? []).filter((a) => a.target?.attribute && inRank(a.conds));
    // At the node's OWN rank, not at 1. A talent that holds two points states
    // its second rank in a `minRank: 2` affix row on the status it grants, and
    // resolving that status at rank 1 made the second point buy nothing.
    const statuses = plan.statusesOf(skillId, { rank, talents: have });
    const buffs = statuses.self;
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
    // A pool dot is readable now: `Warrior_Hemorrhage` declares `vars.damage`
    // 0.35 and hands it to `addStatus` as a share of the crit that applied it.
    // It shows up as neither an affix nor a buff nor an effect of its own, so
    // without this the tree still reported the node the whole Warrior tree is
    // built around as "nothing readable".
    const dots = statuses.dots.filter((d) => d.pool);
    // Scoped damage modifiers, which are not affixes and not effects - "+20%
    // critical damage on weapon skills" is neither - so without this the tree
    // still printed "nothing readable" beside a node the fight was scoring.
    const mods = plan.talentModifiers(skillId, rank);
    // ...and resource income, which is a value like any other: Seasoned
    // Soldier's Rage per physical critical strike is what pays for a Raging
    // Smash, and the tree printed "nothing readable" beside it.
    const gains = plan.resourceGainsOf(skillId, { rank });
    const FIELD = {
      dmgMult: 'damage', critDmgMult: 'crit damage', critChance: 'crit chance',
      armorIgnore: 'armour ignored', magicArmorIgnore: 'magic armour ignored',
      healShare: 'of it healed back',
    };
    const SCOPE = { attack: 'on attacks', weaponSkill: 'on weapon skills', magic: 'on magic', bleed: 'on bleeds', all: '' };
    const modLabel = mods.length
      ? [...new Set(mods.map((m) => `${m.amount > 0 ? '+' : ''}${Math.round(m.amount * 100)}% `
        + `${FIELD[m.field] ?? m.field} ${SCOPE[m.scope] ?? m.scope}`.trim()
        + (m.targetBleeding ? ' vs bleeding' : '')))].join(', ')
      : '';
    // What this node WOULD have given if another one were taken. Kept out of
    // `readable` - it is worth nothing in this build - but carried so the
    // output can say why rather than printing a blank beside a node whose text
    // plainly promises something.
    const needs = statuses.unmetDeps ?? [];
    v = {
      affixes, buffs, effects, granted, dots, mods, gains, needs,
      readable: affixes.length > 0 || buffs.length > 0 || effects.length > 0
        || dots.length > 0 || mods.length > 0 || gains.length > 0,
      kind: affixes.length ? 'affix' : buffs.length ? 'status'
        : dots.length ? `${Math.round(dots[0].pool.fraction * 100)}% of `
          + `${dots[0].pool.magic ? 'magic' : 'physical'} crits as a bleed`
          : modLabel || (gains.length ? gains.map((g) => `+${g.amount} ${g.atb}${g.critGated ? ' per crit' : ''}`).join(', ') : '')
            || (granted.length && effects.length ? 'grants a skill' : effects.length ? 'effect' : '')
            || (needs.length ? `nothing without ${needs[0].needsName}` : 'none'),
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
    // The root's points count toward every branch, so they are tracked apart
    // and added in rather than living in one branch's tally.
    const perBranch = new Map();
    let rootPoints = 0;
    const cumulative = (b) => (perBranch.get(b) ?? 0) + rootPoints;
    const inOrder = entries
      .map(([id, rank]) => ({ n: tree.byId.get(id), rank, granted: granted.has(id) }))
      .sort((a, b) => a.n.tier - b.n.tier);
    for (const { n, rank, granted: free } of inOrder) {
      const have = cumulative(n.branchIndex);
      const need = tierThreshold(n.tier);
      if (n.tier > 0 && have < need) {
        return `${n.name} is tier ${n.tier} and needs ${need} points at lower tiers in ${n.branch}, `
          + `but only ${have} are there`;
      }
      if (free) continue;
      if (n.tier === 0) rootPoints += rank;
      else perBranch.set(n.branchIndex, (perBranch.get(n.branchIndex) ?? 0) + rank);
    }
    return null;
  }
  /**
   * A greedy legal allocation over the nodes this model can score. Walks tiers
   * in order so thresholds are satisfiable, and stops when it runs out of
   * points OR out of readable nodes - it does NOT spend the remainder on nodes
   * it cannot value, because that would be inventing a recommendation.
   */
  function suggest(unitId, { level, points = null, granted = new Set(), value = null } = {}) {
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
    // `value(nodeId, rank, ranksSoFar)` lets a caller rank a point by the real
    // objective instead of by the size of the numbers on it. The magnitude
    // heuristic cannot tell +6 CooldownReduction from +6 MagicMastery, and for
    // a dps build those are worth very different things. It stays as the
    // tiebreak, because the objective is flat across every node the model
    // cannot read and something has to order those.
    const heuristicWeight = (id, atRank) => magnitude(readableValue(id, atRank))
      - (atRank > 1 ? magnitude(readableValue(id, atRank - 1)) : 0);
    const pointWeight = (id, atRank, ranks) => {
      const heuristic = heuristicWeight(id, atRank);
      if (!value) return { score: heuristic, heuristic };
      return { score: value(id, atRank, ranks), heuristic };
    };

    // An allocation is a rank per node, not a set of nodes. `perBranch` counts
    // POINTS, which is what the thresholds are denominated in.
    const ranks = new Map();
    for (const id of granted) ranks.set(id, 1);
    const blind = [];

    // The root's point counts toward every branch's threshold, so it is held
    // separately and added in by `cumulative`.
    let rootPoints = 0;
    const cumulative = (b) => (perBranch.get(b) ?? 0) + rootPoints;
    const addPoint = (n, atRank) => {
      ranks.set(n.skill, atRank);
      if (atRank === 1 && !readableValue(n.skill, 1).readable) blind.push(n.skill);
      if (n.tier === 0) rootPoints += 1;
      else perBranch.set(n.branchIndex, (perBranch.get(n.branchIndex) ?? 0) + 1);
      spent++;
    };

    // The root costs a point and is the way in - confirmed in game.
    const rootNode = tree.nodes.find((n) => n.tier === 0);
    if (rootNode && !ranks.has(rootNode.skill) && spent < budget) addPoint(rootNode, 1);

    // Readable value still unclaimed in a branch: what a gate point is buying.
    // Always the heuristic, never the objective - `promise` has to compare
    // branches by what is LEFT in them, and evaluating a build for every
    // unbought point in every branch on every iteration is not worth it. It
    // calls `heuristicWeight` directly rather than `pointWeight`, because
    // going through the latter would run the objective hook and throw the
    // answer away - about six full evaluations per point, for nothing.
    const promise = (branchIndex) => tree.nodes
      .filter((n) => n.branchIndex === branchIndex)
      .reduce((sum, n) => {
        const at = ranks.get(n.skill) ?? 0;
        let rest = 0;
        for (let r = at + 1; r <= maxPointsOf(n.skill); r++) {
          rest += Math.max(0, heuristicWeight(n.skill, r));
        }
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
        if (at === 0 && cumulative(n.branchIndex) < tierThreshold(n.tier)) continue;
        const w = pointWeight(n.skill, at + 1, ranks);
        legal.push({ n, next: at + 1, w: w.score, h: w.heuristic });
      }
      if (!legal.length) break;

      legal.sort((a, b) => {
        const d = b.w - a.w;
        if (Math.abs(d) > 1e-9) return d;
        const h = b.h - a.h;
        if (Math.abs(h) > 1e-9) return h;
        const p = promise(b.n.branchIndex) - promise(a.n.branchIndex);
        if (Math.abs(p) > 1e-9) return p;
        if (a.n.tier !== b.n.tier) return a.n.tier - b.n.tier;
        return a.n.skill < b.n.skill ? -1 : 1;
      });

      const best = legal[0];
      // Nothing readable is reachable and nothing is locked behind what is
      // left: stop rather than spend the tail at random.
      if (best.w <= 0 && best.h <= 0 && promise(best.n.branchIndex) <= 0) break;
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
  // it modifies its skill in FOUR readable ways, not the two an earlier reading
  // of this file counted:
  //
  //   * `steps[].cond.mastery` names a rune; that step exists only when the
  //     rune is slotted.
  //   * `steps[].cond.masteryExclude` is the mirror image: the step exists only
  //     while that rune is NOT slotted.
  //   * `mastery[].props` overrides the skill's own props - `charges` and
  //     `cooldown`, both of which change throughput directly.
  //   * `affixes[].conds.mastery` gates a stat affix. Five runes are readable
  //     ONLY this way, and every one of them sits on a `*_Status` row rather
  //     than on the skill that owns the rune, which is why counting per skill
  //     missed them.
  //
  // The gates are not local either: three of the 19 gated steps live on a
  // `*_Status` skill while the rune that gates them is declared on the ability
  // that applies the status. So every count here is taken over the WHOLE sheet
  // and keyed by mastery id, never by "the skill this rune belongs to".
  //
  // Everything else a rune does lives in its description and in game code.

  // masteryId -> what the data says it changes, computed once over every row.
  const runeIndex = (() => {
    const idx = new Map();
    const touch = (id) => {
      let e = idx.get(id);
      if (!e) { e = { gatedSteps: 0, gatedStepsWithEffects: 0, excludedSteps: 0, gatedAffixes: 0, overrides: [] }; idx.set(id, e); }
      return e;
    };
    const owner = new Map();
    for (const s of cdb.lines('skill')) {
      for (const m of s.mastery ?? []) {
        owner.set(m.id, s.id);
        const e = touch(m.id);
        e.overrides = Object.keys(m.props ?? {});
      }
    }
    for (const s of cdb.lines('skill')) {
      for (const st of s.steps ?? []) {
        if (st.cond?.mastery) {
          const e = touch(st.cond.mastery);
          e.gatedSteps++;
          if ((st.effects ?? []).length) e.gatedStepsWithEffects++;
        }
        if (st.cond?.masteryExclude) touch(st.cond.masteryExclude).excludedSteps++;
      }
      for (const a of s.affixes ?? []) {
        if (a.conds?.mastery && a.target?.attribute) touch(a.conds.mastery).gatedAffixes++;
      }
    }
    for (const [id, e] of idx) {
      e.owner = owner.get(id) ?? null;
      e.readable = e.gatedSteps > 0 || e.excludedSteps > 0 || e.gatedAffixes > 0 || e.overrides.length > 0;
    }
    return idx;
  })();

  const EMPTY_RUNE = { gatedSteps: 0, gatedStepsWithEffects: 0, excludedSteps: 0, gatedAffixes: 0, overrides: [], readable: false };
  const runeFacts = (masteryId) => runeIndex.get(masteryId) ?? EMPTY_RUNE;

  /**
   * Does the model read anything out of the SCRIPT for this rune?
   *
   * `runeFacts` only counts the data paths - a gated step, a gated affix, a
   * prop override - and that was the whole story until the script readers
   * landed. Now `Scent of Battle` changes a cost, `Juggernaut` grants Rage and
   * `Concentrated Impact` adds 40% damage, and the column still printed
   * "nothing this model can read" beside all three. Asked the honest way: price
   * the skill with the rune and without it, and see whether anything moved.
   */
  function scriptReads(skillId, runeId) {
    const off = combat.profile(skillId, 3, new Set());
    const on = combat.profile(skillId, 3, new Set([runeId]));
    const what = [];
    const cost = (p) => (p?.costs ?? []).map((c) => c.atb + c.amount).join(',');
    if (cost(off) !== cost(on)) what.push('changes its cost');
    if ((on?.runeDamage ?? []).length > (off?.runeDamage ?? []).length) {
      const d = on.runeDamage[on.runeDamage.length - 1];
      what.push(`+${Math.round(d.amount * 100)}% damage${d.singleTarget ? ' at one target' : ''}`);
    }
    const gains = plan.resourceGainsOf(skillId, { rank: 3, runes: new Set([runeId]) });
    const base = plan.resourceGainsOf(skillId, { rank: 3, runes: new Set() });
    if (gains.length > base.length) {
      const g = gains[gains.length - 1];
      what.push(`+${g.amount} ${g.atb}`);
    }
    return what;
  }

  function runesFor(skillId) {
    return (skills.get(skillId)?.mastery ?? []).map((m) => {
      const f = runeFacts(m.id);
      const scripted = scriptReads(skillId, m.id);
      return {
        scripted,
        id: m.id,
        name: m.text?.name ?? m.id,
        desc: m.text?.desc ?? '',
        props: m.props ?? {},
        vars: m.vars ?? {},
        // What the model can actually read out of it.
        gatesSteps: { steps: f.gatedSteps, withEffects: f.gatedStepsWithEffects, excluded: f.excludedSteps },
        gatesAffixes: f.gatedAffixes,
        overrides: f.overrides,
        readable: f.readable || scripted.length > 0,
      };
    });
  }

  // Kept for callers that want the per-skill figure; the whole-sheet one is
  // `runeFacts`, and that is what every count uses.
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

  /**
   * The live rune census. Hardcoding these numbers is how the output came to
   * claim "17 of 84" when the data said 26 - so nothing here is a literal.
   */
  function runeCoverage() {
    let skillsWithRunes = 0, total = 0;
    const gates = new Set(), excludes = new Set(), overrides = new Set(), affixes = new Set();
    for (const s of cdb.lines('skill')) {
      const ms = s.mastery ?? [];
      if (!ms.length) continue;
      skillsWithRunes++;
      for (const m of ms) {
        total++;
        const f = runeFacts(m.id);
        if (f.gatedSteps) gates.add(m.id);
        if (f.excludedSteps) excludes.add(m.id);
        if (f.overrides.length) overrides.add(m.id);
        if (f.gatedAffixes) affixes.add(m.id);
      }
    }
    const readable = new Set([...gates, ...excludes, ...overrides, ...affixes]);
    return {
      skillsWithRunes, total,
      gatesSteps: gates.size,
      excludesSteps: excludes.size,
      overridesProps: overrides.size,
      gatesAffixes: affixes.size,
      readable: readable.size,
      overrideKeys: [...new Set([...runeIndex.values()].flatMap((e) => e.overrides))].sort(),
    };
  }

  /**
   * Every skill this build can press that offers a rune choice.
   *
   * This deliberately does NOT read the resolved rotation. A skill only reaches
   * the rotation once its profile already carries a Damage/Heal/Shield effect,
   * and a rune-gated step is exactly what can ADD that effect - so asking the
   * rotation which runes to offer meant a rune that would make a skill worth
   * pressing could never be found. The pool comes from what is EQUIPPED and
   * SLOTTED instead, which is what the player is actually choosing between.
   */
  function runePools(loadoutOrRotation) {
    const ids = loadoutOrRotation?.gear
      ? runableSkillIds(loadoutOrRotation)
      : [...(loadoutOrRotation?.active ?? []), ...(loadoutOrRotation?.triggered ?? []),
        ...(loadoutOrRotation?.filler ?? []), ...(loadoutOrRotation?.passive ?? [])].map((e) => e.prof.id);
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const runes = runesFor(id);
      if (runes.length < 2) continue;
      out.push({
        key: `rune/${id}`, skill: id,
        name: skills.get(id)?.texts?.name ?? id,
        options: runes, slots: 1,
      });
    }
    return out;
  }

  /**
   * Every skill id a loadout grants, before the rotation decides which of them
   * it can put a cast rate on. Runes attach to skills you KNOW, not to skills
   * the model happens to be able to score.
   */
  function runableSkillIds(loadout) {
    const out = [];
    const push = (id) => { if (id) out.push(id); };

    // A class skill has an unlock level and the data states it. Offering runes
    // on a skill the character has not learned let the search slot and score
    // one - `Mage_ChronoReset` unlocks at 20, `Rogue_Darkness` at 24 - which is
    // advice for a character that does not exist yet.
    const unit = cdb.byId('unit').get(loadout.class);
    for (const s of unit?.skills ?? []) {
      if ((s.level ?? 0) > loadout.level) continue;
      push(s.skill ?? s.ref);
    }

    for (const slot of cat.combatSlots()) {
      const g = loadout.gear[slot.id];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      if (!item) continue;
      // The arsenal hands you only what you slotted; every other slot hands you
      // everything it carries.
      const chosen = loadout.skills?.[slot.id];
      const from = slot.id === 'Slot_Weapon2' && chosen?.length ? chosen : item.skills;
      for (const id of from ?? []) push(id);
      for (const s of cat.inherited(item.type, (t) => t?.skills) ?? []) push(s.skill ?? s.ref);
      for (const type of cat.socketsFor(item)) {
        const augId = loadout.augments?.[`${slot.id}/${type}`];
        for (const id of (augId ? cat.itemById.get(augId)?.skills : null) ?? []) push(id);
      }
    }
    for (const list of Object.values(loadout.skills ?? {})) for (const id of list) push(id);
    // A talent can grant a skill, and a granted skill can carry runes.
    for (const id of Object.keys(loadout.talents ?? {})) {
      push(id);
      for (const g of readableValue(id, loadout.talents[id]).granted) push(g);
    }
    return out;
  }

  return {
    /** The scoped damage modifiers a node confers at the rank it holds. */
    modifiersOf: (id, rank) => plan.talentModifiers(id, rank),
    treeFor, readableValue, illegalAllocation, suggest, coverage, pointsAt,
    runesFor, runePools, gatedSteps, runeFacts, runeCoverage, runableSkillIds,
    thresholds, unlockLevel, branchNames,
    defaultPointsAtCap: DEFAULT_POINTS_AT_CAP,
  };
}
