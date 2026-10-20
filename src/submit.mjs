// ---------------------------------------------------------------------------
// submit.mjs - pack one fight for the project, and send it only when asked.
//
// A player who wants the bench to get better at their class has the evidence
// it needs: the build they wore (a character sheet) and what happened when
// they fought in it (a combat log). This file turns those two into ONE zip
// the project can read offline, and uploads that zip to the project's folder
// on pCloud when - and only when - the player clicks Send (`bench submit
// --send`, the UI's "Send a fight"). The CLI and the UI both call it, so
// what is packed, where it goes and what is refused cannot differ between
// them.
//
// THE BUNDLE. One zip with fixed entry names (ZIP_ENTRIES in
// submission-public.mjs), never the player's own file names - a modkit dump
// is named after the character:
//
//   manifest.json      what the bundle is: the bench and game builds, the
//                      sheet's class and level and what the import dropped,
//                      the log's dialect, counts and encounter, how many
//                      names were removed, and the SHA-256 of the bundle's
//                      delete token (deleteTokenSha256), which is how the
//                      maintainer knows a request for its deletion is its
//                      sender's. Private, like everything here.
//   sheet.json         the imported build, written again - never the bytes
//                      the player gave - and recording exactly what the
//                      import recorded (charsheet.mjs recordedSheet). The
//                      character is "Submitter" unless the player keeps
//                      the name; a sheet with no name gets none.
//   combat-log.jsonl   the log, converted to farever-combat-log v1 by
//                      combatlog.mjs anonymizeLog: every record rebuilt from
//                      a field allowlist, every display name dropped, every
//                      uid renumbered, the submitter "Submitter".
//   summary.json       the Wink summary beside the timeline, rebuilt the
//                      same way, when one was given.
//   note.txt           what the player typed, when they typed something.
//
// PRIVACY IS AN ALLOWLIST AND FAILS CLOSED. The log's own copy is checked by
// anonymizeLog. Then the whole bundle is checked again here: every name a
// player in the fight could carry (anonymizeLog's playerNames) and the
// sheet's character name are searched for among every key and string value
// of manifest.json, sheet.json and summary.json (and the sheet's name in the
// log as well), and one found is a refusal. That search compares WHOLE
// values, so what reaches the manifest is never free text: the importer's
// sentences have the names cut out first (wherever they stand, in any case),
// and the log's text facts (its clock, game version, activity id, outcome)
// are held to shapes and sent as not known otherwise. Whatever is left that
// still equals a name is a field nobody thought of, and nothing is built.
// Last, every file but the note is searched once more for each name INSIDE
// its text - any case, any Unicode form, a lookalike letter (combatlog.mjs
// nameFinder) - in every value that is not one of the game's own ids or the
// format's own words, and a name found is a refusal too. The note is the
// player's own words, and is not searched.
//
// WHAT IS PUBLIC. With Send, nothing. The zip goes to the project's folder
// on pCloud through an upload link: its owner, the maintainer, is the one
// who can read what is in it, and an uploader can put files there and do
// nothing else - list, read or delete. pCloud is a third party: it sees the
// player's address as any website does, and is told the uploader name
// UPLOADER_NAME, never a person's. The manual route (Save .zip, then
// GitHub's issue form) is public, and reportLines says so: an attachment on
// a public issue is public, the note and the fight's start time to the
// millisecond included. The issue's title is prefilled from
// submission-public.mjs's publicManifest - a fixed list of fields held to
// fixed shapes - and nothing else.
//
// THE NETWORK. This is one of the two places the bench talks to the
// network (the other is the questlog link any build command takes, fetched
// by applyQuestlog in bin/bench.mjs), and it does so only from
// sendSubmission and deleteSubmission, which nothing calls without the
// player's click. uploadCall below is the one call site, and pCloud's
// uploadtolink the one request it makes: one file, the zip or a request for
// a deletion. The link is UPLOAD_LINK, and FAREVER_BENCH_UPLOAD_LINK
// overrides it (none or off switches sending off; the tests point it at a
// stand-in on 127.0.0.1). With none, Send is not offered and `--send`
// refuses with the sentence that points at the manual route.
//
// A DELETION IS A REQUEST. An uploader can delete nothing behind the link.
// So each bundle draws a delete token once, its manifest carries the
// token's SHA-256, and the player keeps the token in a receipt;
// deleteSubmission uploads it, as <id>.withdraw.json, to the same folder.
// The maintainer deletes the zips of that id and the request when the
// token's SHA-256 is the manifest's (tools/inbox.mjs says which) - when they
// next read the folder, not when the player asks.
//
// THE API, as the CLI and the UI use it:
//
//   uploadLink(env?)                 the upload link Send uses, canonical, or
//                                    null for none
//   parseUploadLink(value, what?)    an upload link, read: {link, api, code}
//   formUrl(pub?)                    the GitHub form, its title prefilled
//   buildSubmission(engine, input)   -> sub (sync; throws SubmissionError)
//   reportItems(sub, {link, front,   what Send does with it (or why it is
//     uploadProblem}?)               off), the manual route, the names and
//                                    the readers' reports, as {kind, text};
//                                    reportLines the same as text
//   problemsOf(sub, {front}?)        its Problem lines' sentences, in the
//                                    front end's words
//   readZip(buf)                     a bundle's entries, inflated
//   sendRefusal(sub, {front, link}?) why a bundle is not sent, or null - the
//                                    module's own rules (a receipt whose
//                                    fight arrived, a receipt of another
//                                    upload link, a log of another class);
//                                    the caller has no say, and says the
//                                    sentence as it is
//   pendingReceipt(sub, {link}?)     the receipt to save BEFORE sending
//   sendSubmission(sub, opts)        -> receipt (async)
//   deleteSubmission(receipt, opts)  -> { ok, status, id, requested } (async)
//   receiptText(receipt) / parseReceipt(text)
//
// Every refusal is a SubmissionError (submission-public.mjs) with `.status`:
// 400 for input that cannot be packed, 413 for one over a cap, 502 for
// pCloud unreached or an answer that is not its API's, and 503, 507, 429 or
// 502 for an upload pCloud refused (`arrived: false`: nothing of it was
// kept) - always one sentence that opens with what was wrong and, where
// something can be done, says what.
// ---------------------------------------------------------------------------

import { randomBytes, createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  readSheet, toSheet, pinnedSheet, recordedSheet, reportItems as sheetReportItems, SheetError, benchVersion, logClass,
  dumpClassFromLog, classVouch,
} from './charsheet.mjs';
import {
  readCombatLog, anonymizeLog, logReportItems, CombatLogError, inflateCapped, nameFinder, findName,
} from './combatlog.mjs';
import {
  SUBMISSION_FORMAT, SUBMISSION_VERSION, MAX_ZIP_BYTES, MAX_ENTRY_BYTES, ID_RE, TOKEN_RE, GAME_ID_RE,
  SubmissionError, publicManifest, checkPublicManifest, issueTitle as publicTitle, readZipDirectory, zipEntryProblem,
  CLOCKS, GAME_VERSION_RE, OUTCOMES,
} from './submission-public.mjs';
import { steamBuildId } from './lib/game.mjs';

/** The project's pCloud upload link: where Send puts a fight. FAREVER_BENCH_UPLOAD_LINK overrides it. */
export const UPLOAD_LINK = 'https://e.pcloud.com/#/puplink?code=V437ZV4md8W0ibw8hS71eMJFTR0f2Sq4y';
/** The uploader name pCloud is given with every file (its `names`): the bench's, never a person's. */
export const UPLOADER_NAME = 'farever-bench';
/** How long a send waits for pCloud's answer: a 25 MB zip on a slow line. */
export const SEND_TIMEOUT_MS = 600_000;
/** What a request for a deletion says it is (deleteSubmission writes it, tools/inbox.mjs reads it). */
export const WITHDRAWAL_FORMAT = 'farever-bench-withdrawal';
/** The repository the manual issue form lives in. */
export const ISSUE_REPO = 'Blaakan/farever-bench';
/** The manual route's issue form (.github/ISSUE_TEMPLATE/). */
export const FORM_TEMPLATE = 'data-submission.yml';
/** The longest note, in characters (UTF-16 units, as a text box counts them). */
export const NOTE_MAX = 2000;
/** The largest character sheet taken, in bytes. A full sheet is a few kilobytes. */
export const SHEET_MAX_BYTES = 512 * 1024;
/** The largest log taken, per file, in bytes of text once inflated. One long boss fight is a few megabytes. */
export const LOG_MAX_BYTES = 20 * 1024 * 1024;

// What the submitter is called in the files when the name is not kept - the
// same word anonymizeLog writes into the log, so the sheet and the log name
// one character.
const SUBMITTER = 'Submitter';
const RECEIPT_FORMAT = 'farever-bench-receipt';
// What stands in, in the importer's sentences, for a name cut out of them.
const NAME_REMOVED = '<name removed>';
// (The shapes the log's text facts are held to in the manifest - CLOCKS,
// GAME_VERSION_RE, OUTCOMES - are submission-public.mjs's, which the
// anonymised log's header is held to as well.)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v !== '';
const fmt = (n) => Number(n).toLocaleString('en-US');

// A refusal: a SubmissionError carrying the HTTP-like status the CLI exits
// on and the UI answers with.
function fail(status, message, problems = []) {
  const e = new SubmissionError(message, problems);
  e.status = status;
  return e;
}
// A SubmissionError raised by submission-public.mjs carries no status; one
// that reaches a caller from here always does.
function withStatus(e, status) {
  if (e instanceof SubmissionError) {
    if (e.status == null) e.status = status;
    return e;
  }
  return e;
}
// A sentence ends once: the readers' sentences carry no full stop, some
// callers' do.
const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

// The game build this tree's model was last accepted on (model/accepted-
// build.json, {at, cdbSha, bootSha}): beside the install's own hashes it says
// whether the fight was priced by a model that knew this build.
function acceptedBuild() {
  try {
    const a = JSON.parse(readFileSync(new URL('../model/accepted-build.json', import.meta.url), 'utf8'));
    return { cdbSha: typeof a.cdbSha === 'string' ? a.cdbSha : null, bootSha: typeof a.bootSha === 'string' ? a.bootSha : null };
  } catch {
    return { cdbSha: null, bootSha: null };
  }
}

// =============================================================================
// Where things go
// =============================================================================

