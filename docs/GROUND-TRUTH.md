# Ground truth, measured live — 2026-08-02

> **Reading this file on build 25782799 (the September 30 update).** Every
> section down to "Measured on build 25782799" was measured on the builds of
> 2026-07-29 to 2026-08-28 and is kept as written: it is the record of how
> each number was found. Four things those sections take for granted are no
> longer true of the game, and each is marked `[2026-10: ...]` where it
> matters:
>
> - **the training dummy.** It authored no armour then, so "the 0-armor
>   dummy" was literally true and a dummy swing read the formula bare. It
>   authors 0.40 / 0.40 now, at level 1: a level-25 character gets 89.9%
>   through (read, and measured on 2026-10-13 through one Warrior's
>   penetration: the last section).
> - **WeaponPower.** The rule these swings calibrated - 0.4 × the SUM of the
>   aptitude budgets plus the full attribute - was replaced.
> - **Domination, Bloodrage Aura, Brutal Frenzy, Lethal Poison.** Their rows
>   and scripts were retuned or rewritten; the numbers below are the old
>   rows'.
> - **the server half of the client.** `applyDamage`, `addStatus`,
>   `Status.refresh` and 199 more functions are server-only stubs on the new
>   client, so a mechanism this file confirmed "in the bytecode" in those
>   bodies cannot be re-read there.
>
> The rules themselves are in [MODEL.md](MODEL.md); what was measured on the
> new build is the last section of this file.
>
> Two hotfix builds followed it: 25933712 (2026-10-14) and 25959898
> (2026-10-15), the one installed as this is written. Nothing in this file
> was measured on either. The last capture predates both, and `bench verify`
> says so at the top of every ledger it prints from it.

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
`Warrior_Rage_Strike.onInflictDamageEval@45150` ops 20-21 set `critChance = 1`
under `hasStatus(owner, SURGE) && hit.skillId == kind`; `Warrior_Rage_Strike.evalCost@45151` ops 24-28
return 0; `Warrior_Rage_Strike.onStop@45148` removes the status, so it is strictly one-shot.

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
  `[2026-10: Domination's script was rewritten by the September 30 update -
  a stun-armed register at every rank and an owner-wide +25% at rank 3; this
  line is the old script's rider. The dummy is still stunnable: measured
  again 2026-10-13.]`
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
`$HItem.generateItemAffixes@21736` and log the REAL bake — item id, the iLevel
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
   `[2026-10: +5 on that build; Bloodrage Aura's status authors +2 / +3 by
   rank on build 25782799]`
   were being dropped: Bloodrage Aura's status, lost when the skill was refused
   whole for its unrateable heal (`3a99d83`), and `Axe_Boomerang_Combo`'s own
   affix, dropped because the harvest read `rot.passive` only, while
   `permaAffixes@6188` gives them permanently to every nature but Status and
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
> gets between them: `GameObject.doUseSkill@4651` op 2 calls
> `stopActiveSkill@4655` as its FIRST action (op 2 on the build of the day;
> on build 25959898 it is op 10, behind a test of the pressed skill's
> NonInterupting flag at ops 0-7 and of whether it is the running skill at
> ops 8-9), which is `BaseSkill.stop@6200` on
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
the flesh. `[2026-10: the reading - a rankOverride restates vars - stands and
is measured again on the new script. The numbers do not carry over: on build
25782799 the 0.25 is the rank-3 rider's own var with no override, and it is
the REGISTER's amount that is 0.10 with 0.15 from rank 2 - measured
2026-10-13 at ×1.150.]` Fervor conversion confirmed to 0.007% (947/937 = 1.01067 vs
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
  [2026-10: the +5 at ten stacks is still what the row says and what the model prices, and the
  2026-10-13 capture did not see it: 62 critical of 385 swing and finisher rows at ten stacks with
  Battle Shout down, 16.1%, 2.7 standard deviations under the 21.7% the price expects. The read
  stands; `bench audit` carries both numbers and the reading that would settle it.]

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
   bytecode (`st.Player.dropLoot`, acquisition study) rolls generation
   rarity for **Weapon-type only** — gear keeps its authored row rarity. An
   Uncommon-authored necklace offered at Rare is an illegal item.
   `[2026-10: that body was read on the build of the day. On build 25782799
   and the hotfix builds after it st.Player.dropLoot@8181 is a three-op server-only stub and cannot be
   re-read; the same conclusion is read there in ent.Hero.makeLootItem@7953,
   whose ops 126-129 skip the rarity draw for anything that is not a Weapon.]`

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
damage pass. [2026-10: it generates nothing. Its description is "You can
choose a third [Conduit].", the Mage's unit enters it at level 4 and
`Mage_Conduit_Levels` is [1, 1, 4]: it IS the third conduit slot, which the
pool already counts, and it is no longer listed as unscored.] (2) The fastest calibration path for the whole class now exists:
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

**NET PROBE COMPLETED BY THE PLAYER, 2026-08-03.** The symmetric test — net as
sole weapon in either slot with offhand pinned none — reads 33.7 vs 34.0 dps:
equal within optimizer shuffle. The earlier 135.8-vs-52.8 asymmetry was
entirely an OFFHAND LOOPHOLE: `--pin weapon1=none` leaves OffhandWeapon free
and the optimizer socketed a Legendary Firebreath-family shield (Furnace Roar
= 58% of that run's damage) — a state the game does not allow (no empty
mainhand). GUARD NEEDED in the CLI/optimizer: weapon1=none must imply or
require offhand=none, or refuse outright with a named reason. Separately
observed and still uncorrected: `weaponPowerFor`'s no-aptitude fallback
substitutes the class primary budget — the sheet prints WeaponPower 49.43 for
a butterfly net. Inert in the net case (no swings, no weapon skills — the
player's symmetric equality proves it) but contrary to the read of the
closure that prices the WeaponPower flat (the one
`$HSkill.getStepEffectItemScaling@21779` creates; this line cited it by its
bare number on the 2026-08 build); a one-line bytecode-literal correction
awaiting a decision. `[2026-10: closed on 2026-08-12 - an aptitude-less
weapon prices at exactly an empty slot - and the closure itself gained an op
in the September 30 update: see MODEL.md, "WeaponPower".]`

**THE NET PROBE'S TRUE FINDING, 2026-08-03 — a search-quality defect, measured.**
The player pressed past the offhand loophole and was right to: on current HEAD,
full optimization ranks Net_Basic (715.3) ABOVE Mace_Benediction (669.9) and
Shield_Craft (714.3) as arsenal to a GS_Nova mainhand, while FIXED-GEAR
evaluate prices the same items sanely (Mace 188.7 > Net 186.9 > empty 183.4 <
GA 219.3). The damage layer is exonerated; the optimizer is convicted by
dominance: a mace-pinned optimum can always adopt the net-build's entire
configuration and decline to cast mace skills, so its true optimum is >= the
net's 715.3 - the search returns 669.9, leaving >=45 dps (6.4%) in
deterministic bad local optima (numbers repeat run to run). Same family as the
documented "naive injection flips the rotation search to worse plans" class,
and as the player's 33.7-vs-34.0 asymmetry on a nothing item (equivalent
states, different ascent paths). Two regression invariants to encode:
(1) SLOT SYMMETRY - a statless, skill-less item pinned as sole weapon in
either slot (offhand pinned none) must produce THE SAME optimized build and
score; (2) ARSENAL DOMINANCE - for any real weapon W, optimize(pin W2=W) >=
optimize(pin W2=Net_Basic) within tolerance, because the W-plan set strictly
contains net-equivalent plans. The full ladder for the test bank: Axe 806.2,
GA 796.6, Sword_Start 767.8, Spear 758.4, Net 715.3, Shield_Craft 714.3,
Mace 669.9 (GS_Nova mainhand, dummy, 75s, restarts 3).


## Measured on build 25782799 — 2026-10-13

The first ground truth on the September 30 update. Until this night every
rule the model carries on the new build was READ - from `data.cdb`, the
scripts and the bytecode - and nothing was measured, because the capture
chain did not load: the HLX loader's vendored HashLink stopped at bytecode
v5 and the build ships v6. The loader and the probe were rebuilt (bench-probe
v10, 15 of 15 hooks installed) and two driven sessions were recorded on the
training dummies in Tyrna.

**Where it is.** `hlx/logs/bench-probe.csv` in the install, about 56 MB. The
two driven sessions are its first 618,799 lines: two `session` rows
(2026-10-13 00:20:49 and 02:12:35 local time), the last row of the second
at 03:33:45 (`ts_ms` 1791855225136), each session row carrying
`probe=v10;boot_bytes=14789204;boot_mtime_ms=1791451286000` - the size and
time of this build's `hlboot.dat`, which is what makes a row evidence about
THIS build (`bench update` prints it on its CAPTURE line). The driver's
journal names every recorded block with its start, its end and the keys
pressed (156 blocks; the last ends 03:33:09). Columns and row kinds are in
`src/capture.mjs`. The file grows at every login: as this is written it
holds 622,495 lines and a third `session` row (07:54:12, the Mage, 15 hits
on two dummies, in no journal block), so the Mage's default `bench verify`
window and the CAPTURE line reach into rows this section does not describe.
Give a window (below) and they do not.

**The capture predates the two hotfixes.** Its session rows name an
`hlboot.dat` of 14,789,204 bytes written 2026-10-08; the one installed since
2026-10-15 (build 25959898) is 14,797,138 bytes, and every ledger read from
this capture now opens by saying the window is another build's. The model
side of a ledger prices the installed rows. One row the hotfixes moved
reaches a line of this section: Knives Tempest's Shred
(`Rogue_KnivesTempest_Status2`, -20% Armor) lasts 10s on 25959898 where it
lasted 3s when the Rogue was logged. Put back to 3s (one row patched as the
sheet is read, nothing else), every ledger quoted below prints what it
printed on build 25782799, line for line; with the installed row only the
Rogue's rotation blocks move, and both figures are in the table.

**Who.** Four level-25 characters; builds come from the probe's own `snap*`
rows. Emsai, Warrior, Judgement in the main hand, no talent allocated. Emsay,
Mage, no talent allocated. Emsei, Priest, 11 talents. Emsey, Rogue: from no
talent, to Lethal Poison alone, to 15 points spent one at a time, each click
writing a new `snap_talent` set.

**How to reproduce a number.** One journal block at a time, ordinary hits
against ordinary hits. The times are the log's own `ts_ms`:

```
bench verify --character Emsai --target Dummy --since 1791844203301 --until 1791844271325 --split
bench verify --character Emsai --target Dummy --window 1791850432628..1791850511780 --window 1791850518640..1791850597754 --split
bench verify --character Emsay --target Dummy --window 1791846350797..1791846411249 --replay --split
bench verify --character Emsey --target Dummy --window 1791848312667..1791848386858 --behind-fraction 1 --split --fight 74
bench verify --character Emsey --target Dummy --snapshots
```

The first is the Warrior's sixty-second chain, the second her two blocks of
lone Rampage presses, the third three Static Nova presses replayed at their
own times, the fourth the Rogue's chain hit from behind, the fifth the list
of her eighteen snapshots with what each changed. The bare command
(`--character <Name> --target Dummy`) reads the whole span of a snapshot
instead, and that is NOT one fight: the ledger says so above its table, and
its per-hit column is then a mix of states before it is a formula (the
Warrior's reads Rampage +41.9% where the second command reads 852.5 against
853). Three comparison rules a ledger rests on are at the end of this
section.

Everything below is MEASURED unless a sentence says "reading" or "inferred".
"Priced" is the model's figure before the ceiling the log applies; "logged"
is the integer in the rows.

### The log itself

- **Every yard dummy is the unit `Dummy` at level 1.** All 21,868 damage rows
  on a `Dummy#` target in the two sessions carry `tlvl=1`, over 27 dummy
  instances and every player in the log; the three dummies of one yard take
  identical damage. So the level the model stands the dummy at is settled.
- **The dummy's armour is the level-1 pool of its row.** Hits that do not
  vary land on it to the integer. A level-25 Warrior at 48.3% penetration
  gets 0.9453 of a hit through, and four lines that carry no spread log the
  ceiling of their price: Rampage at full charge 852.5 priced, 853 logged
  (nine presses of nine); Raging Smash 247.4, 248; Tear Reality 323.0, 324;
  Charge 231.9, 232. Rampage's and Charge's are what a ledger of their own
  block prints; Raging Smash's and Tear Reality's are the bare prices, which
  a ledger overstates by Domination's averaged bonus (the Warrior section).
  A pool built at the striker's level (0.600 through at no penetration) or
  no pool at all (1.000) cannot produce those integers.
  The 89.9% of the model's dummy is this same pool at no penetration; it was
  not isolated on a character with none.
- **The log writes the CEILING of a hero's direct hit.** Five lines that do
  not vary: Judgement's finisher priced 229.3 and logged 230, its second
  strike 144.3 and 145, its critical strike 352.4 and 353, and under
  Worldsplitter's +30% 298.1 and 299, 187.6 and 188. Rounding misses four of
  the five and flooring all five. On a 15-damage swing the ceiling alone is
  3%, which is why `bench verify` compares a whole-number stream with the
  model's figure plus a half.
- `hits=` in `extra` is a running counter, not hits per cast. A held basic
  chain writes no `press` row. `snap_attr` is dead (zeros); `snap_sheet` and
  `snap_hattr` carry the numbers.
- A head sigil's talent never gets a `snap_talent` row: the Rogue's Venomous
  Assassin and the Warrior's Surge of Violence were active without one.
- **A summon's hits are logged with the OWNER as `source`** and a `Summon_*`
  skill id (`Summon_Imp_Auto`). The 2026-08 probe logged them under a summon
  source; any filter written for that has to change.
- Other players are in the log (the yard is public): filter by `source`.

### Warrior — Domination's register (second session)

Emsai, Judgement (`GA_Craft`), one dummy; the ×1.150 below is the
register's amount from weapon rank 2 up, so the weapon is at rank 2 or above. Key 1 is
Rampage (`GA_Craft_Skill1`), key 2 Shockwave (`GA_Craft_Skill2`), key 3 Tear
Reality (`GA_Demon_Skill1`, the OTHER weapon's skill).

| sequence | n | crits | mean non-crit | mean crit |
|---|---|---|---|---|
| Rampage at full charge, nothing up | 10 | 1 | 853 (no spread) | 1310 (natural) |
| Charge, then Rampage at full charge | 10 | 10 | - | 1507 (no spread) |
| Charge, then Shockwave | 3 | 3 | - | 551 |
| Shockwave, no register | 2 | 0 | 320 | - |
| Charge, then Tear Reality | 3 | 3 | - | 571 |
| Tear Reality, no register | 3 | 0 | 324 | - |
| Charge, 5s of basic attacks, Rampage at full charge | 5 | 5 | - | 1573 |
| Surging Force (a stun), then Rampage | 2 | 2 | - | 628, 628 (short charge) |
| Shockwave (a stun), then Rampage | 3 | 3 | - | 1507, 628, 1005 |
| Raging Smash, then Rampage (the control) | 3 | 0 | 569, 356, 356 | - |

- A stun the Warrior applies puts `GA_Craft_Passive_Proc` on the Warrior in
  the same millisecond as the Stun (`dur=0`). The target need not still be
  stunned when the skill lands - Charge's 1s stun had ended 2.6s earlier -
  and the register did not time out in 82.9s.
- It is spent by the hit of Rampage, of Shockwave and of Tear Reality. It is
  NOT spent by basic attacks or the chain finisher: 35 basic rows passed
  under it. Raging Smash and Tear Reality's debuff do not arm it. Shockwave
  re-arms it with its own stun.
- Beyond the crit: armed crit over non-crit is ×1.767 against a natural
  ×1.536, i.e. ×1.150 on top, at all three charge levels (628 / 356,
  1005 / 569, 1507 / 853). Tear Reality: 571 / 324 = ×1.762. Shockwave:
  551 / 320 = ×1.722, where its natural crit in the first session was 492.
  That one is the same rule in a fuller bracket: Shockwave stuns, so its own
  hit already carries the rank-3 +0.25, and the register's +0.15 sums with
  it - (1 + 0.25 + 0.15) / (1 + 0.25) × the crit multiplier 1.5366 = 1.721.
  The armed hit is priced 548.8 against the logged 551.

**The model on these blocks** (`--split`, each block alone): Rampage at full
charge 852.5 / 853 ordinary (9) and 1309.9 / 1310 critical (1); armed, 1526.9
priced against 1507 logged (8), +1.4%; Charge 231.9 / 232 (12 over two
blocks) and 356.4 / 357 critical; Shockwave armed 548.8 / 551 (3), unarmed
322.5 / 320 (2); Tear Reality armed 574.5 / 571 (3), unarmed 339.3 / 324 (3),
+4.9%; Raging Smash 261.1 / 248 (3), +5.5%; Surging Force 155.1 / 155 (2).
The three lines that read 1.4 to 5.5% high are one approximation and not
three formulas: Domination's rank-3 +0.25 on OTHER casts is paid at the
share of the fight a stun stood, where the game pays it hit by hit - Raging
Smash outside any stun logs its bare 248. Both numbers are in `bench audit`;
paying it per hit means carrying crowd control as state of the foe in the
fight, which is open.

That is the script of the row to the digit: `ctx.critChance = 1` and
`ctx.dmgMult += 0.15` on the next weapon-skill use, whichever weapon grants
the skill. What it does not reach: a target that REFUSES the stun. The dummy
takes it.

**Rampage is hold-to-charge with three levels**, by time from press to hit:
under 2.25s 356, 2.25 to 3.2s 569, auto-release at about 3.25s 853 - the
authored 2.5 : 4 : 6 × Strength, to the integer. 12.0s cooldown from its hit.
A tap does nothing.

**The basic chain** (60s held, second session, block P1e): `GA_Base_Attack`
/ `2` / `3` at 14 rows each, non-crit means 112.3 / 108.7 / 110.8, crits
4 / 3 / 2 at 155.8 / 174.7 / 176.5. First session: block B-dummy-first, ten
swings a link, 110.6 / 110.0 / 109.1; block C-basic-chain, 17 ordinary
swings a link, 113.2 / 111.4 / 108.3 (ranges 102-123, 103-123, 92-122)
against a priced 112.3 - the model -0.4%, +1.3% and +4.1% from the three
links. The critical swings of that block read 164.0 / 168.0 / 164.0 over
3 / 2 / 2 against 172.5; too few to hold a multiplier to. Its crit RATE is
the open number: the model's chain crits 21.7% of the time with the
Raclette Pan at ten stacks and the block logged 15.0 / 10.5 / 10.5%; over
both sessions, at ten stacks with Battle Shout down, 62 critical of 385
swings and finisher rows, 16.1%. The read stands and `bench audit` carries
both.

**Brutal Frenzy's second strike** (`GA_Craft_FinalCombo`). In block P1e,
counted row by row: 16 rows are 13 finishers and 3 second strikes. Each
second strike lands 93 to 102ms after its finisher at 0.63 of it - 145
after 230, 188 after 299, a critical 256 after 265 - which is the row's
`0.9 × Strength` step over its `1.43 × Strength` one. The strike rolls again
on its own hit (its hook's guard is the finisher flag, and the step it plays
is the finisher's own): over both sessions 112 finishers were followed by 28
second strikes, 8 third, 4 fourth and 2 fifth - 42 strikes, 0.375 a
finisher, where one roll at the authored 25% gives 0.25 and a roll that
repeats 0.333, which is what the model prices. The finisher itself reads 230
plain and 299 under Worldsplitter's passive, Resilience of the Unkillable
Demon King (+30% on a finisher pressed while it is ready; it came back 5.5
to 7.5s after being spent, and 14 of 39 finishers found it up: 299 against
230, 188 against 145 on the second strike); 213, 221 and 265 are in the
rows too and were not decomposed here. The model's FOLDED row for block
C-basic-chain reads 228.9 against a logged mean of 242.4 over 20 rows
(145 to 299), -5.4%: a mean over finishers, second strikes and boosted
finishers in whatever mix that minute held, which is not the price of any
one of them.

First session, isolated presses, no spread: Charge 232 ×3, Surging Force
154 ×2, Raging Smash 248 ×2.

### Rogue — Lethal Poison and the reworked tree

Emsey, both sessions. Each talent step is three 27.6s rotations (six keys
with the basic attack held) and 20s of basic attacks; Shadowstep was left out
of every rotation; Venomous Assassin was active throughout from the head
sigil, the reference rotation included.

**The gate.** Doses are statuses on the target: a counter
(`Rogue_Talent_LethalPoison_Dose`) and one marker per kind - `_Dose_FCA`,
`_Dose_WeaponSkill`, `_Dose_ClassSkill`, `_Dose_Finisher`. One dose per kind.
60s of basic attacks alone lays only `_Dose_FCA` and the poison never
appears. The third kind applies `Rogue_Talent_LethalPoison_Status` (duration
20) in the same millisecond and every dose row goes off.

**Which casts lay a dose: only one that lands a hit of its own.** With the
root talent held, 27 presses of Death Mark and 25 of Urge to Kill laid none.
Shadowstep laid the class-skill dose 18 times of 18 and Knives Tempest 83
of 85; Infernal Plunge the weapon-skill dose 223 of 269, and Gaping Wound,
pressed after it in every cycle, 23 of 103 (the kind was already held); 279
of 680 final combo attacks the Final-Combo dose and never another; 3,661
basic hits none. Smoke Bomb was never pressed.

**The poison.** Ticks are Magic, 69 or 71, every 2.0s, the first 1.95s after
application. Both values occur inside ONE application: the tick is priced
against what the target wears when it lands (68.95 and 70.01 priced, as the
15% armour break of Chaos Scorch comes and goes), while the applier's side
is what it was at the application. A third dose while the poison is up gives
a Physical row under the SAME skill id - the direct hit, 272 - and restarts
the 20s; the tick phase is kept. The first application deals no direct hit:
the status went on 24 times with the Rogue as source and the dose counter
emptied 272 times, those 24 and 248 direct hits, every one of the 248 on a
target already wearing her poison. In a rotation: about one direct hit per
6s, and the poison never drops.

**The tree's tier markers** (1 / 3 / 7) count points spent in the rows above
OF THE SAME BRANCH.

**Point by point**, in the order they were spent. The talent names are the
game's; what each tooltip promises is paraphrased, with its numbers, and the
verbatim text is in the driver's journal:

| # | talent | what the rows did |
|---|---|---|
| 1 | Envenom (50% on a base attack against a poisoned target, 35% Dexterity as Magic, refreshes the poison) | a new skill id, `Rogue_Talent_Envenom`: one Magic row on about half of basic hits (76 of 149, 21 of 43), 61-72 non-crit, 92-109 crit. No status |
| 2-3 | Powerful Toxins (+10% / +20% to poisons; snapshot id `Rogue_Talent_LethalDose`) | tick 69-81 → 76-88 → 83-95; direct hit 272 → 301 → 327 (×1.10, ×1.20). Envenom and the dagger poisons unchanged |
| 4-5 | Deadly Poison (+25% / +50% crit chance on the direct hit) | direct-hit crits 5 of 96 without it, 2 of 12 at one point, 73 of 140 (52%) at two. The 5 are not a chance of its own: all five fell among the 47 direct hits landed with Gaping Wound's status on the target, none among the 49 without |
| 6 | Acidic Splatter (20% per Combo Point on the Finisher; 150% Dexterity Magic over 6s; -10% Armor and Magic Resistance) | status and skill id `Rogue_Talent_AcidicSplatter_Status`, duration 6, a tick every 2.0s, 105 base (104.48 priced with Powerful Toxins at two points); a refresh lengthens it; the roll is 20% a Combo Point on the points the Finisher FOUND - it went on 2 times in 7 at one point, 2 in 5 at two, 9 in 15 at three, 20 in 23 at four, 64 in 64 at five, 97 of 114 where the rule expects 94.8; it ALSO lands on the two far dummies across the yard |
| 7-8 | Noxious Stratagem (15% / 30% per Lethal Poison hit to give weapon skills 0.5s back; snapshot id spelled `Rogue_Talent_NoxiousStrategem`) | no row of its own; at two points one weapon skill fired 6 times a step instead of 5. Gaping Wound taps that came 1.1s short of its cooldown fired 0 of 19 without the talent and 18 of 24 at two points |
| 9 | Venom Infusion (each direct hit adds a stack: +2.5% Lethal Poison damage, 45s, up to 20) | `Rogue_Talent_VenomInfusion_Status` on the dummy, duration 45, +1 stack per direct hit (11-17 a step, never 20). Tick 85 at no stacks, 104-107 at twelve. Direct hit 338-406 |
| 10-11 | Improved Mixture (a stack per dose, up to 5; the Final Combo Attack spends them for +15% / +30% each) | `Rogue_Talent_ImprovedMixture_Status` on the Rogue, duration 0, +1 per dose, at most 3 then 5, removed by the Final Combo Attack. Demonic Bite (`Daggers_Demondash_Combo`) 72-85 → 73-119 → 72-193. The Finisher is unchanged |
| 12-13 | Intent to Kill (+2% / +4% periodic damage per poison on the target) | no row of its own; periodic rows rise - Acidic Splatter 105 → 107 → 108-112, Gaping Wound 165-189 → 171-209, the Finger of Sukuna'Maatata's tick 37-42 → 47-54. The count is of every Poison-typed status the target wears, the poison itself included, doses and Venom Infusion not: Gash at five stacks 115 with one poison up and 125 with two |
| 14 | Opportunity Strike (a 30% chance of a second strike on a base attack that triggers Envenom) | NOTHING visible: Envenom rows per basic hit 93 of 187 (50%) against 272 of 526 (52%) before; no doubled row, no new id, no status. Over everything from the snapshot that first holds the point: 381 basic-attack rows, 187 Envenom rows, and not one swing with a second row of itself where 30% of the 187 would be 56 |
| 15 | Finish the Job (+5% / +10% crit chance against poisoned enemies) | basic crits 19% of 194 in its step, inside the 13-23% spread of the fourteen steps before: one point (+5%) cannot be told from none on this sample |

Rotation damage per second by step, reference first: 364, 435, 446, 447,
454, 473, 562, 541, 543, 579, 590, 608, 586, 608, 620, 634. Those figures
are over all three dummies of the yard: from the sixth point on, Acidic
Splatter and the curse it rolls land on the two neighbours as well. On the
dummy being fought the sixteen steps pool to 505.7 a second over the time
in play, and 36.5 a second more fell on the two beside it.

Two readings, marked as such. The glossary line under Improved Mixture's
node says "next Signature Skill"; the rows follow the talent's own text (the
Final Combo Attack), not the glossary. And the direct hit critting with no
crit talent held (5 of 96) is not a chance of its own: it is the crit grant
of Gaping Wound's status, which hands every Bleed-, Poison- or Burn-typed
status hit on its wearer the applier's crit chance. The grant reaches Raw
ticks too - Gaping Wound's own bleed crit on 51 of 389 ticks, the Finger of
Sukuna'Maatata's curse on 32 of 517, Gash on 65 of 968, Lethal Poison's tick
on 72 of 1,278 - and not one of the 92 ticks in the two sixty-second blocks
that never pressed Gaping Wound was critical.

**Position.** `Daggers_Base_Attack` to `4` hit about ×1.27 harder from one
side of a dummy than from the other (14.0-15.3 against 18.7-19.6 on the same
dummy); the finisher, the poison ticks, Flaming Weapon and the trinket do not
change. No status row marks it. (The behind perk measured at +23.2% on
2026-08-11 is the same shape.) READ: it is the daggers' upgrade perk. The
script of `Daggers_Upgrade` adds `vars.damage` to a basic attack that does
not face its target, 0.08 on the row and 0.10 / 0.12 / 0.14 / 0.16 by
rarity; this Rogue wears an Epic pair and a Legendary pair, 0.12 + 0.14,
×1.26. The model carries it at an assumed share of swings (0.41), so a
ledger of a block hit from one side needs `--behind-fraction 1` or `0`:
the chain block from behind reads 18.1 priced against 18.5 / 19.1 / 18.4 /
18.7 logged by link, and the two front blocks 14.4 against 14.6 / 15.2 /
15.1 / 15.1.

**Per state, priced against logged.** Where the state of a hit is known the
price is the logged integer's float. From the isolated presses (journal
blocks D1, one key at a time): Infernal Plunge critical 248.4 / 249; Gaping
Wound 168.0 / 168, its bleed 164.3 / 165 and 249.7 / 250 critical; Shadowstep
critical 135.9 / 136; Knives Tempest 181.3 / 182. The Finger of
Sukuna'Maatata's curse 36.25 / 37, and 40 and 44 logged with Powerful Toxins
at one and two points: a trinket's status is scaled through its ITEM alone
and spread over its ticks (the 45.00 of the 2026-08 capture was the previous
build's rule). Gash reads 17 / 20 / 82 / 90 / 97 / 104 / 112 / 115 / 125 by
how many other statuses of the Rogue's the target wears and by stack; what
counts is settled: the Chaos Mark does, the hidden Lethal Dose marker does
not. Its amount is paid over four ticks (nine seconds at two a tick, floored).

**Combo Points and the Finisher.** The Finisher adds 30% a point it finds
and takes them all: 181 with no point, then 237 / 290 / 344 / 398 / 452 with
one to five (with the +10 penetration of Gash's passive up; 179 and 448
without it). Nothing gates the press on a point. Over the sixteen rotation
steps 182 Finishers held 740 points, 4.07 each - 10 at one, 17 at two, 24
at three, 31 at four, 100 at five. The points follow the row's rule, a
weapon skill or a final attack paying when it is another skill than the last
one that paid: replayed over the rows it gives the logged count on 157 to
160 of 181 Finishers, where paying every weapon skill and every final attack
gives it on 100 to 107. Death Mark's +15% sums with the attacker's own
riders (456 to 484 logged, where a factor would give 524). Urge to Kill
does what its row says and the model prices none of it: all 66 Finisher
taps inside one of its 31 windows fired, 4.1 to 5.5s apart.

**Improved Mixture.** One stack per NEW dose (262 stacks for 262 dose rows),
spent by a final combo attack and never by the Finisher: 138 spends, all at
a Demonic Bite, holding 1 to 5 (60 / 45 / 26 / 1 / 6 times).

**Venomous Assassin** follows its script and not its tooltip: over 224 final
combo taps the script's reading (2s only when the dose is absent after the
dose pass) mispredicts none, the tooltip's 21.

**A cast and the swing in progress.** A skill whose row authors
`interruptStyle` cuts the swing; every other one waits for it to end.
Infernal Plunge, Gaping Wound and the Finisher opened inside a running link
on 480 of 492 uses, Death Mark, Knives Tempest and Urge to Kill on 0 of 107.
A link closed before its hit step lands nothing: of 3,145 links started in
the rotations 480 were closed by a cast and 338 of those wrote no damage row.

**The chain's round.** 1,941ms from first link to first link in the second
session (n 224) and 2,005ms in the first (n 59), against 1,850 authored.
Between one link's end and the next link's start the hero is Free for 10ms
(second session) or 17ms (first), and five links plus five such gaps are the
round to the millisecond. That the gap is one frame of the client is
INFERRED from how far apart it writes its rows, not read. Nothing is priced
for it: every line that rides the chain is over-rated by 4.9% to 8.3% in
RATE and by nothing per hit.

**Flaming Weapon and Gash on a two-instance finisher.** `onInflictHit` rolls
once per hit and `onInflictDamage` once per damage instance: Demonic Bite is
one hit of two damage instances, and Flaming Weapon came with 252 of 827 of
them and never twice beside one, while Gash's application (20% in
`onInflictDamage`) came with 314, 38.0%, where two rolls give 36%.

