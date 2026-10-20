// ---------------------------------------------------------------------------
// submission-public.mjs - the shapes and words a submission is held to, and
// what of one may be seen by anybody.
//
// A player who sends a fight to the project sends one zip with fixed entry
// names (ZIP_ENTRIES). Send puts it in the project's folder on pCloud, which
// only the maintainer reads, and makes nothing public. The manual route - the
// zip attached to the GitHub issue form by hand - is public, and the one
// thing the bench writes for it is the issue's title, built from the object
// this file builds - the "public manifest" - and from nothing else. The note
// the player typed, the importer's notes, file names, character names: none
// of it has a field here, so none of it can reach the title, whatever the
// bench does wrong elsewhere.
//
// The file is pure (no imports, no I/O). It is vocabulary - the shapes a
// manifest is held to, the words a fight is described in, the fixed entry
// set and a zip reader that inflates nothing - and it is read by the bench's
// modules (submit.mjs, combatlog.mjs), its command line and the maintainer's
// tools/inbox.mjs alike: one copy, so none of them can drift from another,
// and nothing behind it that reaches a disk or the network.
//
// THE API, as the bench uses it:
//
//   const pub = publicManifest(manifest, { zipSha256, zipBytes });
//   const problems = checkPublicManifest(pub);   // [] or phrases
//
//   issueTitle(pub)
//     the title the manual route's issue form is prefilled with: the class
//     and level, what was fought, and the id's first eight characters.
//   issueRows(pub) -> [[label, value]]
//     the public manifest as a short table, for whoever reads a bundle
//     (tools/inbox.mjs prints it for each fight in the project's folder).
//   readZipDirectory(bytes) -> [{ name, method, size, compressedSize }]
//     the zip's central directory, read without inflating anything - enough
//     to refuse a zip that is not a bundle before a byte of it is inflated.
//   zipEntryProblem(names)
//     the fixed entry set: manifest.json and sheet.json always, a log
//     (combat-log.jsonl, summary.json or both), note.txt when there is one.
//   CLASS_ID_RE
//     the shape sheet.class must have (a capitalised game id of at most 24
//     characters). The bench sends the unit id; the check holds the shape
//     only, so a class a patch adds is taken without a bench release.
//   WINK_NO_BOSS, OUTCOMES, DIFFICULTY_NAMES, CLOCKS, GAME_VERSION_RE
//     the words a fight is described in, for every module that reads them.
//
// `manifest` is the full manifest.json of the bundle. `zipSha256` and
// `zipBytes` describe the finished zip, which holds manifest.json and so
// cannot name its own hash: they are handed in beside it. `id` and the
// delete token a receipt carries (TOKEN_RE) are 128 random bits each, as 32
// lowercase hex characters, made ONCE per bundle (node:crypto
// randomBytes(16).toString('hex')).
//
// The public manifest, all of it:
//
//   { format: 'farever-bench-submission', version: 1,
//     id: <32 hex>, createdAt: 'YYYY-MM-DD',
//     bench:   { version: '1.2.3' },
//     install: { steamBuild: '<digits>' | null },
//     sheet:   { class: a capitalised game id (CLASS_ID_RE), level: 1..999 },
//     log:     { sourceDialect: 'wink-timeline' (lower-case words joined by -,
//                at most 40 characters),
//                events, damageEvents: whole numbers, perEvent: boolean,
//                duration: whole minutes, in seconds (a multiple of 60) | null,
//                startedAt: 'YYYY-MM-DD' | null,
//                solo: boolean | null,
//                encounter: { bossKind: <unit id, at most 40> | null, difficulty: -1..9 | null,
//                             outcome: 'Victory' | 'Defeat' | null,
//                             targetDummy: boolean | null, partySize: 1..99 | null } },
//     zip:     { sha256: <64 hex>, bytes: 22..MAX_ZIP_BYTES } }
//
// publicManifest reads each from the full manifest's field of the same name
// and place (manifest.createdAt, manifest.bench.version, manifest.log.
// encounter.bossKind ...), except zip, which is handed in beside it.
//
// Every field of the public manifest is always present; null means "not
// known", never "not sent". The class is held to CLASS_ID_RE's shape (one
// capitalised word), not to a list (see CLASS_ID_RE); the boss is a CastleDB
// unit id held to GAME_ID_RE, which also keeps it free of anything markdown
// could act on. Times are rounded to the UTC day and the duration to the
// whole minute: a start time to the millisecond next to a boss and a total -
// or the day, the boss, the difficulty, the party size and a length to the
// second, which on a quiet boss is one fight - is enough to find the same
// fight on a public ranking site (Wink uploads boss kills to one, with the
// start, the length and the whole party by name), and with it the other
// players in the group. The maintainer has the exact values in the zip.
//
// None of it is trusted for being checked. The values come from whatever
// program built the bundle - the bench, or anything that writes its format -
// and the checks only hold them to shapes and lengths. That bounds what a
// hostile bundle can put in a title or a table (a 40-character run of
// letters, digits and _ is the longest free text it gets), and whoever reads
// them still reads them as data.
// ---------------------------------------------------------------------------