// A plain http address is taken only for this machine (the tests' stand-in):
// the zip holds a player's fight, and across a network it travels over TLS
// or not at all.
function isLoopback(host) {
  const h = String(host).toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

// pCloud's own hosts: pcloud.com and pcloud.link, and any name under them.
const PCLOUD_HOST = /^(?:[a-z0-9-]+\.)*pcloud\.(?:com|link)$/;
// An upload link's code, as pCloud writes them (letters and digits).
const CODE_RE = /^[A-Za-z0-9]{8,64}$/;

// An upload link, read: { link, api, code }, or { why } - the phrase that
// says why it is none, read after "it" ("is not an http(s) address").
//
// The code is in the address's query (?code=) or in its fragment, where
// pCloud's own pages put it (#/puplink?code=..., #page=puplink&code=...).
// A link's region decides the API host it answers on: the EU's hosts start
// with e or e and digits (e.pcloud.com, e1.pcloud.link) - and a code of the
// EU is unknown to the US host, and the other way round. The canonical link
// names the code on its region's own site, so two spellings of one link
// compare equal; a stand-in on this machine is its own origin.
function readLink(value) {
  let u = null;
  try { u = new URL(String(value).trim()); } catch { u = null; }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return { why: 'is not an http(s) address' };
  if (u.username || u.password) return { why: 'carries a user or a password, which an upload link does not' };
  const host = u.hostname.toLowerCase();
  const loop = isLoopback(host);
  if (!loop && !PCLOUD_HOST.test(host)) return { why: 'is not on pCloud (pcloud.com, pcloud.link)' };
  if (u.protocol === 'http:' && !loop) return { why: 'is plain http, which is taken only on this machine (127.0.0.1, localhost, [::1])' };
  const frag = u.hash.replace(/^#/, '');
  const code = u.searchParams.get('code') ?? new URLSearchParams(frag.includes('?') ? frag.slice(frag.indexOf('?') + 1) : frag).get('code');
  if (code === null || code === '') return { why: 'carries no code (?code=...)' };
  if (!CODE_RE.test(code)) return { why: 'carries a code that is not 8 to 64 letters and digits' };
  if (loop) return { link: `${u.origin}/#/puplink?code=${code}`, api: u.origin, code };
  if (/^e\d*$/.test(host.split('.')[0]) || host === 'eapi.pcloud.com') {
    return { link: `https://e.pcloud.com/#/puplink?code=${code}`, api: 'https://eapi.pcloud.com', code };
  }
  return { link: `https://my.pcloud.com/#/puplink?code=${code}`, api: 'https://api.pcloud.com', code };
}

/**
 * An upload link, read: { link, api, code }. `link` is its canonical form -
 * what receipts and previews carry, and what two links are compared by;
 * `api` is the pCloud API host its region answers on (for a stand-in on this
 * machine, its own origin); `code` is the link's code. Taken: an https
 * address on pcloud.com or pcloud.link, or an http(s) one on this machine
 * (127.0.0.1, localhost, [::1]), with no user or password and the code in
 * its query or its fragment. Anything else is a SubmissionError (400) whose
 * sentence opens with `what`.
 */
export function parseUploadLink(value, what = 'The upload link') {
  const r = readLink(value);
  if (r.why) {
    throw fail(400, `${what} is ${JSON.stringify(String(value).slice(0, 200))}: it ${r.why} - give the upload link pCloud shows for the folder, `
      + 'https://...pcloud.../#/puplink?code=...');
  }
  return r;
}

/**
 * The upload link Send uses, canonical (parseUploadLink's `link`), or null
 * when there is none. FAREVER_BENCH_UPLOAD_LINK in `env` overrides
 * UPLOAD_LINK; '', 'none' and 'off' (any case) switch sending off. Anything
 * else must be an upload link, or a SubmissionError (400) says what is wrong
 * with it - and names UPLOAD_LINK when it is this copy's own that is.
 */
export function uploadLink(env = process.env) {
  const raw = env?.FAREVER_BENCH_UPLOAD_LINK;
  if (raw === undefined || raw === null) return UPLOAD_LINK === null ? null : parseUploadLink(UPLOAD_LINK, 'UPLOAD_LINK in src/submit.mjs').link;
  const v = String(raw).trim();
  if (v === '' || /^(none|off)$/i.test(v)) return null;
  return parseUploadLink(v, 'FAREVER_BENCH_UPLOAD_LINK').link;
}

/**
 * The manual route: GitHub's issue form for a submission, with the issue's
 * title prefilled from the public manifest (issueTitle - class, level, what
 * was fought, the id's first eight characters). Only the title travels in
 * the address, never data; with no manifest, the bare form.
 */
export function formUrl(pub = null) {
  const base = `https://github.com/${ISSUE_REPO}/issues/new?template=${encodeURIComponent(FORM_TEMPLATE)}`;
  if (pub == null) return base;
  let title;
  try { title = publicTitle(pub); } catch (e) { throw withStatus(e, 400); }
  return `${base}&title=${encodeURIComponent(title)}`;
}

// =============================================================================
// The zip
// =============================================================================

// CRC-32 (the zip and gzip polynomial, reflected), by table. node:zlib has
// crc32 only from Node 22, and the bench runs on 18.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The MS-DOS time and date a zip entry carries, from a Date's UTC fields: a
// zip has no time zone, and reading the local one would make the same
// bundle's bytes depend on the machine that built it. Clamped to what the
// format can hold (1980 to 2107, even seconds).
function dosStamp(date) {
  let d = date instanceof Date ? date : new Date(date ?? Date.now());
  if (!Number.isFinite(d.getTime()) || d.getUTCFullYear() < 1980) d = new Date(Date.UTC(1980, 0, 1));
  if (d.getUTCFullYear() > 2107) d = new Date(Date.UTC(2107, 11, 31, 23, 59, 58));
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const day = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * A zip of `files` ([{name, data}], data a Buffer, bytes or text), in the
 * order given. Each entry is deflated (node:zlib, raw) unless that would not
 * make it smaller, when it is stored; names are UTF-8 (flag bit 11); every
 * entry carries the one time `date` gives (a Date, epoch ms or ISO text), so
 * the same files and date make the same bytes. No zip64: an entry or the
 * whole archive past 4 GB is refused, as is a name that is a path.
 */
function zipFiles(files, { date = null } = {}) {
  if (!Array.isArray(files) || !files.length) throw fail(400, 'A zip needs at least one file.');
  if (files.length > 0xfffe) throw fail(413, `A zip of ${fmt(files.length)} files is past what this writer makes.`);
  const { time, day } = dosStamp(date);
  const locals = [];
  const centrals = [];
  const seen = new Set();
  let offset = 0;
  for (const f of files) {
    const name = f?.name;
    if (typeof name !== 'string' || !name || name.length > 255 || /[\\\u0000-\u001f]/.test(name) || name.startsWith('/')
      || name.split('/').some((p) => p === '..' || p === '')) {
      throw fail(400, `${JSON.stringify(String(name).slice(0, 80))} is not a name a zip entry is given here (a relative path of plain parts).`);
    }
    if (seen.has(name)) throw fail(400, `The zip would hold ${name} twice.`);
    seen.add(name);
    const raw = asBuffer(f.data);
    if (raw === null) throw fail(400, `${name} holds neither text nor bytes.`);
    if (raw.length >= 0xffffffff) throw fail(413, `${name} is past the 4 GB a zip entry holds without zip64.`);
    const crc = crc32(raw);
    const packed = deflateRawSync(raw);
    const deflate = packed.length < raw.length;
    const body = deflate ? packed : raw;
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                 // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6);             // flags: names are UTF-8
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);               // made by: 2.0, MS-DOS attributes
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk, internal and external attributes: all 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + body.length;
    if (offset >= 0xffffffff) throw fail(413, 'The zip is past the 4 GB a zip holds without zip64.');
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * The entries of a submission zip, inflated: [{name, data: Buffer}], in the
 * zip's order. The zip is first held to everything readZipDirectory checks
 * (one archive, at most 16 entries, stored or deflate, no encryption, local
 * headers that match the directory); every entry is then inflated to at most
 * the size it declares and its CRC-32 checked. Throws SubmissionError (400).
 */
export function readZip(buf) {
  const b = asBuffer(buf);
  if (b === null) throw fail(400, 'A zip is bytes, and this is not.');
  let dir;
  try { dir = readZipDirectory(b); } catch (e) { throw withStatus(e, 400); }
  let end = -1;
  for (let o = b.length - 22; o >= Math.max(0, b.length - 22 - 0xffff); o--) {
    if (b.readUInt32LE(o) === 0x06054b50 && o + 22 + b.readUInt16LE(o + 20) === b.length) { end = o; break; }
  }
  const out = [];
  let p = b.readUInt32LE(end + 16);
  for (let i = 0; i < dir.length; i++) {
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const packed = b.subarray(start, start + csize);
    let data;
    try {
      data = method === 8 ? inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(size, MAX_ENTRY_BYTES)) }) : Buffer.from(packed);
    } catch (e) {
      throw fail(400, `${name} in the zip does not inflate to the ${fmt(size)} bytes it declares (${e?.message ?? e}).`);
    }
    if (data.length !== size) throw fail(400, `${name} in the zip is ${fmt(data.length)} bytes, not the ${fmt(size)} it declares.`);
    if (crc32(data) !== crc) throw fail(400, `${name} in the zip does not match its CRC-32: the zip is damaged.`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// =============================================================================
// The bundle
// =============================================================================

// Bytes of a part the caller handed in, for the caps; null when it holds
// nothing readable.
function sizeOf(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (isObj(data)) {
    try { return Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch { return null; }
  }
  return null;
}

// A log part ({name, data, mtimeMs?}) held to the cap: its text, inflated
// once here when it is gzip (to LOG_MAX_BYTES and no further), so that the
// reader gets plain text and a bomb is refused at 20 MB rather than at the
// reader's own 64.
// `named` says whether the caller gave the file a name: a sentence that names
// the file then says it, and one that has none says the part's role alone.
function capLog(part, role, fallback) {
  const named = str(part?.name);
  const name = named ? part.name : fallback;
  const label = named ? `${role} ${part.name}` : role;
  let data = part?.data;
  if (typeof data === 'string') {
    const n = Buffer.byteLength(data, 'utf8');
    if (n > LOG_MAX_BYTES) {
      throw fail(413, `${label} is ${fmt(n)} bytes; a submission takes at most ${fmt(LOG_MAX_BYTES)} (20 MB) per log - send one fight per log.`);
    }
    return { name, named, data };
  }
  data = asBuffer(data);
  if (data === null) throw fail(400, `${label} holds nothing to read - a log is text or bytes.`);
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    const out = inflateCapped(data, LOG_MAX_BYTES);
    if (out.tooLarge) {
      throw fail(413, `${label} inflates to more than ${fmt(LOG_MAX_BYTES)} bytes (20 MB), and a submission takes at most that per log - `
        + 'send one fight per log.');
    }
    if (out.error) throw fail(400, `${label} starts like a gzip file but does not inflate (${out.error}).`);
    data = out.data;
  }
  if (data.length > LOG_MAX_BYTES) {
    throw fail(413, `${label} is ${fmt(data.length)} bytes; a submission takes at most ${fmt(LOG_MAX_BYTES)} (20 MB) per log - send one fight per log.`);
  }
  return { name, named, data };
}

function dateOf(now) {
  if (now == null) return new Date();
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(d.getTime())) throw fail(400, `${JSON.stringify(String(now).slice(0, 60))} is not a time to date a submission with.`);
  return d;
}

// The importer's sentences, with the names cut out: what the manifest
// carries of them. They never need an id kept whole, so a name is cut
// WHEREVER it stands - inside an id ("Zorbalina_hat"), in any case or
// Unicode form, spelt with a lookalike letter (combatlog.mjs nameFinder). A
// name of two letters, which inside text would be found everywhere ("of",
// "al"), is cut where it stands as a word of its own, as written, '_'
// counting as a separator.
function scrubber(names) {
  const inside = nameFinder(names);
  const short = [...names].filter((n) => str(n) && n.trim().length === 2);
  const res = short.map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu'));
  return (v) => {
    if (typeof v !== 'string') return v;
    let s = inside.cut(v, NAME_REMOVED);
    for (const re of res) s = s.replace(re, NAME_REMOVED);
    return s;
  };
}

// The refusal for a name found where it may not stand.
function leaked(s, file, where) {
  return fail(400, `A player's name is still in the bundle: "${s}" - the name of someone in this fight, or of the sheet's character - `
    + `is also a value of ${file} (${where}). A bundle that holds a name is not sent, whichever field holds it, so nothing was built.`);
}

// Every key and string value of `value`, held to `names` as whole values
// (combatlog.mjs findName): the first found is a refusal. `allowed(path, s)`
// names the one place a kept name may stand.
function leakCheck(file, value, names, allowed = () => false) {
  const hit = findName(value, names, allowed);
  if (hit) throw leaked(hit.name, file, hit.where);
}

// Every id of the game this install read: the values that came from data.cdb
// and so carry no name, whatever letters they share with one. Per cdb.
const gameIdsByCdb = new WeakMap();
function gameIds(cdb) {
  let ids = gameIdsByCdb.get(cdb);
  if (ids) return ids;
  ids = new Set();
  for (const [name, sheet] of cdb.sheets ?? []) {
    if (name.includes('@')) continue;
    for (const line of sheet.lines ?? []) if (typeof line?.id === 'string' && line.id) ids.add(line.id);
  }
  gameIdsByCdb.set(cdb, ids);
  return ids;
}

// The words the bench itself writes into a bundle, which no name rides.
const FORMAT_WORDS = new Set([
  'farever-bench', 'farever-bench-submission', 'farever-character-sheet', 'farever-combat-log', 'wink-dps-meter',
  'wink-timeline', 'wink-summary', 'bench-editor', 'bench-envelope', 'bench-loadout', 'modkit-inventory',
  'physical', 'magical', 'raw', 'unclassified', 'Hit', 'Blocked', 'Used', 'Submitter', ...CLOCKS, ...OUTCOMES,
]);
// Values whose shape holds no name: hex (ids, hashes), dates and times, numbers.
const NAMELESS = [/^[0-9a-f]{16,}$/i, /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/, /^-?\d+(?:\.\d+)?$/];

/**
 * The last check of a bundle, fail closed: every string value of every file
 * but the note, searched for each name INSIDE it (nameFinder: any case, any
 * Unicode form, a lookalike letter) - "Heal_by_Kestrela", "KESTRELA",
 * "Kestrela's flask". A value that is one of the game's ids, one of the
 * format's own words, or of a shape no name has (hex, a date, a number) is
 * passed over: it came from the data or from the bench, and a name sharing
 * letters with one is no leak. So is an event's lower-case `kind` and a
 * summary's lower-case `category`, which are the format's vocabulary. The
 * first name found is a refusal that names the file and the field.
 */
function nameInsideCheck(files, names, { isGameId, words, allowed }) {
  const inside = nameFinder(names);
  const passes = (s, key) => isGameId(s) || words.has(s) || NAMELESS.some((re) => re.test(s))
    || ((key === 'kind' || key === 'category') && /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(s));
  for (const { name, value } of files) {
    let hit = null;
    const walk = (v, where, key) => {
      if (hit) return;
      if (typeof v === 'string') {
        if (passes(v, key) || allowed(name, where, v)) return;
        const n = inside.first(v);
        if (n) hit = { name: n, where };
        return;
      }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`, key)); return; }
      if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k, k);
    };
    walk(value, '', null);
    if (hit) {
      throw fail(400, `A player's name is still in the bundle: "${hit.name}" - the name of someone in this fight, or of the sheet's character - `
        + `stands inside a value of ${name} (${hit.where}). A bundle that holds a name is not sent, whichever field holds it, so nothing was built.`);
    }
  }
}

const pretty = (v) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Pack one fight: read the sheet and the log, anonymise both, check the
 * whole bundle for names, zip it and work out the manual route's title.
 * Synchronous; nothing leaves the machine. In five steps, each a function
 * below: the sheet (readSheetPart), the log (readLogPart), the manifest
 * (manifestOf), the names (checkNames) and the zip with its public summary
 * (packBundle).
 *
 * @param input.sheet         { name, data }: a sheet file in any dialect
 *                            readSheet reads (text, bytes or a parsed object),
 *                            or { loadout, name?, rank?, pins?, pieces? }: a
 *                            build somebody stated - the editor's, or the one
 *                            `bench submit` was typed with. With `pins` (the
 *                            UI's App.state.pins, sets as lists) only what they
 *                            hold is recorded (charsheet.mjs pinnedSheet), and
 *                            everything else is left open and named as a gap;
 *                            without them every part of the loadout goes as
 *                            recorded. Either way it takes the path a file does,
 *                            and the manifest labels it 'bench-editor' (a
 *                            stated build, not a file an exporter wrote)
 *                            whichever front end stated it
 * @param input.sheetOptions  { cls, level }: what was given BESIDE a file (--class,
 *                            --level, the UI's class choice): for a dialect that
 *                            does not say (a modkit dump). A cls that names the
 *                            class a file names itself also vouches for it
 *                            against a log of another class (classMismatch);
 *                            beside the editor's build it vouches for nothing
 * @param input.log           { name, data, mtimeMs? }: a combat log in any
 *                            dialect readCombatLog reads; a Wink summary alone
 *                            is taken as totals only
 * @param input.summary       { name, data }: the Wink summary beside a timeline
 * @param input.note          the player's note, at most NOTE_MAX characters
 * @param input.keepName      keep the character's name where the files had it:
 *                            sheet.json and the log's header (off by default)
 * @param input.id            the submission id (32 hex), made here when absent;
 *                            input.deleteToken the same for the delete token,
 *                            whose SHA-256 the manifest carries
 * @param input.now           the bundle's time (a Date, epoch ms or ISO text).
 *                            The same files with a receipt's id, deleteToken
 *                            and createdAt make the same bundle, byte for byte,
 *                            on the same game build and bench version
 * @param input.zipSha256     a bundle built again from a receipt: the receipt's
 *                            zipSha256, given with its id. An id names one
 *                            bundle - sent again after a lost answer, the
 *                            folder holds at most an identical copy, which the
 *                            maintainer drops - so a bundle built again under
 *                            the id must be that bundle: one that is not is
 *                            refused (400) before anything is sent. null - a
 *                            receipt written before receipts named their
 *                            bundle - checks nothing, and the new receipt
 *                            names none either (receiptSha256 null). Left out,
 *                            the bundle is a new one
 * @param input.sentAt        a bundle built again from a receipt: the receipt's
 *                            sentAt (the time pCloud confirmed the send, or
 *                            null for a send whose answer was lost), given
 *                            with its id. Set, the fight under that id
 *                            ARRIVED, and nothing is left to send under it:
 *                            the bundle is still built (Save .zip, --zip), and
 *                            sendRefusal refuses to send it
 * @param input.receipt       a receipt to build the bundle again from (parseReceipt's
 *                            result, or its text): it stands for id,
 *                            deleteToken, now, zipSha256 and sentAt - given
 *                            with any of them is a 400 - and names the upload
 *                            link it was written for (sub.sentTo), which
 *                            sendRefusal holds a send to. One that does not say
 *                            when its bundle was made (createdAt) cannot build
 *                            that bundle again, and is refused (400). A
 *                            refusal OF THE RECEIPT (that one, or one that is
 *                            not a receipt) carries `receipt: true`, for a
 *                            caller to name where it came from
 * @returns {{ id, deleteToken, createdAt, manifest, pub, zip, zipSha256, zipBytes,
 *   receiptSha256, zipName, files: {name, bytes}[], issueTitle, formUrl,
 *   sheetReport: string[], logReport: string[], sheetItems, logItems,
 *   privacy: {namesRemoved, ownNameKept}, keptNameIn: string[],
 *   logClass, classMismatch: {sheet, log, vouched, vouchable} | null,
 *   answered: {sentAt} | null, sentTo: string | null,
 *   statedProblems: object[], problems: string[] }}
 *   `receiptSha256` is what a receipt of this bundle says it is: its own
 *   SHA-256, or null for a bundle built again under an id with no SHA to hold
 *   it to. `classMismatch` is set when the log names its character another
 *   class than the sheet's: `vouchable` when the file names its own class (a
 *   class given beside it could confirm it), `vouched` when the one given
 *   does. sendRefusal refuses such a bundle unless it is vouched for.
 *   `answered` is input.sentAt: when the first send under this id was
 *   confirmed, which sendRefusal refuses to send again. `sentTo` is
 *   input.receipt's upload link (canonical). `issueTitle` is the manual
 *   route's (formUrl prefills it). `statedProblems` is what a stated build is told
 *   (statedFindings), as data: problemsOf words it per front end.
 *
 *   A MODKIT DUMP WITH NO CLASS given beside it is read in the class the
 *   fight's log gives it when the log is of the dump's own character and its
 *   weapons fit that class (charsheet.mjs dumpClassFromLog), and a problem
 *   says so; otherwise the class is asked for (below).
 * @throws SubmissionError with .status 400 or 413, one sentence. A sheet the
 *   importer refused passes its facts on (`needs`, `classes`, `character`,
 *   `empty`, `combatLog`: see charsheet.mjs SheetError); with needs 'class'
 *   it also carries `logClass`, the class the fight's log names its
 *   character (charsheet.mjs logClass; null when it names none or the log
 *   cannot be read)
 */
export function buildSubmission(engine, input = {}) {
  const given = isObj(input) ? input : {};
  const {
    sheet = null, sheetOptions = null, log = null, summary = null, note = null, keepName = false,
  } = given;
  let {
    id = null, deleteToken = null, now = null, zipSha256: expectedSha = null, sentAt = null,
  } = given;
  let rebuilt = Object.prototype.hasOwnProperty.call(given, 'zipSha256');
  // A receipt to build the bundle again from: it stands for its id, key,
  // time, SHA-256 and sentAt, and names the upload link it was sent through
  // (sentTo).
  let sentTo = null;
  if (given.receipt != null) {
    const own = ['id', 'deleteToken', 'now', 'zipSha256', 'sentAt'].filter((k) => given[k] != null || (k === 'zipSha256' && rebuilt));
    if (own.length) {
      throw fail(400, `A receipt stands for the ${own.join(', ')} of the bundle it names - give the receipt, or those, not both.`);
    }
    let r;
    try { r = parseReceipt(given.receipt); } catch (e) { throw Object.assign(withStatus(e, 400), { receipt: true }); }
    if (!r.createdAt) {
      throw Object.assign(fail(400, `The receipt of submission ${r.id.slice(0, 8)} does not say when its bundle was made (createdAt), `
        + 'so that bundle cannot be built again byte for byte - the receipt still asks for the deletion of what it sent.'), { receipt: true });
    }
    ({ id, deleteToken, zipSha256: expectedSha, sentAt } = r);
    now = r.createdAt;
    rebuilt = true;
    sentTo = r.link;
  }
  const keep = keepName === true;
  const when = dateOf(now);
  const createdAt = when.toISOString();
  const subId = id ?? randomBytes(16).toString('hex');
  if (typeof subId !== 'string' || !ID_RE.test(subId)) throw fail(400, `The submission id ${JSON.stringify(id)} is not 32 lowercase hex characters.`);
  const key = deleteToken ?? randomBytes(16).toString('hex');
  if (typeof key !== 'string' || !TOKEN_RE.test(key)) throw fail(400, 'The delete token is not 32 lowercase hex characters.');
  if (expectedSha !== null && (typeof expectedSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha))) {
    throw fail(400, 'The bundle\'s expected SHA-256 is not 64 lowercase hex characters.');
  }
  if (rebuilt && id === null) throw fail(400, 'A receipt\'s SHA-256 names the bundle it was written for, and comes with its id.');
  // The receipt's sentAt: the first send under this id was confirmed then.
  let answered = null;
  if (sentAt !== null && sentAt !== undefined) {
    if (id === null) throw fail(400, 'A receipt\'s sentAt says the fight under its id arrived, and comes with that id.');
    if (!isTime(sentAt)) throw fail(400, 'The receipt\'s sentAt is not a time.');
    answered = { sentAt };
  }
  const problems = [];

  // --- the note: the player's own words, private, capped
  let noteText = null;
  if (note !== null && note !== undefined) {
    if (typeof note !== 'string') throw fail(400, 'The note is not text.');
    const t = note.replace(/\r\n?/g, '\n').trim();
    if (t.length > NOTE_MAX) throw fail(413, `The note is ${fmt(t.length)} characters; a note may hold at most ${fmt(NOTE_MAX)}.`);
    if (t) noteText = t;
  }

  let S;
  let logRead = null;
  try {
    S = readSheetPart(engine, sheet, sheetOptions, { createdAt, problems });
  } catch (e) {
    if (!(e instanceof SubmissionError) || e.needs !== 'class') throw e;
    // The importer's "which class?" of a modkit dump: the fight's log gives
    // it when it is a log of the dump's own character in a class its weapons
    // fit (charsheet.mjs dumpClassFromLog - the rule `bench verify` reads a
    // dump beside a log by too), and it is said. Otherwise it is asked, with
    // the class the log names its character (null when it names none, or
    // cannot be read) for a caller to offer first.
    try { logRead = readLogInput(log, summary); } catch { logRead = null; }
    const unit = dumpClassFromLog(engine.cat, e, logRead?.L ?? null);
    if (!unit) {
      e.logClass = logRead ? logClass(engine.cat, logRead.L) : null;
      // ...and why the log's class was not taken, when it names one.
      if (e.logClass) {
        const fits = Array.isArray(e.classes) && e.classes.includes(e.logClass);
        e.message = `${sentence(e.message)} The fight's log names its character a ${e.logClass}, `
          + `${fits ? 'and is a log of another character' : 'a class the dump\'s weapons do not fit'}, so the dump is not read as one.`;
      }
      throw e;
    }
    S = readSheetPart(engine, sheet, { cls: unit, level: sheetOptions?.level ?? null }, { createdAt, problems });
    problems.push(`a modkit dump names no class: it is read as a ${unit} - the class the fight's log gives the dump's own character, `
      + 'and one every weapon the dump lists fits (a class given beside the dump says otherwise)');
  }
  const L = readLogPart(engine, log, summary, { keep, sheetName: S.R.name, read: logRead });
  const M = manifestOf(engine, S, L, { keep, createdAt, subId, key, problems });
  checkNames(engine, S, L, M);
  const stated = statedFindings(engine, S, L.L, M.classMismatch);
  return packBundle(engine, { S, L, M, noteText, when, createdAt, subId, key, expectedSha, rebuilt, answered, sentTo, stated, problems });
}

// --- the sheet: read by the one importer, whatever it came as ----------------------
function readSheetPart(engine, sheet, sheetOptions, { createdAt, problems }) {
  if (!isObj(sheet)) {
    throw fail(400, 'No character sheet was given - a submission carries the build the fight was fought in: a sheet file, or the build itself, as stated.');
  }
  const opts = { cls: sheetOptions?.cls ?? null, level: sheetOptions?.level ?? null };
  const readAs = (data, what) => {
    try {
      return readSheet(engine, data, opts);
    } catch (e) {
      if (!(e instanceof SheetError)) throw e;
      const err = fail(400, sentence(`${what} was not read: ${e.message}`));
      // What the importer said as data travels with it: a caller asks for a
      // class (`needs`), offers the ones the dump's weapons allow, or says a
      // combat log went where the build goes.
      for (const k of ['needs', 'classes', 'character', 'empty', 'combatLog']) if (e[k] !== undefined) err[k] = e[k];
      throw err;
    }
  };
  // A build somebody stated - the UI's editor, the CLI's flags - is "the
  // build" in every sentence here: both front ends give it this way, and
  // neither may print the other's word for it.
  if (sheet.loadout !== undefined) {
    if (!isObj(sheet.loadout)) throw fail(400, 'The build is not a loadout.');
    let draft;
    try {
      const said = {
        name: str(sheet.name) ? sheet.name : null,
        rank: Number.isInteger(sheet.rank) ? sheet.rank : null,
        source: { writtenAt: createdAt },
      };
      if (sheet.pins != null) {
        if (!isObj(sheet.pins)) throw new TypeError('its pins are not {gear, augments, skills, runes, talents, infusions}');
        const typed = pinnedSheet(engine, sheet.loadout, sheet.pins, { ...said, pieces: sheet.pieces ?? null });
        draft = typed.sheet;
        // What a sheet records whole, said: the rest of a pinned piece's
        // sockets, and the rune slots no pin set, go as empty.
        for (const { slot, types } of typed.emptied.sockets) {
          problems.push(`${slot}: a sheet records a piece's sockets whole, so ${types.join(' and ')}, which no pin held, `
            + `${types.length === 1 ? 'is' : 'are'} sent as empty`);
        }
        if (typed.emptied.runes.length) {
          problems.push(`a sheet records the rune slots whole, so the ${typed.emptied.runes.length} no pin held `
            + `(${typed.emptied.runes.join(', ')}) ${typed.emptied.runes.length === 1 ? 'is' : 'are'} sent as empty`);
        }
        for (const slot of typed.unplaced) {
          problems.push(`${slot}: its sockets were pinned and no piece in it was, and a sheet records sockets on the piece that holds them - they are not sent`);
        }
      } else {
        draft = toSheet(engine, sheet.loadout, said);
      }
    } catch (e) {
      throw fail(400, sentence(`The build could not be written as a sheet: ${e?.message ?? e}`));
    }
    // A build somebody stated has no class but the one they stated: nothing
    // given beside it can confirm it (classVouch's `stated`). What it holds
    // is kept beside it, for what the player is told of it (statedFindings).
    return {
      R: readAs(draft, 'The build'), sourceFormat: 'bench-editor', opts,
      stated: { loadout: sheet.loadout, pins: isObj(sheet.pins) ? sheet.pins : null },
    };
  }
  const label = str(sheet.name) ? `The character sheet ${sheet.name}` : 'The character sheet';
  const bytes = sizeOf(sheet.data);
  if (bytes === null) throw fail(400, `${label} holds nothing to read.`);
  if (bytes > SHEET_MAX_BYTES) {
    throw fail(413, `${label} is ${fmt(bytes)} bytes; a sheet may be at most ${fmt(SHEET_MAX_BYTES)} (512 KB).`);
  }
  const R = readAs(sheet.data, label);
  // (Whether the class given beside the file confirms the file's own is
  // charsheet.mjs classVouch's to say: see manifestOf's classMismatch.)
  return { R, sourceFormat: R.format, opts, stated: null };
}

// --- the log: capped, read, anonymised (allowlist, fail closed) --------------------
// The log as given, capped and read: a Wink summary alone stands in for it.
function readLogInput(log, summary) {
  let logPart = log;
  let sumPart = summary;
  if (!isObj(logPart) && isObj(sumPart)) { logPart = sumPart; sumPart = null; }
  if (!isObj(logPart)) {
    throw fail(400, 'No combat log was given - a submission carries the fight: a farever-combat-log, or the files Wink\'s DPS Meter saved.');
  }
  const mainIn = capLog(logPart, 'The combat log', 'the combat log');
  const compIn = isObj(sumPart) ? capLog(sumPart, 'The summary', 'the summary') : null;
  try {
    const L = readCombatLog({ name: mainIn.name, data: mainIn.data, mtimeMs: Number.isFinite(logPart.mtimeMs) ? logPart.mtimeMs : null, companion: compIn });
    return { L, mainIn, compIn };
  } catch (e) {
    // The reader's sentence names the file itself.
    if (e instanceof CombatLogError) throw fail(400, sentence(`The combat log was not read: ${e.message}`));
    throw e;
  }
}

function readLogPart(engine, log, summary, { keep, sheetName = null, read = null }) {
  const { L, mainIn, compIn } = read ?? readLogInput(log, summary);
  let an;
  try {
    // isUnit: a boss kind, or a unit kind, that is no unit of this game build
    // is not carried in the copy's header, rows or summary, as it is not in
    // the manifest below.
    // otherNames: the sheet's character, which the log need not name.
    an = anonymizeLog(L, {
      keepName: keep, heroKinds: engine.cat.classes.map((c) => c.unit), isUnit: (k) => engine.cdb.has('unit', k),
      otherNames: str(sheetName) && !engine.cat.classes.some((c) => c.unit === sheetName || c.aptitude === sheetName) ? [sheetName] : [],
    });
  } catch (e) {
    if (e instanceof CombatLogError) {
      throw fail(400, sentence(`${mainIn.named ? `The combat log ${mainIn.name}` : 'The combat log'} cannot be sent: ${e.message.replace(/^refused: /, '')}`));
    }
    throw e;
  }
  return { L, an, compIn };
}

// --- manifest.json, and what the bench tells the player before it is sent ------------
function manifestOf(engine, S, P, { keep, createdAt, subId, key, problems }) {
  const { R, sourceFormat, opts } = S;
  const { L, an, compIn } = P;

  // --- who is searched for. The class ids are not: every sheet carries its
  // class, and a character named like one is named like every other of it.
  const names = new Set(an.playerNames);
  if (str(R.name)) names.add(R.name);
  for (const c of engine.cat.classes) { names.delete(c.unit); names.delete(c.aptitude); }
  const scrub = scrubber(names);
  const inside = nameFinder(names);

  // --- sheet.json: the import, written again (charsheet.mjs recordedSheet,
  // the same cut `bench import --json` writes): what the import recorded and
  // nothing it did not, with this install's build in its source - the fight
  // was fought, and is priced, on this install.
  const install = {
    steamBuild: steamBuildId(engine.meta?.game ?? null),
    cdbSha: engine.meta?.cdbSha ?? null,
    bootSha: engine.meta?.bootSha ?? null,
  };
  // The name as the import had it: none stays none, a name becomes
  // "Submitter" unless the player keeps it.
  const keptSheetName = keep && str(R.name) ? R.name : null;
  const sheetName = !str(R.name) ? null : keep ? R.name : SUBMITTER;
  const rs = recordedSheet(engine, R, {
    name: sheetName, source: 'install', writtenAt: createdAt, steamBuild: install.steamBuild, label: 'sheet.json',
  });
  problems.push(...rs.problems);

  // --- the log's facts, for the manifest and the issue
  const s = L.stats;
  const enc = s.encounter ?? {};
  let bossKind = enc.bossKind ?? null;
  if (bossKind !== null && !engine.cdb.has('unit', bossKind)) {
    problems.push(`the log names its boss "${bossKind}", which is no unit id of this game build - it is sent as not known`);
    bossKind = null;
  }
  let duration = Number.isFinite(s.duration) ? s.duration : null;
  if (duration !== null && (duration < 0 || duration > 86_400)) {
    problems.push(`the log says the fight lasted ${duration} s, which no fight does - its length is sent as not known`);
    duration = null;
  }
  let partySize = enc.partySize ?? null;
  if (partySize !== null && partySize > 99) {
    problems.push(`the log says the party held ${partySize} players - the party size is sent as not known`);
    partySize = null;
  }
  // The facts an exporter wrote as text, held to shapes. The manifest is
  // private, but a value it carries as written is a channel a name could
  // ride ("Emsey's logger" as a clock), and the search for names below finds
  // a name only where it is the whole value. So a value that is not of its
  // shape, or holds a name anywhere inside it ("Zorbalina_run"), is sent as
  // not known - and said, without repeating it.
  const shaped = (what, v, shape, ok) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string' && ok(v) && !inside.has(v) && scrub(v) === v) return v;
    problems.push(`the log's ${what} is not ${shape} - it is sent as not known`);
    return null;
  };
  const clock = shaped('clock', str(L.header?.clock) ? L.header.clock : (L.dialect === 'farever-combat-log' ? null : 'client-observed'),
    `one of ${CLOCKS.join(', ')}`, (v) => CLOCKS.includes(v));
  const gameVersion = shaped('game version', s.gameVersion, 'a version (one word of letters, digits and . _ + - with a digit in it)', (v) => GAME_VERSION_RE.test(v));
  const activityId = shaped('activity id', enc.activityId, 'a game id (letters, digits and _) with no name in it', (v) => GAME_ID_RE.test(v));
  const outcome = shaped('outcome', enc.outcome, `${OUTCOMES.join(' or ')}`, (v) => OUTCOMES.some((o) => o.toLowerCase() === v.trim().toLowerCase()));
  const outcomeWord = outcome === null ? null : OUTCOMES.find((o) => o.toLowerCase() === outcome.trim().toLowerCase());

  // --- what the bench can tell the player before it is sent
  // A LOG OF ANOTHER CLASS: sendRefusal refuses the pair, unless it is
  // VOUCHED for - the file names its own class (a written sheet, a saved
  // build) and the class given beside it (--class, the UI's sheetOptions)
  // names the same: two words on the class against the log's one, which
  // says the log's header is the one that is wrong, as `bench verify` takes
  // it. A modkit dump names no class, a sheet with none takes the one given,
  // and a stated build (the editor's, the CLI's flags) has only the class it
  // was stated as: there the given class is the sheet's only word on it,
  // and vouches for nothing. One rule (charsheet.mjs classVouch, which
  // `bench verify` asks too) for every front end: they pass what was typed
  // (sheetOptions) and nothing else.
  const logUnit = logClass(engine.cat, L);
  const { vouchable, vouched } = classVouch(engine.cat, R, opts.cls, { stated: S.stated !== null });
  const classMismatch = logUnit && logUnit !== R.unit ? { sheet: R.unit, log: logUnit, vouched, vouchable } : null;
  if (classMismatch) {
    problems.push(vouched
      ? `the sheet is a ${R.unit} and the log's character a ${logUnit} - the class given beside the sheet names the sheet's own, `
        + 'which says the log\'s header is the one that is wrong, so the pair is sent all the same'
      : `the sheet is a ${R.unit} and the log's character a ${logUnit} - the sheet should be the build this fight was fought in, `
        + 'and a bundle that pairs the two is not sent');
  }
  const logLevel = L.header?.character?.level;
  if (Number.isInteger(logLevel) && logLevel !== R.level) {
    problems.push(`the sheet is level ${R.level} and the log's character level ${logLevel}`);
  }
  if (!L.perEvent) {
    problems.push('only the fight\'s summary was given: per-skill totals, no per-event rows - the .json.timeline Wink saved beside it '
      + 'carries every hit, and is the evidence a formula can be held to');
  }
  if (s.startedAtEstimated) problems.push('the fight\'s start time is estimated from the file\'s time - its summary (the .json beside the timeline) carries the real one');
  for (const p of L.problems) problems.push(`combat log: ${p}`);
  // A summary given and not packed: the player would think it was sent.
  if (compIn && an.summaryText === null) {
    const which = compIn.named ? `the summary ${compIn.name}` : 'the summary';
    problems.push(L.dialect === 'farever-combat-log'
      ? `${which} is not in the bundle: a Wink summary goes beside a Wink timeline only, and a farever-combat-log header carries what it would give`
      : `${which} is not in the bundle: it was not read as this log's summary - the combat log's report says why`);
  }
  if (R.dropped.length) problems.push(`character sheet: ${R.dropped.length} field(s) dropped on import - the sheet report says which and why`);

  // --- privacy, counted, and where a kept name actually stands: in
  // sheet.json when the sheet had one, in the log's header when the log had
  // one (a summary alone keeps none - it carries no name field at all).
  const keptNameIn = [];
  if (keptSheetName !== null) keptNameIn.push('sheet.json');
  if (keep && an.text !== null && an.handle !== SUBMITTER) keptNameIn.push('combat-log.jsonl');
  if (keptSheetName !== null && keptNameIn.length === 2 && keptSheetName !== an.handle) {
    problems.push('you asked to keep your character\'s name, and the sheet and the log name the character differently - each file keeps '
      + 'its own, so the bundle carries both names');
  }
  const sheetNameGone = str(R.name) && !keep && !an.playerNames.includes(R.name);
  const privacy = {
    namesRemoved: an.namesRemoved + (sheetNameGone ? 1 : 0),
    ownNameKept: keptNameIn.length > 0,
  };

  const manifest = {
    format: SUBMISSION_FORMAT,
    version: SUBMISSION_VERSION,
    id: subId,
    createdAt,
    // The delete token's SHA-256 (of its ASCII text): a request for this
    // bundle's deletion carries the token, and is its sender's when the two
    // agree. The token itself is never in the zip - it is the receipt's.
    deleteTokenSha256: createHash('sha256').update(key, 'ascii').digest('hex'),
    bench: { version: benchVersion(), accepted: acceptedBuild() },
    install,
    sheet: {
      sourceFormat,
      class: R.unit,
      level: R.level,
      rank: R.rank ?? null,
      dropped: R.dropped.map((d) => ({ field: scrub(d.field), id: d.id == null ? null : scrub(String(d.id)), why: scrub(d.why) })),
      notes: R.notes.map(scrub),
      gaps: R.gaps.map(scrub),
      unknownKeys: R.unknownKeys.map(scrub),
    },
    log: {
      sourceDialect: L.dialect,
      withSummary: L.perEvent ? L.companionName != null : true,
      events: s.events,
      damageEvents: s.damageEvents,
      myDamageEvents: s.myDamageEvents,
      perEvent: L.perEvent,
      duration,
      startedAt: s.startedAt ?? null,
      startedAtEstimated: s.startedAtEstimated === true,
      clock,
      encounter: {
        bossKind,
        difficulty: enc.difficulty ?? null,
        activityId,
        targetDummy: enc.targetDummy ?? null,
        partySize,
        outcome: outcomeWord,
      },
      gameVersion,
      solo: s.solo ?? null,
    },
    privacy,
  };
  return { manifest, sheetOut: rs.sheet, names, keptSheetName, keptNameIn, privacy, logUnit, classMismatch };
}

// --- a stated build, held to the fight it is said to have been fought in ----------
// Every skill a weapon grants, and the weapons that grant it - once per catalog.
const weaponSkillsByCat = new WeakMap();
function weaponSkillOwners(cat) {
  let map = weaponSkillsByCat.get(cat);
  if (map) return map;
  map = new Map();
  for (const it of cat.items) {
    if (it.isAugment || !cat.isWeaponType(it.type)) continue;
    for (const s of it.skills ?? []) {
      if (!map.has(s)) map.set(s, []);
      map.get(s).push(it.id);
    }
  }
  weaponSkillsByCat.set(cat, map);
  return map;
}

// What the player is told of a STATED build (the editor's, the CLI's flags)
// before it is sent, as data - statedText words each for the front end that
// says it. One that wears nothing, or no weapon, or none of the weapons whose
// skills the log's character used, is not likely the build the fight was
// fought in: the app opens on an empty Mage and "Send a fight" on it is one
// click, and `bench submit --class Warrior --log <fight>` with no --pin packs
// a character with nothing on. And what it holds that no pin states - what
// the app's Apply to editor put there, which leaves the pins as they were, or
// the rest of a saved build whose import pinned what its run held - goes as
// not recorded: said, so a player who fought in it states it. A file is the
// build its exporter recorded, and is told none of this.
//
//   {kind: 'nothing'} | {kind: 'noWeapon'} | {kind: 'skills', missing, from}
//   | {kind: 'unstated', pieces: slot[], augments: n, talents: bool, runes: n}
//
// (A build of another class than the log's holds none of its weapons: the
// refusal says so, and the skills line would only say it again.)
function statedFindings(engine, S, L, classMismatch) {
  if (!S.stated) return [];
  const { cat } = engine;
  const { loadout } = S.stated;
  const gear = isObj(loadout.gear) ? loadout.gear : {};
  const worn = [];
  for (const g of Object.values(gear)) {
    const item = isObj(g) && str(g.item) ? cat.itemById.get(g.item) : null;
    if (item) worn.push(item);
  }
  if (!worn.length) return [{ kind: 'nothing' }];
  const out = [];
  if (!worn.some((it) => cat.isWeaponType(it.type))) {
    out.push({ kind: 'noWeapon' });
  } else if (!(classMismatch && !classMismatch.vouched) && L.perEvent && L.me != null) {
    // The skills the log's character used: every record of it that names one.
    const used = new Set();
    for (const e of [...(L.initial ?? []), ...(L.events ?? [])]) if (e.source === L.me && str(e.skill)) used.add(e.skill);
    const granted = new Set(worn.flatMap((it) => it.skills ?? []));
    const owners = weaponSkillOwners(cat);
    const missing = [...used].filter((s) => !granted.has(s) && owners.has(s)).sort();
    if (missing.length) out.push({ kind: 'skills', missing, from: [...new Set(missing.flatMap((s) => owners.get(s)))].sort() });
  }
  // Held, and stated by no pin: a piece in a slot no pin holds; augments on
  // a pinned piece none of whose sockets is pinned; the tree; the runes.
  const pins = S.stated.pins;
  if (pins) {
    const set = (v) => new Set(v instanceof Set ? v : Array.isArray(v) ? v : []);
    const gearPins = set(pins.gear);
    const augPins = [...set(pins.augments)].map(String);
    const pieces = Object.keys(gear).filter((s) => isObj(gear[s]) && str(gear[s].item) && !gearPins.has(s));
    const augs = isObj(loadout.augments) ? loadout.augments : {};
    const augments = Object.keys(augs).filter((k) => {
      const slot = k.split('/')[0];
      return str(augs[k]) && gearPins.has(slot) && !augPins.some((a) => a.split('/')[0] === slot);
    }).length;
    const talents = pins.talents !== true
      && Object.values(isObj(loadout.talents) ? loadout.talents : {}).some((r) => Number.isInteger(r) && r > 0);
    const runes = set(pins.runes).size ? 0 : Object.values(isObj(loadout.runes) ? loadout.runes : {}).filter(str).length;
    if (pieces.length || augments || talents || runes) out.push({ kind: 'unstated', pieces, augments, talents, runes });
  }
  return out;
}

// A few ids, and how many more there are.
const fewOf = (ids, n = 3) => (ids.length <= n ? ids.join(', ') : `${ids.slice(0, n).join(', ')} and ${ids.length - n} more`);

// One of statedFindings' items as the front end that says it words it:
// 'app' (the build in the editor; Preview again) or 'cli' (the build as
// typed; --pin, --import).
function statedText(p, front) {
  const cli = front === 'cli';
  const build = cli ? 'the build as typed' : 'the build in the editor';
  const ask = cli
    ? 'is it the build this fight was fought in? --pin what the character wore (bench sheet takes the same flags), or --import its character sheet'
    : 'is it the build this fight was fought in? Put that build in the editor (or choose its character sheet file), then Preview again';
  if (p.kind === 'nothing') return `${build} wears nothing - ${ask}`;
  if (p.kind === 'noWeapon') return `${build} wears no weapon - ${ask}`;
  if (p.kind === 'skills') {
    const one = p.missing.length === 1;
    return `the log's character used ${fewOf(p.missing)} - ${one ? 'a skill' : 'skills'} of ${fewOf(p.from)} - and no weapon `
      + `${build} wears grants ${one ? 'it' : 'them'}: ${ask}`;
  }
  const held = [
    p.pieces.length ? `${p.pieces.length === 1 ? 'a piece' : `${p.pieces.length} pieces`} (${fewOf(p.pieces)})` : null,
    p.augments ? `${p.augments === 1 ? 'an augment' : `${p.augments} augments`} in sockets no pin holds` : null,
    p.talents ? 'its talent points' : null,
    p.runes ? `${p.runes === 1 ? 'a rune' : `${p.runes} runes`}` : null,
  ].filter(Boolean);
  return `${build} holds what no pin states - ${held.join(', ')} - and that goes as not recorded, not as the character's `
    + (cli
      ? '(what a questlog link or a saved build put in it and no flag pinned). --pin, --talent and --rune state what the character wore, '
        + 'or --import its character sheet'
      : '(Apply to editor, and importing a saved build, leave what the search chose unpinned). Set what the character wore yourself in '
        + 'the editor (equip a piece again, change a talent or a rune), or choose the build\'s file as the character sheet, then Preview again');
}

/**
 * Every problem a bundle is told with, as sentences in the words of the
 * front end that says them: what a stated build is told (see statedFindings
 * - first, being the likeliest mistake) and then the bundle's own
 * (sub.problems). reportItems prints these as its Problem lines; the UI
 * answers its preview's `problems` with them.
 *
 * @param opts.front  'app' (the default) or 'cli'
 */
export function problemsOf(sub, { front = 'app' } = {}) {
  const stated = Array.isArray(sub?.statedProblems) ? sub.statedProblems.map((p) => statedText(p, front)) : [];
  return [...stated, ...(Array.isArray(sub?.problems) ? sub.problems : [])];
}

// --- the whole bundle, held to the names once more (fail closed) --------------------
function checkNames(engine, S, P, M) {
  const { R } = S;
  const { an } = P;
  const { manifest, sheetOut, names, keptSheetName } = M;
  const keptHere = (path, v) => path === 'character.name' && keptSheetName !== null && v === keptSheetName;
  leakCheck('manifest.json', manifest, names);
  leakCheck('sheet.json', sheetOut, names, keptHere);
  const summaryValue = an.summaryText !== null ? JSON.parse(an.summaryText) : null;
  if (summaryValue !== null) leakCheck('summary.json', summaryValue, names);
  // The log was searched by anonymizeLog for the fight's own names; the
  // sheet's may be another. A JSON string equal to it is its quoted form.
  if (an.text !== null && str(R.name) && names.has(R.name) && !an.playerNames.includes(R.name)
    && !(keptSheetName !== null && R.name === an.handle)
    && an.text.includes(JSON.stringify(R.name))) {
    throw leaked(R.name, 'combat-log.jsonl', 'a value or a key of one of its lines');
  }
  // ...and every name INSIDE every value, the game's ids and the format's
  // words aside (nameInsideCheck). The kept name stands where it was asked to.
  const ids = gameIds(engine.cdb);
  const words = new Set([...FORMAT_WORDS, ...engine.cat.rarityOrder.keys()]);
  const kept = an.handle !== SUBMITTER ? an.handle : null;
  const files = [
    { name: 'manifest.json', value: manifest },
    { name: 'sheet.json', value: sheetOut },
  ];
  if (an.text !== null) files.push({ name: 'combat-log.jsonl', value: an.text.trim().split('\n').map((l) => JSON.parse(l)) });
  if (summaryValue !== null) files.push({ name: 'summary.json', value: summaryValue });
  nameInsideCheck(files, names, {
    isGameId: (s) => ids.has(s),
    words,
    allowed: (file, where, v) => (file === 'sheet.json' && keptHere(where, v))
      || (file === 'combat-log.jsonl' && kept !== null && v === kept && where === '[0].character.name'),
  });
}

// --- the zip, and its public summary ---------------------------------------------------
function packBundle(engine, {
  S, L: P, M, noteText, when, createdAt, subId, key, expectedSha, rebuilt, answered, sentTo, stated, problems,
}) {
  const { R } = S;
  const { L, an } = P;
  const { manifest, sheetOut, privacy, keptNameIn, logUnit, classMismatch } = M;
  const files = [
    { name: 'manifest.json', data: pretty(manifest) },
    { name: 'sheet.json', data: pretty(sheetOut) },
  ];
  if (an.text !== null) files.push({ name: 'combat-log.jsonl', data: an.text });
  if (an.summaryText !== null) files.push({ name: 'summary.json', data: an.summaryText });
  if (noteText !== null) files.push({ name: 'note.txt', data: `${noteText}\n` });
  const wrong = zipEntryProblem(files.map((f) => f.name));
  if (wrong) throw fail(500, `The bundle came out wrong (${wrong}) - that is the bench's fault; nothing was built.`);
  const zip = zipFiles(files, { date: when });
  if (zip.length > MAX_ZIP_BYTES) {
    throw fail(413, `The bundle is ${fmt(zip.length)} bytes once zipped; Send and GitHub's issue form take at most `
      + `${fmt(MAX_ZIP_BYTES)} (25 MB) - send a shorter fight.`);
  }
  try { readZipDirectory(zip); } catch (e) { throw withStatus(e, 500); }
  const zipSha256 = createHash('sha256').update(zip).digest('hex');
  // A bundle built again under a receipt's id is that bundle or nothing: an
  // id names one bundle, and the folder would otherwise hold two different
  // fights under it - the receipt's, and these files as they are now.
  // (Of a receipt whose fight arrived, sending the same files again is no
  // way out either: nothing is sent under its id again - see sendRefusal.)
  // A bundle is more than the player's files: the manifest names the bench
  // version and this install's game build, so after an update of either the
  // very same files make another bundle. The sentence names both causes, and
  // the way on that always works - never "send the same files".
  if (expectedSha !== null && expectedSha !== zipSha256) {
    throw fail(400, `These files make another bundle than the one submission ${subId.slice(0, 8)} was sent as (SHA-256 `
      + `${zipSha256.slice(0, 12)}... where its receipt says ${expectedSha.slice(0, 12)}...): an id names one bundle, and what went into `
      + 'it has changed since that receipt was written - the files, the note or what was chosen with them, or this install\'s game build '
      + 'or the bench\'s version. '
      + (answered
        ? `That one arrived (${answered.sentAt}), so nothing more goes under its id: send this one as a new submission `
          + '(the old receipt still asks for the first one\'s deletion).'
        : 'Ask for the first one\'s deletion with that receipt - it may have arrived - and send this one as a new submission.'));
  }

  // --- the public summary: what the manual route's title is made of
  const pub = publicManifest(manifest, { zipSha256, zipBytes: zip.length });
  const pp = checkPublicManifest(pub);
  if (pp.length) throw fail(400, `The fight's public summary is not acceptable: ${pp.slice(0, 6).join('; ')}${pp.length > 6 ? ` (and ${pp.length - 6} more)` : ''}.`, pp);

  const sheetItems = sheetReportItems(R);
  const logItems = logReportItems(L);
  return {
    id: subId,
    deleteToken: key,
    createdAt,
    manifest,
    pub,
    zip,
    zipSha256,
    zipBytes: zip.length,
    // What a receipt of this bundle names as its SHA-256: its own - unless it
    // was built again from a receipt that named none, when what the folder
    // holds under that id cannot be told from here.
    receiptSha256: rebuilt && expectedSha === null ? null : zipSha256,
    // A name for the saved file that says nothing about the player: on the
    // manual route it is shown on a public issue.
    zipName: `farever-bench-submission-${subId.slice(0, 8)}.zip`,
    files: files.map((f) => ({ name: f.name, bytes: Buffer.byteLength(f.data, 'utf8') })),
    // The manual route's: the issue form's title, and its address with the
    // title filled in.
    issueTitle: publicTitle(pub),
    formUrl: formUrl(pub),
    sheetReport: sheetItems.map((i) => i.text),
    logReport: logItems.map((i) => i.text),
    sheetItems,
    logItems,
    privacy,
    // The files that carry the character's name, kept as asked: [] unless
    // keepName, and only those whose input had a name to keep.
    keptNameIn,
    // The class the log names its character, as a unit id (null when it
    // names none), and {sheet, log, vouched, vouchable} when that is not the
    // sheet's (manifestOf says when it is vouched for).
    logClass: logUnit,
    classMismatch,
    // When the first send under this id was confirmed ({sentAt}: a
    // receipt's, given as input.sentAt), or null: set, there is nothing left
    // to send.
    answered,
    // The upload link the receipt it was built again from was written for
    // (input.receipt's link, canonical), or null: a send goes there or
    // nowhere.
    sentTo,
    // What a stated build is told, as data (statedFindings); problemsOf
    // words it for the front end that says it, before `problems`.
    statedProblems: stated,
    problems,
  };
}

/**
 * What a bundle does, as {kind, text} items for the CLI and the UI: where it
 * goes - which depends on the route, so on whether this copy has an upload
 * link to Send through - the names removed, the sheet's and the log's
 * reports, and the problems found on the way.
 *
 * With Send, the zip goes to the project's folder on pCloud, where only the
 * maintainer can read it, and nothing is made public. On the manual route
 * (save the .zip, then the GitHub form) the zip is an attachment on a public
 * issue: every file in it is public, the note and the fight's start time to
 * the millisecond included. With no upload link, that is the only route, and
 * the form's title is shown. When there is none because the one set is no
 * upload link (FAREVER_BENCH_UPLOAD_LINK set to something uploadLink()
 * refuses), the report opens on a Problem line with uploadLink()'s sentence,
 * and never says that no link is set.
 *
 * Kinds: 'private' (the Send route's heading), 'title' (the form's title,
 * when the manual route is the only one), 'file' (a file of the zip),
 * 'manual', 'names', 'heading' (above a reader's report), 'sheet:<kind>' and
 * 'log:<kind>' (the readers' own items, indented), 'problem' (problemsOf's,
 * in the front end's words, and the upload link's, first).
 *
 * A line the player is warned of carries `warn: true` - every problem, and
 * the readers' own warned lines as they gave them (charsheet.mjs reportItems,
 * combatlog.mjs logReportItems). That flag is the one table of it: the CLI
 * colours by it and the UI marks by it, and neither keeps a list of kinds.
 *
 * @param opts.link           the upload link, null for none; by default
 *                            uploadLink() (a value it refuses counts as none,
 *                            and its sentence as opts.uploadProblem)
 * @param opts.uploadProblem  with no link, why: the sentence uploadLink()
 *                            refused the link that is set with (null when
 *                            none is set)
 * @param opts.front          who prints it, which decides how sending is
 *                            named: 'app' (the default: "Send", "Save .zip")
 *                            or 'cli' ("--send", "--zip")
 */
export function reportItems(sub, { link = undefined, front = 'app', uploadProblem = null } = {}) {
  let live;
  let problem = str(uploadProblem) ? uploadProblem : null;
  if (link === undefined) {
    try { live = uploadLink() !== null; } catch (e) { live = false; problem ??= String(e?.message ?? e); }
  } else {
    live = str(link);
  }
  const cli = front === 'cli';
  const items = [];
  const out = (kind, text, warn = false) => items.push(warn ? { kind, text, warn: true } : { kind, text });
  const files = () => { for (const f of sub.files ?? []) out('file', `  ${f.name}  ${fmt(f.bytes)} bytes`); };
  const manual = 'the zip is attached to a public issue, so every file in it is public - your note and the fight\'s start time '
    + 'to the millisecond included';
  const send = cli ? '--send' : 'Send';
  const save = cli ? '--zip, then the GitHub form' : 'Save .zip, then the GitHub form';
  if (live) {
    out('private', `What ${send} does: the zip (${fmt(sub.zipBytes)} bytes) goes to the project's folder on pCloud (pcloud.com), `
      + 'where only the project\'s maintainer can read it - nothing is made public -');
    files();
    out('manual', `On the manual route instead (${save}: ${sub.formUrl}), ${manual}.`);
  } else {
    if (problem) {
      // A link is set, and is none: said as what it is, warned of, first.
      out('problem', `Problem: ${send} is off: ${sentence(problem)}`, true);
      out('manual', `${send} is off in this copy of the bench until that link is set right. The route meanwhile is ${save}, `
        + `its title filled in: ${sub.formUrl}`);
    } else {
      out('manual', `${send} is not available in this copy of the bench: no upload link is set. The route is ${save}, `
        + `its title filled in: ${sub.formUrl}`);
    }
    out('title', `  Title: ${sub.issueTitle}`);
    out('manual', `On that route ${manual}: the zip (${fmt(sub.zipBytes)} bytes) -`);
    files();
  }
  const p = sub.privacy ?? {};
  const removed = p.namesRemoved ?? 0;
  const where = (sub.keptNameIn ?? []).map((f) => (f === 'combat-log.jsonl' ? 'the log\'s header' : f));
  out('names', p.ownNameKept && where.length
    ? `Names: ${removed} removed; your character's name is kept in ${where.join(' and ')}, as you asked.`
    : `Names: ${removed} removed; your character is "${SUBMITTER}" wherever a file names it.`);
  const nested = (heading, from, own, kindOf) => {
    const list = Array.isArray(own) ? own : (from ?? []).map((text) => ({ kind: 'line', text }));
    if (!list.length) return;
    out('heading', heading);
    for (const i of list) out(`${kindOf}:${i.kind}`, `  ${i.text}`, i.warn === true);
  };
  nested('The character sheet:', sub.sheetReport, sub.sheetItems, 'sheet');
  nested('The combat log:', sub.logReport, sub.logItems, 'log');
  for (const pr of problemsOf(sub, { front })) out('problem', `Problem: ${sentence(pr)}`, true);
  return items;
}

/** reportItems as plain text, one line each. */
export function reportLines(sub, opts = {}) {
  return reportItems(sub, opts).map((i) => i.text);
}

// =============================================================================
// Sending, asking for a deletion, and the receipt
// =============================================================================

// The one place the bench reaches the network: one file uploaded through the
// upload link (pCloud's uploadtolink), the zip or a request for a deletion,
// and its answer read - {status, said}, said being the answer's JSON or null.
// pCloud is given the file and its name, the link's code and the uploader
// name the bench always gives (UPLOADER_NAME), and nothing else: no header
// of the bench's own, never the delete token beside the file. nopartial=1
// has it keep nothing of an upload that breaks off. A redirect is refused
// rather than followed: it would carry the file to an address nobody chose.
// The timeout covers the answer's body as well; a body that stops arriving
// throws, and is said as pCloud not answering.
async function uploadCall(fetchImpl, link, file, timeoutMs) {
  const { api, code } = parseUploadLink(link);
  const url = `${api}/uploadtolink?code=${encodeURIComponent(code)}&names=${encodeURIComponent(UPLOADER_NAME)}&nopartial=1`;
  const body = new FormData();
  body.append('file', new Blob([file.data], { type: file.type }), file.name);
  const fetch = fetchImpl;
  const res = await fetch(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let said = null;
  try { said = JSON.parse(text); } catch { said = null; }
  return { status: res.status, said };
}

// Why a request never got an answer, in a few words.
function unreached(e, timeoutMs) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
  }
  const code = e?.cause?.code ?? e?.code;
  return `could not be reached${code ? ` (${code})` : e?.message ? ` (${String(e.message).slice(0, 120)})` : ''}`;
}

