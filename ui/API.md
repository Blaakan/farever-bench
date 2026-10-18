# farever-bench UI — server API contract

The HTTP contract between `ui/server.mjs`+`ui/api.mjs` (backend) and `ui/web/*`
(frontend). Everything is JSON over `http://127.0.0.1:<port>`. This file is the
single source of truth — if an implementation disagrees with it, fix one or the
other, never silently diverge.

Engine facts referenced here were re-read against the September 30 update
(Steam build 25782799, cdb 58a792af, hlboot 5f288029); see the pitfalls at the
bottom. The sample values in the JSON blocks are illustrations of the shape,
not pins — `ui/lib/check-api.mjs` holds the assertions.

## Conventions

- Attribute/skill/item ids are the CDB row ids (`Staff_Censer`, `CritChance`).
- Every icon is either
  - `{kind:'tile', file:'UI/icons/…png', px:[x,y,w,h]}` — a real PNG served raw
    at `GET /asset/<file>`; the client crops with CSS background-position
    (px rect already multiplied out: x*size, y*size, (width??1)*size, …), or
  - `{kind:'dds', url:'/icon/dds/<b64 of pak path>.png?…'}` — a BC7 DDS
    decoded server-side, cached, served as ONE PNG PER ICON. The query is the
    server's and the client never builds it: `?px=64` when the gfx cell is the
    whole texture (a portrait; `px` picks the smallest mip ≥ that size), and
    `?rect=x,y,w,h` when the cell is one tile of a DDS *sheet* — since the
    September 30 update the 96px skill atlases and the 28px stats strip are
    BC7, and without the rect every skill icon was its whole 960px sheet.
  The server chooses per gfx row (sniffing is done once server-side).
- Colors are `'#rrggbb'` strings.
- All POST bodies and responses are JSON; errors are
  `{error: "human sentence"}` with status 400 (bad input) or 500 (bug).
  Bad input is refused, not repaired into a number: a loadout with no
  `level`, a gear `level` that is not a number, an unknown `goal`, an
  `exclude` that is not a regex, a non-integer `rank`, an `infusions` option
  naming an infusion that does not exist, an `infusionStat` that is not a
  bonus rating — the option's, or a gear entry's — a gear `infusion` /
  `infusionStat` that is not an id, a `prismatic` that is not a boolean and
  an `includeUnreleased` that is not a boolean are each a
  400 with the sentence. So are the numbers a fight is built from, on every
  route that takes `options` (`/api/sheet`, `/api/tooltip/skill`,
  `/api/optimize/start`): `targetLevel` is a positive number or null,
  `targets` a whole number of enemies from 1, `rank` a whole number from 0,
  `lookahead` a number of seconds from 0, `mix` a number from 0 to 1 — a
  string, a NaN or a value outside the range is refused as
  `options.<name> must be …, not <what was sent>`. `GET /api/catalog` with no
  `class` is `class is required - one of …`. Two things ARE repaired, because a saved build can
  carry them: `stars` clamps into `0..maxStars`, and a `rarity` on anything
  but a weapon is dropped (pitfall 13).
- A build the GAME would refuse is neither: it is answered `200
  { "illegal": "sentence" }` by the routes that evaluate one (a two-hander
  with a filled off hand; an infusion that is not one, or on a piece that
  cannot carry it), and a 400 by `/api/optimize/start`, which has no sheet to
  put the sentence on.

## GET /api/bootstrap

Static-per-session data, fetched once at startup.

```jsonc
{
  "meta": { "version": "0.1.0", "cdbSha": "…", "bootSha": "…", "game": "E:\\…",
            // null when no fingerprint is committed (model/fingerprint.json)
            "accepted": null | { "at": "2026-08-11T…", "cdbSame": false,
                                 "bootSame": false, "same": false },
            // the CLI's own sentence, word for word, when this install is not
            // the build the model was accepted on; null when it is. The page
            // shows it as a strip for the whole session and `bench ui` prints
            // it under its banner.
            "notice": null | "this install is not the build the model was accepted on (2026-08-11) - run bench update" },
  "classes": [ { "unit": "Mage", "aptitude": "Wizard", "name": "Mage",
                 "color": "#48b0c5", "icon": {…}, "flagIcon": {…},
                 "armorReduction": 0.25 } ],
  "rarities": [ { "id": "Common", "name": "Common", "color": "#e1e1e1",
                  "iLevelBonus": 0, "stars": 0 } ],   // in ladder order
  "attributes": { "CritChance": { "name": "Critical Chance", "color": "#…",
                  "icon": {…}, "percent": true, "rating": false, "desc": "…" } },
  "slots": [ { "id": "Slot_Head", "short": "Head", "column": "left"|"right",
               "label": "Head", "emptyIcon": {…}, "sockets": ["AugmentDemonSigil"] } ],
               // 12 doll slots in visual order + Weapon1/Weapon2/OffhandWeapon
  "targets": [ { "id": "boss", "label": "named boss (Ulserous…)" }, … ],
  "goals": ["dps","hps","sps","ehp","mixed"],
  "talents": { "Mage": {
      "root": "Mage_Talent_Chaincast",
      "thresholds": [0,1,2,4,8],          // per tier, root included
      "displayCost": [0,0,1,3,7],         // what the game prints per row (t2..t4)
      "unlockLevel": 10,
      "nodes": [ { "id": "Mage_Talent_Chaincast", "name": "Chaincast",
                   "tier": 0, "branch": "Root", "branchIndex": 0,
                   "maxPoints": 1, "icon": {…}, "desc": "filled desc",
                   "readable": true, "kind": "grants a skill" } ] } },
  // talent/rune `desc` are filled at rank 1. Bootstrap is class-wide and has
  // no build, so a magnitude token there reads as the AUTHORED coefficient
  // ("35% Dexterity"), not as a number and not as "?" — see
  // POST /api/tooltip/skill for the priced form.
  "runes": { "Warrior_Charge": {
      "skillName": "Charge", "skillIcon": {…},
      "options": [ { "id": "Warrior_Charge_M1", "name": "Double Up",
                     "desc": "Charge has 2 charges.",   // ::templates:: filled
                     "icon": {…}, "readable": true } ] } },
  "augments": { "AugmentJeweller": [ { "id": "StrongCutAmber", "name": "…",
      "icon": {…}, "rarity": "Rare", "effect": "+2 Vitality",
      "classGate": null | "Mage",
      "grants": null | { "id": "Mage_Talent_HighVoltage", "name": "High Voltage" },
      "acquire": "…" } ] },
  // every infusion of this build of the game ([] when it has none)
  "infusions": [ { "id": "Infusion_Bee_DPS", "name": "Hive Venom", "icon": {…},
      "faction": "Bee", "factionName": "Apix",       // the PATTERN's faction
      "pattern": "InfusionPattern_Bee_DPS",
      "source": { "state": "live"|"unreleased"|"unknown",
                  "why": "Gatsbee drops it on Heroic" },
      "obtainable": true } ],
  "constants": { "maxLevel": 25, "talentPointsAtCap": 16,
      // null on a build with no Infusion system
      "infusion": { "caps": [2, 4, 6], "minRarity": "Epic",
          "stats": [ { "id": "CritChanceRating", "name": "Critical" }, … ],
          "texts": { "header": "Infusions", "prismatic": "Prismatic" } } }
}
```

An **infusion** is a set passive learned from a pattern item and worn on
armour. `infusions` is the catalog's list — one entry per `InfusionPattern`
item, keyed by the skill the pattern names — and `source` is what the install
itself says hands the PATTERN out: the catalog's source reader
(`src/sources.mjs`) searched the cdb, every level file and the compiled code,
and `why` is its sentence, verbatim. `obtainable` is `state !== "unreleased"`,
which is the optimizer's own default: an infusion is offered unless it is
SHOWN to be unobtainable, so one whose source could not be judged
(`"unknown"`) is offered. On this build 11 of 15 are obtainable; the four that
are not drop only from Heroic bosses whose Heroic the client refuses to open.
`faction` is the pattern item's — the faction whose pieces the infusion
lights the bonus line of — and `factionName` is the name the `faction` row
prints: `Bee` is "Apix", and the three `Infusion_Nightling_*` are of faction
`Demon`, "Nightlings". An id is never the name. The set ladder of one
infusion is its `/api/tooltip/skill`.

