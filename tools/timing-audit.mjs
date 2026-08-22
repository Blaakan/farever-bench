// ---------------------------------------------------------------------------
// timing-audit.mjs - the capture polices the model's clock, with no hypothesis.
//
// For every skill a character actually pressed, measure the smallest gap the
// live game allowed between that skill's damage and the player's OTHER damage
// events, and hold it against the occupancy the model bills for the same cast.
// A skill whose events sit closer to its neighbours than its billed occupancy
// allows is a scheduling divergence - the game let the player act while the
// model says the hero was committed.
//
// This is the evidence-first lens: it found nothing by being asked a clever
// question, it flags whatever the log contradicts. The parallel-cast finding
// (Swirling Embers and Depth Shield riding alongside the swing chain) was
// reported from play and confirmed by exactly this arithmetic; this tool runs
// it over everything, always.
//
//   node tools/timing-audit.mjs <character> [--capture <path>] [--game <path>]
//
// Reads the same bench-probe.csv `bench verify` does. Zero dependencies,
// streaming, never loads the log into memory.
// ---------------------------------------------------------------------------
import { createInterface } from 'node:readline';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.mjs';
import { requireGame } from '../src/lib/game.mjs';

const args = process.argv.slice(2);
const character = args.find((a) => !a.startsWith('--'));
const flagOf = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : null;
};
if (!character) {
  console.error('usage: node tools/timing-audit.mjs <character> [--capture <path>]');
  process.exit(2);
}

const game = requireGame(flagOf('game') ? ['--game', flagOf('game')] : []);
const capture = flagOf('capture') ?? join(game, 'hlx', 'logs', 'bench-probe.csv');
if (!existsSync(capture)) {
  console.error(`no capture at ${capture}`);
  process.exit(2);
}

const engine = createEngine({ quiet: true, game });

// One pass: every inflict row this character produced, in order.
const events = [];
const isAction = new Map();
const actionOf = (skill) => {
  if (isAction.has(skill)) return isAction.get(skill);
  let a = false;
  try { const p = engine.combat.profile(skill, 3); a = !!p && p.isStatusTick !== true; } catch { a = false; }
  isAction.set(skill, a);
  return a;
};
await new Promise((resolve, reject) => {
  const rl = createInterface({ input: createReadStream(capture) });
  rl.on('line', (line) => {
    const c = line.split(',');
    if (c[1] !== 'inflict' || c[2] !== character) return;
    // Only ACTIONS enter the timeline: a dot tick landing mid-cast is the
    // game's clock, not the player's, and holding casts against tick
    // neighbours flagged everything.
    if (!actionOf(c[4])) return;
    events.push({ t: +c[0], skill: c[4] });
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});
if (!events.length) {
  console.error(`no inflict rows for "${character}" - check the name (sources are player handles)`);
  process.exit(1);
}

// Per skill: the distribution of gaps from this skill's events to the NEAREST
// other-skill event by the same player, both directions. Cluster same-skill
// hits within 150ms as one cast so a multi-hit cast is one event.
const CLUSTER = 150;
const bySkill = new Map();
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  let s = bySkill.get(e.skill);
  if (!s) bySkill.set(e.skill, s = { casts: 0, lastT: -Infinity, gaps: [] });
  if (e.t - s.lastT > CLUSTER) s.casts++;
  s.lastT = e.t;
  // nearest other-skill action, either side, per event
  let near = Infinity;
  for (let j = i - 1; j >= 0 && e.t - events[j].t <= 5000; j--) {
    if (events[j].skill === e.skill) continue;
    near = Math.min(near, e.t - events[j].t); break;
  }
  for (let j = i + 1; j < events.length && events[j].t - e.t <= 5000; j++) {
    if (events[j].skill === e.skill) continue;
    near = Math.min(near, events[j].t - e.t); break;
  }
  if (Number.isFinite(near)) s.gaps.push(near);
}

// Hold each against the model's billed occupancy. The judgement is a
// FRACTION, not a minimum: over a thousand events, one same-millisecond
// coincidence (a swing and its proc attributing under two ids) is guaranteed,
// while impacts landing consistently closer than the billed commitment is a
// law. Damage lands mid-swing, so even honest chains put SOME impacts nearer
// than the swing period - the flag needs a majority-grade signal.
const rows = [];
for (const [skill, s] of bySkill) {
  if (s.casts < 20) continue;                      // too thin to judge
  let prof = null;
  try { prof = engine.combat.profile(skill, 3); } catch { /* not a skill row */ }
  if (!prof) continue;
  const billed = prof.takesControl === false ? 0 : Math.max(prof.occupancy ?? 0, 0.05);
  if (!s.gaps.length) continue;
  const sorted = s.gaps.slice().sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)] / 1000;
  const median = sorted[Math.floor(sorted.length * 0.5)] / 1000;
  const frac = billed > 0 ? s.gaps.filter((g) => g / 1000 + 0.12 < billed).length / s.gaps.length : 0;
  // The QUARTILE of neighbour gaps sits inside the billed commitment for
  // most events: the game demonstrably lets the player act through it.
  const violates = billed > 0.3 && frac > 0.5;
  rows.push({ skill, casts: s.casts, billed, p25, median, frac, violates });
}
rows.sort((a, b) => (b.violates - a.violates) || b.frac - a.frac);

console.log(`${character}: ${events.length} action events, ${rows.length} skills with n >= 20\n`);
console.log('SKILL                                   CASTS  BILLED  GAP-P25  GAP-MED  INSIDE%  VERDICT');
for (const r of rows) {
  console.log(
    r.skill.padEnd(40)
    + String(r.casts).padStart(5)
    + (r.billed.toFixed(2) + 's').padStart(8)
    + (r.p25.toFixed(2) + 's').padStart(9)
    + (r.median.toFixed(2) + 's').padStart(9)
    + (Math.round(r.frac * 100) + '%').padStart(8)
    + '   ' + (r.violates ? 'VIOLATION - most events land inside the billed occupancy' : 'ok'),
  );
}
const bad = rows.filter((r) => r.violates);
console.log(`\n${bad.length} scheduling divergence${bad.length === 1 ? '' : 's'}.`
  + (bad.length ? ' Each is a skill the live game let the player act through while the model billed a commitment - the parallel-cast class, or an occupancy read high.' : ''));
