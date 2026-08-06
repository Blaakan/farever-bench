// ---------------------------------------------------------------------------
// capture.mjs - read what the game actually did, out of an HLX bench-probe log.
//
// The probe writes one CSV row per observed event:
//
//   ts_ms,event,source,target,skill_id,amount,crit,stacks,max_stacks,extra
//
// This file is the only authoritative thing the bench has. Everything else in
// src/ is a claim about how Farever computes damage; this is a record of what
// Farever computed. Where the two disagree, this wins.
//
// Four properties of the format are easy to get wrong, and three of them have
// already produced a wrong answer in this project:
//
//   * The head of the file is unattributed. `source` and `target` read "???"
//     until the client has resolved names - 2727 rows in the reference capture,
//     0.29% of the inflict stream. Every row after that is attributed. An
//     analysis that samples the first N lines concludes the whole capture is
//     anonymous, which is false.
//
//   * `applyDamage` never fires. The probe hooks it on both Unit and Hero, and
//     it logged zero rows in 4.5M. Damage is computed server-side and the
//     client's copy throws unless `simulatingServer || Config.server`. The
//     `inflict` stream - what the server told the client it did - is the only
//     damage channel there is.
//
//   * `amount` is NOT uniformly an integer, and that is a finding rather than a
//     nuisance. Direct hits arrive whole - Rogue_Sig_Finisher's whole
//     distribution is integral - while several status/tick streams arrive
//     fractional (AcidicSplatter p95 = 75.13, VirulentMagic mean 23.8 with
//     fractional tails). So the game rounds on some paths and not others, and a
//     model that applies one convention everywhere is wrong on half the stream.
//     Which paths round is an open question this reader is meant to answer;
//     `integrality()` below measures it per skill rather than assuming it.
//
//   * Targets carry an instance suffix: "Spirit_Z2W_Claws#9279". The archetype
//     is the part before the '#'. Sources do not - they are player handles.
//
// Zero dependencies, streaming, and it never loads the file into memory: the
// reference capture is 400 MB and streams end to end in about ten seconds.
// ---------------------------------------------------------------------------

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const COLUMNS = [
  'ts_ms', 'event', 'source', 'target', 'skill_id',
  'amount', 'crit', 'stacks', 'max_stacks', 'extra',
];

// The placeholder the probe writes before the client has resolved a name.
export const UNATTRIBUTED = '???';

// Split one line into the fixed ten columns. `extra` is the only field that may
// itself contain a comma, so anything past the tenth is rejoined into it rather
// than dropped. A row that arrives with too FEW fields is malformed and is
// counted, never guessed at - a shifted field would silently mis-attribute a
// hit, which is exactly the class of error this file exists to prevent.
function splitRow(line) {
  const p = line.split(',');
  if (p.length < COLUMNS.length) return null;
  if (p.length > COLUMNS.length) {
    p[COLUMNS.length - 1] = p.slice(COLUMNS.length - 1).join(',');
    p.length = COLUMNS.length;
  }
  return p;
}

