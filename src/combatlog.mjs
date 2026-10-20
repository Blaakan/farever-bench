// ---------------------------------------------------------------------------
// combatlog.mjs - read a combat log that something other than the bench-probe
// wrote, and hand the bench the same rows the probe's CSV gives it.
//
// Two families of file are read (docs/COMBAT-LOG.md is their contract):
//
//   farever-combat-log v1   JSON Lines, a header line and one event per line,
//                           written by any exporter that follows the spec
//   wink-timeline           Wink's DPS Meter per-event file, <id>.json.timeline,
//                           unchanged: the same event layout, a shorter header
//   wink-summary            Wink's fight summary, <id>.json - totals per skill
//                           and no event at all. Read for its start time, its
//                           encounter facts and as a total check beside the
//                           timeline; alone it is evidence of totals only
//
// The event fields ARE Wink's (seq, time, kind, source, target, skill, origin,
// amount, critical, ...). That is deliberate: a Wink user can hand the bench
// the files the meter already wrote, and an exporter author has one layout to
// learn. Only the field NAMES are mirrored; nothing of Wink's code is.
//
// What a third-party log is NOT, and what this reader therefore refuses to
// pretend:
//
//   * It is not the probe's view. Wink keeps an event only when the local
//     player is its source or its target, so a party member's hits and the
//     debuffs they put on the boss are not in the file. A local-only log of a
//     party fight is evidence of the character's totals, not of a formula:
//     what raised the live damage is partly invisible. `stats.solo` says
//     which kind of fight this was, when the file can say.
//   * A `skill_use` is not a press. Wink hooks the client's skill START, which
//     fires for automatic and child starts the player never pressed. It is
//     read as a press with `via=start`, and a use whose origin is another
//     skill (a child started by its parent) is not read as one at all.
//   * Its dates do not place it on a build. The probe's session row names the
//     hlboot.dat it booted from; a third-party file names, at best, the
//     bootSha256, Steam build or game version its header carries. The rows
//     this reader makes open with ONE synthetic session row that says
//     `boot=unreadable` and `build=<what the header named>`, so capture.mjs
//     captureEra answers "this build" only on a matching sha and "cannot tell"
//     otherwise - never "another build" off a file time, which would price the
//     training Dummy at the armour it had before the 2026-10 build.
//
// Every file a stranger uploads is read with two guards: a gzip stream is
// inflated to 64 MB at most, and a log holds 2,000,000 events at most. One
// fight's log is a few megabytes; anything past either line is refused unread.
//
// Zero dependencies (node:zlib only), and pure apart from that: the caller
// hands in text or bytes, never a path, so the UI and the CLI read the same.
// ---------------------------------------------------------------------------

import { gunzipSync } from 'node:zlib';
import {
  DIFFICULTY_NAMES, WINK_NO_BOSS, CLOCKS, OUTCOMES, GAME_VERSION_RE, GAME_ID_RE, difficultyIndex,
} from './submission-public.mjs';

export const LOG_FORMAT = 'farever-combat-log';
export const LOG_VERSION = 1;
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
export const MAX_LOG_EVENTS = 2_000_000;

// The times a fight can start at, in epoch milliseconds: from 2001-09-09
// (1e12) to 2286-11-20 (1e13). Below that line sits the one slip every
// exporter author makes once - epoch SECONDS, which would date the fight in
// January 1970 and print that date into a report and a submission - and above
// it nothing a fight was fought at; past 8.64e15 not even a date, and the
// report that printed one would throw. An event's own `time` is held to 1e7
// seconds either side of the start (115 days) for the same reason: no fight
// is that long, and its row's ts would be no date either.
const MIN_EPOCH_MS = 1e12;
const MAX_EPOCH_MS = 1e13;
const MAX_EVENT_SECONDS = 1e7;

// The sentence every reader of rows says about a summary on its own. The
// summary's per-skill rows are filed under the skill that STARTED each hit and
// summed over every target, so they cannot stand where rows are needed.
export const SUMMARY_ONLY = 'summary-only log: per-skill totals, no per-event rows';

// The one error this module throws, always one sentence a player can act on.
export class CombatLogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CombatLogError';
  }
}

// ActivityDifficulty's cases by index (submission-public.mjs holds the one
// list); the names are accepted where a number is expected too.
export const DIFFICULTIES = DIFFICULTY_NAMES;

// --- Wink's "Boss" (the submission lane) -----------------------------------
// WINK_NO_BOSS (submission-public.mjs) is what the Wink meter writes as the
// boss of a fight whose boss had no kind. It reads as "not known" here - in
// the encounter the reader reports, in the anonymised copy's header and in
// its summary - the way publicManifest reads it, so a submission's zip and
// the manual route's issue title say the same thing about what was fought.
// The same for any boss kind the game has no unit for - a display name an
// exporter wrote where the id goes ("King Ratsar"). This file has no game
// data, so the caller that has it passes `isUnit` (kind -> boolean) to
// anonymizeLog; src/submit.mjs does, and leaves such a kind out of the
// manifest, so the copy's header and summary leave it out too. Without
// `isUnit` only "Boss" and '' go.
function bossKnown(kind, isUnit = null) {
  if (!nonEmpty(kind) || kind === WINK_NO_BOSS) return null;
  return typeof isUnit === 'function' && !isUnit(kind) ? null : kind;
}
// --- end of Wink's "Boss" ------------------------------------------------------

// Line numbers ride on each event without becoming a field of it: a symbol
// key is invisible to JSON.stringify and to Object.keys.
const LINE = Symbol('line');
const ORDER = Symbol('order');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => typeof v === 'string' && v !== '';
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// What is wrong with a value offered as a fight's time 0, as the end of a
// sentence that opens with what it is ("the header's startedAt"), or null
// when it is a time a fight can start at.
function epochProblem(v, what) {
  if (!isNum(v)) return `${what} is ${JSON.stringify(v) ?? String(v)}, not a number of epoch milliseconds`;
  if (v >= MIN_EPOCH_MS && v < MAX_EPOCH_MS) return null;
  if (v >= 1e9 && v < 1e11) {
    return `${what} is ${v}, which looks like epoch SECONDS - it is epoch milliseconds (${v} s would be ${Math.round(v * 1000)})`;
  }
  return `${what} is ${v}, which is no epoch-milliseconds time a fight was fought at (between 2001 and 2286)`;
}

// A date for a sentence, or the number itself when it is none.
function stampOf(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString().replace('T', ' ').slice(0, 19);
}

// --- which kind of file ------------------------------------------------------
// Decided on the FIRST object of the file - the header line of a JSON Lines
// log, or the whole object of a summary - by its shape, the way Wink's own
// reader tells its files apart. Returns the dialect name or null. A file that
// declares another `format` (a character sheet, a bench envelope) is not a
// combat log, whatever else it holds. A Wink timeline header never carries a
// `startedAt` (TimelineStore writes version, me, duration, initial, count,
// clock and leadIn, and nothing else): a header with one and no `format` is a
// farever-combat-log header that forgot its format, and is no dialect - read
// as a Wink timeline, its own start would be thrown away for a file time.
export function detectLogDialect(first) {
  if (!isObj(first)) return null;
  if (first.format === LOG_FORMAT) return LOG_FORMAT;
  if (first.format !== undefined) return null;
  if (first.kind === 'rift-recap') return 'wink-rift-recap';
  if (Array.isArray(first.players) && ('startedAt' in first || 'meName' in first || 'bossKind' in first || 'me' in first)) return 'wink-summary';
  if ('me' in first && ('count' in first || Array.isArray(first.initial)) && !('players' in first) && !('startedAt' in first)) return 'wink-timeline';
  return null;
}

// Wink names a rift recap's files recap_<session>_<n>.json and
// recap_<session>_<n>.json.timeline (RunWriter.archiveRecap), and the
// recap's timeline is an ordinary-looking timeline: only the name, or the
// recap beside it, says what it is.
const RECAP_NAME = /(^|[\\/])recap_[^\\/]*\.json(\.timeline)?$/i;

// The one sentence for a recap, whichever of its two files was given. Wink
// saves each phase of a rift (the gates, the boss) as an ordinary fight as
// well, in the rift's own history folder, and those are what the bench reads.
function recapRefusal(name, other = null) {
  return new CombatLogError(`${name} is ${/\.timeline$/i.test(name) ? 'the timeline of ' : ''}a Wink rift recap `
    + `${other ? `(${other} beside it says so) ` : ''}- a rift's gate and boss phases in one recording - and this bench does not read `
    + 'rift recaps yet. Wink also saves each phase as an ordinary fight, in the rift\'s own history folder: give the bench that '
    + 'fight\'s fight_<id>.json.timeline, with its fight_<id>.json beside it');
}

// --- bytes to lines ----------------------------------------------------------
// Text or bytes, gzip sniffed by its magic (1f 8b), a UTF-8 byte-order mark
// dropped. The size guard applies to what would be parsed: the inflated
// stream, or the plain text as given.
function decode(name, data) {
  const tooBig = () => new CombatLogError(
    `${name} is larger than ${MAX_LOG_BYTES / 1024 / 1024} MB of text, which no one fight's log is: it was refused unread`);
  if (typeof data === 'string') {
    if (Buffer.byteLength(data, 'utf8') > MAX_LOG_BYTES) throw tooBig();
    return dropBom(data);
  }
  let buf = data;
  if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data) && !Buffer.isBuffer(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!Buffer.isBuffer(buf)) throw new CombatLogError(`${name}: nothing to read - a combat log is text or bytes`);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const out = inflateCapped(buf, MAX_LOG_BYTES);
    if (out.tooLarge) {
      throw new CombatLogError(`${name} inflates to more than ${MAX_LOG_BYTES / 1024 / 1024} MB, which no one fight's log does: it was refused unread`);
    }
    if (out.error) throw new CombatLogError(`${name} starts like a gzip file but does not inflate (${out.error})`);
    buf = out.data;
  } else if (buf.length > MAX_LOG_BYTES) {
    throw tooBig();
  }
  return dropBom(buf.toString('utf8'));
}

/**
 * A gzip stream inflated to at most `cap` bytes: { data } (a Buffer), or
 * { tooLarge: true } when it would inflate past the cap - nothing past it is
 * ever held - or { error } (a phrase) when it is not gzip at all. Each caller
 * says the outcome in its own sentence: the reader at its 64 MB, a
 * submission at its 20 MB per log.
 */
