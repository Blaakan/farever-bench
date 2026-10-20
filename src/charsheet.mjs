// ---------------------------------------------------------------------------
// charsheet.mjs - read a character sheet into a loadout, and write one back.
//
// A CHARACTER SHEET is the build a real character wears, written down by
// whatever could read it: an in-game mod, the bench's own save, the modkit's
// login dump. docs/CHARACTER-SHEET.md is the format for exporter authors;
// this file is the one reader behind `bench import`, `--import` on every
// command and the UI's Import button, so the CLI and the page cannot come to
// disagree about what a file said.
//
// Four shapes are read, told apart by their keys (detectSheetDialect):
//
//   farever-character-sheet  the documented format, version 1
//   bench-envelope           what `optimize --json` and the UI's "Save build"
//                            write: the loadout under `build`, the settings
//                            beside it
//   bench-loadout            a bare loadout, {class, level, gear, ...}
//   modkit-inventory         farever-inventory-<Name>.json, through the same
//                            toLoadout the dump path of `verify` uses
//
// Every one of them is first turned into a version-1 sheet and then read by
// ONE normaliser (`normalise` below), so a check written once holds for all
// four. The bench's own two shapes come out fully explicit - in a loadout an
// absent field already has a meaning (no stars, not Flawless, not infused,
// empty socket), and that meaning is written in rather than read as "not
// recorded".
//
// THE RULE FOR PRESENCE, one for every key at every depth, and the reason
// this reader exists rather than a JSON.parse:
//
//   absent                 not recorded. The choice stays OPEN - unpinned, so
//                          the search may fill it - and it is named as a gap.
//   null / [] / {}         recorded as none. A gear slot that is null is an
//                          empty slot, and it is pinned empty.
//   listed in unreadable   the exporter tried and failed. Read as absent, and
//                          named for what it is.
//
// The failure this guards against has a measured price. An exporter that
// cannot read a piece's infusion and writes null says "not infused"; the
// bench prices that, nobody sees it, and the capture that disagrees reads as
// a model error. inventory.mjs met the same thing with the dump's flags.
//
// WHAT IS REFUSED AND WHAT IS DROPPED. A SheetError is thrown for six things
// only - not JSON, not one of the four shapes (a combat log handed in where a
// build goes is said to be one), a version newer than this reader, a class
// that is not a class, a level that is not a level, a modkit dump written
// before a character loaded (nothing equipped) - because with any of them
// there is no build to talk about. Everything else is kept,
// or dropped with a sentence that says why: one stale id must not cost the
// whole import, and a value removed without a word is how an exporter bug
// hides. The output is a loadout ui/view.mjs sanitizeLoadout leaves exactly
// as it is and illegalReason/infusionIllegalReason pass - a build the UI and
// the CLI accept as is (test/run.mjs holds that for every dialect).
//
// `toSheet` is the other direction, the reference exporter: a loadout as a
// version-1 sheet. readSheet(toSheet(x)) reproduces x. `recordedSheet` is an
// IMPORT written again - toSheet's sheet cut back to what the file recorded -
// and is what `bench import --json` and the submission bundle's sheet.json
// write, so the two cannot come to disagree about what a file left open.
// `pinnedSheet` writes a build somebody STATED (the editor's, the CLI's
// flags) as a sheet of what they stated, and `recordedPieces` says, of an
// import, what its file stated of each piece, for an imported build sent
// from the editor to state no more than the file did.
//
// The class, read once for every caller: `resolveClass` (a class as typed),
// `logClass` (the class a combat log names its character), `dumpClassFromLog`
// (the class such a log gives a modkit dump of the same character) and
// `classVouch` (whether a class given beside a build confirms it against a
// log of another class) - `bench submit`, the UI's Send and `bench verify`
// ask these and keep no rule of their own.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { emptyLoadout, classOf, illegalReason } from './loadout.mjs';
import { toLoadout } from './inventory.mjs';
// Only to recognise a combat log handed in where a build goes, and say so.
import { detectLogDialect } from './combatlog.mjs';

export const SHEET_FORMAT = 'farever-character-sheet';
export const SHEET_VERSION = 1;
/** The four shapes readSheet reads, by the id it reports in `format`. */
export const SHEET_DIALECTS = Object.freeze([SHEET_FORMAT, 'bench-envelope', 'bench-loadout', 'modkit-inventory']);

/**
 * The one error readSheet throws. Its message is a sentence for a person,
 * written to follow a file name ("--import x.json: <message>"), so it opens
 * lower-case. `facts` says the same thing as data, for a caller that words
 * its own sentence or acts on it:
 *
 *   needs: 'class'   the file names no class and none was given (a modkit
 *                    dump); `character` is the name it carries, `classes` the
 *                    unit ids whose aptitude every equipped weapon allows
 *   empty: true      a modkit dump that lists nothing equipped
 *   combatLog        the dialect, when the file is a combat log
 */
export class SheetError extends Error {
  constructor(message, facts = null) {
    super(message);
    this.name = 'SheetError';
    if (facts) Object.assign(this, facts);
  }
}

// The keys a version-1 sheet holds, at each depth. Anything else is NAMED in
// `unknownKeys` - a field an exporter added cannot go unnoticed - except `x`,
// the one place an exporter may carry its own data without a word.
const TOP_KEYS = new Set(['format', 'version', 'source', 'character', 'gear', 'talents', 'weaponSkills',
  'classSkills', 'runes', 'weaponSkillRanks', 'buffs', 'stats', 'unreadable', 'x']);
const CHARACTER_KEYS = new Set(['name', 'class', 'level']);
const SOURCE_KEYS = ['exporter', 'exporterVersion', 'writtenAt', 'gameVersion', 'steamBuild', 'bootSha256'];
const ENTRY_KEYS = new Set(['item', 'level', 'upgrade', 'rarity', 'flawless', 'prismatic', 'infusion',
  'infusionStat', 'infusionBonusStat', 'sockets', 'iLevel', 'x']);
const BUFF_KEYS = new Set(['id', 'item', 'stacks', 'remaining']);
// The blocks `unreadable` may name, and how deep a path into each may go.
const UNREADABLE_BLOCKS = new Set(['talents', 'weaponSkills', 'classSkills', 'runes', 'weaponSkillRanks',
  'buffs', 'stats']);

// WHICH SKILLS CARRY A WEAPON MASTERY RANK. The game ranks four skill types
// and no other: Progress.implSetWeaponSkillRank refuses anything but types
// 4, 7, 8 and 24 of the skill.type enum, which are these four labels (the
// enum is read by name below, never by index). A missing key reads rank 1
// (Progress.getWeaponSkillRank returns 1 for a skill with no entry).
const RANKABLE = new Set(['AttackCombo', 'WeaponSkill', 'WeaponSubSkill', 'WeaponPassive']);

// How each dialect is described to a person, and where its level lives.
const DIALECT = {
  [SHEET_FORMAT]: { label: 'a character sheet (farever-character-sheet)', what: 'the sheet', levelAt: 'character.level' },
  'bench-envelope': { label: 'a build the bench saved (optimize --json, or the UI\'s Save build)', what: 'the saved build', levelAt: 'build.level' },
  'bench-loadout': { label: 'a bare bench loadout', what: 'the loadout', levelAt: 'level' },
  'modkit-inventory': { label: 'a modkit inventory dump (farever-inventory-<Name>.json)', what: 'a modkit inventory dump', levelAt: '--level' },
};

// The envelope's DERIVED parts - what a run computed, not what it was asked.
// Everything else in an envelope is a setting and is handed back in
// `result.envelope`, the way readBuildFile hands it to commonSetup.
const ENVELOPE_RESULTS = new Set(['build', 'metrics', 'sheet', 'unmodelled', 'assumptions', 'infusions']);

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// A map keyed by what a file wrote. A plain object takes `o["__proto__"] = v`
// as a change of its prototype and keeps no key at all, so a talent node or a
// gear key spelled that way would go without being named; this one keeps it
// as a key like any other, to be named or dropped with a reason.
const dict = () => Object.create(null);
const plural = (n, one, many = one + 's') => (n === 1 ? one : many);
const listOf = (xs) => xs.join(', ');

function kindOf(v) {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return `a ${typeof v}`;
}

/**
 * Which of the four shapes an object is, or null. By KEYS, in an order that
 * cannot misfire: a `format` key is only ever ours (or another format's, which
 * is refused rather than guessed at), the bench's envelope is the only one
 * with a `build` object, a bare loadout the only one with a top-level `class`,
 * and the modkit dump the only one with an `equipped` list.
 */
export function detectSheetDialect(obj) {
  if (!isObj(obj)) return null;
  if (has(obj, 'format')) return obj.format === SHEET_FORMAT ? SHEET_FORMAT : null;
  if (isObj(obj.build)) return 'bench-envelope';
  if (typeof obj.class === 'string') return 'bench-loadout';
  if (Array.isArray(obj.equipped)) return 'modkit-inventory';
  return null;
}

function parseInput(input) {
  let obj = input;
  if (input instanceof Uint8Array) {
    // A gzip stream is no sheet - but a gzipped combat log is the one
    // gzip a player is likely to have, and it is said as such.
    if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
      throw new SheetError('not a character sheet: the file is gzip-compressed, and a character sheet is plain JSON - '
        + `a gzipped file is likely a combat log, which ${LOG_GOES}`, { combatLog: 'gzip' });
    }
    input = new TextDecoder('utf-8').decode(input);
  }
  if (typeof input === 'string') {
    try {
      // A file saved by a Windows editor may open with a byte-order mark,
      // which JSON.parse refuses. Escaped, so no tool can strip it unseen.
      obj = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch (e) {
      // A JSON Lines file (a farever-combat-log, a Wink timeline) is not
      // one JSON value, and "not JSON" would send its owner looking for a
      // broken brace: its first line says what it is.
      const log = detectLogDialect(firstLine(input));
      if (log) throw new SheetError(logRefusal(log), { combatLog: log });
      throw new SheetError(`not a character sheet: the file is not JSON (${e.message})`);
    }
  }
  if (!isObj(obj)) {
    throw new SheetError(`not a character sheet: it holds ${kindOf(obj)}, and every sheet the bench reads is a JSON object`);
  }
  return obj;
}

// The first non-blank line of a text, parsed, or null.
function firstLine(text) {
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf('\n', at);
    const line = text.slice(at, end < 0 ? text.length : end).replace(/^\uFEFF/, '').trim();
    if (line) {
      try { return JSON.parse(line); } catch { return null; }
    }
    if (end < 0) break;
    at = end + 1;
  }
  return null;
}

// Where a combat log goes instead, said for both front ends.
const LOG_GOES = 'goes in as the fight, not the build: "Send a fight" in the app, or `bench verify --capture <file>` '
  + 'and `bench submit --log <file>` on the command line';
const LOG_LABELS = {
  'farever-combat-log': 'a farever-combat-log',
  'wink-timeline': 'a Wink DPS Meter fight timeline',
  'wink-summary': 'a Wink DPS Meter fight summary',
  'wink-rift-recap': 'a Wink DPS Meter rift recap',
};
function logRefusal(dialect) {
  return `not a character sheet: this is a combat log (${LOG_LABELS[dialect] ?? dialect}), which ${LOG_GOES}`;
}

const SHAPES = `a farever-character-sheet (a "format" key), a build the bench saved (a "build" object), `
  + 'a bare bench loadout (a "class" key) or a modkit inventory dump (an "equipped" list)';

function refusal(obj) {
  const log = detectLogDialect(obj);
  if (log) return { message: logRefusal(log), facts: { combatLog: log } };
  if (has(obj, 'format')) {
    return { message: `not a character sheet: "format" is ${JSON.stringify(obj.format)}, not "${SHEET_FORMAT}". The bench reads ${SHAPES}` };
  }
  return { message: `not a character sheet: the object is none of the four shapes the bench reads - ${SHAPES}` };
}

// --- facts read once per install ---------------------------------------------
// Which skill hosts each rune, and how many items apply each status. Both are
// whole-sheet scans, so they are kept per cdb.
const perCdb = new WeakMap();
function factsOf(cdb) {
  let f = perCdb.get(cdb);
  if (f) return f;
  // A rune is a `mastery` entry of exactly one skill row (84 of them on build
  // 25959898, none shared), so the host of a bare rune id is read, not guessed.
  const hostOf = new Map();
  for (const row of cdb.lines('skill')) {
    for (const m of row.mastery ?? []) if (m?.id && !hostOf.has(m.id)) hostOf.set(m.id, row.id);
  }
  // A consumable's buff can be a status SHARED by many items - the stat
  // elixirs all apply one - and then only the item says which it was.
  const appliedBy = new Map();
  for (const it of cdb.lines('item')) {
    for (const ef of it.props?.effects ?? []) {
      for (const st of ef?.status ?? []) {
        const id = st?.ref;
        if (id) appliedBy.set(id, (appliedBy.get(id) ?? 0) + 1);
      }
    }
  }
  f = { hostOf, appliedBy };
  perCdb.set(cdb, f);
  return f;
}

/**
 * The bench's own version, from package.json: what `source.exporterVersion`
 * says, and what src/submit.mjs puts in a submission's manifest. Read once.
 */
let benchVersionCache;
export function benchVersion() {
  if (benchVersionCache === undefined) {
    try {
      benchVersionCache = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null;
    } catch {
      benchVersionCache = null;
    }
  }
  return benchVersionCache;
}

/** Slot ids by every spelling a sheet may use: the id, and the id without `Slot_`, in any case. */
function slotResolver(cat) {
  const by = new Map();
  for (const s of cat.slots) {
    by.set(s.id.toLowerCase(), s.id);
    by.set(s.id.replace(/^Slot_/, '').toLowerCase(), s.id);
  }
  return (key) => (typeof key === 'string' ? by.get(key.toLowerCase()) ?? null : null);
}

/**
 * A class as a file or a person writes it - its unit id or its aptitude id,
 * in any case ('Rogue', 'assassin', Wink's 'warrior') - as the catalog's
 * class row {unit, aptitude, ...}, or null. The one reading of a class name
 * for the importer, the submission and the CLI.
 */
export function resolveClass(cat, v) {
  if (typeof v !== 'string') return null;
  const low = v.toLowerCase();
  return cat.classes.find((c) => c.unit.toLowerCase() === low || c.aptitude.toLowerCase() === low) ?? null;
}

/**
 * The class a combat log names its character, as a unit id, or null: what
 * combatlog.mjs readCombatLog read as `stats.className` (a farever-combat-log
 * header's character.class, or a Wink summary's meClass, 'warrior'),
 * resolved by resolveClass. The one reading of it for the submission, `bench
 * verify` and the UI's class question.
 *
 * @param log  readCombatLog's result (capture.mjs readCombatLogAt's too)
 */
export function logClass(cat, log) {
  return resolveClass(cat, log?.stats?.className ?? null)?.unit ?? null;
}

/**
 * The class a combat log gives a modkit dump that names none, as a unit id,
 * or null. A dump records no class (readSheet refuses it without one: the
 * SheetError with needs 'class', its `character` and the `classes` its
 * weapons fit), and a log of the same character names it. Taken only when
 * the log's character IS the dump's (by name, in any case - a dump with no
 * name is taken as the log's) and every weapon the dump lists fits that
 * class: a log of another character, one that names no class, or a class the
 * dump's weapons do not fit says nothing of this dump, and the class is asked
 * for. A Warrior's log beside a dump of daggers was read as a Warrior with
 * both daggers dropped, and that gutted sheet was sent. The one rule for
 * `bench submit` (src/submit.mjs buildSubmission, which the UI's Send calls
 * too) and `bench verify --capture <log> --import <dump>`.
 *
 * @param refusal  readSheet's SheetError (anything else gives null)
 * @param log      readCombatLog's result
 */
