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
function applyPins(engine, loadout, args, { stars }) {
  const { cat } = engine;
  const slotIds = cat.combatSlots().map((s) => s.id);
  const augTypeIds = cat.augmentTypes.map((a) => a.id);
  const pinnedGear = new Set();
  const pinnedAug = new Set();
  const augPins = [];

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

    // item [ ^instanceLevel ] [ @rarity ] [ *stars ]
    const m = /^([^@*^]+)(?:\^(\d+))?(?:@([^*^]+))?(?:\*(\d+))?$/.exec(rhs);
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

    const rarity = m[3]
      ? resolve(m[3], cat.cdb.lines('rarity').map((r) => r.id), 'rarity')
      : item.rarity;

    const cap = cat.maxStars(item, rarity);
    const want = m[4] != null ? Number(m[4]) : (stars === 'max' ? cap : Math.min(stars, cap));
    const capped = Math.min(want, cap);
    if (m[4] != null && capped < want) {
      console.error(f.warn(`note: ${itemId} is ${rarity} and caps at ${capped} upgrade stars, not ${want}`));
    }
    loadout.gear[slot] = { item: itemId, rarity, stars: capped, level: instanceLevel };
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
    loadout.augments[p.key] = resolve(p.value, choices, `augment for ${type}`);
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

function commonSetup(args) {
  const assume = {};
  if (typeof args.flags[`fervor-scope`] === 'string') assume.fervorScope = args.flags[`fervor-scope`];
  if (args.flags['no-fervor-damage']) assume.fervorScope = 'none';
  if (!FERVOR_SCOPES.includes(assume.fervorScope ?? 'skills')) die(`--fervor-scope must be one of ${FERVOR_SCOPES.join(', ')}`);
  if (args.flags['no-mastery']) assume.mastery = false;
  const engine = createEngine({
    game: typeof args.flags.game === 'string' ? args.flags.game : undefined,
    assume,
  });
  const level = args.flags.level ? Number(args.flags.level) : engine.ctx.consts.maxLevel;
  if (!Number.isFinite(level) || level < 1) die('--level needs a positive number');
  if (level > engine.ctx.consts.maxLevel) {
    console.error(f.warn(`note: --level ${level} is above this build's MaxLevel of ${engine.ctx.consts.maxLevel}; curves extrapolate`));
  }
  const starsFlag = args.flags.stars ?? 'max';
  const stars = starsFlag === 'max' ? 'max' : Number(starsFlag);
  if (stars !== 'max' && !Number.isFinite(stars)) die("--stars needs a number or 'max'");
  const rarities = typeof args.flags.rarity === 'string'
    ? new Set(args.flags.rarity.split(',').map((r) => resolve(r, engine.cdb.lines('rarity').map((x) => x.id), 'rarity')))
    : null;
  const goal = String(args.flags.goal ?? 'dps');
  if (!GOALS.includes(goal)) die(`--goal must be one of ${GOALS.join(', ')}`);
  const targetName = String(args.flags.target ?? 'reference');
  const rank = args.flags.rank ? Number(args.flags.rank) : engine.ctx.consts.weaponSkillMaxRank;
  const mix = args.flags.mix != null ? Number(args.flags.mix) : 0.5;
  const exPattern = args.flags['include-all'] ? null
    : (typeof args.flags.exclude === 'string' ? args.flags.exclude : DEFAULT_EXCLUDE);
  let exclude = null;
  if (exPattern) {
    try { exclude = new RegExp(exPattern); } catch (e) { die(`--exclude is not a valid regex: ${e.message}`); }
  }
  const rarityCap = typeof args.flags[`rarity-cap`] === 'string'
    ? resolve(args.flags[`rarity-cap`], engine.cat.cdb.lines('rarity').map((r) => r.id), 'rarity')
    : null;
  return {
    engine, level, stars, rarities, goal, targetName, rank, mix, exclude, rarityCap,
    // On by default: rarity is rolled at drop, so a Rare-authored chest that can
    // land Epic or Legendary should be on the table. --no-rarity-roll pins every
    // item to the rarity the CDB authors it at.
    rarityRoll: !args.flags['no-rarity-roll'],
    weights: parseWeights(args),
  };
}

function loadBuild(args, engine, level) {
  if (typeof args.flags.build === 'string') {
    const raw = JSON.parse(readFileSync(args.flags.build, 'utf8'));
    if (!raw.class) die(`${args.flags.build}: no "class" in the build file`);
    return { level, ...raw, gear: { ...(raw.gear ?? {}) }, augments: { ...(raw.augments ?? {}) } };
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
    const loadout = loadBuild(args, s.engine, s.level);
    const cls = classOf(s.engine.cat, loadout);
    const slotIds = s.engine.cat.combatSlots().map((x) => x.id);
    if (typeof args.flags.slot !== 'string') die(`--slot is required. One of: ${slotIds.map(f.short).join(', ')}`);
    const slot = resolve(args.flags.slot, slotIds, 'slot');
    const list = s.engine.cat.candidates(slot, {
      aptitude: cls.aptitude, charLevel: s.level,
      rarities: s.rarities, exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap,
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
        c.item.faction ?? f.dim('-'),
        f.ratingGiven(s.engine.cat, c.item, cls.aptitude, c.rarity) ?? f.dim('-'),
        c.item.skills.length ? f.warn(String(c.item.skills.length)) : '',
      ]), { align: [null, null, null, 'r', 'r', 'r'] }));
  },

  sheet(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level);
    const pins = applyPins(s.engine, loadout, args, { stars: s.stars });
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
    const loadout = loadBuild(args, s.engine, s.level);
    applyPins(s.engine, loadout, args, { stars: s.stars });
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
        r.item.faction ?? f.dim('-'),
        f.ratingGiven(s.engine.cat, r.item, apt, r.rarity) ?? f.dim('-'),
        f.num(r.score, 1),
        r.delta == null ? f.dim('-') : f.signedPct(r.delta),
      ]), { align: [null, null, null, 'r', null, null, null, 'r', 'r'] }));
    if (rows.length > limit) console.log(f.dim(`\n... ${rows.length - limit} more (--all to see them)`));
    console.log('\n' + f.auditBlock(s.engine));
  },

  optimize(args) {
    const s = commonSetup(args);
    const loadout = loadBuild(args, s.engine, s.level);
    const pins = applyPins(s.engine, loadout, args, { stars: s.stars });
    const target = s.engine.combat.foe(s.targetName, s.level);
    const restarts = args.flags.restarts ? Number(args.flags.restarts) : 3;

    const t0 = Date.now();
    const res = optimize(s.engine, {
      loadout, ...pins, goal: s.goal, weights: s.weights, target,
      rank: s.rank, mix: s.mix, rarities: s.rarities, stars: s.stars,
      exclude: s.exclude, rarityRoll: s.rarityRoll, rarityCap: s.rarityCap, pinnedSkills: pins.pinnedSkills,
      allowEmpty: !args.flags['no-empty'], restarts,
      onProgress: process.stderr.isTTY ? (n) => process.stderr.write(`\r  ${n} evaluations...`) : null,
    });
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(30) + '\r');

    console.log(f.header(s.engine, VERSION) + '\n');
    const goalLabel = s.weights
      ? Object.entries(s.weights).map(([k, v]) => `${k}x${v}`).join(' + ')
      : s.goal;
    console.log(`${f.bold(loadout.class + ' ' + s.level)} - maximising ${f.bold(goalLabel)} vs ${target.name}`);
    console.log(f.dim(`upgrade stars: ${s.stars === 'max' ? 'max for rarity' : s.stars}   weapon-skill rank: ${s.rank}   ` +
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
    console.log(f.gearBlock(s.engine, res.loadout, { pinnedGear: pins.pinnedGear }) + '\n');
    console.log(f.bold('AUGMENTS'));
    console.log(f.augmentBlock(s.engine, res.loadout, { pinnedAug: pins.pinnedAug }) + '\n');
    console.log(f.bold('SKILLS'));
    console.log(f.skillsBlock(s.engine, res.loadout, res.evaluation, { pinnedSkills: pins.pinnedSkills }) + '\n');
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
        goal: s.goal, weights: s.weights, target: target.name, fervorScope: s.engine.opts.assume.fervorScope,
        stars: s.stars, rank: s.rank,
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
  bench audit      every assumption and gap in the model

Common flags
  --class <name>          Warrior | Rogue | Mage | Priest
  --level <n>             default: the game's MaxLevel
  --goal <g>              dps | hps | sps | ehp | mixed (default dps)
  --weight <g>=<n>        blend goals, e.g. --weight dps=1 --weight ehp=0.25
  --target <t>            dummy | reference | armoured  (default reference)
  --stars <n|max>         upgrade stars to assume       (default max)
  --rarity <list>         restrict to e.g. Rare,Epic
  --rank <n>              weapon-skill rank 1-3        (default max)
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
  --build <file.json>     start from a saved build
  --json <file.json>      write the result as JSON
  --game <path>           the Farever install, if it cannot be found

Pinning
  --pin chest=Chest_RManfish_Cle       fix an item
  --pin weapon1=Sword_Swarm*3          fix an item at 3 upgrade stars
  --pin trinket=none                   force a slot empty
  --pin feet/enchantfeet=none          force one socket empty
  --pin chest=Chest_RManfish_Cle@Epic  assume a particular drop rarity
  --pin weapon1=Spear_Eruption^10*0    an instance that dropped at level 10, 0 stars

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
