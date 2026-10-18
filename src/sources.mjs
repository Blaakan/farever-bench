// ---------------------------------------------------------------------------
// sources.mjs - what in this install HANDS AN ITEM OUT, read rather than
// assumed.
//
// The bench used to offer every stat-bearing row in the `item` sheet. On build
// 25782799 that stopped being true to the game: 26 of the 125 new Epic rows
// sit only in four loot tables nothing points at, and four of the fifteen
// infusion patterns drop only in a difficulty the client refuses to open.
// Offering those is recommending gear nobody can wear.
//
// "Nothing hands it out" is a claim about the WHOLE install, so it needs the
// whole search, and half of the facts are not in data.cdb at all:
//
//   * data.cdb declares three sheets it leaves EMPTY - `element`, `activity`,
//     `spawner` - because their rows live in the level files. A prefab node
//     whose `props` carries `$cdbtype: "element"` IS a row of that sheet, with
//     the columns the cdb declares for it. So every merchant's shop list, every
//     chest's loot table, every spawner's unit and every dungeon's
//     `heroicReleaseStatus` is an ordinary typed row; it is just stored in
//     the install's other archives (res.pak, res.map.pak and res.levels.pak
//     on build 25782799) instead of in the database.
//   * A loot table is alive when something NAMES it. The cdb says exactly which
//     columns can: the ones whose type is a reference to `lootTable`
//     (unit.props.lootTable / bossLootTable / heroicLootTable,
//     item.props.gainItem.lootTable, element.props.lootTable, ...). Walking the
//     schema rather than grepping strings matters here - `Bee`, `Kobold`,
//     `Cleodora` and `Phrixes` are loot table ids AND faction or unit ids.
//
// So this module reads the prefabs of EVERY archive in the install through the
// cdb's own schema, and answers three questions with their evidence attached:
//
//   release(item)          live | unreleased | unknown, and why
//   minInstanceLevel(item) the lowest level an instance can exist at
//   heroicOf(unit)         is Heroic open for the dungeon that holds this boss
//
// What it does NOT know, and says so rather than guessing: anything the server
// decides (the release status read here is the CLIENT's copy), and anything
// handed out by code with no data row behind it - an item with no source row
// at all is `unknown`, never `unreleased`.
// ---------------------------------------------------------------------------

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openPak } from './lib/pak.mjs';
import { readHBSON } from './lib/hbson.mjs';
import { readHlb } from './lib/hl.mjs';

// WHICH ARCHIVES. Not a list kept here: "no level file in this install names
// it" is a sentence about every archive, and one typed out would go on being
// printed, unproven, the day a patch ships a fifth. Two reads instead:
//
//   * every `*.pak` in the game directory is opened and searched - the four
//     of build 25782799 (res.light.pak holds the cdb and turns out to hold no
//     prefab), and whatever a later patch adds;
//   * the names the GAME'S OWN LOADER opens are taken from the bytecode
//     (readCodeLiterals().paks - fn@22704, Main.hx:208-217, hands res.pak,
//     res.light.pak, res.map.pak and res.levels.pak to
//     hxd.fmt.pak.FileSystem.loadPak, after res<N>.pak for as long as one
//     exists). One of those missing from the directory is a partial install -
//     Steam still downloading - and a partial read is no read.

// One read per install per process: ~4,600 prefabs, ~6 MB, well under 100 ms,
// but an engine is built ninety times by the test suite.
const prefabCache = new Map();

/**
 * Every `$cdbtype` row the install's prefabs hold.
 *
 * @param named the archive names the game's loader opens, or null when the
 *              bytecode did not say - then what is in the directory is all
 *              there is to go on
 * @returns {read, why, paks, files, rows[], placedBy}
 *   paks     every archive searched, whether or not it held a prefab
 *   rows[]   {sheet, row, pak, file, level}  - `level` is the `.dat` directory
 *            the file belongs to (a world or a dungeon), or null for a template
 *   placedBy Map(template path -> Set(file that instantiates it via `source`))
 */
