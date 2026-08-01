// ---------------------------------------------------------------------------
// hl.mjs - a reader for HashLink bytecode (`hlboot.dat`).
//
// Farever ships its compiled game code as HashLink bytecode WITH full debug
// info - source filenames and per-opcode line numbers across every function -
// and that file is where the composition rules live that `data.cdb` does not
// state: WeaponPower's derivation, the 60/40 weapon-skill mix, the hit
// composition order inside `ent.Unit.applyDamage`. Until now those were read
// by measuring the running game; this reads the code.
//
// The format is the one `hashlink/src/code.c` reads, reproduced faithfully:
//
//   "HLB" ver flags nints nfloats nstrings [nbytes v5+] ntypes nglobals
//   nnatives nfunctions [nconstants v4+] entrypoint
//   ints floats strings [bytes v5+] [debugfiles if flags&1]
//   types globals natives functions constants
//
// Every count and index uses HashLink's own varint ("index"): one byte for
// 0..127, two bytes for 13-bit values, four bytes for 29-bit values, with a
// sign bit in the second and third forms. Getting this wrong desyncs the
// stream within a handful of reads, so the whole 40MB file parsing to exactly
// EOF is itself the checksum.
//
// Function NAMES are not stored on functions. They come from the object
// types: a class's `protos` name its methods (name + findex) and its
// `bindings` name its statics (field index + findex). Resolving those is what
// turns "findex 4835" into `ent.Unit.applyDamage` - the exact citations
// docs/MODEL.md has carried all along.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const TYPE_KINDS = [
  'void', 'u8', 'u16', 'i32', 'i64', 'f32', 'f64', 'bool', 'bytes', 'dyn',
  'fun', 'obj', 'array', 'type', 'ref', 'virtual', 'dynobj', 'abstract',
  'enum', 'null', 'method', 'struct', 'packed', 'guid',
];