### Mage - Queen's Decree, the imps, the conduits

Emsay, first session: Intellect 159, Fervor 7.476, CritChance 22.1, Cooldown
Reduction 4, no talent; Silhouette of Almaz in hand, Wingsabers in the
arsenal with Queen's Decree and Swarmstrike Accord slotted. The probe could
not read her conduit slots; the rows say Conduit: Power three times over
(its status rose three stacks at a time, 36 times, and no row of Conduit:
Shard).

- **Queen's Decree** (the arsenal passive) adds 1 INSIDE the damage bracket
  of the next magic skill that finds it ready - (1 + mastery + Fervor) ×
  DamageModifier + 1, ×1.930 on this sheet, not ×2 - and goes on a 20s
  cooldown (19.2 with her Cooldown Reduction). Static Nova with it 450.0
  priced, 451 logged, and 693.0 / 694 critical (three lone presses 25s
  apart, each of which found it ready). Spark Beam with it 150.0 / 151 and
  231.0 / 232 critical; without it 79 logged with three Power stacks up,
  78.8 priced.
- **Its rank-3 clause** strikes on every critical hit of another skill of
  the owner while the cooldown runs: 22.4 / 23 and 34.4 / 35 critical. 41
  rows in the capture: the 40 own critical hits landed on cooldown and the
  cast that spent it; none of the 110 while it was ready, none for 12
  critical imp swings.
