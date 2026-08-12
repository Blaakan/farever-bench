# Engineering log

Why the model is shaped the way it is: what was measured, what it refuted,
and what it cost. Newest first.

These notes used to live in commit messages, which is a bad home for them -
unsearchable next to the code they explain, and invisible to anyone reading
the docs. The reasoning is the durable part, so it lives here; the commits
keep their one-line subjects.

Every number cited here was read from the game or measured against it. Where
an entry says a rule was refuted, the alternative it beat is named, because a
model that only records its conclusions cannot be checked.

---
## 2026-08-12 - A bug net is not a greataxe, whatever the rig says

CaptureNet inherits GreatAxe for the animation rig - its own type row is skills: [], moveSet: Staff, setup: Weapon_2H_GreatAxe.prefab - and the model read that cosmetic inherit as a mechanical one. Through it a bug-catching net collected two augment sockets, a block ability, and the first <Type>_Upgrade in the chain: GreatAxe_Upgrade, +2 CritChance, which lifted every line of the build about 1% and was the whole of the net's +4 dps over an empty arsenal slot. It is the same confusion that once handed this same net a Legendary greatsword's WeaponPower, and it is fixed the same way: by the item's own aptitudes. Net_Basic is the only aptitude-less item among the 37 that fit a weapon slot, so nothing a character fights with moves - Staff_Censer keeps its two sockets and Staff_Upgrade. An arsenal net now prices at exactly an empty slot, to six decimals, and the tripwire pins that end to end.

## 2026-08-11 - Shreds share one bracket, exactly as the extraction always said

targetState multiplied ARatio armour debuffs per affix - Tear Reality plus a second -25% shred priced x0.5625 where the extracted pool law, Armor x (1 + SUM ARatio) x (1 - ignore) x (1 - pen/100), says x0.50. One debuff composes identically either way, which is how the multiply hid through every single-debuff window; the user's formula-first reading caught what fitting never would. mulRatio rows keep their sheet-declared composition, applied after the summed bracket, and DamageTakenModifier affixes ride the same rule. 919 green, Reblochonk unchanged.

## 2026-08-11 - Zero armour is still an intent

The sum law dropped units whose only armour row authors reduction ZERO - the Dummy - from the target registry, and every dummy verify threw. A zero row DECLARES the family: the unit is a target that mitigates nothing, which is not a unit with no intent at all. 919 green, dummy ledgers restored.

## 2026-08-11 - Armour is a sum, the ladder was inverted, and the boss ledger reads like a dummy's

The nearest-row armour resolution is replaced by the law two independent fitters and an adversarial judge all landed on: every reduction-carrying row in a unit's full inheritance closure contributes red/(1-red) to the pool coefficient, pool = S x (385 + 100 x spawnLevel), with a modifier-only stub (Golem_Base's x1.6) composing onto the first reduction row of its attribute - algebraically identical to the verified single-row golem numbers, divergent only on one untested elite family, flagged. Nearest-wins is refuted by the dungeon ladder inversion (adds authored 0.25 out-mitigating the boss authored 0.30 - impossible under shadowing, exact under the sum) and by pooled log-SSE 14.4 vs 1.0 over 27 rows. Spawn-level parity is refuted in every boss window; fitted zone levels ship per world family (rift 6.9, arena 7.9, dungeon-Z1D 12 with per-run re-roll noted) and --target-level always wins. First boss verify under the law: Reblochonk, 100% coverage, 3 match / 9 close / 2 miss. Tripwires re-pinned to the sum with the evidence in each comment. 919 green.

## 2026-08-11 - The finisher arms a promise, the projectiles fly in threes, and the chain hears every press

Three priced fixes from the frontier list. Demondash's finisher (rank 3) plants a consumed +25% on the next weapon-skill hit - armed per combo in the fight, spent at the next weapon-skill cast; Demondash_Skill1 goes -13% to +2.2% in replay. Skill2's Projectiles step plays round(vars.var1) times per cast (three at rank 2 - live, 13 presses threw 30) via the script-loop multiplier on own-step riders, and its rank-3 AOE is a POSITION cast - playStep(Steps.X, null, pos) anchors to the ground, so the authored ignoreMainTarget does not exclude the dummy standing there; the row flips from +17% to -13%, closer and now made of real parts. And replay feeds the chain counter with off-model active presses (Blink, MysticEmpowerment) so the model arms at the live rate. 918 green.

## 2026-08-11 - A trigger is not a cast, a proc rolls on every instance, and a replay is one fight

Three corrections from the frontier hunt. 'Trigger' (on:8) steps leave the cast fold - DuplicatePoison_Skill1's 0.35xDex step was billed per press while ten live presses produced ten host hits and no such lattice, a +10% phantom. An onInflictDamage proc's rate floor rises from the swing clock to the plan's whole instance rate (swings + casts per cooldown + dot ticks): Emsei's Stone (+10 Faith, blocked renewal) was priced at uptime 0.53 against a measured 0.755 because her 5.8 damage instances a second rolled the hook her swing clock priced at 0.11. And replay mode learned two things its first outings taught: a via-granted active is pressed under its presser's id, and an open-ended window is cut at the first two-minute silence so the replay is one fight, not six hours of sittings. 918 green.

## 2026-08-11 - The cap is stood at, and the whole Mage tail was one buff

Conduit: Power's refusal predated the conduit economy: the model's stream once fired every ~28s against the 15-second buff, and crediting the 20-stack cap was the largest overstatement left. The economy was the error - with the chain consuming free volleys the live stream fires every ~2s, the status_on logs once and stays refreshed, and the cap (+10 MagicMastery) is stood at, not visited. Credited as permanent at cap for chain-sustaining builds - both regimes were measured in game, and the chainless starved regime keeps its named refusal. The uniform ~-9% across every Mage magic row was exactly this buff: the Ultimate lands at -0.0% (1006.6 vs 1006.8), Skill1 -1.5%, SummonDemon -1.8%, RayOfSpark -3.2%, and the replay ledger reads 4 match / 4 close / 3 miss from 2/3/6. 918 green.

## 2026-08-11 - Replay: the capture's own fingers on the model's keyboard

verify --replay replaces the sim's chooser with the recorded press timeline - each press fires at its recorded offset if the model agrees it was possible, the fight runs the window's own length, and every disagreement is counted and printed rather than absorbed: N replayed, N refused as not ready, N outside the model's rotation, N landed late. Cadence residuals collapse into formula verification - the Mage's conduit share reads -0.2pp and the Ultimate -0.1pp at her real sequence - and the refusals themselves are findings: utility casts the model does not press still advance the live chain counter, which is the next refinement this mode exposed on its first run. 918 green.

## 2026-08-11 - The Mage was three economies short, and the chain was never a crit rider

The Mage simulated seventeen percent low, and none of it was a
formula - every per-hit price was already within ten percent. It was
three authored economies the fight never ran.

The chain. Chaincast arms after every four active casts, and the arm
is CONSUMED by the next weapon-skill press - Mage_SparkMaster's
onPreSkillProc, the sole caller of propagateMageChainCast@29172 - and
that press pays ZERO Spark, raises every onMageChainCast consumer
(for this build: Chaincast's conduit volley AND Reverberate's second
one 0.4s later), resets its own cooldown a frame later, and plants
the forced-crit register. Live play respends the reset within half a
second, which is how Censer skills beat their authored cooldowns
(5.65/min pressed against a hard cap of 4.0). The sim now consumes at
the press with all four semantics; the trigger ledger that proved it
runs 207 predicted against 204 observed events.

The summon. Staff_SummonDemon_Skill2 sat in unmodelled while its two
imps swung every ~3.2 seconds for 0.2 x the OWNER's Intellect - and
its partner Skill1 is a charge dump, one missile per banked charge
(cap 20), fed +1 per pet hit, +1 per 3s of combat, and 20% per summon
expiry: live 14.9 missiles per press against the model's one. The
reader now hands the fight a summon spec (unit, count, duration, the
pet's authored swing period, the expiry proc) and a charge-dump spec
read off the scripts; the fight opens windows, swings the pets on
expectation, banks the charges, and spends the whole bank per press.
The pets' own damage rides a flagged line - real output the capture
files under source=Summon_*, so verify's fold skips it and the dps
headline keeps it.

The conduits. Three slots can REPEAT an option - the Projectile's own
script fans by getSkillInstanceCount, and every live trigger is an
instance pair - so mechanic pools now cycle their options and fire
per instance. RayOfSpark's SparkRegen is played per CHANNEL TICK
(four a cast, 118 tick-plays for 32 live presses), not once, so
own-channel-step riders fold at the tick count; ConduitResidues
refunds its expectation per trigger event; and the gauge stays where
the bytecode put it - spends only, from above the bound.

Emsay's window: model 284.4 -> 342.2 dps against live 341.4 (+0.2%),
conduit rows 8.4 -> matching 59/min at -2.8% per hit, every share
column within 6pp. Warrior, Priest, Rogue ledgers byte-identical. One
tripwire updated with its reasoning: conduit cadence rides spend
events, not a starved gauge, because the income was always four times
what the model credited. 918 green.

## 2026-08-11 - Evidence outranks freshness, and runes travel to the window that needs them

A login-and-out snapshot carries the newest probe fields and zero combat, and it out-ranked a two-thousand-event window on the strength of its empty rune list - so a snapshot with nothing recorded on the verified target can no longer win on richness. And when the window's snapshot predates the rune probe, the nearest snapshot carrying the authoritative set backfills it before the jobs dump is ever consulted: same character, slotted truth, read on a different day. Emsei's first v6 login resolved the FaithfulWinds phantom exactly as predicted - her authoritative set slots the M2 heal, not the M3 damage - and the Priest ledger stands at 100% coverage, zero phantoms, 5 match / 6 close / 3 miss. 918 green.

## 2026-08-11 - The pool banks a third, of weapon skills alone, on a clock that feeds reset

Demondash's Burn flipped eras because two reader errors cancelled until a better arsenal moved them apart. The banked fraction is a VAR and vars rank-resolve: the passive authors 0.2 with a rankOverride restating 0.3 from rank 2, and the capture proves 0.3 to the integer - status_on amounts 61/77/101 against feeding hits 202/257/335. And the guard is dmg.isWeaponSkill - skill type 7 exactly - so swings, finishers and class casts must not feed it; the model fed it from the whole rotation, a ~63% overcount. The tick clock resets on every discrete feed (the live lattice is silent through sub-2s spam, each tick ~1.9s after the last feed) - but only where the sim's feeds are discrete too: a crit-gated pool is fed the EXPECTED crit share of every swing, a smear that would stall the clock forever, so it stays expiry-anchored. Zero-pay ticks no longer count as ticks. The Burn's share verdict lands at -2.7pp CLOSE with the feed rising alongside the arsenal, exactly as live. Verify grows --rune for capture-proven overrides (SurgingForce's M3 prices 199.2 vs a live n=11 mean of 199.55) and names the jobs-dump fallback for what it is: known runes, not slotted ones - FaithfulWinds' phantom was exactly that difference. 918 green.

## 2026-08-11 - The cap follows the runes, and the chooser follows the target

Three things the calibration sitting taught. The ComboPoint cap honours KNOWN runes: Emsey's v5 snapshot says Combo Ruler is not slotted, so her cap is 5 - and the finisher immediately priced to the decimal (517.2 vs 517.3) where the as-held 6 had read +8.6%; unknown runes keep the assumption. A known-empty rune set is a fact, not an absence: snapshots record per-archetype event counts and runesKnown, so a v5 'none' marker never falls back to the jobs dump. And the snapshot chooser weighs evidence ON the target being verified - a dummy calibration followed by a rift left the newest snapshot rich in everything but dummy hits, and the target-blind pick returned an all-PHANTOM ledger. Measured while calibrating: the behind-perk sum prices +25.0% against +23.2% live (endpoints 36.23 behind / 29.42 front over 92/146 swings), and this player's natural dummy positioning is behindFraction 0 - the sim keeps assuming 1 for rankings, verify takes --behind-fraction. 918 green.

## 2026-08-11 - Slotted beats known, and the dump becomes the fallback it always was

A v5 snapshot's snap_rune rows build loadout.runes outright - validated against the cdb's own mastery lists, proxy garbage rejected into gaps like the talent rows - and the jobs-dump merge now runs only when the capture predates v5, because the dump lists what is KNOWN and pricing a known-but-unslotted rune as active is how a Battle Shout buff nobody had got credited. 918 green.

## 2026-08-11 - The mainhand grants everything, and the newest snapshot knows the most

Two things the first v4 capture taught. A snapshot carrying the weapon-skill selection outranks one that merely saw more damage - each richness point is a probe generation, and the selection is the fact an older snapshot cannot have. And the selection constrains only the slots the game constrains: the arsenals map keeps a dormant entry for the MAINHAND from when it sat in the arsenal - Emsey's lists one skill while the capture shows Skill2 pressed live - so honouring it on Slot_Weapon1 made a pressed skill MISSING. Selections land on the arsenal and offhand alone. Gash closes MISSING to -8.9% with the passive slotted; Rogue coverage back to 100%. 916 green.

## 2026-08-11 - The reader was ready before the row existed, and now it is host-keyed

Probe v4's snap_wskill keys by the granting weapon's item kind - HeroSpecialization.arsenals is per weapon, not per hand - so the parser stores selections per host and fromSnapshot matches hosts against the WORN weapons, dropping owned-but-bagged arsenals on the floor where they belong. The synthetic capture test now carries three v4 rows and pins the whole path: passive included on the worn dagger's slot, the bagged bow's selection kept out. 916 green.

## 2026-08-11 - The last two misses were the mirror's, not the model's

Hemorrhage read +34.7% per hit while its own pricing reproduces the
live lattice to the integer: status_on stacks = round(0.35 x the
feeding crit), exactly four 2-second ticks of ceil(pool/4), zero
crits, live paid tying to fed within carry-in and ceils. The delta
decomposes as an identity - share ratio x rotation-dps ratio x a
second concurrent target's tick dilution = 1.3466 vs 1.3466 observed.
A globally-fed pool's per-tick is share x rotation-dps x interval - a
RATE - so per-hit against it just re-measures the rotation difference
per-hit exists to ignore. Pool lines now carry whose damage feeds
them, and verify judges a global pool on SHARE (+0.3pp, MATCH), the
per-hit printed informationally. Own-fed pools (Boomerang's, decoded
live: 0.4 x hit, four ceil ticks) keep their per-hit verdict.

Heartsteel read +31.2% while its per-fire formula is byte-exact - the
live 269s ARE ceil(0.1 x Armor 2479 x 1.0827), the 323 is that times
Berserk's 1.2, the 412 that times CritDamage 153.24. The excess was
the SIM pressing Fortifying Cry - a zero-damage utility that doubles
Armor for 10 of every 35 seconds, feeding the one skill that scales
off it - against a player who pressed it once in the whole 400MB
capture, out of combat. verify now holds the model to the PRESSED
set: the press aggregate moves above the evaluation and a policy
keeps unpressed actives in the holster (via-granted casts ride their
presser). Heartsteel lands at +11.7%, the not-pressed phantom rows
dissolve, and the Warrior closes at 5 match / 4 close / 2 miss.

The same policy reclassifies Gash from mispriced to MISSING - with
Skill2 unpressed and the arsenal passive unslotted by the default
selection, the model genuinely has no route to the damage - which is
the honest verdict, named against the probe-v4 weapon-skill snapshot
that closes it.

And the latent half of the shield story is fixed while inert: a
Shield-granted CAST never reaches MainhandWeapon in the type chain
either, so shield sources leave the weapon mix entirely, not only
their status ticks. 913 green.

## 2026-08-11 - The rune set was one boolean, and every gate read it as closed

toLoadout wrote the modkit dump's runes as `loadout.runes[r] = true` -
keys the ids, values a boolean - while every consumer reads
Object.values(loadout.runes).flat(): the plan's rune set, the engine's
cache key. So the whole build's rune set resolved to `{true}` and
every rune-gated step, affix and cost relief priced as not taken, on
every class, for as long as the dump path has existed. The value is
the id now.

And the snapshot path never had runes at all - the probe has no field
for them - so `bench verify` now rides them in from the modkit's jobs
dump: runes, like the class, belong to the character and not to the
moment the snapshot was written.

What was hiding behind the closed gates: RadiantVerdict's entire
8-second zone (cond.mastery M1) - the row read +158% per hit because
the model priced only the opening burst against a live mean that is
mostly zone ticks; it reads -12.6% now, and the ledger grew a
FaithfulWinds row the rotation legitimately never pressed. Surging
Force went -29.2% to -0.9%, Shield Craft +52.3% to +31.2%, and the
Priest sheet tightened across the board - Smite -2.4%, Eruption -2.7%,
the orb -1.2%, the combo +0.2%. 913 green.

## 2026-08-11 - The residual hunt, written down where the next reader will look

MODEL.md carries the day: the three-row ComboPoint cap, the op-2
dynVal floor, the carrier's bracket on self-worn Buffs, the swing's
by-type crit on synchronous ticks, the item-scaling channel keyed on
the granting item's type chain, the trinket's at-rest full-pay ticks,
the two talent guards that became scopes, Gash's live company count
and the weapon-skill-selection gap it exposed, and the Censer's fully
authored economy - each with the number it moved and the citation it
rests on. The open residuals are named where they live, with what
unblocks each.

## 2026-08-11 - The censer's whole economy was authored, and the reader just had one shape

The staff's ultimate was refused as "nothing in the data says how many
hits arm it" - but everything does. The passive drops a cloud every
vars.time seconds of combat, walking into it grants one stack of a
counter status, the counter's own script converts at maxStacks into a
proc status, and THAT status's props.skillOverride names the skill it
puts on the signature slot. Ten pickups at three seconds is a cast per
thirty seconds of combat, from a cold start. stackProcsOf now reads
this second shape beside the physical-hit counter - the census is
exactly one row of each in the whole sheet, and the suite pins both -
and the follow-up joins the weapon mix when its host passive is
weapon-granted. The line prices at +3.3% against the capture's 898.

The mark was worse: silently absent. A payload-less target debuff
whose damage is a scripted step its own consume() plays when the
SECOND stack arrives - so it fires once per two applications, and its
appliers are three step refs plus one rank-gated addStatus in the
combo's script. markProcsOf reads the consume shape off the status
row, collects the appliers off the rotation, and the fight pays one
lump per pairing at its own cast counts. Priced with the enemy-worn
status conventions - no crit, no carrier bracket, weapon mix - the
step is 0.25 x (Int + Faith) = 59.0 exactly, against 51 capture rows
that never once deviated from 59 or critted. The verify row reads
-0.0%.

And the chain cast fires the conduits: Chaincast's onMageChainCast
calls forceTriggerAllConduits, a second conduit clock on top of the
Spark threshold, now raised by the sim on every chain arm.

Mage coverage 87.9% -> 100%: no MISSING rows on any of the four
classes. 913 green.

## 2026-08-11 - A channel is four rows in the log, and the splash never hits the one you aimed at

Mage_RayOfSpark read +89.6% per hit and both halves were event
bookkeeping. The channel is a spread loop - the authored amount is the
cast's total - and the model divided by five ticks while counting one
event, where the game divides by four and logs four rows. The divisor
is the game's own: initTicks@5882 sets baseExpectedTicks =
floor(duration / tick), with no start-tick +1 whatever the flags say;
every 2s status row lands on the same number under both formulas,
which is exactly how the +1 hid until a 0.25s channel with a delay
exposed it. Spread loops now divide by that count and report it as
their event count.

The other half was the M2 splash: playStep(M2_HitDmg) sits behind
`hit.target != ctx.aimTarget` - it lands only on targets OTHER than
the one aimed at, none of them against a lone dummy - and the model
credited it a full hit per cast. The rider reader now reads that guard
into a notAimTarget flag that rides the step's effects, and the
pricing clamps their target count below the aim target.

The row lands at -5.5% from +89.6%. 912 green.

## 2026-08-11 - Two talents were read right and routed nowhere, and a register was an ally's

Authority reads "dmg.skillId == Skill.Priest_Prayer_Smite -> dmgMult
+= vars.damage", Radiance "ctx.status != null && ctx.status.owner ==
owner -> dmgMult += vars.damage". Neither guard fit a scope the router
knew, so both were refused - and Smite ran 20% low while every status
tick the Priest carries ran 25% low, five rows in one measurement. The
reader now carries both shapes: a one-skill rider that lands on
exactly the named row's casts, and an owner-carried-tick rider that
lands on tickCarrierSelf rows, each at the value the rankOverride
RESTATES rather than the times-rank heuristic (0.12 x 2 is not 0.25).

Radiance also re-derives the last orb: the live final/plain ratio
1.795-1.801 is (1 + 0.25 + 1)/(1 + 0.25) - the script's +1 shares the
one additive rider bracket with the talent, and the carrier's fervor
cancels out of the ratio. The earlier reading that put the +1 inside
the fervor bracket fit the same number for the wrong reason; moved.

And the shield's pulse is PURE attribute. The item-scaling channel
follows the granting item's TYPE CHAIN - getStepEffectScaling@20778
prices itemRatio 0.4 only when the chain reaches MainhandWeapon, 1.0
for GearTrinket, 0 otherwise - and Shield inherits OffhandWeapon,
never MainhandWeapon. The +0.4-budget reading of the orb was
numerically degenerate on this one build (0.55 x (137 + 49.4) x
1.1316 and 0.55 x 147-ceiled x 1.434 land within half a point) and
the bytecode chain breaks the tie. Gone.

HighVoltage's guaranteed crit was refused because `ownerHero` was not
in SELF_TARGETS - the game's own scripts use it as the owner - and
because the register triple demanded a cost leg this shape lacks. Both
fixed: the costless register (the status consumes ITSELF on the
finisher for critChance += 1) is armed on every mage chain cast, whose
rate the Chaincast talent authors as one per four active casts, and
the sim's finisher blends the forced crit exactly as the costed
register always did.

The Priest ledger closes to 6 match / 6 close / 2 miss from 3/4/7:
Smite -4.3%, Eruption -5.4%, the orb -2.5%, Sunlight +1.7%, Swarm
+3.9%. PurgingStrikes keeps -17.6% - the remainder is a session-state
item-linkage anomaly (its flat flips with a relog) that is flagged,
not baked. RadiantVerdict's +158% is the one new question this ledger
asks. 912 green.

## 2026-08-11 - The trinket reads the character at rest, and pays in full

Trinket_Demon_Status read minus forty-eight percent, and it was three
wrong conventions netting to half. The model spread the authored
amount over the ticks; live, every application pays it IN FULL three
times - the capture's three equal pulses per application, hits 1, 2,
3. The model priced the four-primary scaling off the full combat
sheet, sum 294; live ticks are 0.2 x 225 exactly, where 225 is
floor(each base primary) plus the flat primary affixes of every
NON-WEAPON piece - 2,407 rows sitting on the integer 45.00, with the
daggers' primaries provably excluded and the whole-sheet 58.8 never
occurring once. And the sim repriced the dot at buffed application
states, a x1.25 the live ticks flatly refuse: 45.00 through the whole
rotation, across sessions.

So there is a trinket channel now: a status granted by a non-weapon
item ticks undivided, priced off standingPrimaries() - the standing,
weaponless, floored basis, computed from the resting build so no
application state can move it. And dot-scoped talent multipliers stop
reaching RAW dots at all: Raw bypasses the pipeline those hooks ride
(getDamageScale@5146 returns 1 for Raw before any modifier enters),
which the capture states twice - the trinket's constant 45.00 and
DuplicatePoison's Skill1 status ticking exactly the whole attribute,
both Poison-typed, both with poison-scoped talents ranked.

The row lands at -1.6%; the remainder is six ticks at 51 fed by a
+30-primaries consumable the dump cannot see, which the audit already
names. Every other Rogue row byte-identical. 911 green.

## 2026-08-11 - The hook counts company, and the reader now counts with it

Gash's live ticks decode exactly as 10.0 per stack times stacks times
(1.04 + 0.1k), k = 3..7 - ten percent more per OTHER status the owner
has on the wearer at tick time, the companion hook on the daggers
PASSIVE's script that the rider reader refused by design as
count-scaled. The refusal stands for guessing a number; what lands
instead is the count as LIVE STATE: the dot descriptor carries
perOtherStatus (the vars ratio, behind its rank gate), and the fight
multiplies each tick by one plus ratio times everything it itself has
running - other dots, open debuff windows - which undercounts
multi-instance statuses and marks, and says so in place.

The hook belongs to the STATUS, not the applier: Gash is applied by
whichever skill won the dot selection while the hook sits on a skill
that may not apply anything, so the plan searches every processed
skill for the guard shape and the winner inherits the rider.

And it surfaced a real gap: the plan only knows the hook's host is
SLOTTED if someone tells it. The arsenal pool makes even the weapon
passive a choice, the modkit dump records only the item, and the
snapshot's arsenals list is the weapons owned, not the choices made -
so today's default selection (first two options) drops the passive and
verify prices Gash without the rider it visibly has. The suite pins
both directions with an explicit selection; capture.mjs and
fromSnapshot already consume a snap_wskill row (skill per hand) so the
day the probe emits it, the selection - and the rider - land without
another code change. The probe emitter is the one piece left, and it
needs a login per iteration to test.

911 green.

## 2026-08-11 - Three orbs and a last one, each priced by the script that spends them