export function readPrefabRows(game, { named = null } = {}) {
  const none = (why) => ({ read: false, why, paks: [], files: 0, rows: [], placedBy: new Map() });
  if (!game) return none('no install directory is known for this data');
  let present;
  try {
    present = readdirSync(game).filter((n) => /\.pak$/i.test(n) && statSync(join(game, n)).isFile()).sort();
  } catch (e) {
    return none(`${game} could not be listed (${e.message})`);
  }
  const stamp = present.map((n) => {
    const st = statSync(join(game, n));
    return `${n}:${st.size}:${st.mtimeMs}`;
  }).join('|');
  const key = game + '|' + stamp + '|' + (named ?? []).join(',');
  const hit = prefabCache.get(key);
  if (hit) return hit;

  const out = { read: false, why: null, paks: present, files: 0, rows: [], placedBy: new Map() };
  const lower = new Set(present.map((n) => n.toLowerCase()));
  const missing = (named ?? []).filter((n) => !lower.has(n.toLowerCase()));
  if (missing.length || !present.length) {
    // A partial read cannot support "no prefab names it", so it is no read.
    out.why = missing.length
      ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in ${game}, and the game's loader opens ${missing.length === 1 ? 'it' : 'them'}`
      : `there is no .pak archive in ${game}`;
    prefabCache.set(key, out);
    return out;
  }
  // Which archive, and which file of it, a failure is about - an archive that
  // cannot be opened is named, because the sentence that depends on it is
  // "no level file in this install".
  let at = null;
  try {
    for (const name of present) {
      at = `${name} could not be opened`;
      const pak = openPak(join(game, name));
      try {
        for (const f of pak.files) {
          if (!f.path.endsWith('.prefab')) continue;
          at = `${f.path} in ${name} could not be parsed`;
          const buf = pak.read(f);
          if (buf.length < 6 || buf.toString('latin1', 0, 5) !== 'HBSON') continue;
          const root = readHBSON(buf).root;
          out.files++;
          const dat = /^(.*?\.dat)\//.exec(f.path);
          const level = dat ? dat[1] : null;
          const walk = (node) => {
            if (Array.isArray(node)) { for (const x of node) walk(x); return; }
            if (!node || typeof node !== 'object') return;
            if (typeof node.source === 'string' && node.source.endsWith('.prefab')) {
              let s = out.placedBy.get(node.source);
              if (!s) out.placedBy.set(node.source, s = new Set());
              s.add(f.path);
            }
            const p = node.props;
            if (p && typeof p === 'object' && typeof p.$cdbtype === 'string') {
              out.rows.push({ sheet: p.$cdbtype, row: p, pak: name, file: f.path, level, instanceOf: typeof node.source === 'string' ? node.source : null });
            }
            for (const k of Object.keys(node)) {
              const v = node[k];
              if (v && typeof v === 'object') walk(v);
            }
          };
          walk(root);
        }
      } finally {
        pak.close();
      }
    }
    out.read = true;
  } catch (e) {
    out.why = `${at ?? 'the archives could not be read'} (${e.message})`;
    out.files = 0;
    out.rows = [];
    out.placedBy = new Map();
  }
  prefabCache.set(key, out);
  return out;
}

// --- what the compiled code names ------------------------------------------
// The third store. A loot table can be handed out by a function that names it
// as a string literal and by nothing else - st.activity.RiftContext.
// RiftContext.dropBossActivityLoot@31535 loads "Rift_Tier4" and "Rift_Tier6",
// ent.$Unit.getLootFromUnit@15919 loads "FoeEliteDrops" - and no row anywhere
// points at those. So "nothing names it" has to look here too.
//
// A literal reaches a function two ways: a `String` op, or a `GetGlobal` of a
// constant global whose initialiser holds the string index. One function names
// EVERY row of a sheet - the generated id table (fn@48683 on build 25959898
// loads all 156 loot table ids) - and that says nothing about any of them, so
// a function that loads more than half of a sheet's ids is not a referrer.
//
// What a function DOES with the id is not read. A mention is therefore never
// proof that the thing drops; it is only enough to stop this reader calling
// it dead.
const codeCache = new Map();

/**
 * @param groups {name: Set(ids)} - e.g. {lootTable: ..., item: ...}
 * @returns {read, why, by: Map(id -> [function names]), paks}
 *   paks  the archive names a function hands to the pak loader, or null when
 *         no such function was found - see WHICH ARCHIVES above
 */
export function readCodeLiterals(game, groups) {
  const none = (why) => ({ read: false, why, by: new Map(), paks: null });
  if (!game) return none('no install directory is known for this data');
  const boot = join(game, 'hlboot.dat');
  if (!existsSync(boot)) return none(`hlboot.dat is not in ${game}`);
  const st = statSync(boot);
  const key = `${boot}:${st.size}:${st.mtimeMs}:${Object.entries(groups).map(([k, v]) => k + v.size).join(',')}`;
  const hit = codeCache.get(key);
  if (hit) return hit;
  let out;
  try {
    const code = readHlb(boot);
    const kindOf = new Map();          // string index -> [group, id]
    code.strings.forEach((s, i) => {
      for (const [g, ids] of Object.entries(groups)) if (ids.has(s)) { kindOf.set(i, [g, s]); break; }
    });
    const viaGlobal = new Map();       // constant global -> [group, id]
    for (const c of code.constants ?? []) {
      for (const f of c.fields ?? []) if (kindOf.has(f)) viaGlobal.set(c.global, kindOf.get(f));
    }
    const perFn = new Map();           // findex -> {group -> Set(id)}
    for (const f of code.functions) {
      for (const o of f.ops) {
        const k = o.op === 'String' ? kindOf.get(o.args[1]) : o.op === 'GetGlobal' ? viaGlobal.get(o.args[1]) : null;
        if (!k) continue;
        let m = perFn.get(f.findex);
        if (!m) perFn.set(f.findex, m = {});
        (m[k[0]] ??= new Set()).add(k[1]);
      }
    }
    const by = new Map();
    for (const [findex, m] of perFn) {
      for (const [g, ids] of Object.entries(m)) {
        if (ids.size > groups[g].size / 2) continue;   // the id table, not a referrer
        const name = `${code.nameOf(findex) ?? 'fn'}@${findex}`;
        for (const id of ids) { let a = by.get(id); if (!a) by.set(id, a = []); a.push(name); }
      }
    }
    // The archives the game opens by name: every "<stem>.pak" literal in a
    // function that calls hxd.fmt.pak.FileSystem.loadPak directly. Found by
    // the loader's NAME, so a build that renames it yields no list (null)
    // rather than a wrong one.
    const loadPak = new Set(code.functions.map((f) => f.findex)
      .filter((findex) => code.nameOf(findex) === 'hxd.fmt.pak.FileSystem.loadPak'));
    const pakString = new Map();       // string index -> name
    code.strings.forEach((s, i) => { if (/^[^\\/]+\.pak$/i.test(s)) pakString.set(i, s); });
    const pakGlobal = new Map();       // constant global -> name
    for (const c of code.constants ?? []) {
      for (const f of c.fields ?? []) if (pakString.has(f)) pakGlobal.set(c.global, pakString.get(f));
    }
    const paks = new Set();
    for (const f of code.functions) {
      if (!f.ops.some((o) => /^Call[0-4N]$/.test(o.op) && loadPak.has(o.args[1]))) continue;
      for (const o of f.ops) {
        const name = o.op === 'String' ? pakString.get(o.args[1]) : o.op === 'GetGlobal' ? pakGlobal.get(o.args[1]) : null;
        if (name) paks.add(name);
      }
    }
    out = { read: true, why: null, by, paks: paks.size ? [...paks].sort() : null };
  } catch (e) {
    out = none(`hlboot.dat could not be parsed (${e.message})`);
  }
  codeCache.set(key, out);
  return out;
}

