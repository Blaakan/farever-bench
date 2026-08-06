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

  for (const e of equipped) {
    const item = cat.itemById.get(e.kind);
    if (!item) { unknown.push(e.kind); continue; }
    const legal = (item.slots ?? []).filter((s) => slots.includes(s));
    if (!legal.length) { ignored.push(e.kind); continue; }
    const free = legal.find((s) => !taken.has(s));
    if (!free) { ignored.push(e.kind); continue; }

    taken.add(free);
    loadout.gear[free] = {
      item: item.id,
      stars: e.upgrade ?? 0,
      // -1 is the dump's "never rolled one"; the item's authored rarity stands.
      ...(e.rarity !== undefined && e.rarity >= 0 ? { rarity: e.rarity } : {}),
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