export function dumpClassFromLog(cat, refusal, log) {
  if (refusal?.needs !== 'class' || !log) return null;
  const unit = logClass(cat, log);
  if (!unit || !(Array.isArray(refusal.classes) ? refusal.classes : []).includes(unit)) return null;
  const dumpName = typeof refusal.character === 'string' && refusal.character ? refusal.character.toLowerCase() : null;
  const logNames = [log.header?.character?.name, log.summary?.meName, log.handle].filter((n) => typeof n === 'string');
  if (dumpName && !logNames.some((n) => n.toLowerCase() === dumpName)) return null;
  return unit;
}

/**
 * Whether a class given beside a build CONFIRMS the build's class, against a
 * combat log that names its character another one - the pair `bench submit`
 * (src/submit.mjs classMismatch) and `bench verify` refuse unless it does:
 * the build's class and the class given are then two words on it against the
 * log's one, which says the log's header is the one that is wrong.
 *
 *   vouchable  the build is a FILE that names its own class (R.classFrom
 *              'file': a written sheet, a saved build). A modkit dump names
 *              none, a sheet with no class takes the one given, and a build
 *              somebody stated (the editor's, the CLI's flags: `stated`) has
 *              only the class it was stated as - there the class given is the
 *              build's only word on it, and confirms nothing;
 *   vouched    vouchable, and the class given names the same one.
 *
 * @param R       readSheet's result for the build (null: no file - stated)
 * @param given   the class given beside it (--class, the app's class choice)
 * @param stated  the build was stated, not read from a file
 * @returns {{ vouchable: boolean, vouched: boolean }}
 */
export function classVouch(cat, R, given, { stated = false } = {}) {
  const vouchable = !stated && R?.classFrom === 'file' && typeof R.unit === 'string';
  const vouched = vouchable && resolveClass(cat, given)?.unit === R.unit;
  return { vouchable, vouched };
}

// Who can use a piece, by the class a player knows - "a Rogue (aptitude
// Assassin)" - since a drop sentence is read by someone who typed --class
// Rogue, not --class Assassin. An aptitude no class holds is named as is.
function wantsClass(cat, aptitudes) {
  const list = Array.isArray(aptitudes) ? aptitudes : [];
  if (!list.length) return 'no class';
  const who = list.map((a) => {
    const c = cat.classes.find((x) => x.aptitude === a);
    return c ? `a ${c.unit}` : a;
  });
  return `${who.join(' or ')} (aptitude ${list.join(' or ')})`;
}

function unknownClass(cat, v) {
  return new SheetError(`unknown class ${JSON.stringify(v)} - a sheet names the unit id `
    + `(${cat.classes.map((c) => c.unit).join(', ')}) or the aptitude id `
    + `(${cat.classes.map((c) => c.aptitude).join(', ')}), in any case`);
}

/** The DemonSigil-granted talent nodes of a loadout, each with the sigil behind it. */
function sigilNodes(engine, loadout) {
  const tree = engine.talents.treeFor(loadout.class);
  const out = new Map();
  for (const [key, augId] of Object.entries(loadout.augments ?? {})) {
    if (!augId || !key.endsWith('/AugmentDemonSigil')) continue;
    for (const sk of engine.cat.itemById.get(augId)?.skills ?? []) if (tree.byId.has(sk)) out.set(sk, augId);
  }
  return out;
}

/** The skill types classSkills may be keyed by: the class bar and every mechanic type the bench knows. */
function classSkillTypes(engine) {
  return new Set(['ClassSkill', ...Object.keys(engine.plan.mechanicTypes ?? {})]);
}

/** The rankable weapon skills a loadout holds, each with the slot that holds it. */
function heldRankable(engine, loadout) {
  const { cat, plan } = engine;
  const out = [];
  const seen = new Set();
  const push = (skill, slot) => {
    if (seen.has(skill) || !RANKABLE.has(plan.typeOf(skill))) return;
    seen.add(skill);
    out.push({ skill, slot });
  };
  // The offhand grants every skill it carries, the main hand every one but
  // the WeaponSkills its slots leave out (only at level 1, where it holds one
  // of two), and the arsenal weapon only what is slotted.
  const picks = (key) => (Array.isArray(loadout.skills?.[key]) ? loadout.skills[key] : null);
  for (const slot of ['Slot_Weapon1', 'Slot_OffhandWeapon']) {
    const item = isObj(loadout.gear) ? cat.itemById.get(loadout.gear[slot]?.item) : null;
    // (No list, or an empty one, is the bench's own default: the hand's fill.)
    const chosen = slot === 'Slot_Weapon1' && picks('Slot_Weapon1')?.length ? picks('Slot_Weapon1') : null;
    for (const sk of item?.skills ?? []) {
      if (chosen && plan.typeOf(sk) === 'WeaponSkill' && !chosen.includes(sk)) continue;
      push(sk, slot);
    }
  }
  for (const sk of picks('Slot_Weapon2') ?? []) if (typeof sk === 'string') push(sk, 'Slot_Weapon2');
  return out;
}

// =============================================================================
// readSheet
// =============================================================================

/**
 * Read a character sheet, in any of the four shapes, into a loadout the bench
 * accepts as is - plus what was pinned, dropped, left open and observed.
 *
 * @param input   the parsed object, or its JSON text (a Buffer is read as UTF-8)
 * @param cls     a class for a shape that does not name one (the modkit dump);
 *                a sheet that names its own class keeps it
 * @param level   the same, for the character level
 * @param name    the same, for the character name
 * @returns {{format, version, name, unit, aptitude, level, classFrom, rank, loadout,
 *   pins: {gear, augments, skills, runes, talents, infusions}, dropped: {field, id, why}[],
 *   notes: string[], gaps: string[], missing, recordedPicks, unknownKeys: string[], unreadable: string[],
 *   observed: {stats, buffs, weaponSkillRanks, iLevel}, source, buildMismatch: string|null,
 *   x, envelope?}}
 *
 *   `missing` is what `gaps` says, as data: {level (a modkit dump's guessed),
 *   openSlots (a dump's slots left open), slots, rarity, upgrade, flawless,
 *   prismatic, infusion, infusionStat, sockets (slot ids, in slot order),
 *   talents, runes, ranks (booleans), pools (skill pool keys)}. Every gap
 *   sentence is written from it, so comparing two reads compares these, not
 *   their wording. `recordedPicks` is {pool key: [skill ids]}: the picks the
 *   file recorded for a pool, before the bench filled what they left empty.
 *   `classFrom` is 'file' when the file named the class itself, 'option'
 *   when the class came from `cls` alone (a modkit dump always, or a sheet
 *   with no class): only a class the file named can be confirmed by one
 *   given beside it (src/submit.mjs, the class a log contradicts).
 * @throws SheetError for not JSON, no known shape (a combat log among them,
 *   said so), a newer version, an unknown class, a missing or invalid level,
 *   a modkit dump with nothing equipped - and nothing else
 */
export function readSheet(engine, input, { cls = null, level = null, name = null } = {}) {
  const obj = parseInput(input);
  const format = detectSheetDialect(obj);
  if (!format) {
    const why = refusal(obj);
    throw new SheetError(why.message, why.facts);
  }
  if (typeof level === 'string' && /^\d+$/.test(level.trim())) level = Number(level);

  const R = {
    format,
    version: null,
    name: null,
    unit: null,
    aptitude: null,
    level: null,
    // Where the class came from: 'file' when the file named it, 'option'
    // when only the class given beside it did (a modkit dump always).
    classFrom: 'file',
    rank: null,
    loadout: null,
    pins: { gear: [], augments: [], skills: [], runes: [], talents: false, infusions: [] },
    dropped: [],
    notes: [],
    gaps: [],
    missing: {
      level: false, openSlots: [], slots: [], rarity: [], upgrade: [], flawless: [], prismatic: [], infusion: [],
      infusionStat: [], sockets: [], talents: false, runes: false, ranks: false, pools: [],
    },
    recordedPicks: {},
    unknownKeys: [],
    // The paths the exporter listed as unreadable, canonical - each is also
    // a gap; kept apart so `bench import --check` can count them.
    unreadable: [],
    observed: { stats: null, buffs: null, weaponSkillRanks: null, iLevel: {} },
    source: null,
    // The sentence saying the file was written on another game build, or
    // null. It is also among the notes; it is kept apart so the report can
    // print it FIRST - it is the explanation for the drops that follow it.
    buildMismatch: null,
    x: null,
  };
  const C = {
    engine, R, prefix: '', dialect: DIALECT[format],
    slotOf: slotResolver(engine.cat),
    drop(field, id, why) { R.dropped.push({ field: this.prefix + field, id: id ?? null, why }); },
  };

  let sheet;
  if (format === SHEET_FORMAT) {
    const v = obj.version;
    // A version written as text ("2") or with a fraction (1.5) is still a
    // claim to be newer than this reader, and reading it with version-1
    // meanings would be the guess the refusal exists to prevent.
    const asNumber = typeof v === 'number' ? v
      : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(asNumber) && asNumber > SHEET_VERSION) {
      throw new SheetError(`this character sheet is version ${asNumber}, and this bench reads version ${SHEET_VERSION} - `
        + `update the bench, or have the exporter write version ${SHEET_VERSION}`);
    }
    if (!Number.isInteger(v) || v < 1) {
      C.drop('version', v === undefined ? null : JSON.stringify(v),
        `required, the whole number ${SHEET_VERSION} - read as version ${SHEET_VERSION}`);
    }
    R.version = SHEET_VERSION;
    sheet = obj;
  } else if (format === 'bench-envelope') {
    sheet = envelopeToDraft(C, obj);
  } else if (format === 'bench-loadout') {
    sheet = loadoutToDraft(C, obj, '');
  } else {
    sheet = modkitToDraft(C, obj, { cls, level });
  }

  normalise(C, sheet, { cls, level, name });
  // The dump's draft carries the class it was given, as if the file named it.
  if (format === 'modkit-inventory') R.classFrom = 'option';

  if (format === 'bench-envelope') envelopePins(C, obj);
  return R;
}

// --- the bench's own two shapes ----------------------------------------------

/**
 * A bench loadout as an explicit version-1 sheet. Nothing here checks an id -
 * the normaliser does, once, for every dialect - but every field a loadout
 * leaves out is written in with the meaning the LOADOUT gives it, so the
 * normaliser does not read the bench's own defaults as gaps.
 */
function loadoutToDraft(C, l, path) {
  const { engine, R } = C;
  const { cat } = engine;
  C.prefix = path;
  const LOADOUT_KEYS = new Set(['class', 'level', 'gear', 'augments', 'skills', 'runes', 'talents']);
  for (const k of Object.keys(l)) {
    if (LOADOUT_KEYS.has(k)) continue;
    if (k === 'profile' || k === 'profileValues') {
      R.notes.push(`a rotation profile (${path}${k}) is not part of what an import reads - --build keeps it`);
    } else {
      R.unknownKeys.push(path + k);
    }
  }
  const ENTRY = new Set(['item', 'rarity', 'stars', 'level', 'flawless', 'infusion', 'infusionStat',
    'infusionBonusStat', 'prismatic', 'generic']);
  // A block that is there and is not an object would otherwise read as empty.
  for (const k of ['gear', 'augments', 'skills']) {
    if (l[k] != null && !isObj(l[k])) C.drop(k, null, `must be an object, not ${kindOf(l[k])}`);
  }

  // Sockets, by the slot that hosts them. The key's socket type must be the
  // augment's own - evaluate() refuses the other case with the same words.
  const sockets = new Map();
  for (const [key, augId] of Object.entries(isObj(l.augments) ? l.augments : {})) {
    const [slotKey, type, extra] = String(key).split('/');
    const slot = C.slotOf(slotKey);
    if (!slot || !type || extra !== undefined) {
      C.drop('augments', key, 'not a "<slot>/<socket type>" key');
      continue;
    }
    if (augId == null || augId === '') continue;
    const aug = cat.itemById.get(augId);
    if (aug?.augmentType && aug.augmentType !== type) {
      C.drop(`augments.${key}`, augId, `${augId} is a ${aug.augmentType}, not a ${type}`);
      continue;
    }
    if (!sockets.has(slot)) sockets.set(slot, []);
    sockets.get(slot).push(augId);
  }

  // Keyed by what the file wrote, so with no prototype: a key "__proto__"
  // set on a plain object would vanish without a word (see dict).
  const gear = dict();
  const covered = new Set();
  const worn = new Set();
  for (const [key, g] of Object.entries(isObj(l.gear) ? l.gear : {})) {
    const slot = C.slotOf(key);
    if (slot) covered.add(slot);
    if (!isObj(g)) { gear[key] = g ?? null; continue; }
    if (slot) worn.add(slot);
    for (const k of Object.keys(g)) if (!ENTRY.has(k)) R.unknownKeys.push(`${path}gear.${key}.${k}`);
    if (g.generic != null) {
      R.notes.push(`${path}gear.${key}.generic is no longer read - every aptitude a piece names pays`);
    }
    const item = cat.itemById.get(g.item);
    const e = { item: g.item };
    if (has(g, 'level')) e.level = g.level;
    e.upgrade = g.stars ?? 0;
    if (g.rarity != null) e.rarity = g.rarity;
    else if (item && cat.isWeaponType(item.type)) e.rarity = item.rarity;
    e.flawless = g.flawless ?? false;
    e.prismatic = g.prismatic ?? false;
    e.infusion = g.infusion ?? null;
    if (g.infusionStat != null) e.infusionStat = g.infusionStat;
    else if (g.infusionBonusStat != null) e.infusionStat = g.infusionBonusStat;
    e.sockets = sockets.get(slot) ?? [];
    gear[key] = e;
  }
  // A slot a loadout leaves out is empty - unless its gear could not be read
  // at all, and then nothing about the slots is known.
  if (l.gear == null || isObj(l.gear)) for (const s of cat.combatSlots()) if (!covered.has(s.id)) gear[s.id] = null;
  for (const [slot, list] of sockets) {
    if (worn.has(slot)) continue;
    for (const a of list) C.drop('augments', a, `nothing is worn in ${slot} to hold it`);
  }

  // Skill picks, under the sheet's slot keys. The main hand's list goes
  // through as well: below the level at which the hand holds every skill it
  // carries (level 1 on build 25959898) it is a real pick, and above it the
  // normaliser reads it for its order and nothing else - so a loadout comes
  // back as it was, and one that lists fewer skills than the hand holds is
  // named rather than reset in silence.
  const weaponSkills = dict();
  const classSkills = dict();
  for (const [key, ids] of Object.entries(isObj(l.skills) ? l.skills : {})) {
    if (key === 'Slot_Weapon1' || key === 'Slot_Weapon2') weaponSkills[key] = ids;
    else if (key.startsWith('class/')) classSkills[key.slice('class/'.length)] = ids;
    else C.drop('skills', key, 'not a skill pool the bench has (Slot_Weapon2, class/<type>)');
  }

  const draft = {
    character: { class: l.class, level: l.level },
    gear,
    talents: l.talents ?? {},
    classSkills,
    runes: l.runes ?? {},
  };
  if (Object.keys(weaponSkills).length) draft.weaponSkills = weaponSkills;
  return draft;
}

function envelopeToDraft(C, env) {
  const { engine, R } = C;
  const build = env.build;
  const draft = loadoutToDraft(C, build, 'build.');
  // The level is the build's, else the envelope's own copy of it.
  if (draft.character.level == null && env.level != null) draft.character.level = env.level;
  R.source = {
    exporter: 'farever-bench',
    exporterVersion: typeof env.version === 'string' ? env.version : null,
    bootSha256: typeof env.bootSha === 'string' ? env.bootSha : null,
  };
  if (typeof env.cdbSha === 'string' && engine.meta?.cdbSha && env.cdbSha !== engine.meta.cdbSha) {
    R.buildMismatch = `this build was saved on game data ${env.cdbSha.slice(0, 12)} and this install is `
      + `${engine.meta.cdbSha.slice(0, 12)} - an id the patch removed is dropped below`;
    R.notes.push(R.buildMismatch);
  }
  R.envelope = Object.fromEntries(Object.entries(env).filter(([k]) => !ENVELOPE_RESULTS.has(k)));
  // The run's global rank is the envelope's own record of it; a top-level
  // key, so its path carries no `build.`.
  const max = engine.ctx.consts.weaponSkillMaxRank;
  if (env.rank != null) {
    if (Number.isInteger(env.rank) && env.rank >= 1 && env.rank <= max) C.envelopeRank = env.rank;
    else R.dropped.push({ field: 'rank', id: JSON.stringify(env.rank), why: `a weapon-skill rank is a whole number from 1 to ${max}` });
  }
  return draft;
}

