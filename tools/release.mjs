#!/usr/bin/env node
// ---------------------------------------------------------------------------
// release.mjs - cut a version: run the suite, bump both package.json files,
// write the changelog entry, build the download, print the new version.
//
//   node tools/release.mjs <patch|minor|major> [--notes "..."] [--notes-out f]
//   node tools/release.mjs --zip-only          the download, no bump, no writes
//
// Zero dependencies, git through child_process, stdout is ONLY the new version
// so CI can do `VERSION=$(node tools/release.mjs patch)`; every other word
// goes to stderr. `--zip-only` puts the zip's path there instead, because that
// is the one thing a caller wants back from a run that changes nothing.
//
// It writes files and nothing else - no commit, no tag, no push. A release is
// a human (or a workflow) deciding to publish; this script only prepares the
// diff, which also means running it locally to see what a release WOULD say
// costs nothing but a `git checkout`.
//
// The two package.json versions move together on purpose: the UI reports
// `meta.version` from the root one while the exe is stamped from ui's, and a
// user reading "0.3.1" in the window while holding "0.2.0" the binary has no
// way to tell which is true. So a mismatch is a hard stop, not a fixup.
//
// Double-bumping is the failure mode that matters (run twice, and 0.1.0
// becomes 0.3.0 with a changelog that lies about both). Four guards, all of
// them fatal: package.json's version must still match HEAD's - a bump that is
// written but not yet committed is a release in flight, not a starting point -
// the two package versions must agree, the tag v<new> must not exist, and
// CHANGELOG.md must not already carry a `## [<new>]` heading.
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { findGame } from '../src/lib/game.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const say = (...a) => console.error(...a);

function die(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function git(args, { soft = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (soft) return null;
    die(`git ${args.join(' ')} failed: ${String(e?.stderr || e?.message).trim()}`);
  }
}

// --- arguments --------------------------------------------------------------

function parseArgs(argv) {
  const out = { bump: null, notes: '', notesOut: null, skipTests: false, zipOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notes') out.notes = argv[++i] ?? '';
    else if (a.startsWith('--notes=')) out.notes = a.slice(8);
    else if (a === '--notes-out') out.notesOut = argv[++i] ?? null;
    else if (a.startsWith('--notes-out=')) out.notesOut = a.slice(12);
    else if (a === '--skip-tests') out.skipTests = true;
    else if (a === '--zip-only') out.zipOnly = true;
    else if (a === '-h' || a === '--help') {
      say('usage: node tools/release.mjs <patch|minor|major|none> [--notes "..."] [--notes-out FILE]');
      say('                              [--skip-tests]');
      say('       node tools/release.mjs --zip-only');
      say('');
      say('  none  cut the version already in package.json instead of raising it.');
      say('        The first release needs it: 0.1.0 is written in the manifests');
      say('        and in the README, and every other bump would publish 0.1.1.');
      process.exit(0);
    } else if (!out.bump) out.bump = a;
    else die(`unexpected argument: ${a}`);
  }
  // --zip-only writes nothing and moves no version, so there is nothing to
  // bump and naming one would be a lie about what the run did.
  if (out.zipOnly) {
    if (out.bump) die('--zip-only builds the download from the version already in package.json - drop the bump');
    return out;
  }
  if (!['patch', 'minor', 'major', 'none'].includes(out.bump))
    die('first argument must be patch, minor, major or none');
  return out;
}

// --- versions ---------------------------------------------------------------

// A targeted rewrite, not JSON.stringify: these files are hand-formatted
// (inline keyword arrays, nested build config) and a release should show one
// changed line in the diff, not a reflow of the whole file.
const VERSION_RE = /("version"\s*:\s*")([^"]+)(")/;

function readVersion(file) {
  const m = VERSION_RE.exec(readFileSync(file, 'utf8'));
  if (!m) die(`no "version" field in ${file}`);
  return m[2];
}

function writeVersion(file, from, to) {
  const src = readFileSync(file, 'utf8');
  const m = VERSION_RE.exec(src);
  if (!m || m[2] !== from) die(`${file} no longer reads ${from} - refusing to write`);
  writeFileSync(file, src.slice(0, m.index) + m[1] + to + m[3] + src.slice(m.index + m[0].length));
}

function bumped(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) die(`version ${version} is not x.y.z - bump it by hand`);
  let [major, minor, patch] = m.slice(1).map(Number);
  // `none` cuts what the manifests already say. The first release needs it:
  // 0.1.0 is written in both package.json files and quoted in the README's
  // download links, and every other kind would publish 0.1.1 and make those
  // links wrong on day one.
  if (kind === 'none') return version;
  if (kind === 'major') { major++; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor++; patch = 0; }
  else patch++;
  return `${major}.${minor}.${patch}`;
}

