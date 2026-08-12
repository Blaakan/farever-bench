# farever-bench UI

A desktop character-sheet UI over the bench engine: pick a class, click item
slots to pin gear (level, rarity, stars, enchants, augments), pick weapon and
arsenal skills, allocate the talent tree, slot runes — every tooltip shows the
exact in-game affix bake and where the item drops — then hit **Optimize** and
read the result on a second, non-editable sheet beside yours, with a damage
meter in in-game names and icons.

Everything is read from your own game install at runtime (data.cdb for the
numbers, res.pak for the art, the modkit's `farever-atlas.tsv` for loot
locations when present). Nothing derived from the game ships in this repo.

## Run from source (no build)

```bash
node ui/server.mjs --port 8377     # then open http://127.0.0.1:8377/
```

or as a desktop window:

```bash
cd ui && npm install && npm start
```

## Build the executable

```bash
cd ui && npm install && npm run dist
# -> ui/dist/FareverBench.exe   (portable, single file)
```

The exe bundles the bench engine (`src/`, `bin/`) and the whole UI. On first
run it auto-detects the game through Steam's library list; if that fails it
opens a setup window and asks for the folder (the one holding `Farever.exe`
and `hlboot.dat`). The answer is remembered in Electron's user-data directory
— `%APPDATA%\farever-bench-ui\settings.json` — because a portable exe unpacks
to a fresh temp folder every launch, so the repo's own `.cache/` would not
survive. Run it with `--setup` to pick a different install.

`FAREVER_BENCH_PORT=nnnn` pins the internal server port.

## Releasing

`.github/workflows/release.yml` (manual dispatch, `bump: patch|minor|major`)
runs `tools/release.mjs` to bump both package.json files in lockstep and
prepend a CHANGELOG section from the commits since the last tag, builds the
exe, then publishes a GitHub release with it attached. Building needs only
Node and npm — never the game — which is also why CI runs no tests: the
suite reads your own install.

## Layout

| file | role |
|---|---|
| `server.mjs` | HTTP host: static web, `/api/*`, `/asset/*` (raw PNGs from res.pak), `/icon/dds/*` (BC7 → PNG, cached in `.cache/ui-icons/`) |
| `api.mjs` | every endpoint in `API.md`, engine LRU, optimize job registry (SSE) |
| `view.mjs` | evaluation → JSON serializer shared with the worker |
| `optimize-worker.mjs` | child process running `src/optimize.mjs` with live progress |
| `icons.mjs` | gfx-ref resolution, atlas TSV (loot locations), pak access |
| `lib/` | vendored pak reader, DDS parser, BC7 decoder, PNG writer, check scripts |
| `web/` | the front end: `app.js` core + `components/` (sheet, picker, talents, runes, optimize) |
| `electron/` | the desktop shell |
| `API.md` | the server↔web contract — change it before changing either side |

`web/mock.html` is a static styling mock (no server needed); the `lib/check-*.mjs`
scripts self-test the icon service and the whole API against the live game.