/**
 * An envelope says what its run HELD - `pinned` - and everything else was the
 * search's to choose. Re-reading it pins the same things and no more, which is
 * what `--build` does with the same file, so `--import` and `--build` of one
 * envelope describe one run.
 *
 * A pin holds a VALUE, so a pin survives only when the value it held came
 * through normalisation unchanged. Pinning what is left after a drop would
 * turn "hold this sigil" into "hold this socket empty" and "hold these
 * talents" into "hold no talent" - a held none that nobody chose, which is
 * the failure the presence rule exists to stop. So each pin is checked
 * against the saved build's own value: the piece in the slot, the augment in
 * the socket, the infusion on the piece, the picks in the pool, the rune on
 * the skill, and the talents block as a whole.
 */
function envelopePins(C, env) {
  const { engine, R } = C;
  const l = R.loadout;
  const b = env.build;
  const saved = isObj(env.pinned) ? env.pinned : {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const none = (v) => v == null || v === '';
  const same = (a, c) => (none(a) && none(c)) || a === c;
  // The saved build's own entry for a slot, under whichever spelling it used.
  const savedGear = (slot) => {
    if (!isObj(b.gear)) return undefined;
    const hit = Object.entries(b.gear).find(([k]) => C.slotOf(k) === slot);
    return hit ? hit[1] : undefined;
  };
  const combat = new Set(engine.cat.combatSlots().map((s) => s.id));
  const gear = list(saved.gear).filter((s) => {
    if (!combat.has(s)) return false;
    const g = savedGear(s);
    return same(isObj(g) ? g.item : null, l.gear[s]?.item);
  });
  const sockets = new Set(engine.socketsOf(l).map((s) => s.key));
  const savedAug = isObj(b.augments) ? b.augments : {};
  const augments = list(saved.augments).filter((k) => sockets.has(k) && same(savedAug[k], l.augments[k]));
  const infusions = list(saved.infusions).filter((s) => {
    if (!gear.includes(s)) return false;
    const g = savedGear(s);
    return same(isObj(g) ? g.infusion : null, l.gear[s]?.infusion);
  });
  const pools = new Map(engine.plan.pools(l).map((p) => [p.key, p]));
  const savedSkills = isObj(b.skills) ? b.skills : {};
  const skills = list(saved.skills).filter((k) => pools.has(k) && l.skills[k]?.length
    && Array.isArray(savedSkills[k]) && JSON.stringify(savedSkills[k]) === JSON.stringify(l.skills[k]));
  // A saved rune is keyed by its host, or - the dump's old keying - by itself.
  const { hostOf } = factsOf(engine.cdb);
  const savedRune = (host) => {
    if (!isObj(b.runes)) return null;
    if (has(b.runes, host)) return b.runes[host];
    return Object.values(b.runes).find((r) => typeof r === 'string' && hostOf.get(r) === host) ?? null;
  };
  const runeHosts = new Set(engine.talents.runePools(l).map((p) => p.skill));
  const runes = list(saved.runes).filter((h) => runeHosts.has(h) && same(savedRune(h), l.runes[h]));
  // The normaliser held the talents only when the block survived whole.
  const talentsKept = R.pins.talents === true;
  R.pins = {
    gear,
    augments,
    skills,
    runes,
    talents: saved.talents === true && talentsKept,
    infusions,
  };
  R.notes.push('a saved build keeps the pins of the run that wrote it '
    + `(${gear.length} ${plural(gear.length, 'slot')} held); everything else stays open to the search, as it was`);
}

// --- the modkit's dump ----------------------------------------------------------

// The classes (unit ids) a dump's equipped list allows: those whose aptitude
// can use every weapon it lists - a weapon names its class most narrowly -
// or, with no weapon the data knows, every piece. Every class when nothing
// in it is known.
function dumpClasses(cat, equipped) {
  const items = (Array.isArray(equipped) ? equipped : [])
    .map((e) => (isObj(e) && typeof e.kind === 'string' ? cat.itemById.get(e.kind) : null))
    .filter((it) => it && (it.slots ?? []).length);
  const weapons = items.filter((it) => cat.isWeaponType(it.type));
  const held = weapons.length ? weapons : items;
  return cat.classes.filter((c) => held.every((it) => cat.usableBy(it, c.aptitude))).map((c) => c.unit);
}

function modkitToDraft(C, dump, { cls, level }) {
  const { engine, R } = C;
  const { cat } = engine;
  const name = typeof dump.character === 'string' && dump.character ? dump.character : null;
  // A dump that lists nothing worn is not a naked character: the modkit
  // writes one as the game starts, before a character has loaded, and names
  // it after whatever it found then ("0", "3", "unknown"). Read as a build it
  // would be a level-1 character holding all fifteen slots empty - and the
  // search, held to that, returns a build that wears nothing.
  if (!dump.equipped.length) {
    throw new SheetError(`this modkit inventory dump${name ? ` ("${name}")` : ''} lists nothing equipped - it was written before `
      + 'a character loaded, so it describes no build. Log in with the character and let the modkit write its dump again', { empty: true });
  }
  // The dump names the character and nothing about its class: the modkit
  // reads Unit.kind and never writes it out. Its weapons usually settle it,
  // and the classes they allow travel with the question for a caller to
  // offer first.
  if (cls == null || cls === '') {
    const classes = dumpClasses(cat, dump.equipped);
    const fits = classes.length === 1 ? ` - every weapon it lists fits a ${classes[0]}`
      : classes.length > 1 && classes.length < cat.classes.length ? ` - its weapons fit ${classes.map((c) => `a ${c}`).join(' or ')}` : '';
    throw new SheetError(`a modkit inventory dump does not say which class ${name ? `"${name}" ` : 'the character '}is${fits}. `
      + 'Name the class and it is read again: --class on the command line, the class choice in the app', {
      needs: 'class', character: name, classes,
    });
  }
  const clsRow = resolveClass(cat, cls);
  if (!clsRow) throw unknownClass(cat, cls);
  const max = engine.ctx.consts.maxLevel;
  if (level != null && !(Number.isInteger(level) && level >= 1 && level <= max)) {
    throw new SheetError(`the level given for the dump must be a whole number from 1 to ${max}, not ${JSON.stringify(level)}`);
  }

  const DUMP_KEYS = new Set(['character', 'bankSlots', 'bank', 'bankEquipment', 'equipped', 'bags']);
  for (const k of Object.keys(dump)) if (!DUMP_KEYS.has(k)) R.unknownKeys.push(k);
  const ENTRY = new Set(['kind', 'level', 'upgrade', 'rarity', 'count', 'class', 'infusion', 'infusionStat',
    'infusionBonusStat', 'prismatic', 'flawless']);
  const equipped = [];
  dump.equipped.forEach((e, i) => {
    if (!isObj(e) || typeof e.kind !== 'string') {
      C.drop(`equipped[${i}]`, null, 'an entry is an object with a "kind" item id');
      return;
    }
    for (const k of Object.keys(e)) if (!ENTRY.has(k) && e[k] != null) R.unknownKeys.push(`equipped[${i}].${k}`);
    equipped.push(e);
  });

  // The level is not in the dump. The highest equipped item's is the guess the
  // dump path has always made (a character wears its own level's gear), taken
  // here over whole numbers only and held to the game's range.
  let lvl = level;
  if (lvl == null) {
    const levels = equipped.map((e) => e.level).filter((v) => Number.isInteger(v) && v >= 1);
    lvl = Math.min(max, Math.max(1, ...levels));
    // (Said as a gap by the normaliser, with where it came from.)
    R.missing.level = true;
    C.levelFrom = levels.length ? 'from the highest equipped item' : 'since no equipped item gives a level';
  }
  // Placement, class-usability and the rarity index are the dump path's own
  // (inventory.mjs toLoadout); this reads what it returns.
  const built = toLoadout(cat, { inventory: { equipped }, jobs: null, character: name }, { level: lvl, unit: clsRow.unit });

  // toLoadout places items in list order, first free legal slot first, and
  // reports placements in the same order. An entry it skipped never shares its
  // kind with a later placed one (a kind is unknown, unusable or non-combat
  // every time, and an overflow comes after every copy that found a slot), so
  // walking the list against `placed` pairs each slot with its own entry.
  const raw = new Map();
  let k = 0;
  for (const e of equipped) {
    if (k < built.placed.length && e.kind === built.placed[k].item) raw.set(built.placed[k++].slot, e);
  }
  for (const kind of built.unknown) C.drop('equipped', kind, `no item "${kind}" in this install's data`);
  for (const id of built.unusable) {
    const it = cat.itemById.get(id);
    C.drop('equipped', id, `a ${clsRow.unit} cannot use ${id} - it needs ${wantsClass(cat, it?.aptitudes)}`);
  }
  const combat = new Set(cat.combatSlots().map((s) => s.id));
  const nonCombat = [];
  for (const kind of built.ignored) {
    const it = cat.itemById.get(kind);
    if ((it?.slots ?? []).some((s) => combat.has(s))) {
      C.drop('equipped', kind, `every slot ${kind} fits is taken by an earlier entry of the list`);
    } else {
      nonCombat.push(kind);
    }
  }
  if (nonCombat.length) {
    R.notes.push(`${nonCombat.length} non-combat ${plural(nonCombat.length, 'item')} in the dump ignored - `
      + `the bench scores combat gear only: ${listOf(nonCombat)}`);
  }
  for (const line of built.unreadable) {
    if (/: rarity /.test(line)) C.drop('equipped.rarity', line.split(':')[0], line.slice(line.indexOf(':') + 2));
  }

  // The dump lists everything equipped, so a combat slot it leaves out is
  // EMPTY - recorded. A field it does not carry is absent - not recorded - and
  // a flag it wrote as null (unreadable, in the modkit's own words) is too.
  //
  // EXCEPT where an entry this reader could not place may have been worn. An
  // id a patch renamed, or a piece the class given cannot use, still sat in
  // SOME slot, and writing that slot null would turn "could not read it" into
  // "nothing worn" and hold it - the one thing the presence rule forbids. So
  // every free slot such an entry could have filled stays absent: open, and
  // named. A known item names its own slots. An unknown kind has only the
  // modkit's `class` field to go on (the instance's Haxe class, which splits
  // weapons, worn armour and the rest of Gear - jewellery, trinkets, tools);
  // a consumable's class opens nothing, and a missing one opens every slot.
  const slotRows = cat.combatSlots();
  const slotsByClass = {
    'st.item.Weapon': slotRows.filter((s) => s.types.some((t) => cat.isWeaponType(t))),
    'st.item.Armor': slotRows.filter((s) => s.types.some((t) => cat.isArmorType(t))),
    'st.item.Gear': slotRows.filter((s) => !s.types.some((t) => cat.isWeaponType(t) || cat.isArmorType(t))),
    'st.Item': [],
  };
  const couldWear = new Map();          // free slot -> the unread entries that may sit there
  const mayHold = (slots, kind) => {
    for (const s of slots) {
      if (!combat.has(s) || raw.has(s)) continue;
      if (!couldWear.has(s)) couldWear.set(s, []);
      if (!couldWear.get(s).includes(kind)) couldWear.get(s).push(kind);
    }
  };
  for (const e of equipped) {
    if (built.unknown.includes(e.kind)) {
      const cls = typeof e.class === 'string' ? e.class : null;
      mayHold((has(slotsByClass, cls) ? slotsByClass[cls] : slotRows).map((s) => s.id), e.kind);
    } else if (built.unusable.includes(e.kind)) {
      mayHold(cat.itemById.get(e.kind)?.slots ?? [], e.kind);
    }
  }
  if (couldWear.size) {
    const slots = [...combat].filter((s) => couldWear.has(s));
    // (Said as a gap by the normaliser, with the entries behind it.)
    R.missing.openSlots = slots;
    C.openKinds = [...new Set(slots.flatMap((s) => couldWear.get(s)))];
    C.openSlots = new Set(slots);
  }

  const gear = {};
  for (const slot of combat) {
    const g = built.loadout.gear[slot];
    const e = raw.get(slot);
    if (couldWear.has(slot)) continue;
    if (!g || !e) { gear[slot] = null; continue; }
    const d = { item: g.item };
    if (has(e, 'level')) d.level = e.level;
    if (has(e, 'upgrade')) d.upgrade = e.upgrade;
    if (g.rarity) d.rarity = g.rarity;
    for (const f of ['flawless', 'prismatic', 'infusion']) if (has(e, f)) d[f] = e[f];
    // Both names go through, so the normaliser's one rule for the pair (a
    // value beats a null under either name) holds for the dump too.
    if (has(e, 'infusionStat')) d.infusionStat = e.infusionStat;
    if (has(e, 'infusionBonusStat')) d.infusionBonusStat = e.infusionBonusStat;
    gear[slot] = d;
  }
  return { character: { class: clsRow.unit, level: lvl, name }, gear };
}

// =============================================================================
// the normaliser - one path for every dialect
// =============================================================================
//
// One pass, a step to each part of a build and in the order a build is put
// together: the character; the gear and its sockets; the talents (a sigil's
// node costs no point, so the sockets go first); the skill picks (a talent can
// grant a conduit); the bench's own fill of what nobody chose; the runes (a
// rune can ride a pick); the weapon-skill ranks; what was only observed. Last
// come the pins and the gaps, both from what the steps wrote down. The steps
// share one state, N. What a step finds not recorded it notes in R.missing,
// and every gap sentence is written from there at the end, in the order a
// person reads a build - so two reads of one build name the same gaps, in the
// same words, whatever order their files wrote the keys in.

function normalise(C, s, opts) {
  const N = readCharacter(C, s, opts);
  readGear(N);
  readTalents(N);
  readPicks(N);
  // Fill what nobody chose, the way every reader of a loadout does.
  N.plan.pruneSelection(N.loadout);
  readRunes(N);
  readRanks(N);
  readObserved(N);
  settle(N);
}

// --- the character, and the state every step shares ------------------------------
function readCharacter(C, s, opts) {
  const { engine, R } = C;
  const { cat, cdb, plan, talents } = engine;
  const P = C.prefix;
  const drop = (field, id, why) => C.drop(field, id, why);

  // --- unreadable: the exporter's own list of what it tried and could not read
  const U = new Set();
  if (has(s, 'unreadable') && s.unreadable !== null) {
    if (!Array.isArray(s.unreadable)) {
      drop('unreadable', null, 'must be a list of dotted paths, e.g. ["gear.Slot_Neck.infusion", "talents"]');
    } else {
      for (const p of s.unreadable) {
        const canon = typeof p === 'string' ? canonicalPath(C, p) : null;
        if (canon) U.add(canon);
        else drop('unreadable', typeof p === 'string' ? p : JSON.stringify(p), 'names nothing a version-1 sheet holds');
      }
    }
  }
  R.unreadable = [...U];
  const parent = (p) => (p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '');
  const unread = (p) => { for (let q = p; q; q = parent(q)) if (U.has(q)) return true; return false; };
  // A block whose any part could not be read is not a block to price: half a
  // talent tree is not a talent tree.
  const unreadBlock = (p) => unread(p) || [...U].some((u) => u.startsWith(p + '.'));
  const given = (obj, key, path, block = false) => {
    if (!has(obj, key)) return undefined;
    if (block ? unreadBlock(path) : unread(path)) {
      R.notes.push(`the sheet gives ${P}${path} and also lists it as unreadable - read as not recorded`);
      return undefined;
    }
    return obj[key];
  };

  // --- top level and character
  for (const k of Object.keys(s)) if (!TOP_KEYS.has(k)) R.unknownKeys.push(P + k);
  if (has(s, 'character') && !isObj(s.character)) drop('character', null, 'must be an object {class, level, name}');
  const ch = isObj(s.character) ? s.character : {};
  for (const k of Object.keys(ch)) if (!CHARACTER_KEYS.has(k)) R.unknownKeys.push(`${P}character.${k}`);

  let classRaw = ch.class;
  if (classRaw == null || classRaw === '') {
    if (opts.cls == null || opts.cls === '') {
      throw new SheetError(`${C.dialect.what} does not say the character's class - `
        + `${C.dialect.levelAt.replace('level', 'class')} is required: a unit id (${cat.classes.map((c) => c.unit).join(', ')}) `
        + `or an aptitude id (${cat.classes.map((c) => c.aptitude).join(', ')})`);
    }
    classRaw = opts.cls;
    R.classFrom = 'option';
    R.notes.push(`the class is not in ${C.dialect.what} - ${opts.cls} was given for it`);
  } else if (opts.cls != null && opts.cls !== '' && resolveClass(cat, opts.cls)?.unit !== resolveClass(cat, classRaw)?.unit) {
    R.notes.push(`${C.dialect.what} names its own class, ${classRaw} - the class given beside it (${opts.cls}) is not used`);
  }
  const clsRow = resolveClass(cat, classRaw);
  if (!clsRow) throw unknownClass(cat, classRaw);

  const max = engine.ctx.consts.maxLevel;
  let lv = ch.level;
  // Where the level came from decides whose mistake a bad one is: the sheet's
  // own field, or the value given beside it (--level, the UI's level).
  let levelFrom = C.dialect.levelAt;
  if (lv == null) {
    if (opts.level == null) {
      throw new SheetError(`${C.dialect.what} does not say the character's level - ${C.dialect.levelAt} is required, `
        + `a whole number from 1 to ${max}`);
    }
    lv = opts.level;
    levelFrom = null;
    if (Number.isInteger(lv) && lv >= 1 && lv <= max) R.notes.push(`the level is not in ${C.dialect.what} - ${opts.level} was given for it`);
  } else if (opts.level != null && opts.level !== lv && C.dialect !== DIALECT['modkit-inventory']) {
    R.notes.push(`${C.dialect.what} names its own level, ${lv} - the level given beside it (${opts.level}) is not used`);
  }
  if (!Number.isInteger(lv) || lv < 1 || lv > max) {
    throw new SheetError(levelFrom
      ? `${levelFrom} must be a whole number from 1 to ${max}, not ${JSON.stringify(lv)}`
      : `${C.dialect.what} has no level of its own, and the level given for it must be a whole number from 1 to ${max}, `
        + `not ${JSON.stringify(lv)}`);
  }

  let nm = given(ch, 'name', 'character.name');
  if (nm != null && typeof nm !== 'string') {
    drop('character.name', JSON.stringify(nm), 'a name must be a string');
    nm = undefined;
  }
  const nameGiven = typeof opts.name === 'string' && opts.name ? opts.name : null;
  if (nm && nameGiven && nameGiven !== nm) {
    R.notes.push(`${C.dialect.what} names the character ${nm} - the name given beside it (${nameGiven}) is not used`);
  }
  R.name = nm || nameGiven;
  const unit = clsRow.unit;
  R.unit = unit;
  R.aptitude = clsRow.aptitude;
  R.level = lv;
  const loadout = emptyLoadout(cat, unit, lv);
  R.loadout = loadout;

  // --- source: provenance, carried and compared, never priced
  if (has(s, 'source')) {
    if (!isObj(s.source)) {
      drop('source', null, 'must be an object {exporter, exporterVersion, writtenAt, gameVersion, steamBuild, bootSha256}');
    } else {
      const src = {};
      for (const [k, v] of Object.entries(s.source)) {
        if (!SOURCE_KEYS.includes(k)) { R.unknownKeys.push(`${P}source.${k}`); continue; }
        if (v == null) continue;
        const ok = typeof v === 'string' || ((k === 'writtenAt' || k === 'steamBuild') && typeof v === 'number');
        if (ok) src[k] = v;
        else drop(`source.${k}`, JSON.stringify(v), 'must be a string');
      }
      R.source = src;
      const here = engine.meta?.bootSha;
      if (typeof src.bootSha256 === 'string' && here && src.bootSha256.toLowerCase() !== here.toLowerCase()) {
        R.buildMismatch = `the sheet was written on another game build (hlboot.dat ${src.bootSha256.slice(0, 12)}) `
          + `than this install's (${here.slice(0, 12)}) - an id the patch renamed or removed is dropped below, never guessed`;
        R.notes.push(R.buildMismatch);
      }
    }
  }
  if (has(s, 'x')) (R.x ??= { top: null, gear: {} }).top = s.x;

  const combat = cat.combatSlots().map((x) => x.id);
  return {
    C, R, s, engine, cat, cdb, plan, talents, consts: engine.ctx.consts, P, drop,
    U, unread, unreadBlock, given,
    clsRow, unit, lv, loadout,
    combat,
    combatSet: new Set(combat),
    miss: R.missing,
    // slot -> null (recorded empty) | {infRecorded, socketsRecorded, hostTypes}
    recorded: new Map(),
    iLevels: [],
    pinnedPools: new Set(),
    // pool key -> the sentence for its gap, in the order the pools are read
    poolGaps: new Map(),
    talentsRecorded: false,
    runesRecorded: false,
    runePools: new Map(),
    pools: () => new Map(plan.pools(loadout).map((p) => [p.key, p])),
  };
}

// --- gear ----------------------------------------------------------------------
function readGear(N) {
  const { C, R, s, cat, cdb, talents, P, drop, unread, given, clsRow, unit, lv, loadout, combat, combatSet, recorded, miss } = N;
  const ratings = [...new Set((cdb.byId('aptitude').get('InfusionBonus')?.atbScaling ?? []).map((e) => e.endAtb))];
  const aliased = [];
  const nonCombat = [];
  const nullFlags = [];
  const statAliases = [];
  const seen = new Set();
  const gearRaw = given(s, 'gear', 'gear');
  if (!has(s, 'gear') && !unread('gear')) {
    drop('gear', null, 'required - an object keyed by slot id, {} when nothing is recorded');
  } else if (gearRaw !== undefined && !isObj(gearRaw)) {
    drop('gear', null, 'must be an object keyed by slot id');
  }
  for (const [key, val] of Object.entries(isObj(gearRaw) ? gearRaw : {})) {
    const slot = C.slotOf(key);
    if (!slot) { R.unknownKeys.push(`${P}gear.${key}`); continue; }
    if (slot !== key) aliased.push(`${key} as ${slot}`);
    if (!combatSet.has(slot)) { nonCombat.push(slot); continue; }
    if (seen.has(slot)) { drop(`gear.${key}`, val?.item ?? null, `${slot} is given twice - the first is kept`); continue; }
    seen.add(slot);
    const base = `gear.${slot}`;
    if (unread(base) || unread(`${base}.item`)) {
      if (val !== undefined) R.notes.push(`the sheet gives ${P}gear.${key} and also lists it as unreadable - read as not recorded`);
      continue;
    }
    if (val === null) { recorded.set(slot, null); continue; }
    if (!isObj(val) || typeof val.item !== 'string' || !val.item) {
      drop(base, null, 'an entry is an object with an "item" id, or null for an empty slot');
      continue;
    }
    for (const k of Object.keys(val)) if (!ENTRY_KEYS.has(k)) R.unknownKeys.push(`${P}${base}.${k}`);
    if (has(val, 'x')) (R.x ??= { top: null, gear: {} }).gear[slot] = val.x;

    // The piece itself: it exists, it fits, this class can wear it, and the
    // character is old enough to. The same four the pin grammar dies on.
    const item = cat.itemById.get(val.item);
    if (!item) { drop(base, val.item, `no item "${val.item}" in this install's data`); continue; }
    if (!item.slots.includes(slot)) {
      drop(base, item.id, `${item.id} goes in ${item.slots.join(' or ') || 'no combat slot'}, not ${slot}`);
      continue;
    }
    if (!cat.usableBy(item, clsRow.aptitude)) {
      drop(base, item.id, `a ${unit} cannot use ${item.id} - it needs ${wantsClass(cat, item.aptitudes)}`);
      continue;
    }
    if (item.minLevel != null && item.minLevel > lv) {
      drop(base, item.id, `${item.id} needs level ${item.minLevel}, and the character is level ${lv}`);
      continue;
    }
    const g = { item: item.id };
    const isWeapon = cat.isWeaponType(item.type);

    // Rarity. A weapon's is the one it ROLLED; anything else keeps its row's,
    // and a different one names an item that cannot exist.
    let rarity = item.rarity;
    const rv = given(val, 'rarity', `${base}.rarity`);
    if (rv == null) {
      if (isWeapon && !unread(`${base}.rarity`)) miss.rarity.push(slot);
    } else if (typeof rv !== 'string' || !cat.rarityOrder.has(rv)) {
      drop(`${base}.rarity`, JSON.stringify(rv), `not a rarity - one of ${[...cat.rarityOrder.keys()].join(', ')}`);
    } else if (isWeapon) {
      rarity = rv;
    } else if (rv !== item.rarity) {
      drop(`${base}.rarity`, rv, `${item.id} is ${item.rarity}, and only a weapon rolls its rarity - armour, `
        + 'jewellery and trinkets keep their row\'s');
    }
    if (isWeapon) g.rarity = rarity;

    // Upgrade stars, held to what the rarity allows.
    const cap = cat.maxStars(item, rarity);
    const up = given(val, 'upgrade', `${base}.upgrade`);
    let stars = 0;
    if (up === undefined) {
      if (cap > 0 && !unread(`${base}.upgrade`)) miss.upgrade.push(slot);
    } else if (up === null) {
      stars = 0;
    } else if (!Number.isInteger(up) || up < 0) {
      drop(`${base}.upgrade`, JSON.stringify(up), 'not a star count (a whole number, 0 or more) - priced at 0');
    } else if (up > cap) {
      stars = cap;
      R.notes.push(cap
        ? `${slot}: a ${rarity} ${item.id} holds at most ${cap} upgrade ${plural(cap, 'star')}, so ${up} reads as ${cap}`
        : `${slot}: ${item.id} cannot be upgraded, so ${up} upgrade ${plural(up, 'star')} read as 0`);
    } else {
      stars = up;
    }
    g.stars = stars;

    // The instance level. 0 is the game's own "use the row's level" - crafted
    // pieces and jewellery hold it - so it reads as absent, silently.
    const lvRaw = given(val, 'level', `${base}.level`);
    if (lvRaw != null && lvRaw !== 0) {
      if (Number.isInteger(lvRaw) && lvRaw >= 1) {
        g.level = lvRaw;
        if (lvRaw > lv) R.notes.push(`${slot}: ${item.id} is at instance level ${lvRaw}, above the character's ${lv}`);
      } else {
        drop(`${base}.level`, JSON.stringify(lvRaw), 'not a level - a whole number from 1, or 0, null or absent for '
          + 'the row\'s own; read as absent');
      }
    }

    // The two item flags. true or false; null is tolerated as "not recorded".
    const flag = {};
    for (const f of ['flawless', 'prismatic']) {
      const fv = given(val, f, `${base}.${f}`);
      if (fv === undefined) { flag[f] = unread(`${base}.${f}`) ? 'unread' : 'absent'; continue; }
      if (fv === null) { nullFlags.push(`${slot}.${f}`); flag[f] = 'absent'; continue; }
      if (typeof fv !== 'boolean') {
        drop(`${base}.${f}`, JSON.stringify(fv), 'a flag is true or false - read as not recorded');
        flag[f] = 'unread';
        continue;
      }
      flag[f] = 'given';
      if (fv) g[f] = true;
    }
    if (flag.flawless === 'absent') miss.flawless.push(slot);

    // The infusion: an InfusionPassive skill id, or null for none - and only
    // on a piece the game will infuse.
    const infRaw = given(val, 'infusion', `${base}.infusion`);
    let infRecorded = false;
    if (infRaw === undefined) {
      if (cat.canInfuse(item) && !unread(`${base}.infusion`)) miss.infusion.push(slot);
    } else if (infRaw === null || infRaw === '') {
      infRecorded = true;
    } else if (typeof infRaw !== 'string') {
      drop(`${base}.infusion`, JSON.stringify(infRaw), 'an infusion is an InfusionPassive skill id, or null for none');
    } else if (!cat.infusions.has(infRaw)) {
      drop(`${base}.infusion`, infRaw, `no InfusionPattern item names ${infRaw}`);
    } else if (!cat.canInfuse(item)) {
      drop(`${base}.infusion`, infRaw, cat.whyNotInfusable(item));
    } else {
      g.infusion = infRaw;
      infRecorded = true;
    }

    // Its bonus stat: one of the InfusionBonus ratings. A real rating outside
    // the pool this bench computes for the piece is KEPT - a looted piece
    // carries whatever the server rolled.
    // Both names may be given. A value beats a null under either name - as
    // ui/view.mjs sanitizeLoadout and inventory.mjs toLoadout read the pair -
    // since a null beside a rating says nothing the rating does not; two
    // different ratings are a contradiction, and the sheet's own name wins.
    let statKey = 'infusionStat';
    let st = given(val, 'infusionStat', `${base}.infusionStat`);
    const alias = given(val, 'infusionBonusStat', `${base}.infusionStat`);
    const unsaid = (v) => v == null || v === '';
    if (alias !== undefined) {
      if (st === undefined || (unsaid(st) && !unsaid(alias))) {
        st = alias;
        statKey = 'infusionBonusStat';
        statAliases.push(slot);
      } else if (!unsaid(alias) && alias !== st) {
        drop(`${base}.infusionBonusStat`, JSON.stringify(alias), `differs from infusionStat (${st}), which is kept`);
      }
    }
    if (st === undefined) {
      if (g.infusion && !unread(`${base}.infusionStat`)) miss.infusionStat.push(slot);
    } else if (st === null || st === '') {
      // rolled none, or none recorded as such
    } else if (typeof st !== 'string') {
      drop(`${base}.${statKey}`, JSON.stringify(st), 'must be an attribute id');
    } else if (!ratings.includes(st)) {
      drop(`${base}.${statKey}`, st, `not an infusion bonus rating - the bonus line is one of ${listOf(ratings) || 'none on this build'}`);
    } else if (!cat.canInfuse(item)) {
      drop(`${base}.${statKey}`, st, cat.whyNotInfusable(item));
    } else {
      g.infusionStat = st;
      const pool = cat.infusionBonusPool(item);
      if (!pool.includes(st)) {
        R.notes.push(`${slot}: ${st} is outside the bonus pool the bench computes for ${item.id} (${listOf(pool)}) - `
          + 'kept, since a looted piece carries whatever the server rolled');
      }
    }
    if (g.infusion && flag.prismatic === 'absent') miss.prismatic.push(slot);

    // Sockets: augment ids, each placed by its OWN augment type - no item has
    // two sockets of one type, so order and position say nothing.
    const hostTypes = cat.socketsFor(item);
    const sockRaw = given(val, 'sockets', `${base}.sockets`);
    let socketsRecorded = false;
    const placed = [];
    if (sockRaw === undefined) {
      if (hostTypes.length && !unread(`${base}.sockets`)) miss.sockets.push(slot);
    } else if (sockRaw !== null && !Array.isArray(sockRaw)) {
      drop(`${base}.sockets`, null, 'must be a list of augment item ids');
    } else {
      socketsRecorded = true;
      for (const a of sockRaw ?? []) {
        if (a == null || a === '') continue;
        if (typeof a !== 'string') { drop(`${base}.sockets`, JSON.stringify(a), 'must be an augment item id'); continue; }
        const aug = cat.itemById.get(a);
        if (!aug || !aug.isAugment) {
          drop(`${base}.sockets`, a, aug ? `${a} is not an augment` : `no augment "${a}" in this install's data`);
          continue;
        }
        if (!hostTypes.includes(aug.augmentType)) {
          drop(`${base}.sockets`, a, `${a} is a ${aug.augmentType}, and ${item.id} has no such socket `
            + `(${hostTypes.length ? `it has ${listOf(hostTypes)}` : 'it has none'})`);
          continue;
        }
        const prior = placed.find((p) => p.type === aug.augmentType);
        if (prior) { drop(`${base}.sockets`, a, `a second ${aug.augmentType} on ${slot} - ${prior.aug} is kept`); continue; }
        // A sigil grants a talent, and a talent belongs to one class.
        const foreign = (aug.skills ?? []).map((sk) => ({
          skill: sk, owner: cat.classes.find((c) => talents.treeFor(c.unit).byId.has(sk)),
        })).find((x) => x.owner && x.owner.unit !== unit);
        if (foreign) {
          drop(`${base}.sockets`, a, `${a} grants ${foreign.skill}, a ${foreign.owner.unit} talent - a ${unit} cannot use it`);
          continue;
        }
        placed.push({ type: aug.augmentType, aug: a });
      }
    }
    for (const p of placed) loadout.augments[`${slot}/${p.type}`] = p.aug;

    // Observed only: what the game said this piece's item level is.
    const il = given(val, 'iLevel', `${base}.iLevel`);
    if (il != null) {
      if (typeof il === 'number' && Number.isFinite(il)) N.iLevels.push({ slot, game: il });
      else drop(`${base}.iLevel`, JSON.stringify(il), 'an item level is a number');
    }

    loadout.gear[slot] = g;
    recorded.set(slot, { infRecorded, socketsRecorded, hostTypes });
  }
  if (aliased.length) R.notes.push(`gear keys read as slot ids: ${listOf(aliased)}`);
  if (nonCombat.length) {
    R.notes.push(`${nonCombat.length} non-combat ${plural(nonCombat.length, 'slot')} ignored - the bench scores combat `
      + `gear only: ${listOf(nonCombat)}`);
  }
  if (nullFlags.length) {
    R.notes.push(`${listOf(nullFlags)}: a flag is true or false, and null reads as not recorded`);
  }
  if (statAliases.length) R.notes.push(`infusionBonusStat (the game's own name) read as infusionStat on ${listOf(statAliases)}`);
  if (isObj(gearRaw)) {
    // (A slot the dump's unread entry left open is already a gap, with why.)
    for (const slot of combat) {
      if (!seen.has(slot) && !unread(`gear.${slot}`) && !C.openSlots?.has(slot)) miss.slots.push(slot);
    }
  }

  // A shield under a two-hander is a build the game refuses. What the sheet
  // left unsaid about the piece goes with it: it is no longer worn.
  const offBad = illegalReason(cat, loadout);
  if (offBad) {
    const off = loadout.gear.Slot_OffhandWeapon.item;
    delete loadout.gear.Slot_OffhandWeapon;
    for (const k of Object.keys(loadout.augments)) if (k.startsWith('Slot_OffhandWeapon/')) delete loadout.augments[k];
    recorded.delete('Slot_OffhandWeapon');
    for (const f of PIECE_GAPS) miss[f] = miss[f].filter((x) => x !== 'Slot_OffhandWeapon');
    drop('gear.Slot_OffhandWeapon', off, offBad);
  }
}

// What may be left unsaid about one piece, each a list of slots in R.missing.
const PIECE_GAPS = ['rarity', 'upgrade', 'flawless', 'prismatic', 'infusion', 'infusionStat', 'sockets'];

// --- talents: points spent, checked as one allocation ----------------------------
// Sockets are placed first, because a sigil's node costs no point and the tree
// check has to know.
function readTalents(N) {
  const { R, s, engine, talents, drop, unreadBlock, given, unit, lv, loadout, miss } = N;
  const sigils = sigilNodes(engine, loadout);
  const tv = given(s, 'talents', 'talents', true);
  if (tv === undefined) {
    if (!unreadBlock('talents') && lv >= talents.unlockLevel) miss.talents = true;
    return;
  }
  if (tv !== null && !isObj(tv)) {
    drop('talents', null, 'must be an object {talent node id: points spent}');
    return;
  }
  const ranks = dict();
  const zero = [];
  let bad = null;
  for (const [node, v] of Object.entries(tv ?? {})) {
    const r = isObj(v) ? v.rank : v;
    if (r === 0) { zero.push(node); continue; }
    if (!Number.isInteger(r) || r < 0) { bad = `${node} holds ${JSON.stringify(v)} points, not a whole number`; break; }
    ranks[node] = r;
  }
  bad ??= talents.illegalAllocation(unit, ranks, {
    level: lv, points: talents.pointsAt(lv), granted: new Set(sigils.keys()),
  });
  if (bad) {
    drop('talents', null, `${bad} - the talents block is dropped whole, since part of a tree would be priced as if it were all of it`);
    return;
  }
  for (const [node, sigil] of sigils) {
    if (!has(ranks, node)) continue;
    delete ranks[node];
    R.notes.push(`${node} is granted by ${sigil}, costs no point, and is not counted as spent`);
  }
  if (zero.length) R.notes.push(`${listOf(zero)}: 0 points is no point spent`);
  loadout.talents = Object.fromEntries(Object.entries(ranks));
  N.talentsRecorded = true;
}

// --- skill picks. Talents are in, so a conduit a talent grants is an option. ---
function readPicks(N) {
  const { C, R, s, cat, P, drop, unread, unreadBlock, given, unit, lv, loadout, combatSet, pinnedPools, poolGaps, miss, pools } = N;
  const gap = (key, sentence) => { miss.pools.push(key); poolGaps.set(key, sentence); };
  const applyPicks = (pool, list, field) => {
    const kept = [];
    for (const id of list) {
      if (id == null || id === '') continue;           // an empty position on the game's bar
      if (typeof id !== 'string' || !pool.options.includes(id)) {
        drop(field, typeof id === 'string' ? id : JSON.stringify(id),
          `not one of the ${pool.label} a level-${lv} ${unit} has here (${listOf(pool.options)})`);
        continue;
      }
      if (!pool.repeats && kept.includes(id)) { drop(field, id, `already slotted - the ${pool.label} take each option once`); continue; }
      if (kept.length >= pool.slots) {
        drop(field, id, `the bench holds ${pool.slots} ${pool.label} at level ${lv}, and this one is past the last slot`);
        continue;
      }
      kept.push(id);
    }
    loadout.skills[pool.key] = kept;
    R.recordedPicks[pool.key] = [...kept];
    if (kept.length === pool.slots) pinnedPools.add(pool.key);
    else if (!kept.length) {
      R.notes.push(`${P}${field} is recorded empty, and a pool cannot be held empty - the bench's default picks stand, open to the search`);
    }
  };

  // weaponSkills: the arsenal picks, for the weapon worn in Slot_Weapon2 -
  // and, under the slot key alone, the main hand's own.
  //
  // THE MAIN HAND. Its pool is its WeaponSkills against the game's slot
  // constant (UnlockLevel_WeaponSkillSlots: one slot at level 1, two from
  // level 2), so from level 2 it holds every skill it carries and there is
  // nothing to choose; at level 1 it holds one, and which one is a pick.
  // `weaponSkills.Slot_Weapon1` is that pick - the live picks for the slot.
  // Where the hand holds everything, a list naming every one of its skills
  // is read for its order (the bench keeps one; the price does not move) and
  // any other list is named and not read: the game cannot hold the hand at
  // fewer. An entry keyed by the main-hand WEAPON's id is something else -
  // the game's arsenal pick list for that weapon (HeroSpecialization.arsenals
  // keeps one for every weapon ever slotted), dormant while the weapon is in
  // the main hand - and is never read, at any level.
  const worn = (slot) => loadout.gear[slot]?.item ?? null;
  const w1 = worn('Slot_Weapon1');
  const w2 = worn('Slot_Weapon2');
  const off = worn('Slot_OffhandWeapon');
  const mainPool = pools().get('Slot_Weapon1');
  const mainIsChoice = !!mainPool && mainPool.slots < mainPool.options.length;
  const ws = given(s, 'weaponSkills', 'weaponSkills', true);
  const dormant = [];
  const unworn = [];
  const bySlotKey = new Map();          // slot -> {key, list}: the first key that names it
  let byItem = null;
  if (ws !== undefined && ws !== null && !isObj(ws)) {
    drop('weaponSkills', null, 'must be an object {Slot_Weapon2 or a weapon item id: [skill ids]}');
  } else {
    for (const [key, list] of Object.entries(ws ?? {})) {
      const slot = C.slotOf(key);
      if (slot && combatSet.has(slot)) {
        if (slot === 'Slot_OffhandWeapon') { dormant.push(key); continue; }
        if (slot !== 'Slot_Weapon1' && slot !== 'Slot_Weapon2') {
          drop(`weaponSkills.${key}`, null, `${slot} offers no skill choice - only the weapon hands (Slot_Weapon2, and Slot_Weapon1 at level 1) do`);
          continue;
        }
        // Two spellings of one slot (Slot_Weapon2 and Weapon2) are two
        // answers to one question; the first stands, the second is named.
        if (bySlotKey.has(slot)) {
          drop(`weaponSkills.${key}`, null, `${key} gives ${slot} again - ${bySlotKey.get(slot).key} is kept`);
          continue;
        }
        if (list !== null && !Array.isArray(list)) { drop(`weaponSkills.${key}`, null, 'must be a list of skill ids'); continue; }
        bySlotKey.set(slot, { key, list: list ?? [] });
      } else if (cat.itemById.has(key)) {
        // One item id worn in both hands: the entry is the arsenal's, since
        // the main hand's is dormant.
        if (key === w2) {
          if (list !== null && !Array.isArray(list)) { drop(`weaponSkills.${key}`, null, 'must be a list of skill ids'); continue; }
          byItem = { key, list: list ?? [] };
        } else if (key === w1 || key === off) {
          dormant.push(key);
        } else {
          unworn.push(key);
        }
      } else {
        drop(`weaponSkills.${key}`, null, 'names neither a weapon slot nor an item id');
      }
    }
  }
  if (dormant.length) {
    R.notes.push(mainIsChoice
      ? `weaponSkills for ${listOf(dormant)} ignored - an arsenal entry for the main hand or the offhand is dormant; `
        + `at level ${lv} the main hand's ${plural(mainPool.slots, 'skill slot is', 'skill slots are')} read from weaponSkills.Slot_Weapon1`
      : `weaponSkills for ${listOf(dormant)} ignored - the main hand and the offhand grant every skill they `
        + 'carry, so their arsenal entries are dormant');
  }
  // An arsenal entry by slot with nothing worn there joins the unworn ones.
  const bySlot = bySlotKey.get('Slot_Weapon2');
  if (bySlot && !w2) { unworn.push(bySlot.key); bySlotKey.delete('Slot_Weapon2'); }
  if (unworn.length) {
    R.notes.push(`${unworn.length} weaponSkills ${plural(unworn.length, 'entry', 'entries')} for weapons not worn in `
      + `Slot_Weapon2 ignored: ${listOf(unworn)}`);
  }
  const slotEntry = bySlotKey.get('Slot_Weapon2');
  if (slotEntry && byItem) {
    if (JSON.stringify(slotEntry.list) === JSON.stringify(byItem.list)) {
      R.notes.push(`weaponSkills gives Slot_Weapon2 twice, by slot and by ${byItem.key}, with the same picks`);
    } else {
      drop(`weaponSkills.${byItem.key}`, null, `Slot_Weapon2 is also given by slot id, and the slot entry wins`);
    }
  }
  const arsenal = slotEntry ?? byItem;
  // (Every entry left in bySlotKey is the one read for its slot.)
  for (const [slot, e] of bySlotKey) if (e.key !== slot) R.notes.push(`weaponSkills key ${e.key} read as ${slot}`);
  // null or {} is "recorded: no picks" - which a pool cannot be held at.
  const noneGiven = (v) => v === null || (isObj(v) && !Object.keys(v).length);
  const blockReadable = !unreadBlock('weaponSkills') && (ws === undefined || isObj(ws));

  const mainEntry = bySlotKey.get('Slot_Weapon1');
  if (mainEntry) {
    const field = `weaponSkills.${mainEntry.key}`;
    const ids = mainEntry.list.filter((x) => x != null && x !== '');
    if (!mainPool) {
      R.notes.push(`${field} ignored - ${w1 ? `${w1} offers no skill pick` : 'nothing is worn in Slot_Weapon1'}`);
    } else if (mainIsChoice) {
      applyPicks(mainPool, mainEntry.list, field);
    } else if (ids.length === mainPool.options.length && new Set(ids).size === ids.length
      && mainPool.options.every((o) => ids.includes(o))) {
      loadout.skills.Slot_Weapon1 = ids;
      R.recordedPicks.Slot_Weapon1 = [...ids];
    } else {
      R.notes.push(`${field} lists ${listOf(ids.map(String)) || 'nothing'} - at level ${lv} the main hand holds every skill `
        + `${w1} carries (${listOf(mainPool.options)}), so the list is not read`);
    }
  } else if (mainIsChoice && noneGiven(ws)) {
    R.recordedPicks.Slot_Weapon1 = [];
    R.notes.push('weaponSkills records no main-hand pick, and a pool cannot be held empty - the bench\'s default pick stands, open to the search');
  } else if (mainIsChoice && blockReadable) {
    gap('Slot_Weapon1', `the main-hand pick (weaponSkills for Slot_Weapon1) is not recorded - at level ${lv} the main hand holds `
      + `${mainPool.slots} of its ${mainPool.options.length} skills; the bench's default stands, open to the search`);
  }

  const arsenalPool = pools().get('Slot_Weapon2');
  if (arsenal) {
    if (arsenalPool) applyPicks(arsenalPool, arsenal.list, `weaponSkills.${arsenal.key}`);
    else R.notes.push(`weaponSkills.${arsenal.key} ignored - ${w2} offers no arsenal pick at level ${lv}`);
  } else if (arsenalPool && noneGiven(ws)) {
    R.recordedPicks.Slot_Weapon2 = [];
    R.notes.push('weaponSkills records no arsenal picks, and a pool cannot be held empty - the bench\'s default picks stand, open to the search');
  } else if (arsenalPool && blockReadable) {
    // (A block that is not an object was dropped above, and the drop says so.)
    gap('Slot_Weapon2', 'the arsenal picks (weaponSkills for Slot_Weapon2) are not recorded - the bench\'s default picks stand, open to the search');
  }

  // classSkills: keyed by the game's skill type.
  // (`unreadable` reaches no deeper than one bar: canonicalPath folds a path
  // into a bar up to the bar, since one unread position is an unread bar.)
  const cs = given(s, 'classSkills', 'classSkills');
  const classTypes = classSkillTypes(N.engine);
  const classDone = new Set();
  if (cs !== undefined && cs !== null && !isObj(cs)) {
    drop('classSkills', null, 'must be an object {skill type: [skill ids]}');
  } else {
    for (const [type, list] of Object.entries(cs ?? {})) {
      if (!classTypes.has(type)) { R.unknownKeys.push(`${P}classSkills.${type}`); continue; }
      if (unread(`classSkills.${type}`)) {
        R.notes.push(`the sheet gives ${P}classSkills.${type} and also lists it as unreadable - read as not recorded`);
        continue;
      }
      const pool = pools().get(`class/${type}`);
      if (!pool) {
        if (type === 'RoguePoison') R.notes.push('classSkills.RoguePoison is reserved - no class has a poison pool on this build - and is ignored');
        else drop(`classSkills.${type}`, type, `a level-${lv} ${unit} has no ${type} pool`);
        continue;
      }
      classDone.add(pool.key);
      if (list !== null && !Array.isArray(list)) { drop(`classSkills.${type}`, null, 'must be a list of skill ids'); continue; }
      applyPicks(pool, list ?? [], `classSkills.${type}`);
    }
  }
  for (const pool of pools().values()) {
    if (pool.kind === 'weapon' || classDone.has(pool.key)) continue;
    const type = pool.key.slice('class/'.length);
    if (unread('classSkills') || unread(`classSkills.${type}`)) continue;
    if (cs !== undefined && cs !== null && !isObj(cs)) continue;   // dropped above, and said
    if (noneGiven(cs)) {
      R.recordedPicks[pool.key] = [];
      R.notes.push(`classSkills records no ${pool.label}, and a pool cannot be held empty - the bench's default picks stand, open to the search`);
    } else {
      gap(pool.key, `the ${pool.label} (classSkills.${type}) are not recorded - the bench's default picks stand, open to the search`);
    }
  }
}

// --- runes: hosts read from data, checked against the pools of the build as it
// now stands (after the prune, since a rune can ride an arsenal pick).
function readRunes(N) {
  const { R, s, cdb, talents, drop, unreadBlock, given, lv, loadout, miss } = N;
  const runePools = new Map(talents.runePools(loadout).map((p) => [p.skill, p]));
  N.runePools = runePools;
  const { hostOf } = factsOf(cdb);
  const rv = given(s, 'runes', 'runes', true);
  let runeKeyed = 0;
  const placeRune = (key, rune) => {
    const field = key == null ? 'runes' : `runes.${key}`;
    if (rune == null || rune === '') return;            // a host recorded empty; every host is pinned below
    if (typeof rune !== 'string') { drop(field, JSON.stringify(rune), 'must be a rune id'); return; }
    const host = hostOf.get(rune);
    if (!host) { drop(field, rune, `no skill offers a rune "${rune}"`); return; }
    if (key != null && key !== host) {
      if (key === rune) runeKeyed++;
      else R.notes.push(`runes.${key} holds ${rune}, which is a rune of ${host} - read on ${host}`);
    }
    if (!runePools.has(host)) {
      drop(field, rune, `${rune} is a rune of ${host}, which offers no rune slot in this build - not learned by `
        + `level ${lv}, or nothing worn grants it`);
      return;
    }
    if (loadout.runes[host]) { drop(field, rune, `a second rune on ${host} - ${loadout.runes[host]} is kept`); return; }
    loadout.runes[host] = rune;
  };
  if (rv === undefined) {
    if (runePools.size && !unreadBlock('runes')) miss.runes = true;
  } else if (rv === null) {
    N.runesRecorded = true;
  } else if (Array.isArray(rv)) {
    N.runesRecorded = true;
    for (const r of rv) placeRune(null, r);
  } else if (isObj(rv)) {
    N.runesRecorded = true;
    for (const [k, r] of Object.entries(rv)) placeRune(k, r);
  } else {
    drop('runes', null, 'must be a list of rune ids, or an object {host skill id: rune id}');
  }
  if (runeKeyed) R.notes.push(`${runeKeyed} ${plural(runeKeyed, 'rune was', 'runes were')} keyed by the rune's own id - re-keyed by the skill that hosts it`);
}

// --- weapon-skill ranks -> the one global rank the bench prices with. -----------
function readRanks(N) {
  const { C, R, s, engine, cdb, consts, drop, unreadBlock, given, loadout, miss } = N;
  const maxRank = consts.weaponSkillMaxRank;
  if (Number.isInteger(C.envelopeRank)) R.rank = C.envelopeRank;
  const wr = given(s, 'weaponSkillRanks', 'weaponSkillRanks', true);
  if (wr === undefined) {
    if (R.rank == null && !unreadBlock('weaponSkillRanks')) miss.ranks = true;
    return;
  }
  if (wr !== null && !isObj(wr)) {
    drop('weaponSkillRanks', null, 'must be an object {skill id: rank}');
    return;
  }
  const ranks = {};
  const clamped = [];
  for (const [sk, v] of Object.entries(wr ?? {})) {
    const r = isObj(v) ? v.rank : v;
    if (!cdb.has('skill', sk)) { drop(`weaponSkillRanks.${sk}`, sk, 'not a skill id'); continue; }
    if (!Number.isInteger(r) || r < 1) {
      drop(`weaponSkillRanks.${sk}`, JSON.stringify(v), 'a rank is a whole number from 1 - read as missing, which is rank 1');
      continue;
    }
    if (r > maxRank) clamped.push(`${sk} ${r}`);
    ranks[sk] = Math.min(r, maxRank);
  }
  if (clamped.length) R.notes.push(`weapon-skill ranks stop at ${maxRank}: ${listOf(clamped)} read as ${maxRank}`);
  R.observed.weaponSkillRanks = ranks;
  // Only the skills this build HOLDS count - the map spans every weapon the
  // character ever levelled - and a held one with no entry is rank 1.
  const held = heldRankable(engine, loadout).map((h) => ({ ...h, rank: ranks[h.skill] ?? 1 }));
  const unheld = Object.keys(ranks).filter((sk) => !held.some((h) => h.skill === sk));
  if (unheld.length) {
    R.notes.push(`${unheld.length} weapon-skill ${plural(unheld.length, 'rank')} for skills this build does not hold carried and not used`);
  }
  if (!held.length) {
    R.notes.push('weaponSkillRanks is given, and the build holds no weapon skill to rank');
  } else if (new Set(held.map((h) => h.rank)).size === 1) {
    R.rank = held[0].rank;
  } else {
    const main = held.filter((h) => h.slot === 'Slot_Weapon1');
    const mainAgrees = main.length > 0 && new Set(main.map((h) => h.rank)).size === 1;
    R.rank = mainAgrees ? main[0].rank : Math.max(...held.map((h) => h.rank));
    // Both directions are a misprice: a skill below the rank is priced too
    // high, one above it too low. (Only the main hand's rank can leave the
    // second kind; the highest leaves none.)
    const over = held.filter((h) => h.rank < R.rank);
    const under = held.filter((h) => h.rank > R.rank);
    const named = (xs) => xs.map((h) => `${h.skill} (${h.rank})`).join(', ');
    R.notes.push([
      `weapon-skill ranks differ (${held.map((h) => `${h.skill} ${h.rank}`).join(', ')}), and the bench prices `
        + `one rank for every skill: ${R.rank}, ${mainAgrees ? 'the main hand\'s' : 'the highest'}`,
      over.length ? `Priced above their real rank: ${named(over)}` : null,
      under.length ? `Priced below their real rank: ${named(under)}` : null,
    ].filter(Boolean).join('. '));
  }
}

// --- observed only: buffs, the stat sheet and the item levels the game gave ------
function readObserved(N) {
  const { R, s, cat, cdb, P, drop, given, lv, loadout } = N;
  const { appliedBy } = factsOf(cdb);
  const bv = given(s, 'buffs', 'buffs', true);
  if (bv !== undefined) {
    if (bv !== null && !Array.isArray(bv)) {
      drop('buffs', null, 'must be a list of {id, item?, stacks?, remaining?}');
    } else {
      const out = [];
      (bv ?? []).forEach((b, i) => {
        const at = `buffs[${i}]`;
        if (!isObj(b) || typeof b.id !== 'string') { drop(at, null, 'a buff is {id, item?, stacks?, remaining?}'); return; }
        for (const k of Object.keys(b)) if (!BUFF_KEYS.has(k)) R.unknownKeys.push(`${P}${at}.${k}`);
        if (!cdb.has('skill', b.id)) { drop(`${at}.id`, b.id, 'not a status (skill) id'); return; }
        const e = { id: b.id };
        if (b.item != null) {
          if (typeof b.item === 'string' && cdb.has('item', b.item)) e.item = b.item;
          else drop(`${at}.item`, typeof b.item === 'string' ? b.item : JSON.stringify(b.item), 'not an item id');
        }
        for (const k of ['stacks', 'remaining']) {
          if (b[k] == null) continue;
          if (typeof b[k] === 'number' && Number.isFinite(b[k])) e[k] = b[k];
          else drop(`${at}.${k}`, JSON.stringify(b[k]), 'must be a number');
        }
        const shared = appliedBy.get(b.id) ?? 0;
        if (!e.item && shared > 1) {
          R.notes.push(`${at}: ${b.id} is applied by ${shared} different items, and without "item" the one behind it cannot be told`);
        }
        out.push(e);
      });
      R.observed.buffs = out;
    }
  }
  const sv = given(s, 'stats', 'stats', true);
  if (sv !== undefined) {
    if (sv !== null && !isObj(sv)) {
      drop('stats', null, 'must be an object {attribute id: value}');
    } else {
      const out = {};
      for (const [k, v] of Object.entries(sv ?? {})) {
        if (!cdb.has('attribute', k)) { drop(`stats.${k}`, k, 'not an attribute id'); continue; }
        if (typeof v !== 'number' || !Number.isFinite(v)) { drop(`stats.${k}`, JSON.stringify(v), 'must be a number'); continue; }
        out[k] = v;
      }
      R.observed.stats = out;
    }
  }

  // The item levels the game reported, against the bench's own reading of
  // the same instance (Gear.getILevel: base, rarity, stars, Flawless, sockets).
  for (const { slot, game } of N.iLevels) {
    const g = loadout.gear[slot];
    if (!g) continue;
    const item = cat.itemById.get(g.item);
    const socketed = cat.socketsFor(item).map((t) => loadout.augments[`${slot}/${t}`]).filter(Boolean);
    const bench = Math.round(10 * cat.effectiveLevel(item, {
      charLevel: lv, stars: g.stars, flawless: !!g.flawless, rarity: cat.instanceRarity(item, g),
      level: g.level ?? null, socketed,
    }));
    R.observed.iLevel[slot] = { game, bench };
  }
}

// --- pins and gaps: what was recorded is held; what was not stays open ------------
function settle(N) {
  const { C, R, cat, loadout, combat, recorded, pinnedPools, miss, pools } = N;
  const pins = R.pins;
  for (const slot of combat) {
    if (!recorded.has(slot)) continue;
    pins.gear.push(slot);
    const rec = recorded.get(slot);
    if (!rec) continue;
    if (rec.infRecorded) pins.infusions.push(slot);
    if (rec.socketsRecorded) for (const t of rec.hostTypes) pins.augments.push(`${slot}/${t}`);
  }
  const live = pools();
  pins.skills = [...pinnedPools].filter((k) => live.get(k) && loadout.skills[k]?.length === live.get(k).slots);
  pins.runes = N.runesRecorded ? [...N.runePools.keys()] : [];
  pins.talents = N.talentsRecorded;

  // Slots in slot order, whatever order the file wrote its keys in.
  const order = new Map(combat.map((x, i) => [x, i]));
  for (const k of ['openSlots', 'slots', ...PIECE_GAPS]) {
    miss[k] = [...new Set(miss[k])].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  }

  // The sentences, in the order a person reads a build.
  const out = [...N.U].map((p) => `${p} could not be read by the exporter - left open as not recorded`);
  if (miss.level) out.push(`the character level is not in a modkit dump - taken as ${R.level}, ${C.levelFrom ?? 'from the highest equipped item'}`);
  if (miss.openSlots.length) {
    const n = miss.openSlots.length;
    out.push(`${n} gear ${plural(n, 'slot is', 'slots are')} left open rather than held empty (${listOf(miss.openSlots)}) - `
      + `the dump's ${listOf(C.openKinds ?? [])}, dropped above, may have been worn there`);
  }
  if (miss.slots.length) {
    out.push(`${miss.slots.length} gear ${plural(miss.slots.length, 'slot is', 'slots are')} not recorded (${listOf(miss.slots)}) - left open to the search`);
  }
  const rowRarity = (slot) => {
    const id = loadout.gear[slot]?.item;
    const row = id ? cat.itemById.get(id) : null;
    return row ? `${slot} (${row.id}, row ${row.rarity})` : slot;
  };
  if (miss.rarity.length) out.push(`the rolled rarity is not recorded on ${listOf(miss.rarity.map(rowRarity))} - priced as the row's own`);
  if (miss.upgrade.length) out.push(`upgrade stars are not recorded on ${listOf(miss.upgrade)} - priced at 0 stars`);
  if (miss.flawless.length) out.push(`the Flawless flag is not recorded on ${listOf(miss.flawless)} - priced as not Flawless`);
  if (miss.infusion.length) {
    out.push(`whether ${listOf(miss.infusion)} ${plural(miss.infusion.length, 'carries', 'carry')} an infusion is not recorded - left open to the search`);
  }
  if (miss.infusionStat.length) out.push(`the infusion bonus stat is not recorded on ${listOf(miss.infusionStat)} - its bonus line is not priced`);
  if (miss.prismatic.length) {
    out.push(`the Prismatic flag is not recorded on ${listOf(miss.prismatic)}, which ${plural(miss.prismatic.length, 'carries', 'carry')} an infusion - priced as not Prismatic`);
  }
  if (miss.sockets.length) out.push(`sockets are not recorded on ${listOf(miss.sockets)} - left open to the search`);
  if (miss.talents) out.push('talents are not recorded - the search chooses them');
  for (const sentence of N.poolGaps.values()) out.push(sentence);
  if (miss.runes) out.push('runes are not recorded - the search chooses them');
  if (miss.ranks) out.push(`weapon-skill ranks are not recorded - the bench's default rank (${N.consts.weaponSkillMaxRank}) applies`);
  R.gaps = out;
}

/**
 * An `unreadable` path in its canonical spelling, or null when it names
 * nothing a version-1 sheet holds. Slot aliases are resolved, and the game's
 * `infusionBonusStat` is the sheet's `infusionStat`.
 */
function canonicalPath(C, raw) {
  const seg = raw.split('.');
  if (seg.some((x) => !x)) return null;
  const [head, second, third, ...rest] = seg;
  if (head === 'character') return seg.length === 2 && second === 'name' ? raw : null;
  // classSkills is read bar by bar, so a path names the block or one bar of
  // a type that exists. Deeper - one position on the bar - is the bar: the
  // rest of a bar with a hole the exporter could not read is not the bar.
  if (head === 'classSkills') {
    if (second === undefined) return 'classSkills';
    return classSkillTypes(C.engine).has(second) ? `classSkills.${second}` : null;
  }
  if (head === 'gear') {
    if (seg.length === 1) return 'gear';
    const slot = C.slotOf(second);
    if (!slot || !C.engine.cat.slotById.get(slot)?.combat || rest.length) return null;
    if (third === undefined) return `gear.${slot}`;
    if (!ENTRY_KEYS.has(third) || third === 'x') return null;
    return `gear.${slot}.${third === 'infusionBonusStat' ? 'infusionStat' : third}`;
  }
  if (UNREADABLE_BLOCKS.has(head)) return raw;
  return null;
}

// =============================================================================
// toSheet - the reference exporter
// =============================================================================

/**
 * A loadout as a version-1 character sheet: every combat slot (null when
 * empty), the rarity on every weapon, every flag stated, sockets as a list,
 * runes as the game holds them (a list of rune ids), and talents as the
 * points SPENT - a sigil's node is the sigil's, and listing it would read as
 * a point. Nothing is judged here: it writes what the loadout says, and
 * readSheet is where a loadout is judged. A field that is not of its type
 * (an editor's half-made build, a pool that is not a list) is written as
 * not recorded rather than thrown on; the one throw is classOf's, for a
 * class that is none.
 *
 * The main hand's picks are written only where they say something: its one
 * pick at level 1, always, and above it an order other than the default
 * fill's - so a sheet for a build above level 1 normally carries no
 * main-hand entry, which is what a game exporter writes too.
 *
 * @param name    the character's name, when there is one to write
 * @param rank    the global weapon-skill rank, written as that rank on every
 *                rankable skill the build holds; null writes no ranks
 * @param source  {gameVersion?, steamBuild?, writtenAt?} to carry into `source`
 */
export function toSheet(engine, loadout, { name = null, rank = null, source = null } = {}) {
  const { cat, plan } = engine;
  const cls = classOf(cat, loadout);
  const str = (v) => typeof v === 'string' && v !== '';
  const obj = (v) => (isObj(v) ? v : {});
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => x == null || typeof x === 'string') : null);
  const src = { exporter: 'farever-bench' };
  const version = benchVersion();
  if (version) src.exporterVersion = version;
  src.writtenAt = typeof source?.writtenAt === 'string' ? source.writtenAt : new Date().toISOString();
  for (const k of ['gameVersion', 'steamBuild']) if (source?.[k] != null) src[k] = String(source[k]);
  if (engine.meta?.bootSha) src.bootSha256 = engine.meta.bootSha;

  const character = {
    ...(typeof name === 'string' && name ? { name } : {}),
    class: cls.unit,
    level: loadout.level,
  };

  const gear = {};
  const augments = obj(loadout.augments);
  for (const slot of cat.combatSlots()) {
    const g = obj(loadout.gear)[slot.id];
    if (!isObj(g) || !str(g.item)) { gear[slot.id] = null; continue; }
    const item = cat.itemById.get(g.item);
    const e = { item: g.item };
    if (Number.isInteger(g.level) && g.level >= 1) e.level = g.level;
    e.upgrade = Number.isInteger(g.stars) && g.stars > 0 ? g.stars : 0;
    if (item && cat.isWeaponType(item.type)) {
      const rarity = str(g.rarity) ? g.rarity : item.rarity;
      if (str(rarity)) e.rarity = rarity;
    }
    e.flawless = g.flawless === true;
    e.prismatic = g.prismatic === true;
    e.infusion = str(g.infusion) ? g.infusion : null;
    const stat = str(g.infusionStat) ? g.infusionStat : str(g.infusionBonusStat) ? g.infusionBonusStat : null;
    if (stat) e.infusionStat = stat;
    e.sockets = item ? cat.socketsFor(item).map((t) => augments[`${slot.id}/${t}`]).filter(str) : [];
    gear[slot.id] = e;
  }

  const granted = sigilNodes(engine, { ...loadout, augments });
  const talents = Object.fromEntries(Object.entries(obj(loadout.talents))
    .filter(([node, r]) => !granted.has(node) && Number.isInteger(r) && r > 0));

  const sheet = {
    format: SHEET_FORMAT,
    version: SHEET_VERSION,
    source: src,
    character,
    gear,
    talents,
  };
  const skills = obj(loadout.skills);
  const weaponSkills = {};
  // The main hand: only what its default fill would not say (see above).
  const mainPicks = ids(skills.Slot_Weapon1)?.filter(str);
  if (mainPicks?.length) {
    let pool = null;
    try {
      pool = plan.pools({ ...loadout, gear: obj(loadout.gear) }).find((p) => p.key === 'Slot_Weapon1') ?? null;
    } catch {
      pool = null;
    }
    // Below the full hand the pick is always a choice, so it is written even
    // when it is the default; above it, only an order that is not the fill's.
    const choice = pool && pool.slots < pool.options.length;
    const fill = pool ? pool.options.slice(0, pool.slots) : null;
    if (choice || (fill && JSON.stringify(fill) !== JSON.stringify(mainPicks))) weaponSkills.Slot_Weapon1 = mainPicks;
  }
  const arsenal = ids(skills.Slot_Weapon2)?.filter(str);
  if (arsenal?.length) weaponSkills.Slot_Weapon2 = arsenal;
  if (Object.keys(weaponSkills).length) sheet.weaponSkills = weaponSkills;
  const classSkills = {};
  for (const [key, list] of Object.entries(skills)) {
    if (key.startsWith('class/') && ids(list)) classSkills[key.slice('class/'.length)] = ids(list);
  }
  sheet.classSkills = classSkills;
  sheet.runes = Object.values(obj(loadout.runes)).filter(str);
  if (Number.isInteger(rank)) {
    sheet.weaponSkillRanks = Object.fromEntries(heldRankable(engine, loadout).map((h) => [h.skill, rank]));
  }
  return sheet;
}