// npm ci does not care about the lockfile's own version field, but a lock
// claiming 0.1.0 next to a package claiming 0.2.0 is a lie somebody will
// eventually read. Best effort: only rewritten when it still says the old one.
function syncLock(file, from, to) {
  if (!existsSync(file)) return;
  const src = readFileSync(file, 'utf8');
  const next = src.replace(new RegExp(`("version"\\s*:\\s*")${from.replace(/\./g, '\\.')}(")`, 'g'),
    `$1${to}$2`);
  if (next !== src) writeFileSync(file, next);
}

// --- the commit list --------------------------------------------------------

// Subjects since the last v* tag. No tag yet (a first release) means the whole
// history, which is right: everything in it is new to whoever downloads it.
function subjectsSince(prevTag) {
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const out = git(['log', '--no-merges', '--pretty=format:%s', range], { soft: true });
  if (out == null) return [];
  return out.split('\n').map((s) => s.trim())
    // The previous release's own bookkeeping commit is not news.
    .filter((s) => s && !/^release v?\d+\.\d+\.\d+/i.test(s));
}

// `ui: fixed the picker` style subjects group under their prefix; a one-off
// prefix is not a group, it is a sentence with a colon in it, so a prefix
// needs at least two commits before it earns a heading.
function group(subjects) {
  const prefixOf = (s) => {
    const m = /^([a-z][a-z0-9._/-]{0,20}(?:\([^)]{1,30}\))?)!?:\s+(\S.*)$/.exec(s);
    return m ? { key: m[1], rest: m[2] } : null;
  };
  const counts = new Map();
  for (const s of subjects) {
    const p = prefixOf(s);
    if (p) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  }
  const groups = new Map();
  const loose = [];
  for (const s of subjects) {
    const p = prefixOf(s);
    if (p && counts.get(p.key) >= 2) {
      if (!groups.has(p.key)) groups.set(p.key, []);
      groups.get(p.key).push(p.rest);
    } else loose.push(s);
  }
  const sections = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, lines]) => ({ title: key, lines }));
  if (loose.length) sections.push({ title: sections.length ? 'Other' : 'Changes', lines: loose });
  return sections;
}

