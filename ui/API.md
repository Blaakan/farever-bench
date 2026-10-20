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
  `{error: "human sentence"}` with status 400 (bad input) or 500 (bug) —
  and 403, 404, 405, 413 or 415 for a request the server refuses before any
  route runs (see "Who may call `/api/`" below). The `/api/submit/` routes
  add 404 (a preview that is not held), 409 (one already sent or being sent,
  no upload link, a sheet of another class than the log's, a bundle built
  again from a receipt whose fight arrived, or one built again from a
  receipt of another upload link; a deletion asked for a submission being
  sent), 413 (a part over the bundle's caps), 507
  (a send's receipt could not be kept on disk, so nothing was sent - or
  pCloud's folder is full), and pCloud's answers in `src/submit.mjs`'s
  words: 503 (the upload link closed, or unknown to pCloud; a deletion asked
  with no upload link), 429 (pCloud turns this address away for now) and
  502 (pCloud could not store it, could not be reached, or answered other
  than as its API does).
  Two kinds of refusal carry fields beside the sentence: the reader's
  class question (`needs: "class"`, `character`, `classes` - `/api/import`
  and `/api/submit/preview`, which adds `logClass`), and a send's receipt
  (`receipt`, `receiptText`, `receiptName`, `kept` - see
  `/api/submit/send`); a send, or a request for a deletion, that pCloud
  refused says so with `arrived: false` - nothing of it was kept - and
  carries no receipt.
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
- **Who may call `/api/`.** Listening on loopback does not keep other pages
  out: any page the user has open can aim a request at
  `http://127.0.0.1:<port>`, and one on a name that resolves to 127.0.0.1
  (DNS rebinding) is same-origin with it as far as the browser knows. So
  `ui/server.mjs` refuses, BEFORE any route runs and before a byte of the
  body is read, in this order — each as `{error: "sentence"}`:

  | status | refused | why |
  |---|---|---|
  | 403 | any `/api/` request (GET too) whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` — plus `<host>:<port>` when the server was bound to another loopback address with `--host` | a rebinding page sends its own name; and `/api/bootstrap` names the install folder, which carries the Windows account name |
  | 403 | any request under `/api/submit/` when the server is bound BEYOND loopback (`--host 0.0.0.0`, a LAN address): `bootstrap.submit.off`, `Send a fight is off on this server: it listens on <host>, beyond this machine, …` — before the method, the Origin or the body | there the Host cannot be checked and a request with no Origin passes, so anything on the network could send fights to the project's folder from the player's address, read the kept receipts with their delete tokens, and ask for those fights' deletion |
  | 404 | an `/api/` path that is no route | |
  | 405 | a route asked in a method it does not take, with an `Allow` header: `GET` for `/api/bootstrap`, `/api/catalog`, `/api/optimize/events`, `POST` for every other route; `OPTIONS` included. Outside `/api/` (icons, files) only `GET`/`HEAD` | a cross-site JSON request needs a CORS preflight, and this server never answers one |
  | 403 | a POST whose `Origin` header, when the browser sends one, is not `http://<the Host it was addressed to>` (a request with no `Origin` — curl, Node's fetch, the check script — passes) | an ordinary cross-site page |
  | 415 | a POST whose `content-type` is not `application/json` (parameters such as `; charset=utf-8` are allowed) | a form or a "simple" fetch can send `text/plain` with no preflight |
  | 413 | a body over its route's cap: **40 MB** for the two routes that carry a file, `/api/import` and `/api/submit/preview`; **1 MB** for every other route — the rest of `/api/submit/` takes an id, a flag or a receipt | |
  | 400 | a body that is not JSON (`body is not JSON`) | |

  An over-cap body is READ TO ITS END AND THROWN AWAY, then answered 413
  with the sentence (`the request body is 41 MB, and /api/import takes at
  most 40 MB - none of it was read`; a body so little over that both sizes
  round to the same tenth of a MB reads `more than 40 MB`). It is not cut
  off: a server that closes
  the socket mid-upload leaves the client a connection reset instead of the
  reason. Outside `/api/`, a path whose `%`-escape is not one is a 400
  (`bad url: <path> has a %-escape that is not one`), not a 500.
  When `--host` binds BEYOND loopback (`0.0.0.0`, a LAN address) the
  server is reached by names it cannot list, so the Host is not checked
  there, and the Origin is compared with the request's own Host — which a
  rebinding page passes, and a request with no Origin passes anyway. That
  bind gives the guard up for the rest of `/api/`, and `bench ui` warns
  about it; for `/api/submit/` it is not given up — every route there is
  refused (the 403 above, `submitOffFor` in `ui/server.mjs`), and the
  dialog says so from `bootstrap.submit.off` instead of offering Preview.

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
          "texts": { "header": "Infusions", "prismatic": "Prismatic" } } },
  // "Send a fight": the caps src/submit.mjs holds a bundle to (SHEET_MAX_BYTES,
  // LOG_MAX_BYTES, NOTE_MAX), how long a send waits for pCloud's answer
  // (SEND_TIMEOUT_MS), and why the dialog is off on this server - null on a
  // loopback bind, the 403 sentence of every /api/submit/ route on a bind
  // beyond it (see "Who may call /api/")
  "submit": { "sheetMaxBytes": 524288, "logMaxBytes": 20971520, "noteMax": 2000, "sendTimeoutMs": 600000,
              "off": null | "Send a fight is off on this server: it listens on 0.0.0.0, beyond this machine, …" }
}
```

`submit` is what the dialog holds a file to before reading it, the note's
length, and the wait it states while a send is out (in minutes): the
module's own values, served so that the page never carries a copy that
outlives a change to them.

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
`pinned.runes` and `pinned.talents` (the rune slots and the tree the run held,
so `--build` and `/api/import` hold them again rather than searching them),
`infusionSearch: { offered, stat }` (what the search could hand out and the
roll policy; the CLI reads both back as defaults) and `infusions` (the
engine's `{ sets, pieces }` for the build).

## POST /api/import

A character file the user picked (the band's **Import** button) or dropped on
the window, read into a build the page installs. Body:

```jsonc
{ "file": { "name": "farever-inventory-Tester.json",
            "text": "{\"character\": …}" },     // or "base64": "<its bytes>" - one of the two
  "class": "Rogue",     // optional: only for a file that does not say (the modkit dump)
  "level": 25 }         // optional: the same, for the character level
