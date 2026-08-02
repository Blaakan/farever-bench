# Ground truth, measured live — 2026-08-02

An HLX instrumentation mod (`D:/Gits/farever-hlx`, read-only postfix hooks) logged
every damage event of an 88-second dummy session: Emsai, level-25 Warrior,
Axe_Boomerang Rare 3★ / GA_Craft Epic 4★ / Shield_Craft Rare 3★, 245 session rows.
Full analysis: `farever-hlx/captures/2026-08-02/VERDICT.md`; raw CSV and the
inventory dump sit next to it. Predictions were generated at HEAD `947c02f`
through the engine's own damage path, nothing fitted.

The player has confirmed, in words, the state the dump could not show:
**no runes equipped; Battle Shout and Berserk were cast before the pull.**

**CORRECTED 2026-08-02, later the same day.** The original note here also said
"talents = the Hemorrhage root node only", and the player has since retracted it:
the equipped `Head_RDemon_Fig_Craft` carried a Demon Sigil, and a sigil grants a
talent outright. `DemonSigil_War_SurgeOfViolence` ("Sigil of Bet'Hatesht", Epic,
`augmentTargets: [Head]`, `skills: [Warrior_Talent_SurgeOfViolence]`) is the one
that matters, and `bench optimize` slots that exact sigil on its own Warrior
optimum. The dump enumerates loose sigils as items — it holds two Mage ones — but
it has no field for a sigil ALREADY SOCKETED, so it could never have shown this.

So **Surge of Violence was live**: 25% per combo finisher that the next Rage
Strike costs no Rage *and* is a guaranteed critical strike. Read three ways —
`Warrior_Rage_Strike.onInflictDamageEval@44626` ops 20-21 set `critChance = 1`
under `hasStatus(owner, SURGE) && hit.skillId == kind`; `evalCost@44627` ops 24-28
return 0; `onStop@44624` removes the status, so it is strictly one-shot.

It does **not** settle item 3 below. Because the status is one-shot, a Rage Strike
can only be empowered if a combo finisher landed since the *previous* one, and
interleaving the 16 steady casts against the 24 combo events leaves only 6
eligible. Four of the nine crits — at t=978.394, 986.699, 999.498, 1039.532 —
have zero combo events since the preceding Rage Strike and are mechanically
ineligible. That subset still crits 4/10. The anomaly survives the rider, and
n=16 cannot separate rider from no-rider anyway (Fisher one-sided p = 0.121).

Nor is the Rage ledger evidence for it. `Warrior_BerserkStatus` carries
`TAttribute_ARatio RageGainFactor +1` — income doubled for 15s, already modelled
at `src/sim.mjs:167-173` — which puts 18 of the 115 generator casts at double
rate: 182 available against 190 needed, a deficit of one free cast rather than
three. With the `Warrior_RageStrike_M2` mastery (−1 Rage, never ruled out) it
closes with none.

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
2. **Crit conversion — CLOSED 2026-08-02.** It was never the rating conversion,
   which reproduces the game to five digits. Two permanent +5 CritChance rows
   were being dropped: Bloodrage Aura's status, lost when the skill was refused
   whole for its unrateable heal (`3a99d83`), and `Axe_Boomerang_Combo`'s own
   affix, dropped because the harvest read `rot.passive` only, while
   `permaAffixes@6081` gives them permanently to every nature but Status and
   Passive (`a43c2a6`). The captured build went 19.62% → **29.62%** against a
   measured 27.8–28.8% steady state.
   Note also `Warrior_BattleShoutStatus`'s `TAttribute_Flat CritChance +20` for
   15s, pre-cast: crit measures 10/22 = 45.5% before t0+11.4s and 30/108 = 27.8%
   after. Any baseline must exclude the opener window, as the 28.8% figure does.
   (The old note's "flat across the fight: 30.4% → 34.4%" cannot be halves of a
   28.8% total; treat those two numbers as unreliable.)
3. **Rage Strike crits 56.3% in steady state** (9/16) against 28.8% for
   everything else. Surge of Violence — live via the head sigil, see the
   correction above — accounts for at most 5 of the 9: it is one-shot, so only 6
   of the 16 casts had a combo finisher since the previous Rage Strike, and four
   of the crits land on casts that did not. That subset still crits 4/10. Open,
   and n=16 cannot settle it (Fisher one-sided p = 0.121 rider vs no-rider).
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