export function inflateCapped(buf, cap) {
  try {
    return { data: gunzipSync(buf, { maxOutputLength: cap }) };
  } catch (e) {
    if (e instanceof RangeError || e?.code === 'ERR_BUFFER_TOO_LARGE') return { tooLarge: true };
    return { error: String(e?.message ?? e) };
  }
}

// A UTF-8 byte-order mark (U+FEFF), which some editors write, is not text.
function dropBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// One file: its first object and the lines after it. A summary is one object,
// usually on one line (Wink writes it so) but sometimes saved pretty-printed
// by hand, which is read whole.
function parseFile(name, data) {
  const text = decode(name, data);
  const lines = text.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first].trim() === '') first++;
  if (first >= lines.length) throw new CombatLogError(`${name} is empty`);
  let head;
  try {
    head = JSON.parse(lines[first]);
  } catch {
    let whole = null;
    try { whole = JSON.parse(text); } catch { /* said below */ }
    if (isObj(whole)) return { name, head: whole, headLine: first + 1, rest: [], lineCount: lines.length };
    throw new CombatLogError(`${name}: line ${first + 1} is not JSON, so this is not a combat log `
      + '(a farever-combat-log or a Wink DPS Meter file opens with one JSON object)');
  }
  if (!isObj(head)) throw new CombatLogError(`${name}: line ${first + 1} is not a JSON object, so this is not a combat log`);
  const rest = [];
  for (let i = first + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (rest.length >= MAX_LOG_EVENTS) {
      throw new CombatLogError(`${name} holds more than ${MAX_LOG_EVENTS.toLocaleString('en-US')} events, which no one fight's log does: it was refused`);
    }
    rest.push({ lineNo: i + 1, text: lines[i] });
  }
  // A trailing newline is not a line.
  const lineCount = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  return { name, head, headLine: first + 1, rest, lineCount };
}

// ActivityDifficulty as the reader takes it (submission-public.mjs
// difficultyIndex), held to the cases: -1 (unknown) to the last name.
function difficultyOf(v) {
  const d = difficultyIndex(v);
  if (d === null || d === undefined) return d;   // undefined: present and unreadable - the caller says so
  return Number.isInteger(d) && d >= -1 && d < DIFFICULTIES.length ? d : undefined;
}

// --- the reader ----------------------------------------------------------------
//
//   name       what to call the file in sentences (its base name)
//   data       its text or its bytes, gzip or not
//   mtimeMs    the file's modification time, for a Wink timeline read without
//              its summary: Wink writes the file as the fight ends, so the
//              start is that time minus the fight's duration - an estimate,
//              and said to be one
//   companion  { name, data }: the Wink summary beside a timeline (or the
//              timeline beside a summary - the two are told apart by shape)
//
// Returns the log: { dialect, name, companionName, header, initial, events,
// summary, startedAt, startedAtEstimated, perEvent, me, handle, problems,
// notes, stats, ... }. `events` are the parsed objects in (time, seq) order,
// uids as strings. `problems` are sentences about what is wrong with the file
// (each counted once, with how many rows it touched); `notes` are what the
// reader of the evidence has to know about it. Throws CombatLogError only
// when nothing can be read: not JSON, no dialect it knows (a rift recap and
// its timeline included), a newer version, a header without the fields that
// place it in time and say whose it is, a start that is no time a fight
// starts at (epochProblem), a count that is not a whole number or does not
// match, or either size guard.
export function readCombatLog({ name = 'the combat log', data, mtimeMs = null, companion = null } = {}) {
  const problems = [];
  const notes = [];
  let main = parseFile(name, data);
  // A companion that cannot be read costs the log its companion, not the log.
  let comp = null;
  if (companion) {
    try {
      comp = parseFile(companion.name ?? 'the summary', companion.data);
    } catch (e) {
      if (!(e instanceof CombatLogError)) throw e;
      problems.push(`the summary beside it could not be read, so it was not used: ${e.message}`);
    }
  }
  let dialect = detectLogDialect(main.head);
  // Given the two Wink files the other way round (a multi-select has no order).
  if (dialect === 'wink-summary' && comp && detectLogDialect(comp.head) === 'wink-timeline') {
    [main, comp] = [comp, main];
    dialect = 'wink-timeline';
    mtimeMs = null;
  }

  if (!dialect) {
    if (isObj(main.head) && main.head.format !== undefined) {
      throw new CombatLogError(`${main.name} is a "${String(main.head.format)}" file, not a combat log`);
    }
    if (isObj(main.head) && 'startedAt' in main.head && 'me' in main.head) {
      throw new CombatLogError(`${main.name}: the header has startedAt and me but no "format" - a ${LOG_FORMAT} header opens with `
        + `"format": "${LOG_FORMAT}", "version": ${LOG_VERSION} (and a Wink timeline header carries no startedAt, so it is not one of those)`);
    }
    throw new CombatLogError(`${main.name} is not a combat log this bench reads: its first object is none of a `
      + `${LOG_FORMAT} header ("format": "${LOG_FORMAT}"), a Wink DPS Meter timeline header (me, count, initial) `
      + 'or a Wink fight summary (players, startedAt)');
  }
  if (dialect === 'wink-rift-recap') throw recapRefusal(main.name);
  // A recap's own timeline: told by the recap beside it, or by Wink's name
  // for it when it came alone.
  if (dialect === 'wink-timeline' && comp && detectLogDialect(comp.head) === 'wink-rift-recap') throw recapRefusal(main.name, comp.name);
  if (dialect === 'wink-timeline' && RECAP_NAME.test(main.name)) throw recapRefusal(main.name);
  if (dialect === 'wink-summary') return readSummaryOnly(main, comp, problems, notes);

  const head = main.head;
  if (dialect === LOG_FORMAT) {
    if (!(isNum(head.version) && Number.isInteger(head.version) && head.version >= 1)) {
      throw new CombatLogError(`${main.name}: the header has no version (a ${LOG_FORMAT} header says "version": ${LOG_VERSION})`);
    }
    if (head.version > LOG_VERSION) {
      throw new CombatLogError(`${main.name} is ${LOG_FORMAT} version ${head.version}; this bench reads version ${LOG_VERSION} - a newer bench reads it`);
    }
    const missing = [];
    if (head.startedAt === undefined || head.startedAt === null) missing.push('startedAt');
    if (!(nonEmpty(head.me) || isNum(head.me))) missing.push('me');
    if (missing.length) {
      throw new CombatLogError(`${main.name}: the header lacks ${missing.join(' and ')} - a ${LOG_FORMAT} header needs format, version, `
        + 'startedAt (the epoch milliseconds of time 0) and me (the uid of the character the log is for, as its events write it)');
    }
    const when = epochProblem(head.startedAt, 'the header\'s startedAt');
    if (when) throw new CombatLogError(`${main.name}: ${when}`);
    if (comp) notes.push(`${comp.name} was not read: a companion summary belongs beside a Wink timeline, and a ${LOG_FORMAT} header carries what it would give`);
    comp = null;
  } else {
    if (head.version !== undefined && head.version !== 1) {
      throw new CombatLogError(`${main.name} is a Wink timeline of version ${String(head.version)}; this bench reads version 1`);
    }
    if (!(nonEmpty(head.me) || isNum(head.me))) {
      throw new CombatLogError(`${main.name}: the Wink timeline header names no "me", so whose log it is cannot be told`);
    }
  }
  let coerced = 0;
  const uid = (v) => {
    if (isNum(v)) { coerced++; return String(v); }
    return v;
  };
  const me = uid(head.me);

  // The summary beside a Wink timeline: its start time, its encounter facts,
  // the submitter's name and the game version. One that is not this fight's
  // (another `me`) is not used, and that is said.
  let summary = null;
  if (comp) {
    const d = detectLogDialect(comp.head);
    if (d !== 'wink-summary') {
      problems.push(`${comp.name} is not a Wink fight summary, so it was not used`);
    } else if (comp.head.me !== undefined && comp.head.me !== null && String(comp.head.me) !== me) {
      problems.push(`${comp.name} is another fight's summary (its "me" is ${String(comp.head.me)}, the timeline's ${me}), so it was not used`);
    } else {
      summary = comp.head;
    }
  }

  const { startedAt, startedAtEstimated } = timeZero({ dialect, head, summary, comp, main, mtimeMs, problems, notes });
  const { events, initial, malformed } = readEvents(main, head, uid, problems);

  const log = {
    dialect,
    name: main.name,
    companionName: summary ? comp.name : null,
    header: head,
    initial,
    events,
    summary,
    startedAt,
    startedAtEstimated,
    perEvent: true,
    me,
    lineCount: main.lineCount,
    malformed,
    problems,
    notes,
  };
  index(log);
  validateDamage(log);
  if (coerced) problems.push(`${plural(coerced, 'uid')} ${coerced === 1 ? 'was' : 'were'} written as a number; uids are JSON strings (read as such here)`);
  if (events.length && !events.some((e) => e.source === me || e.target === me)) {
    problems.push(`the header's "me" (${me}) is neither the source nor the target of any event - is it the uid the events use?`);
  }
  const gaps = events.filter((e) => e.kind === 'recording_gap').length;
  if (gaps) problems.push(`the recorder says an observation failed (${plural(gaps, 'recording_gap event')}): the log may be missing rows`);
  const diff = dialect === LOG_FORMAT ? head.encounter?.difficulty : summary?.difficulty;
  if (difficultyOf(diff) === undefined) problems.push(`the encounter's difficulty ${JSON.stringify(diff)} is none of -1, 0, 1, 2 or ${DIFFICULTIES.join(', ')}: read as unknown`);
  log.stats = statsOf(log);
  limitsNotes(log);
  if (summary) totalCheck(log);
  return log;
}