`constants.infusion.caps` are the piece counts a set's ranks start at
(`Item_InfusionCaps`), `minRarity` the rarity a piece must at least be to
carry an infusion (`Item_InfusionMinRarity`), `stats` the ratings a piece's
bonus line can roll (the rows of the `InfusionBonus` aptitude), and `texts`
the game's own words for the list's header and for the item flag that lights
a bonus whatever the faction.

An augment's `effect` is its stat line when it has one. When it has none it is
what the game prints for the item: its `texts.desc` filled against the ONE
skill it carries, or that skill's own description — so the five weapon
formulas describe their enchant and each sigil reads "Grants the talent
<name>." All twelve sigils share one name ("Sigil of Bet'Hatesht"), so the
talent cannot be guessed from the row: `grants` names the node of the
`classGate` class's tree the sigil's skill is (null for every other augment),
and the client reads that, never the strings.

## GET /api/catalog?class=Mage&level=25

Per-slot candidate lists for the picker (recomputed when class/level changes).

```jsonc
{
  "slots": {
    "Slot_Weapon1": [ {
      "id": "Staff_Censer", "name": "Censer of Wool Hollow",
      "type": "Staff", "typeName": "Staff", "hands": "LongWeapon",
      "allowsOffhand": false,          // mainhand candidates only
      "level": 14, "faction": "Crimson", "factionName": "Crimson Rams",
      "levelScales": true,             // its effective level tracks the char
      "levelRange": [14, 25],          // [authored, charLevel] when it scales
      "aptitudes": ["Wizard","Cleric"], "gives": "CritChance+Fervor",
      "icon": {…},
      "rarities": [ { "id": "Rare", "authored": true, "chance": 0.5,
                      "maxStars": 3 }, { "id": "Epic", "chance": 0.19,
                      "maxStars": 4 }, … ],
      "skills": [ { "id": "Staff_Censer_Skill1", "name": "…", "icon": {…} } ],
      "acquire": "Drops from …" | null,
      "track": [ { "label": "…", "x":1, "y":2, "z":3 } ],
      "flavor": "…",
      // what the install says hands the row out (see below)
      "source": { "state": "live"|"unknown"|"unreleased", "why": "…" },
      // whether the game lets the row carry an infusion (see below)
      "infusable": false,
      "notInfusable": null | "Censer of Wool Hollow (Staff_Censer) is a Staff, and only armour - … - can be infused",
      "infusionFaction": null | { "id": "Bee", "name": "Apix" },
      "infusionPool": [ { "stat": "CritChanceRating", "name": "Critical" } ] } ],
    "…": []
  },
  // the rows this class and level are NOT offered, per slot, each a full row
  // plus the reason (see below); a slot with none is absent
  "withheld": {
    "Slot_Chest": [ { …a row…,
        "withheld": { "kind": "unreleased"|"level", "floor": null | 25,
                      "why": "nothing in this install hands it out - loot table Phrixes_HM: no unit, item, loot table, level file, script or compiled function in this install names it" } } ]
  },
  "withheldNote": null | "<which store could not be read>, so no row could be shown to be unobtainable"
}
```

Weapon2 (arsenal) lists mainhands + offhands; OffhandWeapon lists shields.
The client enforces: OffhandWeapon enabled only when
`mainhand.hands === 'OHWeapon'` (server also validates on sheet/optimize).

`rarities` is a spread **for weapons only**. The drop rolls a rarity for a
Weapon and for nothing else (pitfall 13), so every other row — armour,
jewellery, trinkets — comes back with exactly one entry,
`{ "id": <the row's rarity>, "authored": true, "chance": null, "maxStars": n }`.
`chance` is null there because nothing rolled; the picker prints the
percentage only when it is a number and shows its "weapons roll rarity" hint
only when there is more than one entry.

Each slot's list is ordered best first: by the level the row is priced at
when the loadout names no instance level, then by its authored rarity, then
by its authored `level`, then by name. That default level is one END of
`levelRange`, and which end is `levelScales`: the top (`levelRange[1]`, your
level) for a row that scales, the bottom (`levelRange[0]`, its own) for one
that does not — a level-6 Uncommon necklace has a band up to your level but
is priced at 6 until the player says what theirs dropped at, so it lists
below the crafted level-20 Rare one. `level` is the level the ROW authors and
is `null` for a row that authors none: the faction armour and trinkets, and a
few rows that are not drops at all (a crafted trinket, three rows whose
`acquire` reads "Starting outfit" or "Base clothing"). Print "at your level"
for those — never the null, and never "drops": how a row is come by is
`acquire`.

`levelScales` is `cat.effectiveLevel`'s own branch, measured rather than
restated: weapons and the eight worn-armour types take a drop at YOUR level
(true), jewellery and trinkets keep the level their row authors (false). It
is measured per item TYPE, so a crafted helmet says true like any helmet even
though a piece you make never scales — its one-level `levelRange` is what
says so, and both ends of it are the same.

`levelRange` is the `[min, max]` the picker's level
control offers: `[item.level, item.level]` for a CRAFTED row (you make it, so
nothing rolls it), `[item.level, charLevel]` for every other row that authors
a level — one that scales tracks you, and one that does not is a drop whose
own level is only the floor of the band it can drop in — and
`[charLevel, charLevel]` for the rows that author no level at all, which are
priced at your level either way. `null` only if no level can be derived at
all. The bottom of the band is never below the level every source of the row
makes it at (`cat.minInstanceLevel`, which the sheet floors the price at
too): the Demon Epic armour authors `level: 1` and is made only at the level
cap, so its range is `[25, 25]`, not `[1, 25]`.

### Where a row comes from, and what is withheld

`source` is the catalog's source reader's answer for the row
(`cat.release`): what in THIS install hands the item out — a loot table a
unit, a container or a level file points at, a merchant's shop list, a
recipe, a flag the drop code reads — with the reader's own sentence in `why`
("Gatsbee drops it on Heroic"; "loot table HM_DemonGear (Chaotic Gear
Cache)"; "a recipe makes it"). `acquire` is the atlas TSV's hand-kept line
and predates the September 30 update — none of the Epic armour has one — so a
client prints `acquire ?? source.why`. `state` is `live` (an open source
exists), `unknown` (a source could not be judged — the row is still offered,
and `why` says what could not be judged) or `unreleased` (nothing hands it
out).

`slots` lists what the character is OFFERED, which is `cat.candidates`' list
and therefore the optimizer's too. Two kinds of row are left out of it, and
each comes back in `withheld` instead — the same row shape, plus
`withheld: { kind, floor, why }`:

| `kind` | the test (the catalog's) | `why` |
|---|---|---|
| `unreleased` | `cat.release(item).state === "unreleased"` — nothing in the install hands the row out | "nothing in this install hands it out - " + the reader's sentence |
| `level` | `cat.minInstanceLevel(item) > level` — every open source makes the row above the character | "a copy of it only exists at level N - every source of it makes it there (" + the reader's sentence + ")"; `floor` is N |

On this build that is 26 Epic rows whose only loot tables nothing points at
(the first kind, whatever the level), and - below level 25 - the Epic armour
and trinkets a Heroic boss or one of the two gear caches hands out (the
second: each makes its loot at the cap). A row the character is merely too low to WEAR
(`item.minLevel`) is in neither list, as before. The picker shows the
withheld rows apart, dimmed, each with its `why`; they can still be equipped
— a person may, a search never picks one — and `/api/tooltip/item` repeats
the reason (`withheld`). When the reader could not open one of its stores it
withholds nothing at all and `withheldNote` says which store and why: an
empty `withheld` then means "could not tell".

Augments go through the same reader (`cat.augmentCandidates` drops an
unreleased one from `bootstrap.augments`); none is unreleased on this build,
and the augment picker has no withheld list.

### Which rows can carry an infusion

`infusable` is `HInfusion.canBeInfused` by the catalog's reader — the type
chain reaches `Armor` (the eight worn-armour types; not jewellery, not a
trinket), the ROW's rarity is at least `Item_InfusionMinRarity`'s, and the
row has a faction origin (`props.factionOrigin`, else `faction`). A row that
fails says which test in `notInfusable`. For a row that passes,
`infusionFaction` is that faction origin — an infusion OF this faction lights
the piece's bonus line; any other leaves it dark unless the piece is
Prismatic (`Gear.isInfusionBonusActive`) — and `infusionPool` lists the
ratings its bonus line can have rolled (`HInfusion.pickInfusionBonusStat`:
the bonus ratings the piece does not already pay). What each is worth on a
given instance is `/api/tooltip/item`'s `infusionPool[].value`.

## POST /api/sheet

Body: `{ "loadout": {…}, "options": { "target": "boss", "targetLevel": null,
"fight": 200, "targets": 1, "targetHealth": 1, "lookahead": 0, "rank": 3,
"mix": 0.5, "goal": "dps" } }`.

`targetHealth` is a FRACTION in `(0, 1]`, default 1 — the share of its health
the target is standing at. The CLI's `--target-health` takes a percent because
that is how the game talks; this is the engine's own unit, like `mix`. Eight
script clauses compare the target's health against a threshold (Execution's
+25% under 0.35 is the one players ask about) and it is an input, never
derived — nothing says which phase of a fight you mean. At 1 an execute rider
is correctly worth zero, and `throughput.unmodelled` carries a
`kind: "off at this target health"` row naming each one that switched off, so
a UI can tell the user why a rune they slotted reads as worthless. It is a
per-evaluation option, NOT part of the engine LRU key: one engine serves every
health value.

Loadout is the engine's own JSON (`class, level, gear{Slot_X:{item, rarity?,
stars?, level?, generic?, flawless?, infusion?, infusionStat?, prismatic?}},
augments{"Slot_X/AugmentY": id},
skills{poolKey: [ids]}, runes{skillId: runeId}, talents{nodeId: rank}`).
`class` and an integer `level` ≥ 1 are required (400 otherwise — a missing
level used to come back as a 200 whose every attribute read NaN). Before
anything is evaluated the server normalises it (`sanitizeLoadout`): unknown
items and stale sockets, runes and talents are dropped, `stars` clamps into
`0..maxStars`, and a gear `rarity` that is not the row's own is dropped unless
the item is a weapon (pitfall 13) — so "Epic" on an Uncommon helmet prices the
Uncommon helmet, here and in the optimizer, which runs the same function.
An unknown `options.goal` is a 400 naming the goals.

The three infusion fields describe the INSTANCE, in the one spelling the CLI,
`--json` and the dump importers use: `infusion` is an infusion's id (an
`InfusionPassive` skill, one of `bootstrap.infusions`), `infusionStat` the
rating its bonus line rolled (one of `constants.infusion.stats` — absent means
not stated, and then no bonus is priced), `prismatic` `true` when the piece
carries the Prismatic flag. `sanitizeLoadout` brings them to that shape (the
game's own field name `infusionBonusStat` is read as `infusionStat`; `null`,
absent and `""` all mean "not stated") and repairs nothing else:

* **A field that is not what the field holds is a 400** naming the slot and
  the field — `infusion: 5`, an `infusionStat` that is a list, a `prismatic`
  that is not `true` / `false`. Dropped in silence, the answer was the sheet
  of the same piece NOT infused: a 200 for a build nobody sent.
* **An `infusionStat` that is not a bonus rating is a 400** listing the
  ratings there are (`"gear.Slot_Head.infusionStat \"CritChance\" is not an
  infusion bonus rating - the bonus line is one of CritChanceRating, …"`).
  The game prices the line from the `InfusionBonus` rows whose `endAtb` is
  the rolled stat (`Gear.getInfusionBonusAffix`) and draws the roll from the
  same rows, so no other id can be rolled or be worth anything: `CritChance`
  (the attribute a rating buys, not the rating), `Strength` or a typo used to
  come back as a lit line worth 0.
* **An infusion the catalog does not know, or one on a piece that cannot
  carry it**, is not a stale field to drop but a build the game refuses, and
  the answer is `{ "illegal": "Slot_Neck cannot carry Hive Venom: … is a
  Neck, and only armour - … - can be infused" }`.
* **A real bonus rating outside the piece's `infusionPool` is NOT refused** —
  a looted piece carries whatever the server rolled — it is priced as stated
  and named in `unmodelled`.

`options` also carries the infusion search's two settings (`infusions`,
`infusionStat` — see `/api/optimize/start`); the sheet validates them and
reads neither.

Response:

```jsonc
{
  "illegal": null | "GA_Craft is a THWeapon and uses both hands, …",
  // when illegal, everything below is ABSENT — render the sentence.
  "attributes": [ { "id": "Vitality", "name": "Vitality", "value": 171,
                    "display": "171", "group": "primary" } ],
     // ordered: the 5 primaries (group 'primary'), then the More-stats rows
     // (group 'more'): CritChance, CritDamage, ArmorPenetration,
     // SpellPenetration, Fervor, BlockMitigation, DodgeChance, MagicMastery,
     // PhysicalMastery, then group 'defence': Armor (display "1 011",
     // sub "(-25.95%)"), then MaxHealth, HealthRegen.
     // display strings pre-formatted game-style (thin-space thousands,
     // percent 1 decimal, sub lines).
  "ratingNotes": { "CritChance": "141 Critical → +7.4pp (+0.0527pp per point)" },
  "weaponPower": 59.3,
  "survivability": { "maxHealth": 570, "physReduction": 0.256, "ehp": 2269 },
  "sockets": [ { "key": "Slot_Weapon1/AugmentDemon", "slot": "Slot_Weapon1",
                 "type": "AugmentDemon", "host": "Staff_Censer",
                 "current": null | "DemonGearUpgrade_APToCrit" } ],
  "pools": [ { "key": "Slot_Weapon1", "label": "main-hand skills", "slots": 2,
               "kind": "weapon", "repeats": false,
               "options": [ { "id": "…", "name": "…", "icon": {…},
                              "chosen": true, "count": 1, "passive": false } ],
               "alsoGranted": [ { "id": "…", "name": "…", "icon": {…} } ] } ],
  "runePools": [ { "skill": "Mage_Blink", "name": "Blink", "icon": {…},
                   "slots": 1, "current": null | "Mage_Blink_M1",
                   "options": ["Mage_Blink_M1", …] } ],   // ids into bootstrap.runes
  "talentState": { "spent": 16, "budget": 16,
                   "granted": ["Mage_Talent_HighVoltage"],
                   "illegal": null | "sentence" },
  "dps": 221.4, "hps": 0, "damage": {
      "total": 44270, "dps": 221.4, "rows": [ {
        "id": "Staff_Censer_Skill2", "name": "Blinding Light", "icon": {…},
        "kind": "active", "dps": 24.7, "damage": 4931,
        "share": 0.111,            // damage share, computed server-side
        "hits": 11 } ] },
  // null on a build of the game with no Infusion system
  "infusions": {
      "caps": [2, 4, 6],
      "infusable": ["Slot_Head", …],      // slots whose worn piece can carry one
      "sets": [ { "id": "Infusion_Nightling_DPS", "name": "Gift Beyond Realities",
          "icon": {…}, "faction": "Demon", "factionName": "Nightlings",
          "pieces": 4, "slots": ["Slot_Head", …],
          "rank": 2, "title": "(4) Set" | null, "nextCap": 6 | null,
          "attached": true,
          "priced": ["+4% Fervor", "-4% Vitality"],
          "unpriced": ["the status Gift of Critical Chance (…) [+3 CritChance]", …],
          "why": null | "no reader in this model puts a set passive's onKill … on the fight's clock yet",
          "note": null | "1 piece is below the first set bonus at 2; nothing is attached (inferred - the attach is server-side)",
          "source": { "state": "live", "why": "Rumi, Demon Huntress sells it for …" } } ],
      "pieces": [ { "slot": "Slot_Head", "item": "Head_EDemon_FigWiz",
          "itemName": "Dreadful Gaze", "faction": "Demon", "factionName": "Nightlings",
          "infusion": "Infusion_Nightling_DPS" | null, "infusionName": "…" | null,
          "stat": "CritChanceRating" | null, "statName": "Critical" | null,
          "value": 14, "wouldBe": 14, "ceiling": 0, "lit": true,
          "prismatic": false, "display": "+14 Critical" | null,
          "pool": [ { "stat": "CritChanceRating", "name": "Critical" }, … ],
          "note": null | "which rating it rolled is not stated, so no bonus is priced (…)" } ] },
  "unmodelled": [ { "id": "Mage_Blink", "name": "Blink", "kind": "rune",
                    "why": "…", "source": null | "class" | "Slot_Weapon1" | … } ]
}
```

