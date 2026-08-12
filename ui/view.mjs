// ---------------------------------------------------------------------------
// view.mjs - the serializers behind /api/sheet and the optimize result.
//
// Pure functions over an engine + an evaluation: api.mjs calls them on the
// request path and optimize-worker.mjs calls the same ones on the winner, so
// the sheet a user edits and the sheet the search returns cannot drift apart.
// Everything here reads engine state and writes plain JSON; nothing touches
// the network or the filesystem.
// ---------------------------------------------------------------------------

import { socketsOf, classOf } from '../src/loadout.mjs';
import { damageReduction } from '../src/model.mjs';

// The character-panel rows, in the game's own display order. `more` is the
// expandable "More Stats" list, `defence` closes the panel with Armor (plus
// its reduction sub-line), Maximum Health and Health Regen.
const PRIMARY = ['Vitality', 'Strength', 'Dexterity', 'Faith', 'Intellect'];
const MORE = ['CritChance', 'CritDamage', 'ArmorPenetration', 'SpellPenetration',
  'Fervor', 'BlockMitigation', 'DodgeChance', 'MagicMastery', 'PhysicalMastery'];

// Game-style integer formatting: thousands separated with a NARROW NO-BREAK
// SPACE, which is what the in-game sheet prints ("1 011").
const THIN = ' ';
export function gameInt(v) {
  const n = Math.round(v);
  const s = String(Math.abs(n));
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  return (n < 0 ? '-' : '') + grouped;
}

function display(attr, v) {
  if (attr?.isPercent) return v.toFixed(1) + '%';
  if (attr?.id === 'HealthRegen') return v.toFixed(1);
  return gameInt(v);
}

/**
 * Normalise a loadout the client sent before anything evaluates it: clamp the
 * stars, drop gear the catalog does not know, and prune choices whose host is
 * gone. The client mutates freely and re-sends; the server owns legality.
 * Mutates and returns the loadout. Throws on an unknown class.
 */
export function sanitizeLoadout(engine, loadout) {
  const { cat, plan, talents } = engine;
  for (const k of ['gear', 'augments', 'skills', 'runes', 'talents']) {
    if (!loadout[k] || typeof loadout[k] !== 'object') loadout[k] = {};
  }
  classOf(cat, loadout); // throws the sentence for an unknown class

  const rarityKnown = (r) => r == null || cat.rarityOrder.has(r);
  for (const [slotId, g] of Object.entries(loadout.gear)) {
    const item = g?.item ? cat.itemById.get(g.item) : null;
    if (!item) { delete loadout.gear[slotId]; continue; }
    if (!rarityKnown(g.rarity)) delete g.rarity;
    g.stars = Math.min(g.stars ?? 0, cat.maxStars(item, g.rarity ?? item.rarity));
  }

  // A socket exists only while its host item is equipped, and an augment must
  // be of the socket's own type - both re-derived from the gear just kept.
  const sockets = new Map(socketsOf(cat, loadout).map((s) => [s.key, s]));
  for (const [key, augId] of Object.entries(loadout.augments)) {
    const sock = sockets.get(key);
    const aug = augId ? cat.itemById.get(augId) : null;
    if (!sock || !aug || aug.augmentType !== sock.type) delete loadout.augments[key];
  }

  // Skill pools: drop stale ids, fill unset pools with the defaults.
  plan.pruneSelection(loadout);

  // Runes: only skills this build knows offer a slot, and only that skill's
  // own three fit it.
  const pools = new Map(talents.runePools(loadout).map((p) => [p.skill, p]));
  for (const [skillId, runeId] of Object.entries(loadout.runes)) {
    const p = pools.get(skillId);
    if (!p || !p.options.some((o) => o.id === runeId)) delete loadout.runes[skillId];
  }

  // Talents: nothing outside this class's tree.
  const tree = talents.treeFor(loadout.class);
  for (const id of Object.keys(loadout.talents)) {
    if (!tree.byId.has(id)) delete loadout.talents[id];
  }
  return loadout;
}

/** The tier-4 nodes this build's sigils grant - recomputed from the augments,
 *  which is the durable record (optimize also writes them into talents). */
export function grantedNodes(engine, loadout) {
  const tree = engine.talents.treeFor(loadout.class);
  const granted = new Set();
  for (const [key, augId] of Object.entries(loadout.augments ?? {})) {
    if (!key.endsWith('/AugmentDemonSigil') || !augId) continue;
    for (const sk of engine.cat.itemById.get(augId)?.skills ?? []) {
      if (tree.byId.has(sk)) granted.add(sk);
    }
  }
  return granted;
}

