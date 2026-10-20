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
 * A star count as the game holds one: a whole number of upgrades between zero
 * and what the item's rarity allows. `Math.min` alone let a negative count
 * through, and the bake subtracted item levels for it.
 */
export function clampStars(stars, maxStars) {
  const n = Math.floor(Number(stars ?? 0));
  return Number.isFinite(n) ? Math.max(0, Math.min(n, maxStars)) : 0;
}

/**
 * The ratings an infusion bonus line can be - the `endAtb` of the rows of the
 * aptitude the game prices the line from, whose id is the game's own literal
 * ($HInfusion.getInfusionBonusAptitude@21690 loads "InfusionBonus").
 *
 * The list is closed from both ends of the game's code. What a piece can ROLL
 * is drawn from it: ent.$UnitAttributes.initAttributeSystems@15442 ops 82-114
 * fill `infusionBonusAttributes` with one entry per row of that aptitude
 * (`sourceAtb ?? endAtb`; no row authors a `sourceAtb` on build 25782799), and
 * $HInfusion.pickInfusionBonusStat@21694 picks from a copy of it. What a piece
 * is PAID is read from it: st.item.Gear.getInfusionBonusAffix@9767 ops 11-29
 * keep only the rows whose `endAtb` IS the rolled stat, and
 * $HItem.computeAtbScaling@21737 ops 4-9 return 0 for an empty list. So a
 * stat no row names can neither be rolled nor be worth anything. [] on a
 * build of the game with no Infusion system.
 */
export function infusionRatings(cdb) {
  return [...new Set((cdb.byId('aptitude').get('InfusionBonus')?.atbScaling ?? []).map((e) => e.endAtb))];
}

/**
 * Normalise a loadout the client sent before anything evaluates it: clamp the
 * stars, drop gear the catalog does not know and a rarity its item cannot be,
 * bring a piece's infusion fields to one shape, and prune choices whose host
 * is gone. The client mutates freely and
 * re-sends; the server owns legality. Mutates and returns the loadout. Throws
 * the sentence for an unknown class, for a level that is not a level - a
 * missing one used to come back as a 200 whose every attribute read NaN - and
 * for an infusion field that states nothing the game could hold.
 */
