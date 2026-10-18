// ---------------------------------------------------------------------------
// drift.mjs - what changed under the model when the game updated.
//
// The model's whole trust story is that every number is read from the game's
// own data, so a patch is not a maintenance chore - it is an event this tool
// must detect, enumerate, and convert into a work list. Three artifacts:
//
//   FINGERPRINT   model/fingerprint.json, committed. One hash per row of every
//                 sheet the model consumes (and a second one with the row's
//                 texts and visuals stripped and its enums decoded by name, so
//                 a renamed skill or a renumbered enum is not a changed
//                 skill; and on the sheets a SHEET check answers for, a third
//                 with the enums left out, so a flag flip is not mistaken for
//                 a number moving), one per skill script and the hook names each
//                 script declares, the talent trees of the player classes, the
//                 column schema of the consumed sheets (every enum and flags
//                 case, every custom-type case - the things the readers decode
//                 by NAME and therefore cannot see arrive), one hash per sheet
//                 the bench does NOT read (so a system arriving in an unread
//                 sheet is at least named), the classes of the packages the
//                 model cites, and - for every bytecode citation in the source
//                 and the living docs - the function it resolved to, how many
//                 ops its body had, a hash of that body's SHAPE, whether the
//                 body is a server-only stub, and for a closure (which has
//                 no name) the named function that creates it. A pick the
//                 resolver itself calls SUSPECT is not recorded, and the
//                 citations an acceptance let through stale are listed
//                 beside the table with where each was estimated to be.
//                 Small enough to diff in a PR.
//
//   DRIFT REPORT  the difference between the stored fingerprint and the
//                 install as it stands: rows added, removed and changed per
//                 sheet, scripts whose text moved and the hooks they grew,
//                 talents that moved, columns and cases that appeared,
//                 citations whose function moved, changed body, lost its body
//                 or vanished.
//
//   WORK LIST     each change mapped to what it invalidates. A changed skill
//                 script needs its readers re-run AND a dummy session on
//                 whatever grants the skill - the reader can re-read text, but
//                 only a capture can confirm the model's reading of it. A
//                 changed constant or attribute row moves the sheet, which
//                 `bench verify`'s SHEET check can confirm from a snapshot
//                 taken on THIS build (an older one carries the old build's
//                 numbers). A new enum case or a new script hook is a model
//                 re-read: the readers name every case and hook they
//                 understand, so one none of src/ names is unread until
//                 someone reads it. A citation has four fates. MOVED with the
//                 same body is free to re-anchor (the name is the identity,
//                 the findex a cache - `bench update --reanchor` does it). A
//                 body that CHANGED is a formula to re-read. A STUB is a
//                 function the client no longer carries: the formula it
//                 anchored cannot be re-read on this build at all, and the
//                 citing sentence has to say so. A VANISHED one means a
//                 formula's source no longer exists and the formula is
//                 unverified until someone re-reads the new code. A removed
//                 row is cross-referenced against the source and the living
//                 docs: cited somewhere is model work, cited nowhere is a
//                 note.
//
// The fingerprint only updates on --accept, so the drift report is stable and
// repeatable while the work it names is being done.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync,
  openSync, readSync, closeSync, fstatSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { COMBAT_CATEGORIES } from './catalog.mjs';

// Every top-level sheet the bench reads anywhere - the model in src/, the
// commands in bin/ and tools/, and the UI server in ui/. A sheet not listed
// here can change without the drift report noticing, so the list errs wide -
// unused columns hashing along costs a false positive at worst, never a false
// negative on a sheet that matters. The suite lints this list against every
// literal sheet name read through a cdb in all four directories, so a new
// reader cannot forget to register its sheet.
//
// `slot` is deliberately absent: it is not a sheet, it is the `itemType@slot`
// column, and itemType is here. `moveSet` is the base-attack chain length the
// weapons table calls CHAIN; `craft` decides which items count as crafted.
// `gameTerm`, `color` and `icon` are the UI's: term links, class colours,
// class icons. So are `gameBeat`, one more sheet a description's [link] can
// resolve through, and `text`, whose rows the tooltips fill - an infusion's
// set title, the seconds and metres a duration and a range are printed in.
// Nothing numeric reads any of the five, so their drift is a note.
// `faction` is the UI's as well: the NAME a faction is shown under ("Apix",
// where the row id is `Bee`) - on an infusion, on the piece whose bonus line
// it lights, and wherever a text links one. sources.mjs prints the same names
// in its sentences. Names only, so its drift is a note too.
export const SHEETS = [
  'skill', 'item', 'itemType', 'attribute', 'affix', 'statusType', 'rarity',
  'constant', 'unit', 'aptitude', 'affinity', 'craft', 'moveSet',
  'faction',
  'gameBeat', 'text',
  'gameTerm', 'color', 'icon',
  // What hands an item out (sources.mjs): the loot tables. The release-status
  // enum it also needs is NOT here: it is reached through the column that
  // borrows it (`structRef: types@props@releaseStatus`), not by a sheet name,
  // and a status that enum stops naming is refused at the point of use -
  // nothing is withheld and the output says why.
  'lootTable',
];

const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

// The parts of a row no number depends on. Stripped before the second hash,
// so a renamed skill, a recoloured item or a new hit effect is a note and not
// a work item. Top-level keys are text; the deep keys are visual wherever
// they sit (a step's `visuals`, a unit's `models`).
const COSMETIC_TOP = new Set(['texts', 'notes', 'desc', 'name', 'flavorDesc', 'author']);
const COSMETIC_DEEP = new Set(['visuals', 'gfx', 'anim', 'sfx', 'fxs', 'fx', 'sound', 'sounds', 'camRumble',
  'icon', 'icons', 'color', 'colour', 'model', 'models', 'prefab', 'defaultIcons', 'portraitGroup', 'hitFx']);
export function stripCosmetic(row, top = true) {
  if (Array.isArray(row)) return row.map((x) => stripCosmetic(x, false));
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (COSMETIC_DEEP.has(k) || (top && COSMETIC_TOP.has(k))) continue;
    out[k] = stripCosmetic(v, false);
  }
  return out;
}

// An enum ("5:A,B") or flags ("10:A,B") column: its kind and its cases. A
// kind change with the same cases turns an index into a bitmask, so the two
// are only comparable case-by-case when the kind agrees.
const enumCases = (typeStr) => {
  const m = /^(5|10):(.*)$/.exec(String(typeStr ?? ''));
  return m ? { kind: m[1], cases: m[2].split(',').filter(Boolean) } : null;
};

// A row with every enum and flags value replaced by its case NAMES, nested
// sheets included ("skill@steps@effects" is how CastleDB names the sheet behind
// a list column). The rows store an index or a bitmask; a patch that removes a
// case from the MIDDLE of the list renumbers every later one - itemType.flags
// lost `Equippable` at bit 1 in the October 2026 build and twenty rows changed
// in nothing but that number. Hashing names instead of numbers is what keeps a
// renumbering from reading as twenty changed rows, and it is the same decode
// the readers perform.
const colTypes = new WeakMap();
export function decodeRow(cdb, sheetName, row, { dropEnums = false } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  let perCdb = colTypes.get(cdb);
  if (!perCdb) colTypes.set(cdb, perCdb = new Map());
  let cols = perCdb.get(sheetName);
  if (cols === undefined) {
    const s = cdb.sheets?.get?.(sheetName);
    cols = s?.columns ? new Map(s.columns.map((c) => [c.name, String(c.typeStr ?? '')])) : null;
    perCdb.set(sheetName, cols);
  }
  if (!cols) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const t = cols.get(k);
    const e = t ? enumCases(t) : null;
    if (e && dropEnums) continue;
    if (e && Number.isInteger(v) && v >= 0) {
      if (e.kind === '5') out[k] = e.cases[v] ?? v;
      else {
        const names = e.cases.filter((_, i) => Math.floor(v / 2 ** i) % 2 === 1);
        // A bit past the last case has no name; keep it visible as a number.
        const rest = Math.floor(v / 2 ** e.cases.length);
        out[k] = rest ? [...names, `bits>>${e.cases.length}=${rest}`] : names;
      }
    } else if (t === '8' && Array.isArray(v)) out[k] = v.map((x) => decodeRow(cdb, `${sheetName}@${k}`, x, { dropEnums }));
    else if (t === '17' && v && typeof v === 'object') out[k] = decodeRow(cdb, `${sheetName}@${k}`, v, { dropEnums });
    else out[k] = v;
  }
  return out;
}

// What a number can depend on in a row: cosmetics out, enums by name. A skill
// row's script is left out as well - not because nothing depends on it, but
// because it has a hash and a work item of its own, and "the script changed"
// must not also read as "the row changed": with the text inside this hash
// every script change was counted twice and nothing could say whether the
// steps, effects or vars had moved besides.
const coreOf = (cdb, sheetName, row) => {
  const core = stripCosmetic(decodeRow(cdb, sheetName, row));
  if (sheetName === 'skill' && core && typeof core === 'object' && 'script' in core) delete core.script;
  return core;
};

// The schema of every consumed sheet, nested sheets included ("skill@steps" is
// a sheet of its own in CastleDB's naming), as the raw typeStr per column - an
// enum's cases live in that string ("5:Damage,Heal,..."), so keeping the text
// rather than a hash is what lets the diff say WHICH case arrived.
export function schemaOf(cdb) {
  const sheets = {};
  for (const [name, s] of cdb.sheets ?? []) {
    if (!SHEETS.includes(name.split('@')[0])) continue;
    const cols = {};
    for (const c of s.columns ?? []) cols[c.name] = String(c.typeStr ?? '');
    sheets[name] = cols;
  }
  const customTypes = {};
  for (const [name, t] of cdb.customTypes ?? []) {
    customTypes[name] = (t.cases ?? [])
      .map((c) => `${c.name}(${(c.args ?? []).map((a) => a.name).join(',')})`).join('|');
  }
  return { sheets, customTypes };
}

// The hook names a script declares: `function onInflictDamage(hit)` and the
// like. The readers know a fixed vocabulary of them, so a new name is exactly
// the kind of change a text hash cannot describe.
export function hooksOf(script) {
  const names = new Set();
  const RE = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (let m; (m = RE.exec(String(script ?? '')));) names.add(m[1]);
  return [...names].sort();
}

// The talent trees of every unit that has one, as skill -> "tier:branch:max".
// They live inside the unit row, where a moved talent would otherwise surface
// as nothing more than "unit Warrior changed". The branch is an enum and is
// recorded by its case NAME (the row stores an index, and a renumbered enum
// would read as every talent moving); the max is the point cap on the
// talent's own skill row (props.talent.maxPoints) - the tree row has no such
// column, and a cap that moved changes the budget exactly as a tier does.
export function talentsOf(cdb) {
  const out = {};
  let skills = null, branches = null;
  try { skills = cdb.byId('skill'); } catch { /* no skill sheet: no caps */ }
  try { branches = cdb.enumValues('unit@talentTrees@talents', 'branch'); } catch { /* not an enum here */ }
  for (const u of cdb.lines('unit')) {
    if (!(u.talentTrees ?? []).length) continue;
    const m = {};
    for (const tr of u.talentTrees) {
      for (const t of tr.talents ?? []) {
        if (!t?.skill) continue;
        const branch = Number.isInteger(t.branch) ? (branches?.[t.branch] ?? t.branch) : (t.branch ?? '?');
        m[t.skill] = `${t.tier ?? '?'}:${branch}:${skills?.get(t.skill)?.props?.talent?.maxPoints ?? '-'}`;
      }
    }
    out[u.id] = m;
  }
  return out;
}

// A qualified function name is package.Class.method; a dollar marks the
// class's static side and is punctuation, not identity.
const classOfFn = (qualified) => String(qualified).split('.').slice(0, -1).join('.');
const packageOfClass = (cls) => String(cls).replace(/\$/g, '').split('.').slice(0, -1).join('.');

// The code half of "what arrived": the bytecode report used to list citations
// and nothing else, so a whole new class - the infusion helper of the October
// 2026 build - was never named. Recording every class would add a quarter of
// a megabyte to a file meant to be diffed, so this keeps to the packages the
// model actually cites: one "count:hash" per class there, and the method names
// themselves for the classes that own a cited function. The compiled twins of
// the skill scripts (one class per script) are left out - the scripts are
// diffed from the data, text and hooks both.
export function classesOf(code, resolved) {
  if (!code?.fnNames || !resolved) return null;
  const cited = new Set(Object.values(resolved).map((r) => r?.qualified).filter(Boolean).map(classOfFn));
  const scriptPkg = (pkg) => /^script\.skills(\.|$)/.test(pkg);
  const packages = new Set([...cited].map(packageOfClass).filter((p) => !scriptPkg(p)));
  const byClass = new Map();
  for (const [, name] of code.fnNames) {
    if (String(name).endsWith('[native]')) continue;
    const cls = classOfFn(name);
    if (!cls || !packages.has(packageOfClass(cls))) continue;
    (byClass.get(cls) ?? byClass.set(cls, []).get(cls)).push(String(name).split('.').pop());
  }
  const classes = {}, methods = {};
  for (const cls of [...byClass.keys()].sort()) {
    const names = [...new Set(byClass.get(cls))].sort();
    classes[cls] = `${names.length}:${h(names.join(' ')).slice(0, 6)}`;
    if (cited.has(cls)) methods[cls] = names.join(' ');
  }
  return { packages: [...packages].sort(), classes, methods };
}

// The sheets whose changed rows the work list sends to a SHEET check. That
// check compares numbers, and a flag is not one: the four primary attributes
// "changed" in the October 2026 build by gaining one flag bit and were routed
// to a check that could never see it. So these sheets get a third hash, of
// the row with its enum and flags columns left out: second hash moved, third
// did not -> nothing but a flag or an enum value moved.
const SHEET_CHECKED = ['constant', 'attribute', 'rarity', 'affix', 'item', 'aptitude'];

export function buildFingerprint(cdb, { code = null, srcDir = null, known = null, prev = null } = {}) {
  const sheets = {}, core = {}, numeric = {};
  for (const name of SHEETS) {
    let lines;
    try { lines = cdb.lines(name); } catch { continue; }
    const rows = {}, cores = {};
    const nums = SHEET_CHECKED.includes(name) ? (numeric[name] = {}) : null;
    for (const r of lines) {
      // `craft` rows have no id: the item they make is the identity.
      const id = r?.id ?? (name === 'craft' ? r?.item : null);
      // A blank id is a row nobody can cite (the July data shipped one).
      if (typeof id !== 'string' || id === '') continue;
      rows[id] = h(JSON.stringify(r));
      cores[id] = h(JSON.stringify(coreOf(cdb, name, r)));
      if (nums) nums[id] = h(JSON.stringify(stripCosmetic(decodeRow(cdb, name, r, { dropEnums: true }))));
    }
    sheets[name] = rows;
    core[name] = cores;
  }
  // Script text hashed separately from the row: the readers execute the text,
  // so a script change is a different KIND of event than a stat nudge, and the
  // work list treats it as one.
  const scripts = {}, hooks = {};
  for (const s of cdb.lines('skill')) {
    if (s?.script && typeof s.id === 'string' && s.id) {
      scripts[s.id] = h(String(s.script));
      hooks[s.id] = hooksOf(s.script);
    }
  }
  // Every top-level sheet the bench does not read, hashed whole: a system
  // arriving there cannot be modelled, but it can be named.
  const others = {};
  for (const [name, s] of cdb.sheets ?? []) {
    if (name.includes('@') || SHEETS.includes(name)) continue;
    others[name] = h(JSON.stringify(s.lines ?? []));
  }
  const out = {
    at: new Date().toISOString(),
    cdbSha: cdb.meta.cdbSha,
    bootSha: cdb.meta.bootSha,
    sheets,
    core,
    numeric,
    scripts,
    hooks,
    talents: talentsOf(cdb),
    others,
    schema: schemaOf(cdb),
  };
  if (code && srcDir) {
    out.citations = resolveCitations(code, srcDir, { known, deferred: prev?.staleCitations ?? null }).resolved;
    // A STUB carries its annotation forward: when this tool first saw the
    // body gone, and the last accepted build that still recorded one. That
    // record is what lets --accept pass with a citation nobody can re-read,
    // and what keeps the next report from announcing it as news.
    for (const rec of Object.values(out.citations)) {
      if (!rec.stub || rec.stub.since) continue;
      const { thrown, bodyOps } = rec.stub;
      rec.stub = {
        thrown,
        since: out.at,
        sinceBoot: String(out.bootSha ?? '').slice(0, 12) || null,
        // The build that last recorded a body for it, when one did. A table
        // written before bodies were hashed (bare findexes) cannot say.
        bodyLast: bodyOps !== undefined ? { at: prev?.at ?? null, ops: bodyOps } : null,
      };
    }
    out.code = classesOf(code, out.citations);
  }
  return out;
}

// The stored side of a diff taken --against an older copy of the data. Such a
// copy is a data.cdb and nothing else: no bytecode sits beside it. So what a
// fingerprint records about the CODE - the classes of the cited packages -
// still comes from the committed fingerprint, as the citation table does;
// the data is diffed against the copy and the code against the accepted
// build. Built from the copy alone, the report said "classes are not in the
// stored fingerprint" of a fingerprint that held them, and NEW CODE and the
// code-class work items went missing with it.
export function fingerprintAgainst(oldCdb, committed, label) {
  const fp = buildFingerprint(oldCdb);
  fp.at = label;
  if (committed?.code) fp.code = committed.code;
  return fp;
}

// Where citations live: the model, the commands, the tools, the UI server,
// the living documents that state formulas as current fact, and the comment
// lines of the suite. Not the engineering log, the roadmap or the changelog,
// whose findexes are history and should stay as written.
export function citationRoots(repoRoot) {
  return ['src', 'bin', 'tools', 'ui', 'docs/MODEL.md', 'docs/GROUND-TRUTH.md', 'docs/TODO.md', 'ui/API.md', 'test/run.mjs']
    .map((p) => join(repoRoot, p)).filter((p) => existsSync(p));
}

// The files behind a list of roots: a directory gives its top-level .mjs
// files and those of its lib/ folder, a file gives itself. A file under test/
// is read on its COMMENT LINES only - the suite's fixtures are citation-shaped
// strings against synthetic bytecode and must never be taken for citations,
// let alone rewritten.
function citationFiles(roots, { lib = true } = {}) {
  const files = [];
  const push = (label, path) => files.push({
    label, path, prose: !path.endsWith('.mjs'), commentsOnly: basename(dirname(path)) === 'test',
  });
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    if (!root || !existsSync(root)) continue;
    if (statSync(root).isDirectory()) {
      const base = basename(root);
      for (const f of readdirSync(root).sort()) if (f.endsWith('.mjs')) push(`${base}/${f}`, join(root, f));
      const sub = join(root, 'lib');
      if (lib && existsSync(sub) && statSync(sub).isDirectory()) {
        for (const f of readdirSync(sub).sort()) if (f.endsWith('.mjs')) push(`${base}/lib/${f}`, join(sub, f));
      }
    } else {
      push(`${basename(dirname(root))}/${basename(root)}`, root);
    }
  }
  return files;
}

