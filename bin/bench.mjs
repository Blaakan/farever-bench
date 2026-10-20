#!/usr/bin/env node
// ---------------------------------------------------------------------------
// bench - a gear bench for Farever.
//
//   bench optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1
//   bench optimize https://questlog.gg/farever/en/character-builder/<slug>
//
// Reads the CastleDB out of your own copy of the game, computes what every
// item is worth for your class and level, and fills whatever you did not pin
// with the best legal combination it can find.
//
// Nothing here touches the game process or any file inside the install
// directory. The network is reached in two cases, each one you asked for in
// so many words: you handed it a questlog.gg link, which is fetched,
// translated into pins, and then treated as if you had typed them; or you
// sent a fight to the project yourself (`bench submit --send`, or the UI's
// Send button), which uploads that one bundle to the project's pCloud
// folder, only on that explicit action - or asked for the deletion of one
// you sent (`bench submit --delete <receipt>`, or the UI's Delete), which
// uploads that request to the same folder.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
// A build or a fight written by another program (--import, `bench import`).
import { basename } from 'node:path';
import {
  readSheet, recordedSheet, pinnedSheet, reportItems as sheetReportItems, SheetError, detectSheetDialect, logClass, benchVersion,
  dumpClassFromLog, classVouch,
} from '../src/charsheet.mjs';
import { logReportItems, detectLogDialect, CombatLogError, DIFFICULTIES, MAX_LOG_BYTES } from '../src/combatlog.mjs';
import { combatLogOf, readCombatLogAt, winkCompanion } from '../src/capture.mjs';
// One fight sent to the project (`bench submit`): packed, shown, saved, sent,
// and its deletion asked for, by src/submit.mjs, the module the UI's Send
// dialog calls too.
import {
  buildSubmission, reportItems as submitReportItems, sendRefusal, pendingReceipt, sendSubmission, deleteSubmission,
  receiptText, parseReceipt, uploadLink,
} from '../src/submit.mjs';
import { SubmissionError } from '../src/submission-public.mjs';
import { unlinkSync, chmodSync } from 'node:fs';
// What --zip may write over (a bundle the bench saved).
import { readZipDirectory, zipEntryProblem, MAX_ZIP_BYTES } from '../src/submission-public.mjs';
import { resolve as resolvePath, dirname } from 'node:path';
import { createEngine, GOALS, FERVOR_SCOPES, TICK_SOURCES } from '../src/engine.mjs';
import { emptyLoadout, classOf } from '../src/loadout.mjs';
import { optimize, rankSlot } from '../src/optimize.mjs';
import {
  makePolicy, derivedApl, repairApl, searchApl, vocabularyFor, condLabel,
} from '../src/rotation.mjs';
import { slugOf, endpoints, normalize, translate } from '../src/questlog.mjs';
import {
  aggregate, sessions, snapshots, streamCapture, resolveCapture, captureEra, bootFacts,
  describeMissingCapture, describeOtherCaptures, buildDiff, snapshotAt, mechanicEvidence, poolAt, openingState, stretches, parseExtra,
} from '../src/capture.mjs';
import {
  compare, eraWarning, modelTarget, parseWindows, chooseSnapshot, INTEGER_STREAM, fillFromEvidence, replaySchedule,
} from '../src/verify.mjs';
import { readDump, toLoadout, listCharacters, fromSnapshot } from '../src/inventory.mjs';
import { requireGame, requireBoot } from '../src/lib/game.mjs';
import { readHlb } from '../src/lib/hl.mjs';
import { loadCdb, Cdb } from '../src/cdb.mjs';
import {
  buildFingerprint, diffFingerprints, resolveCitations, workList, loadFingerprint, fingerprintPath,
  clusters, addedItemsByKind, citationRoots, captureChain,
  captureLine, acceptGate, fingerprintGaps, planReanchor, applyReanchor, anonWhy, rowDiff,
  acceptedBuild, acceptedStampPath, loadAcceptedStamp, syncAcceptedStamp,
  acceptedRowsPath, saveAcceptedRows, loadAcceptedRows,
  deferredCitations, rowLines, fingerprintAgainst,
} from '../src/drift.mjs';
import { fileURLToPath } from 'node:url';
import * as f from '../src/format.mjs';
import { FLAGS, REPEATABLE, nearestFlags } from '../src/flags.mjs';

// Out of package.json, not a constant here. tools/release.mjs moves that one
// number and ui/api.mjs reads the same file, so a bump cannot leave the CLI
// printing a version nobody can file a bug against. package.json ships in
// every layout the bench runs from: the repo, the zip, and the exe's
// resources/bench (ui/package.json extraResources). Read by charsheet.mjs
// benchVersion, the one reader a sheet's exporterVersion and a submission's
// manifest are written from too, so the version a bundle names is this one.
export const VERSION = benchVersion();

// --- argument parsing ------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], flags: {}, repeated: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    let key = (eq >= 0 ? a.slice(0, eq) : a).replace(/^--?/, '');
    let val = eq >= 0 ? a.slice(eq + 1) : null;
    // A NAME NOBODY READS IS REFUSED (src/flags.mjs has the table and why): it
    // used to be stored and never looked at, so `--target-lvl 3` was the
    // default run with exit 0. Said with the nearest names there are, or with
    // none when nothing is close.
    if (!Object.hasOwn(FLAGS, key)) {
      const near = nearestFlags(key);
      die(`unknown flag ${a.startsWith('--') ? '--' : '-'}${key}`
        + (near.length ? ` - did you mean ${near.map((n) => `--${n}`).join(' or ')}?` : '')
        + '\nbench --help lists every flag.');
    }
    if (val === null) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { val = next; i++; } else { val = true; }
    }
    if (REPEATABLE.has(key)) (out.repeated[key] ??= []).push(val);
    else out.flags[key] = val;
  }
  return out;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// Forgiving name resolution, because "chest" is what a person types and
// "Slot_Chest" is what the data calls it. Ambiguity is an error with the
// choices listed, never a silent pick.
function resolve(input, ids, what) {
  const lower = String(input).toLowerCase();
  const exact = ids.find((id) => id.toLowerCase() === lower);
  if (exact) return exact;
  const stripped = ids.filter((id) => id.toLowerCase().replace(/^slot_|^augment/, '') === lower);
  if (stripped.length === 1) return stripped[0];
  const partial = ids.filter((id) => id.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    die(`ambiguous ${what} "${input}" - could be: ${partial.slice(0, 12).join(', ')}${partial.length > 12 ? ', ...' : ''}`);
  }
  die(`unknown ${what} "${input}".\nKnown: ${ids.slice(0, 40).join(', ')}${ids.length > 40 ? `, ... (${ids.length} total)` : ''}`);
}

// --- pin syntax ------------------------------------------------------------
//
//   --pin chest=Chest_RManfish_Cle        an item
//   --pin weapon1=Sword_Swarm*3           an item with 3 upgrade stars
//   --pin weapon1=Spear_Eruption@Epic     a weapon at the rarity it rolled
//   --pin chest=Chest_EBee_Fig~Infusion_Bee_DPS/CritChance
//                                         a piece infused with Hive Venom whose
//                                         bonus stat rolled CritChanceRating;
//                                         a trailing ! marks it Prismatic, and
//                                         ~none pins it NOT infused
//   --pin trinket=none                    force the slot empty
//   --pin weapon1/enchantweapon=none      force that socket empty
//   --pin feet/enchantfeet=FormulaFeetCritical_Z2
//   --no-augment weapon1                  every socket on that slot: empty
//
// The best rarity a pinned item can actually reach: capped by the slot ceiling
// and by what the level band can roll, floored at what the row is authored as.
function bestRarityFor(cat, item, slotId, charLevel) {
  // ...and only a WEAPON rolls one at all. Gear keeps the rarity on its row,
  // so a pinned necklace must not be quietly promoted either.
  if (!cat.isWeaponType(item.type)) return item.rarity;
  const options = cat.attainableRarities(item, charLevel, slotId);
  let best = item.rarity;
  for (const o of options) {
    if ((cat.rarityOrder.get(o.rarity) ?? 0) > (cat.rarityOrder.get(best) ?? 0)) best = o.rarity;
  }
  return best;
}

// An infusion as a person types it: the skill id, the id without its
// `Infusion_` prefix, or the name the game shows ("Hive Venom", spaces
// optional). The name comes off the skill row, never off the id.
function resolveInfusion(cat, input) {
  const ids = [...cat.infusions.keys()];
  if (!ids.length) die('this build of the game has no infusions');
  const squash = (x) => String(x).toLowerCase().replace(/[\s_'-]+/g, '');
  const byName = ids.filter((id) => squash(cat.infusions.get(id).name) === squash(input));
  if (byName.length === 1) return byName[0];
  const bySuffix = ids.filter((id) => squash(id.replace(/^Infusion_/, '')) === squash(input));
  if (bySuffix.length === 1) return bySuffix[0];
  // The same forgiving match `resolve` makes on the ids - the whole id in any
  // case, or a part of exactly one - with a refusal of its own: handed to
  // `resolve` as a label, the catalogue was printed twice (every id with its
  // name inside the label, every id again after "Known:") and what had been
  // typed came after the first fifteen. What was typed comes first, and each
  // infusion is listed once, by its id and the name the game shows.
  const lower = String(input).toLowerCase();
  const exact = ids.find((id) => id.toLowerCase() === lower);
  if (exact) return exact;
  const partial = ids.filter((id) => id.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  const listed = (list) => list.map((id) => `${id} "${cat.infusions.get(id).name}"`).join(', ');
  if (partial.length > 1) die(`ambiguous infusion "${input}" - could be: ${listed(partial)}`);
  die(`unknown infusion "${input}".\nKnown: ${listed(ids)}`);
}

// The talent nodes this build's socketed DemonSigils hand over: free, and
// outside the tree's point thresholds (talents.mjs illegalAllocation). Read
// off the augments, which are the durable record - the same read as
// ui/view.mjs grantedNodes, which this file does not import (a copy of the
// bench shipped without ui/ still runs every command but `ui`).
function sigilGranted(engine, loadout) {
  const tree = engine.talents.treeFor(loadout.class);
  const granted = new Set();
  for (const [key, augId] of Object.entries(loadout.augments ?? {})) {
    if (!augId || !key.endsWith('/AugmentDemonSigil')) continue;
    for (const sk of engine.cat.itemById.get(augId)?.skills ?? []) if (tree.byId.has(sk)) granted.add(sk);
  }
  return granted;
}

// The commands whose search chooses a talent tree when none is held (both
// run optimize() with the pins applyPins returns). sheet and rank price the
// loadout's tree as it stands.
const TALENT_SEARCH = new Set(['optimize', 'rotation']);

// --- what a saved or imported build holds: the pins applyPins starts from --
//
// A saved envelope (--build) records what was held fixed. Re-reading it
// re-pins the same things, so `optimize --json x` then `optimize --build x`
// reproduces the run rather than quietly re-opening every slot the user had
// fixed. Any --pin (--skills, --rune) on the command line replaces the saved
// set outright, because merging two pin sets silently is how a user ends up
// unable to unpin.
//
// An IMPORTED build (--import) is the other case, and merges. Its pins are
// not a run's choices to start over from but what a character WEARS - the
// slots, sockets, pools, rune slots and talent tree the file recorded - and a
// typed --pin is "this character, with that changed": it wins for the slot it
// names and leaves every other recorded slot held, the way a typed pin wins
// over a questlog link. A typed pin replaces the PIECE, so what was held of
// the piece it replaced goes with it (`replaced`), and a pool the file
// recorded is held only while it still holds what the file recorded
// (`notePicks` before the pools are pruned, `keeps` after).
//
// Fills the gear, augment and infusion sets it is handed; returns the rest
// of what applyPins asks of the file, in its order.
function mergeImportedPins(engine, saved, args, { pinnedGear, pinnedAug, pinnedInfusion }) {
  const slotIds = engine.cat.combatSlots().map((s) => s.id);
  const savedPins = saved?.envelope?.pinned ?? null;
  const imported = saved?.imported ? savedPins : null;
  const merges = (flag) => !!savedPins && (!!imported || !(args.repeated[flag] ?? []).length);
  if (merges('pin')) {
    for (const slot of savedPins.gear ?? []) if (slotIds.includes(slot)) pinnedGear.add(slot);
    for (const key of savedPins.augments ?? []) pinnedAug.add(key);
    for (const slot of savedPins.infusions ?? []) if (slotIds.includes(slot)) pinnedInfusion.add(slot);
  }
  let picks = null;
  return {
    skills: merges('skills') ? (savedPins.skills ?? []) : [],
    talents: savedPins?.talents === true,
    // An imported piece a typed pin replaced: its infusion and its sockets
    // were that piece's, and are no longer held.
    replaced(loadout, slot, nextItem, infusionTyped) {
      if (!imported || !(imported.gear ?? []).includes(slot)) return;
      if (!infusionTyped && (imported.infusions ?? []).includes(slot)) pinnedInfusion.delete(slot);
      if (nextItem != null && nextItem === saved.loadout.gear?.[slot]?.item) return;
      for (const key of imported.augments ?? []) {
        if (!key.startsWith(`${slot}/`)) continue;
        pinnedAug.delete(key);
        delete loadout.augments[key];
      }
    },
    // The tree the file recorded, held as it was - asked again here, because
    // a typed --level or a --pin that took a sigil away can make a tree that
    // was legal in the file one this build cannot hold. Then it is not held,
    // and the sentence says what becomes of it: a command that searches the
    // tree chooses another; one that searches nothing (sheet, rank) prices
    // the tree as the file recorded it, and must not say it was set aside
    // while the page still prices it.
    holdsTree(loadout) {
      const bad = engine.talents.illegalAllocation(loadout.class, loadout.talents ?? {}, {
        level: loadout.level,
        points: engine.talents.pointsAt(loadout.level, null),
        granted: sigilGranted(engine, loadout),
      });
      if (!bad) return true;
      console.error(f.warn(TALENT_SEARCH.has(args._[0])
        ? `note: the talents ${saved.path} recorded are not held - this build cannot hold them as they are (${bad}); the search chooses the tree`
        : `note: the talents ${saved.path} recorded are priced as recorded, although this build cannot hold them as they are: ${bad}`));
      return false;
    },
    // What an imported pool held before the pools are pruned to this build:
    // a typed --pin that changed the weapon changes its pool, and a pick the
    // prune refilled is not the one the file recorded.
    notePicks(loadout) {
      if (imported) picks = new Map((savedPins.skills ?? []).map((key) => [key, JSON.stringify(loadout.skills[key] ?? null)]));
    },
    keeps(loadout, key, typed) {
      return !picks || typed.has(key) || JSON.stringify(loadout.skills[key]) === picks.get(key);
    },
    // The rune slots the file recorded - a rune, or held empty - on the
    // skills this build still holds. A typed --rune replaces the saved set
    // (--build) or wins for its own skill (--import).
    runeHosts(loadout) {
      if (!savedPins?.runes?.length || !merges('rune')) return [];
      const hosts = new Set(engine.talents.runePools(loadout).map((p) => p.skill));
      return savedPins.runes.filter((host) => hosts.has(host));
    },
  };
}
// --- end of what a saved or imported build holds ------------------------------

function applyPins(engine, loadout, args, { stars, rarityRoll, saved = null }) {
  const { cat } = engine;
  const slotIds = cat.combatSlots().map((s) => s.id);
  const augTypeIds = cat.augmentTypes.map((a) => a.id);
  const pinnedGear = new Set();
  const pinnedAug = new Set();
  // Slots whose infusion the user stated - `~something` or `~none`. A pin
  // without a `~` part fixes the item and leaves its infusion to the search.
  const pinnedInfusion = new Set();
  // What each typed --pin stated of its piece beyond the item: the parts of
  // the grammar below that were written, so `bench submit` sends what was
  // typed and not the defaults the bench prices an unstated part at.
  const typedPieces = new Map();
  const augPins = [];

  // What a saved envelope (--build) or an imported sheet (--import) holds:
  // replaced by what is typed, or merged with it (mergeImportedPins).
  const held = mergeImportedPins(engine, saved, args, { pinnedGear, pinnedAug, pinnedInfusion });
  const savedSkillPins = held.skills;

  for (const spec of args.repeated.pin ?? []) {
    if (spec === true) die('--pin needs a value, e.g. --pin chest=Chest_RManfish_Cle');
    const eq = String(spec).indexOf('=');
    if (eq < 0) die(`--pin "${spec}" needs the form slot=item (or slot/socket=augment)`);
    const lhs = spec.slice(0, eq);
    const rhs = spec.slice(eq + 1);

    if (lhs.includes('/')) {
      const [slotRaw, sockRaw] = lhs.split('/');
      const slot = resolve(slotRaw, slotIds, 'slot');
      const type = resolve(sockRaw, augTypeIds, 'augment socket');
      augPins.push({ key: `${slot}/${type}`, value: /^(none|empty|-)$/i.test(rhs) ? null : rhs });
      continue;
    }

    const slot = resolve(lhs, slotIds, 'slot');
    pinnedGear.add(slot);
    if (/^(none|empty|-)$/i.test(rhs)) { delete loadout.gear[slot]; typedPieces.delete(slot); held.replaced(loadout, slot, null, false); continue; }

    // item [ ^instanceLevel ] [ @rarity ] [ *stars ] [ +generic ] [ ~infusion[/stat][!] ]
    // The infusion part is split off first: the item group below takes
    // everything up to the next separator, and `~` is not one of its.
    const tilde = rhs.indexOf('~');
    const itemPart = tilde < 0 ? rhs : rhs.slice(0, tilde);
    const infPart = tilde < 0 ? null : rhs.slice(tilde + 1);
    const m = /^([^@*^+]+)(?:\^(\d+))?(?:@([^*^+]+))?(?:\*(\d+))?(?:\+([A-Za-z]+))?$/.exec(itemPart);
    if (!m) die(`--pin "${spec}": cannot read the item part "${itemPart}"`);
    const itemId = resolve(m[1], cat.items.filter((i) => i.slots.includes(slot)).map((i) => i.id), `item for ${f.short(slot)}`);
    const item = cat.itemById.get(itemId);
    const cls = classOf(cat, loadout);
    if (!cat.usableBy(item, cls.aptitude)) {
      die(`${cls.unit} cannot use ${itemId} - it needs aptitude ${item.aptitudes.join(' or ')}`);
    }
    // `minLevel` is the row's level or, for a head or shoulder piece that
    // authors none, its type's defaultMinLevel - see catalog.mjs.
    if (item.minLevel != null && item.minLevel > loadout.level) {
      die(`${itemId} needs level ${item.minLevel}, the build is level ${loadout.level}`);
    }
    // A pin always may; it is told what it is pinning.
    const rel = cat.release(item);
    if (rel.state === 'unreleased') {
      console.error(f.warn(`note: nothing in this install hands out ${item.name} (${itemId}): ${rel.why}`));
    }
    const floor = cat.minInstanceLevel(item);
    if (floor != null && floor > loadout.level && m[2] == null) {
      console.error(f.warn(`note: ${item.name} (${itemId}) only exists at level ${floor} - every source of it makes it `
        + `there - so it is priced at ${floor}, above the build's ${loadout.level}`));
    }

    // The instance level - what your copy actually dropped at. The authored
    // level is only a reference, so this is what you need to reproduce a real
    // character sheet.
    const instanceLevel = m[2] != null ? Number(m[2]) : null;
    if (instanceLevel != null && instanceLevel > loadout.level) {
      console.error(f.warn(`note: ${itemId} pinned at instance level ${instanceLevel}, above the build's ${loadout.level}`));
    }

    // With no @rarity given, take the best the slot can reach - the same
    // "assume the good version" default that `--stars max` already applies.
    // Pinning an item should not quietly hand you the weakest roll of it.
    const rarity = m[3]
      ? resolve(m[3], cat.cdb.lines('rarity').map((r) => r.id), 'rarity')
      : (rarityRoll ? bestRarityFor(cat, item, slot, loadout.level) : item.rarity);
    // ONLY A WEAPON HAS A RARITY OF ITS OWN (ent.Hero.makeLootItem@7953 ops
    // 126-129; `rarity` is a field of st.item.Weapon and of nothing else). An
    // Epic chest is a different ROW, so `chest=<a Rare row>@Epic` names an item
    // that cannot exist - say which row the Epic one is.
    if (m[3] && !cat.isWeaponType(item.type) && rarity !== item.rarity) {
      const twin = cat.items.find((x) => x.type === item.type && x.rarity === rarity && !x.isAugment
        && cat.factionOrigin(x) === cat.factionOrigin(item)
        && x.aptitudes.length === item.aptitudes.length && x.aptitudes.every((a) => item.aptitudes.includes(a)));
      die(`--pin "${spec}": ${item.name} (${itemId}) is ${item.rarity}, and only a weapon rolls its rarity - `
        + `armour and jewellery keep their row's. `
        + (twin ? `The ${rarity} row of this piece is ${twin.id} (${twin.name}).`
          : `No ${rarity} row of this piece exists.`));
    }

    const cap = cat.maxStars(item, rarity);
    const want = m[4] != null ? Number(m[4]) : (stars === 'max' ? cap : Math.min(stars, cap));
    const capped = Math.min(want, cap);
    if (m[4] != null && capped < want) {
      console.error(f.warn(`note: ${itemId} is ${rarity} and caps at ${capped} upgrade stars, not ${want}`));
    }
    // Craft jewellery names several generic aptitudes and pays exactly one, so
    // a pinned one has to say which. Left unnamed it takes the first, and the
    // gear table prints it in the FACTION column rather than leaving the choice
    // invisible.
    const generics = cat.genericChoices(item);
    let generic = null;
    if (generics.length) {
      generic = m[5]
        ? resolve(m[5], generics, `aptitude for ${itemId} (one of ${generics.join(', ')})`)
        : generics[0];
    } else if (m[5]) {
      die(`--pin "${spec}": ${itemId} names no generic aptitudes to choose between`);
    }
    // The infusion: which set passive the piece carries, what its bonus line
    // rolled, and whether the piece is Prismatic. Refused here only for what
    // the GAME refuses (a piece that cannot be infused) and for a stat the
    // piece cannot have rolled - a typed pin is a claim, unlike a dump.
    const inf = {};
    if (infPart != null) {
      pinnedInfusion.add(slot);
      if (!/^(none|empty|-)$/i.test(infPart)) {
        const im = /^([^/!]+)(?:\/([A-Za-z]+))?(!)?$/.exec(infPart);
        if (!im) die(`--pin "${spec}": cannot read the infusion part "~${infPart}" - the form is ~<infusion>[/<rating>][!]`);
        const why = cat.whyNotInfusable(item);
        if (why) die(`--pin "${spec}": ${why}`);
        inf.infusion = resolveInfusion(cat, im[1]);
        if (im[3]) inf.prismatic = true;
        const pool = cat.infusionBonusPool(item);
        if (im[2]) {
          const all = [...new Set((cat.cdb.byId('aptitude').get('InfusionBonus')?.atbScaling ?? []).map((e) => e.endAtb))];
          // "Crit" is what a person types and "CritChanceRating" what the row
          // says, so the name is matched without its suffix.
          const stat = resolve(im[2].replace(/Rating$/i, ''), all.map((a) => a.replace(/Rating$/, '')),
            'infusion bonus rating') + 'Rating';
          if (!pool.includes(stat)) {
            die(`--pin "${spec}": ${item.name} (${itemId}) cannot have rolled ${stat} as its infusion bonus - it already `
              + `pays that rating, and the roll is taken from the ones it does not (${pool.join(', ')})`);
          }
          inf.infusionStat = stat;
          if (!cat.infusionBonusActive(item, inf)) {
            const of = cat.infusions.get(inf.infusion);
            console.error(f.warn(`note: ${of.name} is a ${of.faction ?? '?'} infusion and ${item.name} is a `
              + `${cat.factionOrigin(item)} piece, so its bonus line stays dark - only a piece of the infusion's own `
              + 'faction, or a Prismatic one (a trailing !), is paid it'));
          }
        }
      }
    }
    loadout.gear[slot] = { item: itemId, rarity, stars: capped, level: instanceLevel, generic, ...inf };
    // (The Prismatic flag is not a part of its own here: it is stated with the
    // infusion, `~` with or without its `!`, and charsheet.mjs pinnedSheet
    // writes it from the infusion's pin - the one rule the editor's build
    // goes by too.)
    typedPieces.set(slot, { level: m[2] != null, rarity: m[3] != null, stars: m[4] != null });
    held.replaced(loadout, slot, itemId, infPart != null);
  }

  // --no-augment <slot> pins every socket that slot can have to empty. Applied
  // after gear pins so the host item is already known.
  for (const spec of args.repeated['no-augment'] ?? []) {
    const slot = resolve(spec, slotIds, 'slot');
    const g = loadout.gear[slot];
    const host = g?.item ? cat.itemById.get(g.item) : null;
    const types = host ? cat.socketsFor(host) : augTypeIds;
    for (const t of types) { pinnedAug.add(`${slot}/${t}`); delete loadout.augments[`${slot}/${t}`]; }
  }

  // Augment pins last: the socket must exist, which needs the host equipped.
  for (const p of augPins) {
    pinnedAug.add(p.key);
    if (p.value == null) { delete loadout.augments[p.key]; continue; }
    const [, type] = p.key.split('/');
    const choices = cat.augmentCandidates(type, { includeUnreleased: true }).map((a) => a.id);
    if (!choices.length) die(`no augments exist for socket ${type}`);
    const chosen = resolve(p.value, choices, `augment for ${type}`);
    // A DemonSigil grants a talent, and a talent belongs to exactly one class.
    // Without this a Warrior sigil pins onto a Priest and its talent is inserted
    // into a tree it is not part of.
    for (const grantedSkill of cat.itemById.get(chosen)?.skills ?? []) {
      const owner = cat.classes.find((c) => engine.talents.treeFor(c.unit).byId.has(grantedSkill));
      if (owner && owner.unit !== loadout.class) {
        die(`${chosen} grants ${grantedSkill}, a ${owner.unit} talent - ${loadout.class} cannot use it`);
      }
    }
    loadout.augments[p.key] = chosen;
  }

  // --- talents --------------------------------------------------------------
  // `--talent <node>=<rank>`. Naming ANY node fixes the WHOLE allocation: the
  // tree has tier thresholds, so a half-pinned allocation is not a constraint
  // the greedy can satisfy without re-deciding which branches are even
  // reachable. Say so rather than silently searching around the pin.
  //
  // BEFORE --skills AND --rune, which are resolved against what the build
  // OFFERS - and a talent is part of what it offers: Conduit: Spark Explosion
  // is a conduit the Mage's talent of that name puts in the pool, and a skill
  // a talent grants can carry a rune slot. Read after them, `--talent
  // Mage_Talent_ConduitSparkExplosion=1 --skills conduits=...` printed the
  // conduit under "not taken" and refused its name as unknown in the same
  // command. The tree needs nothing those two set, so it goes first; the
  // prune below then also drops what a saved selection holds of a tree this
  // command replaced.
  let pinnedTalents = false;
  const talentSpecs = args.repeated.talent ?? [];
  if (talentSpecs.length) {
    const tree = engine.talents.treeFor(loadout.class);
    const ids = tree.nodes.map((n) => n.skill);
    loadout.talents = {};
    for (const spec of talentSpecs) {
      if (spec === true) die('--talent needs a value, e.g. --talent Warrior_Hemorrhage=1');
      const eq = String(spec).indexOf('=');
      const node = resolve(eq < 0 ? spec : spec.slice(0, eq), ids, `talent in the ${loadout.class} tree`);
      const rank = eq < 0 ? 1 : Number(spec.slice(eq + 1));
      if (!Number.isFinite(rank) || rank < 1) die(`--talent "${spec}": rank must be a positive number`);
      loadout.talents[node] = rank;
    }
    // A node a socketed DemonSigil hands over costs no point and stands
    // outside the branch thresholds. Checked against no grant at all, a
    // questlog build or a saved envelope holding a sigil (optimize writes
    // the sigil's node into the talents it returns) was refused as a tier-4
    // node with no points under it.
    const bad = engine.talents.illegalAllocation(loadout.class, loadout.talents, {
      level: loadout.level,
      points: engine.talents.pointsAt(loadout.level, null),
      granted: sigilGranted(engine, loadout),
    });
    if (bad) die(`--talent: ${bad}`);
    pinnedTalents = true;
  } else if (held.talents) {
    pinnedTalents = held.holdsTree(loadout);   // the tree a saved or imported build recorded
  }

  // --skills weapon1=Sword_Swarm_Skill1,Sword_Swarm_Passive
  // --skills prayer=Smite,Life
  // A weapon offers three and you slot two, so this is a real build decision.
  // Left alone, the search picks; named here, it is fixed.
  const pinnedSkills = new Set();
  loadout.skills ??= {};
  held.notePicks(loadout);
  engine.plan.pruneSelection(loadout);
  for (const spec of args.repeated.skills ?? []) {
    if (spec === true) die('--skills needs a value, e.g. --skills weapon1=Skill1,Passive');
    const eq = String(spec).indexOf('=');
    if (eq < 0) die(`--skills "${spec}" needs the form pool=skill,skill`);
    const poolRaw = spec.slice(0, eq);
    const pools = engine.plan.pools(loadout);
    if (!pools.length) die('--skills: nothing is equipped that offers a skill choice yet (pin the weapon first)');
    const keys = pools.map((p) => p.key);
    // "weapon1", "arsenal", "prayers" and the raw key all resolve.
    const alias = new Map(pools.flatMap((p) => [
      [p.key.toLowerCase(), p.key],
      [f.short(p.key).toLowerCase(), p.key],
      [p.label.replace(/\s+/g, '').toLowerCase(), p.key],
      [(p.mechanic ?? '').toLowerCase(), p.key],
    ].filter(([k]) => k)));
    const wanted = alias.get(String(poolRaw).toLowerCase())
      ?? resolve(poolRaw, keys, `skill pool (one of ${pools.map((p) => f.short(p.key) + ' "' + p.label + '"').join(', ')})`);
    const pool = pools.find((p) => p.key === wanted);

    const picks = spec.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean)
      .map((x) => resolve(x, pool.options, `skill for ${pool.label}`));
    if (picks.length > pool.slots) {
      die(`${pool.label}: only ${pool.slots} slot${pool.slots === 1 ? '' : 's'} at level ${loadout.level}, ` +
        `but ${picks.length} skills were named`);
    }
    loadout.skills[pool.key] = picks;
    pinnedSkills.add(pool.key);
  }
  // Saved skill pins hold whatever the file already put in `loadout.skills`
  // - an imported one only while it still holds what the file recorded.
  for (const key of savedSkillPins) if (loadout.skills[key]?.length && held.keeps(loadout, key, pinnedSkills)) pinnedSkills.add(key);

  // --- runes, one pool at a time -------------------------------------------
  // `--rune <skill>=<rune>`. The pool is named by the skill that owns it, which
  // is how `runePools` keys them, and every other slot stays searchable.
  const pinnedRunes = new Set();
  loadout.runes ??= {};
  for (const host of held.runeHosts(loadout)) pinnedRunes.add(host);
  for (const spec of args.repeated.rune ?? []) {
    if (spec === true) die('--rune needs a value, e.g. --rune Warrior_Charge=Warrior_Charge_M1');
    const eq = String(spec).indexOf('=');
    if (eq < 0) die(`--rune "${spec}" needs the form skill=rune`);
    const pools = engine.talents.runePools(loadout);
    if (!pools.length) die('--rune: nothing equipped or allocated offers a rune choice yet');
    const skill = resolve(spec.slice(0, eq), pools.map((p) => p.skill), 'skill with a rune slot');
    const pool = pools.find((p) => p.skill === skill);
    const rhs = spec.slice(eq + 1);
    if (/^(none|empty|-)$/i.test(rhs)) { delete loadout.runes[skill]; pinnedRunes.add(skill); continue; }
    loadout.runes[skill] = resolve(rhs, pool.options.map((r) => r.id), `rune for ${f.short(skill)}`);
    pinnedRunes.add(skill);
  }

  return { pinnedGear, pinnedAug, pinnedSkills, pinnedRunes, pinnedTalents, pinnedInfusion, typedPieces };
}

function parseWeights(args) {
  const w = {};
  for (const spec of args.repeated.weight ?? []) {
    const [k, v] = String(spec).split('=');
    if (!GOALS.includes(k) || k === 'mixed') die(`--weight key must be one of ${GOALS.filter((g) => g !== 'mixed').join(', ')}`);
    w[k] = Number(v);
    if (!Number.isFinite(w[k])) die(`--weight ${k} needs a number`);
  }
  return Object.keys(w).length ? w : null;
}

// The objective the FIGHT plays for. A single goal is handed to the simulator
// so the derived rotation maximises it - a dps query no longer spends casts on
// heals - while a blend keeps the fight's everything-counts criterion, because
// the fight cannot see the blend's normalisation. Mirrors makeScorer.
function simGoalOf(s) {
  return (s.weights && Object.keys(s.weights).length) || s.goal === 'mixed' ? 'mixed' : s.goal;
}

// No id is excluded by default. This used to be `^GM_`, on the belief that
// the prefix marked dev-only items - and the only row it has ever matched is
// GM_MassGrab, "Pocket Hive", the game's one Great Mace (type GreatMace,
// dropped by Queen Honeyzabeth's table), which the default then hid from
// every class that can wield it. No dev or test item row exists in the sheet.
// What a run withholds now is decided by what the install hands out - see
// sources.mjs - and --exclude remains for whatever a user wants gone.
const DEFAULT_EXCLUDE = null;

// How far the rotation looks ahead before choosing a cast, in seconds. Set
// from measurement rather than taste: below ~6s a setup cast that only pays off
// through the skill after it cannot be seen, and above ~12s the answer stops
// moving while the search gets slower. 0 turns it off and gives a plain
// first-available priority list.
const DEFAULT_LOOKAHEAD = 8;

// --- saved builds ----------------------------------------------------------
//
// `--json` writes an ENVELOPE - the build plus the settings it was computed
// under plus the resulting metrics - because a loadout with no target, no goal
// and no cdb hash beside it is a number nobody can check. `--build` therefore
// has to accept both that envelope and a bare loadout, or the tool cannot read
// its own output.
//
// Everything the envelope recorded becomes a DEFAULT, so re-reading a file
// reproduces the run it came from, and any flag you pass still wins.
export const ENVELOPE_KEYS = ['goal', 'weights', 'target', 'fervorScope', 'tickSource', 'stars', 'rank', 'level', 'mix'];

function readBuildFile(args) {
  if (args.flags.import != null) return readImport(args);
  if (typeof args.flags.build !== 'string') return null;
  let raw;
  try { raw = JSON.parse(readFileSync(args.flags.build, 'utf8')); } catch (e) {
    die(`${args.flags.build}: ${e.message}`);
  }
  // An envelope carries the loadout under `build`; a bare loadout carries
  // `class` itself. Anything else is neither.
  const isEnvelope = raw && typeof raw === 'object' && raw.build && typeof raw.build === 'object';
  const loadout = isEnvelope ? raw.build : raw;
  if (!loadout?.class) {
    die(`${args.flags.build}: no "class" in the build file` +
      (isEnvelope ? ' (its "build" object has no class either)' : '') +
      '\nA build file is either the object --json writes, or a bare loadout {class, level, gear, augments}.');
  }
  return { envelope: isEnvelope ? raw : null, loadout, path: args.flags.build };
}

// --- an imported build -------------------------------------------------------
//
// `--import <file>` is a BUILD SOURCE beside --build, and reads what --build
// cannot: a character sheet another program wrote (docs/CHARACTER-SHEET.md),
// a modkit inventory dump, and the bench's own two shapes - all through ONE
// reader (src/charsheet.mjs), the one behind the UI's Import button and
// `bench import`, so the page and the command line cannot come to disagree
// about what a file said.
//
// It hands commonSetup what readBuildFile hands it for a --build file, with
// the reader's whole result beside it (`imported`): the loadout, and an
// envelope whose `pinned` is what the file RECORDED - every slot, socket,
// pool, rune slot and talent tree it said something about, held empty
// included - so a recorded choice is held and an unrecorded one is left to
// the search (applyPins merges it with what is typed). A weapon-skill rank
// the file records is the default rank; a saved build's own settings (goal,
// target, fight, stars...) are the defaults, as they are for --build.
//
// It is NOT turned into --pin strings, which is how a questlog link travels:
// the pin grammar has no word for a Flawless piece, a talent tree recorded
// empty or the rank, and a sigil's free node re-typed as --talent was
// refused as an illegal tree. And the ids are checked against the install
// the command runs on (--game), not whichever one a bare engine would find.
//
// Settings an import does not take from a saved build: its pins, rank and
// level (the reader's own reading of them stands in), the hashes and version
// it was written under (the reader reports another game build itself), and a
// rotation or a stat profile - charsheet.mjs reads the BUILD, and --build is
// the flag that replays a run.
const NOT_IMPORTED = new Set(['pinned', 'rank', 'level', 'cdbSha', 'bootSha', 'version', 'rotation', 'profile', 'profileValues']);

// The level a file records of its own, by its shape - null for a shape that
// carries none (a modkit dump), which is when a typed --level is the file's
// level rather than a re-levelling of it.
function ownLevel(parsed) {
  const dialect = detectSheetDialect(parsed);
  return dialect === 'farever-character-sheet' ? (parsed.character?.level ?? null)
    : dialect === 'bench-envelope' ? (parsed.build?.level ?? parsed.level ?? null)
      : dialect === 'bench-loadout' ? (parsed.level ?? null) : null;
}

// The most the bench reads of one file another program wrote is
// combatlog.mjs's own guard on one fight's log (64 MB). No character sheet,
// saved build or inventory dump comes near it - an optimize envelope is a
// quarter of a megabyte - and a file far past it cannot even be made a
// string: a 1.8 GB bench-probe capture handed to `bench import` died on V8's
// "Cannot create a string longer than ..." instead of a sentence. Asked of
// the file's size before a byte is read; null when it is within reach (a
// file that cannot be stat'ed is left to the read, which says why).
function oversizedImport(path) {
  let st;
  try { st = statSync(path); } catch { return null; }
  if (!st.isFile() || st.size <= MAX_LOG_BYTES) return null;
  const mb = (n) => `${Math.round(n / 1024 / 1024).toLocaleString('en-US')} MB`;
  return `${path} is ${mb(st.size)}, and no character sheet, saved build or one fight's combat log is near that `
    + `(the bench reads ${mb(MAX_LOG_BYTES)} of one at most)`
    + (/\.csv$/i.test(path) ? `. A bench-probe capture is read by bench verify --capture ${path}` : '');
}

// The engine a file another program wrote is read against: the install the
// command runs on (--game) and the class-skill bar's size (--class-skills),
// which decides how many picks a sheet's bar keeps. One place for --import,
// `bench import` and `bench submit`.
function engineOptions(args) {
  return {
    quiet: true,
    game: typeof args.flags.game === 'string' ? args.flags.game : undefined,
    classSkillSlots: args.flags['class-skills'] != null && args.flags['class-skills'] !== true
      ? Number(args.flags['class-skills']) : undefined,
  };
}

// The sheet inside what `bench import <sheet> --json` wrote - {kind: 'sheet',
// sourceFormat, sheet, report} - or null for any other file. That file is the
// sheet as the bench read it with the report beside it, and given back to
// --import or `bench import` it is read as that sheet.
function reportedSheet(parsed) {
  if (parsed == null || typeof parsed !== 'object' || parsed.kind !== 'sheet' || parsed.character !== undefined) return null;
  return detectSheetDialect(parsed.sheet) ? parsed.sheet : null;
}

// A report line the reader is warned of: the readers say so themselves, as
// `warn: true` on the item (charsheet.mjs reportItems, combatlog.mjs
// logReportItems, and submit.mjs reportItems, which carries it onto the
// readers' lines it nests) - never told here by a list of kinds, nor by the
// line's first word. The UI's Import and Send dialogs mark by the same flag.
const warnedLine = (item) => item?.warn === true;

// --- a modkit dump beside a combat log: the class the log names --------------
// A modkit inventory dump records no class, and charsheet.mjs refuses it
// without one. A combat log of the same character names it - its header's
// character.class, or Wink's summary meClass - and `bench verify --capture
// <log>` priced that character's dump on it, then refused the very same dump
// given by --import. So a dump read beside a log of its own character takes
// the log's class when its weapons fit it, and the report says so; a typed
// --class still wins. When the log gives it is charsheet.mjs
// dumpClassFromLog's to say - the rule `bench submit` and the UI's Send read
// a dump beside a log by (src/submit.mjs buildSubmission) - and this only
// reads the log and says it in the command line's words.
// The unit ids a player can be: the game's classes. Handed to the combat-log
// reader (capture.mjs combatLogOf) wherever an engine is at hand, so a party
// member of a class the log itself never names is still read as a player.
const heroKindsOf = (engine) => engine.cat.classes.map((c) => c.unit);
function dumpClassBeside(engine, refusal, logPath) {
  if (typeof logPath !== 'string') return null;
  let log = null;
  try { log = combatLogOf(logPath, { heroKinds: heroKindsOf(engine) })?.log ?? null; } catch (e) {
    if (e instanceof CombatLogError) return null;
    throw e;
  }
  const unit = dumpClassFromLog(engine.cat, refusal, log);
  return unit
    ? { unit, said: `a modkit dump names no class: it is read as a ${unit}, the class ${logPath} gives its character ${log.handle} (--class says otherwise)` }
    : null;
}
// --- end of a modkit dump beside a combat log -----------------------------------

function readImport(args) {
  if (args.importedBuild !== undefined) return args.importedBuild;
  const path = args.flags.import;
  if (path === true || path === '') {
    die('--import needs a file: a character sheet, a build the bench saved, or a modkit inventory dump');
  }
  if (args.flags.build != null) {
    die('--import and --build are both the build a command starts from - give one of them.\n'
      + '  --import reads a character sheet (or any file bench import reads as one); --build replays a run the bench saved.');
  }
  const tooBig = oversizedImport(path);
  if (tooBig) die(`--import ${tooBig}`);
  let bytes;
  try { bytes = readFileSync(path); } catch (e) { die(`--import ${path}: ${e.message}`); }
  const engine = createEngine(engineOptions(args));
  // A typed --class names the class of a file that names none (a modkit
  // dump); a file that names its own keeps it, and the report says so. A
  // typed --level is handed to the reader the same way - for a file with no
  // level of its own - and otherwise RE-LEVELS the build afterwards, exactly
  // as it re-levels a --build file (loadBuild): the file is read at the level
  // it was recorded at, and then asked about at the one typed.
  const typedLevel = args.flags.level != null && args.flags.level !== true ? String(args.flags.level) : null;
  const typedClass = typeof args.flags.class === 'string' ? args.flags.class : null;
  let parsed = null;
  try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { parsed = null; }
  const report = reportedSheet(parsed);
  if (report) parsed = report;
  const own = ownLevel(parsed);
  const readAs = (cls) => readSheet(engine, parsed ?? bytes, { cls, level: own == null ? typedLevel : null });
  let r;
  let fromLog = null;
  try {
    r = readAs(typedClass);
  } catch (e) {
    if (!(e instanceof SheetError)) throw e;
    // A modkit dump beside the fight `bench verify` holds it against: the
    // class that log gives it, when it gives one (dumpClassBeside).
    fromLog = args._[0] === 'verify' && typeof args.flags.capture === 'string' && e.needs === 'class'
      ? dumpClassBeside(engine, e, resolveCapture(requireGame(args._), args.flags.capture).path) : null;
    if (!fromLog) die(`--import ${path}: ${e.message}`);
    try {
      r = readAs(fromLog.unit);
    } catch (again) {
      if (again instanceof SheetError) die(`--import ${path}: ${again.message}`);
      throw again;
    }
  }
  const envelope = Object.fromEntries(Object.entries(r.envelope ?? {}).filter(([k]) => !NOT_IMPORTED.has(k)));
  envelope.pinned = {
    gear: r.pins.gear, augments: r.pins.augments, skills: r.pins.skills,
    infusions: r.pins.infusions, runes: r.pins.runes, talents: r.pins.talents,
  };
  envelope.level = r.level;
  if (r.rank != null) envelope.rank = r.rank;

  // What was read, kept, dropped and left open - before the command's own
  // output, like a questlog link's warnings. On stderr when stdout is the
  // command's JSON: a bare --json, and verify's --json with or without a
  // value (verify prints its ledger to stdout either way, so the report on
  // stdout made the ledger unparseable).
  const jsonOnStdout = args.flags.json === true || (args._[0] === 'verify' && !!args.flags.json);
  const say = jsonOnStdout ? (s) => console.error(s) : (s) => console.log(s);
  say(f.bold(`--import ${path}`));
  if (report) say(f.dim('  The report `bench import --json` wrote: the sheet under its "sheet" key is read.'));
  for (const item of sheetReportItems(r)) say((warnedLine(item) ? f.warn : f.dim)(`  ${item.text}`));
  if (fromLog) say(f.dim(`  The class: ${fromLog.said}.`));
  if (typedLevel != null && own != null && Number(typedLevel) !== r.level) {
    say(f.warn(`  --level ${typedLevel} re-levels the imported build, which the file records at level ${r.level} - `
      + 'as it re-levels a --build file. What that level cannot hold is not checked here.'));
  }
  if (r.envelope?.rotation != null || r.envelope?.profile != null) {
    say(f.dim(`  The ${r.envelope.rotation != null ? 'rotation' : 'stat profile'} saved in ${path} is not used: --import reads the build, `
      + `and --build ${path} replays the run it was saved with.`));
  }
  say('');
  args.importedBuild = { envelope, loadout: r.loadout, path, imported: r };
  return args.importedBuild;
}

// The object `bench verify` reads its build off - the shape inventory.mjs
// toLoadout and fromSnapshot return - for an imported sheet. A sheet carries
// no affix rows, so the SHEET check (the game's own arithmetic, which only a
// capture snapshot logs) has nothing to run on; its runes are the slotted
// ones it recorded; its gaps are what it left unrecorded, which is what the
// ledger closes on, as it closes on what a dump cannot see.
function builtFromSheet(r, loadout) {
  return {
    loadout,
    character: r.name,
    unit: r.unit,
    level: loadout.level,
    placed: Object.entries(loadout.gear ?? {}).filter(([, g]) => g?.item)
      .map(([slot, g]) => ({ slot, item: g.item, stars: g.stars ?? 0 })),
    gaps: [...r.gaps],
    affixes: [],
    sockets: [],
    runesKnown: true,
    attrs: {},
    sheet: {},
  };
}

// --- bench verify: an imported sheet as the build, a combat log as the capture --
// Each is a helper called from one line of `verify`, so the command's own body
// stays what it was beside them.
//
// The build can come from a character sheet (readImport, which commonSetup has
// already run and which has said what it read) and the capture can be a
// combat log another program wrote (capture.mjs combatLogOf: a
// farever-combat-log or a Wink timeline). A log names its own character, which
// is then the default --character; a Wink summary alone holds no row to
// compare and is refused with the reader's sentence.
function verifySources(args, game, engine) {
  const at = resolveCapture(game, typeof args.flags.capture === 'string' ? args.flags.capture : null);
  let combatLog = null;
  if (at.exists) {
    try { combatLog = combatLogOf(at.path, { heroKinds: heroKindsOf(engine) })?.log ?? null; } catch (e) {
      if (!(e instanceof CombatLogError)) throw e;
      die(e.message);
    }
  }
  return { imported: args.importedBuild ?? null, combatLog };
}

// A COMBAT LOG IS ONE FIGHT: with no window asked for (and no --snapshot to
// take one from), its whole span is the window - its first row to its last,
// lead-in included - and it is treated as a GIVEN window from there on: dated
// by its rows, refused when it holds nothing of the character's, replayed
// over its own length, opened at the gauge it logs. The ledger says the
// window is the log's own span. (Left to the default, a fight under thirty
// seconds read as "no recorded damage", and a longer one as "the last 3 play
// sessions" of a file that is one.) Null when that is not the case.
function logSpanWindow(combatLog, capturePath, asked, args) {
  if (!combatLog || asked.windows || args.flags.snapshot != null) return null;
  let span = null;
  for (const r of combatLogOf(capturePath).rows) {
    if (!Number.isFinite(r.ts)) continue;
    span ??= { from: r.ts, to: r.ts };
    if (r.ts < span.from) span.from = r.ts;
    if (r.ts > span.to) span.to = r.ts;
  }
  return span;
}

// THE DIFFICULTY A COMBAT LOG NAMES. Which difficulty a fight was is the one
// thing no capture row says (verify.mjs modelTarget, "the difficulty"), and a
// log's header can say it: encounter.difficulty 1 Veteran, 2 Heroic (the
// game's ActivityDifficulty). A log that says so is priced on it -
// <unit>@veteran or @heroic, the unit the --target filter names, else the
// encounter's own boss - and the ledger says the log decided it. --price-as
// still wins, and so does a mode typed on --target (Ratsar@heroic,
// Ratsar#900@veteran); where that mode and the log disagree, the note says so.
//
// Only where the target COULD have stood in Veteran or Heroic: not the
// training dummy (logged at its row's level 1, whatever the activity), not a
// fight whose header says the target was a dummy, and not one whose hits the
// log wrote at a level below MaxLevel - asked of the character's hits on the
// unit priced. A header saying Heroic over a dummy at level 1 priced the
// model as Dummy@heroic at level 25 (-22.5% where the same log at Normal read
// -1.6%), and the logged level's own line went with it. Then the logged level
// prices it, and the note says why the header was not followed. A log that
// does not say (-1, or nothing) gets a line, where it could have mattered.
//
// Returns { priceAs, note }: priceAs is the model's pricing when the log
// decided it, else null.
function logPricing(engine, combatLog, { rawTarget, wantTarget, wantArchetype, priceAs }) {
  if (!combatLog || priceAs) return { priceAs: null, note: null };
  const enc = combatLog.stats.encounter;
  const d = enc.difficulty;
  const typedMode = wantTarget ? (/@([a-z]+)$/.exec(wantTarget)?.[1] ?? null) : null;
  if (typedMode) {
    const logMode = d === 0 || d === 1 || d === 2 ? DIFFICULTIES[d].toLowerCase() : null;
    return {
      priceAs: null,
      note: logMode && logMode !== typedMode && !(typedMode === 'scaled' && d === 0)
        ? `the log says the fight was ${DIFFICULTIES[d]}; --target ${rawTarget} prices it @${typedMode}, as typed` : null,
    };
  }
  const units = engine.cdb.byId('unit');
  const unit = wantArchetype && units.has(wantArchetype) ? wantArchetype : (enc.bossKind && units.has(enc.bossKind) ? enc.bossKind : null);
  const maxLevel = Math.round(engine.ctx.consts.maxLevel);
  const dummy = engine.combat.namedTargets.dummy?.unit ?? null;
  const mine = combatLog.events.filter((e) => e.kind === 'damage' && e.source === combatLog.me);
  const onUnit = unit ? mine.filter((e) => e.targetKind === unit) : [];
  const hits = onUnit.length ? onUnit : mine;
  const logged = (e) => Number.isFinite(e.targetLevel) && e.targetLevel !== maxLevel;
  const couldBeHard = enc.targetDummy !== true && hits.some((e) => !(dummy && e.targetKind === dummy) && !logged(e));
  if (d === 1 || d === 2) {
    const mode = d === 1 ? 'veteran' : 'heroic';
    if (!couldBeHard) {
      const below = [...new Set(hits.filter(logged).map((e) => e.targetLevel))].sort((a, b) => a - b);
      const why = enc.targetDummy === true ? 'its header says the target was a training dummy'
        : dummy && hits.length && hits.every((e) => e.targetKind === dummy) ? `${dummy} is the training dummy`
          : below.length ? `the hits${onUnit.length ? ` on ${unit}` : ''} were logged at level ${below.join(', ')}, below MaxLevel ${maxLevel}`
            : `${combatLog.handle} landed no hit in it`;
      return {
        priceAs: null,
        note: `the log says the fight was ${DIFFICULTIES[d]}, but ${why}, so it was not one: the model is priced at the level the hits were logged at, `
          + `not @${mode} (--price-as <unit>@${mode} prices it so)`,
      };
    }
    let stands = false;
    if (unit) { try { engine.combat.foe(`${unit}@${mode}`, engine.ctx.consts.maxLevel); stands = true; } catch { stands = false; } }
    if (!stands) {
      return {
        priceAs: null,
        note: `the log says the fight was ${DIFFICULTIES[d]}, and names no unit to price that on - --target <unit> or --price-as <unit>@${mode} does`,
      };
    }
    return {
      priceAs: `${unit}@${mode}`,
      note: `the log says the fight was ${DIFFICULTIES[d]}: the model is priced as ${unit}@${mode}`
        + `${wantArchetype ? '' : ', the encounter\'s own boss'} (--price-as, or a mode on --target, prices it otherwise)`,
    };
  }
  if ((d === -1 || d === null) && couldBeHard) {
    return {
      priceAs: null,
      note: 'the log does not say which difficulty the fight was: a target at MaxLevel stood in Veteran or Heroic, '
        + 'and --price-as <unit>@veteran or @heroic says which',
    };
  }
  return { priceAs: null, note: null };
}

// THE CHARACTER A COMBAT LOG NAMES, against the build. A log's header says
// which class and level its character was; a sheet for another character
// priced against it gave a confident ledger at exit 0 (the example Warrior
// log against the Rogue example sheet: "no base attack in this window",
// "model: 0.0 dps"). Another class is refused - its rows cannot be this
// build's - unless a typed --class CONFIRMS the build's own class, which
// says the header is the one wrong: charsheet.mjs classVouch, the rule
// `bench submit` holds the same pair to. Only an imported file that names
// its own class can be confirmed; a modkit dump (imported, or read from the
// game's folder), a sheet with no class and a capture snapshot have no class
// but the one --class gave them, and that word cannot outvote the log's.
// Another level is said (the note returned): --level re-levels the build to
// the log's.
function logCharacterNote(engine, combatLog, built, { capturePath, wantClass, importPath, imported = null }) {
  if (!combatLog) return null;
  const logUnit = logClass(engine.cat, combatLog);
  const { vouchable, vouched } = classVouch(engine.cat, imported, wantClass, { stated: !imported });
  if (logUnit && logUnit !== built.unit && !vouched) {
    const why = vouchable
      ? `, or --class ${built.unit} if the log's header is the one that is wrong.`
      : `.${wantClass != null ? `\n  --class ${wantClass} is the build's only word on its class - ${imported
        ? `${importPath} names none` : 'a dump or a capture snapshot names none'} - so it cannot say the log's header is the one that is wrong.` : ''}`;
    die(`${capturePath} says its character${combatLog.handle ? ` ${combatLog.handle}` : ''} is a ${logUnit}, `
      + `and the build ${importPath ? `${importPath} ` : ''}is a ${built.unit}: its rows cannot be priced as this build.\n`
      + `  Give the build the log was fought in${importPath ? ' (--import <sheet>)' : ''}${why}`);
  }
  const lvl = combatLog.header?.character?.level;
  return Number.isInteger(lvl) && lvl !== built.level
    ? `the log says its character was level ${lvl}, and the build is priced at level ${built.level} - --level ${lvl} prices it at the log's`
    : null;
}

// WHAT THE READER SAID ABOUT THE LOG, which the ledger stands on: every
// problem it named - damage rows it could not read or place on a target
// (none of which a --target filter reads), a recorder's gap, a summary it
// could not use - and the notes a reader of the evidence needs: an estimated
// start, what a Wink file cannot hold, a party fight. Only `bench import`
// said them, and verify printed a ledger over the very rows they qualify.
// Not the reader's line on the difficulty: verify says its own, the log's
// difficulty being its pricing (logPricing). And a farever-combat-log whose
// character's hits carry no affinity or no target level - the reader has no
// line for it (both are bench additions), and the ledger then compares a
// skill logged under two affinities as one row, at its target's row level.
function logFindings(combatLog) {
  if (!combatLog) return null;
  const notes = combatLog.notes.filter((n) => !/^the difficulty is unknown/.test(n));
  if (combatLog.dialect === 'farever-combat-log') {
    const mine = combatLog.events.filter((e) => e.kind === 'damage' && e.source === combatLog.me);
    const noAffinity = mine.filter((e) => typeof e.affinity !== 'string' || e.affinity === '').length;
    const noLevel = mine.filter((e) => !Number.isFinite(e.targetLevel)).length;
    const of = (n) => `${n === mine.length ? 'none' : `${(mine.length - n).toLocaleString('en-US')}`} of ${combatLog.handle}'s ${mine.length.toLocaleString('en-US')} hits`;
    if (noAffinity) notes.push(`${of(noAffinity)} carry an affinity: a skill logged under two affinities is compared as one row`);
    if (noLevel) notes.push(`${of(noLevel)} carry a targetLevel: the target is priced at its row's level`);
  }
  return { problems: [...combatLog.problems], notes };
}

// WHERE A COMBAT LOG LEAVES THE FIGHT TO THE MODEL, said. A log that records
// no press of its character (combatlog.mjs stats.presses: none written, and
// none declared with source.recordsPresses) cannot say what was pressed, so
// the model plays its own rotation over it - and what it presses that the
// log has no row of is its choice, not evidence. And a Mage's fight opens at
// the Spark the log carries on the character's presses and skill starts
// (the bench-addition field `spark`, read by poolAt): a log with none, or
// none in the window, opens the model's fight on a full gauge, where the
// conduits fire from the top. (Spark is the one gauge verify opens a fight
// at; a log's `rage` is carried and not read.) Null lines where there is
// nothing to say.
function logPlayNotes(engine, combatLog, built, { rank, poolStart, replay }) {
  if (!combatLog) return { presses: null, gauge: null };
  const who = `${combatLog.handle}'s`;
  const presses = combatLog.stats.presses ? null
    : `presses: the log records none of ${who}, and does not say it records them (source.recordsPresses) - the model plays its own rotation, `
      + `and what it presses that the log has no row of is its choice, not evidence${replay ? '; --replay has no recorded sequence to play' : ''}`;
  let gauge = null;
  try { gauge = engine.plan.resolve(built.loadout, rank).sparkGauge?.atb ?? null; } catch { gauge = null; }
  if (!gauge || poolStart?.[gauge] != null) return { presses, gauge: null };
  const key = gauge.toLowerCase();
  return {
    presses,
    gauge: (combatLog.stats.pools ?? []).includes(key)
      ? `${gauge}: no row of ${who} in the window carries it, so the model's fight opens on a full gauge`
      : `${gauge}: the log carries no ${key} value on ${who} presses or skill starts (the field \`${key}\`), so the model's fight opens on a full gauge`,
  };
}

// THE REPLAY'S OPENING IN A LOG THAT WRITES NO SKILL START. --replay opens
// the model's fight where the character's state first becomes a skill (a
// go_state row: a probe's, or captureRows' for every skill_use and
// block_use). A log of presses alone has none, and the replayed fight moved
// from its first second where the recorded one stood until the character
// first acted. So it opens at the character's first press or first hit of
// the base-attack chain in the window, whichever is earlier - a hit lands
// after its swing began, so one opens the fight a windup late - and the
// replay line says which. `see` is handed every row in the window.
function logOpeningWatch(character, chainIds) {
  const w = { ts: null, from: null };
  w.see = (r) => {
    if (r.source !== character) return;
    const from = r.event === 'press' ? 'press' : r.event === 'inflict' && chainIds.has(r.skill) ? 'hit' : null;
    if (from && (w.ts === null || r.ts < w.ts)) { w.ts = r.ts; w.from = from; }
  };
  return w;
}
// --- end of bench verify's import and combat-log helpers -------------------------

function commonSetup(args) {
  const saved = readBuildFile(args);
  const env = saved?.envelope ?? {};
  // A saved setting is a default; an explicit flag always wins.
  const from = (flag, key, fallback) => (args.flags[flag] !== undefined && args.flags[flag] !== null
    ? args.flags[flag]
    : (env[key] !== undefined && env[key] !== null ? env[key] : fallback));

  const assume = {};
  if (env.fervorScope) assume.fervorScope = env.fervorScope;
  if (typeof args.flags[`fervor-scope`] === 'string') assume.fervorScope = args.flags[`fervor-scope`];
  if (args.flags['no-fervor-damage']) assume.fervorScope = 'none';
  if (!FERVOR_SCOPES.includes(assume.fervorScope ?? 'all')) die(`--fervor-scope must be one of ${FERVOR_SCOPES.join(', ')}`);
  if (args.flags['no-mastery']) assume.mastery = false;
  // Whose sheet a status tick is priced off. The default is this build's read
  // (the unit that applied the status); 'carrier' is the accepted build's rule.
  // Saved with the build like the fervor scope, so a file written under one
  // rule is not silently re-read under the other.
  if (env.tickSource) assume.tickSource = env.tickSource;
  if (args.flags['tick-source'] != null) assume.tickSource = args.flags['tick-source'];
  if (!TICK_SOURCES.includes(assume.tickSource ?? TICK_SOURCES[0])) die(`--tick-source must be one of ${TICK_SOURCES.join(', ')}`);
  // Reported from play: a skill cast interrupts the base-attack chain, so the
  // fight restarts it at link 1 after every cast. This flag restores the old
  // reading - the chain holding its place through anything - for sensitivity.
  if (args.flags['chain-persists']) assume.chainResets = false;
  // An unpinned item's stats follow its authored/drop level (verified on a
  // real tooltip); `scaled` prices the untested hypothesis that a fresh drop
  // at your level carries your level's stats.
  if (typeof args.flags.drops === 'string') {
    if (!['scaled', 'authored'].includes(args.flags.drops)) die("--drops must be 'scaled' or 'authored'");
    assume.dropsScale = args.flags.drops === 'scaled';
  }
  // The measured floor on a chain link's swing period (0 to trust the
  // authored durations alone).
  // How often basic attacks land from behind, for the upgrade perks that pay
  // there. Default 0.41, the share a player's sessions measured (engine.mjs
  // DEFAULT_ASSUME); 1 is the Shadowstep claim, and a capture block fought
  // from one side of a dummy is 1 or 0.
  if (args.flags['behind-fraction'] != null && args.flags['behind-fraction'] !== true) {
    assume.behindFraction = Number(args.flags['behind-fraction']);
    if (!(assume.behindFraction >= 0 && assume.behindFraction <= 1)) die('--behind-fraction needs 0..1');
  }
  // The share of a passive's ground drops the hero walks into, for a cast
  // armed by collecting them (the Censer's clouds). Default 1 - every drop,
  // the moment it lands - which is the read with nothing subtracted and is
  // not a measurement (engine.mjs DEFAULT_ASSUME; `bench audit`).
  if (args.flags.pickups != null) {
    assume.pickupShare = args.flags.pickups === true ? NaN : Number(args.flags.pickups);
    if (!(assume.pickupShare >= 0 && assume.pickupShare <= 1)) die('--pickups needs 0..1 (the share of the drops you walk into)');
  }
  if (args.flags['swing-floor'] != null && args.flags['swing-floor'] !== true) {
    assume.swingFloor = Number(args.flags['swing-floor']);
    if (!Number.isFinite(assume.swingFloor) || assume.swingFloor < 0) die('--swing-floor needs a number of seconds');
  }

  // The fight the numbers are computed over. Every one of these is an input,
  // never a derived number, and each is recorded in --json so a result can be
  // re-derived: a dps figure with no fight length and no target count behind it
  // is not comparable to anything, least of all to an in-game meter.
  const numFlag = (name, fallback, { integer = false } = {}) => {
    // A bare `--fight` with no value is a typo, not a request for the default.
    if (args.flags[name] === true) die(`--${name} needs a value`);
    const raw = args.flags[name] !== undefined ? args.flags[name] : (env[name] ?? fallback);
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) die(`--${name} needs a positive number`);
    // Rounding after validating let `--fights 0.4` pass and then write `0` into
    // an envelope the tool refuses to read back.
    if (integer && !Number.isInteger(v)) die(`--${name} needs a whole number, not ${raw}`);
    return v;
  };
  const fight = {
    seconds: numFlag('fight', 200),
    count: numFlag('fights', 1, { integer: true }),
    targets: numFlag('targets', 1),
    // A PERCENT on the way in, because that is the number the game prints and
    // the number a player says out loud - "under 35%" is how the rune's own
    // tooltip reads. The engine wants the ratio the scripts compare against,
    // so it is divided here and nowhere else.
    targetHealth: (() => {
      // `numFlag` looks a saved default up in the envelope under the FLAG's own
      // name, and every other fight field is spelled the same in both places.
      // This one is not - the flag is kebab, the envelope is camelCase like the
      // rest of its keys - so the saved value is handed in as the fallback
      // explicitly. Without it `--build` would silently re-run a 35% envelope
      // at full health and report different numbers for the same file.
      const pct = numFlag('target-health',
        typeof env.targetHealth === 'number' ? env.targetHealth * 100 : 100);
      if (pct > 100) die('--target-health is a percent of the target\'s health, so it cannot exceed 100');
      return pct / 100;
    })(),
    // 0 is legal here and means "no lookahead", so it cannot go through numFlag.
    lookahead: (() => {
      if (args.flags.lookahead === true) die('--lookahead needs a value');
      const raw = args.flags.lookahead ?? env.lookahead ?? DEFAULT_LOOKAHEAD;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) die('--lookahead needs a number of seconds, or 0 to turn it off');
      return v;
    })(),
  };
  const engine = createEngine({
    game: typeof args.flags.game === 'string' ? args.flags.game : undefined,
    assume, fight,
    // How many of the class-skill bar's slots you get. Not in the data - see
    // CLASS_SKILL_SLOTS in skills.mjs - so it is overridable rather than fixed.
    classSkillSlots: args.flags['class-skills'] != null && args.flags['class-skills'] !== true
      ? Number(args.flags['class-skills']) : undefined,
  });

  // The two hashes travel with every export precisely so a build assembled
  // against different numbers is rejectable rather than silently re-scored.
  if (saved?.envelope?.cdbSha && saved.envelope.cdbSha !== engine.meta.cdbSha) {
    console.error(f.warn(`note: ${saved.path} was written against cdb ${saved.envelope.cdbSha.slice(0, 8)}, ` +
      `this game is ${engine.meta.cdbSha.slice(0, 8)} - the numbers will not match that run`));
  }

  const level = Number(from('level', 'level', engine.ctx.consts.maxLevel));
  if (!Number.isFinite(level) || level < 1) die('--level needs a positive number');
  if (level > engine.ctx.consts.maxLevel) {
    console.error(f.warn(`note: --level ${level} is above this build's MaxLevel of ${engine.ctx.consts.maxLevel}; curves extrapolate`));
  }
  const starsFlag = from('stars', 'stars', 'max');
  const stars = starsFlag === 'max' ? 'max' : Number(starsFlag);
  if (stars !== 'max' && !Number.isFinite(stars)) die("--stars needs a number or 'max'");
  const rarities = typeof args.flags.rarity === 'string'
    ? new Set(args.flags.rarity.split(',').map((r) => resolve(r, engine.cdb.lines('rarity').map((x) => x.id), 'rarity')))
    : null;
  const goal = String(from('goal', 'goal', 'dps'));
  if (!GOALS.includes(goal)) die(`--goal must be one of ${GOALS.join(', ')}`);
  // Default to a boss rather than to `Armor_ExpectedReduction`: the authored
  // boss intent is 0.40 against that constant's 0.25, which understates
  // penetration against the content anyone actually gears for. The boss also
  // stands at YOUR level - it used to be Ratsar under a fitted level of 6.9,
  // which froze the pool at 1,177 and left the default mitigating less than
  // world trash. See `bench targets`.
  //
  // An envelope written by this version records the target NAME, with its
  // mode when it has one ("Ratsar@heroic"). One written by an older version
  // recorded only the label ("named boss (Ratsar: 0.4/0.4)"), so the unit id
  // is recovered from the parentheses rather than failing.
  const savedTarget = typeof env.target === 'string'
    ? (/^[A-Za-z0-9_]+(?:@[a-z]+)?$/.test(env.target) ? env.target : (/\(([A-Za-z0-9_]+):/.exec(env.target)?.[1] ?? null))
    : null;
  const targetName = String(args.flags.target ?? savedTarget ?? 'boss');
  // The level the target STANDS at, when it is not the one the target name
  // already implies. The resist pool is built at the target's level and the
  // divisor at the striker's - two dials, and "authored 0.40" is only 40%
  // when they agree. Left unset, a shortcut stands at your level, a unit id
  // at its row's, and `@veteran` / `@heroic` / `@scaled` where those put it
  // (combat.foe has the reads).
  const targetLevel = args.flags['target-level'] != null && args.flags['target-level'] !== true
    ? Number(args.flags['target-level']) : null;
  if (targetLevel !== null && !(Number.isFinite(targetLevel) && targetLevel > 0)) {
    die('--target-level needs a positive number');
  }
  const rank = Number(from('rank', 'rank', engine.ctx.consts.weaponSkillMaxRank));
  const mix = Number(from('mix', 'mix', 0.5));
  const exPattern = args.flags['include-all'] ? null
    : (typeof args.flags.exclude === 'string' ? args.flags.exclude : DEFAULT_EXCLUDE);
  let exclude = null;
  if (exPattern) {
    try { exclude = new RegExp(exPattern); } catch (e) { die(`--exclude is not a valid regex: ${e.message}`); }
  }
  // --include-all also re-admits the rows nothing in this install hands out
  // (sources.mjs). Set once on the catalog, so every candidate list agrees.
  engine.cat.setIncludeUnreleased(!!args.flags['include-all']);
  // Which infusions a search may hand out, and what the bonus roll of a piece
  // nobody owns is taken to be. Both describe the RUN, so they sit on the
  // engine's options beside the fight - optimize() reads them from there -
  // and an envelope's recorded choice is the default, like every other
  // setting.
  {
    const savedSearch = env.infusionSearch ?? null;
    const flag = args.flags.infusions;
    if (flag === true) die('--infusions needs a value: learnable, all, none, or a comma-separated list of infusions');
    if (flag != null) {
      const v = String(flag);
      if (/^all$/i.test(v)) engine.opts.infusions = [...engine.cat.infusions.keys()];
      else if (/^none$/i.test(v)) engine.opts.infusions = [];
      else if (!/^learnable$/i.test(v)) {
        engine.opts.infusions = v.split(',').map((x) => resolveInfusion(engine.cat, x.trim()));
      }
    } else if (Array.isArray(savedSearch?.offered)) {
      engine.opts.infusions = savedSearch.offered.filter((id) => engine.cat.infusions.has(id));
    }
    const st = args.flags['infusion-stat'];
    if (st === true) die('--infusion-stat needs a value: none, best, or a rating (CritChance, Fervor, ArmorPenetration, SpellPenetration)');
    if (st != null) {
      const v = String(st);
      if (/^(none|best)$/i.test(v)) engine.opts.infusionStat = v.toLowerCase();
      else {
        const all = [...new Set((engine.cdb.byId('aptitude').get('InfusionBonus')?.atbScaling ?? []).map((e) => e.endAtb))];
        if (!all.length) die('--infusion-stat: this build of the game has no infusion bonus ratings');
        engine.opts.infusionStat = resolve(v.replace(/Rating$/i, ''), all.map((a) => a.replace(/Rating$/, '')),
          'infusion bonus rating') + 'Rating';
      }
    } else if (typeof savedSearch?.stat === 'string') {
      engine.opts.infusionStat = savedSearch.stat;
    }
  }
  let talentPoints = null;
  if (args.flags[`talent-points`] != null && args.flags[`talent-points`] !== true) {
    talentPoints = Number(args.flags[`talent-points`]);
    if (!Number.isFinite(talentPoints) || talentPoints < 0) die(`--talent-points needs a number`);
  }
  const rarityCap = typeof args.flags[`rarity-cap`] === 'string'
    ? resolve(args.flags[`rarity-cap`], engine.cat.cdb.lines('rarity').map((r) => r.id), 'rarity')
    : null;
  // A named stat profile stands in place of the armour, so a weapon or a
  // rotation can be compared at a fixed corner of the stat space instead of
  // against whatever the gear search converged on. See `bench profiles`.
  let profile = null;
  if (args.flags.profile != null || env.profile != null) {
    const raw = args.flags.profile === true ? null : (args.flags.profile ?? env.profile);
    if (!raw) die('--profile needs a name; `bench profiles` lists them');
    profile = resolve(String(raw), engine.profiles.list().map((p) => p.id), 'profile');
  }
  // The rig is hardcoded at 50/100 and both numbers are overridable, because
  // "does the answer change at a different level of gear" is the next question
  // anyone asks after "does it change with the repartition".
  const profileValues = {};
  for (const [flag, key] of [['profile-base', 'base'], ['profile-peak', 'peak']]) {
    if (args.flags[flag] == null || args.flags[flag] === true) continue;
    const v = Number(args.flags[flag]);
    if (!Number.isFinite(v) || v < 0) die(`--${flag} needs a number of stat points, zero or more`);
    profileValues[key] = v;
  }
  // An AUTHORED rotation, played as authored instead of the derived order and
  // the lookahead. The file is the APL shape `bench rotation --json` writes -
  // {entries: [{skill, cond}], excluded} - or, hand-written, a bare array of
  // skill ids / {skill} objects, which becomes a plain priority list. Skills
  // not on the list are never pressed; that is what "authored" means.
  //
  // WHERE THE FILE KEEPS IT. `bench rotation --json` writes an envelope - the
  // kit under `build`, the rotation under `rotation` - and this reader took
  // `raw.apl ?? raw`, so the one file the help names ("the file bench rotation
  // --json writes") was refused as "not a rotation". Both keys are read.
  const asApl = (x) => {
    let apl = x;
    if (Array.isArray(apl)) {
      apl = {
        entries: apl.map((e) => (typeof e === 'string' ? { skill: e, cond: { kind: 'always' } }
          : { skill: e?.skill, cond: e?.cond ?? { kind: 'always' } })),
        excluded: [],
      };
    }
    return Array.isArray(apl?.entries) && apl.entries.every((e) => typeof e?.skill === 'string') ? apl : null;
  };
  const said = (apl) => `${apl.entries.length} line${apl.entries.length === 1 ? '' : 's'}, walked top to bottom and the first that is ready pressed; `
    + 'a skill with no line is never pressed';
  let policy = null, policyNote = null;
  if (typeof args.flags['rotation-file'] === 'string') {
    let raw;
    try { raw = JSON.parse(readFileSync(args.flags['rotation-file'], 'utf8')); } catch (e) {
      die(`${args.flags['rotation-file']}: ${e.message}`);
    }
    const apl = asApl(raw?.apl ?? raw?.rotation ?? raw);
    if (!apl) {
      die(`${args.flags['rotation-file']}: not a rotation - expected the file bench rotation --json writes, {entries:[{skill,...}]} or ["Skill_A", ...]`);
    }
    policy = makePolicy(apl);
    policyNote = `authored: the rotation in ${args.flags['rotation-file']} - ${said(apl)}`;
  }
  // THE ROTATION SAVED WITH A BUILD. The envelope `bench rotation --json`
  // writes says what its kit scored UNDER ITS ROTATION (metrics.dps), and
  // `sheet --build` of that file priced the kit under the derived order
  // instead - 210.5 for an envelope that says 225.4 - with nothing said.
  // Handed on here for the one command that re-prices a saved build as it
  // stands (`sheet`); a search is NOT handed it, because an authored list
  // ("a skill with no line is never pressed") changes what a search scores.
  const savedApl = !policy && saved?.envelope ? asApl(saved.envelope.rotation ?? null) : null;
  return {
    engine, stars, rarities, goal, targetName, targetLevel, rank, mix, exclude, rarityCap, talentPoints, policy, policyNote,
    savedRotation: savedApl?.entries.length ? { apl: savedApl, path: saved.path, said: said(savedApl) } : null,
    saved, fight, numFlag, profile, profileValues,
    // A bare loadout carries its own level, and the foe, the rating->percent
    // conversions and the candidate list all have to agree with it. Reporting a
    // level-10 character against a level-25 foe mixed two levels in one page.
    level: (args.flags.level == null && env.level == null && saved?.loadout?.level > 0)
      ? saved.loadout.level : level,
    // On by default: a WEAPON's rarity is rolled at drop, so a Rare-authored
    // sword that can land Epic or Legendary should be on the table (gear never
    // rolls one - see catalog.attainableRarities). --no-rarity-roll pins every
    // weapon to the rarity the CDB authors it at. It round-trips like everything
    // else: an envelope written with --no-rarity-roll re-reads that way.
    rarityRoll: args.flags['no-rarity-roll'] ? false : (env.rarityRoll ?? true),
    // A saved blend must not outrank a typed --goal. It used to: re-reading an
    // envelope written with --weight and passing --goal ehp still optimised the
    // saved dps blend, and no flag could clear it.
    weights: parseWeights(args)
      ?? (args.flags.goal !== undefined ? null : (env.weights ?? null)),
  };
}

function loadBuild(args, engine, level, saved = null) {
  const file = saved ?? readBuildFile(args);
  if (file) {
    const raw = file.loadout;
    // Deep enough to be independent of the parsed file: every one of these is
    // mutated by the pin layer and by the search.
    return {
      ...raw,
      // An explicit --level re-levels a saved build; otherwise it keeps its own.
      level: args.flags.level != null ? level : (raw.level ?? level),
      gear: Object.fromEntries(Object.entries(raw.gear ?? {}).map(([k, v]) => [k, { ...v }])),
      augments: { ...(raw.augments ?? {}) },
      skills: Object.fromEntries(Object.entries(raw.skills ?? {}).map(([k, v]) => [k, [...v]])),
      runes: { ...(raw.runes ?? {}) },
      talents: { ...(raw.talents ?? {}) },
    };
  }
  const cls = args.flags.class;
  if (typeof cls !== 'string') {
    die(`--class is required. One of: ${engine.cat.classes.map((c) => c.unit).join(', ')}`);
  }
  return emptyLoadout(engine.cat, resolve(cls, engine.cat.classes.flatMap((c) => [c.unit, c.aptitude]), 'class'), level);
}

// --- commands --------------------------------------------------------------

/**
 * Every weapon, at several stat corners, and how much the answer moves between
 * them.
 *
 * This is the measurement the "search the rotation, then the gear" plan rests
 * on. If the ranking and the kit hold across corners, a weapon and its skills
 * are ONE decision that can be made once and held fixed while the gear is
 * searched. If they do not, the two are coupled and have to be searched
 * together - which is a far more expensive problem, and worth knowing before
 * building for it rather than after.
 */
function compareAcrossProfiles(s, args, profileIds) {
  const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
  const base = loadBuild(args, s.engine, s.level, s.saved);
  const cls = s.engine.cat.classes.find((c) => c.unit === base.class);
  const restarts = s.numFlag('restarts', 1, { integer: true });
  const skills = s.engine.cdb.byId('skill');

  const seen = new Set();
  const weapons = [];
  for (const c of s.engine.cat.candidates('Slot_Weapon1', {
    aptitude: cls.aptitude, charLevel: s.level, rarities: s.rarities,
    exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
  })) {
    if (seen.has(c.item.id)) continue;
    seen.add(c.item.id);
    weapons.push(c);
  }

  const t0 = Date.now();
  const byProfile = new Map();
  let n = 0;
  for (const p of profileIds) {
    const rows = [];
    for (const c of weapons) {
      if (process.stderr.isTTY) {
        process.stderr.write(`\r  ${++n}/${profileIds.length * weapons.length} ${p} ${c.item.id}      `);
      }
      const loadout = {
        ...base, gear: {}, augments: {}, skills: {}, runes: {}, talents: {},
        profile: p, profileValues: s.profileValues,
      };
      loadout.gear.Slot_Weapon1 = {
        item: c.item.id, rarity: c.rarity, generic: c.generic ?? null,
        stars: s.stars === 'max' ? s.engine.cat.maxStars(c.item, c.rarity)
          : Math.min(s.stars, s.engine.cat.maxStars(c.item, c.rarity)),
      };
      const pinnedGear = new Set(s.engine.cat.combatSlots().map((x) => x.id));
      if (!args.flags['no-arsenal']) pinnedGear.delete('Slot_Weapon2');
      try {
        const r = optimize(s.engine, {
      policy: s.policy ?? null,
          loadout, pinnedGear, pinnedAug: new Set(), goal: s.goal, weights: s.weights, target,
          rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
          exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
          talentPoints: s.talentPoints, allowEmpty: true, restarts,
        });
        rows.push({
          id: c.item.id,
          name: c.item.name ?? c.item.id,
          score: r.score,
          skills: (r.loadout.skills?.Slot_Weapon1 ?? []).slice().sort().join('+'),
          talents: Object.keys(r.loadout.talents ?? {}).sort().join('+'),
          runes: Object.entries(r.loadout.runes ?? {}).sort().map(([k, v]) => k + '=' + v).join(','),
        });
      } catch { /* a weapon this class cannot legally hold at this level */ }
    }
    rows.sort((a, b) => b.score - a.score);
    byProfile.set(p, rows);
  }
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(60) + '\r');

  console.log(f.header(s.engine, VERSION) + '\n');
  console.log(`${f.bold(base.class + ' ' + s.level)} - every mainhand at ${profileIds.length} stat corners, `
    + `by ${f.bold(s.goal)} vs ${target.name}`);
  console.log(f.dim(`${weapons.length} weapons x ${profileIds.length} profiles in `
    + `${((Date.now() - t0) / 1000).toFixed(1)}s   skills, talents and runes chosen per cell   `
    + 'no armour, no offhand, no augments\n'));

  // The reference ordering is the LAST corner asked for, so the columns read
  // left to right toward the one the table is sorted by.
  const ref = byProfile.get(profileIds[profileIds.length - 1]).map((r) => r.id);
  const cell = (p, id) => {
    const rows = byProfile.get(p);
    const i = rows.findIndex((r) => r.id === id);
    return i < 0 ? '-' : `#${i + 1} ${rows[i].score.toFixed(0)}`;
  };
  console.log(f.table(['WEAPON', ...profileIds],
    ref.map((id) => [
      byProfile.get(profileIds[0]).find((r) => r.id === id)?.name ?? id,
      ...profileIds.map((p) => cell(p, id)),
    ]), { align: [null, ...profileIds.map(() => 'r')] }));

  console.log('\n' + f.bold('HOW FAR THE ORDER MOVES') + f.dim(` - against ${profileIds[profileIds.length - 1]}`));
  console.log(f.table(['  PROFILE', 'WINNER', 'MEAN SHIFT', 'WORST'],
    profileIds.map((p) => {
      const rows = byProfile.get(p);
      let worst = 0, sum = 0;
      for (let i = 0; i < ref.length; i++) {
        const j = rows.findIndex((r) => r.id === ref[i]);
        if (j < 0) continue;
        worst = Math.max(worst, Math.abs(i - j));
        sum += Math.abs(i - j);
      }
      return ['  ' + p, rows[0]?.name ?? '-', (sum / Math.max(1, ref.length)).toFixed(2), String(worst)];
    }), { align: [null, null, 'r', 'r'] }));

  console.log('\n' + f.bold('AND WHETHER THE BUILD FOR ONE WEAPON MOVES WITH THE STATS'));
  console.log(f.table(['  WEAPON', 'SKILLS', 'TALENTS', 'RUNES'],
    ref.slice(0, 8).map((id) => {
      const per = profileIds.map((p) => byProfile.get(p).find((r) => r.id === id)).filter(Boolean);
      const distinct = (k) => new Set(per.map((r) => r[k])).size;
      const say = (nn) => (nn === 1 ? f.dim('same') : f.warn(`${nn} different`));
      return ['  ' + (byProfile.get(profileIds[0]).find((r) => r.id === id)?.name ?? id),
        say(distinct('skills')), say(distinct('talents')), say(distinct('runes'))];
    })));
  console.log('\n' + f.dim(
    'A column that reads `same` everywhere is a decision that does not depend on your gear,\n'
    + 'so it can be made once and held fixed while the gear is searched. One that moves has to\n'
    + 'be re-decided per stat corner - which is cheap, as long as you know it needs doing.'));
}

/**
 * Every ORDERED pair of weapons: what goes in the main hand and what goes in
 * the arsenal, both ways round.
 *
 * The pair is ordered and the model already says why: only the main hand grants
 * a base-attack chain and a combo, while the arsenal grants two CHOSEN skills
 * and `ceil(v * 0.4)` of its stats. So (A main, B arsenal) and (B main, A
 * arsenal) are different builds with different rotations, and on this data they
 * differ by up to 15% - which means a sweep that picks the arsenal greedily per
 * mainhand is answering a smaller question than the one being asked.
 *
 * Both weapon slots are PINNED in every cell. What is searched is everything
 * that hangs off them: the two main-hand skills, the two arsenal skills, four
 * class skills out of five, the runes on each, and the sixteen talent points.
 */
function sweepWeaponPairs(s, args, top) {
  const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
  const base = loadBuild(args, s.engine, s.level, s.saved);
  const cls = s.engine.cat.classes.find((c) => c.unit === base.class);
  const restarts = s.numFlag('restarts', 1, { integer: true });

  const seen = new Set();
  const weapons = [];
  for (const c of s.engine.cat.candidates('Slot_Weapon1', {
    aptitude: cls.aptitude, charLevel: s.level, rarities: s.rarities,
    exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
  })) {
    if (seen.has(c.item.id)) continue;
    seen.add(c.item.id);
    weapons.push(c);
  }
  const byId = new Map(weapons.map((w) => [w.item.id, w]));
  const nameOf = (id) => byId.get(id)?.item?.name ?? id;
  const gearFor = (id) => {
    const c = byId.get(id);
    return {
      item: id, rarity: c.rarity, generic: c.generic ?? null,
      stars: s.stars === 'max' ? s.engine.cat.maxStars(c.item, c.rarity)
        : Math.min(s.stars, s.engine.cat.maxStars(c.item, c.rarity)),
    };
  };

  let done = 0;
  const tick = (label) => {
    done++;
    if (process.stderr.isTTY) process.stderr.write(`\r  ${done} ${label}                    `);
  };
  function cell(mainId, arsId) {
    tick(`${mainId} / ${arsId ?? '-'}`);
    const loadout = {
      ...base, gear: {}, augments: {}, skills: {}, runes: {}, talents: {},
      profile: s.profile, profileValues: s.profileValues,
    };
    loadout.gear.Slot_Weapon1 = gearFor(mainId);
    if (arsId) loadout.gear.Slot_Weapon2 = gearFor(arsId);
    const pinnedGear = new Set(s.engine.cat.combatSlots().map((x) => x.id));
    try {
      const r = optimize(s.engine, {
      policy: s.policy ?? null,
        loadout, pinnedGear, pinnedAug: new Set(), goal: s.goal, weights: s.weights, target,
        rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
        exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
        talentPoints: s.talentPoints, allowEmpty: true, restarts,
      });
      return {
        dps: r.score,
        mainSkills: r.loadout.skills?.Slot_Weapon1 ?? [],
        arsSkills: r.loadout.skills?.Slot_Weapon2 ?? [],
        classSkills: r.loadout.skills?.['class/ClassSkill'] ?? [],
        talents: Object.keys(r.loadout.talents ?? {}).sort().join('+'),
        runes: Object.entries(r.loadout.runes ?? {}).sort().map(([k, v]) => k + '=' + v).join(','),
      };
    } catch { return null; }
  }

  const t0 = Date.now();
  // One cheap pass with an empty arsenal decides which weapons are worth
  // pairing. A silent cap reads as "we tried everything", so the count of what
  // was dropped is printed rather than assumed away.
  const solo = [];
  for (const w of weapons) {
    const r = cell(w.item.id, null);
    if (r) solo.push({ id: w.item.id, ...r });
  }
  solo.sort((a, b) => b.dps - a.dps);
  const pool = solo.slice(0, Math.min(top, solo.length)).map((x) => x.id);

  const grid = new Map();  // `${main}|${ars}` -> cell
  for (const m of pool) {
    grid.set(`${m}|`, solo.find((x) => x.id === m));
    for (const a of pool) {
      if (a === m) continue;
      const r = cell(m, a);
      if (r) grid.set(`${m}|${a}`, r);
    }
  }
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(60) + '\r');

  console.log(f.header(s.engine, VERSION) + '\n');
  console.log(`${f.bold(base.class + ' ' + s.level)} - every ORDERED weapon pair, by ${f.bold(s.goal)} vs ${target.name}`);
  console.log(f.profileBlock(s.engine.profiles.resolve(s.profile, base.class, s.level, s.profileValues)));
  console.log(f.dim(`${done} cells in ${((Date.now() - t0) / 1000).toFixed(1)}s   `
    + `top ${pool.length} of ${weapons.length} weapons paired both ways`
    + (weapons.length > pool.length
      ? `   ${weapons.length - pool.length} dropped after the solo pass (--top to change)` : '')
    + `\nboth weapon slots pinned per cell; main-hand skills, arsenal skills, class skills, `
    + 'runes and talents searched inside it'));
  console.log('');

  // The matrix. Rows are the main hand, columns the arsenal - which is the
  // whole point, so the two triangles are not the same numbers.
  console.log(f.bold('MAIN HAND (row) x ARSENAL (column)'));
  console.log(f.table(['  MAIN', ...pool.map((a) => nameOf(a).slice(0, 11)), '(none)'],
    pool.map((m) => ['  ' + nameOf(m).slice(0, 26),
      ...pool.map((a) => (a === m ? f.dim('-') : (grid.get(`${m}|${a}`)?.dps.toFixed(0) ?? '-'))),
      f.dim(grid.get(`${m}|`)?.dps.toFixed(0) ?? '-')]),
    { align: [null, ...pool.map(() => 'r'), 'r'] }));

  // The pairs themselves, and what each one chose - which is the substrate a
  // rotation search runs over.
  const ranked = [...grid.entries()]
    .map(([k, v]) => ({ main: k.split('|')[0], ars: k.split('|')[1] || null, ...v }))
    .sort((a, b) => b.dps - a.dps);
  const skillName = (x) => s.engine.cdb.byId('skill').get(x)?.texts?.name ?? x;
  console.log('\n' + f.bold('BEST PAIRINGS'));
  console.log(f.table([s.goal.toUpperCase(), 'MAIN HAND', 'MAIN SKILLS', 'ARSENAL', 'ARSENAL SKILLS', 'CLASS SKILLS'],
    ranked.slice(0, 12).map((r) => [
      r.dps.toFixed(1), nameOf(r.main), r.mainSkills.map(skillName).join(', '),
      r.ars ? nameOf(r.ars) : f.dim('(none)'), r.arsSkills.map(skillName).join(', '),
      r.classSkills.map(skillName).join(', '),
    ]), { align: ['r'] }));

  console.log('\n' + f.bold('AND HOW MUCH THE ORDER MATTERS'));
  const flips = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const ab = grid.get(`${pool[i]}|${pool[j]}`);
      const ba = grid.get(`${pool[j]}|${pool[i]}`);
      if (!ab || !ba) continue;
      const hi = Math.max(ab.dps, ba.dps);
      flips.push({
        a: pool[i], b: pool[j], ab: ab.dps, ba: ba.dps,
        gap: (Math.abs(ab.dps - ba.dps) / hi) * 100,
        sameKit: ab.talents === ba.talents && ab.runes === ba.runes
          && ab.classSkills.join('+') === ba.classSkills.join('+'),
      });
    }
  }
  flips.sort((a, b) => b.gap - a.gap);
  console.log(f.table(['  WEAPON A', 'WEAPON B', 'A MAIN', 'B MAIN', 'GAP', 'SAME KIT?'],
    flips.slice(0, 10).map((x) => ['  ' + nameOf(x.a).slice(0, 24), nameOf(x.b).slice(0, 24),
      x.ab.toFixed(1), x.ba.toFixed(1), x.gap.toFixed(1) + '%',
      x.sameKit ? f.dim('yes') : f.warn('no')]),
    { align: [null, null, 'r', 'r', 'r'] }));
  const mean = flips.reduce((t, x) => t + x.gap, 0) / Math.max(1, flips.length);
  console.log(f.dim(`\n  mean ${mean.toFixed(1)}%, worst ${(flips[0]?.gap ?? 0).toFixed(1)}% - `
    + 'so the pair is ordered, and a sweep that picks the arsenal greedily per mainhand\n'
    + '  is answering a smaller question. SAME KIT? says whether the two orders even want the\n'
    + '  same talents, runes and class skills; where it says no, they are different builds.'));
}

/**
 * Attach a named stat profile to a loadout, and take the armour off.
 *
 * A profile REPLACES the gear - that is the whole point of it - so leaving
 * armour on would double-count. The weapon slots stay live, because the weapon
 * is what grants the skills, sets WeaponPower, and is usually the thing being
 * compared; every other slot is pinned empty so no search can fill it.
 */
function applyProfile(s, loadout, pins) {
  if (!s.profile) return pins;
  loadout.profile = s.profile;
  loadout.profileValues = s.profileValues;
  const weapons = new Set(['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']);
  for (const slot of s.engine.cat.combatSlots()) {
    if (weapons.has(slot.id)) continue;
    delete loadout.gear[slot.id];
    pins.pinnedGear.add(slot.id);
  }
  for (const k of Object.keys(loadout.augments ?? {})) {
    if (!weapons.has(k.split('/')[0])) delete loadout.augments[k];
  }
  return pins;
}

// There is no portable "open this URL", so it is one spawn per platform.
// Failing to open is not fatal: the address is already on stdout, and a
// headless or locked-down box simply has nobody to hand it to.
//
// ui/server.mjs's standalone block has the same helper and does not export it.
// Exporting it there deletes this copy.
function openBrowser(url) {
  const [cmd, argv] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, argv, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no opener on this box - the address is printed */
  }
}

// --- bench submit: what it reads and where it writes ------------------------
//
// A file `bench submit` packs - the fight's log, Wink's summary, an imported
// sheet - read whole, with the size asked first (oversizedImport): the
// submission's own caps (20 MB a log, 512 KB a sheet) are src/submit.mjs's,
// and say themselves; this only keeps a file far past them from dying in V8
// before either can. Sent under the file's base name - which the bundle
// never carries (its entries have fixed names) and the reports print.
function readSubmitPart(path, flag) {
  const tooBig = oversizedImport(path);
  if (tooBig) die(`${flag} ${tooBig}`);
  let data;
  let mtimeMs = null;
  try {
    data = readFileSync(path);
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    die(`${flag} ${path}: ${e.message}`);
  }
  return { name: basename(path), data, mtimeMs };
}

// Where a send's receipt is written: beside the zip it was saved as (its
// name with .receipt.json for .zip); else in the folder the bench keeps its
// receipts in, the UI's own - <FAREVER_BENCH_CACHE, or the bench's .cache>/
// submit-receipts/farever-bench-receipt-<id>.json - and not the current
// folder. Run from a clone of the bench that folder is the repository, and
// the receipt asks for the fight's deletion: `git add -A` published it, and
// anyone could then ask for that. The run prints where it went.
function submitReceiptPath(sub, zipPath) {
  if (zipPath) return `${zipPath.replace(/\.zip$/i, '')}.receipt.json`;
  const cache = process.env.FAREVER_BENCH_CACHE || join(fileURLToPath(new URL('..', import.meta.url)), '.cache');
  return join(cache, 'submit-receipts', `farever-bench-receipt-${sub.id}.json`);
}

// The receipt already standing at `path`, or null when nothing does. A
// receipt is the only way to ask for a sent fight's deletion, so a file there
// that is not this bundle's receipt is never written over: one of another
// submission would leave that one beyond its sender's reach. One saved
// before a send whose answer never came is most often the player's own
// earlier try at this very fight, and the way on is to send that bundle
// again as itself - so that is said before the other name for --zip.
function receiptStanding(path, sub) {
  if (!existsSync(path)) return null;
  let held;
  try {
    held = parseReceipt(readFileSync(path));
  } catch (e) {
    if (!(e instanceof SubmissionError)) throw e;
    die(`${path} is already there and is not a receipt the bench wrote, so it is not written over - give --zip another name, `
      + 'and the receipt goes beside it');
  }
  if (held.id !== sub.id) {
    die(`${path} is the receipt of another submission (${held.id.slice(0, 8)}), and how that one's deletion is asked for - it is not written over. `
      + (held.sentAt
        ? 'Give --zip another name, and the receipt goes beside it.'
        : `It was saved before a send whose answer never came: the same command with --receipt ${path} sends that bundle again as itself; `
          + '--zip with another name packs this one as a new submission, its receipt beside it.'));
  }
  return held;
}

// A receipt written to disk: receiptText's (which names the bundle's SHA-256,
// so --receipt builds that bundle again or refuses), readable by its owner
// alone. Anyone who can read it can ask for the fight's deletion, so the
// file is created 0600, and one already standing there (a receipt
// saved before the send, now answered) is put back to 0600 as well: a mode
// given to writeFileSync applies only to a file it creates. (On Windows the
// mode is the read-only bit and nothing more; the folder's own ACL is what
// keeps other accounts out, as it does for the UI's receipts.)
function writeReceipt(path, receipt) {
  writeFileSync(path, receiptText(receipt), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* written, and its mode left as the system made it */ }
}

// A path that names a file - not a folder, and not nothing.
function isFileAt(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Wink's summary beside a timeline, read when the player named none: the
// <id>.json of an <id>.json.timeline, when that is a file. The player did not
// type it, so a read that fails is not their --summary failing: the summary
// is left out, and that is said, and the log goes alone. Null when there is
// none to read. Whether the log reader took it as this timeline's summary
// is known only once the bundle is built (see `submit`). Found and read as
// every reader of a log finds it (capture.mjs winkCompanion).
function besideSummary(logPath) {
  const side = winkCompanion(logPath);
  if (!side) return null;
  return { path: side.path, part: side.data ? { name: side.name, data: side.data, mtimeMs: side.mtimeMs } : null, why: side.why };
}

// Where --zip may write. Never over a file this run reads, nor a receipt -
// the one way to ask for a sent fight's deletion, and not in the zip, so a
// receipt written over is a fight whose deletion nobody can ask for - nor
// anything that is not a bundle the bench saved: `--zip mylog.jsonl`
// replaced the player's log with the zip and said "Saved". An earlier bundle
// may be replaced; its receipt, if it was sent, is a file of its own. The
// sentence, or null.
function zipTargetProblem(zipPath, inputs) {
  const key = (p) => {
    const full = resolvePath(p);
    return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full;
  };
  for (const [what, path] of inputs) {
    if (typeof path === 'string' && key(path) === key(zipPath)) {
      return `--zip ${zipPath} is ${what}, and the bundle is not saved over it - give --zip another name`;
    }
  }
  let st;
  try {
    st = statSync(zipPath);
  } catch {
    return null;
  }
  const other = `${zipPath} is already there and is not a bundle the bench saved, so it is not written over - give --zip another name`;
  if (!st.isFile() || st.size > MAX_ZIP_BYTES) return other;
  let bytes;
  try {
    bytes = readFileSync(zipPath);
  } catch (e) {
    return `--zip ${zipPath}: ${e.message}`;
  }
  try {
    const held = parseReceipt(bytes);
    return `${zipPath} is the receipt of submission ${held.id.slice(0, 8)}, and how that one's deletion is asked for - the bundle is not saved over it; `
      + 'give --zip another name';
  } catch {
    /* not a receipt: is it a bundle? */
  }
  try {
    if (zipEntryProblem(readZipDirectory(bytes).map((d) => d.name)) === null) return null;
  } catch {
    /* not a zip at all */
  }
  return other;
}

// --- bench submit: the build typed on the command line ----------------------
// The build typed on the command line, as a build somebody stated:
// buildSubmission's editor input ({loadout, rank, pins, pieces}), the input
// the UI's editor build goes as, given the pins the flags set (applyPins).
// So src writes it by its one rule (charsheet.mjs pinnedSheet), says what it
// records empty (sub.problems, the report's Problem lines) and labels it as
// it labels the editor's (the manifest's sourceFormat 'bench-editor': a
// stated build, not a file an exporter wrote). A loadout has no "not
// stated", and sent whole every slot the flags left alone went as recorded
// empty and every pool as the character's - the maintainer held the model
// against a character with one weapon and nothing else. So what a flag
// stated is kept, and the rest is left out and named as a gap:
//
//   - a slot a --pin named (`none` is recorded empty), with its item, and of
//     the rest only what the pin wrote: ^level, @rarity, *stars (or --stars,
//     for every piece), the infusion after ~ with its /stat - and with it the
//     Prismatic flag, true with a trailing ! and false without (pinnedSheet's
//     rule, the editor's too). Flawless has no word in the pin grammar, so it
//     is never stated;
//   - a piece's sockets when a --pin or --no-augment named one of them;
//   - the pools --skills filled, the tree when --talent was given, the runes
//     when --rune was, the weapon-skill rank when --rank was;
//   - the level, always: a sheet must name one, so the default is written,
//     and said, when --level was not typed.
//
// A sheet records a piece's sockets, and the rune slots, WHOLE: what is not
// listed is empty. src says what it so records empty, and a socket pinned
// with no piece to sit on (its Problem lines); returned here beside the
// build are only the CLI's own words: `said`, the level nobody typed, and
// `hints`, the flag that names what each of those held - read off the same
// pinnedSheet, so the hints and src's sentences cannot disagree.
function typedBuild(engine, loadout, pins, { rank, typedLevel, typedStars }) {
  // What each pinned piece's --pin wrote; --stars states every piece's stars.
  const pieces = Object.fromEntries([...pins.pinnedGear].map((slot) => {
    const t = pins.typedPieces.get(slot) ?? {};
    return [slot, { ...t, stars: !!t.stars || !!typedStars }];
  }));
  const stated = {
    gear: [...pins.pinnedGear], augments: [...pins.pinnedAug], skills: [...pins.pinnedSkills],
    runes: [...pins.pinnedRunes], talents: !!pins.pinnedTalents, infusions: [...pins.pinnedInfusion],
  };
  const build = { loadout, name: null, rank: Number.isInteger(rank) ? rank : null, pins: stated, pieces };
  const said = [];
  if (!typedLevel) said.push(`--level was not given, and a sheet names one: it says ${loadout.level}, the bench's default - --level <n> says the character's`);
  const { emptied, unplaced } = pinnedSheet(engine, loadout, stated, { pieces });
  const hints = [
    ...emptied.sockets.map(({ slot }) => `--pin ${f.short(slot).toLowerCase()}/<socket>=<augment> names what a socket of ${slot} held.`),
    ...(emptied.runes.length ? ['--rune <skill>=<rune> names what a rune slot held.'] : []),
    ...unplaced.map((slot) => `--pin ${f.short(slot).toLowerCase()}=<item> names the piece ${slot}'s pinned sockets sit on.`),
  ];
  return { build, said, hints };
}
// --- end bench submit: the build typed on the command line ------------------

// What `bench submit` reads, by the way it is asked. Anything else typed
// beside it was stored and never looked at - `--json out.json` wrote
// nothing and exited 0, `--check` checked nothing, `--delete` with a --pin
// beside it asked for a deletion and said nothing of the pin - so it is
// refused, as the command's own flags are refused on every other command
// (SUBMIT_ONLY).
const SUBMIT_READS = ['log', 'summary', 'import', 'build', 'note', 'keep-name', 'zip', 'send', 'receipt', 'class', 'level', 'game', 'class-skills'];
// The flags that assemble a build the way `bench sheet` takes them: read
// when no file (--import, --build) is the build. Beside one, each would send
// another build than the one the file recorded.
const SUBMIT_BUILD = ['pin', 'no-augment', 'skills', 'rune', 'talent', 'stars', 'rank', 'questlog', 'questlog-build'];

// The refusal for a flag `bench submit` would not read as it is asked, or
// null. Asked in main() before a questlog link is fetched, so that a refusal
// reaches nothing.
function submitUnread(args) {
  const typed = [
    ...Object.keys(args.flags).filter((flag) => args.flags[flag] != null),
    ...Object.keys(args.repeated).filter((flag) => (args.repeated[flag] ?? []).length),
  ];
  if (args.flags.delete != null) {
    const beside = typed.filter((flag) => flag !== 'delete');
    if (!beside.length) return null;
    return `--delete asks for the deletion of a fight sent earlier and builds nothing, so --${beside[0]} has nothing to do beside it: `
      + `bench submit --delete ${typeof args.flags.delete === 'string' ? args.flags.delete : '<receipt.json>'}`;
  }
  const unread = typed.filter((flag) => !SUBMIT_READS.includes(flag) && !SUBMIT_BUILD.includes(flag));
  if (unread.length) {
    return `--${unread[0]} is not read by \`bench submit\`, which would ignore it`
      + (unread[0] === 'json' ? ' - --zip saves the bundle, and its manifest.json is what it holds, as data.'
        : unread[0] === 'check' ? ' - bench import <file> --check checks a sheet or a log.'
          : ' - it packs the build and the fight as they are and prices nothing (bench sheet prices the build).');
  }
  const file = args.flags.import ?? args.flags.build ?? null;
  const beside = file != null ? typed.filter((flag) => SUBMIT_BUILD.includes(flag)) : [];
  if (beside.length) {
    return `--${args.flags.import != null ? 'import' : 'build'} ${file === true ? '<file>' : file} is the build the fight was fought in, as the file recorded it, `
      + `and --${beside[0]} would send another - give the file alone (with --class and --level for a file that does not carry them), `
      + 'or the build by flags without a file';
  }
  return null;
}

const commands = {
  /**
   * The same character sheet the packaged desktop app shows, served out of this
   * process for the browser you already have. Needs Node and your own copy of
   * Farever and nothing else - no Chromium download, and no unsigned binary to
   * talk Windows into running - which is also the only way a Linux or macOS
   * player gets the UI at all.
   *
   * ui/server.mjs is imported HERE and nowhere else, dynamically: it pulls in
   * the icon service, the pak reader and the whole web tree, so a static import
   * would charge `bench rank` for a UI it never starts, and a copy of the bench
   * shipped without ui/ would fail before it could run a single command.
   */
  async ui(args) {
    if (args.flags.port === true) die('--port needs a number, or leave it out for any free port');
    const port = args.flags.port == null ? 0 : Number(args.flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      die('--port needs a whole number from 0 to 65535 (0, or nothing at all, takes any free one)');
    }
    if (args.flags.host === true) die('--host needs an address, e.g. --host 0.0.0.0');
    const host = typeof args.flags.host === 'string' ? args.flags.host : '127.0.0.1';
    if (args.flags.game === true) die('--game needs the path to your Farever install');

    // The engine's own answer to "where is Farever", and its own sentence when
    // there is none: requireGame prints what to do about it and stops, so a
    // missing install reads as a missing install rather than as a stack out of
    // the pak reader three imports later. An explicit --game is handed over
    // rather than left to findGame's default argv, which is this command line
    // and not the one it expects to parse.
    const game = requireGame(typeof args.flags.game === 'string' ? ['--game', args.flags.game] : []);

    let startServer;
    try {
      ({ startServer } = await import('../ui/server.mjs'));
    } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
      die('ui/ is missing or incomplete in this copy, so there is no UI to serve.\n'
        + `  ${e.message}\n`
        + '  Every other command still works. The download that carries the UI is\n'
        + `  farever-bench-v${VERSION}.zip.`);
    }

    const benchRoot = fileURLToPath(new URL('..', import.meta.url));
    const live = await startServer({ benchRoot, host, port, game });

    // A wildcard bind is not an address anyone can open. The loopback one is,
    // and it is inside the wildcard.
    const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const url = `http://${shown.includes(':') ? `[${shown}]` : shown}:${live.port}/`;
    console.log(`farever-bench ${VERSION} ui on ${url}`);
    console.log(f.dim(`  reading ${game}`));
    // The line every other command prints under its header; this one has no
    // header, and the page it serves carries the same sentence.
    if (live.notice) console.log(f.warn(`  ${live.notice}`));
    // On the BOUND address, not the printed one: a wildcard bind prints as
    // loopback and is precisely the case worth warning about.
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
      console.log(f.warn(`  bound to ${host}, so anything that can reach this machine can read it`));
    }
    // ...and Send a fight is off there (ui/server.mjs submitOffFor), in the
    // server's own sentence: every /api/submit/ route answers 403 with it.
    if (live.submitOff) console.log(f.warn(`  ${live.submitOff}.`));
    if (args.flags.open) openBrowser(url);
    else console.log(f.dim('  (--open launches your browser for you)'));
    console.log(f.dim('  press Ctrl+C to stop'));
  },

  classes(args) {
    const { engine } = commonSetup(args);
    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.table(['CLASS', 'APTITUDE', 'PRIMARY', 'ARMOUR TARGET', 'RESOURCE'],
      engine.cat.classes.map((c) => {
        const apt = engine.cdb.byId('aptitude').get(c.aptitude);
        const primary = (apt.atbScaling ?? []).find((e) => (e.statGroup ?? 0) === 0)?.endAtb ?? '-';
        const unit = engine.cdb.byId('unit').get(c.unit);
        const res = (unit.stats ?? []).map((s) => s.attribute).filter((a) => /^Max(Rage|Spark|ComboPoint|Focus|SpecialEnergy)$/.test(a));
        return [c.unit, c.aptitude, primary, f.pct(apt.props?.armorReduction ?? 0, 0), res.join(', ') || f.dim('(prayer charges)')];
      })));
  },

  slots(args) {
    const { engine } = commonSetup(args);
    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.table(['SLOT', 'CATEGORY', 'STAT FACTOR', 'HOSTS AUGMENT', 'INFUSION'],
      engine.cat.combatSlots().map((s) => {
        const here = engine.cat.items.filter((i) => i.slots.includes(s.id) && !i.isAugment);
        const types = here.flatMap((i) => engine.cat.socketsFor(i));
        // How many of the slot's rows can carry an infusion - counted, so the
        // column follows whatever tier and type the next patch opens it to.
        const infusable = here.filter((i) => engine.cat.canInfuse(i)).length;
        return [f.short(s.id), s.category, s.affixFactor === 1 ? '' : f.warn('x' + s.affixFactor),
          [...new Set(types)].map((t) => t.replace(/^Augment/, '')).join(', ') || f.dim('-'),
          infusable ? `${infusable} of ${here.length} rows` : f.dim('-')];
      })));
    console.log('\n' + f.dim('Slot factor: Slot_Weapon2 (the arsenal weapon) contributes 40% of its stats.'));
    if (engine.cat.infusions.size) {
      const c = engine.cat;
      console.log(f.dim(`Infusion: ${c.infusionMinRarity} armour with a faction can carry one of ${c.infusions.size} set passives; `
        + `${c.infusionCaps.join(' / ')} pieces of the SAME one are its rank ${c.infusionCaps.map((_, i) => i + 1).join(' / ')}. `
        + 'Pin one with --pin <slot>=<item>~<infusion>[/<rating>][!].'));
    }
  },

  items(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    const cls = classOf(s.engine.cat, loadout);
    const slotIds = s.engine.cat.combatSlots().map((x) => x.id);
    if (typeof args.flags.slot !== 'string') die(`--slot is required. One of: ${slotIds.map(f.short).join(', ')}`);
    const slot = resolve(args.flags.slot, slotIds, 'slot');
    // EVERY row, the withheld ones included and marked: this command is where
    // a player looks an item up, and one that silently is not there reads as a
    // bug. The search does not offer the marked rows unless --include-all.
    const list = s.engine.cat.candidates(slot, {
      aptitude: cls.aptitude, charLevel: s.level,
      rarities: s.rarities, exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
      talentPoints: s.talentPoints, includeUnreleased: true,
    });
    const { cat } = s.engine;
    const gone = new Map(list.filter((c) => cat.release(c.item).state === 'unreleased').map((c) => [c.item.id, cat.release(c.item)]));
    const anyInfusable = list.some((c) => cat.canInfuse(c.item));
    const pricedAt = (item) => cat.instanceLevel(item, { charLevel: s.level });
    const anyRaised = list.some((c) => c.item.level != null && pricedAt(c.item) !== c.item.level);
    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`${cls.unit} ${s.level} - ${f.short(slot)} - ${list.length} legal ` +
      `${s.rarityRoll ? '(item, rarity) pairs' : 'items'}\n`);
    console.log(f.table(['ITEM', 'NAME', 'RAR', 'ROLL', 'MAX UPG', 'LVL', 'FACTION', 'GIVES', 'SKILLS',
      ...(anyInfusable ? ['INFUSE'] : []), ...(gone.size ? ['SOURCE'] : [])],
      list.map((c) => [
        c.item.id, c.item.name === c.item.id ? '' : c.item.name, c.rarity,
        // A share of the rarities this row can roll, its own included - the
        // three of a Rare weapon sum to 100%. Gear does not roll and shows none.
        c.chance != null ? f.pct(c.chance, 0) : '',
        cat.maxStars(c.item, c.rarity),
        // The level an unpinned piece of this row is PRICED at, with the
        // row's own beside it where the two differ: a weapon's or a worn
        // armour piece's authored level is a floor, not a pin
        // (catalog.mjs effectiveLevel), and the column used to print the
        // floor - `1` for the 48 Demon armour rows a level-25 build wears at
        // 25, `18` for breeches priced at 250.
        c.item.level == null ? f.dim('(scales)')
          : pricedAt(c.item) !== c.item.level ? `${pricedAt(c.item)} ${f.dim(`(row ${c.item.level})`)}` : c.item.level,
        c.item.faction ?? (c.generic ? f.warn(c.generic) : f.dim("-")),
        f.ratingGiven(cat, c.item, cls.aptitude, c.rarity, c.generic) ?? f.dim('-'),
        c.item.skills.length ? f.warn(String(c.item.skills.length)) : '',
        ...(anyInfusable ? [cat.canInfuse(c.item)
          ? cat.infusionBonusPool(c.item).map((p) => p.replace(/Rating$/, '')).join('/') : f.dim('-')] : []),
        ...(gone.size ? [gone.has(c.item.id) ? f.warn('not obtainable') : ''] : []),
      ]), { align: [null, null, null, 'r', 'r', 'r'] }));
    if (anyRaised) {
      console.log(f.dim('\nLVL: the level an unpinned piece is priced at. "N (row n)": the row authors level n and the piece is priced at N - a weapon '
        + 'or worn armour as a drop at yours, its row level being a floor, or a piece every source of which makes it higher '
        + '(--drops authored prices a drop at n; --pin <slot>=<item>^n names one instance).'));
    }
    if (anyInfusable) {
      console.log(f.dim('\nINFUSE: the ratings the piece\'s infusion bonus can roll (the ones it does not already pay).'));
    }
    if (gone.size) {
      console.log(f.warn(`\n${gone.size} row${gone.size === 1 ? '' : 's'} above cannot be obtained on this build, and the search does not `
        + 'offer them (--include-all does):'));
      const byWhy = new Map();
      for (const [id, r] of gone) { if (!byWhy.has(r.why)) byWhy.set(r.why, []); byWhy.get(r.why).push(id); }
      for (const [why, ids] of byWhy) console.log(f.dim(`  ${ids.join(', ')}: ${why}`));
    }
  },

  sheet(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    const pins = applyProfile(s, loadout,
      applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved }));
    const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
    let ev = s.engine.evaluate(loadout, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s), policy: s.policy ?? null });
    // A build saved with its rotation is priced under that rotation
    // (commonSetup, `savedRotation`) - while the kit is still the one it was
    // written for. A --pin or a --skills that takes a listed skill off the
    // bar leaves a list that would skip that line in silence and never press
    // what replaced it; then the derived order is played, and said.
    let authored = s.policyNote ?? null, rotationGone = null;
    if (!s.policy && s.savedRotation) {
      const held = new Set(ev.rotation.active.map((a) => a.prof.id));
      const gone = [...new Set(s.savedRotation.apl.entries.map((e) => e.skill))].filter((id) => !held.has(id));
      if (gone.length) {
        const nameOf = (id) => s.engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
        rotationGone = `the rotation saved in ${s.savedRotation.path} is NOT played: it presses ${gone.map(nameOf).join(', ')}, `
          + `which this build does not hold (a --pin or a --skills changed the kit it was written for). The derived order is played instead; `
          + `--rotation-file ${s.savedRotation.path} plays the saved list as it is, skipping those lines.`;
      } else {
        ev = s.engine.evaluate(loadout, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s), policy: makePolicy(s.savedRotation.apl) });
        authored = `saved: the rotation ${s.savedRotation.path} was written with - ${s.savedRotation.said} (--rotation-file <json> plays another)`;
      }
    }
    console.log(f.header(s.engine, VERSION) + '\n');
    if (ev.profile) console.log(f.profileBlock(ev.profile) + '\n');
    console.log(f.gearBlock(s.engine, loadout) + '\n');
    {
      const ib = (ev.infusions?.sets.length || ev.infusions?.pieces.length)
        ? f.infusionBlock(s.engine, loadout, ev, { verbose: true }) : null;
      if (ib) console.log(f.bold('INFUSION') + '\n' + ib + '\n');
    }
    if (s.engine.socketsOf(loadout).length) {
      console.log(f.bold('AUGMENTS'));
      console.log(f.augmentBlock(s.engine, loadout) + '\n');
    }
    if (s.engine.plan.pools(loadout).length) {
      console.log(f.bold('SKILLS'));

      console.log(f.skillsBlock(s.engine, loadout, ev, { pinnedSkills: pins.pinnedSkills }) + '\n');
    }
    console.log(f.sheetBlock(s.engine, ev, { level: s.level }));
    if (rotationGone) console.log(f.warn(rotationGone) + '\n');
    console.log(f.throughputBlock(s.engine, ev, { goal: s.goal, authored }) + '\n');
    console.log(f.auditBlock(s.engine));
  },

  rank(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved });
    const slotIds = s.engine.cat.combatSlots().map((x) => x.id);
    if (typeof args.flags.slot !== 'string') die(`--slot is required. One of: ${slotIds.map(f.short).join(', ')}`);
    const slot = resolve(args.flags.slot, slotIds, 'slot');
    const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
    const { rows, baseScore } = rankSlot(s.engine, loadout, slot, { ...s, target });
    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`${loadout.class} ${s.level} - ranking ${f.short(slot)} by ${f.bold(s.goal)} vs ${target.name}`);
    if (baseScore <= 1e-9) {
      console.log(f.dim(`the slot is empty in this build, so there is nothing to be relative to - showing absolute ${s.goal}`));
    }
    console.log('');
    const limit = args.flags.all ? rows.length : 15;
    const apt = classOf(s.engine.cat, loadout).aptitude;
    console.log(f.table(['', 'ITEM', 'RAR', 'ROLL', 'UPG', 'FACTION', 'GIVES', s.goal.toUpperCase(), 'DELTA'],
      rows.slice(0, limit).map((r) => [
        r.equipped ? f.bold('>') : '', r.item.id, r.rarity,
        r.chance != null && r.rarity !== r.item.rarity ? f.pct(r.chance, 0) : '',
        r.stars ? '*'.repeat(r.stars) : '',
        r.item.faction ?? (r.generic ? f.warn(r.generic) : f.dim('-')),
        f.ratingGiven(s.engine.cat, r.item, apt, r.rarity, r.generic) ?? f.dim('-'),
        f.num(r.score, 1),
        r.delta == null ? f.dim('-') : f.signedPct(r.delta),
      ]), { align: [null, null, null, 'r', null, null, null, 'r', 'r'] }));
    if (rows.length > limit) console.log(f.dim(`\n... ${rows.length - limit} more (--all to see them)`));
    console.log('\n' + f.auditBlock(s.engine));
  },

  optimize(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    const pins = applyProfile(s, loadout,
      applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved }));
    const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
    // Validated like every other number: `--restarts abc` used to make the
    // search loop run zero times and surface as a null dereference inside
    // optimize() rather than as a message.
    const restarts = s.numFlag('restarts', 3, { integer: true });

    const t0 = Date.now();
    const res = optimize(s.engine, {
      policy: s.policy ?? null,
      loadout, ...pins, goal: s.goal, weights: s.weights, target,
      rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
      exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap, pinnedSkills: pins.pinnedSkills,
      talentPoints: s.talentPoints,
      allowEmpty: !args.flags['no-empty'], restarts,
      onProgress: process.stderr.isTTY ? (n) => process.stderr.write(`\r  ${n} evaluations...`) : null,
    });
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(30) + '\r');

    console.log(f.header(s.engine, VERSION) + '\n');
    const goalLabel = s.weights
      ? Object.entries(s.weights).map(([k, v]) => `${k}x${v}`).join(' + ')
      : s.goal;
    console.log(`${f.bold(loadout.class + ' ' + s.level)} - maximising ${f.bold(goalLabel)} vs ${target.name}`);
    console.log(f.dim(`upgrade stars: ${s.stars === 'max' ? 'max for rarity' : s.stars}   `
      + `weapon mastery: ${s.rank === s.engine.ctx.consts.weaponSkillMaxRank
        ? `rank ${s.rank}, fully mastered` : `rank ${s.rank}`}   ` +
      `rarities: ${s.rarities ? [...s.rarities].join('/') : 'all'}   ` +
      `drop-rarity: ${s.rarityRoll ? 'rolled' : 'as authored'}` +
      (s.exclude ? `   excluding /${s.exclude.source}/` : '')));
    if (pins.pinnedGear.size || pins.pinnedAug.size) {
      console.log(f.dim(`pinned: ${[...pins.pinnedGear].map(f.short).join(', ') || '-'}` +
        (pins.pinnedAug.size ? `   sockets: ${[...pins.pinnedAug].map((k) => k.replace(/Slot_|Augment/g, '')).join(', ')}` : '') +
        (pins.pinnedInfusion.size ? `   infusions: ${[...pins.pinnedInfusion].map(f.short).join(', ')}` : '')));
    }
    // What the candidate lists left out, and on what evidence - a filter you
    // cannot see is a filter you cannot check.
    if (!args.flags['include-all']) {
      const src = s.engine.cat.sources();
      const gone = s.engine.cat.unreleasedItems().filter((x) => !x.item.isAugment);
      if (gone.length) {
        console.log(f.dim(`withheld: ${gone.length} stat-bearing rows nothing in this install hands out `
          + '(--include-all offers them; `bench audit` says how that was read)'));
      } else if (!src.prefabs.read || !src.code.read) {
        console.log(f.dim(`withheld: nothing - ${src.prefabs.why ?? src.code.why}, so no row could be shown to be unobtainable`));
      }
    }
    // The seeds are not all random. After `--restarts` random ones, the search
    // starts once from each secondary rating the class can wear, with every
    // armour slot filled by a piece that pays it - see `themeSeeds`. Saying
    // which seed won is the interesting half: "the ArmorPenetration set" is a
    // statement about the build, and "restart 2" is not.
    // The running commentary and the assumption list are the tool explaining
    // ITSELF, which is worth reading once and not on every run. `--verbose`
    // brings back the search trace, the per-line notes, the rotation's own
    // reasoning, and the audit.
    const verbose = !!args.flags.verbose;
    const won = res.trace.reduce((b, x) => (x.score > b.score ? x : b)).restart;
    if (verbose) {
      console.log(f.dim(`${res.evaluations} distinct loadouts evaluated in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `over ${res.trace.length} seeds (${restarts} random, ${res.trace.length - restarts} themed by rating) - ` +
        `best from ${typeof won === 'number' ? `restart ${won}` : `the ${won} set`}`));
    }
    console.log('');
    console.log(f.gearBlock(s.engine, res.loadout, {
      pinnedGear: pins.pinnedGear, indifferent: new Set(res.indifferent),
    }));
    if (verbose && res.indifferent.length) {
      console.log(f.dim(`  no effect: emptying ${res.indifferent.map(f.short).join(', ')} scores exactly the ` +
        `same for ${s.goal}.\n  The pick is the best of equals - a shield grants only armour, so a damage goal\n` +
        '  cannot tell one from another, or from none at all.'));
    }
    console.log('');
    {
      const ib = f.infusionBlock(s.engine, res.loadout, res.evaluation, { search: res.infusion, verbose });
      if (ib) console.log(f.bold('INFUSION') + '\n' + ib + '\n');
    }
    console.log(f.bold('AUGMENTS'));
    console.log(f.augmentBlock(s.engine, res.loadout, { pinnedAug: pins.pinnedAug }) + '\n');
    if (res.talentAlloc) {
      console.log(f.bold('TALENTS'));
      console.log(f.talentBlock(s.engine, res.loadout, res.talentAlloc, res.talentCoverage,
        { verbose }) + '\n');
    }
    console.log(f.bold('SKILLS'));
    console.log(f.skillsBlock(s.engine, res.loadout, res.evaluation,
      { pinnedSkills: pins.pinnedSkills, verbose }) + '\n');
    console.log(f.runeBlock(s.engine, res.loadout, res.evaluation) + '\n');
    console.log(f.sheetBlock(s.engine, res.evaluation, { level: s.level }));
    console.log(f.damageBlock(res.evaluation) + '\n');
    if (verbose) {
      console.log(f.throughputBlock(s.engine, res.evaluation, { goal: s.goal, authored: s.policyNote ?? null }) + '\n');
      // What the search bought over the seed, when the seed had anything in it.
      const seedScore = s.engine.makeScorer({ ...s, target, ref: res.reference }).scoreFrom(res.reference);
      if (seedScore > 0) {
        console.log(f.dim(`starting build scored ${f.num(seedScore, 2)}; this one scores ${f.num(res.score, 2)} ` +
          `(${f.signedPct(res.score / seedScore - 1)})`) + '\n');
      }
      console.log(f.auditBlock(s.engine));
    }

    if (typeof args.flags.json === 'string') {
      writeFileSync(args.flags.json, JSON.stringify({
        version: VERSION,
        cdbSha: s.engine.meta.cdbSha,
        bootSha: s.engine.meta.bootSha,
        // `target` is the name you can pass back to --target; `targetLabel` is
        // the sentence a reader needs. Recording only the label is what made
        // this file unreadable by the tool that wrote it.
        goal: s.goal, weights: s.weights,
        target: s.targetName, targetLabel: target.name,
        fervorScope: s.engine.opts.assume.fervorScope,
        tickSource: s.engine.opts.assume.tickSource,
        stars: s.stars, rank: s.rank, level: s.level, mix: s.mix,
        rarityRoll: s.rarityRoll,
        fight: s.fight.seconds, fights: s.fight.count, targets: s.fight.targets,
        targetHealth: s.fight.targetHealth,
        lookahead: s.fight.lookahead,
        pinned: {
          gear: [...pins.pinnedGear], augments: [...pins.pinnedAug], skills: [...pins.pinnedSkills],
          infusions: [...pins.pinnedInfusion],
          // The rune slots and the talent tree the run held (a --rune, a
          // --talent, an imported build's), so --build holds them again
          // rather than searching them anew.
          runes: [...pins.pinnedRunes], talents: pins.pinnedTalents,
        },
        // What the infusion search was allowed to do, so --build reproduces it.
        infusionSearch: { offered: res.infusion.offered, stat: res.infusion.statPolicy },
        build: res.loadout,
        // The sets the build wears and each piece's bonus line, as the engine
        // attached them: {sets: [{id, name, pieces, slots, rank, title,
        // priced[], fought[], unpriced[]}], pieces: [{slot, item, infusion,
        // stat, value, lit, prismatic, pool[]}]} - `priced` is what of the set
        // is in the number, `fought` what each part came to in this fight.
        infusions: res.evaluation.infusions,
        metrics: {
          dps: res.evaluation.throughput.dps,
          hps: res.evaluation.throughput.hps,
          sps: res.evaluation.throughput.sps,
          ehp: res.evaluation.survivability.ehp,
        },
        sheet: Object.fromEntries(res.evaluation.sheet),
        unmodelled: res.evaluation.throughput.unmodelled,
        assumptions: s.engine.audit,
      }, null, 2));
      console.log(f.dim(`\nwrote ${args.flags.json}`));
    }
  },

  rarity(args) {
    const s = commonSetup(args);
    const { cat } = s.engine;
    console.log(f.header(s.engine, VERSION) + '\n');

    console.log(f.bold('WHAT THE DATA SAYS'));
    console.log(f.table(
      ['RARITY', 'FLAGS', 'iLVL', 'MAX UPG', ...['1-10', '11-30', '31-49', '50+'].map((b) => 'drop ' + b)],
      s.engine.cdb.lines('rarity').map((r) => [
        r.id,
        cat.cdb.flagNames('rarity', 'flags', r.flags).join(',') || f.dim('-'),
        r.props?.iLevelBonus != null ? '+' + r.props.iLevelBonus : f.dim('-'),
        r.props?.gearUpgrades ?? f.dim('-'),
        ...[[1, 10], [11, 30], [31, 49], [50, 10000]].map(([lo, hi]) => {
          const b = (r.props?.generationChance ?? []).find((x) => x.minLevel === lo && x.maxLevel === hi);
          return b ? (b.chance ? f.pct(b.chance, 0) : f.dim('0')) : f.dim('-');
        }),
      ]), { align: [null, null, 'r', 'r', 'r', 'r', 'r', 'r'] }));

    console.log('\n' + f.bold('CEILING PER SLOT') + f.dim(`   at level ${s.level}`));
    console.log(f.table(['SLOT', 'KIND', 'CEILING', 'REACHABLE HERE', 'DERIVED FROM'],
      cat.combatSlots().map((slot) => {
        const c = cat.rarityCeiling(slot.id);
        const sample = cat.candidates(slot.id, {
          aptitude: cat.classes[0].aptitude, charLevel: s.level, rarityRoll: true, exclude: s.exclude,
        });
        const seen = [...new Set(sample.map((x) => x.rarity))]
          .sort((a, b) => (cat.rarityOrder.get(a) ?? 0) - (cat.rarityOrder.get(b) ?? 0));
        const above = seen.filter((r) => (cat.rarityOrder.get(r) ?? 0) > (cat.rarityOrder.get(c.rarity) ?? 0));
        return [f.short(slot.id), cat.isWeaponSlot(slot.id) ? 'weapon' : 'gear',
          f.bold(c.rarity),
          seen.map((r) => (above.includes(r) ? f.warn(r + '*') : r)).join(', '),
          f.dim(c.why)];
      })));

    // WHICH COLUMNS SPEAK OF RARITY is read off the schema, every run. This
    // paragraph used to be typed: "no column anywhere declares a rarity
    // ceiling, the seven columns typed on rarity are ..." - and went on saying
    // so on a build with eleven, two of which are exactly a floor and a
    // ceiling. st.skill.GainItem.onStartStep@32109 ops 99-110 copies a
    // container's `gainItem.rarity.min` / `.max` onto every loot entry it
    // opens, and ent.Hero.makeLootItem@7953 ops 140-167 rolls inside them.
    const cdb = s.engine.cdb;
    const rarityCols = [];
    for (const [name, sh] of cdb.sheets) {
      for (const c of sh.columns ?? []) if (c.typeStr === '6:rarity') rarityCols.push(`${name}.${c.name}`);
    }
    const BOUNDS = ['item@props@gainItem@rarity.min', 'item@props@gainItem@rarity.max'];
    const bounds = BOUNDS.filter((c) => rarityCols.includes(c));
    const boxes = cdb.lines('item').filter((i) => i.props?.gainItem?.rarity?.min != null || i.props?.gainItem?.rarity?.max != null);
    const lootTableCols = rarityCols.filter((c) => /^lootTable(@|\.)/.test(c));
    const rarityTypes = [...cdb.customTypes.keys()].filter((k) => /rarity/i.test(k));
    // What a constant holds, as the kinds of its leaves - `range`, `float`...
    const leafKinds = (v, out = new Set()) => {
      if (Array.isArray(v)) for (const x of v) leafKinds(x, out);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'group') leafKinds(x, out);
          else if (k === 'v') leafKinds(x, out);
          else if (k !== 'id' && k !== 'desc') out.add(k);
        }
      }
      return out;
    };
    const stub = cdb.has('constant', 'WeaponRarityChances_Low') ? cdb.row('constant', 'WeaponRarityChances_Low') : null;
    const stubKinds = stub ? [...leafKinds(stub.v)] : [];
    const wrap = (text) => {
      const lines = [];
      let line = ' ';
      for (const word of text.split(/\s+/).filter(Boolean)) {
        if (line.length + 1 + word.length > 76 && line.trim()) { lines.push(line); line = ' '; }
        line += ' ' + word;
      }
      if (line.trim()) lines.push(line);
      return lines.join('\n');
    };
    const para = [];
    para.push(`${rarityCols.length} columns are typed on \`rarity\`: ${rarityCols.join(', ')}.`);
    if (bounds.length) {
      para.push(`${bounds.length === 2 ? 'Two' : 'One'} of them bound${bounds.length === 2 ? '' : 's'} a roll: ${bounds.join(' and ')} - `
        + 'a CONTAINER\'s own floor and ceiling, copied onto every loot entry it opens '
        + '(st.skill.GainItem.onStartStep@32109) and rolled inside (ent.Hero.makeLootItem@7953). '
        + (boxes.length
          ? `${boxes.length === 1 ? 'One row authors' : `${boxes.length} rows author`} it: `
            + boxes.map((i) => `${i.texts?.name ?? i.id} (${i.id}) - `
              + `${i.props.gainItem.rarity.min != null ? `floor ${i.props.gainItem.rarity.min}` : 'no floor'}, `
              + `${i.props.gainItem.rarity.max != null ? `ceiling ${i.props.gainItem.rarity.max}` : 'no ceiling'}`).join('; ') + '.'
          : 'No row authors either on this build.'));
    }
    para.push(`${bounds.length ? 'Beyond that, no' : 'No'} column declares a ceiling for a slot or for an item row. `
      + (lootTableCols.length ? `\`lootTable\` does carry rarity (${lootTableCols.join(', ')}), which this bench does not read. `
        : '`lootTable` carries no rarity column at all. ')
      + (rarityTypes.length ? `There is a custom type named for it (${rarityTypes.join(', ')}), also unread. `
        : 'There is no rarity custom type. ')
      + (stub
        ? `\`WeaponRarityChances_Low\` exists as a constant and holds ${stubKinds.length ? `only ${stubKinds.join(' and ')} leaves` : 'nothing'}`
          + `${stubKinds.some((k) => /float|int|chance/i.test(k)) ? ' - it may no longer be the stub it was; read it' : ' - a level range and no chance'}.`
        : ''));
    console.log('\n' + f.warn('WHAT THE DATA DOES NOT SAY'));
    console.log(para.map(wrap).join('\n\n'));
    console.log([
      '',
      '  So a WEAPON\'s ceiling is set where its loot entry is made - by its',
      '  container\'s bounds where it has one, in code everywhere else - and',
      '  ent.Hero.makeLootItem@7953 rolls inside whatever the entry carries. The',
      '  AllowRandomWeaponDrop flag stands in for that ceiling; --rarity-cap',
      '  overrides it. A weapon\'s ROLL share is its level band\'s chance over the',
      '  sum of the rarities at or above its row\'s, the way the game draws it.',
      '  GEAR does not roll at all (the same function skips everything that is',
      '  not a Weapon): its "ceiling" is only the highest rarity AUTHORED on a',
      '  stat-bearing row this install hands out, and a piece keeps its row\'s.',
    ].join('\n'));
  },

  targets(args) {
    const s = commonSetup(args);
    const { combat, cdb } = s.engine;
    const [a, b] = s.engine.ctx.consts.resistFormula;
    const maxLevel = Math.round(s.engine.ctx.consts.maxLevel);
    // Damage that gets through, at a given penetration.
    const through = (armor, pen) => {
      const r = armor * (1 - pen / 100);
      return 1 - r / (r + a + b * s.level);
    };
    const unitName = (id) => cdb.byId('unit').get(id)?.texts?.name ?? null;
    // Two answers in one column: `immune` is isCCImmune (nothing lands),
    // `no stun` a unit that is not immune and still refuses a stun, `lands`
    // neither. An archetype's is a census of its heirs, not a flag it carries.
    const cc = (t) => (t.ccImmune ? 'immune' : t.stunImmune ? 'no stun' : 'lands')
      + (/^assumed/.test(t.ccImmune ? t.ccImmuneWhy : t.stunImmuneWhy) ? '*' : '');

    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`What the world resists at level ${s.level}, and what penetration buys against it.\n`);
    console.log(f.table(
      ['TARGET', 'WHAT', 'PHYS', 'MAG', 'LEVEL', 'ARMOUR', 'NO PEN', '25% PEN', '50% PEN', 'GAIN @50%', 'CC'],
      combat.foes.map((n) => {
        const t = combat.foe(n, s.level);
        const named = combat.namedTargets[n];
        const base = through(t.armor, 0);
        return [
          n, t.unit ? `${named.label} (${t.unit})` : named.label,
          f.pct(t.physReduction, 0), f.pct(t.magicReduction, 0),
          f.num(t.spawnLevel, Number.isInteger(t.spawnLevel) ? 0 : 1), f.num(t.armor, 0),
          f.pct(base), f.pct(through(t.armor, 25)), f.pct(through(t.armor, 50)),
          t.armor > 0 ? f.signedPct(through(t.armor, 50) / base - 1, 1) : f.dim('-'),
          cc(t),
        ];
      }), { align: [null, null, 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', null] }));
    console.log(f.dim([
      '  PHYS / MAG is what the unit row authors: the reduction it would be at its own level.',
      '  ARMOUR is the pool the game builds from it at LEVEL, and the PEN columns are what gets',
      `  through to a level-${s.level} striker. CC: \`immune\` refuses every crowd control (the unit`,
      '  flags a skill reads as isCCImmune); `no stun` is not immune - a root or a slow lands -',
      '  and still refuses a stun (unit flag NoStun); `lands` takes all of it. * is assumed from',
      '  the units built on that archetype, not read off a unit (bench audit has the counts).',
    ].join('\n')));

    // The heroic bosses, each as the unit its row says in Normal and as its
    // heroic rows at MaxLevel - the two things `--target <id>` and
    // `--target <id>@heroic` price.
    if (combat.heroicBosses.length) {
      console.log('\n' + f.bold('HEROIC') + f.dim(`  the ${combat.heroicBosses.length} bosses that author a heroic loot table in a dungeon whose Heroic is released:`
        + `\n  the unit row in Normal, the heroic rows at level ${maxLevel} in Heroic`));
      const side = (t) => [
        `${f.pct(t.physReduction, 0)}${t.magicReduction !== t.physReduction ? ' / ' + f.pct(t.magicReduction, 0) : ''}`,
        f.num(t.spawnLevel, Number.isInteger(t.spawnLevel) ? 0 : 1), f.num(t.armor, 0), f.pct(through(t.armor, 0)),
      ];
      console.log(f.table(
        ['UNIT', 'NAME', 'NORMAL', 'LVL', 'ARMOUR', 'NO PEN', 'HEROIC', 'LVL', 'ARMOUR', 'NO PEN'],
        combat.heroicBosses.map((id) => [
          id, unitName(id) ?? f.dim('(no name)'),
          ...side(combat.foe(id, s.level)), ...side(combat.foe(`${id}@heroic`, s.level)),
        ]), { align: [null, null, 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'] }));
      const named = combat.heroicNamed;
      console.log(f.dim(`  \`--target heroic\` is the Heroic column: ${named.share} of ${named.of} resolve the same row`
        + (named.share === named.of ? '.' : `, and the shortcut stands on ${named.unit}.`)
        + ' `--target <unit>@heroic` names one.'));
      // Authored ahead of the mode: the loot table is wired, the dungeon's
      // level file keeps Heroic shut - not a target anyone meets yet.
      for (const x of combat.heroicAhead ?? []) {
        console.log(f.dim(`  not listed: ${x.id} (${unitName(x.id) ?? 'no name'}) authors a heroic loot table, and ${x.why}`));
      }
      for (const x of combat.heroicUnjudged ?? []) {
        console.log(f.dim(`  listed although unread: ${x.id} - ${x.why}`));
      }
    }

    console.log(f.dim(`\n  ${combat.targetsByUnit.size} units resolve an armour intent through inheritance, ` +
      'so --target also\n  accepts any unit id directly.'));

    // Every count below is taken off the rows as the sentence is printed.
    const units = cdb.lines('unit');
    const isArmourRow = (st) => st.specScaling?.armorReduction != null || st.specScaling?.magicReduction != null;
    const declarers = units.filter((u) => (u.stats ?? []).some((st) => st.heroic !== true && isArmourRow(st)));
    const heroicOnly = units.filter((u) => !declarers.includes(u)
      && (u.stats ?? []).some((st) => st.heroic === true && isArmourRow(st)));
    const bossOwn = declarers.filter((u) => combat.unitFlags(u.id).includes('Boss')).map((u) => u.id);
    // Who splits physical from magical, and why - the model's own list, so the
    // prose and the audit cannot disagree about what a golem is.
    const golems = combat.armourSplits.byStub.map((id) => [id, combat.targetsByUnit.get(id)]);
    const splitOther = combat.armourSplits.authored.map((id) => [id, combat.targetsByUnit.get(id)]);
    const wrap = (parts, sep, width, indent) => {
      const lines = [];
      let cur = '';
      for (const part of parts) {
        const next = cur ? `${cur}${sep}${part}` : part;
        if (next.length > width && cur) { lines.push(cur); cur = part; } else cur = next;
      }
      if (cur) lines.push(cur);
      // A list breaks after its comma; a comparison carries its sign down.
      const list = sep.trim() === ',';
      return lines.map((l, i) => indent + (i && !list ? `  ${sep.trim()}  ` : '') + l
        + (list && i < lines.length - 1 ? ',' : '')).join('\n');
    };
    // The archetype ladder, off the rows: every row that authors a reduction
    // and that other units are built from, by what it authors.
    const isParent = new Set(units.flatMap((u) => (u.inherit ?? [])
      .filter((i) => !i?.textOnly && i?.ref).map((i) => i.ref)));
    const ownRed = (u) => (u.stats ?? [])
      .find((st) => st.heroic !== true && st.specScaling?.armorReduction != null)?.specScaling.armorReduction ?? null;
    const tiers = new Map();
    for (const u of declarers) {
      const r = ownRed(u);
      if (r == null || u.lvl != null || !isParent.has(u.id)) continue;
      if (!tiers.has(r)) tiers.set(r, []);
      tiers.get(r).push(u.id);
    }
    const ladder = [...tiers].sort((x, y) => x[0] - y[0]).map(([r, ids]) => `${ids.join(' / ')} ${r.toFixed(2)}`);
    const bossReds = [...new Set(bossOwn.map((id) => ownRed(cdb.byId('unit').get(id))))].sort();
    // The row whose Armor is a bare multiplier, and the units it lands on.
    const { stubOwners } = combat.armourSplits;
    // A boss whose row stands below the character, to show what a unit id prices.
    const low = bossOwn.map((id) => combat.foe(id, s.level)).find((t) => t.spawnLevel < s.level);
    const dummy = combat.foe('dummy', s.level);
    // A level-less row that some unit summons, found by shape, to show where
    // a summon stands.
    const summon = [...combat.targetsByUnit.keys()]
      .filter((id) => cdb.byId('unit').get(id).lvl == null && combat.summonersOf(id).length)
      .map((id) => combat.foe(id, s.level))
      .find((t) => /^summoned: /.test(t.levelWhy));
    const ref = combat.foe('reference', s.level);
    const boss = combat.foe('boss', s.level);
    const gain = (t) => f.signedPct(through(t.armor, 50) / through(t.armor, 0) - 1, 1);

    console.log('\n' + f.bold('WHERE THESE COME FROM'));
    console.log([
      '  `unit.stats[].specScaling.armorReduction` and `.magicReduction`. Foes',
      '  express armour as a target damage REDUCTION, exactly the way the four',
      `  classes do, and the game turns that intent into a pool at the unit's level.`,
      `  ${declarers.length} units author one` + (heroicOnly.length ? ` (${heroicOnly.length} more only in Heroic)` : '')
        + ' and the rest inherit it,',
      '  so nothing here is invented.',
      '',
      '  A unit resolves ONE armour row: its own when it authors one, the nearest',
      '  inherited otherwise - a child\'s row replaces its parent\'s, it does not add',
      '  to it. So the ladder the world is built on is the ladder the table shows:',
      '',
      wrap(ladder, '  <  ', 66, '    '),
      '',
      `  and ${bossOwn.length} bosses author a row of their own, at ${bossReds.map((r) => r.toFixed(2)).join(' / ')}:`,
      wrap(bossOwn, ', ', 66, '    '),
      '',
      f.bold('  What follows, and matters for gearing:'),
      '',
      `  * Physical and magical reduction are EQUAL on every foe but the ${golems.length} units`,
      `    that inherit ${stubOwners.join(' / ') || '(none)'} - an Armor multiplier with no MagicArmor twin, so a`,
      '    golem is harder to hit than to burn' + (golems.length
        ? ` (${golems[0][0]}: ${f.pct(golems[0][1].phys, 0)} / ${f.pct(golems[0][1].mag, 0)}).` : '.'),
      ...(splitOther.length ? [
        '    The only other rows that split them author it outright:',
        wrap(splitOther.map(([id, i]) => `${id}${unitName(id) ? ` ("${unitName(id)}")` : ''} ${f.pct(i.phys, 0)} / ${f.pct(i.mag, 0)}`),
          ', ', 64, '      ') + '.',
      ] : []),
      '    Against everything else ArmorPenetration and SpellPenetration are worth',
      '    the same, and which one you want is decided by your class and your',
      '    gear\'s faction, not by the fight.',
      '',
      `  * Armor_ExpectedReduction (${cdb.constant('Armor_ExpectedReduction')}) is well below what you actually fight, so`,
      `    it understates penetration against a boss - ${gain(ref)} against ${gain(boss)} at`,
      '    50% penetration. That is why the default target is a boss and not that',
      '    constant.',
      '',
      '  * A foe\'s pool is built at ITS level and divided at YOURS, so a foe below',
      '    you mitigates less than its row says. The archetype shortcuts (trash to',
      '    dungeon) stand at your own level; `dummy` and `heroic` stand where the',
      '    table says. A unit id stands where its row puts it in Normal',
      '    difficulty' + (low
        ? `: \`--target ${low.unit}\` is level ${low.spawnLevel}, ${f.pct(1 - through(low.armor, 0))} to you.` : '.'),
      `    \`<target>@veteran\` and \`<target>@heroic\` stand it at level ${maxLevel}, where those`,
      '    difficulties spawn everything (Heroic also reads the heroic rows);',
      '    `<target>@scaled` builds the pool at your level, which is what a rift does',
      '    to whatever stands in it. `--target-level <n>` overrides any of them.',
      '',
      `  * The training dummy is not a zero any more. Its row authors ${f.pct(dummy.physReduction, 0)} / ${f.pct(dummy.magicReduction, 0)}`,
      `    and it stands at level ${dummy.spawnLevel}, so a level-${s.level} character loses ${f.pct(1 - through(dummy.armor, 0))} on it.`,
      '    `none` is the target that mitigates nothing.',
      '',
      ...(summon ? [
        '  * A unit with no level on its row that something SUMMONS stands at its',
        '    summoner\'s level, not at 1:',
        `    \`--target ${summon.unit}\` is level ${f.num(summon.spawnLevel, Number.isInteger(summon.spawnLevel) ? 0 : 1)}, summoned by`,
        wrap(combat.summonersOf(summon.unit), ', ', 64, '    ') + '.',
        '',
      ] : []),
      f.dim('  Not read: which activity a unit stands in, and the few spawners that name a'),
      f.dim('  level - both ship in the level prefabs, not in data.cdb. A summoned row that'),
      f.dim('  authors a level of its own is priced at that row (bench audit names them).'),
      f.dim('  Not modelled: unitType.props.resistance is an affinity-level resistance'),
      f.dim('  hook and only Bee uses it (Honey), so it is inert.'),
    ].join('\n'));
  },

  talents(args) {
    const s = commonSetup(args);
    const T = s.engine.talents;
    const want = typeof args.flags.class === "string"
      ? resolve(args.flags.class, s.engine.cat.classes.flatMap((c) => [c.unit, c.aptitude]), "class")
      : null;
    console.log(f.header(s.engine, VERSION) + "\n");

    const classes = want
      ? s.engine.cat.classes.filter((c) => c.unit === want || c.aptitude === want)
      : s.engine.cat.classes;
    for (const c of classes) {
      const tree = T.treeFor(c.unit);
      const readable = tree.nodes.filter((n) => T.readableValue(n.skill).readable);
      console.log(f.bold(c.unit + " - " + tree.nodes.length + " nodes, " + readable.length +
        " this model can read, " + T.pointsAt(s.level) + " points at level " + s.level));
      // Which nodes are the PREREQUISITE for another one. A node that reads as
      // nothing on its own is not necessarily a dead point: Rage Shield's whole
      // value in this model is that Hold the Line waits on the status it
      // applies, and printing "nothing" beside it without saying so is the
      // table telling you to skip the node the branch is built on.
      const neededBy = new Map();
      for (const n of tree.nodes) {
        const alone = T.readableValue(n.skill, 1, { have: new Set([n.skill]) });
        for (const d of alone.needs ?? []) {
          const owner = tree.nodes.find((x) => T.readableValue(x.skill, 1).granted?.includes(d.needs))
            ?? tree.nodes.find((x) => d.needs.startsWith(x.skill));
          if (!owner) continue;
          if (!neededBy.has(owner.skill)) neededBy.set(owner.skill, []);
          neededBy.get(owner.skill).push(n.name);
          n.waitsOn = owner.name;
        }
      }
      console.log(f.table(["  TIER", "BRANCH", "TALENT", "READS AS", "WHAT"],
        tree.nodes.map((n) => {
          const v = T.readableValue(n.skill);
          const wanted = neededBy.get(n.skill);
          return ["  " + n.tier, n.branch, n.name,
            v.readable ? f.bold(v.kind) : f.dim("nothing"),
            (n.waitsOn ? f.dim(`only while ${n.waitsOn} is up; `) : '')
            + (wanted ? f.dim(`${wanted.join(' and ')} need${wanted.length > 1 ? '' : 's'} it; `) : '')
            + (v.affixes.length ? f.affixSummary(v.affixes)
              : v.buffs.length ? v.buffs.map((x) => x.name + " x" + x.stacks).join(", ")
                : v.effects.length ? v.effects.map((x) => x.kind).join(", ")
                  // A node read off its SCRIPT declares none of the three, and
                  // the column must not say "nothing" beside what it reads as.
                  : f.dim(v.readable ? "its script - no affix, effect or Status step in the row"
                    : "no affix, no effect, no status"))];
        })));
      console.log("");
    }

    console.log(f.bold("RULES") + f.dim("   every one of them out of the data"));
    console.log([
      "  tier thresholds  " + T.thresholds.map((v, i) => "t" + i + "=" + v).join("  "),
      "                   points needed AT LOWER TIERS in that branch, root included",
      "  unlock level     " + T.unlockLevel,
      "  points at cap    " + T.defaultPointsAtCap + "   (observed - no constant declares the rate)",
      "  points per node  1 or 2 - props.talent.maxPoints, and it is 2 on 48 of 88",
      "  DemonSigil       grants one tier-4 talent outright: costs no point, and does",
      "                   not count toward its branch thresholds",
    ].join("\n"));

    console.log("\n" + f.warn("WHY THIS IS MOSTLY STRUCTURE"));
    const all = s.engine.cat.classes.flatMap((c) => T.treeFor(c.unit).nodes);
    const rd = all.filter((n) => T.readableValue(n.skill).readable);
    // Counted at print time, like the rune figures below. The sentence this
    // replaced carried a hand count ("72 of them DO ship an hscript body")
    // that had come to exceed the number it was a part of.
    const unreadScripted = all.filter((n) => !T.readableValue(n.skill).readable
      && T.readableValue(n.skill).hasScript).length;
    console.log([
      "  " + rd.length + " of " + all.length + " talent nodes declare something this model reads - a stat affix,",
      "  a self-buff status, a damage effect, or one of the script shapes the fight",
      "  plays (a scoped modifier, a pool, a status on a named event, a rider on a",
      "  status's own hits, cooldown handed to a named skill). The other " + (all.length - rd.length) + " read as",
      "  nothing here: " + unreadScripted + " of them ship an hscript body the readers behind this",
      "  table do not take (the fight scores a few of those through readers of",
      "  its own - a next-cast register, the Mage's chain), and the rest declare",
      "  nothing at all. So what is left of the talent layer is blocked on script",
      "  shapes, not on absent data. Every one of the " + all.length + " nodes also carries a",
      "  texts.desc to check an implementation against.",
      "",
      "  So the optimiser allocates points over the readable nodes and STOPS. It",
      "  does not spend the remainder on nodes it cannot tell apart, because a",
      "  build assembled that way would look authoritative and be arbitrary. The",
      "  one point it does put in such a node is a GATE POINT: a tier it takes",
      "  something from stands on it, and the table tags it. A point bought",
      "  toward a tier the budget then does not reach is taken back. The unspent",
      "  points are reported rather than quietly filled.",
      "",
    ].join("\n"));

    // Every figure below is counted from the sheet at print time. The line this
    // replaced said "17 of 84" from a stale hand count; the data says 26 through
    // steps and props alone, and 31 once mastery-gated affixes are read too.
    const rc = T.runeCoverage();
    console.log([
      f.bold("  Runes are the same shape.") + ` ${rc.skillsWithRunes} skills offer a choice, ` +
        `${rc.total} runes in all, and ${rc.readable} of them`,
      "  declare something this model reads:",
      `    ${String(rc.gatesSteps).padStart(3)}  gate a step        steps[].cond.mastery`,
      `    ${String(rc.excludesSteps).padStart(3)}  suppress a step    steps[].cond.masteryExclude`,
      `    ${String(rc.overridesProps).padStart(3)}  override a prop    mastery[].props (${rc.overrideKeys.join(", ")})`,
      `    ${String(rc.gatesAffixes).padStart(3)}  gate a stat affix  affixes[].conds.mastery`,
      "  The sets barely overlap, and the gates are not local: three gated steps sit",
      "  on a *_Status row while the rune that gates them is declared on the ability",
      `  that applies it, so the count is taken over the whole sheet. The other ${rc.total - rc.readable}`,
      "  promise things in their own description that live in code.",
    ].join("\n"));
  },

  /**
   * The full build for every ORDERED (mainhand, arsenal) pair.
   *
   * `weapons --pairs` answers the same pairing question on a pinned stat rig -
   * fast, comparable, and wearing no armour. This is the expensive sibling:
   * both weapon slots pinned per cell and EVERYTHING else searched for real -
   * every armour slot, the offhand, every enchant and gem socket, the arsenal
   * skills, the sixteen talent points and the runes - so each pair gets the
   * layout a player would actually wear with it. (A main, B arsenal) and
   * (B main, A arsenal) are different builds with different rotations, and
   * both are here.
   *
   * The cost is stated up front rather than discovered: pairs x a full
   * optimize each. --main / --arsenal narrow the sweep, --restarts trades
   * depth for time, --json records every layout, --show prints the top N in
   * full.
   */
  layouts(args) {
    const s = commonSetup(args);
    const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
    const base = loadBuild(args, s.engine, s.level, s.saved);
    const cls = s.engine.cat.classes.find((c) => c.unit === base.class);
    const restarts = s.numFlag('restarts', 3, { integer: true });
    // 0 is a legitimate ask here - the summary table alone - so this one is
    // not run through numFlag's positive check.
    const show = args.flags.show != null && args.flags.show !== true
      ? Math.max(0, Math.trunc(Number(args.flags.show))) : 1;
    if (Number.isNaN(show)) die('--show needs a number of layouts');

    const candidatesFor = (slotId) => {
      // One entry per item, at its BEST attainable rarity - the same "assume
      // the good version" default a pin gets, or the sweep would quietly
      // compare every weapon at its weakest roll.
      const bestOf = new Map();
      for (const c of s.engine.cat.candidates(slotId, {
        aptitude: cls.aptitude, charLevel: s.level, rarities: s.rarities,
        exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
      })) {
        const held = bestOf.get(c.item.id);
        if (!held || (s.engine.cat.rarityOrder.get(c.rarity) ?? -1)
          > (s.engine.cat.rarityOrder.get(held.rarity) ?? -1)) {
          bestOf.set(c.item.id, c);
        }
      }
      return [...bestOf.values()];
    };
    const filterBy = (list, flag) => {
      if (typeof args.flags[flag] !== 'string') return list;
      const re = new RegExp(args.flags[flag], 'i');
      const out = list.filter((c) => re.test(c.item.id) || re.test(c.item.name ?? ''));
      if (!out.length) die(`--${flag} ${args.flags[flag]} matches no weapon for this class`);
      return out;
    };
    const mains = filterBy(candidatesFor('Slot_Weapon1'), 'main');
    const arsenals = filterBy(candidatesFor('Slot_Weapon2'), 'arsenal');
    const gearFor = (c) => ({
      item: c.item.id, rarity: c.rarity, generic: c.generic ?? null,
      stars: s.stars === 'max' ? s.engine.cat.maxStars(c.item, c.rarity)
        : Math.min(s.stars, s.engine.cat.maxStars(c.item, c.rarity)),
    });

    const pairs = [];
    for (const m of mains) {
      for (const a of arsenals) {
        if (a.item.id === m.item.id) continue;
        pairs.push([m, a]);
      }
    }
    if (!pairs.length) die('no legal (mainhand, arsenal) pairs to sweep');

    // Every pair's full report goes to DISK as it completes, not to RAM:
    // a 200-pair sweep holds hundreds of full evaluations otherwise, and a
    // sweep is exactly the run long enough to want reading before it ends.
    // Each file is an `optimize --json`-shaped envelope, so `--build` reads
    // any one of them back directly; `index.json` is rewritten per pair with
    // the ranking so far. A pair whose file already exists is SKIPPED, which
    // is what turns a crash, a Ctrl+C or a bigger --restarts into a resume
    // instead of a restart - `--fresh` recomputes everything.
    const outDir = typeof args.flags.out === 'string' ? args.flags.out
      : `bench-layouts-${base.class}-${s.goal}`;
    mkdirSync(outDir, { recursive: true });

    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`${f.bold(base.class + ' ' + s.level)} - the best full layout for every ordered ` +
      `(mainhand, arsenal) pair, by ${f.bold(s.goal)} vs ${target.name}`);
    console.log(f.dim(`  ${mains.length} mainhands x ${arsenals.length} arsenals = ${pairs.length} pairs, ` +
      `each a full optimize (${restarts} restart${restarts === 1 ? '' : 's'}) over armour, offhand, ` +
      'augments, arsenal skills, talents and runes'));
    console.log(f.dim(`  reports land in ${outDir}/ as they finish - index.json is the ranking so far, ` +
      'each pair file reloads with --build, and an existing file resumes instead of recomputing'));

    const envelopeOf = (m, a, res) => ({
      version: VERSION, cdbSha: s.engine.meta.cdbSha, bootSha: s.engine.meta.bootSha,
      goal: s.goal, weights: s.weights, target: s.targetName, targetLabel: target.name,
      fervorScope: s.engine.opts.assume.fervorScope,
      tickSource: s.engine.opts.assume.tickSource,
      stars: s.stars, rank: s.rank, level: s.level, mix: s.mix,
      rarityRoll: s.rarityRoll,
      fight: s.fight.seconds, fights: s.fight.count, targets: s.fight.targets,
      targetHealth: s.fight.targetHealth,
      lookahead: s.fight.lookahead, restarts,
      main: m.id, mainName: m.name, arsenal: a.id, arsenalName: a.name,
      // The offhand is SEARCHED, not pinned - a one-handed mainhand gets the
      // best shield the goal can price, skills included - and it belongs in
      // the summary or the choice reads as if it never happened.
      offhand: res.loadout.gear?.Slot_OffhandWeapon?.item ?? null,
      score: res.score,
      pinned: { gear: ['Slot_Weapon1', 'Slot_Weapon2'], augments: [], skills: [] },
      build: res.loadout,
      metrics: {
        dps: res.evaluation.throughput.dps,
        hps: res.evaluation.throughput.hps,
        sps: res.evaluation.throughput.sps,
        ehp: res.evaluation.survivability.ehp,
      },
      unmodelled: res.evaluation.throughput.unmodelled,
    });
    // What survives in memory per pair: one summary row. The full evaluation
    // is kept only for the --show best, in a list that never exceeds --show.
    const rows = [];
    const keep = [];
    const fileFor = (m, a) => join(outDir, `${m.id}__${a.id}.json`);
    const writeIndex = () => {
      rows.sort((x, y) => y.score - x.score);
      writeFileSync(join(outDir, 'index.json'), JSON.stringify({
        version: VERSION, cdbSha: s.engine.meta.cdbSha, bootSha: s.engine.meta.bootSha,
        goal: s.goal, target: s.targetName, targetLabel: target.name,
        level: s.level, rank: s.rank, restarts,
        done: rows.length, of: pairs.length,
        pairs: rows,
      }, null, 2));
    };

    const t0 = Date.now();
    let resumed = 0;
    for (let i = 0; i < pairs.length; i++) {
      const [m, a] = pairs[i];
      if (process.stderr.isTTY) {
        const done = i, left = pairs.length - i;
        const eta = done > 0 ? Math.round(((Date.now() - t0) / done) * left / 1000) : null;
        const mb = Math.round(process.memoryUsage().rss / 1048576);
        process.stderr.write(`\r  ${i + 1}/${pairs.length}  ${m.item.id} / ${a.item.id}` +
          `${eta != null ? `  ~${eta}s left` : ''}  ${mb}MB        `);
      }
      const file = fileFor(m.item, a.item);
      if (!args.flags.fresh && existsSync(file)) {
        try {
          const env = JSON.parse(readFileSync(file, 'utf8'));
          rows.push({
            main: m.item.id, mainName: m.item.name ?? m.item.id,
            arsenal: a.item.id, arsenalName: a.item.name ?? a.item.id,
            score: env.score, metrics: env.metrics,
            offhand: env.build?.gear?.Slot_OffhandWeapon?.item ?? null,
            arsSkills: env.build?.skills?.Slot_Weapon2 ?? [],
            talentCount: Object.keys(env.build?.talents ?? {}).length,
            file,
          });
          resumed++;
          continue;
        } catch { /* unreadable checkpoint: recompute it */ }
      }
      const loadout = { ...base, gear: {}, augments: {}, skills: {}, runes: {}, talents: {} };
      loadout.gear.Slot_Weapon1 = gearFor(m);
      loadout.gear.Slot_Weapon2 = gearFor(a);
      try {
        const res = optimize(s.engine, {
      policy: s.policy ?? null,
          loadout, pinnedGear: new Set(['Slot_Weapon1', 'Slot_Weapon2']), pinnedAug: new Set(),
          goal: s.goal, weights: s.weights, target,
          rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
          exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
          talentPoints: s.talentPoints, allowEmpty: true, restarts,
        });
        writeFileSync(file, JSON.stringify(envelopeOf(m.item, a.item, res), null, 2));
        rows.push({
          main: m.item.id, mainName: m.item.name ?? m.item.id,
          arsenal: a.item.id, arsenalName: a.item.name ?? a.item.id,
          score: res.score,
          metrics: envelopeOf(m.item, a.item, res).metrics,
          offhand: res.loadout.gear?.Slot_OffhandWeapon?.item ?? null,
          arsSkills: res.loadout.skills?.Slot_Weapon2 ?? [],
          talentCount: Object.keys(res.loadout.talents ?? {}).length,
          file,
        });
        // Only the --show best keep their full evaluation in memory.
        keep.push({ score: res.score, main: m.item, ars: a.item, res });
        keep.sort((x, y) => y.score - x.score);
        if (keep.length > Math.max(1, show)) keep.pop();
        writeIndex();
      } catch { /* a pair this class cannot legally hold */ }
    }
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(70) + '\r');
    rows.sort((x, y) => y.score - x.score);
    writeIndex();
    if (typeof args.flags.json === 'string') {
      // The single-file container, assembled from the per-pair files so it
      // costs no memory during the sweep.
      writeFileSync(args.flags.json, JSON.stringify({
        version: VERSION, goal: s.goal, target: s.targetName, level: s.level,
        pairs: rows.map((r) => {
          try { return JSON.parse(readFileSync(r.file, 'utf8')); } catch { return r; }
        }),
      }, null, 2));
    }

    const best = rows[0]?.score ?? 0;
    console.log('');
    console.log(f.table(
      [s.goal.toUpperCase(), 'VS BEST', 'MAIN HAND', 'OFFHAND', 'ARSENAL', 'ARSENAL SKILLS', 'TALENTS'],
      rows.map((r) => [
        f.num(r.score, 1),
        r.score >= best ? f.bold('best') : f.signedPct(r.score / best - 1),
        r.mainName,
        r.offhand ? f.short(r.offhand) : f.dim('-'),
        r.arsenalName,
        (r.arsSkills ?? []).map(f.short).join(', ') || f.dim('-'),
        r.talentCount + ' nodes',
      ]),
      { align: ['r', 'r', null, null, null, null, null] },
    ));
    console.log(f.dim(`  ${rows.length} of ${pairs.length} pairs legal`
      + (resumed ? `, ${resumed} resumed from ${outDir}` : '')
      + `, ${((Date.now() - t0) / 1000).toFixed(1)}s`));

    // The full blocks for the best pairs COMPUTED THIS RUN. A resumed pair's
    // report lives in its file; reprinting it exactly means re-running its
    // optimize, which is what --fresh is for.
    for (const k of keep.slice(0, Math.max(0, show))) {
      console.log('\n' + '='.repeat(78));
      console.log(f.bold(`${k.main.name ?? k.main.id}  +  ${k.ars.name ?? k.ars.id} (arsenal)`)
        + `   ${s.goal} ${f.num(k.res.score, 1)}`);
      console.log('='.repeat(78) + '\n');
      console.log(f.gearBlock(s.engine, k.res.loadout, {
        pinnedGear: new Set(['Slot_Weapon1', 'Slot_Weapon2']),
        indifferent: new Set(k.res.indifferent),
      }) + '\n');
      console.log(f.bold('AUGMENTS'));
      console.log(f.augmentBlock(s.engine, k.res.loadout, { pinnedAug: new Set() }) + '\n');
      if (k.res.talentAlloc) {
        console.log(f.bold('TALENTS'));
        console.log(f.talentBlock(s.engine, k.res.loadout, k.res.talentAlloc, k.res.talentCoverage) + '\n');
      }
      console.log(f.bold('SKILLS'));
      console.log(f.skillsBlock(s.engine, k.res.loadout, k.res.evaluation, { pinnedSkills: new Set() }) + '\n');
      console.log(f.runeBlock(s.engine, k.res.loadout, k.res.evaluation) + '\n');
      console.log(f.throughputBlock(s.engine, k.res.evaluation, { goal: s.goal, authored: s.policyNote ?? null }));
    }
    console.log('\n' + f.dim(`every layout is in ${outDir}/ - index.json ranks them, and any pair file `
      + 'loads back with --build'));
    console.log('\n' + f.auditBlock(s.engine));
  },

  rotation(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    const pins = applyProfile(s, loadout,
      applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved }));
    const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
    if (!loadout.gear.Slot_Weapon1?.item) {
      die('bench rotation needs a mainhand pinned - a rotation is FOR a weapon.\n'
        + '  bench rotation --class Warrior --profile armorpen \\\n'
        + '    --pin weapon1=GA_Craft --pin weapon2=GA_Demon');
    }
    // A rotation is searched at fixed stats for the same reason a weapon is: a
    // rotation fitted to one gear set is a rotation for that gear set.
    if (!s.profile) {
      console.error(f.warn('note: no --profile, so the rotation is being searched against whatever gear is\n'
        + '  pinned. That is a rotation for that build rather than for the weapon.'));
    }
    const restarts = s.numFlag('restarts', 12, { integer: true });
    const rounds = s.numFlag('rounds', 3, { integer: true });
    const scorer = s.engine.makeScorer({
      goal: s.goal, weights: s.weights, target, rank: s.rank, mix: s.mix,
      ref: s.engine.evaluate(loadout, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s) }),
    });
    const skillName = (x) => s.engine.cdb.byId('skill').get(x)?.texts?.name ?? x;

    const kitSearch = (policy) => optimize(s.engine, {
      loadout, ...pins, goal: s.goal, weights: s.weights, target,
      rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
      exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
      pinnedSkills: pins.pinnedSkills, talentPoints: s.talentPoints,
      allowEmpty: !args.flags['no-empty'], restarts: s.numFlag('kit-restarts', 3, { integer: true }),
      policy,
    });

    const t0 = Date.now();
    let totalFights = 0;
    // Lists the search WANTED to score and did not have to, because it had
    // played that exact list before. Reported rather than swallowed: "570k
    // fights" and "570k lists considered" stopped being the same number the
    // moment the search grew a memo, and quietly printing the smaller one under
    // the old label would understate the search and overstate the machine.
    let totalRepeats = 0;
    // Round 0: the kit, against the rotation the model derives. That is where
    // every other command stops.
    let kit = kitSearch(null);
    let derivedScore = kit.score;
    // The orders the derived fight played for a press that lands on its
    // caster (sim.mjs `simulate`), for the sentence about the baseline below.
    const placed = kit.evaluation?.throughput?.rotationSearched?.landers ?? null;
    let apl = null, aplScore = derivedScore, best = { kit, apl: null, score: derivedScore };
    const log = [];

    for (let round = 1; round <= rounds; round++) {
      // --- search the rotation, kit fixed -----------------------------------
      const ev = s.engine.evaluate(kit.loadout, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s) });
      const ids = ev.throughput.lines.filter((l) => l.kind === 'active').map((l) => l.id);
      // ...in the order the model derives, so restart 0 reproduces it exactly
      // and the search can only improve on what was already reported.
      const seedApl = apl ? repairApl(apl, ids) : derivedApl(ids);
      // The reported list must never be null. The search can legitimately fail
      // to beat the baseline - `derivedScore` is the better of plain priority
      // order AND an 8-second rollout, and a rollout is not something an APL
      // can express - so when that happens the honest answer is the derived
      // order itself, printed as the list it is.
      if (!best.apl) best.apl = seedApl;
      const vocabulary = vocabularyFor(ev.rotation);
      const score = (candidate) => {
        totalFights++;
        try {
          return scorer.scoreFrom(s.engine.evaluate(kit.loadout, {
            target, rank: s.rank, mix: s.mix, policy: makePolicy(candidate), goal: simGoalOf(s),
          }));
        } catch { return -Infinity; }
      };
      const got = searchApl({
        score, ids, vocabulary, restarts, seed: 0x9e3779b9 + round,
        onProgress: process.stderr.isTTY
          ? (p) => process.stderr.write(`\r  round ${round}: ${p.evaluations} fights, best ${p.best.toFixed(1)}   `)
          : null,
        startFrom: seedApl,
      });
      apl = got.apl;
      aplScore = got.score;
      totalRepeats += got.cacheHits ?? 0;
      log.push({
        round, what: 'rotation', score: aplScore, fights: got.evaluations,
        vocab: vocabulary.length, trace: got.trace,
      });
      if (aplScore > best.score + 1e-9) best = { kit, apl, score: aplScore };

      // --- then the kit again, this time answering to that rotation ---------
      // `appendUnlisted` because the kit search moves underneath the list: a
      // change that slots a NEW weapon skill would otherwise be judged with
      // that skill never pressed, so every such change looks like a loss. An
      // explicit drop still sticks.
      const next = kitSearch(makePolicy(repairApl(apl, ids), { appendUnlisted: true }));
      log.push({ round, what: 'kit', score: next.score });
      if (next.score > best.score + 1e-9) { kit = next; best = { kit, apl, score: next.score }; }
      else break;   // neither half moved; the loop has converged
    }
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(60) + '\r');

    // --- report -------------------------------------------------------------
    const finalEv = s.engine.evaluate(best.kit.loadout, {
      target, rank: s.rank, mix: s.mix, policy: best.apl ? makePolicy(best.apl) : null,
      goal: simGoalOf(s),
    });
    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`${f.bold(loadout.class + ' ' + s.level)} - searching for a rotation, maximising `
      + `${f.bold(s.goal)} vs ${target.name}`);
    if (finalEv.profile) console.log(f.profileBlock(finalEv.profile));
    console.log(f.dim(`main hand ${f.short(loadout.gear.Slot_Weapon1.item)}`
      + (loadout.gear.Slot_Weapon2?.item ? `   arsenal ${f.short(loadout.gear.Slot_Weapon2.item)}` : '')
      + `\n${totalFights} simulated fights in ${((Date.now() - t0) / 1000).toFixed(1)}s over `
      + `${rounds} round${rounds === 1 ? '' : 's'} of (rotation, then kit)`
      + (totalRepeats
        ? `\n${totalFights + totalRepeats} lists considered - ${totalRepeats} of them were lists `
          + 'this search had already played, and were re-scored from the memo'
        : '')));
    console.log('');

    console.log(f.bold('ROTATION') + f.dim('  - walk it top to bottom, press the first line that is ready'));
    console.log(f.table(['  #', 'SKILL', 'WHEN', 'PER CAST', 'EVERY'],
      best.apl.entries.map((e, i) => {
        const line = finalEv.throughput.lines.find((l) => l.id === e.skill);
        return [`  ${i + 1}`, skillName(e.skill),
          condLabel(e.cond, skillName) || f.dim('always'),
          line ? (line.perCast.damage + line.perCast.heal + line.perCast.shield).toFixed(1) : f.dim('-'),
          line ? line.interval.toFixed(2) + 's' : f.dim('never')];
      }), { align: [null, null, null, 'r', 'r'] }));
    const never = [...(best.apl.excluded ?? []),
      ...best.apl.entries.filter((e) => !finalEv.throughput.lines.some((l) => l.id === e.skill)).map((e) => e.skill)];
    if (never.length) {
      console.log(f.dim(`  not pressed: ${[...new Set(never)].map(skillName).join(', ')}`
        + ' - the search found the clock better spent elsewhere'));
    }
    console.log(f.dim('  anything not listed is never pressed; when no line matches, you swing.'));

    console.log('\n' + f.bold('WHAT IT IS WORTH'));
    console.log(f.table(['  ', s.goal.toUpperCase(), 'VS DERIVED'], [
      ['  derived order (what every other command reports)', derivedScore.toFixed(1), ''],
      ['  searched rotation', best.score.toFixed(1),
        f.bold(((best.score / derivedScore - 1) * 100).toFixed(2) + '%')],
    ], { align: [null, 'r', 'r'] }));
    if (best.score <= derivedScore + 1e-9) {
      console.log(f.warn('  The search did not beat the baseline, so the list above IS the derived order.'));
      console.log(f.dim(`  That baseline is the better of plain priority order and a ${s.fight.lookahead}s rollout,`
        + '\n  and a rollout is not something a priority list can express - it re-simulates the next\n'
        + '  few seconds before every cast. Where the rollout wins, an APL starts behind and may\n'
        + '  not catch up. --lookahead 0 compares against plain priority order instead.'));
      // ...and, for a build with a press that lands on its caster for a
      // status that waits for a landing, of every order that places that
      // press (sim.mjs `simulate`) - with or without a lookahead.
      if (placed?.played?.length > 1) {
        console.log(f.dim(`  In this build each of those was also played ${placed.exhaustive ? 'every way' : 'several ways'} `
          + `${placed.of.map((l) => l.name).join(' and ')} can be placed (${placed.played.length} orders: as ranked, last, left out),\n`
          + '  and the baseline is the best of them - with --lookahead 0 too. bench sheet --verbose lists them.'));
      }
    }
    console.log(f.table(['  ROUND', 'SEARCHED', s.goal.toUpperCase(), 'FIGHTS'],
      log.map((l) => ['  ' + l.round, l.what, l.score.toFixed(1), l.fights ? String(l.fights) : ''])
      , { align: [null, null, 'r', 'r'] }));

    // --- is that edge real? -------------------------------------------------
    // The search runs deterministic - procs folded in at their expected rate,
    // which is the mean exactly. A rotation tuned on the mean still has to beat
    // the other one when the dice are actually rolled, and an edge inside the
    // spread is not an edge. This is the difference between "the search found
    // 0.4%" and "0.4% is there to find".
    const rolls = s.numFlag('validate', 200, { integer: true });
    if (rolls > 1) {
      const rolled = createEngine({
        game: typeof args.flags.game === 'string' ? args.flags.game : undefined,
        assume: s.engine.opts.assume,
        fight: { ...s.fight, count: rolls },
        classSkillSlots: args.flags['class-skills'] != null && args.flags['class-skills'] !== true
          ? Number(args.flags['class-skills']) : undefined,
      });
      const rolledTarget = rolled.combat.foe(s.targetName, s.level, s.targetLevel);
      const run = (p) => rolled.evaluate(best.kit.loadout,
        { target: rolledTarget, rank: s.rank, mix: s.mix, policy: p, goal: simGoalOf(s) }).throughput;
      const a = run(null);
      const b = run(makePolicy(best.apl));
      // Two independent means, so the difference has the pooled standard error.
      const se = Math.sqrt((a.dpsSd ** 2 + b.dpsSd ** 2) / rolls);
      const diff = b.dps - a.dps;
      // A spread of exactly zero is not a suspiciously clean result, it is a
      // build with nothing to roll: the dice touch every proc-applied dot,
      // every triggered skill, the +/-10% swing band and - since the crit
      // decomposition landed - every critical strike. A build with none of
      // those, which now means one that cannot crit either, plays out the same
      // way every time, and saying "clears the noise" about a fight that has no
      // noise would dress a tautology up as a test.
      const deterministic = a.dpsSd < 1e-9 && b.dpsSd < 1e-9;
      console.log('\n' + f.bold('AND WHETHER IT SURVIVES THE DICE')
        + f.dim(`  - ${rolls} fights each, procs and crits rolled rather than averaged`));
      console.log(f.table(['  ', 'MEAN', 'SD', ''], [
        ['  derived order', a.dps.toFixed(1), a.dpsSd.toFixed(2), ''],
        ['  searched rotation', b.dps.toFixed(1), b.dpsSd.toFixed(2), ''],
        ['  difference', (diff > 0 ? '+' : '') + diff.toFixed(2),
          deterministic ? '-' : '+/- ' + se.toFixed(2),
          deterministic ? f.dim('exact')
            : Math.abs(diff) > 2 * se ? f.bold('clears the noise')
              : f.warn('INSIDE THE NOISE - not a real edge')],
      ], { align: [null, 'r', 'r'] }));
      if (deterministic) {
        console.log(f.dim('  This build has nothing for the dice to touch - no proc-applied dot, no\n'
          + '  triggered skill and no crit chance - so every fight plays out identically and the\n'
          + `  difference is exact rather than significant. Rolling it ${rolls} times proves that,\n`
          + '  and nothing more.'));
      } else if (Math.abs(diff) <= 2 * se) {
        console.log(f.dim('  The searched rotation is not distinguishable from pressing whatever is ready.\n'
          + '  That is a fact about this build, not a failure of the search: the mechanics that\n'
          + '  reward sequencing here are mostly ones the model still refuses - see `bench audit`.'));
      }
    }

    // --- does a stat repartition change the ROTATION? -----------------------
    // Not "does this rotation still win elsewhere" - that is the weaker
    // question below. This one searches a FRESH rotation at every corner with
    // the kit held fixed, so the only thing that moved is the stats, and then
    // cross-evaluates every rotation at every corner. If the lists come out the
    // same, a rotation is a property of the weapon and the gear search can run
    // afterwards with it fixed. If they differ, the answer is "it depends", and
    // the matrix says how much it depends.
    if (args.flags['across-search'] !== undefined) {
      const corners = typeof args.flags['across-search'] === 'string'
        ? args.flags['across-search'].split(',').map((x) => resolve(x.trim(), s.engine.profiles.list().map((p) => p.id), 'profile'))
        : ['mid', 'strength', 'vitality', 'crit', 'armorpen', 'fervor'];
      const t1 = Date.now();
      let fights = 0;
      const found = new Map();
      for (const p of corners) {
        const l2 = { ...best.kit.loadout, profile: p };
        const ev2 = s.engine.evaluate(l2, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s) });
        const ids2 = ev2.throughput.lines.filter((x) => x.kind === 'active').map((x) => x.id);
        const score2 = (apl2) => {
          fights++;
          try {
            return scorer.scoreFrom(s.engine.evaluate(l2, {
              target, rank: s.rank, mix: s.mix, policy: makePolicy(apl2), goal: simGoalOf(s),
            }));
          } catch { return -Infinity; }
        };
        if (process.stderr.isTTY) process.stderr.write(`\r  searching ${p}: ${fights} fights   `);
        const got = searchApl({
          score: score2, ids: ids2, vocabulary: vocabularyFor(ev2.rotation),
          restarts, seed: 0x9e3779b9, startFrom: derivedApl(ids2),
        });
        found.set(p, { apl: got.apl, own: got.score, derived: scorer.scoreFrom(ev2) });
      }
      if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(50) + '\r');

      console.log('\n' + f.bold('DOES THE STAT SPREAD CHANGE THE ROTATION?')
        + f.dim(`  - a fresh search at each corner, kit held fixed, ${fights} fights in `
          + `${((Date.now() - t1) / 1000).toFixed(1)}s`));
      const sig = (apl) => apl.entries
        .map((e) => skillName(e.skill) + (e.cond.kind === 'always' ? '' : `[${condLabel(e.cond, skillName)}]`))
        .join(' > ');
      console.log(f.table(['  CORNER', 'DERIVED', 'SEARCHED', 'GAIN', 'THE ROTATION IT WANTS'],
        corners.map((p) => {
          const g = found.get(p);
          return ['  ' + p, g.derived.toFixed(1), g.own.toFixed(1),
            ((g.own / g.derived - 1) * 100).toFixed(2) + '%', sig(g.apl)];
        }), { align: [null, 'r', 'r', 'r'] }));

      // The transfer matrix. Row = the rotation found at that corner, column =
      // the corner it is being played at, cell = how far below that corner's
      // OWN best it lands. A row of zeroes is a rotation that costs nothing to
      // carry everywhere.
      console.log('\n' + f.bold('AND WHAT IT COSTS TO CARRY ONE EVERYWHERE')
        + f.dim('  - % below the best rotation for that corner'));
      const cell = (from, to) => {
        const l2 = { ...best.kit.loadout, profile: to };
        try {
          const v = scorer.scoreFrom(s.engine.evaluate(l2, {
            target, rank: s.rank, mix: s.mix, policy: makePolicy(found.get(from).apl),
            goal: simGoalOf(s),
          }));
          return (v / found.get(to).own - 1) * 100;
        } catch { return NaN; }
      };
      const worst = new Map();
      const rows = corners.map((from) => {
        const cells = corners.map((to) => cell(from, to));
        worst.set(from, Math.min(...cells.filter(Number.isFinite)));
        return ['  ' + from, ...cells.map((v) => (Number.isFinite(v) ? v.toFixed(2) + '%' : '-'))];
      });
      console.log(f.table(['  FOUND AT', ...corners], rows, { align: [null, ...corners.map(() => 'r')] }));
      const best1 = [...worst.entries()].sort((a, b) => b[1] - a[1])[0];
      console.log(f.dim(`\n  Carrying one rotation everywhere costs at most `
        + `${Math.abs(best1[1]).toFixed(2)}% if you pick the one found at "${best1[0]}".\n`
        + '  A distinct list per corner is only worth writing down if that number is one you care about.'));
    }

    // --- does it transfer? --------------------------------------------------
    // The entire reason to search a POLICY rather than a sequence is that its
    // conditions are re-evaluated against whatever build wears it. That is a
    // claim, and it is checkable: run this rotation at other corners of the
    // stat space and see whether it still beats pressing whatever is ready
    // there. A rotation that only wins at the corner it was tuned on is a
    // rotation for that corner.
    if (s.profile && args.flags.across !== undefined) {
      const others = typeof args.flags.across === 'string'
        ? args.flags.across.split(',').map((x) => resolve(x.trim(), s.engine.profiles.list().map((p) => p.id), 'profile'))
        : ['zero', 'mid', 'full', 'crit', 'armorpen', 'fervor'];
      console.log('\n' + f.bold('AND WHETHER IT TRANSFERS')
        + f.dim('  - the same rotation, re-evaluated at other stat corners'));
      const rows = [];
      for (const p of others) {
        const l2 = { ...best.kit.loadout, profile: p };
        let der, run;
        try {
          der = scorer.scoreFrom(s.engine.evaluate(l2, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s) }));
          run = scorer.scoreFrom(s.engine.evaluate(l2, {
            target, rank: s.rank, mix: s.mix, policy: makePolicy(best.apl), goal: simGoalOf(s),
          }));
        } catch { continue; }
        rows.push(['  ' + p + (p === s.profile ? f.dim('  (tuned here)') : ''),
          der.toFixed(1), run.toFixed(1),
          ((run / der - 1) * 100).toFixed(2) + '%',
          run >= der - 1e-6 ? f.dim('holds') : f.warn('LOSES to the derived order')]);
      }
      console.log(f.table(['  PROFILE', 'DERIVED', 'THIS ROTATION', 'GAIN', ''], rows,
        { align: [null, 'r', 'r', 'r'] }));
      console.log(f.dim('  A rotation that only wins where it was tuned is a rotation for that corner.\n'
        + '  One that holds everywhere is a rotation for the weapon, which is the thing worth having.'));
    }

    // How much of the search agreed. Restarts are independent climbs from
    // random lists, so the fraction that reach the same score is the honest
    // evidence that this is an optimum rather than the best of a few tries.
    const top = log.filter((l) => l.what === 'rotation');
    if (top.length && top[0].trace) {
      const tr = top[top.length - 1].trace;
      const hit = tr.filter((x) => x.score >= best.score - 1e-6).length;
      console.log(f.dim(`\n  ${hit} of ${tr.length} independent restarts reached this score`
        + `; worst reached ${Math.min(...tr.map((x) => x.score)).toFixed(1)}.`));
    }

    console.log('\n' + f.talentBlock(s.engine, best.kit.loadout, best.kit.talentAlloc, best.kit.talentCoverage));
    console.log('\n' + f.bold('SKILLS'));
    console.log(f.skillsBlock(s.engine, best.kit.loadout, finalEv, { pinnedSkills: pins.pinnedSkills }));
    console.log('\n' + f.runeBlock(s.engine, best.kit.loadout, finalEv));
    if (typeof args.flags.json === 'string') {
      writeFileSync(args.flags.json, JSON.stringify({
        version: VERSION, cdbSha: s.engine.meta.cdbSha, bootSha: s.engine.meta.bootSha,
        goal: s.goal, weights: s.weights, target: s.targetName, targetLabel: target.name,
        fervorScope: s.engine.opts.assume.fervorScope,
        tickSource: s.engine.opts.assume.tickSource,
        stars: s.stars, rank: s.rank, level: s.level, mix: s.mix, rarityRoll: s.rarityRoll,
        fight: s.fight.seconds, fights: s.fight.count, targets: s.fight.targets,
        targetHealth: s.fight.targetHealth,
        lookahead: s.fight.lookahead,
        profile: s.profile, profileValues: s.profileValues,
        pinned: { gear: [...pins.pinnedGear], augments: [...pins.pinnedAug], skills: [...pins.pinnedSkills] },
        build: best.kit.loadout,
        // The rotation is part of the result, so it round-trips with the build.
        rotation: best.apl,
        metrics: {
          derived: derivedScore, searched: best.score,
          dps: finalEv.throughput.dps, hps: finalEv.throughput.hps,
          sps: finalEv.throughput.sps, ehp: finalEv.survivability.ehp,
        },
        sheet: Object.fromEntries(finalEv.sheet),
        unmodelled: finalEv.throughput.unmodelled,
        assumptions: s.engine.audit,
      }, null, 2));
      console.log(f.dim(`\nwrote ${args.flags.json}`));
    }
    console.log('\n' + f.auditBlock(s.engine));
  },

  profiles(args) {
    const s = commonSetup(args);
    const want = typeof args.flags.class === 'string'
      ? resolve(args.flags.class, s.engine.cat.classes.flatMap((c) => [c.unit, c.aptitude]), 'class')
      : null;
    console.log(f.header(s.engine, VERSION) + '\n');
    const classes = want
      ? s.engine.cat.classes.filter((c) => c.unit === want || c.aptitude === want)
      : s.engine.cat.classes;
    console.log(f.dim(
      'A profile PINS every stat to a flat number, replacing whatever the level curve and the\n'
      + 'gear would have produced. Then a weapon or a rotation can be compared with nothing else\n'
      + 'moving - two weapons differ only in the kit they grant and the coefficients they scale by,\n'
      + 'not in which is the better stat stick. The weapon slots stay live; the armour is gone.\n'
      + `The rig is ${'50'} everywhere and ${'100'} on the one stat a profile names, so `
      + '`crit` minus `mid`\nis exactly "+50 CritChanceRating and nothing else moved". '
      + '--profile-base and --profile-peak\nmove both numbers. The budgets below are context, not the source: they say what a real\n'
      + 'set would deliver, so you can see how far from a real character the rig sits.\n'));
    for (const c of classes) {
      const b = s.engine.profiles.budgetsFor(c.unit, s.level);
      console.log(f.bold(`${c.unit} - what one full set delivers at level ${s.level}`));
      const rows = [];
      if (b.primary) rows.push(['  primary', b.primary.atb, b.primary.amount.toFixed(1), '']);
      if (b.vitality) rows.push(['  vitality', b.vitality.atb, b.vitality.amount.toFixed(1), '']);
      if (b.armor) rows.push(['  armor', b.armor.atb, b.armor.amount.toFixed(1), 'from props.armorReduction, not the authored columns']);
      for (const r of b.ratings) {
        rows.push(['  ratings', r.atb, r.amount.toFixed(1),
          r.factions.length ? `factions ${r.factions.join('/')}` : '']);
      }
      console.log(f.table(['  GROUP', 'ATTRIBUTE', 'FULL SET', 'NOTE'], rows,
        { align: [null, null, 'r'] }));
      console.log(f.dim('  One budget is split across the ratings your factions give you, so the three\n'
        + '  rating rows above are one 100%, not three.'));
      console.log('');
    }
    const rows = s.engine.profiles.list().map((p) => {
      const r = s.engine.profiles.resolve(p.id, classes[0].unit, s.level, s.profileValues);
      return ['  ' + p.id, p.desc,
        r.peakAtb ? `${r.peakAtb} ${r.peak} vs ${r.base} elsewhere` : `all ${r.base}`];
    });
    console.log(f.bold('PROFILES') + '\n' + f.table(['  NAME', 'WHAT IT IS', 'PINS'], rows));
    console.log(f.dim(`\n  bench sheet --class ${classes[0].unit} --profile armorpen --pin weapon1=GA_Craft`
      + `\n  bench weapons --class ${classes[0].unit} --profile armorpen`));
  },

  weapons(args) {
    const s = commonSetup(args);
    // `--across` answers the question the whole decomposition rests on: does the
    // ranking depend on the stats? If it does not, a weapon and its skills are
    // one decision and the gear search runs afterwards with them fixed.
    const across = typeof args.flags.across === 'string'
      ? args.flags.across.split(',').map((x) => resolve(x.trim(), s.engine.profiles.list().map((p) => p.id), 'profile'))
      : (args.flags.across === true ? ['zero', 'mid', 'full', 'crit', 'armorpen', 'fervor'] : null);
    if (across) return compareAcrossProfiles(s, args, across);
    if (!s.profile) {
      die('bench weapons needs a --profile, so every weapon is compared at the same stats.\n'
        + '  Without one the answer is "whichever weapon the gear search happened to like".\n'
        + '  `bench profiles` lists them; `--profile armorpen` is the usual place to start,\n'
        + '  `--across` runs several and reports how much the ranking moves between them,\n'
        + '  and `--pairs` sweeps every ORDERED (mainhand, arsenal) pair.');
    }
    // The arsenal is not a lesser copy of the mainhand: it grants two chosen
    // skills and 0.4 of its stats, and no chain. So the pair is ordered, and
    // --pairs is the sweep that treats it that way.
    if (args.flags.pairs) {
      const top = args.flags.top != null && args.flags.top !== true ? Number(args.flags.top) : 6;
      if (!Number.isFinite(top) || top < 2) die('--top needs a number of weapons to pair, at least 2');
      return sweepWeaponPairs(s, args, top);
    }
    const target = s.engine.combat.foe(s.targetName, s.level, s.targetLevel);
    const base = loadBuild(args, s.engine, s.level, s.saved);
    const cls = s.engine.cat.classes.find((c) => c.unit === base.class);
    const restarts = s.numFlag('restarts', 1, { integer: true });
    const arsenal = !args.flags['no-arsenal'];

    // Every distinct mainhand this class can hold. Rarity is pinned to the
    // authored one unless --rarity-roll asks otherwise, because a weapon
    // comparison should not also be a comparison of how lucky the drop was.
    const seen = new Set();
    const weapons = [];
    for (const c of s.engine.cat.candidates('Slot_Weapon1', {
      aptitude: cls.aptitude, charLevel: s.level, rarities: s.rarities,
      exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
    })) {
      if (seen.has(c.item.id)) continue;
      seen.add(c.item.id);
      weapons.push(c);
    }

    const t0 = Date.now();
    const rows = [];
    let n = 0;
    for (const c of weapons) {
      if (process.stderr.isTTY) process.stderr.write(`\r  ${++n}/${weapons.length} ${c.item.id}      `);
      const loadout = {
        ...base, gear: {}, augments: {}, skills: {}, runes: {}, talents: {},
        profile: s.profile, profileValues: s.profileValues,
      };
      loadout.gear.Slot_Weapon1 = {
        item: c.item.id, rarity: c.rarity, generic: c.generic ?? null,
        stars: s.stars === 'max' ? s.engine.cat.maxStars(c.item, c.rarity)
          : Math.min(s.stars, s.engine.cat.maxStars(c.item, c.rarity)),
      };
      // Everything except the mainhand is pinned: the profile is the armour,
      // and the augment sockets are left empty so a weapon is compared on the
      // kit it grants rather than on the enchants it can host.
      const pinnedGear = new Set(s.engine.cat.combatSlots().map((x) => x.id));
      if (arsenal) pinnedGear.delete('Slot_Weapon2');
      const pinnedAug = new Set();
      let res;
      try {
        res = optimize(s.engine, {
          loadout, pinnedGear, pinnedAug, goal: s.goal, weights: s.weights, target,
          rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
          exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
          talentPoints: s.talentPoints, allowEmpty: true, restarts,
        });
      } catch (err) {
        rows.push({ id: c.item.id, name: c.item.name ?? c.item.id, error: err.message });
        continue;
      }
      const ev = res.evaluation;
      // What the weapon grants, not only what was chosen: a pool of three that
      // hands you two plus an always-on passive reads as one skill otherwise.
      const pool = s.engine.plan.pools(res.loadout).find((p) => p.key === 'Slot_Weapon1');
      rows.push({
        id: c.item.id,
        name: c.item.name ?? c.item.id,
        type: s.engine.cat.handednessOf(c.item) ?? '',
        score: res.score,
        chain: ev.rotation.filler.length,
        skills: (res.loadout.skills?.Slot_Weapon1 ?? []),
        slots: pool ? `${res.loadout.skills?.Slot_Weapon1?.length ?? 0}/${pool.options?.length ?? 0}` : '',
        arsenal: res.loadout.gear.Slot_Weapon2?.item ?? null,
        gaps: (ev.throughput.unmodelled ?? []).filter((u) => u.source !== 'talent'),
      });
    }
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(50) + '\r');

    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`${f.bold(base.class + ' ' + s.level)} - every mainhand, ranked by ${f.bold(s.goal)} vs ${target.name}`);
    console.log(f.profileBlock(s.engine.profiles.resolve(s.profile, base.class, s.level, s.profileValues)));
    console.log(f.dim(`${weapons.length} weapons in ${((Date.now() - t0) / 1000).toFixed(1)}s   `
      + `weapon mastery: rank ${s.rank}   skills, talents and runes chosen per weapon   `
      + `arsenal: ${arsenal ? 'searched' : 'empty'}   no armour, no offhand, no augments`));
    console.log('');
    rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    const best = rows[0]?.score ?? 0;
    console.log(f.table([s.goal.toUpperCase(), 'VS BEST', 'WEAPON', 'HANDS', 'CHAIN', 'SLOTS', 'SKILLS TAKEN', 'GAPS'],
      rows.map((r) => (r.error
        ? [f.warn('-'), '', r.name, '', '', '', f.warn(r.error), '']
        : [r.score.toFixed(1), best > 0 ? ((r.score / best - 1) * 100).toFixed(1) + '%' : '',
          r.name, r.type, String(r.chain), r.slots,
          r.skills.map((x) => s.engine.cdb.byId('skill').get(x)?.texts?.name ?? x).join(', '),
          r.gaps.length ? f.warn(String(r.gaps.length)) : ''])),
      { align: ['r', 'r'] }));

    const gaps = new Map();
    for (const r of rows) {
      for (const g of r.gaps ?? []) if (!gaps.has(g.id)) gaps.set(g.id, g.why);
    }
    if (gaps.size) {
      console.log('\n' + f.bold(`NOT SCORED (${gaps.size})`) + f.dim(' - what these weapons declare that the model cannot price'));
      const named = new Map();
      for (const id of gaps.keys()) {
        const nm = s.engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
        named.set(nm, (named.get(nm) ?? 0) + 1);
      }
      for (const [id, why] of gaps) {
        // Five weapon types share the name "Weapon Upgraded" and they are five
        // different rows, so the id goes in wherever the name does not identify.
        const nm = s.engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
        const label = named.get(nm) > 1 || nm === id ? `${nm} (${id})` : nm;
        console.log(`  ${label}  ${f.dim(why)}`);
      }
    }
    console.log('\n' + f.dim('CHAIN is how many links the base-attack chain has. A weapon whose kit the model\n'
      + 'cannot read scores low for a reason the GAPS column names, not because it is weak.'));
  },

  // The patch-day pipeline. `bench update` diffs the install against the
  // committed fingerprint and prints the work list; --reanchor rewrites the
  // citations whose function merely moved; --accept records the new state
  // once the work is done (or consciously deferred). The two halves are
  // independent on purpose: a bytecode the reader cannot parse (a new HLB
  // version, a new opcode) must not hide the data drift, so the cdb half runs
  // regardless and the citations are reported as UNCHECKED.
  async update(args) {
    // --game lands in flags, so hand it back to the locator or it falls
    // through to the cached path - and with a live and a PTR install side by
    // side that is a report about the wrong build.
    const gameArgv = typeof args.flags.game === 'string' ? ['--game', args.flags.game, ...args._] : args._;
    const game = requireGame(gameArgv);
    const cdb = loadCdb({ game, quiet: true });
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const withStale = !!args.flags['with-stale-citations'];

    // Refused before anything is computed: nothing below may tempt a write.
    if (args.flags.accept && args.flags.against) {
      console.log(f.warn(`Not accepted: ${acceptGate({ against: true }).reason}.`));
      process.exitCode = 1;
      return;
    }

    let code = null, codeError = null;
    try { code = readHlb(requireBoot(gameArgv)); } catch (e) { codeError = e.message; }

    // --against <path>: diff against an older copy of the data instead of the
    // committed fingerprint - a data.cdb pulled out of an old depot, or a whole
    // install folder. The schema diff can only speak from a real old build,
    // and the fingerprint carries one only from the first --accept after
    // schemas were tracked. Old ROWS are what lets a changed row say what
    // changed in it: --against has them, and so does the copy --accept leaves
    // in .cache/ on the machine that accepted.
    const committed = loadFingerprint(repoRoot);
    let stored = committed, oldCdb = null;
    if (args.flags.against) {
      if (typeof args.flags.against !== 'string') throw new Error('--against needs a path: a data.cdb file or an install folder');
      const p = args.flags.against;
      if (!existsSync(p)) throw new Error(`--against: ${p} does not exist`);
      oldCdb = statSync(p).isDirectory()
        ? loadCdb({ game: p, quiet: true })
        : new Cdb(JSON.parse(readFileSync(p, 'utf8')), { game: p, cdbSha: null, bootSha: null });
      // The data of the old copy, and the code half of the committed
      // fingerprint: an old data.cdb has no bytecode beside it.
      stored = fingerprintAgainst(oldCdb, committed, `${p} (--against)`);
    } else if (committed) {
      const raw = loadAcceptedRows(repoRoot, committed.cdbSha);
      if (raw) oldCdb = new Cdb(raw, { game: acceptedRowsPath(repoRoot), cdbSha: raw.cdbSha, bootSha: null });
    }
    // The qualified names, body shapes and stub annotations a previous
    // --accept recorded. They describe the bytecode, not the data, so they
    // are consulted whatever the data is being diffed against.
    const known = committed?.citations ?? null;
    // Citations are scanned wherever they are stated as current fact: the
    // model, the commands, the tools, the UI server, the living docs, and the
    // comment lines of the suite.
    const roots = citationRoots(repoRoot);
    const current = buildFingerprint(cdb, { code, srcDir: roots, known, prev: committed });
    // ...and with them what the last acceptance deferred: where each of
    // those citations was estimated to be when it was let through.
    const deferredList = committed?.staleCitations ?? null;
    const cites = code ? resolveCitations(code, roots, { known, deferred: deferredList }) : { resolved: {}, report: [], sites: [] };
    const gate = acceptGate({ report: cites.report, codeError, withStale });
    // What the last acceptance deferred, against what the source says today.
    const deferred = code ? deferredCitations(committed, cites.report) : [];

    // --reanchor: the mechanical half, on its own. A dry run unless --write.
    if (args.flags.reanchor) {
      if (!code) {
        console.log(f.warn(`Cannot re-anchor: the bytecode is unreadable (${codeError}).`));
        process.exitCode = 1;
        return;
      }
      const only = typeof args.flags.only === 'string' ? args.flags.only : null;
      const plan = planReanchor(code, roots, { known, only, deferred: deferredList });
      console.log(f.bold(`RE-ANCHOR  ${plan.edits.length} citation${plan.edits.length === 1 ? '' : 's'} can be rewritten mechanically, ${plan.manual.length} need a person`)
        + f.dim(only ? `  (only files matching ${only})` : ''));
      for (const e of plan.edits) {
        console.log(`  ${`${e.file}:${e.line}`.padEnd(24)} ${e.from} -> ${e.to}  ${f.dim(e.why)}`
          + (e.body === 'CHANGED' ? f.warn('  BODY CHANGED since the accepted build - the number moves, the sentence still needs a re-read') : '')
          + (e.printed ? f.warn('  [printed to the user]') : ''));
      }
      if (plan.manual.length) {
        console.log('');
        console.log(f.bold(`MANUAL     ${plan.manual.length}`) + f.dim('  never rewritten: a fresh number on a sentence nobody re-read would be a forged re-read'));
        for (const m of plan.manual) {
          console.log(`  ${m.state.padEnd(8)} ${m.label ?? m.key}  ${f.dim(m.at.join(', '))}${m.printed ? f.warn('  [printed to the user]') : ''}\n${f.dim('           ' + m.why)}`);
        }
      }
      if (args.flags.json) {
        const out = typeof args.flags.json === 'string' ? args.flags.json : 'bench-reanchor.json';
        writeFileSync(out, JSON.stringify({ edits: plan.edits, manual: plan.manual }, null, 1));
        console.log(f.dim(`\nfull plan -> ${out}`));
      }
      if (args.flags.write) {
        const done = applyReanchor(plan);
        console.log('');
        for (const w of done.written) console.log(`  wrote ${w.edits} edit${w.edits === 1 ? '' : 's'} to ${w.path}`);
        for (const s of done.skipped) console.log(f.warn(`  SKIPPED ${s}: it changed since it was scanned - nothing written there, run again`));
        if (!done.written.length && !done.skipped.length) console.log(f.dim('  nothing to write'));
      } else {
        console.log(f.dim('\nDry run: nothing was written. --reanchor --write rewrites the files; --only <path> narrows it to the files whose path contains it.'));
      }
      return;
    }

    // --row <sheet>:<id>: everything that changed inside one row.
    if (args.flags.row) {
      const [sheet, ...rest] = String(args.flags.row).split(':');
      const id = rest.join(':');
      if (!sheet || !id) die('--row needs <sheet>:<id>, e.g. --row rarity:Epic');
      if (!oldCdb) {
        die('--row needs the old rows, and the fingerprint keeps hashes only. Either pass --against <an older data.cdb or install folder>,\n'
          + `or run it on the machine that ran the last --accept (it keeps the accepted rows in ${acceptedRowsPath(repoRoot)}; there is no such file for the accepted build here).`);
      }
      const paths = rowDiff(oldCdb, cdb, sheet, id);
      if (paths == null) die(`--row: ${sheet}:${id} is not a row on both sides (old side: ${stored.at}) - an added or a removed row has nothing to diff`);
      console.log(f.bold(`${sheet} ${id}`) + f.dim(`  ${stored.at} -> this install; texts and visuals left out, enums by name${sheet === 'skill' ? ', the script on a line of its own' : ''}`));
      const out = rowLines(sheet, paths);
      for (const l of out) console.log(paths.length ? `  ${l}` : f.dim(`  ${l}`));
      return;
    }

    if (!stored) {
      // A packaged copy carries the accepted build's two hashes and not the
      // fingerprint: it can say whether the game moved, and nothing more.
      const stamp = loadAcceptedStamp(repoRoot);
      if (stamp) {
        const acc = acceptedBuild(repoRoot, cdb.meta);
        console.log(`This copy carries no model/fingerprint.json - a download ships the accepted build's hashes only (${acceptedStampPath(repoRoot)}).`);
        console.log(`  the model was accepted on ${String(stamp.at).slice(0, 10)}: cdb ${String(stamp.cdbSha).slice(0, 12)}  boot ${String(stamp.bootSha ?? '').slice(0, 12) || 'n/a'}`);
        console.log(`  this install:                       cdb ${cdb.meta.cdbSha.slice(0, 12)}  boot ${cdb.meta.bootSha?.slice(0, 12) ?? 'n/a'}`);
        console.log(acc?.same
          ? '  The same build: every number is computed on the data the model was accepted on.'
          : f.warn('  NOT the same build: the game was patched after this copy was released. What changed can only be listed from a clone of the repository (it holds the fingerprint) - or wait for a release accepted on the new build.'));
        console.log(f.dim('Nothing was recorded.'));
        return;
      }
      if (!args.flags.accept) {
        console.log('No fingerprint exists, so there is nothing to diff against.');
        console.log(f.dim(`Recording this build as the baseline is an acceptance like any other: re-run with --accept. ${gate.ok ? 'The citation gate is open.' : `It would be refused now: ${gate.reason}.`}`));
        return;
      }
      if (!gate.ok) {
        console.log(f.warn(`No fingerprint existed, and this build cannot be recorded as the baseline: ${gate.reason}.`));
        process.exitCode = 1;
        return;
      }
      if (gate.stale.length) current.staleCitations = gate.stale;
      mkdirSync(join(repoRoot, 'model'), { recursive: true });
      writeFileSync(fingerprintPath(repoRoot), JSON.stringify(current, null, 1));
      syncAcceptedStamp(repoRoot, current);
      saveAcceptedRows(repoRoot, cdb);
      console.log(`No fingerprint existed. Recorded the current build as the baseline:`);
      console.log(`  cdb ${current.cdbSha.slice(0, 12)}  boot ${current.bootSha?.slice(0, 12)}`);
      console.log(`  ${Object.keys(current.sheets).length} sheets, ${Object.keys(current.scripts).length} scripts, ${Object.keys(current.citations ?? {}).length} citations`);
      console.log(f.dim('Commit model/fingerprint.json and model/accepted-build.json. Future runs diff against them.'));
      return;
    }

    // Citations first - they are free to check and they gate everything else.
    const chain = captureChain(game, code?.version ?? null, { functions: code?.functions.length ?? null });
    if (code) {
      const rep = cites.report;
      const of = (st) => rep.filter((c) => c.state === st);
      const moved = of('MOVED'), missing = of('MISSING'), stubs = of('STUB'), anon = of('ANON');
      const ambiguous = moved.filter((c) => c.ambiguous);
      const suspect = rep.filter((c) => c.suspect);
      const changed = rep.filter((c) => c.body === 'CHANGED' && c.state !== 'STUB');
      const unhashed = rep.filter((c) => c.body === 'UNHASHED').length;
      console.log(f.bold(`BYTECODE   HLB v${code.version}, ${code.functions.length} functions, ${code.natives.length} natives`));
      // The in-game half, from what the install itself recorded: did the
      // loader run on this boot, and was anything captured against it.
      const cap = captureLine(chain);
      console.log((cap.level === 'warn' ? f.warn : f.dim)(`CAPTURE    ${cap.text}`));
      const staleAnon = anon.filter((c) => c.stale);
      console.log(f.bold(`CITATIONS  ${of('OK').length} ok, ${moved.length} moved, ${stubs.length} on a server-only stub, ${missing.length} missing`
        + (anon.length ? `, ${anon.length} anonymous${staleAnon.length ? ` (${staleAnon.length} stale)` : ''}` : ''))
        + (ambiguous.length ? f.dim(`  (${ambiguous.length} of the moved names match several functions - each placed by the shift its nearest unambiguous neighbour measured`) + (suspect.length ? f.warn(`, ${suspect.length} SUSPECT`) : '') + f.dim(')') : ''));
      // What a findex cannot say: whether the function under the name is still
      // the function the sentence read.
      console.log(f.dim(`  bodies   ${rep.filter((c) => c.body === 'SAME').length} same as accepted, ${changed.length} CHANGED, ${rep.filter((c) => c.body === 'STRIPPED').length} STRIPPED to a stub`
        + (unhashed ? `, ${unhashed} not comparable - the stored fingerprint predates body hashes, so MOVED says where a function is and nothing about what is in it; recorded on --accept` : '')));
      for (const c of moved.filter((x) => !x.suspect).slice(0, 20)) {
        console.log(`  MOVED    ${c.name}  @${c.cached} -> @${c.now}  ${f.dim(c.qualified ?? '')}`
          + (c.ambiguous || c.via ? f.dim(`  via ${c.via}`) : '')
          + (c.body === 'CHANGED' ? f.warn(`  BODY CHANGED (${c.opsWas ?? '?'} -> ${c.ops} ops)`) : ''));
      }
      if (moved.length > 20) console.log(f.dim(`  ...and ${moved.length - 20} more moved (all in --json)`));
      for (const c of changed) {
        console.log(f.warn(`  CHANGED  ${c.name}@${c.cached}${c.now != null ? ` -> @${c.now}` : ''} ${c.qualified}: the body is not the one the fingerprint recorded (${c.opsWas ?? '?'} -> ${c.ops} ops) - re-read the formula at ${(c.at ?? c.in ?? []).slice(0, 4).join(', ')}`));
      }
      for (const c of stubs) {
        const at = (c.at ?? c.in ?? []).slice(0, 4).join(', ');
        const head = `  STUB     ${c.name}@${c.cached}${c.stale ? ` -> @${c.now}` : ''} ${c.qualified}: ${c.ops} ops, throws "${c.stub.thrown}"`;
        if (c.stub.recorded) console.log(f.dim(`${head} - annotated since ${String(c.stub.since).slice(0, 10)}; the formula it anchored cannot be re-read on this client`) + (c.stale ? f.warn('  (the number is stale)') : ''));
        else console.log(f.warn(`${head} - the client no longer carries this body, so the formula it anchored cannot be re-read on this build${c.body === 'STRIPPED' ? ` (the accepted build recorded ${c.opsWas ?? 'a body of unknown'} ops there)` : ''}. Say so where it is cited: ${at}${c.printed ? ' [printed to the user]' : ''}`
          // Accepted stale: the stub got its date, the sentence stayed as it was.
          + (c.stub.acceptedStale ? `. Accepted STALE${c.stub.since ? ` on ${String(c.stub.since).slice(0, 10)}` : ''} (--with-stale-citations): the sentence was not reworded then and still states @${c.cached}` : '')));
      }
      // Intact itself, and calling something that is not.
      for (const c of rep.filter((x) => x.leans?.length && x.state !== 'STUB')) {
        console.log(f.dim(`  LEANS    ${c.name}@${c.cached} ${c.qualified} has its body, and calls ${c.leans.length === 1 ? 'a server-only stub' : 'server-only stubs'}: ${c.leans.join(', ')} - what happens in there cannot be re-read on this client (${(c.at ?? []).slice(0, 3).join(', ')})`));
      }
      for (const c of suspect) {
        console.log(f.warn(`  SUSPECT  ${c.name}@${c.cached} -> @${c.now} ${c.qualified}: ${c.off ?? '?'} slots off ${c.via}; the alternatives: ${(c.candidates ?? []).filter((x) => !x.endsWith('@' + c.now)).join(', ')} - qualify the citation in ${(c.in ?? []).join(', ')} as Class.method@findex`));
      }
      for (const c of missing) {
        // "No longer exists" is a claim about the game; say it only when no
        // reading of the spelling finds anything.
        console.log(f.warn(`  MISSING  ${c.name}@${c.cached} in ${(c.at ?? c.in ?? []).slice(0, 4).join(', ')} - ${c.hint?.text ?? 'no function of that name on this build; the formula it anchored is UNVERIFIED until the new code is read'}`));
      }
      for (const c of staleAnon.slice(0, 20)) {
        console.log(f.warn(`  ANON     ${c.closure ? 'fn' : ''}@${c.cached} in ${(c.at ?? []).slice(0, 4).join(', ')} - ${anonWhy(c)}`));
      }
      if (staleAnon.length > 20) console.log(f.dim(`  ...and ${staleAnon.length - 20} more anonymous (all in --json)`));
      const quiet = anon.length - staleAnon.length;
      if (quiet) console.log(f.dim(`  ANON     ${quiet} more land on an unnamed function - nothing but the number identifies them until --accept records the body`));
      // A recorded closure with a twin and no owner to tell them apart: the
      // number is taken at its word, and that is said.
      for (const c of rep.filter((x) => x.name === 'fn' && x.state === 'OK' && x.twins?.length)) {
        console.log(f.dim(`  ANON     fn@${c.cached} lands on the body the fingerprint recorded - and so ${c.twins.length === 1 ? 'does' : 'do'} ${c.twins.map((x) => `fn@${x}`).join(', ')}, with no owner recorded to tell them apart; the written number is taken at its word (${(c.at ?? []).slice(0, 3).join(', ')})`));
      }
      const printed = rep.filter((c) => c.printed && (c.state !== 'OK' || c.body === 'CHANGED'));
      if (printed.length) console.log(f.warn(`  ${printed.length} of these sit in strings the bench PRINTS (an audit's why:), so a user is being told it: ${printed.map((c) => `${c.name}@${c.cached}`).join(', ')}`));
      // A deferral is put on the record so that it stays in view: what the
      // last --accept --with-stale-citations let through, and which of those
      // are still owed.
      if (deferred.length) {
        const open = deferred.filter((d) => d.open);
        console.log((open.length ? f.warn : f.dim)(`  DEFERRED ${deferred.length} citation${deferred.length === 1 ? ' was' : 's were'} accepted stale on ${String(committed?.at).slice(0, 10)} (--with-stale-citations); `
          + (open.length ? `${open.length} still ${open.length === 1 ? 'is' : 'are'}: ${open.map((d) => `${d.label} ${d.state}${d.at.length ? ` ${d.at[0]}` : ''}`).join(', ')}` : 'none still is')
          + (open.length < deferred.length ? ` - ${deferred.length - open.length} ${open.length ? 'more' : 'of them'} ${deferred.length - open.length === 1 ? 'was' : 'were'} rewritten since, and the next --accept shortens the list` : '')));
      }
      if (gate.stale.length) console.log(f.dim(`  \`bench update --reanchor\` lists what can be rewritten mechanically (--write does it) and what needs a person.`));
    } else {
      console.log(f.warn(`BYTECODE   unreadable: ${codeError}`));
      const cap = captureLine(chain);
      console.log((cap.level === 'warn' ? f.warn : f.dim)(`CAPTURE    ${cap.text}`));
      console.log(f.warn('CITATIONS  UNCHECKED - every formula anchored in the bytecode is unverified until the reader parses this build'));
    }

    const diff = diffFingerprints(stored, current);
    const writeJson = (extra) => {
      if (!args.flags.json) return;
      const out = typeof args.flags.json === 'string' ? args.flags.json : 'bench-drift.json';
      writeFileSync(out, JSON.stringify({
        stored: stored.at, bytecode: code ? { version: code.version, functions: code.functions.length } : { error: codeError },
        capture: chain, diff, citations: cites.report, accept: gate, deferred, ...extra,
      }, null, 1));
      console.log(f.dim(`\nfull report -> ${out}`));
    };
    // The one place a fingerprint is written. Gated: see acceptGate.
    const accept = (what) => {
      if (!gate.ok) {
        console.log(f.warn(`\nNot accepted: ${gate.reason}.`));
        process.exitCode = 1;
        return;
      }
      if (gate.stale.length) current.staleCitations = gate.stale;
      writeFileSync(fingerprintPath(repoRoot), JSON.stringify(current, null, 1));
      syncAcceptedStamp(repoRoot, current);
      const kept = saveAcceptedRows(repoRoot, cdb);
      const stubbed = Object.values(current.citations ?? {}).filter((r) => r.stub).length;
      console.log(f.bold(`\nAccepted: ${what}`)
        + f.dim(` Commit model/fingerprint.json and model/accepted-build.json with the work that justified accepting.`));
      console.log(f.dim(`  recorded ${Object.keys(current.citations ?? {}).length} citations with their body shapes, ${stubbed} of them annotated as server-only stubs`
        + (gate.stale.length ? `, and ${gate.stale.length} accepted STALE (--with-stale-citations): ${gate.stale.map((x) => x.key).join(', ')}` : '')));
      console.log(f.dim(`  the accepted rows are kept in ${kept} (this machine only, never committed) so the next report can say what changed inside a row`));
    };
    if (diff.same) {
      console.log(`\nNo drift: the install matches the fingerprint from ${stored.at}.`);
      // The same build can still leave --accept something to record: a table
      // written before hooks, talents, schemas or body shapes existed, or
      // citations added to the source since.
      const gaps = fingerprintGaps(stored, current, { report: code ? cites.report : null });
      if (gaps.length) console.log(f.dim(`The stored fingerprint is not what this version would write for this build (${gaps.join(', ')}) - --accept rewrites it on this same build.`));
      writeJson({ clusters: [], itemsAdded: [], work: [], gaps });
      if (args.flags.accept) {
        if (gaps.length) accept(`the fingerprint is rewritten for this build (${gaps.join(', ')}).`);
        else console.log(f.dim('\nNothing to accept: the fingerprint already records everything this version tracks for this build.'));
      }
      return;
    }
    console.log('');
    console.log(f.bold(`DRIFT since ${stored.at}`)
      + f.dim(`  cdb ${diff.cdbChanged ? 'CHANGED' : 'same'}, boot ${stored.bootSha == null ? 'n/a' : diff.bootChanged ? 'CHANGED' : 'same'}`));
    // A skill row's script has its own hash and its own line, so a row that
    // changed in its script alone is neither "changed in substance" nor
    // "cosmetic": it is counted with the scripts.
    const scriptMoved = new Set([...diff.scripts.changed, ...diff.scripts.removed]);
    for (const [sheet, d] of Object.entries(diff.sheets)) {
      if (d.newlyTracked) { console.log(`  ${sheet.padEnd(12)} ${d.added.length} rows, tracked for the first time`); continue; }
      const scriptOnly = sheet === 'skill' ? (d.cosmeticOnly ?? []).filter((id) => scriptMoved.has(id)).length : 0;
      const cosmetic = (d.cosmeticOnly?.length ?? 0) - scriptOnly;
      const notes = [cosmetic ? `${cosmetic} in texts, visuals or an enum's numbering only` : '', scriptOnly ? `${scriptOnly} in the script alone` : ''].filter(Boolean).join(', ');
      console.log(`  ${sheet.padEnd(12)} +${d.added.length} added  -${d.removed.length} removed  ~${d.changed.length} changed${notes ? f.dim(` (${notes})`) : ''}`);
    }
    if (diff.scripts.changed.length || diff.scripts.added.length || diff.scripts.removed.length) {
      console.log(`  ${'scripts'.padEnd(12)} +${diff.scripts.added.length}  -${diff.scripts.removed.length}  ~${diff.scripts.changed.length}`);
    }
    if (diff.scripts.hooksUnknown) {
      console.log(f.dim(`  ${'hooks'.padEnd(12)} not in the stored fingerprint - recorded on --accept, diffed from then on`));
    } else if (diff.scripts.newHookNames.length) {
      console.log(`  ${'hooks'.padEnd(12)} ${diff.scripts.newHookNames.length} names no script declared before: ${diff.scripts.newHookNames.join(', ')}`);
    }
    if (diff.talentsUnknown) {
      console.log(f.dim(`  ${'talents'.padEnd(12)} not in the stored fingerprint - recorded on --accept, diffed from then on (a moved talent is invisible in this report)`));
    }
    for (const [u, d] of Object.entries(diff.talents ?? {})) {
      console.log(`  ${('talents '.padEnd(12))} ${u}: +${d.added.length} -${d.removed.length} ~${d.changed.length} moved`);
    }
    if (diff.othersUnknown) {
      console.log(f.dim(`  ${'unread'.padEnd(12)} sheets nothing reads are not in the stored fingerprint - recorded on --accept`));
    } else if (diff.othersChanged.length) {
      console.log(`  ${'unread'.padEnd(12)} sheets nothing in the bench reads changed: ${diff.othersChanged.join(', ')}`);
    }
    // Schema: what the row hashes cannot see - a column or an enum case that
    // appeared. The readers decode those by name, so a new case is silent.
    const sch = diff.schema;
    if (sch.unknown) {
      console.log(f.dim(`  ${'schema'.padEnd(12)} not in the stored fingerprint - recorded on --accept, diffed from then on`));
    } else {
      const sheetChanges = Object.entries(sch.sheets);
      const typeChanges = Object.entries(sch.customTypes);
      if (sheetChanges.length || typeChanges.length) {
        const cols = sheetChanges.reduce((n, [, d]) => n + d.added.length + d.removed.length + d.changed.length, 0);
        console.log(`  ${'schema'.padEnd(12)} ${cols} column changes across ${sheetChanges.length} sheets, ${typeChanges.length} custom types`);
        for (const [sheet, d] of sheetChanges.slice(0, 40)) {
          if (d.newSheet) { console.log(`    + ${sheet}  (${d.added.join(', ')})`); continue; }
          if (d.goneSheet) { console.log(`    - ${sheet}`); continue; }
          for (const c of d.added) console.log(`    + ${sheet}.${c}`);
          for (const c of d.removed) console.log(`    - ${sheet}.${c}`);
          for (const c of d.changed) {
            console.log(c.casesAdded
              ? `    ~ ${sheet}.${c.col}  ${c.casesAdded.length ? 'gained ' + c.casesAdded.join(', ') : ''}${c.casesRemoved.length ? ' lost ' + c.casesRemoved.join(', ') : ''}${c.reordered ? ' REORDERED' : ''}`
                + (!c.reordered && c.shifted?.length ? f.warn(`  INDEX SHIFT ${c.shifted.join(', ')} - only a by-name decode survives`) : '')
              : `    ~ ${sheet}.${c.col}  ${c.from} -> ${c.to}`);
          }
        }
        if (sheetChanges.length > 40) console.log(f.dim(`    ...and ${sheetChanges.length - 40} more sheets (all in --json)`));
        for (const [t, d] of typeChanges) {
          console.log(d.newType ? `    + customType ${t}  (${d.added.join(', ')})` : d.goneType ? `    - customType ${t}`
            : `    ~ customType ${t}  ${d.added.length ? 'gained ' + d.added.join(', ') : ''}${d.removed.length ? ' lost ' + d.removed.join(', ') : ''}`);
        }
      }
    }

    // New code: the classes that arrived in the packages the model cites, and
    // the cited classes whose method set moved.
    const cd = diff.code;
    // Always against the committed fingerprint: --against changes what the
    // DATA is diffed against, and an old data.cdb says nothing about code.
    const codeSince = args.flags.against ? `  since the accepted build (${String(committed?.at).slice(0, 10)}) - the code is diffed against the committed fingerprint whatever --against names` : '';
    if (code && cd.unknown) {
      console.log(f.dim(`  ${'code'.padEnd(12)} classes are not in the committed fingerprint - recorded on --accept; this report cannot name a class the patch added`));
    } else if (code && (cd.added.length || cd.removed.length || cd.changed.length)) {
      console.log('');
      console.log(f.bold(`NEW CODE   ${cd.added.length} classes added, ${cd.removed.length} removed, ${cd.changed.length} with another method set`)
        + f.dim(`  in the packages the model cites (${(current.code?.packages ?? []).map((p) => p || '(top level)').join(', ')})${codeSince}`));
      if (cd.added.length) console.log(`  + ${cd.added.slice(0, 24).join(', ')}${cd.added.length > 24 ? f.dim(`, ...and ${cd.added.length - 24} more`) : ''}`);
      if (cd.removed.length) console.log(`  - ${cd.removed.slice(0, 24).join(', ')}${cd.removed.length > 24 ? f.dim(`, ...and ${cd.removed.length - 24} more`) : ''}`);
      for (const c of cd.changed.filter((x) => x.cited)) {
        console.log(`  ~ ${c.cls}  ${c.from} -> ${c.to} methods${c.methodsAdded?.length ? `, gained ${c.methodsAdded.join(', ')}` : ''}${c.methodsRemoved?.length ? `, lost ${c.methodsRemoved.join(', ')}` : ''}`);
      }
      const uncited = cd.changed.filter((x) => !x.cited).length;
      if (uncited) console.log(f.dim(`  ~ ${uncited} more classes nothing cites changed their method set (all in --json)`));
    }

    // The two summaries that turn hundreds of ids into a sentence.
    const groups = clusters(diff);
    if (groups.length) {
      console.log('');
      console.log(f.bold('NEW SYSTEMS?') + f.dim('  ids added in the same patch sharing a word across sheets, largest first, each id counted once - a heuristic, read the rows'));
      for (const g of groups.slice(0, 10)) {
        console.log(`  ${g.token.padEnd(12)} ${Object.entries(g.sheets).map(([s, ids]) => `${s} ${ids.length}`).join(', ')}`
          + f.dim(`  e.g. ${Object.values(g.sheets).flat().slice(0, 4).join(', ')}`));
      }
      if (groups.length > 10) console.log(f.dim(`  ...and ${groups.length - 10} smaller ones: ${groups.slice(10).map((g) => g.token).join(', ')}`));
    }
    const kinds = addedItemsByKind(diff, cdb);
    if (kinds.length) {
      console.log('');
      console.log(f.bold(`ITEMS ADDED  ${diff.sheets.item.added.length}`));
      for (const k of kinds.slice(0, 12)) console.log(`  ${String(k.ids.length).padStart(4)}  ${k.kind.padEnd(28)} ${f.dim(k.ids.slice(0, 3).join(', ') + (k.ids.length > 3 ? ', ...' : ''))}`);
      if (kinds.length > 12) console.log(f.dim(`  ...and ${kinds.length - 12} more kinds`));
    }

    const work = workList(diff, cdb, { srcDir, roots, oldCdb });
    const needsGame = work.filter((w) => w.needs === 'in-game');
    const needsSheet = work.filter((w) => w.needs === 'sheet');
    const needsModel = work.filter((w) => w.needs === 'model');
    const notes = work.filter((w) => w.needs === 'none');
    console.log('');
    console.log(f.bold(`WORK LIST  ${work.length - notes.length} items: ${needsGame.length} need an in-game log, ${needsSheet.length} a SHEET check, ${needsModel.length} a model re-read`)
      + f.dim(`  (+${notes.length} notes needing nothing)`));
    // Both evidence buckets stand on a capture of THIS build. Say whether
    // there is one before listing what needs it.
    if (chain.present && !chain.capturedOnThisBoot && (needsGame.length || needsSheet.length)) {
      console.log(f.warn(`  nothing has been captured in combat on this build yet (see CAPTURE): the in-game and SHEET buckets have no evidence to be checked against${chain.bakedOnThisBoot ? ' - except the item bakes, which tools/bake-diff.mjs holds against the model' : ''}. A snapshot or log from before the patch is evidence about the old build.`));
    }
    if (!oldCdb) {
      console.log(f.dim(`  a changed row is named, not described: the fingerprint keeps hashes. --against <an older data.cdb> (or the rows a previous --accept kept on this machine) lets each item say what changed; --row <sheet>:<id> prints one row in full.`));
    }
    const show = (list, cap = 25) => {
      for (const w of list.slice(0, cap)) console.log(`  [${w.needs}] ${w.kind.padEnd(22)} ${w.id}\n${f.dim('           ' + w.why)}`);
      if (list.length > cap) console.log(f.dim(`  ...and ${list.length - cap} more (all in --json)`));
    };
    // The SHEET bucket in the order a sheet is built: the tables every item
    // goes through first (a rarity row prices every item of that rarity),
    // then the items themselves.
    const SHEET_ORDER = ['rarity', 'attribute', 'aptitude', 'affix', 'constant', 'item'];
    const rank = (w) => { const i = SHEET_ORDER.indexOf(w.kind.split('-')[0]); return i < 0 ? SHEET_ORDER.length : i; };
    const sheetOrdered = [...needsSheet].sort((a, b) => rank(a) - rank(b));
    // Schema items first among the model re-reads: they are few, and each one
    // is a whole kind of thing the readers cannot see yet.
    const modelOrdered = [...needsModel.filter((w) => w.kind.startsWith('schema-')), ...needsModel.filter((w) => !w.kind.startsWith('schema-'))];
    show(needsGame); show(sheetOrdered, 10); show(modelOrdered, 20);
    const dev = work.filter((w) => / dev\/test row/.test(w.why));
    if (dev.length) console.log(f.warn(`  ${dev.length} rows read like dev/test rows: ${dev.map((w) => w.id).join(', ')}`));
    const todo = work.filter((w) => /named TODO_/.test(w.why));
    if (todo.length) console.log(f.dim(`  ${todo.length} rows are named TODO_: ${todo.map((w) => w.id).join(', ')}`));

    writeJson({ clusters: groups, itemsAdded: kinds, work });
    if (args.flags.accept) accept('the fingerprint now records this build.');
    else {
      console.log(f.dim('\nThe fingerprint is unchanged; re-run with --accept once the work list is addressed.'
        + (gate.ok ? '' : ` It would be refused now: ${gate.reason}.`)));
    }
  },

  audit(args) {
    const { engine } = commonSetup(args);
    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.auditBlock(engine));
    console.log('\n' + f.dim('See docs/MODEL.md for where each formula came from.'));
  },

  /**
   * What a file says, as the bench reads it: a character sheet in any of the
   * four shapes charsheet.mjs reads, or a combat log in any dialect
   * combatlog.mjs reads - told apart by the file itself, so an exporter's
   * author has one command to check their output with. It prints what was
   * read, kept, dropped and why, and runs nothing.
   *
   *   --check        exit 1 when anything was dropped, not understood or
   *                  listed unreadable (a sheet), or when the reader names a
   *                  problem (a log) - for an exporter's own tests
   *   --json <out>   the same as data: for a sheet {kind, sourceFormat, sheet,
   *                  report} - the version-1 sheet of what the file recorded,
   *                  as the bench read it (charsheet.mjs recordedSheet), and
   *                  the report beside it, which --import and this command
   *                  read back as that sheet; a log as its dialect, figures
   *                  and sentences.
   *                  A bare --json prints that to stdout instead
   *   --class, --level   for a shape that does not carry them (a modkit dump)
   *
   * A Wink timeline (<id>.json.timeline) is read with its summary, the
   * <id>.json beside it, which carries the fight's start time.
   */
  import(args) {
    let typed = args._.slice(1);
    if (typed.length > 1) die(`bench import reads one file, not ${typed.length}: ${typed.join(', ')}`);
    if (args.flags.import === true) die('--import needs a file');
    const flagged = typeof args.flags.import === 'string' ? args.flags.import : null;
    // `--check` takes no value, and the parser hands a flag the word after
    // it: `bench import --check <file>`, the natural order, read the file as
    // the flag's value and then said no file was given. With no file
    // otherwise, that word IS the file; beside one, it is a second file.
    if (typeof args.flags.check === 'string') {
      if (!typed.length && !flagged) typed = [args.flags.check];
      else die(`--check takes no value, and "${args.flags.check}" was given after it: bench import <file> --check`);
      args.flags.check = true;
    }
    if (typed[0] && flagged && typed[0] !== flagged) die(`bench import was given two files, ${typed[0]} and --import ${flagged} - give one`);
    const path = typed[0] ?? flagged;
    if (!path) {
      // `bench import --json <file>`: --json took the file as where to write.
      if (typeof args.flags.json === 'string') {
        die(`bench import needs a file to read, and --json took "${args.flags.json}" as the file its report is written to.\n`
          + '  Name the file first: bench import <file> --json [<out>] (a bare --json prints the report).');
      }
      die('bench import needs a file: bench import <file>\n'
        + '  a character sheet (docs/CHARACTER-SHEET.md), a build the bench saved, a bare loadout or a modkit inventory dump;\n'
        + '  or a combat log (docs/COMBAT-LOG.md) - a farever-combat-log, or a Wink DPS Meter fight file');
    }
    if (args.flags.level === true) die('--level needs a number');
    if (args.flags.class === true) die('--class needs a class');
    const jsonOut = args.flags.json;
    const toStdout = jsonOut === true;
    const tooBig = oversizedImport(path);
    if (tooBig) die(tooBig);
    let bytes;
    try { bytes = readFileSync(path); } catch (e) { die(`${path}: ${e.message}`); }

    // WHICH KIND OF FILE, by its contents. Gzip is only ever a log. A file
    // that is one JSON object is a sheet in one of the four shapes, or a log
    // that fits on one line (a Wink summary, a header with no event); a file
    // of JSON lines is a log by its first line.
    const text = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? null : bytes.toString('utf8').replace(/^\uFEFF/, '');
    let whole = null;
    if (text != null) { try { whole = JSON.parse(text); } catch { whole = null; } }
    // What `bench import <sheet> --json` wrote is read as the sheet it holds.
    const wrapped = reportedSheet(whole);
    if (wrapped) whole = wrapped;
    let first = null;
    if (text != null && whole == null) {
      const line = text.split(/\r?\n/).find((l) => l.trim() !== '');
      try { first = line == null ? null : JSON.parse(line); } catch { first = null; }
    }
    const kind = text == null ? 'log'
      : detectSheetDialect(whole) ? 'sheet'
        : detectLogDialect(whole) || detectLogDialect(first) ? 'log' : null;

    const engineFor = () => createEngine(engineOptions(args));
    // A Wink timeline with the summary beside it, as every reader takes it.
    const readAsLog = () => readCombatLogAt(path, { data: bytes });

    if (kind == null) {
      // Neither: both readers say why, each in its own words.
      let asSheet = null;
      let asLog = null;
      try { readSheet(engineFor(), whole ?? bytes); } catch (e) { asSheet = e.message; }
      try { readAsLog(); } catch (e) { asLog = e.message; }
      die(`${path} is neither a character sheet nor a combat log the bench reads.\n`
        + `  As a character sheet: ${asSheet ?? 'not one'}\n  As a combat log: ${asLog ?? 'not one'}`);
    }

    if (kind === 'sheet') {
      const engine = engineFor();
      let r;
      try {
        r = readSheet(engine, whole, {
          cls: typeof args.flags.class === 'string' ? args.flags.class : null,
          level: args.flags.level != null ? String(args.flags.level) : null,
        });
      } catch (e) {
        if (e instanceof SheetError) die(`${path}: ${e.message}`);
        throw e;
      }
      const failing = r.dropped.length + r.unknownKeys.length + r.unreadable.length;
      // The build as the bench would hand it on, written only when --json
      // asks for it: the version-1 sheet of what was KEPT - not the file's
      // bytes - recording what the file recorded and leaving open what it
      // left open (charsheet.mjs recordedSheet, the cut a submission's
      // sheet.json is too), with the game build the FILE said it was written
      // on in its source, never this install's. A sheet that does not read
      // back as the import is said beside it, on stderr when stdout is the
      // report.
      const recorded = toStdout || typeof jsonOut === 'string'
        ? recordedSheet(engine, r, { source: 'file', label: 'the --json sheet' })
        : null;
      // `sourceFormat`, not `format`: a top-level format would make this
      // wrapper pass for a sheet of that format (and be refused as one with
      // no character). Given back to --import or here, its `sheet` is read.
      const report = recorded && {
        kind: 'sheet',
        sourceFormat: r.format,
        sheet: recorded.sheet,
        report: {
          dropped: r.dropped, notes: r.notes, gaps: r.gaps, unknownKeys: r.unknownKeys,
          unreadable: r.unreadable, buildMismatch: r.buildMismatch,
        },
      };
      const readBack = (recorded?.problems ?? []).map((p) => f.warn(`note: ${p}.`));
      if (toStdout) {
        console.log(JSON.stringify(report, null, 2));
        for (const line of readBack) console.error(line);
      } else {
        console.log(f.header(engine, VERSION) + '\n');
        console.log(f.bold(path));
        if (wrapped) console.log(f.dim('  The report `bench import --json` wrote: the sheet under its "sheet" key is read.'));
        for (const item of sheetReportItems(r)) console.log(warnedLine(item) ? f.warn(`  ${item.text}`) : `  ${item.text}`);
        console.log('');
        console.log(failing
          ? f.warn(`${r.dropped.length} dropped, ${r.unknownKeys.length} unknown key${r.unknownKeys.length === 1 ? '' : 's'}, `
            + `${r.unreadable.length} listed unreadable${args.flags.check ? ' - --check fails' : ''}.`)
          : f.dim(`Nothing dropped, unknown or unreadable${r.gaps.length ? `; ${r.gaps.length} gap${r.gaps.length === 1 ? '' : 's'} left open to the search` : ''}.`));
        // The --class and --level this read needed travel with the commands
        // it suggests: a modkit dump names no class, and the suggestion
        // without it died on that very sentence.
        const needed = (r.format === 'modkit-inventory' && typeof args.flags.class === 'string' ? ` --class ${args.flags.class}` : '')
          + (args.flags.level != null && ownLevel(whole) == null ? ` --level ${args.flags.level}` : '');
        console.log(f.dim(`Every command that builds takes it as its build: bench sheet --import ${path}${needed}, `
          + `bench optimize --import ${path}${needed}.`));
        if (typeof jsonOut === 'string') {
          writeFileSync(jsonOut, JSON.stringify(report, null, 2));
          for (const line of readBack) console.log(line);
          console.log(f.dim(`wrote ${jsonOut}`));
        }
      }
      if (args.flags.check && failing) process.exitCode = 1;
      return;
    }

    let log;
    try { log = readAsLog(); } catch (e) {
      if (!(e instanceof CombatLogError)) throw e;
      // The reader names the file by its base name: that is the path typed.
      const name = basename(path);
      die(e.message.startsWith(name) ? `${path}${e.message.slice(name.length)}` : `${path}: ${e.message}`);
    }
    const report = { kind: 'log', dialect: log.dialect, stats: log.stats, problems: log.problems, notes: log.notes };
    if (toStdout) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const item of logReportItems(log)) console.log(warnedLine(item) ? f.warn(item.text) : item.text);
      // A summary given alone, with its timeline beside it: the events are there.
      if (!log.perEvent && existsSync(`${path}.timeline`)) {
        console.log(f.dim(`Its timeline is beside it: bench import ${path}.timeline reads the fight's events, with this summary.`));
      }
      if (typeof args.flags.class === 'string' || args.flags.level != null) {
        console.log(f.dim('--class and --level are read for a character sheet that does not carry them; a combat log names its own.'));
      }
      console.log('');
      console.log(log.problems.length
        ? f.warn(`${log.problems.length} problem${log.problems.length === 1 ? '' : 's'}${args.flags.check ? ' - --check fails' : ''}.`)
        : f.dim('No problem.'));
      // A log carries no build: verify takes one from the sheet of the
      // character it was fought by - or, for a modkit player, their dump.
      if (log.perEvent) {
        console.log(f.dim(`bench verify --capture ${path} --import <character sheet> holds the model against it, `
          + 'with the build it was fought in (with the modkit, the login dump stands in for the sheet).'));
      }
      if (typeof jsonOut === 'string') {
        writeFileSync(jsonOut, JSON.stringify(report, null, 2));
        console.log(f.dim(`wrote ${jsonOut}`));
      }
    }
    if (args.flags.check && log.problems.length) process.exitCode = 1;
  },

  /**
   * One fight, packed for the project: the build it was fought in and its
   * combat log, every name taken out, as one zip of fixed entries
   * (src/submit.mjs; docs/SUBMITTING.md is the player's account of it). It
   * prints what the zip holds and where it would go - the same lines the
   * UI's Send dialog shows - and does nothing else unless asked:
   *
   *   --log <file>        the fight, in any dialect combatlog.mjs reads; a
   *                       Wink <id>.json.timeline brings the <id>.json beside it
   *   --summary <file>    Wink's summary, named by hand
   *   --import <file>     the build as a sheet recorded it (--build <file>
   *                       reads a saved build the same way); without either,
   *                       the build as typed by flags (typedBuild)
   *   --note <text>, --keep-name   what the player adds, and keeps
   *   --zip [<file>]      save the bundle
   *   --send              upload it to the project's pCloud folder, its
   *                       receipt written first
   *   --receipt <file>    build it again as the bundle a receipt names
   *   --delete <receipt>  ask for the deletion of a fight sent earlier
   *
   * What may stand beside what is held in main() (submitUnread), before a
   * questlog link is fetched. Exit 0 when it did what was asked; 1, with one
   * sentence, when it refused or pCloud did.
   *
   * The two calls that reach the network (sendSubmission, deleteSubmission)
   * stand in this method's own body and nowhere else in the file: the suite's
   * "network call sites" group holds the tree to that.
   */
  async submit(args) {
    if (args._.length > 1) {
      die(`bench submit takes its files by flag, and "${args._[1]}" was given on its own: `
        + 'bench submit --log <combat log> --import <character sheet>');
    }

    // --- ask for the deletion of a fight sent earlier: its receipt, and
    // nothing built
    if (args.flags.delete != null) {
      if (args.flags.delete === true || args.flags.delete === '') {
        die('--delete needs the receipt the send wrote: bench submit --delete <receipt.json>');
      }
      let receipt;
      try {
        receipt = parseReceipt(readFileSync(args.flags.delete));
      } catch (e) {
        die(`--delete ${args.flags.delete}: ${e.message}`);
      }
      // Asked through this copy's own upload link and no other: a receipt
      // anyone could have written names any link, and its id and token go
      // there. src/submit.mjs deleteSubmission holds that rule - the UI's
      // Delete asks it too - and says how to ask through the receipt's link
      // when it is another (FAREVER_BENCH_UPLOAD_LINK).
      let link;
      try { link = uploadLink(); } catch (e) {
        if (!(e instanceof SubmissionError)) throw e;
        die(e.message);
      }
      try {
        await deleteSubmission(receipt, { link });
      } catch (e) {
        if (!(e instanceof SubmissionError)) throw e;
        die(e.message);
      }
      console.log(`Asked: the project's pCloud folder now holds a request to delete submission ${receipt.id.slice(0, 8)}. `
        + 'The maintainer deletes the fight and the request when they next read the folder; nothing of it was ever public. '
        + 'Asking again with the same receipt is harmless.');
      return;
    }

    // --- the flags, held to their shapes before a file is read
    for (const flag of ['send', 'keep-name']) {
      if (typeof args.flags[flag] === 'string') {
        die(`--${flag} takes no value, and "${args.flags[flag]}" was given after it - bench submit takes its files by flag (--log, --import)`);
      }
    }
    if (args.flags.log === true || args.flags.log === '') {
      die('--log needs the fight\'s file: a farever-combat-log (docs/COMBAT-LOG.md), or Wink\'s <id>.json.timeline');
    }
    if (args.flags.summary === true || args.flags.summary === '') die('--summary needs Wink\'s <id>.json, the summary saved beside its timeline');
    if (args.flags.note === true) die('--note needs its text: --note "the bee buff was up the whole fight"');
    if (args.flags.zip === '') die('--zip needs a file name, or nothing at all for the bundle\'s own');
    if (args.flags.receipt === true || args.flags.receipt === '') die('--receipt needs the receipt a send wrote: --receipt <receipt.json>');
    if (args.flags.import === true || args.flags.import === '') {
      die('--import needs a file: a character sheet, a build the bench saved, or a modkit inventory dump');
    }
    if (args.flags.build === true || args.flags.build === '') die('--build needs a file: a build the bench saved (optimize --json, the UI\'s Save build)');
    if (args.flags.import != null && args.flags.build != null) {
      die('--import and --build are both the build the fight was fought in - give one of them (bench submit reads a saved build the same way either way)');
    }
    if (args.flags.log == null && args.flags.summary == null) {
      die('bench submit needs the fight: --log <file> - a farever-combat-log (docs/COMBAT-LOG.md), gzipped or not, '
        + 'or Wink\'s <id>.json.timeline, whose <id>.json beside it is read with it');
    }

    // --- a receipt to build again from, read first. It is given to
    // buildSubmission whole (its `receipt`): its SHA-256 is what the rebuilt
    // bundle is held to, its sentAt says whether its fight arrived and its
    // link is where it may be sent - src/submit.mjs's rules, the UI's
    // `again` too. One that did arrive, or names another upload link, is
    // still built (--zip), and sendRefusal refuses to send it.
    let again = null;
    if (typeof args.flags.receipt === 'string') {
      try {
        again = parseReceipt(readFileSync(args.flags.receipt));
      } catch (e) {
        die(`--receipt ${args.flags.receipt}: ${e.message}`);
      }
    }

    // --- the build the fight was fought in. A file (--import, or --build
    // for a build the bench saved) goes as the file recorded it, which is
    // what the maintainer is to read: sheet.json leaves open what the file
    // left open (charsheet.mjs recordedSheet), and a pin typed beside it
    // is refused in main(). Without one, the build typed by flags, given
    // as a stated build - the input the UI's editor build goes as
    // (typedBuild) - and `hints` names the flag for what src sends empty.
    const sheetPath = typeof args.flags.import === 'string' ? args.flags.import : typeof args.flags.build === 'string' ? args.flags.build : null;
    const sheetFlag = args.flags.build != null ? '--build' : '--import';
    let engine;
    let sheet;
    let sheetOptions = null;
    let typedSaid = [];
    let typedHints = [];
    if (sheetPath) {
      const part = readSubmitPart(sheetPath, sheetFlag);
      engine = createEngine(engineOptions(args));
      sheet = { name: part.name, data: part.data };
      // What was typed beside the file, and nothing more: a modkit dump with
      // no --class takes the class its log gives it there, or is asked one
      // (src/submit.mjs buildSubmission, the rule the UI's Send reads it by).
      sheetOptions = {
        cls: typeof args.flags.class === 'string' ? args.flags.class : null,
        level: args.flags.level != null && args.flags.level !== true ? String(args.flags.level) : null,
      };
    } else {
      if (typeof args.flags.class !== 'string') {
        die('bench submit needs the build the fight was fought in: --import <character sheet> (bench import says what one holds) '
          + 'or --build <a build the bench saved>, or the build as bench sheet takes it (--class <class> with --pin and the rest)');
      }
      const s = commonSetup(args);
      engine = s.engine;
      const loadout = loadBuild(args, s.engine, s.level, s.saved);
      const pins = applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved });
      const typed = typedBuild(s.engine, loadout, pins, {
        rank: args.flags.rank != null && args.flags.rank !== true ? s.rank : null,
        typedLevel: args.flags.level != null && args.flags.level !== true,
        typedStars: args.flags.stars != null && args.flags.stars !== true,
      });
      sheet = typed.build;
      typedSaid = typed.said;
      typedHints = typed.hints;
    }

    // --- the fight. Wink saves one as two files, and the timeline alone
    // carries no start time: the summary beside it is read with it unless
    // another is named.
    const logIn = typeof args.flags.log === 'string' ? readSubmitPart(args.flags.log, '--log') : null;
    const summaryPath = typeof args.flags.summary === 'string' ? args.flags.summary : null;
    const beside = !summaryPath && logIn ? besideSummary(args.flags.log) : null;
    const summaryIn = summaryPath ? readSubmitPart(summaryPath, '--summary') : (beside?.part ?? null);

    const input = {
      sheet,
      sheetOptions,
      log: logIn,
      summary: summaryIn,
      note: typeof args.flags.note === 'string' ? args.flags.note : null,
      keepName: args.flags['keep-name'] === true,
    };
    // The bundle a receipt names, built again (its id, key, time, SHA-256,
    // sentAt and link): the same zip or none - buildSubmission refuses
    // another one under its id, which names one bundle.
    let sub;
    try {
      sub = buildSubmission(engine, again ? { ...input, receipt: again } : input);
    } catch (e) {
      if (!(e instanceof SubmissionError)) throw e;
      // A refusal of the receipt itself (src's `receipt` fact), named by its flag.
      if (e.receipt === true) {
        die(`--receipt ${args.flags.receipt}: ${e.message}\n  bench submit --delete ${args.flags.receipt} asks for the deletion of what it sent.`);
      }
      // That refusal, said with the flags that act on it. It is that one when
      // the same files and flags pack as a new bundle: the receipt is then
      // the only thing they do not match. (Nothing promises that the same
      // files build the receipt's bundle again: after an update of the game
      // or of the bench they make another one - src's sentence says both.)
      let packs = false;
      if (again?.zipSha256 && e.status === 400) {
        try { buildSubmission(engine, input); packs = true; } catch { packs = false; }
      }
      if (packs) {
        die(`--receipt ${args.flags.receipt}: ${e.message}\n`
          + `  bench submit --delete ${args.flags.receipt} asks for the first one's deletion, and the same command without --receipt `
          + 'packs these as a new submission.');
      }
      die(e.message);
    }

    // --- what the zip holds, and where it would go. The readers' own
    // reports follow, and they name what the player's files named - the
    // player's own screen, not the bundle - so a line says so above them.
    console.log(f.header(engine, VERSION) + '\n');
    if (!sheetPath) {
      console.log(f.dim('The build goes as the flags typed it: a sheet of what they stated, and each Gap in its report below is a part '
        + 'no flag stated - sent as not recorded, not as empty.'));
    }
    for (const line of typedSaid) console.log(f.warn(`note: ${line}`));
    if (!sheetPath || typedSaid.length) console.log('');
    if (beside) {
      // Said from what was packed: a summary beside the timeline that the
      // log reader did not take is not "read with it".
      const packed = sub.files.some((x) => x.name === 'summary.json');
      console.log(f.dim(packed
        ? `--summary ${beside.path}: Wink's summary beside the timeline, read with it - it carries the fight's start time (--summary <file> names another).`
        : beside.part
          ? `${beside.path} is beside the timeline and was not taken as its summary - the Problem lines below say why; the log goes without it (--summary <file> names another).`
          : `${beside.path} is beside the timeline and could not be read (${beside.why}) - the log goes without its summary (--summary <file> names one).`) + '\n');
    }
    if (again) {
      console.log(f.dim(`--receipt ${args.flags.receipt}: built again as submission ${again.id}, made ${again.createdAt} - `
        + (again.zipSha256
          ? `the same zip, byte for byte, as the one the receipt was written for (SHA-256 ${sub.zipSha256}).`
          : 'the receipt carries no SHA-256 of its bundle, so whether these are the same files is not checked: '
            + 'other files would put a second, different bundle under this id in the project\'s folder.')) + '\n');
    }
    // --- where Send would go, read once. The upload link: one set that is
    // none is said as what it is (uploadLink()'s sentence, which --send dies
    // with below), never as "no upload link is set". And what src/submit.mjs
    // sendRefusal refuses to send - a receipt whose fight arrived, a receipt
    // written for another upload link than this copy's (or for one, when this
    // copy has none), a sheet of one class with a log of another (unless the
    // --class typed beside a file that names its own class names the same:
    // buildSubmission decided that from sheetOptions) - the rule the UI's
    // Send asks too. Said first in the report, as the UI's preview says it,
    // in a dry run as well: its closing line must not offer --send for a
    // bundle --send refuses.
    let link = null;
    let uploadProblem = null;
    try {
      link = uploadLink();
    } catch (e) {
      if (!(e instanceof SubmissionError)) throw e;
      uploadProblem = e.message;
    }
    const refused = sendRefusal(sub, { front: 'cli', link });

    // The report in the command line's words (--send, --zip), each line
    // coloured by its kind; the readers' own reports open at the first heading.
    // (After the module's own first two lines when the link set is none:
    // its Problem line and the manual route "until that link is set right".)
    const report = submitReportItems(sub, { front: 'cli', link, uploadProblem });
    if (refused) {
      report.splice(uploadProblem ? 2 : 0, 0, {
        kind: 'refused', text: `Problem: ${/[.!?]$/.test(refused.message) ? refused.message : `${refused.message}.`}`, warn: true,
      });
    }
    const ownFiles = report.findIndex((i) => i.kind === 'heading');
    for (let i = 0; i < report.length; i++) {
      if (i === ownFiles) {
        console.log(f.dim('Below, what the bench read in your own files, for you to check. It is not sent as written: '
          + 'the "Names" line above says which names the bundle carries.'));
      }
      console.log(warnedLine(report[i]) ? f.warn(report[i].text) : report[i].text);
    }
    // The flag that names what a Problem line above says the typed build
    // sends empty, or does not send (typedBuild).
    for (const hint of typedHints) console.log(f.dim(hint));
    if (!sub.manifest.log.perEvent) {
      const timeline = [args.flags.log, args.flags.summary].filter((p) => typeof p === 'string').map((p) => `${p}.timeline`).find(isFileAt);
      if (timeline) console.log(f.dim(`Its timeline is beside it: --log ${timeline} sends every hit, with this summary.`));
    }

    // --- where it goes. Whatever would stop the run is asked before
    // anything is written, so a refusal leaves the folder as it was: a --zip
    // over a file it must not replace; and with --send, an upload link set
    // and readable, what src/submit.mjs sendRefusal refuses to send (both
    // read above), a receipt of another submission standing where this
    // one's goes.
    const zipPath = args.flags.zip == null ? null : args.flags.zip === true ? sub.zipName : args.flags.zip;
    if (zipPath != null) {
      const wrong = zipTargetProblem(zipPath, [
        ['the fight\'s log (--log)', args.flags.log],
        [beside ? 'the summary beside the timeline' : 'the summary (--summary)', summaryPath ?? beside?.path],
        [`the build (${sheetFlag})`, sheetPath],
        ['the receipt --receipt names', args.flags.receipt],
      ]);
      if (wrong) die(wrong);
    }
    let receiptPath = null;
    let standing = null;
    if (args.flags.send) {
      if (uploadProblem) die(uploadProblem);
      // What is not sent is src/submit.mjs sendRefusal's to say (read
      // above). Refused here, before anything is written, and in
      // sendSubmission's order: before whether there is a link at all. Said
      // as it is: its remedy is in the command line's words.
      if (refused) die(refused.message);
      if (link) {
        receiptPath = again ? args.flags.receipt : submitReceiptPath(sub, zipPath);
        standing = receiptStanding(receiptPath, sub);
      }
    }

    // --- saved
    if (zipPath != null) {
      try {
        writeFileSync(zipPath, sub.zip);
      } catch (e) {
        die(`--zip ${zipPath}: ${e.message}`);
      }
      console.log(`\nSaved ${zipPath}: ${sub.zipBytes.toLocaleString('en-US')} bytes, SHA-256 ${sub.zipSha256}.`);
      if (!args.flags.send) {
        console.log(f.dim(`By hand, attach it to a new issue: ${sub.formUrl} - on that route every file in it, and the file's own name, is public.`));
      }
    }
    if (!args.flags.send) {
      // What --send would do with it, as the report above said it: sent,
      // refused (sendRefusal), or off - for no link, or for one that is none.
      // A bundle --receipt built again is that receipt's submission, under
      // its id; any other run packs a new one.
      if (zipPath == null) {
        const id = again
          ? `it is submission ${again.id.slice(0, 8)}, built again under the id --receipt ${args.flags.receipt} names `
            + '(without --receipt, a run packs it anew, under a new id)'
          : 'each run packs it anew, under a new id';
        if (link) {
          console.log(f.dim('\nNothing was saved or sent. --zip [<file>] saves this bundle; '
            + `${refused ? '--send refuses it - the first Problem line above says why' : '--send sends it'}. ${id[0].toUpperCase()}${id.slice(1)}.`));
        } else {
          console.log(f.dim(`\nNothing was saved or sent. --zip [<file>] saves this bundle (${id}); `
            + (uploadProblem
              ? '--send is off until the upload link is set right (the first Problem line above says what is wrong with it) - the route '
                + `meanwhile is --zip, then the GitHub form: ${sub.formUrl}`
              : `--send is not available in this copy (no upload link is set) - the route is --zip, then the GitHub form: ${sub.formUrl}`)));
        }
      }
      return;
    }

    // --- sent
    if (!link) {
      die(zipPath
        ? `Send is off in this copy of the bench (no upload link is set) - ${zipPath} is saved: attach it to a new issue: ${sub.formUrl}`
        : `Send is off in this copy of the bench (no upload link is set) - save the .zip (--zip <file>) and attach it to a new issue: ${sub.formUrl}`);
    }
    // THE RECEIPT FIRST. A send whose answer is lost - a timeout, a dropped
    // connection - may still have put the fight in the project's folder, and
    // the receipt is the player's one way to ask for its deletion: it is on
    // disk before a byte leaves, and completed after. A receipt --receipt
    // named stands already, and is only ever completed.
    if (!standing) {
      try {
        mkdirSync(dirname(receiptPath), { recursive: true });
        writeReceipt(receiptPath, pendingReceipt(sub, { link }));
      } catch (e) {
        if (e instanceof SubmissionError) die(e.message);
        die(`The receipt could not be saved as ${receiptPath} (${e.message}) - nothing was sent: the deletion of a fight sent with no receipt `
          + 'could not be asked for.');
      }
    }
    console.log(`\nSending to the project's pCloud folder - the receipt ${receiptPath} is saved first.`);
    let receipt;
    try {
      // (sendSubmission asks sendRefusal again, in the same words.)
      receipt = await sendSubmission(sub, { link, benchVersion: VERSION, front: 'cli' });
    } catch (e) {
      if (!(e instanceof SubmissionError)) throw e;
      // Refused by pCloud (src/submit.mjs: `arrived: false`, and no
      // receipt): with nopartial=1 nothing of the zip was kept. A receipt
      // this run saved would ask for nothing, and left standing it would
      // refuse the next run's - it goes. One --receipt named is the first
      // send's, and stays. Asked first: such a refusal carries no receipt,
      // like the one below that never left.
      if (e.arrived === false) {
        const said = /nothing was (?:kept|sent)/.test(e.message) ? e.message : `${e.message} Nothing of this send was kept.`;
        if (standing) {
          die(`${said}\nThe receipt ${receiptPath} is kept: it still asks for the first send's deletion if that one arrived `
            + `(bench submit --delete ${receiptPath}).`);
        }
        let removed = false;
        try { unlinkSync(receiptPath); removed = true; } catch { /* said below */ }
        die(said + (removed ? '\nThe receipt saved before sending is removed: no fight arrived under its id.'
          : `\nThe receipt ${receiptPath} asks for nothing: no fight arrived under its id.`));
      }
      // Refused before the request left: there is nothing to ask for.
      if (!e.receipt) {
        if (!standing) {
          try { unlinkSync(receiptPath); } catch { /* it would ask for nothing: no fight carries its id */ }
        }
        die(e.message);
      }
      die(`${e.message}\n`
        + `The receipt is ${receiptPath}${standing ? '' : ' (saved before sending)'}: `
        + (again ? 'the same command, as typed, sends the same bundle again' : `the same command with --receipt ${receiptPath} sends the same bundle again`)
        + `, and bench submit --delete ${receiptPath} asks for the fight's deletion.`);
    }
    try {
      writeReceipt(receiptPath, receipt);
    } catch (e) {
      console.error(f.warn(`The receipt could not be written as ${receiptPath} (${e.message}). Here it is - save it as a file, it is how this fight's `
        + 'deletion is asked for:\n') + receiptText(receipt));
    }
    console.log(`Sent: submission ${receipt.id.slice(0, 8)} is in the project's pCloud folder as ${receipt.uploadedAs} `
      + `(${sub.zipBytes.toLocaleString('en-US')} bytes, SHA-256 ${sub.zipSha256}). Only the maintainer can read it; nothing was made public.`);
    console.log(`Receipt: ${receiptPath} - keep it. bench submit --delete ${receiptPath} asks for this fight's deletion; anyone holding the file can do that, `
      + 'and nothing else with it.');
  },

  // Hold the model against the record. Every other command reports what the
  // bench BELIEVES; this one reports where that belief disagrees with what the
  // game actually did, per skill, signed.
  async verify(args) {
    // `rank` is weapon mastery, and it is not decoration: a script that opens
    // `if (rank >= 3)` is invisible below it. On the accepted build
    // Daggers_DuplicatePoison_Skill1's whole bonus-damage hook sat behind that
    // gate, and evaluating at the default rank of 1 silently priced a quarter
    // of the build's damage at zero. (Build 25782799 emptied that row's script;
    // 109 others in the sheet still test `rank >= 3`.) Every other command
    // takes this from commonSetup; so does this one.
    const { engine, rank, mix, targetLevel, policy: authoredPolicy, fight: fightSetup } = commonSetup(args);
    const game = requireGame(args._);
    // An imported sheet as the build, a combat log as the capture (verifySources).
    const { imported, combatLog } = verifySources(args, game, engine);
    const character = args.flags.character ?? args.flags.char ?? combatLog?.handle;
    if (typeof character !== 'string') {
      die('verify needs --character <Name> - the character the capture recorded.\n'
        + `Known in this install: ${listCharacters(game).join(', ') || '(none)'}`);
    }

    // Which log. The probe's file is rotated when the game is patched - the
    // old one renamed beside it, a new one started at the next boot - so the
    // default path may not exist yet, and an older log beside it is another
    // build's. Reading that one is a decision (--capture <file>), never a
    // fallback: the ledger below would wear the patch as a model error.
    const captureFile = resolveCapture(game, typeof args.flags.capture === 'string' ? args.flags.capture : null);
    const capturePath = captureFile.path;
    const otherLogs = () => describeOtherCaptures(captureFile)
      + (captureFile.others.length ? ' verify says which build its window was recorded on.' : '');
    if (!captureFile.exists) {
      die(describeMissingCapture(captureFile)
        + (captureFile.others.length ? ' verify says which build its window was recorded on.' : ''));
    }

    const wantLevel = args.flags.level != null && args.flags.level !== true ? Number(args.flags.level) : null;
    const wantClass = typeof args.flags.class === 'string' ? args.flags.class : null;

    // A build snapshot written INTO the capture beats the modkit's login-time
    // dump on every axis that matters: it is contemporaneous with the damage,
    // and it carries the talents the dump has no field for. Use one when the
    // probe has written one, unless --dump says otherwise.
    const snaps = args.flags.dump ? { snapshots: [] } : await snapshots(capturePath, { source: character });
    // Choosing between snapshots takes two rules, and they are in this order for
    // a reason.
    //
    // FIRST, how much of a build it actually describes - counted as gear that
    // resolves to something wearable in a combat slot. An early probe build read
    // the backpack instead of the equipment, so a capture can hold snapshots
    // whose "build" is one net and a pile of soulstones. Those are not builds,
    // and no amount of damage recorded under them makes them one.
    //
    // ONLY THEN, how much damage was recorded under it - because the last
    // snapshot of a session is written as the player logs out and has nothing
    // after it at all.
    const combatSlots = new Set(engine.cat.combatSlots().map((s) => s.id));
    const describes = (s) => (s.gear ?? []).reduce((n, g) => {
      const item = engine.cat.itemById.get(g.kind);
      return n + ((item?.slots ?? []).some((x) => combatSlots.has(x)) ? 1 : 0);
    }, 0);

    const usable = snaps.snapshots
      .map((s) => ({ s, slots: describes(s) }))
      .filter((c) => c.slots >= 5);
    // Then by how COMPLETE the description is - sockets and affixes each count,
    // because each was added by a later probe build and a capture spans several.
    // A snapshot missing either cannot be scored properly: without sockets the
    // model loses the augments and the item levels they carry, and without
    // affixes the sheet cannot be checked at all.
    //
    // Only then by how much damage was recorded under it, since the last
    // snapshot of a session is written as the player logs out.
    // Each richness point is a probe generation: sockets and affixes arrived
    // with v3, the weapon-skill selection with v4 - and a snapshot that
    // carries the selection beats one that merely saw more damage, because
    // the selection is the build fact the older snapshot CANNOT have.
    const richness = (x) => ((x.sockets ?? []).length ? 1 : 0) + ((x.affixes ?? []).length ? 1 : 0)
      + (x.weaponSkills && Object.keys(x.weaponSkills).length ? 1 : 0)
      + (x.runes ? 1 : 0);
    // When the run verifies against ONE target, the evidence that matters is
    // events ON that target: a dummy calibration followed by a rift leaves
    // the newest snapshot rich in everything except dummy hits, and a
    // target-blind pick chose it - the whole ledger came back PHANTOM.
    //
    // `--target` is the capture FILTER: hits on that unit. A capture names
    // its targets by unit id, so a shortcut is read through to the unit
    // behind it (`dummy` is Dummy) and a mode suffix is the model's business
    // only (`Ratsar@heroic` filters on Ratsar). What the model is priced
    // against is a second question - see modelTarget below - and `--price-as`
    // answers it separately when the two must differ.
    //
    // ...and a unit id is not ONE target either. `--target Dummy#2180` names an
    // INSTANCE as the capture writes it: the rows are that instance's alone
    // and the model stands on the unit. Without one, a read on a unit is held
    // to the instance the character was fighting at each moment (see where
    // the capture is read, below).
    const rawTarget = typeof args.flags.target === 'string' ? args.flags.target : null;
    const instanceOf = rawTarget ? /^([^#@]+)#(-?\d+)(@[a-z]+)?$/.exec(rawTarget) : null;
    const wantTarget = instanceOf ? instanceOf[1] + (instanceOf[3] ?? '') : rawTarget;
    const wantPriceAs = typeof args.flags['price-as'] === 'string' ? args.flags['price-as'] : null;
    let wantArchetype = null;
    if (wantTarget) {
      let asFoe = null;
      try { asFoe = engine.combat.foe(wantTarget, engine.ctx.consts.maxLevel); } catch (e) {
        // Not something the model can stand on. As a pure filter that is
        // fine - any archetype in the log can be read - provided the model
        // is told what to stand on instead.
        if (!wantPriceAs) die(e.message);
      }
      if (asFoe && !asFoe.unit) {
        die(`--target ${wantTarget} is not a unit, so no capture row is a hit on it.\n`
          + `Filter the capture with --target <unit id> and price the model with --price-as ${wantTarget}.`);
      }
      // A shortcut that carries a MODE is not one either. `heroic` stands on
      // whichever heroic boss the sheet lists first and speaks for all of
      // them: as a filter it would read the hits on that one boss - at any
      // difficulty, the capture cannot tell - drop the other bosses', and
      // price what it kept on heroic rows.
      const shortcut = engine.combat.namedTargets[wantTarget.replace(/@[a-z]+$/, '')];
      if (asFoe && shortcut?.mode) {
        const stoodOn = engine.combat.heroicBosses.includes(asFoe.unit) ? engine.combat.heroicBosses : [asFoe.unit];
        die(`--target ${wantTarget} is not one unit: it is what ${stoodOn.length} units resolve to in ${shortcut.mode} mode `
          + `(${stoodOn.join(', ')}), so it cannot say which capture rows to read.\n`
          + `Filter the capture with --target <unit id> and price the model with --price-as ${wantTarget}, `
          + `or say both at once with --target <unit id>@${shortcut.mode}.`);
      }
      wantArchetype = asFoe?.unit ?? wantTarget.replace(/@[a-z]+$/, '');
    }
    // The instance as the capture spells it: the unit's own id and the number.
    const wantInstance = instanceOf ? `${wantArchetype}#${instanceOf[2]}` : null;
    if (wantPriceAs) {
      try { engine.combat.foe(wantPriceAs, engine.ctx.consts.maxLevel); } catch (e) { die(`--price-as: ${e.message}`); }
    }
    const evidence = (x) => (wantArchetype ? (x.targets?.[wantArchetype] ?? 0) : x.events);
    // WHICH PIECE OF THE CAPTURE, when the caller says: --since / --until are
    // one range, each --window <from>..<to> another, all in the capture's own
    // epoch milliseconds (verify.mjs parseWindows). A given window is priced
    // with the snapshot STANDING when it opens - not with whichever snapshot
    // saw the most damage - and --snapshot names the build outright
    // (verify.mjs chooseSnapshot). Left alone, the choice below stands as it
    // always has: the richest snapshot with evidence on the target, and its
    // own span as the window.
    const asked = parseWindows({
      since: args.flags.since ?? null, until: args.flags.until ?? null, windows: args.repeated?.window ?? [],
    });
    if (asked.error) die(asked.error);
    // A combat log is one fight: its own span is the window (logSpanWindow).
    const logSpan = logSpanWindow(combatLog, capturePath, asked, args);
    if (logSpan) asked.windows = [logSpan];
    const isEquipment = (kind) => (engine.cat.itemById.get(kind)?.slots ?? []).some((x) => combatSlots.has(x));
    const differ = (a, b) => buildDiff(a, b, { relevant: isEquipment });
    const stamp = (ms) => (ms == null ? 'open' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}Z (${ms})`);
    // --snapshots: the character's snapshots, one line each, and what each
    // changed. A capture recorded for a purpose is walked one build at a time
    // (the 2026-10-13 Rogue: eighteen snapshots, one talent point apart), and
    // this is the list a window and a --snapshot number are read off.
    if (args.flags.snapshots) {
      const all = snaps.snapshots;
      if (args.flags.json) {
        console.log(JSON.stringify(all.map((x, i) => ({
          index: x.index, ts: x.ts, until: x.until, events: x.events, onTarget: evidence(x),
          usable: describes(x) >= 5, talents: x.talents, changed: i ? differ(all[i - 1], x) : null,
        })), null, 2));
        return;
      }
      console.log(f.bold(`${character} - ${all.length} snapshot(s) in ${capturePath}`));
      if (!all.length) console.log(f.dim('  none: the probe wrote no build for this character in this log.'));
      for (const [i, x] of all.entries()) {
        const changed = i ? differ(all[i - 1], x) : null;
        console.log(`  #${String(x.index).padEnd(3)} ${stamp(x.ts)}  until ${x.until == null ? 'the end of the log' : stamp(x.until)}`);
        console.log(f.dim(`       ${x.events.toLocaleString()} damage rows under it`
          + (wantArchetype ? `, ${evidence(x).toLocaleString()} on ${wantArchetype}` : '')
          + `; ${describes(x)} worn pieces, ${x.talents.length} talent rows`
          + (describes(x) >= 5 ? '' : ' - too little gear to price a build')));
        if (changed) {
          console.log(f.dim(changed.length
            ? `       against #${all[i - 1].index}: ${changed.join('; ')}`
            : `       the same build as #${all[i - 1].index} (a snapshot is also written at every login)`));
        }
      }
      console.log(f.dim('\nPrice a window with one of them: --snapshot <n>, with --since / --until or --window <from>..<to> '
        + 'for the rows.\nLeft out, a given window is priced with the snapshot standing when it opens.'));
      return;
    }
    const usableSet = new Set(usable.map((c) => c.s));
    const chosen = chooseSnapshot({
      snaps: snaps.snapshots.map((x) => Object.assign(x, { usable: usableSet.has(x) })),
      windows: asked.windows,
      want: args.flags.snapshot != null && args.flags.snapshot !== true ? String(args.flags.snapshot)
        : args.flags.snapshot === true ? '' : null,
      differ,
    });
    if (chosen.error) die(chosen.error);
    // A snapshot with NOTHING recorded on the verified target cannot win on
    // richness: a login-and-out snapshot carries the newest probe fields and
    // zero combat, and it once out-ranked a two-thousand-event window on the
    // strength of its empty rune list.
    const withEvidence = usable.filter((c) => evidence(c.s) > 0);
    const pickFrom = withEvidence.length ? withEvidence : usable;
    const snap = chosen.snap ?? (pickFrom.length
      ? pickFrom.reduce((best, c) => {
        if (c.slots !== best.slots) return c.slots > best.slots ? c : best;
        const cr = richness(c.s);
        const br = richness(best.s);
        if (cr !== br) return cr > br ? c : best;
        return evidence(c.s) > evidence(best.s) ? c : best;
      }).s
      : null);
    // --- where the build comes from: an imported sheet, that snapshot, or the dump --
    // One value from here on. `buildSnap` is the snapshot the build is read
    // off: null for an import, whose sheet IS the build, and for the dump. An
    // import takes no window from a snapshot either - unless --snapshot names
    // one, whose span is then the window, as a given one.
    const buildSnap = imported ? null : snap;
    if (imported && args.flags.snapshot != null && snap && !asked.windows) asked.windows = [{ from: snap.ts, to: snap.until ?? null, snapshot: snap.index }];
    // --- end of where the build comes from ---------------------------------------
    // Falling back is fine; falling back QUIETLY is not. A capture that holds
    // snapshots for this character which none of them can be used is a probe
    // problem, and the run must not read as though no snapshot was ever taken.
    const snapNote = (!buildSnap && !imported && snaps.snapshots.length)
      ? `${snaps.snapshots.length} snapshot(s) for ${character} are in the capture but carry no gear `
        + '- an older probe build. Falling back to the login dump; re-capture to use them.'
      : null;

    let built;
    let runeNote = null;
    if (imported) {
      // The imported sheet, as the object the rest of this command reads
      // off a dump or a snapshot. A typed --level re-levels it, as it does
      // a --build file (loadBuild).
      built = builtFromSheet(imported.imported, loadBuild(args, engine, wantLevel, imported));
    } else if (snap) {
      // The snapshot has no runes, so the class still comes from the dump when
      // there is one - same character, and the class does not change.
      let unit = wantClass;
      if (!unit) {
        try { unit = toLoadout(engine.cat, readDump(game, character)).unit; } catch { unit = null; }
      }
      if (!unit) die(`${character} has a capture snapshot but no rune list to name the class - pass --class.`);
      built = fromSnapshot(engine.cat, snap, { level: wantLevel, unit });
      // Runes: a v5 snapshot carries the SLOTTED set (per-skill masteries,
      // what hasMastery answers) and stands alone. Only when the capture
      // predates v5 do runes ride in from the modkit's jobs dump - which
      // lists every rune KNOWN, slotted or not, and is still better than
      // pricing every rune-gated step as not taken: RadiantVerdict's whole
      // 8-second zone is behind its M1 rune, and the row read +158% per hit
      // against a live mean that is mostly zone ticks.
      let runeSource = built.runesKnown ? 'snapshot' : null;
      // Runes belong to the character more than to the moment: when the
      // WINDOW's snapshot predates the rune probe, the nearest snapshot that
      // does carry the authoritative set (a later login is enough to write
      // one) beats the jobs dump's known-runes list outright - it is the
      // same character and the slotted truth, just read on a different day.
      if (!built.runesKnown) {
        const runed = snaps.snapshots
          .filter((x) => x.runes)
          .sort((a, b) => Math.abs(a.ts - snap.ts) - Math.abs(b.ts - snap.ts))[0];
        if (runed) {
          const known = new Set();
          for (const row of engine.cdb.lines('skill')) {
            for (const m of row.mastery ?? []) if (m?.id) known.add(m.id);
          }
          built.loadout.runes = {};
          for (const r of runed.runes) if (known.has(r.id)) built.loadout.runes[r.id] = r.id;
          built.runesKnown = true;
          runeSource = 'nearest-snapshot';
        }
      }
      if (!built.runesKnown && !Object.keys(built.loadout.runes ?? {}).length) {
        try {
          built.loadout.runes = toLoadout(engine.cat, readDump(game, character)).loadout.runes ?? {};
          if (Object.keys(built.loadout.runes).length) runeSource = 'dump';
        } catch { /* no dump - the snapshot stands alone */ }
      }
      // Capture-proven overrides. Two reasons to need one: a pre-v5 capture
      // has no slotted truth at all, and a v5 cache read can be stale-EMPTY
      // (the per-instance masteries cache is skipped on client replicas -
      // Emsai's Surging Force decomposed only WITH its M3 in the same window
      // the snapshot claimed zero runes). `--rune A,B` slots them on top of
      // whatever the sources above produced.
      const runeOverrides = (args.repeated?.rune ?? [])
        .flatMap((v) => String(v).split(',')).map((x) => x.trim()).filter(Boolean);
      if (runeOverrides.length) {
        const known = new Set();
        for (const row of engine.cdb.lines('skill')) {
          for (const m of row.mastery ?? []) if (m?.id) known.add(m.id);
        }
        built.loadout.runes ??= {};
        for (const id of runeOverrides) {
          if (!known.has(id)) die(`--rune ${id}: no skill in the data carries a mastery by that id`);
          built.loadout.runes[id] = id;
        }
        runeSource = (runeSource ? runeSource + '+' : '') + 'override';
      }
      if (runeSource === 'dump') {
        runeNote = 'runes: from the jobs dump, which lists what is KNOWN, not what is slotted - '
          + 'rune-gated rows may be phantom (FaithfulWinds was). Re-capture with probe v5+ for the slotted truth.';
      }
    } else {
      // A combat log carries no build. A player without the modkit has no
      // dump either, and the dump's own sentence never named the way out.
      let dump;
      try { dump = readDump(game, character); } catch (e) {
        if (!combatLog) throw e;
        die(`${e.message}\nA combat log carries no build: give the one it was fought in with --import <character sheet> `
          + '(bench import <file> says what a sheet holds).');
      }
      built = toLoadout(engine.cat, dump, { level: wantLevel, unit: wantClass });
    }
    // The character a combat log names, against the build (logCharacterNote), and what its reader said of it.
    const logLevelNote = logCharacterNote(engine, combatLog, built, {
      capturePath, wantClass, importPath: imported?.path ?? null, imported: imported?.imported ?? null,
    });
    const logSaid = logFindings(combatLog);

    // THE MECHANIC SLOTS (conduits, prayers), when nothing carried them. A
    // snapshot writes what they hold where the probe can read it; where it
    // cannot (probe v10 on build 25782799: `snap_err conduit`), the model
    // would fill a pool that allows repeats with its options in turn, and
    // price conduits the character does not slot. So such a pool is filled
    // from what the character's own rows show under the snapshot
    // (verify.mjs fillFromEvidence), `--skills <pool>=<a,b,...>` names it
    // outright - the spelling the build commands use - and the ledger says
    // which of the three it is standing on.
    const poolFacts = [];
    {
      let pools = [];
      try { pools = engine.plan.pools(built.loadout); } catch { pools = []; }
      const nameOf = (id) => engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
      const count = (ids) => [...new Set(ids)].map((id) => {
        const n = ids.filter((x) => x === id).length;
        return `${nameOf(id)}${n > 1 ? ` x${n}` : ''}`;
      }).join(', ');
      built.loadout.skills ??= {};
      for (const spec of args.repeated?.skills ?? []) {
        if (spec === true) die('--skills needs a value, e.g. --skills conduits=Mage_Conduit_Power,Mage_Conduit_Power');
        const eq = String(spec).indexOf('=');
        if (eq < 0) die(`--skills "${spec}" needs the form pool=skill,skill`);
        const alias = new Map(pools.flatMap((p) => [
          [p.key.toLowerCase(), p], [f.short(p.key).toLowerCase(), p],
          [p.label.replace(/\s+/g, '').toLowerCase(), p], [(p.mechanic ?? '').toLowerCase(), p],
        ].filter(([k]) => k)));
        const pool = alias.get(spec.slice(0, eq).trim().toLowerCase());
        if (!pool) {
          die(`--skills: ${character} has no skill pool "${spec.slice(0, eq)}" `
            + `(one of ${pools.map((p) => p.label.replace(/\s+/g, '')).join(', ') || 'none'})`);
        }
        const picks = spec.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean);
        for (const id of picks) {
          if (!pool.options.includes(id)) die(`--skills: ${id} is not one of the ${pool.label} (${pool.options.join(', ')})`);
        }
        if (picks.length > pool.slots) {
          die(`${pool.label}: only ${pool.slots} slot${pool.slots === 1 ? '' : 's'} at level ${built.level}, but ${picks.length} were named`);
        }
        if (!pool.repeats && new Set(picks).size !== picks.length) die(`${pool.label}: an option fills one slot only`);
        built.loadout.skills[pool.key] = picks;
        poolFacts.push({
          key: pool.key, label: pool.label, how: 'named', fill: picks,
          note: `${pool.label}: ${count(picks)} - named with --skills`,
        });
      }
      if (buildSnap) {
        const runes = new Set(Object.values(built.loadout.runes ?? {}).flat().filter(Boolean));
        for (const p of pools) {
          if (p.kind !== 'mechanic' || !p.repeats || built.loadout.skills[p.key]?.length) continue;
          const options = p.options.map((id) => {
            let statuses = [];
            try { statuses = engine.plan.statusesOf(id, { rank, runes }).self.map((b) => b.status); } catch { statuses = []; }
            return { id, statuses };
          });
          const evidence = await mechanicEvidence(capturePath, {
            source: character, since: snap.ts, until: snap.until ?? null,
            skills: p.options, statuses: options.flatMap((o) => o.statuses),
          });
          const got = fillFromEvidence({ slots: p.slots, options, evidence });
          const defaulted = engine.plan.defaultSelection(built.loadout)[p.key] ?? [];
          const saw = got.seen.map((s) => `${nameOf(s.id)}: `
            + [s.hits ? `${s.hits.toLocaleString()} hits` : null,
              s.applied ? `its status applied ${s.applied.toLocaleString()} times`
                + (s.perEvent ? `, ${s.perEvent} stack${s.perEvent > 1 ? 's' : ''} at a time` : '') : null]
              .filter(Boolean).join(', ')).join('; ');
          const unseen = p.options.filter((id) => !got.seen.some((s) => s.id === id)).map(nameOf);
          if (got.fill) {
            built.loadout.skills[p.key] = got.fill;
            poolFacts.push({
              key: p.key, label: p.label, how: 'rows', fill: got.fill, exact: got.exact, seen: got.seen,
              note: `${p.label}: the snapshot does not say what the ${p.slots} slots hold; filled from ${character}'s own rows under it - `
                + `${count(got.fill)} (${saw}${unseen.length ? `; no row of ${unseen.join(', ')}` : ''})`
                + (got.exact ? '' : '. How many slots each holds is not in the rows: they take turns')
                + `. --skills ${p.label}=<a,b,...> names them outright.`,
            });
          } else {
            poolFacts.push({
              key: p.key, label: p.label, how: 'default', fill: defaulted, seen: got.seen,
              note: `${p.label}: the snapshot does not say what the ${p.slots} slots hold, and ${character}'s rows under it do not settle it `
                + `(${saw || 'no hit and no status of any option'}). The model fills them in turn - ${count(defaulted)} - `
                + `and a line of one the character did not slot is not this ledger's evidence. --skills ${p.label}=<a,b,...> names them.`,
            });
          }
        }
      }
    }

    // A capture is many hours across many builds; the dump is one instant. The
    // default window is the character's last few play sessions, because that is
    // the stretch most likely to have been played in the gear they are wearing
    // now. Comparing against the whole file reads their entire back catalogue
    // of weapons as missing coverage - the first run of this command did.
    const wantSessions = args.flags.sessions != null && args.flags.sessions !== true
      ? Number(args.flags.sessions) : 3;
    // A GIVEN window stands as given: its rows are whatever falls in the
    // ranges, and `since` / `until` below are its outer ends (what the build
    // check and a replay read).
    let windows = asked.windows;
    let since = windows ? windows[0].from : null;
    let until = windows ? windows.reduce((m, w) => (w.to == null || m == null ? null : Math.max(m, w.to)), -Infinity) : null;
    if (until === -Infinity) until = null;
    let window = windows ? { given: true, ranges: windows, ...(logSpan ? { fromLog: true } : {}) } : null;
    // A snapshot IS the window: the build it describes stands from the moment it
    // was written until the next one. That is a far better boundary than "the
    // last few sessions", which was only ever a guess at when the gear last
    // changed.
    if (!windows && buildSnap) {
      since = snap.ts;
      until = snap.until;
      window = {
        fromSnapshot: true,
        events: snap.events,
        seconds: until ? (until - snap.ts) / 1000 : null,
      };
    }
    if (!windows && since === null) {
      const s = await sessions(capturePath, { source: character, gapMs: 120_000 });
      const real = s.sessions.filter((x) => x.seconds >= 30);
      if (!real.length) {
        die(`${character} has no recorded damage in ${capturePath}.\n`
          + 'Either the probe never saw this character, or the name is wrong'
          + (captureFile.defaulted ? ', or this log was started after the last patch\nand the play is in an older one.\n' : '.\n')
          + otherLogs());
      }
      const take = real.slice(-Math.max(1, wantSessions));
      since = take[0].startTs;
      window = { count: take.length, of: real.length, seconds: take.reduce((a, x) => a + x.seconds, 0) };
    }

    // One list of ranges from here on, whichever way the window was arrived at.
    windows ??= [{ from: since, to: until }];
    const inWindow = (ts) => windows.some((w) => ts >= (w.from ?? -Infinity) && ts <= (w.to ?? Infinity));
    // WHICH INSTANCE of the unit. The model fights one target; three yard
    // dummies are three, and what a rotation lands on the two it is not
    // fighting (Acidic Splatter spreads to the enemies around the one hit,
    // and the trinket's curse then rolls on those ticks) is damage the model
    // has no line for. Read together, the 2026-10-13 Rogue's 15-point
    // rotation was 57,304 on three dummies against a single-target model,
    // and from the sixth talent on the two totals agreed only because of the
    // neighbours. So a read on a unit is held to the instance being fought
    // at each moment (capture.mjs aggregate, `follow`: the target of the
    // latest press, or where the latest base attack landed), or to the one
    // `--target <unit>#<n>` names; what that leaves out is counted and
    // said. `--all-instances` reads the unit's every instance, as this
    // command always used to - and so does a model asked to fight several
    // targets (--targets), which has lines for them.
    const followInstance = wantArchetype != null && !wantInstance && !args.flags['all-instances'] && fightSetup.targets === 1;
    const cap = await aggregate(capturePath, {
      source: character,
      target: wantArchetype,
      groupBy: 'skill',
      windows,
      instance: wantInstance,
      follow: followInstance ? { isBaseAttack: engine.plan.isBaseAttack } : null,
    });
    // A GIVEN WINDOW WITH NOTHING IN IT IS NOT A LEDGER. It used to print one:
    // `--since 1 --until 2` dated the window from the numbers that were typed
    // (1970, so "written before this boot was installed", so the Dummy priced
    // with no armour), fell back to the snapshot with the most damage under
    // it, and listed ten lines of a 395 dps model as NOT-PRESSED beside zero
    // capture rows, with exit code 0. A window the caller gave is a claim
    // about where the rows are; when there are none it is said, with where
    // they are - before the build is dated and before anything is priced.
    if (asked.windows && cap.matched === 0) {
      const said = windows.map((w) => `${stamp(w.from)} .. ${stamp(w.to)}`).join(', ');
      if (wantInstance && cap.leftOut.hits > 0) {
        die(`${character} dealt ${cap.leftOut.hits.toLocaleString()} damage row${cap.leftOut.hits === 1 ? '' : 's'} on ${wantArchetype} in the given window (${said}), `
          + `none of them on ${wantInstance}.\n`
          + `They are on ${cap.leftOut.instances.slice(0, 6).map((x) => `${x.target} (${x.hits.toLocaleString()})`).join(', ')}`
          + `${cap.leftOut.instances.length > 6 ? `, and ${cap.leftOut.instances.length - 6} more` : ''}.`);
      }
      const inWindow0 = wantArchetype ? await aggregate(capturePath, { source: character, groupBy: 'target', windows }) : cap;
      if (inWindow0.matched > 0) {
        die(`${character} dealt ${inWindow0.matched.toLocaleString()} damage row${inWindow0.matched === 1 ? '' : 's'} in the given window (${said}), `
          + `none of them on ${wantArchetype}.\n`
          + `They are on ${inWindow0.groups.slice(0, 6).map((g) => `${g.key} (${g.hits.toLocaleString()})`).join(', ')}`
          + `${inWindow0.groups.length > 6 ? `, and ${inWindow0.groups.length - 6} more` : ''}.`);
      }
      const whole = await aggregate(capturePath, { source: character, groupBy: 'target' });
      if (!whole.matched && combatLog) {
        die(`${character} has no damage row in ${capturePath}. The log writes its own character as "${combatLog.handle}", `
          + 'and --character names whose rows are read; bench import <file> prints what the log holds.');
      }
      if (!whole.matched) {
        die(`${character} has no recorded damage in ${capturePath}.\n`
          + 'Either the probe never saw this character, or the name is wrong'
          + (captureFile.defaulted ? ', or this log was started after the last patch\nand the play is in an older one.\n' : '.\n')
          + otherLogs());
      }
      die(`${character} has no damage row in the given window (${said}).\n`
        + `Its ${whole.matched.toLocaleString()} damage rows in ${capturePath} run from ${stamp(whole.firstTs)} to ${stamp(whole.lastTs)}.\n`
        + 'Times are epoch milliseconds, the log\'s own ts_ms; --snapshots lists the character\'s builds and when each was written.');
    }
    // WHICH BUILD the window was recorded on, off the capture's own session
    // rows and the installed bytecode - before anything is priced, because the
    // answer decides what a disagreement below can mean. A given window is
    // dated by its ROWS and never by the bounds that were typed (it holds
    // rows, or the run stopped above).
    const era = captureEra({
      sessionRows: cap.sessionRows,
      from: cap.firstTs ?? (asked.windows ? null : since),
      to: cap.lastTs ?? (asked.windows ? null : until ?? since),
      boot: bootFacts(game),
      // A combat log names its build by the hlboot.dat hash its header carries.
      bootSha: engine.meta.bootSha,
    });
    // PRICE AGAINST WHAT WAS HIT. `--target Dummy` filtered the capture to
    // dummy hits and then priced the model against the default reference foe
    // (0.25/0.25 mitigation) - so every skill read 15-25% low against a target
    // that mitigates nothing, across three classes, and the deficit wore the
    // costume of a formula error. The model's target is the one the capture
    // was filtered to - AS THAT UNIT WAS when the capture was recorded: the
    // Dummy authors 0.40 / 0.40 since the 2026-10 build and authored nothing
    // before it, so a pre-patch dummy window priced on today's row reads
    // every row 10% low for a reason that is the patch's and not the model's
    // (verify.mjs modelTarget). --price-as names the model's target outright.
    //
    // And AT THE LEVEL IT STOOD AT: a unit id alone is its row's level in
    // Normal, and the capture logs where each target actually stood (tlvl).
    // --target-level still wins over both.
    //
    // And the DIFFICULTY, which the logged level only half says: at MaxLevel
    // a unit stood in Veteran or in Heroic, and for a boss with heroic armour
    // rows those are two targets (verify.mjs modelTarget). What each would
    // make of the filtered unit is worked out here, where the engine is.
    const difficulty = (() => {
      if (!wantArchetype || !engine.cdb.byId('unit').has(wantArchetype)) return null;
      const maxLevel = Math.round(engine.ctx.consts.maxLevel);
      let veteran;
      let heroic;
      try {
        veteran = engine.combat.foe(`${wantArchetype}@veteran`, built.level);
        heroic = engine.combat.foe(`${wantArchetype}@heroic`, built.level);
      } catch { return { maxLevel }; }
      const [ra, rb] = engine.ctx.consts.resistFormula;
      const through = (pool) => 1 - pool / (pool + ra + rb * built.level);
      const short = (t) => `S ${(t.physReduction / (1 - t.physReduction)).toFixed(2)}/${(t.magicReduction / (1 - t.magicReduction)).toFixed(2)}, `
        + `${f.pct(1 - through(t.armor), 0)} to a level-${built.level} striker`;
      const span = engine.combat.normalLevelSpan(wantArchetype);
      return {
        maxLevel,
        normalTop: span ? span.hi : null,
        heroicDiffers: veteran.armor !== heroic.armor || veteran.magicArmor !== heroic.magicArmor,
        veteranLabel: short(veteran), heroicLabel: short(heroic),
        // What pricing a Heroic window as Veteran overreads by, per hit.
        overread: through(veteran.armor) / through(heroic.armor) - 1,
      };
    })();
    // The difficulty a combat log names prices the model, where it can (logPricing).
    const fromLog = logPricing(engine, combatLog, { rawTarget, wantTarget, wantArchetype, priceAs: wantPriceAs });
    const priced = modelTarget({
      filter: wantTarget, priceAs: fromLog.priceAs ?? wantPriceAs, unit: wantArchetype, era,
      logged: cap.targetLevels, heroLevel: built.level, difficulty,
    });
    // The log decided the difficulty, not a typed --price-as: said as that.
    if (fromLog.priceAs) priced.note = fromLog.note;
    const verifyTarget = priced.name
      ? engine.combat.foe(priced.name, built.level, targetLevel ?? priced.level)
      : undefined;
    // What the player actually pressed in this window - BEFORE the model runs,
    // because the model is held to it. Left to its own rotation the sim
    // presses every active it owns, and a utility the player never touched
    // can distort a row it feeds: Fortifying Cry doubles Armor for 10 of
    // every 35 seconds and the sim's auto-press read Heartsteel - the one
    // skill that scales off Armor - 31% high against a player who pressed
    // the buff once in the whole capture, out of combat. A skill applied BY
    // a pressed cast (the orb status rides its S1) stays allowed through the
    // via chain; with no press rows at all (an old capture), the model keeps
    // its own rotation.
    const pressAgg = await aggregate(capturePath, {
      source: character, event: 'press', groupBy: 'skill', windows,
    });
    const pressed = new Set(pressAgg.groups.map((g) => g.key));
    // NO PRESS ROW IS AN ANSWER TOO, where the log writes them. A window
    // opened by a session row was written by probe v10 or later, which logs
    // every press - and a held basic chain writes none (2026-10-13: sixty
    // seconds of left mouse button, 76 damage rows, no press row). So such a
    // window with no press in it is a window in which nothing was pressed,
    // and the model is held to that: the chain alone. Before this, an empty
    // set fell through to "an old capture, keep the model's own rotation",
    // and a basic-attack block was priced against a fight that pressed every
    // cooldown the build owns - Battle Shout's crit chance and Berserk's
    // damage on swings that had neither.
    // (A combat log says on its session row whether it writes presses at all:
    // presses=0 is a log that never could, and its empty set says nothing.)
    const nothingPressed = !pressed.size && era.sessions.some((s) => s.presses !== 0) && cap.matched > 0;
    let policy = null;
    let fightLen = null;
    let chainFeeds = null;
    let divergence = null;
    let replayOpens = null;
    let replayOpensFrom = null;
    // --replay: hold the model to the capture's own PRESS SEQUENCE, not just
    // its press SET. The sim's chooser is replaced by the recorded timeline -
    // each press fires at its recorded offset if the model agrees it is
    // ready - so WHICH press finds a register armed, a conduit spent or a
    // charge banked is the capture's own order. The fight is as long as a
    // GIVEN window, or as --fight says; only a window left open at its end
    // runs to fifteen seconds past the last press. (It used to run there
    // always: a 30.5 s window was replayed over 40 s whatever --fight said,
    // the last ten of them bare chain the capture holds no row of, and the
    // ledger's dps and SHARE were that longer fight's.) Where the model DISAGREES
    // that a recorded press was possible, that is counted and reported, not
    // silently absorbed: a divergence is a finding about the model's
    // cooldown/resource state, which is exactly what this mode exists to
    // expose.
    if (args.flags.replay && windows.length > 1) {
      die('--replay plays ONE recorded press sequence as one fight; give it one window (--since / --until), not several.');
    }
    // ...and a fight has a first second. A press is replayed at its offset
    // from where the window opens, so a window with no opening (--until
    // alone, --window ..<to>) has no clock to put the presses on: the
    // offsets came out as epoch seconds, the fight as fifty-seven years, and
    // the command never returned. Taking the origin from the rows instead
    // would replay the log's first sitting against a ledger of every row up
    // to --until, which is two different windows; so it is asked for.
    if (args.flags.replay && asked.windows && windows[0].from == null) {
      die('--replay needs where the fight starts: give --since or --window <from>..');
    }
    if (args.flags.replay && pressed.size) {
      const presses = [];
      // ...and where the recorded sitting OPENS: the character's first skill
      // state inside the window (a `go_state` row to Skill - a swing or a
      // cast), which is where the model's fight starts moving too
      // (verify.mjs replaySchedule, `opens`).
      let opensTs = null;
      // (A combat log with no skill start opens at a press or a swing: logOpeningWatch.)
      let watch = null;
      if (combatLog) { try { watch = logOpeningWatch(character, new Set((engine.plan.resolve(built.loadout, rank).filler ?? []).map((x) => x.prof.id))); } catch { watch = null; } }
      await streamCapture(capturePath, (r) => {
        if (!inWindow(r.ts)) return;
        if (opensTs === null && r.event === 'go_state' && r.target === character && parseExtra(r.extra).state === 'Skill') opensTs = r.ts;
        watch?.see(r);
        if (r.source !== character || r.event !== 'press') return;
        presses.push({ t: (r.ts - since) / 1000, id: r.skill });
      });
      replayOpensFrom = opensTs !== null ? 'state' : watch?.ts != null ? watch.from : null;
      if (opensTs === null && watch?.ts != null) opensTs = watch.ts;
      // The schedule itself - the cut at a two-minute silence, the fight's
      // length, the policy and what it counts - is verify.mjs replaySchedule.
      const schedule = replaySchedule(presses, {
        fight: args.flags.fight !== undefined ? fightSetup.seconds
          : asked.windows && windows[0].to != null ? (windows[0].to - windows[0].from) / 1000 : null,
        opens: opensTs === null ? null : (opensTs - since) / 1000,
      });
      replayOpens = opensTs === null ? null : (opensTs - since) / 1000;
      const seq = schedule.seq;
      fightLen = schedule.fight;
      // Presses the model holds no active for still advance the game's chain
      // counter when their type is active-ish (BaseSkill.isActiveSkill@6156: weapon,
      // class and signature skills - types 7, 9 and 17, and NOT the
      // WeaponSubSkill that BaseSkill.isWeaponSkill@6161 now admits) - Blink and
      // MysticEmpowerment fed the live Mage chain while the model's counter
      // never saw them, which is why replay refused chain-reset presses the
      // player demonstrably made.
      try {
        const rotR = engine.plan.resolve(built.loadout, rank);
        const knownIds = new Set([
          ...(rotR.active ?? []).map((a) => a.prof.id),
          ...(rotR.active ?? []).map((a) => a.via).filter(Boolean),
        ]);
        const activeish = new Set(['WeaponSkill', 'ClassSkill', 'SignatureSkill']);
        chainFeeds = seq
          .filter((p) => !knownIds.has(p.id) && activeish.has(engine.plan.typeOf(p.id)))
          .map((p) => p.t);
      } catch { /* no feeds - replay still runs */ }
      // The tally is the schedule's own and is the RETURNED fight's: it starts
      // over with every fight the evaluation plays.
      divergence = schedule.tally;
      policy = schedule.policy;
    } else if (pressed.size) {
      const allowed = new Set(pressed);
      try {
        const rotPre = engine.plan.resolve(built.loadout, rank);
        for (const a of rotPre.active ?? []) {
          if (a.via && (pressed.has(a.via) || allowed.has(a.via))) allowed.add(a.prof.id);
        }
      } catch { /* the rotation still resolves inside evaluate */ }
      policy = ({ ready, actives }) => {
        for (const i of ready) if (allowed.has(actives[i].prof.id)) return i;
        return -1;
      };
    } else if (nothingPressed) {
      policy = () => -1;
    }
    // THE CHAIN, when the window never swung it. A block of isolated presses
    // holds no base attack at all, and a model that fills the gaps with its
    // chain prices those presses inside Brutal Frenzy, Devote and whatever
    // else only a swing puts up. So a window that pressed something and
    // holds not one hit of the build's own chain is played with the chain
    // held - and with every timed status on the character that is not a
    // pressed skill's own priced as down, which reaches past a swing's
    // statuses to a proc's and a conduit's (engine.mjs, the held-chain rule;
    // the ledger names what was priced down). (A window with no press row
    // in a log that writes none says nothing about how it was played, and
    // keeps the model's own fight.)
    let holdChain = false;
    // ...AND WHEN IT NEVER PRESSED EITHER. Nothing pressed and not one swing:
    // the window holds nothing the model can play, and what its rows hold
    // was dealt by something that happened before it opened or is something
    // the model has no line for (the 2026-10-13 Warrior's second login: 3.5
    // seconds, one Rampage hit, its press half a second before the window).
    // Swinging the chain there printed four
    // NOT-PRESSED lines of 66 to 88 model hits beside a window with no swing
    // in it. So the chain is held here too, and the ledger says the fight is
    // empty.
    let nothingToPlay = false;
    if (cap.matched > 0 && (pressed.size > 0 || nothingPressed)) {
      try {
        const chainIds = new Set((engine.plan.resolve(built.loadout, rank).filler ?? []).map((x) => x.prof.id));
        const swung = cap.groups.some((g) => chainIds.has(g.key));
        if (pressed.size > 0) holdChain = chainIds.size > 0 && !swung;
        else nothingToPlay = !swung && !authoredPolicy;
      } catch { /* the rotation still resolves inside evaluate */ }
    }
    // THE GAUGE AT THE OPENING of a given window. The Mage's conduits fire
    // only on a Spark spend from above the gauge, so where the pool stands
    // when the window opens decides whether they fire in it at all: the
    // 2026-10-13 chain block opened at 35.8 of 100 and logged no conduit row
    // in seventy seconds, where a fight opened on a full pool fires five. The
    // log says (every press and state row carries it), and the model's fight
    // opens there.
    let poolStart = null;
    let poolNote = null;
    if (asked.windows && windows[0].from != null) {
      let gaugeAtb = null;
      try { gaugeAtb = engine.plan.resolve(built.loadout, rank).sparkGauge?.atb ?? null; } catch { gaugeAtb = null; }
      if (gaugeAtb === 'Spark') {
        const open = await poolAt(capturePath, { source: character, since: windows[0].from, until: windows[0].to, key: 'spark' });
        if (open) {
          poolStart = { [gaugeAtb]: open.value };
          poolNote = `${gaugeAtb}: ${open.value} when the window opens (the first row that says, `
            + `${((open.ts - windows[0].from) / 1000).toFixed(1)}s in) - the model's fight opens there`;
        }
      }
    }
    // Where a combat log leaves the fight to the model: no press recorded, no gauge carried (logPlayNotes).
    const logPlay = logPlayNotes(engine, combatLog, built, { rank, poolStart, replay: !!args.flags.replay });
    const ev = engine.evaluate(built.loadout, { rank, mix, target: verifyTarget, policy: authoredPolicy ?? policy, fight: fightLen, chainFeeds, holdChain: holdChain || nothingToPlay, poolStart });
    // Both clocks, for the RATE: the model's fight as it was played, and the
    // capture's time in play over the rows read.
    const clocks = { modelSeconds: ev.throughput.fight ?? fightLen ?? fightSetup.seconds, liveSeconds: cap.activeMs > 0 ? cap.activeMs / 1000 : null };
    let cmp = compare({ modelLines: ev.throughput.lines, captureGroups: cap.groups, pressed, ...clocks });
    // WHAT WAS CARRIED INTO A WINDOW THAT PRESSED NOTHING. Such a window is
    // played with the chain alone, and that is right: nothing WAS pressed in
    // it. But a window cut out of a sitting does not open on nothing. The
    // 2026-10-13 Rogue's sixteen "basics" blocks each open one to seven
    // seconds after a rotation with Lethal Poison still on the dummy: its
    // ticks, and Envenom - a base-attack rider gated on that poison, which
    // refreshes it - run for the whole block, and both were printed MISSING,
    // "damage the game did and the bench cannot see", for a model that has
    // both lines whenever it presses. So a row the chain-alone fight has no
    // line for is asked of the build's own unrestricted fight: with a line
    // there it was CARRIED IN - filed as that, out of MISSING and out of
    // coverage (verify.mjs compare) - and the ledger says what stood when
    // the window opened (capture.mjs openingState). MISSING stays for a row
    // neither fight has a line for.
    //
    // This is the FILING, and it is not the whole answer: the model's fight
    // still opens with nothing standing, so a carried-in line is not priced
    // and the window's own lines are priced without what stood (bench audit,
    // "a fight starts COLD").
    let carriedNote = null;
    let opening = null;
    if (nothingPressed && !authoredPolicy && cmp.totals.missing > 0) {
      let free = null;
      try { free = engine.evaluate(built.loadout, { rank, mix, target: verifyTarget, poolStart }); } catch { free = null; }
      if (free) {
        const has = new Set(compare({ modelLines: free.throughput.lines, captureGroups: cap.groups }).rows
          .filter((r) => r.status === 'BOTH').map((r) => r.skill ?? r.id));
        cmp = compare({ modelLines: ev.throughput.lines, captureGroups: cap.groups, pressed, carried: has, ...clocks });
      }
      const rowsIn = cmp.rows.filter((r) => r.status === 'CARRIED-IN');
      if (rowsIn.length && windows[0].from != null) {
        const nameOf = (id) => engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
        const state = await openingState(capturePath, { source: character, at: windows[0].from, wearers: cap.instances });
        const ago = (ts) => `${((windows[0].from - ts) / 1000).toFixed(1)}s`;
        opening = {
          lastPress: state.lastPress ? { skill: state.lastPress.skill, name: nameOf(state.lastPress.skill), ts: state.lastPress.ts } : null,
          standing: state.standing.map((e) => ({
            status: e.status, name: nameOf(e.status), on: e.self ? 'self' : 'target', wearer: e.wearer,
            since: e.since, lastAt: e.lastAt, stacks: e.stacks, expires: e.expires, ...(e.initial ? { initial: true } : {}),
          })),
        };
        // Each carried-in line, with what the log holds behind it: the line
        // is a status standing when the window opens, or a rider the build
        // plays only while such a status stands (`rule.whileStatus`, read off
        // its script's guard), or a skill pressed before the window.
        let riders = [];
        try { riders = engine.plan.resolve(built.loadout, rank).triggered ?? []; } catch { riders = []; }
        for (const r of rowsIn) {
          const skill = r.skill ?? r.id;
          const own = state.standing.find((e) => e.status === skill);
          const gate = own ? null : riders.filter((g) => String(g.prof?.id ?? '').split('#')[0] === skill && g.rule?.whileStatus)
            .map((g) => state.standing.find((e) => e.status === g.rule.whileStatus)).find(Boolean) ?? null;
          r.carriedBy = own ? { standing: skill, since: own.since, ...(own.initial ? { initial: true } : {}) }
            : gate ? { whileStanding: gate.status, since: gate.since }
              : state.pressed[skill] != null ? { pressed: skill, ts: state.pressed[skill] } : null;
        }
        const what = rowsIn.map((r) => {
          const by = r.carriedBy;
          return nameOf(r.skill ?? r.id) + (by?.standing ? (by.initial ? ' (standing when the log opens, its initial[])' : ` (standing, applied ${ago(by.since)} before it)`)
            : by?.whileStanding ? ` (plays while ${nameOf(by.whileStanding)} stands)`
              : by?.pressed ? ` (pressed ${ago(by.ts)} before it)`
                // Nothing in the log behind it: carried in by elimination -
                // the build has the line when it presses, and nothing was.
                : ' (the log before the window does not show what)');
        }).join(', ');
        const standing = opening.standing.slice(0, 6).map((e) => `${e.name} on ${e.on === 'self' ? character : 'the target'}`).join(', ')
          + (opening.standing.length > 6 ? `, and ${opening.standing.length - 6} more` : '');
        const hitsIn = rowsIn.reduce((n, r) => n + r.liveHits, 0);
        carriedNote = `carried in: ${rowsIn.length} line${rowsIn.length > 1 ? 's' : ''}, `
          + `${hitsIn.toLocaleString()} hit${hitsIn === 1 ? '' : 's'}, dealt in this window by what was pressed or applied before it - ${what}.\n`
          + `  The last press before the window: ${opening.lastPress ? `${opening.lastPress.name}, ${ago(opening.lastPress.ts)} earlier` : 'none in this session of the log'}. `
          + `Standing when it opens: ${standing || 'no status of this character\'s'}.\n`
          + '  The model\'s fight opens with nothing standing: the carried-in lines are not priced (they are out of MISSING and out of\n'
          + '  coverage), and the lines that are priced are priced without whatever stood.';
      } else if (rowsIn.length) {
        carriedNote = `carried in: ${rowsIn.length} line${rowsIn.length > 1 ? 's' : ''} of skills this window did not press and the build has a line for when it does. `
          + 'They are out of MISSING and out of coverage.';
      }
    }

    // What the model stood on, in words. With no --target the capture is
    // every hit the character landed and the model keeps the engine's own
    // default target, exactly as before.
    const pricedLabel = ev.target?.name ?? verifyTarget?.name ?? null;
    // What the held chain priced as down (engine.mjs marks each row).
    const heldDown = (ev.buffs ?? []).filter((b) => b.heldDown)
      .map((b) => ({ status: b.status, name: b.name ?? engine.cdb.byId('skill').get(b.status)?.texts?.name ?? b.status, from: b.from }));
    // WHAT THIS BUILD HOLDS THAT A HIT CAN FIND IN TWO STATES, as far as the
    // model itself knows - for the closing paragraph, which used to call a
    // per-hit disagreement "a formula error and nothing else" over a Mage
    // ledger whose three misses were states: Static Nova 450.0 against 451
    // with Queen's Decree and 233 without, block by block, and -28.9% over a
    // span that mixes the two. Three kinds are known from the evaluation:
    //   a USE RIDER (throughput.useRiders): the next press that can spend it
    //   takes its amount and its cooldown starts, so each spender's line is
    //   a mix of presses that found it ready and presses that did not - by
    //   the model's clock in the model's fight, by the recorded one in the
    //   capture;
    //   a RAMPED BUFF priced at its mean stack count (conduitRamps);
    //   a PERK THAT PAYS FROM ONE SIDE of the target (sidePerks): a base
    //   attack from behind takes the daggers' upgrade amount, the model bills
    //   it on --behind-fraction of the swings, and a window fought from one
    //   side is all or none of them. The 2026-10-13 Rogue's ordinary swings
    //   read 18.4-19.1 from behind (100 of them) and 14.6-15.2 from the
    //   front (69), where the model's are 18.1 at --behind-fraction 1, 14.4
    //   at 0 and 15.9 at the default - and the flag was in no help text.
    // Only what the ledger has a row for is named.
    const stateMixes = [];
    {
      const nameOf = (id) => engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
      const inLedger = new Set(cmp.rows.filter((r) => (r.liveHits ?? 0) > 0).map((r) => r.id));
      const linesOf = (id) => (ev.throughput?.lines ?? []).filter((l) => l.id === id || String(l.id).startsWith(`${id}#`));
      for (const u of ev.throughput?.useRiders ?? []) {
        const spec = (ev.rotation?.useRiders ?? []).find((x) => x.from === u.from);
        const spenders = (u.spenders ?? []).filter((id) => inLedger.has(id));
        if (!spenders.length) continue;
        stateMixes.push({
          kind: 'use rider', id: u.from, name: u.name ?? nameOf(u.from), amount: spec?.amount ?? null,
          spenders: spenders.map((id) => ({ id, name: nameOf(id) })),
          // In the model's fight: the presses that spent it, of those that could.
          spent: u.fires, presses: (u.spenders ?? []).reduce((n, id) => n + linesOf(id).reduce((m, l) => m + (l.casts ?? 0), 0), 0),
        });
      }
      for (const g of ev.conduitRamps ?? []) {
        stateMixes.push({ kind: 'ramp', id: g.id, name: nameOf(g.id), mean: g.mean, cap: g.cap });
      }
      // The side perks, when the window holds a base attack for them to ride
      // (BaseSkill.isBasicAttack@6152: skill types Attack..Attack4).
      const skillTypes = engine.cdb.enumValues('skill', 'type');
      const isBasic = (id) => /^Attack[234]?$/.test(skillTypes[engine.cdb.byId('skill').get(id)?.type] ?? '');
      const side = ev.sidePerks;
      if (side?.perks?.length && [...inLedger].some(isBasic)) {
        stateMixes.push({
          kind: 'side', amount: side.perks.reduce((n, p) => n + p.damage, 0), fraction: side.fraction,
          weapons: side.perks.map((p) => {
            const item = engine.cat.itemById.get(built.loadout.gear[p.slot]?.item);
            return { slot: p.slot, id: item?.id ?? null, name: item?.name ?? item?.id ?? p.slot, amount: p.damage };
          }),
        });
      }
    }
    // The difficulty warning is about which ROWS a window at MaxLevel reads, so
    // it stands while the model is priced at the logged level - also when a
    // --target-level says that same level, which answers where and not which.
    const undecidedNote = priced.difficulty && (targetLevel == null || targetLevel === priced.level) ? priced.note : null;
    // WHICH BUILD THE WINDOW WAS PRICED WITH, and whether the window is one
    // build. `chosen.mixed` is every other snapshot that stands somewhere in
    // a GIVEN window and differs; on the default path the window is the
    // chosen snapshot's own span and nothing else can stand in it.
    const snapFacts = buildSnap ? {
      index: snap.index ?? null, of: snaps.snapshots.length, ts: snap.ts, until: snap.until ?? null,
      how: chosen.how ?? 'most evidence', note: chosen.note ?? null,
      // The build standing when the window opens, when that is not the one
      // priced (a --snapshot that names another).
      standing: (() => {
        if (!asked.windows || windows[0].from == null) return null;
        const at = snapshotAt(snaps.snapshots, windows[0].from);
        return at && at !== snap ? { index: at.index, ts: at.ts, differs: differ(snap, at) } : null;
      })(),
    } : null;
    const mixed = buildSnap ? (chosen.mixed ?? []) : [];
    const mixedNote = mixed.length
      ? 'THIS WINDOW MIXES BUILDS. It is priced with snapshot #' + snap.index + '; inside it the character also stood as:\n'
        + mixed.map((m) => `  #${m.index}, ${m.until != null && m.ts <= (windows[0].from ?? -Infinity) ? 'until' : 'from'} `
          + `${stamp(m.until != null && m.ts <= (windows[0].from ?? -Infinity) ? m.until : m.ts)}: ${m.differs.join('; ')}`).join('\n')
        + '\nEvery row dealt under another build is evidence about that build, not about this ledger\'s model. '
        + 'Narrow the window (--since / --until) to one of them, or name the build with --snapshot.'
      : null;
    // WHETHER THE WINDOW IS ONE FIGHT. The ledger with no window flag reads a
    // snapshot's whole span, and on a capture recorded block by block that
    // span is many things at once: the 2026-10-13 Warrior's is 6,716 seconds
    // of chain-only blocks, lone presses, a held skill at three charge
    // levels and a rotation, and its ledger printed Rampage +41.9%, Surging
    // Force +21.3% and the base attacks +8..12% with nothing saying why.
    // Block by block the same model reads Rampage at full charge 852.5
    // against a logged 853, Surging Force pressed alone 155.5 against 154,
    // an ordinary swing of the chain 112.3 against 108-113. The model plays
    // ONE fight that presses, whenever it is ready, everything the window
    // pressed anywhere; a swing dealt in a block that pressed nothing is
    // then compared with a swing priced inside Battle Shout.
    //
    // So the window's stretches of play are counted (capture.mjs stretches)
    // and the ledger says when they were not played alike: some press and
    // some do not, or a pressed skill whose own cast puts a timed status on
    // the character was pressed in fewer than half of the stretches that
    // pressed anything. It is a count off the press rows, said with its
    // numbers; it does not try to find the blocks, which no silence marks
    // (the Rogue's basics blocks open four seconds after a rotation).
    let spanFacts = null;
    let spanNote = null;
    {
      const GAP_MS = 30_000;
      let parts = [];
      try { parts = (await stretches(capturePath, { source: character, target: wantArchetype, windows, gapMs: GAP_MS })).stretches; } catch { parts = []; }
      const pressing = parts.filter((x) => Object.keys(x.pressed).length);
      if (parts.length > 1 && pressing.length) {
        const nameOf = (id) => engine.cdb.byId('skill').get(id)?.texts?.name ?? id;
        const buffCasts = new Set((ev.buffs ?? []).filter((b) => b.duration > 0 && b.trigger?.on === 'cast').map((b) => b.from));
        const partial = [...pressed].filter((id) => buffCasts.has(id))
          .map((id) => ({ skill: id, name: nameOf(id), stretches: pressing.filter((x) => x.pressed[id]).length }))
          .filter((x) => x.stretches * 2 < pressing.length);
        const silent = parts.length - pressing.length;
        spanFacts = { stretches: parts.length, pressing: pressing.length, silent, gapMs: GAP_MS, partial, mixed: silent > 0 || partial.length > 0 };
        if (spanFacts.mixed) {
          spanNote = `THIS WINDOW IS NOT ONE FIGHT. It holds ${parts.length} stretches of play (split at ${GAP_MS / 1000}s without a hit or a press): `
            + `${pressing.length} press something${silent ? `, ${silent} press nothing` : ''}`
            + (partial.length ? `; ${partial.map((x) => `${x.name} was pressed in ${x.stretches} of the ${pressing.length}`).join(', ')}` : '') + '.\n'
            + (authoredPolicy ? 'The model plays one fight, by the rotation it was given.'
              : divergence ? 'The model replays one recorded sequence, as one fight.'
                : 'The model plays one fight that presses, whenever it is ready, everything the window pressed anywhere.')
            + ' PER-HIT below\n'
            + 'therefore mixes states - such as a swing inside a buff and one outside it, a held skill\'s charge levels, an armed\n'
            + 'press and a plain one - and a delta there is the mix before it is a formula. Take one stretch with --since / --until\n'
            + 'or --window (--snapshots lists the builds and their spans), and read it with --split.';
        }
      }
    }
    // THE SAME BUILD, WRITTEN AGAIN. The probe writes a snapshot at every
    // login as well as at every change, so the span of the snapshot chosen
    // above can stop where the same build goes on: the Warrior's second
    // session is snapshot #2, "the same build as #1", and its 178 rows were
    // in no ledger that did not ask for them. The window is not widened -
    // what a snapshot's span means stays one thing - but the ledger says
    // which neighbours are the same build, what they hold, and how to read
    // them together.
    let sameBuild = [];
    if (buildSnap && window?.fromSnapshot) {
      const all = snaps.snapshots;
      const at = all.indexOf(snap);
      for (let i = at + 1; i < all.length && differ(snap, all[i]).length === 0; i++) sameBuild.push(all[i]);
      for (let i = at - 1; i >= 0 && differ(snap, all[i]).length === 0; i--) sameBuild.unshift(all[i]);
      sameBuild = sameBuild.map((x) => ({ index: x.index, ts: x.ts, until: x.until ?? null, events: x.events, onTarget: evidence(x) }));
    }
    // Other players on the same target instances, inside the window.
    const foreign = cap.foreign ?? [];
    const foreignNote = foreign.length
      ? `${foreign.reduce((n, x) => n + x.hits, 0).toLocaleString()} hits by ${foreign.length} other player${foreign.length > 1 ? 's' : ''} `
        + `landed on the same target${wantArchetype ? '' : 's'} inside this window (`
        + foreign.slice(0, 4).map((x) => `${x.source} ${x.hits}`).join(', ') + (foreign.length > 4 ? ', ...' : '')
        + '). Their rows are not in the ledger; whatever they put on the target was there for these hits.'
      : null;
    if (args.flags.json) {
      console.log(JSON.stringify({
        character, unit: built.unit, level: built.level,
        capture: capturePath, since, until, windows, window, gaps: built.gaps,
        // Where the build came from: 'import' (--import, with its file and
        // the shape it was read as), the capture's 'snapshot' or the modkit
        // 'dump'.
        build: imported ? { from: 'import', file: imported.path, format: imported.imported.format } : { from: snap ? 'snapshot' : 'dump' },
        // A combat log as the capture: its dialect, the name its character
        // is written under, the difficulty its header names (null: none) and
        // what the ledger made of that.
        combatLog: combatLog ? {
          dialect: combatLog.dialect, handle: combatLog.handle, difficulty: combatLog.stats.encounter.difficulty,
          note: fromLog.note, pricedByLog: fromLog.priceAs != null,
          // The log's own level for its character, when the build's is another.
          levelNote: logLevelNote,
          // What its reader said of it (logFindings): the problems it named
          // (rows skipped or read against no target, a recorder's gap ...)
          // and the notes the ledger stands on (an estimated start, what a
          // Wink file cannot hold, hits with no affinity or target level).
          problems: logSaid.problems, notes: logSaid.notes,
          // Whether it records its character's presses (false: the model
          // played its own rotation), whether its header or dialect said so,
          // the pools it carries a value of ('rage', 'spark'), and the line
          // for a gauge it does not carry (the model's fight opened full).
          presses: combatLog.stats.presses, pressesDeclared: combatLog.stats.pressesDeclared, pools: combatLog.stats.pools,
          gaugeNote: logPlay.gauge,
        } : null,
        // The window's stretches of play, and whether they were played alike
        // (`mixed`: some press and some do not, or a buff was pressed in
        // fewer than half of those that press - PER-HIT then mixes states).
        // Null when the window is one stretch, or the log holds no press.
        span: spanFacts,
        // Neighbouring snapshots that are the same build as the one whose
        // span is the window, with the rows each holds: not in this ledger.
        sameBuild,
        // The build the window was priced with, how it was chosen, and every
        // other build standing inside a given window (empty: it is one build).
        snapshot: snapFacts, mixedBuilds: mixed,
        // The mechanic pools the snapshot did not carry: how each was filled
        // ('named' with --skills, from the 'rows', or the model's 'default').
        pools: poolFacts.map(({ note, ...rest }) => rest),
        // Other players' hits on the same target instances inside the window.
        foreign,
        // What was pressed in the window; `nothingPressed` when the log writes
        // presses and the window holds none (the model then plays the chain alone).
        pressed: [...pressed], nothingPressed,
        // ...and no base attack either: there is nothing in the window for
        // the model to play, and its fight is empty.
        nothingToPlay,
        // What stood when a no-press window opened, when rows in it were
        // CARRIED IN from before (null otherwise): the character's last
        // press, and the statuses it had applied that were still up.
        opening,
        // No hit of the build's base-attack chain in the window: the model
        // stood still between presses.
        holdChain: holdChain || nothingToPlay,
        // ...and what was priced as down for it: every timed status on the
        // character that is not a pressed skill's own - a swing's, and also
        // a proc's or a conduit's (bench audit, "with the chain held").
        heldDown,
        // What the build holds that a hit can find in two states, as far as
        // the model knows: a use rider with the ledger's lines that can spend
        // it (`spent` of `presses` in the model's own fight), a buff priced
        // at its mean stack count. A PER-HIT delta on such a line is the mix
        // before it is a formula.
        stateMixes,
        // --replay: the recorded presses as the RETURNED fight played them
        // (verify.mjs replaySchedule) - how many of `total` it `replayed`,
        // refused as `notReady`, did not know, pressed more than a second
        // late - over a fight of `fight` seconds, the last of `fights` the
        // evaluation played. Null without the flag, or with nothing pressed.
        // `opens`: the second the recorded sitting's first skill state opened,
        // until which the replayed fight stands still (null: the log does not
        // say, and it moves from its first second).
        // `opensFrom`: what said so - 'state' (a skill start), or, in a combat
        // log that writes none, its first 'press' or base-attack 'hit'.
        replay: divergence ? { ...divergence, fight: fightLen, opens: replayOpens, opensFrom: replayOpensFrom } : null,
        // The gauge pool at the opening of a given window, where the log says.
        poolStart,
        // Which build the window was recorded on: true, false, or null when
        // it cannot be told - and the sentence that says why.
        captureEra: {
          onThisBuild: era.onThisBuild, reason: era.reason, from: era.from, to: era.to,
          probe: era.probe, sessions: era.sessions, boot: era.boot,
        },
        // What the rows are hits on, what the model stood on and at which
        // level - with the levels the capture itself logged for those rows.
        target: {
          filter: wantArchetype, pricedAs: priced.name, pricedLabel, note: priced.difficulty ? undecidedNote : priced.note,
          // Which INSTANCES of the unit the rows are on: the one named
          // (`--target <unit>#<n>`: 'named'), the one being fought at each
          // moment ('followed'), or every one ('all': --all-instances, a
          // model of several targets, or no unit asked for) - and the rows
          // of the character's on the unit's other instances that this left
          // out of every figure in the ledger, per instance.
          instances: wantInstance ? 'named' : followInstance ? 'followed' : 'all',
          read: cap.instances, leftOut: cap.leftOut,
          // 'veteran-or-heroic' when the window stood at MaxLevel, the two
          // difficulties are different targets for this unit and nothing
          // says which it was (the note says what each costs); else null.
          difficulty: undecidedNote ? priced.difficulty : null,
          level: verifyTarget?.spawnLevel ?? null,
          levelNote: targetLevel == null ? priced.levelNote : null,
          loggedLevels: cap.targetLevels,
        },
        // The fight the model played, in seconds, and what it dealt a second.
        // The capture's side of that - its damage per second over its time
        // in play, and the model's over the capture's - is `totals.rate`.
        modelSeconds: clocks.modelSeconds,
        modelDps: ev.throughput.dps, ...cmp,
      }, null, 2));
      return;
    }

    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.bold(`${character} - ${built.unit} ${built.level}`) + f.dim(
      `  ${built.placed.length} slots from ${imported ? `the imported sheet ${imported.path}` : snap ? 'the capture\'s own snapshot' : 'the modkit dump'}`));
    const eraNote = eraWarning(era);
    if (eraNote) console.log(f.warn(eraNote));
    else console.log(f.dim(`capture: ${era.reason}`));
    if (priced.note && (!priced.difficulty || undecidedNote)) console.log(f.warn(priced.note));
    // What the log said about the difficulty, when it did not price it.
    if (fromLog.note && !fromLog.priceAs) console.log(f.dim(fromLog.note));
    if (logLevelNote) console.log(f.warn(logLevelNote));
    for (const p of logSaid?.problems ?? []) console.log(f.warn(`log: ${p}`));
    for (const n of logSaid?.notes ?? []) console.log(f.dim(`log: ${n}`));
    console.log(f.dim(`target: capture rows on ${wantInstance ?? wantArchetype ?? 'every target'}`
      + (followInstance ? `, held to the instance being fought${cap.instances.length ? ` (${cap.instances.slice(0, 4).join(', ')}${cap.instances.length > 4 ? ', ...' : ''})` : ''}` : '')
      + `; model priced against ${pricedLabel ?? '(none)'}`));
    if (cap.leftOut.hits > 0) {
      const lo = cap.leftOut;
      console.log(f.warn(`  left out: ${lo.hits.toLocaleString()} hit${lo.hits === 1 ? '' : 's'}, ${Math.round(lo.total).toLocaleString()} damage, that ${character} landed on `
        + `${lo.instances.length} other instance${lo.instances.length === 1 ? '' : 's'} of ${wantArchetype} `
        + `(${lo.instances.slice(0, 4).map((x) => `${x.target} ${x.hits.toLocaleString()} / ${Math.round(x.total).toLocaleString()}`).join(', ')}${lo.instances.length > 4 ? ', ...' : ''})`
        + (wantInstance ? '.' : ' while it was fighting another: a spread, an area.')
        + `\n  The model fights one target and has no line for them; they are in no figure below. --all-instances reads them`
        + (wantInstance ? '.' : `, --target ${wantArchetype}#<n> names one instance outright.`)));
    } else if (wantArchetype && !followInstance && !wantInstance && cap.instances.length > 1) {
      console.log(f.dim(`  the rows are on ${cap.instances.length} instances of ${wantArchetype}, all read`
        + (args.flags['all-instances'] ? ' (--all-instances)' : ` (the model fights ${fightSetup.targets} targets)`)
        + '; a model of one target has a line for one of them.'));
    }
    if (priced.levelNote && targetLevel == null) console.log(f.dim(`  ${priced.levelNote}`));
    if (snapNote) console.log(f.warn(snapNote));
    if (runeNote) console.log(f.warn(runeNote));
    for (const pf of poolFacts) console.log(pf.how === 'default' ? f.warn(pf.note) : f.dim(pf.note));
    if (divergence) {
      console.log(f.dim(`replay: ${divergence.replayed}/${divergence.total} presses replayed over ${(fightLen ?? 0).toFixed(1).replace(/\.0$/, '')}s`
        + (replayOpens > 0 ? `, opening ${replayOpens.toFixed(2)}s in ${replayOpensFrom === 'press' ? `at ${character}'s first press (the log writes no skill start)`
          : replayOpensFrom === 'hit' ? `at ${character}'s first base-attack hit (the log writes no skill start or press before it; the swing began a windup earlier)`
            : 'where the log\'s first skill state does'}` : '')
        + (divergence.beyond ? ` (${divergence.beyond} more were pressed after the fight's end)` : '')
        + (divergence.cut && divergence.cut.kept + divergence.cut.voided > 0
          ? `, ${divergence.cut.kept + divergence.cut.voided} swing${divergence.cut.kept + divergence.cut.voided === 1 ? '' : 's'} cut short by a press that interrupts - ${divergence.cut.voided} before the hit (nothing landed), ${divergence.cut.kept} after it` : '')
        + (divergence.notReady ? `, ${divergence.notReady} the model refused as not ready` : '')
        + (divergence.unknown ? `, ${divergence.unknown} outside the model's rotation` : '')
        + (divergence.pressedLate ? `, ${divergence.pressedLate} landed >1s late` : '')));
    }
    if (mixedNote) console.log(f.warn(mixedNote));
    if (window?.given) {
      for (const w of window.ranges) console.log(f.dim(`window: ${stamp(w.from)} .. ${stamp(w.to)}`
        + (w.from != null && w.to != null ? `, ${((w.to - w.from) / 1000).toFixed(1)}s` : '')
        + (window.fromLog ? ' - the combat log\'s own span, first row to last (--since / --until or --window take a part of it)'
          : w.snapshot != null ? ` - the span of snapshot #${w.snapshot} (--snapshot), priced with the imported sheet` : ' (given)')));
    }
    if (snapFacts && (window?.given || chosen.how === 'asked')) {
      console.log(f.dim(`build: snapshot #${snapFacts.index} of ${snapFacts.of}, written ${stamp(snapFacts.ts)} - `
        + (snapFacts.how === 'asked' ? 'named with --snapshot'
          : snapFacts.how === 'standing' ? 'the one standing when the window opens'
            : snapFacts.how === 'next' ? 'the first one inside the window'
              : snapFacts.how === 'nearest' ? 'the nearest one that describes a build, none standing in the window' : 'the one with the most evidence')));
      if (snapFacts.note) console.log(f.warn(snapFacts.note));
      if (snapFacts.standing) {
        console.log(f.warn(`the build standing when the window opens is snapshot #${snapFacts.standing.index}, not the one priced: `
          + (snapFacts.standing.differs.length ? snapFacts.standing.differs.join('; ') : 'the same build, written again')));
      }
    }
    if (foreignNote) console.log(f.warn(foreignNote));
    if (nothingToPlay) {
      console.log(f.warn('presses: none in this window, in a log that writes them, and no base attack either - there is nothing in it for the model to play.\n'
        + '  Its fight is empty. A row below was dealt by something pressed or applied before the window opens (CARRIED-IN),\n'
        + '  or is one no fight of this build has a line for (MISSING).'));
    } else if (nothingPressed) {
      console.log(f.dim('presses: none in this window, in a log that writes them - the model plays the base-attack chain alone'));
    }
    if (logPlay.presses) console.log(f.warn(logPlay.presses));
    if (carriedNote) console.log(f.warn(carriedNote));
    if (poolNote) console.log(f.dim(poolNote));
    if (logPlay.gauge) console.log(f.warn(logPlay.gauge));
    if (holdChain) {
      const names = [...new Set(heldDown.map((b) => b.name))];
      console.log(f.dim('chain: no base attack in this window - the model stands still between presses, and every timed status of the\n'
        + '  character\'s that is not a pressed skill\'s own is priced as down'
        + (names.length
          ? `: ${names.join(', ')}.\n  What only a swing applies is rightly down. One that a proc on any damage, a conduit or a passive raises off a press is\n`
            + '  down with it, and may stand in the rows (bench audit, "with the chain held").'
          : ' (this build has none).')));
    }
    if (window?.fromSnapshot) {
      console.log(f.dim(`window: the snapshot's own span - ${window.events.toLocaleString()} events`
        + (window.seconds ? ` over ${Math.round(window.seconds)}s` : ', open-ended')));
      const more = sameBuild.reduce((n, x) => n + x.onTarget, 0);
      if (more > 0) {
        const first = Math.min(snap.ts, ...sameBuild.map((x) => x.ts));
        const lastUntil = [snap, ...sameBuild].some((x) => x.until == null) ? null : Math.max(snap.until, ...sameBuild.map((x) => x.until));
        console.log(f.warn(`  snapshot${sameBuild.length > 1 ? 's' : ''} ${sameBuild.map((x) => `#${x.index}`).join(', ')} `
          + `${sameBuild.length > 1 ? 'are' : 'is'} the same build, written again (one is written at every login): `
          + `${more.toLocaleString()} more row${more === 1 ? '' : 's'}${wantArchetype ? ` on ${wantArchetype}` : ''} that this window does not read.\n`
          + `  --since ${first}${lastUntil == null ? '' : ` --until ${lastUntil}`} reads them together.`));
      }
    } else if (window && !window.given) {
      console.log(f.dim(`window: last ${window.count} of ${window.of} sessions, `
        + `${Math.round(window.seconds)}s of recorded combat`));
    }
    // THE RATE, beside the model's. A ledger that printed `model: 613.3 dps`
    // and nothing for the capture left the one number a reader came for to
    // be worked out by hand - and it was worked out against three dummies.
    const rate = cmp.totals.rate;
    console.log(f.dim(`capture: ${cap.matched.toLocaleString()} events over ${cap.groups.length} skills`
      + (rate ? `, ${rate.liveDps.toFixed(1)} damage a second over the ${rate.liveSeconds.toFixed(1)}s it was in play` : '')
      + `   model: ${ev.throughput.dps.toFixed(1)} dps${rate ? ` over a ${rate.modelSeconds.toFixed(1).replace(/\.0$/, '')}s fight` : ''}`));
    // ...and the two compared - where they can be. A window that is several
    // stretches of play not played alike (lone presses with pauses between
    // them, a chain-only block, a rotation) has a "time in play" that is all
    // of those, and its rate against ONE fight that presses everything
    // whenever it is ready is no comparison: the 2026-10-13 Mage's whole span
    // reads 88 a second against a model of 228. So there the line says that
    // instead of a percentage.
    if (rate && cmp.totals.matched > 0) {
      const pc = (x) => `${x > 0 ? '+' : ''}${(100 * x).toFixed(1)}%`;
      if (spanFacts?.mixed) {
        console.log(f.warn(`rate: not like for like on this window - it is ${spanFacts.stretches} stretches of play that were not played alike (above the table), `
          + `and the capture's ${rate.liveDps.toFixed(1)} a second is over all of them, pauses of up to ${spanFacts.gapMs / 1000}s between presses included. `
          + 'Take one stretch (--since / --until, --window) before reading a rate, or RATE below.'));
      } else {
        console.log(f.dim(`rate: the model's lines deal ${rate.modelDps.toFixed(1)} a second against the capture's ${rate.liveDps.toFixed(1)}: ${pc(rate.delta)}`
          + (rate.perHitPart != null ? `, of which ${pc(rate.perHitPart)} is the size of the hits (the capture's own hit counts at the model's mean hit) and the rest how often they land (RATE below)` : '')
          + '.'));
      }
    }
    console.log('');

    const t = cmp.totals;
    const poolRows = t.pools.match + t.pools.close + t.pools.miss;
    const pctOf = (x) => (x === null ? '-' : `${(100 * x).toFixed(1)}%`);
    console.log(f.bold(`coverage ${pctOf(t.coverage)}`) + f.dim(t.coverage === null && t.carriedIn
      ? '  every row of this window was carried into it: there is nothing here for the model to cover.'
      : t.carriedIn
        ? '  of the damage the game recorded that was not carried into the window, the model has a line for.'
        : '  of the damage the game recorded, the model has a line for.'));
    console.log(`  matched ${t.matched}   MISSING ${t.missing}   PHANTOM ${t.phantom}`
      + (t.carriedIn ? `   carried-in ${t.carriedIn}` : '')
      + (t.notPressed ? `   not-pressed ${t.notPressed}` : '')
      + `   per-hit: ${t.verdicts.match} match / ${t.verdicts.close} close / ${t.verdicts.miss} miss`
      // A pool has no per-hit claim (verify.mjs `globalPool`): counted apart,
      // by the SHARE it is held to.
      + (poolRows ? `   pool${poolRows > 1 ? 's' : ''} by share: ${t.pools.match} match / ${t.pools.close} close / ${t.pools.miss} miss` : ''));
    console.log('');

    const n = (x, d = 1) => (x === null || x === undefined ? '-' : x.toFixed(d));
    const sd = (x) => (x === null || x === undefined ? '-' : `${x > 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
    if (spanNote) console.log(f.warn(spanNote) + '\n');
    console.log(
f.dim('SKILL'.padEnd(38) + 'STATUS'.padEnd(9) + 'MODEL'.padStart(8) + 'LIVE'.padStart(8)
        + 'PER-HIT'.padStart(9) + 'SHARE'.padStart(8) + 'RATE'.padStart(8) + 'HITS'.padStart(8) + 'CRIT'.padStart(7))
    );
    // A row that is ONE AFFINITY of a skill (verify.mjs compare: the capture
    // logs the skill under several and the model prices them as separate
    // hits) says which in its name, and the cut to the column's width must
    // not be what removes it: the skill's id is shortened instead.
    const shown = (r, w) => {
      if (!r.affinity) return r.id.slice(0, w);
      const tail = ` (${r.affinity})`;
      return (r.skill.length + tail.length <= w ? r.skill : r.skill.slice(0, Math.max(1, w - tail.length - 1)) + '~') + tail;
    };
    for (const r of cmp.rows) {
      // A status wider than its column (NOT-PRESSED, CARRIED-IN) takes the
      // room from the MODEL column beside it, which such a row leaves empty,
      // so LIVE and everything after it stay under their headers.
      const over = Math.max(0, r.status.length + 1 - 9);
      const line = shown(r, 37).padEnd(38) + r.status.padEnd(9)
        + n(r.modelMean).padStart(Math.max(2, 8 - over)) + n(r.liveMean).padStart(8)
        // A pool other hits feed ticks at a rate, not a per-event amount: it
        // is held to SHARE and prints no per-hit figure (the footer says so).
        + (r.globalPool ? 'pool' : sd(r.perHitDelta)).padStart(9) + sd(r.shareDelta).padStart(8) + sd(r.rateDelta).padStart(8)
        + String(Math.round(r.liveHits || r.modelHits)).padStart(8)
        + (r.liveCrit === undefined ? '-' : pctOf(r.liveCrit)).padStart(7);
      if (r.status === 'MISSING' || r.status === 'PHANTOM') console.log(f.warn(line));
      else if (r.status === 'NOT-PRESSED' || r.status === 'CARRIED-IN') console.log(f.dim(line));
      else console.log(line);
    }

    // THE TWO HALVES OF THE DIE (--split). PER-HIT above is a mean over
    // whatever the window happened to roll; here the ordinary hits are held
    // to the model's ordinary hit and the critical ones to its critical one,
    // with how many of each the window holds and the range they span - a
    // line that reads one integer every time says so by itself.
    if (args.flags.split) {
      const rng = (lo, hi) => (lo === null || lo === undefined ? '' : lo === hi ? `=${n(lo, 0)}` : `${n(lo, 0)}-${n(hi, 0)}`);
      console.log('');
      console.log(f.bold('ORDINARY AND CRITICAL HITS APART') + f.dim('  model / live (hits, range) / delta; crit rate model vs live'));
      console.log(f.dim('SKILL'.padEnd(34) + 'ORDINARY'.padStart(9) + 'LIVE'.padStart(8) + ' '.repeat(15) + 'DELTA'.padStart(8)
        + 'CRITICAL'.padStart(10) + 'LIVE'.padStart(8) + ' '.repeat(15) + 'DELTA'.padStart(8) + 'RATE'.padStart(13)));
      for (const r of cmp.rows) {
        if (r.status !== 'BOTH' && r.status !== 'MISSING') continue;
        const half = (model, live, hits, lo, hi, delta) => n(model).padStart(9) + n(live).padStart(8)
          + (hits ? ` (${hits}, ${rng(lo, hi)})` : '').padEnd(15).slice(0, 15) + sd(delta).padStart(8);
        console.log(shown(r, 33).padEnd(34)
          + half(r.modelNonCrit, r.liveNonCrit, r.liveNonCritHits, r.liveNonCritMin, r.liveNonCritMax, r.nonCritDelta)
          + ' ' + half(r.modelCrit, r.liveCritMean, r.liveCritHits, r.liveCritMin, r.liveCritMax, r.critHitDelta)
          + `${r.modelCritRate == null ? '-' : pctOf(r.modelCritRate)} / ${pctOf(r.liveCrit ?? 0)}`.padStart(15));
      }
      console.log(f.dim('A row with no model figure is one the fight kept no decomposition for (a pool, a\n'
        + 'counter priced after the fight). A half with no live figure did not occur in the window.'));
    }

    // The sheet, checked against the game's own arithmetic.
    //
    // A capture's affix rows ARE the game's derivation: one row per applied
    // affix, carrying the value the sheet was built from and the item or skill
    // that applied it. Base stats plus that sum reproduces the in-game sheet to
    // within rounding on every attribute of every class tested - so where the
    // model disagrees, the model is wrong, and by exactly this much.
    //
    // It belongs in this report because a damage delta means nothing until the
    // sheet behind it is known. A skill reading 20% low on a sheet that is
    // itself 12% low is not a 20% damage error.
    if (built.affixes?.length) {
      const base = engine.baseStatsFor(built.unit, built.level);
      // A snap_affix row sourced from a STATUS skill is combat state the probe
      // caught live - Emsey logged one Devote stack mid-fight (+6 FervorRating)
      // and Emsai was mid-dash (+0.3 MoveSpeedFactor) - and the model predicts
      // the STANDING sheet. Both sides therefore exclude statuses: the model
      // stopped folding them in, and the live sum drops the ones the snapshot
      // happened to catch.
      const skillRows = engine.cat.cdb.byId('skill');
      const natures = engine.cat.cdb.enumValues('skill', 'nature');
      const isStatusRow = (a) => {
        const s = /^ESkill:(.+)$/.exec(String(a.source ?? ''));
        if (!s) return false;
        const row = skillRows.get(s[1]);
        return row != null && natures[row.nature] === 'Status';
      };
      const sums = new Map();
      for (const a of built.affixes) {
        const m = /^ETAttribute:(.+)$/.exec(String(a.target ?? ''));
        if (!m || a.value == null) continue;
        if (isStatusRow(a)) continue;
        sums.set(m[1], (sums.get(m[1]) ?? 0) + a.value);
      }
      // Only attributes affixes fully determine. A derived one - CritChance is
      // computed from CritChanceRating, ArmorPenetration from its rating - is
      // not base-plus-affixes, and comparing it that way invents a discrepancy
      // out of the conversion the model is supposed to be doing.
      const derived = new Set(
        (engine.ctx.attrTable?.attrs ?? [])
          .filter((a) => (a.scaling ?? []).length)
          .map((a) => a.id)
      );
      // The same floor the sheet applies. An attribute whose row says it cannot
      // go negative does not, in the game either: Emsey's Corrupted Gifts sum
      // SpellPenetrationRating to -83 and the character screen shows Magic
      // Penetration 0%. Comparing an unclamped sum against a clamped sheet
      // reported a -100% error against a model that was right.
      const attrById = new Map((engine.ctx.attrTable?.attrs ?? []).map((a) => [a.id, a]));
      const rows = [];
      for (const [attr, sum] of sums) {
        if (derived.has(attr)) continue;
        let live = (base.get(attr) ?? 0) + sum;
        const row = attrById.get(attr);
        if (row && !row.negativeAllowed && live < 0) live = 0;
        if (row?.roundUp) live = Math.round(live);
        const model = ev.sheet.get(attr);
        if (model == null || Math.abs(live) < 1e-9) continue;
        rows.push({ attr, live, model, rel: (model - live) / live });
      }
      rows.sort((a, b) => a.rel - b.rel);
      const off = rows.filter((r) => Math.abs(r.rel) > 0.01);
      console.log('');
      console.log(f.bold(`SHEET  ${rows.length - off.length}/${rows.length} within 1% of the game's own affix arithmetic`));
      for (const r of off.slice(0, 10)) {
        console.log(`  ${r.attr.padEnd(24)}${r.live.toFixed(1).padStart(9)}${r.model.toFixed(1).padStart(9)}`
          + `${((r.rel > 0 ? '+' : '') + (100 * r.rel).toFixed(1) + '%').padStart(9)}`);
      }
      if (off.length) {
        // The affix rows are the RECORDING build's arithmetic. On a window
        // from another build a difference here is the patch before it is the
        // model: the 2026-10 build moved the Epic and Legendary item-level
        // bonus, and a pre-patch snapshot of such a weapon reads several
        // percent off (Emsey's August window: Dexterity 169 against 175).
        console.log(f.dim(era.onThisBuild === true
          ? '  game (base + its own affixes) vs model. A damage delta on a wrong sheet\n'
            + '  is not a damage error - fix the sheet first.'
          : '  game (base + its own affixes, as the RECORDING build baked them) vs the\n'
            + '  model on today\'s data. On a window from another build a row here is the\n'
            + '  patch before it is the model, and a damage delta on a moved sheet is not\n'
            + '  a damage error.'));
      }
    }

    console.log('');
    console.log(f.dim(
      'PER-HIT, SHARE and RATE are model MINUS capture, so a positive number is the model\n'
      + 'claiming too much. Read PER-HIT first: what one hit deals does not depend on how often\n'
      + 'it lands. It holds a mean to a mean: the model\'s hit, its ordinary and critical outcomes\n'
      + 'weighed at the build\'s crit chance over the model\'s own fight, against whichever hits\n'
      + 'this window holds.\n'
      + 'A disagreement there is a formula error or a STATE - something the hit found standing,\n'
      + 'which the window holds in one mix and the model\'s fight in another: a charge level, a\n'
      + 'buff\'s stack count, a register another press had spent, the side of the target you\n'
      + 'stood on. Over a few hits it is also the die: which of them happened to crit. It is the\n'
      + 'formula only where the ORDINARY and CRITICAL halves (--split) disagree on a window that\n'
      + 'is one state: one block of play (--window <from>..<to>, or --since / --until), played\n'
      + 'as it was pressed (--replay) or for as long as it lasted (--fight <s>).\n'
      + (stateMixes.length
        ? 'What this build holds of that kind, as far as the model knows:\n'
          + stateMixes.map((m) => (m.kind === 'use rider'
            ? `  ${m.name}${m.amount != null ? ` puts +${Math.round(m.amount * 100)}% in the damage bracket of` : ' is spent by'} the next of `
              + `${m.spenders.map((x) => x.name).join(', ')} to find it ready, and is then away for its cooldown: each of those lines is a mix\n`
              + `  of presses that found it and presses that did not - ${+m.spent.toFixed(1)} of ${+m.presses.toFixed(1)} in the model's fight, and the capture's mix is its own.\n`
            : m.kind === 'side'
              ? `  A base attack landed from behind the target takes +${Math.round(m.amount * 100)}% (the upgrade perk of ${m.weapons.map((w) => w.name).join(' and of ')}), and the model\n`
                + `  bills it on ${Math.round(m.fraction * 100)}% of the swings: a window fought from one side holds all of them or none - --behind-fraction 1 from behind, 0 from the front.\n`
              : `  ${m.name} is priced at ${m.mean.toFixed(1)} of its ${m.cap} stacks, the mean over the model's fight: a hit landed at another count is off by the difference.\n`)).join('')
        : '')
      + (spanFacts?.mixed
        ? 'This window is several stretches that were not played alike (see above the table):\n'
          + 'the mix comes first here.\n'
        : '')
      + (era.onThisBuild === true ? ''
        : 'This window is not known to be recorded on this build (see the top): a disagreement\n'
          + 'can also be whatever the patch changed about that skill.\n')
      + (undecidedNote
        ? 'On this window it can also be the difficulty: the target stood at MaxLevel,\n'
          + 'Heroic reads other armour rows for it, and the model was priced on the rows\n'
          + 'every other difficulty reads (see the top). The same offset on every row is\n'
          + 'that, not a formula.\n'
        : '')
      + (rate
        ? 'RATE is how often a line lands - its rows per second of the model\'s fight against its\n'
          + 'rows per second of the capture\'s time in play (first hit to last, breaks over 30s left\n'
          + 'out) - and the two totals above the table are compared the same way. It is like for\n'
          + 'like on a window that is one fight on one target; a disagreement there with PER-HIT in\n'
          + 'agreement is the rotation or the clock: what was pressed when, what a cast cut short,\n'
          + 'how fast a bar filled.\n'
        : '')
      + (poolRows
        ? 'A line whose PER-HIT reads `pool` is a pool other hits pay into - a part of their damage,\n'
          + 'paid out again tick by tick. What one tick deals follows how much the fight was dealing,\n'
          + 'not a formula of its own: it has no per-hit figure, is held to SHARE, and is counted apart.\n'
        : '')
      + 'MISSING is damage the game did and the bench cannot see. PHANTOM is damage the\n'
      + 'bench claims and the game never recorded. Both outrank any delta.'
      + (t.carriedIn
        ? '\nCARRIED-IN is damage dealt in this window by something pressed or applied before\n'
          + 'it opened. The model has a line for it in a fight that presses it and none in\n'
          + 'this one, which pressed nothing: it is no hole in the model and no evidence\n'
          + 'about it either, and coverage and SHARE are measured without it.'
        : '')
      + (cmp.rows.some((r) => r.affinity)
        ? '\nA row named <skill> (<Affinity>) is one affinity of a skill the capture logs under\n'
          + 'several, where the model prices them as different hits (a status\'s tick and the\n'
          + 'direct hit its re-application plays): each is held to its own rows.'
        : '')));
    {
      // The ceiling, said where it matters: a line that logs whole numbers is
      // compared half a point up, and a hit that never varies can still sit
      // half a point from that.
      const small = cmp.rows.filter((r) => r.status === 'BOTH' && r.logLift > 0 && r.liveMean > 0 && r.liveMean < 60);
      console.log(f.dim(
        'A direct hit is logged as a whole number, the CEILING of what the formula gives, so a\n'
        + `whole-number line is compared with the model's figure plus ${INTEGER_STREAM.lift} (the MODEL column prints\n`
        + 'the figure itself). On a hit that never varies the true lift is anywhere in (0, 1]'
        + (small.length
          ? ':\n' + small.slice(0, 6).map((r) => `  ${r.id} is within ±${(100 * 0.5 / r.liveMean).toFixed(1)}% of where it is printed`).join('\n')
          : '.')));
      if (!args.flags.split) {
        const few = cmp.rows.filter((r) => r.status === 'BOTH' && r.liveHits > 0 && r.liveHits < 30).length;
        if (few) {
          console.log(f.dim(`${few} line${few > 1 ? 's hold' : ' holds'} fewer than 30 hits: there the mean is mostly which hits happened to crit.\n`
            + '--split compares ordinary and critical hits apart.'));
        }
      }
    }
    if (built.gaps.length) {
      console.log('\n' + f.warn(imported ? `${imported.path} does not record:` : 'the dump cannot see:'));
      for (const g of built.gaps) console.log(f.warn(`  - ${g}`));
      console.log(f.dim('  Damage from any of these arrives as MISSING and is not evidence\n'
        + '  that a formula is wrong.'));
    }
  },
};

// --- entry -----------------------------------------------------------------

const USAGE = `farever-bench ${VERSION} - a gear bench for Farever

  bench ui         the character sheet, talent tree, rune page and optimizer in
                   your own browser, served from this machine only
  bench optimize   fill every unpinned slot and socket with the best combination
  bench rank       rank every item that fits one slot, against your current build
  bench sheet      show the stat sheet a build produces
  bench items      list every item legal in a slot for a class
  bench classes    the playable classes and what they scale off
  bench slots      the slots, their stat share, and which augments they host
  bench rarity     which rarities each slot can reach, and how that is derived
  bench targets    what the world actually resists, and what penetration buys
  bench talents    the talent trees and runes, and how much of them is readable
  bench profiles   the stat corners a weapon or a rotation can be compared at
  bench weapons    every mainhand, ranked at one of those corners
  bench layouts    the best FULL build for every ordered (mainhand, arsenal)
                   pair - armour, offhand, augments, arsenal skills, talents
                   and runes searched per pair. Every report is written to
                   disk AS IT FINISHES (default bench-layouts-<class>-<goal>/,
                   --out <dir> moves it): index.json is the live ranking,
                   each pair file reloads with --build, and re-running skips
                   pairs already on disk - a crash or Ctrl+C resumes instead
                   of restarting (--fresh recomputes). --main/--arsenal
                   narrow the sweep, --restarts <n> trades depth for time
                   (default 3), --show <n> prints the top layouts in full,
                   --json <file> additionally collates everything into one
  bench rotation   search for the rotation a weapon wants, and the kit with it
  bench update     the patch-day pipeline: diff the install against the
                   committed fingerprint - every sheet row, every script,
                   every bytecode citation - and print the work list, split
                   into what needs an in-game log, what the SHEET check can
                   confirm, and what is a model re-read. A citation is opened,
                   not just located: MOVED, body CHANGED, STUB (the client no
                   longer carries the body) and MISSING are four different
                   answers. --reanchor lists the citations whose function
                   merely moved and what needs a person (--write rewrites the
                   former in place, --only <path> narrows it). --accept
                   records the new build once addressed, and is refused while
                   a citation is stale (--with-stale-citations defers them,
                   on the record: every later run lists the ones still
                   owed); --json <file> dumps the report; --against
                   <data.cdb or install dir> diffs the game data against an
                   older copy instead of the fingerprint (the code still
                   against the fingerprint), and then says what changed
                   inside each row; --row <sheet>:<id> prints one row's
                   changes in full, a skill's script among them
  bench audit      every assumption and gap in the model
  bench import     what a character sheet or a combat log says, as the bench
                   reads it: kept, dropped and why (--check for an
                   exporter's tests). Every command that builds takes a
                   sheet as its build with --import <file>
  bench submit     one fight for the project: the build it was fought in
                   and its combat log, names removed, as one zip. Prints
                   what it holds and where it would go, and sends nothing
                   without --send (docs/SUBMITTING.md)
  bench verify     hold the model against a recorded capture and print the
                   per-skill difference, signed. Needs --character <Name>,
                   whose gear comes from the modkit's own inventory dump and
                   whose damage comes from the HLX probe's log - or from a
                   character sheet (--import) and a combat log (--capture),
                   which names its own character. Defaults to
                   the span of the capture's richest snapshot of that
                   character (else its last 3 play sessions, --sessions n),
                   optionally one target archetype (--target). --json emits
                   the whole ledger. This is the only command that can report
                   the model wrong without a person deciding that it is.
                   ONE PIECE OF A CAPTURE: --since <ms> and --until <ms> give
                   a window by its two ends (epoch milliseconds, the log's
                   own ts_ms; either alone leaves the other open), and
                   --window <from>..<to> gives one too and may be repeated
                   for several at once. A given window that holds no row of
                   the character (or none on --target) is refused, with
                   where its rows are. A given window is priced with the
                   snapshot STANDING when it opens - the first written
                   inside it when none stands, else the nearest in time,
                   and the build line says which; --snapshot <n> (or
                   @<ms>) names the build instead, and --snapshots lists
                   every snapshot of the character with what each changed.
                   A window is compared with ONE model fight: when it is
                   several stretches of play that were not played alike
                   (some press, some do not; a buff pressed in few of them)
                   the ledger says so above the table, because PER-HIT then
                   mixes states - which a snapshot's whole span usually
                   does. It also says when a neighbouring snapshot is the
                   same build written again, with rows it did not read.
                   The ledger says when a window holds two builds, when
                   other players hit the same target inside it, when it
                   holds no press (the model then swings its chain and
                   presses nothing) and when it holds no base attack (the
                   model then stands still between presses). What a
                   window with no press holds of skills pressed, or of
                   statuses applied, before it opened is filed CARRIED-IN
                   instead of MISSING, with what the log shows standing at
                   the opening; the model's fight opens on nothing. --split
                   compares ordinary and critical hits apart, which is the
                   comparison to read on a window of a few presses.
                   --behind-fraction <0..1> says which side of the target a
                   window was fought from (1 behind, 0 in front), for a
                   build whose weapon upgrade pays only from behind: the
                   ledger names the perk when the build holds one. A pool
                   other hits pay into is held to SHARE and prints "pool"
                   for PER-HIT.
                   A skill the log holds under two affinities, where the
                   model prices them as two hits (a status's tick and the
                   direct hit its re-application plays), is two rows,
                   <skill> (<Affinity>). The model's fight is as long as
                   --fight says (200 s): on a window where something ramps
                   from nothing - a stack counter - give it the window's
                   own length. --replay plays one window's recorded presses
                   at their own times instead of the model's rotation, which
                   is what holds a use-on-cooldown register to the presses
                   that really found it ready; the window has to say where
                   it starts (--since, or --window <from>..), because that
                   is the fight's first second, and the replayed fight is
                   as long as the window (or as --fight says; fifteen
                   seconds past the last press when the window is left
                   open). A recorded press that falls inside a swing of the
                   chain cuts it, as the game does: before the swing's hit
                   it deals nothing and the chain stays on that link, after
                   it the hit stands and the swing ends there.
                   ONE TARGET: a unit is not one target (three yard dummies
                   are three), so with --target <unit> each row is held to
                   the INSTANCE the character was fighting at that moment -
                   the target of its latest press, or where its latest base
                   attack landed - and what it landed on the unit's other
                   instances meanwhile (a spread, an area) is left out,
                   counted and said. --target <unit>#<n> names one instance
                   as the log writes it; --all-instances reads them all (so
                   does --targets above 1). The ledger prints the capture's
                   damage a second over its time in play beside the model's,
                   and RATE per line: how often it lands, model against
                   capture.
                   A summon's swings are logged under the pet's own skill
                   and compared there when the capture holds them under the
                   character's name (probe v10 on). Slots the snapshot
                   cannot read - the Mage's conduits on build 25782799 -
                   are filled from what the character's own rows show, and
                   the ledger says so; --skills <pool>=<a,b,...> names them
                   (--skills conduits=Mage_Conduit_Power,Mage_Conduit_Power).
                   A given window opens the Mage's fight at the Spark the
                   log carries for its first row: under half the pool no
                   conduit fires until Spark comes back.
                   --capture <file> reads another log than the live
                   hlx/logs/bench-probe.csv (a bare name is looked up in that
                   folder): the probe starts a new log with each build, and
                   the ledger says which build its window was recorded on.
                   --dump builds the character from the modkit's inventory
                   dump even when the capture holds a snapshot of it.
                   --target <unit> picks the capture rows (hits on that
                   unit) and prices the model on it, at the level the
                   capture logged; --price-as <target> prices the model on
                   something else (a mode: Ratsar@heroic, a rift:
                   ImpDemon_Rift@scaled, or none). A dummy window recorded
                   before the 2026-10 build is priced on \`none\` by itself:
                   the Dummy had no armour then. A boss logged at MaxLevel
                   stood in Veteran or in Heroic, the capture does not say
                   which, and Heroic reads other armour rows for some: the
                   ledger opens by saying so when it matters, and
                   --price-as <unit>@heroic or @veteran settles it. \`heroic\`
                   speaks for every heroic boss and cannot filter a capture.
                   --capture also reads a combat log another program wrote
                   (docs/COMBAT-LOG.md): a farever-combat-log, or a Wink DPS
                   Meter <id>.json.timeline with its <id>.json beside it.
                   Its whole span is the window unless one is given, its
                   own character is the default --character, and a header
                   that names the difficulty (Veteran, Heroic) prices the
                   model on it unless --price-as, or a mode on --target
                   (Ratsar@heroic), says otherwise. A log whose header
                   names another class than the build's is refused. A Wink
                   summary alone holds totals and no row, and is refused.
                   --import <sheet> builds the character from a character
                   sheet instead of a snapshot or the dump (bench import
                   says what the file holds); no snapshot is chosen then,
                   unless --snapshot names one to take the window from.

The UI in your browser
  The same sheet the packaged desktop app shows, out of this process. It costs
  no Chromium download and needs no code signature to get past SmartScreen, and
  it is how a Linux or macOS player gets the UI at all - the packaged build is
  a Windows binary. Everything is read from your own copy of the game; nothing
  is sent anywhere unless you send a fight to the project yourself, with the
  Send button, and the server listens on this machine only unless you say
  otherwise.

  bench ui --open

  --open                  open the default browser once the server is up
  --port <n>              a fixed port           (default: any free one)
  --host <h>              bind address    (default 127.0.0.1, this machine only)
  --game <path>           your Farever install, if it is not auto-detected

Searching a rotation
  What is searched is a POLICY, not a sequence: an ordered list of (skill,
  condition) that a player can follow, and that transfers across gear because
  its conditions are re-evaluated rather than baked in. A sequence would be
  optimal for one build against one fight, and would learn to dump every
  cooldown before the bell.

  bench rotation --class Warrior --profile armorpen \\
    --pin weapon1=GA_Craft --pin weapon2=GA_Demon

  --rounds <n>            rounds of (search the rotation, then search the kit
                          against it). Default 3; it stops early when neither
                          half moves.
  --restarts <n>          random restarts per rotation search (default 12).
                          Restart 0 always starts from the order the model
                          derives, so the answer can never be worse than it.
  --kit-restarts <n>      restarts for the kit search inside each round (3)
  --validate <n>          how many rolled fights the rotation found is held
                          against the derived order over, to say whether its
                          edge is outside the spread (default 200; 1 skips it)

Stat profiles
  A profile PINS every stat to a flat number, replacing whatever the level curve
  and the gear would produce. Two weapons then differ only in the kit they grant
  and the coefficients they scale by, not in which is the better stat stick. The
  weapon slots stay live; the armour is gone. The rig is 50 everywhere and 100 on
  the one stat a profile names, so "crit" minus "mid" is exactly +50
  CritChanceRating and nothing else moved.

  --profile <name>        zero | mid | strength | dexterity | intellect | faith
                          | vitality | armor | magicarmor | crit | armorpen
                          | spellpen | fervor
  --profile-base <n>      what every stat is pinned to     (default 50)
  --profile-peak <n>      what the named stat is pinned to (default 100)
  --across <p1,p2,...>    (bench weapons) run several corners and report how far
                          the ranking moves between them; (bench rotation)
                          re-evaluate the ONE rotation found at other corners.
  --across-search <list>  (bench rotation) the stronger question: search a FRESH
                          rotation at every corner with the kit held fixed, then
                          cross-evaluate every rotation at every corner. Answers
                          "does a stat repartition change the rotation", and what
                          carrying a single rotation everywhere costs.
  --no-arsenal            (bench weapons) leave the arsenal slot empty
  --pairs                 (bench weapons) sweep every ORDERED (mainhand,
                          arsenal) pair of the best weapons instead
  --top <n>               (with --pairs) how many weapons are paired
                          (default 6, at least 2)

Common flags
  --help, -h              this text
  --version, -V           the version, and nothing else
  --class <name>          Warrior | Rogue | Mage | Priest
  --level <n>             default: the game's MaxLevel
  --verbose               optimize prints the build and where its damage came
                          from. This adds back everything that explains those
                          numbers: the search trace, the rotation's own
                          reasoning, the per-skill refusal causes, the talent
                          coverage note, and the assumptions-and-gaps list
  --goal <g>              dps | hps | sps | ehp | mixed (default dps)
  --weight <g>=<n>        blend goals, e.g. --weight dps=1 --weight ehp=0.25
  --mix <0..1>            the physical share of the damage effective HP is
                          computed against; the rest is magical (default 0.5)
  --slot <slot>           (bench rank, bench items) the slot to rank or list;
                          required there, and bench slots names them
  --all                   (bench rank) every row, not the first fifteen
  --no-empty              (optimize, rotation) the search may not leave a slot
                          empty - the off hand excepted
  --target <t>            none | dummy | reference | trash | small | big | elite
                          | boss | dungeon | heroic | any unit id   (default
                          boss, 0.40/0.40 at your own level). \`none\` mitigates
                          nothing; \`dummy\` is the training dummy's own row,
                          which carries armour since the 2026-10 build. A unit
                          id stands at its row's level in Normal difficulty;
                          add @veteran or @heroic to stand it at MaxLevel
                          (Heroic also reads its heroic rows - Nepsilon@heroic),
                          @scaled to build its pool at your level, as a rift
                          does. \`bench targets\` prints all of it
  --target-level <n>      the level the foe STANDS at. The resist pool is
                          built at its level and divided at yours, so a foe
                          below you mitigates less than its row says. Overrides
                          whatever the target name implies (see bench targets)
  --fight <s>             how long the simulated fight is    (default 200s)
  --fights <n>            roll the procs for real n times and report the mean
                          and the spread; 1 folds them in at their expected
                          rate, which is the same mean without the sampling
  --rotation-file <json>  play an AUTHORED rotation instead of the derived
                          order and the lookahead: the file bench rotation
                          --json writes, or a bare ["Skill_A", ...] priority
                          list. Skills not listed are never pressed. bench
                          sheet --build <that file> plays the rotation saved
                          in it without being asked, as long as the build
                          still holds every skill it presses, and says so
                          on its ROTATION line; a search (optimize, rank) is
                          handed a rotation only by this flag
  --lookahead <s>         seconds of rollout when choosing a cast (default 8);
                          0 gives a plain first-available priority list. The
                          fight is played both ways and the better kept.
  --targets <n>           how many enemies stand in an area  (default 1)
                          Only Area and Aura steps scale with it, and nothing
                          in the data says how many there are - it is an input.
  --target-health <pct>   what percent of its health the target is standing at
                          (default 100). Some script clauses compare the
                          TARGET's health against a threshold - Execution is
                          +25% under 35%; bench audit counts them and says
                          which are priced - and which phase of a fight you are
                          asking about is an input, not something the tool can
                          derive. At 100 an execute rider is correctly worth
                          zero and the output says which ones those were.
  --stars <n|max>         upgrade stars to assume       (default max)
                          Weapons only: the game upgrades weapons, and armour
                          has no upgrade path at all.
  --rarity <list>         restrict to e.g. Rare,Epic
  --rank <n>              weapon mastery rank 1-3      (default max, i.e. fully
                          mastered). A weapon levels with kills and each of its
                          skills - passives included - takes two upgrades, so
                          rank 3 is a weapon you have finished. It applies to
                          weapon skills, combos and weapon passives; class
                          skills do not rank, they take a rune instead.
  --class-skills <n>      how many class skills fit on the bar (default 4).
                          Six exist per class, at levels 3/5/10/15/20/30, so a
                          level-25 character has learned five and slots four.
                          That count is not in the game data.
  --rune <skill>=<rune>   fix one rune slot; repeatable, and PER SLOT - every
                          other rune is still searched. Use =none to force it
                          empty
  --talent <node>=<rank>  fix the talent tree; repeatable. Naming ANY node fixes
                          the WHOLE allocation, because the tree has tier
                          thresholds and a half-pinned allocation is not
                          something the search can complete legally. The
                          allocation is checked against the real rules, so a
                          combination a character could not have is refused
  --talent-points <n>     talent points to spend  (default: the full allowance)
  --talent-points <n>     points to spend in the tree (default: the full 16)
  --rarity-cap <r>        highest rarity a roll may reach (default: derived
                          per slot - see )
  --no-rarity-roll        pin every weapon to the rarity the CDB authors it at
                          (by default a weapon's rarity is treated as rolled at
                          drop, so Epic and Legendary versions are on the
                          table; gear never rolls one and keeps its row's)
  --exclude <regex>       drop matching item ids       (default: none)
  --include-all           no id exclusions at all, and offer the rows nothing
                          in this install hands out (withheld by default -
                          bench audit says how that is read)
  --infusions <list>      which infusions the search may hand out: learnable
                          (default - every one this install does not show to
                          be unobtainable), all, none, or a comma list of ids
                          or names
  --infusion-stat <s>     what an infused piece nobody owns is taken to have
                          rolled as its bonus stat: none (default, priced 0),
                          best, or a rating (CritChance, Fervor,
                          ArmorPenetration, SpellPenetration). Only a piece of
                          the infusion's own faction is ever paid it
  --fervor-scope <s>      all | skills | none   (default all)
                          measured in game: a combo finisher moved by exactly
                          its Fervor, so base attacks get it too
  --no-fervor-damage      the same as --fervor-scope none
  --no-mastery            drop the unverified mastery multipliers
  --tick-source <s>       instigator | carrier   (default instigator)
                          whose Fervor, mastery and crit a status tick takes:
                          the unit that applied it (read on this build, not
                          yet measured) or the unit wearing it (the rule the
                          previous build measured)
  --chain-persists        let the base-attack chain hold its place through a
                          skill cast (reported from play: it does not)
  --behind-fraction <f>   0..1   (default 0.41)
                          the share of base attacks that land from behind the
                          target. The daggers' upgrade perk pays only there
                          (+8% on its row, more with the weapon's rarity) and
                          where you stand is not in the game data: 0.41 is
                          what a player's sessions measured. 1 is every swing
                          from behind, 0 none
  --pickups <f>           0..1   (default 1)
                          the share of a weapon passive's ground drops you
                          walk into, for a cast armed by collecting them (the
                          clouds a censer drops around you). The drops are on
                          an authored timer; whether you reach one is not in
                          the game data. 1 takes every drop the moment it
                          lands and is not a measurement - a build that holds
                          such a passive says what rides on it, and bench
                          audit names the rows and their numbers
  --drops <s>            authored | scaled   (default scaled)
                          whether an unpinned WEAPON or piece of WORN ARMOUR
                          is priced at its own row's level or as a drop at
                          yours, the row's level then being a floor (measured:
                          armour whose row authors level 1 logs 25 on a
                          level-25 character). Necks, rings, trinkets and
                          whatever is crafted are priced at their row's level
                          either way - for a dropped necklace that is an
                          assumption the capture does not hold (bench audit).
                          Only a weapon rolls its rarity
  --swing-floor <s>       the measured floor on a chain link's swing period
                          (default 0; --swing-floor 0.7 restores the old read)
  --build <file.json>     start from a saved build - either a bare loadout or
                          the envelope --json writes, whose recorded goal,
                          target, level, fight and pins become the defaults
  --import <file>         start from a build another program wrote down: a
                          character sheet (docs/CHARACTER-SHEET.md), a modkit
                          inventory dump (with --class, or beside a combat
                          log of its character - verify --capture, submit
                          --log - in the class the log names), a bare
                          loadout or a saved envelope - every shape bench
                          import reads. What it recorded is held, empty
                          included; what it left out is searched and named;
                          a typed --pin, --skills, --rune or --talent wins
                          for what it names; its weapon-skill rank is the
                          default --rank.
                          What was read and dropped is printed first. Not
                          with --build or a questlog link, nor on a command
                          that builds nothing (classes, slots, targets,
                          talents, profiles, rarity, audit, ui, update)
  --json <file.json>      write the result as JSON, and read it back with
                          --build to reproduce the run exactly
  --game <path>           the Farever install, if it cannot be found

Pinning
  --pin chest=Chest_RManfish_Cle       fix an item
  --pin weapon1=Sword_Swarm*3          fix an item at 3 upgrade stars
  --pin trinket=none                   force a slot empty
  --pin feet/enchantfeet=none          force one socket empty
  --pin weapon1=Spear_Eruption@Epic    a weapon at the rarity it rolled (only a
                                       weapon rolls one - gear keeps its row's)
  --pin weapon1=Spear_Eruption^10*0    an instance that dropped at level 10, 0 stars
  --pin chest=Chest_EBee_Fig~Infusion_Bee_DPS/CritChance
                                       an infused piece: ~<infusion>, then
                                       optionally /<the rating its bonus stat
                                       rolled> and ! if the piece is Prismatic.
                                       ~none pins it not infused; with no ~ part
                                       the search chooses the infusion
  --pin neck=Necklace_Z2RCraft+MaPen   craft jewellery pays ONE of the generic
                                       aptitudes it names; this picks which

A questlog.gg build, as pins
  Hand any command a character-builder link and it is fetched, translated into
  the pins above, and run. The class and the level come from the link, so
  neither has to be typed, and anything you DO type wins over what the link
  said - so the last line below asks what that build looks like at level 20
  with a different trinket.

  bench sheet     https://questlog.gg/farever/en/character-builder/<slug>
  bench optimize  https://questlog.gg/farever/en/character-builder/<slug>
  bench optimize  <link> --level 20 --pin trinket=Trinket_Kobold

  --questlog <slug>        the same thing by slug, when a link is awkward
  --questlog-build <n>     which of the character's builds, from 0  (default 0)

  Whatever questlog records and the bench cannot take is printed before the
  run rather than dropped - the cosmetic slots, per-skill arsenal ranks, runes
  on skills the build has no slot for, and the class-skill bar, which questlog
  does not store at all. That last one is why an imported build is not quite
  fully pinned: the bench still searches which class skills are on the bar.
  This, and sending a fight to the project, or asking for its deletion, when
  you do it yourself (bench submit --send or --delete, or the UI's Send and
  Delete), are the only things in the tool that touch the network.
  To see the translation without running it:
    node tools/questlog-import.mjs <link>

Importing a character sheet
  A character sheet is the build a real character wears, written down by
  whatever could read it - an in-game mod, the bench's own save, the modkit's
  login dump (docs/CHARACTER-SHEET.md is the format for an exporter's author).
  Every command that builds takes one as its build with --import <file>.

  bench import <file>     what the file says, as the bench reads it: the
                          character, what was kept, what was dropped and why,
                          what was left open. It reads a combat log too
                          (docs/COMBAT-LOG.md) and says what it holds. It
                          runs nothing.
  --check                 exit 1 when anything was dropped, not understood or
                          listed unreadable (a sheet), or when the log reader
                          names a problem - for an exporter's own tests
  --json <out>            the same as data: for a sheet, {kind, sourceFormat,
                          sheet, report} - under "sheet" the version-1 sheet
                          of what it recorded, as the bench read it (what it
                          left out is left out; a piece's stars, rarity and
                          flags are written as priced), which --import and
                          bench import read back; for a log, its dialect,
                          figures and sentences (a bare --json prints it
                          instead)
  --class, --level        for a file that does not carry them (a modkit dump)

Sending a fight to the project
  The bench gets closer to the game each time its numbers are held against a
  real fight. bench submit packs one - the build it was fought in and its
  log, every other player's name removed and yours made "Submitter", as one
  zip whose files have fixed names - and prints what it holds and where it
  would go. Nothing leaves this machine without --send (or --delete, which
  asks for the deletion of a fight you sent). docs/SUBMITTING.md says what is
  sent, where it goes, and how its deletion is asked for.

  bench submit --log fight.jsonl --import sheet.json
  bench submit --log <id>.json.timeline --class Rogue --pin weapon1=<item>
  bench submit --log fight.jsonl --import sheet.json --zip fight.zip --send

  --log <file>            the fight: a farever-combat-log (docs/COMBAT-LOG.md),
                          gzipped or not, or Wink's <id>.json.timeline - its
                          <id>.json beside it is read with it, and said
  --summary <file>        Wink's summary for that timeline, named by hand
                          (given with no --log, it is sent as totals only)
  --import <file>         the build, as a sheet recorded it (any shape bench
                          import reads; --class and --level for a file that
                          does not carry them); --build <file> reads a build
                          the bench saved the same way. Without either, the
                          build typed by flags (--class, --level, --pin,
                          --no-augment, --skills, --rune, --talent, --stars,
                          --rank, or --questlog <slug>) is sent as typed:
                          what no flag stated is sent as not recorded, and
                          named. Nothing else the build commands take is read
                          here
  --note <text>           a note for the maintainer, 2000 characters at most
                          (private with --send, public on the manual route)
  --keep-name             keep your character's name where your files had it
  --zip [<file>]          save the bundle; with no name, as farever-bench-
                          submission-<first 8 of its id>.zip, which names
                          nothing of yours. Never written over a file it was
                          built from, a receipt, or anything but a bundle.
                          Attached to a new issue by hand, every file in it
                          is public
  --send                  upload it to the project's folder on pCloud, where
                          only the maintainer can read it; nothing is made
                          public. Its receipt is written BEFORE it is
                          sent - beside the zip (<name>.receipt.json), or
                          with no --zip in the folder the UI keeps its
                          receipts in (.cache/submit-receipts), never the
                          current folder - so the deletion of a fight whose
                          answer is lost can still be asked for. Refused
                          while no upload link is set (naming the GitHub
                          form to use instead), and when the sheet and the
                          log name different classes (beside a file, a
                          --class naming the sheet's own class sends it)
  --receipt <file>        build the bundle again as the one that receipt names
                          (its id, key and time), held to the SHA-256 the
                          receipt carries: anything but that zip is refused -
                          other files, note or flags, or the same ones after
                          an update of the game or of the bench. Sent
                          again after a lost answer, it is the same bundle
                          under the same id: if the first did arrive, the
                          maintainer drops the duplicate. A receipt whose
                          fight arrived, or one written for another upload
                          link, is not sent (--zip still saves it)
  --delete <receipt>      ask for a sent fight's deletion: a small request
                          goes to the project's pCloud folder, and the
                          maintainer deletes the fight and the request when
                          they next read it. Asked only through this copy's
                          own upload link; a receipt of another is refused,
                          unless FAREVER_BENCH_UPLOAD_LINK names that one

  FAREVER_BENCH_UPLOAD_LINK, when set, is the upload link sending goes
  through instead of the project's own; none or off switches sending off.

Skill selection
  --skills weapon1=Skill1,Passive      slot two of the three a weapon offers
  --skills prayers=Smite,Life          choose the prayer sequence
  (left alone, the optimiser chooses and prints what it dropped)
  --no-augment weapon1                 no augments at all on that slot

Example
  bench optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1
`;

// --- a questlog.gg link, as pins -------------------------------------------
// One of the two places the bench reaches the network; the other is
// src/submit.mjs, which sends a fight to the project only on `bench submit
// --send` or the UI's Send button, and asks for one's deletion only on `bench
// submit --delete` or the UI's Delete (test/run.mjs "network call sites"
// holds the tree to exactly those). A link is turned into the same
// --pin/--skills/--talent/--rune flags a person would have typed, and pushed
// in FRONT of the ones they did type - so anything named on the command line
// overrides what the link said rather than fighting it.
const QUESTLOG_LINK = /questlog\.gg|character-builder/i;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`questlog answered ${r.status} ${r.statusText}\n  ${url}`);
  return r.json();
}

// The commands whose second argument is their own: `bench import <file>`
// reads that file, and `bench submit` takes its files by flag. A link is not
// looked for there, and nothing there is refused as stray.
const OWN_ARGUMENTS = new Set(['import', 'submit']);

async function applyQuestlog(args) {
  const flagged = typeof args.flags.questlog === 'string' ? args.flags.questlog : null;
  // `bench import` reads a file and builds nothing: a link would be fetched
  // for a command that never looks at it.
  if (args._[0] === 'import' && (flagged || args.flags['questlog-build'] != null)) {
    die('bench import reads a file and does not build from a questlog link - give the link to the command that runs the build');
  }
  const positional = OWN_ARGUMENTS.has(args._[0]) ? [] : args._.slice(1);
  const link = flagged ?? positional.find((a) => QUESTLOG_LINK.test(a)) ?? null;
  // A second positional has never meant anything, so anything else there is a
  // mistake worth naming rather than ignoring.
  const stray = positional.filter((a) => a !== link);
  if (stray.length) {
    die(`unexpected argument "${stray[0]}"\n` +
      '  the only thing a second argument can be is a questlog.gg build link');
  }
  if (!link) return;
  // Two builds to start from, and nothing to say which one: the link would be
  // pushed in front as typed pins and merged with the imported file's.
  if (args.flags.import != null) {
    die('--import and a questlog link are both the build a command starts from - give one of them');
  }

  const slug = slugOf(link);
  const character = await getJson(endpoints(slug).character);
  const authorSlug = character?.result?.data?.character?.user?.slug;
  if (!authorSlug) throw new Error('the questlog payload names no author, so its talents cannot be reached');
  const talents = await getJson(endpoints(slug, authorSlug).talents);

  const which = args.flags['questlog-build'];
  const buildIndex = which == null || which === true ? 0 : Number(which);
  if (!Number.isInteger(buildIndex) || buildIndex < 0) die('--questlog-build needs a whole number from 0');

  const build = normalize(character, talents, { buildIndex });
  const out = translate(build, createEngine({ quiet: true }));

  // The link carries a class and a level, so neither has to be typed - but a
  // typed one still wins, which is what makes "this build at level 20" work.
  if (typeof args.flags.class !== 'string') args.flags.class = out.class;
  if (args.flags.level == null || args.flags.level === true) args.flags.level = String(out.level);

  const ahead = (key, vals) => {
    if (vals.length) args.repeated[key] = [...vals, ...(args.repeated[key] ?? [])];
  };
  ahead('pin', out.pins.filter((p) => !p.isSkills).map((p) => p.arg));
  ahead('skills', out.pins.filter((p) => p.isSkills).map((p) => p.arg));
  ahead('talent', out.talentPins.map((t) => t.arg));
  ahead('rune', out.runePins.map((r) => r.arg));

  console.log(f.bold(build.name) + f.dim('  by ' + (build.author ?? '?') + '  -  questlog.gg/'
    + slug + (build.buildCount > 1 ? '  (build ' + (buildIndex + 1) + '/' + build.buildCount + ')' : '')));
  for (const w of out.warnings) console.log(f.warn('  ' + w));
  console.log();
}

// The commands that read --character. One entry today; a command that learns
// to build from a dump or a snapshot adds itself here.
const READS_CHARACTER = new Set(['verify']);

// The commands that build nothing from a build source, and so refuse
// --import: they list the data (classes, slots, targets, talents, profiles,
// rarity, audit), serve the UI, or read the game for a patch. A command that
// learns to read a build (loadBuild) leaves this list.
const NO_BUILD = new Set(['classes', 'slots', 'targets', 'talents', 'profiles', 'rarity', 'audit', 'ui', 'update']);

// The flags `bench submit` reads and no other command does. Anywhere else
// they would be stored and never looked at - `bench verify --log <fight>`
// pricing the live capture instead of the fight named - so they are refused.
const SUBMIT_ONLY = ['log', 'summary', 'note', 'keep-name', 'zip', 'send', 'receipt', 'delete'];

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  // Before the usage, so a bare `bench --version` answers the question asked
  // rather than printing two hundred lines that do not contain the answer.
  if (args.flags.version || args.flags.V) { console.log(VERSION); return; }
  if (!cmd || args.flags.help || args.flags.h) { console.log(USAGE); return; }
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"\n\n${USAGE}`);
  // --character names the character a capture recorded, and `verify` is the
  // one command that reads it. Everywhere else it was ignored without a word:
  // `bench sheet --class Warrior --character Emsai` printed an empty sheet.
  if ((args.flags.character ?? args.flags.char) != null && !READS_CHARACTER.has(cmd)) {
    die(`--character is read by \`bench verify\` only. \`bench ${cmd}\` would ignore it: `
      + 'a build is given with --class and --pin, or a questlog link.');
  }
  // --import is a build to start from, and these commands start from none.
  // Read anyway, the file was validated and its whole report printed above a
  // listing that never looked at it (`bench talents --import <a Rogue>`
  // printed the Rogue's report, then every class's tree from the Warrior's).
  if (args.flags.import != null && NO_BUILD.has(cmd)) {
    die(`--import is a build to start from, and \`bench ${cmd}\` builds nothing from one`
      + (cmd === 'ui' ? ' - the Import button in the UI reads the same files.'
        : ['talents', 'profiles', 'targets', 'rarity'].includes(cmd) ? ' - --class and --level say what it is asked about.' : '.'));
  }
  const submitFlags = cmd === 'submit' ? [] : SUBMIT_ONLY.filter((flag) => args.flags[flag] != null);
  if (submitFlags.length) {
    die(`--${submitFlags[0]} is read by \`bench submit\` only, and \`bench ${cmd}\` would ignore it`
      + (cmd === 'verify' && submitFlags[0] === 'log' ? ' - bench verify reads a combat log with --capture <file>.'
        : cmd === 'import' && submitFlags[0] === 'summary' ? ' - bench import reads a Wink timeline with the summary beside it.' : '.'));
  }
  // ...and the other way round: what `bench submit` would not read is
  // refused there, before a questlog link is fetched.
  if (cmd === 'submit') {
    const unread = submitUnread(args);
    if (unread) die(unread);
  }
  try {
    await applyQuestlog(args);
    // `verify` streams a capture, so a command may be async now. Awaiting a
    // non-promise is free, and without it a rejection would escape this catch.
    await fn(args);
  } catch (e) {
    die(`\n${e.message}\n` + (process.env.BENCH_DEBUG ? '\n' + e.stack : f.dim('\n(BENCH_DEBUG=1 for a stack trace)')));
  }
}

main(process.argv.slice(2));
