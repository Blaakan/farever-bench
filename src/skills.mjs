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
const SELF_TARGETS = new Set(['owner', 'hit.source', 'this.owner', 'dmg.source', 'ctx.source', 'self']);
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
const KNOWN_PRED = /\b\w+\.(?:isMagic|isPhysical|isWeaponSkill|isBaseAttack|isBasicAttack|isFinalCombo|isFinalAttack|isStatusType|hasStatusType|critical|isCrit)\b|\b(?:isStatusType|hasStatusType)\s*\(/g;

function scopeOf(block) {
  // Only the `if` CONDITIONS are the guard. The enclosing block also carries
  // whatever statements ran before the call, and `Exposed Essence` sets two
  // fields on consecutive lines - so reading the whole block made the second
  // line's guard contain the first line's assignment, and refused it.
  const guard = [...String(block).matchAll(/\bif\s*\(([^{]*)\)/g)].map((m) => m[1]).join(' && ');
  // Strip the handler signature and every predicate we understand. If anything
  // condition-shaped survives, we do not understand this guard.
  const rest = String(guard)
    .replace(/function\s+on\w+\s*\([^)]*\)/g, ' ')
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
  if (/isBaseAttack|isBasicAttack|isFinalCombo|isFinalAttack/.test(guard)) return { scope: 'attack', targetBleeding };
  if (fromStatus) {
    return /^(?:Bleed|Hemorage)$/.test(fromStatus)
      ? { scope: 'bleed', targetBleeding }
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
  // A rune can supply the number the skill itself does not declare:
  // Warrior_Charge reads `vars.var1` and its own vars have no var1 - the value
  // lives on the mastery row that gates the call.
  const v = vars?.[m[2]] ?? runeVars?.[m[2]];
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
      const slots = Math.min(slotsAt(def.slotConstant, level), options.length);
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
    const guardOpts = { rank, runes, talents };
    const usableRule = (r) => !!r && r.kind !== 'never' && r.kind !== 'conditional';
    const sel = loadout.skills ?? defaultSelection(loadout);
    const filler = [];
    const active = [];
    const triggered = [];
    const passive = [];
    const dots = [];
    const unmodelled = [];
    const seen = new Set();
    const dotSeen = new Set();

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
    // gives it a cap. Spark fails the first half in reverse: the Mage's costs
    // live in a compiled `getSparkCost()`, so income without a readable spend
    // buys nothing and is not claimed as tracked.
    const tracked = new Set(gains.map((g) => g.atb));

    const push = (bucket, id, extra = {}) => {
      if (seen.has(id)) return;
      seen.add(id);
      const prof = combat.profile(id, rank, runes);
      if (!prof) return;
      if (outOfCombatOnly(prof)) return;
      const carries = prof.effects.some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind));
      if (!carries) {
        // No declared amount, but it may still grant a stat or leave something
        // ticking on the target.
        const own = (prof.affixes ?? []).filter((a) => a.target?.attribute);
        const st = statusesOf(id, { runes, rank, talents });
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
      const st2 = statusesOf(id, { runes, rank, talents });
      noteDots(id, st2, extra);
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
      const chosen = (sel[p.key] ?? p.options.slice(0, p.slots)).slice(0, p.slots);
      const item = p.kind === 'weapon' ? cat.itemById.get(loadout.gear[p.slot]?.item) : null;
      const all = item?.skills ?? [];

      for (const id of chosen) {
        const t = typeOf(id);
        if (t === 'WeaponSkill') push(active, id, { source: p.key, chosen: true });
        else if (t === 'WeaponPassive') pushTriggered(id, p.key);
        else if (p.mechanic) pushTriggered(id, p.key, { mechanic: p.mechanic, sharedWith: chosen.length });
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
      for (const id of item?.skills ?? []) {
        if (seen.has(id)) continue;
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
      const prof = combat.profile(id, rank, runes);
      if (!prof) return;
      seen.add(id);
      if (outOfCombatOnly(prof)) return;

      const carries = prof.effects.some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind));
      const ownAffixes = (prof.affixes ?? []).filter((a) => a.target?.attribute);
      const st = statusesOf(id, { runes, rank, talents });
      noteDots(id, st, { source });

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
        unmodelled.push({
          id, name: prof.name, source, kind: 'no rate',
          why: extra.parent
            // The parent link IS in the data (props.subskills); what is not is
            // the counter that arms it. Both ultimates hang off a weapon
            // passive that banks stacks per damage event and swaps to the
            // ultimate at the cap - a rate the fight could produce, but only
            // once something counts damage instances.
            ? `${skills.get(extra.parent)?.texts?.name ?? extra.parent} unlocks it, and that is a passive - `
              + 'nothing in the data says how many hits arm it'
            : 'declares damage but no trigger rate can be derived from the data',
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
      const runeFeedsResource = runePromises.some((r) => /\[(Rage|Spark|ComboPoint)\]/i.test(r.desc));

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
      const kind = st.unreadable.length ? 'script magnitude'
        : (prof.costs.length || feedsResource || runeFeedsResource) ? 'resource'
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
      noteDots(id, statusesOf(id, { runes, rank: nodeRank, talents }), { source: 'talent' });
      // ...and a talent that carries a damage step of its OWN, played on an
      // event rather than cast. `Cracking Blood` has one step - 0.15x Faith +
      // 0.15x Intellect of Magic - and its script plays it on a 35% roll every
      // time a bleed ticks. It went through no bucket at all: the talent pass
      // collected only what ticks, so a node the tree printed as "effect" was
      // worth exactly zero in the fight it was printed beside.
      //
      // Only where the rule is one the fight raises. A talent is not cast, so a
      // roll with no event named has no rate and stays unscored.
      const tp = combat.profile(id, nodeRank, runes);
      if (!tp?.effects.some((x) => ['Damage', 'Heal', 'Shield'].includes(x.kind)
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
    const liveDots = [];
    for (const d of byStatus.values()) {
      if (canFire(d)) { liveDots.push(d); continue; }
      unmodelled.push({
        id: d.status,
        name: d.name,
        source: d.source,
        kind: 'no rate',
        why: `${d.fromName} applies it, but nothing gives ${d.from} a rate this model can price`,
      });
    }

    return {
      filler, active, triggered, passive, dots: liveDots,
      unmodelled: unmodelled.filter((u) => !accounted.has(u.id)),
      selection: sel, runes: [...runes], rank, chain,
      resources: { gains, tracked: [...tracked] },
    };
  }

  /**
   * How often a triggered skill fires, expressed against rates the throughput
   * model already computes. Every rule names the data it rests on; there is no
   * fallback, because a guessed rate is worse than a stated gap.
   */
  function triggerRule(id, prof, extra, opts = {}) {
    const s = skills.get(id);

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
      // ...and the rest of that guard decides whether the rate applies at all.
      const g = guardOf(onDotTick ? script.replace(BLEED_EVENT, ' ') : script, opts);
      if (!g.fires) return { kind: 'never', why: g.why };
      if (!g.unread && onDotTick) {
        return {
          kind: 'per-dot-tick', chance,
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
          why: `vars.chance = ${chance}, and its script gates on the combo finisher`,
        };
      }
      return { kind: 'per-attack', chance, why: `vars.chance = ${chance} on a base-attack proc` };
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
   * one refusal. A status whose affix carries `mod.dynVal` has its magnitude
   * decided by a script at runtime (`Priest_Crusader_Status` is +10% damage per
   * dynVal with `maxStacks: 300`), so counting it at its cap would credit the
   * build with +3000% and is exactly the kind of large, wrong, flattering
   * number worth refusing. Those are reported as unmodelled instead.
   */
  const statusCache = new Map();
  function statusesOf(skillId, { runes = null, rank = 1, talents = null } = {}) {
    // The talents belong in the key as much as the runes do: a call site guarded
    // by `hasTalent(X)` resolves differently for a build that took X.
    const key = skillId + '#' + rank
      + (runes?.size ? '@' + [...runes].sort().join('+') : '')
      + (talents?.size ? '%' + [...talents].sort().join('+') : '');
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
        note(ref, to, undefined, st.duration);
      }
      // An effect can carry one too, and that one rides the hit.
      for (const e of st.effects ?? []) if (e.status) note(e.status, 'Target');
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
        note(resolved, to, triggerOf(live.slice(0, m.index), s, g), null, magnitudeFromScript);
      }
    }

    // Which statuses this script applies as a SHARE of the hit, and how big a
    // share. Resolved through a local, because that is how the scripts write it.
    const poolFraction = new Map();
    if (s?.script) {
      const body = liveScript(s.script);
      const local = new Map();
      POOL_LOCAL.lastIndex = 0;
      for (let mm; (mm = POOL_LOCAL.exec(body));) {
        const v = s.vars?.[mm[2]];
        if (typeof v === 'number' && v > 0) local.set(mm[1], v);
      }
      ADD_STATUS_3.lastIndex = 0;
      for (let mm; (mm = ADD_STATUS_3.exec(body));) {
        const [, , raw, arg] = mm;
        const id = skills.get(raw) ? raw : null;
        if (!id) continue;
        const t = arg.trim();
        const direct = /^\w+\.amount\s*\*\s*vars\.([A-Za-z0-9_]+)$/.exec(t);
        const frac = direct ? s.vars?.[direct[1]] : local.get(t);
        if (typeof frac !== 'number' || !(frac > 0)) continue;
        const scope = enclosingBlock(body.slice(0, mm.index));
        poolFraction.set(id, {
          fraction: frac,
          // The guard says which damage feeds it. Hemorrhage takes physical
          // critical strikes and explicitly excludes damage from other dots,
          // which is what stops a bleed from feeding itself.
          crit: /\bcritical\b|\bisCrit\b/.test(scope),
          physical: /\bisPhysical\b/.test(scope),
          magic: /\bisMagic\b/.test(scope),
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
      if (kinds.has('CrowdControl') || kinds.has('HardCC')) flaggedCC.push(label);
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
          tick: sp.periodic.tick,
          duration: life ?? sp.periodic.duration,
          stacks: st.props?.status?.maxStacks ?? 1,
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
      const dynamic = affixes.some((a) => a.mod?.dynVal);
      const entry = {
        from: skillId,
        status: statusId,
        name: st.texts?.name ?? statusId,
        stacks: st.props?.status?.maxStacks ?? 1,
        stackingPolicy: st.props?.status?.stackingPolicy ?? null,
        duration: st.duration ?? null,
        types,
        to: wearer,
        affixes,
      };
      if (dynamic) {
        unreadable.push({ ...entry, why: 'its affixes are scaled by a script-set dynVal, so their magnitude is not in the data' });
        continue;
      }
      if (!affixes.length) continue;
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
  function triggerOf(before, skill, guard = null) {
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
    const combo = /isFinalCombo|isFinalAttack|isComboAttack/.test(scope);
    const attack = /isBaseAttack|isBasicAttack/.test(scope);
    let on = 'cast';
    let why = `${hook ?? 'its script'} applies it`;
    // Both, when the guard is an OR of the two. `Rogue_Talent_LethalPoison`
    // reads `(dmg.isBaseAttack || dmg.isFinalCombo) && checkProba(vars.chance)`,
    // and taking only the combo branch would cost it two thirds of its uptime.
    if (combo && attack) { on = 'attack-or-combo'; why = 'on a base attack or a combo finisher'; }
    else if (combo) { on = 'combo'; why = 'on the combo finisher'; }
    else if (attack) { on = 'attack'; why = 'on a base attack'; }
    else if (/isWeaponSkill/.test(scope)) { on = 'weapon-skill'; why = 'on every weapon skill you press'; }
    if (chance < 1) why += `, ${Math.round(chance * 100)}% of the time`;
    // A condition on live state sits on top of the event and the roll, and it
    // can only make the status land LESS often than this says. Carrying the
    // flag lets the caller say so instead of quietly presenting a ceiling as a
    // rate - `DM_Multispin_Passive` needs its own buff max-stacked first.
    const unread = guard?.unread ?? (UNREAD_COND.exec(scope) ?? [null])[1] ?? null;
    if (unread) why += `, and only while ${unread}() holds - which this reader cannot evaluate`;
    return { on, chance, why, hook, unread };
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
  function talentModifiers(skillId, rank = 1) {
    const key = skillId + '@' + rank;
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
        const sc = scopeOf(enclosingBlock(body.slice(0, m.index)));
        if (!sc) continue;
        const { scope, targetBleeding } = sc;
        out.push({
          field: 'healShare', scope, targetBleeding,
          amount: amount * rank, from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      // Cooldown reduction earned off an EVENT rather than carried as a stat.
      // `Red Tempo` reads `if (dmg.isStatusType(Bleed)) if (checkProba(0.12))
      // reduceWeaponsCooldown(1)` - so every bleed tick has a 12% chance to cut
      // a second off your weapon skills. That is a rate the fight can derive
      // once it knows the bleed's tick interval, which it does.
      const CD_PROC = /reduce(?:Weapons)?Cooldown\s*\(\s*vars\.([A-Za-z0-9_]+)\s*\)/g;
      CD_PROC.lastIndex = 0;
      for (let m; (m = CD_PROC.exec(body));) {
        const seconds = s.vars?.[m[1]];
        if (typeof seconds !== 'number' || seconds <= 0) continue;
        const scope0 = enclosingBlock(body.slice(0, m.index));
        const sc0 = scopeOf(scope0);
        if (!sc0) continue;
        let chance = 1;
        const cv = /checkProba\s*\(\s*vars\.([A-Za-z0-9_]+)/.exec(scope0)?.[1];
        if (cv && typeof s.vars?.[cv] === 'number') chance = s.vars[cv];
        out.push({
          field: 'cooldownPerTick', scope: sc0.scope, targetBleeding: sc0.targetBleeding,
          amount: seconds * chance * rank, from: skillId, name: s.texts?.name ?? skillId,
        });
      }
      DMG_FIELD.lastIndex = 0;
      for (let m; (m = DMG_FIELD.exec(body));) {
        const amount = s.vars?.[m[2]];
        if (typeof amount !== 'number' || amount === 0) continue;
        const guard = enclosingBlock(body.slice(0, m.index));
        const sc2 = scopeOf(guard);
        if (!sc2) continue;
        const { scope, targetBleeding } = sc2;
        out.push({
          // `armorIgnore` and `magicArmorIgnore` are the SAME 5% applied to two
          // different armours, not 10% applied to one. Exposed Essence sets
          // both on consecutive lines and folding them together doubled it.
          field: m[1],
          scope,
          targetBleeding,
          amount: amount * rank,
          from: skillId,
          name: s.texts?.name ?? skillId,
        });
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
          amount: amount * rank, from: skillId, name: s.texts?.name ?? skillId,
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
      for (const b of selfBuffsOf(entry.prof.id, { runes, rank: rotation.rank ?? 1 })) {
        if (seen.has(b.status)) continue;
        seen.add(b.status);
        out.push(b);
      }
    }
    return out;
  }

  return {
    pools, defaultSelection, pruneSelection, resolve, selfBuffs, selfBuffsOf, statusesOf,
    weaponSlotsAt, arsenalSlotsAt, typeOf, baseChain, resourceGainsOf, talentModifiers,
    mechanicTypes: MECHANIC_TYPES,
  };
}
