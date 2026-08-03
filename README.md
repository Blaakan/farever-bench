# farever-bench

A gear bench for **Farever** (Shiro Games). Pick a class, pin whatever you have
already decided, and it fills the rest — every armour slot, both weapons, the
offhand, and all the enchant and gem sockets — with the best legal combination
it can find.

```bash
node bin/bench.mjs optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1
```

> *"I want to play Priest with this exact sword and no enchant on it. Work out
> everything else."*

Read-only. It parses `data.cdb` out of your own copy of the game and does
arithmetic. It never touches the game process, writes nothing to the install
directory, and makes no network connections.

---

## What it does

```
Priest 25 - maximising dps vs named boss (Ratsar: 0.4/0.4)
pinned: Weapon1   sockets: Weapon1/EnchantWeapon, Weapon1/Demon

SLOT           ITEM                                     RAR        UPG    iLVL  FACTION  GIVES
Weapon1        Beefury, Blessed Blade of the Farseeker  Legendary  *****   350  Bee      ArmorPenetration+SpellPenetration  pinned
Weapon2        Censer of Wool Hollow                    Legendary  *****   350  Crimson  CritChance+Fervor                  rolled
OffhandWeapon  (empty)
...

AUGMENTS
SLOT  SOCKET         AUGMENT                EFFECT
Feet  EnchantFeet    Magic Formula: Fervor  +15 FervorRtg
Neck  Jeweller       Cursed Eye of Vice     +9 CritChanceRtg +9 FervorRtg ...

DAMAGE
                        DPS  DAMAGE  SHARE  HITS
  overall             221.4  44,270          724
  Hive Bite            50.6  10,114  22.8%    92
  Prayer: Smite        28.4   5,688  12.8%    31
  Blinding Light       24.7   4,931  11.1%    11
  Luon Shackles        17.3   3,470   7.8%    15
  Hive Swarm           14.3   2,861   6.5%   184
  Sword_Base_Attack    14.1   2,822   6.4%   102
  ...
```

The damage column **adds up**: every ability's total sums to the overall, the
base-attack chain is broken out per link rather than hidden behind one row, and
HITS counts damage *events* — a dot's tick, each hit of a multi-hit cast, one per
target of a cleave — which is what a damage meter counts, so the two reconcile
row by row.

Every number comes with the target it was computed against and the fight it was
computed over. `--verbose` adds back everything that *explains* a number rather
than being one: the search trace, the rotation and its reasoning, the cause of
every refusal, and the assumptions-and-gaps list.

### Commands

| | |
|---|---|
| `optimize` | fill every unpinned slot and socket with the best combination |
| `rank` | rank every item that fits one slot against your current build |
| `sheet` | the stat sheet a build produces, with rating→percent conversions |
| `items` | every item legal in a slot for a class |
| `classes` | the four playable classes and what they scale off |
| `slots` | the slots, their share of the stat budget, and which augments they host |
| `rarity` | which rarities each slot can reach, and how that is derived |
| `targets` | what the world actually resists, and what penetration buys |
| `talents` | the talent trees and runes, and how much of them is readable |
| `profiles` | the stat corners a weapon or a rotation can be compared at |
| `weapons` | every mainhand, ranked at one of those corners |
| `layouts` | the best full build for every ordered (mainhand, arsenal) pair — one report each, written to disk as it finishes, resumable |
| `rotation` | search for the rotation a weapon wants, and the kit that goes with it |
| `audit` | every assumption and gap in the model |

### Searching a rotation

```bash
bench rotation --class Warrior --profile armorpen \
  --pin weapon1=GA_Craft --pin weapon2=GA_Demon --restarts 250 --across
```

```
627810 simulated fights in 101.0s over 3 rounds of (rotation, then kit)
1198882 lists considered - 571072 of them were lists this search had already
played, and were re-scored from the memo

ROTATION  - walk it top to bottom, press the first line that is ready
  #  SKILL         WHEN                            PER CAST   EVERY
  1  Tear Reality  always                             212.3  18.18s
  2  Rampage       always                             457.2  11.11s
  3  Shockwave     debuff.Tear Reality.remains>=3     139.1  25.00s
  4  Raging Smash  ready.Shockwave                     75.2   6.45s
  5  Raging Smash  debuff.Tear Reality.remains>=3      75.2   6.45s
  not pressed: Ignore Pain, Surging Force - the search found the clock better spent elsewhere
  anything not listed is never pressed; when no line matches, you swing.

  derived order   147.9
  searched        151.1     +2.22%
  1 of 250 independent restarts reached this score; worst reached 149.2.
```

