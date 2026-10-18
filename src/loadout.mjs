// ---------------------------------------------------------------------------
// loadout.mjs - a build, and the stat sheet it produces.
//
// A loadout is deliberately plain data so it round-trips through JSON, a text
// profile and a CLI flag without losing anything:
//
//   {
//     class: "Priest",             // a `unit` row with an aptitude
//     level: 25,
//     gear:     { Slot_Chest: { item: "Chest_RManfish_Cle", stars: 0 }, ... },
//     augments: { "Slot_Chest/AugmentBlacksmith": "ReinforcedCopperPlate", ... }
//   }
//
// An augment key is `<slot>/<augmentType>`, because legality is per host item:
// the same AugmentJeweller gem is a different decision on your neck than on
// either finger.
//
// A gear entry describes an INSTANCE, so beside `item` it may carry what the
// instance rolled or was given:
//
//   rarity        a weapon's rolled rarity id (gear keeps its row's)
//   stars         upgrade level
//   level         the level this copy dropped at
//   flawless      the Flawless item flag
//   infusion      the InfusionPassive skill id infused into it, e.g.
//                 "Infusion_Bee_DPS" (st.item.Gear.infusion)
//   infusionStat  the attribute id its infusion bonus rolled, e.g.
//                 "CritChanceRating" (st.item.Gear.infusionBonusStat); absent
//                 means not known, and then no bonus is priced
//   prismatic     true when the piece carries the Prismatic item flag, which
//                 lights the bonus whatever the infusion's faction
//
// The last three are ONE spelling everywhere - loadout, --json, the dump and
// snapshot importers, the pin grammar - and the game's own field name
// `infusionBonusStat` is accepted on the way in.
// ---------------------------------------------------------------------------

import { computeSheet } from './model.mjs';

export function emptyLoadout(cat, unitId, level) {
  const cls = cat.classes.find((c) => c.unit === unitId || c.aptitude === unitId);
  if (!cls) {
    throw new Error(
      `unknown class "${unitId}". Known: ${cat.classes.map((c) => c.unit).join(', ')}`
    );
  }
  // `skills` holds the choices a weapon or a class mechanic forces: two of the
  // three a weapon offers, three prayers out of three, and so on. Keyed the
  // same way sockets are, by what forced the choice.
  return { class: cls.unit, level, gear: {}, augments: {}, skills: {}, runes: {}, talents: {} };
}

export function classOf(cat, loadout) {
  const cls = cat.classes.find((c) => c.unit === loadout.class);
  if (!cls) throw new Error(`unknown class "${loadout.class}"`);
  return cls;
}

// Two-handed mainhands leave no hand for an offhand. `OHWeapon` is the only
// itemType flagged AllowShield, so this is a data rule and not a list we keep.
// Returns null when the loadout is legal, or a sentence saying why it is not.
export function illegalReason(cat, loadout) {
  const off = loadout.gear.Slot_OffhandWeapon;
  if (!off?.item) return null;
  const main = loadout.gear.Slot_Weapon1;
  // An offhand with no mainhand is an unfinished build, not an illegal one -
  // the search passes through that state on its way to filling the mainhand.
  if (!main?.item) return null;
  const mainItem = cat.itemById.get(main.item);
  if (!cat.allowsOffhand(mainItem)) {
    return `${mainItem.id} is a ${cat.handednessOf(mainItem) ?? 'two-handed weapon'} and uses both hands, ` +
           'so nothing can go in the offhand';
  }
  return null;
}

// An infusion on something the game will not infuse, or one that is not an
// infusion at all. Kept apart from `illegalReason` on purpose: that one is
// what `pruneIllegal` consults before deleting the offhand, and an infusion
// problem is no reason to take a shield off.
//
// Only what the GAME refuses is refused here ($HInfusion.canBeInfused@21689).
// A bonus stat outside the pool this bench computes is NOT: a real looted
// piece carries whatever the server rolled, getInfusionBonusAffix@9767 pays
// any stat an InfusionBonus row names, and a character ingested from a dump
// must stay scorable - the engine names it as a gap instead.
export function infusionIllegalReason(cat, loadout) {
  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g?.item || !g.infusion) continue;
    const item = cat.itemById.get(g.item);
    if (!item) continue;                      // evaluate() names the missing item
    if (!cat.infusions.has(g.infusion)) {
      return `${g.infusion} (on ${slot.id}) is not an infusion - no InfusionPattern item names it. `
        + `Known: ${[...cat.infusions.keys()].join(', ') || 'none on this build'}`;
    }
    const why = cat.whyNotInfusable(item);
    if (why) return `${slot.id} cannot carry ${cat.infusions.get(g.infusion).name}: ${why}`;
  }
  return null;
}

