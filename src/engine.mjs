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
import { LANDER_WAYS } from './sim.mjs';
import { buildSkillPlan } from './skills.mjs';
import { buildTalentPlan } from './talents.mjs';
import { buildProfiles } from './profiles.mjs';
import { evaluate as evaluateLoadout, classOf, socketsOf } from './loadout.mjs';
import { infusionSets } from './loadout.mjs';
import { buildInfusionPlan } from './infusion.mjs';

export const GOALS = ['dps', 'hps', 'sps', 'ehp', 'mixed'];
export const FERVOR_SCOPES = ['skills', 'all', 'none'];
export const TICK_SOURCES = ['instigator', 'carrier'];

export const DEFAULT_ASSUME = {
  // Fervor's description says "your Skills", but the measurement says
  // everything: a combo finisher at 133 went to exactly 133 x 1.12 x 1.016
  // = 151 under +12% PhysicalMastery and 30 FervorRating (~+1.58%) - without
  // the Fervor term it prices 149. So base attacks get it too, and 'all' is
  // the default. --fervor-scope skills|none remain as sensitivity toggles.
  fervorScope: 'all',
  mastery: true,
  // Whose sheet seeds a status tick's context - its crit and its
  // (1 + fervor + mastery) bracket. 'instigator' is what build 25782799's
  // SkillContext.initVars@5241 reads (the unit that APPLIED the status);
  // 'carrier' is the accepted 2026-08-11 build's rule (the unit WEARING it),
  // which is the one the captures measured. The new read is scored and not
  // yet measured - see castOutput in damage.mjs and the audit entry -
  // so --tick-source carrier stays as the comparison.
  tickSource: 'instigator',
  // How much of the time basic attacks land from the target's rear half-plane,
  // for the weapon upgrade perks that pay there. The predicate (read from
  // Daggers_Upgrade's script) is a full 180 degrees of "behind", so 1.0 is
  // the claim for a build that repositions every swing - Shadowstep teleports
  // there - but nobody sustains it: the 2026-08 capture sweep measured the
  // player's realized behind-share at ~0.41 across sessions, and the one
  // dummy session that watched a drifting melee read 0.68-0.85. The default
  // is the measured number; --behind-fraction 1 restores the optimist.
  behindFraction: 0.41,
  // The share of a passive's ground drops the hero walks into, for a cast
  // that is armed by collecting them (the Censer's Hidden Power: a cloud
  // every 3 s at a random spot 3 to 10 units off, lying 6 s, seven to arm).
  // The timer and the count are authored; whether a drop is collected is
  // the player's feet and is in no row. 1 - every drop, the moment it lands,
  // with no step billed - is the most the script allows and it is NOT
  // measured on this build: it is the default because it is the read with
  // nothing subtracted, and the audit and the build both say it is an input.
  // --pickups states another.
  pickupShare: 1,
  // Reported from play: casting a skill interrupts the base-attack chain, so
  // the next swing starts the chain over. Everything gated on the combo
  // finisher - Rage income, prayer charging, per-combo procs - rides on this.
  // --chain-persists restores the old always-continues reading.
  chainResets: true,
  // An unpinned item's stats follow A DROP AT YOUR LEVEL. This is measured, not
  // assumed: a Cheese Moon read in game is "Axe Level 25" with three upgrade
  // stars, and only iLevel 290 (25x10 + the Rare bonus + 3x10) reproduces its
  // +36/+15/+18/+39/+39. The authored `item.level` is the row's reference - the
  // level the thing first becomes available - not the level a drop arrives at.
  // `--drops authored` keeps the old reading and a `^N` pin still names an
  // instance exactly.
  dropsScale: true,
  // The measured floor on a chain link's swing period - see buildCombat.
  swingFloor: 0,
};

