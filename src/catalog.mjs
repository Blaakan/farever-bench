// ---------------------------------------------------------------------------
// catalog.mjs - slots, items, augments, and what a piece of gear is worth.
//
// The gear model, as the data actually has it:
//
//   * A stat stick's stats are stored NOWHERE. They are computed at equip time
//     from `itemType.atbRatio` (this slot's share of the budget) times
//     `aptitude.atbScaling` (the level curve for that stat group), evaluated
//     at the item's effective level. So two chests of the same rarity, level
//     and faction are identical, and "rank every chest" is arithmetic rather
//     than a search. Only 6 equippable items in the whole sheet carry an
//     authored affix.
//
//   * Which secondary rating a piece can carry is decided by the cross of the
//     character's class and the ITEM'S FACTION, through
//     `aptitude.atbScaling[].conds.factions`. A Manfish chest gives a Priest
//     FervorRating and a Warrior ArmorPenetrationRating, out of the same row.
//     Gear with no faction has no secondary stat at all.
//
//   * Augments are a separate, fully authored layer: 93 items across 8
//     `Augment*` itemTypes, each carrying explicit flat affixes. Legality is
//     `itemType.props.augmentTargets` intersected with the host item's own
//     inheritance chain. They are not a rounding error - a single
//     DemonGearUpgrade moves 40 rating, which is more than the entire rating
//     contribution of any armour slot.
//
//   * `Slot_Weapon2` carries `slot.affixFactor = 0.4`: the arsenal weapon
//     contributes two fifths of its stats, so a character wears 1.4 weapons.
// ---------------------------------------------------------------------------

import { budget, resistForReduction, STAT_GROUPS } from './model.mjs';

// The slots a build is actually optimising. Tools, bags, mount, glider and
// the four consumable slots are read but never scored - see docs/MODEL.md.
const COMBAT_CATEGORIES = new Set(['Left', 'Right', 'Weapons']);

