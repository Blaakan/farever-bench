# farever-bench UI — server API contract

The HTTP contract between `ui/server.mjs`+`ui/api.mjs` (backend) and `ui/web/*`
(frontend). Everything is JSON over `http://127.0.0.1:<port>`. This file is the
single source of truth — if an implementation disagrees with it, fix one or the
other, never silently diverge.

Engine facts referenced here are verified against the live game data
(cdb b7a48efb); see the pitfalls at the bottom.

## Conventions

- Attribute/skill/item ids are the CDB row ids (`Staff_Censer`, `CritChance`).
- Every icon is either
  - `{kind:'tile', file:'UI/icons/…png', px:[x,y,w,h]}` — a real PNG served raw
    at `GET /asset/<file>`; the client crops with CSS background-position
    (px rect already multiplied out: x*size, y*size, (width??1)*size, …), or
  - `{kind:'dds', url:'/icon/dds/<b64 of pak path>.png?px=64'}` — a BC7 DDS
    decoded server-side, cached, served as PNG (`px` picks the mip ≤ that size).
  The server chooses per gfx row (sniffing is done once server-side).
- Colors are `'#rrggbb'` strings.
- All POST bodies and responses are JSON; errors are
  `{error: "human sentence"}` with status 400 (bad input) or 500 (bug).

## GET /api/bootstrap

Static-per-session data, fetched once at startup.

```jsonc
{
  "meta": { "version": "0.1.0", "cdbSha": "…", "bootSha": "…", "game": "E:\\…" },
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
  "targets": [ { "id": "boss", "label": "named boss (Ratsar…)" }, … ],
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
      "classGate": null | "Mage", "acquire": "…" } ] },
  "constants": { "maxLevel": 25, "talentPointsAtCap": 16 }
}
```

## GET /api/catalog?class=Mage&level=25

Per-slot candidate lists for the picker (recomputed when class/level changes).

```jsonc
{
  "slots": {
    "Slot_Weapon1": [ {
      "id": "Staff_Censer", "name": "Censer of Wool Hollow",
      "type": "Staff", "typeName": "Staff", "hands": "LongWeapon",
      "allowsOffhand": false,          // mainhand candidates only
      "level": 14, "faction": "Crimson",
      "levelScales": true,             // its effective level tracks the char
      "levelRange": [14, 25],          // [authored, charLevel] when it scales
      "aptitudes": ["Wizard","Cleric"], "gives": "CritChance+Fervor",
      "icon": {…},
      "rarities": [ { "id": "Rare", "authored": true, "chance": 0.5,
                      "maxStars": 3 }, { "id": "Epic", "chance": 0.19,
                      "maxStars": 4 }, … ],   // gear: single authored row
      "skills": [ { "id": "Staff_Censer_Skill1", "name": "…", "icon": {…} } ],
      "acquire": "Drops from …", "track": [ { "label": "…", "x":1, "y":2, "z":3 } ],
      "flavor": "…" } ],
    "…": []
  }
}
```

Weapon2 (arsenal) lists mainhands + offhands; OffhandWeapon lists shields.
The client enforces: OffhandWeapon enabled only when
`mainhand.hands === 'OHWeapon'` (server also validates on sheet/optimize).

`levelScales` is `cat.effectiveLevel`'s own branch, measured rather than
restated: weapons and the eight worn-armour types take a drop at YOUR level
(true), jewellery, trinkets and every crafted/consumable row keep the level
their row authors (false). `levelRange` is `[min, max]` accordingly —
`[item.level, charLevel]` when it scales, `[item.level, item.level]` when it
does not, and `[charLevel, charLevel]` for the 48-of-261 rows that author no
level at all (the `*_R<Faction>_*` armour), which drop at your level either
way. `null` only if no level can be derived at all.

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
stars?, level?, generic?, flawless?}}, augments{"Slot_X/AugmentY": id},
skills{poolKey: [ids]}, runes{skillId: runeId}, talents{nodeId: rank}`).

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
  "unmodelled": [ { "name": "Blink", "why": "…" } ]
}
```

## POST /api/tooltip/item

Body: `{ "class": "Mage", "charLevel": 25, "item": "Staff_Censer",
"slot": "Slot_Weapon1", "rarity": "Rare", "stars": 3, "level": null,
"augments": ["DemonGearUpgrade_APToCrit"] }` (rarity/stars optional →
authored/0).

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
  "faction": "Crimson" | null }
```

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

**`loadout` and `options` are optional and they are what make the numbers
real.** They take the same shapes `/api/sheet` takes; `options` reads
`target` (default `boss`), `targetLevel`, `rank`, `mix`, `goal`, and the
engine-construction trio `targets`/`fight`/`lookahead`. When a loadout is
given, `runes` defaults to that build's own choice for this skill
(`loadout.runes[skill]`), and an illegal loadout returns `{ "illegal": "…" }`
exactly as `/api/sheet` does. →

```jsonc
{ "name": "…", "icon": {…}, "desc": "templates filled AT `rank`",
  "cooldown": 20, "charges": null|n, "nature": "ClassSkill",
  "rank": 3,                       // echoes the request
  "priced": true,                  // magnitudes are real numbers, not ratios
  "rune": "Mage_StaticNova_M2"|null,   // the rune the fill was done with
  "unresolved": [ { "token": "::dmg::", "why": "…" } ],
  "ranks": [ { "rank": 1, "desc": "…", "active": true,
               "hiddenWhenMerged": false } ] }