// --- time 0 -----------------------------------------------------------------
// A v1 header's own startedAt; a Wink timeline's from its summary, else the
// file's modification time minus the fight's duration, ESTIMATED and said.
// A summary's start that is no time a fight starts at is not used; the file
// time stands in for it, as when there is no summary.
function timeZero({ dialect, head, summary, comp, main, mtimeMs, problems, notes }) {
  const summaryWhen = summary && summary.startedAt !== undefined && summary.startedAt !== null
    ? epochProblem(summary.startedAt, `${comp.name}'s startedAt`) : null;
  if (summaryWhen) problems.push(`${summaryWhen}, so it was not used`);
  if (dialect === LOG_FORMAT) return { startedAt: head.startedAt, startedAtEstimated: head.startedAtEstimated === true };
  if (summary && summary.startedAt !== undefined && summary.startedAt !== null && !summaryWhen) {
    return { startedAt: summary.startedAt, startedAtEstimated: false };
  }
  if (isNum(mtimeMs)) {
    const startedAt = Math.round(mtimeMs - (isNum(head.duration) ? head.duration : 0) * 1000);
    const est = epochProblem(startedAt, 'the start worked out from the file\'s modification time minus the fight\'s duration');
    if (est) throw new CombatLogError(`${main.name}: ${est} - give it its fight summary, which carries the real one`);
    notes.push('the start time is ESTIMATED: the file\'s modification time minus the fight\'s duration (Wink writes the timeline '
      + 'as the fight ends). Its summary, the <id>.json beside it, carries the real one');
    return { startedAt, startedAtEstimated: true };
  }
  if (summaryWhen) {
    throw new CombatLogError(`${main.name}: ${summaryWhen}, and with no file time to estimate it from, the fight cannot be placed in time`);
  }
  // Wink's summary is the timeline's name without `.timeline`; a file
  // named otherwise was renamed, and its summary's name cannot be told.
  const sibling = /\.timeline$/i.test(main.name) && main.name.replace(/\.timeline$/i, '') ? main.name.replace(/\.timeline$/i, '') : '<id>.json';
  throw new CombatLogError(`${main.name}: a Wink timeline carries no start time of its own - give it its fight summary `
    + `(${sibling}) with it`);
}

// --- the events --------------------------------------------------------------
// The event lines, held to the header's count, parsed and sorted by (time,
// seq); the header's initial[] beside them. What cannot be read is skipped,
// counted and said in `problems`.
function readEvents(main, head, uid, problems) {
  if (head.count !== undefined && !(isNum(head.count) && Number.isInteger(head.count) && head.count >= 0)) {
    throw new CombatLogError(`${main.name}: the header's count is ${JSON.stringify(head.count) ?? String(head.count)}, not a number of events - `
      + 'count is the number of event lines as a whole number, or left out');
  }
  if (head.count !== undefined && head.count !== main.rest.length) {
    throw new CombatLogError(`${main.name}: the header says ${head.count} events and the file holds ${main.rest.length} - `
      + 'it was cut short or added to, and a fight with rows missing reads as another fight');
  }
  let malformed = 0;
  let noKind = 0;
  let noTime = 0;
  let farTime = 0;
  const events = [];
  for (const { lineNo, text } of main.rest) {
    let ev;
    try { ev = JSON.parse(text); } catch { malformed++; continue; }
    if (!isObj(ev)) { malformed++; continue; }
    if (!nonEmpty(ev.kind)) { noKind++; continue; }
    if (!isNum(ev.time)) { noTime++; continue; }
    if (Math.abs(ev.time) > MAX_EVENT_SECONDS) { farTime++; continue; }
    for (const k of ['source', 'target', 'instance']) if (ev[k] !== undefined) ev[k] = uid(ev[k]);
    ev[LINE] = lineNo;
    ev[ORDER] = events.length;
    events.push(ev);
  }
  // Wink writes in (time, seq) order; the spec does not require it, and the
  // capture readers group by the exact millisecond, so it is made true here.
  const seqOf = (e) => (isNum(e.seq) ? e.seq : Infinity);
  events.sort((a, b) => a.time - b.time || seqOf(a) - seqOf(b) || a[ORDER] - b[ORDER]);

  // The statuses (and procs) already standing when the recording opened.
  const initial = [];
  let badInitial = 0;
  for (const e of Array.isArray(head.initial) ? head.initial : []) {
    if (!isObj(e) || !nonEmpty(e.kind)) { badInitial++; continue; }
    if (isNum(e.time) && Math.abs(e.time) > MAX_EVENT_SECONDS) { badInitial++; continue; }
    for (const k of ['source', 'target', 'instance']) if (e[k] !== undefined) e[k] = uid(e[k]);
    e[LINE] = main.headLine;
    e[ORDER] = initial.length;
    initial.push(e);
  }
  const firstTime = events.length ? events[0].time : 0;
  for (const e of initial) if (!isNum(e.time)) e.time = Math.min(0, firstTime);

  if (malformed) problems.push(`${plural(malformed, 'line')} of the file ${malformed === 1 ? 'is' : 'are'} not a JSON object and ${malformed === 1 ? 'was' : 'were'} skipped`);
  if (noKind) problems.push(`${plural(noKind, 'event')} ${noKind === 1 ? 'has' : 'have'} no kind and ${noKind === 1 ? 'was' : 'were'} skipped`);
  if (badInitial) {
    problems.push(`${plural(badInitial, 'entry', 'entries')} of the header's initial[] ${badInitial === 1 ? 'is' : 'are'} not an event, `
      + `or ${badInitial === 1 ? 'has a time' : 'have times'} no fight has, and ${badInitial === 1 ? 'was' : 'were'} skipped`);
  }
  if (noTime) problems.push(`${plural(noTime, 'event')} ${noTime === 1 ? 'has' : 'have'} no time and ${noTime === 1 ? 'was' : 'were'} skipped`);
  if (farTime) {
    problems.push(`${plural(farTime, 'event')} ${farTime === 1 ? 'has a time' : 'have times'} more than ${MAX_EVENT_SECONDS.toLocaleString('en-US')} s `
      + `from startedAt, which no fight lasts, and ${farTime === 1 ? 'was' : 'were'} skipped`);
  }
  return { events, initial, malformed };
}

// A summary alone: no event, totals per skill under their ORIGIN ids. Read so
// that it can travel with a submission and be printed; refused wherever rows
// are needed.
function readSummaryOnly(main, comp, problems, notes) {
  const s = main.head;
  if (s.version !== undefined && s.version !== 1) {
    throw new CombatLogError(`${main.name} is a Wink fight summary of version ${String(s.version)}; this bench reads version 1`);
  }
  if (comp) notes.push(`${comp.name} was not read: it is not the timeline of ${main.name}`);
  const me = s.me !== undefined && s.me !== null && s.me !== '' ? String(s.me) : (s.players.find((p) => p?.isMe === true)?.uid ?? null);
  const when = s.startedAt === undefined || s.startedAt === null ? null : epochProblem(s.startedAt, 'its startedAt');
  const log = {
    dialect: 'wink-summary',
    name: main.name,
    companionName: null,
    header: null,
    initial: [],
    events: [],
    summary: s,
    startedAt: s.startedAt !== undefined && s.startedAt !== null && !when ? s.startedAt : null,
    startedAtEstimated: false,
    perEvent: false,
    me: me === null ? null : String(me),
    lineCount: main.lineCount,
    malformed: 0,
    problems,
    notes,
  };
  if (when) problems.push(`${when}: read as no start time`);
  else if (log.startedAt === null) problems.push('the summary names no start time');
  if (difficultyOf(s.difficulty) === undefined) problems.push(`the encounter's difficulty ${JSON.stringify(s.difficulty)} is none of -1, 0, 1, 2: read as unknown`);
  index(log);
  log.stats = statsOf(log);
  notes.push(`${SUMMARY_ONLY}. Its per-skill rows are filed under the skill that STARTED each hit (a status's ticks under the `
    + 'skill that applied it, a pet\'s swings under the skill that summoned it) and sum every target, so they cannot be joined to the '
    + 'bench\'s per-hit lines: it travels with a submission as evidence of totals, and `bench verify` refuses it');
  limitsNotes(log);
  return log;
}

// Who is who, once: each uid's unit kind (from targetKind on the rows that hit
// or touch it, and the bench-addition sourceKind on the rows it is the source
// of), each uid's display name, the uids a summary lists as players, and the
// character's HANDLE - the name its rows are written under, which is what
// `bench verify --character` selects on.
function index(log) {
  const kinds = new Map();     // uid -> Set of kinds
  const names = new Map();     // uid -> first name seen
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const e of [...log.initial, ...log.events]) {
    if (nonEmpty(e.target) && nonEmpty(e.targetKind)) add(kinds, e.target, e.targetKind);
    if (nonEmpty(e.source) && nonEmpty(e.sourceKind)) add(kinds, e.source, e.sourceKind);
    if (nonEmpty(e.source) && nonEmpty(e.sourceName) && !names.has(e.source)) names.set(e.source, e.sourceName);
    if (nonEmpty(e.target) && nonEmpty(e.targetName) && !names.has(e.target)) names.set(e.target, e.targetName);
  }
  const listed = new Map();    // uid -> name, the summary's players
  for (const p of Array.isArray(log.summary?.players) ? log.summary.players : []) {
    if (!isObj(p) || p.uid === undefined || p.uid === null || p.uid === '') continue;
    listed.set(String(p.uid), nonEmpty(p.name) ? p.name : null);
    if (nonEmpty(p.name) && !names.has(String(p.uid))) names.set(String(p.uid), p.name);
  }
  const me = log.me;
  const mine = me ? (log.summary?.players ?? []).find((p) => isObj(p) && (p.isMe === true || String(p.uid) === me)) : null;
  const handle = [
    log.header?.character?.name,
    log.summary?.meName,
    mine?.name,
    me ? names.get(me) : null,
  ].find(nonEmpty) ?? 'me';
  // A handle is a player's name to the capture readers only while it holds no
  // '#' (capture.mjs isPlayerHandle); a name that did would read as a unit.
  log.handle = handle.replace(/#/g, '_').trim() || 'me';
  log.units = { kinds, names, listed };
}

