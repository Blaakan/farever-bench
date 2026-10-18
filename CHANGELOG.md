# Changelog

Every release of farever-bench, newest first:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape,
[semver](https://semver.org/spec/v2.0.0.html) numbers. `package.json` and
`ui/package.json` always carry the same version - `tools/release.mjs` moves
them together and refuses to run when they disagree.

## [0.5.0] - 2026-10-18

The September 30 update (Farever build 25782799, bytecode v6), end to end,
and the two hotfix builds that followed it (25933712 on 2026-10-14, 25959898
on 2026-10-15). The update went through `bench update` first on the public
test branch and then live; the pipeline was fixed where it fell short, every
rule the update moved was re-read on the new build, what it added was
implemented, on 2026-10-13 the game was measured on it for the first time,
and the model was then held against those rows one block of play at a time.
The hotfixes went through the same pipeline before any of it was accepted.
Every default number moves, on every class. What moved them is READ from the
new build; `bench audit` says, entry by entry, which of it the capture
measured (44 of its 121 entries are verified) and which is still an
assumption, with both numbers where the read and the rows disagree. The
capture is of build 25782799; nothing has been measured on either hotfix.

### Known issues

What the 2026-10-13 capture or the reads already show is off in this
version. Each one is an entry in `bench audit`, with both figures where the
read and the rows disagree.

- **Base attacks run 5-8% fast in rate.** In game the hero stands in a Free
  state for a frame before every link of the chain; the fight does not, so
  every line that rides the chain is over-rated by that much a second (per
  hit they agree).
- **Infusion sets have never been measured.** They are read from their
  scripts; no captured character wore one. Their own lines are 3-12% of
  each class's default build, and three of those builds also count Wet's
  +6% damage taken.
- **The Rogue's rate reads 4.8% high** over sixteen rotation steps, like
  for like, and Urge to Kill is in no number: the model's Finishers spend
  2.1 points where the capture's spent 4.1.
- **Domination's rank-3 bonus is averaged** over the share of the fight the
  foe is controlled, where the game pays it per hit (Raging Smash +5.5%,
  Tear Reality +4.9% in their own blocks).
- **The Raclette Pan's crit stacks are priced as read** (+0.5 CritChance
  each), and the one wearer measured did not show them: 16.1% critical at
  ten stacks against 21.7% priced.
- **The search can stop short.** The Warrior's default search settles at
  841.7 where its previous optimum still prices 846.3 on the same rows.
- **Read and not priced:** Spark Surge and the Spark Cube, six Mage talents,
  Expulse beyond one orb, Going With the Flow, Water Veil's heal. Each says
  so in `bench audit` and under `--verbose`.
- **Nothing is measured on the two hotfix builds**, and heroic targets are
  read from the client, not measured.

### Fixed

- The bytecode reader refused the new build outright: the update ships HashLink
  bytecode version 6, which adds one index per debug local (the op where its
  scope ends). The reader now accepts v2-v6 and still parses the whole file
  to exactly EOF.
- **Base attacks were priced by the previous build's rule**, which the update
  replaced: a swing now scales on the mean, over the weapon's aptitudes, of
  0.4 x the aptitude's budget + 0.6 x its attribute, where it was 0.4 x the
  SUM of the budgets plus the whole attribute. A dual-aptitude swing prices
  about 0.53x what it did and a single-aptitude one about 0.76x. Read on the
  new build and measured on four weapons on 2026-10-13: with each weapon in
  a chain block of its own, the ordinary swing reads within 3% of its price
  on fifteen of seventeen links; the two others are the Warrior's third
  (the model 4.1% over on 17 swings) and the Mage's second (6.6% over on 13).
- **Gear was offered at rarities it cannot have.** Only a weapon rolls its
  rarity; armour and jewellery keep their row's, and the update's Epic armour
  is a separate set of rows. The search no longer prices a Rare chest "as
  Epic", `--pin <gear>@Epic` is refused with the id of the row that is Epic,
  and a weapon's roll share is normalised the way the game draws it (a
  Rare-authored weapon at level 25: Rare 71.4%, Epic 27.1%, Legendary 1.4%).
- **Epic pieces were offered to characters who cannot have one.** Every Epic
  armour piece and trinket is made at the level cap, by a Heroic boss or a
  cache; below it they are not offered, and at it they are priced at item
  level 300, not at an authored level plus the rarity bonus.
- **The training dummy is not a zero-mitigation target any more.** Its row
  authors 40% armour on this build and it stands at level 1, so a level-25
  character gets 89.9% through. `--target dummy` is that unit; the new
  `--target none` mitigates nothing.