function sectionBody(sections, notes) {
  const out = [];
  if (notes.trim()) out.push(notes.trim(), '');
  if (!sections.length) out.push('- No commits since the previous release.', '');
  for (const s of sections) {
    if (sections.length > 1 || s.title !== 'Changes') out.push(`### ${s.title}`, '');
    for (const line of s.lines) out.push(`- ${line}`);
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// --- changelog --------------------------------------------------------------

const CHANGELOG_HEAD = `# Changelog

Every release of farever-bench, newest first:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape,
[semver](https://semver.org/spec/v2.0.0.html) numbers. \`package.json\` and
\`ui/package.json\` always carry the same version - \`tools/release.mjs\` moves
them together and refuses to run when they disagree.
`;

// The text under `## [x.y.z]`, up to the next `## ` heading. Used when a
// release cuts a version whose section was written by hand rather than
// generated - the release page should show what the changelog says.
function sectionOf(file, version) {
  if (!existsSync(file)) return null;
  // Split on the headings rather than matching across them: a lookahead of
  // `^## |\s*$` is zero-width at the first line end, so it captured nothing
  // and every release silently fell back to the raw commit list.
  const lines = readFileSync(file, 'utf8').split('\n');
  const head = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n').trim() || null;
}

function prependSection(file, heading, body) {
  const src = existsSync(file) ? readFileSync(file, 'utf8') : CHANGELOG_HEAD;
  const entry = `${heading}\n\n${body}`;
  const ix = src.search(/^## /m);
  if (ix < 0) return `${src.replace(/\s*$/, '\n')}\n${entry}`;
  return `${src.slice(0, ix)}${entry}\n${src.slice(ix)}`;
}

// --- the suite --------------------------------------------------------------
//
// Nothing ships until `node test/run.mjs` passes. The gate lives HERE, in the
// script a person runs, and not as a step in .github/workflows/release.yml,
// for one reason: test/run.mjs opens `loadCdb()` and `requireBoot()` on the
// first line and asserts every number against the player's own data.cdb and
// hlboot.dat - by design, so a balance patch that moves a constant is caught
// rather than agreed with. A GitHub runner has no Farever installed, so the
// suite cannot pass there; it cannot even start. The only machine that can
// check a release is a machine that owns the game, which is the machine a
// release is cut from.
//
// So: an install present means the suite runs and a failure is fatal. No
// install means the suite is not failing, it is unrunnable - that is the CI
// case, it is said out loud, and the release continues.
function runSuite() {
  if (args.skipTests) {
    say('');
    say('  ###########################################################');
    say('  ##  --skip-tests: this release was NOT checked against   ##');
    say('  ##  the game data. Nothing has run test/run.mjs. The     ##');
    say('  ##  next person to trust these numbers is trusting you.  ##');
    say('  ###########################################################');
    say('');
    return;
  }
  // An empty argv on purpose: this script's own flags are not the CLI's, and
  // `--notes patch` must never be read as a path to an install.
  const game = findGame([]);
  if (!game) {
    say('release: no Farever install on this machine, so test/run.mjs cannot run here.');
    say('release: the suite reads data.cdb and hlboot.dat - cut the release from a');
    say('release: machine that owns the game if you want it checked.');
    return;
  }
  say(`release: running test/run.mjs against ${game}`);
  const r = spawnSync(process.execPath, [join(ROOT, 'test', 'run.mjs')],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.error) die(`could not run test/run.mjs: ${r.error.message}`);
  if (r.status !== 0)
    die(`test/run.mjs exited ${r.status} - nothing has been written. Fix the suite, `
      + 'or --skip-tests if you already know why it fails.');
}

// --- the download -------------------------------------------------------------
//
// One zip carries both ways of running the bench without the desktop app,
// because they are the same thing: `bench <command>` and `bench ui` are one
// source tree with one dependency (Node 18, and your own copy of Farever).
// Nothing game-derived is in it - every number and every icon is read at
// runtime out of the install the user already has.
//
// Written with node:zlib rather than shelled out to PowerShell's
// Compress-Archive. A windows-latest runner has PowerShell, but a release that
// can only be built on Windows is a release nobody can cut from a laptop, and
// filtering a tree for Compress-Archive means staging a copy of it first. This
// is the ZIP container (APPNOTE 4.3) and it runs wherever Node does.

// Everything option 2 (`bench ui`) and option 3 (`bench <command>`) need, and
// nothing else. ui/electron and ui/package.json are deliberately absent: they
// describe the Electron build, which is the OTHER download.
const SHIPPED = [
  'bin', 'src', 'docs',
  'ui/server.mjs', 'ui/api.mjs', 'ui/view.mjs', 'ui/icons.mjs',
  'ui/optimize-worker.mjs', 'ui/lib', 'ui/web', 'ui/API.md', 'ui/README.md',
  'bench.cmd', 'bench-ui.cmd', 'bench-ui.sh',
  'package.json', 'LICENSE', 'README.md', 'CHANGELOG.md',
];

// bin/, src/, docs/, ui/lib and ui/web are taken WHOLE, so anything that grows
// inside one of them ships with it. These are the things that do: build output,
// installed packages, the machine-local cache, and the sweep reports - which
// are derived from the player's own game data and are the one category that
// must never leave a machine. Dotted names go too; none of them are source.
const NEVER = /^(node_modules|dist|out|bench-layouts-.*)$/;

// The screenshots stay in the repository and out of the download. They are the
// one part of the documentation made of the game's own art and text - decoded
// icons, an item's flavour line - and while a screenshot in a README is
// ordinary documentation, a copy of it inside a distributed archive is a
// different thing to defend. So the bundle refers to the repository's README
// for them, which also takes the download from 2.7MB to well under one.
const REPO_URL = 'https://github.com/Blaakan/farever-bench';
const SHIPPED_SKIP = /^docs\/img(\/|$)/;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS packed date and time, which is the only timestamp the base format has.
function dosStamp(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Relative paths, forward slashes, sorted - so two builds of the same tree
// produce the same entry order.
function collect(rel, into) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs))
    die(`the download is missing ${rel} - it is on the list and not on disk`);
  if (SHIPPED_SKIP.test(rel)) return into;
  if (statSync(abs).isFile()) { into.push(rel); return into; }
  for (const name of readdirSync(abs).sort()) {
    if (name.startsWith('.') || NEVER.test(name)) continue;
    collect(`${rel}/${name}`, into);
  }
  return into;
}

function zipBytes(entries) {
  // A member count past 65535 needs zip64, which this writer does not speak.
  if (entries.length > 0xFFFF) die(`${entries.length} files needs a zip64 writer`);
  const { time, date } = dosStamp(new Date());
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data, { level: 9 });
    // Deflate is bigger than the input on bytes that are already compressed -
    // the .ico, mostly. Store those rather than pay for the stream header.
    const store = deflated.length >= e.data.length;
    const body = store ? e.data : deflated;
    const method = store ? 0 : 8;
    const crc = crc32(e.data);

    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);              // version needed to extract: 2.0
    head.writeUInt16LE(0x0800, 6);          // flags: the name is UTF-8
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(e.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);              // no extra field
    local.push(head, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    // Made by UNIX (0x03), spec 3.0 - which is what makes an extractor read
    // the mode in the external attributes below, so bench-ui.sh arrives
    // executable on the platforms that need it to be.
    dir.writeUInt16LE(0x031E, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);               // extra
    dir.writeUInt16LE(0, 32);               // comment
    dir.writeUInt16LE(0, 34);               // disk number
    dir.writeUInt16LE(0, 36);               // internal attributes
    dir.writeUInt32LE((e.mode << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                 // no archive comment
  return Buffer.concat([...local, cd, end]);
}

// The bundle's markdown, with the screenshots turned back into a pointer. A
// relative link to a file the archive does not carry renders as a broken image
// in every viewer, which reads as a build mistake rather than as a decision -
// so each one becomes a line naming the repository, and the reader is told once
// at the top where the illustrated version lives.
function forBundle(buf) {
  let text = buf.toString('utf8');
  if (!/\]\(docs\/img\//.test(text)) return buf;
  text = text.replace(/!\[([^\]]*)\]\(docs\/img\/[^)]+\)/g,
    (_, alt) => `> ${alt || 'Screenshot'} - see ${REPO_URL}#readme`);
  const note = `> The screenshots in this guide live with the repository:\n`
    + `> ${REPO_URL}#readme\n\n`;
  // After the title line, so the document still opens with its own name.
  const nl = text.indexOf('\n');
  return Buffer.from(text.slice(0, nl + 1) + '\n' + note + text.slice(nl + 1).replace(/^\n+/, ''), 'utf8');
}

// The zip carries the working tree byte for byte, and the working tree is
// whatever the builder's git checked out. `core.autocrlf=true` is git's
// Windows default and is what the windows-latest runner uses, so on the
// machine that cuts the release bench-ui.sh is CRLF on disk - and v0.1.0's zip
// shipped it that way, which is `/bin/sh` reading the shebang as `/bin/sh\r`
// and answering "bad interpreter: /bin/sh^M". .gitattributes pins eol=lf for
// the checkout; this pins it for the artifact, so the download is right even
// when built from a tree that is not.
//
// Bytes, not text: a script is not guaranteed to be valid UTF-8 and a
// round-trip through a string would rewrite bytes this has no business
// touching. Only a CR that is part of a CRLF goes; a lone CR is data.
function lfOnly(buf) {
  if (!buf.includes(0x0D)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0D && buf[i + 1] === 0x0A) continue;
    out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

// What a shell or the kernel parses, rather than what a person reads: the .sh,
// and anything carrying a shebang - bin/*.mjs do, and `#!/usr/bin/env node\r`
// fails the same way the moment somebody marks one executable. The .cmd files
// are deliberately left alone: cmd.exe is their only reader and CRLF is its
// native form.
const runsAsScript = (rel, data) =>
  rel.endsWith('.sh') || (data.length > 1 && data[0] === 0x23 && data[1] === 0x21);

// ...and the other direction, for the one reader that wants CRLF. cmd.exe
// seeks through a batch file byte by byte, so a `goto` in an LF-only .cmd can
// land in the wrong place - and bench-ui.cmd goes to :failed to keep a
// double-clicked window open. .gitattributes pins these to CRLF in the working
// tree; this pins them in the ARTIFACT, so a checkout configured otherwise
// cannot ship a batch file Windows mis-seeks.
const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const wantsCrlf = (rel) => rel.endsWith('.cmd') || rel.endsWith('.bat');

function crlfOnly(buf) {
  const text = buf.toString('binary');
  // Normalise to LF first, then raise every LF - idempotent, and it cannot
  // double a CR that is already there.
  const out = text.split(CRLF).join(NL).split(NL).join(CRLF);
  return out === text ? buf : Buffer.from(out, 'binary');
}

function buildZip(version) {
  const files = [];
  for (const rel of SHIPPED) collect(rel, files);
  // Under one directory named after the release, so unzipping into Downloads
  // leaves one folder rather than twenty files, and two versions can sit side
  // by side.
  const root = `farever-bench-v${version}`;
  const entries = files.map((rel) => {
    let data = readFileSync(join(ROOT, rel));
    if (rel.endsWith('.md')) data = forBundle(data);
    if (runsAsScript(rel, data)) data = lfOnly(data);
    else if (wantsCrlf(rel)) data = crlfOnly(data);
    return {
      name: `${root}/${rel}`,
      data,
      // S_IFREG, and +x only on the shell script - the one file in here that
      // is run rather than read.
      mode: rel.endsWith('.sh') ? 0o100755 : 0o100644,
    };
  });
  const out = join(ROOT, `${root}.zip`);
  const bytes = zipBytes(entries);
  writeFileSync(out, bytes);
  say(`release: ${root}.zip - ${entries.length} files, ${(bytes.length / 1024).toFixed(0)}KB`);
  return out;
}

// --- main -------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));

const rootPkg = join(ROOT, 'package.json');
const uiPkg = join(ROOT, 'ui', 'package.json');
for (const f of [rootPkg, uiPkg]) if (!existsSync(f)) die(`missing ${f}`);

const current = readVersion(rootPkg);
const uiCurrent = readVersion(uiPkg);
if (current !== uiCurrent)
  die(`package.json says ${current} but ui/package.json says ${uiCurrent} - `
    + 'put them back in lockstep before releasing');

// A build of the tree as it stands, for checking that the download extracts
// and runs. It cuts no release - no version moves, no changelog is written,
// and the zip carries the version package.json already had - so it does not
// go through the suite gate either.
if (args.zipOnly) {
  const path = buildZip(current);
  process.stdout.write(path + '\n');
  process.exit(0);
}

const next = bumped(current, args.bump);
const tag = `v${next}`;

const inRepo = git(['rev-parse', '--git-dir'], { soft: true }) != null;
if (!inRepo) say('release: not a git checkout - no commit list, guards reduced to the changelog');

// The guard that catches the rerun: a second run would happily take 0.2.0 to
// 0.3.0, tag two releases one commit apart and write a changelog that splits
// one set of commits across both. Committed version == working version means
// no release is half-done.
if (inRepo) {
  const head = git(['show', 'HEAD:package.json'], { soft: true });
  const m = head && VERSION_RE.exec(head);
  if (m && m[2] !== current)
    die(`package.json says ${current} but HEAD says ${m[2]} - a bump is already `
      + 'written and uncommitted. Commit or revert it before releasing again.');
}

if (inRepo && git(['tag', '--list', tag], { soft: true }))
  die(`tag ${tag} already exists - the bump has already happened`);

const changelog = join(ROOT, 'CHANGELOG.md');
const hasSection = existsSync(changelog)
  && new RegExp(`^## \\[${next.replace(/\./g, '\\.')}\\]`, 'm').test(readFileSync(changelog, 'utf8'));
// Cutting the version already in the manifests, its section is SUPPOSED to be
// there already - that is what is being released. Only a real bump can find
// its own section written, and that means the bump already happened.
if (hasSection && args.bump !== 'none')
  die(`CHANGELOG.md already has a section for ${next} - the bump has already happened`);
if (!hasSection && args.bump === 'none')
  die(`CHANGELOG.md has no section for ${next}. Cutting the current version means `
    + 'releasing what is already written down; write that section first, or bump instead.');

// After the guards - a suite is a minute and "the tag already exists" is a
// millisecond - and before the first write, so a failure leaves the tree
// exactly as it was found.
runSuite();

const prevTag = inRepo
  ? git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], { soft: true })
  : null;
