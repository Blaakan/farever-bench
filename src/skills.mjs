// ---------------------------------------------------------------------------
// skills.mjs - what you actually press, and what you had to choose.
//
// A weapon does not hand you its whole kit. It grants a fixed base-attack chain
// and a combo, which you always have, plus a POOL of `WeaponSkill` and
// `WeaponPassive` entries of which you slot only some. Most weapons offer three
// and you pick two, so "which two" is a build decision the same way an item is,
// and this module makes it one the search can choose.
//
// Slot counts come from the game's own constants, not from a list here:
//
//   UnlockLevel_WeaponSkillSlots  [1, 2]      main-hand skill slots
//   UnlockLevel_Arsenal           [7, 20, 50] arsenal (Slot_Weapon2) slots
//   Priest_Prayer_Slot_Unlocks    [1, 1, 9]   prayers in the sequence
//   Mage_Conduit_Levels           [1, 1, 4]   conduits
//
// so a level-12 character gets two main-hand skills, one arsenal skill and
// three prayers, and the numbers move on their own if a patch moves them.
//
// The second thing this module fixes is the difference between a skill you cast
// and a skill that fires at you. Roughly a third of what a build knows is
// `nature: Passive` - prayers, poisons, conduits, weapon passives, enchants.
// Those have a `cooldown` field that is an anti-double-fire guard, not a cast
// rate: `Priest_Prayer_Smite` reads `cooldown: 1` and doing 279 damage every
// second would make it the entire build. Its real trigger is in its own
// description - "Becomes ready after you use your [ComboAttack]" - and in
// `Priest_Rosary`'s script:
//
//     function onSkillProc(ctx) {
//       if( ctx.skill.isFinalAttack() ) { chargePrayer(); }
//     }
//
// So triggered skills get a rate from an explicit rule tied to something the
// data states, and anything without such a rule scores ZERO and is named in the
// coverage report rather than guessed at.
// ---------------------------------------------------------------------------

const FILLER_TYPES = new Set(['Attack', 'Attack2', 'Attack3', 'Attack4', 'AttackCombo']);
const COMBO_TYPES = new Set(['AttackCombo']);

// Types you press, that sit on a real cooldown.
const ACTIVE_TYPES = new Set([
  'WeaponSkill', 'ClassSkill', 'SignatureSkill', 'Skill', 'Secondary',
]);

// The per-class mechanic skills. Each is chosen from a pool and each fires on
// an event rather than on a cooldown.
const MECHANIC_TYPES = {
  PriestPrayer: { slotConstant: 'Priest_Prayer_Slot_Unlocks', label: 'prayers' },
  MageConduit: { slotConstant: 'Mage_Conduit_Levels', label: 'conduits' },
  RoguePoison: { slotConstant: null, label: 'poisons' },
};

// Types that are never throughput: movement, mounts, menus.
const INERT_TYPES = new Set([
  'Dash', 'Swap', 'Jump', 'Exit', 'Mount', 'Action', 'ItemUse', 'GroupSkill',
]);

// `addStatus(<who>, Skill.<Id>)` - the only way a self-buff's identity is
// recorded. The status skill it names carries the actual affix and the stack
// cap in ordinary data columns; it is only the LINK that lives in script text,
// so this reads the link and nothing else. Two targets mean "me": `owner`, and
// `hit.source` inside an onInflictHit handler.
const ADD_STATUS = /addStatus\s*\(\s*([A-Za-z_.]+)\s*,\s*Skill\.([A-Za-z0-9_]+)\s*\)/g;
const SELF_TARGETS = new Set(['owner', 'hit.source', 'this.owner', 'dmg.source']);