### `unmodelled`: what the number leaves out

One row per thing the build has that the fight does not score, each with the
engine's reason. `kind` and `source` are the ENGINE's own tags, passed on as
they are — neither is a closed list, so print them, do not switch on them.
`source` says where the line came from: a gear slot (`"Slot_Weapon1"`), a
skill pool's key, a socket's key (`"Slot_Head/AugmentDemonSigil"`),
`"class"`, `"talent"`, `"conduit"`, `"script"`, `"infusion"`, or `null` where
the engine tagged nothing (one small search per class on build 25782799
returned `class`, `talent`, `script`, `infusion`, `Slot_Weapon1`,
`Slot_Weapon2`, a sigil socket and `null`).

`name` and `why` are printed the way the rest of the sheet is: the engine's
sentences quote the rows they are about with their `[links]` still in them
("the status Gift of [CritChance]", "each time one of your [WeaponSkill]s
recovers its cooldown"), and both fields come back with those links named —
"Gift of Critical Chance", "Weapon Skills" — as `/api/tooltip/skill`'s text
does.
A `source: "infusion"` row about a set repeats what that set's entry in
`infusions.sets` says, and says it in the same words — the same linked names,
and the scored stat rows as the affix template prints them ("Scored: +4%
Fervor", where the engine's own sentence, and `bench optimize`'s INFUSION
block, read "+4 Fervor"). The envelope's `unmodelled` is the engine's list
untouched, because that field is the CLI's.

### `infusions`: the sets worn, and what of each is in the number

Nothing in this block is decided by the UI server: it is the engine's own
attach (`evaluate(…).infusions`, `src/infusion.mjs`), passed on with the names
a page prints.

* **`sets`** — one per distinct infusion worn. `pieces` is how many worn
  pieces carry it, and `rank` how many of `caps` that count reaches
  (`HInfusion.getRankFromStacks`): 0 below the first cap, where nothing is
  attached and `nextCap` says how many pieces the first bonus takes. `title`
  is the game's own for that rank (`text.infusion_rank` filled with the cap —
  "(4) Set"), null at rank 0. This rank is the SET's — not weapon mastery,
  not talent points (see "Four ranks").
* **`priced` / `unpriced`** — what of the set IS in the sheet and the dps,
  and each thing it does that is NOT, by name. The set's rank-gated stat rows
  are always priced, and are printed here as the game prints an affix
  ("+4% Fervor"). Whatever the set does that the model does not score is in
  `unpriced`, each with the amounts its row authors, and `why` gives the
  reason they share — so while `unpriced` is not empty the dps UNDERSTATES
  the set, which is what a page has to say next to the number and why these
  two lists exist. Each such set also has a row in `unmodelled` with
  `source: "infusion"`, which says the same thing in the same words (see
  `unmodelled` above) — a page that shows both shows one gap twice, not two.
* **`pieces`** — one per worn piece that carries an infusion or a stated
  roll. `lit` is `Gear.isInfusionBonusActive`: a stated roll AND an infusion
  AND (Prismatic OR the infusion's faction is the piece's). `value` is the
  rating the sheet was actually paid (0 while dark), `wouldBe` what the stated
  roll is worth lit, `display` that line through the affix template, and
  `ceiling` — for a piece whose roll nobody stated — the best a roll could be
  worth where the piece would be paid it at all. `note` says why a line pays
  nothing.

## POST /api/tooltip/item

Body: `{ "class": "Mage", "charLevel": 25, "item": "Staff_Censer",
"slot": "Slot_Weapon1", "rarity": "Rare", "stars": 3, "level": null,
"augments": ["DemonGearUpgrade_APToCrit"], "infusion": "Infusion_Bee_DPS",
"infusionStat": "CritChanceRating", "prismatic": false }` (rarity/stars
optional → authored/0; the three infusion fields optional → not infused).
`rarity` is honoured for a weapon only; anything else is priced
at the rarity its row authors, the same clamp `/api/sheet` applies, so a
tile's tooltip and the sheet cannot disagree. An unknown `rarity`, an
`infusion` that is not one of `bootstrap.infusions`, an `infusionStat` that
is not one of `constants.infusion.stats` (the refusal `/api/sheet` gives a
gear entry, for the same reason), either of the two that is not an id, a
`prismatic` that is not a boolean, and a
`level` or `charLevel` that is not a number ≥ 1, are a 400; `stars` clamps
into `0..maxStars` (a negative count used to subtract item levels).

```jsonc
{ "name": "Censer of Wool Hollow", "rarityId": "Rare", "rarityName": "Rare",
  "color": "#3698fd", "typeName": "Staff", "slotLabel": "Main Hand",
  "iLevel": 290, "stars": 3, "maxStars": 3,
  "damageLine": "≈39–47 per swing" | null,       // weapons: WP-derived
  "weaponPower": 108.8 | null,
  "affixes": [ { "attr": "Intellect", "name": "Intellect", "value": 18,
                 "display": "+18 Intellect" } ],   // the exact game bake
  "upgrade": null | {                              // the weapon upgrade rider
      "name": "Weapon Upgraded",
      "desc": "Damage dealt by your Base Attacks from behind …by 12%.",
      "affixes": [ { "attr": "CritChance", "name": "Critical Chance",
                     "value": 3, "display": "+3 Critical Chance" } ], // may be []
      "unlockedAt": 3, "rank": 2 },       // rank = RARITY index (Rare = 2)
  "gives": "CritChance+Fervor" | null,
  "skills": [ { "name": "…", "icon": {…} } ],      // weapons
  "flavor": "…", "acquire": "Drops from …" | null,
  "track": [ { "label": "…", "x": 1, "y": 2 } ],
  "faction": "Crimson" | null, "factionName": "Crimson Rams" | null,
  "source": { "state": "live", "why": "…" },       // as on a catalog row
  "withheld": null | { "kind": "level", "floor": 25, "why": "…" },  // at charLevel
  "infusable": true,
  "notInfusable": null | "… is Rare, and a piece must be Epic or better to be infused",
  "infusion": null | { "id": "Infusion_Bee_DPS", "name": "Hive Venom", "icon": {…},
      "faction": "Bee", "factionName": "Apix", "pattern": "…",
      "source": {…}, "obtainable": true,            // as in bootstrap.infusions
      "text": "Infused with Hive Venom" },
  "infusionBonus": null | { "title": "Infusion bonus (Nightlings)",
      "stat": "CritChanceRating", "name": "Critical", "value": 14,
      "display": "+14 Critical", "active": false, "prismatic": false,
      "note": null | "dark - Hive Venom's faction is Apix and this piece's is Nightlings: …" },
  "infusionPool": [ { "stat": "CritChanceRating", "name": "Critical", "value": 14 } ] }
```

