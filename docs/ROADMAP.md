# Roadmap: finish the model, class by class

The objective: every class covered the way the **Warrior** now is — every point
of damage either scored from a read formula, or refused with a reason a player
can check. This document is the handoff: the method that got there, the exact
remaining items with the reads already done against them, and what "done" means
per class.

State at handoff (2026-08-02, second pass): **664 checks green**; baselines
Warrior 438.2, Rogue 358.1, Mage 238.7, Priest 296.3 (`optimize`, level 25,
named boss). Unscored lists: Warrior 5, Priest 7, Rogue 6, Mage 6.

## READ FIRST: docs/GROUND-TRUTH.md

An instrumented capture (4,916 logged damage events, 88s dummy session) now
supersedes several things below and settles others. **Landed from it so far:**
the swing floor is retired — 12 uninterrupted cycles measure 1903ms against the
model's floored 2850ms, a ratio of 1.498, and the authored durations were right
all along.

**Still open from that document, each with a measured target — this is the live
work list, ahead of everything in the older sections:**

1. **Crit conversion — CLOSED.** Never the rating conversion, which reproduces
   the game to five digits. Two permanent +5 CritChance rows were dropped:
   Bloodrage Aura's status (`3a99d83`) and `Axe_Boomerang_Combo`'s own affix
   (`a43c2a6`). Captured build 19.62% → 29.62% against a measured 27.8–28.8%.
2. **Three refused script riders all fire in game** — the combo's +20% vs a
   bleeding target (dmgMult, not critDmgMult: the clean 1.5325 crit ratio proves
   which), Bonethrow's rank-3 +20% critDmgMult, and Domination against the stun
   window, because **the training dummy IS stunnable**. Riderless numbers run
   −13.7% to −17.5%. Policy to adopt: publish rider-on conditioned on status
   uptime rather than refusing.
3. **ComboWindow — DISPUTED, and the dispute is UNVERIFIED.** A read claims
   there is no banked finisher at all: `Hero.update@7495` /
   `isWithinAttackCombo@7459` run the clock from the END of the last basic
   attack to the START of the next, so casts, idle and runs of short casts all
   break the chain by the same rule — and the model's per-cast test misses that
   two 0.4s Rage Strikes break it in game. That would make the t=47.6→55.0s
   sequence an artefact of swings that landed no damage row rather than a banked
   link. Its skeptic died before checking it (spend limit), so **verify before
   acting**, and do not implement a banked-chain concept on this evidence.
4. **Rage Strike crits 56.3%** (9/16). Surge of Violence is live — the head
   sigil grants it, see GROUND-TRUTH's correction — but being one-shot it covers
   at most 5 of the 9; four crits land on casts with no combo finisher since the
   previous Rage Strike, and that subset still crits 4/10. Open. Separately its
   damage is ×1.1025 short at current HEAD, which the CritDamage anchor says is
   NOT a Strength error.
5. **Berserk is authored at exactly 0.20** in both the cdb row and the compiled
   script — do NOT retune it to 0.185. What is real is that the game composes
   dmgMult riders ADDITIVELY (`computeDamage@4841` seeds `modMult` from
   `hitData.dmgMult`, and every rider is `+=` into that one scalar) while the
   model compounds them: `runeDamage` at `m *= 1 + rd.amount`, then
   `damageByAffinity`, then `basicAttack`, on separate lines. Two +20% riders
   should give ×1.40, not ×1.44. Fix the bracket; carry the 1.25% residual as an
   open anomaly.
6. **Bleed tick ratio — CLOSED, measurement-side.** `ceil(round(0.100 × H) / 4)`
   reproduces 0.1023–0.1028 on its own, because the log ceils like the display.
   The model's 0.100 is the correct real-damage coefficient. Retire the
   Fervor-applied-twice hypothesis; what needs fixing is the COMPARISON, which
   must quantise the same way the engine does before differencing.