// The fields a damage event must carry for the bench to use it, checked once.
// A row that cannot be joined (no skill, no amount, no source) is not read;
// one without its target or the target's kind is read against `?#-1` (no
// target), `?#<uid>` (a target and no kind) or `<unit>#-1` (a kind and no
// target), none of which a --target filter matches, and counted. A target
// with no kind that the log NAMES is another player (the probe writes players
// so, and B2 reads them so: by name, no '#'), and a hit on a player is no
// problem of the file's.
const USABLE = Symbol('usable');
function validateDamage(log) {
  let noSkill = 0; let noAmount = 0; let noSource = 0; let noCrit = 0; let noTarget = 0;
  const { kinds, names, listed } = log.units;
  // (A uid some row gives a kind is no kindless player: its row lacks the kind.)
  const aPlayer = (u) => !kinds.get(u)?.size && (names.has(u) || listed.has(u));
  for (const e of log.events) {
    if (e.kind !== 'damage') continue;
    if (!nonEmpty(e.skill)) { noSkill++; continue; }
    if (!isNum(e.amount)) { noAmount++; continue; }
    if (!nonEmpty(e.source)) { noSource++; continue; }
    if (typeof e.critical !== 'boolean') noCrit++;
    if (e.target !== log.me && (!nonEmpty(e.target) || (!nonEmpty(e.targetKind) && !aPlayer(e.target)))) noTarget++;
    e[USABLE] = true;
  }
  const p = log.problems;
  if (noSkill) p.push(`${plural(noSkill, 'damage event')} ${noSkill === 1 ? 'names' : 'name'} no skill and ${noSkill === 1 ? 'was' : 'were'} not read (a damage row is joined on its skill id)`);
  if (noAmount) p.push(`${plural(noAmount, 'damage event')} ${noAmount === 1 ? 'carries' : 'carry'} no amount and ${noAmount === 1 ? 'was' : 'were'} not read`);
  if (noSource) p.push(`${plural(noSource, 'damage event')} ${noSource === 1 ? 'names' : 'name'} no source and ${noSource === 1 ? 'was' : 'were'} not read`);
  if (noCrit) p.push(`${plural(noCrit, 'damage event')} ${noCrit === 1 ? 'does' : 'do'} not say whether ${noCrit === 1 ? 'it was' : 'they were'} critical: read as not critical`);
  if (noTarget) {
    p.push(`${plural(noTarget, 'damage event')} ${noTarget === 1 ? 'lacks' : 'lack'} a target or its targetKind: read against `
      + '`?#-1` with no target, `?#<uid>` with no targetKind, `<unit>#-1` with a targetKind and no target - none of which a --target filter matches');
  }
}

function encounterOf(log) {
  const src = log.dialect === LOG_FORMAT ? (isObj(log.header?.encounter) ? log.header.encounter : {}) : (log.summary ?? {});
  const d = difficultyOf(src.difficulty);
  return {
    bossKind: nonEmpty(src.bossKind) && src.bossKind !== WINK_NO_BOSS ? src.bossKind : null,   // WINK_NO_BOSS: not known
    difficulty: d === undefined ? null : d,
    activityId: nonEmpty(src.activityId) ? src.activityId : null,
    targetDummy: typeof src.targetDummy === 'boolean' ? src.targetDummy : null,
    partySize: isNum(src.partySize) && Number.isInteger(src.partySize) && src.partySize > 0 ? src.partySize : null,
    outcome: nonEmpty(src.outcome) ? src.outcome : null,
  };
}

function gameVersionOf(log) {
  const v = log.header?.source?.gameVersion ?? log.summary?.gameVersion;
  return nonEmpty(v) ? v : null;
}

// The unit kinds that are a player's class: `heroKinds` (the classes' unit
// ids, when the caller has the engine), and what the log itself says - the
// kinds seen on the character and on the players a summary lists, and the
// classes its header and summary name, matched to the kinds the rows write in
// any case (Wink's className is 'warrior' where its rows write 'Warrior').
function heroKindsOf(log, heroKinds = null) {
  const { kinds, listed } = log.units;
  const hero = new Set(heroKinds ?? []);
  for (const k of kinds.get(log.me) ?? []) hero.add(k);
  for (const u of listed.keys()) for (const k of kinds.get(u) ?? []) hero.add(k);
  const classes = new Set([log.header?.character?.class, log.summary?.meClass,
    ...(Array.isArray(log.summary?.players) ? log.summary.players.map((p) => (isObj(p) ? p.className : null)) : [])]
    .filter(nonEmpty).map((c) => c.toLowerCase()));
  for (const ks of kinds.values()) for (const k of ks) if (classes.has(k.toLowerCase())) hero.add(k);
  return hero;
}

// Is a uid a player, or could it be one? The submitter is; every uid a
// summary lists is; and so is any uid no row gives a unit kind other than a
// hero's - a party healer who only ever appears as the SOURCE of a heal or a
// buff carries a name and no kind at all, and is exactly the one a blocklist
// would miss. With `isUnit` (the game's unit ids, the submission's), a kind
// that is no unit of the game counts as no kind: a display name an exporter
// wrote where the unit id belongs says nothing about what the uid is.
function playerish(log, heroKinds = null, isUnit = null) {
  const { kinds, listed } = log.units;
  const hero = heroKindsOf(log, heroKinds);
  return (u) => {
    if (!nonEmpty(u)) return false;
    if (u === log.me || listed.has(u)) return true;
    const ks = [...(kinds.get(u) ?? [])].filter((k) => typeof isUnit !== 'function' || isUnit(k));
    return ks.every((k) => hero.has(k));
  };
}

// Does the log record its character's presses? Declared by the exporter
// (`source.recordsPresses: true`, for one that hooks the input path and
// writes a `press` row for each), always so for a Wink timeline (it writes a
// `skill_use` for every skill the character starts, a held base attack's
// swings included), and otherwise seen: any press, skill_use or block_use of
// the character. A log that records none - a held base-attack chain and
// nothing pressed, from an exporter that did not say - cannot tell "nothing
// was pressed" from "presses are not written", and the readers are told it
// is the second (the session row's presses=0).
function pressesOf(log) {
  if (log.header?.source?.recordsPresses === true || log.dialect === 'wink-timeline') return { presses: true, declared: true };
  const seen = log.events.some((e) => (e.kind === 'press' || e.kind === 'skill_use' || e.kind === 'block_use') && e.source === log.me);
  return { presses: seen, declared: false };
}

// The pools (rage, spark) the log carries a value of, on its character's
// presses and skill starts - the bench-addition fields `rage` and `spark`.
function poolsOf(log) {
  const out = [];
  for (const k of POOL_KEYS) {
    if (log.events.some((e) => isNum(e[k]) && e.source === log.me && USE_KINDS.has(e.kind))) out.push(k);
  }
  return out;
}
const POOL_KEYS = ['rage', 'spark'];
const USE_KINDS = new Set(['press', 'skill_use', 'block_use']);

function statsOf(log) {
  // (Keyed by what the file wrote: a kind "__proto__" is counted, not lost.)
  const byKind = Object.create(null);
  let damageEvents = 0;
  let myDamageEvents = 0;
  const skills = new Map();
  for (const e of log.events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.kind !== 'damage') continue;
    damageEvents++;
    if (!e[USABLE] || e.source !== log.me) continue;
    myDamageEvents++;
    const s = skills.get(e.skill) ?? { skill: e.skill, hits: 0, total: 0, crits: 0 };
    s.hits++; s.total += e.amount; if (e.critical === true) s.crits++;
    skills.set(e.skill, s);
  }
  const summary = log.summary;
  // A summary alone: its own per-skill totals, under their ORIGIN ids.
  if (!log.perEvent) {
    const mine = (summary.players ?? []).find((p) => isObj(p) && (p.isMe === true || (log.me && String(p.uid) === log.me)));
    for (const s of Array.isArray(mine?.skills) ? mine.skills : []) {
      if (!isObj(s) || !nonEmpty(s.id)) continue;
      skills.set(s.id, { skill: s.id, hits: isNum(s.hits) ? s.hits : 0, total: isNum(s.damage) ? s.damage : 0, crits: isNum(s.crits) ? s.crits : 0 });
    }
  }
  const encounter = encounterOf(log);
  const span = log.events.length ? log.events[log.events.length - 1].time - Math.max(0, log.events[0].time) : null;
  const duration = isNum(log.header?.duration) ? log.header.duration : isNum(summary?.duration) ? summary.duration : span;
  // Solo: the party size the file states, else the players a summary lists.
  // A timeline alone cannot say: Wink writes no party size into it.
  let solo = null;
  if (encounter.partySize !== null) solo = encounter.partySize === 1;
  else if (Array.isArray(summary?.players) && summary.players.length > 1) solo = false;
  else if (Array.isArray(summary?.players) && summary.players.length === 1) solo = true;
  const isPlayer = playerish(log);
  const seen = new Set();
  const players = [];
  const push = (u) => {
    if (!nonEmpty(u) || seen.has(u) || !isPlayer(u)) return;
    seen.add(u);
    players.push({ uid: u, isMe: u === log.me, named: log.units.names.has(u) });
  };
  if (log.me) push(log.me);
  for (const u of log.units.listed.keys()) push(u);
  for (const e of [...log.initial, ...log.events]) { push(e.source); push(e.target); }
  return {
    events: log.events.length,
    damageEvents,
    myDamageEvents,
    byKind,
    duration,
    startedAt: log.startedAt,
    startedAtEstimated: log.startedAtEstimated,
    me: log.me,
    handle: log.handle,
    players,
    solo,
    perEvent: log.perEvent,
    encounter,
    gameVersion: gameVersionOf(log),
    build: buildOf(log),
    // The class and level the log names its character, as it writes them.
    className: classOut(log),
    level: levelOut(log),
    // Whether it records the character's presses (and whether it said so),
    // and the pools it carries a value of: what verify can replay from it.
    ...(log.perEvent ? (() => { const p = pressesOf(log); return { presses: p.presses, pressesDeclared: p.declared, pools: poolsOf(log) }; })()
      : { presses: false, pressesDeclared: false, pools: [] }),
    skills: [...skills.values()].sort((a, b) => b.total - a.total || (a.skill < b.skill ? -1 : 1)),
  };
}