// `extra` is a ";"-separated bag of "k=v" - "affinity=Magic;hits=1". Absent and
// empty both read as an empty bag.
export function parseExtra(s) {
  const out = {};
  if (!s) return out;
  for (const part of s.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) out[part] = true;
    else out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

// "Spirit_Z2W_Claws#9279" -> "Spirit_Z2W_Claws". Player sources have no suffix,
// so this is safe to apply to either column.
export function archetype(name) {
  if (!name) return name;
  const i = name.indexOf('#');
  return i < 0 ? name : name.slice(0, i);
}

function num(s) {
  if (s === '' || s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Stream every row, newest work first: `onRow` is called with a plain object
// per data line. Returns the counts that let a caller trust the read - a
// capture with malformed rows is a capture with a broken probe.
export async function streamCapture(path, onRow) {
  if (!existsSync(path)) throw new Error(`capture: no such file ${path}`);
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let header = null;
  let rows = 0;
  let malformed = 0;

  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) {
      header = line;
      const got = line.split(',');
      const missing = COLUMNS.filter((c) => !got.includes(c));
      if (missing.length) {
        throw new Error(
          `capture: ${path} is not a bench-probe log - missing column(s) ` +
          `${missing.join(', ')}. Header was: ${line}`
        );
      }
      continue;
    }
    if (!line) continue;

    const p = splitRow(line);
    if (!p) { malformed++; continue; }

    rows++;
    onRow({
      line: lineNo,
      ts: num(p[0]),
      event: p[1],
      source: p[2],
      target: p[3],
      skill: p[4],
      amount: num(p[5]),
      crit: p[6] === '1' || p[6] === 'true',
      stacks: num(p[7]),
      maxStacks: num(p[8]),
      extra: p[9],
    });
  }

  return { header, lines: lineNo, rows, malformed };
}

// A running tally for one group. An exact histogram keyed on the observed
// amount is usually far smaller than the sample and gives exact quantiles with
// no reservoir and no interpolation. Amounts are mostly - not always - whole,
// so the key space stays small in practice; `whole` tracks how true that is.
class Tally {
  constructor(key) {
    this.key = key;
    this.n = 0;
    this.sum = 0;
    this.crits = 0;
    this.whole = 0;
    this.hist = new Map();
    this.firstTs = null;
    this.lastTs = null;
    this.affinities = new Set();
    this.targets = new Set();
    this.sources = new Set();
    this.gapSum = 0;
    this.gapN = 0;
    this._prevTs = null;
  }

  add(r, { gapCeilMs }) {
    this.n++;
    const a = r.amount ?? 0;
    this.sum += a;
    if (r.crit) this.crits++;
    if (Number.isInteger(a)) this.whole++;
    this.hist.set(a, (this.hist.get(a) ?? 0) + 1);
    if (this.firstTs === null || r.ts < this.firstTs) this.firstTs = r.ts;
    if (this.lastTs === null || r.ts > this.lastTs) this.lastTs = r.ts;

    // Cadence: mean gap between consecutive events, ignoring the jumps between
    // play sessions. A capture spanning 20,000 seconds of wall clock is not one
    // fight, and averaging across the idle time reports a cast every 40s.
    if (this._prevTs !== null) {
      const d = r.ts - this._prevTs;
      if (d >= 0 && d <= gapCeilMs) { this.gapSum += d; this.gapN++; }
    }
    this._prevTs = r.ts;
  }

  quantile(q) {
    if (!this.n) return null;
    const want = Math.min(this.n - 1, Math.floor(q * this.n));
    const keys = [...this.hist.keys()].sort((x, y) => x - y);
    let seen = 0;
    for (const k of keys) {
      seen += this.hist.get(k);
      if (seen > want) return k;
    }
    return keys[keys.length - 1];
  }

  report() {
    const keys = [...this.hist.keys()];
    return {
      key: this.key,
      hits: this.n,
      total: this.sum,
      mean: this.n ? this.sum / this.n : 0,
      min: keys.length ? Math.min(...keys) : null,
      max: keys.length ? Math.max(...keys) : null,
      p05: this.quantile(0.05),
      p50: this.quantile(0.50),
      p95: this.quantile(0.95),
      critRate: this.n ? this.crits / this.n : 0,
      crits: this.crits,
      // What share of this skill's events arrived as whole numbers. 1 means the
      // game rounds this path; anything less means it does not, and the model
      // must not round it either.
      integrality: this.n ? this.whole / this.n : null,
      meanGapMs: this.gapN ? this.gapSum / this.gapN : null,
      spanMs: this.firstTs !== null ? this.lastTs - this.firstTs : null,
      affinity: [...this.affinities].sort().join('|') || null,
      distinctTargets: this.targets.size,
      distinctSources: this.sources.size,
    };
  }
}

// Aggregate an `inflict` stream into per-group statistics.
//
//   source     only this actor's hits (a player handle, exact match)
//   target     only against this target archetype ("#uid" stripped)
//   event      which stream to read (default "inflict")
//   groupBy    'skill' | 'source' | 'target' | 'source+skill'
//   gapCeilMs  gaps longer than this are session breaks, not cadence
//
// Returns the tallies plus the read receipt, so a caller can see how much of
// the file was actually consumed and how much was unattributed.
export async function aggregate(path, {
  source = null,
  target = null,
  event = 'inflict',
  groupBy = 'skill',
  gapCeilMs = 30_000,
  since = null,
  until = null,
} = {}) {
  const groups = new Map();
  let matched = 0;
  let unattributed = 0;

  const keyOf = (r) => {
    switch (groupBy) {
      case 'source': return r.source;
      case 'target': return archetype(r.target);
      case 'source+skill': return `${r.source}\t${r.skill}`;
      case 'skill': return r.skill;
      default: throw new Error(`capture: unknown groupBy "${groupBy}"`);
    }
  };

  const receipt = await streamCapture(path, (r) => {
    if (event && r.event !== event) return;
    if (r.source === UNATTRIBUTED) { unattributed++; return; }
    if (source && r.source !== source) return;
    if (target && archetype(r.target) !== target) return;
    // A capture is many hours of play across many builds. Comparing a model
    // against all of it compares one gear snapshot to every weapon the player
    // swapped through, and reads their whole back catalogue as missing
    // coverage. Windowing is not an optimisation here - it is what makes the
    // comparison mean anything.
    if (since !== null && r.ts < since) return;
    if (until !== null && r.ts > until) return;

    matched++;
    const k = keyOf(r);
    let t = groups.get(k);
    if (!t) { t = new Tally(k); groups.set(k, t); }
    t.add(r, { gapCeilMs });

    const x = parseExtra(r.extra);
    if (x.affinity) t.affinities.add(x.affinity);
    t.targets.add(archetype(r.target));
    t.sources.add(r.source);
  });

  return {
    ...receipt,
    event,
    groupBy,
    matched,
    unattributed,
    groups: [...groups.values()]
      .map((t) => t.report())
      .sort((a, b) => b.total - a.total),
  };
}

// Build snapshots, as bench-probe v3 writes them.
//
// The probe emits a `snap` marker whenever the local character's build changes,
// then a burst of `snap_gear` / `snap_talent` / `snap_arsenal` / `snap_attr` /
// `snap_hattr` rows describing it. The name rides in `skill_id`; the value in
// `amount`, `stacks` or `extra`.
//
// These are the only description of a build that is contemporaneous with the
// damage it produced. The modkit's inventory dump is written at login and
// carries gear alone, so a capture spanning days compared against it reads
// every weapon since swapped out as damage the model cannot see - and every
// talent as missing, permanently, because the dump has no field for one.
//
// A snapshot's `ts` is therefore also a boundary: the build it describes stands
// until the next marker for the same actor.
export async function snapshots(path, { source = null } = {}) {
  const open = new Map();   // actor -> the snapshot currently being filled
  const out = [];

  const receipt = await streamCapture(path, (r) => {
    // Damage attributed to whichever build was standing when it landed. Counted
    // here because this pass is already reading every row, and because picking a
    // snapshot by recency picks the one written as the player logged out - which
    // has no damage after it at all. A build description is only useful in
    // proportion to the evidence it covers.
    if (r.event === 'inflict') {
      const cur = open.get(r.source);
      if (cur) { cur.events++; cur.damage += r.amount ?? 0; }
      return;
    }
    if (!r.event || !r.event.startsWith('snap')) return;
    if (source && r.source !== source) return;

    if (r.event === 'snap') {
      const x = parseExtra(r.extra);
      const s = {
        actor: r.source,
        ts: r.ts,
        key: x.key ?? '',
        level: x.level != null ? Number(x.level) : null,
        gear: [],
        talents: [],
        arsenals: [],
        attrs: {},
        hattrs: {},
        sheet: {},
        affixes: [],
        sockets: [],
        errors: [],
        events: 0,
        damage: 0,
      };
      open.set(r.source, s);
      out.push(s);
      return;
    }

    const s = open.get(r.source);
    if (!s) return;   // a burst whose marker was rotated out of this file
    const x = parseExtra(r.extra);
    switch (r.event) {
      case 'snap_gear': {
        const num = (v) => (v === '' || v === undefined ? null : Number(v));
        s.gear.push({
          kind: r.skill,
          upgrade: num(x.upgrade),
          level: num(x.level),
          rarity: x.rarity === '' || x.rarity === undefined ? null : x.rarity,
          ilevel: num(x.ilevel),
          flawless: x.flawless === '1',
        });
        break;
      }
      // The live stat sheet, off UnitAttributes.attributes. Distinct from
      // snap_attr, which reads the named scalars on the same object and was
      // observed returning BASE values - critChance 5 and every attribute 0 on
      // a fully geared level-25 hero. Where the two disagree, this one is the
      // sheet the game was actually fighting with.
      case 'snap_sheet':
        s.sheet[r.skill] = r.amount;
        break;
      // Every affix applied to the hero, with the value the sheet was built
      // from. `skill_id` is the affix row id, `target` is what it modifies
      // (ETAttribute:Dexterity and so on), `amount` is the applied value.
      //
      // Provenance has a documented limit: a base item affix and a socketed
      // augment's affix both report source EItem(<host item>), because the
      // gem's id is a lookup key that is discarded before application. These
      // rows say what is applied and by which piece; snap_socket says which
      // gems are in that piece.
      case 'snap_affix': {
        const x2 = parseExtra(r.extra);
        s.affixes.push({
          id: r.skill,
          target: r.target,
          value: r.amount,
          uid: x2.uid ?? null,
          source: x2.src ?? null,
          target2: x2.tgt2 ?? null,
        });
        break;
      }
      // What is socketed where - gems and enchants alike, they are the same
      // mechanism. `skill_id` is the augment's item id, `stacks` its index in
      // the host's slot list.
      case 'snap_socket': {
        const x2 = parseExtra(r.extra);
        s.sockets.push({
          augment: r.skill,
          index: r.stacks ?? null,
          host: x2.host ?? null,
          hostFlawless: x2.host_flawless === '1',
        });
        break;
      }
      // The probe could not read something and said so rather than inventing a
      // row. Carried through to the report: a named gap is a result.
      case 'snap_err':
        s.errors.push({ what: r.skill, why: r.extra });
        break;
      case 'snap_talent':
        s.talents.push({ id: r.skill, rank: r.stacks ?? null });
        break;
      case 'snap_arsenal':
        s.arsenals.push({ id: r.skill, value: x.value ?? null });
        break;
      case 'snap_attr':
        s.attrs[r.skill] = r.amount;
        break;
      case 'snap_hattr':
        s.hattrs[r.skill] = r.amount;
        break;
      default:
        break;
    }
  });

  // Each snapshot stands until the next one for the same actor.
  const byActor = new Map();
  for (const s of out) {
    const prev = byActor.get(s.actor);
    if (prev) prev.until = s.ts;
    byActor.set(s.actor, s);
    s.until = null;
  }

  return { ...receipt, snapshots: out };
}

// Split one actor's events into sessions - contiguous stretches of activity
// separated by more than `gapMs` of silence. A capture is many play sessions;
// a fight is a stretch inside one. Rates computed across the whole file are
// meaningless, so anything that reports dps has to segment first.
export async function sessions(path, {
  source,
  event = 'inflict',
  gapMs = 60_000,
} = {}) {
  if (!source) throw new Error('capture: sessions() needs a source');
  const out = [];
  let cur = null;

  const receipt = await streamCapture(path, (r) => {
    if (r.event !== event || r.source !== source) return;
    if (!cur || r.ts - cur.endTs > gapMs) {
      cur = { startTs: r.ts, endTs: r.ts, hits: 0, total: 0, skills: new Set() };
      out.push(cur);
    }
    cur.endTs = r.ts;
    cur.hits++;
    cur.total += r.amount ?? 0;
    cur.skills.add(r.skill);
  });

  return {
    ...receipt,
    sessions: out.map((s) => ({
      startTs: s.startTs,
      endTs: s.endTs,
      seconds: (s.endTs - s.startTs) / 1000,
      hits: s.hits,
      total: s.total,
      dps: s.endTs > s.startTs ? s.total / ((s.endTs - s.startTs) / 1000) : null,
      skills: s.skills.size,
    })),
  };
}