export const SUBMISSION_FORMAT = 'farever-bench-submission';
export const SUBMISSION_VERSION = 1;

// The zip's entries, by their only allowed names. The bench never writes the
// user's own file names into a bundle: a modkit dump is named after the
// character.
export const ZIP_ENTRIES = Object.freeze(['manifest.json', 'sheet.json', 'combat-log.jsonl', 'summary.json', 'note.txt']);
const ZIP_REQUIRED = ['manifest.json', 'sheet.json'];
const ZIP_LOGS = ['combat-log.jsonl', 'summary.json'];

// 25 MB is also what GitHub takes as an issue attachment, so a zip Send takes
// always fits the manual issue form too.
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
// What one entry may declare uncompressed. The declaration can lie - the
// reader that later inflates it caps its output as well - but an honest
// bundle never comes near it, and a zip that announces a bomb is refused at
// the door for nothing.
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 16;

export const ID_RE = /^[0-9a-f]{32}$/;
// The delete token a receipt carries; the bundle's manifest holds its SHA-256.
export const TOKEN_RE = /^[0-9a-f]{32}$/;
// A CastleDB unit id. The longest on build 25959898 is 32 characters, so 40
// leaves room for a patch and very little for a sentence.
export const GAME_ID_RE = /^[A-Za-z0-9_]{1,40}$/;
// The class is printed in the issue's title, so its shape is narrow: one
// capitalised word of letters, digits and _, at most 24 characters - room for
// any unit id a patch may add (the class units are a handful of letters) and
// none for a sentence. A fixed list was tried and refused: a class added by a
// patch would have been turned away until a bench release, and the bar for
// this project is that a patch is absorbed without hand-written code. Which
// units the bench sends is the bench's business (it writes ent.Unit.kind,
// never the aptitude id); the check only holds the shape.
export const CLASS_ID_RE = /^[A-Z][A-Za-z0-9_]{0,23}$/;
// A bench version as package.json writes it (a pre-release tag allowed).
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,24})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STEAM_BUILD_RE = /^\d{1,12}$/;
// The log dialects are the bench's own names (farever-combat-log,
// wink-timeline, wink-summary today). Held to a shape rather than a list so
// that a dialect a bench release adds passes an older copy's checks too; at
// most 40 characters, so the shape cannot carry a paragraph.
const DIALECT_RE = /^(?=[a-z0-9-]{1,40}$)[a-z0-9]+(?:-[a-z0-9]+){0,5}$/;

// --- the words a fight is described in ------------------------------------------
// One copy for every module that reads or writes them: combatlog.mjs (the
// reader and the anonymised copy), submit.mjs (the manifest) and this file
// (the public manifest, its title and its table).
//
// What the Wink meter writes as the boss of a fight whose boss had no kind
// (CombatModel.hx:692: an empty kind becomes "Boss"). No unit has that id on
// build 25959898, so it is "not known" everywhere, as the meter's other
// blanks are.
export const WINK_NO_BOSS = 'Boss';
// The two outcomes the Wink meter records; anything else it writes as an
// empty string, which is "not known" here.
export const OUTCOMES = Object.freeze(['Victory', 'Defeat']);
// ActivityDifficulty, the game's own custom type in data.cdb: its cases are
// Normal, Veteran and Heroic on build 25959898, in that order, and the index
// is the value - which is what Wink writes, with -1 when it could not tell.
// The suite holds this list to the data. The public manifest carries the
// number; a case added by a patch prints as its number until it is named.
export const DIFFICULTY_NAMES = Object.freeze(['Normal', 'Veteran', 'Heroic']);
// The clocks docs/COMBAT-LOG.md names for a log's times.
export const CLOCKS = Object.freeze(['client-observed', 'server']);
// A game version as a log may state it: one token of at most 40 letters,
// digits and . _ + - ( ), with a digit in it. What Config.getVersion()
// returns has not been seen in a real file, so the shape keeps prose out (no
// blanks, no quotes) rather than guess a layout.
export const GAME_VERSION_RE = /^(?=[^\d]*\d)[0-9A-Za-z._+()-]{1,40}$/;

