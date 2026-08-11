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
  ratings, and 271 of the 513 stat-bearing items name a class pair. An earlier
  both-halves model reading 453 Vitality where a real character sat at 193 was
  wrong for that era's other reasons (armour doubling among them), and the
  own-half rule it spawned survived until a sheet was finally read with a
  single known item equipped.

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

Four of eight now read and credit. The two that still refuse are correct:
`GS_Nova_Combo` needs `hasStatusMaxStacked` and `Thrown_Seeds_Skill1` needs a
status on the target. Two more (`Rogue_Talent_NoxiousStrategem`,
`Priest_Talent_SwiftJustice`) are gated on `dmg.skillId == Skill.X`, which is
readable but see the caution below.

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
level *and* a generation rarity for **Weapon-type only** — everything under
`MainhandWeapon` or `OffhandWeapon` in the `itemType` tree. Everything under
`Gear` keeps the level and the rarity written on its own row.

The live bakes settle both halves. `Necklace_Z2RCraft` logged iLevel **210** on a
level-25 character, which is its authored 20 exactly; the Z3 craft rings logged
**160** for an authored 15; and `GA_Craft` logged **320** against an authored
level of 4. Fixed-level gear does not scale, and weapons plainly do.

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
a one-shot flag and the next cast of ONE named skill spends it. Recognised by a
**triple**, which a sweep of all 962 scripts matches exactly once — so this is a
named mechanic, not a class:

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
The bytecode does not allow it. `GameObject.doUseSkill@4576` **op 2** calls
`stopActiveSkill@4580` as its very first action, which is `BaseSkill.stop@6093`
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

The reader is `runeDamage`, generalised: it already read a skill's own script for
a rune-gated `dmgMult`, so it now also answers a **rank** comparison (a question
about the build, not about live state) and tags a **target-state** guard for the
fight to answer. `critDmgMult` entries land in `critBonus`; `dmgMult` entries in
the additive bracket. Anything else in the guard still refuses.

One trap worth naming: Domination reads `Stun || Root || Slow || (rank >= 3 &&
isCCImmune())`, where the rank clause belongs to **one alternative**. Vetoing the
whole rider on it silences a +25% that fires on the stun path at any rank, so the
rank test applies only when the guard is a plain conjunction.

The gates are the **build's own**. `bleeding` is 1 when this build applies a
Bleed-typed dot and 0 when it does not — the same whole-credit policy the scoped
talent modifiers already use, and the capture measured a bleed up at 17 of 17
steady finishers. `cc` is the union of every stun the kit can apply, each at
duration/cooldown, combined as `1 - PROD(1 - u)`; the durations come off the
applying steps and the cooldowns off the skills, so nothing is invented.

**Damage riders SUM into one bracket; they do not compound.**
`computeDamage@4841` (`Unit.hx:2000-2031`) op 8 runs the hooks, op 14 seeds
`modMult` from `hitData.dmgMult` — one scalar that starts at 1 and that every
rider only ever `+=`s — and op 165 applies it once. The model multiplied a line
at a time: `runeDamage`, then `damageByAffinity`, then the basic-attack proc.
Two +20% riders read ×1.44 where the game gives ×1.40.

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
17.3 with 3. **The rank the row sees is `stars - 1`**, and a one-star weapon
carries no rider at all. Which of two rules that is stays open: plain
`stars - 1`, or `stars` capped at the rarity's own maximum minus one. Every Epic
case agrees, so one hover of the Rare 3-star Axe_Boomerang decides it — +2 is the
first, +3 the second.

*Reading a printed sheet against the game's:* the model folds a proc-applied
buff with no cooldown behind it into the resting sheet at its cap, because in
sustained combat that is where it sits. The game's Character Profile shows you
standing still. On the captured build that is the Raclette Pan's +5, so the two
are compared as `model − 5`.

**The bake is checked against the game's own return value, not against tooltips.**
`captures/2026-08-02-v2/bench-probe-bakes.csv` is a postfix on
`$HItem.generateItemAffixes@20747`: the item, the iLevel it was called with, and
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
`BaseSkill.permaAffixes@6081` (`BaseSkill.hx:850`) returns false for exactly two
natures — `Status` and `Passive` — and true for every other. `initData@6029` then
runs `if (permaAffixes()) updateAffixes()`, which hands the rows to
`owner.addAffix@4478` for good. A passive's rows are not permanent *by that test*
but arrive the other way, through `setRunning@6025`, and a passive is always
running; a status's rows belong to the buff path, which prices them at an uptime.
So the harvest is **every owned skill except a status**, deduplicated by id.