7. **The bake's live residuals, RECHECKED at current HEAD.** Rebuilt from the
   capture's own inventory dump. CritDamage (⇒ Strength+Intellect, the tightest
   anchor — three band-less skills agreeing to 0.3%) went +0.24% → **−0.02%**;
   Armor −10.5% → **−4.3%**. What is left is a UNIFORM ~−6.9% across combo,
   Bonethrow and Rampage — three different attribute mixes on two weapons, short
   by the same factor — which is a missing multiplier, not a stat error.
   `PhysicalMastery` reads 0.00 and shares an additive bracket with Fervor.
   Probe: `scratchpad/recheck-bake.mjs`.

Also confirmed correct and needing no work: the ±10% band (and the log ceils like
the display), the crit multiplier to 0.3%, the whole Hemorrhage ledger, status
ticks never critting (0/98), and full-charge Rampage as the standing assumption.
Bonethrow's 269ms pairs are cleave, not a return hit — retire that hypothesis.

## The method (proven, in order of preference)

1. **Read `data.cdb`** — rows, scripts, vars. Most refusals die here.
2. **Read the compiled code** — `node bin/hl.mjs find/disasm/grep-str`. This is
   how WeaponPower, the 60/40 mix, the fervor+mastery bracket, Spark costs,
   Combo Points, `on: Code`, `getStackFactor` and `areaHit` were settled. Full
   debug info: follow the `; L####` source lines.
3. **Measure in game** — the user runs 5-minute protocols on the 0-armor dummy:
   naked character sheet, bag-vs-equipped tooltips, single-swing damage,
   stopwatch cadences. Every past measurement reproduced the model to the
   integer once the formula was right; design the protocol so one read
   discriminates between candidate formulas.
4. **Refuse and NAME** what none of the three can price. A refusal without a
   named reason is a bug — and so is a refusal whose reason is *false*. Four of
   them were: a Rogue's Combo Points were called "a pool nothing declares income
   for", a shield was called "a status that declares nothing readable", and two
   Mage talents were called "no effect anywhere in the row" while `bench talents`
   printed a damage effect for them on the same build. Check the sentence, not
   just the zero.

Discipline: adversarially verify multi-agent findings before acting — this pass
ran a verifier over every read and it caught a hook name that does not exist
(`onStatusApply`; the real one is `onInflictStatusEval`), four stale line cites,
a memo-key hazard, and a tick schedule driven by `Refresh` rather than `Start`.
Roughly one claim in six needed correcting. Every change lands with tests in
`test/run.mjs` style; suite + all-four baselines before every commit; commit
messages in the repo's voice with **no AI attribution**; caches must stay bounded
(see "A cache that never evicts is a leak with a hit rate").

## What landed in this pass

- **Crit rolls in `--fights`.** A cast decomposes as `fixed + base × (1+p(cd−1))`
  because crit chance and multiplier are properties of the *skill*; rolling *k*
  of *n* hits has the deterministic value as its binomial mean. Pool feeds follow
  the same die. Spread on a crit corner went 0.2% → 2.5%; the answer did not move.
- **Three new rotation atoms and a memo.** `buff.X.remains>=n`, `rage<=n`,
  `cd.X<=n`, with thresholds drawn from the build's own cast occupancies. 43% of
  a search was re-simulating lists it had already played. Searched-over-derived
  went +0.5% → +2.2%.
- **`on: Code` steps are not part of the cast.** 158 steps declare it, 72 carry
  a real amount, and all of them were billed on their skill's cast. Brutal
  Frenzy's finisher now prices the measured 133 instead of 161, and its 0.3 step
  rides a 15% base-attack roll. Refusing `Halos_Demon_Skill2`'s leash damage (the
  foe must walk out) freed the Mage search onto an arsenal worth 24 dps more.
- **The stack counter, damage side.** `getStackFactor@20772` multiplies a DoT
  tick by the live stack count. Five stacks of Lethal Poison were priced as one.
- **`Mono` never cleaves** — settled at the opcode level, promoted from
  `unmodelled` to `verified`, with a patch tripwire on `props.hitCount`.