That last line is worth reading twice: **one** restart in 250 found this list.
The vocabulary grew when `remains` and `cd` landed, and a richer vocabulary makes
the basin around the best list narrower, not wider — which is exactly why the
search kicks the incumbent instead of restarting at random.

**What is searched is a policy, not a sequence.** A sequence is optimal for one
build against one deterministic fight, transfers to nothing, and learns to dump
every cooldown before the bell — none of which is a rotation anyone can play. An
ordered list of `(skill, condition)` — what SimulationCraft calls an Action
Priority List — is stationary and re-evaluates against whatever build wears it.

A condition may only say things the fight already tracks: `buff.X.up/.down`,
`debuff.X.up/.down`, `buff.X.remains>=n` for how much of a window is left,
`rage>=n` and `rage<=n` at a threshold something actually costs or wastes,
`ready.X` / `holding.X` / `cd.X<=n` for another skill, `charges>=n` for its own.
Up to three of them may be ANDed.

The `remains` and `cd` thresholds are not a continuum. The only question a
remaining-time test can answer is *is there room for what I am about to press*,
so the discrete set is the **occupancies of this build's own casts** — the
durations actually on offer — rounded to the half second and capped at three
distinct values. Arbitrary thresholds would mostly duplicate each other, and
every one of them costs a fight to find that out. A skill may appear **more than once** under different
conditions, which is the commonest idiom in a real list — the search used it to
put `Raging Smash if rage>=18` above the armour-strip window and a bare
`Raging Smash` below it.

Steepest ascent over reorder / relocate / re-condition / conjoin / relax / drop /
add, with **iterated local search**: every third restart is a fresh random list
and the rest are kicks away from the best found so far. That matters — climbing
from random lists alone reached the best score in 1 restart out of 30, because
the basin around a sensible order is narrow. Restart 0 is always the order the
model derives, so the answer can never be worse than what every other command
reports. Ties break toward the simpler list, which is what keeps tautologies
like `ready.X` on X's own line out of the output.

Rounds alternate — search the rotation with the kit fixed, then the kit with the
rotation fixed — until neither moves.

Three things are checked rather than claimed:

```
AND WHETHER IT SURVIVES THE DICE  - 60 fights each, procs and crits rolled rather than averaged
                      MEAN        SD
  derived order      145.9      5.70
  searched rotation  150.8      5.84
  difference         +4.97  +/- 1.05  clears the noise

AND WHETHER IT TRANSFERS  - the same rotation, re-evaluated at other stat corners
  PROFILE                 DERIVED  THIS ROTATION   GAIN
  zero                       72.4           73.7  1.77%  holds
  mid                       144.0          147.6  2.49%  holds
  crit                      149.0          152.4  2.28%  holds
  armorpen  (tuned here)    147.5          151.1  2.48%  holds
  fervor                    147.3          151.0  2.49%  holds
```

`--validate n` rolls the procs, the ±10% swing band and the crit instead of
averaging them, and says outright when a difference is inside the spread.
`--across` re-runs the rotation at other stat corners: one that only wins where
it was tuned is a rotation for that corner, and this one holds everywhere.

### Does a stat repartition change the rotation?

`--across-search` asks the stronger version of that question: search a **fresh**
rotation at every corner with the kit held fixed — so the only thing that moved is
the stats — then cross-evaluate every rotation at every corner.