The row that proves it is `Axe_Boomerang_Combo`: nature `Combo`, `TAttribute_Flat
CritChance +5` at `minRank: 2`, `displayed: false`, and a `rankDesc` reading *"You
permanently gain ::val1%:: [CritChance]"*. It is owed for **wielding** the axe —
`Weapon.applySkills@8181` creates a skill object for every row of `item.skills` —
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
and every ally in range. That status is `TAttribute_Flat CritChance` **3** at
rank ≤ 1 and **5** at rank ≥ 2. The heal genuinely has no rate this reader can
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
- **what you socket raises the host item's gear level.** `Gear.getILevel@8123`
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
- **a damage-over-time ticks once per stack.** `$HSkill.getStackFactor@20772`
  runs as the **last** line of `getStepEffectVal@20775` — after the scaling,
  after the spread division, after the damage variance — and multiplies the
  value by `Status.stacks` whenever the running skill is a Status that is
  *either* a DoT (its `statusType`, or an ancestor of it through the `parent`
  chain, carries the DoT flag) *or* carries the `ScaleWithStacks` effect flag.
  It is an **OR evaluated once**: `Daggers_Demondash_Passive_Status` is typed
  `Burn` *and* flagged, and is multiplied exactly once.

  The count is read **at every tick**, so the per-tick value snapshots at
  application and the multiplier does not.

  The cap comes off `getMaxStacks@14459`:

  - `props.status.maxStacks`, whose default is **1**, not unlimited;
  - replaced by any `props.rankOverride` entry at or below the **applying**
    skill's rank (`Status.get_rank@14428` = `instigatorSkill.rank`) — which is
    how Hysteria's counter drops from 150 to 100 once the weapon skill is
    upgraded;
  - plus exactly one script path: Lethal Poison reads
    `getStatusMaxStacks(b) = b + getTalentRank(Rogue_Talent_ImprovedMixture)`.

  An application adds exactly **one** stack — `props.status.stacks` is authored
  on none of the 100 `type: Status` steps — and nothing anywhere decrements a
  stack on a timer: the whole status expires at once. `DurationBased` is the one
  exception and it is sampled **only at application**,
  `ceil(stacks × durationProgress)`, which is why a stack table needs no
  per-tick decay at all.

  Five stacks of Lethal Poison were being priced as one. That is where the
  Rogue's **324 → 385** came from.

  `maxStacks <= 0` means **uncapped** — seven rows author `-1` — and that sign
  was a live trap: the bare `?? 1` it replaced handed the literal `-1` into the
  affix scale, i.e. a buff worth *minus* its own value. Nothing was visibly
  wrong because only a foe status carries affixes among the seven, which is the
  kind of bug that waits for a patch to become one. An uncapped **dot** is held
  at one stack and named: over a 200-second fight an every-swing application
  would reach two hundred stacks and print a number that grows with the fight
  length rather than with the build. Every uncapped dot in the sheet today is a
  *pool* dot, whose fed/owed ledger already **is** the stack count expressed as
  damage, so nothing is currently scored at that floor.

  What has **not** landed is the affix side. `applyAffixes@6083` multiplies each
  affix by `getAffixMultiplier() = stacks` too, and a stat buff is still counted
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

  Brutal Frenzy is the case that shows the size of it. The cast is the
  `1.43 × Strength` Area step — the measured **133**. The `0.3 × Strength` Mono
  step is `id: "Attack", on: Code`, played by

  ```
  function onInflictHit(hit) {
    if( rank >= 3 && hit.isBaseAttack) {
      if(checkProba(vars.chance)) { playStep(Steps.Attack, hit.target); }
    }
  }
  ```

  at `vars.chance` 0.15 — which is the tooltip's *"all your attacks have a 15%
  chance to deal an additional 28"* in as many words. So the finisher prices 133
  rather than 161, and the 28 goes on the base-attack clock through the same
  trigger machinery every other proc uses. This closes the audit line that used
  to read *"billed per finisher, not as its 15%-per-attack rider… the wrong
  schedule is kept knowingly rather than half-read"*.

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
  attacks) key on `prof.type` — and a status tick, which cannot crit at all
  (`initVars@5150`), falls entirely into `fixed`. Rolling *k* crits out of *n*
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