// What a Wink file cannot carry, said once per log in the reader's words.
function limitsNotes(log) {
  if (log.dialect === LOG_FORMAT) {
    if (log.stats.solo === false) {
      log.notes.push(`a party fight (${log.stats.encounter.partySize ?? 'several'} players): unless the exporter wrote every player's events, `
        + 'what the others put on the target is not in it, and the per-hit lines are evidence of totals, not of formulas');
    }
    // (Not for a training dummy: the Dummy is logged at level 1, its own
    // row's, so the question does not arise.)
    if (log.stats.encounter.targetDummy !== true
      && (log.stats.encounter.difficulty === -1 || (log.stats.encounter.difficulty === null && log.stats.encounter.bossKind))) {
      log.notes.push('the difficulty is unknown: a target at MaxLevel stood in Veteran or Heroic, and --price-as <unit>@heroic or @veteran says which');
    }
    return;
  }
  const n = log.notes;
  n.push('Wink keeps an event only when the character is its source or its target: a party member\'s hits and the debuffs they '
    + 'put on the target are not in the file');
  if (log.stats.solo === false) {
    n.push(`this was a party fight (${log.stats.encounter.partySize ?? 'several'} players), so the per-hit lines are evidence of totals, `
      + 'not of formulas: what the others did to the target raised the live damage and is not in the file');
  } else if (log.stats.solo === null) {
    n.push('whether the fight was solo cannot be told from a timeline alone (Wink writes the party size into the summary)');
  }
  if (log.perEvent) {
    n.push('a skill_use is a skill STARTED on the client, automatic and child starts included, and is read as a press with via=start; '
      + 'a block is a block_use, a dash a dodge_use');
    n.push('Wink writes no target level and no affinity: the target stands at its row\'s level, and a skill logged under two affinities '
      + 'is compared as one');
  }
  n.push('times are what this client observed (clock "client-observed"), not the server\'s');
  if (log.stats.encounter.targetDummy !== true && (log.stats.encounter.difficulty === -1 || log.stats.encounter.difficulty === null)) {
    n.push('the difficulty is unknown: a target at MaxLevel stood in Veteran or Heroic, and --price-as <unit>@heroic or @veteran says which');
  }
}

// Beside its summary, a timeline's damage can be folded the way the summary
// files it (under each hit's origin) and the two compared. A gap is hits the
// timeline could not place, or the summary's own filing; it is said, never
// corrected.
function totalCheck(log) {
  const s = log.summary;
  const mine = (s.players ?? []).find((p) => isObj(p) && (p.isMe === true || String(p.uid) === log.me));
  if (!mine || !Array.isArray(mine.skills)) return;
  const folded = new Map();
  for (const e of log.events) {
    if (e.kind !== 'damage' || !e[USABLE] || e.source !== log.me) continue;
    const k = nonEmpty(e.origin) ? e.origin : e.skill;
    folded.set(k, (folded.get(k) ?? 0) + e.amount);
  }
  const off = [];
  let agree = 0;
  for (const sk of mine.skills) {
    if (!isObj(sk) || !nonEmpty(sk.id) || !isNum(sk.damage)) continue;
    const got = folded.get(sk.id) ?? 0;
    if (Math.abs(got - sk.damage) <= Math.max(1, sk.damage * 0.001)) agree++;
    else off.push(`${sk.id} (timeline ${got.toFixed(1)}, summary ${sk.damage.toFixed(1)})`);
  }
  const total = agree + off.length;
  if (!total) return;
  log.notes.push(off.length
    ? `the timeline's damage folded by origin agrees with the summary on ${agree} of ${total} skills; it differs on `
      + `${off.slice(0, 4).join(', ')}${off.length > 4 ? ` and ${off.length - 4} more` : ''}`
    : `the timeline's damage folded by origin agrees with the summary on all ${total} skills`);
}

// The build a log names, in the form the synthetic session row carries it:
// the boot hash when the exporter wrote one (the only identity captureEra can
// hold against the install), else the Steam build, else the game's version
// string, else `unknown`. Never a date. The value is kept as written but for
// what the session row's `k=v;k=v` bag cannot carry: a ';' would end it and a
// line break or another control character would end the row, so each run of
// those becomes one space (capture.mjs parseExtra splits a pair on its FIRST
// '=', so an '=' inside the value is carried as is). `1.2.3 (25959898)` stays
// `1.2.3 (25959898)`: a version that never existed would be worse than none.
function buildOf(log) {
  const src = isObj(log.header?.source) ? log.header.source : {};
  const v = [src.bootSha256, src.steamBuild, src.gameVersion, log.summary?.gameVersion]
    .map((x) => (isNum(x) ? String(x) : x)).find((x) => nonEmpty(x) && x.trim() !== '');
  if (!v) return 'unknown';
  const clean = v.replace(/[;\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return (/^[0-9a-f]{64}$/i.test(clean) ? clean.toLowerCase() : clean) || 'unknown';
}

// --- rows for the capture readers ------------------------------------------------
// The mapping docs/COMBAT-LOG.md calls B2: what each event becomes in
// capture.mjs's row contract {line, ts, event, source, target, skill, amount,
// crit, stacks, maxStacks, extra}. Rows are sorted by (time, seq), the
// statuses standing at the start first, and the first row is the synthetic
// session row.
//
// WHO. The character is its handle. A uid some row gave a unit kind that is
// no player's class is `<kind>#<uid>`, the form the probe writes a creature
// in, so instance following, openingState's wearers and the --target filter
// all read it. A player - named and kindless, or of a class's kind - is a
// player handle with no '#', as the probe writes one (capture.mjs
// isPlayerHandle): its name, or `player<uid>` when the log names none, both
// as a source and as the target of a hit. Anything else is `?#<uid>`, which
// names nothing. `heroKinds` are the classes' unit ids when the caller has
// the engine; without them the classes the log itself shows count.
//
// WHAT THE CHARACTER DID. Its press - a `press` row, or a skill_use or
// block_use of its own that no other skill started - is a press row; every
// skill it STARTS (a child start included) is also a `go_state` row to Skill
// on the handle, as the probe writes one when the character's state becomes a
// skill: verify's --replay opens the fight where the first one stands. A
// `rage` or `spark` value on the row rides both, as the probe's do, for
// capture.mjs poolAt.
export function captureRows(log, { heroKinds = null } = {}) {
  if (!log?.perEvent) throw new CombatLogError(`${log?.name ?? 'the log'}: ${SUMMARY_ONLY}`);
  const T0 = log.startedAt;
  const me = log.me;
  const H = log.handle;
  const { kinds, names } = log.units;
  const hero = heroKindsOf(log, heroKinds);
  const firstKind = (u) => { const s = kinds.get(u); return s ? s.values().next().value : null; };
  const nameOf = (u) => { const n = names.get(u); return nonEmpty(n) ? n.replace(/#/g, '_').trim() : ''; };
  // A player's handle, or null for a uid that is no player.
  const playerHandle = (u, kind) => {
    const k = nonEmpty(kind) ? kind : firstKind(u);
    if (k && !hero.has(k)) return null;
    const n = nameOf(u);
    if (n) return n;
    return k ? `player${u}` : null;
  };
  const who = (u, kind) => {
    if (!nonEmpty(u)) return nonEmpty(kind) ? `${kind}#-1` : '?#-1';
    if (u === me) return H;
    const p = playerHandle(u, kind);
    if (p) return p;
    const k = nonEmpty(kind) ? kind : firstKind(u);
    return k ? `${k}#${u}` : `?#${u}`;
  };
  // The target of a hit: a player's handle, else the row's own targetKind
  // (a row without one names no unit, whatever other rows said of the uid).
  const hitTarget = (e) => {
    if (e.target === me) return H;
    if (nonEmpty(e.target)) {
      const p = playerHandle(e.target, e.targetKind);
      if (p) return p;
    }
    return `${nonEmpty(e.targetKind) ? e.targetKind : '?'}#${nonEmpty(e.target) ? e.target : -1}`;
  };
  const tsOf = (t) => Math.round(T0 + t * 1000);
  const val = (v) => String(v).replace(/[;\r\n]/g, ' ');
  const kv = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v)))
    .map(([k, v]) => `${k}=${val(v)}`).join(';');
  const pools = (e) => POOL_KEYS.map((k) => [k, isNum(e[k]) ? e[k] : null]);
  const pressTarget = (e) => {
    if (nonEmpty(e.target) && e.target !== me) return `T:${nonEmpty(e.targetKind) ? e.targetKind : firstKind(e.target) ?? '?'}#${e.target}`;
    return null;
  };
  // A use's resolved target rides on the skill_context row that names it.
  const context = new Map();
  for (const e of log.events) if (e.kind === 'skill_context' && isNum(e.related) && !context.has(e.related)) context.set(e.related, e);

  const base = (e, event, source, target, extra = '', amount = null, crit = false) => ({
    line: e[LINE] ?? 1,
    ts: tsOf(e.time),
    event,
    source,
    target,
    skill: isStr(e.skill) ? e.skill : '',
    amount,
    crit,
    stacks: isNum(e.stacks) ? e.stacks : null,
    maxStacks: null,
    extra,
  });
  const dur = (v) => (isNum(v) && v > 0 ? v : null);
  // The character's state going to a skill, as the probe writes it: no
  // source, the handle as target.
  const toSkill = (e) => base(e, 'go_state', '', H, kv([['state', 'Skill'], ...pools(e)]));

  const one = (e) => {
    const src = who(e.source, e.sourceKind);
    switch (e.kind) {
      case 'damage': {
        if (!e[USABLE]) return null;
        return base(e, 'inflict', src, hitTarget(e), kv([
          ['origin', e.origin], ['dtype', e.damageType], ['outcome', e.outcome],
          ['affinity', e.affinity], ['tlvl', e.targetLevel], ['thp', e.targetHp],
          ['tmax', e.targetMaxHp], ['tarm', e.targetArmor], ['tmarm', e.targetMagicArmor],
        ]), e.amount, e.critical === true);
      }
      case 'avoided':
        return base(e, 'avoided', src, who(e.target, e.targetKind), kv([['origin', e.origin], ['outcome', e.outcome]]), 0, false);
      case 'press':
        return base(e, 'press', src, pressTarget(e) ?? 'T:', kv([['kind', e.skill], ['via', 'input'], ...pools(e)]));
      case 'skill_use':
      case 'block_use': {
        const mine = e.source === me;
        const own = mine && (!nonEmpty(e.origin) || e.origin === e.skill);
        if (!own) {
          const use = base(e, e.kind, src, who(e.target, e.targetKind), kv([['origin', e.origin]]));
          return mine ? [use, toSkill(e)] : use;
        }
        const ctx = isNum(e.seq) ? context.get(e.seq) : null;
        const target = pressTarget(e) ?? (ctx ? pressTarget(ctx) : null) ?? 'T:';
        return [
          base(e, 'press', src, target, kv([['kind', e.skill], ['via', 'start'], ['use', e.kind === 'block_use' ? 'block' : null], ...pools(e)])),
          toSkill(e),
        ];
      }
      case 'skill_context':
        return null;   // folded into the press it resolved
      case 'dodge_use':
        return base(e, 'dodge', src, nonEmpty(e.target) ? who(e.target, e.targetKind) : '');
      case 'skill_end':
        return base(e, 'skill_end', src, nonEmpty(e.target) ? who(e.target, e.targetKind) : '', kv([['reason', e.outcome]]));
      case 'status_applied':
      case 'status_present':
        return base(e, 'status_on', src, who(e.target, e.targetKind), kv([['ok', 1], ['dur', dur(e.duration)]]));
      case 'status_refreshed':
      case 'status_duration':
        return base(e, 'status_refresh', src, who(e.target, e.targetKind), kv([['refresh_dur', dur(e.duration)]]));
      case 'status_stacks':
        return base(e, 'status_stacks', src, who(e.target, e.targetKind));
      case 'status_removed':
        return base(e, 'status_off', src, who(e.target, e.targetKind), kv([['reason', e.outcome]]));
      default:
        return base(e, e.kind, src, nonEmpty(e.target) ? who(e.target, e.targetKind) : '', kv([['outcome', e.outcome]]),
          isNum(e.amount) ? e.amount : null, e.critical === true);
    }
  };

  const all = [
    ...log.initial.map((e) => ({ e, init: 0 })),
    ...log.events.map((e) => ({ e, init: 1 })),
  ];
  const seqOf = (e) => (isNum(e.seq) ? e.seq : Infinity);
  all.sort((a, b) => a.e.time - b.e.time || a.init - b.init || seqOf(a.e) - seqOf(b.e) || a.e[ORDER] - b.e[ORDER]);
  const rows = [];
  for (const { e } of all) {
    const r = one(e);
    if (Array.isArray(r)) rows.push(...r);
    else if (r) rows.push(r);
  }
  const presses = pressesOf(log).presses ? 1 : 0;
  rows.unshift({
    line: 1,
    ts: rows.length ? rows[0].ts : Math.round(T0),
    event: 'session',
    source: '',
    target: '',
    skill: log.dialect,
    amount: null,
    crit: false,
    stacks: null,
    maxStacks: null,
    extra: `probe=${log.dialect};boot=unreadable;build=${buildOf(log)};presses=${presses}`,
  });
  return rows;
}

// --- writing farever-combat-log v1 -------------------------------------------------
// The header and event fields this repo documents, in a fixed order. The
// submission's copy is REBUILT from these and nothing else: a key that is not
// here does not reach a submission, whatever a future exporter adds. The
// display names Wink writes beside the ids (sourceName, targetName,
// skillName, itemName) are not among them: the ids carry the meaning, and a
// name is what identifies a person.
//
// A field's type says what passes: 'uid' (renumbered), 'number', 'boolean',
// 'string', 'id' (a string or a number), 'kind' (a unit id - what the
// caller's isUnit accepts, any string without one) and 'dtype' (one of the
// four damage types).
const EVENT_FIELDS = {
  seq: 'number', time: 'number', kind: 'string', source: 'uid', target: 'uid', skill: 'string', origin: 'string',
  instance: 'uid', amount: 'number', critical: 'boolean', lethal: 'boolean', hits: 'number', damageType: 'dtype',
  outcome: 'string', stacks: 'number', duration: 'number', statusType: 'string', related: 'number', estimated: 'boolean',
  targetKind: 'kind', before: 'number', after: 'number', hiddenStatus: 'boolean', useDuration: 'number', item: 'string',
  sourceKind: 'kind', affinity: 'string', targetLevel: 'number', targetHp: 'number', targetMaxHp: 'number',
  targetArmor: 'number', targetMagicArmor: 'number', blocked: 'number', overkill: 'number', absorbed: 'number',
  summoned: 'boolean', isBaseAttack: 'boolean', stepId: 'id', rage: 'number', spark: 'number',
};
const DAMAGE_TYPES = new Set(['physical', 'magical', 'raw', 'unclassified']);
// What an exporter's name and version may look like in the copy: one token,
// no blanks and no quotes, so no sentence rides them.
const EXPORTER_RE = /^[A-Za-z0-9][A-Za-z0-9._+()-]{0,59}$/;
// A class as a log writes it ('Warrior', Wink's 'warrior'): one word.
const CLASS_WORD_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
// A Wink summary's category ('boss', 'dungeon'...): lower-case words.
const CATEGORY_RE = /^(?=.{1,40}$)[a-z0-9]+(?:[-_][a-z0-9]+){0,5}$/;

function rebuild(src, spec, U, isKind = null) {
  const out = {};
  for (const [k, type] of Object.entries(spec)) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (type === 'uid') { if (isStr(v)) out[k] = U(v); else if (isNum(v)) out[k] = U(String(v)); continue; }
    if (type === 'id') { if (isStr(v) || isNum(v)) out[k] = v; continue; }
    if (type === 'kind') { if (nonEmpty(v) && (typeof isKind !== 'function' || isKind(v))) out[k] = v; continue; }
    if (type === 'dtype') { if (isStr(v) && DAMAGE_TYPES.has(v)) out[k] = v; continue; }
    if (type === 'number' ? isNum(v) : typeof v === type) out[k] = v;
  }
  return out;
}

