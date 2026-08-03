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
   **Shape settled 2026-08-02 v2**: no floor of any kind — per-link animation
   locks on a frame grid. See the v2 section below.
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
   **DISSOLVED 2026-08-02 v2** under directly observed Surge windows — the
   ineligible-crit class is empty. See below.
4. **ComboWindow is half wrong.** Chains reset, but casts do NOT reset a banked
   finisher — decisive sequence at t=47.6→55.0s: link 3 held across three Rage
   Strikes and a fully-held Rampage, then the finisher fired. The model needs a
   banked-chain concept.
   **SETTLED 2026-08-02 v2**: one cumulative end-to-start clock, 52/52; the
   banked-chain concept is RETIRED — do not implement it. See below.
5. **Berserk's measured factor is ×1.183–1.187, not a clean ×1.20** (window
   expiry bracketed +10.9–11.8s, composes additively with dmgMult riders).
   Either the authored value differs or a base is excluded; readable.
   **SETTLED 2026-08-02 v2**: exactly ×1.20 — the low read was Enchant_Devote
   fervor-ramp contamination across the window boundary. See below.

## Instrumentation notes (for anyone extending the capture)

Of nine hooks, only `ent.Unit.onInflictDamage` produced rows (4,916). The
receiver-side `applyDamage` pair and the `addStatus`/`addStacks`/`refresh`
family bound cleanly but never fired — live status application flows through
the network-sync path, not local `addStatus`. Mod v2 re-sites those, adds
cast/press events, buff apply/remove, a Rage column, and one decimal place on
amounts — the four residual anomalies in VERDICT.md §3.10 all live at the
integer floor.

## The second capture answers — 2026-08-02, v2

Mod v2 ran and delivered: press rows with a Rage column, deduped cast-state
transitions, status on/off/refresh with reasons, two-decimal amounts, and the
REAL bake logged per item (`generateItemAffixes` postfix). One ~2-minute dummy
session, Battle Shout and Berserk cast MID-fight this time, both windows logged
to the millisecond. Full analysis:
`farever-hlx/captures/2026-08-02-v2/VERDICT-V2.md`. Predictions regenerated at
`5f32441`; nothing reused from v1.

**The session's own loadout correction, first.** Mainhand was **GS_Nova**
(Rare 0★, effective iLevel 260 — the paired bake row reads 32/25/69, the
measured Rare-0★ tooltip to the integer), not the axe: the Axe and Shield
passive statuses Cancel before the first Dash. So every number below is the GS
chain, and the axe's combo-bleed rider never fires in this capture — the
three-rider sum stays untested, but the two-rider overlap decides composition
anyway.

**Item 4 — ComboWindow, SETTLED; the banked chain is retired.** One uniform
clock, run from the END of the last completed basic to the START of the next,
casts and idle pooling together, 0.6s: it predicts **52/52** basic-chain casts.
Literal start-to-start scores 18/52 (every advancing start-to-start is
681–1292ms — the phrasing forbids every observed advance). The banked finisher
scores 50/52 and both its misses are mid-chain links surviving casts (415ms
through a Rage Strike, 527ms through a Surging Force) — which banking cannot
produce. This capture's equivalent of v1's decisive t=47.6→55.0s sequence fired
at 597ms end-to-start, inside the window by 3ms, no banking needed; per-link
damage-landing offsets (median 472/320/431/402ms after cast start) explain how
v1's damage-timestamp reconstruction manufactured a bank. The anchor is proven
by the double-Rage-Strike reset: a basic pressed 13ms after the second RS ended
still reset, because 854ms had passed since the last BASIC's end — the clock is
not refreshed by skill ends. Measured bracket [597, 854)ms contains the
authored 600. The model's `sim.mjs:952` per-cast occupancy test and `:984` idle
test must become ONE cumulative clock (reset iff nextBasicStart −
lastCompletedBasicEnd > comboWindow), and the `engine.mjs:748-753` hedge goes.
The paragraph above that asked for a banked-chain concept is hereby retired.
One residual ask, n=0 in both captures: complete links 1–3, cast Charge
(1064ms), press basic — uniform clock predicts restart at L1.