// Every citation in the given roots, one record per place it is written. Three
// kinds of spelling are understood, N standing for the findex (no digits in
// these examples: this file is scanned too):
//
//   name@N                    the main form; the name may be qualified
//   `name`@N  `name` (@N)  `Class.name`, findex N  Class.name (findex N)
//   `name` (N)                the prose forms - the name backticked or dotted,
//                             so a word in front of a number is never guessed
//                             into a name. The last one - a backticked name
//                             and nothing but a number in brackets - needs
//                             four digits, like every number with no `@` or
//                             "findex" beside it to say what it is.
//   fn@N  @N  findex N  fn N  anonymous: a closure has no name to resolve by,
//                             and a bare number has lost its name. They are
//                             COUNTED and reported with file and line, not
//                             resolved by name - the number is all there is.
//                             Only `fn@` says closure; "fn" and a space is a
//                             number that lost its name like the others.
//
// A number followed by a dash is an op range inside a function (an `@` in
// front of "117-150"), not a findex, and a bare number needs four digits: an
// op position is at most three.
const NAME_RE = '[A-Za-z_$][A-Za-z0-9_$.]*[A-Za-z0-9_$]';
export function scanCitationSites(roots) {
  const sites = [];
  const CITE = new RegExp(`(${NAME_RE})@(\\d{3,6})\\b(?!-\\d)`, 'g');
  const PROSE = new RegExp(
    '(?:`(' + NAME_RE + ')`(?:@|\\s?\\(@|,?\\s\\(?findex\\s|\\s\\((?=\\d{4,6}\\)))'
    + '|(?<![A-Za-z0-9_$.])((?:[A-Za-z_$][A-Za-z0-9_$]*\\.)+[A-Za-z_$][A-Za-z0-9_$]*)(?:\\s?\\(@|,?\\s\\(?findex\\s))'
    + '(\\d{3,6})\\b(?!-\\d)', 'g');
  const BARE = /(?<![A-Za-z0-9_$`])@(\d{4,6})\b(?!-\d)/g;
  const FINDEX = /\bfindex\s(\d{4,6})\b(?!-\d)/g;
  const FN = /(?<![A-Za-z0-9_$.`])fn\s(\d{4,6})\b(?!-\d)/g;
  // In a .mjs file a citation outside a comment sits in a string the tool
  // prints - an audit `why:` - and a stale one there is a false statement to
  // the user, not a stale note to a maintainer.
  const inComment = (line, col) => /(^|[^:'"`])\/\//.test(line.slice(0, col)) || /^\s*(\*|\/\*)/.test(line);
  for (const file of citationFiles(roots)) {
    const lines = readFileSync(file.path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (file.commentsOnly && !line.trimStart().startsWith('//')) continue;
      if (!line.includes('@') && !line.includes('findex') && !/fn\s\d|`\s\(\d/.test(line)) continue;
      const taken = [];
      const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
      const add = (o) => {
        taken.push([o.start, o.end]);
        sites.push({
          file: file.label, path: file.path, line: i + 1, text: line.slice(o.start, o.end),
          printed: !file.prose && !file.commentsOnly && !inComment(line, o.start), ...o,
        });
      };
      CITE.lastIndex = 0;
      for (let m; (m = CITE.exec(line));) {
        const numStart = m.index + m[1].length + 1;
        add({
          form: m[1] === 'fn' ? 'anon' : 'at', name: m[1], cached: Number(m[2]),
          start: m.index, end: m.index + m[0].length,
          nameStart: m.index, nameEnd: m.index + m[1].length, numStart, numEnd: numStart + m[2].length,
        });
      }
      PROSE.lastIndex = 0;
      for (let m; (m = PROSE.exec(line));) {
        const end = m.index + m[0].length;
        if (!free(m.index, end)) continue;
        const name = m[1] ?? m[2];
        const nameStart = m.index + (m[1] ? 1 : 0);
        add({
          form: 'prose', name, cached: Number(m[3]), start: m.index, end,
          nameStart, nameEnd: nameStart + name.length, numStart: end - m[3].length, numEnd: end,
        });
      }
      for (const RE of [BARE, FINDEX, FN]) {
        RE.lastIndex = 0;
        for (let m; (m = RE.exec(line));) {
          const end = m.index + m[0].length;
          if (!free(m.index, end)) continue;
          add({ form: 'anon', bare: true, name: 'fn', cached: Number(m[1]), start: m.index, end, numStart: end - m[1].length, numEnd: end });
        }
      }
    }
  }
  return sites;
}

// Every NAMED citation in the given roots. The name is the identity -
// findexes drift every patch, names have survived every one so far - so each
// is resolved by name against the CURRENT bytecode and the stored findex is
// only a cache to compare against. Returns name -> findex -> Set(file).
export function scanCitations(roots) {
  const found = new Map();
  for (const s of scanCitationSites(roots)) {
    // An anonymous citation is skipped here (its findex IS its identity,
    // nothing to resolve by name); resolveCitations reports it on its own.
    if (s.form === 'anon') continue;
    const byFindex = found.get(s.name) ?? new Map();
    byFindex.set(s.cached, (byFindex.get(s.cached) ?? new Set()).add(s.file));
    found.set(s.name, byFindex);
  }
  return found;
}

// --- what a cited function IS, beyond where it sits --------------------------

const perCode = new WeakMap();
function memo(code, key, make) {
  let m = perCode.get(code);
  if (!m) perCode.set(code, m = new Map());
  if (!m.has(key)) m.set(key, make());
  return m.get(key);
}

// The string a constant global holds, or null. Constants are (global, fields)
// pairs and a String's first field is its index in the string table.
function constantString(code, global) {
  const byGlobal = memo(code, 'constants', () => new Map((code.constants ?? []).map((k) => [k.global, k])));
  const t = code.types?.[code.globals?.[global]];
  const k = byGlobal.get(global);
  if (!k || t?.name !== 'String') return null;
  return code.strings?.[k.fields?.[0]] ?? null;
}

// The constant the October 2026 client throws where a server-side body used to
// be. The accepted build kept those bodies behind a runtime guard -
// `if (!simulatingServer && !Config.server) throw "!isServer"` and then 150 ops
// of applyDamage; this one ships the throw alone, 202 times.
export const SERVER_ONLY = '!isServer';

// A function that does nothing but throw a constant: its last three ops load a
// constant String, wrap it in an exception and throw, and no path returns (a
// guard in front of a real body has a Ret, a default-argument preamble in
// front of the throw does not). Returns the constant thrown. Only SERVER_ONLY
// means "the client no longer carries this body": the other 121 on that build
// throw "TODO", "Not implemented", "assert" - ordinary abstract methods, which
// were never bodies to lose.
export function throwOnly(code, findex) {
  const f = code?.byFindex?.get?.(findex);
  const n = f?.ops?.length ?? 0;
  if (n < 3) return null;
  const [g, c, t] = [f.ops[n - 3], f.ops[n - 2], f.ops[n - 1]];
  if (t.op !== 'Throw' || g.op !== 'GetGlobal' || !/^Call/.test(c.op)) return null;
  if (!/Exception\.thrown$/.test(String(code.fnNames?.get?.(c.args[1]) ?? ''))) return null;
  if (f.ops.some((o) => o.op === 'Ret')) return null;
  return { ops: n, thrown: constantString(code, g.args[1]) };
}

// A type as it matters to a body: its name. A virtual is reduced to the word,
// because its field list is the column list of a cdb sheet - one new constant
// in a group and every function holding that group in a register would read
// as rewritten.
function typeNorm(code, tIdx, depth = 0) {
  const t = code.types?.[tIdx];
  if (!t || depth > 6) return `t${tIdx}`;
  switch (t.kind) {
    case 10: case 20: return `(${(t.args ?? []).map((a) => typeNorm(code, a, depth + 1)).join(',')})->${typeNorm(code, t.ret, depth + 1)}`;
    case 11: case 21: case 17: case 18: return t.name;
    case 14: return `ref<${typeNorm(code, t.type, depth + 1)}>`;
    case 19: return `null<${typeNorm(code, t.type, depth + 1)}>`;
    case 22: return `packed<${typeNorm(code, t.type, depth + 1)}>`;
    case 15: return 'virtual';
    default: return t.kindName ?? `kind${t.kind}`;
  }
}

// The object type behind a register type, through ref/null/packed wrappers.
function objType(code, tIdx) {
  let t = code.types?.[tIdx];
  while (t && (t.kind === 14 || t.kind === 19 || t.kind === 22)) t = code.types[t.type];
  return t ?? null;
}

// Field index -> name. Indexes run over the flattened field list, the
// parent's fields first, exactly as the reader's own disassembly resolves them.
function fieldNameOf(code, tIdx, fieldIdx) {
  const t = objType(code, tIdx);
  if (!t) return `f${fieldIdx}`;
  if (t.kind === 15) return t.fields?.[fieldIdx]?.name ?? `f${fieldIdx}`;
  if (t.kind !== 11 && t.kind !== 21) return `f${fieldIdx}`;
  const chain = [];
  for (let cur = t; cur; cur = cur.super >= 0 ? code.types[cur.super] : null) chain.unshift(cur);
  let at = fieldIdx;
  for (const c of chain) {
    const n = (c.fields ?? []).length;
    if (at < n) return c.fields[at].name;
    at -= n;
  }
  return `f${fieldIdx}`;
}

// Virtual-method slot -> name, through the receiver's class chain. The slot
// is the proto's pindex and it moves whenever a parent class gains a method:
// GameObject's went 131->136 and 143->149 across the October 2026 patch under
// functions that did not change a line.
function protoNameOf(code, tIdx, slot) {
  const t = objType(code, tIdx);
  if (!t) return `p${slot}`;
  if (t.kind === 15) return t.fields?.[slot]?.name ?? `p${slot}`;
  for (let cur = t; cur; cur = cur.super >= 0 ? code.types[cur.super] : null) {
    const p = (cur.protos ?? []).find((x) => x.pindex === slot);
    if (p) return p.name;
  }
  return `p${slot}`;
}

// The server-only stubs a function calls. A cited body can be intact and its
// claim still rest on one that is not: BaseSkill.setRunning is all there, and
// what it does is call applyAffixes and removeAffixes, which are not. Direct
// calls and closures by findex; method calls through the receiver's declared
// class, which is the implementation the disassembly names - an override in a
// subclass is not followed.
export function stubCallees(code, findex) {
  const f = code?.byFindex?.get?.(findex);
  if (!f || !code.types) return [];
  const protoOf = (tIdx, slot) => {
    for (let cur = objType(code, tIdx); cur && (cur.kind === 11 || cur.kind === 21); cur = cur.super >= 0 ? code.types[cur.super] : null) {
      const p = (cur.protos ?? []).find((x) => x.pindex === slot);
      if (p) return p;
    }
    return null;
  };
  const out = new Set();
  for (const o of f.ops) {
    let callee = null;
    if (/^Call[0-4N]$/.test(o.op) || o.op === 'StaticClosure' || o.op === 'InstanceClosure') callee = o.args[1];
    else if (o.op === 'CallMethod') callee = protoOf(f.regs[o.extra?.[0]], o.args[1])?.findex;
    else if (o.op === 'CallThis') callee = protoOf(f.regs[0], o.args[1])?.findex;
    if (callee != null && throwOnly(code, callee)?.thrown === SERVER_ONLY) out.add(`${code.fnNames?.get?.(callee) ?? 'fn'}@${callee}`);
  }
  return [...out];
}

// The SHAPE of a function body: its ops with everything a patch renumbers
// resolved to a name, hashed. Callees by name instead of findex, fields and
// virtual slots by name instead of index, string globals by the string, other
// globals by their type, constants by value, jumps as the relative offsets
// they already are, and no debug lines. The one Int left out is the line
// number a haxe.PosInfos literal carries (`lineNumber = 174` moves with every
// edit above it in the source file). Two builds give the same shape exactly
// when the function was compiled from the same code - which is the question a
// findex cannot answer: MOVED and identical, or MOVED and rewritten.
export function bodyShape(code, findex) {
  const f = code?.byFindex?.get?.(findex);
  if (!f || !code.types) return null;
  const cache = memo(code, 'shapes', () => new Map());
  if (cache.has(findex)) return cache.get(findex);
  const T = (i) => typeNorm(code, i);
  const fn = (i) => code.fnNames?.get?.(i) ?? 'fn';
  const G = (i) => {
    const s = constantString(code, i);
    return s != null ? JSON.stringify(s) : `g:${T(code.globals?.[i])}`;
  };
  const str = (i) => JSON.stringify(code.strings?.[i] ?? `s${i}`);
  // Ints that only feed a PosInfos line number.
  const lineInts = new Set();
  for (let i = 0; i < f.ops.length; i++) {
    const o = f.ops[i];
    const isLine = (o.op === 'DynSet' && code.strings?.[o.args[1]] === 'lineNumber')
      || (o.op === 'SetField' && fieldNameOf(code, f.regs[o.args[0]], o.args[1]) === 'lineNumber');
    if (!isLine) continue;
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      if (f.ops[j].op === 'Int' && f.ops[j].args[0] === o.args[2]) { lineInts.add(j); break; }
    }
  }
  const lines = [T(f.type), f.regs.map(T).join(' ')];
  for (let i = 0; i < f.ops.length; i++) {
    const o = f.ops[i];
    const A = o.args;
    const X = o.extra ? ` [${o.extra.join(',')}]` : '';
    let s;
    switch (o.op) {
      case 'Int': s = `${A[0]} ${lineInts.has(i) ? 'L' : code.ints?.[A[1]]}`; break;
      case 'Float': s = `${A[0]} ${code.floats?.[A[1]]}`; break;
      case 'String': s = `${A[0]} ${str(A[1])}`; break;
      case 'Bytes': s = `${A[0]}`; break;
      case 'Call0': case 'Call1': case 'Call2': case 'Call3': case 'Call4':
        s = `${A[0]} ${fn(A[1])} ${A.slice(2).join(',')}`; break;
      case 'CallN': s = `${A[0]} ${fn(A[1])}${X}`; break;
      case 'CallMethod': s = `${A[0]} ${protoNameOf(code, f.regs[o.extra[0]], A[1])}${X}`; break;
      case 'CallThis': s = `${A[0]} ${protoNameOf(code, f.regs[0], A[1])}${X}`; break;
      case 'StaticClosure': s = `${A[0]} ${fn(A[1])}`; break;
      case 'InstanceClosure': s = `${A[0]} ${fn(A[1])} ${A[2]}`; break;
      case 'VirtualClosure': s = `${A[0]} ${A[1]} ${protoNameOf(code, f.regs[A[1]], A[2])}`; break;
      case 'GetGlobal': s = `${A[0]} ${G(A[1])}`; break;
      case 'SetGlobal': s = `${G(A[0])} ${A[1]}`; break;
      case 'Catch': s = G(A[0]); break;
      case 'Field': s = `${A[0]} ${A[1]}.${fieldNameOf(code, f.regs[A[1]], A[2])}`; break;
      case 'SetField': s = `${A[0]}.${fieldNameOf(code, f.regs[A[0]], A[1])} ${A[2]}`; break;
      case 'GetThis': s = `${A[0]} this.${fieldNameOf(code, f.regs[0], A[1])}`; break;
      case 'SetThis': s = `this.${fieldNameOf(code, f.regs[0], A[0])} ${A[1]}`; break;
      case 'DynGet': s = `${A[0]} ${A[1]} ${str(A[2])}`; break;
      case 'DynSet': s = `${A[0]} ${str(A[1])} ${A[2]}`; break;
      case 'Type': s = `${A[0]} ${T(A[1])}`; break;
      default: s = `${A.join(',')}${X}`;
    }
    lines.push(`${o.op} ${s}`);
  }
  const out = { ops: f.ops.length, shape: h(lines.join('\n')) };
  cache.set(findex, out);
  return out;
}

// Resolution is by suffix - `getStackFactor` matches `$HSkill.getStackFactor`,
// a dollar in either being namespace punctuation, not identity - and a bare
// method name routinely matches several classes (`reset` matches forty). What
// disambiguates is the SHIFT. A patch moves every function of a class block by
// the same amount, and the amount differs between blocks by hundreds: on the
// September 2026 build ent.GameObject moved +55, st.skill.BaseSkill +74, the
// script.skills block +1192. Plain nearest-to-the-cache therefore lands on a
// base-class stub that happens to sit between the old and the new findex - it
// did, five times in 28. So every citation with one live candidate, or whose
// cache is still true, is an ANCHOR measuring the shift near its findex; an
// ambiguous citation is re-anchored to the candidate nearest cached + the
// shift of the nearest anchor; and a pick that still sits more than a few
// slots off that prediction is SUSPECT. A qualified citation (the class
// written in front of the method) is never ambiguous, and a name the
// fingerprint recorded with its qualified spelling resolves by that spelling
// first - so the honest fix for a suspect pick is to qualify it in src/.
//
// The stored citation table is a second set of anchors, and after a partial
// re-anchor the better one: it measures accepted-build -> this build, while a
// citation the source already re-stamped measures nothing (its shift is zero
// by construction). A stale citation is therefore placed by the anchors that
// actually moved, and by the unmoved ones only when nothing else exists.
//
// Then each resolved function is OPENED. Where it sits says nothing about
// whether it is still the function the citing sentence read: the body may be a
// server-only stub (state STUB), or it may differ from the shape the
// fingerprint recorded (body CHANGED), or the fingerprint may predate shapes
// and have nothing to compare (body UNHASHED - not "the same", unknown).
// (No example with a findex here: this file is scanned too.)
export function resolveCitations(code, roots, { known = null, deferred = null } = {}) {
  const sites = scanCitationSites(roots);
  const all = [];
  for (const [findex, name] of code.fnNames?.entries?.() ?? []) {
    all.push({ findex, name, norm: String(name).replace(/\$/g, '') });
  }
  const byQualified = new Map(all.map((x) => [x.name, x]));
  const candidatesOf = (name) => {
    const norm = name.replace(/\$/g, '');
    const exact = all.filter((x) => x.norm === norm);
    return exact.length ? exact : all.filter((x) => x.norm.endsWith(`.${norm}`));
  };
  // The table is keyed by the citation as written, name and findex both, so
  // two functions cited under one bare name keep two records. A table from
  // before that (keyed by the bare name) is still read.
  const recOf = (name, cached) => {
    const keyed = known?.[`${name}@${cached}`];
    if (keyed && typeof keyed === 'object') return keyed;
    const bare = known?.[name];
    return bare && typeof bare === 'object' ? bare : null;
  };
  // And by the function it named. Re-anchoring rewrites the number in the
  // source, which changes the key; the record of what that function's body
  // WAS must survive that, or re-stamping a number would erase the one piece
  // of evidence that the body under it changed.
  const storedByQualified = new Map();
  for (const rec of Object.values(known ?? {})) {
    if (rec && typeof rec === 'object' && rec.qualified && !storedByQualified.has(rec.qualified)) storedByQualified.set(rec.qualified, rec);
  }

  const groups = new Map();
  for (const s of sites) {
    if (s.form === 'anon') continue;
    const key = `${s.name}@${s.cached}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(s);
  }
  const entries = [];
  for (const list of groups.values()) {
    const { name, cached } = list[0];
    const rec = recOf(name, cached);
    const wanted = rec?.qualified ?? null;
    const recorded = wanted ? byQualified.get(wanted) : null;
    entries.push({
      name, cached, files: [...new Set(list.map((s) => s.file))].sort(), sites: list, rec,
      live: recorded ? [recorded] : candidatesOf(name), recorded: !!recorded,
      recordedGone: wanted && !recorded ? wanted : null,
    });
  }
  // Pass 1: the anchors - what the patch did to findexes near each of them.
  const anchors = [];
  for (const e of entries) {
    if (!e.live.length) continue;
    if (e.live.some((x) => x.findex === e.cached)) anchors.push({ name: e.name, cached: e.cached, now: e.cached, from: 'source' });
    else if (e.live.length === 1) anchors.push({ name: e.name, cached: e.cached, now: e.live[0].findex, from: 'source' });
  }
  for (const [key, rec] of Object.entries(known ?? {})) {
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const old = typeof rec === 'number' ? rec : rec?.findex;
    if (name === 'fn' || !Number.isInteger(old)) continue;
    const q = typeof rec === 'object' && rec?.qualified ? byQualified.get(rec.qualified) : null;
    const live = q ? [q] : candidatesOf(name);
    if (live.length === 1) anchors.push({ name, cached: old, now: live[0].findex, from: 'fingerprint' });
  }
  const nearest = (list, cached) => list.reduce((best, a) => (
    !best || Math.abs(a.cached - cached) < Math.abs(best.cached - cached) ? a : best), null);
  const measured = anchors.filter((a) => a.from === 'fingerprint' || a.now !== a.cached);
  const nearestAnchor = (cached) => nearest(measured.length ? measured : anchors, cached);
  // For a number with no name: only the stored table says how far its
  // neighbourhood moved since the build it was written on.
  const storedAnchors = anchors.filter((a) => a.from === 'fingerprint');
  // And what the stored table held AT a number: a bare number that equals a
  // recorded citation's findex was, on the accepted build, that function.
  const storedAt = new Map();
  for (const [key, rec] of Object.entries(known ?? {})) {
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const old = typeof rec === 'number' ? rec : rec?.findex;
    if (name === 'fn' || !Number.isInteger(old)) continue;
    const q = typeof rec === 'object' && rec?.qualified ? byQualified.get(rec.qualified) : null;
    const live = q ? [q] : candidatesOf(name);
    if (!storedAt.has(old)) storedAt.set(old, { name, now: live.length === 1 ? live[0].findex : null, qualified: live.length === 1 ? live[0].name : null });
  }
  const viaOf = (a) => `${a.name}@${a.cached}->@${a.now} (shift ${a.now - a.cached >= 0 ? '+' : ''}${a.now - a.cached})`;
  // What the last acceptance deferred (--with-stale-citations). Such a
  // citation was written on a build OLDER than the table: the table's anchors
  // measure accepted build -> this build, and applied to its number they
  // measure nothing (on the accepted build itself every shift is zero, and a
  // hint then "predicted" the stale number it was a hint about). What the
  // deferral recorded is where the citation was estimated to be on the build
  // being accepted; that is where the table's shift applies from.
  const deferredBy = new Map((Array.isArray(deferred) ? deferred : []).map((d) => [d.key, d]));
  const fromDeferral = (key) => {
    const d = deferredBy.get(key);
    if (!d || !Number.isInteger(d.predicted)) return null;
    const a = nearest(storedAnchors, d.predicted);
    const shift = a ? a.now - a.cached : 0;
    return { then: d.predicted, via: d.via ?? null, predicted: d.predicted + shift, since: shift ? viaOf(a) : null };
  };
  // (A second deferral does not quote the first: one basis, not a history.)
  const deferralText = (was) => `it was placed near @${was.then} when it was accepted stale${was.via && !/^it was placed near/.test(was.via) ? ` (${was.via})` : ''}${was.since ? `, and ${was.since} since` : ''}`;

  const hasBodies = !!code.byFindex;
  const classify = (entry, findex, rec) => {
    rec ??= storedByQualified.get(entry.qualified) ?? null;
    entry.rec = rec;
    if (!hasBodies) return null;
    const b = bodyShape(code, findex);
    const thrown = throwOnly(code, findex);
    if (b) {
      entry.ops = b.ops;
      if (rec?.shape) {
        entry.body = rec.shape === b.shape ? 'SAME' : 'CHANGED';
        if (entry.body === 'CHANGED') entry.opsWas = rec.ops ?? null;
      } else entry.body = 'UNHASHED';
    }
    if (thrown?.thrown === SERVER_ONLY) {
      // A server-only stub. STRIPPED when the stored record held a body.
      if (rec?.shape && !rec.stub) { entry.body = 'STRIPPED'; entry.opsWas = rec.ops ?? null; }
      entry.stale = findex !== entry.cached;
      // The annotation is a fact about the FUNCTION: the client has not
      // carried this body since such a build. Whether the SENTENCE was dealt
      // with is another fact, and it is about the citation as written: an
      // --accept recorded it while its number was true. A gated accept only
      // ever writes such records; one whose key and findex differ was let
      // through by --with-stale-citations - nobody reworded that sentence -
      // and a stale citation with no record of its own was never accepted at
      // all. Neither is "recorded", or the deferral would turn into a licence
      // to stamp a fresh number on a sentence nobody re-read.
      const own = known?.[`${entry.name}@${entry.cached}`];
      const ownStub = own && typeof own === 'object' && own.stub ? own : null;
      const acceptedStale = !!ownStub && ownStub.findex !== entry.cached;
      entry.stub = {
        thrown: thrown.thrown, since: rec?.stub?.since ?? null,
        recorded: !!rec?.stub && (!entry.stale || (!!ownStub && !acceptedStale)),
        ...(acceptedStale ? { acceptedStale: true } : {}),
      };
      entry.state = 'STUB';
    } else {
      if (thrown) entry.throwsOnly = thrown.thrown;
      const leans = stubCallees(code, findex);
      if (leans.length) entry.leans = leans;
    }
    return b;
  };
  const record = (entry, pick, b) => {
    const out = { findex: pick.findex, qualified: pick.name };
    if (b) { out.ops = b.ops; out.shape = b.shape; }
    // A stub keeps the annotation it was first accepted with; a new one says
    // what the stored record knew of the body, for buildFingerprint to date.
    const rec = entry.rec;
    delete entry.rec;
    if (entry.stub) {
      out.stub = rec?.stub?.since
        ? { ...rec.stub, thrown: entry.stub.thrown }
        : { thrown: entry.stub.thrown, ...(rec?.shape && !rec.stub ? { bodyOps: rec.ops ?? null } : {}) };
    }
    return out;
  };

  // Pass 2: everything, the ambiguous ones aimed at the predicted findex.
  const resolved = {};
  const report = [];
  const typeNames = code.types ? memo(code, 'typeNames', () => (
    code.types.filter((t) => (t.kind === 11 || t.kind === 21) && t.name).map((t) => t.name))) : [];
  for (const { name, cached, files, sites: at, rec, live, recorded, recordedGone } of entries) {
    const key = `${name}@${cached}`;
    const where = at.map((s) => `${s.file}:${s.line}`);
    const printed = at.some((s) => s.printed);
    if (!live.length) {
      const entry = { name, cached, in: files, at: where, printed, state: 'MISSING', recordedGone: recordedGone ?? undefined };
      // "No longer exists" is a claim about the game; most of the time the
      // truth is about the spelling. Say which.
      const segs = name.split('.');
      const anchor = nearestAnchor(cached);
      const predicted = anchor ? cached + anchor.now - anchor.cached : null;
      let hint = null;
      for (let k = 1; k < segs.length && !hint; k++) {
        const tail = segs.slice(k).join('.');
        const c = candidatesOf(tail);
        if (!c.length) continue;
        const pick = predicted == null ? c[0] : c.reduce((best, x) => (Math.abs(x.findex - predicted) < Math.abs(best.findex - predicted) ? x : best));
        hint = { kind: 'spelling', text: `no function is spelled ${name}; ${tail} resolves - did you mean ${pick.name}@${pick.findex}${c.length > 1 ? ` (one of ${c.length})` : ''}`, suggestion: `${pick.name}@${pick.findex}` };
      }
      const norm = name.replace(/\$/g, '');
      const cls = !hint ? typeNames.find((t) => { const n = t.replace(/\$/g, ''); return n === norm || n.endsWith(`.${norm}`); }) : null;
      if (cls) {
        const same = entries.filter((e) => e.cached === cached && e.name !== name && e.live.length)
          .map((e) => `${e.name}@${cached}`);
        hint = { kind: 'class', text: `${cls} is a class, not a function${same.length ? ` - the same findex is cited as ${same.join(', ')}` : ''}; write the method after it` };
      }
      if (!hint && segs.length === 1 && (code.strings ?? []).includes(name)) {
        // Where to look. A prediction that equals the written number is none:
        // it says the anchors measured no shift, not that the number is good.
        const was = fromDeferral(key);
        const near = was ? was.predicted : predicted != null && predicted !== cached ? predicted : null;
        hint = {
          kind: 'local', predicted: near, ...(near != null ? { via: was ? deferralText(was) : viaOf(anchor) } : {}),
          text: `${name} is a local's or a closure's name in the debug info, not a function name - cite the closure as fn@N`
            + (was ? ` (near fn@${near}, approximately: ${deferralText(was)})`
              : near != null ? ` (near fn@${near} if its neighbours' shift holds, approximately: ${viaOf(anchor)})` : ''),
        };
      }
      if (hint) entry.hint = hint;
      report.push(entry);
      continue;
    }
    const still = live.find((x) => x.findex === cached);
    if (still) {
      const entry = { name, cached, in: files, at: where, printed, state: 'OK', qualified: still.name };
      const b = classify(entry, cached, rec);
      report.push(entry);
      resolved[key] = record(entry, still, b);
      continue;
    }
    const ambiguous = live.length > 1;
    const anchor = ambiguous ? nearestAnchor(cached) : null;
    const shift = anchor ? anchor.now - anchor.cached : 0;
    const predicted = cached + shift;
    const pick = live.reduce((best, x) => (Math.abs(x.findex - predicted) < Math.abs(best.findex - predicted) ? x : best));
    const off = Math.abs(pick.findex - predicted);
    const entry = { name, cached, in: files, at: where, printed, state: 'MOVED', now: pick.findex, qualified: pick.name, ambiguous };
    if (recorded) entry.via = 'the qualified name the fingerprint recorded';
    if (ambiguous) {
      entry.candidates = live.map((x) => `${x.name}@${x.findex}`);
      entry.via = anchor ? viaOf(anchor) : 'no anchor - nearest to the cache';
      entry.predicted = predicted;
      entry.off = off;
      entry.suspect = !anchor || off > SUSPECT_SLOTS;
      // Deferred as SUSPECT, and still written the same way: it stays one.
      // Its number is older than the table, so the shift above was measured
      // for other numbers - a candidate that happens to sit near the stale
      // one would otherwise pass as placed.
      if (!entry.suspect && deferredBy.get(key)?.state === 'SUSPECT') {
        entry.suspect = true;
        entry.via = `${entry.via} - but it was accepted stale as SUSPECT, and that shift is not one its number ever went through`;
      }
    }
    if (recordedGone) {
      // The function the fingerprint named is gone; whatever the bare name
      // found is a guess until someone looks.
      entry.recordedGone = recordedGone;
      entry.suspect = true;
      entry.via = `the recorded ${recordedGone} no longer exists - re-anchored by bare name only`;
    }
    const b = classify(entry, pick.findex, rec);
    report.push(entry);
    // A SUSPECT pick is not recorded. The table is what the next run trusts
    // over every heuristic ("the qualified name the fingerprint recorded"),
    // and a guess written into it by --accept --with-stale-citations would
    // come back as a fact and be re-anchored mechanically.
    if (entry.suspect) delete entry.rec;
    else resolved[key] = record(entry, pick, b);
  }

  // The anonymous ones. A closure has no name, so the only identity a patch
  // cannot renumber is its body: once a fingerprint has recorded the shape,
  // the same shape is looked for where the neighbours went. Before that there
  // is nothing to check a number against - but there is something to check it
  // AGAINST: a number that now lands on a named function, or on nothing, was
  // written on another build.
  const anon = new Map();
  for (const s of sites) if (s.form === 'anon') (anon.get(s.cached) ?? anon.set(s.cached, []).get(s.cached)).push(s);
  for (const [n, list] of anon) {
    const key = `fn@${n}`;
    const rec = known?.[key] && typeof known[key] === 'object' ? known[key] : null;
    const entry = {
      name: 'fn', cached: n, in: [...new Set(list.map((s) => s.file))].sort(),
      at: list.map((s) => `${s.file}:${s.line}`), printed: list.some((s) => s.printed), state: 'ANON',
    };
    const f = code.byFindex?.get?.(n);
    const named = code.fnNames?.get?.(n) ?? null;
    const here = hasBodies ? bodyShape(code, n) : null;
    const anchor = nearest(storedAnchors, n);
    const predicted = anchor ? n + anchor.now - anchor.cached : null;
    if (hasBodies) {
      entry.lands = !f ? 'no function at this findex' : named ? `the named function ${named}` : `an unnamed function, ${f.ops.length} ops${debugPlace(code, f)}`;
    }
    if (rec?.shape) {
      // A shape is not an identity by itself: one unnamed function in six
      // has a twin nearby (see closureNow). So the recorded closure is looked
      // for by everything the record holds, and when that leaves more than
      // one candidate nothing is resolved - the candidates are listed for a
      // person, and the number is never rewritten.
      const found = closureNow(code, rec, { at: n, near: predicted ?? n });
      if (found.hit === n) {
        entry.state = 'OK'; entry.ops = here.ops; entry.body = 'SAME';
        if (found.twins) entry.twins = found.twins;
        resolved[key] = { findex: n, anon: true, ops: here.ops, shape: here.shape, ...closureIdentity(code, n) };
      } else if (found.hit != null) {
        Object.assign(entry, { state: 'MOVED', now: found.hit, body: 'SAME', ambiguous: false, via: found.via });
        resolved[key] = { findex: found.hit, anon: true, ops: rec.ops, shape: rec.shape, ...closureIdentity(code, found.hit) };
      } else if (found.candidates.length) {
        entry.closure = list.some((s) => !s.bare);
        entry.stale = true;
        entry.twins = found.candidates;
        entry.twinsWhy = found.why;
        if (predicted != null && predicted !== n) entry.predicted = predicted;
      } else {
        entry.state = 'MISSING';
        entry.hint = { kind: 'anon', predicted, text: `${found.why} (${rec.ops} ops) - rewritten or gone` };
      }
    } else {
      // Never recorded: the number is all there is. `fn@` says closure, so
      // landing on a named function proves the number is from another build;
      // a bare number landing on one may even be current - but then the name
      // is the identity and has to be written, or the next patch loses it
      // again. Either way a person has to look.
      entry.closure = list.some((s) => !s.bare);
      entry.stale = hasBodies ? (!f || !!named) : null;
      if (named) entry.named = named;
      const was = storedAt.get(n);
      const def = deferredBy.get(key);
      const placed = fromDeferral(key);
      if (was && was.now !== n) entry.was = was;
      else if (def?.was?.name) {
        // The table that held a function at this number is the one before
        // the deferral; the deferral kept its name, and the name still
        // resolves or does not.
        const live = (def.was.qualified ? byQualified.get(def.was.qualified) : null) ?? (candidatesOf(def.was.name).length === 1 ? candidatesOf(def.was.name)[0] : null);
        entry.was = { name: def.was.name, qualified: def.was.qualified ?? null, now: live?.findex ?? null, deferred: true };
      }
      if (placed) {
        entry.predicted = placed.predicted;
        entry.via = deferralText(placed);
        entry.deferred = true;
      } else if (predicted != null && predicted !== n) {
        entry.predicted = predicted;
        entry.via = viaOf(anchor);
      }
      if (here && entry.stale === false) resolved[key] = { findex: n, anon: true, ops: here.ops, shape: here.shape, ...closureIdentity(code, n) };
    }
    report.push(entry);
  }
  return { resolved, report, sites, candidatesOf };
}
// A class block shifts as one; a candidate this far from the prediction is
// in some other class, whatever its name.
const SUSPECT_SLOTS = 32;
// How far from the predicted findex a recorded closure body is looked for.
const ANON_WINDOW = 4000;

function debugPlace(code, f) {
  const file = f?.debug && code.debugFiles?.length ? code.debugFiles[f.debug[0]] : null;
  return file ? ` of ${file}:${f.debug[1]}` : '';
}

// Every unnamed function with the recorded body shape within the window of a
// findex, nearest first.
function sameShapeNear(code, rec, predicted) {
  const out = [];
  for (const f of code.functions ?? []) {
    if (Math.abs(f.findex - predicted) > ANON_WINDOW || f.ops.length !== rec.ops) continue;
    if (code.fnNames?.has?.(f.findex)) continue;
    if (bodyShape(code, f.findex)?.shape !== rec.shape) continue;
    out.push(f.findex);
  }
  return out.sort((a, b) => Math.abs(a - predicted) - Math.abs(b - predicted) || a - b);
}

// The NAMED function a closure is made under. An unnamed function has no name
// to resolve by, but it is created somewhere - a StaticClosure or
// InstanceClosure op - and on the October 2026 build 6151 of the 6274 unnamed
// functions are created in exactly one place (113 in several, 10 in none that
// the bytecode shows). Following that one maker up until it has a name gives
// the closure an owner a patch cannot renumber. Null when any step of the way
// has no maker or more than one.
function closureOwner(code, findex) {
  const makers = memo(code, 'makers', () => {
    const m = new Map();
    for (const f of code.functions ?? []) {
      for (const o of f.ops) {
        if (o.op !== 'StaticClosure' && o.op !== 'InstanceClosure') continue;
        (m.get(o.args[1]) ?? m.set(o.args[1], new Set()).get(o.args[1])).add(f.findex);
      }
    }
    return m;
  });
  let cur = findex;
  for (let depth = 0; depth < 8; depth++) {
    const by = makers.get(cur);
    if (!by || by.size !== 1) return null;
    [cur] = by;
    const name = code.fnNames?.get?.(cur);
    if (name) return String(name);
  }
  return null;
}

// The closures of one owner that have one body shape, in findex order - the
// order the compiler emitted them, which is the order they stand in the
// source.
function closureSiblings(code, owner, rec) {
  const byOwner = memo(code, 'closuresByOwner', () => {
    const m = new Map();
    for (const f of code.functions ?? []) {
      if (code.fnNames?.has?.(f.findex)) continue;
      const o = closureOwner(code, f.findex);
      if (o) (m.get(o) ?? m.set(o, []).get(o)).push(f.findex);
    }
    return m;
  });
  return (byOwner.get(owner) ?? [])
    .filter((i) => code.byFindex.get(i)?.ops.length === rec.ops && bodyShape(code, i)?.shape === rec.shape)
    .sort((a, b) => a - b);
}

// What a fingerprint records of a closure besides its body: its owner, and
// which of the owner's closures with that body it is. The body alone is not
// an identity - two lambdas written alike compile alike, and 1100 of those
// 6274 unnamed functions have a twin within the window the resolver searches
// (`$HSkill.updateSkillInf` creates two identical 46-op closures ten source
// lines apart, and the model cites one of them).
function closureIdentity(code, findex) {
  const owner = code?.byFindex ? closureOwner(code, findex) : null;
  const b = owner ? bodyShape(code, findex) : null;
  if (!b) return {};
  const sibs = closureSiblings(code, owner, b);
  const nth = sibs.indexOf(findex) + 1;
  return nth ? { owner, nth, of: sibs.length } : {};
}

// Where a recorded closure is on this build: `hit`, or the `candidates` that
// nothing recorded can tell apart, with `why`.
//
//   an owner was recorded   its closures with that body are counted. As many
//                           as were recorded: the same one in order (the
//                           first of two is still the first of two). Another
//                           count: a lambda was added or removed in that
//                           function, and which is which is a person's call.
//   no owner                the unnamed functions with that body near the
//                           predicted findex. Exactly one: that one. Several,
//                           and the written number is still one of them: the
//                           number is taken at its word and the twins are
//                           reported (refusing here would refuse the very
//                           build the record was accepted on). Several, and
//                           it is not: candidates.
//
// "Nearest to the prediction" is deliberately not a rule: the prediction is a
// neighbour's shift and was two slots off for the one closure it was checked
// on, and twins sit one slot apart.
function closureNow(code, rec, { at, near }) {
  if (rec.owner) {
    const sibs = closureSiblings(code, rec.owner, rec);
    if (sibs.length && sibs.length === rec.of && rec.nth >= 1 && rec.nth <= sibs.length) {
      return {
        hit: sibs[rec.nth - 1],
        via: sibs.length === 1 ? `the body shape the fingerprint recorded - the one closure with it that ${rec.owner} creates`
          : `the body shape the fingerprint recorded - number ${rec.nth} of the ${rec.of} closures with it that ${rec.owner} creates, in source order`,
      };
    }
    if (sibs.length) {
      return { hit: null, candidates: sibs, why: `${rec.owner} created ${rec.of} closure${rec.of === 1 ? '' : 's'} with the recorded body on the accepted build and creates ${sibs.length} now - which of them this was cannot be read off the bytecode` };
    }
    const loose = sameShapeNear(code, rec, near);
    return {
      hit: null, candidates: loose,
      why: loose.length
        ? `${rec.owner}, which created it on the accepted build, creates no closure with the recorded body now; ${loose.length === 1 ? 'one unnamed function' : `${loose.length} unnamed functions`} within ${ANON_WINDOW} slots of fn@${near} ${loose.length === 1 ? 'has' : 'have'} that body, under another owner`
        : `${rec.owner}, which created it on the accepted build, creates no closure with the recorded body now, and no unnamed function within ${ANON_WINDOW} slots of fn@${near} has it`,
    };
  }
  const c = sameShapeNear(code, rec, near);
  if (c.length === 1) return { hit: c[0], via: `the body shape the fingerprint recorded - the only unnamed function with it within ${ANON_WINDOW} slots` };
  if (c.includes(at)) return { hit: at, twins: c.filter((x) => x !== at), via: 'the written number still lands on the recorded body' };
  return {
    hit: null, candidates: c,
    why: c.length
      ? `${c.length} unnamed functions within ${ANON_WINDOW} slots of fn@${near} have the recorded body, and the record names no owner to tell them apart`
      : `no unnamed function within ${ANON_WINDOW} slots of fn@${near} has the body the fingerprint recorded`,
  };
}

// The citations whose written number is not where the function lives, or
// that could not be placed at all. These are what --accept refuses on: the
// table would otherwise record a findex the source contradicts. A STUB at its
// current findex is not one of them (it is recorded with its annotation); a
// STUB whose number is stale is.
//
// Each entry also carries what the report could say about where an unplaced
// citation went - the predicted findex and what it rests on, the name the
// stored table held at a bare number. When the list is recorded as a deferral
// that is the only copy of it: the table written beside it measures no shift
// at all for a number older than itself.
export function staleCitations(report) {
  const out = [];
  for (const c of report ?? []) {
    const key = `${c.name}@${c.cached}`;
    const where = {};
    const predicted = c.state === 'MISSING' ? c.hint?.predicted : c.state === 'ANON' ? c.predicted : null;
    if (Number.isInteger(predicted)) { where.predicted = predicted; where.via = (c.state === 'MISSING' ? c.hint.via : c.via) ?? null; }
    if (c.state === 'ANON' && c.was?.name) where.was = { name: c.was.name, qualified: c.was.qualified ?? null };
    if (c.state === 'MISSING') out.push({ key, state: 'MISSING', in: c.in, ...where });
    else if (c.suspect) out.push({ key, state: 'SUSPECT', now: c.now, in: c.in });
    else if (c.state === 'MOVED') out.push({ key, state: 'MOVED', now: c.now, in: c.in });
    else if (c.state === 'STUB' && c.stale) out.push({ key, state: 'STUB', now: c.now, in: c.in });
    else if (c.state === 'ANON' && c.stale) out.push({ key, state: 'ANON', in: c.in, ...where });
  }
  return out;
}

// May this build be accepted? The answer and the reason, with nothing
// written - the command prints it and the suite pins it.
//   --against   the diff on screen is against some other copy of the data,
//               not against the fingerprint being replaced: accepting would
//               record a comparison nobody was shown.
//   bytecode    without a readable boot there is no citation table to record.
//   citations   stale ones block, naming the tool that fixes the free ones;
//               --with-stale-citations is the conscious deferral and the list
//               goes into the fingerprint so the deferral stays visible:
//               every later `bench update` reads it back (deferredCitations)
//               and says which of them are still owed.
export function acceptGate({ report = [], codeError = null, against = false, withStale = false } = {}) {
  if (against) return { ok: false, stale: [], reason: '--accept cannot be combined with --against: the diff shown is against another copy of the data, not against the fingerprint being replaced' };
  if (codeError) return { ok: false, stale: [], reason: `the bytecode is unreadable (${codeError}), so the citation table cannot be recorded - fix the reader first` };
  const stale = staleCitations(report);
  if (stale.length && !withStale) {
    const by = (st) => stale.filter((x) => x.state === st).length;
    const parts = ['MOVED', 'MISSING', 'SUSPECT', 'STUB', 'ANON'].filter((st) => by(st))
      .map((st) => `${by(st)} ${st === 'STUB' ? 'STUB with a stale number' : st === 'ANON' ? 'anonymous and stale' : st}`);
    return {
      ok: false, stale,
      reason: `${stale.length} citation${stale.length > 1 ? 's are' : ' is'} stale (${parts.join(', ')}): ${stale.slice(0, 8).map((x) => x.key).join(', ')}${stale.length > 8 ? ', ...' : ''}. `
        + 'Run `bench update --reanchor` to see what can be rewritten mechanically and what needs a person, '
        + 'or pass --with-stale-citations to accept anyway and have the list recorded in the fingerprint',
    };
  }
  return { ok: true, stale };
}

// What became of the citations a previous --accept --with-stale-citations let
// through. The list was put in the fingerprint so the deferral would stay
// visible, and for that something has to read it back: each entry against
// today's report - still written the same way and still stale (`open`),
// written the same way and resolving now (OK), or no longer written that way
// at all (GONE: someone rewrote the sentence, which is how most get fixed).
export function deferredCitations(stored, report) {
  const list = Array.isArray(stored?.staleCitations) ? stored.staleCitations : [];
  if (!list.length) return [];
  const now = new Map((report ?? []).map((c) => [`${c.name}@${c.cached}`, c]));
  const stale = new Map(staleCitations(report).map((x) => [x.key, x.state]));
  return list.map((d) => {
    const c = now.get(d.key);
    return {
      // A bare number is shown the way it is written, without the fn it never had.
      key: d.key, label: c?.state === 'ANON' && c.closure === false ? `@${c.cached}` : d.key,
      was: d.state, state: stale.get(d.key) ?? (c ? 'OK' : 'GONE'), open: stale.has(d.key), at: c?.at ?? [],
    };
  });
}

// Is the stored fingerprint missing something this version records, on the
// very build it was accepted on? Then --accept has work to do even though the
// install did not change: a table written before hooks, talents, schemas, body
// shapes or stub annotations existed cannot diff them at the next patch. With
// today's report in hand, a deferral list that still names a citation which is
// no longer stale is one more thing to rewrite: it says work is owed that was
// done.
export function fingerprintGaps(stored, current, { report = null } = {}) {
  const gaps = [];
  for (const k of ['core', 'numeric', 'hooks', 'talents', 'others', 'schema', 'code']) {
    if (!stored?.[k] && current?.[k]) gaps.push(k);
  }
  const strip = (t) => JSON.stringify(Object.fromEntries(Object.entries(t ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  if (current?.citations && strip(stored?.citations) !== strip(current.citations)) gaps.push('citations');
  if (report && deferredCitations(stored, report).some((d) => !d.open)) gaps.push('staleCitations');
  return gaps;
}

// --- re-anchoring ------------------------------------------------------------
//
// The mechanical half of a patch day: every citation whose function merely
// moved gets its number rewritten where it is written. What it will NOT do is
// the half that needs a reader:
//
//   MOVED, one candidate      the number, spelling untouched
//   MOVED, several candidates the number AND the shortest qualified spelling
//                             that names exactly the function picked, so the
//                             citation is not ambiguous a second time
//   STUB an --accept recorded at a number that was true
//                             the number - the sentence was dealt with when
//                             the annotation was accepted, and the function
//                             has merely moved since
//   STUB seen for the first time, or accepted STALE (--with-stale-citations
//   dates the stub and leaves the sentence as it was), SUSPECT, MISSING,
//   anonymous                 never rewritten; listed under MANUAL with what
//                             is known (where it resolved, the predicted
//                             findex, whether the sentence is printed to the
//                             user). A fresh number on "read from X ops 83-87"
//                             over a three-op stub would be a forged re-read.
//
// Spellings that share one cached findex must land on one new findex; when
// they do not, none of them is rewritten.
export function planReanchor(code, roots, { known = null, only = null, deferred = null } = {}) {
  const res = resolveCitations(code, roots, { known, deferred });
  const edits = [], manual = [];
  const shortest = (qualified) => {
    const segs = String(qualified).split('.');
    for (let k = 1; k <= segs.length; k++) {
      const suffix = segs.slice(-k).join('.');
      const c = res.candidatesOf(suffix);
      if (c.length === 1 && c[0].name === qualified) return suffix;
    }
    return null;
  };
  const sitesOf = new Map();
  for (const s of res.sites) {
    const key = `${s.name}@${s.cached}`;
    (sitesOf.get(key) ?? sitesOf.set(key, []).get(key)).push(s);
  }
  // One old findex, one new findex - among the spellings that are STALE. A
  // spelling whose number is already true says nothing about them: the new
  // findex of one function is routinely the old findex of another.
  const landings = new Map();
  for (const c of res.report) {
    if (c.name === 'fn' || c.state === 'MISSING' || c.state === 'OK' || (c.state === 'STUB' && !c.stale)) continue;
    const now = c.now ?? c.cached;
    (landings.get(c.cached) ?? landings.set(c.cached, new Map()).get(c.cached)).set(c.name, now);
  }
  const wanted = (s) => !only || s.path.replace(/\\/g, '/').includes(String(only).replace(/\\/g, '/'));
  for (const c of res.report) {
    const key = `${c.name}@${c.cached}`;
    const at = (sitesOf.get(key) ?? []).filter(wanted);
    if (!at.length) continue;
    const say = (why, extra = {}) => manual.push({
      // A bare number is shown the way it is written ("@N", "findex N",
      // "fn N"), without the fn@ it never had.
      key, label: c.state === 'ANON' && c.closure === false ? at[0].text : key, state: c.suspect ? 'SUSPECT' : c.state, why,
      at: at.map((s) => `${s.file}:${s.line}`), printed: at.some((s) => s.printed), ...extra,
    });
    if (c.state === 'OK') continue;
    if (c.state === 'MISSING') { say(c.hint?.text ?? 'no function of that name on this build - the formula it anchored is unverified until the new code is read'); continue; }
    if (c.state === 'ANON') {
      say(anonWhy(c), { predicted: c.predicted ?? undefined });
      continue;
    }
    if (c.state === 'STUB' && !c.stub?.recorded) {
      say(`${c.qualified}@${c.now ?? c.cached} is a server-only stub on this build (${c.ops} ops, throws "${c.stub.thrown}") - the body this sentence read is not in the client any more; reword it to say which build the read dates from`
        + (c.stale ? `. The number is stale too (now @${c.now})` : '')
        + (c.stub.acceptedStale ? `. It was accepted stale${c.stub.since ? ` on ${String(c.stub.since).slice(0, 10)}` : ''} (--with-stale-citations): that dated the stub, it did not deal with this sentence`
          : c.stale && c.stub.since ? `. The stub is annotated since ${String(c.stub.since).slice(0, 10)}, but no --accept ever recorded this sentence at a number that was true` : ''),
      { now: c.now ?? c.cached });
      continue;
    }
    if (c.state === 'STUB' && !c.stale) continue;
    if (c.suspect) {
      say(`could not be placed: ${c.off ?? '?'} slots off ${c.via}; candidates ${(c.candidates ?? []).join(', ')} - qualify it as Class.method@findex`, { now: c.now });
      continue;
    }
    const lands = landings.get(c.cached);
    if (lands && new Set(lands.values()).size > 1) {
      say(`spellings of @${c.cached} disagree on where it went: ${[...lands].map(([n, f]) => `${n} -> @${f}`).join(', ')}`, { now: c.now });
      continue;
    }
    // MOVED (or an annotated STUB whose number went stale).
    let newName = null;
    if (c.ambiguous) {
      newName = shortest(c.qualified);
      if (!newName) { say(`moved to ${c.qualified}@${c.now}, but no spelling names that function alone`, { now: c.now }); continue; }
    }
    for (const s of at) {
      const name = newName ?? s.name;
      const to = s.text.slice(0, s.nameStart != null ? s.nameStart - s.start : 0)
        + (s.nameStart != null ? name : '')
        + s.text.slice(s.nameStart != null ? s.nameEnd - s.start : 0, s.numStart - s.start)
        + String(c.now) + s.text.slice(s.numEnd - s.start);
      edits.push({
        path: s.path, file: s.file, line: s.line, start: s.start, end: s.end, from: s.text, to,
        why: c.ambiguous ? `${c.qualified}, placed via ${c.via}` : c.qualified ?? c.via ?? 'the recorded body shape',
        body: c.body ?? null, printed: s.printed,
      });
    }
  }
  return { edits, manual, report: res.report };
}

// What can be said of a number nobody recorded: where it lands on this build,
// and what the accepted build's table knew about it. Nothing here is a
// resolution - every clause says what it rests on.
export function anonWhy(c) {
  // A recorded closure that more than one function could be.
  if (c.twins && c.state === 'ANON') {
    return `${c.twinsWhy}: ${c.twins.map((x) => `fn@${x}`).join(', ')}. Read them and write the number of the one the sentence means`
      + (c.predicted != null ? ` (its neighbours' shift points near @${c.predicted} - approximately, and twins sit closer together than that is accurate)` : '');
  }
  const head = c.stale == null ? `an anonymous citation, never recorded (the bytecode was not opened)`
    : !c.lands || /^no function/.test(c.lands) ? `no function has findex ${c.cached} on this build - the number is from another one`
    : c.named && c.closure ? `fn@ cites a closure, and @${c.cached} is the named function ${c.named} on this build - the number predates it`
    : c.named ? `a bare number: on this build @${c.cached} is ${c.named}. If that is the function meant, write the name in front so the name tracks it; if it is not, the number predates this build`
    : `it lands on ${c.lands}; nothing but the number identifies it until --accept records that body`;
  const now = c.was?.now != null ? ` - that function is now @${c.was.now}` : '';
  const was = c.was
    // After a deferral the table that held it is the one BEFORE the accepted one.
    ? (c.was.deferred ? `. When it was accepted stale, the table of the build before had ${c.was.name} at @${c.cached}${now}`
      : `. The accepted build's table has ${c.was.name} at @${c.cached}${now}`)
    : c.predicted == null ? ''
    : c.deferred ? `. Its function is now near @${c.predicted} - approximately: ${c.via}`
    : `. If it was written on the accepted build its function is now near @${c.predicted} - approximately, via ${c.via}`;
  return head + was;
}

// Write a plan's edits. Each one is checked against the text it expects at
// the position it recorded; a file that changed underneath is left alone and
// reported, never half-rewritten.
export function applyReanchor(plan) {
  const byPath = new Map();
  for (const e of plan.edits) (byPath.get(e.path) ?? byPath.set(e.path, []).get(e.path)).push(e);
  const written = [], skipped = [];
  for (const [path, list] of byPath) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const ok = list.every((e) => lines[e.line - 1]?.slice(e.start, e.end) === e.from);
    if (!ok) { skipped.push(path); continue; }
    // Right to left within a line, so earlier columns stay true.
    for (const e of [...list].sort((a, b) => b.line - a.line || b.start - a.start)) {
      const l = lines[e.line - 1];
      lines[e.line - 1] = l.slice(0, e.start) + e.to + l.slice(e.end);
    }
    writeFileSync(path, lines.join('\n'));
    written.push({ path, edits: list.length });
  }
  return { written, skipped };
}

export function diffSchema(oldSchema, newSchema) {
  // A fingerprint recorded before schemas were tracked has nothing to diff
  // against; say so rather than reporting every column as new.
  if (!oldSchema) return { unknown: true, sheets: {}, customTypes: {} };
  const sheets = {};
  const a = oldSchema.sheets ?? {}, b = newSchema.sheets ?? {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const ac = a[name], bc = b[name];
    if (!ac) { sheets[name] = { newSheet: true, added: Object.keys(bc), removed: [], changed: [] }; continue; }
    if (!bc) { sheets[name] = { goneSheet: true, added: [], removed: Object.keys(ac), changed: [] }; continue; }
    const added = Object.keys(bc).filter((c) => !(c in ac));
    const removed = Object.keys(ac).filter((c) => !(c in bc));
    const changed = [];
    for (const col of Object.keys(bc)) {
      if (!(col in ac) || ac[col] === bc[col]) continue;
      const eo = enumCases(ac[col]), en = enumCases(bc[col]);
      if (eo && en && eo.kind === en.kind) {
        const o = eo.cases, n = en.cases;
        const keptOld = o.filter((x) => n.includes(x));
        const keptNew = n.filter((x) => o.includes(x));
        changed.push({
          col, from: ac[col], to: bc[col],
          casesAdded: n.filter((x) => !o.includes(x)),
          casesRemoved: o.filter((x) => !n.includes(x)),
          reordered: keptOld.some((x, i) => keptNew[i] !== x),
          // A case removed from the MIDDLE reorders nothing and still moves
          // every later case one index down: the kept cases whose number
          // changed. Rows store the number.
          shifted: keptOld.filter((x) => o.indexOf(x) !== n.indexOf(x)),
        });
      } else {
        changed.push({ col, from: ac[col], to: bc[col] });
      }
    }
    if (added.length || removed.length || changed.length) sheets[name] = { added, removed, changed };
  }
  const customTypes = {};
  const ta = oldSchema.customTypes ?? {}, tb = newSchema.customTypes ?? {};
  for (const name of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
    if (ta[name] === tb[name]) continue;
    const o = ta[name] ? ta[name].split('|') : [], n = tb[name] ? tb[name].split('|') : [];
    customTypes[name] = {
      added: n.filter((x) => !o.includes(x)), removed: o.filter((x) => !n.includes(x)),
      newType: !(name in ta), goneType: !(name in tb),
    };
  }
  return { unknown: false, sheets, customTypes };
}

// Classes that arrived, left, or changed their method set, in the packages
// the model cites.
function diffCode(oldCode, newCode) {
  if (!oldCode?.classes || !newCode?.classes) return { unknown: true, added: [], removed: [], changed: [] };
  const a = oldCode.classes, b = newCode.classes;
  // A package only one side tracked is newly cited, not newly written.
  const both = new Set((oldCode.packages ?? []).filter((p) => (newCode.packages ?? []).includes(p)));
  const tracked = (cls) => both.has(packageOfClass(cls));
  const changed = [];
  for (const cls of Object.keys(b)) {
    if (!(cls in a) || a[cls] === b[cls]) continue;
    const entry = { cls, from: Number(a[cls].split(':')[0]), to: Number(b[cls].split(':')[0]), cited: cls in (newCode.methods ?? {}) };
    const om = oldCode.methods?.[cls], nm = newCode.methods?.[cls];
    if (om != null && nm != null) {
      const o = new Set(om.split(' ')), n = new Set(nm.split(' '));
      entry.methodsAdded = [...n].filter((x) => !o.has(x));
      entry.methodsRemoved = [...o].filter((x) => !n.has(x));
    }
    changed.push(entry);
  }
  return {
    unknown: false,
    added: Object.keys(b).filter((c) => !(c in a) && tracked(c)),
    removed: Object.keys(a).filter((c) => !(c in b) && tracked(c)),
    changed,
  };
}

export function diffFingerprints(oldFp, newFp) {
  const sheets = {};
  for (const name of new Set([...Object.keys(oldFp.sheets ?? {}), ...Object.keys(newFp.sheets ?? {})])) {
    const a = oldFp.sheets?.[name];
    const b = newFp.sheets?.[name] ?? {};
    // A sheet the fingerprint never held is newly tracked, not N added rows:
    // there is nothing to validate, --accept simply starts recording it.
    if (!a) { sheets[name] = { newlyTracked: true, added: Object.keys(b), removed: [], changed: [], cosmeticOnly: [] }; continue; }
    // A fingerprint recorded before blank ids were dropped may hold one; it is
    // not a removed row, it was never a row.
    const added = Object.keys(b).filter((id) => !(id in a));
    const removed = Object.keys(a).filter((id) => id !== '' && !(id in b));
    const changed = Object.keys(b).filter((id) => id in a && a[id] !== b[id]);
    // Changed in nothing a number depends on - its texts or visuals, or the
    // index an enum it stores was renumbered to - when both sides carry the
    // second hash to say so.
    const ca = oldFp.core?.[name], cb = newFp.core?.[name];
    const cosmeticOnly = ca && cb ? changed.filter((id) => id in ca && id in cb && ca[id] === cb[id]) : [];
    // Without the second hash on both sides "changed" cannot be split at
    // all, and the work list must not pretend it was.
    const na = oldFp.numeric?.[name], nb = newFp.numeric?.[name];
    const flagOnly = na && nb ? changed.filter((id) => !cosmeticOnly.includes(id) && id in na && id in nb && na[id] === nb[id]) : [];
    if (added.length || removed.length || changed.length) sheets[name] = { added, removed, changed, cosmeticOnly, flagOnly, coreKnown: !!(ca && cb) };
  }
  const a = oldFp.scripts ?? {};
  const b = newFp.scripts ?? {};
  const scripts = {
    added: Object.keys(b).filter((id) => !(id in a)),
    removed: Object.keys(a).filter((id) => !(id in b)),
    changed: Object.keys(b).filter((id) => id in a && a[id] !== b[id]),
  };
  // Hooks: per script, the names it did not declare before; and globally, the
  // names no script declared before - a new event the game raises. And per
  // REMOVED script, the hooks that went with it: those no longer run.
  if (oldFp.hooks && newFp.hooks) {
    const everOld = new Set(Object.values(oldFp.hooks).flat());
    scripts.hooksAdded = {};
    for (const id of [...scripts.changed, ...scripts.added]) {
      const before = new Set(oldFp.hooks[id] ?? []);
      const fresh = (newFp.hooks[id] ?? []).filter((n) => !before.has(n));
      if (fresh.length) scripts.hooksAdded[id] = fresh;
    }
    scripts.newHookNames = [...new Set(Object.values(scripts.hooksAdded).flat())].filter((n) => !everOld.has(n)).sort();
  } else {
    scripts.hooksUnknown = true;
  }
  if (oldFp.hooks) {
    scripts.hooksRemoved = {};
    for (const id of scripts.removed) if (oldFp.hooks[id]?.length) scripts.hooksRemoved[id] = oldFp.hooks[id];
  }
  // Talents, by class.
  const talents = {};
  if (oldFp.talents && newFp.talents) {
    for (const unit of new Set([...Object.keys(oldFp.talents), ...Object.keys(newFp.talents)])) {
      const ta = oldFp.talents[unit] ?? {}, tb = newFp.talents[unit] ?? {};
      const d = {
        added: Object.keys(tb).filter((s) => !(s in ta)),
        removed: Object.keys(ta).filter((s) => !(s in tb)),
        changed: Object.keys(tb).filter((s) => s in ta && ta[s] !== tb[s]).map((s) => ({ skill: s, from: ta[s], to: tb[s] })),
      };
      if (d.added.length || d.removed.length || d.changed.length) talents[unit] = d;
    }
  }
  // Sheets nobody reads, changed anyway.
  const others = oldFp.others && newFp.others
    ? Object.keys(newFp.others).filter((s) => s in oldFp.others && oldFp.others[s] !== newFp.others[s])
    : null;
  return {
    same: oldFp.cdbSha === newFp.cdbSha && oldFp.bootSha === newFp.bootSha,
    cdbChanged: oldFp.cdbSha !== newFp.cdbSha,
    bootChanged: oldFp.bootSha !== newFp.bootSha,
    sheets,
    scripts,
    talents,
    // An empty `talents` from a fingerprint that never held them is not "no
    // talent moved". The report has to be able to tell.
    talentsUnknown: !(oldFp.talents && newFp.talents),
    othersChanged: others ?? [],
    othersUnknown: others === null,
    schema: diffSchema(oldFp.schema ?? null, newFp.schema ?? { sheets: {}, customTypes: {} }),
    code: diffCode(oldFp.code ?? null, newFp.code ?? null),
  };
}

// Source files as one list, for the questions the work list asks of them: is
// this removed id named anywhere, is this new enum case or hook quoted.
function sourceText(roots, opts) {
  const files = citationFiles(roots, opts);
  if (!files.length) return null;
  return files.map((f) => ({ file: f.label, text: readFileSync(f.path, 'utf8'), prose: f.prose }));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `file:line` for the first places an id is named, or null. Comments count: a
// comment citing a row is a claim about it. An id is matched as a whole word -
// a short id must not hit a longer one that merely ends with it - and an id
// that is nothing but one plain word (no underscore, digit or inner capital)
// counts in CODE only where it is quoted, backticked or read as a property:
// as a bare word it is English, and "second wind" in a comment is not a
// citation of an affinity row. In the living documents every whole word still
// counts - prose is where a row is named bare. (No row id as an example here:
// this file is scanned too.)
function citedAt(files, literal, cap = 3) {
  if (!files || !literal || !String(literal).trim()) return null;
  const lit = escapeRe(literal);
  const word = new RegExp(`(^|[^A-Za-z0-9_])${lit}(?![A-Za-z0-9_])`);
  const strict = new RegExp(`['"\`]${lit}['"\`]|\\.${lit}(?![A-Za-z0-9_])`);
  const plain = /^[A-Za-z][a-z]*$/.test(String(literal));
  const hits = [];
  for (const { file, text, prose } of files) {
    const re = plain && !prose ? strict : word;
    if (!re.test(text)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < cap; i++) {
      if (re.test(lines[i])) hits.push(`${file}:${i + 1}`);
    }
    if (hits.length >= cap) break;
  }
  return hits.length ? hits : null;
}

// The source with its comments removed: what the readers EXECUTE, which is
// the only text that can name an enum case or a hook they decode.
function codeOnly(src) {
  return (src ?? []).map(({ text }) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\`])\/\/.*$/gm, '$1')).join('\n');
}

// Rows whose id reads like a developer's scratch entry. They ship in data.cdb
// like everything else and, unflagged, become candidates the optimiser offers.
export const DEV_ROW = /^test$|(^|_)test(r|_delete)?$|_Test$|^TODO_|^infusion_test/i;

// What changed INSIDE a row, as JSON paths with the old and the new value -
// the difference between "rarity Epic changed" and "props.iLevelBonus 30 ->
// 50". Both rows go through the same decode the second hash uses, so a flags
// column reads as the names gained and lost and a renumbered enum reads as
// nothing. Only possible with the old ROW in hand: the fingerprint keeps
// hashes, so this needs --against or the copy --accept leaves on this machine.
export function rowPaths(oldRow, newRow, { cap = 6 } = {}) {
  const out = [];
  let more = 0;
  const brief = (v) => {
    if (v === undefined) return undefined;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  };
  const isObj = (v) => v !== null && typeof v === 'object';
  const names = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const walk = (x, y, path) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (names(x) && names(y)) {
      const gained = y.filter((n) => !x.includes(n)), lost = x.filter((n) => !y.includes(n));
      if (gained.length || lost.length) { push({ path, gained, lost }); return; }
    }
    if (isObj(x) && isObj(y) && Array.isArray(x) === Array.isArray(y)) {
      const keys = Array.isArray(x)
        ? [...Array(Math.max(x.length, y.length)).keys()]
        : [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const k of keys) walk(x[k], y[k], Array.isArray(x) ? `${path}[${k}]` : (path ? `${path}.${k}` : String(k)));
      return;
    }
    push({ path, from: brief(x), to: brief(y) });
  };
  const push = (p) => { if (out.length < cap) out.push(p); else more++; };
  walk(oldRow, newRow, '');
  if (more) out.push({ more });
  return out;
}

// What changed in a skill's script: whether it arrived, left or was edited,
// the hooks it gained and lost, and the lines that are in one text and not in
// the other (trimmed, counted, in the order they stand - not an alignment,
// just what a reader needs to find the edit). Null when the text is the same.
export function scriptDiff(oldScript, newScript) {
  const a = typeof oldScript === 'string' ? oldScript : '', b = typeof newScript === 'string' ? newScript : '';
  if (a === b) return null;
  const linesOf = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const la = linesOf(a), lb = linesOf(b);
  const only = (xs, ys) => {
    const left = new Map();
    for (const y of ys) left.set(y, (left.get(y) ?? 0) + 1);
    return xs.filter((x) => { const n = left.get(x) ?? 0; if (n) left.set(x, n - 1); return !n; });
  };
  const ha = hooksOf(a), hb = hooksOf(b);
  const removed = only(la, lb), added = only(lb, la);
  return {
    state: !a.trim() ? 'ADDED' : !b.trim() ? 'REMOVED' : 'CHANGED',
    hooks: hb, hooksGained: hb.filter((x) => !ha.includes(x)), hooksLost: ha.filter((x) => !hb.includes(x)),
    removed, added,
    // The hash is of the text as it stands, so it moves on an indent too.
    layoutOnly: !removed.length && !added.length,
  };
}

// One row, old against new, every path - what `bench update --row` prints.
// Null when either side has no such row. The paths come from the decode the
// second hash uses, and that hash leaves a skill's script out (it has a hash
// and a work item of its own) - so for a skill the script is compared here as
// well, as one more entry: a row printed in full that left it out said
// "nothing changed" of the 47 skill rows the October 2026 patch changed in
// their script alone (counted against a July copy of the data).
export function rowDiff(oldCdb, cdb, sheet, id) {
  let o, n;
  try { o = oldCdb.byId(sheet).get(id); n = cdb.byId(sheet).get(id); } catch { return null; }
  if (!o || !n) return null;
  const paths = rowPaths(coreOf(oldCdb, sheet, o), coreOf(cdb, sheet, n), { cap: Infinity });
  const script = sheet === 'skill' ? scriptDiff(o.script, n.script) : null;
  if (script) paths.push({ path: 'script', script });
  return paths;
}

const describeScript = (s) => `script ${s.state}`
  + (s.hooksGained.length ? `, hooks +${s.hooksGained.join(' +')}` : '') + (s.hooksLost.length ? `${s.hooksGained.length ? '' : ', hooks'} -${s.hooksLost.join(' -')}` : '')
  + (s.state !== 'CHANGED' ? '' : s.layoutOnly ? ' in its layout only (the same lines, another indent or order)'
    : `: ${s.removed.length} line${s.removed.length === 1 ? '' : 's'} out, ${s.added.length} in`);

// What `bench update --row` prints for one row: a line per path, the script's
// own lines under its entry, and "nothing changed" only when nothing did -
// said of the row, and of the script by name when the row is a skill.
export function rowLines(sheet, paths) {
  const lines = [];
  for (const p of paths ?? []) {
    lines.push(describePaths([p]));
    if (!p.script) continue;
    for (const l of p.script.removed) lines.push(`  - ${l}`);
    for (const l of p.script.added) lines.push(`  + ${l}`);
  }
  if (!lines.length) lines.push(sheet === 'skill' ? 'nothing a number depends on changed, and the script is the same text' : 'nothing a number depends on changed');
  return lines;
}

export function describePaths(paths) {
  return (paths ?? []).map((p) => {
    if (p.more) return `+${p.more} more`;
    if (p.script) return describeScript(p.script);
    if (p.gained || p.lost) return `${p.path}${p.gained.length ? ` +${p.gained.join(' +')}` : ''}${p.lost.length ? ` -${p.lost.join(' -')}` : ''}`;
    if (p.from === undefined) return `${p.path} ADDED ${p.to}`;
    if (p.to === undefined) return `${p.path} REMOVED (was ${p.from})`;
    return `${p.path} ${p.from} -> ${p.to}`;
  }).join('; ');
}

// Who can reach a skill row, read off the data instead of guessed from an id.
//
// The schema says exactly where a skill can be named: the columns typed as a
// reference to the skill sheet. Three kinds of row carry them, and they are
// three different answers to "where do I stand to validate this":
//
//   KIT    a class (a unit with talent trees, and what it inherits), an item,
//          an item type - including the `<itemType>_Upgrade` perk, which no
//          column names: Weapon.getWeaponUpgradeSkill composes the id from the
//          item type and looks it up (the same rule src/catalog.mjs reads).
//          Something a player can own, so a dummy session exists.
//   OTHER  any other sheet with such a column - a faction's reputation
//          rewards, a profession's upgrades, a world element. Named, real,
//          and not a kit: the host is said, nothing is promised about it.
//   FOE    a unit without talent trees. The model prices what a player does
//          TO a target, never what the target casts.
//
// From each root the closure follows what a skill row names: other skills
// (any string that is a skill id, and any identifier in its script), and the
// units it summons - whose own skills then belong to whoever summoned them, so
// a player's pet attack is the player's and not "a foe skill". Last, and only
// for rows nothing else reaches, the references a skill's TOOLTIP holds
// (`texts.refs`, three columns typed as skill references): a tooltip that
// prints a row's numbers does not apply that row, but it does say whose it
// is - Warrior_BurstOfAnger has no script and no step naming its status, and
// its tooltip refers to Warrior_BurstOfAnger_Status. The chain says so
// ("> its tooltip"). KIT wins over OTHER wins over FOE. A row none of them
// reaches is none of them and is reported as that - with the skill rows that
// do name it, when some do: "named by no data row" was said of rows another
// (unreached) skill row names in a step.
function skillReach(cdb) {
  let skills, units;
  try { skills = cdb.byId('skill'); units = cdb.byId('unit'); } catch { return null; }
  const TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g;
  const tipCols = (cdb.sheets?.get?.('skill@texts@refs')?.columns ?? [])
    .filter((c) => String(c.typeStr) === '6:skill').map((c) => c.name);
  // Every skill id and unit id a row mentions outside its texts, and (`tips`)
  // the skills its tooltip refers to.
  const refsCache = new Map();
  const refsOf = (row) => {
    if (refsCache.has(row)) return refsCache.get(row);
    const sk = new Set(), un = new Set(), tips = new Set();
    const walk = (v, k) => {
      if (typeof v === 'string') {
        if (k === 'script') { for (const m of v.matchAll(TOKEN)) if (skills.has(m[0])) sk.add(m[0]); return; }
        if (skills.has(v)) sk.add(v);
        if (k === 'unit' && units.has(v)) un.add(v);
        return;
      }
      if (Array.isArray(v)) { for (const x of v) walk(x, k); return; }
      if (v && typeof v === 'object') for (const kk of Object.keys(v)) { if (kk !== 'texts') walk(v[kk], kk); }
    };
    walk(row, '');
    for (const c of tipCols) { const t = row?.texts?.refs?.[c]; if (typeof t === 'string' && skills.has(t)) tips.add(t); }
    const out = { sk, un, tips };
    refsCache.set(row, out);
    return out;
  };
  const parentsOf = (u) => (Array.isArray(u?.inherit) ? u.inherit : u?.inherit ? [u.inherit] : [])
    .map((p) => (typeof p === 'string' ? p : p?.ref)).filter((p) => typeof p === 'string');
  const isClass = (u) => (u?.talentTrees ?? []).length > 0;
  const closure = (roots) => {
    // skill id -> { root: 'item X', via: parent skill | null }
    const seen = new Map();
    const queue = [];
    const visit = (id, root, via) => { if (!seen.has(id) && skills.has(id)) { seen.set(id, { root, via }); queue.push(id); } };
    const unitsSeen = new Set();
    for (const { ids, root } of roots) for (const id of ids) visit(id, root, null);
    const drain = (tooltips) => {
      while (queue.length) {
        const id = queue.shift();
        const { sk, un, tips } = refsOf(skills.get(id));
        for (const s of sk) if (s !== id) visit(s, seen.get(id).root, id);
        for (const u of un) {
          if (unitsSeen.has(u)) continue;
          unitsSeen.add(u);
          // What a summoned unit casts belongs to the summoner.
          for (const s of refsOf(units.get(u)).sk) visit(s, seen.get(id).root, `${id} > unit ${u}`);
        }
        if (tooltips) for (const s of tips) if (s !== id) visit(s, seen.get(id).root, `${id} > its tooltip`);
      }
    };
    // Everything a step, a prop or a script reaches first; a tooltip only
    // places what is left, so no row is "reached through a tooltip" that a
    // real reference reaches too.
    drain(false);
    for (const id of [...seen.keys()]) {
      for (const s of refsOf(skills.get(id)).tips) if (s !== id) visit(s, seen.get(id).root, `${id} > its tooltip`);
    }
    drain(true);
    return seen;
  };

  const kitRoots = [], otherRoots = [], foeRoots = [];
  const classChain = new Set();
  for (const u of units.values()) {
    if (!isClass(u)) continue;
    const stack = [u.id];
    while (stack.length) {
      const id = stack.pop();
      if (classChain.has(id) || !units.has(id)) continue;
      classChain.add(id);
      const row = units.get(id);
      const inTree = new Set((row.talentTrees ?? []).flatMap((t) => [t.root, ...(t.talents ?? []).map((x) => x.skill)]).filter(Boolean));
      const ids = [...refsOf(row).sk];
      kitRoots.push({ ids: ids.filter((s) => inTree.has(s)), root: `${id} talent tree` });
      kitRoots.push({ ids: ids.filter((s) => !inTree.has(s)), root: id === u.id ? `class ${id}` : `unit ${id}, inherited by class ${u.id}` });
      stack.push(...parentsOf(row));
    }
  }
  const skillRef = (sheet) => [...(cdb.sheets ?? [])].some(([name, s]) => (
    name.split('@')[0] === sheet && (s.columns ?? []).some((c) => String(c.typeStr) === '6:skill')));
  for (const [name, s] of cdb.sheets ?? []) {
    if (name.includes('@') || name === 'skill' || name === 'unit' || !skillRef(name)) continue;
    const into = name === 'item' || name === 'itemType' ? kitRoots : otherRoots;
    for (const row of s.lines ?? []) {
      const { sk, un } = refsOf(row);
      const root = `${name} ${row.id ?? '?'}`;
      if (sk.size) into.push({ ids: [...sk], root });
      for (const u of un) if (units.has(u)) into.push({ ids: [...refsOf(units.get(u)).sk], root: `${root} > unit ${u}` });
    }
  }
  try {
    for (const t of cdb.lines('itemType')) {
      if (skills.has(`${t.id}_Upgrade`)) kitRoots.push({ ids: [`${t.id}_Upgrade`], root: `the upgrade perk of ${t.id} weapons` });
    }
  } catch { /* no itemType sheet: nothing composes an upgrade id */ }
  for (const u of units.values()) {
    if (classChain.has(u.id)) continue;
    const name = u.texts?.name ? ` ("${u.texts.name}")` : '';
    foeRoots.push({ ids: [...refsOf(u).sk], root: `unit ${u.id}${name}` });
  }
  const kit = closure(kitRoots), other = closure(otherRoots), foe = closure(foeRoots);
  const chain = (seen, id) => {
    const { root, via } = seen.get(id);
    const hops = [];
    for (let v = via, n = 0; v && n < 4; n++) {
      hops.unshift(v);
      const head = v.split(' > ')[0];
      v = seen.get(head)?.via ?? null;
    }
    return [root, ...hops].join(' > ');
  };
  // Who names a row that no root reaches. Every unit and every sheet with a
  // column typed as a skill reference is a root, so what is left can only be
  // named - in a step, a prop, a script or a tooltip - by another skill row,
  // one that is unreached itself or it would have carried this one along.
  // Built on first use.
  let namers = null;
  const namedBy = (id) => {
    if (!namers) {
      namers = new Map();
      for (const row of skills.values()) {
        const { sk, tips } = refsOf(row);
        for (const s of new Set([...sk, ...tips])) if (s !== row.id) (namers.get(s) ?? namers.set(s, []).get(s)).push(row.id);
      }
    }
    return namers.get(id) ?? [];
  };
  return {
    isClass: (id) => isClass(units.get(id)),
    // { side: 'kit' | 'other' | 'foe' | 'none', host } - and for 'none', the
    // skill rows that name it (`namedBy`), which may be none either.
    place(id) {
      if (kit.has(id)) return { side: 'kit', host: chain(kit, id) };
      if (other.has(id)) return { side: 'other', host: chain(other, id) };
      if (foe.has(id)) return { side: 'foe', host: chain(foe, id) };
      return { side: 'none', host: null, namedBy: namedBy(id) };
    },
    // No skill anywhere on its inherit chain, no stats of its own, no talent
    // tree: a merchant, a trainer, a critter - an NPC, not a combatant.
    isNpc(id) {
      const seen = new Set(), stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur) || !units.has(cur)) continue;
        seen.add(cur);
        const row = units.get(cur);
        if ((row.skills ?? []).length || isClass(row)) return false;
        stack.push(...parentsOf(row));
      }
      return units.has(id) && !(units.get(id).stats ?? []).length;
    },
  };
}

// What an item row IS, for the question "how would anyone validate this":
// worn for stats (its type chain reaches a slot the catalog scores, or it is
// an augment), a pointer to a skill, a consumable carrying stats, or none of
// those.
function itemKinds(cdb) {
  let types, displayCategories;
  try {
    types = cdb.byId('itemType');
    displayCategories = cdb.enumValues('itemType@slot', 'displayCategory');
  } catch { return null; }
  const chainOf = (typeId) => {
    const c = [];
    for (let cur = types.get(typeId), n = 0; cur && n < 32; cur = cur.inherit ? types.get(cur.inherit) : null, n++) c.push(cur.id);
    return c;
  };
  const combatSlots = new Set();
  for (const t of types.values()) {
    if (t.slot?.isSlot && COMBAT_CATEGORIES.has(displayCategories[t.slot.displayCategory ?? -1] ?? null)) combatSlots.add(t.id);
  }
  const wearable = new Set(), augment = new Set();
  for (const t of types.values()) {
    if ((t.slot?.equippableOn ?? []).some((e) => combatSlots.has(e.ref))) wearable.add(t.id);
    if ((t.props?.augmentTargets ?? []).length) augment.add(t.id);
  }
  return (item) => {
    const chain = chainOf(item?.type);
    if (chain.some((t) => wearable.has(t)) || chain.some((t) => augment.has(t))) return { kind: 'gear' };
    if (item?.props?.ref?.skill) return { kind: 'pointer', skill: item.props.ref.skill };
    const stats = (item?.affixes ?? []).map((a) => a?.target?.attribute).filter(Boolean);
    const statuses = (item?.props?.effects ?? []).flatMap((e) => (e.status ?? []).map((s) => s.ref)).filter(Boolean);
    if (stats.length || statuses.length) return { kind: 'consumable', stats, statuses };
    return { kind: 'other', type: item?.type ?? null };
  };
}

// The work list: every change, mapped to what it invalidates and how it gets
// re-validated. This is the honest half of the pipeline - the part that says
// which numbers cannot be trusted until a human logs in.
//
//   srcDir   the model's source: what the readers EXECUTE (is this case
//            quoted, is this column read, is this hook known)
//   roots    everywhere a row may be stated as fact (the citation roots): a
//            removed row named in a living document is a stale sentence too
//   oldCdb   the old rows, when there are any - then a changed row says WHAT
//            changed in it, and a flag flip is no longer sent to a SHEET
//            check that cannot see a flag
export function workList(diff, cdb, { srcDir = null, roots = null, oldCdb = null } = {}) {
  const items = [];
  const src = srcDir ? sourceText(srcDir, { lib: false }) : null;
  const stated = roots ? sourceText(roots) : src;
  const code = codeOnly(src);
  // "Named" means QUOTED in executed code - 'Area' in a comment, or inside
  // summonOwner, is not a reader knowing the case. "Read" means the column's
  // name occurs in executed code as a property or a quoted key; it errs
  // towards read, which errs towards model work. A hook is known when its
  // name occurs in executed code at all.
  const named = (word) => !!src && new RegExp(`['"\`]${escapeRe(word)}['"\`]`).test(code);
  const columnRead = (col) => !!src && new RegExp(`[.'"\`]${escapeRe(col)}(?![A-Za-z0-9_])`).test(code);
  const hookKnown = (name) => !!src && new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`).test(code);
  const reach = skillReach(cdb);
  const kindOfItem = itemKinds(cdb);
  const place = (id) => reach?.place(id) ?? { side: 'kit', host: null };
  // A row no class, item, unit or other sheet reaches. "Named by no data row"
  // is said only when that is what was found; a row some other skill row
  // names is said to be named by it, and that the namer is unreached too.
  const unreached = (at) => {
    const by = at.namedBy ?? [];
    if (!by.length) return 'named by no data row - applied from code, or dead';
    return `named only by skill${by.length === 1 ? '' : 's'} ${by.slice(0, 3).join(', ')}${by.length > 3 ? ` and ${by.length - 3} more` : ''}, and no class, item, unit or other sheet reaches ${by.length === 1 ? 'that row' : 'those rows'} - it is live only if code applies ${by.length === 1 ? by[0] : 'one of them'}`;
  };
  // A dev/test row is excluded, not validated. A TODO_ row is a live row
  // waiting for its final id - three merchants shed the prefix in the October
  // 2026 build - so it keeps whatever routing its content earns.
  const isDev = (id) => !/^TODO_/.test(id) && DEV_ROW.test(id);
  const devNote = (id) => (/^TODO_/.test(id)
    ? ' (named TODO_ - whether it is live is unverified)'
    : DEV_ROW.test(id) ? ' (reads like a dev/test row - exclude it rather than model it)' : '');
  const hookNote = (id) => {
    const fresh = diff.scripts.hooksAdded?.[id] ?? [];
    if (!fresh.length) return '';
    const unknown = fresh.filter((n) => !hookKnown(n));
    return ` - declares new hook${fresh.length > 1 ? 's' : ''} ${fresh.join(', ')}`
      + (unknown.length ? ` (never named in src/: ${unknown.join(', ')} - the readers cannot see what it does)` : '');
  };
  // The old row beside the new one, decoded the way the second hash is.
  const oldRows = (sheet) => { try { return oldCdb?.byId?.(sheet) ?? null; } catch { return null; } };
  const newRows = (sheet) => { try { return cdb.byId(sheet); } catch { return null; } };
  const pathsOf = (sheet, id) => {
    const o = oldRows(sheet)?.get(id), n = newRows(sheet)?.get(id);
    if (!o || !n) return null;
    const p = rowPaths(coreOf(oldCdb, sheet, o), coreOf(cdb, sheet, n));
    return p.length ? p : null;
  };
  const withPaths = (item, sheet, id) => {
    const p = pathsOf(sheet, id);
    if (p) { item.paths = p; item.why = `${describePaths(p)} - ${item.why}`; }
    return item;
  };

  // One item per skill id. A skill whose script AND row both moved is one
  // thing to re-read, not two - the report used to count 168 ids twice. The
  // second hash leaves the script out, so "the row changed too" means steps,
  // effects or vars really moved besides the text; a fingerprint without that
  // hash cannot say, and then nothing is claimed.
  const skillDiff = diff.sheets?.skill ?? {};
  const skillRowChanged = new Set(skillDiff.coreKnown
    ? (skillDiff.changed ?? []).filter((id) => !(skillDiff.cosmeticOnly ?? []).includes(id)) : []);
  const folded = new Set();
  const skillItem = (kind, id, needs, why, { script = false } = {}) => {
    const at = place(id);
    const also = script && skillRowChanged.has(id) ? '; the row changed too (steps, effects or vars)' : '';
    // The script item speaks for the row: its own "changed" or "added" entry
    // would be the same id a second time.
    if (script) folded.add(id);
    let item;
    if (isDev(id)) item = { kind, id, needs: 'none', why: `${why(at.host ?? 'no host')}${also}${devNote(id)}` };
    else if (at.side === 'foe') item = { kind, id, needs: 'none', why: `a foe skill - named by ${at.host} and by nothing a player can own; the model prices what a player does to a target, not what the target casts${hookNote(id)}` };
    else if (at.side === 'other') item = { kind, id, needs: 'model', why: `named by ${at.host} only - not a class, an item or a unit's kit, so there is no build to stand on; read what applies it before pricing or dismissing it${also}${hookNote(id)}` };
    else if (at.side === 'none') item = { kind, id, needs: 'model', why: `${unreached(at)}; read it before trusting any number near it${also}${hookNote(id)}` };
    else item = { kind, id, needs, why: `${why(at.host)}${also}${devNote(id)}${hookNote(id)}` };
    if (at.host) item.host = at.host;
    if (script && skillRowChanged.has(id)) withPaths(item, 'skill', id);
    items.push(item);
  };

  for (const id of diff.scripts.changed) {
    skillItem('script-changed', id, 'in-game',
      (host) => `the script the readers execute changed - re-run the readers, then a dummy session on ${host ?? 'whatever grants it'} to confirm the new reading`,
      { script: true });
  }
  for (const id of diff.scripts.added) {
    skillItem('script-added', id, 'in-game',
      (host) => `a new script on ${host ?? 'an unknown host'} - nothing has ever validated it`, { script: true });
  }
  // A script REMOVED from a skill that still exists. The row survives, so no
  // "removed" item fires, and the generic "row changed" hides what happened:
  // every hook the readers took from that text no longer runs.
  for (const id of diff.scripts.removed ?? []) {
    let alive = false;
    try { alive = cdb.has('skill', id); } catch { /* no skill sheet */ }
    if (!alive) continue;
    const hooks = diff.scripts.hooksRemoved?.[id];
    const at = citedAt(stated, id);
    folded.add(id);
    const host = place(id).host;
    items.push(withPaths({
      kind: 'script-removed', id, needs: 'model',
      why: `the script the readers executed is gone - every hook they read from it (${hooks?.join(', ') ?? 'not recorded in the stored fingerprint'}) no longer runs; re-read the row${host ? ` on ${host}` : ''}`
        + (at ? `. Named at ${at.join(', ')}` : ''),
    }, 'skill', id));
  }

  // Sent to a SHEET check, each with what the check needs to mean anything: a
  // snapshot taken on THIS build. One written before the patch adds the old
  // build's bake to the new build's base stats, and the gap it shows is the
  // patch, not the model.
  const ON_THIS_BUILD = 'from a snapshot taken on THIS build (an older one carries the old build\'s numbers)';
  const sheetNeeds = {
    constant: ['sheet', `every formula consuming the constant moves - bench verify's SHEET check confirms ${ON_THIS_BUILD}; damage-side constants need a dummy session`],
    attribute: ['sheet', `the attribute table drives the whole sheet - SHEET check ${ON_THIS_BUILD}`],
    rarity: ['sheet', `iLevel bonuses and star caps price every item - SHEET check ${ON_THIS_BUILD}, plus one tooltip`],
    affix: ['sheet', `affix kinds/composition rules moved - SHEET check ${ON_THIS_BUILD}`],
    statusType: ['model', 'the DoT/HoT flags decide which ticks crit - re-run the tick-crit table against a capture'],
    unit: ['in-game', 'target mitigation or base stats moved - re-measure it and re-run SHEET'],
    item: ['sheet', `item stats re-bake - SHEET check on an affected wearer ${ON_THIS_BUILD}, or the bake log after one login`],
    itemType: ['model', 'slots/sockets/block grants moved - re-run verify on an affected build'],
    skill: ['model', 'steps/effects/vars moved - re-price, and a dummy session if the skill is damage-bearing'],
    aptitude: ['sheet', `class scaling moved - SHEET check ${ON_THIS_BUILD}`],
    affinity: ['model', 'mitigation routing moved - dummy vs boss comparison'],
    craft: ['model', 'what counts as crafted moved - the crafted/dropped split in the catalog'],
    moveSet: ['in-game', 'the base-attack chain length moved - the CHAIN column and every swing cadence on that weapon type'],
    gameTerm: ['none', 'a UI term the description links resolve through - cosmetic'],
    color: ['none', 'a UI colour - cosmetic'],
    icon: ['none', 'a UI icon - cosmetic'],
    gameBeat: ['none', 'a UI term the description links resolve through - cosmetic'],
    text: ['none', 'a UI string the tooltips fill (set titles, the units of a duration and a range) - cosmetic'],
    faction: ['none', 'the name a faction is printed under - cosmetic'],
  };
  // A constant that arrived with a system nothing reads is not a SHEET check:
  // no formula of the model consumes it. It is the system that needs reading.
  const addedClusters = clusters(diff);
  const clusterOf = (id) => addedClusters.find((g) => Object.values(g.sheets).some((ids) => ids.includes(id)))?.token ?? null;
  const unitName = (id) => { const n = newRows('unit')?.get(id)?.texts?.name; return n ? ` ("${n}")` : ''; };
  // The routing one row earns, beyond what its sheet says.
  const route = (sheet, id, added) => {
    const [needs, why] = sheetNeeds[sheet] ?? ['model', 'a sheet the model reads changed'];
    if (sheet === 'skill') {
      const at = place(id);
      if (at.side === 'foe') return ['none', `a foe skill - named by ${at.host} and by nothing a player can own; the model prices what a player does to a target, not what the target casts`];
      if (at.side === 'other') return ['model', `named by ${at.host} only - not a class, an item or a unit's kit; read what applies it before pricing or dismissing it`];
      if (at.side === 'none') return ['model', `${unreached(at)}; read it before trusting any number near it`];
      return [needs, at.host ? `${why} (on ${at.host})` : why];
    }
    if (sheet === 'unit' && reach) {
      if (reach.isNpc(id)) return ['none', `unit ${id}${unitName(id)} has no skill anywhere on its inherit chain and no stats of its own - an NPC, not something a build fights`];
      return [needs, `unit ${id}${unitName(id)}: ${why}`];
    }
    if (sheet === 'item' && kindOfItem) {
      const k = kindOfItem(newRows('item')?.get(id));
      if (k.kind === 'pointer') return ['none', `not worn - it names skill ${k.skill} (props.ref.skill), and that row is what a number depends on; it has its own item when it changed`];
      if (k.kind === 'consumable') {
        return ['model', `not worn, so there is no wearer to SHEET-check: a consumable carrying ${[k.stats.length ? `affixes on ${[...new Set(k.stats)].join(', ')}` : '', k.statuses.length ? `status ${[...new Set(k.statuses)].join(', ')}` : ''].filter(Boolean).join(' and ')} - it reaches a sheet only as a prebuff a snapshot may show`];
      }
      if (k.kind === 'other') return ['none', `not wearable combat gear (${k.type ?? 'no type'}): no slot the model fills, no affixes, no status - nothing a number depends on`];
    }
    if (sheet === 'constant' && src && !named(id)) {
      const token = added ? clusterOf(id) : null;
      if (token) return ['model', `a constant of a system nothing reads ("${token}" arrived across several sheets) - no formula of the model consumes it yet; read the system`];
      return ['none', 'a constant nothing in src/ quotes - no formula of the model consumes it'];
    }
    return [needs, why];
  };

  for (const [sheet, d] of Object.entries(diff.sheets)) {
    if (d.newlyTracked) {
      items.push({ kind: 'sheet-newly-tracked', id: sheet, needs: 'none', why: `${d.added.length} rows recorded for the first time - nothing to validate, --accept starts tracking them` });
      continue;
    }
    const cosmetic = new Set(d.cosmeticOnly ?? []);
    // A stored fingerprint from before the second hash has one hash per row,
    // and a renamed skill moves that as surely as a new coefficient does. The
    // routing stays what the row would earn if a number moved - it cannot be
    // lowered on a guess - but the sentence must not state as fact what this
    // report cannot tell: against a July copy of the data, 9 of the 85 skill
    // rows it said "steps/effects/vars moved" of had changed in texts and
    // visuals alone. With the old rows in hand the paths say what moved, and
    // nothing is hedged.
    const blind = (item) => {
      if (d.coreKnown === false && !item.paths) {
        item.why = `changed - whether in a number or only in its texts and visuals, the stored fingerprint cannot say (it predates the second hash; --against <an older data.cdb> tells). Routed as if a number did: ${item.why}`;
      }
      return item;
    };
    for (const id of d.changed) {
      if (sheet === 'skill' && folded.has(id)) continue;
      if (cosmetic.has(id)) {
        items.push({ kind: `${sheet}-changed`, id, needs: 'none', why: 'only its texts, names or visuals changed, or the index of an enum it stores - nothing a number depends on' + devNote(id) });
      } else if (sheet === 'unit' && reach?.isClass(id)) {
        items.push(blind(withPaths({ kind: 'unit-changed', id, needs: 'model', why: 'a player class row - class skills, base stats or talent trees moved; the talents are listed separately when the fingerprint holds them' }, sheet, id)));
      } else {
        const [needs, why] = route(sheet, id, false);
        const item = { kind: `${sheet}-changed`, id, needs: isDev(id) ? 'none' : needs, why: why + devNote(id) };
        const p = pathsOf(sheet, id);
        // A row that moved in NOTHING but a flags or enum column is not a
        // SHEET check: the check compares numbers and a flag is not one. What
        // it needs is someone reading what the flag gates.
        const flagOnly = p && p.every((x) => x.gained || x.lost);
        if (flagOnly && item.needs === 'sheet') {
          const flipped = p.flatMap((x) => [...x.gained, ...x.lost]);
          const unread = flipped.filter((x) => !named(x));
          item.needs = 'model';
          item.why = !src ? 'only a flag moved, which a SHEET check cannot see - read what it gates'
            : unread.length
              ? `only a flag moved, which a SHEET check cannot see - and src/ never quotes ${unread.join(', ')}: read what it gates`
              : 'only a flag moved, which a SHEET check cannot see - the readers decode it by name, so re-run verify on a build that uses it';
        } else if (!p && item.needs === 'sheet' && (d.flagOnly ?? []).includes(id)) {
          // No old rows to read the flag off, but the hashes say that much.
          item.needs = 'model';
          item.why = 'only a flag or an enum value moved (no number did), which a SHEET check cannot see - --against <an older data.cdb> names which; read what it gates';
        }
        if (p) { item.paths = p; item.why = `${describePaths(p)} - ${item.why}`; }
        // A row the routing itself calls a note stays as worded: "nothing a
        // number depends on" holds whatever moved in it.
        items.push(needs === 'none' ? item : blind(item));
      }
    }
    for (const id of d.added) {
      if (sheet === 'skill' && folded.has(id)) continue;
      const [needs, why] = route(sheet, id, true);
      items.push({ kind: `${sheet}-added`, id, needs: isDev(id) ? 'none' : needs, why: `new row - ${why}${devNote(id)}` });
    }
    for (const id of d.removed) {
      const at = citedAt(stated, id);
      items.push(at
        ? { kind: `${sheet}-removed`, id, needs: 'model', why: `a row the model cites no longer exists - ${at.join(', ')}` }
        : { kind: `${sheet}-removed`, id, needs: 'none', why: stated ? 'gone, and nothing in the source or the living docs names it' : 'a row the model may cite no longer exists' });
    }
  }
  for (const [unit, d] of Object.entries(diff.talents ?? {})) {
    for (const s of d.added) items.push({ kind: 'talent-added', id: `${unit}:${s}`, needs: 'model', why: `a new talent in the ${unit} tree - read it, price it, and a dummy session if it is damage-bearing` });
    for (const s of d.removed) items.push({ kind: 'talent-removed', id: `${unit}:${s}`, needs: 'model', why: `a talent the ${unit} tree no longer offers - any build pinning it is illegal now` });
    for (const c of d.changed) items.push({ kind: 'talent-moved', id: `${unit}:${c.skill}`, needs: 'model', why: `tier:branch:max ${c.from} -> ${c.to} - the tier thresholds and the point budget the optimiser searches moved with it` });
  }
  for (const s of diff.othersChanged ?? []) {
    items.push({ kind: 'untracked-sheet-changed', id: s, needs: 'none', why: 'a sheet nothing in the bench reads changed - if a new system lives there, add it to SHEETS and read it' });
  }

  // Schema: the readers decode enum and flags columns by NAME, so a case none
  // of src/ names is invisible to them until someone reads what it does. A
  // column on a cosmetic path - visuals, sounds, models, icons - is a note:
  // nothing in it can move a number.
  const COSMETIC = /(^|[@.])(visuals?|gfx|fxs?|sounds?|anims?|models?|prefabs?|icons?|colou?rs?|texts?|camRumble|bellFx|linkFx)([@.]|$)/i;
  const cosmetic = (path) => COSMETIC.test(path) || /^(gameTerm|color|icon|gameBeat|text|faction)([@.]|$)/.test(path);
  const schemaItem = (kind, id, needs, why) => items.push(cosmetic(id)
    ? { kind, id, needs: 'none', why: `cosmetic path - ${why}` }
    : { kind, id, needs, why });
  const sch = diff.schema ?? { sheets: {}, customTypes: {} };
  for (const [sheet, d] of Object.entries(sch.sheets ?? {})) {
    if (d.newSheet) {
      schemaItem('schema-sheet-added', sheet, 'model', `a new nested sheet with columns ${d.added.join(', ')} - read what drives it before trusting rows that set it`);
      continue;
    }
    if (d.goneSheet) {
      schemaItem('schema-sheet-removed', sheet, 'model', 'a nested sheet the readers may walk no longer exists');
      continue;
    }
    for (const col of d.added) {
      schemaItem('schema-column-added', `${sheet}.${col}`, 'model', 'a column the readers never consume - read what it drives before trusting rows that set it');
    }
    for (const col of d.removed) {
      const used = columnRead(col);
      schemaItem('schema-column-removed', `${sheet}.${col}`, used ? 'model' : 'none', used ? 'a column the readers may consume no longer exists' : 'a column no longer exists, and nothing in src/ reads it');
    }
    for (const c of d.changed) {
      if (c.casesAdded) {
        const read = columnRead(c.col);
        const unread = c.casesAdded.filter((x) => !named(x));
        const shifted = c.shifted ?? [];
        const parts = [];
        if (c.casesAdded.length) {
          parts.push(`gained ${c.casesAdded.join(', ')}`
            + (!src ? ' (src/ not scanned)'
              : !read ? ' (a column nothing in src/ reads - nothing in the model depends on it)'
              : unread.length ? ` (never quoted in src/: ${unread.join(', ')})` : ' (every new case is quoted in src/)'));
        }
        if (c.casesRemoved.length) parts.push(`lost ${c.casesRemoved.join(', ')}`);
        if (c.reordered) parts.push('cases REORDERED - only a by-name decode survives that');
        else if (shifted.length) parts.push(`INDEX SHIFT: ${shifted.join(', ')} kept their names and changed their numbers - every row storing one changed with it, and only a by-name decode survives that`);
        const needs = (read && unread.length) || c.casesRemoved.length || c.reordered || shifted.length ? 'model' : 'none';
        schemaItem('schema-enum-changed', `${sheet}.${c.col}`, needs, parts.join('; '));
      } else {
        schemaItem('schema-type-changed', `${sheet}.${c.col}`, 'model', `column type ${c.from} -> ${c.to}`);
      }
    }
  }
  for (const [type, d] of Object.entries(sch.customTypes ?? {})) {
    const unread = (d.added ?? []).map((x) => x.replace(/\(.*$/, '')).filter((x) => !named(x));
    items.push({
      kind: d.newType ? 'schema-customtype-added' : d.goneType ? 'schema-customtype-removed' : 'schema-customtype-changed',
      id: type,
      needs: unread.length || d.goneType || (d.removed ?? []).length ? 'model' : 'none',
      why: [
        d.added?.length ? `gained ${d.added.join(', ')}` : '',
        d.removed?.length ? `lost ${d.removed.join(', ')}` : '',
        unread.length ? `never quoted in src/: ${unread.join(', ')}` : '',
      ].filter(Boolean).join('; ') || 'changed',
    });
  }

  // New code. A class the model cites that grew or lost a method is a place
  // where a formula may have gained a branch; a class that arrived in a
  // package the model cites is a system to look at. Neither is priced by
  // anything yet, so the first is model work and the second a note.
  const cd = diff.code;
  if (cd && !cd.unknown) {
    for (const c of cd.changed) {
      if (!c.cited) continue;
      items.push({
        kind: 'code-class-changed', id: c.cls, needs: 'model',
        why: `a class the model cites: ${c.from} -> ${c.to} methods`
          + (c.methodsAdded?.length ? `, gained ${c.methodsAdded.join(', ')}` : '')
          + (c.methodsRemoved?.length ? `, lost ${c.methodsRemoved.join(', ')}` : '')
          + ' - read the new ones before trusting the formulas around them',
      });
    }
    for (const cls of cd.added) items.push({ kind: 'code-class-added', id: cls, needs: 'none', why: 'a class that did not exist on the accepted build, in a package the model cites - nothing reads it' });
    for (const cls of cd.removed) {
      const at = citedAt(stated, cls.split('.').pop().replace(/^\$/, ''));
      items.push({ kind: 'code-class-removed', id: cls, needs: at ? 'model' : 'none', why: at ? `a class the source names is gone - ${at.join(', ')}` : 'a class is gone, and nothing in the source names it' });
    }
  }
  return items;
}

// A heuristic, and labelled as one: ids ADDED in the same patch that share a
// word across sheets are usually one feature arriving in pieces - an item
// type, an aptitude, a handful of constants and the skills that read them.
// Listing the clusters turns 300 rows into "a new system called X".
//
// Chosen GREEDILY: the largest cluster first, then its ids are taken out of
// every other one. Without that the list repeated the first system under its
// own suffixes ("tank", "support" and "nightling" were all infusion ids) and
// ranked one-word coincidences - three unrelated rows that share "shop" -
// above a seven-row rework.
//
// And a shared word is not yet a name. The ids are namespaced with
// underscores (Infusion_..., Dungeon_Heroic_..., Emote_..., Poison_Dose) and
// described in camelCase inside a segment (RotationSpeed, SparkCube): a word
// that only ever occurs INSIDE a segment is a description several unrelated
// rows happen to share. In the October 2026 build "speed" joined a status
// named "Pilgrim's Stride" (Pilgrims_FlaskSpeed_Status), a nameless
// SpeedBoost skill and two constants that are a bare float each
// (RotationSpeed, ModelScaleSpeed), and the work list then called the two
// constants "a system nothing reads". So a word names a cluster only when at
// least one of its ids carries it as a whole segment.
export function clusters(diff, { min = 3 } = {}) {
  const GENERIC = new Set(['status', 'skill', 'base', 'attack', 'area', 'passive', 'combo', 'craft', 'item',
    'summon', 'spawn', 'bonus', 'boss', 'multi', 'shot', 'wall', 'dance', 'high', 'low',
    'first', 'time', 'last', 'delete', 'test', 'trinket']);
  const tokensOf = (id) => String(id).split(/[_\s]+/)
    .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t));
  const namespaces = (id, token) => String(id).split(/[_\s]+/).some((p) => p.toLowerCase() === token);
  const byToken = new Map();
  for (const [sheet, d] of Object.entries(diff.sheets ?? {})) {
    if (d.newlyTracked) continue;
    for (const id of d.added ?? []) {
      for (const t of new Set(tokensOf(id))) {
        const m = byToken.get(t) ?? new Map();
        m.set(sheet, (m.get(sheet) ?? []).concat(id));
        byToken.set(t, m);
      }
    }
  }
  const sizeOf = (m) => [...m.values()].reduce((n, ids) => n + ids.length, 0);
  const out = [];
  for (;;) {
    let best = null;
    for (const [token, m] of byToken) {
      const rows = sizeOf(m);
      if (m.size < 2 || rows < min) continue;
      if (![...m.values()].some((ids) => ids.some((id) => namespaces(id, token)))) continue;
      if (!best || rows > best.rows || (rows === best.rows && m.size > best.m.size)) best = { token, m, rows };
    }
    if (!best) break;
    out.push({ token: best.token, sheets: Object.fromEntries([...best.m].map(([s, ids]) => [s, ids])), rows: best.rows });
    const taken = new Set([...best.m.entries()].flatMap(([s, ids]) => ids.map((id) => `${s}\u0000${id}`)));
    byToken.delete(best.token);
    for (const [token, m] of byToken) {
      for (const [s, ids] of m) {
        const left = ids.filter((id) => !taken.has(`${s}\u0000${id}`));
        if (left.length) m.set(s, left); else m.delete(s);
      }
      if (!m.size) byToken.delete(token);
    }
  }
  return out;
}

// Added items grouped by rarity and type: "116 Epic armour" reads better than
// 116 ids, and a whole tier arriving at once is the kind of change the rarity
// ceilings in the catalog are derived from.
export function addedItemsByKind(diff, cdb) {
  const groups = new Map();
  if (diff.sheets?.item?.newlyTracked) return [];
  const items = cdb.byId('item');
  for (const id of diff.sheets?.item?.added ?? []) {
    const it = items.get(id);
    const key = `${it?.rarity ?? '?'} ${it?.type ?? '?'}`;
    groups.set(key, (groups.get(key) ?? []).concat(id));
  }
  return [...groups].map(([kind, ids]) => ({ kind, ids })).sort((a, b) => b.ids.length - a.ids.length);
}

// --- the in-game half --------------------------------------------------------

// The last `session` row of a probe log, found from the END: the log is
// append-only across boots and patches (1.8 GB after a month), and the probe
// (schema v10 on) opens every boot's output with one row that says which
// hlboot.dat the rows below it were recorded against:
//
//   <ts_ms>,session,...,probe=v10;boot_bytes=<size>;boot_mtime_ms=<mtime>
//
// Returns where that row is and what it says, or - for a log written before
// the row existed - that there is none. `cap` bounds how far back a log
// without one is searched.
const SESSION_MARK = Buffer.from(',session,');
// The session row whose marker starts before byte `end` of an open log,
// searched backwards over at most `budget` bytes. `scanned` is what the
// search read, so a caller walking back row by row can keep one budget.
function sessionBefore(fd, size, end, budget, chunk) {
  const read = (from, to) => {
    const buf = Buffer.alloc(Math.max(0, to - from));
    readSync(fd, buf, 0, buf.length, from);
    return buf;
  };
  let pos = end, scanned = 0, carry = Buffer.alloc(0);
  while (pos > 0 && scanned < budget) {
    const n = Math.min(chunk, pos);
    pos -= n;
    // The first bytes of the chunk read before ride along, so a marker cut
    // by the chunk boundary is still one marker.
    const buf = Buffer.concat([read(pos, pos + n), carry]);
    scanned += n;
    const at = buf.lastIndexOf(SESSION_MARK);
    if (at >= 0) {
      const mark = pos + at;
      const head = read(Math.max(0, mark - 64), mark);
      const start = mark - (head.length - 1 - head.lastIndexOf(0x0a));
      const tail = read(mark, Math.min(size, mark + 4096));
      const nl = tail.indexOf(0x0a);
      const stop = nl < 0 ? size : mark + nl;
      const line = read(start, stop).toString('utf8').replace(/\r$/, '');
      return { size, found: true, scanned, offset: start, next: Math.min(size, stop + 1), line, ...parseSession(line) };
    }
    carry = buf.subarray(0, Math.min(SESSION_MARK.length - 1, n));
  }
  return { size, found: false, scanned, capped: pos > 0 };
}
export function lastSession(path, { cap = 256 * 1024 * 1024, chunk = 1 << 20 } = {}) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const { scanned, ...found } = sessionBefore(fd, size, size, cap, chunk);
    return found;
  } finally { closeSync(fd); }
}

// EVERY session row of a log the same cap reaches, the last one first. A log
// holds one per launch, and a build is recorded over many: on 2026-10-13 the
// live log held three rows naming the installed hlboot.dat - two driven
// sessions holding 91,298 hits and a login after them holding 540, fifteen
// of them the character's own - and reading the LAST one alone reported
// "3695 rows (540 hits)" for the build. `capped` says the walk stopped at the
// cap with the log not yet read to its start.
export function sessionRows(path, { cap = 256 * 1024 * 1024, chunk = 1 << 20 } = {}) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const sessions = [];
    let end = size, left = cap, capped = false;
    while (end > 0 && left > 0) {
      const { scanned, ...s } = sessionBefore(fd, size, end, left, chunk);
      left -= scanned;
      if (!s.found) { capped = !!s.capped; break; }
      sessions.push(s);
      end = s.offset;
    }
    if (end > 0 && left <= 0) capped = true;
    return { size, sessions, capped };
  } finally { closeSync(fd); }
}

function parseSession(line) {
  const fields = line.split(',');
  const out = { ts: Number(fields[0]) || null, probe: null, bootBytes: null, bootMtimeMs: null, bootUnreadable: false };
  for (const kv of String(fields[fields.length - 1] ?? '').split(';')) {
    const [k, v] = kv.split('=');
    if (k === 'probe') out.probe = Number(String(v).replace(/^v/, '')) || null;
    else if (k === 'boot_bytes') out.bootBytes = Number(v);
    else if (k === 'boot_mtime_ms') out.bootMtimeMs = Number(v);
    else if (k === 'boot' && v === 'unreadable') out.bootUnreadable = true;
  }
  return out;
}

// Rows from an offset to the end of a log (or to `to`): how many, and how
// many of them are hits. Counted, never loaded.
function countRows(path, from, to = Infinity) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return { rows: 0, inflict: 0 }; }
  try {
    const size = Math.min(fstatSync(fd).size, to);
    const HIT = Buffer.from(',inflict,');
    const buf = Buffer.alloc(1 << 20);
    let rows = 0, inflict = 0, tail = Buffer.alloc(0), last = 0x0a;
    for (let pos = from; pos < size;) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const view = Buffer.concat([tail, buf.subarray(0, n)]);
      for (let i = tail.length; i < view.length; i++) if (view[i] === 0x0a) rows++;
      for (let i = view.indexOf(HIT); i >= 0; i = view.indexOf(HIT, i + 1)) if (i + HIT.length > tail.length) inflict++;
      tail = Buffer.from(view.subarray(Math.max(0, view.length - (HIT.length - 1))));
      last = buf[n - 1];
      pos += n;
    }
    // A final row with no newline yet is still a row.
    if (size > from && last !== 0x0a) rows++;
    return { rows, inflict };
  } finally { closeSync(fd); }
}

