#!/usr/bin/env node
// ---------------------------------------------------------------------------
// capture.mjs - read an HLX bench-probe log: what the game actually did.
//
//   node bin/capture.mjs info                  event histogram, attribution,
//                                              span, and the read receipt
//   node bin/capture.mjs sources [--top N]     who is in this capture
//   node bin/capture.mjs skills --source NAME  per-skill hits/rate/bands/crit
//   node bin/capture.mjs sessions --source NAME
//
// Options: --file <csv> (defaults to <game>/hlx/logs/bench-probe.csv; a
//          combat log another program wrote is read too - capture.mjs
//          combatLogOf, docs/COMBAT-LOG.md), --target <archetype>,
//          --event <name>, --top <n>, --json
//
// Read-only, streaming. The reference capture is 400 MB and every command here
// reads all of it - roughly ten seconds - because sampling the head of the file
// is how two separate analyses of this capture reached false conclusions.
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { requireGame } from '../src/lib/game.mjs';
import {
  streamCapture, aggregate, sessions, archetype, UNATTRIBUTED, resolveCapture, describeMissingCapture,
} from '../src/capture.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const CMDS = ['info', 'sources', 'skills', 'sessions'];
if (!cmd || !CMDS.includes(cmd)) {
  console.error(
    'usage: capture.mjs info | sources | skills | sessions\n' +
    '       [--file <csv>] [--source <name>] [--target <archetype>]\n' +
    '       [--event <name>] [--top <n>] [--json] [--game <path>]'
  );
  process.exit(1);
}

function opt(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

// The live log is rotated when the game is patched, so the default may not
// exist yet and the log beside it is another build's: say so and list what is
// there, rather than fail on a path. A bare --file name is looked up in the
// install's log folder; a path that exists needs no install at all.
const file = (() => {
  const named = opt('file');
  if (named && existsSync(named)) return named;
  const resolved = resolveCapture(requireGame(argv), named);
  if (!resolved.exists) {
    console.error(describeMissingCapture(resolved, '--file'));
    process.exit(1);
  }
  return resolved.path;
})();
const source = opt('source');
const target = opt('target');
const top = Number(opt('top', '25'));
const asJson = flag('json');

const n = (x, d = 0) => (x === null || x === undefined ? '-' : x.toFixed(d));
const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);

