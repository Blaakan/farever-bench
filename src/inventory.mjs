// ---------------------------------------------------------------------------
// inventory.mjs - turn the modkit's character dumps into a loadout.
//
// The HLX modkit writes two files per character into the game directory:
//
//   farever-inventory-<Name>.json   { character, equipped[], bank[], bags[] }
//   farever-jobs-<Name>.json        { character, jobs[], runes[] }
//
// An entry is `{kind, level, upgrade, rarity, count, class}` where `kind` is the
// CastleDB item id, `upgrade` is the star count, and `rarity` of -1 means the
// item never rolled one and takes its authored rarity.
//
// This is the only path in the bench that produces a build nobody chose: the
// character as actually equipped, which is what a capture recorded and
// therefore the only build a capture can verify against. Everything else -
// `optimize`, `rank`, a questlog URL - describes a build somebody wants.
//
// What the dump does NOT carry is as important as what it does. There is no
// socket or enchant content, no talent selection, and no active consumable, so
// a loadout built from it is the character's GEAR and nothing else. Those gaps
// are named on the returned object rather than silently defaulted, because a
// verify run that quietly assumes empty sockets will read the difference as a
// model error.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { emptyLoadout } from './loadout.mjs';

// A loadout from a capture's own build snapshot, which is strictly better
// evidence than the login-time dump: it was written while the damage rows were
// being written, and it carries the talents the dump has no field for.
//
// The gear list arrives as item ids in equipment order, exactly as the dump's
// does, so slot assignment is shared. What is new is `talents`, which the
// caller can hand to the model, and `attrs` - the hero's live sheet, which is
// what a stat-level disagreement should be checked against rather than
// re-derived.
export function fromSnapshot(cat, snap, { level = null, unit = null } = {}) {
  const dumpish = {
    character: snap.actor,
    inventory: {
      equipped: (snap.gear ?? []).map((g) => ({
        kind: g.kind,
        // `level` is the item's own level, the same number the modkit dump
        // reports - 25 on Emsey's daggers. `ilevel` is a different scale
        // entirely (280 on the same daggers) and feeding it here priced a
        // level-25 build at 9e17 dps. The snapshot carries both; only one of
        // them is what the catalog means by a level.
        level: g.level ?? 0,
        upgrade: g.upgrade ?? 0,
        // The ROLLED rarity, which is emphatically not the authored one - this
        // line used to discard it on the assumption that they agreed.
        // Daggers_Demondash is authored Rare and Emsey's instance is Epic, and
        // that costs twice: Rare's iLevelBonus is 10 against Epic's 30, so the
        // weapon comes out two effective levels light and every stat line on it
        // with it; and Rare permits three upgrades against Epic's four, so a
        // four-star instance silently loses its fourth.
        rarity: g.rarity ?? null,
      })),
    },
    // Runes are not in the snapshot - the class has to come from somewhere, so
    // an explicit --class wins and otherwise the caller supplies the dump's.
    jobs: null,
  };

  const built = toLoadout(cat, dumpish, { level: level ?? snap.level ?? null, unit });

  // A talent id is a `skill` row like any other, so one that does not resolve is
  // not a talent. This is not fussiness: the first probe build could not reach
  // into hxbit's map proxy and reported the proxy's own struct fields, so a
  // capture on disk contains talents named `map`, `obj` and `bit`. Feeding those
  // to the model would be worse than having no talents at all, because the model
  // would look them up, miss, and carry on.
  const talents = [];
  const rejected = [];
  for (const t of snap.talents ?? []) {
    if (t?.id && cat.cdb.has('skill', t.id)) talents.push(t);
    else if (t?.id) rejected.push(t.id);
  }

  built.talents = talents;
  // And into the loadout the engine actually scores. A talent tree node is
  // keyed by its skill id - `Rogue_Talent_VirulentMagic` - which is exactly
  // what the snapshot reports, so this is the whole wiring. Capturing talents
  // and not handing them over would leave them in the MISSING column looking
  // like a coverage hole, which is the opposite of what they now are.
  built.loadout.talents = Object.fromEntries(
    talents.filter((t) => t.rank > 0).map((t) => [t.id, t.rank])
  );
  built.arsenals = snap.arsenals ?? [];
  // The slotted WEAPON skills, when the capture is new enough to carry them
  // (probe v4's snap_wskill). This is the one build fact nothing else records
  // - the dump has only the item, and the arsenal pool makes even the weapon
  // passive a choice - so without it the plan's default selection stands and
  // a companion hook on an unslotted-by-default passive (Gash's) never
  // prices. Only ids the catalog recognises are handed over; the rest are
  // named in gaps like every other unresolvable row.
  if (snap.weaponSkills && Object.keys(snap.weaponSkills).length) {
    built.loadout.skills ??= {};
    for (const [slot, ids] of Object.entries(snap.weaponSkills)) {
      const good = ids.filter((id) => cat.cdb.has('skill', id));
      for (const bad of ids.filter((id) => !cat.cdb.has('skill', id))) rejected.push(bad);
      if (good.length) built.loadout.skills[slot] = good;
    }
  }
  built.attrs = snap.attrs ?? {};
  built.hattrs = snap.hattrs ?? {};
  // UnitAttributes.attributes is keyed by the attribute's POSITION in the cdb
  // sheet, not by name, so it arrives as {63: 1105}. Resolve it.
  //
  // Two things this is not. It is not the full sheet - only 12 of 78 attributes
  // appear, and neither Strength nor CritChance is among them, so it reads as a
  // sparse override map rather than the character's stats. And the named
  // scalars on the same object (snap_attr) are base values: critChance 5 on a
  // geared level-25 hero. Where the live sheet actually lives is still open, so
  // this is carried as a cross-check and never as an input.
  const attrRows = cat.cdb.lines('attribute');
  const sheet = {};
  for (const [k, v] of Object.entries(snap.sheet ?? {})) {
    const i = Number(k);
    const row = Number.isInteger(i) ? attrRows[i] : null;
    sheet[row?.id ?? k] = v;
  }
  built.sheet = sheet;
  built.snapshotTs = snap.ts;
  built.until = snap.until ?? null;

  // Sockets, at last. The snapshot reports the augment in each host's slot
  // list; the loadout keys them `<slot>/<augmentType>`, so the augment's own
  // row says which socket type it occupies and the host says which slot.
  // Anything that does not resolve is named rather than dropped.
  built.affixes = snap.affixes ?? [];
  built.sockets = snap.sockets ?? [];
  // Two of the same item wear two different sockets. Resolving the host slot
  // with a `find` returns the first match every time, so Emsey's second
  // Finger_Z3RCraft_Ap and Emsai's silently handed their jewel to the left
  // ring and the right one went bare - eleven augments placed out of twelve.
  //
  // The snapshot gives each socket a host id and an index within that host, so
  // group by host and hand the nth occurrence of a given index to the nth slot
  // that item occupies.
  const unplacedSockets = [];
  const byHost = new Map();
  for (const sk of built.sockets) {
    if (!byHost.has(sk.host)) byHost.set(sk.host, []);
    byHost.get(sk.host).push(sk);
  }
  for (const [host, list] of byHost) {
    const slots = built.placed.filter((p) => p.item === host).map((p) => p.slot);
    const usedPerIndex = new Map();
    for (const sk of list) {
      const aug = cat.itemById.get(sk.augment);
      const idx = sk.index ?? 0;
      const nth = usedPerIndex.get(idx) ?? 0;
      usedPerIndex.set(idx, nth + 1);
      const hostSlot = slots[nth];
      if (!aug || !hostSlot || !aug.augmentType) {
        unplacedSockets.push(sk.augment);
        continue;
      }
      built.loadout.augments[`${hostSlot}/${aug.augmentType}`] = aug.id;
    }
  }

  built.gaps = [
    unplacedSockets.length
      ? `${unplacedSockets.length} socketed augment(s) could not be placed (${unplacedSockets.slice(0, 3).join(', ')})`
      : null,
    built.sockets.length ? null : 'the snapshot recorded no sockets - either none are slotted or the probe could not reach them',
    talents.length
      ? null
      : 'the snapshot recorded no readable talents - either none are taken or the probe could not reach them',
    rejected.length
      ? `${rejected.length} snapshot row(s) named something that is not a skill (${rejected.slice(0, 4).join(', ')}) - an old probe build reporting proxy internals; re-capture`
      : null,
    built.unusable?.length
      ? `${built.unusable.length} item(s) in the snapshot this class cannot wear (${built.unusable.slice(0, 3).join(', ')}) - the probe read a backpack rather than the equipment; skipped`
      : null,
    ...(snap.errors ?? []).map((e) => `the probe reported it could not read ${e.what}: ${e.why}`),
    'consumables and persistent buffs are still not captured',
  ].filter(Boolean);
  return built;
}