```
CORNER    DERIVED  SEARCHED   GAIN  THE ROTATION IT WANTS
mid         144.0     147.5  2.39%  Tear Reality > Rampage > Raging Smash[debuff.Tear Reality.up] > Shockwave[cd.Rampage<=1]
strength    208.7     213.3  2.22%  Rampage[holding.Shockwave] > Raging Smash[debuff.Tear Reality.remains>=1] > Tear Reality > ...
crit        149.0     152.4  2.31%  Tear Reality > Rampage > Raging Smash[debuff.Tear Reality.remains>=3] > Raging Smash[cd.Tear Reality<=3 & debuff.Tear Reality.up] > ...
armorpen    147.5     151.0  2.38%  Tear Reality > Rampage > Raging Smash[debuff.Tear Reality.up] > Shockwave[cd.Rampage<=1]
fervor      147.3     150.9  2.39%  Tear Reality > Rampage > Raging Smash[debuff.Tear Reality.up] > Shockwave[cd.Rampage<=1]

AND WHAT IT COSTS TO CARRY ONE EVERYWHERE  - % below the best rotation for that corner
  FOUND AT     mid  strength  vitality    crit  armorpen  fervor
  mid        0.00%    -0.08%    -0.40%  -0.31%     0.00%   0.00%
  strength   0.08%     0.00%    -0.32%  -0.27%     0.08%   0.08%
  crit      -0.24%    -0.24%    -0.63%   0.00%    -0.24%  -0.24%
  fervor     0.00%    -0.08%    -0.40%  -0.31%     0.00%   0.00%
```

**Barely.** Three of the six corners converge on the *same* four-line list, and
carrying any one of them everywhere costs at most **0.63%**. `crit` is again the
one that reaches furthest — it is the only corner that wanted a two-term
condition, `Raging Smash if cd.Tear Reality<=3 & debuff.Tear Reality.up` — and
`vitality` the one that wants the longest list. Whether a distinct list per stat
spread is worth writing down is then a decision with a number attached rather
than a guess, and the number says no.

**On the size of the number, and why it moved.** This used to read +0.5%, and
the reason given was that the mechanics worth sequencing around were ones the
model refused. Two of those have since landed and the number went to **+2.2%**:
the rotation language gained *how much of a window is left* (`remains`) and *how
close a cooldown is* (`cd.X<=n`), and a damage-over-time now ticks once per
stack instead of once. The winning list uses both — `Shockwave if
debuff.Tear Reality.remains>=3` is *do not spend it into a window that will
close first*.

What is still refused is named in `bench audit` and it is still worth something:
a stat buff is counted at its stack cap rather than at a tracked count, Surge of
Violence's free cast has no register, and the proc-applied trinket buffs are
refused entirely. The search is what will measure those when they land, the same
way it measured these.

### Comparing weapons without the gear in the way

The best rotation depends on the weapon, the talents, the runes and the stats;
the best gear depends on the rotation. Searched together that is one problem
with two moving halves, and the gear half is the expensive one.

A **stat profile** cuts it: a fixed, named corner of the stat space that stands
in place of the armour. Nothing about it is invented — `itemType.atbRatio` sums
to exactly 1.0 per stat group over one item per core slot, so one budget *is* a
complete set, and `budget(level, start, end)` is the same curve every other
number here comes off.

A profile **pins** every stat to a flat number — 50 everywhere, 100 on the one it
names — and those values *replace* whatever the level curve and the gear would
have produced.

| | |
|---|---|
| `zero` | every stat pinned to 0 |
| `mid` | every stat pinned to 50 |
| `strength` `dexterity` `intellect` `faith` `vitality` `armor` `magicarmor` `crit` `armorpen` `spellpen` `fervor` | every stat pinned to 50, that one to 100 |

`--profile-base` and `--profile-peak` move both numbers.

So `crit` minus `mid` is exactly *"+50 CritChanceRating and nothing else moved"* —
the comparison that isolates a stat. **Forced, not added**, which is the point: a
weapon that happens to be a better stat stick cannot win on that, so two weapons
differ only in the kit they grant and the coefficients they scale by. The pinning
happens inside the sheet's topological walk, so everything downstream follows —
pin Dexterity and the CritChance that scales off it moves with it.

The numbers are arbitrary and deliberately so. 50 is not half of anything; it is a
fixed rig, the same for every weapon and every class. A profile denominated in
budget fractions cannot do that job — a Warrior's full primary budget is 123.6 and
a Rogue's is 148.3, so "half a budget" is a different number per class and carries
the budget's own shape into the comparison. `bench profiles` prints the real
budgets alongside, so you can see how far from a real character the rig sits.

```bash
bench profiles --class Warrior          # what a full set delivers, per group
bench weapons  --class Warrior --profile armorpen
bench weapons  --class Warrior --across  # and how much the answer moves
```

