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

  const bad = illegalReason(cat, loadout);
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
    const rarity = g.rarity ?? item.rarity;
    const stars = Math.min(g.stars ?? 0, cat.maxStars(item, rarity));
    // What is SOCKETED into this piece, because Gear.getILevel@8123 adds every
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

/**
 * The standing, weaponless, floored primaries - the basis a TRINKET-granted
 * status tick reads. Live, Trinket_Demon_Status pays a constant 45.00 per tick
 * in Emsey's snapshot state, and 45.00 = 0.2 x 225 where 225 is exactly
 * floor(each base primary) + the flat primary affixes of every NON-WEAPON
 * piece (138 + 87) - not the combat sheet (whose four-primary sum is 294 and
 * would tick 59), and not any weapon-mixed variant. 2,407 capture rows sit on
 * the integer. The mechanism behind the weapon exclusion was not isolated in
 * the client; the basis is stated here as measured, and a second wearer with
 * primary affixes on more attributes would discriminate the near-miss
 * decompositions (rounded-base + Dex-only lands on the same 225 for this one
 * build).
 */
export function standingPrimaries(cat, loadout, { baseStatsFor, primaries }) {
  const cls = classOf(cat, loadout);
  const armorReduction = cat.armorReductionFor(cls.aptitude);
  const mods = { flat: new Map(), addRatio: new Map(), mulRatio: new Map() };
  const opts = { aptitude: cls.aptitude, charLevel: loadout.level, armorReduction };
  const WEAPON = new Set(['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']);
  for (const slot of cat.combatSlots()) {
    if (WEAPON.has(slot.id)) continue;
    const g = loadout.gear[slot.id];
    if (!g?.item) continue;
    const item = cat.itemById.get(g.item);
    if (!item) continue;
    const rarity = g.rarity ?? item.rarity;
    const stars = Math.min(g.stars ?? 0, cat.maxStars(item, rarity));
    const socketed = [];
    for (const type of cat.socketsFor(item)) {
      const augId = loadout.augments?.[`${slot.id}/${type}`];
      if (augId) socketed.push(augId);
    }
    cat.contribute(item, slot.id, {
      ...opts, stars, rarity, flawless: !!g.flawless, level: g.level ?? null, socketed,
      generic: g.generic ?? null,
    }, mods);
  }
  for (const sock of socketsOf(cat, loadout)) {
    if (WEAPON.has(sock.slot)) continue;
    const augId = loadout.augments[sock.key];
    if (!augId) continue;
    const aug = cat.itemById.get(augId);
    if (!aug) continue;
    const af = cat.slotById.get(sock.slot)?.affixFactor ?? 1;
    cat.applyAffixes(aug.affixes, mods, af, af !== 1);
  }
  const base = baseStatsFor(cls.unit, loadout.level);
  const out = new Map();
  for (const atb of primaries) {
    out.set(atb, Math.floor(base.get(atb) ?? 0) + (mods.flat.get(atb) ?? 0));
  }
  return out;
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
    const augId = loadout.augments[sock.key];
    const aug = augId ? cat.itemById.get(augId) : null;
    for (const s of aug?.skills ?? []) add(s, sock.key);
  }

  return { ids: [...ids], sources };
}