```

`file.text` is the file as a string (what `File.text()` gives); `file.base64`
is its bytes, for a client that has bytes. Exactly one of them, and a
`base64` that is not base64 is a 400 rather than a file nobody sent. `name` is
the file's name and is only echoed in sentences. `class` (a unit or aptitude
id, any case) and `level` are what the CLI's `--class` / `--level` are to
`bench import`: a file that names its own keeps them.

The file is read by `src/charsheet.mjs` `readSheet` — the one reader behind
`bench import`, `--import` on every command and this route, so the page and
the CLI cannot read one file two ways. It takes four shapes, told apart by
their keys: the documented character sheet (`docs/CHARACTER-SHEET.md`), a
build the bench saved (`optimize --json`, the result pane's **Save build**),
a bare loadout, and the modkit's `farever-inventory-<Name>.json`. Response:

```jsonc
{ "format": "farever-character-sheet" | "bench-envelope" | "bench-loadout" | "modkit-inventory",
  "version": 1 | null,
  "name": "Example" | null,            // null when the file names nobody
  "unit": "Rogue", "aptitude": "Assassin", "level": 25,
  "rank": 3 | null,                    // the weapon-skill rank it records; null = not recorded
  "loadout": { …the /api/sheet loadout… },
  "pins": { "gear": ["Slot_Weapon1", …], "augments": ["Slot_Weapon1/AugmentDemon", …],
            "skills": ["Slot_Weapon2", …], "runes": ["Rogue_Shadowstep", …],
            "talents": true, "infusions": ["Slot_Chest", …] },
  "pieces": { "Slot_Weapon1": { "level": true, "rarity": false, "stars": false, "flawless": true,
                                "prismatic": true, "infusionStat": true }, … },   // what the FILE stated of each piece
  "report": [ "Read as a character sheet (farever-character-sheet), version 1.",
              "Character: Example, Rogue (aptitude Assassin), level 25.", … ],
  "reportItems": [ { "kind": "read", "text": "Read as a character sheet (farever-character-sheet), version 1." },
                   { "kind": "character", "text": "Character: Example, …" }, { "kind": "gap", "text": "Gap: …", "warn": true }, … ],
  "dropped": [ { "field": "gear.Slot_Head.sockets", "id": "…", "why": "sentence" } ],
  "notes": ["…"], "gaps": ["…"], "unknownKeys": ["gear.Slot_Head.colour"],
  "unreadable": ["talents"],           // what the exporter said it could not read
  "buildMismatch": null | "sentence",  // written on another build of the game
  "observed": { "stats": null | { "Vitality": 412, … }, "buffs": null | [ … ],
                "weaponSkillRanks": null | { … },
                "iLevel": { "Slot_Weapon1": { "game": 340, "bench": 340 } } },
  "source": null | { "exporter": "…", "exporterVersion": "…", "steamBuild": "…", … } }
```

* **`loadout` is installed as it is.** readSheet guarantees that
  `sanitizeLoadout` removes nothing from it and that neither
  `illegalReason` nor `infusionIllegalReason` objects (the suite holds that
  for every shape), so `/api/sheet` prices exactly what the file said. A
  node a socketed sigil grants is not in `talents` (it costs no point; a
  note says so) — the sheet grants it from the sigil, so the number is the
  same.
* **`pins` is what the file RECORDED**, in the shape `/api/optimize/start`
  takes: a slot written with an item or as `null` is pinned (worn, or held
  empty); a slot the file leaves out is left open to the search and named in
  `gaps`. A skill pool is pinned only when its picks fill it, as the page's
  own rule is. `infusions` only names slots that are also in `gear`.
* **`pieces` is what the file STATED of each piece** (`src/charsheet.mjs`
  `recordedPieces`): a field is false where the import names it not
  recorded (a gap). `loadout` fills those in - a weapon's row rarity, 0
  stars, not Flawless - because a loadout has no "not recorded"; sent from
  the editor as they are, they went as the character's own, where the same
  file sent as a file left them open. So the page keeps `pieces` and sends
  it back with the build in the editor (`/api/submit/preview`'s
  `sheet.editor.pieces`) for each piece the editor still holds as imported.
* **`report` is what to print** — the lines `bench import` prints, in the
  order a person checks a file: what it was, who wrote it, the other-build
  sentence first when there is one, who the character is, what was kept,
  then each drop with its reason, each gap, the unknown keys, the item
  levels and observations, the notes. The fields beside it are the same
  facts for a program; a page does not recompose sentences from them.
  `reportItems` is the same lines with the kind the reader gives each
  (`reportItems` in `src/charsheet.mjs`: `read`, `source`, `mismatch` - the
  file was written on another game build -, `character`, `kept`, `rank`,
  `dropped`, `gap`, `unknown`, `ilevel`, `ilevels`, `buffs`, `stats`,
  `note`), and `"warn": true` on a line the reader warns of (`mismatch`,
  `dropped`, `gap`, `unknown`, `ilevel` - the reader's one table of it,
  which `bench import` colours by too; no other line has the key): a page
  marks a line by `warn` and its kind, never by the words it opens with.
* `rank` is null when the file does not record the weapon-skill ranks (the
  report's gap line then says the bench's default rank applies).

Applying it (`components/exchange.js`): `App.state.cls = unit`,
`App.state.level = level`, `App.state.name = name` when it is not null,
`App.state.loadout = ` a deep copy of `loadout`, `App.state.pins` from `pins`
(Sets, `talents` a boolean), `App.state.options.rank = rank` — or, when
`rank` is null, the page's own starting rank (3, the default everything on
the page falls back to, and `WeaponSkill_MaxRank` - the rank the gap line
names), so one import's rank never outlives it into the
next file — `App.result = null`, then `await App.loadCatalog()`,
`App.refreshSheet()`, `App.render()`. Never through `App.setClass` /
`App.setLevel`: both start from an empty loadout and empty pins. Two of
those are not on the sheet, so the report panel says them above the lines:
a file that names nobody leaves the band's name as it was ("the band keeps
the name …"), and a rank that changed says what the page now prices with —
the page has no control for it. The panel is a strip in the page's flow
under the band, above the tabs: it pushes the sheet down rather than lying
over the gear it describes (or the Optimize result beside it), and scrolls
on its own past a third of the window.

The page does not import while Optimize runs (`#optimize-btn` reads
`Cancel`): a search's answer is about the build it started from, and would
otherwise land on the imported one with "Apply to editor" beside it. The
panel asks, and **Stop the search and import** cancels the job first. A file
dropped while a dialog is open (the exchange modal with no `onDrop`, the item
picker) is not imported behind it: the drag shows "no drop", and a drop that
arrives anyway is refused with a sentence.

A 400 is one of readSheet's sentences — not JSON, none of the four shapes, a
version newer than this bench reads, a class or a level that is not one — or
one of the route's own: a body that carries no file, both or neither of
`text` / `base64`, a `class` that is not a string (`class must be a class id
- a unit id (Warrior, Rogue, Mage, Priest) or an aptitude id (Fighter,
Assassin, Wizard, Cleric) - not 5`),
a `level` that is neither a whole number nor its digits as a string (`level
must be a character level - a whole number, or left out - not {"a":1}`; the
range is readSheet's). Nothing else refuses a file: a stale id, an item
the class cannot use or a socket the piece does not have is dropped and named
in `dropped`, never the whole import. One refusal is a question: a modkit
dump never names the class, and without `class` it is

```jsonc
{ "error": "a modkit inventory dump does not say which class \"Tester\" is - every weapon it lists fits a Rogue. Name the class and it is read again: --class on the command line, the class choice in the app",
  "needs": "class",
  "character": "Tester" | null,    // the name the file carries
  "classes": ["Rogue"] | null }    // the unit ids that can use every weapon it lists (every piece, with none); [] when no class can
```

— the reader's facts (`SheetError`'s `needs`, `character`, `classes`). The
page words its own question from them - the sentence is the reader's, and
names the CLI's `--class` - offers the first of `classes` (the editor's
class when there is none), and sends the same file again with `class`. A
page acts on `needs`, never on the words. The body cap is the file routes'
40 MB (413 beyond); a sheet is a few kilobytes.

