// Turn a questlog.gg character-builder link into a bench command line.
//
// Every id questlog stores is a `data.cdb` id, so this resolves each one against
// the catalog and reports whatever it could not carry rather than dropping it
// quietly. See src/questlog.mjs for what does not survive the trip.
import fs from 'node:fs';
import { createEngine } from '../src/engine.mjs';
import { slugOf, endpoints, normalize, translate, commandLine } from '../src/questlog.mjs';
import * as f from '../src/format.mjs';

const USAGE = [
  'questlog-import - a questlog.gg build, as bench pins',
  '',
  '  node tools/questlog-import.mjs <url or slug> [options]',
  '',
  '  --verb <v>      the bench subcommand to write   (default optimize; sheet',
  '                  prints the stat sheet this exact build produces)',
  '  --build <n>     which of the character\'s builds, from 0     (default 0)',
  '  --save <file>   keep the raw payload that was fetched',
  '  --from <file>   translate a saved payload instead of fetching',
  '',
  'To RUN a questlog build rather than read it, hand the link to the bench',
  'itself - `bench optimize <link>` - which pins it and takes every other flag',
  'as normal. This tool is for seeing what the link translates to.',
  '',
  'Example',
  '  node tools/questlog-import.mjs \\',
  '    https://questlog.gg/farever/en/character-builder/HandWithTheFullTeam',
].join('\n');

function die(msg) {
  console.error(f.warn('questlog-import: ' + msg));
  process.exit(1);
}

// Every flag takes a value, so one pass consumes the pair and whatever is left
// over is the URL or slug.
function parseArgs(input) {
  const takesValue = new Set(['verb', 'build', 'from', 'save']);
  const flags = {};
  const loose = [];
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    const m = /^--([\w-]+)$/.exec(a);
    if (!m) { loose.push(a); continue; }
    if (m[1] === 'help') return { help: true, flags, loose };
    if (!takesValue.has(m[1])) die('unknown flag --' + m[1] + '\n\n' + USAGE);
    const v = input[i + 1];
    if (v == null || v.startsWith('--')) die('--' + m[1] + ' needs a value');
    flags[m[1]] = v;
    i++;
  }
  return { help: false, flags, loose };
}

async function get(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText + ' for ' + url);
  return r.json();
}

// The equipment and the talents live behind two different procedures, and the
// second is keyed by the AUTHOR's slug - which only the first one tells you.
async function fetchPayload(input) {
  const slug = slugOf(input);
  const character = await get(endpoints(slug).character);
  const authorSlug = character?.result?.data?.character?.user?.slug;
  if (!authorSlug) throw new Error('the character payload names no author, so its talents cannot be reached');
  const talents = await get(endpoints(slug, authorSlug).talents);
  return { slug, character, talents };
}

function report(build, out, { buildIndex, verb }) {
  console.log(f.bold(build.name) + f.dim('  by ' + (build.author ?? '?') + '  -  '
    + out.class + ' ' + out.level
    + (build.buildCount > 1 ? '  (build ' + (buildIndex + 1) + '/' + build.buildCount + ')' : '')));
  if (build.desc.trim()) console.log(f.dim('  ' + build.desc.trim().split('\n')[0]));
  if (build.talentName) console.log(f.dim('  talents: ' + build.talentName));
  console.log();

  const rows = [];
  for (const p of out.pins) {
    if (p.empty) continue;
    if (p.isSkills) { rows.push(['  ' + f.short(p.slot), 'skills', p.skills.join(', ')]); continue; }
    if (p.socket) {
      rows.push(['', f.short(p.socket).replace(/^Augment/, ''), p.augment + '  ' + f.dim(p.name)]);
      continue;
    }
    rows.push(['  ' + f.short(p.slot), 'item', p.arg.split('=')[1] + '  ' + f.dim(p.name)]);
  }
  console.log(f.table(['  SLOT', 'WHAT', 'ID'], rows));

  if (out.talentPins.length) {
    console.log('\n' + f.table(['  TALENT', 'RANK'],
      out.talentPins.map((t) => ['  ' + t.node, String(t.rank)])));
  }
  if (out.runePins.length) {
    console.log('\n' + f.table(['  SKILL', 'RUNE'],
      out.runePins.map((r) => ['  ' + r.skill, r.rune])));
  }

  // An empty slot is pinned empty, because importing a build means reproducing
  // it. Worth saying out loud, since it is the one thing that stops `optimize`
  // from improving a build it could otherwise fill.
  const empties = out.pins.filter((p) => p.empty).map((p) => p.arg.split('=')[0]);
  if (empties.length) {
    out.notes.push(empties.join(', ') + (empties.length === 1 ? ' is' : ' are')
      + ' empty in questlog and pinned empty here; drop those --pin lines to let optimize fill them');
  }
  if (out.notes.length) {
    console.log('\n' + f.bold('NOTES'));
    for (const n of out.notes) console.log('  ' + n);
  }
  console.log('\n' + f.bold('QUESTLOG RECORDS THIS, THE BENCH CANNOT TAKE IT'));
  for (const w of out.warnings) console.log(f.warn('  ' + w));

  // One flag per line, continued with a backslash so the block pastes and runs.
  const line = commandLine(out, { verb });
  let cmd = '';
  for (let i = 0; i < line.length; i++) {
    const a = line[i];
    if (/^--(pin|talent|rune|skills)$/.test(a)) cmd += ' \\\n  ' + a + ' ' + line[++i];
    else cmd += (cmd ? ' ' : '') + a;
  }
  console.log('\n' + f.bold('COMMAND'));
  console.log(cmd.replace(/^bench/, 'node bin/bench.mjs'));
  console.log();
}

async function main() {
  const { help, flags, loose } = parseArgs(process.argv.slice(2));
  if (help || (!loose.length && !flags.from)) { console.log(USAGE); return; }

  const buildIndex = Number(flags.build ?? '0');
  if (!Number.isInteger(buildIndex) || buildIndex < 0) die('--build needs a whole number from 0');

  const payload = flags.from
    ? JSON.parse(fs.readFileSync(flags.from, 'utf8'))
    : await fetchPayload(loose[0]);

  if (flags.save) {
    fs.writeFileSync(flags.save, JSON.stringify(payload, null, 1));
    console.log(f.dim('saved the raw payload to ' + flags.save));
  }

  const build = normalize(payload.character, payload.talents, { buildIndex });
  const out = translate(build, createEngine({ quiet: true }));
  report(build, out, { buildIndex, verb: flags.verb ?? 'optimize' });
}

try { await main(); } catch (e) { die(e.message); }