Sequencing was worth **0–0.4%** while the resource mechanics were refused; with
Rage, Spark and Combo Points modelled for real the searcher finds **~1.7%**
where a pool wants managing. The player-facing debuffs are mostly movement
slows and the few damage amplifiers sit on long cooldowns, so the ceiling is
still modest — a fact about this game's numbers, not a limit of the method,
which finds a 2× on the synthetic cases whenever the data offers one.

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
| ~~Fervor / the Masteries~~ **READ 2026-08-02**: one additive bracket `(1 + fervor + mastery) × DamageModifier` | `getDamageRatio@4505` (GameObject.hx:716-720), disassembled with the repo's own `bin/hl.mjs`. Applied to every affinity except Raw (`getDamageScale@5146` returns 1 outright) and never to a status tick, whose SkillContext belongs to the carrier (`initVars@5150`). The measured finisher 133 → 151 = ×(1 + 0.12 + 0.0158) agrees to the integer. | done — `--no-mastery` / `--fervor-scope` remain as toggles |
| `WeaponPower` = the trained level's flat primary budget **plus your primary attribute** | It has no scaling entry and no budget group, so the weapon must set it — 67 mentions across the whole CDB and three strings in the binary, none of them a setter. **Measured 2026-08-01 on a real Cheese Moon vs a 0-armor dummy, twice:** the bag tooltip reads 18–21 against a naked Strength of 34, and the same swing runs 19–24 once the axe's own +15 Strength is equipped — `0.13 × (budget(25) + Strength)` reproduces both within ~5%, the same flat 116 falls out of both readings, and the +2 the equip added is exactly 0.13 × 15. Rarity/star iLevel bonuses belong to the stats (the same tooltip's stat lines match the drop-level budget), not to the damage line. The old slot-share reading (×0.28 at the authored item level) was four to five times low on every base attack. The weapon's "Level 25" is its TRAINED level (weapons level per kills, `WeaponKills_PerSkillRankPoint`); assumed fully trained. **Completed cross-type the same day with Judgement dummy reads:** two-handers take 0.4 of the flat budget where one-handers take all of it (swings 78–95 at Str 72 → flat ≈ 52 = 0.4 × budget), and a **mainhand weapon skill's attribute scaling is 60% attribute + 40% weapon flat** — `constant.WeaponPowerRatio`'s own description, `MainhandWeaponSkill 0.4` — measured exact on five integers: Rampage 233/371/556 at authored 2.5/4/6 × Strength and Brutal Frenzy 133 + its 28 rider at 1.43/0.3, all `ratio × (0.6 × 72 + 0.4 × 123.6) = ratio × 92.7`. Also measured in the same session: PhysicalMastery ×1.12 exact, Fervor applying to base attacks (finisher 133 → 151 = ×1.12 × 1.016), and the ±10% roll riding only the WeaponPower-scaled swings (the Strength-scaled finisher never varies). **Completed with the expanded tooltips (Beefury, Wingsabers):** the game *renders* the rule — Royal Severance "(30 + 30% Intellect) + (25 + 30% Strength)" is 0.6 × authored 0.5 on the attribute and 0.4 × 0.5 × **each attribute's own level-25 curve** as the flat (148.3 / 123.6); Hive Bite's 29.33% is authored 0.85 × its own rank-2 +15%. Tear's 75 proved the per-attribute flats. Swing attribute terms **split across the item's aptitude attributes** — Beefury "(13 + 6.5% Strength + 6.5% Faith)". Skill flats follow the *character's* level; swing flats follow the *weapon's trained* level (two Epic 0-star bag reads imply flats ~100–107, i.e. under-trained weapons). Ten integers reproduce exactly. Open: whether a dual-aptitude item pays BOTH halves to one wearer — Tear's 75 needs the axe's +18 Dexterity on a Warrior sheet; one character-sheet read of Dexterity settles it. | read Dexterity on the equipped sheet (46 vs 28); read the bag weapons' Level lines; disassemble the weapon-equip path for provenance |
| ~~a cast costs only its own authored duration~~ **READ 2026-08-02**: no hero recovery exists | `Skill_RecoveryTime`'s only reader is `Foe.getSkillRecoveryTime@6773`, whose only callers are foe AI; the once-unplaced bare `recoveryTime` symbols resolve to the skill sheet's `aiProps` column — foe-AI data plumbing. The stopwatch agreed first (ten Judgement chains at exactly the authored 3.0s). | done |
| how many enemies an area hits | Fully absent from the data — geometry is authored, population is not. `--targets` is an input, defaulting to 1. | measure in game |
| a `Mono` step carrying an area does not cleave | 80 rows do it and their descriptions disagree; single-target is the reading that agrees with 87% of them and cannot flatter. | `forceMono` in the binary |
| ~~a re-applied status refreshes rather than stacks~~ **READ 2026-08-02** | `addStatus@4561` switches on the authored `stackingPolicy` enum [Additive, DurationBased, Override] exactly as modelled, and `Status.refresh@14446` never SHORTENS a window — the refresh duration is max(new, remaining), which the fight now applies too. | done |
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
hits: `Axe_Boomerang_Skill1` (Bonethrow) bleeds for 40% of the damage
*Bonethrow* deals, crit or not — its guard has no crit test. Reading its
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

Corrections that came out of it, each verified against a capture and most
against the bytecode:

- **Mitigation composes as two multiplies**, not one sum: armorIgnore takes
  its own `(1 - clamp(a,0,1))` on the pool before penetration's
  `(1 - clamp(p,0,100)/100)` (getAffinityDamageReduction@4510). And armour is
  a RATING at a LEVEL: the pool is built at the target's spawn level, the
  divisor at the striker's (`foe(name, level, targetLevel)`, parity default -
  boss rows' lvl column is contradicted by measurement; they spawn at zone
  level). Dynamic level scaling (getDynamicScalingFactor@4638) is read and
  confirmed inactive in ordinary fights.
