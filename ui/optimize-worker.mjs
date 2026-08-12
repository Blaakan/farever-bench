// ---------------------------------------------------------------------------
// optimize-worker.mjs - the search, off the server's event loop.
//
// Protocol: one JSON line on stdin ({benchRoot, game, loadout, pins, options}),
// JSON lines back on stdout - {"type":"progress","evals":n} at most ~4/s while
// the search runs, then exactly one of {"type":"done", envelope, view, score,
// elapsed} or {"type":"error", error}. Always exits 0: a failed search is an
// answer, not a crash, and the error line is the report. Progress must go
// through optimize()'s own onProgress - the CLI's stderr spinner is TTY-gated
// and completely silent when piped (API.md pitfall 11).
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function readSpecLine() {
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl >= 0) return buf.slice(0, nl);
  }
  return buf;
}

async function main() {
  const spec = JSON.parse(await readSpecLine());
  const { benchRoot, game, pins = {}, options = {} } = spec;
  const t0 = Date.now();

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

  emit({
    type: 'done',
    envelope,
    view,
    score: result.score,
    elapsed: (Date.now() - t0) / 1000,
  });
  icons.close?.();
}

main().catch((e) => {
  emit({ type: 'error', error: String(e?.message ?? e) });
  process.exit(0);
});