- **The gear bake, LANDED.** Gear ratio, the aptitude divisor, the item's own
  armour mean, and a drop at your level rather than the authored row level. Three
  measured tooltips and twelve integers, all exact, with the naked control
  untouched. It was the largest error in the tool and it moved every baseline by
  20–30%.
- **Proc-applied buffs that block their own renewal.** `!owner.hasStatus(<the
  status this very call applies>)` is a readable self-block, not live state. The
  four trinket Stones went from scoring zero to scoring, at `rD/(1+rD)` rather
  than at the cap.
- **The conduit gauge, read and then measured.** Conduits fire when Spark is
  spent from above half of MaxSpark, all together. Measured in game both ways —
  five stacks when starved, twenty when fed — which confirmed the rule to the
  integer *and* retired a permanent +10 MagicMastery the Mage had been carrying.

## Per-class expansion program

Repeat the Warrior program for **Priest, Rogue, Mage**, in that order (Priest
has the most refusals outstanding):

1. **Walk the talent tree node by node** (the Warrior standard: all 16 spent
   points readable). `bench talents --class X` prints live counts. Extend the
   shared readers when a shape repeats (scoped modifiers, status deps, resource
   gains, cooldown mutations); park what the game truly keys on presence alone.
2. **Drain the unscored list.** Run `optimize`, `weapons --across`, and
   `layouts` per class; every `not scored in this build` entry gets a data-read,
   a bytecode-read, or a measurement protocol — or a better reason.
3. **Finish the class resource.**
   - Mage: the conduit gauge and the finisher's flat 10 Spark have landed.
     Remaining — base Spark regen as time income (0.005 × MaxSpark × 1.3 per
     second on a 3s tick, plus the talent income: Infinite Resources +3/2s,
     Conduit Residues 25% × 5 per trigger, Prodigious Mind, Spark Flask),
     Foresight's free cast, the chaincast bypass and `Reverberate`'s second
     forced volley, and `Mage_ChronoReset`. And `Conduit: Power`'s mean stack
     count, which waits on the stack counter's affix side.
   - Rogue: CP income/spend lands; remaining — the distinct-kind dedup
     (consecutive same skill pays once), M1 crit extra, M2 cap 5, M3 refund 1,
     UrgeToKill (8s→1s finisher CD + 1 CP/s window).
   - Priest: prayer charging is modelled; verify each prayer's rank riders and
     Judgment's rune choices (Alacrity −2s/prayer is a cooldown mutation).
4. **Calibrate once per class in game.** One naked-dummy session each — the
   protocols are written out at the bottom of this file.

## Cross-class engine items, with the reads already done

- **Stack counter, affix side.** `applyAffixes@6083` multiplies every affix by
  `getAffixMultiplier() = stacks`; a stat buff is still counted at its cap. Three
  call shapes consume `stacks`, not one — `applyAffix` in engine.mjs, the local
  `put` inside the memoised `restat`, and `talents.mjs`'s weighing loop — and one
  of them is a **cache key** (`b.status + '#' + b.stacks`), so a fractional mean
  must be quantised before it goes in or a bounded cache of integer states
  becomes an unbounded one of float states.