// =============================================================================
// pinnedSheet - a build somebody STATED, as a sheet of what they stated
// =============================================================================
//
// The editor's build, or the build `bench submit` was typed with, sent as the
// character's own. toSheet writes a loadout, and a loadout has no "not
// stated": every slot left alone is in it empty, every piece at the stars and
// rarity the bench assumes, the tree and the runes empty, every pool at its
// default picks - and sent like that, all of it went as the character's,
// recorded: the maintainer held the model against a character with one weapon
// and nothing else, and blamed the model. The format's one rule for presence
// is that what was not stated is ABSENT, and the reader names each such gap.
// What was stated is what the PINS say - the same pins the UI keeps and the
// CLI's --pin, --skills, --talent and --rune set:
//
//   - a pinned slot, with its piece (an empty one is recorded empty); of the
//     piece, every field - or, when `pieces` is given, only the fields it
//     marks stated ({level, rarity, stars, flawless} per slot: the pin
//     grammar states some and not others);
//   - the piece's infusion when its infusion is pinned, and with it the
//     piece's Prismatic flag. The flag decides whether the infusion is paid,
//     and both ways of TYPING an infusion state it - the CLI's ~infusion with
//     its trailing ! (none typed is "not Prismatic": applyPins writes no
//     flag, and a loadout's absent flag is false), the editor's box beside
//     the infusion (unticked, the same) - so neither caller works it out.
//     A piece a FILE recorded is the one exception, and only through
//     `pieces` (recordedPieces): a file may have recorded the infusion and
//     not the flag, or the flag and not the infusion, and its piece states
//     the flag exactly as the file did. A `pieces` entry that does not name
//     `prismatic` leaves the flag to the infusion's pin, whether `pieces`
//     is given or not;
//   - the infusion's bonus stat with the infusion; a piece a file recorded
//     as rolling none (`pieces` infusionStat true, and no stat in the
//     loadout) states none, as that file did, where a typed infusion with
//     no /stat leaves it open;
//   - its sockets when one of them is pinned. A sheet records a piece's
//     sockets WHOLE, so the others are recorded empty - `emptied.sockets`
//     says which, for the caller to tell the player;
//   - a pool when it is pinned; the talents when they are; the runes when
//     any is, and then every rune slot - `emptied.runes` names the ones no
//     pin set, recorded empty for the same reason.
//
// A pinned socket on a slot with no pinned piece has no piece to sit on in a
// sheet, and is not written (`unplaced`).
//
// @param pins    {gear, augments, skills, runes, infusions: slot or key
//                lists (arrays or Sets), talents: boolean} - readSheet's pins
//                shape, which the UI's App.state.pins is
// @param pieces  null (every field of a pinned piece stated), or a Map or an
//                object {slot: {level, rarity, stars, flawless, prismatic?,
//                infusionStat?}}: booleans, each field stated or not. The
//                CLI's typed pins and the editor's own entries name the first
//                four; recordedPieces - a piece as a file recorded it - all six
// @returns {{ sheet, emptied: {sockets: {slot, types}[], runes: string[]}, unplaced: string[] }}
export function pinnedSheet(engine, loadout, pins = {}, { name = null, rank = null, source = null, pieces = null } = {}) {
  const { cat } = engine;
  const sheet = toSheet(engine, loadout, { name, rank: Number.isInteger(rank) ? rank : null, source });
  const set = (v) => new Set(v instanceof Set ? v : Array.isArray(v) ? v : []);
  const gearPins = set(pins?.gear);
  const augPins = set(pins?.augments);
  const infPins = set(pins?.infusions);
  const skillPins = set(pins?.skills);
  const runePins = set(pins?.runes);
  const stated = (slot) => {
    if (pieces == null) return null;
    const t = pieces instanceof Map ? pieces.get(slot) : isObj(pieces) && has(pieces, slot) ? pieces[slot] : null;
    return isObj(t) ? t : {};
  };
  const emptied = { sockets: [], runes: [] };
  for (const slot of Object.keys(sheet.gear)) {
    if (!gearPins.has(slot)) { delete sheet.gear[slot]; continue; }
    const e = sheet.gear[slot];
    if (!e) continue;
    const t = stated(slot);
    if (t) {
      if (!t.level) delete e.level;
      if (!t.rarity) delete e.rarity;
      if (!t.stars) delete e.upgrade;
      if (!t.flawless) delete e.flawless;
    }
    // The Prismatic flag goes with a pinned infusion - unless `pieces` says
    // what a file recorded of it (see above). With or without `pieces`.
    const prismatic = typeof t?.prismatic === 'boolean' ? t.prismatic : infPins.has(slot);
    if (!prismatic) delete e.prismatic;
    if (!infPins.has(slot)) {
      delete e.infusion;
      delete e.infusionStat;
    } else if (t?.infusionStat === true && typeof e.infusion === 'string' && e.infusion && e.infusionStat === undefined) {
      e.infusionStat = null;
    }
    const item = cat.itemById.get(e.item);
    const host = item ? cat.socketsFor(item) : [];
    const named = host.filter((type) => augPins.has(`${slot}/${type}`));
    if (!named.length) { delete e.sockets; continue; }
    const rest = host.filter((type) => !named.includes(type));
    if (rest.length) emptied.sockets.push({ slot, types: rest });
  }
  const unplaced = [...new Set([...augPins].map((k) => String(k).split('/')[0]))].filter((slot) => !sheet.gear[slot]?.item);
  if (pins?.talents !== true) delete sheet.talents;
  if (!runePins.size) {
    delete sheet.runes;
  } else {
    emptied.runes = engine.talents.runePools(loadout).map((p) => p.skill).filter((host) => !runePins.has(host));
  }
  for (const key of Object.keys(sheet.weaponSkills ?? {})) if (!skillPins.has(key)) delete sheet.weaponSkills[key];
  if (sheet.weaponSkills && !Object.keys(sheet.weaponSkills).length) delete sheet.weaponSkills;
  for (const type of Object.keys(sheet.classSkills ?? {})) if (!skillPins.has(`class/${type}`)) delete sheet.classSkills[type];
  if (sheet.classSkills && !Object.keys(sheet.classSkills).length) delete sheet.classSkills;
  return { sheet, emptied, unplaced };
}

