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
// Options: --file <csv> (defaults to <game>/hlx/logs/bench-probe.csv),
//          --target <archetype>, --event <name>, --top <n>, --json
//
// Read-only, streaming. The reference capture is 400 MB and every command here
// reads all of it - roughly ten seconds - because sampling the head of the file
// is how two separate analyses of this capture reached false conclusions.
// ---------------------------------------------------------------------------
import { join } from 'node:path';
import { requireGame } from '../src/lib/game.mjs';
import { streamCapture, aggregate, sessions, archetype, UNATTRIBUTED } from '../src/capture.mjs';

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

const file = opt('file') ?? join(requireGame(argv), 'hlx', 'logs', 'bench-probe.csv');
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
    events: Object.fromEntries([...events.entries()].sort((a, b) => b[1] - a[1])),
  };
  if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

  console.log(`${file}`);
  console.log(`${r.rows.toLocaleString()} rows over ${n(out.spanHours, 1)}h, ${sources.size.toLocaleString()} distinct sources`);
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
