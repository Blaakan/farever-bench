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
// {type:'done', envelope, view, score, elapsed} or {type:'error', error}. A
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
  const { buildView, buildEnvelope, sanitizeLoadout } = await import(url('ui/view.mjs'));

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
      exclude: /^GM_/,
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
    const view = buildView({ engine, icons, loadout: result.loadout, ev, options });
    const envelope = buildEnvelope({
      engine, loadout: result.loadout, options, metrics, ev,
      pinned: {
        gear: [...(pins.gear ?? [])],
        augments: [...(pins.augments ?? [])],
        skills: [...(pins.skills ?? [])],
      },
    });

    // Closed BEFORE the answer goes out, not after: the server terminates the
    // worker the moment a terminal message lands, so anything left until then
    // is anything left undone.
    closeIcons();
    emit({ type: 'done', envelope, view, score: result.score, elapsed: (Date.now() - t0) / 1000 });
  } finally {
    closeIcons();
  }
}

// A search that fails is a sentence for the user, not a stack: the server
// relays this string straight into the SSE 'error' frame.
main().catch((e) => {
  emit({ type: 'error', error: String(e?.message ?? e) });
});