```

`ranks` is the mastery ladder: entry 1 is `texts.desc`, entries 2 and 3 are
`texts.rankDescs[0]` and `[1]` (always exactly two when present — base + two
upgrades = `WeaponSkill_MaxRank`). Rows with no `rankDescs` return a
one-entry array. Each `desc` is filled AT ITS OWN rank — and, when a loadout
is given, *priced* at that rank too, because the rank moves the scaling
conditions as well as the vars. `active` is `rank <= <requested rank>`;
`hiddenWhenMerged` is the row's `HiddenWhenMerged` flag, set on lines that
merely restate a number the top-level `desc` already carries at that rank.

`unresolved` lists every token the fill could not answer, deduplicated, with
the reason. An empty list is the claim that every number in every line is a
real one. Those tokens are the only place `?` still appears.

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
the summoned unit (`Rogue_Darkness`). Each is named in `unresolved`.

Talent tooltips: client uses bootstrap data (desc pre-filled) + rank state.
Rune tooltips: bootstrap.runes entries. Both are filled at rank 1 with the
coefficient fallback, because bootstrap is class-wide and carries no build —
so a magnitude there reads `"35% Dexterity"`, and the skill tooltip re-prices
the same sentence the moment a loadout exists.

## POST /api/optimize/start

Body: `{ "loadout": {…}, "pins": { "gear": ["Slot_Weapon1"], "augments":
["Slot_Weapon1/AugmentDemon"], "skills": ["Slot_Weapon1"],
"runes": ["Mage_Blink"], "talents": false }, "options": { …same as sheet…,
"lookahead": 8, "restarts": 3, "allowEmpty": true, "talentPoints": null } }`

Pinned = "the user chose this, keep it"; everything else is searched.
`pins.runes` lists skill ids whose rune slot is pinned (to the loadout's
value, including null = pinned empty). `pins.talents` true = whole allocation
pinned.

→ `{ "job": "j1" }`

## GET /api/optimize/events?job=j1  (SSE)

- `event: progress`  `data: {"evals": 1234, "elapsed": 3.2}`
- `event: done`  `data: { "envelope": {…the optimize --json envelope…},
    "view": {…exactly the /api/sheet response shape for the winner…},
    "score": 532.4, "elapsed": 25.1 }`
- `event: error`  `data: {"error": "sentence"}`

`POST /api/optimize/cancel {job}` kills the worker.

The envelope must round-trip: saving it to a file and running
`node bin/bench.mjs sheet --build file.json` reproduces the same sheet.

## GET /asset/<path>

Raw file from res.pak (whitelisted prefixes `UI/`, `Font/`). PNGs only —
requesting a DDS-disguised-as-png here is a 404; those go through /icon/dds.
Cache-Control: immutable.

## GET /icon/dds/<b64url(pakPath)>.png?px=64

BC7 DDS → PNG at the smallest mip ≥ px (mip2 64px for px≤64 — no full
decode). Disk-cached in `.cache/ui-icons/`. Also accepts
`atlas:<cellIndex>` as the path for `farever-atlas-icons.dds` cells.

## Implementation pitfalls (verified — do not rediscover)

1. `engine.evaluate` THROWS on illegal loadouts → catch, return `illegal`
   via `illegalReason(cat, loadout)`.
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
   always multiply per row. Sniff DDS vs PNG by magic, not name.
9. Rune display text is `mastery[].text` (singular); statusType/itemType/
   gameTerm names nest `.name.v`.
10. Desc templates are the GAME's grammar, not a convention — port
    `HText.makeSkillText` (src/const/HText.hx:1036) rather than inventing one.
    The token is
    `::(-?)(ref([\d]*)_)?([a-zA-Z]+)([\d]*)(%?)(#?)::`, so **trailing digits
    are an index, not part of the name**: `val1` is the name `val` at index 0
    and `dmg2` the name `dmg` at index 1. Resolution runs whole-name specials
    (`charges`/`cooldown`/`dmgs`/`dur`/`duration`/`name`/`stacks`) → `vars`,
    **which override the specials** → the computed families (`atbgain`, `dmg`,
    `heal`, `shield`, `val`). `refN_` reads the N-th referenced status; `%`
    scales a stored fraction by 100 but NOT a value already in the attribute's
    own units, which is what the game decides by testing the affix's ref id
    for the substring `Ratio` (a flat +3 CritChance affix reads "3%", not
    "300%"). `#` is the status's LIVE stack count and is therefore 1 in a
    builder. `chance`/`threshold` carry CastleDB's `display: 1`
    (DisplayMode.Percent) and read as a percentage even written bare (69 descs
    do; the game prints "a 4% chance" off `vars.chance` 0.04). `[Term]` links
    resolve via `gameTerm`/attribute/statusType **and skill** names — twelve
    links in this build resolve nowhere but the skill row.
    `D:\Gits\farever-mods\tools\gen-atlas.mjs` (~line 1290) has an older,
    smaller version of the same substitution and no magnitudes at all.
17. Which effect `::dmgN::` names comes off `HSkill.getEffectIndex` (@20830),
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
11. Optimize child: in-process `optimize()` from `src/optimize.mjs` with
    `onProgress` (CLI stderr progress is TTY-gated = silent when piped).
12. `pointsAt(level)`: 0 below 10, else 16. Sigil-granted node: rank 1 in
    `loadout.talents`, zero cost, excluded from thresholds — recompute
    granted-ness from `augments` keys ending `/AugmentDemonSigil`.
13. Gear rarity is authored (single row); ONLY weapons roll. Stars clamp to
    `maxStars(item, rarity)`.
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
