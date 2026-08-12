# Changelog

Every release of farever-bench, newest first:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape,
[semver](https://semver.org/spec/v2.0.0.html) numbers. `package.json` and
`ui/package.json` always carry the same version - `tools/release.mjs` moves
them together and refuses to run when they disagree.

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