// One probe log against the boot it sits beside: is there a session row, was
// it written against THIS hlboot.dat, and is there anything after it.
function logEra(path, boot) {
  if (!existsSync(path)) return { exists: false };
  const st = statSync(path);
  const out = { exists: true, bytes: st.size, mtime: st.mtime, predatesBoot: !!(boot && st.mtime < boot.mtime) };
  const all = sessionRows(path);
  const s = all?.sessions[0];
  if (!s) { out.session = null; out.scanCapped = !!all?.capped; return out; }
  const isSameBytes = (x) => !!boot && x.bootBytes === boot.bytes;
  // The probe reads the file's mtime in whole seconds.
  const matches = (x) => isSameBytes(x) && x.bootMtimeMs != null && Math.abs(x.bootMtimeMs - boot.mtimeMs) < 2000;
  // The LAST session, and what follows its row - `rows` and `inflict` are its
  // own, as they always were.
  out.session = {
    ts: s.ts, probe: s.probe, bootBytes: s.bootBytes, bootMtimeMs: s.bootMtimeMs, bootUnreadable: s.bootUnreadable,
    sameBytes: isSameBytes(s), matchesBoot: matches(s), offset: s.offset, ...countRows(path, s.next),
  };
  // EVERY SESSION RECORDED ON THIS BOOT: walked back from the last row for as
  // long as each row names the installed hlboot.dat. The first that names
  // another file - or could not read one - ends the walk: what lies before it
  // was recorded on another build, or cannot be tied to this one, and a later
  // match does not vouch for it. Each session's rows run to the next session
  // row, so the total is theirs and no other build's.
  if (out.session.matchesBoot) {
    const run = [];
    for (const x of all.sessions) { if (!matches(x)) break; run.push(x); }
    const counted = run.map((x, i) => countRows(path, x.next, i === 0 ? Infinity : run[i - 1].offset));
    out.onBoot = {
      sessions: run.length,
      rows: counted.reduce((n, c) => n + c.rows, 0),
      inflict: counted.reduce((n, c) => n + c.inflict, 0),
      firstTs: run[run.length - 1].ts,
      // The walk reached the cap with every row so far a match: there may be
      // more of this boot's sessions further back than was read.
      capped: run.length === all.sessions.length && !!all.capped,
    };
  }
  return out;
}