export function buildCatalog(cdb, ctx) {
  const itemTypes = cdb.byId('itemType');
  const rarityOrder = new Map(cdb.lines('rarity').map((r, i) => [r.id, i]));
  const statGroupNames = cdb.enumValues('aptitude@atbScaling', 'statGroup').map((s) => s.toLowerCase());
  const displayCategories = cdb.enumValues('itemType@slot', 'displayCategory');

  // --- itemType inheritance -------------------------------------------------
  const chainCache = new Map();
  function chain(typeId) {
    let c = chainCache.get(typeId);
    if (c) return c;
    c = [];
    for (let cur = itemTypes.get(typeId); cur; ) {
      c.push(cur.id);
      const p = cur.inherit;
      cur = p ? itemTypes.get(p) : null;
    }
    chainCache.set(typeId, c);
    return c;
  }

  // Walk up the chain for the first row that actually declares a thing.
  function inherited(typeId, pick) {
    for (const id of chain(typeId)) {
      const v = pick(itemTypes.get(id));
      if (v !== undefined && v !== null && !(typeof v === 'object' && Object.keys(v).length === 0)) return v;
    }
    return null;
  }

  // --- slots ----------------------------------------------------------------
  const slots = [];
  for (const t of cdb.lines('itemType')) {
    if (!t.slot?.isSlot) continue;
    const cat = displayCategories[t.slot.displayCategory ?? -1] ?? null;
    slots.push({
      id: t.id,
      category: cat,
      combat: COMBAT_CATEGORIES.has(cat),
      affixFactor: t.slot.affixFactor ?? 1,
      types: [], // filled below
    });
  }
  const slotById = new Map(slots.map((s) => [s.id, s]));

  // Reverse `slot.equippableOn`: which itemTypes go in which slot.
  for (const t of cdb.lines('itemType')) {
    for (const e of t.slot?.equippableOn ?? []) {
      const s = slotById.get(e.ref);
      if (s) s.types.push(t.id);
    }
  }

  // --- aptitudes ------------------------------------------------------------
  // A "generic" aptitude is one the game puts on jewellery: no display name
  // and no `combines`, carrying only a rating. Anyone can wear those.
  const aptitudes = cdb.byId('aptitude');
  const isGeneric = (id) => {
    const a = aptitudes.get(id);
    return !!a && !a.name && !(a.combines ?? []).length;
  };

  // The hero units, one per playable class, and the aptitude each maps to.
  const classes = cdb.lines('unit')
    .filter((u) => (u.props?.aptitudes ?? []).length && !u.props?.foe)
    .map((u) => ({
      unit: u.id,
      name: u.id,
      aptitude: u.props.aptitudes[0].ref,
      aptitudeName: aptitudes.get(u.props.aptitudes[0].ref)?.name ?? u.props.aptitudes[0].ref,
    }));

  // --- items ----------------------------------------------------------------
  const items = [];
  for (const it of cdb.lines('item')) {
    const ch = chain(it.type);
    const slotIds = slots.filter((s) => s.types.some((t) => ch.includes(t))).map((s) => s.id);
    const augmentOf = cdb.lines('itemType').filter(
      (t) => t.id.startsWith('Augment') && (t.props?.augmentTargets ?? []).length && ch.includes(t.id)
    );
    if (!slotIds.length && !augmentOf.length) continue;

    items.push({
      id: it.id,
      name: it.texts?.name ?? it.id,
      type: it.type,
      chain: ch,
      slots: slotIds,
      isAugment: augmentOf.length > 0,
      augmentType: augmentOf[0]?.id ?? null,
      rarity: it.rarity ?? 'Common',
      faction: it.faction ?? null,
      affinity: it.affinity ?? null,
      level: it.level ?? null,
      iLevel: it.iLevel ?? null,
      aptitudes: (it.aptitudes ?? []).map((a) => a.ref),
      affixes: it.affixes ?? [],
      skills: (it.skills ?? []).map((s) => s.skill ?? s.ref).filter(Boolean),
      moveSet: inherited(it.type, (t) => t?.moveSet),
      raw: it,
    });
  }
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Which augment types can sit on a given host item.
  const augmentTypes = cdb.lines('itemType')
    .filter((t) => (t.props?.augmentTargets ?? []).length)
    .map((t) => ({ id: t.id, targets: t.props.augmentTargets.map((x) => x.itemType) }));

  function socketsFor(item) {
    if (!item) return [];
    return augmentTypes
      .filter((a) => a.targets.some((tgt) => item.chain.includes(tgt)))
      .map((a) => a.id);
  }

  // --- effective level ------------------------------------------------------
  // iLevel is ten times the level. Items with neither (every `*_R<Faction>_*`
  // row - 501 of them) drop at the character's level, so that is what they
  // are worth. Rarity, upgrade stars and "flawless" each add iLevel on top.
  function effectiveLevel(item, { charLevel, stars = 0, flawless = false, rarity = null }) {
    const baseILevel = item.iLevel ?? (item.level != null ? item.level * 10 : charLevel * 10);
    const rar = cdb.byId('rarity').get(rarity ?? item.rarity);
    const iLevel = baseILevel
      + (rar?.props?.iLevelBonus ?? 0)
      + ctx.consts.gearUpgradeILevelBonus * stars
      + (flawless ? ctx.consts.flawlessILevelBonus : 0);
    return iLevel / 10;
  }

  function maxStars(item, rarity = null) {
    return cdb.byId('rarity').get(rarity ?? item.rarity)?.props?.gearUpgrades ?? 0;
  }

  // Rarity is NOT a property of an item id. `st.Player.dropLoot` picks it with
  // a weighted random draw over `rarity.props.generationChance`, banded by
  // level, filtered to at least the item's authored rarity - which is why a
  // CDB-Rare sword can be sitting in your bag as Legendary. So the unit a tool
  // ranks is (item, rarity), and for gear you do not own yet the right answer
  // is a distribution rather than a point.
  function attainableRarities(item, charLevel) {
    const floor = rarityOrder.get(item.rarity) ?? 0;
    const out = [];
    for (const r of cdb.lines('rarity')) {
      if ((rarityOrder.get(r.id) ?? 0) < floor) continue;
      const band = (r.props?.generationChance ?? [])
        .find((b) => charLevel >= b.minLevel && charLevel <= b.maxLevel);
      const chance = band?.chance ?? 0;
      if (r.id === item.rarity) out.push({ rarity: r.id, chance: chance || null, authored: true });
      else if (chance > 0) out.push({ rarity: r.id, chance, authored: false });
    }
    return out;
  }

  // --- handedness -----------------------------------------------------------
  // Only a one-handed mainhand leaves a hand free, and the data says which
  // those are rather than us listing them: `OHWeapon` is the single itemType
  // carrying the `AllowShield` flag, and every weapon type inherits from
  // exactly one of OHWeapon / THWeapon / DualWeapon / LongWeapon.
  const typeFlagNames = cdb.enumValues('itemType', 'flags');
  const allowShieldBit = typeFlagNames.indexOf('AllowShield');
  if (allowShieldBit < 0) throw new Error('itemType.flags has no AllowShield - the game changed shape');

  function allowsOffhand(mainhand) {
    if (!mainhand) return false;
    return chain(mainhand.type).some((id) => ((itemTypes.get(id)?.flags ?? 0) >> allowShieldBit) & 1);
  }

  function handednessOf(item) {
    const hit = chain(item.type).find((id) => ['OHWeapon', 'THWeapon', 'DualWeapon', 'LongWeapon'].includes(id));
    return hit ?? null;
  }

  // --- legality -------------------------------------------------------------
  // An item is wearable if it names no aptitude, names the character's own, or
  // names only generic ones.
  function usableBy(item, aptitude) {
    if (!item.aptitudes.length) return true;
    return item.aptitudes.some((a) => a === aptitude || isGeneric(a));
  }

  // An item's `aptitudes` column is the set of aptitudes the item CAN be, not a
  // set it is all of at once - `$HItem.getAptitude` is singular. Two shapes
  // exist and they behave differently:
  //
  //   * a class item names one or two CLASS aptitudes (`Chest_Z2U2_FigCle` is
  //     [Fighter, Cleric]), of which at most one can ever be yours, so the
  //     choice is forced;
  //   * craft jewellery names several GENERIC ones (`Necklace_Z1RCraft` is
  //     [Crit, Fervor, ArPen, MaPen]), which is a real choice - one necklace
  //     id, four different necklaces.
  //
  // No item mixes the two shapes, so filtering to what this character can use
  // leaves either one class aptitude or a list of generics. Summing that list
  // would pay the shared MaxHealth budget once per entry, which is why this
  // returns options and the caller picks exactly one.
  function payingAptitudes(item, aptitude) {
    if (!item.aptitudes.length) return [];
    return item.aptitudes.filter((a) => a === aptitude || isGeneric(a));
  }

  // The single aptitude an equipped instance resolves to. `chosen` comes from
  // the loadout; without it the first option wins, which is deterministic and
  // reported rather than hidden.
  function resolveAptitude(item, aptitude, chosen = null) {
    const options = payingAptitudes(item, aptitude);
    if (!options.length) return null;
    if (chosen) {
      if (!options.includes(chosen)) {
        throw new Error(`${item.id} cannot be a ${chosen} item (options: ${options.join(', ')})`);
      }
      return chosen;
    }
    return options[0];
  }

  // --- affix application ----------------------------------------------------
  // Only four of the twelve affix rows target an attribute, and they are the
  // only ones any equippable or augment uses. The rest are inventory size,
  // craft chances and internal markers.
  const AFFIX_KIND = {
    TAttribute_Flat: 'flat',
    TAttribute_ARatio: 'addRatio',
    TAttribute_MRatio: 'mulRatio',
    TAttribute_MRatioMin: 'mulRatio',
  };

  function applyAffixes(affixes, mods, factor = 1) {
    for (const a of affixes ?? []) {
      const kind = AFFIX_KIND[a.ref];
      const atb = a.target?.attribute;
      if (!kind || !atb) continue;
      const v = (a.val ?? 0) * factor;
      if (kind === 'mulRatio') {
        mods.mulRatio.set(atb, (mods.mulRatio.get(atb) ?? 1) * (1 + v));
      } else {
        mods[kind].set(atb, (mods[kind].get(atb) ?? 0) + v);
      }
    }
  }

  // --- the conversion an atbScaling row implies ----------------------------
  // A row like {endAtb: MaxHealth, sourceAtb: Vitality} states its budget in
  // MaxHealth but delivers it as Vitality, so the amount has to be divided by
  // however much MaxHealth one Vitality buys (3, from MaxHealth.scaling).
  function sourceConversion(endAtb, sourceAtb) {
    if (!sourceAtb || sourceAtb === endAtb) return 1;
    const end = ctx.attrTable.byId.get(endAtb);
    const hit = end?.scaling.find((s) => s.from === sourceAtb && s.op.case !== 'Rating');
    if (!hit || !hit.scale) {
      throw new Error(
        `aptitude.atbScaling maps ${sourceAtb} -> ${endAtb} but ${endAtb} has no ` +
        `scaling entry from ${sourceAtb}; the conversion factor is unknown.`
      );
    }
    return hit.scale;
  }

  // --- what one equipped item contributes ----------------------------------
  /**
   * @param item     a catalog item
   * @param slotId   which slot it is worn in (decides affixFactor)
   * @param opts     {aptitude, charLevel, stars, flawless, armorReduction}
   * @param mods     accumulator {flat, addRatio, mulRatio} of Maps
   */
  function contribute(item, slotId, opts, mods) {
    const slot = slotById.get(slotId);
    const affixFactor = slot?.affixFactor ?? 1;
    const rarity = opts.rarity ?? item.rarity;
    const effLevel = effectiveLevel(item, opts);
    const ratios = { ...(inherited(item.type, (t) => t?.atbRatio) ?? {}) };

    // A per-rarity override zeroes primary and vitality on Common gear.
    const rarities = inherited(item.type, (t) => t?.props?.rarities);
    const ov = (rarities ?? []).find((r) => r.rarity === rarity)?.atbRatio;
    if (ov) Object.assign(ratios, ov);

    const aptId = resolveAptitude(item, opts.aptitude, opts.itemAptitude);
    if (aptId) {
      const apt = aptitudes.get(aptId);
      for (const e of apt?.atbScaling ?? []) {
        const c = e.conds ?? {};
        if (c.minRarity != null && (rarityOrder.get(rarity) ?? -1) < (rarityOrder.get(c.minRarity) ?? 0)) continue;
        if ((c.factions ?? []).length && !c.factions.some((f) => f.ref === item.faction)) continue;

        const group = statGroupNames[e.statGroup ?? 0];
        const ratio = ratios[group] ?? 0;
        if (!ratio) continue;

        // Armor and MagicArmor ignore their authored start/end.
        const isArmor = e.endAtb === 'Armor' || e.endAtb === 'MagicArmor';
        const total = isArmor
          ? resistForReduction(effLevel, opts.armorReduction, ctx.consts.resistFormula)
          : budget(effLevel, e.start, e.end, ctx.consts.earlyMaxLevel);
        if (!total) continue;

        const target = e.sourceAtb ?? e.endAtb;
        const amount = (total * ratio * affixFactor) / sourceConversion(e.endAtb, e.sourceAtb);
        mods.flat.set(target, (mods.flat.get(target) ?? 0) + amount);
      }
    }

    // Authored affixes, if any, and the item's own slot factor applies to them
    // too - an arsenal weapon is 40% of itself in every respect.
    applyAffixes(item.affixes, mods, affixFactor);
  }

  // The mean of the character's aptitudes' armorReduction - what the runtime
  // uses as the Armor budget target.
  function armorReductionFor(aptitude) {
    const a = aptitudes.get(aptitude);
    const reds = [a?.props?.armorReduction].filter((x) => x != null);
    if (!reds.length) return 0;
    return reds.reduce((s, x) => s + x, 0) / reds.length;
  }

  return {
    cdb, ctx,
    slots, slotById, classes, items, itemById,
    chain, inherited, socketsFor, augmentTypes,
    effectiveLevel, maxStars, usableBy, payingAptitudes, resolveAptitude,
    contribute, applyAffixes, armorReductionFor,
    rarityOrder, isGeneric, attainableRarities,
    allowsOffhand, handednessOf,

    combatSlots: () => slots.filter((s) => s.combat),

    // Every item that can legally go in a slot for this class, filtered by
    // level requirement and the rarities the caller allows.
    //
    // `rarityRoll` expands each item into one entry per rarity it can actually
    // drop as, because rarity is rolled and not authored. Off by default: it
    // multiplies the search space by about three and turns a definite answer
    // into a probabilistic one, which is the right trade only when the
    // question is "what should I chase" rather than "what should I wear".
    candidates(slotId, { aptitude, charLevel, rarities = null, exclude = null, rarityRoll = false } = {}) {
      const out = [];
      for (const it of items) {
        if (it.isAugment) continue;
        if (!it.slots.includes(slotId)) continue;
        if (!usableBy(it, aptitude)) continue;
        if (it.level != null && it.level > charLevel) continue;
        if (exclude && exclude.test(it.id)) continue;

        const rarityVariants = rarityRoll
          ? attainableRarities(it, charLevel)
          : [{ rarity: it.rarity, chance: null, authored: true }];
        // One row per (rarity, aptitude) the instance could be. For most items
        // that is one row; craft jewellery genuinely offers several.
        const aptVariants = payingAptitudes(it, aptitude);
        for (const v of rarityVariants) {
          if (rarities && !rarities.has(v.rarity)) continue;
          for (const apt of aptVariants.length ? aptVariants : [null]) {
            out.push({
              item: it, rarity: v.rarity, chance: v.chance, authored: v.authored,
              aptitude: apt,
              aptitudeIsChoice: aptVariants.length > 1,
            });
          }
        }
      }
      return out;
    },

    // Every augment that can sit in a given socket type. Augments are not
    // dropped gear - they are crafted from an authored recipe - so their
    // rarity is fixed and never rolled.
    augmentCandidates(socketType, { exclude = null } = {}) {
      return items.filter((it) => it.isAugment && it.augmentType === socketType
        && !(exclude && exclude.test(it.id)));
    },
  };
}