// --- the schema walk ---------------------------------------------------------
// A column either carries its own type or borrows another column's whole
// definition through `structRef: "types@props@gains"` - that is how
// `releaseStatus` and `gains` are shared between element, activity and the
// rest. Nested rows are sheets of their own, named `parent@column`.
function columnDef(cdb, sheetName, col) {
  if (col.structRef) {
    const at = col.structRef.lastIndexOf('@');
    const host = cdb.sheets.get(col.structRef.slice(0, at));
    const def = host?.columns.find((c) => c.name === col.structRef.slice(at + 1));
    return def ? { def, sub: col.structRef } : null;
  }
  return { def: col, sub: `${sheetName}@${col.name}` };
}

/** visit(targetSheet, value, path, holder) for every reference column in a row. */
function walkRefs(cdb, sheetName, row, visit, path = '') {
  const sheet = cdb.sheets.get(sheetName);
  if (!sheet || !row || typeof row !== 'object') return;
  for (const col of sheet.columns) {
    const v = row[col.name];
    if (v == null) continue;
    const r = columnDef(cdb, sheetName, col);
    if (!r) continue;
    const t = r.def.typeStr ?? '';
    const p = path ? `${path}.${col.name}` : col.name;
    if (t.startsWith('6:')) {
      if (typeof v === 'string') visit(t.slice(2), v, p, row);
    } else if (t === '8') {
      if (Array.isArray(v)) v.forEach((x, i) => walkRefs(cdb, r.sub, x, visit, `${p}[${i}]`));
    } else if (t === '17') {
      walkRefs(cdb, r.sub, v, visit, p);
    }
  }
}

const graphCache = new Map();

