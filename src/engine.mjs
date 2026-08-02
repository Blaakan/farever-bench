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
  // Fervor's description says "your Skills", but the measurement says
  // everything: a combo finisher at 133 went to exactly 133 x 1.12 x 1.016
  // = 151 under +12% PhysicalMastery and 30 FervorRating (~+1.58%) - without
  // the Fervor term it prices 149. So base attacks get it too, and 'all' is
  // the default. --fervor-scope skills|none remain as sensitivity toggles.
  fervorScope: 'all',
  mastery: true,
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
  function evaluate(loadout, { target, rank = 1, mix = 0.5, policy = null, goal = 'dps' } = {}) {
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
    const evalOpts = {
      ...opts,
      attackerLevel: loadout.level,
      swingAttrs: mainItem
        ? mainItem.aptitudes.map((a) => combat.primaryAtbFor({ aptitude: a })).filter(Boolean)
        : null,
      // The mix has NO slot gate - getStepEffectItemScaling@20780 checks only
      // isWeaponBased on the skill type - so the arsenal's weapon skills mix
      // exactly like the mainhand's. Class skills (type 9) stay pure
      // attribute, read straight off BaseSkill.isWeaponBased@6057's set.
      weaponMix: mainItem || hasArsenal ? {
        flats: combat.attributeBudgets(loadout.level),
        ids: new Set([
          ...rot.filler.map((x) => x.prof.id),
          ...rot.active
            .filter((x) => x.source === 'Slot_Weapon1' || x.source === 'Slot_Weapon2'
              || x.source === 'Slot_OffhandWeapon')
            .map((x) => x.prof.id),
        ]),
      } : null,
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
    // type has a `<Type>_Upgrade` skill whose affix rows are gated by the
    // upgrade level - `Scepter_Upgrade` is +4 SpellPenetration at one star
    // rising to +8 at five, `Staff_Upgrade` +2..+6 CooldownReduction. Eight of
    // the twenty carry readable affixes; the other twelve are procs whose
    // payload lives in a script, and those are named in the audit.
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
    for (const slotId of ['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']) {
      const g = loadout.gear[slotId];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      const upgradeId = cat.upgradeSkillFor(item);
      if (!upgradeId) continue;
      const stars = Math.min(g.stars ?? 0, cat.maxStars(item, g.rarity));
      if (stars < 1) continue;
      // The affix ladder is read at STARS - 1; see above. A one-star weapon
      // still reaches the script-proc branch below, which is keyed on the star
      // count and not on this ladder.
      const riderRank = stars - 1;
      const up = cdb.byId('skill').get(upgradeId);
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
        const chance = up?.vars?.chance;
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
    };
    // Modifiers whose scope this fight does not separate. Named, not dropped.
    const unreadMods = [];
    for (const [id, nodeRank] of Object.entries(loadout.talents ?? {})) {
      for (const mod of talents.modifiersOf(id, nodeRank)) {
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
        const type = mod.scope === 'attack' ? 'Attack'
          : mod.scope === 'weaponSkill' ? 'WeaponSkill' : null;
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
        const r = Math.max(1e-9, (1 / swingPeriod) * (b.trigger?.chance ?? 1));
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
      // A buff applied ONCE PER CONDUIT TRIGGER is not permanent, and crediting
      // it at its cap was the single largest overstatement left in the Mage.
      // Conduit: Power is +0.5 MagicMastery a stack to a cap of 20, so the cap
      // reads +10 - and the fight's own conduit stream fires roughly once every
      // 28 seconds against a 15-second buff, which is under one stack on
      // average. Measured in game 2026-08-02, both halves: starved of Spark it
      // stacked to exactly 5 and stopped (the gauge, not the cap), and fed
      // Spark it reached 20 for +10% MagicMastery. The cap is real; standing at
      // it is not. Pricing the mean needs the stack counter's affix side, so
      // this is refused and named rather than kept at the flattering end.
      if (dur > 0 && !(cd > 0) && b.trigger?.hook === 'onStartConduit') {
        b.timed = false;
        b.uptime = 0;
        conduitBuffGaps.push({ id: b.status, from: b.from, stacks: b.stacks, duration: dur });
        continue;
      }
      b.uptime = (cd > 0 && dur > 0) ? Math.min(1, dur / Math.max(cd, src.occupancy)) : 1;
      b.timed = cd > 0 && dur > 0;
      if (b.timed) timed.push(b);
      else {
        mods.damageByAffinity.all = (mods.damageByAffinity.all ?? 0) + scriptDmgMult(b, 1);
        for (const a of b.affixes) if (!isScriptDmgMult(a)) applyAffix(a, b.stacks, 1);
      }
    }

    // The sheet the FIGHT starts from: everything permanent, nothing timed.
    const combatBase = evaluateLoadout(cat, loadout, {
      baseStatsFor, injectFlat: inject, injectAddRatio: addRatio, injectMulRatio: mulRatio, force,
    });
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
    const resting = combatBase;
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
      ...conduitBuffGaps.map((g) => ({
        id: g.id,
        source: 'conduit',
        kind: 'no rate',
        why: `it stacks to ${g.stacks} over ${g.duration}s, one stack per conduit trigger - and the `
          + 'gauge fires roughly once every 28 seconds against that window, so standing at the cap is '
          + 'not a thing a fight does. Measured in game both ways: starved of Spark it stacked to '
          + 'exactly five and stopped, fed Spark it reached the full twenty. Pricing the mean needs '
          + 'the stack counter on the affix side, so it is refused rather than kept at the cap',
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
        score: (loadout) => metrics(evaluate(loadout, { target, rank, mix, goal }))[goal] ?? 0,
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
      score: (loadout) => norm(metrics(evaluate(loadout, { target, rank, mix, goal: 'mixed' }))),
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
      severity: 'assumption',
      what: 'an item\'s stats follow the level it dropped at; its weapon damage follows its trained level',
      why: 'Verified on a real Cheese Moon: trained to weapon level 25 it still shows the effective-' +
           'level-11 stat budget (+36/+15/+18/+39/+39 - the same numbers as the level-10 Spear reading) ' +
           'while its damage line reads 18-21, the FULL primary budget at the trained level. So "Level ' +
           '25" on a weapon tooltip is training, not the drop. What a fresh drop at your level carries ' +
           'is still unmeasured: --drops scaled prices that hypothesis, and a ^N pin names an instance ' +
           'exactly.',
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
