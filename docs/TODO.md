# Next session — the work list, in priority order

State at handoff (2026-08-22, v0.3.0): **966 checks green**; baselines Warrior
514.8, Rogue 479.1, Mage 541.3, Priest 427.2 (`optimize`, level 25, named
boss). The 2026-08 bytecode audit is implemented through its second pass —
what remains is listed here with the reads already done against each item.
Full citations live in the audit report and in the code comments the fixes
carry; the numbers below are the ones that decide priority.

## Model — structural, each deserves its own verified pass

- **Live tick repricing** (audit #14). The game re-runs the full pipeline per
  tick — live attacker sheet, live stacks, live receive side — and snapshots
  only the ctx (carrier bracket, critChance, dynVals) at first application.
  The bench prices the whole tick at application. The refresh re-snapshot is
  an accidental partial correction; the honest fix routes tick payment
  through `restat` at tick time. Touches the pricing caches — do it with the
  capture as referee, per skill.
- **onUseSkill shapes** (audit #17). `doUseSkill@4576` dispatches to all owner
  scripts on every use; the bench reads exactly one idiom. Known silent
  zeros: DS_Bladeleaf_Passive (+100% magic on one cast per 30s ICD),
  DS_Bladeleaf_Combo_Status (signature fires all stacked projectiles at
  0.35×(Str+Int)), GA_Demon_Passive, Priest_Crusader, Trinket_Bee. The ICD
  idiom (consumeCooldown/isInCooldown vs authored cooldown) is half-parsed
  elsewhere — finish the reader.
- **Event-step replay remainder** (audit #18). on=Hit steps replay per landed
  hit: Warrior_SurgingForce's Stun+GainRage per Area hit (rage income ~N×
  low at --targets N), SparkSurge_Mark's on=Consume payload. The dot side
  (per-hit application clock) landed; the step side did not.
- **Occupancy over-reads** — found by `tools/timing-audit.mjs` on its first
  run, Emsei's log: Sword_Swarm_Combo billed 0.75s vs 0.40s observed (92% of
  events inside), Spear_Eruption_Skill2 1.25 vs 0.83 (91%), Sword_Base_
  Attack3 0.55 vs 0.40 (75%), Priest_RadiantVerdict 0.45 at 52%. Re-derive
  those occupancies from the step data; the tool is the acceptance test.
  Then run the tool over every character in the reference log.
- **Demondash Skill1 rank-3 aura** is over-credited ~3× — statusesOf grants
  it per cast, the game needs 3 presses inside 5s. The sim carries a press
  counter already (the chain arm); gate the aura the same way.
- **Rogue lookahead trap**: before the fixes, the la8 search settled 23%
  below the la0 basin; it recovered incidentally. Understand why the rollout
  loses to greedy by ~6% on chain builds (it prices the arm at zero — give
  the rollout the register) or stop paying for a rollout that never wins.

## Estimator

- **Phase averaging.** One deterministic timeline has ±2% phase quantisation
  and is asked to resolve 0.1% differences; the CDR staircase spans 9.14%.
  Measured: K=5 timelines (190–210s) takes the Mage monotonicity grid 28→9
  inversions; K=21 (150–250s) takes it to 4. It changes every printed
  number, so it is a release decision — flag first (`--fights`-like), then
  default.
- Keep the monotonicity harness from the arsenal investigation as a tool:
  single-item upgrade steps must not lower dps; 1.1% of reachable steps
  still invert.

## Measurements owed / pending (game time)

- **RoundUp discriminator** (audit #22): compute and name the exact
  dual-aptitude item whose baked Strength lands on x.5, with both predicted
  tooltip integers — then it is one screenshot.
- **Domination vs pre-existing CC**, Judgement in hand this time: ~20 basics
  plain, then Charge and basics inside the 1s stun window. Decides whether
  the +25% is per-state on every hit or only rides the stun-attached cast.
- **Rank-3 CC-immune clause**: needs an actually CC-immune target (the dummy
  stuns — measured).
- **Mace basics block** at weapon rank ≥3 (Blessing +0.70 crit rider on
  basics — tonight's log had n=9).
- Staff_Craft_C at 8.0% (z=−2.3) and the ignite dot at 7.0% want larger n.
- Spark talent income terms (Infinite Resources, Conduit Residues, …) — one
  session per talent, zero other resource talents.

## Latent tripwires — documented, no action until the data moves

Audit #23 (unknown-hook census), #26 (per-instigator stack piles), #27
(target-side block), #28 (foe reactive scripts), #31 (Uncommon statGroup
rules), #33 (area maxFalloff), #35 (castTimeFactor — zero sources), and the
flawless ×2 augment path (#15 — every roll chance authored 0; fires the day
a patch turns it on).

## UI

- **The skill-pool pin bug**: `App.setSkills` pins the pool on ANY click,
  deselecting included, and nothing renders or clears the pin — the
  optimizer then silently returns the user's own selection (the "Smoke Bomb
  over Urge to Kill" report). Pin only meaningful selections or make the pin
  an explicit, visible toggle with an unpin affordance for class pools.
- **One defaults object** shared by bin/ and ui/ — `lookahead` is 8 in the
  CLI and 0 in five UI places, and ui/API.md documents both. Ship the
  defaults in the bootstrap payload so the front-end cannot drift.
- Expose `--rotation-file` and `--target-level` in the UI.

## Verify — the group-content pass (unblocked by probe v7)

The 2026-08-22 Rogue verify taught three lessons, all from the author's own
challenge. (1) Per-hit rows were POOLED across instances of an archetype,
which is wrong exactly when instances differ in debuff state — the rift case.
(2) External debuffs were not accounted for and they DOMINATE boss windows:
live basics hit DemonSuperElite HARDER than rift trash (34.5 vs 25-28 mean
non-crit), an inversion armour cannot produce at any spawn level — the
party's shreds and taken-amps did it, and the "DemonSuperElite spawns at
rift level" reading is NOT separable from them in v6 data. (3) OreAffix_Ice
is a consumable prebuff, not a model gap.

Probe v7 makes the honest version buildable — work items:

- **Debuff-aware, per-instance verify**: group by target INSTANCE, price each
  hit against the row's own tarm/tmarm/tdtm instead of a derived foe — the
  spawn-level question and the shred question both become one subtraction.
- **tlvl closes the fitted spawn levels**: retire FITTED_LEVELS in favour of
  logged levels wherever v7 rows exist; keep the fits only for old captures.
- **thp turns execute clauses into measured windows** (Demonic Bite's +25%
  under 35% shows today as a persistent −5% on its row).
- **snap_buff folds prebuffs into the verify loadout** (ore weapon buffs,
  food, flasks) instead of the standing "consumables not captured" caveat.
- Open model-side finding from that ledger, target-independent in size:
  Daggers_Demondash_Passive_Status per-hit at −65.7% (model 32.9 vs live
  95.9 dps) — signature of a live stack count ~3x what the model credits on
  that ScaleWithStacks burn.

## Verify / tooling

- Per-category crit buckets in `bench verify` (weapon-path vs spell-path) so
  a ZealousFighter-class rider shows as its own column instead of a residual.
- Run `tools/timing-audit.mjs` as part of the patch-day pipeline
  (`bench update`) — it is the no-hypothesis lens and it costs seconds.
- The audit's own stale notes: whenever one of the items above lands, the
  matching `bench audit` entry moves from assumption to verified with the
  citation, the same discipline the crit-rider fix followed.