- **Units inherit from every parent** (loadUnit@18967 iterates all `inherit`
  entries, modifier-only stubs take the parent's row with multipliers
  multiplied). Golems mitigate 0.4068 physical off a 0.30 base and are the
  one family where ArmorPenetration beats SpellPenetration.
- **The character sheet and the combat sheet are different objects.** The
  fight prices against permanent statuses at cap (a Devote enchant's five
  stacks are the value of the slot); the sheet the game shows you standing
  still contains none of that - except auras with no duration, which are worn,
  not entered (the Boomerang crit aura). `bench verify`'s SHEET check now
  lands 9/9 to 12/13 attributes within 1% on all four classes.
- **A star is not the rider rank.** Weapon upgrade skills attach at three
  stars (GearUpgrades.SkillUnlockLevel) and take their rank from the ROLLED
  rarity index (updateInf@8174 overwrites the authored rarity), settling the
  stars-minus-one question. Upgrade proc chances rank-resolve through the
  same overrides. The behind perk (dmgMult += vars.damage on basic attacks
  from the rear half-plane) sums across both weapons into the one additive
  bracket, billed at `assume.behindFraction` (default 1, an assumption).
- **Which ticks crit is the statusType's DoT/HoT flag** (initVars@5150 zeroes
  ctx.critChance only for flagged types, parent chain walked); everything
  else ticks with the CARRIER's crit chance. Buff auras crit; poisons do not.
- **Scripted riders are events, not decoration.** onInflictStatusEval rides
  dot ticks - once PER STACK (measured: exactly 5.0 procs per tick at five
  stacks); `status.kind == Skill.X` filters which dot; hasStatusMaxStacked on
  a build-applied status is a named assumption; a self-`resetCooldown` behind
  a Mark another skill supplies is a banked economy (one mark per supplier
  cast, one spent per reset). Multi-applier dots keep one identity fed from
  every channel - Lethal Poison went from -81% to -1.4% per tick on that
  change alone.
- **Coverage is 100% on all four classes**: every damage source the game
  recorded has a model line. Held against a player pressing the proper
  rotation on one dummy, the formulas price within -2.9% at the player's own
  press rate; the model's own fight cadence remains the dominant residual.

Patch days run through `bench update`: model/fingerprint.json holds one hash
per sheet row, per script, and the resolved name->findex table for every
citation in src/. The drift report names additions, removals and changes, and
the work list routes each to its validation - an in-game log, the SHEET
check, or a model re-read. The suite fails when a citation stops resolving;
`--accept` records a new build only deliberately.

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
- **An op-2 dynVal is a floor, not a mystery.** getAffixModVal@20794: op 0
  multiplies the authored value by the script-set dynVal (worth 0 until a
  script writes), op 1 replaces, op 2 ADDS - and a fresh instance reads
  dynVal 0, so the authored value is guaranteed. Crusader's +10 CritChance,
  +10% damage, shield and heal, and 10 flat CDR are credited at ONE stack
  (maxStacks 300 is the growth channel) at 20/120 uptime; the addDynVal
  growth stays refused and flagged. Live in-buff crit +11.96 points agrees.
