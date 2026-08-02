# Roadmap: finish the model, class by class

The objective: every class covered the way the **Warrior** now is — every point
of damage either scored from a read formula, or refused with a reason a player
can check. This document is the handoff: the method that got the Warrior there,
the exact remaining items, and what "done" means per class.

State at handoff (2026-08-02): 566 checks green; baselines Warrior 512.4,
Rogue 326.0, Mage 340.5, Priest 383.2 (`optimize`, level 25, named boss);
every formula in README's seven-line block is bytecode-read and/or
dummy-measured.

## The method (proven, in order of preference)

1. **Read `data.cdb`** — rows, scripts, vars. Most refusals die here.
2. **Read the compiled code** — `node bin/hl.mjs find/disasm/grep-str`. This is
   how WeaponPower, the 60/40 mix, the fervor+mastery bracket, Spark costs and
   Combo Points were settled. Full debug info: follow the `; L####` source
   lines.
3. **Measure in game** — the user runs 5-minute protocols on the 0-armor dummy:
   naked character sheet, bag-vs-equipped tooltips, single-swing damage,
   stopwatch cadences. Every past measurement reproduced the model to the
   integer once the formula was right; design the protocol so one read
   discriminates between candidate formulas.
4. **Refuse and NAME** what none of the three can price. The honest causes now
   include `foe is passive` (block/hit-driven), kill-driven hooks, and
   stack-gated guards. A refusal without a named reason is a bug.

Discipline: adversarially verify multi-agent findings before acting (one
audit finding in ten was wrong); every change lands with tests in
`test/run.mjs` style; suite + all-four baselines before every commit; commit
messages in the repo's voice with **no AI attribution**; caches must stay
bounded (see "A cache that never evicts is a leak with a hit rate").

## Per-class expansion program

Repeat the Warrior program for **Priest, Rogue, Mage**, in that order (Priest
has the most refusals outstanding):

1. **Walk the talent tree node by node** (the Warrior standard: all 16 spent
   points readable). `bench talents --class X` prints live counts. Extend the
   shared readers when a shape repeats (scoped modifiers, status deps,
   resource gains, cooldown mutations); park what the game truly keys on
   presence alone.
2. **Drain the unscored list.** Run `optimize`, `weapons --across`, and
   `layouts` per class; every `not scored in this build` entry gets a
   data-read, a bytecode-read, or a measurement protocol — or a better reason.
3. **Finish the class resource.**
   - Mage: weapon-skill Spark costs land already; remaining — the finisher's
     10-Spark cost (the chain is not pool-gated in the fight), Foresight's
     free cast (global@17633), chaincast bypass, `Mage_ChronoReset`.
   - Rogue: CP income/spend lands; remaining — the distinct-kind dedup
     (consecutive same skill pays once), M1 crit extra, M2 cap 5, M3 refund 1,
     UrgeToKill (8s→1s finisher CD + 1 CP/s window).
   - Priest: prayer charging is modeled; verify each prayer's rank riders and
     Judgment's rune choices (Alacrity −2s/prayer is a cooldown mutation).
4. **Calibrate once per class in game.** One naked-dummy session each (the
   Warrior protocol): a swing pair, a finisher, one class-mechanic cadence
   (prayer charge rate / spark drain / CP fill). Ask the user; they are fast.

## Cross-class engine items (unblock several classes at once)

- **Stack counter channel** (the biggest named gap): track counts, not just
  up/down, for statuses the fight applies. Unlocks Ram Veil's five-stack
  Benediction economy, DM_Multispin's max-stack reset, Hysteria's hit counter,
  Blessing's empowered-next-N, and the `hasStatusMaxStacked` refusal family.
- **Cooldown mutations, wave 2.** Wave 1 (explicit `resetCooldown(Skill.X)` /
  `reduceCooldown(Skill.X, vars.t)`) is live with deterministic thinning.
  Remaining: the `skill.kind`/`s.kind` dynamic-target family (~15 sites,
  mostly self-reductions per event), `reduceWeaponsCooldown` event sites (6 —
  MUST NOT double-count Red Tempo, which already rides `cdrWeaponSkill`), and
  chance<1 on cooldown-gated procs (the twelve `<Type>_Upgrade` star procs).
- **Proc-applied self-buffs with real uptime** (StoneOfPower shape): wire
  trigger `applies` through the sim with application-thinning; keep the
  enchant path (folded permanent at cap) untouched — high-rate procs saturate,
  low-rate ones must not.
- **"Next cast free/empowered" register**: Surge of Violence (in the default
  Warrior build via sigil, scored zero today), Mage_Blink's Phase Strike.
- **Crit rolling in `--fights` mode**: crits are still expected-value even
  when rolled; the spread on crit-bleed builds reads near zero.
- **Depth Shield orbs** (watcher-status payload: stacks × mean declared step)
  and the pending trinket reads (Trinket_Bee, PrismaticPearl, PurifiedHeart).
  A spawned task exists for these; absorb it.
- **Rotation search**: stack-count and `remains(i)` APL atoms, `rage<=n`,
  memoization; sequencing is worth ~1.7% now and grows with each mechanic
  above.

## Model verification remainder

- **Gear bake full trace** (`generateItemAffixes@20747`): the ÷aptitude-count
  is read; trace the whole loop (gearRatio bounds, round-as-loop-count,
  per-row semantics) and reconcile the two decompositions exactly.
- **Fresh-drop stats** (`--drops scaled` hypothesis): one in-game check — pick
  up any new drop at level 25, read its stat lines vs the authored-level
  prediction.
- **Brutal Frenzy's 0.3-ratio step**: billed per finisher, tooltip says
  15%-per-attack rider; reschedule via the trigger machinery.
- **D7/D8 dummy experiments** (documented in git history): Exsanguination
  crit semantics on bleed ticks; snapshot-vs-live on a non-pool dot.
- **forceMono** (Mono-with-area cleave) — one `bin/hl.mjs grep-str` session.
- **Foe model, optional**: kills (arms Rampage's rank-3 reset and every
  `onKill` hook — a trash-pack mode) and an attacking foe (arms `foe is
  passive` items). Big design; flag-gated if attempted.

## Acceptance criteria ("100% covered")

Per class: (1) `bench talents` shows every spent point readable or
reason-named; (2) `optimize`/`layouts` unscored lists contain ONLY entries
whose kind is `foe is passive`, `crowd control`, `utility`, or a named
kill/live-state gate — nothing left saying `script`, `no rate`, or `script
magnitude` without a read having been attempted and documented; (3) one
in-game calibration session reproduced the class's numbers to display
rounding; (4) suite green, baselines re-recorded, `bench audit` and
`docs/MODEL.md` updated in the same commit as the change they describe.
