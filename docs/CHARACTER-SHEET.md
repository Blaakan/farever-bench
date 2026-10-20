# Character sheet v1 - `farever-character-sheet`

A character sheet is a Farever character written down as it stands: its class
and level, the gear it wears, the talents it spent, the skills it slotted, the
runes it chose, and what the game said about it. The bench reads one wherever
it needs a real build instead of a searched one:

- `bench import <file>` reads it and says what it kept, dropped and why - the
  exporter author's validation tool;
- `--import <file>` on every command that builds (`sheet`, `optimize`,
  `rank`, `verify`, `submit` and the rest) makes it the build that command
  works on (`bench sheet --import me.json`, `bench optimize --import me.json`,
  `bench verify --import me.json --capture fight.jsonl`). The commands that
  build nothing - `classes`, `slots`, `targets`, `talents`, `profiles`,
  `rarity`, `audit`, `ui`, `update` - refuse it;
- the UI's **Import** button loads it into the editor;
- a fight sent to the project carries the sheet it was fought with.

This page is the contract for whoever writes one - an in-game mod, a memory
reader, a converter. The bench does not ship an exporter for the game itself.

Ids are CastleDB row ids from the game's `data.cdb`, exactly as the game holds
them (`Daggers_Demondash`, `Rogue_DeathMark_M2`, `CritChanceRating`), never
display names. A display name joins nothing: the bench checks every id against
the install it runs on.

The machine-readable schema is [schema/character-sheet.v1.json](schema/character-sheet.v1.json)
(JSON Schema 2020-12). Two legal examples, both level-25 characters on build
25959898, are [examples/sheet-minimal.json](examples/sheet-minimal.json) - the
required keys and nothing else - and [examples/sheet-full.json](examples/sheet-full.json),
which uses every block. The bench's suite reads both on every run and fails if
either loses an id.

## The smallest sheet

```json
{
  "format": "farever-character-sheet",
  "version": 1,
  "character": { "class": "Warrior", "level": 25 },
  "gear": { "Slot_Weapon1": { "item": "GS_Nova" } }
}
```

It reads, and the bench names as a gap each thing it could not know: the
other fourteen slots; the greatsword's rolled rarity, its stars, its Flawless
flag and its sockets; the talents, the class skills, the runes and the
weapon-skill rank. All of them are *not recorded*. A search may fill each of
them, and a sheet that records them holds them.

## One rule for presence

The same rule holds for every key at every depth, and an exporter that follows
it can never make the bench price something it did not see:

| What the sheet has | What it means | What the bench does |
|---|---|---|
| the key is **absent** | not recorded | leaves that choice open (unpinned: a search may fill it) and names it as a gap |
| `null`, `[]` or `{}` | recorded as none or empty | holds it as none. A gear slot that is `null` is an empty slot, held empty |
| the path is listed in `unreadable` | the exporter tried and failed | reads it as absent, and names it as unreadable |

So an exporter that cannot read a piece's infusion **must not** write
`"infusion": null` - that says "not infused", and the bench will price the
piece without it. It leaves the key out, or better, lists
`"gear.Slot_Chest.infusion"` in `unreadable`. The difference is not cosmetic:
an unseen infusion read as "none" turns into a model error the moment the
sheet is held against a fight.

Two further rules:

- `x` - at the top level and inside any gear entry - is the exporter's own
  object. It is ignored: never read, never reported, and not written back
  (`bench import --json` and a submission's `sheet.json` leave it out).
- Any other key the bench does not know is **named** in the report (an unknown
  key), never dropped in silence. Non-combat slot keys (`Slot_Mount`,
  `Slot_Glider`, tools, bags, consumables) are named and ignored.

## The complete example, annotated

This is the whole of `examples/sheet-full.json`, a level-25 Rogue, key for
key. The comments are not JSON - the file itself has none - and the suite
checks that this block, with its comments taken out, is that file.

```jsonc
{
  "format": "farever-character-sheet",   // required, exactly this
  "version": 1,                          // required; a bench that reads 1 refuses 2
  "source": {                            // optional provenance, never priced
    "exporter": "example-exporter",
    "exporterVersion": "1.0.0",
    "writtenAt": "2026-10-19T12:00:00Z",
    "steamBuild": "25959898",            // buildid in steamapps/appmanifest_3672400.acf
    // sha256 of hlboot.dat - write it whenever the exporter can hash the file
    "bootSha256": "c7173926f28c2419dc71662012e8c8c30acf32b9e7b4dfa351482d9041d57cd4"
  },
  "character": { "name": "Example", "class": "Rogue", "level": 25 },
  "gear": {                              // all 15 combat slots, each an entry or null
    "Slot_Weapon1": {
      "item": "Daggers_Demondash",
      "level": 25,                       // the instance level, Gear.level
      "upgrade": 4,                      // stars, Gear.upgradeLevel; Epic allows 4
      "rarity": "Epic",                  // the ROLLED rarity - the row says Rare
      "flawless": false,
      "prismatic": false,
      "infusion": null,                  // recorded: not infused (a weapon never is)
      // one augment per socket type: the dagger has an AugmentDemon and an
      // AugmentEnchantWeapon socket, and each augment's own type places it
      "sockets": ["DemonGearUpgradeRare_MPToAP", "FormulaWeaponDevote"],
      "iLevel": 340                      // observed, Gear.getILevel(); checked, never priced
    },
    "Slot_Weapon2": {                    // the arsenal weapon; its picks are in weaponSkills
      "item": "Daggers_DuplicatePoison",
      "level": 25,
      "upgrade": 5,
      "rarity": "Legendary",
      "flawless": false,
      "prismatic": false,
      "infusion": null,
      "sockets": ["FormulaWeaponFlamingWeapon"],   // its AugmentDemon socket is recorded empty
      "iLevel": 370
    },
    "Slot_OffhandWeapon": null,          // recorded: empty (daggers allow no offhand)
    "Slot_Head": {
      "item": "Head_EDemon_AssCle", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["DemonSigil_Rogue_VenomousFinisher"]   // grants Rogue_Talent_VenomousFinisher, at no point
    },
    "Slot_Neck": {
      "item": "Necklace_Z2RCraft",
      "level": 0,                        // 0 = the row's own level (the game stores it on crafted pieces and jewellery)
      "upgrade": 0, "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["StrongCutAmber"]
    },
    "Slot_Shoulders": {
      "item": "Shoulders_EBee_Ass", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": []                      // recorded: the piece has no socket
    },
    "Slot_Chest": {
      "item": "Chest_EKobold_AssWiz", "level": 25, "upgrade": 0,
      "flawless": true,
      "prismatic": false,
      "infusion": "Infusion_Kobold_DPS",           // an InfusionPassive skill id
      "infusionStat": "CritChanceRating",          // the rating its bonus rolled
      "sockets": ["ReinforcedCopperPlate"],
      "iLevel": 310
    },
    "Slot_Back": {
      "item": "Back_EKobold_Ass", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["HonedEmbroidery"]
    },
    "Slot_Hands": {
      "item": "Hands_EDemon_AssWiz", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["FormulaHandsDexterity_Z2"]
    },
    "Slot_Waist": {
      "item": "Waist_EKobold_Ass", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": []
    },
    "Slot_Legs": {
      "item": "Legs_EKobold_AssWiz", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": []
    },
    "Slot_Feet": {
      "item": "Feet_EKobold_FigAss", "level": 25, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["FormulaFeetCritical_Z2"]
    },
    "Slot_FingerLeft": {
      "item": "Finger_Z3RCraft_Ap", "level": 0, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["StrongCutAmber"]
    },
    "Slot_Trinket": {
      "item": "Trinket_Kobold_E", "level": 0, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": []
    },
    "Slot_FingerRight": {
      "item": "Finger_Z3RCraft_Cri", "level": 0, "upgrade": 0,
      "flawless": false, "prismatic": false, "infusion": null,
      "sockets": ["ResonantCutAmber"]
    }
  },
  "talents": {                           // points SPENT, 16 in all; the sigil's node is not listed
    "Rogue_Talent_LethalPoison": 1,
    "Rogue_Talent_AcidicSplatter": 1,
    "Rogue_Talent_Envenom": 1,
    "Rogue_Talent_LethalDose": 2,
    "Rogue_Talent_ImprovedMixture": 2,
    "Rogue_Talent_DeadlyPoison": 2,
    "Rogue_Talent_NoxiousStrategem": 2,
    "Rogue_Talent_VenomInfusion": 1,
    "Rogue_Talent_BullyingTheWeak": 2,
    "Rogue_Talent_UpTheAnte": 1,
    "Rogue_Talent_VirulentMagic": 1
  },
  "weaponSkills": {                      // the arsenal's two picks, for the weapon in Slot_Weapon2
    "Slot_Weapon2": ["Daggers_DuplicatePoison_Skill1", "Daggers_DuplicatePoison_Passive"]
  },
  "classSkills": {                       // the game's bar, positional; null = an empty position
    "ClassSkill": ["Rogue_Shadowstep", "Rogue_DeathMark", "Rogue_KnivesTempest", "Rogue_UrgeToKill", null]
  },
  // rune ids as the game lists them; each one's host skill is found in data
  // (Momentum is a rune of Rogue_Shadowstep, Rogue_Finisher_M1 of Rogue_Sig_Finisher)
  "runes": ["Rogue_Finisher_M1", "Momentum", "Rogue_DeathMark_M2", "Rogue_KnivesTempest_M1", "Rogue_UrgeToKill_M3"],
  "weaponSkillRanks": {                  // every rankable skill of both worn weapons
    "Daggers_Demondash_Combo": 3,
    "Daggers_Demondash_Skill1": 3,
    "Daggers_Demondash_Skill2": 3,
    "Daggers_Demondash_Passive": 3,
    "Daggers_DuplicatePoison_ComboAttack": 3,   // the arsenal brings no combo: carried, not used
    "Daggers_DuplicatePoison_Skill1": 3,
    "Daggers_DuplicatePoison_Skill2": 3,        // not picked: carried, not used
    "Daggers_DuplicatePoison_Passive": 3
  },
  "buffs": [                             // printed and carried, not priced in v1
    {
      "id": "ItemStatus",                // the status many consumables share...
      "item": "ElixirOfMinorStrength",   // ...so the item that applied it is required
      "stacks": 1,
      "remaining": 1745.2                // seconds left
    }
  ],
  "stats": {                             // raw attribute values; printed, not compared in v1
    "Vitality": 214,                     // what this build holds, as the bench computes it
    "Strength": 44,                      // 41, plus the elixir's flat +3 (see "stats" below)
    "Dexterity": 166,
    "CritChance": 15.202235795182705,    // raw: a percent, unrounded
    "ArmorPenetration": 26.061343299391655
  },
  "unreadable": []                       // nothing failed
}
```

## Every key

`R` = required. "Absent" and "null" follow the rule above; this table says
what each means for that key.

### Top level

| Key | Type | R | Absent means | `null` means |
|---|---|---|---|---|
| `format` | `"farever-character-sheet"` | yes | not this format: the other shapes are tried (below) | - |
| `version` | integer, `1` | yes | read as 1, and named as a defect | named as a defect |
| `source` | object | no | no provenance | no provenance |
| `character` | object | yes | refused: no class, no level | refused |
| `gear` | object, slot id -> entry or `null` | yes | every slot not recorded, and named as a defect | named as a defect |
| `talents` | object, node id -> points | no | talents not recorded: the search chooses them | no point spent (held) |
| `weaponSkills` | object, slot or weapon id -> list | no | arsenal picks not recorded: the default picks stand, open to the search (a gap) | no picks - a pool cannot be held empty, so the default picks stand, open to the search (a note) |
| `classSkills` | object, skill type -> list | no | the class bars not recorded (a gap per bar) | no picks, as for `weaponSkills` (a note per bar) |
| `runes` | list of rune ids, or object host -> rune | no | runes not recorded: the search chooses them | no rune slotted (every rune slot held empty) |
| `weaponSkillRanks` | object, skill id -> rank | no | the bench's default rank (3, fully mastered) applies | every held skill at rank 1 |
| `buffs` | list | no | none observed | none active |
| `stats` | object, attribute id -> number | no | none observed | none observed |
| `unreadable` | list of dotted paths | no | nothing failed | nothing failed |
| `x` | object | no | - | - |

### `source`

| Key | Type | Meaning |
|---|---|---|
| `exporter` | string | the exporter's name |
| `exporterVersion` | string | its version |
| `writtenAt` | string | ISO-8601 time the sheet was written |
| `gameVersion` | string | the game's own version string |
| `steamBuild` | string of digits | the Steam build id the game ran as |
| `bootSha256` | 64 hex digits | sha256 of `hlboot.dat`. **Should** be written: it is the build identity the bench holds against its own install, and a mismatch is reported first, before the drops it may explain |

### `character`

| Key | Type | R | Meaning |
|---|---|---|---|
| `class` | string | yes | the **unit id** - `Warrior`, `Rogue`, `Mage`, `Priest`, what `ent.Unit.kind` holds - or the aptitude id - `Fighter`, `Assassin`, `Wizard`, `Cleric` - in any case. The bench always writes the unit id |
| `level` | integer | yes | 1 to the game's MaxLevel (25 on build 25959898) |
| `name` | string | no | the hero's name. Replaced by "Submitter" before an upload unless the player keeps it |

### `gear`

Keyed by these 15 combat slot ids:

`Slot_Weapon1` (main hand), `Slot_Weapon2` (arsenal), `Slot_OffhandWeapon`,
`Slot_Head`, `Slot_Neck`, `Slot_Shoulders`, `Slot_Chest`, `Slot_Back`,
`Slot_Hands`, `Slot_Waist`, `Slot_Legs`, `Slot_Feet`, `Slot_FingerLeft`,
`Slot_Trinket`, `Slot_FingerRight`.

A key without the `Slot_` prefix (`Weapon1`, `FingerLeft`) is read with a
note. Write all fifteen: a slot that is absent is not recorded, which is not
the same as empty.

### A gear entry

| Key | Type | R | Absent means | `null` means |
|---|---|---|---|---|
| `item` | item id | yes | - (an entry without one is dropped) | - |
| `level` | integer >= 1, or `0` | no | the row's own level | the row's own level |
| `upgrade` | integer >= 0 | no | not recorded: priced at 0 stars, named as a gap on a piece that takes stars | recorded: 0 stars |
| `rarity` | rarity id | on a weapon | weapon: not recorded, priced as the row's authored rarity, named as a gap | not a rarity: read as absent. The schema refuses it - write the id |
| `flawless` | boolean | no | not recorded: priced not Flawless, named as a gap | tolerated as absent, with a note |
| `prismatic` | boolean | no | not recorded: priced not Prismatic (a gap when the piece is infused) | tolerated as absent, with a note |
| `infusion` | InfusionPassive skill id | no | not recorded: left open, named as a gap on a piece that can carry one | not infused (held) |
| `infusionStat` | rating attribute id | no | not recorded: the bonus line is not priced (a gap when infused) | no bonus stat |
| `infusionBonusStat` | - | no | the game's own name for `infusionStat`, read as it with a note | - |
| `sockets` | list of augment item ids | no | not recorded: sockets left open, named as a gap | nothing socketed (held) |
| `iLevel` | number | no | not observed | not observed |
| `x` | object | no | - | - |

- **`level`** is the instance level (`Gear.level`), the level the copy
  dropped at - **not** its item level. The game stores `0` on crafted pieces
  and jewellery to mean "the row's own level"; write it as it is, the bench
  reads `0`, `null` and absent alike.
- **`rarity`**: only a weapon rolls one (`Weapon.rarity`); write it on every
  weapon, since the row's own (a dungeon dagger's Rare) is often not what the
  copy rolled (Epic). On armour, jewellery and the trinket it is optional, and
  when given it must be the row's own - a different one is dropped and named.