```
  DPS  VS BEST  WEAPON                          HANDS       CHAIN  SLOTS  SKILLS TAKEN
376.1     0.0%  Judgement                       THWeapon    4      2/2    Rampage, Shockwave
336.9   -10.4%  Martyr of Enripit               THWeapon    4      2/2    Wild Whirlwind, Outburst
330.5   -12.1%  Amon Ram, the Creator           OHWeapon    4      1/1    Ram Veil
```

`--across` answers the question the decomposition rests on, and on this data the
answer is encouraging: above the bare corner the **weapon ranking barely moves**
(mean shift 0.3–0.6 places out of 13) and the **skill choice does not move at
all**. Talents and runes do — three or four different sets across six corners —
which is exactly what you would expect from nodes that trade crit against
penetration. So a weapon and its two skills are one decision that can be made
once; the tree and the runes are re-decided per corner, which is cheap.

A profile also probes corners gear cannot reach — a Warrior in Faith gear — and
says so rather than presenting a hypothetical as a build. That is how you find
out whether a weapon's kit scales off a stat its class never gets.

### The fight

Throughput is a **simulated fight**, not a steady state. Banked charges are
spent, statuses tick and expire, and the base-attack chain fills what is left.

The fight **holds state**: buffs and debuffs land, change what the next cast is
worth, and expire. Without that, stripping a quarter of the target's armour and
then nuking it is worth exactly the same as nuking it first — and a buff window
is worth the same whether you burst inside it or outside it.

```bash
--fight 200      # how long the fight is (default 200s, what a meter reports)
--fights 50      # roll the procs, the swing band and the crit for real, and
                 # report the mean and the spread
--targets 3      # how many enemies stand in an area effect (default 1)
--lookahead 8    # seconds of rollout when choosing a cast; 0 for a plain
                 # first-available priority list
```

**On the rotation.** SimulationCraft answers dependency order with a
human-authored Action Priority List and does no search — its wiki says outright
there is *"no lookahead or optimization of action orderings"*. Nobody authors
those lists for this game, so `--lookahead` stands in for one: it scores each
ready cast by what the next few seconds are worth if you press it. That is worth
up to +97% on a rotation built to reward it. It is a heuristic and it can lose
to plain priority order, so the fight is played **both ways and the better
kept**, and the output says which won. Sequencing used to be worth 0–0.4% on
this game's numbers; with Rage, Spark and Combo Points modelled for real it
reaches ~1.7% where a resource wants managing, and grows as more of the
stack-and-reset mechanics land.

`--targets` is the one to reach for when the tool's number looks low against an
in-game meter. Most of a build's damage is area-borne, and *nothing in the data
says how many enemies are standing in the area* — so the default is honest
single-target and the crowd is something you tell it about.

### Pinning

Pinning is the point. Anything you pin is held fixed and everything else is
optimised around it.

```bash
--pin chest=Chest_RManfish_Cle     # fix an item
--pin weapon1=Sword_Swarm*3        # fix an item at 3 upgrade stars
--pin trinket=none                 # force a slot empty
--pin feet/enchantfeet=none        # force one socket empty
--pin chest=Chest_RManfish_Cle@Epic  # assume a particular drop rarity
--pin weapon1=Spear_Eruption^10*0  # the instance that dropped at level 10, unupgraded
--pin neck=Necklace_Z2RCraft+MaPen  # craft jewellery pays ONE named generic
--no-augment weapon1               # no augments at all on that slot
```

Slot and item names are matched loosely: `chest`, `Chest`, `Slot_Chest` and
`fingerleft` all work. Ambiguity is an error that lists the candidates rather
than a silent guess.

### Which skills to slot

A weapon offers three skills and you get two. That is a build decision, so the
optimiser makes it and tells you what it dropped:

```
SKILLS
POOL              SLOTS  TAKEN
main-hand skills  2/3    Heat Emission, Hot, hot, hot!   not taken: Flamie
arsenal skills    2/3    Luon Shackles, Hidden Power     not taken: Blinding Light
prayers           3/3    Prayer: Life, Prayer: Smite, Prayer: Virtue
```