const subjects = inRepo ? subjectsSince(prevTag) : [];
const body = sectionBody(group(subjects), args.notes);
const date = new Date().toISOString().slice(0, 10);

// `none` moves no version and adds no section - the manifests and the
// changelog already say what is being cut, and rewriting them would only
// restate it with today's date.
if (args.bump !== 'none') {
  writeVersion(rootPkg, current, next);
  writeVersion(uiPkg, current, next);
  syncLock(join(ROOT, 'ui', 'package-lock.json'), current, next);
  writeFileSync(changelog, prependSection(changelog, `## [${next}] - ${date}`, body));
}
// The notes are what the release page shows, so they come from the section
// being released - the one already written when nothing was bumped.
if (args.notesOut) {
  writeFileSync(args.notesOut, args.bump === 'none' ? sectionOf(changelog, next) || body : body);
}

// Last, so the package.json and the CHANGELOG.md inside the zip are the ones
// this release just wrote rather than the previous release's.
buildZip(next);

say(args.bump === 'none'
  ? `release: cutting ${next} as it stands - no version moved, no changelog section added`
  : `release: ${current} -> ${next}`
    + `  (${subjects.length} commit${subjects.length === 1 ? '' : 's'} since ${prevTag ?? 'the first commit'})`);
// Say what was actually written. Claiming three files were rewritten when the
// run deliberately left them alone is the kind of line somebody trusts.
const wrote = [
  ...(args.bump === 'none' ? [] : ['package.json', 'ui/package.json', 'CHANGELOG.md']),
  ...(args.notesOut ? [args.notesOut] : []),
];
say(wrote.length ? `release: wrote ${wrote.join(', ')}` : 'release: wrote nothing but the zip');

process.stdout.write(next + '\n');