- **`upgrade`** above what the rarity allows (Uncommon 2, Rare 3, Epic 4,
  Legendary 5; weapons only) is clamped, with a note.
- **`infusion`** must be one of the 15 InfusionPassive ids the game's
  InfusionPattern items name, on a piece the game will infuse (armour of
  sufficient rarity that belongs to a faction). **`infusionStat`** must be one
  of the InfusionBonus ratings - `CritChanceRating`, `FervorRating`,
  `ArmorPenetrationRating`, `SpellPenetrationRating`; anything else is dropped.
  A rating outside the pool the bench computes for the piece is **kept** and
  flagged: a looted piece carries whatever the server rolled.
- **`sockets`** lists the augments in `Gear.slots`. Order and `null` entries
  mean nothing: no item has two sockets of one type, so each augment's own
  type places it. An augment the piece has no socket for, a second augment of
  one type, or a DemonSigil of another class is dropped and named.
- **`iLevel`** is what `Gear.getILevel()` returned. The bench computes the
  same piece's item level itself (base, rarity, stars, Flawless, socketed
  item levels) and names any disagreement. It is the cheapest check there is
  that the rarity, stars and level above were read right.

### `talents`

`{talent node id: points spent}`, as `HeroSpecialization.talents` holds them.
Nodes are skill ids of type Talent from the class's own tree; a node holds at
most 2 points, and the tree's tier thresholds apply. The bench allows up to 16
points from level 10 (`UnlockLevel_Talents`): 16 is the count at the level
cap, confirmed in game, and the levels in between are not modelled, so a
sheet below the cap is checked against the cap's allowance. The allocation is
checked **whole**: if it is not one the
game allows, the whole block is dropped with the reason, because pricing part
of a tree as if it were all of it misprices the rest.