- **A unit's armour is one row, not a sum over its parents.** The target
  ladder read 12 to 18 points of mitigation too hard wherever a unit inherits
  a row and authors its own (`small` 43% for 25%, `big` 49% for 35%, `elite`
  52% for 40%), and bosses stood at fitted levels the logged levels
  contradict. A unit now stands at its row's level and resolves one row.
- **The Rogue's Finisher was priced twice** - its melee and its ranged step
  are one hit, chosen by what is in the main hand.
- **The Rogue's poison tree was priced at nothing**: Lethal Poison is applied
  by three doses of different kinds on this build, re-applying it deals a
  direct hit, and twelve talents ride it. All read and played in the fight;
  see Added.
- **The Mage's chain register was lost** on the new build (the talent's
  script reads another accessor), and a node held both as a talent point and
  from a sigil armed two chains. One chain, keyed to Chaincast's counter, and
  Chain Strike reaches the finisher.
- **Prayers fired on every combo finisher.** A prayer is readied by its own
  event and RELEASED by Judgment: the pre-patch capture shows 2,052 of one
  Priest's 2,060 Smite casts within 1.5s of a Judgment press.
- **Sunlight was worn on every press.** It is put up when a hit of a skill or
  a released prayer of yours lands on an ally (solo: on you), lasts 6s, and
  the first finisher spends it unless Solar Devotion is held.
- **A weapon whose row lists fewer chain links than its weapon class declares
  was padded with other rows.** Nothing on this build reads that length:
  Flame of Argol is one swing and its finisher, Twin Pillars of Justice three
  and its finisher. Read, not yet watched in game, and said on the weapon's
  line.
- **Brutal Frenzy's second strike** is rolled at a quarter for 0.63 of the
  hit now, not 15% of every attack for a fifth; the row was retuned and the
  reader followed it. The strike rolls again on its own hit, so a finisher
  is followed by a third of a strike on average (0.25 / 0.75), not a
  quarter: 42 strikes after 112 finishers in the 2026-10-13 rows, 0.375.
- **A pet's hit reached its owner through the wrong hook.** The build routes
  a summon's damage through proxy hooks: the Silhouette of Almaz's imp rider
  and charge feed, Mad Buzz and Swarmstrike Accord are read there.
- **A status tick took its wearer's Fervor, mastery and crit.** On this build
  the code reads the unit that APPLIED the status; `--tick-source carrier`
  keeps the previous build's rule.
