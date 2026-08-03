# The precision plan — SimulationCraft-grade results for Farever

2026-08-03. The strategic layer above `ROADMAP.md` (which holds the live work
order). Target: the confidence SimC earns for WoW — a player pastes a build,
the number that comes out survives contact with a damage meter, and a patch
day costs hours, not weeks. Farever is ~10× simpler than WoW; the bar is
therefore reachable by a small system if the system is honest.

What SimC actually runs on, mapped to what this repo already has:

| SimC pillar | farever-bench analog | state |
|---|---|---|
| automated spell-data extraction | cdb reader + hlboot disassembler (cross-validated against a second implementation) | **done** |
| community log-verification | HLX bench-probe (18 read-only hooks) + pew-pew-meter cross-check | **done, v2 live** |
| action priority lists | rotation search + APL atoms (`buff.X.remains`, `rage<=n`, `cd.X<=n`) | partial |
| stochastic iterations, error bars | deterministic credit accumulators + crit rolling | partial |
| stat weights / scale factors | — | missing |
| fight styles | single 0-armor dummy or one boss archetype | minimal |
| report surface (charts, uptimes, timelines) | text tables | minimal |
| patch-day regeneration | manual re-runs | missing as a pipeline |

The method that got the Warrior to ±1% per-hit is the asset, not any single
formula: **read the data, read the bytecode, measure in game, refuse-and-name
the rest.** Every phase below scales that method, not around it.

---

## Phase 0 — Truth infrastructure that survives patches (the automation bar)

The requirement: a game update costs one login and one command.

1. **`bench update` — the patch pipeline.** Detect a new build (hlboot/cdb
   hash), then in order: re-extract cdb; re-resolve every bytecode citation
   **by name** (the hook-map builder already resolves name→findex; findexes
   drift every patch, names have survived every one so far); regenerate the
   HLX gamelib; rebuild + redeploy bench-probe; print a drift report — new
   skills, changed rows, moved functions, citations that no longer resolve.
   Acceptance: replay an old→new depot pair end to end with zero manual edits.
2. **The def-bake table as a formula tripwire.** First login after any patch
   floods `bench-probe-bakes.csv` with every item def baked by the live game.
   Auto-diff against the stored 636-key table: any stat-formula change is
   detected the day it ships, with the exact rows that moved. This is the
   single highest-leverage automation in the plan — it converts the hardest
   calibration (the bake) into a self-checking oracle.
3. **`bench verify <capture>` — the known-answer diff as a command.** What the
   analysis workflows do by hand today (per-skill rate, per-hit bands, crit
   splits, ledger books, cadence) becomes a first-class command over any
   capture CSV: MATCH/CLOSE/MISS per line with the waterfall. Routine
   calibration stops needing an analyst.
4. **Citation hygiene.** Every formula in `MODEL.md`/audit keeps its
   name-first citation (`$HSkill.getStepEffectVal`, findex as a cache); the
   suite fails if a cited name stops resolving. The 03a56b9 lesson
   (session-coined labels) becomes a lint.

Manual-authoring lane here: none. This phase is pure automation.

## Phase 1 — Warrior to delivery grade

Ship the class the method already conquered. "Delivery grade" defined:
**±3% total, ±5% per-skill against an instrumented capture, on three
independent builds, with a stated confidence interval** — i.e. within the
meter's own noise floor at 75s.