A node a socketed DemonSigil grants costs no point. Leave it out; listed at 1
it is accepted and normalised away with a note. Sockets are placed before the
talents are checked.

### `weaponSkills`

The arsenal picks. Keyed by `Slot_Weapon2`, or by a weapon item id - which is
how `HeroSpecialization.arsenals` holds them, so a dump of that map is
accepted as is. The picks apply **only to the weapon worn in `Slot_Weapon2`**:

- the main hand and the offhand grant every skill they carry, so an entry
  keyed by the main-hand or offhand weapon's id is dormant (the game keeps an
  arsenal list for every weapon ever slotted) - ignored, with one note;
- entries for weapons not worn are ignored and counted in one note;
- when one item id is worn in both weapon slots, its item-keyed entry is the
  arsenal's;
- when a slot key and an item key both cover `Slot_Weapon2`, the slot key wins
  and the clash is named; two spellings of the slot key (`Slot_Weapon2` and
  `Weapon2`) keep the first and name the second;
- picks are checked against what the weapon offers (its WeaponSkills and its
  WeaponPassive) and cut to the number of arsenal slots at the character's
  level, each removal named.

`Slot_Weapon1` - the slot key, never the weapon's id - is the main hand's own
pick, and it matters only below the level at which the main hand holds every
skill it carries: the game's `UnlockLevel_WeaponSkillSlots` gives it one slot
at level 1 and two from level 2, and no weapon has more than two
WeaponSkills, so at level 1 it holds one of them and the list says which.
From level 2 a list naming every one of the hand's WeaponSkills is read for
its order only; any other list is named and not read, since the hand cannot
hold fewer. A level-1 sheet without it has a gap.

