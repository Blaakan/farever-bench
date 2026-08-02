# Ground truth, measured live — 2026-08-02

An HLX instrumentation mod (`D:/Gits/farever-hlx`, read-only postfix hooks) logged
every damage event of an 88-second dummy session: Emsai, level-25 Warrior,
Axe_Boomerang Rare 3★ / GA_Craft Epic 4★ / Shield_Craft Rare 3★, 245 session rows.
Full analysis: `farever-hlx/captures/2026-08-02/VERDICT.md`; raw CSV and the
inventory dump sit next to it. Predictions were generated at HEAD `947c02f`
through the engine's own damage path, nothing fitted.

The player has confirmed, in words, the state the dump could not show:
**talents = the Hemorrhage root node only; no runes equipped; Battle Shout and
Berserk were cast before the pull.** Every hypothesis that leaned on unknown
talents or runes is dead. What remains unexplained is the model's to fix.

## Anchors you can calibrate against today

- **The ±10% swing band is exact, and the log ceils like the display.**
  Steady normals 25–31 vs ceil(24.71..30.2); crit max 47 = ceil(46.36) exactly.
- **Crit multiplier = the sheet's CritDamage to 0.3%** (three band-less skills:
  1.5325, 1.530, 1.531 vs 1.5348).
- **All three refused script riders fire in game**: combo +20% vs bleeding
  (dmgMult, not critDmgMult — the clean 1.5325 crit ratio proves which),
  Bonethrow rank-3 +20% critDmgMult, Domination vs the stun window — the
  training dummy IS stunnable. Shipped riderless numbers run −13.7% to −17.5%.
  Policy: publish rider-on conditioned on status uptime instead of refusing.
- **The Hemorrhage ledger is right.** Crit-only feeds, f = 0.35 (rounding band
  [0.3435, 0.3588]), 2s grid / 8s window / 4 ticks, perTick recomputed per feed,
  carry across refresh AND expiry required by the data, books close to 0.1–2.5%.
  Status ticks never crit: 0/98.
- **Bleed tick ratio is 0.1023–0.1028, not 0.100** — systematic, small; best
  candidate is Fervor applied a second time at tick landing.
- **Full-charge GA_Craft_Skill1 = the standing audit assumption**, −2.5% on mean;
  partial tiers never appear. GA weapon-skill rank ≥ 2 (cadence excludes rank 1).
- **Bonethrow's 269ms pairs are cleave, not a return hit** — one hit per target,
  independent per-target ledgers. Retire the return-hit hypothesis.

## The bake, answered from the side (your current blocker)

6ecf7ad ends: "One tooltip settles it: any dual-aptitude item at a known level."
Better than a tooltip is coming: the instrumentation workspace will postfix
`$HItem.generateItemAffixes@20747` and log the REAL bake — item id, the iLevel
argument, and every resulting affix line — for every item the client touches.
That settles group-by-endAtb, gearRatio-or-not, and the divisor in one login,
with N items instead of one tooltip. Until then, two live anchors from this
capture (both residuals after riders and buffs are accounted):

- Live Armor ≈ 2508 vs modelled 2257 (+11%) — from Heartsteel's pure 0.1×Armor.
- Live Strength ≈ 138 vs modelled 146 — Rage Strike (pure Str) −5.4% and the GA
  60/40 mix −2.5% cohere on it; Vitality meanwhile lands exact.

## Open defects, each with its measured target

1. **Chain cadence: model ×1.498 too slow.** 12 pure cycles, median 1903ms
   (1820–1972) vs modelled 2850ms; links 210–640ms apart, not the 0.7s floor.
   Suspiciously exactly ×1.5. Largest error in the model; every DPS number
   inherits it.
2. **Crit conversion.** Steady-state non-Rage-Strike crit = 28.8% (30/104, flat
   across the fight: 30.4% → 34.4%) vs the computed sheet's 21.39% — with
   talents and runes now ruled out by the player, the rating→chance conversion
   is the prime suspect. `ent.UnitAttributes` carries BOTH `critChance` and
   `critChanceRating`; the conversion between them is a bytecode read waiting
   to happen.
3. **Rage Strike crits 56.3% in steady state** (9/16) against 28.8% for
   everything else. No talent explains it (player has none). Read the skill row
   / script for an authored crit rider.
4. **ComboWindow is half wrong.** Chains reset, but casts do NOT reset a banked
   finisher — decisive sequence at t=47.6→55.0s: link 3 held across three Rage
   Strikes and a fully-held Rampage, then the finisher fired. The model needs a
   banked-chain concept.
5. **Berserk's measured factor is ×1.183–1.187, not a clean ×1.20** (window
   expiry bracketed +10.9–11.8s, composes additively with dmgMult riders).
   Either the authored value differs or a base is excluded; readable.

## Instrumentation notes (for anyone extending the capture)

Of nine hooks, only `ent.Unit.onInflictDamage` produced rows (4,916). The
receiver-side `applyDamage` pair and the `addStatus`/`addStacks`/`refresh`
family bound cleanly but never fired — live status application flows through
the network-sync path, not local `addStatus`. Mod v2 re-sites those, adds
cast/press events, buff apply/remove, a Rage column, and one decimal place on
amounts — the four residual anomalies in VERDICT.md §3.10 all live at the
integer floor.