export function inventoryPath(game, character) {
  return join(game, `farever-inventory-${character}.json`);
}
export function jobsPath(game, character) {
  return join(game, `farever-jobs-${character}.json`);
}

// Every character the modkit has dumped in this install.
export function listCharacters(game) {
  const out = [];
  for (const f of readdirSync(game)) {
    const m = /^farever-inventory-(.+)\.json$/.exec(f);
    if (m) out.push(m[1]);
  }
  return out.sort();
}

export function readDump(game, character) {
  const invPath = inventoryPath(game, character);
  if (!existsSync(invPath)) {
    throw new Error(
      `no inventory dump for "${character}" in ${game}.\n` +
      'The HLX modkit writes farever-inventory-<Name>.json on login.'
    );
  }
  const inv = JSON.parse(readFileSync(invPath, 'utf8'));
  const jp = jobsPath(game, character);
  const jobs = existsSync(jp) ? JSON.parse(readFileSync(jp, 'utf8')) : null;
  return { inventory: inv, jobs, character: inv.character ?? character };
}

// Which class a rune list belongs to. Runes are named `<Class>_<Skill>_M<n>`,
// and the generic ones (Momentum, ComboStep, MasterOfShadows) carry no prefix -
// so the class is whatever prefix the class-specific ones agree on. A dump with
// no class-specific rune returns null rather than a guess.
export function classFromRunes(cat, runes = []) {
  const known = new Set(cat.classes.map((c) => c.unit));
  const votes = new Map();
  for (const r of runes) {
    const pre = String(r).split('_')[0];
    if (known.has(pre)) votes.set(pre, (votes.get(pre) ?? 0) + 1);
  }
  if (!votes.size) return null;
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Build a loadout from an equipped list. Items are placed into the first slot
// they are legal for that is still free, in dump order - which is how a second
// dagger reaches the arsenal and a second ring reaches the other finger.
//
// Anything that is not combat gear (a pickaxe, a teleport stone, a bag) has no
// combat slot and is skipped; it is reported in `ignored` rather than dropped
// silently, so a piece the catalog fails to recognise cannot hide there.
export function toLoadout(cat, dump, { level = null, unit = null } = {}) {
  const equipped = dump.inventory?.equipped ?? [];
  const runes = dump.jobs?.runes ?? [];

  const cls = unit ?? classFromRunes(cat, runes);
  if (!cls) {
    throw new Error(
      `cannot tell which class ${dump.character} is from the dump - ` +
      'no class-specific rune in farever-jobs. Pass --class.'
    );
  }

  // The character level is not in either dump. Gear level is the best proxy we
  // have: a character wears their own level's gear, and the highest equipped
  // level is a lower bound that has never been wrong on a played character.
  const lvl = level ?? Math.max(1, ...equipped.map((e) => e.level ?? 0));

  const loadout = emptyLoadout(cat, cls, lvl);
  const slots = cat.combatSlots().map((s) => s.id);
  const taken = new Set();
  const placed = [];
  const ignored = [];
  const unknown = [];

  const clsRow = cat.classes.find((c) => c.unit === cls);
  const unusable = [];

  for (const e of equipped) {
    const item = cat.itemById.get(e.kind);
    if (!item) { unknown.push(e.kind); continue; }
    const legal = (item.slots ?? []).filter((s) => slots.includes(s));
    if (!legal.length) { ignored.push(e.kind); continue; }
    // A build description is not a promise that every item in it is wearable.
    // A capture snapshot can hand over a backpack, and a Rogue's backpack may
    // hold a Wizard staff - which is a thing to skip and name, not a reason to
    // refuse to score the character at all.
    if (clsRow && !cat.usableBy(item, clsRow.aptitude)) { unusable.push(item.id); continue; }
    const free = legal.find((s) => !taken.has(s));
    if (!free) { ignored.push(e.kind); continue; }

    taken.add(free);
    // Rarity arrives two ways. The modkit dump writes an index with -1 for
    // "never rolled one"; a capture snapshot writes the rolled rarity's id
    // ("Epic"). Only the id is usable - it is what the catalog keys on - so a
    // number is treated as the dump's sentinel and dropped, and the item's
    // authored rarity stands in.
    const rolled = typeof e.rarity === 'string' && e.rarity ? e.rarity : null;
    loadout.gear[free] = {
      item: item.id,
      stars: e.upgrade ?? 0,
      ...(rolled ? { rarity: rolled } : {}),
      ...(e.level ? { level: e.level } : {}),
    };
    placed.push({ slot: free, item: item.id, stars: e.upgrade ?? 0 });
  }

  for (const r of runes) loadout.runes[r] = true;

  return {
    loadout,
    character: dump.character,
    unit: cls,
    level: lvl,
    placed,
    ignored,
    unknown,
    unusable,
    // What a capture-verify run must not treat as zero. Each of these is a real
    // input the dump cannot see, and each has been measured to move a headline
    // number, so they are carried to the report rather than assumed away.
    gaps: [
      'sockets and enchants are not in the dump - every socket reads empty',
      'talents are not in the dump - only runes are',
      'consumables and persistent buffs are not in the dump',
      level === null ? `character level assumed ${lvl} from the highest equipped item` : null,
    ].filter(Boolean),
  };
}
