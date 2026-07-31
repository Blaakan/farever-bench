// ---------------------------------------------------------------------------
// engine.mjs - one object that loads everything and scores a loadout.
//
// The optimiser calls `score()` tens of thousands of times, so the expensive
// work (parsing the CastleDB, building the attribute table, flattening skill
// profiles) happens once here and the per-call path allocates only the three
// modifier maps and the sheet.
//
// A scalar score is what a search needs, but a single number is also how a
// tool starts lying, so `evaluate()` returns every component and the CLI
// prints them next to the winner.
// ---------------------------------------------------------------------------

import { loadCdb } from './cdb.mjs';
import { buildContext, baseStats, auditModel } from './model.mjs';
import { buildCatalog } from './catalog.mjs';
import { buildCombat } from './damage.mjs';
import { buildSkillPlan } from './skills.mjs';
import { buildTalentPlan } from './talents.mjs';
import { buildProfiles } from './profiles.mjs';
import { evaluate as evaluateLoadout, classOf, socketsOf } from './loadout.mjs';

export const GOALS = ['dps', 'hps', 'sps', 'ehp', 'mixed'];
export const FERVOR_SCOPES = ['skills', 'all', 'none'];

export const DEFAULT_ASSUME = {
  // Fervor's description says "your Skills", so base attacks are excluded by
  // default. Which reading is right decides whether Fervor gear or penetration
  // gear wins, and neither is verified - see docs/MODEL.md.
  fervorScope: 'skills',
  mastery: true,
};