// What the loader wrote about its last launch. hlx.log is rewritten per
// launch and is a few kilobytes: which mods loaded, how many hook targets
// were installed and which were refused, and whether its own bytecode reader
// could parse the boot it was started on.
function parseLoaderLog(text) {
  const out = { loaded: [], probe: null, hooks: null, refused: [], patched: 0, bootParse: null, complete: /\bboot complete\b/.test(text) };
  out.hlxBoot = /^\[hlx-boot\] ==== hlx-boot/m.test(text);
  for (const m of text.matchAll(/loadMod\(([^)]+)\) -> (true|false)/g)) out.loaded.push({ mod: m[1], ok: m[2] === 'true' });
  const probe = /^\[([\w.-]+)\] [^\n]*?: \1(?: v(\d+))? loaded/m.exec(text);
  if (probe) out.probe = { name: probe[1], version: probe[2] ? Number(probe[2]) : null };
  const hooks = /install: (\d+) of (\d+) hook target\(s\) installed/.exec(text);
  if (hooks) out.hooks = { installed: Number(hooks[1]), of: Number(hooks[2]) };
  for (const m of text.matchAll(/install_patch failed for (\S+)/g)) out.refused.push(m[1]);
  out.patched = [...text.matchAll(/PatchFunctionPrologue\(patch#\d+\): OK/g)].length;
  const parsed = /reflection_init_constructor_table: parsed '[^']*' and scanned[^\n]*? (\d+)\/(\d+) function\(s\) scanned/.exec(text);
  const failed = /hl_code_read\('[^']*'\) failed: (.+?) - /.exec(text);
  if (parsed) out.bootParse = { ok: true, functions: Number(parsed[2]) };
  else if (failed) out.bootParse = { ok: false, error: failed[1] };
  return out;
}

// The in-game half of the pipeline lives in the install's hlx/ folder: a
// loader DLL and its bytecode, a probe mod, and the logs they write. Whether
// that chain WORKS on this build is not something a version byte can say -
// the loader and the probe are loaded by the game's own VM, and on the first
// October 2026 launch HLB v4 files loaded on a v6 boot while seven hooks were
// refused for an unrelated reason. So this reads the evidence instead: what
// the loader logged about its last launch, and what each probe log says about
// the boot its last rows were recorded against. This looks, and says.
export function captureChain(gameDir, bootVersion = null, { functions = null } = {}) {
  const hlx = join(gameDir, 'hlx');
  if (!existsSync(hlx)) return { present: false };
  const versionOf = (p) => {
    try {
      const b = readFileSync(p).subarray(0, 4);
      return b[0] === 0x48 && b[1] === 0x4c && b[2] === 0x42 ? b[3] : null;
    } catch { return null; }
  };
  // The bytecode version of each part is kept as a fact and no longer as a
  // verdict.
  const parts = [];
  const loader = join(hlx, 'loader');
  if (existsSync(loader)) for (const f of readdirSync(loader)) if (f.endsWith('.hl')) parts.push({ what: 'loader', file: f, version: versionOf(join(loader, f)) });
  const mods = join(hlx, 'mods');
  if (existsSync(mods)) {
    for (const d of readdirSync(mods)) {
      const dir = join(mods, d);
      try {
        if (!statSync(dir).isDirectory()) continue;
        for (const f of readdirSync(dir)) if (f.endsWith('.hl')) parts.push({ what: `mod ${d}`, file: f, version: versionOf(join(dir, f)) });
      } catch { /* a file in mods/ is not a mod */ }
    }
  }
  const bootPath = join(gameDir, 'hlboot.dat');
  const bootStat = existsSync(bootPath) ? statSync(bootPath) : null;
  const boot = bootStat ? { bytes: bootStat.size, mtime: bootStat.mtime, mtimeMs: bootStat.mtimeMs } : null;
  const logs = join(hlx, 'logs');
  const logPath = join(logs, 'hlx.log');
  let log = null;
  if (existsSync(logPath)) {
    const st = statSync(logPath);
    // The tail is enough: the launch facts are its last lines.
    const text = readFileSync(logPath).subarray(Math.max(0, st.size - 4 * 1024 * 1024)).toString('utf8');
    log = { mtime: st.mtime, predatesBoot: !!(boot && st.mtime < boot.mtime), ...parseLoaderLog(text) };
    // The loader's own count of the boot's functions, against the reader's.
    log.sameFunctions = functions != null && log.bootParse?.ok ? log.bootParse.functions === functions : null;
  }
  const damage = logEra(join(logs, 'bench-probe.csv'), boot);
  const bake = logEra(join(logs, 'bench-probe-bakes.csv'), boot);
  // Logs renamed aside when a patch landed: evidence about another build,
  // kept beside the live ones.
  const archived = existsSync(logs)
    ? readdirSync(logs).filter((f) => /^bench-probe.*\.csv$/.test(f) && f !== 'bench-probe.csv' && f !== 'bench-probe-bakes.csv').sort()
    : [];
  // Rows in ANY session recorded on this boot: a launch that wrote its session
  // row and nothing else is not "nothing captured on this build" over a log
  // whose earlier sessions on the same boot hold ninety thousand hits.
  const onThisBoot = (era) => !!(era.exists && era.session?.matchesBoot && (era.onBoot?.rows ?? era.session.rows) > 0);
  return {
    present: true, parts, bootVersion, boot,
    bootMtime: boot?.mtime ?? null,
    // hlx-boot IS this DLL: it stands in for the game's std library and loads
    // the loader from there. Without it nothing in hlx/ runs.
    loaderDll: existsSync(join(gameDir, 'libhl64.dll')),
    log, lastLog: log?.mtime ?? null, logPredatesBoot: !!log?.predatesBoot,
    damage, bake, archived,
    // The two answers everything else is for.
    capturedOnThisBoot: onThisBoot(damage),
    bakedOnThisBoot: onThisBoot(bake),
  };
}

// The CAPTURE line of `bench update`, composed from that evidence: did the
// loader run on this boot and what did it refuse, does each log's last
// session row match THIS hlboot.dat, are there rows after it.
export function captureLine(chain) {
  if (!chain?.present) return { level: 'dim', text: 'no hlx/ in this install - the in-game half is not deployed here' };
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'never');
  const parts = [];
  let warn = false;
  const log = chain.log;
  if (!log) {
    parts.push(chain.loaderDll ? 'no hlx.log - the loader has not run in this install' : 'hlx-boot is not installed (no libhl64.dll) and has left no log');
    warn = true;
  } else if (log.predatesBoot) {
    parts.push(`the loader last ran ${day(log.mtime)}, before this hlboot.dat (${day(chain.boot?.mtime)}) - not launched on this build yet`
      + (chain.loaderDll ? '' : ', and hlx-boot is not installed now (no libhl64.dll)'));
    warn = true;
  } else {
    const said = [];
    if (log.bootParse && !log.bootParse.ok) { said.push(`its bytecode reader refused the boot (${log.bootParse.error})`); warn = true; }
    if (log.sameFunctions === false) { said.push(`it parsed ${log.bootParse.functions} functions where this boot has another count - a log about another boot`); warn = true; }
    for (const m of log.loaded.filter((x) => !x.ok)) { said.push(`${m.mod} failed to load`); warn = true; }
    if (log.probe) said.push(`${log.probe.name}${log.probe.version ? ` v${log.probe.version}` : ''} loaded`);
    else if (!log.loaded.some((x) => x.ok)) { said.push('no mod loaded'); warn = true; }
    if (log.hooks) {
      said.push(`${log.hooks.installed} of ${log.hooks.of} hooks installed`);
      if (log.hooks.installed < log.hooks.of) warn = true;
    }
    if (log.refused.length) {
      said.push(`${log.refused.length} hook${log.refused.length > 1 ? 's' : ''} refused (${log.refused.slice(0, 4).join(', ')}${log.refused.length > 4 ? ', ...' : ''})`);
      warn = true;
    }
    if (!log.complete) { said.push('the log stops before "boot complete"'); warn = true; }
    parts.push(`the loader ran on this boot (${day(log.mtime)}): ${said.join(', ') || 'it logged nothing about mods or hooks'}`
      + (chain.loaderDll ? '' : '; hlx-boot is not installed now (no libhl64.dll)'));
    if (!chain.loaderDll) warn = true;
  }
  const era = (what, e) => {
    if (!e.exists) return `no ${what} log`;
    if (!e.session) return `${what} log has no session row${e.scanCapped ? ' in its last 256 MB' : ''} (written by a probe older than v10), last written ${day(e.mtime)}${e.predatesBoot ? ', before this boot' : ''}`;
    const s = e.session;
    const counted = (c) => `${c.rows} row${c.rows === 1 ? '' : 's'}${what === 'damage' ? ` (${c.inflict} hits)` : ''}`;
    // Several sessions on this boot: the total is the evidence the build
    // has, and the last session's own count is what the line used to print
    // alone ("3695 rows (540 hits)" over a log holding 91,838 hits).
    if (s.matchesBoot && e.onBoot?.sessions > 1) {
      return `${what} log: ${counted(e.onBoot)} over ${e.onBoot.sessions} sessions recorded on this hlboot.dat`
        + `${e.onBoot.capped ? ' in its last 256 MB' : ''}, ${counted(s)} of them since the last session row`;
    }
    if (s.matchesBoot) return `${what} log: ${counted(s)} since a session row that matches this hlboot.dat`;
    if (s.bootUnreadable) return `${what} log: its last session row could not read hlboot.dat, so nothing ties its ${s.rows} rows to this build`;
    return `${what} log: its last session row was written against ${s.sameBytes ? 'a hlboot.dat of this size but another date' : 'another hlboot.dat'} (${s.bootBytes} bytes, ${day(s.bootMtimeMs)})${s.sameBytes ? ' - the same build only if Steam merely re-verified the file' : ''}`;
  };
  parts.push(era('bake', chain.bake));
  parts.push(era('damage', chain.damage));
  if (!chain.capturedOnThisBoot) { parts.push('nothing captured in combat on this build yet'); warn = true; }
  if (chain.archived.length) parts.push(`${chain.archived.length} earlier log${chain.archived.length > 1 ? 's' : ''} renamed beside them`);
  return { level: warn ? 'warn' : 'ok', text: parts.join('; ') };
}