- **The carrier's bracket belongs to self-worn Buffs.** initVars@5150 seeds
  every tick's SkillContext from the status's OWNER: an enemy-worn debuff
  ticks at the foe's ~1.0, a self-carried Buff at the player's
  (1 + fervor + mastery). Same flag (`tickCarrierSelf`), same
  over-generalisation, as the tick-crit rule.
- **A swing-triggered tick inherits the swing's by-type crit.**
  PurgingStrikes plays its damage step synchronously inside onInflictDamage
  behind isBaseAttack || isFinalCombo; ZealousFighter's "+8 crit on attacks"
  prices the tick too. `tickOnSwing` reads the guard-then-playStep shape and
  the pricing keys the by-type bonuses on the swing's category.
- **The item-scaling channel follows the granting item's TYPE CHAIN**
  (getStepEffectScaling@20778): itemRatio 0.4 where the chain reaches
  MainhandWeapon - every held weapon, so weapon-granted status ticks take
  the ordinary 0.6/0.4 mix (Demondash's aura: -22.7% -> -3.2%) - 1.0 for
  GearTrinket, and 0 otherwise. Shield inherits OffhandWeapon, never
  MainhandWeapon, so the orb pulse is PURE attribute; a +0.4-budget reading
  that fit the same number was degenerate on one build and the bytecode
  breaks the tie. Raw-affinity ticks price pure everywhere (the capture
  pins it twice), and dot-scoped talent multipliers never reach Raw dots
  (getDamageScale@5146 returns 1 for Raw first).
- **The trinket channel reads the character at rest and pays in full.**
  Trinket_Demon_Status ticks its authored amount undivided - three equal
  pulses per application - priced off floor(base primaries) + non-weapon
  flat primary affixes (0.2 x 225 = 45.00 exactly, 2,407 rows), immune to
  application-state repricing. -48.4% -> -1.6%; the rest is a consumable
  the dump cannot see.
- **Two talent guards became scopes.** Authority: `dmg.skillId == Skill.X`
  -> a one-skill rider (Smite -20.3% -> -4.3%). Radiance: `ctx.status !=
  null && ctx.status.owner == owner` -> a rider on every owner-carried tick
  (five Priest rows moved at once; the orb's last-pulse ratio 2.25/1.25
  proves the script's ctx.dmgMult += 1 shares this rider bracket). Both at
  the rankOverride-RESTATED value, not times-rank.
- **Gash counts company.** The daggers passive's hook adds +10% per OTHER
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
  per pairing, 59.0 exact against 51 capture rows (-0.0%). The guaranteed
  crit: `ownerHero` is the owner (SELF_TARGETS), and the costless register -
  the status consumes itself on the finisher for critChance += 1 - is armed
  per mage chain cast at Chaincast's authored one-per-four-actives, which
  also force-fires every conduit. RayOfSpark: a spread channel divides by
  the game's own floor(duration/tick) (initTicks@5882 - no start-tick +1)
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
getArsenalSkills@8543 said it would. What one sitting of play settled:

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
  replicated masteries list (the storage hasMastery@6089 consults). Emsey's
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
  exactly - the model banked 0.2 of the whole rotation instead of 0.3 of
  three skills, and the two cancelled until the Legendary arsenal raised
  the true feed while shrinking the false one. Fixed both, plus the tick
  clock: it resets on every discrete feed (the live lattice is silent
  through sub-2s spam), expiry-anchored only where the sim's feed is an
  expectation smear (crit-gated pools), and zero-pay ticks are not ticks.
  Share verdict: -2.7pp CLOSE, feed rising with the arsenal like live.
- **The v5 rune cache lies by omission.** BaseSkill.masteries is DERIVED
  from HeroSpecialization.skillMasteries and a pure client replica never
  rebuilds it (initData@6029 skips applyMasteries) - Emsai's Surging Force
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
  propagateMageChainCast@29172 caller - consumes it on the next
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