/**
 * Of each piece an import read, the fields the FILE stated - pinnedSheet's
 * `pieces`, as a file recorded them: {slot: {level, rarity, stars, flawless,
 * prismatic, infusionStat}}, each true unless the import named it not
 * recorded (R.missing, the data its gaps are written from). The loadout
 * readSheet returns fills in what a file left open - a weapon's row rarity,
 * 0 stars - and a build put in the editor by Import and sent from there
 * went with those fills as the character's own, where the same file sent as
 * a file left them open: one sheet, two bundles. The UI's /api/import
 * answers with this beside the loadout, and the page sends it back for the
 * pieces the editor still holds as imported, so the editor's build states
 * what the file did. (A piece's level is stated whenever the loadout holds
 * one: a file that left it out leaves none in the loadout either.)
 *
 * @param R  readSheet's result
 */
export function recordedPieces(R) {
  const miss = R?.missing ?? {};
  const not = (f, slot) => (Array.isArray(miss[f]) ? miss[f] : []).includes(slot);
  const out = {};
  for (const [slot, g] of Object.entries(isObj(R?.loadout?.gear) ? R.loadout.gear : {})) {
    if (!isObj(g) || typeof g.item !== 'string' || !g.item) continue;
    out[slot] = {
      level: true,
      rarity: !not('rarity', slot),
      stars: !not('upgrade', slot),
      flawless: !not('flawless', slot),
      prismatic: !not('prismatic', slot),
      infusionStat: !not('infusionStat', slot),
    };
  }
  return out;
}