**Item 3 — the 9/16, DISSOLVED.** Surge's windows are now observed, not
inferred: armed exactly at combo-finisher inflicts, consumed at the empowered
cast's skill_end (+13/+54ms), strictly one-shot (a cast pressed while the stale
row was visible paid full and did not crit). The 11-cast ledger decomposes
every crit: 2 forced, 1 inside the Battle Shout +20 window (1 of 2 window
casts), 2 steady natural = 2/7 = 28.6% against the session's fleet non-RS
steady 13/43 = 30.2%. The "mechanically ineligible crit" class is EMPTY.
The Rage ledger closes to the point — cost 10 flat (two clean 20→10 pairs),
Surge casts pay 0, income +1/swing +2/finisher +1/weapon-skill +1/3s doubled
under Berserk, all 14 inter-press deltas exact — so **M2 is refuted** (the
"never ruled out" above is ruled out). Asymmetry worth modelling: the cost
check runs at PRESS, the forced-crit check at DAMAGE EVAL — a queued second
Rage Strike gets the free cast without the crit.

> **REFUTED — by this capture's own press rows, and then by the bytecode.**
>
> The Rage column already contains the test. Four back-to-back Rage Strike
> pairs, all inside one 0.4s cast:
>
> | t | rage at press | verdict |
> |---|---|---|
> | 35.153 → 35.552 (399ms) | 14 → 15 | rage went UP; press 1 was **free** |
> | 46.219 → 46.636 (417ms) | 20 → 10 | press 1 **paid** (not armed) |
> | 87.657 → 88.087 (430ms) | 20 → 20 | at the cap and unmoved; press 1 **free** |
> | 88.087 → 88.517 (430ms) | 20 → 10 | press 2 **paid** |
>
> **Never two free casts in a row.** The 87.657 triple is the decisive one: free,
> then full price, 430ms apart.
>
> The mechanism agrees. The two hooks do run at those two moments, but nothing
> gets between them: `GameObject.doUseSkill@4576` op 2 calls
> `stopActiveSkill@4580` as its FIRST action, which is `BaseSkill.stop@6093` on
> the running skill, which runs `onStop` and removes the status before the new
> cast evaluates anything. A press cannot outrun its own stop, and a queued press
> resolves when the current cast ENDS — the same removal. One arm buys one free
> critical cast. The register is modelled one-shot accordingly.
>
> *Method note, because this cost a wrong commit:* the claim above was inherited
> and then "verified" by looking for a mechanism that would explain it, which
> found one and stopped. Asking what it PREDICTED — two free casts off a single
> 25% proc — killed it in one line, and eight rows of a CSV already on disk
> settled it. Check the prediction before the mechanism.

**Item 5 — Berserk, exactly ×1.20; do not retune, and nothing was wrong with
the authored value.** Identical-state pairs read 1.1915/1.1924/1.1928 raw —
and every pair spans the Enchant_Devote 3→5 fervor ramp (+0.632 pts); corrected,
they read 1.1984/1.1994/1.1998. v1's ×1.183–1.187 was the same contamination
over a larger ramp. Composition, decided twice over: dmgMult riders SUM into
one bracket, and that bracket MULTIPLIES (1 + fervor + mastery). The only
double-rider deterministic hit (RS 352, Berserk + Domination-via-stun) fits
1+0.20+0.25 = 1.45 at −0.23% where compounded 1.20×1.25 misses by +3.2%; a
42-hit least-squares prefers additive at rms 0.26%/worst 0.54% over compounded
0.66%/2.83%; and Berserk-added-INTO-the-fervor-bracket (1.1860) is excluded by
the GA ratio window [1.1903, 1.1954]. So: `amount = B × (1+F+M) ×
(1+Σ dmgMult) × cd^crit`. Fixes owed: `damage.mjs` runeDamage must stop
`m *= 1+rd.amount` per line and sum instead; `skills.mjs` must stop folding
Berserk into sheet DamageModifier. Caveat named: at sheet DamageModifier = 100,
`(D+Σ)` vs `D×(1+Σ)` are indistinguishable — deciding that needs a capture with
a permanent DamageModifier ≠ 100 source. Independent channel: running
Hemorrhage ticks obey `ceil(bank/4 × 1.2)` inside the window, 10/11 exact, and
tick 28-not-30 with Devote up proves ticks skip the fervor/mastery bracket.