export class SubmissionError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'SubmissionError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// The public manifest
// ---------------------------------------------------------------------------

// 'YYYY-MM-DD' (UTC) of an epoch-ms number, an ISO string or a Date; null for
// anything else.
function utcDay(v) {
  let d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v);
  else if (typeof v === 'string' && v.trim()) d = new Date(DAY_RE.test(v.trim()) ? `${v.trim()}T00:00:00Z` : v.trim());
  if (!d || !Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const orNull = (v) => (v === undefined ? null : v);

/**
 * ActivityDifficulty as a number, from what a file writes for it: the index,
 * one of DIFFICULTY_NAMES in any case, or its digits as text. null when
 * nothing is written, undefined when what is written is none of those. Which
 * numbers are cases is the reader's to hold: a case a patch adds is a number
 * past the names. The one reading, for combatlog.mjs and publicManifest.
 */
export function difficultyIndex(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    const i = DIFFICULTY_NAMES.findIndex((n) => n.toLowerCase() === t.toLowerCase());
    if (i >= 0) return i;
    if (/^-?\d+$/.test(t)) return Number(t);
  }
  return undefined;
}

// The public manifest's: text that is no difficulty is not known; anything
// else unreadable is carried for checkPublicManifest to name.
function difficultyOf(v) {
  const d = difficultyIndex(v);
  if (d !== undefined) return d;
  return typeof v === 'string' ? null : v;
}

function outcomeOf(v) {
  if (typeof v !== 'string') return null;
  return OUTCOMES.find((o) => o.toLowerCase() === v.trim().toLowerCase()) ?? null;
}

/**
 * The public subset of a bundle's manifest.json: a NEW object built field by
 * field from the allowlist, so a key the manifest grows later stays private
 * until somebody adds it here on purpose. Values are carried as they are
 * except for these: the two times become UTC days and the duration whole
 * minutes (part of the privacy rule), and the Wink meter's ways of saying
 * "not known" become null - an outcome other than its two, a party size of
 * 0, and a boss of '' or 'Boss'. Nothing is validated here -
 * checkPublicManifest does that, so a manifest with a bad field gives a
 * subset that names it.
 */
export function publicManifest(manifest, { zipSha256 = null, zipBytes = null } = {}) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const log = m.log && typeof m.log === 'object' ? m.log : {};
  const enc = log.encounter && typeof log.encounter === 'object' ? log.encounter : {};
  const steam = m.install?.steamBuild;
  const party = enc.partySize;
  return {
    format: orNull(m.format),
    version: orNull(m.version),
    id: orNull(m.id),
    createdAt: utcDay(m.createdAt),
    bench: { version: orNull(m.bench?.version) },
    install: { steamBuild: typeof steam === 'number' && Number.isInteger(steam) ? String(steam) : orNull(steam) },
    sheet: { class: orNull(m.sheet?.class), level: orNull(m.sheet?.level) },
    log: {
      sourceDialect: orNull(log.sourceDialect),
      events: orNull(log.events),
      damageEvents: orNull(log.damageEvents),
      perEvent: orNull(log.perEvent),
      duration: typeof log.duration === 'number' && Number.isFinite(log.duration) ? Math.round(log.duration / 60) * 60 : orNull(log.duration),
      startedAt: utcDay(log.startedAt),
      solo: orNull(log.solo),
      encounter: {
        bossKind: enc.bossKind === '' || enc.bossKind === WINK_NO_BOSS ? null : orNull(enc.bossKind),
        difficulty: difficultyOf(enc.difficulty),
        outcome: outcomeOf(enc.outcome),
        targetDummy: orNull(enc.targetDummy),
        partySize: typeof party === 'number' && party <= 0 ? null : orNull(party),
      },
    },
    zip: { sha256: zipSha256, bytes: zipBytes },
  };
}