Slot counts come from the game's own constants —
`UnlockLevel_WeaponSkillSlots`, `UnlockLevel_Arsenal`,
`Priest_Prayer_Slot_Unlocks`, `Mage_Conduit_Levels` — so a level-12 character
correctly gets two main-hand skills and only one arsenal skill. Fix a choice by
hand:

```bash
--skills weapon1=Scepter_Flamie_Skill1,Scepter_Flamie_Passive
--skills prayers=Smite,Life
```

The chain's **length** is authored, in `moveSet.comboLength`, and two weapons'
item rows are shorter than it says: `Scepter_Flamie` lists 2 links where the
scepter moveSet declares 4, and `DM_Multispin` lists 4 where DualMaces declares
5. The missing links all exist as rows — `DM_Base_Attack4` is the only
chain-link row in the sheet no weapon references — so they are filled from the
weapon type and the fill is printed. It matters because the combo finisher is
what charges prayers and what every proc guard rolls against: a 2-link chain
fires them twice as often, which was worth +44% on a Priest holding that scepter.

Only the **main-hand** weapon's base-attack chain is used — the arsenal is a
weapon you swap to, not a second set of swings — while its slotted skills still
count. The arsenal contributes `ceil(stat * 0.4)` rather than half, which is
**checked against the game**: the same spear reads +36/+18/+15/+39/+39 in the
main hand and +15/+8/+6/+16/+16 in the arsenal.

### Goals

```bash
--goal dps          # default
--goal ehp          # effective health
--goal hps          # healing throughput
--goal sps          # shielding
--goal mixed        # dps + 0.25*ehp, the default blend
--weight dps=1 --weight ehp=0.25    # a blend, normalised against your seed build
```

