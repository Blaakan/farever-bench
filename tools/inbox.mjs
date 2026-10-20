#!/usr/bin/env node
// ---------------------------------------------------------------------------
// inbox.mjs - what is in the project's pCloud folder, and what to do with
// each file in it.
//
//   node tools/inbox.mjs <folder> [--json]
//
// Send uploads a player's fight to the project's folder on pCloud as
// <id>.zip, and "Delete a submission I sent" uploads <id>.withdraw.json
// beside it (src/submit.mjs). An uploader can put files there and do nothing
// else, so the folder is the maintainer's to read and to tidy. This reads a
// local copy of it - pCloud Drive's view of the folder, or a downloaded copy
// - with every folder under it, and says, id by id:
//
//   keep    the zip to keep
//   drop    a copy of it: the same SHA-256 under the same id - a send made
//           again after its answer was lost (pCloud renames the second
//           upload of a name, "<id> (1).zip")
//   look    a zip whose id another zip with another SHA-256 names too: two
//           different bundles claim one id - keep both, and look (the zips
//           of the id whose deletion was asked for count among them); and a
//           request that cannot be settled yet, because a zip of its id, or
//           a folder or a file, could not be read - keep it until it is
//   delete  a zip whose sender asked for its deletion (a request whose
//           token's SHA-256 is the deleteTokenSha256 in the zip's
//           manifest.json), and every request once read - one that matches
//           deletes its zips, one that matches nothing is ignored, and one
//           with no zip of its id asks for a fight that never arrived
//   other   a file that is not a submission (a test upload, a stray)
//
// It changes nothing: it reads, and prints; deleting is the maintainer's,
// in pCloud. It makes no network call - the folder is read from disk. Exit
// 0 with the report; 1 for a folder that cannot be read. --json prints one
// object instead (format 'farever-bench-inbox').
//
// EVERY FILE IS DATA. The folder holds what someone else's program wrote:
// the bench, or anything that can reach the link - and its code ships in
// every copy of the bench. Nothing in it is run or followed. A zip is read
// no further than the bench's own reader takes it (submit.mjs readZip, after
// the directory alone has been held to the fixed entry set and a size); a
// value of a manifest is printed only through the public manifest's check,
// which holds each to a shape; a file name is printed with its control and
// direction characters replaced; a request's token is compared by its
// SHA-256 and never printed.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readZip, WITHDRAWAL_FORMAT } from '../src/submit.mjs';
import {
  SUBMISSION_FORMAT, ID_RE, TOKEN_RE, MAX_ZIP_BYTES, MAX_ENTRY_BYTES, readZipDirectory, zipEntryProblem,
  publicManifest, checkPublicManifest, issueTitle, issueRows,
} from '../src/submission-public.mjs';

const USAGE = 'node tools/inbox.mjs <folder> [--json] - reads a local copy of the project\'s pCloud folder and says what to keep, drop and delete';
// A request for a deletion is a few hundred bytes; a .json past this is
// something else, and is not read.
const MAX_REQUEST_BYTES = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const asJson = argv.includes('--json');
const loose = argv.filter((a) => a !== '--json');
if (loose.length !== 1 || loose[0].startsWith('-')) {
  console.error(loose.find((a) => a.startsWith('-')) ? `unknown flag ${loose.find((a) => a.startsWith('-'))} - ${USAGE}` : USAGE);
  process.exit(1);
}
const folder = loose[0];
let isFolder = false;
try { isFolder = statSync(folder).isDirectory(); } catch { isFolder = false; }
if (!isFolder) {
  console.error(`${folder} is not a folder - ${USAGE}`);
  process.exit(1);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (data, enc) => createHash('sha256').update(data, enc).digest('hex');
const fmt = (n) => Number(n).toLocaleString('en-US');
// A path as printed: relative to the folder, with / between its parts, and
// every control or direction character (a name can carry a terminal escape,
// or turn its own text around) shown as '?': Unicode's controls (Cc) and
// direction controls (Bidi_Control, U+061C among them), the zero-width
// space, non-joiner and joiner, the line and paragraph separators and the
// byte order mark.
const HIDDEN = /[\p{Cc}\p{Bidi_Control}\u200b-\u200d\u2028\u2029\ufeff]/u;
const shown = (s) => [...String(s)].map((c) => (HIDDEN.test(c) ? '?' : c)).join('');
const rel = (at) => shown(relative(folder, at).split(/[\\/]/).join('/'));

const zips = [];
const requests = [];
const other = [];
// A sentence about a file may quote a name from inside it (a zip's entry):
// it is shown the way a path is.
const notOne = (at, why) => { other.push({ path: rel(at), why: shown(why) }); };

// What could not be settled from what was read. A request for a deletion
// is the player's only proof of it, so it is never said to be deleted while
// a zip of its id may be here unread: `unread` holds the id of every .zip
// that could not be read or was no bundle - from its name (pCloud's
// "<id>.zip", "<id> (1).zip") and from its manifest.json when that was read
// - and `blind` counts what was not read at all: a folder that would not
// open, a link not followed, a file whose bytes could not be read.
const unread = new Set();
let blind = 0;
const NAMED_ID = /^([0-9a-f]{32})/i;

// --- every file, from the folder down ---------------------------------------
const files = [];
let passed = 0;   // what is neither a file nor a folder read: a link, a folder that would not open
const walk = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (dir === folder) {
      console.error(`${folder} could not be read (${e.code ?? e.message})`);
      process.exit(1);
    }
    notOne(dir, `a folder that could not be read (${e.code ?? e.message})`);
    passed++;
    blind++;
    return;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const at = join(dir, e.name);
    if (e.isSymbolicLink()) {
      notOne(at, 'a link, which is not followed');
      passed++;
      blind++;
    } else if (e.isDirectory()) {
      walk(at);
    } else if (e.isFile()) {
      files.push(at);
    } else {
      notOne(at, 'neither a file nor a folder');
      passed++;
    }
  }
};
walk(folder);