**Item 1 — cadence, shape settled (GS chain).** No floor of any kind: per-link
animation locks, L1 median 765ms / L2 723 / L3 710 / finisher 848, quantized to
a ~13–14ms frame grid, plus an 11–13ms one-tick re-trigger gap (30/32). A clean
four-link chain runs 3043–3113ms (mean 3075, n=5) ≈ 1.30 links/s. Cadence is
buff-independent — Berserk and Battle Shout shift in-window link means <2%, so
neither carries a haste rider. Held-vs-tapped for basics is unobservable with
this probe: basics emit zero press rows (the input path bypasses the hook).

**Item 2's Battle Shout note, confirmed live.** +20 CritChance flat, zero
damage affix: in-window crit density 9/17 = 52.9% vs post-window 15/50 = 30.0%,
delta +22.9 pts against the authored +20 (trinket ramp accounts for ≤2.5 pts of
the excess); fit residuals carry no BS damage term at ±0.4%. The opener-crit
caveat above is fully explained. Precision floor ±13 pts at n=17.

**The bake is ground truth now — the −6.9% leaves the bake forever.** All 18
live item_affixes signatures are integer-exact under HEAD at TRUE effective
iLevels (level_arg = eff iLevel ×10; Axe 290, GA_Craft 320, Shield 270, rings
260, necklace 210, head 260, the rest 260), so zero stat error reaches the
damage path from gear. The 636-key def-bake table reproduces 636/636 (2,765
affix lines) under two one-line fixes HEAD still owes `catalog.mjs`: round ONCE
per target attribute, not per row (87 keys, ±1..2), and the Uncommon statGroup
drop — single-aptitude drops the primary group, multi-aptitude drops the
vitality group — now MEASURED on 287 keys, no longer just trace-derived. The
twelve landed tooltip integers stay exact under both. The two "live anchors
from the side" above are superseded: gear Armor is the exact integer 2431
(bake-side share of the −4.3% is at most the shield socket's 17 armor = 0.7%;
the rest sits in base armor, buffs, or the Heartsteel read), and the Strength
puzzle inverts — live Strength is now ~11 HIGH of the ground-truth sheet
(145.6–146.8 vs 135.2), and that single +11 lands all four damage anchors
(RS ×1.081, combo ×1.055–1.060, GA ×1.052–1.056, swings ×1.057) within 0.8%
through their measured elasticities (1.00/0.62/0.62/0.73). Candidate sources
invisible to the capture: the arsenal stat discount (40% → ~70%) or an unread
talent Strength node. One sheet read (146 vs 136) or one arsenal-empty capture
settles it. Model mispick found en route: the necklace generic is the
four-rating Vit4/CCR11/APR11/SPR11/FR11, not Vit2/CCR14.

**The integer-floor anomalies, reframed.** Two-decimal logging shows every
hero-sourced hit as an exact integer while mob autos carry decimals (22.5710678,
18.05) — hero damage is quantized BEFORE `onInflictDamage`, so the four §3.10
anomalies live hero-side, not log-side, and rounding polarity is still open.
The Hemorrhage tick formula (log-ceils) is confirmed 10/11; the one miss
(73 vs 198, pool 714-of-791 spent) is the influx/twin-ledger item's problem,
which survives.

