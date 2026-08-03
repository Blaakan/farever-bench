// ---------------------------------------------------------------------------
// questlog.mjs - turn a questlog.gg character-builder link into bench pins.
//
// questlog.gg stores a build as the game's own ids. Its tRPC endpoints hand
// back `"mainHand":{"id":"GS_Nova",...}` and `"Warrior_Talent_Sever":{"rank":1}`
// - the same strings `data.cdb` uses - so this is a renaming job, not a
// matching one, and every id either resolves against the catalog or is
// reported. Nothing is guessed.
//
// Two endpoints hold a build:
//
//   characterBuilder.getCharacter?input={"slug":"<url slug>"}
//     -> character.classId, and builds[] with .level, .equipment, .talentBuildId
//   talentBuilder.getTalentBuilderBySlug?input={"slug":"<author slug>"}
//     -> builds[], one of which has the id talentBuildId names; that one
//        carries .talents and .runes
//
// The split matters: talent pages are shared between characters, so the
// equipment call alone cannot tell you the allocation.
//
// Four things questlog records that the bench cannot take, all reported rather
// than dropped: the cosmetic slots (mount, glider, sickle, jobTool, pickaxe),
// which have no combat slot; per-skill arsenal ranks, against the bench's one
// global `--rank`; runes on skills the build does not offer a slot for; and the
// class-skill bar, which questlog does not store at all.
// ---------------------------------------------------------------------------

// questlog's equipment key -> the bench's combat slot. Everything not named
// here is cosmetic or a gathering tool and has no combat slot at all.
export const SLOT_MAP = new Map([
  ['mainHand', 'Slot_Weapon1'],
  ['secondaryWeapon', 'Slot_Weapon2'],
  ['offHand', 'Slot_OffhandWeapon'],
  ['head', 'Slot_Head'],
  ['neck', 'Slot_Neck'],
  ['shoulders', 'Slot_Shoulders'],
  ['chest', 'Slot_Chest'],
  ['back', 'Slot_Back'],
  ['hands', 'Slot_Hands'],
  ['waist', 'Slot_Waist'],
  ['legs', 'Slot_Legs'],
  ['feet', 'Slot_Feet'],
  ['finger1', 'Slot_FingerLeft'],
  ['finger2', 'Slot_FingerRight'],
  ['trinket', 'Slot_Trinket'],
]);

// Recorded so an occupied one is reported instead of silently vanishing.
export const COSMETIC_KEYS = new Set(['mount', 'glider', 'sickle', 'jobTool', 'pickaxe']);

export const API = 'https://questlog.gg/farever/api/trpc';

export function endpoints(slug, authorSlug = null) {
  const q = (proc, input) => `${API}/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
  return {
    character: q('characterBuilder.getCharacter', { slug }),
    talents: authorSlug ? q('talentBuilder.getTalentBuilderBySlug', { slug: authorSlug }) : null,
  };
}

// A questlog URL is .../character-builder/<slug>, and a bare slug is accepted
// too so the tool can be pointed at either.
export function slugOf(input) {
  const s = String(input).trim();
  const m = /character-builder\/([^/?#]+)/.exec(s);
  if (m) return decodeURIComponent(m[1]);
  if (/^https?:/i.test(s)) throw new Error(`not a questlog character-builder URL: ${s}`);
  return s;
}

// Pull the two tRPC payloads down to the flat shape `translate` reads. Kept
// separate so a fixture can be checked in without a network call.
export function normalize(characterPayload, talentPayload, { buildIndex = 0 } = {}) {
  const data = characterPayload?.result?.data;
  if (!data?.character) throw new Error('character payload has no .result.data.character');
  const builds = data.builds ?? [];
  if (!builds.length) throw new Error(`"${data.character.name}" has no builds`);
  if (buildIndex >= builds.length) {
    throw new Error(`build ${buildIndex} asked for, but this character has ` +
      `${builds.length} (numbered from 0)`);
  }
  const build = builds[buildIndex];

  // The talent page is optional: a character can be saved with no allocation.
  let talents = {}; let runes = {}; let talentName = null;
  if (build.talentBuildId != null && talentPayload) {
    const found = (talentPayload?.result?.data?.builds ?? [])
      .find((b) => b.id === build.talentBuildId);
    if (!found) {
      throw new Error(`talent build ${build.talentBuildId} is not on the author's talent page ` +
        '(it may be private)');
    }
    talents = found.talents ?? {};
    runes = found.runes ?? {};
    talentName = found.name ?? null;
  }

  return {
    name: data.character.name,
    author: data.character.user?.name ?? null,
    authorSlug: data.character.user?.slug ?? null,
    classId: data.character.classId,
    desc: data.character.desc ?? '',
    buildCount: builds.length,
    level: build.level,
    equipment: build.equipment ?? {},
    talentName,
    talents,
    runes,
  };
}