// One of OUTCOMES, in its own spelling, or null.
function outcomeWord(v) {
  return isStr(v) ? OUTCOMES.find((o) => o.toLowerCase() === v.trim().toLowerCase()) ?? null : null;
}

// The encounter as the copy writes it: every fact held to its shape - the
// boss a unit of the game (Wink's "Boss" above), the activity a game id, the
// outcome one of Wink's two - and left out when it is not, or when a name
// rides inside it (`clean`).
function encounterOut(log, { isUnit = null, clean = () => true } = {}) {
  const e = encounterOf(log);
  const out = {};
  const boss = bossKnown(e.bossKind, isUnit);
  if (boss !== null && GAME_ID_RE.test(boss)) out.bossKind = boss;
  if (e.difficulty !== null) out.difficulty = e.difficulty;
  if (e.activityId !== null && GAME_ID_RE.test(e.activityId) && clean(e.activityId)) out.activityId = e.activityId;
  if (e.targetDummy !== null) out.targetDummy = e.targetDummy;
  if (e.partySize !== null) out.partySize = e.partySize;
  const outcome = outcomeWord(e.outcome);
  if (outcome) out.outcome = outcome;
  return out;
}

function classOut(log) {
  const c = log.header?.character?.class ?? log.summary?.meClass;
  return nonEmpty(c) && /^[A-Za-z]+$/.test(c) ? c : null;
}

function levelOut(log) {
  const l = log.header?.character?.level;
  return isNum(l) && Number.isInteger(l) && l >= 1 ? l : null;
}

// The v1 header of the submission's copy, from what the reader holds: every
// field rebuilt from its allowlist and held to a shape (EXPORTER_RE,
// GAME_VERSION_RE, CLOCKS, the encounter's), the uids renumbered (`U`), the
// character named as asked, a fact a name rides inside left out (`clean`),
// and only a duration the file (or its summary) DECLARED written - the span
// of the rows is the reader's measurement, not the file's statement. A log
// that records its character's presses (pressesOf) says so in the copy, so
// that the maintainer's verify reads it as the original reads.
function headerOut(log, { U, characterName, isUnit = null, clean = () => true, eventOut }) {
  const h = log.header ?? {};
  const srcIn = isObj(h.source) ? h.source : {};
  const fact = (v, re) => (nonEmpty(v) && re.test(v) && clean(v) ? v : null);
  const source = {};
  const exporter = fact(srcIn.exporter, EXPORTER_RE) ?? (log.dialect !== LOG_FORMAT ? 'wink-dps-meter' : null);
  if (exporter) source.exporter = exporter;
  const exporterVersion = fact(srcIn.exporterVersion, EXPORTER_RE);
  if (exporterVersion) source.exporterVersion = exporterVersion;
  const gameVersion = fact(gameVersionOf(log), GAME_VERSION_RE);
  if (gameVersion) source.gameVersion = gameVersion;
  const steam = isNum(srcIn.steamBuild) ? String(srcIn.steamBuild) : srcIn.steamBuild;
  if (isStr(steam) && /^\d{1,12}$/.test(steam)) source.steamBuild = steam;
  if (isStr(srcIn.bootSha256) && /^[0-9a-f]{64}$/i.test(srcIn.bootSha256)) source.bootSha256 = srcIn.bootSha256.toLowerCase();
  if (pressesOf(log).declared) source.recordsPresses = true;
  const character = {};
  if (characterName !== null) character.name = characterName;
  const cls = classOut(log);
  if (cls && clean(cls)) character.class = cls;
  const level = levelOut(log);
  if (level !== null) character.level = level;
  const out = { format: LOG_FORMAT, version: LOG_VERSION };
  if (Object.keys(source).length) out.source = source;
  out.startedAt = log.startedAt;
  if (log.startedAtEstimated) out.startedAtEstimated = true;
  // A v1 header that names no clock names none in the copy; a Wink timeline's
  // is always the client's.
  const clock = nonEmpty(h.clock) ? (CLOCKS.includes(h.clock) ? h.clock : null) : log.dialect === LOG_FORMAT ? null : 'client-observed';
  if (clock) out.clock = clock;
  out.me = U(log.me);
  if (Object.keys(character).length) out.character = character;
  const enc = encounterOut(log, { isUnit, clean });
  if (Object.keys(enc).length) out.encounter = enc;
  out.initial = log.initial.map(eventOut);
  const duration = isNum(h.duration) ? h.duration : isNum(log.summary?.duration) ? log.summary.duration : null;
  if (duration !== null) out.duration = duration;
  if (isNum(h.leadIn)) out.leadIn = h.leadIn;
  out.count = log.events.length;
  return out;
}

// --- names, found ------------------------------------------------------------------
// A name is looked for as the same letters whatever the case, the Unicode form
// (NFKC: a full-width or composed spelling), a format character between its
// letters (a zero-width space) or a Cyrillic or Greek letter drawn like a
// Latin one: "KESTRELA", "Kеstrela" with a Cyrillic e and "Kestrela's flask"
// all hold "Kestrela". The lookalikes are the common ones, not every
// confusable Unicode knows.
const LOOKALIKE = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h',
  'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'u', 'ν': 'n', 'ο': 'o', 'ρ': 'p', 'τ': 't',
  'υ': 'u', 'χ': 'x', 'ζ': 'z',
};
const FORMAT_CHAR = /\p{Cf}/u;
// A text folded for comparison, with the index in `src` (its NFKC form) that
// each folded character came from.
function fold(s) {
  const src = String(s).normalize('NFKC');
  let text = '';
  const at = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (FORMAT_CHAR.test(ch)) continue;
    const low = ch.toLowerCase();
    text += low.length === 1 ? (LOOKALIKE[low] ?? low) : ch;
    at.push(i);
  }
  return { text, at, src };
}