### `classSkills`

Keyed by the game's skill type id:

| Key | Game source | Notes |
|---|---|---|
| `ClassSkill` | `HeroSpecialization.skillSlots` | positional; `null` is an empty position. The game's bar has five positions and the bench slots four: a skill in the fifth position is dropped and named, so `bench import --check` fails on it. Write that position `null`, as the example does |
| `MageConduit` | `HeroSpecialization.conduits` | slot order; one conduit may appear more than once. A conduit a talent grants is an option once that talent is held |
| `PriestPrayer` | `HeroSpecialization.prayerSequence` | the prayer order |
| `RoguePoison` | - | reserved: no class has a poison pool on build 25959898, so it is named and ignored |

A pool is held only when its picks fill it; a partly filled bar is kept as it
is and left open to a search.

### `runes`

The slotted runes, recommended as the list `HeroSpecialization.skillMasteries`
holds - rune (mastery) ids. Each rune belongs to exactly one skill, and the
bench finds that skill in data. `{host skill id: rune id}` is accepted too.
A second rune on one skill is named (the first is kept), and a rune on a skill
the character has not learned, or that nothing worn grants, is dropped.
Learned but unslotted runes are not part of a sheet.

### `weaponSkillRanks`

Weapon mastery per skill: `{skill id: rank}`, the integer
`Progress.getWeaponSkillRank` returns (`{"rank": n}` is accepted too). Write
one entry for every rankable skill - types AttackCombo, WeaponSkill,
WeaponSubSkill and WeaponPassive - of every weapon worn. A held skill missing
from the map reads **rank 1**, which is the game's own default for a skill
never levelled. The ranks of skills the build does not hold (the arsenal's
combo, an arsenal skill not picked) are carried and not used, with one note:
the example lists all eight of its two daggers' rankable skills, and two of
them are such.

