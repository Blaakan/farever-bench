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
// directory. The network is reached in exactly one case: you handed it a
// questlog.gg link, which is fetched, translated into pins, and then treated
// as if you had typed them.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, GOALS, FERVOR_SCOPES } from '../src/engine.mjs';
import { emptyLoadout, classOf } from '../src/loadout.mjs';
import { optimize, rankSlot } from '../src/optimize.mjs';
import {
  makePolicy, derivedApl, repairApl, searchApl, vocabularyFor, condLabel,
} from '../src/rotation.mjs';
import { slugOf, endpoints, normalize, translate } from '../src/questlog.mjs';
import { aggregate, sessions, snapshots } from '../src/capture.mjs';
import { compare } from '../src/verify.mjs';
import { readDump, toLoadout, listCharacters, fromSnapshot } from '../src/inventory.mjs';
import { requireGame } from '../src/lib/game.mjs';
import * as f from '../src/format.mjs';

export const VERSION = '0.1.0';

// --- argument parsing ------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], flags: {}, repeated: {} };
  const REPEATABLE = new Set(['pin', 'no-augment', 'weight', 'skills', 'rune', 'talent']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    let key = (eq >= 0 ? a.slice(0, eq) : a).replace(/^--?/, '');
    let val = eq >= 0 ? a.slice(eq + 1) : null;
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

function applyPins(engine, loadout, args, { stars, rarityRoll, saved = null }) {
  const { cat } = engine;
  const slotIds = cat.combatSlots().map((s) => s.id);
  const augTypeIds = cat.augmentTypes.map((a) => a.id);
  const pinnedGear = new Set();
  const pinnedAug = new Set();
  const augPins = [];

  // A saved envelope records what was held fixed. Re-reading it re-pins the
  // same things, so `optimize --json x` then `optimize --build x` reproduces
  // the run rather than quietly re-opening every slot the user had fixed.
  // Any --pin on the command line replaces the saved set outright, because
  // merging two pin sets silently is how a user ends up unable to unpin.
  const savedPins = saved?.envelope?.pinned ?? null;
  if (savedPins && !(args.repeated.pin ?? []).length) {
    for (const slot of savedPins.gear ?? []) if (slotIds.includes(slot)) pinnedGear.add(slot);
    for (const key of savedPins.augments ?? []) pinnedAug.add(key);
  }
  const savedSkillPins = savedPins && !(args.repeated.skills ?? []).length ? (savedPins.skills ?? []) : [];

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
    if (/^(none|empty|-)$/i.test(rhs)) { delete loadout.gear[slot]; continue; }

    // item [ ^instanceLevel ] [ @rarity ] [ *stars ] [ +generic ]
    const m = /^([^@*^+]+)(?:\^(\d+))?(?:@([^*^+]+))?(?:\*(\d+))?(?:\+([A-Za-z]+))?$/.exec(rhs);
    if (!m) die(`--pin "${spec}": cannot read the item part "${rhs}"`);
    const itemId = resolve(m[1], cat.items.filter((i) => i.slots.includes(slot)).map((i) => i.id), `item for ${f.short(slot)}`);
    const item = cat.itemById.get(itemId);
    const cls = classOf(cat, loadout);
    if (!cat.usableBy(item, cls.aptitude)) {
      die(`${cls.unit} cannot use ${itemId} - it needs aptitude ${item.aptitudes.join(' or ')}`);
    }
    if (item.level != null && item.level > loadout.level) {
      die(`${itemId} needs level ${item.level}, the build is level ${loadout.level}`);
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
    loadout.gear[slot] = { item: itemId, rarity, stars: capped, level: instanceLevel, generic };
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
    const choices = cat.augmentCandidates(type).map((a) => a.id);
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

  // --skills weapon1=Sword_Swarm_Skill1,Sword_Swarm_Passive
  // --skills prayer=Smite,Life
  // A weapon offers three and you slot two, so this is a real build decision.
  // Left alone, the search picks; named here, it is fixed.
  const pinnedSkills = new Set();
  loadout.skills ??= {};
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
  // Saved skill pins hold whatever the file already put in `loadout.skills`.
  for (const key of savedSkillPins) if (loadout.skills[key]?.length) pinnedSkills.add(key);

  // --- runes, one pool at a time -------------------------------------------
  // `--rune <skill>=<rune>`. The pool is named by the skill that owns it, which
  // is how `runePools` keys them, and every other slot stays searchable.
  const pinnedRunes = new Set();
  loadout.runes ??= {};
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

  // --- talents --------------------------------------------------------------
  // `--talent <node>=<rank>`. Naming ANY node fixes the WHOLE allocation: the
  // tree has tier thresholds, so a half-pinned allocation is not a constraint
  // the greedy can satisfy without re-deciding which branches are even
  // reachable. Say so rather than silently searching around the pin.
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
    const bad = engine.talents.illegalAllocation(loadout.class, loadout.talents, {
      level: loadout.level,
      points: engine.talents.pointsAt(loadout.level, null),
      granted: new Set(),
    });
    if (bad) die(`--talent: ${bad}`);
    pinnedTalents = true;
  }

  return { pinnedGear, pinnedAug, pinnedSkills, pinnedRunes, pinnedTalents };
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

// Dev-only items are in the same sheet as everything else with no flag to tell
// them apart, so the one heuristic is their id prefix. Visible and overridable
// rather than silent: a filter you cannot see is a filter you cannot check.
const DEFAULT_EXCLUDE = '^GM_';

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
export const ENVELOPE_KEYS = ['goal', 'weights', 'target', 'fervorScope', 'stars', 'rank', 'level', 'mix'];

function readBuildFile(args) {
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
  // Default to a boss rather than to `Armor_ExpectedReduction`. Every named boss
  // and every world elite sits at 0.40 reduction while that constant is 0.25,
  // which understates penetration by nearly half against the content anyone
  // actually gears for. See `bench targets`.
  //
  // An envelope written by this version records the target NAME. One written
  // by an older version recorded only the label ("named boss (Ratsar: 0.4/0.4)"),
  // so the unit id is recovered from the parentheses rather than failing.
  const savedTarget = typeof env.target === 'string'
    ? (/^[A-Za-z0-9_]+$/.test(env.target) ? env.target : (/\(([A-Za-z0-9_]+):/.exec(env.target)?.[1] ?? null))
    : null;
  const targetName = String(args.flags.target ?? savedTarget ?? 'boss');
  const rank = Number(from('rank', 'rank', engine.ctx.consts.weaponSkillMaxRank));
  const mix = Number(from('mix', 'mix', 0.5));
  const exPattern = args.flags['include-all'] ? null
    : (typeof args.flags.exclude === 'string' ? args.flags.exclude : DEFAULT_EXCLUDE);
  let exclude = null;
  if (exPattern) {
    try { exclude = new RegExp(exPattern); } catch (e) { die(`--exclude is not a valid regex: ${e.message}`); }
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
  return {
    engine, stars, rarities, goal, targetName, rank, mix, exclude, rarityCap, talentPoints,
    saved, fight, numFlag, profile, profileValues,
    // A bare loadout carries its own level, and the foe, the rating->percent
    // conversions and the candidate list all have to agree with it. Reporting a
    // level-10 character against a level-25 foe mixed two levels in one page.
    level: (args.flags.level == null && env.level == null && saved?.loadout?.level > 0)
      ? saved.loadout.level : level,
    // On by default: rarity is rolled at drop, so a Rare-authored chest that can
    // land Epic or Legendary should be on the table. --no-rarity-roll pins every
    // item to the rarity the CDB authors it at. It round-trips like everything
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
  const target = s.engine.combat.foe(s.targetName, s.level);
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
  const target = s.engine.combat.foe(s.targetName, s.level);
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

const commands = {
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
    console.log(f.table(['SLOT', 'CATEGORY', 'STAT FACTOR', 'HOSTS AUGMENT'],
      engine.cat.combatSlots().map((s) => {
        const types = engine.cat.items
          .filter((i) => i.slots.includes(s.id) && !i.isAugment)
          .flatMap((i) => engine.cat.socketsFor(i));
        return [f.short(s.id), s.category, s.affixFactor === 1 ? '' : f.warn('x' + s.affixFactor),
          [...new Set(types)].map((t) => t.replace(/^Augment/, '')).join(', ') || f.dim('-')];
      })));
    console.log('\n' + f.dim('Slot factor: Slot_Weapon2 (the arsenal weapon) contributes 40% of its stats.'));
  },

  items(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    const cls = classOf(s.engine.cat, loadout);
    const slotIds = s.engine.cat.combatSlots().map((x) => x.id);
    if (typeof args.flags.slot !== 'string') die(`--slot is required. One of: ${slotIds.map(f.short).join(', ')}`);
    const slot = resolve(args.flags.slot, slotIds, 'slot');
    const list = s.engine.cat.candidates(slot, {
      aptitude: cls.aptitude, charLevel: s.level,
      rarities: s.rarities, exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
      talentPoints: s.talentPoints,
    });
    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`${cls.unit} ${s.level} - ${f.short(slot)} - ${list.length} legal ` +
      `${s.rarityRoll ? '(item, rarity) pairs' : 'items'}\n`);
    console.log(f.table(['ITEM', 'NAME', 'RAR', 'ROLL', 'MAX UPG', 'LVL', 'FACTION', 'GIVES', 'SKILLS'],
      list.map((c) => [
        c.item.id, c.item.name === c.item.id ? '' : c.item.name, c.rarity,
        c.chance != null && !c.authored ? f.pct(c.chance, 0) : '',
        s.engine.cat.maxStars(c.item, c.rarity),
        c.item.level ?? f.dim('(scales)'),
        c.item.faction ?? (c.generic ? f.warn(c.generic) : f.dim("-")),
        f.ratingGiven(s.engine.cat, c.item, cls.aptitude, c.rarity, c.generic) ?? f.dim('-'),
        c.item.skills.length ? f.warn(String(c.item.skills.length)) : '',
      ]), { align: [null, null, null, 'r', 'r', 'r'] }));
  },

  sheet(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    const pins = applyProfile(s, loadout,
      applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved }));
    const target = s.engine.combat.foe(s.targetName, s.level);
    const ev = s.engine.evaluate(loadout, { target, rank: s.rank, mix: s.mix, goal: simGoalOf(s) });
    console.log(f.header(s.engine, VERSION) + '\n');
    if (ev.profile) console.log(f.profileBlock(ev.profile) + '\n');
    console.log(f.gearBlock(s.engine, loadout) + '\n');
    if (s.engine.socketsOf(loadout).length) {
      console.log(f.bold('AUGMENTS'));
      console.log(f.augmentBlock(s.engine, loadout) + '\n');
    }
    if (s.engine.plan.pools(loadout).length) {
      console.log(f.bold('SKILLS'));

      console.log(f.skillsBlock(s.engine, loadout, ev, { pinnedSkills: pins.pinnedSkills }) + '\n');
    }
    console.log(f.sheetBlock(s.engine, ev, { level: s.level }));
    console.log(f.throughputBlock(s.engine, ev, { goal: s.goal }) + '\n');
    console.log(f.auditBlock(s.engine));
  },

  rank(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level, s.saved);
    applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved });
    const slotIds = s.engine.cat.combatSlots().map((x) => x.id);
    if (typeof args.flags.slot !== 'string') die(`--slot is required. One of: ${slotIds.map(f.short).join(', ')}`);
    const slot = resolve(args.flags.slot, slotIds, 'slot');
    const target = s.engine.combat.foe(s.targetName, s.level);
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
    const target = s.engine.combat.foe(s.targetName, s.level);
    // Validated like every other number: `--restarts abc` used to make the
    // search loop run zero times and surface as a null dereference inside
    // optimize() rather than as a message.
    const restarts = s.numFlag('restarts', 3, { integer: true });

    const t0 = Date.now();
    const res = optimize(s.engine, {
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
        (pins.pinnedAug.size ? `   sockets: ${[...pins.pinnedAug].map((k) => k.replace(/Slot_|Augment/g, '')).join(', ')}` : '')));
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
      console.log(f.throughputBlock(s.engine, res.evaluation, { goal: s.goal }) + '\n');
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
        stars: s.stars, rank: s.rank, level: s.level, mix: s.mix,
        rarityRoll: s.rarityRoll,
        fight: s.fight.seconds, fights: s.fight.count, targets: s.fight.targets,
        lookahead: s.fight.lookahead,
        pinned: { gear: [...pins.pinnedGear], augments: [...pins.pinnedAug], skills: [...pins.pinnedSkills] },
        build: res.loadout,
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

    console.log('\n' + f.warn('WHAT THE DATA DOES NOT SAY'));
    console.log([
      '  No column anywhere declares a rarity ceiling. The seven columns typed on',
      '  `rarity` are: item.rarity, aptitude@atbScaling.conds.minRarity,',
      '  itemType@props@rarities.rarity, itemType@defaultIcons.rarity,',
      '  job@recipeModels.rarity, and two constant sub-columns for enchant',
      '  materials and scrap quantities. `lootTable` carries no rarity at all, and',
      '  there is no RarityKind custom type. `WeaponRarityChances_Low` exists as a',
      '  constant but is an empty stub with only a 0-10 level range in it.',
      '',
      '  So the ceiling is a content decision in code, and the two rules above',
      '  stand in for it. Both move on their own: the weapon ceiling follows the',
      '  AllowRandomWeaponDrop flag, and the gear ceiling rises by itself the day',
      '  a patch authors an Epic chest. Override either with --rarity-cap.',
    ].join('\n'));
  },

  targets(args) {
    const s = commonSetup(args);
    const { combat } = s.engine;
    const [a, b] = s.engine.ctx.consts.resistFormula;
    // Damage that gets through, at a given penetration.
    const through = (armor, pen) => {
      const r = armor * (1 - pen / 100);
      return 1 - r / (r + a + b * s.level);
    };

    console.log(f.header(s.engine, VERSION) + '\n');
    console.log(`What the world resists at level ${s.level}, and what penetration buys against it.\n`);
    console.log(f.table(
      ['TARGET', 'UNIT', 'PHYS', 'MAG', 'ARMOUR', 'NO PEN', '25% PEN', '50% PEN', 'GAIN @50%'],
      combat.foes.map((n) => {
        const t = combat.foe(n, s.level);
        const base = through(t.armor, 0);
        return [
          n, t.name.replace(/^[^(]*\(|\)$/g, ''),
          f.pct(t.physReduction, 0), f.pct(t.magicReduction, 0), f.num(t.armor, 0),
          f.pct(base), f.pct(through(t.armor, 25)), f.pct(through(t.armor, 50)),
          t.armor > 0 ? f.signedPct(through(t.armor, 50) / base - 1, 1) : f.dim('-'),
        ];
      }), { align: [null, null, 'r', 'r', 'r', 'r', 'r', 'r', 'r'] }));

    console.log(f.dim(`\n  ${combat.targetsByUnit.size} units resolve an armour intent through inheritance, ` +
      'so --target also\n  accepts any unit id directly.'));

    console.log('\n' + f.bold('WHERE THESE COME FROM'));
    console.log([
      '  `unit.stats[].specScaling.armorReduction` and `.magicReduction`. Foes',
      '  express armour as a target damage REDUCTION, exactly the way the four',
      '  classes do, and resistForReduction turns that intent into a number. 27',
      '  units declare one and the rest inherit it, so nothing here is invented.',
      '',
      '  The ladder the world is built on:',
      '',
      '    W_Assassin 0.20  <  W_Base_Small / D_Base_Small 0.25  <  W_Base 0.30',
      '      <  W_Base_Big / W_Base_Unique / D_Base_Big 0.35  <  W_Base_Elite 0.40',
      '      =  every named boss (Ratsar, Mokshi, Crabgantua, Phrixes, Cleodora,',
      '         MunsterChuck, Ulserous, DemonSuperElite)',
      '',
      f.bold('  Two things follow, and both matter for gearing:'),
      '',
      '  * Physical and magical reduction are EQUAL on every real foe. Only the',
      '    dev punching bags split them (PunchingBagArmor 0.5/0, PunchingBagMagicRes',
      '    0/0.5). So ArmorPenetration and SpellPenetration are worth the same',
      '    against everything currently in the game - which one you want is decided',
      '    by your class and your gear\'s faction, never by the fight.',
      '',
      `  * Armor_ExpectedReduction (${s.engine.cdb.constant('Armor_ExpectedReduction')}) is well below what you actually fight, so`,
      '    it understates penetration by nearly half against a boss. That is why',
      '    the default target is a boss and not that constant.',
      '',
      f.dim('  Not modelled: unitType.props.resistance is an affinity-level resistance'),
      f.dim('  hook and only Bee uses it (Honey), so it is inert. Foe level is taken'),
      f.dim('  from --level; zone rows carry levels 1..25 if you want a specific one.'),
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
                  : f.dim("no affix, no effect, no status"))];
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
    console.log([
      "  " + rd.length + " of " + all.length + " talent nodes declare something a data-driven model can",
      "  read - a stat affix, a self-buff status, or a damage effect. The other",
      "  " + (all.length - rd.length) + " declare no affix, no effect and no status - but 72 of them DO",
      "  ship an hscript body, and between them those scripts call only 63",
      "  distinct names - about 39 real host functions once the entry hooks and",
      "  built-ins are removed. So the talent layer is blocked on the same small",
      "  script kernel the rest of the skill work needs, not on absent data. Every",
      "  one of the 88 nodes also carries a texts.desc to check an implementation",
      "  against.",
      "",
      "  So the optimiser allocates points over the readable nodes and STOPS. It",
      "  does not spend the remainder on nodes it cannot tell apart, because a",
      "  build assembled that way would look authoritative and be arbitrary. The",
      "  unspent points are reported rather than quietly filled.",
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
    const target = s.engine.combat.foe(s.targetName, s.level);
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
      stars: s.stars, rank: s.rank, level: s.level, mix: s.mix,
      rarityRoll: s.rarityRoll,
      fight: s.fight.seconds, fights: s.fight.count, targets: s.fight.targets,
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
      console.log(f.throughputBlock(s.engine, k.res.evaluation, { goal: s.goal }));
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
    const target = s.engine.combat.foe(s.targetName, s.level);
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
      const rolledTarget = rolled.combat.foe(s.targetName, s.level);
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
        stars: s.stars, rank: s.rank, level: s.level, mix: s.mix, rarityRoll: s.rarityRoll,
        fight: s.fight.seconds, fights: s.fight.count, targets: s.fight.targets,
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
    const target = s.engine.combat.foe(s.targetName, s.level);
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

  audit(args) {
    const { engine } = commonSetup(args);
    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.auditBlock(engine));
    console.log('\n' + f.dim('See docs/MODEL.md for where each formula came from.'));
  },

  // Hold the model against the record. Every other command reports what the
  // bench BELIEVES; this one reports where that belief disagrees with what the
  // game actually did, per skill, signed.
  async verify(args) {
    // `rank` is weapon mastery, and it is not decoration: a script that opens
    // `if (rank >= 3)` is invisible below it. Daggers_DuplicatePoison_Skill1's
    // whole bonus-damage hook is behind that gate, and evaluating at the
    // default rank of 1 silently priced a quarter of the build's damage at
    // zero. Every other command takes this from commonSetup; so does this one.
    const { engine, rank, mix } = commonSetup(args);
    const game = requireGame(args._);
    const character = args.flags.character ?? args.flags.char;
    if (typeof character !== 'string') {
      die('verify needs --character <Name> - the character the capture recorded.\n'
        + `Known in this install: ${listCharacters(game).join(', ') || '(none)'}`);
    }

    const capturePath = typeof args.flags.capture === 'string'
      ? args.flags.capture
      : join(game, 'hlx', 'logs', 'bench-probe.csv');

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
    const richness = (x) => ((x.sockets ?? []).length ? 1 : 0) + ((x.affixes ?? []).length ? 1 : 0);
    const snap = usable.length
      ? usable.reduce((best, c) => {
        if (c.slots !== best.slots) return c.slots > best.slots ? c : best;
        const cr = richness(c.s);
        const br = richness(best.s);
        if (cr !== br) return cr > br ? c : best;
        return c.s.events > best.s.events ? c : best;
      }).s
      : null;
    // Falling back is fine; falling back QUIETLY is not. A capture that holds
    // snapshots for this character which none of them can be used is a probe
    // problem, and the run must not read as though no snapshot was ever taken.
    const snapNote = (!snap && snaps.snapshots.length)
      ? `${snaps.snapshots.length} snapshot(s) for ${character} are in the capture but carry no gear `
        + '- an older probe build. Falling back to the login dump; re-capture to use them.'
      : null;

    let built;
    if (snap) {
      // The snapshot has no runes, so the class still comes from the dump when
      // there is one - same character, and the class does not change.
      let unit = wantClass;
      if (!unit) {
        try { unit = toLoadout(engine.cat, readDump(game, character)).unit; } catch { unit = null; }
      }
      if (!unit) die(`${character} has a capture snapshot but no rune list to name the class - pass --class.`);
      built = fromSnapshot(engine.cat, snap, { level: wantLevel, unit });
    } else {
      built = toLoadout(engine.cat, readDump(game, character), { level: wantLevel, unit: wantClass });
    }

    // A capture is many hours across many builds; the dump is one instant. The
    // default window is the character's last few play sessions, because that is
    // the stretch most likely to have been played in the gear they are wearing
    // now. Comparing against the whole file reads their entire back catalogue
    // of weapons as missing coverage - the first run of this command did.
    const wantSessions = args.flags.sessions != null && args.flags.sessions !== true
      ? Number(args.flags.sessions) : 3;
    let since = args.flags.since != null && args.flags.since !== true ? Number(args.flags.since) : null;
    let until = null;
    let window = null;
    // A snapshot IS the window: the build it describes stands from the moment it
    // was written until the next one. That is a far better boundary than "the
    // last few sessions", which was only ever a guess at when the gear last
    // changed.
    if (since === null && snap) {
      since = snap.ts;
      until = snap.until;
      window = {
        fromSnapshot: true,
        events: snap.events,
        seconds: until ? (until - snap.ts) / 1000 : null,
      };
    }
    if (since === null) {
      const s = await sessions(capturePath, { source: character, gapMs: 120_000 });
      const real = s.sessions.filter((x) => x.seconds >= 30);
      if (!real.length) {
        die(`${character} has no recorded damage in ${capturePath}.\n`
          + 'Either the probe never saw this character, or the name is wrong.');
      }
      const take = real.slice(-Math.max(1, wantSessions));
      since = take[0].startTs;
      window = { count: take.length, of: real.length, seconds: take.reduce((a, x) => a + x.seconds, 0) };
    }

    const cap = await aggregate(capturePath, {
      source: character,
      target: typeof args.flags.target === 'string' ? args.flags.target : null,
      groupBy: 'skill',
      since,
      until,
    });
    const ev = engine.evaluate(built.loadout, { rank, mix });
    // What the player actually pressed in this window, so a model line with no
    // recorded damage can be told apart from an invented one: a skill never
    // pressed is a rotation the human did not play, not a phantom source.
    const pressAgg = await aggregate(capturePath, {
      source: character, event: 'press', groupBy: 'skill', since, until,
    });
    const pressed = new Set(pressAgg.groups.map((g) => g.key));
    const cmp = compare({ modelLines: ev.throughput.lines, captureGroups: cap.groups, pressed });

    if (args.flags.json) {
      console.log(JSON.stringify({
        character, unit: built.unit, level: built.level,
        capture: capturePath, since, window, gaps: built.gaps,
        modelDps: ev.throughput.dps, ...cmp,
      }, null, 2));
      return;
    }

    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.bold(`${character} - ${built.unit} ${built.level}`) + f.dim(
      `  ${built.placed.length} slots from ${snap ? 'the capture\'s own snapshot' : 'the modkit dump'}`));
    if (snapNote) console.log(f.warn(snapNote));
    if (window?.fromSnapshot) {
      console.log(f.dim(`window: the snapshot's own span - ${window.events.toLocaleString()} events`
        + (window.seconds ? ` over ${Math.round(window.seconds)}s` : ', open-ended')));
    } else if (window) {
      console.log(f.dim(`window: last ${window.count} of ${window.of} sessions, `
        + `${Math.round(window.seconds)}s of recorded combat`));
    }
    console.log(f.dim(`capture: ${cap.matched.toLocaleString()} events over ${cap.groups.length} skills`
      + `   model: ${ev.throughput.dps.toFixed(1)} dps`));
    console.log('');

    const t = cmp.totals;
    const pctOf = (x) => (x === null ? '-' : `${(100 * x).toFixed(1)}%`);
    console.log(f.bold(`coverage ${pctOf(t.coverage)}`) + f.dim(
      `  of the damage the game recorded, the model has a line for.`));
    console.log(`  matched ${t.matched}   MISSING ${t.missing}   PHANTOM ${t.phantom}`
      + (t.notPressed ? `   not-pressed ${t.notPressed}` : '')
      + `   per-hit: ${t.verdicts.match} match / ${t.verdicts.close} close / ${t.verdicts.miss} miss`);
    console.log('');

    const n = (x, d = 1) => (x === null || x === undefined ? '-' : x.toFixed(d));
    const sd = (x) => (x === null || x === undefined ? '-' : `${x > 0 ? '+' : ''}${(100 * x).toFixed(1)}%`);
    console.log(
      f.dim('SKILL'.padEnd(38) + 'STATUS'.padEnd(9) + 'MODEL'.padStart(8) + 'LIVE'.padStart(8)
        + 'PER-HIT'.padStart(9) + 'SHARE'.padStart(8) + 'HITS'.padStart(8) + 'CRIT'.padStart(7))
    );
    for (const r of cmp.rows) {
      const line = r.id.slice(0, 37).padEnd(38) + r.status.padEnd(9)
        + n(r.modelMean).padStart(8) + n(r.liveMean).padStart(8)
        + sd(r.perHitDelta).padStart(9) + sd(r.shareDelta).padStart(8)
        + String(Math.round(r.liveHits || r.modelHits)).padStart(8)
        + (r.liveCrit === undefined ? '-' : pctOf(r.liveCrit)).padStart(7);
      if (r.status === 'MISSING' || r.status === 'PHANTOM') console.log(f.warn(line));
      else if (r.status === 'NOT-PRESSED') console.log(f.dim(line));
      else console.log(line);
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
        console.log(f.dim('  game (base + its own affixes) vs model. A damage delta on a wrong sheet\n'
          + '  is not a damage error - fix the sheet first.'));
      }
    }

    console.log('');
    console.log(f.dim(
      'PER-HIT and SHARE are model MINUS capture, so a positive number is the model\n'
      + 'claiming too much. Read PER-HIT first: it needs no clock and no fight boundary,\n'
      + 'so a disagreement there is a formula error and nothing else.\n'
      + 'MISSING is damage the game did and the bench cannot see. PHANTOM is damage the\n'
      + 'bench claims and the game never recorded. Both outrank any delta.'));
    if (built.gaps.length) {
      console.log('\n' + f.warn('the dump cannot see:'));
      for (const g of built.gaps) console.log(f.warn(`  - ${g}`));
      console.log(f.dim('  Damage from any of these arrives as MISSING and is not evidence\n'
        + '  that a formula is wrong.'));
    }
  },
};