- **Proc-applied self-buffs — LANDED for the blocked shape, remainder below.**
  The four Stones now score at `rD/(1+rD)`. What is left: **PrismaticPearl**,
  which is not a proc at all but a deterministic `onUpdate` clock alternating two
  statuses every `vars.time` seconds — ~100% uptime of exactly one of them,
  needing its own case rather than thinning; and the **event rate**, currently
  estimated from the rotation's swing cadence when the real trigger is
  `onInflictDamage`, which fires per damage instance *including your own dot
  ticks*, so the present number is a floor. Two closed forms, both Monte-Carlo
  checked:
  - *blocked-while-up* (Stones, Pearl): `uptime = rD/(1+rD)` — 34% to 72%, never
    saturating. On a fixed cadence *T* with per-event probability *p*:
    `D / (D + T(1/p − 1/2))`.
  - *refresh-and-add-a-stack* (everything else): `q = 1 − e^(−rD)`,
    `uptime = q`, `mean stacks = q(1−q^S)/(1−q)`.
  `Enchant_Zealot` and `Enchant_Devote` must stay frozen at the cap — gate on
  those two status ids or on `item.type === 'AugmentEnchantWeapon'`, **not** on
  "chance < 1" (catches `Staff_SummonDemon_Combo_R3_Buff`) or "is a Passive"
  (catches the Stones). The measured cost of leaving them frozen: <1% in a
  filler-heavy fight, ~40% at a 25% swing clock.
  Two traps: `isBaseAttack` **includes** the combo finisher
  (`BaseSkill.isBaseAttack@6046`), which the model's `attack` bucket does not —
  a 25% under-count that is invisible at uptime 1 and immediate under thinning;
  and `onInflictDamage` fires per damage instance **including your own dot
  ticks**, so a bleed Warrior's proc rate is far above its swing rate.
- **Cooldown mutations, wave 2.** The dynamic-target family is **26 sites in 20
  rows**, not ~15: `skill.kind`, bare `kind` and no-arg `resetCooldown()` all
  resolve to the script's own skill id, so every one is a pure self-mutation;
  `s.kind` is the loop variable of `forAllWeaponSkills`/`forAllClassSkills` and
  is the only broadcast form. `reduceWeaponsCooldown` has **8** sites and the
  model credits exactly one (`Warrior_RedTempo`, verified by running
  `talents.modifiersOf`) because that reader only runs over talent rows. And the
  "cooldown-gated star procs" premise is **wrong**: none of the twenty
  `<Type>_Upgrade` rows has a cooldown and none uses the ICD idiom, so their rate
  is plain linear Bernoulli — and only seven of the twelve scripted rows carry a
  `checkProba` at all (`Thrown_Upgrade`'s var named `chance` is an additive crit
  bonus, not a roll). Bonus finding that contradicts current behaviour: the
  `<Type>_Upgrade` skill's rank is the weapon's **rarity index** and it does not
  attach below 3 upgrade levels.
- **"Next cast free/empowered" register.** One shape, four realisations: a
  damage multiplier on the cast's SkillContext, a forced crit on the HitData, a
  cost waiver via `evalCost`, and a cooldown/cast-time waiver.
  `Warrior_Talent_SurgeOfViolence` is a cost waiver **and** a forced crit on the
  next `Warrior_Rage_Strike`, armed at 25% per landed AttackCombo;
  `Mage_Blink_Mastery3` (Phase Strike) is `+0.15` into `ctx.dmgMult` on the next
  `WeaponSkill`, armed once per Blink. Neither status declares a duration, so
  both are infinite — pure booleans that persist until spent, which is exactly
  why `arm rate × multiplier` over-counts and a register is needed. 31 further
  sites censused. `Warrior_BurstOfAnger` is authored WIP with zero steps and no
  reader anywhere: inert, not unmodelled.
- **Depth Shield orbs.** `Shield_OrbitWater_S1` has zero declared steps; pressing
  it runs `onProc`, which wipes and re-fills a watcher status to its stack cap.
  The payload is a **declared step** (0.55×Faith damage / 0.30×Faith heal), not a
  script dynVal; the only scripted quantity is a rank-3 `ctx.dmgMult += 1` on the
  final orb. Charges 3 (rank 1) / 4 (rank ≥2), one per pulse. Total per cast =
  `(N + [rank≥3]) × 0.55 × Faith` on a 15s cooldown.
  Of the 13 trinkets: 2 fully scored, 1 scored-but-inert, 2 correctly refused
  (foe passive), and **8 refused for causes that are mostly fixable** — five of
  those (four Stones + PrismaticPearl) only because of the `hasStatus`
  self-block above, and all five are exactly computable. `Trinket_Demon`'s DoT is
  fully authored and worth 0 today. `Trinket_Bee` is genuinely blocked (summoned
  pet AI cadence). `PurifiedHeart` is blocked by a magic-crit trigger **and is
  flagged `Bug` by the authors on all three of its rows**.