The bench prices one rank for every skill. Only the skills the build holds
count: the main hand's and the offhand's, and the arsenal's picks. When they
agree, that is the rank. When they differ, the rank is the main hand's (if its
skills agree among themselves, else the highest) and a warning names every
skill priced above its real rank.

### `buffs`

| Key | Type | R | Meaning |
|---|---|---|---|
| `id` | skill id | yes | the status's own skill row id (`status.inf.id`), not a status *type* |
| `item` | item id | **yes when `id` is `ItemStatus`** | the item that applied it. One status can be shared by many items - on build 25959898, 48 items (the stat elixirs and potions among them) apply `ItemStatus` - and then only the item says which it was. The schema requires it on `ItemStatus`; write it for any other status whenever it is known |
| `stacks` | number | no | stacks held |
| `remaining` | number | no | seconds left; `-1` for a status with no end |

Printed (one line in the report) and carried; not priced in v1. A shared
status without its `item` is read with a note saying which it cannot tell.

### `stats`

`{attribute id: value}`, the raw unrounded value the game holds for each
attribute - never the character panel's text, which rounds and formats.
Printed (one line in the report: the count, and the first few by name) and
carried; not compared in v1.

The example's five values are what that build holds: `bench sheet --import
docs/examples/sheet-full.json` computes Vitality 214, Strength 41, Dexterity 166,
CritChance 15.202... and ArmorPenetration 26.061..., and Strength is written
as 44 because the elixir the sheet lists carries a flat +3 Strength on its
row, which the game holds while the buff runs and the bench, which does not
price buffs in v1, leaves out. They are the bench's numbers, not a capture's:
do not test an exporter against them.

### `unreadable`

Dotted paths: `character.name`, `gear`, `gear.<slot>`,
`gear.<slot>.<entry key>`, and `talents`, `weaponSkills`, `classSkills`,
`classSkills.<type>`, `runes`, `weaponSkillRanks`, `buffs`, `stats`. A path
into a block (`talents.Rogue_Talent_Envenom`) makes the whole block
unreadable - half a tree is not a tree. `classSkills` is read bar by bar, so
a path into one bar (`classSkills.ClassSkill.2`, one position) makes that bar
unreadable and leaves the others; a type that is not one of the four is a
path to nothing, and is dropped like any other.

## Where the client holds each field

As of build 25959898, from the game's own class names. Read statically from
the game's compiled code; marked where nothing has confirmed it.

| Field | Client source | Status |
|---|---|---|
| `character.name` | the hero's name on `ent.Hero` | not verified |
| `character.class` | `ent.Unit.kind` (replicated) | verified |
| `character.level` | `ent.Unit._level` (replicated). `HeroData` is server-only on the client | verified |
| `gear` | `loadout.equipment.getSlot(<slot id>)` for each of the 15 slot ids (`Equipment.getSlot`) | method verified; the path to the equipment object not verified |
| `level`, `upgrade` | `Gear.level`, `Gear.upgradeLevel` | verified |
| `sockets` | `Gear.slots` (augment item ids) | verified |
| `infusion`, `infusionStat` | `Gear.infusion`, `Gear.infusionBonusStat` | fields verified; no live value seen yet |
| `rarity` | `Weapon.rarity` (a String) | verified |
| `flawless`, `prismatic` | `Item.flags`: bit 0 Flawless, bit 1 Prismatic | verified |
| `iLevel` | `Gear.getILevel()` | method verified |
| `talents` | `HeroSpecialization.talents` (node id -> points) | verified |
| `weaponSkills` | `HeroSpecialization.arsenals` (weapon item id -> skill ids) | verified |
| `classSkills.ClassSkill` | `HeroSpecialization.skillSlots` | field verified; element type not verified |
| `classSkills.MageConduit` | `HeroSpecialization.conduits` | field verified; element type not verified |
| `classSkills.PriestPrayer` | `HeroSpecialization.prayerSequence` | field verified; element type not verified |
| `runes` | `HeroSpecialization.skillMasteries` (rune ids) | verified |
| `weaponSkillRanks` | `Player.progress.getWeaponSkillRank(<skill id>)`; 1 when the skill has no entry | verified |
| `buffs` | the hero's statuses: `id` = `status.inf.id`, `remaining` = `getDurationLeft()` | not verified (as the Wink DPS Meter reads them) |
| `stats` | `UnitAttributes`, keyed by attribute position in the attribute sheet - convert the position to the attribute id | not verified that every attribute is held there |
| `source.gameVersion` | `Config.getVersion()` | verified |
| `source.steamBuild` | `buildid` in `steamapps/appmanifest_3672400.acf` | verified |
| `source.bootSha256` | sha256 of `hlboot.dat` in the game folder | - |

## Other shapes the bench reads

The same reader, with the same checks, takes three other files; each is
recognised by its keys:

| Shape | Recognised by | Notes |
|---|---|---|
| a build the bench saved | a `build` object | what `bench optimize --json` and the UI's "Save build (.json)" write. The build is read with the same checks; the pins of the run that wrote it are kept - each only while the value it held came through unchanged, so a dropped sigil does not become a socket held empty - and its settings (goal, target, rank...) are handed back to the command |
| a bare bench loadout | a top-level `class` | `{class, level, gear, augments, skills, runes, talents}`, as `--build` reads it. Every field a loadout carries is recorded; runes keyed by their own id (the dump's old keying) are re-keyed by their host |
| a modkit inventory dump | an `equipped` list | `farever-inventory-<Name>.json`. It names no class, so one has to be given (`--class`, or the class picked in the UI): the refusal names the classes every weapon it lists fits, and carries them as data (`needs: "class"`, `classes`, `character`) for a front end to offer. On the command line, beside a combat log of the same character (`bench verify --capture`, `bench submit --log`), the class the log names is taken, and said; the app's Send a fight dialog offers it first. A dump that lists nothing equipped - written before a character loaded - describes no build and is refused. It holds no level, so the level is taken from the highest equipped item unless one is given (`--level`), and said. Placement follows the dump's own order, and a combat slot the dump leaves out is empty - except a slot an entry the bench could not place (an id this install does not have, a piece the class cannot use) may have filled, which is left open and named. Sockets, talents, picks, runes and ranks are not in it, and are gaps |

Whatever the shape, the result is the same: a loadout, what is held fixed,
and the report.

## Validating a sheet

```
bench import my-sheet.json            # what was read, kept, dropped and why
bench import my-sheet.json --check    # the same, and exit 1 if anything was
                                      # dropped, unknown or unreadable
