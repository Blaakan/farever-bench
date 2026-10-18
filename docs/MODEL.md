# The model

Where every formula came from, what is verified, and what is still a guess.

Farever ships `hlboot.dat` as **HashLink bytecode with full debug info** -
version 6 since the September 30 update (build 25782799): on the hotfix
build installed as this is written (25959898) 1743 source filenames and
per-opcode line numbers across 48068 functions (`node bin/hl.mjs info`;
1742 and 48047 on 25782799). So the citations below are to real functions and
real source lines, and any of them can be re-checked after a patch with a
disassembler. Every `name@findex` in this file is checked by the suite against
the installed build.

**One limit, new with that build, and it runs through the whole document.**
The client no longer carries its server half: 202 functions do nothing but
`throw "!isServer"` (181 of them are three ops long, the rest a
default-argument preamble in front of the same throw; counted with
`drift.throwOnly` over all 48047 on 25782799, and the same 202 and 181 over
the 48068 of 25959898), and `ent.Unit.applyDamage`,
`ent.Unit.receiveDamage`, `ent.Unit.applyEffect`, `GameObject.addStatus`,
`Status.refresh`, `BaseSkill.applyAffixes`, `BaseSkill.playStep` and
`st.Player.dropLoot` are among them. A rule this file says was read in one of
those bodies was read on the **2026-08-11 build** and cannot be re-read on
this client; each such sentence says so where it stands. What the client
still carries is the shared code - the scaler, the context a hit is priced
in, the unit merge, the loot roll - and that is what the 2026-10 reads cite.

