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
import { evaluate as evaluateLoadout, classOf, socketsOf, standingPrimaries } from './loadout.mjs';

export const GOALS = ['dps', 'hps', 'sps', 'ehp', 'mixed'];
export const FERVOR_SCOPES = ['skills', 'all', 'none'];

export const DEFAULT_ASSUME = {
  // Fervor's description says "your Skills", but the measurement says
  // everything: a combo finisher at 133 went to exactly 133 x 1.12 x 1.016
  // = 151 under +12% PhysicalMastery and 30 FervorRating (~+1.58%) - without
  // the Fervor term it prices 149. So base attacks get it too, and 'all' is
  // the default. --fervor-scope skills|none remain as sensitivity toggles.
  fervorScope: 'all',
  mastery: true,
  // How much of the time basic attacks land from the target's rear half-plane,
  // for the weapon upgrade perks that pay there. The predicate (read from
  // Daggers_Upgrade's script) is a full 180 degrees of "behind", so 1.0 is
  // the claim for a build that repositions every swing - Shadowstep teleports
  // there - but nobody sustains it: the 2026-08 capture sweep measured the
  // player's realized behind-share at ~0.41 across sessions, and the one
  // dummy session that watched a drifting melee read 0.68-0.85. The default
  // is the measured number; --behind-fraction 1 restores the optimist.
  behindFraction: 0.41,
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
  function evaluateOnce(loadout, { target, rank = 1, mix = 0.5, policy = null, goal = 'dps', fight = null, chainFeeds = null, conduitStacks = null, targetHealth = opts.targetHealth } = {}) {
    checkTargetHealth(targetHealth);
    const cls = classOf(cat, loadout);
    const tgt = target ?? combat.foe('reference', loadout.level);
    const weaponPower = combat.weaponPowerFor(cat, loadout, cls);
    const rot = rotationFor(loadout, rank);
    // WeaponPower's other half: every read of it adds the mean of the ITEM's
    // aptitude attributes off whatever sheet is being consulted - Beefury
    // swings with (6.5% Strength + 6.5% Faith), Judgement with its whole 0.7
    // on Strength - see amountOf in damage.mjs. And a MAINHAND skill's
    // attribute scalings mix 60% attribute with 40% of that attribute's own
    // budget curve at the CHARACTER's level (WeaponPowerRatio's 0.4), ten
    // measured integers exact - so the fight knows which casts are the
    // mainhand's and which attributes its swings read.
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
    const evalOpts = {
      ...opts,
      // A REPLAY prices the fight at the capture window's own length, so the
      // per-minute columns are commensurable with the recorded ones.
      ...(fight > 0 ? { fight } : {}),
      ...(chainFeeds ? { chainFeeds } : {}),
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
      // The mix has NO slot gate - getStepEffectItemScaling@20780 checks only
      // isWeaponBased on the skill type - so the arsenal's weapon skills mix
      // exactly like the mainhand's. Class skills (type 9) stay pure
      // attribute, read straight off BaseSkill.isWeaponBased@6057's set.
      // The item-scaling channel follows the granting item's TYPE CHAIN, per
      // getStepEffectScaling@20778: itemRatio 0.4 when the chain reaches
      // MainhandWeapon (every held weapon does), 1.0 for GearTrinket, and 0
      // otherwise - Shield inherits OffhandWeapon > Weapon and never
      // MainhandWeapon, so a SHIELD-granted status prices PURE attribute (the
      // orb's live pulse is 0.55 x live-ceiled Faith x its riders exactly; an
      // earlier +0.4-budget reading of the same number was degenerate on this
      // one build and is gone). Weapon-granted ticks take the ordinary
      // 0.6/0.4 mix, Raw gated at the pricing site; class and talent statuses
      // are in no set and price pure.
      weaponMix: (() => {
        if (!mainItem && !hasArsenal) return null;
        const shieldStatus = new Set(rot.active
          .filter((x) => typeof x.source === 'string' && x.prof.isStatusTick
            && cat.itemById.get(loadout.gear[x.source]?.item)?.type === 'Shield')
          .map((x) => x.prof.id));
        // A SHIELD in the offhand takes no mix at all - the type chain
        // (Shield > OffhandWeapon > Weapon) never reaches MainhandWeapon, so
        // getStepEffectScaling@20778's itemRatio is 0 for everything it
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
          // The trinket channel: a status granted by a NON-weapon item ticks
          // undivided at the standing, weaponless, floored primaries - see
          // standingPrimaries() for the measurement. The map is fixed at the
          // resting build, so buffed application states cannot reprice it,
          // which is also measured: live ticks stay 45 through the rotation.
          standingIds: new Set((rot.dots ?? [])
            .filter((d) => typeof d.source === 'string' && d.source.startsWith('Slot_')
              && !WEAPON_SLOTS.has(d.source) && itemType(d.source))
            .map((d) => d.status)),
          standing: standingPrimaries(cat, loadout, {
            baseStatsFor,
            primaries: [...combat.attributeBudgets(loadout.level).keys()],
          }),
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
      //   cc - Domination's `+25% vs a stunned target`. The union of every stun
      //     this kit can apply, each at duration/cooldown: independent windows,
      //     so 1 - PROD(1 - u). Nothing here is invented - the durations come
      //     off the applying steps and the cooldowns off the skills.
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
      rank,
      gates: (() => {
        const bleeding = rot.dots?.some((d) => (d.types ?? []).some((t) => /Bleed|Hemorage/i.test(t)))
          ? 1 : 0;
        let miss = 1;
        for (const e of [...rot.active, ...rot.filler, ...(rot.triggered ?? [])]) {
          const st = plan.statusesOf(e.prof.id, { rank, runes: new Set(rot.runes ?? []) });
          for (const cc of st.flaggedCC ?? []) {
            const dur = cc.duration;
            if (!(dur > 0)) continue;
            const cd = Math.max(e.prof.cooldown ?? 0, e.prof.occupancy ?? 0.05);
            miss *= 1 - Math.min(1, dur / cd);
          }
        }
        return { bleeding, cc: 1 - miss };
      })(),
    };

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
    // break the stars rule. Weapon.getWeaponUpgradeSkill@8182 attaches the
    // upgrade skill only at upgradeLevel >= GearUpgrades.SkillUnlockLevel (3),
    // and sets rank = the instance's ROLLED rarity index - updateInf@8174
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
        // is skill types Attack..Attack4 (BaseSkill.isBasicAttack@6045), which
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
    // A SKILL'S OWN AFFIX ROWS. This used to read `rot.passive` only, which is
    // the wrong half of the game's rule. `BaseSkill.permaAffixes@6081`
    // (BaseSkill.hx:850) returns false for exactly two natures - Status(4) and
    // Passive(5) - and true for everything else, and `initData@6029` then does
    // `if (permaAffixes()) updateAffixes()`, handing them to `owner.addAffix`
    // for good. A passive's rows are not permanent by that test but arrive the
    // other way, through `setRunning@6025`, and a passive is always running; a
    // status's rows belong to the buff path, which prices them at an uptime.
    //
    // So the rule here is every owned skill EXCEPT a status, and the row that
    // proves it is `Axe_Boomerang_Combo`: nature Combo, `TAttribute_Flat
    // CritChance +5` at `minRank: 2`, `displayed: false`, and a rankDesc that
    // says "You permanently gain ::val1%:: [CritChance]" in as many words. It
    // is owed for WIELDING the axe - `Weapon.applySkills@8181` creates a skill
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
        // One stack, always: `BaseSkill.getAffixMultiplier@6082` returns 1, and
        // only `Status.getAffixMultiplier@14436` returns the stack count.
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
    for (const [id, nodeRank, asTalent] of modSources) {
      for (const mod of plan.talentModifiers(id, nodeRank, { asTalent })) {
        if (!asTalent && mod.field !== 'cooldownPerTick') continue;
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
        // scopes its +20% to Poison damage, and the model has no poison pool to
        // put it on, so it must contribute nothing rather than +20% globally.
        // A scope may cover more than one profile category: the finisher's
        // profile type is AttackCombo, and 'attack-or-combo' pays both halves.
        const types = mod.scope === 'attack' ? ['Attack']
          : mod.scope === 'combo' ? ['AttackCombo']
            : mod.scope === 'attack-or-combo' ? ['Attack', 'AttackCombo']
              : mod.scope === 'weaponSkill' ? ['WeaponSkill'] : null;
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
        else unreadMods.push(mod);
      }
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

    // A SCRIPTED `dmgMult` IS NOT A SHEET STAT. `skills.mjs` turns an
    // unconditional `hit.dmgMult += vars.n` into a `TAttribute_Flat
    // DamageModifier` row so the buff, its uptime and its place in the fight
    // all come for free - but DamageModifier MULTIPLIES in `castOutput`, and
    // `computeDamage@4841` says these riders SUM. Berserk at +0.20 beside
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
    for (const b of buffs) {
      const src = combat.profile(b.from, rank, new Set(rot.runes ?? []));
      const cd = src?.cooldown ?? 0;
      const dur = b.duration;
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
    const tp = combat.throughput(rot, combatBase.sheet, tgt, evalOpts,
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
    ];
    for (const u of unreadMods) {
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
    for (const e of [...(rot.filler ?? []), ...(rot.active ?? []), ...(rot.triggered ?? []),
      ...(rot.passive ?? [])]) {
      for (const g of plan.scriptGapsOf(e.prof.id, rank, { runes: new Set(rot.runes ?? []) })) {
        extraGaps.push({
          id: g.id, name: g.name, source: 'script', kind: 'rider not read',
          why: `${g.name} is scored, but one clause of its script is not: `
            + `${g.field} ${g.amount} behind \`${g.guard}\`, which this reader cannot answer`,
        });
      }
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
    if (extraGaps.length) tp.unmodelled = [...tp.unmodelled, ...extraGaps];
    return {
      ...r, target: tgt, weaponPower, profile, rotation: rot, buffs,
      throughput: tp, survivability: sv,
      // What the wrapper needs to close the ramp loop, and what a reader needs
      // to see that it was closed: `pending` is "there is a stacking conduit
      // buff here that nobody has priced yet", `conduitRamps` is what it was
      // finally priced at.
      conduitPending: conduitBuffGaps, conduitRamps,
    };
  }

  // The mean stack count of a once-per-trigger buff over a fight of `T`
  // seconds. It climbs one stack per trigger to `cap` and then holds, so the
  // time-average is the area under that curve: half the cap while ramping,
  // then the cap. If the gap between triggers is longer than the buff itself
  // it never accumulates at all - it is up at one stack for dur/cadence of the
  // time and down the rest.
  function rampMeanStacks(cap, cadence, dur, T) {
    if (!(cadence > 0) || !(T > 0) || !(cap > 0)) return 0;
    if (cadence >= dur) return Math.min(1, dur / cadence);
    const toCap = cap * cadence;                       // seconds to reach it
    return T <= toCap ? T / (2 * cadence) : cap * (1 - toCap / (2 * T));
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
  function evaluate(loadout, args = {}) {
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
    if (!Number.isFinite(cadence)) return first;      // nothing ever fired

    const T = first.throughput?.fight ?? args.fight ?? opts.fight;
    const stacks = new Map(first.conduitPending.map((g) =>
      [g.id, rampMeanStacks(g.stacks, cadence, g.duration, T)]));
    return evaluateOnce(loadout, { ...args, conduitStacks: stacks });
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
      what: opts.targetHealth >= 1
        ? 'the target stands at FULL health, so every execute clause in the game is off'
        : `the target stands at ${+(opts.targetHealth * 100).toFixed(2)}% health for every clause that asks`,
      why: 'Eight script clauses across seven weapons compare the TARGET\'s healthRatio against a '
        + 'threshold. None of that is live state this reader has to guess at: which phase of a fight '
        + 'you are asking about is an input, the same standing --targets has. So --target-health states '
        + 'it and the comparison is answered exactly - no assumption that the fight ends in a kill, '
        + 'none that damage is even, none that some share of the clock is spent below the line. `<` and '
        + '`<=` therefore differ only exactly AT the boundary, which is all the precision one stated '
        + 'number can carry. THREE of the eight are priced today: Execution\'s +25% under 35%, Demonic '
        + 'Bite\'s +25% and Scatterbloom\'s +50%. The other five ask something else as well as the '
        + 'health - a recast pair, a skillId disjunction, a status mark, a playStep payload, a `*=` '
        + 'multiplier - and stay refused on THAT guard, each named on its own line. Hiveborn Blossom\'s '
        + '+200% ABOVE 80% is among them, so no above-threshold rider is priced today and the default '
        + 'of 100 has nothing to switch on - it only switches the execute riders off, and says which. '
        + 'SIX MORE clauses read the OWNER\'s health (Hive Bite, Tide Warlord, Flamie, '
        + 'Fanatical Fury, RobinHoof_Summon, Infused Tusk) and those stay REFUSED: the target\'s health '
        + 'is one number the player can state, and your own health over a fight is a trajectory this '
        + 'model does not simulate - it never takes damage.',
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
        + 'has to say so.',
    },
    {
      severity: 'verified',
      what: opts.assume.chainResets
        ? 'the base-attack chain drops after ComboWindow (0.6s) without an attack'
        : 'the base-attack chain holds its place through anything (--chain-persists)',
      why: 'Read from Hero.update@7495 / isWithinAttackCombo@7459: ONE CUMULATIVE CLOCK, from the END ' +
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
      severity: 'verified',
      what: 'a cast costs only its own authored duration - no global recovery window',
      why: 'Read from the bytecode: Skill_RecoveryTime\'s only reader is Foe.getSkillRecoveryTime@6773, ' +
           'whose only callers are foe AI (onUseSkillEnd, canAutoPickSkill), and the once-unplaced bare ' +
           '`recoveryTime` symbols resolve to the skill sheet\'s aiProps column - foe-AI data plumbing. ' +
           'No hero path pays any global recovery. The stopwatch agreed first: ten Judgement chains ran ' +
           '~3.0s each, exactly the authored 3.00.',
    },
    {
      severity: 'verified',
      what: 'a WEAPON is generated - it takes the source\'s level and rolls its rarity; GEAR is authored and keeps both',
      why: 'The split is the itemType tree: everything under MainhandWeapon or OffhandWeapon against ' +
           'everything under Gear. The live bakes settle both halves - Necklace_Z2RCraft logged iLevel ' +
           '210 on a LEVEL-25 character, its authored 20 exactly, the Z3 craft rings logged 160 for an ' +
           'authored 15, and GA_Craft logged 320 against an authored level of 4. Applying either rule ' +
           'to everything is how the optimiser came to recommend items the world cannot drop: a level-6 ' +
           'Uncommon necklace offered as Rare at iLevel 260, about four times its legal stats. So ' +
           '`--drops scaled` means "a weapon generates at your level" and gear is unaffected either ' +
           'way; a pinned gear item is never promoted past its own rarity. Anything ranked before this ' +
           'has to be re-run - it moved every baseline down 1-3%. A weapon\'s DAMAGE line still follows ' +
           'its trained level rather than its drop, verified on a real Cheese Moon: trained to weapon ' +
           'level 25 it shows the effective-level-11 stat budget while its damage line reads 18-21, ' +
           'the full primary budget at the trained level. A ^N pin still names an instance exactly.',
    },
    {
      severity: 'verified',
      what: 'a `Mono` step never cleaves, whatever area it carries',
      why: 'Read from AreaStep.areaHit@5972 (SkillStep.hx:1856-1893): hitCount starts at -1 for ' +
           'unlimited, `if (inf.type == Mono) hitCount = 1`, and the priority hit DECREMENTS it before ' +
           'the `if (hitCount == 0) return null` at L1892 - so the GameLayer.find shape query at op 229 ' +
           'is never reached and props.area is dead for that cast. With no priority target the sweep ' +
           'does run, and L1970-1974 then trims the result to the single NEAREST object. A Mono step ' +
           'IS an AreaStep at runtime (isAreaStep@5961 returns true for type 0) and does run the ' +
           'swept-shape routine, which is why the cone matters: it decides WHICH enemy and whether you ' +
           'connect at all, never how many. The only override is the step-level props.hitCount, and ' +
           'all six of its occurrences in data.cdb hold the value 1. So all 80 Mono-with-area rows ' +
           'resolve identically and the two the model used to call contradictory do not: ' +
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