The infusion block is two of the three things the game's item tooltip builds
for an infused piece (`ui.TipItem.init`): one line naming the infusion — the
text row `infusion.item_effect`, "Infused with [skill]" — and, **whenever a
bonus roll is stated**, a block titled `infusion.infusion_bonus` filled with
the PIECE's faction ("Infusion bonus (Nightlings)" — not the infusion's
faction) over the rating printed as an ordinary flat affix. **The third is
NOT in this response:** under those the game embeds the infusion's set ladder
(`ui.win.InfusionSkillDesc`, the "(2) Set … (4) Set … (6) Set" panel, in a
flow of class `infusion-set-info`), lit at the rank of the hero looking at
the tooltip. That is a fact about a BUILD, and this route is asked about an
item — so the ladder is `/api/tooltip/skill` with `skill: infusion.id` and
the loadout, which returns those lines with the build's set rank. A page that
wants the game's whole tooltip prints the two together; the bench's own page
prints the ladder on the Infusions block's set rows and not on the tile.
The game shows the bonus block on a piece
that is not paid its bonus too, without its `active` class; `active` here is
that same test (`Gear.isInfusionBonusActive`: a stated roll AND an infusion
AND — Prismatic OR the infusion's faction is the piece's), and `note` says
why a stated roll pays nothing. Dim a dark line; do not hide it — it is the
one thing the player has to fix. `value` is what the line is worth on THIS
instance (`cat.infusionBonus` at its level, stars and sockets), whether or
not it is lit; nothing of the block is in `affixes`, which stays the piece's
own lines. `infusionPool` gives the same number for each rating the piece can
have rolled. A piece that cannot be infused returns `infusion: null`,
`infusionBonus: null`, an empty pool and the rule it fails in `notInfusable`
— the infusion fields of the request, once they have passed the 400 checks
above, are ignored for it (the SHEET refuses such a build; a tooltip only
describes the item).

`upgrade` is the `<Type>_Upgrade` skill a weapon's stars unlock — a rider on
the item, not an augment. It is `null` below the unlock and for anything that
is not an upgradable weapon. `unlockedAt` is the `GearUpgrades.SkillUnlockLevel`
constant (3 stars). `rank` is the item's ROLLED RARITY index (Common 0 …
Legendary 4), **not** `stars - 1` — a 3-star Epic dagger reads the rank-3 12%
where stars would say 10% — and it is the same derivation the sheet applies,
so the two always agree. `affixes` lists the flat attribute lines the sheet
sums (8 of the 20 rider rows have them); the other 12 are scripted procs and
list `[]`, with `desc` carrying everything readable. Never throws: an
unrecognised shape costs the field, not the tooltip.

## POST /api/tooltip/skill

Body: `{ "skill": "Mage_StaticNova", "rank": 3, "runes": ["…"],
"loadout": {…}, "options": {…} }` — `rank` defaults to `WeaponSkill_MaxRank`
= 3, matching `/api/sheet`'s `rank` default (mastery is assumed trained out).
`rank` is a whole number ≥ 0 or absent (400 otherwise), and it is a MASTERY
rank: the server reads it in the row's own system, see "Four ranks" below.

**`loadout` and `options` are optional and they are what make the numbers
real.** They take the same shapes `/api/sheet` takes; `options` reads
`target` (default `boss`), `targetLevel`, `rank`, `mix`, `goal`, and the
engine-construction trio `targets`/`fight`/`lookahead`. When a loadout is
given, `runes` defaults to that build's own choice for this skill
(`loadout.runes[skill]`), and an illegal loadout returns `{ "illegal": "…" }`
exactly as `/api/sheet` does. →

```jsonc
{ "name": "…", "icon": {…}, "desc": "templates filled AT the described rank",
  "cooldown": 20, "charges": null|n, "nature": "ClassSkill",
  "rank": 3,                       // the rank the row is HELD at (see below)
  "rankKind": "mastery" | "talent" | "infusion" | "upgrade",
  "rankFrom": null | "Rogue_Talent_AcidicSplatter",  // a status: whose rank
  "priced": true,                  // magnitudes are real numbers, not ratios
  "rune": "Mage_StaticNova_M2"|null,   // the rune the fill was done with
  "unresolved": [ { "token": "::dmg::", "why": "…" } ],
  "ranks": [ { "rank": 1, "desc": "…", "active": true,
               "hiddenWhenMerged": false,
               // an InfusionPassive row only:
               "title": "(2) Set", "pieces": 2 } ] }
```

### Four ranks

Four systems share the word. The row's own `type` tells three of them apart
and the fourth is known by what the row is; `rankKind` says which one a
tooltip counts in:

| `rankKind` | rows | what `rank` is | its top |
|---|---|---|---|
| `mastery` | weapon skills, and anything none of the others claims | the weapon-mastery rank the request carries | `WeaponSkill_MaxRank` |
| `talent` | `Talent` rows | the POINTS in the node | `props.talent.maxPoints` (1 or 2) |
| `infusion` | `InfusionPassive` rows | how many set thresholds the worn pieces reach — the number of `Item_InfusionCaps` entries (2, 4, 6) not above the piece count, 0 when fewer than the first are worn | the number of caps |
| `upgrade` | the twenty `<Type>_Upgrade` weapon passives | the index of the RARITY the weapon carrying it rolled (Rare 2, Epic 3, Legendary 4) — `Weapon.getWeaponUpgradeSkill` hands the skill out at `rarity.index` once the stars reach `GearUpgrades.SkillUnlockLevel`; 0 when no held weapon has unlocked it | the last rarity's index |

A status row has no type and is read at the rank of the row that applies it
(`rankFrom`), which is how the engine resolves a talent's statuses. With a
`loadout` the rank is the BUILD's — `loadout.talents[id]` (a node not taken
reads as its first point), the count of `gear[slot].infusion === id` over the
pieces the game can infuse, the rarity of the held weapon whose passive it is
— and the request's `rank` only ever answers for `mastery` rows. That matters because
the client sends one blanket mastery rank with every hover: read literally, a
one-point talent's poison was asked for its rank-3 numbers, its
`conds.maxRank: 1` affixes dropped out, and the sentence read "reducing Magic
Resistance by ?". Without a loadout a `rank` in the request is taken in the
row's own system and clamped to its top.

An infusion's pieces are counted by the engine's own counter (`infusionSets`
in `src/loadout.mjs`: one per worn piece per infusion id), so the rank a
tooltip lights is the rank `/api/sheet` attaches. The picker writes
`gear[slot].infusion`; an infusion nobody wears reports `rank: 0`, every line
`active: false`, and is described at its first set.

Only a piece the game would let carry an infusion can count
(`HInfusion.canBeInfused`, three tests on the item row): its type chain
reaches `Armor` — the eight worn-armour types, not jewellery and not a
trinket — its rarity is at least the constant `Item_InfusionMinRarity`'s
(Epic on this build), and it has a faction (`props.factionOrigin`, else
`faction`). A loadout with an `infusion` written on anything else never
reaches a count: it is an illegal build and the answer is the `illegal`
sentence naming the piece and the test it fails, exactly as `/api/sheet`
answers it. (A necklace and a ring carrying one used to light "(2) Set".)

An upgrade passive is the same sentence `/api/tooltip/item` prints as the
weapon's `upgrade` rider, at the same rank — the two are checked against each
other for every weapon type and rarity. With a loadout it is read off the
first of `Slot_Weapon1`, `Slot_Weapon2`, `Slot_OffhandWeapon` that holds a
weapon of the passive's type with enough stars (two weapons of one type each
carry their own copy; one tooltip describes one). A passive nothing held has
unlocked reports `rank: 0`, `active: false`, and is described at the first
rarity whose star allowance reaches the unlock (Rare). Read as mastery, which
is what these rows used to fall through to, a Legendary sword's "7% chance to
attack twice" was described at the blanket rank 3 as 6%.

### The ladder

`ranks` is the row's ladder, in whichever system it counts.

* **Mastery**: entry 1 is `texts.desc`, entries 2 and 3 are
  `texts.rankDescs[0]` and `[1]` (always exactly two when present — base + two
  upgrades = `WeaponSkill_MaxRank`). Each `desc` is filled AT ITS OWN rank —
  and, when a loadout is given, *priced* at that rank too, because the rank
  moves the scaling conditions as well as the vars.
* **A row with no `rankDescs`** (a class skill, a talent, a status) returns ONE
  entry: the sentence at the rank being described, carrying that rank. It is
  not a ladder and the client prints no number beside it.
