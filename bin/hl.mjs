#!/usr/bin/env node
// ---------------------------------------------------------------------------
// hl.mjs - poke at Farever's compiled code (`hlboot.dat`).
//
//   node bin/hl.mjs info                     counts, version, entry point
//   node bin/hl.mjs find <regex>             functions whose resolved name or
//                                            source file matches
//   node bin/hl.mjs disasm <findex|name>     one function, refs resolved
//   node bin/hl.mjs grep-str <regex>         the string table
//
// Read-only, like everything else here. The game path resolves the same way
// bench's does, and `--game <path>` overrides it.
// ---------------------------------------------------------------------------
import { requireBoot } from '../src/lib/game.mjs';
import { readHlb, disasm, typeName } from '../src/lib/hl.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || !['info', 'find', 'disasm', 'grep-str'].includes(cmd)) {
  console.error('usage: hl.mjs info | find <regex> | disasm <findex|name> | grep-str <regex>  [--game <path>]');
  process.exit(1);
}

const code = readHlb(requireBoot(argv));

if (cmd === 'info') {
  console.log(`version ${code.version}  debug ${code.hasDebug}  entry @${code.entrypoint}`);
  console.log(`functions ${code.functions.length}  natives ${code.natives.length}  types ${code.types.length}`);
  console.log(`ints ${code.ints.length}  floats ${code.floats.length}  strings ${code.strings.length}  files ${code.debugFiles.length}`);
} else if (cmd === 'find') {
  const re = new RegExp(argv[1] ?? '.', 'i');
  const rows = [];
  for (const f of code.functions) {
    const name = code.nameOf(f.findex) ?? '';
    const file = f.debug ? code.debugFiles[f.debug[0]] ?? '' : '';
    if (re.test(name) || re.test(file)) {
      rows.push(`${String(f.findex).padStart(6)}  ${name || '(unnamed)'}  ${file}${f.debug ? ':' + f.debug[1] : ''}  (${f.ops.length} ops)`);
    }
  }
  for (const n of code.natives) {
    if (re.test(`${n.lib}.${n.name}`)) rows.push(`${String(n.findex).padStart(6)}  ${n.lib}.${n.name} [native]`);
  }
  console.log(rows.join('\n') || '(no match)');
  console.error(`${rows.length} matches`);
} else if (cmd === 'disasm') {
  const arg = argv[1];
  let findex = Number(arg);
  if (!Number.isFinite(findex)) {
    const hit = [...code.fnNames.entries()].find(([, n]) => n === arg)
      ?? [...code.fnNames.entries()].find(([, n]) => n.toLowerCase().includes(String(arg).toLowerCase()));
    if (!hit) { console.error(`no function named ${arg}`); process.exit(1); }
    findex = hit[0];
  }
  console.log(disasm(code, findex));
} else if (cmd === 'grep-str') {
  const re = new RegExp(argv[1] ?? '.', 'i');
  const rows = code.strings.map((s, i) => [i, s]).filter(([, s]) => re.test(s));
  for (const [i, s] of rows.slice(0, 200)) console.log(`${i}\t${JSON.stringify(s)}`);
  console.error(`${rows.length} matches`);
}
export { typeName };