// --- a zip: a submission, or not one -----------------------------------------
function readBundle(at) {
  // A zip that is not read as a bundle: listed with why, and the id its
  // name, or its manifest when that was read, gives it kept in `unread`.
  const named = NAMED_ID.exec(basename(at))?.[1]?.toLowerCase() ?? null;
  const notRead = (why, id = null) => {
    notOne(at, why);
    if (named) unread.add(named);
    if (typeof id === 'string' && ID_RE.test(id)) unread.add(id);
  };
  let size;
  try { size = statSync(at).size; } catch (e) { blind++; notRead(`could not be read (${e.code ?? e.message})`); return; }
  if (size > MAX_ZIP_BYTES) { notRead(`a zip of ${fmt(size)} bytes, more than any bundle (${fmt(MAX_ZIP_BYTES)})`); return; }
  let bytes;
  try { bytes = readFileSync(at); } catch (e) { blind++; notRead(`could not be read (${e.code ?? e.message})`); return; }
  // The directory first, inflating nothing: the fixed entries, and what they
  // say they hold - a bundle's log is at most 20 MB.
  let dir;
  try {
    dir = readZipDirectory(bytes);
  } catch (e) {
    notRead(String(e?.message ?? e).replace(/^The zip is /, 'a .zip that is ').replace(/\.$/, ''));
    return;
  }
  const wrong = zipEntryProblem(dir.map((d) => d.name));
  if (wrong) { notRead(`a zip, and no bundle: ${wrong}`); return; }
  const declared = dir.reduce((a, d) => a + d.size, 0);
  if (declared > MAX_ENTRY_BYTES) { notRead(`a zip whose entries say they hold ${fmt(declared)} bytes, more than any bundle`); return; }
  let manifest;
  try {
    const entry = readZip(bytes).find((e) => e.name === 'manifest.json');
    manifest = JSON.parse(entry.data.toString('utf8'));
  } catch (e) {
    notRead(`a zip whose manifest.json could not be read (${String(e?.message ?? e).slice(0, 160)})`);
    return;
  }
  const said = isObj(manifest) ? manifest.id : null;
  if (!isObj(manifest) || manifest.format !== SUBMISSION_FORMAT) { notRead(`a zip whose manifest.json is no "${SUBMISSION_FORMAT}"`, said); return; }
  if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) { notRead('a zip whose manifest.json names no submission id'); return; }
  const zipSha256 = sha256(bytes);
  // Every value said of it goes through the public manifest's check: one
  // that does not pass it was not made by the bench, and is said so.
  const pub = publicManifest(manifest, { zipSha256, zipBytes: bytes.length });
  const problems = checkPublicManifest(pub);
  if (problems.length) {
    notRead(`a zip naming submission ${manifest.id}, whose manifest.json the bench would not have written: ${problems.slice(0, 3).join('; ')}`
      + `${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`, manifest.id);
    return;
  }
  const enc = pub.log.encounter;
  zips.push({
    path: rel(at),
    name: basename(at),
    id: manifest.id,
    bytes: bytes.length,
    sha256: zipSha256,
    createdAt: typeof manifest.createdAt === 'string' && TIME_RE.test(manifest.createdAt) ? manifest.createdAt : null,
    benchVersion: pub.bench.version,
    class: pub.sheet.class,
    level: pub.sheet.level,
    encounter: { bossKind: enc.bossKind, difficulty: enc.difficulty, outcome: enc.outcome, targetDummy: enc.targetDummy },
    deleteTokenSha256: typeof manifest.deleteTokenSha256 === 'string' && SHA256_RE.test(manifest.deleteTokenSha256) ? manifest.deleteTokenSha256 : null,
    title: issueTitle(pub),
    rows: issueRows(pub).map(([k, v]) => [k, v.replace(/`/g, '')]),
  });
}

// --- a .json: a request for a deletion, or not one ---------------------------
function readRequest(at) {
  let size;
  try { size = statSync(at).size; } catch (e) { blind++; notOne(at, `could not be read (${e.code ?? e.message})`); return; }
  if (size > MAX_REQUEST_BYTES) { notOne(at, `a .json of ${fmt(size)} bytes, more than any request for a deletion`); return; }
  let text;
  try { text = readFileSync(at, 'utf8'); } catch (e) { blind++; notOne(at, `could not be read (${e.code ?? e.message})`); return; }
  let obj;
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    obj = JSON.parse(text);
  } catch {
    notOne(at, 'a .json that is not JSON');
    return;
  }
  if (!isObj(obj) || obj.format !== WITHDRAWAL_FORMAT) { notOne(at, `a .json that is no request for a deletion (its format is not "${WITHDRAWAL_FORMAT}")`); return; }
  if (typeof obj.id !== 'string' || !ID_RE.test(obj.id) || typeof obj.deleteToken !== 'string' || !TOKEN_RE.test(obj.deleteToken)) {
    notOne(at, 'a request for a deletion with no id or no delete token of the shape the bench writes (32 lowercase hex)');
    return;
  }
  requests.push({
    path: rel(at),
    id: obj.id,
    // The token's SHA-256, as the manifest carries it: the token itself is
    // not kept here, and never printed.
    tokenSha256: sha256(obj.deleteToken, 'ascii'),
    requestedAt: typeof obj.requestedAt === 'string' && TIME_RE.test(obj.requestedAt) ? obj.requestedAt : null,
    zipSha256: typeof obj.zipSha256 === 'string' && SHA256_RE.test(obj.zipSha256) ? obj.zipSha256 : null,
  });
}

for (const at of files) {
  const lower = basename(at).toLowerCase();
  if (lower.endsWith('.zip')) readBundle(at);
  else if (lower.endsWith('.json')) readRequest(at);
  else notOne(at, 'neither a zip nor a request for a deletion (.json)');
}

// --- what to do, id by id ----------------------------------------------------
const byId = new Map();
const of = (id) => {
  if (!byId.has(id)) byId.set(id, { id, zips: [], requests: [] });
  return byId.get(id);
};
for (const z of zips) of(z.id).zips.push(z);
for (const q of requests) of(q.id).requests.push(q);

const submissions = [];
for (const id of [...byId.keys()].sort()) {
  const g = byId.get(id);
  const withdrawn = new Map();
  // A request is settled only on what was read: while a zip of its id, or
  // anything at all, could not be read, the zip it asks about may be the one
  // unread - it is kept, and looked at, whatever else it says.
  const unsure = unread.has(id) || blind > 0;
  const keepIt = 'a zip of this id, or a folder, could not be read - keep the request until it is';
  for (const q of g.requests) {
    const hits = g.zips.filter((z) => z.deleteTokenSha256 !== null && z.deleteTokenSha256 === q.tokenSha256);
    q.action = unsure ? 'look' : 'delete';
    q.matches = hits.map((z) => z.path);
    if (!g.zips.length) {
      q.why = unsure ? keepIt : 'no zip of this id is here: nothing arrived under it, or it is deleted already - delete the request';
    } else if (hits.length) {
      q.why = `its token is the one ${hits.length === 1 ? 'that zip\'s manifest names' : `those ${hits.length} zips' manifests name`}: `
        + `delete ${hits.length === 1 ? 'it' : 'them'}, and ${unsure
          ? 'keep the request: a zip of this id, or a folder, could not be read, and may hold another copy' : 'the request'}`;
      for (const z of hits) if (!withdrawn.has(z)) withdrawn.set(z, q);
    } else {
      q.why = unsure ? `its token is not the one any zip of this id read here names, and ${keepIt}`
        : 'its token is not the one any zip of this id names: ignore it, and delete the request';
    }
  }
  for (const [z, q] of withdrawn) {
    z.action = 'delete';
    z.why = `its sender asked for its deletion (${q.path})`;
  }
  // The rest: one zip kept per SHA-256 - the one named <id>.zip when it is
  // among them - and its copies dropped; two SHA-256s under one id are both
  // kept, and looked at. Two counted over EVERY zip of the id, those whose
  // deletion was asked for included: a bundle of another SHA-256 that
  // claims the id of one withdrawn is still not that player's to keep.
  const bySha = new Map();
  for (const z of g.zips.filter((x) => !withdrawn.has(x))) {
    if (!bySha.has(z.sha256)) bySha.set(z.sha256, []);
    bySha.get(z.sha256).push(z);
  }
  const conflict = new Set(g.zips.map((z) => z.sha256)).size > 1;
  for (const group of bySha.values()) {
    const keeper = group.find((z) => z.name === `${id}.zip`) ?? group[0];
    keeper.action = conflict ? 'look' : 'keep';
    keeper.why = !conflict ? 'the zip to keep'
      : bySha.size > 1 ? 'keep it, and look: another zip under this id is another bundle (another SHA-256)'
        : 'keep it, and look: a zip under this id whose deletion was asked for is another bundle (another SHA-256)';
    for (const z of group) {
      if (z === keeper) continue;
      z.action = 'drop';
      z.why = `the same bundle as ${keeper.path} (the same SHA-256)`;
    }
  }
  const order = { keep: 0, look: 1, drop: 2, delete: 3 };
  g.zips.sort((a, b) => order[a.action] - order[b.action] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  submissions.push({
    id,
    title: g.zips[0]?.title ?? null,
    rows: g.zips[0]?.rows ?? [],
    zips: g.zips.map(({ name, title, rows, ...z }) => z),
    requests: g.requests,
  });
}

const count = (action) => submissions.reduce((a, s) => a + s.zips.filter((z) => z.action === action).length, 0);
const asked = (action) => requests.reduce((a, q) => a + (q.action === action ? 1 : 0), 0);
const todo = {
  keep: count('keep'),
  look: count('look') + asked('look'),
  drop: count('drop'),
  delete: count('delete') + asked('delete'),
};

if (asJson) {
  console.log(JSON.stringify({
    format: 'farever-bench-inbox',
    version: 1,
    folder: shown(folder),
    submissions: submissions.map(({ rows, ...s }) => s),
    other,
    todo,
  }, null, 2));
  process.exit(0);
}

// --- the report --------------------------------------------------------------
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
console.log(`${shown(folder)}: ${plural(files.length + passed, 'entry', 'entries')} - `
  + `${plural(zips.length, 'zip')} of ${plural(submissions.filter((s) => s.zips.length).length, 'submission')}, `
  + `${plural(requests.length, 'request')} for a deletion, ${plural(other.length, 'other entry', 'other entries')}. `
  + 'Nothing was changed; every file was read as data.');
// The widest path, by a fold: the folder holds whatever anyone uploaded, as
// many files as they like, and one argument per entry (Math.max(...all))
// is past what a call takes long before a flooded folder ends.
const width = Math.min(48, [zips, requests, other].reduce((w, list) => list.reduce((m, x) => Math.max(m, x.path.length), w), 0));
const line = (action, path, why) => console.log(`  ${action.padEnd(7)} ${path.padEnd(width)}  ${why}`);
for (const s of submissions) {
  console.log(`\n${s.id}  ${s.title ?? (unread.has(s.id) ? '(a zip of this id is here, and was not read as a bundle - see Not submissions)'
    : '(no zip of this id is here)')}`);
  for (const [k, v] of s.rows) console.log(`    ${k}: ${v}`);
  for (const z of s.zips) {
    const made = z.createdAt ? `, made ${z.createdAt}` : '';
    line(z.action, z.path, z.action === 'keep' || z.action === 'look'
      ? `${z.why} - ${fmt(z.bytes)} bytes, SHA-256 ${z.sha256.slice(0, 12)}...${made}, farever-bench ${z.benchVersion}`
      : z.why);
  }
  for (const q of s.requests) line(q.action, q.path, q.why);
}
if (other.length) {
  console.log('\nNot submissions:');
  for (const o of other) line('other', o.path, o.why);
}
console.log(`\nTo do: keep ${fmt(todo.keep)}, look at ${fmt(todo.look)}, drop ${fmt(todo.drop)}, delete ${fmt(todo.delete)}`
  + `${other.length ? `, and see to ${plural(other.length, 'entry', 'entries')} that ${other.length === 1 ? 'is' : 'are'} no submission` : ''}.`);
