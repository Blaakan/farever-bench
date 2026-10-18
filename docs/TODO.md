# Next session — the work list, in priority order

State on 2026-10-17, Farever build 25959898 (the second hotfix after the
September 30 update, build 25782799), accepted the same day: `bench update
--accept` recorded it in `model/fingerprint.json` and
`model/accepted-build.json`, with the 15 server-only stubs the citations
name. The suite reads 4,305 checks green and wrote `model/suite-pass.json`;
`node tools/release.mjs --check` passes. Baselines, `optimize`, level 25,
default target (ul'Serous at your level): Warrior 841.7, Rogue 1,082.3,
Mage 718.8, Priest 579.1.

Read those four numbers with what is in them. The rules were READ on build
25782799 and carried to 25959898 by the hotfix pass; the capture of
2026-10-13 is of 25782799, settled most of what it reached block by block
([GROUND-TRUTH.md](GROUND-TRUTH.md), last section), and has nothing to say
about either hotfix. Infusion sets are the largest unmeasured contribution
on every class: other players' rows say when three sets fire, and no row
says how much any set deals. The baselines of the handoff before this one
(2026-08-22, v0.3.0: 514.8 / 479.1 / 541.3 / 427.2) are another game build
and are not a comparison.

## Left from the patch day

- The fingerprint does not record what `src/sources.mjs` depends on in the
  level prefabs (a Heroic's release status, a shop line) nor the
  release-status enum. Build 25959898 is the first instance: the Heroic of
  Cheese Station and of Crimson Barracks went to Release in the level files,
  and neither `bench update` nor `--against` says a word of it - it shows
  only in what the search offers (13 withheld rows where there were 26).
- The audit's RATE entry quotes the Rogue's rate as measured on the tree
  before the hotfixes (528.5 a second against 505.7, +4.5%); on the installed
  rows the same sixteen steps read 530.1, +4.8%. The entry should say which
  tree its figures are of, or count them when it is printed.
- Outside this repo: the probe's `snap_gear` row writes no infusion keys yet
  (the reader takes `infusion=`, `infusionStat=`, `prismatic=1` when it
  does), so an infused character cannot be captured as worn.
- Not checked: whether `tools/timing-audit.mjs` and `tools/hook-coverage.mjs`
  say which build the capture they read was recorded on, the way
  `bench verify` does.

## Open, where the model and the 2026-10-13 rows disagree

Each is in `bench audit` with both numbers; the read stands until the cause
is found.

- **Urge to Kill is in no number.** The captured Rogue's Finishers held
  4.07 points each over the sixteen rotation steps; the model's own rotation
  finds 2.12, because Urge to Kill hands out a point a second for ten and the
  fight does not cast it (all 66 Finisher taps inside one of its 31 windows
  fired, 4.1 to 5.5s apart, where the 1s cooldown alone allows none). With
  the capture's own presses replayed the Finishers price 449.4 a hit against
  455.0. Pricing it is a window of its own in the fight.
- **Domination's rank-3 bonus is paid at the controlled share of the
  fight**; the game pays it per hit (Raging Smash +5.5%, Tear Reality +4.9%
  in their own block). The fix carries crowd control as state of the foe in
  the fight.
- **The Raclette Pan's crit chance**: 62 critical of 385 swings and finisher
  rows at ten stacks with Battle Shout down (16.1%), where +0.5 CritChance a
  stack prices 21.7%.
- **Chaos Bolts' reset is rolled once a finisher**, at 0.2, where the game
  rolls it per bolt (47 applications in 268 bolts, 17.5% a bolt; 35 of 67
  finishers with at least one). The audit's `verified` entry describes the
  game's rule; the fight's mutation loop rolls an `on: host` mutation once
  per cast event. Roll it per damage instance of the host, and say which.
- **The fight presses Infernal Plunge too eagerly** (Nibsham's Liberators):
  in every rotation block the capture's key 1 took Demonic Bite's register
  before key 3 (82 of 82 Gaping Wound hits unarmed), and the model re-presses
  Infernal Plunge the moment its reset lands. Per state both lines are exact.
- **Two link readings are wider than the rest**: the Warrior's third
  (+4.1% on 17 swings) and the Mage's second (+6.6% on 13). Nothing explains
  a link reading under its neighbours.
- **The chain's round** runs 1,941ms first link to first link against 1,850
  authored, a Free state of 10 to 17ms before every link; nothing prices it,
  so every line that rides the chain is over-rated by 4.9 to 8.3% in RATE.
- **The Rogue's rate**, like for like over the sixteen steps: +4.8% a second
  on the installed rows, hits 3.8% smaller and 9.0% more numerous.
- **A stat buff is counted at its cap**, not at a tracked count; a buff's
  stack count is one of the states a per-hit disagreement can be.
- **Jewellery's level**: priced at its row's, and two necklaces that author
  15 were logged at 17.

## Open in the model, read and not priced

- **A press kept for what it puts up, whatever that carries.** A cast that
  puts a status up is kept for it, so a defensive or movement buff is
  pressed on cooldown in a dps fight (bare level-25 characters on the named
  boss: Smoke Bomb 71.95 against 72.48 unslotted, Ignore Pain 67.58 / 68.07,
  Bloom 93.06 / 93.23, Judgment for three seconds of move speed 46.77 /
  47.62); and a press that deals damage and displaces more is pressed
  whenever it is ready (on the tree before the hotfixes, Zealous Spins in
  the arsenal of that day's default Warrior build read 812.1 where the slot
  empty read 846.3). One rule settles both - keep a press only where the
  fight with it beats the fight without it, for every cast - at one fight
  more per press per evaluation. Hot, hot, hot! is pressed on cooldown for an
  area that is not priced.
- **Expulse beyond one orb**: the recast is priced at one orb a press; the
  real count is the spheres Abyssal Rise left, which Tide stacks feed - three
  banks with a lifetime between them, none kept by the fight.
- **Going With the Flow** (Clawdius's passive): a step played for a skill
  different from the last one that played it; pricing it needs a per-rider
  memory in the fight.
- **Water Veil** has no rate: its heal goes to whoever wears a shield you
  apply (70 of 70 rows on the hero who applied it), and this fight raises no
  event when a shield goes on.
- **Mystic Empowerment**: priced on the Mage who casts it; where its press
  falls is the order's (ranked first it read lower, 685.5 against 700.3 on
  the default Mage build of the day), and what it does for other heroes of a
  party is not priced.
- **A heal a script sizes as a share of a hit** is paid at the bare share
  (Bloodfeast, Soothing Rays): whether the server runs it through
  HealGivenMultiplier is not read.
- **Spark Surge, and the Spark Cube that grants it**, are in no number.
- **The set readers**, measured on no wearer: Hive Venom reads 1.47 against
  the Seals' row on one wearer where two others read 1.76 (a total over three
  ticks predicts 1.80), and 23 of 1,016 Fermentation applications stand
  beside no weapon-skill row.
- **Live tick repricing** (audit #14). A tick is priced against what the
  target wears when it lands; the applier's side is the snapshot at
  application, priced at the averaged sheet where the game takes the state of
  that moment. Whether a refresh re-seeds the context cannot be read
  (`Status.refresh` is a server-only stub). A rider up while a pool ticks is
  not replayed on the ticks.
- **onUseSkill shapes** (audit #17). `GameObject.doUseSkill@4651` dispatches
  to all owner scripts on every use; the bench reads a few idioms. Of the
  2026-08 list, Bladeleaf (`DS_Bladeleaf_Combo_Status`) and Eternal Flower
  Heart (`Trinket_Bee`) have not been re-checked on the new build.
- **A weapon sub-skill's USE.** Its hits are read as a weapon skill's. A
  recast raising a weapon-skill event rests on a bridge, and three
  consequences of it are not taken: Spark cost and the Mage chain spend,
  spending a next-weapon-skill register, banking a Tide Rising stack.
- **Six Mage talents stay unpriced and say so**: Nimble Fingers, Temporal
  Compression, Kinetic Surge, Prodigious Mind, Infinite Resources, Power
  Circuit.
- **Named, not priced**: Power of the Tides; Cheesebane's bank and Brood
  Leap's forced crit; Blessing's rank-3 +0.7 crit on the empowered swings;
  Tidal Bulwark's explosion; the two infusion summons' swings; Alacrity on
  Judgment.
- **Reader faults found and not fixed**, each small and each a wrong or
  missing sentence somewhere: another object's rank inside a disjunction is
  read as the row's own (`Spear_Goo_Passive_Dot`, `Halos_Totem_Passive` not
  checked); a status that is not a control, on a script-played step, is
  still noted as applied by the cast itself (nine rows); `triggerOf` still
  files a status under an unknown hook as `on: cast`; `cond.heroic` on a step
  is not gated (four boss skills, no player row); Verdant Impetus
  (`Thrown_Seeds_Skill2_Status`, Ipheion, Star Blossom) is told it declares
  nothing this model can read, where its script adds `vars.damage` to ranged
  base attacks and finishers and resets Harvesting Scythe when it ends - a
  false reason, and unpriced damage.
- **What the fight view of a set still leaves**: typed riders are not paid
  on a script-played step's rider lines, and doses and marks kept in
  registers are not raised as "a status landed".
- **Critter-typed and Invulnerable units refuse every status**, damage over
  time included; the model still prices a bleed on one if you name it as
  the target.
- **Which activity scales dynamically, and the spawners that name a level,**
  are prefab data nobody reads for targets: `@scaled` is the caller's say-so.
- **Event-step replay remainder** (audit #18). on=Hit steps replay per landed
  hit: Warrior_SurgingForce's Stun+GainRage per Area hit (rage income ~N×
  low at --targets N), SparkSurge_Mark's on=Consume payload.
- **Occupancy over-reads** - found by `tools/timing-audit.mjs` on the
  2026-08 log and not re-run on the new one: Sword_Swarm_Combo billed 0.75s
  vs 0.40s observed (92% of events inside), Spear_Eruption_Skill2 1.25 vs
  0.83 (91%), Sword_Base_Attack3 0.55 vs 0.40 (75%), Priest_RadiantVerdict
  0.45 at 52%. Re-derive those occupancies from the step data; the tool is
  the acceptance test.

## Search and estimator

- **The Warrior's default search ends below a build it can price.** On
  build 25959898 it settles at 841.7 on four pieces of Balance of Justice,
  at the default restarts and at six, where its previous optimum still
  prices 846.3 on the same rows. The same search-quality class as the Priest
  talent valley: a local search, and a new option in the pool moved its
  path.
- **The Priest's search is about 2.4 times as long** as before a press that
  lands on its caster was played in several orders (116s to 273s side by
  side; the library search with no lookahead, the UI's default, 108s to
  297s). Most of it is a build with Faithful Winds and its rune, played in
  rank and tail orders whatever an estimate says; an estimate that skipped
  orders was tried, saved nothing measurable, and could skip the fight that
  would have won.
- **The Rogue's search is slow** (702s on 2026-10-17 beside the suite and
  two other searches). A cast cache keyed on interned state identity was
  built and measured slower than the string-keyed one; the remedy is open.
- **Infusion planning**: that the gear ascent reaches every faction-matched
  set is not proven (no faction-themed armour seeds). A piece's rollable
  rating is not weighed for the class when sets compete for a piece.
- **Rogue lookahead trap**: before the fixes, the la8 search settled 23%
  below the la0 basin; it recovered incidentally. Understand why the rollout
  loses to greedy by ~6% on chain builds (it prices the arm at zero - give
  the rollout the register, the doses and the bank) or stop paying for a
  rollout that never wins.
- **Phase averaging.** One deterministic timeline has ±2% phase quantisation
  and is asked to resolve 0.1% differences; the CDR staircase spans 9.14%.
  Measured: K=5 timelines (190–210s) takes the Mage monotonicity grid 28→9
  inversions; K=21 (150–250s) takes it to 4. It changes every printed
  number, so it is a release decision — flag first (`--fights`-like), then
  default.
- Keep the monotonicity harness from the arsenal investigation as a tool:
  single-item upgrade steps must not lower dps; 1.1% of reachable steps
  still invert.

## Verify and tooling

- **Debuff-aware verify.** Rows are held to the instance being fought; what
  is left is to price each hit against the row's own tarm / tmarm / tdtm
  instead of a derived foe, so "party shreds" stops being an inference.
- **A window at the level cap does not say Veteran from Heroic.** Verify
  warns and prices Veteran; a difficulty field on the probe's rows would
  settle it.
- **thp turns execute clauses into measured windows** (Demonic Bite's +25%
  under 35%).
- **snap_buff folds prebuffs into the verify loadout** (ore weapon buffs,
  food, flasks) instead of the standing "consumables not captured" caveat.
- A two-group comparison in verify (two windows of one build against each
  other) is optional and not built.
- Run `tools/timing-audit.mjs` as part of the patch-day pipeline
  (`bench update`) - it is the no-hypothesis lens and it costs seconds.
- Five row counts the audit quotes from earlier slices of the capture are
  not plain filters of the sheet and were not re-counted. Whenever an item
  above lands, the matching `bench audit` entry moves from assumption to verified
  with its citation.

## UI

- **One defaults object** shared by bin/ and ui/ — `lookahead` is 8 in the
  CLI and 0 in five UI places, and ui/API.md documents both. Not small: it
  needs a decision about the editor sheet (lookahead 0) against the search
  (8). Ship the defaults in the bootstrap payload so the front-end cannot
  drift.
- Expose `--rotation-file`, `--target-level` and `--pickups` in the UI.
  `targetLevel` already rides the API; what is missing is an options panel
  and an upload path. The UI prices Hidden Power at every cloud collected.
- The game's item tooltip embeds the infusion's set ladder (its item-tooltip
  builder draws it); the bench's item tooltip does not - the ladder is on
  the Infusions block's set rows.
- Small, each a wrong or missing sentence: the picker prints "at your level"
  on rows withheld because a copy only exists at 25; an infusion pin on a
  slot named only in the infusion pins is searched for gear and never
  infused, without a word; a non-string `infusion` in a loadout is dropped
  silently by the sheet where the item tooltip refuses it; the CLI path
  still accepts any attribute id as an infusion bonus roll and prices it at
  0 (the UI refuses it).
- `bench talents` still prints "nothing" for a node the fight scores through
  a reader of its own where that reader is not in the table's list.

## Latent tripwires — documented, no action until the data moves

Audit #23 (unknown-hook census), #26 (per-instigator stack piles), #27
(target-side block), #28 (foe reactive scripts), #31 (Uncommon statGroup
rules), #33 (area maxFalloff), #35 (castTimeFactor — zero sources), and the
flawless ×2 augment path (#15 — every roll chance authored 0; fires the day
a patch turns it on). New with the update: every affinity sub-school is
still empty (a populated one is a fourth mitigation path); `LinearRatio` is
still unused; no unit authors flat armour or a `levelMultiplier` on an
armour row (read, unexercised).

## Queued for a driven session

In-game evidence is gathered in a session the bench drives on an explicit
go for that session. These protocols wait for one; each names what is read
and what each outcome means, and each is in `bench audit` with its
arithmetic. A dummy cannot answer the first two groups.

**On build 25959898 itself, first.**
- One login and one dummy session with the probe on, so the CAPTURE line has
  evidence about this build and the 170 sheet checks of the work list have a
  snapshot to be checked against.
- Knives Tempest with Shred, ten presses on the dummy: the -20% Armor for
  10s (the row) against the 3s logged on 25782799; a Gash or a basic swing
  inside the 3-to-10s window reads the shredded pool.
- Acidic Splatter from range: a ranged main hand, 20 Finishers at five
  points; 20 applications is the new script's reading, and the melee rows
  stay 0.2 a point.
- Expulse after Abyssal Rise: ten seconds of swinging, Abyssal Rise, then
  Expulse and its recast; the orbs thrown are the spheres on the ground,
  eight at most - and whether the recast now aims itself.
- The two released Heroics: Heroic selectable in the lobby of Cheese
  Station and of Crimson Barracks at level 25, and not in Chakram's Chapel
  or Honeyzabeth's Hivetrunk.

**On an Elite or a Boss.**
- Domination's register on a target that refuses the stun: Charge or
  Shockwave, then Rampage, ten times. Every Rampage a crit at ×1.15 is the
  reading; otherwise the register does not arm on a refused stun and the
  default Warrior loses most of what it is worth.
- A stun on a `NoStun` unit that is not Elite / Boss / Miniboss (a
  Ruinbringer Invader, `Demon_Rift_Claws_Major`): the stun must not land and
  a root must.
- One swing on a heroic boss against the same swing on the dummy: 0.667.
  A Veteran and a Heroic kill of Nepsilon with the probe on.
- The armour law, solo: a Nightspawn Invader against a Nightling Invader at
  level 25, about 1.07 for one row, 0.81 for a sum. The 0.35 tier: a big mob
  against trash, 0.929.
- Heroic trash: one Dungeon-flagged unit's health in Veteran against Heroic.

**At the infusion station, and with infused pieces on the character the
probe runs on.**
- The attach: ONE piece infused with Chain Heal on a piece of another
  faction, not Prismatic; Fervor on the sheet before and after.
- Two sets of one faction: four of Blood Oath and four of Gift Beyond
  Realities, +8 Fervor.
- The bonus line: an infused Epic chest at 25 reads +14; whether a looted
  piece's bonus can be a stat outside the four ratings; whether about one
  looted infusable piece in ten is Prismatic.
- The amounts the other players' rows could not give: Seals of Atonement's
  step on a two-hit swing, Hive Venom's tick at five stacks, Fermentation's
  Melted Cheese, Bubble Bullet armed mid-chain; Wet and Hive Venom on an
  immune target (a refused control must not add a Hive Venom stack); a knock
  with no force (Martyr of Enripit's first swing); a `NoPushback` unit.
- Can an Epic piece exist below level 25 (a cache opened at 24).

**On the dummy, not pressed on 2026-10-13.**
- The tick rule on a pool: one Bonethrow with no damage buff up; a Light
  Burn tick under both `--tick-source` values (let it EXPIRE between
  readings); fifty Luon Marks at 10% crit or more. Control: a Raw tick must
  not move.
- Whether a refreshed status keeps its first application's context.
- `ignoreResistance`: Groundswell Strike or Aimed Shot at rank 1 and rank 2,
  about ×1.67.
- The chain without padding: Flame of Argol (1 swing between two Searing
  Furnaces, or 3) and Twin Pillars of Justice (3 or 4), watching for two
  Sentences back to back.
- Iron Cyclone's four hits with and without Domination (all four at ×1.25);
  the rank-3 rider inside Raging Smash's slow with the Thundersmash rune
  (×1.25 by the code, ×1.00 by the tooltip); Chaotic Distorsion inside a
  stun (×1.40).
- A recast is a use: does Expulse's recast drain Spark.
- Rogue: Smoke Bomb as a dose-layer; Urge to Kill's window priced against
  its Finishers (the points held at each tap).
- Scorch at weapon rank 3, the chain alone and then with Pyroball's Light
  Burn kept up: its critical share is the sheet's in the first block and 25
  points over it in the second. A Priest with no prayer slotted pressing
  Judgment under Spirited Disciple: no `press` row, no status row. Surge of
  Violence on a finisher that lands several hits (Brutal Frenzy): one roll a
  finisher.
- Ranged and caster kits: Credence rank 3 (Deadeye Focus, an instant Aimed
  Shot at ×1.25); Heat Emission adjacent and from ten units, and a second
  press inside your own Hot, hot, hot!; Hidden Power at rank 1 and 2, and how
  many of its clouds a player walks into (`--pickups`); Radiance rank 3
  after a Blazing Beam; Horns of the Wind's finisher arrow at ×2.5; Ram Trap
  rank 3 under a boss and with two dummies; the Mirrors' extra hit;
  Thornlace's petals, spin hits and whether the cast holds the hero.
- Melee kits and Priest: a bare `isBaseAttack` on the finisher (Iron Fins,
  1.5s back per finisher); Abyssal Fury's blasts and Rage; Zealous Spins
  presses in 60s; Blessing's bonus hits and its rank-3 crit; Conquer at rank
  2 against its tooltip; Sunlight without Solar Devotion; Spirited Disciple
  with three prayers; Purging Strikes on a multi-hit finisher; Lifestealing
  rows per Cascade and per Castigate.
- Still owed from August: the RoundUp discriminator (name the dual-aptitude
  item whose baked Strength lands on x.5, with both predicted integers);
  Staff_Craft_C at 8.0% (z=-2.3) and the ignite dot at 7.0% want larger n.

**Tooltips, one screenshot each.** The first swing of a dual-aptitude weapon
with the weapon's own level on the same tooltip (WeaponPower, the client's
reading); an infused piece (the set ladder inside the item tooltip, the
bonus block's title and whether it is greyed on a mismatched piece, the word
Prismatic); an Unstable Bomblets panel (AllAttributes, and its second line);
Ignore Pain's 40% or 60%; Battle Shout's range; a Sigil of Bet'Hatesht's
description; a link to an attribute with an empty display name; a freshly
crafted Infused Tusk's item level.

## Known limits, not tasks

- **The client no longer carries the server half of combat.** 202 functions
  are a bare `throw "!isServer"` on build 25782799 and on 25959898 -
  `applyDamage`, `receiveDamage`, `applyEffect`, `addStatus`,
  `Status.refresh`, `applyAffixes`, `playStep`, `dropLoot` among them. A
  rule read in one of those bodies was read on the 2026-08-11 build and
  cannot be re-read; the capture is the only referee for what they do, and
  each such sentence says so.
- **What a capture cannot say.** A dummy session says nothing about bosses,
  crowd-control immunity or heroic targets; a talent nobody allocated is not
  in it; no captured character wears an infusion, so no set amount is in
  it; and a capture is evidence about the build it was recorded on - the
  2026-10-13 one about 25782799, not about the two hotfixes.
- **The searches and the suite are slower.** A Priest search plays a build
  that holds Sunlight in several orders (about 2.4 times as long), and the
  full suite takes about forty minutes; its `optimiser` group alone is six
  Priest searches. `node test/run.mjs --only "<regex>"` runs the groups whose
  title matches and `--list` prints the titles.
