// ---------------------------------------------------------------------------
// optimize-worker.mjs - the search, off the server's event loop.
//
// A node:worker_threads Worker, NOT a child process. The child-process version
// re-launched process.execPath, which in the packaged app is the Electron
// binary, with ELECTRON_RUN_AS_NODE=1; on some machines that second Electron
// aborted inside Chromium's ICU bootstrap before a line of this file ran:
//
//   optimize worker exited with code 2147483651 :
//   [ERROR:base\i18n\icu_util.cc:232] Invalid file descriptor to ICU data received
//
// 2147483651 is 0x80000003, STATUS_BREAKPOINT - a fatal Chromium CHECK, not a
// JS error - and that ICU string is present in electron.exe and absent from
// node.exe, so the process that died was Electron reading an ICU handle its
// parent never passed on. A worker thread launches no second binary and
// inherits no handle, so the failure has nowhere to happen; it is also the
// same code path on Windows, Linux and plain `node ui/server.mjs`.
//
// Protocol: the job arrives whole as workerData ({benchRoot, game, loadout,
// pins, options}) and answers go back over parentPort - {type:'progress',
// evals} at most ~4/s while the search runs, then exactly one of
// {type:'done', envelope, view, search, score, elapsed} or {type:'error',
// error} (`search` is what the search was allowed to do - see below). A
// failed search is an answer, not a crash, and the error message is the whole
// report. Progress must go through optimize()'s own onProgress - the CLI's
// stderr spinner is TTY-gated and completely silent off a terminal (API.md
// pitfall 11).
//
// Messages cross by structured clone, so everything posted must be plain data:
// buildView/buildEnvelope already return JSON-shaped objects because their
// other consumer is `bench sheet --build`.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workerData, parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('optimize-worker.mjs is a worker thread, not a script'
    + ' - it is started by ui/api.mjs and takes its job from workerData');
}

const emit = (msg) => parentPort.postMessage(msg);