**New, measured, and owed to the model:** GA_Craft_Skill1 prices attacker state
at PRESS — 3.2–3.3s projectile flight, ±0.2% under press-state vs ±4.6% at
damage time — so slow projectiles need a launch-time snapshot.

> **NOT OWED — the model already does this, 2026-08-03.** `runFight` calls
> `hit(prof, now)` *before* `tickTo(end)` advances the clock, and `setUp(applies)`
> runs after it, so a cast is priced against the state it was pressed in. The
> measurement therefore CONFIRMS the model rather than indicting it, and the
> alternative it rules out — pricing at impact — is the one the model never did.
> Two corrections to the entry itself: `GA_Craft_Skill1` carries no projectile
> anywhere in its row (its steps are Cast / Visuals / Dash / Area), so the
> 3.2–3.3s is its **charge hold**, not flight time. The observable form of the
> invariant is now a test: a skill that buffs itself must not price its own cast
> under that buff, which `GA_Craft_FinalCombo` (+4 PhysicalMastery) checks.
`GS_Nova_Skill2_Buff` is rank ≥2 (+10 PhysicalMastery, additive in the bracket;
947/866 = 1.09353 vs 1.09168). Domination is rank ≥2 (0.25; the 0.15 hypothesis
leaves 7.4% residuals) — the rankOverride-restates-vars reading, confirmed in
the flesh. Fervor conversion confirmed to 0.007% (947/937 = 1.01067 vs
1.01074). CritDamage ×1.533–1.540 live. Dash cancels basics.

**Still open after v2, each with its ask:** the +11 Strength source (sheet read
or arsenal-empty capture); GS-build crit conversion — fleet steady 30.2% vs the
build's modelled 17.95%, P ≈ 0.02, so the v1 crit close was axe-build-specific
(sheet CritChance read on the GS loadout); SurgingForce's unmodelled ~+20%/~2s
self-window and its own hit ×1.41–1.48 short (SF spam at fixed Devote stacks);