// =============================================================================
// recordedSheet - an import written again, recording what it recorded
// =============================================================================
//
// What `bench import --json` writes as its `sheet`, and a submission's
// sheet.json (src/submit.mjs): the import written again - never the bytes it
// came as (a modkit dump carries a guild, friends, a bank) - as a sheet like
// any other, which `bench import` and `--import` read back. So it keeps the
// format's one rule for presence: a field ABSENT was not recorded, and is left
// open to the search and named as a gap; a field written - null, [] and {}
// included - was recorded, and is held. toSheet is the reference exporter for
// a LOADOUT, and a loadout has no "not recorded": it writes every combat slot,
// a talents block, a runes list, the default picks of every pool and every
// flag of every piece. Written as it comes, sheet-minimal's one weapon came
// back as fourteen slots held empty, no talent and no rune held, and the
// bench's default skills held as the player's.
//
// So toSheet's output is cut back to what the import recorded:
//
//   - what readSheet's pins say: a slot, a piece's infusion and sockets, the
//     talents and the runes are written only when the import recorded them
//     (a saved envelope aside - see below);
//   - what the exporter listed as unreadable stays listed, and is not written;
//   - what the game showed beside the build, which a loadout has no place for
//     (the per-skill ranks, the buffs, the stat sheet, each piece's item
//     level), travels as the file gave it;
//   - what the import left unsaid is left out: each piece's field it named
//     as not recorded, and each skill pool (R.missing, the data its gaps are
//     written from); a pool the player filled only partly is written as the
//     player filled it (R.recordedPicks), and the bench fills the rest again
//     the same way.
//
// A field whose absence and whose value read the same - no gap and no price
// either way (the Prismatic flag of a piece with no infusion, the stars of a
// piece that cannot be upgraded, the sockets of a piece that has none) - is
// written as toSheet writes it, or left out where it says nothing.
//
// A SAVED ENVELOPE (optimize --json, the UI's Save build) is the bench's own
// fully explicit shape: every field of its build was recorded, and its pins
// are something else - what the run that wrote it HELD, everything else left
// to that run's search. A version-1 sheet has no way to say "recorded, and
// left to the search", so the sheet records the envelope's whole build, and
// its read-back pins are not held to the envelope's.
//
// THE SOURCE names the bench as the writer (exporter, exporterVersion, the
// time it wrote) and carries the game build the sheet is of, which is the
// caller's to say:
//
//   'file'     the build the FILE was written on - its gameVersion, steamBuild
//              and bootSha256 as it gave them, and nothing of this install's:
//              a sheet from another build, read back, must still say so (and
//              still raise readSheet's buildMismatch). `bench import --json`.
//   'install'  this install's: its hlboot.dat (toSheet's own) and the Steam
//              build the caller read (lib/game.mjs steamBuildId - this file
//              reads no install). The submission's sheet.json: the fight was
//              fought, and is priced, on this install, and every id the sheet
//              holds is one this install read.
//
// Then the whole sheet is read back once more: it must give the import's
// build, the import's pins, and leave open everything the import left open -
// compared as R.missing, by meaning: one gap in two wordings is one gap. A
// modkit dump's guessed level cannot come back as a gap (the format requires a
// level, so one is written), and its slots left open come back as slots not
// recorded, which is the same thing; a field the import dropped comes back as
// not recorded, which is what it now is. Anything else is a problem, said in a
// sentence.