// ---------------------------------------------------------------------------
// The translation itself.
//
// Returns { pins, notes, warnings, ... }. `warnings` is everything questlog
// said that the bench cannot carry; it is never empty on a real build, because
// the class-skill bar always lands there.
// ---------------------------------------------------------------------------
export function translate(build, engine) {
  const { cat } = engine;
  const warnings = [];
  const notes = [];
  const pins = [];

  const cls = cat.classes.find(
    (c) => c.aptitude.toLowerCase() === String(build.classId).toLowerCase()
        || c.unit.toLowerCase() === String(build.classId).toLowerCase());
  if (!cls) {
    throw new Error(`questlog class "${build.classId}" matches no aptitude. ` +
      `Known: ${cat.classes.map((c) => c.aptitude).join(', ')}`);
  }

  const rarities = cat.cdb.lines('rarity').map((r) => r.id);
  const slotShort = (id) => id.replace(/^Slot_/, '').toLowerCase();
  const weaponSlots = new Set(['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']);

  // Which socket a given augment goes in is derived, not tabulated: intersect
  // the sockets the host item actually has with the socket types that list this
  // augment as a candidate. Exactly one survivor is the answer; anything else
  // is reported rather than picked.
  const socketFor = (host, augId) => {
    const hosted = new Set(cat.socketsFor(host));
    const hits = cat.augmentTypes
      .filter((t) => hosted.has(t.id))
      .filter((t) => cat.augmentCandidates(t.id).some((a) => a.id === augId));
    return hits.length === 1 ? hits[0].id : null;
  };

  for (const [key, entry] of Object.entries(build.equipment ?? {})) {
    const itemId = entry?.id;
    if (COSMETIC_KEYS.has(key)) {
      if (itemId) warnings.push(`${key} holds ${itemId}: no combat slot exists for it, dropped`);
      continue;
    }
    const slot = SLOT_MAP.get(key);
    if (!slot) {
      if (itemId) warnings.push(`unknown questlog slot "${key}" holds ${itemId}, dropped`);
      continue;
    }
    if (!itemId) { pins.push({ slot, arg: `${slotShort(slot)}=none`, empty: true }); continue; }

    const item = cat.itemById.get(itemId);
    if (!item) { warnings.push(`${key}: no item "${itemId}" in the catalog, dropped`); continue; }
    if (!item.slots.includes(slot)) {
      warnings.push(`${key}: ${itemId} does not fit ${slot} (it fits ${item.slots.join(', ')}), dropped`);
      continue;
    }

    // gradeOverride indexes the rarity ladder from 1. Left null the item keeps
    // the rarity the CDB authors it at, which is also what the bench does for
    // gear - but a weapon rolls its rarity, so its authored value is spelled
    // out rather than left to the drop model.
    let rarity = null;
    if (entry.gradeOverride != null) {
      rarity = rarities[entry.gradeOverride - 1];
      if (!rarity) {
        warnings.push(`${key}: gradeOverride ${entry.gradeOverride} is outside the rarity ladder, ignored`);
      }
    }
    if (!rarity && weaponSlots.has(slot)) rarity = item.rarity;

    let spec = itemId;
    if (entry.level != null) spec += `^${entry.level}`;
    if (rarity) spec += `@${rarity}`;
    if (weaponSlots.has(slot) || entry.upgradeLevel) spec += `*${entry.upgradeLevel ?? 0}`;

    // Craft jewellery names several generic aptitudes and pays one. questlog
    // records no such choice, so if the catalog offers one the bench's default
    // is taken and the fact is reported.
    const generics = cat.genericChoices(item);
    if (generics.length > 1) {
      notes.push(`${slotShort(slot)}: ${itemId} pays one of ${generics.join(', ')}; ` +
        `questlog does not record which, so the bench takes ${generics[0]}`);
    }

    pins.push({ slot, arg: `${slotShort(slot)}=${spec}`, item: itemId, name: item.name });

    for (const [field, aug] of [['enchant', entry.enchant], ['corruptedGift', entry.corruptedGift]]) {
      const augId = aug?.id;
      if (!augId) continue;
      if (!cat.itemById.get(augId)) {
        warnings.push(`${key}: no augment "${augId}" in the catalog, dropped`);
        continue;
      }
      const type = socketFor(item, augId);
      if (!type) {
        warnings.push(`${key}: ${augId} (${field}) fits no single socket on ${itemId}, dropped`);
        continue;
      }
      pins.push({
        slot, socket: type, augment: augId,
        arg: `${slotShort(slot)}/${type}=${augId}`,
        name: cat.itemById.get(augId).name,
      });
    }

    // The arsenal weapon offers three skills and slots two; the mainhand grants
    // all of them, which is why questlog only records a choice on the second.
    if (Array.isArray(entry.arsenalSkills) && entry.arsenalSkills.length) {
      const ids = entry.arsenalSkills.map((s) => s.id);
      pins.push({ slot, skills: ids, arg: `${slotShort(slot)}=${ids.join(',')}`, isSkills: true });
      const ranks = [...new Set(entry.arsenalSkills.map((s) => s.rank))];
      if (ranks.length > 1) {
        warnings.push(`${key}: arsenal skills are at different ranks (` +
          entry.arsenalSkills.map((s) => `${s.id}=${s.rank}`).join(', ') +
          '); the bench has one global --rank, so no rank is emitted');
      } else if (ranks.length === 1) {
        notes.push(`${key}: every arsenal skill is rank ${ranks[0]}; add --rank ${ranks[0]} ` +
          'to match it (the bench defaults to a fully mastered weapon)');
      }
    }
  }

  // Talents. Every id is checked against the tree so a renamed node is caught
  // here rather than by the CLI's resolver.
  const tree = engine.talents.treeFor(cls.unit);
  const talentPins = [];
  for (const [node, v] of Object.entries(build.talents ?? {})) {
    if (!tree.byId.has(node)) {
      warnings.push(`talent "${node}" is not in the ${cls.unit} tree, dropped`);
      continue;
    }
    const rank = typeof v === 'number' ? v : v?.rank;
    if (!Number.isFinite(rank) || rank < 1) {
      warnings.push(`talent "${node}" has no readable rank, dropped`);
      continue;
    }
    talentPins.push({ node, rank, arg: `${node}=${rank}` });
  }

  // Runes are per skill, and a skill only offers a slot when the build reaches
  // it. Pools are taken from the assembled loadout so the ones that cannot be
  // placed are named instead of failing the command later.
  const loadout = {
    class: cls.unit, level: build.level, gear: {}, augments: {},
    skills: {}, runes: {}, talents: {},
  };
  for (const p of pins) {
    if (p.isSkills || p.socket || p.empty) continue;
    loadout.gear[p.slot] = { item: p.item, stars: 0 };
  }
  for (const t of talentPins) loadout.talents[t.node] = t.rank;
  const pools = new Map(engine.talents.runePools(loadout).map((p) => [p.skill, p]));
  const runePins = [];
  for (const [skill, rune] of Object.entries(build.runes ?? {})) {
    const pool = pools.get(skill);
    if (!pool) {
      // questlog lets a rune be set on any skill of the class, level or not, so
      // the usual cause is a skill this character has not learned yet - the
      // Warrior's Burst of Anger unlocks at 30 and a level-25 reference build
      // still carries a rune for it.
      warnings.push(`rune ${rune} is on ${skill}, which offers no rune slot at level ` +
        `${build.level} - either not learned yet, or nothing equipped grants it; dropped`);
      continue;
    }
    if (!pool.options.some((o) => o.id === rune)) {
      warnings.push(`${rune} is not one of ${skill}'s runes (${pool.options.map((o) => o.id).join(', ')}), dropped`);
      continue;
    }
    runePins.push({ skill, rune, arg: `${skill}=${rune}` });
  }

  warnings.push('questlog does not store which class skills are on the bar, ' +
    'so the bench still searches that choice');

  return {
    class: cls.unit, level: build.level, name: build.name,
    pins, talentPins, runePins, notes, warnings,
  };
}

// The command line itself. `verb` is any bench subcommand that takes pins -
// `optimize` to let it fill what questlog does not record, `sheet` to just
// print the stat sheet this exact build produces.
export function commandLine(result, { verb = 'optimize', extra = [] } = {}) {
  const argv = ['bench', verb, '--class', result.class, '--level', String(result.level)];
  for (const p of result.pins) {
    argv.push(p.isSkills ? '--skills' : '--pin', p.arg);
  }
  for (const t of result.talentPins) argv.push('--talent', t.arg);
  for (const r of result.runePins) argv.push('--rune', r.arg);
  argv.push(...extra);
  return argv;
}