export function buildSources(cdb) {
  const key = (cdb.meta?.cdbSha ?? '') + '|' + (cdb.meta?.game ?? '');
  if (cdb.meta?.cdbSha && graphCache.has(key)) return graphCache.get(key);

  const tables = cdb.sheets.has('lootTable') ? cdb.byId('lootTable') : new Map();
  const items = cdb.byId('item');
  const units = cdb.byId('unit');
  // The bytecode first: besides the ids it names, it says which archives the
  // game opens, and the prefab read is checked against that list.
  //
  // Loot table ids are faction and unit ids too (`Bee`, `Cleodora`), so a
  // literal can be a mention of something else entirely - which only ever
  // errs towards "unknown", the safe side.
  const code = readCodeLiterals(cdb.meta?.game ?? null,
    { lootTable: new Set(tables.keys()), item: new Set(items.keys()) });
  const prefabsAsRead = readPrefabRows(cdb.meta?.game ?? null, { named: code.paks });

  // --- the two enums a gate is stated in ------------------------------------
  // A release status is stored as an INDEX into its column's list, and the
  // column is a borrowed one (`activity@props.heroicReleaseStatus` is
  // `structRef: types@props@releaseStatus`), so the names are resolved through
  // the column that CARRIES the value - not from a sheet named here.
  //
  // $HData.checkStatus@21563, by NAME: null -> open; Disabled, Development ->
  // closed; Beta -> `getServerBranch() != "live"`, so closed for the build
  // Steam ships; Release -> open. The function's switch ends in a default
  // `false`, but that is this build's answer to an index it has no case for.
  // An index this cdb gives no name, or a name the function was not read for,
  // is therefore NOT JUDGED here: reading it as shut withheld gear with the
  // sentence "heroicReleaseStatus #3, which checkStatus refuses" the moment
  // the enum moved - and 3 is Release.
  const STATUS_OPEN = new Map([['Disabled', false], ['Development', false], ['Beta', false], ['Release', true]]);
  const statusNamesOf = new Map();
  const statusNames = (sheetName, colName) => {
    const key = `${sheetName}.${colName}`;
    if (!statusNamesOf.has(key)) {
      const col = cdb.sheets.get(sheetName)?.columns.find((c) => c.name === colName);
      const def = col ? columnDef(cdb, sheetName, col)?.def : null;
      const m = /^5:(.*)$/.exec(def?.typeStr ?? '');
      statusNamesOf.set(key, m ? { names: m[1].split(',') } : {
        names: null,
        why: !col ? `\`${sheetName}\` declares no column \`${colName}\` in this data.cdb`
          : !def ? `its column borrows \`${col.structRef}\`, which this data.cdb does not define`
            : `its column is not an enum in this data.cdb (typeStr ${def.typeStr ?? 'none'})`,
      });
    }
    return statusNamesOf.get(key);
  };
  /**
   * @param sheetName, colName where the value sits, e.g. `activity@props`,
   *                           `heroicReleaseStatus`
   * @returns {judged, open, name, why}  `open` is null when not judged
   */
  function checkStatus(v, sheetName, colName) {
    if (v == null) return { judged: true, open: true, name: null };
    const { names, why } = statusNames(sheetName, colName);
    const name = names?.[v] ?? null;
    if (STATUS_OPEN.has(name)) return { judged: true, open: STATUS_OPEN.get(name), name };
    return {
      judged: false, open: null, name,
      why: !names ? `and ${why}, so nothing names it`
        : name == null ? `and its column names only ${names.join(', ')}`
          : `which reads "${name}" - a status $HData.checkStatus@21563 was not read for`,
    };
  }
  // ONE status that cannot be judged takes the whole prefab store with it. The
  // enum is shared, so if one row's gate is unreadable every row's is, and a
  // reader that cannot tell an open merchant from a shut one can show nothing
  // to be unobtainable: nothing is withheld, and the output says why.
  let prefabs = prefabsAsRead;
  if (prefabsAsRead.read) {
    scan: for (const r of prefabsAsRead.rows) {
      if (!cdb.sheets.has(r.sheet)) continue;
      for (const col of ['releaseStatus', 'heroicReleaseStatus']) {
        const v = r.row.props?.[col];
        const g = checkStatus(v, `${r.sheet}@props`, col);
        if (g.judged) continue;
        prefabs = {
          ...prefabsAsRead, read: false,
          why: `a release status in the level files cannot be judged (${r.sheet} ${r.row.id ?? '(unnamed)'} in ${r.file} `
            + `states ${col} ${v}, ${g.why})`,
        };
        break scan;
      }
    }
  }
  // Why the level files answer nothing, as a clause: they were not read at
  // all, or they were and their gates cannot be judged.
  const noPrefabs = prefabs.read ? null
    : prefabsAsRead.read ? prefabs.why : `the level files were not read (${prefabs.why})`;

  // A loot line's `conditions.difficulty` is {min, max}, each a case of the
  // custom type its column names (`9:ActivityDifficulty`), stored as
  // [caseIndex]. The line filter fn@21756 (HItem.hx:665-669) passes it when
  // the run's difficulty d satisfies index(min) <= d <= index(max), with the
  // index taken by lib._Network.$InstanceDifficulty_Impl_.
  // fromActivityDifficulty@21757 and d = 0 when there is no instance config to
  // read it from (ops 113-128). So:
  //   no min, or a min at case 0   the line drops on the default difficulty -
  //                                no gate of its own
  //   min is the case NAMED Heroic  a Heroic-only line: it needs the Heroic of
  //                                whoever owns the table (below)
  //   anything else                not judged. What opens Veteran is not read,
  //                                and a case this cdb does not name cannot be
  //                                matched to anything - it is never dropped
  //                                to "no gate", which called a Heroic-only
  //                                pattern live when the case was not found.
  const difficultyCol = cdb.sheets.get('lootTable@loot@conditions@difficulty')?.columns.find((c) => c.name === 'min');
  const difficultyType = /^9:(.+)$/.exec(difficultyCol?.typeStr ?? '')?.[1] ?? null;
  const difficultyCases = (difficultyType ? cdb.customTypes.get(difficultyType)?.cases : null) ?? null;
  const difficultyCase = (v) => (Array.isArray(v) && v.length
    ? { index: v[0], name: difficultyCases?.[v[0]]?.name ?? null } : null);
  /** @returns {heroic, unread}  `unread` is the reason the line is not judged, or null */
  function difficultyGate(d) {
    const lo = difficultyCase(d?.min);
    const hi = difficultyCase(d?.max);
    if (!lo || lo.index === 0) return { heroic: false, unread: null };
    if (lo.name === 'Heroic' && (!hi || hi.name === 'Heroic')) return { heroic: true, unread: null };
    if (lo.name == null) {
      return {
        heroic: false,
        unread: `it asks for a minimum difficulty (case ${lo.index}) that `
          + (difficultyCases ? `${difficultyType} does not name - it has ${difficultyCases.map((c) => c.name).join(', ')}`
            : 'no custom type in this data.cdb names'),
      };
    }
    return {
      heroic: false,
      unread: `it drops from ${lo.name} difficulty${hi ? ` to ${hi.name ?? `case ${hi.index}`}` : ' up'}, and what opens that is not read`,
    };
  }
  const itemFlags = cdb.sheets.has('item') ? cdb.enumValues('item', 'flags') : [];
  const worldLootBit = itemFlags.indexOf('WorldLoot');
  const maxLevel = cdb.has('constant', 'MaxLevel') ? cdb.constant('MaxLevel') : null;

  const nameOf = (sheet, id) => {
    const r = cdb.sheets.has(sheet) ? cdb.byId(sheet).get(id) : null;
    return r?.texts?.name ?? r?.name ?? id;
  };

  // --- every reference, from both stores -----------------------------------
  const tableRefs = new Map();   // lootTable id -> [{...}]
  const itemRefs = new Map();    // item id -> [{...}] (anything but loot/craft)
  const shops = [];              // {item, cost[], conds, level, npc, row, file, pak, level, gate}
  const unitLevels = new Map();  // unit id -> Set(level dir)
  const activities = new Map();  // level dir -> [{id, status, heroicStatus, file}]
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  // A reference to an item is not automatically a way to GET it. Of the
  // columns typed as an item reference, these hand one over - a shop line, a
  // chest's lootItems, a dialog's gains / receiveItems, a completable's reward,
  // a unit's own equipment (a class unit's starter kit) - and the rest are a
  // PRICE (`cost[].kind`, `require[].kind`, `price.kind`), a condition
  // (`carryItems`), an NPC's costume (`npcGear`), a text template (`inherit`)
  // or a recipe input. A reference of the second kind is kept as a `mention`:
  // it never makes an item "live", and it does stop this reader from calling
  // the item unreleased, because it shows the row is wired to something.
  const GIVES = /(?:^|\.)(?:shop|lootItems|items|receiveItems|reward|itemList)\[\d+\]\.(?:item|kind)$|^parts\./;

  // SCRIPTS name things too, and no schema types what a script says: a dialog
  // that calls a loot helper with a table id is a referrer the typed walk
  // cannot see. So every code-shaped string (it has a call in it) in either
  // store is tokenised, and a loot table whose id appears as a whole token is
  // "mentioned" - never proof it drops, always enough to stop this reader
  // calling it dead.
  const scriptMentions = new Set();
  const noteScript = (v) => {
    if (typeof v === 'string') {
      if (v.length < 12 || !v.includes('(')) return;
      for (const m of v.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (tables.has(m[0])) scriptMentions.add(m[0]);
    } else if (Array.isArray(v)) { for (const x of v) noteScript(x); }
    else if (v && typeof v === 'object') { for (const k of Object.keys(v)) noteScript(v[k]); }
  };

  for (const sheet of cdb.raw.sheets) {
    if (sheet.name.includes('@')) continue;
    if (sheet.name !== 'lootTable') for (const row of sheet.lines ?? []) noteScript(row);
    // lootTable -> lootTable nesting and lootTable -> item lines are the graph
    // itself, read below; craft outputs are their own source kind.
    if (sheet.name === 'lootTable') continue;
    for (const row of sheet.lines ?? []) {
      walkRefs(cdb, sheet.name, row, (target, value, path) => {
        if (target === 'lootTable' && tables.has(value)) {
          push(tableRefs, value, { where: 'cdb', sheet: sheet.name, id: row.id ?? null, path });
        } else if (target === 'item' && items.has(value) && value !== row.id && sheet.name !== 'craft') {
          push(itemRefs, value, { where: 'cdb', sheet: sheet.name, id: row.id ?? null, path, gives: GIVES.test(path) });
        }
      });
    }
  }

  // Which files are IN THE WORLD: a level's own tiles, and any template one of
  // them instantiates through `source` (followed through templates that place
  // templates). A row in a template nothing places is not a source of anything.
  const placedFiles = new Map();   // file -> Set(level dir)
  if (prefabs.read) {
    const levelOf = new Map();
    for (const r of prefabs.rows) if (r.level) levelOf.set(r.file, r.level);
    const reach = (file, seen = new Set()) => {
      if (placedFiles.has(file)) return placedFiles.get(file);
      const out = new Set();
      if (seen.has(file)) return out;
      seen.add(file);
      const dat = /^(.*?\.dat)\//.exec(file);
      if (dat) out.add(dat[1]);
      for (const by of prefabs.placedBy.get(file) ?? []) for (const l of reach(by, seen)) out.add(l);
      placedFiles.set(file, out);
      return out;
    };
    for (const r of prefabs.rows) reach(r.file);

    for (const r of prefabs.rows) {
      noteScript(r.row);
      if (!cdb.sheets.has(r.sheet)) continue;
      const levels = placedFiles.get(r.file) ?? new Set();
      // Every status below is one the scan above could judge - `prefabs.read`
      // is false otherwise and this loop does not run.
      const gate = checkStatus(r.row.props?.releaseStatus, `${r.sheet}@props`, 'releaseStatus');
      const at = { where: 'prefab', sheet: r.sheet, id: r.row.id ?? null, pak: r.pak, file: r.file, placed: levels.size > 0, gate };
      if (r.sheet === 'activity' && r.level) {
        push(activities, r.level, {
          id: r.row.id ?? null, file: r.file, name: r.row.texts?.name ?? r.row.id ?? null,
          status: gate,
          heroic: checkStatus(r.row.props?.heroicReleaseStatus, `${r.sheet}@props`, 'heroicReleaseStatus'),
          heroicDeclared: r.row.props != null && 'heroicReleaseStatus' in r.row.props,
        });
      }
      walkRefs(cdb, r.sheet, r.row, (target, value, path, holder) => {
        if (target === 'lootTable' && tables.has(value)) push(tableRefs, value, { ...at, path });
        else if (target === 'unit' && units.has(value)) {
          for (const l of levels) { let s = unitLevels.get(value); if (!s) unitLevels.set(value, s = new Set()); s.add(l); }
        } else if (target === 'item' && items.has(value)) {
          // A shop line is `{item, cost[], level, conds}`; its `cost[].kind` is
          // an item reference too, and a price is not a source.
          if (/\.cost\[\d+\]\.kind$/.test(path)) return;
          if (/(^|\.)shop\[\d+\]\.item$/.test(path)) {
            shops.push({
              item: value, cost: holder.cost ?? [], conds: holder.conds ?? null, level: holder.level ?? null,
              npc: r.row.props?.npc?.unit ?? null, ...at,
            });
          } else push(itemRefs, value, { ...at, path, gives: GIVES.test(path) });
        }
      });
    }
  }

  // --- is Heroic open where this boss stands -------------------------------
  // The dungeon's activity row carries `heroicReleaseStatus`, and both gates on
  // a heroic run read it through checkStatus: Progress.canDoHeroicDungeon@9023
  // ops 3-10 and the lobby's own difficulty reason. The link from a boss to its
  // dungeon is the level file itself - the spawner that names the unit sits in
  // the same `.dat` as the activity row.
  function heroicOf(unitId) {
    if (!prefabs.read) return { known: false, open: null, why: noPrefabs, levels: [] };
    const levels = [...(unitLevels.get(unitId) ?? [])]
      .map((l) => ({ level: l, acts: (activities.get(l) ?? []).filter((a) => a.heroicDeclared) }))
      .filter((x) => x.acts.length);
    if (!levels.length) {
      return { known: false, open: null, why: `no level file places ${nameOf('unit', unitId)} beside a dungeon definition`, levels: [] };
    }
    const flat = levels.flatMap((x) => x.acts.map((a) => ({ level: x.level, ...a })));
    const open = flat.some((a) => a.heroic.open && a.status.open);
    return {
      known: true, open,
      levels: flat.map((a) => ({ level: a.level, activity: a.id, name: a.name, status: a.heroic.name })),
      why: open ? null
        : `Heroic is not released for ${flat.map((a) => a.name ?? a.id ?? a.level).join(' / ')} `
          + `(heroicReleaseStatus ${[...new Set(flat.map((a) => a.heroic.name))].join('/')}, which `
          + '$HData.checkStatus@21563 refuses)',
    };
  }

  // --- a table is alive when a live thing names it -------------------------
  // Each referrer is judged on its own terms:
  //   unit.props.heroicLootTable   dropBossLoot@28748 ops 55-86 reads it only
  //                                in heroic mode, so it needs heroicOf(unit)
  //   unit.props.(boss)lootTable   the kill itself
  //   item.props.gainItem          a container: alive when the container is
  //   a prefab row                 alive when placed and its own releaseStatus
  //                                passes checkStatus
  //   lootTable.loot[].lootTable   alive when the parent is
  const nestedIn = new Map();
  for (const t of tables.values()) {
    for (const l of t.loot ?? []) if (l.lootTable && tables.has(l.lootTable)) push(nestedIn, l.lootTable, t.id);
  }
  const tableState = new Map();   // id -> {live, heroicOnly, floors[], why[]}
  function judgeTable(id, stack = new Set()) {
    if (tableState.has(id)) return tableState.get(id);
    if (stack.has(id)) return { live: false, known: true, heroicOnly: false, floors: [], why: [] };
    stack.add(id);
    const res = { live: false, known: true, heroicOnly: true, floors: [], why: [], via: [] };
    const alive = (floor, heroicOnly, via) => {
      res.live = true;
      res.floors.push(floor);
      if (!heroicOnly) res.heroicOnly = false;
      res.via.push(via);
    };
    const refs = tableRefs.get(id) ?? [];
    for (const ref of refs) {
      if (ref.where === 'prefab') {
        const who = `${ref.sheet} ${ref.id ?? '(unnamed)'} in ${ref.file}`;
        // A prefab no level instantiates is not shown to be unused: the game
        // can load one by path (an activity's base definition is the case on
        // this build - Gameplay/Activities/Base.prefab names two crate tables
        // and no tile places it). So that is "not judged", never "dead".
        if (!ref.placed) {
          res.known = false;
          res.why.push(`${who} names it, and no level places that prefab - whether the game loads it another way is not read`);
        }
        else if (!ref.gate.open) res.why.push(`${who} names it and is ${ref.gate.name}-gated`);
        else alive(null, false, who);
        continue;
      }
      if (ref.sheet === 'unit' && /heroicLootTable$/.test(ref.path)) {
        const h = heroicOf(ref.id);
        if (!h.known) { res.known = false; res.why.push(`${nameOf('unit', ref.id)} drops it on Heroic, and ${h.why}`); }
        else if (!h.open) res.why.push(`${nameOf('unit', ref.id)} drops it on Heroic only, and ${h.why}`);
        // A heroic (or veteran) run is always at the cap:
        // st.Activity.getLevel@10293 returns round(Const.Hero.MaxLevel) for
        // difficulty 1 and 2, and that is the loot level the drop is made at.
        else alive(maxLevel, true, `${nameOf('unit', ref.id)} on Heroic`);
        continue;
      }
      if (ref.sheet === 'item' && /gainItem\.lootTable$/.test(ref.path)) {
        const box = release(ref.id, stack);
        const range = items.get(ref.id)?.props?.gainItem?.levelRange;
        // GainItem.getSourceItemLevel@32110 ops 25-39 clamps the opener's level
        // into the container's own levelRange.
        if (box.state === 'unreleased') res.why.push(`${nameOf('item', ref.id)} holds it, and ${box.why}`);
        else alive(range?.min ?? null, false, nameOf('item', ref.id));
        continue;
      }
      alive(null, false, ref.sheet === 'unit' ? nameOf('unit', ref.id) : `${ref.sheet} ${ref.id ?? ''}`.trim());
    }
    for (const parent of nestedIn.get(id) ?? []) {
      const p = judgeTable(parent, stack);
      if (p.live) alive(p.floors.every((f) => f != null) ? Math.min(...p.floors) : null, p.heroicOnly, `table ${parent}`);
      else if (!p.known) {
        res.known = false;
        res.why.push(`table ${parent} holds it and could not be judged${p.why.length ? ` (${p.why[0]})` : ''}`);
      }
    }
    // No prefab read means a chest or a crate that names this table is
    // invisible - so "nothing names it" cannot be said. The same goes for the
    // compiled code: a table a function hands out by literal has no row.
    if (!res.live && (!prefabs.read || !code.read)) {
      res.known = false;
      res.why.push(!prefabs.read ? noPrefabs : `the compiled code was not read (${code.why})`);
    }
    if (!res.live && res.known && code.by.has(id)) {
      res.known = false;
      res.why.push(`compiled code names it (${code.by.get(id).slice(0, 2).join(', ')}), and what that code does with it is not read`);
    }
    if (!res.live && res.known && !refs.length && !(nestedIn.get(id) ?? []).length) {
      if (scriptMentions.has(id)) {
        res.known = false;
        res.why.push('a script mentions it, and what a script does with a loot table is not read');
      } else res.why.push('no unit, item, loot table, level file, script or compiled function in this install names it');
    }
    stack.delete(id);
    tableState.set(id, res);
    return res;
  }

  // --- loot lines per item --------------------------------------------------
  const lootLines = new Map();   // item id -> [{table, heroicLine, unread}]
  for (const t of tables.values()) {
    for (const l of t.loot ?? []) {
      if (!l.item) continue;
      const gate = difficultyGate(l.conditions?.difficulty);
      push(lootLines, l.item, { table: t.id, heroicLine: gate.heroic, unread: gate.unread });
    }
  }
  // Which units own a table through a non-heroic column - a Heroic-only LINE in
  // a normal boss table needs that boss's Heroic to be open.
  const ownersOf = (tableId) => (tableRefs.get(tableId) ?? [])
    .filter((r) => r.where === 'cdb' && r.sheet === 'unit').map((r) => r.id);

  const craftOut = cdb.sheets.has('craft')
    ? new Map(cdb.lines('craft').filter((c) => c.item).map((c) => [c.item, c.id ?? c.item])) : new Map();
  const unitFactions = new Set(cdb.lines('unit').map((u) => u.faction).filter(Boolean));

  const releaseCache = new Map();
  /**
   * @returns {state: 'live'|'unreleased'|'unknown', why, sources[], dead[], unjudged[], floor}
   *   live        at least one source in this install is open
   *   unreleased  it has source rows and every one of them is shut - `why`
   *               names each and what shuts it
   *   unknown     no source row at all, or one this reader could not judge -
   *               `why` names each of those and what stopped it
   */
  function release(itemId, stack = new Set()) {
    if (releaseCache.has(itemId)) return releaseCache.get(itemId);
    const it = items.get(itemId);
    const sources = [];
    const dead = [];
    const mentions = [];
    // Every source this reader met and could not judge, each with its reason.
    // One is enough to keep the item from being called unreleased.
    const unjudged = [];
    const live = (kind, how, floor = null) => sources.push({ kind, how, floor, live: true });

    // Without the level files no merchant, chest or dialog reward is visible,
    // so whatever else is found the list of sources is not the whole list.
    if (!prefabs.read) unjudged.push(`${noPrefabs}, and a merchant, a chest or a reward in them may hand it out`);

    if (craftOut.has(itemId)) live('craft', 'a recipe makes it');
    if (it && worldLootBit >= 0 && (((it.flags ?? 0) >> worldLootBit) & 1)) live('world-loot', 'it carries the WorldLoot flag');
    // $HItem.getFactionLootTable@21743 ops 30-42 builds a faction's drop table
    // at runtime from every item with `rarity == "Rare"` and that faction.
    if (it?.rarity === 'Rare' && it.faction && unitFactions.has(it.faction)) {
      live('faction-drop', `${nameOf('faction', it.faction)} foes drop their Rare gear`);
    }
    for (const ref of itemRefs.get(itemId) ?? []) {
      if (!ref.gives) { mentions.push(ref); continue; }
      if (ref.where === 'prefab' && !ref.placed) {                               // see judgeTable
        unjudged.push(`${ref.sheet} ${ref.id ?? '(unnamed)'} in ${ref.file} gives it, and no level places that prefab`);
        continue;
      }
      if (ref.where === 'prefab' && !ref.gate.open) {
        dead.push(`${ref.sheet} ${ref.id ?? ''} gives it and is ${ref.gate.name}-gated`);
        continue;
      }
      live('row', ref.sheet === 'unit' ? `${nameOf('unit', ref.id)} carries it`
        : `${ref.sheet} ${ref.id ?? ''} gives it`.replace(/\s+/g, ' '));
    }
    for (const s of shops.filter((x) => x.item === itemId)) {
      const who = s.npc ? nameOf('unit', s.npc) : (s.id ?? 'a merchant');
      const price = (s.cost ?? []).map((c) => `${c.amount ?? 1} ${nameOf('item', c.kind)}`).join(' + ');
      if (!s.placed) unjudged.push(`${who} sells it in ${s.file}, and no level places that prefab`);   // see judgeTable
      else if (!s.gate.open) dead.push(`${who} sells it, and that merchant is ${s.gate.name}-gated (not on the live branch)`);
      else sources.push({ kind: 'shop', how: `${who} sells it${price ? ` for ${price}` : ''}`, npc: s.npc, cost: s.cost, floor: s.level ?? null, live: true });
    }
    for (const line of lootLines.get(itemId) ?? []) {
      const t = judgeTable(line.table, stack);
      if (!t.known && !t.live) { unjudged.push(`loot table ${line.table}: ${[...new Set(t.why)].join('; ')}`); continue; }
      if (!t.live) { dead.push(`loot table ${line.table}: ${t.why.join('; ')}`); continue; }
      // The table is handed out; whether THIS line of it is depends on a
      // difficulty the reader has no rule for.
      if (line.unread) { unjudged.push(`its line in loot table ${line.table}: ${line.unread}`); continue; }
      if (line.heroicLine && !t.heroicOnly) {
        // The line itself is Heroic-gated inside a table the boss also drops on
        // Normal, so it needs the Heroic of whoever owns the table.
        const owners = ownersOf(line.table);
        const hs = owners.map((u) => ({ u, h: heroicOf(u) }));
        if (hs.some((x) => x.h.known && x.h.open)) {
          const u = hs.find((x) => x.h.known && x.h.open).u;
          sources.push({ kind: 'loot', how: `${nameOf('unit', u)} drops it on Heroic`, table: line.table, unit: u, heroic: true, floor: maxLevel, live: true });
        } else if (hs.length && hs.every((x) => x.h.known)) {
          dead.push(`${owners.map((u) => nameOf('unit', u)).join(' / ')} drops it on Heroic only (loot table ${line.table}), and ${hs[0].h.why}`);
        } else if (!hs.length) {
          unjudged.push(`its line in loot table ${line.table} is Heroic-only, and no unit row names that table as its own`);
        } else {
          const x = hs.find((y) => !y.h.known);
          unjudged.push(`${nameOf('unit', x.u)} drops it on Heroic only (loot table ${line.table}), and ${x.h.why}`);
        }
        continue;
      }
      const floor = t.floors.every((f) => f != null) ? Math.min(...t.floors) : null;
      sources.push({
        kind: 'loot', table: line.table, heroic: t.heroicOnly, floor, live: true,
        how: `loot table ${line.table} (${t.via.slice(0, 2).join(', ')})`,
      });
    }

    // An item a function names by literal may be handed out by that function
    // (a starter kit, a scripted reward) - not read, so not "unreleased".
    const inCode = code.by.get(itemId) ?? null;
    let res;
    if (sources.length) {
      res = { state: 'live', why: [...new Set(sources.map((s) => s.how))].join('; '), sources, dead };
    } else if (dead.length && !unjudged.length && !mentions.length && code.read && !inCode) {
      res = { state: 'unreleased', why: [...new Set(dead)].join('; '), sources, dead };
    } else {
      const m = mentions[0];
      res = {
        state: 'unknown', sources, dead,
        // With the level files unread every other reason is a consequence
        // of that one, and repeats it.
        why: unjudged.length ? `not judged - ${[...new Set(unjudged)].filter((u, i) => i === 0 || prefabs.read || !u.includes(noPrefabs)).join('; ')}`
          : inCode ? `compiled code names it (${inCode.slice(0, 2).join(', ')}), and what that code does with it is not read`
          : !code.read && dead.length ? `the compiled code was not read (${code.why}), so "nothing hands it out" cannot be said`
          : m ? `${m.sheet} ${m.id ?? ''} names it (${m.path}), which is not a source this reader understands`.replace(/\s+/g, ' ')
            : 'no source row names it - handed out by code, or not at all',
      };
    }
    res.unjudged = [...new Set(unjudged)];
    // The lowest level an instance can exist at: defined only when EVERY
    // source states one - and a source this reader could not judge states
    // nothing. An item in a Heroic boss's table and in one only compiled code
    // hands out would otherwise be floored at the cap by the half that was
    // read, and hidden from every character below it. The same goes for an
    // item a function names by literal, and for all of them when the bytecode
    // was not read: a floor is a way of withholding, and nothing is withheld
    // on half a search.
    res.floor = res.state === 'live' && !unjudged.length && code.read && !inCode && sources.every((s) => s.floor != null)
      ? Math.min(...sources.map((s) => s.floor)) : null;
    if (!stack.size) releaseCache.set(itemId, res);
    return res;
  }

  const api = {
    // `read` is "can a gate in them be judged"; `parsed` is whether the files
    // themselves were read - they differ when a release status has no name.
    prefabs: { read: prefabs.read, parsed: prefabsAsRead.read, why: prefabs.why, files: prefabs.files, rows: prefabs.rows.length, paks: prefabs.paks },
    code: { read: code.read, why: code.why, namedBy: (id) => code.by.get(id) ?? [], paks: code.paks },
    release,
    minInstanceLevel: (itemId) => release(itemId).floor,
    heroicOf,
    tableState: (id) => judgeTable(id),
    tableRefs: (id) => tableRefs.get(id) ?? [],
    shopsFor: (itemId) => shops.filter((s) => s.item === itemId),
    checkStatus,
  };
  if (cdb.meta?.cdbSha) graphCache.set(key, api);
  return api;
}