// Where each skill pool is written in a sheet.
function poolPath(key) {
  if (key === 'Slot_Weapon1' || key === 'Slot_Weapon2') return ['weaponSkills', key];
  if (key.startsWith('class/')) return ['classSkills', key.slice('class/'.length)];
  return null;
}
// Set (or, with undefined, remove) a pool's picks. A block left with no pool
// goes as a whole: an empty block is "recorded as none", which reads as a note
// that every pool was recorded empty, not as the gaps an absent one gives.
function poolSet(sheet, key, list) {
  const [block, k] = poolPath(key);
  if (list === undefined) {
    if (isObj(sheet[block])) delete sheet[block][k];
    if (isObj(sheet[block]) && !Object.keys(sheet[block]).length) delete sheet[block];
    return;
  }
  if (!isObj(sheet[block])) sheet[block] = {};
  sheet[block][k] = list;
}

// Remove what an `unreadable` path names (readSheet's canonical spelling): a
// sheet that both gives a field and lists it as unreadable is read as not
// recorded, with a note the import did not have. A path into one of the
// blocks read as a whole names the whole block.
const WHOLE_BLOCKS = new Set(['talents', 'weaponSkills', 'runes', 'weaponSkillRanks', 'buffs', 'stats']);
function unsetUnreadable(sheet, path) {
  const [head, second, third] = path.split('.');
  if (WHOLE_BLOCKS.has(head)) { delete sheet[head]; return; }
  if (head === 'character') { if (isObj(sheet.character)) delete sheet.character[second]; return; }
  if (head === 'classSkills') {
    if (second === undefined) delete sheet.classSkills;
    else if (isObj(sheet.classSkills)) delete sheet.classSkills[second];
    return;
  }
  if (head === 'gear') {
    if (second === undefined) { sheet.gear = {}; return; }
    if (!isObj(sheet.gear)) return;
    if (third === undefined) delete sheet.gear[second];
    else if (isObj(sheet.gear[second])) delete sheet.gear[second][third];
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
// One spelling for a value whatever its keys' order, to compare two builds.
const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/**
 * What a read left open, as one set of keys ("slot:Slot_Head",
 * "upgrade:Slot_Weapon1", "pool:class/ClassSkill", "talents",
 * "unreadable:gear.Slot_Neck.infusion"): two reads that left the same things
 * open give the same set, however their sentences are worded or ordered. A
 * modkit dump's slots left open count as slots not recorded - the same
 * question, open - and its guessed level is not in it (a sheet written again
 * names the level it was read at).
 */
export function openKeys(r) {
  const m = r?.missing ?? {};
  const out = new Set();
  for (const s of [...(m.openSlots ?? []), ...(m.slots ?? [])]) out.add(`slot:${s}`);
  for (const f of PIECE_GAPS) for (const s of m[f] ?? []) out.add(`${f}:${s}`);
  for (const f of ['talents', 'runes', 'ranks']) if (m[f]) out.add(f);
  for (const k of m.pools ?? []) out.add(`pool:${k}`);
  for (const p of r?.unreadable ?? []) out.add(`unreadable:${p}`);
  return out;
}

/**
 * An import written again: toSheet's sheet of what readSheet kept, cut back
 * to what the import `R` recorded (see above), with what the game showed
 * beside the build carried. Returns { sheet, problems }: a problem is a
 * sentence, said when the sheet does not read back as the import - none for
 * every documented example. Throws nothing readSheet would: a sheet the
 * reader refuses on reading back is written as toSheet writes the build, and
 * said.
 *
 * @param R             readSheet's result
 * @param name          the character's name to write; null writes none.
 *                      Default: the import's own
 * @param source        'file' (the default) or 'install': whose game build the
 *                      sheet's source names (see above)
 * @param writtenAt     source.writtenAt; default now
 * @param steamBuild    this install's Steam build, for source 'install'
 * @param label         what the sentences call the sheet ("sheet.json")
 *
 * (`levelGuessed`, which callers passed for a modkit dump read with no level,
 * is no longer needed - R.missing.level says it - and is ignored.)
 */
export function recordedSheet(engine, R, {
  name = R.name ?? null, source = 'file', writtenAt = null, steamBuild = null, label = 'the sheet',
} = {}) {
  if (source !== 'file' && source !== 'install') {
    throw new TypeError(`recordedSheet: source is 'file' or 'install', not ${JSON.stringify(source)}`);
  }
  const fromFile = source === 'file';
  const own = isObj(R.source) ? R.source : {};
  const written = toSheet(engine, R.loadout, {
    name,
    rank: R.rank,
    source: fromFile ? { writtenAt, gameVersion: own.gameVersion, steamBuild: own.steamBuild } : { writtenAt, steamBuild },
  });
  // toSheet names this install's hlboot.dat; a file's own sheet names the
  // file's, or none when the file named none.
  if (fromFile) {
    if (typeof own.bootSha256 === 'string' && own.bootSha256) written.source.bootSha256 = own.bootSha256;
    else delete written.source.bootSha256;
  }
  try {
    return cutToRecorded(engine, R, clone(written), { label });
  } catch (e) {
    if (!(e instanceof SheetError)) throw e;
    return { sheet: written, problems: [`${label}, written again from the import, does not read back (${e.message}) - it is written as the reference exporter writes the build`] };
  }
}

// recordedSheet's cut, on toSheet's `sheet` (changed in place and returned).
function cutToRecorded(engine, R, sheet, { label }) {
  const ownShape = R.format === 'bench-envelope';
  const miss = R.missing ?? {};

  // What the game showed and a loadout has no place for travels too: the
  // per-skill ranks as recorded, the buffs, the stat sheet, each piece's item
  // level (below, once the gear is cut). Every one was held to the game's ids
  // by readSheet.
  const obs = R.observed ?? {};
  if (isObj(obs.weaponSkillRanks) && Object.keys(obs.weaponSkillRanks).length) sheet.weaponSkillRanks = { ...obs.weaponSkillRanks };
  if (Array.isArray(obs.buffs)) sheet.buffs = obs.buffs.map((b) => ({ ...b }));
  if (isObj(obs.stats)) sheet.stats = { ...obs.stats };

  // --- what the pins say was recorded
  if (!ownShape) {
    for (const slot of Object.keys(sheet.gear)) {
      if (!R.pins.gear.includes(slot)) { delete sheet.gear[slot]; continue; }
      const e = sheet.gear[slot];
      if (!isObj(e)) continue;
      if (!R.pins.infusions.includes(slot)) { delete e.infusion; delete e.infusionStat; }
      // The sockets stay only where the import held the host's: a piece whose
      // sockets were not recorded leaves them open, and on a piece with none
      // an empty list says nothing either way.
      if (!R.pins.augments.some((k) => k.startsWith(`${slot}/`))) delete e.sockets;
      // Prismatic is a flag of the infusion: on a piece with none, false says
      // nothing either way, and is not written for the import.
      if (e.prismatic === false && !(typeof e.infusion === 'string' && e.infusion)) delete e.prismatic;
    }
    if (!R.pins.talents) delete sheet.talents;
    if (!R.pins.runes.length) delete sheet.runes;
  }
  // --- each piece's fields the import left unsaid
  const gear = isObj(sheet.gear) ? sheet.gear : {};
  for (const f of PIECE_GAPS) {
    for (const slot of miss[f] ?? []) {
      if (!isObj(gear[slot])) continue;
      delete gear[slot][f];
      if (f === 'infusion') delete gear[slot].infusionStat;
    }
  }
  // The infusion's bonus stat the other way round: toSheet writes none when
  // the piece has none, which reads as "not recorded"; where the import read
  // it as recorded (rolled none), it is written null.
  for (const [slot, e] of Object.entries(gear)) {
    if (isObj(e) && typeof e.infusion === 'string' && e.infusion && e.infusionStat === undefined
      && !(miss.infusionStat ?? []).includes(slot)) e.infusionStat = null;
  }
  // --- what the exporter could not read stays unread
  if (Array.isArray(R.unreadable) && R.unreadable.length) {
    for (const p of R.unreadable) unsetUnreadable(sheet, p);
    sheet.unreadable = [...R.unreadable];
  }
  for (const [slot, v] of Object.entries(isObj(obs.iLevel) ? obs.iLevel : {})) {
    if (isObj(sheet.gear?.[slot]) && Number.isFinite(v?.game)) sheet.gear[slot].iLevel = v.game;
  }

  // --- the skill pools: left out where the import left them open, as the
  // player slotted them where they were recorded and not filled, as the build
  // holds them where they were filled - and left out where the import has no
  // picks for them at all (a block it dropped: not recorded is what it now is)
  const recorded = isObj(R.recordedPicks) ? R.recordedPicks : {};
  for (const pool of engine.plan.pools(R.loadout)) {
    if (!poolPath(pool.key)) continue;
    if ((miss.pools ?? []).includes(pool.key) || !has(recorded, pool.key)) { poolSet(sheet, pool.key, undefined); continue; }
    if (R.pins.skills.includes(pool.key)) continue;
    poolSet(sheet, pool.key, [...recorded[pool.key]]);
  }

  // --- the read-back, held to the import
  const cur = readSheet(engine, sheet);
  const again = `${label}, written again from the import,`;
  const problems = [];
  if (canon(cur.loadout) !== canon(R.loadout)) {
    problems.push(`${again} reads back as a slightly different build - whoever reads it gets that build, not the import's`);
  }
  const pinsOf = (r) => canon(Object.fromEntries(Object.entries(r.pins).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v])));
  if (!ownShape && pinsOf(cur) !== pinsOf(R)) {
    problems.push(`${again} holds other choices than the import held - the gaps reported beside it are the import's own`);
  }
  const back = openKeys(cur);
  const lost = [...openKeys(R)].filter((k) => !back.has(k));
  if (lost.length) {
    problems.push(`${again} no longer names ${lost.length} of the import's gaps (${lost.slice(0, 3).join(', ')}) - `
      + 'the gaps reported beside it are the import\'s own');
  } else if (cur.dropped.length) {
    problems.push(`${again} loses ${cur.dropped.length} field(s) when read back: `
      + `${cur.dropped.slice(0, 3).map((d) => d.field).join(', ')}`);
  }
  return { sheet, problems };
}

