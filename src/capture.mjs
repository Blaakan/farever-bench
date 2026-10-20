// ---------------------------------------------------------------------------
// capture.mjs - read what the game actually did, out of an HLX bench-probe log.
//
// The probe writes one CSV row per observed event:
//
//   ts_ms,event,source,target,skill_id,amount,crit,stacks,max_stacks,extra
//
// Probe v7 (2026-08-23) enriches inflict rows with the TARGET's live facts in
// extra: tlvl (the level the target stands at - the unit row, the difficulty
// and the activity decide it between them, and the log is the only place all
// three are already resolved), thp (current health - every execute clause),
// tmax/tarm/tmarm/tdtm (MaxHealth, Armor, MagicArmor, DamageTakenModifier off
// the live attribute map - group shreds and taken-amps included; asked for,
// and never once written in the 20M rows of the pre-patch capture). And a
// snapshot event snap_buff: every active status on the hero (ore buffs, food,
// flasks - the consumables that were invisible). Rows older than v7 simply
// lack the keys; parseExtra is tolerant either way.
//
// Probe v10 (2026-10-08) opens every log, at every boot, with a `session`
// row: skill_id "bench-probe", amount the schema number, and in extra the
// probe version and two cheap facts about the hlboot.dat it booted from -
// `probe=v10;boot_bytes=<n>;boot_mtime_ms=<n>`. That row is what says which
// BUILD a stretch of the log was recorded on; v9 and older wrote none, so a
// log without one predates this probe. See captureEra below.
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

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
// The combat-log hook (see "combat logs" above streamCapture).
import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readCombatLog, captureRows, MAX_LOG_BYTES, SUMMARY_ONLY, CombatLogError } from './combatlog.mjs';

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

// A level -> rows tally of logged `tlvl`, as a caller reads it: the level most
// rows stood at, how many of the matched rows said so, and the whole spread.
// `mode` is null when no matched row carried a level (a pre-v7 window, or a
// filter that matched nothing) - absence is not level 0.
function loggedLevels(tally, matched) {
  const levels = [...tally].map(([level, rows]) => ({ level, rows }))
    .sort((x, y) => y.rows - x.rows || x.level - y.level);
  const logged = levels.reduce((n, l) => n + l.rows, 0);
  return { mode: levels.length ? levels[0].level : null, modeRows: levels[0]?.rows ?? 0, logged, matched, levels };
}

// --- which file ------------------------------------------------------------
// The probe appends to ONE file, <game>/hlx/logs/bench-probe.csv, and a log is
// only evidence about the build it was recorded on. So the file is rotated
// when the game is patched: the old one is renamed beside it (the pre-patch
// capture is bench-probe.2026-08-02_2026-08-29.build-2026-07-29.csv) and the
// probe starts a new one at its next boot. Between those two moments the
// default path does not exist at all, and right after it the file is a header
// and a session row. Neither is an error; both have to be said.
export const CAPTURE_LOG = 'bench-probe.csv';

export function captureLogDir(gameDir) {
  return join(gameDir, 'hlx', 'logs');
}