**SHEET READ, 2026-08-02 evening — the player photographed the Character
Profile on the exact v2 loadout (GS_Nova mainhand, GA_Craft arsenal, OFFHAND
EMPTY — the shield was unequipped, so no shield socket in these numbers):
Vitality 179, Strength 144, Dexterity 32, Faith 32, Intellect 28, level 25.**
What it settles: the +11-Strength anomaly is a SHEET-SIDE deficit — the game's
own sheet carries 144 against the model's computed 135.2, and the
damage-inferred 145.6–146.8 sits within hero-quantization of the sheet. The
damage path is exonerated end to end; the −6.9% "multiplier" is dead. What it
arms: the full five-attribute vector discriminates the two candidate sources —
an arsenal stat share larger than the modelled 0.4 inflates every GA_Craft-
carried attribute proportionally (Vit AND Str, in the GA's aptitude mix), while
an unread talent node moves only its own stat. Diff all five against the
model's sheet for THIS exact loadout (no offhand!) and the residual vector
picks the hypothesis. The remaining ~1–3 between sheet 144 and damage-inferred
145.6–146.8 is within fit precision; do not chase it until the sheet diff is
clean.

**FULL SHEET + EVERY TOOLTIP, 2026-08-02 late evening — the anomaly is closed.**
The player photographed More Stats and every equipped tooltip on the same
loadout. The sheet is an EXACT LINEAR SUM of the naked base (Vit 38, Str 34,
Dex 28, Faith 28, Int 28 — the old naked measurement, still exact at 25) plus
the tooltip lines including enchants and augments: Vit 179, Str 144, Dex 32,
Faith 32, Armor 1930, all to the integer; MaxHealth = 3 × Vit = 537 exactly.

What killed the +11: **+8 is enchants** — Honed Bronze Plate (+2 Str +2 Dex) on
chest AND back, Magic Formula: Strength (+4) on hands — which the inventory
dump has no field for; the rest is per-line item prediction diffs. The arsenal
hypothesis is executed by the game's own UI: Judgement's tooltip prints
"Arsenal stats efficiency: 40%" with the discounted lines (+20 Vit +16 Str
+35 ArPen). The talent pane shows 15 points UNSPENT, only the root and the
sigil-granted Surge of Violence — no hidden talent node either.

More settlements riding along:
- **Necklace generic = the four-rating spread, tooltip-confirmed**: Pendant of
  Adaptability (L20): +4 Vit, +11 Critical, +11 ArPen, +11 MagPen, +11 Fervor —
  exactly the owed fix #5.
- **Sheet crit 17.3% closes the conversion**: base 5.8 + ratings (~159 crit
  rating → ~8.4) + Judgement's 4★ upgrade "+3% Critical Chance" ≈ 17.2–17.3 —
  AND proves arsenal upgrade riders reach the wearer's sheet.
- **Armor 1930 = pure gear sum** (279+259+358+100+219+158+318+239), consistent
  with v2's 2431 minus the unequipped shield's 501. The sheet prints the
  mitigation beside it: −40.08% at armor 1930 — a free mitigation-curve point.
- **Fervor 4.6%** closes from the rating sum (~87 rating) through the budget
  conversion.
- Judgement carries a Corrupted Gift (−8 MagPen +8 ArPen) — augments of this
  family are the standing explanation for the shield's +10 effective iLevel.
- Per-item stat lines (for the item-bake diff, verbatim from tooltips):
  Martyr of Enripit (2H Sword L25 Rare 0★): 174–213 phys, +32 Vit +25 Str +69 Critical.
  Judgement (2H Axe L25 Epic 4★, arsenal @40%): +20 Vit +16 Str +35 ArPen; Gift −8 MagPen +8 ArPen; Devote formula; upgrade +3% crit.
  Brutality Faceshield (Head 25): 279 Armor, +11 Vit +10 Str +30 ArPen; Sigil of Bet'Hatesht.
  Miner Ramparts (Shoulders 25): 259 Armor, +9 Vit +7 Str +22 Critical.
  Whirring Gem of Apix (Chest 25): 358 Armor, +11 Vit +10 Str +30 ArPen; Honed Bronze Plate +2 Str +2 Dex.
  Crimson Wings (Back 25): 100 Armor, +6 Vit +6 Str +16 Fervor; Honed Soft Embroidery +2 Str +2 Dex.
  Unholy Crimson Gloves (Hands 25): 219 Armor, +8 Vit +7 Str +22 Fervor; Magic Formula +4 Str.
  Night Servant's Girdle (Waist 25): 158 Armor, +8 Vit +4 Str +4 Faith +11 MagPen +11 Fervor.
  Wrong Trousers (Legs 25): 318 Armor, +11 Vit +10 Str +30 Critical.
  Melain's Golden Greaves (Feet 25): 239 Armor, +9 Vit +7 Str +22 ArPen; Magic Formula +15 ArPen.
  Set Eye of Fracture (Ring 25, ×2): +6 Vit +39 ArPen; Cursed Eye of Brutality +9 Crit +9 Fervor +9 ArPen −9 MagPen.
  Pendant of Adaptability (Neck 20): above; plus the same Cursed Eye augment.

## The meter's 705, laddered — 2026-08-03

The player ran the pew-pew-meter on the fully-geared pin: two ~75-second
encounters, 703 and 708 dps, against the model's 436.0. Every rung between the
two numbers is now named, and the ladder closes to 0.4 dps of rounding. Full
reconciliation with per-skill tables: `farever-hlx/captures/DPS-GAP-METER.md`.
First, the mapping that made it possible: every meter row resolves to a data id
— **Mania is `GS_Nova_Combo`, the chain's own 4th link**, scored all along
inside "(base attack chain)" (52 hits, 62.7 dps) and hidden only by the
aggregate row at `sim.mjs:1223`; the GS Base Attacks print raw ids because
their `texts.name` is authored false, which means the meter reads the same
sheet we do.

```
 436.0  the model, vs Ratsar 0.4/0.4, as pinned
+173.3  the target: the meter fights were not against Ratsar-class armour
=609.3  the same build, same engine, vs a dummy-class target
 +64.2  Rampage at the live cadence, 3-4 full-charge presses per 75s
 +35.5  Anger Release: ~18 steady-state, ~18 walked in as banked stacks
  +9.8  the below-the-cut trio (Shockwave/Whirlwind/Surging Force), live-priced
 +10.3  Raging Smash's concentrated, Strength-shaped excess
  +2.3  Hemorrhage, bottom of the residual band
 −25.5  the chain repays the clock those presses consumed
=705.9  against the meter's 705.5 (703 and 708)
```

**The target rung is 64% of the whole gap, and it is not a model defect.** The
model's mitigation is one uniform ×1.397 on every physical line, so per-skill
consistency cannot pick the target — residual size does: vs Ratsar every row
runs ×1.43–1.81 (no mechanism supplies a uniform +60%); vs the dummy every row
runs ×1.02–1.30, mean ×1.16, inside the documented live-over-model family. The
meter fights were on an unmitigated target. And the early comfort that "the
base chain matches absolutely" was a mispairing — live 3 visible links against
the model's 4-link aggregate; the honest subtotal is 207.5, and nothing
matches absolutely vs Ratsar.

**Rampage's rung is a rotation-search story, not a mechanics one.** The single
modelled cast is the opener, chosen at every fight length from 4s to 200s;
spamming loses 23.3 dps at model prices because full-charge density (988.2 per
3s hold) is breakeven against the chain cycle (967.9 per 3.00s) before billing
the forfeited Rage, finisher progress, and crit volume. The cooldown machinery
is right and even generous. At live per-hit prices the same press is a clear
win — the defect is the inverted relative price, downstream of per-hit
calibration, plus one true omission: Mania's rank-3
`reduceWeaponsCooldown(1.5s)` refund is dropped without a word (the refusal
filter suppresses riders on accounted skills), so live weapon cooldowns run
faster than modelled and nothing says so.

**Anger Release's refusal is stale, and half its meter line is a bank.** The
arming count is authored: 1 stack per non-DoT Physical damage event,
`GS_Nova_Passive_Stack` maxStacks 150 with rankOverride 100 at rank ≥2, cap →
consume → 10s proc in the SignatureSkill slot. Steady state = hit rate over
100: one cast per 69s in the model fight (627.0 per cast, +9.1 gross), one per
76–82s live. The stack status has no authored duration — stacks carry across
combats, the player's own fact, sitting in the data — so the observed 2 casts
per encounter is ~2× steady state and half this rung walks in from previous
pulls.

**The negative rung is the same clock, honestly kept**: live chain throughput
0.84/0.95 links/s against the model's 1.12, and the missing 16–25% is exactly
the Rampage holds and Anger casts above. The meter's own header convicts its
list of truncation — rows sum 671/679 against totals 703/708 — so ~30 dps of
Shockwave/Whirlwind/Surging Force live below the cut, and the player likely
presses what the model slots after all.

Fixes owed, in order: (1) score Anger Release from maxStacks plus the fight's
own event counter — but land the price analytically; naive injection flips
the rotation search to worse plans (436.0 → 413/423), the known search bug
class; (2) the refusal filter must report riders on accounted skills; (3)
print the chain per-link so the next meter reconciles without an
instrumented copy; (4) name the beneficiary in Rampage's conditional refusal
(it gates Shockwave's reset, not Rampage's cast). Unresolved and named: the
live talent pane (×1.16 residual under model talents, ×1.25 under none) and
the weapon tooltips against the Legendary 5★ pin — one screenshot each, and
neither can rescue Ratsar.

Why are we still far? Because the model is simulating a different fight, not
mis-multiplying this one: two-thirds of the distance is armour the live
target never wore, most of the rest is a rotation the player weaves and the
model prices at par or refuses — half of one ultimate arriving pre-banked —
and the last slice is the familiar ×1.16 the residual family already owns.
  Raclette Pan (Trinket 25): +32 ArPen; equipped effect: attacks grant 0.5% Critical 10s, stacking ×10.

**The one survivor, sharpened:** live steady combat crit 30.2% vs sheet 17.3%
+ trinket cap +5 = 22.3% — about +8 points from a combat-time source the sheet
does not show and the buffs do not explain (Battle Shout windows already
excluded from the 30.2%). Everything else about crit is now confirmed twice.
`(D+Σ)` vs `D×(1+Σ)` (DamageModifier ≠ 100 capture); the three-rider sum (axe
session: finisher on a bleeding target inside Berserk during the stun); the
Battle Shout ±13pt floor (~100 in-window hits); hero-side rounding polarity and
the Hemorrhage influx/twin-ledger; the shield's +10 eff iLevel (unsocket and
re-read Armor, 501 → 484 predicted); the Shoulders def default 140
(`Item.getILevel` disassembly); the armor recheck probe, to be re-created and
re-run at the true levels; and S0 = 0.075, a fitted fervor+mastery composite an
inventory dump would split. Named non-finding so nobody reopens it: group-mean
vs per-row in the bake is algebraically undecidable on shipped data (equal
end/start ratios make the curve commute with the mean) and numerically
irrelevant on all 636 keys.