- **The conduit gauge** — the missing rate behind three Mage refusals. Every
  equipped conduit fires *together* when the Spark gauge crosses its threshold;
  `Reverberate` forces a second full volley 0.4s after a Chaincast consumption,
  and both ignore the 50% threshold. Conduit damage is a **sum over equipped
  conduits**, not one of them.
- **Rotation search: stack-count atoms.** `buff.X.stacks>=n` waits on the affix
  side of the stack counter landing, or the atom gates on a number the damage
  does not respect. Note also that the vocabulary currently mints atoms the fight
  can never satisfy — a DoT's status is offered as a `debuff.X.up` although the
  dot table is not exposed to the policy at all, and a non-timed buff is offered
  although `setUp` will never put it up. Fix that first; every new atom family
  multiplies against the same defect.

## Measured 2026-08-02: three character sheets and a damage meter

A level-25 Warrior, 0-armour dummy. These are the numbers the gear-bake rewrite
has to land against, and the first one already retired a hypothesis.

**(0) COMPLETELY NAKED — the control, and it is exact.** All sixteen attributes
match to the displayed digit: Vitality 38, Strength 34, Dexterity/Faith/Intellect
28, CritChance 5.8%, Critical Bonus 151.2%, ArPen/MPen/Fervor/Block/both
Masteries 0, Dodge 0.3%, MaxHealth 114, HealthRegen 1.1. So the attribute curve,
the rating→percent conversion, the health pool and the crit derivation are all
right, and **every error below enters through the ITEM stat bake** — it grows
with the number of items worn and with nothing else. That is the whole
justification for doing the bake rewrite next rather than hunting elsewhere.

**(1) Naked + GS_Nova, Rare 0★.** The swing formula is CONFIRMED EXACT and needs
no change: the model predicts a `GS_Base_Attack` band of **94–115** and the
measured hits are **94–113**, matching the weapon's own written damage line.
`GS_Base_Attack` authors `0.95 × WeaponPower`, and although the in-game tooltip
renders that as "95% Strength", reading it literally predicts 76 and is wrong —
the flat belongs in the term. A rival hypothesis fitted from the geared meter
alone (flat = the FULL primary budget rather than 0.4 × it) predicted 174 here
and is dead. **Do not re-open this without a naked read.**

The same sheet exposes the bake, though, at 5–9% per line:

| | game | model |
|---|---|---|
| Strength | 59 | 61 |
| Vitality | 70 | 73 |
| Dex / Faith / Int | 28 / 28 / 28 | 28 / 28 / 28 ✓ |
| Critical Bonus | 151.7% | 151.8% ✓ |
| Critical Chance | 9.4% | 8.8% |
| Max Health | 210 | 219 |

The weapon's tooltip reads +32 Vitality / +25 Strength / +69 Critical; the model
reads +35 / +27 and slightly low on crit.

**(2) Fully geared** (the build in `.scratch/_meterbuild.mjs`). **CAVEAT, and it
is load-bearing: the GS_Nova instance in this reading is NOT the one in (1).**
"Martyr of Enripit" is the only GreatSword row in the game, so both readings are
that item — but at different rarity/stars/drop level, and the geared instance is
not yet identified. Until it is, the ATTRIBUTE rows below cannot be used to fit
the bake, because the weapon's own contribution is unknown. Fit against (0) and
(1), which are fully specified, and use this only as a confirmation afterwards.

Strength lands to one point — 173 against 174 — but that was computed with the
weapon ASSUMED Legendary 5★, which is circular: the same assumption that makes
Strength match is the one the bake error would hide in. What is safe to read here
is the shape rather than the size, because these three miss identically across
every weapon rarity and star count tried, so none of them is the weapon:

| | game | model |
|---|---|---|
| Dexterity | 32 | **45** |
| Faith | 32 | **28** |
| Armor | 1,949 | **1,576** |
| Fervor | 20.2% | 18.0% |
| Critical Chance | 20.8% | 23.2% |