// --- what was accepted, and where that is written ----------------------------

export function fingerprintPath(repoRoot) {
  return join(repoRoot, 'model', 'fingerprint.json');
}

export function loadFingerprint(repoRoot) {
  const p = fingerprintPath(repoRoot);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// The three facts every command header needs - when, and the two hashes - in
// a file of their own. The fingerprint is half a megabyte and ships nowhere:
// neither the zip nor the exe carried model/, so `acceptedBuild` answered null
// in every released copy and the one banner written for the user who cannot
// know the game was patched never printed for them. This file is two hundred
// bytes and is on both packaging lists (tools/release.mjs SHIPPED, the exe's
// extraResources); the suite checks that it is, and that it says what the
// fingerprint says.
export function acceptedStampPath(repoRoot) {
  return join(repoRoot, 'model', 'accepted-build.json');
}

const stampOf = (fp) => ({ at: fp.at, cdbSha: fp.cdbSha ?? null, bootSha: fp.bootSha ?? null });

// Bring the stamp in line with a fingerprint. Derived data: it accepts
// nothing, it restates what the fingerprint already records. Returns whether
// anything was written.
export function syncAcceptedStamp(repoRoot, fp) {
  if (!fp?.cdbSha) return false;
  const p = acceptedStampPath(repoRoot);
  const want = JSON.stringify(stampOf(fp), null, 1) + '\n';
  if (existsSync(p) && readFileSync(p, 'utf8') === want) return false;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, want);
  return true;
}