export function createEngine({ game, assume = {}, fight = {}, quiet = false, classSkillSlots } = {}) {
  const cdb = loadCdb({ game, quiet });
  const ctx = buildContext(cdb);
  const cat = buildCatalog(cdb, ctx);
  const combat = buildCombat(cdb, ctx);
  const plan = buildSkillPlan(cdb, ctx, cat, combat,
    classSkillSlots != null ? { classSkillSlots } : {});
  const talents = buildTalentPlan(cdb, ctx, cat, combat, plan);
  const profiles = buildProfiles(cdb, ctx, cat);
  const opts = {
    assume: { ...DEFAULT_ASSUME, ...assume },
    // The fight the numbers are computed over. 200 seconds because that is the
    // length a damage meter typically reports, and because a fight length is
    // what makes a banked charge worth anything.
    fight: fight.seconds ?? 200,
    fights: fight.count ?? 1,
    targets: fight.targets ?? 1,
    // How far ahead the rotation looks before choosing a cast. 0 is a plain
    // first-available priority list, which is what SimulationCraft does with an
    // authored APL; anything above 0 lets a setup cast win on what it makes the
    // NEXT few seconds worth.
    lookahead: fight.lookahead ?? 0,
    seed: fight.seed ?? 0x9e3779b9,
  };
  if (!FERVOR_SCOPES.includes(opts.assume.fervorScope)) {
    throw new Error(`fervorScope must be one of ${FERVOR_SCOPES.join(', ')}`);
  }

  const baseCache = new Map();
  const baseStatsFor = (unit, level) => {
    const k = unit + '@' + level;
    let b = baseCache.get(k);
    if (!b) { b = baseStats(cdb, ctx, unit, level); baseCache.set(k, b); }
    return b;
  };

  // The rotation depends on the gear AND on which skills are slotted, so the
  // cache key has to carry both. It is worth caching: the search re-evaluates
  // the same weapon plus skill choice thousands of times.
  const rotationCache = new Map();
  function rotationFor(loadout, rank) {
    // CLASS AND LEVEL FIRST. The key used to be built from gear, skills,
    // augments, runes and talents alone - all of which are empty on a naked
    // character - so evaluating a naked Rogue and then a naked Warrior through
    // one engine handed the Warrior the ROGUE's rotation, complete with
    // Rogue_Sig_Finisher. The class also decides which unit skills exist and
    // the level decides which of them are unlocked, so both belong in the key.
    const key = loadout.class + '@' + loadout.level + '|' + rank
      + '|' + (loadout.gear.Slot_Weapon1?.item ?? '-')
      + '|' + (loadout.gear.Slot_Weapon2?.item ?? '-')
      + '|' + Object.entries(loadout.skills ?? {}).sort().map(([k, v]) => k + ':' + v.join('+')).join(';')
      + '|' + cat.combatSlots().map((s) => loadout.gear[s.id]?.item ?? '').join(',')
      + '|' + Object.entries(loadout.augments ?? {}).filter(([, v]) => v).sort().join(',')
      + '|' + Object.values(loadout.runes ?? {}).flat().filter(Boolean).sort().join(',')
      + '|' + Object.entries(loadout.talents ?? {}).sort().map(([k, v]) => k + ':' + v).join(',');
    let r = rotationCache.get(key);
    if (!r) { r = plan.resolve(loadout, rank); rotationCache.set(key, r); }
    return r;
  }

  /** Full evaluation: stat sheet, throughput, survivability, rotation lines. */
  function evaluate(loadout, { target, rank = 1, mix = 0.5 } = {}) {
    const cls = classOf(cat, loadout);
    const tgt = target ?? combat.foe('reference', loadout.level);
    const weaponPower = combat.weaponPowerFor(cat, loadout, cls);
    const rot = rotationFor(loadout, rank);

    // Stats that come from what you know rather than from what you wear:
    //
    //   * a passive ability's own affixes - the weapon-class block skills at
    //     +50/+60 BlockMitigation;
    //   * self-buff statuses a skill applies, at full stacks - the weapon
    //     enchants, where Zealot is +6 CritChanceRating x 5 stacks. That is the
    //     entire value of an enchant slot, and without it the search correctly
    //     concluded that no enchant was worth having.
    const inject = new Map([['WeaponPower', weaponPower]]);
    const addRatio = new Map();
    const mulRatio = new Map();
    const addFlat = (atb, v) => inject.set(atb, (inject.get(atb) ?? 0) + v);

    // A named stat profile stands IN PLACE OF the armour, so a rotation can be
    // searched against a fixed corner of the stat space instead of against
    // whatever the gear search happened to converge on. The weapon stays real:
    // it is what grants the skills and sets WeaponPower, and it is the thing
    // being compared. See profiles.mjs for where the numbers come from.
    const profile = loadout.profile
      ? profiles.resolve(loadout.profile, loadout.class, loadout.level, loadout.profileScale ?? 1) : null;
    if (profile) for (const [atb, v] of profile.inject) addFlat(atb, v);

    for (const p of rot.passive ?? []) {
      for (const a of p.affixes ?? []) {
        if (a.ref === 'TAttribute_Flat') addFlat(a.target.attribute, a.val ?? 0);
      }
    }

    // The effect a weapon's upgrade stars unlock. The game's own window says
    // upgrading a weapon gives "access to a unique effect", and each weapon
    // type has a `<Type>_Upgrade` skill whose affix rows are gated by the
    // upgrade level - `Scepter_Upgrade` is +4 SpellPenetration at one star
    // rising to +8 at five, `Staff_Upgrade` +2..+6 CooldownReduction. Eight of
    // the twenty carry readable affixes; the other twelve are procs whose
    // payload lives in a script, and those are named in the audit.
    //
    // The rows are MUTUALLY EXCLUSIVE per star, the same shape as every other
    // rank-gated affix in this database, so they are filtered and never summed.
    //
    // Only the weapons you actually wield: the arsenal grants two chosen skills
    // and its discounted stats, and the upgrade effect is neither.
    const upgradeGaps = [];
    for (const slotId of ['Slot_Weapon1', 'Slot_OffhandWeapon']) {
      const g = loadout.gear[slotId];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      const upgradeId = cat.upgradeSkillFor(item);
      if (!upgradeId) continue;
      const stars = Math.min(g.stars ?? 0, cat.maxStars(item, g.rarity));
      if (stars < 1) continue;
      const up = cdb.byId('skill').get(upgradeId);
      const rows = (up?.affixes ?? []).filter((a) => a.target?.attribute
        && !(a.conds?.minRank != null && stars < a.conds.minRank)
        && !(a.conds?.maxRank != null && stars > a.conds.maxRank)
        && !(a.conds?.equalRank != null && stars !== a.conds.equalRank));
      if (!rows.length) {
        upgradeGaps.push({ id: upgradeId, slot: slotId, stars });
        continue;
      }
      for (const a of rows) {
        if (a.ref === 'TAttribute_Flat') addFlat(a.target.attribute, a.val ?? 0);
      }
    }
    // Talents you have allocated. Only 22 of the 88 nodes declare anything a
    // model can read; the rest are structurally present and numerically
    // invisible, which `bench talents` reports rather than hides.
    // Talents use all three affix models, not just the flat one.
    // Priest_Talent_CrusadersResolve is TAttribute_ARatio +0.08 Armor - a
    // RATIO, +8% armour - and reading it as a flat +0.08 threw away its entire
    // value while printing a number that looks like a rounding error.
    //
    // The three affix models are NOT interchangeable, and the multiplicative
    // one is the trap. `TAttribute_MRatio` REPLACES the multiplier - a status
    // carrying `DamageTakenModifier` MRatio 0.6 means "you take 60% of what you
    // would have", i.e. a 40% reduction. Reading it as `* (1 + 0.6)` turned
    // `Warrior_IgnorePainStatus` from -40% damage taken into +60% damage taken,
    // and `GM_MassGrab_Skill2_Status`'s DamageModifier MRatio 1.5 into +150%.
    // `uptime` therefore has to be blended between the multiplier and 1, not
    // multiplied into the value: a buff that is up half the time gives
    // `0.5*val + 0.5*1`, never `val/2`.
    const applyAffix = (a, scale = 1, uptime = 1) => {
      const atb = a.target?.attribute;
      const kind = ctx.affix.kindOf(a.ref);
      if (!atb || !kind) return;
      if (kind === 'flat') addFlat(atb, (a.val ?? 0) * scale * uptime);
      else if (kind === 'addRatio') addRatio.set(atb, (addRatio.get(atb) ?? 0) + (a.val ?? 0) * scale * uptime);
      else {
        // A multiplier that is only up part of the time averages toward 1, and
        // `uptime * val + (1 - uptime)` is that average - never `val / 2`,
        // which would turn a half-uptime -40% into a -70%. Composition with
        // whatever is already there is the `affix` sheet's business.
        const m = uptime * (a.val ?? 0) + (1 - uptime);
        mulRatio.set(atb, ctx.affix.composeMul(a.ref, mulRatio.get(atb) ?? 1, m));
      }
    };
    // Talents. A talent has no cooldown of its own, so a status it grants is
    // permanent unless the status says otherwise - and where the status DOES
    // declare a short duration with no applier cooldown to divide it by, the
    // uptime is not in the data and counting it whole would make an emergency
    // button a passive. Those are refused and named.
    const talentBuffGaps = [];
    // The rest of the allocation, because a node can depend on one: Hold the
    // Line is worth nothing without Rage Shield, and reading it in isolation
    // handed a build 22 dps for a talent it had not enabled.
    const allocated = new Set(Object.keys(loadout.talents ?? {}));
    const talentDepGaps = [];
    for (const [id, rank] of Object.entries(loadout.talents ?? {})) {
      const v = talents.readableValue(id, rank, { have: allocated });
      for (const n of v.needs ?? []) talentDepGaps.push({ ...n, from: id });
      for (const a of v.affixes) applyAffix(a);
      for (const b of v.buffs) {
        const src = combat.profile(b.from, rank, new Set(rot.runes ?? []));
        const timed = b.duration > 0 && !(src?.cooldown > 0);
        if (timed) {
          talentBuffGaps.push({ id: b.status, from: id, duration: b.duration });
          continue;
        }
        for (const a of b.affixes) applyAffix(a, b.stacks);
      }
    }

    // Scoped damage modifiers the allocated talents confer. These are not stats
    // - "+20% critical damage on weapon skills" cannot be written on a sheet -
    // so they travel to the fight separately and are applied where their scope
    // says. `targetBleeding` ones are credited whole: the model only reaches
    // them when a pool dot is running, and a bleed re-applied off every crit is
    // up essentially all of the time. That is an assumption and it is in the
    // audit.
    //
    // THIS RUNS BEFORE THE SHEET IS BUILT, and it has to. One of these routes
    // its value onto the sheet rather than into the fight - `Red Tempo` earns
    // cooldown back per bleed tick, which is a rate and therefore a
    // CooldownReduction - and this pass used to sit after both
    // `evaluateLoadout` calls, so that `addFlat` wrote into a map nothing read
    // again. The talent was scored, printed with a value, and worth exactly
    // zero: two points in it moved the Warrior's dps by 0.00.
    const mods = {
      critDamageByType: {}, critChanceByType: {}, damageByAffinity: {},
      armorIgnore: {}, bleed: {}, cooldown: {},
    };
    // Modifiers whose scope this fight does not separate. Named, not dropped.
    const unreadMods = [];
    for (const [id, nodeRank] of Object.entries(loadout.talents ?? {})) {
      for (const mod of talents.modifiersOf(id, nodeRank)) {
        const add = (bag, key) => { bag[key] = (bag[key] ?? 0) + mod.amount; };
        // Routing is EXPLICIT, with no default. A scope this does not recognise
        // is dropped, not folded into "everything": `Rogue_Talent_LethalDose`
        // scopes its +20% to Poison damage, and the model has no poison pool to
        // put it on, so it must contribute nothing rather than +20% globally.
        const type = mod.scope === 'attack' ? 'Attack'
          : mod.scope === 'weaponSkill' ? 'WeaponSkill' : null;
        if (mod.field === 'healShare' && mod.scope === 'bleed') add(mods.bleed, 'healShare');
        else if (mod.scope === 'bleed' && mod.field !== 'cooldownPerTick') add(mods.bleed, mod.field);
        else if (mod.field === 'critDmgMult' && type) add(mods.critDamageByType, type);
        else if (mod.field === 'critChance' && type) add(mods.critChanceByType, type);
        else if (mod.field === 'dmgMult' && mod.scope === 'physical') add(mods.damageByAffinity, 'Physical');
        else if (mod.field === 'dmgMult' && mod.scope === 'magic') add(mods.damageByAffinity, 'Magic');
        else if (mod.field === 'dmgMult' && type) add(mods.damageByAffinity, type);
        else if (mod.field === 'dmgMult' && mod.scope === 'all') add(mods.damageByAffinity, 'all');
        // Cooldown reduction earned per bleed tick. The bleed's own tick
        // interval turns "a 12% chance for one second" into a rate: at one tick
        // every two seconds that is 0.06 seconds of cooldown back per second.
        // A flat second off a cooldown of length C, arriving at a steady r
        // seconds per second, finishes that cooldown in C/(1+r) - which is
        // exactly what a CooldownReduction of 100r does, so the rate converts.
        //
        // WHICH cooldowns is in the call, not in the description alone:
        // `reduceWeaponsCooldown` is the weapon-skill-only form, and Red Tempo's
        // own text says "the cooldown of all your [WeaponSkill]s". Putting it on
        // the sheet's global CooldownReduction would have sped up Charge,
        // Berserk and Surging Force as well, so it is carried as a scoped bonus
        // and the fight applies it only to the skills it names.
        //
        // It is credited only while a bleed is actually running. A build with
        // no pool dot earns nothing from it, which is correct and is why this
        // reads the resolved rotation rather than the talent alone.
        else if (mod.field === 'cooldownPerTick' && mod.scope === 'bleed') {
          const tickInterval = (rot.dots ?? []).find((d) => d.pool)?.tick ?? 0;
          if (tickInterval > 0) add(mods.cooldown, 'weaponSkill');
          else unreadMods.push(mod);
        } else if (mod.field === 'armorIgnore') add(mods.armorIgnore, 'Physical');
        else if (mod.field === 'magicArmorIgnore') add(mods.armorIgnore, 'Magic');
        else unreadMods.push(mod);
      }
    }
    // The bleed's tick interval is what turns seconds-per-proc into a rate, and
    // it is only known once the rotation is resolved.
    if (mods.cooldown.weaponSkill) {
      const tickInterval = (rot.dots ?? []).find((d) => d.pool)?.tick ?? 0;
      mods.cooldown.weaponSkill /= tickInterval;
    }

    // Self-buffs, at the uptime the fight actually supports rather than at a
    // flat 100%. `Priest_BlessingOfFervor` is fifteen seconds of +10 Fervor on
    // a hundred-and-twenty-second cooldown: counting it whole credits a build
    // with a button it presses once every two minutes as if it were always on.
    // A buff with no cooldown behind it - the weapon enchants, which refresh
    // off a proc every few swings - keeps its full uptime, which is the case
    // the old blanket assumption was actually written for.
    // Self-buffs split in two, and the split is the whole point of a stateful
    // fight. A buff with no cooldown behind it - a weapon enchant refreshed off
    // a proc every few swings - is effectively always on and belongs in the
    // sheet. A buff on a cooldown is a WINDOW: it lands, it changes what the
    // next few casts are worth, and it expires. Averaging that into the sheet
    // at duration/cooldown is the right number for a stat block and the wrong
    // model for a rotation, because it makes bursting inside the window worth
    // exactly the same as bursting outside it.
    //
    // So the permanent ones go into the sheet, and the timed ones are handed to
    // the fight, which applies them when they are cast and prices what follows
    // against them. The printed sheet still shows the timed ones at their
    // uptime, because that IS what a character averages - but the fight does
    // not read that sheet.
    const buffs = plan.selfBuffs(rot);
    const timed = [];
    for (const b of buffs) {
      const src = combat.profile(b.from, rank, new Set(rot.runes ?? []));
      const cd = src?.cooldown ?? 0;
      const dur = b.duration;
      b.uptime = (cd > 0 && dur > 0) ? Math.min(1, dur / Math.max(cd, src.occupancy)) : 1;
      b.timed = cd > 0 && dur > 0;
      if (b.timed) timed.push(b);
      else for (const a of b.affixes) applyAffix(a, b.stacks, 1);
    }

    // The sheet the FIGHT starts from: everything permanent, nothing timed.
    const combatBase = evaluateLoadout(cat, loadout, {
      baseStatsFor, injectFlat: inject, injectAddRatio: addRatio, injectMulRatio: mulRatio,
    });

    // ...and the sheet averaged over the fight, with the timed buffs folded in
    // at their uptime. That is a useful number and it is NOT the character
    // sheet: a level-25 Warrior with no gear reads 5.8% crit in game, and this
    // one read 8.3% because Battle Shout's +20 CritChance on a 120-second
    // cooldown was averaged in at 12.5% uptime. Anyone comparing the tool to
    // their own character sheet was comparing against a different question.
    //
    // So both are computed and both are reported: `sheet` is what the game
    // shows you standing still, `averaged` is what the fight sees.
    const resting = combatBase;
    for (const b of timed) for (const a of b.affixes) applyAffix(a, b.stacks, b.uptime);
    const averaged = evaluateLoadout(cat, loadout, {
      baseStatsFor, injectFlat: inject, injectAddRatio: addRatio, injectMulRatio: mulRatio,
    });
    const r = { ...resting, averaged: averaged.sheet };

    /**
     * The sheet with a given set of statuses live on top of the combat base.
     * Memoised on the status set, because a fight cycles through a handful of
     * distinct combinations thousands of times.
     */
    const restatCache = new Map();
    function restat(active) {
      if (!active.length) return combatBase.sheet;
      const key = active.map((b) => b.status + '#' + (b.stacks ?? 1)).sort().join('|');
      let hit = restatCache.get(key);
      if (hit) return hit;
      const f2 = new Map(inject), a2 = new Map(addRatio), m2 = new Map(mulRatio);
      const put = (a, scale) => {
        const atb = a.target?.attribute;
        const kind = ctx.affix.kindOf(a.ref);
        if (!atb || !kind) return;
        if (kind === 'flat') f2.set(atb, (f2.get(atb) ?? 0) + (a.val ?? 0) * scale);
        else if (kind === 'addRatio') a2.set(atb, (a2.get(atb) ?? 0) + (a.val ?? 0) * scale);
        else m2.set(atb, ctx.affix.composeMul(a.ref, m2.get(atb) ?? 1, a.val ?? 0));
      };
      for (const b of active) for (const a of b.affixes) put(a, b.stacks ?? 1);
      hit = evaluateLoadout(cat, loadout, {
        baseStatsFor, injectFlat: f2, injectAddRatio: a2, injectMulRatio: m2,
      }).sheet;
      restatCache.set(key, hit);
      return hit;
    }
    const tp = combat.throughput(rot, combatBase.sheet, tgt, opts,
      { restat, timedBuffs: timed, averagedSheet: averaged.sheet, mods });
    // Survivability is what you average over a fight, so it reads the averaged
    // sheet - a defensive cooldown you press is real mitigation, just not
    // mitigation you are standing in right now.
    const sv = combat.survivability(averaged.sheet, tgt, mix);
    // A talent buff whose uptime is not derivable is a real gap, and the list
    // the user reads has to carry it.
    const extraGaps = [
      ...talentBuffGaps.map((g) => ({
        id: g.id,
        source: 'talent',
        why: `${g.from} grants it for ${g.duration}s but declares no cooldown, so its uptime is not in the data`,
      })),
      ...upgradeGaps.map((g) => ({
        id: g.id,
        source: g.slot,
        why: `the effect ${g.stars} upgrade star${g.stars === 1 ? '' : 's'} unlock is a script proc, not an affix`,
      })),
      ...talentDepGaps.map((g) => ({
        id: g.from,
        source: 'talent',
        why: `its effect lands only while ${g.needsName} is up, and nothing in this build applies that`,
      })),
    ];
    for (const u of unreadMods) {
      extraGaps.push({
        id: u.from, source: 'talent',
        why: `it modifies ${u.field} for ${u.scope} damage, which is a category this fight does not separate`,
      });
    }
    if (extraGaps.length) tp.unmodelled = [...tp.unmodelled, ...extraGaps];
    return { ...r, target: tgt, weaponPower, profile, rotation: rot, buffs, throughput: tp, survivability: sv };
  }

  /**
   * The scalar the search maximises.
   *
   * A single goal is used raw. A weighted blend is normalised against a
   * reference evaluation captured once at the start of a run, so "dps=1,
   * ehp=0.25" means what it looks like instead of being swamped by whichever
   * metric happens to have the larger units.
   */
  function makeScorer({ goal = 'dps', weights = null, target, rank = 1, mix = 0.5, ref = null }) {
    const metrics = (ev) => ({
      dps: ev.throughput.dps,
      hps: ev.throughput.hps,
      sps: ev.throughput.sps,
      ehp: ev.survivability.ehp,
    });
    const w = weights && Object.keys(weights).length ? weights : null;
    if (!w && goal !== 'mixed') {
      return {
        metrics,
        score: (loadout) => metrics(evaluate(loadout, { target, rank, mix }))[goal] ?? 0,
        scoreFrom: (ev) => metrics(ev)[goal] ?? 0,
      };
    }
    const blend = w ?? { dps: 1, ehp: 0.25 };
    const refM = ref ? metrics(ref) : null;
    const norm = (m) => {
      let s = 0;
      for (const [k, wk] of Object.entries(blend)) {
        const base = refM?.[k];
        s += wk * ((m[k] ?? 0) / (base && base > 0 ? base : 1));
      }
      return s;
    };
    return {
      metrics,
      score: (loadout) => norm(metrics(evaluate(loadout, { target, rank, mix }))),
      scoreFrom: (ev) => norm(metrics(ev)),
    };
  }

  const audit = [
    ...auditModel(cdb, ctx),
    ...combat.audit.filter((a) => !(a.what.startsWith('Fervor') && opts.assume.fervorScope === 'none')),
    {
      severity: 'assumption',
      what: 'a self-buff is worth duration/cooldown of itself, at full stacks',
      why: 'A buff on a cooldown is credited at min(1, duration / cooldown) - Priest_BlessingOfFervor is ' +
           '15s on 120s, so 13%. One with no cooldown behind it keeps 100%: a 15-second enchant buff ' +
           'refreshed by a 30%-per-attack proc does sit at its cap in sustained combat. Stacks are ' +
           'still counted at the cap, which a short or movement-heavy fight would not reach.',
    },
    {
      severity: 'assumption',
      what: 'a damage-over-time snapshots its multipliers when it is applied',
      why: 'A DoT ticks at the value it was worth at the moment it landed and does not follow buffs that ' +
           'come and go while it runs. Nothing in the CDB states this either way; it is the convention ' +
           'SimulationCraft uses for World of Warcraft, where target debuffs snapshot at cast end and ' +
           'player buffs at impact, and it is the one this model follows. A re-application re-snapshots.',
    },
    {
      severity: 'assumption',
      what: opts.lookahead > 0
        ? `the rotation is searched ${opts.lookahead}s ahead, and the better of that and priority order is kept`
        : 'the rotation is a first-available priority list, with no lookahead',
      why: 'SimulationCraft answers this with a human-authored Action Priority List and does no search at ' +
           'all - its wiki says outright that there is "no lookahead or optimization of action orderings". ' +
           'Nobody authors those lists for this game, so a bounded rollout stands in for one. It is a ' +
           'heuristic and a myopic one: it maximises what lands inside the horizon while the cost of ' +
           'spending a cooldown early falls outside it, and on two classes that made the answer WORSE ' +
           'than plain priority order. So the fight is played both ways and the better kept, which is a ' +
           'lower bound on what a player can get rather than a claim about what they would do. Sequencing ' +
           'is worth 0-0.4% on the builds in this data: the player-facing debuffs are mostly movement ' +
           'slows, and the few damage amplifiers sit on cooldowns long relative to their windows.',
    },
    {
      severity: 'assumption',
      what: `throughput is a ${opts.fight}-second fight, not a steady state`,
      why: 'Cooldowns are pressed in priority order - highest damage per second of commitment first - ' +
           'charges are spent as the bank allows, statuses tick and expire, and the base-attack chain ' +
           'fills what is left. --fight changes the length and --fights rolls the procs for real ' +
           'instead of folding them in at their expected rate.',
    },
    {
      severity: 'assumption',
      what: `an area effect is priced against ${opts.targets} target${opts.targets === 1 ? '' : 's'}`,
      why: 'The geometry is fully authored - shape, range, height, and an expanding rangeScale - but ' +
           'nothing anywhere says how many enemies stand inside it. `unitGroup` describes spawn points ' +
           'and the `spawner` sheet is empty because placement is level data. So --targets is an input, ' +
           'never a derived number, and only Area and Aura steps scale with it.',
    },
    {
      severity: 'unverified',
      what: 'a cast costs only its own authored duration - no global recovery window',
      why: 'Skill_RecoveryTime (1s) used to be added to every cast, which billed a level-25 Priest 0.59 ' +
           'attacks a second for a chain whose authored durations run at 2.2. It sits in the constant ' +
           'sheet inside the SpawnTime/Aggro/Panic/PathSearch block between Skill_Pick_RetryCooldown and ' +
           'Skill_RecoveryTime_Boss, and its only bytecode symbol is ent.Foe.getSkillRecoveryTime - so it ' +
           'reads as foe AI. That is circumstantial: bare `recoveryTime` and `get_recoveryTime` symbols ' +
           'also exist and have not been placed. ComboWindow (0.6) and AttackQueueTime (0.4) are ' +
           'consistent with a chain that runs back to back.',
    },
    {
      severity: 'unmodelled',
      what: 'whether a `Mono` step carrying an area cleaves',
      why: '80 Mono steps carry a props.area, and structurally identical rows disagree in their own ' +
           'descriptions - DM_Base_Attack1 is Mono + Cone(160) "to nearby enemies", Daggers_Base_Attack ' +
           'is Mono + Cone(150) "to an enemy". Mono is treated as single-target, which is the reading ' +
           'that agrees with the descriptions on 87% of player skills and the one that cannot flatter.',
    },
    {
      severity: 'verified',
      what: 'the arsenal gives two skills and 40% of its stats, and nothing else',
      why: 'Confirmed in game: you do not swap to it. It contributes no base-attack chain and no combo ' +
           'attack, so the main hand supplies all of the filler; its two slotted skills and its discounted ' +
           'stats are its entire contribution. The same spear reads +36/+18/+15/+39/+39 in the main hand ' +
           'and +15/+8/+6/+16/+16 in the arsenal, which is ceil(v * 0.4) on all five and not a half. The ' +
           'factor itself is read from itemType Slot_Weapon2 slot.affixFactor, so a patch moves it on its own.',
    },
    {
      severity: 'assumption',
      what: 'a DemonSigil is taken because a free talent beats an empty socket, not because it scored',
      why: 'Each of the 12 sigils grants one tier-4 talent, and most of those declare no effect, no affix ' +
           'and no status - Priest_Talent_SunHalo carries only vars.damage 0.5 and no script at all, so ' +
           'its behaviour lives in game code keyed on the talent being present. The objective therefore ' +
           'cannot rank the sigils against each other, and the socket used to be left empty because of ' +
           'it. The search now breaks that tie towards taking one, and the output says the pick is not ' +
           'scoreable rather than presenting it as a considered choice.',
    },
  ];

  return {
    cdb, ctx, cat, combat, plan, talents, profiles, opts, audit,
    baseStatsFor, evaluate, makeScorer, socketsOf: (l) => socketsOf(cat, l),
    meta: cdb.meta,
  };
}
