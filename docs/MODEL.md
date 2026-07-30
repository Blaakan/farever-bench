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
  `conds.factions`. **Every aptitude an item names pays, and they sum**, and they
  pay regardless of your class — see [section 12](#12-checked-against-the-game),
  which is checked against a character sheet. Each aptitude's share is rounded
  on its own before the sum; that is a one-unit difference and the game agrees.
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
| `active` | `max(cooldown / (1+CDR), occupancy)` | needs `cooldown > 0` |
| `triggered` | `comboRate / prayersSlotted` | prayers, per `Priest_Rosary` |
| | `attackRate × vars.chance` | `vars.chance` is the proc rate the data ships |
| `passive` | not throughput; contributes stats | own affixes, or a self-buff status |
| `unmodelled` | **zero, and named** | anything else |

**No cooldown and no rule means unmodelled, not spammable.**
`Warrior_Rage_Strike` has no cooldown and `props.costs: [{amount: 10, atb:
Rage}]` — it is gated by Rage income, which lives in a script. Treating it as
castable every 1.4s tripled the Warrior's damage before this was caught.

**`props.rankOverride`** restates props at a weapon-skill rank;
`GA_Craft_Skill1` drops from a 16s cooldown to 12s at rank 2, and `--rank`
applies it.

**`cond.castHoldStep` steps are mutually exclusive charge levels.**
`GA_Craft_Skill1` declares Hit1/Hit2/Hit3 at 2.5×/4×/6× Strength for how long
you held it. Summing all three overstated the skill twofold; full charge is
assumed and stated in the audit.

**`cond.mastery` steps are excluded.** Which rune is slotted is a build axis
this model does not carry, so a rune-gated step is left out rather than granted.

**Cooldowns cannot oversubscribe the clock.** If the sum of
`occupancy / interval` exceeds 1, every active skill is scaled by `1/busy` and
the output says so — a real rotation would drop its weakest skill rather than
slow all of them, and this model has no priority order to do that with.

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
nothing else — resolves X, and applies its affixes **at full stacks**. A
15-second buff refreshed by a 30%-per-attack proc does sit at its cap in
sustained combat; a short fight would not reach it, and the audit says so.

Only self-targets count: `owner`, `hit.source`, `dmg.source`. `addStatus(hit.target, …)`
is a debuff on the enemy and must never be read as your own stat — the model
checks the target and the status's `props.status.types` includes `Buff`.

Without this, every weapon-enchant socket came back empty, and the tool was
implicitly claiming "no enchant is better than any enchant".

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
only 13 of 962 skills carry `props.interruptStyle`. The actor is committed to
one skill until its step DAG finishes, so occupancy is:

```
occupancy = max(step.delay + step.duration) + Skill_RecoveryTime * ratio
            ratio = Attacks_RecoveryRatio (0.25) for attacks, 1 otherwise
```

**No animation model is needed**, which is the single biggest scope risk this
project does not have: the `anim` sheet has exactly two columns (id, comment)
with no timing data, only 1 of 962 skills sets `anim.duration`, and no
`getAnimDuration` symbol exists in the bytecode. Every delay and duration in
`steps` is explicit seconds.

### The rotation

Cooldown skills on cooldown, base-attack chain in the gaps:

```
dps = SUM_cooldowns(damage_i / max(cooldown_i / (1+CDR), occupancy_i))
    + chainDamage/chainTime * max(0, 1 - SUM(occupancy_i / interval_i))
```

The whole attack chain is one cycle, because you cannot press swing 3 without 1
and 2. This is a priority list with no conditions — as much player model as can
be justified without a measured occupancy log.

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

## The search

Coordinate ascent with exhaustive per-slot enumeration: walk the free
decisions, and for each one try every legal option with everything else held
fixed, keeping the best. Stop when a full pass changes nothing.

Fast enough to be exhaustive: a slot has 2–27 candidates, a build has ~15 slots
and up to ~10 sockets, and convergence takes 3–5 passes. About 3000 distinct
loadouts, well under a second.

Gear is optimised before augments in every pass, because gear decides which
sockets exist. Coordinate ascent finds a *local* optimum and the interactions
here are real, so the search restarts from several seeds (`--restarts`) and
keeps the best. Restarts use a seeded PRNG — never `Math.random` — so a build
you share can be re-derived.

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
| `WeaponPower` = the weapon slot's share of the class primary budget | It has no scaling entry and no budget group, so the weapon must set it. `constant.WeaponPowerRatio`'s description — *"Percent of AP/SP scaling that are replaced by a flat amount coming from weapon"* — is consistent with this reading but does not confirm it. Every base attack scales off it. | disassemble the weapon-equip path |
| `LinearRatio` behaves like `Flat` | No row in this build uses it. | wait for one, then check |

**Absent entirely** — skill scripts (427 of 962 skills carry hscript bodies, so
DoTs, procs, statuses, talents and conditional riders are all missing), items
that grant a skill rather than stats (weapon enchants and Demon sigils score
zero), per-swing variance (`WeaponAttack_RandomRange` = 0.1 exists but its only
located read is a UI text path), party buffs (`Group_MaxPlayers` = 4),
consumables (4 slots, 80 items with effect props), threat, and every non-combat
slot.

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

**The reading.** `Spear_Eruption` — "Gorgon Ratsay's Toothpick", Rare, Kobold
faction, aptitudes `[Assassin, Cleric]` — on a level-10 instance, which with
Rare's `+10 iLevelBonus` is effective level 11:

| | Vitality | Dexterity | Faith | Critical | Armor Pen |
|---|---|---|---|---|---|
| main hand | 36 | 18 | 15 | 39 | 39 |
| arsenal | 15 | 8 | 6 | 16 | 16 |

**What it settled.** All ten numbers fall out of three rules, and each rule is
discriminated by at least one of them:

1. **Every aptitude pays, and they sum.** Dexterity 18 is Assassin's primary
   budget (36..648) and Faith 15 is Cleric's (30..540) — a 1.2 ratio that
   matches the budgets exactly. Vitality is the sum of both MaxHealth budgets.
   The static reading had assumed an item resolves to ONE aptitude, which would
   have produced 18 *or* 15, never both.
2. **They pay regardless of your class.** Your aptitude gates whether you can
   equip the thing; once it is on you get everything it grants. That is why a
   Rogue's tooltip shows +15 Faith.
3. **Each aptitude's share is rounded on its own, then summed.** Rounding per
   aptitude gives Vitality 16 + 20 = 36; summing first and rounding once gives
   35. The sheet says 36.
4. **The arsenal factor is 0.4 with a ceiling.** `ceil(v * 0.4)` is the only
   combination reproducing all five arsenal values; `round` gives 14 and 7,
   `floor` gives 14/7/15/15, and 0.5 is not close. The ceiling is why the
   arsenal *feels* halved.

**And the two ratings from one item** are the clearest illustration of the
faction rule: Assassin reads Kobold as ArmorPenetration, Cleric reads Kobold as
CritChance, so a single Kobold `AssCle` spear grants both — 39 of each, each at
the full `ratings` share rather than a split.

`test/run.mjs` asserts all ten values plus the Corrupted Gift's -20/+20 →
-8/+8, so a regression here fails the suite by name.

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