// Opcode table, in opcode order, with the fixed argument count per op.
// -1 marks the two variable shapes: the call family (dst, target, count byte,
// then `count` args) and OSwitch (reg, ncases, `ncases` offsets, end).
export const OPCODES = [
  ['Mov', 2], ['Int', 2], ['Float', 2], ['Bool', 2], ['Bytes', 2], ['String', 2],
  ['Null', 1],
  ['Add', 3], ['Sub', 3], ['Mul', 3], ['SDiv', 3], ['UDiv', 3], ['SMod', 3], ['UMod', 3],
  ['Shl', 3], ['SShr', 3], ['UShr', 3], ['And', 3], ['Or', 3], ['Xor', 3],
  ['Neg', 2], ['Not', 2], ['Incr', 1], ['Decr', 1],
  ['Call0', 2], ['Call1', 3], ['Call2', 4], ['Call3', 5], ['Call4', 6],
  ['CallN', -1], ['CallMethod', -1], ['CallThis', -1], ['CallClosure', -1],
  ['StaticClosure', 2], ['InstanceClosure', 3], ['VirtualClosure', 3],
  ['GetGlobal', 2], ['SetGlobal', 2],
  ['Field', 3], ['SetField', 3], ['GetThis', 2], ['SetThis', 2],
  ['DynGet', 3], ['DynSet', 3],
  ['JTrue', 2], ['JFalse', 2], ['JNull', 2], ['JNotNull', 2],
  ['JSLt', 3], ['JSGte', 3], ['JSGt', 3], ['JSLte', 3],
  ['JULt', 3], ['JUGte', 3], ['JNotLt', 3], ['JNotGte', 3],
  ['JEq', 3], ['JNotEq', 3], ['JAlways', 1],
  ['ToDyn', 2], ['ToSFloat', 2], ['ToUFloat', 2], ['ToInt', 2],
  ['SafeCast', 2], ['UnsafeCast', 2], ['ToVirtual', 2],
  ['Label', 0], ['Ret', 1], ['Throw', 1], ['Rethrow', 1],
  ['Switch', -1], ['NullCheck', 1], ['Trap', 2], ['EndTrap', 1],
  ['GetI8', 3], ['GetI16', 3], ['GetMem', 3], ['GetArray', 3],
  ['SetI8', 3], ['SetI16', 3], ['SetMem', 3], ['SetArray', 3],
  ['New', 1], ['ArraySize', 2], ['Type', 2], ['GetType', 2], ['GetTID', 2],
  ['Ref', 2], ['Unref', 2], ['Setref', 2],
  ['MakeEnum', -1], ['EnumAlloc', 2], ['EnumIndex', 2], ['EnumField', 4],
  ['SetEnumField', 3],
  ['Assert', 0], ['RefData', 2], ['RefOffset', 3], ['Nop', 0],
  ['Prefetch', 3], ['Asm', 3],
  // Farever's toolchain is a HashLink fork with one opcode past OAsm. Its
  // shape was determined EMPIRICALLY: with one argument, the entire 40MB
  // hlboot.dat parses to exactly EOF; with zero, the stream desyncs 150KB
  // later. What it does is unknown - the name says only where it came from.
  ['Shiro101', 1],
];
const CALL_FAMILY = new Set(['CallN', 'CallMethod', 'CallThis', 'CallClosure', 'MakeEnum']);

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  byte() { return this.buf[this.pos++]; }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  // HashLink's varint. The sign bit only exists in the 2- and 4-byte forms.
  index() {
    const b = this.byte();
    if ((b & 0x80) === 0) return b & 0x7f;
    if ((b & 0x40) === 0) {
      const v = this.byte() | ((b & 31) << 8);
      return (b & 0x20) === 0 ? v : -v;
    }
    const c = this.byte(), d = this.byte(), e = this.byte();
    const v = ((b & 31) << 24) | (c << 16) | (d << 8) | e;
    return (b & 0x20) === 0 ? v : -v;
  }
  uindex() {
    const v = this.index();
    if (v < 0) {
      const err = new Error(`negative index ${v} where unsigned expected at ${this.pos}`);
      err.filePos = this.pos;
      throw err;
    }
    return v;
  }
  // A string block: total byte size, the blob, then one length per string.
  // Strings sit consecutively in the blob, each NUL-terminated.
  strings(count) {
    const size = this.i32();
    const blob = this.buf.subarray(this.pos, this.pos + size);
    this.pos += size;
    const out = new Array(count);
    let at = 0;
    for (let i = 0; i < count; i++) {
      const len = this.uindex();
      out[i] = blob.toString('utf8', at, at + len);
      at += len + 1;
    }
    return out;
  }
}