// Every damage log in the install's log folder, newest first. The bake log
// (bench-probe-bakes*.csv) has other columns and is not one of them.
export function listCaptures(gameDir) {
  const dir = captureLogDir(gameDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!/^bench-probe.*\.csv$/i.test(name) || /^bench-probe-bakes/i.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.push({ name, path: join(dir, name), bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished between the listing and the stat */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The capture a command should read: the one it was told, else the live log.
// A bare file name is looked up in the log folder too, so the rotated capture
// can be named without its path. Never falls back to another file on its own:
// an older log is another build's, and reading it has to be a decision.
export function resolveCapture(gameDir, named = null) {
  const dir = captureLogDir(gameDir);
  let path = join(dir, CAPTURE_LOG);
  if (named) {
    path = named;
    if (!existsSync(path) && !isAbsolute(named) && existsSync(join(dir, named))) path = join(dir, named);
  }
  return {
    path,
    exists: existsSync(path),
    defaulted: !named,
    others: listCaptures(gameDir).filter((c) => c.path !== path),
  };
}

// The sentences for a capture that is not there, or holds nothing a command
// can use - one wording for every reader (`bench verify`, bin/capture.mjs).
// `flag` is how that command names a file.
export function describeOtherCaptures(resolved, flag = '--capture') {
  if (!resolved.others.length) return 'No other bench-probe log is in that folder.';
  return 'Other logs in that folder (each one another stretch of play, and an older one another build):\n'
    + resolved.others.map((c) => `  ${c.name}   ${(c.bytes / 1e6).toFixed(1)} MB, `
      + `last written ${new Date(c.mtimeMs).toISOString().slice(0, 10)}`).join('\n')
    + `\nName one with ${flag} <file>.`;
}
export function describeMissingCapture(resolved, flag = '--capture') {
  return `no capture at ${resolved.path}\n`
    + (resolved.defaulted
      ? 'The probe starts a new log with each build, and nothing has been recorded on this one yet.\n'
      : 'That file does not exist, here or in the install\'s hlx/logs folder.\n')
    + describeOtherCaptures(resolved, flag);
}

// --- which build -----------------------------------------------------------
// A `session` row, as probe v10 writes it at every boot (see the header).
export function parseSession(r) {
  const x = parseExtra(r.extra);
  const n = (v) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    ts: r.ts,
    probe: typeof x.probe === 'string' ? x.probe : null,
    bootBytes: n(x.boot_bytes),
    bootMtimeMs: n(x.boot_mtime_ms),
    // The probe could not stat the file it booted from, and said so.
    bootUnreadable: x.boot === 'unreadable',
    // A combat log's synthetic session row (combatlog.mjs captureRows): the
    // build its header names, and whether the log records presses at all
    // (0 or 1). Only on the rows that carry them: a probe's session row
    // parses to the object it always did, so `--json` output is unchanged.
    ...(typeof x.build === 'string' && x.build !== '' ? { build: x.build } : {}),
    ...(x.presses !== undefined ? { presses: n(x.presses) } : {}),
  };
}

// The two facts a session row carries, off the installed bytecode.
export function bootFacts(gameDir) {
  try {
    const st = statSync(join(gameDir, 'hlboot.dat'));
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// Was this stretch of a capture recorded on the INSTALLED build?
//
//   sessionRows   every session row of the file (any reader's receipt has them)
//   from, to      the window's first and last event, in ms
//   boot          bootFacts() of the install, or null when it cannot be read
//   bootSha       the installed hlboot.dat's sha256 (engine.meta.bootSha), for
//                 a combat log's session row, which names a build by hash
//
// A window is spoken for by the session row that opened the boot it started in
// - the last one at or before `from` - and by every session row inside it. If
// those name the installed hlboot.dat (same size, same modification second: the
// probe's stat has no milliseconds), it is this build. If one names another
// file, it is not. And if there is no session row at all the log was written
// by probe v9 or older, which leaves only dates: a window that ended before the
// installed hlboot.dat was written was recorded before this boot was installed
// - another build, unless Steam merely re-verified the file - and one that did
// not is an old probe running on this boot, about which nothing can be said.
//
// `onThisBuild` is true, false, or null for "cannot tell"; `reason` is the
// sentence to print. Pure, so it can be tested without a game.
export function captureEra({ sessionRows = [], from = null, to = null, boot = null, bootSha = null } = {}) {
  const day = (ms) => (ms == null ? '?' : new Date(ms).toISOString().slice(0, 10));
  const sorted = [...sessionRows].filter((s) => s.ts != null).sort((a, b) => a.ts - b.ts);
  const opener = from == null ? null : sorted.filter((s) => s.ts <= from).pop() ?? null;
  const inside = sorted.filter((s) => (from == null || s.ts > from) && (to == null || s.ts <= to));
  const sessions = opener ? [opener, ...inside] : inside;
  const out = { sessions, from, to, boot, probe: sessions.length ? sessions[sessions.length - 1].probe : null };
  // --- a combat log's session row (combatlog.mjs) ---------------------------
  // A log some other tool wrote names its build by what its header carried -
  // the hlboot.dat sha256, a Steam build, a game version - and never by a
  // file on this machine, so the size-and-date rule below cannot speak for
  // it. The sha matching the installed one is this build; anything else is
  // "cannot tell", with both named. Never "another build": that answer would
  // price the training Dummy at the armour it had before the 2026-10 build
  // (verify.mjs TARGET_HISTORY) off nothing but a date.
  const named = sessions.filter((s) => s.build != null);
  if (named.length) {
    const want = typeof bootSha === 'string' && bootSha !== '' ? bootSha.toLowerCase() : null;
    if (want && named.every((s) => s.build.toLowerCase() === want)) {
      return { ...out, onThisBuild: true,
        reason: `recorded on this build (the ${out.probe ?? 'log'} header names the installed hlboot.dat, sha256 ${want.slice(0, 12)})` };
    }
    const said = [...new Set(named.map((s) => s.build))].join(', ');
    // A Wink timeline's header carries no build: what its session row names
    // is the game version of the summary beside it (combatlog.mjs buildOf),
    // and the sentence sends a reader to that file, not to the header.
    const whose = out.probe === 'wink-timeline'
      ? (said === 'unknown' ? 'the Wink timeline names no build, and no summary beside it names a game version'
        : `its Wink summary names the game version ${said}`)
      : `the ${out.probe ?? 'log'} header names its build as ${said === 'unknown' ? 'nothing (no bootSha256, steamBuild or gameVersion)' : said}`;
    return { ...out, onThisBuild: null,
      reason: `${whose}, `
        + `and the installed hlboot.dat is ${want ? `sha256 ${want.slice(0, 12)}` : 'not hashed here'} - a combat log's dates never place it on a build, `
        + 'so which build it describes cannot be told' };
  }
  // --- end of the combat-log branch -------------------------------------------
  if (!boot) {
    return { ...out, onThisBuild: null, reason: 'the installed hlboot.dat could not be read, so the capture\'s build cannot be told' };
  }
  const same = (s) => s.bootBytes === boot.bytes && s.bootMtimeMs != null && Math.abs(s.bootMtimeMs - boot.mtimeMs) < 2000;
  // A window that starts in rows no session row opens and only later crosses
  // one is two builds' worth of rows whenever its head is older than the boot.
  if (!opener && sessions.length && from != null && from < boot.mtimeMs) {
    return { ...out, onThisBuild: false,
      reason: `it starts (${day(from)}) before its first session row, in rows written before this boot was installed `
        + `(${day(boot.mtimeMs)}) - the head of the window is another build's` };
  }
  if (sessions.length) {
    const other = sessions.find((s) => !s.bootUnreadable && !same(s));
    if (other) {
      return { ...out, onThisBuild: false,
        reason: `recorded on another build: its session row (${other.probe ?? 'probe ?'}, ${day(other.ts)}) names an hlboot.dat of `
          + `${other.bootBytes ?? '?'} bytes written ${day(other.bootMtimeMs)}, and the installed one is ${boot.bytes} bytes written ${day(boot.mtimeMs)}` };
    }
    if (sessions.some((s) => s.bootUnreadable)) {
      return { ...out, onThisBuild: null, reason: 'its session row says the probe could not read hlboot.dat, so the build cannot be told' };
    }
    return { ...out, onThisBuild: true,
      reason: `recorded on this build (${out.probe ?? 'probe ?'} session row of ${day(sessions[sessions.length - 1].ts)} names the installed hlboot.dat)` };
  }
  if (to != null && to < boot.mtimeMs) {
    return { ...out, onThisBuild: false,
      reason: `written before this boot was installed: no session row (probe v9 or older) and its last row is ${day(to)}, `
        + `the installed hlboot.dat ${day(boot.mtimeMs)}` };
  }
  return { ...out, onThisBuild: null,
    reason: 'no session row (probe v9 or older) on rows newer than the installed hlboot.dat - which build they describe cannot be told' };
}

// --- combat logs (src/combatlog.mjs) -----------------------------------------
// `--capture` takes a combat log as well as a probe CSV: a farever-combat-log
// or a Wink DPS Meter timeline, gzip or not (docs/COMBAT-LOG.md). Such a file
// is not streamed line by line - its rows have to be sorted, a use's target
// sits on a later row, and gzip has no lines at all - so it is read WHOLE by
// combatlog.mjs, turned into the rows below once, and replayed to `onRow`.
// What tells the two apart is the first bytes: gzip's magic, or a '{' as the
// first character that is not blank. A probe CSV opens with its column names
// and goes the old way, untouched.
//
// A command reads one capture several times (verify streams it six to eight
// times), so the parsed log is kept per path, size and modification time -
// and the sibling summary's, for a Wink timeline - and the rows are frozen:
// every reader gets the same objects, and none of them may change one.
const COMBAT_LOGS = new Map();   // path -> { key, log, rows }

function sniffCombatLog(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return true;
    let i = n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    while (i < n && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
    return i < n && buf[i] === 0x7b;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// The Wink summary beside a timeline: `<id>.json.timeline` -> `<id>.json`,
// as every reader of a log takes it (`--capture`, `bench import`, `bench
// submit`). Null when the path is no timeline or nothing that is a FILE stands
// there - a folder of that name is not a summary. A file that cannot be read
// (past the reader's size guard, or the read fails) comes back with `why` and
// no `data`: it costs the log its summary, never the log.
//
//   { path, name, size, mtimeMs, data: Buffer | null, why: string | null }
//
// `read: false` stats it and reads nothing (data stays null): what a cache
// key needs.
export function winkCompanion(path, { read = true } = {}) {
  if (typeof path !== 'string' || !/\.timeline$/i.test(path)) return null;
  const p = path.replace(/\.timeline$/i, '');
  let st;
  try { st = statSync(p); } catch { return null; }
  if (!st.isFile()) return null;
  const out = { path: p, name: basename(p), size: st.size, mtimeMs: st.mtimeMs, data: null, why: null };
  if (st.size > MAX_LOG_BYTES) return { ...out, why: `it is larger than ${MAX_LOG_BYTES / 1024 / 1024} MB, which no Wink summary is` };
  if (!read) return out;
  try { return { ...out, data: readFileSync(p) }; } catch (e) { return { ...out, why: e.message }; }
}

// One combat log read from disk with the Wink summary beside it: what
// readCombatLog returns, with a summary that stood there and could not be
// read named among its problems. `data` is the file's bytes when the caller
// has them already; `name` what the sentences call it (its base name).
// Throws CombatLogError, as the reader does.
export function readCombatLogAt(path, { data = null, name = basename(path) } = {}) {
  const side = winkCompanion(path);
  const log = readCombatLog({
    name,
    data: data ?? readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
    companion: side?.data ? { name: side.name, data: side.data } : null,
  });
  if (side?.why) log.problems.push(`${side.name} is beside the timeline and could not be read (${side.why}), so it was not used`);
  return log;
}

// The rows of the header's initial[] - what stood when the recording opened -
// carry `initial=1`, so that openingState holds them as standing at an
// opening at or before them: an entry written without a time stands at the
// log's first row (combatlog.mjs), which is exactly where a window over the
// whole log, or one cut from its start, opens. They are told by their line:
// combatlog.mjs gives every row the line its event was read from, the
// header's to initial[], and no event of the file shares it. (A row already
// tagged by the reader is left as it is.)
function initialTagged(log, rows) {
  if (!log.initial.length) return rows;
  const head = new Set(captureRows({ ...log, events: [] }).filter((r) => r.event !== 'session').map((r) => r.line));
  return rows.map((r) => (r.event !== 'session' && head.has(r.line) && parseExtra(r.extra).initial === undefined
    ? { ...r, extra: r.extra ? `${r.extra};initial=1` : 'initial=1' } : r));
}
export const isInitialRow = (r) => r?.event === 'status_on' && parseExtra(r.extra).initial === '1';

// The parsed log and its rows for a capture path, or null when the file is a
// probe CSV. Throws CombatLogError - the reader's sentence when the file
// cannot be read, and the refusal of a summary on its own: its rows are
// totals under origin ids, and every reader here needs rows.
//
// `heroKinds`: the unit ids a player can be (the game's classes, from an
// engine), for a caller that has one at hand - a uid of such a kind is a
// player, named by its handle in the rows (combatlog.mjs captureRows), even
// where the log itself names no player of that class. Without them the
// kinds come from the log alone. The rows are read once per file and kept:
// a later caller with no engine at hand (streamCapture, and every reader
// under it) takes the rows the last caller that gave kinds read.
export function combatLogOf(path, { heroKinds = null } = {}) {
  if (!existsSync(path) || !sniffCombatLog(path)) return null;
  const st = statSync(path);
  const side = winkCompanion(path, { read: false });
  const key = `${st.size}\t${st.mtimeMs}\t${side ? `${side.path}\t${side.size}\t${side.mtimeMs}` : ''}`;
  const kinds = Array.isArray(heroKinds) && heroKinds.length ? [...new Set(heroKinds)].sort().join(',') : null;
  const hit = COMBAT_LOGS.get(path);
  if (hit && hit.key === key && (kinds === null || hit.kinds === kinds)) return hit;
  // Refused before it is read into memory: the reader's own guard is on
  // the text it would parse, and a gzip larger than that inflates past it.
  if (st.size > MAX_LOG_BYTES) {
    throw new CombatLogError(`capture: ${path} is larger than ${MAX_LOG_BYTES / 1024 / 1024} MB, which no one fight's combat log is`);
  }
  const log = readCombatLogAt(path);
  if (!log.perEvent) {
    const timeline = existsSync(`${path}.timeline`) ? `${path}.timeline` : null;
    throw new CombatLogError(`capture: ${path} is a Wink fight summary - ${SUMMARY_ONLY}`
      + (timeline ? `. Its timeline is ${timeline}: read that one` : ''));
  }
  const rows = initialTagged(log, captureRows(log, { heroKinds: kinds === null ? null : kinds.split(',') })).map((r) => Object.freeze(r));
  const entry = { key, kinds, log, rows };
  COMBAT_LOGS.set(path, entry);
  while (COMBAT_LOGS.size > 4) COMBAT_LOGS.delete(COMBAT_LOGS.keys().next().value);
  return entry;
}

function replayCombatLog(path, onRow) {
  const { log, rows } = combatLogOf(path);
  const sessionRows = [];
  for (const r of rows) {
    if (r.event === 'session') sessionRows.push(parseSession(r));
    onRow(r);
  }
  return { header: JSON.stringify(log.header), lines: log.lineCount, rows: rows.length, malformed: log.malformed, sessionRows };
}
// --- end of the combat-log hook ------------------------------------------------

// Stream every row, newest work first: `onRow` is called with a plain object
// per data line. Returns the counts that let a caller trust the read - a
// capture with malformed rows is a capture with a broken probe - and the
// file's session rows, which every reader passes on in its receipt.
export async function streamCapture(path, onRow) {
  if (!existsSync(path)) throw new Error(`capture: no such file ${path}`);
  // A combat log (gzip, or JSON on its first line): see the block above.
  if (sniffCombatLog(path)) return replayCombatLog(path, onRow);
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  let header = null;
  let rows = 0;
  let malformed = 0;
  const sessionRows = [];

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
    const row = {
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
    };
    if (row.event === 'session') sessionRows.push(parseSession(row));
    onRow(row);
  }

  return { header, lines: lineNo, rows, malformed, sessionRows };
}

// A player handle carries no instance suffix; a creature's name does
// ("Spirit_Z2W_Claws#9279"), and the placeholder is neither.
export function isPlayerHandle(name) {
  return typeof name === 'string' && name !== '' && name !== UNATTRIBUTED && !name.includes('#');
}

// A row-time test for a list of ranges. `windows` is [{ from, to }, ...],
// each end inclusive and null for open; null or empty means every row.
function windowTest(windows) {
  if (!windows || !windows.length) return () => true;
  const ws = windows.map((w) => [w.from ?? -Infinity, w.to ?? Infinity]);
  if (ws.length === 1) { const [a, b] = ws[0]; return (ts) => ts >= a && ts <= b; }
  return (ts) => ws.some(([a, b]) => ts >= a && ts <= b);
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
    // Critical and ordinary hits apart: sum, count and range of each. A short
    // window's mean is mostly its crit luck (three presses, two crits), and
    // the two halves are what a formula can be held to - see verify.mjs.
    this.ncSum = 0; this.ncMin = null; this.ncMax = null;
    this.cSum = 0; this.cMin = null; this.cMax = null;
    this.whole = 0;
    this.hist = new Map();
    this.firstTs = null;
    this.lastTs = null;
    this.affinities = new Set();
    // The same tally per AFFINITY the rows were logged with. One skill id can
    // be two different hits: a status's tick and the step its re-application
    // plays are both logged under the status (Lethal Poison: the tick Magic,
    // the direct hit Physical), and only the affinity tells them apart.
    this.byAffinity = new Map();
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
    if (r.crit) {
      this.crits++; this.cSum += a;
      if (this.cMin === null || a < this.cMin) this.cMin = a;
      if (this.cMax === null || a > this.cMax) this.cMax = a;
    } else {
      this.ncSum += a;
      if (this.ncMin === null || a < this.ncMin) this.ncMin = a;
      if (this.ncMax === null || a > this.ncMax) this.ncMax = a;
    }
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
      // The two halves of the mean. Null where the window holds none of that
      // kind - three hits that all crit say nothing about an ordinary one.
      nonCrit: this.n - this.crits
        ? { hits: this.n - this.crits, mean: this.ncSum / (this.n - this.crits), min: this.ncMin, max: this.ncMax }
        : null,
      crit: this.crits
        ? { hits: this.crits, mean: this.cSum / this.crits, min: this.cMin, max: this.cMax }
        : null,
      // What share of this skill's events arrived as whole numbers. 1 means the
      // game rounds this path; anything less means it does not, and the model
      // must not round it either.
      integrality: this.n ? this.whole / this.n : null,
      meanGapMs: this.gapN ? this.gapSum / this.gapN : null,
      spanMs: this.firstTs !== null ? this.lastTs - this.firstTs : null,
      affinity: [...this.affinities].sort().join('|') || null,
      // One report per affinity, when the group holds more than one.
      ...(this.byAffinity.size > 1
        ? { byAffinity: [...this.byAffinity.values()].map((t) => t.report()).sort((a, b) => b.total - a.total) }
        : {}),
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
//   since      first millisecond read, inclusive (null: from the start)
//   until      last millisecond read, inclusive (null: to the end)
//   windows    several such ranges at once, [{ from, to }, ...] with either
//              end null for open: a row is read when it falls in ANY of them.
//              Given together with since/until, a row has to satisfy both.
//   instance   only the source's rows on this target INSTANCE ("Dummy#2180"),
//              exact; needs `source`
//   follow     { isBaseAttack(skillId) } - hold each of the source's rows to
//              the instance it was FIGHTING at that moment (see below); needs
//              `source` and `target`
//
// WHICH INSTANCE. A unit id is not one target: the 2026-10-13 dummy yard holds
// three units called Dummy, and what a character lands on the two it is not
// fighting - a status that spreads to the enemies around the one hit, an
// area - is still a row "on Dummy". A model that fights ONE target has no
// line for those rows, and a ledger that read them beside it compared two
// different fights: the Rogue's 15-point rotation logged 57,304 on three
// dummies and 52,894 on the one it pressed, and Acidic Splatter's row was two
// thirds neighbour (40 of its 60 hits). So a read for one source on one unit
// can be held to the instance being fought, and that is a fact per MOMENT,
// because in a pull it changes (three units killed in turn are three
// instances):
//
//   * a `press` row names it - the probe writes the hero's target in the
//     target column as `T:<unit>#<n>` (`T:` alone, `Point` and `#-1` name
//     nothing and are skipped);
//   * a held base-attack chain writes no press row, so a base attack of the
//     source's that lands on the unit names it too - unless that same swing
//     also landed on the instance already being fought (a cleave), which
//     changes nothing.
//
// The later of the two stands, a press first when both fall in one
// millisecond. It is followed from the top of the log, not from the window's
// first row (a window cut out of a sitting opens mid-fight), and a `session`
// row forgets it. A row that falls before anything has named an instance is
// kept: nothing says it was not on the one being fought. What is not kept is
// counted, per instance, in `leftOut`.
//
// Returns the tallies plus the read receipt, so a caller can see how much of
// the file was actually consumed and how much was unattributed - and, when
// the read was for ONE source, `foreign`: which other players landed rows,
// in the same window, on the very target instances this source hit. A
// capture is everything the client saw - the 2026-10-13 dummy sessions were
// recorded in a town and hold some 130 other handles - and none of those
// rows is this source's damage. The ones on ITS targets are still worth a
// word: whatever such a player put on the target was there for this
// source's hits too.
export async function aggregate(path, {
  source = null,
  target = null,
  event = 'inflict',
  groupBy = 'skill',
  gapCeilMs = 30_000,
  since = null,
  until = null,
  windows = null,
  instance = null,
  follow = null,
} = {}) {
  if ((instance || follow) && !source) throw new Error('capture: aggregate() holds rows to an instance for one source only');
  if (follow && !target) throw new Error('capture: aggregate() follows the fought instance of one target unit');
  const groups = new Map();
  let matched = 0;
  let unattributed = 0;
  // Other players' rows that pass every filter but the source one, kept per
  // target INSTANCE until the end - which instances count is only known once
  // the source's own rows are in.
  const foreign = new Map();   // "handle	instance" -> { source, target, hits, total }
  const hitInstances = new Set();
  const inWindows = windowTest(windows);
  // The span of what matched - the window a caller actually read, which is
  // what captureEra needs when `until` was left open.
  let firstTs = null;
  let lastTs = null;
  // The level the matched rows' TARGETS stood at, as the probe logged it
  // (`tlvl`, v7 on): level -> rows. It is the one place where the unit row,
  // the difficulty and a spawner's own level are already resolved, so a
  // caller pricing a window can stand its target where the game stood it
  // instead of where a row or a guess would. Rows older than v7 carry none.
  const targetLevels = new Map();
  // The source's rows on another instance than the one named or followed.
  const leftOut = new Map();   // instance -> { target, hits, total }
  const leave = (r) => {
    const e = leftOut.get(r.target) ?? { target: r.target, hits: 0, total: 0 };
    e.hits++; e.total += r.amount ?? 0;
    leftOut.set(r.target, e);
  };
  // TIME IN PLAY: the sum of the gaps between consecutive matched rows inside
  // one window range, a gap longer than `gapCeilMs` being a break and not
  // play. On a window that is one sitting it is the time from the first hit
  // to the last; over three windows it is the three such spans added, with
  // nothing for the pauses between them. It is the clock a rate is taken on.
  const ranges = (windows ?? []).map((w) => [w.from ?? -Infinity, w.to ?? Infinity]);
  const rangeOf = (ts) => {
    for (let i = 0; i < ranges.length; i++) if (ts >= ranges[i][0] && ts <= ranges[i][1]) return i;
    return -1;
  };
  let activeMs = 0;
  let prevTs = null;
  let prevRange = -1;
  // The instance being fought (`follow`), and the rows of the moment being
  // read: they are filed once the whole millisecond is in, because the row
  // that names the instance can sit after a hit it decides.
  let fought = null;
  let momentTs = null;
  let momentPress = null;
  let momentBase = [];
  let pending = [];

  const keyOf = (r) => {
    switch (groupBy) {
      case 'source': return r.source;
      case 'target': return archetype(r.target);
      case 'source+skill': return `${r.source}\t${r.skill}`;
      case 'skill': return r.skill;
      default: throw new Error(`capture: unknown groupBy "${groupBy}"`);
    }
  };

  const take = (r) => {
    if (source) hitInstances.add(r.target);

    matched++;
    if (r.ts != null) {
      if (firstTs === null || r.ts < firstTs) firstTs = r.ts;
      if (lastTs === null || r.ts > lastTs) lastTs = r.ts;
      const range = rangeOf(r.ts);
      if (prevTs !== null && range === prevRange) {
        const d = r.ts - prevTs;
        if (d >= 0 && d <= gapCeilMs) activeMs += d;
      }
      prevTs = r.ts; prevRange = range;
    }
    const k = keyOf(r);
    let t = groups.get(k);
    if (!t) { t = new Tally(k); groups.set(k, t); }
    t.add(r, { gapCeilMs });

    const x = parseExtra(r.extra);
    if (x.affinity) {
      t.affinities.add(x.affinity);
      let sub = t.byAffinity.get(x.affinity);
      if (!sub) { sub = new Tally(x.affinity); t.byAffinity.set(x.affinity, sub); }
      sub.add(r, { gapCeilMs });
      sub.affinities.add(x.affinity);
    }
    t.targets.add(archetype(r.target));
    t.sources.add(r.source);
    const lv = num(x.tlvl ?? '');
    if (lv !== null) targetLevels.set(lv, (targetLevels.get(lv) ?? 0) + 1);
  };
  // Close the moment: settle which instance is being fought, then file the
  // rows that were waiting on it.
  const settle = () => {
    if (momentPress) fought = momentPress;
    else if (momentBase.length && (fought === null || !momentBase.includes(fought))) fought = momentBase[0];
    for (const r of pending) {
      if (fought === null || r.target === fought) take(r); else leave(r);
    }
    momentPress = null; momentBase = []; pending = [];
  };
  // What a row says about the instance being fought, whatever the window and
  // the event filter make of the row afterwards.
  const track = (r) => {
    if (r.ts !== momentTs) { settle(); momentTs = r.ts; }
    if (r.event === 'session') { fought = null; return; }
    if (r.source !== source) return;
    if (r.event === 'press') {
      const m = /^T:(.+#\d+)$/.exec(r.target ?? '');
      if (m && archetype(m[1]) === target) momentPress = m[1];
    } else if (r.event === 'inflict' && archetype(r.target) === target && follow.isBaseAttack(r.skill)) {
      momentBase.push(r.target);
    }
  };

  const receipt = await streamCapture(path, (r) => {
    if (follow) track(r);
    if (event && r.event !== event) return;
    if (r.source === UNATTRIBUTED) { unattributed++; return; }
    if (target && archetype(r.target) !== target) return;
    // A capture is many hours of play across many builds. Comparing a model
    // against all of it compares one gear snapshot to every weapon the player
    // swapped through, and reads their whole back catalogue as missing
    // coverage. Windowing is not an optimisation here - it is what makes the
    // comparison mean anything.
    if (since !== null && r.ts < since) return;
    if (until !== null && r.ts > until) return;
    if (!inWindows(r.ts)) return;
    if (source && r.source !== source) {
      // Somebody else's row in the same window. A player handle carries no
      // instance suffix; a creature's name does, and a creature hitting back
      // is not company worth reporting.
      if (isPlayerHandle(r.source)) {
        const k = `${r.source}	${r.target}`;
        const f = foreign.get(k) ?? { source: r.source, target: r.target, hits: 0, total: 0 };
        f.hits++; f.total += r.amount ?? 0;
        foreign.set(k, f);
      }
      return;
    }
    if (instance && r.target !== instance) { leave(r); return; }
    if (follow) { pending.push(r); return; }
    take(r);
  });
  if (follow) settle();

  return {
    ...receipt,
    event,
    groupBy,
    matched,
    unattributed,
    firstTs,
    lastTs,
    // Time in play, in milliseconds (see `activeMs` above): the clock a rate
    // over these rows is taken on.
    activeMs,
    // The source's rows that passed every other filter and landed on another
    // instance than the one named (`instance`) or being fought (`follow`):
    // how many, how much, and on which, most damage first. Empty without
    // either option.
    leftOut: (() => {
      const instances = [...leftOut.values()].sort((a, b) => b.total - a.total || (a.target < b.target ? -1 : 1));
      return { hits: instances.reduce((n, x) => n + x.hits, 0), total: instances.reduce((n, x) => n + x.total, 0), instances };
    })(),
    targetLevels: loggedLevels(targetLevels, matched),
    // The target INSTANCES the source's own rows landed on ("Dummy#2180"),
    // when one source was asked for.
    instances: [...hitInstances],
    // Other players' rows on the target instances the source itself hit in
    // this read, per player, most rows first. Empty when no source was asked
    // for: with nobody singled out, nobody is "other".
    foreign: (() => {
      const by = new Map();
      for (const f of foreign.values()) {
        if (!hitInstances.has(f.target)) continue;
        const e = by.get(f.source) ?? { source: f.source, hits: 0, total: 0 };
        e.hits += f.hits; e.total += f.total;
        by.set(f.source, e);
      }
      return [...by.values()].sort((a, b) => b.hits - a.hits || (a.source < b.source ? -1 : 1));
    })(),
    groups: [...groups.values()]
      .map((t) => t.report())
      .sort((a, b) => b.total - a.total),
  };
}

// What a set of skills and statuses left in one actor's rows - the evidence a
// build fact the probe could not read can still be recovered from.
//
//   source         the actor (exact handle)
//   since, until   the span read, inclusive, either end null for open
//   skills         ids to count `inflict` rows of, with the actor as source
//   statuses       ids to follow on the actor: how often each was applied to
//                  it, and by how many stacks AT A TIME
//
// A status applied by several instances of one mechanic at once arrives as
// that many stack rows in one millisecond (the 2026-10-13 Mage's three Power
// conduits: `status_on` at 2 and `status_stacks` 3 on the first trigger,
// then 4, 5, 6 together on the next), so the gain per moment is kept as a
// histogram: `perEvent` is the commonest gain, and a gain cut short by the
// cap is simply a rarer one. Rows within 5 ms are one moment.
export async function mechanicEvidence(path, { source, since = null, until = null, skills = [], statuses = [] } = {}) {
  const hits = new Map(skills.map((id) => [id, 0]));
  const st = new Map(statuses.map((id) => [id, { cur: 0, base: 0, at: null, gains: new Map() }]));
  const close = (e) => {
    if (e.at === null) return;
    const gain = e.cur - e.base;
    if (gain > 0) e.gains.set(gain, (e.gains.get(gain) ?? 0) + 1);
    e.at = null;
  };
  await streamCapture(path, (r) => {
    if (since !== null && r.ts < since) return;
    if (until !== null && r.ts > until) return;
    if (r.event === 'inflict') {
      if (r.source === source && hits.has(r.skill)) hits.set(r.skill, hits.get(r.skill) + 1);
      return;
    }
    if (r.target !== source) return;
    const e = st.get(r.skill);
    if (!e) return;
    if (r.event === 'status_off') { close(e); e.cur = 0; return; }
    if ((r.event !== 'status_on' && r.event !== 'status_stacks') || r.stacks === null) return;
    if (e.at === null || r.ts - e.at > 5) { close(e); e.at = r.ts; e.base = e.cur; }
    e.cur = r.stacks;
  });
  const out = { hits: Object.fromEntries(hits), statuses: {} };
  for (const [id, e] of st) {
    close(e);
    const events = [...e.gains.values()].reduce((a, b) => a + b, 0);
    const perEvent = events
      ? [...e.gains.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0] : null;
    out.statuses[id] = { events, perEvent, gains: Object.fromEntries(e.gains) };
  }
  return out;
}

// What a pool of one actor stood at when a span opens: the first row in it
// that says. The probe writes a hero's Rage and Spark on every `press` row
// and every `go_state` row (the actor is the source of the first and the
// target of the second), as `<key>=<value>` in `extra`.
//
// Returns { value, ts } or null when no row of the actor in the span carries
// the key.
export async function poolAt(path, { source, since = null, until = null, key } = {}) {
  let found = null;
  await streamCapture(path, (r) => {
    if (found) return;
    if (since !== null && r.ts < since) return;
    if (until !== null && r.ts > until) return;
    if (!((r.event === 'press' && r.source === source) || (r.event === 'go_state' && r.target === source))) return;
    const v = num(parseExtra(r.extra)[key] ?? '');
    if (v !== null) found = { value: v, ts: r.ts };
  });
  return found;
}

// What one actor had set going when a span OPENS: its presses before that
// moment, and the statuses it had applied that were still up at it.
//
// A window cut out of a recorded sitting does not begin with nothing. The
// 2026-10-13 Rogue's "basics" blocks open one to seven seconds after a
// rotation, with Lethal Poison still ticking on the dummy for the whole block,
// and the Warrior's second login opens half a second after a Rampage press
// whose hit lands inside it. Rows like those were dealt in the window by
// something that happened before it, and the log says what.
//
//   source    the actor (exact handle)
//   at        the opening, epoch ms; rows at or after it are not read - but
//             for a combat log's initial[] statuses, which stood before
//             its first row (`initial: true` on the entry)
//   wearers   keep only statuses worn by the actor itself or by one of these
//             target instances ("Dummy#2180" - the ones the window's own rows
//             hit, `aggregate().instances`); null keeps every wearer
//
// How a status reaches the log: `status_on` carries the applier as source and
// the wearer as target, with the duration in `extra` (`dur=`, 0 for a status
// with no clock); `status_refresh`, `status_stacks` and `status_off` carry the
// wearer alone (`refresh_dur=` restarts the clock from the refresh). A status
// stands at the opening when the actor applied it and neither a `status_off`,
// a `status_stacks` to 0 nor its own clock has ended it since. A `session`
// row is a new boot of the game: nothing the log held standing before it is
// known to stand after it (the first 2026-10-13 session left dose markers
// with no clock on dummies the second never saw), so both lists start over.
//
// Returns { lastPress: { skill, ts } | null, pressed: { <skill>: last ts },
// standing: [{ status, wearer, self, since, lastAt, stacks, expires, initial? }] } -
// `expires` null for a status with no clock.
export async function openingState(path, { source, at, wearers = null } = {}) {
  let lastPress = null;
  const pressed = {};
  const up = new Map();     // "wearer\tstatus" -> entry
  const seconds = (v) => { const n = num(v ?? ''); return n !== null && n > 0 ? n : null; };
  const worn = wearers ? new Set(wearers) : null;
  await streamCapture(path, (r) => {
    // (A status of a combat log's initial[] stood before its recording
    // opened, and so at an opening at or before its row - see initialTagged.)
    const initial = isInitialRow(r);
    if (r.ts === null || (r.ts >= at && !initial)) return;
    if (r.event === 'session') {
      up.clear(); lastPress = null;
      for (const k of Object.keys(pressed)) delete pressed[k];
      return;
    }
    if (r.event === 'press') {
      if (r.source !== source) return;
      lastPress = { skill: r.skill, ts: r.ts };
      pressed[r.skill] = r.ts;
      return;
    }
    if (!r.event || !r.event.startsWith('status_')) return;
    const key = `${r.target}\t${r.skill}`;
    if (r.event === 'status_on') {
      if (r.source !== source) return;
      const x = parseExtra(r.extra);
      // (`ok=1` on every one of the 43,676 `status_on` rows of the 2026-10-13
      // log. A 0 has not been seen; it is read as an application that did
      // not take.)
      if (x.ok === '0') return;
      if (worn && r.target !== source && !worn.has(r.target)) return;
      const dur = seconds(x.dur);
      // Applied again while still up, it has stood since the first time.
      const prev = up.get(key);
      const still = prev && (prev.expires === null || prev.expires > r.ts);
      up.set(key, {
        status: r.skill, wearer: r.target, self: r.target === source,
        since: still ? prev.since : r.ts, lastAt: r.ts, stacks: r.stacks, expires: dur === null ? null : r.ts + dur * 1000,
        // Standing since before the log opens (its initial[]): `since` is
        // then where the log starts, not when it was applied.
        ...(initial || (still && prev.initial) ? { initial: true } : {}),
      });
      return;
    }
    const e = up.get(key);
    if (!e) return;
    if (r.event === 'status_off' || (r.event === 'status_stacks' && r.stacks === 0)) { up.delete(key); return; }
    if (r.event === 'status_stacks') { if (r.stacks !== null) e.stacks = r.stacks; return; }
    if (r.event === 'status_refresh') {
      const again = seconds(parseExtra(r.extra).refresh_dur);
      e.lastAt = r.ts;
      if (r.stacks !== null) e.stacks = r.stacks;
      if (again !== null) e.expires = Math.max(e.expires ?? 0, r.ts + again * 1000);
    }
  });
  const standing = [...up.values()].filter((e) => e.expires === null || e.expires > at)
    .sort((a, b) => b.lastAt - a.lastAt);
  return { lastPress, pressed, standing };
}

// One actor's STRETCHES OF PLAY inside a window, and what each pressed.
//
// A span of a capture is rarely one fight. The 2026-10-13 Warrior's first
// snapshot stands over 6,716 seconds that hold sixty seconds of the chain
// alone, eight skills pressed one at a time, a held skill at three charge
// levels and a rotation - and a ledger over all of it compares each skill's
// mean with ONE model fight that presses everything the span pressed
// anywhere. Before a per-hit delta on such a span is read as a formula, the
// reader has to know the span was not played alike; this is what says so.
//
//   source    the actor (exact handle)
//   target    count only damage rows on this archetype (null: any target)
//   windows   [{ from, to }] as `aggregate` takes them (null: the whole log)
//   gapMs     a stretch ends where neither a damage row nor a press of the
//             actor was logged for longer than this. Thirty seconds is the
//             file's own line between cadence and a break (`aggregate`'s
//             gapCeilMs); it is a way to count, not a fact about the game.
//
// Returns { stretches: [{ startTs, endTs, hits, skills: { id: rows },
// pressed: { id: presses } }] } in time order. Press rows exist from the
// probe that writes them; on an older log every stretch has none.
export async function stretches(path, { source, target = null, windows = null, gapMs = 30_000 } = {}) {
  if (!source) throw new Error('capture: stretches() needs a source');
  const inWindows = windowTest(windows);
  const out = [];
  let cur = null;
  await streamCapture(path, (r) => {
    if (r.source !== source || r.ts === null || !inWindows(r.ts)) return;
    const hit = r.event === 'inflict' && (!target || archetype(r.target) === target);
    const press = r.event === 'press';
    if (!hit && !press) return;
    if (!cur || r.ts - cur.endTs > gapMs) {
      cur = { startTs: r.ts, endTs: r.ts, hits: 0, skills: {}, pressed: {} };
      out.push(cur);
    }
    cur.endTs = r.ts;
    if (hit) { cur.hits++; cur.skills[r.skill] = (cur.skills[r.skill] ?? 0) + 1; }
    else cur.pressed[r.skill] = (cur.pressed[r.skill] ?? 0) + 1;
  });
  return { stretches: out };
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
  // How many `press` rows the file holds for the actor asked about (every
  // actor's when none was). A window with no press row means "nothing was
  // pressed" only in a log that writes them, and this pass reads every row
  // anyway.
  let pressRows = 0;

  const receipt = await streamCapture(path, (r) => {
    // Damage attributed to whichever build was standing when it landed. Counted
    // here because this pass is already reading every row, and because picking a
    // snapshot by recency picks the one written as the player logged out - which
    // has no damage after it at all. A build description is only useful in
    // proportion to the evidence it covers.
    if (r.event === 'inflict') {
      const cur = open.get(r.source);
      if (cur) {
        cur.events++; cur.damage += r.amount ?? 0;
        // Per-archetype counts, so a caller verifying against one target can
        // pick the snapshot that actually saw it: a dummy calibration
        // followed by a rift leaves the NEWEST snapshot rich in everything
        // except dummy hits, and target-blind selection chose it.
        const a = archetype(r.target);
        cur.targets[a] = (cur.targets[a] ?? 0) + 1;
      }
      return;
    }
    if (r.event === 'press') {
      if (!source || r.source === source) pressRows++;
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
        targets: {},
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
          // The infusion fields, under the names the modkit dump uses
          // (`infusionBonusStat`, the game's own field name, is accepted).
          // Set ONLY when the row carries the key: a probe that predates
          // them writes none, and inventory.mjs reads a missing key as "not
          // recorded" - which is not the same thing as "not infused".
          ...(x.infusion !== undefined ? { infusion: x.infusion === '' ? null : x.infusion } : {}),
          ...((x.infusionStat ?? x.infusionBonusStat) !== undefined
            ? { infusionStat: (x.infusionStat ?? x.infusionBonusStat) || null } : {}),
          ...(x.prismatic !== undefined ? { prismatic: x.prismatic === '1' } : {}),
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
      // WHICH weapon skills are slotted, per weapon - the one build fact no
      // other source carries. The dump has only the item; the snapshot's
      // arsenals list is the weapons OWNED, not the choices made; and the
      // arsenal pool makes even the weapon PASSIVE a choice, so a build
      // rebuilt without this row prices Gash's companion hook on a passive
      // it cannot know is slotted. `skill_id` is the slotted skill,
      // `extra.host` the granting weapon's item kind - the probe reads
      // HeroSpecialization.arsenals, which is keyed by weapon, not by hand;
      // the loadout builder matches hosts against the WORN weapons. Probe v4
      // emits it; older captures simply leave the map empty and the default
      // selection stands.
      case 'snap_wskill': {
        (s.weaponSkills ??= {})[x.host ?? '?'] ??= [];
        s.weaponSkills[x.host ?? '?'].push(r.skill);
        break;
      }
      // The runes actually SLOTTED, one row per rune with its host skill -
      // read off each skill instance's replicated masteries list, i.e. what
      // BaseSkill.hasMastery@6196 would answer. The jobs dump lists what is KNOWN;
      // this says what is active, and the difference has been caught live
      // (a Battle Shout press with no M3 buff behind it). Probe v5.
      // The equipped conduits in slot order, duplicates real (probe v7) -
      // stacks carries the slot index.
      case 'snap_conduit':
        (s.conduits ??= []).push(r.skill);
        break;
      case 'snap_rune':
        // The explicit empty marker: `none` with count=0 makes "zero slotted"
        // a recorded fact rather than an absence a reader would paper over
        // with the jobs dump's known-runes list.
        s.runes ??= [];
        if (r.skill !== 'none') s.runes.push({ id: r.skill, host: x.host ?? null });
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

  // Each snapshot stands until the next one for the same actor. `index` is
  // its place among that actor's snapshots, from 1 - the number a person
  // names one by (`bench verify --snapshot 3`).
  const byActor = new Map();
  const counts = new Map();
  for (const s of out) {
    const prev = byActor.get(s.actor);
    if (prev) prev.until = s.ts;
    byActor.set(s.actor, s);
    s.until = null;
    s.index = (counts.get(s.actor) ?? 0) + 1;
    counts.set(s.actor, s.index);
  }

  return { ...receipt, snapshots: out, pressRows };
}

// The snapshot STANDING at a moment: the last one written at or before it.
// Null before the first - rows can precede it (the probe writes a snapshot a
// little after login, and a character's first swings can beat it).
export function snapshotAt(snaps, ts) {
  let at = null;
  for (const s of snaps) if (s.ts <= ts && (!at || s.ts >= at.ts)) at = s;
  return at;
}

// What separates two snapshots AS BUILDS, in words - empty when they describe
// the same one. The probe writes a snapshot at every login as well as at
// every change, so two snapshots are not two builds until something a build
// is made of differs: a worn piece (its upgrade, level, rarity, infusion), a
// talent's rank, a slotted weapon skill, a rune, a socketed augment, a
// conduit, the level. The sheet and affix rows are left out on purpose: they
// follow from those facts, and they also catch whatever buff happened to be
// up when the snapshot was written.
//
// `relevant(kind)` narrows the gear rows to the ones that are equipment - a
// snapshot lists the bag too, and a potion drunk between two snapshots is not
// a build change. Left out, every gear row counts.
export function buildDiff(a, b, { relevant = null } = {}) {
  const facts = (s) => {
    const m = new Map();
    const seen = new Map();
    for (const g of s.gear ?? []) {
      if (relevant && !relevant(g.kind)) continue;
      const n = (seen.get(g.kind) ?? 0) + 1;   // two rings of one kind are two rows
      seen.set(g.kind, n);
      const bits = [
        g.upgrade != null ? `+${g.upgrade}` : null, g.level != null ? `L${g.level}` : null, g.rarity ?? null,
        g.flawless ? 'flawless' : null, g.infusion ? `infusion ${g.infusion}` : null,
        g.infusionStat ? `stat ${g.infusionStat}` : null, g.prismatic ? 'prismatic' : null,
      ].filter(Boolean).join(' ');
      m.set(`gear ${g.kind}${n > 1 ? ` (${n})` : ''}`, bits || 'worn');
    }
    for (const t of s.talents ?? []) m.set(`talent ${t.id}`, String(t.rank ?? '?'));
    for (const [host, ids] of Object.entries(s.weaponSkills ?? {})) m.set(`skills of ${host}`, [...ids].sort().join('+'));
    for (const r of s.runes ?? []) m.set(`rune ${r.id}`, 'slotted');
    for (const k of s.sockets ?? []) m.set(`socket ${k.host ?? '?'} [${k.index ?? '?'}]`, k.augment);
    (s.conduits ?? []).forEach((c, i) => m.set(`conduit ${i}`, c));
    if (s.level != null) m.set('level', String(s.level));
    return m;
  };
  const fa = facts(a);
  const fb = facts(b);
  const out = [];
  for (const [k, v] of fa) {
    if (!fb.has(k)) out.push(`${k}: ${v} -> none`);
    else if (fb.get(k) !== v) out.push(`${k}: ${v} -> ${fb.get(k)}`);
  }
  for (const [k, v] of fb) if (!fa.has(k)) out.push(`${k}: none -> ${v}`);
  return out;
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