1. **Close the residual family** (each has its measured target in
   `GROUND-TRUTH.md`): the +3–8pp hot-crit source (the Raclette ramp is
   already logged in `status_stacks` rows — measure, don't hypothesize); the
   Strength-shaped sheet surplus; SurgingForce's ~+20%/2s self-window;
   hero-side quantization polarity; the Hemorrhage influx/twin-ledger tail.
2. **Fix the rotation search's relative prices.** The Rampage lesson: the
   search is *rational at model prices* and the prices were wrong. Opportunity
   cost must bill actual per-link chain time (landed), Rage/finisher/crit
   income forfeited (landed for bleed, generalize), and launch-time snapshots.
   Then re-audit every "the sim never casts X" against the meter.
3. **Stochastic mode.** Keep the deterministic engine for search (it is why
   optimize is fast); add `--iterations N --seed S` for delivery numbers:
   rolled crits/procs/bands, report mean ± CI, distribution vs meter variance.
   A build whose CI does not contain the meter reading is a defect, by
   definition, every time.
4. **Fight styles.** Author (manual lane, explicitly worth it): `dummy`,
   `boss` (Ratsar-class mitigation), `cleave2` (the two-dummy protocol that
   cracked the Hemorrhage ledger), `adds` (periodic waves), `execute`
   (sub-30% phase for Execution-family talents), `movement` (forced gaps).
   SimC's fight styles are hand-authored; that is the right call here too.
5. **Default Warrior APL, authored and versioned.** The optimizer finds
   rotations; the *product* also ships a curated, human-readable priority
   list per weapon family, verified against captures. Manual lane, high value.
6. **The last Warrior asks** (one short session each, protocols written):
   the banked-chain n=0 trial, SurgingForce spam at fixed Devote, repeated
   Battle Shout windows, one `DamageModifier ≠ 100` capture.

## Phase 2 — Every class to the same bar

Order: Priest → Rogue → Mage per the standing program, unless the user
reorders. Per class, the recipe is now mechanical:

1. **Data+bytecode pass**: walk the talent tree to 100% read-or-refused-with-
   true-reason; read every weapon-skill script (the punctuation lessons —
   optional chaining, two-arg calls, rank-as-build-question — are landed
   readers now, so most refusals die cheap).
2. **Resource ledger, closed by one capture.** The probe already stamps
   `rage=`/`spark=` on every press row; extend to Combo Points and Priest's
   resource. One 2-minute instrumented dummy session per class hands over the
   complete income ledger — the Warrior's Rage books closed in exactly one.
   Known first targets: Mage's missing income family (time regen, Infusion —
   refused as "nothing declared", almost certainly script-side income),
   Rogue CP riders, Priest's heal/damage split scoring.
3. **Proc engine generalization.** ICDs, stack-release ultimates (the Anger
   Release shape), conduit-style gauges, on-crit feeds — all four exist for
   Warrior/Mage already; promote them from per-skill code to a shared engine
   with authored parameters.
4. **Default APL + fight-style verification** as in Phase 1.
5. **Acceptance identical to Warrior's**: ±3%/±5%/CI against an instrumented
   capture on three builds.

## Phase 3 — The product surface

What makes SimC *used*, not just correct:

1. **Import everything.** questlog.gg URLs (works today; finish per-skill
   arsenal ranks and class-bar skills — both flagged by the importer's own
   warnings), the modkit's inventory dumps (own characters, "best upgrade
   from what I own"), and manual loadout files.
2. **Reports people can read.** One HTML report per run: dps waterfall,
   per-skill table with crit splits, buff/debuff uptime bars, resource
   timeline, and the audit trail (what was refused and why — the honesty
   surface is a feature, not an apology).
3. **Stat weights / scale factors.** Finite-difference weights per sheet stat
   at the build point, with CI; the single most-requested SimC artifact.
4. **Sweeps as products**: the layouts command (exists, resumable) plus
   talent-tree sweeps and upgrade-priority lists, all writing progressive
   result files.
5. **The comparison harness**: `bench compare buildA buildB` with
   significance, so "is X an upgrade" has an answer with error bars.

---

## Standing rules (they are why the numbers are trusted)

- **Refuse-and-name survives every phase.** A number the model cannot derive
  is named, never fitted. The coverage list is a product surface.
- **Every mechanism claim carries a citation** — a cdb row, a `name@findex`,
  or a capture file. "The data says" beats "the meter suggests" beats "it
  feels right", in that order, and disagreement between tiers is always a
  work item.
- **Manual authoring is welcome where it multiplies quality** — APLs, fight
  styles, protocol design, naming maps — and unwelcome where automation is
  honest — formulas, item stats, proc rates, resource income.
- **The instrumentation loop is the moat.** SimC needed a decade of community
  logs; this project verifies against the game's own computation in an
  afternoon. Guard it: read-only hooks, no Skip, rebuild-per-patch in the
  update pipeline.

## Sequencing and the definition of done

0. Phase 0 items 2–3 first (they accelerate everything after); item 1 lands
   before the next game patch or the first one after.
1. Warrior delivery next — it is closest, and every engine feature it forces
   (stochastic mode, fight styles, proc engine) is class-agnostic by
   construction.
2. Classes in program order, each a repetition of a now-mechanical recipe.
3. Product surface grows alongside, questlog + verify first.

**Done means:** a player pastes a questlog URL; bench prints a number with a
confidence interval; the meter lands inside it; a patch ships and `bench
update` reports the drift the same day; and for all four classes the coverage
list explains, in named reasons, everything the number excludes.
