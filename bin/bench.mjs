#!/usr/bin/env node
// ---------------------------------------------------------------------------
// bench - a gear bench for Farever.
//
//   bench optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1
//
// Reads the CastleDB out of your own copy of the game, computes what every
// item is worth for your class and level, and fills whatever you did not pin
// with the best legal combination it can find.
//
// Nothing here touches the game process, the network, or any file inside the
// install directory.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { createEngine, GOALS, FERVOR_SCOPES } from '../src/engine.mjs';
import { emptyLoadout, classOf } from '../src/loadout.mjs';
import { optimize, rankSlot } from '../src/optimize.mjs';
import * as f from '../src/format.mjs';

export const VERSION = '0.1.0';

// --- argument parsing ------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], flags: {}, repeated: {} };
  const REPEATABLE = new Set(['pin', 'no-augment', 'weight', 'skills']);
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

  return { pinnedGear, pinnedAug, pinnedSkills };
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
  if (!FERVOR_SCOPES.includes(assume.fervorScope ?? 'skills')) die(`--fervor-scope must be one of ${FERVOR_SCOPES.join(', ')}`);
  if (args.flags['no-mastery']) assume.mastery = false;

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
  return {
    engine, stars, rarities, goal, targetName, rank, mix, exclude, rarityCap, talentPoints,
    saved, fight, numFlag,
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
    const pins = applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved });
    const target = s.engine.combat.foe(s.targetName, s.level);
    const ev = s.engine.evaluate(loadout, { target, rank: s.rank, mix: s.mix });
    console.log(f.header(s.engine, VERSION) + '\n');
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
    const pins = applyPins(s.engine, loadout, args, { stars: s.stars, rarityRoll: s.rarityRoll, saved: s.saved });
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
    console.log(f.dim(`${res.evaluations} distinct loadouts evaluated in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `over ${restarts} restart${restarts === 1 ? '' : 's'} (best score from restart ` +
      `${res.trace.reduce((b, x) => (x.score > b.score ? x : b)).restart})`));
    console.log('');
    console.log(f.gearBlock(s.engine, res.loadout, {
      pinnedGear: pins.pinnedGear, indifferent: new Set(res.indifferent),
    }));
    if (res.indifferent.length) {
      console.log(f.dim(`  no effect: emptying ${res.indifferent.map(f.short).join(', ')} scores exactly the ` +
        `same for ${s.goal}.\n  The pick is the best of equals - a shield grants only armour, so a damage goal\n` +
        '  cannot tell one from another, or from none at all.'));
    }
    console.log('');
    console.log(f.bold('AUGMENTS'));
    console.log(f.augmentBlock(s.engine, res.loadout, { pinnedAug: pins.pinnedAug }) + '\n');
    if (res.talentAlloc) {
      console.log(f.bold('TALENTS'));
      console.log(f.talentBlock(s.engine, res.loadout, res.talentAlloc, res.talentCoverage) + '\n');
    }
    console.log(f.bold('SKILLS'));
    console.log(f.skillsBlock(s.engine, res.loadout, res.evaluation, { pinnedSkills: pins.pinnedSkills }) + '\n');
    console.log(f.runeBlock(s.engine, res.loadout, res.evaluation) + '\n');
    console.log(f.sheetBlock(s.engine, res.evaluation, { level: s.level }));
    console.log(f.throughputBlock(s.engine, res.evaluation, { goal: s.goal }) + '\n');

    // What the search bought over the seed, when the seed had anything in it.
    const seedScore = s.engine.makeScorer({ ...s, target, ref: res.reference }).scoreFrom(res.reference);
    if (seedScore > 0) {
      console.log(f.dim(`starting build scored ${f.num(seedScore, 2)}; this one scores ${f.num(res.score, 2)} ` +
        `(${f.signedPct(res.score / seedScore - 1)})`) + '\n');
    }
    console.log(f.auditBlock(s.engine));

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
      console.log(f.table(["  TIER", "BRANCH", "TALENT", "READS AS", "WHAT"],
        tree.nodes.map((n) => {
          const v = T.readableValue(n.skill);
          return ["  " + n.tier, n.branch, n.name,
            v.readable ? f.bold(v.kind) : f.dim("nothing"),
            v.affixes.length ? f.affixSummary(v.affixes)
              : v.buffs.length ? v.buffs.map((x) => x.name + " x" + x.stacks).join(", ")
              : v.effects.length ? v.effects.map((x) => x.kind).join(", ")
              : f.dim("no affix, no effect, no status")];
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

  audit(args) {
    const { engine } = commonSetup(args);
    console.log(f.header(engine, VERSION) + '\n');
    console.log(f.auditBlock(engine));
    console.log('\n' + f.dim('See docs/MODEL.md for where each formula came from.'));
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
  bench audit      every assumption and gap in the model

Common flags
  --class <name>          Warrior | Rogue | Mage | Priest
  --level <n>             default: the game's MaxLevel
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
  --talent-points <n>     talent points to spend  (default: the full allowance)
  --talent-points <n>     points to spend in the tree (default: the full 16)
  --rarity-cap <r>        highest rarity a roll may reach (default: derived
                          per slot - see )
  --no-rarity-roll        pin every item to the rarity the CDB authors it at
                          (by default rarity is treated as rolled at drop, so
                          Epic and Legendary versions are on the table)
  --exclude <regex>       drop matching item ids       (default ^GM_)
  --include-all           no id exclusions at all
  --fervor-scope <s>      skills | all | none   (default skills)
                          whether the unverified Fervor damage bonus applies to
                          base attacks too, or at all
  --no-mastery            drop the unverified mastery multipliers
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

Skill selection
  --skills weapon1=Skill1,Passive      slot two of the three a weapon offers
  --skills prayers=Smite,Life          choose the prayer sequence
  (left alone, the optimiser chooses and prints what it dropped)
  --no-augment weapon1                 no augments at all on that slot

Example
  bench optimize --class Priest --pin weapon1=Sword_Swarm --no-augment weapon1
`;

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.flags.help || args.flags.h) { console.log(USAGE); return; }
  if (args.flags.version || args.flags.V) { console.log(VERSION); return; }
  const fn = commands[cmd];
  if (!fn) die(`unknown command "${cmd}"\n\n${USAGE}`);
  try {
    fn(args);
  } catch (e) {
    die(`\n${e.message}\n` + (process.env.BENCH_DEBUG ? '\n' + e.stack : f.dim('\n(BENCH_DEBUG=1 for a stack trace)')));
  }
}

main(process.argv.slice(2));