/**
 * The infusion sets a build wears: one entry per distinct infusion, with how
 * many equipped pieces carry it and the rank that count reaches.
 *
 * Counted the way ent.Hero.refreshInfusions@7739 counts (ops 5-52): one per
 * equipped Gear instance whose `infusion` is set, keyed by the infusion id -
 * so two infusions never add up to one set, and a piece between two caps adds
 * nothing. `rank` is $HInfusion.getRankFromStacks@21691; `nextCap` is the
 * piece count the next rank needs, or null at the top.
 *
 * THIS RANK IS ITS OWN NAMESPACE. It is not `--rank` (weapon mastery, 1-3 per
 * weapon skill) and not a talent's points; every `minRank`/`rank >= N` on an
 * InfusionPassive row is answered with this number and no other.
 */
export function infusionSets(cat, loadout) {
  const by = new Map();
  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g?.item || !g.infusion) continue;
    let e = by.get(g.infusion);
    if (!e) {
      const inf = cat.infusions.get(g.infusion);
      by.set(g.infusion, e = { id: g.infusion, name: inf?.name ?? g.infusion, faction: inf?.faction ?? null, pieces: 0, slots: [] });
    }
    e.pieces++;
    e.slots.push(slot.id);
  }
  const caps = cat.infusionCaps ?? [];
  return [...by.values()]
    .map((e) => ({ ...e, rank: cat.infusionRank(e.pieces), nextCap: caps.find((c) => c > e.pieces) ?? null }))
    .sort((a, b) => b.pieces - a.pieces || a.id.localeCompare(b.id));
}

// Drop anything the handedness rule forbids. Used by the search, which changes
// the mainhand constantly and must not leave an illegal shield behind.
export function pruneIllegal(cat, loadout) {
  if (illegalReason(cat, loadout)) delete loadout.gear.Slot_OffhandWeapon;
  return loadout;
}

// Every augment socket this loadout currently has, in slot order. A socket
// only exists while an item is in the slot that hosts it - taking the chest
// off takes its augment with it.
export function socketsOf(cat, loadout) {
  const out = [];
  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g) continue;
    const item = cat.itemById.get(g.item);
    if (!item) continue;
    for (const type of cat.socketsFor(item)) {
      out.push({ key: `${slot.id}/${type}`, slot: slot.id, type, host: item.id });
    }
  }
  return out;
}