// A damage row's icon: the row id is a skill row for casts and a STATUS row
// for dots - status rows are skill rows too and reuse the parent tile, so the
// id itself resolves most of the time. When it does not, the applier does.
function lineIcon(engine, icons, line) {
  const skills = engine.cdb.byId('skill');
  const own = skills.get(line.id)?.gfx;
  if (own?.file) return icons.iconRef(own);
  const from = String(line.from ?? line.source ?? '').split('+')[0];
  const fb = skills.get(from)?.gfx;
  return fb?.file ? icons.iconRef(fb) : null;
}

function skillRef(engine, icons, id) {
  const s = engine.cdb.byId('skill').get(id);
  return { id, name: s?.texts?.name ?? id, icon: s?.gfx?.file ? icons.iconRef(s.gfx) : null };
}

/** The /api/sheet response body for a legal, evaluated loadout. */
export function buildView({ engine, icons, loadout, ev, options = {} }) {
  const { ctx, talents, plan } = engine;
  const attrs = ctx.attrTable.byId;
  const name = (id) => engine.cdb.byId('attribute').get(id)?.name ?? id;

  // --- attribute rows -------------------------------------------------------
  const rows = [];
  const push = (id, group, extra = {}) => {
    const a = attrs.get(id);
    const v = ev.sheet.get(id) ?? 0;
    rows.push({ id, name: name(id), value: v, display: display(a, v), group, ...extra });
  };
  for (const id of PRIMARY) push(id, 'primary');
  for (const id of MORE) push(id, 'more');
  {
    const armor = ev.sheet.get('Armor') ?? 0;
    const red = damageReduction({
      resist: armor, attackerLevel: loadout.level, formula: ctx.consts.resistFormula,
    });
    push('Armor', 'defence', { sub: `(-${(red * 100).toFixed(1)}%)` });
    push('MaxHealth', 'defence');
    push('HealthRegen', 'defence');
  }

  // --- rating notes: what each rating is buying, keyed by the consumer ------
  // pp = rating / budget(L, 150, 1000, 50) * target; the `scale` column is
  // dead data (API.md pitfall 5).
  const ratingNotes = {};
  for (const a of ctx.attrTable.attrs) {
    const s = a.scaling.find((x) => x.op.case === 'Rating');
    if (!s) continue;
    const v = ev.sheet.get(s.from) ?? 0;
    if (!v) continue;
    const { min, max, target } = s.op.args;
    const step = min * Math.pow(Math.pow(max / min, 1 / (ctx.consts.earlyMaxLevel - 1)), loadout.level - 1);
    ratingNotes[a.id] = `${gameInt(v)} ${name(s.from)} → +${((v / step) * target).toFixed(1)}pp `
      + `(+${(target / step).toFixed(4)}pp per point)`;
  }

  // --- sockets / pools / rune pools ----------------------------------------
  const sockets = socketsOf(engine.cat, loadout).map((s) => ({
    ...s, current: loadout.augments?.[s.key] ?? null,
  }));

  const pools = plan.pools(loadout).map((p) => {
    const chosen = loadout.skills?.[p.key] ?? p.options.slice(0, p.slots);
    return {
      key: p.key, label: p.label, slots: p.slots, kind: p.kind,
      // Whether one option may hold more than one slot. A Mage slots the same
      // conduit twice; a Priest gets one of each prayer. `count` says how many
      // slots each option currently holds, which `chosen` alone cannot.
      repeats: p.repeats === true,
      options: p.options.map((id) => ({
        ...skillRef(engine, icons, id),
        chosen: chosen.includes(id),
        count: chosen.filter((x) => x === id).length,
        // BEING in `options` is what costs a slot, whatever the skill's type.
        // The arsenal offers its weapon's passive as a third pick and taking it
        // spends one of the two slots; the main hand's passive is free and is
        // therefore not an option at all - it arrives in `alsoGranted`. So this
        // flag is for the badge only: it says "this pick is a passive", never
        // "this pick is free". Reading it as free lit the arsenal passive up as
        // permanently active and took its click handler away, so it could be
        // neither taken nor dropped.
        passive: engine.cdb.enumName('skill', 'type',
          engine.cdb.byId('skill').get(id)?.type) === 'WeaponPassive',
      })),
      alsoGranted: (p.alsoGranted ?? []).map((id) => skillRef(engine, icons, id)),
    };
  });

  const runePools = talents.runePools(loadout).map((p) => ({
    skill: p.skill,
    name: p.name,
    icon: skillRef(engine, icons, p.skill).icon,
    slots: p.slots,
    current: loadout.runes?.[p.skill] ?? null,
    options: p.options.map((o) => o.id),
  }));

  // --- talents --------------------------------------------------------------
  const granted = grantedNodes(engine, loadout);
  const budget = talents.pointsAt(loadout.level);
  let spent = 0;
  for (const [id, rank] of Object.entries(loadout.talents ?? {})) {
    if (!granted.has(id)) spent += rank;
  }
  const talentState = {
    spent, budget,
    granted: [...granted],
    illegal: talents.illegalAllocation(loadout.class, loadout.talents ?? {}, {
      level: loadout.level, points: budget, granted,
    }),
  };

  // --- damage rows ----------------------------------------------------------
  // `line.share` is cast-time occupancy, NOT damage share (pitfall 2); the
  // share here is damage over the summed damage. Heal-carrying rows ride
  // along for the Priest goals, marked by their heal fields.
  const fight = ev.throughput.fight || 1;
  const kept = ev.throughput.lines
    .filter((l) => (l.total.damage + l.total.heal + l.total.shield) > 0)
    .sort((a, b) => b.total.damage - a.total.damage);
  const totalDamage = kept.reduce((s, l) => s + l.total.damage, 0);
  const damageRows = kept.map((l) => ({
    id: l.id,
    name: l.name,
    icon: lineIcon(engine, icons, l),
    kind: l.kind,
    dps: l.total.damage / fight,
    damage: l.total.damage,
    share: totalDamage > 0 ? l.total.damage / totalDamage : 0,
    hits: l.hits,
    ...(l.total.heal > 0 ? { heal: l.total.heal, hps: l.total.heal / fight } : {}),
    ...(l.total.shield > 0 ? { shield: l.total.shield } : {}),
  }));

  return {
    illegal: null,
    attributes: rows,
    ratingNotes,
    weaponPower: ev.weaponPower,
    survivability: {
      maxHealth: ev.survivability.maxHealth,
      physReduction: ev.survivability.physReduction,
      ehp: ev.survivability.ehp,
    },
    sockets,
    pools,
    runePools,
    talentState,
    dps: ev.throughput.dps,
    hps: ev.throughput.hps,
    damage: { total: totalDamage, dps: ev.throughput.dps, rows: damageRows },
    unmodelled: (ev.throughput.unmodelled ?? []).map((u) => ({
      id: u.id, name: u.name ?? u.id, kind: u.kind ?? null, why: u.why,
    })),
  };
}