Dexterity is 28 naked plus 4 from the two Honed augments, so the game pays
`Waist_RCrimson_FigAss`'s **Assassin half nothing** while the model pays it +13.
Faith is 28 plus 4 the model pays nothing for, most likely the three
Fervor-aptitude jewellery pieces. That is in direct tension with the audit's
verified "an item pays EVERY aptitude it names" — which was measured on a
**weapon** (Cheese Moon), never on armour or on jewellery. Armour may simply not
follow the same rule.

**(3) The damage meter**, 75s, same build: **703 dps**, 53k total, 127 hits, 24%
crit. Per-line totals are in the table in `.scratch/_meterbuild.mjs`. Two things
it settles on its own: `GS Base Attack`'s **max hit was 604**, which no crit on
the top of the model's ±10% band can reach (~429), so the geared swing really is
too small; and **Anger Release fired twice**, which the model scores at zero.

## The gear bake: LANDED 2026-08-02

Three terms were missing and they only reconcile **together** — each alone makes
the other two look wrong, which is why a first attempt at the gear ratio by
itself was implemented and reverted.

1. **Gear ratio.** The level curve runs a second time on
   `GearStatsRatio_Scaling_Bounds` (0.5 → 0.9) and multiplies every row not
   flagged `gearOnly`. Armour and the ratings *are* `gearOnly`, which is what
   lets them pin an item's level independently of the term under test.
2. **The aptitude divisor.** Every row is divided by the number of aptitudes the
   ITEM names. A dual-aptitude item pays a shared line ONCE at the mean; what the
   second aptitude buys is its own primary. The model summed them and read
   **double** on every dual-aptitude item in the game.
3. **Armour takes the ITEM's aptitude mean**, not the wearer's. A Fighter+Cleric
   belt reads 158 Armor on a Warrior — 0.325, where the Warrior's own 0.4 would
   read 219.

Plus the level: an item's stats follow **a drop at your level**, not its authored
row level. The Cheese Moon is photographed as "Axe Level 25" with three stars,
iLevel 290 — the level the old tests pinned at 10 was never read off a tooltip,
it was the level at which the two missing terms happened to cancel.

Measured against one level-25 Warrior in four equip states, three items, twelve
integers, **all exact**, with the naked control still exact on all sixteen
attributes:

| item | aptitudes | measured |
|---|---|---|
| GS_Nova, Rare 0★ | 1 | +25 Str, +32 Vit, +69 Crit |
| Waist_RDemon_FigCle | 2 | +4 Str, +4 Faith, +8 Vit, 158 Armor |
| Axe_Boomerang, Rare 3★ | 2 | +36 Vit, +15 Str, +18 Dex, +39 Crit, +39 ArPen |

On the fully geared character the sheet went from Vitality 226 / Armor 1576 to
the measured **213 / 1949**, and Dexterity and Faith land exactly once the waist
is specified correctly. Baselines fell accordingly: Warrior 539.5 → 438.2,
Rogue 399.0 → 306.7, Mage 328.5 → 223.0, Priest 385.6 → 296.3.

**Still open from the same trace:** the Uncommon `statGroup` rules — Vitality is
dropped off a dual-aptitude Uncommon and Primary off a single-aptitude one — which
no measurement here touches.

## Historical: why half of it must not land

**`gearRatio` is real, and it is measured.** `generateItemAffixes@20747` runs the
level curve a SECOND time on `GearStatsRatio_Scaling_Bounds` (0.5 → 0.9) and
multiplies every row that is not flagged `gearOnly` by the result. Four
independent derivations of the function — one reading the disassembly top-down,
one working backwards from the measurement, one focused on rounding position, one
on the level and ratio terms — all reproduced the tooltip of a level-25 Rare
0★ GS_Nova to the integer:

| | model @ L21 | @ L26 | × gearRatio(26) = 0.6749 | tooltip |
|---|---|---|---|---|
| Strength | 27 | 37 | 24.97 → **25** | **25** |
| Vitality | 35 | 47 | 31.72 → **32** | **32** |
| CritChanceRating | 57 | **69** | *gearOnly, skipped* | **69** |

Two separate errors, and they partly cancel on the attributes while not
cancelling at all on the rating — which is why the model looked only 9% off.
The level is one: the model evaluates the item at its AUTHORED row level (20 →
iLevel 210 → L 21) where the instance is a level-25 drop (iLevel 260 → L 26).
`--drops scaled` already computes exactly that, so the default is wrong, not the
code.

**But landing gearRatio ALONE was tried and reverted, and it must not be tried
again on its own.** It breaks twelve measured assertions — the Spear_Eruption and
Cheese Moon tooltips — and no instance level rescues them:

| Spear_Eruption, instance level | Vit / Dex / Faith | Crit / ArPen |
|---|---|---|
| 10 (what the model infers today) | 20 / 10 / 9 | **39 / 39 ✓** |
| 18 | **35 / 18 / 15 ✓** | 53 / 53 |
| tooltip | 36 / 18 / 15 | 39 / 39 |

The attributes and the ratings want different levels, so a single level plus
gearRatio cannot satisfy both. The `gearOnly` flags are uniform across every
aptitude (Primary and Vitality false, Armor and Ratings true), so it is not a
per-item difference either.

**THE FULL SEARCH, and it does not close.** The four ambiguous choices were
implemented switchable and swept against all three tooltips at once
(`.scratch/_bakefit.mjs`):

| group | gearRatio | divisor | GS_Nova (single apt) | Spear (dual) | Cheese Moon (dual) |
|---|---|---|---|---|---|
| mean | **true** | false | **EXACT** | err 30 | err 30 |
| row | false | false | err 27 | **EXACT** | **EXACT** |
| either | true | true | EXACT | err 90 | err 50 |
| mean | false | false | err 27 | err 1 | err 1 |

No combination satisfies all three. Two things ARE settled by the sweep: the
divisor must be OFF (the bytecode's per-row re-add cancels it exactly, and
turning it on makes every dual case three times worse), and `mean` versus
per-row grouping is worth at most one point, so it is not the discriminator.

The remaining conflict cannot be traded against level either, because **each
item pins its own level through its `gearOnly` ratings row**, which gearRatio
never touches: GS_Nova's Critical of 69 forces L = 26, the Spear's 39/39 forces
L = 11, and at exactly those levels the attributes want x0.675 and x1.0. With
gearRatio on, the dual items land on exactly 0.5617x their tooltips — which is
`gearRatio(11)` to four figures, so the term is being applied and is simply not
wanted there.

So one of the two measurement families is not what it is assumed to be. The
GS_Nova reading is the stronger of the two: it is fresh, and it comes with a
naked control, a full character sheet, the item tooltip and a damage meter that
all agree. The Spear and Cheese Moon readings are older, and what they actually
pin is the tooltip integers — their *instance level* was inferred by the very
model now in question, which makes them circular in precisely the way the geared
sheet was.

**THE DISCRIMINATING MEASUREMENT, and it is one tooltip:** equip any
DUAL-APTITUDE item at a known level and read its stat lines. If a dual item at a
known level shows gearRatio applied, the old Spear/Cheese Moon level attributions
are wrong and gearRatio lands globally. If it does not, aptitude count really
does change the rule and the bake needs a branch. Until then, nothing lands.

**What separates the two cases is the APTITUDE COUNT.** GS_Nova is single
(Fighter); Spear_Eruption and Cheese Moon are dual. The bytecode GROUPS the
surviving rows by `endAtb`, takes the arithmetic MEAN of `start`/`end` across the
group, evaluates the curve once, and divides by `item.aptitudes.length` — then
re-adds that one amount once per row. The model instead sums a separately-rounded
budget per aptitude. On a single-aptitude item the two agree and gearRatio is the
only difference; on a dual-aptitude item they differ by a factor that gearRatio
then compounds. So **the grouping, the mean, the aptitude divisor and gearRatio
have to land in one change**, validated against all three tooltips at once, or
each half makes the other look wrong.