export function loadAcceptedStamp(repoRoot) {
  const p = acceptedStampPath(repoRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Is this install the build the model was accepted on? Every command prints
// the answer with its header, because a number computed on a newer build than
// the one that calibrated it is exactly the number this tool exists to not
// print silently. Read from the stamp, which every layout ships, and from the
// fingerprint where only that exists.
export function acceptedBuild(repoRoot, meta) {
  const fp = loadAcceptedStamp(repoRoot) ?? loadFingerprint(repoRoot);
  if (!fp) return null;
  const cdbSame = fp.cdbSha === meta?.cdbSha;
  const bootSame = fp.bootSha == null || meta?.bootSha == null || fp.bootSha === meta.bootSha;
  return { at: fp.at, cdbSame, bootSame, same: cdbSame && bootSame };
}

// The rows the model was accepted on, kept on THIS machine. The fingerprint
// holds hashes, which can say a row changed and never what changed in it; the
// rows themselves are the game's and are never committed (the repository
// ships no game data). So --accept leaves the consumed sheets beside the
// install-path cache, in .cache/ - ignored by git, absent from every
// download - and the next patch's report reads them back to say "iLevelBonus
// 30 -> 50". A fresh clone has no such file and says so; --against <old
// data.cdb> does the same job from any old copy.
export function acceptedRowsPath(repoRoot) {
  return join(repoRoot, '.cache', 'accepted-rows.json.gz');
}

export function saveAcceptedRows(repoRoot, cdb) {
  const keep = (name) => SHEETS.includes(name.split('@')[0]);
  const raw = {
    cdbSha: cdb.meta?.cdbSha ?? null,
    sheets: (cdb.raw?.sheets ?? []).filter((s) => keep(s.name)),
    customTypes: cdb.raw?.customTypes ?? [],
  };
  const p = acceptedRowsPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, gzipSync(Buffer.from(JSON.stringify(raw))));
  return p;
}

// The raw sheets as saved, or null when there are none for that cdb. The
// caller wraps them in its own Cdb.
export function loadAcceptedRows(repoRoot, cdbSha) {
  const p = acceptedRowsPath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
    return raw.cdbSha && raw.cdbSha === cdbSha ? raw : null;
  } catch { return null; }
}