**UPGRADE-RIDER RANK, 2026-08-02 night — the screenshot decides against the
star count.** The 4★ Judgement's tooltip prints "Upgrade: Critical Chance
increased by 3%" — on the same item whose effective iLevel is 320 = 250 +
Epic 30 + 4×10 (bake-row confirmed). The sheet corroborates independently:
5.8 base + ~8.4 ratings + 3 = 17.2–17.3 vs the printed 17.3; +4 would read
18.2+. So iLevel counts four upgrades while the rider row fires at rank 3:
the rank that row sees is NOT the star count. The RULE is underdetermined by
one point (stars−1? capped at rarity-max−1?); the discriminator is the
player's Rare 3★ Axe_Boomerang tooltip — +2 settles stars−1, +3 settles
something subtler. Until then, model the rider at stars−1 with the Axe read
as the pending check, and keep the resting sheet pinned to 17.3.

**ITEM LOGIC, 2026-08-03 — the optimizer recommends jewelry that cannot
exist.** Player report, verified: `bench optimize` slots "Amulet of Precision"
(`Necklace_Z1_Cri`, authored level 6, authored rarity Uncommon, WorldLoot) as
Rare at iLVL 260, and "Signet of the Fighter" (`Finger_Z2RCraft_CriAP`,
authored level 15) at 260. Two compounding defects:

1. `src/engine.mjs:46` defaults `dropsScale: true` while `--drops` help still
   says "default authored". With scale on, `effectiveLevel` takes
   `max(authored, charLevel×10)` and lifts every authored-level row to
   character level. The live bakes rule on this: `Necklace_Z2RCraft` logged
   iLevel **210 = authored 20 exactly** on a level-25 character, and the
   Z3 craft rings 260 = authored 25 — fixed-level gear does NOT scale.
   Meanwhile GA_Craft at eff 320 proves weapons DO generate at source level
   above their authored 4. The scale hypothesis is weapon-true, gear-false.
2. `rarityRoll` defaults on for every slot, but the drop chain read from the
   bytecode (`st.Player.dropLoot@3836`, acquisition study) rolls generation
   rarity for **Weapon-type only** — gear keeps its authored row rarity. An
   Uncommon-authored necklace offered at Rare is an illegal item.

Fix shape: scale (and rarity-roll) Weapon-type only; gear takes
`authored ?? charLevel` level and authored rarity. Then re-run anything that
ranked jewelry under the old defaults — the layouts sweep and every recent
optimize output priced some slots ~4× their legal stats.

**MAGE FIRST-RUN, 2026-08-03 — 239.0 dps is starvation, not mystery.** The
player ran the first non-Warrior optimize. The low number is the roadmap's own
"Remaining" list made visible: base Spark regen as time income, the talent
income family, Foresight's free cast, the chaincast bypass and Reverberate are
all unmodelled, so the sim funds ~125 weapon-skill casts per 200s on partial
income and fills the rest with dagger swings (~34 dps across four links).
Two additions from this look: (1) `Mage_Infusion` is refused as "nothing
declared" — a class skill named Infusion with an empty row almost certainly
generates Spark in script or code; read it as part of the income pass, not the
damage pass. (2) The fastest calibration path for the whole class now exists:
the v2 bench-probe logs `spark=` on every press row — one 2-minute Mage dummy
session hands over the complete live Spark ledger (income per swing, per tick,
per talent) the way the Rage ledger was closed for Warrior in one capture.