## Model verification remainder

- **Gear bake REWRITE** (not a read — the read is done, in the audit). Landing it
  moves every stat in the tool, so it needs the ten measured tooltip integers
  re-verified against the new decomposition in the same change. Three gaps it
  closes: the Uncommon `statGroup` rules, Armor's reduction term taking the
  ITEM's aptitude mean rather than the wearer's, and `gearRatio` entirely absent.
- **Fresh-drop stats** (`--drops scaled` hypothesis): one in-game check — pick
  up any new drop at level 25, read its stat lines vs the authored-level
  prediction.
- **D7/D8 dummy experiments** (documented in git history): Exsanguination crit
  semantics on bleed ticks; snapshot-vs-live on a non-pool dot.
- **Foe model, optional**: kills (arms Rampage's rank-3 reset and every `onKill`
  hook — a trash-pack mode) and an attacking foe (arms `foe is passive` items,
  which is now the *largest* named refusal family). Big design; flag-gated if
  attempted.

## The in-game protocols, written out

Each is one session on the 0-armor dummy. Design note: every one of these is
built so a single reading discriminates between candidate formulas.

1. ~~**Mage conduit gauge.**~~ **DONE, 2026-08-02.** The trigger rule turned out
   to be fully readable (`Mage_Conduit_SparkBounds`), so only the buff needed a
   reading. Result: `+0.5%` MagicMastery a stack, cap **20** (`+10%`), and the
   five-stack ceiling that first showed up was the *gauge*, not the cap — the
   row's `maxStacks: 20` and `duration: 15` are both correct, and a claim that
   the row authored neither is retired. The measurement's real value was the
   second half: it proved the model had been standing at a cap the fight cannot
   reach, worth 13% of the class.
2. **Censer's Hidden Power absorption (5 min).** (i) Enter combat and stand
   still 60s: count the clouds (expect 20 at one per 3s) and confirm the stack
   counter stays at 0 — that proves absorption is positional. (ii) Play normally
   for 120s walking into every cloud and stopwatch from combat start to the
   prompt lighting up; that number *is* the absorption fraction,
   `f = 30 / seconds`. (iii) Cast it and read the damage integer — it should be
   `ceil(3 × (Faith + Intellect) × your brackets)`, which also confirms the
   rank-2 full magic-armour ignore.
3. **Blessing's rank-3 crit rider (2 min).** `Mace_Benediction_Passive_Status`
   adds `sourceSkill.vars.chance = 0.7` on empowered base attacks at rank 3. If
   `hit.critChance` is a 0..1 fraction — which `Rogue_Talent_DeadlyPoison`'s
   "2% per stack" tooltip implies — that is **+70 percentage points** on two or
   three base attacks per weapon-skill cast, which is enormous. Swing 20 empowered
   base attacks and count the crits.
4. **Fresh-drop stats (1 min).** Pick up any drop at level 25 and read its stat
   lines. If they match the authored-level prediction the current model stands;
   if they match your level, `--drops scaled` becomes the default.
5. **Per-class calibration (5 min each, the Warrior protocol).** A swing pair, a
   finisher, and one class-mechanic cadence — prayer charge rate for the Priest,
   Spark drain for the Mage, Combo Point fill for the Rogue.

## Acceptance criteria ("100% covered")

Per class: (1) `bench talents` shows every spent point readable or
reason-named; (2) `optimize`/`layouts` unscored lists contain ONLY entries whose
kind is `foe is passive`, `crowd control`, `utility`, or a named
kill/live-state/fight-model gate — nothing left saying `script`, `no rate`, or
`script magnitude` without a read having been attempted and documented, and
nothing left whose stated reason is false; (3) one in-game calibration session
reproduced the class's numbers to display rounding; (4) suite green, baselines
re-recorded, `bench audit` and `docs/MODEL.md` updated in the same commit as the
change they describe.