The optimiser evaluates the real objective for every candidate rather than
using stat weights, because the objective is not linear in the stats — see
[docs/MODEL.md](docs/MODEL.md#why-not-stat-weights).

---

## Install

You need [Node.js](https://nodejs.org/) 18+ and a copy of Farever.

```bash
git clone https://github.com/<you>/farever-bench
cd farever-bench
node test/run.mjs                  # 503 checks against your own game data
node bin/bench.mjs optimize --class Warrior
```

The install is found through Steam's own library list. If that fails:

```bash
node bin/bench.mjs optimize --class Warrior --game "E:\SteamLibrary\steamapps\common\Farever"
```

The path is remembered in `.cache/` so you only answer once.

No game data is redistributed. Everything is read from your install at runtime,
and nothing derived from it is committed.

---

## How it knows anything

Farever runs on Shiro's own stack — Haxe → HashLink → Heaps.io — and ships two
things that make this tool possible:

1. **`data.cdb`**, a CastleDB with the whole stat system in it: 78 attributes
   *with their formulas*, per-class stat budgets, per-slot budget shares, 962
   skills with timed damage effects, and 93 augments with explicit affixes.
2. **`hlboot.dat`**, HashLink bytecode v4 **with full debug info** — source
   filenames and per-opcode line numbers across 47342 functions. The repo
   ships its own reader for it (`node bin/hl.mjs find/disasm/grep-str`), so
   the composition rules are read out of the compiled game rather than
   guessed, and every citation below reproduces from your install.

Seven formulas carry the whole model. All seven were read from the bytecode —
the last three with the repo's own reader, after live measurements found them
first — and each is cited to its function index and source line in
[docs/MODEL.md](docs/MODEL.md):

```
budget(L, min, max) = min * (max/min)^((L-1)/(EarlyMaxLevel-1))     one curve, everything
rating contribution = (rating / budget(L, min, max)) * target        `scale` is NOT read
armor budget        = red * (385 + 100L) / (1 - red)                 authored columns are dead
attribute           = (stored + scaling + flat) * modAdd * modMul
weaponPower         = 0.4 * SUM(aptitude budgets at item level)      + MEAN of those attributes per swing
weapon-skill term   = ratio * (0.6*attribute + 0.4*its own curve)    either hand; class skills pure
one hit             = (amount + adds) * dmgMult * crit               * (1+fervor+mastery) * (1-reduction) * taken
```

Four consequences worth knowing as a player, none of them visible in game:

- **Rating is linear, and it depreciates.** At level 25 one point of
  CritChanceRating is +0.0527 percentage points of crit, and every point loses
  **3.8% of its value per character level you gain**.
- **Faction decides your secondary stat.** The same Manfish chest gives a
  Priest Fervor and a Warrior ArmorPenetration, out of one data row. Gear with
  no faction has no secondary stat at all.
- **An item naming two aptitudes pays you both halves** — everything its
  tooltip shows, which is why a Kobold spear lists +39 Critical and +39 Armor
  Penetration at once and you receive both. Read off the character sheet: a
  naked Warrior at 38/34/28 Vitality/Strength/Dexterity equips a
  Fighter+Assassin axe showing +36/+15/+18 and reads exactly 74/49/46.
  Armour is the one exception — its budget is the wearer's own reduction
  target, so it pays once however many aptitudes the row names. Dual-aptitude
  gear therefore carries roughly two budgets of primaries and ratings, and
  shared pieces really are stat-denser than exclusive ones.
- **Only weapons can be upgraded.** The game's own window text says so, and the
  twenty `<WeaponType>_Upgrade` skills exist for weapon types only. Reading the
  per-rarity `gearUpgrades` column alone put three stars on every armour piece.

---

## What it does not do

Stated plainly, because a tool that hides its gaps is worse than no tool. `bench
audit` prints this list with every result.

- **The composition order is READ now.** `ent.Unit.computeDamage` and
  `applyDamage` are disassembled (`node bin/hl.mjs disasm 4841`): one folded
  multiplier `(amount + adds) × dmgMult × crit × (1 − reduction) × taken`,
  Fervor and the matching Mastery additive inside one bracket, Raw damage
  bypassing all of it, and `WeaponPower` = 0.4 × the summed aptitude budgets.
  Every formula was ALSO verified against live dummy readings before the code
  was read, and the audit tracks the few places the two disagree.
- **How many enemies you are hitting is an input, not an answer.** Most of a
  build's damage comes from area steps, and the geometry is fully authored —
  shape, range, height, an expanding radius — but *nothing anywhere says how
  many enemies stand inside it*. `--targets` defaults to 1, so the headline
  figure is single-target and an open-world pull reads higher.
- **Partial skill scripts.** 427 of 962 skills carry hscript bodies this build
  does not execute. What is read out of them, because the data records it
  nowhere else: the status a skill applies (`addStatus`, through a local alias
  if it uses one), the *event* that applies it, the roll that guards it, the
  proc rate `vars.chance`, and the rest of the guard — a `rank >= 2` rider, a
  `hasTalent` or `hasMastery` check, all of which the build can answer. A
  magnitude passed as a third `addStatus` argument or a `setDynVal` injection is
  not, and neither is a guard that asks about live state (`hasStatus`,
  `getStatusCount`, `.stacks >= getMaxStacks()`). Those keep their rate
  **refused and named** rather than approximated: `DA_Water_Combo_PassiveRank3`
  rolls 0.35 a swing but only once its own buff is max-stacked, and crediting
  the bare 0.35 is a proc rate the skill does not have.
- **A guard is read, not assumed.** A script's `rank >= 2`, `hasTalent`,
  `hasMastery` and `critical` are all things the build can answer, so they are
  evaluated: a rank-1 character no longer gets rank-2 riders, a rune-gated
  bonus applies only when you slot it, and a proc on a critical strike is
  priced at your crit rate. A guard that asks about live state — `hasStatus`,
  `getStatusCount`, target health — keeps its rate **refused and named**
  instead of approximated. See [docs/MODEL.md §14](docs/MODEL.md) for the full
  list of shapes and where each is read.

- **Talents and runes are structure more than value.** The trees are allocated
  and validated against the real rules, but most of the 88 nodes and most of the
  84 runes declare nothing a data-driven model can read. `bench talents` counts
  what is readable, live. A Demon sigil grants a tier-4 talent outright; the
  search takes one because free beats empty, and says the pick is not scoreable.

  **The Warrior is the exception, because it was walked node by node.** All
  sixteen points land on something the model values: two pool bleeds, six scoped
  modifiers, penetration against a bleeding target, Rage income per critical
  strike, cooldown earned back per bleed tick, and a proc rolled against each of
  those ticks. What is left is named with its reason — a "next cast is free"
  register the fight does not carry, and four nodes that need a foe that hits
  back. The other three classes have the shared readers and have not been
  audited that way, so their exposure is under-reading rather than over-reading.

  **A node can depend on another node, and it says so in script.** Hold the Line
  is +6% damage *while Rage Shield is up*, and Rage Shield is a different branch
  you may not have taken. Four nodes across three trees have that shape and all
  four were being credited unconditionally; they are resolved against the
  allocation now, and a build that cannot arm one is told which one it is
  missing.
- **Resources: Rage yes, Spark no, ComboPoints halfway.** A resource is a second
  kind of cooldown — you wait for income instead of a timer — and for the
  Warrior both halves are authored. `MaxRage` is 20 and `NoAutoFill` says you
  start a fight at zero; `Warrior_Rage`'s script generates 1 from every attack,
  combo finisher and weapon skill (and explicitly *not* from a signature skill,
  so it cannot fund itself); `Warrior_InfiniteRage` adds 1 every 3s in combat
  from ordinary columns; `Warrior_Rage_Strike` spends 10. So it casts every ~7s
  on a real build, and it is worth **+14%** on the Warrior.

  The Mage and Rogue pools were unreadable from data and are now read from the
  bytecode: `Skill.getSparkCost` prices a weapon skill at
  `round(max(5, cooldown × 1.0))` Spark, refunded by Ray of Spark's authored
  18% of MaxSpark per cast, and `Rogue_ComboPoints` grants one point per
  distinct weapon skill or finisher with the signature spending all of them at
  +30% damage each. Both gates run in the fight now; what is still simplified
  is named in the audit (the finisher's own 10-Spark cost, the
  consecutive-same-skill dedup).
- **Coverage is reported by cause, not as one number.** The tool names every
  skill it could not score and groups them: `utility`, `rune`, `resource`,
  `no rate` (the amount is in the data, the schedule is not), `status`,
  `script magnitude`, `script`, and `nothing declared`. Five to eight per class,
  and each group says what would settle it.

  **A rune can turn any of them into something else, so the choice is printed.**
  A teleport is not inherently worth zero — `Rogue_Shadowstep` with *Combo Step*
  generates 2 ComboPoints, `Mage_Blink` with *Phase Strike* amplifies your next
  weapon skill, `Warrior_Charge` with *Juggernaut* generates 5 Rage. The search
  leaves those sockets empty precisely *because* it cannot price them, so the
  options are listed under the skill with their numbers filled in from the data:

  ```
  resource  gated by a pool nothing in this build declares readable income for
    Shadowstep (Rogue_Shadowstep)
      offers  Combo Step: Shadowstep generates 2 [ComboPoint].
    Death Mark (Rogue_DeathMark)
      offers  Surge of Energy: Death Mark instantly generates 5 [ComboPoint]s.
      offers  Domination: Reduces the damage the marked enemy deals to you by 20%.
  ```
- **A thin player model.** The fight is simulated, but the priority is derived —
  press the ready skill with the highest damage per second of commitment — not
  authored. There is no movement, no target switching, no interrupt, and the
  foe does not act, so crowd control and mitigation-through-avoidance are worth
  nothing here.
- **The model has been checked against the running game, extensively.** A
  naked level-25 character sheet reproduces to the decimal; two weapons were
  measured live on a 0-armor dummy (swings, crits, bleed ticks, charge
  timings) and every formula reproduces the displayed integers; six expanded
  tooltips render the weapon-skill mix the model implements; a character-sheet
  reading settled how aptitudes pay; and the composition order itself is now
  disassembled from `hlboot.dat` rather than assumed (`node bin/hl.mjs disasm
  4841`). See [docs/MODEL.md](docs/MODEL.md). What remains unmeasured is
  behavioral, not numeric — movement, target switching, a foe that acts — and
  the audit names it.

---

## Relation to farever-mods

`src/lib/pak.mjs` and `src/lib/game.mjs` are copied from
[farever-mods](https://github.com/Blaakan/farever-mods) — the `.pak` reader and
the Steam-library install finder — same MIT licence, copied rather than
depended on so this repo clones and runs on its own. `game.mjs`'s cache path is
the only change.

Everything else is new.

## Licence

MIT. Farever and its data are Shiro Games'; nothing from the game is
redistributed here.