// The schema checkPublicManifest holds a public manifest to. A leaf is a
// function that answers null when the value is fine and a phrase when it is
// not; a nested object is a nested object, every key required.
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const leaf = {
  exact: (want) => (v) => (v === want ? null : `is not ${JSON.stringify(want)}`),
  str: (re, what) => (v) => (typeof v === 'string' && re.test(v) ? null : `is not ${what}`),
  int: (lo, hi) => (v) => (isInt(v) && v >= lo && v <= hi ? null : `is not a whole number from ${lo} to ${hi}`),
  num: (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? null : `is not a number from ${lo} to ${hi}`),
  bool: () => (v) => (typeof v === 'boolean' ? null : 'is not true or false'),
  day: () => (v) => (typeof v === 'string' && DAY_RE.test(v) && utcDay(v) === v ? null : 'is not a day written YYYY-MM-DD'),
  // A length rounded to the whole minute, carried in seconds.
  minutes: (hi) => (v) => (isInt(v) && v >= 0 && v <= hi && v % 60 === 0 ? null : `is not whole minutes as seconds (a multiple of 60) from 0 to ${hi}`),
  oneOf: (list) => (v) => (list.includes(v) ? null : `is not one of ${list.join(', ')}`),
  orNull: (f) => (v) => (v === null ? null : f(v)),
};
const GAME_ID = leaf.str(GAME_ID_RE, 'a game id (letters, digits and _, at most 40)');
const SCHEMA = {
  format: leaf.exact(SUBMISSION_FORMAT),
  version: leaf.exact(SUBMISSION_VERSION),
  id: leaf.str(ID_RE, '32 lowercase hex characters'),
  createdAt: leaf.day(),
  bench: { version: leaf.str(VERSION_RE, 'a version written like 1.2.3') },
  install: { steamBuild: leaf.orNull(leaf.str(STEAM_BUILD_RE, 'a Steam build number')) },
  sheet: { class: leaf.str(CLASS_ID_RE, 'a class id (one capitalised word of letters, digits and _, at most 24 characters)'), level: leaf.int(1, 999) },
  log: {
    sourceDialect: leaf.str(DIALECT_RE, 'a dialect name (lower case words joined by -, at most 40 characters)'),
    events: leaf.int(0, 2_000_000),
    damageEvents: leaf.int(0, 2_000_000),
    perEvent: leaf.bool(),
    duration: leaf.orNull(leaf.minutes(86_400)),
    startedAt: leaf.orNull(leaf.day()),
    solo: leaf.orNull(leaf.bool()),
    encounter: {
      bossKind: leaf.orNull(GAME_ID),
      difficulty: leaf.orNull(leaf.int(-1, 9)),
      outcome: leaf.orNull(leaf.oneOf(OUTCOMES)),
      targetDummy: leaf.orNull(leaf.bool()),
      partySize: leaf.orNull(leaf.int(1, 99)),
    },
  },
  zip: { sha256: leaf.str(SHA256_RE, '64 lowercase hex characters'), bytes: leaf.int(22, MAX_ZIP_BYTES) },
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function walk(schema, value, path, out) {
  if (!isPlain(value)) { out.push(`${path || 'the manifest'} is not an object`); return; }
  for (const k of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) out.push(`${path ? `${path}.` : ''}${k} is not a field of the public manifest`);
  }
  for (const [k, rule] of Object.entries(schema)) {
    const at = path ? `${path}.${k}` : k;
    if (!Object.prototype.hasOwnProperty.call(value, k)) { out.push(`${at} is missing`); continue; }
    if (typeof rule === 'function') {
      const why = rule(value[k]);
      if (why) out.push(`${at} ${why}`);
    } else {
      walk(rule, value[k], at, out);
    }
  }
}

/**
 * Every problem with a public manifest, as phrases naming the field ("log.
 * events is not a whole number from 0 to 2000000"); [] when it is acceptable.
 * Strict both ways: a key the schema does not name is a problem, and so is a
 * key it names that is missing.
 */
export function checkPublicManifest(obj) {
  const out = [];
  walk(SCHEMA, obj, '', out);
  if (!out.length && obj.log.damageEvents > obj.log.events) out.push('log.damageEvents is more than log.events');
  return out;
}