/**
 * A search for names INSIDE text, folded (above): `first(s)` is the first
 * name found in `s` or null, `has(s)` whether one is, `cut(s, repl)` is `s`
 * with every one replaced. Names shorter than `min` letters are left to a
 * whole-value comparison - inside text, two letters are found everywhere.
 */
export function nameFinder(names, { min = 3 } = {}) {
  const list = [...new Set([...(names ?? [])].filter(isStr))]
    .map((name) => ({ name, f: fold(name).text.trim() }))
    .filter((x) => x.f.length >= min)
    .sort((a, b) => b.f.length - a.f.length);
  const first = (s) => {
    if (!isStr(s) || !list.length) return null;
    const { text } = fold(s);
    return list.find((x) => text.includes(x.f))?.name ?? null;
  };
  return {
    first,
    has: (s) => first(s) !== null,
    cut(s, repl) {
      if (!isStr(s) || !list.length) return s;
      const { text, at, src } = fold(s);
      const spans = [];
      for (const x of list) {
        for (let i = text.indexOf(x.f); i >= 0; i = text.indexOf(x.f, i + x.f.length)) spans.push([at[i], at[i + x.f.length - 1] + 1]);
      }
      if (!spans.length) return s;
      spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      let out = '';
      let pos = 0;
      for (const [a, b] of spans) {
        if (b <= pos) continue;
        out += src.slice(pos, Math.max(a, pos)) + (a >= pos ? repl : '');
        pos = b;
      }
      return out + src.slice(pos);
    },
  };
}

/**
 * The first key or string value of `root` that IS one of `names` (a Set),
 * as { name, where } - `where` the path to it ("header.character.name",
 * "events[3].skill", "gear (a key)") - or null. `allowed(where, s)` names the
 * one place a kept name may stand. The whole-value half of the name check
 * every file of a submission goes through (nameFinder is the other).
 */
export function findName(root, names, allowed = () => false) {
  let found = null;
  const hit = (s, where) => { if (!found && names.has(s) && !allowed(where, s)) found = { name: s, where }; };
  const walk = (v, where) => {
    if (found) return;
    if (isStr(v)) { hit(v, where); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
    if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        const at = where ? `${where}.${k}` : k;
        hit(k, `${at} (a key)`);
        walk(x, at);
      }
    }
  };
  walk(root, '');
  return found;
}

// --- the submission's copy ----------------------------------------------------------
// ALLOWLIST, FAIL CLOSED. The header (its initial[] included), every event and
// the summary are rebuilt from the fields above; a key not on the list never
// reaches the output. Names are dropped - sourceName, targetName, skillName,
// itemName, the summary's meName and players' names, the encounter's name -
// and the submitter's becomes "Submitter" unless `keepName`. accountId and
// characterId go. EVERY uid (the character, the targets, the skill and status
// objects) is remapped to a decimal string, the character to "1" and the rest
// "2", "3"... in order of first appearance, so the file still reads as rows
// (the capture readers want digits after '#') and one target stays one target.
// Another PLAYER - a uid the original names or gives a class's kind, as
// captureRows reads players - is named "Player <its new uid>" where its
// name stood, so the copy still reads it as a player (a party member's hits
// on the target are what verify warns about) and names nobody.
//
// With `isUnit` (the game's unit ids - the submission passes them), a unit
// kind that is no unit of the game is not written: an exporter that put a
// player's name where the unit id goes (sourceKind "Kestrela") would carry the
// name in it. The header's and the summary's text facts are held to shapes,
// and one with a name inside it (nameFinder) is left out.
//
// Then two checks, and either one refuses the whole log:
//   * every display name the input carries (below) is searched for among
//     the output's string values and keys, and one found is a refusal:
//     either the rebuild missed a channel, or a name is also a value the log
//     carries - and a copy holding it is not sent, whichever it is;
//   * the output is read back, and the submitter's damage-event count and
//     per-skill totals must equal the original's: an anonymiser that lost a
//     row would hand the maintainer a different fight.
//
// Returns { text (null for a summary alone), summaryText (null without a
// summary), namesRemoved, playerNames, handle }. `playerNames` is what the
// caller searches the rest of a bundle for (the sheet, the manifest), and
// `namesRemoved` counts them, the kept name aside. `heroKinds` are the
// classes' unit ids (the engine's); see below for what they change.
// `isUnit` is the submission lane's: see Wink's "Boss" at the top.
// `otherNames` are names the log does not carry and the copy must not either
// - the sheet's character, packed beside it: a text fact with one inside is
// left out of the copy as one with the log's own names is.
export function anonymizeLog(log, { keepName = false, heroKinds = null, isUnit = null, otherNames = [] } = {}) {
  if (!log || (!log.perEvent && !log.summary)) throw new CombatLogError('nothing to anonymise: no events and no summary');
  const me = log.me;
  const isKind = typeof isUnit === 'function' ? isUnit : null;
  const map = new Map();
  if (me) map.set(me, '1');
  let next = map.size + 1;
  const U = (u) => {
    if (u === undefined || u === null) return u;
    const k = String(u);
    if (k === '') return '';
    if (!map.has(k)) map.set(k, String(next++));
    return map.get(k);
  };
  // First appearance decides the number: walk everything once in the order
  // it will be written.
  for (const e of [...log.initial, ...log.events]) { U(e.source); U(e.target); U(e.instance); }
  const players = Array.isArray(log.summary?.players) ? log.summary.players : [];
  for (const p of players) if (isObj(p) && p.uid !== undefined && p.uid !== null) U(String(p.uid));
  for (const k of Object.keys(isObj(log.summary?.healingReceived) ? log.summary.healingReceived : {})) U(k);

  // The names. FAIL CLOSED: every display name the input carries - the
  // character's, a summary's meName and players' names, and the sourceName
  // and targetName of every event, whoever's uid it is - is searched for in
  // the output, but for the words that are no name here: a unit kind the
  // log itself carries (Wink writes a unit's kind where it has no display
  // name, and the Dummy's display name is its kind), the encounter's boss,
  // and Wink's own "Unknown". With `isUnit`, only a kind that IS a unit of
  // the game: a name written where a kind goes is still a name. A creature's
  // display name has no business in an id field either, so searching for it
  // costs a refusal on a true collision and nothing else.
  //
  // Which of them are a PLAYER's - what `playerNames` hands the caller and
  // `namesRemoved` counts - is playerish's question, and it needs the
  // classes' unit ids to answer it: without `heroKinds` a party member of
  // another class (a Rogue the character buffed, targetKind "Rogue") looks
  // like a creature. So without them every name counts as a player's.
  const exempt = (k) => !isKind || isKind(k);
  const notAName = new Set(['Unknown']);
  for (const ks of log.units.kinds.values()) for (const k of ks) if (exempt(k)) notAName.add(k);
  for (const b of [encounterOf(log).bossKind, log.summary?.bossKind]) if (nonEmpty(b) && exempt(b)) notAName.add(b);
  const isPlayer = Array.isArray(heroKinds) && heroKinds.length ? playerish(log, heroKinds, isUnit) : () => true;
  const names = new Set();     // searched for in the output
  const people = new Set();    // the ones that are, or could be, a player's
  const addName = (n, player) => {
    if (!nonEmpty(n) || !n.trim() || notAName.has(n)) return;
    names.add(n);
    if (player) people.add(n);
  };
  const own = [log.header?.character?.name, log.summary?.meName,
    players.find((p) => isObj(p) && (p.isMe === true || String(p.uid) === me))?.name,
    me ? log.units.names.get(me) : null].find(nonEmpty) ?? null;
  addName(log.header?.character?.name, true);
  addName(log.summary?.meName, true);
  for (const p of players) if (isObj(p)) addName(p.name, true);
  for (const e of [...log.initial, ...log.events]) {
    addName(e.sourceName, !nonEmpty(e.source) || isPlayer(e.source));
    addName(e.targetName, !nonEmpty(e.target) || isPlayer(e.target));
  }
  const kept = keepName && own ? own : null;
  const handle = kept ?? 'Submitter';
  const inside = nameFinder([...names, ...(Array.isArray(otherNames) ? otherNames.filter(nonEmpty) : [])]);
  const clean = (v) => !inside.has(v);

  // Another player, as the copy names it (see above): a uid the original
  // names or lists, unless a unit kind of the game says it is a creature, or
  // a uid of a class's kind.
  const hero = heroKindsOf(log, heroKinds);
  const aPlayer = (u) => {
    if (!nonEmpty(u) || u === me) return false;
    const ks = [...(log.units.kinds.get(u) ?? [])].filter(exempt);
    if (ks.length) return ks.every((k) => hero.has(k));
    return log.units.names.has(u) || log.units.listed.has(u);
  };
  const eventOut = (e) => {
    const r = rebuild(e, EVENT_FIELDS, U, isKind);
    if (aPlayer(e.source)) r.sourceName = `Player ${U(e.source)}`;
    if (aPlayer(e.target)) r.targetName = `Player ${U(e.target)}`;
    return r;
  };
  const refuse = (hit) => new CombatLogError(`refused: someone in this fight is, or could be, named "${hit.name}", and that is also a value the `
    + `anonymised copy carries (${hit.where}) - an id or a word the format writes, or a name an exporter put where an id belongs. `
    + 'A copy that holds a player\'s name is not sent, whatever field holds it: nothing was written');

  let text = null;
  if (log.perEvent) {
    const header = headerOut(log, { U, characterName: handle, isUnit, clean, eventOut });
    const events = log.events.map(eventOut);
    text = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
    const hit = findName({ header, events }, names, (where, s) => kept !== null && s === kept && where === 'header.character.name');
    if (hit) throw refuse(hit);
  }
  let summaryText = null;
  if (log.summary) {
    const summaryOut = summaryAllowlisted(log.summary, U, { isUnit, clean });
    summaryText = JSON.stringify(summaryOut, null, 1) + '\n';
    const hit = findName({ summary: summaryOut }, names);
    if (hit) throw refuse(hit);
  }

  // Read back, and hold the submitter's damage to what it was.
  const want = log.stats.skills;
  let got;
  if (text !== null) {
    const again = readCombatLog({ name: 'combat-log.jsonl', data: text });
    got = again.stats;
    if (got.myDamageEvents !== log.stats.myDamageEvents) {
      throw new CombatLogError(`the anonymised log holds ${got.myDamageEvents} of the character's damage events where the original held `
        + `${log.stats.myDamageEvents}: it was not written`);
    }
  } else {
    got = readCombatLog({ name: 'summary.json', data: summaryText }).stats;
  }
  const same = got.skills.length === want.length && want.every((w) => {
    const g = got.skills.find((x) => x.skill === w.skill);
    return g && g.hits === w.hits && g.crits === w.crits && Math.abs(g.total - w.total) <= 1e-6 * Math.max(1, Math.abs(w.total));
  });
  if (!same) throw new CombatLogError('the anonymised log\'s per-skill damage differs from the original\'s: it was not written');

  return {
    text,
    summaryText,
    namesRemoved: [...people].filter((n) => n !== kept).length,
    playerNames: [...people],
    handle,
  };
}

