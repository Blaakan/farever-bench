# farever-bench UI

A desktop character-sheet UI over the bench engine: pick a class, click item
slots to pin gear (level, rarity, stars, enchants, augments, infusion), pick
weapon and arsenal skills, allocate the talent tree, slot runes — every
tooltip shows the exact in-game affix bake and where the item comes from —
then hit **Optimize** and read the result on a second, non-editable sheet
beside yours, with a damage meter in in-game names and icons.

Everything is read from your own game install at runtime (data.cdb for the
numbers, res.pak for the art, the modkit's `farever-atlas.tsv` for loot
locations when present). Nothing derived from the game ships in this repo.

## Run from source (no build)

```bash
node ui/server.mjs --port 8377     # then open http://127.0.0.1:8377/
node bin/bench.mjs ui --port 8377  # the same server, as a bench command
```

If the install is not the build the model was accepted on, both print the
CLI's warning under their banner and the page carries it as a strip: the
numbers are computed either way, they are just not vouched for until
`bench update` has been worked through.

or as a desktop window:

```bash
cd ui && npm install && npm start
```

## What the page says about what it does not offer

Two things are decided by the engine's catalog and only SHOWN here, each with
the reason the catalog gives:

* **Rows nothing hands out.** The catalog reads what in your install hands
  each item out (loot tables, the level files, merchants, recipes, the
  compiled code). A row with no open source — on the September 30 build, 26
  Epic pieces that sit only in loot tables nothing points at — and a row whose
  every copy is made above your level (below the level cap, the Epic armour
  and trinkets of the Heroic bosses and the gear caches) are listed in the
  picker under **Not offered**, dimmed, each with the sentence that says why.
  You can still equip one; the optimizer never picks one, and its result
  lists the rows it was not offered.
* **Infusions.** A piece that can carry one (Epic faction armour) gets three
  controls in the picker: which infusion — or "the optimizer's choice", or
  "none" — which rating its bonus line rolled, and whether the piece is
  Prismatic. The list is the infusions something hands out on your build; the
  ones behind an unreleased Heroic appear only when asked for, with the
  reason. The **Infusions** block under the sheet shows the sets worn (pieces,
  the set rank reached), what of each set is in the number and — folded under
  it — everything the set does that is NOT scored, and each piece's bonus
  line: lit, dark (and why), or not stated. In the editor the same block
  chooses what the optimizer may hand out (the lit orbs) and what it takes an
  unowned piece's bonus roll to be; in the result it says what that search was
  offered and what it withheld.

A skill pool is pinned for the optimizer only when your selection fills it,
and a pinned pool wears a gold pip — click the pip to unpin.

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
| `view.mjs` | evaluation → JSON serializer shared with the worker; what the candidate lists withhold, and why |
| `optimize-worker.mjs` | worker thread running `src/optimize.mjs` with live progress; reports what the search was offered |
| `icons.mjs` | gfx-ref resolution, atlas TSV (loot locations), pak access |
| `lib/` | vendored pak reader, DDS parser, BC7 decoder, PNG writer, check scripts |
| `web/` | the front end: `app.js` core + `components/` (sheet, picker, talents, runes, optimize) |
| `electron/` | the desktop shell |
| `API.md` | the server↔web contract — change it before changing either side |

`web/mock.html` is a static styling mock (no server needed); the `lib/check-*.mjs`
scripts self-test the icon service and the whole API against the live game:

```bash
node ui/lib/check-icons.mjs          # the DDS/BC7/PNG codecs
node ui/lib/check-icon-service.mjs   # every gfx cell, the rect slicer, the cache
node ui/lib/check-api.mjs            # every endpoint, several real optimize runs (~2.5 min)
node ui/lib/check-exchange.mjs       # the Send a fight dialog's own steps, on a stand-in DOM (no server)
```

They are the UI's tests — `test/run.mjs` does not start the server, and runs
`check-exchange.mjs` alone of them — and they write only under the OS temp
directory (`farever-bench-checks/`), never into `.cache/`.