if (cmd === 'info') {
  const events = new Map();
  const sources = new Set();
  let unattributed = 0;
  let lastUnattributed = 0;
  let firstTs = null;
  let lastTs = null;

  const r = await streamCapture(file, (row) => {
    events.set(row.event, (events.get(row.event) ?? 0) + 1);
    if (row.source === UNATTRIBUTED) { unattributed++; lastUnattributed = row.line; }
    else sources.add(row.source);
    if (row.ts !== null) {
      if (firstTs === null || row.ts < firstTs) firstTs = row.ts;
      if (lastTs === null || row.ts > lastTs) lastTs = row.ts;
    }
  });

  const out = {
    file,
    lines: r.lines,
    rows: r.rows,
    malformed: r.malformed,
    spanHours: firstTs !== null ? (lastTs - firstTs) / 3_600_000 : null,
    distinctSources: sources.size,
    unattributed,
    lastUnattributedLine: lastUnattributed,
    // One per boot from probe v10 on: which hlboot.dat that stretch ran against.
    sessionRows: r.sessionRows,
    events: Object.fromEntries([...events.entries()].sort((a, b) => b[1] - a[1])),
  };
  if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

  console.log(`${file}`);
  console.log(`${r.rows.toLocaleString()} rows over ${n(out.spanHours, 1)}h, ${sources.size.toLocaleString()} distinct sources`);
  // Which build the rows describe is the first thing to know about a log.
  if (r.sessionRows.length && r.sessionRows[r.sessionRows.length - 1].build != null) {
    // A combat log another program wrote (src/combatlog.mjs) opens with one
    // synthetic session row naming the build its header carries - a boot
    // hash, a Steam build or a game version - and no boot on this machine.
    // A log that names no build cannot be placed on one by anybody, so the
    // line says that instead of sending the reader to verify to ask.
    const last = r.sessionRows[r.sessionRows.length - 1];
    const named = last.build !== 'unknown';
    // (A Wink timeline's header carries no build: what it names is the game
    // version of the summary beside it.)
    const wink = last.probe === 'wink-timeline';
    console.log(`a ${last.probe ?? 'combat log'} file, `
      + (named ? (wink ? `whose Wink summary names the game version ${last.build}` : `naming its build as ${last.build}`)
        : wink ? 'naming no build (a Wink timeline carries none, and no summary beside it names a game version)'
          : 'naming no build (no bootSha256, steamBuild or game version in its header)')
      + `${last.presses === 0 ? ', with no press or skill use of its character' : ''}`
      + (named ? '; `bench verify` says whether that is the installed one' : ', so no reader can place it on a build'));
  } else if (r.sessionRows.length) {
    const last = r.sessionRows[r.sessionRows.length - 1];
    const boots = new Set(r.sessionRows.map((s) => `${s.bootBytes}/${s.bootMtimeMs}`));
    console.log(`${r.sessionRows.length} boot(s) recorded (${last.probe ?? 'probe ?'}), against ${boots.size} hlboot.dat - `
      + `the last one ${last.bootBytes ?? '?'} bytes; \`bench verify\` says whether that is the installed one`);
  } else {
    console.log('no session row: written by probe v9 or older, so the file does not say which build it was recorded on');
  }
  if (r.malformed) console.log(`WARNING: ${r.malformed} malformed row(s) - the probe wrote something this reader does not understand`);
  console.log(`unattributed: ${unattributed.toLocaleString()} (${pct(unattributed / r.rows)}), last at line ${lastUnattributed.toLocaleString()}`);
  console.log('');
  for (const [k, v] of [...events.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(v).padStart(10)}  ${k}`);
  }
} else if (cmd === 'sources') {
  const a = await aggregate(file, { groupBy: 'source', event: opt('event', 'inflict') });
  if (asJson) { console.log(JSON.stringify(a.groups.slice(0, top), null, 2)); process.exit(0); }
  console.log(`${a.matched.toLocaleString()} ${a.event} rows, ${a.groups.length.toLocaleString()} distinct sources`);
  console.log('');
  console.log(`${'SOURCE'.padEnd(24)}${'HITS'.padStart(9)}${'TOTAL'.padStart(12)}${'CRIT'.padStart(8)}${'SKILLS'.padStart(8)}`);
  for (const g of a.groups.slice(0, top)) {
    console.log(`${g.key.slice(0, 23).padEnd(24)}${String(g.hits).padStart(9)}${String(g.total).padStart(12)}${pct(g.critRate).padStart(8)}${String(g.distinctTargets).padStart(8)}`);
  }
} else if (cmd === 'skills') {
  const a = await aggregate(file, {
    source, target, groupBy: 'skill', event: opt('event', 'inflict'),
  });
  if (asJson) { console.log(JSON.stringify(a, null, 2)); process.exit(0); }

  const scope = [source && `source=${source}`, target && `target=${target}`].filter(Boolean).join(' ') || 'everyone';
  console.log(`${a.matched.toLocaleString()} ${a.event} rows (${scope}), ${a.groups.length} skills`);
  if (a.unattributed) console.log(`skipped ${a.unattributed.toLocaleString()} unattributed rows`);
  console.log('');
  console.log(
    `${'SKILL'.padEnd(38)}${'HITS'.padStart(8)}${'TOTAL'.padStart(11)}${'SHARE'.padStart(8)}` +
    `${'MEAN'.padStart(9)}${'P05'.padStart(8)}${'P50'.padStart(8)}${'P95'.padStart(8)}` +
    `${'CRIT'.padStart(8)}${'WHOLE'.padStart(8)}${'GAP'.padStart(9)}`
  );
  const grand = a.groups.reduce((s, g) => s + g.total, 0);
  for (const g of a.groups.slice(0, top)) {
    console.log(
      `${g.key.slice(0, 37).padEnd(38)}${String(g.hits).padStart(8)}${n(g.total, 0).padStart(11)}` +
      `${pct(grand ? g.total / grand : 0).padStart(8)}${n(g.mean, 1).padStart(9)}` +
      `${n(g.p05, 2).padStart(8)}${n(g.p50, 2).padStart(8)}${n(g.p95, 2).padStart(8)}` +
      `${pct(g.critRate).padStart(8)}${pct(g.integrality).padStart(8)}` +
      `${(g.meanGapMs === null ? '-' : `${(g.meanGapMs / 1000).toFixed(2)}s`).padStart(9)}`
    );
  }
  console.log('');
  console.log(`TOTAL ${n(grand, 0)} over ${a.groups.length} skills`);
  console.log(
    'WHOLE is the share of events that arrived as integers. The game rounds some\n' +
    'damage paths and not others, so a model that applies one convention to all of\n' +
    'them is wrong on whichever half it guessed against.'
  );
} else if (cmd === 'sessions') {
  if (!source) { console.error('sessions needs --source <name>'); process.exit(1); }
  const s = await sessions(file, { source, event: opt('event', 'inflict') });
  const real = s.sessions.filter((x) => x.seconds >= 5);
  if (asJson) { console.log(JSON.stringify(real, null, 2)); process.exit(0); }
  console.log(`${source}: ${s.sessions.length} sessions, ${real.length} longer than 5s`);
  console.log('');
  console.log(`${'#'.padStart(4)}${'SECONDS'.padStart(10)}${'HITS'.padStart(8)}${'TOTAL'.padStart(11)}${'DPS'.padStart(9)}${'SKILLS'.padStart(8)}`);
  for (const [i, x] of real.slice(0, top).entries()) {
    console.log(
      `${String(i + 1).padStart(4)}${n(x.seconds, 1).padStart(10)}${String(x.hits).padStart(8)}` +
      `${String(x.total).padStart(11)}${n(x.dps, 1).padStart(9)}${String(x.skills).padStart(8)}`
    );
  }
}

export { archetype };