const BUCKET = { damage: 'number', percent: 'number', hits: 'number', crits: 'number', critical_damage: 'number' };
const HEAL = {
  output: 'number', hits: 'number', crits: 'number', casts: 'number', knownCritHits: 'number',
  estimatedHits: 'number', unknownOutputHits: 'number', unattributedHits: 'number',
};
function breakdownOut(b) {
  if (!isObj(b)) return null;
  const out = {};
  for (const t of ['physical', 'magical', 'raw', 'unclassified']) if (isObj(b[t])) out[t] = rebuild(b[t], BUCKET, (u) => u);
  if (Array.isArray(b.affinities)) {
    out.affinities = b.affinities.filter(isObj).map((a) => rebuild(a, { affinity: 'string', type: 'string', ...BUCKET }, (u) => u));
  }
  return out;
}
function healingOut(h) {
  if (!isObj(h)) return null;
  const out = rebuild(h, HEAL, (u) => u);
  if (isObj(h.distribution)) out.distribution = rebuild(h.distribution, { team: 'number', self: 'number', unattributed: 'number' }, (u) => u);
  if (Array.isArray(h.skills)) {
    out.skills = h.skills.filter(isObj).map((s) => {
      const r = { ...(nonEmpty(s.id) ? { id: s.id } : {}), ...rebuild(s, HEAL, (u) => u) };
      if (isObj(s.distribution)) r.distribution = rebuild(s.distribution, { team: 'number', self: 'number', unattributed: 'number' }, (u) => u);
      return r;
    });
  }
  return out;
}
// Wink's summary, rebuilt: no fight id or name, no meName, no player names,
// no account or character ids, no phase (Wink's free text); every uid
// remapped; its text facts held to the shapes the header's are, and left out
// with a name inside.
function summaryAllowlisted(s, U, { isUnit = null, clean = () => true } = {}) {
  const out = rebuild(s, {
    version: 'number', gameVersion: 'string', startedAt: 'number', duration: 'number', me: 'uid', meClass: 'string',
    category: 'string', categoryVersion: 'number', activityId: 'string', bossKind: 'string',
    gatesClosed: 'number', difficulty: 'id', partySize: 'number', outcome: 'string', targetDummy: 'boolean',
  }, U);
  const shape = (k, re) => { if (out[k] !== undefined && !(re.test(out[k]) && clean(out[k]))) delete out[k]; };
  shape('gameVersion', GAME_VERSION_RE);
  shape('meClass', CLASS_WORD_RE);
  shape('category', CATEGORY_RE);
  shape('activityId', GAME_ID_RE);
  if (out.bossKind !== undefined && (bossKnown(out.bossKind, isUnit) === null || !GAME_ID_RE.test(out.bossKind))) delete out.bossKind;   // not known (Wink's "Boss" above)
  if (out.outcome !== undefined) {
    const w = outcomeWord(out.outcome);
    if (w) out.outcome = w;
    else delete out.outcome;
  }
  if (out.difficulty !== undefined) {
    const d = difficultyOf(out.difficulty);
    if (isNum(d)) out.difficulty = d;
    else delete out.difficulty;
  }
  if (isObj(s.healingReceived)) {
    out.healingReceived = {};
    for (const [k, v] of Object.entries(s.healingReceived)) if (isNum(v)) out.healingReceived[U(k)] = v;
  }
  out.players = (Array.isArray(s.players) ? s.players : []).filter(isObj).map((p) => {
    const r = rebuild(p, {
      uid: 'uid', isMe: 'boolean', className: 'string', damage: 'number', heal: 'number', hits: 'number', crits: 'number', kills: 'number',
    }, U);
    if (r.className !== undefined && !(CLASS_WORD_RE.test(r.className) && clean(r.className))) delete r.className;
    r.skills = (Array.isArray(p.skills) ? p.skills : []).filter(isObj).map((sk) => {
      const o = rebuild(sk, { id: 'string', damage: 'number', hits: 'number', crits: 'number', kills: 'number', casts: 'number' }, U);
      const b = breakdownOut(sk.damageBreakdown);
      if (b) o.damageBreakdown = b;
      return o;
    });
    const b = breakdownOut(p.damageBreakdown);
    if (b) r.damageBreakdown = b;
    const h = healingOut(p.healing);
    if (h) r.healing = h;
    return r;
  });
  return out;
}

// --- what to say about a log ------------------------------------------------------
// Plain sentences for `bench import`, `bench submit` and the UI: which dialect,
// the span, the character (its class and level as the log names them, so an
// exporter author sees they were read), the counts, whether it records the
// character's presses, the character's damage by skill, the problems, the
// limits of the source, and whether it was solo. No colour, no layout beyond
// two spaces of indent under a heading line.
//
// Each item is {kind, text}: 'read' (what the file is), 'time', 'character',
// 'events', 'encounter', 'solo', 'build', 'presses', 'heading', 'skill' (an
// indented line under it), 'problem', 'note'; a 'problem' also carries
// `warn: true`. logReportLines is the same as plain text.
export function logReportItems(log, { top = 20 } = {}) {
  const items = [];
  // A problem is the line the reader is warned of, and carries `warn: true` -
  // the flag every front end colours or marks by (charsheet.mjs reportItems).
  const out = (kind, text) => items.push(kind === 'problem' ? { kind, text, warn: true } : { kind, text });
  const s = log.stats;
  const fmt = (n, d = 1) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const label = log.dialect === LOG_FORMAT
    ? `a ${LOG_FORMAT} v${log.header?.version ?? LOG_VERSION} log${nonEmpty(log.header?.source?.exporter)
      ? ` written by ${log.header.source.exporter}${nonEmpty(log.header.source.exporterVersion) ? ` ${log.header.source.exporterVersion}` : ''}` : ''}`
    : log.dialect === 'wink-timeline'
      ? `a Wink DPS Meter fight timeline${log.companionName ? `, with its summary ${log.companionName}` : ' (no summary beside it)'}`
      : 'a Wink DPS Meter fight summary (totals only, no per-event rows)';
  out('read', `${log.name}: ${label}.`);
  if (s.startedAt !== null) {
    out('time', `It starts ${stampOf(s.startedAt)} UTC`
      + `${log.startedAtEstimated ? ' (estimated)' : ''}${isNum(s.duration) ? ` and lasts ${fmt(s.duration)} s` : ''}.`);
  }
  const what = [s.className ? `a ${s.className}` : null, s.level !== null && s.level !== undefined ? `level ${s.level}` : null].filter(Boolean);
  out('character', `The character is uid ${s.me ?? '?'}, written as "${s.handle}" in the rows`
    + `${what.length ? `: ${what.join(', ')}` : ': the log names no class or level'}.`);
  if (log.perEvent) {
    const kinds = Object.entries(s.byKind).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n.toLocaleString('en-US')} ${k}`);
    out('events', `${plural(s.events, 'event')}${kinds.length ? ` (${kinds.join(', ')}${Object.keys(s.byKind).length > 6 ? ', ...' : ''})` : ''}; `
      + `${plural(s.damageEvents, 'damage event')}, ${s.myDamageEvents.toLocaleString('en-US')} of them the character's.`);
  }
  const enc = s.encounter;
  const diff = enc.difficulty === null || enc.difficulty === -1 ? 'difficulty unknown' : `${DIFFICULTIES[enc.difficulty]} difficulty`;
  out('encounter', `Encounter: ${enc.bossKind ?? 'no boss named'}${enc.targetDummy ? ' (a target dummy)' : ''}, ${diff}`
    + `${enc.partySize !== null ? `, party of ${enc.partySize}` : ''}${enc.outcome ? `, ${enc.outcome}` : ''}.`);
  out('solo', s.solo === true ? 'A solo fight: its per-hit rows are evidence a formula can be held to.'
    : s.solo === false ? 'A party fight: its rows are evidence of the character\'s totals, not of formulas.'
      : 'Whether the fight was solo is not in the file.');
  out('build', s.build === 'unknown' ? 'It names no build (no bootSha256, steamBuild or game version), so which build it describes cannot be told.'
    : `It names its build as ${s.build}.`);
  if (log.perEvent) {
    const pools = s.pools?.length ? `, and the character's ${s.pools.join(' and ')} on them` : '';
    out('presses', s.presses
      ? `It records the character's presses${s.pressesDeclared ? (log.dialect === LOG_FORMAT ? ' (source.recordsPresses)' : ' (every skill it starts)') : ''}${pools}.`
      : 'It records no press of the character, and does not say it records them (source.recordsPresses): bench verify plays '
        + 'the model\'s own rotation against it, and what the model does not press there is its choice, not evidence.');
  }
  if (s.skills.length) {
    out('heading', log.perEvent ? 'The character\'s damage by skill:' : 'The character\'s damage by skill, as the summary files it (under origin ids):');
    for (const k of s.skills.slice(0, top)) {
      out('skill', `  ${k.skill}  ${plural(k.hits, 'hit')}, ${fmt(k.total)} total, ${plural(k.crits, 'crit')}`);
    }
    if (s.skills.length > top) out('skill', `  ...and ${s.skills.length - top} more`);
  }
  for (const p of log.problems) out('problem', `Problem: ${p}.`);
  for (const n of log.notes) out('note', `Note: ${n}.`);
  return items;
}

/** logReportItems as plain text. */
export function logReportLines(log, opts = {}) {
  return logReportItems(log, opts).map((i) => i.text);
}