- **Demonic Discharge** spent the Decree on all but one bolt of a press: 58.4
  priced, 59 logged, and 89.9 / 90 critical, with one bolt of each press at
  30.2 / 31. The presses counted 3, 20, 20, 20, 7, 19, 7 and 10 bolts. READ
  and MEASURED: that one bolt is on a hit context of its own (`hits=1` on 8
  presses of 8). That it is the last one shot is INFERRED; it lands 3rd of
  3, 20th, 19th and 20th of 20, 6th of 7, 16th of 19, 7th of 7 and 10th of
  10, and it does not land after the cast (bracketed bolts land after
  `skill_end` on all three twenty-bolt presses).
- **The imps** (`Summon_Imp_Auto`, logged with the Mage as source): 31.1
  priced against 31.0 over 7 ordinary rows of a replayed block (28 to 33,
  the swing band); 23 of 56 swings critical where the script's +15% joins
  the CHANCE (37.1% priced). They are priced on the dummy's level-1 pool
  like her own hits, which answers what a dummy with no armour could not.
- **One charge per imp hit.** 45 of the 48 imp swings that found room in the
  bank came with a charge of Demonic Discharge inside 3ms; 8 more landed on
  a full bank. The combat timer's own charges come 2.96s apart.
- **Chaos Bolts** (the staff's finisher) rolls its reset per bolt: 47
  applications in 268 bolts, 17.5%, and 35 of 67 finishers with at least
  one (one roll a finisher would give 20%). Its bolt 55.1 / 53.9 in the
  chain block, which opened at Spark 35.8, under the gauge.
- **Spark is spent, never required.** Summon: Vile Imps went off at 17.4 of
  its 19 and Swarmstrike Accord at 5.85 and 1.95 of 29.
- **Inner Demon's clock** opens ready and came back 19.26 to 19.74s after
  each of twelve spends (20 × 0.96).
- **Mystic Empowerment and the latch.** Its status went on its own caster
  (33 of the log's 39 rows have source and target the same; her 5 of 5).
  Cooldown Reduction is read when a cooldown STARTS and held for it: a 20s
  clock begun under the status, which ended 4.9s in, took 13.03s (13.2 if
  latched, 17.0 if the rate followed the status); three begun before it,
  with the status arriving 9.9 / 3.1 / 8.2s in, took 18.99 / 19.68 / 19.26s;
  21 that never met it 18.98 to 19.74s.
- **The staff's swing is two states.** 26.5 priced against 27.1 logged over
  the 14 swings without the +10 MagicMastery its finisher's rank-3 clause
  gives for 10s, 28.9 against 29.0 over the 28 with it; by link the block
  reads 28.8 against 28.6 / 27.5 / 28.9 (14 / 13 / 15).

### Priest - the auras, the prayers, Sunlight

Emsei, first session: Strength 57, Dexterity 40, Faith 141, Fervor 9.16,
CritChance 7.5, eleven talents and Solar Devotion from the head sigil;
Beefury in the main hand.

- **An aura that follows its wearer has no hit at spawn.** Hive Swarm: first
  row 0.95s after the press, ten in ten seconds, 43.9 priced and 44 logged
  (45 while Hive's Sunder's debuff stands: 44.8); over a replayed block 44.2
  against 44.3 on 29 rows. Swirling Embers: eight rows, 95.0 / 95, 144.0 /
  145 critical. The floor Radiant Verdict's Consecration rune lays IS an
  instantiated area: a row 0.34s after the press and three more.
- **A slotted rune restates its row's vars.** Radiant Verdict under
  Consecration: four floor rows of 40.4 / 41 where the row alone gives five
  of 31; the direct hit 181.96 / 182 and 276.0 / 277 critical.
- **A status step a swing plays is not "an attack".** Purging Strikes crit
  on 30 of 302 hits (9.9%) and Sunlight on 9 of 65, where the swings that
  played them crit on 83 of 544 (17.6%): Zealous Fighter's chance and Might
  of the Executioner's crit damage sit behind a base-attack-or-finisher test
  the status's step does not pass.
- **Swarm, the poison of Beefury's passive,** is rolled on Hive Swarm's
  hits, not on swings: 10 rows for 29 swarm hits in the block of lone
  presses, 23.5 / 24, and none in the chain block (132 hits). It is also the
  one foe-worn status the tick rule was measured on: over the capture's 107
  ticks it logged 25.5, where pricing off the unit that APPLIED it gives
  25.3 and off the unit wearing it 21.7; none of the 107 was critical at a
  sheet crit chance of 15.6%.
- **Prayers.** One Smite per enemy in reach per release: 51 rows are 17
  releases × the yard's three dummies. 19 Judgment presses, 17 released a
  Smite; the 2 that did not had no finisher since the last release.
  Blessing of Fervor came back 107.0 and 102.5s after a press in the
  rotation (Surge of Faith, a second off per prayer judged - read, not
  priced), Crusader 129s.
- **Sunlight.** With Solar Devotion nothing spends it: 65 of 65 finishers
  inside a Sunlight, 18 statuses all ended by expiry. Faithful Winds' lane
  hits its caster every 0.5s for 10s and each hit puts Sunlight back up; she
  stood in her own lane on 15 casts of 15.
- **Base attacks.** Beefury 14.6 priced against 15.0 / 15.1 / 15.1 logged by
  link (28 / 25 / 29), the finisher 110.0 / 109.8 (28). Beefury's upgrade
  perk is a second HIT (231 swings with one Purging Strikes row, 11 with
  two), not more damage on the first.
- **Other anchors of the replayed lone presses**: Hive's Sunder 261.1 / 262,
  Depth Shield's orb 111.8 / 112.5 (4).

### The model against the capture, before reconciliation

Per hit, model minus capture, each character's whole snapshot span on the
dummies (`bench verify --character <Name> --target Dummy --sessions 40`), on
the tree as it stood on 2026-10-13 when the capture landed. These are the
numbers the reconciliation STARTED from, not its result, and they are kept
as the record of that night. Each is a mean over a whole span, which is
what the next section takes apart.

- **Warrior** (Emsai, 498 events, 10 lines, coverage 100%; 4 match / 3 close
  / 3 miss; sheet 9 of 9 within 1%): Brutal Frenzy +0.7%, Shockwave -1.4%,
  Raging Smash -1.4%, Charge +2.5%, Tear Reality +6.2% (3 hits); base attacks
  +8.7 / +7.6 / +11.9%; Surging Force +21.0% (6 hits). Rampage +41.8% is NOT
  evidence as it stands: that window mixes its three charge levels and the
  armed crits, and the model prices every cast at full charge.
- **Priest** (Emsei, 1,688 events, 13 lines, coverage 100%; 6 / 4 / 3; sheet
  10 of 10): Hive Bite +1.3%, Hive's Sunder +1.9%, Prayer: Smite +2.2%,
  Sunlight +2.8%, Depth Shield's orb +3.5%, Purging Strikes +1.6%, the Swarm
  poison -0.8%; base attacks +8.7 / +5.3 / +6.8%; Swirling Embers +10.4%,
  Hive Swarm +12.6%; Radiant Verdict -11.3%.
- **Rogue** (Emsey, 1,839 events, 16 lines, coverage 100%; 7 / 6 / 3; sheet 9
  of 9): Knives Tempest -0.6%, Infernal Plunge +2.0%, Void Fangs +2.6%,
  Demonic Bite +3.1%, Gaping Wound's tick +3.0%, Gash -2.1%, Flaming Weapon
  +2.4%, Shadowstep +5.1%; base attacks -4.7 to -7.3% (the window mixes the
  two sides of the position effect above); Gaping Wound's hit +18.4% (13
  hits), the Finger of Sukuna'Maatata's tick +23.5%, the Finisher +24.7%, the
  burn of Chaos Scorch (`Daggers_Demondash_Passive_Status`) +61.3%.
- **Mage** (Emsay, 763 events, coverage 91.8%; 1 / 4 / 3; sheet 11 of 12):
  base attacks +2.6 to +6.0%, Chaos Bolts +6.2%, Swarmstrike Accord's status
  +5.7%; Demonic Discharge -25.0%, Spark Beam -21.4%, Static Nova -35.8% (6
  hits); and two lines the model does not have at all, MISSING -
  `Summon_Imp_Auto` (56 hits, 39.7 a hit: the imps' own swing, under the
  owner's name) and Queen's Decree (`DS_Bladeleaf_Passive`, 41 hits, 28.1).

Three patterns stood out that night: base attacks 3 to 12% over on three of
four weapons, three Mage spells 21 to 36% LOW, and a sheet that was exact
everywhere it was checked, so none of it was gear. What each turned out to
be is the next section.

### The model against the capture, after reconciliation

The same whole-span command on the final tree (build 25959898's data) is no
better a verdict than it was, and says so itself: a span is several stretches of play that were not
played alike, and the model plays one fight. For the record it reads Warrior
3 match / 3 close / 4 miss (Rampage +41.9%, base attacks +9.1 / +8.0 /
+12.3%, Brutal Frenzy +12.8%), Mage 0 / 6 / 4 with nothing MISSING and
coverage 100%, Priest 11 / 2 / 0, Rogue 2 / 11 / 2 with the Chaos Scorch
pool judged on its share. The verdicts are per block:

| character, block (window) | line | priced / logged (n) | model minus capture |
|---|---|---|---|
| Warrior, C-basic-chain | base attacks, ordinary, by link | 112.3 / 113.2, 111.4, 108.3 (17 each) | -0.4 / +1.3 / +4.1% |
| | base attacks, critical | 172.5 / 164.0, 168.0, 164.0 (3 / 2 / 2) | +5.5 / +3.0 / +5.5% |
| Warrior, P1a (two blocks) | Rampage, full charge | 852.5 / 853 (9); 1309.9 / 1310 critical (1) | 0.0% |
| Warrior, P1b-armed-2 | Rampage armed | 1526.9 / 1507 critical (8) | +1.4% |
| | Charge | 231.9 / 232 (7) | +0.2% |
| Warrior, P1c-charge-key2 | Shockwave armed | 548.8 / 551 critical (3) | -0.3% |
| Warrior, P1c-charge-key3 | Tear Reality armed | 574.5 / 571 critical (3) | +0.7% |
| Warrior, P1d-what-arms | Shockwave / Tear Reality / Raging Smash / Surging Force | 322.5 / 320 (2); 339.3 / 324 (3); 261.1 / 248 (3); 155.1 / 155 (2) | +0.9 / +4.9 / +5.5 / +0.4% |
| Mage, C-basic-chain | base attacks, ordinary, by link | 28.8 / 28.6, 27.5, 28.9 (14 / 13 / 15) | +2.2 / +6.6 / +1.1% |
| | Chaos Bolts, a bolt | 55.1 / 53.9 (63) | +3.0% |
| Mage, D-key-G-adjacent, replayed | Static Nova | 450.0 / 451 (2); 693.0 / 694 critical (1) | -0.1% |
| Mage, D-skills-cycle1a, replayed | Spark Beam; the imps; the Decree's strike | 150.0 / 151 (2); 31.1 / 31.0 (7); 22.4 / 23 (3) | -0.3 / +1.9 / -0.6% |
| | Demonic Discharge, the block's MEAN | 37.4 / 57.4 (18) | -34.0% (the model's bank, below) |
| Priest, C-basic-chain | base attacks, ordinary, by link | 14.6 / 15.0, 15.1, 15.1 (28 / 25 / 29) | +0.6 / 0.0 / +0.1% |
| | Hive Bite (the finisher) | 110.0 / 109.8 (28) | +0.6% |
| Priest, D-skills-cycle1, replayed | Hive Swarm; Swirling Embers; Hive's Sunder; Swarm | 44.2 / 44.3 (29); 95.0 / 95 (7); 261.1 / 262 (1); 23.5 / 24 (10) | +0.7 / +0.5 / -0.1 / -0.2% |
| Rogue, no-talents-C-basic-chain, behind | base attacks, ordinary, by link | 18.1 / 18.5, 19.1, 18.4, 18.7 | +0.8 / -2.6 / +1.3 / -0.1% |
| | Demonic Bite; Gash; the curse; Flaming Weapon | 56.1 / 56.5 (45); 81.0 / 77.5 (31); 36.3 / 37 (18); 9.9 / 10 (33) | +0.2 / +5.2 / -0.7 / +3.5% |
| Rogue, two front blocks, `--behind-fraction 0` | base attacks, ordinary, by link | 14.4 / 14.6, 15.2, 15.1, 15.1 | +2.0 / -1.8 / -1.4 / -1.6% |
| Rogue, no-talents-E-rotation (226s) | Finisher | 304.3 / 379.4 (22, 179 to 486) | -19.7% (the points held, below) |
| | Gash; base attacks | 105.8 / 96.7 (102); 19.3 / 18.3 to 18.7 | +9.9%; +5.5 to +7.8% |
| Rogue, fifteen points (92s) | Lethal Poison's tick; its direct hit; Envenom; Acidic Splatter | 104.9 / 106.4 (39); 402.9 / 422.2 (5); 64.3 / 64.5 (58); 119.5 / 121.3 (17) | -0.9 / -4.4 / +0.6 / -1.1% |
| | Finisher; Infernal Plunge; Gaping Wound's hit | 313.8 / 406.0 (8); 185.8 / 212.3 (14); 211.2 / 178.0 (5) | -22.6 / -12.2 / +18.9% |

The last four rows are priced with Shred at the installed 10s. With the row
at the 3s the Rogue was logged under they read as on build 25782799: the
Finisher 303.3 and Gash 103.6 in the rotation block, its swings 19.2;
Lethal Poison's direct hit 402.0, the Finisher 312.4, Infernal Plunge 185.4
and Gaping Wound's hit 210.2 at fifteen points.

A percentage is after the half point the ceiling adds. What the lines that
do not close are, each said in `bench audit` with both numbers:

- **The Finisher** reads the points it found, not a formula. Every logged
  Finisher is on the 1 + 0.3n ladder; the model's own rotation finds 2.12
  points a press where the capture's held 4.07, because Urge to Kill hands
  out a point a second for ten and the fight does not cast it. With the
  capture's own presses replayed the Finishers price 449.4 a hit against
  455.0 logged.
- **Infernal Plunge and Gaping Wound's hit** are a register, Demonic Bite's
  +25% on the next weapon skill, and who takes it is the order of the
  presses: in every rotation block key 1 took it before key 3 (82 of 82
  Gaping Wound hits unarmed), and the model re-presses Infernal Plunge the
  moment its reset lands, before the next Demonic Bite arms it. Per state
  both are exact (above).
- **Demonic Discharge's mean in a replayed block** is the model's bank: it
  opens empty where the live one stood at twenty, so the replay dumps mostly
  the one unboosted bolt. Per bolt it is closed (58.4 / 59).
- **Gash's block mean** is the count of other statuses at each tick, which
  the model holds a little more often than the hands did; per state it is
  exact.
- **The Warrior's cc share** (Tear Reality +4.9%, Raging Smash +5.5%) is
  Domination's rank-3 bonus paid as a fight average.
- **The Mage's staff, second link** (+6.6% on 13 swings) and **the Warrior's
  third** (+4.1% on 17) are the widest link readings left; the staff's block
  is two states (above), and nothing explains a link reading under its
  neighbours.
- **The Raclette Pan's crit chance**: the capture shows 62 critical of 385
  at ten stacks where the model's chain expects 21.7%. Not written off as
  the die.
- **Chaos Bolts' reset**: the rows roll it per bolt (above) and the fight
  rolls it once a finisher at 0.2. That moves how often Summon: Vile Imps
  comes back, not what a bolt is (55.1 priced, 53.9 logged).

### Three rules a comparison rests on

1. **The log ceils.** A whole-number stream is compared with the model plus
   a half; on a line of 15 a hit the ceiling alone is 3%.
2. **A window must match what was pressed.** One block of play, priced with
   the build standing in it, played as it was pressed (`--replay`) or for as
   long as it lasted (`--fight`), from the side it was fought from. A span
   that holds a held skill's three charge levels, armed and plain presses,
   or a chain block beside a rotation, reads the mix. A window that pressed
   nothing still holds what was pressed before it (`CARRIED-IN`), and a
   press made a few seconds after a chain still stands in the chain's
   statuses: Surging Force logged 178 that way where it is 154 alone.
3. **Rate is only comparable like for like.** Rows a second mean something
   on one fight on ONE target instance over the time in play. The three
   yard dummies are three targets; a model fight of 200s against a block of
   thirty is not the same ramp; and a replay's swings stay on the model's
   clock, so a replay is not the referee of a rate. Like for like, the
   Rogue's own rotation reads +4.5% a second over the sixteen steps (528.5
   against 505.7): its hits 4.1% smaller and 9.0% more numerous. That is the
   tree before the hotfixes, with Shred at the capture's 3s, and the figure
   `bench audit` prints; with the installed row the same sixteen steps read
   530.1, +4.8%, hits 3.8% smaller and 9.0% more numerous.

### What this capture cannot say

Anything about bosses, crowd-control immunity or heroic targets, and any
talent nobody had allocated: the Mage's chain, the Warrior's tree, most of
the Priest's.

Nothing the two hotfix builds changed: Expulse's recast (its aim step gone,
its orbs counted through a new helper), Acidic Splatter's roll under its new script and with a ranged
Finisher, Shred's 10s, the two heroics released on 25959898 (Cheese Station,
Crimson Barracks), and whatever server code moved with them.