export function readHlb(path, { opOverrides = null } = {}) {
  const buf = readFileSync(path);
  const r = new Reader(buf);
  if (r.byte() !== 0x48 || r.byte() !== 0x4c || r.byte() !== 0x42) {
    throw new Error(`${path} is not HashLink bytecode (no HLB magic)`);
  }
  const version = r.byte();
  if (version < 2 || version > 5) throw new Error(`unsupported HLB version ${version}`);
  const flags = r.uindex();
  const nints = r.uindex();
  const nfloats = r.uindex();
  const nstrings = r.uindex();
  const nbytes = version >= 5 ? r.uindex() : 0;
  const ntypes = r.uindex();
  const nglobals = r.uindex();
  const nnatives = r.uindex();
  const nfunctions = r.uindex();
  const nconstants = version >= 4 ? r.uindex() : 0;
  const entrypoint = r.uindex();
  const hasDebug = (flags & 1) !== 0;

  const ints = new Array(nints);
  for (let i = 0; i < nints; i++) ints[i] = r.i32();
  const floats = new Array(nfloats);
  for (let i = 0; i < nfloats; i++) floats[i] = r.f64();
  const strings = r.strings(nstrings);
  if (version >= 5) {
    // A raw byte pool plus positions; nothing here reads it, but it has to be
    // skipped exactly.
    const size = r.i32();
    r.pos += size;
    for (let i = 0; i < nbytes; i++) r.uindex();
  }
  let debugFiles = [];
  if (hasDebug) {
    const nfiles = r.uindex();
    debugFiles = r.strings(nfiles);
  }

  // --- types ---------------------------------------------------------------
  const types = new Array(ntypes);
  for (let i = 0; i < ntypes; i++) {
    const kind = r.byte();
    const t = { kind, kindName: TYPE_KINDS[kind] ?? `kind${kind}` };
    switch (kind) {
      case 10: case 20: { // fun / method
        const nargs = r.byte();
        t.args = new Array(nargs);
        for (let j = 0; j < nargs; j++) t.args[j] = r.index();
        t.ret = r.index();
        break;
      }
      case 11: case 21: { // obj / struct
        t.name = strings[r.uindex()];
        t.super = r.index();
        t.global = r.uindex();
        const nfields = r.uindex();
        const nprotos = r.uindex();
        const nbindings = r.uindex();
        t.fields = new Array(nfields);
        for (let j = 0; j < nfields; j++) {
          t.fields[j] = { name: strings[r.uindex()], type: r.index() };
        }
        t.protos = new Array(nprotos);
        for (let j = 0; j < nprotos; j++) {
          t.protos[j] = { name: strings[r.uindex()], findex: r.uindex(), pindex: r.index() };
        }
        t.bindings = new Array(nbindings);
        for (let j = 0; j < nbindings; j++) {
          t.bindings[j] = { field: r.uindex(), findex: r.uindex() };
        }
        break;
      }
      case 14: case 19: case 22: // ref / null / packed
        t.type = r.index();
        break;
      case 15: { // virtual
        const nfields = r.uindex();
        t.fields = new Array(nfields);
        for (let j = 0; j < nfields; j++) {
          t.fields[j] = { name: strings[r.uindex()], type: r.index() };
        }
        break;
      }
      case 17: // abstract
        t.name = strings[r.uindex()];
        break;
      case 18: { // enum
        t.name = strings[r.uindex()];
        t.global = r.uindex();
        const ncons = r.uindex();
        t.constructs = new Array(ncons);
        for (let j = 0; j < ncons; j++) {
          const name = strings[r.uindex()];
          const nparams = r.uindex();
          const params = new Array(nparams);
          for (let k = 0; k < nparams; k++) params[k] = r.index();
          t.constructs[j] = { name, params };
        }
        break;
      }
      default:
        if (kind >= TYPE_KINDS.length) throw new Error(`bad type kind ${kind} at ${r.pos}`);
      // primitives and array/type/dynobj carry no payload
    }
    types[i] = t;
  }

  const globals = new Array(nglobals);
  for (let i = 0; i < nglobals; i++) globals[i] = r.index();

  const natives = new Array(nnatives);
  for (let i = 0; i < nnatives; i++) {
    natives[i] = {
      lib: strings[r.uindex()],
      name: strings[r.uindex()],
      type: r.index(),
      findex: r.uindex(),
    };
  }

  // --- functions -------------------------------------------------------------
  const functions = new Array(nfunctions);
  for (let i = 0; i < nfunctions; i++) {
    const type = r.index();
    const findex = r.uindex();
    const nregs = r.uindex();
    const nops = r.uindex();
    const regs = new Array(nregs);
    for (let j = 0; j < nregs; j++) regs[j] = r.index();
    const ops = new Array(nops);
    for (let j = 0; j < nops; j++) {
      const op = r.byte();
      const spec = OPCODES[op] ?? (opOverrides?.has(op) ? [`Op${op}`, opOverrides.get(op)] : null);
      if (!spec) {
        const tail = ops.slice(Math.max(0, j - 15), j)
          .map((o, k) => `${j - Math.min(15, j) + k}: ${o.op} ${o.args.join(',')}${o.extra ? ' [' + o.extra.join(',') + ']' : ''}`)
          .join('\n  ');
        const err = new Error(`unknown opcode ${op} at op ${j}/${nops} of function ${findex} (pos ${r.pos})\n  ${tail}`);
        err.unknownOp = op;
        err.filePos = r.pos;
        throw err;
      }
      const [name, nargs] = spec;
      if (nargs >= 0) {
        const args = new Array(nargs);
        for (let k = 0; k < nargs; k++) args[k] = r.index();
        ops[j] = { op: name, args };
      } else if (CALL_FAMILY.has(name)) {
        const p1 = r.index();
        const p2 = r.index();
        const count = r.byte();
        const extra = new Array(count);
        for (let k = 0; k < count; k++) extra[k] = r.index();
        ops[j] = { op: name, args: [p1, p2], extra };
      } else { // Switch
        const reg = r.uindex();
        const ncases = r.uindex();
        const offsets = new Array(ncases);
        for (let k = 0; k < ncases; k++) offsets[k] = r.uindex();
        const end = r.uindex();
        ops[j] = { op: name, args: [reg, end], extra: offsets };
      }
    }
    let debug = null;
    let assigns = null;
    if (hasDebug) {
      // Run-length encoded (file, line) per op, exactly code.c's automaton.
      debug = new Array(nops * 2);
      let curfile = -1, curline = 0, at = 0;
      while (at < nops) {
        let c = r.byte();
        if (c & 1) {
          c >>= 1;
          curfile = (c << 8) | r.byte();
        } else if (c & 2) {
          const delta = c >> 6;
          let count = (c >> 2) & 15;
          while (count--) { debug[at * 2] = curfile; debug[at * 2 + 1] = curline; at++; }
          curline += delta;
        } else if (c & 4) {
          curline += c >> 3;
          debug[at * 2] = curfile; debug[at * 2 + 1] = curline; at++;
        } else {
          const b2 = r.byte(), b3 = r.byte();
          curline = (c >> 3) | (b2 << 5) | (b3 << 13);
          debug[at * 2] = curfile; debug[at * 2 + 1] = curline; at++;
        }
      }
      if (version >= 3) {
        // Local variable names: (name, opcode position). Kept - they are what
        // makes a listing readable.
        const nassigns = r.uindex();
        assigns = new Array(nassigns);
        for (let j = 0; j < nassigns; j++) {
          assigns[j] = { name: strings[r.uindex()], at: r.index() };
        }
      }
    }
    functions[i] = { type, findex, regs, ops, debug, assigns };
  }

  const constants = new Array(nconstants);
  for (let i = 0; i < nconstants; i++) {
    const global = r.uindex();
    const nfields = r.uindex();
    const fields = new Array(nfields);
    for (let j = 0; j < nfields; j++) fields[j] = r.uindex();
    constants[i] = { global, fields };
  }

  if (r.pos !== buf.length) {
    throw new Error(`parse desync: stopped at ${r.pos} of ${buf.length}`);
  }

  // --- name resolution -------------------------------------------------------
  // findex -> "Type.method". Protos are instance methods, bindings statics.
  const fnNames = new Map();
  for (const t of types) {
    if (t.kind !== 11 && t.kind !== 21) continue;
    for (const p of t.protos ?? []) fnNames.set(p.findex, `${t.name}.${p.name}`);
    for (const b of t.bindings ?? []) {
      const f = t.fields?.[b.field];
      if (f) fnNames.set(b.findex, `${t.name}.${f.name}`);
    }
  }
  for (const n of natives) fnNames.set(n.findex, `${n.lib}.${n.name} [native]`);

  const byFindex = new Map(functions.map((f) => [f.findex, f]));

  return {
    version, flags, hasDebug, entrypoint,
    ints, floats, strings, debugFiles, types, globals, natives, functions,
    constants, fnNames, byFindex,
    nameOf: (findex) => fnNames.get(findex) ?? null,
  };
}