The Depth Shield pulse read half of live, and it was three misses
stacked. The pulse count came off the raw row's maxStacks 3, ignoring
the rankOverride that restates 4 at rank 2 - live bursts are four
pulses in twenty-three of twenty-three casts. The split between the
two pulse steps was an even halving, where the script's own shape -
consume a stack, play Area while stacks remain, else play LastOrbArea
- says pulses-minus-one and one. And the rank-3 last-orb rider,
ctx.dmgMult += 1, was disclaimed instead of carried; it lands on the
SkillContext scalar initVars@5150 seeds with the carrier's fervor and
mastery, so the final pulse reads (B+1)/B of a plain one, which is
exactly the 1.77-2.0 spread the capture shows across 297 players -
never a clean doubling. The detector branch now parses the guard
shape, resolves the pulse count through rankOverride, and rides the
rider into the carrier bracket.

The pulse magnitude was the fourth miss, and it names a channel:
STATUS TICKS read the granting item's scaling. A shield-granted pulse
keeps the whole attribute and adds 0.4 x its budget curve on top -
0.55 x (137 + 0.4 x 123.58) x bracket = 116.03 against live non-crit
[116.08, 116.74] - where a weapon-granted tick takes the ordinary
0.6/0.4 mix (Demondash's aura lands -3.2% from -22.7%) and a
Raw-affinity tick stays pure attribute (DuplicatePoison's, exact,
untouched). The engine routes status ids into the two channels by the
granting slot's item type; Raw is gated at the pricing site.

The orb line goes -49.5% to +5.2%. Eruption, Swarm and the Swarm
poison all moved toward live with the weapon channel - -23.3%, -17.4%
and -0.6% - and the Warrior ledger is byte-identical. 908 green.

## 2026-08-11 - The carrier was the player all along

Two prices that both keyed on "it is a status" when the game keys on
WHOSE context the tick runs in.

The fervor-and-mastery bracket - getDamageRatio@4505, seeded into
every SkillContext by initVars@5150 from the status's OWNER - was
skipped for all status ticks on the reasoning that the context belongs
to the carrier. True, and incomplete: for a debuff the foe wears the
carrier is the foe and the bracket is as good as 1, but a self-carried
Buff's carrier is the player, whose fervor and mastery ride every
tick. Demondash's aura read a flat, state-independent x1.27 low across
three sessions; the bracket is the larger half of it. The branch now
applies the owner's bracket when tickCarrierSelf - the same flag, and
the same over-generalisation, the tick-crit rule was already fixed by.

And a swing-triggered tick inherits the swing's BY-TYPE crit.
PurgingStrikes' status plays its damage step synchronously inside
onInflictDamage, gated on isBaseAttack || isFinalCombo - the tick
lands in the swing's hit context 0-1ms after it - so ZealousFighter's
"+8 crit on your attacks" prices the tick too. The model keyed the
by-type bonus on the status row's own cdb type, which is undefined,
and the credit fell on the floor: swings priced at 15.5% crit, their
ticks at 7.5%, live both ~16%. profile() now reads the exact
guard-then-playStep shape off the status script into tickOnSwing, and
the pricing keys the chance AND crit-damage bonuses on the swing's
category for those ticks.

Every self-carried Buff tick on the ledger moved toward live and none
away: PurgingStrikes -45.5% to -34.1%, Sunlight -32.8% to -18.6%,
Eruption -44.7% to -36.8%, Swarm -36.0% to -24.9%, the water orbs
-47.7% to -38.4%, Chaotic Flames -22.7% to -13.8%. Debuffs, DoTs and
Raw ticks priced exactly as before. 908 green.

## 2026-08-11 - A dynVal that adds starts from the authored floor

The blanket refusal of dynVal-scaled statuses conflated three
different ops. getAffixModVal@20794 switches on the mod: op 0
multiplies the authored value by the script-set dynVal - worth zero
until a script writes it, rightly refused. Op 1 replaces it - same.
But op 2 ADDS, and a fresh status instance reads dynVal 0, so the
authored value is a floor the wearer always gets. Priest_Crusader_Status
is the entire op-2 population in the data: authored +10 CritChance,
+10% damage, +10% shield and heal power, and 10 flat cooldown
reduction per press, grown by addDynVal per prayer trigger under the
M2 mastery.

The refusal now keys on the op. Crusader's authored floors are
credited at ONE stack - its maxStacks 300 is the growth channel's
headroom, not a stack count any fight reaches; the applier's own
script is removeStatus + addStatus, a fresh single-stack instance per
press, and the capture's status_on rows say stacks=1 - and flow
through the ordinary timed-buff path at duration/cooldown = 20/120
uptime. The addDynVal growth stays refused and the entry carries
growthRefused so the partial credit stays visible.

The capture agrees end to end: Emsei's in-buff crit ran 24.4% against
12.45% outside (n=127/530), and the blended uplift in the verify
window decomposes as 10 x 0.186 live uptime = 1.86 points of credited
floor plus ~0.5 of deliberately-refused growth, against +2.31
observed. The op-0 rows (DA_Water_Combo, Mage_Talent_Discipline) stay
out, and the suite now pins both directions. 908 green.

## 2026-08-11 - The cap was never four, and two affixes knew better

The signature finisher was priced at a 4-point spend with a literal in
the code and a comment calling it "the cap". The unit row does say 4 -
but exactly two skill rows in the whole data raise it, each with a
TAttribute_Flat MaxComboPoint affix: Rogue_ComboMax, a baseline skill
sitting on the unit row itself, and Rogue_Finisher_Combo_Point, the
permanent State the finisher's checkComboPoints() applies while the
Combo Ruler mastery is held. Masteries are priced as held everywhere
else in the file, so the true spend is 6, and the live capture agrees
to the integer: in the proper-rotation window every finisher hit
factors as A x (1 + 0.3c) with c = 6 on nine of ten hits and c = 5 on
the tenth - a mean spend of 5.9.

comboPointCap() now reads all three numbers off the rows: the unit
stat, the unit-skill affixes, and the mastery-applied State found by
its script shape (hasMastery guarding addStatus, the named status
carrying its own MaxComboPoint affix). The finisher's cost and rider
both use it, as does the checkProba(vars.x * cp) proc roll that was
priced at the same stale 4. The State's +1 lives on no sheet the model
builds - it exists only while the status instance does - so the plan
hands the fight a pool-cap override and the fight takes the larger of
sheet and override, letting a 6-point cost actually be payable.

Rogue_Sig_Finisher goes from -18.7% per hit (MISS) to +3.4% (CLOSE)
against the proper-rotation window, with the share flat at -0.5% - the
cadence survived the bigger price. 907 green.

## 2026-08-11 - A patch is an event, and the model now has a nervous system for it

`bench update` is the patch-day pipeline the precision plan asked for
and nothing ever built. model/fingerprint.json - committed, diffable in
a PR - holds one hash per row of every sheet the model consumes, one
per skill script, and the resolved name-to-findex table for every
bytecode citation in the source. A run diffs the install against it and
prints three things: the drift (rows added, removed, changed, per
sheet, scripts counted separately because the readers execute them),
the citation states (OK, MOVED with the new findex, MISSING with the
formula it orphans), and the work list - every change routed to its
validation: an in-game log for a changed script, the SHEET check for a
constant or an attribute, a model re-read for the rest, each naming
where to stand. --accept records the new build only deliberately, so
the report stays stable while the work it names is being done.

The citation table is a suite gate now, not documentation: the test
fails when a name stops resolving or a cached findex goes stale, which
on patch day is the alarm working. Its first run caught three on the
spot - applyVars@20790, a session-coined label for a function that is
anonymous in the binary, cited as such now; the Sig finisher's onStep
hook cited without its script namespace; and the pipeline's own
docstring example matching itself.

The synthetic-patch test mutates a fingerprint four ways - a stat
nudge, a new row, a deletion, a script rewrite - and asserts each lands
in the right bucket with the right validation need.

MODEL.md carries the verification era now: the two-multiply mitigation,
the two-level armour rating, full multi-parent inheritance, the
standing-versus-combat sheet split, rolled-rarity upgrade ranks, the
tick-crit rule, the rider economies, and what holding all of it against
a live capture measured. 907 green.

## 2026-08-11 - The dash spends a mark, and the poison fires once a stack

Two rates the fresh single-dummy session measured and the model could
not produce, both landed with their own economy.

Demondash's dash carries a 12-second cooldown and a script that resets
it - resetCooldown(skill.kind), the self-referencing spelling the
mutation reader did not know - whenever it hits a target wearing a Mark
that its own Skill2 applies on every damage instance. The player
pressed it at 0.353/s against the model's 0.085/s: a 4.2x under-rate on
the second-biggest hit in the build. The reader takes the self-spelling
now, resolves the Mark through the script's own alias table, and treats
"the target wears a Mark another of my skills applies" as a rotation
fact rather than unreadable state. And because the first attempt
assumed the Mark was simply always there - at which point the sim
pressed the dash at three times the rate its marks could arrive and the
window read +20% - the reset is banked: one mark per supplier cast,
one spent per reset, none means no fire.

Virulent Magic fires once PER STACK of the poison whose ticks it rides:
one hundred and ninety procs on thirty-eight logged ticks at five
stacks, exactly 5.0. The dot-tick event now carries the tick's live
stack count and a status-filtered rider multiplies by it - only the
status-filtered ones, because that is precisely where the evidence
sits, and widening it to every rider without its own measurement would
be the flattering guess this model refuses.

The fresh window, model against a player pressing the proper rotation
on one dummy: end-to-end -19.5% before, -8.6% after; the formulas at
the player's own press rate sit at -2.9%. What remains is named:
Sig_Finisher -19.6% per hit (the combo-point question), the trinket
-48%, two statuses in the minus-twenties, base attacks +10..+24% under
a behind-fraction assumed at 1 while the player drifts.

Baselines: Warrior and Mage untouched; Rogue and Priest move with the
mechanisms. 899 green.

## 2026-08-11 - Three reads land at once: who crits, who stands behind, and what a star is worth

The tick-crit rule, read at the op level and cross-checked against
every status in the capture. initVars@5150 zeroes a tick's crit chance
only for statuses whose statusType carries the DoT or HoT flag - Bleed,
Burn, Poison, Hemorage through its parent - walked up the parent chain
exactly as hasStatusFlag@20821 walks it. Everything else rolls the
CARRIER's chance: a self-carried Buff aura ticks with the player's
crit (PurgingStrikes 11.6% live, Demondash's aura 12.7%), an enemy-worn
status with the enemy's, which is as good as none. The model called
every status tick critless for its whole life; it now flags the row's
types and branches, and every id in the capture lands on the right side
of the rule.

The behind perk, found in the data: Daggers_Upgrade's script pays
`dmgMult += vars.damage` on basic attacks landed in the target's rear
half-plane, rank-resolved to 12% on Emsey's daggers - BOTH of them,
because evalDamage runs every skill instance's hook into one additive
bracket and nothing dedupes by kind. Billed at an assumed behind
fraction, default 1 - the Shadowstep claim - overridable with
--behind-fraction and named in the assumptions, because the one
measured session put a drifting melee at 0.68-0.85. Emsey's base
attacks flip from thirty percent low to a spread centred on the
fraction's own honesty.

And a star is not what the rider rank counts. getWeaponUpgradeSkill
@8182 attaches the upgrade skill only at three stars and reads its rank
off the ROLLED rarity index - updateInf@8174 overwrites the authored
rarity with the roll first. Every measured weapon so far was degenerate
between rolled-rarity and the old stars-minus-one; the two that break
it are a three-star Epic showing its rank-3 perk and a Legendary shield
showing rank-4. The proc chances rank-resolve through the same
overrides now - the Legendary sword doubles at 7%, not the base row's
4% - and one- and two-star weapons carry no rider at all, which the
suite pins.

Last, the scope reader stops collapsing `isBaseAttack || isFinalCombo`
onto the attack chain alone. Zealous Fighter's +8pp crit never reached
the finisher; Master-at-arms' +30% crit damage lost its finisher share
the same way. The scope carries both halves and the router pays both
profile categories.

All four baselines move, none idly: Warrior 601.1 to 601.9,
Rogue 432.1 to 447.1, Mage 238.3 to 245.5, Priest 353.8 to 363.0 -
tick-crit on aura statuses, finisher-half modifiers, and rank-true
upgrade procs are each real mechanisms the optimizer could not
previously see. 899 green.

## 2026-08-11 - A loop that watches is not a loop that pays

Depth Shield's orb status loops at a tenth of a second, and the model
read that as a payout clock: 0.55x Faith spread across a lifetime of
detector polls, 0.7 a tick against the game's 152 a strike - the worst
single per-hit row on the board, off by two orders of magnitude.

The looping step carries no effects. It exists to notice a foe. The
damage lives in Code steps the script plays as it consumes the status's
own stacks, one pulse per orb - which makes the shape a lump of
stacks-many pulses per application, not a DoT at all. profile() detects
the triple now - a loop step with no effects, on a status whose script
consumes itself - prices the pulse steps at the stack count split
across them, and drops the periodic entirely.

0.7 to 74.0 against a live 152.3. The remaining half is stated in the
code rather than hidden: the rank-3 last-orb double is not carried, and
the live mean sits at almost exactly twice the plain pulse - which
smells like the double applying more widely than the script's last-orb
branch reads, and is the named next question for this row.

Baselines: Warrior 601.1, Mage 238.3 untouched; Rogue 432.1 and Priest
353.8 carry the session's earlier movements only. 898 green.

## 2026-08-11 - Death Mark reads, and the poison finally has all three of its hands

Two mechanisms, both named by the residual investigation, both landing
within their predicted effect.

Death Mark's status carries no affix, no tick, no step - its entire
payload is one line of script, `dmg.dmgMult += vars.var1` inside
onReceiveDamageEval, gated on `sourceObject == status.instigator`. That
is a target debuff in disguise: +15% to everything the INSTIGATOR deals
to the wearer for thirty seconds, and nothing to anyone else. statusesOf
reads the shape now and routes it to the debuff channel with
`scriptTaken`; targetState folds it exactly where an affix saying the
same thing would land; and a cooldown press whose payload is a target
debuff window is scheduled the way a self-buff window always was. The
fight presses it three times in two hundred seconds and prices the
windows through the lookahead.

Lethal Poison was starved of two of its three appliers. The game feeds
it from the talent (20% per swing or finisher), Envenom (every
finisher's first hit) and Venom Infusion (25% per weapon skill) all at
once, and pins it at its stack cap; the model collapsed the three to
one channel per status and averaged a stack and a half of six. The
collapse now keeps one status IDENTITY - one tally, one stack count,
one live instance - and registers it in every applier's event channel,
each channel carrying its own chance and its own deterministic-thinning
credit. The per-hit row goes from -81.0% to -1.4%, which was the worst
residual in the model and is now one of its best.

One reporting nit surfaced by the suite within minutes: with several
appliers the per-application snapshot varies, so a stack average
back-derived from damage can drift past the cap it is enforced at. The
report clamps to the cap it knows rather than un-enforcing it.

Rogue baseline 409.1 to 432.1 - Death Mark windows plus a properly fed
poison are real value. Warrior, Mage, Priest unmoved. 898 green.

## 2026-08-11 - The deficit wore a costume: verify filtered the capture to dummies and priced the model against a boss

Three classes of direct hits read 15 to 25 percent low on targets that
mitigate nothing, and the cluster spanned every skill and every class,
which should have said "one term" louder than it did. The term was in
the harness. `--target Dummy` filtered the CAPTURE to dummy hits and
then evaluated the MODEL against the default reference foe at 0.25/0.25
mitigation. At level parity with each build's penetration that is
-18/-25% on Emsey's physical and magical hits, -15.3% on Emsai's,
-21.6/-13.6% on Emsei's - the exact cluster, reproduced arithmetically
by the investigation before the fix was written. verify now prices
against the target the capture was filtered to.

With the costume off, the ledger tells a different story on all three
clean windows: every class at 100% coverage, zero MISSING, zero
PHANTOM, and per-hit at 2/6/3 (Warrior), 5/2/7 (Priest), 1/5/13 (Rogue)
match/close/miss - including rows the mitigation had been flattering,
which now read honestly high and are named per-skill errors.

The last coverage rows fell to three reader changes. Acidic Splatter: a
talent's steps are only reachable through its script, so a status they
apply takes its trigger from the script's own playStep site - the
signature finisher's first hit at vars.chance x combo points, priced at
the cap with the assumption stated (0.2 x 4 = 80% per finisher). Its
poison cloud and its -25% MagicArmor debuff ride the same status. The
demon trinket: `!hasStatus(dmg.target, X)` is the no-reapply gate with
the recipient named instead of the owner, and a ROLL with no predicate
on an inflict hook is floored to the swing-and-finisher clock - three
percent per damage instance is a rate, and refusing a rate is not the
discipline. The Swarm's rank-3 poison rides the same floor.

The floor is for rolls only, and the hour it briefly was not proved
why: an unconditional application floored to once per swing read
optimized Rogue and Mage builds at 4.6x their previous totals. No roll,
no floor - refused, as before. Baselines settle at Warrior 601.1
(unchanged), Rogue 409.1 (+8.5%, Acidic Splatter is real value), Mage
238.3 (unchanged), Priest 353.8 (the two talent statuses). 898 green.

## 2026-08-11 - The last silent drop: a status that fights

Two Priest talents put a fifth of the class's recorded damage through a
shape no bucket had a name for - a status, worn as a buff, whose script
plays damage steps on events the fight raises. Sunlight's status deals
0.6x Faith on every combo finisher while it is up; Purging Strikes'
deals 0.15x Faith on every swing and finisher. Not a dot - nothing
ticks. Not a buff - no affix. statusesOf routed them nowhere, silently,
the one place left where the model dropped damage without a word.

Three small pieces close it:

profile() stops folding a status row's Code steps into its effects when
the status does not loop. A looping status plays its step per tick and
the dot pricing rightly consumes it folded; a non-looping status's Code
steps are event riders, and folding them buried them in a bucket
nothing reads.

The talent pass runs each talent-applied status through profileOf, so
its scripted steps park in the same rider machinery every skill's
already use - same guard reader, same refusal discipline, same uptime
assumption as every self-applied gate: the status is up when the event
lands, and the applier is the talent itself.

And scriptedRiders follows ONE hop through onStep. Sunlight's script
plays Steps.Trigger from onInflictDamage and the Damage step from
onStep gated on `s.kind == Steps.Trigger` - the real event is wherever
Trigger was played, so the reader takes the hook and guard there,
keeping the inner scope's own conditions (a hasSkill gate on the inner
hop still gates - SunHalo's area step stays off for a build without
SunHalo).

Priest on the clean dummy window: coverage 77.7% to 98.1%, MISSING
three to one. The Priest baseline moves 316.5 to 346.6 and should - the
optimizer's build takes both talents and their damage now exists. The
other three baselines and both other verify windows are untouched. 897
green.

Named, remaining: the Swarm's rank-3 poison (1.9pp, applier event is
the Swarm's own hits); Depth Shield's orbs, now visibly mispriced at
0.7 against 152 per strike - its loop is a DETECTOR, not a payout
clock, and the charges are the real schedule.

## 2026-08-11 - Armour is a rating at a level, and the level is not always yours

The model priced every target as if "authored 0.40" meant forty percent.
The bytecode says it means something narrower: getResistanceLevelScaling
@20663 converts the authored reduction into a resist POOL at the
TARGET's level - red*(385+100*L)/(1-red) - and getAffinityDamage-
Reduction@4510 divides at the STRIKER's. Two dials. Forty percent is
what you get when they agree.

foe() takes the second dial now: foe(name, level, targetLevel), pool at
the target's spawn level, divisor at the attacker's, parity when the
caller says nothing - which is every current caller, so no number moved
and the four baselines say so. --target-level exposes it.

Parity stays the default for a measured reason, not a lazy one. The
boss rows' own lvl column is contradicted by the capture: Ratsar's row
says 10, and at 10 the formula predicts mitigation the fight simply did
not show - inverting the clean magic channel of the real fights puts
him at 18-25. World bosses spawn at zone level, set by world data this
model does not read, and zone level is the player's level in practice.

The rest of the boss-fight reconciliation, for the record, because it
retires a standing anomaly: dynamic scaling
(GameObject.getDynamicScalingFactor@4638) is fully read - a Vitality-
ratio multiplier behind an activity-flag gate - and demonstrably
inactive in every captured fight. And VirulentMagic reading 29-36%
mitigation where its zero Spell Penetration predicted forty was not the
boss at all: it was the Rogue's own Acidic Splatter carrying -25%
MagicArmor on the target for most of the fight, compounded by Death
Mark's +15%. The kit was shredding the boss and the model could not see
the shredding. Both debuffs ride machinery that already exists -
targetState() multiplies foe armour from a worn status's affixes - and
what each still wants is only its application rate: Acidic Splatter is
per-combo-finisher at min(1, 0.2 x combo points spent), Death Mark is a
pressable on a 90s cooldown. Named for the next pass.

## 2026-08-11 - A cast that deals nothing and delivers a quarter of the class

Two triage lines, one in the plan and one in the fight, each dropping
the same shape from a different side: a cast whose entire payload is a
damage-over-time.

Swirling Embers is an 18-second cooldown whose only step applies an
eight-second aura ticking 0.25x(Dex+Faith); Depth Shield's cast applies
orbs that strike on their own clock. The plan filed both under `passive`
because the cast carries no direct damage, so their dots were refused
with "nothing gives it a rate this model can price" - while the rate sat
on the row as the cooldown. And the fight dropped them a second time:
its actives filter kept a cast only if it output damage or set up a
buff, and applying a dot was neither.

The plan now schedules a cooldown cast that applies a dot exactly the
way it schedules one that applies a timed buff, and the fight keeps a
cast that is the applier of a dot it tracks - the dot fires off that
cast's own event, so dropping the cast was dropping the dot.

Priest coverage on the clean dummy window: 54.3% to 77.7%, MISSING five
to three. Rogue 92.5% and Warrior 100% unchanged, four baselines
unmoved, 892 green.

Still missing, named: Sunlight and PurgingStrikes - statuses whose
payload is a one-shot Damage step with no tick and no affix, which
statusesOf silently routes nowhere (the one place the model still drops
something without a word); and the Swarm's rank-3 poison, whose applier
event is the Swarm's own hits. Both are read, both have every number
authored in the cdb, and both want one statusesOf change that is next.

## 2026-08-11 - The character sheet is not the fight, and the fight was leaking into it

Four fixes out of one investigation round, and the sheet check lands
exact on every verified character: Rogue 9/9, Warrior 9/9, Priest 10/10
attributes within one percent of the game's own affix arithmetic.

The Fervor over-count was never in the gear or the augments - both
reproduce the game to the point. It was the reporting boundary. The
engine folds permanent self-buff statuses into the sheet at full stacks
- Devote's five six-Fervor stacks, +30 - which is exactly right for
PRICING, since standing at the cap is the entire value of the enchant
slot, and exactly wrong for the sheet `bench verify` holds against the
game's standing arithmetic. The two are split now: the fight keeps
pricing against the status-capped base, and the reported sheet stops at
what the game shows you standing still. DPS is untouched by
construction, and the baselines did not move.

The split has one subtlety, and a regression test caught it within
minutes: duration. The Boomerang's crit aura never expires - wielding
the axe IS the status - and the game's standing sheet shows it. Devote's
stacks last fifteen seconds and exist only once combat applies them. A
status with no duration is an aura you wear; one with a duration is a
state you enter. Duration is the split, and it is the game's own.

The live side of the sheet check now drops status-sourced affix rows
too: the probe caught Emsey mid-Devote-stack and Emsai mid-dash, and a
snapshot is entitled to catch you doing something without the model
being wrong about it.

BlockMitigation closed the same hour: the model granted a weapon's
PhysicalBlock AND the shield's ShieldBlock, 110 against the game's 60.
One block slot per hero, the shield's wins - and the weapon's copy
arrives both through its own skill list and its itemType's, so the skip
guards both doors.

And verify learned the difference between a phantom and a rotation. A
model line with no damage is a heal or a shield, not a claim the capture
can contradict - both Priest prayers were phantoms of this kind. A line
with damage the player never PRESSED in the window is the model playing
a rotation the human did not - Skill2's direct damage is real, priced
correctly, and simply was not part of how Emsey plays. not-pressed is
its own quiet row now, and PHANTOM is reserved for the damning case.

## 2026-08-10 - A tick is a tick, and Virulent Magic finally rides one

Three readings and one sim change, and the largest remaining MISSING row
crosses into the scored column.

Rogue_Talent_VirulentMagic was already reaching scriptedRiders - the
talent pass has existed all along - and being refused on its guard:
`hasStatusMaxStacked(s.target, Skill.Rogue_Talent_LethalPoison_Status)`
matched the unread-condition list and that was that. But both halves of
that guard are readable for THIS build. `s.status.kind == Skill.X` names
which dot's tick the rider rides - a filter the fight can honour, not a
question about live state - and hasStatusMaxStacked, for a status the
build itself applies, is an assumption worth naming rather than a
refusal: in a sustained fight the cap is reached and stays reached. The
rule now says both aloud, including that the ramp before the cap is
credited as if it fired.

The tick vocabulary also split. isStatusType(Bleed) is the pool-dot
event and stays on that clock; isDoT() and onInflictStatusEval mean any
tick of anything; a kind== filter means one status's ticks and no
other's. The sim raises them accordingly - regular dots now fire the
dot-tick event too, carrying their status id, and each rider filters for
itself. The Warrior's two bleed talents keep bleedOnly, or they would
have started riding every poison in the game.

Against the clean Rogue dummy window: coverage 83.8% to 92.5%, MISSING
four to two, VirulentMagic scored at 377 live hits with a -29.7% per-hit
residual that is now a formula question rather than a hole.

Rogue's baseline moves 351.8 to 377.0 and is supposed to: the
DuplicatePoison rider was firing on pool ticks only, and the game fires
it on every poison tick - eighteen modelled hits against two thousand
eight hundred recorded was the original finding. Warrior, Mage, Priest
baselines unmoved. 892 green.

## 2026-08-07 - Two rings, one jewel, and the right hand went bare

Socket placement resolved a host's slot with a find, which returns the
first match. Both of Emsey's Finger_Z3RCraft_Ap rings therefore handed
their jewel to Slot_FingerLeft and the second overwrote the first, so
eleven augments were placed out of twelve and the right ring wore
nothing. Emsai had the same pair and the same hole.

The snapshot gives every socket a host id and an index within that host,
so they are grouped by host now and the nth occurrence of an index goes
to the nth slot that item occupies.

Against the game's own affix arithmetic, on clean dummy windows:

  Emsey   8/12 attributes within 1%  ->  10/12
  Emsai   5/10                       ->   7/10

CritChanceRating and ArmorPenetrationRating closed on both, which is
what a missing Cursed Eye of Vice was worth - it carries nine of each.

What is left is one damage-relevant discrepancy and it is the same on
every class: FervorRating reads over, +12.2% on the Rogue and +23.6% on
the Warrior, and the missing jewel had been masking part of it. The
augment affixes themselves are right - three Cursed Eyes at nine apiece
and the shield's gift at forty, all matching the capture term for term -
so the excess is in what socketing does to the host rather than in the
socket. Only the Epic Corrupted Gifts declare an iLevel at all, and
Emsai wears exactly one, which cannot be worth thirty Fervor on a shield
that carries none of its own. Named here rather than guessed at.

MoveSpeedFactor and BlockMitigation are also out but neither reaches a
damage number; BlockMitigation reads 110 against the game's 60 on both
shield users, which looks like a cap the model does not apply.

## 2026-08-06 - The rarity a thing rolled is not the rarity it was written as

Chasing the weapons' missing fourteen percent found it one line above
where I was looking. fromSnapshot discarded the captured rarity on a
stated assumption that the snapshot "reports the authored rarity name,
which is the same answer". It does not.

Daggers_Demondash is authored Rare. Emsey's instance is Epic - a purple
tooltip and three of four upgrade pips, which a Rare cannot even hold.
That costs twice over. Rare's iLevelBonus is 10 against Epic's 30, so
the weapon is priced two effective levels light and every stat line on
it moves down together; and Rare permits three upgrades against Epic's
four, so maxStars quietly clipped the arsenal dagger's fourth star.

Head_RManfish_Ass is authored Rare AND rolled Rare, which is precisely
why it was the piece that matched all along.

Rarity now arrives two ways and both are handled: the modkit dump writes
an index with -1 for "never rolled one", a capture snapshot writes the
rolled rarity's id. Only the id is usable, so a number is treated as the
dump's sentinel and the authored rarity stands in.

The user's hypothesis - that a Corrupted Gift raises the host's item
level - is correct and was already implemented; effectiveLevel adds each
socketed item's iLevel and the comment beside it quotes the same
observation from play. It simply was not the thing still missing.

Sheet against the game's own affix arithmetic: 3 of 9 attributes within
one percent, now 8 of 12. Vitality, Dexterity and Intellect closed
entirely. Per-hit exact matches 1 to 3. 892 green, Rogue baseline
unmoved - toLoadout is a verify path and the optimiser never walks it.

## 2026-08-06 - The floor was in the game too, and the diagnostic was the thing that was wrong

The sheet check reported SpellPenetrationRating as -83 in the game and 0
in the model, and I read that as the model wrongly flooring a stat the
game lets go negative. It is the other way round. The attribute row says
negativeAllowed is false, getAffinityDamageReduction clamps penetration
to [0,100] at ops 248-258, and Emsey's own character screen reads Magic
Penetration 0% with two Corrupted Gifts summing to -83.

So the model was right and the comparison was not: it summed base plus
affixes without applying the floor it was measuring against, and then
reported a -100% error.

It applies the attribute row's own rules now - the negative floor and
the rounding - which is what makes the live column reproduce the game's
displayed sheet exactly: Emsey 163 Vitality, 166 Dexterity, 61
Intellect; Emsai 134 Strength; Emsei 137 Faith; Emsay 140 Intellect,
every one matching the character screen.

A diagnostic that does not obey the rules it is checking will invent
findings, and this one invented a clamp bug that never existed.

## 2026-08-06 - Every discrepancy was one missing socket, and here is the arithmetic

The sockets arrived and the prediction held.

Emsey's twelve, read straight off the wire: DemonGearUpgrade_MPToAP and
FormulaWeaponFlamingWeapon in the main hand, DemonGearUpgrade_MPToFerv
and FormulaWeaponDevote in the arsenal, MysticCopperPlate in the chest,
MysticEmbroidery on the back, FormulaHandsDexterity_Z2 on the gloves.
That last one is the four Dexterity the gloves were short by, and the
two Mystics are the two-and-two on chest and back - named now instead of
inferred.

Selection had to learn about them first. Only seven snapshots in
thirty-nine carry sockets, because a capture spans several probe builds
and each added a column, so the run was picking a complete-looking
snapshot that predated them and reporting no sockets at all. It ranks by
how much of a build a snapshot describes now: slot count, then whether
it carries sockets and affixes, then damage recorded under it.

The sheet, against the game's own affix arithmetic:

  Dexterity              -10.7%  ->  -4.0%
  ArmorPenetrationRating -31.7%  ->  -3.5%
  Intellect              -14.4%  ->  -4.5%
  CritChanceRating       -18.8%  ->  -7.6%
  Vitality                -7.1%  ->  -5.2%

And the damage, without a line of the damage model being touched:

  per-hit   0 match / 1 close / 14 miss  ->  1 match / 8 close / 7 miss
  MISSING   4 -> 3

Two new things are visible now that the noise is down. FervorRating has
crossed to +7.9%, so something is counting Fervor twice - the Corrupted
Gift and Devote both touch it. And SpellPenetrationRating is -83 in the
game and 0 in the model, which is not a scale error but a floor: the
game lets penetration go negative and the model does not.

## 2026-08-06 - The game shows its working, and the sheet was wrong all along

A capture's affix rows turn out to be the game's own derivation of the
character sheet: one row per applied affix, carrying the value it
contributed and the item or skill that applied it. Base stats plus that
sum reproduces the in-game sheet to within rounding on every attribute
of every one of the four classes - Warrior's Strength 33.97 + 100 =
133.97 against a displayed 134, the Rogue's Dexterity 39.67 + 126 =
165.67 against 166, the Priest's Vitality 38.21 + 164 = 202.21 against
202.

So the base curve is right and the affix stream is complete, and the
model is short. Not by a constant, which is the useful part: the
Warrior's SpellPenetrationRating is -73 in game and +22 in the model
because neither half of the Corrupted Gift is counted; ArmorPenetration
and CritChance ratings run 19-32% light across all four; the core
attributes 8-19%. Per item it splits three ways - weapons about a fifth
under, some armour missing an Intellect affix entirely, and the craft
rings out by exactly two.

`bench verify` prints that comparison now, next to the damage. It has to
be there rather than in a tool of its own, because a skill reading
twenty percent low on a sheet that is itself twelve percent low is not a
twenty percent damage error, and the ledger was quietly inviting that
mistake every time it printed.

Derived attributes are excluded by construction: CritChance is computed
from CritChanceRating, so comparing it to base-plus-affixes would invent
a discrepancy out of the very conversion the model is meant to perform.
The filter reads the attribute table rather than a list of names.

Snapshot selection now prefers one carrying affixes, after slot count
and before event count - a snapshot that cannot check the sheet is worth
less than one that can.

## 2026-08-06 - Sockets stop being a permanent apology

The bench reads snap_affix and snap_socket, and puts the augments into
the loadout it scores. An augment's own row names the socket type it
occupies and the host names the slot, which is exactly the key the
loadout already uses, so placing them is a lookup rather than a scheme.

"sockets and enchants are not captured" leaves the gaps list after
however many sessions it has been sitting there. What replaces it is
narrower and checkable: an augment that will not resolve is named, and a
snapshot with no socket rows says so rather than implying an empty
build.

The affix rows are carried but not yet consumed. They are the sheet's
own working - one row per applied affix with the value it contributed -
and the right use for them is to check the computed sheet against the
game's, term by term, rather than to replace it. That wants its own
command and its own thought.

## 2026-08-06 - The hook that made two thousand hits out of forty-nine casts

onInflictStatusEval is read now. It was the largest single thing the
model could not see: hook-coverage put 35.6% of a Rogue's damage behind
it, and Daggers_DuplicatePoison_Skill1 alone was a quarter of the build,
priced at eighteen hits where the game recorded two thousand eight
hundred. Its script is four lines - on a DoT tick, against a target
carrying its own status, half the time, play a bonus step.

Four things had to be true for that to be read, and none of them was.

The hook was not in RIDER_HOOKS, so every playStep behind it was refused
as an event this fight does not produce. It fires because a status dealt
damage, which is a tick, and the fight already raises one.

`isDoT()` was not recognised. BLEED_EVENT knew isStatusType(Bleed) and
nothing else; the poison weapons phrase the same question the other way.

`target.hasStatus(Skill.X)` was refused as live state the reader cannot
answer - true in general, and false when X is a status this very skill
applies. The host puts it there. It is blanked the way the tick event is,
and the assumption it leaves behind is stated in the rule's own `why`,
because a host on a 24-second cooldown will not hold its status through
every tick of a fight.

And `bench verify` evaluated at rank 1. Weapon mastery is not decoration
when a script opens `if (rank >= 3)` - the whole hook is invisible below
it. Every other command takes rank from commonSetup; so does this one now.

Then the rider showed up as damage the game never recorded, because the
model prices a script step on its own line as `<host>#<step>` and the
probe logs `dmg.baseSkill`, so the game files it under the host. compare()
folds them. Reporting it separately was two wrong answers from one naming
difference: a phantom, and a host short by exactly that much.

Against Emsey's live capture, over the session still being played:
coverage 72.2% to 83.1%, MISSING six to four, PHANTOM two to one, and
Daggers_DuplicatePoison_Skill1's per-hit error from +186% to +42.8%.
892 green; all four baselines unmoved, because only two skills in the
game declare this hook and neither is in an optimised build.

## 2026-08-06 - The talents were captured, and then not handed over

Three fixes, and the first fair question the model has ever been asked.

A snapshot's `level` is the item's own level - 25 on Emsey's daggers -
and `ilevel` is a different scale entirely, 280 on the same daggers.
Feeding the second where the catalog expects the first priced a level-25
Rogue at nine hundred and twenty-seven quadrillion dps. The snapshot
carries both; only one of them is what the catalog means by a level.

Choosing between snapshots takes two rules in this order: how much of a
build it describes, counted as gear that resolves to something wearable
in a combat slot, and only then how much damage was recorded under it.
Ranking by damage alone picked a snapshot whose entire build was one net
and a pile of soulstones, because it had been on disk longer than the
correct one had been alive. A build with one slot is not a build, and no
amount of evidence beneath it makes it one.

And the talents were being read, validated, carried on the returned
object - and never written into the loadout the engine scores. A tree
node is keyed by its skill id, which is exactly what the snapshot
reports, so the wiring is one line.

Against Emsey's live capture: coverage 72.2% to 80.4%, MISSING six to
five, Rogue_Talent_LethalPoison_Status crossing from a coverage hole
into a scored line, and the first per-hit MATCH this project has
recorded. 892 green, Rogue baseline unmoved at 351.8.

What is left in MISSING is now a short and honest list: VirulentMagic
and AcidicSplatter, whose damage comes through onInflictStatusEval; a
Demondash status; the demon trinket's proc; and a weapon enchant. Four
of the five are script hooks, which is the answer hook-coverage.mjs gave
before any of this was wired.

## 2026-08-06 - A snapshot is worth what it can be checked against

Three things the first real snapshot capture taught, all of them about
choosing and trusting a build description rather than about damage.

Pick the snapshot with the most damage under it, not the most recent
one. The last snapshot of a session is written as the player logs out,
so selecting by recency selects the one build with no evidence behind
it - and the run came back with zero events and a 1.9 dps model. The
count is taken in the pass that already reads every row.

Skip an item the class cannot wear instead of refusing to score at all.
The probe handed over a backpack, the backpack held a Wizard staff, and
`toLoadout` threw rather than shrug. A build description is not a
promise that everything in it is wearable; the item is skipped and named
in the gaps.

Resolve the sheet. UnitAttributes.attributes is keyed by the
attribute's position in the cdb sheet, so it arrives as {63: 1105} and
means SprintSpeed. Worth saying plainly that it is not the character's
stats: twelve of seventy-eight attributes appear, Strength and
CritChance among the missing, so it reads as a sparse override map. The
named scalars on the same object are base values - critChance 5 on a
geared level-25 hero. Where the live sheet lives is still open, so this
is carried as a cross-check and never as an input.

## 2026-08-06 - A talent that is not a skill is not a talent

Reading the corrected snapshot, and refusing the old one.

`snap_sheet` carries the live stat sheet off UnitAttributes.attributes,
which is the one the game fought with; `snap_attr`'s named scalars turned
out to be base values. `snap_err` carries what the probe could not read,
and it reaches the report as a named gap rather than vanishing.

fromSnapshot now checks every talent against the cdb. A talent id is a
skill row like any other, so one that does not resolve is not a talent -
and there are twenty-four rows on disk named `map`, `obj` and `bit` from
the probe build that could not see into hxbit's proxy. Handing those to
the model would be worse than handing it nothing, because it would look
them up, miss, and carry on. They are rejected by name in the gaps list.

And `bench verify` says which build description it used. It was already
falling back to the login dump when no snapshot carried gear - correct,
since none of the eight on disk does - but it fell back silently, so a
run with eight contemporaneous snapshots sitting in the capture read
exactly like a run with none.

## 2026-08-06 - Weighing the half of the game the model has never run

427 of the 962 skill rows carry a script the bench does not execute. It
reads four things out of that text with regexes - addStatus, the event
predicate, checkProba, vars.chance - and 84 of the 119 declared hooks
are named nowhere in this repo. Whether that mattered has been an open
question for as long as the question has existed, because there was
nothing to weigh it against.

There is now. Against Emsey's last three sessions: 29.4% of the damage
came from skills with no script at all, 12.2% from skills whose every
hook is read, and 58.4% from skills declaring a hook that is not.

The offenders are nameable, which is the useful part.
Daggers_DuplicatePoison_Skill1 is a quarter of the damage on its own and
its script is four lines - onInflictStatusEval plays a bonus step every
time a DoT ticks on a target carrying its status. The skill has a
24-second cooldown, so roughly forty-nine casts produced two thousand
eight hundred hits, and the model priced eighteen. That is not a formula
being wrong by a factor; it is a hook that was never run.
Rogue_Talent_VirulentMagic is another tenth through the same hook.

So the residual is script-shaped. Not input-shaped, not a coefficient.
One hook, onInflictStatusEval, sits under 35.6% of this build's damage.

Two caveats are in the header of the tool and belong here too. Declaring
an unread hook is not the same as the damage coming from it, so 58.4% is
an upper bound. And the per-hook table credits a skill's whole damage to
every unread hook it declares, which is why shouldHighlightSkill - a UI
decision - scores eight percent across the wider capture. Read it as a
reading order, not a measurement.

## 2026-08-06 - A build that was written down while the damage was still happening

The bench side of the probe's snapshot.

`capture.snapshots()` reads the `snap` family back out of a log, and
each one carries what the modkit's dump never could: the talents. It
also carries the live sheet, which is the right thing to check a
stat-level disagreement against rather than re-deriving it.

`inventory.fromSnapshot()` turns one into a loadout, reusing the dump's
slot assignment because the gear arrives in the same shape. It restates
the gaps honestly - sockets and enchants are still uncaptured, and a
snapshot with no talent rows says so rather than implying none are
taken.

`bench verify` now prefers a snapshot and falls back to the dump, with
--dump to force the old path.

The part worth noticing is the window. A snapshot stands until the next
one, so it is not just a better description of the build, it is the
boundary of the stretch that build was played over - which is exactly
the thing this command was guessing at with "the last three sessions".
That guess was a stand-in for "since the gear last changed", and now
there is a timestamp that says so.

Tested against a synthetic log rather than a live capture, so the reader
is exercised before the probe that writes them has been deployed:
markers bound each other, a later build does not inherit an earlier
one's gear, the window selects only the damage its own build did, and
snap rows never leak into the damage stream.

892 assertions green, baselines unmoved.

## 2026-08-06 - A unit has more than one parent, and the model only ever met the first

`unitChain` followed `inherit[0]` and stopped. Three hundred and five of
the five hundred and sixteen unit rows declare two or three parents, and
the shape is always the same: an archetype first, a species second.
Boar_Z2W_2 inherits [W_Base, Boar_Z1W], so the old walk found world
trash and never found the boar.

DataCache.initUnits@18912 builds the closure at @18967 and runs it over
every row. It iterates every inherit entry, resolves each parent first,
then merges field-wise: an attribute the child does not have is copied
whole; an attribute the child declares as a bare multiplier - no value,
no levelScaling, no specScaling - is thrown away and replaced by the
parent's row with the two multipliers multiplied together; and anything
else the child keeps, except that a null multiplier is filled from the
parent. Only nulls are ever filled, so a child beats its parents and an
earlier parent beats a later one.

`mergedStats` now does that, memoised, and refuses to loop.

What it turns up: Golem_Base declares Armor as `multiplier: 1.6` and
nothing else. A golem inheriting [W_Base, Golem_Base] takes W_Base's
0.30 curve and Golem_Base's multiplier, and because the multiplier
scales the resist POOL rather than the fraction, it comes back as
1.6*0.3 / (1.6*0.3 + 1 - 0.3) = 0.4068. Off a Unique parent 0.4628, off
an Elite one 0.5161. The level cancels, which is why one number
describes a golem at every level.

So the comment that said physical and magical reduction are equal on
every real foe was wrong, and wrong because of this bug: seventeen
golems are harder to hit than to burn, and against them ArmorPenetration
is worth materially more than SpellPenetration. That paragraph is
rewritten and the test that asserted symmetry is narrowed rather than
deleted - it now says the split is exactly the units inheriting
Golem_Base, so a patch that splits anything else still trips it.

Four golems fail to inherit Golem_Base at all: the elite variants take
[W_Base_Elite] alone and read a symmetric 0.40, while the ordinary
version of the same creature carries the multiplier. That looks like an
authoring slip, and the test pins it as observed rather than smoothing
it over.

Baselines unmoved - Warrior 601.1, Rogue 351.8, Mage 238.3, Priest
316.5 - because the default target is Armor_ExpectedReduction and not a
golem. 878 assertions green.

## 2026-08-06 - A command that can call the bench wrong without asking anyone's opinion

`bench verify --character <Name>` reads the gear the modkit dumped, runs
the model on it, reads what the probe recorded that character actually
doing, and prints the difference per skill, signed.

Model minus capture, so a positive number is the model claiming too
much. Per-hit leads because it needs no clock and no fight boundary -
the same skill landing on the same target - so a disagreement there is a
formula error and nothing else. Share, crit and cadence follow, in
descending order of how much each can be trusted; cadence is a smell,
because open-world play is not a fight.

MISSING and PHANTOM outrank every delta. One is damage the game did and
the bench cannot see, the other is damage the bench invented.

The window defaults to the last three sessions rather than the whole
log. The first run of this comparison read Emsey's entire back catalogue
of weapons as missing coverage, because the dump is one instant and the
capture is eighty-four hours - Bow, Spear and Fists skills from gear
long since swapped out. A capture and a build have to be talking about
the same afternoon.

The report ends by naming what the dump cannot see - sockets, enchants,
talents, consumables - because damage from any of those arrives as
MISSING, and reading that as a broken formula would send someone hunting
a bug that is really a missing input.

First run against Emsey, Rogue 25, last three sessions, 15,034 events:
73.3% coverage, 13 matched, 6 MISSING, 1 PHANTOM, and not one skill
inside the per-hit band. Three of the six MISSING are talent statuses
the dump cannot carry. That is the ledger this was built to produce.

## 2026-08-06 - Two levers that never meet, and the model had welded them together

`mitigate` folded `armorIgnore` into penetration and handed the sum to a
single `(1 - pen/100)`. The game does not. `getAffinityDamageReduction`
@4510 reduces the resist pool twice: once at ops 133-147 for a physical
hit's `armorIgnore`, or ops 80-95 for a magic hit's `magicArmorIgnore` -
`isMagic` at op 75 and `isPhysical` at op 127 select one branch, never
both - and once more at ops 259-263 for penetration.

So the game computes (1 - a)(1 - b) and the model computed (1 - a - b),
which overstates damage by 2.0% at 10% ignore against a 0.40 elite and
3.3% at 60% penetration. The two clamps are independent too, one to
[0,1] and one to [0,100]; clamping the sum let a large penetration hide
an out-of-range ignore.

The forms agree exactly when either term is zero. That is why every
calibration to date could pass over it - no captured build had an
`armorIgnore` source live - and why the four baselines do not move:
Warrior 601.1, Rogue 351.8, Mage 238.3, Priest 316.5, unchanged, and
601.1 three runs running.

`damageReduction` takes the ignore as its own parameter because folding
it into penetration cannot express the second multiply. `survivability`
needs nothing: a reference foe brings neither lever.

The live carrier is Warrior_ExposedEssence - maxPoints 2, vars.var1
0.05, rankOverride to 0.10 at rank 2 - which writes both `armorIgnore`
and `magicArmorIgnore` when the target carries a Bleed. Rank 2 alone is
worth ten points of ArPen. The error was never the term; it was the
composition.

## 2026-08-06 - The record was always on disk, and nothing had ever read it

Four modules that let the bench be told it is wrong by something other
than a person.

capture.mjs streams the probe's log - 4.6M rows in about ten seconds,
never held in memory - and aggregates it per skill, per source or per
target, with exact quantiles off an integer histogram. Three properties
of that file have already produced a false conclusion in this project
and each is now written down where the parser is: the head of the log is
unattributed for 2,727 rows and no further; applyDamage logged nothing
in 4.5M because the server computes damage and the client's copy throws;
and the amounts are not uniformly whole, so `integrality` measures which
paths round rather than assuming one convention for all of them.

inventory.mjs turns the modkit's character dumps into a loadout - the
character as actually equipped, which is the only build a capture can be
held against. It names what the dump cannot see rather than defaulting
it: no sockets, no enchants, no talents, no consumables.

verify.mjs is the join. Per-hit first, because it needs no clock and no
fight boundary, so a disagreement there is a formula error and nothing
else; then share, crit, and cadence, in descending order of how much
each can be trusted. MISSING and PHANTOM matter more than any delta -
one is damage the bench cannot see, the other is damage it invented.

Every delta is model minus capture, so the rows add up to a ledger
instead of a list of complaints.

## 2026-08-03 - The mace could always have pretended to be a net, and the search forgot

Fixed gear prices every arsenal sanely - the mace above the net above
the empty hand. Turned loose, the optimizer hands the mace a build worth
forty-five points less than one it provably dominates: every net plan is
a mace plan that keeps its skills sheathed. The numbers repeat, so these
are not unlucky restarts but stable wrong valleys, the same family as
the injection regression and the player's thirty-three-versus-
thirty-four on an item that is nothing twice. Two invariants go to the
suite: a nothing item scores the same in either hand, and no real weapon
loses to the net it could imitate.

## 2026-08-03 - Two pins the optimizer honoured and nobody could reach

The player finished the probe with the experiment that decides it: the
net alone in either hand, offhand pinned shut, and the two numbers meet
at thirty-four. The earlier gap was never the net - it was an empty
mainhand leaving the shield slot open, and the optimizer building a
loadout no character can stand in. The guard writes itself: a missing
mainhand forfeits the offhand, or the pin is refused by name. And the
sheet still hands the net a greatsword's WeaponPower through a fallback
the bytecode never wrote - inert here, proven inert by the same
experiment, and one line whenever the word is given.

## 2026-08-03 - A cooldown you press is not a thing that is simply true

Battle Shout is fifteen seconds of +20 CritChance on a hundred-and-twenty
second cooldown and it read as a DEAD BAR SLOT - worth negative, because it
occupied one. Berserk went the same way, and so did Blessing of Fervor and
Smoke Bomb.

The cause is one test. A pressable skill with a cooldown was only kept as a
cast if the status it applies carried a ONE-SHOT amount - a shield, a lump
heal. A status carrying an AFFIX fell past that into `passive`, the bucket for
things that are simply true. So the fight never cast it, the window never
opened, and the buff sat in `timedBuffs` waiting for a `setUp` that could not
come. Only TIMED buffs are promoted: a permanent one is already in the sheet
and needs no cast to be true, which is what `passive` is for.

Priced in isolation on one fixed build, Berserk is +4.7% (613.4 against 585.9)
and Battle Shout +4.8%, both consistent with ~22% uptime of what they declare.
The free Warrior optimum moves much further, 488.6 -> 617.5, because two dead
bar slots becoming real cooldowns changes which KIT wins and not just what the
old one scores. The Priest moves 296.3 -> 316.5 on Blessing of Fervor alone -
the audit's own worked example of a buff at 13% uptime, never once cast.

Four smaller reads came out of the same thread, all of them about a rune's
vars:

  * A RUNE'S VARS OVERRIDE THE ROW'S. `applyVars` runs per slotted mastery on
    top of the row, so `amountOf` had the precedence backwards. Six rows across
    four classes declare a key their rune replaces. Execution is the visible
    one: the row says +50% below 20%, the rune says the tooltip's +25% below
    35%, and a var read ONLY inside a clause gated on the rune that overrides
    it has no observable base value at all. Score-neutral - those clauses are
    refused anyway - but the reported magnitude was wrong, and the refusal text
    resolved its vars bare too. Both fixed.

  * `extendStatusDuration` is a channel. Three rows call it, one per class, and
    Battle Fury's whole body is one of them: 0.25s onto Battle Shout per crit
    dealt. While the buff is up it loses a second a second and gains `e`, so it
    lasts D/(1-e) - a closed form, the same shape as the renewal uptimes beside
    it, and a floor, because the rate is the display swing cadence and a
    multi-hit cast raises the hook too.

  * The fight was reading a buff's duration off the ROTATION ENTRY's copy,
    which is a different object from the one in `timedBuffs` - the two are
    built under different `statusesOf` keys. A duration computed correctly
    reached nothing. Found by forcing 120 seconds and watching the dps not move
    by a single digit. The override is confined to buffs that were actually
    extended; preferring the resolved list wholesale moved all four baselines.

  * A REFUSAL WHOSE REASON IS FALSE IS A BUG, again. The gap list resolved
    `runeDamage` without the runes, so a rune-gated rider it was applying was
    reported as not scored - Concentrated Impact's +40% at one target, printed
    as read in the rune table and as refused two blocks below.

Also recorded, unresolved: the Warrior baseline read 479.7 three times earlier
today and 488.6 afterwards, same command, same cdb and boot hashes, with `src/`
untouched between the two commits. Not uncommitted work (stashed, still 488.6),
not the CLI (the parent's own bin/bench.mjs gives 488.6), not nondeterminism
(three identical runs), not a data patch, and not CPU contention - the leading
hypothesis, and it is wrong. Until it is explained no baseline in ROADMAP.md
should be trusted to a tenth.

832 green. Baselines 617.5 / 351.8 / 238.3 / 316.5.

## 2026-08-03 - The butterfly net was never good; the axes were priced too cheap

A statless net ranked beside real steel in the old sweep, and the player
asked the right question. On today's code the order restores itself at
every tier - fixed gear, full optimization, and the sheet shows why it
ever inverted: when Rampage cost one cast per fight and the riders were
refused, a greataxe's entire skill package priced at fifteen points, and
against a margin that thin the net rode restart noise into the rankings.
The fixes that landed this week repriced the axes; the net returns to
catching butterflies. One regression test keeps it there, and the sweep
wants a fresh run once the queue empties.

## 2026-08-03 - Write the road to the meter's respect

SimulationCraft earned a decade of trust by regenerating its data every
patch and answering to a million combat logs. This game is a tenth the
size and this repo already holds the sharper instrument: hooks that read
the game's own arithmetic in an afternoon. The plan scales the method
that got the Warrior to one percent - read the data, read the code,
measure live, refuse and name the rest - into a pipeline a patch cannot
break: the update command, the def-bake tripwire, verify-as-a-command,
then Warrior to delivery grade, then every class through the same
now-mechanical recipe, then the surfaces people actually use - imports,
reports, stat weights, and a confidence interval the meter must land
inside.

Manual authorship keeps the two lanes it earns: priority lists and fight
styles. Everything else regenerates itself or says, by name, why not.

## 2026-08-03 - Someone else's build, read back in the game's own names

questlog.gg stores a character-builder link as the game's own ids, so
translating one into pins is a renaming job and not a matching one. Two
tRPC procedures hold a build: characterBuilder.getCharacter carries the
equipment and names a talentBuildId, and talentBuilder.getTalentBuilderBySlug
carries the allocation and the runes, keyed by the AUTHOR's slug - which only
the first call tells you.

Hand any command a link and it is fetched, translated, and run. The derived
flags go in FRONT of the typed ones, so the link supplies the class, the level
and every pin, and anything named on the command line overrides it:

  bench optimize <link> --level 20 --pin trinket=none

Which socket an augment goes in is derived rather than tabulated: intersect
the host's sockets with the types that list the augment, take the single
survivor. No table to keep in sync with the sheet.

Two places the two disagree in form. gradeOverride indexes the rarity ladder
from 1, so its 5 is Legendary and not off the end of a five-entry list. And a
weapon comes across with ^level@rarity*stars spelled out while gear takes the
bare id, because gear neither rolls a rarity nor has an upgrade path.

Four things questlog records do not survive, and all four print before the run
rather than being dropped: the cosmetic slots, per-skill arsenal ranks against
the one global --rank, runes on skills the build offers no slot for, and the
class-skill bar, which questlog does not store at all - so an imported build is
not quite fully pinned.

The rune case is not a gap in the bench. questlog lets a rune be set on any
skill of the class whatever the level, so a level-25 reference build carries
one for Warrior_BurstOfAnger, which unlocks at 30.

This is the first thing in the tool that reaches the network, so the two places
that claimed it never does now say when it does.

The suite also spawns the CLI for the first time - usage renders, a stray
positional is refused. Nothing loaded bin/bench.mjs before, which is how a
stray backtick in the USAGE template broke every invocation twice.

815 green, baselines unmoved at 479.7 / 350.6 / 239.0 / 293.8.

## 2026-08-03 - Armour rides the source; only the jewel box keeps its row

The gear rule from yesterday pinned too much. Its evidence was all
jewellery - a necklace baked at its authored twenty, rings at their
authored twenty-five - and the rule it justified swallowed the wardrobe
whole, crushing three worn armour slots authored at level one down to
iLevel eleven on a build the player measures at seven hundred.

The split the data actually supports: weapons and worn armour are
generated - the source's level, authored as a floor, exactly what the
loot entry's UseItemLevel minimum says - while GearNeck, GearFinger and
GearTrinket keep the level written on their rows. Every live bake lands
on its integer under this split: the Z2 necklace at 21, the Rare
greatsword at 26, the Epic greataxe at 28 before stars, the demon set
restored to 26.

The reference build climbs 561.6 to 627.1 against a meter reading 703,
and what remains is the queue: the Rampage cadence, the Anger bank, and
the residual family, each already priced.

## 2026-08-03 - The build was never two builds; the meter and the URL agree

The player rules on the provenance question: the questlog reference is
the very loadout the meter measured, and the photographed tooltips were
an older wardrobe. So the maxed weapons are real, the level-one helmets
are worn in earnest, and the armor floor stops being hygiene and starts
being the difference. What separates 561.6 from 703 is nothing new under
the sun: the Rampage cadence, the Anger bank, three starved armor slots,
and the residual family - every one already queued with its number.

## 2026-08-03 - The pendant keeps its row; the helmet does not

The questlog import put the fix from yesterday on trial and found the
half that was wrong: three armor rows authored at level one now price at
next to nothing, while the same families sit on the player at
twenty-five with real armor on every line. Jewelry is fixed at its
authored level - the bakes proved that. Armor authors a minimum and
rides the source, like the loot entries' own UseItemLevel says. Split
the rule: fixed for the jewel box, floored-and-scaling for everything
worn. One Horns of Nightking tooltip confirms it.

## 2026-08-03 - Two pins the optimizer honoured and nobody could reach

`optimize` has read `spec.pinnedTalents` and `spec.pinnedRunes` since they were
written. Nothing ever set them: the CLI had no flag, and `REPEATABLE` did not
carry the names either, so even a hand-added flag would have been swallowed.
Gear, sockets and skill pools could be pinned; the tree and the runes could not.

`--rune <skill>=<rune>`, repeatable, and PER SLOT. The search asked
`if (!pinnedRunes.size)` before touching any rune at all, so pinning one froze
every other slot in the build - which is not what a pin means anywhere else
here. Pinning a chest does not stop the boots being searched. Now it filters the
pool list instead, and =none forces a slot empty.

`--talent <node>=<rank>`, repeatable. Naming any node fixes the WHOLE
allocation, and the help says so rather than leaving it to be discovered: the
tree has tier thresholds, so a half-pinned allocation is not a constraint the
greedy can satisfy without re-deciding which branches are reachable. Every
allocation is checked against the real rules before it is used, so `--talent
Warrior_Talent_Sever=9` is refused by name.

One reporting hole came with it: `allocateTalents` returns null when the tree is
pinned - it did not choose anything - and the printer read that as "there is no
tree to show", so pinning an allocation hid it. A pinned allocation now builds
its own descriptor and prints.

Four baselines unmoved: nothing here changes an unpinned search. Suite 791.

## 2026-08-03 - A mage priced at half power, and the ledger that would feed him

The first non-Warrior run prints 239 and the number is honest about its
own cause: the roadmap already names every missing Spark income - the
time regen, the talent family, the free casts - so the sim funds a
hundred-odd skill casts where the live class chains them, and daggers
fill the silence. One new lead: Infusion is refused for declaring
nothing, and a class skill named Infusion that declares nothing has
almost certainly been feeding Spark from a script all along.

The shortcut is already deployed: the probe stamps spark on every press
row, so one two-minute Mage session on the dummy reads the entire income
ledger live - the same single capture that closed the Warrior's Rage
books.

## 2026-08-03 - Only a weapon is rolled; the pendant keeps its own row

The optimizer was recommending items the world cannot drop. A level-6
Uncommon necklace offered as Rare at iLevel 260 is about four times its legal
stats, and a level-15 ring was priced the same way.

Two defaults conspired, and both are half-right: the drop-scale lifted every
authored-level row to character level, and the rarity roll promoted every
slot. The game does both for WEAPON-type only - everything under
MainhandWeapon or OffhandWeapon in the itemType tree - while everything under
Gear keeps the level and rarity written on its own row.

The live bakes had already ruled and nobody had asked them.
Necklace_Z2RCraft logged iLevel 210 on a LEVEL-25 character, which is its
authored 20 exactly; the Z3 craft rings logged 160 for an authored 15; and
GA_Craft logged 320 against an authored level of 4. Fixed-level gear does not
scale, and weapons plainly do. All three are now assertions.

`--drops scaled` means "a weapon generates at your level" and says so - the
help text had been claiming a default of `authored` since the engine flipped
it to scaled. `bestRarityFor` hands a pinned gear item its own rarity back
instead of promoting it.

Re-ranked, and it moves things: Warrior 495.7 -> 479.7, Rogue 354.5 -> 350.6,
Mage 241.4 -> 239.0, Priest 298.4 -> 293.8. The Warrior's neck went from a
promoted Rare at 260 to an Uncommon at its own 150. Anything ranked under the
old defaults is worth re-running, the layouts sweep included.

The audit entry that carried this as an untested hypothesis is now verified,
and keeps the half that is still true: a weapon's DAMAGE line follows its
trained level, not its drop.

Suite 788.

## 2026-08-03 - A pendant the world cannot drop, priced as if it did

The player caught the optimizer wearing fiction: a level-6 Uncommon
necklace offered as Rare at item level 260. Two defaults conspired -
dropsScale flipped true in the engine while the help text still says
authored, lifting every fixed-level row to character level; and the
rarity roll applied to every slot when the bytecode rolls rarity for
weapons alone. The live bakes had already ruled: the Z2 necklace logged
210 on a level-25 character, authored exactly, while the greataxe scaled
to 320. Weapons ride the source's level; jewelry keeps its own.

Scale weapons only, roll weapons only, and re-rank what the old defaults
priced - some slots were credited four times their legal stats.

## 2026-08-03 - Write down the four things the meter's ladder bought

The code landed across cc53235, 2bfdc6a and 44db73a; the documentation did
not follow it, which is the one rule this repo has about docs.

MODEL.md gains the five readings behind those commits. A pull starts cold -
zero extra resources unless stated, and why that matters most on a counter
that survives the pull. A stack counter has a rate, with the shape that
matches exactly once in the sheet and the reason it is priced post-hoc rather
than handed to the rotation search. The chain reports per link, and why an
aggregate row is the wrong shape for reconciling against a meter. A refusal
inside an accounted skill is still a refusal, with the three things that are
dead rather than gaps. And a refusal names who loses out.

ROADMAP.md carries the meter's ladder as its own section: two thirds of the
705-vs-436 gap is the target the live fights never faced, a comparison
artefact rather than a defect, and a table of the four fixes it did expose
against the commits that closed them. State line to 780 checks.

README.md was showing an output shape that no longer exists - a METRIC block
with one dps line, and a sigil described as unscoreable that the model has
since learned to read. Replaced with the real DAMAGE block off the same
command, plus what makes that column trustworthy: it adds up, the chain is
per link, and HITS counts damage EVENTS so a meter and the model reconcile
row by row.

## 2026-08-03 - A pull starts cold, and the counter was never unreadable

The convention first, because it decides the number: any measured pull assumes
ZERO extra resources unless it says otherwise - no food, no banked aura stacks,
no enchant buff still running from the last fight, no skill pressed before the
combat window. It is in the audit now. It matters most where a counter carries
ACROSS combats, because there the flattering reading and the honest one differ
by a factor of two.

Then Anger Release. "Nothing in the data says how many hits arm it" was false:
GS_Nova_Passive banks one stack per non-DoT physical damage EVENT and converts
at maxStacks - 150 authored, 100 from rank 2 - so the rate is events/100. What
was missing was a fight that counted its own events, and it counts them now.
A sweep of every script in the sheet matches this shape exactly once.

Priced POST-HOC, deliberately. The rate needs the run's own event count, and
injecting it as a pressable instead was measured to send the rotation search to
WORSE plans - 436 to 413/423 - which is the same local-optimum failure the
talent search shows. An analytic line gives the search nothing to reorder
around. Its damage still joins the headline, or the repartition would stop
closing on it.

`floor` is what makes the cold start honest: 99 stacks at the bell are 99
stacks nobody spent, the same convention the pool dots' un-ticked tail already
follows. On a bare GS pin that is 3 fires from 398 physical hits, one every
66.7s against the analysis's 69s, and dps 183.2 -> 188.3.

Two more stale refusals gone with it - the parent-link branch and
noteUnmodelled both claimed the rate was unreadable. GS build unscored 3 -> 1.

Four baselines unmoved: no current optimum holds GS_Nova. Suite 780.

## 2026-08-03 - Two refusals that were true and unhelpful

FIX (2), the silent one. The unscored list is per-SKILL, so a clause refused
inside a skill the model DOES score landed nowhere: the damage was right, one
line of the script was worth zero, and nothing said so. Mania is the case -
the greatsword finisher is scored every cycle, and its rank-3
reduceWeaponsCooldown(1.5) is gated on hasStatusMaxStacked, correctly refused,
and previously invisible. Live weapon cooldowns run faster than modelled
because of it, and that is now a sentence rather than a shrug.

`scriptGapsOf` walks the same regexes and reports what scopeOf turned down,
with the guard text so a reader can see why. It names, it does not price.

Two things it must NOT report, because dead is not a gap: a clause behind a
rune the build did not slot, and one behind a rank the weapon has not reached.
Both contribute nothing in game either, and listing them would bury the real
one. Mania's own rider vanishes from the list at rank 1, which is the check.
It also skips anything runeDamage already reads, or Domination would be filed
as dropped while it is being applied.

FIX (3), the misdirected one. Rampage's entry read "its script resets
Shockwave's cooldown from a onKill hook", filed under Rampage - which reads as
"Rampage is not scored". Rampage is scored, every cast. What is missing is a
cooldown SHOCKWAVE never gets back, and a reader asking why Rampage looked low
was being pointed at the wrong skill. The sentence now says the host is fine,
names the beneficiary, and says what the shortfall does. Also "a onKill" -> "an
onKill".

Four baselines unmoved - nothing here changes a number, only what the tool says
about them. Suite 771.

## 2026-08-03 - The chain was hiding a name the meter could see

A damage meter listed Mania among its top rows and the model appeared not to
have it at all. It had it the whole time: GS_Nova_Combo is the greatsword
chain's FOURTH LINK, scored every cycle, and invisible because the throughput
emitted one aggregate `(base attack chain)` row for the lot. A reconciliation
against a meter is a per-ROW exercise, and this was the row it could not find.

One line per link now. Each carries its own recurrence rather than the cycle's,
because the links do not fire equally often - a chain broken partway pays link
1 more than link 4, which is the entire reason a finisher is worth naming
separately. On a bare GS pin: 3.92s, 4.65s, 4.88s, 5.41s down the chain, 51
hits to 37.

Nothing about the totals moves. The lines still sum exactly to dps x fight and
the per-link clock shares still sum exactly to fillerShare, both asserted.

The disambiguation added with HITS earns its keep immediately: Brutal Frenzy is
GA_Craft's combo finisher AND a separate proc, and now prints as two rows that
say which is which.

Four baselines unmoved. Suite 762.

## 2026-08-03 - Most of the distance was armour the target never wore

The meter's 705 against the model's 436, laddered rung by rung and closed
to 0.4 dps: 173 points of Ratsar mitigation the live fights never faced,
64 of Rampage woven at live prices, 35 of a refused ultimate half-funded
by stacks that walk in from earlier combats, small change from Raging
Smash and the rows below the meter's cut, and the chain paying 25 back
for the clock it lent. Mania was never missing - it was the chain's own
fourth link, nameless under the aggregate row. Fixes owed: read the
stack counter that arms Anger Release, report riders on accounted
skills, print the chain per link, and name the beneficiary when a
refusal gates someone else's cooldown.

## 2026-08-03 - Bring the handoff current, and close an item that was never open

The roadmap's live work list described a world several commits old: items 2
through 5 had all landed and it still said "to adopt", "unverified", "open".
Rewritten against what is actually in the tree, with the commit that closed
each, plus the state line - 754 checks, the four current baselines, the new
unscored counts - and a section saying what IS open.

Then the next item on it, which turns out not to be an item.

GROUND-TRUTH lists "slow projectiles need a launch-time snapshot" under things
owed to the model, measured: GA_Craft_Skill1 fits +-0.2% against the attacker
state at press and +-4.6% against the state when its damage lands. The model
already prices at press - `runFight` calls `hit(prof, now)` BEFORE `tickTo(end)`
advances the clock, and `setUp` runs after - so the measurement confirms it
rather than indicting it, and the reading it rules out is the one the model
never did.

Two corrections to that entry while checking it. GA_Craft_Skill1 carries no
projectile anywhere in its row - its steps are Cast, Visuals, Dash, Area - so
the 3.2-3.3s is its CHARGE HOLD, not flight time.

The invariant now has an observable test rather than a code-ordering argument:
a skill that buffs itself must not price its own cast under that buff.
GA_Craft_FinalCombo deals damage and puts +4 PhysicalMastery on itself, and
+4 PhysicalMastery demonstrably raises that same cast if it is up - so the
unbuffed reading is the check.

Suite 756, four baselines unmoved.

## 2026-08-03 - Count the hits, and count them the way a meter would

HITS is damage EVENTS, not casts. A dot's tick is one, a multi-hit skill
lands several per cast, and a cleave one per target - which is what a damage
meter counts and what the instrumented capture logs a row for, so it is the
column that makes the two comparable line by line.

`critRoll.hits` looked like the answer and is not: it counts only CRITTABLE
hits, so a status tick contributes nothing to it and every dot would have read
zero. The count is taken where `targets` is already known, in castOutput's
damage branch, and rides the result as `out.hits`.

Checks the arithmetic invites, all of which hold: Hemorrhage ticks 100 times
in a 200s fight on its 2s grid; the base chain's 146 is 36.4 cycles of four
links, and 33,383 / 146 = 228.6 against a 917.1 four-link cycle; Rampage's 18
is its 18 casts at one hit each. GS_Nova_Skill1 reports 13 for a declared 12
plus a second effect's 1. And Shield_Firebreath's 3-hit status reports 0,
which is right - it is ignoreMainTarget, so at a single target it hits nobody.

Four baselines unmoved. Suite 754.

## 2026-08-03 - Lead with the damage, and put the explaining behind --verbose

`optimize` printed the build, then a rotation table, then thirty-seven
assumptions. The thing a reader wants - how much damage, and from what - was
neither first nor complete. 380 lines down to 128.

The new DAMAGE block is overall dps and overall damage, then one row per
ability in decreasing damage with its own dps, damage and share.

Making that column ADD UP was the work. `perCast x fight/interval` is not the
per-ability total: for the chain, `interval` is the cycle time while the chain
only runs for its share of the clock, so reconstructing it that way reads 30%
over - measured 39,630 against a reported 30,537. A reader adding the old
table up was right to find it did not close. Every line now carries a real
`total` from the sim, which already had it, and the column closes exactly on
all four classes.

A pool feed belongs IN the sum. It is not a subset of the lines above it - it
is a share of their crits, paid out again on its own schedule - and the
shortfall without it is exactly its size. The audit's "not a subtotal" meant
not a SUBSET; it was read as "do not add this".

Behind --verbose: the search trace, the rotation's reasoning, the per-skill
refusal causes, the talent coverage note, the seed comparison, and the
assumptions list. The unscored COUNT still always prints - a build with things
the model cannot price is something a reader has to know - and says how to see
the rest.

Two more false labels while here, both the same shape as 0062c22: the sigil
socket and the talent row each said Surge of Violence is "nothing this model
can read", because `readableValue` looks for an affix, an effect or a status
and a mechanic is none of those. Both now name it.

A skill and the dot it leaves behind share a name, so the kind is appended
where it would otherwise print twice - Bonethrow (active) and Bonethrow (over
time).

Four baselines unmoved. Suite 752.

## 2026-08-03 - The coverage list was refusing two things the model scores

A refusal whose reason is false is a bug, and the two newest channels each
made one. GA_Craft_Passive sat under "everything it does lives in its hscript
body" while its +25% rider was being read off that very body and applied to
every cast in the stun window. The same sentence sat on
Warrior_Talent_SurgeOfViolence after its register started making Rage Strike
free and certain.

Both were true when written and neither was updated when the channel that
scored them landed - which is the failure mode the roadmap already names, and
the coverage list is precisely the thing a player checks the tool against.

noteUnmodelled now returns early for a skill carrying a script rider, and for
either half of an empowerment pair. The pair needs its own index: asking
`empowermentsOf` about the applier alone finds nothing, because the shape is
only visible when the consumer is in scope too - so the participating ids are
computed once over the whole sheet and cached per (rank, runes).

Warrior's unscored list 5 -> 3. The other three classes are unchanged, as are
all four baselines: nothing about what is SCORED moved, only what the report
claims about it. Suite 742.

## 2026-08-03 - Cooldown earned off an event, from any source but a bleed

Eight rows call reduceWeaponsCooldown and one was credited. Three of the seven
refusals were about punctuation and one about the engine; none was about the
mechanic.

scopeOf would not answer `rank >= N`, which is a question about the BUILD and
not about live state - answered now, and only for a plain conjunction, since
inside a disjunction the clause belongs to one alternative. KNOWN_PRED matched
`\w+\.`, so `hit.skill?.isBaseAttack()` was refused on a question mark.
CD_PROC demanded a bare one-argument call, so `reduceWeaponsCooldown(vars.time,
owner)` was refused on a comma - the second argument is whose cooldowns, and on
a self-applied status that is you.

And once read, none of it scored: the engine credited only the bleed scope and
everything else fell to unreadMods. The rate belongs to the SOURCE skill, not
to the scope - the scope says who benefits, the source says how often it fires.
Red Tempo is a talent on bleed ticks; Sword_Start_Combo is onFirstHit on the
finisher, so its rate is the chain's finisher rate. That cadence is an estimate
and says so: the fight derives the real one by playing it, and this has to be
known before the fight to set the cooldowns it will play with.

Four of eight read and credit. Sword_Start_Skill1 has a 10s cooldown and its
own combo hands back 0.5s a finisher at rank 3 - measured 10.0s -> 8.0s, and
10.0s exactly at rank 2. The two still refused are right to be: GS_Nova_Combo
needs hasStatusMaxStacked, Thrown_Seeds_Skill1 a status on the target.

Two things deliberately left out, both recorded in MODEL.md. Reading
`dmg.skillId == Skill.X` as a status scope is correct and drops the Priest
298.4 -> 293.2 - the search finds a worse build once the node is visible to
it, which is a search bug to understand before the read ships. And offering
rotation skills to talentModifiers without filtering the field credits a
skill's dmgMult riders twice, once per-skill and once at scope 'all' across the
build, which read the Warrior 31% high; only cooldownPerTick comes through.

Four baselines unmoved - no optimum holds one of these four. Suite 737.

## 2026-08-02 - The press rows already knew, and nobody asked them

The refutation in d6e88e4 stood on the bytecode alone. It did not need to.
This capture's press rows carry a Rage column, and four back-to-back Rage
Strike pairs inside one 0.4s cast settle it directly:

  35.153 -> 35.552  rage 14 -> 15   rage went UP; press 1 was free
  46.219 -> 46.636  rage 20 -> 10   press 1 paid, not armed
  87.657 -> 88.087  rage 20 -> 20   at the cap and unmoved; press 1 free
  88.087 -> 88.517  rage 20 -> 10   press 2 paid

Never two free casts in a row. The 87.657 triple is the whole argument in
three rows: free, then full price, 430ms apart.

Recorded with a method note, because the error is more useful than the fix.
The claim was inherited from VERDICT-V2 and then "verified" by hunting a
mechanism that would explain it - which found one and stopped. A read that
can only confirm is not a read. Asking what the claim PREDICTED killed it in
one line; eight rows of a CSV already on disk settled it; the bytecode came
third and cost the most.

## 2026-08-02 - A press cannot outrun its own stop

The register's two hooks do run at two moments - cost at press, forced crit
at damage eval - and I read that as a gap a second press could slip through:
free again, but no longer critical. The player asked what that implies and
the implication is absurd. Two free casts off one 25% proc.

It is absurd because it does not happen. `GameObject.doUseSkill@4576` op 2
calls `stopActiveSkill@4580` as its FIRST action, and that is
`BaseSkill.stop@6093` on the running skill, which runs `onStop` and removes
the status before the new cast evaluates anything at all. Queueing does not
help either: a queued press resolves when the current cast ENDS, which is the
same removal.

So one arm buys one free critical cast and the next press pays full. Spamming
Raging Smash at full Rage under Surge is: free and critical, then 10, then 10.

The model already did the right thing - the register was written one-shot,
cleared on every cast of the named skill - so nothing changes but the
sentences that justified it, in sim.mjs, MODEL.md and GROUND-TRUTH.md, where
the claim is now marked refuted with the op that refutes it. The test pins
one-shot behaviour rather than leaving it to prose.

Suite 729.

## 2026-08-02 - The register that makes the next cast free, and certain

Surge of Violence: 25% per combo finisher that the next Rage Strike costs no
Rage and cannot fail to critically strike. It needs no talent point -
DemonSigil_War_SurgeOfViolence hands the node over from a Head socket, which
is why the reader is fed by runableSkillIds, the one gatherer that walks
augments.

Recognised by a triple - forced crit in onInflictDamageEval, zero cost in
evalCost, removeStatus in onStop - plus an applier doing addStatus behind
isFinalAttack() and checkProba(vars.chance). A sweep of all 962 scripts in
the sheet matches exactly one row with it, so this is a named mechanic and
not a class, and the reader says so by finding nothing else.

Carried as the PROBABILITY the register is armed, which is the convention
crit already uses and whose binomial mean is the deterministic number. A
finisher does p += (1-p) x chance, because a proc that lands while it is
already armed is wasted and cannot stack. Spending costs cost x (1-p) and
lifts the cast to (1-p) x rolled + p x forced, where forced is the existing
`fixed + base x (1 + p(cd-1))` decomposition at p = 1 - no second pricing
needed. The pool feed follows the same die, so a forced crit feeds Hemorrhage.

Both halves are real. On a bare axe build the sigil raises Rage Strike 11%
per cast AND shortens its interval 4.65s -> 3.33s, because a free cast waits
on no Rage income.

Named rather than approximated: the cost check runs at PRESS and the
forced-crit check at DAMAGE EVAL, with onStop removing the status in between,
and startSkill@6034 builds a fresh Skill per press - so the removal is driven
by the FIRST cast's lifetime and a second cast queued before it stops gets the
free cast without the crit. This fight casts sequentially and never queues.

Warrior 482.1 -> 495.7; the other three hold, none of them having the node.
Suite 727.

## 2026-08-02 - Three riders the reader could always have read

The capture proved all three fire and shipping without them cost -13.7% to
-17.5% on the skills that carry one. Each was refused differently.

The combo's +20% against a bleeding target had a guard `scopeOf` already
accepted - but the only reader of it was scoped to talent nodes, so a rider
on a weapon skill was never offered to it at all. A structural refusal with
no sentence attached.

Bonethrow's rank-3 +20% crit damage and Domination's +25% both died on the
predicate strip, which refuses anything it cannot name and had no name for
`rank`. A rank comparison is a question about the BUILD, not about live
state, and is now answered rather than refused.

`runeDamage` is where they go, because it was already this: a skill's own
script, read for a `dmgMult` its slotted rune unlocks. It now also reads
`critDmgMult`, answers a rank clause, and tags a target-state guard for the
fight. Everything else still refuses.

Two traps. Domination reads Stun||Root||Slow||(rank>=3 && isCCImmune()),
where the rank clause belongs to ONE alternative - vetoing the rider on it
silenced a +25% that fires on the stun path at any rank, so the rank test
applies only to a plain conjunction. And its amount is 0.15 in the row and
0.25 from rank 2 through props.rankOverride, which is why 321c090 had to land
first.

The gates are the build's own, not constants. `bleeding` is 1 when the build
applies a Bleed-typed dot and 0 otherwise - the whole-credit policy the scoped
talent modifiers already use, and the capture had a bleed up at 17 of 17
steady finishers. `cc` is the union of every stun the kit applies, each at
duration/cooldown, 1 - PROD(1 - u); durations come off the applying steps,
cooldowns off the skills. A kit with neither prices both at zero.

flaggedCC now carries the status lifetime. Nothing consumed it before, so it
was dropped - and it is the whole of Domination's value.

Warrior 467.9 -> 482.1. Rogue, Mage and Priest do not move: none of their
optima holds a skill carrying one of these. Suite 721.

## 2026-08-02 - One clock, and the banked chain that was never there

`Hero.update@7495` / `isWithinAttackCombo@7459` keep ONE timestamp - the end
of the last completed basic - and never refresh it when a skill ends. So
casts, idle and RUNS of short casts all break the chain by the same measure.

The fight asked two questions instead: is THIS cast longer than the window,
and did I stand still longer than it. Neither sees a run of short casts, and
two 0.4s Rage Strikes back to back break the chain in game.

The v2 capture settles it 52/52 on the one-clock rule. Literal start-to-start
scores 18/52 - every advancing start-to-start is 681-1292ms, which the
phrasing forbids. A BANKED finisher scores 50/52 and both its misses are
mid-chain links surviving casts, 415ms through a Rage Strike and 527ms through
a Surging Force, which banking cannot produce. So the banked-chain concept is
retired rather than implemented, and v1's decisive t=47.6->55.0s sequence turns
out to be 597ms end-to-start, inside the window by 3ms: per-link damage-landing
offsets of 320-472ms after cast start are what manufactured a bank out of
damage timestamps.

The anchor is the double-Rage-Strike reset: a basic pressed 13ms after the
second one ENDED still reset, because 854ms had passed since the last BASIC
ended. Measured bracket [597, 854)ms contains the authored 600.

The lookahead runs the same rule now. It assumed any cast reset the chain,
which made a setup cast look free.

Warrior 471.8 -> 467.9, Rogue 355.3 -> 354.5, Mage 240.4 -> 241.4, Priest
298.4 unmoved. Suite 713.

## 2026-08-02 - One bracket for the riders, and three stars in the ledger

TWO FIXES, both from the v2 capture.

Damage riders sum. `computeDamage@4841` op 8 runs the hooks, op 14 seeds
modMult from hitData.dmgMult - one scalar starting at 1 that every rider only
ever `+=`s - and op 165 applies it once. The model multiplied a line at a
time: runeDamage, then damageByAffinity, then the basic-attack proc. Two +20%
riders read x1.44 where the game gives x1.40.

Decided three ways: the one deterministic double-rider hit, Rage Strike 352
under Berserk and Domination, fits 1+0.20+0.25 = 1.45 to -0.23% where
1.20x1.25 misses by +3.2%; a 42-hit least-squares prefers additive at rms
0.26% over 0.66%; and Berserk-into-the-fervor-bracket is excluded by the GA
ratio window. Shape: B x (1+F+M) x (1+SUM dmgMult) x critDamage^crit.

A scripted dmgMult is not a sheet stat either. skills.mjs turns an
unconditional `hit.dmgMult += vars.n` into a TAttribute_Flat DamageModifier
row so the buff, its uptime and its place in the fight come for free - but
DamageModifier MULTIPLIES. Those rows now divert into the additive channel at
the same uptime. critDmgMult rows are left alone: ctx.critDmgMult really does
start at atbVal(CritDamage). Caveat named: at DamageModifier = 100, (D+S) and
Dx(1+S) are indistinguishable, and only a permanent non-100 source separates
them.

And the upgrade ladder reads at stars-1. The iLevel is unambiguous about the
stars - 320 is 250 + Epic 30 + 4x10 - while the four-star weapon's own tooltip
says "Critical Chance increased by 3%" and the sheet closes at 17.3 with 3.
The two count different things. A one-star weapon carries no rider. Whether
the rule is plain stars-1 or stars capped at the rarity maximum minus one is
open; every Epic case agrees and one hover of the Rare 3-star axe decides it.

The reconstructed v2 sheet now reads 17.27 resting against a photographed
17.3. Warrior 468.8 -> 471.8, Rogue 358.1 -> 355.3, Mage 241.0 -> 240.4,
Priest 300.2 -> 298.4. Suite 707.

## 2026-08-02 - Four stars on the hilt, three in the ledger

The agent shipped a residual rather than tune around it: the data's
GreatAxe_Upgrade ladder says +4 at four stars, the player's sheet
arithmetic wanted +3. The screenshot rules: Judgement prints "Critical
Chance increased by 3%" on the very item whose bake row proves four
upgrades in the iLevel. The rider row and the iLevel do not count the
same thing, and the sheet's 17.3 corroborates the smaller number.

One point cannot name the rule - stars minus one, or a cap one short of
the rarity's maximum. The Rare three-star axe in the player's bag prints
the deciding digit whenever it is next hovered.

## 2026-08-02 - The arsenal's upgrade effect was never the arsenal's to keep

The harvest read Slot_Weapon1 and Slot_OffhandWeapon on the reasoning that
the arsenal grants two chosen skills and its discounted stats, and an upgrade
effect is neither. The player's Character Profile refutes it. On a build whose
only CritChance sources are the naked base, the ratings and Judgement's
upgrade line, the sheet reads 17.3% where base plus ratings give 14.26% -
and nothing else in that loadout grants a point of crit.

It arrives whole. The slot's 0.4 discounts stat lines; an upgrade row is a
skill affix and ceil(4 x 0.4) = 2 is not what the sheet shows.

Named residual, shipped rather than tuned around: GreatAxe_Upgrade is
+1/+2/+3/+4/+5 by star and the weapon is four stars - iLevel 320 is
250 + Epic 30 + 4x10, so the star count is not in doubt - which makes the
data say +4 where the sheet wants +3. One screenshot of Judgement's upgrade
line says whether the rank that row sees is the star count. The model reads
18.27 resting against a photographed 17.3, where it read 14.26 before.

Reading a printed sheet against the game's needs one subtraction: a
proc-applied buff with no cooldown behind it is folded in at its cap, because
that is where it sits in sustained combat, and the Character Profile shows you
standing still. Here that is the Raclette Pan's +5.

Warrior 445.3 -> 468.8, Mage 238.7 -> 241.0, Priest 296.3 -> 300.2, Rogue
unmoved. Suite 703.

## 2026-08-02 - Diff the bake against the game's own return value, and close it

captures/2026-08-02-v2 postfixes $HItem.generateItemAffixes@20747 and logs
what it hands back: 632 item/rarity/iLevel signatures, 2,115 affix lines.
That is not a tooltip. Diffing against it started at 1,299 exact and ends at
all of them, on three rules.

ONE ROUND PER TARGET ATTRIBUTE. Two aptitudes both paying MaxHealth are two
rows on one line, and rounding each before the sum loses up to a point per
row - 87 signatures came out +-1..2. The rows accumulate as floats now and
the LINE rounds, before the slot factor ceils it.

UNCOMMON DROPS A GROUP, and which one depends on the aptitude count: single
pays no primary, multi pays no vitality. Nothing authored says so - the
`rarities` overrides stop at Common, which zeroes both - so it is measured,
on 287 Uncommon keys. Without it every Uncommon row read 2-5 points high.

A GENERIC APTITUDE IS NOT A CHOICE. The five nameless jewellery rows paid
exactly one, enumerated as a candidate per generic. The measurement that
rested on was right and the inference was not: "Pendant of Adaptability
grants 46 rating, not 184" correctly killed the naive sum and was read as one
row paying 46. The game's bake for that necklace is Vit 4 and 11 on each of
four ratings - 44, which IS the 46 - each a quarter because it names four.

Two confirmations fell out. The live GA bakes 49/38/87 and ceil(v x 0.4)
gives 20/16/35, which is Judgement's arsenal tooltip to the integer, pinning
the bake and the slot factor against one screenshot. And the sheet prints
-40.08% beside Armor 1930, against the mitigation curve's 40.0831%.

tools/bake-diff.mjs keeps the harness. It reads `bake` rows only: an
item_affixes row reports the DEF iLevel while carrying the LIVE affixes, so
mixing them files the axe's 290 numbers under 260. The one line still
differing is Scepter_Start, which carries authored affixes the generator does
not generate and so does not log.

Suite 700, four baselines unmoved.

## 2026-08-02 - The sheet is a sum, and the eleven points were enchants all along

Every equipped tooltip photographed, and the character sheet closes as an
exact linear sum: naked base plus every tooltip line lands Vitality 179,
Strength 144, Dexterity 32, Faith 32, Armor 1930 to the integer, and
MaxHealth is three Vitality on the nose. The missing Strength was never a
multiplier, never the arsenal share - Judgement's own tooltip prints
"Arsenal stats efficiency: 40%" - and never a talent, for the pane shows
fifteen points unspent. It was two Honed Bronze Plates and a Magic
Formula: enchants the inventory dump has no field for, eight points of
the eleven, the rest per-line prediction dust.

Riding along: the necklace generic is the four-rating spread exactly as
owed; sheet crit 17.3% closes the conversion AND proves an arsenal
upgrade rider reaches the wearer; armor is a pure gear sum printed next
to its own mitigation, -40.08% at 1930.

One survivor, sharpened: steady combat crit runs about eight points above
sheet-plus-trinket. The sheet is now innocent twice over; whatever grants
it, it happens in combat.

## 2026-08-02 - The sheet says 144, and the multiplier that never existed dies with it

The player photographed the character profile on the exact v2 loadout:
Vitality 179, Strength 144, Dexterity 32, Faith 32, Intellect 28, offhand
empty. The model computes Strength 135.2 for that loadout, so the +11 the
damage anchors demanded is sitting in the game's own sheet - a sheet-side
bake deficit, not a damage-path multiplier. The damage path is exonerated
end to end.

The five-attribute vector is the discriminator the anomaly was waiting
for: a larger-than-0.4 arsenal share moves Vitality and Strength together
in the GA's aptitude mix; an unread talent node moves one stat alone.
Diff the model's sheet for this loadout against all five and the residual
pattern names the culprit.

## 2026-08-02 - One clock, one bracket, and an anomaly that was never there

The second capture ran with the probe the first one asked for, and four of
the five open items fall. The combo window is a single cumulative clock from
the end of the last basic to the start of the next - casts and idle pooling
in one 0.6s budget, 52/52 casts predicted, bracketed [597, 854)ms - and the
banked finisher is retired as a mechanism: its two misses are mid-chain links
surviving casts, which banking cannot produce, and v1's decisive sequence
re-fires at 597ms end-to-start with 3ms to spare. Do not implement the
banked-chain concept; replace the two tests in sim.mjs with the one clock.

Rage Strike's 9/16 dissolves under directly observed Surge windows: two
forced crits, one inside Battle Shout's +20 window, two natural at 2/7
against a fleet 13/43. The ineligible-crit class is empty, the ledger closes
at cost 10 flat, and M2 is refuted. Berserk is exactly 0.20 and always was -
the 1.183 was the Devote fervor ramp riding across the window boundary - and
dmgMult riders SUM in one bracket that multiplies (1+fervor+mastery):
additive fits 42 hits at rms 0.26% where compounding misses the only
double-rider hit by +3.2%.

The bake is ground truth now: all 18 live instances integer-exact at their
true effective iLevels, 636/636 def keys under the two one-line fixes
catalog.mjs still owes (round once per target; the Uncommon statGroup drop,
now measured on 287 keys). The uniform -6.9% leaves the bake forever, and
what replaces it is sharper: one +11 Strength the capture cannot see lands
all four damage anchors within 0.8% through their elasticities.

What survives, named: the Strength source, a GS-build crit shortfall at
P=0.02, SurgingForce's unmodelled self-window, bracket attachment at
DamageModifier=100, and hero damage quantized to integers before the log.
Verdict and asks: farever-hlx/captures/2026-08-02-v2/VERDICT-V2.md.

## 2026-08-02 - Correct the premise the capture's verdict was resting on

The handoff said "talents = the Hemorrhage root node only", and the player
has retracted it: the equipped head carried a Demon Sigil, and a sigil grants
a talent outright. DemonSigil_War_SurgeOfViolence is the one that matters -
augmentTargets [Head], skills [Warrior_Talent_SurgeOfViolence] - and bench's
own Warrior optimum already slots that exact sigil. The dump lists loose
sigils as items and holds two Mage ones; it has no field for one ALREADY
socketed, so it could never have shown this.

So Surge of Violence was live: 25% per finisher that the next Rage Strike is
free and a guaranteed crit, read three ways at 44626/44627/44624. It does not
settle the 9/16 anyway. The status is one-shot, so only 6 of the 16 steady
casts had a finisher since the previous Rage Strike, and four of the nine
crits land on casts that did not - that subset still crits 4/10. Nor is the
Rage ledger evidence for it: Berserk's RageGainFactor +1 doubles income for
15s, which the sim already models, and the deficit falls from three free
casts to one, or to none with the M2 mastery.

Two items close. Crit conversion was never the conversion. Bleed ticks are a
measurement artefact - ceil(round(0.100 x H)/4) reproduces 0.1023-0.1028 with
no extra multiplier, because the log ceils.

Two change shape. Berserk is authored at exactly 0.20 and must not be retuned;
what is wrong is that the game adds dmgMult riders into one bracket where the
model compounds them across three separate lines. And the ComboWindow item is
now disputed by a read whose own skeptic died before checking it, so it is
marked unverified rather than actioned.

The bake residuals are rebuilt from the capture's inventory dump: CritDamage
+0.24% -> -0.02%, Armor -10.5% -> -4.3%, and what remains is a uniform -6.9%
across three different mixes on two weapons - a multiplier, not a stat.

## 2026-08-02 - A rank override restates vars, not only props

`updateSkillInf@20788` (HSkill.hx:368-373) walks props.rankOverride and, for
every entry whose minRank the rank clears, calls applyProps at ops 54-56 AND
applyVars at ops 57-59. `applyVars@20790` Reflect-sets each named field onto
the accumulated vars, so a later override wins and an unnamed sibling is left
alone. The model merged props and dropped vars on the floor.

98 rows restate vars by rank. Domination is the one that shows the cost:
GA_Craft_Passive is var1 0.15 with `rankOverride [{minRank: 2, vars: {var1:
0.25}}]`, so every read of that rider below rank 2 understates it by 1.67x -
and bench's default rank is weaponSkillMaxRank, where the override is always
in scope.

The resolved vars ride the profile as `prof.vars`, so a reader gets the rank
right by default instead of having to remember. `s.vars` is the unresolved
row and reading it at a rank is now the thing to avoid.

Nothing scores off these vars yet, so all four baselines hold and the suite
is 678. This is the floor for the three refused riders, whose amounts all
come out of exactly this column.

## 2026-08-02 - Harvest a skill's affixes because you own it, not because it is a passive

`BaseSkill.permaAffixes@6081` is false for exactly two natures - Status and
Passive - and `initData@6029` hands every other skill's affix rows to
`owner.addAffix` permanently. The harvest read `rot.passive` alone, which is
the wrong half of that rule: a passive's rows are not permanent by the
game's own test at all, they arrive through `setRunning` and stay because a
passive never stops.

`Axe_Boomerang_Combo` is the row that shows it. Nature Combo, TAttribute_Flat
CritChance +5 at minRank 2, `displayed: false`, and a rankDesc that says "You
permanently gain ::val1%:: [CritChance]" outright. It is owed for WIELDING
the axe - `Weapon.applySkills@8181` builds a skill object for every row of
item.skills - and it was dropped for living in `filler` instead of `passive`.

Six rows in the whole sheet sit outside Status/Passive with an attribute
affix: the three Block abilities, which already arrived through `passive` and
are why this dedupes by id; this combo; DA_Water_Combo's +2 at rank 3; and
one Bee row. The test asserts that census, so a seventh is noticed rather
than absorbed.

Through `applyAffix` rather than the old Flat-only `addFlat`, so a ratio row
in this position is not read as a flat.

On the captured build, crit 24.62 -> 29.62 against a measured 28.8. The four
baselines do not move: the Warrior optimum wields Judgement mainhand and the
axe as arsenal, so that combo is not in its chain. Suite 674.

## 2026-08-02 - Do not throw the aura out with the payload it could not price

Bloodrage Aura declares two things on one row. A heal, played only from
`on: Code` - the script fires it on a physical critical strike at rank 3 -
which has no rate this reader can derive. And an Aura step at Start with
`duration: -1`, putting +5 CritChance on the wielder and every ally in
range for as long as the axe is held.

The reader refused the skill whole and took the aura with it. Five points
of crit, on the one weapon in the game whose passive IS a crit aura.

The buckets were never meant to be exclusive. A refused payload now files
under `unmodelled` AND `passive`, and the refusal sentence says which half
it kept. Two things come through and no more: the skill's own affix rows,
and self-buffs with no positive duration - a timed buff needs the rate
that was just refused to know how often it goes up. Script-gated and
dynVal-scaled statuses never reach `self` at all; `statusesOf` has already
sent those to `unreadable` with a reason of their own.

The rank rows were already resolved correctly - 3 at rank 1, 5 at rank 2
and up, mutually exclusive - so nothing new had to be read to price it.

Warrior 438.2 -> 445.3. The other three do not move, which is the check:
it is an Axe_Boomerang passive and only one optimum holds that axe.
Suite 670.

## 2026-08-02 - Retire the swing floor: the stopwatch was timing interrupted chains

An instrumented capture - 4,916 logged damage events over an 88-second
dummy session - puts 12 uninterrupted Cheese Moon cycles at a median of
1903ms against the model's 2850ms. Ratio 1.498, and individual links land
210-640ms apart, well under the 0.70s floor that was meant to bound them.
The authored durations sum to 1810ms, within 5% of the measured median.

So the authored durations were right all along. The floor came from two
stopwatch readings, and Judgement only agreed with it because its links are
authored at 0.70-0.85 anyway; the fast axe's 0.25-0.55 were written off as
"hit timings, not swing periods" and the difference was papered over rather
than chased. Logged cast events beat a stopwatch, and the direction of the
error also contradicts the model's own note about interleaves stretching
recurrence.

Every throughput number inherited that 1.5x on any weapon whose links swing
faster than 0.7s. Rogue 306.7 -> 358.1 and Mage 223.0 -> 238.7; Warrior
438.2 and Priest 296.3 do not move at all, because their chains are
authored above the old floor - which is itself a check that the change does
what it claims and nothing else.

--swing-floor 0.7 restores the old reading. The residual 5% between 1810ms
authored and 1903ms measured is unexplained and named rather than fitted.

Suite 664 green.

## 2026-08-02 - Land the gear bake, and let three tooltips agree for the first time

Three terms were missing from generateItemAffixes@20747 and they only
reconcile together - each alone makes the other two look wrong, which is
why the first attempt at the gear ratio by itself was reverted two commits
ago.

The level curve runs a SECOND time on GearStatsRatio_Scaling_Bounds
(0.5 -> 0.9) and multiplies every row not flagged gearOnly. Every row is
then divided by the number of aptitudes the ITEM names, so a dual-aptitude
item pays a shared line once at the mean and the second aptitude buys only
its own primary - the model summed them and read double on every
dual-aptitude item in the game. And armour resolves the ITEM's aptitude
mean rather than the wearer's: a Fighter+Cleric belt reads 158 Armor on a
Warrior, which is 0.325, where the Warrior's own 0.4 reads 219.

The level was wrong too. An item's stats follow a drop at YOUR level, not
its authored row level. The Cheese Moon is photographed as "Axe Level 25"
with three upgrade stars - iLevel 290 - and the level 10 the old tests
pinned was never read off a tooltip at all. It was the level at which the
two missing terms happened to cancel, which is the shape of a circular fit,
and it hid a 25% error on every geared character for as long as it stood.

Measured on one level-25 Warrior in four equip states - naked, weapon only,
belt only, both - across three items and twelve integers, all exact:

  GS_Nova Rare 0*        1 aptitude   +25 Str  +32 Vit  +69 Crit
  Waist_RDemon_FigCle    2 aptitudes  +4 Str   +4 Faith  +8 Vit  158 Armor
  Axe_Boomerang Rare 3*  2 aptitudes  +36 Vit  +15 Str  +18 Dex  +39/+39

and the naked control, which contains no item at all, still reads exactly on
all sixteen attributes. On the fully geared character the sheet moved from
Vitality 226 / Armor 1576 to the measured 213 / 1949, MaxHealth to 639 on
the nose, and Dexterity and Faith land exactly once the waist is specified
right.

Four old assertions changed and every one of them was encoding the old
decomposition: two tooltip readings re-pinned from an inferred level 10 to
the measured level 25 at 3 stars, "pays a Priest MORE with both aptitudes"
inverted to "pays a shared line ONCE at the mean", and the armour-reduction
invariant restricted to single-aptitude gear, since a mixed set now lands
between two classes' declared values rather than on either.

Baselines fall accordingly and this is the correction, not a regression:
Warrior 539.5 -> 438.2, Rogue 399.0 -> 306.7, Mage 328.5 -> 223.0,
Priest 385.6 -> 296.3. Suite 664 green.

Still open from the same trace: the Uncommon statGroup rules, which no
measurement here touches.

## 2026-08-02 - Write down what the game itself said, and pin the model against it

An 88-second instrumented dummy session - every damage event logged from
inside the running game by a read-only hook mod - measured the model at
last from the outside. The arithmetic held: the swing band exact at both
ceil edges, the crit multiplier to 0.3%, the Hemorrhage ledger down to
its 0.35 feed fraction and its carry across expiry. The timing did not:
the chain runs half again faster than modelled, a banked finisher
survives casts the model thinks reset it, and steady-state crit sits
seven points above anything the sheet can build - with talents and runes
ruled out by the player's own mouth, the rating conversion is the last
suspect standing.

The three refused script riders all fire in the live game, priced now to
the percent. And the bake dispute of 6ecf7ad has a way out that beats
any tooltip: hook the bake function itself and log what it actually
returns, for every item, at whatever level it truly runs.

docs/GROUND-TRUTH.md carries the anchors, the defects with their
measured targets, and which hooks turned out to observe nothing.

## 2026-08-02 - Sweep the bake's four unknowns, and find the measurements disagree

The four ambiguous choices in generateItemAffixes - group by endAtb or read
per row, apply gearRatio or not, divide by the aptitude count or not - were
implemented switchable and swept against all three measured tooltips at
once. No combination satisfies them all.

Two things the sweep does settle. The aptitude divisor must be OFF: the
bytecode re-adds its per-group amount once per row, which cancels the
divisor exactly, and forcing it on makes every dual-aptitude case three
times worse. And mean-of-group versus per-row is worth at most one point,
so it is not the discriminator either.

What is left will not reconcile. With gearRatio on, GS_Nova is exact and
both dual-aptitude items land on precisely 0.5617x their tooltips - which
is gearRatio(11) to four figures, so the term is being applied and is
simply not wanted there. It cannot be traded against level, because each
item pins its own level through its gearOnly ratings row, which gearRatio
never touches: GS_Nova's Critical of 69 forces level 26, the Spear's 39/39
forces level 11, and at exactly those levels the attributes want x0.675 and
x1.0.

So one of the two measurement families is not what it is assumed to be. The
GS_Nova reading is the stronger: fresh, and corroborated by a naked control,
a full character sheet, the item tooltip and a damage meter that all agree.
The Spear and Cheese Moon readings pin their tooltip integers honestly
enough, but their INSTANCE LEVEL was inferred by the very model now in
question - circular in the same way the geared sheet turned out to be.

One tooltip settles it: any dual-aptitude item at a known level. Until that
exists, nothing lands. Suite 658 green, baselines unchanged.

## 2026-08-02 - gearRatio is real, and landing it alone is worse than not landing it

Four independent derivations of generateItemAffixes@20747 - one reading the
disassembly top-down, one working backwards from the measurement, one on
rounding position, one on the level and ratio terms - all reproduced a
level-25 Rare 0-star GS_Nova's own tooltip to the integer. The function
runs the level curve a SECOND time on GearStatsRatio_Scaling_Bounds
(0.5 -> 0.9) and multiplies every row not flagged gearOnly by the result:
at L 26 that is 0.6749, and 47 x 0.6749 = 32 Vitality, 37 x 0.6749 = 25
Strength, while the Critical line is gearOnly and is therefore already
exactly 69 without it. Three integers, one of them untouched, so it is a
three-point fit rather than one free parameter.

Two errors, and they partly cancel on the attributes while not cancelling
on the rating, which is why the model looked only 9% off. The other is the
level: the model evaluates an item at its AUTHORED row level where the
instance is a drop at the character's. --drops scaled already computes that,
so the default was the mistake and not the code.

I implemented it, and reverted it. gearRatio on its own breaks twelve
measured assertions - the Spear_Eruption and Cheese Moon tooltips - and no
instance level rescues them: at level 10 their ratings are exact and their
attributes 1.8x short, at level 18 the attributes are right and the ratings
1.35x too high. The gearOnly flags are uniform across every aptitude, so it
is not a per-item difference.

What separates the two cases is the APTITUDE COUNT. GS_Nova names one
aptitude; the Spear and Cheese Moon name two. The bytecode groups the
surviving rows by endAtb, means start/end across the group, evaluates once,
divides by aptitudes.length and re-adds that single amount once per row,
where this model sums a separately-rounded budget per aptitude. On a
single-aptitude item those agree and gearRatio is the only difference; on a
dual-aptitude item they differ by a factor gearRatio then compounds. So the
grouping, the mean, the divisor and gearRatio land together against all
three tooltips at once, or each half makes the other look wrong.

Reverted clean: suite 658 green, baselines 539.5 / 399.0 / 328.5 / 385.6.

## 2026-08-02 - Say which weapon each measured sheet was wearing

The naked-plus-weapon reading and the fully-geared reading are not the same
GS_Nova instance. "Martyr of Enripit" is the only GreatSword row in the
game so both are that item, but at different rarity, stars or drop level,
and the geared one is not yet identified.

That matters more than it sounds. The geared Strength appeared to land to
one point - 173 against 174 - but only because the run ASSUMED the weapon
was Legendary 5-star, and that assumption is exactly where a bake error
would hide. Fitting the bake against it would be circular.

So the bake is to be fitted against the two readings that are fully
specified: the naked control, which must stay exact because it contains no
item at all, and the single Rare 0-star weapon whose tooltip states its own
three affix lines. The geared sheet is a confirmation afterwards, and its
attribute rows are usable now only for their SHAPE - Dexterity and Faith
miss identically across every weapon rarity and star count tried, so
neither of those is the weapon.

## 2026-08-02 - Add the control: naked is exact, so every error is the item bake

A completely naked level-25 Warrior matches on all sixteen attributes to
the displayed digit - the attribute curve, the rating-to-percent
conversion, the health pool, the crit derivation, every zero. Put one Rare
0-star weapon on and Strength is +2, Vitality +3, Max Health +9. Put the
full set on and Dexterity is +13, Faith -4, Armor -373, Fervor -2.2pp.

The error scales with the number of items worn and with nothing else, which
isolates it entirely to the item stat bake and retires every other
candidate at once. generateItemAffixes@20747 is already traced and the
model is provably running the other decomposition of it; what the rewrite
lacked was measured integers to land against, and there are now four sheets
to check it with - naked, naked plus one weapon whose tooltip reads
+32 Vitality / +25 Strength / +69 Critical, fully geared, and a damage
meter over the same build.

## 2026-08-02 - Write down three measured sheets, and the hypothesis one of them killed

A level-25 Warrior on a 0-armour dummy, read three ways, plus a damage
meter. These are what the gear-bake rewrite has to land against.

The naked read settles the swing formula and it needs no change. The model
predicts a GS_Base_Attack band of 94-115 and the measured hits are 94-113,
matching the weapon's own written damage line. That matters because a rival
hypothesis - fitted from the geared meter alone, where the arithmetic
implied a flat of 123.4 against budget(25) = 123.6, a 0.2% fit - predicted
174 here. It was wrong by 60% and it was one commit away from landing. The
naked read is what stopped it, and the roadmap now says not to re-open the
question without one.

What the same sheet does expose is the bake, at 5-9% a line: the weapon's
tooltip reads +32 Vitality / +25 Strength and the model reads +35 / +27,
carrying Max Health to 219 against 210.

The geared sheet is worse and points somewhere specific. Strength lands to
one point (173 against 174) and Critical Bonus to a tenth, but Dexterity
reads 45 against 32 and Faith 28 against 32 - and both are IDENTICAL across
four different weapon rarity/star configurations, so neither is the weapon.
The player's Dexterity is 28 naked plus 4 from two augments, which means the
game pays their waist's Assassin half NOTHING while the model pays it +13;
their Faith is 28 plus 4 the model pays nothing for. That is in direct
tension with the audit's verified "an item pays every aptitude it names",
which was measured on a WEAPON and never on armour or jewellery. Armour may
not follow the same rule at all.

And the meter settles two things without any inference: GS Base Attack's max
hit was 604, which no crit on the top of the model's +/-10% band can reach
(~429), so the geared swing really is too small; and Anger Release fired
twice in 75 seconds against a model that scores it zero.

Suite 658 green; no behaviour changed in this commit.

## 2026-08-02 - Yes, it is in the data: read the double-attack upgrade proc

The star effect on a GreatSword is not a mystery and did not need a
tooltip read. GreatSword_Upgrade is vars.chance 0.04 and one hook:

    function onSkillProc(ctx) {
      if (ctx.skill?.isBasicAttack() && checkProba(vars.chance)) {
        ctx.skill.playStep(null, ctx.skill.getExecStep().index, null, null, 0.0);
      }
    }

with the description "Your [BasicAttack]s have a 4% chance to attack
twice". Replaying the executing step IS the hit again, so the entire
payload is x(1 + chance) on basic attacks - and isBasicAttack is skill
types Attack..Attack4, which EXCLUDES the combo finisher, so the rider must
not reach the swing that ends the chain. `isFiller` would have; it covers
the finisher too. Twelve of the twenty <Type>_Upgrade rows are scripts
rather than affixes and were refused wholesale; this is the first of them
read, and none of the twelve carries a cooldown or uses the game's own
internal-cooldown idiom, so the rate is plain Bernoulli with nothing to
saturate.

It also settles a question the other direction. A research pass claimed the
upgrade skill's rank was the weapon's RARITY index; it is the star count.
Staff_Upgrade at minRank 3 is CooldownReduction +4, and a real three-star
Censer tooltip reads "Cooldown Reduction increased by 4%". The model's
existing reading was right and now has a measured tooltip behind it.

Warrior 520.1 -> 539.5 (the default build wields a GreatSword). Rogue
399.0, Mage 328.5, Priest 385.6 unchanged. Suite 658 green.

## 2026-08-02 - Call the functions by their names, not by the labels the session gave them

Nine citations in engine.mjs and damage.mjs pointed at findexes under
names the disassembly session coined - descs, getMainType, makeSkillInf,
fn - or at the wrong findex outright: getStepEffectItemScaling was cited
at 20775, which is getStepEffectVal. The real owners, read back from the
type table: getStepEffectItemScaling@20780, getStepEffectScaling@20778,
convertWeaponPowerScaling@20782, getEffectRange@20779. fn@20784 keeps
its label because it truly is a closure, reachable only through the
static that encloses it.

No formula changed; the numbers were always read from the right code.
Only the trail now names where it walked. Found while building the
findex-to-owner hook map: 37 of 38 cited functions are name-addressable.

## 2026-08-02 - Read the third line of getILevel, and stop quoting a feed as a subtotal

Two reports from play, both right, and both about the tool rather than the
game.

A DEMONIC GIFT RAISES THE GEAR LEVEL. Gear.getILevel@8123 is three lines -
the base plus rarity, then round(upgradeLevel x Item_GearUpgradeILevelBonus)
for the stars, then `for (s in this.slots) lvl += Data.item.byId.get(s)?.iLevel
?? 0`. That third line was the one nothing read. Every socketed item adds its
OWN iLevel to the host, and twelve items in the game do it: the EPIC Corrupted
Gifts declare iLevel 10, so socketing one is worth a whole effective level of
stats on top of the affixes it swaps - every line on the weapon moves,
including the ones the gift does not mention. The RARE gifts declare no iLevel
and neither does any enchant, jewel or sigil, so those add nothing, which is
why the effect reads as "slight". The search already takes the Epic gift
wherever it fits, so all four baselines move: Warrior 512.4 -> 520.1, Rogue
392.3 -> 399.0, Mage 323.5 -> 328.5, Priest 383.2 -> 385.6.

AND THE POOL FEED WAS NOT A SUBTOTAL, WHICH THE LINE DID NOT SAY. "35% of
11697 physical critical damage" sat beside a damage table that does not
contain 11697, and trying to add it up and failing is the correct reaction.
Three things separate those numbers and the line now names all of them: the
feed is the CRIT-ATTRIBUTABLE share of the damage rather than the whole of it,
because a guard that says dmg.critical only ever sees the part that crit; it
is measured BEFORE DamageModifier, because a pool banks base damage and each
tick carries whatever is up when it lands (on record from play - a bleed
ticking at 100 goes to 120 the moment Berserk is pressed, with no new crit);
and what the bell catches un-ticked is dropped, which on a 75-second fight was
1135 of 14509 and went unmentioned.

Suite 658 green.

## 2026-08-02 - Read the gauge, and let the measurement settle what the row could not

A conduit fires when Spark is SPENT while the pool before the spend was
strictly above half of MaxSpark, and every equipped conduit fires at once.
Mage_Conduit_SparkBounds is [0.5, 0.5, 0.5] and the test is `bound < ratio`,
so the Low/Medium/High tiering is inert and conduit damage is a SUM over
the ones you slotted.

The model refused all of them as "no trigger rate can be derived from the
data". It was derivable. It needed the Spark pool simulated rather than a
rate invented, and "one per weapon skill" would have been badly wrong:
in-combat regen is 0.65/s against roughly 5/s of spend, so a full pool buys
a handful of triggers and the gauge then sits under the threshold for the
rest of the fight.

MEASURED IN GAME, and it confirms the rule to the integer. Starved of
Spark, Conduit: Power stacked to exactly five and stopped - from a full
100, the finisher's flat 10 leaves 100/90/80/70/60 before five spends, all
strictly above 50, and 50 before the sixth, which is not. Fed Spark, the
same buff reached its full twenty for +10% MagicMastery. So the five was
the GAUGE and not the cap, and the row's maxStacks 20 and duration 15 are
both right - which also retires a claim that the row authored neither.

That second reading is what moves the number. Conduit: Power was credited
at its cap, a permanent +10 MagicMastery on a class that multiplies by it,
where the gauge fires about once every 22 seconds against a 15-second buff.
Standing at the cap is not a thing a fight does. Pricing the mean needs the
stack counter's affix side, so it is refused and named rather than kept at
the flattering end.

Also: onStartConduit joins the rider hooks. A conduit has no cast - it IS
the trigger - so an `on: Code` step its own script plays there happens once
per fire. Without that, Conduit: Spark Explosion sat in the rotation
carrying nothing while the step holding its whole 0.25 x Intellect was
refused beside it, the same circle Staff_Censer_Skill2 fell into.

Mage 364.6 -> 323.5, and its unscored list 7 -> 6. Warrior 512.4, Rogue
392.3, Priest 383.2 unchanged. Suite 645 green.

## 2026-08-02 - A buff that will not renew itself is not a buff at its cap

StoneOfPower rolls `checkProba(vars.chance) && !owner.hasStatus(<the very
status this call applies>)` on every damage instance you deal. The reader
saw `hasStatus` in UNREAD_COND and refused the whole thing, so all four
trinket Stones and PrismaticPearl scored exactly zero - a trinket slot the
optimiser could not see at all.

That guard is not a question about live state. It is the applier declining
to renew its own buff, which makes the thing an ALTERNATING RENEWAL
process: on for its whole duration, then off until the next success. Uptime
is rD/(1+rD) - 34% at one damage instance a second, 72% at five - and it
NEVER reaches the cap. A refresh-and-stack buff is 1-e^(-rD) instead, which
does saturate. Reading one as the other is a third of the answer, so the
guard is read rather than the shape assumed.

Both forms go in as closed forms rather than as events in the fight, and
that is deliberate. The fight thins applications evenly, one every 1/p
events; even spacing is not a renewal process. For a blocked buff whose
duration sits near the mean gap, regular arrivals give ~95% uptime where
the real geometric process gives ~49% - the flattering direction, which is
the one to refuse. The event rate is estimated from the rotation's swing
cadence rather than the true damage-instance count (a multi-hit cast and a
bleed tick both raise onInflictDamage), so the number is a floor and says
so.

Enchant_Zealot and Enchant_Devote stay frozen at the cap, gated BY ID.
Every shape-based gate catches something else: "chance < 1" also catches
Staff_SummonDemon's rank-3 buff, "is a Passive" catches the Stones. The
cost of the freeze is measured - under 1% in a filler-heavy fight, up to
~40% at a quarter swing clock - and it is in the audit.

On a legendary GA_Craft Warrior the Stone is now worth +3.9% where it was
worth nothing, and the sheet reads +4 Strength of its +10 rather than
either 0 or 10. Baselines unchanged (the level-6 Rare Stones do not win a
level-25 trinket slot); suite 634 green.

## 2026-08-02 - Write down the road again: what landed, and what the reads already say

The roadmap was a plan; this is a plan plus the reads that were done
against it, so the next pass starts from the answers rather than from the
questions.

What landed: crit rolling, three rotation atoms and a bounded memo, the
on:Code split, the stack counter's damage side, Mono settled at the opcode
level, and the gear bake traced.

What remains now carries its reading. The proc-buff item has both closed
forms and the two enchant rows that must stay frozen. The cooldown item has
the real site counts (26 dynamic, 8 reduceWeaponsCooldown of which the
model credits one) and the correction that the star procs have no internal
cooldown at all. The next-cast item has the four realisations of the shape
and the note that both live statuses are infinite. The trinket item says
which five of the eight refusals are one guard away from being computable
and which two are genuinely blocked. And the conduit gauge is named as the
one missing rate behind three Mage entries.

Method gains a fourth rule with teeth: a refusal whose stated reason is
FALSE is a bug too. Four were. And the verification note is now specific -
one claim in six needed correcting, including a hook name that does not
exist anywhere in the game.

The in-game protocols are written out rather than described, each built so
one reading discriminates between the candidates.

## 2026-08-02 - Re-run the numbers the README quotes, and say what the bake actually does

The README's rotation transcript was two different stale runs stitched
together: a ROTATION block reporting derived 336.3 beside an --across table
whose armorpen row said 272.3, neither of which this tool has produced
since the buff-window fix. A repo whose whole claim is that every number
comes with the fight it was computed over cannot ship a transcript nothing
reproduces. Both blocks are re-run from one session, and so is the
--across-search matrix.

They also say something new. The searched rotation is +2.22% over the
derived order where the old text said +0.5% and explained the small number
by the mechanics the model refused; two of those have since landed and the
winning list uses both - `Shockwave if debuff.Tear Reality.remains>=3` is
do not spend it into a window that will close first. One restart in 250
found that list, where it used to be 107 in 250: a richer vocabulary makes
the basin narrower, not wider, which is exactly why the search kicks the
incumbent rather than restarting at random.

And the gear bake is traced. generateItemAffixes@20747 is NOT a
per-aptitude sum: it groups aptitude.atbScaling rows by endAtb, averages
start/end across the group, evaluates the curve once at L = iLevel/10,
multiplies by gearRatio unless the row is gearOnly, divides by
item.aptitudes.length, uses Math.round only as a `> 0` predicate - there is
no loop, op 288 is a continue, so "round-as-loop-count" was a misreading -
then multiplies by itemType.atbRatio[statGroup] and rounds once to emit.
This model is the same expression with aptitudes.length := 1,
gearRatio := 1, the group mean replaced by a per-row sum, and the round
moved inside the sum. The two reproduce the same ten measured integers at
DIFFERENT inferred levels - this model at effective level 11, the bytecode
uniquely at iLevel 290 - so the tooltips do not separate them and the
bytecode is authoritative. Three gaps fall out and are named: the Uncommon
statGroup rules, Armor's reduction taking the ITEM's aptitude mean rather
than the wearer's, and gearRatio missing entirely. The rewrite moves every
stat in the tool, so it belongs in its own change with the integers
re-measured against it - a named next edit rather than a pending read.

## 2026-08-02 - Stop refusing things for reasons that were not true

Four of the refusals in the coverage report were about the reader, not
about the game, and one of them was scoring a talent at zero that the
reader had already read correctly.

A RESOURCE THE BUILD DOES DECLARE. The kind ladder matched the word
[ComboPoint] in a rune's description and filed the skill under "gated by a
pool nothing in this build declares readable income for" - about a Rogue,
whose Combo Point income is read three screens earlier and is what gives
the Finisher its cost. Shadowstep and Death Mark both came out that way.
Now the NAMED pool is checked against `tracked`, so the sentence is only
printed when it is true.

A MODIFIER THAT WAS READ AND THEN DROPPED. Rogue_Talent_LethalDose scopes
its +10%/+20% to damage from a Poison-typed status; `bench talents` has
always printed "+10% damage dot:Poison" and engine.mjs then routed
everything that was not attack/weaponSkill/physical/magic/bleed/all into
unreadMods. The scope names a real statusType - Poison carries the DoT flag
and twelve status rows wear it - so it goes down the per-dot channel with
its own type, and `dotOutput` now offers that channel to AUTHORED dots and
not only to pool ones. Bloodletting reaches non-pool bleeds by the same
line. Rogue 385.0 -> 392.3.

A TALENT THAT GRANTS A SKILL. `props.subskills` is the column every weapon
follow-up already uses and `bench talents` already follows to print "grants
a skill" - and the optimize reader did not, so two Mage conduit talents
were filed under "no effect, no affix and no status anywhere in the row"
while the talents command printed a damage effect for them on the same
build. Two readers of the same data disagreeing inside one tool is worse
than either answer.

A SHIELD IS NOT AN UNREADABLE STATUS. Halos_Demon_Passive's absorb is
0.7 x Intellect on the granted status's Refresh step; "its payload is a
status that declares nothing readable" was false about it. It is worth zero
for the same reason a block proc is - nothing attacks you - and it now says
so.

Also: a conduit's refusal names the real gap (every equipped conduit fires
when the Spark gauge crosses its threshold, and the fight spends Spark
without simulating the gauge) rather than pointing the reader at the
CastleDB; and Mage_SparkMaster stops being listed as unmodelled while the
model is visibly using it to spend Spark, the same rule that already
accounts for Priest_Rosary and Warrior_Rage.

Unscored lists: Warrior 4->5, Priest 4->7, Rogue 4->6, Mage 8->7 - the
counts go UP where the on:Code split turned one silent refusal into several
named ones, which is the direction this report is supposed to move.

Baselines: Warrior 512.4, Rogue 392.3, Mage 364.6, Priest 383.2. Suite 624.

## 2026-08-02 - Count the stacks: a poison at five is not a poison at one

getStackFactor@20772 runs as the LAST line of getStepEffectVal@20775 -
after the scaling, after the spread division, after the damage variance -
and multiplies the value by Status.stacks whenever the running skill is a
Status that is either a DoT (its statusType, or an ancestor of it through
the parent chain, carries the DoT flag) or carries the ScaleWithStacks
effect flag. It is an OR evaluated once, so a status that is both -
Daggers_Demondash_Passive_Status is typed Burn AND flagged - is multiplied
exactly once.

The model tracked whether a status was up and never how many. Five stacks
of Lethal Poison were priced as one. That is the Rogue's 323.9 -> 385.0.

The count is read AT EVERY TICK, so the per-tick value snapshots and the
multiplier does not. The cap is getMaxStacks@14459: props.status.maxStacks
with a DEFAULT OF 1 rather than unlimited, replaced by any rankOverride at
or below the APPLYING skill's rank - which is how Hysteria's counter drops
from 150 to 100 on upgrade - plus one script path, Lethal Poison's
getStatusMaxStacks(b) = b + getTalentRank(Rogue_Talent_ImprovedMixture).
An application adds exactly one stack: props.status.stacks is authored on
none of the 100 type:Status steps. Nothing decrements a stack on a timer;
the whole status expires at once, and DurationBased's
ceil(stacks x durationProgress) is sampled only at application, which is
why the table needs no per-tick decay.

maxStacks <= 0 means UNCAPPED, and that sign was a live trap: the bare
`?? 1` it replaces handed the literal -1 into the affix scale, a buff worth
MINUS its own value. Only a foe status carries affixes among the seven that
author it, so nothing was visibly wrong - the kind of bug that waits for a
patch. An uncapped dot is now held at one stack and NAMED, because over 200
seconds an every-swing application reaches two hundred stacks and prints a
number that grows with the fight length rather than with the build. Every
uncapped dot in the sheet today is a pool dot, whose fed/owed ledger
already IS the count expressed as damage, so nothing is scored at that
floor.

The dot line says so out loud now - "96 ticks of 75 every 2s from Lethal
Poison - 12 a stack, 6.5 stacks on average of 7" - because printing the
one-stack figure beside a total six times larger reads as an arithmetic
error in the tool.

Not landed, and in the audit: the affix side. applyAffixes@6083 multiplies
each affix by getAffixMultiplier() = stacks too, and a stat buff is still
counted at its cap.

Baselines: Warrior 512.4, Rogue 323.9 -> 385.0, Mage 364.6, Priest 383.2.
Suite 621 green.

## 2026-08-02 - A step the cast does not play: read `on: Code` and put it on its own clock

skill@steps.on has a Code case and it means what it says - the step is
played by playStep(Steps.<id>) from the row's own script and by nothing
else, Steps.<name> being the step's id column, which 139 of the 141
playStep call sites in the sheet name on their own row. 158 steps declare
it, 72 carry a real amount, and every one of them was being folded into its
skill's cast output.

Brutal Frenzy is the size of it. The cast is the 1.43 x Strength Area step,
the measured 133. The 0.3 x Strength Mono step is `id: "Attack", on: Code`,
played by

    function onInflictHit(hit) {
      if( rank >= 3 && hit.isBaseAttack) {
        if(checkProba(vars.chance)) { playStep(Steps.Attack, hit.target); }
      }
    }

at vars.chance 0.15 - the tooltip's "all your attacks have a 15% chance to
deal an additional 28" in as many words. So the finisher prices 133 rather
than 161, the suite now asserts BOTH measured integers instead of their
sum, and the audit line that admitted to keeping the wrong schedule
knowingly is closed.

Three shapes fall out. An event rider (isBaseAttack, isFinalCombo,
isWeaponSkill, isStatusType(Bleed)) goes on that event's clock with the
roll and the crit gate read the way a proc's are - which needed
weapon-skill and attack-or-combo trigger buckets the sim did not have. A
per-cast rider (onDamage, onHit, onStart, onCastEnd, onAreaElapsed, or a
guard naming one of the host's own steps) is folded back INTO the cast at
its chance, because its schedule is the cast's: Staff_Censer_Skill2's
entire damage is one such step, and left outside the cast the skill carries
nothing, never reaches the rotation, and the rider has no parent to hang
off - a weapon lost its best skill to that circle before the fold went in.
Everything else is refused with the hook named.

That last one moved a headline. Halos_Demon_Skill2 plays 2.5 x Intellect
when a target LEAVES its leash and the simulated foe does not move;
refusing it took that arsenal from 340.5 to 311.9 and freed the search onto
Spear_Goo, which scores 364.6 under the old code as well - the Mage
optimiser had been sitting 24 dps below an option it could already see.

Baselines: Warrior 512.4 and Priest 383.2 unchanged, Rogue 326.0 -> 323.9
(Daggers_DuplicatePoison's bonus needs a stacked poison, Demondash's rides
a 30% roll), Mage 340.5 -> 364.6. Suite 603 green.

## 2026-08-02 - Name the talent the sigil grants, and stop calling the readable one unreadable

The sigil line said 'a free tier-4 talent this model cannot score' about all
twelve variants, and that is only true of some: the Warrior's Infused Wound
sigil grants a fully readable pool bleed - 35% of magic crits, worth exactly
zero on an all-physical build, which the search already priced by tying all
three variants - while Surge of Violence really is a next-cast register the
fight does not carry, and Second Wind is a skill, not a tree node. The line
now names the granted talent and says which case it is.

## 2026-08-02 - Say the three things a rotation line could not say, and stop replaying fights

The list could ask whether a window was open and never how much of it was
left; it could ask whether a pool had enough and never whether it had too
much; and it could ask whether a cooldown was running and never whether it
was nearly back. Each of those is an ordinary rotation decision:

  buff.X.remains>=n   do not start a long cast into a window with a second
                      left, and refresh a debuff before it drops
  rage<=n             a generator is wasted at a full bar, so press it low
  cd.X<=n             hold the filler, the big one is nearly back

The thresholds are not a continuum. The only question a remaining-time test
can answer is whether there is room for what you are about to press, so the
discrete set is the OCCUPANCIES of this build's own casts - the durations
actually on offer - rounded to the half second and capped at three. An
armorpen Warrior's vocabulary is 45 atoms, and the search reached for one
immediately: Shockwave if cd.Rampage<=1, worth +2.54% over the derived
order where the old vocabulary found +0.49% at six times the restarts.

cd.X<=n reads ready as back-within-n, which makes it a superset of ready.X
rather than a rival - and therefore vacuous on X's own line, the same way
ready.X already was. rage>=10 & rage<=5 is refused as contradictory, and so
is buff.X.down & buff.X.remains>=1: a line that can never fire costs a
whole fight to discover.

And the search now remembers what it has played. Steepest ascent
regenerates the whole neighbourhood every step and most of it is unchanged
from the step before; the kicks then re-climb from a list it has mostly
already seen. 43% of a 40-restart run was re-simulation - 99,601 fights for
176,358 lists considered. Keyed on the list itself, bounded at 200k, and
the repeats are printed beside the fights rather than folded into them: "N
simulated fights" now means N fights actually played.

Suite 601 green; all four baselines unchanged (512.4 / 326.0 / 340.5 / 383.2).

## 2026-08-02 - Throw the last die: crit rolls, and the spread stops lying

--fights existed to say how much of a build is luck, and crit - the one
thing every build in this game is actually built around - stayed at its
expectation while everything else rolled. A crit-bleed Warrior reported a
spread of 0.2%. That read as a claim about the build and was a fact about
the model.

A cast decomposes as fixed + base x (1 + p(cd-1)), because crit chance and
crit multiplier are properties of the SKILL and not of the effect - the
category riders (Sever on weapon skills, Master-at-arms on attacks) key on
prof.type - and a status tick, which cannot crit at all, falls entirely
into fixed. Roll k of n hits and you get fixed + base x (1 + (k/n)(cd-1)),
whose binomial mean is exactly the deterministic number.

What fed a pool follows the same die. Hemorrhage takes 35% of physical
CRITICAL damage, so a swing that rolled no crit feeds it nothing; averaging
the feed while rolling the damage would have put the spread straight back
where it was.

The roll happens in the fight, not in castOutput, because the pricing cache
is keyed on state - a cached roll is the same roll every time, which is how
a die stops being one.

Deterministic output is untouched: all four baselines re-record to the
decimal (512.4 / 326.0 / 340.5 / 383.2). Only the spread moves, from 0.2%
to 2.5% on a crit corner.

## 2026-08-02 - Write down the road: the method, the remainder, and what done means

The Warrior is the standard now - every point of damage scored from a read
formula or refused with a checkable reason - and this is the program for
holding Priest, Rogue and Mage to it: the three-step method that worked
(data, then bytecode, then a five-minute dummy protocol), the per-class
lists, the cross-class engine items that unblock several at once, and
acceptance criteria strict enough that '100% covered' is a checkable claim
rather than a feeling.

## 2026-08-02 - Read the cooldown riders: a reset is worth more than most damage

A skill-bound class trades damage for tempo, and ~50 scripts mutate
cooldowns - Tear resets Bonethrow on a crit, the bow passive resets its
skill on 8% of swings, Prosecutor hands the Priest signature half a second
per crit. Wave one reads the explicit-target family, resetCooldown(Skill.X)
and reduceCooldown(Skill.X, vars.t), with the guard read the way a proc's
is: the hook, the event, the roll, the crit gate, the rank gate. The fight
fires them with deterministic thinning - a 30%-per-combo reset lands once
every ~3.3 combos, never '30% of a reset' - and rolled runs roll.

Bonethrow on a naked axe drops from its authored 14.3s to 11.8s off Tear's
crits alone, and the effect compounds with every point of crit the gear
search buys - which is exactly why these riders could not stay refused. A
site the fight cannot produce keeps its refusal and names it: Rampage's
rank-3 reset of Shockwave fires onKill, and nothing dies in a fight against
a reference boss.

## 2026-08-02 - Score Dominion's proc, and say WHY a block never happens

Shield coverage, walked item by item after the offhand question. Dominion's
passive turned out to be live code behind a commented-out draft: the first
combo finisher each cooldown plays a 0.1 x Armor hit and consumeCooldown()s.
That is a readable shape - a cooldown-gated trigger - so the fight carries
the gate now (exact in a synthetic: ten fires, 20.0s apart) and the passive
scores. The same shape is what the twelve weapon-upgrade star procs want,
one chance-roll away.

Magma Mia's flame cloak and the water shield's block stacks stay at zero,
and now say the true reason: they fire when you block or when you are hit,
and the simulated foe never attacks. 'foe is passive' is a statement about
the fight model; 'no rate' claimed the data withheld something it did not.

For the record, the sweep's Shield_Start monotony survived a full re-rank
audit: in a real build, shield actives compete for cast time against the
mainhand's better skills, and the cheap starter skill genuinely wins -
344.1 against a five-star Legendary Dominion's 341.4.

## 2026-08-02 - Show the hand the search already filled

A one-handed mainhand gets its offhand searched like any slot, shield skills
included - Cheese Moon takes Shield_Start for the +3.7 dps its skill is
actually worth, not as a tiebreak - but the summary table and the index
never said so, which read as the slot being skipped. The offhand now rides
the table, the index rows and each pair envelope.

For the record, because it looks wrong until it is checked: Shield_Start at
zero stars is the game's own rule - the five starter pieces carry an
explicit PreventUpgrade flag - and every other shield upgrades normally.
What keeps the other shields from competing is that their skills are refused
(Depth Shield's status declares no rate), which the coverage report already
names per build.

## 2026-08-02 - Write each layout as it lands, and let a dead sweep resume

A layouts sweep is exactly the run long enough to want reading before it
ends, and exactly the run most likely not to end: every pair's report now
goes to disk the moment it finishes (bench-layouts-<class>-<goal>/, --out
moves it), index.json is rewritten per pair with the ranking so far, and a
pair whose file already exists is skipped - so a crash, a Ctrl+C or a second
invocation resumes where the last one stopped, and --fresh recomputes.

Each pair file is an optimize-shaped envelope that --build reads back
directly, which also removes the extract-a-build-first friction the single
container had. Memory stops scaling with the sweep: what survives per pair
is one summary row, the full evaluations kept only for the --show best.

## 2026-08-02 - A cache that never evicts is a leak with a hit rate

Twenty-five pairs into a layouts sweep the process died at 4GB, and the
culprit was the rotation cache: its key carried EVERY gear slot's item, so
each of the optimiser's ~20k armour candidates minted its own cached
rotation - a cache with a near-zero hit rate in exactly the workload that
runs longest. An armour swap cannot change the rotation, so the gear portion
of the key now names only skill-bearing items, which both bounds the entries
and makes the cache actually hit.

Every other accumulator whose key carries a search-varied set - statusesOf
and resourceGainsOf on the talents set, profile on the rune set, the talent
readableValue on the allocation - gets a FIFO cap as the second seatbelt:
evicting the oldest entry costs a re-read, never correctness. Twenty
full-optimize pairs now plateau at ~880MB where they used to pass 2GB, and
the layouts progress line shows RSS so a regression is visible while it
happens rather than at the post-mortem.

## 2026-08-02 - Say what has been checked, now that so much has

The README still apologised that almost nothing was verified against the
running game, through a sentence whose template holes never rendered. The
truth inverted: the naked sheet reproduces to the decimal, two weapons were
measured live on a 0-armor dummy, six tooltips render the formulas the model
implements, and the composition order is disassembled rather than assumed.
The formula block grows from four read formulas to seven; sequencing's
0-0.4% updates to the ~1.7% the searcher finds now that the resource pools
are real; and the stackingPolicy row moves to READ - the refresh window is
max(new, remaining), which the fight applies too.

## 2026-08-02 - One report per ordered weapon pair: bench layouts

weapons --pairs answers the pairing question on a pinned stat rig, wearing no
armour. This is the expensive sibling the question deserves: both weapon
slots pinned per cell and everything else searched for real - every armour
slot, the offhand, every enchant and gem socket, the arsenal skills, the
sixteen talent points and the runes - so (A main, B arsenal) and (B main,
A arsenal) each get the layout a player would actually wear. Weapons pin at
their best attainable rarity, the same assume-the-good-version default a
--pin gets; --main/--arsenal narrow the sweep, --restarts trades depth for
time, --show prints the top layouts in full, and --json checkpoints every
five pairs so a long sweep that dies keeps what it earned.

## 2026-08-02 - Close the last two disputes: the divide is real and the tooltip ceils

generateItemAffixes@20747 does divide each gear-stat row by the aptitude
count - read directly at HItem.hx:415 - and it does not contradict the
character sheet after all: for attributes both aptitudes carry, sum-of-halves
equals mean-of-fulls, so this model's per-aptitude-rounded sum reproduces
every measured tooltip integer either way. The decompositions differ only in
which inferred drop level fits a single-aptitude line; the bake's full loop
is the named next read.

And the tooltip renderer (skillEffectValText@20949) resolves its unit to the
live Hero, so its range endpoints go through the same virtual ceil the dealt
number does - the reading the calibration assumed.

## 2026-08-02 - Disassemble the formulas, and let the code correct its own calibration

Nine readers over hlboot.dat, every claim op-cited, and the measured model
mostly held: the budget curve, the mitigation formula, the crit roll, the
stacking policies, the hook scoping and the statusType parent walk all read
back exactly as calibrated. What the code corrected:

  - WeaponPower has no handedness factor: the flat is 0.4 x the SUM of the
    item's aptitude primary budgets, and the 1H/2H asymmetry was the authored
    per-type swing ratios all along. Every measured tooltip reproduces.
  - The 60/40 weapon-skill mix gates on skill TYPE, not slot - the arsenal's
    weapon skills mix identically; class skills stay pure attribute.
  - Fervor and the matching mastery are ADDITIVE in one bracket, times
    DamageModifier; Raw damage bypasses all of it; a status tick can neither
    crit nor carry the attacker's bracket at all.
  - The chain drops on one rule - ComboWindow (0.6s) without an attack - so a
    hypothetical sub-window cast preserves it; a refresh never shortens a
    status; mitigation divides by the STRIKER's level; heroes display ceil.
  - Skill_RecoveryTime is foe AI, function-cited; the once-unplaced
    recoveryTime symbols are the skill sheet's aiProps column.

And two refusals lift: Mage weapon skills now cost round(max(5, cooldown))
Spark against Ray of Spark's income, and the Rogue's finisher spends four
Combo Points at +30% each, both read out of the class scripts' compiled
bodies rather than guessed.

## 2026-08-02 - Read the compiled half: a bytecode reader for the file the model always cited

hlboot.dat is HashLink bytecode with full debug info, and it is where every
formula lives that data.cdb does not state. This reads all of it: the varint
stream, the type table, 47342 functions with opcodes, per-op source lines and
local variable names, and resolves findex -> Type.method through the object
protos and bindings - so 'ent.Unit.applyDamage (findex 4835)', which
docs/MODEL.md has cited since the start, now falls out of the repo's own
tooling.

The file is its own checksum: one wrong argument count desyncs the stream
within a handful of reads, so parsing 40MB to exactly EOF validates the whole
table. Shiro's toolchain adds one opcode past OAsm; its single-argument shape
was found empirically - zero arguments desyncs 150KB later, one reaches EOF.

  node bin/hl.mjs find 'Unit\.(apply|compute)Damage'
  node bin/hl.mjs disasm 4841
  node bin/hl.mjs grep-str WeaponPowerRatio

## 2026-08-01 - Measure the fight in game, and find the model both inventing and refusing damage

Fixes found by auditing the sim against what a player actually does:
Bonethrow's pool ate the whole rotation's crits through a hook it does not
have (~18% of the Warrior headline invented); pool dots now pay out over
their own ticks and take their multipliers per status type, one-way through
statusType.parent; Ram Veil's stack-gated buff is refused and named instead
of credited at full uptime; Berserk's RageGainFactor is read live; the fight
plays for the goal it was asked; the chain restarts after a cast.

Calibrated against live readings on a 0-armor dummy, two weapons, six
tooltips and one character sheet, all pinned in the suite:
  - WeaponPower = the trained level's flat primary budget (x0.4 two-handed)
    plus the mean of the item's aptitude attributes
  - a mainhand skill's attribute scaling is 60% attribute + 40% of that
    attribute's own budget curve (WeaponPowerRatio's 0.4, rendered outright
    by the expanded tooltips; ten integers exact)
  - an item pays EVERY aptitude it names - the own-half rule is refuted by
    the character sheet - except armour, which pays once
  - masteries multiply x1.12 as assumed, Fervor applies to base attacks too,
    the +-10% roll rides weapon damage only, and a chain link swings no
    faster than 0.7s

503 checks were green before; 549 are green now.

## 2026-07-31 - Pin the stats to stated numbers, not to fractions of a budget

I read "all stats at 50" as fifty percent of a budget. It meant fifty POINTS.
The two are not the same instrument and the difference matters: a fraction of a
budget is a different number per class - a Warrior's full primary budget is 123.6
and a Rogue's is 148.3 - so "half a budget" carries the budget's own shape into
every comparison, which is exactly the confound a fixed rig exists to remove.

So a profile now PINS: `zero` puts every stat at 0, `mid` at 50, and each named
profile puts every stat at 50 and its own at 100. --profile-base and
--profile-peak move both numbers.

Forced, not added. The values replace whatever the level curve, the gear and the
weapon produce, so a weapon that is simply a better stat stick cannot win on
that - two weapons differ only in the kit they grant and the coefficients they
scale by. `computeSheet` applies them INSIDE its topological walk rather than
over the finished sheet, so everything downstream is computed from the forced
number: pin Dexterity and the CritChance that scales off it moves with it.
Overriding afterwards would have left every derived stat disagreeing with the
stat it derives from.

And the question the rig exists to answer now has a command. `--across-search`
searches a FRESH rotation at every corner with the kit held fixed - so the only
thing that moved is the stats - then cross-evaluates every rotation at every
corner. On Judgement + Worldsplitter the answer is "yes, a little": each corner
wants a visibly different list and `crit` reaches for the only two-term
condition, but carrying one rotation everywhere costs at most 0.56%. That is a
decision with a number on it rather than a guess.

`--across` keeps the weaker question - one rotation, re-evaluated elsewhere.

## 2026-07-31 - Move one stat at a time, and stop refusing a legal pair of hands

Two things, both found by running the tool the way a user does.

PINNING BOTH HANDS WAS REFUSED. `--pin weapon1=Axe_Boomerang --pin
offhand=Shield_Craft` came back "the pinned offhand leaves no legal one-handed
mainhand", which is false - an Axe is an OHWeapon and the pair is legal. The
guard exists for "you pinned a shield and now nothing one-handed is left to
CHOOSE", so it only makes sense while the mainhand is free; a pinned slot has no
candidate list at all, and `undefined?.some()` is falsy, so pinning both hands
took the branch every time. The genuinely illegal pairing - a two-hander and a
shield - is caught a few lines above, where both are known.

THE PROFILE SET NOW MOVES ONE STAT AT A TIME. Every stat sits at the same
fraction of ITS OWN full-set budget, and one of them is raised to the top:
`zero` is nothing, `mid` is half of everything, `full` is all of everything, and
each named stat is `mid` with that one at a full set. So `crit` minus `mid` is
exactly "half a budget more CritChance and nothing else moved".

The old set poured the whole ratings budget into one rating and left the others
empty, so a "crit" corner also had NO PENETRATION - and a difference with two
causes measures neither. That also means every corner except `zero` is now
deliberately unattainable, because four ratings at half a budget each is two
budgets and gear delivers one. It says so: holding nine stats still and moving
the tenth is what a probe is for, and the output prints the overshoot rather
than letting a probe read as a build.

One test went with it. "Concentrating the ratings budget beats splitting it" was
asserting a property of the old profile SHAPE, not of the game. The claim it was
standing in for - penetration has increasing returns, which is why the gear
search needs rating-themed seeds - is now tested where it actually lives, in the
mitigation curve.

500 -> 507 checks. No class's optimize result moves.

## 2026-07-31 - A rotation the search could not beat is still a rotation, not a null

`bench rotation` crashed whenever the search failed to beat the baseline: `best`
was seeded with a null list and only replaced on an improvement, so a build where
the derived order wins printed a header and then died reading `.entries`.

It is not a rare case, and the reason is worth printing rather than hiding. The
baseline is the better of plain priority order AND an 8-second rollout, and a
rollout is not something a priority list can express - it re-simulates the next
few seconds before every cast. Where the rollout wins, an APL starts behind and
may never catch up. So the list falls back to the derived order, the output says
so in as many words, and it points at `--lookahead 0` for a comparison against
plain priority order instead.

Found by running the command the way a user would - a different weapon pairing,
this one with an empty arsenal.

## 2026-07-31 - Say the things a priority list needs to say, and search it properly

The rotation search ran end to end and produced an answer, but what it searched
was "each skill, under at most one condition" - which excludes the two commonest
idioms in a real priority list. Calling that "the best rotation" was overclaiming.

CONJUNCTIONS. A condition is now up to three atoms ANDed. `buff.x.up & rage>=10`
is an ordinary thing to want and a single condition per line cannot express it.
Contradictions are skipped rather than evaluated - an entry that can never fire
costs a fight to discover.

DUPLICATE LINES. A skill may appear more than once under different conditions.
`Rampage if the armour is stripped` near the top and a bare `Rampage` below it as
the fallback is how priority lists are actually written. The search reached for
it as soon as it could: `Raging Smash if rage>=18` above the window and
`Raging Smash` again below. A skill is only EXCLUDED when its last line goes.

CHARGES. `charges>=n` against the line's own skill - "do not spend the last one" -
for a resource the fight already tracks per skill and nothing could ask about.

And the search itself was weak. Random restarts reached the best score in ONE
restart out of thirty, because the basin around a sensible order is narrow and
almost every random list falls into a worse one. It is iterated local search now:
every third restart is a fresh random list, the rest are one to three kicks away
from the incumbent. 107 of 250 restarts now reach the winner, and the winner
improved from +0.38% to +0.49%.

Two reporting fixes that were making the output claim more than it knew. The
tie-break nudge leaked into the reported score, so no restart ever "matched" the
winner by a hair. And ties now count condition TERMS as well as lines, which
strips tautologies - `ready.X` on X's own line, `rage>=9` where the fight only
offers casts it can pay for - that survived because they cost nothing and made
the rotation look like it knew something it did not.

Then the two checks the result needed. `--validate` re-rolls the procs instead of
averaging them and says outright when a difference sits inside the spread, or -
as here - that the build has nothing stochastic in it so the difference is exact
rather than significant. `--across` re-runs the rotation at other stat corners,
which is the entire claim behind searching a policy rather than a sequence: this
one holds at five of six and loses 0.73% at `half`.

README and docs/MODEL.md, which the last commit left out entirely.

## 2026-07-31 - Search the rotation, and find out the fight was pricing every buff window wrong

A rotation search that can only report "+0.4%" is not obviously worth building.
This one paid for itself on the first run, by putting `Ignore Pain` - zero
damage, one DamageTakenModifier affix - at the top of the priority list and
gaining 3.4%. A defensive cooldown cannot raise damage, so the fight was wrong.

`restat` re-prices a cast while a buff is up. It copied the three modifier
accumulators at CALL time, and the averaged-sheet step mutates those same maps
to fold in every timed buff at its uptime. So the moment any window opened,
casts were priced against base + every timed buff averaged in + the one actually
up, and PRESSING ANY BUFF AT ALL was a global damage bonus. The accumulators are
snapshotted while they still hold only the permanent layer now. Warrior 378.8 ->
367.5, Priest 252.7 -> 227.1; Rogue and Mage do not move, because their builds
put up no timed self-buff for the bug to bite on.

The search itself: an ordered list of (skill, condition), which is what
SimulationCraft calls an APL and what a player can actually follow. A sequence
would be the wrong object - optimal for one build against one deterministic
fight, and free to dump every cooldown before the bell. Conditions come from
what THIS build can produce: a buff or debuff it applies, a resource threshold
some cast actually costs, another skill ready or on cooldown. Steepest-ascent
over reorder / relocate / re-condition / drop, with seeded restarts; restart 0
is the derived order, so the answer is never worse than what was already
reported. Ties break toward the shorter list.

Rounds alternate: search the rotation with the kit fixed, then the kit with the
rotation fixed, until neither moves. The kit half lets unlisted skills fall
through, or every change that slots a new skill would be judged with that skill
never pressed.

For Judgement + Worldsplitter at the armorpen corner, 100k fights in 12s finds
+0.38%, and what it finds is legible: Rampage, Raging Smash and Shockwave all
gated on Tear Reality's armour-strip debuff being up. Strip a quarter of the
target's armour, then land the big one.

488 -> 500 checks, including one that asserts a zero-damage defensive cooldown
can never raise dps.

## 2026-07-31 - A fixed corner of the stat space, so a weapon can be compared without the gear

The best rotation depends on the weapon, the talents, the runes and the stats;
the best gear depends on the rotation. Searched together that is one problem
with two moving halves, and the gear half is the expensive one - twenty thousand
loadouts, where a rotation search wants thousands of fights per loadout.

A stat profile replaces the armour with a fixed, named sheet. Nothing in it is
invented: 1.0 of a group is `budget(level, start, end)` off aptitude.atbScaling,
armour takes the props.armorReduction inverse the rest of the model uses, and
itemType.atbRatio summing to exactly 1.0 per group over one item per core slot
is what makes one budget a COMPLETE SET rather than an arbitrary amount. One
budget is split across whichever ratings your factions pay, so a class's three
rating rows are one 100%, not three.

1.0 is the designers' unit and not the ceiling - a Legendary roll puts an item
above your level, augments add on top of the budget, and the arsenal adds 0.4 of
a second weapon, so a maxed Warrior reads 469 ArmorPenetrationRating against the
380 one budget gives. --profile-scale brackets it from the other side. A corner
gear cannot reach - a Warrior in Faith gear, or in SpellPenetration, which no
faction pays a Fighter - is marked a probe rather than presented as a build.

`bench weapons --across` then measures the thing the decomposition rests on, and
the answer is worth having before building for it: above the naked corner the
weapon ranking moves 0.3-0.6 places out of 13, and the skill choice does not move
at all on any of the eight weapons checked. Talents and runes do move, 3-4
different sets over six corners, which is what nodes trading crit against
penetration should do. So a weapon and its two skills are one decision that does
not depend on gear; the tree and the runes are re-decided per corner.

Naked is the one corner that reorders the top - GS_Nova wins with nothing on and
GA_Craft wins everywhere else - which is not a surprise once the ratings are
gone and a weapon's raw coefficients are the whole story.

473 -> 488 checks. No class's optimize result moves.

## 2026-07-31 - Say which node the branch is built on, and write down what is left

`bench talents` printed "nothing" beside Rage Shield and "status" beside Hold
the Line, which reads as advice to skip the first and take the second - exactly
backwards, since the second is worth nothing without the first. The table now
carries the link both ways, and the same two lines appear on the Rogue tree
where Atrophic and Crippling Poison wait on Lethal Poison.

Tests for the four readings: the dependency in both directions and the two cases
it must NOT refuse (a step-identity comparison, and an applier that is not a
talent node); the injected amounts and the three shapes that keep their zero;
the bleed-tick rule and a census that fails if a patch adds a third skill with
that shape; and that the allocation heuristic can now weigh a pool dot, a scoped
modifier and resource income. 456 -> 473.

docs/MODEL.md gains the three new script shapes and the reason each is not the
live-state question the refusal list is aimed at, the Warrior's remaining gaps
with what each is worth, and why the search needed three changes rather than one.

## 2026-07-31 - Score the injected amount, the bleed's own ticks, and the tree the gear is fitted to

Three things a Warrior build declares that nothing was reading, and one reason
the search could not find the build they add up to.

A `dynVal` effect carries no amount - the number arrives from a script - so it
reads as zero, which is right for eleven of the fourteen sites and wrong for the
three whose number is sitting in `vars` two lines up. `setDynVal(1, owner.maxHealth
* vars.var2); playStep(Steps.SelfHeal)` names both the slot and the amount, and
the step it plays has an id. So Last Stand heals 35% of MaxHealth and Fury Pulse
generates its Rage, where both read as blanks before. A share of a hit, a share
of CURRENT health and a script local keep their zero and stay named.

Cracking Blood went through no bucket at all. Its roll is guarded on
`dmg.isStatusType(Hemorage)` - which is not a question about live state, it is
which damage event this is, the same kind of statement as `isBaseAttack` - so
the event is a bleed tick, not a swing. Pool dots settle their total at the end
from what fed them and so never needed a schedule; they have one now, because
something rides it.

Then the search, which was fitting gear to a tree it had allocated by the size
of the numbers on each node. That heuristic could not see a scoped modifier or a
pool dot at all, which is most of the Warrior tree - and it lands 28 dps below
what ranking by the real objective picks. Every gear comparison in every pass was
made against that tree, and the good allocation arrived after the last restart,
when nothing could respond to it. Now: the tree is re-cut against the objective
whenever the ascent converges and the loop carries on, points are moved one at a
time until none improves, and the seeds include one per secondary rating with
every armour slot paying it - because penetration has increasing returns, so a
crit set and a penetration set differ by 3% with every single-slot step between
them downhill. A sigil is scored with the talent it grants, since it carries
nothing else.

Warrior 376.1 -> 378.8, Mage 319.9 -> 321.3, Rogue and Priest unchanged. The run
costs about three times the evaluations.

## 2026-07-31 - A talent that pays into the sheet has to be read before the sheet is built

Two Warrior nodes were scored, printed with a value, and worth exactly zero.

Red Tempo earns cooldown back per bleed tick, which is a rate and therefore a
CooldownReduction - so the modifier pass routes it onto the sheet with addFlat.
That pass ran AFTER both evaluateLoadout calls, so it wrote into a map nothing
read again. Two points in the node moved the answer by 0.00. It runs before the
sheet now, and it is scoped: reduceWeaponsCooldown is the weapon-skill-only form
and the node's own text says "the cooldown of all your [WeaponSkill]s", so the
divisor is per skill rather than one number on the sheet speeding up Charge and
Berserk as well.

Hold the Line was the error in the other direction. Its script fires on
`s.kind == Warrior_Talent_RageShield_Status` and the guard reader had no case
for a status-identity comparison, so it evaluated to "unconditional" and the
node was credited +6% damage and -6% damage taken whether or not Rage Shield was
taken - 22 dps for a talent whose own text says "while ::ref2_name:: is active".

`.kind ==` is not one thing: against `Steps.X` it is a dispatch on the skill's
own step and no condition at all, against `Skill.X` it is a dependency. Only the
second is read, and only where the answer is definite - a status whose appliers
are all talent nodes is one the allocation can rule out; anything else stays
unknown and is left alone. Four nodes across three trees have this shape.

Warrior 376.1 -> 382.9. Rogue, Mage and Priest unchanged.

## 2026-07-31 - Read the guard, and refuse the conditions the build cannot answer

Checked against a real level-25 Warrior, which corrected the foundations:
RoundUp rounds rather than ceils (the raw curve gives 33.974/28.091/38.211
against a game showing 34/28/38, and only rounding fits all three), and the
printed sheet is the RESTING one - crit read 8.3% because a 120-second buff
was averaged in at its uptime. All fourteen attributes now reproduce exactly.

The chain's length is authored in moveSet.comboLength and was never read.
Scepter_Flamie swings three times and then the combo - confirmed in game -
where its item row lists two, so its finisher was landing twice as often as
it should and every prayer and isFinalCombo proc with it.

Weapon mastery and runes are disjoint systems: rank gates sit only on weapon
skills, combos, passives and talents, runes only on class and signature
skills, and no row carries both. Six class skills exist per class and four
fit on the bar, so which four is now a decision the search makes.

Resources are a second kind of cooldown. Both halves were in the data and
only one was read - props.costs says a cast takes 10 Rage, and Warrior_Rage's
script says you make one from every attack, combo and weapon skill. The
regex matched addStatus and never addAtb.

The script readers, each first written too permissively and caught by a class
sweep: scoped damage modifiers, pool dots whose magnitude is a share of the
crit that applied them, healing shares, cooldown per tick, and rune cost
relief. rank, hasTalent, hasMastery, critical and totalHits==1 are evaluable
and are evaluated; hasStatus, healthRatio and their kin keep the rate refused
and named. Hemorrhage now scores, and with it the eleven nodes downstream.

docs/MODEL.md section 14 lists every shape, where each is read, and what is
left - with the reasons, so the next session does not have to rediscover them.

## 2026-07-30 - The tier thresholds are indexed by tier, and the root counts everywhere

Confirmed in game, and it is the reading I had rejected:

  tier 0  from the start
  tier 1  every branch, once tier 0 holds 1 point
  tier 2  that branch, once tier 1 and below hold 2 cumulative
  tier 3  that branch, once tier 2 and below hold 4 cumulative
  tier 4  that branch, once tier 3 and below hold 8 cumulative

So Talents_TierThresholds is read straight - [0,1,2,4,8] indexed BY TIER, all
five entries used. My shift-by-one was wrong, and the argument for it was wrong
twice over: it rested on 8 points not fitting in a seven-node branch, but 48 of
the 88 nodes hold two points, so a branch holds eleven.

The other half is that the ROOT counts toward every branch. It has to. A branch
holds exactly one tier-1 node worth one point, so tier 2 could never reach its
threshold of 2 from same-branch points alone; "tier 1 opens once tier 0 holds 1
point" says the same thing from the other side. Root points are now tracked
apart and added into every branch's cumulative total.

Both allocations tested in game come back legal and one point short is refused,
with the refusal naming the tier that actually blocked:

  root + 1 + 2 + 4 = 8 below tier 4   -> legal
  root + 1 + 3 + 3 = 8 below tier 4   -> legal
  root + 1 + 2 + 3 = 7                -> "Luminous Bastion is tier 4 and needs
                                          8 points at lower tiers in Left"

With the real thresholds and two-point nodes, all four classes now spend the
full 16 - the Priest was leaving 5 on the table two commits ago and 1 last
commit.

`bench talents` prints the thresholds per tier instead of dumping the raw array
under a label that stated the indexing the code had rejected, and adds the
points-per-node line.

305 checks, 17 new ones pinning every tier's boundary, the root's role, and that
the array is never shifted again.

## 2026-07-30 - Talent nodes hold two points, and the rank rows are exclusive

An adversarial pass over the talent and rune layer (four lenses, 29 findings
surviving independent re-check) found a fatal one, and it is the same mistake I
had already fixed once somewhere else.

`props.talent.maxPoints` is 2 on 48 of the 88 nodes - every tier-2 and two
thirds of tier 3. The comment in this file asserted the opposite, and the value
was read into a field nothing consumed. So the allocator could never put a
second point anywhere, which is exactly where the 5 points it reported as
"unspent" were supposed to go.

Worse, the affix rows are rank-gated to match:

  Priest_Talent_SharpMind.affixes = [
    { CooldownReduction, conds: { maxRank: 1 }, val: 3 },
    { CooldownReduction, conds: { minRank: 2 }, val: 6 },
  ]

Those are MUTUALLY EXCLUSIVE - 3 at one point, 6 at two - and the model summed
them to 9, a number no character can have. Identical in shape to the
cond.castHoldStep charge levels fixed in damage.mjs, on 12 affix-bearing nodes,
which are precisely the ones the greedy prefers. The Priest build's whole
CooldownReduction came from that one talent, on a build the tool itself reports
as cooldown-oversubscribed - so gear was being ranked against an unreachable
stat line.

Now: readableValue(id, rank) filters affix rows by rank the same way damage.mjs
already did for weapon-skill ranks; an allocation is a rank per node rather than
a set of nodes; the greedy scores the MARGINAL point (a second point in Sharp
Mind is worth +3, not +9); perBranch and coverage count points, not nodes; and
illegalAllocation replays an allocation point by point. A Priest goes from 11 of
16 spent to 15 of 16, with 11 of those points on nodes that declare a value.

Four more real defects from the same pass:

  * props.status.ref merged a status with no Buff guard, so an enemy DEBUFF's
    affixes could land on your own sheet. It now checks props.status.types.
  * Talent affixes were injected as flat only, silently dropping the three
    TAttribute_ARatio ones. Crusader's Resolve is a RATIO - +8% Armor - and was
    being applied, and printed, as a flat +0.08.
  * optimize() returned the score captured before talents were attached while
    the evaluation beside it included them: two numbers for one build.
  * A DemonSigil for another class could be pinned and its talent inserted into
    a tree it is not part of.

Plus: --talent-points now exists (the comment had promised it), the rune the
search picks is printed with how many of the three the model can actually tell
apart, and the hardcoded coverage counts in the audit text are gone - they had
already gone stale twice, so they now point at `bench talents` for live figures.

One thing this invalidates rather than fixes. The tierThreshold off-by-one was
justified by "tier 4 would need 8 points in a branch holding only 7 nodes". With
two-point nodes a branch holds ELEVEN points, so 8 is reachable and that
argument is dead. Both readings are now internally consistent and the comment
says so; settling it needs one in-game observation.

288 checks, 49 of them new and covering ranks, legality and coverage - the pass
also found this subsystem had no tests at all.

## 2026-07-30 - Follow the link that grants a status, refuse the one that only mentions it

The Sunlight description reads "empower them for 6s with Sunlight. The next
Final Combo Attack consumes Sunlight to deal an additional (60% Faith) Magic
damage" - and every one of those numbers turned out to be in the data. I was
not following the link.

`Priest_Talent_Sunlight_Status` carries `duration: 6` and a step whose effect is
`scaling: [{ratio: 0.6, atb: Faith}], affinity: Light`. The talent reaches it
through `steps[].props.status.ref` on a Status step, which is a real structural
grant: the step applies that status. Following it, plus the `props.subskills`
link already in place, takes readable talent nodes from 24 to 26.

I had said the consumption "lives entirely in the script layer". Half right: the
consumption does, and it is right there in the status's own script -
`owner.tryConsumeStatus(...)`, guarded by
`!hasSkill(Skill.Priest_Talent_SolarDevotion)`, which is Solar Devotion's whole
implementation. But the DAMAGE was declared in ordinary columns the entire time.

The more valuable half of this is what was refused. `texts.refs.ref` also names
a skill, on 240 rows, and following it would take readable nodes from 24 to 59.
It is a display placeholder - what fills ::ref_name:: and ::ref_dmg:: in the
description - so it points at whatever the text MENTIONS. 13 Rogue talents
reference Rogue_Talent_LethalPoison_Status and 11 Priest talents reference
Sunlight, because they modify it. Crediting each with the status's damage would
count one status thirteen times, for a coverage number more than twice as
flattering as the truth. There is now a test asserting a talent that only
mentions a status is never credited with it, and that the readable count stays
in the twenties.

That reframes the gap usefully: the base effects of a branch are largely
readable, and what is missing is the MODIFIER layer sitting on top of them - 21
of a Priest's 22 nodes adjust a status whose own numbers the model now reads.

One over-count this exposed, now in the audit: a granted status's script-gated
steps are counted unconditionally. Sunlight declares both a Damage and an
AreaDamage step and only plays the second when SunHalo is also taken, with
nothing in the step row saying so, so it reads as 1.2x Faith instead of 0.6x
unless SunHalo is in the build.

239 checks.

## 2026-07-30 - Spend the rest of the talent points, and correct what the trees are missing

Two fixes and one correction I owe.

The TALENTS block now prints in `bench optimize`. It was written into sheet()
where `res` does not exist, so it never rendered and would have crashed if it
had. It lives in format.mjs as talentBlock() now, next to the others.

The allocator no longer commits to one branch. A tier-by-tier walk that picked a
target branch ran out of nodes and left 8 of 16 points unspent. It is now a
greedy over every node that is LEGAL RIGHT NOW, re-derived after each point, so
filling one branch to tier 4 and spilling the remainder into the next-best is
the natural outcome rather than a special case. A Priest goes from 8 points in
one branch to 10 across three, 6 of them on nodes with readable values. It still
stops rather than spending the tail at random, and says how many are unspent.

Also: a node is marked a "gate point" by whether it is READABLE, not by whether
its weight is nonzero. Soothing Rays was being labelled a gate point while its
own row said it grants an effect.

The correction. I said last turn that the unreadable talents were "in game code,
mostly no script either". That was wrong, and wrong in the optimistic direction
once checked:

  * 72 of the 88 nodes ship an hscript body.
  * Between them those scripts call 63 distinct names, of which ~20 are entry
    hooks (onHit, onInflictDamage, onKill, onSkillProc, ...) and a few are
    built-ins. The real host surface for the ENTIRE talent layer is about 39
    functions - essentially the same ~40-function kernel the rest of the skill
    work needs.
  * All 88 carry a texts.desc, so there is a written statement of intent to
    check any implementation against.

So the trees are blocked on the script kernel, not on absent data.

And one field I simply was not reading: `props.subskills`. That is how a talent
that says "unlocks a new Conduit" actually hands you the skill - both Mage
conduit talents declare nothing themselves and grant
Mage_Talent_Conduit*_Conduit through it. Following it takes readable nodes from
22 to 24 and turns "unreadable" into "grants a skill that does X".
`props.talent.maxPoints` is read too; every node that declares it says 1.

## 2026-07-30 - Talent trees and runes: build the structure, and refuse to fake the rest

Runes work end to end. A rune modifies its skill two readable ways and the
model now applies both: `steps[].cond.mastery` names a rune and that step
exists only while it is slotted, and `mastery[].props` overrides the skill's
own props (`charges` and `cooldown` are the only two that appear). The search
picks one of three per skill.

Talent trees are fully structural: unit.talentTrees[] gives 22 nodes per class
as {skill, tier, branch}, Talents_TierThresholds gates depth per branch,
UnlockLevel_Talents is 10, and 16 points at the cap. A DemonSigil grants one
tier-4 node outright - it costs no point and does not count toward its branch
thresholds. Allocation, legality checking and coverage all respect that.

Two things this cost, both worth recording:

  * The thresholds are indexed FROM TIER 1, not from tier 0. [0,1,2,4,8] means
    tier 1 is free, tier 2 needs 1, tier 3 needs 2, tier 4 needs 4. Reading it
    as thresholds[tier] makes tier 4 cost 8 points in a branch that holds 7
    nodes - unreachable, and the allocator silently picks nothing at all.
  * A readable node is almost always gated behind unreadable ones. Every tree
    root declares nothing, so allocating over readable nodes alone picks
    nothing. The gate points have to be spent; they are spent, marked blind,
    and counted.

And the honest part. Across the four classes there are 88 talent nodes and
**22 declare something a data-driven model can read** - 13 a stat affix, 2 a
self-buff status, 7 a damage effect. The other 66 declare no affix, no effect,
no status, and mostly no script: their behaviour is in game code keyed on the
talent being slotted. Runes are the same shape, 17 of 84.

So the optimiser allocates over what it can value, spends the gate points it
must, and reports the split rather than presenting a full 16-point build as a
recommendation it cannot justify. `bench talents` prints every node, what it
reads as, and why most of it is structure.

## 2026-07-30 - Break ties toward the better item, and say when a slot makes no difference

Reported: a pinned weapon came back Rare, and the offhand came back Rare while
the arsenal came back Legendary. Both were real problems, neither was the maths.

A shield's atbRatio is `{armor: 0.337}` and nothing else, so for a damage goal
every offhand - and no offhand at all - scores byte-identically. The search kept
whichever one a restart happened to seed, and the output presented a coin flip
as a considered choice.

So the comparison is now lexicographic: the objective first, then the total
magnitude of everything the build grants. A Legendary shield beats a Rare one
and both beat an empty slot even when the goal cannot tell them apart, which is
what a player expects and is never worse. And `indifferent` reports the slots
where that happened, so the row is marked "no effect" and the footer says
emptying it scores the same.

Pinning an item with no @rarity now takes the best the slot can reach, matching
the "assume the good version" default that --stars max already applied. Pinning
a weapon should not quietly hand you its weakest roll.

Two corrections to what the tool claims:

  * The arsenal audit line said "a weapon you swap to". You do not swap to it.
    It gives two skills and 40% of its stats and nothing else - no base-attack
    chain, no combo attack. Same behaviour, wrong reason, now stated correctly
    and marked verified rather than assumed.
  * The DemonSigil socket is named as unscoreable and why: each of the 12
    sigils grants one talent, and those talents declare no effect, no affix and
    no status. Priest_Talent_SunHalo carries only `vars.damage: 0.5` and has no
    script at all, so its behaviour lives in game code keyed on the talent being
    present. There is nothing in the data to read.

## 2026-07-30 - Take the target's armour from the world instead of from a constant

Penetration is worthless without knowing what it penetrates, and the default
target was a synthetic thing built out of Armor_ExpectedReduction (0.25). That
constant is softer than anything you actually fight.

Foes turn out to express armour exactly the way the four classes do - as a
target damage REDUCTION, in unit.stats[].specScaling.armorReduction and
.magicReduction. 27 units declare one and 420 resolve one through inheritance,
so the whole ladder is authored:

  W_Assassin 0.20  <  W_Base_Small / D_Base_Small 0.25  <  W_Base 0.30
    <  W_Base_Big / W_Base_Unique / D_Base_Big 0.35  <  W_Base_Elite 0.40
    =  every named boss

Two findings fall out, and both change how you gear:

  * Physical and magical reduction are EQUAL on every real foe. Only the dev
    punching bags split them (0.5/0 and 0/0.5). So ArmorPenetration and
    SpellPenetration are worth the same against everything in the game right
    now - which one you want is decided by your class and your faction, never
    by the fight. The suite asserts this, so a patch that splits them fails by
    name, which is exactly when a gearing tool needs telling.
  * At level 25, 50% penetration is worth +14.3% damage against the constant
    and +25.0% against a 0.40 boss. The old default was understating
    penetration by nearly half against the content anyone gears for.

So --target now names real archetypes (dummy, small, trash, big, dungeon,
elite, boss) or any unit id, and defaults to boss. `bench targets` prints the
ladder, what gets through at 0/25/50% penetration, and where the numbers come
from.

Not modelled and said so: unitType.props.resistance is an affinity-level hook
only Bee uses, and specScaling.playerCount scales boss health with party size.

233 checks.

## 2026-07-30 - Derive the rarity ceiling instead of assuming every slot reaches Legendary

Equipment stops at Rare today while weapons reach Legendary, and the search was
happily dressing a Priest in Legendary armour that cannot drop.

The honest finding first: the CDB does not declare this anywhere. The seven
columns typed on `rarity` are an item's own rarity, conds.minRarity, per-rarity
atbRatio overrides, icons, recipe models, enchant materials and scrap
quantities. lootTable carries no rarity at all, there is no RarityKind custom
type, and WeaponRarityChances_Low is an empty stub holding only a 0-10 level
range. The ceiling is a content decision living in code.

So two derivations stand in for it, and both move on their own:

  * weapon slots take the highest rarity flagged AllowRandomWeaponDrop. That
    flag is the one thing in the database that names the weapon/non-weapon
    split at all - set on Uncommon, Rare, Epic and Legendary, clear on Common -
    and it gives Legendary.
  * every other slot takes the highest rarity actually AUTHORED on a
    stat-bearing item that fits it. Requiring an aptitude stops shop cosmetics
    like Head_Shop, which are Epic and grant nothing, from raising it. That
    gives Rare today and becomes Epic by itself the day a patch authors an Epic
    chest - no code change, and the suite will say so.

`bench rarity` prints both derivations next to the raw table and spells out
what the data does not say, so a patch that moves either is visible rather than
silently absorbed. `--rarity-cap` overrides.

Also fixed a display bug the all-aptitudes rule exposed: GIVES showed only the
first aptitude's rating, so a Kobold Assassin+Cleric spear read as ArmorPen
when it grants ArmorPen AND Crit. It now lists all of them.

226 checks.

## 2026-07-30 - Score the skills, and check the gear model against a character sheet

The Priest optimum was dressing head to toe in Fervor gear, and the reason was
that skills were not being scored at all: only base attacks were, Fervor was
the only multiplier that touched them, and penetration had nothing to act on.
With the rotation modelled the same search picks SpellPenetration across every
slot and Fervor drops to noise.

What was missing:

  * PriestPrayer / MageConduit / RoguePoison / WeaponSubSkill were in no bucket
    at all. Prayer: Smite does 279 damage and was contributing zero.
  * Warrior_Rage_Strike has no cooldown and costs 10 Rage. It was being scored
    as castable every 1.4s, which tripled the Warrior and starved everything
    else of the clock. Resource-gated skills are now named as unmodelled.
  * Rampage declares Hit1/Hit2/Hit3 at 2.5x/4x/6x Strength under
    cond.castHoldStep - mutually exclusive charge levels, and all three were
    being summed.
  * cooldowns could oversubscribe the clock; they are now scaled to fit and the
    output says so.
  * weapon enchants came back empty because their whole value is a stacking
    status named only inside a script. addStatus(owner, Skill.X) is now read -
    the link, nothing else - so Zealot is +6 CritChanceRating x 5 stacks.
  * props.rankOverride now applies, so --rank changes cooldowns.

And the arsenal is not a second main hand: its base-attack chain does not
exist, only two of its skills are slotted, and the weapon passive counts
against those two. Skill selection is a search variable now, and the output
prints what it dropped.

Then a real character sheet arrived, and it corrected two things the static
reading had wrong. Spear_Eruption, Rare/Kobold/[Assassin,Cleric], reads
+36/+18/+15/+39/+39 in the main hand and +15/+8/+6/+16/+16 in the arsenal:

  * every aptitude an item names pays, and they SUM - the model had assumed an
    item resolves to one. Dexterity is Assassin's budget and Faith is Cleric's,
    which is where 18 and 15 come from, and the two aptitudes read the same
    Kobold faction differently, which is where two ratings come from.
  * they pay regardless of your class; your aptitude only gates equipping.
  * each aptitude's share is rounded before the sum: 16 + 20 = 36, not 35.
  * the arsenal factor is ceil(v * 0.4), not a half. round gives 14 and 7,
    floor gives 14/7/15/15. A Rare Corrupted Gift confirms it on authored
    affixes: -20/+20 becomes -8/+8.

All ten values are asserted in the suite, which is now 191 checks. docs/MODEL.md
gains a section for what is checked against the game as opposed to read out of
the bytecode, and --pin item^10 pins an instance level so a reading can be
reproduced.

Fervor's offensive half still lands on no attribute, so --fervor-scope
skills|all|none is a switch rather than a decision baked in, and rarity is
rolled by default now that Epic and Legendary are reachable.

## 2026-07-30 - A gear bench that fills the slots you did not pin

Pick a class, pin whatever you have already decided, and it works out the
rest: every armour slot, both weapons, the offhand, and all ten enchant and
gem sockets.

    bench optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1

The stat engine is read out of the game rather than guessed at. hlboot.dat
ships HashLink bytecode v4 with full debug info, so every formula in
docs/MODEL.md cites the function index and source line it came from:

  * one geometric curve drives every budget in the game
  * rating -> percent ignores the `scale` field sitting next to it, which is
    a 7.5x trap, and there is a test asserting the two are not equal
  * Armor bypasses its authored columns entirely and is the inverse of the
    mitigation formula, so a class's armour is design intent not a number
  * attributes compose as (stored + scaling + flat) * modAdd * modMul, and
    nothing is ever written back - which is why the promoted fields in
    memory read zero for gear-derived stats

Three things the data made non-obvious and the model gets right:

  * faction crosses with class to decide which secondary rating a piece can
    carry, so one row is four different items
  * an item's `aptitudes` column is a set of ALTERNATIVES, not a set it is
    all of at once - summing it paid the shared MaxHealth budget four times
    on the craft necklaces
  * OHWeapon is the only itemType flagged AllowShield, so handedness is a
    data rule: pinning a shield constrains the mainhand, and pinning a
    two-hander plus a shield is refused by name

The search is coordinate ascent with exhaustive per-slot enumeration rather
than stat weights, because the objective is not linear: Faith and Strength
cross over at 35% crit, mitigation is a hyperbola, and a rating point loses
3.8% of its value per level. ~3000 loadouts in under a second, seeded PRNG so
a shared build is re-derivable.

Absolute damage rests on three multipliers read from descriptions rather than
code - Fervor's offensive half, the two masteries, WeaponPower - so `bench
audit` prints them with every result, --no-fervor-damage turns the biggest one
off, and no absolute DPS is claimed. Nothing has been checked against the
running game.

pak.mjs and game.mjs are copied from farever-mods; everything else is new.
