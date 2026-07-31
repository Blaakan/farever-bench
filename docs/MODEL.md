# The model

Where every formula came from, what is verified, and what is still a guess.

Farever ships `hlboot.dat` as **HashLink bytecode v4 with full debug info**:
1716 source filenames and per-opcode line numbers across 47342 functions. So
the citations below are to real functions and real source lines, and any of
them can be re-checked after a patch with a disassembler.

Nothing in this repo is hardcoded. Every constant is a `constant`-sheet lookup
and every coefficient is a CastleDB id, so a balance patch changes the answer
without changing the code. An id that fails to resolve throws by name.

---

## 1. One curve drives everything

`HAttributes.field#6`, `@src/const/HAttributes.hx:15-24`:

```
budget(L, min, max) = min * (max/min) ^ ((L-1) / (EarlyMaxLevel - 1))
```

`EarlyMaxLevel` is `constant.LevelScalingFormula_EarlyMaxLevel` = **50**, and
the constant's own description spells the formula out:
*"For x current level: start \* pow( pow(end/start, 1/(maxLevel-1)), x-1)"*.

The function returns 0 for the degenerate row it also guards against
(`min ≈ 0` with `max == 0`), so an unauthored budget contributes nothing rather
than `NaN`.

This one function is the item stat budget, the character's own level growth
(`unit.stats[].levelScaling`), **and** the denominator of every rating
conversion. Implemented once in [`src/model.mjs`](../src/model.mjs) as
`budget()`.

Note the character level cap is `constant.MaxLevel` = **25** while every curve
is authored against 50, so live stats sit near the geometric middle of the
tables. The cap will move; the curve is parameterised on the constant so
nothing needs changing when it does.

## 2. Rating → percent, and the trap in it

`ent.Unit.getAtbScaling`, findex 4801, `@src/ent/Unit.hx:1383`:

```
contribution = (rating / budget(L, min, max)) * target
```

where `Rating(min, max, target)` is the `AttributeOperator` case stored in
`attribute.scaling[].scalingOperator`. That column's `typeStr` is
`9:AttributeOperator`, a **custom type** — decode `cdb.customTypes` or the value
is an opaque number array. The complete enum, from that table:

```
AttributeOperator = Flat | LinearRatio | Rating(min:Int, max:Int, target:Float)
```

`[0]` is `Flat`; `[2,150,1000,20]` is `Rating(150, 1000, 20)`. An exhaustive
scan of the database finds only `[0]`, `[2,150,1000,20]` and `[2,150,1000,50]`.
**`LinearRatio` is unused in this build**, which is why the model treats it as
`src * scale` and says so in `bench audit` rather than pretending to know.

**The trap:** the `scale` field sitting next to the operator is *never read* on
the Rating path. `CritChanceRating` carries `scale: 0.1` and `FervorRating`
carries `0.05`, and both are dead data. A naive `scale * rating` implementation
is off by about **7.5×**. `test/run.mjs` asserts the two values are *not* equal,
so reintroducing the bug fails the suite.

**Two consequences.** Because `min` and `max` are exactly the level-1 and
level-50 rating budgets, a full budget yields exactly `target` percentage
points at *any* level:

- Rating is **exactly linear** at a fixed level. There is no
  diminishing-returns curve, which is the thing that invalidated stat weights
  in World of Warcraft.
- A rating point **loses `(1000/150)^(1/49) ≈ 3.8%` of its value per character
  level gained**. At level 25 the budget is 379.87, so +1 CritChanceRating is
  +0.0527pp of crit and +1 ArmorPenetrationRating is +0.1316pp.

No player can see any of this in game.

## 3. Armor is design intent, not a number

The same `field#6` **hardcodes attribute indices 23 and 24** (`Armor` and
`MagicArmor`) and returns `field#5` instead — the algebraic inverse of the
mitigation curve:

```
resistForReduction(L, red) = red * (a + b*L) / (1 - red)
```

with `[a, b] = constant.ResistanceScalableReductionFormula = [385, 100]`, and
`red` the mean of the character's aptitudes' `props.armorReduction`.

So `aptitude.atbScaling`'s authored `start`/`end` columns for Armor are **dead
at runtime**. Interpolating them geometrically is wrong at every level except 1
and 50.

The authored numbers do still agree with `props.armorReduction` for three of
the four classes:

| aptitude | `props.armorReduction` | authored start | implied by props |
|---|---|---|---|
| Assassin | 0.30 | 208 | 207.9 ✓ |
| Wizard | 0.25 | 162 | 161.7 ✓ |
| Cleric | 0.25 | 162 | 161.7 ✓ |
| **Fighter** | **0.40** | **261** | **323.3** ✗ (261 implies 0.35) |

The Fighter's authored columns are stale. The model follows the runtime and uses
`props.armorReduction`; `bench audit` reports the discrepancy, and the test
suite asserts the Fighter still disagrees — so if a patch fixes it, the suite
tells you to update this table.

## 4. Mitigation

`ent.GameObject.getAffinityDamageReduction`, findex 4510,
`@src/ent/GameObject.hx:748-802`:

```
R'        = totalResist * (1 - clamp(penetration, 0, 100) / 100)
reduction = R' / (R' + 385 + 100 * attackerLevel)
reduction += sum(affinity.reductions)      // flat, added to the FRACTION
reduction = max(reduction, 0)              // floored, never capped at 1
```

Three details that are easy to get wrong:

- The level term is the **attacker's** level, not the defender's.
- `affinity.reductions` (`MagicReduction`, `Resilience`) are added to the
  resulting *fraction*, not to the resist pool.
- `Raw` affinity returns 0 immediately, bypassing everything.

`affinity` is a two-level tree and **all 14 magic sub-schools are empty** in
this build — Fire, Water, Nature, Air, Chaos, Light, Cheese, Shadow, Spark,
Honey, Flower and Lava all inherit from `Magic`; Violence and Earth inherit
from `Physical`. So there are exactly **three** mitigation paths today, not
seventeen. If those columns ever get populated, that is a real balance change
worth watching.

| affinity | resist | penetration | flat reductions |
|---|---|---|---|
| `Raw` | — | — | — |
| `Physical` | `Armor` | `ArmorPenetration` | — |
| `Magic` | `MagicArmor` | `SpellPenetration` | `MagicReduction` |

## 5. Attribute composition

`ent.Unit.atb`, findex 4796:

```
atb = (stored + scaling + flat) * (modAdd * modMul)
```

- `stored` — the unit's own value: `unit.stats[].value`, or `levelScaling`
  through the curve, or the attribute's `defVal`.
- `scaling` — `attribute.scaling[]` applied to already-resolved attributes.
- `flat` / `modAdd` / `modMul` — `TAttribute_Flat`, `TAttribute_ARatio`,
  `TAttribute_MRatio` from gear and augments.

Then the `RoundUp` flag ceils, and anything without `NegativeAllowed` is floored
at zero.

**Nothing ever writes a computed value back into storage.** `initAttributes`
writes only `attribute.defVal` and `unit.inf.stats[].value`; all 30 callers of
`set` are resource/damage/heal mutations. That is why the promoted
per-attribute fields in memory read **zero** for gear-derived stats — they are
the stored layer, not the sheet. Anyone planning to read a character's stats out
of the process should know this before designing around it.

Attributes are evaluated in **topological order** over the scaling graph, not
sheet order. Sheet order happens to be valid today; relying on that is how a
patch breaks you silently. A cycle throws with the path named.

## 6. What an item is worth

459 of 508 equippable items are pure stat sticks whose stats are **stored
nowhere**. They are computed at equip time:

```
amount = budget(effectiveLevel, entry.start, entry.end) * atbRatio[group] * affixFactor
```

