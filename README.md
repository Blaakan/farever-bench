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
upgrade stars: max for rarity   weapon-skill rank: 3   rarities: all
pinned: Weapon1   sockets: Weapon1/EnchantWeapon, Weapon1/Demon

SLOT           ITEM                                     RAR        UPG    iLVL  FACTION  GIVES
Weapon1        Beefury, Blessed Blade of the Farseeker  Legendary  *****   200  Bee      SpellPenetration  pinned
Weapon2        Amon Ram, the Creator                    Legendary  *****   300  Crimson  Fervor
OffhandWeapon  (empty)
Head           Vision of the Beekeeper                  Rare               260  Bee      SpellPenetration
...

AUGMENTS
SLOT           SOCKET         AUGMENT               EFFECT
Weapon1        EnchantWeapon  (none)                                          pinned
Weapon1        Demon          (none)                                          pinned
Head           DemonSigil     Sigil of Bet'Hatesht  a free tier-4 talent this model cannot score
Feet           EnchantFeet    Magic Formula: Fervor  +15 FervorRtg
Neck           Jeweller       Cursed Eye of Vice     +9 CritChanceRtg +9 FervorRtg ...

METRIC                    VALUE
damage / s                195.8  <- goal
time on cooldowns          11.9%  88.0% swinging, 0.1% idle
fight                      200s  one 200s fight, procs at their expected rate
```

Every number comes with the target it was computed against, the fight it was
computed over, the rotation that produced it, and a list of the assumptions
still in the model.

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
| `audit` | every assumption and gap in the model |

### The fight

Throughput is a **simulated fight**, not a steady state. Banked charges are
spent, statuses tick and expire, and the base-attack chain fills what is left.

The fight **holds state**: buffs and debuffs land, change what the next cast is
worth, and expire. Without that, stripping a quarter of the target's armour and
then nuking it is worth exactly the same as nuking it first — and a buff window
is worth the same whether you burst inside it or outside it.

```bash
--fight 200      # how long the fight is (default 200s, what a meter reports)
--fights 50      # roll the procs for real and report the mean and the spread
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
kept**, and the output says which won. On this game's actual numbers sequencing
is worth 0–0.4% — the player-facing debuffs are mostly movement slows.

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
node test/run.mjs                  # 344 checks against your own game data
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
   filenames and per-opcode line numbers across 47342 functions. So the
   composition rules were read out of the compiled game rather than guessed.

Four formulas carry the whole model. All four were read from the bytecode, and
each is cited to its function index and source line in
[docs/MODEL.md](docs/MODEL.md):

```
budget(L, min, max) = min * (max/min)^((L-1)/(EarlyMaxLevel-1))     one curve, everything
rating contribution = (rating / budget(L, min, max)) * target        `scale` is NOT read
armor budget        = red * (385 + 100L) / (1 - red)                 authored columns are dead
attribute           = (stored + scaling + flat) * modAdd * modMul
```

Four consequences worth knowing as a player, none of them visible in game:

- **Rating is linear, and it depreciates.** At level 25 one point of
  CritChanceRating is +0.0527 percentage points of crit, and every point loses
  **3.8% of its value per character level you gain**.
- **Faction decides your secondary stat.** The same Manfish chest gives a
  Priest Fervor and a Warrior ArmorPenetration, out of one data row. Gear with
  no faction has no secondary stat at all.
- **An item naming two aptitudes is naming who may wear it**, not paying twice.
  Its *tooltip* shows both readings — which is why a Kobold spear lists +39
  Critical and +39 Armor Penetration at once — but you receive your own half.
  The proof is in the budget: summed over one item per slot, `itemType.atbRatio`
  comes to exactly 1.0 in every stat group, so a full set is one aptitude curve.
- **Only weapons can be upgraded.** The game's own window text says so, and the
  twenty `<WeaponType>_Upgrade` skills exist for weapon types only. Reading the
  per-rarity `gearUpgrades` column alone put three stars on every armour piece.

---

## What it does not do

Stated plainly, because a tool that hides its gaps is worse than no tool. `bench
audit` prints this list with every result.

- **No absolute DPS claim.** The composition order inside
  `ent.Unit.applyDamage` is not yet disassembled, and three multipliers are
  modelled from their descriptions rather than from code: Fervor's offensive
  half, the two Masteries, and `WeaponPower`. Toggle the first two off with
  `--no-fervor-damage` and `--no-mastery` and watch the answer move — that is
  how much it depends on them.
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
  and validated against the real rules, but 63 of the 88 nodes and 53 of the 84
  runes declare nothing a data-driven model can read. `bench talents` counts
  what is readable, live. A Demon sigil grants a tier-4 talent outright; the
  search takes one because free beats empty, and says the pick is not scoreable.
- **Resources: Rage yes, Spark no, ComboPoints halfway.** A resource is a second
  kind of cooldown — you wait for income instead of a timer — and for the
  Warrior both halves are authored. `MaxRage` is 20 and `NoAutoFill` says you
  start a fight at zero; `Warrior_Rage`'s script generates 1 from every attack,
  combo finisher and weapon skill (and explicitly *not* from a signature skill,
  so it cannot fund itself); `Warrior_InfiniteRage` adds 1 every 3s in combat
  from ordinary columns; `Warrior_Rage_Strike` spends 10. So it casts every ~7s
  on a real build, and it is worth **+14%** on the Warrior.

  The Mage is genuinely blocked: `getSparkCost()` is a compiled method and no
  Mage skill declares a cost in any column, so income without a readable spend
  buys nothing. ComboPoints are in between — the cap is authored but
  `Rogue_ComboPoints` awards through a local inside a helper and the finisher
  spends `-getCp()`, so neither end is a number to read. A skill gated by a pool
  nothing declares readable income for is still reported unscored rather than
  treated as spammable.
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
- **Almost nothing has been checked against the running game.** One item has:
  , main-hand and arsenal, all ten values reproduced exactly.
  That one reading corrected two things the static model had wrong — every
  aptitude on an item pays and they sum, and each share is rounded before the
  sum — and confirmed the arsenal factor as  rather than a half.
  See [docs/MODEL.md section 12](docs/MODEL.md#12-checked-against-the-game).
  Everything else is still "the bytecode says X", which is not the same claim as
  "the process does X".

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