Three words are used on purpose from here on: **READ** (a cdb row, a script
or the bytecode says so), **MEASURED** (the running game did it, with the
capture or the reading named and its n), **ASSUMED** (a stated convention, or
a bridge between two reads). Where a section mixes them, each sentence says
which it is. The 2026-10 rules are collected in
[the September 30 update](#the-september-30-update-build-25782799) at the end;
the numbered sections above it were written against the 2026-08-11 build and
are corrected in place wherever that update moved them, with the older fact
kept as dated history.

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

`ent.Unit.getAtbScaling`, findex 4880, `@src/ent/Unit.hx:1398-1437`:

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
  +0.0526pp of crit (20 / 379.87) and +1 ArmorPenetrationRating is +0.1316pp.

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

`ent.GameObject.getAffinityDamageReduction`, findex 4582,
`@src/ent/GameObject.hx:862-916`:

```
R'        = totalResist * (1 - clamp(armorIgnore, 0, 1))        // its own multiply
R'        = R' * (1 - clamp(penetration, 0, 100) / 100)
reduction = R' / (R' + 385 + 100 * attackerLevel)
reduction += sum(affinity.reductions)      // flat, added to the FRACTION
reduction = max(reduction, 0)              // floored, never capped at 1
```

Four details that are easy to get wrong:

- The level term is the **attacker's** level, not the defender's. The pool
  `totalResist` is built at the **target's** level, so a target is a rating at
  a level and not a percentage ([§13](#13-what-the-world-actually-resists)).
- `armorIgnore` and penetration are **two multiplies** on the pool, not one
  sum (ops 133-147 physical, 81-95 magic, then penetration at ops 259-263).
- `affinity.reductions` (`MagicReduction`, `Resilience`) are added to the
  resulting *fraction*, not to the resist pool.
- `Raw` affinity returns 0 immediately, bypassing everything - and since
  build 25782799 so does a hit a script flags `ignoreResistance`: ops 8-11
  jump past the resistance loop (ops 12-43), while the flat `reductions` loop
  (ops 289-319) still runs. READ, not measured; two scripts write the flag,
  Groundswell Strike (`DA_Water_Skill2`) and Aimed Shot (`Bow_Craft_Skill1`),
  both from weapon rank 2, both with the rank text "Ignores [Armor].".

`affinity` is a two-level tree and **every sub-school is empty** on build
25782799 - Fire, Water, Nature, Wind, Chaos, Light, Cheese, Shadow, Spark,
Honey, Flower, Lava and Electric inherit from `Magic`; Violence and Earth
inherit from `Physical`; none of the fifteen authors a resistance, a
penetration or a reduction of its own. (`Air` was a row until that build;
`Wind` and `Electric` arrived with it.) So there are exactly **three**
mitigation paths today, not eighteen. If those columns ever get populated,
that is a real balance change worth watching.

| affinity | resist | penetration | flat reductions |
|---|---|---|---|
| `Raw` | — | — | — |
| `Physical` | `Armor` | `ArmorPenetration` | — |
| `Magic` | `MagicArmor` | `SpellPenetration` | `MagicReduction` |

## 5. Attribute composition

`ent.Unit.atb`, findex 4875:

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

941 of the 1076 equippable rows on build 25782799 author no affix at all (it
was 459 of 508 when this section was first written): they are pure stat
sticks whose stats are **stored nowhere**. They are computed at equip time:

```
amount = budget(effectiveLevel, entry.start, entry.end) * atbRatio[group] * affixFactor
```

- `entry` — a row of `aptitude.atbScaling`, gated by `conds.minRarity` and
  `conds.factions`. **Every named aptitude pays — read off the character sheet
  2026-08-01:** a naked level-25 Warrior at 38/34/28 Vitality/Strength/Dexterity
  equips Cheese Moon (Fighter+Assassin, tooltip +36/+15/+18 with both ratings)
  and the sheet reads exactly **74/49/46** — every tooltip line, including the
  Assassin's Dexterity the earlier own-half rule refused a Warrior. Tear's
  measured 75 prices on that Dexterity too, so the combat pipeline agrees with
  the sheet. Each aptitude's share is rounded on its own before any sum; that
  is a one-unit difference and the game agrees.

  **ARMOUR is the exception and pays once.** Its budget is
  `resistForReduction(level, the wearer's props.armorReduction)` — no aptitude
  in it — so a second aptitude paying it would double the one stat that cannot
  double; the full-set reduction invariant (each class lands at its own
  declared reduction in level-appropriate Rare gear) still holds and is still
  asserted.

  The `itemType.atbRatio` identity — one item per core slot sums to exactly
  1.0 per stat group — remains true, but it is a statement about the design
  budget of a full single-class set, not about what a dual-class row pays: a
  dual-aptitude item really does carry roughly two budgets of primaries and
  ratings, and 344 of the 638 aptitude-bearing rows name a class pair (271 of
  513 before the 2026-10 build added an Epic tier). An earlier
  both-halves model reading 453 Vitality where a real character sat at 193 was
  wrong for that era's other reasons (armour doubling among them), and the
  own-half rule it spawned survived until a sheet was finally read with a
  single known item equipped.

  **Generic aptitudes** — the five nameless rows `Crit / ArPen / MaPen / Fervor
  / Vita` that jewellery uses — pay like every other aptitude: all of them,
  each divided by how many the item names (the game's own bake, below under
  "A generic aptitude is not a choice"). The paragraph that stood here until
  2026-08-02 said an item naming only generics pays exactly ONE of them, a
  decision rather than a sum; that rule is retired and kept only as the record
  of how the 46-rating measurement was first misread. A sixth nameless
  aptitude row exists since build 25782799, `InfusionBonus`, and it is **not**
  a generic: no item names it, it is the curve an infused piece's bonus rating
  is read off ([Infusion](#infusion)), and `isGeneric` asks "is it named by an
  item" for exactly that reason.
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
authored   = (item.level * 10) ?? item.iLevel          // the LEVEL first
baseILevel = instance level * 10, when one is named (^N)
           | max(source floor * 10,
                 scales ? max(authored, characterLevel * 10)
                        : authored ?? characterLevel * 10)
iLevel     = baseILevel + rarity.iLevelBonus + 10*stars + 10*flawless
             + the iLevel of what is socketed
effLevel   = iLevel / 10
```

iLevel is ten times the level — the easiest place in the whole project to be
silently wrong by a factor of ten. The `+10`s are
`constant.Item_GearUpgradeILevelBonus` and `Item_FlawlessILevelBonus`. Three
things in that block are 2026-10 reads, and each replaced a rule that priced
an item no instance can be:

- **The level before the authored `iLevel`.** An instance's item level is
  recomputed, not carried: `Gear.updateInf@9757` ops 2-12 write the instance
  level into `def.level` and overwrite `def.iLevel` with
  `$HItem.getBaseILevel@21728` = required level x 10 + the rarity's bonus.
  Reading the column first was harmless for the rows that author
  `iLevel = level x 10` and wrong for the 48 Demon armour rows that author
  `level 1, iLevel 1`.
- **`scales`** is true for what a kill generates - weapons and worn armour,
  with the authored level as a floor - and false for jewellery and for
  anything a recipe makes (the `craft` sheet names its equippable outputs).
  MEASURED on the 2026-08-02 bakes: `Necklace_Z2RCraft` 210 for an authored
  20, `Chest_RCrimson_Fig_Craft` 210 for 20, `GA_Craft` 320 for 4, all on a
  level-25 character.
- **The source floor.** Where every source this install opens for a row
  states a level, the piece is never priced below it
  ([what the install hands out](#what-the-install-hands-out)). Every Epic
  armour piece and Epic trinket has only such sources - a Heroic boss table
  (`st.Activity.getLevel@10293` returns `MaxLevel` on Veteran and Heroic) or
  a cache whose `props.gainItem.levelRange` is `{25, 25}` - so there is no
  level-20 Epic chest to wear. ASSUMED at one step: that the server makes
  heroic loot at exactly that level is read from the client's copy of the
  drop path, whose callee is a server-only stub.

A row with neither a level nor an iLevel drops at the character's level; that
is what the last fallback is for.

**A level a row can be WORN at is a separate thing.** `itemType.defaultMinLevel`
is carried as `item.minLevel` and read only by the candidate list and the pin
gate - it is not an item level and prices nothing. READ: it is also a drop
gate on a faction's own lines (`$HItem.getFactionLootTable@21743` ops 0-5
build them with the UseItemLevel flag, and a line whose item level is above
the loot level is refused), so a slot whose type starts at level 13 neither
drops nor is offered below it.

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
| `AugmentEnchantWeapon` | mainhand | grants a *skill*, no stats - and only from the hand you wield: the arsenal weapon hands out no skill from its sockets ([what the capture corrected](#what-the-capture-corrected)) |
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

### The chain is the weapon's own rows

**On build 25782799 the base-attack chain is the swing rows the item lists,
then its finisher, and nothing pads it.** READ:
`ent.Hero.getNextAttackSkill@7811` ops 64-89 return the finisher once the last
used basic is the last entry of `attackSkills`, else the next entry;
`ent.Hero.updateSkillCache@7812` ops 49-62 fill `attackSkills` with the hero's
skills of type `Attack`..`Attack4` whose origin item is the active weapon; and
`st.Item.getMainSkillList@8735` builds what a weapon hands over from the
item's own `skills` (ops 7-39, a `WeaponSubSkill` excepted) plus its type's
(ops 40-65), where a weapon type lists one Block row and no swing.
`moveSet.comboLength` has **no reader left**: its accessor
`get_comboLength@17283` has no caller and `ent.Hero.attack@7840` no longer
touches the moveSet. So Flame of Argol (`Scepter_Flamie`) is one swing and
Searing Furnace where the column says 4, and Twin Pillars of Justice
(`DM_Multispin`) three swings and Sentence where it says 5.

ASSUMED, one bridge: that `st.Item.applySkills@8736` - a server-only stub on
this client - gives the hero exactly that list. NOT MEASURED on this build,
and it is the flattering direction: on the scepter the finisher, and every
prayer and `isFinalCombo` roll off it, lands twice as often as on the previous
build. One session settles it (`bench audit` carries the protocol: count the
swings between two Searing Furnaces - 1 is this reading, 3 means something
still pads).

**What the previous build did, kept because the fix that stood here was
right about the length and wrong about the rows.** On the 2026-08-11 build
`Hero.attack` reset its counter against `moveSet.comboLength` - 4 for
one-handers, 5 for duals and bows - and the model filled a short item row
from the weapon type's other rows. On **2 of the 33 weapons that carried a
chain** the two disagreed:

| weapon | item row lists | `comboLength` | missing |
|---|---|---|---|
| `Scepter_Flamie` | 2 | 4 | `Scepter_Base_Attack2`, `Scepter_Base_Attack3` |
| `DM_Multispin` | 4 | 5 | `DM_Base_Attack4` |

The length was right for that build and the rows were not. MEASURED in the
pre-patch capture (the event log that ends 2026-08-28): 190 Flame of Argol
wielders swung the **same** swing three times before the finisher (1,886 + 826
chains) and 54 Twin Pillars wielders played A1 A2 A3 A3 (94 + 84) - the old
client repeated the last DECLARED swing up to `comboLength - 1`; it did not
borrow `Scepter_Base_Attack2` or `DM_Base_Attack4` from the type. The fill is
removed: the bench fills nothing, and where a weapon lists fewer links than
its moveSet's dead `comboLength` the plan carries an `assumption` line saying
so.

Why the length matters, in either direction: the combo finisher is what every
`isFinalCombo` guard rolls against, so a 2-link chain fires all of them
**twice** as often. A Priest holding the scepter read 0.65 combos/s against
`Scepter_Start`'s 0.31 on the previous build's data, prayers every 4.62s
against 9.68s, and a headline figure 44% above the four-link chain. Short is
the *flattering* reading, which is why the unpadded chain is in the audit as
an assumption until it is watched in game.

**A slot is not one row.** Every staff declares `Staff_Base_Attack` and
`Staff_Base_Attack2` and *both are typed `Attack`* — there is no `Attack2` row
for staffs at all. Keying the chain by type slot merged them and made every
staff a link short, so the item's own declaration order is the chain.

**A `WeaponSubSkill` is a follow-up, not a choice - and it is a weapon
skill.** `Book_WaterOrbs_Skill2_Recast` exists only because Skill2 does; its
parent is declared in `props.subskills` (below). READ on build 25782799:
`BaseSkill.isWeaponSkill@6161` ops 5-11 are `type == 7 || type == 8`
(WeaponSkill or WeaponSubSkill - it tested 7 alone on the previous build), so
a guard written `dmg.isWeaponSkill` holds on a sub-skill's hits and the
modifier scope `weaponSkill` is routed to both types. Five rows are type 8:
Anger Release, Hidden Power, Expulse, Void Fangs and Blind Breakthrough's
recast. What follows per USE - a recast raising one weapon-skill event - is
ASSUMED on a bridge (`tryConsumeCharge@9631` has no skill-type gate), and the
audit names the one Spark-gauge reading that settles it.

**Only the main-hand chain is used.** The combo attack cannot be performed
with the arsenal weapon (confirmed in game, [§12](#12-checked-against-the-game)),
so the arsenal brings no chain and no finisher. Its slotted skills still
contribute, which is exactly what `UnlockLevel_Arsenal` describes.

**A step can ask what is in the main hand.** `steps[].cond.weapons.isRanged`
is new on build 25782799, and READ: `SkillStep.checkStaticConds@5991` ops
58-89 compare it with `ownerUnit.getMoveSet().props.range`, where
`Hero.getMoveSet@7830` is the ACTIVE weapon's type moveSet and the active
weapon is `Slot_Weapon1`; an empty main hand reads as not ranged. The
Finisher (`Rogue_Sig_Finisher`) authors a melee Area step and a ranged
Projectile step for the same hit, both at delay 0.2; until the 2026-10 pass
both were summed and the Finisher priced double (the Rogue's same-build
figure fell 12.9% when one was taken out). `profile()` takes a wield flag and
keeps the step the main hand selects, and the cast's execution point is the
step `BaseSkill.getExecStep@6139` picks rather than the first damage-bearing
one. `cond.heroic` sits in the same function and is not gated: four boss
skills carry it and no player-reachable row does.

### Cast, or fired at you

Roughly a third of what a build knows is `nature: Passive`, and a `cooldown` on
one of those is an anti-double-fire guard rather than a cast rate.
`Priest_Prayer_Smite` reads `cooldown: 1` and does 279 damage; scoring it every
second would make it the entire build. Its real trigger is stated twice in the
data — in its own description, *"Becomes ready after you use your
[ComboAttack]"*, and in its own script (`Priest_Rosary`, where this file used
to place it, has no script on build 25782799):

```js
function onSkillProc(ctx) {
  if( ctx.skill.isFinalAttack() ) { chargePrayer(); }
}
```

**Ready is not fired.** READ: each prayer readies itself in its own
`onSkillProc` (Prayer: Smite on the finisher, Prayer: Life on a weapon skill
of the weapon in hand, Prayer: Virtue on a skill of the arsenal weapon);
`PriestComponent.chargePrayer@30856` ops 35-42 hold ONE charge; and
`divineInterventionProc@30855` ops 24-32 start every prayer that is not in
cooldown - its one caller is the step of Judgment
(`Priest_Sig_DivineIntervention`). So a prayer is a triggered line whose
event is a **Judgment press that finds it ready**, not the finisher itself.
MEASURED on the pre-patch capture, the scripts unchanged since: 2,052 of one
Priest's 2,060 Smite casts fall within 1.5s after a Judgment press, and the
median gap between two Smites over 1,135 players is 19.2s. Until the 2026-10
pass the model fired a prayer on every finisher.

So skills are sorted into buckets, and a triggered skill only earns a rate
from an **explicit rule tied to something the data states**:

| bucket | rate | rule |
|---|---|---|
| `filler` | the chain cycles in whatever time is left | — |
| `active` | `cooldown × (1 − CDR/100)`, a bank of `charges`, floor `occupancy` | needs `cooldown > 0` |
| `triggered` | per Judgment press that finds it ready | prayers, per their own scripts |
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

**Cooldown earned off an event, from any source.** Eight rows call
`reduceWeaponsCooldown` and one was credited. Three of the refusals were about
punctuation and one about the engine, none about the mechanic:

- `scopeOf` would not answer `rank >= N`. A rank comparison is a question about
  the **build**, not about live state, and it is now answered when the caller
  knows the rank — for a plain conjunction only, since inside a disjunction the
  clause belongs to one alternative.
- `KNOWN_PRED` matched `\w+\.`, so `hit.skill?.isBaseAttack()` was refused **on a
  question mark**.
- `CD_PROC` demanded a bare one-argument call, so `reduceWeaponsCooldown(vars.time,
  owner)` was refused **on a comma**. The second argument is whose cooldowns, and
  on a self-applied status that is you.
- And once read, the engine credited only `scope === 'bleed'`. Everything else
  fell to `unreadMods` and scored zero.

**The rate belongs to the SOURCE skill, not to the scope.** The scope says who
benefits ("your weapon skills"); the source says how often it fires. `Red Tempo`
is a talent on bleed ticks; `Sword_Start_Combo` is `onFirstHit` on the finisher,
so its rate is the chain's finisher rate. The chain cadence used for that is an
**estimate** — the fight derives the real rate by playing it, and this has to be
known before the fight in order to set the cooldowns it will play with.

Four of eight read and credited when this was written (2026-08-03). The two
that still refused then were correct: `GS_Nova_Combo` needs
`hasStatusMaxStacked` and `Thrown_Seeds_Skill1` needs a status on the target.
Two more (`Rogue_Talent_NoxiousStrategem`, `Priest_Talent_SwiftJustice`) were
gated on `dmg.skillId == Skill.X`, which is readable but see the caution
below.

**Since the 2026-10 pass the whole family goes through one loop.** A cooldown
mutation is any `reduceCooldown(...)`, `resetCooldown()` or
`reduceWeaponsCooldown(...)` site, on a weapon row, a status row or an
allocated talent, and it is carried as `{host, target, on, chance, seconds}`
where `on` is the event the fight raises for it: `host` (the row's own
press), `attack`, `combo`, `attack-or-combo`, `weapon-skill`, `magic-crit`
or `skill-hit` (every hit of one named skill's cast). What is read now that
was refused: the target spelled `skill.kind`, a bare `kind` or an empty
argument list (all three are the script's own skill); the seconds handed
over as a local with one conditional reassignment (Venomous Assassin's 1s,
or 2s when its Final Combo dose is new); `onSkillProc` and `onHitNewTarget`
as events; a reset behind "your Magic critical strikes", priced as
`1 - (1 - q x c)^n` over the n hits of the cast; and a talent that hands
cooldown to a skill the fight does not cast, which is named with that reason
instead of dropped (Prosecutor and Judgment, Footwork). Noxious Stratagem is
priced as an event on Lethal Poison's ticks and direct hits. Still refused
and named: the `s.kind` broadcast form inside `forAllWeaponSkills` /
`forAllClassSkills`, and a method call on another object (one such idiom is
read: the off-hand weapon's skill, `sk.reduceCooldown(vars.time)`). All of it is READ
and none of it measured on this build; the two audit entries on cooldown
handed back say which reading is a floor.

*Not landed, and why.* Teaching `scopeOf` that `dmg.skillId == Skill.X` names a
status — gated on the row really having `props.status`, so
`Priest_Talent_Authority`'s `Priest_Prayer_Smite` (a cast, not a status) stays
refused — correctly un-refuses `Priest_Talent_PiercingLight` at
`dot:Priest_Talent_Sunlight_Status`. It also drops the Priest optimum 298.4 →
293.2, stable across restarts and isolated to that one line. The **read** is
right; the talent search finds a worse build once the node becomes visible to it.
That is a search-quality bug and has to be understood before the read ships.

*Also not to be repeated:* offering rotation skills to `talentModifiers` without
filtering the field credits a skill's `dmgMult` riders a second time — once
per-skill through `runeDamage`, once here at scope `all` across the whole build.
That read the Warrior **31% high**. Only `cooldownPerTick` comes through from a
non-talent source.

**A weapon is generated; gear is authored.** The drop chain rolls a generation
rarity for **Weapon-type only** — everything under `MainhandWeapon` or
`OffhandWeapon` in the `itemType` tree. Everything under `Gear` keeps the
rarity written on its own row: an Epic chest is a different ROW from the Rare
one (`Chest_EBee_Fig` beside `Chest_RBee_Fig`), not a roll of it, so a gear
pin with `@Epic` is refused with the id of the row that is that rarity. The
generation LEVEL is narrower than it reads here: weapons and worn armour
take the level of what made them, jewellery and crafted pieces keep the level
on their row ([§6, effective level](#6-what-an-item-is-worth)).

The live bakes settle both halves. `Necklace_Z2RCraft` logged iLevel **210** on a
level-25 character, which is its authored 20 exactly; the Z3 craft rings logged
**160** for an authored 15; and `GA_Craft` logged **320** against an authored
level of 4. Fixed-level gear does not scale, and weapons plainly do.
`[2026-10: on build 25782799 worn armour is generated too - it stands at the
drop's level with its row's as a floor - and the 2026-10-13 capture holds it:
eight Demon armour rows that author level 1 were logged at 25 or 24. The Z3
craft rings author 25 on that build. Jewellery is priced at its row's level,
an assumption the same capture does not hold: two necklaces that author 15
were logged at 17. bench audit carries both; --drops scaled now prices a
weapon and worn armour at your level.]`

Applying either rule to everything is how the optimizer came to recommend items
the world cannot drop: a level-6 Uncommon necklace (`Necklace_Z1_Cri`) offered as
**Rare at iLevel 260** — roughly four times its legal stats — and a level-15 ring
priced the same way. `--drops scaled` now means "a weapon generates at your
level"; gear is unaffected either way, and `bestRarityFor` returns a pinned
gear item's own rarity rather than promoting it.

Anything ranked under the old defaults has to be re-run. Doing so moved every
baseline down: Warrior 495.7 → 479.7, Rogue 354.5 → 350.6, Mage 241.4 → 239.0,
Priest 298.4 → 293.8, and the Warrior's neck went from a promoted Rare at 260 to
an Uncommon at its own 150.

**A pull starts cold.** Any measured fight assumes **zero extra resources**
unless it says otherwise — no food buff, no banked stacks of an aura, no enchant
buff still running from the previous pull, no skill pressed before the combat
window opens. It is the only convention that makes a measured pull reproducible,
and it matters most where a counter carries *across* combats, because there the
flattering reading and the honest one differ by a factor of two:
`GS_Nova_Passive_Stack` has no authored duration, so a meter showing two Anger
Release casts in 75 seconds is one earned and one walked in. The model earns
both. Anything measured on a warm character has to say so.

**A stack counter has a rate, and it was always in the data.** The refusal read
*"nothing in the data says how many hits arm it"*, and the data says 100.
`GS_Nova_Passive` banks one stack per non-DoT **physical damage event** and
converts at `maxStacks` — 150 authored, 100 from rank 2 through `rankOverride` —
so the rate is `events / cap`. What was missing was a fight that counted its own
events. A sweep of every script in the sheet matches the shape exactly once:

```
onInflictDamage(dmg) {
  if (!dmg.isDoT && dmg.isPhysical && !hasStatus(owner, UltProc)) addStatus(owner, Buff);
  if (hasStatusMaxStacked(owner, Buff)) { removeStatus(Buff); addStatus(UltProc); }
}
```

The follow-up is named by `props.subskills`, not guessed from the id.

It is priced **post-hoc**, deliberately. The rate needs the run's own event count,
and injecting it as a pressable was measured to send the rotation search to
*worse* plans (436 → 413/423) — the same local-optimum failure the talent search
shows. An analytic line gives the search nothing to reorder around. Its damage
still joins the headline, or the repartition would stop closing on it. `floor` is
what makes the cold start honest: 99 stacks at the bell are 99 stacks nobody
spent, the same convention the pool dots' un-ticked tail already follows.

**The chain reports per link.** The aggregate `(base attack chain)` row hid a
named ability: a damage meter listed **Mania** among its top rows and the model
appeared not to have it, when `GS_Nova_Combo` is the greatsword chain's fourth
link and had been scored every cycle with no way to see it. A reconciliation
against a meter is a per-*row* exercise, and that was the row it could not find.

Each link carries its **own** recurrence, not the cycle's, because they do not
fire equally often — a chain broken partway pays link 1 more than link 4, which
is the entire reason a finisher is worth naming separately. On a bare GS pin the
intervals run 3.92 → 4.65 → 4.88 → 5.41s and the hits 51 → 37. Splitting changes
no total: the lines still sum exactly to `dps × fight` and the per-link clock
shares to `fillerShare`, both asserted.

**A refusal inside an accounted skill is still a refusal.** The unscored list is
per-*skill*, so a clause refused inside a skill the model **does** score landed
nowhere: the damage was right, one line of the script was worth zero, and nothing
said so. `GS_Nova_Combo` is the case — the finisher is scored every cycle, and
its rank-3 `reduceWeaponsCooldown(1.5)` is gated on `hasStatusMaxStacked`,
correctly refused, and previously silent. Live weapon cooldowns run faster than
modelled because of it. `scriptGapsOf` walks the same regexes and reports what
`scopeOf` turned down, with the guard text. It names; it does not price.

Three things it must **not** report, because **dead is not a gap**: a clause
behind a rune the build did not slot, one behind a rank the weapon has not
reached, and one `runeDamage` already reads. The first two contribute nothing in
game either; the third would file Domination as dropped while it is being
applied.

**A refusal names who loses out.** Rampage's entry read *"its script resets
Shockwave's cooldown from a onKill hook"*, filed under Rampage — which reads as
"Rampage is not scored". Rampage is scored, every cast. What is missing is a
cooldown **Shockwave** never gets back, and a reader asking why Rampage looked
low was being pointed at the wrong skill.

**A next-cast register: free, and a guaranteed critical strike.** Something arms
a one-shot flag and the next cast of ONE named skill spends it. First
recognised by a **triple**, which a sweep of the 962 scripts of the 2026-08
build matched exactly once. Since the 2026-10 pass a build carries a LIST of
registers and three shapes arm one - a finisher's roll (below), a counter of
active casts (the Mage chain, [further down](#the-mages-three-economies-2026-08-11-later)),
and a stun attempt ([Domination](#domination-a-register-and-an-owner-wide-rider)) -
each one flag, spent before it is armed:

```
onInflictDamageEval   hasStatus(owner, S) && hit.skillId == kind -> hit.critChance = 1
evalCost              hasStatus(owner, S) -> return 0
onStop                removeStatus(owner, S)
```

…plus an applier doing `addStatus(owner, S)` behind `isFinalAttack()` and
`checkProba(vars.chance)`. That is `Warrior_Talent_SurgeOfViolence`, 25% per
combo finisher, and it needs **no talent point** —
`DemonSigil_War_SurgeOfViolence` grants the node from a Head socket, which is why
`runableSkillIds` (which walks augments) is what feeds the reader.

Carried as the **probability** the register is armed, the same convention crit
already uses. A finisher does `p += (1 - p) * chance` — a proc landing while it
is already armed is *wasted*, so it never saturates past 1. Spending costs
`cost x (1 - p)` and lifts the cast to `(1-p) x rolled + p x forced`, where
forced is the existing decomposition at p = 1, i.e. `fixed + base x cd`. The pool
feed follows the same die. Both halves are real: on a bare axe build the sigil
raises Rage Strike 11% per cast *and* shortens its interval 4.65s → 3.33s,
because a free cast waits on no Rage income.

*One arm buys exactly one free critical cast.* The cost check runs at press and
the forced-crit check at damage eval, which looks like it should let a second
press slip in free while the first cast is still running — the shape VERDICT-V2
describes as "a queued second Rage Strike gets the free cast without the crit".
The bytecode does not allow it. `GameObject.doUseSkill@4651` **op 2** calls
`stopActiveSkill@4655` as its very first action (op 2 on the 2026-08 build; on
build 25959898 op 10, after a test of the pressed skill's NonInterupting flag
at ops 0-7 and of whether it is already the running skill at ops 8-9), which is `BaseSkill.stop@6200`
on the running skill, which runs `onStop` and removes the status *before* the new
cast evaluates anything. Pressing again cannot outrun its own stop, and queueing
cannot either: a queued press resolves when the current cast ends, which is the
same removal. Spamming Rage Strike at full Rage under Surge gives one free
critical cast and then full price.

**A skill can carry its own damage rider, and three of them were refused.** The
2026-08-02 capture proved all three fire; shipping without them cost −13.7% to
−17.5% on the skills that carry one. Each was refused for a different reason:

| rider | field | guard | why it was refused |
|---|---|---|---|
| `Axe_Boomerang_Combo` +20% | `dmgMult` | target has a Bleed | the guard was readable, but only *talents* were offered to the reader |
| `Axe_Boomerang_Skill1` +20% | `critDmgMult` | `rank >= 3` | `rank` survived `scopeOf`'s predicate strip |
| `GA_Craft_Passive` +25% | `dmgMult` | target Stunned/Rooted/Slowed | same, plus its amount lives in a `rankOverride` nothing merged |

The third row is the 2026-08 script of Domination. Build 25782799 rewrote it
into two mechanisms and that row describes neither; see
[Domination](#domination-a-register-and-an-owner-wide-rider).

The reader is `runeDamage`, generalised: it already read a skill's own script for
a rune-gated `dmgMult`, so it now also answers a **rank** comparison (a question
about the build, not about live state) and tags a **target-state** guard for the
fight to answer. `critDmgMult` entries land in `critBonus`; `dmgMult` entries in
the additive bracket. Anything else in the guard still refuses.

One trap worth naming, as it stood on the 2026-08 script: Domination read
`Stun || Root || Slow || (rank >= 3 && isCCImmune())`, where the rank clause
belonged to **one alternative**. Vetoing the whole rider on it silenced a +25%
that fired on the stun path at any rank, so the rank test applies only when
the guard is a plain conjunction. The rule about disjunctions stands; the
script it was learnt on is gone.

The gates are the **build's own**. `bleeding` is 1 when this build applies a
Bleed-typed dot and 0 when it does not — the same whole-credit policy the scoped
talent modifiers already use, and the capture measured a bleed up at 17 of 17
steady finishers. `cc` is no longer "every stun at duration/cooldown": it has
one reader, typed gates and a target that can refuse - see
[crowd control](#crowd-control-has-one-reader-and-a-target-can-refuse-it).

**Damage riders SUM into one bracket; they do not compound.**
`computeDamage@4920` (`Unit.hx:2102-2133` on build 25782799) op 5 runs the
hooks, op 11 seeds `modMult` from `hitData.dmgMult` — one scalar that starts at
1 and that every rider only ever `+=`s — and ops 134-147 apply it once. (On
the 2026-08-11 build the same three were read at ops 8, 14 and 165,
`Unit.hx:2000-2031`; the function is 148 ops long now.) The model multiplied
a line at a time: `runeDamage`, then `damageByAffinity`, then the basic-attack
proc. Two +20% riders read ×1.44 where the game gives ×1.40.

Decided three ways in the v2 capture: the one deterministic double-rider hit
(Rage Strike 352 under Berserk *and* Domination) fits `1 + 0.20 + 0.25 = 1.45`
to −0.23% where `1.20 × 1.25` misses by +3.2%; a 42-hit least-squares prefers
additive at rms 0.26% against 0.66%; and Berserk-added-*into*-the-fervor-bracket
is excluded by the GA ratio window [1.1903, 1.1954]. So the shape is

```
amount = B x (1 + Fervor + Mastery) x (1 + SUM dmgMult) x critDamage^crit
```

**A scripted `dmgMult` is not a sheet stat.** `skills.mjs` turns an unconditional
`hit.dmgMult += vars.n` into a `TAttribute_Flat DamageModifier` row so the buff,
its uptime and its place in the fight come for free — but DamageModifier
*multiplies* in `castOutput`. Those rows are now diverted into the additive rider
channel at the same uptime the sheet would have given them. `critDmgMult` rows
are left alone: `ctx.critDmgMult` really does start at `atbVal(CritDamage)`.

*Named caveat:* at sheet DamageModifier = 100, `(D + Σ)` and `D × (1 + Σ)` are
indistinguishable. Deciding that needs a capture with a permanent
DamageModifier ≠ 100 source.

**The arsenal's upgrade effect reaches you, whole.** The harvest read
`Slot_Weapon1` and `Slot_OffhandWeapon`, on the reasoning that the arsenal grants
two chosen skills and its discounted stats and an upgrade effect is neither. The
player's own Character Profile refutes it: on a build whose only CritChance
sources are the naked base, the ratings and Judgement's upgrade line, the sheet
reads **17.3%** where base + ratings alone give 14.26%. Nothing else in that
loadout grants CritChance. It is *not* scaled by the slot's 0.4 either — an
upgrade row is a skill affix, not a stat line.

*The rider row and the iLevel do not count the same thing.* The iLevel is
unambiguous about the stars — 320 = 250 + Epic 30 + 4 × 10 — and the ladder is
+1/+2/+3/+4/+5 by rank, so the data reads +4. The screenshot reads *"Critical
Chance increased by 3%"* on that same four-star weapon, and the sheet closes at
17.3 with 3, so the row that fired here is rank 3 on a four-star Epic.

~~**The rank the row sees is `stars - 1`.**~~ **Settled, and not this way.** The
rank is the **rolled rarity index**; the stars only decide whether the skill
attaches at all, at `GearUpgrades.SkillUnlockLevel` (3). Every case on this page
is degenerate between the two rules — a four-star Epic reads rank 3 either way,
which is exactly why the wrong reading survived a tooltip that agreed with it.
What decided it is `Weapon.getWeaponUpgradeSkill@9837` plus two weapons that
break the stars rule, and a Censer whose CooldownReduction is *flat* across
3/4/5 stars and steps once per rarity (Rare 3, Epic 4, Legendary 5). See
"A star is not the rider rank" further down.

*Reading a printed sheet against the game's:* the model folds a proc-applied
buff with no cooldown behind it into the resting sheet at its cap, because in
sustained combat that is where it sits. The game's Character Profile shows you
standing still. On the captured build that is the Raclette Pan's +5, so the two
are compared as `model − 5`. `[2026-10: the 2026-10-13 capture does not hold
those stacks at their price: 62 critical of 385 swings and finisher rows at ten
stacks with Battle Shout down, 16.1%, where +0.5 CritChance a stack gives
21.7%. The price stands and bench audit carries both numbers.]`

**The bake is checked against the game's own return value, not against tooltips.**
`captures/2026-08-02-v2/bench-probe-bakes.csv` is a postfix on
`$HItem.generateItemAffixes@21736`: the item, the iLevel it was called with, and
every affix line that came back. **632 signatures, 2,115 lines, all exact.** Three
rules took it there from 1,299:

1. **One round per target attribute, not one per row.** Two aptitudes both paying
   MaxHealth are two rows landing on one line, and rounding each before adding
   them loses up to a point per row — 87 signatures came out ±1..2. The rows
   accumulate as floats and the *line* rounds, before the slot factor ceils it.
2. **Uncommon drops a stat group, and which one depends on the aptitude count** —
   single-aptitude pays no *primary*, multi-aptitude pays no *vitality*. Nothing
   authored says so: the `itemType.props.rarities` overrides stop at Common
   (which zeroes both). Measured on 287 Uncommon keys.
3. **Generic aptitudes pay like every other aptitude** — all of them, each divided
   by how many the item names. See below.

Read `bake` rows only when diffing. An `item_affixes` row reports the item's *def*
iLevel while carrying the *live* affixes, so mixing the two files the live axe's
iLevel-290 numbers under 260. Two more traps in that comparison: `effectiveLevel`
adds the rarity's `iLevelBonus` to `level * 10`, so an instance level must be
handed in net of it; and a shield lists `Slot_Weapon2` before
`Slot_OffhandWeapon`, so taking `slots[0]` prices every shield at the arsenal's
40%. The only line that still differs is `Scepter_Start`, which carries authored
affixes `Vitality +2 / Faith +2` that `generateItemAffixes` does not generate and
therefore does not log.

**A generic aptitude is not a choice.** The five nameless rows — Crit, ArPen,
MaPen, Fervor, Vita — used to pay exactly ONE, enumerated as a candidate per
generic. The measurement that rule rested on was right and the inference was not:
*"Pendant of Adaptability grants 46 rating, not 184"* correctly killed the naive
sum, and was read as one row paying 46. The game's own bake for that necklace at
iLevel 210 is

```
Vitality 4 | CritChanceRating 11 | ArmorPenetrationRating 11
          | SpellPenetrationRating 11 | FervorRating 11
```

— four rating lines summing to **44**, which is the 46 that was measured, each a
quarter because the item names four aptitudes. `genericChoices` now returns `[]`
and jewellery appears once as a candidate instead of once per generic.

**A skill's own affix is owed for owning the skill, not for being a passive.**
`BaseSkill.permaAffixes@6188` (`BaseSkill.hx:865`) returns false for exactly two
natures — `Status` and `Passive` — and true for every other. `BaseSkill.initData@6136` then
runs `if (permaAffixes()) updateAffixes()`, which hands the rows to
`GameObject.addAffix@4550` for good. A passive's rows are not permanent *by that test*
but arrive the other way, through `BaseSkill.setRunning@6132`, and a passive is always
running; a status's rows belong to the buff path, which prices them at an uptime.
So the harvest is **every owned skill except a status**, deduplicated by id.

The row that proves it is `Axe_Boomerang_Combo`: nature `Combo`, `TAttribute_Flat
CritChance +5` at `minRank: 2`, `displayed: false`, and a `rankDesc` reading *"You
permanently gain ::val1%:: [CritChance]"*. It is owed for **wielding** the axe —
on the 2026-08-11 build `Weapon.applySkills@9836` created a skill object for
every row of `item.skills`; on build 25782799 that function's first op calls
`st.Item.applySkills@8736`, a server-only stub, and what is still readable is
the list it is handed, `st.Item.getMainSkillList@8735` —
and the model dropped it because a combo lives in `filler`, not in `passive`.

A census of the whole sheet finds six rows outside Status/Passive carrying an
attribute affix: the three weapon-class Block abilities (which already arrived
through `passive`, hence the dedupe), `Axe_Boomerang_Combo`, `DA_Water_Combo`'s
+2 CritChance at rank 3, and one Bee NPC row. The change cannot move anything
else by accident, and the test asserts that census so a seventh row is noticed.

**A refused payload does not take an always-on stat with it.** The buckets are
not exclusive, and one row can land in two of them. `Axe_Boomerang_Skill_Passive`
declares a heal played only from `on: Code` — its script fires it on a physical
critical strike at rank ≥ 3 — and, on the same row, an `Aura` step at `Start`
with `duration: -1` that puts `Axe_Boomerang_Skill_Passive_Status` on the wielder
and every ally in range. That status was `TAttribute_Flat CritChance` **3** at
rank ≤ 1 and **5** at rank ≥ 2 on the 2026-08 build; build 25782799 authors
**2** and **3**, and the rule below is unchanged by the retune - the suite
holds it to the row. The heal genuinely has no rate this reader can
derive; the aura is on from the moment the axe is equipped and never expires.
Refusing the skill whole cost five points of crit on the one weapon in the game
whose passive *is* a crit aura — about 1.6% of the Warrior's optimum.

So a `carries`-payload refusal now files the skill under **both** `unmodelled`
and `passive`, and the refusal sentence names what it kept. Only two things come
through: the skill's own affix rows, and self-buffs with no positive duration. A
*timed* buff needs the very rate that was just refused in order to know how often
it goes up, so it stays out; anything script-gated or `dynVal`-scaled never
reaches `self` in the first place — `statusesOf` diverts those to `unreadable`
with a reason. `selfBuffs` honours an entry's declared `buffs` list where it has
one, so the restriction survives the round trip.

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
| `rank >= 2` | **evaluated** | it is the weapon-skill rank, the same number `--rank` resolves on every step, effect and affix. A rank-1 character was being handed rank-2 riders: `Sword_Swarm_Passive`'s poison and `GM_MassGrab_Combo`'s proc appear only at rank 3. (This cell also named Deadeye Focus, `Bow_Craft_Passive`; on build 25782799 its script applies the status at every rank and rank 3 gates the +25% inside the status) |
| `hasTalent(X)`, `hasMastery(X)` | **evaluated** | the loadout says which talents and runes it has |
| `hasStatusMaxStacked`, `.stacks >= getMaxStacks()` on a counter **the build fills itself** | **answered, as an assumption** | taken as full for the whole fight, and the rule's own sentence says so |
| `hasStatus`, `getStatusCount`, `isStatusType`, `isInCooldown`, and the two above on anything else | **refused, and named** | a question about live state at the moment the proc rolls |

Cascade's Axe (`DA_Water_Combo_PassiveRank3`) is why it matters: its guard is
`isBaseAttack && status.stacks >= status.getMaxStacks() && checkProba(0.35)`,
and reading only the first and last credits it 0.35 per swing when it needs a
max-stacked buff first. It was reported `conditional` until the 2026-10 pass.
It is priced now, because the build stacks Cascade itself - one per finisher,
five deep, on a fifteen-second timer the next finisher renews - and the
counter is taken as held from the first second: about 15s of a 200s fight
credited a roll it does not have, the flattering direction, stated in
`bench audit`.

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
`Crescent_FlowerSpiral_Skill_1` grants its `_Charge` counter. When this was
written neither was scoreable, and what it bought was coverage that named
them. Both are played since the 2026-10 pass: Cascade's Axe on a counter the
build fills itself, and Flower Spiral's counter as a bank of petals the cast
spends for one more spin each - READ, with the petal count and the hold
still to be watched in game.

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
listed as things the model failed to score — the same treatment the Priest's
bookkeeping row `Priest_Rosary` has (a row with no script on build 25782799:
each prayer readies itself, see "Ready is not fired" above).

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
`[2026-10: both are modelled on build 25782799. Skill.getSparkCost prices a
weapon skill at round(max(5, cooldown × 1.0)) Spark, and Spark is spent and
never required - a press short of it goes off, as the capture logged.
Rogue_ComboPoints pays a point to a skill different from the last one it paid,
and the Finisher spends what the pool holds
([the dose-gated poison](#lethal-poison-is-applied-by-a-count-of-doses)).]`

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

| | rows | rank-gated | rune-bearing | whose rank |
|---|---|---|---|---|
| `WeaponSkill` | 68 | 38 | 0 | weapon mastery |
| `AttackCombo` | 33 | 14 | 0 | weapon mastery |
| `WeaponPassive` | 31 | 14 | 0 | weapon mastery |
| `Talent` | 88 | 44 | 0 | points in the node |
| `InfusionPassive` | 15 | 15 | 0 | the infusion set's rank |
| `ClassSkill` | 26 | 0 | 24 | - |
| `SignatureSkill` | 4 | 0 | 4 | - |

Counted on build 25782799 the way the suite counts it: a row is rank-gated
when a step condition, an affix condition, a `rankOverride` or a
`rankPassives` entry names a rank. (The table that stood here read 56 / 31 /
27 / 46 on the 2026-08 build by a wider test; the rule it illustrates did not
change.) Rank gates also sit on 64 rows with no type at all - the statuses
and helper rows those skills apply, which run at their instigator's rank
(`Status.get_rank@15802`) - and on three rows no build is granted: two foe
`Skill` rows and one consumable.

**No row carries both.** And a rank is **one of three namespaces**, decided by
the row's type, which is the thing to get right before pricing a `minRank`:

- **weapon mastery** on weapon skills, combos and weapon passives - `--rank`;
- **talent points** on a `Talent` - capped at `props.talent.maxPoints` (2 on
  48 of the 88 nodes). Resolving a talent at the weapon's rank asks a
  two-point node whether it is at rank 3, and every `minRank: 2` rider on it
  passes for free; the talent pass uses the node's own rank;
- **the infusion set rank** on an `InfusionPassive` - how many of
  `Item_InfusionCaps` (2 / 4 / 6) the count of pieces carrying that infusion
  reaches. `--rank` cannot reach it and a full set cannot be dimmed by
  `--rank 1`; see [Infusion](#infusion).

A type the suite has not been told the namespace of fails by name, so a
fourth cannot arrive quietly.

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
blank. A control is worth nothing **as a control** here, because the
simulated foe does not act — which is the right answer, not a shortfall. It is
worth something as a **state**: riders and a register read it, and since the
2026-10 pass one reader says what a cast controls, for how long, and whether
the target refuses it
([crowd control](#crowd-control-has-one-reader-and-a-target-can-refuse-it)).
On build 25782799 the `CrowdControl` flag sits on five status types - Slow,
Silence, Stun, Root and Grounded - and every reader takes the list from the
sheet, by name.

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

Then, in the model (the bracket was READ on 2026-08-02 - `GameObject.getDamageRatio@4577`
- and the two lines that stood here marked UNVERIFIED, one multiply each for
Fervor and Mastery, are retired):

```
expected = (amount + adds)
         * (1 + Fervor + Mastery) * DamageModifier/100   // nothing of it on Raw
         * (1 + SUM dmgMult riders)                      // one additive bracket
         * (1 + critChance * (critDamage/100 - 1))
         * (1 - mitigation)                              // §4
         * DamageTakenModifier of the target
```

**How one scaling entry is priced** is the other half, and build 25782799
moved it. READ in `$HSkill.getStepEffectScaling@21777`, the one function
that turns `{ratio, atb}` into a number:

| the entry scales on | what the game reads | cited |
|---|---|---|
| an ordinary attribute, on a skill granted by a held weapon | `ratio × (0.6 × attribute + 0.4 × that attribute's own budget curve)` - `itemRatio` is `WeaponPowerRatio.MainhandWeaponSkill` (0.4) where the granting item's type chain reaches `MainhandWeapon`, 1 for `GearTrinket`, 0 otherwise | ops 2-35, 92-118 |
| `WeaponPower` | `ratio × MEAN over the weapon's aptitudes of (0.4 × budget_i + 0.6 × attribute_i)` | ops 189-200, `convertWeaponPowerScaling@21781`, `getStepEffectItemScaling@21779` and its closure |
| `AllAttributes` | `ratio × MEAN of the attributes flagged MainAttribute` - Strength, Dexterity, Faith, Intellect today - with no weapon share | ops 119-188 |
| `MaxHealth`, first in the list | the MaxHealth of the hit's TARGET - yourself for a self heal or shield (Spark Shield, Rage Shield), the foe for damage. The eleven damage rows of that shape are trap and environment damage no build deals, and stay at zero | `getStepEffectVal@21774` ops 40-60 |
| anything, on a class skill or a talent | `ratio × attribute` - the gate is `BaseSkill.isWeaponBased@6164`, a set of skill TYPES with no slot check, so the arsenal's weapon skills take the mix and class skills never do | - |

The second row is the rule the September 30 update changed, and it has its
own section: [WeaponPower](#weaponpower-the-rule-that-moved-under-an-unchanged-function).
`AllAttributes` and `WeaponPower` are the two ids the scaler resolves by NAME
rather than off the sheet, which is why neither appears as a stat. All five
rows are READ; on this client the scaler's only remaining caller is the
tooltip (`HText.skillEffectValText@21951`), the damage-side caller being
server code that is no longer shipped.

### Timing

There is **no player global cooldown**. `getSkillRecoveryTime` occurs exactly
once in the bytecode, as `ent.Foe.getSkillRecoveryTime` (findex 7043), and
only 13 of the 962 skills of the 2026-08 build carried `props.interruptStyle`. `Skill_RecoveryTime` sits in
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
- **what you socket raises the host item's gear level.** `Gear.getILevel@9760`
  (`src/st/item/Gear.hx:48-51`) is three lines:

  ```
  lvl  = Item.getILevel(this)                              // base + rarity, + flawless
  lvl += round(upgradeLevel * Item_GearUpgradeILevelBonus)  // the stars
  for (s in this.slots) lvl += Data.item.byId.get(s)?.iLevel ?? 0
  ```

  That third line was the one nothing read. Twelve items in the game carry an
  `iLevel` among the augments and they are all `AugmentDemon`: the **Epic**
  Corrupted Gifts declare `iLevel: 10`, so socketing one is worth a whole
  effective level of stats on top of the affixes it swaps — every line on the
  weapon moves, including the ones the gift does not mention. The **Rare**
  Corrupted Gifts declare no `iLevel`, and neither does any enchant, jewel or
  sigil, so those add nothing at all.

  Reported from play — *"using a demonic gift on a weapon slightly increases its
  stats"* — before the code was read, and worth 1–2% on all four baselines
  because the search already takes the Epic gift wherever it fits.
- **a conduit fires when Spark is spent from above the gauge — and they all fire
  together.** `Mage_Conduit_SparkBounds` is `[0.5, 0.5, 0.5]` and the test is
  `bound < ratio`, so all three tiers are the same number and the Low/Medium/High
  tiering is inert. Every equipped conduit fires at once, which makes conduit
  damage a **sum** over the ones you slotted rather than one of them.

  The model used to refuse all of them as *"no trigger rate can be derived from
  the data"*. It was derivable — it needed the Spark pool **simulated** rather
  than a rate invented. "One per weapon skill" would have been badly wrong:
  in-combat regen is 0.65/s against roughly 5/s of spend, so a full pool buys a
  handful of triggers and the gauge then sits under the threshold for the rest of
  the fight.

  **Measured in game, 2026-08-02, on a naked Censer Mage — and it confirms the
  rule to the integer.** Starved of Spark, `Conduit: Power` stacked to exactly
  **five** and stopped: from a full 100, the finisher's flat 10 leaves the pool
  reading 100 / 90 / 80 / 70 / 60 before five successive spends, all strictly
  above 50, and 50 before the sixth — which is not. Fed Spark, the same buff
  reached its full **twenty** stacks for +10% MagicMastery. So the five was the
  *gauge*, not the cap, and the row's `maxStacks: 20` and `duration: 15` are both
  right.

  That last reading cost the Mage 13%. `Conduit: Power` was being credited at its
  cap — a permanent **+10 MagicMastery** — where the gauge fires roughly once
  every 22 seconds against a 15-second buff, which is well under one stack on
  average. Pricing the mean needs the stack counter's affix side, so it is
  refused and named rather than kept at the flattering end.
- **a damage-over-time ticks once per stack.** `$HSkill.getStackFactor@21771`
  runs as the **last** line of `getStepEffectVal@21774` — after the scaling,
  after the spread division, after the damage variance — and multiplies the
  value by `Status.stacks` whenever the running skill is a Status that is
  *either* a DoT (its `statusType`, or an ancestor of it through the `parent`
  chain, carries the DoT flag) *or* carries the `ScaleWithStacks` effect flag.
  It is an **OR evaluated once**: `Daggers_Demondash_Passive_Status` is typed
  `Burn` *and* flagged, and is multiplied exactly once.

  The count is read **at every tick**, so the per-tick value snapshots at
  application and the multiplier does not.

  The cap comes off `getMaxStacks@15831`:

  - `props.status.maxStacks`, whose default is **1**, not unlimited;
  - replaced by any `props.rankOverride` entry at or below the **applying**
    skill's rank (`Status.get_rank@15802` = `instigatorSkill.rank`) — which is
    how Hysteria's counter drops from 150 to 100 once the weapon skill is
    upgraded;
  - and, on the 2026-08-11 build only, one script path: Lethal Poison read
    `getStatusMaxStacks(b) = b + getTalentRank(Rogue_Talent_ImprovedMixture)`.
    On build 25782799 no row declares that hook; Lethal Poison is ONE stack
    and Improved Mixture is a different mechanic
    ([the dose-gated poison](#lethal-poison-is-applied-by-a-count-of-doses)).

  An application adds exactly **one** stack — `props.status.stacks` is authored
  on none of the 100 `type: Status` steps (98 on build 25782799) — and nothing anywhere decrements a
  stack on a timer: the whole status expires at once. `DurationBased` is the one
  exception and it is sampled **only at application**,
  `ceil(stacks × durationProgress)`, which is why a stack table needs no
  per-tick decay at all.

  Five stacks of Lethal Poison were being priced as one on the 2026-08 build.
  That is where the Rogue's **324 → 385** came from then; the stacking poison
  it describes was removed by the September 30 update.

  `maxStacks <= 0` means **uncapped** — seven rows author `-1` — and that sign
  was a live trap: the bare `?? 1` it replaced handed the literal `-1` into the
  affix scale, i.e. a buff worth *minus* its own value. Nothing was visibly
  wrong because only a foe status carries affixes among the seven, which is the
  kind of bug that waits for a patch to become one. `[2026-10: eleven rows
  author -1 on build 25782799 and three of them carry affixes
  (EliteOutnumbered, Phrixes_NC_Bonus "Demonic Power", Phrixes_NC_Bonus_Scale);
  no skill row names any of them.]` An uncapped **dot** is held
  at one stack and named: over a 200-second fight an every-swing application
  would reach two hundred stacks and print a number that grows with the fight
  length rather than with the build. Every uncapped dot in the sheet today is a
  *pool* dot, whose fed/owed ledger already **is** the stack count expressed as
  damage, so nothing is currently scored at that floor.

  What has **not** landed is the affix side. `BaseSkill.applyAffixes@6190`
  multiplied each affix by `getAffixMultiplier() = stacks` too - READ on the
  2026-08-11 build; the function is a server-only stub from build 25782799 on
  and that body can no longer be re-read - and a stat buff is still counted
  at its cap — right for a weapon enchant refreshed off a proc every few swings
  (`Enchant_Zealot` saturates), wrong for one whose income the fight cannot
  derive. The `restat` cache is keyed on `status#stacks`, so a fractional mean
  has to be quantised before it can go in, or a bounded cache of integer states
  becomes an unbounded one of float states.
- **a step whose `on` is `Code` is not part of the cast.** `skill@steps.on` has
  a `Code` case and it means what it says: that step is played by
  `playStep(Steps.<id>)` from the row's own script and by nothing else, where
  `Steps.<name>` is the step's `id` column (139 of the 141 `playStep` call sites
  in the sheet name a step id on their own row). 158 steps declare it, 72 carry
  a real amount, and every one was being folded into its skill's cast output.
  (On build 25782799: 185 of 187 call sites, 214 steps, 107 with an amount of
  their own.)

  Brutal Frenzy (`GA_Craft_FinalCombo`) is the case that shows the size of it.
  The cast is the `1.43 × Strength` Area step — MEASURED **133** on the
  2026-08-01 dummy. Its second step is `id: "Attack", on: Code`, a Mono hit
  the row's own script plays. On the 2026-08-11 build that step was
  `0.3 × Strength`, played from

  ```
  function onInflictHit(hit) {
    if( rank >= 3 && hit.isBaseAttack) {
      if(checkProba(vars.chance)) { playStep(Steps.Attack, hit.target); }
    }
  }
  ```

  at `vars.chance` 0.15 — the tooltip's *"all your attacks have a 15% chance to
  deal an additional 28"* in as many words — so the finisher priced 133 rather
  than 161 and the 28 went on the base-attack clock. That closed the audit
  line that used to read *"billed per finisher, not as its 15%-per-attack
  rider… the wrong schedule is kept knowingly rather than half-read"*.

  **Build 25782799 retuned the row and the rule held without a code change.**
  READ off the row: the `Attack` step is `0.9 × Strength`, the guard is
  `rank >= 3 && hit.isFinalCombo`, and `vars.chance` is 0.25 — a quarter of
  finishers strike a second time for 0.63 of the first, where it was 15% of
  every attack for a fifth. The rider is priced on the finisher's event at
  that roll, on the weapon mix like the finisher it follows. MEASURED
  2026-10-13 (the capture, second session, the 60s of held basics): 16
  `GA_Craft_FinalCombo` rows are 13 finishers and 3 second strikes, each
  second strike 93-102ms after its finisher and at 0.63 of it to the integer
  (145 after 230, 188 after 299, a critical 256 after 265) — 3 of 13 against
  the authored 25%, and the ratio is 0.9 / 1.43 exactly. The same session
  holds the answer to the question the audit still asks, whether a second
  strike can roll another: one finisher of 265 is followed by FOUR strikes of
  167 about 100ms apart (22s into the session, n = 1 such run). So it can,
  and the fight's one-strike-per-roll pricing is a floor; how often is not
  yet counted (before the patch the same question read 54 of 411).

  Three shapes come out of it:

  - **an event rider** — `isBaseAttack` / `isFinalCombo` / `isWeaponSkill` /
    `isStatusType(Bleed)` in the guard: it goes on that event's clock, with the
    roll and the crit gate read the same way a proc's are.
  - **a per-cast rider** — `onDamage`, `onHit`, `onStart`, `onCastEnd`,
    `onAreaElapsed`, or a guard naming one of the host's own steps: its schedule
    *is* the cast's, so it is folded back into the cast at its chance. That fold
    is not cosmetic. `Staff_Censer_Skill2`'s entire damage is one such step
    (`onAreaElapsed` — a delayed detonation), and left outside the cast the skill
    carries nothing, never reaches the rotation, and the rider then has no parent
    to hang off. A weapon lost its best skill to that circle before the fold went
    in.
  - **a refusal, with the hook named** — `onGameBeat` (you blocked),
    `onReceiveDamage` (you were hit), `onAreaExited` (the foe walked out),
    `onStop`, `onStacksChange`, `checkStop`, or a guard asking live state.
    `Halos_Demon_Skill2` plays `2.5 × Intellect` when a target *leaves* its
    leash, and the simulated foe does not move: refusing it dropped that arsenal
    from 340.5 to 311.9 for the Mage and freed the search onto `Spear_Goo`, which
    scores **364.6 under both the old code and the new** — the optimiser had been
    stuck 24 dps below an option it could already see.

  A status row is deliberately exempt. A status is a thing that runs a script for
  as long as it is up, and its script-played steps *are* its payload —
  `Priest_Talent_Sunlight_Status` declares nothing else at all — so there is no
  cast to take them out of.
- **procs are events inside the fight.** By default each contributes its
  expected fraction — which is the mean, exactly, without sampling. `--fights n`
  rolls them with a seeded PRNG and reports the mean and the standard deviation
  instead.
- **and so is the crit.** For a long time it was the one die `--fights` did not
  throw: procs rolled, the ±10% swing band rolled, and crit stayed at its
  expectation — so a crit-bleed build, whose whole damage profile is *did the
  crit land*, reported a spread of essentially zero. That read as a claim about
  the build and was a fact about the model.

  A cast decomposes as `fixed + base × (1 + p(cd−1))`, because its crit chance
  and its crit multiplier are properties of the **skill** rather than of the
  effect — the category riders (`Sever` on weapon skills, `Master-at-arms` on
  attacks) key on `prof.type` — and the tick of a status typed DoT or HoT,
  which cannot crit at all (`SkillContext.initVars@5241` ops 3-33 zero the chance for
  those types: every bleed, burn and poison), falls entirely into `fixed`. A
  tick of any other status rolls its applier's crit
  ([whose sheet a tick reads](#a-status-tick-is-priced-off-whoever-applied-it)). Rolling *k* crits out of *n*
  hits gives `fixed + base × (1 + (k/n)(cd−1))`, whose binomial mean is exactly
  the deterministic number, so the default answer does not move by a decimal.
  What fed a pool follows the same die: Hemorrhage takes a share of physical
  **critical** damage, so a swing that rolled no crit feeds it nothing —
  averaging the feed while rolling the damage would have put the spread straight
  back where it was. On a `crit`-corner Warrior the reported spread went from
  0.2% to 2.5%.

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

**A DoT snapshots its applier's side, and reads its target's as it lands.** The
applier's part of its per-tick value is fixed when it is applied and does not
follow the applier's buffs that come and go while it ticks; a re-application
re-snapshots. The target's part is read at each tick: MEASURED 2026-10-13,
Lethal Poison's tick logged both 69 and 71 inside one application (68.95 and
70.01 priced) as Chaos Scorch's armour break came and went on the dummy.
When this was written nothing stated it either way and it was SimulationCraft's
convention. Half of it is READ now: a status's hits run in the status's own
`SkillContext`, built once when the status starts (`Status.postInit@15818` →
`BaseSkill.start@6145`), so the crit chance and the `(1 + fervor + mastery) ×
DamageModifier` bracket are the applier's at that moment. What stays ASSUMED:
the model prices that snapshot at the averaged sheet rather than at the state
of the moment, and whether a refresh re-seeds the context cannot be read
(`Status.refresh` is a server-only stub on this client). What does move a
running tick is the attacker's script hooks - Berserk is
`hit.dmgMult += vars.damage` in `onInflictDamageEval`, which is the mechanism
behind the measured tick jump in [§12](#12-checked-against-the-game).

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

One kind of press is also played out of that order. A press that lands on its
own caster, in a build holding a status such a landing puts up (Faithful Winds
under Sunlight), buys the status's window, which the ranking does not see, so
the fight is also played with that press LAST in the order and WITHOUT it -
every combination while there are at most 8, one press at a time past that -
and the best is kept. A releaser in the rotation for nothing but a release
that lands on its caster (Judgment with a heal as its only prayer, toward
damage) gets the same choice. The sheet's ROTATION block lists each order with
what it came to, and a press left out is named `not pressed` with both
numbers. These are orders the simulator can play, not a rule of the game, and
they make a Priest search about 2.4 times as long. What the order still gets
wrong is said in `bench audit`: a cast that puts a status up is kept for it
whatever the status carries, so a defensive or movement buff is pressed on
cooldown in a dps fight; and a press that deals damage and displaces more than
it deals is pressed whenever it is ready (on the tree before the hotfixes,
Zealous Spins in the arsenal of that day's default Warrior build read 812.1
where the same build with the slot empty read 846.3). One fight more per press
per evaluation would settle both, and was not taken.

Sequencing was worth **0–0.4%** while the resource mechanics were refused; with
Rage, Spark and Combo Points modelled for real the searcher finds **~1.7%**
where a pool wants managing. The player-facing debuffs are mostly movement
slows and the few damage amplifiers sit on long cooldowns, so the ceiling is
still modest — a fact about this game's numbers, not a limit of the method,
which finds a 2× on the synthetic cases whenever the data offers one.

### Reference targets

A target is described by two things: the damage reduction its row authors, and
the LEVEL it stands at. Feeding `resistForReduction` back through the forward
formula returns exactly the authored fraction at zero penetration only when
the target stands at the attacker's level; a target below you mitigates less
than its row says, because the pool is built at its level and divided at
yours. The `reference` target is the game's own
`constant.Armor_ExpectedReduction` (0.25), the designers' number and not one
this tool invented; the DEFAULT is `boss`, the named boss ul'Serous, Herald
Avatar (`Ulserous`, 0.40 / 0.40) at your level, because the constant sits
well under what you fight.

| `--target` | what it is |
|---|---|
| `none` | no mitigation at all - not a unit; the zero every hand calculation wants |
| `dummy` | the unit `Dummy`, the training dummy of the two hubs: it authors 0.40 / 0.40 and stands at level 1 |
| `reference` | `Armor_ExpectedReduction`, at your level |
| `trash` … `boss`, `dungeon` | the world's archetypes, at your level ([§13](#13-what-the-world-actually-resists)) |
| `heroic` | a heroic dungeon boss: the heroic rows at `MaxLevel` |
| any unit id, with `@veteran` / `@heroic` / `@scaled` | that unit, where that difficulty stands it |

**The Dummy is not the zero it was.** When this section was written the
`Dummy` row authored zero mitigation and nothing here depended on it. READ on
build 25782799: the row authors `armorReduction 0.4` and `magicReduction
0.4`, carries no level, and a level-less unit nothing summons is made at
level 1 (`ent.$Unit.__constructor__@15927` ops 135-165) - so its pool is 323,
built at level 1 and divided at the striker's, and a level-25 character gets
89.9% through. Five spawners place it, three in `Z2_Azuram_Hub` and two in
`Z1_Primevalley_Hub`; that was read on 2026-10-08 in the install's level
prefabs, which the bench itself does not open for targets. MEASURED: all
5,013 hits the pre-patch capture logged on it were at level 1, and on
2026-10-13 all three yard dummies in Tyrna logged `tlvl=1` on every row and
took identical damage. What is NOT yet measured is the 0.899 itself (a white
non-crit swing against its tooltip mid-range). Every "0-armour dummy"
calibration in this file and in GROUND-TRUTH.md predates the change and stood
on a row that really was zero.

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
| `all` (default) | it multiplies base attacks too - MEASURED 2026-08-02: a combo finisher at 133 went to exactly 133 × 1.12 × 1.016 = 151 under +12% PhysicalMastery and 30 FervorRating; without the Fervor term it prices 149 |
| `skills` | it multiplies skills only, matching the words "your Skills" (the default until that measurement) |
| `none` | it does not touch damage; only the three verified consumers apply |

Note that `HealGivenMultiplier` already carries Fervor, so healing must not have
it applied a second time — that one is verified and lives in the sheet.

**The switch survives as a toggle, not as the open question.** The bracket
was READ on 2026-08-02 (`GameObject.getDamageRatio@4577`: `(1 + fervor + mastery) ×
DamageModifier`, on everything but Raw) and MEASURED the same day on base
attacks. A second switch sits beside it since the 2026-10 pass, for the one
place the bracket's OWNER is in question:

| `--tick-source` | whose bracket and crit a status tick takes |
|---|---|
| `instigator` (default) | the unit that APPLIED the status - what build 25782799's context reads |
| `carrier` | the unit wearing it - what the 2026-08-11 build read, and what its captures measured |

See [a status tick is priced off whoever applied it](#a-status-tick-is-priced-off-whoever-applied-it).

Worth knowing what this cost before the rotation was modelled properly: with
skills ignored, base attacks were the only damage, Fervor was the only
multiplier that touched them, and the optimiser dressed a Priest head-to-toe in
Fervor gear. With prayers, weapon skills, procs and enchants scored, the same
search picks **SpellPenetration** across every slot and Fervor drops to noise.
The rotation model, not the Fervor switch, was what made that answer wrong.

## Searching a rotation

[`src/rotation.mjs`](../src/rotation.mjs). What is searched is a **policy**, not
a sequence, and the distinction is the whole design:

- A **sequence** is optimal for one build against one deterministic fight. It
  transfers to nothing, and because a cooldown that never comes back before the
  bell is free, it learns to dump everything in the last twenty seconds. Neither
  is a rotation anyone can play.
- A **policy** is an ordered list of `(skill, condition)`. At every moment the
  player can act, walk it top to bottom and press the first line that is ready
  and whose condition holds; otherwise swing. It is stationary — it cannot
  exploit the end of the fight — and its conditions are re-evaluated against
  whatever build wears it, so it transfers. It is also the object SimulationCraft
  calls an APL, except that a community writes those by hand and nobody writes
  them for this game.

**A condition may only say what the fight already tracks**, because one it
cannot evaluate is a rotation nobody can execute: `buff.X.up/.down`,
`debuff.X.up/.down`, `buff.X.remains>=n`, `rage>=n` and `rage<=n` at a threshold
something actually costs, `ready.X` / `holding.X` / `cd.X<=n` against another
skill, `charges>=n` against its own. Up to three ANDed. The vocabulary is built
from what **this build** produces — one taken from the whole game would be
mostly conditions that are never true, and each costs a fight to find that out.

Three of those atoms are recent and each one closes a sentence the list could
not previously say:

- **`buff.X.remains>=n` / `debuff.X.remains>=n`.** `buff.X.up` says nothing about
  whether the window will still be open when the cast lands, which is exactly
  what a priority list is for: do not start a long cast into a window with a
  second left, and do refresh a debuff before it drops rather than after.
- **`rage<=n`.** A generator is wasted at a full bar — Surging Force hands back
  Rage you cannot hold — so *press it while the pool is low* is a real decision,
  and `rage>=n` cannot express it at all.
- **`cd.X<=n`.** `holding.X` is true for the whole of a forty-second wait.
  *Hold the filler, the big one is nearly back* needs the near miss, not the
  binary. The reading is a superset of `ready.X` (ready counts as back-within-n),
  which is why it is refused as vacuous on X's own line, the same way `ready.X`
  already was.

The `remains` and `cd` thresholds are **not a continuum**. The only question a
remaining-time test can answer is *is there room for what I am about to press*,
so the discrete set is the occupancies of this build's own casts — the durations
actually on offer — rounded to the half second and capped at three distinct
values. On an `armorpen` Warrior that vocabulary is 45 atoms, and the search
reached for one immediately: `Shockwave if cd.Rampage<=1`, which is *do not
spend the filler cooldown a second before the big one comes back*.

**And the search remembers what it has played.** Steepest ascent regenerates the
whole neighbourhood every step, and most of it is unchanged from the step
before; iterated local search then kicks the incumbent by one or two moves and
re-climbs from a list it has mostly already seen. Roughly **43% of the fights in
a 40-restart run were re-simulations of a list the search had already played** —
99,601 fights for 176,358 lists considered. The memo is keyed on the list itself
(skills, conditions, order, exclusions); the build is fixed for one `searchApl`
call, so it needs no fingerprint, and a kit change makes a fresh call and a fresh
cache. It is bounded at 200,000 entries, because a cache that never evicts is a
leak with a hit rate, and evicting the oldest costs one re-simulated fight and
never correctness. The reported "N simulated fights" now means N fights actually
played, with the repeats reported beside it rather than folded in.

**A skill may appear more than once.** `Rampage if the armour is stripped` near
the top and a bare `Rampage` below it is the commonest idiom in a real list, and
a representation allowing one line per skill cannot express it at all. The
search used it as soon as it could: `Raging Smash if rage>=18` above the window
and `Raging Smash` again below it.

**The search is iterated local search**, not random restarts. Moves are reorder,
relocate, re-condition, conjoin, relax, drop and add; every third restart is a
fresh random list and the rest are one to three random kicks away from the best
found so far. That change mattered more than any other: climbing from random
lists alone reached the best score in **1 restart out of 30**, because the basin
around a sensible priority order is narrow and almost every random list falls
into a worse one. With kicks it is **107 of 250**.

Restart 0 always starts from the order the model derives, so the answer can
never be worse than what every other command already reported. Ties break toward
the simpler list — fewer lines first, then fewer terms per line — which is what
keeps conditions that are quietly tautologies out of the output. `ready.X` on
X's own line is always true and `rage>=9` is implied by a fight that only offers
casts it can pay for; both survived until the tie-break counted terms, and both
made the printed rotation look like it knew something it did not.

**Rounds alternate**: search the rotation with the kit fixed, then the kit with
the rotation fixed, until neither moves. The kit half lets unlisted skills fall
through the policy, because otherwise every change that slots a new skill is
judged with that skill never pressed and looks like a loss.

### What it found, and what it found by accident

For Judgement + Worldsplitter at the `armorpen` corner: **+0.49%**, 326,656
simulated fights in 41 seconds. `--validate` re-rolls the procs rather than
averaging them and says outright when a difference sits inside the spread;
`--across` re-runs the rotation at other corners, where this one holds at five of
six and loses 0.73% at `half`.

The first run paid for the whole thing by finding a bug in the fight. It put
`Ignore Pain` — zero damage, one `DamageTakenModifier` affix — at the top of the
priority list and gained 3.4%. A defensive cooldown cannot raise damage, so
something was wrong: `restat`, which re-prices a cast while a buff is up, copied
the three modifier accumulators at *call* time, and the averaged-sheet step
mutates those same maps to fold in every timed buff at its uptime. So the moment
any window opened, casts were priced against base + every timed buff averaged in
+ the one actually up, and **pressing any buff at all was a global damage
bonus**. Warrior 378.8 → 367.5, Priest 252.7 → 227.1; Rogue and Mage do not
move, because their builds put up no timed self-buff for it to bite on.

### Why the number is small, and what would change it

*(Written on the 2026-08 build, and the prediction in its last paragraph came
true. On build 25782799 the same command -
`bench rotation --class Warrior --profile armorpen --pin weapon1=GA_Craft
--pin weapon2=GA_Demon --restarts 60 --across` - finds **+7.92%** over the
derived order, 492,310 simulated fights, holding at five of five corners and
clearing the dice at +17.65 ± 0.44 dps; 12 of 60 restarts reach it. Two of
the mechanisms the text below asks for exist now: the fight counts stacks,
and scripts may hand cooldown back. And a register a stun arms for the next
weapon skill is exactly the kind of state an ordering can exploit.)*

Sequencing is worth 0–0.5% on this data, and the reason is not the search. The
mechanics that reward ordering are mostly ones the model refuses: 17 skills gate
on `hasStatusMaxStacked` and 24 read `getStatusCount`, and 43 sites reset or
reduce another skill's cooldown. The fight tracks *which* statuses are up but not
*how many*, and nothing is permitted to touch cooldown state. Ram Veil is the
worked case — build five Benediction stacks with the combo, spend them for a
15-second Crit/Fervor window, and a critical combo finisher resets the cooldown
and makes the next cast instant — and the model prices it at a flat `0.8 × Faith`
whether you press it at five stacks or none.

Two mechanisms would unlock most of it, and both are the same move this project
has made repeatedly: take a predicate off the refusal list by giving the fight
the state to answer it, rather than approximating it.

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

**Every stat is PINNED to a flat number, and one is raised.** `zero` pins
everything to 0, `mid` to 50, and each named profile pins everything to 50 and
its own stat to 100. `--profile-base` and `--profile-peak` move both numbers.

So `crit` minus `mid` is exactly *"+50 CritChanceRating and nothing else moved"* —
the comparison that isolates a stat.

**Forced, not added.** The values replace whatever the level curve, the gear and
the weapon produce, so a weapon that happens to be a better stat stick cannot win
on that: two weapons differ only in the kit they grant and the coefficients they
scale by. `computeSheet` applies them *inside* its topological walk, so
everything downstream is computed from the forced number — pin Dexterity and the
CritChance that scales off it moves with it. Overriding the finished sheet
instead would leave every derived stat quietly disagreeing with the stat it
derives from.

**The numbers are arbitrary, and that is the point.** 50 is not half of anything
and it is not what any character wears; it is a fixed rig, the same for every
weapon and every class. A profile denominated in budget fractions cannot do that
job — a Warrior's full primary budget is 123.6 and a Rogue's is 148.3, so "half a
budget" is a different number per class and carries the budget's own shape into
the comparison. The budgets are still computed and printed beside the rig, so
the distance from a real character is visible rather than hidden.

An earlier version of this file denominated the corners in budget fractions and
poured the whole ratings budget into one rating, which meant a "crit" corner also
had **no penetration** — a difference with two causes measures neither.

### What it measured

`bench weapons --across` runs every mainhand at six corners. On this data, above
the bare corner:

| | |
|---|---|
| weapon ranking | mean shift **0.3–0.6** places out of 13, worst 3 |
| which two skills to slot | **identical at every corner**, on all eight weapons checked |
| talents | 3–4 different sets across six corners |
| runes | 2–4 different sets |

`zero` is the one corner that reorders the top — `GS_Nova` wins with no gear on
and `GA_Craft` wins everywhere else — which is worth knowing and is not a
surprise: with no ratings at all, a weapon's raw coefficients are the whole
story.

That table is the 2026-08 build's. Run again on build 25782799
(`bench weapons --class Warrior --across zero,mid,crit,armorpen,fervor,strength`,
14 mainhands, 241s) the shape holds and two details moved: the mean shift
above the bare corner is 0.57 to 0.86 places out of 14 (worst 3; `zero`
1.43, worst 5), the skill choice is `same` at every corner on all eight
weapons the command tabulates, talents take 2 to 4 different sets and runes 2
to 4 - and Judgement (`GA_Craft`) now wins at `zero` too, 144 to Wingsabers'
138, where Martyr of Enripit (`GS_Nova`) has dropped to twelfth. Its swing
ratio went from 0.95 to 0.7 in the update, which is at least part of why;
the rest was not decomposed.

So the weapon and its skills are **one decision that does not depend on your
gear**, and the tree and the runes are re-decided per stat corner. That is the
shape a rotation search should be built to, and it is a measurement rather than
an assumption.

## The search

Coordinate ascent with exhaustive per-slot enumeration: walk the free
decisions, and for each one try every legal option with everything else held
fixed, keeping the best. Stop when a full pass changes nothing. One exception:
the skill step tries a newly slotted skill with each of its runes (a pinned
rune stays pinned), because a skill whose worth is its rune never reaches the
bar for the rune step to find it. It is a local search, and it can end below a
build it found before: on build 25959898 the default Warrior search settles at
841.7 on a four-piece Balance of Justice build, where its previous optimum
still prices 846.3.

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

**A weapon rolls its rarity; a piece of gear never does.** READ on build
25782799: the roll is made where the loot entry becomes an item, in
`ent.Hero.makeLootItem@7953`. Ops 126-129 test
`isSameType(item.type, "Weapon")` and jump past the whole block (to op 422)
for anything else; ops 140-167 read the entry's `minRarity` / `maxRarity`;
and the draw from op 168 on walks `rarity.props.generationChance`, banded by
the loot level, inside those bounds. So a CDB-`Rare` sword can be sitting in
your bag as Legendary, and a CDB-`Rare` chest is Rare for ever: its Epic
version is another row.

That replaces two things this section used to say. It cited
`st.Player.dropLoot` for the roll; that function is a server-only stub on this
client (`st.Player.dropLoot@8181`, three ops), so what it did on the
2026-08-11 build can no longer be re-read. And it offered a rarity roll on
every slot, which is how the optimizer came to price a Rare chest as Epic - a
phantom piece, since the 2026-10 build authors a real Epic row beside it with
different stats.

So the honest ranking unit is **(item, rarity)** for a weapon and the row
itself for gear. `--rarity-roll` (the default; `--no-rarity-roll` pins every
weapon to the rarity its row authors) expands each weapon candidate into one
row per attainable rarity with its share shown. The share is NORMALISED over
the rarities at or above the row's own, the way the game draws it: a
Rare-authored weapon at level 25 is Rare 71.4% / Epic 27.1% / Legendary 1.43%
(50, 19 and 1 over their sum of 70). Not modelled, and said in `bench items`:
the luck counter that shifts those odds and a source that carries a floor.

**How high a roll can go is declared in exactly one place.** Eleven columns
are typed on `rarity` (`bench rarity` lists them off the schema). Two of them
bound a roll: `item@props@gainItem@rarity.min` and `.max`, a CONTAINER's own
floor and ceiling, copied onto every loot entry it opens
(`st.skill.GainItem.onStartStep@32109` ops 99-110) and rolled inside. One row
authors one today: Hero Weapon Cache (`HM_Weapon_Cache_25`), floor Epic, no
ceiling. Beyond that no column declares a ceiling for a slot or an item:
`lootTable` carries no rarity column, there is no rarity custom type, and
`WeaponRarityChances_Low` holds only a level range. So two derivations stand
in, and both move on their own when the data does:

* a weapon slot takes the highest rarity flagged `AllowRandomWeaponDrop` - the
  one thing in the database that names the weapon / non-weapon split at all.
  That is Legendary.
* every other slot's "ceiling" is only the highest rarity AUTHORED on a
  stat-bearing row that fits it **and that this install hands out**
  ([what the install hands out](#what-the-install-hands-out)). Requiring an
  aptitude keeps shop cosmetics such as `Head_Shop`, which are Epic and grant
  nothing, from raising it. On build 25782799 that is Epic on the eight
  armour slots and the trinket, Rare on the neck and the two rings. It was
  Rare everywhere on the 2026-08 build, and the suite's ceiling tests failed
  on the new one with the message they were written to fail with.

`bench rarity` prints both alongside the raw table, so a patch that moves
either is visible rather than silently absorbed, and `--rarity-cap` overrides
the weapon one.

Level bands, from the sheet on build 25782799:

| rarity | L1–10 | L11–30 | L31–49 | L50+ | iLevel bonus | max stars |
|---|---|---|---|---|---|---|
| Uncommon | 40% | 30% | 15% | 0% | 0 | 2 |
| Rare | 60% | 50% | 59% | 60% | +10 | 3 |
| Epic | 0% | 19% | 25% | 35% | +50 | 4 |
| Legendary | 0% | 1% | 1% | 5% | +70 | 5 |

The two top bonuses were +30 and +50 until the September 30 update; a
Legendary five-star weapon at level 25 is iLevel 370 now where it was 350.

**An Epic tier of armour exists, and it is rows.** The 2026-08 build authored
no combat item above Rare (its 138 Epic equippables were gliders and shop
cosmetics). Build 25782799 authors 125 Epic stat-bearing gear rows: fifteen
for each of the eight armour slots and five trinkets. 26 of them sit only in
loot tables nothing in this install opens and are withheld from the search
with that reason; the other 99 can only be made at level 25, which the
effective-level floor in [§6](#6-what-an-item-is-worth) enforces.

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
the absence of animation timing data, that item affixes have no RNG
(`$HItem.generateItemAffixes@21736` made zero random calls when it was read on
the 2026-08 build), that a weapon's rarity is rolled when it is made and a
gear piece's never is.

**Assumed, and flagged in `bench audit`** - the table below is the 2026-08
list, kept with its strike-throughs because each row records how a question
was closed. Rows the September 30 update reopened say so in their first cell,
and the live list is `bench audit` (92 entries on build 25782799: 23
verified, 60 assumption, 6 unmodelled, 3 info):

| assumption | why it is a guess | how to settle it |
|---|---|---|
| ~~Fervor / the Masteries~~ **READ 2026-08-02**: one additive bracket `(1 + fervor + mastery) × DamageModifier` | `GameObject.getDamageRatio@4577` (GameObject.hx:830-834 on build 25782799; 716-720 when first read), disassembled with the repo's own `bin/hl.mjs`. Applied to every affinity except Raw (`getDamageScale@5238` returns 1 outright). On the 2026-08-11 build it was never applied to a foe-worn status tick, whose SkillContext belonged to the carrier (`SkillContext.initVars@5241`); on build 25782799 the same ops read the status's INSTIGATOR, so a tick takes its applier's bracket - read, not yet measured. The measured finisher 133 → 151 = ×(1 + 0.12 + 0.0158) agrees to the integer. | done — `--no-mastery` / `--fervor-scope` remain as toggles |
| `WeaponPower` on the **2026-08-11 build** = the trained level's flat primary budget **plus your primary attribute**. SUPERSEDED on build 25782799 - the rule is `R × mean(0.4 × budget + 0.6 × attribute)` now, see [WeaponPower](#weaponpower-the-rule-that-moved-under-an-unchanged-function). This row is kept whole as the record of how the accepted rule was measured; its "0-armor dummy" was the 2026-08 Dummy, which authored no armour | It has no scaling entry and no budget group, so the weapon must set it — 67 mentions across the whole CDB and three strings in the binary, none of them a setter. **Measured 2026-08-01 on a real Cheese Moon vs a 0-armor dummy, twice:** the bag tooltip reads 18–21 against a naked Strength of 34, and the same swing runs 19–24 once the axe's own +15 Strength is equipped — `0.13 × (budget(25) + Strength)` reproduces both within ~5%, the same flat 116 falls out of both readings, and the +2 the equip added is exactly 0.13 × 15. Rarity/star iLevel bonuses belong to the stats (the same tooltip's stat lines match the drop-level budget), not to the damage line. The old slot-share reading (×0.28 at the authored item level) was four to five times low on every base attack. The weapon's "Level 25" is its TRAINED level (weapons level per kills, `WeaponKills_PerSkillRankPoint`); assumed fully trained. **Completed cross-type the same day with Judgement dummy reads:** two-handers take 0.4 of the flat budget where one-handers take all of it (swings 78–95 at Str 72 → flat ≈ 52 = 0.4 × budget), and a **mainhand weapon skill's attribute scaling is 60% attribute + 40% weapon flat** — `constant.WeaponPowerRatio`'s own description, `MainhandWeaponSkill 0.4` — measured exact on five integers: Rampage 233/371/556 at authored 2.5/4/6 × Strength and Brutal Frenzy 133 + its 28 rider at 1.43/0.3, all `ratio × (0.6 × 72 + 0.4 × 123.6) = ratio × 92.7`. Also measured in the same session: PhysicalMastery ×1.12 exact, Fervor applying to base attacks (finisher 133 → 151 = ×1.12 × 1.016), and the ±10% roll riding only the WeaponPower-scaled swings (the Strength-scaled finisher never varies). **Completed with the expanded tooltips (Beefury, Wingsabers):** the game *renders* the rule — Royal Severance "(30 + 30% Intellect) + (25 + 30% Strength)" is 0.6 × authored 0.5 on the attribute and 0.4 × 0.5 × **each attribute's own level-25 curve** as the flat (148.3 / 123.6); Hive Bite's 29.33% is authored 0.85 × its own rank-2 +15%. Tear's 75 proved the per-attribute flats. Swing attribute terms **split across the item's aptitude attributes** — Beefury "(13 + 6.5% Strength + 6.5% Faith)". Skill flats follow the *character's* level; swing flats follow the *weapon's trained* level (two Epic 0-star bag reads imply flats ~100–107, i.e. under-trained weapons). Ten integers reproduce exactly. Open: whether a dual-aptitude item pays BOTH halves to one wearer — Tear's 75 needs the axe's +18 Dexterity on a Warrior sheet; one character-sheet read of Dexterity settles it. | read Dexterity on the equipped sheet (46 vs 28); read the bag weapons' Level lines; disassemble the weapon-equip path for provenance |
| ~~a cast costs only its own authored duration~~ **READ 2026-08-02**: no hero recovery exists | `Skill_RecoveryTime`'s only reader is `Foe.getSkillRecoveryTime@7043`, whose only callers are foe AI; the once-unplaced bare `recoveryTime` symbols resolve to the skill sheet's `aiProps` column — foe-AI data plumbing. The stopwatch agreed first (ten Judgement chains at exactly the authored 3.0s). | done |
| how many enemies an area hits | Fully absent from the data — geometry is authored, population is not. `--targets` is an input, defaulting to 1. | measure in game |
| a `Mono` step carrying an area does not cleave | 80 rows do it and their descriptions disagree; single-target is the reading that agrees with 87% of them and cannot flatter. | `forceMono` in the binary |
| ~~a re-applied status refreshes rather than stacks~~ **READ 2026-08-02, on the 2026-08-11 build** | `addStatus@4636` switched on the authored `stackingPolicy` enum [Additive, DurationBased, Override] exactly as modelled, and `Status.refresh@15820` never SHORTENED a window — the refresh duration was max(new, remaining), which the fight applies too. Both functions are server-only stubs from build 25782799 on: the bodies this row read are not in the client any more and the rule cannot be re-read there. Where the 2026-10-13 capture looked it agrees - a third dose on a poisoned dummy restarts Lethal Poison's 20s. | done on the build it was read on; not re-readable |
| `LinearRatio` behaves like `Flat` | No row in this build uses it. | wait for one, then check |

**Absent entirely, when this was written** — most of what a skill script does.
508 of the 1098 skill rows carry hscript bodies on build 25782799, 508 of 1101
on 25959898 (427 of 962 on the 2026-08 build). The paragraph below is the FIRST reader's reach;
[§14](#14-what-the-script-readers-take-and-where-to-pick-up) and the dated
sections after it are what has been read since, and `bench audit` counts
what is still refused. Four things were read out of the text because the data
records them nowhere else: the status a skill applies (`addStatus`, through a
local alias if it uses one), the event that applies it (`isWeaponSkill`,
`isBaseAttack`, `isFinalCombo`), the roll that guards it
(`checkProba(vars.chance)`), and `vars.chance` itself. Everything else is not: a
magnitude passed as a third `addStatus` argument (`Warrior_Hemorrhage` bleeds
for 35% of the hit that applied it), a `setDynVal` injection, a conditional
rider. Those are named in the output rather than counted at zero in silence.

Also absent: party buffs (`Group_MaxPlayers` = 4), consumables (4 slots, 80
items with effect props), threat, a foe that acts (so crowd control is worth
nothing as a control - it is read as a state since the 2026-10 pass), and
every non-combat slot. Per-swing variance stood in this list too; it has been
modelled since 2026-08-02, when the ±10% band was measured on the dummy.

**And the one that mattered most when this section was written:** none of it
had been checked against the running game. "The bytecode says X" and "the
process does X" are different claims. [§12](#12-checked-against-the-game) and
everything dated after it is the record of the second claim being
established for the 2026-08 build - and the September 30 update put a large
part of the model back on the first claim alone, because the capture chain
did not load on the new build until 2026-10-13
([the first measured night](#what-the-capture-says-so-far-2026-10-13)).

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

On record from the game, and implemented as a **payout ledger** in the fight:

> A 200 crit banks `200 × 0.35 = 70` damage over 8 seconds, four ticks of 17.5.
> Crit again for 100 two ticks later and the 35 still owed is **added** to the
> new 35, redistributing 70 over a fresh 8 seconds.

So the remainder is carried, not dropped — which is neither the `refresh` the
model does elsewhere nor the `stack` it refuses. Each feed adds to what is
owed and resets the per-tick rate over a fresh window; each tick pays it down;
what the bell catches un-paid is dropped, because a damage meter never saw it
either. Over a 200-second fight that tail is a fraction of a percent — over a
short one it is not, and crediting it in full read a 3-second fight four ticks
rich. Generalising the carry to every dot whose declared amount is a total
takes the answer to **44,000 dps** on a Mage: those are applied on every
swing, so a pool that never drops its overflow never bounds. The
`stackingPolicy` column keeps it to the four statuses that declare it.

**Which damage feeds a pool is the HOOK's rule, then the guard's.**
`onInflictDamage` is owner-global — Hemorrhage takes 35% of every physical
critical strike you land, whoever landed it, and `if (dmg.isDoT) return;`
keeps it from feeding itself. A skill's own `onDamage` sees only that skill's
hits: `Axe_Boomerang_Skill1` (Bonethrow) BANKS 40% of the damage *Bonethrow*
deals, crit or not — its guard has no crit test. Banks, not "bleeds for": the
share is what goes into the ledger, and the status row pays it back out as
Damage of its own affinity, each tick a hit. A Raw pool (Hemorrhage,
Virulent Contamination) pays what it banked. A pool that is not Raw -
Bonethrow's Physical bleed, Spark Hemorrhage's Magic one - takes the
target's armour again on every tick, the banked hit having paid it once
already, and on build 25782799's read the applier's
`(1 + Fervor + mastery) × DamageModifier` as well
([whose sheet a tick reads](#a-status-tick-is-priced-off-whoever-applied-it)).
The second armour pass was invisible while the Dummy authored no armour and
every calibration was on Raw Hemorrhage; it is READ, not measured, and one
Bonethrow on today's Dummy measures it. Reading its
per-skill hook as global fed its pool from the whole rotation's crits, which
invented ~18% of a Warrior's headline dps and drove the arsenal pick. A hook
the reader does not recognise refuses the pool by name. The multiplier a
bleed-scoped talent adds is matched per pool dot through the `statusType`
sheet's parent chain — `Hemorage` declares `parent: Bleed`, so Bloodletting's
Bleed guard covers both dots and Exsanguination's Hemorage guard covers only
Hemorrhage and Infused Wound.

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

**The chain length, confirmed for the 2026-08 build - and what it swung was
not what was filled.** Flame of Argol (`Scepter_Flamie`) swung **3 times and
then the combo finisher** — four links, which is what its moveSet's
`comboLength` said and not what its own item row lists. That observation was
right. The inference drawn from it here - that the game resolves the missing
links from the weapon type, so the two rows filled in
[section 9](#the-chain-is-the-weapons-own-rows) "are the right ones" - was
not: the capture later showed the old client repeating the item's own last
swing (A A A, and A1 A2 A3 A3 on Twin Pillars of Justice, which this
paragraph said had not been observed). On build 25782799 `comboLength` has no
reader and the chain is the listed rows alone - one swing and the finisher on
that scepter - READ and not yet watched.

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
`unit.stats[].specScaling.armorReduction` and `.magicReduction`. The game turns
that intent into a pool at the unit's level, so a target is described by three
things - two authored fractions and a level - and all three are read, not
invented here. This section was rewritten on 2026-10-13 for build 25782799;
`bench targets` prints everything in it off the rows, and what the 2026-08
text said differently is kept at the end.

28 units author an intent (5 more only in Heroic) and the rest inherit it up
the `unit.inherit` chain, which resolves for 432 units. The ladder the world is
built on:

| tier | reduction | who |
|---|---|---|
| `W_Assassin` | 0.20 | world assassins |
| `W_Base_Small`, `D_Base_Small`, `W_Assassin_U` | 0.25 | small mobs |
| `W_Base` | 0.30 | world trash |
| `W_Base_Big`, `W_Base_Unique`, `D_Base_Big` | 0.35 | big and unique mobs, dungeon mobs |
| `W_Base_Elite` | 0.40 | world elites |
| ten bosses with a row of their own | 0.40 | DemonSuperElite, DemonSuperElite_Fairy, Crabgantua, MunsterChuck, Mokshi, Phrixes, Phrixes_NightGod, Ulserous, Cleodora, Ratsar |
| `Dummy` | 0.40 / 0.40, at level 1 | the training dummy (it was 0 until the 2026-10 build) |
| `PunchingBagArmor` / `PunchingBagMagicRes` | 0.5 / 0 and 0 / 0.5 | dev targets |

### One row, not a sum

**A unit's armour is ONE row: its own when it authors one, the nearest
inherited otherwise.** READ: the unit merge keeps a child's reduction row and
throws if two rows of one attribute survive (`DataCache.initUnits@19817`,
ops 155-264 of the row-merging closure it creates), and
`ent.Unit.getAtbLevelScaling@4882` builds the pool from the single row `DataCache.getStatInfo@19835` returns, times its
multiplier, rounded.

MEASURED, on the pre-patch capture: for one hero and one skill, a unit with
its own 0.25 or 0.20 row under an inherited 0.30 takes MORE than a plain 0.30
unit at the same logged level in 186 of 201 pairs, median 1.073 - one row
predicts 1.071, a sum 0.811. A 25-pair extract of it is in the suite. Limits
of that evidence, stated: 19 heroes, the target's debuff state was not logged,
and the 0.35 tier reads softer than its row.

That retires the law this file carried from 2026-08-11 ("armour is a SUM over
the inheritance closure", at the end of this document, kept as the record of
how it was fitted). The sum was fitted to boss windows in which the boss took
more than either reading allows - party armour shreds, INFERRED, because the
target's live armour was never logged - and it read 12 to 18 points of
mitigation too hard wherever a unit has a parent with a row: `small` 43%
where its row says 25%, `big` 49% for 35%, `elite` and the inheriting bosses
52% for 40%. Still owed, solo: one swing on a Nightspawn Invader
(`ImpDemon_Rift`, own 0.25 under 0.30) against the same swing on a Nightling
Invader (`Demon_Rift_Claws`, 0.30 alone), both at level 25 - about 1.07
confirms one row and 0.81 would be the sum.

### A level, and who sets it

The pool is built at the TARGET's level and divided at yours
([§4](#4-mitigation)), so the level is half the answer. READ:

- a spawner passes its own level or none (`ent.FoeGenerator.spawnUnit@7528`
  ops 28-39); the unit constructor then takes the row's `lvl..maxLvl`, or 1
  (`ent.$Unit.__constructor__@15927` ops 135-165);
- **Veteran and Heroic** override it with `MaxLevel` (`spawnUnit` ops 40-76);
- in an activity flagged `DynamicScaling` the pool is rebuilt at the
  STRIKER's level (`ent.GameObject.receiveHit@4540` ops 0-15,
  `ent.Unit.computeDamage@4920` ops 59-68) - a rift;
- a SUMMONED unit never takes the roll: every summon path hands the
  constructor its summoner's level (`ent.GameObject.spawnFoe@4698` ops 28-30),
  and who summons whom is in `data.cdb`.

So a unit id is priced at its row's level (Normal difficulty); `@veteran`,
`@heroic`, `@scaled` and `--target-level` say otherwise, and the archetype
shortcuts (`trash` … `boss`, `dungeon`) stand at YOUR level by declaration. A
row with no level that something summons stands where its summoners do (five
such targets), and only a level-less row nothing summons stands at 1 - fifteen
targets, the training dummy among them.

MEASURED, pre-patch capture: 296 of the 300 unit archetypes it logged a level
for were only ever at their row's level, their summoners' or at 25. What the
bench cannot see is WHICH of those you are in: the activity rows and the few
spawners that name a level ship in the level prefabs, not in `data.cdb`. The
per-family fitted levels that stood here (rift 6.9, arena 7.9, dungeon 12)
are gone with the armour sum they were fitted with; the logged levels
contradict each one they match.

At level 25, against a level-25 striker:

| target | reduction | armour | damage through | at 50% pen | gain |
|---|---|---|---|---|---|
| `none` | 0 | 0 | 100.0% | 100.0% | - |
| `dummy` (level 1) | 0.40 | 323 | 89.9% | 94.7% | +5.3% |
| `reference` (the constant) | 0.25 | 962 | 75.0% | 85.7% | **+14.3%** |
| `small` | 0.25 | 962 | 75.0% | 85.7% | +14.3% |
| `trash` | 0.30 | 1,236 | 70.0% | 82.4% | +17.6% |
| `big` / `dungeon` | 0.35 | 1,553 | 65.0% | 78.8% | +21.2% |
| `elite` / `boss` / `heroic` | 0.40 | 1,923 | 60.0% | 75.0% | **+25.0%** |

Penetration is worth nearly twice as much against a boss as against the
designers' reference constant, which is why the default `--target` is `boss`
and not `reference`. `--target` also accepts any unit id whose intent
resolves.

### Heroic

Heroic is the third `ActivityDifficulty` (`st.GameLayer.isHeroicMode@7661`).
READ: a unit stat row is three-state - no `heroic` key applies in both modes,
`false` in Normal only, `true` in Heroic only (ops 85-110 of the same
row-merging closure of `DataCache.initUnits@19817`) - and 35 rows on 11
units carry `true` on build 25959898 (27 on 9 on 25782799). `--target
<unit>@heroic` reads exactly that at `MaxLevel`, and `heroic` is what the 10
bosses that author a heroic loot table in a dungeon whose Heroic is released
resolve to: 10 of 10 at 0.40 / 0.40, a pool of 1,923. Seven of them
(Nepsilon, Reblochonk, Gatsbee, Munster Chuck, Sponge Blob, Golcano, Robin
Hoof) carry that row only in Heroic, so
their Normal selves mitigate what their archetype does - Nepsilon is 30% at
level 5 in Normal, 11.6% to a level-25 striker.

NOT MEASURED, and one swing settles it: a heroic boss should take 0.667 of
what the training dummy takes. Heroic TRASH is unmodelled and says so:
`ent.Foe.setHeroicScaling@7094` is a server-only stub, and
`Dungeon_Heroic_HealthScaling` (3.5) and `Dungeon_Heroic_FoePowerScaling`
(2.5) are read by no client function, so which attribute each multiplies is
unknown. Neither is an input of a damage number; armour is, and no unit but
the bosses authors a heroic armour row, so heroic trash is priced on its
normal row at `MaxLevel`.

### What follows for gearing

**Physical and magical reduction are equal on every foe but a named few.**
The 17 units that inherit `Golem_Base` carry an Armor multiplier with no
MagicArmor twin, so a golem is harder to hit than to burn (`Golem_Z1W_Earth1`:
41% / 30%); and three rows author a split outright - the two punching bags
and `R1KoboldBoss_Sparkling` ("Snack of Ratsar", 0% / 30%, its own
`Armor value: 0` row replacing its parent's). Against everything else
`ArmorPenetration` and `SpellPenetration` are worth exactly the same: which
one you want is decided by your class and your gear's faction, never by the
fight. The suite counts the exceptions off the rows, so a patch that adds
one fails by name.

**Not modelled.** `unitType.props.resistance` is an affinity-level resistance
hook and only `Bee` uses it (`Honey`), so it is inert today - and since every
sub-school is empty (§4), an affinity resistance would have nothing to attach
to anyway. `specScaling.playerCount` scales boss health and add counts with
party size, which the model does not carry. A Critter-typed or Invulnerable
unit refuses every status (`ent.Unit.canReceiveStatus@4922`), damage over
time included, and the model still prices a bleed on one if you name it as
the target; the audit says so.

**What this section said until 2026-10-13**, for anyone reading an old
ledger: "27 units declare an intent ... resolves for 420 units"; `Dummy` and
`PunchingBag` at reduction 0; "physical and magical reduction are equal on
every real foe - only the dev punching bags split them"; and a level-25
table that had no `small` row and no level column, because every target was
taken at the attacker's level.

---

## The verification era (2026-08-06 .. 2026-08-11)

Everything above describes the model as derived; this section records what
holding it against the game's own record changed. The instrument is
`bench verify`: the HLX probe's capture supplies the damage the game actually
dealt and a build snapshot taken while it was being dealt (gear with rolled
rarity, sockets, talents at rank, live affixes with provenance), and the join
prints per-skill signed deltas plus a SHEET check against the game's own affix
arithmetic. The capture is the oracle; the game's damage code cannot be run
outside the client (server-side, verified at the opcode level - applyDamage
throws without Config.server and logged zero rows in 4.5M).

**How to read everything from here to "The armour law".** These sections are
the record of the 2026-08-11 build, written in the present tense of the day
each was written, and they are kept as written. Six things in them did not
survive the September 30 update and are marked `[2026-10: ...]` where they
stand: boss levels as fitted zone levels, armour as a sum over parents, a
status tick taking its carrier's bracket and crit, the stacking Lethal
Poison, `isWeaponSkill` as skill type 7 alone, and the description of the
patch-day pipeline. The rules that replaced them are in
[§13](#13-what-the-world-actually-resists) and in
[the September 30 update](#the-september-30-update-build-25782799).

Corrections that came out of it, each verified against a capture and most
against the bytecode:

- **Mitigation composes as two multiplies**, not one sum: armorIgnore takes
  its own `(1 - clamp(a,0,1))` on the pool before penetration's
  `(1 - clamp(p,0,100)/100)` (getAffinityDamageReduction@4582). And armour is
  a RATING at a LEVEL: the pool is built at the target's spawn level, the
  divisor at the striker's (`foe(name, level, targetLevel)`, parity default -
  boss rows' lvl column is contradicted by measurement; they spawn at zone
  level). Dynamic level scaling (GameObject.getDynamicScalingFactor@4713) is read and
  confirmed inactive in ordinary fights. `[2026-10: the two multiplies and
  the rating-at-a-level stand. "Boss rows' lvl column is contradicted" does
  not: the logged levels agree with the rows for 296 of 300 archetypes, and
  the contradiction was the armour sum's - §13.]`
- **Units inherit from every parent** (the row-merging closure of
  `DataCache.initUnits@19817` iterates all `inherit` entries; this sentence
  cited it by its debug-local name `loadUnit` until 2026-10. Modifier-only
  stubs take the parent's row with multipliers multiplied). Golems mitigate
  0.4068 physical off a 0.30 base and are the one family where
  ArmorPenetration beats SpellPenetration.
- **The character sheet and the combat sheet are different objects.** The
  fight prices against permanent statuses at cap (a Devote enchant's five
  stacks are the value of the slot); the sheet the game shows you standing
  still contains none of that - except auras with no duration, which are worn,
  not entered (the Boomerang crit aura). `bench verify`'s SHEET check now
  lands 9/9 to 12/13 attributes within 1% on all four classes.
- **A star is not the rider rank.** Weapon upgrade skills attach at three
  stars (GearUpgrades.SkillUnlockLevel) and take their rank from the ROLLED
  rarity index (Weapon.updateInf@9829 overwrites the authored rarity), settling the
  stars-minus-one question. Upgrade proc chances rank-resolve through the
  same overrides. The behind perk (dmgMult += vars.damage on basic attacks
  from the rear half-plane) sums across both weapons into the one additive
  bracket, billed at `assume.behindFraction` (default 1, an assumption).
- **Which ticks crit is the statusType's DoT/HoT flag** (SkillContext.initVars@5241 zeroes
  ctx.critChance only for flagged types, parent chain walked); everything
  else ticks with the CARRIER's crit chance. Buff auras crit; poisons do not.
  `[2026-10: the flag rule stands. "The CARRIER's" does not on build
  25782799 - the same ops read the status's instigator. The carrier rule is
  what this build's captures measured and is kept as --tick-source carrier.]`
- **Scripted riders are events, not decoration.** onInflictStatusEval rides
  dot ticks - once PER STACK (measured: exactly 5.0 procs per tick at five
  stacks); `status.kind == Skill.X` filters which dot; hasStatusMaxStacked on
  a build-applied status is a named assumption; a self-`resetCooldown` behind
  a Mark another skill supplies is a banked economy (one mark per supplier
  cast, one spent per reset). Multi-applier dots keep one identity fed from
  every channel - Lethal Poison went from -81% to -1.4% per tick on that
  change alone. `[2026-10: that was the stacking Lethal Poison of the
  2026-08 build; the update removed it and the number calibrates a body
  that no longer exists.]`
- **Coverage is 100% on all four classes**: every damage source the game
  recorded has a model line. Held against a player pressing the proper
  rotation on one dummy, the formulas price within -2.9% at the player's own
  press rate; the model's own fight cadence remains the dominant residual.

Patch days run through `bench update`: model/fingerprint.json holds one hash
per sheet row, per script, and the resolved name->findex table for every
citation in src/. The drift report names additions, removals and changes, and
the work list routes each to its validation - an in-game log, the SHEET
check, or a model re-read. The suite fails when a citation stops resolving;
`--accept` records a new build only deliberately. `[2026-10: true as far as
it goes and a long way short of what the pipeline does since its first real
patch day - see "The patch-day pipeline" at the end of this file.]`

## The residual hunt (2026-08-11)

Seven residuals the verification era left were investigated in parallel
against the capture and closed in one pass. What each one taught:

- **The ComboPoint cap is three rows, not one.** The unit sheet says 4;
  `Rogue_ComboMax` (a baseline unit skill) and `Rogue_Finisher_Combo_Point`
  (the permanent State the finisher's checkComboPoints() applies under the
  Combo Ruler mastery) each add a TAttribute_Flat MaxComboPoint +1. Live
  finisher hits quantize as A x (1 + 0.3c) with c = 6 on nine of ten hits.
  `comboPointCap()` reads all three off the rows; the finisher's spend, the
  checkProba(vars.x * cp) proc roll, and the fight's pool cap (an override -
  the State's +1 is on no sheet the model builds) all consume it.
  Sig finisher: -18.7% -> +3.4%.
- **An op-2 dynVal is a floor, not a mystery.** getAffixModVal@21793: op 0
  multiplies the authored value by the script-set dynVal (worth 0 until a
  script writes), op 1 replaces, op 2 ADDS - and a fresh instance reads
  dynVal 0, so the authored value is guaranteed. Crusader's +10 CritChance,
  +10% damage, shield and heal, and 10 flat CDR are credited at ONE stack
  (maxStacks 300 is the growth channel) at 20/120 uptime; the addDynVal
  growth stays refused and flagged. Live in-buff crit +11.96 points agrees.
- **The carrier's bracket belongs to self-worn Buffs.** SkillContext.initVars@5241 seeds
  every tick's SkillContext from the status's OWNER: an enemy-worn debuff
  ticks at the foe's ~1.0, a self-carried Buff at the player's
  (1 + fervor + mastery). Same flag (`tickCarrierSelf`), same
  over-generalisation, as the tick-crit rule. `[2026-10: on build 25782799
  initVars seeds the context from the status's INSTIGATOR
  (Status.getSourceObject@15807), so a foe-worn tick of a status you applied
  takes YOUR bracket. Read, not measured; the owner rule above is this
  build's, and its captures agree with it.]`
- **A swing-triggered tick inherits the swing's by-type crit.**
  PurgingStrikes plays its damage step synchronously inside onInflictDamage
  behind isBaseAttack || isFinalCombo; ZealousFighter's "+8 crit on attacks"
  prices the tick too. `tickOnSwing` reads the guard-then-playStep shape and
  the pricing keys the by-type bonuses on the swing's category. `[2026-10: on
  build 25782799 a status step a swing plays is not an attack unless the step
  carries the flag: Purging Strikes crit on 30 of 302 hits (9.9%) where the
  swings that played it crit on 83 of 544 (17.6%), so Zealous Fighter's +8 and
  Might of the Executioner's crit damage stay off it.]`
- **The item-scaling channel follows the granting item's TYPE CHAIN**
  (getStepEffectScaling@21777): itemRatio 0.4 where the chain reaches
  MainhandWeapon - every held weapon, so weapon-granted status ticks take
  the ordinary 0.6/0.4 mix (Demondash's aura: -22.7% -> -3.2%) - 1.0 for
  GearTrinket, and 0 otherwise. Shield inherits OffhandWeapon, never
  MainhandWeapon, so the orb pulse is PURE attribute; a +0.4-budget reading
  that fit the same number was degenerate on one build and the bytecode
  breaks the tie. Raw-affinity ticks price pure everywhere (the capture
  pins it twice), and dot-scoped talent multipliers never reach Raw dots
  (getDamageScale@5238 returns 1 for Raw first). `[2026-10: on build
  25782799 a weapon-granted status takes the weapon mix whatever its
  affinity, Raw included, and the dmgMult hooks and crit grants reach Raw
  status hits; the bracket still skips Raw.]`
- **The trinket channel reads the character at rest and pays in full.**
  Trinket_Demon_Status ticks its authored amount undivided - three equal
  pulses per application - priced off floor(base primaries) + non-weapon
  flat primary affixes (0.2 x 225 = 45.00 exactly, 2,407 rows), immune to
  application-state repricing. -48.4% -> -1.6%; the rest is a consumable
  the dump cannot see. `[2026-10: on build 25782799 a trinket's status is
  scaled through its ITEM alone and spread over its ticks: 36.25 a tick, 37
  logged on 2026-10-13. The 45.00 is the rule of the build of the day.]`
- **Two talent guards became scopes.** Authority: `dmg.skillId == Skill.X`
  -> a one-skill rider (Smite -20.3% -> -4.3%). Radiance: `ctx.status !=
  null && ctx.status.owner == owner` -> a rider on every owner-carried tick
  (five Priest rows moved at once; the orb's last-pulse ratio 2.25/1.25
  proves the script's ctx.dmgMult += 1 shares this rider bracket). Both at
  the rankOverride-RESTATED value, not times-rank.
- **Gash counts company.** `[2026-10: the count is of the owner's statuses
  ON THE TARGET - other dots, open debuff windows, the Lethal Poison doses
  (not their hidden marker), the Chaos Mark, a set's statuses - and a status
  the owner wears himself is not counted; the amount is paid over four ticks. The sentence below says "on the wearer", meaning the
  target that wears Gash.]` The daggers passive's hook adds +10% per OTHER
  own status on the wearer at tick time (decoded exactly: 10.0/stack x
  stacks x (1.04 + 0.1k), k = 3..7). The dot descriptor carries
  `perOtherStatus` and the fight multiplies by its own live count. The hook
  lives on a skill that never applies the status, so the plan searches every
  processed skill - and it exposed the one build fact nothing records: WHICH
  weapon skills are slotted. capture.mjs and fromSnapshot already consume a
  probe-v4 `snap_wskill` row; until the probe emits it, the default
  selection drops the arsenal passive and Gash verifies without its rider.
- **The Censer's economy is fully authored.** The ultimate: a cloud every
  vars.time seconds -> a counter stack per pickup -> conversion at maxStacks
  -> props.skillOverride names the follow-up; one cast per 30s of combat,
  priced +3.3%. The mark: consumed on the SECOND stack, one scripted lump
  per pairing, 59.0 exact against 51 capture rows (-0.0%). `[2026-10: the
  drops are authored and the pickups are not. On build 25782799 a cloud
  lands at a random spot 3 to 10 units from the hero and lies 6s, and a cast
  is seven clouds, one per 21s if every cloud is walked into the moment it
  lands. That share is an input now, --pickups (default 1), and a build that
  leans on it says so beside its number.]` The guaranteed
  crit: `ownerHero` is the owner (SELF_TARGETS), and the costless register -
  the status consumes itself on the finisher for critChance += 1 - is armed
  per mage chain cast at Chaincast's authored one-per-four-actives, which
  also force-fires every conduit. RayOfSpark: a spread channel divides by
  the game's own floor(duration/tick) (SkillStep.initTicks@5985 - no start-tick +1)
  and logs one row per tick, and the M2 splash's `target != ctx.aimTarget`
  guard lands on nobody against a lone dummy. +89.6% -> -5.5%.

The hunt's last catch was not a formula at all: toLoadout wrote the dump's
runes as `runes[r] = true` while every consumer reads the VALUES, so the
whole build's rune set resolved to `{true}` and every rune-gated step
priced as not taken, on every class, since the dump path existed. With the
ids as values - and `bench verify` riding runes in from the jobs dump for
snapshot builds, since runes belong to the character and not the moment -
RadiantVerdict's "+158%" collapsed to -12.6% (its whole 8-second zone sits
behind the M1 rune), Surging Force went -29.2% to -0.9%, and the Priest
ledger tightened across the board.

The two Warrior model-highs turned out to be the mirror's, not the model's.
Hemorrhage's pool pricing reproduces the live lattice to the integer
(status_on stacks = round(0.35 x the feeding crit), four 2s ticks of
ceil(pool/4)); its "+34.7% per hit" decomposed as share x rotation-dps x a
second target's tick dilution, an identity to five digits - so verify now
judges GLOBALLY-fed pools on share (per-hit printed informationally) while
own-fed pools keep their per-hit verdict. Heartsteel's per-fire formula is
byte-exact (269 = ceil(0.1 x Armor x fervor bracket); 323 is that under
Berserk; 412 the one crit); its excess was the sim auto-pressing Fortifying
Cry - so verify now holds the model to the PRESSED set, with via-granted
casts riding their presser. And a Shield-granted CAST leaves the weapon mix
entirely (the type chain never reaches MainhandWeapon), fixed while inert.

Under the pressed frame, the ledgers close at: Warrior 5 match / 4 close /
2 miss, Priest 5/6/3, Rogue 7/7/4, Mage 2/5/4 - and coverage is 100%
everywhere except one honest hole: Gash reads MISSING because its live
applier is the arsenal passive the default selection drops (the probe-v4
snap_wskill row closes it). The open residuals: PurgingStrikes -15.9% (a
session-state item linkage that flips its flat with a relog - deliberately
not baked), the Mage combo's crit mix and conduit share (the sim's press
cadence vs the live player's), and the rune-slotting question (the modkit
dump lists runes with no slotted field; one Battle Shout press without its
M3 buff proves at least one listed rune inactive in-window).

## Probe v4 lands (2026-08-11, same day)

The v4 capture came back clean on the first deploy: 94 snap_wskill rows,
zero wskill errors - HeroSpecialization.arsenals unwrapped exactly as
getArsenalSkills@9321 said it would. What one sitting of play settled:

- **Gash: MISSING -> -8.9%.** The selection rows show the passive slotted
  ("Sharpen Fangs" - whose own tooltip states the +10%-per-other-status
  rider the capture decoded), the loadout carries it, the companion rider
  prices, Rogue coverage returns to 100%. Two corrections the capture
  taught in passing: the arsenals map keeps a DORMANT entry for the
  mainhand (one skill listed while the capture shows another pressed), so
  selections constrain only the arsenal and offhand; and a snapshot
  carrying the selection outranks one that merely saw more damage.
- **The PurgingStrikes flat is the NORMAL state.** The relog differential
  ran entirely on the +30 lattice (modal 38/36/35 = 0.15 x (Faith + 30) x
  the bracket in its buff states; the pure 29/30 never appears) - three of
  four observed sessions now. Still unbaked, because one session proves it
  absent; the row sits at -11.1%.
- **The Censer ultimate crits** - 23.1% over 13 casts - so the crit-folded
  price was right (-7.9%), and its 30s arming cadence holds at share +1.0.
  The mark holds at scale: 116 hits, -2.2%. The combo's live crit is 73.7%
  at the player's real cadence - the register genuinely does not saturate,
  which files the remaining combo gap under the sim's own press cadence,
  not the formula.
- Priest, on a window three times longer: every row within +-12%, most
  single digits (Smite -0.9%, Eruption -3.5%, orb -4.5%, RadiantVerdict
  -9.9% at n=39).

## Probe v5 and the calibration sitting (2026-08-11, later still)

- **snap_rune: what is slotted, not what is known.** Each skill instance's
  replicated masteries list (the storage BaseSkill.hasMastery@6196 consults). Emsey's
  six rows exclude Combo Ruler - so her ComboPoint cap is 5, and with
  comboPointCap() honouring known runes the finisher priced to the decimal
  (517.2 vs 517.3) where the as-held 6 read +8.6%. Emsai emitted zero rows
  and his Battle Shout landed without its M3 buff again: fourteen runes
  known, none slotted - the jobs dump is a fallback for pre-v5 captures
  only, and the probe writes an explicit `none` marker so known-empty never
  reads as unknown.
- **The behind perk, measured.** A split dummy session (one minute strictly
  behind, one strictly in front): non-crit swing means 36.23 vs 29.42 over
  92/146 swings = +23.2% live, against the model's priced sum of +25.0% -
  the perk arithmetic verifies. This player's natural dummy positioning
  measured behindFraction ~0; the sim keeps assuming 1 for build rankings
  (best case, stated), and verify takes --behind-fraction for the honest
  dummy ledger. The front half also isolates a ~+9% swing surplus that the
  behind assumption used to hide - the Rogue tail's next question, along
  with Demondash's Burn (-24%).
- **The snapshot chooser weighs evidence on the verified target.** A dummy
  calibration followed by a rift left the newest snapshot rich in
  everything but dummy hits; the target-blind pick returned an all-PHANTOM
  ledger once. Snapshots now carry per-archetype event counts.

## The second residual hunt (2026-08-11, night)

Four investigators on the last disk-serviceable rows. What each closed:

- **The swings were right all along.** The "+9% surplus" was the
  calibration's own arithmetic: it unfolded crits with the sheet's 16.95%
  where the line folds 26.95% (FinishTheJob's +10% on Attacks, live-confirmed
  at 24.4% observed), and it blended DeathMark's +15% taken at the sim's
  uptime in a window that never pressed DeathMark. State-matched, the model
  swing reads -1.7% at front and -0.2% behind - and the behind minute
  independently proves both weapons' behind perks sum at FULL value on the
  arsenal copy (0.12 + 0.14; an arsenal-scaled 0.4 x 0.14 is excluded by the
  data). "Arsenal stats efficiency 40%" is Slot_Weapon2's affixFactor,
  already inside the affix integers both sides agree on. No code changed.
- **Demondash's Burn was two errors cancelling.** The banked fraction is a
  rank-resolved VAR (0.2 authored, 0.3 from rank 2 - the capture's
  status_on amounts prove 0.3 to the integer: 61/77/101 against hits
  202/257/335), and the feed guard is `dmg.isWeaponSkill` = skill type 7
  exactly `[2026-10: 7 or 8 on build 25782799 - a WeaponSubSkill's hits
  feed it too]` - the model banked 0.2 of the whole rotation instead of 0.3 of
  three skills, and the two cancelled until the Legendary arsenal raised
  the true feed while shrinking the false one. Fixed both, plus the tick
  clock: it resets on every discrete feed (the live lattice is silent
  through sub-2s spam), expiry-anchored only where the sim's feed is an
  expectation smear (crit-gated pools), and zero-pay ticks are not ticks.
  Share verdict: -2.7pp CLOSE, feed rising with the arsenal like live.
- **The v5 rune cache lies by omission.** BaseSkill.masteries is DERIVED
  from HeroSpecialization.skillMasteries and a pure client replica never
  rebuilds it (BaseSkill.initData@6136 skips applyMasteries) - Emsai's Surging Force
  decomposed only WITH its M3 (+40% single-target; all 11 hits across five
  days, min non-crit 149 vs a no-M3 ceiling of ~129) twenty-three seconds
  after a snapshot claiming zero runes. Probe v6 reads the authoritative
  container itself; until a v6 capture lands, verify's --rune slots
  capture-proven overrides (M3 prices 199.2 vs the live n=11 mean 199.55).
- **FaithfulWinds' phantom was the dump fallback working as designed and
  labelled wrong.** Its only damage step is M3-gated; Emsei pressed it once
  live and produced exactly one self status and zero damage - M3 unslotted
  - while the pre-v5 fallback slotted all 12 KNOWN runes (including three
  mutually exclusive Judgment runes). The model's mastery gate is correct;
  verify now names the fallback in its output, and Emsei's first v5+ login
  resolves the row to zero on its own. A whole-cdb sweep found no Damage
  effect on any enemy-excluding step - no alignment gate is missing.

The v6 logins landed the same night. Emsei's authoritative set reads five
runes - the FaithfulWinds M2 heal, not the M3 damage - and her ledger
closed at 100% coverage, zero phantoms, 5 match / 6 close / 3 miss, with
RadiantVerdict holding at -10% under its authoritative M1. Two chooser
rules came out of it: a snapshot with nothing recorded on the verified
target cannot win on richness (a login-and-out snapshot once out-ranked a
two-thousand-event window on the strength of its empty rune list), and a
window predating the rune probe backfills from the NEAREST rune-bearing
snapshot before the dump is ever consulted.

## The Mage's three economies (2026-08-11, later)

"The mage simulated damage seems very low" - seventeen percent low, and
none of it a formula: every per-hit price was already within ten percent.
Three authored economies the fight never ran, each decoded against the
415-second window (live 341.4 dps, model 284.4):

- **The chain is a consume-site economy, not a crit rider.** Chaincast
  arms per four active casts; Mage_SparkMaster's onPreSkillProc - the sole
  propagateMageChainCast@30808 caller - consumes it on the next
  weapon-skill press, which pays ZERO Spark, raises EVERY onMageChainCast
  consumer (Chaincast's conduit volley plus Reverberate's echo 0.4s
  later), resets its own cooldown a frame later (respent live within
  ~0.5s - Censer skills beat their authored cooldowns), and plants the
  forced-crit register. Ledger: 207 predicted vs 204 observed trigger
  events.
- **The summoner's worth is its pets'.** SummonDemon_Skill2's two imps
  swing every ~3.2s for 0.2 x the OWNER's Intellect; Skill1 dumps one
  missile per banked charge (cap 20, fed per pet hit + per 3s + per
  expiry proc) - 14.9 per press live against the model's one. The fight
  now schedules windows, pets and the bank; pet damage rides a flagged
  line verify's source-filtered fold skips.
- **Conduit slots repeat, income was 4x, refunds exist.** Projectile x2 +
  Power (the script fans by instance; every live trigger is a pair);
  RayOfSpark's SparkRegen plays per CHANNEL TICK so own-channel riders
  fold at the tick count; ConduitResidues refunds per trigger event. The
  gauge law stays spends-only, exactly as the bytecode has it.

`[2026-10, three corrections on build 25782799. (1) The chain belongs to
Chaincast: it is keyed to Chaincast's counter of active casts, one counter
for the build, and a node owned twice (a talent point AND a sigil) arms one
chain, not two - the first re-read after the update printed a Mage at 720.4
from exactly that doubling; one register gives 567.4 for that build and the
optimum is 590.7. (2) What broke the register on the new build was not a new
hook: onMageChainCast is old, and High Voltage's consumer reads
skill.activeSkill.isFinalAttack() where it read another accessor. Chain
Strike is read by shape, with its rankOverride, and reaches the finisher,
because BaseSkill.isBaseAttack@6153 is true for the finisher too. (3) The
summoner's feed moved hooks - see "A summon's hit reaches its owner through
the proxy hooks" at the end of this file.]`

Result: model 342.2 vs live 341.4 dps (+0.2%), conduits matching 59
rows/min at -2.8% per hit, every share within 6pp; the other three
classes' ledgers byte-identical. Remaining Mage residuals are per-hit
state (staff swings -10..-20% under in-fight fervor, combo -23.6% at the
live 73.7% crit mix) - the cadence story is closed.

One contradiction stays open, on record: Emsai's authoritative container
ALSO reads zero runes - two containers, same answer - while his eleven
Surging Force hits across five days decompose only WITH M3's +40%,
including one twenty-three seconds after a zero-read. Either the runes
were genuinely unslotted at some point (old hits legitimate, the last one
unexplained) or a third container exists. The discriminator is his next
Surging Force press: ~110-130 non-crit means the container is right and
history moved; ~150-175 means it is not the whole truth. Until then the
row prices bare, with --rune Warrior_SurgingForce_M3 on record as the
capture-proven override (199.2 vs the live n=11 mean 199.55).

## The priced frontier (2026-08-11, end of session)

What the last investigation pass measured but deliberately did NOT implement
- each is real, priced, and waiting for its own careful session:

`[2026-10: the first item below is REFUTED - a unit's armour is one row and
the fitted levels are gone, §13 - and the third describes a rider on the
stacking Lethal Poison that the update removed with its script. Both are
kept as written, because the windows they were fitted to are real and the
explanation that replaced the fit (party armour shreds) is itself inferred.]`

- **Boss armour is a SUM over the inheritance closure, not the nearest row.**
  A Priest dungeon window inverts the authored mitigation ladder under
  nearest-wins and reconciles to <=1.3% cross-ratio error under
  sum-of-all-rows; rift boss+adds share one fitted zone level only under
  the sum. Parity spawn level (target=attacker) is refuted in every boss
  window tested (fitted: rift-R1 ~6.5, dungeon-Z1D ~15.5 under chain-sum).
  And the ArmorPenetration rating conversion reads ~2x the boss-implied
  effective pen (sheet 34.1% vs implied 16-18%) - untestable on dummies by
  construction. Changing armour resolution moves every boss price in the
  bench; medium confidence; needs its own session with the fit re-derived
  (golems included) before it lands.
- **Demondash tail**: the rank-3 Combo_Status (+0.25 next weapon-skill hit,
  consumed) is unpriced (fixes Demondash_Skill1 -13% and part of
  DuplicatePoison_Skill1's remainder); Skill2's scripted 3-projectile
  multiplicity and its blocked ignoreMainTarget AOE at one target are read
  wrong in opposite directions and happen to leave +17% net.
- **Rider mix on DuplicatePoison_Skill1**: the model fires its per-dot-tick
  rider without Lethal Poison stack multiplicity but at an assumed 100%
  Skill1_Status uptime - reweighting its own component prices at the live
  mix lands -1.6%.
- **Devote ramps**: event-weighted mean 2.77/5 stacks in mixed fights (4.31
  on dummies) against the frozen cap - ~0.7% generous outside calibration
  windows.
- **Replay refinements**: utility casts (Blink, MysticEmpowerment) advance
  the live chain counter but are not model actives, so replay refuses some
  chain-reset presses; SummonDemon's missile channel may under-fold sheet
  crit (~10% on that row, evidence split).

## The armour law (2026-08-11, the boss session)

`[2026-10: WITHDRAWN. The client's unit merge keeps one row per attribute
and throws on two, the pre-patch capture's own per-hit pairs side with one
row in 186 of 201, and the logged target levels contradict every fitted
level below. §13 is the law now; this section is the record of the fit.]`

Two independent fitters and an adversarial judge landed on one law, then
implemented: a unit's pool coefficient is the SUM of red/(1-red) over every
reduction-carrying row in its full inheritance closure - a child's row does
not shadow its parent's - and the pool is S x (385 + 100 x spawnLevel).
Nearest-row is refuted by the dungeon ladder inversion and by pooled
log-SSE 14.4 vs 1.0 over 27 rows. Golem stubs compose onto the first
reduction row of their attribute (Golem_Z2W_E is the untested
discriminator, flagged). Spawn-level parity is refuted in every boss
window: fitted zone levels ship per family (rift-R1 6.9, arena 7.9,
dungeon-Z1D 12, re-rolling 9.7-12.5 between runs - --target-level wins
when known). Penetration conversion reads ~2x the boss-implied effective
values (Emsey AP_eff ~8.6 vs sheet 34; Emsei SP_eff ~41 vs sheet 53) - the
next open question, with the judge's back-solve check specified. First
boss ledger under the law: Reblochonk, 100% coverage, 3 match / 9 close /
2 miss - a boss page that reads like a dummy's.

## The September 30 update (build 25782799)

The game's "September 30" update is the live build 25782799 since 2026-10-08:
HashLink bytecode v6, 48047 functions, and against the build the model was
accepted on (2026-08-11) `bench update` counts +141 / -4 / ~243 skill rows,
+167 / ~48 items, +38 / -12 / ~6 constants, +18 / -4 / ~39 units, +2 / ~7
attributes, one aptitude, one status type, two affinities in and one out.
This section is how the model stands on that build. Each rule says how it is
known. Most of it is READ; the game was first MEASURED on this build on
2026-10-13, and the model was then held against those rows one block of play
at a time: [what that changed](#what-the-capture-corrected) and
[what it settled, what was protocol and what is open](#what-the-capture-settled-2026-10-13)
are the last subsections but one.

Two hotfix builds followed, 25933712 on 2026-10-14 and 25959898 on
2026-10-15. What they moved and what the bench did about it is
[the last subsection](#two-hotfixes-builds-25933712-and-25959898). Every
measurement in this section is of 25782799; none was taken on either hotfix.


### WeaponPower: the rule that moved under an unchanged function

A base attack scales on `WeaponPower`, which no affix grants and no sheet
row computes: the scaler resolves the id by name, into the equipped weapon's
own aptitudes.

```
swing = R × MEAN over the weapon's aptitudes i of
            ( 0.4 × budget_i(weapon level)  +  0.6 × attribute_i )
```

`R` is the swing row's authored ratio, `budget_i` the primary budget of
aptitude i at the WEAPON's level (priced at the character's, a weapon being
trained up to it), 0.4 is `WeaponPowerRatio.MainhandWeaponSkill`. It is the
ordinary 60/40 weapon-skill mix, averaged over the aptitudes the weapon
names. No handedness factor exists anywhere in the damage path; rarity, stars
and iLevel bonuses never enter the flat.

**READ, op by op.** `$HSkill.getStepEffectScaling@21777` ops 92-118: an
attribute flagged `ItemScaling` keeps `1 - itemRatio` of its ratio when the
skill comes from an item - and the `WeaponPower` attribute row carries that
flag (`attribute.WeaponPower.flags` = 512). `convertWeaponPowerScaling@21781`
ops 51-55 divide the ratio by the aptitude count and ops 69-77 sum
`obj.atb(primary) × ratio`. The flat is `getStepEffectItemScaling@21779`
through the closure it creates, which multiplies each primary's budget
(`getExpectedAttributeAtAptitudesLevel@21643`) by the ratio, by `itemRatio`
and by `1 / count`.

**What it replaced.** On the 2026-08-11 build the rule was
`R × (0.4 × the SUM of the budgets + the full MEAN of the attributes)`, and
every reading of that build fits it: Beefury 13 = 0.13 × 0.4 × (123.6 +
123.6), Wingsabers 22 = 0.205 × 0.4 × (123.6 + 148.3), Judgement 78-95 a
swing. Two things changed, and both can be seen without the game:

- the closure gained ONE op. Its last multiply uses the `1 / count` factor
  its predecessor unpacked and never used; a pre-patch dump of that function
  differs from today's in exactly that op. The function `getStepEffectScaling`
  that everyone would have re-read first is unchanged in the place that
  matters - the rule moved in a closure two calls down and in a data flag;
- the `WeaponPower` attribute row gained `ItemScaling`: its accepted hash is
  reproduced only by today's row with flags 0.

The authored swing ratios did not move to compensate (GreatSword went 0.95 →
0.7 and the Halos swings changed; the other 57 base-attack rows hash as they
did), so a dual-aptitude swing prices about 0.53× what it did and a
single-aptitude one about 0.76×. That was the largest single move of the
update: the Warrior's default optimum fell 8.6% on this rule alone (603.6
to 551.4), the Priest's 5.1%, the Mage's 3.7%, the Rogue's 2.4%.

**MEASURED 2026-10-13 on four weapons, and the old rule is excluded.** Each
weapon in its own chain block of about a minute, ordinary hits against
ordinary hits, the model's figure against the logged mean by link
(`bench verify ... --window <block> --split`):

| weapon (aptitudes) | priced | logged by link (n) | model minus capture |
|---|---|---|---|
| Judgement (Fighter) | 112.3 | 113.2 / 111.4 / 108.3 (17 each) | -0.4 / +1.3 / +4.1% |
| Beefury (Fighter + Cleric) | 14.6 | 15.0 / 15.1 / 15.1 (28 / 25 / 29) | +0.6 / +0.1 / 0.0% |
| Silhouette of Almaz (Wizard) | 28.8 | 28.6 / 27.5 / 28.9 (14 / 13 / 15) | +2.2 / +6.6 / +1.1% |
| Nibsham's Liberators (Assassin + Wizard), from behind | 18.1 | 18.5 / 19.1 / 18.4 / 18.7 | +0.8 / -2.6 / +1.3 / -0.1% |
| the same, from the front | 14.4 | 14.6 / 15.2 / 15.1 / 15.1 | +2.0 / -1.8 / -1.4 / -1.6% |

The percentages are after the half point the log's ceiling adds (a 15-damage
swing carries up to 3% of rounding). By the ratios above the accepted rule
would price those swings a further 1.3× to 1.9× higher. Two readings are
wider than the rest and stay open: the Warrior's third link (+4.1% on 17
swings) and the Mage's second (+6.6% on 13). The staff's swing is two
states, not one (26.5 priced against 27.1 logged on the 14 swings without
the +10 MagicMastery its finisher's rank-3 clause gives for 10s, 28.9
against 29.0 on the 28 with it), and critical swings are too few in any one
block to hold a crit multiplier to.

The first ledgers of that night read the same swings +5 to +12% high
(Warrior +8.7 / +7.6 / +11.9%, Priest +8.7 / +5.3 / +6.8%, Mage +2.6 to
+6.0%) and the Rogue's -4.7 to -7.3%. That was the window and three model
defects, not the rule: a whole snapshot span against a model fight that
pressed every buff the span pressed anywhere, the crit share of the model
(21.7% on the Warrior) against 10-15% in a minute of swings, the ceiling,
Beefury's upgrade perk priced as +7% on the swing where it is a second HIT
at the perk's chance (its script plays the exec step again), an enchant in
the Rogue's ARSENAL daggers paid to her swings (it does nothing, below),
and, on the Rogue, a window that mixed both sides of the target (her
daggers' behind perk, below).

Still worth one screenshot, because it checks the CLIENT's reading
independently of the dummy's armour: the expanded tooltip of a dual-aptitude
weapon's first swing with the weapon's own level read off the same tooltip.
A naked level-25 Warrior with Cheese Moon at weapon level 25 reads
`(7 + 3.9% Strength + 3.9% Dexterity)` under this rule and
`(14 + 6.5% + 6.5%)` under the accepted one.

**`AllAttributes` is the second id resolved by name.** READ: ops 119-188 of
the same scaler test the id against the string, collect every attribute
flagged `MainAttribute` (Strength, Dexterity, Faith, Intellect today), and
add `atb(a) × ratio / count` for each; the row carries no `ItemScaling` flag,
so it takes no weapon share. It is a selector, not a stat - nothing grants
it and the sheet's value for it is 0 - which is why every one of the 19
scaling entries that use it (all on Infusion rows) priced zero before it was
read. NOT MEASURED on a wearer's sheet: none of the four captured characters
wears an infusion. Other players' rows bracket it, and that is an inference
(no sheet behind them): the Seals of Atonement row that scales `0.3 ×
AllAttributes` reads 18-24 non-critical on seven wearers and 31-33 on an
eighth, where the four snapshotted characters' four attributes average 64 to
77.

### A status tick is priced off whoever applied it

READ on build 25782799: a status's hits run in the status's own
`SkillContext`, and `st.skill.SkillContext.initVars@5241` seeds it from
`skill.getSourceObject()` - which for a Status is its INSTIGATOR
(`Status.getSourceObject@15807` is `return this.instigator`), not the unit
wearing it. Ops 3-33 zero the crit chance for a status typed DoT or HoT; ops
34-43 take crit chance and crit damage from the source; ops 47-52 take the
Physical and Magic `getDamageRatio` brackets from the source. So:

| a tick of a status YOU applied | bracket `(1 + fervor + mastery) × DamageModifier` | crit |
|---|---|---|
| typed DoT or HoT (every bleed, burn, poison) | yours, unless it is Raw | never |
| any other status, on you or on the foe | yours, unless it is Raw | yours |
| Raw affinity | none (`getDamageScale@5238` returns 1) | as its type says |

On the 2026-08-11 build the same ops read the status OWNER, and the captures
of that build agreed: a foe-worn tick took no bracket and never crit (the
Luon Mark: 51 lumps, one integer, no crit), a self-worn Buff took both. That
rule is kept as `--tick-source carrier`; `instigator` is the default.

What is read is the context. What is NOT readable is its consumer: the old
client multiplied the hit by the context's bracket in `ent.Unit.applyEffect`,
a server-only stub now. So that the server applies the bracket to a tick at
all was ASSUMED from the 2026-08-11 body, and the 2026-10-13 capture holds
it on two statuses. MEASURED: Lethal Poison's tick takes the Rogue's Fervor
and mastery (68.95 priced, 69 logged); and Swarm, the poison Beefury's
passive puts on the foe, logged 25.5 a tick over 107 ticks where pricing
off the unit that APPLIED it gives 25.3 and off the unit wearing it 21.7.
None of the 107 was critical, at a sheet crit chance of 15.6%: a typed DoT
starts at no chance of its own. Not pressed that night: a pool (one
Bonethrow on the Dummy with no damage buff up separates the readings;
`bench audit` has the arithmetic).

**The applier's side is taken when the status goes on; the target's side
when the tick lands.** MEASURED: both 69 and 71 occur inside ONE
application of Lethal Poison, 68.95 and 70.01 priced, as Chaos Scorch's
15% armour break comes and goes on the target. The model prices a tick
against what the target wears at that tick.

A non-Raw POOL dot's tick takes a second stage either way - the target's
armour on its own pass - described in [§12](#12-checked-against-the-game).

### Crowd control has one reader, and a target can refuse it

Three things ask whether a cast controls what it hits: the share of the fight
a crowd-control rider is priced at, whether a cast pays that rider on its OWN
hits, and whether it arms Domination's register. They are answered from one
list, `plan.crowdControlOf` (and `plan.ownCrowdControlOf`), built from three
routes: a Status step the cast plays, an effect that carries the status, and
a script's `addStatus` / `addStatusDuration`. A duration authored as a `vars`
key is resolved; a step the cast does not itself play applies nothing by
being listed (Eruption stuns from weapon rank 3, where its script plays the
step - it had been read as stunning at rank 1). What "crowd control" means is
the `statusType` sheet's `CrowdControl` flag with the parent walk, by name:
Slow, Silence, Stun, Root, Grounded.

**The gate is typed.** A rider that asks for any crowd control
(`isCrowdControlled` / `isUnderAnyCC`: Domination's rank-3 bonus, Chaotic
Distorsion's rank-2 +40%) is priced on the controlled share of the fight,
each applier's duration over the interval the fight actually PLAYED it at,
windows taken as independent. A rider that asks for one type (a Slow:
Riptide, Pyroclasm) is priced on that type's share alone.

**Own hits.** A cast that applies its own control pays a gated rider on its
own hits whole. MEASURED on the Status-step shape, 2026-08-21, old script,
same hook: five clean-dummy Charges at exactly ×1.25. READ for a stun the
script adds in its own `onHit`: `st.skill.SkillStep.hitEntity@6061` ops
136-137 bind a closure and hand it to `newHit`, and that closure runs the
script's hooks before
`ent.GameObject.receiveHit@4540` applies the damage, so all four hits of
Iron Cyclone take the rider. ASSUMED, not measured, for the shape where one
effect carries both the damage and the status (Luon Shackles).

**The target has a say, and it is two answers.** Every foe carries:

- `ccImmune` - `ent.Foe.isCCImmune@7071` exactly: the unit flags Elite, Boss
  or Miniboss, merged down the inheritance chain. Such a unit refuses every
  status flagged CrowdControl that someone else applies
  (`ent.GameObject.canReceiveStatus@4634`), so nothing ever "stands" on it
  and a rider that reads the state is worth ZERO there. This is also what a
  skill script reads when it calls `isCCImmune()` (Shockwave's and Iron
  Cyclone's rank-3 clauses, which had been stripped and so read as
  unconditional);
- `stunImmune` - whether a stun someone else applies is refused, which is
  wider: `ent.Unit.canReceiveStatus@4922` ops 0-57 refuse a Stun-typed status
  on any unit flagged `NoStun` before the immunity test is reached, ops 58-64
  every status on a unit of type Critter, ops 65-76 every status from a
  non-ally on an `Invulnerable` unit. 76 units carry `NoStun` after the merge
  and 69 of them are none of Elite / Boss / Miniboss - a root or a slow lands
  on those and a stun does not.

On a unit both are the row's own flags. On an archetype (`trash`, `big`,
`elite` …) they are a census of the units built from it, labelled as an
assumption: `big` and `dungeon` print `no stun*`, `elite` `immune*`. `none`
and `reference` are not units and take everything. The default target,
`boss`, is immune. Where a stun the target refuses would have fed a rider,
the plan names the rider and the control under `off against this target`.

NOT COUNTED, and named: a control the script reaches from an event this
fight does not produce (Deceiver Trick stuns an enemy that LEAVES its area;
Blinding Light slows whatever enters). NOT MEASURED on this build: the
rank-3 rider inside a Slow rather than a Stun (the code says any crowd
control, the tooltip says Stun), and Iron Cyclone's four hits.

### Domination: a register and an owner-wide rider

Judgement's passive, Domination (`GA_Craft_Passive`), was rewritten by the
update into two mechanisms. The rows:

```js
// GA_Craft_Passive                       vars { var1: 0.25 }
function onTryAddStatus(s, to) {
  if (s.id == Skill.Stun) addStatus(owner, Skill.GA_Craft_Passive_Proc);
}
function onInflictDamageEval(hit) {
  if (rank >= 3 && isCrowdControlled(hit.target)) hit.dmgMult += vars.var1;
}
// GA_Craft_Passive_Proc                  vars { damage: 0.10 }, 0.15 from rank 2
function onSkillProc(ctx) {
  if (ctx.isWeaponSkill) { ctx.critChance = 1; ctx.dmgMult += vars.damage; stop(); }
}
```

**The register, at every rank.** A stun you apply arms a one-shot status on
you; the next weapon-skill USE spends it for a certain critical strike and
+10% (+15% from weapon rank 2) in the one additive `dmgMult` bracket. READ:
`onSkillProc` is raised once per use (`tryConsumeCharge@9631`), every hit of
the cast copies the context, and `criticalRoll@6320` crits whenever
`critChance >= random`. The fight spends before it arms, so a stunning
weapon skill arms the NEXT press and never itself.

**MEASURED 2026-10-13** (second session, Emsai, Judgement at weapon rank 2 or
above, training dummy), and the read holds to the digit:

| sequence | n | crits | non-crit | crit |
|---|---|---|---|---|
| Rampage at full charge, nothing up | 10 | 1 | 853 (no spread) | 1310 |
| Charge, then Rampage at full charge | 10 | 10 | - | 1507 (no spread) |
| Charge, then Shockwave | 3 | 3 | - | 551 (320 unarmed) |
| Charge, then Tear Reality, the OTHER weapon's skill | 3 | 3 | - | 571 (324 unarmed) |
| Surging Force (a stun), then a short-charge Rampage | 2 | 2 | - | 628, 628 (356 unarmed) |

1507 / 853 = ×1.767 against a natural ×1.536: the forced crit, and ×1.150 on
top, at all three of Rampage's charge levels (628 / 356, 1005 / 569, 1507 /
853). The status lands on the Warrior in the same millisecond as the Stun;
the target need NOT still be stunned when the skill lands (Charge's 1s stun
had ended 2.6s earlier); it did not time out in 82.9s; basic attacks and the
chain finisher do not spend it (35 basic rows passed under it); Raging Smash
does not arm it; Shockwave re-arms it with its own stun. Each of those is
what the script says, and so is the one number that looked short: armed
Shockwave reads 551 / 320 = ×1.722, not ×1.767, because Shockwave stuns -
its own hit already carries the rank-3 +0.25, and the register's +0.15 sums
with it in the same bracket: (1 + 0.25 + 0.15) / (1 + 0.25) × the crit
multiplier 1.5366 = 1.721. It is priced 548.8 against the logged 551.

What the dummy cannot say is the half the default target depends on. That
the hook fires on a stun the target REFUSES is the tooltip (it says the
passive triggers after applying a Stun even when the target is immune) and
the hook's name - `onTryAddStatus` - and nothing more: its dispatcher sat in
`GameObject.addStatus`, a server-only stub. The register is ASSUMED to arm against a boss; if it does
not, the Warrior's default optimum loses most of what the register is worth
there. One Elite or Boss, Charge then Rampage ten times, settles it.

**The rank-3 bonus** is the OWNER's rider (`evalDamage@6124` ops 71-123 run
`onInflictDamageEval` on every skill and status of whoever lands the hit), so
it rides every hit you deal, not the passive's own - a routing the 2026-08
model needed too and did not have: its rider was read, listed as scored and
applied to no cast. It is priced through the crowd-control gate above and is
zero on an immune target. That gate is a SHARE: the game pays the +0.25 hit
by hit, on hits that land while a control stands. MEASURED where the two
differ, in a block of lone presses: Raging Smash outside any stun logs its
bare 248 and Tear Reality 324, where the model's averaged bonus prices 261.1
and 339.3 (+5.5%, +4.9%). Paying it per hit means carrying crowd control as
state of the foe in the fight; that is open, and `bench audit` carries both
numbers.

### Lethal Poison is applied by a count of doses

The update rebuilt the Rogue's root talent. Every noun below is the row's
`texts.name`; the tooltips quoted are the game's, read off the screen on
2026-10-13.

**READ.** `Rogue_Talent_LethalPoison.onInflictHitNewTarget@45254` (raised by
`BaseSkill.onHit@6233` ops 18-78, before `onInflictHit`) lays one hidden,
one-stack dose per skill CATEGORY the first time a cast of that category
hits a target - weapon skill, class skill, Final Combo Attack (skill type
AttackCombo, the base chain's last link) and signature - and `checkDoses@45258`
converts `vars.var1` (3) held doses into one application of Lethal Poison.
The status is one stack, 20s, and its loop is flagged SpreadEffects, so the
authored `4 × Dexterity` is the TOTAL over ten ticks. Applying it to a target
that already wears it plays the status's `Blast` step, `1.5 × Dexterity`
Physical, as a hit of the status itself.

**MEASURED 2026-10-13** (Emsey, both sessions, the tree stepped through one
point at a time), and it answers the three questions the read left to
server code:

- doses are statuses on the target: a counter plus one marker per kind
  (`_Dose_FCA`, `_Dose_WeaponSkill`, `_Dose_ClassSkill`, `_Dose_Finisher`),
  one dose per kind. 60s of basic attacks alone lays only the Final Combo
  dose and the poison never appears;
- **only a cast that lands a hit of its own lays a dose.** With the root
  talent held, 27 presses of Death Mark and 25 of Urge to Kill laid none;
  Shadowstep laid the class-skill dose 18 times of 18 and Knives Tempest 83
  of 85, and every one of the 105 class-skill dose rows shares a millisecond
  with a hit of one of those two. Infernal Plunge laid the weapon-skill dose
  223 times of 269, 279 of 680 final combo attacks the Final Combo dose,
  3,661 basic hits none. Smoke Bomb was never pressed;
- the THIRD kind applies Lethal Poison (duration 20) in the same millisecond
  and every dose row goes off. Ticks are Magic, 69-71 with no talent behind
  them, every 2.0s, the first 1.95s after application;
- a third dose WHILE the poison is up gives a Physical row under the same
  skill id - the Blast, 272 - and restarts the 20s; the tick phase is kept.
  In a rotation that is about one Blast per 6s and the poison never drops. A
  FIRST application deals none: the status went on 24 times with the Rogue
  as source and the dose counter emptied 272 times, those 24 and 248 Blasts,
  every one of the 248 on a target already wearing her poison. The first row
  after an application is the Magic tick about 1.95s later.

**What rides it** is read per talent and summed in ONE bracket, because each
rider is a `+=` on the hit. Measured where the capture stepped through the
tree one point at a time (15 points, three 27.6s rotations each):

| talent | what the script does | what the rows did |
|---|---|---|
| Powerful Toxins (`Rogue_Talent_LethalDose`) | +10% / +20% on Poison-typed status hits | tick 69-81 → 76-88 → 83-95, Blast 272 → 301 → 327: ×1.10, ×1.20 |
| Deadly Poison | +25% / +50% crit chance on the Blast alone | Blasts critical 5 of 96 without it, 2 of 12 at one point, 73 of 140 (52%) at two. The 5 are Gaping Wound's grant, not a chance of the Blast's own: all fell among the 47 Blasts landed with its status on the target, none among the 49 without. Priced at two points: 0.5 plus the grant's share |
| Envenom | a base attack on a poisoned target: 50% for `0.35 × Dexterity` Magic, and it refreshes the poison | one Magic row on about half of basic hits (76 of 149, 21 of 43), 61-72, crit 92-109 |
| Venom Infusion | a stack per Blast on the target, +2.5% each on Lethal Poison, 45s | +1 stack per Blast, 11-17 a step, never the cap of 20; tick 85 at none, 104-107 at twelve |
| Improved Mixture | a stack per dose, spent by the Final Combo Attack for +15% / +30% each | one stack per NEW dose (262 for 262 dose rows), at most 3 then 5 by rank; 138 spends, every one at a Demonic Bite (72-85 → 73-119 → 72-193), none at the Finisher |
| Intent to Kill | +2% / +4% per poison on the target to periodic damage | no row of its own; Acidic Splatter (105 → 107 → 108-112), Gaping Wound (165-189 → 171-209) and the Finger of Sukuna'Maatata's tick (37-42 → 47-54) all rise. The count is of every Poison-typed status the target wears, the poison itself included and the doses and Venom Infusion not (Gash at five stacks 115 with one poison up, 125 with two); a set's status on the foe is one more (Hive Venom; read, no wearer captured) |
| Acidic Splatter | Finisher: 20% per Combo Point to apply a 6s poison and -10% Armor and MagicArmor | on the points the Finisher FOUND: 2 applications in 7 Finishers at one point, 2 in 5 at two, 9 in 15 at three, 20 in 23 at four, 64 in 64 at five - 97 of 114 where 0.2 × n expects 94.8; 105 a tick (104.48 priced) every 2.0s; it also lands on the two far dummies |
| Noxious Stratagem | Lethal Poison damage: 15% / 30% to give weapon skills 0.5s back | no row; Gaping Wound taps 1.1s short of its cooldown fired 0 of 19 without the talent and 18 of 24 at two points |
| Venomous Assassin | a final combo gives the Finisher 1s back, 2s when the Final Combo dose is not on the target after the hit's dose pass | over 224 Finisher taps the script's reading mispredicts none; the tooltip's ("2s if it applies a new Lethal Dose") 21 |
| Opportunity Strike | its text promises a 30% chance of a second strike on a base attack that triggers Envenom | NOTHING: with the point held 187 Envenom rows over 381 basic hits and not one swing with a second row of itself, where 30% would be 56; filed `off in this build` |
| Finish the Job | +5% / +10% crit chance against poisoned enemies | basic crits 19% in its step, inside the 13-23% spread of the others: not separable at this n |

Improved Mixture's stacks follow the talent's own text - the next Final
Combo Attack - and not the glossary line under the node, which says "next
Signature Skill".

**Who crits.** A crit chance a status on the target hands to other statuses'
hits (Gaping Wound's grant, for every Bleed-, Poison- or Burn-typed status
hit on its wearer) reaches every one of them, Raw included: MEASURED, Gaping
Wound's own bleed critical on 51 of 389 ticks, the Finger of Sukuna'Maatata's
curse on 32 of 517, Gash on 65 of 968, Lethal Poison's tick on 72 of 1,278,
and not one of the 92 ticks of the two sixty-second blocks that never
pressed Gaping Wound. A pool's ticks are not credited.

**What Gash counts.** Gash's amount grows with the other statuses of the
Rogue's on the target. READ and MEASURED: the doses count and so does the
Chaos Mark; the hidden Lethal Dose marker does not - it is added by
`SkillScript.enforceStatusCount@6887`, whose op 16 hands `addStatus` a null
source skill, and the rows read 17 / 20 / 82 / 90 / 97 / 104 / 112 / 115 /
125 by count and stack. Its amount is paid over four ticks (the spread
divisor is the ticks its step expects, nine seconds at two a tick, floored).

**Combo Points and the Finisher.** `Rogue_ComboPoints` pays a point to a
weapon skill or a final attack that is a different skill from the last one
it paid; the Finisher needs no point, spends what the pool holds and adds
30% a point. MEASURED: 181 with no point, then 237 / 290 / 344 / 398 / 452
with one to five (with the +10 penetration of Gash's passive up; 179 and 448
without it); replayed over the rows the row's rule gives the logged count on
157 to 160 of 181 Finishers, where paying every weapon skill and every final
attack gives it on 100 to 107. The fight presses the Finisher whenever it is
ready and prices it at the points held. Death Mark's +15% on the target sums
with the attacker's own riders (456 to 484 logged, where a factor would give
524). OPEN: over the sixteen rotation steps 182 Finishers held 4.07 points
each where the model's own rotation finds 2.12, because Urge to Kill hands
out a point a second for ten and the fight does not cast it - all 66
Finisher taps inside one of its 31 windows fired, 4.1 to 5.5s apart.

ASSUMED, each with its measurement in `bench audit`: that Smoke Bomb lays no
dose (never pressed), and Acidic Splatter's roll with a ranged main hand,
whose shuriken lands after the Combo Points are spent - see
[the hotfixes](#two-hotfixes-builds-25933712-and-25959898), the second of
which rewrote that script for it.

**Position is the daggers' perk.** The dagger base attacks hit about ×1.27
harder from one side of a dummy than from the other (14.0-15.3 against
18.7-19.6 on the same dummy), while the finisher, the poison ticks, Flaming
Weapon and the trinket do not change. READ: the script of `Daggers_Upgrade`
adds `vars.damage` to a basic attack that does not face its target - 0.08 on
the row, 0.10 / 0.12 / 0.14 / 0.16 by rarity - and this Rogue wears an Epic
pair and a Legendary pair, 0.12 + 0.14 = ×1.26. It is the behind perk of
[the verification era](#the-verification-era-2026-08-06--2026-08-11), carried
at an ASSUMED share of swings (`behindFraction` 0.41, `--behind-fraction`).
No status row marks the side, so a ledger of a block hit from one side needs
`--behind-fraction 1` or `0` to be read at all.


### Infusion

The update's new gear system. An **infusion** is a set passive
(`skill.type` InfusionPassive, 15 rows) learned from a pattern item
(itemType `InfusionPattern`) and put on a piece of armour.

**Which pieces.** READ: `$HInfusion.canBeInfused@21689` - armour of
`Item_InfusionMinRarity` (Epic) or better, with a faction. Never a necklace,
a ring, a trinket or a weapon.

**The set rank.** READ: the rank is how many of `Item_InfusionCaps`
(2 / 4 / 6) the count of equipped pieces carrying the SAME infusion reaches
(`$HInfusion.getRankFromStacks@21691`, counted per id by
`ent.Hero.refreshInfusions@7739`), and the game titles rank r with
`caps[r-1]` - "(2) Set", "(4) Set", "(6) Set"
(`ui.win.InfusionSkillDesc.getRankTitle@15961` ops 0-28). It is its own rank
namespace ([§9](#rank-and-runes-are-two-systems-and-they-do-not-overlap)):
every rank test in the script, every `minRank` on a step and every
`rankOverride` on a var is answered by the pieces worn. Sets are counted per
infusion id, so two different infusions of one faction are two sets.

ASSUMED, and the largest assumption in the system: that the passive exists
only from the first cap and runs at that rank. The lines that add the skill
are compiled out of this client with the rest of the server. If one infused
piece already attached it at rank 0, every `minRank` row would be live from
the first piece. Settled at the infusion station with one piece and one
character-sheet read (`bench audit` names the infusion to use).

**The bonus rating** is separate from the set. READ:
`st.item.Gear.getInfusionBonusAffix@9767` =
`round(Item_InfusionBonusRatio × the InfusionBonus aptitude's rating budget
at the piece's own item level)`, NOT divided by the piece's aptitude count -
at level 25, +14 / +10 / +7 by slot, 89 rating over eight lit pieces. It is
lit (`isInfusionBonusActive@9766`) when the piece has a rolled stat AND an
infusion AND is either Prismatic or of the infusion pattern's faction; it
does not read the set rank. The stat is rolled when the piece is looted
(`$HInfusion.pickInfusionBonusStat@21694`, from the ratings the piece does
not already pay), so a build nobody owns has no stat to price: it is 0 unless
a pin, a dump or `--infusion-stat` states one, and the build table prints
how much that leaves out. Prismatic is the game's roll, not a choice: 10% of
looted infusable pieces (`Item_PrismaticChance`, `makeLootItem@7953` ops
454-463), so the search never assumes it. (The 2026-09-10 log entry priced
the bonus at "a quarter of a normal secondary gain"; the live ratio is 0.4.)

**What a set is worth in a fight** comes in three layers:

1. *Attribute rows* from the (4) Set rank, priced as the permanent skill
   affixes they are.
2. *The script*, read where the hook a call is written in and the guard in
   front of it name an event this fight raises. What it does there enters
   the fight BESIDE the rotation, never through it - the cached rotation is
   the same object with and without four sets - as one of five part shapes:
   a status an event puts up and that ticks (Hive Venom: one stack per OTHER
   status you land on the foe, cap 5; no crit chance of its own, so its
   ticks roll only where a grant on the foe hands Poison hits one - Gaping
   Wound's, which is the applier's chance); a debuff an event stacks on the foe
   (Wet: +2% damage taken a stack, up to 3, on every crowd control you TRY
   and every knockback that carries a force; Melted Cheese: -1% Armor and
   MagicArmor a stack on every damage instance of a weapon skill, spent at
   4); a step played on an event or inside a window a kind of press opens
   (Seals of Atonement); a cast a counter of your own status applications
   arms (Bubble Bullet, one per 10 applications of Wet, priced after the
   fight like the stack counters); two statuses a timer swaps (Balance of
   Justice). 8 of the 15 scripts have a part of that kind.
3. *Everything else*, refused BY NAME with the reason the reader stopped: a
   hook that waits on something this fight never does (a foe dying, you
   being hit or blocking, an object walked onto, an ally healed), a guard
   about state the fight does not hold. Links are followed, not just script
   text: a step that applies a status or summons a unit names what it
   reaches, with its amounts.

One application is one status LANDED and none on a target that refuses it
(`plan.refusalOf`); a knock is counted only where its entry carries a force.
10 of the 15 families scale on `AllAttributes`, and none takes the weapon
mix: types InfusionPassive and the skills a set unlocks are outside
`BaseSkill.isWeaponBased@6164`.

**What it does is READ; when it fires is partly MEASURED; how much it deals
is not.** None of the four captured characters wears an infusion. Other
players in the same log do - 9,657 rows of 20 infusion statuses and steps
from 33 of them, with no build, sheet or set rank behind any - and those rows
settle WHEN and HOW OFTEN for three sets: Seals of Atonement plays once per
damage instance of the wearer's own base attacks and finishers under Seal
of Wrath (529 of 529; of the wearers' 545 such rows 529 are followed by one
and the 16 others are each the last damage their target took; four-bolt
finishers 12 / 12, 20 / 20, 4 / 4; none for summons or weapon skills), and
its six-piece Smite is there twice (53, ×2.50 of that wearer's on-attack
row); Hive Venom ticks every 2s, linear in stacks, never critical in 334,
each application restarting its 6s; Fermentation adds one stack per damage
instance of a weapon skill (993 of 1,010, the other 17 each the killing
blow). Wet goes on when a stun is REFUSED by a unit flagged NoStun (4 of 4).
Not in the rows: any amount, the six-piece branches of Hive Venom and
Fermentation, a target immune to crowd control, the typed readers on Hive
Venom. Two things in them nothing explains: one wearer's Hive Venom reads
1.47 against the Seals' row where two others read 1.76 (a total over three
ticks predicts 1.80), and 23 of 1,016 Fermentation applications stand
beside no weapon-skill row. `bench audit` has one entry per priced set with
its counts and the measurement that settles the rest.

**The search.** An infusion is carried per gear slot (`infusion`,
`infusionStat`, `prismatic` on the gear entry; `~<infusion>[/<rating>][!]`
on a pin). The optimizer plans sets, keeps a slot's infusion through a gear
swap, and solves which piece takes which set exactly rather than greedily.
On the default search no class ends on a six-piece set. On build 25959898
the Warrior and the Priest wear four pieces of Balance of Justice and two
two-piece sets beside it, the Mage and the Rogue four two-piece sets; before
the scripts were priced they ended on two different four-piece Nightling
sets, because each grants +4 Fervor and
sets are counted per id.

### What the install hands out

A row in the item sheet is not an item you can have. `src/sources.mjs` reads
**three stores** to say whether anything in this install hands a row out:

1. **`data.cdb` rows** that name the item or its loot table - a unit's
   `lootTable` / `bossLootTable` / `heroicLootTable`, a container's
   `gainItem`, a recipe, the `WorldLoot` flag, a faction's Rare drops
   (`$HItem.getFactionLootTable@21743`);
2. **the prefabs in the paks** - the `element`, `activity` and `spawner`
   sheets are empty in `data.cdb` because their rows live in the level
   files. Every `*.pak` of the game directory is opened (4,597 prefabs on
   this build) and its `$cdbtype` rows read through the cdb's own schema with
   the HBSON reader in `src/lib/hbson.mjs`: a merchant's shop list, a chest,
   a dialog reward, a dungeon's release status;
3. **literals in compiled code** - a loot table or an item id that a
   function loads as a string. Eight loot tables are named nowhere else.

**Gates are judged by name or not at all.** A release status is resolved
through the column that carries it and is open only for the case named
Release (`$HData.checkStatus@21563` refuses Disabled, Development and Beta);
a heroic loot table needs its boss's dungeon to have Heroic released; a loot
line's difficulty bound is read the game's way (index of min ≤ run difficulty
≤ index of max). An enum case the reader cannot name, a table only compiled
code names, a prefab no level places: the source is UNJUDGED, nothing is
withheld on its account, and the reason is printed. The list of archives is
checked against the names the loader itself passes to the pak filesystem, so
a partial install reads as "not read" rather than as "nothing sells it".

What that withholds on build 25959898, with the reason beside each:

- **13 stat-bearing gear rows** that sit only in two loot tables no source
  opens (`Phrixes_HM`, `Cleodora_HM`);
- **2 of the 15 infusions** - Resine Armor and Honorable Defender - whose
  pattern drops only in the Heroic of a dungeon whose `heroicReleaseStatus`
  is Development (Honeyzabeth's Hivetrunk, Chakram's Chapel). The other
  thirteen: ten drop from a Heroic boss, three are sold by Rumi, Demon
  Huntress.

On build 25782799 it was 26 rows in four tables (`MunsterChuck_HM` and
`RobinHoof_HM` as well) and four infusions (Unstable Bomblets and Balance of
Justice as well): 25959898 released the Heroic of Cheese Station and of
Crimson Barracks, and the reader followed the level files with no change of
code.

`--include-all` re-admits the rows, `--infusions all` the infusions, and a
pin always can. There is no default exclusion by id any more (`/^GM_/` had
been hiding Pocket Hive, which is a real weapon).

ASSUMED: the release status is the CLIENT's copy. A server that opened those
heroics anyway would make both lists too long; opening one lobby at level 25
settles it. And the fingerprint does not see the prefab-side facts this
reader depends on - a status flip in a level file is invisible to
`bench update` today.

### A summon's hit reaches its owner through the proxy hooks

READ on build 25782799: `BaseSkill.evalDamage@6124` ops 9-13 test
`instigator != instigator.resolveProxy()`, and for such a hit ops 14-70 raise
`onProxyDamageEval` on every skill and status of the proxy-resolved OWNER. So
a pet's hit is evaluated by its owner's proxy hook and by nobody's
`onInflictDamageEval`, and a clause in a proxy hook never touches what the
owner casts. Three kits moved onto those hooks and are read there: the
Silhouette of Almaz's imp crit rider (priced on the pets line), Mad Buzz's
bee enrage (read and refused), and three post-damage feeds on
`onProxyDamage` - Demonic Discharge's charge per pet hit, Mad Buzz's roll on
its bees' bolts, Swarmstrike Accord's bonus hit.

When `onProxyDamage` fires was ASSUMED - its dispatcher sat in the receive
side, server-only now - at one fire per damage event a summon lands, what
each script's one-for-one move from `onInflictDamage` says. MEASURED
2026-10-13 for Demonic Discharge's feed: 45 of the 48 imp swings that found
room in the bank came with a charge inside 3ms (8 more landed on a full
bank). The imps' own swing is priced on the dummy's pool like the Mage's
hits, 31.1 against 31.0 over 7 ordinary rows of a replayed block, and 23 of
56 were critical where the script's +15% joins the chance (37.1% priced).

One row fact changes how a capture is read: a summon's hits are logged with
the OWNER as `source` and a `Summon_*` skill id (`Summon_Imp_Auto`: 56 hits,
39.7 a hit), where the 2026-08 probe logged them under a `Summon_*` source.
`bench verify` folds them onto the pet's own line.

### Readers the weapon kits needed

Each of these is one reader extended, READ from the script and the bytecode,
unmeasured on this build unless it says otherwise, and each has an entry in
`bench audit` with the reading that settles it:

- **`isBaseAttack` reaches the finisher.** `BaseSkill.isBaseAttack@6153` is
  true for skill types 0-3 or 4; `BaseSkill.isBasicAttack@6152` stops at 3. A bare
  `isBaseAttack` guard rides every swing AND the finisher unless the guard
  takes the finisher back out. Three readers used to read it as "not the
  finisher".
- **A rider written in `onInflictHit` or `onInflictDamage` is counted once
  per HIT of the swing it rides.** MEASURED on the pre-patch capture (scripts
  unchanged): per hit for both hooks, and again on 2026-10-13: Demonic Bite
  is one hit of two damage instances, and Flaming Weapon (`onInflictHit`)
  came with 252 of its 827 instances and never twice beside one, while
  Gash's application (20% in `onInflictDamage`) came with 314, 38.0%, where
  two rolls give 36%. The pre-patch capture shows one floor - projectile
  finishers raise more hook events than bolts. Brutal Frenzy's second strike
  rolls again on its own hit (its hook's guard is the finisher flag, and the
  step it plays is the finisher's own) and is priced so, p / (1 - p) a
  finisher: 0.333 at the authored 25%, where 112 finishers were followed by
  42 strikes on 2026-10-13 (0.375).
- **A braceless `if` guards its own statement and no more.** One function
  reads it for every reader.
- **Marks, banks and detonations.** A mark a weapon skill's hit leaves on
  the target and the next finisher hit spends (Thrill of the Hunter); a bank
  of petals spent for one more spin each (Flower Spiral); a mark that
  detonates, banked one stack per hit and spent whole by the next Magic
  weapon skill (Void Bomblet). A finisher that spends a bank AND a mark takes
  both in one bracket: `1 + bank + mark`, not a product.
- **Instant casts and recasts.** A cooldown reset that "makes it instant"
  hands back an instant cast; a recast skill is pressed twice per cooldown
  and the cooldown runs from the second press.
- **A hit a status deals when it ENDS** is priced once per target the
  applying step reaches, and never on a target that refuses the status.
- **Armour a script takes off ONE named skill's hits** is priced on that
  skill, through the two-multiply mitigation of [§4](#4-mitigation).
- **A step played on a named skill's hits** is a per-hit rider of that
  skill; and one step is one line in the damage table.
- **Talent amounts are the `rankOverride` vars**, not the first-rank value
  times the points (Red Tempo and Magic Conduction were read ×rank).
- **Sunlight is worn only when something puts it up**: a hit of a skill or a
  released prayer of yours that lands on an ally, and solo the ally is you.
  It lasts 6s and the first finisher spends it unless Solar Devotion is held.
  A status step or a buff a script hands you raises no hit and opens
  nothing. A looping area lands on you again on every tick and holds the
  window for its length plus the status's 6s - Faithful Winds' lane hits its
  caster every 0.5s for 10s (MEASURED: she stood in her own lane on 15 casts
  of 15, each hit putting Sunlight back up) - and a press in the rotation for
  that landing alone is played with and without it ([Choosing the
  order](#choosing-the-order)). With Solar Devotion nothing spends Sunlight:
  65 of 65 finishers fell inside one, 18 statuses all ended by expiry.
  Purging Strikes plays ONCE in a press where Sunlight re-applies its status
  (MEASURED before the patch: one row in 194 of 317 four-bolt presses, four
  in 90). Spirited Disciple hands out its status only on a Judgment press
  that finds three prayers ready; a build that cannot ready three (fewer
  slotted, or one whose readying event the fight never plays) is told the
  status is never up, and Judgment is not pressed for it alone. Soothing
  Rays heals 30% of what Sunlight deals, on Sunlight's own line, at the bare
  share: whether the server runs that heal through HealGivenMultiplier is not
  read.
- **`onProc` and `onProjectileEnd` are the cast's own hooks**, like
  `onDamage`: a step played from one is folded into the cast.
- **A literal a script assigns on ONE step of its own row** -
  `critChance = 1`, `armorIgnore = n` behind `skillId == skill.kind &&
  stepId == Steps.S` - is a rider scoped to that step. Two rows have the
  shape, both infusions. An ignore that is assigned is a `set`, one that is
  added an `add`, and the larger of a set and the build's category riders
  stands: which of two hooks wrote last is not read.

New kinds in the unscored list say what was read and why it is worth zero
here, instead of filing a read under "cannot evaluate": `off against this
target` (an immune or stun-refusing target), `off at this target count`
(`--targets`), `off in this build` (a register nothing arms, a gate the build
cannot fill, a cast it does not make, a talent that does nothing - Opportunity
Strike, with the rows), beside the older `off at this target health`; `not
pressed` (a slotted skill the fight was played with and without and was
better without, both numbers given); and `lands on an ally` (a status a
script hands to an ally or a summon, not to you or your target - a status
handed out in a loop over the caster's party is the caster's, and is priced:
Mystic Empowerment).

### What the capture corrected

Holding the model to the 2026-10-13 rows one block of play at a time
changed these rules. Each is the game's, READ from a row, a script or the
bytecode, and each was found because a line of the capture disagreed; the
measurement that found it is beside it. The citations are on build
25959898.

- **The log writes the CEILING of a hero's direct hit.** Five lines that do
  not vary: Judgement's finisher priced 229.3 and logged 230, its second
  strike 144.3 and 145, its critical strike 352.4 and 353, and under
  Worldsplitter's +30% 298.1 and 299, 187.6 and 188. Rounding misses four of
  the five and flooring all five. `bench verify` compares a whole-number
  stream with the model's figure plus a half; health keeps the float.
- **The arsenal weapon hands out no skill from its sockets.** READ:
  `st.item.Gear.getSkills@9762` skips its first loop for a piece in
  `Slot_Weapon2` (ops 4-6) and runs the second only when `canGiveSlotSkills`
  holds (ops 76-79), which `st.item.Weapon.canGiveSlotSkills@9839` answers
  false for the hero's secondary weapon (ops 0-7). MEASURED: a Rogue with
  Devote in her arsenal daggers logged not one Devote stack in 15,489 damage
  rows, beside 1,531 Flaming Weapon hits from her main hand; the Warrior and
  the Priest, Devote in the main hand, logged 17 and 10 applications of it. An enchant in the
  arsenal does nothing; a socketed augment's stat lines are affixes and still
  count (Corrupted Gift stays in the arsenal's Demon socket); and the arsenal
  hands out no Block either (`st.Item.getSkills@8734` gives `Slot_Weapon2`
  only the chosen arsenal skills), so a staff with dual swords behind it
  reads Withstand's 50, not 100, as the Mage's snapshots do.
- **A status granted by an item scales through the item.** READ:
  `$HSkill.getStepEffectScaling@21777` ops 27-35 hand a status of a
  trinket's to `getStepEffectItemScaling@21779` at share 1. The Finger of
  Sukuna'Maatata's curse is 0.2 × (123.58 + 148.30 + 123.58 + 148.30) / 3 =
  36.25 a tick, spread over its ticks; MEASURED 37 logged, and 40 and 44 with
  Powerful Toxins at one and two points. The 45.00 of the 2026-08 capture was
  the previous build's rule. A weapon-granted status takes the weapon mix
  whatever its affinity (`getStepEffectVal@21774` ops 64-106 pass the item
  and test no affinity), Raw included.
- **A spread loop is divided by the ticks its step expects** -
  `floor(duration / tick)`, and `round` only for an instantiated Area step.
  Gash pays its amount over four ticks, not four and a half.
- **What a status on the target adds sums with the attacker's riders**; it
  used to multiply them (Death Mark's +15%, above). And the `dmgMult` hooks
  and crit grants reach every status hit, Raw included.
- **Queen's Decree adds 1 INSIDE the damage bracket** of the next magic skill
  that finds it ready - `(1 + mastery + Fervor) × DamageModifier + 1`, ×1.930
  on the Mage's sheet, not ×2 - and goes on a 20s cooldown (19.2 with her
  Cooldown Reduction). MEASURED: Static Nova 450.0 priced against 451 logged
  and 693.0 / 694 critical, three lone presses each of which found it ready;
  Spark Beam 150.0 / 151 with it, 78.8 / 79 without. Its rank-3 clause strikes
  on every critical hit of another skill of the owner while the cooldown
  runs: 22.4 / 23 and 34.4 / 35 critical; of its 41 rows 40 are the owner's
  critical hits on cooldown and one the cast that spent it, none of 110 came
  while it was ready, none for the imps' critical swings. It had been
  refused, which is what read three Mage spells 21 to 36% low.
- **Demonic Discharge spends the Decree on all but one bolt of a press.** One
  bolt of each press is on a hit context of its own (READ and MEASURED:
  `hits=1` on 8 presses of 8; `st.skill.$DamageResult.__constructor__@15281`,
  `BaseSkill.onHit@6233`) and is priced unboosted, 30.2 / 31, against 58.4 /
  59 and 89.9 / 90 critical for the others. That it is the LAST bolt shot is
  INFERRED (3rd of 3, 20th, 19th and 20th of 20, 6th of 7, 16th of 19, 7th of
  7, 10th of 10); it does not land after the cast.
- **Worldsplitter's passive** (Resilience of the Unkillable Demon King) adds
  30% to a finisher pressed while it is off cooldown, and swings shorten that
  cooldown. MEASURED: 299 against 230, 188 against 145 on the second strike;
  it came back 5.5 to 7.5s after being spent, and 14 of 39 finishers found it
  up.
- **Demonic Bite's Chaos Mark** is a mark Infernal Plunge consumes for a
  reset, and Chaotic Flames waits for a third use inside five seconds.
- **An aura that follows its wearer has no hit at spawn; an instantiated
  area does.** MEASURED: Hive Swarm's first row 0.95s after the press, ten in
  ten seconds; Swirling Embers eight rows; the floor of Radiant Verdict's
  Consecration rune a row 0.34s after the press and three more. Hive Swarm
  11 events to 10, Swirling Embers 9 to 8, Pestilential Aura 7 to 6 (Cinder
  Coat never had the spawn hit: its area row says `skipFirstTick`).
- **A slotted rune restates its row's vars.** Radiant Verdict under
  Consecration: four floor rows of 40.4 / 41 where the row alone gives five
  of 31.
- **A status step a swing plays is not "an attack"** unless the step carries
  the flag, so Zealous Fighter's crit chance and Might of the Executioner's
  crit damage, which sit behind a base-attack-or-finisher test, stay off
  Purging Strikes and Sunlight. MEASURED: Purging Strikes critical on 30 of
  302 hits (9.9%) and Sunlight on 9 of 65, where the swings that played them
  crit on 83 of 544 (17.6%).
- **A rider behind a status type on the target** (Scorch's crit chance
  against a burning target) is paid while one of your own burns stands, not
  always.
- **Judgment needs a ready prayer.** One Smite per enemy in reach per
  release (51 rows: 17 releases × the yard's three dummies); 19 Judgment
  presses, 17 released a Smite, and the 2 that did not had no finisher since
  the last release. Judgment is kept for a release worth something to the
  goal.
- **One counter per host**: an arsenal passive's stack-driven cast slotted
  and held both was on two lines. And the fight no longer opens the window
  of a debuff the target refuses.
- **Spark is spent and never required.** MEASURED: Summon: Vile Imps went off
  at 17.4 of its 19, Swarmstrike Accord at 5.85 and 1.95 of 29. Copies of one
  conduit add their stacks (Conduit: Power three times over rose three stacks
  at a time, 36 times); Inner Demon's clock opens ready and came back 19.26
  to 19.74s after each of twelve spends (20 × 0.96).
- **Cooldown Reduction is read when a cooldown STARTS and held for it.**
  READ: `st.skill.Skill.onTriggerCD@9634` ops 0-8 write `cooldownDuration =
  getEffectiveCooldown()` and `Skill.update@9639` ops 18-21 divide the step
  by that field (`getCooldown@9604`). MEASURED on the Mage's 20s clocks: one
  begun under Mystic Empowerment, which ended 4.9s in, took 13.03s (13.2 if
  latched, 17.0 if the rate followed the status); three begun before it, the
  status arriving 9.9 / 3.1 / 8.2s in, took 18.99 / 19.68 / 19.26s; 21 that
  never met it 18.98 to 19.74s. So a timed status that carries Cooldown
  Reduction shortens the cooldowns begun under it (Mystic Empowerment and
  its twin, Crusader, Dark Gift, the status on Hysteria's finisher), where it
  was worth nothing to cooldowns.
- **A status handed out in a loop over the caster's party is the caster's.**
  READ: `SkillScript.getPartyHeroesWithinRange@6861` leaves nobody out;
  MEASURED: 33 of the log's 39 Mystic Empowerment rows have the same source
  and target, the bench's own Mage 5 of 5. It is priced on the Mage who casts
  it, with its three runes; what it does for the other heroes of a party is
  not.
- **A damaging status rolled in a damage hook is rolled on every damage
  instance you land** (the Finger of Sukuna'Maatata's curse), not floored to
  the swing and finisher clock.
- **A skill whose row authors `interruptStyle` cuts the swing in progress;
  every other one waits for it.** MEASURED on the Rogue: Infernal Plunge,
  Gaping Wound and the Finisher opened inside a running link on 480 of 492
  uses, Death Mark, Knives Tempest and Urge to Kill on 0 of 107; a link
  closed before its hit step lands nothing (338 of the 480 wrote no damage
  row).

Not changed, and said where it stands: the chain's round runs 1,941ms from
first link to first link (n 224; 2,005 in the first session, n 59) against
1,850 authored, the hero Free for 10 to 17ms between links. That the gap is
one client frame is INFERRED; nothing prices it, so a line that rides the
chain is over-rated by 4.9% to 8.3% in RATE and by nothing per hit.

### The patch-day pipeline

`bench update` diffs the install against `model/fingerprint.json`, and the
first real patch day taught it most of what it now does. The parts a reader
of this file meets:

**A citation has a state, and the suite gates on it.** Every `name@findex`
in `src/`, `bin/`, `tools/`, `ui/`, the suite's comments and the living
documents is resolved against the installed bytecode:

| state | means | what clears it |
|---|---|---|
| OK | the name is at that number | - |
| MOVED | the function exists at another number | `bench update --reanchor --write`, mechanical |
| STUB | the function is a server-only `throw` on this build: the body the sentence read is gone | a person rewords the sentence to say which build the read dates from; `--accept` then records the stub |
| MISSING | no function has that name (a renamed accessor, or a debug-local's name) | a person |
| ANON | a bare number or a closure with no name: nothing but the number identifies it | a person names it, or `--accept` records its body |
| SUSPECT | an ambiguous name resolved off the predicted findex | qualifying the name |

Beside the state, a recorded citation carries a BODY verdict - SAME,
CHANGED, STRIPPED to a stub, or UNHASHED - from a name-resolved shape hash,
so MOVED says where a function is and CHANGED says its contents moved. That
verdict is exactly what would have caught the WeaponPower closure, and it
could not catch it this time: the 2026-08-11 fingerprint predates body
hashes, so every body reads "not comparable" until the next `--accept`. A LEANS line names an intact function that calls a
server-only stub.

**`--reanchor` never forges a re-read.** It rewrites only a number whose name
still resolves to one function; a STUB, a MISSING and an ANON are listed as
MANUAL with the file and line, because a fresh number on a sentence nobody
re-read would claim a read that did not happen.

**`--accept` is gated.** It refuses on any stale citation, on unreadable
bytecode and on a SUSPECT pick; `--with-stale-citations` defers the named
ones, and a deferral is printed as DEFERRED on every later run and keeps the
suite's gate red. Accepting writes the fingerprint and
`model/accepted-build.json`, the stamp every command header and the UI read
to say "this install is not the build the model was accepted on". A release
is gated on a suite pass recorded against that stamp
(`tools/release.mjs --check`).

**Drift is routed.** A row hash that decodes enums by NAME (a renumbered enum
is not a changed row), a third hash that ignores flags, the schema, each
script's hooks, the talent trees, and the classes and methods of the code the
model cites. `--row <sheet>:<id>` prints what changed inside one row,
script included; `--against <older data.cdb>` diffs against an old copy for
what the stored fingerprint predates.

**The CAPTURE line is evidence, not a version check.** It says whether a
probe log holds rows after a `session` row whose boot size and time match
this `hlboot.dat`, counting every session recorded on that boot, so a last
launch that wrote nothing does not read as a build nobody measured. Until
2026-10-13 it said nothing had been captured on build 25782799, and 160
in-game and 170 sheet-check work items had nothing to be checked against. On
build 25959898 it says so again: the loader has not run on that build, and
the capture is of the one before it.

**The first hotfix day.** On build 25959898 `--reanchor` proposed 1,121
rewrites of citations whose function only moved (998 in the code and the
suite, 112 in this file, 10 in GROUND-TRUTH.md, 1 in TODO.md) and listed 40
for a person (16 STUB, 2 SUSPECT, 22 ANON). Every rewrite was then held to the
previous build's bytecode: 315 distinct moves, the function at the old
number carrying the qualified name of the one picked, its body equal to the
new one but for type, string and line indexes - except two whose behaviour
moved (`SkillStep.hitEntity`, `GameObject.doUseSkill`; see
[the hotfixes](#two-hotfixes-builds-25933712-and-25959898)). That comparison
is the body verdict's job; it was done by hand because the stored fingerprint
predates body hashes.

What the pipeline still cannot see, stated: a fact that lives only in a
level prefab; a class the patch added, on the first patch after body and
class tables are recorded; and whether the recorded body shape survives a
recompile. The hotfixes were that second build, with no body hash recorded to
test: by hand, the cited bodies that moved compare equal but for their
indexes, which is what a shape that names its references has to survive.

### What the capture settled (2026-10-13)

The probe was rebuilt for bytecode v6 (bench-probe v10, 15 of 15 hooks) and
two driven sessions were recorded on the training dummies in Tyrna with four
level-25 characters: Emsai (Warrior), Emsay (Mage), Emsei (Priest), Emsey
(Rogue). The full record, with the command that reproduces each number, is
in [GROUND-TRUTH.md](GROUND-TRUTH.md#measured-on-build-25782799--2026-10-13).
It was recorded on build 25782799 and predates both hotfixes. What it means
for the rules above:

- **Settled, to the integer where the line does not vary**: the dummy's
  armour (the level-1 pool of its row, through a Warrior's 48.3%
  penetration: Rampage 852.5 priced against 853 logged, nine of nine); the
  new base-attack rule on four weapons, each in its own chain block (the old
  one excluded); Domination's register (forced crit, ×1.150, spent by any
  weapon skill of either weapon, not by basics, the armed Shockwave's
  ×1.722 included); Rampage's three charge levels in the authored 2.5 : 4 :
  6 (356 / 569 / 853) and its 12.0s cooldown from the hit; Brutal Frenzy's
  second strike at 0.9 / 1.43 of the finisher and its re-roll; the dose gate,
  which casts lay a dose, the Blast, the 20s restart, and the Rogue's tree
  one talent point at a time; whose stats a status tick takes (the
  applier's, on two statuses); the Combo Points' rule; Queen's Decree, the
  imps and Mystic Empowerment's latch; the auras and the prayers; and the
  log's ceiling.
- **Protocol, not a formula**: what the first whole-capture ledgers read as
  misses and the same rows, one block at a time, do not. Rampage's +41.8% is
  three charge levels and the armed crits in one window; Surging Force's
  +21% is the statuses only a swing applies (it logged 178 a few seconds
  after a chain, 154 alone); most of the 3 to 12% on base attacks is buffs
  the chain block never pressed, the crit die and the ceiling; and the
  Rogue's -4.7 to -7.3% on swings is a window that mixed both sides of the
  target. The three rules a comparison rests on - the log ceils, a window
  must match what was pressed, a rate is comparable only like for like - are
  at the end of the GROUND-TRUTH section.
- **Wrong in the model, and fixed**: [the list above](#what-the-capture-corrected).
  Three Mage spells read 21 to 36% low mostly because Queen's Decree was
  refused; the trinket's tick +23.5% was its item scaling; the burn of Chaos
  Scorch (+61% a tick) is a pool many small hits feed, so its per-tick mean is
  no price - on its share of the fight it reads +0.6% - and its rank-3 -15%
  armour break, refused until then, is in the fight. The Finisher's +24.7%
  turned into the open line below once Combo Points were paid by the row's
  rule.
- **Open, each in `bench audit` with both numbers**:
  - the Finisher below a full bar: the model's own rotation finds 2.12
    points a press where the capture's held 4.07 - Urge to Kill hands out a
    point a second for ten and the fight does not cast it;
  - Domination's rank-3 bonus paid at the controlled SHARE of the fight
    (Raging Smash +5.5%, Tear Reality +4.9% in their own block) where the
    game pays it per hit;
  - the Raclette Pan's crit chance: priced at its row, and 62 critical of 385
    swings and finisher rows at ten stacks with Battle Shout down (16.1%)
    where the price expects 21.7%;
  - two link readings wider than the rest, the Warrior's third (+4.1% on 17
    swings) and the Mage's second (+6.6% on 13);
  - Chaos Bolts' reset: the game rolls it per bolt (47 applications in 268
    bolts, 17.5% a bolt, 35 of 67 finishers with at least one) and the fight
    rolls it once a finisher at 0.2;
  - the Rogue's rate: like for like over the sixteen steps her own rotation
    lands 4.5% more a second than the capture (528.5 against 505.7 on the
    tree before the hotfixes; 530.1, +4.8%, with Shred's installed 10s),
    hits 4.1% smaller and 9.0% more numerous;
  - buffs priced at their fight average (a buff's stack count, a register
    another press had spent): a per-hit disagreement on a whole span is a
    mix of states before it is a formula, and the ledger names the states
    the build is known to hold;
  - the level of a dropped necklace (two that author 15 were logged at 17).
- **Not answerable from it**: anything about bosses, crowd-control immunity
  or heroic targets; any talent nobody had allocated; any amount an infusion
  deals (other players' rows settle when three sets fire, above); and
  anything the two hotfix builds changed.

The standard those lines were held to is the one this file is written to: a
model change must be the game's rule, read from the data or the bytecode,
AND agree with the rows. Where the read and the rows disagree and the cause
is not found, the read stays and both numbers go in the audit.

### Two hotfixes (builds 25933712 and 25959898)

Two Steam builds followed the September 30 update: 25933712 on 2026-10-14
and 25959898 on 2026-10-15, the one installed as this is written. They were
taken through `bench update` against the previous build's rows and its
bytecode, kept beside the install. READ, on 25959898 against 25782799:

- **The bytecode moved, almost all of it by position.** 48,068 functions
  where there were 48,047; every function the model cites that only moved
  was re-stamped by `--reanchor --write` and each rewrite held to the old
  build: the function at the old number carries the qualified name of the
  one picked, and its body compares equal but for type, string and line
  indexes. Two bodies differ in what they do. `st.skill.SkillStep.hitEntity`
  skips a hit whose effect is missing. `GameObject.doUseSkill` tests the
  pressed skill's `NonInterupting` flag (ops 0-7 and 20-26 of
  `GameObject.doUseSkill@4651`): a press so flagged neither stops the running
  skill nor, on this build, puts the hero in the Skill state. Two rows carry
  the flag, Bubble Bullet (the Overwhelming Tides set's cast) and the row
  that uses a consumable (`ConsumeItem`); the fight reads the flag off the
  row.
- **Three scripts the readers execute changed shape.** Expulse, the recast
  of the Book of Mi'Mizan's skill (`Book_WaterOrbs_Skill2_Recast`), lost its
  Aim: its first step, an Aim on Prepare with a range of 40, is a Cast on
  Start with no range; its duration went 0.35 to 0.5s and its orb spacing 0.15 to `vars.time` 0.08,
  and its script counts the orbs through a helper of its own
  (`getOrbCount()`): the reader stopped matching the recast's shape and
  priced one orb a press with or without the spheres it pulls in, and said
  nothing. It now puts a one-line helper's return in place of its call, so
  the recast is again worth nothing without Abyssal Rise's spheres and one
  orb a press with them, said on the line (the real count is the spheres
  pulled in, unmodelled). Acidic
  Splatter's script reads the Combo Points when the Finisher is USED
  (`onUseSkill`, before the Finisher's ConsumeCP step) and rolls on the
  Finisher's first hit or its projectile's first (`hit.projectile != null &&
  hit.hitCount == 0`), then zeroes them: the reader had lost the per-point
  chance (it priced a flat 20%) and filed the armour break as unreadable;
  both are back, read as the first-hit gate it is. That is the game's fix
  for a ranged Finisher, whose shuriken lands after the points are spent; a
  melee Finisher hits 0.02s before its ConsumeCP step, so on 25782799 its
  first hit saw the same points. Shred, Knives Tempest's armour break
  (`Rogue_KnivesTempest_Status2`, -20% Armor), lasts 10s where it lasted 3s.
- **Two Heroics were released.** Four more bosses author a heroic loot table
  (twelve, eight before), and the level files of two of their dungeons now
  mark `heroicReleaseStatus` Release: Cheese Station (Munster Chuck) and
  Crimson Barracks (Robin Hoof). Chakram's Chapel (High Inquisitor Chakram)
  and Honeyzabeth's Hivetrunk (Queen Honeyzabeth) still mark Development and
  their bosses carry no heroic stat row. The column alone stopped meaning
  "released" on this build, so a heroic boss is now a unit that authors a
  heroic loot table in a dungeon whose Heroic is released, read where the
  loot side reads it: ten bosses, 10 of 10 at 0.40 / 0.40 in Heroic, 35
  heroic stat rows on 11 units. What is withheld follows with no change of
  code: 13 rows and two infusions where it was 26 and four, and Balance of
  Justice, whose pattern Robin Hoof drops in Heroic, is in the default
  search.
- **What the patch notes say and nothing here has measured**: Expulse aims
  itself, Acidic Splatter works with the ranged Finisher, and a balance pass
  on Munster Chuck, whose skill list the hotfixes reordered.

What moved the four default optima, each re-priced both ways on the final
tree: the Warrior 846.3 to 841.7 - its previous optimum still prices 846.3
on the new rows, and the search, with Balance of Justice in its pool, settles
on a four-piece Balance of Justice build that reads less (at the default
restarts and again at six): a search result, not a rule; the Rogue 1,068.9 to
1,082.3, all of it Shred (with the row put back to 3s the same build reads
1,068.9); the Mage 718.8 unchanged; the Priest 575.2 to 579.1, a re-searched
build with four pieces of Balance of Justice. The capture is of 25782799,
so every ledger now says it is another build's, and the one ledger line a
hotfix row reaches is the Rogue's (Shred; GROUND-TRUTH.md gives both
figures).