- **A pool bleed that is not Raw** (Bonethrow's) takes the target's armour on
  each tick as well as on the hit that banked it.
- **An enchant in the arsenal weapon was priced, and does nothing.** The
  arsenal weapon hands out no skill from its sockets (read from the two
  gates in `Gear.getSkills` and `Weapon.canGiveSlotSkills`; a Rogue with
  Devote in her arsenal daggers logged not one stack in 15,489 damage rows).
  All four default optima wore a second enchant there. Nor does it hand out
  its Block: a staff with dual swords behind it reads Withstand's 50, not
  100.
- **A status was scaled off its wearer where the game scales it through the
  item that granted it.** A trinket's status prices off the trinket alone
  (Finger of Sukuna'Maatata: 36.25 a tick where the bench said 45, 37
  logged), and a weapon-granted Raw tick takes the weapon mix.
- **A tick's divisor, its target and its riders.** A spread loop is divided
  by the ticks its step expects (Gash pays its whole amount over four ticks,
  not four and a half); a tick is priced against what the TARGET wears when
  it lands, the applier's side staying as it was applied; the `dmgMult`
  hooks and the crit grants reach Raw status hits; what a status on the
  target adds to the hits it receives sums with the attacker's own riders
  instead of multiplying (Death Mark's +15%).
- **A looping area landed a hit at spawn it does not land.** Only an
  instantiated area does; an aura that follows its wearer for the row's life
  is not one. Hive Swarm 11 events to 10, Swirling Embers 9 to 8,
  Pestilential Aura 7 to 6, each held by the rows.
- **A slotted rune's `vars` were ignored** where the rune restates a key of
  its row (Radiant Verdict under Consecration: four floor hits, not five).
- **A status step a swing plays was taken for an attack.** It is one only
  where the step carries the flag, so Zealous Fighter's crit chance and
  Might of the Executioner's crit damage no longer ride Purging Strikes or
  Sunlight (9.9% critical over 302 hits where the swings read 17.6%).
- **Queen's Decree, Worldsplitter's passive and the Chaos Mark were refused
  or mispriced.** Queen's Decree adds 1 inside the damage bracket of the
  next magic skill that finds it ready, and at rank 3 strikes on your
  critical hits while its cooldown runs; Resilience of the Unkillable Demon
  King adds 30% to a finisher pressed while it is ready and its cooldown is
  shortened by swings; Demonic Bite lays a mark Infernal Plunge consumes for
  a reset, and Chaotic Flames waits for a third use inside five seconds.
- **A weapon upgrade that "attacks twice"** is a second hit at the perk's
  chance, not that much more damage on the first.
- **Riders behind a status type were paid always.** Scorch's crit chance
  against a burning target is paid while one of your own burns stands.
- **Judgment was pressed with nothing to release.** It needs a ready prayer;
  it is kept for a release worth something to the goal, and a status handed
  out at a count of ready prayers the build cannot reach is said to be off.
- **An arsenal passive's stack-driven cast was on two lines**, both in the
  headline, when the passive was also slotted (one counter per host now).
- **The fight opened the window of a debuff the target refuses**, and a
  counting dot counted it.
- **Combo Points were paid on every weapon skill and finisher.** The row
  pays a skill different from the last one it paid, and the Finisher is
  priced at the points the pool holds when it is pressed; Acidic Splatter
  rolls on those points.
- **A damaging status rolled in a damage hook was floored to the swing
  clock.** It is rolled on every damage instance you land (the Finger of
  Sukuna'Maatata's curse).
- **Cooldown Reduction on a timed status was worth nothing to cooldowns.** It
  is read when a cooldown starts and held for that cooldown (read off
  `Skill.onTriggerCD` and `Skill.update`; measured on four cooldowns that
  straddle Mystic Empowerment), so Mystic Empowerment is priced on the Mage
  who casts it, with its three runes, and Crusader's and Dark Gift's
  reductions are live.
- **The Mage's conduits**: copies of one conduit add their stacks, the Power
  buff ramps from the fight's own trigger events when no damage conduit is
  slotted, and Spark is spent and never required (a press short of Spark
  goes off, as logged). Inner Demon's clock opens ready and takes Cooldown
  Reduction.
- **The level a piece is priced at was described wrongly.** A weapon and a
  piece of worn armour stand at the drop's level with the row's as a floor
  (held by the capture); jewellery at its row's level is an assumption the
  capture does not hold, said with both numbers. `bench items` prints the
  priced level beside the row's.
- **A talent point that bought nothing is handed back.** The default Mage
  reads "14 of 16 points spent, 2 unspent".
- **Unknown flags ran the defaults.** A flag the command line does not read
  is refused with the nearest names; `--talent` is read before `--skills`
  and `--rune`, so a conduit a talent grants can be named in the same
  command; an infusion the command line cannot place is refused with what
  was typed and the list.
- `--rotation-file` refused the file `bench rotation --json` writes. It
  reads it, and `bench sheet --build <that file>` plays the saved rotation
  and says so.
- **Refusals whose reason was false, second pass**: Opportunity Strike is
  filed `off in this build` with the rows that show it does nothing (187 of
  381 basic hits carried the refresh and no swing landed twice); Mystic
  Empowerment's status is the caster's, not "an ally's"; the Mage's third
  conduit slot is no longer listed as an unscored skill; Zeal says it works
  on Zealous Spins alone; Going With the Flow says what its script does and
  that it is not priced; Soothing Rays is priced as a share of Sunlight's
  damage.
- **Rank gates on a rider were read off the wrong object or the wrong
  namespace** in several kits: Deadeye Focus's status is applied at every
  rank and rank 3 gates its bonus; a talent's amount is its `rankOverride`
  value, not the first rank times the points (Red Tempo, Magic Conduction);
  a braceless `if` no longer lends its condition to the statement after it
  (Nectar-infused Blade's extra hit is not crit-gated).
- **Refusals whose stated reason was false**, across all four classes: a
  clause the tool had read and answered no was filed under "cannot evaluate";
  `bench talents` printed "nothing" for nodes the fight scores and a
  structure paragraph that contradicted its own table; the optimize header
  said "13 of 16 points spent" above sixteen points; Rampage's kill-reset
  sentence was printed at ranks where the script has no reset.
- **Three readers the hotfix scripts moved under** (build 25959898).
  Expulse's recast (the Book of Mi'Mizan) counts its orbs through a helper
  of its script, and the reader priced one orb a press whether or not the
  spheres it pulls in were there, without a word; it reads the helper, and
  the recast is again worth nothing without Abyssal Rise and one orb a
  press with it, said on the line. Acidic Splatter's script reads the Combo Points when the
  Finisher is used and rolls on its first hit or its projectile's: the
  reader had lost the chance per point (a flat 20%) and filed the armour
  break as unreadable, and both are back. Shred, Knives Tempest's armour
  break, lasts 10s on that build where it lasted 3s, and the audit reads its
  lifetime off the row.
- **A heroic boss is one whose dungeon has Heroic released.** Build 25959898
  links a heroic loot table on four more bosses and releases the Heroic of
  two of their dungeons, Cheese Station (Munster Chuck) and Crimson Barracks
  (Robin Hoof); Chakram's Chapel and Honeyzabeth's Hivetrunk still mark
  Development. The release is read from the dungeon's level file, where the
  loot side reads it: ten heroic bosses, and what is withheld follows.
- **A press flagged NonInterupting takes no control of the hero.**
  `GameObject.doUseSkill` neither stops the running skill for it nor, since
  build 25959898, puts the hero in the Skill state; the fight reads the flag
  off the row (Bubble Bullet and the row that uses a consumable carry it).
- `bench update` aborted entirely when the bytecode could not be read, hiding
  the data drift behind it. The two halves are now independent: an unreadable
  bytecode reports its citations as UNCHECKED and the rest still prints.
- A bare citation name matching several functions (`reset` matches forty)
  re-anchored to whichever came first in the table. A patch moves each class
  block by its own amount (+55, +74 and +1192 on the test build), so the
  resolver measures that shift from the unambiguous citations nearest the
  cache and takes the candidate nearest the predicted findex; a pick still
  off the prediction is SUSPECT, listed with its alternatives, never
  recorded, and blocks `--accept` until the citation is qualified.
- `bench update` dropped its `--game` flag and fell through to the cached
  install path - with a live and a test build side by side, a report about
  the wrong one. It is honoured now. A refused `--accept` and a refused
  baseline exit 1, and `--json` is written even when there is no drift.
- `moveSet` (a weapon class's range, which a step condition now asks about)
  and `craft` (what counts as crafted) are read by the model but were not
  fingerprinted, so a patch to either was invisible; nor were `gameTerm`,
  `color`, `icon`, `gameBeat`, `text`, `faction` and `lootTable`, which the
  UI server and the source reader use. All are tracked now, and the suite
  lints the sheet list against every sheet name read through a cdb in src/,
  bin/, tools/ and ui/.
- `--character` on a command other than `bench verify` is refused instead of
  ignored.
- Opcode 101, carried as a fork-only opcode of unknown purpose, is upstream
  HashLink's `OCatch`; renamed, and the listing prints the caught type.
- The suite pinned the bytecode version, the function count and findexes as
  literals; it checks the version range, finds functions by name, and holds
  each bytecode read it relies on to the shape of the function it was read
  from.
- UI: tooltip corrections against the game's own text builder (a `1 - val`
  multiplier, two-decimal percents, metres, link order and postfix letters);
  the weapon-upgrade passive's rank in skill tooltips; a sigil's effect line;
  armour rarity in the picker; list order by the level a piece is priced at;
  and a skill pool is pinned only when your selection fills it, with a pip to
  unpin - any click used to pin it, and the optimizer returned your own
  half-made selection.
- UI: a request the engine refuses is a 400 with the engine's sentence -
  an unknown target, a loadout that is not an object, an illegal seed, an
  infusion on a slot that is not pinned or a bonus stat that is not one, a
  `targetLevel`, `targets`, `rank`, `lookahead` or `mix` that is not a
  number in range - `/api/catalog` asks for its class, and
  `/api/optimize/start` refuses before it supersedes a running search.

### Added

- **Infusion**, the update's gear system. An infusion is a set passive on a
  piece of Epic faction armour; 2 / 4 / 6 pieces carrying the same one are
  its rank 1 / 2 / 3, a rank of its own that `--rank` does not reach. The
  bench reads which pieces can carry one, the set's stat rows, the bonus
  rating a faction-matched or Prismatic piece pays (+14 / +10 / +7 by slot at
  level 25), and what 8 of the 15 set scripts do in a fight - Hive Venom, Wet
  and Bubble Bullet, Melted Cheese and Fermented, Seals of Atonement and the
  rest - each at the set's own rank; everything else a set does is refused
  by name with its reason. The search plans sets across the eight armour
  slots. Pins: `--pin <slot>=<item>~<infusion>[/<rating>][!]`, `~none`.
  Flags: `--infusions learnable|all|none|<list>`, `--infusion-stat
  none|best|<rating>`. `bench sheet` and `bench optimize` print an INFUSION
  block, `bench slots` and `bench items` an infusion column. All of it is
  read. None of the four captured characters wears one; other players' rows
  in the same log (9,657 of them, with no build or sheet behind them) settle
  when Seals of Atonement, Hive Venom and Fermentation fire and how often,
  and no amount. A set's status on the foe is a status of its type to every
  reader of that type: Hive Venom is one more poison to Intent to Kill and
  a Poison hit to Gaping Wound's crit grant.
- **What your install hands out.** The tool reads the loot tables, the
  prefabs inside every pak (with a reader for their container format) and
  the literals in compiled code, and withholds what nothing hands out: on
  build 25959898, 13 Epic rows that sit only in loot tables nothing opens,
  and two infusions whose pattern drops in a Heroic the level files mark
  unreleased (26 rows and four infusions on 25782799, before two dungeons
  opened their Heroic). Each is
  printed with its reason; a source the reader cannot judge withholds
  nothing. `--include-all` offers the rows. There is no default exclusion by
  id any more, which had been hiding Pocket Hive.
- **Targets with a level and a mode.** `--target none` and `--target heroic`;
  `<unit>@veteran`, `<unit>@heroic` (the level cap; Heroic also reads the
  heroic stat rows, 35 on 11 units on build 25959898) and `<unit>@scaled` (a
  rift); a summoned unit stands at its summoner's level. `bench targets`
  prints the level, the pool and a CC column, and a table of the heroic
  bosses (ten on 25959898, eight on 25782799). Heroic trash is
  named as unmodelled: its rescale is server code the client does not carry.
- **Crowd-control immunity.** Every target says whether it is immune to crowd
  control and whether it refuses a stun (a wider set: 69 units take a root or
  a slow and refuse a stun). A bonus that needs the target controlled is
  worth zero on an immune one - the default boss is - and the output names it
  under `off against this target`.
- **Domination's register** (Judgement): a stun you apply arms the next
  weapon skill as a certain critical strike with +10% / +15%, and the rank-3
  bonus rides every hit you land on a controlled target. Measured on the
  dummy 2026-10-13: every armed cast a crit, x1.150 on top.
- **The Rogue's reworked tree**: the dose gate, Lethal Poison's direct hit as
  its own line, Envenom, Powerful Toxins, Deadly Poison, Venom Infusion,
  Improved Mixture's bank, Intent to Kill, Noxious Stratagem, Venomous
  Assassin, Acidic Splatter with its armour debuff, Finish the Job, Bullying
  the Weak against `--target-health`; Opportunity Strike, Urge to Kill's
  window and Footwork are named with their reason.
- **A weapon sub-skill is a weapon skill** for every guard and scope that
  asks; `AllAttributes` scaling (the mean of the four main attributes); a hit
  flagged `ignoreResistance` (Groundswell Strike, Aimed Shot from rank 2)
  skips the armour pool; a heal or shield scaled on MaxHealth reads yours.
- **Kit mechanics that were refused and are played**: cooldown handed back
  by a script in every spelling (the skill's own id, a local, a hit of one
  named skill, a Magic critical strike); a mark the next finisher spends; a
  bank of petals; a mark that detonates; an instant cast after a reset; a
  recast; a hit a status deals when it ends; armour taken off one named
  skill; a counter the build fills itself; riders counted per hit of a
  swing. `--targets` answers the clauses that ask how many enemies a cast
  hit.
- **New causes in the unscored list**: `off against this target`, `off at
  this target count` and `off in this build` - a clause that was read and is
  worth zero for the fight you described, with what would switch it on -
  beside `off at this target health`; `not pressed`, a slotted skill the
  fight was played with and without and left unpressed, with both numbers;
  and `lands on an ally`, a status a script hands to an ally or a summon.
- **A press that lands on its own caster is played in several orders.** In a
  build holding a status such a landing puts up (Faithful Winds under
  Sunlight), the fight is also played with that press last in the order and
  without it, and the best is kept; a releaser kept for nothing but a
  release that lands on its caster gets the same choice. The sheet lists
  each order with what it came to.
- `--tick-source instigator|carrier`, saved in the `--json` envelope.
- `--pickups <0..1>` (default 1): the share of a passive's ground drops you
  walk into, for a cast armed by collecting them (Hidden Power). It is an
  input, not a measurement, and a build that leans on it says so beside its
  number. `--behind-fraction`, which the fight has read since 0.3.0, is in
  `--help` with it.
- **`bench verify`, pointed at one piece of a capture.** `--since` /
  `--until` / `--window <from>..<to>` give a window, priced with the
  snapshot standing when it opens (`--snapshot`, `--snapshots`); `--split`
  compares ordinary and critical hits apart; `--replay` plays a window's
  recorded presses at their own times; `--target <unit>#<n>` and
  `--all-instances` say which instance of a unit is read, and by default
  each row is held to the instance being fought. The ledger says when a
  window is not one fight, holds two builds, or holds other players' hits;
  files what a window with no press inherited as CARRIED-IN; prints the
  capture's rate beside the model's and a RATE column; compares a
  whole-number stream with the ceiling the log writes; splits a skill
  logged under two affinities into two rows; compares a summon's swings
  under the pet's own skill; and names the states a per-hit disagreement
  can be instead of calling it a formula error.
- **The suite survives a bad day.** A throw costs its own group one failure
  and the run goes on (on this patch day one TypeError had hidden 35 real
  failures behind it); `node test/run.mjs --only "<regex>"` runs the groups
  whose title matches and `--list` prints the titles; a group that asserts
  nothing fails; the summary and the stamp wait until nothing asynchronous
  is left.
- **`bench verify` knows which build a capture is from.** `--capture <file>`
  reads another log; `--target` filters the capture and `--price-as` prices
  the model on something else; the ledger says the build, the level the
  target was logged at, and warns when a boss at the level cap could have
  been Veteran or Heroic. A dummy window from before this build is priced on
  `none` by itself.
- **`bench update --reanchor`** lists the citations whose function merely
  moved and what needs a person; `--write` rewrites the former in place and
  never touches the latter. A citation is opened, not just located: STUB (the
  client no longer carries the body - 202 server-side functions on this
  build), body CHANGED, MISSING and anonymous numbers are separate answers,
  and a LEANS line names an intact function that calls a stub.
- `bench update --row <sheet>:<id>` prints what changed inside one row, a
  skill's script included; `--accept` is a gate (refused on any stale
  citation; `--with-stale-citations` defers them and every later run lists
  what is still owed); a missing fingerprint is baselined only with
  `--accept`.
- The fingerprint records the column schema of every consumed sheet and every
  custom type, each script's hook names, the talent trees, a row hash that
  decodes enums by name, the classes and methods of the code the model cites,
  and a body shape per cited function - so a new enum case, a renumbered
  enum, a moved talent, a new hook and a changed function body are each
  their own event. New cases are checked against the source: one not quoted
  in executed code is a model re-read.
- The work list cross-references removed rows against the source, routes a
  skill by who can reach it (a kit, a foe, nobody), groups added ids that
  share a word across sheets as a possible new system, and counts added
  items by rarity and type. `--against <data.cdb or install dir>` diffs
  against an older copy of the game data.
- `bench update` prints a CAPTURE line from evidence: whether a probe log
  holds rows after a session row that names this `hlboot.dat`, counted over
  every session recorded on that boot.
- Citations are scanned in bin/, tools/, ui/, src/lib, ui/lib, the suite's
  comments and the living documents (docs/MODEL.md, docs/GROUND-TRUTH.md,
  docs/TODO.md, ui/API.md) as well as src/.
- Every command's header, and the UI as a strip across the page, say when the
  install is not the build the model was accepted on. The accepted build is
  a stamp that ships with a release, and a release is gated on a suite pass
  recorded against it (`tools/release.mjs --check`).
- Dumps and snapshots carry `infusion`, `infusionStat`, `prismatic` and
  `flawless` on a gear entry, and a dump's rolled rarity; unknown keys are
  named, not dropped.
- UI: the Infusions block (sets worn, what of each is scored, what is not,
  each piece's bonus line), three infusion controls in the picker, a *Not
  offered* section listing the rows nothing hands out and the rows made only
  above your level with the reason for each, a source line from the install
  when the atlas file is absent, the infusion set ladder in a set's tooltip,
  and skill icons decoded from the game's BC7 atlases.

### Changed

- **Every default optimum moves.** `bench optimize --class <c>`, level 25,
  default target, as the tool priced the same build before this work and
  after:

  | | before | after |
  |---|---|---|
  | Warrior | 603.6 | 841.7 |
  | Rogue | 626.1 | 1,082.3 |
  | Mage | 467.3 | 718.8 |
  | Priest | 498.2 | 579.1 |

  None of the four is one change. Down: the base-attack rule (Warrior -8.6%
  alone), the Finisher counted once (Rogue -12.9%), the Epic rows nothing hands
  out withheld (26 on build 25782799, 13 on 25959898). Up: Domination's register and the builds the search makes around
  it, the Rogue's poison tree, the Mage's chain, and infusion sets - the
  largest single contribution on every class that no captured character
  wears.

  The read-only pass stood at 852.2 / 1,036.4 / 677.7 / 571.4; holding the
  model to the capture then moved each by its own causes. Warrior: the
  arsenal's second enchant gone, partly given back by Brutal Frenzy's
  re-roll. Rogue: the same enchant down, Gash's divisor and the Raw-tick
  rules up, Death Mark summing with the riders down, Combo Points by the
  row's rule with the Finisher pressed at the points held up (1,054.2), and
  Hive Venom counted as a poison by Intent to Kill and Gaping Wound's grant
  (1,068.9). Mage: the enchant and Chaotic Flames' third-use gate down, the
  armour break of Nibsham's Liberators and the Finger of Sukuna'Maatata on
  the damage-instance clock up (675.1), and Mystic Empowerment priced with
  its rune (718.8). Priest: a re-searched build with the Censer of Wool
  Hollow in hand - the auras lose their spawn hit, the swing-played statuses
  lose two talents, Faithful Winds' lane is pressed for Sunlight, and
  Crusader's Cooldown Reduction moves the press times (575.2).

  The hotfixes then moved three of the four, on the data alone. Warrior
  846.3 to 841.7: the previous optimum still prices 846.3, and the search,
  with Balance of Justice in its pool now that Robin Hoof's Heroic is open,
  settles on a four-piece Balance of Justice build that reads less - a
  search result, not a rule. Rogue 1,068.9 to 1,082.3, all of it Shred's
  10s (with the row at 3s the same build reads 1,068.9). Priest 575.2 to
  579.1, a re-searched build with four pieces of Balance of Justice. The
  Mage reads 718.8 as before.
- The default target is still `boss`, and it is now a statement about level
  too: ul'Serous, Herald Avatar (40% / 40%) at your own level, immune to crowd
  control.
- A piece of armour that a kill generates is priced at your level and a
  crafted piece or a piece of jewellery at its row's; the level slider in the
  UI appears for armour.
- The search takes longer: it plans infusion sets, plays more per tick, and
  plays a Priest build that holds Sunlight in several orders. On build
  25959898 a default optimize took about three minutes (Warrior 177s, Mage
  206s), eight (Priest, 472s) and twelve (Rogue, 702s), timed one after the
  other for this entry while the full suite and two other searches ran
  beside them.
- The Priest's Hidden Power is priced on a stated input, `--pickups` (every
  cloud collected by default). It was priced that way before and did not
  say so.
- The files of the UI's icon cache are named differently (the name hashes
  the build's stamp with the key); the old `.cache/ui-icons/*.png` are never
  read again and can be deleted.
- `tools/bake-diff.mjs` reads the install's own bake log by default, only the
  rows after its last session row, and says which build that was.

## [0.4.0] - 2026-09-07

- A bee nobody summoned, a bank nobody spent, and pets counted twice
- Inner Demon was readable all along: a reset every thirty seconds, paid in blood
- The owner the shell swallowed
- A summoner is worth its pets, for the whole twelve seconds
- The probe's seventh eye, written into the reader and the plan
- Verify reads the authored rotation from the right scope

## [0.3.0] - 2026-08-22

The model audit release: nine combat subsystems were traced op-by-op through
the game's compiled code, every divergence adversarially verified, and the
fixes landed with in-game measurements as the referee. Baselines move on
every class — Rogue and Mage come DOWN because two phantom-income laws died;
the capture, not the old number, is the authority.

### Global

- Fixed CooldownReduction using the wrong formula: the game multiplies
  cooldowns by (1 − CDR/100), the bench divided by (1 + CDR/100) — cooldowns
  ran up to 10% long and the stat was undervalued at every value. 100 CDR now
  correctly means no cooldown.
- Fixed skill cooldowns not starting at the attack animation's execution
  point: the press-to-press cycle is animation offset + cooldown, measured
  live to 48ms of spread.
- Fixed guaranteed and script-granted critical strikes not being captured —
  Blazing Beam's "always critically strikes", stun-gated bonuses, and eight
  more script riders now price.
- Fixed rider bonuses scoped to "base attacks" not reaching the combo
  finisher where the game's own predicate includes it.
- Fixed looping area skills missing their spawn hit, and spread loops now pay
  the spawn's share — measured on GS Nova's capture events.
- Fixed skills whose payload fires through a launcher step pricing at zero
  (Crescent's Flower Spiral).
- Fixed damage-over-time riders that fire "when the status is applied" being
  priced per tick instead of per application, at the per-hit application
  rate — 98.8% of 71,578 captured procs sit within 5ms of an application row.
- Added the self-CC rule: a skill that applies its own Stun/Root/Slow-typed
  status pays CC-gated bonuses on its own hit (Charge lands its stun the same
  millisecond before its damage — five clean-dummy Charges at exactly ×1.25).
- Some casts never take the hero's control: a skill whose payload is pure
  status or script (Swirling Embers, Depth Shield) now costs no clock and no
  longer resets the attack combo, while animation-carrying casts still break
  it — reported from play, confirmed in the bytecode.
- The rear-hit assumption is measured now: behind-fraction defaults to the
  capture's 0.41 instead of a promised 1.0.
- New: `--rotation-file <json>` plays an authored rotation or priority list
  exactly as written, instead of the derived order and the lookahead.
- New: `tools/timing-audit.mjs` — the capture audits every skill's billed
  occupancy with no hypothesis; its first run validated the basic chain to
  the centisecond and flagged four occupancy over-reads for the next pass.
- Latent guards, ready before a patch needs them: offensive Resilience,
  target-sourced MaxHealth rows, the MRatio × MRatioMin channel split,
  Override stacking as stop-and-recreate, rank-zero reading every rank row,
  zero-ratio scaling rows.

### Mage

- Fixed passive in-combat Spark generation not being accounted for: +1.95
  per 3s tick at cap 100, ticking through casts, exactly as measured.
- Fixed weapon-skill Spark costs not following the CDR-reduced cooldown.
- Fixed Chain Strike contributing zero (+15% per rank on basics while the
  chain is armed — a state the fight already tracked).
- Fixed the chain arm counter advancing while an arm was banked and arms
  never expiring: the counter freezes while armed and an unspent arm lapses
  after 15 seconds.

### Warrior

- Fixed Rage gain factors applying to trickle income: only per-attack script
  gains ride the live factor (Berserk doubles your swings' Rage, never the
  Infinite Rage trickle), matching the two code paths.

### Rogue

- Fixed Death Mark's +15% not reaching Raw damage-over-time: script riders
  bypass the Raw gate in the game, so a marked target's bleed pays it.
- Fixed the Finisher rune's +1 combo point per critical missing from the
  income - up to ~1.5x the point rate at high crit.
- Virulent Magic rides Lethal Poison's application clock now; capture parity
  held at −6.5% per-hit while the optimizer's synthetic builds lose the
  phantom pricing the old per-tick law invented.

## [0.2.2] - 2026-08-20

- The Linux icon is a png, which is what the builder can read

## [0.2.1] - 2026-08-20

- A Linux build, and a cache that survives a read-only mount
- Line endings decided here, not by whoever cloned the repo
- The optimizer runs in a thread, not a second Electron
- Edit what is equipped, and search what an item says
- Fixed an issue that could result in epic rarity performing better than legendary in some cases

## [0.2.0] - 2026-08-12

- A boss you fight at your own level, and a buff that stops growing
- What you made keeps the level you made it at

## [0.1.0] - 2026-08-12

First numbered version: everything the repo does today, before any release
automation existed.

### bench

- `bin/bench.mjs`, the CLI over the model: `optimize` fills every unpinned
  slot and socket, `sheet` prints the stat sheet a build produces, `rank`
  ranks one slot against a build, `weapons` and `layouts` sweep weapon
  choices, `rotation` searches the rotation a weapon wants, and `items`,
  `classes`, `slots`, `rarity`, `targets`, `talents`, `profiles` read the
  game's own tables back out.
- `verify` holds the model against a recorded capture; `audit` lists every
  assumption and gap in it; `update` is the patch-day pipeline.
- Warrior is calibrated against data, bytecode and the training dummy; the
  other three classes are modelled from the same tables and not yet
  measured end to end (`docs/ROADMAP.md`).
- Zero runtime dependencies, Node 18+. Nothing derived from the game ships
  in the repo - every number is read from the player's own install, found
  through `--game`, `FAREVER_DIR`, or Steam's own library list.

### ui

- `ui/server.mjs` + `ui/api.mjs`: a local HTTP host for the bench engine,
  contract in `ui/API.md`. Character sheet, item picker with the exact
  in-game affix bake and drop locations, talent tree, rune page, and an
  optimizer that streams progress over SSE and answers on a second,
  read-only sheet with a damage meter.
- `ui/icons.mjs`: the game's own art, straight out of `res.pak` - PNG atlas
  crops served as rects, BC7 DDS portraits decoded in pure JS and cached.
- `ui/electron/`: the desktop shell, packaged as a portable Windows exe with
  `cd ui && npm run dist`. It carries the engine and the whole UI; the only
  thing it needs from the machine is the game install.
