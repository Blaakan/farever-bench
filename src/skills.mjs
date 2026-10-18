// ---------------------------------------------------------------------------
// skills.mjs - what you actually press, and what you had to choose.
//
// A weapon does not hand you its whole kit. It grants a fixed base-attack chain
// and a combo, which you always have, plus a POOL of `WeaponSkill` and
// `WeaponPassive` entries of which you slot only some. Most weapons offer three
// and you pick two, so "which two" is a build decision the same way an item is,
// and this module makes it one the search can choose.
//
// Slot counts come from the game's own constants, not from a list here:
//
//   UnlockLevel_WeaponSkillSlots  [1, 2]      main-hand skill slots
//   UnlockLevel_Arsenal           [7, 20, 50] arsenal (Slot_Weapon2) slots
//   Priest_Prayer_Slot_Unlocks    [1, 1, 9]   prayers in the sequence
//   Mage_Conduit_Levels           [1, 1, 4]   conduits
//
// so a level-12 character gets two main-hand skills, one arsenal skill and
// three prayers, and the numbers move on their own if a patch moves them.
//
// The second thing this module fixes is the difference between a skill you cast
// and a skill that fires at you. Roughly a third of what a build knows is
// `nature: Passive` - prayers, poisons, conduits, weapon passives, enchants.
// Those have a `cooldown` field that is an anti-double-fire guard, not a cast
// rate: `Priest_Prayer_Smite` reads `cooldown: 1` and doing 279 damage every
// second would make it the entire build. What makes it READY is in its own
// description - "Becomes ready after you use your [ComboAttack]" - and in its
// own script (not Priest_Rosary's, which has none on build 25782799):
//
//     function onSkillProc(ctx) {
//       if( ctx.skill.isFinalAttack() ) { chargePrayer(); }
//     }
//
// and what FIRES it is Judgment - see the PriestPrayer rule in `triggerRule`.
//
// So triggered skills get a rate from an explicit rule tied to something the
// data states, and anything without such a rule scores ZERO and is named in the
// coverage report rather than guessed at.
// ---------------------------------------------------------------------------

const FILLER_TYPES = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4', 'AttackCombo']);
const COMBO_TYPES = new Set(['AttackCombo']);

// The chain slots, IN ORDER. A weapon swings these one after another and the
// combo finishes; you cannot press swing 3 without 1 and 2, so the order is
// part of the model rather than whatever order the item row happens to list.
const CHAIN_SLOTS = ['Attack', 'Attack2', 'Attack3', 'Attack4'];

// Types you press, that sit on a real cooldown.
const ACTIVE_TYPES = new Set([
  'WeaponSkill', 'ClassSkill', 'SignatureSkill', 'Skill', 'Secondary',
]);

// How many class skills fit on the bar. Every one of the four classes declares
// exactly SIX `ClassSkill` rows, at levels 3, 5, 10, 15, 20 and 30 - so at the
// level-25 cap you have learned five and you slot four.
//
// That count is not in the data. It was told to us, the same way the 16 talent
// points were, and it is deliberately a named constant with an override rather
// than a number buried in an expression: `--class-skills`. Getting it wrong is
// not subtle - handing the Warrior all five gave it a free cooldown, and the
// class-skill bar is where a class's whole identity sits.
const CLASS_SKILL_SLOTS = 4;

// The per-class mechanic skills. Each is chosen from a pool and each fires on
// an event rather than on a cooldown.
// `repeats` says whether the SAME option may fill more than one slot. Nothing
// in the data declares it, so it is player testimony, the same standing as
// CLASS_SKILL_SLOTS: a Mage may slot one conduit twice, a Priest gets one of
// each prayer. The conduit side has corroboration in the game's own code -
// Mage_Conduit_Projectile's script fans by getSkillInstanceCount() /
// getSkillInstanceIndex() with a stagger, which only means anything if a
// second copy can exist - and in the live capture, where Emsay's three slots
// read Projectile x2 + Power. RoguePoison stays false: nothing says otherwise
// and its slot count is unbounded, so cycling would fabricate poisons.
const MECHANIC_TYPES = {
  PriestPrayer: { slotConstant: 'Priest_Prayer_Slot_Unlocks', label: 'prayers', repeats: false },
  MageConduit: { slotConstant: 'Mage_Conduit_Levels', label: 'conduits', repeats: true },
  RoguePoison: { slotConstant: null, label: 'poisons', repeats: false },
};

// Types that are never throughput: movement, mounts, menus.
const INERT_TYPES = new Set([
  'Dash', 'Swap', 'Jump', 'Exit', 'Mount', 'Action', 'ItemUse', 'GroupSkill',
]);

// `addStatus(<who>, Skill.<Id>)` - one of the two ways a status's identity is
// recorded. The status skill it names carries the actual affix and the stack
// cap in ordinary data columns; it is only the LINK that lives in script text,
// so this reads the link and nothing else. Two targets mean "me": `owner`, and
// `hit.source` inside an onInflictHit handler.
//
// Scripts also bind the skill to a local first - `Priest_Crusader` opens with
// `var Buff = Skill.Priest_Crusader_Status;` and then calls `addStatus(owner,
// Buff)` - so the aliases are resolved before the call sites are matched.
// Without that, every skill whose script does this reads as granting nothing
// and disappears from the build entirely.
const ADD_STATUS = /(?:addStatus|enforceStatus|setStatus)\s*\(\s*([A-Za-z_.]+)\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*([,)])/g;
const SKILL_ALIAS = /\b(?:var|final)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*Skill\.([A-Za-z0-9_]+)\s*;/g;
// `ownerHero` is the game's own alias for the owning hero - its scripts use it
// interchangeably with `owner` (`consumeStatus(ownerHero, ...)`,
// `ownerHero?.mage`), and reading it as a third party filed HighVoltage's
// guaranteed-crit register under "handed to an ally", which no ally ever saw.
// `skill.owner` is the same unit spelled out: the script's `owner` IS its
// skill's owner (script.SkillScript.get_owner@6705 ops 0-2 read
// `this.skill.owner`), and Bouncing Shot's compiled hook hands exactly that
// field to addStatus (script.skills.Bow_Craft_Skill2.onDamage@44926 ops
// 33-40). Read as a third party it filed Deadeye Focus under "handed to an
// ally or a summon"; the 2026-10-13 capture has that status on the hero whose
// skill applied it in 360 rows of 360 (the weapon passive's applications and
// this one's are one id in the log).
const SELF_TARGETS = new Set(['owner', 'ownerHero', 'skill.owner', 'hit.source', 'this.owner', 'dmg.source', 'ctx.source', 'self']);
// The thing you just hit. Everything NOT in this set and not in SELF_TARGETS
// is a third party - an ally, a party member, a summoned pet, usually bound to
// a lambda parameter - and a Buff handed to one of those is not YOUR buff.
// Crediting it is not a small error: `Warrior_IgnorePainStatus_Allies` is a
// second copy of a 60-second cooldown's mitigation, applied by a script that
// says `if (a != owner)` in as many words. Those are named as unreadable.
const ENEMY_TARGETS = new Set(['hit.target', 'dmg.target', 's.target', 'a.target', 'ctx.target', 'target']);

// The OTHER way, and the one no script is involved in at all: a `Status` step
// names the status it applies outright.
//
//   Priest_BlessingOfFervor.steps[] = { on: Hit, type: Status,
//                                       props: { status: { ref: ..._Status } } }
//
// That status is +10 Fervor for 15 seconds and the model was reading none of
// it, because it only ever looked in script text. `props.status.target` is an
// enum - Self, Target, Group and, since build 25782799, SkillTarget - absent
// meaning "whoever the step hit, else the caster". It is decoded by NAME, in
// `statusesOf`; this is only the recipients the model has a place for.
const STATUS_TARGETS = ['Self', 'Target', 'Group'];

// `addAtb(owner, Attribute.<X>, <n>)` / `addResource(<X>, <n>)` - a resource
// moving, and the other half of the sentence whose first half is `props.costs`.
//
// This is the SAME shape the reader already handles for `addStatus`: a hook, a
// guard naming events the fight counts, and a call. It was never matched, so
// the income side of every resource was invisible while the spend side sat in
// an ordinary column - and a skill gated by a resource was reported unscored on
// the grounds that "the rule lives in a script", when the rule is one line of
// script the reader was simply not looking at:
//
//   Warrior_Rage:  if( hit.isFirstHit && (hit.isBaseAttack || hit.isFinalCombo
//                      || hit.isWeaponSkill) && !(hit.skill?.isSignature()) )
//                    addAtb(owner, Attribute.Rage, vars.var1);
//
// `isFirstHit` costs nothing to honour - a gain is awarded per CAST, not per
// target hit, which is what the simulation does anyway - and `!isSignature()`
// is a real exclusion that stops the Warrior's own Rage spender from paying for
// itself.
const ADD_RESOURCE = /\b(addAtb|addResource)\s*\(\s*(?:owner\s*,\s*)?(?:Attribute\.)?([A-Za-z0-9_]+)\s*,\s*([^;]*?)\)\s*;/g;
// `extendStatusDuration(owner, Skill.X, vars.n)` - time added to a status that
// is ALREADY running. Distinct from addStatus, which re-applies or stacks.
const EXTEND_STATUS = /\bextendStatusDuration\s*\(\s*owner\s*,\s*Skill\.([A-Za-z0-9_]+)\s*,\s*([^),]+)\)/g;

// `hit.dmgMult += vars.damage` - a damage multiplier a STATUS confers, written
// in script because no affix row can express it.
//
// `Warrior_BerserkStatus` is the case that shows why it matters. Its own
// description reads "increase all damage done by 20% AND Rage generated ... by
// 1", and the model read only the Rage half: the +20% lives in an
// `onInflictDamageEval` one-liner and in a `CustomProperty` affix carrying a
// bare 20 with no target attribute. So Berserk looked like a Rage cooldown, the
// optimiser dropped it from the four class-skill slots, and the class's biggest
// damage cooldown was worth nothing.
//
// Read ONLY where the amount is a plain number and the guard is answerable -
// about sixty sites carry this shape and most are conditional on live state,
// per-cast, or scaled by a stack count. `x.dmgMult += stacks * vars.y` is not a
// number this reader has.
const DMG_MULT = /\b\w+\.(dmgMult|critDmgMult)\s*\+=\s*([^;]+);/g;

// A POOL dot: the third argument to `addStatus` is a share of the hit that
// applied it, and it is fully in the data.
//
//   // Warrior_Hemorrhage, vars.damage = 0.35
//   function onInflictDamage(dmg) {
//     if(dmg.isDoT) return;
//     if(dmg.critical && dmg.isPhysical) {
//       var amount = dmg.amount * vars.damage;
//       addStatus(dmg.target, Skill.Warrior_Hemorrhage_Status, amount);
//     }
//   }
//
// The model used to refuse the whole thing on the grounds that "its magnitude
// is the third argument to addStatus, computed by a script" - which was true of
// the shape and false of the number. `vars.damage` is right there.
//
// And because the status is `DurationBased` with unlimited stacks, NO DAMAGE IS
// LOST: every re-application carries the remainder forward. So the total over a
// fight is just `fraction x the damage that triggered it`, and the fight does
// not have to track individual bleed instances to get the total right - only
// the tail still ticking when the bell goes.
// --- per-category damage modifiers a talent confers -------------------------
//
// Most of the Warrior tree's "increased damage" nodes are one line, and they
// are all the same line with a different guard and a different field:
//
//   Sever              if (dmg.isWeaponSkill)              dmg.critDmgMult += 0.2
//   Master-at-arms     if (dmg.isBaseAttack||isFinalCombo) dmg.critDmgMult += 0.15
//   Bloodletting       if (dmg.isStatusType(Bleed))        dmg.dmgMult     += 0.1
//   Exsanguination     if (dmg.isStatusType(Hemorage))     dmg.critChance  += 0.1
//   Magic Conduction   if (target bleeding && dmg.isMagic) dmg.dmgMult     += 0.07
//   Exposed Essence    if (dmg.target.hasStatusType(Bleed)) armorIgnore     = 0.05
//
// None of these is a stat, which is why none of them was readable: a sheet has
// one DamageModifier and cannot say "+20% critical damage, but only on weapon
// skills". So they are read as SCOPED modifiers and applied where the scope
// says, and a reader that flattened them into one number would give every swing
// a weapon-skill bonus.
const DMG_FIELD = /\b\w+\.(dmgMult|critDmgMult|critChance|armorIgnore|magicArmorIgnore)\s*(?:\+=|=)\s*vars\.([A-Za-z0-9_]+)\s*;/g;

// Which damage a guard is talking about. Ordered: the most specific wins.
// The refusal is the important half. Falling back to "unconditional" when the
// predicate is unrecognised turns a narrow rider into a global damage bonus:
// `Priest_Talent_PiercingLight` came out as 100% magic-armour ignore and
// `Priest_Talent_Radiance` as a flat +24% damage, which took that class from
// 249 to 380 dps. So the guard must be EMPTY, or built only from the predicates
// named here. Anything else and the talent stays unread, by name.
// `\w+[.?]+` rather than `\w+\.`: the scripts use optional chaining, and
// `hit.skill?.isBaseAttack()` is the same predicate as `hit.skill.isBaseAttack()`.
// `Halos_Upgrade` was refused for a question mark.
// `isAttack` joined the list on build 25782799: BaseSkillAccess.get_isAttack@5192
// is `skill.isBaseAttack() || skill.isFinalAttack()`, the same five types a bare
// isBaseAttack already names. Blessing's status moved to it, and unknown it
// failed closed - refused for a predicate this file can price.
const KNOWN_PRED = /\b\w+[.?]+(?:isMagic|isPhysical|isWeaponSkill|isBaseAttack|isBasicAttack|isAttack|isFinalCombo|isFinalAttack|isStatusType|hasStatusType|critical|isCrit)\b|\b(?:isStatusType|hasStatusType)\s*\(/g;

/**
 * WHICH SWINGS A GUARD NAMES, for every reader that has to say.
 *
 * Three predicates, two reaches, read off the bytecode:
 *
 *   isBaseAttack   skill types 0-4, the combo finisher INCLUDED
 *                  (BaseSkill.isBaseAttack@6153: ops 7-10 the switch on 0-3,
 *                  ops 18-22 `type == 4`). As `hit.isBaseAttack` /
 *                  `dmg.isBaseAttack` it is asked of the STEP
 *                  (ScriptHitData.get_isBaseAttack@6292,
 *                  DamageResult.get_isBaseAttack@5220 ->
 *                  SkillStep.isBaseAttack@6027: the step's own BaseAttack
 *                  flag, or the same test on its skill).
 *   isAttack       the same five types (get_isAttack@5192).
 *   isBasicAttack  types 0-3 only (BaseSkill.isBasicAttack@6152).
 *   isFinalCombo / isFinalAttack   type 4 only (get_isFinalCombo@5191 ->
 *                  BaseSkill.isFinalAttack@6154).
 *
 * The tooltips keep the same split: `[Attack]` on a row whose script says
 * isBaseAttack (Groundswell Strike: "All your [Attack]s reduce the
 * cooldown"), `[BasicAttack]` - printed "Base Attack" - on one that says
 * isBasicAttack (the weapon upgrades), `[ComboAttack]` for the finisher.
 *
 * `scopeOf` already read it this way. `eventsOf`, `triggerOf` and the rule
 * ladders built on them read a bare isBaseAttack as "not the finisher", which
 * dropped the finisher's share from every proc, give-back and applier written
 * that way - Groundswell's own refund among them, on a skill that is a third
 * of its weapon.
 *
 * A guard can take the finisher back out - Envenom is `ctx.isBaseAttack &&
 * ... && !ctx.isFinalCombo` - and that is honoured in a plain conjunction
 * only: inside a disjunction the negation belongs to one alternative
 * (Zeal's `!hit.isFinalCombo && hit.isWeaponSkill || hit.isBaseAttack`).
 */
function swingsOf(guard) {
  // An early return is the positive condition written backwards: `if
  // (!ctx.isFinalCombo) return;` in front of a call means the call runs on
  // the finisher (Honor, the Crimson set's status, is applied that way) -
  // not that the finisher is excluded.
  const g = String(guard).replace(/if\s*\(\s*!\s*([\w.?]*\bis(?:FinalCombo|FinalAttack)(?:\s*\(\s*\))?)\s*\)\s*return\b/g, 'if ($1)');
  const wide = /isBaseAttack|\bisAttack\b/.test(g);
  const notFinisher = !/\|\|/.test(g) && /!\s*[\w.?]*\bis(?:FinalCombo|FinalAttack)\b/.test(g);
  const finisher = /is(?:FinalCombo|FinalAttack|ComboAttack)\b/
    .test(g.replace(/!\s*[\w.?]*\bis(?:FinalCombo|FinalAttack)\b/g, ' '));
  return {
    attack: wide || /isBasicAttack/.test(g),
    combo: !notFinisher && (wide || finisher),
  };
}

/**
 * HOW OFTEN A SWING RAISES THE HOOK A RIDER IS WRITTEN IN - one rule, for
 * every reader that puts a rider on the swing clock.
 *
 * onInflictHit is raised once per HIT (BaseSkill.onHit@6233 ops 102-114 run
 * for every HitData the swing produces; only onFirstHit, ops 83-88, is held
 * to the first) and onInflictDamage once per damage instance (its dispatcher
 * is server-side and gone from this client; per instance is how the pre-patch
 * capture reconciles). So a roll or a playStep written there happens for each
 * hit a qualifying swing lands - a dual-wield finisher twice - unless the
 * guard itself says `isFirstHit`. Any other hook is the reader's own business
 * and is not per hit by this rule.
 *
 * THE TWO HOOKS COUNT DIFFERENT THINGS, and a swing whose one step carries
 * two damage effects is where they part: it is ONE hit and TWO damage
 * instances. MEASURED 2026-10-13 on Demonic Bite (one step, a Physical and a
 * Magic effect), 827 finishers: Flaming Weapon - onInflictHit, 30% - played
 * beside 252 of them (30.5%) and never twice beside one; Gash's application -
 * onInflictDamage, 20% - came with 314 (38.0%, where two rolls give 36% and
 * one gives 20%). On the basic swings, one effect each, they are the same
 * count: 29.5% and 21.4% of 4,336. `swingHookPerLanding` says which count a
 * hook takes; the fight holds both (castOutput's `landings` and `hits`).
 */
export function swingHookPerHit(hook, guard) {
  return /^onInflict(?:Hit|Damage)$/.test(hook ?? '') && !/\bisFirstHit\b/.test(String(guard));
}
/** Whether a per-hit hook is raised per HIT (onInflictHit) rather than per damage instance. */
export function swingHookPerLanding(hook) {
  return hook === 'onInflictHit';
}

/**
 * `rank` is optional and changes what the guard reader will answer. A talent
 * caller passes none: a node's rank is how many POINTS are in it, and the
 * scripts do not test it. A weapon-skill caller passes the weapon rank, because
 * its scripts DO - `if (rank >= 3)` is a question about the build, not about
 * live state, and refusing it left five of the eight `reduceWeaponsCooldown`
 * rows in the game unread.
 */
function scopeOf(block, rank = null) {
  // Only the `if` CONDITIONS are the guard. The enclosing block also carries
  // whatever statements ran before the call, and `Exposed Essence` sets two
  // fields on consecutive lines - so reading the whole block made the second
  // line's guard contain the first line's assignment, and refused it.
  const guard = [...String(block).matchAll(/\bif\s*\(([^{]*)\)/g)].map((m) => m[1]).join(' && ');
  // Strip the handler signature and every predicate we understand. If anything
  // condition-shaped survives, we do not understand this guard.
  // A rank comparison is answered when the caller knows the rank, and only for
  // a plain conjunction - inside a disjunction the clause belongs to one
  // alternative and vetoing the whole guard on it silences the other paths.
  if (rank != null && !/\|\|/.test(guard)) {
    for (const r of guard.matchAll(/\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g)) {
      const n = Number(r[2]);
      const ok = r[1] === '>=' ? rank >= n : r[1] === '<=' ? rank <= n
        : r[1] === '>' ? rank > n : r[1] === '<' ? rank < n
          : r[1] === '==' ? rank === n : rank !== n;
      if (!ok) return null;
    }
  }
  const rest = String(guard)
    .replace(/function\s+on\w+\s*\([^)]*\)/g, ' ')
    .replace(rank != null ? /\brank\s*(?:>=|<=|==|!=|>|<)\s*\d+/g : /(?!)/g, ' ')
    .replace(KNOWN_PRED, ' ')
    // Enum members and bare status-type names - `StatusType.Hemorage`, and the
    // plain `Bleed` the scripts also write.
    .replace(/\b(?:StatusType|Skill|Mastery|Attribute|Steps)\.\w+/g, ' ')
    .replace(/\b[A-Z]\w*\b/g, ' ')
    // The receivers a predicate hangs off. `dmg.target.hasStatusType(Bleed)`
    // leaves `dmg` behind once the predicate is stripped, and that is not a
    // condition.
    // The proc roll is read explicitly by the callers, so it is not an
    // unrecognised condition - `Red Tempo`'s `checkProba(vars.chance)` is the
    // 12% it advertises, not something opaque.
    .replace(/\bcheckProba\s*\([^)]*\)/g, ' ')
    .replace(/\bvars\.\w+/g, ' ')
    .replace(/\b(?:dmg|hit|ctx|owner|target|self|s|a|if|var|return)\b/g, ' ')
    .replace(/[\s{}()&|!,;.]/g, '');
  if (rest.length > 0) return null;

  // `dmg.isStatusType(X)` scopes the bonus to damage FROM a status of that
  // type, and X is not always the one you are looking at: the Warrior tree says
  // Bleed and Hemorage, the Rogue tree says Poison. Reading any of them as "all
  // damage" is how `Rogue_Talent_LethalDose` became a flat +20%.
  const fromStatus = /\bisStatusType\s*\(\s*(?:StatusType\.)?(\w+)/.exec(guard)?.[1] ?? null;
  const targetBleeding = /(?:target\s*,\s*StatusType\.|target\.)hasStatusType|hasStatusType\s*\([^)]*target/.test(guard);
  // ...and WHICH type the target has to be wearing. The flag above is named
  // for the first tree that used it; the Rogue's says Poison
  // (`dmg.target.hasStatusType(StatusType.Poison)`), and a reader that keeps
  // only the flag prints "vs bleeding" beside a poison talent and credits it
  // in a fight where nothing is poisoned.
  const targetType = targetBleeding
    ? /hasStatusType\s*\(\s*(?:[\w.]+\s*,\s*)?(?:StatusType\.)?(\w+)\s*\)/.exec(guard)?.[1] ?? null : null;
  if (/isMagic/.test(guard)) return { scope: 'magic', targetBleeding, targetType };
  if (/isWeaponSkill/.test(guard)) return { scope: 'weaponSkill', targetBleeding, targetType };
  // Which half of the swing-and-finisher pair a guard names is a third of the
  // rate, and collapsing both onto 'attack' silently dropped the finisher:
  // Zealous Fighter's +8pp crit reads `isBaseAttack || isFinalCombo`, and the
  // finisher never saw it.
  {
    // Two near-twin predicates with different reach: BaseSkill.isBaseAttack@6153 is
    // skill types 0-4 - the FINISHER included - while BaseSkill.isBasicAttack@6152
    // stops at 3. Scripts use both deliberately, and folding them onto one
    // scope handed a future isBasicAttack rider to the finisher and stripped
    // the finisher from every bare isBaseAttack guard.
    const sw = swingsOf(guard);
    if (sw.attack && sw.combo) return { scope: 'attack-or-combo', targetBleeding, targetType };
    if (sw.combo) return { scope: 'combo', targetBleeding, targetType };
    if (sw.attack) return { scope: 'attack', targetBleeding, targetType };
  }
  if (fromStatus) {
    // WHICH bleed is kept, not collapsed. The statusType sheet subtypes them
    // one way - `Hemorage` declares `parent: Bleed`, nothing else declares a
    // parent - so a guard naming Bleed covers a Hemorage dot but a guard
    // naming Hemorage covers only Hemorage dots. Folding both onto one scope
    // handed Exsanguination's crit chance to Bonethrow's plain-Bleed pool,
    // a talent whose own guard says `isStatusType(StatusType.Hemorage)`.
    return /^(?:Bleed|Hemorage)$/.test(fromStatus)
      ? { scope: 'bleed', statusType: fromStatus, targetBleeding }
      : { scope: 'dot:' + fromStatus, targetBleeding };
  }
  if (targetBleeding) return { scope: 'all', targetBleeding, targetType };
  return { scope: 'all', targetBleeding: false };
}

// The share may be wrapped in one rounding call. Aimed Shot's rank-3 bleed is
// `var dot = ceil(hit.amount * vars.var1);`, and demanding the bare product
// left "Enemies bleed for 25% of the damage dealt ... if this critically
// strikes" without a line or a sentence. The rounding itself is under one
// point of damage per application and is not priced.
const POOL_LOCAL = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:ceil|round|floor)\s*\(\s*)?\w+\.amount\s*\*\s*vars\.([A-Za-z0-9_]+)\s*\)?\s*;/g;
const ADD_STATUS_3 = /(?:addStatus|enforceStatus|setStatus)\s*\(\s*([A-Za-z_.]+)\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*,\s*([^;()]+?)\)\s*;/g;

/** A literal, `vars.x`, or `-vars.x`. Anything else is not a number we have. */
function amountOf(expr, vars, runeVars = null) {
  const t = String(expr).trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(-?)\s*vars\.([A-Za-z0-9_]+)$/.exec(t);
  if (!m) return null;
  // A rune can supply the number the skill itself does not declare -
  // Warrior_Charge reads `vars.var1` and its own vars have no var1 - and it can
  // also REPLACE one the skill does declare. `updateSkillInf@21787` runs
  // applyProps and applyVars per slotted mastery on top of the row's own, so
  // the rune wins wherever both name the same key; reading the base row instead
  // is how Execution (`Warrior_RageStrike_M3`) printed the row's 0.5 above 0.2
  // when the rune it is gated on says 0.25 above 0.35 - the tooltip's numbers.
  // Six rows in the sheet override a key their base row also defines, one in
  // each class plus two on the Mage, so this is a mechanism and not one item.
  const v = runeVars?.[m[2]] ?? vars?.[m[2]];
  return typeof v === 'number' ? (m[1] ? -v : v) : null;
}

// --- what else the guard is conditional on ---------------------------------
//
// The guard reader used to match its four predicates and IGNORE everything else
// in the same `if`, which credits a proc with a rate it does not have. Across
// the sheet, 37 of the skills carrying a `vars.chance` and 20 of the addStatus
// call sites carry a second condition alongside the one being read. They are
// not all the same kind of thing:
//
//   rank >= 2        EVALUABLE. It is the weapon-skill rank, the same number
//                    --rank resolves on every step, effect and affix. The model
//                    knew it all along and was not applying it here, so a
//                    rank-2 rider was credited to a rank-1 character.
//   hasTalent(X)     EVALUABLE. The loadout says which talents are allocated.
//   hasMastery(X)    EVALUABLE. The loadout says which runes are slotted.
//   hasStatus(X)     NOT. It is a question about live state at the moment the
//   getStatusCount   proc rolls, and the honest answer is that the rate is
//   hasStatusMaxStacked  conditional on something this reader cannot evaluate.
//   .stacks/getMaxStacks
//   isStatusType     `DA_Water_Combo_PassiveRank3` is the case that shows why it
//   isInCooldown     matters: its script is `isBaseAttack && status.stacks >=
//                    status.getMaxStacks() && checkProba(0.35)`, and reading
//                    only the first and last credits it 0.35 per swing when it
//                    actually needs a max-stacked buff first.
//
// So the first three are evaluated, and a call site still carrying one of the
// rest keeps its rate REFUSED and NAMED rather than approximated.
const RANK_CMP = /\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g;
// The enum prefix matters: these are written `hasMastery(Mastery.Warrior_Charge_M3)`
// and `hasTalent(Skill.X)`, so a pattern that only allows `Skill.` captures the
// literal word "Mastery" as the id, finds no such rune, and silently deletes the
// branch - which is worse than not reading the guard at all.
const HAS_BUILD = /\b(?:hasTalent|hasMastery|hasGlobalMastery)\s*\(\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*)?(?:(?:Mastery|Skill|Talent|Attribute)\.)?([A-Za-z0-9_]+)/g;
// A damage multiplier scaled by the COUNT of a status the owner carries -
// `hit.dmgMult += getStatusCount(owner, Skill.S) * vars.X`. `DMG_FIELD` cannot
// see it, because it demands a bare `vars.X` on the right of the `+=`, and
// `DMG_MULT` is only ever applied to status scripts. Fifteen sites in the sheet
// write a count into a damage field and twelve are player-reachable.
const OWN_STACK_MULT =
  /(?:hit|dmg|ctx)\.dmgMult\s*\+=\s*getStatusCount\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)\s*\)\s*\*\s*vars\.(\w+)/;

const UNREAD_COND = /\b(hasStatusMaxStacked|hasStatusApplied|hasStatusType|hasStatus|getStatusCount|getStatusesCount|getStatusTypeCount|isStatusType|isInCooldown|isSkillInCooldown|getMaxStacks|getEffectCount|haveProc|canRecast|haveRecast|isUnderAnyCC|isCCImmune|checkComboPoints|getCp|critical|isCrit|healthRatio|isPhysical|isMagic|totalHits|hitCount)\b/;
// "The cast's first hit" has a second spelling since build 25959898, for a
// cast whose hit is a projectile's: Acidic Splatter's guard reads
// `hit.isFirstHit || (hit.projectile != null && hit.hitCount == 0)` - the
// patch notes' fix for the ranged Finisher. That `hitCount` asks nothing the
// first-hit gate does not, so it is not an unreadable condition.
const FIRST_HIT_OR_PROJECTILE = /(\w+)\.isFirstHit\s*\|\|\s*\(\s*\1\.projectile\s*!=\s*null\s*&&\s*\1\.hitCount\s*==\s*0\s*\)/g;
const unreadCond = (scope) => UNREAD_COND.exec(String(scope).replace(FIRST_HIT_OR_PROJECTILE, '$1.isFirstHit'));

/**
 * "Only at this many ready prayers": `var n = <x>.getChargedPrayerCount();
 * if (n == vars.k)` in front of a call, or the count compared in place.
 * PriestComponent.getChargedPrayerCount@30854 counts the prayers of the
 * sequence that are not in cooldown (ops 22-28) - the same "ready" the release
 * asks (divineInterventionProc@30855) - so it is live state, but state the
 * fight itself holds at the moment of the press. Unread, it credited Spirited
 * Disciple - "when you activate 3 [Prayer]s all at once" - on every press.
 * Returns the comparison, or null when the count is used any other way.
 */
function readyPrayerTest(scope, vars, runeVars = null) {
  const local = /\bvar\s+(\w+)\s*=\s*[\w.?]+\.getChargedPrayerCount\s*\(\s*\)\s*;/.exec(scope)?.[1] ?? null;
  const CMP = String.raw`\s*(==|>=|<=|!=|>|<)\s*(vars\.\w+|\d+)`;
  const m = (local ? new RegExp(String.raw`\b` + local + CMP).exec(scope) : null)
    ?? new RegExp(String.raw`getChargedPrayerCount\s*\(\s*\)` + CMP).exec(scope);
  if (!m) return null;
  const n = amountOf(m[2], vars, runeVars);
  return typeof n === 'number' ? { op: m[1], n } : null;
}

const cmpOk = (a, op, b) => (op === '>=' ? a >= b : op === '<=' ? a <= b
  : op === '==' ? a === b : op === '!=' ? a !== b : op === '>' ? a > b : a < b);

// `s.kind == <X>` - "this handler fires for THAT thing", and which thing
// decides whether the guard is a condition at all.
//
//   s.kind == Steps.Area       a step of the skill's own cast. The step always
//                              runs, so this is a dispatch, not a condition.
//   s.kind == Unit.Summon_Bee  a check on who was hit; already refused by the
//                              `elsewhere` test.
//   s.kind == Skill.<Status>   A DEPENDENCY. `onReceiveStatus(s) { if (s.kind
//                              == Shield) addStatus(owner, Buff); }` fires only
//                              when something ELSE applies that status.
//
// The third one went unread, so the guard evaluated to "unconditional" and the
// payload was credited whole. `Warrior_Talent_HoldTheLine` is the case:
// +6% damage and -6% damage taken while `Warrior_Talent_RageShield_Status` is
// up - and Rage Shield is a separate talent, in a different branch, that the
// build may simply not have taken. A build without it was being handed 22 dps
// for a node whose own text says "while ::ref2_name:: is active".
//
// Four talents across three classes have this shape and every one of them
// depends on another node of the SAME tree: Hold the Line on Rage Shield,
// Atrophic Poison and Crippling Poison on Lethal Poison, Potent Fortitude on
// the Priest's Shield prayer. So it is answerable - the loadout says what it
// has - and it is answered rather than refused.
const STATUS_DEP = /\b\w+(?:\.\w+)*\.kind\s*==\s*(?:Skill\.)?([A-Za-z0-9_]+)/g;

/**
 * Everything in `scope` that decides whether the call fires, split into what
 * the model can answer and what it cannot.
 *
 * `fires: false`  the condition is evaluable and it is FALSE - the call is dead
 *                 for this build, and crediting it would be inventing damage.
 * `unread: <name>` a condition on live state; the rate is not derivable.
 */
// THE RANK GATE, decided per `if` and not over the whole scope. A rank test
// vetoes a call only where it is a top-level conjunct of a condition the call
// sits behind, and only when it is the row's OWN rank:
//
//   if (rank >= 3 && dmg.critical) ...        the rank is the gate
//   if (dmg.isBaseAttack || (x && spinSkill.rank >= 3)) ...
//                                             it belongs to one alternative,
//                                             and to ANOTHER skill's rank
//
// Nectar-infused Blade is the second line, and matching `rank >= 3` anywhere
// in the scope refused its whole bonus hit below rank 3. (`scopeOf` answers
// the same question by switching the veto off when ANY `||` is in sight,
// which would also drop a plain `if (rank >= 3)` nested under an
// `isBaseAttack || isFinalCombo` - one of the commonest shapes in the sheet -
// so the test is not copied; each condition is judged on its own.)
//
// An early exit is the same gate inverted: `if (rank < 3) return;` lets the
// rest run only where the test is FALSE.
const BARE_RANK = /^rank\s*(>=|<=|==|!=|>|<)\s*(\d+)$/;
function splitTop(text, op) {
  const parts = [];
  let d = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
    else if (d === 0 && text.startsWith(op, i)) { parts.push(text.slice(from, i)); from = i + op.length; i += op.length - 1; }
  }
  parts.push(text.slice(from));
  return parts;
}
// Outer whitespace and one or more fully enclosing pairs of parentheses off.
function bare(term) {
  let t = term.trim();
  for (;;) {
    if (!(t.startsWith('(') && t.endsWith(')'))) return t;
    let d = 0, wraps = true;
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i] === '(') d++;
      else if (t[i] === ')') d--;
      if (d === 0) { wraps = false; break; }
    }
    if (!wraps) return t;
    t = t.slice(1, -1).trim();
  }
}
// Every `if (...)` condition in a scope, parentheses balanced, with whether
// the statement behind it is an early exit.
function ifConds(scope) {
  const out = [];
  const IF = /\bif\s*\(/g;
  for (let m; (m = IF.exec(scope));) {
    const open = m.index + m[0].length - 1;
    let d = 0, close = -1;
    for (let i = open; i < scope.length; i++) {
      if (scope[i] === '(') d++;
      else if (scope[i] === ')') { d--; if (d === 0) { close = i; break; } }
    }
    out.push({
      cond: scope.slice(open + 1, close < 0 ? scope.length : close),
      exits: close >= 0 && EARLY_EXIT.test(scope.slice(close + 1).trimStart()),
    });
  }
  return out;
}
function rankVeto(scope, rank) {
  for (const { cond, exits } of ifConds(scope)) {
    const alts = splitTop(cond, '||');
    if (exits) {
      // The rest runs only if every alternative is false.
      for (const alt of alts) {
        const r = BARE_RANK.exec(bare(alt));
        if (r && cmpOk(rank, r[1], Number(r[2]))) return `its script returns early on rank ${r[1]} ${r[2]}`;
      }
      continue;
    }
    if (alts.length > 1) continue;
    for (const term of splitTop(cond, '&&')) {
      const r = BARE_RANK.exec(bare(term));
      if (r && !cmpOk(rank, r[1], Number(r[2]))) return `its script gates on rank ${r[1]} ${r[2]}`;
    }
  }
  return null;
}

function guardOf(scope, { rank = 1, runes = null, talents = null } = {}) {
  {
    const veto = rankVeto(scope, rank);
    if (veto) return { fires: false, why: veto };
  }
  HAS_BUILD.lastIndex = 0;
  for (let m; (m = HAS_BUILD.exec(scope));) {
    const id = m[1];
    // Nothing was passed, so nothing can be asserted - fall through to unread
    // rather than pretending the build does not have it.
    if (!runes && !talents) return { fires: true, unread: 'hasTalent/hasMastery' };
    if (!(runes?.has(id) || talents?.has(id))) {
      return { fires: false, why: `its script gates on ${id}, which this build does not have` };
    }
  }
  const un = unreadCond(scope);
  return { fires: true, unread: un ? un[1] : null };
}

// Comments out of a script body, so nothing switched off is ever credited.
// Whitespace is preserved so an index into the result still points at the same
// place in the original.
const blank = (s) => s.replace(/[^\n]/g, ' ');
const liveScript = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/\/\/[^\n]*/g, blank);

// A script can give an expression a name of its own. Expulse's recast read
// `var orbCount = getStatusCount(owner, Skill.Book_WaterOrbs_Orb_Charge);` up
// to build 25782799 and reads `var orbCount = getOrbCount();` beside
// `function getOrbCount() { return getStatusCount(owner, Skill.Book_WaterOrbs_Orb_Charge); }`
// since 25959898 - the same count, and a shape reader that spells the
// expression out stopped matching it. Every zero-argument function whose whole
// body is one `return <expr>;` is put back in place of its calls. Takes text
// already stripped of comments (liveScript) and of whitespace.
export function inlineReturnHelpers(text) {
  let out = text;
  for (const [, name, expr] of text.matchAll(/function(\w+)\(\)\{return([^;{}]+);\}/g)) {
    out = out.replace(new RegExp(`(?<![\\w.])${name}\\(\\)`, 'g'), expr);
  }
  return out;
}

// WHICH HALF of a script the fight can raise.
//
// A hook that waits for a block, or for being hit, never fires against a foe
// that does not attack. A hook that fires on damage you DEAL fires on every hit
// you land - on the 2026-08-11 build `receiveDamage` ops 97-114 raised
// onInflictDamage on the INSTIGATOR, not on the victim (Unit.receiveDamage@4913
// is a server-only stub on the client of build 25782799, where that read cannot
// be repeated; the 2026-10-13 capture still has the hook on the dealer's side:
// Gash's roll, written in onInflictDamage, came with 314 of the Rogue's 827
// Demonic Bites). Asking only whether a DEFENSIVE hook is
// PRESENT therefore reported a script that is half offensive as wholly
// defensive. `Shell of the Devourer` is the case that shows it: onGameBeat
// with GameBeat.AttackBlock alongside onInflictHit AND onInflictDamage, filed
// under "it fires when you block or when you are hit, and the simulated foe
// never attacks" - true of one of its three hooks. A player reading that
// concludes the zero belongs to the fight model, when half of it belongs to the
// reader.
//
// Returns null when nothing defensive is declared, else the two hook lists and
// whether an offensive one rides along. Naming the hooks is the point: "half of
// it fires" without saying WHICH half is not an improvement on the old lie.
const DEF_HOOK_NAME = /^on(?:ReceiveDamage|ReceiveDamageEval|ReceiveHit|BlockEval)$/;
const OFF_HOOK_NAME = /^on(?:InflictDamage|InflictDamageEval|InflictHit|SkillProc|FirstHit|StacksChange|Damage|DamageEval|Hit|Cast|UseSkill|Kill)$/;
function foeGating(script) {
  const body = liveScript(script ?? '');
  if (!body) return null;
  const names = [...body.matchAll(/function\s+(on\w+)\s*\(/g)].map((m) => m[1]);
  const def = names.filter((n) => DEF_HOOK_NAME.test(n));
  // Two block beats, not one: `AttackBlock` and `BlockWellTimed` split the
  // twelve GameBeat hooks in the sheet evenly, and reading only the first is
  // how Shield Bash's whole rider stayed invisible to this test.
  if (/GameBeat\.(?:AttackBlock|BlockWellTimed)/.test(body)) def.push('a block');
  if (!def.length) return null;
  const off = names.filter((n) => OFF_HOOK_NAME.test(n));
  return { mixed: off.length > 0, def, off };
}

// The text of the innermost block still OPEN at the end of `src`, with every
// closed sibling block removed. Given
//
//     function onInflictDamage(dmg) {
//       if (dmg.isBaseAttack && checkProba(vars.chance)) { doOneThing(); }
//       if (dmg.isFinalCombo) { addStatus(
//
// this returns only the second `if`, so the first branch's guard is not
// attributed to a call it does not guard.
// A closed sibling's HEADER has to go with it. Dropping only the body leaves
// `if (ctx.target.hasStatus(mark) && ...)` sitting at depth 0, so the guard on
// the branch that ran gets attributed to the branch that did not:
// `Bow_BigGame_Passive` marks a target in its `else if` and the condition from
// the `if` above it read as a condition on the mark.
//
// A closed sibling WITHOUT braces has to go too. `if (cond) statement;` that
// has already ended guards its one statement and nothing after it, but it
// carries no `}` for the walk below to count, so its condition stayed at
// depth 0 and read as a guard on whatever followed. Nectar-infused Blade is
// the case:
//
//     if (dmg.isBaseAttack || ...) {
//       if (rank >= 3 && dmg.critical)
//         reduceCooldown(Skill.Crescent_FlowerSpiral_Skill_1, vars.time);
//
//       playStep(Steps.Damage, dmg.target);
//
// and the bonus hit every swing lands was priced on critical strikes only,
// from rank 3 only, and the slow on the same step refused as applied "only
// while critical() holds". The pre-patch capture has the same script shape
// and settles which reading is the game's: 16,253 of 16,992 one-hit swings
// that did NOT crit carry the extra hit (95.7%), against 4,303 of 4,583 that
// did (93.9%). Blanked before the walk, on the ORIGINAL text - once the
// braces are gone a braced `if (...) {` and a braceless one look the same.
// Three things are deliberately NOT blanked:
//   * an `if` whose statement has not ended - it is the guard of the very
//     call being read;
//   * an early exit, `if (...) return;` (or continue / break / throw): it
//     guards everything after it. 45 scripts carry one, and blanking them
//     turned Infusion_Crimson_Tank's "on the combo finisher" into "on every
//     cast". Under any depth of braceless `if`s: `if (a) if (b) return;`
//     leaves through the same door, where `if (a) if (b) x();` is two closed
//     siblings and both go;
//   * one followed by `else`: the else branch is still guarded by it.
const EARLY_EXIT = /^(?:return|continue|break|throw)\b/;
function blankClosedBracelessIfs(src) {
  const closeOf = (open) => {
    let d = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') d++;
      else if (src[i] === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  };
  let out = src;
  const IF = /\bif\s*\(/g;
  for (let m; (m = IF.exec(src));) {
    const close = closeOf(m.index + m[0].length - 1);
    if (close < 0) break;
    let s = close + 1;
    while (s < src.length && /\s/.test(src[s])) s++;
    if (s >= src.length || src[s] === '{') continue;      // braced, or nothing after it yet
    // A nested braceless `if` is its own match; this one ends where that ends.
    let e = s, d = 0, ended = false;
    for (; e < src.length; e++) {
      const ch = src[e];
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (d === 0) break; d--; }
      else if (ch === ';' && d === 0) { ended = true; break; }
    }
    if (!ended) continue;
    // The statement it finally guards, past any braceless `if` nested in
    // front of it - that one is asked whether it is a way out.
    let stmt = s;
    for (let n; (n = /^if\s*\(/.exec(src.slice(stmt, stmt + 16)));) {
      const c = closeOf(stmt + n[0].length - 1);
      if (c < 0) break;
      stmt = c + 1;
      while (stmt < src.length && /\s/.test(src[stmt])) stmt++;
    }
    if (EARLY_EXIT.test(src.slice(stmt, stmt + 10))) continue;
    if (/^\s*else\b/.test(src.slice(e + 1))) continue;
    // `else if (...) x;` keeps its `else`; only the if and its statement go.
    out = out.slice(0, m.index) + out.slice(m.index, e + 1).replace(/[^\n]/g, ' ') + out.slice(e + 1);
  }
  return out;
}

export function enclosingBlock(text) {
  const src = blankClosedBracelessIfs(String(text));
  const out = [];
  let depth = 0;
  let i = src.length - 1;
  while (i >= 0) {
    const ch = src[i];
    if (ch === '}') { depth++; i--; continue; }
    if (ch === '{') {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          // That was a sibling block at our own level. Its header - `if (...)`,
          // `else if (...)`, `for (...)` - is immediately before it, so walk
          // back to the previous statement boundary and drop it too.
          i--;
          while (i >= 0 && !'{};'.includes(src[i])) i--;
          continue;
        }
      }
      i--; continue;    // an OPEN brace: this one encloses the call, so keep going
    }
    if (depth === 0) out.push(ch);
    i--;
  }
  return out.reverse().join('');
}

// The name of the function a position in a script sits in, or ''.
const hookAt = (body, index) => [...body.slice(0, index).matchAll(/function\s+(\w+)\s*\(/g)].pop()?.[1] ?? '';

// What the THIRD argument of an addStatus / setStatus / enforceStatus call is.
// `from` is the index just past the second comma; `call` the matched head.
//   count      a literal or a bare vars.X - how many stacks the call adds
//   toggle     `<cond> ? 1 : 0`, a bare 0, or enforceStatus's boolean - the
//              status is held while the condition is
//   magnitude  anything else: an amount the script worked out, which the
//              status row then carries only a placeholder for (`text` is
//              what it wrote, for the refusal's sentence)
function thirdArgOf(body, from, call, vars = null) {
  let depth = 0, i = from;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth === 0) break; depth--; }
  }
  const text = body.slice(from, i).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return Number(text) === 0 ? { kind: 'toggle', cond: 'never (this call is the one that takes it off)' }
      : { kind: 'count', n: Number(text) };
  }
  const v = /^vars\.([A-Za-z0-9_]+)$/.exec(text);
  if (v) return { kind: 'count', n: typeof vars?.[v[1]] === 'number' ? vars[v[1]] : null };
  const tern = /^([\s\S]+?)\?\s*1\s*:\s*0$/.exec(text);
  if (tern) return { kind: 'toggle', cond: tern[1].replace(/\s+/g, ' ').trim() };
  if (/^enforceStatus\b/.test(call)) return { kind: 'toggle', cond: text.replace(/\s+/g, ' ') };
  return { kind: 'magnitude', text: text.replace(/\s+/g, ' ') };
}
// The two hooks build 25782799 added for damage dealt by a hero's PROXIES -
// its summons. `BaseSkill.evalDamage@6124` ops 9-70 raise onProxyDamageEval
// (slot 29) on the proxy-resolved owner's skills and statuses when the
// hitting unit is not its own proxy, and BaseSkill.onInflictDamageEval@6126 ops 5-16
// send the summon's own rows through the same slot - so the owner's
// onInflictDamageEval never sees a pet's hit, and a clause in a proxy hook
// never sees the owner's. onProxyDamage (slot 30) is the post-damage twin;
// its dispatcher is server-side and not in this client.
const PROXY_HOOK = /^onProxyDamage(?:Eval)?$/;

// WHAT A CAPTURE HOLDS OF A "STRIKE AGAIN" TALENT, by the row that was
// measured: the basic-attack damage rows landed with the point held, how many
// of them carried the refresh its guard would have to see through, and how
// many swings landed a second row of themselves on that target inside 400 ms.
// A measurement is of one row on one build; a talent of the same shape this
// table does not name is still told "not ruled out" and what to measure.
const REPLAY_ROWS = {
  Rogue_Talent_OpportunityStrike: { date: '2026-10-13', swings: 381, carriers: 187, replays: 0 },
};

/**
 * A step a script plays for a skill DIFFERENT FROM THE LAST ONE THAT PLAYED
 * IT: a script-level variable the guard compares with the hitting skill's
 * kind and the block sets to it beside the play. Returns the step, whether
 * only a cast's first hit counts, and which skills the guard admits - read
 * off the guard and off the body of any helper the guard hands the skill to
 * (`isSkillCompatible(s)`) - or null when the script has no such memory.
 */
function lastFiredRider(script) {
  const body = liveScript(script ?? '');
  const m = /if\s*\(([^{}]*?\b(\w+)\s*!=\s*(\w+)\.kind\b[^{}]*?)\)\s*\{\s*playStep\s*\(\s*Steps\.(\w+)[^;]*;\s*\2\s*=\s*\3\.kind\s*;/.exec(body);
  if (!m) return null;
  const [, guard, memory, , step] = m;
  // The memory has to be the script's own, declared outside every function:
  // a local would be new at each hit and remember nothing.
  if (!new RegExp(`(?:^|\\n)\\s*var\\s+${memory}\\b`).test(body.replace(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g, ''))) return null;
  const helpers = [...guard.matchAll(/\b([a-z]\w*)\s*\(\s*\w+\s*\)/g)].map((h) => hookBody(body, h[1])).join(' ');
  const said = `${guard} ${helpers}`;
  const events = [
    /\bisWeaponSkill\b/.test(said) ? 'a weapon skill' : null,
    /\bisFinalAttack\b|\bisFinalCombo\b/.test(said) ? 'a finisher' : null,
    /\bisBas(?:e|ic)Attack\b/.test(said) ? 'a base attack' : null,
    /\bisClassSkill\b/.test(said) ? 'a class skill' : null,
  ].filter(Boolean);
  return { step, memory, firstHit: /\bisFirstHit\b/.test(guard), events };
}

// The text INSIDE one hook's braces, or '' when the script does not declare
// it. A clause is the hook's own only if it sits in that span: which hook a
// rider is written in decides WHOSE hits it sees - `onInflictDamageEval` is
// the owner's own, `onProxyDamageEval` its summons' - and a reader that takes
// the whole script as one bag cannot tell the two apart.
function hookBody(body, hook) {
  const m = new RegExp(`function\\s+${hook}\\s*\\([^)]*\\)\\s*\\{`).exec(body);
  if (!m) return '';
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < body.length && depth > 0; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') depth--;
  }
  return body.slice(start, depth === 0 ? i - 1 : i);
}

// The HOOK a position in a script runs from, looking through one helper
// function. A call written in `function gainStack() { ... }` is not raised
// by whatever hook happens to be declared above the helper - Deceiver Trick's
// reset of Chaotic Distorsion sits in such a helper, the helper is called
// from onAreaExited, and "the last `function on...` before the call" named
// onAreaElapsed. Returns the hook's name (or null), and where the helper was
// called from so the caller's own guard can be read with the site's.
function raisedFrom(body, index) {
  const name = hookAt(body, index) || null;
  if (!name || /^on[A-Z]/.test(name)) return { hook: name, callAt: null };
  const CALL = new RegExp('(?<!function\\s)(?<![.\\w])' + name + '\\s*\\(', 'g');
  for (let m; (m = CALL.exec(body));) {
    const outer = hookAt(body, m.index) || null;
    if (outer && outer !== name && /^on[A-Z]/.test(outer)) return { hook: outer, callAt: m.index };
  }
  return { hook: null, callAt: null };
}

// AN ALTERNATIVE THAT NAMES ANOTHER SKILL'S HITS. Nectar-infused Blade's
// whole onInflictDamage sits behind
//
//   var spinSkill = owner.getSkill(Skill.<Spin>);
//   if (dmg.isBaseAttack || (dmg.skill.inf.id == Skill.<Spin> && spinSkill.rank >= 3)) { ... }
//
// - the swing, OR, from the spin skill's third rank (whose own rank text is
// "Triggers the effects of" the passive), every damage instance that skill
// deals. `eventsOf` answers for the first alternative; this answers for the
// second: the skill named, and the rank of THAT skill it asks for. Null when
// the scope has no such alternative, when it is written any other way (the
// rank must be read off a local that IS `owner.getSkill(Skill.<Spin>)`), or
// when the build's weapon rank has not reached it - a weapon's skills all
// stand at the weapon's rank, the one rank a build states.
const SKILL_ARM = /\|\|\s*\(\s*\w+\.(?:skill\.inf\.id|skillId)\s*==\s*Skill\.(\w+)\s*(?:&&\s*(\w+)\.rank\s*>=\s*(\d+)\s*)?\)/;
function namedSkillArm(scope, body, rank) {
  const m = SKILL_ARM.exec(scope);
  if (!m) return null;
  if (m[2]) {
    const local = new RegExp('\\bvar\\s+' + m[2] + '\\s*=\\s*owner\\.getSkill\\s*\\(\\s*Skill\\.' + m[1] + '\\s*\\)\\s*;');
    if (!local.test(body) || rank < Number(m[3])) return null;
  }
  return { skill: m[1], minRank: m[2] ? Number(m[3]) : null };
}

// A CAST THAT SPENDS A BANK, read whole or not at all - see where
// `scriptedRiders` uses it. Returns the bank status, the step every cast
// plays once, the step played once per charge spent, and - where the loop
// spaces its plays by `i * <a local set from vars.X>` - the var that says how
// long each charge adds to the cast.
function bankSpendOf(body) {
  const start = hookBody(body, 'onStart').replace(/\s+/g, '');
  const m = /var(\w+)=getStatusCount\(owner,(?:Skill\.)?(\w+)\);(?:[^;{}]*;)*?consumeStatus\(owner,(?:Skill\.)?\2(?:,\d+)?\);if\(\1==0\)\{playStep\(Steps\.(\w+)\);(?:playStep\(Steps\.\w+\);)*\}else\{for\((\w+?)in0\.\.\.\(\1\+1\)\)\{if\(\4<\1\)\{wait\(([^{}]*?),function\(\)\{playStep\(Steps\.(\w+)\);\}\);\}else\{wait\([^{}]*function\(\)\{playStep\(Steps\.\3\);(?:playStep\(Steps\.\w+\);)*\}\);\}\};?\}$/
    .exec(start);
  if (!m) return null;
  const local = new RegExp('^' + m[4] + '\\*(\\w+)$').exec(m[5])?.[1] ?? null;
  const spacing = local ? new RegExp('var' + local + '=vars\\.(\\w+);').exec(start)?.[1] ?? null : null;
  return { status: m[2], once: m[3], perStack: m[6], spacingVar: spacing };
}

// The text of the innermost `{ ... }` around a position: what runs together
// with the call found there.
function blockAround(body, index) {
  let depth = 0, start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (body[i] === '}') depth++;
    else if (body[i] === '{') { if (depth === 0) { start = i + 1; break; } depth--; }
  }
  depth = 0;
  let end = body.length;
  for (let i = index; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { if (depth === 0) { end = i; break; } depth--; }
  }
  return body.slice(start, end);
}

/**
 * Fill a `texts.desc` template from the numbers beside it.
 *
 * A description is written as `"::name:: generates ::var1:: [ComboPoint]."` and
 * the values are right there in the row's own `vars` - printing the raw
 * template at a reader is asking them to go and look the numbers up themselves.
 * A `%` suffix means "as a percentage", which is how every ratio in the sheet
 * is written. Anything that resolves to nothing is left exactly as it was
 * rather than blanked, so a placeholder this cannot fill stays visible as one.
 */
function fillTemplate(desc, vars, skill, skills = null) {
  const fmt = (v, pct) => (pct ? `${+(v * 100).toFixed(2)}%` : String(+v.toFixed(3)));
  return String(desc).replace(/\s+/g, ' ').trim()
    .replace(/::(ref\d?)_([A-Za-z0-9_]+)(%?)::/g, (whole, refKey, key, pct) => {
      // `texts.refs` points at ANOTHER skill row, and `::ref2_dur1::` means
      // "dur1, from that row". Following it as a mechanical link would be
      // wrong - the same status is referenced by thirteen different Rogue
      // talents that modify it rather than each granting it - but following it
      // for DISPLAY is exactly what the column is for.
      const target = skills?.get(skill?.texts?.refs?.[refKey]);
      if (!target) return whole;
      if (key === 'name') return target.texts?.name ?? whole;
      if (key === 'duration') return typeof target.duration === 'number' ? fmt(target.duration, pct) : whole;
      const v = target.vars?.[key];
      return typeof v === 'number' ? fmt(v, pct) : whole;
    })
    .replace(/::([A-Za-z0-9_]+)(%?)::/g, (whole, key, pct) => {
      if (key === 'name') return skill?.texts?.name ?? whole;
      const v = vars?.[key] ?? skill?.vars?.[key];
      if (typeof v !== 'number') return whole;
      return fmt(v, pct);
    });
}

/**
 * The ComboPoint cap - the most the pool holds, and so the most a finisher
 * can spend - from the rows, not a literal.
 *
 * The unit sheet authors 4, and exactly two skill rows in the whole data raise
 * it, each with a TAttribute_Flat MaxComboPoint affix: `Rogue_ComboMax`, a
 * baseline skill on the unit row itself, and `Rogue_Finisher_Combo_Point`, the
 * permanent State the signature finisher's checkComboPoints() applies while
 * Mastery.Rogue_Finisher_M2 is held ("Combo Ruler" - whose own text names the
 * total, vars.var2 = 6). Masteries are priced as held everywhere else in this
 * file, so both count: 4 + 1 + 1 = 6. The live capture agrees to the integer -
 * finisher hits quantize as A x (1 + 0.3c) with c = 6 on nine of ten hits in
 * the proper-rotation window, c = 5 on the tenth.
 *
 * The State's +1 lives on NO sheet the model builds - it exists only while the
 * status instance does - which is why the pool cap takes this value as an
 * override rather than reading MaxComboPoint off the evaluated sheet.
 *
 * WHEN THE RUNES ARE KNOWN, the mastery gate is honoured instead of assumed:
 * a v5 capture's snap_rune rows say what hasMastery would answer, and Emsey's
 * say Rogue_Finisher_M1 without M2 - so her cap is 5, not the 6 the as-held
 * assumption priced (+8.6% on the finisher in the window that proved it).
 * `runes = null` means unknown, and the assumption stands as before.
 */
function comboPointCap(cdb, runes = null) {
  const unit = cdb.lines('unit').find((u) => (u.stats ?? []).some((s) => s.attribute === 'MaxComboPoint'));
  if (!unit) return 4;
  let cap = 4;
  for (const st of unit.stats) {
    if (st.attribute === 'MaxComboPoint' && typeof st.value === 'number') cap = st.value;
  }
  const flatOf = (id) => (cdb.byId('skill').get(id)?.affixes ?? [])
    .filter((x) => x.ref === 'TAttribute_Flat' && x.target?.attribute === 'MaxComboPoint')
    .reduce((n, x) => n + (typeof x.val === 'number' ? x.val : 0), 0);
  const counted = new Set();
  for (const s of unit.skills ?? []) {
    const id = s.skill ?? s.ref ?? s;
    if (typeof id !== 'string' || counted.has(id)) continue;
    counted.add(id);
    cap += flatOf(id);
    // The mastery-applied State: a unit skill whose script guards addStatus
    // behind hasMastery. Any status it names that carries its own
    // MaxComboPoint affix counts once - if the gate passes.
    const src = String(cdb.byId('skill').get(id)?.script ?? '');
    if (!/hasMastery\s*\(/.test(src) || !/addStatus\s*\(\s*owner\s*,/.test(src)) continue;
    if (runes) {
      const gates = [...src.matchAll(/hasMastery\s*\(\s*Mastery\.(\w+)/g)].map((m) => m[1]);
      if (gates.length && !gates.some((g) => runes.has(g))) continue;
    }
    for (const m of src.matchAll(/Skill\.(\w+)/g)) {
      if (!counted.has(m[1])) { counted.add(m[1]); cap += flatOf(m[1]); }
    }
  }
  return cap;
}

export function buildSkillPlan(cdb, ctx, cat, combat, { classSkillSlots = CLASS_SKILL_SLOTS } = {}) {
  const skills = cdb.byId('skill');
  const T = cdb.enumValues('skill', 'type');
  const stepOnNames = cdb.enumValues('skill@steps', 'on');
  const stepTypeNames = cdb.enumValues('skill@steps', 'type');

  // What KIND of thing a status is, stated outright. `statusType.flags` is
  // `DoT | CrowdControl | HardCC | HoT` and nothing read it, so the model's own
  // structural test - "one of its steps carries props.loop.tick" - had nothing
  // to be checked against. Across the sheet the two agree on 31 of the 33
  // statuses the game types as a DoT or a HoT; the two they disagree on are
  // ticks this model would silently score as a single lump, and they are now
  // named. The CC flags do the other half: a stun has no damage, no affix and
  // no duration of its own, so a skill whose whole payload is one is not an
  // unexplained blank in the coverage report - it is crowd control, which needs
  // a foe that acts before it is worth anything.
  const stackNames = cdb.enumValues('skill@props@status', 'stackingPolicy');
  const statusTargetNames = cdb.enumValues('skill@steps@props@status', 'target');
  // The rows whose script RELEASES the Priest's prayers - found by the call,
  // not by id (see `triggerRule`, the PriestPrayer rule).
  const prayerReleasers = cdb.lines('skill')
    .filter((r) => r.id && /\bdivineInterventionProc\s*\(/.test(liveScript(r.script ?? '')))
    .map((r) => r.id);
  // ...and whether the row's own checkEnabled REFUSES the press while no prayer
  // is ready. Judgment's does: `if (priest.getChargedPrayerCount() == 0) return
  // Reason.RequireActivePrayer` (Priest_Sig_DivineIntervention.checkEnabled@45320
  // ops 12-16), and PriestComponent.getChargedPrayerCount@30854 counts the
  // skills of the hero's prayerSequence that are off cooldown - so with no
  // prayer slotted the count is zero for the whole fight and the button never
  // answers, whatever a rune would hang on the press.
  const refusesEmptyPress = (id) => /function\s+checkEnabled\b[\s\S]*?getChargedPrayerCount\s*\(\s*\)\s*==\s*0\s*\)\s*\{?\s*return\s+Reason\.(?!Ok\b)\w+/
    .test(liveScript(cdb.byId('skill').get(id)?.script ?? ''));
  const statusTypes = cdb.byId('statusType');
  const statusFlagNames = cdb.enumValues('statusType', 'flags');
  // The crowd-control gate reads this one flag by NAME (it is the flag
  // GameObject.isUnderAnyCC@4635 asks for by index, hasStatusFlag@21820(inf,
  // 1)). An enum that lost the case would make every status "not control"
  // without a word, so it fails here instead.
  if (!statusFlagNames.includes('CrowdControl')) {
    throw new Error('statusType.flags has no CrowdControl case - the crowd-control gate cannot be read');
  }
  const statusTypeFlags = (typeId) => {
    const r = statusTypes.get(typeId);
    return r ? new Set(statusFlagNames.filter((_, i) => ((r.flags ?? 0) >> i) & 1)) : new Set();
  };
  // ...through the parent chain, the same walk `damage.mjs` uses to decide which
  // dots a `isStatusType(Bleed)` guard covers. `Hemorage` declares `parent:
  // Bleed` and only Bleed carries the DoT flag, so a status typed Hemorage is a
  // DoT only if the walk is taken.
  const statusTypeFlagsDeep = (typeId) => {
    const out = new Set();
    for (let cur = typeId, hops = 0; cur != null && hops < 8; hops++) {
      for (const f of statusTypeFlags(cur)) out.add(f);
      cur = statusTypes.get(cur)?.parent ?? null;
    }
    return out;
  };
  // Does a guard naming status type `guardType` cover a status typed
  // `types`? Status.isType@15821 walks each type's `parent` chain, so a
  // Bleed guard covers a Hemorage status and a Poison guard does NOT cover a
  // Poison_Dose one (that row authors no parent).
  const typeCovers = (guardType, types) => (types ?? []).some((t) => {
    for (let cur = t, hops = 0; cur != null && hops < 8; hops++) {
      if (cur === guardType) return true;
      cur = statusTypes.get(cur)?.parent ?? null;
    }
    return false;
  });

  /**
   * How many stacks of a status can be held at once.
   *
   * Read from `Status.getMaxStacks@15831`: the base is
   * `props.status.maxStacks`, DEFAULT 1 - not unlimited - and every
   * `props.rankOverride` entry at or below the applying skill's rank may
   * replace it (`updateSkillInf@21787` copies the field through, later wins).
   *
   * `maxStacks <= 0` means UNCAPPED, and that sign is a live trap: seven rows
   * author `-1`, and the `?? 1` this replaces handed a literal -1 straight into
   * the affix scale, i.e. a buff worth MINUS its own value. Only a foe status
   * carries affixes among those seven today, so nothing was visibly wrong -
   * which is exactly the kind of bug that waits for a patch to become one.
   *
   * The game also asks the status's own script: getMaxStacks@15831 calls the
   * `getStatusMaxStacks` hook, whose default (SkillScript.getStatusMaxStacks@6802)
   * returns -1 and leaves the base standing. On the accepted build one row
   * overrode it - Lethal Poison, `b + getTalentRank(Rogue_Talent_ImprovedMixture)` -
   * and the script path below read exactly that shape. Build 25782799 emptied
   * that script (the status is one stack now) and no row in the sheet declares
   * the hook, so the path matches nothing today; it stays because the hook does.
   */
  const MAX_STACK_SCRIPT = /function\s+getStatusMaxStacks\s*\([^)]*\)\s*\{\s*return\s+\w+\s*\+\s*getTalentRank\s*\(\s*(?:Skill\.)?([A-Za-z0-9_]+)/;
  function maxStacksOf(statusId, rank = 1, talents = null) {
    const s = skills.get(statusId);
    if (!s) return 1;
    let cap = s.props?.status?.maxStacks ?? 1;
    for (const ov of s.props?.rankOverride ?? []) {
      if ((ov.minRank ?? 0) <= rank && ov.props?.maxStacks != null) cap = ov.props.maxStacks;
    }
    const m = s.script ? MAX_STACK_SCRIPT.exec(liveScript(s.script)) : null;
    if (m && talents instanceof Map) cap += talents.get(m[1]) ?? 0;
    return cap > 0 ? cap : Infinity;
  }

  /**
   * THE VARS A SCRIPT READS ARE THE RANK'S, NOT THE ROW'S.
   *
   * `props.rankOverride` restates vars as it restates props -
   * updateSkillInf@21787 ops 57-59 call applyVars for every override the rank
   * clears, and ops 277-322 copy the result onto the inf every script then
   * reads as `vars`. `combat.profile()` does that fold once; this is the
   * door to it for every reader in this file that used to index the bare row
   * (`skills.get(id).vars`), which is the rank-1 value at every rank.
   * Sentence is the size of it: the debuff its finisher leaves is
   * `dmg.dmgMult += vars.damage`, 0.05 on the row and 0.1 from rank 2, and it
   * was read at 5% for every build.
   *
   * WHICH rank is the caller's business, because the game has three: a weapon
   * row takes the weapon-skill rank, a status takes its instigator skill's
   * (Status.get_rank@15802 ops 0-5), and a talent takes its points.
   */
  const varsOf = (id, rank = 1, runes = null) => combat.profile(id, rank, runes)?.vars
    ?? skills.get(id)?.vars ?? {};

  // Who applies which status, over the whole sheet. Both paths: a `Status` step
  // naming a ref, and an `addStatus` call site in a script (through the local
  // alias the scripts use). Built once, and only ever asked the one question a
  // guard needs answered - "is there anything in this build that puts X up?".
  //
  // A status nothing applies is not a dependency this can rule on: the applier
  // may well be in game code. So an unknown answer leaves the guard alone, and
  // only a status whose appliers are all NAMED and all ABSENT kills the branch.
  const statusAppliers = (() => {
    const idx = new Map();
    const add = (statusId, by) => {
      if (!statusId || !skills.has(statusId)) return;
      let e = idx.get(statusId);
      if (!e) { e = new Set(); idx.set(statusId, e); }
      e.add(by);
    };
    for (const s of cdb.lines('skill')) {
      for (const st of s.steps ?? []) {
        if (st.props?.status?.ref) add(st.props.status.ref, s.id);
        for (const e of st.effects ?? []) if (e.status) add(e.status, s.id);
      }
      if (!s.script) continue;
      const body = liveScript(s.script);
      const alias = new Map();
      SKILL_ALIAS.lastIndex = 0;
      for (let m; (m = SKILL_ALIAS.exec(body));) alias.set(m[1], m[2]);
      ADD_STATUS.lastIndex = 0;
      for (let m; (m = ADD_STATUS.exec(body));) {
        add(skills.has(m[2]) ? m[2] : alias.get(m[2]), s.id);
      }
    }
    return idx;
  })();

  /**
   * The statuses a guard says must already be up (or must just have landed) for
   * the call it guards to fire, resolved through the script's own aliases.
   *
   * `Steps.X` and `Unit.X` are excluded by construction: only a name that
   * resolves to a real skill row is a status, and `Steps.Area` is not one.
   */
  function statusDepsOf(guard, alias) {
    const out = [];
    STATUS_DEP.lastIndex = 0;
    for (let m; (m = STATUS_DEP.exec(guard));) {
      const id = skills.has(m[1]) ? m[1] : alias?.get(m[1]);
      if (id && skills.has(id) && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * Can this build put that status up? `null` where the model cannot tell -
   * nothing in the sheet applies it, or the caller did not say what it has.
   */
  function canApply(statusId, { talents = null, runes = null, own = null } = {}) {
    const by = statusAppliers.get(statusId);
    if (!by || !by.size) return null;
    if (!talents && !runes) return null;
    for (const owner of by) {
      if (own === owner) return true;
      if (talents?.has(owner) || runes?.has(owner)) return true;
    }
    // Only a set of appliers the loadout can definitively rule OUT is a `no`.
    // Every applier being a talent node is that case: the allocation is the
    // complete list of the ones you have.
    return [...by].every((owner) => isTalentNode(owner)) ? false : null;
  }

  // Every skill id that appears as a node in any class's talent tree, so
  // `canApply` can tell "you did not take that talent" from "the applier is
  // something this reader has not accounted for".
  const talentNodeIds = (() => {
    const s = new Set();
    for (const u of cdb.lines('unit')) {
      for (const tr of u.talentTrees ?? []) for (const x of tr.talents ?? []) if (x.skill) s.add(x.skill);
    }
    return s;
  })();
  const isTalentNode = (id) => talentNodeIds.has(id);

  // How many of a thing you have at a given level: count the unlock levels at
  // or below it. The list IS the slot count.
  function slotsAt(constantId, level) {
    if (!constantId) return Infinity;
    let vals;
    try { vals = cdb.constantFloats(constantId); } catch { return Infinity; }
    return vals.filter((v) => v <= level).length;
  }

  const weaponSlotsAt = (level) => slotsAt('UnlockLevel_WeaponSkillSlots', level);
  const arsenalSlotsAt = (level) => slotsAt('UnlockLevel_Arsenal', level);

  function typeOf(id) {
    const s = skills.get(id);
    return s ? (T[s.type] ?? null) : null;
  }
  // A link of a base-attack chain, its last one included: the five skill types
  // BaseSkill.isBaseAttack@6153 names (0-3 and 4, the final combo).
  const isBaseAttack = (id) => FILLER_TYPES.has(typeOf(id));

  // WHAT THE GAME CALLS A SKILL WHEN IT ASKS OF A HIT. `hit.isSkill` is
  // BaseSkillAccess.get_isSkill@5193: BaseSkill.isWeaponSkill@6161 (skill types 7 and
  // 8), BaseSkill.isClassSkill@6158 (9) or BaseSkill.isSignature@6159 -> $HSkill.isSignature@21816
  // (17-20, and the two rows it names by id) - asked of the row whose STEP
  // made the hit. That row is never the cast that put a status up: every step
  // is built by, and handed, the row that owns it (BaseSkill.initSteps@6138
  // op 30), its hit takes that row's context (BaseSkill.newHit@6237 ops 1, 30-31;
  // $ScriptHitData.__constructor__@6318 ops 4-6), and a status row carries no
  // type at all. So a heal a STATUS lands - Depth Shield's orbs - is not a
  // skill's hit, whichever skill put the status there.
  const HIT_SKILL_TYPES = new Set(['WeaponSkill', 'WeaponSubSkill', 'ClassSkill', 'SignatureSkill',
    'RoguePoison', 'PriestPrayer', 'MageConduit']);
  const HIT_SKILL_IDS = new Set(['Mage_SparkMaster', 'Rogue_MasterPoisoner']);

  /**
   * Does playing this row land a hit OF A SKILL on the hero who played it?
   * `stepId` null asks about the cast - the steps it plays itself; a step id
   * asks about that one step, whoever plays it. What makes a step a hit on its
   * caster is read in `profile().casterHits`; a status the script hands the
   * owner (`addStatus(owner, ...)`) or a Status step is not a hit, and neither
   * raises onInflictHit.
   */
  function landsOnCaster(rowId, stepId, rank, runes) {
    if (!HIT_SKILL_TYPES.has(typeOf(rowId)) && !HIT_SKILL_IDS.has(rowId)) return null;
    const hits = (combat.profile(rowId, rank, runes)?.casterHits ?? [])
      .filter((h) => (stepId == null ? h.by === 'cast' : h.stepId === stepId));
    if (!hits.length) return null;
    return { step: hits[0].stepId, lasts: Math.max(...hits.map((h) => h.lasts)) };
  }

  // A `WeaponSubSkill` is a follow-up, not a choice: `Book_WaterOrbs_Skill2_Recast`
  // exists only because Skill2 does.
  //
  // The wiring used to be guessed from the ID PREFIX, and the data states it
  // outright: `skill.props.subskills[].skill` names the parent, on 7 rows,
  // covering all five WeaponSubSkills. The prefix rule never resolved one
  // WRONGLY - it either agreed or found nothing - but "found nothing" was the
  // answer for the two that matter, because their parent is the weapon's
  // PASSIVE rather than a numbered skill:
  //
  //     GS_Nova_Passive      -> GS_Nova_Ultimate
  //     Staff_Censer_Passive -> Staff_Censer_Ultimate
  //
  // Neither id starts with the other, so both were reported as having "no
  // discoverable trigger" while the column that states their trigger sat
  // unread. `hlboot.dat` carries `resolveSubSkills`, `isSubSkillOf` and
  // `get_subskills`, so this is the link the game itself follows.
  const subParent = new Map();
  for (const s of cdb.lines('skill')) {
    for (const x of s.props?.subskills ?? []) {
      if (x.skill) subParent.set(x.skill, s.id);
    }
  }

  /** The parent a sub-skill declares, falling back to the id-prefix reading. */
  function parentOf(id, all) {
    const declared = subParent.get(id);
    if (declared) return declared;
    return all.find((sel) => id !== sel && id.startsWith(sel)) ?? null;
  }

  function subSkillsFor(selected, all) {
    const out = [];
    for (const id of all) {
      if (typeOf(id) !== 'WeaponSubSkill') continue;
      const parent = parentOf(id, all);
      // A sub-skill is yours when its parent is - slotted, or always-on. A
      // weapon's passive is always on, which is exactly how the two ultimates
      // reach the player.
      if (parent && (selected.includes(parent) || typeOf(parent) === 'WeaponPassive')) out.push(id);
    }
    return out;
  }

  function orphanSubSkills(all, selected) {
    return all.filter((id) => {
      if (typeOf(id) !== 'WeaponSubSkill') return false;
      const parent = parentOf(id, all);
      return !(parent && (selected.includes(parent) || typeOf(parent) === 'WeaponPassive'));
    });
  }

  // --- the base-attack chain ------------------------------------------------
  //
  // THE CHAIN IS THE WEAPON'S OWN SWING ROWS, THEN ITS FINISHER - and nothing
  // else. On build 25782799 the next base attack is chosen by
  // ent.Hero.getNextAttackSkill@7811: ops 64-77 `lastCombo =
  // attackSkills.indexOf(lastAttack); if (attackComboSkill != null &&
  // lastCombo >= attackSkills.length - 1) return attackComboSkill`, ops 78-89
  // `return attackSkills[lastCombo + 1]`. `attackSkills` is every skill the
  // hero owns of type Attack..Attack4 whose originItem is the active weapon,
  // and `attackComboSkill` the one of type AttackCombo
  // (ent.Hero.updateSkillCache@7812 ops 49-62). The length is how many swing
  // rows the weapon grants; no number anywhere is consulted.
  //
  // `moveSet.comboLength` USED to be consulted, and this function used to
  // fill the chain up to it. Two weapons list fewer links than that column
  // says:
  //
  //   Scepter_Flamie  lists Scepter_Base_Attack + its own combo   -> 2, says 4
  //   DM_Multispin    lists DM_Base_Attack1..3 + its own combo    -> 4, says 5
  //
  // On the accepted build Hero.attack reset the counter at `comboLength - 1`,
  // so those two swung a padded chain - and the pre-patch capture says HOW:
  // 190 Flame of Argol wielders swung `A A A` then the finisher (1,886 + 826
  // chains, A being Scepter_Base_Attack every time) and 54 Twin Pillars of
  // Justice wielders `A1 A2 A3 A3` then theirs (94 + 84; DM_Base_Attack4
  // never appears). The old client REPEATED THE LAST DECLARED SWING. The fill
  // this function carried - the type's Attack2/Attack3 rows, an orphan
  // Attack4 - got the length right and the rows wrong even then.
  //
  // Now the column has no reader at all: its one accessor
  // (_Data.$MoveSet_Impl_.get_comboLength@17283) has no caller and no op
  // names the string, and ent.Hero.attack@7840 no longer touches the moveSet.
  // So Flame of Argol is one swing and its finisher, and Twin Pillars three
  // and theirs. That is a READ, not a measurement - the event capture ends
  // before this build - and it is the flattering direction (the finisher, and
  // every prayer charge and isFinalCombo roll off it, lands twice as often on
  // the scepter), so the audit carries it as unverified with the one count
  // that settles it.
  const chainRowsBySlot = new Map(CHAIN_SLOTS.map((s) => [s, []]));
  for (const s of cdb.lines('skill')) {
    const t = T[s.type ?? -1];
    if (chainRowsBySlot.has(t)) chainRowsBySlot.get(t).push(s.id);
  }
  const moveSets = cdb.byId('moveSet');

  const chainCache = new Map();
  /**
   * The ordered base-attack chain a weapon actually swings: its own swing
   * rows in slot order, then its combo. `want` is the moveSet's authored
   * `comboLength`, kept only so a caller can show where the dead column and
   * the chain disagree; `filled` is always empty and stays for the callers
   * that still ask.
   */
  function baseChain(item) {
    if (!item) return { links: [], filled: [], want: 0, moveSet: null };
    let hit = chainCache.get(item.id);
    if (hit) return hit;

    // A slot is NOT one row. Every staff declares `Staff_Base_Attack` and
    // `Staff_Base_Attack2` and both are typed `Attack` - there is no Attack2
    // row for staffs at all - so keying the chain by type slot silently merged
    // two distinct swings into one and made every staff a link short. The
    // item's own declaration order is the chain; the slot type is only how a
    // MISSING link is found.
    const own = item.skills ?? [];
    const swings = own.filter((id) => chainRowsBySlot.has(typeOf(id)));
    const combo = own.filter((id) => COMBO_TYPES.has(typeOf(id)));
    const want = moveSets.get(item.moveSet)?.comboLength ?? 0;

    // Slot order, stable within a slot so two `Attack`-typed staff swings keep
    // the order the item lists them in, and the combo always finishes. The
    // game's own order is the hero's skill list (attackSkills is pushed in
    // that order), which this cannot see; slot order is what the pre-patch
    // capture shows on the weapons whose rows are listed out of order.
    const slotIx = (id) => CHAIN_SLOTS.indexOf(typeOf(id));
    const links = swings
      .map((id, i) => ({ id, i, s: slotIx(id) }))
      .sort((a, b) => (a.s - b.s) || (a.i - b.i))
      .map((x) => x.id)
      .concat(combo);
    hit = { links, filled: [], want, moveSet: item.moveSet ?? null };
    chainCache.set(item.id, hit);
    return hit;
  }

  /**
   * What the hero HOLDS, for the one step condition that asks - see `profile`
   * in damage.mjs. `cond.weapons.isRanged` is compared with the MAIN hand's
   * moveSet (SkillStep.checkStaticConds@5991 ops 58-89; the active weapon is
   * Slot_Weapon1 by get_activeWeapon@7720 -> get_weapon1@7718), and
   * `moveSet.props.range` is authored true on Scepter, Staff, Halos, Thrown,
   * Bow and SpellBook. Every other moveSet leaves it unset, which the game
   * reads as false - exactly as it reads an empty hand.
   */
  function wieldOf(loadout) {
    const id = loadout?.gear?.Slot_Weapon1?.item ?? null;
    const item = id ? cat.itemById.get(id) : null;
    return { ranged: moveSets.get(item?.moveSet)?.props?.range === true };
  }

  // --- the pools a build has to choose from --------------------------------
  /**
   * Every talent NODE this build holds. Two routes reach the same place and a
   * caller may have used either: points spent land in `loadout.talents`, and a
   * DemonSigil hands a tier-4 node over outright from a socket. `optimize`
   * writes the sigil's node back into `loadout.talents` itself; `bench sheet`
   * and the UI do not, so both routes are read here and the set dedupes them.
   */
  function heldTalents(loadout) {
    const out = new Set(Object.keys(loadout.talents ?? {}));
    for (const [key, augId] of Object.entries(loadout.augments ?? {})) {
      if (!augId || !key.endsWith('/AugmentDemonSigil')) continue;
      for (const id of cat.itemById.get(augId)?.skills ?? []) {
        if (typeOf(id) === 'Talent') out.add(id);
      }
    }
    return out;
  }

  /**
   * The mechanic skills this build's TALENTS hand it, by mechanic type.
   *
   * A talent carries what it grants one row over, in `props.subskills` - and
   * the Mage's two tier-4 conduit nodes each grant a `MageConduit` row
   * (Mage_Talent_ConduitSparkExplosion -> ..._Conduit, "Conduit: Spark
   * Explosion"). In game that row is one more conduit you MAY SLOT against the
   * same three `Mage_Conduit_Levels` slots. It is not a fourth conduit.
   *
   * Reading the pool from `unit.skills` alone left those rows out of every
   * selection while `resolve`'s talent pass granted them anyway, so the node
   * was worth a free conduit and the player could not choose it - the one
   * shape a build tool must never have: an option that is not offered, scoring
   * as though it had been taken.
   *
   * Sorted, because two granted nodes must not order the slots by whichever
   * order the caller happened to write the talent map in - `rotationFor`'s
   * cache key sorts the talents, so the pool must be stable under the same
   * build too.
   */
  function grantedMechanicSkills(loadout) {
    const out = new Map();
    for (const node of heldTalents(loadout)) {
      for (const x of skills.get(node)?.props?.subskills ?? []) {
        if (!x.skill) continue;
        const t = typeOf(x.skill);
        if (!t || !MECHANIC_TYPES[t]) continue;
        const list = out.get(t) ?? [];
        if (!list.includes(x.skill)) list.push(x.skill);
        out.set(t, list);
      }
    }
    for (const list of out.values()) list.sort();
    return out;
  }

  /**
   * THE CLASS PASSIVE THAT OPENS A MECHANIC SLOT. "You can choose a third
   * [Conduit]." is a row with no step, no affix, no status and no script:
   * what it gives is the slot. The slot is read - `pools` counts the levels
   * of the pool's slot constant at or under the character's (`slotsAt`) -
   * and it is in the build ("conduits 3/3"). Listed under "nothing declared
   * ... not scored in this build", the row read as a hole beside the very
   * thing it gives.
   *
   * Found by the DATA and never by an id: a ClassPassive of the class's own
   * unit list, bare as above, that the unit enters at a level at which the
   * pool's constant opens a slot, and whose description names the pool by
   * the game's keyword - the mechanic type's name less the class's
   * (MageConduit -> [Conduit]). A passive that says the same and sits at
   * another level, or carries a script, is not answered by the constant and
   * stays in the list.
   */
  function slotOpeners(loadout) {
    const unit = cdb.byId('unit').get(loadout.class);
    const out = [];
    for (const [type, def] of Object.entries(MECHANIC_TYPES)) {
      if (!def.slotConstant || !loadout.class || !type.startsWith(loadout.class)) continue;
      let opens;
      try { opens = cdb.constantFloats(def.slotConstant); } catch { continue; }
      const keyword = type.slice(loadout.class.length);
      if (!keyword) continue;
      for (const e of unit?.skills ?? []) {
        const id = e.skill ?? e.ref;
        const row = skills.get(id);
        if (!row || typeOf(id) !== 'ClassPassive' || e.level == null || e.level > loadout.level) continue;
        if ((row.steps ?? []).length || (row.affixes ?? []).length || row.script || row.props?.status) continue;
        if (!opens.includes(e.level) || !(row.texts?.desc ?? '').includes(`[${keyword}]`)) continue;
        out.push({ id, mechanic: type, constant: def.slotConstant, level: e.level, slot: opens.filter((v) => v <= e.level).length });
      }
    }
    return out;
  }

  /**
   * Every selection this loadout has to make, each with its options and how
   * many of them fit. Weapon pools depend on what is equipped, so this is
   * recomputed whenever the gear changes.
   */
  function pools(loadout) {
    const out = [];
    const level = loadout.level;

    // The two weapon slots are NOT symmetric, and this is confirmed in game:
    //
    //   Slot_Weapon1        full stats, every skill, and the combo attack
    //   Slot_OffhandWeapon  full stats and every skill (no pool at all)
    //   Slot_Weapon2        stats at 0.4, and only TWO skills, chosen - and the
    //                       weapon passive counts against those two
    //
    // So the main hand's pool covers only its `WeaponSkill`s, against
    // `UnlockLevel_WeaponSkillSlots` (2 from level 2), and its `WeaponPassive`
    // is always on. A typical weapon has two skills and a passive, which is why
    // the main hand feels like it grants everything - it does.
    {
      const g = loadout.gear.Slot_Weapon1;
      const item = g?.item ? cat.itemById.get(g.item) : null;
      const options = (item?.skills ?? []).filter((id) => typeOf(id) === 'WeaponSkill');
      const slots = weaponSlotsAt(level);
      if (options.length && slots >= 1) {
        out.push({
          key: 'Slot_Weapon1', kind: 'weapon', slot: 'Slot_Weapon1', host: item.id,
          label: 'main-hand skills', slots: Math.min(slots, options.length), options,
          // The main hand's PASSIVE is not part of this choice - it is always
          // on - so it is not in `options` and the line reads "2/2" beside a
          // weapon that plainly has three skills. It is granted; say so, or the
          // output looks like it lost one.
          alsoGranted: (item?.skills ?? []).filter((id) => typeOf(id) === 'WeaponPassive'),
        });
      }
    }
    {
      const g = loadout.gear.Slot_Weapon2;
      const item = g?.item ? cat.itemById.get(g.item) : null;
      // The passive is in the pool here: "only 2 of the 3 are available, even
      // passive skills, and they are picked by the player".
      const options = (item?.skills ?? []).filter((id) => {
        const t = typeOf(id);
        return t === 'WeaponSkill' || t === 'WeaponPassive';
      });
      const slots = arsenalSlotsAt(level);
      if (options.length && slots >= 1) {
        out.push({
          key: 'Slot_Weapon2', kind: 'weapon', slot: 'Slot_Weapon2', host: item.id,
          label: 'arsenal skills', slots: Math.min(slots, options.length), options,
        });
      }
    }

    // The class mechanic, if this class has one. Same unlock-level gate as
    // everywhere else: a level-12 Priest has not learned a level-30 prayer.
    const unit = cdb.byId('unit').get(loadout.class);
    const classSkills = (unit?.skills ?? [])
      .filter((s) => (s.level ?? 0) <= level)
      .map((s) => s.skill ?? s.ref)
      .filter(Boolean);

    // The class-skill bar: six exist, four fit, and which four is a build
    // decision exactly like which two weapon skills to slot. The signature
    // skill and the class passives are NOT in this pool - they are always on.
    {
      const options = classSkills.filter((id) => typeOf(id) === 'ClassSkill');
      const slots = Math.min(classSkillSlots, options.length);
      if (options.length && slots >= 1) {
        out.push({
          key: 'class/ClassSkill', kind: 'class', slot: null, host: loadout.class,
          label: 'class skills', slots, options,
        });
      }
    }
    const granted = grantedMechanicSkills(loadout);
    for (const [type, def] of Object.entries(MECHANIC_TYPES)) {
      const own = classSkills.filter((id) => typeOf(id) === type);
      // The pool has to EXIST for this class before a grant may join it. A
      // sigil is class-gated in game, and minting a `PriestPrayer` pool on a
      // Mage because a foreign sigil sat in a socket would be a worse bug than
      // the one below - so the class's own rows decide whether the mechanic is
      // hers, and the grant only ever widens a pool she already has.
      if (!own.length) continue;
      // ...and a talent-granted row of that type is one more OPTION, not a
      // free extra. See `grantedMechanicSkills`.
      const options = own.concat((granted.get(type) ?? []).filter((id) => !own.includes(id)));
      // Mechanic slots may REPEAT an option: Mage_Conduit_Projectile's own
      // script fans by getSkillInstanceCount()/getSkillInstanceIndex() with a
      // 0.1s stagger, and the live stream shows every trigger as an
      // instance PAIR - Emsay runs Projectile x2 + Power in her three slots.
      // Clamping to options.length priced one row per event where the game
      // fires two.
      const slots = slotsAt(def.slotConstant, level);
      if (slots < 1) continue;
      out.push({
        key: `class/${type}`, kind: 'mechanic', slot: null, host: loadout.class,
        label: def.label, slots, options, mechanic: type,
        repeats: def.repeats === true,
      });
    }
    return out;
  }

  // The default selection: the first `slots` options, so a build with no
  // explicit choice is still well-defined and deterministic.
  //
  // NOTE: a MECHANIC pool with more slots than options is left SHORT here,
  // while `resolve` cycles it (Projectile x2 + Power). The two disagree, and
  // this is the reader the CLI and the UI go through - so a pruned Mage
  // carries two conduits into a three-slot pool and the third slot goes to
  // nobody. Left alone deliberately: it is a separate bug from the one this
  // change fixes, it moves every Mage's baseline, and the one assertion that
  // covers it reads per-hit interval where it means trigger cadence.
  // How a pool fills when nobody has chosen. A pool that allows repeats fills
  // every slot, cycling its options - the third conduit slot going back to the
  // first option is exactly the live fill (Projectile x2 + Power). Everything
  // else takes each option at most once, so a Priest holding two prayers at
  // three slots carries two, not one of them twice.
  function fillPool(p) {
    if (p.repeats && p.options.length) {
      return Array.from({ length: p.slots }, (_, i) => p.options[i % p.options.length]);
    }
    return p.options.slice(0, p.slots);
  }

  function defaultSelection(loadout) {
    const sel = {};
    for (const p of pools(loadout)) sel[p.key] = fillPool(p);
    return sel;
  }

  // Prune a selection down to what is currently legal - the search swaps
  // weapons constantly and a stale skill id must not survive the swap.
  function pruneSelection(loadout) {
    const live = new Map(pools(loadout).map((p) => [p.key, p]));
    loadout.skills ??= {};
    for (const key of Object.keys(loadout.skills)) {
      const p = live.get(key);
      if (!p) { delete loadout.skills[key]; continue; }
      const kept = loadout.skills[key].filter((id) => p.options.includes(id)).slice(0, p.slots);
      loadout.skills[key] = kept;
    }
    // Fill anything unset so a partial build still evaluates.
    for (const [key, p] of live) {
      if (!loadout.skills[key]?.length) loadout.skills[key] = fillPool(p);
    }
    return loadout;
  }

  // --- the rotation --------------------------------------------------------
  /**
   * Turn a loadout into the buckets the throughput model needs.
   *
   * Only the MAIN-HAND weapon's base-attack chain is used: the arsenal is a
   * second weapon you swap to, not a second set of swings you get for free.
   * The arsenal still contributes its slotted skills, which is exactly what
   * `UnlockLevel_Arsenal` describes.
   */
  function resolve(loadout, rank) {
    const runes = new Set(Object.values(loadout.runes ?? {}).flat().filter(Boolean));
    // What a script guard can be asked about: the weapon-skill rank, the runes
    // slotted and the talents allocated. All three are decisions this build has
    // already made, so a guard that names one is answerable rather than opaque.
    const talents = new Set(Object.keys(loadout.talents ?? {}));
    // ...and how many POINTS are in each: a node answers its own
    // props.rankOverride at them, and a status cap can read them through the
    // getStatusMaxStacks hook (no row does on build 25782799 - see
    // `maxStacksOf`).
    const talentRanks = new Map(Object.entries(loadout.talents ?? {}));
    // `owned` is every row the build holds, filled as the passes below push
    // them (it is `seen`, live): a guard asking about a status one of those
    // rows applies is asking about this build, not about live state.
    const guardOpts = { rank, runes, talents, owned: null };
    // What is in the main hand, for the steps that ask (the Rogue's Finisher).
    const wield = wieldOf(loadout);
    // ...and whether the off-hand carries a weapon skill, for the one script
    // that asks (`getOffhandWeaponSkill() != null`, see `scriptedRiders`).
    // Every skill of an off-hand weapon is held - it has no pool - so the
    // item's own list is the answer.
    const offhandSkillId = (cat.itemById.get(loadout.gear.Slot_OffhandWeapon?.item)?.skills ?? [])
      .find((id) => typeOf(id) === 'WeaponSkill') ?? null;
    const offhandSkill = offhandSkillId != null;
    const usableRule = (r) => !!r && r.kind !== 'never' && r.kind !== 'conditional';

    // Riders that ride an EVENT rather than the host's own cast, collected as
    // profiles are resolved and pushed into `triggered` once it is known which
    // skills the fight can actually fire.
    const pendingRiders = [];
    // When a talent-applied status that rides swings is actually worn - see
    // the talent pass.
    const statusWindows = new Map();
    const riderCache = new Map();
    // Steps a bank spend prices (`<skill>#<step>`), so the refusal the rider
    // reader parked for them is not printed beside the line that carries it.
    const pendingBankSteps = new Set();
    // A status a WEAPON PASSIVE THIS BUILD OWNS keeps on its owner for good:
    // the passive's own Status step, played on Refresh with duration -1.
    // Flame of Argol's passive is the shape ("You are permanently followed by
    // a Flamie"). OWNED is what the passes below grant, asked of the same
    // sources so the answer does not depend on which row is resolved first:
    // the main hand's and the offhand's passives are always on, and the
    // arsenal's is owned when the player gave it one of the arsenal's skill
    // slots (it is an option of that pool - see `pools`). Returns the
    // passive's id, or null.
    let wornCache = null;
    const wornAlways = (statusId) => {
      if (!wornCache) {
        wornCache = new Map();
        const owned = [];
        for (const slot of ['Slot_Weapon1', 'Slot_OffhandWeapon']) {
          const held = loadout.gear?.[slot]?.item ? cat.itemById.get(loadout.gear[slot].item) : null;
          owned.push(...(held?.skills ?? []));
        }
        for (const p of pools(loadout)) {
          if (p.kind === 'weapon') owned.push(...(sel[p.key] ?? fillPool(p)).slice(0, p.slots));
        }
        for (const pid of owned) {
          if (typeOf(pid) !== 'WeaponPassive') continue;
          for (const st of skills.get(pid)?.steps ?? []) {
            if ((stepTypeNames[st.type ?? -1] ?? '') !== 'Status' || (stepOnNames[st.on ?? -1] ?? '') !== 'Refresh') continue;
            if (Number(st.duration) !== -1 || !st.props?.status?.ref) continue;
            if (st.cond?.minRank != null && rank < st.cond.minRank) continue;
            if (!wornCache.has(st.props.status.ref)) wornCache.set(st.props.status.ref, pid);
          }
        }
      }
      return wornCache.get(statusId) ?? null;
    };
    /**
     * The profile a bucket should use: the same one `combat.profile` returns,
     * with its per-cast script riders folded back in, and its event riders
     * parked for the pass below. See `scriptedRiders` and `foldRider`.
     */
    function profileOf(id, atRank = rank) {
      const key = id + '@' + atRank;
      if (riderCache.has(key)) return riderCache.get(key);
      let base = combat.profile(id, atRank, runes, wield);
      // A talent's step that nothing plays is not a payload: taken out here,
      // before anything asks whether the node "carries" one (see
      // `stepIsDead`).
      if (base?.scripted?.length && typeOf(id) === 'Talent'
        && base.scripted.some((st) => stepIsDead(id, st.stepId))) {
        base = { ...base, scripted: base.scripted.filter((st) => !stepIsDead(id, st.stepId)) };
      }
      let prof = base;
      if (base?.scripted?.length) {
        const { riders, refused } = scriptedRiders(id, base, { rank: atRank, runes, talents, wornAlways, offhandSkill });
        let folded = null;
        for (const r of riders) {
          // ...nor is a per-cast rider behind a stated-health test folded: the
          // fold would price it at every health. It stays a rider of its own,
          // on its host's cast, where the fight can drop it. Nor one that
          // rides ANOTHER skill's cast (`namedSkillArm`): this row's own cast
          // is not the event.
          if (r.rule.kind !== 'per-parent-cast' || r.rule.targetHealth || r.rule.parent !== id) {
            pendingRiders.push({ host: id, prof: base, ...r });
            continue;
          }
          // A crit gate needs the sheet, which plan time does not have. None of
          // the per-cast riders in this sheet carries one; if one appears, it is
          // named rather than folded at the wrong rate.
          if (r.rule.critGated) {
            refused.push({
              step: r.step.stepId,
              why: `${base.name}'s ${r.step.stepId} step is played by the cast itself but only on a `
                + 'critical strike, and a per-cast rider is folded into the cast before the sheet exists',
            });
            continue;
          }
          const stepEffects = (r.rule.notAimTarget || r.rule.atPosition)
            ? r.step.effects.map((e) => ({
              ...e,
              ...(r.rule.notAimTarget ? { notAimTarget: true } : {}),
              ...(r.rule.atPosition ? { atPosition: true } : {}),
            }))
            : r.step.effects;
          folded = (folded ?? base.effects)
            .concat(foldRider(stepEffects, (r.rule.chance ?? 1) * (r.rule.perCast ?? 1)));
          // A rider folded into its cast has no line to carry a sentence, so
          // one that is priced as a FLOOR says so in the coverage list.
          if (r.rule.floor) refused.push({ step: r.step.stepId, kind: 'assumption', why: r.rule.floor });
        }
        if (folded) prof = { ...base, effects: folded };
        for (const f of refused) pendingRiders.push({ host: id, prof: base, refusal: f });
      }
      riderCache.set(key, prof);
      return prof;
    }
    const sel = loadout.skills ?? defaultSelection(loadout);
    const filler = [];
    const active = [];
    const triggered = [];
    const passive = [];
    const dots = [];
    const unmodelled = [];
    const seen = new Set();
    guardOpts.owned = seen;
    const dotSeen = new Set();
    // RIDERS THE OWNER CARRIES FOR EVERY HIT. A dmgMult/crit clause written in
    // `onInflictDamageEval` is not its row's own: evalDamage@6124 ops 71-123
    // run that hook on every skill and status of whoever lands the hit, so it
    // rides everything the owner deals for as long as the row is owned.
    // `profile().runeDamage` reads the clause and marks it `ownerWide`; this
    // is the list the fight is handed, because a rider that stays on a profile
    // nobody casts reaches no cast - Domination was reported as scored for
    // exactly that long while it priced zero.
    //
    // Not from a TALENT row (talentModifiers already routes those, and a
    // second route would pay one twice) and not from a STATUS row (that is a
    // buff, live only while it is worn, and the buff path owns it).
    const ownerRiders = [];
    // ...and the ARMOUR a row's script takes off one named skill's hits
    // (`profile().armorIgnores`): Hidden Power's passive writes
    // `magicArmorIgnore = 1` for the Ultimate's hits only, so the rider lives
    // on a row nobody casts and has to be carried to the skill it names.
    // Under the same two exclusions, for the same reasons.
    const armorIgnores = [];
    // A RIDER THE NEXT SKILL OF A KIND TAKES, ON THE ROW'S OWN COOLDOWN.
    // Queen's Decree (the Wingsabers' passive), to the letter of its script:
    //
    //   onUseSkill(ctx)       if (ctx.isSkill && canDoMagicDamage(ctx.skill))
    //                           if (!isInCooldown()) {
    //                             ctx.magicDmgMult += vars.damage;
    //                             consumeCooldown(); }
    //   onInflictDamage(dmg)  if (rank >= 3)
    //                           if (dmg.critical && dmg.skill.kind != skill.kind
    //                               && isInCooldown())
    //                             playStep(Steps.Damage, dmg.target);
    //
    // Read on build 25782799: DS_Bladeleaf_Passive.onUseSkill@44612 ops 0-12 are BaseSkill.isWeaponSkill@6161
    // || BaseSkill.isClassSkill@6158 || BaseSkill.isSignature@6159 of the skill being used, op 14
    // canDoMagicDamage@6930 - the used ROW holds, among its own steps'
    // effects, one whose affinity's damage type is Magic
    // ($HSkill.getEffectIndex@21830 walks inf.steps[].effects[]; the test,
    // fn@44341, asks the affinity and not the effect's kind, so a heal counts)
    // - ops 16-17 SkillScript.isInCooldown@6846, ops 18-28 the add to ctx.magicDmgMult,
    // op 29 consumeCooldown@6848. So a status the cast APPLIES does not
    // qualify its cast (Swarmstrike Accord and Summon: Vile Imps hold no
    // effect of their own), and what is added to is the cast's damage-ratio
    // bracket, not its dmgMult (damage.mjs castOutput, `xr.bracket`).
    //
    // MEASURED 2026-10-13 (Mage, 69 presses): the ready marker
    // (DS_Bladeleaf_Passive_Status, enforced from onRegUpdate while the
    // cooldown is not running) went off inside half a second of every press
    // of Demonic Discharge, Spark Beam and Static Nova that found it up - 13
    // of 13 - and stayed up through 4 presses of Swarmstrike Accord, 3 of
    // Summon: Vile Imps, 7 of Spark Shield, 2 of Mystic Empowerment and 6 of
    // Blink. It came back 19.0-19.5 s later (13.0 and 13.5 s under Mystic
    // Empowerment's +30 Cooldown Reduction): the rank-2 cooldown of 20 s at
    // the wearer's 4% Cooldown Reduction, on the half-second the marker is
    // polled at. While it ran, 40 of 40 critical hits of her own were
    // followed by the step inside 80 ms - base attacks, the finisher, weapon
    // and class skills, and the hits of a status she wears - and 0 of 110
    // while it did not; the log's 41 rows of the step are those 40 and the
    // hit that spent it. A summon's critical hit plays none (its hits reach
    // the owner's scripts as onProxyDamage, not onInflictDamage).
    //
    // Only this spelling is taken. `spenders` (the rows that can spend it) is
    // filled in once the build's actives are known.
    // Presses that deal nothing and land on their own caster, kept aside
    // until the build's status windows are known (see `push`).
    const selfLanders = [];
    const useRiders = [];
    const useRiderOf = (id, prof, source) => {
      const body = liveScript(skills.get(id)?.script ?? '');
      const use = hookBody(body, 'onUseSkill');
      if (!use || !(prof.cooldown > 0)) return null;
      const m = /^\s*if\s*\(\s*(\w+)\.isSkill\s*&&\s*canDo(Magic|Physical)Damage\s*\(\s*\1\.skill\s*\)\s*\)\s*\{\s*if\s*\(\s*!\s*isInCooldown\s*\(\s*\)\s*\)\s*\{\s*\1\.(magicDmgMult|physicalDmgMult)\s*\+=\s*vars\.(\w+)\s*;\s*consumeCooldown\s*\(\s*\)\s*;\s*\}\s*\}\s*$/.exec(use);
      if (!m) return null;
      const amount = varsOf(id, rank, runes)?.[m[4]];
      if (!(typeof amount === 'number' && amount > 0)) return null;
      // The step it plays on a critical hit while the cooldown runs, when the
      // build's rank reaches the clause.
      let critStep = null;
      const inflict = hookBody(body, 'onInflictDamage');
      const pm = /if\s*\(\s*(\w+)\.critical\s*&&\s*\1\.skill\.kind\s*!=\s*skill\.kind\s*&&\s*isInCooldown\s*\(\s*\)\s*\)\s*\{?\s*playStep\s*\(\s*Steps\.(\w+)\s*,\s*\1\.target\s*\)/.exec(inflict);
      if (pm && guardOf(enclosingBlock(inflict.slice(0, pm.index)), guardOpts).fires) {
        const effects = ((prof.scripted ?? []).find((x) => x.stepId === pm[2])?.effects ?? [])
          .filter((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length));
        if (effects.length) {
          critStep = {
            stepId: pm[2],
            prof: {
              ...prof, id: `${id}#${pm[2]}`, effects,
              occupancy: 0, cooldown: 0, charges: 1, costs: [], isFiller: false, isCombo: false, scripted: [],
            },
          };
        }
      }
      return {
        from: id, name: prof.name, source: source ?? null,
        every: prof.cooldown, root: m[2], field: m[3], bracketRoot: m[3] === 'magicDmgMult' ? 'Magic' : 'Physical',
        amount, critStep, spenders: [],
      };
    };
    const noteOwnerRiders = (id, prof, source) => {
      if (typeOf(id) === 'Talent' || prof.nature === 'Status') return;
      for (const rd of prof.runeDamage ?? []) {
        if (rd.ownerWide) ownerRiders.push({ ...rd, from: id, name: prof.name, source: source ?? null });
      }
      for (const ai of prof.armorIgnores ?? []) armorIgnores.push({ ...ai, from: id, name: prof.name });
    };
    // Hosts whose payload the model DID reach, but through a bucket that runs
    // after the coverage report has already been written into. Listing a skill
    // as unscored while the fight is visibly firing one of its steps is the
    // output contradicting itself.
    const accountedLate = new Set();
    // A script's own name for a status: `var mark = Skill.X;` then `mark`.
    const aliasOf = (body, name) => {
      SKILL_ALIAS.lastIndex = 0;
      for (let am; (am = SKILL_ALIAS.exec(body));) if (am[1] === name) return am[2];
      return name;
    };

    // Every damage- or heal-over-time this build can put up, with what applies
    // it and how often that lands. `checkProba(vars.chance)` is the one gate the
    // data states outright, so an applier that rolls for it carries its chance
    // and the simulation either folds it in at its expected rate or rolls it.
    // Several skills can apply the same status - Gash is put up by the Twin
    // Fangs' passive on a roll, by Shiv's own hit, and again by Shiv's rank-3
    // crit (and Lethal Poison, on build 25782799, by the root talent's dose
    // gate and by Toxic Miasmas' on-kill area). Keeping whichever was seen first meant a
    // status could be attributed to the one applier the model cannot price and
    // then reported as unmodelled, while a perfectly priceable applier for it
    // sat in the rotation. So every applier is collected and the best one is
    // chosen at the end, once it is known which skills the fight can fire.
    // A DEBUFF THAT LIVES AS LONG AS A DOT OF THE SAME ROW. Chaos Scorch's
    // script lays two statuses on what a weapon skill hits - the burn (a
    // pool that ticks) and, from rank 3, a second row carrying -15% Armor and
    // MagicArmor - and the second has no duration of its own: its whole
    // script is
    //
    //   function onUpdate(dt) { if (!owner.hasStatus(Skill.<the burn>)) stop(); }
    //
    // so it stands exactly while the burn does. That is a duration the row
    // states, through the other row, and it makes the debuff the burn's
    // companion: applied with it, refreshed with it, gone with it. Returned
    // for a dot when the same reading (`st`) holds such an entry on the same
    // trigger; the fight keeps it up for the dot's life (sim.mjs, where a dot
    // or a pool is applied).
    const companionDebuffOf = (d, st) => {
      for (const x of st.onTarget ?? []) {
        if (x.status === d.status || x.duration != null) continue;
        if ((x.trigger?.on ?? null) !== (d.trigger?.on ?? null) || (x.trigger?.chance ?? 1) !== (d.trigger?.chance ?? 1)) continue;
        const body = liveScript(skills.get(x.status)?.script ?? '').replace(/\s+/g, '');
        if (!new RegExp(`functionon(?:Reg)?Update\\(\\w*\\)\\{if\\(!owner\\.hasStatus\\(Skill\\.${d.status}\\)\\)\\{?stop\\(\\);`).test(body)) continue;
        return { ...x, duration: d.duration, companionOf: d.status };
      }
      return null;
    };
    const noteDots = (id, st, extra = {}) => {
      for (const d of st.dots ?? []) {
        // A roll with no predicate in a damage hook is rolled on every damage
        // instance the owner lands, and for a status that DEALS damage the
        // fight has that clock (see `everyInstance` in triggerOf).
        const instance = d.trigger?.everyInstance === true && !d.trigger.unread;
        dots.push({
          ...d,
          on: instance ? 'damage-instance' : d.trigger?.on ?? 'cast',
          chance: d.trigger?.chance ?? 1,
          why: instance ? String(d.trigger.why).replace(' - floored to the swing and finisher clock', ' you land') : d.trigger?.why ?? null,
          // "...and not again until it has run out": the applier's own guard.
          blocked: d.trigger?.reapply === 'blocked',
          // A roll that scales with a pool the applying cast consumes.
          perPoint: d.trigger?.perPoint ?? null,
          source: extra.source ?? null,
          // What names the event when it is not one of the fight's clocks:
          // another skill's cast, another status's application, a dose gate.
          castOf: d.trigger?.skill ?? null,
          applyOf: d.trigger?.status ?? null,
          tickOf: d.trigger?.tickOf ?? null,
          // A copy: the reader's answer is cached per row, and this build's
          // own companions are written onto it below.
          gate: d.trigger?.gate ? { ...d.trigger.gate } : null,
          // The stat rows the same status puts on the target. A cast's own
          // travel in `applies.target`; a talent has no cast to carry them,
          // so they ride the dot's application (see `put` in sim.mjs).
          debuff: extra.source === 'talent'
            ? (st.onTarget ?? []).find((x) => x.status === d.status) ?? null
            : companionDebuffOf(d, st),
        });
      }
    };

    // A PASSIVE'S DEBUFF ON THE FOE IS WRITTEN AND NEVER READ. `passive[]
    // .debuffs` has no reader anywhere: a cast puts its debuffs up when it is
    // pressed (`applies.target`), a passive is never pressed, and the fight
    // had no other way to put one up. So a row that also keeps a stat or a dot
    // went into `passive`, came out of the unscored list, and the shred its
    // script lays on what you hit was in neither. Chaos Scorch is the row: at
    // rank 3 its burn carries -15% Armor and MagicArmor, and nothing said so.
    //
    // NAMED here, not priced: the row stays where it is and the status is
    // said beside it, with what it carries and when the script applies it.
    // (The fight can hold a debuff an event applies now - `rotation
    // .foeDebuffs`, which the set passives use - so pricing one is a matter
    // of reading how long its row keeps it up.)
    //
    // ...EXCEPT one whose row says how long: a debuff that stops itself when
    // a dot of the same passive is gone stands as long as that dot does, and
    // is in the fight with it (`companionDebuffOf`). Chaos Scorch's is that
    // shape, so it is no longer named here; what is left to name is a debuff
    // with no such companion.
    const notePassiveDebuffs = (id, prof, st, source) => {
      for (const d of st.onTarget ?? []) {
        // One that rides a dot of the same row is in the fight with that dot
        // (`companionDebuffOf`) and is not owed a line here.
        if ((st.dots ?? []).some((x) => companionDebuffOf(x, st)?.status === d.status)) continue;
        const rows = (d.affixes ?? []).filter((a) => a.target?.attribute)
          .map((a) => `${a.val} ${a.target.attribute}`).join(', ');
        unmodelled.push({
          id, name: prof.name, source: source ?? null, kind: 'debuff not scored',
          why: `${prof.name} is in the build, and the status it puts on what you hit is not in the number: `
            + `${d.name}${d.name !== d.status ? ` (${d.status})` : ''}`
            + (rows ? ` [${rows}${d.stacks > 1 ? `, x${d.stacks} at its cap` : ''}]` : '')
            + ` - ${d.trigger?.why ?? 'applied by its script'}. A passive is never cast, so the fight has `
            + 'nothing that puts its debuff up, and the build reads low by what that would be worth',
        });
      }
      // ...and the same row's statuses the reader REFUSED. A cast that is
      // scored names them (`buff refused`, in `push`); a passive kept for a
      // stat or a dot dropped them without a line. Unstable Goo is the row on
      // build 25782799: its dot (Ignited Goo) is scored, and the Goo its
      // magic crits lay on the target first - a mark carrying MoveSpeedFactor
      // -0.3 - was neither in the number nor in the list.
      //
      // Only for a passive that ENDS at one of the two `passive.push` sites.
      // One the trigger path scores, or refuses for want of a rate, leaves
      // `pushTriggered` earlier and its refused statuses are not named
      // there. The two weapon passives whose status enforceStatus holds up
      // behind `!isInCooldown()` go that way - Resilience of the Unkillable
      // Demon King is scored as a trigger, Queen's Decree as a use rider
      // (`useRiderOf`). Each of those two statuses is a marker (no affix row, no
      // effect: it shows the passive is ready), so `statusesOf` carries the
      // switch on the applied trigger (`toggle`) and refuses nothing - there
      // is nothing on the status to refuse - and the number loses nothing.
      //
      // The kind is the refusal's own where it names one (`conditional` for a
      // switch or a guard this cannot evaluate, `foe is passive`), else by
      // what the refused third argument was.
      for (const u of st.unreadable ?? []) {
        unmodelled.push({
          id: u.status, name: u.name, source: source ?? null,
          kind: u.kind ?? (u.refusal === 'count' ? 'stack count' : 'buff refused'),
          why: `${prof.name} is in the build, but ${u.name}${u.name !== u.status ? ` (${u.status})` : ''} is not scored: ${u.why}`,
        });
      }
    };

    // A skill the data says can only be used OUT of combat is not a gap in the
    // model - it is simply not available in a fight, and the honest thing is to
    // leave it out rather than report it as damage nobody could score.
    const outOfCombatOnly = (prof) => {
      const e = prof?.enableCond;
      return !!e?.length && e.every((f) => f === 'OutOfCombat');
    };

    // --- resources ----------------------------------------------------------
    // Income first, because whether a resource-gated skill is castable at all
    // depends on whether anything fills the pool it spends from. `tracked` is
    // the set of pools this build can actually account for, and a cost in
    // anything else still refuses the skill by name.
    const gains = [];
    // A talent is read at its POINTS: that is the rank its script sees and the
    // one its rankOverride answers to (Spark Flask restates var1 15 -> 30 at
    // two points), not the weapon's.
    const noteGains = (id, atRank = rank) => {
      for (const g of resourceGainsOf(id, { rank: atRank, runes, talents })) gains.push(g);
    };
    // Everything the character KNOWS, not just what reaches the rotation: the
    // Warrior's Rage passive emits no damage and would never be collected by a
    // pass that only looked at what it could score.
    {
      const unit0 = cdb.byId('unit').get(loadout.class);
      for (const s of unit0?.skills ?? []) {
        const id = s.skill ?? s.ref;
        if (id && (s.level ?? 0) <= loadout.level) noteGains(id);
      }
      for (const slot of cat.combatSlots()) {
        const it = loadout.gear[slot.id]?.item ? cat.itemById.get(loadout.gear[slot.id].item) : null;
        for (const id of it?.skills ?? []) noteGains(id);
      }
      for (const [id, pts] of Object.entries(loadout.talents ?? {})) noteGains(id, pts);
    }
    // A pool is tracked when something declares income for it AND the sheet
    // gives it a cap.
    //
    // The Rogue's Combo Points. The award is a helper in the row's own
    // script, and the row's text says the rule: "Generates 1 [ComboPoint] when
    // using a [ComboAttack] or [WeaponSkill] different from the last action."
    //
    //   function onSkillProc(ctx)    { tryGetComboPoint(ctx.skill, ctx.skillId, false); }
    //   function onInflictDamage(dmg) { if (dmg.isFirstHit) tryGetComboPoint(dmg.skill, dmg.skillId, dmg.critical); }
    //   function tryGetComboPoint(s, skind, isCrit) {
    //     if (s != null && isSkillCompatible(s)) {            // a weapon skill or the final combo
    //       if (lastSkillProc != skind) { points += vars.var1; lastSkillProc = skind; }
    //       if (isCrit && lastSkillCritProc != skind && hasGlobalMastery(Mastery.Rogue_Finisher_M1)) {
    //         points += 1; lastSkillCritProc = skind; } ... addAtb(owner, Attribute.ComboPoint, points)
    //
    // (compiled as Rogue_ComboPoints.tryGetComboPoint@45222: ops 4-5 the
    // `lastSkillProc` test, op 15 the write, ops 16-24 the critical lane.)
    // ONE memory for both call sites, so a cast pays at its use and its first
    // hit then finds its own kind there; and the memory is only ever a skill
    // that PAID, so a class skill or the Finisher between two final combos
    // does not make the second one "different". The critical lane keeps a
    // memory of its own, written only when it pays.
    //
    // It was carried as +1 for every weapon-skill cast and every final combo,
    // which over-pays any rotation that repeats one of them - and a chain
    // repeats its final combo whenever no weapon skill falls between two.
    // MEASURED 2026-10-13 (Rogue, sixteen rotations of two weapon skills and
    // the chain, 182 Finishers, the points read off each hit's amount on the
    // 1 + 0.3 n ladder): 740 points, 4.07 a Finisher. Replayed over the rows
    // with Knives Tempest's own point and the critical lane, the rule gives
    // the logged count on 157-160 of 181 Finishers (725-730 points against
    // 735 logged); every-event income on 100-107 (842-866). In the fight's own
    // play of the last of those builds 55 events ask for a point in 92 s and
    // 25 are paid.
    //
    // `distinct`: the gain pays an event of another skill than the last one
    // it paid (the fight keeps the memory, per gain - sim.mjs, where income
    // is awarded).
    if (loadout.class === 'Rogue') {
      gains.push({
        atb: 'ComboPoint', amount: skills.get('Rogue_ComboPoints')?.vars?.var1 ?? 1, on: ['weapon-skill', 'combo'], distinct: true,
        from: 'Rogue_ComboPoints', fromName: 'Combo Points',
        why: 'its own script (tryGetComboPoint@45222): a weapon skill or a final combo pays when it is another skill than the last one that paid',
      });
      // The finisher's rune adds a second lane: tryGetComboPoint@45222 ops
      // 16-24 pay +1 more when the first hit CRITS and the mastery is
      // slotted, against a memory of its own. Expectation-priced via the crit
      // chance of the paying event, the memory with it.
      if (runes.has('Rogue_Finisher_M1')) {
        gains.push({
          atb: 'ComboPoint', amount: 1, on: ['weapon-skill', 'combo'], critGated: true, distinct: true,
          from: 'Rogue_Finisher_M1', fromName: 'Combo Points (critical)',
          why: 'tryGetComboPoint@45222 ops 16-24: with the mastery, a critical first hit of another skill than the last one that paid this way pays one more point',
        });
      }
    }
    const tracked = new Set(gains.map((g) => g.atb));

    // The swing riders a cast puts on its caster - see the branch in `push`.
    // Read narrowly: a non-ticking Buff the caster wears, whose script plays
    // ONE of its own damage steps behind exactly the swing guard
    // (`profile().swingPlay`, the same shape Purging Strikes' status has).
    //
    // `opener` is for a status a cast does NOT open: Blessing's is put up by
    // the weapon's passive on every weapon skill, `vars.var1` stacks deep, and
    // spends one per swing - so its window is every weapon-skill press, and
    // closes after that many swings or its ten seconds, whichever is first.
    const swingRidersOf = (hostId, hostProf, statusIds, opener = null) => {
      const out = [];
      for (const sid of statusIds ?? []) {
        const sp = combat.profile(sid, rank, runes);
        const play = sp?.swingPlay;
        if (!play || sp.periodic || sp.tickCarrierSelf !== true) continue;
        const row = skills.get(sid);
        const body = liveScript(row?.script ?? '');
        const stepId = play.stepId;
        // The step's effects, wherever the profile filed them: a step the
        // status lists on Hit is among its effects, one it lists on Code is
        // among the steps its script plays.
        const effects = [...(sp.effects ?? []).filter((e) => e.stepId === stepId),
          ...((sp.scripted ?? []).find((x) => x.stepId === stepId)?.effects ?? [])]
          .filter((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length));
        if (!effects.length) continue;
        // The roll, at the rank the status was applied at (its vars are
        // restated like a skill's: Abyssal Fury's chance is 0.3, 0.4 from 2).
        const chance = play.chanceVar ? sp.vars?.[play.chanceVar] : 1;
        if (!(typeof chance === 'number' && chance > 0 && chance <= 1)) continue;
        // How long the window runs: the status row's duration at the rank it
        // was APPLIED at. A status takes its instigator skill's rank
        // (Status.get_rank@15802 ops 0-5) and props.rankOverride restates
        // `duration` like any other prop (updateSkillInf@21787 ops 189-203:
        // `inf.duration = props.duration`) - Swarmstrike Accord is 8s, 12 at
        // rank 3. `profile()` has folded it.
        const life = sp.duration;
        if (!(life > 0)) continue;
        // A counted opener means something only where the status spends its
        // own stacks one swing at a time; otherwise the count is just stacks.
        const charges = opener?.charges > 0 && play.consumesPerSwing ? opener.charges : null;
        if (opener && !charges) continue;
        // ...and the same step on a SUMMON's hit, unguarded, where the script
        // has the build-25782799 proxy hook for it.
        const proxy = new RegExp('^\\s*playStep\\s*\\(\\s*Steps\\.' + stepId + '\\b')
          .test(hookBody(body, 'onProxyDamage'));
        const on = sp.tickOnSwing === 'attack-or-combo' ? 'your attacks and combo finishers'
          : sp.tickOnSwing === 'combo' ? 'your combo finishers' : 'your attacks';
        // THE STEP MAY ITSELF BE AN ATTACK. `skill@steps.props.flags` has a
        // BaseAttack case, and `hit.isBaseAttack` asks the step before it asks
        // the skill (SkillStep.isBaseAttack@6027 ops 4-9) - so a hit of a step
        // carrying it answers true to every guard written that way, whatever
        // row it sits on. One step in the sheet does: Abyssal Fury's blast,
        // whose tooltip says as much ("Blasted damage is considered as an
        // [Attack]"). What that buys is everything else the build hangs on
        // `hit.isBaseAttack` - Rage, Groundswell Strike's refund, a roll of
        // Cascade's Axe - once per blast. The fight does NOT raise that
        // event: its consumers are not told apart by which spelling they use
        // (`hit.skill.isBaseAttack()` asks the skill alone and says no), so
        // the blast is priced as damage only and the rule says what is left
        // out. Read, not measured.
        const stepRow = (row?.steps ?? []).find((x) => x.id === stepId);
        const flaggedAttack = cdb.flagNames('skill@steps@props', 'flags', stepRow?.props?.flags ?? 0)
          .includes('BaseAttack');
        out.push({
          prof: {
            ...sp, id: `${sid}#${stepId}`, effects,
            occupancy: 0, cooldown: 0, charges: 1, costs: [], isFiller: false, isCombo: false, scripted: [],
          },
          rule: {
            kind: sp.tickOnSwing === 'attack-or-combo' ? 'per-attack-or-combo'
              : sp.tickOnSwing === 'combo' ? 'per-combo' : 'per-attack',
            chance,
            // onInflictDamage is raised per damage INSTANCE, so a swing that
            // lands two hits plays the step twice - the reading the
            // application clock already takes (the capture's 2.35
            // applications a second only reconciles per hit).
            perHit: true,
            window: opener
              ? { from: hostId, on: opener.on, duration: life, charges }
              : { from: hostId, duration: life },
            proxy,
            flaggedAttack,
            accountsFor: opener ? [sid, hostId] : [sid],
            why: `${sp.name}'s ${stepId} step, played by the status on `
              + (chance < 1 ? `${Math.round(chance * 100)}% of the hits` : 'every damage instance')
              + (opener
                ? ` of the next ${charges} of ${on} after each weapon skill you press (${hostProf.name} puts `
                  + `${charges} stacks up, each swing spends one on its first hit, and what is left is gone after ${life}s)`
                : ` of ${on} for the ${life}s ${hostProf.name} puts it up`)
              + (play.notSelf ? ' (the step\'s own hit does not roll for another: the script excludes it)' : '')
              + (flaggedAttack ? '. The step is flagged a base attack, so whatever else this build pays per '
                + 'attack hit is owed on each of these too, and is NOT added here - a floor' : '')
              + (proxy ? ' - and on every hit a summon of yours lands in that window (its onProxyDamage hook, '
                + 'priced at one per summon damage event at the window\'s uptime; not measured on this build)'
                : ''),
          },
        });
      }
      return out;
    };

    const push = (bucket, id, extra = {}) => {
      if (seen.has(id)) return;
      seen.add(id);
      const prof = profileOf(id);
      if (!prof) return;
      if (outOfCombatOnly(prof)) return;
      noteOwnerRiders(id, prof, extra.source);
      const carries = carriesPayload(prof);
      if (!carries) {
        // No declared amount, but it may still grant a stat or leave something
        // ticking on the target.
        const own = (prof.affixes ?? []).filter((a) => a.target?.attribute);
        const st = statusesOf(id, { runes, rank, talents, talentRanks });
        noteDots(id, st, extra);
        // Same as the prayer case, one bucket over: a skill you PRESS whose
        // payload is the status it applies. `Mage_ShieldOfSpark` is a 30-second
        // cooldown that shields for a share of your MaxHealth, and the amount is
        // in ordinary columns - only the schedule was missing, and a cooldown is
        // a schedule.
        // A COOLDOWN WHOSE PAYLOAD IS A SWING RIDER WORN AS A BUFF. The cast
        // itself emits nothing: it puts a status on you whose OWN script plays
        // a damage step on your attacks for as long as it is worn. Swarmstrike
        // Accord is the shape - eight seconds (twelve at rank 3) of
        // `onInflictDamage(hit) { if (hit.isBaseAttack || hit.isFinalCombo)
        // playStep(Steps.BonusDamage, hit.target); }` - and the one-shot
        // branch below took that step for a lump the cast lands ONCE, so a
        // window holding two dozen bonus hits was booked as one of them.
        //
        // The cast is pressed like any other (it costs its clock and opens
        // the window) and the step goes on the event its guard names, live
        // only while the window the cast opened is still running.
        // A CAST WHOSE PAYLOAD IS WHAT IT RELEASES. Judgment deals nothing
        // itself: its one step calls divineInterventionProc, and every ready
        // prayer fires. It was filed as a rune choice the model could not
        // rank and never pressed, while the prayers it alone fires were being
        // fired by the finisher.
        if (bucket === active && prof.cooldown > 0 && prayerReleasers.includes(id)) {
          bucket.push({
            ...extra,
            prof: { ...prof, isFiller: false, isCombo: false },
            applies: { self: st.self, target: st.onTarget },
            releases: true,
            needsReady: refusesEmptyPress(id),
          });
          // Its runes are still a choice nothing here ranks, and still said.
          const before = unmodelled.length;
          noteUnmodelled(id, prof, st, extra);
          if (unmodelled.length > before && unmodelled[unmodelled.length - 1].kind !== 'rune') unmodelled.pop();
          return;
        }
        if (bucket === active && prof.cooldown > 0) {
          const worn = swingRidersOf(id, prof, st.all);
          if (worn.length) {
            bucket.push({
              ...extra,
              prof: { ...prof, isFiller: false, isCombo: false },
              applies: { self: st.self, target: st.onTarget },
            });
            for (const w of worn) triggered.push({ prof: w.prof, source: extra.source ?? null, rule: w.rule });
            return;
          }
        }
        if (bucket === active && prof.cooldown > 0) {
          const payloads = oneShotPayloads(id, { runes, rank, talents });
          if (payloads.length) {
            for (const p of payloads) {
              // The status supplies the AMOUNT; the skill that applies it
              // supplies the SCHEDULE - its cooldown, its cast time, its
              // charges. Neither is any use without the other.
              bucket.push({
                ...extra,
                prof: {
                  ...p.prof,
                  cooldown: prof.cooldown,
                  occupancy: prof.occupancy,
                  charges: prof.charges,
                  type: prof.type,
                  isFiller: false,
                  isCombo: false,
                },
                via: id,
                viaName: prof.name,
                applies: { self: st.self, target: st.onTarget },
              });
            }
            return;
          }
        }
        // A COOLDOWN WHOSE PAYLOAD IS A TIMED SELF-BUFF IS A CAST. The branch
        // above only rescues a status carrying a one-shot amount - a shield, a
        // lump heal - and a status carrying an AFFIX fell past it into
        // `passive`, which is the bucket for things that are simply true. So
        // the fight never pressed it, its window never opened, and the buff sat
        // in `timedBuffs` waiting for a `setUp` that could not come: Battle
        // Shout is fifteen seconds of +20 CritChance on a hundred-and-twenty
        // second cooldown and it read as a dead bar slot, worth negative
        // because it occupied one. Berserk went the same way.
        //
        // Only TIMED buffs qualify. A permanent one is already in the sheet and
        // needs no cast to be true, which is the case `passive` exists for.
        // ...and the same for a TARGET debuff with a duration: Death Mark is a
        // ninety-second press whose whole payload is thirty seconds of +15% on
        // one enemy, and a window like that is exactly what the lookahead
        // exists to price.
        if (bucket === active && prof.cooldown > 0
          && (st.self.some((b) => b.duration > 0) || st.onTarget.some((d) => d.duration > 0))) {
          bucket.push({
            ...extra,
            prof: { ...prof, isFiller: false, isCombo: false },
            applies: { self: st.self, target: st.onTarget },
          });
          return;
        }
        // The same rule for a cast whose whole payload is a DOT. Swirling
        // Embers is an 18-second-cooldown cast whose only step applies an
        // 8-second aura that ticks 0.25x(Dex+Faith); Depth Shield's cast
        // applies orbs that strike on their own clock. Filing those in
        // `passive` left the dot with no applier the fight could fire -
        // "nothing gives Spear_Eruption_Skill1 a rate this model can price" -
        // when the rate was the cooldown sitting right on the row. A quarter
        // of the Priest's recorded damage was behind this one triage line.
        if (bucket === active && prof.cooldown > 0 && st.dots.length) {
          bucket.push({
            ...extra,
            prof: { ...prof, isFiller: false, isCombo: false },
            applies: { self: st.self, target: st.onTarget },
          });
          return;
        }
        if (own.length || st.self.length || st.dots.length) {
          passive.push({ prof, source: extra.source, affixes: own, buffs: st.self, debuffs: st.onTarget, dots: st.dots });
          notePassiveDebuffs(id, prof, st, extra.source);
          return;
        }
        // A PRESS THAT CARRIES NOTHING BUT LANDS ON ITS OWN CASTER. It has no
        // amount, no stat and no tick of its own, and is still worth a press
        // to a build that holds a status "a skill of yours landing on an ally"
        // puts up (`statusWindows`, `opensOn.allyHit`: Sunlight). Faithful
        // Winds is the row: ten seconds of an area that hits its caster every
        // half second. Whether the build holds such a status is only known
        // once the talents are read, so the entry waits (`selfLanders`); what
        // the row does besides is still named below.
        if (bucket === active && prof.cooldown > 0 && landsOnCaster(id, null, rank, runes)) {
          selfLanders.push({
            ...extra,
            prof: { ...prof, isFiller: false, isCombo: false },
            applies: { self: st.self, target: st.onTarget },
          });
        }
        // Everything else this skill could be doing lives somewhere the model
        // does not look. Say so. Five Priest class abilities used to disappear
        // here without a word, which is worse than a wrong number - the output
        // read as if the class had no cooldowns at all.
        noteUnmodelled(id, prof, st, extra);
        return;
      }
      // A cast rate has to come from somewhere. A cooldown is one; so is a
      // resource, once the income that fills it is read - `Warrior_Rage_Strike`
      // has no cooldown and costs 10 Rage, and the Warrior generates 1 Rage per
      // attack, combo finisher and weapon skill, plus 1 every 3 seconds from
      // Infinite Rage. That is a rate, and the fight can now derive it.
      if (bucket === active && !(prof.cooldown > 0)) {
        if (prof.costs.length && prof.costs.every((c) => tracked.has(c.atb))) {
          // Falls through: the simulation gates the cast on the pool.
        } else if (prof.costs.length) {
          unmodelled.push({
            id, name: prof.name, kind: 'resource',
            why: `gated by ${prof.costs.map((c) => c.atb).join('/')}, and nothing in this build `
              + 'declares income for it that this model can read',
          });
          return;
        } else {
          unmodelled.push({ id, name: prof.name, kind: 'no rate', why: 'no cooldown and no resource cost, so no cast rate can be derived' });
          return;
        }
      }
      // A skill that both hits and leaves something ticking gets both counted,
      // and what it puts UP travels with it - the fight applies a buff or a
      // debuff at the moment the cast lands, and prices what comes after
      // against it.
      const st2 = statusesOf(id, { runes, rank, talents, talentRanks });
      noteDots(id, st2, extra);
      // A skill can be scored for its damage while a buff it grants is
      // refused - Ram Veil's +5 CritChance / +5 Fervor lands only when a
      // max-stacked Benediction is consumed, which is live state. The cast is
      // counted; the refusal is NAMED rather than swallowed, or the output
      // would quietly read lower than the tooltip promises with no word why.
      for (const u of st2.unreadable ?? []) {
        if (!u.trigger?.unread) continue;
        unmodelled.push({
          id: u.status, name: u.name, source: extra.source ?? null, kind: 'buff refused',
          why: `${prof.name} is scored, but ${u.name} lands only while ${u.trigger.unread}() `
            + 'holds, which this reader cannot evaluate',
        });
      }
      bucket.push({ ...extra, prof, applies: { self: st2.self, target: st2.onTarget } });
    };

    // 1. The main-hand chain, and only it - the combo attack cannot be
    // performed with the arsenal weapon. Its passive is always on, unlike the
    // arsenal's, which has to win one of two slots.
    const main = loadout.gear.Slot_Weapon1?.item ? cat.itemById.get(loadout.gear.Slot_Weapon1.item) : null;
    // The chain in SLOT ORDER: the weapon's own swing rows, then its combo -
    // see `baseChain`. Iterating `main.skills` in declaration order happened
    // to produce the right order on every weapon in this build, which is not
    // the same thing as producing it on purpose.
    const chain = baseChain(main);
    if (main) {
      for (const id of chain.links) push(filler, id, { source: 'Slot_Weapon1' });
      for (const id of main.skills) {
        if (typeOf(id) === 'WeaponPassive') pushTriggered(id, 'Slot_Weapon1');
      }
      // Fewer links than the moveSet's `comboLength` says. That used to mean
      // "the model is short a link"; on this build it means the column is dead
      // and the chain is exactly what is listed - which is a read, so it is
      // scored, and it is unmeasured, so the plan says what to count.
      //
      // Only where there is a FINISHER to count. The sentence is about how
      // often the finisher lands, and the count it asks for is the swings
      // between two of them - the links that are not the AttackCombo row.
      // Large Butterfly Net lists one Attack row (Net_Capture) under a
      // moveSet that says 4 and no finisher at all: it was told its finisher
      // lands more often and to count "0 swings between two finishers". A
      // chain with no finisher has nothing the dead column could have moved,
      // so nothing is said about it.
      const swings = chain.links.filter((id) => !COMBO_TYPES.has(typeOf(id))).length;
      const hasFinisher = chain.links.length > 0 && COMBO_TYPES.has(typeOf(chain.links[chain.links.length - 1]));
      if (chain.want > 0 && hasFinisher && chain.links.length < chain.want) {
        const n = chain.links.length;
        unmodelled.push({
          id: main.id, name: main.name, source: 'Slot_Weapon1', kind: 'assumption',
          why: `its base-attack chain is played as the ${n} link${n === 1 ? '' : 's'} it lists, where its `
            + `moveSet ${chain.moveSet} says ${chain.want}. Nothing in build 25782799 reads that number any `
            + 'more (the client used to repeat the last swing up to it), so the finisher - and everything '
            + 'that rolls off it - lands more often than before the patch. Read from the bytecode, not '
            + `measured: ${swings} swing${swings === 1 ? '' : 's'} between two finishers in game is this reading, `
            + `${chain.want - 1} means something still pads the chain`,
        });
      }
    }

    // The offhand grants full stats and every skill it has, with no pool.
    const off = loadout.gear.Slot_OffhandWeapon?.item ? cat.itemById.get(loadout.gear.Slot_OffhandWeapon.item) : null;
    for (const id of off?.skills ?? []) {
      const t = typeOf(id);
      if (FILLER_TYPES.has(t)) continue;             // the offhand has no chain of its own
      if (t === 'WeaponSkill') push(active, id, { source: 'Slot_OffhandWeapon' });
      else pushTriggered(id, 'Slot_OffhandWeapon');
    }

    // 2. Slotted weapon skills, from both hands, plus their follow-ups.
    //
    // Resolved ONCE. Three passes below ask the same question of the same
    // loadout, and the talent pass needs to know what the mechanic pools were
    // offering - not just what they picked.
    const livePools = pools(loadout);
    // Every mechanic skill this build is OFFERED, slotted or not. The talent
    // pass at 5 needs the offer rather than the pick: a conduit a talent added
    // to the pool is the pool's to fire, and a granted row that no pool claims
    // is still the talent's - so the membership test, not the type test.
    const mechanicOptions = new Set(livePools.filter((p) => p.mechanic).flatMap((p) => p.options));
    for (const p of livePools) {
      // One fill rule, shared with defaultSelection/pruneSelection - when they
      // disagreed, a stored selection of two conduits silently beat the cycle
      // here and the third slot went to nobody.
      const chosen = (sel[p.key] ?? fillPool(p)).slice(0, p.slots);
      const item = p.kind === 'weapon' ? cat.itemById.get(loadout.gear[p.slot]?.item) : null;
      const all = item?.skills ?? [];

      if (p.mechanic) {
        // Duplicates collapse to one entry with an INSTANCE COUNT - the
        // seen-guard would eat a second push, and the game itself fans one
        // trigger event across instances (getSkillInstanceCount).
        const counts = new Map();
        for (const id of chosen) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const [id, n] of counts) {
          pushTriggered(id, p.key, { mechanic: p.mechanic, sharedWith: counts.size, instances: n });
        }
      } else {
        for (const id of chosen) {
          const t = typeOf(id);
          if (t === 'WeaponSkill') push(active, id, { source: p.key, chosen: true });
          else if (t === 'WeaponPassive') pushTriggered(id, p.key);
        }
      }
      // A follow-up fires off its parent, so it is TRIGGERED, not active. It
      // has no cooldown of its own and asking it for one sent every one of them
      // to "no cast rate can be derived" - which was true of the question and
      // false of the skill.
      for (const id of subSkillsFor(chosen, all)) {
        const parent = parentOf(id, all);
        pushTriggered(id, p.key, { followUp: true, parent });
      }
      for (const id of orphanSubSkills(all, chosen)) {
        const prof = combat.profile(id, rank, runes);
        if (prof?.effects.some((e) => e.kind === 'Damage')) {
          unmodelled.push({ id, name: prof.name, kind: 'no rate', why: 'a WeaponSubSkill with no discoverable trigger' });
        }
      }
    }

    // 3. Class skills that are not part of a chosen pool: always available -
    // once you have LEARNED them. `unit@skills.level` states the unlock, and
    // ignoring it put three level-30 capstones (Warrior_BurstOfAnger,
    // Priest_Miracle, Rogue_Darkness) in a level-25 character's coverage report
    // as things the model had failed to score. It had not failed to score them;
    // the character does not have them.
    const unit = cdb.byId('unit').get(loadout.class);
    // Six class skills exist and four fit on the bar, so the ones NOT slotted
    // are not yours - handing out all five a level-25 character has learned is
    // a free cooldown. The chosen four came through the pool loop above.
    const classPool = livePools.find((p) => p.key === 'class/ClassSkill');
    const classChosen = new Set(classPool
      ? (sel[classPool.key] ?? classPool.options.slice(0, classPool.slots)).slice(0, classPool.slots)
      : []);
    for (const s of unit?.skills ?? []) {
      const id = s.skill ?? s.ref;
      if (!id || seen.has(id)) continue;
      if ((s.level ?? 0) > loadout.level) continue;
      const t = typeOf(id);
      if (MECHANIC_TYPES[t]) continue;            // handled by its pool
      if (INERT_TYPES.has(t)) continue;
      if (t === 'ClassSkill' && classPool && !classChosen.has(id)) continue;
      if (ACTIVE_TYPES.has(t)) push(active, id, { source: 'class' });
      else pushTriggered(id, 'class');
    }

    // 4. Skills granted by anything else worn: enchants, sigils, trinkets.
    //
    // NOT BY THE ARSENAL WEAPON. st.Item.getSkills@8734 asks the piece's equip
    // slot before anything else (ops 5-10, against the string "Slot_Weapon2" -
    // the global Gear.getSkills@9762 op 5-6 tests for the sockets). In that
    // slot it hands back the arsenal skills the player chose, each one only if
    // $Weapon.isValidArsenalSkill@9859 passes it (a WeaponSkill or a
    // WeaponPassive the row lists: ops 42-71), and returns. Every other slot
    // goes to op 73, st.Item.getMainSkillList@8735, which is the ONLY place a
    // piece's own non-pool rows (ops 7-39: its Block among them) and its
    // itemType's skills (ops 40-65: each weapon class's Block) are added. So
    // the arsenal's two chosen skills are the pool loop's above and it gives
    // nothing else: no Parry from Wingsabers behind a staff, no Block from a
    // shield parked there.
    //
    // MEASURED 2026-10-13: Emsay wore Silhouette of Almaz with Wingsabers in
    // the arsenal. Each of her snapshots holds one BlockMitigation affix, 50
    // flat from MagicBlock, and no PhysicalBlock row; the model read 100, and
    // `verify` printed BlockMitigation 50.0 / 100.0 on her SHEET line.
    //
    // (With NO arsenal skill chosen the same function hands out the first skill
    // the row lists instead - ops 15-41 - which on GA_Craft is its Parry. The
    // bench never holds that state: pruneSelection fills an empty pool.)
    const ARSENAL = 'Slot_Weapon2';
    for (const slot of cat.combatSlots()) {
      if (slot.id === ARSENAL) continue;
      const g = loadout.gear[slot.id];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      // The block family is EXCLUSIVE: a hero has one block slot and the
      // shield's wins (Hero.refreshSkills@7738 fills one slot per skill kind,
      // first match, and the capture shows exactly one BlockMitigation affix
      // per character - always the shield's when one is worn). The model used
      // to grant a weapon's PhysicalBlock AND the shield's ShieldBlock and
      // read 110 against the game's 60. The weapon's copy arrives BOTH ways -
      // GA_Craft lists PhysicalBlock in its own item.skills and the GreatAxe
      // itemType inherits it too - so the skip guards both loops. A shield in
      // the ARSENAL shadows nothing: it hands out no Block of its own (above),
      // so the main hand's stays - it used to read as worn and a two-hander
      // lost its Parry to a Block the hero did not have.
      const hasShield = Object.entries(loadout.gear ?? {}).some(([sid, x]) => {
        if (sid === ARSENAL) return false;
        const it2 = x?.item ? cat.itemById.get(x.item) : null;
        return it2 && /Shield/i.test(String(it2.type ?? ''));
      });
      const blockShadowed = (id) => hasShield && /^(Physical|Magic)Block$/.test(id);
      for (const id of item?.skills ?? []) {
        if (seen.has(id) || blockShadowed(id)) continue;
        const t = typeOf(id);
        if (FILLER_TYPES.has(t) || t === 'WeaponSkill' || t === 'WeaponPassive' || t === 'WeaponSubSkill') continue;
        if (INERT_TYPES.has(t)) continue;
        if (ACTIVE_TYPES.has(t)) push(active, id, { source: slot.id });
        else pushTriggered(id, slot.id);
      }
      // The itemType's shared moves (each weapon class's block) - but only
      // for real combat gear: the bug net reaches GreatAxe's PhysicalBlock
      // through an inherit that exists for the animation rig. See
      // catalog.isCombatGear.
      for (const s of (cat.isCombatGear(item) ? cat.inherited(item?.type, (t) => t?.skills) : null) ?? []) {
        const id = s.skill ?? s.ref;
        if (!id || seen.has(id) || INERT_TYPES.has(typeOf(id))) continue;
        if (blockShadowed(id)) continue;
        pushTriggered(id, slot.id);
      }
    }
    for (const sock of cat.socketsFor ? socketList(loadout) : []) {
      // The arsenal weapon's sockets hand out no skill (catalog.mjs
      // socketGrantsSkills, Gear.getSkills@9762).
      if (!cat.socketGrantsSkills(sock.slot)) continue;
      const augId = loadout.augments?.[sock.key];
      const aug = augId ? cat.itemById.get(augId) : null;
      for (const id of aug?.skills ?? []) {
        if (seen.has(id)) continue;
        if (ACTIVE_TYPES.has(typeOf(id))) push(active, id, { source: sock.key });
        else pushTriggered(id, sock.key);
      }
    }

    function socketList(l) {
      const out = [];
      for (const slot of cat.combatSlots()) {
        const g = l.gear[slot.id];
        if (!g?.item) continue;
        const item = cat.itemById.get(g.item);
        if (!item) continue;
        for (const type of cat.socketsFor(item)) out.push({ key: `${slot.id}/${type}`, slot: slot.id, type });
      }
      return out;
    }

    // A triggered skill only earns a throughput slot if we can say how often it
    // fires. One that cannot still counts if it grants a stat - the weapon-class
    // block abilities are +50 BlockMitigation and the weapon enchants are
    // stacking rating buffs - so those go to `passive` instead of being dropped.
    function pushTriggered(id, source, extra = {}) {
      if (seen.has(id)) return;
      const prof = profileOf(id);
      if (!prof) return;
      seen.add(id);
      if (outOfCombatOnly(prof)) return;
      noteOwnerRiders(id, prof, source);

      const carries = carriesPayload(prof);
      const ownAffixes = (prof.affixes ?? []).filter((a) => a.target?.attribute);
      const st = statusesOf(id, { runes, rank, talents, talentRanks });
      noteDots(id, st, { source });

      // A skill whose DAMAGE has no derivable rate can still carry a stat that
      // is simply ALWAYS ON, and refusing the damage is no reason to throw the
      // stat out with it. Bloodrage Aura is the row that proved it: its Heal
      // step is `on: Code`, played only by the script on a physical crit at
      // rank >= 3, so the skill really has no rate this reader can derive - but
      // the SAME row also runs an Aura step at Start with `duration: -1`, which
      // puts CritChance on the wielder and every ally in range for the whole
      // fight (+5 when this was written; +2, and +3 from rank 2, on build
      // 25782799). The skill was refused whole and the aura's crit went with
      // it, on the one weapon in the game whose passive IS a crit aura.
      //
      // Only a PERMANENT self-buff and the skill's own affix rows come through
      // here. A timed buff needs the rate that was just refused to know how
      // often it goes up; a debuff and a DoT need it too. Anything script-gated
      // or dynVal-scaled never reaches `st.self` - `statusesOf` has already
      // diverted those into `unreadable` with a reason.
      // Returns the clause to append to the refusal, so the report never says
      // "not scored" about a skill half of which just was.
      const alwaysOn = st.self.filter((b) => !(b.duration > 0));
      const keepAlwaysOn = () => {
        if (!ownAffixes.length && !alwaysOn.length) return '';
        passive.push({
          prof, source, affixes: ownAffixes, buffs: alwaysOn, debuffs: [], dots: [], ...extra,
        });
        const kept = [
          ...ownAffixes.map((a) => a.target.attribute),
          ...alwaysOn.flatMap((b) => b.affixes.map((a) => a.target.attribute)),
        ];
        return kept.length
          ? ` - the ${[...new Set(kept)].join('/')} it grants IS scored, at the permanent value; `
            + 'only this payload is not'
          : '';
      };

      if (carries) {
        const rule = triggerRule(id, prof, extra, guardOpts);
        if (usableRule(rule)) {
          triggered.push({ prof, source, rule, applies: { self: st.self, target: st.onTarget }, ...extra });
          return;
        }
        // A rule the guard reader looked at and REFUSED says something specific
        // about why, and that beats the generic "no trigger rate" message.
        // The row's own always-on rows stay, as they do on every other
        // refusal below: a payload behind a rank the build has not reached,
        // or behind a condition this cannot answer, says nothing about a stat
        // the same row grants for being owned. (Latent on build 25782799 -
        // the rows with both shapes are the set passives, which do not come
        // through here - and that is the only reason it cost nothing.)
        if (rule) {
          unmodelled.push({
            id, name: prof.name, source,
            kind: rule.kind === 'never' ? 'gated off' : 'conditional',
            why: rule.why + keepAlwaysOn(),
          });
          return;
        }
        // A trigger that only fires when you BLOCK or when you are HIT never
        // fires here - the simulated foe does not attack - and that is a
        // statement about the fight model, not about the data. A trigger that
        // does BOTH is a different sentence: half of it fires on every hit you
        // land, so the zero is a floor rather than an answer.
        const gate = foeGating(skills.get(id)?.script);
        if (gate) {
          unmodelled.push({
            id, name: prof.name, source,
            kind: gate.mixed ? 'half of it fires' : 'foe is passive',
            why: (gate.mixed
              ? `its script declares ${gate.off.join(' and ')} alongside ${gate.def.join(' and ')} - hooks on `
                        + 'damage you DEAL, not only on damage you take - so "the foe is passive" is not the '
                        + 'whole reason this is worth zero here. What those hooks are guarded on, and where '
                        + 'their payload lands, is further than this reader follows'
              : 'it fires when you block or when you are hit, and the simulated foe never attacks - '
                + 'real in game, correctly worth zero here') + keepAlwaysOn(),
          });
          return;
        }
        // A CONDUIT has a rate, and it is not one the data withholds - it is
        // one the fight does not yet produce. Every equipped conduit fires
        // together when the Spark gauge crosses its threshold, so the number
        // needed is a gauge simulation, not a missing column. Saying that beats
        // "no trigger rate can be derived from the data", which points the
        // reader at the CastleDB when the answer is in the fight model.
        if (typeOf(id) === 'MageConduit' || extra.mechanic === 'MageConduit'
          || typeOf(extra.grantedBy ?? '') === 'Talent') {
          const conduit = typeOf(id) === 'MageConduit';
          unmodelled.push({
            id, name: prof.name, source, kind: conduit ? 'no rate' : 'no rate',
            why: conduit
              ? 'every equipped conduit fires together when the Spark gauge crosses its threshold, '
                + 'and this fight spends Spark without simulating the gauge - so the amount is exact '
                + 'and the rate is a fight-model gap, not a data one'
              : `${skills.get(extra.grantedBy)?.texts?.name ?? extra.grantedBy} grants it, and its `
                + 'trigger is the conduit gauge this fight does not simulate',
          });
          return;
        }
        // A follow-up armed by a STACK COUNTER now has a rate, and it was
        // always in the data: one stack per qualifying damage event, converting
        // at `maxStacks`. What was missing was a fight that counted its own
        // events, and it counts them now.
        if (stackProcIds(rank, runes).has(id)) return;
        // A ROW THAT RUNS ITS OWN COOLDOWN AS A CLOCK. Queen's Decree is the
        // shape `triggerRule` does not take: the cooldown is spent by the
        // next skill that can deal magic damage (`onUseSkill`: `if
        // (!isInCooldown()) { ctx.magicDmgMult += vars.damage;
        // consumeCooldown(); }`), and its rank-3 step is played on every
        // critical damage instance WHILE that cooldown runs. Where both
        // halves are read to the letter (`useRiderOf`) the fight keeps that
        // clock and prices them; any other spelling keeps the refusal below,
        // which says what was read - "no trigger rate can be derived from the
        // data" was never the reason: the rate is right there, behind a state.
        {
          const spec = useRiderOf(id, prof, source);
          if (spec) {
            useRiders.push(spec);
            if (ownAffixes.length || alwaysOn.length) keepAlwaysOn();
            return;
          }
        }
        {
          const cb = liveScript(skills.get(id)?.script ?? '');
          const spend = /consumeCooldown\s*\(/.exec(cb);
          if (spend && prof.cooldown > 0) {
            const spendHook = hookAt(cb, spend.index);
            const spendScope = enclosingBlock(cb.slice(0, spend.index));
            const bonus = /\b\w+\.(magicDmgMult|physicalDmgMult|dmgMult|critDmgMult)\s*\+=\s*vars\.(\w+)/.exec(spendScope);
            const bonusVal = bonus ? varsOf(id, rank, runes)[bonus[2]] : null;
            // ...AT THIS RANK. The played step sits behind `rank >= 3`, and a
            // clause the build's rank switches off is dead, not unpriced -
            // the same test the gap reader puts to every clause. Named
            // without it, a rank-1 Queen's Decree was said to play a step it
            // does not have.
            const played = [...cb.matchAll(/playStep\s*\(\s*Steps\.(\w+)/g)]
              .filter((pm) => /\bisInCooldown\s*\(\s*\)/.test(enclosingBlock(cb.slice(0, pm.index)))
                && !/!\s*isInCooldown/.test(enclosingBlock(cb.slice(0, pm.index)))
                && guardOf(enclosingBlock(cb.slice(0, pm.index)), guardOpts).fires)
              .map((pm) => ({ step: pm[1], hook: hookAt(cb, pm.index), crit: /\bcritical\b|\bisCrit\b/.test(enclosingBlock(cb.slice(0, pm.index))) }));
            unmodelled.push({
              id, name: prof.name, source, kind: 'conditional',
              why: `its script runs on its own ${prof.cooldown}s cooldown, spent from ${spendHook}`
                + (typeof bonusVal === 'number'
                  ? ` (the press that spends it takes ${bonus[1]} +${bonusVal})` : '')
                + (played.length
                  ? `, and its ${played.map((p) => p.step).join(' / ')} step is played from ${played[0].hook}`
                    + `${played[0].crit ? ' on a critical strike' : ''} only while that cooldown is running`
                    + ' - both are read, and neither is priced'
                  : ' - it is read, and not priced')
                + ': this fight does not keep a passive\'s cooldown as a clock'
                + keepAlwaysOn(),
            });
            return;
          }
        }
        // A STEP PLAYED FOR A SKILL DIFFERENT FROM THE LAST ONE THAT PLAYED IT.
        // Going With the Flow:
        //
        //   var lastSkillProc = null;
        //   function onInflictDamage(dmg) { var s = dmg.skill;
        //     if (s != null && dmg.isFirstHit && lastSkillProc != s.kind && isSkillCompatible(s)) {
        //       playStep(Steps.Eruption); lastSkillProc = s.kind; } }
        //   function isSkillCompatible(s) { ... return s.isWeaponSkill() || s.isFinalAttack(); }
        //
        // That is a rate, and the script states all of it: the first hit of
        // every weapon skill or finisher whose row is not the one that fired
        // it last (nothing fired it before the first, so the first always
        // does). It was told "no trigger rate can be derived from the data",
        // which sends the reader to the CastleDB for something that is in the
        // script and missing from the FIGHT: no rider here remembers which
        // skill paid it last (the income reader does, for Combo Points). So
        // it stays unpriced, and says what it is and what is missing. The
        // audit holds it as open with what pricing it must carry.
        const memo = lastFiredRider(skills.get(id)?.script);
        if (memo) {
          unmodelled.push({
            id, name: prof.name, source, kind: 'conditional', lastFired: memo,
            why: `its script plays its ${memo.step} step on ${memo.firstHit ? 'the first hit of ' : ''}`
              + `${memo.events.length ? memo.events.join(' or ') : 'a skill'} whose row differs from the last one that played it `
              + '(the first one always does) - a rate the script states in full, and one this fight does not '
              + 'produce: no rider here remembers which skill fired it last. Read, and not priced'
              + keepAlwaysOn(),
          });
          return;
        }
        unmodelled.push({
          id, name: prof.name, source, kind: 'no rate',
          why: (extra.parent
            // The parent link IS in the data (props.subskills); what is not is
            // the counter that arms it - for the ultimates that bank a stack
            // per damage event, see `stackProcsOf`, which reads exactly that.
            ? `${skills.get(extra.parent)?.texts?.name ?? extra.parent} unlocks it, and that is a passive - `
              + 'nothing in the data says how many hits arm it'
            : 'declares damage but no trigger rate can be derived from the data')
            + keepAlwaysOn(),
        });
        return;
      }

      // A skill can carry its payload one level down, in the status it applies,
      // and that is not a gap - the amount is in ordinary columns. The three
      // Priest prayers are the case that shows it: Life heals 1x Faith and Smite
      // hits for 1.5x Faith on their own steps and both were scored, while
      // Virtue - which shields for 0.8x Faith - declared nothing itself and fell
      // straight through to "not modelled", on the same trigger, off the same
      // combo, in the same rotation. Same mechanic, same rate, one of the three
      // silently worth nothing.
      // A PASSIVE THAT ARMS A SWING RIDER. Blessing is the row: every weapon
      // skill puts `vars.var1` stacks of a status on you (2, 3 from rank 2)
      // whose own script plays a damage step on each attack and spends one
      // stack for it - "Your [WeaponSkill] empower your next ::var1::
      // [Attack]s". Nothing here has an amount of its own, so the passive fell
      // to the unscored list while its status sat in no bucket at all.
      // Only the certain form: applied to you, on a weapon skill, with no roll
      // and no live-state guard in front, by a literal or a var.
      {
        const worn = (st.applied ?? [])
          .filter((a) => a.to === 'Self' && a.trigger?.on === 'weapon-skill' && !a.trigger.unread
            && !a.trigger.toggle && (a.trigger.chance ?? 1) === 1 && a.trigger.count > 0)
          .flatMap((a) => swingRidersOf(id, prof, [a.status],
            { on: 'weapon-skill', charges: Math.min(a.trigger.count, maxStacksOf(a.status, rank, talentRanks)) }));
        if (worn.length) {
          for (const w of worn) triggered.push({ prof: w.prof, source, rule: w.rule });
          if (ownAffixes.length || st.self.length) {
            passive.push({ prof, source, affixes: ownAffixes, buffs: st.self, debuffs: st.onTarget, dots: st.dots, ...extra });
          }
          // What the status's script does beyond the step is still named.
          for (const gap of worn.flatMap((w) => scriptGapsOf(w.rule.accountsFor[0], rank, { runes }))) {
            unmodelled.push({
              // Under the clause's own id: the status itself is accounted for
              // by the rider, and an entry under its id would be dropped as
              // already scored.
              id: gap.id + '#' + gap.field, name: gap.name, source, kind: 'rider not read',
              why: gap.why,
            });
          }
          return;
        }
      }
      const payloads = oneShotPayloads(id, { runes, rank, talents });
      if (payloads.length) {
        const rule = triggerRule(id, prof, extra, guardOpts);
        if (usableRule(rule)) {
          for (const p of payloads) {
            triggered.push({
              prof: p.prof, source, rule, via: id, viaName: prof.name,
              applies: { self: st.self, target: st.onTarget }, ...extra,
            });
          }
          // The payload enters under the STATUS's profile, so the host's own
          // affix rows have no entry to ride - a row whose payload is one
          // level down and which also grants a stat for being owned lost the
          // stat. The host goes in beside it for its rows alone.
          if (ownAffixes.length) passive.push({ prof, source, affixes: ownAffixes, buffs: [], debuffs: [], dots: [], ...extra });
          return;
        }
      }
      if (ownAffixes.length || st.self.length || st.dots.length) {
        passive.push({ prof, source, affixes: ownAffixes, buffs: st.self, debuffs: st.onTarget, dots: st.dots, ...extra });
        notePassiveDebuffs(id, prof, st, source);
        return;
      }
      noteUnmodelled(id, prof, st, { source });
    }

    // One place that decides what to SAY about a skill the model cannot score,
    // so the reason is specific instead of "not modelled".
    //
    // Silence is reserved for rows that are not abilities at all: `Mount` sits
    // in the class's skill list with no type, no script, no affix and a single
    // Mount step. Naming it would bury the five real class cooldowns this list
    // exists to surface.
    function noteUnmodelled(id, prof, st, extra = {}) {
      const s = skills.get(id);
      const isAbility = prof.type != null || prof.hasScript || (s?.affixes ?? []).length
        || (s?.steps ?? []).some((x) => (x.effects ?? []).length || x.props?.status?.ref);
      if (!isAbility) return;

      // A REFUSAL WHOSE REASON IS FALSE IS A BUG, and the two channels added
      // most recently both created one. `GA_Craft_Passive` was still filed
      // under "everything it does lives in its hscript body" while its +25%
      // rider was being read off that very body (read - and, it turned out,
      // applied to nothing until `ownerRiders` carried it); the same sentence
      // sat on `Warrior_Talent_SurgeOfViolence` after its register started
      // making Rage Strike free and certain. The coverage report is the thing a
      // player checks the tool against, so a skill the model DOES score must
      // not appear in the list of skills it does not.
      if ((prof.runeDamage ?? []).length) return;
      if (empowermentIds(rank, runes).has(id)) return;
      // A follow-up armed by a stack counter is scored from `events / maxStacks`
      // now, so "nothing in the data says how many hits arm it" stopped being
      // true. The data says 100.
      if (stackProcIds(rank, runes).has(id)) return;

      // What KIND of gap this is, so a reader can tell a teleport apart from
      // damage the model cannot reach. "Contributes zero" is true of both and
      // useful about neither: `Mage_Blink` contributes zero because it is a
      // teleport, and that is the right answer, not a shortfall.
      const stepTypes = new Set((s?.steps ?? []).map((x) => stepTypeNames[x.type ?? -1]));
      const MOVEMENT = ['Dash', 'Teleport', 'Jump', 'GapClose'];
      const carriesAnywhere = (id2) => {
        const p2 = combat.profile(id2, rank, runes);
        return !!p2?.effects.some((x) => ['Damage', 'Heal', 'Shield'].includes(x.kind)
          && (x.baseVal || x.scaling.length));
      };

      // A RUNE can turn a movement ability into something else entirely, and
      // the search picks the rune - so "it is only a teleport" is a claim about
      // one rune choice, not about the skill.
      //
      //   Rogue_Shadowstep + Combo Step   generates 2 ComboPoints
      //   Mage_Blink       + Phase Strike next WeaponSkill deals more damage
      //   Warrior_Charge   + Juggernaut   generates 5 Rage
      //
      // A rune that gates a step, gates an affix or overrides a prop is already
      // applied by `profile()`. One that declares only `vars` and a description
      // is NOT, and that is exactly where these three live. So the slotted rune
      // is checked, and where it promises something unread the skill is filed
      // under what the RUNE does rather than under what the skill does alone.
      // ...and the choice matters even when nothing is slotted. The search
      // leaves these empty precisely BECAUSE it cannot price them: if a skill
      // scores zero, so does doubling its charges, so every rune ties and the
      // tiebreak picks none. Reporting "nothing here to score" about a skill
      // whose rune list contains "generates 2 ComboPoints" is the tool being
      // confidently unhelpful. So every rune whose payload the model does not
      // read is named, slotted or not, with what it promises.
      // ...or one whose script clause a reader DOES take: a status the row
      // applies behind `hasMastery(<rune>)` that the status reader keeps.
      // Spirited Disciple is the row - priced on the presses that release
      // three prayers, and printed here as declaring only a description.
      const readsRune = (m) => Object.keys(m.props ?? {}).length > 0
        || (s?.steps ?? []).some((x) => x.cond?.mastery === m.id || x.cond?.masteryExclude === m.id)
        || (s?.affixes ?? []).some((a) => a.conds?.mastery === m.id)
        || runeStatusesOf(id, m.id, { rank, talents, talentRanks }).length > 0;
      const slottedRune = (s?.mastery ?? []).find((m) => runes?.has(m.id)) ?? null;
      const unreadRunes = (s?.mastery ?? []).filter((m) => !readsRune(m) && (m.text?.desc ?? '').trim());
      const runePromises = unreadRunes.map((m) => ({
        id: m.id,
        name: m.text?.name ?? m.id,
        slotted: !!runes?.has(m.id),
        desc: fillTemplate(m.text?.desc ?? "", m.vars ?? {}, s, skills),
      }));
      const runeDesc = runePromises.length
        ? (runePromises.find((r) => r.slotted) ?? runePromises[0]).desc : '';
      // A rune that promises a resource this build cannot account for. The
      // NAMED pool matters, and it used to be ignored: the test matched the
      // word `[ComboPoint]` in a rune's description and filed the skill under
      // "gated by a pool nothing in this build declares readable income for" -
      // about a Rogue, whose Combo Point income is read three screens earlier
      // and is what gives the Finisher its cost. Shadowstep and Death Mark both
      // came out that way, and the printed reason was simply false.
      const runePools = runePromises.flatMap((r) =>
        [...String(r.desc).matchAll(/\[(Rage|Spark|ComboPoint)\]/gi)].map((m) => m[1]));
      const runeFeedsResource = runePools.some((p) => !tracked.has(p));

      // Utility only when nothing - including the rune you actually slotted -
      // gives it a payload.
      const isUtility = MOVEMENT.some((m) => stepTypes.has(m))
        && !carriesAnywhere(id) && !st.all.some(carriesAnywhere)
        && !runeDesc;
      // Resource: it spends one, or it generates one. `Warrior_InfiniteRage` is
      // a GainAtb of 1 Rage every 3 seconds - fully in the data, and useless
      // until something tracks the pool it fills.
      const resourceAtbs = new Set(ctx.attrTable.attrs.filter((a) => a.isResource).map((a) => a.id));
      const feedsResource = (s?.steps ?? []).some((x) => (x.effects ?? []).some((ef) =>
        resourceAtbs.has(ef.target?.atb)));
      // A status the game itself types as a tick, that carries no tick schedule
      // this model can find, is a different gap from "declares nothing" - the
      // effects are right there, it is the SHAPE that is missing.
      const noTick = st.missingTick ?? [];
      // ...and one it types as crowd control is not a gap at all. It is the
      // right answer for a fight whose foe does not act.
      const ccOnly = (st.flaggedCC ?? []).length > 0 && !st.self.length && !st.dots.length;
      // A skill that fires when you BLOCK or when you are HIT is the same
      // case from the other side: the simulated foe never attacks, so the
      // event never happens. Magma Mia's flame cloak and Infused Tusk's
      // emergency shield are real in game and rightly worth zero here - but
      // "worth zero because the foe is passive" is a different sentence from
      // "no rate can be derived", and the report should say which.
      const gate = foeGating(s?.script);
      const defenceGated = !!gate && !gate.mixed;
      const mixedHooks = !!gate && gate.mixed;
      // ...and a defensive payload is the same sentence again. A shield that
      // absorbs damage nothing deals is worth zero for the same reason a block
      // proc is, and "its payload is a status that declares nothing readable"
      // was simply wrong about it: Halos_Demon_Passive's absorb is 0.7 x
      // Intellect, right there on the status's Refresh step.
      const shieldOnly = !gate && st.all.length > 0 && !st.dots.length
        && st.all.some((id2) => {
          const p2 = combat.profile(id2, rank, runes);
          return !!p2?.effects.some((e) => e.kind === 'Shield' && (e.baseVal || e.scaling.length));
        })
        && !st.all.some((id2) => {
          const p2 = combat.profile(id2, rank, runes);
          return !!p2?.effects.some((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length));
        });
      // The KIND a refused status is filed under has to be the refusal it got:
      // the list prints the kind's own sentence, and "the amount is computed
      // by a script from the hit that applied it" over a status the script
      // merely holds up behind a condition, or applies a count of, is the
      // false reason the per-row sentence was just corrected away from. A
      // refusal that names its kind keeps it (a switch, a guard this cannot
      // evaluate: `conditional`); a refused third argument is filed by what
      // the argument was (`refusal`).
      const kind = st.unreadable.length
        ? (st.unreadable[0].kind
          ?? (st.unreadable[0].refusal === 'condition' ? 'conditional'
            : st.unreadable[0].refusal === 'count' ? 'stack count' : 'script magnitude'))
        : (prof.costs.length || feedsResource || runeFeedsResource) ? 'resource'
          : mixedHooks ? 'half of it fires'
          : shieldOnly ? 'foe is passive'
          : defenceGated ? 'foe is passive'
            : noTick.length ? 'no rate'
            : isUtility ? 'utility'
              : runeDesc ? 'rune'
                : ccOnly ? 'crowd control'
                  : st.onTarget.length ? 'debuff'
                    : st.all.length ? 'status'
                      : prof.hasScript ? 'script'
                        : 'nothing declared';
      // A status this skill applies that carries a ONE-SHOT payload - a Shield,
      // a lump Heal, a single Damage hit with no loop - is the commonest case
      // here and it is not a script gap at all: the amount is in ordinary
      // columns, it just has no schedule, so nothing in this model knows when
      // it lands. Saying "it lives in its hscript body" about those was
      // factually wrong on 38 rows and pointed the reader at the wrong problem.
      const oneShot = [];
      for (const id2 of statusIdsOf(id, { runes, rank, talents })) {
        const sp = combat.profile(id2, rank, runes);
        if (sp && !sp.periodic && sp.effects.some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind)
          && (e.baseVal || e.scaling.length))) oneShot.push(skills.get(id2)?.texts?.name ?? id2);
      }

      let why;
      // `blanket`: the sentence claims nothing of the row was read. A later
      // pass that does read its mechanism withdraws exactly that sentence and
      // no other.
      let blanket = false;
      if (runePromises.length) {
        const one = runePromises.find((r) => r.slotted) ?? runePromises[0];
        why = (one.slotted ? `you slotted ${one.name}` : `${one.name} is on offer here`)
          + `, and it declares only a description - "${one.desc}"`
          + (runePromises.length > 1 ? ` (and ${runePromises.length - 1} more like it)` : '');
      } else if (st.unreadable.length) {
        why = st.unreadable[0].why;
      } else if (mixedHooks) {
        // NOT a floor, and the hooks are NAMED rather than characterised.
        // This reader does not read their GUARDS: `Shell of the Devourer`
        // guards `onInflictHit` on `isFinalCombo && isFirstHit`, so it fires
        // on the combo finisher and not on every hit, and guards
        // `onInflictDamage` on `dmg.skillId == ..._StatusBlockBuffed`, so that
        // one fires only AFTER a block and pays a cooldown reduction rather
        // than damage. Saying which hooks are DECLARED is all this can honestly
        // do.
        //
        // And the zero itself is right here: the one DAMAGE step in the whole
        // chain hangs off that same block-applied status, so the half that does
        // fire fills a bucket only a block empties. What the old sentence got
        // wrong is its REASON, not its number - which is why this one claims no
        // floor. The row that proves the
        // difference: its `onInflictHit` really does fire here, on every combo
        // finisher, and really does stack Water Infusion - but the only DAMAGE
        // step in its chain hangs off `Shield_OrbitWater_P_StatusBlockBuffed`,
        // which a block and nothing else applies, and its `onInflictDamage` is
        // itself gated on that same status. So the half that fires fills a
        // bucket only a block empties, and the total really is zero. What is
        // wrong with the old sentence is its REASON, not its number - and a
        // sentence promising a floor would have been wrong in the flattering
        // direction on the one row this kind currently reaches.
        why = `its script declares ${gate.off.join(' and ')} alongside ${gate.def.join(' and ')} - hooks on `
                        + 'damage you DEAL, not only on damage you take - so "the foe is passive" is not the '
                        + 'whole reason this is worth zero here. What those hooks are guarded on, and where '
                        + 'their payload lands, is further than this reader follows';
      } else if (defenceGated) {
        why = 'it fires when you block or when you are hit, and the simulated foe never attacks - '
          + 'real in game, correctly worth zero here, and the zero is a statement about the fight '
          + 'model rather than about the data';
      } else if (shieldOnly) {
        why = `its whole payload is an absorb shield (${st.all.join(', ')}), and a shield is worth `
          + 'exactly zero against a foe that never attacks - the magnitude IS in the data, so this '
          + 'is the fight model refusing it rather than the reader failing to find it';
      } else if (noTick.length) {
        why = `applies ${noTick.map((x) => x.name).join(', ')}, which statusType flags as a `
          + `${noTick[0].types.join('/')} - so it ticks - but no step on it carries a loop.tick, `
          + 'so the schedule the game gives it is not in the row';
      } else if (ccOnly) {
        why = `applies ${st.flaggedCC.map((x) => x.name).join(', ')}, which is crowd control - `
          + 'worth nothing here because the simulated foe does not act';
      } else if (oneShot.length) {
        why = `applies ${oneShot.join(', ')}, whose amount is in the data but whose timing is not - it has no schedule this model can put it on`;
      } else if (st.onTarget.length) {
        why = `applies ${st.onTarget.map((x) => x.name).join(', ')} to the target, and a debuff's worth needs the fight simulated`;
      } else if (prof.hasScript && startsDamage(id, rank, runes).length) {
        // Its damage is in ANOTHER ROW its script starts - Power of the Tides
        // erupts each Tidal Totem through Halos_Totem_Passive_Aoe. That is
        // more than "it lives in its script": the row is named, with what the
        // script says about how many it starts and from which hook.
        const st0 = startsDamage(id, rank, runes)[0];
        why = `its damage is in another row: its script starts ${st0.row}`
          + ` from ${st0.hook ?? 'top-level code'}, ${st0.count} - so the damage ${st0.row} carries has no `
          + 'clock in this fight';
      } else if (prof.hasScript) {
        blanket = true;
        why = 'everything it does lives in its hscript body, which this model does not execute';
      } else if (st.all.length) {
        why = `applies ${st.all.join(', ')}, which declares nothing this model can read at rank ${rank}`;
      } else if (prof.effects.length) {
        why = 'its only effects are GainAtb or Status rows with no readable payload';
      } else {
        why = 'declares no effect, no affix and no status this model can read';
      }
      unmodelled.push({ id, name: prof.name, source: extra.source, why, kind, runePromises, ...(blanket ? { blanket } : {}) });
    }

    // 4b. Passives a skill only grants ONCE IT HAS THE RANK.
    //
    // `props.rankPassives` is a rank gate like every other one in this sheet,
    // and it was the only one nothing read. Two rows carry it and both are on
    // player weapons, at minRank 3 - which is the rank `--rank` defaults to, so
    // the character always has them and the model never knew they existed:
    //
    //   DA_Water_Combo             -> DA_Water_Combo_PassiveRank3
    //   Crescent_FlowerSpiral_Skill_1 -> ..._Charge
    //
    // Neither turns out to be scoreable - one fires off a max-stacked status on
    // a base-attack roll, the other is a stack counter its own skill consumes -
    // so what this buys is not damage but honesty: they are now NAMED in the
    // coverage report instead of being absent from it.
    const prof0 = (id) => skills.get(id)?.texts?.name ?? id;
    for (const id of [...seen]) {
      const s = skills.get(id);
      for (const row of s?.props?.rankPassives ?? []) {
        if (row.minRank != null && rank < row.minRank) continue;
        if (row.maxRank != null && rank > row.maxRank) continue;
        for (const p of row.passives ?? []) {
          if (p.ref) pushTriggered(p.ref, `${prof0(id)} @rank ${row.minRank ?? rank}`);
        }
      }
    }

    // 5. Talents. Their stat affixes and self-buffs are applied by engine.mjs
    // straight off `talents.readableValue`, so only what ticks is collected
    // here - counting them in both places would double them. This is how
    // Rogue_Talent_LethalPoison's poison gets its real applier: the talent
    // itself puts it up (through its dose gate since build 25782799; on a
    // base-attack roll before), and without this pass the only applier the
    // model saw was whichever other node named the status.
    //
    // AT THE TALENT'S OWN RANK. `rank` in this function is the WEAPON mastery
    // rank - 1 to 3, two upgrades per weapon skill - and a talent's rank is the
    // points in that node, 1 or 2. They are disjoint systems: rank gates appear
    // only on WeaponSkill / AttackCombo / WeaponPassive / Talent rows and runes
    // only on ClassSkill / SignatureSkill rows, with no row carrying both. So
    // resolving a talent at the weapon's rank asks a two-point node whether it
    // is at rank 3, and every `minRank: 2` rider on it passes for free.
    for (const [id, nodeRank] of Object.entries(loadout.talents ?? {})) {
      const tst = statusesOf(id, { runes, rank: nodeRank, talents, talentRanks });
      noteDots(id, tst, { source: 'talent' });
      const nodeName = skills.get(id)?.texts?.name ?? id;
      // A node whose status only weakens what the TARGET deals is read and is
      // worth nothing here for a reason a player can check - so it is named,
      // not left blank beside a point they spent.
      for (const u of tst.unreadable ?? []) {
        if (u.kind !== 'foe is passive') continue;
        unmodelled.push({ id, name: nodeName, source: 'talent', kind: 'foe is passive', why: `${u.name}: ${u.why}` });
      }
      // A heal step the talent reader prices as a share of ONE NAMED ROW's
      // hits (`talentModifiers`: healShare on one skill - Soothing Rays) is
      // paid on that row's line, hit for hit. The step is then not "played
      // from onInflictDamage with no event this fight raises": the event is
      // that row dealing damage, and the fight raises it.
      for (const mod of talentModifiers(id, nodeRank)) {
        if (mod.field === 'healShare' && mod.scope === 'one-skill' && mod.step) accountedLate.add(`${id}#${mod.step}`);
      }
      // "STRIKE AGAIN" - a replay of the skill that applied a status:
      //   onInflictStatusEval(s) { if (s.fromSkill == null) return;
      //     if (s.fromSkill.isBasicAttack()) { if (s.status.kind == Skill.S) {
      //       if (checkProba(vars.chance)) { ... playStepIndexOnSkill(dmgStep, s.fromSkill, s.target) ...
      // Opportunity Strike. The guard is readable; what cannot be read is
      // whether it is ever true on this build. The hook's one visible raise
      // site is GameObject.addStacks@4637 (ops 23-129), which hands it the
      // skill the status was applied FROM - and Lethal Poison is applied by
      // the talent's own script (SkillScript.addStatus@6879 defaults fromSkill
      // to the calling skill) and refreshed by Envenom through
      // Status.refresh@15820. Both that refresh and GameObject.addStatus@4636
      // are server-only stubs on this client, so whether either re-raises the
      // hook with the basic attack as its source is not on this machine.
      //
      // So the read stops at "cannot tell", and THE CAPTURE DECIDES. Measured
      // 2026-10-13 on the dummy with the point held (the Rogue's span from
      // the snapshot that first holds it): 381 basic-attack damage rows, 187
      // of them carrying an Envenom row - the refresh the guard would have
      // to see through - and not one swing with a second row of itself on
      // that target inside 400 ms; nor in the 3,955 basic rows before the
      // point. At the row's chance that is 56 replays that are not there.
      // The sentence used to end "not scored, and not ruled out. In game: 200
      // basic attacks on a dummy ..." - asking for the measurement the audit
      // two files over recorded as made. It is scored ZERO on that evidence
      // and filed with what is read and worth nothing in the build, with the
      // rows; the guard is still said, because a row that applies the status
      // FROM a basic attack would open it and no capture has seen one.
      {
        const hb = hookBody(liveScript(skills.get(id)?.script ?? ''), 'onInflictStatusEval');
        const m = /(\w+)\.fromSkill\.(?:isBasicAttack|isBaseAttack)\s*\(\s*\)[\s\S]*?\1\.status\.kind\s*==\s*(?:Skill\.)?(\w+)[\s\S]*?checkProba\s*\(\s*vars\.(\w+)\s*\)[\s\S]*?playStepIndexOnSkill\s*\(/.exec(hb);
        const chance = m ? combat.profile(id, nodeRank, runes)?.vars?.[m[3]] : null;
        if (m && skills.has(m[2]) && typeof chance === 'number') {
          const sn = skills.get(m[2]).texts?.name ?? m[2];
          const held = REPLAY_ROWS[id] ?? null;
          unmodelled.push({
            id, name: nodeName, source: 'talent', kind: held ? 'off in this build' : 'conditional',
            why: `${nodeName} replays a basic attack's damage step ${Math.round(chance * 100)}% of the time when that attack `
              + `is the skill ${sn} was applied FROM. In this build ${sn} is applied by a talent's own script and `
              + 'refreshed by another, never from a basic attack, and whether the server hands the hook one anyway '
              + 'is in code this client does not ship'
              + (held
                ? ` - so the capture decides. MEASURED ${held.date} with the point held: ${held.carriers} of ${held.swings} basic `
                  + `hits carried the refresh, and not one swing landed twice where ${Math.round(chance * 100)}% of them would be `
                  + `${Math.round(chance * held.carriers)}. Scored zero on that; it would take a row that applies ${sn} from a `
                  + 'basic attack to open the guard'
                : ` - so it is not scored, and not ruled out. In game: 200 basic attacks on a dummy with ${sn} up; any `
                  + 'swing that lands twice is this talent'),
          });
        }
      }
      // A talent-applied STATUS can carry a script of its own, and that script
      // can play damage steps on events the fight raises. Sunlight's status
      // deals 0.6x Faith on every combo finisher while it is worn; Purging
      // Strikes' status deals 0.15x Faith on every swing and finisher. Both
      // fell through every bucket without a word - not a dot (no tick), not a
      // buff (no affix) - which made them the one place the model still
      // dropped damage silently. `profileOf` runs the status through the same
      // scripted-rider reader every skill gets, and parks what it finds for
      // the rider pass below. WHEN the status is worn is read just below,
      // off the applier's own site; where that site is not one this
      // recognises, the old assumption stands - the status is up when the
      // event lands.
      for (const stId of statusIdsOf(id, { runes, rank: nodeRank, talents, talentRanks })) {
        profileOf(stId, nodeRank);
      }
      // ...and WHEN it is worn, which "the status is up when the event lands"
      // got wrong for the two rows it was written about. Sunlight is put on
      // an ally a skill of yours lands on (`onInflictHit`: `validSkill &&
      // hit.target.isAlly(owner)`), lasts six seconds, and is SPENT by the
      // first finisher unless Solar Devotion is held; Purging Strikes' status
      // is put up only when your own Sunlight deals damage. Priced as always
      // worn, every finisher paid Sunlight and every swing paid Purging
      // Strikes - as if every Priest held Solar Devotion and never stopped
      // healing - and the capture says otherwise: 59% of Sunlight's endings
      // on other players are a consume. The window is read off the applier's
      // own site; a site this does not recognise keeps the old reading.
      //
      // WHICH presses land on an ally is the hook's own question: it is
      // onInflictHit, and a HIT is what raises it - not a status a script
      // hands the owner, and not a status's own steps (`landsOnCaster`). In
      // a fight with no party the one ally is you, so the window opens on a
      // skill whose hit lands on its own caster.
      for (const ap of statusesOf(id, { runes, rank: nodeRank, talents, talentRanks }).applied ?? []) {
        const sp = combat.profile(ap.status, nodeRank, runes);
        if (!sp?.swingPlay || !(sp.duration > 0)) continue;
        const tb = liveScript(skills.get(id)?.script ?? '');
        const at = ap.site?.route === 'script' ? null
          : ap.site?.stepId ? new RegExp('\\bplayStep\\s*\\(\\s*Steps\\.' + ap.site.stepId + '\\b').exec(tb) : null;
        const scope = ap.site?.route === 'script' ? (ap.site.scope ?? '') : at ? enclosingBlock(tb.slice(0, at.index)) : '';
        const fromStatus = /\bskillId\s*==\s*Skill\.(\w+)/.exec(scope)?.[1] ?? null;
        const opensOn = /\.isAlly\s*\(\s*owner\s*\)/.test(scope) ? { allyHit: true }
          : fromStatus && skills.get(fromStatus)?.props?.status ? { firesOf: fromStatus } : null;
        if (!opensOn) continue;
        const kept = sp.swingPlay.keptBy && heldTalents(loadout).has(sp.swingPlay.keptBy);
        // The skill that keeps it is PRICED by that: it is what takes the
        // one-swing count off the window. Held through a sigil it also comes
        // through the granted-skill pass, which finds no effect, no affix
        // and no status on the row and would file it under "nothing
        // declared" beside the line that says it is why Sunlight is not
        // spent.
        if (kept) accountedLate.add(sp.swingPlay.keptBy);
        statusWindows.set(ap.status, {
          opensOn, duration: sp.duration,
          ...(sp.swingPlay.consumesWhole && !kept ? { charges: 1 } : {}),
          said: (opensOn.allyHit ? 'worn only after a hit of one of your skills lands on you (the one ally of a fight with no party)'
            : `worn only after ${skills.get(fromStatus)?.texts?.name ?? fromStatus} deals damage`)
            + `, for ${sp.duration}s`
            + (sp.swingPlay.consumesWhole
              ? (kept ? ` - and not spent, because ${skills.get(sp.swingPlay.keptBy)?.texts?.name ?? sp.swingPlay.keptBy} is held`
                : ` - and spent by the first swing that plays it${sp.swingPlay.keptBy ? ` (${skills.get(sp.swingPlay.keptBy)?.texts?.name ?? sp.swingPlay.keptBy} would keep it)` : ''}`)
              : ''),
        });
      }
      // ...and a talent that carries a damage step of its OWN, played on an
      // event rather than cast. `Cracking Blood` has one step - 0.15x Faith +
      // 0.15x Intellect of Magic - and its script plays it on a 35% roll every
      // time a bleed ticks. It went through no bucket at all: the talent pass
      // collected only what ticks, so a node the tree printed as "effect" was
      // worth exactly zero in the fight it was printed beside.
      //
      // Only where the rule is one the fight raises. A talent is not cast, so a
      // roll with no event named has no rate and stays unscored.
      // A talent that GRANTS A SKILL carries its payload one row over, in
      // `props.subskills` - the same column the weapon follow-ups use, and the
      // same one `bench talents` already follows to print "grants a skill".
      // This pass did not, so `bench optimize` filed two Mage conduit talents
      // under "no effect, no affix and no status anywhere in the row" while
      // `bench talents` printed a damage effect for them on the same build.
      // Two readers of the same data disagreeing in one tool is worse than
      // either answer.
      for (const x of skills.get(id)?.props?.subskills ?? []) {
        if (!x.skill) continue;
        // ...unless what it grants is a MECHANIC skill, in which case the node
        // does not hand you the row - it hands you the OPTION. Taking
        // Mage_Talent_ConduitSparkExplosion adds "Conduit: Spark Explosion" to
        // the conduits you may slot against the same three Mage_Conduit_Levels
        // slots; it does not give you a fourth conduit. `pools` puts it in the
        // pool, the loop at 2 fires it if this build actually slotted it, and
        // granting it here as well was worth a free ~1000 damage to any Mage
        // who took the node and never chose the conduit.
        //
        // `seen` would not have caught this: the unslotted case never reaches
        // `seen` at all, which is exactly the case that was wrong. Same guard
        // the class-skill pass at 3 already uses - handled by its pool.
        if (mechanicOptions.has(x.skill)) { accountedLate.add(id); continue; }
        pushTriggered(x.skill, 'talent', { grantedBy: id });
        // The NODE is not the gap; the row it grants is, and that row now says
        // so under its own name. Printing both makes one talent appear twice
        // under two different causes, one of which ("declares nothing") is
        // false of a node whose whole job is to grant something.
        accountedLate.add(id);
      }
      // A talent's damage step is very often an `on: Code` one - the node has no
      // cast, so a step it plays HAS to come from its script - and `profileOf`
      // parks those for the rider pass below with the guard already read.
      const tp = profileOf(id, nodeRank);
      if (!tp) continue;
      if (!tp.effects.some((x) => ['Damage', 'Heal', 'Shield'].includes(x.kind)
        && (x.baseVal || x.scaling.length))) continue;
      const rule = triggerRule(id, tp, {}, { rank, runes, talents });
      if (rule?.kind !== 'per-dot-tick') continue;
      triggered.push({ prof: tp, source: 'talent', rule });
    }

    // A skill that IS the mechanism behind a trigger rule the model applied is
    // modelled, even though nothing scores it directly. The same goes for the
    // passives that generate a resource the fight now spends: `Warrior_Rage`
    // emits no damage and `Warrior_InfiniteRage` emits none either, but between
    // them they are the cast rate of `Warrior_Rage_Strike`. Listing them as
    // things the model failed to score, while the model is visibly using them,
    // is the output contradicting itself.
    const accounted = new Set([
      ...triggered.flatMap((t) => t.rule.accountsFor ?? []),
      ...gains.filter((g) => tracked.has(g.atb)).map((g) => g.from),
      // `Mage_SparkMaster` is the Spark SPEND hook, and the model spends Spark:
      // getSparkCost@9623 is read, the costs are attached to every weapon skill
      // above, and the fight gates casts on the pool. Listing the mechanism as
      // a skill nobody modelled, while the model is visibly using it, is the
      // output contradicting itself - the same rule that already accounts for
      // Priest_Rosary and Warrior_Rage.
      ...(tracked.has('Spark') ? ['Mage_SparkMaster'] : []),
      // ...and a class passive that is nothing but one more slot of a
      // mechanic pool, where the slot is in the build (`slotOpeners`).
      ...slotOpeners(loadout).map((o) => o.id),
    ]);

    // A status whose applier has no cast rate and whose script guard names an
    // event this fight does not produce can never land. Saying so beats leaving
    // it in the list looking scored. (`Sword_Swarm_Passive_Poison` was the
    // example - applied by the swarm's own ticks hurting something - until the
    // fight learned that event: `tick-of`, in `canFire` below.)
    const castable = new Set([...active, ...filler].map((x) => x.prof.id));
    // A talent is not cast, so a talent whose script applies a status "on cast"
    // has no event either - only its event-guarded siblings do.
    //
    // A POOL dot is the exception, and it is not a loophole: it does not need a
    // cast rate because it is not applied on a schedule at all. It takes a
    // share of damage the fight is already computing, so its total is known
    // even though nothing "casts" it. Hemorrhage is a talent that fires off
    // every physical critical strike; asking it for a cast rate is asking the
    // wrong question.
    //
    // The three named events are answered the same way - by whether the
    // fight produces them. Another skill's cast needs that skill in the
    // rotation; another status's application needs that status applied; and a
    // dose gate needs enough of its categories to be skills this build
    // presses that LAND A HIT OF THEIR OWN (the dose hook is raised by the
    // hit), which is what `doseReach` counts.
    const landsHit = (prof) => prof?.isStatusTick !== true
      && (prof?.effects ?? []).some((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length));
    const doseReach = (gate) => gate.categories.filter((c) => (c.on === 'combo'
      ? filler.some((x) => x.prof.isCombo && landsHit(x.prof))
      : active.some((a) => !a.via && landsHit(a.prof) && (c.on === 'weapon-skill'
        ? (a.prof.type === 'WeaponSkill' || a.prof.type === 'WeaponSubSkill')
        : c.on === 'class-skill' ? a.prof.type === 'ClassSkill'
          : a.prof.type === 'SignatureSkill'))));
    const canFire = (d) => !!d.pool || (d.on === 'cast' ? castable.has(d.from)
      : d.on === 'cast-of' ? castable.has(d.castOf)
        : d.on === 'dose-gate' ? doseReach(d.gate).length >= d.gate.need
          : d.on === 'apply-of' ? dots.some((x) => x.status === d.applyOf && x.on !== 'apply-of' && canFire(x))
            // ...the hits of another status: only where the build puts that one up.
            : d.on === 'tick-of' ? dots.some((x) => x.status === d.tickOf && x.on !== 'tick-of' && canFire(x))
              : true);

    // --- steps the cast does not play, on the clock the script gives them ----
    //
    // See `scriptedRiders`. This is where Brutal Frenzy's script-played step,
    // which the audit called "billed per finisher, not as its 15%-per-attack
    // rider", stops being an assumption: the step is out of the cast, the
    // guard in front of its playStep is read, and the rider goes on the clock
    // that guard names at the chance beside it (the base-attack clock at 15%
    // when that was written; the finisher's at 25% on build 25782799).
    for (const r of pendingRiders) {
      if (r.refusal) {
        // The HOST's own refusal is the better sentence when there is one:
        // "it fires when you block and the simulated foe never attacks" says
        // more than "one of its steps has no rate", and printing both makes the
        // same skill appear twice under two different causes.
        if (unmodelled.some((u) => u.id === r.host)) continue;
        unmodelled.push({
          id: `${r.host}#${r.refusal.step ?? 'step'}`, name: r.prof.name,
          kind: r.refusal.kind ?? 'no rate', why: r.refusal.why,
        });
        continue;
      }
      const worn = statusWindows.get(r.host);
      const rule = worn
        ? { ...r.rule, window: { from: r.host, opensOn: worn.opensOn, duration: worn.duration, ...(worn.charges ? { charges: worn.charges } : {}) },
          why: `${r.rule.why} - ${worn.said}` }
        : r.rule;
      triggered.push({ prof: riderProf(r.prof, r.step, rule), source: 'scripted', rule });
      accountedLate.add(r.host);
    }

    // Income is the same rule. A gain whose guard names no event is "when this
    // skill goes off", which is a rate only if the fight casts that skill -
    // `Warrior_Charge` with Juggernaut pays 5 Rage per CHARGE, and a talent is
    // never cast at all, so `Warrior_Talent_SeasonedSoldier`'s Rage-on-physical-
    // crit is not something this reader can put on a clock.
    for (let i = gains.length - 1; i >= 0; i--) {
      const g = gains[i];
      const evs = Array.isArray(g.on) ? g.on : [g.on];
      if (g.on === 'time' || evs.some((e) => e !== 'cast')) continue;
      if (castable.has(g.from)) continue;
      gains.splice(i, 1);
      unmodelled.push({
        id: g.from, name: g.fromName, kind: 'resource',
        why: `it generates ${g.amount} ${g.atb}, but only on a condition this reader cannot `
          + 'price - nothing gives it an event the fight produces',
      });
    }
    const byStatus = new Map();
    for (const d of dots) {
      const held = byStatus.get(d.status);
      // Prefer an applier the fight can actually fire; between two that can,
      // prefer the one that fires more often - an event beats a cooldown.
      if (!held || (canFire(d) && !canFire(held))
        || (canFire(d) && canFire(held) && held.on === 'cast' && d.on !== 'cast')) {
        byStatus.set(d.status, d);
      }
    }
    // ONE status, EVERY applier. Collapsing to a single applier starved every
    // multi-source dot. The case this was measured on was the accepted build's
    // Lethal Poison - fed by the talent (20% per swing or finisher), Envenom
    // and Venom Infusion at once, pinned at its stack cap in game while the
    // model, applying from one channel, averaged a stack and a half of six.
    // That poison is a one-stack gated status now; the shape lives on in Gash
    // (the passive's roll per attack and weapon skill, Shiv's own hit).
    // The losers' channels ride the winner as co-appliers: same status
    // instance, same tally, more application events.
    for (const d of dots) {
      const held = byStatus.get(d.status);
      if (!held) continue;
      // The count-scaled companion rider belongs to the STATUS, not to
      // whichever applier won the selection - the hook keys on dmg.skillId ==
      // the status and fires whoever applied the instance. Gash is applied by
      // Skill2 in this build while the hook lives on the weapon PASSIVE's
      // script, so the winner inherits it from any losing copy.
      if (d.perOtherStatus && !held.perOtherStatus) held.perOtherStatus = d.perOtherStatus;
      if (held === d || !canFire(d) || d.on === 'cast') continue;
      // Only the four event clocks can ride another applier as a channel; a
      // gate or a named cast is the status's own schedule or it is nothing.
      if (d.on === 'dose-gate' || d.on === 'cast-of' || d.on === 'apply-of' || d.on === 'tick-of') continue;
      const co = (held.coAppliers ??= []);
      if (co.some((c) => c.on === d.on && c.from === d.from)) continue;
      co.push({ on: d.on, chance: d.chance ?? 1, from: d.from, why: d.why ?? null });
    }
    // The count-scaled companion hook can live on a skill that never APPLIES
    // the status at all: Gash is applied by Skill2 in this build while the
    // hook - dmgMult += count-of-other-own-statuses x vars.x, keyed on
    // dmg.skillId == the status - sits on the weapon Passive's script. So the
    // hook is searched for across every skill the plan processed, not just
    // the appliers.
    {
      const hosts = [...active, ...filler, ...passive].map((x) => x.prof.id);
      for (const d of byStatus.values()) {
        if (d.perOtherStatus) continue;
        for (const hid of hosts) {
          const hs = skills.get(hid);
          if (!hs?.script) continue;
          const ap = liveScript(hs.script);
          const mm = new RegExp('skillId\\s*==\\s*Skill\\.' + d.status
            + '\\b([\\s\\S]{0,600}?)dmgMult\\s*\\+=\\s*(\\w+)\\s*\\*\\s*vars\\.(\\w+)').exec(ap);
          if (!mm || !/for\s*\(\s*\w+\s+in\s+\w+\.target\.statuses\s*\)/.test(mm[1])) continue;
          const gate = /rank\s*>=\s*(\d+)/.exec(mm[1]);
          if (gate && rank < Number(gate[1])) continue;
          let v = hs.vars?.[mm[3]];
          for (const ov of (hs.props?.rankOverride ?? [])) {
            if ((ov.minRank ?? 0) <= rank && ov.vars?.[mm[3]] != null) v = ov.vars[mm[3]];
          }
          if (typeof v === 'number' && v > 0) { d.perOtherStatus = v; break; }
        }
      }
    }
    const liveDots = [];
    for (const d of byStatus.values()) {
      if (canFire(d)) {
        // A DoT whose ticks scale with a stack count the data never caps. It is
        // scored at one stack, which is the floor rather than the truth, and
        // saying so beats printing a number that grows with the fight length.
        if (d.uncappedStacks) {
          unmodelled.push({
            id: d.status, name: d.name, source: d.source, kind: 'no rate',
            why: `${d.name} ticks are multiplied by its stack count (getStackFactor@21771) and its `
              + 'maxStacks is the authored -1, i.e. uncapped - so how many stacks a fight reaches is '
              + 'the fight length, not the data. Scored at one stack, which is a floor',
          });
        }
        liveDots.push(d);
        continue;
      }
      // A gate this build cannot fill, a skill it does not press, a status it
      // never applies: each is read, and each is a fact about the BUILD - so
      // it says which, rather than "nothing gives it a rate".
      if (d.on === 'dose-gate' || d.on === 'cast-of' || d.on === 'apply-of' || d.on === 'tick-of') {
        const reach = d.on === 'dose-gate' ? doseReach(d.gate) : [];
        unmodelled.push({
          id: d.status, name: d.name, source: d.source, kind: 'off in this build',
          why: d.on === 'dose-gate'
            ? `${d.fromName} applies it once ${d.gate.need} of its ${d.gate.categories.length} doses are on the target, `
              + `and this build can lay ${reach.length ? `only ${reach.length} (${reach.map((c) => c.label).join(', ')})` : 'none'} - `
              + `a dose needs a skill of its kind that lands a hit of its own (${d.gate.categories.map((c) => c.label).join(', ')})`
            : d.on === 'cast-of'
              ? `${d.fromName} applies it on ${skills.get(d.castOf)?.texts?.name ?? d.castOf}, which this build does not cast`
              : d.on === 'tick-of'
                ? `${d.fromName} applies it on the hits of ${skills.get(d.tickOf)?.texts?.name ?? d.tickOf}, `
                  + 'which nothing in this build puts up'
                : `${d.fromName} applies it each time ${skills.get(d.applyOf)?.texts?.name ?? d.applyOf} is applied, `
                  + 'and nothing in this build applies that',
        });
        continue;
      }
      // Same split as the trigger path: an applier that fires on a block or
      // on being hit is dead because the foe is passive, not because the
      // data withheld a rate.
      const gate = foeGating(skills.get(d.from)?.script);
      unmodelled.push({
        id: d.status,
        name: d.name,
        source: d.source,
        kind: !gate ? 'no rate' : gate.mixed ? 'half of it fires' : 'foe is passive',
        why: !gate
          ? `${d.fromName} applies it, but nothing gives ${d.from} a rate this model can price`
          : gate.mixed
            ? `${d.fromName} applies it from ${gate.off.join(' and ')}, which fire on every hit you `
              + `land, and from ${gate.def.join(' and ')}, which the simulated foe never triggers - `
              + 'so "the foe is passive" is only half the reason, and what the other half is worth '
              + 'depends on where its payload lands'
            : `${d.fromName} applies it on a block or on being hit, and the simulated foe never attacks`,
      });
    }

    // --- what rides a status's OWN hits, bound to the dots this fight plays ----
    //
    // `hitHooksOf` reads the shapes off each row; here they meet the build.
    // Every script the build OWNS is asked - the nodes it allocated at their
    // points, everything else at the weapon rank - and a shape whose status
    // this fight does not apply is bound to nothing, which is the right answer
    // for it: the hit it rides never happens.
    const dotOf = (statusId) => liveDots.find((d) => d.status === statusId && !d.pool) ?? null;
    const typesOf = (statusId) => (skills.get(statusId)?.props?.status?.types ?? []).map((t) => t.type);
    const dotRiders = [];
    let comboBank = null;
    // What was bound, for the lists that say what a node does in THIS build.
    const statusHooks = [];
    {
      const owned = new Map([...seen].map((id) => [id, rank]));
      for (const [tid, pts] of Object.entries(loadout.talents ?? {})) owned.set(tid, pts);
      const hooks = [...owned].flatMap(([hostId, hostRank]) => hitHooksOf(hostId, hostRank, runes)
        .map((h) => ({ ...h, from: hostId, fromName: skills.get(hostId)?.texts?.name ?? hostId })));
      const bound = (h, live) => statusHooks.push({ from: h.from, kind: h.kind, status: h.status ?? null, live });
      // The hit a rider names has to exist before the rider is read, and the
      // allocation is not held in tree order: the re-apply hits first.
      for (const h of hooks) {
        if (h.kind !== 'reapply') continue;
        const d = dotOf(h.status);
        const step = d ? (d.prof.scripted ?? []).find((x) => x.stepId === h.stepId) : null;
        if (!d || !step?.effects?.length) { bound(h, false); continue; }
        d.reapply = {
          stepId: h.stepId, from: h.from, critAdd: 0,
          prof: {
            ...d.prof, id: `${d.status}#${h.stepId}`, name: `${d.name} (direct)`, effects: step.effects,
            periodic: null, occupancy: 0, cooldown: 0, charges: 1, costs: [],
            isFiller: false, isCombo: false, scripted: [],
          },
          why: `${d.name}'s ${h.stepId} step: a direct hit of the status itself, played each time `
            + `${d.name} is applied to a target that already carries it (${h.fromName}'s onTryAddStatus) - `
            + 'so never on the first application',
        };
        // The step is on the fight's clock now; the status row's own "nothing
        // in the row says when" about it is no longer true.
        accountedLate.add(`${d.status}#${h.stepId}`);
        bound(h, true);
      }
      for (const h of hooks) {
        if (h.kind === 'reapply') continue;
        if (h.kind === 'step-rider') {
          const d = dotOf(h.status);
          const live = !!d?.reapply && d.reapply.stepId === h.stepId;
          if (live && h.field === 'critChance') d.reapply.critAdd += h.amount;
          else if (live) d.reapply.add = (d.reapply.add ?? 0) + h.amount;
          bound(h, live);
        } else if (h.kind === 'stack-rider') {
          const d = dotOf(h.status);
          // A counter fed by one step needs that step to be played.
          const live = !!d && (h.fedByStep == null || d.reapply?.stepId === h.fedByStep);
          if (live) {
            d.stackRider = {
              status: h.counter, name: h.counterName, per: h.per, cap: h.cap, duration: h.duration,
              fedByStep: h.fedByStep, from: h.from,
            };
          }
          bound(h, live);
        } else if (h.kind === 'cooldown') {
          const d = dotOf(h.status);
          if (d) (d.cooldownRiders ??= []).push({ chance: h.chance, seconds: h.seconds, from: h.from, name: h.fromName });
          bound(h, !!d);
        } else if (h.kind === 'per-typed') {
          // The count is of the statuses ON THE TARGET of the hit
          // (`dmg.target.getStatusesCount(...)`), whoever put them there, so
          // a status the owner wears is not one. The rider is handed on even
          // when this plan applies nothing of the type: the plan knows the
          // build's own statuses, and an attached set can put one more on
          // the foe (Hive Venom is typed Poison). `statuses` here is the
          // plan's own answer, and so is `live` below; the fight asks again
          // of the list it plays (damage.mjs `typedRot`), and a rider nothing
          // answers is said once that list is whole (engine.mjs).
          const typed = liveDots.filter((d) => d.to !== 'Self' && typeCovers(h.statusType, d.types));
          dotRiders.push({
            amount: h.amount, statusType: h.statusType, statuses: typed.map((d) => d.status),
            names: typed.map((d) => d.name), from: h.from, name: h.fromName,
          });
          bound(h, typed.length > 0);
        } else if (h.kind === 'combo-bank') {
          // The income is the dose gate's: what this build applies of that
          // type is its doses. No gate, no income; no finisher, no spend.
          const gateDot = liveDots.find((d) => d.gate
            && d.gate.categories.some((c) => typeCovers(h.feedType, typesOf(c.status))));
          const live = !!gateDot && filler.some((x) => x.prof.isCombo);
          if (live) {
            comboBank = {
              status: h.bank, name: h.bankName, per: h.per, cap: h.cap, from: h.from,
              feeds: gateDot.gate.categories.filter((c) => typeCovers(h.feedType, typesOf(c.status))).map((c) => c.status),
              feedName: gateDot.gate.markerName ?? 'dose',
            };
          }
          bound(h, live);
        } else if (h.kind === 'companion') {
          const d = liveDots.find((x) => x.status === h.status && x.gate);
          if (d) {
            (d.gate.companions ??= []).push({
              status: h.companion,
              withDoses: !!h.withType && d.gate.categories.some((c) => typeCovers(h.withType, typesOf(c.status))),
            });
          }
        }
      }
      // WHOSE HITS A CRIT-GRANTING STATUS REACHES: every status of the build
      // typed as one of the types its hook names, parents walked. (A status
      // an attached set puts on the foe is reached too, and is not in this
      // list: the fight adds it - damage.mjs `typedRot`.)
      for (const g of liveDots) {
        if (!g.grantsCrit || g.pool) continue;
        for (const d of liveDots) {
          if (d.pool || !g.grantsCrit.types.some((t) => typeCovers(t, d.types))) continue;
          (d.critFrom ??= []).push(g.status);
        }
      }
      // A PASSIVE WHOSE WHOLE SCRIPT WORKS ON ONE OTHER SKILL, in a build that
      // does not hold that skill. Zeal (Sunset and Dawn) banks a stack per
      // attack and, at the cap, has the finisher reset Zealous Spins's
      // cooldown and put up a status whose one line raises Zealous Spins's
      // damage. Slotted beside Iron Cyclone alone it is worth exactly
      // nothing - in game too - and it was printed as a pick and told
      // "everything it does lives in its hscript body, which this model does
      // not execute": true of the reader, and silent about the one thing a
      // player needs, that the slot is as good as empty in THIS build.
      //
      // Found by what the scripts name, never by an id: every castable skill
      // the row's script and the scripts of the statuses it names refer to
      // (`Skill.X`), less the row itself. One such skill, nothing else the
      // row could be worth (no step that deals or heals, no affix on it or
      // on those statuses), and the build without that skill: it is read,
      // and worth zero here. With the skill held the old sentence stands -
      // then it is a rider this model does not price.
      {
        const CASTABLE = new Set(['WeaponSkill', 'WeaponSubSkill', 'ClassSkill', 'SignatureSkill', 'AttackCombo', 'Attack', 'Attack2', 'Attack3', 'Attack4']);
        const named = (rowId) => [...liveScript(skills.get(rowId)?.script ?? '').matchAll(/\bSkill\.([A-Za-z0-9_]+)/g)].map((x) => x[1]);
        const bare = (rowId) => {
          const r = skills.get(rowId);
          return !(r?.affixes ?? []).length
            && !(r?.steps ?? []).some((x) => (x.effects ?? []).some((e) => (e.scaling ?? []).length || e.baseVal));
        };
        for (const u of unmodelled) {
          if (!u.blanket || !skills.get(u.id)?.script) continue;
          const own = named(u.id);
          const statuses = [...new Set(own)].filter((x) => skills.get(x)?.props?.status);
          const all = [...own, ...statuses.flatMap(named)].filter((x) => x !== u.id);
          const targets = [...new Set(all.filter((x) => CASTABLE.has(typeOf(x))))];
          if (targets.length !== 1 || seen.has(targets[0])) continue;
          if (!bare(u.id) || !statuses.every(bare)) continue;
          const x = targets[0];
          const xn = skills.get(x)?.texts?.name ?? x;
          const does = [
            new RegExp(`resetCooldown\\s*\\(\\s*Skill\\.${x}\\b`).test(liveScript(skills.get(u.id).script)) ? `its script resets ${xn}'s cooldown` : null,
            statuses.some((sid) => new RegExp(`skillId\\s*==\\s*Skill\\.${x}\\b[\\s\\S]*?dmgMult\\s*\\+=`).test(liveScript(skills.get(sid)?.script ?? '')))
              ? `a status it hands out raises ${xn}'s damage` : null,
          ].filter(Boolean);
          u.kind = 'off in this build';
          u.blanket = false;
          u.actsOn = x;
          u.why = `${u.name ?? u.id} works on ${xn} alone - ${does.length ? does.join(', and ') : `${xn} is the one skill its script names`} - `
            + `and this build does not hold ${xn}, so the slot it takes is worth what an empty one is. `
            + `With ${xn} beside it, it is a rider this model reads and does not price`;
        }
      }
      // TWO THINGS THAT WAIT ON A STATUS THIS FIGHT NEVER APPLIES, each under
      // the cause that is true of it. Both used to keep a sentence about the
      // READER ("nothing in the row says when", "a question about live state
      // this reader cannot answer") in builds where the reader had the answer
      // and the build was what was missing.
      //
      // A re-apply step: the status row's own script is empty, so the row's
      // rider reader files "played only from script, and nothing in the row
      // says when" - and the hook that plays it is read, off whichever row
      // carries it. When the status is live the step is on the fight's clock
      // (above); when it is not, the reason is the status, or the row that
      // would play the step.
      for (const u of unmodelled) {
        const m = /^(.+)#([A-Za-z0-9_]+)$/.exec(String(u.id ?? ''));
        if (!m || dotOf(m[1])) continue;
        const hosts = reapplyHostsOf(m[1], m[2]);
        if (!hosts.length) continue;
        const host = hosts.find((h) => owned.has(h)) ?? hosts[0];
        const sn = skills.get(m[1])?.texts?.name ?? m[1];
        const hn = `the ${skills.get(host)?.texts?.name ?? host}${typeOf(host) === 'Talent' ? ' talent' : ''}`;
        u.kind = 'off in this build';
        u.why = `${sn}'s ${m[2]} step is a direct hit played each time ${sn} is applied to a target that already `
          + `carries it (${hn}'s onTryAddStatus), and `
          + (owned.has(host) ? `this fight never applies ${sn}` : `this build does not hold ${hn}`);
      }
      // A rider gated on that status being on the target: the fight answers
      // the gate per event, and in a fight that never applies the status the
      // answer is no every time. Left in `triggered` it scored nothing and
      // said nothing.
      for (let i = triggered.length - 1; i >= 0; i--) {
        const ws = triggered[i].rule?.whileStatus;
        if (!ws || liveDots.some((d) => d.status === ws)) continue;
        const [t] = triggered.splice(i, 1);
        const wn = skills.get(ws)?.texts?.name ?? ws;
        const [, stepId] = /#([A-Za-z0-9_]+)$/.exec(t.prof.id) ?? [];
        unmodelled.push({
          id: t.prof.id, name: t.prof.name, kind: 'off in this build',
          why: `${t.prof.name}'s ${stepId ?? 'scripted'} step is played only while ${wn} is on the target, `
            + `and this fight never applies ${wn}`,
        });
      }
    }

    // --- summons, and the charge economy they feed ---------------------------
    //
    // Staff_SummonDemon_Skill2 is a SUMMONER: step type 23 with props.summon
    // {unit: Summon_Imp, count: 2}, duration 12 - and it sat in unmodelled as
    // "everything it does lives in its hscript body" while its imps swung
    // every ~3.2s for 0.2 x the OWNER's Intellect (live: 35.3 hits/min at
    // 41.7, the same law as the owner's own missiles to within 0.3%). Its
    // partner Skill1 is a CHARGE DUMP: one missile per banked charge (cap =
    // the Charge status's maxStacks, 20), fed +1 per pet hit (onProxyDamage -
    // see `petFed` below for the hook and what of it can still be read), +1
    // per vars.time seconds of combat at rank >= 2 (onRegUpdate), and 20% per
    // summon expiry - live 14.9 hits per press against the model's one. Both
    // are authored; the reader hands the fight the spec and the fight
    // schedules it.
    // WHERE a summon step lives. Three shapes exist in this data and only the
    // first was ever read as itself:
    //
    //   * CAST-HOSTED. The step is the summoner's own and runs at Start or
    //     CastEnd - the Silhouette of Almaz's imps, Tidal Totem's totem. The
    //     window opens when the skill is pressed, which is what `active` does.
    //   * STATUS-HOSTED. The step lives on a STATUS the skill applies, `on:
    //     Code`, played only by that status's own script. Pocket Hive is the
    //     shape: `Mad Buzz` rolls 20% per damage event to stack `Buzzing`, and
    //     `Buzzing`'s onStacksChange summons an Angry Bee at its tenth stack
    //     and then spends the lot.
    //   * SELF-HOSTED, SCRIPT-PLAYED. The step is the skill's own but `on:
    //     Code`, played by a proc in its own script - Eternal Flower Heart
    //     rolls 5% per weapon-skill cast.
    //
    // The second was refused whole. `carriesPayload` counts Damage, Heal and
    // Shield effects and a Summon step is none of those, so Mad Buzz fell
    // through to the "declares nothing readable" branch and was filed by
    // whatever its script mentioned. It mentions `onReceiveDamage`, so a
    // passive that is HALF offensive was reported as wholly defensive - "it
    // fires when you block or when you are hit, and the simulated foe never
    // attacks" - while its `onInflictDamage` half fires on every hit you land.
    // A whole weapon's gimmick sat behind a sentence that was true of one line
    // of its script.
    //
    // The third was worse than refused: it was priced as a CAST. A payload-less
    // Passive reclaimed into `active` is a skill the fight PRESSES, so Eternal
    // Flower Heart's bee opened its window on a press instead of on the roll
    // the script authors, and nothing in the report said which.
    const summons = [];
    const summonHostOf = (id) => {
      const stepOf = (sid) => (skills.get(sid)?.steps ?? []).find((x) => x.props?.summon?.unit);
      const own = stepOf(id);
      if (own) return { hostId: id, step: own };
      // The link from an applier to its counter lives in script text and
      // nowhere else - `addStatus(owner, Skill.GM_MassGrab_Passive_Status)` -
      // so it is read here the way every other status link in this file is,
      // aliases resolved first.
      const linked = new Set(statusIdsOf(id, { runes, rank, talents }));
      const body = liveScript(skills.get(id)?.script ?? '');
      const alias = new Map();
      SKILL_ALIAS.lastIndex = 0;
      for (let m; (m = SKILL_ALIAS.exec(body));) alias.set(m[1], m[2]);
      ADD_STATUS.lastIndex = 0;
      for (let m; (m = ADD_STATUS.exec(body));) {
        if (!SELF_TARGETS.has(m[1])) continue;
        linked.add(alias.get(m[2]) ?? m[2]);
      }
      for (const sid of linked) {
        const step = stepOf(sid);
        if (step) return { hostId: sid, step };
      }
      return null;
    };
    // WHEN the window opens. A step played by the cast keeps the behaviour the
    // Almaz established; a `Code` step is played by a script, and the script
    // says what pays for it. A shape neither of these reads is REFUSED rather
    // than guessed at - a summon priced on an invented rate is the flattering
    // direction, and this file does not take it.
    const summonTriggerOf = (id, hostId, step) => {
      if ((stepOnNames[step.on ?? -1] ?? '') !== 'Code') return { on: 'cast' };
      const hostRow = skills.get(hostId);
      const hostBody = liveScript(hostRow?.script ?? '');
      if (step.id && !new RegExp(`playStep\\s*\\(\\s*Steps\\.${step.id}\\b`).test(hostBody)) return null;
      // STACK-DRIVEN. The host is a counter status that summons at its cap and
      // then spends every stack; what feeds the counter is the APPLIER's roll.
      if (hostId !== id && /hasStatusMaxStacked/.test(hostBody)) {
        const stacks = maxStacksOf(hostId, rank);
        if (!Number.isFinite(stacks) || stacks < 2) return null;
        const body = liveScript(skills.get(id)?.script ?? '');
        if (!new RegExp(`addStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?${hostId}\\b`).test(body)) return null;
        const ch = /checkProba\s*\(\s*vars\.(\w+)\s*\)/.exec(body);
        const chance = ch ? (varsOf(id, rank, runes)[ch[1]] ?? 0) : 1;
        if (!(chance > 0)) return null;
        // WHICH events roll it. `onInflictDamage` is every damage instance you
        // deal, and the fight counts those; `onReceiveDamage` is one the
        // simulated foe never produces. Both hooks are NAMED so the rate can be
        // reported as the floor it is, instead of a hook set being mistaken for
        // its defensive half - which is exactly how this weapon came to be
        // worth zero.
        if (!/function\s+onInflictDamage\b/.test(body)) return null;
        // ...and a THIRD since build 25782799: `onProxyDamage`, the hook for
        // damage the owner's SUMMONS deal. Mad Buzz gained one whose body is
        // the same roll its onInflictDamage runs, and its text changed with it
        // ("When you or your [Summon]s deal damage ..."), so every bee bolt
        // rolls for the next bee. Read only when the two hooks run the SAME
        // statement - a proxy hook that does something else is not this feed.
        const sameBody = (a, b) => {
          const na = hookBody(body, a).replace(/\s+/g, ''), nb = hookBody(body, b).replace(/\s+/g, '');
          return na.length > 0 && na === nb;
        };
        return {
          on: 'damageEvent',
          chance,
          stacks,
          alsoOnReceive: /function\s+onReceiveDamage\b/.test(body),
          alsoOnProxy: sameBody('onProxyDamage', 'onInflictDamage'),
          // The counter REFRESHES on every application: `Buzzing` declares no
          // `props.status.stackingPolicy`, and absent is refresh - the same
          // reading the dot ledger takes. So a gap longer than the row's own
          // duration loses the WHOLE climb rather than one stack of it, and the
          // window is what the fight needs in order to price that.
          window: Number(hostRow?.duration) > 0 ? Number(hostRow.duration) : 0,
        };
      }
      // CAST-PROC-DRIVEN. The skill's own script rolls on a qualifying press.
      const m = /onUseSkill[\s\S]{0,240}?isWeaponSkill[\s\S]{0,240}?checkProba\s*\(\s*vars\.(\w+)\s*\)/.exec(hostBody);
      if (m) {
        const chance = varsOf(hostId, rank, runes)[m[1]] ?? 0;
        if (chance > 0) return { on: 'weaponSkillCast', chance };
      }
      return null;
    };
    const summonSpecOf = (id) => {
      const found = summonHostOf(id);
      if (!found) return null;
      const { hostId, step: st } = found;
      const trigger = summonTriggerOf(id, hostId, st);
      if (!trigger) return null;
      // Vars come off the HOST row, because the step's `duration` names one of
      // the host's - `Buzzing`'s "dur1" is 15 and lives on `Buzzing`.
      const row = skills.get(hostId);
      const unitId = st.props.summon.unit;
      const unitRow = cdb.byId('unit').get(unitId);
      const autoId = (unitRow?.skills ?? []).map((x) => x.skill ?? x.ref ?? x).find(Boolean);
      const auto = autoId ? profileOf(autoId) : null;
      if (!auto || !(auto.effects ?? []).some((e) => e.kind === 'Damage')) return null;
      // The pet's swing period from its own authored steps. Not every step is
      // clock: Visuals and the Projectile's flight overlap the action, so
      // summing EVERY delay+duration read the imp at 7.0s where the measured
      // cycle is 3.23s. The cycle the comment always described is the longest
      // action step's end plus the Wait recovery - FreeRotation 0.3+2.2 and
      // Wait 1.3 = 3.8 for the imp, against 3.23 measured (the recovery
      // overlaps partially live; the authored number stays, conservative).
      const petSteps = cdb.byId('skill').get(autoId)?.steps ?? [];
      const stepEnd = (x) => (Number(x.delay) > 0 ? Number(x.delay) : 0)
        + (Number(x.duration) > 0 ? Number(x.duration) : 0);
      const actionEnd = petSteps.reduce((m, x) => {
        const tn = stepTypeNames[x.type ?? -1] ?? '';
        return (tn === 'Visuals' || tn === 'Wait') ? m : Math.max(m, stepEnd(x));
      }, 0);
      const waits = petSteps.reduce((s2, x) => s2
        + ((stepTypeNames[x.type ?? -1] ?? '') === 'Wait' && Number(x.duration) > 0 ? Number(x.duration) : 0), 0);
      // ...and a pet cannot swing faster than its own row's COOLDOWN, nor
      // start the next cast before the current one's DURATION is out. The
      // Angry Bee's steps come to one second, its cooldown is 1 and its row
      // duration is 2, so the three disagree and the fight takes the slowest -
      // the AI loop that would settle it is not read, and the fast number is
      // the flattering direction. The imp is untouched by this: its 1.5-second
      // row sits well inside the 3.8 its steps author.
      const authored = (actionEnd + waits) || 3.8;
      const period = Math.max(
        authored,
        Number(auto.cooldown) > 0 ? Number(auto.cooldown) : 0,
        Number(auto.duration) > 0 ? Number(auto.duration) : 0,
      );
      // How long the pets LIVE is the SUMMON STEP's duration - the row's own
      // `duration` is the cast length. Reading the row first priced the
      // Silhouette of Almaz's imps at a 0.3-SECOND window per 20s cycle -
      // 1.1 pet hits per fight, a summoner priced at zero with a straight
      // face. Step duration, then the vars the scripts name, then the row.
      const dur = (Number(st.duration) > 0 ? Number(st.duration) : null)
        ?? (typeof st.duration === 'string' ? varsOf(hostId, rank, runes)[st.duration] : null)
        ?? varsOf(hostId, rank, runes).dur1
        ?? (Number(row.duration) || 12);
      // A COUNTER IS RARELY FED BY ONE THING, and reading only the applier's
      // own roll halved this bee. `Buzzing` also takes TWO stacks from every
      // Honey Crush - `GM_MassGrab_Combo`'s
      // `onFirstHit(hit) { addStatus(owner, Skill.GM_MassGrab_Passive_Status, 2); }`
      // with no rank gate and no roll in front of it, and the row's own
      // `vars.var1 = 2` printed in its tooltip as "generating 2 stacks". Two
      // feeds put the counter at its cap every 14 seconds where the roll alone
      // takes 26, so the weapon's own combo is half the gimmick. It is not a
      // Pocket Hive quirk either: the only other 10-stack, 10-second counter in
      // the sheet, `DM_Multispin_Passive_Status`, is fed by a hit hook and a
      // timer both.
      //
      // Only an UNGUARDED feed on a per-cast hook counts. A roll, a rank gate
      // or a status test in front of it is a rate this reader does not have,
      // and a feed on some other hook is a schedule it cannot name - both stay
      // uncounted, which leaves the summon rate a floor rather than a guess.
      if (trigger.on === 'damageEvent') {
        trigger.feeds = [];
        for (const e of [...active, ...filler, ...triggered]) {
          const fid = e.prof?.id;
          if (!fid || fid === id) continue;
          const fbody = liveScript(skills.get(fid)?.script ?? '');
          if (!fbody) continue;
          ADD_STATUS_3.lastIndex = 0;
          for (let m; (m = ADD_STATUS_3.exec(fbody));) {
            if (!SELF_TARGETS.has(m[1]) || m[2] !== hostId) continue;
            const fn = [...fbody.slice(0, m.index).matchAll(/function\s+(\w+)\s*\(/g)].pop()?.[1] ?? '';
            if (!/^(onFirstHit|onCast|onUseSkill|onStartCast)$/.test(fn)) continue;
            if (/checkProba|rank\s*>=|hasStatus/.test(enclosingBlock(fbody.slice(0, m.index)))) continue;
            const arg = m[3].trim();
            const n = Number(arg) || (varsOf(fid, rank, runes)[arg.replace(/^vars\./, '')] ?? 0);
            if (n > 0) {
              trigger.feeds.push({
                from: fid, amount: n, hook: fn,
                name: skills.get(fid)?.texts?.name ?? fid,
              });
            }
          }
        }
      }
      // The charge and crit riders are the SUMMONER's, not the host's. For a
      // cast-hosted summon the two are the same row, so this is the read it
      // always was.
      const body = liveScript(skills.get(id)?.script ?? '');
      // onSummonElapsed -> checkProba(vars.chance) -> a charge, per expiry.
      const el = /onSummonElapsed[\s\S]{0,160}?checkProba\s*\(\s*vars\.(\w+)\s*\)/.exec(body);
      // The summoner's own script can raise its PETS' crit: the Almaz reads
      // `onProxyDamageEval(hit) { if (hit.instigatorUnit?.kind ==
      // Unit.Summon_Imp) hit.critChance += vars.var2; }`. That guard is
      // unanswerable for the player's own casts - and it never sees them: on
      // build 25782799 a summon's hit is routed to its OWNER's scripts as
      // onProxyDamageEval and to nobody's onInflictDamageEval
      // (BaseSkill.evalDamage@6124 ops 9-13 `instigator != resolveProxy()`,
      // ops 14-70 the owner's skills and statuses through slot 29;
      // BaseSkill.onInflictDamageEval@6126 ops 5-16 pick slot 29 for a proxy and 17
      // otherwise). So a rider in that hook is the PET line's, and for a
      // guard naming this pet it is always true there.
      //
      // The pet is spelled `instigatorUnit` or `skill.ownerUnit` and NOT
      // `sourceUnit`: ScriptHitData.get_source@6294 resolves the proxy, so on
      // a pet's hit `hit.sourceUnit` is the hero. The accepted build's script
      // said `sourceUnit.kind == Unit.Summon_Imp` inside onInflictDamageEval;
      // that spelling can no longer hold and is no longer read.
      const proxyEval = hookBody(body, 'onProxyDamageEval');
      const pc = new RegExp('(?:instigatorUnit|skill\\??\\.ownerUnit)\\??\\.kind\\s*==\\s*(?:Unit\\.)?' + unitId
        + '\\b[\\s\\S]{0,80}?critChance\\s*\\+=\\s*vars\\.(\\w+)').exec(proxyEval);
      // Pocket Hive's rank-3 clause says summoning one more extends the ones
      // already out, and it is READ AND REFUSED rather than credited.
      // `extendSummonDuration@6916` scopes to one skill INSTANCE -
      // `BaseSkill.getSummons@6247` filters `f.summonSourceSkill == this` -
      // and `Buzzing` is consumed and removed on every cycle, so each climb
      // builds a brand-new Status. `GM_MassGrab_Passive_Status.onStacksChange@44767` calls the extend at
      // op37, synchronously, after a `playStep` deferred to the next frame:
      // this instance has summoned nothing yet, and the bees still in the air
      // carry the PREVIOUS instance as their `summonSourceSkill`. The set it
      // extends is empty. Crediting it stretched a 15-second bee to 16.75 and
      // the fight's dps with it, which is the flattering direction on a rider
      // the runtime does not appear to deliver. The capture would settle it -
      // lifetimes clustered at 15s confirm, 18s or more refute - and no
      // character in the modkit's dumps owns this weapon, so it stays refused
      // and named.
      return {
        from: id, host: hostId, unit: unitId, count: st.props.summon.count ?? 1,
        // A concurrent cap where the step declares one: Eternal Flower Heart's
        // summon step says `limit: 1`, so a second bee replaces the first
        // rather than doubling the line. Pocket Hive declares none.
        limit: Number(st.props.summon.limit) > 0 ? Number(st.props.summon.limit) : null,
        // `proxied`: this profile is a SUMMON's, and a summon's hit is not its
        // owner's - evalDamage@6124 ops 9-70 send it to the owner's
        // onProxyDamageEval and to nobody's onInflictDamageEval, so the
        // owner-wide riders above do not ride it.
        duration: dur, period, petProf: { ...auto, proxied: true }, trigger,
        // Nothing in this data extends a live pet in a way the runtime
        // delivers, so the field the fight reads is zero - see above. It stays
        // on the spec because the fight's arithmetic for it is general and the
        // next patch may author one that does.
        extend: 0,
        elapsedChargeChance: el ? (varsOf(id, rank, runes)[el[1]] ?? 0) : 0,
        petCritBonus: pc ? (varsOf(id, rank, runes)[pc[1]] ?? 0) : 0,
        // Pet riders READ AND REFUSED: a clause in the summoner's proxy hook
        // that pays only while the PET wears a status. Mad Buzz is the shape
        // - `dmg.dmgMult += vars.damage` for a bee carrying the status Brood
        // Leap's area puts on a bee standing in it (the same +50% that sat on
        // that status as a DamageModifier affix until this build). Where a
        // pet stands is a position the fight does not have, so nothing is
        // credited; the spec carries it so the refusal can say exactly what
        // it is refusing and who applies the status.
        petRiders: (() => {
          const m = new RegExp('(?:instigatorUnit|skill\\??\\.ownerUnit)\\??\\.kind\\s*==\\s*(?:Unit\\.)?' + unitId
            + '\\b[\\s\\S]{0,200}?hasStatus\\s*\\(\\s*(?:Skill\\.)?(\\w+)\\s*\\)[\\s\\S]{0,80}?'
            + '\\.(dmgMult|critDmgMult|critChance)\\s*\\+=\\s*vars\\.(\\w+)').exec(proxyEval);
          const amount = m ? combat.profile(id, rank, runes)?.vars?.[m[3]] : null;
          if (!m || !(typeof amount === 'number' && amount > 0)) return [];
          const appliers = [...active, ...filler, ...triggered].map((e) => e.via ?? e.prof?.id).filter(Boolean)
            .filter((sid, i, all) => all.indexOf(sid) === i
              && new RegExp('addStatus\\s*\\(\\s*\\w+\\.target\\s*,\\s*(?:Skill\\.)?' + m[1] + '\\b')
                .test(liveScript(skills.get(sid)?.script ?? '')));
          // An applier reaches a summon only through an area that is allowed
          // to hit one - a step authoring its own `hitFilter` (the default
          // filter is enemies) - and that step can be rank-gated: Brood
          // Leap's is `minRank: 2`.
          const reachRank = (sid) => {
            const ranks = (skills.get(sid)?.steps ?? [])
              .filter((x) => x.props?.area?.hitFilter != null && (stepOnNames[x.on ?? -1] ?? '') !== 'Code')
              .map((x) => x.cond?.minRank ?? 1);
            return ranks.length ? Math.min(...ranks) : null;
          };
          return [{
            field: m[2], amount, needsStatus: m[1],
            unitName: unitRow?.texts?.name ?? unitId,
            appliers: appliers.map((sid) => ({
              id: sid, name: skills.get(sid)?.texts?.name ?? sid,
              minRank: reachRank(sid), live: reachRank(sid) != null && rank >= reachRank(sid),
            })),
          }];
        })(),
      };
    };
    // A summoner that fell into unmodelled earns its slot back: its worth is
    // its pets', which the fight now schedules. Only a CAST-hosted one earns a
    // place in the ROTATION with it - a passive whose script summons on a proc
    // is not a skill anybody presses, and pressing it is how a 5%-per-weapon-
    // skill bee came to be priced at one press per fight.
    for (let i = unmodelled.length - 1; i >= 0; i--) {
      const spec = summonSpecOf(unmodelled[i].id);
      if (!spec) continue;
      const prof = profileOf(unmodelled[i].id);
      if (!prof) continue;
      unmodelled.splice(i, 1);
      if (spec.trigger.on === 'cast') {
        active.push({ prof, source: 'class', applies: { self: [], target: [] } });
      }
      summons.push(spec);
    }
    for (const a of active) {
      if (summons.some((sp) => sp.from === a.prof.id)) continue;
      const spec = summonSpecOf(a.prof.id);
      if (spec) summons.push(spec);
    }
    // ...and one nothing else reclaimed: a PASSIVE the build owns outright,
    // kept for the stat it grants, whose script also summons.
    for (const p of passive) {
      if (summons.some((sp) => sp.from === p.prof.id)) continue;
      const spec = summonSpecOf(p.prof.id);
      if (spec) summons.push(spec);
    }

    // A WEAPON-SKILL COOLDOWN RESET on an internal cooldown - Inner Demon's
    // whole shape, read from its script: `onSkillProc` guarded on
    // isWeaponSkill, the `!isInCooldown()/consumeCooldown()` idiom whose
    // period is the row's own cooldown, and `ctx.skill.resetCooldown()` as
    // the payload. Every <cd> seconds the next weapon-skill cast is handed
    // back. The life it costs (payLife of health x var1) is survivability
    // this model does not track - for a dps answer the reset is pure upside,
    // and the cost is NAMED rather than hidden. At rank >= 3 the same proc
    // shields for the life paid; the fraction rides along and damage.mjs
    // prices it off the sheet's MaxHealth (current ~ max, the resting claim).
    let wsReset = null;
    const wsResetOf = (id) => {
      const row = skills.get(id);
      const body = liveScript(row?.script ?? '');
      if (!(row?.cooldown > 0)) return null;
      const m = /onSkillProc[\s\S]{0,120}?isInCooldown\s*\(\s*\)[\s\S]{0,80}?isWeaponSkill[\s\S]{0,600}?resetCooldown\s*\(\s*\)/.exec(body);
      if (!m) return null;
      const lifeFrac = (() => {
        const lf = /health\s*\*\s*vars\.(\w+)/.exec(body);
        return lf ? (varsOf(id, rank, runes)[lf[1]] ?? 0) : 0;
      })();
      const shieldGate = /rank\s*>=\s*(\d+)[\s\S]{0,200}?setShield/.exec(body);
      const shieldMinRank = shieldGate ? Number(shieldGate[1]) : null;
      // The period is the cooldown AT THE WEAPON'S RANK: Inner Demon authors
      // 30 with props.rankOverride restating 20 from rank 2 ("Cooldown
      // reduced to 20"), and the bare row scheduled five resets where the
      // rank-3 character has eight.
      const every = combat.profile(id, rank, runes)?.cooldown;
      return {
        from: id, every: every > 0 ? every : row.cooldown,
        // the shield equals the life paid, so one fraction serves both
        shieldFrac: shieldMinRank != null && rank >= shieldMinRank ? lifeFrac : 0,
        lifeFrac,
      };
    };
    for (let i = unmodelled.length - 1; i >= 0 && !wsReset; i--) {
      const spec = wsResetOf(unmodelled[i].id);
      if (!spec) continue;
      unmodelled.splice(i, 1);
      wsReset = spec;
    }
    if (!wsReset) {
      for (const p of passive) {
        const spec = wsResetOf(p.prof.id);
        if (spec) { wsReset = spec; break; }
      }
    }
    // The charge dump's whole shape, off its script: an enable gate on the
    // charge count, a shoot per charge, pet hits and a combat timer feeding
    // it, and the cap on the Charge status row.
    let chargeDump = null;
    for (const a of active) {
      const row = skills.get(a.prof.id);
      const body = liveScript(row?.script ?? '');
      if (!body || !/checkEnabled[\s\S]{0,120}?getStatusCount\s*\(\s*owner\s*,/.test(body)) continue;
      const alias = /\b(\w+)\s*=\s*Skill\.(\w+)/.exec(body);
      const statusId = alias?.[2] ?? null;
      if (!statusId || !skills.get(statusId)) continue;
      const cap = maxStacksOf(statusId, rank);
      if (!Number.isFinite(cap) || cap < 2) continue;
      // THE PET FEED. `onProxyDamage(dmg) { addStatus(owner, Charge); }` -
      // unguarded, so one charge per damage event a proxy of the owner lands.
      // The accepted build spelled the same thing `onInflictDamage` +
      // `dmg.sourceUnit != owner`, and that law is the calibrated one (14.9
      // charges per press live). What can be READ of the new hook is its Eval
      // twin's routing (evalDamage@6124 ops 9-70); the post-damage dispatch of
      // onProxyDamage itself sat in Unit.receiveDamage@4913 /
      // applyDamage@4914, which are `throw "!isServer"` stubs in this client,
      // and no client function calls the slot. So "once per pet hit" is the
      // script's own one-for-one substitution plus the tooltip, not a read,
      // and the audit says so.
      const petFed = new RegExp('^\\s*addStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.' + statusId
        + '|' + (alias?.[1] ?? statusId) + ')\\s*\\)').test(hookBody(body, 'onProxyDamage'));
      const tm = /onRegUpdate[\s\S]{0,300}?rank\s*>=\s*(\d+)[\s\S]{0,300}?vars\.(\w+)/.exec(body);
      const timerPeriod = tm && rank >= Number(tm[1]) ? varsOf(row.id, rank, runes)[tm[2]] ?? null : null;
      chargeDump = { skill: a.prof.id, status: statusId, cap, petFed, timerPeriod };
      break;
    }
    // THE SAME BANK, SPENT ON TOP OF A SPIN THE CAST ALWAYS PLAYS. Flower
    // Spiral (see `bankSpendOf`) plays one spin whatever it holds and one
    // more per Psychoactive Petal, and the two steps author the same
    // damage - so the press is its own spin times (1 + petals), which is the
    // charge dump's arithmetic with a spin that needs no charge (`plus`).
    // The petals come from the skill's own script: one per `vars.time`
    // seconds in combat (onRegUpdate, the var at the weapon's rank), and one
    // from the finisher's first hit (onInflictDamage behind isFinalAttack()
    // and isFirstHit). The petal's own duration refreshes on every arrival
    // and is longer than either feed's interval, so nothing is lost to it.
    // Only where both steps really are the same hit and at least one feed is
    // read; otherwise the per-petal step keeps the refusal that names it.
    if (!chargeDump) {
      for (const a of active) {
        const row = skills.get(a.prof.id);
        const body = liveScript(row?.script ?? '');
        const sp = bankSpendOf(body);
        const statusRow = sp ? skills.get(sp.status) : null;
        if (!statusRow) continue;
        const base = combat.profile(a.prof.id, rank, runes);
        const fx = (id) => JSON.stringify(((base?.scripted ?? []).find((x) => x.stepId === id)?.effects ?? [])
          .map((e) => [e.kind, e.affinity, e.baseVal, e.scaling, e.hits, e.ticks, e.area?.range ?? null]));
        if (fx(sp.once) === '[]' || fx(sp.once) !== fx(sp.perStack)) continue;
        const cap = maxStacksOf(sp.status, rank);
        if (!Number.isFinite(cap) || cap < 1) continue;
        const self = new RegExp('addStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?' + sp.status + '\\s*\\)');
        const upd = hookBody(body, 'onRegUpdate');
        const tv = self.test(upd) ? />=?\s*vars\.(\w+)/.exec(upd)?.[1] : null;
        const timerPeriod = tv ? (base?.vars?.[tv] ?? null) : null;
        const dmgHook = hookBody(body, 'onInflictDamage');
        const comboFed = self.test(dmgHook) && /isFinalAttack\s*\(\s*\)/.test(dmgHook) && /isFirstHit/.test(dmgHook) ? 1 : 0;
        if (!(timerPeriod > 0) && !comboFed) continue;
        chargeDump = {
          skill: a.prof.id, status: sp.status, statusName: statusRow.texts?.name ?? sp.status,
          cap, petFed: false, timerPeriod: timerPeriod > 0 ? timerPeriod : null, comboFed, plus: 1,
          window: Number(statusRow.duration) > 0 ? Number(statusRow.duration) : null,
          // Each petal's spin is played `i * vars.delay` after the press and
          // the cast's Stop step waits for the last, so a petal costs that
          // much clock on top of the cast.
          perStackTime: sp.spacingVar && base?.vars?.[sp.spacingVar] > 0 ? base.vars[sp.spacingVar] : 0,
        };
        // The bank's own row is the mechanism the fight plays, not a row
        // that "declares nothing".
        accountedLate.add(sp.status);
        // The per-petal step is priced now: its refusal is withdrawn.
        for (let i = unmodelled.length - 1; i >= 0; i--) {
          if (unmodelled[i].id === `${a.prof.id}#${sp.perStack}`) unmodelled.splice(i, 1);
        }
        pendingBankSteps.add(`${a.prof.id}#${sp.perStack}`);
        break;
      }
    }

    // --- an OWN-STACK MULTIPLIER: a bank the actives fill and one press spends
    //
    // Tide Rising Uppercut is the shape, and it was worth NOTHING - not
    // refused, not named, simply absent from every channel at once. `DMG_FIELD`
    // is the only regex in this file that finds a damage rider in a script and
    // it requires the right-hand side to be a bare `vars.X;`. This clause reads
    //
    //   onDamageEval(hit) { hit.dmgMult += getStatusCount(owner, Skill.S)*vars.var2 }
    //
    // so nothing matched, `scriptGapsOf` returned an empty list, and a weapon
    // skill worth SIX TIMES its base hit at the cap priced at exactly its base
    // hit with no sentence anywhere saying so. Silence is the worst of the
    // three outcomes this file can produce: a refusal at least tells a player
    // where to stop trusting the number.
    //
    // THREE clauses must agree before any of it is read, because a bank with no
    // feed and no spend is not a rate:
    //   * the EVAL  - `dmgMult += getStatusCount(owner, S) * vars.X`
    //   * the FEED  - `onSkillProc(ctx) { if (ctx.isSkill && ...) addStatus(owner, S) }`
    //   * the SPEND - `onDamage` -> `removeStatus(owner, S)`
    // Anything that declares only some of them keeps whatever it had before.
    let stackMult = null;
    for (const a of active) {
      const row = skills.get(a.prof.id);
      const body = liveScript(row?.script ?? '');
      const m = OWN_STACK_MULT.exec(body);
      if (!m) continue;
      const statusId = m[1];
      const statusRow = skills.get(statusId);
      const per = varsOf(a.prof.id, rank, runes)[m[2]];
      if (!(per > 0) || !statusRow) continue;
      const cap = maxStacksOf(statusId, rank);
      if (!Number.isFinite(cap) || cap < 2) continue;
      const has = (re) => new RegExp(re + '\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?' + statusId + '\\b').test(body);
      if (!/onSkillProc[\s\S]{0,240}?isSkill/.test(body) || !has('addStatus')) continue;
      if (!/function\s+onDamage\s*\(/.test(body) || !has('removeStatus')) continue;
      // The bank's own duration, which is what BINDS - see the fight.
      const window = Number(statusRow.duration) > 0 ? Number(statusRow.duration) : 0;
      if (!(window > 0)) continue;
      stackMult = {
        skill: a.prof.id, name: a.prof.name, status: statusId,
        statusName: statusRow.texts?.name ?? statusId,
        per, cap, window,
      };
      break;
    }

    // The NEXT-WEAPON-SKILL register: Demondash's finisher (onHit, rank >= 3)
    // puts a status on the owner whose whole script is `isWeaponSkill() ->
    // dmgMult += vars.damage; stop()` - +25% on the next weapon-skill hit,
    // consumed. The conditional-buff refusal correctly keeps it off the
    // sheet; the FIGHT arms it per finisher and spends it on the next
    // weapon-skill cast, which is what live shows (8 of 23 Demondash_Skill1
    // hits at the +25% plateau).
    // A next-weapon-skill REGISTER: a status some cast applies to the owner,
    // whose script waits for the next qualifying use, adds dmgMult once, and
    // stops itself. Two script shapes say it:
    //   * onInflictDamageEval + isWeaponSkill() + dmgMult += vars.x + stop()
    //     (Demondash's finisher status), and
    //   * onSkillProc(ctx) { ctx.dmgMult += X; stop() } - the hook
    //     tryConsumeCharge@9631 raises once per skill USE, which the model
    //     refused wholesale as "an event this fight does not produce". It
    //     fires on every press: DS_Bladeleaf's finisher arms +50% for the
    //     next weapon skill this way, and pricing it at zero read that
    //     Rogue's weapon-skill line ~1.5x low.
    // The ARMER generalises too: the finisher is the common case, but
    // Mage_Blink_M3 arms the same register shape off a class-skill cast, so
    // the rider records who arms it and the fight listens for that cast.
    //
    // WHAT a register writes is read off its own script, per shape:
    //   * the AMOUNT is the status row's vars at the rank it is applied at -
    //     a status takes its instigator skill's rank (Status.get_rank@15802
    //     ops 0-5) and `props.rankOverride` restates vars like any other row.
    //     Domination's register is 0.10, and 0.15 from weapon rank 2; reading
    //     the row's bare vars priced it at 0.10 for everyone.
    //   * `level` is the hook: onSkillProc writes the cast's CONTEXT once per
    //     use and every hit copies it; onInflictDamageEval writes one hit.
    //   * `forcedCrit` is a `ctx.critChance = 1` in the same onSkillProc -
    //     $BaseSkillContext.copy@5232 ops 18-19 carry it into every hit and criticalRoll@6320
    //     ops 9-13 crit whenever critChance >= random.
    //   * WHO spends it is the guard. Only `isWeaponSkill` is read here. A
    //     register the FINISHER spends has the same body behind
    //     `isFinalAttack()` - the perfect-block status is one, armed by a
    //     block this passive foe never gives - and must not be taken for a
    //     weapon-skill one because its `dmgMult += ...; stop()` looks alike.
    const riderShape = (row) => {
      const body = liveScript(row?.script ?? '');
      const varsAt = combat.profile(row?.id, rank, runes)?.vars ?? row?.vars ?? {};
      const amountOf = (key, literal) => {
        const v = key != null ? varsAt[key] : Number(literal);
        return typeof v === 'number' && v > 0 ? v : null;
      };
      let m = /onInflictDamageEval[\s\S]{0,200}?isWeaponSkill\s*\(\s*\)[\s\S]{0,160}?dmgMult\s*\+=\s*vars\.(\w+)[\s\S]{0,100}?stop\s*\(\s*\)/.exec(body);
      if (m) {
        const amount = amountOf(m[1]);
        return amount ? { amount, level: 'hit', forcedCrit: false } : null;
      }
      const proc = hookBody(body, 'onSkillProc');
      m = /\.dmgMult\s*\+=\s*(?:vars\.(\w+)|([0-9.]+))[\s\S]{0,100}?stop\s*\(\s*\)/.exec(proc);
      if (m) {
        if (!/\bisWeaponSkill\b/.test(proc.slice(0, m.index))) return null;
        const amount = amountOf(m[1], m[2]);
        return amount
          ? { amount, level: 'ctx', forcedCrit: /\.critChance\s*=\s*1\b/.test(proc) }
          : null;
      }
      return null;
    };
    const riderFrom = (armerId, armedBy) => {
      const body = liveScript(skills.get(armerId)?.script ?? '');
      const add = /addStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)/.exec(body);
      if (!add) return null;
      const gate = /rank\s*>=\s*(\d+)/.exec(body.slice(0, add.index));
      if (gate && rank < Number(gate[1])) return null;
      const v = riderShape(skills.get(add[1]));
      return v ? { ...v, status: add[1], from: armerId, armedBy } : null;
    };
    const wsRiders = [];
    for (const x of filler) {
      if (!x.prof.isCombo) continue;
      const r = riderFrom(x.prof.id, 'combo');
      if (r) { wsRiders.push(r); break; }
    }
    if (!wsRiders.length) {
      for (const a of active) {
        const r = riderFrom(a.prof.id, new Set([a.prof.id]));
        if (r) { wsRiders.push(r); break; }
      }
    }
    // THE THIRD ARMER: applying a status to something. Domination, on build
    // 25782799: `onTryAddStatus(s, to) { if (s.id == Skill.Stun)
    // addStatus(owner, Skill.GA_Craft_Passive_Proc); }` (compiled
    // GA_Craft_Passive.onTryAddStatus@44727: ops 1-3 `s.id != "Stun"` -> ret,
    // op 17 addStatus(owner, "GA_Craft_Passive_Proc")), and the register it
    // plants is the onSkillProc shape above with a forced crit
    // (GA_Craft_Passive_Proc.onSkillProc@44730: op 3 BaseSkill.isWeaponSkill@6161, ops
    // 5-6 `ctx.critChance = 1`, ops 7-17 `ctx.dmgMult += vars.damage`, op 19
    // stop). So the armer is no single cast: it is EVERY cast in the build
    // that applies that status - Shockwave, Charge, Surging Force, an
    // arsenal stun - and the owner of the hook is a passive that sits in no
    // bucket, which is why the two searches above never found it.
    //
    // NOT READ, and stated in the audit: the hook's dispatcher.
    // GameObject.addStatus@4636 is a `throw "!isServer"` stub in this client
    // and no client function calls the script slot, so "it fires on the one
    // who applies the status, once per attempt, whether or not the status
    // lands" is the hook's name, its (status, target) signature and the
    // tooltip ("After applying a [Stun], even if the target is immune") -
    // which is also the only authority for arming against a CC-immune boss.
    for (const id of seen) {
      const hook = hookBody(liveScript(skills.get(id)?.script ?? ''), 'onTryAddStatus');
      const m = /^\s*(?:if\s*\(\s*rank\s*>=\s*(\d+)\s*\)\s*\{?\s*)?if\s*\(\s*\w+\.id\s*==\s*(?:Skill\.)?(\w+)\s*\)\s*\{?\s*addStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)\s*\)\s*;?[\s}]*$/.exec(hook);
      if (!m || (m[1] && rank < Number(m[1]))) continue;
      if (wsRiders.some((r) => r.status === m[3])) continue;
      const v = riderShape(skills.get(m[3]));
      if (!v) continue;
      // Who applies the watched status. For a crowd-control status that is
      // `crowdControlOf` and nothing else - the one reader, which knows a
      // stun step the script only plays from rank 3 is no stun at rank 1 and
      // one played when the foe leaves an area is never attempted here
      // (`unpriced`). Asking `statusesOf().all` beside it, as this did, armed
      // the register off every Stun a row merely LISTS. For any other status
      // the listing is all there is. A grafted entry is asked as its HOST -
      // the row whose cast it is.
      const watchedIsCC = (skills.get(m[2])?.props?.status?.types ?? [])
        .some((t) => statusTypeFlagsDeep(t.type).has('CrowdControl'));
      const applies = (sid) => !!sid && (watchedIsCC
        ? crowdControlOf(sid, { runes, rank, talents, talentRanks }).some((c) => c.status === m[2] && !c.unpriced)
        : (statusesOf(sid, { runes, rank, talents, talentRanks }).all ?? []).includes(m[2]));
      const armedBy = new Set([...active, ...filler]
        .filter((e) => applies(e.via ?? e.prof.id)).map((e) => e.prof.id));
      // The same question of the lines the fight plays on a ROLL. They would
      // arm it too and the register is a flag, not a probability, so they
      // are named rather than counted - a floor, said where it is one.
      const uncounted = triggered.filter((e) => applies(e.via ?? String(e.prof.id).split('#')[0]))
        .map((e) => e.prof.name ?? e.prof.id);
      wsRiders.push({
        ...v, status: m[3], from: id, armedBy, watches: m[2],
        uncounted: [...new Set(uncounted)],
      });
    }
    // THE MIRROR IMAGE: a mark a weapon skill's hit puts on the TARGET, which
    // the next finisher's hit spends. Thrill of the Hunter (Horns of the
    // Wind's passive) is the shape, and it was refused whole as "everything
    // it does lives in its hscript body":
    //
    //   function onInflictHit(ctx) {
    //     if (ctx.target.hasStatus(mark) && (ctx.isFinalCombo)) {
    //       ctx.dmgMult += vars.damage;
    //       ...
    //       consumeStatus(ctx.target, mark);
    //     } else if ((ctx.isWeaponSkill || ctx.skill.isWeaponSkill())) {
    //       addStatus(ctx.target, mark);
    //     }
    //   }
    //
    // (Bow_BigGame_Passive.onInflictHit@44944: op 5 hasStatus, op 9
    // BaseSkill.isFinalAttack@6154 on the hit's skill, ops 11-21 `dmgMult +=
    // vars.damage`, op 74 the consume; ops 78-83 the weapon-skill test, op 89
    // the addStatus.) Build
    // 25782799 doubled the bonus (vars.damage 1, and 1.5 from rank 2 through
    // props.rankOverride) and narrowed the spender from "a swing or the
    // finisher" to the finisher alone. The bonus is written on the HIT that
    // finds the mark, in the one additive dmgMult bracket, and the mark is
    // gone before the finisher's next hit looks - so one hit per mark. The
    // mark is not crowd control (its row carries no status type), so an
    // immune target wears it like any other. Read whole or not at all: the
    // hook must be exactly these two branches around one status.
    let comboRider = null;
    for (const id of seen) {
      if (typeOf(id) === 'Talent') continue;
      const row = skills.get(id);
      const body = liveScript(row?.script ?? '');
      const hit0 = hookBody(body, 'onInflictHit').replace(/\s+/g, '');
      if (!hit0) continue;
      const m = /^if\((\w+)\.target\.hasStatus\((?:Skill\.)?(\w+)\)&&\(?\1\.(?:isFinalCombo|isFinalAttack\(\))\)?\)\{\1\.dmgMult\+=vars\.(\w+);(.*?)consumeStatus\(\1\.target,(?:Skill\.)?\2\);\}elseif\(\(?\1\.isWeaponSkill(?:\|\|\1\.skill\.isWeaponSkill\(\))?\)?\)\{addStatus\(\1\.target,(?:Skill\.)?\2\);\}$/.exec(hit0);
      if (!m) continue;
      const statusId = aliasOf(body, m[2]);
      const statusRow = skills.get(statusId);
      const hv = combat.profile(id, rank, runes)?.vars ?? {};
      const amount = hv[m[3]];
      const window = Number(statusRow?.duration) > 0 ? Number(statusRow.duration) : Infinity;
      if (!statusRow || !(typeof amount === 'number' && amount > 0)) continue;
      // The one other thing the spending branch may do: a crit-chance clause
      // behind a rank and the target's health (Thrill of the Hunter's rank-3
      // "+30% to critically strike under 35%"). Carried so it can be SAID -
      // the fight does not price a crit-chance rider on one finisher hit.
      // Anything else between the add and the consume is not this shape.
      const cm = m[4].length
        ? /^if\(rank>=(\d+)&&\w+\.targetUnit\.healthRatio(<=|<)vars\.(\w+)\)\{\w+\.critChance\+=vars\.(\w+);\}$/.exec(m[4]) : null;
      if (m[4].length && !cm) continue;
      comboRider = {
        from: id, name: row.texts?.name ?? id, status: statusId,
        statusName: statusRow.texts?.name ?? statusId, amount, window,
        crit: cm && rank >= Number(cm[1]) && typeof hv[cm[3]] === 'number' && typeof hv[cm[4]] === 'number'
          ? { op: cm[2], threshold: hv[cm[3]], amount: hv[cm[4]] } : null,
      };
      accountedLate.add(id);
      break;
    }
    // A HIT WHEN A STATUS ENDS. Ram Trap's root (Bow_BigGame_Skill2_Status,
    // four seconds) carries a Code step and one line of script:
    // `onStop(ctx) { if (rank >= 3) playStep(Steps.Damage, owner); }` - the
    // rank-3 "Deals an additional ... when the immobilization effect ends",
    // landed on whoever wore the root. The status is no row the build owns,
    // so the step had no line and no sentence. It is one play per
    // application - the status ends once - so it rides the cast that applies
    // it, and only an unguarded play (bar its own rank) is read.
    //
    // Whether the status LANDS is the target's to say, which the rotation
    // cannot see: a crowd-control status is refused by a Boss, Miniboss or
    // Elite (GameObject.canReceiveStatus@4634 ops 0-7 with Foe.isCCImmune@7071;
    // that the server's addStatus consults it is inferred - its caller is a
    // server-only stub in this client). So the rule carries `needsCC` and
    // the fight drops the rider against such a target, as it drops a
    // health-gated one.
    //
    // HOW MANY WEAR IT. The status ends once on EACH target that wears it, and
    // the step is played on that wearer (`owner` in a status script is the
    // unit carrying it), so a cast buys one end-hit per target its applying
    // step reaches. Ram Trap roots whatever its explosion hits - `if
    // (hit.stepId == Steps.Explode) addStatus(hit.target, <root>)` in its own
    // onHit, and Explode is an Area step - so three trapped enemies are three
    // hits four seconds later, where the rider was priced once a cast at any
    // target count. The applying step's reach is carried onto the rider's
    // effects, so `--targets` scales it through the same caps as the hit that
    // applied it. Read in the two places a step is NAMED: the script's own
    // hit hook behind `<hit>.stepId == Steps.<S>`, and a step whose own
    // effect or props carry the status. Anywhere else the rider stays on one
    // target and its sentence says that is a floor.
    const statusReachOf = (hostId, stId) => {
      const hp = combat.profile(hostId, rank, runes);
      const fx = [...(hp?.effects ?? []), ...(hp?.scripted ?? []).flatMap((x) => x.effects ?? [])];
      const reachOfStep = (stepId) => {
        const e = fx.find((x) => x.stepId === stepId);
        return e ? { step: stepId, area: e.area ?? null } : null;
      };
      const hb = liveScript(skills.get(hostId)?.script ?? '');
      const names = ['Skill\\.' + stId];
      SKILL_ALIAS.lastIndex = 0;
      for (let am; (am = SKILL_ALIAS.exec(hb));) if (am[2] === stId) names.push(am[1]);
      const AT = new RegExp('addStatus\\s*\\(\\s*(\\w+)\\.target\\s*,\\s*(?:' + names.join('|') + ')\\s*[,)]', 'g');
      for (let m; (m = AT.exec(hb));) {
        if (!OWN_HIT_HOOKS.test(hookAt(hb, m.index))) continue;
        const scope = enclosingBlock(hb.slice(0, m.index));
        if (/\|\|/.test(scope)) continue;
        const named = new RegExp('\\b' + m[1] + '\\.stepId\\s*==\\s*Steps\\.(\\w+)').exec(scope)?.[1];
        const reach = named ? reachOfStep(named) : null;
        if (reach) return reach;
      }
      for (const st of skills.get(hostId)?.steps ?? []) {
        if (!st.id || !(st.props?.status?.ref === stId || (st.effects ?? []).some((e) => e.status === stId))) continue;
        const reach = reachOfStep(st.id);
        if (reach) return reach;
      }
      return null;
    };
    for (const a of active) {
      const hostId = a.via ?? a.prof.id;
      for (const stId of statusesOf(hostId, { runes, rank, talents, talentRanks }).all ?? []) {
        const stRow = skills.get(stId);
        const stop = hookBody(liveScript(stRow?.script ?? ''), 'onStop').replace(/\s+/g, '');
        const sm = /^(?:if\(rank>=(\d+)\)\{?)?playStep\(Steps\.(\w+),owner\);?\}?$/.exec(stop);
        if (!sm || (sm[1] && rank < Number(sm[1]))) continue;
        const sp = combat.profile(stId, rank, runes);
        const step = (sp?.scripted ?? []).find((x) => x.stepId === sm[2]);
        if (!step?.effects?.some((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length))) continue;
        const types = (stRow.props?.status?.types ?? []).map((t) => t.type);
        const isCC = types.some((t) => statusTypeFlagsDeep(t).has('CrowdControl'));
        const stName = stRow.texts?.name ?? stId;
        const reach = statusReachOf(hostId, stId);
        const rp = riderProf(sp, step);
        if (reach?.area) rp.effects = rp.effects.map((e) => ({ ...e, area: reach.area }));
        triggered.push({
          prof: rp, source: 'scripted',
          rule: {
            kind: 'per-parent-cast', parent: a.prof.id, chance: 1, divisor: 1,
            needsCC: isCC ? types.filter((t) => statusTypeFlagsDeep(t).has('CrowdControl')) : null,
            why: `${stName}'s ${step.stepId} step is played when ${stName} ends, on whoever wore it - `
              + (reach?.area
                ? `once for every target the ${reach.step} step of a ${a.prof.name} puts it on`
                : reach ? `once for each ${a.prof.name} that puts it on the target`
                  : `once for each ${a.prof.name} that puts it on the target; which of that cast's hits apply it `
                    + 'is not read, so with several targets this is one target\'s worth - a floor')
              + (Number(stRow.duration) > 0 ? `, ${Number(stRow.duration)}s later` : ''),
          },
        });
      }
    }
    // The first, for every reader that asks for "the" register.
    const wsRider = wsRiders[0] ?? null;
    // A row whose register the fight plays is not "everything it does lives
    // in its hscript body". Domination sat in the unscored list under exactly
    // that sentence at ranks 1 and 2, where the register is all it does. When
    // nothing in the build arms it the engine says THAT instead, which is the
    // reason that is true.
    for (const w of wsRiders) accountedLate.add(w.from);

    // Costs the data does not declare, read from the bytecode instead.
    // Mage: `Skill.getSparkCost@9623` - a weapon skill costs
    // round(max(Mage_Spark_SpellMinCost, cooldown x Mage_Spark_SpellCDCostRatio)),
    // spent by Mage_SparkMaster.onPreSkillProc on weapon skills and final
    // attacks. Neither is GATED on it - the finisher's 10 or a weapon skill's
    // own: the game spends what is there and asks for nothing (measured, see
    // `spendOnly` where the cost is attached below).
    // Rogue: the signature finisher consumes all Combo Points for +0.3 dmgMult
    // each (script.skills.Rogue_Sig_Finisher.onStep@45233: at its Damage step
    // `consumed = getCp(); damageBonus = consumed * vars.var1`, at its
    // ConsumeCP step, 0.02 s later, `addAtb(owner, ComboPoint, -getCp())`).
    // Nothing in the row asks for a number of points - `checkComboPoints` only
    // keeps the Combo Ruler State in step with its mastery - so the press is
    // never held back by the pool: it spends what is held and is priced at
    // it (`all` on the cost, `poolRider` beside it; sim.mjs, where a press is
    // paid for and priced). The PROFILE keeps the full bar - comboPointCap()
    // reads the cap off the rows (6 with the Combo Ruler mastery's State, see
    // its docstring) - which is what a reader of the profile alone is shown,
    // and what `amount` on the cost still says.
    // It used to be pressed only at a full bar and always priced at one.
    // MEASURED 2026-10-13 (Rogue, the same 182 Finishers): 10 at one point, 17
    // at two, 24 at three, 31 at four and 100 at five, none at zero; per hit
    // the full-bar price read +10.4% over them (501.7 against 454.5).
    // Profs are CLONED before costs are attached - the profile cache is shared
    // across builds and a mutated cached prof would leak between classes.
    const constNum = (id, dflt) => cdb.byId('constant').get(id)?.v?.float
      ?? cdb.byId('constant').get(id)?.v?.int ?? dflt;
    // A GainAtb a CAST carries is income the fight produces - Mage_RayOfSpark
    // returns 18% of MaxSpark per cast - so the pool it fills is trackable
    // the moment the skill is in the rotation, and a cost in it can gate.
    for (const a of active) {
      for (const e of a.prof.effects ?? []) {
        if (e.kind === 'GainAtb' && e.atb) tracked.add(e.atb);
      }
    }
    let sparkGauge = null;
    if (loadout.class === 'Mage' && tracked.has('Spark')) {
      const minCost = constNum('Mage_Spark_SpellMinCost', 5);
      const ratio = constNum('Mage_Spark_SpellCDCostRatio', 1);
      for (const a of active) {
        if (a.prof.type !== 'WeaponSkill' && a.prof.type !== 'WeaponSubSkill') continue;
        const amount = Math.round(Math.max(minCost, a.prof.cooldown * ratio));
        if (!(amount > 0)) continue;
        // `amount` is the resting price; `cdCost` is the formula, because
        // getSparkCost@9623 reads the cooldown AFTER the CDR modifier - a
        // CDR-stacking Mage pays less Spark per weapon skill, and only the
        // sim knows the sheet's CooldownReduction. The sim resolves cdCost
        // against the effective cooldown; the flat amount stands wherever no
        // sheet is in play.
        // SPENT, NOT REQUIRED (`spendOnly`). The cost is taken by
        // Mage_SparkMaster.onPreSkillProc@45397 (op 81 getSparkCost, then
        // addResource of its negative) and by nothing else: getSparkCost@9623
        // has that one caller and the tooltip, and no enable check asks for
        // it - a weapon skill pressed on less Spark than it costs goes off
        // and empties the pool. MEASURED 2026-10-13: Summon: Vile Imps
        // pressed at 17.4 of its 19 summoned its imps, and Swarmstrike
        // Accord at 5.85 and at 1.95 of its 29 put its status up; the pool
        // read 0, plus the regen since, at the next row. The fight used to
        // refuse such a press until Spark came back.
        a.prof = { ...a.prof, costs: [...(a.prof.costs ?? []), { atb: 'Spark', amount, cdCost: { min: minCost, ratio }, spendOnly: true }] };
      }
      // The finisher's own cost is a FLAT constant with no cooldown term, and
      // it is the spend that actually drives the gauge on a naked Mage: five
      // finishers take a full pool from 100 to 50 and that is exactly where the
      // conduits stop. The chain is still not GATED on it - a Mage with no
      // Spark keeps swinging - but the spend is real and the gauge reads it.
      const bounds = (() => {
        try { return cdb.constantFloats('Mage_Conduit_SparkBounds'); } catch { return [0.5]; }
      })();
      // A trigger-event refund: Mage_Talent_ConduitResidues hooks
      // onConduitTriggers and returns vars.var1 Spark at vars.chance - see
      // `conduitRefundOf`. Carried as its expectation on the gauge.
      let residues = 0;
      for (const tid of Object.keys(loadout.talents ?? {})) {
        const refund = conduitRefundOf(tid, loadout.talents[tid], runes);
        if (refund) residues += refund.chance * refund.amount;
      }
      sparkGauge = {
        atb: 'Spark',
        ratio: bounds[0] ?? 0.5,
        finisherCost: constNum('Mage_Spark_SpellCDCost_FinalCombo', 10),
        residues,
      };
    }
    let poolCapOverride = null;
    if (loadout.class === 'Rogue' && tracked.has('ComboPoint')) {
      // Runes count as KNOWN only when the loadout actually carries a rune
      // map (a v5 snapshot or the jobs dump) - an empty map on a bare
      // catalog build means unknown, and the as-held assumption stands.
      const cap = comboPointCap(cdb, Object.keys(loadout.runes ?? {}).length ? runes : null);
      const per = cdb.byId('skill').get('Rogue_Sig_Finisher')?.vars?.var1 ?? 0.3;
      for (const a of active) {
        if (a.prof.id !== 'Rogue_Sig_Finisher') continue;
        a.prof = {
          ...a.prof,
          costs: [...(a.prof.costs ?? []), { atb: 'ComboPoint', amount: cap, all: true }],
          runeDamage: [...(a.prof.runeDamage ?? []), { amount: cap * per }],
          // What the fight takes back from that full-bar rider for each
          // point the pool was short of when the press went off.
          // (`name`: what the game calls the pool, for the line that says so.)
          poolRider: { atb: 'ComboPoint', per, full: cap, name: cdb.byId('attribute').get('ComboPoint')?.name ?? 'ComboPoint' },
        };
      }
      // The Combo Ruler State's +1 is on no sheet, so the pool's cap cannot
      // come from the sheet alone - the fight takes the larger of the two.
      poolCapOverride = { ComboPoint: cap };
    }

    // --- the second press of a recast skill ----------------------------------
    // See `recastOf`. The recast is the SAME row pressed again, so it enters
    // the fight as a second entry of the same profile - `<id>#recast` - that
    // only its own first press can open, for the window the script gives, and
    // that hands the cooldown back to the first when it is used. Each press
    // then carries the clauses the script keeps for it: the riders behind the
    // recast flag (Hiveborn Blossom's +100% is `if (!firstCast)`), and the
    // statuses applied behind it (Zealous Spins' rank-3 armour break is `if
    // (rank >= 3 && recasting)`, the second press alone - it was being put up
    // by every press).
    for (const a of [...active]) {
      const rc = recastOf(a.prof.id, rank, runes);
      if (!rc) continue;
      if (rc.unread) {
        // A recast that hands over to a SUB-SKILL is the follow-up machinery's
        // (`props.subskills`: Void Fangs recasts into its Shoot row, which is
        // priced as its own entry) - not a second press of this row.
        if ((skills.get(a.prof.id)?.props?.subskills ?? []).length) continue;
        unmodelled.push({
          id: a.prof.id + '#recast', name: a.prof.name, source: a.source ?? null, kind: 'recast not priced',
          why: `${a.prof.name} can be pressed again inside its own cooldown (its script answers `
            + 'checkForceRecast, which is what lets a press through), and when is written in a shape this '
            + 'reader does not follow - so the second press and whatever it does are not in the number',
        });
        continue;
      }
      if (!carriesPayload(a.prof) || !(a.prof.cooldown > 0)) continue;
      const answered = (isRecast) => (rc.flag ? { [rc.flag.name]: isRecast === rc.flag.recastWhen } : null);
      const ridersFor = (isRecast) => combat.riderDamage(a.prof.id, rank, runes, answered(isRecast));
      // A status applied behind the flag belongs to the press the flag names.
      const st = statusesOf(a.prof.id, { runes, rank, talents, talentRanks });
      const pressOf = (statusId) => {
        const scope = st.applied.find((x) => x.status === statusId)?.site?.scope ?? '';
        const m = rc.flag ? new RegExp('(!\\s*)?\\b' + rc.flag.name + '\\b').exec(scope) : null;
        if (!m) return 'both';
        return (!m[1]) === rc.flag.recastWhen ? 'recast' : 'first';
      };
      const appliesFor = (isRecast) => {
        const keep = (b) => { const p = pressOf(b.status); return p === 'both' || (p === 'recast') === isRecast; };
        return { self: (a.applies?.self ?? []).filter(keep), target: (a.applies?.target ?? []).filter(keep) };
      };
      const first = { ...a, prof: { ...a.prof, runeDamage: ridersFor(false) }, applies: appliesFor(false) };
      active[active.indexOf(a)] = first;
      active.push({
        ...a,
        prof: { ...a.prof, id: a.prof.id + '#recast', runeDamage: ridersFor(true) },
        applies: appliesFor(true),
        recast: {
          of: a.prof.id, window: rc.window,
          why: `${a.prof.name} pressed a second time, inside the ${rc.window}s its script allows after the first `
            + '(one recast per press; the cooldown is taken to run from the second press - read, not measured)',
        },
      });
    }

    // --- cooldown mutations -------------------------------------------------
    // "Reset Bonethrow when Tear crits" is worth more than most damage riders
    // on a skill-bound class, and ~50 scripts mutate cooldowns. Wave one reads
    // the EXPLICIT-target family - resetCooldown(Skill.X) and
    // reduceCooldown(Skill.X, vars.t) - with the guard read the same way a
    // proc's is: the event, the roll, the crit gate, the rank gate. A site
    // whose hook the fight cannot produce (onKill, onAreaExited) or whose
    // guard asks live state is refused with the reason, not skipped.
    const cdMutations = [];
    // Both spellings of the target: `Skill.X`, and `skill.kind` - the host
    // resetting ITSELF. Demondash's dash is the second kind: a 12-second
    // cooldown whose script consumes a Mark off the target and calls
    // resetCooldown(skill.kind), so the real cadence is however fast Marks
    // arrive - and its Skill2 puts a Mark on every damage instance it deals.
    // The player pressed it at 0.353/s against the model's 0.085/s, a 4.2x
    // under-rate on the second-biggest hit in the build, all of it this one
    // unread spelling.
    //
    // The seconds may be a LOCAL rather than a var, and then the handler says
    // what it holds. Venomous Assassin (build 25782799):
    //
    //   function onInflictHit(hit) {
    //     if (hit.isFinalCombo && hit.isFirstHit) {
    //       var reduction = vars.dur1;
    //       if (!hasStatus(hit.target, Skill.Rogue_Talent_LethalPoison_Dose_FCA)) {
    //         reduction = vars.dur2;
    //       }
    //       reduceCooldown(Skill.Rogue_Sig_Finisher, reduction);
    //
    // CD_MUT used to demand `vars.X` or nothing, so this call matched nothing
    // and the talent vanished without a line. The base value is the local's
    // initialiser; the one reassignment this reads is behind "a named status
    // is NOT on the target", which the fight answers per hit (`alt`).
    //
    // ...and two more that say "this skill" with less: a bare `kind` (the
    // script's own field - Riptide's `reduceCooldown(kind, vars.time)` compiles
    // to `this.skill.kind`, Halos_Totem_Skill2.onHitNewTarget@44828 ops 5-7)
    // and an EMPTY argument list (Pyroclasm's `resetCooldown()`). Neither was
    // matched, so neither was read or named. A method call on something else
    // - `ctx.activeSkill.resetCooldown()`, `sk.reduceCooldown(vars.time)` -
    // resets THAT object and is not this call; the lookbehind keeps it out.
    //
    // One expression for all of it: the target is `Skill.X`, `skill.kind`,
    // `kind` or absent (group 2 is set only for the first); the seconds are
    // `vars.X` (group 3) or a local's name (group 4), and only after a comma -
    // so a lone local (`reduceCooldown(t)`) is still no match, as before.
    const CD_MUT = /(?<![.\w?])(resetCooldown|reduceCooldown)\s*\(\s*(?:Skill\.([A-Za-z0-9_]+)|skill\.kind|kind)?\s*(?:,\s*(?:vars\.([A-Za-z0-9_]+)|([A-Za-z_]\w*)))?\s*\)/g;
    // The casts this fight MAKES. A releaser is in `active` for what it
    // releases (Judgment and the prayers), and one with nothing to press for
    // - no rider that fires off its press, no status of its own to put up,
    // no dot - is dropped by the fight (sim.mjs, the actives filter): its
    // own checkEnabled refuses the press. It is not a cast, so cooldown
    // handed to it buys none, and a talent that hands it is named below
    // like any other whose target is not cast rather than left as a
    // mutation nothing ever spends.
    // A releaser whose checkEnabled refuses an empty press (`needsReady`) is
    // idle as soon as nothing in the build can be released, even where a rune
    // would hang a status on the press: the press never happens.
    const idleReleaser = (a) => a.releases === true
      && !triggered.some((t) => t.rule?.kind === 'per-parent-cast' && t.rule.parent === a.prof.id)
      && (a.needsReady === true
        || (!((a.applies?.self?.length ?? 0) + (a.applies?.target?.length ?? 0))
          && !liveDots.some((d) => d.from === a.prof.id && d.on === 'cast')));
    const idleReleasers = new Set(active.filter(idleReleaser).map((a) => a.prof.id));
    // ...and that is said, because a key that never answers is otherwise a
    // silence: the cast is on the bar, a rune may be slotted on it, and no
    // line of the fight carries its name.
    for (const a of active) {
      if (!idleReleasers.has(a.prof.id) || a.needsReady !== true) continue;
      if (unmodelled.some((u) => u.id === a.prof.id && u.kind === 'off in this build')) continue;
      const hung = [...(a.applies?.self ?? []), ...(a.applies?.target ?? [])]
        .map((b) => skills.get(b.status)?.texts?.name ?? b.name ?? b.status);
      unmodelled.push({
        id: a.prof.id, name: a.prof.name, kind: 'off in this build',
        why: `${a.prof.name} is never pressed in this build: the game refuses the press while no prayer is ready `
          + '(its own checkEnabled), and no prayer is slotted'
          + (hung.length ? ` - so the status that press would put up (${[...new Set(hung)].join(', ')}) is never up` : ''),
      });
    }
    const activeIds = new Set(active.map((a) => a.prof.id).filter((id) => !idleReleasers.has(id)));
    // `onHitNewTarget` is the host's own landing, once per enemy a cast has
    // not hit yet: BaseSkill.onHit@6233 ops 17-22 push the target onto the
    // cast's list and call BaseSkill.onHitNewTarget@6232 only when it was not on it.
    // One per cast at one target; counted once per cast here.
    //
    // `onSkillProc` is every USE of a skill by the owner (tryConsumeCharge@9631
    // ops 67-121), which this file already takes as such for the weapon-skill
    // register. With the bare `kind` read, Shiv's "Your [ComboAttack] resets
    // the cooldown" - `onSkillProc(ctx) { if (ctx.skill.isFinalAttack())
    // resetCooldown(kind); }` - would otherwise be refused as "an event this
    // fight does not produce" about the finisher the fight plays every cycle.
    // Which uses is the guard's: the finisher, a swing, a weapon skill. A use
    // with no such test is every press of anything, which the fight does not
    // raise as one event, and stays unread.
    const KNOWN_HOOKS = /^on(Damage|DamageEval|InflictDamage|InflictHit|InflictDamageEval|FirstHit|Hit|HitNewTarget|SkillProc)$/;
    // A third spelling names the target by what is HELD rather than by id:
    // `var sk = ownerHero.getOffhandWeaponSkill(); if (sk != null) {
    // sk.reduceCooldown(vars.time); }` - Tactician Assault's tooltip line,
    // "a chance to reduce the cooldown of your Off-Hand [WeaponSkill]".
    // getOffhandWeaponSkill@7828 hands back the first of the hero's weapon
    // skills whose originItem is the active off-hand, which the loadout
    // answers; with nothing there the call site is dead and adds nothing.
    // (CD_MUT's lookbehind keeps every `<object>.reduceCooldown(...)` out;
    // this is the one object whose skill the build can name.)
    const OFFHAND_SK = /\bvar\s+(\w+)\s*=\s*\w+\.getOffhandWeaponSkill\s*\(\s*\)\s*;/g;
    // "...and make it instant." A reset that comes with a status the target's
    // own `shouldPlayInstantly` waits for hands back more than a cooldown:
    // the cast it buys is played with castTimeFactor 0 (BaseSkill.start@6145
    // ops 5-22 ask Skill.playInstantly@9626, which is the script's
    // shouldPlayInstantly), and `profile().instant` is what that cast costs.
    // Three rows in the sheet say it, in two spellings of the test, each
    // through one helper function:
    //   Aimed Shot, Pyroclasm   return owner.getStatusCount(Proc) > 0
    //   Ram Veil                return owner.getStatus(Skill.X) != null
    // WHICH status is read here; that the reset's own site applies it is
    // checked where the site is read.
    const aliasesOf = (body) => {
      const map = new Map();
      SKILL_ALIAS.lastIndex = 0;
      for (let am; (am = SKILL_ALIAS.exec(body));) map.set(am[1], am[2]);
      return map;
    };
    const instantStatusOf = (targetId) => {
      const tb = liveScript(skills.get(targetId)?.script ?? '');
      let ret = hookBody(tb, 'shouldPlayInstantly');
      if (!ret) return null;
      const hop = /^\s*return\s+(\w+)\s*\(\s*\)\s*;?\s*$/.exec(ret);
      if (hop) ret = hookBody(tb, hop[1]);
      const m = /^\s*return\s+owner\.getStatusCount\s*\(\s*(?:Skill\.)?(\w+)\s*\)\s*>\s*0\s*;?\s*$/.exec(ret)
        ?? /^\s*return\s+owner\.getStatus\s*\(\s*(?:Skill\.)?(\w+)\s*\)\s*!=\s*null\s*;?\s*$/.exec(ret);
      const id = m ? (aliasesOf(tb).get(m[1]) ?? m[1]) : null;
      return id && skills.get(id) ? id : null;
    };
    // What the instant status is worth beyond the cast time, and what ends it.
    //   * It lasts its row's duration, so an instant cast nobody takes in that
    //     window is lost (the reset is not - that already happened).
    //   * It is ONE cast's: either its own onSkillProc consumes it on the
    //     target's use (Deadeye Focus), or the target's onProc removes it
    //     (Pyroclasm, Ram Veil) - both run from tryConsumeCharge@9631, once
    //     per use. A status neither shape ends would make every press in the
    //     window instant, and is carried as that (`consumed: false`).
    //   * A RIDER on that one cast: Deadeye Focus's onSkillProc reads
    //     `if (ctx.skillId == Skill.Bow_Craft_Skill1) { if (rank >= 3) {
    //     ctx.dmgMult += vars.var1; } consumeStatus(owner, ...); }`
    //     (Bow_Craft_Passive_Status.onSkillProc@44931: ops 1-5 the skill
    //     test, ops 8-10 `rank < 3` jumps the add, ops 11-21 the add, op 33
    //     the consume). The write is on the cast's CONTEXT, which every hit
    //     of the cast copies ($ScriptHitData.__constructor__@6318 op 10 ->
    //     $BaseSkillContext.copy@5232), so it is the one additive dmgMult bracket - and since
    //     the status holds one stack (no props.status.maxStacks:
    //     Status.getMaxStacks@15831 defaults to 1) and is spent by the use it
    //     boosts, "the cast the proc handed back" and "the cast that takes
    //     the bonus" are the same cast. The status takes its instigator
    //     skill's rank (Status.get_rank@15802), i.e. the weapon's.
    const instantOf = (targetId, statusId) => {
      if (!statusId || instantStatusOf(targetId) !== statusId) return null;
      const stRow = skills.get(statusId);
      const sb = liveScript(stRow?.script ?? '');
      const proc = hookBody(sb, 'onSkillProc');
      const rm = new RegExp('^\\s*if\\s*\\(\\s*(\\w+)\\.skillId\\s*==\\s*Skill\\.' + targetId + '\\s*\\)\\s*\\{\\s*'
        + '(?:(?:if\\s*\\(\\s*rank\\s*>=\\s*(\\d+)\\s*\\)\\s*\\{\\s*)?\\1\\.dmgMult\\s*\\+=\\s*vars\\.(\\w+)\\s*;\\s*\\}?\\s*)?'
        + '(?:consumeStatus|removeStatus)\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?' + statusId + '\\s*\\)\\s*;?\\s*\\}\\s*$').exec(proc);
      const tb = liveScript(skills.get(targetId)?.script ?? '');
      const tAlias = [...aliasesOf(tb)].filter(([, v]) => v === statusId).map(([k]) => k);
      const ownRemoves = new RegExp('removeStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.' + statusId
        + (tAlias.length ? '|' + tAlias.join('|') : '') + ')\\s*\\)').test(hookBody(tb, 'onProc'));
      const amount = rm?.[3] ? combat.profile(statusId, rank, runes)?.vars?.[rm[3]] : null;
      const minRank = rm?.[2] ? Number(rm[2]) : 1;
      return {
        status: statusId, name: stRow?.texts?.name ?? statusId,
        window: Number(stRow?.duration) > 0 ? Number(stRow.duration) : Infinity,
        consumed: !!rm || ownRemoves,
        rider: typeof amount === 'number' && amount > 0 && rank >= minRank ? { amount, minRank } : null,
      };
    };
    // Whether the fight scores damage FOR a host, wherever that damage went:
    // its own cast (or the row grafted in for it, `via`), a step the fight
    // plays for it on an event (`<host>#<step>`, or a rider worn for a window
    // the host opens), a dot it applies or co-applies, a summon it calls.
    const dealsDamage = (p) => (p?.effects ?? []).some((e) => e.kind === 'Damage' && (e.baseVal || e.scaling?.length));
    const scoresDamage = (hostId) => [...filler, ...active]
      .some((a) => (a.prof.id === hostId || a.via === hostId) && dealsDamage(a.prof))
      || triggered.some((t) => (t.prof.id === hostId || String(t.prof.id).startsWith(hostId + '#')
        || t.rule?.window?.from === hostId) && dealsDamage(t.prof))
      || liveDots.some((d) => (d.from === hostId || (d.coAppliers ?? []).some((c) => c.from === hostId)) && dealsDamage(d.prof))
      || summons.some((sp) => sp.from === hostId || sp.host === hostId);
    // A talent held but not in `seen` (it carries no payload of its own) can
    // still mutate a cooldown, so the allocation is walked too - with the
    // row's vars at the points in the node, the rank a talent's
    // props.rankOverride answers to (Prosecutor gives back 0.5 s, 1 s with
    // two points).
    for (const hostId of new Set([...seen, ...Object.keys(loadout.talents ?? {})])) {
      const hs = skills.get(hostId);
      if (!hs?.script) continue;
      const body = liveScript(hs.script);
      // The numbers a site reads are the host's vars AT ITS RANK:
      // props.rankOverride restates them (updateSkillInf@21787 ops 57-59), and
      // Deadeye Focus's roll is 8% at rank 1 and 12% from rank 2 - reading the
      // bare row printed "8% of the time" at every rank. A talent's rank is
      // its points, not the weapon's - whether it came in through `seen` or
      // only through the allocation.
      const hostRank = talentRanks.has(hostId) || typeOf(hostId) === 'Talent' ? (talentRanks.get(hostId) ?? 1) : rank;
      const hv = varsOf(hostId, hostRank, runes);
      const aliases = aliasesOf(body);
      const sites = [];
      CD_MUT.lastIndex = 0;
      for (let m; (m = CD_MUT.exec(body));) {
        const [, call, named = null, secVar0, secLocal] = m;
        // A LOCAL for the seconds is read where it is declared, in the
        // function the call sits in: its initialiser is the base value, and
        // the one reassignment taken is the `alt` shape above.
        let secVar = secVar0, alt = null;
        if (call === 'reduceCooldown' && secLocal) {
          const fn = hookBody(body, hookAt(body, m.index));
          secVar = new RegExp(`\\bvar\\s+${secLocal}\\s*=\\s*vars\\.(\\w+)\\s*;`).exec(fn)?.[1] ?? null;
          const am = new RegExp('if\\s*\\(\\s*!\\s*hasStatus\\s*\\(\\s*\\w+\\.target\\s*,\\s*(?:Skill\\.)?(\\w+)\\s*\\)\\s*\\)\\s*\\{\\s*'
            + secLocal + '\\s*=\\s*vars\\.(\\w+)\\s*;\\s*\\}').exec(fn);
          if (am && typeof hv[am[2]] === 'number' && skills.has(am[1])) {
            alt = { absent: am[1], absentName: skills.get(am[1]).texts?.name ?? am[1], seconds: hv[am[2]] };
          }
          // Any other write to the local is a value this reader does not have.
          const writes = [...fn.matchAll(new RegExp(`\\b${secLocal}\\s*[-+*/]?=[^=]`, 'g'))].length;
          if (!secVar || writes !== 1 + (alt ? 1 : 0)) continue;
        }
        sites.push({
          index: m.index, call, named,
          seconds: call === 'reduceCooldown' ? hv[secVar] : null, alt, via: null,
        });
      }
      // THE OFF-HAND SPELLING: every `<sk>.reduceCooldown(vars.X)` after the
      // local is declared. The target is the skill the build holds there.
      OFFHAND_SK.lastIndex = 0;
      for (let om; (om = OFFHAND_SK.exec(body));) {
        if (!offhandSkillId) continue;
        const call = new RegExp('\\b' + om[1] + '\\.reduceCooldown\\s*\\(\\s*vars\\.([A-Za-z0-9_]+)\\s*\\)', 'g');
        call.lastIndex = om.index;
        for (let cm; (cm = call.exec(body));) {
          sites.push({
            index: cm.index, call: 'reduceCooldown', named: offhandSkillId,
            seconds: hv[cm[1]], alt: null, via: null, offhandVar: om[1],
          });
        }
      }
      // STATUS-HOSTED. The call can sit one hop away: in the `onStart` of a
      // status the host puts on its owner. Deadeye Focus moved there on build
      // 25782799 - the passive now only rolls and applies
      // Bow_Craft_Passive_Status, and that status's whole onStart is
      // `resetCooldown(Skill.Bow_Craft_Skill1)`
      // (Bow_Craft_Passive_Status.onStart@44930, three ops) - and the reset
      // vanished from the fight without a line, because this loop walks
      // the rows the build OWNS and a status is not one. The event, the roll
      // and the guard are the APPLIER's, read at its addStatus site exactly
      // as a direct call's are; only an onStart that is nothing but the call
      // is followed, so a guard inside the status cannot go unread.
      //
      // onStart runs when the status is CREATED. Whether a re-application
      // while it is still worn runs it again decides nothing: the status is
      // only ever worn while the skill it reset is ready (it resets on
      // arrival and is consumed by the use that starts the next cooldown), so
      // a second roll in that window has no cooldown to give back either way.
      ADD_STATUS.lastIndex = 0;
      for (let m; (m = ADD_STATUS.exec(body));) {
        if (!SELF_TARGETS.has(m[1])) continue;
        const stId = aliases.get(m[2]) ?? m[2];
        const stRow = skills.get(stId);
        if (!stRow?.script) continue;
        const start = hookBody(liveScript(stRow.script), 'onStart');
        const cm = /^\s*(resetCooldown|reduceCooldown)\s*\(\s*Skill\.([A-Za-z0-9_]+)\s*(?:,\s*vars\.([A-Za-z0-9_]+))?\s*\)\s*;?\s*$/.exec(start);
        if (!cm) continue;
        sites.push({
          index: m.index, call: cm[1], named: cm[2],
          seconds: cm[1] === 'reduceCooldown' ? combat.profile(stId, rank, runes)?.vars?.[cm[3]] : null,
          alt: null, via: stId,
        });
      }
      for (const site of sites) {
        const { call, named, seconds, alt } = site;
        const targetId = named ?? hostId;            // skill.kind = the host itself
        // Mutating a skill the fight does not cast. For a weapon row that is
        // a skill the build left unslotted, and there is nothing to say. A
        // TALENT is points spent, so it is read to the end and named below
        // rather than dropped without a line.
        const targetCast = activeIds.has(targetId);
        if (!targetCast && !talentRanks.has(hostId)) continue;
        if (call === 'reduceCooldown' && !(typeof seconds === 'number' && seconds > 0)) continue;
        const before = body.slice(0, site.index);
        const from = raisedFrom(body, site.index);
        const hook = from.hook;
        // Through a helper, the guards in front of the helper's CALL gate the
        // site as much as the helper's own.
        let scope = (from.callAt != null ? enclosingBlock(body.slice(0, from.callAt)) + ' ' : '') + enclosingBlock(before);
        const targetName = skills.get(targetId)?.texts?.name ?? targetId;
        if (!targetCast) {
          // A HELD TALENT HANDING COOLDOWN TO A SKILL THIS FIGHT DOES NOT
          // CAST. Prosecutor is the row: `reduceCooldown(Skill.
          // Priest_Sig_DivineIntervention, vars.time)` on a critical attack or
          // combo finisher, 15% of the time. Judgment is a cast here for the
          // prayers it releases, or for the timed buff one of two runes hangs
          // on it (Spirited Disciple, Revitalized Soul); in a build that
          // slots no prayer, with Alacrity or no rune, it has nothing to
          // release and nothing to put up (`idleReleasers`), the fight does
          // not press it, the time buys no cast, and the node scored zero
          // in silence. With no prayer to release that is how the game has
          // it as well - Judgment's own checkEnabled refuses the press -
          // and the sentence says so; it is filed with the things not
          // scored, under the talent, either way.
          // Footwork is the other row: five seconds off Dash each time
          // Lethal Poison is applied, and no fight here dashes - a gap of
          // this model's, not a fact about the game.
          if (!guardOf(scope, { rank, runes, talents }).fires) continue;   // rank/talent-gated off
          if (unmodelled.some((u) => u.id === hostId && u.cdTarget === targetId)) continue;
          const hostName = hs.texts?.name ?? hostId;
          unmodelled.push({
            id: hostId, name: hostName, kind: 'conditional', cdTarget: targetId,
            why: `${hostName} ${call === 'resetCooldown' ? `resets ${targetName}'s cooldown`
              : `gives back ${seconds}s of ${targetName}'s cooldown`}, and ${targetName} is not a cast this fight makes`
              + (idleReleasers.has(targetId)
                ? ' - it is pressed for what it releases, and nothing in this build is released by it'
                : '')
              + (unmodelled.some((u) => u.id === targetId) ? ' (it is in this list itself)' : '')
              + (idleReleasers.has(targetId)
                ? ', so the time buys nothing and the talent is not scored'
                : ', so the time buys nothing in this model and the talent is not scored'),
          });
          continue;
        }
        // `onSkillProc(ctx) { if (ctx.skill == skill) resetCooldown(Skill.X) }`
        // is not "an event this fight does not produce": onSkillProc is raised
        // once per skill USE (tryConsumeCharge@9631) and the guard keeps the
        // host's own. It is the host being pressed.
        const ownPress = hook === 'onSkillProc' && /\b\w+\.skill\s*==\s*skill\b/.test(scope);
        if (ownPress && call === 'resetCooldown' && activeIds.has(hostId)) {
          cdMutations.push({
            host: hostId, target: targetId, on: 'host', supply: null, chance: 1, critGated: false,
            kind: 'reset', seconds: 0, alt: null, via: null, instant: null,
            why: `${hs.texts?.name ?? hostId} resets ${targetName}'s cooldown when it is pressed`,
          });
          continue;
        }
        if (ownPress) {
          // The host is not a cast this fight makes (it deals nothing and
          // carries no stat the model reads), so its press - and everything
          // that hangs off it - has no event. Say what hangs off it: the
          // reset, and what the TARGET's own script does while the status
          // the host applies is up.
          const hostName = hs.texts?.name ?? hostId;
          const tBody = liveScript(skills.get(targetId)?.script ?? '');
          const ov = /if\s*\(\s*hasStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)\s*\)\s*\)\s*\{?\s*return\s+([\d.]+)\s*;/
            .exec(hookBody(tBody, 'onCooldownEval'));
          const stRow = ov ? skills.get(ov[1]) : null;
          const applied = !!stRow && statusIdsOf(hostId, { runes, rank, talents, talentRanks }).includes(ov[1]);
          const inc = applied
            ? /timer\s*>=\s*vars\.(\w+)[\s\S]{0,80}?addAtb\s*\(\s*owner\s*,\s*Attribute\.(\w+)\s*,\s*([\d.]+|vars\.\w+)\s*\)/
              .exec(hookBody(liveScript(stRow.script ?? ''), 'onRegUpdate')) : null;
          const incN = inc ? (inc[3].startsWith('vars.') ? stRow.vars?.[inc[3].slice(5)] : Number(inc[3])) : null;
          unmodelled.push({
            id: hostId, name: hostName, kind: 'conditional',
            why: `${hostName} deals nothing itself and is not pressed in this fight, so what it sets off is not `
              + `scored: pressing it resets ${targetName}'s cooldown`
              + (applied
                ? `, and for the ${stRow.duration}s of ${stRow.texts?.name ?? ov[1]} it applies ${targetName}'s own script `
                  + `answers its cooldown with ${ov[2]}s (onCooldownEval)`
                  + (inc && typeof incN === 'number'
                    ? ` while the status adds ${incN} ${inc[2]} every ${stRow.vars?.[inc[1]]}s` : '')
                  + '. The fight has no cooldown that changes while a buff is up'
                  + ((active.find((a) => a.prof.id === targetId)?.prof.costs ?? []).some((c) => tracked.has(c.atb) && !c.all && !c.spendOnly)
                    ? `, and it presses ${targetName} only when it can pay its whole cost` : '')
                  + ` - so ${targetName} is cast less often here than in game inside that window`
                : `, so ${targetName} comes back slower here than in game`),
          });
          continue;
        }
        // HOW MANY ENEMIES THE CAST HIT is stated, like the target's health:
        // `dmg.ctx.totalHits >= vars.var1` is Blinding Light's rank-3 "If 2 or
        // more enemies are hit, the cooldown is reduced" - a question
        // `--targets` answers. The comparison rides the mutation and the
        // fight drops it where the stated count fails it.
        let needsTargets = null;
        {
          const tm = /\b\w+(?:\.\w+)*\.totalHits\s*(>=|>|==)\s*(?:vars\.(\w+)|(\d+))/.exec(scope);
          const n = tm ? (tm[2] ? hv[tm[2]] : Number(tm[3])) : null;
          if (tm && typeof n === 'number') { needsTargets = { op: tm[1], n }; scope = scope.replace(tm[0], ' '); }
        }
        if (!hook || !KNOWN_HOOKS.test(hook)) {
          // A clause this build has SWITCHED OFF is not a missing cooldown.
          // The rank gate and the rune/talent gate are answerable whatever the
          // hook, so they are asked before anything is said: Deceiver Trick's
          // reset is its rank-3 line (`if (rank >= 3) { wait(0, () -> {
          // gainStack(); }); }` in the hook that calls the helper, which is
          // why the caller's scope is in `scope`), Unstable Goo's is `if (rank
          // >= 3)` in onStatusConsumed, and both were printed as missing at
          // ranks 1 and 2, where the script never reaches the call.
          if (!guardOf(scope, { rank: hostRank, runes, talents }).fires) continue;
          // NAME WHO LOSES OUT, and say the host is fine. This entry is filed
          // under the skill whose SCRIPT carries the call, which reads as "this
          // skill is not scored" - and Rampage is scored, every cast of it. What
          // is missing is a cooldown Shockwave never gets back. A reader
          // checking why Rampage looked low was being pointed at the wrong
          // skill entirely.
          const hostName = hs.texts?.name ?? hostId;
          // What the lead may say about the host's OWN damage is asked of the
          // rotation, not of the cast alone - there are three true answers:
          //   * the fight scores some: its cast, a step played for it on an
          //     event, a dot it applies, a summon it calls. Unstable Goo is a
          //     passive - nothing is "cast" - whose damage is the Ignited Goo
          //     ticks on their own line, and it IS scored;
          //   * it has damage and none of it is scored. Deceiver Trick lost
          //     its cast-time hit on build 25782799 - all it deals is the step
          //     played when a foe leaves its area, refused on its own line -
          //     and the sentence went on saying it was scored;
          //   * it has no damage this reader knows of, and nothing is claimed.
          const scored = scoresDamage(hostId);
          const hp = combat.profile(hostId, hostRank, runes);
          const unscoredOwn = !scored && (dealsDamage(hp)
            || (hp?.scripted ?? []).some((st) => dealsDamage(st))
            || dots.some((d) => d.from === hostId && dealsDamage(d.prof)));
          // "On the cast itself" is said only of a skill the fight presses.
          const lead = scored ? `${hostName}'s own damage IS scored; what is not is`
            : !unscoredOwn ? `What is not scored of ${hostName} is`
              : activeIds.has(hostId) && !dealsDamage(hp)
                ? `${hostName} deals nothing on the cast itself; what is also missing is`
                : `${hostName}'s own damage is not scored either; what is also missing is`;
          unmodelled.push({
            id: hostId, name: hostName, kind: 'conditional',
            // A skill that gives ITSELF the cooldown back says so plainly.
            why: targetId === hostId
              ? `${lead} its own cooldown coming back early - `
                + `its script ${call === 'resetCooldown' ? 'resets' : 'shortens'} it from `
                + `${/^[aeiou]/i.test(hook ?? 'top') ? 'an' : 'a'} ${hook ?? 'top-level'} hook, an event this fight `
                + 'does not produce, so it is pressed less often here than in game'
              : `${lead} the cooldown it gives `
              + `${targetName} - its script ${call === 'resetCooldown' ? 'resets' : 'shortens'} `
              + `${targetName}'s cooldown from ${/^[aeiou]/i.test(hook ?? 'top') ? 'an' : 'a'} `
              + `${hook ?? 'top-level'} hook, an event this fight does not produce, so `
              + `${targetName} comes back slower here than in game`,
          });
          continue;
        }
        // `hasStatus(hit.target, <Mark>)` where the Mark is applied by ANOTHER
        // skill this build runs is a rotation fact, not unreadable live state:
        // Skill2 marks on every damage instance it deals, so a build weaving
        // both has a Mark waiting essentially every dash. Resolved through the
        // script's own alias table and stripped from the guard. Whether a
        // mark IS waiting is the fight's to say: it is a status with a life
        // of its own, laid by whichever supplier lands (`mark`, below).
        // (the off-hand site's own `sk != null` is the loadout fact this
        // site was admitted on)
        let scope2 = site.offhandVar
          ? scope.replace(new RegExp('\\b' + site.offhandVar + '\\s*!=\\s*null\\b'), ' ') : scope;
        const markSuppliers = new Set();
        // The mark itself, off its own row: how long it stands on the target
        // and how many of it the target can hold (one, unless the row stacks).
        let mark = null;
        {
          const aliases = new Map();
          SKILL_ALIAS.lastIndex = 0;
          for (let am; (am = SKILL_ALIAS.exec(body));) aliases.set(am[1], am[2]);
          const HAS_T = /hasStatus\s*\(\s*[\w.]+\s*,\s*(?:Skill\.)?([A-Za-z_][\w]*)\s*\)/g;
          for (let hm; (hm = HAS_T.exec(scope));) {
            const stId = aliases.get(hm[1]) ?? hm[1];
            for (const sid of seen) {
              if (sid === hostId) continue;
              const other = skills.get(sid);
              const applies = new RegExp(`addStatus\\s*\\([^)]*${stId}\\b`).test(String(other?.script ?? ''))
                || (other?.steps ?? []).some((x) => x.props?.status?.ref === stId
                  || (x.effects ?? []).some((ef) => ef.status === stId));
              if (applies) markSuppliers.add(sid);
            }
            if (markSuppliers.size) {
              scope2 = scope2.replace(hm[0], ' ');
              const mr = skills.get(stId);
              mark = {
                status: stId,
                duration: typeof mr?.duration === 'number' && mr.duration > 0 ? mr.duration : null,
                stacks: Math.max(1, mr?.props?.status?.maxStacks ?? 1),
              };
            }
          }
        }
        // "ALL YOUR [MAGIC] CRITICAL STRIKES" is an event too. Pyroclasm's
        // rank-3 reset is `if (dmg.isMagic && dmg.critical && rank >= 3) { if
        // (checkProba(vars.chance)) { addStatus(owner, Proc); resetCooldown(); }
        // }` in onInflictDamage - owner-wide, no swing or skill named, so it
        // rides every Magic damage instance that crits, whoever's cast it
        // came from. The fight prices a crit expectation for every cast and
        // swing, so the count is there; it is taken off those and not off
        // triggered lines or ticks, which makes the rate a floor.
        const magicCrit = /^onInflict(Damage|Hit)$/.test(hook) && !eventsOf(scope).size
          && /\bisMagic\b/.test(scope) && /\bcritical\b|\bisCrit\b/.test(scope)
          && !new RegExp(`skillId\\s*==\\s*Skill\\.${hostId}`).test(scope);
        const g = guardOf(magicCrit ? scope2.replace(/\b(?:isMagic|critical|isCrit)\b/g, ' ') : scope2,
          { rank, runes, talents });
        if (!g.fires) continue;                       // rank/talent-gated off: dead for this build
        if (g.unread && !/^(critical|isCrit)$/.test(g.unread)) {
          unmodelled.push({
            id: hostId, name: hs.texts?.name ?? hostId, kind: 'conditional',
            why: `its script ${call === 'resetCooldown' ? 'resets' : 'shortens'} ${targetName}'s `
              + `cooldown, but only while ${g.unread}() holds - which this reader cannot evaluate`,
          });
          continue;
        }
        let chance = 1;
        const cv = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope)?.[1];
        if (cv && typeof hv[cv] === 'number') chance = hv[cv];
        const critGated = !magicCrit && /\bcritical\b|\bisCrit\b/.test(scope);
        // Which event carries it: the host's own landing when the hook is
        // per-skill or the guard names the host's own skillId; otherwise the
        // events the guard states.
        const ownHit = /^on(Damage|DamageEval|FirstHit|Hit|HitNewTarget)$/.test(hook)
          || new RegExp(`skillId\\s*==\\s*Skill\\.${hostId}`).test(scope);
        const ev = eventsOf(scope);
        if (!ownHit && !ev.size && !magicCrit) continue;   // no producible event stated
        // The instant cast that comes with it - only where the reset's own
        // site puts the status up: the status whose onStart IS the reset, or
        // an `addStatus(owner, <it>)` in the same block as the call.
        const instant = call !== 'resetCooldown' ? null
          : site.via ? instantOf(targetId, site.via)
            : (() => {
              const st = instantStatusOf(targetId);
              if (!st) return null;
              const names = [`Skill\\.${st}`, ...[...aliases].filter(([, v]) => v === st).map(([k]) => k)];
              return new RegExp('addStatus\\s*\\(\\s*owner\\s*,\\s*(?:' + names.join('|') + ')\\s*\\)')
                .test(blockAround(body, site.index)) ? instantOf(targetId, st) : null;
            })();
        cdMutations.push({
          host: hostId, target: targetId,
          on: ownHit ? 'host' : magicCrit ? 'magic-crit' : ev.has('combo') && ev.has('attack') ? 'attack-or-combo'
            : ev.has('combo') ? 'combo' : ev.has('attack') ? 'attack' : 'weapon-skill',
          // The reset SPENDS a mark another skill supplies, so the fight banks
          // one per supplier cast and each reset consumes one - "the mark is
          // always up" briefly stood here unbanked, and the sim promptly
          // pressed the dash at three times the rate its marks could arrive.
          supply: markSuppliers.size ? [...markSuppliers] : null,
          // ...and the mark is a STATUS on the target: it stands for its own
          // duration and the target holds as many as its row stacks to, so a
          // supplier that lands while one is up refreshes it and banks nothing
          // more (`mark`). A supplier is whichever of them LANDS - the chain's
          // finisher is one when its hit carries the mark (Demonic Bite), and
          // it is not a press.
          mark: markSuppliers.size ? mark : null,
          chance, critGated,
          kind: call === 'resetCooldown' ? 'reset' : 'reduce',
          seconds: seconds ?? 0,
          alt,
          // The status the call was reached through, when it was.
          via: site.via,
          instant,
          ...(needsTargets ? { needsTargets } : {}),
          why: `${hs.texts?.name ?? hostId} ${call === 'resetCooldown' ? 'resets' : `gives back ${seconds}s of`} `
            + (targetId === hostId ? 'its own cooldown' : `${targetName}'s cooldown`)
            // The uses an onSkillProc clause rides are not the host's own
            // landing, so they are said.
            + (hook === 'onSkillProc' && !ownHit
              ? (ev.has('combo') && ev.has('attack') ? ' each time you swing or use the combo finisher'
                : ev.has('combo') ? ' each time you use the combo finisher'
                  : ev.has('attack') ? ' each time you swing' : ' each time you use a weapon skill')
              : '')
            + (critGated ? ' on a critical strike' : '')
            + (magicCrit ? ' when a Magic hit of yours critically strikes' : '')
            + (needsTargets ? ` when the cast hits ${needsTargets.op} ${needsTargets.n} enemies` : '')
            + (chance < 1 ? `, ${Math.round(chance * 100)}% of the time` : '')
            + (alt ? ` (${alt.seconds}s when the target does not carry ${alt.absentName})` : '')
            + (instant
              ? ` and makes the next one instant${Number.isFinite(instant.window) ? ` if it is cast within ${instant.window}s` : ''}`
                + (instant.rider ? ` - that cast takes +${Math.round(instant.rider.amount * 100)}% damage` : '')
              : ''),
        });
        // ...and the same call on ANOTHER SKILL'S HITS, where the `if` it
        // sits behind names them as an alternative (`namedSkillArm`).
        // Nectar-infused Blade's refund is inside the block that runs on a
        // swing OR on a hit of a rank-3 Flower Spiral, so each spin that
        // crits gives the second back too - counted on swings only until
        // now. Every damage instance of that skill's cast rolls on its own
        // ('skill-hit'); the status-hosted and instant shapes are not this.
        if (!ownHit && !magicCrit && !site.via && /^onInflict(?:Damage|Hit)$/.test(hook)) {
          const arm = namedSkillArm(scope, body, hostRank);
          if (arm && arm.skill !== hostId && activeIds.has(arm.skill)) {
            const armName = skills.get(arm.skill)?.texts?.name ?? arm.skill;
            cdMutations.push({
              host: hostId, target: targetId, on: 'skill-hit', of: arm.skill, supply: null,
              chance, critGated, kind: call === 'resetCooldown' ? 'reset' : 'reduce', seconds: seconds ?? 0,
              alt, via: null, instant: null,
              why: `${hs.texts?.name ?? hostId} ${call === 'resetCooldown' ? 'resets' : `gives back ${seconds}s of`} `
                + (targetId === hostId ? 'its own cooldown' : `${targetName}'s cooldown`)
                + ` on every hit of ${armName}`
                + (critGated ? ' that critically strikes' : '')
                + (chance < 1 ? `, ${Math.round(chance * 100)}% of the time` : ''),
            });
          }
        }
      }
    }
    // A row whose mechanism the fight plays is not "everything it does lives
    // in its hscript body" - Deadeye Focus would sit under that sentence with
    // its reset priced. Only that sentence is withdrawn: a row filed for a
    // reason of its own keeps it.
    for (let i = unmodelled.length - 1; i >= 0; i--) {
      if (unmodelled[i].blanket && cdMutations.some((mu) => mu.host === unmodelled[i].id)) unmodelled.splice(i, 1);
    }

    // A FOLLOW-UP THAT THROWS ONE PROJECTILE PER CHARGE IT HOLDS. Expulse's
    // recast (Book of Mi'Mizan) is the shape:
    //
    //   var orbCount = getStatusCount(owner, Skill.<Charge>);
    //   for (i in 0...orbCount) { delay(.., () -> { consumeStatus(owner, Skill.<Charge>, 1); playStep(Steps.Shoot); }); }
    //
    // (the count through a one-line helper of its own since build 25959898 -
    // inlineReturnHelpers puts it back) and its parent hands it the charges: one per object of a NAMED skill it
    // pulls in (`owner.getSkill(Skill.X)?.getSkillObjects()`, each played
    // back as a Status step of that charge, with a `break` at a literal
    // count). So the recast is worth nothing without X's objects, one orb
    // with one, and up to the break's count with a full spawn - and how many
    // X leaves lying about when the parent is pressed is a bank this fight
    // does not keep (X spends its own counter into objects that last the
    // object step's duration). The follow-up was priced at one, said
    // nowhere, behind a parent that was never pressed. It stays at ONE - the
    // object X spawns with nothing banked - only when X is in the build, and
    // the sentence names every number it leaves out.
    for (let i = triggered.length - 1; i >= 0; i--) {
      const t = triggered[i];
      if (t.rule?.kind !== 'per-parent-cast' || !t.rule.parent || t.source === 'scripted') continue;
      const strip = (id) => inlineReturnHelpers(liveScript(skills.get(id)?.script ?? '').replace(/\s+/g, ''));
      const fm = /var(\w+)=getStatusCount\(owner,(?:Skill\.)?(\w+)\);for\(\w+?in0\.\.\.\1\)\{delay\([^{}]*\(\)->\{consumeStatus\(owner,(?:Skill\.)?\2,1\);playStep\(Steps\.(\w+)\);\}\);\}/.exec(strip(t.prof.id));
      if (!fm) continue;
      const pb = strip(t.rule.parent);
      const src = /owner\.getSkill\(Skill\.(\w+)\)/.exec(pb)?.[1] ?? null;
      const most = Number(/if\(\w+>=(\d+)\)\{break;\}/.exec(pb)?.[1]);
      const srcRow = src ? skills.get(src) : null;
      const objStep = (srcRow?.steps ?? []).find((x) => (stepTypeNames[x.type ?? -1] ?? '') === 'SkillObject');
      const chargeName = skills.get(fm[2])?.texts?.name ?? fm[2];
      const parentName = skills.get(t.rule.parent)?.texts?.name ?? t.rule.parent;
      const srcName = srcRow?.texts?.name ?? src;
      const held = !!src && active.some((a) => (a.via ?? a.prof.id) === src);
      if (!src || !objStep) continue;
      if (!held) {
        triggered.splice(i, 1);
        unmodelled.push({
          id: t.prof.id, name: t.prof.name, kind: 'off in this build',
          why: `${t.prof.name} throws one projectile for every ${chargeName} it holds, ${parentName} gets those by pulling in `
            + `what ${srcName} leaves on the ground, and ${srcName} is not in this build - so there is nothing to throw`,
        });
        continue;
      }
      unmodelled.push({
        id: t.prof.id, name: t.prof.name, kind: 'assumption',
        why: `${t.prof.name} (the recast) throws one projectile for every ${chargeName} it holds and is priced at ONE per `
          + `${parentName}. ${parentName} gets them by pulling in what ${srcName} left on the ground`
          + (Number.isFinite(most) && most > 0 ? ` - ${most} at most` : '')
          + (Number(objStep.duration) > 0 ? `, each lying there ${Number(objStep.duration)}s` : '')
          + ` - and how many that is at each press is a count this fight does not keep: ${srcName} spawns one with nothing `
          + 'banked and one more per charge of its own counter. So the line is the single-object case, and it '
          + `assumes ${/^[aeiou]/i.test(srcName ?? '') ? 'an' : 'a'} ${srcName} shortly before every ${parentName}`,
      });
    }

    // WHICH ENTRIES LAND A SKILL'S HIT ON THE HERO WHO PLAYS THEM - what a
    // window opened by "a skill of yours lands on an ally" asks of each press
    // and of each rider that fires (Sunlight is the row). The pressed row is
    // the one whose steps are played: `via` where the entry is priced off the
    // status that row applies, the id otherwise; a `host#step` rider is asked
    // about its own step alone.
    // ...and the presses whose only worth is that landing join the rotation
    // where a rider of the build waits for one (`selfLanders`).
    if (selfLanders.length && triggered.some((tr) => tr.rule?.window?.opensOn?.allyHit)) {
      for (const e of selfLanders) if (!active.some((a) => a.prof.id === e.prof.id)) active.push(e);
    }
    for (const e of [...active, ...triggered]) {
      const [row, step] = String(e.prof.id).split('#');
      const lands = step ? landsOnCaster(row, step, rank, runes) : landsOnCaster(e.via ?? row, null, rank, runes);
      if (lands) e.landsOnCaster = lands;
    }

    // WHO CAN SPEND A USE RIDER (`useRiderOf`): a pressed row of a skill type
    // (`ctx.isSkill`) that holds an effect of the damage type the script asks
    // canDoMagicDamage / canDoPhysicalDamage for. The pressed row is the one
    // whose steps are walked - `via` where the entry is priced off a status
    // that row applies - and an effect that names no affinity is Physical to
    // $HSkill.getDamageType@21763 (ops 0-9).
    for (const u of useRiders) {
      const holds = (rowId) => (skills.get(rowId)?.steps ?? []).some((st) => (st.effects ?? [])
        .some((e) => (e.affinity ? combat.affinityOf(e.affinity).root : 'Physical') === u.root));
      u.spenders = [...new Set(active
        .map((a) => a.via ?? String(a.prof.id).split('#')[0])
        .filter((rowId) => (HIT_SKILL_TYPES.has(typeOf(rowId)) || HIT_SKILL_IDS.has(rowId)) && holds(rowId)))];
      // The step it plays while its cooldown runs is priced by the fight
      // (sim.mjs `useRegs`), so the gap reader's "only while isInCooldown()
      // holds" refusal of that step no longer describes it.
      if (u.critStep) accountedLate.add(u.critStep.prof.id);
    }

    return {
      useRiders,
      filler, active, triggered, passive, dots: liveDots,
      // `accountedLate` is filled by passes that run after `accounted` is
      // built, so it is applied here rather than folded in above.
      unmodelled: unmodelled.filter((u) => !accounted.has(u.id) && !accountedLate.has(u.id) && !pendingBankSteps.has(u.id)),
      selection: sel, runes: [...runes], rank, chain, cdMutations, sparkGauge,
      resources: { gains, tracked: [...tracked], capOverride: poolCapOverride },
      summons,
      chargeDump,
      stackMult,
      // What rides the build's own statuses' hits, off live state - see the
      // block above `summons`.
      dotRiders, comboBank, statusHooks,
      wsRider,
      wsRiders,
      comboRider,
      ownerRiders,
      armorIgnores,
      wsReset,
      // Chainstrike (Mage_Talent_ChainStrike), read by its shape:
      // `onInflictDamageEval(hit) { if (hit.skill.isBaseAttack() &&
      // hasStatus(owner, Skill.<S>)) hit.dmgMult += vars.damage; }`
      // (Mage_Talent_ChainStrike.onInflictDamageEval@45453: op 3
      // BaseSkill.isBaseAttack@6153, ops 14-16 hasStatus, ops 17-27 the add). <S> is
      // the chain's own arm status, which the fight already
      // tracks, so the sim applies the rider to the swings that land while an
      // arm is banked - the window between the arming cast and the next
      // weapon skill. Contributed exactly zero before, on a state the sim had.
      //
      // Two things this used to get wrong. isBaseAttack is skill types 0-3
      // OR 4 (the finisher included - BaseSkill.isBasicAttack@6152 is the 0-3 one), so
      // the finisher takes the rider too. And the amount is the row's vars AT
      // THE TALENT'S RANK through props.rankOverride (0.15, 0.3 from two
      // points): the script adds vars.damage once, and `vars x points` only
      // agreed with the override by coincidence.
      chainStrike: (() => {
        for (const [tid, pts] of Object.entries(loadout.talents ?? {})) {
          if (!(pts > 0)) continue;
          const tb = liveScript(skills.get(tid)?.script ?? '');
          const m = /function\s+onInflictDamageEval\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\.skill\??\.(isBaseAttack|isBasicAttack)\s*\(\s*\)\s*&&\s*hasStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)\s*\)\s*\)\s*\{\s*\1\.dmgMult\s*\+=\s*vars\.(\w+)\s*;\s*\}\s*\}/.exec(tb);
          if (!m) continue;
          const v = combat.profile(tid, pts, runes)?.vars?.[m[4]];
          if (typeof v === 'number' && v > 0) {
            return { amount: v, status: m[3], from: tid, finisher: m[2] === 'isBaseAttack' };
          }
        }
        return null;
      })(),
    };
  }

  // --- steps the cast does not play ----------------------------------------
  //
  // `damage.mjs` splits a skill's `on: Code` steps out of its cast output,
  // because the game plays those from `playStep(Steps.<id>)` and from nothing
  // else. This puts them back on the clock the script actually gives them,
  // through the same trigger machinery every other proc uses.
  //
  // The hooks accepted here are the ones that ride an event this fight
  // produces. Everything else - onGameBeat (you blocked), onReceiveDamage (you
  // were hit), onAreaExited, onStop, onStacksChange, onUpdate, checkStop - is
  // refused with the hook named, because a rider on an event the fight does not
  // raise is worth zero and the zero is a statement about the fight model.
  //
  // `onDamage` / `onDamageEval` / `onHit` see only the host's OWN hits - the
  // same reading that separates Bonethrow's per-skill pool from Hemorrhage's
  // owner-global `onInflictDamage` - so they schedule against the host's own
  // rate. `onAreaElapsed` is the same thing on a delay: the cast drops an area
  // and the area's own timer runs out, which is a delayed detonation and one
  // fire per cast. Staff_Censer_Skill2 is that shape and nothing else -
  // `onAreaElapsed(a, ctx) { playStep(Steps.Explosion, null, a.position); }`,
  // no guard at all - and refusing it cost the Mage its best weapon.
  //
  // `onAreaExited` is NOT in the list and must not be: Halos_Demon_Skill2
  // plays its damage when the target LEAVES a leash, and the simulated foe
  // does not move. That zero is real, and it is a statement about the fight
  // model rather than about the data.
  //
  // `onStartConduit` is the same shape one level out: a conduit has no cast at
  // all, it IS the trigger, so a step its own script plays on that hook happens
  // exactly once per conduit fire. `Mage_Talent_ConduitSparkExplosion_Conduit`
  // keeps its whole 0.25 x Intellect there, and without this the conduit landed
  // in the rotation carrying nothing while the step it plays was refused beside
  // it - the same circle Staff_Censer_Skill2 fell into.
  // `onInflictStatusEval` earns its place here on measurement, not taste. Held
  // against a live capture of the accepted build, skills declaring it carried
  // 35.6% of a Rogue's damage - Daggers_DuplicatePoison_Skill1 alone was 24.9%,
  // priced by this model at eighteen hits where the game recorded two thousand
  // eight hundred, because the hook that produces them was never an event this
  // reader believed in. (That row's script is EMPTY on build 25782799 and the
  // step it played is gone; the hook is still raised, by GameObject.addStacks@4637, for
  // the rows that keep one.)
  //
  // `onProc` is the cast itself. Skill.tryConsumeCharge@9631 runs once per
  // use (op 0 returns when the charge was already taken): ops 67-121 raise
  // onSkillProc on every skill and status the owner carries, and ops 122-124
  // then call the pressed skill's OWN script through the slot next to it -
  // onProc. Heat Emission moved its Burst there on build 25782799 and was
  // refused as "an event this fight does not produce", about the one event the
  // fight produces for every skill it presses.
  //
  // `onProjectileEnd` is the cast's too: ent.Projectile.onProjectileEnd@6409
  // hands a closure the projectile's own skill and that closure calls the
  // skill script's onProjectileEnd once for the projectile that ended.
  // Castigate moved its Splash there on build 25782799, behind
  // `proj.skillContext.projectiles.length <= 1` - the last bolt of the four
  // - so once per cast. How many projectiles a cast has left is read only in
  // that spelling; any other count stays a refusal.
  const RIDER_HOOKS = /^on(InflictHit|InflictDamage|InflictDamageEval|InflictStatusEval|Damage|DamageEval|FirstHit|Hit|Start|CastEnd|AreaElapsed|StartConduit|Proc|ProjectileEnd)$/;
  const OWN_CAST_HOOKS = /^on(Damage|DamageEval|FirstHit|Hit|Start|CastEnd|AreaElapsed|StartConduit|Proc|ProjectileEnd)$/;

  // A STEP NOTHING PLAYS. An `on: Code` step runs when a script calls
  // `playStep(Steps.<id>)` and at no other time, so a named step that no
  // script in the install names is left in the row and deals nothing - it is
  // not a rate the model failed to find. Build 25782799 left one on Virulent
  // Contamination: the talent's script was rewritten to bank a share of the
  // crit as a pool (`addStatus(dmg.target, <status>, dmg.amount *
  // vars.damage)`) and its old `Damage` step, 0.4 x Intellect, stayed in the
  // row with no call site anywhere - while the node was filed as "declares
  // damage but no trigger rate can be derived" beside the pool the fight was
  // scoring for it.
  //
  // "No script" means the row's own and every other row's that mentions this
  // one (a step can be played from outside: Lethal Poison's Blast is, by the
  // talent), and "names" means the token `Steps.<id>` anywhere in it - there
  // is more than one call that plays a step (playStep, playAreaStepFromPt,
  // ...) and a script may hold the step in a local first. A row that plays
  // ANY step by index rather than by name is not judged, and neither is a row
  // with no script at all: its steps are somebody else's to play.
  //
  // Asked of TALENT rows only (see `profileOf`). A node has no cast and no AI,
  // so its script really is the only thing that can play its steps; for a
  // weapon passive or a status the same test finds a handful more (Cinder
  // Coat's MagicDamage, Dark Gift's SelfDamage) that are probably leftovers
  // too, and those keep the sentence they had until someone reads them.
  const deadStepCache = new Map();
  function stepIsDead(rowId, stepId) {
    if (!stepId) return false;
    const key = rowId + '#' + stepId;
    if (deadStepCache.has(key)) return deadStepCache.get(key);
    const names = new RegExp('\\bSteps\\.' + stepId + '\\b');
    const own = liveScript(skills.get(rowId)?.script ?? '');
    let dead = own.trim().length > 0 && !names.test(own)
      && !/\bplay\w*Step\w*\s*\(\s*(?!Steps\.)[\w.]+\s*[,)]/.test(own)
      // ...and no other step of the row chains into it (props.startSteps).
      && !(skills.get(rowId)?.steps ?? []).some((st) => (st.props?.startSteps ?? [])
        .some((e) => (e?.step ?? e) === stepId));
    if (dead) {
      for (const o of cdb.lines('skill')) {
        if (o.id === rowId || !o.script || !o.script.includes(rowId)) continue;
        if (names.test(liveScript(o.script))) { dead = false; break; }
      }
    }
    deadStepCache.set(key, dead);
    return dead;
  }

  function scriptedRiders(skillId, prof, opts = {}) {
    const riders = [];
    const refused = [];
    if (!prof?.scripted?.length) return { riders, refused };
    const s = skills.get(skillId);
    const body = liveScript(s?.script ?? '');
    const name = prof.name;

    // A CAST THAT SPENDS A BANK. Flower Spiral's onStart is the shape:
    //
    //   var stackCount = getStatusCount(owner, Skill.<Charge>);
    //   consumeStatus(owner, Skill.<Charge>, 1000);
    //   if (stackCount == 0) { playStep(Steps.StartBaseArea); ... }
    //   else { for (i in 0...(stackCount + 1)) {
    //     if (i < stackCount) { wait(.., function() { playStep(Steps.AdditionalArea); }); }
    //     else { wait(.., function() { playStep(Steps.StartBaseArea); ... }); } }; }
    //
    // Read whole or not at all. It says two things the site-by-site reader
    // cannot: the first step is played EXACTLY ONCE by every cast (the empty
    // branch plays it, and the loop's last turn plays it), and the second
    // once per charge spent. The count is a local, so reading the two
    // `if`s for live-state words found none in them and one in the
    // statement above - which refused the certain spin for "only while
    // getStatusCount() holds".
    const spend = (() => {
      const sp = bankSpendOf(body);
      return sp && skills.get(sp.status) ? sp : null;
    })();

    for (const step of prof.scripted) {
      const label = `${name}'s ${step.stepId ?? 'unnamed'} step`;
      if (!step.stepId) {
        // With no script on the row there is no script to play it from, and
        // saying "played only from script" about it is a reason that is
        // false. Gaping Wound is the row: its 0.35 x Dexterity step is
        // `on: Trigger`, the script that used to sit beside it was emptied in
        // build 25782799, and what raises a Trigger step is not something
        // this model reads. Not the cast, not a script: unscored, and said so.
        refused.push({
          step: null,
          why: body.trim()
            ? `${label} is played only from script and carries no id, so no playStep call can name it`
            : `${label} is not part of the cast (it is authored \`on: ${step.on ?? 'Code'}\`) and the row carries no `
              + 'script on this build, so nothing this model reads plays it',
        });
        continue;
      }
      // A step ANOTHER step starts is played wherever that one is.
      // `props.startSteps` on Flower Spiral's StartBaseArea names BaseArea,
      // and the profile already carries that pair as the STARTER's entry
      // (`viaStartStep`, with the started step's effects). So a step no
      // playStep call names, which a starter stands in for, is neither
      // priced a second time nor refused - "nothing in the row says when"
      // was false of it.
      if (prof.scripted.some((x) => x.viaStartStep === step.stepId)
        && !new RegExp(`\\bplayStep\\s*\\(\\s*Steps\\.${step.stepId}\\b`).test(body)) continue;
      if (spend && step.stepId === spend.once) {
        const stName = skills.get(spend.status)?.texts?.name ?? spend.status;
        riders.push({
          step,
          rule: {
            kind: 'per-parent-cast', parent: skillId, chance: 1, divisor: 1, perCast: 1, critGated: false,
            why: `${label} is played once by every cast - its script plays it whether or not it holds any ${stName}`,
          },
        });
        continue;
      }
      if (spend && step.stepId === spend.perStack) {
        const stName = skills.get(spend.status)?.texts?.name ?? spend.status;
        const cap = maxStacksOf(spend.status, opts.rank ?? 1);
        refused.push({
          step: step.stepId, kind: 'no rate',
          why: `${label} is played once for every ${stName} the cast spends`
            + (Number.isFinite(cap) ? ` - it can hold ${cap}` : '')
            + ' - and how many are banked at each press is a count this fight does not keep, so the cast is '
            + 'priced at the one spin it always plays and every banked one is missing',
        });
        continue;
      }
      const re = new RegExp(`\\bplayStep\\s*\\(\\s*Steps\\.${step.stepId}\\b`, 'g');
      let rule = null;
      let why = null;
      // The gate is a fact about THIS build - a rank the weapon has not reached
      // or a rune it did not slot - rather than a hole in the model, so it is
      // reported under its own cause.
      let gated = false;
      // ...and so is a step that waits on a status no row this build holds
      // applies: read, answered, and the answer is "never" (see TARGET_HELD).
      let offBuild = false;
      // ...and so is a step whose only play sites are hooks the fight never
      // raises (a kill, a block): read, and not something a point can buy here.
      let sites = 0, unraisedSites = 0;
      const healthSites = [];
      const alsoSites = [];
      let holdHealthSite = false;
      for (let m; (m = re.exec(body)) && !rule;) {
        sites++;
        const before = body.slice(0, m.index);
        const hookAt = before.lastIndexOf('function ');
        let hook = hookAt >= 0 ? /function\s+([A-Za-z0-9_]+)/.exec(before.slice(hookAt))?.[1] ?? null : null;
        let scope = enclosingBlock(before);
        // ONE indirection through onStep. Sunlight's shape: onInflictDamage
        // plays Steps.Trigger, and onStep - gated `s.kind == Steps.Trigger` -
        // plays Steps.Damage. The Damage step's real event is wherever Trigger
        // was played from, so the chain is followed one hop: find which step
        // kind this onStep body is gated on, find where THAT step is played,
        // and read the hook and guard there instead, keeping this scope's own
        // conditions (a hasSkill gate on the inner hop still gates).
        if (hook === 'onStep') {
          const kindGate = /\w+\.kind\s*==\s*Steps\.([A-Za-z0-9_]+)/.exec(scope);
          const parentStep = kindGate?.[1];
          const site = parentStep
            ? new RegExp(`\\bplayStep\\s*\\(\\s*Steps\\.${parentStep}\\b`).exec(body)
            : null;
          if (site) {
            const before2 = body.slice(0, site.index);
            const hookAt2 = before2.lastIndexOf('function ');
            const hook2 = hookAt2 >= 0 ? /function\s+([A-Za-z0-9_]+)/.exec(before2.slice(hookAt2))?.[1] ?? null : null;
            if (hook2 && hook2 !== 'onStep') {
              hook = hook2;
              scope = enclosingBlock(before2) + ' ' + scope.replace(kindGate[0], ' ');
            }
          }
        }
        if (!hook || !RIDER_HOOKS.test(hook)) {
          unraisedSites++;
          why ??= `${label} is played from ${/^[aeiou]/i.test(hook ?? 'top-level') ? 'an' : 'a'} ${hook ?? 'top-level'} hook, which is an event this fight does not produce`;
          continue;
        }
        // A FAN: the site sits in `for (x in <list>)` where the list is
        // `getInflictedStatuses(Skill.S)` - every S the owner has put on
        // anyone (SkillScript.getInflictedStatuses@6873 filters the unit's
        // instigatedStatuses by kind). Heat Emission is the shape:
        //
        //   var flamies = getInflictedStatuses(Skill.Scepter_Flamie_Flamie);
        //   for (flamie in flamies) {
        //     var ctx = playStep(Steps.Burst, null, flamie.owner.position);
        //     ctx.dmgMult = flamie.stacks;
        //   }
        //
        // How many S are out is live state - allies carry them - so the step
        // has no count, EXCEPT the one the data pins: a weapon passive this
        // build owns that keeps S on its owner for good (`opts.wornAlways`).
        // Then one play per cast is certain, and it is priced as that floor
        // and said to be one. Each play is scaled by that S's own stacks; a
        // status that holds one stack (Status.getMaxStacks@15831 defaults to
        // 1 where props.status.maxStacks is absent) makes that exactly 1.
        let fanNote = null;
        {
          const fan = /\bvar\s+(\w+)\s*=\s*getInflictedStatuses\s*\(\s*(?:Skill\.)?(\w+)\s*\)\s*;[\s\S]*?\bfor\s*\(\s*(\w+)\s+in\s+\1\s*\)/.exec(scope);
          if (fan) {
            const stId = fan[2];
            const stName = skills.get(stId)?.texts?.name ?? stId;
            const perStack = new RegExp('\\.dmgMult\\s*\\*?=\\s*' + fan[3] + '\\.stacks\\b').test(blockAround(body, m.index));
            const cap = maxStacksOf(stId, opts.rank ?? 1);
            const keeper = opts.wornAlways?.(stId) ?? null;
            if (!keeper) {
              why ??= `${label} is played once for every ${stName} you have out`
                + (perStack ? ', each multiplied by that one\'s stacks' : '')
                + ' - a count this fight does not track, and nothing this build owns keeps one up for good';
              continue;
            }
            const stepRow = (s?.steps ?? []).find((x) => x.id === step.stepId);
            const atWearer = new RegExp('playStep\\s*\\(\\s*Steps\\.' + step.stepId + '\\s*,\\s*null\\s*,').test(body);
            fanNote = `${label} is played once for every ${stName} you have out, and is priced at ONE - the `
              + `one the weapon's own passive (${skills.get(keeper)?.texts?.name ?? keeper}, ${keeper}) keeps on you for good`
              + (perStack
                ? (cap === 1 ? `, at the one stack a ${stName} holds` : `, at one stack of the ${cap} it can hold`)
                : '')
              + `. Every other ${stName} you put up - on an ally, for a while - adds a play this fight does not `
              + 'have, so the line is a floor'
              + (atWearer && Number(stepRow?.range) > 0
                ? `; and each play is centred on the ${stName}'s wearer with a reach of ${Number(stepRow.range)}, so `
                  + 'yours lands only on a target that close to you'
                : '');
          }
        }
        // "The last projectile of the cast" is once per cast, not live state.
        // WITHOUT that test the hook runs for every projectile that ends -
        // Castigate throws four - and the site is that many plays a cast,
        // which is a count no reader here takes for it (a Projectile step's
        // `generation.count`, a script loop, a rune that adds bolts). Pricing
        // it as one per cast, which is what falling through to the own-cast
        // branch did, would be a quarter of Castigate's; it is refused with
        // the count named. No row plays a step that way on build 25782799.
        if (hook === 'onProjectileEnd') {
          const LAST = /\b\w+(?:\.\w+)*\.projectiles\.length\s*<=\s*1\b/;
          if (!LAST.test(scope)) {
            why ??= `${label} is played from onProjectileEnd with no test for the cast's last projectile, so it is `
              + 'played once for every projectile of the cast that ends - a count this reader does not take';
            continue;
          }
          scope = scope.replace(LAST, ' ');
        }
        // A crit gate and an affinity gate are both evaluable - the fight
        // computes a crit expectation for every hit it prices, and the host's
        // own affinity is on the effect - so they are lifted out before the
        // guard is judged, exactly the way resource income already does it.
        const critGated = /\bcritical\b|\bisCrit\b/.test(scope);
        // ...and so is a bleed tick. `dmg.isStatusType(Hemorage)` asks WHICH
        // damage event this is, the same way isBaseAttack does, and the fight
        // raises one every time a pool dot hurts the target. Cracking Blood is
        // the case: its whole payload is a Code step played on that event.
        //
        // `x.isDoT()` is the same question asked wider - "is this damage event
        // a tick", any tick, not specifically a bleed. The two are kept apart
        // because the sim raises them apart: a bleed rider fires on pool-dot
        // ticks, an any-dot rider on every tick of every status.
        const BLEED_ONLY = /\w+\.isStatusType\s*\(\s*(?:StatusType\.)?(Bleed|Hemorage)\s*\)/;
        const ANY_DOT = /\w+\.isDoT\s*\(\s*\)/;
        const bleedOnly = BLEED_ONLY.test(scope);
        // onInflictStatusEval only ever fires because a status dealt damage, so
        // the hook itself is the tick event even when the body does not restate
        // it.
        const onDotTick = bleedOnly || ANY_DOT.test(scope) || hook === 'onInflictStatusEval';
        let cleaned = scope.replace(BLEED_ONLY, ' ').replace(ANY_DOT, ' ');

        // `s.status.kind == Skill.X` names WHICH dot's tick this rides. If the
        // build applies X - its own steps, or a talent or rune it took - that
        // is a filter the fight can honour, not a question about live state
        // (the accepted build's Virulent Magic rode Lethal Poison's ticks this
        // way; build 25782799 rewrote that talent as a crit pool).
        let dotStatus = null;
        const applied = new Set();
        for (const st of s?.steps ?? []) {
          for (const e of st.effects ?? []) if (e.status) applied.add(e.status);
        }
        const KIND_EQ = /\w+(?:\.\w+)*\.kind\s*==\s*(?:Skill\.)?([A-Za-z0-9_]+)/g;
        KIND_EQ.lastIndex = 0;
        for (let km; (km = KIND_EQ.exec(scope));) {
          if (!(applied.has(km[1]) || canApply(km[1], opts) === true)) continue;
          dotStatus = km[1];
          cleaned = cleaned.replace(km[0], ' ');
        }

        // `hasStatusMaxStacked(_, Skill.X)` for a status the build applies is
        // an ASSUMPTION rather than a refusal: in a sustained fight the stack
        // cap is reached and stays reached. It is named in the rule's own
        // `why`, because the ramp-up ticks before the cap are being credited
        // as if they fired.
        let maxStacked = null;
        const MAXSTACK = /hasStatusMaxStacked\s*\(\s*[^,()]+,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*\)/g;
        MAXSTACK.lastIndex = 0;
        for (let mm; (mm = MAXSTACK.exec(scope));) {
          if (!(applied.has(mm[1]) || canApply(mm[1], opts) === true)) continue;
          maxStacked = mm[1];
          cleaned = cleaned.replace(mm[0], ' ');
        }

        // `target.hasStatus(Skill.X)` where X is a status THIS skill applies is
        // not a question about live state the reader cannot answer - the host
        // puts it there. Blanked the way the tick event is, and the assumption
        // it carries (that the status is up when the tick lands) is named in
        // `why` rather than hidden, because a host on a long cooldown will not
        // hold its own status through the whole fight.
        const SELF_STATUS = /(\w+)\.hasStatus\s*\(\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*\)/g;
        let selfHeld = null;
        SELF_STATUS.lastIndex = 0;
        for (let sm; (sm = SELF_STATUS.exec(scope));) {
          if (!applied.has(sm[2])) continue;
          selfHeld = sm[2];
          cleaned = cleaned.replace(sm[0], ' ');
        }

        // `hasStatus(<x>.target, Skill.X)` where X is a ticking status ANOTHER
        // row of this build applies is not unreadable live state either: the
        // fight schedules X and knows at every swing whether it is up. Envenom
        // is the shape - "your basic attacks against enemies affected by
        // Lethal Poison" - and it carries the gate into the rule (`whileStatus`)
        // for the fight to answer per event. A negated test is the no-reapply
        // idiom and is not this.
        //
        // ...and when every applier of X is a talent node and the build holds
        // none of them, the question is answered as well - with "never". That
        // is a fact about the build; it used to be refused as "a question
        // about live state this reader cannot answer", which it is not.
        let whileStatus = null;
        let neverHeld = null;
        const TARGET_HELD = /(?<![!\w])hasStatus\s*\(\s*\w+\.target\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*\)/g;
        TARGET_HELD.lastIndex = 0;
        for (let tm; (tm = TARGET_HELD.exec(scope));) {
          if (/!\s*$/.test(scope.slice(0, tm.index))) continue;
          if (!combat.profile(tm[1], 1)?.periodic) continue;
          const can = canApply(tm[1], opts);
          if (can === false) { neverHeld = tm[1]; continue; }
          if (can !== true) continue;
          whileStatus = tm[1];
          cleaned = cleaned.replace(tm[0], ' ');
        }
        if (neverHeld && !whileStatus) {
          const nn = skills.get(neverHeld)?.texts?.name ?? neverHeld;
          why ??= `${label} is played only while ${nn} is on the target, and this build holds nothing that applies ${nn}`;
          offBuild = true;
          continue;
        }
        // ...and the same play may REFRESH that status:
        // `var p = getStatus(ctx.target, Skill.X); p.refresh(null);`.
        const refreshes = whileStatus
          ? (new RegExp('var\\s+(\\w+)\\s*=\\s*getStatus\\s*\\(\\s*\\w+\\.target\\s*,\\s*(?:Skill\\.)?' + whileStatus
            + '\\s*\\)\\s*;\\s*\\1\\.refresh\\s*\\(').test(scope) ? whileStatus : null)
          : null;

        // THE TARGET'S HEALTH is not live state the reader cannot answer: the
        // caller STATES it (`--target-health`, full by default), exactly as
        // `runeDamage` in damage.mjs already takes it for a dmgMult rider.
        // Spark Shot is the shape for a played step:
        //
        //   if (hit.targetUnit.healthRatio < vars.threshold) playStep(AdditionalDamage)
        //   if (rank >= 3 && hit.targetUnit.healthRatio > vars.var2) playStep(AdditionalDamage)
        //
        // and at the default full health the second - "Deals additional
        // damage if the enemy is over 80% [Health]" - is simply true, on every
        // finisher, where it was refused as a question about live state. The
        // COMPARISON is recorded on the rule and never its answer: the
        // rotation is cached across evaluations and cannot know the health
        // one of them states. The fight drops the rider where the stated
        // health fails it, and the engine says so. Only the thing being HIT:
        // `owner.healthRatio` is the owner's and stays unread.
        let health = null;
        {
          const h = /(\w+(?:\.\w+)*)\.healthRatio\s*(<=|>=|<|>)\s*vars\.([A-Za-z0-9_]+)/.exec(cleaned);
          if (h && /target/i.test(h[1])) {
            const t = (combat.profile(skillId, opts.rank ?? 1, opts.runes ?? undefined)?.vars ?? s?.vars)?.[h[3]];
            if (typeof t === 'number') {
              health = { op: h[2], threshold: t };
              cleaned = cleaned.replace(h[0], ' ');
            }
          }
        }
        // `var sk = ownerHero.getOffhandWeaponSkill(); if (sk != null) ...` is a
        // question about the LOADOUT: ent.Hero.getOffhandWeaponSkill@7828 is
        // null without an active off-hand (ops 0-3) and otherwise the first
        // of the hero's weapon skills whose originItem is that off-hand (ops
        // 6-25). Tactician Assault puts its whole proc behind it, and read
        // without it a sword with nothing in the other hand was paid the
        // magic hit all the same.
        {
          const oh = /\bvar\s+(\w+)\s*=\s*\w+\.getOffhandWeaponSkill\s*\(\s*\)\s*;/.exec(
            body.slice(Math.max(0, hookAt), m.index));
          const asked = oh ? new RegExp('\\b' + oh[1] + '\\s*!=\\s*null\\b').exec(scope) : null;
          if (asked && opts.offhandSkill === false) {
            why ??= `${label} needs a weapon skill on an off-hand weapon, and this build holds none`;
            gated = true;
            continue;
          }
          if (asked) cleaned = cleaned.replace(asked[0], ' ');
        }

        const g = guardOf(
          cleaned.replace(/\b(?:critical|isCrit|isPhysical|isMagic)\b/g, ' '), opts);
        if (!g.fires) { why ??= `${label}: ${g.why}`; gated = true; continue; }
        if (g.unread) {
          // ...unless the row is the `consumeCooldown` shape, where the
          // "unreadable" condition IS the mechanism. Dominion holds a status up
          // while it is off cooldown, spends it on the combo finisher and calls
          // consumeCooldown(), so its guard's `hasStatus` is the gate rather
          // than a question about live state - and `triggerRule` already reads
          // that shape. Only where the whole row is this one step, so the rule
          // it derives is unambiguously about the step in hand.
          const fallback = prof.scripted.length === 1
            ? triggerRule(skillId, prof, {}, opts) : null;
          if (fallback && fallback.kind !== 'never' && fallback.kind !== 'conditional') {
            rule = fallback;
            break;
          }
          why ??= `${label} is played only while ${g.unread}() holds, which is a question about `
            + 'live state this reader cannot answer';
          continue;
        }
        // (Judged only once the guard is known to hold: a step behind a rune
        // the build did not slot is gated off, and that is the better reason.)
        // A step whose only payload is a number THE SCRIPT COMPUTES has no
        // amount in the row. Castigate's Splash is `setDynVal(1, totalDmg *
        // vars.var1)` - a share of the damage the cast's own bolts just dealt
        // - and a rider priced from the row would be worth zero and vanish
        // without a word. Said instead, with the expression and with who it
        // lands on.
        {
          // DAMAGE only: a heal set to a share of a hit has a reader of its
          // own (the talent reader's heal share - Bloodfeast), and saying
          // here that nobody computes it would be false of those.
          const pays = (step.effects ?? []).filter((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind));
          if (pays.length && pays.every((e) => e.kind === 'Damage' && e.hasDynVal && !(e.baseVal || e.scaling?.length))) {
            const dv = /setDynVal\s*\(\s*\d+\s*,\s*([^;]+?)\)\s*;/.exec(blockAround(body, m.index))?.[1]?.trim() ?? null;
            const stepRow = (s?.steps ?? []).find((x) => x.id === step.stepId);
            why ??= `${label} is played from ${hook}, and its amount is not in the row: the script sets it`
              + (dv ? ` to \`${dv}\`` : '')
              + (stepRow?.props?.area?.ignoreMainTarget
                ? ' and the area leaves out the enemy the cast was aimed at - so it is worth nothing at one target, and at more it is a share this reader does not compute'
                : ', which is a number this reader does not compute');
            continue;
          }
        }
        let chance = 1;
        const cp = /checkProba\s*\(\s*(?:vars\.([A-Za-z0-9_]+)|(\d*\.?\d+))\s*\)/.exec(scope);
        if (cp) {
          const n = cp[1] ? (prof.vars ?? s?.vars)?.[cp[1]] : Number(cp[2]);
          if (!(typeof n === 'number' && n > 0 && n <= 1)) {
            why ??= `${label} rolls against a number that is not in the data`;
            continue;
          }
          chance = n;
        }
        const ev = eventsOf(scope);
        // `dmg.stepId == Steps.X` naming a step on THIS row means "when my own
        // cast's X step lands", which is the host's own rate rather than a
        // separate event.
        const ownStep = /\bstepId\s*==\s*Steps\.([A-Za-z0-9_]+)/.exec(scope)?.[1];
        const onOwnCast = OWN_CAST_HOOKS.test(hook)
          || !!(ownStep && (s?.steps ?? []).some((x) => x.id === ownStep));
        const roll = chance < 1 ? `, ${Math.round(chance * 100)}% of the time` : '';
        const crit = critGated ? ' on a critical strike' : '';
        // HOW OFTEN PER SWING, by the one rule `swingHookPerHit` states - the
        // same one `triggerRule` applies to a row that is its own rider. A
        // step played from the hook is played once for each hit of the swing
        // the guard names; a rider counted once per swing beside one counted
        // once per hit, on the same hook and the same two-hit finisher, was
        // two readings of one event.
        const perHit = swingHookPerHit(hook, scope);
        const perLanding = perHit && swingHookPerLanding(hook);
        const each = perHit ? ', once for every hit the swing lands' : '';
        // A STEP THAT ROLLS AGAIN ON ITS OWN HIT. Brutal Frenzy's second
        // strike is
        //
        //   function onInflictHit(hit) {
        //     if (rank >= 3 && hit.isFinalCombo) {
        //       if (checkProba(vars.chance)) { playStep(Steps.Attack, hit.target); }
        //     }
        //   }
        //
        // and the step it plays is a step of the finisher itself: its hit is
        // a hit of the same combo skill, raises the same hook, passes the
        // same guard and rolls the same chance. So the plays per finisher
        // hit are p + p^2 + ... = p / (1 - p), a third at the row's 0.25 and
        // not a quarter. MEASURED 2026-10-13 (the log numbers a cast's hits):
        // 112 finishers, 28 second strikes (0.250), then 8 third, 4 fourth
        // and 2 fifth - 42 in all, 0.375 a finisher (+-0.06), where a strike
        // that could not re-roll would never log a third.
        //
        // Read only for this spelling: the finisher's own script, on the
        // per-hit hook, guarded by the finisher test alone - nothing that
        // tells the played step's hit from the swing's (no isFirstHit, no
        // stepId, no skillId) - rolling a chance, playing a step of its own
        // row that deals damage.
        const rollsAgain = chance < 1 && perHit && hook === 'onInflictHit' && prof.isCombo === true
          && ev.has('combo') && !ev.has('attack')
          && !/isFirstHit|stepId|skillId/.test(scope)
          && (step.effects ?? []).some((e) => e.kind === 'Damage');
        const plays = rollsAgain ? chance / (1 - chance) : chance;
        const again = rollsAgain ? ' - and again on its own hit, which rolls the same chance' : '';
        if (onDotTick) {
          const held = selfHeld ? `, while ${selfHeld} is on the target - which this skill applies itself, and which the model assumes is up whenever a tick lands` : '';
          const capped = maxStacked ? `, once ${maxStacked} is fully stacked - assumed held for the whole fight, so the ramp before the cap is credited as if it fired` : '';
          // A STATUS-NAMED onInflictStatusEval rider fires on the status's
          // APPLICATION clock, not its tick clock: the sole dispatch site is
          // GameObject.addStacks@4637, once per application or stack-gain,
          // never on the tick path. The capture agrees to the millisecond -
          // 98.8% of 71,578 Virulent Magic procs land within 5ms of a Lethal
          // Poison application row, while ticks hold a fixed 2s cadence
          // through refresh storms. The old per-tick-x-stacks read matched
          // live totals only because the at-cap application rate happened to
          // sit near stacks/tick - the LAW was wrong even when the number was
          // close.
          if (hook === 'onInflictStatusEval' && dotStatus) {
            rule = {
              kind: 'per-dot-apply', chance, critGated,
              status: dotStatus,
              why: `${label} is played each time ${dotStatus} is applied or gains a stack${crit}${roll}${held}${capped}`,
            };
          } else {
            const which = dotStatus ? `every tick of ${dotStatus}` : bleedOnly ? 'every tick of a bleed' : 'every tick of a damage-over-time';
            rule = {
              kind: 'per-dot-tick', chance, critGated, bleedOnly,
              status: dotStatus,
              why: `${label} is played on ${which}${crit}${roll}${held}${capped}`,
            };
          }
        } else if (ev.has('attack') && ev.has('combo')) {
          rule = { kind: 'per-attack-or-combo', chance, critGated, perHit, perLanding, why: `${label} is played on a base attack or a combo finisher${each}${crit}${roll}` };
        } else if (ev.has('combo')) {
          rule = { kind: 'per-combo', chance: plays, divisor: 1, critGated, perHit, perLanding, why: `${label} is played on the combo finisher${each}${crit}${roll}${again}` };
        } else if (ev.has('attack')) {
          rule = { kind: 'per-attack', chance, critGated, perHit, perLanding, why: `${label} is played on a base attack${each}${crit}${roll}` };
        } else if (ev.has('weapon-skill')) {
          rule = { kind: 'per-weapon-skill', chance, critGated, why: `${label} is played on every weapon skill you press${crit}${roll}` };
        } else if (onOwnCast) {
          // The host's own landing. For a chain link that IS the combo or a
          // swing; for anything else it is one fire per cast of the host -
          // TIMES the tick count when the gating step is a spread CHANNEL:
          // RayOfSpark's SparkRegen is played per ChannelTick hit (script
          // onHit), so its +18% MaxSpark arrives four times a cast, and
          // folding it once starved the sim's pool by ~75% of that income.
          let perCast = 1;
          if (ownStep) {
            const chan = (prof.effects ?? []).find((e2) => e2.stepId === ownStep);
            if (chan?.spread && (chan.ticks ?? 1) > 1) perCast = chan.ticks;
          }
          // ...and TIMES a script loop around the playStep site: Demondash's
          // Skill2 plays its Projectiles step round(vars.var1) times per
          // cast (3 at rank 2) - live, 13 presses threw 30.
          {
            const lead = body.slice(Math.max(0, m.index - 260), m.index);
            const lm = /for\s*\(\s*\w+\s+in\s+0\.\.\.round\(\s*vars\.(\w+)\s*\)\s*\)/.exec(lead);
            const lv = lm ? (prof.vars ?? s?.vars)?.[lm[1]] : null;
            if (typeof lv === 'number' && lv > 1) perCast *= Math.round(lv);
          }
          rule = prof.isCombo
            ? { kind: 'per-combo', chance, divisor: 1, critGated, why: `${label} is played by the finisher itself${crit}${roll}` }
            : prof.isFiller
              ? { kind: 'per-attack', chance, critGated, why: `${label} is played by the swing itself${crit}${roll}` }
              : {
                kind: 'per-parent-cast', parent: skillId, chance, divisor: 1, perCast, critGated,
                why: `${label} is played by the cast itself${perCast > 1 ? `, once per channel tick (${perCast} a cast)` : ''}${crit}${roll}`,
              };
        } else {
          why ??= `${label} is played from ${hook} with no event this fight raises`;
        }
        // The target-status gate rides whichever event rule the guard gave it.
        // The hook is onInflictDamage, raised per damage INSTANCE, so a swing
        // that lands two hits rolls twice (`perHit`) - which a swing rule
        // already carries, and says, by `swingHookPerHit` above; it is set
        // and said here only for an event that rule does not cover.
        if (rule && whileStatus) {
          if (onDotTick || rule.kind === 'per-parent-cast') {
            // Not a shape the fight gates per event yet; refuse rather than
            // drop the condition.
            rule = null;
            why ??= `${label} is played only while ${skills.get(whileStatus)?.texts?.name ?? whileStatus} is on the target, `
              + 'on an event this reader does not gate on a status';
          } else {
            const wn = skills.get(whileStatus)?.texts?.name ?? whileStatus;
            rule.whileStatus = whileStatus;
            rule.refreshes = refreshes;
            const saidPerHit = rule.perHit != null;
            rule.perHit ??= hook === 'onInflictDamage';
            rule.accountsFor = [skillId];
            rule.why += ` - only while ${wn} is on the target`
              + (rule.perHit && !saidPerHit ? ', rolled on each damage instance the swing lands' : '')
              + (refreshes ? `, and each play refreshes ${wn}` : '');
          }
        }
        // `hit.target != ctx.aimTarget` on the playStep site: the step lands
        // only on targets OTHER than the one aimed at - zero of them against
        // a lone dummy. RayOfSpark's M2 splash is the shape, and the model
        // was crediting it a full hit per cast on a single target, which is
        // half of why that row read +89.6% per hit.
        // A floor is said wherever the rule ends up - on the line it becomes,
        // or beside the cast it is folded into.
        if (rule && fanNote) { rule.floor = fanNote; rule.why = fanNote; }
        // ...and the step's OTHER event, where the same `if` names another
        // skill's hits as an alternative (`namedSkillArm`). It is a rider of
        // its own on that skill's cast - once per damage instance the cast
        // lands, which is what onInflictDamage is raised for - behind the
        // same roll and crit gate as the site. Left out, Nectar-infused
        // Blade's hit on each spin of a rank-3 Flower Spiral had no line and
        // no sentence: 134 hits of a 20-cast skill.
        if (rule && !onDotTick && /^onInflict(?:Damage|Hit)$/.test(hook)) {
          const arm = namedSkillArm(scope, body, opts.rank ?? 1);
          if (arm && arm.skill !== skillId && skills.get(arm.skill)) {
            const armName = skills.get(arm.skill).texts?.name ?? arm.skill;
            alsoSites.push({
              kind: 'per-parent-cast', parent: arm.skill, chance, divisor: 1, critGated, perHit: true,
              why: `${label} is also played on every hit of ${armName}`
                + (arm.minRank ? `, which ${armName} brings from its rank ${arm.minRank}` : '') + `${crit}${roll}`,
            });
          }
        }
        if (rule && health) {
          rule.targetHealth = health;
          rule.why += ` while the target is ${health.op} ${+(health.threshold * 100).toFixed(2)}% health`;
        }
        if (rule && /\btarget\s*!=\s*(?:ctx\.)?aimTarget\b/.test(scope)) rule.notAimTarget = true;
        // A site behind a stated-health test does not end the search: another
        // site of the same step may hold where this one does not.
        if (rule?.targetHealth) holdHealthSite = true;
        // A step played AT A POSITION - playStep(Steps.X, null, pos) - is
        // anchored to the ground, not to the aim target, so an authored
        // ignoreMainTarget on its area does NOT exclude the target standing
        // there: Demondash Skill2's AOE hit the lone dummy 10 times in 28
        // projectile hits while the model zeroed it.
        if (rule && new RegExp('playStep\\s*\\(\\s*Steps\\.' + step.stepId + '\\s*,\\s*null\\s*,').test(body)) {
          rule.atPosition = true;
        }
        if (holdHealthSite) { healthSites.push(rule); rule = null; holdHealthSite = false; }
      }
      if (rule) riders.push({ step, rule });
      else if (!healthSites.length) {
        refused.push({
          step: step.stepId,
          kind: offBuild ? 'off in this build' : gated ? 'gated off' : 'no rate',
          cause: sites > 0 && unraisedSites === sites ? 'unraised-hook' : null,
          why: why ?? `${label} is played only from script, and nothing in the row says when`,
        });
      }
      // Each health-conditioned site is a rider of its own: the same step,
      // played in a different part of the fight (Spark Shot's execute branch
      // and its above-80% branch).
      for (const hr of healthSites) riders.push({ step, rule: hr });
      // ...and so is the same step on another skill's hits.
      for (const ar of alsoSites) riders.push({ step, rule: ar });
    }
    return { riders, refused };
  }

  /**
   * A per-cast rider folded back INTO the cast, at the rate the script gives it.
   *
   * `Staff_Censer_Skill2` is the case that forces this: its entire damage is one
   * `on: Code` step played by `onAreaElapsed`, i.e. a delayed detonation, one
   * fire per cast. Taken out of the cast and left as a separate rider, the skill
   * carries no damage at all - so it never reaches the rotation, so the rider
   * has no parent, so the rider never fires either, and a weapon loses its best
   * skill to a circle. Folded back in, the schedule is identical to the cast's
   * own and the arithmetic is exact.
   *
   * A chance scales it linearly, which is legal for DAMAGE (unlike a status,
   * whose uptime saturates). The scale rides `baseVal` and every scaling ratio.
   */
  function foldRider(effects, scale) {
    if (scale === 1) return effects;
    return effects.map((e) => ({
      ...e,
      baseVal: (e.baseVal ?? 0) * scale,
      scaling: (e.scaling ?? []).map((sc) => ({ ...sc, ratio: (sc.ratio ?? 0) * scale })),
    }));
  }

  /**
   * Does this skill carry a damage/heal/shield payload AT ALL - in its cast, or
   * in a step its own script plays?
   *
   * The distinction has to be invisible to the bucketing, or splitting the
   * script-played steps out silently reclassifies skills. `Warrior_IgnorePain`
   * is the case: its heal is one `on: Code` step, so with the split it stopped
   * "carrying", fell through to the passive bucket, and left the rotation - a
   * defensive cooldown the search had been pressing simply vanished, along with
   * the buff window every other test in the suite prices against it.
   */
  function carriesPayload(prof) {
    // ...an AMOUNT, not just the effect row. A Damage effect with no baseVal,
    // no scaling and no script-fed value is a carrier for something else - a
    // knock-back, a status - and deals nothing: Abyssal Fury's cast is one
    // such Area (the push) beside the Status step that is its whole point, and
    // counted as a payload it was pressed as a hit worth zero while the buff
    // it opens went unread.
    const has = (list) => (list ?? []).some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind)
      && (e.baseVal || (e.scaling ?? []).length || e.hasDynVal));
    return has(prof?.effects) || (prof?.scripted ?? []).some((st) => has(st.effects));
  }

  /** A rider's own profile: the host's, carrying only the step the script plays. */
  function riderProf(prof, step, rule = null) {
    return {
      ...prof,
      id: `${prof.id}#${step.stepId}`,
      name: prof.name,
      // A rider whose site guards `target != aimTarget` lands on nobody at
      // one target; one played at a position keeps the aim target in its
      // area. The pricing site reads both flags off each effect.
      effects: (rule?.notAimTarget || rule?.atPosition)
        ? step.effects.map((e) => ({
          ...e,
          ...(rule.notAimTarget ? { notAimTarget: true } : {}),
          ...(rule.atPosition ? { atPosition: true } : {}),
        }))
        : step.effects,
      // It is not a cast: it costs no time, no cooldown and no resource, and it
      // is not the base-attack chain even when its host is.
      occupancy: 0, cooldown: 0, charges: 1, costs: [], isFiller: false, isCombo: false,
      scripted: [],
    };
  }

  // WHAT ELSE A COOLDOWN-GATED PASSIVE'S SCRIPT DOES AROUND ITS GATE. The rule
  // below ("the first <event> after each cooldown") read one clause of such a
  // script - the event that spends the cooldown - and two more can ride the
  // same cooldown. Resilience of the Unkillable Demon King (Worldsplitter's
  // passive) has both, and until the 2026-10-13 capture neither was priced:
  //
  //   function onUseSkill(ctx) {
  //     if (isInCooldown()) { return; }
  //     if (ctx.isFinalCombo) { ctx.dmgMult += vars.damage; }
  //   }
  //   function onInflictDamage(dmg) {
  //     ...
  //     if (dmg.isFirstHit) {
  //       if (dmg.isBaseAttack || dmg.isFinalCombo) {
  //         if (rank >= 2) { reduceCooldown(kind, vars.time); }
  //         if (rank >= 3 && dmg.critical) { reduceCooldown(kind, vars.dur1); }
  //       }
  //     }
  //   }
  //
  //   gateComboAdd   the finisher pressed while the passive is OFF cooldown
  //                  takes vars.damage in its context's dmgMult - the one
  //                  additive bracket, every hit of that finisher (the bank's
  //                  and the mark's channel, see sim.mjs).
  //   gateRelief     every base attack and finisher shortens the cooldown,
  //                  once per swing (isFirstHit), by the amounts the rank has
  //                  unlocked; a critical one by more. The spending
  //                  finisher's own hit shortens nothing: the script calls
  //                  consumeCooldown from a wait(0), after that hit's
  //                  reduceCooldown found no cooldown to reduce.
  //
  // MEASURED 2026-10-13 (Emsai, Judgement with Worldsplitter's passive in the
  // arsenal, rank 3, two sixty-second basic chains): the passive's status
  // comes back 5.5-7.5s after the finisher that spent it - where 30s less 2s
  // a swing less 6s a critical one, at 4 swings per 3.1s chain and 17% crit,
  // predicts 6.1 - and the finisher that finds it up logs 299 against 230,
  // x1.30 (its second strike 188 against 145). 14 of 39 finishers were such.
  //
  // Only this exact spelling is read. A reduceCooldown behind any other guard,
  // or a dmgMult written under another test, is left to the readers that own
  // those shapes; the two clauses are optional and independent.
  function gateClausesOf(body, vars, rank) {
    const out = {};
    const use = hookBody(body, 'onUseSkill').replace(/\s+/g, '');
    const add = /^if\(isInCooldown\(\)\)\{?return;\}?if\((\w+)\.isFinalCombo\)\{?\1\.dmgMult\+=vars\.(\w+);\}?$/.exec(use);
    if (add && typeof vars[add[2]] === 'number' && vars[add[2]] > 0) out.gateComboAdd = vars[add[2]];
    const hit = hookBody(body, 'onInflictDamage').replace(/\s+/g, '');
    const blk = /if\((\w+)\.isFirstHit\)\{if\(\1\.isBaseAttack\|\|\1\.isFinalCombo\)\{((?:if\(rank>=\d+(?:&&\1\.critical)?\)\{?reduceCooldown\(kind,vars\.\w+\);\}?)+)\}\}/.exec(hit);
    if (blk) {
      let perSwing = 0, perCrit = 0;
      for (const m of blk[2].matchAll(/if\(rank>=(\d+)(&&\w+\.critical)?\)\{?reduceCooldown\(kind,vars\.(\w+)\);\}?/g)) {
        const v = vars[m[3]];
        if (rank < Number(m[1]) || typeof v !== 'number' || !(v > 0)) continue;
        if (m[2]) perCrit += v; else perSwing += v;
      }
      if (perSwing > 0 || perCrit > 0) out.gateRelief = { perSwing, perCrit };
    }
    return out;
  }

  /**
   * How often a triggered skill fires, expressed against rates the throughput
   * model already computes. Every rule names the data it rests on; there is no
   * fallback, because a guessed rate is worse than a stated gap.
   */
  function triggerRule(id, prof, extra, opts = {}) {
    const s = skills.get(id);

    // A CONDUIT fires when Spark is SPENT while the pool BEFORE the spend was
    // strictly above the gauge threshold - `Mage_Conduit_SparkBounds` is
    // [0.5, 0.5, 0.5] and the test is `bound < ratio`, so all three tiers are
    // the same number and it is all-or-nothing today. Every equipped conduit
    // fires at once, so conduit damage is a SUM over the conduits you slotted
    // rather than one of them.
    //
    // This is the rate the model kept refusing as "no trigger rate can be
    // derived from the data". It was derivable; it needed the Spark pool
    // simulated rather than a rate invented, and "one per weapon skill" would
    // have been badly wrong - in-combat regen is 0.65/s against ~5/s of spend,
    // so the pool spends almost all of a sustained fight below the threshold.
    //
    // Measured in game 2026-08-02 on a naked Censer Mage: starting from a full
    // 100 Spark and paying the finisher's flat 10, the pool reads 100/90/80/70/60
    // before five successive spends and 50 before the sixth - and the buff
    // stacked exactly FIVE times before triggers stopped. The threshold is
    // exact to the integer.
    if (typeOf(id) === 'MageConduit') {
      return {
        kind: 'per-conduit-trigger', chance: 1,
        why: 'it fires whenever Spark is spent from above the gauge threshold '
          + '(Mage_Conduit_SparkBounds 0.5), together with every other conduit',
      };
    }

    // A PRAYER IS MADE READY BY ITS OWN EVENT AND RELEASED BY JUDGMENT.
    //
    // This used to say "Priest_Rosary charges a prayer on the combo's final
    // attack; slotted prayers cycle" and fired one prayer per finisher, in
    // turn. Priest_Rosary has no script on this build; the script that
    // sentence quoted is Prayer: Smite's own, and each prayer has one:
    //
    //   Smite   onSkillProc: ctx.skill.isFinalAttack()          -> chargePrayer()
    //   Life    ctx.skill.isWeaponSkill() && !isFromArsenal()   -> chargePrayer()
    //   Virtue  ctx.skill.isFromArsenal() && !isPassive()       -> chargePrayer()
    //
    // ("Becomes ready after you use your [ComboAttack]" / "a [Skill] of your
    // actual weapon" / "of your Arsenal weapon".) PriestComponent.chargePrayer@30856 ops 35-42
    // add ONE charge and only below one, so a ready prayer stays ready and
    // does not bank a second; and nothing fires it but
    // PriestComponent.divineInterventionProc@30855, which starts every prayer
    // that is not in cooldown (ops 24-32; Skill.isInCooldown@9599 is "fewer than
    // one charge") and whose one caller is the signature skill's own step -
    // Judgment, "Releases a nova that activates all ready [Prayer]s", on its
    // twelve-second cooldown. So the prayers fire TOGETHER, when Judgment is
    // pressed, each at most once per press.
    //
    // MEASURED before the patch, in the event capture (the scripts are
    // unchanged since): 2,052 of one Priest's 2,060 Smite casts fall within
    // 1.5s after a Judgment press, and across 1,135 players the gap between
    // two Smites has a median of 19.2s - where one prayer per finisher, in
    // turn, gave one every six or seven seconds.
    if (extra.mechanic === 'PriestPrayer') {
      const ready = hookBody(liveScript(s?.script ?? ''), 'onSkillProc');
      const cond = /if\s*\(([^{]*)\)\s*\{[^}]*\bchargePrayer\s*\(/.exec(ready)?.[1] ?? null;
      const releaser = prayerReleasers[0] ?? null;
      const releaserName = skills.get(releaser)?.texts?.name ?? releaser;
      let opensOn = null, said = null;
      if (cond && /\bis(?:FinalAttack|FinalCombo)\s*\(/.test(cond)) {
        opensOn = { combo: true };
        said = 'your combo finisher';
      } else if (cond && /\bisWeaponSkill\s*\(/.test(cond) && /!\s*[\w.]*\bisFromArsenal\s*\(/.test(cond)) {
        opensOn = { weaponSkill: true, sources: ['Slot_Weapon1', 'Slot_OffhandWeapon'] };
        said = 'a weapon skill of the weapon in hand';
      } else if (cond && /\bisFromArsenal\s*\(/.test(cond) && !/!\s*[\w.]*\bisFromArsenal\s*\(/.test(cond)) {
        opensOn = { sources: ['Slot_Weapon2'] };
        said = 'a skill of the arsenal weapon';
      }
      if (!opensOn || !releaser) {
        return {
          kind: 'conditional',
          why: !releaser
            ? 'a prayer fires only when something releases it, and no row in this build calls the release'
            : `its script makes it ready on \`${(cond ?? 'a condition').replace(/\s+/g, ' ').trim()}\`, which is not one of the events this reader follows`,
        };
      }
      return {
        kind: 'per-parent-cast', parent: releaser, chance: 1, divisor: 1,
        // One charge, made ready by the event above and held until released.
        window: { opensOn, duration: Infinity, charges: 1 },
        why: `${releaserName} releases every prayer that is ready, and this one is made ready by ${said} `
          + '(one charge, held until it is released)',
        // The mechanism row must not also be reported as an ability nobody
        // modelled.
        accountsFor: ['Priest_Rosary'],
      };
    }

    // A follow-up fires once per cast of the skill it follows, and which skill
    // that is comes out of `props.subskills` rather than out of the id. The
    // parent's cast rate is something the fight already produces, so this needs
    // no new assumption - unlike a parent that is a weapon PASSIVE, which has
    // no cast rate at all and leaves its ultimate genuinely unpriced.
    if (extra.parent) {
      const parentType = typeOf(extra.parent);
      if (parentType !== 'WeaponPassive') {
        return {
          kind: 'per-parent-cast', parent: extra.parent, chance: 1, divisor: 1,
          why: `props.subskills makes it a follow-up to ${skills.get(extra.parent)?.texts?.name ?? extra.parent}`,
        };
      }
      return null;
    }

    // "The first <event> after each cooldown" - Dominion's shape. The script
    // holds a status up while off cooldown, spends it on the event, and calls
    // consumeCooldown(); the rate is therefore one fire per max(cooldown,
    // event interval), which the fight produces exactly once it carries the
    // gate. Only the certain form is claimed - a chance roll on top of a
    // cooldown gate composes two rates this reader has not verified together.
    if (s?.script && (prof.cooldown > 0)
      && /consumeCooldown\s*\(/.test(String(s.script))
      && !/checkProba/.test(String(s.script))) {
      const body = liveScript(s.script);
      const at = body.search(/consumeCooldown\s*\(/);
      const scope = enclosingBlock(body.slice(0, Math.max(0, at)));
      const ev = eventsOf(scope);
      // Only events the trigger machinery rides: a combo or a swing. A
      // weapon-skill-gated one would silently fire off the wrong event.
      if (ev.has('combo') || ev.has('attack')) {
        const around = gateClausesOf(body, prof.vars ?? s.vars ?? {}, opts.rank ?? 1);
        return {
          // Both, when the guard names both: the gate then opens on whichever
          // lands first, a swing two times in three.
          kind: ev.has('combo') && ev.has('attack') ? 'per-attack-or-combo'
            : ev.has('combo') ? 'per-combo' : 'per-attack',
          chance: 1, divisor: 1, cooldownGate: prof.cooldown,
          ...around,
          why: `its script fires on the first ${[...ev].join('/')} each ${prof.cooldown}s (consumeCooldown)`
            + (around.gateRelief
              ? `, a cooldown each base attack and finisher shortens by ${around.gateRelief.perSwing}s`
                + (around.gateRelief.perCrit ? ` and a critical one by ${around.gateRelief.perCrit}s more` : '')
              : '')
            + (around.gateComboAdd ? `; the finisher that finds it ready deals +${Math.round(around.gateComboAdd * 100)}%` : ''),
        };
      }
    }

    // `vars.chance` is the proc rate the data ships. WHAT it rolls against is
    // in the script's own guard, and the two are not the same rate: a combo
    // finisher lands about a third as often as a swing does, so reading every
    // proc as per-attack overstated `Enchant_Lifestealing` threefold. The guard
    // is one line and it is worth reading rather than assuming.
    //
    // ...and it is only THIS script's roll where the script rolls something
    // or names it. A row can carry `vars.chance` as a leftover of the row it
    // was copied from - Gift Beyond Realities (0.15) and Blood Oath (0.2)
    // author one, roll nothing and never say the word - and the branch below
    // then judged the WHOLE file as "the guard around the roll": a rank test
    // on an unrelated summon became "its script gates on rank >= 3", and an
    // isInCooldown() beside it "vars.chance = 0.15, but its script also gates
    // on isInCooldown()". Both reasons were false. Narrow on purpose: a script
    // that rolls a local (`checkProba(chance)`), or reads the var another way
    // (`sourceSkill.vars.chance`), still comes through here as before, and so
    // does a row with no script at all. Five rows a player can own match the
    // exclusion besides those two (a mace passive, a flame's status, two
    // Rogue talents and a Priest one); none of them reaches this function,
    // and the whole weapon / talent / trinket surface reads the same with and
    // without the test.
    const chance = (prof?.vars ?? s?.vars)?.chance;
    const ownsRoll = !s?.script || /checkProba\s*\(|\bchance\b/.test(liveScript(s.script));
    if (typeof chance === 'number' && chance > 0 && ownsRoll) {
      const full = liveScript(s.script ?? '');
      // The guard is the block around the ROLL, not the whole file. A script
      // has several handlers and only one of them is the proc:
      // `Daggers_DuplicatePoison_ComboAttack` rolls in `onInflictDamage` while a
      // different handler entirely calls `getStatusCount`, and reading the file
      // as one guard would refuse a rate the roll does not actually depend on.
      const at = full.search(/checkProba\s*\(\s*vars\.chance/);
      const script = at >= 0 ? enclosingBlock(full.slice(0, at)) : full;
      // A roll that rides a DOT'S OWN TICKS, not a swing. `Cracking Blood`
      // guards on `dmg.isStatusType(StatusType.Hemorage)`, so the event is the
      // bleed hurting the target - which happens every `tick` seconds while it
      // is up, a rate this fight knows and nothing like the base-attack rate the
      // fallback at the bottom would otherwise have given it.
      //
      // `dmg.isStatusType(X)` is NOT the live-state question the refusal list
      // is aimed at. It asks which damage event this is, exactly the way
      // `isBaseAttack` does - `hasStatus`, `hasStatusType` and
      // `hasStatusMaxStacked` are the ones that ask what is up right now. So it
      // is stripped before the guard is judged, and only where it names a bleed
      // the fight actually runs. Two skills in the sheet have this shape and
      // both are Warrior talents.
      const BLEED_EVENT = /\w+\.isStatusType\s*\(\s*(?:StatusType\.)?(Bleed|Hemorage)\s*\)/;
      const onDotTick = BLEED_EVENT.test(script);
      let scope2 = onDotTick ? script.replace(BLEED_EVENT, ' ') : script;
      // `!hasStatus(target, Skill.X)` where the SAME script does
      // `addStatus(..., Skill.X)` is not a question about live state - it is
      // "do not reapply while my own status is up". The dot machinery already
      // treats a reapplication as a refresh, so the roll rate stands as
      // authored and the gate is stripped rather than refused. The demon
      // trinket is the case: 3% per damage event, unless its burn is already
      // burning - and that guard kept 47-a-tick out of the model entirely.
      let noReapply = null;
      {
        const own = new Set();
        const SELF_APPLY = /(?:addStatus|enforceStatus|setStatus)\s*\(\s*[^,()]+,\s*(?:Skill\.)?([A-Za-z0-9_]+)/g;
        for (let m; (m = SELF_APPLY.exec(full));) own.add(m[1]);
        const HAS_OWN = /!?\s*hasStatus\s*\(\s*[^,()]+,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*\)/g;
        for (let m; (m = HAS_OWN.exec(scope2));) {
          if (!own.has(m[1])) continue;
          noReapply = m[1];
          scope2 = scope2.replace(m[0], ' ');
        }
      }
      const reapplyNote = noReapply
        ? `; its "not while ${noReapply} is up" gate is a refresh the dot model already absorbs`
        : '';
      // "IS MY OWN COUNTER FULL" IN ITS SECOND SPELLING. Cascade's Axe reads
      //
      //   var status = owner.getStatus(Skill.DA_Water_Combo_Status);
      //   if (status != null && status.stacks >= status.getMaxStacks() && checkProba(vars.chance))
      //
      // which is hasStatusMaxStacked(owner, Skill.X) written out by hand - and
      // `scriptedRiders` already answers that one, as a named assumption,
      // whenever the build itself applies X: in a sustained fight the cap is
      // reached and stays reached (Cascade stacks once per finisher, five
      // deep, on a fifteen-second timer the next finisher renews). The same
      // answer here, with the same sentence in the rule's `why`; a status
      // nothing in the build applies stays the live-state question it is.
      let capped = null;
      {
        const local = /\bvar\s+(\w+)\s*=\s*owner\.getStatus\s*\(\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*\)\s*;/.exec(script);
        const full2 = local ? new RegExp('(?:\\b' + local[1] + '\\s*!=\\s*null\\s*&&\\s*)?\\b' + local[1]
          + '\\.stacks\\s*>=\\s*' + local[1] + '\\.getMaxStacks\\s*\\(\\s*\\)').exec(scope2) : null;
        const applied = full2 && (canApply(local[2], opts) === true
          || [...(statusAppliers.get(local[2]) ?? [])].some((by) => opts.owned?.has(by)));
        if (applied && Number.isFinite(maxStacksOf(local[2], opts.rank ?? 1))) {
          capped = local[2];
          scope2 = scope2.replace(local[0], ' ').replace(full2[0], ' ');
        }
      }
      const cappedNote = capped
        ? `, once ${skills.get(capped)?.texts?.name ?? capped} is fully stacked - which this build applies itself and `
          + 'is assumed to hold for the whole fight, so the ramp before the cap is credited as if it fired'
        : '';
      // ...and the rest of that guard decides whether the rate applies at all.
      const g = guardOf(scope2, opts);
      if (!g.fires) return { kind: 'never', why: g.why };
      if (!g.unread && onDotTick) {
        return {
          // This path only ever matched isStatusType(Bleed), so it stays on
          // the pool-dot clock - regular dots now raise ticks too, and without
          // this flag the two Warrior bleed talents would ride every poison.
          kind: 'per-dot-tick', chance, bleedOnly: true,
          why: `vars.chance = ${chance} on every tick of a bleed`,
        };
      }
      if (g.unread) {
        return {
          kind: 'conditional',
          why: `vars.chance = ${chance}, but its script also gates on ${g.unread}(), `
            + 'which is a question about live state this reader cannot answer - so the rate is not derivable',
        };
      }
      // Which swings roll it - see `swingsOf`. A bare isBaseAttack is the
      // finisher too; no predicate at all keeps the base-attack reading.
      const sw = swingsOf(script);
      // ...and how often per swing: once per hit where the roll is written
      // in a per-hit hook - see `swingHookPerHit`, the rule `scriptedRiders`
      // applies to a script-played step too.
      const perHit = at >= 0 && swingHookPerHit(hookAt(full, at), script);
      const perLanding = perHit && swingHookPerLanding(hookAt(full, at));
      const each = perHit ? ', rolled for every hit the swing lands' : '';
      if (sw.combo && !sw.attack) {
        return {
          kind: 'per-combo', chance, divisor: 1, perHit, perLanding,
          why: `vars.chance = ${chance}, and its script gates on the combo finisher${each}${reapplyNote}${cappedNote}`,
        };
      }
      // A roll behind `isSkill` is not a base-attack proc. `ctx.isSkill` is a
      // weapon, class or signature skill (BaseSkillAccess.get_isSkill@5193) -
      // exactly the presses a base attack is NOT - and the fight raises that
      // event where it already banks a stack per active press. Nectar Balls
      // is the shape (`ctx.isSkill && !ctx.skill.isPassive() &&
      // checkProba(vars.chance)`) and, read through here, it rolled on every
      // swing. No row a player can own reaches this line today: the one
      // script that rolls behind isSkill is that set passive, which is read
      // at its own rank beside the engine. (Asked before the swing reading
      // below: with no swing predicate in the guard, `swingsOf` keeps the
      // base-attack reading, which is the one this arm exists to correct.)
      if (/\.isSkill\b/.test(script) && !/isBaseAttack|isBasicAttack/.test(script)) {
        return { kind: 'per-skill', chance, why: `vars.chance = ${chance} on every skill you use${reapplyNote}${cappedNote}` };
      }
      if (sw.combo && sw.attack) {
        return {
          kind: 'per-attack-or-combo', chance, perHit, perLanding,
          why: `vars.chance = ${chance} on a base attack or a combo finisher${each}${reapplyNote}${cappedNote}`,
        };
      }
      return {
        kind: 'per-attack', chance, perHit, perLanding,
        why: `vars.chance = ${chance} on a base-attack proc${each}${reapplyNote}${cappedNote}`,
      };
    }

    return null;
  }

  // --- statuses a skill applies ---------------------------------------------
  /**
   * Every status a skill puts up, from both data paths, split by who wears it.
   *
   * `Enchant_Zealot` is the case that made this necessary: its script does
   * `addStatus(owner, Skill.Enchant_Zealot_Status)` and that status carries
   * `TAttribute_Flat CritChanceRating +6` with `props.status.maxStacks: 5`, so
   * the enchant is worth +30 rating - which is the whole reason to put an
   * enchant on a weapon at all.
   *
   * `Priest_BlessingOfFervor` is the case the script-only reading missed: it
   * names its status in a `Status` STEP, not in a script, and it is +10 Fervor.
   *
   * Stat buffs are modelled AT FULL STACKS, which is stated in the audit - with
   * one refusal, now narrowed by op. A status whose affix carries `mod.dynVal`
   * has part of its magnitude decided by a script at runtime, but
   * getAffixModVal@21793 says HOW: op 0 multiplies the authored val by the
   * dynVal, op 1 replaces it - those are refused, the authored number means
   * nothing on its own. Op 2 ADDS, and a fresh instance reads dynVal 0, so the
   * authored val is a floor: `Priest_Crusader_Status`'s +10 CritChance is live
   * for the whole 20s press even with zero growth. The floor is credited at
   * one stack (its maxStacks 300 is the growth channel, and crediting it at
   * cap would hand the build +3000 crit); the addDynVal growth stays refused.
   */
  // --- a status applied by a COUNT of doses ----------------------------------
  //
  // Build 25782799 rebuilt the Rogue's Lethal Poison as a gate, and the shape
  // is general enough to read as one. The talent's script:
  //
  //   function onInflictHitNewTarget(ctx) {
  //     if (ctx.target.isAlly(skill.owner)) { return; }
  //     if (ctx.isWeaponSkill) { applyDose(WS, ctx.target); }
  //     if (ctx.isClassSkill)  { applyDose(CS, ctx.target); }
  //     if (ctx.isFinalCombo)  { applyDose(FCA, ctx.target); }
  //     if (ctx.isSignature)   { applyDose(SIG, ctx.target); }
  //   }
  //   function applyDose(sid, target) { addStatus(target, sid); checkDoses(target); }
  //   function checkDoses(target) {
  //     var statuses = target.getStatuses(s -> isDose(s), owner);
  //     var doseCount = statuses != null ? Math.round(statuses.length) : 0;
  //     var doseNeed = vars.var1;
  //     if (doseCount >= doseNeed) {
  //       addStatus(target, Skill.Rogue_Talent_LethalPoison_Status);
  //       removeStatuses(target, s -> isDose(s));
  //       ...
  //
  // One hidden status per skill CATEGORY, each capped at one stack by its
  // row (no props.status.maxStacks: Status.getMaxStacks@15831 answers 1) and
  // authoring no duration (it leaves only when consumed); `vars.var1` of
  // them on the target at once and they are all removed for one application
  // of the status. The four predicates compile to tests on the hitting
  // skill's TYPE (script.skills.Rogue_Talent_LethalPoison
  // .Rogue_Talent_LethalPoison.onInflictHitNewTarget@45254: BaseSkill.isWeaponSkill@6161, BaseSkill.isClassSkill@6158,
  // BaseSkill.isFinalAttack@6154, BaseSkill.isSignature@6159), and `isFinalCombo` is the base
  // chain's last link, skill type AttackCombo - the game term the tooltip
  // prints is "Final Combo Attack" - not the signature Finisher.
  //
  // What is returned is what the fight plays: the categories with the dose
  // each lays, the count that converts, the status applied. Anything that
  // does not fit - a category predicate this reader has no event for, a dose
  // row that can stack or that times out, a count that is not a plain var -
  // returns null and the status keeps whatever refusal it had.
  const DOSE_CATEGORY = [
    [/^isWeaponSkill$/, 'weapon-skill'],
    [/^isClassSkill$/, 'class-skill'],
    [/^(?:isFinalCombo|isFinalAttack)$/, 'combo'],
    [/^isSignature$/, 'signature'],
  ];
  const fnParams = (body, name) => {
    const m = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`).exec(body);
    return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
  };
  const gateCache = new Map();
  function doseGateOf(skillId, rank = 1) {
    const key = skillId + '@' + rank;
    if (gateCache.has(key)) return gateCache.get(key);
    const done = (v) => { gateCache.set(key, v); return v; };
    const s = skills.get(skillId);
    const body = liveScript(s?.script ?? '');
    const hook = hookBody(body, 'onInflictHitNewTarget');
    if (!hook) return done(null);
    const alias = new Map();
    SKILL_ALIAS.lastIndex = 0;
    for (let m; (m = SKILL_ALIAS.exec(body));) alias.set(m[1], m[2]);
    const categories = [];
    let helper = null;
    const CALL = /if\s*\(\s*(\w+)\.(\w+)\s*\)\s*\{?\s*(\w+)\s*\(\s*(?:Skill\.)?(\w+)\s*,\s*\1\.target\s*\)\s*;?\s*\}?/g;
    for (let m; (m = CALL.exec(hook));) {
      const cat = DOSE_CATEGORY.find(([re]) => re.test(m[2]))?.[1] ?? null;
      const status = skills.has(m[4]) ? m[4] : alias.get(m[4]);
      if (!cat || !status || !skills.has(status)) return done(null);
      if (helper && helper !== m[3]) return done(null);
      helper = m[3];
      const row = skills.get(status);
      // One unique dose per category, held until consumed - or it is not
      // this shape.
      if (maxStacksOf(status, rank) !== 1 || Number(row.duration) > 0) return done(null);
      categories.push({ on: cat, status, label: row.texts?.name ?? status });
    }
    if (!helper || !categories.length) return done(null);
    // The helper: lay the dose it was handed, then run the count.
    const hp = fnParams(body, helper);
    const hb = hookBody(body, helper);
    if (!hp || hp.length !== 2) return done(null);
    const hm = new RegExp(`^\\s*addStatus\\s*\\(\\s*${hp[1]}\\s*,\\s*${hp[0]}\\s*\\)\\s*;\\s*(\\w+)\\s*\\(\\s*${hp[1]}\\s*\\)\\s*;?\\s*$`).exec(hb);
    if (!hm) return done(null);
    const checkFn = hm[1];
    const cb = hookBody(body, checkFn);
    if (!/\.getStatuses\s*\(/.test(cb)) return done(null);
    const cmp = /if\s*\(\s*\w+\s*>=\s*(vars\.\w+|\w+)\s*\)/.exec(cb);
    if (!cmp) return done(null);
    const needKey = cmp[1].startsWith('vars.') ? cmp[1].slice(5)
      : new RegExp(`\\bvar\\s+${cmp[1]}\\s*=\\s*vars\\.(\\w+)\\s*;`).exec(cb)?.[1] ?? null;
    const need = needKey ? (combat.profile(skillId, rank)?.vars ?? s.vars ?? {})[needKey] : null;
    if (!(Number.isInteger(need) && need >= 1)) return done(null);
    const ap = /addStatus\s*\(\s*\w+\s*,\s*(?:Skill\.)?(\w+)\s*\)\s*;\s*removeStatuses\s*\(/.exec(cb.slice(cmp.index));
    const applies = ap ? (skills.has(ap[1]) ? ap[1] : alias.get(ap[1])) : null;
    if (!applies || !skills.has(applies)) return done(null);
    // The visible marker the script keeps in step with the count
    // (`enforceStatusCount(target, Skill.M, count)`): display only, but a
    // status of the owner's on the target all the same.
    const mk = /enforceStatusCount\s*\(\s*\w+\s*,\s*(?:Skill\.)?(\w+)\s*,/.exec(body);
    const marker = mk ? (skills.has(mk[1]) ? mk[1] : alias.get(mk[1]) ?? null) : null;
    return done({
      from: skillId, fromName: s.texts?.name ?? skillId,
      need, categories, applies, marker, checkFn,
      markerName: marker ? (skills.get(marker)?.texts?.name ?? marker) : null,
    });
  }

  // --- what a script hangs on a status's OWN hits ------------------------------
  //
  // A status the build applies is hit-bearing in its own right - its ticks,
  // and any step a script plays on it - and other rows hang riders on those
  // hits by naming the status (`dmg.skillId == Skill.S`), one of its steps
  // (`dmg.stepId == Steps.X`), or its kind (`dmg.isDoT`). None of that is a
  // stat, and none of it is a rate the plan can know: how many stacks a
  // counter holds, or how many poisons are on the target, is the fight's own
  // state. So each shape is read HERE, off the row alone, into a descriptor;
  // `resolve` binds the ones whose status this build actually applies onto
  // the dot the fight schedules, sim.mjs plays them, and `bench talents`
  // prints the same descriptors so the tree and the fight cannot disagree
  // about what a node does.
  //
  // Seven shapes, each quoted from the row that has it on build 25782799:
  //
  //   reapply      `onTryAddStatus(sInf, target) { if (sInf.id == Skill.S &&
  //                hasStatus(target, Skill.S)) { var p =
  //                target.getStatus(Skill.S); p.playStep(Steps.X); } }` -
  //                step X of status S, played on S itself each time S is
  //                applied to a target that already wears it (Lethal Poison's
  //                Blast; compiled Rogue_Talent_LethalPoison.onTryAddStatus@45255 ops 7-17: getStatus,
  //                then a call to BaseSkill.playStep@6214 with the string
  //                "Blast" - the callee is a server-only stub here, the call
  //                is the read).
  //   step-rider   `if (dmg.skillId == Skill.S && dmg.stepId == Steps.X)
  //                dmg.critChance += vars.k` - Deadly Poison on the Blast.
  //   stack-rider  `onInflictDamage(dmg) { if (dmg.skillId == Skill.S &&
  //                dmg.stepId == Steps.X) addStatus(dmg.target, Skill.V) }`
  //                with V's own `onReceiveDamageEval(dmg) { if (dmg.skillId ==
  //                Skill.S) dmg.dmgMult += vars.k * stacks }` - Venom
  //                Infusion: a counter the status's hits feed and its hits
  //                read, +1 per Blast to V's cap, for V's duration.
  //   cooldown     `onInflictDamage(dmg) { if (dmg.skillId == Skill.S) { if
  //                (checkProba(vars.c)) reduceWeaponsCooldown(vars.t); } }` -
  //                Noxious Stratagem, on every damage instance of the status
  //                (the guard names no step, so ticks and the Blast alike).
  //   per-typed    `if (dmg.isDoT) { var n = dmg.target.getStatusesCount(s ->
  //                s.isType(StatusType.T)); dmg.dmgMult += vars.k * n; }` -
  //                Intent to Kill (its Rogue_Talent_IntentToKill.onInflictDamageEval@45280:
  //                $HSkill.isDoT@21772 on the hitting
  //                skill's inf; GameObject.getStatusesCount@4632 counts
  //                instances on the target, whoever applied them, the hitting
  //                status included).
  //   combo-bank   `onInflictStatus(s) { if (s.isType(StatusType.T))
  //                addStatus(owner, Skill.B); }` with B's `onSkillProc(ctx) {
  //                if (ctx.skill.isFinalAttack()) { ctx.dmgMult *= (1 +
  //                vars.k * stacks); stop(); } }` - Improved Mixture
  //                (Rogue_Talent_ImprovedMixture.onInflictStatus@45272, and the bank's own
  //                Rogue_Talent_ImprovedMixture_Status.onSkillProc@45274): a bank on the owner, one stack per
  //                status of type T it STARTS (the hook's one raise site is
  //                Status.start@15819 through onApplyStatus@4602, so a dose
  //                already on the target banks nothing), spent by the next
  //                finisher.
  //   companion    a hook that puts one more status on the target whenever S
  //                (or a status of some type) lands - Crippling Poison,
  //                Atrophic Poison. It deals nothing; it is one more status
  //                of the owner's on the target, which a count-scaled rider
  //                counts.
  //
  // `rank` is the rank the row answers its own props.rankOverride at: the
  // points in a talent node, the weapon rank for anything else. A status a
  // script applies takes the rank of the skill that applied it
  // (Status.get_rank@15802 ops 0-5), so the counter and the bank are read at
  // that same rank.
  const hitHookCache = new Map();
  function hitHooksOf(hostId, rank = 1, runes = null) {
    const key = hostId + '@' + rank + (runes?.size ? '@' + [...runes].sort().join('+') : '');
    if (hitHookCache.has(key)) return hitHookCache.get(key);
    const out = [];
    hitHookCache.set(key, out);
    const row = skills.get(hostId);
    if (!row?.script) return out;
    const body = liveScript(row.script);
    const vars = combat.profile(hostId, rank, runes)?.vars ?? row.vars ?? {};
    const num = (k) => (typeof vars[k] === 'number' && vars[k] > 0 ? vars[k] : null);
    const NAME = '(?:Skill\\.)?(\\w+)';
    const isStatus = (id) => !!skills.get(id)?.props?.status;
    const name = (id) => skills.get(id)?.texts?.name ?? id;
    {
      const m = new RegExp(`if\\s*\\(\\s*\\w+\\.id\\s*==\\s*${NAME}\\s*&&\\s*hasStatus\\s*\\(\\s*(\\w+)\\s*,\\s*(?:Skill\\.)?\\1\\s*\\)\\s*\\)\\s*\\{\\s*`
        + 'var\\s+(\\w+)\\s*=\\s*\\2\\.getStatus\\s*\\(\\s*(?:Skill\\.)?\\1\\s*\\)\\s*;\\s*\\3\\.playStep\\s*\\(\\s*Steps\\.(\\w+)\\s*\\)')
        .exec(hookBody(body, 'onTryAddStatus'));
      if (m && isStatus(m[1])) out.push({ kind: 'reapply', status: m[1], statusName: name(m[1]), stepId: m[4] });
    }
    {
      const RE = new RegExp(`if\\s*\\(\\s*\\w+\\.skillId\\s*==\\s*${NAME}\\s*&&\\s*\\w+\\.stepId\\s*==\\s*Steps\\.(\\w+)\\s*\\)\\s*\\{?\\s*`
        + '\\w+\\.(critChance|dmgMult)\\s*\\+=\\s*vars\\.(\\w+)\\s*;', 'g');
      for (const m of hookBody(body, 'onInflictDamageEval').matchAll(RE)) {
        const v = num(m[4]);
        if (v != null && isStatus(m[1])) {
          out.push({ kind: 'step-rider', status: m[1], statusName: name(m[1]), stepId: m[2], field: m[3], amount: v });
        }
      }
    }
    {
      const m = new RegExp(`if\\s*\\(\\s*\\w+\\.skillId\\s*==\\s*${NAME}\\s*(?:&&\\s*\\w+\\.stepId\\s*==\\s*Steps\\.(\\w+)\\s*)?\\)\\s*\\{?\\s*`
        + `addStatus\\s*\\(\\s*\\w+\\.target\\s*,\\s*${NAME}\\s*\\)`).exec(hookBody(body, 'onInflictDamage'));
      const vRow = m ? skills.get(m[3]) : null;
      const vm = vRow ? new RegExp(`if\\s*\\(\\s*\\w+\\.skillId\\s*==\\s*(?:Skill\\.)?${m[1]}\\s*\\)\\s*\\{?\\s*`
        + '\\w+\\.dmgMult\\s*\\+=\\s*vars\\.(\\w+)\\s*\\*\\s*stacks\\s*;')
        .exec(hookBody(liveScript(vRow.script ?? ''), 'onReceiveDamageEval')) : null;
      const per = vm ? (combat.profile(m[3], rank, runes)?.vars ?? vRow.vars ?? {})[vm[1]] : null;
      const cap = vRow ? maxStacksOf(m[3], rank) : null;
      if (vm && isStatus(m[1]) && typeof per === 'number' && per > 0 && Number.isFinite(cap) && Number(vRow.duration) > 0) {
        out.push({
          kind: 'stack-rider', status: m[1], statusName: name(m[1]), fedByStep: m[2] ?? null,
          counter: m[3], counterName: name(m[3]), per, cap, duration: Number(vRow.duration),
        });
      }
    }
    {
      const m = new RegExp(`if\\s*\\(\\s*\\w+\\.skillId\\s*==\\s*${NAME}\\s*\\)\\s*\\{?\\s*`
        + '(?:if\\s*\\(\\s*checkProba\\s*\\(\\s*vars\\.(\\w+)\\s*\\)\\s*\\)\\s*\\{?\\s*)?'
        + 'reduceWeaponsCooldown\\s*\\(\\s*vars\\.(\\w+)\\s*\\)').exec(hookBody(body, 'onInflictDamage'));
      const seconds = m ? num(m[3]) : null;
      const chance = m ? (m[2] ? num(m[2]) : 1) : null;
      if (m && isStatus(m[1]) && seconds != null && chance != null) {
        out.push({ kind: 'cooldown', status: m[1], statusName: name(m[1]), chance: Math.min(1, chance), seconds });
      }
    }
    {
      const m = new RegExp('if\\s*\\(\\s*\\w+\\.isDoT\\s*\\)\\s*\\{\\s*var\\s+(\\w+)\\s*=\\s*\\w+\\.target\\.getStatusesCount\\s*\\(\\s*'
        + '(\\w+)\\s*->\\s*\\2\\.isType\\s*\\(\\s*(?:StatusType\\.)?(\\w+)\\s*\\)\\s*\\)\\s*;\\s*'
        + '\\w+\\.dmgMult\\s*\\+=\\s*vars\\.(\\w+)\\s*\\*\\s*\\1\\s*;').exec(hookBody(body, 'onInflictDamageEval'));
      const v = m ? num(m[4]) : null;
      if (m && v != null) out.push({ kind: 'per-typed', statusType: m[3], amount: v });
    }
    {
      const m = new RegExp('if\\s*\\(\\s*\\w+\\.isType\\s*\\(\\s*(?:StatusType\\.)?(\\w+)\\s*\\)\\s*\\)\\s*\\{?\\s*'
        + `addStatus\\s*\\(\\s*owner\\s*,\\s*${NAME}\\s*\\)`).exec(hookBody(body, 'onInflictStatus'));
      const bRow = m ? skills.get(m[2]) : null;
      const bm = bRow ? /if\s*\(\s*\w+\.skill\??\.isFinalAttack\s*\(\s*\)\s*\)\s*\{\s*\w+\.dmgMult\s*\*=\s*\(\s*1\s*\+\s*vars\.(\w+)\s*\*\s*stacks\s*\)\s*;\s*stop\s*\(\s*\)/
        .exec(hookBody(liveScript(bRow.script ?? ''), 'onSkillProc')) : null;
      const per = bm ? (combat.profile(m[2], rank, runes)?.vars ?? bRow.vars ?? {})[bm[1]] : null;
      const cap = bRow ? maxStacksOf(m[2], rank) : null;
      if (bm && typeof per === 'number' && per > 0 && Number.isFinite(cap)) {
        out.push({
          kind: 'combo-bank', feedType: m[1], bank: m[2],
          bankName: bRow.texts?.name ?? row.texts?.name ?? m[2], per, cap,
          // What the row's own text calls the thing it banks on (its
          // ::ref_name::), for a label - the type itself carries no name.
          feedName: skills.get(row.texts?.refs?.ref ?? '')?.texts?.name ?? null,
        });
      }
    }
    for (const hookName of ['onInflictStatus', 'onInflictStatusEval']) {
      const m = new RegExp(`\\.kind\\s*==\\s*${NAME}([^{]*)\\)\\s*\\{?\\s*addStatus\\s*\\(\\s*\\w+\\.(?:target|owner)\\s*,\\s*${NAME}\\s*\\)`)
        .exec(hookBody(body, hookName));
      if (!m || !isStatus(m[1]) || !skills.has(m[3])) continue;
      out.push({
        kind: 'companion', status: m[1], companion: m[3],
        withType: /isType\s*\(\s*(?:StatusType\.)?(\w+)\s*\)/.exec(m[2])?.[1] ?? null,
      });
    }
    return out;
  }

  /**
   * Cooldown a row's script hands back to a NAMED skill somebody presses, off
   * the row alone - for the tree's label. `resolve` is the pricing reader (it
   * knows which skills are in the rotation and judges the guard); this only
   * says what the row declares, on the same hooks that one accepts.
   */
  /**
   * Which rows play a status's step when the status is RE-APPLIED (the
   * `reapply` shape of `hitHooksOf`), whether or not a build holds them - so a
   * build that lacks the row can be told which row it lacks. A fact of the
   * sheet, indexed once.
   */
  let reapplyIndex = null;
  function reapplyHostsOf(statusId, stepId) {
    if (!reapplyIndex) {
      reapplyIndex = new Map();
      for (const o of cdb.lines('skill')) {
        if (!o.script || !o.script.includes('onTryAddStatus')) continue;
        for (const h of hitHooksOf(o.id, 1)) {
          if (h.kind !== 'reapply') continue;
          const k = `${h.status}#${h.stepId}`;
          if (!reapplyIndex.has(k)) reapplyIndex.set(k, []);
          reapplyIndex.get(k).push(o.id);
        }
      }
    }
    return reapplyIndex.get(`${statusId}#${stepId}`) ?? [];
  }

  /**
   * Would the fight PRESS this skill as its row stands, no rune slotted - is
   * there anything on it a press is scored for? The triage `resolve` runs on a
   * cooldown it is handed (a payload of its own, a one-shot status, a timed
   * buff or debuff, a dot), asked of the row alone. For whoever weighs
   * cooldown handed to it before any build exists: the Rogue's Finisher is a
   * hit and answers yes; Judgment (the Priest's signature) answers no - what
   * it does is `priest.divineInterventionProc()`, compiled code. The fight
   * does press it, for the prayers it releases (or for the timed buff
   * Spirited Disciple or Revitalized Soul hangs on it), but those prayers
   * are lines of their own, made ready by their own events, and which of
   * them a build slots is not something this row says: a press sooner
   * releases nothing more than was ready.
   */
  const pressCache = new Map();
  function pressIsScored(skillId) {
    if (pressCache.has(skillId)) return pressCache.get(skillId);
    const prof = combat.profile(skillId, 3);
    const st = prof ? statusesOf(skillId, { rank: 3 }) : null;
    const yes = !!prof && (carriesPayload(prof) || oneShotPayloads(skillId, { rank: 3 }).length > 0
      || st.self.some((b) => b.duration > 0) || st.onTarget.some((d) => d.duration > 0) || st.dots.length > 0);
    pressCache.set(skillId, yes);
    return yes;
  }

  function cooldownGiftsOf(hostId, rank = 1) {
    const row = skills.get(hostId);
    const body = liveScript(row?.script ?? '');
    if (!body) return [];
    const vars = combat.profile(hostId, rank)?.vars ?? row.vars ?? {};
    const out = [];
    const RE = /\b(resetCooldown|reduceCooldown)\s*\(\s*Skill\.([A-Za-z0-9_]+)\s*(?:,\s*(?:vars\.([A-Za-z0-9_]+)|([A-Za-z_]\w*)))?\s*\)/g;
    for (const m of body.matchAll(RE)) {
      const fn = hookAt(body, m.index);
      if (!/^on(Damage|DamageEval|InflictDamage|InflictHit|InflictDamageEval|FirstHit|Hit)$/.test(fn)) continue;
      if (!ACTIVE_TYPES.has(typeOf(m[2]))) continue;
      const key = m[3] ?? (m[4]
        ? new RegExp(`\\bvar\\s+${m[4]}\\s*=\\s*vars\\.(\\w+)\\s*;`).exec(hookBody(body, fn))?.[1] : null);
      const seconds = m[1] === 'reduceCooldown' ? vars[key] : null;
      if (m[1] === 'reduceCooldown' && !(typeof seconds === 'number' && seconds > 0)) continue;
      const scope = enclosingBlock(body.slice(0, m.index));
      const cv = /checkProba\s*\(\s*vars\.(\w+)/.exec(scope)?.[1];
      out.push({
        call: m[1], target: m[2], targetName: skills.get(m[2])?.texts?.name ?? m[2], seconds,
        events: [...eventsOf(scope)],
        chance: cv && typeof vars[cv] === 'number' ? vars[cv] : 1,
        critGated: /\bcritical\b|\bisCrit\b/.test(scope),
        // Whether the time can buy a cast without a rune's help.
        pressed: pressIsScored(m[2]),
      });
    }
    return out;
  }

  const statusCache = new Map();
  function statusesOf(skillId, { runes = null, rank = 1, talents = null, talentRanks = null } = {}) {
    // The talents belong in the key as much as the runes do: a call site guarded
    // by `hasTalent(X)` resolves differently for a build that took X.
    const key = skillId + '#' + rank
      + (runes?.size ? '@' + [...runes].sort().join('+') : '')
      + (talents?.size ? '%' + [...talents].sort().join('+') : '')
      // The RANK of an allocated talent, not just its presence: a status cap
      // may read it (`maxStacksOf`'s script path), so two builds holding the
      // same nodes at different point counts are not the same key.
      + (talentRanks?.size ? '~' + [...talentRanks].sort().map(([k, v]) => k + v).join('+') : '');
    let hit = statusCache.get(key);
    if (hit) return hit;

    const s = skills.get(skillId);
    // The same row with its vars as this rank leaves them - what `triggerOf`
    // reads a `checkProba(vars.x)` against (see `varsOf`).
    const sAt = s ? { ...s, vars: varsOf(skillId, rank, runes) } : s;
    const found = new Map(); // statusId -> { to, trigger, appliedDuration, scriptMagnitude, site }
    // Statuses this skill would apply if the build had the thing that arms it.
    // Reported rather than silently dropped: "Hold the Line does nothing here"
    // is a fact about the allocation, and the reason belongs next to it.
    const unmetDeps = [];
    // `site` is WHERE the row authors the application - a Status step, an
    // effect, or a script call, with the step or hook it sits in. Nothing
    // here judges it; `crowdControlOf` is the reader that asks.
    const note = (statusId, to, trigger = { on: 'cast', chance: 1, why: 'applied by the cast itself' },
      appliedDuration = null, scriptMagnitude = false, site = null) => {
      if (!statusId || found.has(statusId)) return;
      found.set(statusId, { to, trigger, appliedDuration, scriptMagnitude, site });
    };

    // The same gate `damage.mjs profile()` applies to a step, so a rank-gated
    // or charge-gated Status step is not granted at rank 1. Three real rows
    // needed it: Scepter_Flamie_S2 step 6 is `minRank: 2`, GM_MassGrab_Skill1's
    // stun is `minRank: 2`, Book_WaterOrbs_Skill1's buff is `minRank: 3`.
    let maxHold = 0;
    for (const st of s?.steps ?? []) {
      const h = st.cond?.castHoldStep;
      if (typeof h === 'number' && h > maxHold) maxHold = h;
    }
    const stepLives = (st) => {
      const c = st.cond ?? {};
      if (c.minRank != null && rank < c.minRank) return false;
      if (c.maxRank != null && rank > c.maxRank) return false;
      if (c.equalRank != null && rank !== c.equalRank) return false;
      if (typeof c.castHoldStep === 'number' && c.castHoldStep !== maxHold) return false;
      if (c.mastery && !runes?.has(c.mastery)) return false;
      if (c.masteryExclude && runes?.has(c.masteryExclude)) return false;
      return true;
    };

    // Path 1: a Status step names it outright.
    //
    // `props.status.target` cannot be read literally. All six DoT applications
    // that come through this path say `Self`, and putting an enemy's bleed on
    // the player is not a rounding error - it is the wrong entity. The value
    // that survives every row is: an explicit Target/Group wins, and otherwise
    // the recipient is the step's natural subject - whoever was hit for a Hit
    // or ProjectileHit step, the caster for a Start or CastEnd one.
    // A TALENT's steps are only ever reached through its script - the node has
    // no cast - so a status its steps apply takes its trigger from the script's
    // own playStep site, not from the 'applied by the cast itself' default that
    // a talent can never satisfy. Acidic Splatter's poison cloud is the case:
    // playStep(Steps.Area) sits behind "the signature finisher's first hit, at
    // vars.chance x combo points", and that is a rate the fight raises.
    const scriptSiteTrigger = (() => {
      if (typeOf(s?.id) !== 'Talent' || !s?.script) return null;
      const body = liveScript(s.script);
      const m = /playStep\s*\(\s*Steps\./.exec(body);
      return m ? triggerOf(body.slice(0, m.index), sAt) : null;
    })();
    // ...AND SO IS ANY STEP THE CAST DOES NOT PLAY, on whatever row. An
    // `on: Code` (or Trigger) step is played by `playStep(Steps.<id>)` and by
    // nothing else, so a status it carries lands when that call runs: Hidden
    // Power's buff when you walk into its cloud (onHit, behind the Cloud
    // step's area), the Book of Mi'Mizan's charge as each sphere flies back
    // (a closure under onStep), a step no call names at all - never. All of
    // them were noted as "applied by the cast itself". The trigger is read
    // at THAT step's call site, and it says whether the fight raises the hook
    // it sits in; `crowdControlOf` already judged crowd control this way.
    const playedSiteTrigger = (st) => {
      const on = stepOnNames[st.on ?? -1] ?? null;
      if (on !== 'Code' && on !== 'Trigger') return undefined;
      const body = liveScript(s?.script ?? '');
      const m = st.id ? new RegExp('\\bplayStep\\s*\\(\\s*Steps\\.' + st.id + '\\b').exec(body) : null;
      if (!m) {
        return {
          on: 'cast', chance: 1, hook: null, unread: null, reapply: null,
          notPlayed: 'no playStep call in the row\'s script names the step that carries it',
          why: 'it sits on a step only a script can play, and no playStep call names that step',
        };
      }
      const trig = triggerOf(body.slice(0, m.index), sAt);
      const hook = hookAt(body, m.index);
      if (!RIDER_HOOKS.test(hook)) {
        trig.notPlayed = `the step that carries it is played from ${hook || 'top-level script'}, an event this fight does not produce`;
        trig.why = `${hook || 'its script'} plays the step that carries it`;
      } else if (trig.on === 'cast') {
        trig.why = `${hook} plays the step that carries it`;
      }
      return trig;
    };
    for (const st of s?.steps ?? []) {
      if (!stepLives(st)) continue;
      const ref = st.props?.status?.ref;
      if (ref) {
        const on = stepOnNames[st.on ?? -1] ?? null;
        const declared = st.props.status.target;
        // The column documents itself: "When a target is available (after a
        // hit), defaults to it. Otherwise, applies to self." An explicit value
        // therefore wins outright, and an ABSENT one follows the step - EXCEPT
        // that a Hit step is not always a hit on an enemy. Priest_BlessingOfFervor
        // lands its buff through an Area step whose hitFilter is Allies|Self,
        // so "whoever was hit" is you. The status's own Buff/Debuff typing is
        // the check that survives every row: a Buff never goes on the enemy.
        const t = (skills.get(ref)?.props?.status?.types ?? []).map((x) => x.type);
        const buffOnly = t.includes('Buff') && !t.includes('Debuff');
        // By NAME: the column is an enum whose order a patch may change (it
        // has, elsewhere - affix.target lost a case from its middle), and a
        // case with no reading here - SkillTarget, which no row uses yet -
        // falls to the step's natural subject like an absent one, not to
        // whichever name used to sit at its index.
        const declaredName = declared == null ? null : (statusTargetNames[declared] ?? null);
        const to = STATUS_TARGETS.includes(declaredName) ? declaredName
              : buffOnly ? 'Self'
                : (on === 'Hit' || on === 'ProjectileHit') ? 'Target' : 'Self';
        // A Status step can also carry the lifetime for a status that declares
        // none of its own - Scepter_Flamie_S2 gives its flame `dur2` = 8s while
        // Scepter_Flamie_P gives the same status -1, i.e. forever.
        note(ref, to, scriptSiteTrigger ?? playedSiteTrigger(st), st.duration, false,
          { route: 'step', stepId: st.id ?? null, on });
      }
      // An effect can carry one too, and that one rides the hit - with the
      // lifetime written beside it, the same column a Status step has and the
      // same two spellings (a number, or a vars key). Luon Shackles authors
      // `status: "Stun", duration: "dur1"` on its hit effect and the Stun row
      // declares no lifetime of its own, so dropping the effect's left the
      // stun with none. The body that applies an effect's status is not on
      // this client (ent.Unit.applyEffect@4912 is a `!isServer` stub); what
      // says the column is the lifetime is the row's own tooltip - "stunning
      // them for ::dur1::", and at rank 2 "Stun duration increased to
      // ::dur1::" over a rankOverride that restates exactly that key.
      for (const e of st.effects ?? []) {
        if (e.status) {
          note(e.status, 'Target', scriptSiteTrigger ?? playedSiteTrigger(st), e.duration ?? null, false,
            { route: 'effect', stepId: st.id ?? null, on: stepOnNames[st.on ?? -1] ?? null });
        }
      }
    }

    // Path 2: the script names it, possibly through a local alias.
    //
    // Comments are stripped first. Three scripts carry a commented-out
    // `addStatus` - Warrior_Rage's `//addSkillCharges(...)` neighbour,
    // Crimson_Book_Skill, and one of the two calls in
    // Daggers_DuplicatePoison_ComboAttack - and crediting a build with a status
    // the developer switched off is a silent, flattering error.
    //
    // WHEN it lands is read from the same script, because the difference
    // between "on every weapon skill" and "on a 25% base-attack roll" is a
    // factor of ten and both live in one line of guard. Only the handful of
    // predicates the rotation can already price are recognised; anything else
    // falls back to "whenever this skill goes off", which for a passive means
    // the model says so rather than inventing a rate.
    if (s?.script) {
      const live = liveScript(s.script);
      const alias = new Map();
      SKILL_ALIAS.lastIndex = 0;
      for (let m; (m = SKILL_ALIAS.exec(live));) alias.set(m[1], m[2]);
      // THE CAST'S OWN AFFINITY ANSWERS `isPhysical` / `isMagic` in a hook
      // that only ever sees the cast's own hits. Swift Strike stacks its
      // critical-chance buff from `onDamage(dmg) { if (dmg.isPhysical &&
      // dmg.isFirstHit) addStatus(owner, ...) }`, and the hit it is asking
      // about is its own: one Physical effect on the step the cast plays.
      // `isPhysical` is the affinity's damage type by id
      // (DamageResult.get_isPhysical@5216 -> $HSkill.isPhysical@21764:
      // getDamageType(affinity).id == "Physical"), which is the root
      // `affinityOf` walks to. Only the steps the CAST plays count - the same
      // row's script-played BonusDamage step is Magic, raises the hook too,
      // and correctly fails the test - and only when every one of them
      // agrees; a cast of mixed schools keeps the refusal it had.
      const castRoots = new Set((combat.profile(skillId, rank, runes)?.effects ?? [])
        .filter((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length))
        .map((e) => combat.affinityOf(e.affinity).root));
      const answerAffinity = (text, at) => {
        if (castRoots.size !== 1 || !/^on(?:Damage|DamageEval|FirstHit|Hit)$/.test(hookAt(text, at))) return text;
        const fnAt = text.lastIndexOf('function', at);
        return text.slice(0, fnAt)
          + text.slice(fnAt, at).replace(/(!\s*)?\b\w+\.is(Physical|Magic)\b/g,
            (whole, neg, which) => (!neg && castRoots.has(which) ? ' '.repeat(whole.length) : whole))
          + text.slice(at);
      };
      ADD_STATUS.lastIndex = 0;
      for (let m; (m = ADD_STATUS.exec(live));) {
        const [, who, raw, tail] = m;
        const resolved = skills.get(raw) ? raw : alias.get(raw);
        if (!resolved || !skills.get(resolved)) continue;
        const liveAt = answerAffinity(live, m.index);
        // A script names its recipient, and that name is the answer. `owner` is
        // you; `hit.target`/`dmg.target` is the enemy; a loop variable handing
        // the status to allies is NEITHER.
        //
        // And `hit.target` is not always an enemy either: `GM_MassGrab_Skill2`
        // buffs `hit.target` inside `if (hit.targetUnit.kind == Unit.Summon_Bee)`,
        // so the thing it hit is its own pet. Reading the Buff typing over that
        // guard made the bee's +50% DamageModifier a permanent stat on the
        // character. The guard is right there in the enclosing block.
        const guard = enclosingBlock(liveAt.slice(0, m.index));
        // The rest of that same guard decides whether this call site is live at
        // all. A `rank >= 2` rider means a rank-1 character never gets the
        // status, and crediting it anyway is the model handing out an upgrade
        // the character has not earned.
        const g = guardOf(guard, { rank, runes, talents });
        if (!g.fires) continue;
        // ...and so does the OTHER half of that guard: what it fires ON. A
        // handler that runs when a named status lands is dead in a build that
        // never applies that status, and `Warrior_Talent_HoldTheLine` was being
        // credited its whole payload for a Rage Shield it may not have taken.
        // Only a status the loadout can definitively rule out kills the branch.
        let deadDep = null;
        for (const dep of statusDepsOf(guard, alias)) {
          if (canApply(dep, { talents, runes, own: skillId }) === false) { deadDep = dep; break; }
        }
        if (deadDep) {
          unmetDeps.push({
            from: skillId, status: resolved, needs: deadDep,
            name: skills.get(resolved)?.texts?.name ?? resolved,
            needsName: skills.get(deadDep)?.texts?.name ?? deadDep,
          });
          continue;
        }
        // THE LOOP OVER THE CASTER'S PARTY HANDS THE STATUS TO THE CASTER.
        // `for (h in getPartyHeroesWithinRange(ownerHero, vars.range))
        // addStatus(h, S)` with nobody left out is every hero of the caster's
        // party in range, THE CASTER AMONG THEM: SkillScript
        // .getPartyHeroesWithinRange@6861 walks hero.player.group.players
        // (ops 17-25, the loop 36-84) and pushes each player's hero inside
        // the range (op 79 the distance test, op 83 the push), and the hero
        // it was handed is compared with nobody. MEASURED 2026-10-13:
        // Mystic Empowerment went on 39 times, 33 of them on the hero who
        // cast it - once for each of the 33 casts - and the bench's own Mage,
        // fighting alone, wore it after each of her five (so a hero alone
        // still has a group to walk; with none, ops 23-28 return the empty
        // list). So the loop variable is `owner` for this fight of one hero,
        // and the status is hers like any other the script hands to owner.
        // It was first filed as a third party's ("an ally or a summon, not
        // you"), then as the party's with the caster in it and unpriced.
        const whoRe = who.replace(/\./g, '\\.');
        const partyLoop = new RegExp(`for\\s*\\(\\s*${whoRe}\\s+in\\s+getPartyHeroes\\w*\\s*\\(\\s*(?:owner|ownerHero)\\s*[,)]`).test(guard)
          && !new RegExp(`\\b${whoRe}\\s*!=\\s*owner\\b|\\bowner\\s*!=\\s*${whoRe}(?![\\w.])`).test(guard);
        const elsewhere = !partyLoop && /Unit\.Summon_|targetUnit\.kind|isAlly|onPlayerAllies|getPartyHeroes/.test(guard);
        const fnAt = hookAt(live, m.index);
        // `<s>.owner`, where <s> is the STATUS a status hook was handed, is
        // whoever wears that status - not an ally, not a summon. Atrophic
        // Poison: `onInflictStatus(s) { if (s.kind == Skill.<Lethal Poison>)
        // addStatus(s.owner, Skill.<Atrophic>) }` (compiled
        // Rogue_Talent_AtrophicPoison.onInflictStatus@45310: op 4 reads
        // `owner` off the st.skill.Status), so the recipient is the poisoned
        // enemy. Resolved only where the guard names the status and its own
        // typing says who wears it; anything else stays a third party.
        //
        // ...or names its TYPE: Crippling Bloodloss, `onInflictStatus(s) { if
        // (s.isType(StatusType.Hemorage)) addStatus(s.owner, ...) }`. Who
        // wears a status of a type is what the rows of that type say, all of
        // them (parents walked, as isType walks them): every Hemorage row in
        // the sheet is a Debuff, so its wearer is the bleeding enemy - where
        // the 2026-10-13 capture has the status, 18 rows and every one on a
        // foe. A type whose rows disagree settles nothing and stays a third
        // party.
        const viaStatusOwner = (() => {
          const p = /^on(?:InflictStatus|ReceiveStatus)$/.test(fnAt) ? fnParams(live, fnAt)?.[0] : null;
          if (!p || who !== `${p}.owner`) return null;
          const worn = new RegExp(`\\b${p}\\.kind\\s*==\\s*(?:Skill\\.)?(\\w+)`).exec(guard)?.[1];
          if (worn) {
            const types = (skills.get(skills.has(worn) ? worn : alias.get(worn) ?? '')?.props?.status?.types ?? [])
              .map((x) => x.type);
            return types.includes('Debuff') ? 'Target' : types.includes('Buff') ? 'Self' : null;
          }
          const typed = new RegExp(`\\b${p}\\.isType\\s*\\(\\s*(?:StatusType\\.)?(\\w+)\\s*\\)`).exec(guard)?.[1];
          if (!typed) return null;
          const rows = [...skills.values()].map((r) => (r.props?.status?.types ?? []).map((x) => x.type))
            .filter((types) => typeCovers(typed, types));
          return !rows.length ? null
            : rows.every((types) => types.includes('Debuff') && !types.includes('Buff')) ? 'Target'
              : rows.every((types) => types.includes('Buff') && !types.includes('Debuff')) ? 'Self' : null;
        })();
        const to = elsewhere ? 'Elsewhere'
          : (partyLoop || SELF_TARGETS.has(who)) ? 'Self'
            : ENEMY_TARGETS.has(who) ? 'Target'
              : viaStatusOwner ?? 'Elsewhere';
        // WHO A THIRD PARTY IS, as far as the script says. `to` routes a
        // status - yours, your target's, or neither - and "neither" used to
        // be told one sentence, "an ally or a summon, not you". The
        // 2026-10-13 capture has two of the statuses a build was told that
        // about on the hero who cast them. This is read for the SENTENCE a
        // refused status is given (below, where `wearer` is Elsewhere), and
        // prices nothing:
        //
        //   ally           the guard leaves the owner out in so many words
        //                  (`a != owner`) - Ignore Pain's copy for allies,
        //                  Cursed Link.
        //   summon         the guard tests the unit for a Summon_ kind, or the
        //                  recipient is the unit onSummon was handed (Brood
        //                  Leap's bees, Beacon of Hope's totem).
        //   (the party     is not a third party: the loop over the caster's
        //                  party holds the caster, and is routed to her above.)
        //   shield-wearer `s.owner` in onShield(s, ...): whoever wears the
        //                  shield that was just applied - the owner, for a
        //                  shield of their own. Water Veil: 70 rows in the
        //                  capture, 70 on the hero who applied the shield.
        //   area-unit      the unit an area hook was handed (onAreaEntered(
        //                  area, unit)): whoever walks in. Blinding Light's
        //                  slow: 80 rows, every one on a foe.
        //   null           somebody the script names another way.
        const recipient = to !== 'Elsewhere' ? null : (() => {
          const params = fnAt ? (fnParams(live, fnAt) ?? []) : [];
          if (new RegExp(`\\b${who.replace(/\./g, '\\.')}\\s*!=\\s*owner\\b|\\bowner\\s*!=\\s*${who.replace(/\./g, '\\.')}(?![\\w.])`).test(guard)) return 'ally';
          if (/Unit\.Summon_/.test(guard) || (fnAt === 'onSummon' && who === params[0])) return 'summon';
          if (fnAt === 'onShield' && params[0] && who === `${params[0]}.owner`) return 'shield-wearer';
          if (/^onAreaEnter(?:ed)?$/.test(fnAt) && params[1] && who === params[1]) return 'area-unit';
          return null;
        })();
        // A third argument is a MAGNITUDE the script computed - a pool DoT
        // bleeding for a share of the hit that applied it. The status row then
        // carries a placeholder, not an amount.
        //
        // ...when it IS one. The parameter is a COUNT: script.SkillScript
        // .SkillScript.addStatus@6879 takes `count` at ops 0-3 and rounds it at op 11, and
        // most three-argument calls hand it exactly that - a literal
        // (`addStatus(owner, Buzzing, 2)`), a var (Blessing's
        // `addStatus(owner, Buff, vars.var1)`, "empower your next ::var1::
        // [Attack]s"), or a switch written as a ternary or as enforceStatus's
        // boolean (`setStatus(owner, S, inCombat && healthRatio < x ? 1 : 0)`,
        // `enforceStatus(owner, S, !isInCooldown())`). Only an amount the
        // script computed from the hit is a magnitude, and calling the rest
        // one refused four weapon passives for a reason that was not true.
        const third = tail === ',' ? thirdArgOf(live, m.index + m[0].length, m[0], sAt?.vars) : null;
        // ONE SWITCH IS READ rather than carried as a condition the fight
        // does not track: on `enforceStatus`, whose third argument is an
        // on/off FLAG (script.SkillScript.enforceStatus@6886 takes a bool),
        // the condition `hasStatusApplied(owner, Skill.T)` - "while a
        // status of mine named T is on somebody". Adrenaline holds its buff
        // up that way for as long as an enemy carries Lethal Poison, and was
        // refused as "its magnitude is the third argument to addStatus,
        // computed by a script from the hit that applied it" - a sentence
        // about a different call. T is a dependency like any other: a build
        // that holds no row applying it gets nothing and is told which node
        // it lacks; one that does carries the dependency out on the trigger
        // (`whileApplied`), and engine.mjs keeps the buff only when the
        // rotation really applies T - then credited for the whole fight (the
        // reading every always-on status gets, and here an over-read by
        // however long the first application takes to land).
        const whileApplied = (() => {
          if (tail !== ',' || !live.startsWith('enforceStatus', m.index)) return null;
          const cm = /^\s*hasStatusApplied\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)\s*\)\s*\)/
            .exec(live.slice(m.index + m[0].length));
          const dep = cm ? (skills.has(cm[1]) ? cm[1] : alias.get(cm[1]) ?? null) : null;
          return dep && skills.has(dep) ? dep : null;
        })();
        if (whileApplied && canApply(whileApplied, { talents, runes, own: skillId }) === false) {
          unmetDeps.push({
            from: skillId, status: resolved, needs: whileApplied,
            name: skills.get(resolved)?.texts?.name ?? resolved,
            needsName: skills.get(whileApplied)?.texts?.name ?? whileApplied,
          });
          continue;
        }
        const magnitudeFromScript = third?.kind === 'magnitude' && !whileApplied;
        // ...and of what is left, WHAT the argument was goes with the site, so
        // the refusal can say it: addStatus's third parameter is the stacks
        // to add (SkillScript.addStatus@6879 ops 0-3 default it to 1, ops
        // 11-12 round it and hand it to GameObject.addStatus), setStatus's
        // the count to set (SkillScript.setStatus@6889, a ref<f64>), and it
        // is an AMOUNT only where the script works it out from a hit - the
        // argument reads a hit's `amount`, or is a bare local in a script
        // that does (`var amount = dmg.amount * vars.x`, or the same through
        // a helper the hit's amount is passed to). Anything else the script
        // computed is a count this reader does not follow, and is refused as
        // that, not as "computed from the hit". (enforceStatus's is a
        // CONDITION - SkillScript.enforceStatus@6886 adds the status when it
        // is true and the target lacks it, ops 0-8, and removes it when it
        // is false, ops 9-14 - which is the switch above, refused under its
        // own sentence.)
        const thirdSaid = magnitudeFromScript ? (() => {
          const fromHit = /\.amount\b/.test(third.text) || (/^[A-Za-z_]\w*$/.test(third.text) && /\.amount\b/.test(live));
          return { call: /^\w+/.exec(m[0])[0], text: third.text, is: fromHit ? 'amount' : 'count' };
        })() : null;
        // A call that sits in a HELPER function is not guarded by whichever
        // hook happens to precede it in the file - `triggerOf` takes "the
        // last `function on...`", and for Lethal Poison that is
        // onTryAddStatus, three functions up and nothing to do with it. The
        // one helper shape this reader follows to its hook is the dose gate.
        const gate = fnAt && !/^on[A-Z]/.test(fnAt) ? doseGateOf(skillId, rank) : null;
        const gated = gate && gate.applies === resolved && gate.checkFn === fnAt
          ? {
            on: 'dose-gate', chance: 1, hook: 'onInflictHitNewTarget', unread: null, reapply: null, gate,
            why: `once ${gate.need} of its ${gate.categories.length} doses are on the target `
              + `(${gate.categories.map((c) => c.label).join(', ')})`,
          }
          : null;
        const trig = gated ?? triggerOf(liveAt.slice(0, m.index), sAt, g, resolved);
        // A switch is the script holding the status up only while its own
        // condition does - which is the guard, wherever it is written. (Not
        // the one switch read above: that condition is the dependency the
        // trigger already carries, and the engine answers it.)
        if (third?.kind === 'toggle' && !whileApplied) {
          trig.toggle = third.cond;
          // Which call switches it: the refusal names enforceStatus.
          trig.toggleCall = /^\w+/.exec(m[0])[0];
        }
        if (third?.kind === 'count') trig.count = third.n;
        // A status handed out only at a COUNT OF READY PRAYERS. The count
        // is live state, but the fight keeps it press by press, so the
        // comparison travels with the trigger and the fight answers it
        // (`readyPrayerTest`). A count used any other way is refused under
        // its own name rather than read as no condition at all.
        if (/\bgetChargedPrayerCount\b/.test(guard)) {
          const test = readyPrayerTest(guard, sAt?.vars, (s.mastery ?? []).find((x) => runes?.has(x.id))?.vars ?? null);
          if (test) {
            trig.readyPrayers = test;
            trig.why = `${trig.hook ?? 'its script'} applies it on a press made with `
              + `${test.op === '==' ? 'exactly' : test.op} ${test.n} prayer${test.n === 1 ? '' : 's'} ready`
              + (trig.unread ? `, and only while ${trig.unread}() holds - which this reader cannot evaluate` : '');
          } else if (!trig.unread) {
            trig.unread = 'getChargedPrayerCount';
            trig.why += ', and only at a count of ready prayers this reader cannot evaluate';
          }
        }
        // THE STATUS A LOCAL NAMES MAY BE SWAPPED ON A ROLL before it is handed
        // out: `var status = Skill.A; if (hasMastery(M)) { if (checkProba(p))
        // status = Skill.B; } ... addStatus(h, status)`. The alias reader
        // takes the first assignment, so with the rune slotted A's own
        // rune-gated row was priced on every cast where the script hands out
        // B on p of them (Cosmic Singularity: +5 MagicMastery, or the twin's
        // +5 PhysicalMastery, half and half). Read for that spelling: a later
        // plain assignment of the same local, behind a guard that holds in
        // this build and rolls a literal or a var. The two rows are then
        // blended where the entry is built (`swap`).
        const swap = (() => {
          if (skills.get(raw) || !alias.has(raw)) return null;
          const re = new RegExp(`(?<![\\w.])${raw}\\s*=\\s*Skill\\.([A-Za-z0-9_]+)\\s*;`, 'g');
          for (let sm; (sm = re.exec(live));) {
            if (sm.index >= m.index || /\b(?:var|final)\s+$/.test(live.slice(0, sm.index)) || !skills.get(sm[1]) || sm[1] === resolved) continue;
            const sg = enclosingBlock(live.slice(0, sm.index));
            if (!guardOf(sg, { rank, runes, talents }).fires) continue;
            const roll = /checkProba\s*\(\s*(?:vars\.([A-Za-z0-9_]+)|(\d*\.?\d+))\s*\)/.exec(sg);
            const p = roll ? (roll[1] ? varsOf(skillId, rank, runes)[roll[1]] : Number(roll[2])) : null;
            if (typeof p === 'number' && p > 0 && p < 1) return { to: sm[1], p };
          }
          return null;
        })();
        note(resolved, to, whileApplied
          ? { ...trig, whileApplied, why: `for as long as ${skills.get(whileApplied)?.texts?.name ?? whileApplied} is on an enemy` }
          : trig, null, magnitudeFromScript,
        { route: 'script', hook: fnAt || null, scope: guard, third: thirdSaid, recipient, swap });
      }
    }

    // Which statuses this script EXTENDS while they run, and by how much per
    // event. `extendStatusDuration(owner, Skill.X, vars.n)` adds to the time
    // left on a status that is already up - it is not a re-application and not
    // a stack, so neither the renewal reader nor the stack channel sees it, and
    // a rune whose whole body is one of these used to read as doing nothing.
    //
    // Three rows in the sheet call it, one per class: Battle Fury
    // (`Warrior_BattleShout_M1`) adds 0.25s to Battle Shout on every critical
    // strike you deal, and the Rogue and Mage rows are the same shape. The
    // amount is only ever on the RUNE, which is why this had to wait for
    // `amountOf` to prefer the rune's vars over the row's.
    const extendPer = new Map();
    // ...and the ones it extends on an EVENT the fight raises (see below).
    const extendOnPer = new Map();
    if (s?.script) {
      const ebody = liveScript(s.script);
      const runeVars = (s.mastery ?? []).find((m) => runes?.has(m.id))?.vars ?? null;
      EXTEND_STATUS.lastIndex = 0;
      for (let mm; (mm = EXTEND_STATUS.exec(ebody));) {
        const [, target, expr] = mm;
        const amount = amountOf(expr, varsOf(skillId, rank, runes), runeVars);
        if (amount == null || !(amount > 0)) continue;
        const before = ebody.slice(0, mm.index);
        const scope = enclosingBlock(before);
        const critOnly = /\bcritical\b|\bisCrit\b/.test(scope);
        // The gate is the ordinary one - `hasMastery(Warrior_BattleShout_M1)`
        // is evaluable against the slotted runes, so a build without the rune
        // gets nothing rather than a silent credit. A CRIT gate is not an
        // unreadable condition - the fight computes a crit expectation for
        // every hit it prices - so it is lifted out before the guard is judged,
        // exactly as the resource channel does it.
        const hookAt = before.lastIndexOf('function on');
        const hook = hookAt >= 0
          ? /function\s+(on[A-Za-z0-9_]*)/.exec(before.slice(hookAt))?.[1] ?? null : null;
        // ...AND ONE MORE EVENT THE FIGHT RAISES ITSELF: a weapon skill
        // getting a charge back. Mystic Continuum (Mystic Empowerment's rune)
        // is `onSkillGainCharge(s) { if (s.isWeaponSkill() && hasMastery(M))
        // extendStatusDuration(owner, <status>, vars.time) }` - half a second
        // on the status each time one of the hero's weapon skills comes off
        // cooldown. The fight knows the instant every charge returns, so this
        // one is not a rate folded into a longer life: it is handed to the
        // fight as the event (`extendOn`), which adds the time when a charge
        // comes back with the status up. MEASURED 2026-10-13: the captured
        // Mage slots the rune, and her status stood 15.0, 15.5 and 16.0 s.
        // Only where the guard is that one test: the skill handed to the
        // hook is a weapon skill.
        const onCharge = hook === 'onSkillGainCharge' && /\b\w+\.isWeaponSkill\s*\(\s*\)/.test(scope);
        const judged = scope.replace(/\b(?:critical|isCrit|isPhysical|isMagic)\b/g, ' ')
          .replace(onCharge ? /\b\w+\.isWeaponSkill\s*\(\s*\)/g : /(?!)/g, ' true ');
        const g = guardOf(judged, { rank, runes, talents });
        if (!g.fires || g.unread) continue;
        if (onCharge) {
          extendOnPer.set(target, { on: 'weapon-skill-charge', amount, hook, from: skillId });
          continue;
        }
        // Only the damage hooks carry a rate this model can put a number on.
        if (!/^on(InflictDamage|InflictHit|Damage|Hit)$/.test(hook ?? '')) continue;
        extendPer.set(target, { amount, critOnly, hook, from: skillId });
      }
    }

    // Which statuses this script applies as a SHARE of the hit, and how big a
    // share. Resolved through a local, because that is how the scripts write it.
    const poolFraction = new Map();
    if (s?.script) {
      const body = liveScript(s.script);
      // The banked share is a VAR, and vars are rank-resolved: Demondash's
      // passive authors var1 = 0.2 with a rankOverride restating 0.3 from
      // rank 2, and the capture proves the live fraction to the integer
      // (status_on amounts 61/77/101 against feeding hits 202/257/335 are
      // round(0.3 x hit); 0.2 would read 40/51/67). Reading the raw row
      // undercut every tick by a third and hid behind a feed-set error that
      // overcounted by roughly the same amount - until a better arsenal
      // moved the two in opposite directions.
      const varAt = (key) => {
        let v = s.vars?.[key];
        for (const ov of (s.props?.rankOverride ?? []).slice()
          .sort((a, b) => (a.minRank ?? 0) - (b.minRank ?? 0))) {
          if ((ov.minRank ?? 0) <= rank && ov.vars?.[key] != null) v = ov.vars[key];
        }
        return v;
      };
      const local = new Map();
      POOL_LOCAL.lastIndex = 0;
      for (let mm; (mm = POOL_LOCAL.exec(body));) {
        const v = varAt(mm[2]);
        if (typeof v === 'number' && v > 0) local.set(mm[1], v);
      }
      ADD_STATUS_3.lastIndex = 0;
      for (let mm; (mm = ADD_STATUS_3.exec(body));) {
        const [, , raw, arg] = mm;
        const id = skills.get(raw) ? raw : null;
        if (!id) continue;
        const t = arg.trim();
        const direct = /^\w+\.amount\s*\*\s*vars\.([A-Za-z0-9_]+)$/.exec(t);
        const frac = direct ? varAt(direct[1]) : local.get(t);
        if (typeof frac !== 'number' || !(frac > 0)) continue;
        // WHICH damage feeds the pool is the HOOK's business before it is the
        // guard's. `onInflictDamage` is the owner-global hook - Hemorrhage
        // takes a share of every physical critical strike you land, whoever
        // landed it - while `onDamage` on a skill's own script sees only that
        // skill's hits: Bonethrow's tooltip says "bleed for ::var1%:: of the
        // damage dealt", meaning dealt BY BONETHROW. Reading both as global
        // fed Bonethrow's pool from the whole rotation's crits, which invented
        // ~18% of a Warrior's headline dps. A hook this reader does not know
        // is refused, and the status falls through to the script-magnitude
        // refusal below rather than riding a feed it does not have.
        const beforeCall = body.slice(0, mm.index);
        const hookAt = beforeCall.lastIndexOf('function on');
        const hook = hookAt >= 0
          ? /function\s+(on[A-Za-z0-9_]*)/.exec(beforeCall.slice(hookAt))?.[1] ?? null : null;
        if (hook !== 'onInflictDamage' && hook !== 'onDamage') continue;
        const scope = enclosingBlock(beforeCall);
        poolFraction.set(id, {
          fraction: frac,
          own: hook === 'onDamage',
          // The guard says which damage feeds it. Hemorrhage takes physical
          // critical strikes and explicitly excludes damage from other dots,
          // which is what stops a bleed from feeding itself. Bonethrow's guard
          // is EMPTY - no crit test - so its feed is all of its own damage.
          crit: /\bcritical\b|\bisCrit\b/.test(scope),
          physical: /\bisPhysical\b/.test(scope),
          magic: /\bisMagic\b/.test(scope),
          // `dmg.isWeaponSkill` is skill type 7 or 8 (BaseSkill.isWeaponSkill@6161; 7
          // alone until build 25782799 admitted WeaponSubSkill)
          // - Demondash's pool banks weapon-skill hits ONLY, and feeding it
          // from every swing and finisher overcounted its basket by ~63%.
          weaponSkill: /\bisWeaponSkill\b/.test(scope),
          excludesDot: /isDoT/.test(body),
        });
      }
    }

    const self = [], onTarget = [], unreadable = [], dots = [];
    // What the game itself says these statuses ARE, whatever the model made of
    // them: the ones typed as ticking, and the ones typed as crowd control.
    const flaggedDot = [], flaggedCC = [], missingTick = [];
    for (const [statusId, { to, trigger, appliedDuration, scriptMagnitude, site }] of found) {
      const st = skills.get(statusId);
      if (!st) continue;
      const types = (st.props?.status?.types ?? []).map((t) => t.type);
      const isBuff = !types.length || types.includes('Buff');
      const kinds = new Set(types.flatMap((t) => [...statusTypeFlags(t)]));
      const label = { status: statusId, name: st.texts?.name ?? statusId, types };
      if (kinds.has('DoT') || kinds.has('HoT')) flaggedDot.push(label);
      // A CC label carries its LIFETIME. The status row's own `duration` if it
      // declares one, else the duration the applying step handed it - which is
      // where the stuns keep theirs (Shockwave's `dur1`, Charge's literal 1).
      // Nothing consumed this before, so it was dropped; Domination's rank-3
      // rider is worth the fraction of the fight this covers. The value is the
      // RAW column - a vars key stays a string here - and `crowdControlOf` is
      // where it becomes seconds. The label carries WHERE the row applies it
      // too (`site`), which is what that reader judges it by. The flag is
      // asked the way the game asks it, parents walked (hasStatusFlag@21820):
      // no type inherits it today, and the day one does it is still control.
      if (types.some((t) => statusTypeFlagsDeep(t).has('CrowdControl') || statusTypeFlagsDeep(t).has('HardCC'))) {
        flaggedCC.push({ ...label, duration: st.duration ?? appliedDuration ?? null, site });
      }
      // Typed as a tick by the game and carrying no tick schedule this model can
      // find. Scoring its effects once, as a lump, is the wrong shape - so say
      // so rather than quietly reading a damage-over-time as a hit.
      if ((kinds.has('DoT') || kinds.has('HoT'))
        && !(st.steps ?? []).some((x) => x.props?.loop?.tick != null)) missingTick.push(label);
      // Buff/Debuff typing breaks a tie; it does NOT overrule a named
      // recipient. A Buff never lands on the enemy, so where the path could
      // only guess ("whoever the Hit step hit") the typing decides - that is
      // how `GS_Nova_Skill2_Buff` and `Priest_BlessingOfFervor_Status` get back
      // onto the player. But where a SCRIPT names someone else outright, that
      // is the answer: `Warrior_IgnorePain` hands its ally buff to
      // `onPlayerAllies(a -> ...)` with `a != owner`, and `GM_MassGrab` buffs a
      // summon. Reading the typing over the name made both of those a permanent
      // stat on the character - one of them a multiplicative +50% damage.
      const wearer = to === 'Elsewhere' ? 'Elsewhere'
        : (types.includes('Buff') && !types.includes('Debuff')) ? 'Self'
          : to;
      if (wearer === 'Elsewhere') {
        // "Not to you" is only true of a row whose hits cannot land on its
        // caster. Faithful Winds hands its status to `isAlly(hit.target)` from
        // an area whose filter admits the caster (`landsOnCaster`), and the
        // 2026-10-13 capture shows it on the Priest herself after 15 of her
        // own casts. It stays unpriced - what it lands on is whoever stands
        // in the area - but the sentence must not say it never reaches you.
        // Only for that spelling - the recipient tested as `isAlly(...)` and
        // nothing narrower: a status a row hands to its summons through a
        // step is no more the caster's for the area admitting her.
        const onCaster = new RegExp('isAlly\\s*\\(\\s*(\\w+)\\.target\\s*\\)\\s*\\)\\s*\\{?\\s*addStatus\\s*\\(\\s*\\1\\.target\\s*,\\s*(?:Skill\\.)?'
          + statusId + '\\b').test(liveScript(skills.get(skillId)?.script ?? ''))
          && !!landsOnCaster(skillId, null, rank, runes);
        // Filed by what the refusal IS, and that is WHERE THE SCRIPT SENDS IT
        // (`recipient`, read where the call was found). Left without a kind it
        // was listed under `script magnitude`, whose sentence - "the amount is
        // computed by a script from the hit that applied it" - is true of
        // none of these; filed whole under `lands on an ally` it told a Mage
        // that Mystic Empowerment and Water Veil go "to an ally or a summon"
        // while the capture has both on the hero who cast them. (A status
        // handed out in a loop over the caster's party never reaches this
        // branch: it is the caster's, and is read as hers above.)
        const named = site?.recipient ?? null;
        const rolled = /\bcheckProba\s*\(/.test(site?.scope ?? '') ? ', on a roll each time' : '';
        const filed = onCaster
          ? {
            kind: 'conditional',
            why: 'its script hands it to whoever of your side its area hits - an ally, or you while you stand in it - '
              + 'and where anyone stands is not something this fight has',
          }
          : named === 'shield-wearer'
            ? {
              kind: 'no rate',
              why: `its script hands it to whoever wears a shield you apply${rolled} - you, for a shield of your own - `
                + 'and this fight raises no event when a shield goes on, so nothing gives it a rate',
            }
            : named === 'area-unit'
              ? {
                kind: 'conditional',
                why: 'its script hands it to whatever unit enters its area - who stands in the area, and for how long, '
                  + 'is not something this fight has',
              }
              : { kind: 'lands on an ally', why: 'its script hands it to an ally or a summon, not to you or to your target' };
        unreadable.push({
          from: skillId, status: statusId, name: st.texts?.name ?? statusId, to, types, recipient: named, ...filed,
        });
        continue;
      }

      // A status that ticks is a damage- or heal-over-time, and it is fully
      // authored: `skill.duration` is its lifetime, one of its steps carries
      // `props.loop.tick`, and the effect on that step is the amount. The model
      // used to report every one of these as "its payload is a status or script
      // effect" - `Sword_Swarm_Passive_Swarm` alone is ten ticks of
      // 0.12*Strength + 0.12*Faith and was worth a fifth of a Priest's damage.
      const sp = combat.profile(statusId, rank, runes);
      // The status's own lifetime, or the one the applying step handed it.
      let life = sp?.periodic?.duration ?? null;
      if ((life == null || !Number.isFinite(life)) && appliedDuration != null) {
        const given = typeof appliedDuration === 'number' ? appliedDuration
          : (varsOf(skillId, rank, runes)[appliedDuration] ?? null);
        if (typeof given === 'number' && given > 0) life = given;
      }
      // A pool DoT's magnitude arrives as the third `addStatus` argument -
      // `Warrior_Hemorrhage` bleeds for 35% of the crit that applied it - and
      // the status row then carries `baseVal: 1` as a placeholder. Scoring that
      // literally prints a bleed that deals 1 damage a tick, which is worse
      // than saying nothing: it looks like a real, tiny number.
      const pool = poolFraction.get(statusId) ?? null;
      const placeholder = scriptMagnitude && !pool
        && sp?.effects.every((e) => !e.scaling.length && Math.abs(e.baseVal ?? 0) <= 1);
      if (placeholder) {
        // What reaches this refusal is a third argument the script COMPUTED
        // (`thirdArgOf`: a literal or a var is a count the applier carries, a
        // `? 1 : 0` or enforceStatus's boolean is a switch refused further
        // down under its own condition). The sentence is the argument's own:
        // one reason for every computed argument called a count a magnitude -
        // "computed from the hit that applied it" over a count the script
        // works out from a rank, a local or another status's stacks.
        const third = site?.third;
        unreadable.push({
          from: skillId, status: statusId, name: st.texts?.name ?? statusId, to: wearer, types,
          refusal: third?.is ?? 'amount',
          why: third?.is === 'count'
            ? `its script ${third.call === 'setStatus' ? 'sets its stack count to' : 'applies it with a stack count of'} `
              + `\`${third.text}\`; this reader takes an application as one stack and `
              + 'does not follow a count the script works out'
            : 'its magnitude is the third argument to addStatus, computed by a script from the hit that applied it',
        });
        continue;
      }
      // A pool dot carries no amount of its own - the placeholder baseVal is
      // the point - so it qualifies on its schedule alone.
      if (sp?.periodic && (pool || sp.effects.some((e) => (e.kind === 'Damage' || e.kind === 'Heal')
        && (e.baseVal || e.scaling.length)))) {
        dots.push({
          from: skillId,
          fromName: skills.get(skillId)?.texts?.name ?? skillId,
          status: statusId,
          name: st.texts?.name ?? statusId,
          to: wearer,
          // What the game types this status as - `Bleed`, `Hemorage`, `Burn` -
          // which is what a talent's `isStatusType` guard asks about, so a
          // scoped modifier can be matched to the dots it actually covers.
          types,
          // ...and whether the game types it a DoT at all, parents walked -
          // what `dmg.isDoT` asks of the hitting status ($HSkill.isDoT@21772
          // on its inf), so a rider guarded on that reaches exactly these.
          isDoT: types.some((t) => statusTypeFlagsDeep(t).has('DoT')),
          // A status that hands OTHER statuses' hits a crit chance while it
          // is on the target. Gaping Wound's status (build 25782799):
          //   function onReceiveDamageEval(dmg) {
          //     if (dmg.isStatusType(StatusType.Bleed) || dmg.isStatusType(StatusType.Poison)
          //       || dmg.isStatusType(StatusType.Burn))
          //       dmg.critChance += getAtb(skill.getSourceObject(), Attribute.CritChance);
          //   }
          // The hook is the WEARER's, run on every hit it receives
          // (evalDamage@6124 op 173 -> BaseSkill.onReceiveDamageEval@6127), and a
          // status's source object is its instigator
          // (Status.getSourceObject@15807) - so every status hit of those
          // types on that target rolls the applier's own crit chance for as
          // long as this status is up. No rank guard in the script, though
          // the tooltip lists it as the rank-3 line.
          grantsCrit: (() => {
            const hb = hookBody(liveScript(st.script ?? ''), 'onReceiveDamageEval');
            if (!/critChance\s*\+=\s*getAtb\s*\(\s*skill\.getSourceObject\s*\(\s*\)\s*,\s*Attribute\.CritChance\s*\)/.test(hb)) return null;
            const guard = /if\s*\(([^{]*)\)\s*\{?\s*\w+\.critChance/.exec(hb)?.[1] ?? '';
            // Only a guard built from status-type tests is this shape.
            if (guard.replace(/\w+\.isStatusType\s*\(\s*(?:StatusType\.)?\w+\s*\)/g, '').replace(/[\s|()]/g, '')) return null;
            const named = [...guard.matchAll(/isStatusType\s*\(\s*(?:StatusType\.)?(\w+)\s*\)/g)].map((x) => x[1]);
            return named.length ? { types: named } : null;
          })(),
          tick: sp.periodic.tick,
          duration: life ?? sp.periodic.duration,
          stacks: Number.isFinite(maxStacksOf(statusId, rank, talentRanks))
            ? maxStacksOf(statusId, rank, talentRanks) : 1,
          // WHETHER A TICK IS MULTIPLIED BY THE STACK COUNT, which is the whole
          // of the stack channel on the damage side and was missing entirely.
          //
          // `$HSkill.getStackFactor@21771` runs as the LAST line of
          // `getStepEffectVal@21774` - after the scaling, after the spread
          // division, after the damage variance - and multiplies the value by
          // `Status.stacks` when the running skill is a Status that is EITHER a
          // DoT (its statusType, or an ancestor of it, carries the DoT flag) OR
          // carries the `ScaleWithStacks` effect flag. It is an OR evaluated
          // once, so a status that is both - Daggers_Demondash_Passive_Status is
          // typed Burn AND flagged - is multiplied exactly once.
          //
          // The accepted build's Lethal Poison was the size of the gap: five
          // stacks of it were being priced as one. (Gash is the Rogue's
          // stacking dot today.)
          //
          // ...EXCEPT where the cap is the authored -1, which means uncapped.
          // A pool dot handles that with its own ledger - what fed it IS the
          // count expressed as damage - but an ordinary uncapped DoT applied
          // every swing would reach two hundred stacks before the bell and
          // print a number nobody could earn. Nothing in the data bounds it, so
          // it is held at one stack and NAMED, which is the same rule every
          // other unbounded quantity here gets.
          scaleByStacks: (Number.isFinite(maxStacksOf(statusId, rank, talentRanks)) || !!pool)
            && ([...types].some((t) => statusTypeFlagsDeep(t).has('DoT'))
              || sp.effects.some((e) => e.scaleWithStacks)),
          uncappedStacks: !Number.isFinite(maxStacksOf(statusId, rank, talentRanks)) && !pool
            && ([...types].some((t) => statusTypeFlagsDeep(t).has('DoT'))
              || sp.effects.some((e) => e.scaleWithStacks)),
          // How a re-application composes with what is already running, from
          // `props.status.stackingPolicy` - `Additive | DurationBased |
          // Override`. Eleven statuses declare one and only FOUR are
          // DurationBased, all of them ticking: Hemorrhage, Infused Wound,
          // Axe_Boomerang_Skill1_Status and Daggers_Demondash_Passive_Status.
          //
          // That column is the discriminator this needed. Guessing it from "is
          // the declared amount a total" instead matched nearly every dot in
          // the game, including ones applied on every swing, and took the
          // answer to 44,000 dps. Four rows is a rule; everything else refreshes.
          stacking: st.props?.status?.stackingPolicy != null
            ? stackNames[st.props.status.stackingPolicy] ?? null : null,
          // A COUNT-SCALED companion rider: the APPLIER's own script boosts
          // this status's every damage event by +vars.x per OTHER status the
          // owner has on the wearer at that instant. Gash is the shape -
          // Daggers_DuplicatePoison_Passive's onInflictDamageEval counts
          // dmg.target.statuses owned by the owner, excluding Gash itself,
          // and does dmgMult += count * vars.var1 behind a rank gate. The
          // count is live state, so the FIGHT multiplies each tick by
          // (1 + x * others-up-right-now) rather than this reader guessing a
          // number; the live decode ran k = 3..7, mean 5.09, and the ledger
          // mean was a third low without it.
          perOtherStatus: (() => {
            const ap = liveScript(s?.script ?? '');
            const mm = new RegExp('skillId\\s*==\\s*Skill\\.' + statusId
              + '\\b([\\s\\S]{0,600}?)dmgMult\\s*\\+=\\s*(\\w+)\\s*\\*\\s*vars\\.(\\w+)').exec(ap);
            if (!mm) return null;
            if (!/for\s*\(\s*\w+\s+in\s+\w+\.target\.statuses\s*\)/.test(mm[1])) return null;
            const gate = /rank\s*>=\s*(\d+)/.exec(mm[1]);
            if (gate && rank < Number(gate[1])) return null;
            let v = s.vars?.[mm[3]];
            for (const ov of (s.props?.rankOverride ?? [])) {
              if ((ov.minRank ?? 0) <= rank && ov.vars?.[mm[3]] != null) v = ov.vars[mm[3]];
            }
            return typeof v === 'number' && v > 0 ? v : null;
          })(),
          pool,
          trigger,
          prof: sp,
        });
      }
      // A status's affix rows are rank-gated the same way a skill's are, and
      // they are MUTUALLY EXCLUSIVE: GA_Demon_Skill2_Status declares CritChance
      // +10 at maxRank 1 and +15 at minRank 2, and summing them read +25 - the
      // same error the talent and weapon-upgrade rank rows already had, in a
      // third place. The rank is the weapon-skill rank the caller is assuming.
      // A damage multiplier the status confers through its script, where the
      // amount is a number and the guard is one this reader can answer. The
      // attributes are the ones the sheet already carries, so the buff, its
      // uptime and its place in the fight all come for free.
      const scripted = [];
      if (st.script) {
        const body = liveScript(st.script);
        DMG_MULT.lastIndex = 0;
        for (let mm; (mm = DMG_MULT.exec(body));) {
          const amount = amountOf(mm[2], sp?.vars ?? st.vars);
          if (amount == null || amount <= 0) continue;
          // WHICH HOOK. A `dmgMult` written in onReceiveDamageEval is on the
          // damage the wearer TAKES (evalDamage@6124 op 173 runs the target's
          // BaseSkill.onReceiveDamageEval@6127), never on what it deals - so it is not
          // a DamageModifier on anybody's sheet. Sentence's debuff is the
          // row: read here it became a stat on the ENEMY, which nothing
          // prices, and the tooltip's "increasing all damage you deal to
          // them" was worth zero. The receive side is read below.
          if (/^onReceive/.test(hookAt(body, mm.index))) continue;
          const scope = enclosingBlock(body.slice(0, mm.index));
          // UNCONDITIONAL ONLY. A `dmgMult` inside any branch is a modifier on
          // a SUBSET of casts - `DS_Bladeleaf_Combo_Status` buffs only weapon
          // skills, `Bow_Craft_AttackCombo_Status` only its own combo - and
          // turning those into a permanent stat on the sheet took the Mage to
          // 6,000 dps. Only a bare handler body is a buff that is simply on
          // while the status is, which is what Berserk's is.
          if (/\bif\b|&&|\|\||\?/.test(scope.replace(/function\s+on\w+\s*\([^)]*\)/g, ''))) continue;
          const g = guardOf(scope, { rank, runes, talents });
          if (!g.fires || g.unread) continue;
          scripted.push({
            ref: 'TAttribute_Flat',
            target: { attribute: mm[1] === 'dmgMult' ? 'DamageModifier' : 'CritDamage' },
            val: amount * 100,
            conds: {},
            fromScript: true,
          });
        }
      }
      const liveRows = (row) => (row?.affixes ?? []).filter((a) => a.target?.attribute
        && !(a.conds?.minRank != null && rank < a.conds.minRank)
        && !(a.conds?.maxRank != null && rank > a.conds.maxRank)
        && !(a.conds?.equalRank != null && rank !== a.conds.equalRank)
        && !(a.conds?.mastery && !runes?.has(a.conds.mastery))
        && !(a.conds?.masteryExclude && runes?.has(a.conds.masteryExclude)));
      // A status its script SWAPS for a twin on a roll (`site.swap`) is worn
      // as one or the other. What both rows carry is on every cast; a row
      // only one of them carries is on its share of them - an attribute row
      // is linear, so the expectation is exact, and nothing here pretends to
      // know which cast got which. Only for two rows of one life: a twin
      // that lasts another time is not a blend.
      const twin = site?.swap && skills.get(site.swap.to)?.duration === st.duration ? skills.get(site.swap.to) : null;
      const same = (a, b) => a.target.attribute === b.target.attribute && a.ref === b.ref && a.val === b.val && !a.mod?.dynVal && !b.mod?.dynVal;
      const affixes = (twin
        ? [
          ...liveRows(st).map((a) => (liveRows(twin).some((b) => same(a, b)) ? a : { ...a, val: a.val * (1 - site.swap.p), swapShare: 1 - site.swap.p })),
          ...liveRows(twin).filter((b) => !liveRows(st).some((a) => same(a, b))).map((b) => ({ ...b, val: b.val * site.swap.p, swapShare: site.swap.p })),
        ]
        : liveRows(st))
        .concat(scripted);
      // A scripted multiplier is a real number, so it does not make the status
      // "dynamic" the way a mod.dynVal does.
      //
      // And a dynVal does not always erase the authored value: the game's
      // getAffixModVal@21793 switches on the mod's op - op 0 MULTIPLIES the
      // authored val by the script-set dynVal (worth 0 until a script writes
      // it), op 1 REPLACES it, but op 2 ADDS - and a fresh status instance
      // reads dynVal 0, so for op 2 the authored val is a floor the wearer
      // always gets. Priest_Crusader_Status is the whole op-2 population in
      // the data (the other two dynVal rows are op 0): authored +10
      // CritChance, +10% damage, +10% shield and heal per press, grown by
      // addDynVal per prayer trigger under the M2 mastery. The base is
      // credited; the growth stays refused; and the stacks are pinned to 1 -
      // its maxStacks 300 is the growth channel's headroom, not a stack count
      // any fight reaches (the applier's own script is removeStatus +
      // addStatus, a fresh single-stack instance per press, and the live
      // capture's status_on rows say stacks=1).
      const dynamic = affixes.some((a) => a.mod?.dynVal && a.mod.dynVal.op !== 2);
      const dynGrowth = !dynamic && affixes.some((a) => a.mod?.dynVal);
      const entry = {
        from: skillId,
        status: statusId,
        name: st.texts?.name ?? statusId,
        // At the cap, which the audit has always said - but the cap now comes
        // off `getMaxStacks@15831` rather than off a bare `?? 1`, so a row
        // declaring the uncapped -1 no longer scales its own affix by MINUS ONE.
        // An uncapped buff is held at one stack instead: nothing in the data
        // says how many a fight reaches, and Infinity is not a number to
        // multiply an affix by.
        stacks: dynGrowth ? 1
          : Number.isFinite(maxStacksOf(statusId, rank, talentRanks))
            ? maxStacksOf(statusId, rank, talentRanks) : 1,
        uncapped: !Number.isFinite(maxStacksOf(statusId, rank, talentRanks)),
        // Op-2 dynVal: the authored base is credited above, the script's
        // addDynVal growth is not - the flag keeps the partial credit visible.
        growthRefused: dynGrowth || undefined,
        stackingPolicy: st.props?.status?.stackingPolicy ?? null,
        // The lifetime AT THE RANK IT WAS APPLIED AT: props.rankOverride restates
        // `duration` (updateSkillInf@21787 ops 189-203) and profile() has folded
        // it - the row's own column is the rank-1 value at every rank.
        duration: (sp?.duration > 0 ? sp.duration : st.duration) ?? null,
        // Time this build's own script adds back while the status runs, per
        // event. `engine.mjs` turns it into an effective duration; it stays a
        // rate here because the rate is the fight's business, not the sheet's.
        extend: extendPer.get(statusId) ?? null,
        // ...or per EVENT, where the event is the fight's own (a weapon
        // skill's charge coming back): sim.mjs adds the time as it happens.
        ...(extendOnPer.has(statusId) ? { extendOn: extendOnPer.get(statusId) } : {}),
        types,
        to: wearer,
        affixes,
        trigger,
        // A Status step authored `on: Hit` lands WITH the hit that triggers
        // it and before that hit's damage is worked out, so what it puts on
        // the target is there for the hit itself (the fight prices the cast
        // inside it - sim.mjs, where a press is priced).
        // MEASURED 2026-10-13: Knives Tempest with the Shred rune, 1 x
        // Dexterity, logged 182 on all five plain hits of the isolated
        // presses - 181.3 under its own -20% Armor, where the bare target
        // prices 178.9 - and the Shred row is written in the hit's own
        // millisecond, ahead of it. Tear Reality is the contrast: its armour
        // break is not a Hit step, and its hit logged 324 against a bare 323.0.
        ...(site?.route === 'step' && site.on === 'Hit' ? { withHit: true } : {}),
        // How a re-application composes, from the APPLIER's guard rather than
        // from the status row: `blocked` means the script refuses to re-apply
        // while its own buff is up, which is an alternating renewal process and
        // not a refresh.
        reapply: trigger?.reapply ?? null,
      };
      if (dynamic) {
        unreadable.push({ ...entry, why: 'its affixes are scaled by a script-set dynVal, so their magnitude is not in the data' });
        continue;
      }
      // A status with NO affixes whose script says `dmg.dmgMult += vars.X`
      // inside onReceiveDamageEval, gated on `sourceObject == status.instigator`,
      // is a target debuff in disguise: +X% to everything the INSTIGATOR deals
      // to the wearer, and nothing to anyone else. Death Mark is the shape -
      // vars.var1 = 0.15 for thirty seconds on a ninety-second press - and it
      // fell through every bucket because its whole payload is that one line
      // of script. The magnitude is in the data (the status row's own vars);
      // only the reading was missing.
      //
      // ...and the same line with NO guard at all, which is +X% to everything
      // ANYONE deals to the wearer - the instigator included, so it prices the
      // same for the build that applied it. Sentence is that row: its whole
      // script is `onReceiveDamageEval(dmg) { dmg.dmgMult += vars.damage; }`,
      // 0.05 and 0.1 from rank 2 (the status takes its instigator's rank, so
      // the var is read at the applier's). Any OTHER guard in front of the
      // statement - a skill id, an affinity, a stack count - is not this
      // shape and is left to the reader that owns it.
      {
        const stRow = skills.get(statusId);
        const recvBody = hookBody(liveScript(stRow?.script ?? ''), 'onReceiveDamageEval');
        const recv = /\bdmgMult\s*\+=\s*vars\.([A-Za-z0-9_]+)\s*;/.exec(recvBody);
        const lead = recv ? recvBody.slice(0, recv.index) : '';
        const instigatorGated = !!recv
          && /^\s*if\s*\(\s*\w+\.sourceObject\s*==\s*status\.instigator\s*\)\s*\{?\s*\w+\.$/.test(lead);
        const bare = !!recv && /^\s*\w+\.$/.test(lead);
        const v = recv ? (sp?.vars ?? stRow?.vars)?.[recv[1]] : null;
        if (recv && (instigatorGated || bare) && typeof v === 'number' && v > 0 && wearer !== 'Self') {
          onTarget.push({ ...entry, scriptTaken: v });
          continue;
        }
      }
      // A status the TARGET wears whose own script cuts what its wearer
      // DEALS - `onInflictDamageEval(dmg) { dmg.dmgMult -= ... }` on a status
      // worn by the enemy (Atrophic Poison). That is mitigation for you and
      // nothing for your damage, and against a foe that never attacks it is
      // worth exactly zero - which is a sentence, not a silence.
      if (!affixes.length && wearer === 'Target'
        && /\w+\.dmgMult\s*-=/.test(hookBody(liveScript(st.script ?? ''), 'onInflictDamageEval'))) {
        const hb = hookBody(liveScript(st.script ?? ''), 'onInflictDamageEval');
        const key = /status\.instigatorSkill\.vars\.(\w+)/.exec(hb)?.[1] ?? null;
        const amount = key ? (combat.profile(skillId, rank, runes)?.vars ?? s?.vars ?? {})[key] : null;
        unreadable.push({
          ...entry, kind: 'foe is passive',
          why: `it is worn by your target and cuts the damage its wearer DEALS`
            + (typeof amount === 'number' ? ` by ${+(amount * 100).toFixed(2)}%` : '')
            + ' (its own onInflictDamageEval) - mitigation for you in game, and worth nothing against a foe that never attacks',
        });
        continue;
      }
      // ...and the same statement written as attribute rows instead of a
      // script line: a status the target wears whose every row lowers its
      // WEARER's DamageModifier (Crippling Bloodloss, "reduces all damage
      // dealt by affected enemies", put on whoever wears your Hemorrhage).
      // Filed as a third party's it said nothing at all beside the point
      // spent; as a debuff on the target with nothing more said, it would
      // still say nothing - no part of this fight reads what the foe deals.
      if (wearer === 'Target' && affixes.length
        && affixes.every((a) => a.target?.attribute === 'DamageModifier' && a.val < 0)) {
        unreadable.push({
          ...entry, kind: 'foe is passive',
          why: 'it is worn by your target and cuts the damage its wearer DEALS by '
            + `${+(Math.abs(affixes.reduce((sum, a) => sum + a.val, 0)) * 100).toFixed(2)}% (its own DamageModifier row) - `
            + 'mitigation for you in game, and worth nothing against a foe that never attacks',
        });
        continue;
      }
      if (!affixes.length) continue;
      // A status whose APPLICATION is gated on live state the reader computed
      // the flag for and then dropped. Ram Veil's +5 CritChance / +5 Fervor
      // lands only when a max-stacked Benediction is CONSUMED - the script says
      // `hasStatusMaxStacked` in as many words - and the entry used to ship
      // without the guard, so the buff was credited on every cast at ~100%
      // uptime. That is the refuse-don't-approximate rule inverted: the
      // conditional reward was maximised. Refused and named instead.
      if (trigger?.unread) {
        unreadable.push({
          ...entry, kind: 'conditional',
          why: `its script applies it only while ${trigger.unread}() holds, which this reader cannot evaluate`,
        });
        continue;
      }
      // ...and the same refusal for a status its script SWITCHES: the third
      // argument of setStatus / enforceStatus is the condition it is held
      // under (see `thirdArgOf`). Tide Warlord's mastery is up "while fighting
      // under 50% Health" - the owner's own health, which this fight does not
      // track - and that is the sentence it is refused with, not a magnitude
      // it never had.
      // ...and for one that sits on a step the fight never sees played.
      if (trigger?.notPlayed) {
        unreadable.push({ ...entry, kind: 'conditional', why: trigger.notPlayed });
        continue;
      }
      if (trigger?.toggle) {
        unreadable.push({
          // `refusal` says what the third argument was, beside the kind the
          // list files it under - the same field a refused count or amount
          // carries (the placeholder branch above).
          ...entry, kind: 'conditional', refusal: 'condition',
          why: `its script holds it up only while \`${trigger.toggle}\` is true`
            + (trigger.toggleCall === 'enforceStatus' ? ' - enforceStatus adds it then and takes it off otherwise -' : ',')
            + ' and that is live state this fight does not track',
        });
        continue;
      }
      // A status the ENEMY wears is a debuff on them, not a stat on you. Merging
      // it into your own sheet would credit you with their armour reduction.
      if (wearer === 'Self' && isBuff) self.push(entry);
      else onTarget.push(entry);
    }

    // Every status this skill applies, whatever the model could make of it -
    // including the ones that fell through every bucket because they carry a
    // one-shot Shield or Heal rather than an affix or a tick. Those still have
    // to be nameable, or the coverage report says "declares no status" about a
    // skill that plainly declares one.
    hit = {
      self, onTarget, unreadable, dots, all: [...found.keys()],
      flaggedDot, flaggedCC, missingTick, unmetDeps,
      // Every application as it was FOUND - who gets it and on what event -
      // including the statuses no bucket above kept (one with no affix and
      // no tick is still something a script can hang a rider on).
      applied: [...found].map(([status, v]) => ({ status, to: v.to, trigger: v.trigger, site: v.site })),
    };
    statusCache.set(key, hit);
    // The key carries the talents set, so a long talent search mints entries
    // without bound. Evicting the oldest costs a re-read, never correctness.
    if (statusCache.size > 20000) statusCache.delete(statusCache.keys().next().value);
    return hit;
  }

  /**
   * The crowd control one skill puts on what it hits: which status, for how
   * long, whether the fight can count on it, and which of the cast's OWN hits
   * land inside it. This is the one reader of that question - the gate's
   * share of the fight, the "does this cast pay the rider on its own hits"
   * flag and the stun-armed register all ask here, so they cannot disagree
   * (they did: a stun applied by script fed the share and armed the
   * register, and the cast that applied it did not count as stunning).
   *
   * Three authored routes:
   *
   *   * a Status step, or an EFFECT that carries a status - through
   *     `statusesOf().flaggedCC`. Its lifetime is the status row's own, else
   *     the applying step's or effect's, and either may name a VARS KEY
   *     instead of a number: Shockwave's stun is `duration: "dur1"`, 3 seconds
   *     and 4 from rank 2 through `props.rankOverride`. The label carries the
   *     raw column; here it is resolved against the applier's rank-resolved
   *     vars. Left as the string, `dur > 0` was false and Shockwave, Surging
   *     Force and Thundersmash's slow were skipped by every consumer in
   *     silence.
   *   * an `addStatus` call in the script - the same label, with the hook and
   *     the guard it sits behind.
   *   * `addStatusDuration(<what was hit>, Skill.<S>, <seconds>)` in the
   *     script - how Iron Cyclone, Ram's Expulsion, Tide Rising Uppercut and
   *     the starter kits stun. ADD_STATUS does not match that call (its name
   *     runs on), so these appliers were not crowd control to anything.
   *
   * A STEP THE CAST DOES NOT PLAY applies nothing by being listed. `on: Code`
   * (and Trigger) steps are played by `playStep(Steps.<id>)` and by nothing
   * else - see `scriptedRiders` - so a status on one lands where the script
   * plays it:
   *
   *   Eruption          `if (rank >= 3 && hit.stepId == Steps.Stun)
   *                     playStep(Steps.ApplyStun, hit.target)` - no stun at
   *                     all below rank 3 (its rank-3 text is "The lava
   *                     explosion stuns enemies"), and it was read at rank 1.
   *   Deceiver Trick    plays its stunning Damage step from onAreaExited -
   *                     when an enemy LEAVES the area, which a foe that does
   *                     not move never does. Not left out: returned with
   *                     `unpriced` saying so, because a control the build
   *                     holds and the fight cannot count is a floor to name.
   *
   * The same goes for a script call in a hook the fight does not raise
   * (Blinding Light slows whatever ENTERS its area, and takes the slow off
   * when it leaves): `unpriced`, with the hook named.
   *
   * WHICH OF THE CAST'S OWN HITS LAND INSIDE IT is `own`: '*' every hit, a
   * step id the hits of that step, null none this reader will stand behind.
   *
   *   * a step or effect the cast itself plays: every hit. MEASURED on the
   *     Status-step shape (Charge, 2026-08-21: the stun lands the same
   *     millisecond before the damage, five clean-dummy Charges at exactly
   *     x1.25). An effect that carries both the damage and the status (Luon
   *     Shackles) is taken the same way and is not measured.
   *   * the script's own `onHit` / `onFirstHit`: every hit, the one that
   *     raised the hook included. READ: st.skill.SkillStep.hitEntity@6061
   *     op 137 hands BaseSkill.newHit a closure (fn@48280) that runs
   *     `baseSkill.onHit(hit)` at op 10 - st.skill.BaseSkill.onHit@6233
   *     ops 80-91 call the script's onFirstHit and onHit on the server - and
   *     only at op 13 ent.GameObject.receiveHit@4540, where the hit's effects
   *     and their damage are applied; a projectile's closure fn@34678 hands
   *     receiveHit to onHit as the callback it runs at op 101, after the
   *     script. So Iron Cyclone's `onHit(hit) { addStatusDuration(hit.target,
   *     Skill.Stun, vars.dur1) }` has stunned the target before each of its
   *     four hits is priced. Behind `hit.stepId == Steps.<X>` it is the hits
   *     of step X and no others (Blazing Beam's rank-3 slow rides its Blast,
   *     not the beam before it).
   *   * any other hook - onDamage (raised after the hit's damage), an
   *     owner-wide onInflict*, an area event - none. Later hits of the same
   *     cast that would land inside it are not counted: a floor, not a guess.
   *
   * "Crowd control" is the game's own flag: a statusType carrying
   * CrowdControl, or whose parent chain does - what
   * GameObject.isUnderAnyCC@4635 asks through hasStatusFlag@21820(inf, 1).
   * Stun, Root and Slow, the three names the accepted build's guard spelled
   * out, all carry it; so do Silence and Grounded. Only the TYPED states
   * count, which is measured: Tear Reality's MoveSpeedFactor "slow" rides a
   * Debuff-typed status and fires nothing, exactly as reported from play.
   * A script call behind a guard this build fails, or one this reader cannot
   * answer, is left out: the list is what the cast certainly applies, plus
   * what it holds and the fight cannot count (`unpriced`).
   *
   * WHO WEARS IT is not judged here. No row in the sheet puts a typed
   * control on its own caster, and the recipient `statusesOf` infers for a
   * script-played Status step is the step's default (Self) rather than the
   * target the script hands to playStep - Radiant Verdict plays its Stun
   * step on `hit.target` - so filtering on it would drop real stuns.
   */
  const OWN_HIT_HOOKS = /^on(?:Hit|FirstHit)$/;
  const ccCache = new Map();
  function crowdControlOf(skillId, { runes = null, rank = 1, talents = null, talentRanks = null } = {}) {
    const key = skillId + '#' + rank
      + (runes?.size ? '@' + [...runes].sort().join('+') : '')
      + (talents?.size ? '%' + [...talents].sort().join('+') : '')
      + (talentRanks?.size ? '~' + [...talentRanks].sort().map(([k, v]) => k + v).join('+') : '');
    const cached = ccCache.get(key);
    if (cached) return cached;
    const vars = combat.profile(skillId, rank, runes)?.vars ?? {};
    const seconds = (d) => (typeof d === 'string' ? vars[d] : d);
    const isCC = (types) => types.some((t) => statusTypeFlagsDeep(t).has('CrowdControl'));
    const body = liveScript(skills.get(skillId)?.script ?? '');
    // One script site, judged: the hook it sits in and what the block that
    // encloses it says for this build. A guard with an `||` in it is not a
    // conjunction, and neither a rank test nor a step test inside one can be
    // read as THE condition (Nectar-infused Blade's is `isBaseAttack ||
    // (<another skill> && spinSkill.rank >= 3)`).
    const judge = (hook, scope) => {
      const plain = !/\|\|/.test(scope);
      return {
        hook: hook || null, plain,
        g: guardOf(scope, { rank, runes, talents }),
        step: plain ? /\b\w+\.stepId\s*==\s*Steps\.(\w+)/.exec(scope)?.[1] ?? null : null,
      };
    };
    const siteAt = (index) => judge(hookAt(body, index), enclosingBlock(body.slice(0, index)));
    const ownOf = (site) => (OWN_HIT_HOOKS.test(site.hook ?? '') && site.plain && site.g.fires && !site.g.unread
      ? (site.step ?? '*') : null);
    const notRaised = (site) => (RIDER_HOOKS.test(site.hook ?? '') ? null
      : `${site.hook ?? 'top-level script'}, an event this fight does not produce`);
    const out = [];
    for (const cc of statusesOf(skillId, { runes, rank, talents, talentRanks }).flaggedCC ?? []) {
      if (!isCC(cc.types)) continue;
      const d = seconds(cc.duration);
      const entry = {
        status: cc.status, name: cc.name, types: cc.types,
        duration: typeof d === 'number' ? d : null, own: null, unpriced: null,
      };
      const at = cc.site;
      if (at?.route === 'script') {
        const site = judge(at.hook, at.scope ?? '');
        if (notRaised(site)) entry.unpriced = `it is applied from ${notRaised(site)}`;
        else entry.own = ownOf(site);
      } else if (at && (at.on === 'Code' || at.on === 'Trigger')) {
        const sites = at.stepId
          ? [...body.matchAll(new RegExp('\\bplayStep\\s*\\(\\s*Steps\\.' + at.stepId + '\\b', 'g'))].map((m) => siteAt(m.index))
          : [];
        // A plain guard this build fails is a dead call: the step is not
        // played at this rank, or without that rune, and nothing lands.
        const live = sites.filter((x) => !(x.plain && !x.g.fires));
        if (sites.length && !live.length) continue;
        const raised = live.find((x) => !notRaised(x));
        if (!sites.length) {
          entry.unpriced = 'the step that carries it is played only from script, and no playStep call in the row names it';
        } else if (!raised) {
          entry.unpriced = `the step that carries it is played from ${notRaised(live[0])}`;
        } else if (raised.plain && raised.g.unread) {
          entry.unpriced = `the step that carries it is played only while ${raised.g.unread}() holds, which this reader cannot evaluate`;
        } else {
          entry.own = ownOf(raised);
        }
      } else {
        entry.own = '*';
      }
      out.push(entry);
    }
    const TIMED = /addStatusDuration\s*\(\s*([A-Za-z_.]+)\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*,\s*(?:vars\.(\w+)|(\d*\.?\d+))\s*[,)]/g;
    for (let m; (m = TIMED.exec(body));) {
      if (!ENEMY_TARGETS.has(m[1]) || out.some((o) => o.status === m[2])) continue;
      const types = (skills.get(m[2])?.props?.status?.types ?? []).map((t) => t.type);
      if (!isCC(types)) continue;
      const site = siteAt(m.index);
      if (!site.g.fires || site.g.unread) continue;
      const d = m[3] ? vars[m[3]] : Number(m[4]);
      out.push({
        status: m[2], name: skills.get(m[2])?.texts?.name ?? m[2], types,
        duration: typeof d === 'number' ? d : null, own: ownOf(site),
        unpriced: notRaised(site) ? `it is applied from ${notRaised(site)}` : null,
      });
    }
    ccCache.set(key, out);
    if (ccCache.size > 20000) ccCache.delete(ccCache.keys().next().value);
    return out;
  }

  /**
   * Which of a row's own hits are priced with the target already under the
   * control that row applies: '*' for every hit, a Set of step ids, or null.
   * See `crowdControlOf` for what each route is worth and why.
   */
  function ownCrowdControlOf(skillId, opts = {}) {
    const steps = new Set();
    for (const c of crowdControlOf(skillId, opts)) {
      if (c.unpriced || c.own == null) continue;
      // `opts.lands` is the TARGET's say: a control it refuses (a stun, on a
      // unit that carries NoStun) is applied and does not stand.
      if (opts.lands && !opts.lands(c)) continue;
      if (c.own === '*') return '*';
      steps.add(c.own);
    }
    return steps.size ? steps : null;
  }

  /**
   * What THIS target turns away of a status someone else puts on it: null
   * when the status lands, else the name of the refusal. The two answers a
   * target carries, each asked of the status row's own types with the parents
   * walked, the way the game asks:
   *
   *   `ccImmune`    a status one of whose types carries CrowdControl -
   *                 ent.GameObject.canReceiveStatus@4634 ops 0-7: the source
   *                 is someone else, $HSkill.hasStatusFlag@21820(inf, 1), and
   *                 isCCImmune()
   *   `stunImmune`  a status one of whose types is, or descends from, Stun -
   *                 ent.Unit.canReceiveStatus@4922 ops 0-57 (the NoStun
   *                 flag), and the rule above again, Stun being crowd control
   *
   * A refused status is not applied at all, so nothing of it is a status
   * landed - whichever reader found it: the control list above, or the debuff
   * a cast sets up (Spark Beam's rune slow is both). The same function refuses
   * EVERY status on a unit of type Critter or flagged Invulnerable (ops
   * 58-76); a target says that only inside `stunImmune`, so a status that is
   * not a stun is not judged for those two here.
   */
  function refusalOf(statusId, tgt) {
    const types = (skills.get(statusId)?.props?.status?.types ?? []).map((t) => t.type);
    if (tgt?.ccImmune === true && types.some((t) => statusTypeFlagsDeep(t).has('CrowdControl'))) return 'crowd control';
    // The walk is the function's own (ops 41-51: the type's id against the
    // string op 7 loads, then its parent). damage.mjs names that string as
    // the statusType row "Stun" and fails loudly when the row is gone.
    const isStun = (typeId) => {
      for (let cur = typeId, hops = 0; cur != null && hops < 8; hops++) {
        if (cur === 'Stun') return true;
        cur = statusTypes.get(cur)?.parent ?? null;
      }
      return false;
    };
    if (tgt?.stunImmune === true && types.some(isStun)) return 'stun';
    return null;
  }

  /**
   * When an `addStatus` call site fires, read off the guard that precedes it.
   *
   * This is deliberately a handful of predicates and no more. Each one names an
   * event the rotation already counts, so the rate is something the fight
   * produced rather than something this function invented; a call site whose
   * guard says anything else falls through to "when the skill goes off", and if
   * the skill has no cast rate the simulation will not fire it at all.
   *
   *   isWeaponSkill()                 every weapon skill you press
   *   isBaseAttack() / isBasicAttack  every swing of the chain
   *   isFinalCombo / isFinalAttack    the combo finisher
   *   checkProba(vars.chance)         multiplies whichever of those it guards
   *
   * `before` is the script text up to the call, so the enclosing hook and the
   * `if` that wraps the call are both in it.
   */
  function triggerOf(before, skill, guard = null, appliedId = null) {
    // Only the innermost handler matters: take the text after the last hook.
    const lastHook = before.lastIndexOf('function on');
    const handler = lastHook >= 0 ? before.slice(lastHook) : before;
    const hook = /function\s+(on[A-Za-z0-9_]*)/.exec(handler)?.[1] ?? null;
    // ...and within it, only the block that actually ENCLOSES the call. A
    // handler with two branches would otherwise lend the first branch's
    // `checkProba` and its `isBaseAttack` to a call in the second, which is a
    // guard the call does not have. Walking back from the call, every `}` we
    // pass closes a sibling block whose text must be dropped.
    const scope = enclosingBlock(handler);
    let chance = 1;
    if (/checkProba\s*\(/.test(scope)) {
      const v = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope)?.[1];
      const n = v ? skill?.vars?.[v] : null;
      if (typeof n === 'number' && n > 0 && n <= 1) chance = n;
    }
    // `hit.skillId == Skill.X` where X is a skill somebody PRESSES is that
    // skill's own cast, and nothing else. Acidic Splatter gates on
    // Rogue_Sig_Finisher and isFirstHit (or, since build 25959898, its
    // projectile's first hit): once per signature Finisher. This
    // used to be read as "the combo event by another name" and put on the
    // base-attack chain's finisher - a different skill (type AttackCombo, the
    // game's "Final Combo Attack") on a different clock, which applied the
    // poison nearly twice as often as a Finisher is cast.
    const sigGate = /\bskillId\s*==\s*(?:Skill\.)?([A-Za-z0-9_]+)/.exec(scope)?.[1] ?? null;
    const castOf = sigGate != null && sigGate !== skill?.id && ACTIVE_TYPES.has(typeOf(sigGate)) ? sigGate : null;
    // Which swings - see `swingsOf`: a bare isBaseAttack is the finisher too.
    // The finisher is asked through `eventsOf`, which reads the same
    // `swingsOf` and also drops what a plain conjunction negates.
    const combo = eventsOf(scope).has('combo');
    const attack = swingsOf(scope).attack;
    // `checkProba(vars.X * cp)` where cp was read off the ComboPoint pool: the
    // roll scales with the points the finisher finds there. `chance` is the
    // roll at a full bar; `perPoint` is the rule, which the fight plays at
    // the points the press that raises the event consumed (sim.mjs, where a
    // cast-of status is applied).
    // MEASURED 2026-10-13 (Rogue, Acidic Splatter at 0.2 a point, ten
    // rotations, the pressed dummy, points read off each Finisher's hit): 2
    // applications in 7 Finishers at one point, 2 in 5 at two, 9 in 15 at
    // three, 20 in 23 at four, 64 in 64 at five - 97 of 114, where 0.2 x n
    // expects 94.8.
    // The pool can also be read OUTSIDE the hook that rolls, into a variable of
    // the script's own. Build 25959898 moved Acidic Splatter's read there:
    // `cp = Math.round(owner.atb(Attribute.ComboPoint))` in onUseSkill when
    // ctx.skillId is the Finisher - before the Finisher spends them - and the
    // roll in onInflictHit, on the Finisher's first hit or its projectile's
    // first (`hit.projectile != null && hit.hitCount == 0`, the ranged
    // Finisher the patch notes say it had not worked with), then `cp = 0`.
    // Read at the use of the very skill the roll is gated on, that is the
    // points the press consumes, which is what `perPoint` plays.
    const mulVar = /checkProba\s*\(\s*vars\.[A-Za-z0-9_]+\s*\*\s*(\w+)/.exec(scope)?.[1] ?? null;
    const filledAtUse = (() => {
      if (!mulVar || !castOf) return false;
      const text = liveScript(skill?.script ?? '');
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])${mulVar}\\s*=(?!=)[^;]*\\bComboPoint\\b`, 'g'))) {
        const upTo = text.slice(0, m.index);
        const at = upTo.lastIndexOf('function on');
        if (at < 0 || !/^function\s+onUseSkill\b/.test(upTo.slice(at))) continue;
        if (new RegExp(`\\bskillId\\s*==\\s*(?:Skill\\.)?${castOf}\\b`).test(enclosingBlock(upTo.slice(at)))) return true;
      }
      return false;
    })();
    let perPoint = null;
    if (mulVar && (/ComboPoint/.test(scope) || filledAtUse)) {
      const v = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope)?.[1];
      const n = v ? skill?.vars?.[v] : null;
      if (typeof n === 'number' && n > 0) {
        chance = Math.min(1, n * comboPointCap(cdb));
        perPoint = { atb: 'ComboPoint', chance: n, name: cdb.byId('attribute').get('ComboPoint')?.name ?? 'ComboPoint' };
      }
    }
    let on = 'cast';
    let why = `${hook ?? 'its script'} applies it`;
    // An unpredicated roll in a damage hook: see the last branch below.
    let everyInstance = false;
    // What ELSE names the event, when it is not one of the fight's own clocks.
    let named = null;
    const tryOf = hook === 'onTryAddStatus'
      ? /\b\w+\.id\s*==\s*(?:Skill\.)?([A-Za-z0-9_]+)/.exec(scope)?.[1] ?? null : null;
    // Both, when the guard is an OR of the two (the accepted build's Lethal
    // Poison read `(dmg.isBaseAttack || dmg.isFinalCombo) &&
    // checkProba(vars.chance)`), and taking only the combo branch would cost
    // such an applier two thirds of its uptime.
    if (combo && attack) { on = 'attack-or-combo'; why = 'on a base attack or a combo finisher'; }
    else if (combo) { on = 'combo'; why = 'on the combo finisher'; }
    else if (attack) { on = 'attack'; why = 'on a base attack'; }
    else if (/isWeaponSkill/.test(scope)) { on = 'weapon-skill'; why = 'on every weapon skill you press'; }
    else if (castOf) {
      on = 'cast-of'; named = { skill: castOf };
      why = `on every ${skills.get(castOf)?.texts?.name ?? castOf} you cast`;
    } else if (tryOf && skills.get(tryOf)?.props?.status) {
      // `onTryAddStatus(s, t) { if (s.id == Skill.X) ... }` rides every
      // application ATTEMPT of status X - the first and every one after it.
      // Whether this fight ever applies X is the caller's question.
      on = 'apply-of'; named = { status: tryOf };
      why = `each time ${skills.get(tryOf)?.texts?.name ?? tryOf} is applied`;
    }
    else if (sigGate && skills.get(sigGate)?.props?.status && /^onInflict(Damage|Hit)$/.test(hook ?? '') && chance < 1) {
      // `dmg.skillId == Skill.X` where X is a STATUS is that status's own
      // hits, and nothing else: Swarm Lord's poison is rolled on each hit of
      // Hive Swarm (`if (dmg.skillId == Skill.Sword_Swarm_Passive_Swarm) { if
      // (checkProba(vars.chance) && rank >= 3) addStatus(dmg.target, ...)`).
      // It fell to the branch below - "every damage instance, floored to the
      // swing and finisher clock" - which put the poison on a Priest who only
      // swings and took it from one who only casts.
      // MEASURED 2026-10-13: sixty seconds of the sword's chain with no weapon
      // skill pressed logged 132 hits and no poison row; a block of lone
      // presses with no swing in it logged 29 Hive Swarm hits and 10 of the
      // poison's.
      // Only a ROLL, like the floor it is taken from: an unconditional
      // application behind such a test (Melting Faith on Sunlight's hit, Venom
      // Infusion on the Blast) has its own reader and keeps it.
      on = 'tick-of'; named = { tickOf: sigGate };
      why = `on each hit of ${skills.get(sigGate)?.texts?.name ?? sigGate}`;
    }
    else if (/^onInflict(Damage|Hit)$/.test(hook ?? '') && chance < 1) {
      // A ROLL with no predicate rides every damage instance the owner deals.
      // The fight has no per-instance event, so it goes on the swing-and-
      // finisher clock as a FLOOR - multi-hit casts and dot ticks also raise
      // onInflictDamage in game, so the true rate is at least this. The demon
      // trinket is the shape: 3% per damage instance.
      //
      // ONLY where a roll bounds it. An UNCONDITIONAL application on every
      // damage instance was briefly floored too, and the optimizer showed why
      // that cannot stand within the hour: builds stacking such statuses read
      // 4.6x their previous total, because "at least once per swing" is a
      // wild overclaim for appliers the game fires far more selectively than
      // the reader understood. No roll, no floor - refused, as before.
      //
      // The floor is what a BUFF or a debuff rolled this way still stands on.
      // A DAMAGING status does not: the fight counts the damage instances it
      // lands and rolls on each (`everyInstance`, taken up where the dots
      // are gathered - `noteDots` - and played in sim.mjs, "the instance
      // clock"). MEASURED 2026-10-13 (Rogue, sixteen rotations, the pressed
      // dummy): 131 applications of the trinket's curse in the 3,844 damage
      // rows landed while it was absent - 3.41% a row, the row says 3% - and
      // an application in the same millisecond as nothing but a status tick
      // or a proc row; on swings and finishers alone the roll would have to
      // be 7.9%. The floor read 16.6 of its ticks per 100 s where the log
      // holds 25.4.
      on = 'attack-or-combo';
      why = 'on every damage instance - floored to the swing and finisher clock';
      everyInstance = true;
    }
    if (perPoint) why += `, ${Math.round(perPoint.chance * 100)}% for each ${perPoint.name} it consumes`;
    else if (chance < 1) why += `, ${Math.round(chance * 100)}% of the time`;
    // A USE COUNT INSIDE A WINDOW. Infernal Plunge's rank-3 clause is
    //
    //   lastUses.push(time.now); filterUses();
    //   if (lastUses.length >= vars.var2) { <empty the list>; addStatus(owner, <Chaotic Flames>); }
    //
    // with filterUses dropping every entry older than vars.time: the status
    // is handed out on the var2-th use inside vars.time seconds and the count
    // starts over. Read as "onProc applies it", it was put up by EVERY cast -
    // a hundred ticks of Chaotic Flames in a fight whose 12-second cooldown
    // allows no two uses five seconds apart without a reset, and none at all
    // in the 2026-10-13 capture (16,000 of the Rogue's damage rows; the
    // counter status under it reached 2 stacks 162 times and never 3).
    // The gate is carried to the fight (`uses`), which keeps the list.
    let uses = null;
    {
      const um = /\b([A-Za-z_]\w*)\.length\s*>=\s*vars\.([A-Za-z0-9_]+)/.exec(scope);
      if (um) {
        const src = liveScript(skill?.script ?? '');
        const pushes = new RegExp(`\\b${um[1]}\\.push\\s*\\(\\s*time\\.now\\s*\\)`).test(src);
        const wv = new RegExp(`time\\.now\\s*-\\s*${um[1]}\\s*\\[[^\\]]*\\]\\s*>\\s*vars\\.([A-Za-z0-9_]+)`).exec(src)?.[1];
        const n = skill?.vars?.[um[2]];
        const t = wv ? skill?.vars?.[wv] : null;
        if (pushes && typeof n === 'number' && n >= 1 && typeof t === 'number' && t > 0) {
          uses = { count: Math.round(n), within: t };
          why += `, on use number ${uses.count} inside ${t}s (the count then starts over)`;
        }
      }
    }
    // A condition on live state sits on top of the event and the roll, and it
    // can only make the status land LESS often than this says. Carrying the
    // flag lets the caller say so instead of quietly presenting a ceiling as a
    // rate - `DM_Multispin_Passive` needs its own buff max-stacked first.
    let unread = guard?.unread ?? (unreadCond(scope) ?? [null])[1] ?? null;
    // ...with ONE exception, and it is a big one. `!owner.hasStatus(X)` where X
    // is the very status this call applies is not a question about live state -
    // it is the applier refusing to re-apply while its own buff is up, which is
    // a rule, not a mystery. StoneOfPower is the shape:
    //
    //   onInflictDamage(dmg) {
    //     if( checkProba(vars.chance) && !owner.hasStatus(Skill.StoneOfPower_Trinket_Status))
    //       addStatus(owner, Skill.StoneOfPower_Trinket_Status);
    //   }
    //
    // Read as an unreadable condition, all four Stones scored exactly zero.
    // Read as what it is, the buff is an alternating renewal process - ON for
    // its whole duration, then OFF until the next success - whose uptime is
    // rD/(1 + rD): a third at one damage instance a second, never saturating.
    // That is a number, and refusing a number is not the same discipline as
    // refusing a guess.
    let reapply = null;
    // ...and the target-flavoured spelling of the same rule. The demon trinket
    // writes `!hasStatus(dmg.target, Skill.X)` - do not re-apply while MY burn
    // is already on the victim - which is the identical no-reapply gate with
    // the recipient named instead of the owner.
    if (unread === 'hasStatus' && appliedId
      && new RegExp(`!\\s*(?:\\w+\\.)?hasStatus\\s*\\(\\s*(?:[\\w.]+\\s*,\\s*)?(?:Skill\\.)?${appliedId}\\b`)
        .test(scope.replace(/\s+/g, ' '))) {
      unread = (unreadCond(scope.replace(
        new RegExp(`!\\s*(?:\\w+\\.)?hasStatus\\s*\\(\\s*(?:[\\w.]+\\s*,\\s*)?(?:Skill\\.)?${appliedId}\\s*\\)`), ' '),
      ) ?? [null])[1] ?? null;
      reapply = 'blocked';
    }
    if (unread) why += `, and only while ${unread}() holds - which this reader cannot evaluate`;
    else if (reapply === 'blocked') why += ', and not again until it has run out';
    return { on, chance, why, hook, unread, reapply, ...(uses ? { uses } : {}), ...(named ?? {}), ...(everyInstance ? { everyInstance: true } : {}), ...(perPoint ? { perPoint } : {}) };
  }

  /**
   * Which of the events the fight already counts a guard names. Unlike
   * `triggerOf`, which has to pick ONE bucket, this returns all of them:
   * `Warrior_Rage` guards on `isBaseAttack || isFinalCombo || isWeaponSkill`
   * and collapsing that to a single event loses two thirds of the income.
   */
  function eventsOf(scope0) {
    // A NEGATED predicate names what the event is NOT. Envenom reads
    // `ctx.isBaseAttack && ... && !ctx.isFinalCombo` (compiled
    // Rogue_Talent_Envenom.onInflictDamage@45264: the step's isBaseAttack,
    // then isFinalAttack excluded) - basic attacks only - and testing for
    // the predicate's mere presence put it on the finisher as well. Only in
    // a plain conjunction: inside an `||` the negation belongs to one
    // alternative (Mad Spin's `!isFinalCombo && isWeaponSkill || isBaseAttack`
    // still reaches the finisher through its second branch).
    //
    // An EARLY EXIT is the opposite and must not be taken for one:
    // `if (!ctx.isFinalCombo) return;` requires the predicate for everything
    // after it (the Crimson infusion's finisher hook is written that way).
    //
    // WHICH SWINGS is `swingsOf`'s to say, and it has to see the negated
    // FINISHER predicate to say it: a bare isBaseAttack reaches the finisher
    // (skill types 0-4), and `!isFinalCombo` is what takes it back out.
    // Blanked here before the question was asked, Envenom's guard came out as
    // "a base attack or a combo finisher" - the reading the paragraph above
    // exists to prevent. So the two finisher predicates are left standing for
    // it, and only the others a plain conjunction negates are dropped here.
    const PRED = '(?:isFinalCombo|isFinalAttack|isComboAttack|isBaseAttack|isBasicAttack|isWeaponSkill)';
    const NEGATED_HERE = '(?:isComboAttack|isBaseAttack|isBasicAttack|isWeaponSkill)';
    let scope = String(scope0).replace(
      new RegExp(`if\\s*\\(\\s*!\\s*([\\w.?]+\\.${PRED}\\b(?:\\s*\\(\\s*\\))?)\\s*\\)\\s*\\{?\\s*return\\b`, 'g'), ' $1 ');
    if (!/\|\|/.test(scope)) {
      scope = scope.replace(new RegExp(`!\\s*[\\w.?]+\\.${NEGATED_HERE}\\b(?:\\s*\\(\\s*\\))?`, 'g'), ' ');
    }
    const ev = new Set();
    const sw = swingsOf(scope);
    if (sw.attack) ev.add('attack');
    if (sw.combo) ev.add('combo');
    if (/isWeaponSkill/.test(scope)) ev.add('weapon-skill');
    return ev;
  }

  /**
   * Every resource this skill generates, from both paths.
   *
   * Authored: a `GainAtb` effect. On a looping step with no lifetime that is a
   * RATE - `Warrior_InfiniteRage` is 1 Rage every `dur1` = 3s, `enableCond`
   * InCombat, no script at all - and otherwise it lands when the skill is cast.
   *
   * Scripted: `addAtb` / `addResource`, guarded by the same predicates
   * `addStatus` call sites are, read with the same machinery.
   */
  const gainCache = new Map();
  function resourceGainsOf(skillId, { rank = 1, runes = null, talents = null } = {}) {
    const key = skillId + '#' + rank
      + (runes?.size ? '@' + [...runes].sort().join('+') : '')
      + (talents?.size ? '%' + [...talents].sort().join('+') : '');
    let hit = gainCache.get(key);
    if (hit) return hit;

    const s = skills.get(skillId);
    const prof = combat.profile(skillId, rank, runes);
    const out = [];
    const name = s?.texts?.name ?? skillId;

    // 1. Authored. A periodic self-effect with no lifetime is income per second.
    const periodic = prof?.periodic?.tick > 0 && !Number.isFinite(prof.periodic.duration)
      ? prof.periodic.tick : null;
    if (periodic) {
      for (const e of prof.effects) {
        if (e.kind !== 'GainAtb' || !e.atb || !e.baseVal) continue;
        out.push({
          atb: e.atb, amount: e.baseVal, on: 'time', every: periodic, liveFactor: false,
          from: skillId, fromName: name,
          why: `${name} declares ${e.baseVal} ${e.atb} every ${periodic}s`
            + (prof.enableCond?.length ? ` while ${prof.enableCond.join('/')}` : ''),
        });
      }
    }

    // 2. Scripted. The guard says which events pay and how often.
    if (s?.script) {
      const src = liveScript(s.script);
      // A rune can carry the number the skill leaves open, so the slotted one's
      // vars are the fallback - Warrior_Charge reads vars.var1 and has none.
      const runeVars = (s.mastery ?? []).find((m) => runes?.has(m.id))?.vars ?? null;
      ADD_RESOURCE.lastIndex = 0;
      for (let m; (m = ADD_RESOURCE.exec(src));) {
        const [, , atb, expr] = m;
        if (!ctx.attrTable.byId.has(atb)) continue;
        const amount = amountOf(expr, varsOf(skillId, rank, runes), runeVars);
        // A spend, or an amount that is not a number in the data (`-getCp()`).
        if (amount == null || amount <= 0) continue;
        const scope = enclosingBlock(src.slice(0, m.index));
        // A CRIT gate is not an unreadable condition - the fight computes crit
        // expectation for every hit it prices. `Warrior_Talent_SeasonedSoldier`
        // pays 1 Rage on a physical critical strike, which is a rate, not a
        // mystery. The affinity rider is evaluable too, so both are lifted out
        // of the guard before it is judged.
        const critGated = /\bcritical\b|\bisCrit\b/.test(scope);
        const affinity = /\bisMagic\b/.test(scope) ? 'Magic'
          : /\bisPhysical\b/.test(scope) ? 'Physical' : null;
        const judged = scope.replace(/\b(?:critical|isCrit|isPhysical|isMagic)\b/g, ' ');
        const g = guardOf(judged, { rank, runes, talents });
        if (!g.fires) continue;
        if (g.unread) continue;             // conditional income is not income
        const ev = eventsOf(scope);
        let chance = 1;
        if (/checkProba\s*\(/.test(scope)) {
          const v = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope)?.[1];
          const n = v ? varsOf(skillId, rank, runes)[v] : null;
          if (typeof n === 'number' && n > 0 && n <= 1) chance = n;
        }
        out.push({
          atb, amount, chance,
          critGated, affinity,
          // Which factor path this income rides: Unit.addAtb@4876 op 21 reads
          // the LIVE gain factor (Berserk's doubled RageGainFactor reaches
          // per-attack Rage), while Unit.addResource@4885 uses the raw stored
          // factor - the InfiniteRage trickle and SurgingForce's return never
          // double, and neither does an authored GainAtb step.
          liveFactor: m[1] === 'addAtb',
          // A crit-gated gain rides every damaging event, not just the ones the
          // guard happens to name - a crit is a property of the hit, not of
          // which button produced it.
          on: ev.size ? [...ev] : critGated ? ['attack', 'combo', 'weapon-skill'] : ['cast'],
          // `!isSignature()` is the rule that stops the Warrior's own Rage
          // spender from paying for itself.
          excludeSignature: /isSignature/.test(scope),
          // The hook the call is written in. An event list of ['cast'] only
          // says that no swing or weapon skill is named; the hook says what
          // the event actually is - a conduit trigger, a heal, a clock.
          hook: hookAt(src, m.index) || null,
          // ...and the one skill its guard asks for, where it asks for one
          // (`ctx.skill.kind == Skill.ConsumeFlask`): the gain is paid on
          // that skill's use and on nothing else.
          needsSkill: /\b(?:skill\.kind|skillId)\s*==\s*Skill\.(\w+)/.exec(scope)?.[1] ?? null,
          from: skillId, fromName: name,
          why: `${name} generates ${amount} ${atb} `
            + (ev.size ? `on ${[...ev].join(' / ')}` : 'when it is cast')
            + (chance < 1 ? `, ${Math.round(chance * 100)}% of the time` : ''),
        });
      }
    }

    gainCache.set(key, out);
    if (gainCache.size > 20000) gainCache.delete(gainCache.keys().next().value);
    return out;
  }

  /**
   * The scoped damage modifiers a talent confers, at the rank it holds.
   *
   * THE RANK IS IN THE VARS. The scripts read `vars.X` without mentioning
   * rank, and what makes the second point of a two-point node buy something
   * is `props.rankOverride` restating X at minRank 2 - the same fold every
   * skill row gets (updateSkillInf@21787 ops 57-59), keyed on the talent's
   * points. This used to multiply the row's value by the points instead,
   * reasoned from the nodes whose value sits in affix columns (Fighting
   * Spirit 2 -> 4 CritChance); that agrees wherever the override doubles and
   * is wrong where it does not: Red Tempo restates its chance 0.12 -> 0.25
   * (not 0.24) beside a `time` it does not restate at all, and Magic
   * Conduction 0.07 -> 0.15. Every amount below is the var at the node's
   * rank, and nothing is multiplied.
   */
  const modCache = new Map();
  /**
   *  separates two things that both call themselves a rank. A talent
   * NODE rank is a dose - its effect scales with the points spent, so amounts
   * multiply by it. A weapon skill rank is a THRESHOLD its script tests, and
   * nothing multiplies by it. A non-talent caller passes  and
   * gets the amount once, with the rank spent answering the guard instead.
   */
  /**
   * What a skill's script DECLARES that the guard reader then refused.
   *
   * A refusal on a skill the model does not score at all shows up in the
   * unscored list. A refusal on a skill it DOES score shows up nowhere: the
   * skill is accounted, its damage is right, and one clause of its script is
   * quietly worth zero. `GS_Nova_Combo` is the case that found this - the
   * greatsword finisher is scored every cycle, and its rank-3
   * `reduceWeaponsCooldown(1.5)` is gated on `hasStatusMaxStacked`, correctly
   * refused, and never mentioned. Live weapon cooldowns therefore run faster
   * than modelled and the tool says nothing.
   *
   * This does not price anything. It names what was dropped, which is the
   * difference between a gap and a silent one.
   */
  const gapCache = new Map();
  // A skill whose damage lives in ANOTHER ROW, named only by its script.
  // `Heat Emission` was the case on the accepted build: `steps: []`, and its
  // whole payload was `startSkill(Skill.Scepter_Flamie_Skill1_Area,
  // flamie.owner)` once per live flamie - 8,633 hits of it in the capture and
  // not one of them modelled, and at rank 3 the row was rescued into the
  // rotation for the shield it also applies, so it was not even in the
  // unscored list: SILENT, which is the worst of the three things this file
  // can do with a row. Build 25782799 gave Heat Emission a Burst step of its
  // own (see the fan in `scriptedRiders`), and the row it used to start now
  // keeps its Burst behind `on: Code` with no script to play it.
  //
  // The row a script names is perfectly readable. What is missing is the FAN -
  // how many it starts - which is read off the loop around the call and said
  // in the row's own terms: one per status the owner has out, one per summon
  // of a named skill. Naming it is what this is for; pricing it is not,
  // because a fan this reader has to guess at is the flattering direction.
  //
  // One player row has the shape on this build: Power of the Tides, which
  // starts an AoE at each of its totems whenever an active skill is used.
  // (Four foe rows have it too.)
  const startsDamage = (skillId, rank, runes) => {
    const body = liveScript(skills.get(skillId)?.script ?? '');
    if (!body) return [];
    const out = [];
    const seen = new Set();
    const RE = /startSkill\s*\(\s*(?:Skill\.)?(\w+)/g;
    RE.lastIndex = 0;
    for (let m; (m = RE.exec(body));) {
      if (seen.has(m[1]) || !skills.get(m[1])) continue;
      seen.add(m[1]);
      const p2 = combat.profile(m[1], rank, runes);
      if (!p2?.effects?.some((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length))) continue;
      // The loop the call sits in, if any: `for (x in getSummons(Skill.S))`,
      // `for (x in getInflictedStatuses(Skill.S))`, or the same through a
      // local assigned on an earlier line.
      const scope = enclosingBlock(body.slice(0, m.index));
      const loops = [...scope.matchAll(/\bfor\s*\(\s*\w+\s+in\s+((?:[^()]|\([^()]*\))*)\)/g)];
      const over = loops.length ? loops[loops.length - 1][1].trim() : null;
      const src = over && /^\w+$/.test(over)
        ? new RegExp('\\bvar\\s+' + over + '\\s*=\\s*([^;]+);').exec(scope)?.[1]?.trim() ?? over
        : over;
      const fm = src ? /^(getSummons|getInflictedStatuses)\s*\(\s*(?:Skill\.)?(\w+)\s*\)$/.exec(src) : null;
      const ofName = fm ? (skills.get(fm[2])?.texts?.name ?? fm[2]) : null;
      out.push({
        row: m[1], hook: hookAt(body, m.index) || null,
        fan: fm ? { kind: fm[1] === 'getSummons' ? 'summon' : 'status', of: fm[2], name: ofName } : null,
        count: !over ? 'once each time that hook runs'
          : !fm ? `once per turn of a loop over \`${over}\`, which this reader does not count`
            : fm[1] === 'getSummons'
              ? `once for every summon of ${ofName} you have out, which this fight does not count`
              : `once for every ${ofName} you have out, and how many that is is live state this reader cannot count`,
      });
    }
    return out;
  };

  function scriptGapsOf(skillId, rank = 1, { asTalent = false, runes = null } = {}) {
    const key = skillId + '@' + rank + (asTalent ? '' : '#skill')
      + (runes?.size ? '@' + [...runes].sort().join('+') : '');
    let hit = gapCache.get(key);
    if (hit) return hit;
    hit = [];
    const s = skills.get(skillId);
    const body = s?.script ? liveScript(s.script) : '';
    if (body) {
      // The SLOTTED rune's vars go on top, or the reported magnitude is the
      // row's default rather than the one the clause would actually add.
      // Execution is gated on `hasMastery(Warrior_RageStrike_M3)` and that same
      // rune replaces both numbers it reads, so the gap used to be printed as
      // "dmgMult 0.5 ... healthRatio <= vars.threshold" - 0.5 above 0.2 - for a
      // rider whose tooltip says 25% below 35%. A var read only inside a clause
      // gated on the rune that overrides it has no observable base value at all.
      const runeVars = (s?.mastery ?? []).filter((m) => runes?.has(m.id))
        .reduce((acc, m) => ({ ...acc, ...(m.vars ?? {}) }), null);
      const own = asTalent ? s.vars : (combat.profile(skillId, rank, runes ?? undefined)?.vars ?? s.vars);
      const vars = runeVars ? { ...own, ...runeVars } : own;
      // A damage rider `runeDamage` already reads is not a gap - that reader
      // answers guards `scopeOf` refuses (a rank clause, a target-state one)
      // and applies them per-skill. Without this check Domination would be
      // reported as dropped while it is being applied.
      // WITH THE RUNES. A rune-gated rider only appears in `runeDamage` when
      // the rune is passed, so resolving this bare made the dedup miss and the
      // gap list claim a rider that is being applied: Concentrated Impact's
      // +40% at one target is read, printed in the rune table as read, and was
      // simultaneously reported as not scored. A refusal whose reason is false
      // is a bug - the same rule as the comment above `runeDamage` in resolve().
      const rcFlag = recastOf(skillId, rank, runes)?.flag ?? null;
      const read = [
        ...(combat.profile(skillId, rank, runes ?? undefined)?.runeDamage ?? []),
        // ...and a clause the recast's own press carries is read too.
        ...(rcFlag ? combat.riderDamage(skillId, rank, runes ?? null, { [rcFlag.name]: rcFlag.recastWhen }) : []),
      ];
      const look = (re, field) => {
        re.lastIndex = 0;
        for (let m; (m = re.exec(body));) {
          const name = field === 'cooldown' ? m[1] : m[2];
          const amount = vars?.[name];
          if (typeof amount !== 'number' || amount === 0) continue;
          if (field !== 'cooldown'
            && read.some((r) => r.field === m[1] && Math.abs(r.amount - amount) < 1e-9)) continue;
          const guard = enclosingBlock(body.slice(0, m.index));
          // Read, not a gap - unless it sits in a proxy hook, where the
          // modifier reader does not take it (it is not the owner's rider).
          if (!PROXY_HOOK.test(hookAt(body, m.index)) && scopeOf(guard, asTalent ? null : rank)) continue;
          // DEAD IS NOT A GAP. A clause behind a rune you did not slot, or
          // behind a rank this weapon has not reached, contributes nothing in
          // game either - reporting it as something the reader could not answer
          // would fill the list with things that are correctly worth zero.
          const needsRune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(guard)?.[1];
          if (needsRune && !runes?.has(needsRune)) continue;
          let rankDead = false;
          for (const r of String(guard).matchAll(/\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g)) {
            const n = Number(r[2]);
            const ok = r[1] === '>=' ? rank >= n : r[1] === '<=' ? rank <= n
              : r[1] === '>' ? rank > n : r[1] === '<' ? rank < n
                : r[1] === '==' ? rank === n : rank !== n;
            if (!ok) rankDead = true;
          }
          if (rankDead) continue;
          // The first `if` only, on one line. `enclosingBlock` hands back
          // everything up to the call, and one of these rows carries four
          // statements and a loop between the guard and the payload.
          const first = /\bif\s*\(([^{]*)\)/.exec(String(guard))?.[1] ?? '';
          const cond = first.replace(/\s+/g, ' ').trim().slice(0, 90);
          hit.push({
            id: skillId, name: s.texts?.name ?? skillId,
            field: field === 'cooldown' ? 'cooldownPerTick' : m[1],
            amount, guard: cond || '(none)',
            // WHICH hook the clause sits in, because it decides whose hits
            // it rides - a proxy hook's rider is the summons', not the owner's.
            hook: hookAt(body, m.index) || null,
          });
        }
      };
      look(/reduce(?:Weapons)?Cooldown\s*\(\s*vars\.([A-Za-z0-9_]+)\s*(?:,\s*[\w.?]+\s*)?\)/g, 'cooldown');
      look(new RegExp(DMG_FIELD.source, 'g'), 'damage');
      // THE ARMOUR FAMILY on a row that is not a talent - `ignoreResistance`,
      // `armorIgnore`, `magicArmorIgnore` - has readers of its own in
      // damage.mjs (`ignoresResistance`, `armourIgnoresOf`), each as narrow
      // as a script reader has to be. A write neither of them answers keeps
      // the hit's armour, which is the under-read direction and was SILENT:
      // `look` above takes a clause `scopeOf` can scope as read, which is
      // true of a talent (the category router applies it) and false of any
      // other row (engine.mjs lets only the cooldown field through from a
      // non-talent source), and a literal on the right matched nothing at
      // all. So every such write the profile does not carry is named here -
      // unless a rank it has not reached or a rune it did not slot makes it
      // dead in game as well. (A talent row is the category router's whichever
      // way it is asked.)
      if (!asTalent && typeOf(skillId) !== 'Talent') {
        const prof = combat.profile(skillId, rank, runes ?? undefined);
        const ARMOUR_WRITE = /\b\w+\.(ignoreResistance|armorIgnore|magicArmorIgnore)\s*(?:\+=|=)\s*([^;]+);/g;
        for (let m; (m = ARMOUR_WRITE.exec(body));) {
          // ...or the step-scoped literal reader carries it: an ignore
          // ASSIGNED behind `skillId == skill.kind && stepId == Steps.S` is a
          // rider of that one step (`runeDamage`, `stepId` + `set`), priced
          // where the step's hits are.
          const answered = m[1] === 'ignoreResistance'
            ? prof?.ignoresResistance === true
            : (prof?.armorIgnores ?? []).some((a) => a.field === m[1])
              || (prof?.runeDamage ?? []).some((rd) => rd.field === m[1] && rd.set && rd.stepId);
          if (answered) continue;
          const guard = enclosingBlock(body.slice(0, m.index));
          const needsRune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(guard)?.[1];
          if (needsRune && !runes?.has(needsRune)) continue;
          if (rankVeto(guard, rank)) continue;
          const rhs = m[2].trim();
          const vn = /^vars\.(\w+)$/.exec(rhs)?.[1];
          const first = ifConds(guard).map((c) => c.cond.trim()).join(' && ');
          // An entry the DMG_FIELD pass above already made for this clause
          // (it refuses the guard too) is not said twice.
          if (hit.some((h) => h.field === m[1] && h.hook === (hookAt(body, m.index) || null))) continue;
          hit.push({
            id: skillId, name: s.texts?.name ?? skillId, field: m[1],
            amount: vn && typeof vars?.[vn] === 'number' ? vars[vn] : rhs,
            guard: first.replace(/\s+/g, ' ').trim().slice(0, 90) || '(none)',
            hook: hookAt(body, m.index) || null,
          });
        }
        // A MULTIPLIER WRITTEN AS `*=`. DMG_FIELD finds `<field> += vars.X`
        // and nothing else, so `hit.dmgMult *= (1 + vars.var1)` reached no
        // reader and no gap: Nectar-infused Blade's rank-2 "Damage increased
        // by 30% against enemies under 35% [Health]" - on its own hit, behind
        // `var tunit = toUnit(hit.target); if (tunit != null &&
        // tunit.healthRatio <= vars.threshold)` - was neither priced nor
        // said. It is not priced here either (a `*=` multiplies whatever the
        // additive riders left, which is not the bracket `runeDamage` adds
        // into); it is NAMED, with the health it waits for - read off the
        // thing being hit, directly or through that one local - so the engine
        // can say "off at the health you stated" where that is the whole
        // truth. Dead at a rank or without a rune, it is not a gap.
        const MULT_WRITE = /\b\w+\.dmgMult\s*\*=\s*\(\s*1\s*\+\s*vars\.(\w+)\s*\)\s*;/g;
        for (let m; (m = MULT_WRITE.exec(body));) {
          const amount = vars?.[m[1]];
          if (typeof amount !== 'number' || amount === 0) continue;
          const guard = enclosingBlock(body.slice(0, m.index));
          const needsRune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(guard)?.[1];
          if (needsRune && !runes?.has(needsRune)) continue;
          if (rankVeto(guard, rank)) continue;
          const hm = /\b(\w+)\.healthRatio\s*(<=|>=|<|>)\s*vars\.(\w+)/.exec(guard);
          const ofTarget = !!hm && (/target/i.test(hm[1])
            || new RegExp('\\bvar\\s+' + hm[1] + '\\s*=\\s*toUnit\\s*\\(\\s*\\w+\\.target\\s*\\)\\s*;').test(guard));
          hit.push({
            id: skillId, name: s.texts?.name ?? skillId, field: 'dmgMult', amount, mult: true,
            targetHealth: ofTarget && typeof vars?.[hm[3]] === 'number' ? { op: hm[2], threshold: vars[hm[3]] } : null,
            // Whose hits: the row's own when the clause names its own id.
            own: new RegExp('\\b\\w+\\.(?:skill\\.inf\\.id|skillId)\\s*==\\s*Skill\\.' + skillId + '\\b').test(guard),
            guard: ifConds(guard).map((c) => c.cond.trim()).join(' && ').replace(/\s+/g, ' ').slice(0, 120) || '(none)',
            hook: hookAt(body, m.index) || null,
          });
        }
      }
      // A RIDER WHOSE RIGHT-HAND SIDE IS NOT A BARE VAR. Both looks above
      // require `<field> += vars.X;`, so a statement that multiplies the var
      // by a count, reads an attribute, or simply assigns a literal was
      // invisible to them - neither priced nor named. Three on player
      // weapons were silent that way: Cheesebane's bank (`dmgMult +=
      // owner.getStatusCount(Skill.<S>) * vars.var1`, fed by its own roll on
      // every tick of a damage-over-time), Brood Leap's `critChance = 1`
      // behind the status Honey Crush's reset arms, and Blessing's rank-3
      // `critChance += sourceSkill.vars.chance` on the attacks it empowers.
      //
      // Named, not priced. A statement another reader takes is not a gap, so
      // each of those readers is asked first: `runeDamage` (the forced
      // crit, the attribute rider), the own-stack bank and the detector's
      // last pulse (matched by their shape), a register (onSkillProc /
      // onUseSkill bodies, which `riderShape` and the empowerment reader
      // own), and the count-scaled companion on a dot. A proxy hook and a
      // receive hook are other readers' ground and are left to them, and so
      // is an amount that is a script LOCAL (`dmgMult += damageBonus`): what
      // it holds was worked out somewhere this net does not follow, and the
      // Rogue's Finisher - whose local is its combo points, read and priced -
      // is the row that says a local is not evidence of a gap.
      //
      // A reader added for one of these shapes has to be asked HERE as well,
      // or the row it prices is still printed as not priced.
      {
        const NON_BARE = /\b\w+\.(dmgMult|critDmgMult|critChance|armorIgnore|magicArmorIgnore|physicalDmgMult|magicDmgMult|dmgAdd)\s*(\+=|-=|\*=|=)\s*([^;]+);/g;
        NON_BARE.lastIndex = 0;
        for (let m; (m = NON_BARE.exec(body));) {
          const rhs = m[3].replace(/\s+/g, ' ').trim();
          if (/^-?\s*vars\.[A-Za-z0-9_]+$/.test(rhs)) continue;
          if (m[2] !== '+=' && m[2] !== '=') continue;
          if (/^[A-Za-z_]\w*$/.test(rhs)) continue;
          const hook = hookAt(body, m.index);
          if (!/^on(?:InflictDamageEval|DamageEval)$/.test(hook)) continue;
          const field = m[1];
          // THE ARMOUR FAMILY HAS READERS OF ITS OWN (damage.mjs: `armourIgnoresOf`,
          // on the profile as `armorIgnores`), and the net just above names
          // every write they leave on a row that is not a talent. A write the
          // profile carries is priced; one that net filed is already said.
          if ((field === 'armorIgnore' || field === 'magicArmorIgnore')
            && ((combat.profile(skillId, rank, runes ?? undefined)?.armorIgnores ?? []).some((a) => a.field === field)
              || hit.some((h) => h.field === field && h.hook === (hook || null)))) continue;
          // (`set`: a literal assigned on one step of the row's own - the
          // step-scoped reader's crit and armour ignore.)
          if (read.some((r) => r.field === field && (r.forced || r.set || (r.fromAtb && rhs.includes('Attribute.' + r.fromAtb))))) continue;
          // A next-cast register's forced crit is the empowerment reader's.
          if (field === 'critChance' && empowermentIds(rank, runes).has(skillId)) continue;
          // The own-stack bank `resolve()` prices (Tide Rising Uppercut), the
          // count-scaled companion `statusesOf` hands the fight (Gash), and a
          // literal on a status's own step (Depth Shield's last pulse).
          if (OWN_STACK_MULT.test(body) && /getStatusCount\s*\(\s*owner\s*,/.test(rhs)) continue;
          if (/^\w+\s*\*\s*vars\.\w+$/.test(rhs) && /for\s*\(\s*\w+\s+in\s+\w+\.target\.statuses\s*\)/.test(body)) continue;
          // ...and the count of one status type on the target, on a
          // damage-over-time (`hitHooksOf`, its `per-typed` shape: Intent to
          // Kill's `dmgMult += vars.damage * <poisons on the target>`), which
          // the fight binds onto the dots it rides and prices there.
          if (field === 'dmgMult' && hook === 'onInflictDamageEval' && /^vars\.\w+\s*\*\s*\w+$/.test(rhs)
            && hitHooksOf(skillId, rank, runes).some((h) => h.kind === 'per-typed')) continue;
          const guard = enclosingBlock(body.slice(0, m.index));
          const needsRune = /hasMastery\s*\(\s*(?:Mastery\.)?([A-Za-z0-9_]+)/.exec(guard)?.[1];
          if (needsRune && !runes?.has(needsRune)) continue;
          let rankDead = false;
          if (!/\|\|/.test(guard)) {
            for (const r of String(guard).matchAll(/\brank\s*(>=|<=|==|!=|>|<)\s*(\d+)/g)) {
              const n = Number(r[2]);
              const ok = r[1] === '>=' ? rank >= n : r[1] === '<=' ? rank <= n
                : r[1] === '>' ? rank > n : r[1] === '<' ? rank < n
                  : r[1] === '==' ? rank === n : rank !== n;
              if (!ok) rankDead = true;
            }
          }
          if (rankDead) continue;
          // Each enclosing `if`, by its own parentheses - `enclosingBlock`
          // hands the headers back without their braces, so a condition ends
          // where its parenthesis closes and nowhere else.
          const conds = [];
          for (const im of String(guard).matchAll(/\bif\s*\(/g)) {
            let depth = 1, j = im.index + im[0].length;
            for (; j < guard.length && depth > 0; j++) {
              if (guard[j] === '(') depth++;
              else if (guard[j] === ')') depth--;
            }
            conds.push(guard.slice(im.index + im[0].length, j - 1).replace(/\s+/g, ' ').trim());
          }
          const behind = conds.join(' && ').slice(0, 160);
          const literal = /^-?\d+(?:\.\d+)?$/.test(rhs);
          // `sourceSkill.vars.X` on a status is a var of the row that applied
          // it; with one applier in the sheet that is a number after all.
          const src = /^sourceSkill\.vars\.([A-Za-z0-9_]+)$/.exec(rhs);
          const appliers = src ? [...(statusAppliers.get(skillId) ?? [])] : [];
          const srcVal = appliers.length === 1 ? varsOf(appliers[0], rank, runes)[src[1]] : null;
          const name = s.texts?.name ?? skillId;
          hit.push({
            id: skillId, name, field, amount: typeof srcVal === 'number' ? srcVal : rhs, guard: behind || '(none)',
            hook,
            why: `${name} is scored, but one clause of its script is not: \`${field} ${m[2]} ${rhs}\``
              + (typeof srcVal === 'number'
                ? ` (${srcVal}, a var of ${skills.get(appliers[0])?.texts?.name ?? appliers[0]}, which applies it)` : '')
              + (behind ? ` behind \`${behind}\`` : '')
              + (literal
                ? ' - a literal the script writes onto the hit, behind a guard no reader here answers'
                : typeof srcVal === 'number'
                  ? ' - read, and not priced: it is on the hits the status sees while it is worn, and the fight '
                    + 'prices those at the sheet\'s own values'
                  : ' - the amount is not a number in the row (a count, an attribute or a state the script '
                    + 'reads when the hit lands), and no reader here prices that shape'),
          });
        }
      }
    }
    for (const st of startsDamage(skillId, rank, runes)) {
      const name = s?.texts?.name ?? skillId;
      hit.push({
        id: skillId, name, field: 'startSkill', amount: st.row, guard: `startSkill(${st.row})`,
        fan: st.fan, hook: st.hook,
        why: `${name} is scored, but its script also starts ${st.row} - a row that carries real `
          + `damage of its own - ${st.count}`,
      });
    }
    gapCache.set(key, hit);
    return hit;
  }

  function talentModifiers(skillId, rank = 1, { asTalent = true } = {}) {
    const key = skillId + '@' + rank + (asTalent ? '' : '#skill');
    let hit = modCache.get(key);
    if (hit) return hit;
    const s = skills.get(skillId);
    const out = [];
    // The row's vars at this rank: the node's points for a talent, the
    // weapon-skill rank for anything else (see `varsOf`).
    const vars = varsOf(skillId, rank);
    if (s?.script) {
      const body = liveScript(s.script);
      // A share of the damage handed back as healing. `Bloodfeast` reads
      // `setDynVal(1, ctx.amount * vars.damage); playStep(Steps.Heal, owner)` -
      // the dynVal IS the amount, which is why the status it plays declares
      // none, and 15% of everything a bleed deals is not a rounding error on a
      // build whose bleed is a tenth of its damage.
      const HEAL_SHARE = /setDynVal\s*\(\s*\d+\s*,\s*\w+\.amount\s*\*\s*vars\.([A-Za-z0-9_]+)\s*\)\s*;\s*playStep\s*\(\s*Steps\.(Heal|SelfHeal)/g;
      HEAL_SHARE.lastIndex = 0;
      for (let m; (m = HEAL_SHARE.exec(body));) {
        const amount = vars[m[1]];
        if (typeof amount !== 'number' || amount <= 0) continue;
        const sc = scopeOf(enclosingBlock(body.slice(0, m.index)), asTalent ? null : rank);
        if (!sc) continue;
        const { scope, statusType = null, targetBleeding } = sc;
        out.push({
          field: 'healShare', scope, statusType, targetBleeding,
          amount, from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      // ...and the same share written for ONE NAMED ROW's hits, with the play
      // behind a null test of who it lands on:
      //
      //   onInflictDamage(dmg) {
      //     if (dmg.skillId == Skill.S) {
      //       setDynVal(1, dmg.amount * vars.v);
      //       if (dmg?.status?.owner != null) playStep(Steps.Heal, dmg.status.owner);
      //     } }
      //
      // Soothing Rays: 30% of what Sunlight deals, healed to whoever wears the
      // Sunlight that dealt it. The reader above missed it twice over - a
      // statement stands between its two calls, and its scope is a skill id,
      // which `scopeOf` does not answer - and the step was then refused as
      // "played from onInflictDamage with no event this fight raises" beside
      // a Sunlight line of 188 hits. Read for exactly this spelling: the one
      // guard is the skill id, the step played carries nothing but a heal
      // whose amount is the dynVal, and the recipient is `owner` or the
      // wearer of the hitting status where that status is one a hero wears
      // (typed Buff and not Debuff) - in a fight of one hero, her.
      const HEAL_SHARE_OF = /if\s*\(\s*(\w+)\.skillId\s*==\s*(?:Skill\.)?(\w+)\s*\)\s*\{\s*setDynVal\s*\(\s*(\d+)\s*,\s*\1\.amount\s*\*\s*vars\.([A-Za-z0-9_]+)\s*\)\s*;\s*(?:if\s*\(\s*\1\??\.status\??\.owner\s*!=\s*null\s*\)\s*\{?\s*)?playStep\s*\(\s*Steps\.(\w+)\s*,\s*(\1\.status\.owner|owner)\s*\)/g;
      HEAL_SHARE_OF.lastIndex = 0;
      for (let m; (m = HEAL_SHARE_OF.exec(body));) {
        const amount = vars[m[4]];
        const of = skills.get(m[2]);
        const step = (s.steps ?? []).find((x) => x.id === m[5]);
        const fx = step?.effects ?? [];
        if (typeof amount !== 'number' || amount <= 0 || !of || !fx.length) continue;
        // effect 1 is Heal on this sheet's enum; asked by name.
        const kinds = cdb.enumValues('skill@steps@effects', 'effect');
        if (!fx.every((e) => kinds[e.effect] === 'Heal' && e.dynVal === Number(m[3]) && !(e.scaling ?? []).length && !e.baseVal)) continue;
        const types = (of.props?.status?.types ?? []).map((x) => x.type);
        const onHero = m[6] === 'owner' || (types.includes('Buff') && !types.includes('Debuff'));
        if (!onHero) continue;
        out.push({
          field: 'healShare', scope: 'one-skill', skill: m[2], statusType: null, targetBleeding: undefined,
          amount, from: skillId, name: s.texts?.name ?? skillId, step: m[5],
        });
      }
      // Cooldown reduction earned off an EVENT rather than carried as a stat.
      // `Red Tempo` reads `if (dmg.isStatusType(Bleed)) if (checkProba(0.12))
      // reduceWeaponsCooldown(1)` - so every bleed tick has a 12% chance to cut
      // a second off your weapon skills. That is a rate the fight can derive
      // once it knows the bleed's tick interval, which it does.
      // The optional second argument is WHOSE cooldowns - `owner`, or
      // `dmg.status.owner` for a status carrying its instigator. Both are you on
      // a self-applied status, so it changes nothing here except whether the row
      // is read at all: demanding a bare one-argument call refused two rows on
      // their punctuation alone.
      const CD_PROC = /reduce(?:Weapons)?Cooldown\s*\(\s*vars\.([A-Za-z0-9_]+)\s*(?:,\s*[\w.?]+\s*)?\)/g;
      CD_PROC.lastIndex = 0;
      for (let m; (m = CD_PROC.exec(body));) {
        const seconds = vars[m[1]];
        if (typeof seconds !== 'number' || seconds <= 0) continue;
        const scope0 = enclosingBlock(body.slice(0, m.index));
        const sc0 = scopeOf(scope0, asTalent ? null : rank);
        if (!sc0) continue;
        let chance = 1;
        const cv = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope0)?.[1];
        if (cv && typeof vars[cv] === 'number') chance = vars[cv];
        out.push({
          field: 'cooldownPerTick', scope: sc0.scope, statusType: sc0.statusType ?? null,
          targetBleeding: sc0.targetBleeding,
          amount: seconds * chance, from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      DMG_FIELD.lastIndex = 0;
      for (let m; (m = DMG_FIELD.exec(body));) {
        const amount = vars[m[2]];
        if (typeof amount !== 'number' || amount === 0) continue;
        // A rider written in a PROXY hook is its summons', never the owner's:
        // evalDamage@6124 raises onProxyDamageEval only for a hit whose
        // instigator is not its own proxy (ops 9-13). Whatever its guard
        // says, it is not a modifier on anything the owner casts.
        if (PROXY_HOOK.test(hookAt(body, m.index))) continue;
        const guard = enclosingBlock(body.slice(0, m.index));
        const sc2 = scopeOf(guard, asTalent ? null : rank);
        if (!sc2) continue;
        const { scope, statusType = null, targetBleeding } = sc2;
        out.push({
          // `armorIgnore` and `magicArmorIgnore` are the SAME 5% applied to two
          // different armours, not 10% applied to one. Exposed Essence sets
          // both on consecutive lines and folding them together doubled it.
          field: m[1],
          scope,
          statusType,
          targetBleeding,
          targetType: sc2.targetType ?? null,
          amount,
          from: skillId,
          name: s.texts?.name ?? skillId,
        });
      }
      // Two more authored guard shapes, at the value the rankOverride restates
      // like everything above (Authority 0.1 -> 0.2 at rank 2, Radiance
      // 0.12 -> 0.25).
      const varAtRank = (key) => vars[key];
      // A rider scoped to ONE SKILL by id - Authority is `dmg.skillId ==
      // Skill.Priest_Prayer_Smite -> dmgMult += vars.damage`. Only when the
      // named row is a castable skill: the same guard naming a STATUS is the
      // companion-hook family the dot pipeline reads.
      // ANCHORED, and the anchor is the whole point. Without the trailing
      // lookahead this matched the PREFIX of a longer expression and booked its
      // FIRST TERM as if it were the whole rider. On the accepted build two of
      // the five rows it matched were prefix matches, and both were priced
      // wrong for it: Venomous Finisher's `dmg.dmgMult += vars.damage *
      // dmg.target.getStatusCount(Skill.Rogue_Talent_LethalPoison_Status)`
      // booked a flat +5% where the script multiplied by up to seven stacks,
      // and Ramp-up's `+= vars.var1 * status.stacks` booked a flat +10% the
      // same way. A number that is WRONG is worse than one that is missing,
      // because nothing in the report marks it as a guess - so the anchor
      // refuses the shape. Build 25782799 re-scripted Venomous Finisher (it is
      // Venomous Assassin now, cooldown for the Finisher and no rider at all);
      // Ramp-up still has it.
      //
      // The pass below would name a TALENT of that shape - its mod reaches
      // `unreadMods` and prints as a gap - and no talent has it today. Ramp-up
      // is borne by a STATUS, and `if (!asTalent && mod.field !==
      // 'cooldownPerTick') continue` in engine.mjs drops every status-borne
      // mod before it gets there. So Ramp-up trades a wrong number for a
      // silence - the lesser of the two evils, and still one of them.
      const ONE_SKILL = /if\s*\(\s*\w+\.skillId\s*==\s*Skill\.(\w+)\s*\)\s*\{\s*\w+\.dmgMult\s*\+=\s*vars\.(\w+)\s*(?=[;}])/g;
      ONE_SKILL.lastIndex = 0;
      for (let m; (m = ONE_SKILL.exec(body));) {
        const v = varAtRank(m[2]);
        const row = skills.get(m[1]);
        if (typeof v !== 'number' || v <= 0 || !row || row.props?.status) continue;
        out.push({
          field: 'dmgMult', scope: 'one-skill', skill: m[1], statusType: null,
          targetBleeding: undefined, amount: v, from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      // ...and the same shape with a COUNT on the right of the var, which this
      // reader will not price: the multiplier is per stack of a status the
      // TARGET carries, and how many are on it when the cast lands is live
      // state rather than a column. It rides out under its own scope so the
      // engine can NAME it - which is what the anchor above would otherwise
      // have turned into a fresh silence.
      const ONE_SKILL_COUNT =
        /if\s*\(\s*\w+\.skillId\s*==\s*Skill\.(\w+)\s*\)\s*\{\s*\w+\.dmgMult\s*\+=\s*vars\.(\w+)\s*\*\s*([^;\n]+);/g;
      ONE_SKILL_COUNT.lastIndex = 0;
      for (let m; (m = ONE_SKILL_COUNT.exec(body));) {
        const v = varAtRank(m[2]);
        const row = skills.get(m[1]);
        if (typeof v !== 'number' || v <= 0 || !row) continue;
        out.push({
          field: 'dmgMult', scope: 'one-skill-per-count',
          skill: m[1], skillName: row.texts?.name ?? m[1],
          amount: v, countExpr: m[3].trim(), from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      // A rider behind the TARGET'S HEALTH, on a kind of cast, split by the
      // hit's affinity - Bullying the Weak (build 25782799):
      //   if (dmg.isWeaponSkill && dmg.targetUnit.healthRatio <= vars.threshold) {
      //     if (dmg.isMagic)    { dmg.dmgMult    += vars.damage; }
      //     if (dmg.isPhysical) { dmg.critChance += vars.chance; }
      //   }
      // The comparison is the one a skill's own execute clause makes
      // (Execution, Demonic Bite, Scatterbloom) and it is answered the same
      // way: exactly, against the health the caller STATED. `scopeOf` refuses
      // the guard for the healthRatio in it, so nothing reads this twice.
      {
        const hb = hookBody(body, 'onInflictDamageEval');
        // The hook's OUTERMOST guard only: the same comparison nested under
        // another condition (a skill's own `skillId == skill.kind`, a rank
        // test) is that clause's business, and `runeDamage` reads those.
        const hm = /^\s*if\s*\(([^{]*?)\b\w+\.targetUnit\??\.healthRatio\s*(<=|<|>=|>)\s*vars\.(\w+)\s*\)\s*\{/.exec(hb);
        const threshold = hm ? varAtRank(hm[3]) : null;
        const pre = hm ? hm[1].replace(/\s|&&/g, '') : '';
        const preScope = /^\w+\.isWeaponSkill$/.test(pre) ? 'weaponSkill'
          : /^\w+\.isBaseAttack$/.test(pre) ? 'attack-or-combo' : pre === '' ? 'all' : null;
        if (hm && typeof threshold === 'number' && preScope) {
          let depth = 1, i = hm.index + hm[0].length;
          const start = i;
          for (; i < hb.length && depth > 0; i++) depth += hb[i] === '{' ? 1 : hb[i] === '}' ? -1 : 0;
          const inner = hb.slice(start, i - 1);
          const CLAUSE = /(?:if\s*\(\s*\w+\.(isMagic|isPhysical)\s*\)\s*\{?\s*)?\w+\.(dmgMult|critChance|critDmgMult)\s*\+=\s*vars\.(\w+)\s*;/g;
          for (const cm of inner.matchAll(CLAUSE)) {
            const v = varAtRank(cm[3]);
            if (typeof v !== 'number' || v <= 0) continue;
            out.push({
              field: cm[2], scope: preScope,
              affinity: cm[1] === 'isMagic' ? 'Magic' : cm[1] === 'isPhysical' ? 'Physical' : null,
              targetHealth: { op: hm[2], threshold },
              amount: v, from: skillId, name: s.texts?.name ?? skillId,
            });
          }
        }
      }
      // A rider on every status tick the OWNER CARRIES - Radiance is
      // `ctx.status != null && ctx.status.owner == owner -> dmgMult +=
      // vars.damage`, measured x1.25 on all five of Emsei's self-carried
      // ticks at once (the orb's last-pulse ratio 2.25/1.25 pins that the +1
      // and this rider share the one additive bracket). The owner test is the
      // WEARER: a dot on the enemy is worn by the enemy and takes nothing.
      const OWN_TICK = /if\s*\(\s*(\w+)\.status\s*!=\s*null\s*&&\s*\1\.status\.owner\s*==\s*owner\s*\)\s*\{\s*\1\.dmgMult\s*\+=\s*vars\.(\w+)/.exec(body);
      if (OWN_TICK) {
        const v = varAtRank(OWN_TICK[2]);
        if (typeof v === 'number' && v > 0) {
          out.push({
            field: 'dmgMult', scope: 'own-status-tick', statusType: null,
            targetBleeding: undefined, amount: v, from: skillId, name: s.texts?.name ?? skillId,
          });
        }
      }
    }
    // ...and the modifiers that live on a DEBUFF this talent puts on the enemy.
    // `Warrior_Talent_Bruise` applies a 15-second status whose own script reads
    // `onReceiveDamageEval(dmg) { if (dmg.isPhysical) dmg.dmgMult += 0.04 }` -
    // an amplification on the TARGET, not a stat on you, which is why neither
    // the affix reader nor the self-buff reader ever saw it.
    //
    // It is credited at full uptime. The applier is a physical critical strike
    // and the debuff lasts fifteen seconds, so on any build that crits at all
    // it is up essentially always; that is an assumption and it is in the audit.
    for (const statusId of statusesOf(skillId, { rank }).all) {
      const st = skills.get(statusId);
      if (!st?.script) continue;
      const sbody = liveScript(st.script);
      if (!/function\s+onReceiveDamage/.test(sbody)) continue;
      DMG_FIELD.lastIndex = 0;
      for (let m; (m = DMG_FIELD.exec(sbody));) {
        // The status's own var, at the rank of what applied it - the node's.
        const amount = varsOf(statusId, rank)[m[2]];
        if (typeof amount !== 'number' || amount === 0) continue;
        const sc = scopeOf(enclosingBlock(sbody.slice(0, m.index)));
        if (!sc) continue;
        const aff = /isPhysical/.test(sbody) ? 'Physical' : /isMagic/.test(sbody) ? 'Magic' : 'all';
        out.push({
          field: m[1], scope: aff === 'all' ? 'all' : aff.toLowerCase(),
          targetBleeding: false, onTarget: true,
          amount, from: skillId, name: s.texts?.name ?? skillId,
        });
      }
    }

    modCache.set(key, out);
    return out;
  }

  /** Backwards-compatible view: just the self-buffs. */
  function selfBuffsOf(skillId, opts) {
    return statusesOf(skillId, opts).self;
  }

  /**
   * A SKILL THAT CAN BE PRESSED AGAIN INSIDE ITS OWN COOLDOWN.
   *
   * `Skill.isCooldownBlocked@9600` is `isInCooldown() && !canIgnoreCd()`, and
   * `canIgnoreCd@9601` op 0 asks `canForceCast@9647`, which is the script's
   * own `checkForceRecast()` (slot 41, its only caller in the boot). So a row
   * that defines the hook is castable through its cooldown for as long as the
   * hook says yes, and the script says when:
   *
   *   Zealous Spins     checkForceRecast -> canRecast():
   *                     `time.now - lastHitTime < vars.time` - three seconds
   *                     from a press that hit ("If an enemy is hit, you can
   *                     recast it within ::time::"); the recast's own hit
   *                     stamps lastHitTime = -1, so there is one.
   *   Hiveborn Blossom  checkForceRecast -> haveRecast(): a status the first
   *                     press puts on you (four seconds, its row's duration)
   *                     and the second press removes.
   *
   * Priced at one press per cooldown, a recast skill was read at HALF its
   * presses - Zealous Spins in silence - and a clause the script keeps for
   * the second press ("with damage increased by ::var1%::") had nowhere to go.
   *
   * Returned: the window, and the script's own flag for "this press is the
   * recast" where it keeps one (`recasting = true` under the test, or
   * `firstCast = !haveRecast()`), with the polarity that means recast. A
   * shape this does not read - Void Fangs recasts into an override skill,
   * Blink's is a teleport back - returns null and is named by the caller.
   *
   * NOT READ: that the second press restarts the cooldown. The press consumes
   * a charge through doConsumeCharge@9633 (`charges = max(0, charges - 1)`
   * after onTriggerCD@9634 restates the duration), and what the recharge does
   * with a charge count already at zero is server-side. Taken as a restart -
   * the cooldown runs from the LAST press - which is the slower reading.
   */
  function recastOf(skillId, rank = 1, runes = null) {
    const s = skills.get(skillId);
    const body = liveScript(s?.script ?? '');
    const test = /function\s+checkForceRecast\s*\(\s*\)\s*(?::\s*\w+\s*)?\{\s*return\s+(\w+)\s*\(\s*\)\s*;?\s*\}/.exec(body)?.[1];
    if (!test) return /function\s+checkForceRecast\b/.test(body) ? { unread: true } : null;
    const tb = hookBody(body, test);
    const vars = varsOf(skillId, rank, runes);
    let window = null;
    const clock = /time\.now\s*-\s*\w+\s*<\s*vars\.(\w+)/.exec(tb);
    if (clock) window = vars[clock[1]];
    else {
      const named = /getStatusCount\s*\(\s*(?:Skill\.)?(\w+)\s*\)/.exec(tb)?.[1];
      const sid = named && skills.has(named) ? named
        : named ? new RegExp('\\bvar\\s+' + named + '\\s*=\\s*Skill\\.(\\w+)\\s*;').exec(body)?.[1] : null;
      // Only a status the row itself puts on its owner when it is pressed.
      if (sid && new RegExp('addStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?(?:' + sid + '|' + named + ')\\b').test(body)) {
        window = combat.profile(sid, rank, runes)?.duration;
      }
    }
    if (!(typeof window === 'number' && window > 0)) return { unread: true };
    let flag = null;
    const direct = new RegExp('\\b(\\w+)\\s*=\\s*(!?)\\s*' + test + '\\s*\\(\\s*\\)\\s*;').exec(body);
    const branch = new RegExp('if\\s*\\(\\s*' + test + '\\s*\\(\\s*\\)\\s*\\)\\s*\\{\\s*(\\w+)\\s*=\\s*(true|false)\\s*;').exec(body);
    if (direct) flag = { name: direct[1], recastWhen: direct[2] !== '!' };
    else if (branch) flag = { name: branch[1], recastWhen: branch[2] === 'true' };
    return { window, flag, test };
  }

  /**
   * The Spark a row hands back when the conduits trigger: `onConduitTriggers`
   * - raised once per trigger EVENT, not per conduit (triggerAllConduits@30806)
   * - rolling `vars.<chance>` for `addResource(Attribute.Spark, vars.<n>)`.
   * Conduit Residues is the row. The fight carries it on the gauge as an
   * expectation (`sparkGauge.residues`), and the talent table asks here
   * whether the fight pays a gain the event list alone would call unpaid -
   * one reader, so the two cannot disagree. `points` is the node's rank.
   */
  function conduitRefundOf(skillId, points = 1, runes = null) {
    const tb = liveScript(skills.get(skillId)?.script ?? '');
    const m = /function\s+onConduitTriggers[\s\S]{0,200}?checkProba\s*\(\s*vars\.(\w+)\s*\)[\s\S]{0,120}?addResource\s*\(\s*Attribute\.Spark\s*,\s*vars\.(\w+)/.exec(tb);
    if (!m) return null;
    const tv = varsOf(skillId, points, runes);
    const chance = tv[m[1]], amount = tv[m[2]];
    return typeof chance === 'number' && typeof amount === 'number' ? { atb: 'Spark', chance, amount } : null;
  }

  /** Every status id a skill applies, whatever the model could make of it. */
  function statusIdsOf(skillId, opts) {
    return statusesOf(skillId, opts).all;
  }

  /**
   * The statuses the status reader KEEPS for this skill only while one of its
   * runes is slotted - a buff, a debuff or a dot its script applies behind
   * `hasMastery(<rune>)`. The honest way to ask whether a rune that declares
   * nothing but a description is read: slot it, unslot it, and see what the
   * reader holds. Each entry is the buff / debuff / dot as `statusesOf` kept
   * it (with its `trigger`).
   */
  function runeStatusesOf(skillId, runeId, { rank = 1, talents = null, talentRanks = null } = {}) {
    const kept = (st) => [...st.self, ...st.onTarget, ...st.dots];
    const without = new Set(kept(statusesOf(skillId, { runes: new Set(), rank, talents, talentRanks })).map((b) => b.status));
    return kept(statusesOf(skillId, { runes: new Set([runeId]), rank, talents, talentRanks }))
      .filter((b) => !without.has(b.status) && !b.trigger?.unread && !b.trigger?.notPlayed && !b.trigger?.toggle);
  }

  /**
   * The statuses a skill applies that carry a ONE-SHOT amount - a shield, a
   * lump heal, a single hit - as opposed to a tick schedule (which is a DoT and
   * goes through `dots`) or a stat affix (which is a buff and goes through the
   * sheet). The amount is in ordinary columns; all that was ever missing is a
   * rate to put it on.
   */
  function oneShotPayloads(skillId, { runes = null, rank = 1 } = {}) {
    const out = [];
    for (const statusId of statusesOf(skillId, { runes, rank }).all) {
      const sp = combat.profile(statusId, rank, runes);
      if (!sp || sp.periodic) continue;
      if (!sp.effects.some((x) => ['Damage', 'Heal', 'Shield'].includes(x.kind)
        && (x.baseVal || x.scaling.length))) continue;
      out.push({ status: statusId, prof: sp });
    }
    return out;
  }

  /** Every self-buff the resolved rotation can put up, deduplicated. */
  function selfBuffs(rotation) {
    const runes = new Set(rotation.runes ?? []);
    const seen = new Set();
    const out = [];
    for (const entry of [...rotation.active, ...rotation.triggered, ...rotation.filler, ...(rotation.passive ?? [])]) {
      // A passive entry may declare WHICH of its self-buffs it is claiming. The
      // two long-standing call sites hand over the whole of `st.self`, so this
      // is a no-op for them; it exists for the entry that reaches `passive`
      // because its damage had no rate, and is therefore only entitled to the
      // buffs that are up regardless of that rate.
      const own = entry.buffs ?? selfBuffsOf(entry.prof.id, { runes, rank: rotation.rank ?? 1 });
      for (const b of own) {
        if (seen.has(b.status)) continue;
        seen.add(b.status);
        out.push(b);
      }
    }
    return out;
  }

  /**
   * A NEXT-CAST EMPOWERMENT: something arms a one-shot register, and the next
   * cast of ONE named skill spends it for a discount and a guaranteed critical
   * strike. `Warrior_Talent_SurgeOfViolence` is the only one in the game, and
   * it is reachable without a talent point because `DemonSigil_War_SurgeOfViolence`
   * grants the node outright from a Head socket.
   *
   * The recognition is a TRIPLE, and a sweep of every script in the sheet
   * matches exactly one row with it - so this is a named mechanic, not a class:
   *
   *   onInflictDamageEval   hasStatus(owner, S) && hit.skillId == kind
   *                           -> hit.critChance = 1        (a LITERAL, not vars)
   *   evalCost              hasStatus(owner, S) -> return 0
   *   onStop                removeStatus(owner, S)
   *
   * ...plus an applier elsewhere that does `addStatus(owner, S)` behind
   * `isFinalAttack()` and `checkProba(vars.chance)`.
   *
   * Read three ways: `Warrior_Rage_Strike.onInflictDamageEval@45150` ops 20-21
   * set `critChance = 1`; `Warrior_Rage_Strike.evalCost@45151` ops 24-28 return 0; `Warrior_Rage_Strike.onStop@45148`
   * op 10 removes it. The applier is
   * `Warrior_Talent_SurgeOfViolence.onInflictDamage@45190`: op 3
   * `BaseSkill.isFinalAttack@6154` (which is `inf.type == 4`, AttackCombo), ops 5-7 the
   * hit's count is 1 (`hit.isFirstHit`, a guard build 25782799 added: one roll
   * a finisher however many hits it lands), op 20 `checkProba`, op 35
   * `addStatus`. `vars.chance` is 0.25 and `props.talent.maxPoints` is 1.
   */
  /**
   * Every id that PARTICIPATES in an empowerment anywhere in the sheet - the
   * skill that spends the register and the skill that arms it. Computed over
   * the whole skill list once per (rank, runes), because the pair is only
   * visible when both halves are in scope: asking about the applier alone finds
   * nothing. Used to keep the coverage report honest.
   */
  /**
   * A STACK COUNTER that arms a follow-up. The shape, in one script:
   *
   *   onInflictDamage(dmg) {
   *     if (!dmg.isDoT && dmg.isPhysical && !hasStatus(owner, UltProc))
   *       addStatus(owner, Buff);
   *     if (hasStatusMaxStacked(owner, Buff)) { removeStatus(Buff); addStatus(UltProc); }
   *   }
   *
   * One stack per qualifying damage EVENT, and at the cap it converts. So the
   * rate is not missing from the data at all - it is `events / maxStacks`, and
   * the only thing the old refusal ("nothing in the data says how many hits arm
   * it") was missing is that the fight counts its own events.
   *
   * The follow-up is named by `props.subskills`, not guessed from the id.
   */
  function stackProcsOf(ownedIds, { rank = 1, runes = null } = {}) {
    const out = [];
    // ONE COUNTER, however many routes lead to its host - the rule
    // `empowermentsOf` states for a register. `runableSkillIds` lists an
    // arsenal weapon's slotted skills once as what the weapon hands over and
    // once as the pick itself, so its own passive given an arsenal slot came in
    // twice; walked as given that was two counters fed by the same hits and the
    // follow-up on two identical lines, both in the headline (Anger Release
    // 2,520 twice behind Hysteria, Hidden Power 5,915 twice behind the Censer's
    // passive: 80 of the 3,388 main hand x arsenal pairs).
    ownedIds = [...new Set(ownedIds)];
    for (const id of ownedIds) {
      const s = skills.get(id);
      const body = s?.script ? liveScript(s.script) : '';
      if (!body) continue;
      // The TIMED shape - the Censer's ultimate. The passive drops a pickup
      // every vars.time seconds of combat (onRegUpdate), walking into it
      // grants one stack of a counter status, the counter's own script
      // converts at full stacks into a proc status, and THAT status's
      // props.skillOverride names the follow-up it puts on the signature
      // slot. Every number is authored: the timer, the counter's maxStacks,
      // the override target - so the rate is cap x time seconds of combat
      // per cast, from a cold start, plus the press the model does not bill.
      {
        const timed = /function\s+onRegUpdate\s*\([\s\S]{0,200}?isInCombat[\s\S]{0,200}?>\s*vars\.(\w+)[\s\S]{0,120}?playStep\s*\(\s*Steps\.(\w+)/.exec(body);
        const period = timed ? s.vars?.[timed[1]] : null;
        const pick = timed
          ? new RegExp('stepId\\s*==\\s*Steps\\.' + timed[2] + '\\b[\\s\\S]{0,300}?playStep\\s*\\(\\s*Steps\\.(\\w+)').exec(body)
          : null;
        const pickStep = pick ? (s.steps ?? []).find((x) => x.id === pick[1]) : null;
        const counterId = pickStep?.props?.status?.ref
          ?? (pickStep?.effects ?? []).map((e) => e.status).find(Boolean) ?? null;
        const counterRow = counterId ? skills.get(counterId) : null;
        const cap2 = counterId ? maxStacksOf(counterId, rank) : null;
        const conv = counterRow?.script
          ? /hasStatusMaxStacked\s*\([\s\S]{0,80}?\{\s*addStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)/.exec(liveScript(counterRow.script))
          : null;
        const followUp = conv
          ? skills.get(conv[1])?.props?.status?.skillOverride?.[0]?.skill ?? null : null;
        if (typeof period === 'number' && period > 0 && Number.isFinite(cap2) && cap2 > 1 && followUp) {
          // WHAT IS DROPPED, as the step authors it - for the sentence, not
          // for the rate. The rate above is the timer's, and it is the
          // rate of the drops; a stack is a drop the hero WALKED INTO, and
          // nothing in the data says how many of them that is (the fight
          // takes a stated share, `pickupShare`, all of them by default -
          // see the audit). `others` are the drops the timer does not make:
          // the same step played from another hook of the row.
          const dropStep = (s.steps ?? []).find((x) => x.id === timed[2]);
          const rnd = dropStep?.props?.position?.random ?? null;
          const lasts = typeof dropStep?.duration === 'string' ? (s.vars?.[dropStep.duration] ?? null) : (dropStep?.duration ?? null);
          const others = [...body.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1])
            .filter((fn) => fn !== 'onRegUpdate'
              && new RegExp('playStep\\s*\\(\\s*Steps\\.' + timed[2] + '\\b').test(hookBody(body, fn)))
            // ...each with the rank its body asks for, when it asks.
            .map((fn) => ({ hook: fn, minRank: Number(/\brank\s*>=\s*(\d+)/.exec(hookBody(body, fn))?.[1] ?? 0) }));
          out.push({
            from: id, counter: counterId, cap: cap2, skill: followUp, on: 'timer', period: cap2 * period,
            drop: {
              step: timed[2], every: period, lasts: typeof lasts === 'number' ? lasts : null,
              from: rnd?.minRange ?? null, to: rnd?.range ?? null, radius: dropStep?.range ?? null,
              others,
              // The pickup hook refuses a drop while the armed status waits.
              heldWhileArmed: new RegExp('stepId\\s*==\\s*Steps\\.' + timed[2] + '\\b[^{}]*!\\s*hasStatus\\s*\\([^)]*' + conv[1] + '\\b').test(body),
            },
          });
          continue;
        }
      }
      if (!/hasStatusMaxStacked/.test(body) || !/addStatus/.test(body)) continue;
      const alias = (n) => new RegExp(`\\b${n}\\s*=\\s*Skill\\.([A-Za-z0-9_]+)`).exec(body)?.[1] ?? n;
      const capped = /hasStatusMaxStacked\s*\(\s*owner\s*,\s*(\w+)/.exec(body)?.[1];
      if (!capped) continue;
      const counter = alias(capped);
      const cap = maxStacksOf(counter, rank);
      if (!Number.isFinite(cap) || cap <= 1) continue;
      // What arms it: the guard on the `addStatus` that feeds the counter.
      const feed = new RegExp(`if\\s*\\(([^)]*)\\)[^;{}]*\\{?[^;{}]*addStatus\\s*\\(\\s*owner\\s*,\\s*${capped}\\b`)
        .exec(body)?.[1] ?? '';
      if (!/isPhysical/.test(feed) || !/isDoT/.test(feed)) continue;   // the only shape read
      const follow = (s.props?.subskills ?? []).map((x) => x.skill ?? x.ref).filter(Boolean);
      if (!follow.length) continue;
      out.push({ from: id, counter, cap, skill: follow[0], on: 'physicalHit' });
    }
    return out;
  }

  /**
   * A MARK: a payload-less target debuff whose damage is a scripted step its
   * own consume() plays - fired when the SECOND stack arrives, so it pays one
   * lump per maxStacks applications. The Censer's mark is the shape: applied
   * by three step refs and one rank-gated script addStatus, consumed on
   * pairing (the instigator's-finisher consume path only accelerates the same
   * alternation - either way one fire spends the whole mark), Trigger step
   * 0.25 x (Int + Faith) at the weapon mix = the capture's constant 59, 51
   * rows without a single deviation or crit.
   */
  function markProcsOf(applierIds, { rank = 1, runes = null } = {}) {
    const byStatus = new Map();
    const note = (statusId, applier) => {
      const row = skills.get(statusId);
      if (!row?.script || !row.props?.status) return;
      const body = liveScript(row.script);
      const step = /function\s+consume\s*\(\s*\)\s*\{\s*playStep\s*\(\s*Steps\.(\w+)\s*\)\s*;?\s*consumeStatus\s*\(\s*owner\s*,\s*kind\s*\)/.exec(body)?.[1];
      if (!step) return;
      if (!/onReceiveStatus[\s\S]{0,200}?stacks\s*>\s*1[\s\S]{0,120}?consume\s*\(\s*\)/.test(body)) return;
      const cap = maxStacksOf(statusId, rank);
      if (!Number.isFinite(cap) || cap < 2) return;
      const e = byStatus.get(statusId) ?? { status: statusId, step, per: cap, appliers: [] };
      if (!e.appliers.includes(applier)) e.appliers.push(applier);
      byStatus.set(statusId, e);
    };
    for (const id of applierIds) {
      const p = combat.profile(id, rank, runes);
      for (const r of p?.statusRefs ?? []) {
        if (r.target === 'Target' && typeof r.ref === 'string') note(r.ref, id);
      }
      const body = liveScript(skills.get(id)?.script ?? '');
      const AS = /addStatus\s*\(\s*\w+\.target\s*,\s*Skill\.(\w+)\s*\)/g;
      AS.lastIndex = 0;
      for (let m; (m = AS.exec(body));) {
        const gate = /rank\s*>=\s*(\d+)/.exec(enclosingBlock(body.slice(0, m.index)));
        if (gate && rank < Number(gate[1])) continue;
        note(m[1], id);
      }
    }
    return [...byStatus.values()];
  }

  /**
   * A mark that DETONATES: stacks a cast leaves on the target, spent whole by
   * the next hit of a named kind.
   *
   * Void Bomblet (Mirrors of the Nightgoddesses) is the shape. The finisher's
   * two bolts each leave a stack (the Damage effect's own `status`, up to
   * props.status.maxStacks), and the status's script is
   *
   *   function onReceiveDamage(dmg) {
   *     if (dmg.isWeaponSkill && dmg.isMagic) { playStep(Steps.AOE); wait(0, () -> { stop(); }); }
   *   }
   *
   * with AOE a Code step whose Damage effect is flagged ScaleWithStacks - the
   * row's "Your [Magic] [WeaponSkill]s detonate ::ref_name::, dealing
   * ::ref_dmg:: per stack." It is a hook on damage the WEARER takes, which
   * here is the target, so the rule that refuses onReceiveDamage (the passive
   * foe never hits you) does not apply; and because the status is no row the
   * build owns, the step had no line and no gap either: Chaotic Distorsion
   * priced at its bare hit, with up to four stacks of 0.375 + 0.375 beside
   * it.
   *
   * `isMagic` is the affinity's damage type, not the Magic affinity alone
   * ($HSkill.isMagic@21765 compares getDamageType(affinity).id with "Magic"),
   * which is the root this model already keeps per effect; `isWeaponSkill`
   * is skill type 7 or 8 (BaseSkill.isWeaponSkill@6161). The fight banks one stack per
   * hit of an applier, to the cap, inside the status's own refreshing
   * duration, and the next weapon-skill cast that lands Magic damage spends
   * the bank - once: `stop()` removes the status before the cast's next hit.
   */
  function detonationsOf(applierIds, { rank = 1, runes = null } = {}) {
    const byStatus = new Map();
    for (const id of applierIds) {
      const p = combat.profile(id, rank, runes);
      for (const r of p?.statusRefs ?? []) {
        // (`target` is the enum's NAME - `profile().statusRefs`, decoded there.)
        if (r.target !== 'Target' || typeof r.ref !== 'string') continue;
        const row = skills.get(r.ref);
        if (!row?.script || !row.props?.status) continue;
        const hook = hookBody(liveScript(row.script), 'onReceiveDamage').replace(/\s+/g, '');
        const m = /^if\((\w+)\.isWeaponSkill&&\1\.isMagic\)\{playStep\(Steps\.(\w+)\);(?:wait\(0,\(\)->\{stop\(\);\}\);|stop\(\);)\}$/.exec(hook);
        if (!m) continue;
        const step = (combat.profile(r.ref, rank, runes)?.scripted ?? []).find((x) => x.stepId === m[2]);
        if (!step?.effects?.some((e) => e.kind === 'Damage' && e.scaleWithStacks && (e.baseVal || e.scaling.length))) continue;
        const cap = maxStacksOf(r.ref, rank);
        if (!Number.isFinite(cap) || cap < 1) continue;
        const e = byStatus.get(r.ref) ?? {
          status: r.ref, name: row.texts?.name ?? r.ref, step: m[2], cap,
          window: Number(row.duration) > 0 ? Number(row.duration) : Infinity, appliers: [],
          // ...and what a player calls them: the line names its appliers.
          applierNames: [],
        };
        if (!e.appliers.includes(id)) { e.appliers.push(id); e.applierNames.push(skills.get(id)?.texts?.name ?? id); }
        byStatus.set(r.ref, e);
      }
    }
    return [...byStatus.values()];
  }

  /** Both halves of every stack-counter pair in the sheet, for the coverage report. */
  const stackIdCache = new Map();
  function stackProcIds(rank = 1, runes = null) {
    const key = rank + '@' + (runes?.size ? [...runes].sort().join('+') : '-');
    let hit = stackIdCache.get(key);
    if (!hit) {
      hit = new Set();
      for (const p of stackProcsOf([...skills.keys()], { rank, runes })) {
        hit.add(p.from); hit.add(p.skill);
      }
      stackIdCache.set(key, hit);
    }
    return hit;
  }

  const empIdCache = new Map();
  function empowermentIds(rank = 1, runes = null) {
    const key = rank + '@' + (runes?.size ? [...runes].sort().join('+') : '-');
    let hit = empIdCache.get(key);
    if (!hit) {
      hit = new Set();
      for (const e of empowermentsOf([...skills.keys()], { rank, runes })) {
        hit.add(e.from); hit.add(e.skill);
        // The chain's own counter is a participant too: Chaincast is scored
        // through the register whether or not a crit armer rides it.
        if (e.chainFrom) hit.add(e.chainFrom);
        // ...and so is every node that hangs something on a chain cast.
        for (const id of [...(e.volleyFrom ?? []), ...(e.strikeFrom ?? [])]) hit.add(id);
      }
      empIdCache.set(key, hit);
    }
    return hit;
  }

  /**
   * What a participant of an empowerment IS, in the words a talent table
   * prints beside it. A chain counter is not a next-cast register and must
   * not be called one: its payoff is a free weapon skill, not a crit.
   */
  function empowermentLabel(id, rank = 1, runes = null) {
    for (const e of empowermentsOf([...skills.keys()], { rank, runes })) {
      if (e.chainFrom === id) {
        return `the chain: every ${e.armEveryActiveCasts} skills, the next weapon skill costs no Spark, `
          + `fires your conduits${e.chainSpend?.resetsCooldown ? ' and has no cooldown' : ''}`;
      }
      if ((e.volleyFrom ?? []).includes(id) && e.from !== id) return 'fires your conduits once more on every chain cast';
      if ((e.strikeFrom ?? []).includes(id)) return 'more damage on your attacks while a chain is armed';
      if (e.from === id || e.skill === id) return 'a next-cast register';
    }
    return null;
  }

  // The status-side consumer of the Mage chain's crit register - see the
  // second half of `empowermentsOf` for why the accessor hop is anonymous.
  const CHAIN_CRIT_CONSUMER = /function\s+onUseSkill\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\.(?:\w+\??\.)?(?:isFinalAttack|isFinalCombo)\s*\(\s*\)\s*\)\s*\{\s*\1\.critChance\s*\+?=\s*1\b[\s\S]{0,200}?consumeStatus\s*\(\s*(?:owner|ownerHero)\s*,/;

  function empowermentsOf(ownedIds, { rank = 1, runes = null } = {}) {
    const out = [];
    // ONE OF EACH, however many routes lead to it. A node held as a talent
    // point AND handed over by a sigil is in the caller's list twice, and a
    // register is a status, not a count of ways to own its armer: the hero
    // carries one. Walked as given, a Mage with High Voltage from both routes
    // was handed TWO chain registers - two arms every four casts, two free
    // weapon skills, two sets of conduit volleys - and that doubled economy
    // is what the 720-dps Mage optimum of the regex-only fix was made of.
    ownedIds = [...new Set(ownedIds)];
    const consumers = new Map();     // status -> skill that spends it
    for (const id of ownedIds) {
      const body = liveScript(skills.get(id)?.script ?? '');
      if (!body) continue;
      const forced = /hasStatus\s*\(\s*owner\s*,\s*(\w+)\s*\)[^;{}]*\)?\s*\{?[^;{}]*\.critChance\s*=\s*1\b/.exec(body);
      if (!forced) continue;
      if (!new RegExp(`hasStatus\\s*\\(\\s*owner\\s*,\\s*${forced[1]}\\s*\\)`).test(body)) continue;
      if (!/\bevalCost\b/.test(body) || !/return\s+0/.test(body)) continue;
      if (!/removeStatus\s*\(\s*owner\s*,/.test(body)) continue;
      // The status is named through a local alias; resolve it to a real row.
      const alias = new RegExp(`\\b${forced[1]}\\s*=\\s*(?:Skill\\.)?([A-Za-z0-9_]+)`).exec(body);
      consumers.set(alias?.[1] ?? forced[1], id);
    }
    if (consumers.size) {
      for (const id of ownedIds) {
        const body = liveScript(skills.get(id)?.script ?? '');
        if (!body) continue;
        for (const [status, skill] of consumers) {
          const m = new RegExp(`addStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?${status}`).exec(body);
          if (!m) continue;
          const line = body.slice(0, m.index);
          const onFinisher = /isFinalAttack|isFinalCombo/.test(line);
          const cv = /checkProba\s*\(\s*vars\.(\w+)/.exec(line)?.[1];
          const chance = cv ? skills.get(id)?.vars?.[cv] : 1;
          if (!onFinisher || typeof chance !== 'number' || !(chance > 0)) continue;
          out.push({ status, skill, from: id, chance, on: 'combo' });
        }
      }
    }
    // THE MAGE CHAIN, the second authored shape - and it belongs to the
    // COUNTER, not to the crit register that rides it. The Chaincast talent
    // counts ACTIVE-skill uses (`ctx.skill.isActiveSkill()`,
    // Mage_Talent_Chaincast.onSkillProc@45436 op 3) up to vars.var1, then sets
    // a status and stops counting while it is up (ops 14-16). The class
    // passive spends that status on the next WEAPON-SKILL press and raises
    // onMageChainCast (Mage_SparkMaster.onPreSkillProc@45397 ops 14-35 and
    // 56-79), which the counter's own script answers with a conduit volley
    // and the cast's cooldown handed back. None of that reads High Voltage:
    // Chaincast is the tree's root and High Voltage a tier-4 node (and a
    // sigil), so a chain without the crit register is the ordinary Mage.
    // This loop used to START from the crit armer, which priced a Chaincast
    // Mage without High Voltage as having no chain at all.
    for (const id of ownedIds) {
      const row = skills.get(id);
      const body = liveScript(row?.script ?? '');
      if (!body || !/isActiveSkill\s*\(\s*\)/.test(body) || !/function\s+onMageChainCast\b/.test(body)) continue;
      const cnt = /<\s*vars\.(\w+)/.exec(body);
      const every = cnt ? row.vars?.[cnt[1]] : null;
      if (!(typeof every === 'number' && every > 0)) continue;
      // The ARM is the status whose presence freezes the counter and which
      // the counter itself sets at the cap; its own row says how long an
      // unspent arm lasts (Mage_Talent_Chaincast_Status.duration, 15).
      const armId = /hasStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*\)/.exec(body)?.[1] ?? null;
      if (!armId || !skills.has(armId)
        || !new RegExp(`(?:set|add)Status\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?${armId}\\s*\\)`).test(body)) continue;
      const armWindow = combat.profile(armId, rank, runes)?.duration ?? 0;
      // Chaincast's payoff also resets the consuming cast's cooldown a frame
      // later - wait(0, () -> ctx.activeSkill?.resetCooldown()) - which live
      // play respends within ~0.5s, the whole reason Censer skills beat
      // their authored cooldowns.
      const resetsCooldown = /resetCooldown/.test(body);
      // EVERY onMageChainCast consumer that force-fires conduits counts, not
      // only the counting talent: Reverberate's whole payoff is a SECOND
      // full volley 0.4s after Chaincast's - the capture's burst-start gaps
      // cluster at [400,600)ms once per chain, and without the echo the
      // trigger ledger runs 37 events short of the observed 204.
      let conduitVolleys = 0;
      // The COSTLESS CRIT REGISTER is one more onMageChainCast consumer, and
      // an optional one: High Voltage plants a status on every chain cast
      // (onMageChainCast -> addStatus(ownerHero, ...Status)) and the STATUS's
      // own script is the consumer - onUseSkill guards the finisher
      // predicate, adds critChance += 1 to the cast and consumes itself.
      // Live it re-arms 2-4x faster than finishers are pressed, which is why
      // every recorded finisher volley crits (12 of 12 at 100%).
      //
      // The predicate's RECEIVER is whatever the build's script context calls
      // the cast this patch: `skill.baseSkill.isFinalAttack()` on the
      // accepted build, `skill.activeSkill.isFinalAttack()` on 25782799 (the
      // cdb-wide accessor respelling; Mage_Talent_HighVoltage_Status.onUseSkill@45468 op 9 is the same
      // BaseSkill.isFinalAttack@6154 call either way). One optional accessor hop of any
      // name is accepted - the predicate carries the meaning, as KNOWN_PRED
      // already reads it - because spelling the old accessor here is what
      // silently dropped the whole chain economy on patch day.
      let crit = null;
      const volleyFrom = [];
      for (const rid of ownedIds) {
        const rb = liveScript(skills.get(rid)?.script ?? '');
        if (!rb || !/onMageChainCast/.test(rb)) continue;
        if (/forceTriggerAllConduits/.test(rb)) { conduitVolleys++; volleyFrom.push(rid); }
        if (crit) continue;
        const arm = /function\s+onMageChainCast\s*\([^)]*\)\s*\{[\s\S]*?addStatus\s*\(\s*(?:owner|ownerHero)\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)/.exec(rb);
        if (!arm) continue;
        const sBody = liveScript(skills.get(arm[1])?.script ?? '');
        if (CHAIN_CRIT_CONSUMER.test(sBody)) crit = { status: arm[1], from: rid };
      }
      // The CONSUME is the event, and it is not free of semantics: the chain
      // is spent by the next WEAPON-SKILL press (Mage_SparkMaster's
      // onPreSkillProc, the sole propagateMageChainCast@30808 caller), and
      // that press pays ZERO Spark - ops 80-87 of
      // Mage_SparkMaster.onPreSkillProc@45397 charge only when !isFree. The
      // sim consumes at the press, waives the Spark, fires the volleys,
      // resets the cooldown, and - when the build owns one - arms the crit
      // register, all at the same instant the game does. `chance` is that
      // register's: 0 without it, so the chain's economy is priced and the
      // finisher keeps its own crit roll.
      out.push({
        status: crit?.status ?? armId, skill: null, from: crit?.from ?? id, chainFrom: id,
        chance: crit ? 1 : 0,
        on: 'combo', consume: 'combo', armEveryActiveCasts: every, armWindow,
        firesConduits: conduitVolleys > 0, conduitVolleys, volleyFrom,
        // The node whose rider is live while an arm is banked (Chainstrike:
        // `hit.skill.isBaseAttack() && hasStatus(owner, <the arm>)`), by the
        // same shape `resolve` reads it in.
        strikeFrom: ownedIds.filter((rid) => new RegExp('hasStatus\\s*\\(\\s*owner\\s*,\\s*(?:Skill\\.)?' + armId
          + '\\s*\\)\\s*\\)\\s*\\{\\s*\\w+\\.dmgMult\\s*\\+=').test(liveScript(skills.get(rid)?.script ?? ''))),
        chainSpend: { on: 'weapon-skill', freeSpark: true, resetsCooldown, status: armId },
      });
    }
    return out;
  }

  return {
    pools, defaultSelection, pruneSelection, resolve, selfBuffs, selfBuffsOf, statusesOf, crowdControlOf,
    ownCrowdControlOf, refusalOf, wieldOf, recastOf, runeStatusesOf, conduitRefundOf,
    weaponSlotsAt, arsenalSlotsAt, typeOf, isBaseAttack, baseChain, resourceGainsOf, talentModifiers, maxStacksOf,
    doseGateOf, hitHooksOf, scriptedRiders, stepIsDead, cooldownGiftsOf,
    empowermentsOf, empowermentIds, empowermentLabel, scriptGapsOf, stackProcsOf, markProcsOf, detonationsOf,
    slotOpeners,
    lastFiredOf: (id) => lastFiredRider(skills.get(id)?.script),
    mechanicTypes: MECHANIC_TYPES,
  };
}