// --- disassembly -------------------------------------------------------------
export function typeName(code, tIdx) {
  const t = code.types[tIdx];
  if (!t) return `t${tIdx}`;
  switch (t.kind) {
    case 10: case 20:
      return `(${(t.args ?? []).map((a) => typeName(code, a)).join(', ')}) -> ${typeName(code, t.ret)}`;
    case 11: case 21: case 17: case 18: return t.name;
    case 14: return `ref<${typeName(code, t.type)}>`;
    case 19: return `null<${typeName(code, t.type)}>`;
    case 15: return `virtual<${(t.fields ?? []).map((f) => f.name).join(',')}>`;
    default: return t.kindName;
  }
}

// Field name for `Field/SetField dst, obj, fieldIndex` - resolved through the
// register's object type, walking supers the way field indexes do (a child's
// field indexes continue its parent's).
function fieldName(code, regType, fieldIdx) {
  let t = code.types[regType];
  while (t && (t.kind === 14 || t.kind === 19 || t.kind === 22)) t = code.types[t.type];
  if (!t) return `f${fieldIdx}`;
  if (t.kind === 15) return t.fields?.[fieldIdx]?.name ?? `f${fieldIdx}`;
  if (t.kind !== 11 && t.kind !== 21) return `f${fieldIdx}`;
  // Collect the inheritance chain root-first, then index into the flattened
  // field list.
  const chain = [];
  let cur = t;
  while (cur) {
    chain.unshift(cur);
    cur = cur.super >= 0 ? code.types[cur.super] : null;
  }
  let flat = [];
  for (const c of chain) flat = flat.concat(c.fields ?? []);
  return flat[fieldIdx]?.name ?? `f${fieldIdx}`;
}