* **An infusion** returns its set bonuses as the game's own panel prints them
  (`ui.win.InfusionSkillDesc`): `title` is `text.infusion_rank` filled with the
  cap ("(2) Set", "(4) Set", "(6) Set"), `pieces` is the cap, and `desc` is
  the row's sentence for that rank followed — one per line, `\n`-separated —
  by each affix that STARTS there (`conds.minRank == rank`, or
  `conds.equalRank == rank`, or neither and rank 1; `==`, so a stat line is
  printed once, on the set that turns it on). The affix is printed by the
  `affix` row's own template, not composed: "+2.5% Critical Chance",
  "-4% Vitality". Every infusion on this build authors an empty second
  sentence and a `minRank: 2` affix, so its "(4) Set" line is the stat line.

`active` is `<held rank> >= <this entry's rank>`; `hiddenWhenMerged` is the
row's `HiddenWhenMerged` flag, set on lines that merely restate a number the
top-level `desc` already carries at that rank. It is always `false` on an
infusion's set lines: seven infusions author the flag on their empty second
sentence, but the line served is that sentence plus the stat line that starts
at the set — the only statement of the "(4) Set" bonus — and the game's panel
(`InfusionSkillDesc.getRankText`) does not read the flag.

`unresolved` lists every token the fill could not answer, in ANY line or in
the top-level `desc`, deduplicated, with the reason. An empty list is the
claim that every number in every line is a real one. Those tokens are the
only place `?` still appears.

### What the magnitudes mean

`::dmg::`, `::dmgs::`, `::heal::`, `::shield::` and `::atbgain::` are not
stored values — they are computed from the skill's steps against a character,
which is why they used to print `?` in 58% of descriptions. `api.mjs` ports
the game's own renderer (`HText.makeSkillText` / `HText.skillEffectValText`,
read out of the shipped bytecode; the findexes are named in the source), so
what comes back is what the in-game tooltip prints:

* the amount is `ceil(baseVal + Σ ratio × attribute)` against the **resting**
  sheet — what the game shows you standing still — with the mainhand's 60/40
  attribute/budget mix and WeaponPower's aptitude means, then `× (1 + mastery
  + Fervor) × DamageModifier`, then `× DamageModifier` again for a Damage
  effect (or `HealGivenMultiplier` / `ShieldPowerMultiplier`). The second
  DamageModifier is the game's own arithmetic and is inert at a neutral 100.
* a **range** (`180–430`) is printed only where the game prints one:
  `WeaponAttack_RandomRange` (±10%) rides Damage effects on skill types
  `Attack..Attack4`, so basic swings band and weapon skills, finishers and
  status ticks do not. Heals and shields can also band by one when the
  multiplier is not exactly 1, which is the same floor/ceil pair the game
  applies.
* **there is no target in that expression**: no crit, no armour. The tooltip
  is a pre-mitigation number and will never equal a damage meter directly.
  The relation is exact, though —
  `perCast.damage == tooltip × critMult × mitigation × hitsPerCast` — and it
  is checked against `evaluate(…).throughput.lines` (see the note below).

Without a loadout the same tokens degrade to the **authored coefficient**
(`"120% Intellect + 120% Faith"`) rather than to `?`. That is the honest
answer for a class-wide surface: the row states a coefficient and nothing
else, and a talent's poison ticks for whatever the wearer has.

Three families are **refused** rather than approximated, and are the `?` that
remains: a **pool dot** whose whole amount is a share of the strike that
applied it (`Axe_Boomerang_Skill1_Status`, `Bow_Craft_Skill1_Rank3_Status`,
`Rogue_Talent_AtrophicPoison_Status`), a **script-injected `dynVal`** with no
readable magnitude (`Priest_Talent_BurningRays_Status`,
`Crimson_Captain_FanaticalFuryStatus`), and a **summon** whose damage lives on
the summoned unit (`Rogue_Darkness`). Each is named in `unresolved`. So is
`::sourceItemDesc::` (the whole text of `Whetstone_Status` and
`Weighstone_Status`): the game fills it with the description of the item the
live status came from, and a status row alone does not name that item.

Talent tooltips: client uses bootstrap data (desc pre-filled) + rank state.
Rune tooltips: bootstrap.runes entries. Both are filled at rank 1 with the
coefficient fallback, because bootstrap is class-wide and carries no build —
so a magnitude there reads `"35% Dexterity"`, and the skill tooltip re-prices
the same sentence the moment a loadout exists.

## POST /api/optimize/start

Body: `{ "loadout": {…}, "pins": { "gear": ["Slot_Weapon1"], "augments":
["Slot_Weapon1/AugmentDemon"], "skills": ["Slot_Weapon1"],
"runes": ["Mage_Blink"], "talents": false, "infusions": ["Slot_Chest"] },
"options": { …same as sheet…,
"lookahead": 8, "restarts": 3, "allowEmpty": true, "talentPoints": null,
"exclude": null, "infusions": "learnable", "infusionStat": "none",
"includeUnreleased": false } }`

`exclude` is a regex over item ids, and NOTHING is excluded unless the request
sends one — the search considers exactly the rows `/api/catalog` lists in
`slots`. (The
worker used to hard-code `/^GM_/`, the CLI's guess at a developer prefix; the
one id it matches is `GM_MassGrab`, "Pocket Hive", the game's only Two-handed
Mace, which the picker could equip and the optimizer could never suggest.)

The rows `/api/catalog` returns in `withheld` are NOT searched — the worker
lists from the same `cat.candidates` — and the answer says which they were
(`search.gear`, below). `includeUnreleased: true` re-admits the ones nothing
in the install hands out (the CLI's `--include-all`); a row that only exists
above the character's level is never searched. A PINNED piece is kept
whatever it is, as a `--pin` is.

**Infusion.** A set pays at 2, 4 and 6 pieces of one infusion, so the search
plans sets over the armour it ends up wearing rather than trying one slot at a
time (`infusionPass` in `src/optimize.mjs`). Three things steer it, and they
are the CLI's `--infusions`, `--infusion-stat` and `~` pins by the same
names:

* `options.infusions` — which infusions it may hand out: `"learnable"` (the
  default: every one with `obtainable: true` in `bootstrap.infusions`),
  `"all"`, `"none"` (no infusion is planned), or a list of infusion ids — the
  way to say "I have not learned that one", or to offer one the install
  withholds.
* `options.infusionStat` — what an infused piece NOBODY OWNS is taken to have
  rolled: `"none"` (the default — no bonus line is priced, a floor, because
  the roll is the game's and not a choice), `"best"`, or one rating id from
  `constants.infusion.stats`. It only ever lights a faction-matched piece.
* `pins.infusions` — the slots whose infusion is the user's own statement:
  the loadout's `infusion` (with its `infusionStat` and `prismatic`) is kept,
  and a slot listed here whose entry states none is kept NOT infused. A slot
  in `pins.gear` only has its piece held and its infusion searched. The page
  always sends the list. **A request with no `pins.infusions` key** is read
  as the model's own default — every pinned piece keeps the infusion it
  states — so an older client's pinned pieces are never re-infused behind
  its back. **An infusion pin implies the piece is pinned**: every slot in
  `pins.infusions` must also be in `pins.gear`, and a request where one is
  not is a 400 naming the slot. An infusion is a field of the piece that
  carries it (`Gear.infusion`), so "hold the infusion, search the piece" is
  not a thing the search can do — the CLI cannot even say it, its infusion
  pin being the `~` part of a gear pin — and `optimize()` took such a slot
  as "swap the piece in bare and never infuse this slot": the search with
  the pin scored below the same search without it. A `pins.infusions` that
  is not a list of slot ids is a 400 too.

The loadout goes through the same `sanitizeLoadout` as `/api/sheet`, so a
pinned piece cannot carry a rarity its row does not author — and everything
that function or the target lookup refuses is refused HERE, as a 400, BEFORE
a running search is superseded: a loadout with no `level` or an unknown
`class`, a gear `level` that is not a number, an `options.target` nothing
names, an `exclude` that does not compile, a `goal` that is not one of
`bootstrap.goals`, an `infusions` / `infusionStat` / `includeUnreleased` that
is not one of the values above, a `pins.infusions` that is not a list or
names a slot `pins.gear` does not, a gear entry whose infusion fields
`/api/sheet` would refuse — and a SEED THE GAME WOULD REFUSE: a
two-hander with a filled off hand, an infusion the catalog does not know, an
infusion on a piece that cannot carry one (the sentence `/api/sheet` returns
as `illegal`). A request that is refused never costs the search already
running. (The loadout and the target used to be checked only inside the
worker: the answer was a 200 and a job whose one event was the refusal, and
the search it replaced was already dead. An illegal off hand stayed that way
one round longer - the search evaluates its seed first, and that evaluation
is what threw.)

Pinned = "the user chose this, keep it"; everything else is searched.
`pins.runes` lists skill ids whose rune slot is pinned (to the loadout's
value, including null = pinned empty). `pins.talents` true = whole allocation
pinned. `pins.skills` lists pool keys whose selection is kept — and the page
pins a pool only when the selection FILLS it, and shows the pin (a pip on the
pool that unpins it). Any click used to pin, a deselect included: emptying a
pool pinned it, the server refilled it with the defaults, and the search then
handed that default back as the user's choice with nothing on the page to say
a pin existed.

→ `{ "job": "j1" }`

## GET /api/optimize/events?job=j1  (SSE)

- `event: progress`  `data: {"evals": 1234, "elapsed": 3.2}`
- `event: done`  `data: { "envelope": {…the optimize --json envelope…},
    "view": {…exactly the /api/sheet response shape for the winner…},
    "search": {…what the search was allowed to do, below…},
    "score": 532.4, "elapsed": 25.1 }`
- `event: error`  `data: {"error": "sentence"}`

`POST /api/optimize/cancel {job}` kills the worker.

`search` is the half of an answer a build alone does not carry — what was and
was not on the table:

```jsonc
{ "infusions": {
      "total": 15,
      "offered": [ { "id": "Infusion_Bee_DPS", "name": "Hive Venom" }, … ],
      // only when the default ("learnable") decided: what it left out, and why
      "withheld": [ { "id": "Infusion_Kobold_DPS", "name": "Unstable Bomblets",
                      "why": "Munster Chuck drops it on Heroic only (…), and Heroic is not released for Cheese Station (…)" } ],
      "statPolicy": "none" | "best" | "<rating id>",
      "pinned": ["Slot_Chest"] },          // slots whose infusion was held
  "gear": {
      "includeUnreleased": false,
      // the rows this class and level were not offered - /api/catalog's
      // `withheld`, flattened; with includeUnreleased only the `level` kind
      "withheld": [ { "id": "Chest_ECrimson_Wiz", "name": "Chakram's Ceremonial Robes",
                      "rarity": "Epic", "slots": ["Slot_Chest"],
                      "kind": "unreleased", "why": "nothing in this install hands it out - …" } ],
      "unread": null | "<which store could not be read>" } }
