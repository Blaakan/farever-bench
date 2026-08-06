#!/usr/bin/env node
// ---------------------------------------------------------------------------
// hook-coverage.mjs - how much of the damage the game actually dealt flows
// through skill scripts the bench does not execute.
//
//   node tools/hook-coverage.mjs [--source <name>] [--since <ms>] [--top <n>]
//
// 427 of the game's 962 skill rows carry a `script` column of live Haxe, and
// the bench reads four things out of that text with regexes: addStatus, the
// event predicate, checkProba, and vars.chance. Everything else in those
// scripts is not executed. The open question has always been whether that
// matters - whether the model's residual error is formula-shaped, input-shaped
// or script-shaped - and until there was a capture to weigh it against, the
// answer was a guess.
//
// This weighs it. For every skill that actually dealt damage in a capture, it
// asks whether that skill's script declares a hook whose name appears nowhere
// in the bench's source, and sums the damage on each side.
//
// TWO HONEST CAVEATS, because the headline number is only as good as these:
//
//   * "Declares an unread hook" is not "its damage comes from that hook". A
//     skill whose script only decides whether to highlight an icon is counted
//     as unread here. So the aggregate is an UPPER BOUND on script-shaped
//     error, not a measurement of it.
//
//   * The per-hook table is worse: a skill's whole damage is credited to EVERY
//     unread hook it declares, so a UI hook riding on a big skill scores as
//     highly as the hook doing the damage. Read that table as "which names to
//     go and read next", ranked, and nothing more. shouldHighlightSkill scoring
//     8% is the tell.
//
// A skill counts as read if its hook name appears literally anywhere in the
// bench's own source - deliberately generous, so this cannot flatter itself.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCdb } from '../src/cdb.mjs';
import { aggregate } from '../src/capture.mjs';
import { requireGame } from '../src/lib/game.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const game = requireGame(argv);
const capture = opt('capture') ?? join(game, 'hlx', 'logs', 'bench-probe.csv');
const source = opt('source');
const since = opt('since') ? Number(opt('since')) : null;
const top = Number(opt('top', '15'));

const cdb = loadCdb({ game, quiet: true });

// Every `function name(` in a script body. The scripts are Haxe-shaped, and a
// hook is always a top-level function declaration.
function hooksOf(row) {
  const out = new Set();
  if (!row?.script) return out;
  const re = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(String(row.script)))) out.add(m[1]);
  return out;
}

const SRC = ['skills', 'damage', 'talents', 'engine', 'sim', 'rotation']
  .map((f) => readFileSync(new URL(`../src/${f}.mjs`, import.meta.url), 'utf8'))
  .join('\n');

const skills = cdb.lines('skill');
const declared = new Set();
for (const s of skills) for (const h of hooksOf(s)) declared.add(h);
const read = new Set([...declared].filter((h) => SRC.includes(h)));
const unread = [...declared].filter((h) => !read.has(h));

const byId = cdb.byId('skill');
const agg = await aggregate(capture, { source, since, groupBy: 'skill' });

let total = 0;
let noScript = 0;
let allRead = 0;
let hasUnread = 0;
const perHook = new Map();
const perHookSkills = new Map();
const offenders = [];

for (const g of agg.groups) {
  total += g.total;
  const row = byId.get(g.key);
  if (!row?.script) { noScript += g.total; continue; }
  const hs = [...hooksOf(row)];
  const u = hs.filter((h) => !read.has(h));
  if (!u.length) { allRead += g.total; continue; }
  hasUnread += g.total;
  offenders.push({ id: g.key, damage: g.total, hits: g.hits, hooks: u });
  for (const h of u) {
    perHook.set(h, (perHook.get(h) ?? 0) + g.total);
    if (!perHookSkills.has(h)) perHookSkills.set(h, new Set());
    perHookSkills.get(h).add(g.key);
  }
}

const pc = (x) => (total ? `${((100 * x) / total).toFixed(1)}%` : '-');

console.log(`${capture}`);
console.log(`scope: ${source ?? 'everyone'}${since ? ` since ${since}` : ''}`);
console.log(`${agg.matched.toLocaleString()} damage events over ${agg.groups.length} skills, `
  + `${Math.round(total).toLocaleString()} damage`);
console.log('');
console.log(`script hooks declared in data.cdb: ${declared.size}`);
console.log(`  named anywhere in bench source:  ${read.size}`);
console.log(`  never named:                     ${unread.length}`);
console.log('');
console.log('WHERE THE DAMAGE CAME FROM');
console.log(`  skills with no script at all:            ${pc(noScript).padStart(7)}`);
console.log(`  skills whose every hook is read:         ${pc(allRead).padStart(7)}`);
console.log(`  skills declaring an UNREAD hook:         ${pc(hasUnread).padStart(7)}   <- upper bound`);
console.log('');
console.log('SKILLS, worst first');
console.log(`  ${'SHARE'.padStart(7)}  ${'HITS'.padStart(8)}  SKILL / unread hooks`);
for (const o of offenders.sort((a, b) => b.damage - a.damage).slice(0, top)) {
  console.log(`  ${pc(o.damage).padStart(7)}  ${String(o.hits).padStart(8)}  ${o.id}`);
  console.log(`  ${''.padStart(17)}  ${o.hooks.join(', ')}`);
}
console.log('');
console.log('HOOKS, by the damage of every skill declaring them (over-attributed - see header)');
console.log(`  ${'SHARE'.padStart(7)}  ${'SKILLS'.padStart(6)}  HOOK`);
for (const [h, v] of [...perHook.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`  ${pc(v).padStart(7)}  ${String(perHookSkills.get(h).size).padStart(6)}  ${h}`);
}