export function sanitizeLoadout(engine, loadout) {
  const { cat, plan, talents } = engine;
  const bonusRatings = infusionRatings(engine.cdb);
  // A loadout is an object; a string here failed on the first write below
  // with the runtime's sentence about a property, not one about the request.
  if (!loadout || typeof loadout !== 'object') {
    throw new Error(`a loadout must be an object, not ${JSON.stringify(loadout)}`);
  }
  for (const k of ['gear', 'augments', 'skills', 'runes', 'talents']) {
    if (!loadout[k] || typeof loadout[k] !== 'object') loadout[k] = {};
  }
  classOf(cat, loadout); // throws the sentence for an unknown class
  if (!Number.isInteger(loadout.level) || loadout.level < 1) {
    throw new Error('loadout.level must be a positive integer, not '
      + `${JSON.stringify(loadout.level) ?? 'missing'}`);
  }

  const rarityKnown = (r) => r == null || cat.rarityOrder.has(r);
  for (const [slotId, g] of Object.entries(loadout.gear)) {
    const item = g?.item ? cat.itemById.get(g.item) : null;
    if (!item) { delete loadout.gear[slotId]; continue; }
    if (!rarityKnown(g.rarity)) delete g.rarity;
    // ONLY A WEAPON'S RARITY IS THE INSTANCE'S TO STATE. The drop rolls one
    // for a Weapon and for nothing else (ent.Hero.makeLootItem@7953 ops
    // 126-129 skip the roll unless the type chain reaches "Weapon"; the one
    // write is Weapon.set_rarity@9846), so armour, jewellery and trinkets are
    // the rarity on their row and a different one names an item that cannot
    // exist. A saved build or a hand-written request can still carry one, and
    // priced as sent it was worth +50 iLevel on any green once the Epic tier
    // landed - so it is dropped here, which is also what stops the optimizer
    // carrying a pinned "Epic" green through its whole search.
    if (g.rarity != null && g.rarity !== item.rarity && !cat.isWeaponType(item.type)) {
      delete g.rarity;
    }
    g.stars = clampStars(g.stars, cat.maxStars(item, g.rarity ?? item.rarity));
    // The level a piece dropped at is a number or absent; anything else bakes
    // to a NaN item level and an empty stat block.
    if (g.level != null && !(Number.isFinite(g.level) && g.level >= 1)) {
      throw new Error(`gear.${slotId}.level must be a level (1 or more), not `
        + `${JSON.stringify(g.level)}`);
    }
    // THE INFUSION A PIECE CARRIES is three fields of the instance
    // (loadout.mjs has the spelling): which set passive, which rating its
    // bonus line rolled, and whether the piece is Prismatic. They are brought
    // to ONE shape here - an id or absent, `true` or absent, and the game's own
    // field name `infusionBonusStat` folded into `infusionStat` as the dump
    // importers fold it - and nothing more. Whether the piece may CARRY the
    // infusion is not repaired the way a foreign rarity is: an infusion on a
    // necklace is not a stale field to drop, it is a build the game refuses,
    // and the caller is told so with the catalog's own sentence
    // (`infusionIllegalReason`, which every route that evaluates consults).
    //
    // NOT STATED is null, absent or the empty string, and only that is
    // dropped. Anything else that is not an id - `infusion: 5`, a list - is
    // refused: dropped in silence it came back as the sheet of the same build
    // NOT infused, a 200 for a build nobody sent, while /api/tooltip/item
    // refused the same value. `prismatic` is a flag and is held to the same
    // rule, because coerced it lit a bonus line for the string "false".
    const unsaid = (v) => v == null || v === '';
    // The spelling the roll arrived under, so a refusal names the field sent.
    const statKey = unsaid(g.infusionStat) && !unsaid(g.infusionBonusStat) ? 'infusionBonusStat' : 'infusionStat';
    const sent = { infusion: g.infusion, infusionStat: g[statKey] };
    delete g.infusionBonusStat;
    for (const [k, as] of [['infusion', 'infusion'], ['infusionStat', statKey]]) {
      if (unsaid(sent[k])) { delete g[k]; continue; }
      if (typeof sent[k] !== 'string') {
        throw new Error(`gear.${slotId}.${as} must be an id, not ${JSON.stringify(sent[k])}`);
      }
      g[k] = sent[k];
    }
    if (g.prismatic != null && typeof g.prismatic !== 'boolean') {
      throw new Error(`gear.${slotId}.prismatic must be true or false, not ${JSON.stringify(g.prismatic)}`);
    }
    if (g.prismatic) g.prismatic = true; else delete g.prismatic;
    // A ROLL THAT IS NOT A BONUS RATING is refused too, and for the same
    // reason an `options.infusionStat` that is not one is. The engine prices
    // it without complaint - at 0, since no InfusionBonus row names it
    // (`infusionRatings` above has the reads) - and then reports the line as
    // lit and "priced as stored ... not in the pool this bench computes", the
    // sentence it keeps for a REAL rating the piece was not expected to roll.
    // For `CritChance` (the attribute a rating buys, not the rating), for
    // `Strength` or for a typo that sentence is false: nothing was priced and
    // no pool is in question. A real rating outside the piece's own pool is
    // still let through - a looted piece carries whatever the server rolled.
    if (g.infusionStat && !bonusRatings.includes(g.infusionStat)) {
      throw new Error(`gear.${slotId}.${statKey} ${JSON.stringify(g.infusionStat)} is not an infusion bonus rating - `
        + `the bonus line is one of ${bonusRatings.join(', ') || 'none on this build'} (the rows of the InfusionBonus `
        + 'aptitude), and the game pays nothing for any other');
    }
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

/**
 * The name a faction is shown under. The row id is not it: `Bee` is "Apix",
 * `Demon` is "Nightlings", and an infusion's own id says `Nightling` where
 * its pattern's faction is `Demon`. `$HText.faction@21938` case Name is
 * `texts.name` (ops 13-17) with no fallback; three rows author none (Starter,
 * World, Craft) and those read as their id here rather than as nothing.
 */
export function factionName(cdb, id) {
  if (id == null) return null;
  return cdb.byId('faction').get(id)?.texts?.name || id;
}

/**
 * WHAT THE CANDIDATE LISTS LEAVE OUT, AND ON WHAT EVIDENCE.
 *
 * `cat.candidates` - which the picker's catalog and the search both list from
 * - withholds two kinds of row a character of this class and level could
 * otherwise be handed, and a filter nobody can see is a filter nobody can
 * check. So the same two tests are asked here, by the catalog's own readers,
 * and each row comes back with the reader's own sentence:
 *
 *   unreleased  `cat.release(item).state` - nothing in this install hands the
 *               row out (sources.mjs searched the cdb, every level file and
 *               the compiled code for a source and found none that is open);
 *   level       `cat.minInstanceLevel(item)` is above the character - every
 *               open source of the row makes it at that level, so no copy the
 *               character could wear exists (catalog.mjs has the reads: a
 *               Heroic boss table makes its loot at the level cap, and so do
 *               the two gear caches).
 *
 * NOT listed: a row the character is simply too low for (`item.minLevel`,
 * the equip gate every list has always applied) - that is not withholding, it
 * is the level requirement printed on the item.
 *
 * The two are asked in `cat.candidates`' own order, so a row has one reason.
 *
 * @returns Map(slotId -> [{ item, kind: 'unreleased'|'level', floor, why }])
 */
export function withheldItems(engine, { aptitude, level }) {
  const { cat } = engine;
  const out = new Map();
  for (const slot of cat.combatSlots()) {
    const rows = [];
    for (const item of cat.items) {
      if (item.isAugment || !item.slots.includes(slot.id)) continue;
      if (!cat.usableBy(item, aptitude)) continue;
      if (item.minLevel != null && item.minLevel > level) continue;
      const held = withheldReason(cat, item, level);
      if (held) rows.push({ item, ...held });
    }
    if (rows.length) out.set(slot.id, rows);
  }
  return out;
}

/** Why one row is withheld from a character of this level, or null when it is not. */
export function withheldReason(cat, item, level) {
  const floor = cat.minInstanceLevel(item);
  const rel = cat.release(item);
  if (floor != null && floor > level) {
    return {
      kind: 'level', floor,
      why: `a copy of it only exists at level ${floor} - every source of it makes it there (${rel.why})`,
    };
  }
  if (rel.state === 'unreleased') {
    return { kind: 'unreleased', floor: null, why: `nothing in this install hands it out - ${rel.why}` };
  }
  return null;
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

/**
 * The infusion half of a sheet: the sets the build wears, what of each is in
 * the number and what is not, and each infused piece's bonus line.
 *
 * Nothing is decided here. The sets, their rank, what was priced and every
 * refusal are the ENGINE's (`ev.infusions`, infusion.mjs `attach`), passed on
 * with the names a page prints; a later model change that prices one more
 * effect moves a string from `unpriced` to `priced` and this code does not
 * move. `null` on a build of the game with no infusion system.
 *
 * @param gameText  ui/api.mjs's two printers. `affixLine` prints an affix
 *                  through the game's own template: the bonus line is a
 *                  `TAttribute_Flat` affix (st.item.Gear.getInfusionBonusAffix@9767
 *                  op 51 names that row) and is printed as one rather than
 *                  composed here. `fillLinks` names the [links] the engine's
 *                  sentences carry over from the rows they quote - a status
 *                  whose row is named "Gift of [CritChance]" reads "Gift of
 *                  Critical Chance", the name that link resolves to. Without
 *                  the pair the lines come back unprinted (`display: null`)
 *                  and unlinked.
 */
function infusionView({ engine, icons, loadout, ev, gameText = null }) {
  const { cat, cdb } = engine;
  if (!cat.infusions.size) return null;
  const inf = ev.infusions ?? { sets: [], pieces: [] };
  const attr = (id) => cdb.byId('attribute').get(id)?.name || id;
  const linked = (s) => (gameText?.fillLinks ? gameText.fillLinks(cdb, s) : s);
  // A set's title is the game's own text row filled with the cap its rank
  // stands at - `Texts.infusion_rank({rank})`, "(4) Set"
  // (ui.win.InfusionSkillDesc.getRankTitle@15961) - the engine's string when
  // the row is gone.
  const rankText = cdb.byId('text').get('infusion_rank')?.value?.text;
  const titleOf = (s) => (s.rank >= 1 && typeof rankText === 'string' && cat.infusionCaps[s.rank - 1] != null
    ? rankText.replace('::rank::', String(cat.infusionCaps[s.rank - 1])) : (s.title ?? null));
  // WHAT IS SCORED, in the game's words. The engine lists the set's
  // rank-gated stat rows first, each as "<amount> <attribute id>", and then
  // anything else it priced. The rows themselves ride along (`affixes`), so
  // each is printed here by the affix template instead - "+4% Fervor", where
  // the id form reads "+4 Fervor" and names Critical Chance `CritChance`.
  // That the first entries ARE those rows is checked, not assumed: if the
  // engine's list ever stops lining up with them it is passed on untouched.
  const scoredOf = (s) => {
    const rows = s.affixes ?? [];
    const said = s.priced ?? [];
    const aligned = !!gameText?.affixLine && said.length >= rows.length
      && rows.every((a, i) => typeof said[i] === 'string' && said[i].endsWith(` ${a.target?.attribute}`));
    return aligned
      ? [...rows.map((a, i) => gameText.affixLine(cdb, a) ?? linked(said[i])), ...said.slice(rows.length).map(linked)]
      : said.map(linked);
  };
  const infusable = cat.combatSlots().filter((s) => {
    const g = loadout.gear?.[s.id];
    return g?.item && cat.canInfuse(cat.itemById.get(g.item));
  }).map((s) => s.id);
  return {
    caps: cat.infusionCaps,
    // The slots whose worn piece the game would let carry an infusion.
    infusable,
    sets: inf.sets.map((s) => ({
      ...skillRef(engine, icons, s.id),
      faction: s.faction ?? null,
      factionName: factionName(cdb, s.faction),
      pieces: s.pieces,
      slots: s.slots,
      // The SET's rank - how many of `caps` the piece count reaches - and the
      // game's title for it ("(4) Set"); null below the first cap, where
      // `nextCap` says how many pieces the first bonus takes.
      rank: s.rank,
      title: titleOf(s),
      nextCap: s.nextCap ?? null,
      attached: !!s.attached,
      // What of the set is IN the number, and each thing that is not, by name.
      priced: scoredOf(s),
      unpriced: (s.unpriced ?? []).map(linked),
      why: s.why ?? null,
      note: s.note ?? null,
      // Whether anything hands its pattern out, and the reader's sentence.
      source: s.source ? { state: s.source.state, why: s.source.why } : null,
    })),
    pieces: inf.pieces.map((p) => {
      const item = cat.itemById.get(p.item);
      const origin = item ? cat.factionOrigin(item) : null;
      return {
        slot: p.slot,
        item: p.item,
        itemName: item?.name ?? p.item,
        faction: origin,
        factionName: factionName(cdb, origin),
        infusion: p.infusion,
        infusionName: p.infusion ? (cat.infusions.get(p.infusion)?.name ?? p.infusion) : null,
        stat: p.stat,
        statName: p.stat ? attr(p.stat) : null,
        // `value` is what the sheet was paid (0 while the line is dark),
        // `wouldBe` what the stated roll is worth lit, `ceiling` the best a
        // roll nobody stated could be worth on a piece that would be paid it.
        value: p.value,
        wouldBe: p.wouldBe,
        ceiling: p.ceiling,
        lit: !!p.lit,
        prismatic: !!p.prismatic,
        display: p.stat && gameText?.affixLine
          ? gameText.affixLine(cdb, { ref: 'TAttribute_Flat', val: p.wouldBe, target: { attribute: p.stat } })
          : null,
        pool: (p.pool ?? []).map((id) => ({ stat: id, name: attr(id) })),
        note: p.note ?? null,
      };
    }),
  };
}

/** The /api/sheet response body for a legal, evaluated loadout. */
export function buildView({ engine, icons, loadout, ev, options = {}, gameText = null }) {
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

  // --- what the number leaves out, in the words the rest of the sheet uses ----
  // The engine's sentences quote the rows they are about, [links] and all: a
  // status whose row is named "Gift of [CritChance]", a quoted description
  // that says "one of your [WeaponSkill]s". Printed raw, that is markup on a
  // page ("Weapon Skills" is what the link and its plural print) - and for
  // an infusion set it was the SAME gap in two spellings, because the
  // `infusions` block above prints these very strings linked ("Gift of
  // Critical Chance") and its stat rows through the affix template ("+4%
  // Fervor") while the set's row down here still said "Gift of [CritChance]"
  // and "Scored: +4 Fervor". So every name and sentence goes through the same
  // link printer the block uses, and a set's row has its scored list replaced
  // by the block's own. The replacement is looked for, not assumed: it is
  // made only where the sentence carries the engine's list word for word
  // after "Scored: " (infusion.mjs `attach`), and a sentence of any other
  // shape is passed on linked and otherwise untouched. The engine joins that
  // list with "; " - an entry can be a whole clause with commas of its own
  // since a set's fight parts are scored ("Wet on the foe: +2% ... a stack,
  // up to 3, one stack on ...") - and so does the row.
  const infusions = infusionView({ engine, icons, loadout, ev, gameText });
  const linked = (s) => (typeof s === 'string' && gameText?.fillLinks ? gameText.fillLinks(engine.cdb, s) : s);
  const whyOf = (u) => {
    let why = u.why;
    if (u.source === 'infusion' && typeof why === 'string') {
      const said = (ev.infusions?.sets ?? []).find((s) => s.id === u.id)?.priced ?? [];
      const shown = infusions?.sets.find((s) => s.id === u.id)?.priced ?? [];
      const quoted = `Scored: ${said.join('; ')}.`;
      if (said.length && shown.length === said.length && why.split(quoted).length === 2) {
        why = why.replace(quoted, () => `Scored: ${shown.join('; ')}.`);
      }
    }
    return linked(why);
  };

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
    infusions,
    // `source` is the engine's own tag for where a line came from, passed on
    // as it is and NOT a closed list: a gear slot (`Slot_Weapon1`), a skill
    // pool's key, a socket's key (`Slot_Head/AugmentDemonSigil`), `class`,
    // `talent`, `conduit`, `script`, `infusion` (what an attached set does
    // that the fight does not score, and the rolls nobody stated) - or null
    // where the engine tagged nothing.
    unmodelled: (ev.throughput.unmodelled ?? []).map((u) => ({
      id: u.id, name: linked(u.name ?? u.id), kind: u.kind ?? null, why: whyOf(u),
      source: u.source ?? null,
    })),
  };
}

/**
 * The `optimize --json` envelope, field for field what bin/bench.mjs writes -
 * it has to, because the promise is that saving it and running
 * `bench sheet --build <file>` reproduces the same sheet.
 */
export function buildEnvelope({ engine, loadout, options = {}, metrics, ev, pinned, infusion = null }) {
  return {
    version: options.version ?? '0.1.0',
    cdbSha: engine.meta.cdbSha,
    bootSha: engine.meta.bootSha,
    goal: options.goal ?? 'dps',
    weights: options.weights ?? null,
    target: options.target ?? 'boss',
    targetLabel: ev.target.name,
    fervorScope: engine.opts.assume.fervorScope,
    // Which sheet a status tick is priced off. The CLI writes it and reads it
    // back (`ENVELOPE_KEYS`); nothing in the UI sets it, so this is the
    // engine's default - recorded because the numbers below were computed
    // under it and the envelope is field for field the CLI's.
    tickSource: engine.opts.assume.tickSource,
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
      // The slots whose INFUSION was held as the seed stated it (none stated
      // means held not infused) - what `bench optimize --build` re-pins.
      infusions: pinned?.infusions ?? [],
      // The rune slots and the talent tree the run held, as the CLI's
      // envelope records them, so `--build` and an import hold them again
      // rather than searching them anew.
      runes: pinned?.runes ?? [],
      talents: !!pinned?.talents,
    },
    // What the infusion search was allowed to do, so `--build` reproduces it:
    // the infusions it could hand out and what an unowned piece's bonus roll
    // was taken to be. bin/bench.mjs reads both back as the run's defaults.
    infusionSearch: { offered: infusion?.offered ?? [], stat: infusion?.statPolicy ?? 'none' },
    build: loadout,
    // The sets the build wears and each piece's bonus line, as the engine
    // attached them (infusion.mjs `attach`) - the CLI's own field.
    infusions: ev.infusions,
    metrics,
    sheet: Object.fromEntries(ev.sheet),
    unmodelled: ev.throughput.unmodelled,
    assumptions: engine.audit,
  };
}