- `entry` — a row of `aptitude.atbScaling`, gated by `conds.minRarity` and
  `conds.factions`. **One aptitude pays: the wearer's own.** An item naming two
  is naming who may WEAR it, not how many budgets it hands out — 271 of the 513
  stat-bearing items name a class pair, and the six `combines` aptitude rows
  (FigAss, WizCle, …) exist to label exactly that. Each aptitude's share is
  rounded on its own before any sum; that is a one-unit difference and the game
  agrees.

  **The proof is `itemType.atbRatio` itself.** Summed over one item per core
  slot — mainhand, the eight armour pieces, neck and two fingers — every stat
  group comes to *exactly* 1.0:

  ```
  primary 1.0    vitality 1.0    armor 1.0    ratings 1.0
  ```

  A full set is designed to deliver one aptitude curve per group, so paying
  every named aptitude hands a dual-class item two of them. That is what put a
  level-25 Priest at 453 Vitality where a real character sits at 193, gave the
  same Priest a near-full Intellect budget *and* a near-full Faith one off gear
  that is Mage-or-Priest, and — worst — doubled ARMOUR, which cannot double
  because its budget is `resistForReduction(level, the wearer's
  props.armorReduction)` and does not depend on the aptitude at all. Cleric
  declares 0.25 and the sheet was reading 40.3%.

  The in-game reading in [section 12](#12-checked-against-the-game) is not
  contradicted: it is an ITEM TOOLTIP, and a tooltip has no wearer. `cat.contribute`
  keeps that as an explicit `allAptitudes` mode and the test suite still asserts
  all ten of its numbers.

  **Generic aptitudes** — the five nameless rows `Crit / ArPen / MaPen / Fervor
  / Vita` that jewellery uses — are the same rule from the other side: nobody's
  class matches them, so an item naming only generics pays exactly ONE, and
  which one is a decision rather than a sum. Four items are affected
  (`Necklace_Z1RCraft`, `Necklace_Z2RCraft`, `Finger_Z2RCraft_CriAP`,
  `Finger_Z2RCraft_FerMP`); each appears once per generic in the candidate list,
  the same way a rarity roll does, and the pick is printed. Nothing in the data
  says which one you get — only that it is one.
- `group` — `aptitude@atbScaling.statGroup` is the enum
  `Primary | Vitality | Armor | Ratings`, matching `itemType.atbRatio`'s four
  keys exactly.
- `atbRatio` — the slot's share of the budget, inherited up the `itemType`
  chain, with a per-rarity override in `props.rarities` (Common gear gets no
  primary or vitality). **The `primary` and `armor` shares sum to exactly 1.0**
  across the eight armour slots plus the mainhand, which the test suite asserts.
- `affixFactor` — `Slot_Weapon2` carries `slot.affixFactor = 0.4`, so the
  arsenal weapon contributes two fifths of everything, stats and augments
  alike. A character effectively wears 1.4 weapons.

  **Verified against the game.** The same spear reads +36/+18/+15/+39/+39 in the
  main hand and +15/+8/+6/+16/+16 in the arsenal. `ceil(v * 0.4)` is the only
  combination that reproduces all five — `round` gives 14 and 7, `floor` gives
  14/7/15/15, and 0.5 is not close. So it is 0.4, and the CEILING is what makes
  small values look nearly halved. A Rare Corrupted Gift confirms it on authored
  affixes too: -20/+20 in the main hand, -8/+8 in the arsenal.

**How a modifier composes is authored too.** The `affix` sheet's `stack` column
is an `AffixStacking` custom type and nothing read it:

| ref | `stack` | means |
|---|---|---|
| `TAttribute_Flat` | — | additive |
| `TAttribute_ARatio` | — | additive, into `modAdd` |
| `TAttribute_MRatio` | `Multiplicative` | the multiplier **replaces** and compounds: `DamageTakenModifier 0.6` is "you take 60% of what you would" |
| `TAttribute_MRatioMin` | `Min(base: 1)` | the **strongest applies** and they do not compound — two 30% slows are a 30% slow, not 51% |

Two readings were wrong before this was read. `catalog.applyAffixes` composed a
multiplicative affix as `cur * (1 + v)` while `engine.applyAffix` composed the
same ref as `cur * v`, so one row meant different things depending on whether it
arrived on an item or in a status; and `MRatioMin` was treated as `MRatio`
everywhere. Neither is live today — no equippable or augment carries a
multiplicative affix, and all eight `MRatioMin` rows target `MoveSpeedFactor`,
which nothing here scores — so this changed no number. It stops the day one is
authored from being a silent factor of two. A slot factor now blends a
multiplier toward 1 rather than scaling it, because `0.6 × 0.4 = 0.24` is a
*bigger* reduction than the affix grants.

**`sourceAtb`.** A row like `{endAtb: MaxHealth, sourceAtb: Vitality}` states
its budget in MaxHealth but delivers it as Vitality, so the amount is divided by
how much MaxHealth one Vitality buys (3, from `MaxHealth.scaling`). The model
looks that factor up rather than assuming it, and throws if it is absent.

**Effective level.**

```
baseILevel = item.iLevel ?? (item.level * 10) ?? (characterLevel * 10)
iLevel     = baseILevel + rarity.iLevelBonus + 10*stars + 10*flawless
effLevel   = iLevel / 10
```

iLevel is ten times the level — the easiest place in the whole project to be
silently wrong by a factor of ten. **501 of 911 equippable rows have no
authored level at all** (every `*_R<Faction>_*` row), because they drop at the
character's level; that is what the third fallback is for. The `+10`s are
`constant.Item_GearUpgradeILevelBonus` and `Item_FlawlessILevelBonus`.

**Faction is a build axis.** Which secondary rating a piece can carry is the
cross of the character's class with the *item's* faction, through
`conds.factions`. One row, four different answers:

| faction | Warrior | Rogue | Mage | Priest |
|---|---|---|---|---|
| Manfish | ArmorPen | Crit | SpellPen | Fervor |
| Bee | ArmorPen | Fervor | Fervor | SpellPen |
| Kobold | Crit | ArmorPen | SpellPen | Crit |
| Crimson | Fervor | Crit | Crit | Fervor |
| Demon | Fervor | Fervor | Fervor | SpellPen |
| World / Craft | ArmorPen | Crit | SpellPen | Fervor |
| Starter | Crit | ArmorPen | Crit | Crit |

Gear with no faction has no secondary stat, and sub-Rare gear has none either
(`conds.minRarity`).

## 7. Augments

A separate, fully authored layer: **93 items across 8 `Augment*` itemTypes**,
each carrying explicit `TAttribute_Flat` affixes. Legality is
`itemType.props.augmentTargets` intersected with the host item's own
inheritance chain, so it is derived rather than listed:

| socket | goes on | notable |
|---|---|---|
| `AugmentBlacksmith` | Chest | +2/+2 primaries, or +100 Armor +4 Vitality |
| `AugmentOutfitter` | Back | same shapes |
| `AugmentJeweller` | Neck, both Fingers | +7/+7 ratings; the Cursed Eyes are +9/+9/+9/−9 |
| `AugmentEnchantHands` | Hands | +4 of one primary |
| `AugmentEnchantFeet` | Feet | +15 of one rating, or +200 Armor |
| `AugmentEnchantWeapon` | mainhand | grants a *skill*, no stats |
| `AugmentDemon` | any weapon | converts 40 rating from one type to another |
| `AugmentDemonSigil` | Head | grants a *talent*, no stats |

These are not a rounding error. At level 25 the total ratings budget is 379.87
and a chest's share is `0.075 × 379.87 ≈ 28`, so a single
`DemonGearUpgrade_FervToCrit` (−40 Fervor, +40 Crit) is a **bigger rating swing
than the entire rating contribution of any armour slot**. And because the Demon
augments convert any rating into any other, faction does not finally determine
your rating — it determines your starting point.

A socket only exists while an item that hosts it is equipped, which is why the
optimiser recomputes the decision set every pass and prunes orphaned augments.

A real loadout is therefore **15 gear + up to 10 augment sockets = 25
decisions**, not 15.

## 8. Handedness

Only a one-handed mainhand leaves a hand free for the offhand, and the data
says which: **`OHWeapon` is the single itemType carrying the `AllowShield`
flag**. Every weapon type inherits from exactly one of:

- `OHWeapon` — Sword, Mace, Axe → **offhand allowed**
- `THWeapon` — GreatSword, GreatAxe, GreatMace, Bow, Book, Halos, Scepter, Thrown, Crescent, CaptureNet
- `DualWeapon` — DualSwords, DualMaces, DualAxes, Daggers, Fists
- `LongWeapon` — Spear, Staff

Pinning a shield therefore constrains the mainhand to one-handers, and pinning
a two-hander plus a shield is refused by name.

## 9. Skills: what you press, and what you had to choose

A weapon does not hand you its kit. It grants a base-attack chain and a combo
unconditionally, plus a **pool** of `WeaponSkill` and `WeaponPassive` entries of
which you slot only some — usually three offered and two taken. Slot counts come
from the game's constants:

| constant | value | means |
|---|---|---|
| `UnlockLevel_WeaponSkillSlots` | `[1, 2]` | 2 main-hand skill slots, from level 2 |
| `UnlockLevel_Arsenal` | `[7, 20, 50]` | arsenal slots at 7 and 20 (a third at 50) |
| `Priest_Prayer_Slot_Unlocks` | `[1, 1, 9]` | 3 prayers in the sequence |
| `Mage_Conduit_Levels` | `[1, 1, 4]` | 3 conduits |

So the count moves on its own if a patch moves it, and a level-12 character
correctly gets two main-hand skills and only one arsenal skill.

### The chain's length is authored

`moveSet.comboLength` says how many links a weapon's base-attack chain has, per
weapon class — 4 for one-handers, 5 for duals and bows. It went unread, and the
chain was whatever the item row happened to list. On **2 of the 33 weapons that
carry a chain** those disagree, and both are missing links that exist as rows:

| weapon | item row lists | `comboLength` | missing |
|---|---|---|---|
| `Scepter_Flamie` | 2 | 4 | `Scepter_Base_Attack2`, `Scepter_Base_Attack3` |
| `DM_Multispin` | 4 | 5 | `DM_Base_Attack4` |

`DM_Base_Attack4` is the **only** chain-link row in the sheet that no player
weapon references, and the two scepter rows are what `Scepter_Start` swings. So
the item row is incomplete and the game resolves the rest from the type.

It is not cosmetic. The combo finisher charges a Priest's prayers and is what
every `isFinalCombo` guard rolls against, so a 2-link chain fires all of them
**twice** as often: a Priest holding `Scepter_Flamie` read 0.65 combos/s against
`Scepter_Start`'s 0.31, prayers every 4.62s against 9.68s, and a headline figure
44% above what the fixed chain gives. Short is also the *flattering* reading.

The fill is derived: take the common id prefix of the links the weapon does
declare, and use it to find the row filling each missing slot; an ambiguous or
absent match fills nothing. `Net_Basic` (a capture net) matches nothing and is
reported short rather than faked. What was filled is printed with the rotation.

**A slot is not one row.** Every staff declares `Staff_Base_Attack` and
`Staff_Base_Attack2` and *both are typed `Attack`* — there is no `Attack2` row
for staffs at all. Keying the chain by type slot merged them and made every
staff a link short, so the item's own declaration order is the chain and the
slot type is only how a missing link is found.

**A `WeaponSubSkill` is a follow-up, not a choice.**
`Book_WaterOrbs_Skill2_Recast` exists only because Skill2 does, and the wiring is
by id prefix, which is how the data names them. One that prefixes nothing —
`Staff_Censer_Ultimate` — has no discoverable trigger and is reported unmodelled
rather than handed out free. It does 658 damage, so guessing would not be a
rounding error.

**Only the main-hand chain is used.** The arsenal is a weapon you swap to, so
counting both base-attack chains at once would double the filler. Its slotted
skills still contribute, which is exactly what `UnlockLevel_Arsenal` describes.

### Cast, or fired at you

Roughly a third of what a build knows is `nature: Passive`, and a `cooldown` on
one of those is an anti-double-fire guard rather than a cast rate.
`Priest_Prayer_Smite` reads `cooldown: 1` and does 279 damage; scoring it every
second would make it the entire build. Its real trigger is stated twice in the
data — in its own description, *"Becomes ready after you use your
[ComboAttack]"*, and in `Priest_Rosary`'s script:

```js
function onSkillProc(ctx) {
  if( ctx.skill.isFinalAttack() ) { chargePrayer(); }
}
```

So skills are sorted into four buckets, and a triggered skill only earns a rate
from an **explicit rule tied to something the data states**:

| bucket | rate | rule |
|---|---|---|
| `filler` | the chain cycles in whatever time is left | — |
| `active` | `cooldown / (1+CDR)`, a bank of `charges`, floor `occupancy` | needs `cooldown > 0` |
| `triggered` | per combo | prayers, per `Priest_Rosary` |
| | per swing or per combo × `vars.chance` | `vars.chance` is the proc rate the data ships; the script's own guard says which event it rolls against |
| `dots` | applied by an event, then tick until they expire | a status carrying `props.loop.tick` |
| `passive` | not throughput; contributes stats | own affixes, or a self-buff status |
| `unmodelled` | **zero, and named** | anything else |

**A follow-up's parent is declared, not guessed.** `skill.props.subskills[].skill`
names it, on 7 rows covering all five `WeaponSubSkill`s, and the binary follows
the same link (`resolveSubSkills`, `isSubSkillOf`, `get_subskills`). The model
used to infer it from the id prefix, which never resolved one *wrongly* but
found nothing for the two that matter — `GS_Nova_Passive → GS_Nova_Ultimate` and
`Staff_Censer_Passive → Staff_Censer_Ultimate`, where neither id starts with the
other. A follow-up is therefore TRIGGERED at its parent's cast rate, not an
active waiting for a cooldown it does not have; asking it for one sent every
follow-up in the game to "no cast rate can be derived".

Where the parent is a weapon **passive**, there is still no rate — those two
ultimates are armed by a stack counter that banks per damage event — and the
output says exactly that instead of blaming the link.

**A skill you have not learned is not a gap.** `unit@skills.level` gates the
class list, and ignoring it put three level-30 capstones in a level-25
character's coverage report as things the model had failed to score.

**A guard has more in it than the event.** The reader used to match its four
predicates and ignore the rest of the same `if`, which credits a proc with a
rate it does not have. 37 of the skills carrying a `vars.chance` and 20 of the
`addStatus` call sites carry a second condition, and they are not all the same
kind of thing:

| in the guard | | |
|---|---|---|
| `rank >= 2` | **evaluated** | it is the weapon-skill rank, the same number `--rank` resolves on every step, effect and affix. A rank-1 character was being handed rank-2 riders: `Sword_Swarm_Passive`'s poison, `Bow_Craft_Passive`'s status and `GM_MassGrab_Combo`'s proc all appear only at rank 3 now |
| `hasTalent(X)`, `hasMastery(X)` | **evaluated** | the loadout says which talents and runes it has |
| `hasStatus`, `getStatusCount`, `hasStatusMaxStacked`, `.stacks >= getMaxStacks()`, `isStatusType`, `isInCooldown` | **refused, and named** | a question about live state at the moment the proc rolls |

`DA_Water_Combo_PassiveRank3` is why it matters: its guard is `isBaseAttack &&
status.stacks >= status.getMaxStacks() && checkProba(0.35)`, and reading only
the first and last credits it 0.35 per swing when it needs a max-stacked buff
first. It is now reported `conditional` rather than scored.

The guard is the block around the **roll**, not the whole script.
`Daggers_DuplicatePoison_ComboAttack` rolls in `onInflictDamage` while a
different handler entirely calls `getStatusCount`, and reading the file as one
guard refused a rate the roll does not depend on.

**And a closed sibling branch takes its header with it.** Dropping only the body
left `if (ctx.target.hasStatus(mark) && …)` sitting at depth 0, so the guard on
the branch that ran was attributed to the branch that did not —
`Bow_BigGame_Passive` marks its target in an `else if` and the condition above
it read as a condition on the mark.

**`props.rankPassives` is a rank gate too.** Two rows carry it, both on player
weapons, both at `minRank: 3` — which is the rank `--rank` defaults to, so the
character always had them and the model did not know they existed.
`DA_Water_Combo` grants `DA_Water_Combo_PassiveRank3` and
`Crescent_FlowerSpiral_Skill_1` grants its `_Charge` counter. Neither turns out
to be scoreable, so what this buys is not damage but coverage that names them.

**`props.enableCond` says when a skill may be used at all** — `InCombat |
InCombatOrTargetting | OutOfCombat`. An `OutOfCombat` skill is not a gap in the
model, it is unavailable in a fight, so it is left out rather than reported as
damage nobody could score.

**Which event a proc rolls against is in the guard, not assumed.**
`Enchant_Lifestealing` reads `vars.chance = 0.5` and its script says
`if( hit.isFinalCombo && checkProba(vars.chance))`. A combo finisher lands about
a third as often as a swing, so pricing every proc per-attack overstated that
enchant threefold. The model reads `isFinalCombo` / `isFinalAttack` /
`isBaseAttack` / `isWeaponSkill` out of the text ahead of the call, and nothing
else — a guard it does not recognise falls back to "when the skill goes off",
and if the skill has no cast rate the fight never fires it and the output says
so by name.

### Resources are a second kind of cooldown

Instead of waiting for a timer you wait for income, and **both halves are in the
data**. `props.costs` says a cast takes 10 Rage. The income was the part nothing
read, and it was never missing — only unlooked-at:

```js
// Warrior_Rage, a ClassPassive with no damage and no cooldown
function onInflictHit(hit) {
  if( hit.isFirstHit && (hit.isBaseAttack || hit.isFinalCombo || hit.isWeaponSkill)
      && !(hit.skill?.isSignature() ?? false) )
    addAtb(owner, Attribute.Rage, vars.var1);       // vars.var1 = 1
}
```

That is the **same shape** the reader already handled for `addStatus` — a hook,
a guard naming events the fight counts, a call — and it was skipped only because
the regex matched `addStatus|enforceStatus|setStatus` and never `addAtb`.
`Warrior_InfiniteRage` needs no script at all: a `SelfEffect` step with
`loop.tick: dur1` (= 3) carrying `GainAtb Rage 1`, gated `enableCond: InCombat`.
Its own description says *"While in combat, you generate 1 Rage every 3s."*

So the loop is complete and fully authored:

| | from |
|---|---|
| cap | `MaxRage` = 20 on the Warrior unit, via the sheet |
| starts empty | `Rage.flags` carries `NoAutoFill` |
| income, per event | `Warrior_Rage`'s script: +1 on attack, combo finisher and weapon skill |
| income, per second | `Warrior_InfiniteRage`: +1 every 3s in combat |
| multiplier | `attribute.gainAtb` → `RageGainFactor`, 1 on the Warrior and doubled by `Warrior_BerserkStatus` |
| spend | `Warrior_Rage_Strike`'s `props.costs` |
| no in-combat decay | `Rage.regenAtbs` fires only at `timeOutsideCombat: 3` |
| does not fund itself | the script's own `!isSignature()` |

`Warrior_Rage_Strike` therefore casts every **~7s** on a real build rather than
being reported unscoreable, and it is worth **+14%** on the Warrior. The two
passives that feed it are the *mechanism*, so they are accounted for rather than
listed as things the model failed to score — the same treatment `Priest_Rosary`
already had.

**A pool-gated skill is not charge-gated.** Running one through the charge
machinery spends its single charge and then sets the next recovery to Infinity,
so it fires once per fight; the pool is the gate, and the charge is not touched.

**`isFirstHit` costs nothing to honour** — a gain is awarded per cast, not per
target hit, which is what the simulation does anyway.

**Still not modelled: Spark.** `Mage_SparkMaster` spends `s.getSparkCost()`, a
compiled method, and **no Mage skill declares a cost in any column**. Income
without a readable spend buys nothing, so Spark is not claimed as tracked.
ComboPoint is the middle case: the cap is authored (`MaxComboPoint` 4, raised to
5 by `Rogue_ComboMax`) but `Rogue_ComboPoints` awards through a local variable
inside a helper function rather than a literal, and `Rogue_Sig_Finisher` spends
`-getCp()`, so neither end is a number this reader will invent.

**No cooldown, no cost and no rule still means unmodelled, not spammable.**
Treating `Warrior_Rage_Strike` as castable every 1.4s tripled the Warrior's
damage before any of this existed.

### Rank and runes are two systems, and they do not overlap

**Confirmed in game.** A weapon has **mastery levels**, earned with kills
(`WeaponKills_PerSkillRankPoint` = 20, and 26 on an off-hand). Each of its
skills — *passives included* — takes **two upgrades**, so a skill runs rank 1 →
2 → 3 and `WeaponSkill_MaxRank` = 3 is that ceiling. A fully mastered weapon is
every skill at rank 3, which is what `--rank` defaults to.

A **class** skill does not rank. It offers three runes and you choose.

The data separates them completely, which is worth stating because the two look
alike in the sheet and one function resolves both:

| | rows | rank-gated | rune-bearing |
|---|---|---|---|
| `WeaponSkill` | 68 | 56 | 0 |
| `AttackCombo` | 33 | 31 | 0 |
| `WeaponPassive` | 31 | 27 | 0 |
| `Talent` | 88 | 46 | 0 |
| `ClassSkill` | 26 | 0 | 24 |
| `SignatureSkill` | 4 | 0 | 4 |

**No row carries both.** So `minRank`/`maxRank` is always weapon mastery, except
on a `Talent`, where it is the points in that node — a **different namespace**,
capped at `props.talent.maxPoints` = 2. Resolving a talent at the weapon's rank
asks a two-point node whether it is at rank 3, and every `minRank: 2` rider on
it passes for free; the talent pass now uses the node's own rank.

**`props.rankOverride`** restates props at a weapon-skill rank;
`GA_Craft_Skill1` drops from a 16s cooldown to 12s at rank 2, and `--rank`
applies it.

**`cond.castHoldStep` steps are mutually exclusive charge levels.**
`GA_Craft_Skill1` declares Hit1/Hit2/Hit3 at 2.5×/4×/6× Strength for how long
you held it. Summing all three overstated the skill twofold; full charge is
assumed and stated in the audit.

**`cond.mastery` steps are gated on the slotted rune**, and the search chooses
it. That choice has to be enumerated from what the build KNOWS, never from the
resolved rotation: a skill only reaches the rotation once it already carries a
damage effect, and a rune-gated step is exactly what can give it one — so
asking the rotation which runes to offer meant a rune that makes a skill worth
pressing could never be found. `Priest_FaithfulWinds` is the live case: it does
nothing at all until `Priest_FaithfulWinds_M3` adds its damage step.

### Self-buffs, and why an enchant is worth anything

A weapon enchant's whole value is a stacking buff, and the *link* to it lives
only in script text:

```js
// Enchant_Zealot
function onInflictHit(hit) {
  if( hit.isBaseAttack) {
    if(checkProba(vars.chance)) { addStatus(owner, Skill.Enchant_Zealot_Status); }
  }
}
```

`Enchant_Zealot_Status` then carries `TAttribute_Flat CritChanceRating +6` with
`props.status.maxStacks: 5` and `duration: 15` in ordinary data columns. So the
model reads `addStatus(<self>, Skill.<X>)` out of the script — the link, and
nothing else — resolves X, and applies its affixes at full stacks.

Without this, every weapon-enchant socket came back empty, and the tool was
implicitly claiming "no enchant is better than any enchant".

**A script may bind the skill to a local first.** `Priest_Crusader` opens with
`var Buff = Skill.Priest_Crusader_Status;` and then calls `addStatus(owner,
Buff)`, so a reader that only matches `Skill.X` at the call site finds nothing
and the ability disappears from the build without a word. Five Priest class
cooldowns vanished that way; aliases are resolved before the call sites are
matched, and anything still unreadable is now NAMED.

**And a script is not the only path.** A `Status` step names the status it
applies outright:

```
Priest_BlessingOfFervor.steps[] = { on: Hit, type: Status,
                                    props: { status: { ref: …_Status } } }
```

That status is +10 Fervor for 15 seconds, and a script-only reader saw none of
it. Who wears it is decided the way the column documents itself — "when a target
is available (after a hit), defaults to it, otherwise applies to self" — with
the status's own `Buff`/`Debuff` typing as the check that survives every row: a
Buff never lands on the enemy. `Priest_BlessingOfFervor` applies its buff
through an Area step whose `hitFilter` is `Allies|Self`, so "whoever was hit" is
you.

**Uptime, not 100%.** A buff on a cooldown is credited at
`min(1, duration / cooldown)`. `Priest_BlessingOfFervor` is fifteen seconds on a
hundred-and-twenty-second cooldown: 13%, not always-on. A buff with no cooldown
behind it — the enchants, refreshed off a proc every few swings — keeps its full
uptime, which is the case the old blanket assumption was actually written for.

**Refused rather than counted.** `Priest_Crusader_Status` carries
`maxStacks: 300` and affixes whose magnitude is a `mod.dynVal` injected by a
script at runtime. Counting it at its cap would credit the build with +3000%
damage, so a status whose payload is a script-set dynVal is reported unmodelled
by name instead.

### Damage over time

**The game types its own statuses**, in `statusType.flags` — `DoT |
CrowdControl | HardCC | HoT` — and that column went unread, so the model's
structural test ("one of its steps carries `props.loop.tick`") had nothing to be
checked against. They agree on **31 of the 33** statuses the game types as
ticking; the two they disagree on (`GA_Demon_Skill2_Status`, `Trap`) would have
been scored as a single lump and are now named. The CC flags do the other half:
the 22 statuses typed `CrowdControl`/`HardCC` give a skill whose whole payload
is a stun its own coverage bucket, instead of it reading as an unexplained
blank. Crowd control is worth nothing here because the simulated foe does not
act — which is the right answer, not a shortfall.

A DoT is not scripted; it is an ordinary `skill` row. `props.status` marks it a
status, `skill.duration` (or the `duration` on the step that applies it) is its
lifetime, one of its steps carries `props.loop.tick`, and the effect on that
step is the amount. `Sword_Swarm_Passive_Swarm` alone is ten ticks of
`0.12*Strength + 0.12*Faith`, and the model used to report it as "its payload is
a status or script effect".

The fight applies them on the event their guard names, ticks them, and expires
them. Re-application refreshes rather than stacks, which is the whole difference
between a 10-second bleed on a 10-second cooldown and the same bleed on a
40-second one.

## 10. Damage

Every point of damage, healing and shielding is emitted by a
`skill.steps[].effects[]` entry:

```
{ effect: Damage|Heal|Shield|GainAtb|Status,
  affinity, baseVal, scaling: [{ratio, atb, conds}], dynVal, flags }

amount = baseVal + SUM(ratio * attributeValue(atb))
```

so the coefficient table is shipped. `steps[].cond` and `scaling[].conds` carry
`minRank`/`maxRank`/`equalRank` gates on the weapon-skill rank (1–3, earned
after `WeaponKills_PerSkillRankPoint` = 20 kills each), which the model
resolves against `--rank`.

Then, in the model:

```
expected = amount
         * DamageModifier/100
         * (1 + critChance * (critDamage/100 - 1))
         * (1 - mitigation)
         * (1 + Fervor)          <- UNVERIFIED
         * (1 + Mastery)         <- UNVERIFIED
```

### Timing

There is **no player global cooldown**. `getSkillRecoveryTime` occurs exactly
once in 47342 functions, as `ent.Foe.getSkillRecoveryTime` (findex 6773), and
only 13 of 962 skills carry `props.interruptStyle`. `Skill_RecoveryTime` sits in
the constant sheet inside the SpawnTime/Aggro/Panic/PathSearch block, between
`Skill_Pick_RetryCooldown` and `Skill_RecoveryTime_Boss`. So it is foe AI, and
adding it to every player cast — which the model used to do — billed a level-25
Priest 0.59 attacks a second for a chain whose own authored durations run at
2.2. That single line was worth **×1.5 on total damage.**

The actor is committed to the cast itself, and not to what it leaves behind:

```
occupancy = max(skill.duration,
                max over CAST steps of (step.delay + step.duration))
            cast steps exclude Area / Aura / Summon / SkillObject / Status
```

Both halves are needed. 40 of the 340 castable damage-bearing skills declare no
`skill.duration` at all, and on 96 of them the steps already run longer than the
authored duration. Excluding the lingering step types is what stops
`Staff_Censer_Skill2` — an 0.35-second cast that leaves a 3-second area behind —
from billing 4.20 seconds and eating a fifth of the clock on its own.

**Numbers can hide in `vars`.** The columns typed `types@props@skillVal` — a
step's `range` and `duration`, a loop's `tick` — hold either a number or a key
into the skill's own `vars`. Reading those as zero silently deleted damage:
`Priest_RadiantVerdict`'s rune-gated step runs for `dur2` = 8 seconds at one
tick every 2, and a zero duration made that one tick instead of four.

**No animation model is needed**, which is the single biggest scope risk this
project does not have: the `anim` sheet has exactly two columns (id, comment)
with no timing data, only 1 of 962 skills sets `anim.duration`, and no
`getAnimDuration` symbol exists in the bytecode. Every delay and duration in
`steps` is explicit seconds.

### How many times a hit lands

One authored effect is not one hit. Three multipliers are fully in the data and
none of them was being read:

| where | what it does |
|---|---|
| `steps[].props.loop.tick` | replays the step every `tick` for its duration — `GS_Nova_Skill1` spins for 3s at 0.25 and lands **12** hits |
| `steps[].props.area.targetCooldown` | caps how often the SAME target may be re-hit — `Priest_Prayer_Smite` ticks 15 times and touches you once |
| `steps[].props.projectile.generation.count` | an `on: ProjectileHit` step fires once per projectile — `Staff_Censer_Combo` is **four** bolts, and its own description says so |

With `loop.flags:SpreadEffects`, or on a `SelfEffect` step, the declared amount
is the TOTAL rather than the per-tick amount — both are stated in the columns'
own `documentation` strings, and the two rules are complements: 0 of the 32
`SelfEffect` loop steps carry the flag, because they do not need it. Reading a
`SelfEffect` DoT as per-tick would give `Bleed` 200% of the victim's maximum
health.

**Target count is NOT in the data.** The geometry is fully authored — shape
(`Circle | Rect(width) | Cone(angle) | Donut(thickness)`), size from the step's
`range`, height, and an expanding `rangeScale` — but nothing anywhere says how
many enemies stand inside it. `unitGroup` describes spawn points and the
`spawner` sheet is empty because placement is level data. So `--targets` is an
input with a default of 1, only `Area` and `Aura` steps scale with it, and
`props.hitCount` caps it where a row sets one. A `Mono` step carrying an area is
treated as single-target: 80 rows do that and their own descriptions disagree
with each other, so the reading that cannot flatter wins.

### The rotation is a fight

Throughput is not a steady state any more. `sim.mjs` plays out a fight of
`--fight` seconds:

- **priority** — at every decision point, press the ready skill with the highest
  damage per second of commitment. The steady state instead assumed every
  cooldown was used exactly on cooldown, and when they oversubscribed the clock
  it slowed all of them down proportionally, which is the one thing no player
  does.
- **charges** — a skill opens with its whole bank and regains one per cooldown.
  That is what a charge IS: the bytecode's event for a finished cooldown is
  `onSkillGainCharge`, singular, and the one rune that hooks it glosses it as
  "each time one of your WeaponSkills recovers its cooldown". So the sustained
  rate stays `1/cooldown` and a charge buys `(charges − 1)` extra casts over the
  fight — a sentence a steady state cannot say, which is why `props.charges` sat
  in the profile unread.
- **statuses tick and expire**, and re-applying one REFRESHES it, so the
  overflow of a long debuff on a short cooldown is lost.
- **the base-attack chain fills the gaps**, one link at a time, because you
  cannot press swing 3 without 1 and 2.
- **procs are events inside the fight.** By default each contributes its
  expected fraction — which is the mean, exactly, without sampling. `--fights n`
  rolls them with a seeded PRNG and reports the mean and the standard deviation
  instead.

The denominator is the fight length, not the moment of the last cast. Getting
that wrong let a build with **no main-hand weapon at all** beat one holding a
sword, because ending the fight early divided its damage by a shorter clock.

### The fight holds state

A cast is priced **at the moment it is cast**, against whatever is up. That is
the difference between a priority list and a rotation, and without it two whole
categories of decision are worth exactly nothing:

- **A debuff on the target.** 37 debuff statuses carry stat affixes and a dozen
  of them amplify damage — `GA_Demon_Skill1_Status` strips a quarter of the
  target's Armor *and* MagicArmor, `Priest_BeaconOfHope_Status_Debuff` makes it
  take 10% more. With a constant target these were free.
- **A buff window.** A buff on a cooldown is not a small permanent bonus; it is
  a window. Averaging `Priest_Judgment_Status` into the sheet at
  `duration/cooldown` makes bursting inside it worth exactly as much as
  bursting outside it.

So self-buffs split in two. The ones with no cooldown behind them — a weapon
enchant refreshed off a proc every few swings — go into the sheet, because they
really are always on. The ones on a cooldown are handed to the fight, which
puts them up when they are cast and expires them. The printed stat block still
shows those at their uptime, because that *is* what a character averages; the
fight does not read that sheet.

Pricing is memoised on the **state signature**, not on the clock: a fight cycles
through a handful of distinct (buffs up, debuffs up) combinations thousands of
times, so this costs about 13% and not 13×.

**A DoT snapshots.** Its per-tick value is fixed when it is applied and does not
follow buffs that come and go while it ticks; a re-application re-snapshots.
Nothing in the CDB states this either way — it is SimulationCraft's convention,
where target debuffs snapshot at cast end and player buffs at impact, and it is
in the audit as an assumption rather than a reading.

### Choosing the order

SimulationCraft's answer to dependency order is an **Action Priority List**: a
human writes `actions+=/spell,if=buff.x.up&debuff.y.remains>2`, the engine walks
it top to bottom every time the player can act, and casts the first available
entry. Its wiki is explicit that there is *"no lookahead or optimization of
action orderings"*. That works because a community writes and tunes the list per
specialisation.

Nobody writes those lists for this game, so the choice is between a greedy order
that cannot see a setup cast and a short rollout that can. `--lookahead`
(default 8s) scores each ready cast by what the next few seconds are worth if
you press it, then falls back to priority order. On synthetic rotations where
the right answer is arithmetic it is worth up to **+97%**: a setup that does no
damage at all always loses a density comparison, and two cooldowns and one short
window never line up by accident.

**It is a heuristic, and a myopic one.** It maximises what lands inside the
horizon while the cost of spending a long cooldown early falls outside it, and
on two of the four classes that made the answer *worse* than plain priority
order. So the fight is played **both ways and the better kept** — both are
rotations the simulator can execute, so the higher of the two is a lower bound
on what a player can reach, and the lower one never was. The output says which
won.

On the builds in this data, sequencing is worth **0–0.4%**, on 22 of about 90
weapons. The player-facing debuffs are mostly movement slows, and the few damage
amplifiers sit on cooldowns long relative to their windows. That is a fact about
this game's numbers, not a limit of the method — the synthetic cases show the
method finding a 2× when the data offers one.

### Reference targets

A target is fully described by the damage reduction it is meant to have at the
attacker's level: feeding `resistForReduction` back through the forward formula
returns exactly that fraction at zero penetration. The default comes from the
game's own `constant.Armor_ExpectedReduction` (0.25), so it is the designers'
reference and not one this tool invented.

| `--target` | reduction |
|---|---|
| `dummy` | 0 |
| `reference` | `Armor_ExpectedReduction` |
| `armoured` | 2× that |

Note the `Dummy` unit *does* exist in the `unit` sheet with MaxHealth 50000 and
zero mitigation, but it is referenced by no `zone` row — it is a dev spawn, not
a placed encounter, so nothing here depends on it.

---

## Why not stat weights

A fixed weight vector gets some comparisons backwards, and here is one that is
computable in closed form from data the tool already loads.

`CritChance` scales `+0.014` per **Dexterity** *and* per **Faith**.
`CritDamage` scales `+0.02` per **Strength** *and* per **Intellect**. For a
weapon that scales equally off both — `Sword_Craft`'s combo is
`0.425*Strength + 0.425*Faith` — the coefficient term is symmetric, so the
tiebreak is entirely the crit side:

```
dM/dFaith    = 0.00014 * (CritDamage/100 - 1)
dM/dStrength = 0.0002  * critChance
```

These cross at **35.0% crit** (at CritDamage 150), 37.8% (154), 42.0% (160).
Below the crossover Faith wins; above it Strength wins. Both sides are
reachable at level 25.

Add the hyperbola in Armor and the 3.8%-per-level rating decay, and any single
weight vector is wrong somewhere. So the optimiser evaluates the real objective
for every candidate instead. It costs more and it cannot get this class of
answer backwards.

## The Fervor question

This is the single assumption that most changes the answer, so it is a switch.

Fervor's in-game description reads *"Increases the damage, healing and
shielding of your Skills. Reduces damage taken by half of that amount."* Two of
those three are verified straight out of `attribute.scaling`:

```
DamageTakenModifier    scaling: [{ attribute: Fervor, scale: -0.5 }]
HealGivenMultiplier    scaling: [{ attribute: Fervor, scale:  1   }]
ShieldPowerMultiplier  scaling: [{ attribute: Fervor, scale:  1   }]
```

The offensive half lands on **no attribute at all** — `DamageModifier.scaling`
is empty. So it is a code-only path, and `--fervor-scope` picks the reading:

| `--fervor-scope` | |
|---|---|
| `skills` (default) | it multiplies skills, matching the words "your Skills" |
| `all` | it multiplies base attacks too |
| `none` | it does not touch damage; only the three verified consumers apply |

Note that `HealGivenMultiplier` already carries Fervor, so healing must not have
it applied a second time — that one is verified and lives in the sheet.

Worth knowing what this cost before the rotation was modelled properly: with
skills ignored, base attacks were the only damage, Fervor was the only
multiplier that touched them, and the optimiser dressed a Priest head-to-toe in
Fervor gear. With prayers, weapon skills, procs and enchants scored, the same
search picks **SpellPenetration** across every slot and Fervor drops to noise.
The rotation model, not the Fervor switch, was what made that answer wrong.

## Stat profiles, and why they exist

The best rotation depends on the weapon, the talents, the runes and the stats.
The best gear depends on the rotation. Searched together that is one problem with
two moving halves, and the gear half is the expensive one — twenty thousand
loadouts, where a rotation search wants thousands of fights *per* loadout.

A profile replaces the armour with a fixed, named stat sheet, so a weapon or a
rotation can be compared with nothing else moving. The numbers are the ones
already established elsewhere in this document:

- `budget(level, start, end)` off `aptitude.atbScaling` for primary, vitality and
  the ratings;
- `resistForReduction(level, props.armorReduction)` for armour, because the
  authored Armor columns are dead ([§3](#3-armor-is-design-intent-not-a-number));
- and `itemType.atbRatio` summing to **exactly 1.0** per stat group over one item
  per core slot ([§6](#6-what-an-item-is-worth)), which is what makes one budget
  a *complete set* rather than an arbitrary amount.

So `full` is a perfect set and `crit` is the same set with the whole ratings
budget in one place. One budget is split across whichever ratings your factions
pay, so the three rating rows a class shows are one 100%, not three.

**1.0 is the designers' unit, not the ceiling.** A maxed build runs above it: a
Legendary roll puts an item's effective level above the character's, augments add
on top of the budget rather than inside it, and the arsenal contributes 0.4 of a
second weapon. A level-25 Warrior the optimiser dressed reads 469
ArmorPenetrationRating against the 380 one budget delivers, so `--profile-scale
1.25` brackets it from the other side.

**A corner gear cannot reach is still worth probing, and says so.** An item pays
the WEARER's aptitude, so a Warrior gets Strength and never Faith, and
`conds.factions` on the Fighter's rating rows lists no faction at all for
SpellPenetration. Those profiles are marked as probes rather than builds — but
they answer a real question, which is whether a weapon's kit scales off a stat
its class never gets.

### What it measured

`bench weapons --across` runs every mainhand at six corners. On this data, above
the naked corner:

| | |
|---|---|
| weapon ranking | mean shift **0.3–0.6** places out of 13, worst 3 |
| which two skills to slot | **identical at every corner**, on all eight weapons checked |
| talents | 3–4 different sets across six corners |
| runes | 2–4 different sets |

Naked is the one corner that reorders the top — `GS_Nova` wins with no gear on
and `GA_Craft` wins everywhere else — which is worth knowing and is not a
surprise: with no ratings at all, a weapon's raw coefficients are the whole
story.

So the weapon and its skills are **one decision that does not depend on your
gear**, and the tree and the runes are re-decided per stat corner. That is the
shape a rotation search should be built to, and it is a measurement rather than
an assumption.

## The search

Coordinate ascent with exhaustive per-slot enumeration: walk the free
decisions, and for each one try every legal option with everything else held
fixed, keeping the best. Stop when a full pass changes nothing.

A slot has 2–27 candidates, a build has ~15 slots and up to ~10 sockets, and
convergence takes 3–9 passes. Around 20,000 distinct loadouts and a few seconds.

Gear is optimised before augments in every pass, because gear decides which
sockets exist. Coordinate ascent finds a *local* optimum and the interactions
here are real, so the search restarts from several seeds (`--restarts`) and
keeps the best. Restarts use a seeded PRNG — never `Math.random` — so a build
you share can be re-derived.

Three things had to be added before it found what it was walking past, and all
three are the same mistake in different places: **a decision was being scored
against a build that had not been allowed to answer it.**

**The tree the gear is fitted to.** Talents are allocated inside the loop, and
the in-pass allocation is a cheap heuristic that ranks a point by the size of
the numbers on it. That heuristic counted affixes, buffs and effects and nothing
else — a fair reading of the Priest tree and a blind one on the Warrior's, which
is almost entirely scoped modifiers and pool dots. Hemorrhage, the root the whole
class is built around, weighed exactly zero, and the heuristic allocation landed
**28 dps** below what ranking by the real objective picks. Every gear comparison
in every pass was made against that tree, and the objective allocation used to
arrive once, after the last restart, when nothing could respond to it. Now the
tree is re-cut against the objective whenever the ascent converges, and the loop
carries on if that moved anything.

**The allocation itself.** A greedy that walks tiers in order cannot revisit a
decision, and thresholds mean the first four points in a branch decide which
seven nodes are even reachable. So points are moved one at a time — out of where
they are, into anywhere legal — until none improves.

**Which rating you are building for.** Penetration has *increasing* returns:
damage through armour is `K / (R(1−p) + K)`, so each point is worth more than the
last. A build in crit gear loses by swapping one slot to penetration even when
swapping all nine wins, and every single-slot step between the two sets is
downhill. Random restarts do not find that and coordinate ascent cannot walk to
it, so the seeds now include **one per secondary rating the class can wear**,
with every armour slot filled by a piece that pays it. Weapons are left out: a
weapon is chosen for its kit, not its faction, and theming those slots seeded a
shield into the offhand and forbade every two-hander for the whole restart.

And a sigil is scored with the talent it grants. It carries nothing else, so
comparing two sigils by the score of the trial compared two identical builds.

## Drop rarity

Rarity is **not** a property of an item id. `st.Player.dropLoot` (findex 3836,
`@src/st/Player.hx:328-331`) picks it with a weighted random draw over
`rarity.props.generationChance`, banded by level and filtered to at least the
item's authored rarity — which is why a CDB-`Rare` sword can be sitting in your
bag as Legendary.

So the honest ranking unit is **(item, rarity)**. `--rarity-roll` expands each
candidate into one row per attainable rarity with its drop chance shown. It is
off by default because it triples the search space and turns a definite answer
into a probabilistic one — the right trade when the question is *"what should I
chase"*, not *"what should I wear"*.

And how high a roll can go is **not declared anywhere**. The seven columns
typed on rarity are an item own rarity, conds.minRarity, per-rarity atbRatio
overrides, icons, recipe models, enchant materials and scrap quantities;
lootTable carries no rarity at all; there is no RarityKind custom type; and
WeaponRarityChances_Low is an empty stub with only a 0-10 level range in it. So
the ceiling is a content decision in code. Two derivations stand in for it, and
both move on their own when the data does:

* weapon slots take the highest rarity flagged AllowRandomWeaponDrop - the one
  thing in the database that names the weapon/non-weapon split at all. That is
  Legendary.
* every other slot takes the highest rarity actually AUTHORED on a stat-bearing
  item that fits it. Requiring an aptitude keeps shop cosmetics such as
  Head_Shop, which are Epic and grant nothing, from raising it. That is Rare
  today, and it becomes Epic by itself the day a patch authors an Epic chest.

bench rarity prints both alongside the raw table, so a patch that moves either
is visible rather than silently absorbed, and --rarity-cap overrides them.

Level bands, from the sheet:

| rarity | L1–10 | L11–30 | L31–49 | L50+ | iLevel bonus | max stars |
|---|---|---|---|---|---|---|
| Uncommon | 40% | 30% | 15% | 0% | 0 | 2 |
| Rare | 60% | 50% | 59% | 60% | +10 | 3 |
| Epic | 0% | 19% | 25% | 35% | +30 | 4 |
| Legendary | 0% | 1% | 1% | 5% | +50 | 5 |

Worth knowing: **no combat item in this build is authored above Rare.** The 138
Epic-authored equippables are gliders and shop cosmetics. So at level 25 an
Epic or Legendary version of a piece only exists as a roll.

---

## 14. What the script readers take, and where to pick up

Everything below is read out of hscript text. The rule throughout is the same
and it is the one this project keeps relearning: **match a shape, evaluate what
the build can answer, and REFUSE the rest by name.** Every reader here was
first written too permissively and caught by a class sweep — a per-cast damage
multiplier read as a permanent stat took a Mage to 6,000 dps, an unrecognised
guard defaulting to "unconditional" took a Priest from 249 to 380, and pooling
every dot that declares a total reached 44,000. Widen one of these and re-run
`optimize` on all four classes before believing the result.

| shape | read as | lives in |
|---|---|---|
| `addStatus(who, Skill.X)` | a status, and who wears it | `skills.statusesOf` |
| `addStatus(t, X, hit.amount * vars.f)` | a POOL dot worth `f` of the hit | `POOL_LOCAL` / `ADD_STATUS_3` |
| `addAtb/addResource(Atb, vars.n)` | resource income, on the events its guard names | `resourceGainsOf` |
| `x.dmgMult += vars.n` (unguarded, on a status) | a `DamageModifier` affix | `DMG_MULT` |
| `x.{dmgMult,critDmgMult,critChance,armorIgnore} += vars.n` | a SCOPED modifier | `talentModifiers` / `DMG_FIELD` |
| `setDynVal(1, x.amount*vars.n); playStep(Steps.Heal)` | a healing share | `HEAL_SHARE` |
| `setDynVal(1, <number>); playStep(Steps.X)` | the amount step `X`'s `dynVal` effect was missing | `damage.scriptDynVals` |
| `setDynVal(1, owner.maxHealth*vars.n); playStep(Steps.X)` | the same, as scaling on `MaxHealth` | `damage.scriptDynVals` |
| `reduceWeaponsCooldown(vars.n)` on a tick | `CooldownReduction`, via the dot's tick interval | `CD_PROC` |
| `evalCost` → `val -= vars.n` under `hasMastery` | a rune cutting a cast's cost | `damage.costRelief` |
| `x.dmgMult += vars.n` under `hasMastery` | a rune's damage bonus on its own skill | `damage.runeDamage` |

**What a guard may say.** `rank >= N`, `hasTalent`, `hasMastery` and `critical`
are all EVALUABLE — the build knows its rank, its talents, its runes, and the
fight computes crit expectation. `totalHits == 1` is answerable too, because
that is what `--targets` says. Everything else — `hasStatus`, `getStatusCount`,
`healthRatio`, `isInCooldown` — is live state, and a call site guarded by one
keeps its rate refused and named. `scopeOf` is the gatekeeper: it strips every
predicate it understands and refuses if anything condition-shaped survives.

**Three more, because a guard is not always a condition.**

`x.kind == Y` reads three different ways and only one of them is a question:

| | |
|---|---|
| `s.kind == Steps.Area` | a dispatch on which step of this skill's own cast fired. The step always runs, so this is not a condition at all. |
| `s.kind == Unit.Summon_Bee` | who was hit; already refused by the "hands it elsewhere" test. |
| `s.kind == Skill.<status>` | a **dependency**. The handler fires when something else applies that status. |

The third went unread, so the guard evaluated to "unconditional" and the payload
was credited whole. `Warrior_Talent_HoldTheLine` is the case: +6% damage and −6%
damage taken *while `Warrior_Talent_RageShield_Status` is up*, and Rage Shield is
a separate node in a different branch that the build may simply not have taken.
That was 22 dps for a talent whose own text says "while ::ref2_name:: is
active". It is answered rather than refused, because the loadout knows: a
whole-sheet index says who applies each status, and where **every** applier is a
talent node the allocation is the complete list. Anything else stays unknown and
is left alone — `Priest_Talent_PotentFortitude` waits on the Shield prayer, which
is not a node, so it keeps its credit. Four nodes across three trees have this
shape.

`dmg.isStatusType(Bleed)` is **not** the live-state question the refusal list is
aimed at. It says which damage event this is, exactly the way `isBaseAttack`
does; `hasStatus`, `hasStatusType` and `hasStatusMaxStacked` are the ones that
ask what is up right now. So a roll guarded by it rides the bleed's **own
ticks**, and `Warrior_Talent_CrackingBlood` was otherwise going to be read at the
base-attack rate — several times too fast — if it had been read at all. Two
skills in the sheet have this shape and both are Warrior talents.

`setDynVal(n, …); playStep(Steps.X)` names both the slot and the amount for an
effect that declares neither. Fourteen sites do it; three of them hand it a
number the data carries (a literal, `vars.x`, or `owner.maxHealth * vars.x`) and
the rest hand it a share of a hit, a share of **current** health, or a script
local accumulated over the cast. Those keep their zero and stay named. What the
three buy: `Last Stand` heals 35% of MaxHealth, `Fury Pulse` generates its Rage,
and both runes previously read as doing nothing at all.

### Where to pick up

**Unfinished on the Warrior**, all for stated reasons rather than for want of
looking:

| | why |
|---|---|
| Rage Shield | `Shield 0.05 × MaxHealth`, applied whenever a Hemorrhage-type status lands. The applier's own guard is `!hasStatus(owner, …)`, an internal marker whose duration is not in the data, so there is no rate to put on it. It is not inert in the model even so: **Hold the Line reads it**, and that dependency is now the difference between a Right-branch build worth +23 dps and one worth nothing |
| Surge of Violence | "your NEXT Raging Smash is free and crits" — needs a per-cast register the fight does not carry. Worth roughly 1.7%: about one Raging Smash in five, which is a guaranteed crit and 9 Rage back |
| Crippling Bloodloss, Second Wind, Fortitude | act on damage the enemy deals; the simulated foe does not act |
| Execution, Into The Fray | gated on target health or on enemy counts the fight does not track per cast |
| Battle Momentum | `totalHits >= 3` is answerable from `--targets`, but the count reaches the guard through a script local assigned in a different handler, so the number is not read |
| Melee Fever, Enduring Defenses, Hold On! | need kills, blocking, or a party |
| Overwhelming Rage | **no script, no vars, no affix, no step.** Its text is the only statement of what it does, and the skill it modifies unlocks at level 30 |

**What the Warrior tree now reads**, for contrast, because the list above is
short only because the list below got long: Hemorrhage and Infused Wound as pool
dots, Bloodletting / Exsanguination / Sever / Master-at-arms / Bruise / Magic
Conduction as scoped modifiers, Exposed Essence as penetration, Seasoned Soldier
as Rage income, Red Tempo as cooldown earned back per bleed tick, Cracking Blood
as a roll against each of those ticks, Bloodfeast as a share of the bleed healed
back, Hold the Line once Rage Shield is in, and Fighting Spirit / Rash Soul /
Zealous Warrior off ordinary affix rows. Sixteen of sixteen points land on
something the model can value.

**The other three classes have not been audited node by node.** Priest, Rogue
and Mage gained from the shared readers (+1.4%, +4.6%, 0%) because the generic
patterns matched, not because anyone checked them against the game. The readers
refuse what they cannot classify, so the exposure is under-reading rather than
over-reading — but it is unverified, and the Warrior tree only became correct
because it was walked one node at a time against a real character.

## Verified, assumed, absent

**Verified from the bytecode** — the level curve, the rating conversion and that
`scale` is ignored, the armor inverse and the mitigation formula, the
composition order, the effective-level arithmetic, the absence of a player GCD,
the absence of animation timing data, that item affixes have no RNG (findex
20747 makes zero random calls), that rarity is rolled at drop.

**Assumed, and flagged in `bench audit`:**

| assumption | why it is a guess | how to settle it |
|---|---|---|
| Fervor multiplies damage by its own percentage | Its in-game description says so, but `DamageModifier.scaling` is **empty** and no attribute takes a scaling entry from Fervor except `DamageTakenModifier` (−0.5), `HealGivenMultiplier` (+1) and `ShieldPowerMultiplier` (+1). The offensive half is a code-only path. | disassemble `ent.Unit.computeDamage` (findex 4841) |
| the two Masteries multiply matching-affinity damage | Same shape of hole. Currently **inert**: both are zero from every source in this build. | same |
| `WeaponPower` = the MAIN-HAND weapon's share of the class primary budget | It has no scaling entry and no budget group, so the weapon must set it — 67 mentions across the whole CDB and three strings in the binary, none of them a setter. `constant.WeaponPowerRatio`'s description — *"Percent of AP/SP scaling that are replaced by a flat amount coming from weapon"* — is consistent but does not confirm it. Every base attack scales off it. It used to sum BOTH weapon slots, so equipping an arsenal raised every swing by 40% for a slot that grants no swings. | disassemble the weapon-equip path |
| a cast costs only its own authored duration | `Skill_RecoveryTime` reads as foe AI from its position in the constant sheet and from `ent.Foe.getSkillRecoveryTime` being its only symbol, but bare `recoveryTime` / `get_recoveryTime` symbols exist and have not been placed. `ComboWindow` 0.6 and `AttackQueueTime` 0.4 are consistent with a chain that runs back to back. | disassemble the cast path |
| how many enemies an area hits | Fully absent from the data — geometry is authored, population is not. `--targets` is an input, defaulting to 1. | measure in game |
| a `Mono` step carrying an area does not cleave | 80 rows do it and their descriptions disagree; single-target is the reading that agrees with 87% of them and cannot flatter. | `forceMono` in the binary |
| a re-applied status refreshes rather than stacks | `stackingPolicy` is authored on 11 of 250 status rows. | disassemble the status path |
| `LinearRatio` behaves like `Flat` | No row in this build uses it. | wait for one, then check |

**Absent entirely** — most of what a skill script does. 427 of 962 skills carry
hscript bodies, and four things are read out of the text because the data
records them nowhere else: the status a skill applies (`addStatus`, through a
local alias if it uses one), the event that applies it (`isWeaponSkill`,
`isBaseAttack`, `isFinalCombo`), the roll that guards it
(`checkProba(vars.chance)`), and `vars.chance` itself. Everything else is not: a
magnitude passed as a third `addStatus` argument (`Warrior_Hemorrhage` bleeds
for 35% of the hit that applied it), a `setDynVal` injection, a conditional
rider. Those are named in the output rather than counted at zero in silence.

Also absent: per-swing variance (`WeaponAttack_RandomRange` = 0.1 exists but its
only located read is a UI text path), party buffs (`Group_MaxPlayers` = 4),
consumables (4 slots, 80 items with effect props), threat, crowd control (a stun
has no damage, no affix and no duration of its own — scoring it needs a fight
model with a foe that acts), and every non-combat slot.

**And the one that matters most:** none of this has been checked against the
running game. Every formula was read statically out of `data.cdb` and
`hlboot.dat`. "The bytecode says X" and "the process does X" are different
claims, and only the first is established.

---

## 12. Checked against the game

Everything above this section was read statically out of `data.cdb` and
`hlboot.dat`. This section is the exception: it is the one place where the model
has been compared with what a character sheet actually shows, and it corrected
two things the static reading had wrong.

### A whole character sheet

A level-25 Warrior with **no equipment, no talents and nothing slotted**, read
off the game's own sheet. The first reading that covers the entire sheet rather
than one item, so it pins the level curve, the rounding rule and every derived
stat at once — all 14 values now reproduce exactly, and the suite asserts them.

| | Vit | Str | Dex | Faith | Int | Crit% | CritDmg | Dodge |
|---|---|---|---|---|---|---|---|---|
| game | 38 | 34 | 28 | 28 | 28 | 5.8 | 151.2 | 0.3 |

It corrected two things.

**`RoundUp` rounds; it does not ceil.** The raw curve values are 33.974, 28.091
and 38.211 against a game showing 34, 28 and 38. Ceiling matches one of the
three, flooring matches two, **rounding matches all three** and is the only rule
that can. Ceiling put every primary a point high on a naked character, and
because `CritChance` scales `+0.014` per Dexterity *and* per Faith, the error
propagated into the derived stats too.

**The printed sheet is the RESTING one.** Crit read 8.3% against the game's 5.8
because `Warrior_BattleShout`'s +20 CritChance, on a 120-second cooldown, was
averaged in at its 12.5% uptime. That average is a useful number and it is not
a character sheet — anyone comparing the tool to their own was comparing against
a different question. Both are computed now: `sheet` is what the game shows you
standing still, `averaged` is what the fight sees, and survivability reads the
latter because a defensive cooldown you press is real mitigation.

Two skill tooltips from the same character confirm the coefficients:
`Raging Smash` reads 55 against `1.6 × 34 = 54.4`, and `Surging Force` reads 23
against `0.6 × 38 = 22.8`. Both are consistent with damage being **ceiled** for
display; Raging Smash is the discriminator, since rounding would show 54.

### The class-skill bar is a choice

Every class declares **six** `ClassSkill` rows, at levels 3, 5, 10, 15, 20 and
30 — so at the level-25 cap you have learned five, and **four fit on the bar**.
Confirmed in game. That count is not in the data; it is `CLASS_SKILL_SLOTS` with
a `--class-skills` override, the same treatment the 16 talent points get.

Handing out all five was a free cooldown. The pool is now a decision the search
makes and prints, exactly like which two weapon skills to slot.

**Berserk is why it mattered.** Its description reads *"increase all damage done
by 20% **and** Rage generated … by 1"*, and the model read only the Rage half —
the +20% lives in an `onInflictDamageEval` one-liner and in a `CustomProperty`
affix carrying a bare 20 with no target attribute. So Berserk looked like a Rage
cooldown and the search dropped it from the bar. Reading an **unconditional**
`x.dmgMult += vars.n` on a status as a `DamageModifier` affix fixes it, and
Berserk is now taken over Battle Shout.

Only unconditional ones. About sixty sites carry that shape and most sit inside
a branch — `DS_Bladeleaf_Combo_Status` buffs only weapon skills,
`Bow_Craft_AttackCombo_Status` only its own combo — and reading those as
permanent stats took the Mage to 6,000 dps.

### A pool dot banks BASE damage, and its ticks are multiplied live

**Checked in game.** A bleed already ticking at 100 goes to **120** the moment
Berserk is pressed, with no new critical strike. So the multiplier is not baked
in when the pool is fed — the pool holds base damage and each tick is worth
whatever is up when it lands.

That is why `castOutput` divides `DamageModifier` back out when it feeds a pool,
and the total is multiplied by the **averaged** sheet's `DamageModifier` at the
end: the ticks are spread evenly across the bleed's life and a damage buff is up
for a known fraction of the clock, so the average is exactly the right
multiplier for a total banked without one.

**And the buff is not baked in at application either.** Two readings from the
game, one of them the awkward case:

| | |
|---|---|
| hit 241 with no buff | bleed ticks **21**; pressing Berserk takes the same bleed to **26** |
| Berserk first, hit 380 | bleed ticks **30**, and drops to **25** when Berserk expires |

The first pins the coefficient: `241 × 0.35 / 4 ticks = 21.09`. The second pins
the mechanism — `30 / 25 = 1.2` exactly, so a bleed created *inside* the window
loses the bonus when the window ends. Nothing is banked; the pool holds base
damage and the multiplier is always live, which is what this model does.

One loose end: the second reading's absolutes come out about 10% under either
prediction, which is the size of the gap you would expect if the hit number the
game displays is itself already buffed. The model assumes it is, and divides
`DamageModifier` back out before banking. A precise pair of numbers — one hit
and its bleed tick, with no buffs up at all — would confirm it.

### Hemorrhage pools; it does not refresh

On record from the game, and **not yet implemented**, so it is written down here
rather than half-applied:

> A 200 crit banks `200 × 0.35 = 70` damage over 8 seconds, four ticks of 17.5.
> Crit again for 100 two ticks later and the 35 still owed is **added** to the
> new 35, redistributing 70 over a fresh 8 seconds.

So the remainder is carried, not dropped — which is neither the `refresh` the
model does nor the `stack` it refuses. Generalising it to every dot whose
declared amount is a total takes the answer to **44,000 dps** on a Mage: those
are applied on every swing, so a pool that never drops its overflow never
bounds. Hemorrhage is bounded in game because it is gated on a critical strike,
and the model cannot read Hemorrhage at all yet — its magnitude is a script
argument. The rule waits for the applier whose rate makes it finite; `d.pooled`
already marks which dots it will apply to.

**The reading.** `Spear_Eruption` — "Gorgon Ratsay's Toothpick", Rare, Kobold
faction, aptitudes `[Assassin, Cleric]` — on a level-10 instance, which with
Rare's `+10 iLevelBonus` is effective level 11:

| | Vitality | Dexterity | Faith | Critical | Armor Pen |
|---|---|---|---|---|---|
| main hand | 36 | 18 | 15 | 39 | 39 |
| arsenal | 15 | 8 | 6 | 16 | 16 |

**What it settled.** All ten numbers fall out of three rules, and each rule is
discriminated by at least one of them:

1. **A tooltip shows every aptitude's reading, summed.** Dexterity 18 is
   Assassin's primary budget (36..648) and Faith 15 is Cleric's (30..540) — a
   1.2 ratio that matches the budgets exactly. Vitality is the sum of both
   MaxHealth budgets. The two ratings are the clearest illustration of the
   faction rule: Assassin reads Kobold as ArmorPenetration and Cleric reads it
   as CritChance, so one Kobold `AssCle` spear shows both at 39, each at the
   full `ratings` share rather than a split.
2. **Each aptitude's share is rounded on its own, then summed.** Rounding per
   aptitude gives Vitality 16 + 20 = 36; summing first and rounding once gives
   35. The reading says 36.
3. **The arsenal factor is 0.4 with a ceiling.** `ceil(v * 0.4)` is the only
   combination reproducing all five arsenal values; `round` gives 14 and 7,
   `floor` gives 14/7/15/15, and 0.5 is not close. The ceiling is why the
   arsenal *feels* halved.

**What it did NOT settle, and what a second reading corrected.** This is an item
tooltip, and a tooltip has no wearer. Read as a character sheet it says a
dual-class item pays both budgets — and that produced a level-25 Priest with 453
Vitality, a near-full Intellect budget *and* a near-full Faith one, and a
physical damage reduction of 40.3% for a class whose own `props.armorReduction`
row says 0.25. A real level-25 character with decent gear sits at **193
Vitality**. So the wearer takes one aptitude's half, and the tooltip's union is
kept as an explicit `allAptitudes` mode — see [section 6](#6-what-an-item-is-worth)
for the `atbRatio` sums that pin it.

`test/run.mjs` asserts all ten values in tooltip mode, the single-aptitude half
a Rogue actually receives, the Corrupted Gift's -20/+20 → -8/+8, the four
`atbRatio` group sums, and that a full set lands a Priest on its declared
armour reduction — so a regression on any of them fails the suite by name.

**The chain length, confirmed.** `Scepter_Flamie` swings **3 times and then the
combo finisher** — four links, which is what its moveSet's `comboLength` says
and not what its own item row lists. So the item row is incomplete and the game
resolves the rest from the weapon type, and the two links filled in
[section 9](#the-chains-length-is-authored) are the right ones. `DM_Multispin`
is filled by the same rule and the same evidence (`DM_Base_Attack4` is the only
chain-link row no weapon references), but it has **not** been observed.

**Weapon mastery, confirmed.** A weapon levels with kills; each of its skills,
passives included, takes two upgrades; so a skill is rank 1, 2 or 3 and a fully
mastered weapon is every skill at 3. `--rank` defaults there.

**Also confirmed by observation, not derivation:**

- the main hand grants every skill it has, plus the combo attack;
- an equippable offhand grants full stats and every skill it has;
- the arsenal grants **two** skills, chosen, and the weapon passive counts
  against those two — which is why `--skills weapon2=...` exists;
- the combo attack cannot be performed with the arsenal weapon.

To reproduce a reading yourself, pin the instance level:

```bash
bench sheet --class Rogue --level 25 --pin 'weapon1=Spear_Eruption^10*0'
```

---

## 13. What the world actually resists

Penetration is worthless without knowing what it is penetrating, and the answer
is fully in the data: foes express armour the same way the four classes do, as a
target damage **reduction**, in
`unit.stats[].specScaling.armorReduction` and `.magicReduction`. Feeding that
through `resistForReduction` and back returns exactly the stated fraction at zero
penetration, so a target is completely described by two numbers - and both are
authored, not invented here.

27 units declare an intent and the rest inherit it up the `unit.inherit` chain,
which resolves for 420 units. The ladder the world is built on:

| tier | reduction | who |
|---|---|---|
| `W_Assassin` | 0.20 | world assassins |
| `W_Base_Small`, `D_Base_Small`, `W_Assassin_U` | 0.25 | small mobs |
| `W_Base` | 0.30 | world trash |
| `W_Base_Big`, `W_Base_Unique`, `D_Base_Big` | 0.35 | big and unique mobs, dungeon mobs |
| `W_Base_Elite` | 0.40 | world elites |
| named bosses | 0.40 | Ratsar, Mokshi, Crabgantua, Phrixes, Cleodora, MunsterChuck, Ulserous, DemonSuperElite |
| `Dummy`, `PunchingBag` | 0 | dev targets |
| `PunchingBagArmor` / `PunchingBagMagicRes` | 0.5 / 0 and 0 / 0.5 | dev targets, the only split ones |

Two consequences, and both change how you gear.

**Physical and magical reduction are equal on every real foe.** Only the dev
punching bags split them. So `ArmorPenetration` and `SpellPenetration` are worth
exactly the same against everything currently in the game: which one you want is
decided by your class and your gear's faction, never by the fight. The test suite
asserts this, so a patch that starts splitting them fails by name - and that is
precisely when a gearing tool needs to be told.

**`Armor_ExpectedReduction` is softer than what you fight.** At level 25:

| target | reduction | armour | damage through | at 50% pen | gain |
|---|---|---|---|---|---|
| `reference` (the constant) | 0.25 | 962 | 75.0% | 85.7% | **+14.3%** |
| `trash` | 0.30 | 1236 | 70.0% | 82.4% | +17.6% |
| `big` / `dungeon` | 0.35 | 1553 | 65.0% | 78.8% | +21.2% |
| `elite` / `boss` | 0.40 | 1923 | 60.0% | 75.0% | **+25.0%** |

Penetration is worth nearly twice as much against a boss as against the
designers' reference constant, which is why the default `--target` is `boss` and
not `reference`. `--target` also accepts any unit id whose intent resolves.

**Not modelled.** `unitType.props.resistance` is an affinity-level resistance
hook and only `Bee` uses it (`Honey`), so it is inert today - and since every
magic sub-school is empty (§4), an affinity resistance would have nothing to
attach to anyway. Foe level comes from `--level`; the 125 `zone` rows carry
levels 1..25 if a specific one matters. And `specScaling.playerCount` scales boss
health and add counts with party size, which the model does not carry.
