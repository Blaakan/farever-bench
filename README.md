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
Priest 25 - maximising dps vs reference (Armor_ExpectedReduction 0.25)
upgrade stars: max for rarity   weapon-skill rank: 3   rarities: all
pinned: Weapon1   sockets: Weapon1/EnchantWeapon, Weapon1/Demon

SLOT           ITEM                                     RAR   UPG  iLVL  FACTION  GIVES
Weapon1        Beefury, Blessed Blade of the Farseeker  Rare  ***   140  Bee      SpellPenetration  pinned
Weapon2        Censer of Wool Hollow                    Rare  ***   180  Crimson  Fervor
OffhandWeapon  (empty)
Head           High-Ranking Official's Hat              Rare  ***   290  Crimson  Fervor
...

AUGMENTS
SLOT           SOCKET         AUGMENT               EFFECT
Weapon1        EnchantWeapon  (none)                                          pinned
Weapon1        Demon          (none)                                          pinned
Feet           EnchantFeet    Magic Formula: Fervor  +15 FervorRtg
Neck           Jeweller       Cursed Eye of Vice     +9 CritChanceRtg +9 FervorRtg ...
```

Every number comes with the target it was computed against, the rotation that
produced it, and a list of the assumptions still in the model.

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
| `audit` | every assumption and gap in the model |

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
node test/run.mjs                  # 233 checks against your own game data
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

Two consequences worth knowing as a player, neither visible in game:

- **Rating is linear, and it depreciates.** At level 25 one point of
  CritChanceRating is +0.0527 percentage points of crit, and every point loses
  **3.8% of its value per character level you gain**.
- **Faction decides your secondary stat.** The same Manfish chest gives a
  Priest Fervor and a Warrior ArmorPenetration, out of one data row. Gear with
  no faction has no secondary stat at all — and an item naming two aptitudes
  gets *both* readings, which is how one Kobold spear grants +39 Critical and
  +39 Armor Penetration at once.

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
- **Partial skill scripts.** 427 of 962 skills carry hscript bodies this build
  does not execute. Two things are read out of them because the data records
  them nowhere else: the proc rate (`vars.chance`) and the self-buff a skill
  applies (`addStatus(owner, Skill.X)`, which is how a weapon enchant is worth
  anything). Everything else in a script — damage over time, conditional riders,
  resource generation — is absent, and every skill it costs is **named** in the
  output rather than silently dropped.
- **No talents or runes.** The 22-node trees are not modelled, and steps gated on
  `cond.mastery` are excluded. A Demon sigil grants a talent outright, so those
  sockets report *not scoreable* rather than *empty*.
- **No resource tracking.** Rage, Spark, ComboPoints and prayer charges live in
  scripts. A skill gated by one — `Warrior_Rage_Strike` — is reported unmodelled
  instead of being treated as spammable.
- **No player model.** The rotation is "cooldowns on cooldown, base-attack chain
  in the gaps, procs off the measured attack rate". Occupancy is estimated from
  each skill's step timings, not measured. If cooldowns oversubscribe the clock
  they are scaled to fit and the output says so.
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
