# Combat log v1 - `farever-combat-log`

A combat log is one fight, written down as it happened: every hit, every
skill the character started, every status that went up and came down. The
bench holds its model against such a record (`bench verify --capture`), and a
player can send one to the project with the character sheet it was fought
with (`bench submit`, the UI's "Send a fight"). This page is the contract for
whoever writes one: an in-game mod, an external meter, a converter.

Two kinds of file are read:

- **`farever-combat-log` v1**, the format below. It is Wink's DPS Meter
  timeline layout with the same event field names, plus a header that says
  when the fight started, whose it was and which build of the game it was
  fought on, and a few optional fields the bench can use.
- **Wink's DPS Meter files, unchanged.** A Wink user hands the bench the two
  files the meter already saved; nothing has to be converted first. See
  [Wink's own files](#winks-own-files).

Ids are CastleDB row ids from the game's `data.cdb`, exactly as the game holds
them (`GA_Craft_Skill1`, `Warrior_BattleShoutStatus`, `Dummy`), never display
names. A display name joins nothing: the bench matches a hit to its own line by
the skill id and the target's unit id.

The machine-readable schema is [schema/combat-log.v1.json](schema/combat-log.v1.json)
(JSON Schema 2020-12). A short legal example, a Warrior with a great axe on the
training Dummy, is [examples/combat-log.jsonl](examples/combat-log.jsonl).
`bench import <file> --check` reads a log and says what it read, what it could
not use and why; it exits 1 when anything was wrong.

## The file

- JSON Lines, UTF-8: line 1 is the **header**, every following line is one
  **event**. Blank lines are skipped. A byte-order mark is tolerated.
- It may be gzip-compressed; the bench recognises gzip by its first two bytes
  (`1f 8b`), whatever the file is called.
- Two guards apply to every log, local or uploaded: the text is at most
  **64 MB** (a gzip file is inflated to 64 MB and no further), and it holds at
  most **2,000,000 events**. Anything past either is refused unread. One fight
  is a few megabytes. A submission is capped tighter: 20 MB uncompressed per
  log.
- Events should be written in time order. The reader sorts them by
  `(time, seq)` anyway, because the capture readers group rows by the exact
  millisecond.

## The header

```json
{ "format": "farever-combat-log", "version": 1,
  "source": { "exporter": "my-mod", "exporterVersion": "1.0.0",
              "gameVersion": "...", "steamBuild": "25959898", "bootSha256": "<hex>" },
  "startedAt": 1792324800000, "clock": "client-observed", "me": "812",
  "character": { "name": "Tester", "class": "Warrior", "level": 25 },
  "encounter": { "bossKind": "Dummy", "difficulty": 0, "targetDummy": true, "partySize": 1 },
  "initial": [ { "time": -0.5, "kind": "status_present", "source": "812", "target": "812",
                 "targetKind": "Warrior", "skill": "Warrior_BattleShoutStatus", "stacks": 1, "duration": 9.5 } ],
  "duration": 31.0, "count": 14 }
```

| field | type | required | meaning |
|---|---|---|---|
| `format` | string | **yes** | `"farever-combat-log"` |
| `version` | integer | **yes** | `1`. A newer version is refused with a sentence; the bench reads 1. |
| `startedAt` | number | **yes** | Epoch MILLISECONDS of time 0, the moment every event's `time` counts from. A value outside 2001-2286 is refused with a sentence: epoch seconds (`1792324800` for `1792324800000`) would date the fight in 1970. |
| `me` | string | **yes** | The uid of the character the log is for, exactly as the events write it in `source` and `target`. |
| `count` | integer | no | The number of event lines (the header and `initial` not counted). When present it must be a whole number and match, or the log is refused: a file cut short reads as another fight. |
| `duration` | number | no | Seconds, the fight's length. |
| `clock` | string | no | `"client-observed"` (what this client was told, and when) or `"server"`. Default `client-observed`. |
| `source.exporter`, `source.exporterVersion` | string | no | What wrote the file. |
| `source.bootSha256` | string | **should** | sha256 of the `hlboot.dat` the game ran from, hex. The only build identity the bench can hold against an install: with it, a log is placed on "this build"; without it, "cannot tell". See [the build](#which-build). |
| `source.steamBuild` | string | no | The Steam build id (`buildid` in `appmanifest_3672400.acf`). |
| `source.recordsPresses` | boolean | no | `true` says the log writes a `press` for every press of the character (an exporter that hooks the input path). See [presses](#presses-and-skill-starts). |
| `source.gameVersion` | string | no | The game's own version string, if the exporter can read it. |
| `character.name` | string | no | The character's name: the handle its rows are written under, and what `bench verify --character` selects. Replaced by `Submitter` in a submission unless the player keeps it. |
| `character.class` | string | no | Unit id (`Warrior`, `Rogue`, `Mage`, `Priest`) or aptitude id (`Fighter`, `Assassin`, `Wizard`, `Cleric`), any case. |
| `character.level` | integer | no | The character's level. |
| `encounter.bossKind` | string | no | Unit id of the boss or the target (`Ratsar`, `Dummy`). |
| `encounter.difficulty` | integer or string | no | The game's ActivityDifficulty: `0` Normal, `1` Veteran, `2` Heroic, `-1` unknown. The case names (`"Heroic"`) are read too, in any case. A value that is none of these is read as unknown, and said. |
| `encounter.activityId` | string | no | The activity row id. |
| `encounter.targetDummy` | boolean | no | A training-dummy fight. |
| `encounter.partySize` | integer | no | How many players were in the fight. `1` makes it solo (see [what a log is evidence of](#what-a-log-is-evidence-of)). |
| `encounter.outcome` | string | no | `Victory`, `Defeat` or empty. |
| `encounter.name` | string | no | A display name. Read for nothing, dropped from a submission. |
| `initial` | array of events | no | What was already standing at time 0: the statuses on the character and on the target, written as `status_present` events. They tell `bench verify` what stood when a window opens: a DoT already ticking on the dummy is named as "standing when the log opens" beside the hits it deals. Whether a hit was carried into a window is decided from the build's own fight, not from this list. An entry without a `time` stands at 0, or at the first event's time when the file opens earlier (a lead-in); either way it stands at a window that opens there. |
| `leadIn` | number | no | Seconds of lead-in before time 0 the file holds (events may have a negative `time`). |
| `startedAtEstimated` | boolean | no | `true` when `startedAt` was not observed but worked out (the bench writes it when it converts a Wink timeline that came without its summary). |

Any other header key is carried and ignored. A header without `format` is
not guessed at: one that carries `startedAt` and `me` is refused with a
sentence asking for `"format": "farever-combat-log"` (a Wink timeline header
never carries `startedAt`, so it cannot be one of those).

## Events

```json
{"seq":3,"time":0.412,"kind":"damage","source":"812","target":"900","targetKind":"Dummy","skill":"GA_Craft_Skill1","origin":"GA_Craft_Skill1","amount":486.31,"critical":false,"hits":1,"damageType":"physical","outcome":"Hit","affinity":"Physical","targetLevel":1}
```

The field names are Wink's (its `TimelineEvent`), so one reader takes both.

| field | type | meaning |
|---|---|---|
| `seq` | integer | Order of observation, unique in the file. `related` points at it. |
| `time` | number | Seconds from `startedAt`. May be negative inside a lead-in. **Required on every event.** An event more than 10,000,000 s (115 days) from `startedAt` is skipped and counted. |
| `kind` | string | What happened (the list below). **Required on every event.** |
| `source` | string | The uid that did it. A pet's hit names its OWNER here; `skill` stays the pet's own attack. |
| `target` | string | The uid it happened to. For a status, the uid that wears it. |
| `skill` | string | The CastleDB id of what produced the event: the skill for a hit, the STATUS for its ticks (a DoT's ticks carry the status id, not the skill that applied it), the pet's own skill for a pet's swing. This is the join key. |
| `origin` | string | The id of the parent skill: the skill that applied a status, the parent of a child skill. Not the join key. |
| `instance` | string | The uid of the skill or status OBJECT (one cast, one application). The target's instance is `target`, not this. |
| `amount` | number | Raw and unrounded, as received. One event per damage instance: a two-hit finisher is two events. |
| `critical` | boolean | The hit was critical. |
| `lethal` | boolean | The hit killed. |
| `hits` | integer | The game's hit count on the result. |
| `damageType` | string | `physical`, `magical`, `raw` or `unclassified`. Not an affinity: `magical` covers several. |
| `outcome` | string | On a `damage` event: `Hit`, `Blocked`, or the id of what blocked it. On an `avoided` event: the id of what avoided it (`DamageDodge`, `InvulnerableHit` - Wink writes these two only as `avoided`, never as `damage`). On `status_removed`: why (`Expired`, `Consumed`, ...). |
| `stacks` | integer | A status's stacks after the event. |
| `duration` | number | A status's time LEFT in seconds, `-1` when it has no clock. |
| `statusType` | string | `buff` or `debuff`. |
| `related` | integer | The `seq` of the use event this one belongs to (`skill_context`, `skill_end`). |
| `targetKind` | string | The unit id of the target (`Dummy`). |
| `estimated` | boolean | The amount was estimated (Wink, on heals it could not read; Wink then writes `amount` and `critical` as `null`, which the bench reads as absent and leaves out when it rewrites the log). |
| `item`, `itemName` | string | On a consumable's use: the item id (`ElixirOfMinorStrength`), and its name. |
| `sourceName`, `targetName`, `skillName` | string | Display names. `sourceName` and `targetName` name the players in the rows: the character, when the header does not, and every other player - a uid with a name and no unit kind, or a class's kind, is written under that name rather than as a uid. `skillName` is read for nothing. All three are dropped from a submission, where another player's are written `Player <their new uid>`. |
| `before`, `after`, `hiddenStatus`, `useDuration` | | Wink's own; carried and ignored. |
| `cause` | string | Wink's own free text; ignored, and left out of a submission's copy. |

Any other key is carried and ignored, never an error.

**uids are JSON strings**: `"812"`, not `812`. Decimal digits are best: the
bench writes a target as `<unit>#<uid>`, and its readers expect digits after
the `#`. A uid written as a number is read as a string and counted as a
problem.

### Required on a damage event

`time`, `kind` (`"damage"`), `source`, `skill` (non-empty), `amount`,
`critical`.

`target` and `targetKind` are strongly recommended. Without them the hit is
read against a target that names no unit - `?#-1` with no `target`,
`?#<uid>` with a `target` and no `targetKind`, `<unit>#-1` with a
`targetKind` and no `target` - which no `--target` filter matches, and it is
counted as a problem. A hit on the character, or on another player the log
names (a uid with a display name, or listed among a Wink summary's players,
and no unit kind), needs no `targetKind`: it is read against that player's
handle (see [Who](#how-a-log-becomes-the-benchs-rows)) and not counted. A
damage event without a skill, an amount or a source is not read at all, and
counted. One that does not say whether it was critical is read as not
critical, and counted.

### Kinds

| kind | what it is | what the bench reads it as |
|---|---|---|
| `damage` | a hit that landed (blocked or not) | an `inflict` row: the evidence |
| `avoided` | a hit dodged or made harmless (`outcome` `DamageDodge` or `InvulnerableHit`), amount 0 | an `avoided` row, never damage |
| `heal` | a heal | carried, not compared |
| `press` | **bench addition**: a player INPUT, for an exporter that hooks the input path | a press |
| `skill_use` | a skill STARTED on the client | a press, with `via=start` (see [below](#presses-and-skill-starts)); by the character, also a skill start |
| `block_use` | a block started | a press, with `use=block`; by the character, also a skill start |
| `dodge_use` | a dash | a `dodge` row |
| `skill_context` | where a use was aimed (`related` = the use's `seq`) | folded into its press, as the press's target |
| `skill_end` | a skill stopped | a `skill_end` row |
| `block_success` | a block that caught a hit | carried |
| `status_applied`, `status_present` | a status put up, or already up | `status_on` |
| `status_refreshed`, `status_duration` | a status's clock restarted or changed | `status_refresh` |
| `status_stacks` | a status's stacks changed | `status_stacks` |
| `status_removed` | a status came down (`outcome` says why) | `status_off` |
| `shield_*`, `proc_*`, `charge_update`, `health_loss`, `health_sample`, `death`, `recording_*` | Wink's other observations | carried, not compared |

A `recording_gap` is the recorder saying an observation failed; the bench says
the log may be missing rows.

### Presses and skill starts

**A `skill_use` is not a press.** Wink's `skill_use` fires on the client's skill
start, which includes skills the game started on its own and child skills a
parent started. The bench reads a `skill_use` (or `block_use`) by the character
as a press only when its `origin` is absent or is the skill itself; a child's
start is not a press. An exporter that can hook the input path should write
kind `press` instead: that is what the bench's own probe records.

**Whether a log records presses** is said once, for the whole file. One that
holds any `press`, `skill_use` or `block_use` of the character does; so does
every Wink timeline, which writes a `skill_use` for every skill its character
starts; and so does one whose header sets `source.recordsPresses: true`. An
exporter that writes `press` rows should set it: a log of the base-attack
chain alone holds no press, and without the declaration it cannot be told
from a log that never writes one. In a log that records presses, a window
with no press is a window in which nothing was pressed, and `bench verify`
plays the model's fight pressing nothing. In one that does not, a window with
no press says nothing about what was pressed, and the model plays its own
rotation. `bench import` says which of the two a log is.

**A skill start** - every `skill_use` and `block_use` of the character, a
child's start included - is also the moment the character's state became a
skill, which the bench's probe writes as a row of its own. `bench verify
--replay` opens its fight where the first one in the window stands. A
window with no skill start - a log that writes `press` rows and no
`skill_use` - opens at the character's first press in it, or at its first
hit of the base-attack chain when that comes earlier (a hit lands a windup
after its swing began, so the fight then opens that much late). The
`replay:` line says which, and `--json` gives it as `replay.opensFrom`
([below](#what-bench-verify-says-about-a-log)).

**Pools.** `rage` and `spark` (bench additions, below) on the character's
presses and skill starts say where its Rage and Spark stood at that moment.
`bench verify` opens a Mage's fight at the Spark the window's first such
event carries: a conduit fires only on a spend from above the gauge, so the
pool at the opening decides whether any fires in the window. A log with no
`spark` on those events, or none in the window, opens the model's fight on
a full gauge, and verify says so. `rage` is carried, and read by nothing
yet.

### Bench additions

All optional, and not all of them are read yet. Three kinds:

- **read by `bench verify` today**: `affinity`, `targetLevel` and `spark`
  (each one a check it cannot make without it, see [what each field unlocks](#what-each-field-unlocks));
- **used to name rows**: `sourceKind`;
- **carried**: the rest reach the bench's rows or a submission and are read by
  nothing yet. `targetHp`, `targetMaxHp`, `targetArmor` and `targetMagicArmor`
  land in each hit's row under the keys the bench's own probe writes (`thp`,
  `tmax`, `tarm`, `tmarm`), and `rage` in each press's; `blocked`, `overkill`,
  `absorbed`, `summoned`, `isBaseAttack` and `stepId` are kept in the file and
  in a submission's copy.

| field | type | read | meaning |
|---|---|---|---|
| `sourceKind` | string | names rows | The unit id of the source, after owner attribution. A uid some event gives a kind is written `<kind>#<uid>` in the rows. |
| `affinity` | string | **verify** | The hit's affinity id (`Physical`, `Magic`, `Spark`, `Chaos`, `Light`...). Never derived from `damageType`. |
| `targetLevel` | integer | **verify** | The level the target stood at. |
| `targetHp`, `targetMaxHp` | number | carried | The target's health and maximum health at the hit. |
| `targetArmor`, `targetMagicArmor` | number | carried | The target's live armour and magic armour. |
| `blocked`, `overkill`, `absorbed` | number | carried | The amount a block took, past the target's last health point, and into a shield. |
| `summoned` | boolean | carried | A pet of `source` dealt it. |
| `isBaseAttack` | boolean | carried | The hit was a base attack. |
| `stepId` | string or integer | carried | The skill step that dealt it. |
| `spark` | number | **verify** | On a `press`, `skill_use` or `block_use` of the character: its Spark at that moment. |
| `rage` | number | carried | The same, for its Rage. |

## What each field unlocks

`bench verify` compares the model's line for each skill with the log's hits of
that skill. What it can check depends on what the log carries.

| the log carries | the bench can |
|---|---|
| `skill`, `amount`, `critical` on each hit | compare the mean hit per skill, ordinary and critical hits apart, the share, the crit rate, and whether the game rounded that path (a stream of whole numbers) |
| `targetKind` | filter to one target (`--target Dummy`) and price the model against that unit's armour |
| `target` (an instance uid) | hold the rows to the one target being fought, not its neighbours |
| `targetLevel` | stand the model's target at the level it stood at |
| `encounter.difficulty` | price a Veteran or Heroic fight as one, where the level alone cannot say which |
| `affinity` | split one skill into its parts (a status's tick and its direct hit) |
| `press` / `skill_use` with targets | hold the model to what was pressed, file what was never pressed, replay the sequence (`--replay`), follow the target |
| `source.recordsPresses` (or any press of the character) | read a window with no press as one in which nothing was pressed, not as one that says nothing |
| `skill_use` / `block_use` of the character | open `--replay`'s fight where the character's first skill started, not at its first press or swing |
| `spark` on the character's presses and starts | open a Mage's fight at the Spark the window opens on |
| statuses with `stacks` and `duration`, and `initial` | name what stood when a window opened, beside the hits filed as carried in; read a mechanic's stacks |
| `source.bootSha256` | say the log was recorded on the installed build |
| `encounter.partySize` | tell a solo fight from a party fight |

## What `bench verify` says about a log

Above its table, `bench verify --capture <log>` says what the log let it
check and what it did not, one line each:

- `capture:` - which build the log was recorded on (see [which
  build](#which-build)).
- `log:` - what the reader said of the file: each problem it named (a hit
  read against no target, a `recording_gap`, a summary beside the timeline
  that did not read...), in the warning colour, and each note the ledger
  stands on (an estimated start time, what a Wink file cannot hold, a party
  fight) - and, in a `farever-combat-log`, how many of the character's hits
  carry no `affinity` or no `targetLevel`. The reader's word on the
  difficulty is not among them: verify says its own, since the difficulty
  prices the target.
- `presses:` - in a log that records no press of the character and does not
  declare that it does (`source.recordsPresses`), that the model plays its
  own rotation, and that what it presses which the log has no row of is its
  choice, not evidence (with `--replay`: that there is no recorded sequence
  to play). In a log that records presses, a window with none: the model
  plays the base-attack chain alone.
- `Spark:` - for a build with a Spark gauge (a Mage), when the log carries
  no `spark` on the character's presses or skill starts, or none in the
  window: the model's fight opens on a full gauge.
- `replay:` - with `--replay`, how many recorded presses the model played,
  and where its fight opened: "where the log's first skill state does", "at
  <character>'s first press (the log writes no skill start)", or "at
  <character>'s first base-attack hit".

`--json` carries the same as data. Its `combatLog` object (null for the
probe's own capture) holds `dialect`, `handle` (the name the character's
rows are written under), `difficulty` (the one the log names, null for
none),
`note` and `pricedByLog` (what verify made of that difficulty), `levelNote`
(the log's own level for its character, when the build's is another),
`problems` and `notes` (the `log:` lines), `presses` (whether the log
records its character's presses), `pressesDeclared` (whether it says so:
`source.recordsPresses`, or a Wink timeline), `pools` (the pools it carries
a value of on the character's rows: `rage`, `spark`) and `gaugeNote` (the
`Spark:` line, or null). With `--replay`, `replay.opens` is the second of
the window at which the fight opened (null: nothing said where) and
`replay.opensFrom` what said so: `state` (a skill start), `press` or `hit`.

## What a log is evidence of

A hit in a solo fight is evidence a formula can be held to. A local player's
hits in a party fight are evidence of totals only, unless the exporter wrote
every player's events: what the others put on the target (an armour shred, a
damage-taken debuff) raised the live damage, and if it is not in the file, a
correct model reads low beside it. So a fight with `partySize` 1, or a dummy
with nobody else near, is the useful kind.

## Which build

A log is evidence about the build it was fought on and no other. The bench's
own probe names the `hlboot.dat` it booted from in a `session` row; a log
written by anything else names its build by its header: `source.bootSha256`,
else `source.steamBuild`, else `source.gameVersion` (for a Wink pair, the
summary's `gameVersion`). Its dates never place it on a build: a file time is
local to one machine, and a download time is no fight's time.

So `bench verify` says "recorded on this build" only when the header's
`bootSha256` equals the installed `hlboot.dat`'s. Any other answer is "cannot
tell", with both named - never "another build", which would, for instance,
price the training Dummy at the armour it had before the 2026-10 build.

## Wink's own files

Wink's DPS Meter saves every boss, dungeon, world-boss and target-dummy fight
as two files under the game folder:

```
<Farever>/hlx/mods/dps-meter/history/<encounter - difficulty>/<id>.json
<Farever>/hlx/mods/dps-meter/history/<encounter - difficulty>/<id>.json.timeline
```

- The `.json.timeline` is the per-event file: a header
  `{version, me, duration, initial, count, clock, leadIn}` and one event per
  line, the fields above. This is the one `bench verify --capture` reads.
- The `.json` is the fight summary: the start time, the encounter
  (`bossKind`, `difficulty`, `partySize`, `outcome`, `targetDummy`), the game
  version, and per-player totals per skill.

Give the bench the `.json.timeline`. When the `.json` sits beside it with the
same name, it is found and read with it: the start time comes from it, and so
do the encounter facts and the game version. Without it (or with a summary
whose `startedAt` is no time a fight starts at), the start is estimated as the
timeline's modification time minus the fight's duration, and the bench says
so. When sending a fight, select both files.

A `.json` on its own is a **summary-only log**: per-skill totals, no events.
It can travel with a submission as evidence of totals, and `bench verify`
refuses it, because its per-skill rows are filed under the skill that STARTED
each hit (a status's ticks under the skill that applied it, a pet's swings
under the skill that summoned it) and sum every target - they cannot be joined
to the bench's per-hit lines.

A rift recap is not read in v1: `recap_<id>.json` (`"kind": "rift-recap"`, a
rift's gate and boss phases in one record) and its `recap_<id>.json.timeline`
are both refused, the timeline told by the recap beside it or by Wink's name
for it. Wink also saves each phase of the rift as an ordinary fight, in the
rift's own history folder: give the bench that fight's
`fight_<id>.json.timeline`, with its `fight_<id>.json` beside it.

### Wink's limits

These are true of every Wink file, and the bench says the ones that apply:

- An event is kept only when the character is its source or its target. A
  party member's hits, and the debuffs they put on the target, are not in the
  file.
- `skill_use` is a skill start, automatic and child starts included (see
  above). A block is a `block_use`, a dash a `dodge_use`.
- No target level and no affinity: the target stands at its row's level, and a
  skill logged under two affinities is compared as one.
- No `rage` or `spark`: a Mage's model fight opens on a full gauge, not on
  the Spark the character had, and verify says so.
- The clock is what the client observed, not the server's.
- Only boss, dungeon, world-boss and target-dummy fights are saved.
- The SUMMARY leaves out dodged and invulnerable hits; the timeline keeps them
  as `avoided`, amount 0. A blocked hit is still `damage`, with
  `outcome` `Blocked` or the blocker's id.
- The summary writes no target level, and its per-skill ids are origin ids
  (above).

When both files are read, the bench folds the timeline's damage by `origin`
and compares it with the summary per skill, and says where the two differ.

## How a log becomes the bench's rows

The bench's readers take the rows its own probe writes:
`{ts, event, source, target, skill, amount, crit, stacks, extra}`. A combat log
is turned into those rows once, and every `bench verify` feature reads them
unchanged.

- `ts` = `round(startedAt + time * 1000)`, integer milliseconds. Rows are
  sorted by `(time, seq)`, the `initial` statuses first.
- **Who.** The character (`me`) is its handle: `character.name`, else the
  summary's player name, else the `sourceName` on one of its own events, else
  `me`. A uid that some event gives a unit kind (`targetKind`, or `sourceKind`)
  is `<kind>#<uid>` (`Dummy#900`), the form the probe writes a creature in -
  unless the kind is a class's: that uid is a player, as is a named uid with
  no kind, and a player keeps its name (`player<uid>` when it has none).
  Anything else is `?#<uid>`.
- **The first row** is one synthetic `session` row at the first row's time:
  `probe=<dialect>;boot=unreadable;build=<bootSha256|steamBuild|gameVersion|unknown>;presses=<0|1>`.
  The build is written as the header has it (a sha256 in lower case), but for
  a `;` or a control character, each run of which becomes one space.
  `presses=1` when the log records presses ([above](#presses-and-skill-starts)):
  it holds a `press`, `skill_use` or `block_use` of the character, declares
  `source.recordsPresses`, or is a Wink timeline. A window in it with no press
  is then a window in which nothing was pressed; `presses=0` says the log
  records no press at all, so a window in it with none says nothing about
  what was pressed.
- **`initial` rows carry `initial=1`** in their extra, which is how the
  ledger tells a status that stood when the log opened from one put up
  later.

| event | row |
|---|---|
| `damage` | `inflict`: source = who(source), target = `<targetKind or ?>#<target or -1>` (a player's handle when the target is the character or another player, as the probe writes a player), amount as is, crit = `critical`, extra `origin=;dtype=;outcome=` and, only from the bench additions, `affinity=;tlvl=;thp=;tmax=;tarm=;tmarm=` |
| `avoided` | `avoided`, amount 0 - never `inflict` |
| `press` | `press`: target `T:<kind>#<uid>` or `T:`, extra `kind=<skill>;via=input`, and `rage=`, `spark=` when the event carries them |
| `skill_use`, `block_use` by the character, `origin` absent or equal to `skill` | `press`: target from the use, else from the `skill_context` whose `related` is its `seq`, else `T:`; extra `kind=<skill>;via=start` (and `use=block`), `rage=`, `spark=`. And a `go_state` row: no source, the handle as target, extra `state=Skill` with the same `rage=`, `spark=` |
| `skill_use`, `block_use` by the character that another skill started | a row of its own kind, and the same `go_state` row |
| `dodge_use` | `dodge` |
| `skill_context` | folded into its press |
| `skill_end` | `skill_end` |
| `status_applied`, `status_present` (in the events or in `initial[]`) | `status_on`: source = who applied it, target = who wears it, stacks, extra `ok=1` and `dur=<duration>` when above 0 |
| `status_refreshed`, `status_duration` | `status_refresh`, extra `refresh_dur=<duration>` when above 0 |
| `status_stacks` | `status_stacks` |
| `status_removed` | `status_off`, extra `reason=<outcome>` |
| anything else, in the events or in `initial[]` (Wink writes a proc standing at the opening there as `proc_present`) | a row of that kind, which `verify` ignores |

## Sending a fight

`bench submit` and the UI's "Send a fight" convert every log to
`farever-combat-log` v1 before anything leaves the machine, rebuilding each
record from the fields on this page and nothing else. Of those, the display
names (`sourceName`, `targetName`, `skillName`, `itemName`, `encounter.name`)
and Wink's free-text `cause` are left out, and so is a value that does not
have its field's type, a `damageType` that is none of the four, or a
`targetKind` / `sourceKind` that is no unit of the game.

The header's facts are held to shapes, and one that does not have its shape
is left out: the exporter's name and version (one token each), the game
version, the Steam build (digits), `bootSha256` (64 hex characters), the
`clock` (one of the two), the character's class (one word), the boss (a
unit of the game), the activity (a game id) and the outcome (`Victory` or
`Defeat`). So is one with a name inside it - in any case, in any Unicode
form, or spelt with a Cyrillic or Greek letter that looks Latin. Wink's
summary, beside a timeline, is rebuilt the same way. A log that records its
character's presses says so in the copy (`source.recordsPresses: true`, a
Wink timeline's included), so the copy is read as the original is.

Every uid is renumbered (`me` becomes `"1"`); another player's
`sourceName` and `targetName` are written as `Player <their new uid>`, so the
copy still tells a player from a creature; and the character's own name
becomes `Submitter` unless the player keeps it. A copy in which a removed
name still turns up, as a whole value or inside one, is not sent. What is
sent, what is public and how to ask for a submission's deletion are in
[SUBMITTING.md](SUBMITTING.md).