// pCloud's own sentence, as shown to the player: one line, no control
// characters, not a page of text.
function cleanSaid(v) {
  return String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 600);
}

// What pCloud's answer says. Its API answers every call with JSON whose
// `result` is 0 when it did what was asked, and otherwise a number and an
// `error` sentence - with HTTP 200 either way, so the status says nothing.
// 'kept': the file is in the folder. 'refused': it is not, and with
// nopartial=1 nothing of it was kept. 'odd': no such JSON at all (a proxy's
// page, a body cut short), which says nothing of whether the file arrived.
function pcloudSaid({ said }) {
  if (!isObj(said) || !Number.isInteger(said.result)) return { kind: 'odd' };
  if (said.result === 0) return { kind: 'kept' };
  return { kind: 'refused', result: said.result, error: str(said.error) ? cleanSaid(said.error) : null };
}

// pCloud's refusal as the player is told it: the status a caller exits on
// or answers with, and one sentence with pCloud's own words in brackets.
// `asking` words it for a request for a deletion. The codes are those
// pCloud documents for uploadtolink, and 2012, which it answers a code it
// does not know (another region's, or a link that never was) with.
function refusedBy(r, { form = null, asking = false }) {
  const p = `pCloud: ${r.error ?? `result ${r.result}`}`;
  const none = asking ? 'nothing was asked' : 'nothing was kept';
  const manual = `save the .zip and attach it to a new issue: ${form}`;
  let status;
  let text;
  if (r.result === 7002 || r.result === 7004) {
    status = 503;
    text = `The project's upload link is closed (${p}) - ${asking ? 'nothing was asked.' : `nothing was sent; ${manual}`}`;
  } else if (r.result === 2012) {
    status = 503;
    text = `pCloud does not know this copy's upload link (${p}) - ${asking ? 'nothing was asked.' : `nothing was sent; ${manual}`}`;
  } else if (r.result === 7007 || r.result === 7008) {
    status = 507;
    text = `The project's pCloud folder is full (${p}) - ${none}; try again another day${asking ? '.' : `, or ${manual}`}`;
  } else if (r.result === 4000) {
    status = 429;
    text = `pCloud turns this address away for now (${p}) - ${none}; try again later.`;
  } else if (r.result === 2041 || r.result === 5000 || r.result === 5001) {
    status = 502;
    text = `pCloud could not store the ${asking ? 'request' : 'zip'} (${p}) - ${none}; ${asking ? 'ask' : 'send it'} again later.`;
  } else {
    status = 502;
    text = `pCloud refused the upload (result ${r.result}${r.error ? `: ${r.error}` : ''}) - ${none}.`;
  }
  const e = fail(status, text);
  e.arrived = false;
  return e;
}