// --- entry -----------------------------------------------------------------

const USAGE = `farever-bench ${VERSION} - a gear bench for Farever

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
  bench audit      every assumption and gap in the model
  bench verify     hold the model against a recorded capture and print the
                   per-skill difference, signed. Needs --character <Name>,
                   whose gear comes from the modkit's own inventory dump and
                   whose damage comes from the HLX probe's log. Defaults to
                   the last 3 play sessions (--sessions n, --since <ms>),
                   optionally one target archetype (--target). --json emits
                   the whole ledger. This is the only command that can report
                   the model wrong without a person deciding that it is.

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

Common flags
  --class <name>          Warrior | Rogue | Mage | Priest
  --level <n>             default: the game's MaxLevel
  --verbose               optimize prints the build and where its damage came
                          from. This adds back everything that explains those
                          numbers: the search trace, the rotation's own
                          reasoning, the per-skill refusal causes, the talent
                          coverage note, and the assumptions-and-gaps list
  --goal <g>              dps | hps | sps | ehp | mixed (default dps)
  --weight <g>=<n>        blend goals, e.g. --weight dps=1 --weight ehp=0.25
  --target <t>            dummy | small | trash | big | elite | boss | dungeon
                          | reference | any unit id     (default boss)
  --fight <s>             how long the simulated fight is    (default 200s)
  --fights <n>            roll the procs for real n times and report the mean
                          and the spread; 1 folds them in at their expected
                          rate, which is the same mean without the sampling
  --lookahead <s>         seconds of rollout when choosing a cast (default 8);
                          0 gives a plain first-available priority list. The
                          fight is played both ways and the better kept.
  --targets <n>           how many enemies stand in an area  (default 1)
                          Only Area and Aura steps scale with it, and nothing
                          in the data says how many there are - it is an input.
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
  --no-rarity-roll        pin every item to the rarity the CDB authors it at
                          (by default rarity is treated as rolled at drop, so
                          Epic and Legendary versions are on the table)
  --exclude <regex>       drop matching item ids       (default ^GM_)
  --include-all           no id exclusions at all
  --fervor-scope <s>      all | skills | none   (default all)
                          measured in game: a combo finisher moved by exactly
                          its Fervor, so base attacks get it too
  --no-mastery            drop the unverified mastery multipliers
  --chain-persists        let the base-attack chain hold its place through a
                          skill cast (reported from play: it does not)
  --drops <s>             authored | scaled   (default scaled)
                          whether an unpinned WEAPON's stats follow its own
                          row's level or a drop at yours. Gear is unaffected
                          either way: the live bakes show authored-level gear
                          keeping its level exactly (a level-20 necklace logs
                          iLevel 210 on a level-25 character) while a weapon
                          generates at the source's level. Rarity follows the
                          same split - only a weapon rolls one
  --swing-floor <s>       the measured floor on a chain link's swing period
                          (default 0; --swing-floor 0.7 restores the old read)
  --build <file.json>     start from a saved build - either a bare loadout or
                          the envelope --json writes, whose recorded goal,
                          target, level, fight and pins become the defaults
  --json <file.json>      write the result as JSON, and read it back with
                          --build to reproduce the run exactly
  --game <path>           the Farever install, if it cannot be found

Pinning
  --pin chest=Chest_RManfish_Cle       fix an item
  --pin weapon1=Sword_Swarm*3          fix an item at 3 upgrade stars
  --pin trinket=none                   force a slot empty
  --pin feet/enchantfeet=none          force one socket empty
  --pin chest=Chest_RManfish_Cle@Epic  assume a particular drop rarity
  --pin weapon1=Spear_Eruption^10*0    an instance that dropped at level 10, 0 stars
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
  This is the ONLY thing in the tool that touches the network.
  To see the translation without running it:
    node tools/questlog-import.mjs <link>

Skill selection
  --skills weapon1=Skill1,Passive      slot two of the three a weapon offers
  --skills prayers=Smite,Life          choose the prayer sequence
  (left alone, the optimiser chooses and prints what it dropped)
  --no-augment weapon1                 no augments at all on that slot

Example
  bench optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1
`;

// --- a questlog.gg link, as pins -------------------------------------------
// The one place the bench reaches the network. A link is turned into the same
// --pin/--skills/--talent/--rune flags a person would have typed, and pushed
// in FRONT of the ones they did type - so anything named on the command line
// overrides what the link said rather than fighting it.
const QUESTLOG_LINK = /questlog\.gg|character-builder/i;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`questlog answered ${r.status} ${r.statusText}\n  ${url}`);
  return r.json();
}

async function applyQuestlog(args) {
  const flagged = typeof args.flags.questlog === 'string' ? args.flags.questlog : null;
  const positional = args._.slice(1);
  const link = flagged ?? positional.find((a) => QUESTLOG_LINK.test(a)) ?? null;
  // A second positional has never meant anything, so anything else there is a
  // mistake worth naming rather than ignoring.
  const stray = positional.filter((a) => a !== link);
  if (stray.length) {
    die(`unexpected argument "${stray[0]}"\n` +
      '  the only thing a second argument can be is a questlog.gg build link');
  }
  if (!link) return;

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

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.flags.help || args.flags.h) { console.log(USAGE); return; }
  if (args.flags.version || args.flags.V) { console.log(VERSION); return; }
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"\n\n${USAGE}`);
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