// =============================================================================
// reportLines - what the CLI and the UI both print
// =============================================================================

/**
 * The import as plain sentences, in the order a person checks one: what the
 * file was, who the character is, what was kept, then everything that was
 * dropped (and why), left open, not understood, or seen to disagree.
 *
 * Each item is {kind, text}, so a reader that colours or tags a line asks its
 * kind rather than matching the sentence's first word: 'read' (what the file
 * is), 'source', 'mismatch' (another game build), 'character', 'kept', 'rank',
 * 'dropped', 'gap', 'unknown' (keys named and not read), 'ilevel' (an item
 * level the game and the bench disagree on), 'ilevels' (they all agree),
 * 'buffs', 'stats', 'note'. reportLines is the same as plain text.
 *
 * A line the reader is warned of carries `warn: true` (REPORT_WARNED: another
 * game build, what was dropped, left open, not understood or read at another
 * item level). The flag is the one table of it: `bench import`, --import,
 * `bench submit` and the UI's Import and Send dialogs all read it, and none
 * keeps a list of kinds of its own.
 */
export function reportItems(r) {
  const items = [];
  let kind = 'read';
  const out = { push: (text) => items.push(REPORT_WARNED.has(kind) ? { kind, text, warn: true } : { kind, text }) };
  const as = (k) => { kind = k; return out; };
  const end = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
  // A sentence opens with a capital - unless it opens with a key or an id
  // (infusionBonusStat, weaponSkills.Slot_Weapon2), which an exporter author
  // reads to find the key in their own file, and which must print as it is.
  const cap = (t) => (/^[a-z][a-z-]*[,:;]?(\s|$)/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  const d = DIALECT[r.format];
  as('read').push(`Read as ${d?.label ?? r.format}${r.format === SHEET_FORMAT ? `, version ${r.version}` : ''}.`);
  const src = r.source;
  if (src?.exporter) {
    as('source').push(`Written by ${src.exporter}${src.exporterVersion ? ` ${src.exporterVersion}` : ''}`
      + `${src.writtenAt != null ? ` at ${src.writtenAt}` : ''}${src.steamBuild != null ? `, game build ${src.steamBuild}` : ''}.`);
  }
  // Another game build first: it is what explains the drops below it.
  if (r.buildMismatch) as('mismatch').push(cap(end(r.buildMismatch)));
  as('character').push(`Character: ${r.name ? `${r.name}, ` : ''}${r.unit} (aptitude ${r.aptitude}), level ${r.level}.`);

  const l = r.loadout;
  const worn = Object.keys(l.gear).length;
  const empty = r.pins.gear.filter((s) => !l.gear[s]).length;
  const socketed = Object.values(l.augments).filter(Boolean).length;
  const points = Object.values(l.talents).reduce((a, b) => a + b, 0);
  const nodes = Object.keys(l.talents).length;
  const runes = Object.values(l.runes).filter(Boolean).length;
  const held = r.pins.skills.length;
  const kept = [
    `${worn} ${plural(worn, 'piece')} worn`,
    empty ? `${empty} ${plural(empty, 'slot')} recorded empty` : null,
    `${socketed} socketed ${plural(socketed, 'augment')}`,
    nodes ? `${points} talent ${plural(points, 'point')} in ${nodes} ${plural(nodes, 'node')}`
      : (r.pins.talents ? 'no talent point spent' : 'talents not recorded'),
    `${runes} ${plural(runes, 'rune')}`,
    `${held} skill ${plural(held, 'pool')} held as recorded`,
  ].filter(Boolean);
  as('kept').push(`Kept: ${kept.join(', ')}.`);
  as('rank').push(r.rank != null ? `Weapon-skill rank: ${r.rank}.` : 'Weapon-skill rank: not recorded.');

  for (const x of r.dropped) as('dropped').push(`Dropped ${x.field}${x.id != null ? ` (${x.id})` : ''}: ${end(x.why)}`);
  for (const gp of r.gaps) as('gap').push(`Gap: ${end(gp)}`);
  if (r.unknownKeys.length) {
    as('unknown').push(`Unknown ${plural(r.unknownKeys.length, 'key')}, named and not read: ${r.unknownKeys.join(', ')}.`);
  }
  const il = Object.entries(r.observed?.iLevel ?? {});
  const off = il.filter(([, v]) => Math.round(v.game) !== v.bench);
  for (const [slot, v] of off) {
    as('ilevel').push(`Item level of ${slot} (${l.gear[slot]?.item}): ${v.game} in game, ${v.bench} as the bench reads the same piece.`);
  }
  if (il.length && !off.length) as('ilevels').push(`Item levels: all ${il.length} the game reported match the bench's.`);
  // What the game showed and v1 carries without pricing: said, so a reader
  // sees it arrived, and short, since nothing is checked against it.
  const buffs = r.observed?.buffs;
  if (Array.isArray(buffs)) {
    const one = (b) => {
      const parts = [];
      if (b.item) parts.push(b.item);
      if (b.stacks != null) parts.push(`${b.stacks} ${plural(b.stacks, 'stack')}`);
      if (b.remaining != null) parts.push(b.remaining < 0 ? 'no end' : `${Math.round(b.remaining)} s left`);
      return `${b.id}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    };
    as('buffs').push(buffs.length
      ? `Observed ${plural(buffs.length, 'buff')}, carried and not priced in v1: ${buffs.map(one).join('; ')}.`
      : 'Observed buffs: none active.');
  }
  const stats = r.observed?.stats;
  if (isObj(stats)) {
    const ks = Object.keys(stats);
    const SHOWN = 6;
    as('stats').push(ks.length
      ? `Observed stats, carried and not compared in v1: ${ks.length} ${plural(ks.length, 'attribute')} - `
        + `${ks.slice(0, SHOWN).map((k) => `${k} ${stats[k]}`).join(', ')}${ks.length > SHOWN ? `, and ${ks.length - SHOWN} more` : ''}.`
      : 'Observed stats: none.');
  }
  for (const n of r.notes) if (n !== r.buildMismatch) as('note').push(`Note: ${cap(end(n))}`);
  return items;
}

// The kinds of reportItems line the reader is warned of (`warn: true`).
const REPORT_WARNED = new Set(['mismatch', 'dropped', 'gap', 'unknown', 'ilevel']);

/** reportItems as plain text: what `bench import`, --import and the UI's Import print. */
export function reportLines(r) {
  return reportItems(r).map((i) => i.text);
}