## POST /api/submit/* — sending a fight to the project

The band's **Send a fight** dialog (`components/exchange.js`). Five routes,
and the order is the point: the page uploads the files ONCE, to `preview`;
the server packs them, keeps the bundle, and answers with what Send would do
with it and a `previewId`. Everything after that names the bundle by that id
and nothing else: `bundle` hands back the .zip, `send` sends it, and neither
takes a file, a path or a setting. So what is sent is the bundle the user
looked at, byte for byte, and a page that cannot read the preview's answer
(any page but the bench's own - see "Who may call `/api/`") has no id to
send. `delete` asks for a sent fight's deletion with its receipt, and
`receipts` lists the receipts the bench keeps.

Behind all five is `src/submit.mjs`, the module `bench submit` uses: the
bundle, the names it removes, the manual route's title, the receipt and
every sentence are its own, so the page and the CLI cannot pack or say one
fight two ways (docs/SUBMITTING.md is the player's account of it). So are the
rules a page might think its own: Send refuses a sheet of another class
than the log's, and a bundle built again from a receipt whose fight
arrived, by the module's `sendRefusal`, the rule `--send` asks
(`sendRefused`, below); which report lines are warned of is the readers'
`warn`; and the build in the editor is written from the
page's pins by the module (`pinnedSheet`), the rule `bench submit` writes a
build typed with flags by (`editor`, below). **`send` and `delete`
are the only routes of this server that reach the network**, through that
module's `sendSubmission` / `deleteSubmission`, and only on the click that
calls them; the suite's "network call sites" group holds api.mjs to calling
them from those two routes and nowhere else.

**Where Send goes.** Send uploads the zip to the project's folder on pCloud
through an upload link, named `<id>.zip` (the full 32-hex submission id),
with the uploader name `farever-bench` - never the character's, the
account's or the computer's. Nothing is published: the folder's owner, the
maintainer, is the one who can read it, and an uploader can put files there
and do nothing else - list, read or delete. pCloud is a third party: it sees
the player's address as any website does. The link is `uploadLink()`:
`UPLOAD_LINK` in `src/submit.mjs`, which `FAREVER_BENCH_UPLOAD_LINK` in the
environment overrides (`none` / `off` / empty switch Send off; anything else
must be an upload link, or Send is off and `uploadProblem` says why;
`ui/lib/check-api.mjs` points it at a pCloud stand-in on 127.0.0.1 and never
reaches pCloud). It is read when a preview is made and kept with it: the
preview's `upload` says whether Send is offered, and the send goes through
the link that preview was made with. No route hands the link to the page
beside the receipt that names it, and the page never shows it.

**Previews are held in memory**: 30 minutes from the preview, at most 8 at
once (a ninth drops the oldest), and gone when the server stops. A preview is
**sent once**: a send pCloud confirmed (`{result: 0}`) consumes it, and after
that `bundle` and `send` refuse it (409). A send that failed keeps it, so
**Send again** sends the very same bundle - the same id, delete token and
bytes. pCloud keeps every upload (a second one under a name it holds is
renamed beside the first), so if the first send did arrive the folder holds
two identical copies under one id, and the maintainer drops one
(`tools/inbox.mjs` reports it). Two sends of one preview at the same moment:
the second is a 409.

**One submission, however many sends.** A preview whose send failed after
the request left (it may have arrived) is never dropped for a newer one, and
its 30 minutes count again from that try. When it is gone all the same -
the 30 minutes ran out, or the bench restarted - `preview` builds it again
from its receipt (`again`, below): the receipt's id, delete token, time and
SHA-256 are `buildSubmission`'s `id`, `deleteToken`, `now` and `zipSha256`,
so the same files make the same zip, byte for byte, as `bench submit
--receipt` does, while the game build and the bench version are the ones it
was made on - anything else is refused, since one id names one bundle - and
a send of it puts at most an identical copy beside the first rather than a
second fight.

**The receipt is kept before a byte leaves.** A send whose answer is lost -
a timeout, a dropped connection, or the app closed while it waits, which
ends this server too - may still have put the fight in the folder. So `send`
writes the receipt to `<cache>/submit-receipts/farever-bench-receipt-<id>.json`
(`<cache>` is `FAREVER_BENCH_CACHE`, which the app sets to its own data
folder, else the bench's `.cache`) BEFORE it sends, as `bench submit --send`
writes its own (beside the zip, or with no `--zip` in this same folder),
and replaces it with the completed receipt (its `sentAt` set) after; a
folder it cannot write refuses the send (507). `receipts` lists the folder,
and `delete` forgets the kept copy once the request for its deletion is in
the folder. It is the one thing in the cache that cannot be made again,
which the dialog says beside every copy it names: **Save receipt** is still
where a player keeps their own. A receipt holds the delete token - whoever
reads it can ask for the fight's deletion - so the file is written mode
`0600` and a folder the write creates `0700`: on Linux and macOS, where
`node ui/server.mjs` is how the UI runs, a default write is readable by
every local account. The modes keep the files at rest from other accounts,
and that is all they do: while the server runs, any program on this machine
that can reach `127.0.0.1` - another account's included - can ask
`receipts` for the kept receipts, their delete tokens with them (a request
with no `Origin` passes the guard, as curl's does). That is one more reason
the server listens on loopback only, and Send a fight is off on any other
`--host` (the 403 above).

**A deletion is a request.** An uploader can delete nothing behind the
link. So each bundle draws a delete token once, its `manifest.json` carries
the token's SHA-256 (`deleteTokenSha256`) and the receipt the token itself,
and `delete` uploads `<id>.withdraw.json` - the receipt's id and token - to
the same folder. The maintainer deletes the zips of that id and the request
when the token's SHA-256 is the manifest's (`tools/inbox.mjs` says which):
when they next read the folder, not when the player asks. Nothing of the
fight was ever public.

### POST /api/submit/preview

```jsonc
{ "sheet": { "editor": { "loadout": { …the editor's loadout… },
                         "pins": { "gear": ["Slot_Weapon1"], "augments": [], "skills": [], "runes": [],
                                   "talents": false, "infusions": [] },   // App.state.pins, as /api/optimize/start takes them
                         "name": "Bencher", "rank": null,
                         "pieces": { "Slot_Weapon1": { "level": true, "rarity": false, … } } } },   // optional: /api/import's, for the pieces still held as imported
           // or { "file": { "name": "sheet.json", "text": "…" } } - or "base64" for its bytes
  "sheetOptions": { "class": "Rogue", "level": 25 },   // optional: for a file that does not say (a modkit dump)
  "log": { "name": "fight_….json.timeline", "base64": "…", "mtimeMs": 1792324809200 },   // or "text"
  "summary": { "name": "fight_….json", "base64": "…" },   // optional: Wink's summary beside its timeline
  "note": "…",              // optional, at most 2000 characters
  "keepName": false,        // optional; true keeps the character's name in the private files
  "again": "<a receipt's text>" }   // optional: build the submission that receipt names again (or the receipt as an object)
```

* **`sheet`** is exactly one of the two. `file` is any shape `/api/import`
  reads, sent the same way (`text`, or `base64` for bytes - exactly one);
  `sheetOptions` are that route's `class` and `level`, read by the same
  rules - what `--class` and `--level` are beside `--import`: the class a
  file that names none (a modkit dump) is read as, and, beside a file that
  names its own, a second word on it that can vouch for the sheet against a
  log of another class (`sendRefused`, below). The dialog sends them with a
  dump's class question, and with the class chosen beside any sheet file.
  `editor` is the build on the page (`App.state.loadout`,
  `App.state.pins` with its Sets as lists, `App.state.name`), handed to
  `buildSubmission` as its editor input `{loadout, name, rank, pins,
  pieces}` and written there as a sheet of what the editor STATED
  (`src/charsheet.mjs` `pinnedSheet`) - the rule `bench submit` writes the
  build its flags typed by, so the page and the CLI cannot record one build
  two ways. Its `manifest.sheet.sourceFormat` is `bench-editor`. A loadout
  has no "not stated", and written whole every slot the editor left alone
  went as recorded empty: the page opens on an empty Mage, and sent from
  there that was "15 slots recorded empty, no talent point spent, 0 runes",
  sent as the character's. So the pins decide, as the CLI's flags do:
  - a pinned slot is recorded, with its piece (an empty one as empty); a
    slot no pin holds is absent - not recorded, and the sheet report names
    it as a gap - whatever the editor holds there;
  - of a pinned piece, the fields it STATES. A piece the editor still holds
    as the last import put it there states what its FILE did: the page sends
    `/api/import`'s `pieces` back for it (`sheet.editor.pieces`,
    `{slot: {level, rarity, stars, flawless, prismatic, infusionStat}}`,
    each true or false - anything else is a 400), so an imported sheet sent
    from the editor packs the same pieces as the same file sent as a file,
    and not the row rarity or the 0 stars the loadout filled in. Any other
    piece was put there by the picker, and states what its entry carries:
    the rarity and the level when the entry carries them, the stars when it
    carries a whole number (the picker writes none for 0), Flawless (no
    control on the page) only where the loadout carries it. The infusion
    itself goes when `infusions` pins it, and with it the Prismatic flag
    (the picker's box beside the infusion, unticked, is "not Prismatic", as
    `~infusion` without `!` is on the command line) - unless an imported
    piece's file stated the flag otherwise (`pieces` prismatic: the
    infusion recorded and the flag not, or the flag and not the infusion);
  - a piece's sockets when one of them is pinned (`augments`), a skill pool
    when pinned (`skills` - the page pins one only when its picks fill it),
    the tree when `talents` is true, the runes when any rune slot is pinned;
  - `rank` only when given: the page sends the rank the last import
    recorded, while the editor is still that file's class at that rank, and
    null otherwise (it has no control for the rank).

  What the editor holds and no pin states - what **Apply to editor** put
  there, since it leaves the pins as they were, or the rest of a saved
  build whose import pinned what its run held - goes as not recorded, and
  the page is told (below, the module's `problemsOf`). A sheet records a piece's sockets and the rune
  slots whole, so one socket pinned of two, or one rune of three slots,
  sends the rest as empty; the module says each such case as a problem.
  `pins` absent is no pin at all. Refused (400): `pins` that is not an
  object, a list field that is not a list of ids, a `talents` that is not a
  boolean.
* **`log`** is the fight: a farever-combat-log file (plain or gzip), Wink's
  `.json.timeline`, or a Wink summary alone (taken as per-skill totals, and
  said). `summary` is the `.json` Wink saves beside a timeline: it gives the
  timeline its real start time. `mtimeMs` is the file's modification time
  (`File.lastModified`): a timeline with no summary is dated from it, and
  the report says the start time is estimated. Send logs as `base64`: a log
  may be gzip, and text would not survive the trip.
* `note` is the player's own words. It goes into the zip as `note.txt`: with
  Send only the maintainer reads it; on the manual route it is public with
  the rest of the zip.
* **`again`** is a receipt - one `send` handed back, or one the bench kept -
  whose submission this bundle is built again as: its id, delete token,
  `createdAt` and `zipSha256` instead of new ones. With the same files and
  choices, on the game build and bench version it was made on, it is the
  same zip, byte for byte, and the same title. With others - or the same
  ones after an update of the game or of the bench - it is refused (400, the
  module's `These files make another bundle than the one submission <id8>
  was sent as (SHA-256 … where its receipt says …): an id names one bundle,
  and what went into it has changed since that receipt was written - the
  files, the note or what was chosen with them, or this install's game build
  or the bench's version. Ask for the first one's deletion with that receipt
  - it may have arrived - and send this one as a new submission.`): the
  folder would otherwise hold two different fights under it. A receipt
  written before receipts named their bundle
  (`zipSha256` null) holds the files to nothing, and the bundle built from it
  names no SHA-256 either. The receipt goes to the module whole
  (`buildSubmission`'s `receipt`, as `bench submit --receipt` gives it),
  and its refusals are the module's, named by this field: one that is none
  (400, `again: That is not a receipt of a sent fight: …` - one that names
  no upload link among them), one with no `createdAt` (400, `again: The
  receipt of submission <id8> does not say when its bundle was made
  (createdAt), so that bundle cannot be built again byte for byte - the
  receipt still asks for the deletion of what it sent.`). Its `sentAt` and
  its `link` say where it may go: a receipt whose fight arrived, or one
  written for another upload link than this copy's (or for one, when this
  copy has none), is built again all the same - Save .zip saves it, as
  `bench submit --receipt <it> --zip` does - but not sent: `sendRefused`
  says why (below). Other files under a receipt whose fight arrived are
  refused with the sentence that says that one arrived (`… That one arrived
  (<sentAt>), so nothing more goes under its id: send this one as a new
  submission …`). The dialog builds again only from a receipt whose send was
  not answered.

Response:

```jsonc
{ "previewId": "<32 hex>",               // names this bundle in the three routes below
  "id": "<32 hex>",                      // the submission id: the one its receipt names (`receipts` lists them by it)
  "expiresAt": "2026-10-19T14:30:00.000Z",
  "upload": true,                        // false: no upload link - no Send, the manual route only
  "uploadProblem": null | "FAREVER_BENCH_UPLOAD_LINK is \"ftp://x\": it is not an http(s) address - give the upload link pCloud shows for the folder, https://...pcloud.../#/puplink?code=...",
  // null, or why Send refuses this bundle - `bench submit --send`'s rule and sentence
  "sendRefused": null | "The sheet is a Mage and the fight's log names its character a Warrior, so it is not sent: … Give the build the fight was fought in - the Warrior's sheet, or that build in the editor."
                      | "The receipt this bundle is built again from is of submission 2e5d004c, whose fight arrived (2026-10-19T14:02:11.000Z): sending it again would only store a second copy beside the first. …",
  "logClass": "Warrior" | null,          // the class the log names its character (unit id), null when it names none
  "title": "Data submission: Warrior 25 vs Dummy, Normal (2e5d004c)",   // the manual route's issue title (formUrl fills it in)
  "files": [ { "name": "manifest.json", "bytes": 1696 }, { "name": "sheet.json", "bytes": 886 },
             { "name": "combat-log.jsonl", "bytes": 3725 } ],   // the zip's entries, uncompressed
  "zipName": "farever-bench-submission-2e5d004c.zip", "zipBytes": 2320,
  "formUrl": "https://github.com/Blaakan/farever-bench/issues/new?template=data-submission.yml&title=…",
  "report": [ "What Send does: the zip (2,320 bytes) goes to the project's folder on pCloud (pcloud.com), where only the project's maintainer can read it - nothing is made public -",
              "  manifest.json  1,696 bytes", …, "On the manual route instead (Save .zip, then the GitHub form: https://github.com/…), the zip is attached to a public issue, …",
              "Names: 2 removed; your character is \"Submitter\" wherever a file names it.",
              "The character sheet:", …, "The combat log:", …, "Problem: the sheet is a Mage and …" ],
  "reportItems": [ { "kind": "refused", "text": "Problem: The sheet is a Mage and …", "warn": true },
                   { "kind": "private", "text": "What Send does: …" }, { "kind": "file", "text": "  manifest.json  1,696 bytes" }, …,
                   { "kind": "manual", "text": "On the manual route instead …" },
                   { "kind": "sheet:gap", "text": "  Gap: …", "warn": true }, { "kind": "log:problem", "text": "  Problem: …", "warn": true }, …,
                   { "kind": "problem", "text": "Problem: the sheet is a Mage and …", "warn": true } ],
  "problems": [ "the sheet is a Mage and the log's character a Warrior - the sheet should be the build this fight was fought in, and a bundle that pairs the two is not sent" ] }
```

* **`title` is the manual route's issue title** - GitHub's form opens with
  it filled in (`formUrl`): written by `submission-public.mjs` from a fixed
  list of fields (class, level, what was fought, the id's first eight
  characters). No note, no file name, no name. Send publishes nothing, so
  there is no issue body to show: on the manual route the player writes the
  issue in GitHub's form - print the title, and say that on that route the
  zip itself is public.
* **`files` is what Send uploads** - the zip's entries, to the project's
  folder on pCloud, where only the maintainer reads them. On the manual
  route (`formUrl`: Save .zip, then the form) every file in it is public,
  the note and the fight's start time to the millisecond included.
* **`report` is what to print**, the lines `bench submit` prints (the
  module's `reportItems(sub, {link})` - the route this copy actually
  offers, the names removed, the sheet's and the log's own reports, then
  every problem as `Problem: …`), with the page's own problems after the
  module's and `uploadProblem`'s line (the module's) and `sendRefused`'s
  first. `reportItems` is the
  same lines with the kind of each: the module's (`private` - what Send
  does -, `file`, `manual`, `title` - the form's title, with no upload link
  only -, `names`, `heading`, `sheet:<kind>` and `log:<kind>` - the readers'
  own kinds, the line indented under its heading -, `problem`) and
  `refused` for `sendRefused`'s line. A line the
  reader warns of carries `"warn": true` - every problem and `refused`, and
  the readers' own warned lines (another game build, a drop, a gap, a key
  not understood, an item level the game disagrees on; a log's problem) -
  and no other line has the key: the readers' one table of it, which
  `bench` colours by too. A page marks a line by `warn` (and picks its look
  by its kind), never by the words it opens with. `problems`
  is the problems as data, without the prefix - the module's `problemsOf`:
  what the build in the editor is told first (below), then the bundle's
  own. A problem does not stop
  the bundle: it is the player's to read before sending (a summary that was
  not packed, an estimated start time, a level that differs from the
  log's).
* **`sendRefused` stops Send**, and only Send. The rules and the sentence
  are the module's `sendRefusal` (in the app's words: the remedy names the
  class choice, the editor, Delete - never a flag), the one `bench submit
  --send` asks, and this server keeps none of its own: `/send` refuses it
  too (409, the same sentence) before anything is written or sent, and
  the page offers no Send for it: Back, to change the build, the class
  beside its file or the log, and Save .zip, which still saves the bundle
  as it is (as `--zip` does). Three things are refused, in this order:
  - a bundle built again from a receipt whose fight arrived (`again` with
    its `sentAt` set, given to the module as `buildSubmission`'s `sentAt`):
    pCloud keeps every upload, so sending it again would only store a second
    copy beside the first (`The receipt this bundle is built again from is
    of submission <id8>, whose fight arrived (<sentAt>): sending it again
    would only store a second copy beside the first. A changed bundle goes
    as a new submission - preview it without the receipt - and Delete, with
    that receipt, asks for the first one's deletion.`);
  - a bundle built again from a receipt written for another upload link
    than the one this copy sends through, or for one when this copy has
    none: it is sent again where it may already be, or not at all - sent
    anywhere else, one fight would be kept twice, and a request for its
    deletion would go to the wrong folder (`The receipt this bundle is built
    again from is of submission <id8>, written for another upload link than
    this copy's (or: for an upload link, and this copy has none): a bundle is
    sent again where it may already be, or not at all - … The bench started
    with FAREVER_BENCH_UPLOAD_LINK=<its link> sends it there; Save .zip keeps
    this copy of it meanwhile.` - the one sentence that prints a link);
  - a sheet of another class than the log's character (the log's header,
    or a Wink summary's `meClass`) - `bench verify` refuses the same pair.
    One case sends, as on the CLI: a file that names its own class, with a
    class given beside it (`sheetOptions.class` - the class chosen beside
    the file in the dialog, what `--class` is to the CLI) that names the
    same, which says the log's header is the one that is wrong; the
    refusal of such a file says so (`… If the log's header is the one that
    is wrong, choosing <A> as the class beside the sheet file says so, and
    it is sent.`). The module decides that when it builds the bundle
    (`classMismatch.vouched`), from what was given and nothing else, and
    `sendSubmission` asks `sendRefusal` again before its request leaves: a
    modkit dump, whose only class is the one chosen for it, and the build
    in the editor are never vouched for (`… A modkit dump names no class,
    so the class chosen for it is the sheet's only word on it, and cannot
    say the log is the one that is wrong.`).

  The report's first line says it (after `uploadProblem`'s).
* **`logClass`** is the class the log names its character (`sub.logClass`,
  a unit id), or null: what a page offers first when it asks a class.
* **The build in the editor** is told more, since the page opens on an
  empty Mage and Send a fight on it is one click - the module's problems for
  a stated build (`src/submit.mjs` `statedFindings`, worded for the app;
  `bench submit` tells a build typed with flags the same in its own words,
  `the build as typed …`), first among them: one that
  wears nothing (`the build in the editor wears nothing - is it the build
  this fight was fought in? …`), wears no weapon, or wears none of the
  weapons whose skills the log's character used (`the log's character used
  GA_Craft_Skill1 - a skill of GA_Craft - and no weapon the build in the
  editor wears grants it: …`); and one that holds what no pin states (`the
  build in the editor holds what no pin states - 2 pieces (Slot_Weapon1,
  Slot_Chest), its talent points - and that goes as not recorded, not as
  the character's …`). The sockets and rune slots sent as empty because a
  sheet records them whole are the module's problems (`Slot_Weapon1: a
  sheet records a piece's sockets whole, so …, which no pin held, is sent
  as empty`).
* `uploadProblem` is the module's sentence when `FAREVER_BENCH_UPLOAD_LINK`
  is set to something that is not an upload link (`FAREVER_BENCH_UPLOAD_LINK
  is "<value>": it <why> - give the upload link pCloud shows for the folder,
  …`: not an http(s) address, not on pCloud, plain http to anything but this
  machine, no code or a code that is not one): Send is then off, and the
  report's first line says why (`Problem: Send is off: …` - the module's
  `reportItems`, given `uploadProblem`), followed by the manual route as the
  way meanwhile (`Send is off in this copy of the bench until that link is
  set right. …`), never by "no upload link is set"; `sendRefused`'s line,
  when there is one, comes after those two.
* **`id`** is the submission id, as the receipt of a send of this bundle
  names it: a page whose send got no answer at all (the server stopped while
  it waited) finds that send's kept receipt by it in `receipts`.

Refused before anything is packed, each a 400 with the route's sentence: a
body with no `sheet`, or both or neither of `file` / `editor`; a file part
that is not `{name, text}` or `{name, base64}` (both, neither, base64 that is
not base64, a name that is not text); an `editor.loadout` that is not an
object, an `editor.name` that is not text, an `editor.rank` that is not a
whole number, `editor.pins` not of the pins' shape, `editor.pieces` not of
`/api/import`'s; a `log` missing; an
`mtimeMs` that is not a number; a `note` that is not text; a `keepName`
that is not `true` / `false`; `sheetOptions` whose `class` or `level`
`/api/import` would refuse (`/api/import` and this route read a file part,
and a class and level, with the same two readers - `parseFilePart`,
`parseClassLevel` - so they refuse in the same words). Then `buildSubmission`'s
own refusals, with its sentences and statuses: a sheet or a log that does not
read (400 - the reader's sentence, prefixed with which file), a name still
found in the bundle (400, and nothing was built), a sheet over 512 KB, a log
over 20 MB once inflated, a note over 2000 characters or a zip over 25 MB
(413). A modkit dump with no class is read in the class the fight's log
gives it when the log is of the dump's own character (by name) and every
weapon the dump lists fits that class (`src/charsheet.mjs`
`dumpClassFromLog`, the rule `bench submit` and `bench verify` read a
dump beside a log by), and a problem says so (`a modkit dump names no
class: it is read as a Warrior - the class the fight's log gives the dump's
own character, …`). Otherwise it is the same question `/api/import` asks,
its sentence ending on why the log's class was not taken (`… The fight's
log names its character a Warrior, a class the dump's weapons do not fit, so
the dump is not read as one.`): 400 with the reader's facts (`needs: "class"`, `character`, `classes` -
`buildSubmission` passes them on) and `logClass`, the class the fight's
log names its character, read by the module's log reader (null when it
names none, or the log does not read); the page offers `logClass` first
(when the dump's weapons allow it), else the first of `classes`, and sends
the preview again with `sheetOptions.class`.

### POST /api/submit/bundle

`{ "previewId": "…" }` → `{ "name": "farever-bench-submission-2e5d004c.zip",
"base64": "<the zip>", "bytes": 2320 }` - the zip the preview described,
byte for byte, for **Save .zip** (the page saves it as a Blob download).
Asked as often as the page likes while the preview is held. The name says
nothing about the player: on the manual route it is shown on a public issue.

### POST /api/submit/send

`{ "previewId": "…", "consent": true }` → 200:

```jsonc
{ "sent": { "id": "<32 hex>", "uploadedAs": "<32 hex>.zip",   // the name the zip went under in the folder
            "sentAt": "2026-10-19T14:02:11.000Z", "zipSha256": "<64 hex>" },
  "receipt": { "id": "<32 hex>", "deleteToken": "<32 hex>", "link": "https://e.pcloud.com/#/puplink?code=…",
               "sentAt": "2026-10-19T14:02:11.000Z", "createdAt": "2026-10-19T14:00:00.284Z",
               "zipSha256": "<64 hex>" },   // its six fields; zipSha256 is the bundle's: `again` holds a rebuild to it
  "receiptText": "{\n  \"format\": \"farever-bench-receipt\", …",   // receiptText(receipt): the file to keep
  "receiptName": "farever-bench-receipt-2e5d004c.json",
  "kept": "…/submit-receipts/farever-bench-receipt-<id>.json" }   // the bench's own copy, or null
```

`consent` must be the literal `true`: the page sends it only once the box
"I understand the zip goes to the project's folder on pCloud, where only the
maintainer can read it" is ticked. The route writes the pending receipt
(`pendingReceipt`: `sentAt` null) to the bench's folder first - see "The
receipt is kept before a byte leaves" - then uploads the zip through the
module's one call site (`sendSubmission`: `POST
<api>/uploadtolink?code=<code>&names=farever-bench&nopartial=1`, one
multipart file part `<id>.zip`, `application/zip`; no header of the bench's
own, never the delete token; a redirect refused rather than followed), with
the same bench version `bench submit --send` holds it to, and waits for
pCloud's answer: `bootstrap.submit.sendTimeoutMs` at most (10 minutes, the
module's `SEND_TIMEOUT_MS` - a 25 MB zip on a slow line). It puts the
completed receipt in its place and writes its response itself. `sent` is
what went: `uploadedAs` is the name pCloud was given, and no field of the
receipt. A send the module refuses before its request leaves, or one pCloud
refuses (below), takes the pending copy back: no fight carries its id. A
copy kept by an earlier send of the same bundle stays - that send may have
arrived.

* **`receiptText` is what the page offers as "Save receipt"**: the receipt
  with a line saying what its token does. It is the only way the player can
  ask for the fight's deletion later (`/api/submit/delete`, or `bench submit
  --delete`). `kept` is where the bench keeps its own copy (null when it
  has none), which the page names beside **Save receipt**.
* **A failure after the request left carries the receipt too** - `receipt`
  (its `sentAt` null), `receiptText`, `receiptName` and `kept` beside
  `error`: pCloud could not be reached, did not answer in time, or answered
  other than as its API does, so the fight may have arrived, and that
  receipt asks for its deletion if it did. The sentence says what to do
  (keep the receipt; send the same bundle again, which stores at most a
  duplicate the maintainer drops; or take the manual route). The preview is
  kept for **Send again**, past any number of newer previews, for 30
  minutes from this try; after that a preview built with `again` is the
  same submission.
* **A refusal pCloud answers carries none.** Its API answers every call
  with HTTP 200 and a JSON `result`: 0 when it kept the file, and otherwise
  a number and an `error` sentence - and with `nopartial=1` nothing of the
  upload was kept. That is `{error, arrived: false}`, the status by the
  result (below) and pCloud's own sentence in brackets in the module's;
  nothing of this send needs a deletion asked for. A receipt the page holds
  from an earlier send of the same preview still stands, and so does the
  bench's kept copy of it.

| status | when | body |
|---|---|---|
| 400 | `consent` is not `true`; `previewId` is not 32 hex characters; the bundle was built by another bench version than this one (the module's sentence) | `{error}` - nothing was sent |
| 404 | no preview has that id: it expired (30 min), was dropped for a newer one (8 held), or the server restarted - `No preview with that id is held: … - the files are to be previewed again, and a bundle whose send was not answered is built again from its receipt as the same submission` | `{error}` |
| 409 | the preview was sent already - `This preview was sent already (submission <id8>): a preview is sent once, and its bundle is in the project's folder now`, with the first send's `receipt`, `receiptText`, `receiptName`, `kept`, so a page whose answer was lost can still save it; a send of it is on its way; the preview's `sendRefused` - `The receipt this bundle is built again from is of submission <id8>, whose fight arrived (<sentAt>): sending it again would only store a second copy beside the first. …`, `The receipt this bundle is built again from is of submission <id8>, written for another upload link than this copy's (or: for an upload link, and this copy has none): …`, or `The sheet is a <A> and the fight's log names its character a <B>, so it is not sent: …` - asked first, as `sendSubmission` asks it; then there being no upload link - `Send is off in this copy of the bench (no upload link is set) - save the .zip and attach it to a new issue: <formUrl>`, or `Send is off: <uploadProblem>` when `FAREVER_BENCH_UPLOAD_LINK` is set to something that is not an upload link | `{error}` (+ the receipt fields for the first) - nothing was written or sent by this request |
| 507 | the receipt could not be written to the bench's folder - `Nothing was sent: the bench could not keep this send's receipt as <path> (<code>), and with no receipt kept, the deletion of a fight whose answer was lost could not be asked for - …` | `{error}` - nothing was sent; the preview stays held |
| 503 | pCloud: the project's upload link is closed (result 7002 or 7004 - `The project's upload link is closed (pCloud: <its sentence>) - nothing was sent; save the .zip and attach it to a new issue: <formUrl>`), or pCloud does not know it (2012 - `pCloud does not know this copy's upload link (pCloud: …) - nothing was sent; …`) | `{error, arrived: false}` |
| 507 | pCloud: the folder is full (7007, 7008 - `The project's pCloud folder is full (pCloud: …) - nothing was kept; try again another day, or save the .zip and attach it to a new issue: <formUrl>`) | `{error, arrived: false}` |
| 429 | pCloud turns this address away for now (4000 - `… nothing was kept; try again later.`) | `{error, arrived: false}` |
| 502 | pCloud could not store it (2041, 5000, 5001 - `pCloud could not store the zip (pCloud: …) - nothing was kept; send it again later.`), or refused it with any other result (`pCloud refused the upload (result <n>: …) - nothing was kept.`) | `{error, arrived: false}` |
| 502 | pCloud could not be reached or did not answer in time (`The upload to the project's pCloud folder could not be reached (<code>)` / `did not answer within 600 s` `- the fight may or may not have arrived. Keep this bundle's receipt: …`), or answered other than as its API does - a proxy's page, no `result` (`pCloud answered <status> but not as its API does - whether the fight arrived cannot be told from here. …`) | `{error, receipt, receiptText, receiptName, kept}` |

### POST /api/submit/delete

`{ "receipt": "<the receipt file's text>" }` (or the receipt as an object) →
`{ "ok": true, "requested": true, "id": "<32 hex>", "forgotten": true }`.

An uploader can delete nothing behind the link, so this ASKS: it uploads one
file through this copy's own upload link, by the same one call a send makes
(`deleteSubmission`) - `<id>.withdraw.json`, `application/json`:

```jsonc
{ "format": "farever-bench-withdrawal", "version": 1,
  "about": "The sender of submission <id> asks for it to be deleted. The SHA-256 of deleteToken is the deleteTokenSha256 in that submission's manifest.json.",
  "id": "<32 hex>", "deleteToken": "<32 hex>", "zipSha256": "<64 hex>" | null, "requestedAt": "2026-10-20T09:00:00.000Z" }
```

The maintainer deletes the zips of that id and the request when the token's
SHA-256 is the `deleteTokenSha256` of the zip's `manifest.json`
(`tools/inbox.mjs` says which) - when they next read the folder, not when
the player asks. Asking twice is harmless, and a receipt kept before a send
whose answer was lost (`sentAt: null`) asks the same: if that send never
arrived, the request deletes nothing. `forgotten` says the bench removed its
own kept copy of that receipt: the request is in the folder.

Asked through this copy's own link and no other - the module's rule, which
`bench submit --delete` asks too: a receipt anyone could have written names
any link, and its id and token would go there. So a receipt of another link
is a 400 before anything leaves (`This receipt is of submission <id8>, sent
to another upload link than this copy's: a deletion is asked only through
this copy's own link. If you sent that fight yourself through that link,
FAREVER_BENCH_UPLOAD_LINK=<its link> asks there.`), and the page shows that
sentence as it is rather than naming a link itself.

409 while a held preview of that very submission is being sent (`Submission
<id8> is being sent right now - nothing was asked: ask for its deletion once
that send is answered, within 10 minutes`): the send's answer would write
its receipt back as completed after the request forgot it. 400 also for a
`receipt` that is none (`That is not a receipt of a sent
fight: …` - one that names no upload link among them); 503 with no upload
link (`Send is off in this copy of the bench (no upload link is set), so no
deletion can be asked from it - …`); pCloud's refusals as for a send, with
`nothing was asked` and `arrived: false`; 502 when pCloud cannot be reached
or answers other than as its API does (`… the request may or may not have
arrived; asking again with the same receipt is harmless (the maintainer
reads one request per id).`). On any refusal the kept copy stays.

### POST /api/submit/receipts

`{}` → the receipts the bench keeps, newest first, and whether this copy
sends at all - never the link it sends through:

```jsonc
{ "folder": "…/submit-receipts",
  "receipts": [ { "file": "…/farever-bench-receipt-<id>.json", "receipt": { …its six fields, zipSha256 null for an older one… },
                  "receiptText": "…", "receiptName": "farever-bench-receipt-2e5d004c.json", "kept": "…" } ],
  "unreadable": [ "farever-bench-receipt-<id>.json" ],   // a file of a receipt's name that does not read as that receipt
  "problem": null | "<folder> could not be read (EACCES)",
  "upload": true, "uploadProblem": null | "FAREVER_BENCH_UPLOAD_LINK is …" }
```

A receipt with `sentAt: null` is a send that was never answered: it may have
arrived. Nothing here reaches the network.

### The dialog (`components/exchange.js`)

**Send a fight** opens it on the build in the editor (sent with the page's
pins, and with the rank only as the last import recorded it - see
`/preview`'s `editor`), or a sheet file - a modkit dump asks for its class
there, as Import does: a question the page words from the refusal's
`character` and `classes`, with `logClass` chosen first when the dump's
weapons allow it, else the first of `classes`; any other sheet file has
"Its class" beside it, "as the file says" unless changed, which goes as
`sheetOptions.class` (what `--class` is beside `--import`: the class of a
file that names none, or the file's own class said again where the log
names another, which the module's refusal names as the way to send it) -,
the fight's log files, a
note (`bootstrap.submit.noteMax` characters) and "Keep my character's
name" (off). On a server
bound beyond this machine it opens on `bootstrap.submit.off` instead, with
Preview and the delete link switched off. The
log picker takes several files: one is the log, whatever it is; two are one
fight only as Wink's `<name>.json.timeline` (the log) with its `<name>.json`
(the summary); anything else is said and not sent. **Preview** uploads
them and shows, from the answer and nothing else: `sendRefused` first,
when there is one, as what stops Send (in the error colour, with Back and
Save .zip as the ways on); the problems; then, with `upload`, "What Send
does" (`The zip - <zipName>, <n> bytes - goes to the project's folder on
pCloud, where only the project's maintainer can read it. Nothing is made
public.`, then `files` with their sizes), or without it the title the form
is filled with and the files as public; the consent box ("I understand the
zip goes to the project's folder on pCloud, where only the maintainer can
read it"), the buttons, the sentence that the GitHub form route makes the
files public while Send makes nothing public; then `report` line for line,
each warned line (`reportItems`' `warn`) marked, in the look of its kind (a
drop, a gap, a key not understood, else a warning). **Send** exists only
with `upload` and no `sendRefused`, and only after the consent box is
ticked; while it waits the dialog cannot be closed (Esc, ✕ and the veil say
why instead, with `bootstrap.submit.sendTimeoutMs` in minutes as the most it
waits), since the answer completes the receipt. A sent fight shows `Sent.
Submission <id8> is in the project's pCloud folder; only the maintainer can
read it. Save the receipt: it is how you ask for this fight's deletion
later (…)` and **Save receipt** - no link, since nothing was published; a
failure shows the server's sentence, where the bench kept the receipt,
**Save receipt** and **Send again**. **Save .zip** saves `/bundle` as a Blob
download; **Open the GitHub form** is `window.open(formUrl)` (Electron hands
`window.open` to the user's browser). The page sends logs and sheets as
`base64`, holds a sheet and a log to `bootstrap.submit`'s caps before
reading either (the module's own, never a copy), never asks the server about
pCloud before Preview, and never shows the upload link.

**One send is one submission, and its receipt is never dropped unsaid.**
From the first answer that carries a receipt (a failure that may still
have arrived included), the dialog holds it until **Save receipt** is
clicked, and everything that would close it unsaved - Esc, the ✕, the veil,
Close - asks first: "Save receipt, then close" or "Close without saving",
naming the bench's kept copy and saying that its folder is a cache (Esc on
the question answers it "not now"). After a send that was not answered the
dialog never makes a second bundle behind the player's back: **Send again**
sends the held preview, and when the server answers 404 (the bench let it
go) the page posts the same preview body again with the receipt as
`again`, shows the rebuilt bundle - the same submission and the same
bytes, which the module holds it to by the receipt's `zipSha256` (other
bytes are its 400, shown as the error; for an older receipt that names no
SHA-256, said to be the same bytes when its title and size are) - and
leaves the click to the player, saying "Send again sends it" only of a
rebuilt preview Send takes (otherwise that Send is off for it, with
`sendRefused` or `uploadProblem`). **Save .zip** on a 404 does the same and
then saves the rebuilt bundle (one that is not the bytes shown is shown
first, not saved). If the first send did arrive, the folder then holds two
identical copies under one id, and the maintainer drops one; the dialog
says so. A send whose request got no answer at all - the server stopped
while it waited - is one not answered too: the page holds no receipt yet,
so it asks `receipts` again (every 5 s while the server does not answer)
and holds the kept receipt whose id is the preview's `id` - as sent, when
it is completed - or says none is kept, when the send never left; until
then Back and Close ask as well. A receipt saved while its send was not
answered is not the completed one: once Send again is answered, Close asks
to save that one.
**Back** asks first: a bundle made from the choices is a new submission, so
it offers "Ask for its deletion, then go back" (`/delete` with the receipt)
or "Stay". A file dropped on the dialog once a send was tried is refused
with a sentence for the same reason.

**Drops.** The dialog sets `onDrop`. Dropped files go where they most likely
belong - the fight's log files, or a lone `.json` while "A character sheet
file" is chosen with none picked - and a line says where they went, with the
other place one click away ("It is the character sheet" / "It is the combat
log"), since a lone `.json` is a sheet or Wink's summary alone.

**The bottom of the dialog.** **Delete a submission I sent…** picks a
receipt file; the receipts the bench keeps (`/receipts`) are listed under
it - "Submission <id8>, sent …" or "Submission <id8>, made … - its send was
not answered" - each with **Save**, **Delete…** and, for one never answered
and while the dialog has no submission of its own, **Send again…**, which
builds the next preview with that receipt as `again` (a banner says to
choose the same files, and that a duplicate in the folder is dropped by the
maintainer; "Make a new submission instead" drops it). While a never
answered one is listed, the first page says so above the choices: a new
bundle is a new submission. Every request for a deletion asks first, and the
question says what it is - `This uploads a request to delete submission
<id8> to the project's pCloud folder; the maintainer deletes the fight and
the request when they next read it.` - and names no link: a receipt of
another one is the server's 400, shown as it is. After it, `Asked: the
project's folder holds a request to delete submission <id8>.` A request for
this dialog's own submission, or for the one whose bundle is on screen (a
preview built again from its receipt), puts it back on its first page, so
no Send puts a withdrawn id back in the folder. While the dialog is busy - a
send on its way above all - the delete links and the question's buttons
are off (and `/delete` refuses a submission being sent, 409).

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
21. A new route is TWO edits in `api.mjs`: its row in `ROUTES` (the method
    it answers — the server refuses every other method, and a path with no
    row, before the body is read) and its `case` in `handle`. A case whose
    row was forgotten is never run: `handle` answers 404 for any path not in
    `ROUTES`, because without the row the request would reach it with no
    method, Origin or content-type check and no body. `check-api.mjs` reads
    both lists off the source and names the missing half. Its body cap is
    the server's, by path (`bodyCapFor`): 1 MB unless the route is one of
    the two that take a file (`FILE_ROUTES` in `ui/server.mjs`), so a new
    route that takes one is a third edit there. An async route writes `res`
    itself, as `optimizeEvents` does, and `handle` returns true at once.
    Three things in the guard bite a client that is not the page: `fetch`
    from another origin is refused (403), a body sent as `text/plain` to
    dodge the preflight is refused (415), and a tool that rewrites `Host`
    (a proxy, an SSH tunnel to another local port) is refused (403) — a
    tunnel has to keep the server's own port, or the server has to be bound
    with `--host` to the name it is reached by. And never answer an
    over-cap body with `req.destroy()`: the client sees `ECONNRESET`, not
    the 413 sentence (`ui/server.mjs` `readBody` drains it instead).
22. The two submit routes that reach the network are held to their own
    `case`s by the suite ("network call sites"): `sendSubmission` may be
    called only in a function that only `case '/api/submit/send':` calls,
    `deleteSubmission` likewise for `/api/submit/delete`. Its reader of
    "the function a call sits in" is a line regex, so inside those two
    handlers there is no arrow function bound to a name (`const f = () =>`)
    above the call - it would read as the call's owner - and the helpers
    they use are declared outside them (`sendWait`, `keepPending`,
    `replyError`). A preview never sends, the dialog never asks pCloud
    anything when it opens (no health check, and never pCloud's
    `showuploadlink`, which tells anyone holding the code the owner's e-mail
    address: Send's own upload is the only contact; `/receipts` reads the
    bench's own folder and nothing else), and the send takes only
    `previewId` and `consent` - never a file, a path or a link from the
    request; the link is the one the preview was made with. Its order is the
    receipt on disk (`keepPending`), then `held.sending`, then
    `sendSubmission` - nothing awaited between the `sending` test and the
    flag, so two sends cannot both pass it, and nothing sent before the
    receipt is kept. `/delete` takes the receipt and nothing else; the link
    it asks through is this copy's own (`uploadLink()`), never the
    receipt's.