export function createEngine({ game, assume = {}, fight = {}, quiet = false, classSkillSlots } = {}) {
  const cdb = loadCdb({ game, quiet });
  const ctx = buildContext(cdb);
  const cat = buildCatalog(cdb, ctx);
  const assumeAll = { ...DEFAULT_ASSUME, ...assume };
  cat.setDropsScale(assumeAll.dropsScale !== false);
  const combat = buildCombat(cdb, ctx, assumeAll);
  const plan = buildSkillPlan(cdb, ctx, cat, combat,
    classSkillSlots != null ? { classSkillSlots } : {});
  const talents = buildTalentPlan(cdb, ctx, cat, combat, plan);
  const profiles = buildProfiles(cdb, ctx, cat);
  const infusionPlan = buildInfusionPlan(cdb, cat, combat, plan);
  const opts = {
    assume: assumeAll,
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
    // The fraction of its health the target is standing at, for the eight
    // script clauses that ask. It is an INPUT and never a derived number - the
    // same standing `--targets` has, and for the same reason: nothing in the
    // data says which phase of a fight you are describing, and the honest
    // answer is to be told rather than to average over a kill nobody specified.
    //
    // It lives BOTH here and on `evaluateOnce`, exactly as `fight` does. The
    // per-evaluation argument is the real parameter - the UI serves many health
    // values off one engine - and this is its default, so a call site that does
    // not mention it inherits what the run was asked for instead of silently
    // falling back to full health. bench has ~20 evaluate/optimize call sites
    // and threading a value through every one of them is how a parameter comes
    // to do nothing on the nineteenth.
    targetHealth: fight.targetHealth ?? 1,
    seed: fight.seed ?? 0x9e3779b9,
  };
  if (!FERVOR_SCOPES.includes(opts.assume.fervorScope)) {
    throw new Error(`fervorScope must be one of ${FERVOR_SCOPES.join(', ')}`);
  }
  if (!TICK_SOURCES.includes(opts.assume.tickSource)) {
    throw new Error(`tickSource must be one of ${TICK_SOURCES.join(', ')}`);
  }
  // A ratio, not a percentage, and never zero: `healthRatio` is what the
  // scripts read and a target at 0 is one that is already dead. Checked at
  // BOTH boundaries - construction and every evaluation - because the two take
  // it from different places: the CLI validates its own flag before building
  // an engine, while /api/sheet hands a per-call value straight out of request
  // JSON. Unchecked there, the CLI's own units (`--target-health 35`) sent as
  // a fraction read as 35, every execute clause silently missed, and a
  // full-health answer came back with no error at all.
  const checkTargetHealth = (v) => {
    if (!(v > 0 && v <= 1)) {
      throw new Error(`targetHealth must be a fraction in (0, 1], got ${v}`
        + (v > 1 && v <= 100 ? ` - that looks like a percentage; ${v / 100} is ${v}%` : ''));
    }
    return v;
  };
  checkTargetHealth(opts.targetHealth);

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
    //
    // Only SKILL-BEARING items key the gear portion. An armour swap cannot
    // change the rotation, and keying every slot's item made each of the
    // optimiser's ~20k armour candidates mint its own cached rotation - a
    // cache with a near-zero hit rate that ate 4GB twenty-five pairs into a
    // `bench layouts` sweep. The cap is the second seatbelt: evicting the
    // oldest entry costs a re-resolve, never correctness.
    const skillBearing = (slotId) => {
      const g = loadout.gear[slotId];
      if (!g?.item) return '';
      const it = cat.itemById.get(g.item);
      return it?.skills?.length ? it.id : '';
    };
    const key = loadout.class + '@' + loadout.level + '|' + rank
      + '|' + (loadout.gear.Slot_Weapon1?.item ?? '-')
      + '|' + (loadout.gear.Slot_Weapon2?.item ?? '-')
      + '|' + Object.entries(loadout.skills ?? {}).sort().map(([k, v]) => k + ':' + v.join('+')).join(';')
      + '|' + cat.combatSlots().map((s) => skillBearing(s.id)).join(',')
      + '|' + Object.entries(loadout.augments ?? {}).filter(([, v]) => v).sort().join(',')
      + '|' + Object.values(loadout.runes ?? {}).flat().filter(Boolean).sort().join(',')
      + '|' + Object.entries(loadout.talents ?? {}).sort().map(([k, v]) => k + ':' + v).join(',');
    let r = rotationCache.get(key);
    if (!r) {
      r = plan.resolve(loadout, rank);
      rotationCache.set(key, r);
      if (rotationCache.size > 4000) rotationCache.delete(rotationCache.keys().next().value);
    }
    return r;
  }

  /** Full evaluation: stat sheet, throughput, survivability, rotation lines. */
  function evaluateOnce(loadout, { target, rank = 1, mix = 0.5, policy = null, goal = 'dps', fight = null, chainFeeds = null, holdChain = false, poolStart = null, conduitStacks = null, ccIntervals = null, targetHealth = opts.targetHealth } = {}) {
    checkTargetHealth(targetHealth);
    const cls = classOf(cat, loadout);
    const tgt = target ?? combat.foe('reference', loadout.level);
    const weaponPower = combat.weaponPowerFor(cat, loadout, cls);
    const rot = rotationFor(loadout, rank);
    // WeaponPower's other half: every read of it adds the mean of the ITEM's
    // aptitude attributes off whatever sheet is being consulted, at the
    // attribute keep (0.6 since build 25782799 flagged the WeaponPower row
    // ItemScaling; the whole mean on the accepted build, where Beefury swung
    // with 6.5% Strength + 6.5% Faith) - see scalingValue in damage.mjs. And
    // a MAINHAND skill's attribute scalings mix 60% attribute with 40% of
    // that attribute's own budget curve at the CHARACTER's level
    // (WeaponPowerRatio's 0.4), ten integers measured exact on the accepted
    // build - so the fight knows which casts are the mainhand's and which
    // attributes its swings read.
    const mainItem = loadout.gear.Slot_Weapon1?.item
      ? cat.itemById.get(loadout.gear.Slot_Weapon1.item) : null;
    const hasArsenal = !!loadout.gear.Slot_Weapon2?.item;
    // Hoisted so the weapon-mix can see them: a stack-proc's follow-up hosted
    // by a WEAPON's own passive (the Censer ultimate) is weapon-based and
    // takes the 0.6/0.4 mix like every other weapon cast.
    const stackProcs = plan.stackProcsOf(talents.runableSkillIds(loadout),
      { rank, runes: new Set(rot.runes ?? []) });
    const weaponItemSkills = new Set(['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']
      .map((slot) => loadout.gear[slot]?.item && cat.itemById.get(loadout.gear[slot].item))
      .filter(Boolean)
      .flatMap((it) => it.skills ?? []));
    // Marks the rotation's own casts apply: consumed on the second stack, one
    // scripted lump per pairing. Weapon-hosted appliers put the mark's step
    // on the weapon mix like every other weapon cast.
    const markProcs = plan.markProcsOf(
      [...rot.active, ...rot.filler].map((x) => x.prof.id),
      { rank, runes: new Set(rot.runes ?? []) });
    // Marks the rotation's casts stack on the target for a later hit to
    // detonate (Void Bomblet) - see plan.detonationsOf.
    const detonations = plan.detonationsOf(
      [...rot.active, ...rot.filler].map((x) => x.prof.id),
      { rank, runes: new Set(rot.runes ?? []) });
    // Every cast in the build that puts crowd control on what it hits, with
    // each control's own duration. A grafted entry is asked as its host, and
    // a script-played step as the row whose script plays it.
    //
    // Split by whether the fight can PRICE the control, and nothing is
    // dropped: `ccAppliers` feed the gate's share; `ccUnpriced` are controls
    // the build holds and the share leaves out - a duration the row does not
    // give in seconds, a step or call the script reaches from an event this
    // fight does not produce - and they are named wherever something reads
    // the gate. They used to be filtered here without a word.
    const ccRunes = new Set(rot.runes ?? []);
    // WHICH control, because the target does not refuse them all alike. A unit
    // can take a root or a slow and still refuse a STUN: ent.Unit
    // .Unit.canReceiveStatus@4922 ops 0-57 return false for a status any of whose
    // types reaches the `Stun` row up its parent chain, on a unit carrying
    // the NoStun flag - with no word about the CrowdControl flag, which is
    // GameObject.canReceiveStatus@4634's separate test and the target's
    // `ccImmune`. So credit that needs a stun STANDING on the target is
    // nothing against `stunImmune`, while a root or a slow keeps gating on
    // `ccImmune` alone. `crowdControlOf` hands each control with its types,
    // which is what tells them apart; until this was wired, `--target big`,
    // `dungeon` or any NoStun unit still paid Domination for stuns that
    // never landed.
    const statusTypeRows = cdb.byId('statusType');
    const isStun = (types) => (types ?? []).some((t) => {
      const seen = new Set();
      for (let x = statusTypeRows.get(t); x && !seen.has(x.id); x = statusTypeRows.get(x.parent)) {
        if (x.id === 'Stun') return true;
        seen.add(x.id);
      }
      return false;
    });
    const stunRefused = tgt.stunImmune === true;
    const ccLands = (c) => !(stunRefused && isStun(c.types));
    const ccPriced = (c) => !c.unpriced && c.duration > 0 && ccLands(c);
    const ccAll = [...rot.active, ...rot.filler, ...(rot.triggered ?? [])]
      .map((e) => ({
        prof: e.prof,
        cc: plan.crowdControlOf(e.via ?? String(e.prof.id).split('#')[0], { rank, runes: ccRunes }),
      }))
      .filter((e) => e.cc.length);
    const ccAppliers = ccAll.map((e) => ({ prof: e.prof, cc: e.cc.filter(ccPriced) }))
      .filter((e) => e.cc.length);
    const ccUnpriced = ccAll.flatMap((e) => e.cc.filter((c) => !ccPriced(c) && ccLands(c)).map((c) => ({ prof: e.prof, cc: c })));
    // ...and the ones this target refuses outright, named apart: nothing about
    // them is unread.
    const ccRefused = ccAll.flatMap((e) => e.cc.filter((c) => !ccLands(c)).map((c) => ({ prof: e.prof, cc: c })));
    const evalOpts = {
      ...opts,
      // A REPLAY prices the fight at the capture window's own length, so the
      // per-minute columns are commensurable with the recorded ones.
      ...(fight > 0 ? { fight } : {}),
      ...(chainFeeds ? { chainFeeds } : {}),
      // A fight in which the base-attack chain is never swung: what a
      // recorded window of isolated presses was (`bench verify` asks for it
      // when a window holds no hit of the build's own chain). The fight
      // stands still between casts, and the statuses only a swing applies
      // are not up - see the self-buff fold below.
      ...(holdChain ? { holdChain: true } : {}),
      // What a pool stands at when the fight opens, where the caller knows
      // (`bench verify` reads a window's opening Spark off the log): a Mage
      // who starts under half her pool fires no conduit until she is fed.
      ...(poolStart ? { poolStart } : {}),
      // Overrides the engine's default for THIS evaluation. Every cache between
      // the guard and the damage number was checked against this: the rotation
      // is structure and cannot see it, `profile()` and `runeDamage` bank the
      // COMPARISON rather than its answer (see damage.mjs), and `castCache`,
      // `factorCache` and `restatCache` are all built inside one evaluation and
      // die with it. So this is the only place the number has to arrive.
      targetHealth,
      attackerLevel: loadout.level,
      swingAttrs: mainItem
        ? mainItem.aptitudes.map((a) => combat.primaryAtbFor({ aptitude: a })).filter(Boolean)
        : null,
      // The mix has NO slot gate - getStepEffectItemScaling@21779 checks only
      // isWeaponBased on the skill type - so the arsenal's weapon skills mix
      // exactly like the mainhand's. Class skills (type 9) stay pure
      // attribute, read straight off BaseSkill.isWeaponBased@6164's set.
      // The item-scaling channel follows the granting item's TYPE CHAIN, per
      // getStepEffectScaling@21777: itemRatio 0.4 when the chain reaches
      // MainhandWeapon (every held weapon does), 1.0 for GearTrinket, and 0
      // otherwise - Shield inherits OffhandWeapon > Weapon and never
      // MainhandWeapon, so a SHIELD-granted status prices PURE attribute (the
      // orb's live pulse is 0.55 x live-ceiled Faith x its riders exactly; an
      // earlier +0.4-budget reading of the same number was degenerate on this
      // one build and is gone). Weapon-granted ticks take the ordinary
      // 0.6/0.4 mix, a Raw one included (measured on Gaping Wound's bleed -
      // castOutput, `mixFlats`); class and talent statuses are in no set and
      // price pure.
      weaponMix: (() => {
        if (!mainItem && !hasArsenal) return null;
        const shieldStatus = new Set(rot.active
          .filter((x) => typeof x.source === 'string' && x.prof.isStatusTick
            && cat.itemById.get(loadout.gear[x.source]?.item)?.type === 'Shield')
          .map((x) => x.prof.id));
        // A SHIELD in the offhand takes no mix at all - the type chain
        // (Shield > OffhandWeapon > Weapon) never reaches MainhandWeapon, so
        // getStepEffectScaling@21777's itemRatio is 0 for everything it
        // grants, casts included, not only status ticks. Inert on every
        // current build (no equipped shield grants a damage-dealing cast
        // with mixable attributes), fixed while it is.
        const shieldCast = (slot) => cat.itemById.get(loadout.gear[slot]?.item)?.type === 'Shield';
        return {
          flats: combat.attributeBudgets(loadout.level),
          ids: new Set([
            ...rot.filler.map((x) => x.prof.id),
            ...rot.active
              .filter((x) => (x.source === 'Slot_Weapon1' || x.source === 'Slot_Weapon2'
                || x.source === 'Slot_OffhandWeapon') && !shieldCast(x.source))
              .map((x) => x.prof.id),
            ...stackProcs.filter((sp) => weaponItemSkills.has(sp.from)).map((sp) => sp.skill),
            ...markProcs.filter((mp) => mp.appliers.some((a) => weaponItemSkills.has(a)))
              .map((mp) => mp.status),
            ...detonations.filter((dt) => dt.appliers.some((a) => weaponItemSkills.has(a)))
              .map((dt) => dt.status),
          ].filter((id) => !shieldStatus.has(id))),
        };
      })(),
      tickScaling: (() => {
        const WEAPON_SLOTS = new Set(['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']);
        const itemType = (slot) => cat.itemById.get(loadout.gear[slot]?.item)?.type ?? null;
        return {
          flats: combat.attributeBudgets(loadout.level),
          mixIds: new Set((rot.dots ?? [])
            .filter((d) => typeof d.source === 'string' && WEAPON_SLOTS.has(d.source)
              && itemType(d.source) && itemType(d.source) !== 'Shield')
            .map((d) => d.status)),
          // The trinket channel: a status granted by a GearTrinket prices its
          // item-scaled attributes off the ITEM alone - the item share is 1
          // there (getStepEffectScaling@21777 ops 27-35) - at the level the
          // instance stands at. One map of flats per such status; see
          // `itemFlats` in castOutput for the read and the measurement.
          itemFlats: new Map((rot.dots ?? [])
            .filter((d) => typeof d.source === 'string' && d.source.startsWith('Slot_')
              && !WEAPON_SLOTS.has(d.source)
              && cat.itemById.get(loadout.gear[d.source]?.item)?.chain?.includes('GearTrinket'))
            .map((d) => {
              const item = cat.itemById.get(loadout.gear[d.source].item);
              return [d.status, combat.itemBudgets(item, cat.instanceLevel(item, {
                charLevel: loadout.level, level: loadout.gear[d.source].level ?? null,
              }))];
            })),
        };
      })(),
      // THE LIVE-STATE GATES a skill's own script riders ask about. Both were
      // refusals until the 2026-08-02 capture priced them; refusing them cost
      // -13.7% to -17.5% on the skills that carry one.
      //
      //   bleeding - the combo's `+20% vs a bleeding target`. Credited whole
      //     when this build actually applies a Bleed-typed dot and zero when it
      //     does not, which is the policy the scoped talent modifiers already
      //     use: a bleed re-applied off every crit is up essentially always,
      //     and the capture measured it up at 17 of 17 steady finishers.
      //
      //   cc - Domination's `+25% vs a crowd-controlled target` (rank 3 only on
      //     build 25782799), and Chaotic Distorsion's own +40% behind the same
      //     question. The union of every crowd control this kit applies AND the
      //     fight can count (`ccAppliers` above; the rest are named, not priced),
      //     each at duration/interval: independent windows, so 1 - PROD(1 - u).
      //     Nothing here is invented - the durations come off the appliers
      //     (`plan.crowdControlOf`, which resolves a duration authored as a
      //     vars key and reads the `addStatusDuration` appliers too) and the
      //     interval is the applier's own: cooldown plus exec offset on a first
      //     pass, and the interval THE FIGHT ACTUALLY PLAYED on the second
      //     (see `evaluate`). An applier with no cooldown has no interval
      //     before the fight - Raging Smash under the Thundersmash rune is
      //     gated by Rage, not by a clock - and reading its 0.4s cast as its
      //     period called the target slowed for the whole fight.
      //
      //   ccImmune - the target refuses crowd control outright
      //     (GameObject.canReceiveStatus@4634; Foe.isCCImmune@7071 is the
      //     unit's Boss, Miniboss or Elite flag). The TARGET says so
      //     (`foe.ccImmune`); absent, it does not. It switches `cc` off whole -
      //     a boss is never "under any CC" - and switches ON the two riders
      //     that ask for exactly that, Shockwave's and Iron Cyclone's rank-3
      //     "+x% to enemies immune to crowd control".
      // A NEXT-CAST EMPOWERMENT the build can arm. `runableSkillIds` already
      // walks the augments, so a sigil-granted talent is in it - which matters,
      // because Surge of Violence needs no talent point: DemonSigil_War_
      // SurgeOfViolence hands the node over from a Head socket, and bench's own
      // Warrior optimum slots exactly that sigil.
      empowerments: plan.empowermentsOf(talents.runableSkillIds(loadout),
        { rank, runes: new Set(rot.runes ?? []) }),
      // A stack counter that arms a follow-up. Its rate is `events / maxStacks`
      // and the fight counts its own events, so the old refusal - "nothing in
      // the data says how many hits arm it" - was false: the data says 100.
      stackProcs,
      markProcs,
      detonations,
      rank,
      gates: (() => {
        const bleeding = rot.dots?.some((d) => (d.types ?? []).some((t) => /Bleed|Hemorage/i.test(t)))
          ? 1 : 0;
        const ccImmune = tgt.ccImmune === true;
        let miss = 1;
        // ...and the same union PER STATUS TYPE, for the riders that ask for
        // one type by name (`ccType`: Riptide and Pyroclasm ask for a Slow).
        // Keyed `cc:<type>`; a type nothing applies has no key and reads 0.
        const missBy = {};
        if (!ccImmune) {
          for (const e of ccAppliers) {
            const every = ccIntervals ? ccIntervals.get(e.prof.id)
              : e.prof.cooldown > 0 ? e.prof.cooldown + (e.prof.execOffset ?? 0) : null;
            if (!(every > 0)) continue;
            for (const cc of e.cc) {
              const out = 1 - Math.min(1, cc.duration / every);
              miss *= out;
              for (const t of cc.types ?? []) missBy[t] = (missBy[t] ?? 1) * out;
            }
          }
        }
        return {
          bleeding, cc: ccImmune ? 0 : 1 - miss, ccImmune: ccImmune ? 1 : 0,
          ...Object.fromEntries(Object.entries(missBy).map(([t, m]) => [`cc:${t}`, 1 - m])),
        };
      })(),
      // The riders the owner carries for every hit - see `ownerRiders` in
      // skills.mjs and where castOutput takes them.
      ownerRiders: rot.ownerRiders ?? [],
      // Which of a row's own hits land inside the crowd control that row
      // applies - the same reader the share above is built from, asked of
      // the row whose hits they are (a script-played step is its host's; a
      // grafted status is NOT its host's cast, its ticks come later).
      //
      // A row of an attached INFUSION is asked at the set's own rank and with
      // no rune: its lines enter the fight beside the rotation (see the
      // fight view below), and the weapon's rank has no business answering
      // for them. The target's say (`lands`) is the same for both: a stun it
      // refuses does not stand, whoever applied it.
      ccOwn: (id) => {
        const row = String(id).split('#')[0];
        const setRank = infusion.fight.rankOf.get(row);
        return plan.ownCrowdControlOf(row, setRank != null
          ? { rank: setRank, runes: new Set(), lands: ccLands }
          : { rank, runes: ccRunes, lands: ccLands });
      },
    };
    // A STEP A WEAPON SKILL'S SCRIPT PLAYS IS STILL THAT SKILL'S STEP. A script
    // rider enters the fight as `host#step` in `triggered`, which the mix set
    // above never looked at - so Brutal Frenzy's second strike was priced on
    // bare Strength while the finisher it belongs to took the mix, and the
    // suite's own pin of that step (priced with the finisher's id, mix on)
    // contradicted the fight. The channel is decided by the skill ROW's type
    // (getStepEffectItemScaling@21779 via BaseSkill.isWeaponBased@6164), and the row is
    // the host's. The same goes for a rider that lives inside a window a
    // weapon skill opens: it is that weapon's status, and a status with no
    // type of its own is asked through the skill that applied it
    // ($HSkill.getStepEffectVal@21774 ops 64-106: the source item is handed
    // on when the row isWeaponBased, or its getSourceSkill() is - for a
    // status its instigator skill, Status.getSourceSkill@15829 - or its
    // source item is a GearTrinket).
    //
    // A typeless row that is NOBODY's status stays out, on purpose. Cascade's
    // Axe is one: `props.rankPassives` makes it a skill of its own, parented
    // where the finisher is (BaseSkill.initPassiveSkills@6142 ops 96-99), so
    // it is its own source (BaseSkill.getSourceSkill@6149), not weapon-based,
    // and takes no item - pure attributes, beside a blast of the same weapon
    // that takes the mix. The audit names the pair and the measurement.
    if (evalOpts.weaponMix) {
      // ...and a step a weapon's PASSIVE plays on its own clock (a use
      // rider's, skills.mjs useRiderOf): WeaponPassive is a weapon-based type
      // (24, BaseSkill.isWeaponBased@6164 ops 45-51), so the step takes its weapon's mix.
      // MEASURED 2026-10-13: Queen's Decree's step - 0.1 x Strength + 0.1 x
      // Intellect at 41 / 159 - logs 23 on a plain hit with no mastery up,
      // which is ceil(22.4) off the mix; the bare attributes give 19.6.
      for (const u of rot.useRiders ?? []) {
        if (!u.critStep || !['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon'].includes(u.source)) continue;
        if (cat.itemById.get(loadout.gear[u.source]?.item)?.type === 'Shield') continue;
        evalOpts.weaponMix.ids.add(u.critStep.prof.id);
      }
      for (const x of rot.triggered ?? []) {
        const id = x.prof?.id ?? '';
        const host = id.includes('#') ? id.slice(0, id.indexOf('#')) : null;
        // ...or one a weapon's PASSIVE opens (Blessing): the passive is no
        // cast and sits in no list above, so its slot says whose it is - the
        // same test `tickScaling.mixIds` puts to a weapon-granted dot.
        const ownSlot = x.rule?.window?.on && typeof x.source === 'string'
          && ['Slot_Weapon1', 'Slot_Weapon2'].includes(x.source)
          && cat.itemById.get(loadout.gear[x.source]?.item)?.skills?.includes(x.rule.window.from);
        if ((host && evalOpts.weaponMix.ids.has(host)) || ownSlot
          || (x.rule?.window && evalOpts.weaponMix.ids.has(x.rule.window.from))) evalOpts.weaponMix.ids.add(id);
      }
    }

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
      ? profiles.resolve(loadout.profile, loadout.class, loadout.level, loadout.profileValues ?? {}) : null;
    // PINNED, not added. The profile's numbers replace whatever the level curve
    // and the gear produce, so two weapons are compared on the kit they grant
    // rather than on which is the better stat stick. It rides every sheet this
    // function builds - the base, the averaged one, and every re-price during
    // the fight - or a buff window would quietly escape the rig.
    const force = profile?.force ?? null;

    // The effect a weapon's upgrade stars unlock. The game's own window says
    // upgrading a weapon gives "access to a unique effect", and each weapon
    // type has a `<Type>_Upgrade` skill carrying five mutually exclusive
    // rank-gated affix rows - `Scepter_Upgrade` +4..+8 SpellPenetration,
    // `Staff_Upgrade` +2..+6 CooldownReduction. Eight of the twenty carry
    // readable affixes; the other twelve are procs whose payload lives in a
    // script, and those are named in the audit.
    //
    // STARS DECIDE WHETHER IT ATTACHES; RARITY DECIDES WHICH ROW. See the
    // closed question below - the rank is the rolled rarity index, and the
    // stars only have to clear GearUpgrades.SkillUnlockLevel. So the ladder's
    // ends never fire: rank 1 is below the Rare index the unlock floors it at,
    // and rank 5 is past Legendary. A Staff reads +3/+4/+5 and nothing else.
    //
    // The rows are MUTUALLY EXCLUSIVE per star, the same shape as every other
    // rank-gated affix in this database, so they are filtered and never summed.
    //
    // THE ARSENAL'S UPGRADE EFFECT REACHES YOU TOO. This used to read only the
    // weapons you wield, on the reasoning that the arsenal grants two chosen
    // skills and its discounted stats and the upgrade effect is neither. The
    // player's own Character Profile refutes it: on a build whose only crit
    // sources are the naked base, the ratings, and Judgement's upgrade line, the
    // sheet reads 17.3% where base + ratings alone give 14.26%. Nothing else in
    // that loadout grants CritChance, so the ~3 points are the ARSENAL weapon's
    // `GreatAxe_Upgrade` row arriving whole - it is not discounted by the
    // slot's 0.4 either, because an upgrade row is a skill affix and not a
    // stat line.
    //
    // THE RIDER ROW AND THE iLEVEL DO NOT COUNT THE SAME THING. The iLevel is
    // unambiguous about the stars - 320 = 250 + Epic 30 + 4x10 - and the affix
    // ladder is +1/+2/+3/+4/+5 by rank, so the data reads +4. The screenshot
    // reads "Critical Chance increased by 3%" on that same four-star weapon,
    // and the sheet closes at 17.3 with 3. So the rank the row sees is
    // STARS - 1, and a one-star weapon carries no rider at all.
    //
    // Which of two rules that is stays open: plain `stars - 1`, or `stars`
    // capped at the rarity's own maximum minus one. Every Epic case agrees, so
    // one hover of the Rare 3-star Axe_Boomerang decides it - +2 is the first,
    // +3 the second.
    const upgradeGaps = [];
    const upgradeProcs = [];
    const upgradeBehind = [];
    // The open question above is CLOSED, by bytecode and by two tooltips that
    // break the stars rule. Weapon.getWeaponUpgradeSkill@9837 attaches the
    // upgrade skill only at upgradeLevel >= GearUpgrades.SkillUnlockLevel (3),
    // and sets rank = the instance's ROLLED rarity index - Weapon.updateInf@9829
    // overwrites inf.rarity with the roll before the read. Every previously
    // measured weapon was degenerate between the two rules (Rare 3-star reads
    // 2 either way, Epic 4-star reads 3); the discriminators are Emsey's
    // 3-star Epic daggers showing the rank-3 "12%" where stars-1 says rank 2,
    // and Emsei's Legendary shield showing the rank-4 "-11%" where stars-1
    // says -9%.
    const rarityIndex = new Map(cdb.lines('rarity').map((r, i) => [r.id, i]));
    const skillUnlock = (() => {
      const v = cdb.constant('GearUpgrades');
      const row = v?.group?.find?.((x) => x.id === 'SkillUnlockLevel');
      return row?.v?.float ?? 3;
    })();
    for (const slotId of ['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']) {
      const g = loadout.gear[slotId];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      const upgradeId = cat.upgradeSkillFor(item);
      if (!upgradeId) continue;
      const stars = Math.min(g.stars ?? 0, cat.maxStars(item, g.rarity));
      if (stars < skillUnlock) continue;
      const riderRank = rarityIndex.get(g.rarity ?? item.rarity) ?? 0;
      const up = cdb.byId('skill').get(upgradeId);
      // The behind perk: `dmgMult += vars.damage` on basic attacks landed from
      // the target's rear half-plane, rank-resolved through rankOverride, and
      // BOTH weapons' copies sum - evalDamage runs every skill instance's hook
      // into the one additive bracket, and nothing dedupes by kind.
      {
        const body = String(up?.script ?? '');
        if (/isBasicAttack\s*\(\s*\)/.test(body) && /dmgMult\s*\+=\s*vars\.damage/.test(body)
          && /getForward\s*\(\s*\)\s*\.dot\s*\(/.test(body)) {
          let dmg = up?.vars?.damage;
          for (const ov of up?.props?.rankOverride ?? []) {
            if ((ov.minRank ?? 0) <= riderRank && ov.vars?.damage != null) dmg = ov.vars.damage;
          }
          if (typeof dmg === 'number' && dmg > 0) {
            upgradeBehind.push({ id: upgradeId, slot: slotId, damage: dmg });
            continue;
          }
        }
      }
      const rows = riderRank < 1 ? [] : (up?.affixes ?? []).filter((a) => a.target?.attribute
        && !(a.conds?.minRank != null && riderRank < a.conds.minRank)
        && !(a.conds?.maxRank != null && riderRank > a.conds.maxRank)
        && !(a.conds?.equalRank != null && riderRank !== a.conds.equalRank));
      if (!rows.length) {
        // ...but a script proc is not automatically unreadable. Twelve of the
        // twenty `<Type>_Upgrade` rows carry a script instead of affixes, and
        // one shape among them is fully in the data:
        //
        //   GreatSword_Upgrade, vars.chance 0.04
        //   "Your [BasicAttack]s have a 4% chance to attack twice."
        //   onSkillProc(ctx) {
        //     if (ctx.skill?.isBasicAttack() && checkProba(vars.chance))
        //       ctx.skill.playStep(null, ctx.skill.getExecStep().index, ...);
        //   }
        //
        // Replaying the executing step IS the hit again, so the whole payload
        // is a multiplier of (1 + chance) on basic attacks - and `isBasicAttack`
        // is skill types Attack..Attack4 (BaseSkill.isBasicAttack@6152), which
        // EXCLUDES the combo finisher. None of these rows carries a cooldown
        // and none uses the game's own internal-cooldown idiom, so the rate is
        // plain Bernoulli with nothing to saturate.
        const body = String(up?.script ?? '');
        // Rank-resolved, like every other vars read: Sword_Swarm at Legendary
        // is rank 4 and its double-attack rolls at 7%, not the base row's 4%.
        let chance = up?.vars?.chance;
        for (const ov of up?.props?.rankOverride ?? []) {
          if ((ov.minRank ?? 0) <= riderRank && ov.vars?.chance != null) chance = ov.vars.chance;
        }
        if (/isBasicAttack\s*\(\s*\)/.test(body) && /playStep\s*\(/.test(body)
          && /checkProba\s*\(\s*vars\.chance/.test(body)
          && typeof chance === 'number' && chance > 0 && chance <= 1) {
          upgradeProcs.push({ id: upgradeId, slot: slotId, stars, chance });
          continue;
        }
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
    // INFUSION SETS, attached here and not through the rotation. A set
    // passive answers every rank gate with the SET's rank - equipped pieces
    // carrying it against Item_InfusionCaps - while `rot`, and every reader
    // that walks it below, speaks the one global `rank` of weapon mastery. The
    // two never meet: nothing of an infusion enters `rot`, so the rotation
    // cache needs no infusion in its key and `--rank 3` cannot light a
    // two-piece set's `rank >= 3` branch. See infusion.mjs for what is priced
    // (the rank-gated rows, as the permanent skill affixes they are) and what
    // is named and refused.
    const infusion = infusionPlan.attach(loadout, infusionSets(cat, loadout), rot);
    for (const a of infusion.affixes) applyAffix(a, 1, 1);

    // A SKILL'S OWN AFFIX ROWS. This used to read `rot.passive` only, which is
    // the wrong half of the game's rule. `BaseSkill.permaAffixes@6188`
    // (BaseSkill.hx:865) returns false for exactly two natures - Status(4) and
    // Passive(5) - and true for everything else, and `BaseSkill.initData@6136` then does
    // `if (permaAffixes()) updateAffixes()`, handing them to `owner.addAffix`
    // for good. A passive's rows are not permanent by that test but arrive the
    // other way, through `BaseSkill.setRunning@6132`, and a passive is always running; a
    // status's rows belong to the buff path, which prices them at an uptime.
    //
    // So the rule here is every owned skill EXCEPT a status, and the row that
    // proves it is `Axe_Boomerang_Combo`: nature Combo, `TAttribute_Flat
    // CritChance +5` at `minRank: 2`, `displayed: false`, and a rankDesc that
    // says "You permanently gain ::val1%:: [CritChance]" in as many words. It
    // is owed for WIELDING the axe - `Weapon.applySkills@9836` creates a skill
    // object for every row of `item.skills` - and the model dropped it because
    // a combo is filler, not a passive.
    //
    // A census of the whole sheet finds six rows outside Status/Passive that
    // carry an attribute affix: the three weapon-class Block abilities (already
    // arriving through `passive`, hence the dedupe), Axe_Boomerang_Combo,
    // DA_Water_Combo's +2 CritChance at rank 3, and one Bee NPC row. So this
    // cannot move anything by accident.
    //
    // `applyAffix` rather than the old Flat-only `addFlat`, because a ratio row
    // in this position would otherwise be read as a flat and silently mangled.
    const affixSeen = new Set();
    for (const e of [...(rot.filler ?? []), ...(rot.active ?? []), ...(rot.triggered ?? []),
      ...(rot.passive ?? [])]) {
      const id = e.prof?.id;
      if (!id || affixSeen.has(id)) continue;
      affixSeen.add(id);
      if (e.prof.nature === 'Status') continue;
      for (const a of (e.affixes ?? e.prof.affixes ?? [])) {
        // Script-scaled magnitudes are not in the data; the reader that owns
        // those says so rather than guessing at one.
        if (!a.target?.attribute || a.mod?.dynVal) continue;
        // One stack, always: `BaseSkill.getAffixMultiplier@6189` returns 1, and
        // only `Status.getAffixMultiplier@15810` returns the stack count.
        applyAffix(a, 1, 1);
      }
    }

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
    // ...and a dependency some held node NAMES is not yet one this fight
    // applies. `statusesOf` can only ask whether a row in the build carries
    // the status; the rotation knows whether its applier has an event.
    // Adrenaline holds its buff by `enforceStatus(owner, <the buff>,
    // hasStatusApplied(owner, <Lethal Poison>))`, and it was credited for the
    // whole fight to a Rogue with no weapon (two doses of the three the gate
    // needs) and to one whose only applier is Toxic Miasmas' on-kill area -
    // builds the same output told "Lethal Poison: off in this build".
    const appliedInFight = (statusId) => (rot.dots ?? []).some((d) => d.status === statusId)
      || [...(rot.active ?? []), ...(rot.filler ?? [])]
        .some((e) => (e.applies?.target ?? []).some((x) => x.status === statusId));
    const talentOffGaps = [];
    for (const [id, rank] of Object.entries(loadout.talents ?? {})) {
      const v = talents.readableValue(id, rank, { have: allocated });
      for (const n of v.needs ?? []) talentDepGaps.push({ ...n, from: id });
      for (const a of v.affixes) applyAffix(a);
      for (const b of v.buffs) {
        const dep = b.trigger?.whileApplied ?? null;
        if (dep && !appliedInFight(dep)) {
          talentOffGaps.push({ from: id, name: b.name, needsName: cdb.byId('skill').get(dep)?.texts?.name ?? dep });
          continue;
        }
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
      armorIgnore: {}, bleed: {}, bleedScoped: [], cooldown: {},
      // A multiplier on BASIC attacks only - the three or four links of the
      // chain, never the combo finisher that ends it. The weapon-upgrade
      // double-attack proc is the only thing that writes it today.
      basicAttack: upgradeProcs.reduce((s, p) => s + p.chance, 0),
      // The behind perks, summed across both weapons - the game runs every
      // instance's hook into one additive bracket - and billed at the
      // assumed behind-fraction. 1.0 is the Shadowstep claim; the measured
      // dummy fraction was 0.68-0.85 for a player who repositions.
      basicAttackBehind: upgradeBehind.reduce((s, p) => s + p.damage, 0)
        * (assumeAll.behindFraction ?? 1),
    };
    // Armour a script takes off ONE skill's hits by name - the Censer's
    // rank-2 "Ignores [MagicArmor]" on its Ultimate, Infernal Plunge's own
    // rank-2 ignore. Keyed by the skill whose hits they are; `mitigate`
    // looks the cast's own row up. A `+=` adds, an `=` sets.
    for (const ai of rot.armorIgnores ?? []) {
      mods.armorIgnoreBySkill ??= {};
      const bag = (mods.armorIgnoreBySkill[ai.skill] ??= {});
      const slot = (bag[ai.root] ??= { add: 0, set: 0 });
      if (ai.set) slot.set = Math.max(slot.set, ai.amount);
      else slot.add += ai.amount;
    }
    // Modifiers whose scope this fight does not separate. Named, not dropped.
    const unreadMods = [];
    // WHAT RATE A SECONDS-PER-EVENT MODIFIER RIDES belongs to the skill whose
    // script carries it, not to the scope. The scope says who BENEFITS - "your
    // weapon skills" - while the source says how often it fires. `Red Tempo` is
    // a talent on bleed ticks; `Sword_Start_Combo` is `onFirstHit` on the
    // finisher, so its rate is the chain's finisher rate.
    //
    // The chain cadence is an ESTIMATE and named as one: the fight derives the
    // real rate by playing it, and this has to be known before the fight to set
    // the cooldowns it will play with. Sum of the chain's own occupancies, one
    // finisher per cycle and the rest swings.
    const chainCycle = (rot.filler ?? []).reduce((s, x) => s + Math.max(x.prof.occupancy, 0.05), 0);
    const perCombo = chainCycle > 0 ? 1 / chainCycle : 0;
    const perSwing = chainCycle > 0 ? Math.max(0, (rot.filler?.length ?? 1) - 1) / chainCycle : 0;
    const eventRate = (mod) => {
      const f = (rot.filler ?? []).find((x) => x.prof.id === mod.from);
      if (f) return f.prof.isCombo ? perCombo : perSwing;
      if (mod.scope === 'attack') return perSwing;
      const a = (rot.active ?? []).find((x) => x.prof.id === mod.from);
      if (a && a.prof.cooldown > 0) return 1 / a.prof.cooldown;
      return 0;
    };
    // The nodes you allocated, at the points in them - AND every skill the
    // rotation plays, at the weapon rank, because a skill's own script carries
    // these too and only talents were ever offered to the reader.
    //
    // ONLY the cooldown field comes through from a non-talent source. A skill's
    // dmgMult/critDmgMult riders are already read per-skill by `runeDamage`,
    // which applies them to THAT skill behind their live gate; letting them
    // through here credits them twice AND at scope 'all', across the whole
    // build. That read the Warrior 31% high.
    const modSources = [
      ...Object.entries(loadout.talents ?? {}).map(([id, r]) => [id, r, true]),
      ...[...new Set([...(rot.filler ?? []), ...(rot.active ?? []), ...(rot.triggered ?? []),
        ...(rot.passive ?? [])].map((e) => e.prof.id))].map((id) => [id, rank, false]),
    ];
    // Talent riders behind the TARGET'S HEALTH (Bullying the Weak). They join
    // the riders the owner carries for every hit, because that is what they
    // are - an onInflictDamageEval clause on a row nobody casts - and
    // castOutput answers the health comparison there against the stated
    // `--target-health`, the way it does for a skill's own execute clause.
    const healthRiders = [];
    const WHILE_TYPED_SCOPES = new Set(['attack', 'combo', 'attack-or-combo', 'weaponSkill', 'all']);
    for (const [id, nodeRank, asTalent] of modSources) {
      for (const mod of plan.talentModifiers(id, nodeRank, { asTalent })) {
        if (!asTalent && mod.field !== 'cooldownPerTick') continue;
        if (mod.targetHealth) {
          healthRiders.push({
            field: mod.field, amount: mod.amount, targetHealth: mod.targetHealth,
            types: mod.scope === 'weaponSkill' ? ['WeaponSkill', 'WeaponSubSkill']
              : mod.scope === 'attack-or-combo' ? ['Attack', 'Attack2', 'Attack3', 'Attack4', 'AttackCombo'] : null,
            affinity: mod.affinity ?? null,
            from: mod.from, name: mod.name, source: 'talent', ownerWide: true, talent: true,
          });
          continue;
        }
        // "...against a target wearing a status of type T", for a T that is
        // not a bleed. The bleed ones keep the accepted reading (credited
        // whole while the build runs a bleed at all - see `gates.bleeding`).
        // Any other type is a state the FIGHT holds - whether one of the
        // build's own statuses of that type is ticking at the swing - so the
        // rider goes to the fight with its type and is paid per event
        // (`whileTyped` in sim.mjs). Finish the Job was credited in full on a
        // build whose only dots were two bleeds.
        if (mod.targetBleeding && mod.targetType && !/^(?:Bleed|Hemorage)$/.test(mod.targetType)) {
          if ((mod.field === 'critChance' || mod.field === 'dmgMult') && WHILE_TYPED_SCOPES.has(mod.scope)) {
            (mods.whileTyped ??= []).push({
              field: mod.field, amount: mod.amount, scope: mod.scope, statusType: mod.targetType,
              from: mod.from, name: mod.name,
            });
          } else unreadMods.push(mod);
          continue;
        }
        const add = (bag, key) => { bag[key] = (bag[key] ?? 0) + mod.amount; };
        // A bleed-scoped modifier keeps the STATUS TYPE its guard named, so the
        // fight can apply Exsanguination (isStatusType(Hemorage)) to the
        // Hemorrhage pool and not to Bonethrow's plain-Bleed one. `Bleed` is
        // the parent type and covers both; the match is resolved per pool dot
        // in damage.mjs against the statusType sheet's parent chain.
        const scoped = (field) => mods.bleedScoped.push({
          statusType: mod.statusType ?? 'Bleed', field, amount: mod.amount,
        });
        // Routing is EXPLICIT, with no default. A scope this does not recognise
        // is dropped, not folded into "everything": `Rogue_Talent_LethalDose`
        // (Powerful Toxins) scopes its +20% to Poison damage, and while there
        // was no channel for a poison it had to contribute nothing rather
        // than +20% globally. (There is one now - the `dot:` branch below.)
        // A scope may cover more than one profile category: the finisher's
        // profile type is AttackCombo, and 'attack-or-combo' pays both halves.
        // So does 'weaponSkill' since build 25782799:
        // BaseSkill.isWeaponSkill@6161 ops 5-11 are `type == 7 || type == 8`,
        // WeaponSkill OR WeaponSubSkill (it was 7 alone), so a guard written
        // `dmg.isWeaponSkill` - Sever's +20% crit damage - now reaches the
        // recasts and the ultimates a weapon grants. Routed to type 7 only,
        // Anger Release, Hidden Power, Expulse and Blind Breakthrough's recast
        // took none of it.
        const types = mod.scope === 'attack' ? ['Attack']
          : mod.scope === 'combo' ? ['AttackCombo']
            : mod.scope === 'attack-or-combo' ? ['Attack', 'AttackCombo']
              : mod.scope === 'weaponSkill' ? ['WeaponSkill', 'WeaponSubSkill'] : null;
        const type = types?.[0] ?? null;
        if (mod.field === 'healShare' && mod.scope === 'bleed') { add(mods.bleed, 'healShare'); scoped('healShare'); }
        else if (mod.scope === 'bleed' && mod.field !== 'cooldownPerTick') { add(mods.bleed, mod.field); scoped(mod.field); }
        // A modifier scoped to a status type that is NOT a bleed. The reader
        // has always produced these correctly - `bench talents` prints
        // "+10% damage dot:Poison" for Rogue_Talent_LethalDose - and the router
        // then dropped them on the floor, because the only per-dot channel was
        // called `bleedScoped` and only pool dots read it. The scope names a
        // real statusType (`Poison` carries the DoT flag and twelve status rows
        // wear it), so it goes down the same channel with its own type and the
        // per-dot matcher walks the parent chain exactly as it already does.
        else if (mod.scope.startsWith('dot:') && mod.field !== 'cooldownPerTick') {
          mods.bleedScoped.push({
            statusType: mod.scope.slice(4), field: mod.field, amount: mod.amount,
          });
        }
        else if (mod.field === 'critDmgMult' && types) for (const t of types) add(mods.critDamageByType, t);
        else if (mod.field === 'critChance' && types) for (const t of types) add(mods.critChanceByType, t);
        else if (mod.field === 'dmgMult' && mod.scope === 'physical') add(mods.damageByAffinity, 'Physical');
        else if (mod.field === 'dmgMult' && mod.scope === 'magic') add(mods.damageByAffinity, 'Magic');
        else if (mod.field === 'dmgMult' && types) for (const t of types) add(mods.damageByAffinity, t);
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
        } else if (mod.field === 'cooldownPerTick') {
          // Every other source: seconds per event x events per second. The rate
          // comes from the SOURCE skill - see `eventRate`. A source the
          // rotation never plays has no rate and stays named rather than
          // credited, which is why this reads the resolved rotation.
          const r = eventRate(mod);
          if (r > 0) mods.cooldown.weaponSkillFlat = (mods.cooldown.weaponSkillFlat ?? 0) + mod.amount * r;
          else unreadMods.push(mod);
        } else if (mod.field === 'armorIgnore') add(mods.armorIgnore, 'Physical');
        else if (mod.field === 'magicArmorIgnore') add(mods.armorIgnore, 'Magic');
        // A rider naming ONE castable skill - Authority's +20% on Smite -
        // lands on exactly that row's casts, and a rider on every status tick
        // the OWNER CARRIES - Radiance's +25% - lands on the tickCarrierSelf
        // rows at the pricing site. Both were read correctly and then dropped
        // here for want of a channel; Smite read 20% low and all five of the
        // Priest's self-carried ticks 25% low, in one measurement each.
        else if (mod.field === 'dmgMult' && mod.scope === 'one-skill' && mod.skill) {
          mods.bySkill ??= {};
          mods.bySkill[mod.skill] = (mods.bySkill[mod.skill] ?? 0) + mod.amount;
        }
        else if (mod.field === 'dmgMult' && mod.scope === 'own-status-tick') {
          mods.ownStatusTick = (mods.ownStatusTick ?? 0) + mod.amount;
        }
        // A share of ONE NAMED ROW's damage handed back as healing (Soothing
        // Rays on Sunlight's hits): priced where that row's hits are, as the
        // bleed's share is priced where the bleed ticks.
        else if (mod.field === 'healShare' && mod.scope === 'one-skill' && mod.skill) {
          mods.healBySkill ??= {};
          mods.healBySkill[mod.skill] = (mods.healBySkill[mod.skill] ?? 0) + mod.amount;
          (mods.healBySkillFrom ??= []).push({ from: mod.from, step: mod.step, of: mod.skill, amount: mod.amount, name: mod.name });
        }
        else unreadMods.push(mod);
      }
    }
    if (healthRiders.length) evalOpts.ownerRiders = [...(evalOpts.ownerRiders ?? []), ...healthRiders];
    // The same test written in a CAST's own script (damage.mjs `typedGuard`:
    // Scorch's +25% critical chance against a burning target) goes the same
    // way, narrowed to the row whose hits it rides - or to every hit, for a
    // clause in an owner-wide hook. The fight pays it while a status of the
    // type stands; with none in the build it is paid nowhere.
    for (const e of [...(rot.active ?? []), ...(rot.filler ?? [])]) {
      for (const rd of e.prof.runeDamage ?? []) {
        if (rd.gate !== 'typed' || rd.ownerWide) continue;
        (mods.whileTyped ??= []).push({
          field: rd.field, amount: rd.amount, scope: 'row', row: e.prof.id, statusType: rd.statusType,
          from: e.prof.id, name: e.prof.name,
        });
      }
    }
    for (const rd of rot.ownerRiders ?? []) {
      if (rd.gate !== 'typed') continue;
      (mods.whileTyped ??= []).push({
        field: rd.field, amount: rd.amount, scope: 'all', statusType: rd.statusType, from: rd.from, name: rd.name,
      });
    }
    // The bleed's tick interval is what turns seconds-per-proc into a rate, and
    // it is only known once the rotation is resolved.
    if (mods.cooldown.weaponSkill) {
      const tickInterval = (rot.dots ?? []).find((d) => d.pool)?.tick ?? 0;
      mods.cooldown.weaponSkill /= tickInterval;
    }
    // The non-bleed sources were already turned into seconds-per-second by
    // their own rate, so they only have to join the same total.
    if (mods.cooldown.weaponSkillFlat) {
      mods.cooldown.weaponSkill = (mods.cooldown.weaponSkill ?? 0) + mods.cooldown.weaponSkillFlat;
      delete mods.cooldown.weaponSkillFlat;
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
    // ...and a self status an attached infusion applies on an event the fight
    // raises, priced by this same pass and the same uptime rules. `selfBuffs`
    // returns a fresh list, so nothing here reaches the cached rotation.
    for (const b of infusion.buffs) if (!buffs.some((x) => x.status === b.status)) buffs.push(b);

    // A SCRIPTED `dmgMult` IS NOT A SHEET STAT. `skills.mjs` turns an
    // unconditional `hit.dmgMult += vars.n` into a `TAttribute_Flat
    // DamageModifier` row so the buff, its uptime and its place in the fight
    // all come for free - but DamageModifier MULTIPLIES in `castOutput`, and
    // `computeDamage@4920` says these riders SUM. Berserk at +0.20 beside
    // Domination at +0.25 has to read 1.45, not 1.20 x 1.25 = 1.50, and the
    // capture's one deterministic double-rider hit picks 1.45 to -0.23%.
    //
    // So they are diverted here into the additive rider channel, at the same
    // uptime the sheet would have given them. `critDmgMult` rows are left
    // alone: `ctx.critDmgMult` really does start at atbVal(CritDamage) and
    // compose the way the sheet's CritDamage does.
    const isScriptDmgMult = (a) => a.fromScript && a.target?.attribute === 'DamageModifier';
    const scriptDmgMult = (b, uptime) => {
      let s = 0;
      for (const a of b.affixes) if (isScriptDmgMult(a)) s += ((a.val ?? 0) / 100) * b.stacks * uptime;
      return s;
    };
    const timed = [];
    const conduitBuffGaps = [];
    const conduitRamps = [];
    // The two rows that must keep folding in permanent at the cap. Named by id
    // rather than by shape, because every shape-based gate catches something
    // else: "chance < 1" also catches Staff_SummonDemon's rank-3 buff and "is a
    // Passive" catches the trinket Stones. The cost of leaving these two frozen
    // is measured - under 1% of the cap in a filler-heavy fight, up to ~40% at a
    // quarter swing clock - and it is in the audit.
    const FROZEN_ENCHANTS = new Set(['Enchant_Zealot_Status', 'Enchant_Devote_Status']);
    // A rough swing cadence, for the DISPLAY sheet only. The fight derives the
    // real rate by raising the event; this is what the averaged column shows,
    // and it is an estimate rather than a claim.
    const swingPeriod = rot.filler?.length
      ? rot.filler.reduce((s, x) => s + Math.max(x.prof.occupancy, 0.05), 0) / rot.filler.length
      : 2;
    // THE STANDING SHEET STOPS HERE. Everything accumulated so far - gear,
    // WeaponPower, upgrade riders, permanent affix rows, talents - is on the
    // sheet the game shows out of combat. Everything the loop below adds is a
    // STATUS a skill applies, and a status is only up once something applied
    // it. Folding those into the sheet `bench verify` checks against the
    // game's own standing arithmetic read every Devote enchant as +30
    // FervorRating of model error - the fight was right to price it, and the
    // character sheet was wrong to show it.
    const standFlat = new Map(inject);
    const standAddRatio = new Map(addRatio);
    const standMulRatio = new Map(mulRatio);
    // With the chain held, a status that has a duration and is not the status
    // of one of the build's own PRESSES is priced as down. What the rule was
    // written for has nothing to apply it: Brutal Frenzy comes off the
    // finisher, Devote and the Raclette Pan off a base attack's hit. Folding
    // those in "permanent at the cap" priced every isolated press of the
    // 2026-10-13 Warrior blocks 12.9% high - (1 + 0.071 + 0.12) over
    // (1 + 0.055), the bracket of a chain nobody swung. A status with no
    // duration is an aura the character wears and stays.
    //
    // IT REACHES FURTHER THAN WHAT ONLY A SWING APPLIES, and there it is a
    // floor (the audit: "with the chain held ..."). The test is who the
    // status is FROM, so one a press can raise without owning is priced down
    // with the rest: a proc on any damage instance (Stone of Righteousness:
    // `onInflictDamage`, 5%, no base-attack guard), a conduit's buff
    // (Conduit: Power: `onStartConduit` - the branch below that ramps it is
    // never reached), a passive answering a weapon skill (Swarm Lord's Hive
    // Swarm: `onSkillProc`). The rows of the 2026-10-13 lone-press blocks
    // hold the first two standing. Every row taken down here is marked
    // (`heldDown`), so a ledger can name what it priced without.
    const pressable = holdChain ? new Set((rot.active ?? []).flatMap((x) => [x.prof.id, x.via].filter(Boolean))) : null;
    for (const b of buffs) {
      const src = combat.profile(b.from, rank, new Set(rot.runes ?? []));
      const cd = src?.cooldown ?? 0;
      const dur = b.duration;
      // (The rows are shared between evaluations: the mark is set either way.)
      b.heldDown = !!(pressable && dur > 0 && !pressable.has(b.from));
      if (b.heldDown) {
        b.uptime = 0;
        b.timed = false;
        continue;
      }
      // A PROC-APPLIED self-buff: no cooldown behind it, applied from a damage
      // hook, and either rolled or blocked while it is already up. Those are the
      // ones the blanket "no cooldown, so it is permanent at the cap" reading
      // gets wrong in the flattering direction - and the four trinket Stones
      // were not even getting that, they were refused outright.
      const procHook = /^on(InflictDamage|InflictHit|Damage|Hit)$/.test(b.trigger?.hook ?? '');
      const isProc = dur > 0 && !(cd > 0) && procHook && !FROZEN_ENCHANTS.has(b.status)
        && ((b.trigger?.chance ?? 1) < 1 || b.reapply === 'blocked');
      if (isProc) {
        // The swing clock is a FLOOR on an onInflictDamage proc's rate: the
        // hook rolls on EVERY damage instance - every dot tick, every cast
        // hit - and Emsei's live stream runs 5.8 instances a second where
        // her swing clock says 0.11, which priced the Stone's +10 Faith at
        // uptime 0.53 against a measured 0.755. Estimate the instance rate
        // from what the plan already knows: swings, every active's casts
        // per cooldown, every dot's tick clock. Still a pre-fight estimate,
        // still BELOW live (folded riders and procs are uncounted), so the
        // flattering direction stays refused.
        const instRate = b.trigger?.hook === 'onInflictDamage'
          ? (1 / swingPeriod)
            + (rot.active ?? []).reduce((s2, a) => s2 + (a.prof.cooldown > 0 ? 1 / a.prof.cooldown : 0), 0)
            + (rot.dots ?? []).reduce((s2, d) => s2 + (d.tick > 0 ? 1 / d.tick : 0), 0)
          : (1 / swingPeriod);
        const r = Math.max(1e-9, instRate * (b.trigger?.chance ?? 1));
        // Blocked-while-up is an ALTERNATING RENEWAL process - on for its whole
        // duration, then off until the next success - so its uptime is
        // rD/(1+rD) and it NEVER saturates: 34% at one damage instance a
        // second, 72% at five. Refresh-and-stack is 1 - e^(-rD), which does
        // saturate. Reading one as the other is a third of the answer.
        //
        // This is a CLOSED FORM and not an event in the fight, deliberately.
        // The fight thins applications deterministically - one every 1/p
        // events, evenly spaced - and even spacing is not a renewal process:
        // for a blocked buff whose duration is near the mean gap, regular
        // arrivals give ~95% uptime where the real geometric process gives
        // ~49%. That is the flattering direction, which is the one to refuse.
        // Both forms are Monte-Carlo checked against the game's own semantics.
        b.uptime = b.reapply === 'blocked'
          ? (r * dur) / (1 + r * dur)
          : 1 - Math.exp(-r * dur);
        b.timed = false;
        b.proc = { chance: b.trigger?.chance ?? 1, blocked: b.reapply === 'blocked', rate: r };
        for (const a of b.affixes) applyAffix(a, b.stacks, b.uptime);
        continue;
      }
      // A buff applied ONCE PER CONDUIT TRIGGER follows the conduit economy,
      // and the cap is a RAMP rather than a state: one stack per trigger, so
      // reaching 20 takes 20 triggers of uninterrupted fighting. Both ends are
      // measured - a dummy fight reaches the full twenty and stands there
      // (2026-08-12), while the capture's real 15-20s pulls die at 1-4 stacks
      // (2026-08-02, three windows, peaks 2/1/4). Neither the old refusal (0)
      // nor crediting the cap outright describes that; the mean over the fight
      // does, and `conduitStacks` carries it - measured on a first pass by
      // `evaluate`, because only the fight knows how often this build spends
      // Spark from above the gauge.
      if (dur > 0 && !(cd > 0) && b.trigger?.hook === 'onStartConduit') {
        const chained = (evalOpts.empowerments ?? []).some((e2) => e2.chainSpend);
        const mean = chained ? null : (conduitStacks?.get(b.status) ?? null);
        if (!chained && mean == null) {
          // First pass, or a build whose conduits never fire: refuse, and tell
          // the wrapper there is a ramp here worth measuring.
          b.timed = false;
          b.uptime = 0;
          conduitBuffGaps.push({ id: b.status, from: b.from, stacks: b.stacks, duration: dur });
          continue;
        }
        if (!chained) {
          // Priced at the fight's own mean. The affix is FLAT MagicMastery and
          // damage is linear in it - it sits inside the additive (1 + fervor +
          // mastery) bracket - so a fight played at a rising stack count and a
          // fight played at the mean deal the same total, exactly, as long as
          // damage is spread evenly over the clock. It is not perfectly even
          // (cooldowns land early, when the ramp is still low), so this reads
          // slightly HIGH on a build that front-loads; the residual is bounded
          // by the ramp's share of the fight and is named in the audit.
          // Deliberately not written to `b.stacks`: the rotation - and these
          // buff objects with it - is cached across evaluations, so the scale
          // stays local to this fold.
          b.timed = false;
          b.uptime = 1;
          mods.damageByAffinity.all = (mods.damageByAffinity.all ?? 0) + scriptDmgMult(b, 1);
          for (const a of b.affixes) if (!isScriptDmgMult(a)) applyAffix(a, mean, 1);
          conduitRamps.push({ id: b.status, from: b.from, cap: b.stacks, mean, duration: dur });
          continue;
        }
        // falls through: permanent at cap, like the live stream says.
      }
      b.uptime = (cd > 0 && dur > 0) ? Math.min(1, dur / Math.max(cd, src.occupancy)) : 1;
      // ...unless its press hands it out only at a count of ready prayers
      // (Spirited Disciple). How often that count is met is the fight's to
      // say, press by press, and duration over cooldown is not it: the
      // AVERAGED sheet leaves the status out - a floor on that display and on
      // the pool-dot multipliers that read it - while the fight puts it up on
      // the presses that earn it.
      // (One no press of the fight could hand out - no cooldown behind it -
      // is simply never up; it must not fall through to "permanent".)
      if (b.trigger?.readyPrayers) {
        b.uptime = 0;
        if (!(cd > 0 && dur > 0)) { b.timed = false; continue; }
      }
      b.timed = cd > 0 && dur > 0;
      if (b.timed) timed.push(b);
      else {
        mods.damageByAffinity.all = (mods.damageByAffinity.all ?? 0) + scriptDmgMult(b, 1);
        for (const a of b.affixes) if (!isScriptDmgMult(a)) applyAffix(a, b.stacks, 1);
        // A status with NO duration is an aura you wear, not a state you
        // enter: the Boomerang's crit aura is applied by wielding the axe and
        // never expires, and the game's standing sheet shows it. A status with
        // a duration - Devote's 15-second stacks - exists only once combat
        // applies it, however permanent the fight makes it. Duration is the
        // split, and it is the game's own.
        if (!(dur > 0)) {
          for (const a of b.affixes) {
            if (isScriptDmgMult(a)) continue;
            const atb = a.target?.attribute;
            const kind = ctx.affix.kindOf(a.ref);
            if (!atb || !kind) continue;
            if (kind === 'flat') standFlat.set(atb, (standFlat.get(atb) ?? 0) + (a.val ?? 0) * b.stacks);
            else if (kind === 'addRatio') standAddRatio.set(atb, (standAddRatio.get(atb) ?? 0) + (a.val ?? 0) * b.stacks);
            else standMulRatio.set(atb, ctx.affix.composeMul(a.ref, standMulRatio.get(atb) ?? 1, a.val ?? 0));
          }
        }
      }
    }

    // TWO STATUSES A TIMER SWAPS, from an attached infusion (Balance of
    // Justice: +5 PhysicalMastery, then +5 MagicMastery, ten seconds each).
    // One is up at any time and never both, so each is on the fight's sheet
    // at the share of THIS fight's length it holds - scheduled from the
    // script's own start, not halved - and not on the standing sheet, which
    // is out of combat where the script takes both off.
    for (const b of infusion.fight.alternating) {
      const share = infusionPlan.alternatingShare(b.alternates, evalOpts.fight ?? opts.fight);
      for (const a of b.affixes) applyAffix(a, b.stacks ?? 1, share);
    }

    // The sheet the FIGHT starts from: everything permanent, nothing timed.
    const combatBase = evaluateLoadout(cat, loadout, {
      baseStatsFor, injectFlat: inject, injectAddRatio: addRatio, injectMulRatio: mulRatio, force,
    });
    // A status its own build EXTENDS while it runs lasts longer than the row
    // says. Battle Fury (`Warrior_BattleShout_M1`) adds 0.25s to Battle Shout
    // on every critical strike you deal, so the fifteen seconds the row
    // declares are not the fifteen seconds a critting build gets.
    //
    // While the buff is up it loses one second per second and gains `e`, so the
    // effective duration is D/(1-e) - a closed form, and the same shape as the
    // renewal uptimes above. The rate is the DISPLAY swing cadence, which is a
    // FLOOR: a multi-hit cast and a bleed tick both raise onInflictDamage and
    // are not counted, so the real extension is at least this. The crit
    // fraction comes off the permanent sheet, which excludes the buff's own
    // CritChance - the feedback loop is real and crediting it here would be the
    // flattering direction.
    for (const b of timed) {
      if (!b.extend || !(b.duration > 0)) continue;
      const src = combat.profile(b.from, rank, new Set(rot.runes ?? []));
      const cd = src?.cooldown ?? 0;
      if (!(cd > 0)) continue;
      const crit = Math.min(1, Math.max(0, (combatBase.sheet.get('CritChance') ?? 0) / 100));
      const rate = (1 / swingPeriod) * (b.extend.critOnly ? crit : 1);
      const e = rate * b.extend.amount;
      // e >= 1 means the build adds time faster than the status spends it, so
      // it never drops once it is up. That is a real answer, not an overflow.
      // `b.duration` is READ here and never written. These buff objects come
      // out of statusCache by reference and outlive the call - the same
      // aliasing the `b.stacks` fold above refuses - so `b.duration = dur`
      // fed its own output back in and compounded the extension by 1/(1-e)
      // on every later evaluation. Battle Shout's only affix is CritChance
      // 20, so a warm engine handed a Warrior build a growing crit bonus:
      // 15s of buff became 245s over 25 identical calls, uptime 0.14 -> 1.00,
      // averaged crit 37 -> 54, dps +14.8%. Within one `optimize` or `rank`
      // that is worse than a wrong number, because every candidate is scored
      // on the same engine and the later ones are enumerated into a bigger
      // bonus - the search was ranking by evaluation order. The extended
      // value lives in `b.extended.to`, which is what the fight reads.
      const dur = e >= 1 ? Math.max(cd, src.occupancy) : b.duration / (1 - e);
      b.extended = { from: b.duration, to: dur, rate, perEvent: b.extend.amount, permanent: e >= 1 };
      b.uptime = Math.min(1, dur / Math.max(cd, src.occupancy));
    }

    // Snapshot the three accumulators HERE, while they still hold only the
    // permanent layer. The averaged sheet below folds every timed buff into
    // these same maps at its uptime, and `restat` - which re-prices a cast
    // while a buff is actually up - used to copy them at CALL time, i.e. after
    // that mutation. So the moment any window opened, the fight priced casts
    // against base + every timed buff at its uptime + the one that is up, and
    // pressing a buff that does nothing for damage at all was worth 3.4%
    // because it switched pricing onto the inflated sheet. The rotation search
    // found it by putting `Ignore Pain` - zero damage, a DamageTakenModifier
    // and nothing else - at the top of the priority list.
    const baseFlat = new Map(inject);
    const baseAddRatio = new Map(addRatio);
    const baseMulRatio = new Map(mulRatio);

    // ...and the sheet averaged over the fight, with the timed buffs folded in
    // at their uptime. That is a useful number and it is NOT the character
    // sheet: a level-25 Warrior with no gear reads 5.8% crit in game, and this
    // one read 8.3% because Battle Shout's +20 CritChance on a 120-second
    // cooldown was averaged in at 12.5% uptime. Anyone comparing the tool to
    // their own character sheet was comparing against a different question.
    //
    // So both are computed and both are reported: `sheet` is what the game
    // shows you standing still, `averaged` is what the fight sees.
    // What the game shows you standing still: the pre-status accumulators.
    // `combatBase` keeps the permanent statuses at cap - that is what the
    // FIGHT prices against, and the entire value of an enchant slot - but it
    // is not the character sheet, and reporting it as one made every
    // always-on status read as sheet error.
    const standing = evaluateLoadout(cat, loadout, {
      baseStatsFor,
      injectFlat: standFlat,
      injectAddRatio: standAddRatio,
      injectMulRatio: standMulRatio,
      force,
    });
    const resting = { ...combatBase, sheet: standing.sheet };
    for (const b of timed) {
      mods.damageByAffinity.all = (mods.damageByAffinity.all ?? 0) + scriptDmgMult(b, b.uptime);
      for (const a of b.affixes) if (!isScriptDmgMult(a)) applyAffix(a, b.stacks, b.uptime);
    }
    const averaged = evaluateLoadout(cat, loadout, {
      baseStatsFor, injectFlat: inject, injectAddRatio: addRatio, injectMulRatio: mulRatio, force,
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
      const f2 = new Map(baseFlat), a2 = new Map(baseAddRatio), m2 = new Map(baseMulRatio);
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
        baseStatsFor, injectFlat: f2, injectAddRatio: a2, injectMulRatio: m2, force,
      }).sheet;
      restatCache.set(key, hit);
      return hit;
    }
    // THE FIGHT'S VIEW OF THE ROTATION: the cached one, with what the attached
    // infusions do in a fight appended - a status that ticks, a step played
    // on an event, a debuff an event stacks on the foe, a cast a counter arms
    // (infusion.mjs `fightOf`). Every part was read at ITS SET's rank and
    // carries a profile priced at that rank; the view is built per evaluation
    // and handed to the fight alone, so `rot`, its cache and every reader
    // above that walks it at the weapon's rank never meet an infusion.
    //
    // `castEvents` is what each cast of the build lands on the foe beyond its
    // damage, for the parts that ride it: the crowd controls it ATTEMPTS, by
    // status (the one reader, `crowdControlOf`, minus what it holds but the
    // fight cannot count), and the knockbacks: one per effect of the cast
    // that authors `sideEffects.knockBack` with a force. No unit row authors
    // KnockResistance (attribute 19, what getKnockRatio@4589 subtracts), so a
    // knock is counted on any target. One per effect and one per control,
    // however many hits carry it: a floor - and kept one by leaving out the
    // entries that author NO force (`noForce`, counted apart so the build can
    // be told how many): whether the hook is raised for a knock that moves
    // nothing is the server's to say (see `knockNoForce` in damage.mjs).
    //
    // `foeRefuses` is which of the build's statuses THIS target turns away
    // (`plan.refusalOf`: crowd control on one that is immune to it, a stun on
    // one that refuses stuns), asked of every status the fight can land - a
    // control, a debuff a cast sets up, a dot, a set's stacking debuff. An
    // attempt is still an attempt; a refused status is not a status landed,
    // through whichever of those the fight would have counted it. A control a
    // cast ALSO holds as its own debuff (a rune's slow with a MoveSpeedFactor
    // row) is the same one application, and the fight sorts that out.
    //
    // The refusals are asked for EVERY build, not only one that wears a set:
    // the fight opens the window of a debuff a cast sets up, and Gash counts
    // the windows that stand. Without the answer a plain Rogue's Hunter Net
    // was a status on a Boss that refuses it. (A build nothing is refused of
    // keeps the rotation object it had.)
    const fightRot = (() => {
      const f = infusion.fight;
      const castEvents = new Map();
      const foeRefuses = new Set();
      const judge = (statusId) => { if (statusId != null && plan.refusalOf(statusId, tgt)) foeRefuses.add(statusId); };
      if (!f.any) {
        for (const e of [...rot.active, ...rot.filler, ...(rot.triggered ?? [])]) {
          for (const d of e.applies?.target ?? []) judge(d.status);
        }
        return foeRefuses.size ? { ...rot, foeRefuses } : rot;
      }
      const ccOf = new Map(ccAll.map((e) => [e.prof, e.cc.filter((c) => !c.unpriced)]));
      for (const e of [...rot.active, ...rot.filler, ...(rot.triggered ?? [])]) {
        for (const d of e.applies?.target ?? []) judge(d.status);
        const cc = (ccOf.get(e.prof) ?? []).map((c) => c.status);
        cc.forEach(judge);
        const knock = (e.prof.effects ?? []).filter((x) => x.knockBack).length;
        const noForce = (e.prof.effects ?? []).filter((x) => x.knockNoForce).length;
        if (!cc.length && !knock && !noForce) continue;
        castEvents.set(e.prof.id, { cc, knock, noForce });
      }
      for (const d of [...(rot.dots ?? []), ...f.dots]) if (d.to !== 'Self') judge(d.status);
      for (const fd of f.foeDebuffs) judge(fd.status);
      return {
        ...rot,
        triggered: [...(rot.triggered ?? []), ...f.triggered],
        dots: [...(rot.dots ?? []), ...f.dots],
        foeDebuffs: f.foeDebuffs, eventProcs: f.eventProcs, castEvents, foeRefuses,
      };
    })();
    const tp = combat.throughput(fightRot, combatBase.sheet, tgt, evalOpts,
      { restat, timedBuffs: timed, averagedSheet: averaged.sheet, mods, policy, goal });
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
      // Priced, not refused - but a mean is still an assumption, so it is
      // stated rather than left to be discovered.
      ...conduitRamps.map((g) => ({
        id: g.id,
        source: 'conduit',
        kind: 'assumption',
        why: `it stacks to ${g.cap} over ${g.duration}s, one stack per conduit trigger, so the cap `
          + 'is a ramp rather than a state. Priced at this fight\'s own mean of '
          + `${g.mean.toFixed(1)} of ${g.cap} stacks, measured from the trigger cadence the fight `
          + 'reports. Both ends are checked in game: a dummy fight reaches the full twenty and '
          + 'stands there, the capture\'s 15-20s pulls die at 1-4. The mean is exact for a flat '
          + 'affix as long as damage is spread evenly over the clock; a build that front-loads its '
          + 'cooldowns spends its opening at a lower stack count than this, so on those it reads '
          + 'slightly high',
      })),
      ...conduitBuffGaps.map((g) => ({
        id: g.id,
        source: 'conduit',
        kind: 'no rate',
        why: `it stacks to ${g.stacks} over ${g.duration}s, one stack per conduit trigger - so the `
          + 'cap is a RAMP, not a state: conduits fire about every 2.6s (the fight\'s own rate, and '
          + `the capture's refresh gaps agree), which is ~${Math.round(g.stacks * 2.6)}s of `
          + 'uninterrupted fighting to reach the cap. Both ends were measured in game: a dummy fight '
          + 'reaches the full twenty and stands at it, while the capture\'s real pulls (15-20s) die '
          + 'at 1-4 stacks. Pricing the mean needs the stack counter on the affix side, so it is '
          + 'refused rather than guessed - which UNDERSTATES a long fight, the opposite of the old '
          + 'cap-crediting error',
      })),
      ...talentDepGaps.map((g) => ({
        id: g.from,
        source: 'talent',
        why: `its effect lands only while ${g.needsName} is up, and nothing in this build applies that`,
      })),
      ...talentOffGaps.map((g) => ({
        id: g.from,
        source: 'talent',
        kind: 'off in this build',
        why: `${g.name} is held only while ${g.needsName} is on an enemy, and nothing this fight fires `
          + `applies ${g.needsName} - see its own entry for what the build is missing`,
      })),
    ];
    // ...and what each attached infusion's fight parts came to: a sentence on
    // the set, and a line for a part this build never raised the event for.
    extraGaps.push(...infusion.gaps, ...infusionPlan.settle(infusion, tp));
    // A CAST ARMED BY WALKING INTO WHAT A PASSIVE DROPS is priced on an input
    // (`assume.pickupShare`), and a build that holds one is told so beside
    // its number - not only under --verbose: the line it buys can be what
    // puts the weapon on the build at all. The sentence carries the line's
    // own size, so the reader can see what rides on the input.
    for (const sp of stackProcs) {
      if (sp.on !== 'timer' || !sp.drop) continue;
      const line = tp.lines.find((l) => l.postHoc && l.source === sp.from);
      const row = cdb.byId('skill').get(sp.from);
      const share = Math.max(0, Math.min(1, assumeAll.pickupShare ?? 1));
      const spot = sp.drop.from != null && sp.drop.to != null ? `, ${sp.drop.from} to ${sp.drop.to} units from you` : '';
      const stays = sp.drop.lasts != null ? `, and lies there ${sp.drop.lasts}s` : '';
      const casts = line && line.interval > 0 ? Math.round(tp.elapsed / line.interval) : 0;
      extraGaps.push({
        id: sp.from, name: row?.texts?.name ?? sp.from, source: 'script', kind: 'assumption',
        // What the build's short form prints: the input, its flag, its size.
        input: {
          flag: '--pickups', value: share,
          says: `${line?.name ?? row?.texts?.name ?? sp.from} is `
            + (line ? `${(line.total.damage / tp.elapsed).toFixed(1)} dps (${casts} cast${casts === 1 ? '' : 's'})` : 'nothing')
            + ` on walking into ${share === 1 ? `every ${sp.drop.step.toLowerCase()}` : `${Math.round(share * 100)}% of the ${sp.drop.step.toLowerCase()}s`} `
            + `its passive drops - --pickups <0..1> states the share you collect`,
        },
        why: `${row?.texts?.name ?? sp.from} is armed by ${sp.cap} pickups, and the passive drops one every ${sp.drop.every}s of combat at a `
          + `random spot${spot}${stays}. Whether you reach it is not in the data: this fight takes `
          + `${share === 1 ? 'every one as collected the moment it lands' : `${Math.round(share * 100)}% of them as collected`} `
          + `(--pickups ${share}), bills no step toward it and no press for the cast - `
          + (line ? `${(line.total.damage / tp.elapsed).toFixed(1)} dps of this build` : 'which comes to no cast in this fight')
          + '. --pickups <0..1> prices the share you collect',
      });
    }
    // A talent rider that waits for a status TYPE on the target (`whileTyped`:
    // Finish the Job against a poisoned one) and finds no status of that type
    // anywhere in the fight - the rotation's dots or an attached set's - is
    // read and worth nothing here. The fight drops it without a word, which
    // left two points in the node moving no number and no line saying why.
    //
    // Is one of a status's types the type a guard names, its parents walked -
    // the statusType sheet's chain, as hasStatusFlag and isType walk it.
    const typeParentOf = new Map(cdb.lines('statusType').map((r) => [r.id, r.parent ?? null]));
    const typeCovers = (guardType, types) => (types ?? []).some((t) => {
      for (let cur = t, hops = 0; cur != null && hops < 8; cur = typeParentOf.get(cur) ?? null, hops++) {
        if (cur === guardType) return true;
      }
      return false;
    });
    {
      const said = new Set();
      for (const r of mods.whileTyped ?? []) {
        if (r.scope === 'row' || said.has(r.from)) continue;      // a cast's own clause is said with its cast
        if ((fightRot.dots ?? []).some((d) => typeCovers(r.statusType, d.types))) continue;
        said.add(r.from);
        extraGaps.push({
          id: r.from, name: r.name, source: 'talent', kind: 'off in this build',
          why: `${r.name} is read, and worth zero here: ${r.field} +${r.amount} while the target wears a `
            + `${r.statusType} status, and nothing in this build applies one`,
        });
      }
      // The same silence, one reader over: a rider on a status's OWN hits
      // that counts the statuses of a type on the target (`per-typed`: Intent
      // to Kill, +x on every periodic hit per Poison there). The plan hands it
      // on whatever the build applies, because a set can put the one status of
      // the type on the foe (Hive Venom); with none on the foe in the whole
      // fight it multiplies every periodic hit by a count of zero. On the foe:
      // a status the owner wears is not on the target of the hit.
      for (const r of rot.dotRiders ?? []) {
        if (said.has(r.from)) continue;
        if ((fightRot.dots ?? []).some((d) => d.to !== 'Self' && typeCovers(r.statusType, d.types))) continue;
        said.add(r.from);
        extraGaps.push({
          id: r.from, name: r.name, source: plan.typeOf(r.from) === 'Talent' ? 'talent' : 'script', kind: 'off in this build',
          why: `${r.name} is read, and worth zero here: +${r.amount} damage on every periodic hit for each `
            + `${r.statusType} status on the target, and nothing in this build puts one there`,
        });
      }
    }
    // A health-gated talent rider that is READ and switched off by the stated
    // health says so, for the reason the same line is said about a skill's
    // own execute clause below: a node that buys nothing at the default full
    // health is otherwise taken for a node the model cannot read.
    {
      const said = new Set();
      for (const hr of healthRiders) {
        const th = hr.targetHealth;
        const on = th.op === '<=' ? targetHealth <= th.threshold
          : th.op === '<' ? targetHealth < th.threshold
            : th.op === '>=' ? targetHealth >= th.threshold : targetHealth > th.threshold;
        if (on || said.has(hr.from)) continue;
        said.add(hr.from);
        const all = healthRiders.filter((x) => x.from === hr.from);
        extraGaps.push({
          id: hr.from, name: hr.name, source: 'talent', kind: 'off at this target health',
          why: `${hr.name} is READ and worth zero here: `
            + all.map((x) => `${x.field} +${x.amount}${x.affinity ? ` on ${x.affinity} hits` : ''}`).join(', ')
            + `${hr.types?.includes('WeaponSkill') ? ' of your weapon skills' : hr.types ? ' of your attacks' : ''} while the target is ${th.op} `
            + `${+(th.threshold * 100).toFixed(2)}% health. You stated ${+(targetHealth * 100).toFixed(2)}%, so it `
            + `never fires - --target-health ${+(th.threshold * 100).toFixed(2)} prices the window it is for`,
        });
      }
    }
    for (const u of unreadMods) {
      // A PER-COUNT rider on one named skill earns its own sentence. The amount
      // is right there in the row and so is the skill it names; the only
      // missing half is how many stacks the target carries when the cast lands.
      // "A category this fight does not separate" points the reader at the
      // wrong problem, and the thing it replaced - a flat first term booked as
      // the whole rider, with nothing anywhere marking it a guess - was worse
      // than either.
      if (u.scope === 'one-skill-per-count') {
        extraGaps.push({
          id: u.from, name: u.name, source: 'talent', kind: 'rider not read',
          why: `${u.name} multiplies ${u.skillName} by ${u.amount} PER \`${u.countExpr}\`, `
            + 'and that count is live state this reader cannot answer. It used to be priced at a '
            + 'flat one of those, which read low by the whole count',
        });
        continue;
      }
      extraGaps.push({
        id: u.from, source: 'talent',
        why: `it modifies ${u.field} for ${u.scope} damage, which is a category this fight does not separate`,
      });
    }
    // A CLAUSE REFUSED ON A SKILL THE MODEL DOES SCORE. The unscored list is
    // per-SKILL, so a refusal inside an accounted skill lands nowhere: the
    // damage is right, one line of the script is worth zero, and nothing says
    // so. `GS_Nova_Combo` is the case - the greatsword finisher is scored every
    // cycle, and its rank-3 `reduceWeaponsCooldown(1.5)` is gated on
    // `hasStatusMaxStacked`, correctly refused, and previously silent. Live
    // weapon cooldowns run faster than modelled because of it.
    //
    // A SUMMONER is asked too, whichever bucket it is in or none. A passive
    // whose worth is its pets' exists only as `rot.summons[].from` - Mad Buzz
    // is in no list here - so a clause the gap reader DOES name about it (its
    // bees' +50% under Brood Leap's status) was dropped by this loop never
    // asking. A row the loop already walks is not asked twice.
    const ownCcRiders = [];   // { prof, rd }: a scored cast's own clause behind the cc gate
    const gapAsked = new Set([...(rot.filler ?? []), ...(rot.active ?? []), ...(rot.triggered ?? []),
      ...(rot.passive ?? [])].flatMap((e) => [e.prof.id, e.via]).filter(Boolean));
    const summonSources = [...new Set((rot.summons ?? []).flatMap((sp) => [sp.from, sp.host]))]
      .filter((id) => id && !gapAsked.has(id))
      .map((id) => ({ prof: { id, name: cdb.byId('skill').get(id)?.texts?.name ?? id }, summonOnly: true }));
    for (const e of [...(rot.filler ?? []), ...(rot.active ?? []), ...(rot.triggered ?? []),
      ...(rot.passive ?? []), ...summonSources]) {
      // ...and the HOST of a grafted entry, not only the row that was grafted.
      // A skill whose own payload is empty is rescued into the rotation under
      // its STATUS's id, so reading gaps off `prof.id` alone never asks the
      // host script anything. On the accepted build `Heat Emission` entered as
      // `Scepter_Flamie_Skill1_Shield` and was silent in BOTH directions at
      // rank 3: no damage line, and no gap line either, while its script
      // started a row worth 8,633 hits in the capture. (Build 25782799 gave it
      // a Burst step of its own, which the fight prices under the skill's own
      // id; the rule stays for the next row grafted that way.) `via` is the
      // host, and it has been on the entry all along.
      //
      // ...and the host of a SCRIPT-PLAYED STEP, which is in the rotation
      // only as `<host>#<step>`: a passive whose whole payload is a step its
      // script plays (Nectar-infused Blade) is in no bucket under its own
      // id, so a clause the gap reader names about it was never asked for.
      // Once per host, however many of its steps ride.
      const riderHost = e.source === 'scripted' && String(e.prof.id).includes('#')
        ? String(e.prof.id).split('#')[0] : null;
      const askHost = riderHost && !gapAsked.has(riderHost) ? riderHost : null;
      if (askHost) gapAsked.add(askHost);
      for (const gapOf of [...new Set([e.prof.id, e.via, askHost].filter(Boolean))])
      for (const g of plan.scriptGapsOf(gapOf, rank, { runes: new Set(rot.runes ?? []) })) {
        // A clause the SUMMON SPEC consumed is read, not a gap: the Almaz's
        // `critChance += vars.var2` behind `instigatorUnit?.kind ==
        // Unit.Summon_Imp` is on the pets line as petCritBonus, and printing
        // "which this reader cannot answer" beside the line that carries it
        // is a refusal whose reason is false.
        if (g.field === 'critChance' && (rot.summons ?? []).some((sp) => sp.from === g.id
          && sp.petCritBonus > 0 && Math.abs(sp.petCritBonus - g.amount) < 1e-12)) continue;
        // A rider in a PROXY hook rides the summons' hits and never the
        // owner's (evalDamage@6124 ops 9-70), so its sentence says whose.
        const onPets = /^onProxyDamage/.test(g.hook ?? '');
        // ...and where the summon spec READ the clause and refused it, the
        // refusal says what it is: a rider on the pet that needs the pet to
        // be wearing a status, with who applies that status named.
        const petRider = onPets ? (rot.summons ?? []).filter((sp) => sp.from === g.id)
          .flatMap((sp) => (sp.petRiders ?? []).map((pr) => ({ sp, pr })))
          .find(({ pr }) => pr.field === g.field && Math.abs(pr.amount - g.amount) < 1e-12) : null;
        if (petRider) {
          const { pr } = petRider;
          const stRow = cdb.byId('skill').get(pr.needsStatus);
          const stName = stRow?.texts?.name ? `${stRow.texts.name} (${pr.needsStatus})` : pr.needsStatus;
          const live = pr.appliers.filter((a) => a.live);
          const gated = pr.appliers.filter((a) => !a.live && a.minRank != null);
          extraGaps.push({
            id: g.id, name: g.name, source: 'script',
            // Two different statements, so two kinds. With an applier live
            // the clause DOES fire, on a condition this fight cannot evaluate
            // (where a summon stands). With none it is read and correctly
            // zero for this build - a rank the weapon has not reached, or a
            // status nothing here applies - and filing that under "something
            // this reader cannot evaluate" gave a true zero a false reason.
            kind: live.length ? 'conditional' : 'off in this build',
            why: `${g.name}'s ${pr.unitName} hits are scored, and one clause of its script is READ and `
              + `not credited: ${pr.field} +${pr.amount} on the hits of any ${pr.unitName} that wears ${stName}`
              + (live.length
                ? `, which ${live.map((a) => a.name).join(' and ')} `
                  + `put${live.length === 1 ? 's' : ''} on a summon standing in its area - and where a summon `
                  + 'stands is a position this fight does not have, so the summon line is a floor by that much'
                : gated.length
                  ? `, which ${gated.map((a) => `${a.name} applies only from rank ${a.minRank}`).join(' and ')} `
                    + `- at rank ${rank} nothing puts it on a summon, so it is worth zero here`
                  : ', and nothing in this build applies that status to a summon, so it is worth zero here'),
          });
          continue;
        }
        // A MULTIPLIER WRITTEN AS `*=` is named and never priced (see
        // `scriptGapsOf`). Behind the target's health it is two different
        // statements: off at the health stated - correctly zero, and said as
        // that - or on, and missing from the line. Nectar-infused Blade's
        // x1.3 under 35% is the one row.
        if (g.mult) {
          const th = g.targetHealth;
          const on = !th || (th.op === '<=' ? targetHealth <= th.threshold
            : th.op === '<' ? targetHealth < th.threshold
              : th.op === '>=' ? targetHealth >= th.threshold : targetHealth > th.threshold);
          const what = `${g.own ? 'its own hits are' : 'a hit is'} multiplied by ${+(1 + g.amount).toFixed(4)}`
            + (th ? ` while the target is ${th.op} ${+(th.threshold * 100).toFixed(2)}% health` : ` behind \`${g.guard}\``);
          extraGaps.push({
            id: g.id, name: g.name, source: 'script',
            kind: on ? 'rider not read' : 'off at this target health',
            why: on
              ? `${g.name} is scored, but one clause of its script is not: ${what} - written as \`dmgMult *=\`, `
                + 'a multiplier this reader does not price, so its line is low by that factor here'
              : `${g.name} is scored, and one clause of its script is worth zero here: ${what}. You stated `
                + `${+(targetHealth * 100).toFixed(2)}%, so it never fires. (Inside that window it would be named `
                + 'as not priced: the reader does not take a `dmgMult *=`.)',
          });
          continue;
        }
        extraGaps.push({
          id: g.id, name: g.name, source: 'script', kind: 'rider not read',
          // A gap that knows how to say itself says itself; the rest take the
          // shape this loop has always built.
          why: g.why ?? (onPets
            ? `${g.name} is scored, but one clause of its script is not: its summons' hits take `
              + `${g.field} ${g.amount} behind \`${g.guard}\` (it is written in ${g.hook}, so it rides `
              + 'what your summons deal and nothing you cast), and that guard is about the summon\'s own '
              + 'state, which this reader cannot answer'
            : `${g.name} is scored, but one clause of its script is not: `
              + `${g.field} ${g.amount} behind \`${g.guard}\`, which this reader cannot answer`),
        });
      }
      // A summoner that sits in no bucket has no profile of its own to ask
      // about health riders.
      if (e.summonOnly) continue;
      // A RIDER THAT IS READ AND SWITCHED OFF BY THE STATED HEALTH. This one is
      // correctly worth zero, so it is not a gap - and that is exactly why it
      // needs saying. Every other channel goes quiet on it: the skill is
      // scored, the gap list above dedups the clause because the reader DOES
      // read it, and the rune table reports what the rune promises. Left
      // silent, a player slots Execution, sees it buy nothing at the default
      // full health, and concludes the rune is bad - when what happened is
      // that they never told the tool about the execute phase.
      //
      // The other direction needs no line here: a rider that FIRED is inside
      // the number, and the audit says which health every clause was priced at.
      for (const rd of combat.profile(e.prof.id, rank, new Set(rot.runes ?? []))?.runeDamage ?? []) {
        // A cast's OWN clause behind the crowd-control gate is the same kind
        // of line and is said below, with the owner-wide ones.
        if (rd.gate === 'cc' && !rd.ownerWide) ownCcRiders.push({ prof: e.prof, rd });
        // A clause that waits for a status TYPE on the target (damage.mjs
        // `typedGuard`) is paid by the fight while a status of that type
        // stands among the ones it plays - the build's own and an attached
        // set's, the list the fight itself asks (damage.mjs `whileTyped`).
        // With none there it is the same kind of correct zero as the health
        // clause below, and as silent.
        if (rd.gate === 'typed' && !(fightRot.dots ?? []).some((d) => typeCovers(rd.statusType, d.types))) {
          extraGaps.push({
            id: e.prof.id, name: e.prof.name, source: 'script', kind: 'off in this build',
            why: `${e.prof.name} is scored, and one clause of its script is READ and worth zero here: `
              + `${rd.field} +${rd.amount} while the target wears a ${rd.statusType} status, and nothing this build `
              + `casts applies one`,
          });
        }
        const th = rd.targetHealth;
        if (!th) continue;
        const on = th.op === '<=' ? targetHealth <= th.threshold
          : th.op === '<' ? targetHealth < th.threshold
            : th.op === '>=' ? targetHealth >= th.threshold : targetHealth > th.threshold;
        if (on) continue;
        extraGaps.push({
          id: e.prof.id, name: e.prof.name, source: 'script', kind: 'off at this target health',
          why: `${e.prof.name} is scored, and one clause of its script is READ and worth zero here: `
            + `${rd.field} +${rd.amount} while the target is ${th.op} `
            + `${+(th.threshold * 100).toFixed(2)}% health${rd.rune ? `, from the rune you slotted` : ''}. `
            + `You stated ${+(targetHealth * 100).toFixed(2)}%, so it never fires - `
            + `--target-health ${+(th.threshold * 100).toFixed(2)} prices the window it is for`,
        });
      }
    }
    // ...and a script-played STEP behind the same kind of test (Spark Shot's
    // execute hit, and its rank-3 hit above 80%): read, on the rotation, and
    // dropped by the fight where the stated health fails it.
    for (const tr of rot.triggered ?? []) {
      // A step that needs a crowd-control status to land first is the same
      // kind of zero against a target that refuses crowd control.
      if (tr.rule?.needsCC && tgt.ccImmune === true) {
        const stepId = String(tr.prof.id).split('#')[1] ?? 'step';
        extraGaps.push({
          id: tr.prof.id, name: tr.prof.name, source: 'script', kind: 'off against this target',
          why: `${tr.prof.name}'s ${stepId} step is READ and worth zero here: it is played when `
            + `${tr.prof.name} ends, ${tr.prof.name} is crowd control (${tr.rule.needsCC.join(', ')}), and this target `
            + `is immune to crowd control${tgt.ccImmuneWhy ? ` (${tgt.ccImmuneWhy})` : ''} - it never wears it`,
        });
        continue;
      }
      const th = tr.rule?.targetHealth;
      if (!th) continue;
      const on = th.op === '<=' ? targetHealth <= th.threshold
        : th.op === '<' ? targetHealth < th.threshold
          : th.op === '>=' ? targetHealth >= th.threshold : targetHealth > th.threshold;
      if (on) continue;
      const stepId = String(tr.prof.id).split('#')[1] ?? 'step';
      // A strict comparison is not met AT its threshold, so the health to ask
      // for is a point inside the window.
      const inside = th.threshold * 100 + (th.op === '<' ? -1 : th.op === '>' ? 1 : 0);
      // ONE CLAUSE OF THE STEP, where the step has another that is live. A
      // script may play the same step from two sites - Spark Shot plays its
      // AdditionalDamage under 35% health and, from rank 3, above 80% as
      // well - and the rotation carries one rider per site. "The step is
      // worth zero, it never plays" is then false beside the line that
      // prices its other site, so the sentence is about this clause and
      // points at the one that is in the number.
      const healthOn = (h) => (h.op === '<=' ? targetHealth <= h.threshold
        : h.op === '<' ? targetHealth < h.threshold
          : h.op === '>=' ? targetHealth >= h.threshold : targetHealth > h.threshold);
      const liveSites = (rot.triggered ?? []).filter((o) => o !== tr && o.prof.id === tr.prof.id
        && !(o.rule?.needsCC && tgt.ccImmune === true)
        && (!o.rule?.targetHealth || healthOn(o.rule.targetHealth)));
      const window = (h) => `while the target is ${h.op} ${+(h.threshold * 100).toFixed(2)}% health`;
      extraGaps.push({
        id: tr.prof.id, name: tr.prof.name, source: 'script', kind: 'off at this target health',
        why: liveSites.length
          ? `${tr.prof.name}'s ${stepId} step is played from more than one place in its script, and one of them `
            + `is READ and worth zero here: the one that plays it ${window(th)}. You stated `
            + `${+(targetHealth * 100).toFixed(2)}%, so that clause never plays - --target-health `
            + `${+inside.toFixed(2)} prices the window it is for. The step's line is its other clause, `
            + liveSites.map((o) => (o.rule.targetHealth ? window(o.rule.targetHealth) : 'whatever the target\'s health')).join(' and ')
          : `${tr.prof.name}'s ${stepId} step is READ and worth zero here: it is played ${window(th)}. `
            + `You stated ${+(targetHealth * 100).toFixed(2)}%, `
            + `so it never plays - --target-health ${+inside.toFixed(2)} prices the window it is for`,
      });
    }
    // A cooldown clause behind a stated TARGET COUNT, off at the count stated.
    for (const mu of rot.cdMutations ?? []) {
      const nt = mu.needsTargets;
      if (!nt) continue;
      const want = Math.max(1, evalOpts.targets ?? 1);
      const on = nt.op === '>=' ? want >= nt.n : nt.op === '>' ? want > nt.n : want === nt.n;
      if (on) continue;
      const name = cdb.byId('skill').get(mu.host)?.texts?.name ?? mu.host;
      extraGaps.push({
        id: mu.host, name, source: 'script', kind: 'off at this target count',
        why: `${name} is scored, and one clause of its script is READ and worth zero here: ${mu.why}. `
          + `You stated ${want} target${want === 1 ? '' : 's'}, so it never fires - --targets `
          + `${nt.op === '>' ? nt.n + 1 : nt.n} prices it`,
      });
    }
    // The finisher's mark carries one clause the fight does not price: crit
    // chance for the hit that spends it, against a target under a stated
    // health. Off at the health stated, it is said like every other health
    // clause; on, it is a clause not read.
    if (rot.comboRider?.crit) {
      const c = rot.comboRider.crit;
      const on = c.op === '<=' ? targetHealth <= c.threshold : targetHealth < c.threshold;
      const what = `critChance +${c.amount} on the finisher hit that spends ${rot.comboRider.statusName}, while the `
        + `target is ${c.op} ${+(c.threshold * 100).toFixed(2)}% health`;
      extraGaps.push({
        id: rot.comboRider.from, name: rot.comboRider.name, source: 'script',
        kind: on ? 'rider not read' : 'off at this target health',
        why: on
          ? `${rot.comboRider.name}'s mark is scored, but one clause of its script is not: ${what} - the fight `
            + 'prices the mark\'s damage bonus and not a crit-chance rider on one hit'
          : `${rot.comboRider.name}'s mark is scored, and one clause of its script is READ and worth zero here: `
            + `${what}. You stated ${+(targetHealth * 100).toFixed(2)}%, so it never fires`,
      });
    }
    // AN OWNER-WIDE RIDER THAT IS READ AND WORTH NOTHING HERE, for the same
    // reason the health clause above is said: every other channel goes quiet
    // on it. Domination's rank-3 +25% rides every hit against a
    // crowd-controlled target - and against a target that refuses crowd
    // control, or in a build that applies none, it is correctly zero. A
    // player who sees the passive "scored" and the number unmoved is owed the
    // sentence.
    //
    // What is zero because of THE BUILD is collected per row and said once.
    // Domination has two such clauses - the rider with no crowd control to
    // ride, the register with no stun to arm it - and a build that has
    // neither used to print the passive's name twice under one heading with
    // nothing to tell the lines apart (and `bench weapons`, which keeps one
    // reason per row, showed only the first).
    const offHere = new Map();   // row id -> { name, clauses }
    const offInBuild = (id, name, clause) => {
      if (!offHere.has(id)) offHere.set(id, { name, clauses: [] });
      offHere.get(id).clauses.push(clause);
    };
    // WHICH state a rider asks for: any crowd control, or the one type its
    // guard names (Riptide's and Pyroclasm's Slow) - and whether anything in
    // the build puts the target in it.
    const ccState = (rd) => (rd.ccType ? `target under a ${rd.ccType}` : 'crowd-controlled target');
    const ccApplied = (rd) => (rd.ccType
      ? ccAll.some((e) => e.cc.some((c) => (c.types ?? []).includes(rd.ccType)))
      : ccAll.length > 0);
    const ccNothing = (rd) => (rd.ccType
      ? `nothing this fight plays applies a ${rd.ccType}` : 'nothing in this build applies crowd control');
    const ccRiders = (rot.ownerRiders ?? []).filter((rd) => rd.gate === 'cc');
    for (const rd of ccRiders) {
      const pct = `${rd.field} +${rd.amount}`;
      if (evalOpts.gates.ccImmune > 0) {
        extraGaps.push({
          id: rd.from, name: rd.name, source: 'script', kind: 'off against this target',
          why: `${rd.name} is read, and its clause is worth zero here: ${pct} on every hit against a `
            + `${ccState(rd)}, and this target is immune to crowd control`
            + (tgt.ccImmuneWhy ? ` (${tgt.ccImmuneWhy})` : '')
            + ' - nothing this build casts can put it in that state',
        });
      } else if (!ccApplied(rd)) {
        offInBuild(rd.from, rd.name, `${pct} on every hit against a ${ccState(rd)}, and `
          + ccNothing(rd));
      }
    }
    // ...and a scored CAST's own clause behind the same gate. Chaotic
    // Distorsion's rank-2 +40% is the one in the sheet: priced for the share
    // of the fight the target spends controlled, and where that share is
    // nothing the zero is said, with the input that decides it.
    const saidOwn = new Set();
    for (const { prof: p, rd } of ownCcRiders) {
      const k = `${p.id}|${rd.field}|${rd.amount}`;
      if (saidOwn.has(k)) continue;
      saidOwn.add(k);
      const lead = `${p.name} is scored, and one clause of its script is READ and worth zero here: `
        + `${rd.field} +${rd.amount} against a ${ccState(rd)}, and `;
      if (evalOpts.gates.ccImmune > 0) {
        extraGaps.push({
          id: p.id, name: p.name, source: 'script', kind: 'off against this target',
          why: lead + 'this target is immune to crowd control' + (tgt.ccImmuneWhy ? ` (${tgt.ccImmuneWhy})` : ''),
        });
      } else if (!ccApplied(rd)) {
        extraGaps.push({
          id: p.id, name: p.name, source: 'script', kind: 'off in this build',
          why: lead + ccNothing(rd),
        });
      }
    }
    // A CONTROL THE BUILD HOLDS AND THE SHARE LEAVES OUT. Said only where
    // something reads the gate, and against a target the control could land
    // on: the readers named are what it would have lifted.
    const readsCc = ccRiders.length > 0 || [...rot.active, ...rot.filler, ...(rot.triggered ?? [])]
      .some((e) => (e.prof.runeDamage ?? []).some((rd) => rd.gate === 'cc'));
    if (readsCc && !(evalOpts.gates.ccImmune > 0)) {
      const readers = [...new Set([...ccRiders.map((rd) => rd.name), ...ownCcRiders.map((x) => x.prof.name)])];
      const saidCc = new Set();
      for (const { prof: p, cc } of ccUnpriced) {
        if (saidCc.has(p.id + '|' + cc.status)) continue;
        saidCc.add(p.id + '|' + cc.status);
        const reason = cc.unpriced ?? (cc.duration == null
          ? 'its row gives no lifetime this reader can turn into seconds'
          : 'its row gives it no lifetime of its own, so how long it holds is whatever removes it');
        extraGaps.push({
          id: p.id, name: p.name, source: 'script', kind: 'assumption',
          why: `${p.name} applies ${cc.name}${cc.name !== cc.status ? ` (${cc.status})` : ''}, which is crowd `
            + `control, but ${reason} - so the time the target spends under it is not in the `
            + `crowd-controlled share, and ${readers.join(' and ') || 'what reads that share'} `
            + `${readers.length > 1 ? 'are' : 'is'} priced as a floor by that much`,
        });
      }
    }
    // A STUN THIS TARGET REFUSES. The build applies it and it does not stand,
    // so it is in no share - said once per reader of the gate, with the
    // unit's own reason, and with what is left when the build also holds a
    // control the target does take.
    if (readsCc && !(evalOpts.gates.ccImmune > 0) && ccRefused.length) {
      // Only a reader the refused stun would have FED. One that asks for a
      // single named type (`ccType`: Riptide's and Pyroclasm's Slow) never
      // counted a stun - its share is keyed on that type alone - so telling
      // it "part of what feeds it" is a stun would be a reason that is false.
      const fedBy = (rd) => !rd.ccType || ccRefused.some(({ cc }) => (cc.types ?? []).includes(rd.ccType));
      const readers = [...new Set([...ccRiders.filter(fedBy).map((rd) => ({ id: rd.from, name: rd.name })),
        ...ownCcRiders.filter((x) => fedBy(x.rd)).map((x) => ({ id: x.prof.id, name: x.prof.name }))].map((x) => JSON.stringify(x)))]
        .map((x) => JSON.parse(x));
      const stuns = [...new Set(ccRefused.map(({ prof: p, cc }) => `${p.name}'s ${cc.name}`))];
      const rest = ccAppliers.length
        ? ` - what it does take (${[...new Set(ccAppliers.flatMap((e) => e.cc.map((c) => `${e.prof.name}'s ${c.name}`)))].join(', ')}) is still counted`
        : ', and a stun is the only crowd control this build applies';
      for (const r of readers) {
        extraGaps.push({
          id: r.id, name: r.name, source: 'script', kind: 'off against this target',
          why: `${r.name} is read, and ${ccAppliers.length ? 'part of what feeds it' : 'its clause'} is worth zero here: `
            + `${stuns.join(', ')} ${stuns.length > 1 ? 'are stuns' : 'is a stun'}, and this target refuses a stun`
            + (tgt.stunImmuneWhy ? ` (${tgt.stunImmuneWhy})` : '') + rest,
        });
      }
    }
    // ...and a next-weapon-skill register nothing in the build ARMS. Read,
    // priced, and never spent is not the same as scored.
    for (const w of rot.wsRiders ?? []) {
      if (!(w.armedBy instanceof Set)) continue;
      const row = cdb.byId('skill').get(w.from);
      const name = row?.texts?.name ?? w.from;
      const watched = cdb.byId('skill').get(w.watches)?.texts?.name ?? w.watches;
      if (!w.armedBy.size && w.watches) {
        offInBuild(w.from, name, `its next-weapon-skill bonus is armed by applying ${watched}, and `
          + 'nothing this build presses applies it'
          + (w.uncounted?.length ? ` (${w.uncounted.join(', ')} would on a roll, which is not counted)` : ''));
      } else if (w.uncounted?.length) {
        extraGaps.push({
          id: w.from, name, source: 'script', kind: 'assumption',
          why: `${name}'s next-weapon-skill bonus is armed by the casts that apply ${watched}; `
            + `${w.uncounted.join(', ')} would arm it too on a roll and ${w.uncounted.length === 1 ? 'is' : 'are'} `
            + 'not counted, so its rate is a floor',
        });
      }
    }
    // ...and a use rider nothing in the build can SPEND (skills.mjs
    // useRiderOf): its cooldown never starts, so the step it plays while
    // that cooldown runs never plays either.
    for (const u of rot.useRiders ?? []) {
      if ((u.spenders ?? []).length) continue;
      offInBuild(u.from, u.name, `its +${Math.round(u.amount * 100)}% goes to the next weapon, class or signature skill `
        + `whose own row holds a ${u.root} effect, and this build presses none`
        + (u.critStep ? ` - so its cooldown never runs and its ${u.critStep.stepId} step never plays` : ''));
    }
    for (const [id, { name, clauses }] of offHere) {
      extraGaps.push({
        id, name, source: 'script', kind: 'off in this build',
        why: clauses.length === 1
          ? `${name} is read, and worth zero here: ${clauses[0]}`
          : `${name} is read, and ${clauses.length} of its clauses are worth zero here: `
            + clauses.map((c, i) => `(${i + 1}) ${c}`).join('; '),
      });
    }
    if (extraGaps.length) tp.unmodelled = [...tp.unmodelled, ...extraGaps];
    // The crowd-control gate was priced off an interval, and on a first pass
    // that interval is a guess - see `evaluate`. Named only when something
    // in the build actually reads the gate.
    const ccPending = readsCc && !evalOpts.gates.ccImmune && ccAppliers.length && !ccIntervals
      ? ccAppliers.map((e) => e.prof.id) : [];
    return {
      ...r, target: tgt, weaponPower, profile, rotation: rot, buffs,
      throughput: tp, survivability: sv, ccPending,
      // ...and on the pass that closed it (`evaluate`), what it was closed
      // on: the interval the first pass played each applier at. Null on a
      // pass that priced the gate off cooldowns - which is every evaluation
      // of a build in which nothing reads the gate.
      ccPlayed: ccIntervals ? Object.fromEntries(ccIntervals) : null,
      // The infusion sets this build wears and what each piece's bonus line
      // came to - see infusion.mjs `attach` for the shape.
      infusions: { sets: infusion.sets, pieces: infusion.pieces },
      // What the wrapper needs to close the ramp loop, and what a reader needs
      // to see that it was closed: `pending` is "there is a stacking conduit
      // buff here that nobody has priced yet", `conduitRamps` is what it was
      // finally priced at.
      conduitPending: conduitBuffGaps, conduitRamps,
      // The perks that pay on ONE SIDE of the target (`upgradeBehind` above),
      // and the share of base attacks they were billed on. A ledger reads it:
      // a window fought from one side holds those swings in another mix than
      // the fight does, and the rows cannot say which side it was.
      sidePerks: { perks: upgradeBehind, fraction: assumeAll.behindFraction ?? 1 },
    };
  }

  // The mean stack count of a once-per-trigger buff over a fight of `T`
  // seconds. It climbs one stack per trigger to `cap` and then holds, so the
  // time-average is the area under that curve: half the cap while ramping,
  // then the cap. If the gap between triggers is longer than the buff itself
  // it never accumulates at all - it is up at one stack for dur/cadence of the
  // time and down the rest.
  // `per` is how many stacks one trigger adds: a conduit slotted n times adds
  // n at once (each instance's onStartConduit runs).
  function rampMeanStacks(cap, cadence, dur, T, per = 1) {
    if (!(cadence > 0) || !(T > 0) || !(cap > 0)) return 0;
    if (cadence >= dur) return Math.min(cap, per) * Math.min(1, dur / cadence);
    const toCap = (cap / per) * cadence;               // seconds to reach it
    return T <= toCap ? per * T / (2 * cadence) : cap * (1 - toCap / (2 * T));
  }

  /**
   * Two passes, and only when the build has one of these buffs.
   *
   * A conduit buff's stack count is driven by how often THIS build spends
   * Spark from above the gauge, which is a thing only the fight knows - so the
   * first pass measures the trigger cadence with the buff refused, and the
   * second prices it at the mean that cadence implies. The measurement is not
   * circular: the buff grants MagicMastery, which changes damage but changes
   * neither Spark income nor the spend schedule, so the cadence the first pass
   * reports is the cadence the second pass runs at.
   */
  function evaluateRamped(loadout, args = {}) {
    const first = evaluateOnce(loadout, args);
    if (!first.conduitPending?.length || args.conduitStacks) return first;

    // The cadence of the TRIGGER EVENT, not of the hits: every instance of a
    // repeated conduit fires at one `now`, so a doubled conduit reports half
    // the interval while riding the same spends.
    const ids = new Set((first.rotation?.triggered ?? [])
      .filter((t) => t.rule?.kind === 'per-conduit-trigger')
      .map((t) => t.prof?.id));
    let cadence = Infinity;
    for (const line of first.throughput?.lines ?? []) {
      if (!ids.has(line.id)) continue;
      const c = line.interval * (line.instances ?? 1);
      if (c > 0 && c < cadence) cadence = c;
    }
    const T = first.throughput?.fight ?? args.fight ?? opts.fight;
    // A build whose conduits all BUFF has no such line: the fight's own count
    // of trigger events says how often they went off.
    // MEASURED 2026-10-13 (a Mage with three Power conduits and no other):
    // every Spark spend from above half the pool added three stacks in one
    // millisecond, 36 times, to the cap of twenty in a rotation - and the
    // model, reading the cadence off a damage conduit's line, gave her none.
    if (!Number.isFinite(cadence) && first.throughput?.conduitEvents > 0) cadence = T / first.throughput.conduitEvents;
    if (!Number.isFinite(cadence)) return first;      // nothing ever fired

    // ...and a conduit slotted n times adds n stacks a trigger.
    const slotted = Object.values(first.rotation?.selection ?? {}).flat();
    const per = (id) => Math.max(1, slotted.filter((x) => x === id).length);
    const stacks = new Map(first.conduitPending.map((g) =>
      [g.id, rampMeanStacks(g.stacks, cadence, g.duration, T, per(g.from))]));
    return evaluateOnce(loadout, { ...args, conduitStacks: stacks });
  }

  /**
   * THE CROWD-CONTROL GATE, closed on the fight's own schedule.
   *
   * The share of the fight a target spends stunned is duration / interval per
   * applier, and the interval is a thing only the fight knows: a cooldown
   * skill is pressed later than its cooldown whenever something better is up,
   * and a cast with no cooldown at all has no interval until its resource has
   * been played. So the first pass prices the gate off cooldowns, and - only
   * when a rider in the build reads the gate - a second prices it off the
   * interval each applier was actually played at. The rider moves damage and
   * not the schedule (a rotation whose ORDER the extra damage changes would
   * shift it a little; one pass further is not taken).
   */
  function evaluate(loadout, args = {}) {
    const ev = evaluateRamped(loadout, args);
    if (!ev.ccPending?.length || args.ccIntervals) return ev;
    const played = new Map();
    for (const line of ev.throughput?.lines ?? []) {
      if (ev.ccPending.includes(line.id) && line.interval > 0 && (line.casts ?? line.hits ?? 0) > 0) {
        played.set(line.id, line.interval);
      }
    }
    return evaluateRamped(loadout, { ...args, ccIntervals: played });
  }

  /**
   * The scalar the search maximises.
   *
   * A single goal is used raw. A weighted blend is normalised against a
   * reference evaluation captured once at the start of a run, so "dps=1,
   * ehp=0.25" means what it looks like instead of being swamped by whichever
   * metric happens to have the larger units.
   */
  // `targetHealth` rides the scorer for the same reason `rank` does: what the
  // search is allowed to pick depends on it. At full health Execution is a
  // rune that adds nothing and the search should not pay a socket for it.
  function makeScorer({ goal = 'dps', weights = null, target, rank = 1, mix = 0.5, ref = null,
    targetHealth = opts.targetHealth }) {
    checkTargetHealth(targetHealth);
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
        score: (loadout) => metrics(evaluate(loadout, { target, rank, mix, goal, targetHealth }))[goal] ?? 0,
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
      // A blend cannot hand the fight a single objective, so the fight keeps
      // its everything-counts criterion for these - see sim.mjs `goalWeights`.
      score: (loadout) => norm(metrics(evaluate(loadout, { target, rank, mix, goal: 'mixed', targetHealth }))),
      scoreFrom: (ev) => norm(metrics(ev)),
    };
  }

  const audit = [
    ...auditModel(cdb, ctx),
    ...combat.audit.filter((a) => !(a.what.startsWith('Fervor') && opts.assume.fervorScope === 'none')),
    {
      severity: 'assumption',
      what: 'a self-buff is worth duration/cooldown on the SHEET; the fight presses it instead',
      why: 'The averaged sheet credits a buff on a cooldown at min(1, duration / cooldown) - ' +
           'Priest_BlessingOfFervor is 15s on 120s, so 13% - and that is a display number. The FIGHT ' +
           'casts the skill and opens a real window, which is what dps is computed from, so bursting ' +
           'inside the window is worth more than the average. That split only became true for every ' +
           'such skill once the bucketing was fixed: a cooldown whose payload is a timed self-buff ' +
           'used to be filed as a PASSIVE unless its status carried a one-shot amount, so the fight ' +
           'never pressed it and the window never opened - Battle Shout, Berserk, Blessing of Fervor ' +
           'and Smoke Bomb all read as dead bar slots, worth NEGATIVE because they occupied one. ' +
           'A buff with no cooldown behind it still keeps 100%: a 15-second enchant refreshed by a ' +
           '30%-per-attack proc does sit at its cap in sustained combat. Stacks are still counted at ' +
           'the cap, which a short or movement-heavy fight would not reach.',
    },
    {
      severity: 'assumption',
      what: 'a damage-over-time keeps what its APPLIER had when it was applied; what the TARGET wears is read at each tick',
      why: 'Two halves, and only one is still an assumption. THE APPLIER\'S SIDE: a DoT ticks at the ' +
           'sheet and the buffs it was applied under and does not follow those that come and go while ' +
           'it runs. Nothing in the CDB states this either way; it is the convention SimulationCraft ' +
           'uses, and a re-application re-snapshots. The 2026-10-13 capture cannot say - nothing on ' +
           'the Rogue\'s sheet moved inside a tick\'s life. THE TARGET\'S SIDE is read when the tick ' +
           'lands, armour and the hooks of its statuses alike. MEASURED 2026-10-13 (Rogue, dummy): ' +
           'one application of Lethal Poison ticked 71, 71, 71, 69, 71, 71, 71, 69, 69 as Chaos ' +
           'Scorch\'s armour break came and went; Gaping Wound\'s bleed, applied 0.8 s BEFORE Death ' +
           'Mark landed, read 189 on all four of its ticks (165 plain); the trinket\'s curse 42 inside ' +
           'the mark and 37 outside it within one application. The fight re-prices a tick whose ' +
           'target changed since the application (a DurationBased carry, a sum of two applications, ' +
           'keeps its snapshot).',
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
           'slows, and the few damage amplifiers sit on cooldowns long relative to their windows. ' +
           'ONE KIND OF PRESS IS ALSO PLAYED OUT OF THAT ORDER: a press that lands on its own caster, in a ' +
           'build holding a status such a landing puts up (Faithful Winds under Sunlight; the Sunlight entry ' +
           'has the read). The order ranks a press by what the press deals, and what this one buys is the ' +
           'status\'s window, which is not stacked: pressed on top of a landing that already holds it open, ' +
           'the seconds the two share are bought twice, and where something else lands at least as often as ' +
           'the window lasts it buys nothing and costs the chain its clock. So the fight is also played with ' +
           'such a press LAST in the order (one whose landing lasts) and WITHOUT it (one that is in the ' +
           'rotation for its landing alone - or, one remove away, a releaser that is in it for nothing but ' +
           'a release that lands on its caster: Judgment with a heal as its only prayer) - every ' +
           `combination while there are at most ${LANDER_WAYS}, one ` +
           'press at a time past that, with or without a lookahead - and the best is kept. The sheet lists ' +
           'each order with what it came to, and a press left out is named under "not pressed" with what ' +
           'holds the window without it. These are orders the simulator can play, not a rule of the game; a ' +
           'hold on "the window is open" was tried as the rule and is not one (it lowers a build whose lane ' +
           'is worth pressing a few seconds into a prayer\'s window). FOUND ON, 2026-10-13, level 25, named ' +
           'boss: with the rune that only ADDS a hit to Faithful Winds (Faithful Hurricane) the default ' +
           'Priest search\'s build read 554.3 as ranked (553.0 in priority order: the lane pressed on top ' +
           'of Prayer: Life\'s window, 160 Sunlight hits for 188), under the 565.9 of the same build with ' +
           'the socket empty; with the ' +
           'lane last it reads 579.6, the empty socket\'s press times plus the rune\'s line and what rides ' +
           'its hit. And with Flame of Argol pinned, whose Heat Emission lands on its caster every 6s where ' +
           'Sunlight lasts 6, Faithful Winds with no rune read 534.7 pressed on cooldown and 548.1 left out, ' +
           'which is what that build reads with the slot empty. (Those figures, and the ones quoted for ' +
           'that Flame of Argol build further down, are of that day. Since ' +
           'then Cooldown Reduction is read when each cooldown starts, and Crusader\'s ten points move ' +
           'the first build\'s presses against its windows: it reads 558.2 as ranked and 556.3 with the ' +
           'lane last, so on that build the order no longer pays, and the default search answers ' +
           'another rune for the lane.) ' +
           'And the default search\'s build with Flame of Argol put in its main hand and Prayer: Life as ' +
           'its only prayer: Judgment - kept for the landing of what it releases and pressed sixteen ' +
           'times - reads 500.6 where the same build with no prayer slotted reads 516.0; played both ' +
           'ways it is left out and the build reads 516.0. NOT COVERED: every other press that costs ' +
           'more than it returns is still pressed whenever it is ready. THE LARGEST CASE FOUND is a press ' +
           'that DEALS damage and takes more than it deals from what it displaces: Zealous Spins in the ' +
           'arsenal of the default Warrior search\'s build (level 25, named boss) reads 812.1 where the ' +
           'same build with that slot empty reads 846.3 - its own two lines are 29.4 dps, and the rest ' +
           'of the build loses 63.6 beside it: Iron Cyclone and Shockwave hit for less (342 to 295 and ' +
           '1,058 to 812 a hit), eight finishers and twelve swings of the chain are not thrown, and the ' +
           'bleed their critical strikes feed is 16 dps lower. Alone on the bar it reads ' +
           '610.6 against 670.0 with nothing slotted. The search does not pick it (it takes the passive ' +
           'in that slot, and the build says the passive is worth what an empty slot is there); a ' +
           'player who pins it is priced with it pressed on cooldown, and is not told. WHAT WOULD SETTLE ' +
           'IT is the rule the landers already get, for every cast: keep a press only where the fight ' +
           'with it beats the fight without it, and say which were left out. That is one more fight per ' +
           'press per evaluation - several times the cost of a search - and it moves every default number ' +
           'that presses something at a loss; it was not taken here. Hot, hot, hot! is another live case - ' +
           'the temporary Flamie it hands out heals and, from rank 3, starts Heat Emission\'s area on your ' +
           'finishers (the Flamie row\'s onSkillProc), which is not priced, so the press is kept for a status ' +
           'worth nothing to the number and costs that Flame of Argol build about 8 dps (556.3 with it never ' +
           'pressed, through an authored order, against 548.1). WHAT WOULD SETTLE THAT ONE: pricing the ' +
           'area - the Heat Emission entry says what has to be measured first - after which the press has ' +
           'a worth to rank. THE GENERAL CASE is a press whose status lands and moves nothing the goal ' +
           'counts: a cast that puts a status up is kept for it whatever the status carries, so a defensive ' +
           'or a movement buff is pressed on its cooldown in a dps fight and costs the swings it takes. ' +
           'Measured here, a bare level-25 character with one legendary weapon against the named boss, the ' +
           'skill slotted against the same bar without it: Smoke Bomb (a second of Dodge, 4 presses) 71.95 ' +
           'against 72.48, Ignore Pain (damage taken, 4) 67.58 against 68.07, Thornlace\'s Bloom (move speed, ' +
           '12) 93.06 against 93.23, and Judgment pressed sixteen times for a rune\'s three seconds of move speed ' +
           'with a heal as the only prayer, 46.89 against 48.28. Small, and on every such bar. What is NOT ' +
           'kept is a press for a status that can never land (a status handed out at exactly three ready ' +
           'prayers, in a build that can ready one): that one is dropped and said. WHAT WOULD SETTLE THE ' +
           'REST is one rule for every cast - which attributes count toward which goal (the survivability ' +
           'sheet reads the defensive rows; nothing reads MoveSpeedFactor) - not an exception per skill; it ' +
           'moves every default number that slots such a press, and was not taken here.',
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
      what: opts.targetHealth >= 1
        ? 'the target stands at FULL health, so every execute clause in the game is off'
        : `the target stands at ${+(opts.targetHealth * 100).toFixed(2)}% health for every clause that asks`,
      // The clauses are COUNTED off the scripts as the list is built: every
      // `<who>.healthRatio <op> vars.<x>`, filed by whose health it is. The
      // entry read "Eight script clauses across seven weapons ... FOUR of
      // the eight are priced today ... Hiveborn Blossom's is among [the
      // others]" on a build whose sheet holds ten in nine rows and whose
      // fight prices nine of them, Hiveborn Blossom's included.
      why: (() => {
        const sites = { target: [], owner: [] };
        for (const s of cdb.lines('skill')) {
          if (typeof s.script !== 'string') continue;
          for (const m of s.script.matchAll(/(\w+(?:\.\w+)*)\.healthRatio\s*(?:<=|>=|<|>)\s*vars\.\w+/g)) {
            sites[/^owner\b|\.ownerUnit$/.test(m[1]) ? 'owner' : 'target'].push(s);
          }
        }
        const rowsOf = (list) => [...new Set(list)];
        const names = (list) => rowsOf(list).map((s) => s.texts?.name ?? s.id).join(', ');
        return `${sites.target.length} script clauses in ${rowsOf(sites.target).length} rows compare the TARGET's healthRatio against a `
          + `threshold of their row (${names(sites.target)}). None of that is live state this reader has to guess at: which phase of a fight `
          + 'you are asking about is an input, the same standing --targets has. So --target-health states '
          + 'it and the comparison is answered exactly - no assumption that the fight ends in a kill, '
          + 'none that damage is even, none that some share of the clock is spent below the line. `<` and '
          + '`<=` therefore differ only exactly AT the boundary, which is all the precision one stated '
          + 'number can carry. WHICH ARE PRICED, checked on build 25782799 by stating a health on a build '
          + 'that holds each row: Execution\'s +25% under 35% (a rune of Raging Smash), Demonic Bite\'s '
          + '+25%, Scatterbloom\'s +50%, Nectar-infused Blade\'s x1.3 on its own hits, Bullying the Weak\'s '
          + 'bonus on weapon skills, the crit chance Thrill of the Hunter adds to the finisher that spends '
          + 'its mark, Spark Shot\'s extra hit - a step its script plays rather than a multiplier, under '
          + '35% at any rank and, from weapon rank 3, ABOVE 80% - and Hiveborn Blossom\'s +200% ABOVE 80% '
          + 'from rank 3; those last two are what the default of 100 switches ON. NOT priced on that '
          + 'guard: Blind Breakthrough\'s, which asks a skillId disjunction as well as the health and is '
          + 'named on its own line. Everything else the default does is switch the execute clauses off, '
          + 'and it says which. '
          + `${sites.owner.length} MORE clauses in ${rowsOf(sites.owner).length} rows read the OWNER's health (${names(sites.owner)}) `
          + 'and those stay REFUSED: the target\'s health '
          + 'is one number the player can state, and your own health over a fight is a trajectory this '
          + 'model does not simulate - it never takes damage.';
      })(),
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
      severity: 'assumption',
      what: 'a fight starts COLD: no banked stacks, no food, no pre-cast, nothing carried in from a previous pull',
      why: 'The player\'s convention, and the only one that makes a measured pull reproducible: any pull '
        + 'assumes zero extra resources unless it says otherwise - a food buff, extra stacks of an aura, '
        + 'an enchant buff still running from the last fight, a skill pressed before the combat window. '
        + 'It matters most where a counter carries ACROSS combats, because there the flattering reading '
        + 'and the honest one differ by a factor of two: GS_Nova_Passive_Stack has no authored duration, '
        + 'so its stacks survive the pull, and a meter showing two Anger Release casts in 75s is one '
        + 'earned and one walked in. The model earns both. Anything measured against a warm character '
        + 'has to say so. '
        + 'A WINDOW OF A CAPTURE IS PRICED THE SAME WAY, AND THERE IT IS KNOWN TO BE FALSE (`bench '
        + 'verify --since / --until`): a window cut out of a sitting opens with whatever the sitting '
        + 'left standing, and the model\'s fight opens with nothing. Only the Mage\'s Spark gauge is '
        + 'opened where the log puts it. The 2026-10-13 Rogue\'s sixteen "basics" blocks each open '
        + '1.1-7.0s after a rotation with Lethal Poison on the dummy. In the one recorded after the '
        + 'Envenom point (1791852924707..1791852946824) it had been up 98.8s and was last refreshed '
        + '5.7s before the window: its ticks (11 rows) and Envenom, a base-attack rider gated on it '
        + '(21 rows), run through the whole 22s, and the chain-alone fight such a window is played as '
        + 'has neither line. The ledger files those rows CARRIED-IN - out of MISSING and out of '
        + 'coverage - and names the last press and the statuses the log holds standing at the opening; '
        + 'it does not price them, and it prices the window\'s own lines without what stood (Urge to '
        + 'Kill and Marked were up in that block too). WHAT WOULD SETTLE IT: open the fight with the statuses standing '
        + 'at the window\'s first millisecond - on the target and on the character, with their '
        + 'remaining clocks and stacks, which the status rows carry - and hold the result against those '
        + 'sixteen blocks: Envenom on about half the swings, the poison refreshed by it and never '
        + 'dropping.',
    },
    {
      severity: 'assumption',
      what: 'with the chain held, every timed status on the character that is not a pressed skill\'s own is priced as down - '
        + 'a swing\'s, and a proc\'s or a conduit\'s with them',
      why: '`bench verify` plays a window that holds presses and no base attack with the chain held, and prices as '
        + 'down every status with a duration whose source is not one of the build\'s pressable skills (the ledger '
        + 'names them). That is right for what only a swing applies - Brutal Frenzy, Devote, the Raclette Pan: '
        + 'played, they priced the 2026-10-13 Warrior\'s lone presses 12.9% high - and it is a FLOOR for what a '
        + 'press can raise without owning. READ: Stone of Righteousness is `onInflictDamage(dmg) { if '
        + '(checkProba(vars.chance) && !owner.hasStatus(...)) addStatus(owner, ...) }` - any damage instance, '
        + 'vars.chance 0.05, +10 Faith for 10s, no base-attack guard; Conduit: Power is `onStartConduit() { '
        + 'addStatus(owner, ...) }`, +0.5 MagicMastery a stack up to 20, 15s; Swarm Lord puts Hive Swarm on its '
        + 'owner from `onSkillProc` when the skill is a weapon skill. MEASURED 2026-10-13, in two blocks of lone '
        + 'presses with no swing in them: the Priest\'s (1791847385286..1791847623434) put the Stone up 5 times - '
        + '50.0s of the 170.4s she dealt damage in, 29%, with 62 of her 130 damage rows under it; the Mage\'s '
        + '(1791846110708..1791846313254) held Conduit: Power at 3 of its 20 stacks, +1.5 MagicMastery, on all 70 '
        + 'of her damage rows. Neither is in the model those ledgers print. NOT DONE, because lifting the rule for '
        + 'them takes more than an exemption: (1) the Stone\'s closed-form rate counts one damage instance per '
        + 'swing period beside the casts and ticks, and with the chain held that term has to go, or it is priced '
        + 'on swings nobody made; (2) WHICH statuses a swing raises has to come from the read - the hook\'s guard '
        + '(isBaseAttack / isAttack / isFinalCombo) or the applier being a chain link - not from a list of ids; '
        + '(3) the conduit\'s ramp is the model\'s own cadence: pressed on cooldown it climbs far past the three '
        + 'stacks that block held, so it is the window\'s ramp only under --replay. WHAT SETTLES IT: those two '
        + 'blocks, once the three are in - the Priest\'s lines with the Stone at 29%, the Mage\'s at three stacks.',
    },
    {
      severity: 'verified',
      what: opts.assume.chainResets
        ? 'the base-attack chain drops after ComboWindow (0.6s) without an attack'
        : 'the base-attack chain holds its place through anything (--chain-persists)',
      why: 'Read from ent.Hero.getNextAttackSkill@7811 (ops 41-52: the last used basic\'s stopTime ' +
           'against Const.Hero.ComboWindow, asked when the next attack is requested; the accepted build ' +
           'kept the same test in a function of its own and reset a counter from Hero.update, neither ' +
           'of which exists any more): ONE CUMULATIVE CLOCK, from the END ' +
           'of the last completed basic to the START of the next, never refreshed by a skill ending - ' +
           'so casts, idle and RUNS of short casts all break the chain by the same measure. The fight ' +
           'used to ask two separate questions instead, is THIS cast longer than the window and did I ' +
           'stand still longer than the window, and neither sees two 0.4s Rage Strikes back to back. ' +
           'The 2026-08-02 v2 capture predicts 52/52 basic-chain casts on the one-clock rule; literal ' +
           'start-to-start scores 18/52 and a BANKED finisher 50/52, whose two misses are mid-chain ' +
           'links surviving casts - which banking cannot produce, so that concept is retired rather ' +
           'than modelled. The anchor is the double-Rage-Strike reset: a basic pressed 13ms after the ' +
           'second one ENDED still reset, because 854ms had passed since the last BASIC ended. The ' +
           'measured bracket [597, 854)ms contains the authored 600.',
    },
    {
      severity: 'assumption',
      what: 'the base-attack chain is the weapon\'s own swing rows and its finisher - no padding',
      why: 'READ on build 25782799: ent.Hero.getNextAttackSkill@7811 ops 64-89 return the finisher once ' +
           'the last used basic is the last entry of attackSkills, else the next entry; ' +
           'ent.Hero.updateSkillCache@7812 ops 49-62 fill attackSkills with the hero\'s skills of type ' +
           'Attack..Attack4 whose originItem is the active weapon. moveSet.comboLength, which the ' +
           'accepted build\'s Hero.attack reset its counter against, has NO reader left - its accessor ' +
           'get_comboLength@17283 has no caller - and ent.Hero.attack@7840 no longer touches the moveSet. ' +
           'So a weapon whose item row lists fewer swings than its moveSet says swings exactly what it ' +
           'lists: Flame of Argol one swing and Searing Furnace (the column says 4), Twin Pillars of ' +
           'Justice three and Sentence (it says 5). MEASURED BEFORE THE PATCH, in the capture, and it is ' +
           'the opposite: 190 Flame of Argol wielders swung the same swing three times before the finisher ' +
           '(1,886 + 826 chains) and 54 Twin Pillars wielders A1 A2 A3 A3 (94 + 84) - the old client ' +
           'repeated the LAST declared swing up to comboLength - 1. The bench used to fill those chains ' +
           'with the weapon type\'s other rows (right length, wrong rows); it now fills nothing. NOT ' +
           'MEASURED on this build - the event capture ends 2026-08-28 - and it is the flattering ' +
           'direction: on the scepter the finisher, and every prayer charge and isFinalCombo roll off ' +
           'it, lands twice as often as before. ALSO READ: the list a weapon hands over is built by ' +
           'st.Item.getMainSkillList@8735 - ops 7-39 push every row of the item\'s own `skills` except a ' +
           'WeaponSubSkill (type 8), ops 40-65 append the `skills` of the item\'s TYPE - and what a weapon ' +
           'itemType lists there is one Block row (PhysicalBlock, MagicBlock or ShieldBlock) on every ' +
           'type but the capture net\'s, which lists nothing: no ' +
           'swing and no finisher comes from the type, so the chain is the item\'s own rows. INFERRED, ' +
           'the one bridge left: that st.Item.applySkills@8736, a server stub on this client, gives the ' +
           'hero that list (what calls the builder on this client is st.Item.getSkills@8734 op 73 and the ' +
           'weapon-skill upgrade window; the capture shows the own-rows chain before the patch). Also open: the reset clock is the last BASIC\'s stopTime, which a finisher ' +
           'does not refresh, so a finisher no longer than the 0.6s window (Sentence and Cascade at ' +
           '0.58s, the finisher of Nibsham\'s Liberators at 0.6s) could, as read, be followed by itself ' +
           'once; the fight does not play that. ONE SESSION settles all three: hold attack with Flame of ' +
           'Argol and count the swings between two Searing Furnaces (1 = this reading, 3 = something ' +
           'still pads); the same with Twin Pillars of Justice (3 against 4), watching for two Sentences ' +
           'with no swing between them.',
    },
    {
      severity: 'assumption',
      what: 'a bare isBaseAttack is every swing AND the finisher; isBasicAttack is the swings alone',
      why: 'READ on build 25782799: st.skill.BaseSkill.isBaseAttack@6153 is true for skill types 0-3 (ops ' +
           '7-10, a switch) or type 4 (ops 18-22), and the accessor a script reads as `x.isAttack` ' +
           '(BaseSkillAccess.get_isAttack@5192) is isBaseAttack() || isFinalAttack(); BaseSkill.isBasicAttack@6152 ' +
           'stops at type 3, BaseSkill.isFinalAttack@6154 is type 4. The tooltips keep the split: [Attack] on a row ' +
           'whose script says isBaseAttack, [BasicAttack] ("Base Attack") on one that says isBasicAttack, ' +
           '[ComboAttack] for the finisher. Every reader takes that reach now; three of them used to read ' +
           'a bare isBaseAttack as "not the finisher". NOT MEASURED. One session settles it: Iron Fins of ' +
           'the Leviathan, Groundswell Strike on cooldown, land ONLY combo finishers\' first hits and watch ' +
           'the cooldown - 1.5s back per finisher is this reading, nothing back means the server tests ' +
           'something narrower than the client predicate.',
    },
    {
      severity: 'assumption',
      what: 'a status that plays a step on its wearer\'s swings is priced inside the window its applier opens',
      why: 'Swarmstrike Accord, Abyssal Fury and Blessing put a status on you whose own script plays a ' +
           'damage step on your attacks (onInflictDamage / onInflictHit behind isBaseAttack, isAttack or ' +
           'isFinalCombo). The step is played once per HIT of a qualifying swing while the status is worn: ' +
           'onInflictHit is raised for every hit (BaseSkill.onHit@6233 ops 102-114), and per damage ' +
           'instance is how the pre-patch capture reconciles for onInflictDamage, whose dispatcher is ' +
           'server-side and gone from this client. Abyssal Fury adds a roll (vars.chance, 0.3 and 0.4 from ' +
           'rank 2) and excludes its own blast (`hit.skillId != skill.kind`). Blessing is armed by every ' +
           'weapon skill, vars.var1 stacks deep, and spends one per swing on its first hit, so a window ' +
           'holds that many swings. THREE THINGS ARE NOT IN THE NUMBER and are floors: (1) the blast\'s ' +
           'step carries the BaseAttack flag (the only step in the sheet that does; ' +
           'SkillStep.isBaseAttack@6027 ops 4-9; "Blasted damage is considered as an [Attack]"), so ' +
           'everything else the build ' +
           'pays per `hit.isBaseAttack` - Rage, Groundswell Strike\'s refund, a roll of Cascade\'s Axe - ' +
           'is owed once per blast and is not raised; (2) Blessing\'s rank-3 clause adds the passive\'s ' +
           'vars.chance (0.7) to the critical chance of the swings it empowers, named and not priced; (3) ' +
           'a weapon sub-skill use is a weapon skill too and would re-arm Blessing. MEASURE on a dummy: ' +
           'Abyssal Fury blasts per attack hit inside one window (the chance), and Rage gained per blast ' +
           '(1 = the flag does what its tooltip says).',
    },
    {
      severity: 'assumption',
      what: 'a weapon\'s status rider takes the weapon mix; a rank passive of the same weapon does not',
      why: 'Two riders of Iron Fins of the Leviathan are priced under different scaling rules, and that ' +
           'is the game\'s own test, not an oversight. READ: $HSkill.getStepEffectVal@21774 ops 64-106 ' +
           'hand getStepEffectScaling@21777 the source item - what the 0.6 / 0.4 weapon mix is built ' +
           'from - only when the row whose step hits BaseSkill.isWeaponBased@6164 (skill types 0-4, 6, 7, 8 and ' +
           '24), or its getSourceSkill() is, or its source item is a GearTrinket. A status has no type ' +
           'and asks its instigator skill (Status.getSourceSkill@15829): Abyssal Fury\'s blast is a step ' +
           'of the status Abyssal Fury\'s press applies, so it is the weapon\'s and takes the mix. ' +
           'Cascade\'s Axe has no type either and is nobody\'s status: the finisher\'s props.rankPassives ' +
           'creates it as a skill of its own, parented where the finisher is ' +
           '(BaseSkill.initPassiveSkills@6142 ops 96-99), so it is its own source ' +
           '(BaseSkill.getSourceSkill@6149) and takes no item - 0.2 Strength + 0.2 Dexterity and ' +
           'nothing else, where the blast\'s 0.3 + 0.3 also draws on the weapon. The blast therefore ' +
           'prices at well over the authored 1.5x of an axe (about 2.6x before crits on a naked level-25 ' +
           'Warrior holding a Rare three-star pair). INFERRED: that the status\'s instigator skill is the ' +
           'weapon skill that applied it - the body that sets it is server-side and gone from this ' +
           'client. NOT MEASURED. MEASURE on a dummy, one sheet: a non-critical blast against a ' +
           'non-critical axe - 1.5x means both scale alike (and one of the two prices here is wrong), ' +
           'the ratio `bench` prints for that build means this reading.',
    },
    {
      severity: 'assumption',
      what: 'a rider written in onInflictHit or onInflictDamage is counted once per hit of the swing it rides',
      why: 'READ: BaseSkill.onHit@6233 holds onFirstHit to the first hit (ops 83-88, `hitCount == 1`) and ' +
           'hands EVERY hit to the instigator\'s scripts as onInflictHit (ops 102-114); onInflictDamage is ' +
           'per damage instance (its dispatcher is server-side and gone from this client; per instance ' +
           'is how the pre-patch capture reconciles). So a roll or a playStep written in either hook ' +
           'happens for each hit a swing lands unless its guard says isFirstHit, and that holds whichever ' +
           'reader takes the rider: a row that rolls for itself (Cascade\'s Axe), a step a script plays ' +
           '(Lifestealing, Flaming Weapon, Brutal Frenzy, Sunlight while Solar ' +
           'Devotion keeps it, Purging Strikes) or a status worn in a window (Abyssal Fury, Blessing, ' +
           'Swarmstrike Accord). The script-played ones used to be counted once per SWING, half of what ' +
           'the row beside them was given on a two-hit finisher. A step that deals two kinds of damage ' +
           'in one hit is one onInflictHit and two onInflictDamage, and the fight counts each hook its ' +
           'own way (a cast\'s hits against its damage instances). MEASURED 2026-10-13 on Demonic Bite, ' +
           'whose one step carries a Physical and a Magic effect (827 finishers, a Rogue on the dummy): ' +
           'Flaming Weapon, onInflictHit at 30%, played beside 252 of them and never twice beside one; ' +
           'Gash\'s application, onInflictDamage at 20%, came with 314 (38.0% - two rolls give 36%, one ' +
           '20%). On the one-effect swings of the same chain they count alike: 29.5% and 21.4% of 4,336. ' +
           'Two player rows have such a step today, both dagger finishers. NOT IN THE NUMBER, a ' +
           'floor: a played step that is itself a hit its own guard admits rolls again - Brutal Frenzy\'s ' +
           'second strike is a step of the finisher\'s own row, so it is a finisher hit too - and that ' +
           'chain is not followed; and on a weapon-skill event a rider is still counted once per press. ' +
           'MEASURED BEFORE THE PATCH, in the event capture (2026-08-02 to 08-29; the rows of Sunlight\'s ' +
           'and Purging Strikes\' statuses, Lifestealing and Flaming Weapon are unchanged since), over ' +
           'presses that landed on one target. onInflictDamage: Purging Strikes on the two-hit fourth ' +
           'swing of the fist weapons shows two rows in 315 of the 329 presses that carried it, and one ' +
           'row on 10,487 of 10,560 one-hit first swings of Amon Ram; Sunlight on Castigate\'s four bolts shows four rows ' +
           'in 187 of 261 presses for players who keep it (mean 3.73) and one in 52 of 67 for players ' +
           'who spend it; Purging Strikes on those four bolts shows four rows in 52 of the 57 presses ' +
           'where no Sunlight fired. onInflictHit: a second row on the same target is common on a ' +
           'two-hit swing and all but absent on a one-hit one - Lifestealing on Cheesebane, the two-hit ' +
           'finisher of Twin Fangs of Ratsar, 139 presses with one row and 81 with two; Flaming Weapon ' +
           '56 and 18 on that fourth swing of the fists, against 482 and 16 on Amon Ram\'s one-hit ' +
           'first swing. TWO THINGS THE CAPTURE ' +
           'ADDS. (1) In a press where Sunlight fires, Purging Strikes mostly plays ONCE whatever the ' +
           'hit count: of 317 such four-bolt presses 194 show one row and 90 show four (mean 2.05). ' +
           'Sunlight\'s damage hands Purging Strikes\' status out again mid-press; why that costs the ' +
           'other bolts their play is not read, so a rider whose status another rider\'s fire has just ' +
           '(re)applied on the press is priced for ONE hit of it - a floor on those presses, where four ' +
           'would be the over-read. (2) The chain is real: on the accepted build, when Brutal Frenzy ' +
           'rolled 15% on every attack, 54 of the 411 presses with one bonus hit show a second (13%, ' +
           'the roll\'s own share). (3) A PROJECTILE finisher raises onInflictHit more than once a bolt: ' +
           'Lifestealing on Castigate\'s four bolts shows 5.8 rows a press on the target (397 presses, ' +
           'never none), where four rolls at 50% give 2 and Amon Ram\'s one-hit finisher shows 0.48. The ' +
           'bolt\'s own hit and the step its ProjectileHit plays are each a hit, and an area of the ' +
           'finisher with no effect on it is one too; none of that is counted - an onInflictHit rider on ' +
           'a projectile swing is a floor by about that much. STILL ' +
           'TO MEASURE on this build: Iron Fins of the Leviathan with Magic Formula: ' +
           'Lifestealing, Lifestealing hits per Cascade over a few hundred finishers - one per ' +
           'finisher is this reading (two rolls at 50%), one per two finishers is one roll per swing.',
    },
    {
      severity: 'assumption',
      what: 'a counter the build fills itself is taken as full for the whole fight',
      why: 'Cascade\'s Axe rolls only while Cascade is at its cap - `status.stacks >= status.getMaxStacks()`, ' +
           'the same question as hasStatusMaxStacked written out by hand - and the build stacks Cascade ' +
           'itself, one per finisher, five deep, on a fifteen-second timer the next finisher renews. It is ' +
           'priced as held from the first second, so the swings before the fifth finisher are credited a ' +
           'roll they do not have: about 15s of a 200s fight, the flattering direction, and stated in the ' +
           'rule\'s own sentence. The roll is per HIT of a swing or a finisher (onInflictHit).',
    },
    {
      severity: 'assumption',
      what: 'a recast skill is pressed twice per cooldown, and the cooldown runs from the second press',
      why: 'READ: st.skill.Skill.isCooldownBlocked@9600 is isInCooldown() && !canIgnoreCd(), ' +
           'canIgnoreCd@9601 op 0 asks canForceCast@9647, and that is the script\'s checkForceRecast(). ' +
           'Zealous Spins ' +
           'answers yes for vars.time (3s) after a press that hit, once; Hiveborn Blossom for the 4s its ' +
           'first press puts a status up, once, and its second press carries `if (!firstCast) ' +
           'hit.dmgMult += vars.var1` (+100%). Both enter the fight as a second entry of the same row ' +
           'that only the first press opens. NOT READ: what the second press does to the cooldown - ' +
           'doConsumeCharge@9633 is max(0, charges - 1) after onTriggerCD@9634, and the recharge is ' +
           'server-side - so the cooldown is taken to restart at the second press, the slower reading. ' +
           'Also not priced: Hiveborn\'s rank-2 `magicArmorIgnore += 1` on the second press (named), and ' +
           'a recast written another way (Chaotic Distorsion, Blink) is named as unread. MEASURE: presses ' +
           'of Zealous Spins in 60s on a dummy (cooldown 10: twelve presses = two per cooldown from the ' +
           'first press, about eleven = from the second).',
    },
    {
      severity: 'assumption',
      what: 'a rider is read when its guard is its own blocks, its own skill id, a step of its row, or an attribute',
      why: 'Three riders were refused for questions the bench answers. Honey Crush: `rank >= 2 && ' +
           'dmg.skillId == skill.kind` then `dmg.ctx.totalHits == 1` - its own hits, at one target ' +
           '(--targets). Hiveborn Blossom: `hit.targetUnit.healthRatio > vars.threshold` in a block of ' +
           'its own beside the recast clause, +200% above 80% health from rank 3 - ON at the default ' +
           '--target-health 100, which is a large stated number and is what the row says. Hive Assault: ' +
           '`hit.dmgMult += owner.atb(Attribute.CritChance) / 100` on its Area step from rank 2 - the ' +
           'sheet\'s critical chance, in points, as damage (atb() is the unscaled value; ' +
           'ScriptBase.getAtb@6650 is its x0.01 spelling). And Sentence\'s debuff is ' +
           '`dmg.dmgMult += vars.damage` in the ' +
           'TARGET\'s onReceiveDamageEval (evalDamage@6124 op 173), 5% and 10% from rank 2: it joins the ' +
           'same additive bracket as the attacker\'s riders in game and is multiplied here (as Death Mark ' +
           'is), a small over-read beside another rider. NONE MEASURED on this build. Conquer is the ' +
           'open case in the other direction: its rank-2 +25% is authored twice, as rank-split scaling ' +
           'rows (1.05 / 1.3125) AND as a script rider, and both are applied - Glory at rank 2, a ' +
           'non-crit Conquer against its tooltip: x1.25 over the tooltip is this reading, equal to it ' +
           'means the rider restates the rows.',
    },
    {
      severity: 'assumption',
      what: 'prayers fire when Judgment is pressed, and Sunlight is worn only when something puts it up',
      why: 'READ: each prayer readies itself in its own onSkillProc (Smite on the finisher, Life on a ' +
           'weapon skill of the weapon in hand, Virtue on a skill of the arsenal weapon); ' +
           'PriestComponent.chargePrayer@30856 ops 35-42 hold ONE charge; divineInterventionProc@30855 ops ' +
           '24-32 start every prayer not in cooldown, and its one caller is Judgment\'s own step. ' +
           'MEASURED before the patch (scripts unchanged): 2,052 of one Priest\'s 2,060 Smite casts fall ' +
           'within 1.5s after a Judgment press; the median gap between two Smites over 1,135 players is ' +
           '19.2s. Sunlight is applied when a hit of a skill or a prayer of yours lands on an ally ' +
           '(`(hit.isSkill || isSkillFromPrayer(hit.skill)) && hit.target.isAlly(owner)` in the ' +
           'talent\'s onInflictHit), lasts 6s and is spent by the first finisher unless Solar Devotion ' +
           'is held; Purging Strikes\' status is put up when your own Sunlight deals damage. READ: ' +
           'onInflictHit has one call site on this client, BaseSkill.onHit@6233, and onHit is reached ' +
           'only from a step\'s hit on an entity (SkillStep.hitEntity@6061) or a projectile\'s - a Status ' +
           'step (SkillStep.doApply@6002 case 1) and a script\'s addStatus(owner) raise neither. With no ' +
           'party the ally is you (Hero.isAllyWith@7835 ops 0-2), so the window opens on a press, or a ' +
           'released prayer, of a weapon, class or signature skill one of whose own steps hits its ' +
           'caster: a SelfEffect step (doApply case 12) or an area whose hitFilter carries Self ' +
           '(BaseSkill.checkAlignment@6184 ops 35-42), with or without an effect on it - Faithful ' +
           'Winds, Blessing of Fervor, Prayer: Life and Prayer: Virtue on the Priest\'s own bar. A heal ' +
           'landed by a STATUS the press put up (Depth Shield\'s orbs) does not open it: the hit is the ' +
           'status row\'s, which is no skill by get_isSkill@5193; nor does a buff a script hands you ' +
           '(Judgment, Crusader, Hive\'s Sunder). WHICH WAY THAT ERRS: an area is taken to land on you ' +
           'at the press whenever its filter admits you - you stand in what you cast, as the statuses ' +
           'such an area applies already assume - which flatters a Priest who throws it elsewhere. A ' +
           'LOOPING area lands again on every tick, and you are taken to stay in it: the window runs to ' +
           'its last tick and the status\'s own seconds after it (Faithful Winds\' lane, every 0.5s for ' +
           '10s; Hot, hot, hot!\'s zone for 4s), and a press that deals nothing but lands on its caster ' +
           '(Faithful Winds with no rune) is in the rotation for that alone where the build holds Sunlight - ' +
           'and the fight is played with it and without it, the better kept (the entry on how the rotation ' +
           'is derived says how, and what a press left out is told with). ' +
           'MEASURED 2026-10-13 (Priest at a dummy, Solar Devotion from the head sigil, Faithful Winds ' +
           'under Gustflow pressed about every 16.5s): after each of fifteen casts Sunlight was on her, ' +
           'refreshed every half second for ten and gone 6.0s after the last tick (15.5-16.0s a cast ' +
           'where no other kept it up); all eighteen Sunlight statuses of the session ended by expiry, none by a finisher, ' +
           'and all 65 finishers that landed inside one struck with it - 62 of the rotation\'s 66, where ' +
           'the fight without the lane gave it to about half. STILL A FLOOR: a Sunlight a finisher DOES ' +
           'spend (no Solar Devotion) is armed once per press, although the lane would put it back at ' +
           'its next tick - not measured, that Priest held the sigil. A script-played step that hits its ' +
           'caster opens the window only where its rider is priced and fires whole, a floor; and in a ' +
           'party every ' +
           'ally your areas reach wears a Sunlight too, none of which is in a solo number. JUDGMENT\'S ' +
           'RUNES: Spirited Disciple hands out its status (+5 to both masteries, 10s) only when ' +
           '`prayers == vars.var1` in Judgment\'s own onSkillProc - three ready at the press, by ' +
           'PriestComponent.getChargedPrayerCount@30854 - so the fight counts the prayers each press ' +
           'finds ready, before the release spends them, and puts the status up on those presses alone: ' +
           'a build that cannot ready three (no arsenal weapon, so no Prayer: Virtue) never gets it. ' +
           'That the count is taken before the release is INFERRED from the script\'s order (the proc ' +
           'hook, then the delayed step that releases). Revitalized Soul is a move-speed status, read ' +
           'and worth nothing to damage. NOT PRICED, and a floor: Alacrity (readying a prayer takes 2s ' +
           'off Judgment - named as a rune the model cannot rank) and Surge of Faith (a second off ' +
           'Blessing of Fervor per prayer judged: it came back 107.0 and 102.5s after a press in that ' +
           'rotation, under an authored 120). SMITE, MEASURED the same day: 51 rows for 17 releases - one ' +
           'on each of the yard\'s three dummies every time, its area reaching 20 units - and none on the ' +
           'two Judgment presses made with no finisher since the last release; a release is one Smite ' +
           'per enemy in reach, not one per ready prayer. MEASURE: Judgment presses and Smite casts ' +
           'over 120s without Alacrity (equal, one per 12s); Sunlight procs per finisher without Solar ' +
           'Devotion; and, standing in your own Faithful Winds without Solar Devotion, ' +
           'whether every finisher of its 10s procs Sunlight (the looping read, which would lift the ' +
           'floor that is left) or only the first (what is priced).',
    },
    {
      severity: 'unmodelled',
      what: 'Spark Surge, and the Spark Cube that grants it, are not in any number',
      why: 'SparkSurge is a skill of every hero (unit.BaseHero.skills, level 20), not a Mage one: its ' +
           'script gives 10 Spark particles on the first hit of each cast or swing toward a gauge of 100 ' +
           '(ent.Hero.gainSparkParticle@7958; the HUD is ui.hud.SparkSurgeGauge), and its status banks ' +
           '20% of the damage dealt over 20s and repays it as unmodifiable Raw damage at the end. A Spark ' +
           'Cube - bought from the quartermaster of the Pilgrims of Merilam once their reputation reward ' +
           'is earned, one refillable charge (constant HeroRefillCharges) - grants the same status. If ' +
           'the gauge fills solo at the read rate it would cycle about every thirty seconds and be worth ' +
           'on the order of a tenth of all damage for every class alike, so it moves no gear ranking; it ' +
           'is left out until it is seen: whether player.group is populated when solo (getSparkInfo@31984 ' +
           'loops group.players) and how many first hits fill the gauge are the two things only the game ' +
           'says.',
    },
    {
      severity: 'verified',
      what: 'a cast costs only its own authored duration - no global recovery window',
      why: 'Read from the bytecode: Skill_RecoveryTime\'s only reader is Foe.getSkillRecoveryTime@7043, ' +
           'whose only callers are foe AI (onUseSkillEnd, canAutoPickSkill), and the once-unplaced bare ' +
           '`recoveryTime` symbols resolve to the skill sheet\'s aiProps column - foe-AI data plumbing. ' +
           'No hero path pays any global recovery. The stopwatch agreed first: ten Judgement chains ran ' +
           '~3.0s each, exactly the authored 3.00.',
    },
    // WHAT LEVEL A PIECE STANDS AT - two entries, because the capture holds one
    // half and contradicts the other. The entry used to read "GEAR is
    // authored and keeps both ... gear is unaffected either way" beside a
    // catalog that had been scaling worn armour for months, and cited "the Z3
    // craft rings logged 160 for an authored 15" for rows that author 25.
    // The counts are taken off the sheet as the list is built.
    (() => {
      const armour = cdb.lines('item').filter((i) => cat.isArmorType(i.type));
      const unlevelled = armour.filter((i) => i.level === 1 && i.iLevel === 1);
      const factions = [...new Set(unlevelled.map((i) => i.faction ?? 'no faction'))];
      return {
        severity: 'verified',
        what: 'a WEAPON and a piece of WORN ARMOUR are generated - each stands at the drop\'s level, its row\'s level being a floor - and only a weapon rolls its rarity',
        why: 'The rule is catalog.mjs effectiveLevel. An unpinned weapon (everything under MainhandWeapon or ' +
             'OffhandWeapon in the itemType tree) and an unpinned piece of the eight worn-armour types stand at ' +
             'the higher of their row\'s level and yours: a loot line that carries the item writes the row\'s ' +
             'level into its MINIMUM, not into the item (the line filter fn@21756 ops 3-15). `--drops authored` ' +
             'prices both at their row instead, or at the lowest level a source makes them where every source ' +
             'states one. MEASURED 2026-10-13, snap_gear of four level-25 characters: ' +
             'Night Servant\'s Girdle (Waist_RDemon_FigCle, whose row authors level 1 and iLevel 1) logged ' +
             'level=25;ilevel=260 on the Warrior, six more armour rows of that authoring logged 25 / 260 on the ' +
             'other three and Belt of Sacrifice (Waist_RDemon_Cle) level=24;ilevel=250 on the Priest; every ' +
             'worn armour row that authors no level logged 25 / 260; Judgement (GA_Craft, row level 4) logged ' +
             `level=25;ilevel=300 as Epic. ${unlevelled.length} armour rows author level 1 / iLevel 1 on this build, ` +
             `all of faction ${factions.join(', ')}; held to their row, three slots of a worn set priced at iLevel 11. ` +
             'A piece that is not a weapon is never promoted past its row\'s rarity. A weapon\'s DAMAGE line ' +
             'still follows its trained level rather than its drop, verified on a real Cheese Moon: trained to ' +
             'weapon level 25 it shows the effective-level-11 stat budget while its damage line reads 18-21, ' +
             'the full primary budget at the trained level. A ^N pin still names an instance exactly. What a ' +
             'necklace, a ring or a crafted piece stands at is the next entry: it is not verified.',
      };
    })(),
    (() => {
      const jewels = cdb.lines('item').filter((i) => i.type === 'GearNeck' || i.type === 'GearFinger');
      const levelled = jewels.filter((i) => i.level != null).length;
      return {
        severity: 'assumption',
        what: 'jewellery is priced at the level its row authors - and the capture logged two necklaces ABOVE theirs',
        why: 'Necks and rings are not in the set `--drops scaled` raises, so one is priced at its row\'s level ' +
             `whatever yours is (${levelled} of the ${jewels.length} jewellery rows author one). NOT HELD by the ` +
             'capture of 2026-10-13: Necklace of Fracture (Necklace_Z2_Ap) and Necklace of Clarity ' +
             '(Necklace_Z2_Mp) both author level 15, both carry the WorldLoot flag, and they logged ' +
             'level=17;ilevel=170 - in all 18 of the Rogue\'s snapshots and in the Priest\'s - where the model ' +
             'prices iLevel 150. So a world-loot necklace\'s row level is a floor at least, as worn armour\'s is. ' +
             'Whether it stands at its source\'s level all the way (the same row at 250 from a level-25 drop) ' +
             'these rows cannot say: both characters are level 25 and wear a 17. What the rule was built on is ' +
             'a player\'s report ("amulets and rings are capped") and earlier logs of CRAFTED pieces - Pendant ' +
             'of Adaptability (Necklace_Z2RCraft) at iLevel 210 for its authored 20 on a level-25 character - ' +
             'and a crafted piece stands at its recipe\'s level by a rule of its own (catalog.mjs: nothing ' +
             'drops it). This capture logs level=0 and no item level for every crafted piece worn - the Z3 ' +
             'craft rings, Pendant of Adaptability, the crafted Demon helms - so it neither confirms nor ' +
             'refutes the crafted half; that one rests on the logs of the previous build. WHAT IT COSTS: the two ' +
             'necklaces are priced 20 item levels under what was worn, and Necklace of Clarity is the Neck ' +
             'piece the default Mage build prints. WHAT SETTLES IT: the item level on the tooltip of a ' +
             'necklace or a ring that is not crafted, picked up at level 25; or the level a world-loot roll ' +
             'hands the item it makes (fn@21756 is a loot TABLE line\'s filter; the world-loot path is not read).',
      };
    })(),
    {
      severity: 'verified',
      what: 'a `Mono` step never cleaves, whatever area it carries',
      why: 'Read from AreaStep.areaHit@6077 (SkillStep.hx:1998-2071 on build 25959898): hitCount starts at -1 for ' +
           'unlimited, `if (inf.type == Mono) hitCount = 1`, and the priority hit DECREMENTS it before ' +
           'the `if (hitCount == 0) return null` at L2034-2035 (ops 84-87) - so the GameLayer.find shape query at op 154 ' +
           'is never reached and props.area is dead for that cast. With no priority target the sweep ' +
           'does run, and L2067-2071 (ops 226-271) then trims the result to the single NEAREST object. A Mono step ' +
           'IS an AreaStep at runtime (isAreaStep@6066 returns true for type 0) and does run the ' +
           'swept-shape routine, which is why the cone matters: it decides WHICH enemy and whether you ' +
           'connect at all, never how many. The only override is the step-level props.hitCount, and ' +
           // Counted off the sheet as the list is built (it read "all six ...
           // all 80 Mono-with-area rows" over a sheet of 85 such steps).
           (() => {
             const stepTypes = cdb.enumValues('skill@steps', 'type');
             const steps = cdb.lines('skill').flatMap((s) => (s.steps ?? []).map((st) => ({ s, st })));
             const counts = steps.filter((x) => x.st.props?.hitCount != null).map((x) => x.st.props.hitCount);
             const mono = steps.filter((x) => stepTypes[x.st.type] === 'Mono' && x.st.props?.area != null);
             const other = counts.filter((v) => v !== 1);
             const where = `${mono.length} Mono steps that carry an area (in ${new Set(mono.map((x) => x.s.id)).size} rows)`;
             return other.length
               ? `${counts.length - other.length} of its ${counts.length} occurrences in data.cdb hold the value 1 and ${other.length} another ` +
                 `(${[...new Set(other)].join(', ')}), which this reader does not follow. So the ${where} resolve identically where the count is 1 or absent, `
               : `all ${counts.length} of its occurrences in data.cdb hold the value 1. So all ${where} resolve identically `;
           })() +
           'and the two the model used to call contradictory do not: ' +
           'DM_Base_Attack1\'s "to nearby enemies" is loose flavour text against Daggers_Base_Attack\'s ' +
           '"to an enemy", and the code agrees with the second. `forceMono`, which the roadmap named as ' +
           'the read that would settle this, turns out to be a heaps.io audio local (hxd.snd.openal) ' +
           'with no connection to skill steps at all - a string-table collision.',
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
    // INFUSION. Computed from the install rather than typed, so a patch that
    // adds a set, moves a cap or opens a heroic changes these sentences too.
    //
    // A CAST ARMED BY WALKING INTO WHAT A PASSIVE DROPS. Its rate was in no
    // entry: the timer and the count are authored and were read, and "every
    // drop is collected" rode along unsaid - on a line that is a fourteenth
    // of the default Priest build and the margin its main hand is chosen by.
    // Built from the rows that have the shape, so a second weapon with a
    // ground pickup is listed the day it ships.
    (() => {
      let memo = null;
      const rows = () => (memo ??= plan.stackProcsOf([...cdb.byId('skill').keys()], { rank: 3 })
        .filter((sp) => sp.on === 'timer' && sp.drop));
      const nameOf = (id) => cdb.byId('skill').get(id)?.texts?.name ?? id;
      const carrier = (id) => cat.items.find((it) => (it.skills ?? []).includes(id))?.name ?? null;
      return {
        severity: 'assumption',
        get what() {
          const r = rows();
          return r.length
            ? `${r.map((sp) => nameOf(sp.from)).join(', ')}: a cast armed by walking into what a passive drops is priced with every drop collected - an input (--pickups), not a measurement`
            : 'no row of this install arms a cast by ground pickups';
        },
        get why() {
          return rows().map((sp) => {
            const d = sp.drop;
            const extra = d.others.map((o) => {
              const body = cdb.byId('skill').get(sp.from)?.script ?? '';
              const at = body.indexOf(`function ${o.hook}`);
              const seg = at < 0 ? '' : body.slice(at, body.indexOf('\nfunction ', at + 1) < 0 ? undefined : body.indexOf('\nfunction ', at + 1));
              const consumed = /\.kind\s*==\s*(?:Skill\.)?(\w+)/.exec(seg)?.[1];
              return `${o.hook}${consumed ? `, when ${nameOf(consumed)} is consumed` : ''}${o.minRank ? `, from weapon rank ${o.minRank}` : ''}`;
            });
            return `${nameOf(sp.from)}${carrier(sp.from) ? ` (${carrier(sp.from)})` : ''}. READ: the passive's onRegUpdate plays its `
              + `${d.step} step every ${d.every}s while the hero is in combat, and starts its timer over out of it. The step is an area`
              + (d.radius != null ? ` of radius ${d.radius}` : '')
              + (d.from != null && d.to != null ? ` at a random spot ${d.from} to ${d.to} units from the hero` : '')
              + (d.lasts != null ? ` that lies ${d.lasts}s` : '')
              + `; the row's onHit, when the hero stands in it, removes it and adds one stack of ${sp.counter}`
              + (d.heldWhileArmed ? ' - and does neither while the armed status waits to be spent' : '')
              + `; at ${sp.cap} stacks that counter's own script hands over the status whose skillOverride puts `
              + `${nameOf(sp.skill)} on the signature slot. So the DROPS are one per ${d.every}s, and a cast is ${sp.cap} of them `
              + 'COLLECTED. ASSUMED: every drop is collected the moment it lands - one cast per '
              + `${sp.period}s of combat from a cold start, with no step toward a drop and no press for the cast billed. `
              + 'That is --pickups 1, the default; it is the read with nothing subtracted, and it is NOT MEASURED on '
              + 'this build. IT READS HIGH by every drop that is missed, every swing lost walking to one, the '
              + 'seconds of the cast itself'
              + (d.heldWhileArmed ? ', and every drop that lands while the cast waits to be pressed' : '')
              + '. '
              + (extra.length
                ? `IT READS LOW by the drops the timer does not make: the same step is played from ${extra.join('; ')} - `
                  + 'not counted. '
                : '')
              + 'WHAT IT DECIDES: a build that holds the row prints the line\'s size and the share it was priced '
              + 'at beside its number, and a main hand that leads the next one by less than that line is '
              + 'chosen on this input. --pickups <0..1> states the share you collect: at 0.5 it is one cast per '
              + `${sp.period * 2}s. NOT ONE RULE YET: where a set passive drops objects to walk onto, the pickup is `
              + 'refused outright ("nothing in the data says how often that is") although its drops are authored '
              + 'as these are and only the share collected is missing. Pricing that pickup at the same stated '
              + 'share would be the one rule; today one is priced at a share and the other at none. '
              + 'WHAT SETTLES IT: on a dummy, '
              + 'two minutes with the weapon, walking into what you can without dropping the chain - the '
              + `casts x ${sp.period} over the seconds fought is the share.`;
          }).join(' ') || 'Nothing to say: the shape is absent from this sheet.';
        },
      };
    })(),
    // A STEP PLAYED FOR A SKILL DIFFERENT FROM THE LAST ONE THAT PLAYED IT:
    // read, and open. The rows are found by the script's shape.
    (() => {
      let memo = null;
      const rows = () => (memo ??= cdb.lines('skill').map((s) => ({ s, m: plan.lastFiredOf(s.id) })).filter((x) => x.m));
      const nameOf = (id) => cdb.byId('skill').get(id)?.texts?.name ?? id;
      return {
        severity: 'unmodelled',
        get what() {
          const r = rows();
          return r.length
            ? `${r.map((x) => x.s.texts?.name ?? x.s.id).join(', ')}: a step played for a skill different from the last one that played it is read and not priced`
            : 'no row of this install plays a step for a skill different from the last one that played it';
        },
        get why() {
          return rows().map(({ s, m }) => {
            const step = (s.steps ?? []).find((x) => x.id === m.step);
            const carrier = cat.items.find((it) => (it.skills ?? []).includes(s.id))?.name ?? null;
            const onHit = /function\s+onHit\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(s.script ?? '')?.[1] ?? '';
            const lands = /addStatus\s*\(\s*\w+\.target\s*,\s*(?:Skill\.)?(\w+)/.exec(onHit)?.[1] ?? null;
            const landsRank = lands ? Number(/\brank\s*>=\s*(\d+)/.exec(onHit)?.[1] ?? 0) : 0;
            return `${s.texts?.name ?? s.id}${carrier ? ` (${carrier})` : ''}. READ: the script keeps, in a variable of its own that starts `
              + `empty, the kind of the last skill that played its ${m.step} step, and plays the step on `
              + `${m.firstHit ? 'the first hit of ' : ''}${m.events.join(' or ') || 'a skill'} whose kind is not that one - so the `
              + 'first such cast of a fight always plays it, and the same skill twice running plays it once. '
              + (step?.range != null ? `The step is an area of range ${step.range} played with no target, around the hero. ` : '')
              + 'The fight raises both events and has no such memory for a RIDER; it has one for income (Combo '
              + 'Points pay "a skill different from the last one that paid"). So the row is NOT PRICED, and a '
              + 'build that holds it is told so and reads LOW by one play for every cast the guard lets through '
              + '- in a rotation that alternates its weapon skills and the finisher, nearly every one. WHAT '
              + 'PRICING IT MUST CARRY: the memory is of the skill that last FIRED the step, not of the last '
              + 'skill used; only a cast\'s first hit counts; the foe has to be taken to stand in an area that '
              + 'is centred on the hero'
              + (lands
                ? `; and${landsRank ? ` from weapon rank ${landsRank}` : ''} each hit of the step puts ${nameOf(lands)} on what it `
                  + 'hits, which is one more status landing - and, where its type is flagged crowd control, one '
                  + 'more attempt - for everything that counts those, to be counted once'
                : '')
              + '. WHAT SETTLES THE READ: on a dummy, one weapon skill twice running and then the other - the '
              + 'log shows the step after the first and the third press and not after the second.';
          }).join(' ') || 'Nothing to say: the shape is absent from this sheet.';
        },
      };
    })(),
    // A HEAL SIZED AS A SHARE OF A HIT. Two readers price it (a bleed's share,
    // a named row's share) and neither said what it leaves out.
    (() => {
      let memo = null;
      const rows = () => (memo ??= (() => {
        const kinds = cdb.enumValues('skill@steps@effects', 'effect');
        const shaped = cdb.lines('skill').filter((s) => s.script
          && /setDynVal\s*\(\s*\d+\s*,\s*\w+\.amount\s*\*\s*vars\.\w+/.test(s.script)
          && (s.steps ?? []).some((st) => (st.effects ?? []).some((e) => kinds[e.effect] === 'Heal' && e.dynVal != null)));
        const priced = shaped.map((s) => ({ s, mods: plan.talentModifiers(s.id, 1).filter((m) => m.field === 'healShare') }))
          .filter((x) => x.mods.length);
        return { shaped, priced };
      })());
      const nameOf = (id) => cdb.byId('skill').get(id)?.texts?.name ?? id;
      return {
        severity: 'assumption',
        get what() {
          const { priced } = rows();
          return `a heal a script sizes as a share of a hit is priced at the bare share (${priced.map((x) => x.s.texts?.name ?? x.s.id).join(', ') || 'no row today'}) - read, not measured`;
        },
        get why() {
          const { shaped, priced } = rows();
          const said = priced.map(({ s, mods }) => mods.map((m) => `${s.texts?.name ?? s.id}: ${Math.round(m.amount * 100)}% at one point, of `
            + (m.scope === 'one-skill' ? `what ${nameOf(m.skill)} deals, on that row's own line`
              : m.statusType ? `what a ${m.statusType}-typed status of yours deals, on its ticks` : 'the hits its guard names')).join('; ')).join('. ');
          const rest = shaped.filter((s) => !priced.some((x) => x.s === s)).map((s) => s.texts?.name ?? s.id);
          return 'The script writes `setDynVal(n, dmg.amount * vars.x)` and plays a step whose one effect is a heal of '
            + 'that dynVal, so the amount is in no row: it is the damage as it landed - critical strike and the '
            + `target's resistance in - times the var. ${shaped.length} rows of the sheet write a heal that way, and the talent `
            + `reader prices the ${priced.length} whose only guard is a status type or one skill's id. ${said}. `
            + 'The recipient is `owner`, or the wearer of the status that dealt the hit where that status is one a '
            + 'hero wears - in this fight of one hero, the hero either way. NOT READ: what the server then does '
            + 'to a heal whose amount is a dynVal. The step\'s dispatch is server-side on this client, so whether '
            + 'HealGivenMultiplier multiplies it, or a critical heal, is not known, and it is priced at the '
            + 'bare share - a floor if they do. NOT MEASURED: the probe logs damage, statuses and presses, and '
            + 'no heal. '
            + (rest.length
              ? `NOT READ BY THIS READER: ${rest.join(', ')} - the share stands behind a rune, a rank or a count there, `
                + 'and each is whatever the step reader makes of it, said beside the build. '
              : '')
            + 'WHAT SETTLES IT: the heal number the game floats beside one such hit, against the hit: the var '
            + 'times the hit is this reading, that times your HealGivenMultiplier the other.';
        },
      };
    })(),
    // ...and computed LATE. Where a pattern comes from is read out of the level
    // archives and the bytecode (sources.mjs) - over half a second - and an
    // engine is built by every command, most of which never print the audit.
    // So each sentence is a getter over one memoised read: the list has its
    // entries from the start and pays for them the first time one is read.
    ...(cat.infusions.size ? (() => {
      const ids = [...cat.infusions.keys()];
      const caps = cat.infusionCaps;
      const top = caps.length;
      let memo = null;
      const I = () => (memo ??= (() => {
      const reads = ids.map((id) => infusionPlan.read(id, top));
      const skillRows = cdb.byId('skill');
      // An infusion's amounts sit on its own row AND on the rows of the
      // statuses and skills it hands over, so the census walks the family -
      // every row the reader reached, whether its effect is scored or
      // refused (walking only the refused rows dropped a set from the count
      // the day its status was priced).
      const scalesOnAll = (rowId) => (skillRows.get(rowId)?.steps ?? [])
        .some((s) => (s.effects ?? []).some((e) => (e.scaling ?? []).some((x) => x.atb === 'AllAttributes')));
      const onAll = ids.filter((id, i) => [...reads[i].family].some(scalesOnAll));
      const sources = ids.map((id) => ({ id, name: cat.infusions.get(id).name, ...cat.infusionSource(id) }));
      const shut = sources.filter((s) => s.state === 'unreleased');
      const unread = sources.filter((s) => s.state === 'unknown');
      const live = sources.filter((s) => s.state === 'live');
      // What one lit bonus line is worth per armour slot at the level cap.
      const perSlot = cat.combatSlots().map((slot) => {
        const it = cat.items.find((x) => x.slots.includes(slot.id) && cat.canInfuse(x));
        const stat = it ? cat.infusionBonusPool(it)[0] : null;
        return it && stat ? cat.infusionBonus(it, stat, { charLevel: ctx.consts.maxLevel }) : null;
      }).filter((v) => v != null);
      const bonusValues = [...new Set(perSlot)].sort((a, b) => b - a);
      // The measurement that settles the attach: a learnable infusion whose
      // second-rank row is one flat stat, so the sheet shows it or does not.
      const probe = live.map((s) => ({ s, rows: infusionPlan.read(s.id, Math.min(2, top)).affixes }))
        .find((x) => x.rows.length === 1 && ctx.affix.kindOf(x.rows[0].ref) === 'flat');
      return { reads, onAll, shut, unread, live, perSlot, bonusValues, probe };
      })());
      // WHAT THE 2026-10-13 CAPTURE HOLDS OF INFUSIONS, all of it from OTHER
      // players. The probe snapshots only the character it runs on, and none
      // of the four it ran on wore a set; but everybody fighting near them is
      // in the same log, and these entries used to say "no infused character
      // has been captured" over ten thousand rows of theirs. Counted from
      // bench-probe.csv, rows whose skill id is an infusion row's (the 313
      // rows of the Rogue talent Venom Infusion are not): which damage row
      // stands beside each row of a set, per wearer, per target. What such
      // rows can say is WHEN a set fires and how often, and a ratio between
      // two lines of one wearer; never an amount, because no wearer's sheet
      // or set rank is logged.
      const OTHERS_INFUSION_ROWS = { rows: 9657, ids: 20, sources: 33 };
      // ...and what they hold of each row an entry below prices, keyed by the
      // row that was MEASURED: a set this table does not name is told what to
      // measure, as before. Every number is a count of rows (the slicing
      // rule is the sentence it is quoted in).
      const SEEN = {
        // Hive Venom's status. `perStack` is the mean tick over the stacks on
        // the foe at that tick, by stack count, on targets only that wearer's
        // set ticked; `ratio` is the Seals' on-attack row (non-critical) over
        // one stack's tick for the wearers of both sets, on one target level.
        Infusion_Bee_DPS_Dot: {
          wearers: 14, ticks: 334, crits: 0, gaps: 279, gapsAtTick: 274,
          refreshes: 2410, refreshesAtCap: 2286,
          perStack: [[[1, 12.0], [2, 12.5], [3, 11.9], [4, 10.8], [5, 11.6]], [[2, 18.0], [3, 18.3], [4, 17.5], [5, 18.2]], [[1, 11.0], [3, 11.0], [5, 11.2]]],
          landings: { targets: 56, own: 960, others: 985, equal: 40 },
          ratio: [{ value: 1.76, wrath: 49, ticks: 27, level: 25 }, { value: 1.76, wrath: 32, ticks: 14, level: 25 }],
          ratioOff: { value: 1.47, wrath: 8, ticks: 5 },
        },
        // Fermentation's debuff, on targets only one wearer stacked it on.
        Infusion_Kobold_Support_Status: {
          wearers: 12, wsRows: 1010, wsWithApplication: 993, applications: 1016, besideWs: 993, besideNothing: 18, besideOther: 5,
          mostStacks: 5, spendRows: 0,
        },
        // Seals of Atonement. `finishers` are the multi-bolt ones: [casts,
        // damage rows, on-attack rows that follow].
        Infusion_Crimson_Support: {
          wearers: 8, rows: 531, onAttack: 529, smite: 2, smiteAmount: 53, smiteWearerOnAttack: 21.2, smiteWearerCrit: 31.6,
          own: 545, followed: 529, summonRows: 89, weaponSkillRows: 171,
          finishers: [[3, 12, 12], [5, 20, 20], [1, 4, 4]],
          windows: 150, refreshes: 312, forceEnded: 21, forceEndedWithPeace: 19,
        },
        // Overwhelming Tides' debuff: a stun tried on a unit that refuses one.
        Infusion_Manfish_DPS_Status: { wearers: 3, applications: 26, stunTries: 4, stunLanded: 0, debuffBeside: 4, stunRowsInLog: 1135, stunRowsOnNoStun: 0 },
      };
      // The Seals' on-attack row as the sheet authors it - the yardstick the
      // rows of two sets on one wearer are held against (their ratio needs
      // no sheet). Named by the step the script plays under Seal of Wrath.
      const sealsOnAttack = (() => {
        const row = cdb.byId('skill').get('Infusion_Crimson_Support');
        const sc = (row?.steps ?? []).find((s) => s.id === 'WrathDmg')?.effects?.[0]?.scaling;
        return sc?.length === 1 ? { name: row.texts?.name ?? row.id, ratio: sc[0].ratio, atb: sc[0].atb } : null;
      })();
      return [
        {
          severity: 'assumption',
          what: `an infusion set is attached from its first cap (${caps.join(' / ')} pieces), at the SET's own rank`,
          get why() { const { probe } = I(); return 'Read: the rank is how many of Item_InfusionCaps the count of equipped pieces carrying the same infusion '
            + 'reaches ($HInfusion.getRankFromStacks@21691, counted per id by ent.Hero.refreshInfusions@7739), and only '
            + `armour of ${cat.infusionMinRarity} or better with a faction can carry one ($HInfusion.canBeInfused@21689). `
            + 'That rank is its own namespace - not --rank, which is weapon mastery. INFERRED: that the passive exists '
            + 'only from the first cap and runs at that rank - the lines that add the skill are compiled out of this '
            + 'client with the rest of the server, and the game titles the ranks '
            + `${caps.map((c) => `"(${c}) Set"`).join(' / ')}. If one infused piece already attached the skill at rank 0, `
            + 'every minRank row would be live from the first piece. Settle it at the infusion station: infuse exactly '
            + 'ONE piece'
            + (probe
              ? ` with ${probe.s.name}, whose (${caps[1] ?? caps[0]}) Set row is ${probe.rows[0].val >= 0 ? '+' : ''}${probe.rows[0].val} `
                + `${probe.rows[0].target.attribute}, on a piece of ANOTHER faction that is not Prismatic (so its bonus line `
                + `stays dark and cannot be mistaken for the row), and read ${probe.rows[0].target.attribute} on the `
                + 'character sheet before and after'
              : ' and read the character sheet before and after')
            + '. No change: the rule here stands.'; },
        },
        {
          severity: 'assumption',
          what: 'an infused piece pays a bonus rating only while it is lit, and only when its roll is stated',
          get why() { const { perSlot, bonusValues } = I(); return 'Read: st.item.Gear.getInfusionBonusAffix@9767 = round(Item_InfusionBonusRatio x '
            + '$HItem.computeAtbScaling@21737 of the InfusionBonus row for the rolled stat, at the piece\'s own item '
            + 'level, NOT divided by its aptitude count); lit when the piece has a rolled stat AND an infusion AND is '
            + 'Prismatic or its faction is the infusion pattern\'s (st.item.Gear.isInfusionBonusActive@9766) - it does '
            + 'not read the set rank, so one matched piece alone is paid. '
            // What a Prismatic piece IS, and how often: the one use
            // Item_PrismaticChance has here. It is a loot roll, so it is said
            // and never priced.
            + (ctx.consts.infusion.prismaticChance > 0
              ? `Prismatic is a flag rolled with the stat when the piece is looted: ${+(ctx.consts.infusion.prismaticChance * 100).toFixed(2)}% `
                + 'of looted pieces that can be infused carry it (Item_PrismaticChance, ent.Hero.makeLootItem@7953 ops '
                + '454-463, through st.Player.rollLuck@8178 - which adds the bonus of the luck counter the code names '
                + '`Luck_PrismaticGear` while the hero carries that counter\'s status inside an instance; that bonus is '
                + 'not read here). It is the game\'s roll and not a choice, so the search never assumes it: only a pin '
                + '(a trailing `!`) or a dump states it. '
              : '')
            + 'At level '
            + `${ctx.consts.maxLevel} the line is ${bonusValues.map((v) => '+' + v).join(' / ')} by slot, `
            + `${perSlot.reduce((s, v) => s + v, 0)} rating over ${perSlot.length} lit pieces. The stat is rolled when the `
            + 'piece is looted ($HInfusion.pickInfusionBonusStat@21694, from the ratings the piece does not already '
            + 'pay), so a build nobody owns has no stat to price: it is 0 unless a pin, a dump or --infusion-stat '
            + 'states one, and the build table says how much that leaves out. NOT measured in game - the server '
            + 'applies affixes (st.Item.applyAffixes is a server stub in this client). Hover one infused piece and read '
            + `the number in its infusion bonus block: ${bonusValues[0] ?? '?'} on a chest at the level cap confirms both `
            + 'the formula and the item level this bench gives the piece.'; },
        },
        {
          severity: 'assumption',
          get what() { const { reads } = I(); return `what ${reads.filter((r) => r.priced.length || r.buffs.length).length} of the ${ids.length} infusion scripts do in a fight is scored, at the set's own rank; the rest is refused by name`; },
          get why() { const { reads, onAll } = I(); return `Each set passive is one scripted effect, attribute rows from its (${caps[1] ?? '?'}) Set rank and a `
            + `scripted branch at its (${caps[2] ?? '?'}) Set rank. The rows are priced, as the permanent skill affixes `
            + 'they are. The SCRIPT is read where the hook a call is written in and the guard in front of it name an '
            + 'event this fight raises, and what it does there enters the fight BESIDE the rotation, never through '
            + 'it: a status that ticks, a debuff an event stacks on the foe, a step played on an event, a cast a '
            + 'counter arms, each with a profile read at the SET\'s rank - so a rank test in the script, a minRank '
            + 'on a step and a rankOverride on a var are answered by the pieces worn and never by --rank. At the '
            + `(${caps[top - 1]}) Set rank that is: `
            + reads.filter((r) => r.labels.length || r.buffs.length)
              .map((r) => `${r.name} - ${[...r.buffs.map((x) => `${x.name ?? x.status} at its cap (${x.trigger.why})`), ...r.labels].join('; ')}`).join('. ')
            + '. READ, and MEASURED ONLY IN PART. None of the four characters the 2026-10-13 capture snapshots '
            + 'wears an infusion, so no line of one was ever held against a known sheet: every AMOUNT is the row, '
            + 'the script and the bytecode. But other players fought beside them, and the log holds '
            + `${OTHERS_INFUSION_ROWS.rows.toLocaleString('en-US')} rows of ${OTHERS_INFUSION_ROWS.ids} infusion statuses and steps from `
            + `${OTHERS_INFUSION_ROWS.sources} of them - no build, no sheet and no set rank of theirs, since the probe `
            + 'snapshots only the character it runs on. Those rows settle WHEN three sets fire and how often, '
            + 'and the entries below say so sentence by sentence, with the counts; what they cannot show is '
            + 'named there too, with the measurement that would. REFUSED, by name beside the build with the reason the reader '
            + 'stopped: '
            + reads.filter((r) => r.unpriced.length).map((r) => `${r.name} (${r.unpriced.length})`).join(', ')
            + ' - a hook that waits on something this fight never does (a foe dying, you being hit or blocking, an '
            + 'object walked onto, an ally healed), a guard about state it does not hold, a shape no part is built '
            + 'for. Reached means by a script line, or by a step that applies a status or summons a unit - the '
            + `links are followed, not just the script text. ${onAll.length} of the ${ids.length} scale their amounts on `
            + 'AllAttributes, the mean of the four main attributes ($HSkill.getStepEffectScaling@21777), and none '
            + 'takes the weapon mix: InfusionPassive (type 27) and the skills a set unlocks (type 11) are outside '
            + 'BaseSkill.isWeaponBased@6164 (types 0-4, 6, 7, 8, 24).'; },
        },
        ...(() => {
          // One entry per SHAPE the reader built a part from, each present only
          // when a row of this install has it and naming the rows that do.
          const withPart = (pick) => { const { reads } = I(); return reads.filter((r) => pick(r.fight)); };
          const names = (rs) => rs.map((r) => r.name).join(', ');
          const skillName = (sid) => cdb.byId('skill').get(sid)?.texts?.name ?? sid;
          const entry = (pick, what, why) => ({
            severity: 'assumption',
            get what() { return what(withPart(pick)); },
            get why() { return why(withPart(pick)); },
          });
          // The rows a hero can use - a weapon's skills, a class's - that
          // author a knock with NO force at any rank, found by shape with the
          // profile's own test (`knockForce` in damage.mjs) and named by the
          // row; a base attack has no name of its own, so it is its id, its
          // type and the weapons that carry it.
          const unforcedKnocks = () => {
            const carriedBy = new Map();
            for (const it of cat.items) {
              for (const sid of it.skills ?? []) {
                if (!carriedBy.has(sid)) carriedBy.set(sid, []);
                carriedBy.get(sid).push(it.name);
              }
            }
            const usable = new Set([...carriedBy.keys(),
              ...cat.classes.flatMap((c) => (cdb.byId('unit').get(c.unit)?.skills ?? []).map((s) => s.skill ?? s.ref))]);
            const typeNames = cdb.enumValues('skill', 'type');
            return cdb.lines('skill')
              .filter((s) => usable.has(s.id) && (s.steps ?? []).some((st) => (st.effects ?? [])
                .some((e) => e.sideEffects?.knockBack && !combat.knockForce(e.sideEffects.knockBack))))
              .map((s) => s.texts?.name
                ?? `${s.id} (${typeNames[s.type] ?? 'a skill'} of ${(carriedBy.get(s.id) ?? []).join(', ') || 'no item'})`);
          };
          // NoPushback: who carries it (flags merged down the inheritance, as
          // the game merges them) and which of this bench's named targets do.
          const noPushback = () => {
            if (!cdb.enumValues('unit', 'flags').includes('NoPushback')) return null;
            const rows = cdb.lines('unit');
            const has = (id) => combat.unitFlags(id).includes('NoPushback');
            return {
              count: rows.filter((u) => has(u.id)).length, of: rows.length,
              presets: combat.foes.filter((n) => combat.namedTargets[n].unit && has(combat.namedTargets[n].unit)).map((n) => `\`${n}\``),
            };
          };
          return [
            entry((f) => f.dots.some((d) => d.on === 'status-apply'),
              (rs) => (rs.length ? `${names(rs)}: a status on the foe that every OTHER status you land applies` : 'no infusion on this build rides the statuses you land'),
              (rs) => rs.map((r) => {
                const d = r.fight.dots.find((x) => x.on === 'status-apply');
                const e = (d.prof.effects ?? []).find((x) => x.kind === 'Damage' && (x.scaling ?? []).length);
                const amount = e ? e.scaling.map((x) => `${x.ratio} x ${x.atb}`).join(' + ') : 'its amount';
                const ticks = Math.max(1, Math.floor(d.duration / d.tick + 1e-9));
                // The types of the status the game flags a DoT: what the
                // build's own typed readers find on the foe when it is there.
                const dotTypes = (d.types ?? []).filter((t) => cdb.flagNames('statusType', 'flags', cdb.byId('statusType').get(t)?.flags ?? 0).includes('DoT'));
                const seen = SEEN[d.status] ?? null;
                const list = (a) => a.map(([n, v]) => `${v.toFixed(1)} at ${n}`).join(', ');
                return `${r.name} puts a stack of ${d.name} on a foe whenever a status of yours lands on it, its own excepted. `
                  + 'READ: the hook is onInflictStatusEval and its one dispatch site is ent.GameObject.addStacks@4637 '
                  + 'ops 23-77, which run it on every skill and status of the applied status\'s instigator on EVERY '
                  + 'application - before the cap at ops 130-144, so a re-application at full stacks counts - and ops '
                  + '153-156 refresh the window each time. The status reads the rank of the skill that applied it '
                  + '(Status.get_rank@15802), so its branches are the set\'s. PRICED: one stack per application, to '
                  + `${d.stacks}, each tick ${amount}${e?.spread ? ` / ${ticks} (the loop is flagged SpreadEffects: the amount is the total over its ${ticks} ticks)` : ''} `
                  + `per stack every ${d.tick}s, multiplied by the stacks on the foe at the tick${d.prof.tickCanCrit ? '' : ', with no crit chance of its own (its type carries the DoT flag)'}. `
                  + (dotTypes.length
                    ? `TO THE BUILD'S OWN READERS it is a ${dotTypes.join(' / ')}-typed status on the foe like any other, because the `
                      + 'game\'s tests ask the status and not who applied it: one more to a count of them on the target '
                      + '(ent.GameObject.getStatusesCount@4632 walks every status the target wears and compares no '
                      + 'instigator), one to a rider that waits for the type on the target '
                      + '(ent.GameObject.hasStatusType@4626 compares an instigator at ops 26-29 only when the script '
                      + 'passes one), and a hit of that type to a status that hands such hits the applier\'s crit chance '
                      + '(st.skill.BaseSkillAccess.isStatusType@5188 asks the hitting status for its own type) - so '
                      + `${d.name}'s ticks are critical for as long as such a status stands on the foe, and never otherwise. `
                      + 'The fight asks all three of the list it plays, the set\'s statuses in it. NOT MEASURED: '
                      + (seen
                        ? `the 2026-10-13 capture holds this status from ${seen.wearers} other players and from none of the four `
                          + 'characters it snapshots, and what any of them holds beside the set is not logged - no talent '
                          + `that counts the type, no status that hands it a crit chance. That ${seen.crits} of their ${seen.ticks} `
                          + 'ticks is critical says the tick has no crit chance of its own, and nothing about the grant. '
                        : 'no character of the 2026-10-13 capture wears an Infusion. ')
                      + 'What settles it is the set worn beside a '
                      + 'talent that counts the type, the set\'s own ticks read with and without the point: one step of '
                      + 'the talent more on each tick, and one more again while a second status of the type stands. '
                    : '')
                  + 'COUNTED as a status landing:every dot and debuff the fight puts on the foe, every feed of a '
                  + 'bleed-style pool (one per damage instance its guard lets through), every crowd control a '
                  + 'cast applies, and the stacking debuffs of other sets - each application once, whichever of '
                  + 'those knows of it (a slow that carries a MoveSpeedFactor row is a control and a debuff, and '
                  + 'one landing), and none of a status this target turns away: crowd control on one immune to '
                  + 'it, a stun on one that refuses stuns (ent.GameObject.canReceiveStatus@4634, '
                  + 'ent.Unit.canReceiveStatus@4922). '
                  + 'NOT counted: a status the fight holds no state for - a mark, a counter on the foe - so the '
                  + 'stack count is a FLOOR, and a build that lands no status reads zero and is told so. '
                  + (seen
                    // What other players' rows show of this status (SEEN), and
                    // what they cannot: said in that order, with the counts.
                    ? `MEASURED 2026-10-13, on the rows of ${seen.wearers} other players (${seen.ticks} ticks; no sheet and no set rank `
                      + `of theirs is logged). A tick every ${d.tick}s: ${seen.gapsAtTick} of the ${seen.gaps} gaps between consecutive ticks `
                      + `of one wearer on one target are within a tenth of a second of it. LINEAR in the stacks on the foe: the `
                      + `tick divided by them reads ${seen.perStack.map((a, i) => `${list(a)} stacks (${['one wearer', 'a second', 'a third'][i] ?? 'another'})`).join('; ')}. `
                      + `Every application restarts the ${d.duration}s, one at the cap included: ${seen.refreshes.toLocaleString('en-US')} refresh rows, `
                      + `each to ${d.duration}s, ${seen.refreshesAtCap.toLocaleString('en-US')} of them at ${d.stacks} stacks. An application for about every other `
                      + `status that lands: on ${seen.landings.targets} targets whose every status row names one wearer, ${seen.landings.own} `
                      + `applications of it beside ${seen.landings.others} of everything else, equal on ${seen.landings.equal} targets - what the `
                      + `${seen.landings.others - seen.landings.own} missing were is not placed. `
                      // The ratio argument needs both rows to scale on the one
                      // attribute; where they do not, it is not made.
                      + (sealsOnAttack && e?.scaling.length === 1 && e.scaling[0].atb === sealsOnAttack.atb
                        ? `THE AMOUNT IS A TOTAL OVER ITS ${ticks} TICKS, by a ratio and not by a sheet: two of those players also `
                          + `wear ${sealsOnAttack.name}, whose on-attack row is ${sealsOnAttack.ratio} x ${sealsOnAttack.atb}, and that row over `
                          + 'one stack\'s tick reads '
                          + seen.ratio.map((x) => `${x.value.toFixed(2)} (${x.wrath} and ${x.ticks} rows, level-${x.level} targets)`).join(' and ')
                          + ` where the two rows make it ${sealsOnAttack.ratio} / (${e.scaling[0].ratio} / ${ticks}) = `
                          + `${(sealsOnAttack.ratio / (e.scaling[0].ratio / ticks)).toFixed(2)} for a total and `
                          + `${(sealsOnAttack.ratio / e.scaling[0].ratio).toFixed(2)} for an amount per tick. A third wearer of both reads `
                          + `${seen.ratioOff.value.toFixed(2)}, on ${seen.ratioOff.wrath} and ${seen.ratioOff.ticks} rows on the training dummy other players were `
                          + 'hitting too: NOT EXPLAINED. '
                        : '')
                      + 'STILL ONLY READ: the amount itself, the eruption at the top rank, '
                      + 'and which of a build\'s statuses count as a landing. MEASURE those with the set on the '
                      + `character the probe runs on: one status landed on a dummy and its ${ticks} ticks, against the sheet.`
                    : `MEASURE, with ${caps[0]} pieces on a training dummy: land ONE status and log the ticks - ${ticks} ticks of `
                      + `(${amount}) / ${ticks} is this reading, ticks ${ticks} times that mean the amount is per tick; then hold `
                      + `${d.stacks} stacks and log again - ticks that do not scale x${d.stacks} mean the stack factor is not linear; `
                      + `and note whether a fresh application restarts the ${d.duration}s.`);
              }).join(' ')),
            entry((f) => f.foeDebuffs.some((d) => d.on.includes('cc-apply') || d.on.includes('knockback')),
              (rs) => (rs.length ? `${names(rs)}: a debuff on the foe from every crowd control you TRY and every knockback you land` : 'no infusion on this build rides crowd control or knockbacks'),
              (rs) => rs.map((r) => {
                const d = r.fight.foeDebuffs.find((x) => x.on.includes('cc-apply') || x.on.includes('knockback'));
                const unforced = unforcedKnocks();
                const noPush = noPushback();
                return `${r.name} stacks ${d.name} on the foe (${d.affixes.map((a) => `${a.val >= 0 ? '+' : ''}${a.val} ${a.target.attribute}`).join(', ')} a stack, `
                  + `up to ${d.cap}, ${d.duration}s, refreshed by each application). READ: the script - onTryAddStatus behind `
                  + 'isCrowdControl (SkillScript.isCrowdControl@6938 = hasStatusFlag@21820(inf, 1)), and '
                  + 'onApplyKnockback with no guard at all. NOT READ: either hook\'s dispatcher. '
                  + 'GameObject.addStatus@4636 and ent.Unit.applyKnock@4949 are server-only stubs in this client '
                  + '(the client half of a knock, rpcApplyKnock__impl@4952, only moves the body). So "once per '
                  + 'attempt, landed or not" is the hook\'s name and the one tooltip that describes it '
                  + '(Domination\'s, same hook: "even if the target is immune") - the same authority the stun-armed '
                  + 'register stands on - and it is what puts this debuff on a Boss, which refuses the control '
                  + 'itself. A knock is counted on any target: getKnockRatio@4589 is 1 - KnockResistance and no '
                  + 'unit row authors that attribute. '
                  + (noPush
                    ? `The unit flag NoPushback is on ${noPush.count} of the ${noPush.of} unit rows`
                      + `${noPush.presets.length ? ` (the ${noPush.presets.join(' and ')} target${noPush.presets.length === 1 ? '' : 's'} of this bench among them)` : ''}`
                      + ' and no function left in this client tests it (its mask is loaded by no function that reads '
                      + 'a unit\'s flags; ent.Unit.canBePushedBy@4907, which decides body pushing, reads others), so '
                      + 'whether such a unit takes a knock - and raises the hook - is the server\'s: a knock is '
                      + 'counted there too. '
                    : '')
                  + 'COUNTED: one attempt per crowd control a cast applies (the '
                  + 'one reader, crowdControlOf) and one knock per effect that authors sideEffects.knockBack WITH A '
                  + 'FORCE - a push or a lift, of either sign - however many hits carry it: a floor. NOT counted: '
                  + 'an entry that authors no force'
                  + (unforced.length ? ` (${unforced.join('; ')})` : ' (no row a hero can use authors one on this build)')
                  + '. Whether the server raises the hook for a knock that moves nothing cannot be read - the half '
                  + 'of it this client keeps plays the knocked animation only for a push above zero '
                  + '(rpcApplyKnock__impl@4952 ops 66-74) - and the build is told how many it pressed. '
                  + (SEEN[d.status]
                    // One refusal the rows do show - a stun on a unit flagged
                    // NoStun - and the one they do not: a Boss's immunity.
                    ? (({ wearers, applications, stunTries, stunLanded, debuffBeside, stunRowsInLog, stunRowsOnNoStun }) =>
                      `MEASURED 2026-10-13, on other players' rows (${wearers} wearers, ${applications} times on; none of the four `
                      + `characters the capture snapshots wears it): one of them landed a weapon skill that deals damage and `
                      + `stuns ${stunTries} times on a unit flagged NoStun. A Stun row followed ${stunLanded} of the ${stunTries} - none of the `
                      + `log's ${stunRowsInLog.toLocaleString('en-US')} Stun applications is on a unit with that flag (${stunRowsOnNoStun}) - and a row of ${d.name} `
                      + `stands within 40 ms of ${debuffBeside}. So a control the target REFUSES still raises the hook: that much `
                      + `of "once per attempt" is measured, on ${stunTries} rows. NOT in the capture: a target immune to crowd `
                      + `control as a whole - none of the ${applications} is on a unit that isCCImmune answers for - and a knock `
                      + 'that can be told from a control. MEASURE: ')(SEEN[d.status])
                    : 'MEASURE: ')
                  + `${caps[0]} pieces, a stun or a slow on a Boss or Elite, and watch its debuff bar. ${d.name} appearing is `
                  + 'this reading. Not appearing means the hook runs only for a control that lands, and against a '
                  + 'target immune to crowd control this debuff is worth what the knockbacks alone make it.'
                  + (unforced.length
                    ? ` Then land ${unforced[0]} and nothing else on any target: ${d.name} appearing means a knock with no `
                      + 'force raises the hook too, and this line under-reads a build that presses one.'
                    : '')
                  + (noPush?.presets.length
                    ? ` And one skill that knocks with a force on the ${noPush.presets[0]} target: no ${d.name} there means a `
                      + 'NoPushback unit raises no knock, and the number against it over-reads.'
                    : '');
              }).join(' ')),
            entry((f) => f.foeDebuffs.some((d) => d.on.includes('weapon-skill-hit')),
              (rs) => (rs.length ? `${names(rs)}: a debuff every damage instance of a weapon skill stacks on the foe` : 'no infusion on this build rides weapon-skill damage'),
              (rs) => rs.map((r) => {
                const d = r.fight.foeDebuffs.find((x) => x.on.includes('weapon-skill-hit'));
                const lump = r.fight.triggered.find((t) => t.rule.kind === 'linked');
                const left = r.fight.foeDebuffs.find((x) => x.on.some((e) => e.startsWith('linked:')));
                return `${r.name} adds a stack of ${d.name} (${d.affixes.map((a) => `${a.val} ${a.target.attribute}`).join(', ')} a stack, ${d.duration}s) `
                  + 'on every damage instance of a weapon skill (onInflictDamage behind dmg.isWeaponSkill - skill '
                  + 'type 7 or 8, BaseSkill.isWeaponSkill@6161; a status tick is the status\'s own damage and adds none). '
                  + (d.consumeAt != null
                    ? `At this rank an instance that finds ${d.consumeAt} stacks spends them instead and plays `
                      + `${lump ? lump.prof.id.split('#')[1] : 'a step'} - so the count cycles 0..${d.consumeAt} and never reaches the `
                      + `row's ${d.cap}`
                      + (left ? `; ${left.name} is worn for the ${left.duration}s the area lasts, and the simulated foe does not walk out of it. ` : '. ')
                      + 'The area is priced whole when it is dropped (its amount is a total over its ticks, the '
                      + 'loop being flagged SpreadEffects), with the debuff it leaves already on. '
                    : `Up to ${d.cap}. `)
                  + 'The debuff rows sum into the one armour bracket every other shred does. '
                  + (SEEN[d.status]
                    ? (({ wearers, wsRows, wsWithApplication, applications, besideWs, besideNothing, besideOther, mostStacks, spendRows }) =>
                      `MEASURED 2026-10-13, on the rows of ${wearers} other players (none of the four characters the capture `
                      + `snapshots wears it; each target had one wearer): ONE STACK PER DAMAGE INSTANCE of a weapon skill, not `
                      + `one per cast - of the wearers' ${wsRows.toLocaleString('en-US')} weapon-skill damage rows, ${wsWithApplication} have an application of `
                      + `${d.name} on that target within 60 ms, and each of the other ${wsRows - wsWithApplication} is the blow its target died of. `
                      + 'Read row by row on one five-hit cast: the count walks from one to five, a hit every quarter '
                      + 'second, and a conduit\'s bolt and a status\'s own damage that land between those hits add none. '
                      + `Each application restarts the row's ${d.duration}s. Of ${applications.toLocaleString('en-US')} applications ${besideWs} stand beside such a row; `
                      + `${besideNothing} stand beside no damage row of the wearer and ${besideOther} beside a base attack or a class skill: `
                      + `those ${applications - besideWs} are NOT EXPLAINED. NOT in the capture: the top rank's branch - the log holds `
                      + `${spendRows} rows of the step that spends the stacks, and the counts it does hold climb to ${mostStacks}, which that `
                      + 'branch never lets stand - and what a stack is worth '
                      + '(no sheet of a wearer is logged). MEASURE: the top rank on the character the probe runs on, one '
                      + 'multi-hit weapon skill on a dummy - the stacks leaving at the hit that finds '
                      + `${d.consumeAt ?? 'the count the script names'} and a damage row of the set beside it is that branch.`)(SEEN[d.status])
                    : 'NOT measured. MEASURE: '
                      + `${caps[0]} pieces, one multi-hit weapon skill on a dummy: the debuff showing one stack per hit, not one per cast, is this reading.`);
              }).join(' ')),
            entry((f) => f.triggered.some((t) => t.rule.window?.on),
              (rs) => (rs.length ? `${names(rs)}: a step played on your attacks while a status the script holds on you is up` : 'no infusion on this build plays a step inside a status it holds on you'),
              (rs) => rs.map((r) => {
                const riders = r.fight.triggered.filter((t) => t.rule.window?.on);
                const wins = [...new Map(riders.map((t) => [t.rule.window.key, t.rule.window])).values()];
                const forced = (riders[0]?.prof.runeDamage ?? []).filter((rd) => rd.stepId && rd.set && rd.forced).map((rd) => rd.stepId);
                // The always-critical step of the top rank, as its row authors it.
                const topStep = (() => {
                  const sc = (cdb.byId('skill').get(r.id)?.steps ?? []).find((s) => s.id === forced[0])?.effects?.[0]?.scaling;
                  return sc?.length === 1 ? { id: forced[0], ratio: sc[0].ratio } : null;
                })();
                return `${r.name} holds ${wins.map((w) => `${skillName(w.key)} for ${w.duration}s after ${w.on === 'weapon-skill' ? 'a weapon skill' : 'a class skill'}`).join(' and ')} `
                  + '- each taken off by the press that puts the other on - and plays '
                  + riders.map((t) => t.prof.id.split('#')[1]).join(', ')
                  + ' inside them. READ: the toggle is onSkillProc, raised once per USE before the cast\'s hits '
                  + 'exist (tryConsumeCharge@9631), behind ctx.isWeaponSkill (type 7 or 8) and ctx.isClassSkill '
                  + '(type 9, BaseSkill.isClassSkill@6158) - a signature skill is neither and touches nothing. The '
                  + 'on-attack steps are onInflictDamage behind isBaseAttack || isFinalCombo (on a damage result '
                  + 'that is SkillStep.isBaseAttack@6027 - the step\'s BaseAttack flag or a skill of type 0-4 - or '
                  + 'the skill\'s BaseSkill.isFinalAttack@6154: Infusion_Crimson_Support.onInflictDamage@45101 ops 9-21), once per DAMAGE '
                  + 'INSTANCE - a swing that lands two hits plays the step twice, the per-instance reading the '
                  + 'swing riders of the weapon kits already take. A step played when the other status is '
                  + 'consumed fires on that press, if the status was still up, and is an area around YOU: the foe '
                  + 'is taken to stand in it. '
                  + (forced.length ? `${forced.join(', ')} always critically strikes (a literal critChance = 1 on that step - see runeDamage). ` : '')
                  + 'The windows open on the presses the fight makes: a fight that drops a class skill because it '
                  + 'deals nothing toward the goal never closes the damage window with it. A weapon sub-skill\'s '
                  + 'recast is not taken as a press. '
                  + (SEEN[r.id]
                    ? (({ wearers, rows, onAttack, smite, smiteAmount, smiteWearerOnAttack, smiteWearerCrit, own, followed, summonRows, weaponSkillRows, finishers, windows, refreshes, forceEnded, forceEndedWithPeace }) =>
                      `MEASURED 2026-10-13, on the rows of ${wearers} other players (none of the four characters the capture `
                      + `snapshots wears it): ${rows} damage rows of the set, ${onAttack} of them the on-attack step. Every one of the ${onAttack} `
                      + 'has the damage window on its wearer and a base-attack or finisher damage row of that wearer on '
                      + `that target in the 250 ms before it; and of the wearers' ${own} base-attack and finisher damage rows `
                      + `under the window, ${followed} are followed by one - the ${own - followed} that are not are each the last damage `
                      + 'their target took. ONCE PER DAMAGE INSTANCE, not per swing: '
                      + finishers.map(([casts, hits, steps]) => `${casts} finisher${casts === 1 ? '' : 's'} of ${hits / casts} bolts, ${steps} on-attack rows for ${hits} damage rows`).join('; ')
                      + `. None for what is not a base attack or a finisher of the wearer's own: ${summonRows} damage rows of `
                      + `their summons and ${weaponSkillRows} of their weapon skills fell inside the window, and the count above is `
                      + `exact without them. The window: on ${windows} times, ${wins[0]?.duration ?? '?'}s each, refreshed ${refreshes} times, `
                      + `force-ended ${forceEnded} times - ${forceEndedWithPeace} of them in the millisecond the other status went on that hero. `
                      + `The other ${smite} rows of the ${rows} are that millisecond's: ${smiteAmount} each and critical, on a wearer whose on-attack row `
                      + `averages ${smiteWearerOnAttack} ordinary and ${smiteWearerCrit} critical - x${(smiteAmount / smiteWearerOnAttack).toFixed(2)} the ordinary one`
                      + (topStep && sealsOnAttack
                        ? `, where ${topStep.id} at its row's ${topStep.ratio} against the on-attack step's ${sealsOnAttack.ratio}, always critical, is `
                          + `x${(topStep.ratio / sealsOnAttack.ratio * smiteWearerCrit / smiteWearerOnAttack).toFixed(2)} on that wearer's own rows`
                        : '')
                      + '. NOT in the capture: that a weapon '
                      + 'skill\'s USE opens the window and a class skill\'s ends it (other players write no press row: '
                      + 'that half is the script), the two heals, and any amount - no sheet and no set rank of a wearer '
                      + 'is logged. MEASURE: the set on the character the probe runs on, one weapon skill and then base '
                      + 'attacks on a dummy - the on-attack row against the sheet is the amount.')(SEEN[r.id])
                    : 'NOT measured. MEASURE: '
                      + `${caps[0]} pieces and a weapon whose swing lands two hits: one weapon skill, then base attacks - an extra `
                      + 'damage number on EVERY hit of every swing until the status drops is this reading; one per '
                      + 'swing halves the line on such a weapon.');
              }).join(' ')),
            entry((f) => f.eventProcs.length > 0,
              (rs) => (rs.length ? `${names(rs)}: a cast a counter of your own status applications arms, priced with no clock of its own` : 'no infusion on this build arms a cast off a counter the fight can count'),
              (rs) => rs.map((r) => {
                const ep = r.fight.eventProcs[0];
                return `${r.name} at its top rank: ${ep.why}. READ: the counter is a status the passive adds in `
                  + 'onInflictStatusEval behind a test that the status applied is the one it counts, once per '
                  + 'application (GameObject.addStacks@4637); at its cap its own script hands over a second status whose '
                  + 'props.status.skillOverride names a slot of the bar; client.UnitController.updateSkillInput@13207 '
                  + 'ops 29-36 swap the pressed slot\'s skill for ent.Hero.getSkillOverride@7980 and ops 54-71 check '
                  + 'and request THAT skill - its own cooldown, cost and checkEnabled, so the skill the slot held '
                  + 'is not spent. ent.GameObject.doUseSkill@4651 ops 0-10 stop the running skill unless the '
                  + 'pressed row is flagged NonInterupting, which this one is, and since build 25959898 ops 20-32 no longer '
                  + 'put the hero in the Skill state for such a row either (set_goState is skipped). PRICED after the fight, one cast per '
                  + `${ep.cap} counted applications${ep.selfFeeds > 0 ? ` plus the ${ep.selfFeeds} each cast of its own lands` : ''}, from a cold start, at the resting `
                  + 'sheet with nothing up - the debuff that armed it included, which under-reads it by that much - '
                  + 'and taken to be pressed inside the seconds the arming status lasts. NOT measured. MEASURE: at '
                  + `${caps[top - 1]} pieces, press the armed slot in the middle of a base-attack chain: the chain carrying on and the `
                  + 'slot\'s own skill keeping its cooldown is this reading.';
              }).join(' ')),
            entry((f) => f.triggered.some((t) => t.rule.critGated && !t.rule.window),
              (rs) => (rs.length ? `${names(rs)}: a step thrown on your critical strikes, counted on base attacks and finishers only` : 'no infusion on this build throws a step on a critical strike'),
              (rs) => rs.map((r) => {
                const ts = r.fight.triggered.filter((t) => t.rule.critGated && !t.rule.window);
                const lit = (ts[0]?.prof.runeDamage ?? []).filter((rd) => rd.stepId && rd.set).map((rd) => `${rd.stepId}: ${rd.field} ${rd.forced ? '= 1 (always)' : '= ' + rd.amount}`);
                return `${r.name} rolls on every critical damage instance that is not its own (onInflictDamage, which `
                  + 'returns unless the hit is critical and is another row\'s) and throws '
                  + ts.map((t) => `${t.prof.id.split('#')[1]} at ${Math.round(t.rule.chance * 100)}%`).join(', ')
                  + '. The fight has no per-instance event, so the roll is counted on the damage instances of '
                  + 'base attacks and finishers at the sheet\'s crit chance - the floor the status reader takes '
                  + 'for an unpredicated onInflictDamage roll that puts up a buff or a debuff (a damaging status '
                  + 'rolled that way is counted on every damage instance the fight lands, which this roll is not: '
                  + 'it needs the critical ones); a weapon skill\'s critical hits throw one too. '
                  + (lit.length ? `Step-scoped literals on its own hits are read (${lit.join('; ')}). ` : '')
                  + 'What a thrown step that hits then throws around itself is named and not counted: where '
                  + 'those land is not in the data.';
              }).join(' ')),
            entry((f) => f.alternating.length > 0,
              (rs) => (rs.length ? `${names(rs)}: two statuses a timer swaps, each on the fight's sheet for the share of the fight it holds` : 'no infusion on this build swaps statuses on a timer'),
              (rs) => rs.map((r) => {
                const pair = r.fight.alternating;
                return `${r.name}: onRegUpdate, in combat, takes one status off and puts the other on every ${pair[0].alternates.period}s, `
                  + 'starting from the first - so one is up at any time and never both. Each is on the sheet the '
                  + 'fight prices at its share of THIS fight\'s length, scheduled from the script\'s own start '
                  + `(${pair.map((b) => `${b.status} ${(infusionPlan.alternatingShare(b.alternates, opts.fight) * 100).toFixed(0)}%`).join(', ')} of ${opts.fight}s), and not on the `
                  + 'standing sheet, where the script has taken both off. A flat row at a share is exact while '
                  + 'damage is spread evenly over the clock; a burst timed into one window does better than this.';
              }).join(' ')),
          ];
        })(),
        {
          severity: 'info',
          get what() { const { live, shut, unread } = I(); return `${live.length} of ${ids.length} infusions can be learned on this build`
            + (shut.length ? `; ${shut.map((s) => s.name).join(', ')} cannot` : '')
            + (unread.length ? `; ${unread.length} could not be judged` : ''); },
          get why() { const { live, shut, unread } = I(); return 'An infusion is learned from its pattern item, and where a pattern comes from is half in data.cdb and '
            + 'half in the level files. '
            + (live.length ? 'Learnable: ' + live.map((s) => `${s.name} - ${s.why}`).join('. ') + '. ' : '')
            + (shut.length ? 'NOT obtainable: ' + shut.map((s) => `${s.name} - ${s.why}`).join('. ') + '. ' : '')
            + (unread.length ? 'Not judged: ' + unread.map((s) => `${s.name} - ${s.why}`).join('. ') + '. ' : '')
            + 'The release status is the CLIENT\'s copy (the dungeon definition in res.levels.pak); a server that '
            + 'opened those heroics anyway would make this list too short. Open the lobby of one at level '
            + `${ctx.consts.maxLevel}: Heroic not selectable confirms it. The search offers every infusion that is not `
            + 'shown to be unobtainable; --infusions all offers every one, and a pin always can.'; },
        },
      ];
    })() : []),
    {
      severity: 'assumption',
      what: 'gear nothing in this install hands out is withheld from the search',
      // A getter, for the same reason as the infusion entries above.
      get why() {
        const p = cat.sources().prefabs;
        const c = cat.sources().code;
        if (!p.read) {
          // Read, but a release status in them has no name this build's data
          // gives it - sources.mjs judges no gate on an index.
          return `${p.parsed ? p.why[0].toUpperCase() + p.why.slice(1) : `The level files could not be read (${p.why})`}`
            + ', so no row is withheld: whether a loot table is named by '
            + 'a chest, a crate or a merchant lives in the prefabs, and "nothing names it" cannot be said without them.';
        }
        if (!c.read) {
          return `The compiled code could not be read (${c.why}), so no row is withheld: a loot table can be handed out `
            + 'by a function that names it and by no row at all, and "nothing names it" cannot be said without it.';
        }
        const gone = cat.unreleasedItems().filter((x) => !x.item.isAugment);
        const tables = [...new Set(gone.flatMap((x) => (x.dead ?? [])
          .map((d) => /^loot table (\w+)/.exec(d)?.[1]).filter(Boolean)))];
        return `${gone.length} stat-bearing rows are in the item sheet and in no source this install opens`
          + (tables.length ? ` - they sit only in loot table${tables.length === 1 ? '' : 's'} ${tables.join(', ')}` : '')
          + '. A source is a row that names the item or its loot table: a unit\'s lootTable / bossLootTable / '
          + 'heroicLootTable, a container\'s gainItem, a recipe, the WorldLoot flag, a faction\'s Rare drops '
          + `($HItem.getFactionLootTable@21743), or - read from the ${p.files} prefabs of ${p.paks.join(', ')}, where `
          + 'the empty `element`, `activity` and `spawner` sheets actually live - a merchant\'s shop list, a chest, '
          + 'a dialog reward. Each is checked for its own gate (releaseStatus through $HData.checkStatus@21563; a '
          + 'heroicLootTable needs its boss\'s dungeon to have Heroic released). Scripts and hlboot.dat are searched '
          + 'too: a table or item that a script or a compiled function names by literal (other than the generated '
          + 'id table, which names every row) is called UNKNOWN and never withheld, because what that code does '
          + 'with it is not read. The release status is the client\'s copy; a server may differ. --include-all '
          + 're-admits the rows, and a pin always can.';
      },
    },
    {
      severity: 'assumption',
      what: 'a DemonSigil is taken because a free talent beats an empty socket, not because it scored',
      why: `Each of the ${cdb.lines('item').filter((i) => i.type === 'AugmentDemonSigil').length} sigils grants one tier-4 talent, and most of those declare no effect, no affix ` +
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
