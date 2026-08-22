# Changelog

Every release of farever-bench, newest first:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape,
[semver](https://semver.org/spec/v2.0.0.html) numbers. `package.json` and
`ui/package.json` always carry the same version - `tools/release.mjs` moves
them together and refuses to run when they disagree.

## [0.3.0] - 2026-08-22

The model audit release: nine combat subsystems were traced op-by-op through
the game's compiled code, every divergence adversarially verified, and the
fixes landed with in-game measurements as the referee. Baselines move on
every class — Rogue and Mage come DOWN because two phantom-income laws died;
the capture, not the old number, is the authority.

### Global

- Fixed CooldownReduction using the wrong formula: the game multiplies
  cooldowns by (1 − CDR/100), the bench divided by (1 + CDR/100) — cooldowns
  ran up to 10% long and the stat was undervalued at every value. 100 CDR now
  correctly means no cooldown.
- Fixed skill cooldowns not starting at the attack animation's execution
  point: the press-to-press cycle is animation offset + cooldown, measured
  live to 48ms of spread.
- Fixed guaranteed and script-granted critical strikes not being captured —
  Blazing Beam's "always critically strikes", stun-gated bonuses, and eight
  more script riders now price.
- Fixed rider bonuses scoped to "base attacks" not reaching the combo
  finisher where the game's own predicate includes it.
- Fixed looping area skills missing their spawn hit, and spread loops now pay
  the spawn's share — measured on GS Nova's capture events.
- Fixed skills whose payload fires through a launcher step pricing at zero
  (Crescent's Flower Spiral).
- Fixed damage-over-time riders that fire "when the status is applied" being
  priced per tick instead of per application, at the per-hit application
  rate — 98.8% of 71,578 captured procs sit within 5ms of an application row.
- Added the self-CC rule: a skill that applies its own Stun/Root/Slow-typed
  status pays CC-gated bonuses on its own hit (Charge lands its stun the same
  millisecond before its damage — five clean-dummy Charges at exactly ×1.25).
- Some casts never take the hero's control: a skill whose payload is pure
  status or script (Swirling Embers, Depth Shield) now costs no clock and no
  longer resets the attack combo, while animation-carrying casts still break
  it — reported from play, confirmed in the bytecode.
- The rear-hit assumption is measured now: behind-fraction defaults to the
  capture's 0.41 instead of a promised 1.0.
- New: `--rotation-file <json>` plays an authored rotation or priority list
  exactly as written, instead of the derived order and the lookahead.
- New: `tools/timing-audit.mjs` — the capture audits every skill's billed
  occupancy with no hypothesis; its first run validated the basic chain to
  the centisecond and flagged four occupancy over-reads for the next pass.
- Latent guards, ready before a patch needs them: offensive Resilience,
  target-sourced MaxHealth rows, the MRatio × MRatioMin channel split,
  Override stacking as stop-and-recreate, rank-zero reading every rank row,
  zero-ratio scaling rows.

### Mage

- Fixed passive in-combat Spark generation not being accounted for: +1.95
  per 3s tick at cap 100, ticking through casts, exactly as measured.
- Fixed weapon-skill Spark costs not following the CDR-reduced cooldown.
- Fixed Chain Strike contributing zero (+15% per rank on basics while the
  chain is armed — a state the fight already tracked).
- Fixed the chain arm counter advancing while an arm was banked and arms
  never expiring: the counter freezes while armed and an unspent arm lapses
  after 15 seconds.

### Warrior

- Fixed Rage gain factors applying to trickle income: only per-attack script
  gains ride the live factor (Berserk doubles your swings' Rage, never the
  Infinite Rage trickle), matching the two code paths.

### Rogue

- Fixed Death Mark's +15% not reaching Raw damage-over-time: script riders
  bypass the Raw gate in the game, so a marked target's bleed pays it.
- Fixed the Finisher rune's +1 combo point per critical missing from the
  income - up to ~1.5x the point rate at high crit.
- Virulent Magic rides Lethal Poison's application clock now; capture parity
  held at −6.5% per-hit while the optimizer's synthetic builds lose the
  phantom pricing the old per-tick law invented.

## [0.2.2] - 2026-08-20

- The Linux icon is a png, which is what the builder can read

## [0.2.1] - 2026-08-20

- A Linux build, and a cache that survives a read-only mount
- Line endings decided here, not by whoever cloned the repo
- The optimizer runs in a thread, not a second Electron
- Edit what is equipped, and search what an item says
- Fixed an issue that could result in epic rarity performing better than legendary in some cases

## [0.2.0] - 2026-08-12

- A boss you fight at your own level, and a buff that stops growing
- What you made keeps the level you made it at

## [0.1.0] - 2026-08-12

First numbered version: everything the repo does today, before any release
automation existed.

### bench

- `bin/bench.mjs`, the CLI over the model: `optimize` fills every unpinned
  slot and socket, `sheet` prints the stat sheet a build produces, `rank`
  ranks one slot against a build, `weapons` and `layouts` sweep weapon
  choices, `rotation` searches the rotation a weapon wants, and `items`,
  `classes`, `slots`, `rarity`, `targets`, `talents`, `profiles` read the
  game's own tables back out.
- `verify` holds the model against a recorded capture; `audit` lists every
  assumption and gap in it; `update` is the patch-day pipeline.
- Warrior is calibrated against data, bytecode and the training dummy; the
  other three classes are modelled from the same tables and not yet
  measured end to end (`docs/ROADMAP.md`).
- Zero runtime dependencies, Node 18+. Nothing derived from the game ships
  in the repo - every number is read from the player's own install, found
  through `--game`, `FAREVER_DIR`, or Steam's own library list.

### ui

- `ui/server.mjs` + `ui/api.mjs`: a local HTTP host for the bench engine,
  contract in `ui/API.md`. Character sheet, item picker with the exact
  in-game affix bake and drop locations, talent tree, rune page, and an
  optimizer that streams progress over SSE and answers on a second,
  read-only sheet with a damage meter.
- `ui/icons.mjs`: the game's own art, straight out of `res.pak` - PNG atlas
  crops served as rects, BC7 DDS portraits decoded in pure JS and cached.
- `ui/electron/`: the desktop shell, packaged as a portable Windows exe with
  `cd ui && npm run dist`. It carries the engine and the whole UI; the only
  thing it needs from the machine is the game install.