function refuse(lead, problems) {
  const shown = problems.slice(0, 6).join('; ');
  const more = problems.length > 6 ? ` (and ${problems.length - 6} more)` : '';
  return new SubmissionError(`${lead}: ${shown}${more}.`, problems);
}

// ---------------------------------------------------------------------------
// The title and the table
// ---------------------------------------------------------------------------

function checked(pub) {
  const problems = checkPublicManifest(pub);
  if (problems.length) throw refuse('The public manifest is not acceptable', problems);
  return pub;
}

function difficultyText(d) {
  if (d == null || d < 0) return 'difficulty not recorded';
  return DIFFICULTY_NAMES[d] ? `difficulty ${d} (${DIFFICULTY_NAMES[d]})` : `difficulty ${d}`;
}

// The length as the public manifest carries it, to the minute.
function durationText(s) {
  if (s == null) return 'length not recorded';
  return s < 60 ? 'under a minute' : `about ${Math.round(s / 60)} min`;
}

function yesNo(v, unknown = 'not recorded') {
  return v == null ? unknown : v ? 'yes' : 'no';
}

/**
 * A short title that names nothing personal: the class and level, what was
 * fought, and the first eight characters of the id so two sends of the same
 * boss are told apart in a list. The prefilled title of the manual issue
 * form (submit.mjs formUrl), and the name tools/inbox.mjs gives a fight.
 */
export function issueTitle(pub) {
  const p = checked(pub);
  const enc = p.log.encounter;
  const diff = enc.difficulty != null && DIFFICULTY_NAMES[enc.difficulty] ? `, ${DIFFICULTY_NAMES[enc.difficulty]}` : '';
  const what = enc.bossKind ? `${enc.bossKind}${diff}` : enc.targetDummy ? 'a target dummy' : 'an unnamed fight';
  return `Data submission: ${p.sheet.class} ${p.sheet.level} vs ${what} (${p.id.slice(0, 8)})`;
}

/**
 * The public manifest as a table, [label, value] rows, for whoever reads a
 * bundle (tools/inbox.mjs prints it). Values with any freedom in them (the
 * class, the boss id, the dialect, the bench version) are set in code spans,
 * which GitHub never turns into links or mentions where a row is pasted; a
 * reader that prints them as plain text drops the backticks.
 *
 * The game build is the INSTALL's when the bundle was made, not the build the
 * fight was played on: a fight recorded before a patch and sent after it is
 * sent from the new build, and the row says which it is.
 */
export function issueRows(pub) {
  const p = checked(pub);
  const enc = p.log.encounter;
  const group = p.log.solo === true ? 'solo'
    : p.log.solo === false ? `in a group${enc.partySize ? ` of ${enc.partySize}` : ''}`
      : enc.partySize ? `party of ${enc.partySize} (solo not recorded)` : 'not recorded';
  const fought = enc.bossKind ? `\`${enc.bossKind}\`` : enc.targetDummy ? 'a target dummy' : 'not recorded';
  const outcome = enc.outcome ?? 'outcome not recorded';
  return [
    ['Character', `\`${p.sheet.class}\`, level ${p.sheet.level}`],
    ['Encounter', `${fought}, ${difficultyText(enc.difficulty)}, ${outcome}`],
    ['Group', group],
    ['Target dummy', yesNo(enc.targetDummy)],
    ['Fight', `${durationText(p.log.duration)}, ${p.log.startedAt ? `on ${p.log.startedAt} (UTC day)` : 'day not recorded'}`],
    ['Log', `\`${p.log.sourceDialect}\`, ${p.log.events} events, ${p.log.damageEvents} of them damage, `
      + (p.log.perEvent ? 'one line per event' : 'per-skill totals only')],
    ['Installed game when sent', p.install.steamBuild ? `Steam build ${p.install.steamBuild}` : 'Steam build not recorded'],
    ['Sent', `${p.createdAt} with farever-bench \`${p.bench.version}\``],
  ];
}

// ---------------------------------------------------------------------------
// The zip, read from its directory only
// ---------------------------------------------------------------------------

/**
 * The phrase that says what is wrong with a list of entry names, or null when
 * it is the fixed set: every name one of ZIP_ENTRIES and none twice,
 * manifest.json and sheet.json present, and at least one of combat-log.jsonl
 * and summary.json.
 */