/**
 * The `optimize --json` envelope, field for field what bin/bench.mjs writes -
 * it has to, because the promise is that saving it and running
 * `bench sheet --build <file>` reproduces the same sheet.
 */
export function buildEnvelope({ engine, loadout, options = {}, metrics, ev, pinned }) {
  return {
    version: options.version ?? '0.1.0',
    cdbSha: engine.meta.cdbSha,
    bootSha: engine.meta.bootSha,
    goal: options.goal ?? 'dps',
    weights: options.weights ?? null,
    target: options.target ?? 'boss',
    targetLabel: ev.target.name,
    fervorScope: engine.opts.assume.fervorScope,
    stars: options.stars ?? 'max',
    rank: options.rank ?? 3,
    level: loadout.level,
    mix: options.mix ?? 0.5,
    rarityRoll: options.rarityRoll ?? true,
    fight: engine.opts.fight,
    fights: engine.opts.fights,
    targets: engine.opts.targets,
    // OPTIONS FIRST, unlike the three above it. Those are construction-time and
    // the engine is the only place they exist; this one is per-evaluation, so
    // the engine holds only the default and a caller that overrode it would
    // otherwise record a health its numbers were not computed at. The worker
    // sets both to the same value and the sheet route sets only the option.
    targetHealth: options.targetHealth ?? engine.opts.targetHealth,
    lookahead: engine.opts.lookahead,
    pinned: {
      gear: pinned?.gear ?? [],
      augments: pinned?.augments ?? [],
      skills: pinned?.skills ?? [],
    },
    build: loadout,
    metrics,
    sheet: Object.fromEntries(ev.sheet),
    unmodelled: ev.throughput.unmodelled,
    assumptions: engine.audit,
  };
}