```

What of the winner's infusions is and is not IN its number is in the view
(`view.infusions.sets[].priced` / `.unpriced`), like any sheet's.

The envelope must round-trip: saving it to a file and running
`node bin/bench.mjs sheet --build file.json` reproduces the same sheet, and
`bench optimize --build file.json` re-runs the same search. It is field for
field what `bench optimize --json` writes — `ui/lib/check-api.mjs` feeds one
back through the CLI and compares the two files' fields — including the four
the UI's copy used to lack: `tickSource` (which sheet a status tick is priced
off), `pinned.infusions` (the slots whose infusion was held),
`infusionSearch: { offered, stat }` (what the search could hand out and the
roll policy; the CLI reads both back as defaults) and `infusions` (the
engine's `{ sets, pieces }` for the build).

## GET /asset/<path>

Raw file from res.pak (whitelisted prefixes `UI/`, `Font/`). PNGs only —
requesting a DDS-disguised-as-png here is a 404; those go through /icon/dds.
Cache-Control: immutable.

## GET /icon/dds/<b64url(pakPath)>.png?px=64 | ?rect=x,y,w,h

BC7 DDS → PNG. Two forms, and `iconRef` picks between them per gfx row:

* `?px=N` — the whole texture at the smallest mip ≥ px (mip2 64px for px≤64 —
  no full decode). For a gfx cell that IS the texture: item, rune and augment
  portraits.
* `?rect=x,y,w,h` — that pixel rect of mip 0, alone: the 4x4 blocks under it
  are sliced out and decoded without touching the rest of the sheet, so the
  answer is a `w`x`h` PNG. For a gfx cell that is one tile of a DDS sheet (the
  `atlas_*_96PX` skill sheets, the 28px stats strip). The rect is client
  input and is validated: four whole numbers, `w` and `h` at least 1, inside
  the texture. It need not be block-aligned — one that is not is decoded
  outward to whole blocks and cropped back. Anything else is a 404 with a
  sentence, never a 500, and never a cached file.

Disk-cached in `.cache/ui-icons/` (or under `FAREVER_BENCH_CACHE`). The cache
file name carries a stamp of the file the PNG was decoded from — size and
mtime of `res.pak`, or of the loose atlas — so a patch that repaints an icon
under the same pak path is a cache miss, not a stale tile forever. Also
accepts `atlas:<cellIndex>` as the path for `farever-atlas-icons.dds` cells
(`px` only; a `rect` on an atlas cell is a 404).

## Implementation pitfalls (verified — do not rediscover)

1. `engine.evaluate` THROWS on illegal loadouts → ask first and return
   `illegal`. There are TWO askers and both must be consulted:
   `illegalReason(cat, loadout)` (the off hand under a two-hander) and
   `infusionIllegalReason(cat, loadout)` (an infusion that is not one, or on a
   piece that cannot carry it). They are separate on purpose — the search's
   `pruneIllegal` consults the first before deleting an off hand. The search
   evaluates its SEED before anything else, so `/api/optimize/start` asks
   both too, before it supersedes a running job.
2. `throughput.lines[].share` is cast-time occupancy, NOT damage share —
   compute damage share as `total.damage / Σ total.damage`.
3. `targets` is engine-construction-time: cache engines keyed
   `targets|fight|lookahead` (LRU of ~4; createEngine ≈ 50ms, so misses are fine).
4. Skill identity is `id`; `name` collides ("Hidden Power" ×3).
5. Rating→pp: `rating / budget(L,150,1000,50) * target` (target 20 crit/fervor,
   50 penetrations). Never use the `scale` column.
6. `attribute.flags` has `Display` marking character-sheet stats; `Percent`
   values are percentage points; DamageModifier-family is 100-based.
7. Armor row sub-line: `damageReduction({resist: sheet.Armor, attackerLevel:
   level})` → "(-25.9%)".
8. Icons: `gfx.size` varies per row in one file (talent atlases mix 96/48) —
   always multiply per row. Sniff DDS vs PNG by magic, not name, and never
   assume which a path is: the skill atlases were PNG until the September 30
   update and are BC7 DDS since, while the talent sheets stayed PNG. A DDS
   that a row addresses with a rect smaller than the texture is a SHEET and
   must be served by rect; `ui/lib/check-icon-service.mjs` sweeps every gfx
   cell for exactly that.
9. Rune display text is `mastery[].text` (singular); statusType/itemType/
   gameTerm names nest `.name.v`.
10. Desc templates are the GAME's grammar, not a convention — port
    `HText.makeSkillText` (src/const/HText.hx:1058 on this build; the findexes
    are in `api.mjs`) rather than inventing one. The token is
    `::(-?)(ref([\d]*)_)?([a-zA-Z]+)([\d]*)(%?)(#?)::`, so **trailing digits
    are an index, not part of the name**: `val1` is the name `val` at index 0
    and `dmg2` the name `dmg` at index 1. Resolution runs whole-name specials
    (`charges`/`cooldown`/`dmgs`/`dur`/`duration`/`name`/`sourceItemDesc`/
    `stacks`) → `vars`, **which override the specials** → the computed
    families (`atbgain`, `dmg`, `heal`, `shield`, `val`). What each prints:
    - `refN_` reads the status in the row's `texts.refs` COLUMN N (`ref`,
      `ref2`, `ref3`) — by number, not by position: a row that authors only
      `ref2` still answers `::ref2_dur::`.
    - `%` scales a stored fraction by 100 **at two decimals** (0.025 is
      "2.5%", not "3%") but NOT a value already in the attribute's own units,
      which is what the game decides by testing the affix's ref id for the
      substring `Ratio` (a flat +3 CritChance affix reads "3%", not "300%").
    - `::valN::` on an affix whose `affix` row stacks `Multiplicative` or
      `Min(base: 1)` prints `1 - val`: a 0.6 `TAttribute_MRatio` on
      DamageTakenModifier is "damage taken reduced by 40%", and a 0.7
      `TAttribute_MRatioMin` on move speed is a 30% slow.
    - Four var NAMES carry their own format whatever the token says:
      `chance` is a percentage, `dur`/`time` are seconds and `range` is metres
      — the units come from the `text` rows `rich_duration_seconds`
      ("::duration::s") and `rich_range_meters` ("::range::m"), not from a
      literal. `threshold` carries CastleDB's `display: 1`
      (DisplayMode.Percent) like `chance` and reads as a percentage written
      bare.
    - `#` is the status's LIVE stack count and is therefore 1 in a builder.

    `[Term]` links are the game's too (`ui.BaseUI.formatTextToFmt`): the
    regex is `\[([!;A-Za-z0-9][A-Za-z0-9_]+)(-([A-Za-z0-9_]+))?\]([A-Za-z]*)`
    and the id is looked up in ONE ORDER, first hit wins — gameTerm,
    attribute, affinity, unit, faction, icon, item, rarity, itemType, skill,
    statusType, *input*, gameBeat, aptitude, *zone, job, ach, activity* (the
    italic ones are not walked here; no skill text links an id only they
    own). `faction` is walked for the item tooltip's "Infusion bonus
    ([Bee])" title, which is what prints "Apix". So `[Bleed]` is
    the SKILL row's "Bleeding", not the statusType's "Bleed", and a summon's
    `[Staff_SummonDemon_Imp]` is the unit's "Vile Imp". The letters after the
    bracket are part of the match: gameTerm, statusType and itemType read
    them as a declension (`[Attack]s` → the row's `plural`), and every other
    sheet — and an unresolved term, which prints its raw id — DROPS them
    (`[Shield]s`, an attribute, prints "Shield").
    `D:\Gits\farever-mods\tools\gen-atlas.mjs` (~line 1290) has an older,
    smaller version of the same substitution and no magnitudes at all.
17. Which effect `::dmgN::` names comes off `HSkill.getEffectIndex`,
    which walks the RAW `steps[].effects[]` with no rank filter and no
    script/played distinction — so index it off the cdb row, NOT off
    `damage.mjs`'s profile. The profile keeps only the full-charge step of
    `GA_Craft_Skill1` (whose sentence says "between `::dmg::` and `::dmg3::`",
    i.e. the 2.5× and 6× charge levels) and files `Staff_Censer_Skill2`'s whole
    payload under `scripted` (its sentence still calls it `::dmg::`).
    `::dmgs::` is the one walk that differs: it skips steps played by script
    (`on == Code`) and groups by affinity.
18. A tooltip magnitude is PRE-MITIGATION and PRE-CRIT — `skillEffectValText`
    never touches a target — so it cannot equal `throughput.lines[].perCast`.
    The relation is exact and is the regression test worth keeping:
    `perCast.damage == amount × critMult × mitigation × hitsPerCast`, where
    `mitigation` is `1 - damageReduction({resist: target.magicArmor|armor,
    penetrationPct, attackerLevel: <character level>})` — NOT
    `1 - target.magicReduction`, which is the authored value at level parity
    and is wrong by 30% against a boss that spawns below you. Two riders:
    a foe-worn status tick loses the caster's Fervor bracket in play but keeps
    it in the tooltip, and a multi-hit cast ("each dealing `::dmg::`") shows
    one hit where the meter sums the cast.
11. The optimizer runs in a WORKER THREAD (`ui/optimize-worker.mjs`), not a
    child process — spawning `process.execPath` launched a second Electron
    binary in the packaged app. It calls `optimize()` from `src/optimize.mjs`
    with `onProgress` (CLI stderr progress is TTY-gated = silent when piped)
    and forwards a HAND-WRITTEN list of options; an option the search should
    honour has to be added there, to `checkOptions` in `api.mjs`, to
    `buildEnvelope` when the CLI records it, and to the client's request
    (`optimize.js` `collectRequest`, `app.js` `state.options` / `state.pins`),
    or the UI silently runs the default. The infusion options show the three
    ways a default can be spelled: `infusions` and `infusionStat` are passed
    as `undefined` when unsaid (an EMPTY `infusions` list is a real answer -
    hand out none), `includeUnreleased` as `null` (the catalog's own setting), and
    `pinnedInfusion` is omitted when the request has no `pins.infusions`.
    `optimize()` does not validate its pin sets against each other - a slot
    in `pinnedInfusion` and not in `pinnedGear` is swapped bare and never
    infused - so `api.mjs` `checkPins` refuses that request before a worker
    exists; a new pin kind needs the same question asked of it.
    `buildEnvelope` is checked field for field against the CLI's writer.
12. `pointsAt(level)`: 0 below 10, else 16. Sigil-granted node: rank 1 in
    `loadout.talents`, zero cost, excluded from thresholds — recompute
    granted-ness from `augments` keys ending `/AugmentDemonSigil`.
13. Gear rarity is authored (single row); ONLY weapons roll —
    `ent.Hero.makeLootItem` skips its whole rarity roll unless the item's type
    chain reaches `Weapon`, and the one rarity setter is on
    `st.item.Weapon`. `cat.candidates` applies that test;
    `cat.attainableRarities` does NOT (handed a helmet it lists every rarity
    up to the slot's ceiling, which became Epic with the September 30 armour
    tier), so the server asks `cat.isWeaponType` itself in three places: the
    catalog's `rarities`, `/api/tooltip/item`, and `sanitizeLoadout`. Stars
    clamp to `0..maxStars(item, rarity)`.
14. Sigils are class-gated via `usableBy(aug, aptitude)` —
    `augmentCandidates` does NOT filter.
15. The engine's own `Slot_Weapon2` skill pool includes the weapon passive:
    genuinely pick 2 of 3, and taking it SPENDS one of the two slots. The
    main-hand pool is 2 actives, its passive granted free in `alsoGranted`.
    So the rule is positional, not type-based: anything in `options` costs a
    slot whatever its type, anything in `alsoGranted` is free. `passive: true`
    is a badge ("this pick is a passive"), never a licence to render it as
    permanently on — doing that lit the arsenal passive up as always active
    and removed its click handler, so it could be neither taken nor dropped.
16. Only a pool with `repeats: true` may put one option in several slots —
    a Mage slots the same conduit twice (three slots, two conduits, filled
    Shard/Power/Shard), a Priest gets one of each prayer. `count` per option
    says how many slots it holds; `chosen` alone cannot express a duplicate.
    So `slots > options.length` is legal for a repeating pool only.
19. Infusion has three rules that look like one and are not. (a) WHO CAN CARRY
    one is a test on the item row (`cat.canInfuse`). (b) THE SET RANK is the
    count of worn pieces carrying the SAME infusion id against
    `Item_InfusionCaps` — its own namespace, never `options.rank`, and two
    different infusions never add up. (c) THE BONUS LINE is per PIECE and
    does not read the set rank: one piece with a stated roll under an
    infusion of its own faction is paid it alone. Never derive any of the
    three in the UI: `cat.canInfuse` / `whyNotInfusable`, `infusionSets`, and
    `cat.infusionBonusActive` / `infusionBonus` are the readers, and
    `evaluate(…).infusions` is what the sheet actually did. What the client
    does NOT show is the attach below the first cap (that one piece attaches
    nothing is inferred — the engine says so in the set's `note`).
20. What a row comes from, and whether it is offered, is the catalog's
    (`cat.release`, `cat.minInstanceLevel`, `cat.infusionSource` — all three
    through `src/sources.mjs`, which reads the cdb, every `.pak`'s prefabs and
    the compiled code, and costs ~0.6 s on first use). The UI never judges a
    row by its id and never composes a source sentence: it frames the
    reader's `why`. `cat.candidates` already withholds, so a list built from
    it is right and SILENT — say what was left out (`withheldItems` in
    `view.mjs` asks the same two tests in the same order).