**CORRECTION to the item-logic fix, 2026-08-03 — armor is not jewelry.** The
questlog import of the player's reference build exposed the over-reach in
235c4db/16f6b77: three armor rows authored at level 1 (Head_RDemon_FigWiz,
Shoulders_RDemon_Fig, Feet_RDemon_Fig) now evaluate at iLVL 11 — near-zero
stats — while the player's live armor of the same faction families sits at
level 25 with 239-358 Armor per piece. The jewelry evidence (bake rows at
authored exactly) proves FIXED level for GearNeck/GearFinger/GearTrinket; for
ARMOR the bytecode's UseItemLevel semantics read authored level as a MINIMUM
(loot-entry minLvl), and armor drops at source level. Refine the split:
jewelry fixed at authored; armor (and weapons) scale to source with authored
as floor. One tooltip of any level-1-authored armor piece ("Horns of
Nightking" family) confirms. Also noted: questlog gradeOverride/upgradeLevel
import verified working — the reference build itself carries maxed weapons
(Legendary 5*) where the live pair was Rare 0* / Epic 4*, so builder-vs-live
divergence is a real comparison hazard, not an import defect.

**PLAYER CORRECTION, 2026-08-03: the questlog build IS the 703 loadout.** The
prior note's "builder-vs-live divergence" was wrong — the tooltip set
photographed earlier (Brutality/Adaptability/Fracture) was a PREVIOUS gear
state; the meter's 703 was recorded on the questlog build as imported:
Legendary 5* Martyr + Judgement, Nightking/Zeal pieces included. Consequences:
(1) the weapons are NOT over-stated; (2) the three level-1-authored armor rows
at iLVL 11 are an ACTIVE understatement of the player's real build — the
armor-floor fix above moves from hygiene to load-bearing; (3) the remaining
561.6 -> 703 gap decomposes onto already-queued rungs: Rampage cadence (model
1 cast/75s = 18 dps vs live 86), Anger Release steady-vs-bank (12.4 vs 37),
the armor-floor recovery on three slots, and the x1.16 per-hit residual
family. Nothing new is needed - land the queue and re-measure.

**NET-ARSENAL PROBE, 2026-08-03 — verified fixed by the week's queue.** The
player's layouts sweep (old code) ranked Net_Basic — a statless, skill-less
capture net — surprisingly high as arsenal. Re-tested on current HEAD, three
tiers: head-to-head at fixed gear GA_Craft 219.3 > net 186.9 ≈ empty 183.4;
full optimization GA 796.6 > net 715.3; WeaponPower identical across arsenals
(49.43 — arsenal never touches swing power, matching the bytecode). The old
anomaly was the arsenal-skill under-pricing family now landed (Rampage
cadence, rider bracket, Mania visibility, cooldown refunds): when a real
arsenal's skill package priced at ~15 dps, the net's cost was noise and
restart variance could flip pairs. Standing asks: (1) a regression test —
an empty arsenal must never outrank a real weapon at equal optimization
(the fixed-gear triple above is the cheap form); (2) the layouts sweep is
pre-fix vintage — re-run --fresh once the last two rungs land.