function checkSub(sub) {
  if (!isObj(sub) || !ID_RE.test(sub.id ?? '') || !TOKEN_RE.test(sub.deleteToken ?? '') || !Buffer.isBuffer(sub.zip) || !isObj(sub.pub)) {
    throw fail(400, 'That is not a bundle buildSubmission made - build it again.');
  }
}
// The link a call was given, canonical: undefined asks uploadLink(), null is
// none.
function linkFor(link) {
  return link === undefined ? uploadLink() : link === null ? null : parseUploadLink(link).link;
}
const isTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Why a bundle is not sent, as a SubmissionError (400), or null when nothing
 * stands in its way. The CLI and the UI ask this and nothing else, and say
 * its sentence as it is; `front` only decides how the remedy is named. Three
 * rules, in this order:
 *
 *   ANSWERED (sub.answered, from buildSubmission's input.sentAt or receipt):
 *   the bundle was built again from a receipt whose send pCloud confirmed.
 *   pCloud keeps every upload - a second one under a name it holds is
 *   renamed beside the first - so sending it again would only store a
 *   second copy; a changed bundle goes as a new submission. Saving it
 *   (--zip, Save .zip) is not refused. The error carries `answered`
 *   ({sentAt}).
 *
 *   ANOTHER LINK (sub.sentTo, from buildSubmission's input.receipt): the
 *   bundle was built again from a receipt written for another upload link
 *   than the one this copy sends through (opts.link), or this copy has none.
 *   A bundle is sent again where it may already be - sent elsewhere, one
 *   fight would be kept twice, and a request for its deletion would go to
 *   the wrong folder - so it is sent there or not at all. Saving it is not
 *   refused either. The error carries `sentTo`, and its remedy is the one
 *   sentence that prints a link: the environment that sends it there.
 *
 *   ANOTHER CLASS (sub.classMismatch): a sheet of one class with a log whose
 *   character is another. Sent, it becomes the project's evidence for the
 *   wrong build - `bench verify` refuses the same pair. Unless the bundle was
 *   vouched for (classMismatch.vouched): the file names its own class and the
 *   class given beside it (buildSubmission's sheetOptions.cls: --class on the
 *   command line, the class choice beside the file in the app) names the
 *   same, which says the log's header is the one that is wrong, as verify
 *   takes it. That is decided when the bundle is built, from what was given,
 *   and nowhere else: a caller has no say here, so no front end can vouch for
 *   a modkit dump with the very class it was read as. The error carries
 *   `classMismatch`.
 *
 * sendSubmission asks this first; a caller may ask it earlier, before
 * anything is written.
 *
 * @param opts.front  who says it, which decides how the remedy is named:
 *                    'app' (the default: the class choice beside the file,
 *                    the editor, preview without the receipt, Delete) or
 *                    'cli' (--class, --import, --receipt, --delete)
 * @param opts.link   the upload link this copy would send through, null for
 *                    none; by default uploadLink() (a value it refuses counts
 *                    as none)
 */
export function sendRefusal(sub, { front = 'app', link = undefined } = {}) {
  if (!isObj(sub)) return null;
  const cli = front === 'cli';
  const from = `The receipt this bundle is built again from${cli ? ' (--receipt)' : ''} is of submission ${String(sub.id).slice(0, 8)}`;
  const a = isObj(sub.answered) ? sub.answered : null;
  if (a) {
    const e = fail(400, `${from}, whose fight arrived (${a.sentAt}): sending it again would only store a second copy beside the first. `
      + 'A changed bundle goes as a new submission - '
      + (cli ? 'leave --receipt out - and bench submit --delete <that receipt> asks for the first one\'s deletion.'
        : 'preview it without the receipt - and Delete, with that receipt, asks for the first one\'s deletion.'));
    e.answered = { sentAt: a.sentAt };
    return e;
  }
  if (str(sub.sentTo)) {
    let here = null;
    if (link === undefined) {
      try { here = uploadLink(); } catch { here = null; }
    } else if (str(link)) {
      try { here = parseUploadLink(link).link; } catch { here = link; }
    }
    if (here !== sub.sentTo) {
      const e = fail(400, `${from}, written for ${here ? 'another upload link than this copy\'s' : 'an upload link, and this copy has none'}: `
        + 'a bundle is sent again where it may already be, or not at all - sent elsewhere, the fight would be kept twice, and a request '
        + 'for its deletion would go to the wrong folder. '
        + (cli
          ? `The same command run with FAREVER_BENCH_UPLOAD_LINK=${sub.sentTo} sends it there.`
          : `The bench started with FAREVER_BENCH_UPLOAD_LINK=${sub.sentTo} sends it there; Save .zip keeps this copy of it meanwhile.`));
      e.sentTo = sub.sentTo;
      return e;
    }
  }
  const m = sub.classMismatch;
  if (!isObj(m) || m.vouched === true) return null;
  const dump = sub.manifest?.sheet?.sourceFormat === 'modkit-inventory';
  let remedy = cli
    ? `Give the build the fight was fought in: --import <the ${m.log}'s sheet>, or --class ${m.log} with its pins.`
    : `Give the build the fight was fought in - the ${m.log}'s sheet, or that build in the editor.`;
  if (dump) {
    remedy += ` A modkit dump names no class, so the class ${cli ? `given for it (--class ${m.sheet})` : 'chosen for it'} is the sheet's `
      + 'only word on it, and cannot say the log is the one that is wrong.';
  } else if (m.vouchable === true) {
    remedy += cli
      ? ` If the log's header is the one that is wrong, --class ${m.sheet} beside the sheet says so, and it is sent.`
      : ` If the log's header is the one that is wrong, choosing ${m.sheet} as the class beside the sheet file says so, and it is sent.`;
  }
  const e = fail(400, `The sheet is a ${m.sheet} and the fight's log names its character a ${m.log}, so it is not sent: the bundle would hold `
    + `a ${m.log}'s fight against a ${m.sheet}'s build as the project's evidence. ${remedy}`);
  e.classMismatch = { ...m };
  return e;
}

// THE RECEIPT. What asks for a sent fight's deletion is its id and its delete
// token (the bundle's manifest holds the token's SHA-256), uploaded through
// the link the fight went through. So a receipt exists from BEFORE the send:
// pendingReceipt is what a caller saves first (sentAt null), and replaces
// with sendSubmission's on pCloud's answer. A send whose answer is lost - a
// timeout, a dropped connection - may still have put the fight in the
// folder, and the pending receipt is then the only way the player has to ask
// for its deletion. It also carries the bundle's time and its SHA-256, so a
// bundle built again from the same files with the receipt's id, key,
// createdAt and zipSha256 (buildSubmission's id, deleteToken, now and
// zipSha256) is the same bundle, byte for byte - or is refused, as it is
// once the game or the bench was updated in between - and sent
// again after a lost answer it puts at most an identical copy beside the
// first, under the same id, which the maintainer drops. Its sentAt goes in
// too (buildSubmission's sentAt): a receipt that has one is of a fight that
// arrived, and sendRefusal sends nothing more under its id. And its link:
// given whole (buildSubmission's receipt), a bundle built again from it is
// sent through that link or not at all (sendRefusal again).

/**
 * The receipt to save before sending: { id, deleteToken, link, sentAt: null,
 * createdAt, zipSha256 }. It asks for the deletion of whatever the send
 * leaves behind, and names the bundle so it can be sent again as itself.
 * zipSha256 is the bundle's (sub.receiptSha256): null only for a bundle built
 * again under an old receipt that named none.
 *
 * @param opts.link  the upload link; default uploadLink()
 * @throws SubmissionError: 400 for what is not a bundle, 503 with no link
 */
export function pendingReceipt(sub, { link = undefined } = {}) {
  checkSub(sub);
  const here = linkFor(link);
  if (!here) {
    throw fail(503, `Send is off in this copy of the bench (no upload link is set) - save the .zip and attach it to a new issue: ${sub.formUrl ?? formUrl(sub.pub)}`);
  }
  const sha = sub.receiptSha256 === undefined ? sub.zipSha256 : sub.receiptSha256;
  return {
    id: sub.id, deleteToken: sub.deleteToken, link: here, sentAt: null, createdAt: isTime(sub.createdAt) ? sub.createdAt : null,
    zipSha256: typeof sha === 'string' && SHA256_RE.test(sha) ? sha : null,
  };
}

/**
 * Send a bundle: upload its zip to the project's folder on pCloud as
 * <id>.zip - POST <api>/uploadtolink?code=<code>&names=farever-bench
 * &nopartial=1, one multipart file part and nothing more (uploadCall).
 * pCloud answers {result: 0}, and nothing else, when it kept the file. Save
 * pendingReceipt(sub) before calling this.
 *
 * pCloud keeps every upload: a second one under a name it holds is renamed
 * beside the first. A bundle sent again after a lost answer is the same id
 * and the same bytes, so the folder holds at most an identical copy, which
 * the maintainer drops (tools/inbox.mjs finds it).
 *
 * @param opts.link          the upload link; default uploadLink()
 * @param opts.fetchImpl     fetch, for a test to stand in
 * @param opts.timeoutMs     how long to wait for pCloud's answer (SEND_TIMEOUT_MS)
 * @param opts.benchVersion  when given, must be the version that built the bundle
 * @param opts.front         how a sentence names the remedy ('app', 'cli')
 * @returns {Promise<{id, deleteToken, link, sentAt, createdAt, zipSha256, uploadedAs}>}
 *   the pending receipt completed - sentAt is when pCloud answered - and
 *   uploadedAs, the name the zip went under, which is no field of a receipt
 * @throws SubmissionError: sendRefusal's (400) before anything leaves; 503
 *   with no link; 502 when pCloud cannot be reached, does not answer in
 *   time, or answers other than as its API does - each of those carries
 *   `.receipt`, the pending receipt, since nothing here can tell that the
 *   fight did not arrive. A refusal from pCloud (a result other than 0)
 *   says nothing was kept: it carries `arrived: false` and no receipt, with
 *   503 (the link closed, or unknown to pCloud), 507 (the folder full), 429
 *   (this address turned away) or 502 (anything else).
 */
export async function sendSubmission(sub, {
  link = undefined, fetchImpl = globalThis.fetch, timeoutMs = SEND_TIMEOUT_MS, benchVersion: version = null, front = 'app',
} = {}) {
  checkSub(sub);
  const here = linkFor(link);
  const refused = sendRefusal(sub, { front, link: here });
  if (refused) throw refused;
  const form = sub.formUrl ?? formUrl(sub.pub);
  if (!here) throw fail(503, `Send is off in this copy of the bench (no upload link is set) - save the .zip and attach it to a new issue: ${form}`);
  if (version != null && version !== sub.pub.bench?.version) {
    throw fail(400, `This bundle was built by farever-bench ${sub.pub.bench?.version} and this is ${version} - build it again before sending.`);
  }
  if (typeof fetchImpl !== 'function') throw fail(502, 'This Node has no fetch, so nothing can be sent from it - save the .zip and attach it to a new issue instead.');
  const pending = pendingReceipt(sub, { link: here });
  const mayHaveArrived = (status, message) => {
    const e = fail(status, message);
    e.receipt = pending;
    return e;
  };
  const keep = front === 'cli'
    ? 'Keep this bundle\'s receipt: sending the same bundle again (--receipt <file>) stores at most a duplicate the maintainer drops, '
      + `and bench submit --delete <file> asks for the fight's deletion if it did arrive. Or save the .zip (--zip <file>) and attach it to a new issue instead: ${form}`
    : 'Keep this bundle\'s receipt: sending the same bundle again stores at most a duplicate the maintainer drops, and Delete with it '
      + `asks for the fight's deletion if it did arrive. Or save the .zip and attach it to a new issue instead: ${form}`;
  const uploadedAs = `${sub.id}.zip`;
  let answer;
  try {
    answer = await uploadCall(fetchImpl, here, { data: sub.zip, type: 'application/zip', name: uploadedAs }, timeoutMs);
  } catch (e) {
    throw mayHaveArrived(502, `The upload to the project's pCloud folder ${unreached(e, timeoutMs)} - the fight may or may not have arrived. ${keep}`);
  }
  const said = pcloudSaid(answer);
  if (said.kind === 'refused') throw refusedBy(said, { form });
  if (said.kind === 'odd') {
    throw mayHaveArrived(502, `pCloud answered ${answer.status} but not as its API does - whether the fight arrived cannot be told from here. ${keep}`);
  }
  return { ...pending, sentAt: new Date().toISOString(), uploadedAs };
}

// A receipt, checked; returned as its six fields and nothing else. A pending
// one (sentAt null) is a receipt: asking for a deletion needs no answer. One
// written before receipts named their bundle's SHA-256 reads with zipSha256
// null. Its link is read as an upload link is, and carried canonical.
function checkReceipt(r) {
  const bad = (why) => fail(400, `That is not a receipt of a sent fight: ${why}.`);
  if (!isObj(r)) throw bad('it is not an object');
  if (r.format !== undefined && r.format !== RECEIPT_FORMAT) throw bad(`its format is ${JSON.stringify(r.format)}, not "${RECEIPT_FORMAT}"`);
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw bad('its id is not 32 lowercase hex characters');
  if (typeof r.deleteToken !== 'string' || !TOKEN_RE.test(r.deleteToken)) throw bad('its deleteToken is not 32 lowercase hex characters');
  if (!str(r.link)) throw bad('it names no upload link');
  const read = readLink(r.link);
  if (read.why) throw bad(`its link ${read.why}`);
  if (r.zipSha256 != null && (typeof r.zipSha256 !== 'string' || !SHA256_RE.test(r.zipSha256))) throw bad('its zipSha256 is not 64 lowercase hex characters');
  return {
    id: r.id, deleteToken: r.deleteToken, link: read.link, sentAt: isTime(r.sentAt) ? r.sentAt : null,
    createdAt: isTime(r.createdAt) ? r.createdAt : null, zipSha256: r.zipSha256 ?? null,
  };
}

/**
 * Ask for a sent fight's deletion: upload <id>.withdraw.json - the receipt's
 * id and delete token, as WITHDRAWAL_FORMAT - to the project's pCloud folder,
 * through the link the fight went through (uploadCall). An uploader can
 * delete nothing behind the link: the maintainer deletes the zips of that id
 * and the request when the token's SHA-256 is the deleteTokenSha256 of the
 * zip's manifest.json, when they next read the folder (tools/inbox.mjs).
 * Asking twice is harmless. A pending receipt (sentAt null) asks the same;
 * if its send never arrived, the request deletes nothing.
 *
 * Asked only through this copy's own upload link: a receipt written for
 * another is refused (400, carrying `sentTo`), with the way to ask there.
 *
 * @param opts.link       this copy's upload link; default uploadLink()
 * @param opts.fetchImpl  fetch, for a test to stand in
 * @param opts.timeoutMs  how long to wait for pCloud's answer (90 s)
 * @returns {Promise<{ok: true, status: 200, id, requested: true}>}
 * @throws SubmissionError: 400 for a receipt that is none, or is of another
 *   link; 503 with no link; 502 when pCloud cannot be reached or answers
 *   other than as its API does; a refusal from pCloud as sendSubmission
 *   says one ("nothing was asked", `arrived: false`)
 */
export async function deleteSubmission(receipt, { link = undefined, fetchImpl = globalThis.fetch, timeoutMs = 90_000 } = {}) {
  const r = checkReceipt(receipt);
  const here = linkFor(link);
  if (!here) {
    throw fail(503, 'Send is off in this copy of the bench (no upload link is set), so no deletion can be asked from it - '
      + 'run it without FAREVER_BENCH_UPLOAD_LINK=none (or off) to ask through the project\'s pCloud folder.');
  }
  if (r.link !== here) {
    const e = fail(400, `This receipt is of submission ${r.id.slice(0, 8)}, sent to another upload link than this copy's: a deletion is `
      + `asked only through this copy's own link. If you sent that fight yourself through that link, FAREVER_BENCH_UPLOAD_LINK=${r.link} asks there.`);
    e.sentTo = r.link;
    throw e;
  }
  if (typeof fetchImpl !== 'function') throw fail(502, 'This Node has no fetch, so no deletion can be asked from it.');
  const request = pretty({
    format: WITHDRAWAL_FORMAT,
    version: 1,
    about: `The sender of submission ${r.id} asks for it to be deleted. The SHA-256 of deleteToken is the deleteTokenSha256 in that `
      + 'submission\'s manifest.json.',
    id: r.id,
    deleteToken: r.deleteToken,
    zipSha256: r.zipSha256,
    requestedAt: new Date().toISOString(),
  });
  const again = 'asking again with the same receipt is harmless (the maintainer reads one request per id).';
  let answer;
  try {
    answer = await uploadCall(fetchImpl, here, { data: request, type: 'application/json', name: `${r.id}.withdraw.json` }, timeoutMs);
  } catch (e) {
    throw fail(502, `The upload to the project's pCloud folder ${unreached(e, timeoutMs)} - the request may or may not have arrived; ${again}`);
  }
  const said = pcloudSaid(answer);
  if (said.kind === 'refused') throw refusedBy(said, { asking: true });
  if (said.kind === 'odd') {
    throw fail(502, `pCloud answered ${answer.status} but not as its API does - whether the request arrived cannot be told from here; ${again}`);
  }
  return { ok: true, status: 200, id: r.id, requested: true };
}

/**
 * The receipt as the file a player keeps: pretty JSON, marked as a receipt,
 * with a sentence saying what its token does - and, for a pending one, that
 * the send's answer was not known when it was written.
 */
export function receiptText(receipt) {
  const r = checkReceipt(receipt);
  const how = 'The deleteToken below asks for its deletion: bench submit --delete <this file>, or "Delete a submission I sent\u2026" in '
    + 'the app; the maintainer deletes it when they next read the folder. Anyone holding this file can ask that, and do nothing else with it.';
  return pretty({
    format: RECEIPT_FORMAT,
    version: 1,
    about: r.sentAt
      ? `A fight you sent to farever-bench's folder on pCloud. ${how}`
      : `A fight you were sending to farever-bench, saved before pCloud answered: it may or may not have arrived. ${how} `
        + 'If it never arrived, the request deletes nothing.',
    id: r.id,
    deleteToken: r.deleteToken,
    link: r.link,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
    zipSha256: r.zipSha256,
  });
}

/**
 * A receipt read back from the text receiptText wrote (or from the object it
 * parses to): { id, deleteToken, link, sentAt, createdAt, zipSha256 }. Throws
 * SubmissionError (400) for anything that is not one - a receipt that names
 * no upload link among them. Build a bundle again from it with
 * buildSubmission's `receipt` (which also holds the send to the link it
 * names), or with its id, deleteToken, now, zipSha256 and sentAt set to the
 * receipt's id, deleteToken, createdAt, zipSha256 and sentAt.
 */
export function parseReceipt(text) {
  let obj = text;
  if (typeof text === 'string' || Buffer.isBuffer(text) || text instanceof Uint8Array) {
    const s = typeof text === 'string' ? text : Buffer.from(text).toString('utf8');
    try {
      obj = JSON.parse(s.replace(/^\uFEFF/, ''));
    } catch {
      throw fail(400, 'That is not a receipt of a sent fight: it is not JSON.');
    }
  }
  return checkReceipt(obj);
}