Infusion is a half case. None of the four captured characters wears one, so
no amount, no sheet and no set rank is in it. Other players in the same log
do: 9,657 rows of 20 infusion statuses and steps from 33 of them, none with
a build behind it. What those rows hold, each with its counts in `bench
audit`: Seals of Atonement plays once per damage instance of the wearer's
own base attacks and finishers under Seal of Wrath (529 of 529; of the
wearers' 545 such rows 529 are followed by one and the 16 others are each
the last damage their target took; four-bolt finishers 12 / 12, 20 / 20,
4 / 4; none for summons or weapon skills), and its six-piece Smite is there
twice (53, ×2.50 of that wearer's on-attack row); Hive Venom ticks every
2s, linear in stacks, never critical in 334 ticks, each application
restarting the 6s; Fermentation adds one stack per damage instance of a
weapon skill (993 of 1,010, the other 17 each the killing blow); Wet goes on
when a stun is REFUSED by a unit flagged NoStun (4 of 4). What they do not
hold: any amount, the six-piece branches of Hive Venom and Fermentation, a
target immune to crowd control. Two things in them nothing explains: one
wearer's Hive Venom reads 1.47 against the Seals' row where two others read
1.76 (a total over three ticks predicts 1.80), and 23 of 1,016 Fermentation
applications stand beside no weapon-skill row.

### What it settled of the measurements the 2026-10 reads asked for

About seventy readings were asked for while the model was being read on the
new build with no capture to check against. Against this night:

| asked | answer |
|---|---|
| one login and one dummy session on this build with the v10 probe | DONE: both `session` rows carry this boot's size and time |
| Domination's register: does a stun arm a certain crit at ×1.10 / ×1.15 | SETTLED on a stunnable target: every armed weapon skill crit, ×1.150 on top. NOT answerable for an immune target |
| Brutal Frenzy's second strike: its amount, and whether it rolls itself again | SETTLED: 0.63 of the finisher (144.3 priced, 145 logged), and it rolls again on its own hit: 28 second, 8 third, 4 fourth and 2 fifth strikes after 112 finishers, 0.375 a finisher against a priced 0.333 |
| WeaponPower on the server | SETTLED on four weapons, each in its own chain block, ordinary hits: fifteen of seventeen link readings within 3% (the table above); the Warrior's third link +4.1% and the Mage's second +6.6% are the two outside. The client's tooltip: not read for a base attack |
| the Dummy: 0.899, 0.600 or 1.000 | SETTLED: level 1 on every row, and the level-1 pool to the integer through a Warrior's 48.3% penetration (Rampage 852.5 / 853, Charge 231.9 / 232). A pet's hit lands on the same pool (the imps 31.1 / 31.0) |
| which casts lay a dose | SETTLED: one per kind, four kinds, and only by a cast that lands a hit of its own - Death Mark 0 of 27 and Urge to Kill 0 of 25 laid none, Shadowstep 18 of 18, Knives Tempest 83 of 85. Smoke Bomb was never pressed |
| does the first Lethal Poison deal the direct hit | NO: the status went on 24 times with the Rogue as source and none has a Physical row of that skill beside it; all 248 direct hits landed on a target already wearing her poison. The first row after an application is the Magic tick about 1.95s later |
| what a re-application does to the timer | back to 20s SETTLED, and the tick phase is kept |
| Improved Mixture's income | SETTLED: one stack per NEW dose (262 stacks for 262 dose rows), cap 3 then 5 by rank; spent by the final combo attack only (138 spends) |
| Venomous Assassin's 2s | SETTLED for the script over the tooltip: of 224 final combo taps the script's reading mispredicts none and the tooltip's 21 |
| Opportunity Strike | SETTLED: nothing - 187 Envenom rows over 381 basic hits with the point held and no swing landing twice |
| Venom Infusion: 2.5% or 3% a stack | the tooltip says 2.5%; ticks 85 → 104-107 at twelve stacks |
| Acidic Splatter's debuff text | Armor and Magic Resistance, 10% |
| whether a Lethal Poison tick takes the applier's Fervor and mastery | YES: 68.95 priced, 69 logged. And on a foe-worn poison of another class (Swarm, 107 ticks): 25.5 logged, 25.3 priced off the applier, 21.7 off the wearer |
| the tick rule on a pool (one Bonethrow), on Light Burn, on fifty Luon Marks | not pressed |
| Iron Cyclone's four hits; Chaotic Distorsion in a stun; the rank-3 rider in a Slow | not pressed |
| the chain without padding (Flame of Argol, Twin Pillars of Justice) | not pressed |
| one charge per imp hit (Demonic Discharge's missiles) | SETTLED: 45 of the 48 imp swings that found room in the bank came with a charge inside 3ms. Bolts per press: 3, 20, 20, 20, 7, 19, 7 and 10 |
| does Gaping Wound's crit grant reach Raw ticks | YES: 51 of 389 on its own bleed, 32 of 517 on the trinket's curse, and 0 of 92 where no Gaping Wound stands. Its rank gate cannot be told (one rank captured) |
| a swing landing two damage instances rolls `onInflictDamage` twice | YES on both classes that showed it: Gash's application with 38.0% of Demonic Bites at 20%, Chaos Bolts' reset per bolt (17.5% a bolt) |
| Judgment presses against Smite casts; Sunlight with Solar Devotion | 19 presses, 17 releases; with Solar Devotion 65 of 65 finishers inside a Sunlight and nothing spending it. Without the sigil: not answerable |
| Seals of Atonement per damage instance; Hive Venom's tick and restart; Fermentation a stack per hit; Wet on a refused control | WHEN and HOW OFTEN settled on other players' rows (above); no amount; an immune target not in the log |
| heroics, Prismatic, lobbies and tooltips | not answerable from a dummy capture |

### Read again from the 2026-08 capture during the 2026-10 pass

The pre-patch event log (1.8 GB, 20.1 M rows, ending 2026-08-28) could not
speak for the new build, but several rules the update did NOT touch were
checked against it while they were being re-read, and a few old readings
were corrected by it:

- **A unit's armour is one row.** For one hero and one skill, a unit with
  its own 0.25 or 0.20 row under an inherited 0.30 takes MORE than a plain
  0.30 unit at the same logged level in 186 of 201 pairs (median 1.073; one
  row predicts 1.071, a sum 0.811).
- **Levels are the rows'.** 296 of the 300 unit archetypes it logged a level
  for were only ever at their row's level, their summoners' or at 25; the
  two level-less summons it met were logged at 25 and 24 over 5,471 rows.
  All 5,013 hits on the Dummy were at level 1.
- **The old client padded a short chain with its own last swing.** 190 Flame
  of Argol wielders swung the same swing three times before the finisher
  (1,886 + 826 chains), 54 Twin Pillars of Justice wielders A1 A2 A3 A3
  (94 + 84). The model had filled those chains with other rows of the type.
- **Prayers fire on Judgment.** 2,052 of one Priest's 2,060 Smite casts fall
  within 1.5s after a Judgment press; the median gap between two Smites over
  1,135 players is 19.2s.
- **A rider in `onInflictDamage` fires per damage instance**: Purging Strikes
  on the fists' two-hit fourth swing shows two rows in 315 of 329 presses,
  and one row on 10,487 of 10,560 one-hit swings. **And one in `onInflictHit`
  per hit**: Lifestealing on a two-hit finisher shows 0 / 1 / 2 rows in
  62 / 128 / 78 presses, which is two rolls at 50%.
- Three things no script says: in a press where Sunlight fires, Purging
  Strikes mostly plays ONCE whatever the hit count (194 of 317 four-bolt
  presses one row, 90 four); a projectile finisher raises `onInflictHit`
  more than once a bolt (5.8 Lifestealing rows a press for four bolts, 397
  presses); and Brutal Frenzy's bonus hit chained in 54 of 411 presses.
- Nectar-infused Blade's extra hit is not crit-gated: 16,253 of 16,992
  one-hit swings that did NOT crit carry it, 4,303 of 4,583 that did.