bench import my-sheet.json --json out.json
                                      # the sheet as the bench normalised it, plus the report
```

`--json` writes `{kind: "sheet", sourceFormat, sheet, report}`: under
`sheet`, the version-1 sheet of what the file recorded, as the bench read it
(what the file left out stays out), and `report` the drops, notes, gaps,
unknown keys and unreadable blocks beside it. The file is itself read back
by `bench import` and `--import`, as the sheet under its `sheet` key.

`--check` is the one to put in an exporter's own tests. Against
[schema/character-sheet.v1.json](schema/character-sheet.v1.json) a sheet can
be checked for shape without the game installed; `bench import` checks every
id against the install, which the schema cannot.

The bench refuses a file - with one sentence, and nothing else read - only
when it is not JSON, is none of the four shapes, is a newer version than the
bench reads, names no class or one that is not a class, gives no level or
one that is not a level from 1 to MaxLevel, or is a modkit dump with nothing
equipped. A combat log given where a build goes is refused as one, and the
sentence says where it goes instead (the fight: `bench verify --capture`,
`bench submit --log`, "Send a fight"). Everything else is kept, or
dropped with the reason. What it drops, it drops by the game's own rules:

- an item the install does not have, one in a slot it does not fit, one the
  class cannot use, or one above the character's level;
- a rarity on gear that is not the row's own;
- an infusion no InfusionPattern names, or on a piece the game will not
  infuse; a bonus stat that is not one of the InfusionBonus ratings;
- an augment its host has no socket for, a second of one socket type, a
  DemonSigil of another class;
- an offhand under a two-handed main hand;
- a talent allocation the tree does not allow (the whole block);
- picks the pool does not offer, repeats, picks past the slot count, and a
  second key for one weapon slot;
- a rune with no host, a rune whose host offers no slot, a second rune on one
  host.

## Versioning

- `version` is a whole number. This bench reads `1`. A sheet with a higher
  version is refused with a sentence saying to update the bench - `"2"` and
  `1.5` count as higher too. Any other version that is not the number `1` -
  missing, `0`, `"1"`, text - is read as 1 and named as a defect.
- Within version 1, keys are only ever **added**, and only as optional keys.
  An older bench names a key it does not know and reads everything else.
- Renaming or removing a key, or changing what a value means, is a new
  version.
- Data of an exporter's own goes under `x`, which no version will claim. The
  bench ignores it and does not write it back.

## What version 1 does not carry

- cosmetic and gathering slots: mount, glider, pickaxe, sickle, job tool;
  bags and their contents; consumables on the bar;
- runes learned but not slotted, and a second rune per skill (the game's data
  plans one from level 50; the cap is 25);
- the main-hand weapon's arsenal pick list (dormant), picks for unworn
  weapons, and the main hand's own picks from level 2 (it holds every skill);
- per-skill weapon ranks as such: the bench prices one rank;
- the companion pet;
- per-infusion piece counts (`Hero.infusionStacks`) - the bench counts them
  from the gear;
- buffs and stats are carried and printed (one line each), but neither is
  priced nor compared in v1.