// Assemble the sheet. Returns the computed attributes plus the raw modifier
// accumulator, so a caller can show where a number came from.
export function evaluate(cat, loadout, {
  baseStatsFor, injectFlat = null, injectAddRatio = null, injectMulRatio = null,
  force = null,
}) {
  const cls = classOf(cat, loadout);
  const armorReduction = cat.armorReductionFor(cls.aptitude);
  const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };

  const opts = { aptitude: cls.aptitude, charLevel: loadout.level, armorReduction };

  const bad = illegalReason(cat, loadout) ?? infusionIllegalReason(cat, loadout);
  if (bad) throw new Error(`loadout: ${bad}`);

  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g?.item) continue;
    const item = cat.itemById.get(g.item);
    if (!item) throw new Error(`loadout: no such item "${g.item}" (slot ${slot.id})`);
    if (!item.slots.includes(slot.id)) {
      throw new Error(`loadout: ${item.id} cannot go in ${slot.id}`);
    }
    if (!cat.usableBy(item, cls.aptitude)) {
      throw new Error(`loadout: ${cls.unit} cannot use ${item.id} (needs ${item.aptitudes.join('/')})`);
    }
    // A weapon's rolled rarity; a gear piece's own row's - see instanceRarity.
    const rarity = cat.instanceRarity(item, g);
    const stars = Math.min(g.stars ?? 0, cat.maxStars(item, rarity));
    // What is SOCKETED into this piece, because Gear.getILevel@9760 adds every
    // socketed item's own iLevel to the host's gear level - so an Epic
    // Corrupted Gift (iLevel 10) is worth a whole effective level of stats on
    // top of the affixes it swaps. The sockets have to be resolved BEFORE the
    // host's stats are computed, which is why this is gathered here rather than
    // in the augment pass below.
    const socketed = [];
    for (const type of cat.socketsFor(item)) {
      const augId = loadout.augments?.[`${slot.id}/${type}`];
      if (augId) socketed.push(augId);
    }
    cat.contribute(item, slot.id, {
      ...opts, stars, rarity, flawless: !!g.flawless, level: g.level ?? null, socketed,
      // Which of an item's generic aptitudes this instance rolled. Only craft
      // jewellery names more than one; everything else ignores it.
      generic: g.generic ?? null,
      // The infusion bonus line - `contribute` pays it only while it is lit
      // (catalog.infusionBonusActive). It rides the INSTANCE's item level, so
      // it has to see the same stars/level/sockets the bake does.
      infusion: g.infusion ?? null, infusionStat: g.infusionStat ?? null, prismatic: !!g.prismatic,
    }, mods);
  }

  // Augments are flat authored affixes on the host item, so they inherit the
  // host slot's affixFactor - an enchant on the arsenal weapon is worth 40%.
  for (const sock of socketsOf(cat, loadout)) {
    const augId = loadout.augments[sock.key];
    if (!augId) continue;
    const aug = cat.itemById.get(augId);
    if (!aug) throw new Error(`loadout: no such augment "${augId}"`);
    if (aug.augmentType !== sock.type) {
      throw new Error(`loadout: ${augId} is a ${aug.augmentType}, not a ${sock.type}`);
    }
    const af = cat.slotById.get(sock.slot)?.affixFactor ?? 1;
    cat.applyAffixes(aug.affixes, mods, af, af !== 1);
  }

  // Anything the caller computes outside the gear layer - WeaponPower is the
  // only one today, because the weapon sets it and no budget group carries it.
  for (const [atb, v] of injectFlat ?? []) {
    mods.flat.set(atb, (mods.flat.get(atb) ?? 0) + v);
  }
  for (const [atb, v] of injectAddRatio ?? []) {
    mods.addRatio.set(atb, (mods.addRatio.get(atb) ?? 0) + v);
  }
  for (const [atb, v] of injectMulRatio ?? []) {
    mods.mulRatio.set(atb, (mods.mulRatio.get(atb) ?? 1) * v);
  }

  const base = baseStatsFor(cls.unit, loadout.level);
  const sheet = computeSheet(cat.ctx, { base, mods, level: loadout.level, force });
  return { sheet, mods, cls, armorReduction };
}

// Every skill id this build touches, with where it came from. Used for
// reporting and for the coverage manifest; the rotation itself is built by
// skills.mjs, which knows which of these you actually get to press.
export function skillsOf(cat, loadout) {
  const cls = classOf(cat, loadout);
  const ids = new Set();
  const sources = new Map();

  const add = (id, from) => {
    if (!id) return;
    ids.add(id);
    if (!sources.has(id)) sources.set(id, from);
  };

  const unit = cat.cdb.byId('unit').get(cls.unit);
  for (const s of unit?.skills ?? []) add(s.skill ?? s.ref, 'class');

  for (const slot of cat.combatSlots()) {
    const g = loadout.gear[slot.id];
    if (!g?.item) continue;
    const item = cat.itemById.get(g.item);
    for (const s of item?.skills ?? []) add(s, slot.id);
    // The itemType can carry skills too (a weapon class's shared moves).
    const typeSkills = cat.inherited(item.type, (t) => t?.skills);
    for (const s of typeSkills ?? []) add(s.skill ?? s.ref, slot.id);
  }

  for (const sock of socketsOf(cat, loadout)) {
    // The arsenal weapon's sockets hand out no skill (catalog.mjs
    // socketGrantsSkills).
    if (!cat.socketGrantsSkills(sock.slot)) continue;
    const augId = loadout.augments[sock.key];
    const aug = augId ? cat.itemById.get(augId) : null;
    for (const s of aug?.skills ?? []) add(s, sock.key);
  }

  return { ids: [...ids], sources };
}
