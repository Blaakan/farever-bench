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
// second would make it the entire build. Its real trigger is in its own
// description - "Becomes ready after you use your [ComboAttack]" - and in
// `Priest_Rosary`'s script:
//
//     function onSkillProc(ctx) {
//       if( ctx.skill.isFinalAttack() ) { chargePrayer(); }
//     }
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
const MECHANIC_TYPES = {
  PriestPrayer: { slotConstant: 'Priest_Prayer_Slot_Unlocks', label: 'prayers' },
  MageConduit: { slotConstant: 'Mage_Conduit_Levels', label: 'conduits' },
  RoguePoison: { slotConstant: null, label: 'poisons' },
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
const SELF_TARGETS = new Set(['owner', 'ownerHero', 'hit.source', 'this.owner', 'dmg.source', 'ctx.source', 'self']);
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
// it, because it only ever looked in script text. `props.status.target` is a
// Self|Target|Group enum, absent meaning Self.
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
const KNOWN_PRED = /\b\w+[.?]+(?:isMagic|isPhysical|isWeaponSkill|isBaseAttack|isBasicAttack|isFinalCombo|isFinalAttack|isStatusType|hasStatusType|critical|isCrit)\b|\b(?:isStatusType|hasStatusType)\s*\(/g;

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
  if (/isMagic/.test(guard)) return { scope: 'magic', targetBleeding };
  if (/isWeaponSkill/.test(guard)) return { scope: 'weaponSkill', targetBleeding };
  // Which half of the swing-and-finisher pair a guard names is a third of the
  // rate, and collapsing both onto 'attack' silently dropped the finisher:
  // Zealous Fighter's +8pp crit reads `isBaseAttack || isFinalCombo`, and the
  // finisher never saw it.
  {
    const base = /isBaseAttack|isBasicAttack/.test(guard);
    const fin = /isFinalCombo|isFinalAttack/.test(guard);
    if (base && fin) return { scope: 'attack-or-combo', targetBleeding };
    if (fin) return { scope: 'combo', targetBleeding };
    if (base) return { scope: 'attack', targetBleeding };
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
  if (targetBleeding) return { scope: 'all', targetBleeding };
  return { scope: 'all', targetBleeding: false };
}

const POOL_LOCAL = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\w+\.amount\s*\*\s*vars\.([A-Za-z0-9_]+)\s*;/g;
const ADD_STATUS_3 = /(?:addStatus|enforceStatus|setStatus)\s*\(\s*([A-Za-z_.]+)\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)\s*,\s*([^;()]+?)\)\s*;/g;

/** A literal, `vars.x`, or `-vars.x`. Anything else is not a number we have. */
function amountOf(expr, vars, runeVars = null) {
  const t = String(expr).trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(-?)\s*vars\.([A-Za-z0-9_]+)$/.exec(t);
  if (!m) return null;
  // A rune can supply the number the skill itself does not declare -
  // Warrior_Charge reads `vars.var1` and its own vars have no var1 - and it can
  // also REPLACE one the skill does declare. `updateSkillInf@20788` runs
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
const UNREAD_COND = /\b(hasStatusMaxStacked|hasStatusApplied|hasStatusType|hasStatus|getStatusCount|getStatusesCount|getStatusTypeCount|isStatusType|isInCooldown|isSkillInCooldown|getMaxStacks|getEffectCount|haveProc|canRecast|haveRecast|isUnderAnyCC|isCCImmune|checkComboPoints|getCp|critical|isCrit|healthRatio|isPhysical|isMagic|totalHits|hitCount)\b/;

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
function guardOf(scope, { rank = 1, runes = null, talents = null } = {}) {
  RANK_CMP.lastIndex = 0;
  for (let m; (m = RANK_CMP.exec(scope));) {
    if (!cmpOk(rank, m[1], Number(m[2]))) return { fires: false, why: `its script gates on rank ${m[1]} ${m[2]}` };
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
  const un = UNREAD_COND.exec(scope);
  return { fires: true, unread: un ? un[1] : null };
}

// Comments out of a script body, so nothing switched off is ever credited.
// Whitespace is preserved so an index into the result still points at the same
// place in the original.
const blank = (s) => s.replace(/[^\n]/g, ' ');
const liveScript = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/\/\/[^\n]*/g, blank);

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
function enclosingBlock(src) {
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
 * The ComboPoint cap the finisher actually spends at - from the rows, not a
 * literal.
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
  const statusTypes = cdb.byId('statusType');
  const statusFlagNames = cdb.enumValues('statusType', 'flags');
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

  /**
   * How many stacks of a status can be held at once.
   *
   * Read from `Status.getMaxStacks@14459`: the base is
   * `props.status.maxStacks`, DEFAULT 1 - not unlimited - and every
   * `props.rankOverride` entry at or below the applying skill's rank may
   * replace it (`updateSkillInf@20788` copies the field through, later wins).
   *
   * `maxStacks <= 0` means UNCAPPED, and that sign is a live trap: seven rows
   * author `-1`, and the `?? 1` this replaces handed a literal -1 straight into
   * the affix scale, i.e. a buff worth MINUS its own value. Only a foe status
   * carries affixes among those seven today, so nothing was visibly wrong -
   * which is exactly the kind of bug that waits for a patch to become one.
   *
   * One row needs the script path: `Rogue_Talent_LethalPoison_Status` declares
   * `getStatusMaxStacks(b) = b + getTalentRank(Rogue_Talent_ImprovedMixture)`.
   * Every other status returns -1 from the default hook, so the base stands.
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
  // How long the chain is, is AUTHORED - `moveSet.comboLength`, on the moveSet
  // the weapon's itemType inherits. It was never read, and on two weapons out
  // of the thirty-three that carry a chain the item's own `skills` list is
  // SHORTER than what that column says:
  //
  //   Scepter_Flamie  lists Scepter_Base_Attack + its own combo   -> 2, says 4
  //   DM_Multispin    lists DM_Base_Attack1..3 + its own combo    -> 4, says 5
  //
  // Both are missing links that exist as skill rows and are shared across the
  // weapon type: Scepter_Base_Attack2 and _Attack3 are what Scepter_Start
  // swings, and DM_Base_Attack4 is a chain-link row referenced by NO item in
  // the sheet - the only such orphan among player weapons. So the item row is
  // incomplete and the game resolves the rest from the type, which is the only
  // reading under which comboLength means anything.
  //
  // It is not a cosmetic difference. The combo finisher is what charges a
  // Priest's prayers and what every `isFinalCombo` proc guard rolls against, so
  // a chain read as 2 links instead of 4 fires all of them TWICE as often: a
  // Priest holding Scepter_Flamie read 0.65 combos/s against Scepter_Start's
  // 0.31, and prayers every 4.62s against 9.68s. The short reading is also the
  // flattering one, which is exactly the direction to be suspicious of.
  //
  // The fill is derived, never a list kept here: take the common id prefix of
  // the links the weapon DOES declare, and use it to find the row that fills
  // each missing slot. `Net_Basic` (a capture net, prefix `Net_Capture`) matches
  // nothing and is correctly left alone, and an ambiguous match fills nothing
  // rather than guessing.
  const chainRowsBySlot = new Map(CHAIN_SLOTS.map((s) => [s, []]));
  for (const s of cdb.lines('skill')) {
    const t = T[s.type ?? -1];
    if (chainRowsBySlot.has(t)) chainRowsBySlot.get(t).push(s.id);
  }
  const moveSets = cdb.byId('moveSet');
  const commonPrefix = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(0, i);
  };

  const chainCache = new Map();
  /**
   * The ordered base-attack chain a weapon actually swings: its own links in
   * slot order, any link the type supplies that the item row omits, then the
   * combo. `filled` names what had to be recovered and `short` says the chain
   * is still under its authored length, so neither is ever silent.
   */
  function baseChain(item) {
    if (!item) return { links: [], filled: [], want: 0, short: false, moveSet: null };
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
    const filled = [];

    if (want > 0 && swings.length && swings.length + combo.length < want) {
      const prefix = swings.reduce((p, id) => (p === null ? id : commonPrefix(p, id)), null);
      const haveSlots = new Set(swings.map(typeOf));
      for (const slot of CHAIN_SLOTS) {
        if (swings.length + combo.length + filled.length >= want) break;
        if (haveSlots.has(slot) || !prefix) continue;
        // Exactly one candidate, or none. Two rows that both fit the slot and
        // the prefix is an ambiguity this cannot settle, and picking one would
        // be inventing a swing.
        const cands = (chainRowsBySlot.get(slot) ?? [])
          .filter((id) => id.startsWith(prefix) && !swings.includes(id));
        if (cands.length !== 1) continue;
        filled.push({ slot, skill: cands[0], name: skills.get(cands[0])?.texts?.name ?? cands[0] });
      }
    }

    // Slot order, stable within a slot so two `Attack`-typed staff swings keep
    // the order the item lists them in, and the combo always finishes.
    const slotIx = (id) => CHAIN_SLOTS.indexOf(typeOf(id));
    const links = [...swings, ...filled.map((f) => f.skill)]
      .map((id, i) => ({ id, i, s: slotIx(id) }))
      .sort((a, b) => (a.s - b.s) || (a.i - b.i))
      .map((x) => x.id)
      .concat(combo);
    hit = {
      links, filled, want, moveSet: item.moveSet ?? null,
      short: want > 0 && links.length < want,
    };
    chainCache.set(item.id, hit);
    return hit;
  }

  // --- the pools a build has to choose from --------------------------------
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
    for (const [type, def] of Object.entries(MECHANIC_TYPES)) {
      const options = classSkills.filter((id) => typeOf(id) === type);
      if (!options.length) continue;
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
      });
    }
    return out;
  }

  // The default selection: the first `slots` options, so a build with no
  // explicit choice is still well-defined and deterministic.
  function defaultSelection(loadout) {
    const sel = {};
    for (const p of pools(loadout)) sel[p.key] = p.options.slice(0, p.slots);
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
      if (!loadout.skills[key]?.length) loadout.skills[key] = p.options.slice(0, p.slots);
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
    // ...and how many POINTS are in each, which one status cap depends on:
    // Lethal Poison's own script reads `getStatusMaxStacks(b) = b +
    // getTalentRank(Rogue_Talent_ImprovedMixture)`.
    const talentRanks = new Map(Object.entries(loadout.talents ?? {}));
    const guardOpts = { rank, runes, talents };
    const usableRule = (r) => !!r && r.kind !== 'never' && r.kind !== 'conditional';

    // Riders that ride an EVENT rather than the host's own cast, collected as
    // profiles are resolved and pushed into `triggered` once it is known which
    // skills the fight can actually fire.
    const pendingRiders = [];
    const riderCache = new Map();
    /**
     * The profile a bucket should use: the same one `combat.profile` returns,
     * with its per-cast script riders folded back in, and its event riders
     * parked for the pass below. See `scriptedRiders` and `foldRider`.
     */
    function profileOf(id, atRank = rank) {
      const key = id + '@' + atRank;
      if (riderCache.has(key)) return riderCache.get(key);
      const base = combat.profile(id, atRank, runes);
      let prof = base;
      if (base?.scripted?.length) {
        const { riders, refused } = scriptedRiders(id, base, { rank: atRank, runes, talents });
        let folded = null;
        for (const r of riders) {
          if (r.rule.kind !== 'per-parent-cast') { pendingRiders.push({ host: id, prof: base, ...r }); continue; }
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
    const dotSeen = new Set();
    // Hosts whose payload the model DID reach, but through a bucket that runs
    // after the coverage report has already been written into. Listing a skill
    // as unscored while the fight is visibly firing one of its steps is the
    // output contradicting itself.
    const accountedLate = new Set();

    // Every damage- or heal-over-time this build can put up, with what applies
    // it and how often that lands. `checkProba(vars.chance)` is the one gate the
    // data states outright, so an applier that rolls for it carries its chance
    // and the simulation either folds it in at its expected rate or rolls it.
    // Several skills can apply the same status - `Rogue_Talent_LethalPoison`
    // puts its poison up on a base-attack roll, and three other talents put the
    // same poison up unconditionally. Keeping whichever was seen first meant a
    // status could be attributed to the one applier the model cannot price and
    // then reported as unmodelled, while a perfectly priceable applier for it
    // sat in the rotation. So every applier is collected and the best one is
    // chosen at the end, once it is known which skills the fight can fire.
    const noteDots = (id, st, extra = {}) => {
      for (const d of st.dots ?? []) {
        dots.push({
          ...d,
          on: d.trigger?.on ?? 'cast',
          chance: d.trigger?.chance ?? 1,
          why: d.trigger?.why ?? null,
          source: extra.source ?? null,
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
    const noteGains = (id) => {
      for (const g of resourceGainsOf(id, { rank, runes, talents })) gains.push(g);
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
      for (const id of Object.keys(loadout.talents ?? {})) noteGains(id);
    }
    // A pool is tracked when something declares income for it AND the sheet
    // gives it a cap.
    //
    // The Rogue's Combo Points were unreadable from data - the award lives
    // inside a helper and the spend is `-getCp()` - but the bytecode reads
    // clean now: `Rogue_ComboPoints.tryGetComboPoint@44698` grants +1 per
    // distinct weapon skill or combo finisher (first damaging hit only), and
    // the signature finisher adds +0.3 dmgMult per point and consumes them
    // all. Modelled as +1 per weapon-skill cast and per finisher - the
    // consecutive-same-skill dedup is not carried, which flatters a build
    // that spams one skill - with the spend attached below.
    if (loadout.class === 'Rogue') {
      gains.push({
        atb: 'ComboPoint', amount: 1, on: ['weapon-skill', 'combo'],
        from: 'Rogue_ComboPoints', fromName: 'Combo Points',
        why: 'read from tryGetComboPoint@44698: +1 per distinct weapon skill or combo finisher',
      });
    }
    const tracked = new Set(gains.map((g) => g.atb));

    const push = (bucket, id, extra = {}) => {
      if (seen.has(id)) return;
      seen.add(id);
      const prof = profileOf(id);
      if (!prof) return;
      if (outOfCombatOnly(prof)) return;
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
          return;
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
    // The chain in SLOT ORDER, filled against the authored `moveSet.comboLength`
    // where the item row omits a link. Iterating `main.skills` in declaration
    // order happened to produce the right order on every weapon in this build,
    // which is not the same thing as producing it on purpose.
    const chain = baseChain(main);
    if (main) {
      for (const id of chain.links) push(filler, id, { source: 'Slot_Weapon1' });
      for (const id of main.skills) {
        if (typeOf(id) === 'WeaponPassive') pushTriggered(id, 'Slot_Weapon1');
      }
      // Still shorter than its moveSet says, and nothing in the sheet fills the
      // gap. Say so: the combo lands more often than it should and everything
      // gated on the finisher is overstated.
      if (chain.short) {
        unmodelled.push({
          id: main.id, name: main.name, source: 'Slot_Weapon1', kind: 'chain',
          why: `its moveSet ${chain.moveSet} declares a ${chain.want}-hit chain but only `
            + `${chain.links.length} link${chain.links.length === 1 ? '' : 's'} can be found, so the combo `
            + 'finisher - and everything that rolls off it - lands more often here than in game',
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
    for (const p of pools(loadout)) {
      // A mechanic pool with more slots than options CYCLES: the third
      // conduit slot repeats the first option, which is exactly Emsay's live
      // fill (Projectile x2 + Power, proven by the paired trigger rows).
      const dflt = p.kind === 'mechanic' && p.slots > p.options.length
        ? Array.from({ length: p.slots }, (_, i) => p.options[i % p.options.length])
        : p.options.slice(0, p.slots);
      const chosen = (sel[p.key] ?? dflt).slice(0, p.slots);
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
    const classPool = pools(loadout).find((p) => p.key === 'class/ClassSkill');
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
    for (const slot of cat.combatSlots()) {
      const g = loadout.gear[slot.id];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      // The block family is EXCLUSIVE: a hero has one block slot and the
      // shield's wins (Hero.refreshSkills@7364 fills one slot per skill kind,
      // first match, and the capture shows exactly one BlockMitigation affix
      // per character - always the shield's when one is worn). The model used
      // to grant a weapon's PhysicalBlock AND the shield's ShieldBlock and
      // read 110 against the game's 60. The weapon's copy arrives BOTH ways -
      // GA_Craft lists PhysicalBlock in its own item.skills and the GreatAxe
      // itemType inherits it too - so the skip guards both loops. Dual
      // same-class weapons were only ever safe because `seen` deduped.
      const hasShield = Object.values(loadout.gear ?? {}).some((x) => {
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
      // The itemType's shared moves (each weapon class's block).
      for (const s of cat.inherited(item?.type, (t) => t?.skills) ?? []) {
        const id = s.skill ?? s.ref;
        if (!id || seen.has(id) || INERT_TYPES.has(typeOf(id))) continue;
        if (blockShadowed(id)) continue;
        pushTriggered(id, slot.id);
      }
    }
    for (const sock of cat.socketsFor ? socketList(loadout) : []) {
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
      // puts +5 CritChance on the wielder and every ally in range for the whole
      // fight. The skill was refused whole and five points of crit went with
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
        if (rule) {
          unmodelled.push({
            id, name: prof.name, source,
            kind: rule.kind === 'never' ? 'gated off' : 'conditional',
            why: rule.why,
          });
          return;
        }
        // A trigger that only fires when you BLOCK or when you are HIT never
        // fires here - the simulated foe does not attack - and that is a
        // statement about the fight model, not about the data.
        const defGated = !!skills.get(id)?.script
          && /GameBeat\.AttackBlock|onReceiveDamage|onReceiveHit/.test(String(skills.get(id).script));
        if (defGated) {
          unmodelled.push({
            id, name: prof.name, source, kind: 'foe is passive',
            why: 'it fires when you block or when you are hit, and the simulated foe never attacks - '
              + 'real in game, correctly worth zero here' + keepAlwaysOn(),
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
          return;
        }
      }
      if (ownAffixes.length || st.self.length || st.dots.length) {
        passive.push({ prof, source, affixes: ownAffixes, buffs: st.self, debuffs: st.onTarget, dots: st.dots, ...extra });
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
      // rider was being read off that very body and applied; the same sentence
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
      const readsRune = (m) => Object.keys(m.props ?? {}).length > 0
        || (s?.steps ?? []).some((x) => x.cond?.mastery === m.id || x.cond?.masteryExclude === m.id)
        || (s?.affixes ?? []).some((a) => a.conds?.mastery === m.id);
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
      const defenceGated = !!s?.script
        && /GameBeat\.AttackBlock|onReceiveDamage|onReceiveHit/.test(String(s.script));
      // ...and a defensive payload is the same sentence again. A shield that
      // absorbs damage nothing deals is worth zero for the same reason a block
      // proc is, and "its payload is a status that declares nothing readable"
      // was simply wrong about it: Halos_Demon_Passive's absorb is 0.7 x
      // Intellect, right there on the status's Refresh step.
      const shieldOnly = !defenceGated && st.all.length > 0 && !st.dots.length
        && st.all.some((id2) => {
          const p2 = combat.profile(id2, rank, runes);
          return !!p2?.effects.some((e) => e.kind === 'Shield' && (e.baseVal || e.scaling.length));
        })
        && !st.all.some((id2) => {
          const p2 = combat.profile(id2, rank, runes);
          return !!p2?.effects.some((e) => e.kind === 'Damage' && (e.baseVal || e.scaling.length));
        });
      const kind = st.unreadable.length ? 'script magnitude'
        : (prof.costs.length || feedsResource || runeFeedsResource) ? 'resource'
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
      if (runePromises.length) {
        const one = runePromises.find((r) => r.slotted) ?? runePromises[0];
        why = (one.slotted ? `you slotted ${one.name}` : `${one.name} is on offer here`)
          + `, and it declares only a description - "${one.desc}"`
          + (runePromises.length > 1 ? ` (and ${runePromises.length - 1} more like it)` : '');
      } else if (st.unreadable.length) {
        why = st.unreadable[0].why;
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
      } else if (prof.hasScript) {
        why = 'everything it does lives in its hscript body, which this model does not execute';
      } else if (st.all.length) {
        why = `applies ${st.all.join(', ')}, which declares nothing this model can read at rank ${rank}`;
      } else if (prof.effects.length) {
        why = 'its only effects are GainAtb or Status rows with no readable payload';
      } else {
        why = 'declares no effect, no affix and no status this model can read';
      }
      unmodelled.push({ id, name: prof.name, source: extra.source, why, kind, runePromises });
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
    // itself puts it up on a base-attack roll, and without this pass the only
    // applier the model saw was a tier-4 node a sigil happened to grant.
    //
    // AT THE TALENT'S OWN RANK. `rank` in this function is the WEAPON mastery
    // rank - 1 to 3, two upgrades per weapon skill - and a talent's rank is the
    // points in that node, 1 or 2. They are disjoint systems: rank gates appear
    // only on WeaponSkill / AttackCombo / WeaponPassive / Talent rows and runes
    // only on ClassSkill / SignatureSkill rows, with no row carrying both. So
    // resolving a talent at the weapon's rank asks a two-point node whether it
    // is at rank 3, and every `minRank: 2` rider on it passes for free.
    for (const [id, nodeRank] of Object.entries(loadout.talents ?? {})) {
      noteDots(id, statusesOf(id, { runes, rank: nodeRank, talents, talentRanks }), { source: 'talent' });
      // A talent-applied STATUS can carry a script of its own, and that script
      // can play damage steps on events the fight raises. Sunlight's status
      // deals 0.6x Faith on every combo finisher while it is worn; Purging
      // Strikes' status deals 0.15x Faith on every swing and finisher. Both
      // fell through every bucket without a word - not a dot (no tick), not a
      // buff (no affix) - which made them the one place the model still
      // dropped damage silently. `profileOf` runs the status through the same
      // scripted-rider reader every skill gets, and parks what it finds for
      // the rider pass below. The uptime assumption - the status is up when
      // the event lands - is the same one every self-applied gate already
      // makes, and the applier is this very talent.
      for (const stId of statusIdsOf(id, { runes, rank: nodeRank, talents, talentRanks })) {
        profileOf(stId, nodeRank);
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
      // getSparkCost@7986 is read, the costs are attached to every weapon skill
      // above, and the fight gates casts on the pool. Listing the mechanism as
      // a skill nobody modelled, while the model is visibly using it, is the
      // output contradicting itself - the same rule that already accounts for
      // Priest_Rosary and Warrior_Rage.
      ...(tracked.has('Spark') ? ['Mage_SparkMaster'] : []),
    ]);

    // A status whose applier has no cast rate and whose script guard names an
    // event this fight does not produce can never land. Saying so beats leaving
    // it in the list looking scored: `Sword_Swarm_Passive_Poison` is applied by
    // the swarm's own ticks hurting something, which is a chain of events one
    // step past what the simulation tracks.
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
    const canFire = (d) => !!d.pool || d.on !== 'cast' || castable.has(d.from);

    // --- steps the cast does not play, on the clock the script gives them ----
    //
    // See `scriptedRiders`. This is where the 0.3-ratio step that the audit
    // called "billed per finisher, not as its 15%-per-attack rider" stops being
    // an assumption: the step is out of the cast, the guard in front of its
    // playStep is read, and the rider goes on the base-attack clock at 15%.
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
      triggered.push({ prof: riderProf(r.prof, r.step, r.rule), source: 'scripted', rule: r.rule });
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
    // multi-source dot: Lethal Poison is fed by the talent (20% per swing or
    // finisher), Envenom (every finisher) and Venom Infusion (25% per weapon
    // skill) SIMULTANEOUSLY - the game pins it at its stack cap, and the model,
    // applying from exactly one channel, averaged a stack and a half of six.
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
            why: `${d.name} ticks are multiplied by its stack count (getStackFactor@20772) and its `
              + 'maxStacks is the authored -1, i.e. uncapped - so how many stacks a fight reaches is '
              + 'the fight length, not the data. Scored at one stack, which is a floor',
          });
        }
        liveDots.push(d);
        continue;
      }
      // Same split as the trigger path: an applier that fires on a block or
      // on being hit is dead because the foe is passive, not because the
      // data withheld a rate.
      const applierScript = skills.get(d.from)?.script;
      const defGated = !!applierScript
        && /GameBeat\.AttackBlock|onReceiveDamage|onReceiveHit/.test(String(applierScript));
      unmodelled.push({
        id: d.status,
        name: d.name,
        source: d.source,
        kind: defGated ? 'foe is passive' : 'no rate',
        why: defGated
          ? `${d.fromName} applies it on a block or on being hit, and the simulated foe never attacks`
          : `${d.fromName} applies it, but nothing gives ${d.from} a rate this model can price`,
      });
    }

    // --- summons, and the charge economy they feed ---------------------------
    //
    // Staff_SummonDemon_Skill2 is a SUMMONER: step type 23 with props.summon
    // {unit: Summon_Imp, count: 2}, duration 12 - and it sat in unmodelled as
    // "everything it does lives in its hscript body" while its imps swung
    // every ~3.2s for 0.2 x the OWNER's Intellect (live: 35.3 hits/min at
    // 41.7, the same law as the owner's own missiles to within 0.3%). Its
    // partner Skill1 is a CHARGE DUMP: one missile per banked charge (cap =
    // the Charge status's maxStacks, 20), fed +1 per pet hit
    // (onInflictDamage: sourceUnit != owner), +1 per vars.time seconds of
    // combat at rank >= 2 (onRegUpdate), and 20% per summon expiry - live
    // 14.9 hits per press against the model's one. Both are authored; the
    // reader hands the fight the spec and the fight schedules it.
    const summons = [];
    const summonSpecOf = (id) => {
      const row = skills.get(id);
      const st = (row?.steps ?? []).find((x) => x.props?.summon?.unit);
      if (!st) return null;
      const unitId = st.props.summon.unit;
      const unitRow = cdb.byId('unit').get(unitId);
      const autoId = (unitRow?.skills ?? []).map((x) => x.skill ?? x.ref ?? x).find(Boolean);
      const auto = autoId ? profileOf(autoId) : null;
      if (!auto || !(auto.effects ?? []).some((e) => e.kind === 'Damage')) return null;
      // The pet's swing period from its own authored steps: every step's
      // delay + duration, summed - cast 0.3 + 2.2 and recovery 1.3 for the
      // imp, 3.8s authored against a measured 3.23s (the recovery overlaps
      // partially live; the authored number is kept, conservative and cited).
      const period = (cdb.byId('skill').get(autoId)?.steps ?? [])
        .reduce((s2, x) => s2 + (Number(x.delay) || 0) + (Number(x.duration) > 0 ? Number(x.duration) : 0), 0) || 3.8;
      const dur = Number(row.duration) || row.vars?.dur1 || 12;
      // onSummonElapsed -> checkProba(vars.chance) -> a charge, per expiry.
      const body = liveScript(row.script ?? '');
      const el = /onSummonElapsed[\s\S]{0,160}?checkProba\s*\(\s*vars\.(\w+)\s*\)/.exec(body);
      return {
        from: id, unit: unitId, count: st.props.summon.count ?? 1,
        duration: dur, period, petProf: auto,
        elapsedChargeChance: el ? (row.vars?.[el[1]] ?? 0) : 0,
      };
    };
    // A summoner that fell into unmodelled earns its slot back: its worth is
    // its pets', which the fight now schedules.
    for (let i = unmodelled.length - 1; i >= 0; i--) {
      const spec = summonSpecOf(unmodelled[i].id);
      if (!spec) continue;
      const prof = profileOf(unmodelled[i].id);
      if (!prof) continue;
      unmodelled.splice(i, 1);
      active.push({ prof, source: 'class', applies: { self: [], target: [] } });
      summons.push(spec);
    }
    for (const a of active) {
      if (summons.some((sp) => sp.from === a.prof.id)) continue;
      const spec = summonSpecOf(a.prof.id);
      if (spec) summons.push(spec);
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
      const petFed = /onInflictDamage[\s\S]{0,160}?sourceUnit\s*!=\s*owner[\s\S]{0,120}?addStatus\s*\(\s*owner\s*,/.test(body);
      const tm = /onRegUpdate[\s\S]{0,300}?rank\s*>=\s*(\d+)[\s\S]{0,300}?vars\.(\w+)/.exec(body);
      const timerPeriod = tm && rank >= Number(tm[1]) ? row.vars?.[tm[2]] ?? null : null;
      chargeDump = { skill: a.prof.id, status: statusId, cap, petFed, timerPeriod };
      break;
    }

    // The NEXT-WEAPON-SKILL register: Demondash's finisher (onHit, rank >= 3)
    // puts a status on the owner whose whole script is `isWeaponSkill() ->
    // dmgMult += vars.damage; stop()` - +25% on the next weapon-skill hit,
    // consumed. The conditional-buff refusal correctly keeps it off the
    // sheet; the FIGHT arms it per finisher and spends it on the next
    // weapon-skill cast, which is what live shows (8 of 23 Demondash_Skill1
    // hits at the +25% plateau).
    let wsRider = null;
    for (const x of filler) {
      if (!x.prof.isCombo) continue;
      const body = liveScript(skills.get(x.prof.id)?.script ?? '');
      const add = /addStatus\s*\(\s*owner\s*,\s*(?:Skill\.)?(\w+)/.exec(body);
      if (!add) continue;
      const gate = /rank\s*>=\s*(\d+)/.exec(body.slice(0, add.index));
      if (gate && rank < Number(gate[1])) continue;
      const row = skills.get(add[1]);
      const m = /onInflictDamageEval[\s\S]{0,200}?isWeaponSkill\s*\(\s*\)[\s\S]{0,160}?dmgMult\s*\+=\s*vars\.(\w+)[\s\S]{0,100}?stop\s*\(\s*\)/
        .exec(liveScript(row?.script ?? ''));
      const v = m ? row.vars?.[m[1]] : null;
      if (typeof v === 'number' && v > 0) { wsRider = { amount: v, status: add[1] }; break; }
    }

    // Costs the data does not declare, read from the bytecode instead.
    // Mage: `Skill.getSparkCost@7986` - a weapon skill costs
    // round(max(Mage_Spark_SpellMinCost, cooldown x Mage_Spark_SpellCDCostRatio)),
    // spent by Mage_SparkMaster.onPreSkillProc on weapon skills and final
    // attacks. The finisher's own 10-Spark cost is NOT gated here - the chain
    // is not pool-gated in the fight - which flatters a Spark-starved build
    // slightly and is on record rather than hidden.
    // Rogue: the signature finisher consumes all Combo Points for +0.3 dmgMult
    // each (script.skills.Rogue_Sig_Finisher.onStep@44709); modelled at a
    // full-cap spend - comboPointCap() reads the cap off the rows (6 with the
    // Combo Ruler mastery's State, see its docstring), and the live capture
    // quantizes at exactly that spend. The 4 this used to hardcode was the
    // unit row's base, two affixes short, and read the finisher 19% low.
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
        a.prof = { ...a.prof, costs: [...(a.prof.costs ?? []), { atb: 'Spark', amount }] };
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
      // onConduitTriggers - raised once per trigger EVENT, not per conduit
      // (triggerAllConduits@29170) - and returns vars.var1 Spark at
      // vars.chance. Carried as its expectation on the gauge.
      let residues = 0;
      for (const tid of Object.keys(loadout.talents ?? {})) {
        const tb = liveScript(skills.get(tid)?.script ?? '');
        const m = /function\s+onConduitTriggers[\s\S]{0,200}?checkProba\s*\(\s*vars\.(\w+)\s*\)[\s\S]{0,120}?addResource\s*\(\s*Attribute\.Spark\s*,\s*vars\.(\w+)/.exec(tb);
        if (!m) continue;
        const ch = skills.get(tid)?.vars?.[m[1]];
        const amt = skills.get(tid)?.vars?.[m[2]];
        if (typeof ch === 'number' && typeof amt === 'number') residues += ch * amt;
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
          costs: [...(a.prof.costs ?? []), { atb: 'ComboPoint', amount: cap }],
          runeDamage: [...(a.prof.runeDamage ?? []), { amount: cap * per }],
        };
      }
      // The Combo Ruler State's +1 is on no sheet, so the pool's cap cannot
      // come from the sheet alone - the fight takes the larger of the two.
      poolCapOverride = { ComboPoint: cap };
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
    const CD_MUT = /\b(resetCooldown|reduceCooldown)\s*\(\s*(?:Skill\.([A-Za-z0-9_]+)|skill\.kind)\s*(?:,\s*vars\.([A-Za-z0-9_]+))?\s*\)/g;
    const activeIds = new Set(active.map((a) => a.prof.id));
    const KNOWN_HOOKS = /^on(Damage|DamageEval|InflictDamage|InflictHit|InflictDamageEval|FirstHit|Hit)$/;
    for (const hostId of seen) {
      const hs = skills.get(hostId);
      if (!hs?.script) continue;
      const body = liveScript(hs.script);
      CD_MUT.lastIndex = 0;
      for (let m; (m = CD_MUT.exec(body));) {
        const [, call, named, secVar] = m;
        const targetId = named ?? hostId;            // skill.kind = the host itself
        if (!activeIds.has(targetId)) continue;      // mutating a skill not in this build
        const seconds = call === 'reduceCooldown' ? hs.vars?.[secVar] : null;
        if (call === 'reduceCooldown' && !(typeof seconds === 'number' && seconds > 0)) continue;
        const before = body.slice(0, m.index);
        const hookAt = before.lastIndexOf('function on');
        const hook = hookAt >= 0 ? /function\s+(on[A-Za-z0-9_]*)/.exec(before.slice(hookAt))?.[1] ?? null : null;
        const scope = enclosingBlock(before);
        const targetName = skills.get(targetId)?.texts?.name ?? targetId;
        if (!hook || !KNOWN_HOOKS.test(hook)) {
          // NAME WHO LOSES OUT, and say the host is fine. This entry is filed
          // under the skill whose SCRIPT carries the call, which reads as "this
          // skill is not scored" - and Rampage is scored, every cast of it. What
          // is missing is a cooldown Shockwave never gets back. A reader
          // checking why Rampage looked low was being pointed at the wrong
          // skill entirely.
          const hostName = hs.texts?.name ?? hostId;
          unmodelled.push({
            id: hostId, name: hostName, kind: 'conditional',
            why: `${hostName}'s own damage IS scored; what is not is the cooldown it gives `
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
        // script's own alias table, stripped from the guard, and the
        // mark-always-up reading is an assumption this comment owns.
        let scope2 = scope;
        const markSuppliers = new Set();
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
            if (markSuppliers.size) scope2 = scope2.replace(hm[0], ' ');
          }
        }
        const g = guardOf(scope2, { rank, runes, talents });
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
        if (cv && typeof hs.vars?.[cv] === 'number') chance = hs.vars[cv];
        const critGated = /\bcritical\b|\bisCrit\b/.test(scope);
        // Which event carries it: the host's own landing when the hook is
        // per-skill or the guard names the host's own skillId; otherwise the
        // events the guard states.
        const ownHit = /^on(Damage|DamageEval|FirstHit|Hit)$/.test(hook)
          || new RegExp(`skillId\\s*==\\s*Skill\\.${hostId}`).test(scope);
        const ev = eventsOf(scope);
        if (!ownHit && !ev.size) continue;            // no producible event stated
        cdMutations.push({
          host: hostId, target: targetId,
          on: ownHit ? 'host' : ev.has('combo') && ev.has('attack') ? 'attack-or-combo'
            : ev.has('combo') ? 'combo' : ev.has('attack') ? 'attack' : 'weapon-skill',
          // The reset SPENDS a mark another skill supplies, so the fight banks
          // one per supplier cast and each reset consumes one - "the mark is
          // always up" briefly stood here unbanked, and the sim promptly
          // pressed the dash at three times the rate its marks could arrive.
          supply: markSuppliers.size ? [...markSuppliers] : null,
          chance, critGated,
          kind: call === 'resetCooldown' ? 'reset' : 'reduce',
          seconds: seconds ?? 0,
          why: `${hs.texts?.name ?? hostId} ${call === 'resetCooldown' ? 'resets' : `gives back ${seconds}s of`} `
            + `${targetName}'s cooldown`
            + (critGated ? ' on a critical strike' : '')
            + (chance < 1 ? `, ${Math.round(chance * 100)}% of the time` : ''),
        });
      }
    }

    return {
      filler, active, triggered, passive, dots: liveDots,
      // `accountedLate` is filled by passes that run after `accounted` is
      // built, so it is applied here rather than folded in above.
      unmodelled: unmodelled.filter((u) => !accounted.has(u.id) && !accountedLate.has(u.id)),
      selection: sel, runes: [...runes], rank, chain, cdMutations, sparkGauge,
      resources: { gains, tracked: [...tracked], capOverride: poolCapOverride },
      summons,
      chargeDump,
      wsRider,
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
  // against a live capture, skills declaring it carried 35.6% of a Rogue's
  // damage - Daggers_DuplicatePoison_Skill1 alone was 24.9%, priced by this
  // model at eighteen hits where the game recorded two thousand eight hundred,
  // because the hook that produces them was never an event this reader
  // believed in. It fires when a status the owner applied deals damage, which
  // is a tick, and the fight already raises one of those.
  const RIDER_HOOKS = /^on(InflictHit|InflictDamage|InflictDamageEval|InflictStatusEval|Damage|DamageEval|FirstHit|Hit|Start|CastEnd|AreaElapsed|StartConduit)$/;
  const OWN_CAST_HOOKS = /^on(Damage|DamageEval|FirstHit|Hit|Start|CastEnd|AreaElapsed|StartConduit)$/;

  function scriptedRiders(skillId, prof, opts = {}) {
    const riders = [];
    const refused = [];
    if (!prof?.scripted?.length) return { riders, refused };
    const s = skills.get(skillId);
    const body = liveScript(s?.script ?? '');
    const name = prof.name;

    for (const step of prof.scripted) {
      const label = `${name}'s ${step.stepId ?? 'unnamed'} step`;
      if (!step.stepId) {
        refused.push({ step: null, why: `${label} is played only from script and carries no id, so no playStep call can name it` });
        continue;
      }
      const re = new RegExp(`\\bplayStep\\s*\\(\\s*Steps\\.${step.stepId}\\b`, 'g');
      let rule = null;
      let why = null;
      // The gate is a fact about THIS build - a rank the weapon has not reached
      // or a rune it did not slot - rather than a hole in the model, so it is
      // reported under its own cause.
      let gated = false;
      for (let m; (m = re.exec(body)) && !rule;) {
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
          why ??= `${label} is played from a ${hook ?? 'top-level'} hook, which is an event this fight does not produce`;
          continue;
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
        // is a filter the fight can honour, not a question about live state:
        // Virulent Magic rides the ticks of Lethal Poison specifically.
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
        let chance = 1;
        const cp = /checkProba\s*\(\s*(?:vars\.([A-Za-z0-9_]+)|(\d*\.?\d+))\s*\)/.exec(scope);
        if (cp) {
          const n = cp[1] ? s?.vars?.[cp[1]] : Number(cp[2]);
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
        if (onDotTick) {
          const held = selfHeld ? `, while ${selfHeld} is on the target - which this skill applies itself, and which the model assumes is up whenever a tick lands` : '';
          const capped = maxStacked ? `, once ${maxStacked} is fully stacked - assumed held for the whole fight, so the ramp before the cap is credited as if it fired` : '';
          const which = dotStatus ? `every tick of ${dotStatus}` : bleedOnly ? 'every tick of a bleed' : 'every tick of a damage-over-time';
          rule = {
            kind: 'per-dot-tick', chance, critGated, bleedOnly,
            status: dotStatus,
            why: `${label} is played on ${which}${crit}${roll}${held}${capped}`,
          };
        } else if (ev.has('attack') && ev.has('combo')) {
          rule = { kind: 'per-attack-or-combo', chance, critGated, why: `${label} is played on a base attack or a combo finisher${crit}${roll}` };
        } else if (ev.has('combo')) {
          rule = { kind: 'per-combo', chance, divisor: 1, critGated, why: `${label} is played on the combo finisher${crit}${roll}` };
        } else if (ev.has('attack')) {
          rule = { kind: 'per-attack', chance, critGated, why: `${label} is played on a base attack${crit}${roll}` };
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
            const lv = lm ? s?.vars?.[lm[1]] : null;
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
        // `hit.target != ctx.aimTarget` on the playStep site: the step lands
        // only on targets OTHER than the one aimed at - zero of them against
        // a lone dummy. RayOfSpark's M2 splash is the shape, and the model
        // was crediting it a full hit per cast on a single target, which is
        // half of why that row read +89.6% per hit.
        if (rule && /\btarget\s*!=\s*(?:ctx\.)?aimTarget\b/.test(scope)) rule.notAimTarget = true;
        // A step played AT A POSITION - playStep(Steps.X, null, pos) - is
        // anchored to the ground, not to the aim target, so an authored
        // ignoreMainTarget on its area does NOT exclude the target standing
        // there: Demondash Skill2's AOE hit the lone dummy 10 times in 28
        // projectile hits while the model zeroed it.
        if (rule && new RegExp('playStep\\s*\\(\\s*Steps\\.' + step.stepId + '\\s*,\\s*null\\s*,').test(body)) {
          rule.atPosition = true;
        }
      }
      if (rule) riders.push({ step, rule });
      else {
        refused.push({
          step: step.stepId,
          kind: gated ? 'gated off' : 'no rate',
          why: why ?? `${label} is played only from script, and nothing in the row says when`,
        });
      }
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
    const has = (list) => (list ?? []).some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind));
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

    // Prayers charge on the combo's final attack (Priest_Rosary's script, and
    // each prayer's own description), and the slotted ones take turns.
    if (extra.mechanic === 'PriestPrayer') {
      return {
        kind: 'per-combo',
        chance: 1,
        divisor: Math.max(1, extra.sharedWith ?? 1),
        why: 'Priest_Rosary charges a prayer on the combo\'s final attack; slotted prayers cycle',
        // The mechanism IS Priest_Rosary, so it must not also be reported as an
        // ability nobody modelled.
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
        return {
          kind: ev.has('combo') ? 'per-combo' : 'per-attack',
          chance: 1, divisor: 1, cooldownGate: prof.cooldown,
          why: `its script fires on the first ${[...ev].join('/')} each ${prof.cooldown}s (consumeCooldown)`,
        };
      }
    }

    // `vars.chance` is the proc rate the data ships. WHAT it rolls against is
    // in the script's own guard, and the two are not the same rate: a combo
    // finisher lands about a third as often as a swing does, so reading every
    // proc as per-attack overstated `Enchant_Lifestealing` threefold. The guard
    // is one line and it is worth reading rather than assuming.
    const chance = s?.vars?.chance;
    if (typeof chance === 'number' && chance > 0) {
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
      if (/isFinalCombo|isFinalAttack|isComboAttack/.test(script)) {
        return {
          kind: 'per-combo', chance, divisor: 1,
          why: `vars.chance = ${chance}, and its script gates on the combo finisher${reapplyNote}`,
        };
      }
      return { kind: 'per-attack', chance, why: `vars.chance = ${chance} on a base-attack proc${reapplyNote}` };
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
   * getAffixModVal@20794 says HOW: op 0 multiplies the authored val by the
   * dynVal, op 1 replaces it - those are refused, the authored number means
   * nothing on its own. Op 2 ADDS, and a fresh instance reads dynVal 0, so the
   * authored val is a floor: `Priest_Crusader_Status`'s +10 CritChance is live
   * for the whole 20s press even with zero growth. The floor is credited at
   * one stack (its maxStacks 300 is the growth channel, and crediting it at
   * cap would hand the build +3000 crit); the addDynVal growth stays refused.
   */
  const statusCache = new Map();
  function statusesOf(skillId, { runes = null, rank = 1, talents = null, talentRanks = null } = {}) {
    // The talents belong in the key as much as the runes do: a call site guarded
    // by `hasTalent(X)` resolves differently for a build that took X.
    const key = skillId + '#' + rank
      + (runes?.size ? '@' + [...runes].sort().join('+') : '')
      + (talents?.size ? '%' + [...talents].sort().join('+') : '')
      // The RANK of an allocated talent, not just its presence: one status cap
      // is `base + getTalentRank(Rogue_Talent_ImprovedMixture)`, so two builds
      // holding the same nodes at different point counts are not the same key.
      + (talentRanks?.size ? '~' + [...talentRanks].sort().map(([k, v]) => k + v).join('+') : '');
    let hit = statusCache.get(key);
    if (hit) return hit;

    const s = skills.get(skillId);
    const found = new Map(); // statusId -> { to, trigger, appliedDuration, scriptMagnitude }
    // Statuses this skill would apply if the build had the thing that arms it.
    // Reported rather than silently dropped: "Hold the Line does nothing here"
    // is a fact about the allocation, and the reason belongs next to it.
    const unmetDeps = [];
    const note = (statusId, to, trigger = { on: 'cast', chance: 1, why: 'applied by the cast itself' },
      appliedDuration = null, scriptMagnitude = false) => {
      if (!statusId || found.has(statusId)) return;
      found.set(statusId, { to, trigger, appliedDuration, scriptMagnitude });
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
      return m ? triggerOf(body.slice(0, m.index), s) : null;
    })();
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
        const to = declared === 0 ? 'Self'
          : declared === 1 ? 'Target'
            : declared === 2 ? 'Group'
              : buffOnly ? 'Self'
                : (on === 'Hit' || on === 'ProjectileHit') ? 'Target' : 'Self';
        // A Status step can also carry the lifetime for a status that declares
        // none of its own - Scepter_Flamie_S2 gives its flame `dur2` = 8s while
        // Scepter_Flamie_P gives the same status -1, i.e. forever.
        note(ref, to, scriptSiteTrigger ?? undefined, st.duration);
      }
      // An effect can carry one too, and that one rides the hit.
      for (const e of st.effects ?? []) if (e.status) note(e.status, 'Target', scriptSiteTrigger ?? undefined);
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
      ADD_STATUS.lastIndex = 0;
      for (let m; (m = ADD_STATUS.exec(live));) {
        const [, who, raw, tail] = m;
        const resolved = skills.get(raw) ? raw : alias.get(raw);
        if (!resolved || !skills.get(resolved)) continue;
        // A script names its recipient, and that name is the answer. `owner` is
        // you; `hit.target`/`dmg.target` is the enemy; a loop variable handing
        // the status to allies is NEITHER.
        //
        // And `hit.target` is not always an enemy either: `GM_MassGrab_Skill2`
        // buffs `hit.target` inside `if (hit.targetUnit.kind == Unit.Summon_Bee)`,
        // so the thing it hit is its own pet. Reading the Buff typing over that
        // guard made the bee's +50% DamageModifier a permanent stat on the
        // character. The guard is right there in the enclosing block.
        const guard = enclosingBlock(live.slice(0, m.index));
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
        const elsewhere = /Unit\.Summon_|targetUnit\.kind|isAlly|onPlayerAllies|getPartyHeroes/.test(guard);
        const to = elsewhere ? 'Elsewhere'
          : SELF_TARGETS.has(who) ? 'Self'
            : ENEMY_TARGETS.has(who) ? 'Target'
              : 'Elsewhere';
        // A third argument is a MAGNITUDE the script computed - a pool DoT
        // bleeding for a share of the hit that applied it. The status row then
        // carries a placeholder, not an amount.
        const magnitudeFromScript = tail === ',';
        note(resolved, to, triggerOf(live.slice(0, m.index), s, g, resolved), null, magnitudeFromScript);
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
    if (s?.script) {
      const ebody = liveScript(s.script);
      const runeVars = (s.mastery ?? []).find((m) => runes?.has(m.id))?.vars ?? null;
      EXTEND_STATUS.lastIndex = 0;
      for (let mm; (mm = EXTEND_STATUS.exec(ebody));) {
        const [, target, expr] = mm;
        const amount = amountOf(expr, s.vars, runeVars);
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
        const judged = scope.replace(/\b(?:critical|isCrit|isPhysical|isMagic)\b/g, ' ');
        const g = guardOf(judged, { rank, runes, talents });
        if (!g.fires || g.unread) continue;
        const hookAt = before.lastIndexOf('function on');
        const hook = hookAt >= 0
          ? /function\s+(on[A-Za-z0-9_]*)/.exec(before.slice(hookAt))?.[1] ?? null : null;
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
          // `dmg.isWeaponSkill` is skill type 7 exactly (isWeaponSkill@6054)
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
    for (const [statusId, { to, trigger, appliedDuration, scriptMagnitude }] of found) {
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
      // Nothing consumed this before, so it was dropped; Domination's whole
      // value is the fraction of the fight this covers.
      if (kinds.has('CrowdControl') || kinds.has('HardCC')) {
        flaggedCC.push({ ...label, duration: st.duration ?? appliedDuration ?? null });
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
        unreadable.push({
          from: skillId, status: statusId, name: st.texts?.name ?? statusId, to, types,
          why: 'its script hands it to an ally or a summon, not to you or to your target',
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
          : (skills.get(skillId)?.vars?.[appliedDuration] ?? null);
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
        unreadable.push({
          from: skillId, status: statusId, name: st.texts?.name ?? statusId, to: wearer, types,
          why: 'its magnitude is the third argument to addStatus, computed by a script from the hit that applied it',
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
          tick: sp.periodic.tick,
          duration: life ?? sp.periodic.duration,
          stacks: Number.isFinite(maxStacksOf(statusId, rank, talentRanks))
            ? maxStacksOf(statusId, rank, talentRanks) : 1,
          // WHETHER A TICK IS MULTIPLIED BY THE STACK COUNT, which is the whole
          // of the stack channel on the damage side and was missing entirely.
          //
          // `$HSkill.getStackFactor@20772` runs as the LAST line of
          // `getStepEffectVal@20775` - after the scaling, after the spread
          // division, after the damage variance - and multiplies the value by
          // `Status.stacks` when the running skill is a Status that is EITHER a
          // DoT (its statusType, or an ancestor of it, carries the DoT flag) OR
          // carries the `ScaleWithStacks` effect flag. It is an OR evaluated
          // once, so a status that is both - Daggers_Demondash_Passive_Status is
          // typed Burn AND flagged - is multiplied exactly once.
          //
          // Lethal Poison is the size of the gap: five stacks of it were being
          // priced as one.
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
          const amount = amountOf(mm[2], st.vars);
          if (amount == null || amount <= 0) continue;
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
      const affixes = (st.affixes ?? []).filter((a) => a.target?.attribute
        && !(a.conds?.minRank != null && rank < a.conds.minRank)
        && !(a.conds?.maxRank != null && rank > a.conds.maxRank)
        && !(a.conds?.equalRank != null && rank !== a.conds.equalRank)
        && !(a.conds?.mastery && !runes?.has(a.conds.mastery))
        && !(a.conds?.masteryExclude && runes?.has(a.conds.masteryExclude)))
        .concat(scripted);
      // A scripted multiplier is a real number, so it does not make the status
      // "dynamic" the way a mod.dynVal does.
      //
      // And a dynVal does not always erase the authored value: the game's
      // getAffixModVal@20794 switches on the mod's op - op 0 MULTIPLIES the
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
        // off `getMaxStacks@14459` rather than off a bare `?? 1`, so a row
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
        duration: st.duration ?? null,
        // Time this build's own script adds back while the status runs, per
        // event. `engine.mjs` turns it into an effective duration; it stays a
        // rate here because the rate is the fight's business, not the sheet's.
        extend: extendPer.get(statusId) ?? null,
        types,
        to: wearer,
        affixes,
        trigger,
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
      {
        const stRow = skills.get(statusId);
        const sc = liveScript(stRow?.script ?? '');
        const recv = /function\s+onReceiveDamageEval[\s\S]*?\bdmgMult\s*\+=\s*vars\.([A-Za-z0-9_]+)/.exec(sc);
        const instigatorGated = /sourceObject\s*==\s*status\.instigator/.test(sc);
        const v = recv ? stRow?.vars?.[recv[1]] : null;
        if (recv && instigatorGated && typeof v === 'number' && v > 0 && wearer !== 'Self') {
          onTarget.push({ ...entry, scriptTaken: v });
          continue;
        }
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
          ...entry,
          why: `its script applies it only while ${trigger.unread}() holds, which this reader cannot evaluate`,
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
    };
    statusCache.set(key, hit);
    // The key carries the talents set, so a long talent search mints entries
    // without bound. Evicting the oldest costs a re-read, never correctness.
    if (statusCache.size > 20000) statusCache.delete(statusCache.keys().next().value);
    return hit;
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
    // `hit.skillId == Skill.X` where X is the class's signature finisher IS
    // the combo event by another name - Acidic Splatter gates on
    // Rogue_Sig_Finisher and isFirstHit, which is once per finisher, i.e.
    // exactly the event the fight already raises per combo.
    const sigGate = /\bskillId\s*==\s*(?:Skill\.)?([A-Za-z0-9_]+)/.exec(scope)?.[1] ?? null;
    const sigCombo = sigGate != null && typeOf(sigGate) === 'SignatureSkill';
    const combo = sigCombo || /isFinalCombo|isFinalAttack|isComboAttack/.test(scope);
    const attack = /isBaseAttack|isBasicAttack/.test(scope);
    // `checkProba(vars.X * cp)` where cp was read off the ComboPoint pool: the
    // roll scales with the points the finisher spends. Priced at the CAP, with
    // the assumption stated - a finisher build presses at full points, and at
    // 0.2 x 4 the roll is 80%.
    if (/checkProba\s*\(\s*vars\.[A-Za-z0-9_]+\s*\*\s*\w+/.test(scope) && /ComboPoint/.test(scope)) {
      const v = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope)?.[1];
      const n = v ? skill?.vars?.[v] : null;
      if (typeof n === 'number' && n > 0) {
        chance = Math.min(1, n * comboPointCap(cdb));
      }
    }
    let on = 'cast';
    let why = `${hook ?? 'its script'} applies it`;
    // Both, when the guard is an OR of the two. `Rogue_Talent_LethalPoison`
    // reads `(dmg.isBaseAttack || dmg.isFinalCombo) && checkProba(vars.chance)`,
    // and taking only the combo branch would cost it two thirds of its uptime.
    if (combo && attack) { on = 'attack-or-combo'; why = 'on a base attack or a combo finisher'; }
    else if (combo) { on = 'combo'; why = 'on the combo finisher'; }
    else if (attack) { on = 'attack'; why = 'on a base attack'; }
    else if (/isWeaponSkill/.test(scope)) { on = 'weapon-skill'; why = 'on every weapon skill you press'; }
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
      on = 'attack-or-combo';
      why = 'on every damage instance - floored to the swing and finisher clock';
    }
    if (chance < 1) why += `, ${Math.round(chance * 100)}% of the time`;
    // A condition on live state sits on top of the event and the roll, and it
    // can only make the status land LESS often than this says. Carrying the
    // flag lets the caller say so instead of quietly presenting a ceiling as a
    // rate - `DM_Multispin_Passive` needs its own buff max-stacked first.
    let unread = guard?.unread ?? (UNREAD_COND.exec(scope) ?? [null])[1] ?? null;
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
      unread = (UNREAD_COND.exec(scope.replace(
        new RegExp(`!\\s*(?:\\w+\\.)?hasStatus\\s*\\(\\s*(?:[\\w.]+\\s*,\\s*)?(?:Skill\\.)?${appliedId}\\s*\\)`), ' '),
      ) ?? [null])[1] ?? null;
      reapply = 'blocked';
    }
    if (unread) why += `, and only while ${unread}() holds - which this reader cannot evaluate`;
    else if (reapply === 'blocked') why += ', and not again until it has run out';
    return { on, chance, why, hook, unread, reapply };
  }

  /**
   * Which of the events the fight already counts a guard names. Unlike
   * `triggerOf`, which has to pick ONE bucket, this returns all of them:
   * `Warrior_Rage` guards on `isBaseAttack || isFinalCombo || isWeaponSkill`
   * and collapsing that to a single event loses two thirds of the income.
   */
  function eventsOf(scope) {
    const ev = new Set();
    if (/isBaseAttack|isBasicAttack/.test(scope)) ev.add('attack');
    if (/isFinalCombo|isFinalAttack|isComboAttack/.test(scope)) ev.add('combo');
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
          atb: e.atb, amount: e.baseVal, on: 'time', every: periodic,
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
        const amount = amountOf(expr, s.vars, runeVars);
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
          const n = v ? s.vars?.[v] : null;
          if (typeof n === 'number' && n > 0 && n <= 1) chance = n;
        }
        out.push({
          atb, amount, chance,
          critGated, affinity,
          // A crit-gated gain rides every damaging event, not just the ones the
          // guard happens to name - a crit is a property of the hit, not of
          // which button produced it.
          on: ev.size ? [...ev] : critGated ? ['attack', 'combo', 'weapon-skill'] : ['cast'],
          // `!isSignature()` is the rule that stops the Warrior's own Rage
          // spender from paying for itself.
          excludeSignature: /isSignature/.test(scope),
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
   * RANK SCALES THEM LINEARLY. The scripts read `vars.X` without mentioning
   * rank, which taken literally would make the second point in a two-point node
   * buy nothing. Every two-point node in the same tree whose value IS readable
   * from columns scales exactly linearly - Fighting Spirit 2 -> 4 CritChance,
   * Rash Soul 3 -> 6 CooldownReduction, Zealous Warrior 2 -> 4 Fervor, Hold the
   * Line 3% -> 6% - so linear is what the tree does everywhere it can be
   * checked, and a node that gives nothing for a point you are allowed to spend
   * is not a reading worth preferring.
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
      const read = combat.profile(skillId, rank, runes ?? undefined)?.runeDamage ?? [];
      const look = (re, field) => {
        re.lastIndex = 0;
        for (let m; (m = re.exec(body));) {
          const name = field === 'cooldown' ? m[1] : m[2];
          const amount = vars?.[name];
          if (typeof amount !== 'number' || amount === 0) continue;
          if (field !== 'cooldown'
            && read.some((r) => r.field === m[1] && Math.abs(r.amount - amount) < 1e-9)) continue;
          const guard = enclosingBlock(body.slice(0, m.index));
          if (scopeOf(guard, asTalent ? null : rank)) continue;   // read, not a gap
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
          });
        }
      };
      look(/reduce(?:Weapons)?Cooldown\s*\(\s*vars\.([A-Za-z0-9_]+)\s*(?:,\s*[\w.?]+\s*)?\)/g, 'cooldown');
      look(new RegExp(DMG_FIELD.source, 'g'), 'damage');
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
        const amount = s.vars?.[m[1]];
        if (typeof amount !== 'number' || amount <= 0) continue;
        const sc = scopeOf(enclosingBlock(body.slice(0, m.index)), asTalent ? null : rank);
        if (!sc) continue;
        const { scope, statusType = null, targetBleeding } = sc;
        out.push({
          field: 'healShare', scope, statusType, targetBleeding,
          amount: amount * (asTalent ? rank : 1), from: skillId, name: s.texts?.name ?? skillId,
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
        const seconds = s.vars?.[m[1]];
        if (typeof seconds !== 'number' || seconds <= 0) continue;
        const scope0 = enclosingBlock(body.slice(0, m.index));
        const sc0 = scopeOf(scope0, asTalent ? null : rank);
        if (!sc0) continue;
        let chance = 1;
        const cv = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope0)?.[1];
        if (cv && typeof s.vars?.[cv] === 'number') chance = s.vars[cv];
        out.push({
          field: 'cooldownPerTick', scope: sc0.scope, statusType: sc0.statusType ?? null,
          targetBleeding: sc0.targetBleeding,
          amount: seconds * chance * (asTalent ? rank : 1), from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      DMG_FIELD.lastIndex = 0;
      for (let m; (m = DMG_FIELD.exec(body));) {
        const amount = s.vars?.[m[2]];
        if (typeof amount !== 'number' || amount === 0) continue;
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
          amount: amount * (asTalent ? rank : 1),
          from: skillId,
          name: s.texts?.name ?? skillId,
        });
      }
      // Two more authored guard shapes, each carried at the value the
      // rankOverride RESTATES rather than the times-rank heuristic - both
      // rows restate (Authority 0.1 -> 0.2 at rank 2, Radiance 0.12 -> 0.25),
      // and 0.12 x 2 is not 0.25.
      const varAtRank = (key) => {
        let v = s.vars?.[key];
        for (const ov of (s.props?.rankOverride ?? []).slice()
          .sort((a, b) => (a.minRank ?? 0) - (b.minRank ?? 0))) {
          if ((ov.minRank ?? 0) <= rank && ov.vars?.[key] != null) v = ov.vars[key];
        }
        return v;
      };
      // A rider scoped to ONE SKILL by id - Authority is `dmg.skillId ==
      // Skill.Priest_Prayer_Smite -> dmgMult += vars.damage`. Only when the
      // named row is a castable skill: the same guard naming a STATUS is the
      // companion-hook family the dot pipeline reads.
      const ONE_SKILL = /if\s*\(\s*\w+\.skillId\s*==\s*Skill\.(\w+)\s*\)\s*\{\s*\w+\.dmgMult\s*\+=\s*vars\.(\w+)/g;
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
        const amount = st.vars?.[m[2]];
        if (typeof amount !== 'number' || amount === 0) continue;
        const sc = scopeOf(enclosingBlock(sbody.slice(0, m.index)));
        if (!sc) continue;
        const aff = /isPhysical/.test(sbody) ? 'Physical' : /isMagic/.test(sbody) ? 'Magic' : 'all';
        out.push({
          field: m[1], scope: aff === 'all' ? 'all' : aff.toLowerCase(),
          targetBleeding: false, onTarget: true,
          amount: amount * (asTalent ? rank : 1), from: skillId, name: s.texts?.name ?? skillId,
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

  /** Every status id a skill applies, whatever the model could make of it. */
  function statusIdsOf(skillId, opts) {
    return statusesOf(skillId, opts).all;
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
   * Read three ways: `Warrior_Rage_Strike.onInflictDamageEval@44626` ops 20-21
   * set `critChance = 1`; `evalCost@44627` ops 24-28 return 0; `onStop@44624`
   * op 10 removes it. The applier is findex 44666, op 3 `isFinalAttack@6047`
   * (which is `inf.type == 4`, AttackCombo), op 16 `checkProba`, op 29
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
          out.push({ from: id, counter: counterId, cap: cap2, skill: followUp, on: 'timer', period: cap2 * period });
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
        if (r.target === 1 && typeof r.ref === 'string') note(r.ref, id);
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
      }
      empIdCache.set(key, hit);
    }
    return hit;
  }

  function empowermentsOf(ownedIds, { rank = 1, runes = null } = {}) {
    const out = [];
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
    // The COSTLESS register, the second authored shape: the STATUS's own
    // script is the consumer - onUseSkill guards the finisher predicate, adds
    // critChance += 1 to the cast, and consumes itself - and the armer plants
    // it on every MAGE CHAIN CAST (HighVoltage: onMageChainCast ->
    // addStatus(ownerHero, ...Status)). The chain cast has an authored rate
    // of its own: the Chaincast talent counts ACTIVE-skill casts up to
    // vars.var1 and arms the chain, so the register re-arms every var1
    // actives - live, 2-4x faster than finishers are pressed, which is why
    // every recorded finisher volley crits (12 of 12 at 100%). Without the
    // counting talent there is no rate, and the register is not credited.
    for (const id of ownedIds) {
      const body = liveScript(skills.get(id)?.script ?? '');
      if (!body) continue;
      const arm = /function\s+onMageChainCast\s*\([^)]*\)\s*\{[\s\S]*?addStatus\s*\(\s*(?:owner|ownerHero)\s*,\s*(?:Skill\.)?([A-Za-z0-9_]+)/.exec(body);
      if (!arm) continue;
      const sBody = liveScript(skills.get(arm[1])?.script ?? '');
      const consume = /function\s+onUseSkill\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\.(?:baseSkill\.)?(?:isFinalAttack|isFinalCombo)\s*\(\s*\)\s*\)\s*\{\s*\1\.critChance\s*\+?=\s*1\b[\s\S]{0,200}?consumeStatus\s*\(\s*(?:owner|ownerHero)\s*,/.exec(sBody);
      if (!consume) continue;
      let every = null;
      let resetsCooldown = false;
      for (const rid of ownedIds) {
        const rb = liveScript(skills.get(rid)?.script ?? '');
        if (!rb || !/isActiveSkill\s*\(\s*\)/.test(rb) || !/onMageChainCast/.test(rb)) continue;
        const cnt = /<\s*vars\.(\w+)/.exec(rb);
        const n = cnt ? skills.get(rid)?.vars?.[cnt[1]] : null;
        if (typeof n === 'number' && n > 0) {
          every = n;
          // Chaincast's payoff also resets the consuming cast's cooldown a
          // frame later - wait(0, ctx.skill.resetCooldown()) - which live
          // play respends within ~0.5s, the whole reason Censer skills beat
          // their authored cooldowns.
          resetsCooldown = /resetCooldown/.test(rb);
          break;
        }
      }
      if (!(every > 0)) continue;
      // EVERY onMageChainCast consumer that force-fires conduits counts, not
      // only the counting talent: Reverberate's whole payoff is a SECOND
      // full volley 0.4s after Chaincast's - the capture's burst-start gaps
      // cluster at [400,600)ms once per chain, and without the echo the
      // trigger ledger runs 37 events short of the observed 204.
      let conduitVolleys = 0;
      for (const rid of ownedIds) {
        const rb = liveScript(skills.get(rid)?.script ?? '');
        if (!rb || !/onMageChainCast/.test(rb)) continue;
        if (/forceTriggerAllConduits/.test(rb)) conduitVolleys++;
      }
      // The CONSUME is the event, and it is not free of semantics: the chain
      // is spent by the next WEAPON-SKILL press (Mage_SparkMaster's
      // onPreSkillProc, the sole propagateMageChainCast@29172 caller), and
      // that press pays ZERO Spark - ops 81-87 of fn 44855 charge only when
      // !isFree. The sim consumes at the press, waives the Spark, fires the
      // volleys, resets the cooldown, and arms this crit register - all at
      // the same instant the game does.
      out.push({
        status: arm[1], skill: null, from: id, chance: 1,
        on: 'combo', consume: 'combo', armEveryActiveCasts: every,
        firesConduits: conduitVolleys > 0, conduitVolleys,
        chainSpend: { on: 'weapon-skill', freeSpark: true, resetsCooldown },
      });
    }
    return out;
  }

  return {
    pools, defaultSelection, pruneSelection, resolve, selfBuffs, selfBuffsOf, statusesOf,
    weaponSlotsAt, arsenalSlotsAt, typeOf, baseChain, resourceGainsOf, talentModifiers, maxStacksOf,
    empowermentsOf, empowermentIds, scriptGapsOf, stackProcsOf, markProcsOf,
    mechanicTypes: MECHANIC_TYPES,
  };
}
