# Roadmap: finish the model, class by class

The objective: every class covered the way the **Warrior** now is — every point
of damage either scored from a read formula, or refused with a reason a player
can check. This document is the handoff: the method that got there, the exact
remaining items with the reads already done against them, and what "done" means
per class.

State at handoff (2026-08-02, second pass): **658 checks green**; baselines
Warrior 520.1, Rogue 399.0, Mage 328.5, Priest 385.6 (`optimize`, level 25,
named boss). Unscored lists: Warrior 5, Priest 7, Rogue 6, Mage 6.

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
- **The gear bake traced and reconciled** — see the audit entry; the rewrite is
  named below.
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