export function zipEntryProblem(names) {
  if (!Array.isArray(names)) return 'the zip\'s entry list could not be read';
  const seen = new Set();
  for (const n of names) {
    if (!ZIP_ENTRIES.includes(n)) {
      const shown = typeof n === 'string' ? JSON.stringify(n.slice(0, 60)) : String(n);
      return `the zip holds ${shown}, and a submission may hold only ${ZIP_ENTRIES.join(', ')}`;
    }
    if (seen.has(n)) return `the zip holds ${n} twice`;
    seen.add(n);
  }
  const missing = ZIP_REQUIRED.filter((n) => !seen.has(n));
  if (missing.length) return `the zip has no ${missing.join(' and no ')}`;
  if (!ZIP_LOGS.some((n) => seen.has(n))) return `the zip has no log (${ZIP_LOGS.join(' or ')})`;
  return null;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const sig = (b, o, x) => o >= 0 && o + 4 <= b.length && u32(b, o) === x;
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;

/**
 * The entries of a zip, from its central directory: [{ name, method, size,
 * compressedSize }]. Nothing is inflated. Throws SubmissionError for a zip
 * that does not start like one, has no end-of-central-directory record
 * exactly at its end (trailing bytes included), spans disks, is zip64, has
 * more than 16 entries, encrypts one, uses a method other than stored or
 * deflate, declares an entry larger than MAX_ENTRY_BYTES, or whose local
 * headers do not match the directory.
 *
 * Names are read byte for byte as Latin-1: the only names accepted are ASCII,
 * and a name in any other encoding simply fails to match one of them.
 */
export function readZipDirectory(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bad = (why) => new SubmissionError(`The zip is not acceptable: ${why}.`);
  if (b.length < 22) throw bad('it is too short');
  if (!sig(b, 0, LOCAL)) throw bad('it does not start with a zip entry');
  let end = -1;
  for (let o = b.length - 22; o >= Math.max(0, b.length - 22 - 0xffff); o--) {
    if (sig(b, o, END) && o + 22 + u16(b, o + 20) === b.length) { end = o; break; }
  }
  if (end < 0) throw bad('it has no end-of-directory record at its end');
  const total = u16(b, end + 10);
  const cdSize = u32(b, end + 12), cdOffset = u32(b, end + 16);
  if (u16(b, end + 4) !== 0 || u16(b, end + 6) !== 0 || u16(b, end + 8) !== total) throw bad('it spans several disks');
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad('it is a zip64 archive');
  if (total === 0) throw bad('it has no entries');
  if (total > MAX_ZIP_ENTRIES) throw bad(`it has ${total} entries`);
  if (cdOffset + cdSize !== end) throw bad('its directory does not end where its end record starts');
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (!sig(b, p, CENTRAL) || p + 46 > end) throw bad(`directory entry ${i + 1} is damaged`);
    const flags = u16(b, p + 8), method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20), size = u32(b, p + 24);
    const nameLen = u16(b, p + 28), extraLen = u16(b, p + 30), commentLen = u16(b, p + 32);
    const local = u32(b, p + 42);
    if (p + 46 + nameLen > end) throw bad(`directory entry ${i + 1} is damaged`);
    const raw = b.subarray(p + 46, p + 46 + nameLen);
    const name = String.fromCharCode.apply(null, raw);
    if (flags & 1) throw bad(`${JSON.stringify(name.slice(0, 60))} is encrypted`);
    if (method !== 0 && method !== 8) throw bad(`${JSON.stringify(name.slice(0, 60))} uses compression method ${method}`);
    if (size > MAX_ENTRY_BYTES) throw bad(`${JSON.stringify(name.slice(0, 60))} declares ${size} bytes`);
    if (!sig(b, local, LOCAL) || local + 30 > cdOffset) throw bad(`${JSON.stringify(name.slice(0, 60))} has no local header`);
    const lNameLen = u16(b, local + 26), lExtraLen = u16(b, local + 28);
    const dataEnd = local + 30 + lNameLen + lExtraLen + compressedSize;
    if (lNameLen !== nameLen || dataEnd > cdOffset || b.subarray(local + 30, local + 30 + nameLen).some((x, k) => x !== raw[k])) {
      throw bad(`${JSON.stringify(name.slice(0, 60))} does not match its local header`);
    }
    out.push({ name, method, size, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== end) throw bad('its directory is longer than its entries');
  return out;
}
