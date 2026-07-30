// ---------------------------------------------------------------------------
// cdb.mjs - load Farever's CastleDB out of the player's own copy of the game.
//
// Everything this tool knows comes from `data.cdb` inside `res.light.pak`.
// Nothing is hardcoded: every coefficient is a lookup by CastleDB id, and an
// id that does not resolve is a loud failure rather than a silent zero. That
// is the one discipline that lets a tool survive a patch every few weeks.
//
// Two decodings matter and are easy to miss:
//
//   * Enum columns. A column's `typeStr` of "5:A,B,C" means the stored value
//     is an index into that list. `enumName(sheet, col, value)` resolves it.
//
//   * Custom-type columns. A `typeStr` of "9:<Name>" is an index into
//     `cdb.customTypes`, and the stored value is `[caseIndex, ...args]`.
//     Without this table `attribute.scaling[].scalingOperator` is an opaque
//     array of numbers; with it, `[2,150,1000,20]` reads as
//     `Rating(min=150, max=1000, target=20)`. Eight columns across the
//     database are kind-9, so decode them by default.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openPak } from './lib/pak.mjs';
import { requireGame } from './lib/game.mjs';

export class Cdb {
  constructor(raw, meta) {
    this.raw = raw;
    this.meta = meta;
    this.sheets = new Map(raw.sheets.map((s) => [s.name, s]));
    this.customTypes = new Map((raw.customTypes ?? []).map((t) => [t.name, t]));
    this._byId = new Map();
  }

  // A sheet, or a hard failure naming it. A missing sheet means the game
  // changed shape under us, which must never be papered over.
  sheet(name) {
    const s = this.sheets.get(name);
    if (!s) throw new Error(`cdb: no sheet "${name}" (game data changed?)`);
    return s;
  }

  lines(name) {
    return this.sheet(name).lines ?? [];
  }

  // Row lookup by id, memoised per sheet.
  byId(name) {
    let m = this._byId.get(name);
    if (!m) {
      m = new Map(this.lines(name).map((l) => [l.id, l]));
      this._byId.set(name, m);
    }
    return m;
  }

  row(name, id) {
    const r = this.byId(name).get(id);
    if (r === undefined) throw new Error(`cdb: no ${name} row "${id}"`);
    return r;
  }

  has(name, id) {
    return this.byId(name).has(id);
  }

  // The `typeStr` of a column, including for nested columns addressed the way
  // CastleDB itself names them: "skill@steps@effects" is a sheet of its own.
  column(sheetName, colName) {
    const c = this.sheet(sheetName).columns.find((x) => x.name === colName);
    if (!c) throw new Error(`cdb: no column ${sheetName}.${colName}`);
    return c;
  }

  // The label list behind an enum column ("5:Damage,Heal,..." -> [...]).
  enumValues(sheetName, colName) {
    const t = this.column(sheetName, colName).typeStr ?? '';
    const m = /^(?:5|10):(.*)$/.exec(t);
    if (!m) throw new Error(`cdb: ${sheetName}.${colName} is not an enum/flags column (typeStr ${t})`);
    return m[1].split(',');
  }

  enumName(sheetName, colName, value) {
    const vs = this.enumValues(sheetName, colName);
    return value >= 0 && value < vs.length ? vs[value] : null;
  }

  // Decode the bits of a flags column into names.
  flagNames(sheetName, colName, bits) {
    const vs = this.enumValues(sheetName, colName);
    return vs.filter((_, i) => ((bits ?? 0) >> i) & 1);
  }

  // Decode a kind-9 custom-type value: [caseIndex, ...args] -> {case, args}.
  custom(typeName, value) {
    const t = this.customTypes.get(typeName);
    if (!t) throw new Error(`cdb: no customType "${typeName}"`);
    if (!Array.isArray(value) || value.length === 0) return null;
    const c = t.cases[value[0]];
    if (!c) throw new Error(`cdb: ${typeName} case index ${value[0]} out of range`);
    const args = {};
    (c.args ?? []).forEach((a, i) => { args[a.name] = value[i + 1]; });
    return { case: c.name, args };
  }

  // A `constant` row's payload. The sheet stores one tagged value per row:
  // {int:n} | {float:n} | {bool:b} | {floats:[{v,desc}]} | {group:[...]} | ...
  // `constant(id)` returns the scalar where there is one, else the raw value.
  constant(id) {
    const v = this.row('constant', id).v;
    if (v == null) return null;
    if ('int' in v) return v.int;
    if ('float' in v) return v.float;
    if ('bool' in v) return v.bool;
    return v;
  }

  // A `{floats:[{v},...]}` constant as a plain number array.
  constantFloats(id) {
    const v = this.row('constant', id).v;
    if (!v || !Array.isArray(v.floats)) throw new Error(`cdb: constant ${id} is not a float list`);
    return v.floats.map((f) => f.v);
  }
}

// The four archives, and what a missing one costs. res.light.pak is the only
// hard requirement here: it holds the CastleDB, which is the whole model.
export function loadCdb({ game, quiet = false } = {}) {
  const dir = game ?? requireGame();
  const pakPath = join(dir, 'res.light.pak');
  if (!existsSync(pakPath)) {
    throw new Error(
      `res.light.pak is not in ${dir}.\n` +
      'It holds the CastleDB, which is the entire model. If Steam is still\n' +
      'downloading or verifying, let it finish and re-run.'
    );
  }

  const pak = openPak(pakPath);
  let buf;
  try {
    buf = pak.read('data.cdb');
  } finally {
    pak.close();
  }

  const cdbSha = createHash('sha256').update(buf).digest('hex');
  const bootPath = join(dir, 'hlboot.dat');
  const bootSha = existsSync(bootPath)
    ? createHash('sha256').update(readFileSync(bootPath)).digest('hex')
    : null;

  const raw = JSON.parse(buf.toString('utf8'));
  if (!quiet && !raw.sheets) throw new Error('cdb: no sheets in data.cdb');

  // Both hashes travel with every result. A build shared across a patch has
  // to be rejectable rather than silently re-evaluated against new numbers.
  return new Cdb(raw, { game: dir, cdbSha, bootSha });
}