/** A readable listing of one function, refs resolved. */
export function disasm(code, findex) {
  const f = code.byFindex.get(findex);
  if (!f) {
    const nat = code.natives.find((n) => n.findex === findex);
    if (nat) return `${findex}: native ${nat.lib}.${nat.name}: ${typeName(code, nat.type)}`;
    throw new Error(`no function with findex ${findex}`);
  }
  const lines = [];
  const name = code.nameOf(findex) ?? '(unnamed)';
  lines.push(`fn ${name}@${findex}: ${typeName(code, f.type)}`);
  if (f.debug && code.debugFiles.length) {
    const file = code.debugFiles[f.debug[0]] ?? '?';
    lines.push(`  // ${file}:${f.debug[1]}`);
  }
  lines.push(`  // ${f.regs.length} regs: ${f.regs.map((t, i) => `r${i}:${typeName(code, t)}`).join(' ')}`);
  const assignAt = new Map();
  for (const a of f.assigns ?? []) {
    // Positions are 1-based op indexes; 0 and negatives name arguments.
    if (a.at > 0) assignAt.set(a.at - 1, (assignAt.get(a.at - 1) ?? []).concat(a.name));
  }
  for (let i = 0; i < f.ops.length; i++) {
    const o = f.ops[i];
    const A = o.args;
    let s;
    const jump = (k) => `-> ${i + 1 + A[k]}`;
    switch (o.op) {
      case 'Int': s = `r${A[0]} = ${code.ints[A[1]]}`; break;
      case 'Float': s = `r${A[0]} = ${code.floats[A[1]]}`; break;
      case 'String': s = `r${A[0]} = "${code.strings[A[1]]}"`; break;
      case 'Bool': s = `r${A[0]} = ${A[1] !== 0}`; break;
      case 'GetGlobal': s = `r${A[0]} = global@${A[1]} :${typeName(code, code.globals[A[1]])}`; break;
      case 'SetGlobal': s = `global@${A[0]} :${typeName(code, code.globals[A[0]])} = r${A[1]}`; break;
      case 'Field': s = `r${A[0]} = r${A[1]}.${fieldName(code, f.regs[A[1]], A[2])}`; break;
      case 'SetField': s = `r${A[0]}.${fieldName(code, f.regs[A[0]], A[1])} = r${A[2]}`; break;
      case 'GetThis': s = `r${A[0]} = this.${fieldName(code, f.regs[0], A[1])}`; break;
      case 'SetThis': s = `this.${fieldName(code, f.regs[0], A[0])} = r${A[1]}`; break;
      case 'Call0': s = `r${A[0]} = ${code.nameOf(A[1]) ?? 'fn'}@${A[1]}()`; break;
      case 'Call1': s = `r${A[0]} = ${code.nameOf(A[1]) ?? 'fn'}@${A[1]}(r${A[2]})`; break;
      case 'Call2': s = `r${A[0]} = ${code.nameOf(A[1]) ?? 'fn'}@${A[1]}(r${A[2]}, r${A[3]})`; break;
      case 'Call3': s = `r${A[0]} = ${code.nameOf(A[1]) ?? 'fn'}@${A[1]}(r${A[2]}, r${A[3]}, r${A[4]})`; break;
      case 'Call4': s = `r${A[0]} = ${code.nameOf(A[1]) ?? 'fn'}@${A[1]}(r${A[2]}, r${A[3]}, r${A[4]}, r${A[5]})`; break;
      case 'CallN': s = `r${A[0]} = ${code.nameOf(A[1]) ?? 'fn'}@${A[1]}(${o.extra.map((x) => `r${x}`).join(', ')})`; break;
      case 'CallMethod': s = `r${A[0]} = r${o.extra[0]}.proto${A[1]}(${o.extra.slice(1).map((x) => `r${x}`).join(', ')})`; break;
      case 'CallThis': s = `r${A[0]} = this.proto${A[1]}(${o.extra.map((x) => `r${x}`).join(', ')})`; break;
      case 'CallClosure': s = `r${A[0]} = r${A[1]}(${o.extra.map((x) => `r${x}`).join(', ')})`; break;
      case 'StaticClosure': s = `r${A[0]} = &${code.nameOf(A[1]) ?? 'fn'}@${A[1]}`; break;
      case 'InstanceClosure': s = `r${A[0]} = r${A[2]}.&${code.nameOf(A[1]) ?? 'fn'}@${A[1]}`; break;
      case 'JTrue': s = `if r${A[0]} ${jump(1)}`; break;
      case 'JFalse': s = `if !r${A[0]} ${jump(1)}`; break;
      case 'JNull': s = `if r${A[0]} == null ${jump(1)}`; break;
      case 'JNotNull': s = `if r${A[0]} != null ${jump(1)}`; break;
      case 'JSLt': case 'JULt': s = `if r${A[0]} < r${A[1]} ${jump(2)}`; break;
      case 'JSGte': case 'JUGte': s = `if r${A[0]} >= r${A[1]} ${jump(2)}`; break;
      case 'JSGt': s = `if r${A[0]} > r${A[1]} ${jump(2)}`; break;
      case 'JSLte': s = `if r${A[0]} <= r${A[1]} ${jump(2)}`; break;
      case 'JNotLt': s = `if !(r${A[0]} < r${A[1]}) ${jump(2)}`; break;
      case 'JNotGte': s = `if !(r${A[0]} >= r${A[1]}) ${jump(2)}`; break;
      case 'JEq': s = `if r${A[0]} == r${A[1]} ${jump(2)}`; break;
      case 'JNotEq': s = `if r${A[0]} != r${A[1]} ${jump(2)}`; break;
      case 'JAlways': s = `goto ${i + 1 + A[0]}`; break;
      case 'Switch': s = `switch r${A[0]} [${o.extra.map((x, k) => `${k}:${i + 1 + x}`).join(' ')}] end ${i + 1 + A[1]}`; break;
      case 'Add': s = `r${A[0]} = r${A[1]} + r${A[2]}`; break;
      case 'Sub': s = `r${A[0]} = r${A[1]} - r${A[2]}`; break;
      case 'Mul': s = `r${A[0]} = r${A[1]} * r${A[2]}`; break;
      case 'SDiv': case 'UDiv': s = `r${A[0]} = r${A[1]} / r${A[2]}`; break;
      case 'Ret': s = `ret r${A[0]}`; break;
      default: {
        const extra = o.extra ? ` [${o.extra.join(',')}]` : '';
        s = `${o.op} ${A.join(', ')}${extra}`;
      }
    }
    const names = assignAt.get(i);
    const lineInfo = f.debug ? ` ; L${f.debug[i * 2 + 1]}` : '';
    lines.push(`  ${String(i).padStart(4)}: ${s}${names ? `   // ${names.join(', ')}` : ''}${lineInfo}`);
  }
  return lines.join('\n');
}