export function buildSkillPlan(cdb, ctx, cat, combat) {
  const skills = cdb.byId('skill');
  const T = cdb.enumValues('skill', 'type');

  // How many of a thing you have at a given level: count the unlock levels at
  // or below it. The list IS the slot count.
  function slotsAt(constantId, level) {
    if (!constantId) return Infinity;
    let vals;
    try { vals = cdb.constantFloats(constantId); } catch { return Infinity; }
    return vals.filter((v) => v <= level).length;
  }

  const weaponSlotsAt = (level) => slotsAt('UnlockLevel_WeaponSkillSlots', level);
  const arsenalSlotsAt = (level) => slotsAt('UnlockLevel_Arsenal', level);

  function typeOf(id) {
    const s = skills.get(id);
    return s ? (T[s.type] ?? null) : null;
  }

  // A `WeaponSubSkill` is a follow-up, not a choice: `Book_WaterOrbs_Skill2_Recast`
  // exists only because Skill2 does. The wiring is by id prefix, which is how
  // the data names them; one that matches nothing (`Staff_Censer_Ultimate`) has
  // no discoverable trigger and is reported unmodelled rather than handed out
  // free - it does 658 damage, so guessing would not be a rounding error.
  function subSkillsFor(selected, all) {
    const out = [];
    for (const id of all) {
      if (typeOf(id) !== 'WeaponSubSkill') continue;
      if (selected.some((sel) => id !== sel && id.startsWith(sel))) out.push(id);
    }
    return out;
  }

  function orphanSubSkills(all, selected) {
    return all.filter((id) => typeOf(id) === 'WeaponSubSkill'
      && !selected.some((sel) => id !== sel && id.startsWith(sel)));
  }

  // --- the pools a build has to choose from --------------------------------
  /**
   * Every selection this loadout has to make, each with its options and how
   * many of them fit. Weapon pools depend on what is equipped, so this is
   * recomputed whenever the gear changes.
   */
  function pools(loadout) {
    const out = [];
    const level = loadout.level;

    // The two weapon slots are NOT symmetric, and this is confirmed in game:
    //
    //   Slot_Weapon1        full stats, every skill, and the combo attack
    //   Slot_OffhandWeapon  full stats and every skill (no pool at all)
    //   Slot_Weapon2        stats at 0.4, and only TWO skills, chosen - and the
    //                       weapon passive counts against those two
    //
    // So the main hand's pool covers only its `WeaponSkill`s, against
    // `UnlockLevel_WeaponSkillSlots` (2 from level 2), and its `WeaponPassive`
    // is always on. A typical weapon has two skills and a passive, which is why
    // the main hand feels like it grants everything - it does.
    {
      const g = loadout.gear.Slot_Weapon1;
      const item = g?.item ? cat.itemById.get(g.item) : null;
      const options = (item?.skills ?? []).filter((id) => typeOf(id) === 'WeaponSkill');
      const slots = weaponSlotsAt(level);
      if (options.length && slots >= 1) {
        out.push({
          key: 'Slot_Weapon1', kind: 'weapon', slot: 'Slot_Weapon1', host: item.id,
          label: 'main-hand skills', slots: Math.min(slots, options.length), options,
        });
      }
    }
    {
      const g = loadout.gear.Slot_Weapon2;
      const item = g?.item ? cat.itemById.get(g.item) : null;
      // The passive is in the pool here: "only 2 of the 3 are available, even
      // passive skills, and they are picked by the player".
      const options = (item?.skills ?? []).filter((id) => {
        const t = typeOf(id);
        return t === 'WeaponSkill' || t === 'WeaponPassive';
      });
      const slots = arsenalSlotsAt(level);
      if (options.length && slots >= 1) {
        out.push({
          key: 'Slot_Weapon2', kind: 'weapon', slot: 'Slot_Weapon2', host: item.id,
          label: 'arsenal skills', slots: Math.min(slots, options.length), options,
        });
      }
    }

    // The class mechanic, if this class has one.
    const unit = cdb.byId('unit').get(loadout.class);
    const classSkills = (unit?.skills ?? []).map((s) => s.skill ?? s.ref).filter(Boolean);
    for (const [type, def] of Object.entries(MECHANIC_TYPES)) {
      const options = classSkills.filter((id) => typeOf(id) === type);
      if (!options.length) continue;
      const slots = Math.min(slotsAt(def.slotConstant, level), options.length);
      if (slots < 1) continue;
      out.push({
        key: `class/${type}`, kind: 'mechanic', slot: null, host: loadout.class,
        label: def.label, slots, options, mechanic: type,
      });
    }
    return out;
  }

  // The default selection: the first `slots` options, so a build with no
  // explicit choice is still well-defined and deterministic.
  function defaultSelection(loadout) {
    const sel = {};
    for (const p of pools(loadout)) sel[p.key] = p.options.slice(0, p.slots);
    return sel;
  }

  // Prune a selection down to what is currently legal - the search swaps
  // weapons constantly and a stale skill id must not survive the swap.
  function pruneSelection(loadout) {
    const live = new Map(pools(loadout).map((p) => [p.key, p]));
    loadout.skills ??= {};
    for (const key of Object.keys(loadout.skills)) {
      const p = live.get(key);
      if (!p) { delete loadout.skills[key]; continue; }
      const kept = loadout.skills[key].filter((id) => p.options.includes(id)).slice(0, p.slots);
      loadout.skills[key] = kept;
    }
    // Fill anything unset so a partial build still evaluates.
    for (const [key, p] of live) {
      if (!loadout.skills[key]?.length) loadout.skills[key] = p.options.slice(0, p.slots);
    }
    return loadout;
  }

  // --- the rotation --------------------------------------------------------
  /**
   * Turn a loadout into the buckets the throughput model needs.
   *
   * Only the MAIN-HAND weapon's base-attack chain is used: the arsenal is a
   * second weapon you swap to, not a second set of swings you get for free.
   * The arsenal still contributes its slotted skills, which is exactly what
   * `UnlockLevel_Arsenal` describes.
   */
  function resolve(loadout, rank) {
    const runes = new Set(Object.values(loadout.runes ?? {}).flat().filter(Boolean));
    const sel = loadout.skills ?? defaultSelection(loadout);
    const filler = [];
    const active = [];
    const triggered = [];
    const passive = [];
    const unmodelled = [];
    const seen = new Set();

    const push = (bucket, id, extra = {}) => {
      if (seen.has(id)) return;
      seen.add(id);
      const prof = combat.profile(id, rank, runes);
      if (!prof) return;
      const carries = prof.effects.some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind));
      if (!carries) {
        // No declared amount, but it may still grant a stat.
        const own = (prof.affixes ?? []).filter((a) => a.target?.attribute);
        const buffs = selfBuffsOf(id);
        if (own.length || buffs.length) passive.push({ prof, source: extra.source, affixes: own, buffs });
        return;
      }
      // A cast rate has to come from somewhere. A cooldown is one; a resource
      // cost the model does not track is not.
      if (bucket === active && !(prof.cooldown > 0)) {
        if (prof.costs.length) {
          unmodelled.push({
            id,
            why: `gated by ${prof.costs.map((c) => c.atb).join('/')}, which this model does not track`,
          });
        } else {
          unmodelled.push({ id, why: 'no cooldown and no resource cost, so no cast rate can be derived' });
        }
        return;
      }
      bucket.push({ ...extra, prof });
    };

    // 1. The main-hand chain, and only it - the combo attack cannot be
    // performed with the arsenal weapon. Its passive is always on, unlike the
    // arsenal's, which has to win one of two slots.
    const main = loadout.gear.Slot_Weapon1?.item ? cat.itemById.get(loadout.gear.Slot_Weapon1.item) : null;
    if (main) {
      for (const id of main.skills) {
        const t = typeOf(id);
        if (FILLER_TYPES.has(t)) push(filler, id, { source: 'Slot_Weapon1' });
        else if (t === 'WeaponPassive') pushTriggered(id, 'Slot_Weapon1');
      }
    }

    // The offhand grants full stats and every skill it has, with no pool.
    const off = loadout.gear.Slot_OffhandWeapon?.item ? cat.itemById.get(loadout.gear.Slot_OffhandWeapon.item) : null;
    for (const id of off?.skills ?? []) {
      const t = typeOf(id);
      if (FILLER_TYPES.has(t)) continue;             // the offhand has no chain of its own
      if (t === 'WeaponSkill') push(active, id, { source: 'Slot_OffhandWeapon' });
      else pushTriggered(id, 'Slot_OffhandWeapon');
    }

    // 2. Slotted weapon skills, from both hands, plus their follow-ups.
    for (const p of pools(loadout)) {
      const chosen = (sel[p.key] ?? p.options.slice(0, p.slots)).slice(0, p.slots);
      const item = p.kind === 'weapon' ? cat.itemById.get(loadout.gear[p.slot]?.item) : null;
      const all = item?.skills ?? [];

      for (const id of chosen) {
        const t = typeOf(id);
        if (t === 'WeaponSkill') push(active, id, { source: p.key, chosen: true });
        else if (t === 'WeaponPassive') pushTriggered(id, p.key);
        else if (p.mechanic) pushTriggered(id, p.key, { mechanic: p.mechanic, sharedWith: chosen.length });
      }
      for (const id of subSkillsFor(chosen, all)) push(active, id, { source: p.key, followUp: true });
      for (const id of orphanSubSkills(all, chosen)) {
        const prof = combat.profile(id, rank, runes);
        if (prof?.effects.some((e) => e.kind === 'Damage')) {
          unmodelled.push({ id, why: 'a WeaponSubSkill with no discoverable trigger' });
        }
      }
    }

    // 3. Class skills that are not part of a chosen pool: always available.
    const unit = cdb.byId('unit').get(loadout.class);
    for (const s of unit?.skills ?? []) {
      const id = s.skill ?? s.ref;
      if (!id || seen.has(id)) continue;
      const t = typeOf(id);
      if (MECHANIC_TYPES[t]) continue;            // handled by its pool
      if (INERT_TYPES.has(t)) continue;
      if (ACTIVE_TYPES.has(t)) push(active, id, { source: 'class' });
      else pushTriggered(id, 'class');
    }

    // 4. Skills granted by anything else worn: enchants, sigils, trinkets.
    for (const slot of cat.combatSlots()) {
      const g = loadout.gear[slot.id];
      if (!g?.item) continue;
      const item = cat.itemById.get(g.item);
      for (const id of item?.skills ?? []) {
        if (seen.has(id)) continue;
        const t = typeOf(id);
        if (FILLER_TYPES.has(t) || t === 'WeaponSkill' || t === 'WeaponPassive' || t === 'WeaponSubSkill') continue;
        if (INERT_TYPES.has(t)) continue;
        if (ACTIVE_TYPES.has(t)) push(active, id, { source: slot.id });
        else pushTriggered(id, slot.id);
      }
      // The itemType's shared moves (each weapon class's block).
      for (const s of cat.inherited(item?.type, (t) => t?.skills) ?? []) {
        const id = s.skill ?? s.ref;
        if (!id || seen.has(id) || INERT_TYPES.has(typeOf(id))) continue;
        pushTriggered(id, slot.id);
      }
    }
    for (const sock of cat.socketsFor ? socketList(loadout) : []) {
      const augId = loadout.augments?.[sock.key];
      const aug = augId ? cat.itemById.get(augId) : null;
      for (const id of aug?.skills ?? []) {
        if (seen.has(id)) continue;
        if (ACTIVE_TYPES.has(typeOf(id))) push(active, id, { source: sock.key });
        else pushTriggered(id, sock.key);
      }
    }

    function socketList(l) {
      const out = [];
      for (const slot of cat.combatSlots()) {
        const g = l.gear[slot.id];
        if (!g?.item) continue;
        const item = cat.itemById.get(g.item);
        if (!item) continue;
        for (const type of cat.socketsFor(item)) out.push({ key: `${slot.id}/${type}`, slot: slot.id, type });
      }
      return out;
    }

    // A triggered skill only earns a throughput slot if we can say how often it
    // fires. One that cannot still counts if it grants a stat - the weapon-class
    // block abilities are +50 BlockMitigation and the weapon enchants are
    // stacking rating buffs - so those go to `passive` instead of being dropped.
    function pushTriggered(id, source, extra = {}) {
      if (seen.has(id)) return;
      const prof = combat.profile(id, rank, runes);
      if (!prof) return;
      seen.add(id);

      const carries = prof.effects.some((e) => ['Damage', 'Heal', 'Shield'].includes(e.kind));
      const ownAffixes = (prof.affixes ?? []).filter((a) => a.target?.attribute);
      const buffs = selfBuffsOf(id);

      if (carries) {
        const rule = triggerRule(id, prof, extra);
        if (rule) { triggered.push({ prof, source, rule, ...extra }); return; }
        unmodelled.push({ id, why: 'declares damage but no trigger rate can be derived from the data' });
        return;
      }
      if (ownAffixes.length || buffs.length) {
        passive.push({ prof, source, affixes: ownAffixes, buffs, ...extra });
        return;
      }
      if (prof.hasScript || prof.effects.length) {
        unmodelled.push({ id, why: 'its payload is a status or script effect, not a declared amount' });
      }
    }

    return { filler, active, triggered, passive, unmodelled, selection: sel, runes: [...runes] };
  }

  /**
   * How often a triggered skill fires, expressed against rates the throughput
   * model already computes. Every rule names the data it rests on; there is no
   * fallback, because a guessed rate is worse than a stated gap.
   */
  function triggerRule(id, prof, extra) {
    const s = skills.get(id);

    // Prayers charge on the combo's final attack (Priest_Rosary's script, and
    // each prayer's own description), and the slotted ones take turns.
    if (extra.mechanic === 'PriestPrayer') {
      return {
        kind: 'per-combo',
        divisor: Math.max(1, extra.sharedWith ?? 1),
        why: 'Priest_Rosary charges a prayer on the combo\'s final attack; slotted prayers cycle',
      };
    }

    // `vars.chance` is the proc rate the data ships, and every script that
    // reads it gates on `hit.isBaseAttack`.
    const chance = s?.vars?.chance;
    if (typeof chance === 'number' && chance > 0) {
      return { kind: 'per-attack', chance, why: `vars.chance = ${chance} on a base-attack proc` };
    }

    return null;
  }

  // --- self-buffs a skill applies to you ------------------------------------
  /**
   * The stat buffs the rotation grants itself. `Enchant_Zealot` is the case
   * that matters: its script does `addStatus(owner, Skill.Enchant_Zealot_Status)`
   * and that status carries `TAttribute_Flat CritChanceRating +6` with
   * `props.status.maxStacks: 5`, so the enchant is worth +30 rating - which is
   * the whole reason to put an enchant on a weapon at all.
   *
   * Modelled AT FULL STACKS: a 15-second buff refreshed by a 30%-per-attack
   * proc sits at its cap during sustained combat. That is an assumption, it is
   * stated in the audit, and it is the reason this returns its own list rather
   * than quietly folding into the sheet.
   */
  const buffCache = new Map();
  function selfBuffsOf(skillId) {
    let hit = buffCache.get(skillId);
    if (hit) return hit;
    hit = [];
    const s = skills.get(skillId);
    if (s?.script) {
      ADD_STATUS.lastIndex = 0;
      for (let m; (m = ADD_STATUS.exec(s.script));) {
        const [, who, statusId] = m;
        if (!SELF_TARGETS.has(who)) continue;      // a debuff on the target
        const st = skills.get(statusId);
        if (!st) continue;
        const types = (st.props?.status?.types ?? []).map((t) => t.type);
        if (types.length && !types.includes('Buff')) continue;
        const affixes = (st.affixes ?? []).filter((a) => a.target?.attribute);
        if (!affixes.length) continue;
        hit.push({
          from: skillId,
          status: statusId,
          name: st.texts?.name ?? statusId,
          stacks: st.props?.status?.maxStacks ?? 1,
          duration: st.duration ?? null,
          affixes,
        });
      }
    }
    buffCache.set(skillId, hit);
    return hit;
  }

  /** Every self-buff the resolved rotation can put up, deduplicated. */
  function selfBuffs(rotation) {
    const seen = new Set();
    const out = [];
    for (const entry of [...rotation.active, ...rotation.triggered, ...rotation.filler, ...(rotation.passive ?? [])]) {
      for (const b of selfBuffsOf(entry.prof.id)) {
        if (seen.has(b.status)) continue;
        seen.add(b.status);
        out.push(b);
      }
    }
    return out;
  }

  return {
    pools, defaultSelection, pruneSelection, resolve, selfBuffs, selfBuffsOf,
    weaponSlotsAt, arsenalSlotsAt, typeOf,
    mechanicTypes: MECHANIC_TYPES,
  };
}