// --- the release gate that needs no game -------------------------------------
//
// The suite reads the player's own data.cdb and hlboot.dat, so it can only
// run on a machine that owns the game - and releases are cut from a hosted
// runner that does not. tools/release.mjs used to say so and continue, which
// meant a release could go out with the suite crashing and the model
// unaccepted on the live build. What CAN travel to the runner is a statement:
// "test/run.mjs passed on exactly this tree, against exactly this game
// build". A full green run writes it (model/suite-pass.json), it is committed
// with the tree it describes, and the release script checks it against the
// tree in front of it and against the accepted build.

// One hash over the code a release ships and the suite that checked it: every
// file under src/, bin/, tools/, test/ and the UI server's own modules, by
// path and by content with line endings normalised (a Windows checkout and a
// Linux one are the same tree).
export function treeHash(repoRoot) {
  const files = [];
  const SKIP = /^(node_modules|dist|out)$/;
  const walk = (rel) => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) { files.push(rel); return; }
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith('.') || SKIP.test(name)) continue;
      walk(`${rel}/${name}`);
    }
  };
  for (const d of ['src', 'bin', 'tools', 'test', 'ui/lib']) walk(d);
  const ui = join(repoRoot, 'ui');
  if (existsSync(ui)) for (const f of readdirSync(ui).sort()) if (f.endsWith('.mjs')) files.push(`ui/${f}`);
  const sum = createHash('sha256');
  for (const rel of files.sort()) {
    const body = readFileSync(join(repoRoot, rel)).toString('latin1').replace(/\r\n/g, '\n');
    sum.update(`${rel}\u0000${createHash('sha256').update(body, 'latin1').digest('hex')}\n`);
  }
  return sum.digest('hex').slice(0, 16);
}