async function main() {
  const spec = workerData;
  const { benchRoot, game, pins = {}, options = {} } = spec;
  const t0 = Date.now();

  // Every engine import resolves against benchRoot, never against this file:
  // the packaged bench is unpacked to a temp resources directory that has no
  // fixed relationship to anything, and it can contain a space, so the path
  // becomes a URL rather than a string.
  const url = (p) => pathToFileURL(join(benchRoot, p)).href;
  const { createEngine } = await import(url('src/engine.mjs'));
  const { optimize } = await import(url('src/optimize.mjs'));
  const { buildView, buildEnvelope, sanitizeLoadout, withheldItems } = await import(url('ui/view.mjs'));
  // The two printers a view needs for its infusion lines (an affix through
  // the game's own template, a text with its links named) - the same pair the
  // server's own /api/sheet hands buildView, so the two views cannot differ.
  const { gameText } = await import(url('ui/api.mjs'));

  const engine = createEngine({
    quiet: true,
    game,
    fight: {
      seconds: options.fight ?? 200,
      count: options.fights ?? 1,
      targets: options.targets ?? 1,
      lookahead: options.lookahead ?? 0,
      // The search has its own engine, so the health goes in as its DEFAULT
      // and every evaluation the search makes inherits it - `optimize` builds
      // the scorer itself and does not take one. Without this the worker would
      // search a full-health fight and hand back a build tuned for a phase the
      // user did not ask about.
      targetHealth: options.targetHealth ?? 1,
    },
    ...(options.fervorScope ? { assume: { fervorScope: options.fervorScope } } : {}),
  });

  // Same tolerant icon import as the server, with the engine's resolved
  // install dir: the view's icon refs degrade to null while ui/icons.mjs is
  // still being built.
  const icons = existsSync(join(benchRoot, 'ui', 'icons.mjs'))
    ? await (await import(url('ui/icons.mjs')))
      .createIconService({ benchRoot, game: game ?? engine.meta.game })
    : { iconRef: () => null, atlasFor: () => null, handle: () => false, close() {} };

  // Called on the way out of both the answer and the throw, and exactly once:
  // the icon service holds the atlas file handles open.
  let closed = false;
  const closeIcons = () => {
    if (closed) return;
    closed = true;
    try { icons.close?.(); } catch { /* nothing left to release */ }
  };

  const loadout = sanitizeLoadout(engine, spec.loadout);
  const foe = engine.combat.foe(options.target ?? 'boss', loadout.level, options.targetLevel ?? null);

  // WHICH INFUSIONS THE SEARCH MAY HAND OUT, and what the bonus roll of a
  // piece nobody owns is taken to be - the CLI's `--infusions` and
  // `--infusion-stat`, by the same names. Left unsaid, both are the model's
  // own defaults (optimize.mjs): every infusion this install does not show to
  // be unobtainable, and no bonus line priced. `undefined` is how "unsaid" is
  // spelled to optimize(); an EMPTY list is not unsaid, it is "hand out none",
  // so nothing here may default to one.
  const { cat } = engine;
  const offeredInfusions = options.infusions == null || options.infusions === 'learnable' ? undefined
    : options.infusions === 'all' ? [...cat.infusions.keys()]
      : options.infusions === 'none' ? [] : options.infusions;

  // Progress: cumulative evaluation count, throttled so a 6-25s search does
  // not turn into thousands of SSE frames.
  let lastEmit = 0;
  const onProgress = (n) => {
    const now = Date.now();
    if (now - lastEmit < 250) return;
    lastEmit = now;
    emit({ type: 'progress', evals: n });
  };

  try {
    const result = optimize(engine, {
      loadout,
      pinnedGear: new Set(pins.gear ?? []),
      pinnedAug: new Set(pins.augments ?? []),
      pinnedSkills: new Set(pins.skills ?? []),
      pinnedRunes: new Set(pins.runes ?? []),
      pinnedTalents: !!pins.talents,
      goal: options.goal ?? 'dps',
      weights: options.weights ?? null,
      target: foe,
      rank: options.rank ?? 3,
      mix: options.mix ?? 0.5,
      stars: options.stars ?? 'max',
      rarityRoll: options.rarityRoll ?? true,
      // NOTHING is excluded unless the request says so. This used to be a
      // hard-coded /^GM_/, the CLI's guess at a developer prefix - but the
      // one item that id pattern matches is GM_MassGrab, "Pocket Hive", the
      // game's only Two-handed Mace (itemType GreatMace), which /api/catalog
      // lists and the picker equips. A filter the search applies and the
      // picker does not is an item the user can wear and the optimizer can
      // never suggest. api.mjs has already checked the pattern compiles.
      exclude: options.exclude ? new RegExp(options.exclude) : null,
      // The rows nothing in this install hands out stay withheld unless the
      // request re-admits them (the CLI's `--include-all`); `null` is the
      // catalog's own setting, which is to withhold.
      includeUnreleased: options.includeUnreleased === true ? true : null,
      infusions: offeredInfusions,
      infusionStat: options.infusionStat ?? undefined,
      // The slots whose infusion is the user's own statement - "this one" or
      // "none". A client that sends no such list is an older one, and then
      // optimize()'s default stands: a pinned piece keeps what it states.
      // Every slot in the list is in `pins.gear` too - the server refuses a
      // request where one is not (api.mjs `checkPins`), because optimize()
      // takes such a slot as "swap the piece freely and never infuse it".
      pinnedInfusion: Array.isArray(pins.infusions) ? new Set(pins.infusions) : undefined,
      talentPoints: options.talentPoints ?? null,
      allowEmpty: options.allowEmpty ?? true,
      restarts: options.restarts ?? 3,
      onProgress,
    });

    emit({ type: 'progress', evals: result.evaluations });

    const ev = result.evaluation;
    const metrics = {
      dps: ev.throughput.dps,
      hps: ev.throughput.hps,
      sps: ev.throughput.sps,
      ehp: ev.survivability.ehp,
    };
    const view = buildView({ engine, icons, loadout: result.loadout, ev, options, gameText });
    const envelope = buildEnvelope({
      engine, loadout: result.loadout, options, metrics, ev,
      pinned: {
        gear: [...(pins.gear ?? [])],
        augments: [...(pins.augments ?? [])],
        skills: [...(pins.skills ?? [])],
        // What the search actually held, which is the request's list when it
        // sent one and every pinned slot when it did not.
        infusions: result.infusion.pinned,
        runes: [...(pins.runes ?? [])],
        talents: !!pins.talents,
      },
      infusion: result.infusion,
    });

    // WHAT THE SEARCH WAS ALLOWED TO DO - the half of an answer a build alone
    // does not carry. Which infusions it could hand out, which it withheld and
    // on what evidence, what it took an unowned piece's bonus roll to be, and
    // which gear rows the candidate lists left out. Every sentence is the
    // catalog's source reader's; nothing here judges a row.
    const nameOfInfusion = (id) => cat.infusions.get(id)?.name ?? id;
    const cls = cat.classes.find((c) => c.unit === result.loadout.class);
    const src = cat.sources();
    const leftOut = new Map();
    for (const [slotId, rows] of withheldItems(engine, { aptitude: cls.aptitude, level: result.loadout.level })) {
      for (const r of rows) {
        // Re-admitted rows were searched; a row that only exists above the
        // character never is.
        if (r.kind === 'unreleased' && options.includeUnreleased === true) continue;
        const e = leftOut.get(r.item.id)
          ?? { id: r.item.id, name: r.item.name, rarity: r.item.rarity, slots: [], kind: r.kind, why: r.why };
        e.slots.push(slotId);
        leftOut.set(r.item.id, e);
      }
    }
    const search = {
      infusions: {
        total: cat.infusions.size,
        offered: result.infusion.offered.map((id) => ({ id, name: nameOfInfusion(id) })),
        withheld: result.infusion.withheld.map((w) => ({ id: w.id, name: nameOfInfusion(w.id), why: w.why })),
        statPolicy: result.infusion.statPolicy,
        pinned: result.infusion.pinned,
      },
      gear: {
        includeUnreleased: options.includeUnreleased === true,
        withheld: [...leftOut.values()],
        // When a store could not be read nothing is withheld at all, and the
        // reader says which store and why.
        unread: !src.prefabs.read || !src.code.read ? (src.prefabs.why ?? src.code.why) : null,
      },
    };

    // Closed BEFORE the answer goes out, not after: the server terminates the
    // worker the moment a terminal message lands, so anything left until then
    // is anything left undone.
    closeIcons();
    emit({ type: 'done', envelope, view, search, score: result.score, elapsed: (Date.now() - t0) / 1000 });
  } finally {
    closeIcons();
  }
}

// A search that fails is a sentence for the user, not a stack: the server
// relays this string straight into the SSE 'error' frame.
main().catch((e) => {
  emit({ type: 'error', error: String(e?.message ?? e) });
});