export function suiteStampPath(repoRoot) {
  return join(repoRoot, 'model', 'suite-pass.json');
}

export function loadSuiteStamp(repoRoot) {
  const p = suiteStampPath(repoRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Written by the suite itself at the end of a full green run. Unchanged facts
// leave the file untouched, so a second green run does not dirty the tree.
export function writeSuiteStamp(repoRoot, { cdbSha, bootSha, passed }) {
  const tree = treeHash(repoRoot);
  const was = loadSuiteStamp(repoRoot);
  if (was && was.tree === tree && was.cdbSha === cdbSha && was.bootSha === bootSha && was.passed === passed) return false;
  const p = suiteStampPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), cdbSha, bootSha, tree, passed }, null, 1) + '\n');
  return true;
}

// May this tree be released without running the suite here? Three things
// have to line up: there is a stamp, it describes THIS tree, and the game
// build it passed on is the build the model is accepted on.
export function suiteGate({ stamp, tree, accepted }) {
  if (!stamp) return { ok: false, reason: 'no model/suite-pass.json - nothing says test/run.mjs ever passed on this tree; run it to the end on a machine that owns the game and commit the stamp it writes' };
  if (stamp.tree !== tree) return { ok: false, reason: `the suite passed on another tree (stamp ${stamp.tree}, this tree ${tree}) - something under src/, bin/, tools/, test/ or the UI server changed since; run test/run.mjs again and commit the stamp` };
  if (!accepted) return { ok: false, reason: 'no accepted build is recorded (model/accepted-build.json) - run `bench update` and accept a build before releasing numbers computed on it' };
  if (stamp.cdbSha !== accepted.cdbSha || (stamp.bootSha && accepted.bootSha && stamp.bootSha !== accepted.bootSha)) {
    return { ok: false, reason: `the suite passed on game build cdb ${String(stamp.cdbSha).slice(0, 12)} and the model is accepted on ${String(accepted.cdbSha).slice(0, 12)} (${String(accepted.at).slice(0, 10)}) - the patch work is not finished: \`bench update\`, then --accept, then the suite again` };
  }
  return { ok: true, reason: `test/run.mjs passed (${stamp.passed ?? '?'} checks, ${String(stamp.at).slice(0, 10)}) on this tree and on the accepted game build` };
}
