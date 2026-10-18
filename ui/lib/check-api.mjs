#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-api.mjs - self-test for the UI server against the real game data.
//
// Boots startServer on an ephemeral port and asserts the API contract with
// plain fetch: bootstrap counts, the Mage-25 catalog, the naked-Mage sheet
// values from the verified reference (sheet-engine §9), the Censer Rare 3*
// tooltip bake worked example, the illegal-offhand sentence, and one real
// optimize run whose envelope must round-trip through `bench sheet --build`.
//
// While ui/icons.mjs is still being built (it lands in parallel), everything
// icon- and atlas-derived is a WARN rather than a FAIL - the engine-side
// numbers have to pass regardless. Runs standalone: node ui/lib/check-api.mjs
//
// The blocks added for the September 30 update assert RELATIONSHIPS read off
// the install's own rows (the cdb is loaded here beside the server for that),
// not literals a balance patch moves: which rows may offer a rarity spread,
// what a link, a percentage or a set bonus must print given the row that
// authors it, which rank a talent's status is read at. Each sweep also checks
// that it found something to assert on, so none of them can pass by matching
// nothing.
//
// The INFUSION blocks and the WITHHOLDING blocks hold the server against two
// witnesses. The catalog's own readers (an engine built here, beside the
// server) say which rows the install hands out and which pieces carry what;
// the server has to pass that on, with the reason, on every surface - and its
// surfaces have to agree with each other: the bonus an item tooltip prints is
// the rating the sheet moves by, the rank a skill tooltip lights is the rank
// the sheet attaches, the infusions a search says it offered are the ones the
// envelope records.
// ---------------------------------------------------------------------------

import { tmpdir } from 'node:os';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { loadCdb } from '../../src/cdb.mjs';
import { header } from '../../src/format.mjs';
import { createEngine } from '../../src/engine.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRATCH = join(tmpdir(), 'farever-bench-checks');
// The server this boots decodes icons into a disk cache, and a self-test does
// not get to fill (or trust) the repo's own - it uses one beside its other
// scratch files unless the caller already named one.
process.env.FAREVER_BENCH_CACHE ??= join(SCRATCH, 'check-api-cache');

// The icon service, real or stubbed - the stub keeps this script (not the
// repo) honest about which assertions can only be advisory today.
const iconsPath = join(ROOT, 'ui', 'icons.mjs');
const iconsLive = existsSync(iconsPath);
const stubUrl = 'data:text/javascript,' + encodeURIComponent(
  'export async function createIconService() {'
  + ' return { iconRef: () => null, atlasFor: () => null,'
  + ' handle: () => false, close() {} }; }');
const { createIconService } = await import(
  iconsLive ? pathToFileURL(iconsPath).href : stubUrl);
void createIconService; // surface parity is the point; the server loads its own

let failed = 0;
let warned = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}
// An icon/atlas-derived assertion: FAIL when icons.mjs is live, WARN before.
function checkIcons(name, ok, detail = '') {
  if (iconsLive || ok) { check(name, ok, detail); return; }
  console.log(`WARN  ${name}  (icons.mjs not built yet${detail ? `; ${detail}` : ''})`);
  warned++;
}

const { startServer } = await import(pathToFileURL(join(ROOT, 'ui', 'server.mjs')).href);
const { port, close } = await startServer({ benchRoot: ROOT, port: 0 });
const base = `http://127.0.0.1:${port}`;
console.log(`server on ${base} (icons.mjs ${iconsLive ? 'live' : 'stubbed'})`);

const api = async (path, body) => {
  const res = await fetch(base + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
};

// The install's own rows, for the relationship checks; and a few helpers
// they share.
const cdb = loadCdb({ game: null, quiet: true });
const skillType = (row) => cdb.enumName('skill', 'type', row?.type);
const attrName = (id) => cdb.byId('attribute').get(id)?.name || id;
const p2 = (v) => String(Math.round(v * 100) / 100);   // two decimals, trimmed
const TOKEN = /::(-?)(ref(\d*)_)?([a-zA-Z]+)(\d*)(%?)(#?)::/g;
const LINK = /\[([!;A-Za-z0-9][A-Za-z0-9_]+)(-([A-Za-z0-9_]+))?\]([A-Za-z]*)/g;
const pngDims = async (url) => {
  const res = await fetch(base + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const png = res.status === 200 && buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47;
  return { status: res.status, dims: png ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null };
};
const bare = (cls, gear = {}, more = {}) => ({
  class: cls, level: MAX_LEVEL, gear, augments: {}, skills: {}, runes: {}, talents: {}, ...more,
});
// The catalog's readers, as a witness beside the server: what hands a row out
// (`release`), the level every copy of it is made at (`minInstanceLevel`), and
// where an infusion's pattern comes from (`infusionSource`).
const witness = createEngine({ quiet: true });
// $HInfusion.canBeInfused@21689, straight off the rows and not through the
// catalog: the itemType chain reaches Armor, the row's rarity is at least the
// constant's, and it has a faction origin.
const typeChain = (type) => {
  const out = [];
  for (let t = cdb.byId('itemType').get(type), n = 0; t && n < 16; t = cdb.byId('itemType').get(t.inherit), n++) out.push(t.id);
  return out;
};
const rarityAt = (id) => cdb.lines('rarity').findIndex((r) => r.id === id);
const originOf = (itemId) => { const it = cdb.byId('item').get(itemId); return it?.props?.factionOrigin ?? it?.faction ?? null; };
const gameInfusable = (itemId) => {
  const it = cdb.byId('item').get(itemId);
  return !!it && typeChain(it.type).includes('Armor')
    && rarityAt(it.rarity) >= rarityAt(cdb.constant('Item_InfusionMinRarity')?.other?.rarity)
    && originOf(itemId) != null;
};
const factionNameOf = (id) => cdb.byId('faction').get(id)?.texts?.name || id;
const textEntry = (row, entry) => cdb.byId('text').get(row)?.value?.group?.find((g) => g.id === entry)?.value?.text;
const sheetAttr = (s, id) => s.attributes?.find((a) => a.id === id)?.value;
// Every infusion, straight off the pattern ITEMS ($HInfusion.tryFetchPatterns@21683
// keys them by the skill each names) with the source reader's verdict on the
// pattern - the INPUTS of the infusion checks below, so none of them takes the
// server's word for what to ask it. The same goes for which piece can be
// infused (`gameInfusable`), its faction (`originOf`) and what it can roll.
const infusionDefs = cdb.lines('item').filter((it) => it.type === 'InfusionPattern').map((p) => ({
  id: p.props?.ref?.skill,
  name: cdb.byId('skill').get(p.props?.ref?.skill)?.texts?.name,
  faction: p.faction,
  factionName: factionNameOf(p.faction),
  source: witness.cat.infusionSource(p.props?.ref?.skill),
}));
for (const d of infusionDefs) d.obtainable = d.source?.state !== 'unreleased';
const CAPS = cdb.constantFloats('Item_InfusionCaps');
const poolOf = (itemId) => witness.cat.infusionBonusPool(witness.cat.itemById.get(itemId));
// The ratings a bonus line can be at all: the rows of the aptitude the game
// prices it from (st.item.Gear.getInfusionBonusAffix@9767 ops 11-29 keep the
// InfusionBonus rows whose endAtb is the rolled stat, and nothing else).
const BONUS_RATINGS = [...new Set((cdb.byId('aptitude').get('InfusionBonus')?.atbScaling ?? []).map((e) => e.endAtb))];

// One optimize job, start to terminal event, over the same SSE stream the
// page reads.
async function runJob(body, limitMs = 120000) {
  const { status, data: start } = await api('/api/optimize/start', body);
  if (status !== 200) return { start, status, events: [], done: null, elapsed: 0 };
  const events = [];
  const t0 = Date.now();
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), limitMs);
  let done = null;
  try {
    const res = await fetch(`${base}/api/optimize/events?job=${start.job}`, { signal: ctl.signal });
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const ev = /^event: (\S+)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (!ev) continue; // heartbeat comment
        events.push({ event: ev, data: data ? JSON.parse(data) : null });
        if (ev === 'done' || ev === 'error') { done = events.at(-1); ctl.abort(); }
      }
      if (done) break;
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  clearTimeout(timeout);
  return { start, status, events, done, elapsed: (Date.now() - t0) / 1000 };
}

let MAX_LEVEL;   // bootstrap.constants.maxLevel, set first thing below

try {
  const boot = (await api('/api/bootstrap')).data;
  MAX_LEVEL = boot.constants.maxLevel;

  // --- bootstrap ------------------------------------------------------------
  {
    const { status, data: b } = await api('/api/bootstrap');
    check('bootstrap responds', status === 200, `HTTP ${status}`);
    check('bootstrap: 4 classes', b.classes?.length === 4,
      b.classes?.map((c) => c.unit).join(','));
    check('bootstrap: 5 rarities with colors',
      b.rarities?.length === 5 && b.rarities.every((r) => /^#[0-9a-f]{6}$/.test(r.color)),
      b.rarities?.map((r) => `${r.id}=${r.color}`).join(' '));
    check('bootstrap: rarity stars ladder',
      JSON.stringify(b.rarities?.map((r) => r.stars)) === '[0,2,3,4,5]',
      JSON.stringify(b.rarities?.map((r) => r.stars)));
    const mage = b.talents?.Mage;
    check('bootstrap: Mage tree has 22 nodes', mage?.nodes?.length === 22,
      String(mage?.nodes?.length));
    check('bootstrap: displayCost [0,0,1,3,7]',
      JSON.stringify(mage?.displayCost) === '[0,0,1,3,7]',
      JSON.stringify(mage?.displayCost));
    checkIcons('bootstrap: talent nodes carry icons',
      !!mage?.nodes?.length && mage.nodes.every((n) => n.icon),
      `${mage?.nodes?.filter((n) => n.icon).length}/22 with icons`);
    check('bootstrap: talent descs fill', mage?.nodes?.every((n) => n.desc?.length > 0)
      && !mage.nodes.some((n) => /::/.test(n.desc)),
      mage?.nodes?.[0]?.desc?.slice(0, 60));
    check('bootstrap: runes cover 28 skills', Object.keys(b.runes ?? {}).length === 28,
      String(Object.keys(b.runes ?? {}).length));
    check('bootstrap: augments have 8 socket types',
      Object.keys(b.augments ?? {}).length === 8,
      Object.keys(b.augments ?? {}).join(','));
    check('bootstrap: sigils are class-gated',
      (b.augments?.AugmentDemonSigil ?? []).every((a) => a.classGate)
      && b.augments?.AugmentDemonSigil?.length === 12,
      b.augments?.AugmentDemonSigil?.map((a) => a.classGate).join(','));
  }

  // --- bootstrap: the build notice, the sigils, the icons it hands out ------
  {
    const b = boot;
    // The notice is the CLI's own sentence, set exactly when this install is
    // not the build the model was accepted on - checked against what `header`
    // prints for the same meta, so the page and the terminal cannot come to
    // say two different things.
    const acc = b.meta?.accepted ?? null;
    const cli = header({ meta: b.meta }, 'x').replace(/\x1b\[[0-9;]*m/g, '');
    check('bootstrap: meta.notice is set exactly when the install is not the accepted build',
      acc && !acc.same
        ? typeof b.meta.notice === 'string' && b.meta.notice.includes(String(acc.at).slice(0, 10))
        : b.meta?.notice === null,
      `accepted ${JSON.stringify(acc)} -> ${JSON.stringify(b.meta?.notice)}`);
    check('bootstrap: and it is word for word the line the CLI prints under its header',
      b.meta?.notice == null ? !/not the build/.test(cli) : cli.includes(b.meta.notice),
      cli.split('\n').pop());

    // A sigil says which talent it grants: the item's own skill, which is a
    // node of its class's tree - and the sentence names it. All twelve rows
    // share one name, so without `grants` no two could be told apart.
    const sigils = b.augments?.AugmentDemonSigil ?? [];
    const wrong = sigils.filter((a) => {
      const node = b.talents?.[a.classGate]?.nodes?.find((n) => n.id === a.grants?.id);
      const carried = (cdb.byId('item').get(a.id)?.skills ?? []).map((s) => s.skill);
      return !(node && a.grants.name === node.name && carried.includes(node.id)
        && typeof a.effect === 'string' && a.effect.includes(node.name));
    });
    check(`bootstrap: each of the ${sigils.length} sigils names the talent its skill is, in grants and in its effect line`,
      sigils.length > 0 && wrong.length === 0,
      wrong.length ? wrong.map((a) => `${a.id}:${JSON.stringify(a.grants)}:"${a.effect}"`).join(' | ')
        : sigils[0]?.effect);
    check('bootstrap: no two sigils grant the same talent',
      new Set(sigils.map((a) => a.grants?.id)).size === sigils.length,
      sigils.map((a) => a.grants?.id).join(','));
    const mute = Object.values(b.augments ?? {}).flat().filter((a) => !a.effect);
    check('bootstrap: no augment is left without an effect line', mute.length === 0,
      mute.map((a) => a.id).join(','));

    // The icons, fetched. A skill or attribute cell is served AT ITS OWN SIZE
    // (a tile of a sheet) or as the 64px mip of a portrait it covers - never
    // as the sheet it sits on, which is what every one of these was when the
    // 96px atlases became BC7: 120x120 for a skill, 98x14 for a stat.
    const cells = [];
    for (const id of Object.keys(b.runes ?? {})) {
      cells.push([`skill ${id}`, b.runes[id].skillIcon, cdb.byId('skill').get(id)?.gfx]);
    }
    for (const [id, a] of Object.entries(b.attributes ?? {})) {
      cells.push([`attribute ${id}`, a.icon, cdb.byId('attribute').get(id)?.gfx]);
    }
    const off = [];
    let fetched = 0;
    for (const [what, ref, gfx] of cells) {
      if (ref?.kind !== 'dds' || !gfx) continue;
      const size = gfx.size ?? 1;
      const cell = [(gfx.width ?? 1) * size, (gfx.height ?? 1) * size];
      const { status, dims } = await pngDims(ref.url);
      fetched++;
      const ok = dims && ((dims[0] === cell[0] && dims[1] === cell[1])
        || (/[?&]px=64\b/.test(ref.url) && dims[0] === 64 && dims[1] === 64));
      if (!ok) off.push(`${what}: ${status} ${dims ? dims.join('x') : 'not a PNG'} for a ${cell.join('x')} cell`);
    }
    checkIcons(`bootstrap: every DDS skill and attribute icon is served as its own cell (${fetched} fetched)`,
      off.length === 0, off.slice(0, 3).join(' | '));
  }

  // --- bootstrap: the infusions, and whether anything hands each one out -----
  {
    // One entry per InfusionPattern ITEM, keyed by the skill the pattern names
    // ($HInfusion.tryFetchPatterns@21683) - named off the skill row, and of
    // the PATTERN's faction ($HInfusion.getInfusionFaction@21693), under the
    // name the faction row prints. An id is not a name here: the three
    // `Infusion_Nightling_*` are of faction `Demon`, "Nightlings".
    const patterns = cdb.lines('item').filter((it) => it.type === 'InfusionPattern');
    const byId = new Map((boot.infusions ?? []).map((x) => [x.id, x]));
    const off = [];
    for (const p of patterns) {
      const id = p.props?.ref?.skill;
      const got = byId.get(id);
      const want = { name: cdb.byId('skill').get(id)?.texts?.name, faction: p.faction, factionName: factionNameOf(p.faction) };
      if (!got || got.name !== want.name || got.faction !== want.faction || got.factionName !== want.factionName) {
        off.push(`${id}: ${JSON.stringify(got && { name: got.name, faction: got.faction, factionName: got.factionName })} wants ${JSON.stringify(want)}`);
      }
    }
    const renamed = patterns.filter((p) => factionNameOf(p.faction) !== p.faction).length;
    check(`bootstrap: one infusion per pattern item, named off its skill row and its pattern's faction row (${patterns.length} patterns, ${renamed} whose faction name is not the faction id)`,
      patterns.length > 0 && boot.infusions?.length === patterns.length && off.length === 0 && renamed > 0,
      off.slice(0, 3).join(' | '));

    // Whether one can be LEARNED is the catalog's source reader's answer about
    // its pattern, passed on with the reader's sentence - never judged here.
    // `obtainable` is the search's default: offered unless shown unobtainable.
    const apart = [];
    for (const x of boot.infusions ?? []) {
      const w = witness.cat.infusionSource(x.id);
      if (x.source?.state !== w.state || x.source?.why !== w.why || x.obtainable !== (w.state !== 'unreleased')
        || !(typeof x.source?.why === 'string' && x.source.why.length > 10)) {
        apart.push(`${x.id}: ${JSON.stringify(x.source)} obtainable ${x.obtainable} vs ${JSON.stringify(w)}`);
      }
    }
    const shut = (boot.infusions ?? []).filter((x) => !x.obtainable);
    check(`bootstrap: each infusion carries the source reader's verdict and sentence (${boot.infusions?.length - shut.length} obtainable, ${shut.length} not)`,
      apart.length === 0 && shut.length < (boot.infusions?.length ?? 0),
      apart.slice(0, 2).join(' | ') || shut.map((x) => `${x.name}: ${x.source.why}`).slice(0, 1).join(''));

    const inf = boot.constants?.infusion;
    const bonusRatings = [...new Set((cdb.byId('aptitude').get('InfusionBonus')?.atbScaling ?? []).map((e) => e.endAtb))];
    check('bootstrap: the set caps, the minimum rarity and the bonus ratings are the constants\' and the InfusionBonus rows\'',
      JSON.stringify(inf?.caps) === JSON.stringify(cdb.constantFloats('Item_InfusionCaps'))
      && inf?.minRarity === cdb.constant('Item_InfusionMinRarity')?.other?.rarity
      && bonusRatings.length > 0 && JSON.stringify(inf?.stats?.map((s) => s.id)) === JSON.stringify(bonusRatings)
      && inf.stats.every((s) => s.name === attrName(s.id)),
      JSON.stringify(inf));
  }

  // --- catalog --------------------------------------------------------------
  {
    const { data: c } = await api('/api/catalog?class=Mage&level=25');
    const w1 = c.slots?.Slot_Weapon1 ?? [];
    check('catalog: Slot_Weapon1 has 14 items', w1.length === 14, String(w1.length));
    const censer = w1.find((i) => i.id === 'Staff_Censer');
    check('catalog: Censer rarities Rare/Epic/Legendary',
      JSON.stringify(censer?.rarities?.map((r) => r.id)) === '["Rare","Epic","Legendary"]',
      JSON.stringify(censer?.rarities?.map((r) => r.id)));
    check('catalog: Censer maxStars 3/4/5',
      JSON.stringify(censer?.rarities?.map((r) => r.maxStars)) === '[3,4,5]',
      JSON.stringify(censer?.rarities?.map((r) => r.maxStars)));
    checkIcons('catalog: an item carries acquire text',
      w1.some((i) => typeof i.acquire === 'string' && i.acquire.length > 0),
      censer?.acquire?.slice(0, 50) ?? 'none');
  }

  // --- catalog: who may offer a rarity spread, and the order of a list ------
  {
    // The drop rolls a rarity for a WEAPON and for nothing else, so a row in
    // one of the twelve doll slots is exactly the rarity its row authors: one
    // entry, flagged authored, with no chance to print. Before this was
    // guarded an Uncommon helmet offered "Rare 50% / Epic 19%" and the picker
    // painted every armour row with the best of them.
    const rarityRank = new Map(boot.rarities.map((r, i) => [r.id, i]));
    const WEAPON_SLOTS = new Set(['Slot_Weapon1', 'Slot_Weapon2', 'Slot_OffhandWeapon']);
    const phantom = [], unsorted = [], noRange = [], offKey = [];
    const noLevel = { rows: 0, crafted: 0, off: [] };
    let gearRows = 0, weaponRows = 0, spreads = 0, pricedLow = 0;
    let mageHeads = null;
    // The level the server PRICES a row at when the request names no instance
    // level - asked of /api/tooltip/item rather than read back off the catalog
    // row, so the order is held against what a tile would actually be worth:
    // the item level it answers, less the rarity's own bonus, at zero stars.
    const rarityBonus = new Map(boot.rarities.map((r) => [r.id, r.iLevelBonus]));
    const pricedAt = async (cls, slot, id) => {
      const { data: t } = await api('/api/tooltip/item', {
        class: cls, charLevel: MAX_LEVEL, item: id, slot, stars: 0,
      });
      return (t.iLevel - (rarityBonus.get(t.rarityId) ?? 0)) / 10;
    };
    for (const cls of boot.classes.map((c) => c.unit)) {
      const { data: c } = await api(`/api/catalog?class=${cls}&level=${MAX_LEVEL}`);
      if (cls === 'Mage') mageHeads = c.slots.Slot_Head;
      for (const [slot, rows] of Object.entries(c.slots ?? {})) {
        for (const r of rows) {
          const authored = cdb.byId('item').get(r.id)?.rarity;
          const first = r.rarities?.[0];
          if (WEAPON_SLOTS.has(slot)) {
            weaponRows++;
            if (r.rarities.length > 1) spreads++;
            if (!(first?.authored && first.id === authored)) phantom.push(`${cls} ${slot} ${r.id}`);
          } else {
            gearRows++;
            if (!(r.rarities?.length === 1 && first.authored === true
              && first.id === authored && first.chance === null)) {
              phantom.push(`${cls} ${slot} ${r.id}: ${JSON.stringify(r.rarities)}`);
            }
          }
          if (!(Array.isArray(r.levelRange) && r.levelRange.every(Number.isFinite))) {
            noRange.push(`${cls} ${slot} ${r.id}`);
          }
        }
        // Best first: the level a row is priced at by default, then the rarity
        // its row authors. A list sorted on the authored level alone put every
        // row that authors none - the Rare and Epic faction sets - at the
        // bottom, under the level-13 greens; one sorted on the TOP of each
        // row's level range put a level-6 Uncommon necklace above the crafted
        // level-20 Rare one, because a drop that does not scale has a band up
        // to the character's level and is priced at the bottom of it.
        const levels = [];
        for (const r of rows) {
          const lvl = await pricedAt(cls, slot, r.id);
          levels.push(lvl);
          // ...and the catalog row says which end that is: the top of its
          // range when it scales, the bottom when it does not.
          if (r.levelRange?.[r.levelScales ? 1 : 0] !== lvl) {
            offKey.push(`${cls} ${slot} ${r.id}: range ${JSON.stringify(r.levelRange)}, levelScales ${r.levelScales}, priced at ${lvl}`);
          }
          if (lvl < r.levelRange?.[1]) pricedLow++;
          // A row that authors no level is priced at the character's, which
          // is the one thing the picker prints for it ("at your level"). It
          // may not print "drops": some of these rows are a recipe's output.
          if (r.level == null) {
            noLevel.rows++;
            if (r.crafted) noLevel.crafted++;
            if (lvl !== MAX_LEVEL) noLevel.off.push(`${cls} ${slot} ${r.id}: priced at ${lvl}`);
          }
        }
        const rarityOf = (r) => rarityRank.get(r.rarities.find((x) => x.authored)?.id) ?? -1;
        for (let i = 1; i < rows.length; i++) {
          const [a, z] = [[levels[i - 1], rarityOf(rows[i - 1])], [levels[i], rarityOf(rows[i])]];
          if (a[0] < z[0] || (a[0] === z[0] && a[1] < z[1])) {
            unsorted.push(`${cls} ${slot} ${rows[i - 1].id} (lvl ${a[0]}) before ${rows[i].id} (lvl ${z[0]})`);
          }
        }
      }
    }
    check(`catalog: a doll-slot row is one authored rarity with no chance (${gearRows} rows, 4 classes)`,
      gearRows > 0 && phantom.length === 0, phantom.slice(0, 3).join(' | '));
    check(`catalog: weapons still roll - ${spreads} of ${weaponRows} weapon-slot rows offer a spread`,
      spreads > 0, `${spreads}/${weaponRows}`);
    check(`catalog: no row sits above one the server prices at a higher level, nor above a better rarity at the same level (${pricedLow} rows are priced under the top of their range)`,
      unsorted.length === 0 && pricedLow > 0, unsorted.slice(0, 3).join(' | '));
    check('catalog: a row is priced at the top of its level range when it scales and at the bottom when it does not',
      offKey.length === 0, offKey.slice(0, 3).join(' | '));
    check(`catalog: a row that authors no level is priced at the character's (${noLevel.rows} rows; ${noLevel.crafted} of them crafted, so not "drops")`,
      noLevel.rows > 0 && noLevel.off.length === 0, noLevel.off.slice(0, 3).join(' | '));
    check('catalog: every row has a level range to print (none reads "lvl null")',
      noRange.length === 0, noRange.slice(0, 3).join(' | '));
    const top = Math.max(...(mageHeads ?? []).map((r) => rarityRank.get(r.rarities[0].id) ?? -1));
    check('catalog: the first helmet a max-level Mage is shown is one of the best rarity listed',
      mageHeads?.length > 0 && rarityRank.get(mageHeads[0].rarities[0].id) === top,
      `${mageHeads?.[0]?.id} (${mageHeads?.[0]?.rarities?.[0]?.id})`);
  }

  // --- catalog: what is withheld, on what evidence, and where a row comes from -
  // `cat.candidates` leaves out a row nothing in the install hands out, and a
  // row whose every copy is made above the character's level. The picker used
  // to list both kinds like any other row - 26 Epic pieces that sit only in
  // loot tables nothing points at, and every Epic piece offered to a level-10
  // character - with no source text on any of them. Each has to come back
  // apart, with the reader's reason, and the reason has to be TRUE.
  {
    const levels = [...new Set([MAX_LEVEL, MAX_LEVEL - 1, 10])];
    const both = [], silent = [], wrongKind = [], unreleasedListed = [], noSource = [], lowBand = [];
    const heldAtCap = new Set();
    let offered = 0, held = { unreleased: 0, level: 0 }, sourced = 0;
    const lateOffered = new Map();   // class -> ids offered at the cap
    const priceChecks = [];
    for (const cls of boot.classes.map((c) => c.unit)) {
      for (const level of levels) {
        const { data: c } = await api(`/api/catalog?class=${cls}&level=${level}`);
        const listed = new Set(Object.values(c.slots).flat().map((r) => r.id));
        if (level === MAX_LEVEL) lateOffered.set(cls, listed);
        for (const r of Object.values(c.slots).flat()) {
          offered++;
          const item = witness.cat.itemById.get(r.id);
          if (witness.cat.release(item).state === 'unreleased') unreleasedListed.push(`${cls} ${level} ${r.id}`);
          // every offered row says where it comes from: the atlas's line, or
          // the source reader's sentence
          if (!r.acquire) {
            sourced++;
            if (!(typeof r.source?.why === 'string' && r.source.why.length > 5)) noSource.push(`${cls} ${level} ${r.id}`);
          }
          // and its level band never starts below the level every copy is made at
          const floor = witness.cat.minInstanceLevel(item);
          if (floor != null && r.levelRange?.[0] < floor) lowBand.push(`${cls} ${level} ${r.id}: ${JSON.stringify(r.levelRange)} under ${floor}`);
        }
        for (const [slot, rows] of Object.entries(c.withheld ?? {})) {
          for (const r of rows) {
            if (listed.has(r.id)) both.push(`${cls} ${level} ${r.id}`);
            const w = r.withheld;
            if (!(typeof w?.why === 'string' && w.why.length > 20)) { silent.push(`${cls} ${level} ${r.id}`); continue; }
            held[w.kind] = (held[w.kind] ?? 0) + 1;
            const item = witness.cat.itemById.get(r.id);
            const rel = witness.cat.release(item);
            const floor = witness.cat.minInstanceLevel(item);
            // the kind is the reader's, and so is the sentence inside the reason
            const ok = w.kind === 'unreleased' ? (rel.state === 'unreleased' && w.why.includes(rel.why))
              : w.kind === 'level' ? (floor > level && w.floor === floor && w.why.includes(String(floor)) && w.why.includes(rel.why))
                : false;
            if (!ok) wrongKind.push(`${cls} ${level} ${r.id}: ${JSON.stringify(w)}`);
            if (level === MAX_LEVEL && w.kind === 'unreleased') heldAtCap.add(r.id);
            if (w.kind === 'level' && priceChecks.length < 6) priceChecks.push([cls, level, slot, r, floor]);
          }
        }
      }
    }
    check(`catalog: no row is both offered and withheld, and every withheld row says why (${offered} offered; ${held.unreleased} withheld as handed out by nothing, ${held.level} as made above the character's level)`,
      both.length === 0 && silent.length === 0 && held.unreleased > 0 && held.level > 0,
      [...both, ...silent].slice(0, 3).join(' | '));
    check('catalog: a withheld row\'s kind and sentence are the source reader\'s own',
      wrongKind.length === 0, wrongKind.slice(0, 2).join(' | '));
    check('catalog: no row the install hands out to nobody is offered, at any level',
      unreleasedListed.length === 0, unreleasedListed.slice(0, 3).join(' | '));
    // ...and nothing was dropped on the way: what is withheld at the cap as
    // handed out by nothing is exactly the catalog's list of such rows.
    const gone = new Set(witness.cat.unreleasedItems().filter((x) => !x.item.isAugment).map((x) => x.item.id));
    check(`catalog: the rows withheld at the level cap are exactly the stat-bearing rows nothing hands out (${gone.size})`,
      gone.size > 0 && gone.size === heldAtCap.size && [...gone].every((id) => heldAtCap.has(id)),
      `withheld ${heldAtCap.size}, the catalog names ${gone.size}`);
    check(`catalog: a row with no atlas line still says where it comes from (${sourced} such rows carry the source reader's sentence)`,
      sourced > 0 && noSource.length === 0, noSource.slice(0, 3).join(' | '));
    check('catalog: no level band starts below the level every copy of the row is made at',
      lowBand.length === 0, lowBand.slice(0, 2).join(' | '));
    // The reason is true: a row withheld as "only exists at level N" is priced
    // at N when asked for anyway, whatever the character's level - and the
    // same row is offered once the character is there.
    const untrue = [];
    for (const [cls, level, slot, r, floor] of priceChecks) {
      const { data: t } = await api('/api/tooltip/item', { class: cls, charLevel: level, item: r.id, slot, stars: 0 });
      const bonus = boot.rarities.find((x) => x.id === t.rarityId)?.iLevelBonus ?? 0;
      if (t.iLevel !== floor * 10 + bonus || t.withheld?.kind !== 'level' || !lateOffered.get(cls)?.has(r.id)) {
        untrue.push(`${cls} ${level} ${r.id}: iLevel ${t.iLevel}, withheld ${JSON.stringify(t.withheld)}, offered at the cap ${lateOffered.get(cls)?.has(r.id)}`);
      }
    }
    check(`catalog: a row withheld below its level is priced AT that level and is offered once the character reaches it (${priceChecks.length} checked)`,
      priceChecks.length > 0 && untrue.length === 0, untrue.slice(0, 2).join(' | '));
  }

  // --- catalog: which rows can carry an infusion -----------------------------
  {
    // $HInfusion.canBeInfused@21689 is three tests on the item row; the flag,
    // the faction that lights the bonus and the pool it can roll are the
    // catalog's, and a row that cannot be infused says which test it fails.
    const wrong = [];
    let can = 0, cannot = 0;
    for (const cls of boot.classes.map((c) => c.unit)) {
      const { data: c } = await api(`/api/catalog?class=${cls}&level=${MAX_LEVEL}`);
      for (const r of [...Object.values(c.slots).flat(), ...Object.values(c.withheld ?? {}).flat()]) {
        const want = gameInfusable(r.id);
        const item = witness.cat.itemById.get(r.id);
        if (want) can++; else cannot++;
        const pool = witness.cat.infusionBonusPool(item);
        const ok = r.infusable === want && (want
          ? r.notInfusable === null && r.infusionFaction?.id === originOf(r.id)
            && r.infusionFaction.name === factionNameOf(originOf(r.id))
            && JSON.stringify(r.infusionPool.map((p) => p.stat)) === JSON.stringify(pool) && pool.length > 0
            && r.infusionPool.every((p) => p.name === attrName(p.stat))
          : typeof r.notInfusable === 'string' && r.notInfusable.includes(r.id) && r.infusionPool.length === 0);
        if (!ok) wrong.push(`${cls} ${r.id}: infusable ${r.infusable} (${want}), "${r.notInfusable}", ${JSON.stringify(r.infusionFaction)}, ${JSON.stringify(r.infusionPool)}`);
      }
    }
    check(`catalog: a row is infusable exactly when the game's three tests pass, and one that is not says why (${can} can, ${cannot} cannot)`,
      can > 0 && cannot > 0 && wrong.length === 0, wrong.slice(0, 2).join(' | '));
  }

  // --- sheet: naked Mage 25 (values from sheet-engine.md §9) ----------------
  {
    const naked = {
      class: 'Mage', level: 25, gear: {}, augments: {}, skills: {}, runes: {}, talents: {},
    };
    // the 8.58 smoke dps is the reference-target number (boss reads 6.87). It
    // was 8.04, which is what the same bar reads WITHOUT Mystic Empowerment:
    // the default class-skill bar holds it, and until its status was read as
    // the caster's - with Cooldown Reduction taken when a cooldown starts -
    // slotting it moved nothing. Held against the engine below as well, so
    // the literal is a smoke value and not the only thing between the page
    // and a drifted number.
    const { status, data: s } = await api('/api/sheet', {
      loadout: naked, options: { target: 'reference' },
    });
    check('sheet naked responds', status === 200 && s.illegal === null, `HTTP ${status}`);
    const attr = (id) => s.attributes?.find((a) => a.id === id);
    check('sheet naked: Vitality 32', Math.abs((attr('Vitality')?.value ?? 0) - 32) < 1,
      String(attr('Vitality')?.value));
    check('sheet naked: Intellect 40', Math.abs((attr('Intellect')?.value ?? 0) - 40) < 1,
      String(attr('Intellect')?.value));
    check('sheet naked: MaxHealth 96', Math.abs((attr('MaxHealth')?.value ?? 0) - 96) < 1,
      String(attr('MaxHealth')?.value));
    check('sheet naked: CritChance ~5.95',
      Math.abs((attr('CritChance')?.value ?? 0) - 5.95) < 0.05,
      String(attr('CritChance')?.value));
    check('sheet naked: CritChance display "6.0%"',
      attr('CritChance')?.display === '6.0%', attr('CritChance')?.display);
    check('sheet naked: dps ~8.58', Math.abs((s.dps ?? 0) - 8.58) < 0.1,
      s.dps?.toFixed(3));
    {
      // ...and it is the engine's own number for that bar, which reads lower
      // with the one skill that shortens the others' cooldowns off it.
      const bar = { ...naked, gear: {}, skills: {} };
      witness.plan.pruneSelection(bar);
      const at = (l) => witness.evaluate(l, { target: witness.combat.foe('reference', 25), rank: 3 }).throughput.dps;
      const cdr = (id) => witness.plan.statusesOf(id, { rank: 3, runes: new Set() }).self
        .some((b) => b.duration > 0 && b.affixes.some((a) => a.target?.attribute === 'CooldownReduction' && a.val > 0));
      const key = Object.keys(bar.skills).find((k) => bar.skills[k].some(cdr));
      const without = key ? { ...bar, skills: { ...bar.skills, [key]: bar.skills[key].filter((id) => !cdr(id)) } } : null;
      check('sheet naked: the page prints the engine\'s number for the default bar', Math.abs((s.dps ?? 0) - at(bar)) < 1e-6,
        `${s.dps} against ${at(bar)}`);
      check('sheet naked: ...and the bar\'s Cooldown Reduction press is in it', !!without && at(without) < at(bar) - 0.1,
        without ? `${at(without).toFixed(3)} without it` : 'no such skill on the default bar');
    }
    check('sheet naked: primaries then more then defence',
      s.attributes?.[0]?.group === 'primary' && attr('Armor')?.group === 'defence'
      && attr('CritChance')?.group === 'more', s.attributes?.map((a) => a.group).join(','));
  }

  // --- sheet: Censer Legendary*5 --------------------------------------------
  {
    const l = {
      class: 'Mage', level: 25,
      gear: { Slot_Weapon1: { item: 'Staff_Censer', rarity: 'Legendary', stars: 5 } },
      augments: {}, skills: {}, runes: {}, talents: {},
    };
    const { data: s } = await api('/api/sheet', { loadout: l, options: {} });
    const rows = s.damage?.rows ?? [];
    check('sheet censer: damage rows present', rows.length > 0, `${rows.length} rows`);
    const shareSum = rows.reduce((t, r) => t + r.share, 0);
    check('sheet censer: shares sum to 1', Math.abs(shareSum - 1) < 1e-6, shareSum.toFixed(6));
    checkIcons('sheet censer: rows carry icons', rows.every((r) => r.icon),
      `${rows.filter((r) => r.icon).length}/${rows.length}`);
    check('sheet censer: armor sub-line', /^\(-\d+\.\d%\)$/.test(
      s.attributes?.find((a) => a.id === 'Armor')?.sub ?? ''),
      s.attributes?.find((a) => a.id === 'Armor')?.sub);
  }

  // --- illegal offhand ------------------------------------------------------
  {
    const l = {
      class: 'Mage', level: 25,
      gear: {
        Slot_Weapon1: { item: 'Book_Start' },
        Slot_OffhandWeapon: { item: 'Shield_Firebreath' },
      },
      augments: {}, skills: {}, runes: {}, talents: {},
    };
    const { status, data: s } = await api('/api/sheet', { loadout: l, options: {} });
    check('illegal offhand: sentence, no crash',
      status === 200 && /uses both hands/.test(s.illegal ?? ''), s.illegal);
    check('illegal offhand: rest of body absent', !('attributes' in s),
      Object.keys(s).join(','));
  }

  // --- what the server repairs, and what it refuses -------------------------
  {
    const { data: c } = await api(`/api/catalog?class=Mage&level=${MAX_LEVEL}`);
    const sheetOf = async (gear) => (await api('/api/sheet', { loadout: bare('Mage', gear), options: {} })).data;
    const numbers = (s) => JSON.stringify((s.attributes ?? []).map((a) => [a.id, a.value]));

    // An armour row sent at a rarity it does not author is priced as the row.
    // The catalog no longer offers one, but a saved build or a hand-written
    // request can still carry it, and priced as sent an "Epic" green was +50
    // item levels.
    const green = c.slots.Slot_Head.find((r) => r.rarities[0].id !== boot.rarities.at(-1).id);
    const asAuthored = numbers(await sheetOf({ Slot_Head: { item: green.id } }));
    const moved = [];
    for (const r of boot.rarities) {
      if (r.id === green.rarities[0].id) continue;
      if (numbers(await sheetOf({ Slot_Head: { item: green.id, rarity: r.id } })) !== asAuthored) moved.push(r.id);
    }
    check(`sheet: ${green.id} (${green.rarities[0].id}) reads the same at every rarity it is sent as`,
      moved.length === 0, `moved by: ${moved.join(',')}`);
    const { data: tipAs } = await api('/api/tooltip/item', {
      class: 'Mage', charLevel: MAX_LEVEL, item: green.id, rarity: boot.rarities.at(-1).id,
    });
    const { data: tipBare } = await api('/api/tooltip/item', {
      class: 'Mage', charLevel: MAX_LEVEL, item: green.id,
    });
    check('tooltip: and so does its tooltip',
      tipAs.rarityId === green.rarities[0].id && tipAs.iLevel === tipBare.iLevel,
      `${tipAs.rarityId} iLevel ${tipAs.iLevel} vs ${tipBare.iLevel}`);

    // ...and the clamp leaves a weapon alone: its rarity IS the instance's.
    const weapon = c.slots.Slot_Weapon1.find((r) => r.rarities.length > 1);
    const [lo, hi] = [weapon.rarities[0].id, weapon.rarities.at(-1).id];
    check(`sheet: ${weapon.id} still prices its rolled rarity (${lo} vs ${hi})`,
      numbers(await sheetOf({ Slot_Weapon1: { item: weapon.id, rarity: lo } }))
        !== numbers(await sheetOf({ Slot_Weapon1: { item: weapon.id, rarity: hi } })));

    // Stars are a count between zero and what the rarity allows.
    const starred = (stars) => ({ Slot_Weapon1: { item: weapon.id, rarity: hi, stars } });
    check('sheet: negative stars read as none',
      numbers(await sheetOf(starred(-3))) === numbers(await sheetOf(starred(0))));
    const tip = async (stars) => (await api('/api/tooltip/item', {
      class: 'Mage', charLevel: MAX_LEVEL, item: weapon.id, rarity: hi, stars,
    })).data;
    const [neg, zero, over] = [await tip(-3), await tip(0), await tip(99)];
    check('tooltip: stars clamp into 0..maxStars',
      neg.stars === 0 && neg.iLevel === zero.iLevel && over.stars === over.maxStars && over.iLevel > zero.iLevel,
      `-3 -> ${neg.stars} (iLevel ${neg.iLevel}), 0 -> iLevel ${zero.iLevel}, 99 -> ${over.stars}/${over.maxStars}`);

    // Input that is not a number, a goal or a regex is told so. Each of these
    // used to be a 200: a sheet whose every attribute read NaN, a tooltip with
    // a null item level, a search scored on a goal nothing computes.
    const refused = async (what, path, body, about) => {
      const { status, data } = await api(path, body);
      check(`400: ${what}`, status === 400 && typeof data.error === 'string' && about.test(data.error),
        `HTTP ${status} ${JSON.stringify(data).slice(0, 100)}`);
    };
    await refused('a loadout with no level', '/api/sheet', { loadout: { class: 'Mage' } }, /level/);
    await refused('a level that is not a number', '/api/sheet', { loadout: { class: 'Mage', level: 'abc' } }, /level/);
    await refused('a gear level that is not a number', '/api/sheet',
      { loadout: bare('Mage', { Slot_Head: { item: green.id, level: 'x' } }) }, /level/);
    await refused('an unknown goal on /api/sheet', '/api/sheet',
      { loadout: bare('Mage'), options: { goal: 'nope' } }, /goal/);
    await refused('an item tooltip at a level that is not a number', '/api/tooltip/item',
      { class: 'Mage', item: weapon.id, level: 'abc' }, /level/);
    await refused('a skill tooltip at a rank that is not a whole number', '/api/tooltip/skill',
      { skill: weapon.skills[0].id, rank: 1.5 }, /rank/);
    // The infusion search's options, which optimize() takes in silence: an
    // id it does not know is dropped from the offered list, any string is a
    // stat policy.
    await refused('options.infusions that is not a list of infusions', '/api/sheet',
      { loadout: bare('Mage'), options: { infusions: 'bogus' } }, /infusions/);
    await refused('an infusion id nothing names', '/api/sheet',
      { loadout: bare('Mage'), options: { infusions: ['Infusion_Nope'] } }, /Infusion_Nope/);
    await refused('a bonus-roll policy that is not a bonus rating', '/api/sheet',
      { loadout: bare('Mage'), options: { infusionStat: 'Strength' } }, /infusionStat/);
    await refused('includeUnreleased that is not a boolean', '/api/sheet',
      { loadout: bare('Mage'), options: { includeUnreleased: 'yes' } }, /includeUnreleased/);
    await refused('an item tooltip for an infusion nothing names', '/api/tooltip/item',
      { class: 'Mage', item: green.id, infusion: 'Infusion_Nope' }, /infusion/);
    // THE NUMBERS A FIGHT IS BUILT FROM. Each of these was a 200: a target
    // level of "abc" a sheet with `dps: null` and no damage rows, -3 a foe
    // that mitigates next to nothing, a `targets` of "x" a number BELOW one
    // target's, a rank of 2.5 a number between two ranks, a lookahead or a
    // mix that is not one the default in silence. Every refusal names the
    // option and quotes what it was sent.
    const badNumbers = [
      ['targetLevel', ['abc', -3, 0, '20']],
      ['targets', ['x', 2.5, 0, -1]],
      ['rank', ['x', 2.5, -1]],
      ['lookahead', ['x', -1]],
      ['mix', ['x', 1.5, -0.1]],
    ];
    for (const [name, values] of badNumbers) {
      for (const v of values) {
        await refused(`options.${name} ${JSON.stringify(v)} on /api/sheet`, '/api/sheet',
          { loadout: bare('Mage'), options: { [name]: v } },
          new RegExp(`^options\\.${name} must be .*, not ${JSON.stringify(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      }
    }
    // ...and what each rule lets through still answers, with a number.
    const fine = [{ targetLevel: null }, { targetLevel: 20 }, { targets: 3 }, { rank: 1 }, { lookahead: 0 }, { mix: 0 }, { mix: 1 }];
    const answered = [];
    for (const options of fine) {
      const { status, data } = await api('/api/sheet', { loadout: bare('Mage', { Slot_Weapon1: { item: weapon.id } }), options });
      answered.push({ options, ok: status === 200 && Number.isFinite(data.dps) && data.dps > 0, status, dps: data.dps });
    }
    check(`200: the values those rules allow still price a sheet (${fine.length} options)`, answered.every((a) => a.ok),
      JSON.stringify(answered.filter((a) => !a.ok)));
    {
      const { status, data } = await api('/api/catalog?level=25');
      check('400: /api/catalog with no class says a class is required, and which there are',
        status === 400 && /^class is required - one of /.test(data.error ?? '') && /Mage/.test(data.error), `HTTP ${status} ${JSON.stringify(data).slice(0, 100)}`);
    }

    // An attribute that is not a bonus rating, off the rows.
    const notARating = cdb.lines('attribute').find((a) => !BONUS_RATINGS.includes(a.id))?.id;

    // ...and a refused /api/optimize/start does not cost the search already
    // running. The loadout and the target are checked in the worker too, and
    // while they were checked ONLY there the answer was a 200 and a new job
    // whose single event was the refusal - after the running search had been
    // superseded. So: one long search, its stream held open, every refusable
    // start thrown at it, and it must still be running at the end.
    const startRefusals = [
      ['an unknown goal', { loadout: bare('Mage'), options: { goal: 'nope' } }, /goal/],
      ['an exclude that is not a regex', { loadout: bare('Mage'), options: { exclude: '(' } }, /regex/],
      ['a loadout with no level', { loadout: { class: 'Mage' } }, /level/],
      ['an unknown class', { loadout: bare('Nope') }, /class/],
      ['a gear level that is not a number',
        { loadout: bare('Mage', { Slot_Head: { item: green.id, level: 'x' } }) }, /level/],
      ['a loadout that is not an object', { loadout: 'x' }, /loadout/],
      ['a target nothing names', { loadout: bare('Mage'), options: { target: 'nope' } }, /target/],
      // The numbers the worker would build its fight from - each used to be
      // a 200 and a job.
      ['a target level that is not a number', { loadout: bare('Mage'), options: { targetLevel: 'abc' } }, /^options\.targetLevel must be/],
      ['a target level below one', { loadout: bare('Mage'), options: { targetLevel: -3 } }, /^options\.targetLevel must be/],
      ['a target count that is not a number', { loadout: bare('Mage'), options: { targets: 'x' } }, /^options\.targets must be/],
      ['a rank that is not a whole number', { loadout: bare('Mage'), options: { rank: 2.5 } }, /^options\.rank must be/],
      ['a lookahead that is not a number', { loadout: bare('Mage'), options: { lookahead: 'x' } }, /^options\.lookahead must be/],
      ['a mix outside 0..1', { loadout: bare('Mage'), options: { mix: 1.5 } }, /^options\.mix must be/],
      // A seed the game would refuse. The search evaluates its seed first and
      // that evaluation throws - so these two were a 200, a job whose only
      // event was the sentence, and the running search already superseded.
      ['a two-hander with a filled off hand',
        { loadout: bare('Mage', { Slot_Weapon1: { item: 'Book_Start' }, Slot_OffhandWeapon: { item: 'Shield_Firebreath' } }) },
        /both hands/],
      ['an infusion on a piece that cannot carry one',
        { loadout: bare('Mage', { Slot_Neck: { item: c.slots.Slot_Neck[0].id, infusion: infusionDefs[0].id } }) },
        /cannot carry/],
      ['an infusion option nothing names', { loadout: bare('Mage'), options: { infusions: ['Infusion_Nope'] } }, /Infusion_Nope/],
      // A seed whose infusion fields state nothing the game could hold: the
      // worker sanitises the same way, so each was a search for another build.
      ['a gear infusion that is not an id',
        { loadout: bare('Mage', { Slot_Head: { item: green.id, infusion: 5 } }) }, /Slot_Head\.infusion must be an id/],
      ['a gear bonus roll that is not a bonus rating',
        { loadout: bare('Mage', { Slot_Head: { item: green.id, infusionStat: notARating } }) }, /not an infusion bonus rating/],
      // An infusion pin on a slot whose piece is not pinned. An infusion is a
      // field of the piece, so optimize() has no reading of "hold it, swap the
      // piece": it swapped the piece in bare and never infused the slot again
      // - the search with the pin scored below the search without it.
      ['an infusion pin on a slot whose piece is not pinned',
        { loadout: bare('Mage', { Slot_Head: { item: green.id } }), pins: { gear: [], infusions: ['Slot_Head'] } },
        /pins\.infusions names Slot_Head, which pins\.gear does not/],
      ['pins.infusions that is not a list of slots',
        { loadout: bare('Mage'), pins: { gear: ['Slot_Head'], infusions: 'Slot_Head' } }, /pins\.infusions must be a list/],
    ];
    const { data: running } = await api('/api/optimize/start', {
      loadout: bare('Mage'), pins: {},
      options: { goal: 'dps', target: 'boss', fight: 200, lookahead: 8, restarts: 3 },
    });
    const seen = [];
    const ctl = new AbortController();
    const stream = (async () => {
      try {
        const res = await fetch(`${base}/api/optimize/events?job=${running.job}`, { signal: ctl.signal });
        let buf = '';
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString('utf8');
          for (let sep; (sep = buf.indexOf('\n\n')) >= 0; buf = buf.slice(sep + 2)) {
            const m = /^event: (\S+)\ndata: (.*)$/m.exec(buf.slice(0, sep));
            if (m) seen.push({ event: m[1], data: m[2] });
          }
        }
      } catch (e) { if (e.name !== 'AbortError') throw e; }
    })();
    const terminal = () => seen.find((e) => e.event === 'done' || e.event === 'error');
    const until = async (cond, ms) => {
      for (const t0 = Date.now(); !cond() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 50));
      return cond();
    };
    // Running means it has reported an evaluation count.
    const started = await until(() => seen.some((e) => e.event === 'progress') || terminal(), 30000);
    for (const [what, body, about] of startRefusals) {
      await refused(`${what} on /api/optimize/start`, '/api/optimize/start', body, about);
    }
    // A superseded job is told so at once; give the event time to arrive.
    await new Promise((r) => setTimeout(r, 400));
    check(`optimize: the search that was running outlives all ${startRefusals.length} refused starts`,
      started && !terminal(),
      terminal() ? `${terminal().event} ${terminal().data.slice(0, 80)}` : `${seen.length} progress events`);
    await api('/api/optimize/cancel', { job: running.job });
    await until(terminal, 5000);
    ctl.abort();
    await stream;
    check('optimize: and it ends when it is cancelled, not before',
      /cancelled/.test(terminal()?.data ?? ''), terminal() ? `${terminal().event} ${terminal().data}` : 'no terminal event');
  }

  // --- infusion: what a piece carries, on the sheet and in its tooltip -------
  // A gear entry may state three things about its infusion - which set
  // passive, which rating its bonus line rolled, whether the piece is
  // Prismatic - and four surfaces answer for them: the sheet's numbers, the
  // sheet's `infusions` block, the item tooltip and the skill tooltip. They
  // have to tell one story.
  {
    const { data: c } = await api(`/api/catalog?class=Mage&level=${MAX_LEVEL}`);
    const caps = CAPS;
    const armour = Object.entries(c.slots).map(([slot, rows]) => [slot, rows.find((r) => gameInfusable(r.id))]).filter(([, r]) => r);
    const sheetOf = async (gear) => (await api('/api/sheet', { loadout: bare('Mage', gear), options: {} })).data;
    const numbers = (s) => JSON.stringify((s.attributes ?? []).map((a) => [a.id, a.value]));
    const listed = new Set((await sheetOf({})).attributes.map((a) => a.id));

    // THE SET RANK. A flat stat row that starts at an infusion's second set
    // (`conds.minRank: 2`) is on the sheet from the second cap and not one
    // piece earlier - with the SAME pieces worn either way, so nothing but the
    // set can move the number. The row is found in the data, not named.
    const withFlat = cdb.lines('skill').filter((r) => skillType(r) === 'InfusionPassive')
      .map((row) => [row, (row.affixes ?? []).find((a) => a.ref === 'TAttribute_Flat' && a.conds?.minRank === 2
        && listed.has(a.target?.attribute) && typeof a.val === 'number')]).find(([, a]) => a);
    const [setRow, setAffix] = withFlat ?? [];
    const worn = armour.slice(0, caps[1]);
    const dressed = (n) => Object.fromEntries(worn.map(([slot, r], i) => [slot, i < n ? { item: r.id, infusion: setRow.id } : { item: r.id }]));
    // a flat row as the affix template prints it: signed, and a percentage
    // when the target attribute is flagged Percent ("+4% Fervor")
    const flatLine = (a) => {
      const pct = cdb.flagNames('attribute', 'flags', cdb.byId('attribute').get(a.target.attribute)?.flags).includes('Percent');
      return `${a.val >= 0 ? '+' : ''}${p2(a.val)}${pct ? '%' : ''} ${attrName(a.target.attribute)}`;
    };
    const rankTitle = (cap) => cdb.byId('text').get('infusion_rank')?.value?.text?.replace('::rank::', String(cap));
    let below = null, at = null;
    if (setRow && worn.length === caps[1]) {
      [below, at] = [await sheetOf(dressed(caps[1] - 1)), await sheetOf(dressed(caps[1]))];
    }
    const setOf = (s) => s?.infusions?.sets?.find((x) => x.id === setRow?.id);
    const moved = at && below ? sheetAttr(at, setAffix.target.attribute) - sheetAttr(below, setAffix.target.attribute) : NaN;
    check(`sheet: ${setRow?.texts?.name}'s ${setAffix?.val > 0 ? '+' : ''}${setAffix?.val} ${attrName(setAffix?.target?.attribute)} is paid from ${caps[1]} pieces and not from ${caps[1] - 1} (the same pieces worn both times)`,
      !!setRow && Math.abs(moved - setAffix.val) < 1e-6,
      `${attrName(setAffix?.target?.attribute)} moved by ${moved}`);
    check('sheet: and the block says so - the set\'s rank, its title in the game\'s words, and the stat row among what is scored',
      setOf(below)?.rank === 1 && setOf(below)?.title === rankTitle(caps[0]) && setOf(below)?.pieces === caps[1] - 1
      && setOf(at)?.rank === 2 && setOf(at)?.title === rankTitle(caps[1]) && setOf(at)?.nextCap === caps[2]
      && setOf(at).priced.includes(flatLine(setAffix)) && !setOf(below).priced.includes(flatLine(setAffix)),
      JSON.stringify([setOf(below), setOf(at)].map((s) => s && { rank: s.rank, title: s.title, pieces: s.pieces, priced: s.priced })));
    // the skill tooltip counts the same pieces to the same rank
    const tipRank = async (n) => (await api('/api/tooltip/skill', { skill: setRow.id, rank: 3, loadout: bare('Mage', dressed(n)), options: {} })).data.rank;
    const ranks = setRow ? [await tipRank(caps[1] - 1), await tipRank(caps[1])] : [];
    check('tooltip/skill: and the skill tooltip lights the same rank the sheet attaches',
      ranks[0] === setOf(below)?.rank && ranks[1] === setOf(at)?.rank, `tooltip ${ranks.join(' / ')}`);
    // what a set does that the fight does not score is NAMED, never dropped
    const sayNothing = (at?.infusions?.sets ?? []).filter((s) => s.attached && !s.priced.length && !s.unpriced.length);
    check('sheet: an attached set lists what of it is scored and names what is not',
      at?.infusions?.sets?.length > 0 && sayNothing.length === 0
      && at.unmodelled.filter((u) => u.source === 'infusion').length >= at.infusions.sets.filter((s) => s.unpriced.length).length,
      JSON.stringify(at?.infusions?.sets?.map((s) => [s.name, s.priced.length, s.unpriced.length])));

    // ONE GAP, ONE SPELLING. A set's gap is told twice - its entry in the
    // `infusions` block and its row in `unmodelled` - and the engine's
    // sentence quotes the rows it is about with their [links] still in them
    // ("the status Gift of [CritChance]") and the stat rows in id form
    // ("+4 Fervor"), while the block prints both the game's way. Served raw,
    // the row read as a second, different account of the same thing. The
    // witness is an infusion whose ENGINE sentence carries a raw link - found
    // by evaluating each one beside the server, not named.
    const hasLink = (s) => new RegExp(LINK.source).test(String(s));
    const wornAs = (id) => Object.fromEntries(worn.map(([slot, r]) => [slot, { item: r.id, infusion: id }]));
    const rawGapOf = (id) => witness.evaluate(bare('Mage', wornAs(id)), { target: witness.combat.foe('boss', MAX_LEVEL, null), rank: 3 })
      .throughput.unmodelled.find((u) => u.source === 'infusion' && u.id === id);
    const quoting = worn.length === caps[1] ? infusionDefs.map((d) => [d, rawGapOf(d.id)]).find(([, raw]) => raw && hasLink(raw.why)) : null;
    const [qDef, qRaw] = quoting ?? [];
    const qSheet = qDef ? await sheetOf(wornAs(qDef.id)) : null;
    const qSet = qSheet?.infusions?.sets?.find((s) => s.id === qDef.id);
    const qRow = qSheet?.unmodelled?.find((u) => u.source === 'infusion' && u.id === qDef.id);
    check(`sheet: ${qDef?.name}'s row in unmodelled says what its entry in the infusions block says, in the same words (the engine's own sentence carries raw [links])`,
      !!qRaw && !!qSet && !!qRow && qSet.priced.length > 0 && qSet.unpriced.length > 0
      && !hasLink(qRow.why) && !hasLink(qRow.name)
      && qRow.why.includes(`Scored: ${qSet.priced.join('; ')}.`)
      && qSet.unpriced.every((x) => qRow.why.includes(x)),
      JSON.stringify({ why: qRow?.why?.slice(0, 220), priced: qSet?.priced, unpriced: qSet?.unpriced?.[0] }));
    // ...and no row of that sheet prints a link raw, whatever it is about.
    const rawRows = (qSheet?.unmodelled ?? []).filter((u) => hasLink(u.name) || hasLink(u.why));
    check('sheet: no unmodelled row is served with a [link] still in it',
      (qSheet?.unmodelled?.length ?? 0) > 0 && rawRows.length === 0, rawRows.map((u) => `${u.name}: ${u.why.slice(0, 80)}`).join(' | '));

    // THE BONUS LINE. st.item.Gear.isInfusionBonusActive@9766: a rolled stat
    // AND an infusion AND (Prismatic OR the infusion's faction is the piece's).
    // One piece, one stated roll, three infusion states - and for each the item
    // tooltip's `active` and `value` against what the sheet actually pays.
    const [slot, piece] = armour[0];
    const stat = poolOf(piece.id)[0];
    const own = infusionDefs.find((x) => x.faction === originOf(piece.id));
    const other = infusionDefs.find((x) => x.faction !== originOf(piece.id));
    const tipOf = async (extra) => (await api('/api/tooltip/item', { class: 'Mage', charLevel: MAX_LEVEL, item: piece.id, slot, ...extra })).data;
    const cases = {
      bare: { infusion: own.id },
      lit: { infusion: own.id, infusionStat: stat },
      dark: { infusion: other.id, infusionStat: stat },
      prismatic: { infusion: other.id, infusionStat: stat, prismatic: true },
    };
    const tips = {}, sheets = {};
    for (const [k, extra] of Object.entries(cases)) {
      tips[k] = await tipOf(extra);
      sheets[k] = await sheetOf({ [slot]: { item: piece.id, ...extra } });
    }
    const pieceOf = (s) => s.infusions?.pieces?.find((p) => p.slot === slot);
    const v = tips.lit.infusionBonus?.value;
    check(`tooltip/item: ${piece.name}'s bonus is lit under ${own.name} (its own faction), dark under ${other.name}, lit again when Prismatic - and worth the same +${v} each time`,
      v > 0 && tips.bare.infusionBonus === null
      && tips.lit.infusionBonus?.active === true && tips.lit.infusionBonus.note === null
      && tips.dark.infusionBonus?.active === false && tips.dark.infusionBonus.value === v && typeof tips.dark.infusionBonus.note === 'string'
      && tips.prismatic.infusionBonus?.active === true && tips.prismatic.infusionBonus.value === v,
      JSON.stringify(Object.fromEntries(Object.entries(tips).map(([k, t]) => [k, t.infusionBonus && { a: t.infusionBonus.active, v: t.infusionBonus.value }]))));
    check('sheet: and the sheet pays exactly that - the lit and the Prismatic piece move it by the bonus, the dark one by nothing',
      numbers(sheets.lit) !== numbers(sheets.bare) && numbers(sheets.dark) !== numbers(sheets.lit)
      && numbers(sheets.prismatic) === numbers(sheets.lit)
      && v > 0 && pieceOf(sheets.lit)?.value === v && pieceOf(sheets.lit).lit === true
      && pieceOf(sheets.dark)?.value === 0 && pieceOf(sheets.dark).wouldBe === v && pieceOf(sheets.dark).lit === false
      && pieceOf(sheets.prismatic)?.value === v && pieceOf(sheets.lit).display === tips.lit.infusionBonus?.display,
      JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, s]) => [k, pieceOf(s) && { value: pieceOf(s).value, lit: pieceOf(s).lit }]))));
    // the two dark builds differ only in the infusion's NAME, which no number
    // reads at one piece: the stated roll is worth nothing either way
    const darkOwn = await sheetOf({ [slot]: { item: piece.id, infusion: other.id } });
    check('sheet: a dark bonus line leaves every attribute where the unrolled piece has it',
      numbers(sheets.dark) === numbers(darkOwn));
    // The block is the game's own (ui.TipItem.init@15947): the line naming the
    // infusion, then the bonus under the PIECE's faction - not the infusion's
    // - with the rating printed by the affix template.
    const effect = textEntry('infusion', 'item_effect');
    const bonusTitle = textEntry('infusion', 'infusion_bonus');
    const pieceFaction = factionNameOf(originOf(piece.id));
    check(`tooltip/item: the block is the game's text - "${tips.dark.infusion?.text}", then "${tips.dark.infusionBonus?.title}" for a ${pieceFaction} piece under a ${other.factionName} infusion`,
      !!effect && !!bonusTitle
      && tips.dark.infusion?.text === effect.replace('[::skill::]', other.name)
      && tips.dark.infusionBonus?.title === bonusTitle.replace('[::faction::]', pieceFaction)
      && pieceFaction !== other.factionName
      && tips.lit.infusionBonus?.display === `+${v} ${attrName(stat)}`,
      `display "${tips.lit.infusionBonus?.display}"`);
    // what the line COULD be, for each rating the piece can have rolled
    check('tooltip/item: the pool lists each rating the piece can have rolled with what it would be worth',
      JSON.stringify(tips.bare.infusionPool?.map((p) => p.stat)) === JSON.stringify(poolOf(piece.id))
      && v > 0 && tips.bare.infusionPool.find((p) => p.stat === stat)?.value === v,
      JSON.stringify(tips.bare.infusionPool));
    // the game's own field name is read as the bench's
    const aliased = await sheetOf({ [slot]: { item: piece.id, infusion: own.id, infusionBonusStat: stat } });
    check('sheet: a gear entry spelled with the game\'s own infusionBonusStat is read as infusionStat',
      numbers(aliased) === numbers(sheets.lit) && pieceOf(aliased)?.stat === stat);

    // A ROLL THAT IS NOT A BONUS RATING is refused, on a piece that would be
    // lit. The game prices the line from the InfusionBonus rows whose endAtb
    // IS the rolled stat (getInfusionBonusAffix@9767 ops 11-29) and an empty
    // list is worth 0 ($HItem.computeAtbScaling@21737 ops 4-9), so any other
    // id pays nothing on any piece - and served as a sheet it read "lit, +0"
    // under a note about the piece's roll pool. Three ids that are not
    // ratings, each found in the rows: the attribute the rating BUYS (the row
    // whose Rating scaling reads it - `CritChance` for `CritChanceRating`,
    // the spelling the engine's own notes print), an attribute that has
    // nothing to do with one, and an id no row has.
    const bought = witness.ctx.attrTable.attrs.find((a) => a.scaling.some((x) => x.op.case === 'Rating' && x.from === stat))?.id;
    const unrelated = cdb.lines('attribute').find((a) => !BONUS_RATINGS.includes(a.id) && a.id !== bought)?.id;
    const nothing = 'NoSuchRating';
    const notRatings = [bought, unrelated, nothing];
    const refusals = [];
    for (const bad of notRatings) {
      const entry = { item: piece.id, infusion: own.id, infusionStat: bad };
      for (const [route, res] of [
        ['sheet', await api('/api/sheet', { loadout: bare('Mage', { [slot]: entry }), options: {} })],
        ['tooltip/item', await api('/api/tooltip/item', { class: 'Mage', charLevel: MAX_LEVEL, slot, ...entry })],
      ]) {
        const said = typeof res.data?.error === 'string' ? res.data.error : '';
        refusals.push({ bad, route, ok: res.status === 400 && said.includes(JSON.stringify(bad)) && BONUS_RATINGS.every((r) => said.includes(r)), status: res.status });
      }
    }
    check(`400: a bonus roll that is not a bonus rating (${notRatings.join(', ')}) is refused by the sheet and by the item tooltip, each naming it and the ${BONUS_RATINGS.length} ratings there are`,
      !!bought && !!unrelated && !cdb.has('attribute', nothing) && !BONUS_RATINGS.includes(bought) && BONUS_RATINGS.length > 0
      && refusals.length === 6 && refusals.every((r) => r.ok),
      JSON.stringify(refusals.filter((r) => !r.ok)));
    // ...while a REAL rating the piece was not expected to roll is not: a
    // looted piece carries whatever the server rolled, so it is priced as
    // stated, the tooltip and the sheet agree on the number, and both say it
    // is outside the pool. The piece and the rating are found in the rows.
    const [oSlot, oPiece] = armour.find(([, r]) => BONUS_RATINGS.some((x) => !poolOf(r.id).includes(x))) ?? [];
    const outside = oPiece ? BONUS_RATINGS.find((x) => !poolOf(oPiece.id).includes(x)) : null;
    const oOwn = oPiece ? infusionDefs.find((x) => x.faction === originOf(oPiece.id)) : null;
    const oEntry = oPiece ? { item: oPiece.id, infusion: oOwn?.id, infusionStat: outside } : null;
    const oSheet = oEntry ? await sheetOf({ [oSlot]: oEntry }) : null;
    const oBare = oEntry ? await sheetOf({ [oSlot]: { item: oPiece.id, infusion: oOwn?.id } }) : null;
    const oTip = oEntry ? (await api('/api/tooltip/item', { class: 'Mage', charLevel: MAX_LEVEL, slot: oSlot, ...oEntry })).data : null;
    const oLine = oSheet?.infusions?.pieces?.find((p) => p.slot === oSlot);
    check(`sheet: a real bonus rating outside a piece's pool (${outside} on ${oPiece?.name}) is priced as stated and said to be outside it`,
      !!outside && !!oOwn && oLine?.lit === true && oLine.value > 0 && oLine.value === oTip?.infusionBonus?.value
      && oTip.infusionBonus.active === true && typeof oTip.infusionBonus.note === 'string' && typeof oLine.note === 'string'
      && numbers(oSheet) !== numbers(oBare)
      && oSheet.unmodelled.some((u) => u.id === oPiece.id && u.source === oSlot),
      JSON.stringify({ line: oLine && { value: oLine.value, lit: oLine.lit, note: oLine.note }, tip: oTip?.infusionBonus }));

    // AN INFUSION FIELD THAT IS NOT WHAT THE FIELD HOLDS is refused, not
    // dropped: `infusion: 5` came back as the sheet of the piece NOT infused
    // - a 200 for a build nobody sent - while the item tooltip refused it.
    // "Not stated" is null, absent or the empty string, and reads as the
    // piece with no infusion on both routes.
    const wrong = [
      ['infusion', 5], ['infusion', [own.id]], ['infusion', { id: own.id }],
      ['infusionStat', 5], ['infusionBonusStat', [stat]], ['prismatic', 'false'], ['prismatic', 1],
    ];
    const wrongOut = [];
    for (const [field, value] of wrong) {
      const entry = { item: piece.id, infusion: own.id, infusionStat: field === 'infusionBonusStat' ? undefined : stat, [field]: value };
      const sh = await api('/api/sheet', { loadout: bare('Mage', { [slot]: entry }), options: {} });
      wrongOut.push({ field, value, route: 'sheet', ok: sh.status === 400 && String(sh.data?.error).includes(`${slot}.${field} `), said: sh.data?.error });
      if (field !== 'infusionBonusStat') {   // the tooltip body has the bench's spelling only
        const tp = await api('/api/tooltip/item', { class: 'Mage', charLevel: MAX_LEVEL, slot, ...entry });
        wrongOut.push({ field, value, route: 'tooltip/item', ok: tp.status === 400 && String(tp.data?.error).startsWith(`${field} `), said: tp.data?.error });
      }
    }
    check(`400: an infusion field of the wrong type is refused by the sheet (naming the slot and the field) and by the item tooltip - ${wrong.length} values`,
      wrongOut.length === wrong.length * 2 - 1 && wrongOut.every((r) => r.ok),
      JSON.stringify(wrongOut.filter((r) => !r.ok)));
    const unsaid = [];
    for (const v of [null, '']) {
      const s = await sheetOf({ [slot]: { item: piece.id, infusion: v, infusionStat: v, prismatic: v === null ? null : undefined } });
      const t = await api('/api/tooltip/item', { class: 'Mage', charLevel: MAX_LEVEL, slot, item: piece.id, infusion: v, infusionStat: v });
      unsaid.push(numbers(s) === numbers(await sheetOf({ [slot]: { item: piece.id } })) && s.infusions?.pieces?.length === 0
        && t.status === 200 && t.data.infusion === null && t.data.infusionBonus === null);
    }
    check('sheet: and null or the empty string is "not stated" - the piece, not infused, on the sheet and in its tooltip',
      unsaid.length === 2 && unsaid.every(Boolean), JSON.stringify(unsaid));

    // A BUILD THE GAME REFUSES is answered with the rule it breaks.
    // $HInfusion.canBeInfused is three tests on the item row, so here are
    // three pieces that each fail exactly ONE of them; each must come back as
    // an `illegal` sentence naming the piece - from the sheet and from the
    // skill tooltip alike - and not as a sheet that quietly counted it (a
    // necklace and a ring used to light "(2) Set").
    const every1 = Object.entries(c.slots).flatMap(([s, list]) => list.map((r) => [s, r]));
    const armourType = (r) => typeChain(r.type).includes('Armor');
    const atLeastMin = (r) => rarityAt(cdb.byId('item').get(r.id)?.rarity) >= rarityAt(cdb.constant('Item_InfusionMinRarity')?.other?.rarity);
    const failing = [
      ['not armour', (r) => !armourType(r) && atLeastMin(r) && originOf(r.id)],
      ['armour under the minimum rarity', (r) => armourType(r) && !atLeastMin(r) && originOf(r.id)],
      ['armour with no faction', (r) => armourType(r) && atLeastMin(r) && !originOf(r.id)],
    ].map(([what, fits]) => [what, every1.find(([, r]) => fits(r))]);
    const accepted = [];
    for (const [what, hit] of failing) {
      if (!hit) { accepted.push(`no row on this build is "${what}" alone`); continue; }
      const [s, r] = hit;
      const gear = { [s]: { item: r.id, infusion: own.id } };
      const { status, data: sh } = await api('/api/sheet', { loadout: bare('Mage', gear), options: {} });
      const { data: tp } = await api('/api/tooltip/skill', { skill: own.id, rank: 3, loadout: bare('Mage', gear), options: {} });
      const said = (x) => typeof x?.illegal === 'string' && x.illegal.includes(r.id) && !('attributes' in x) && !('ranks' in x);
      if (!(status === 200 && said(sh) && said(tp))) accepted.push(`${what} (${r.id}): sheet ${status} ${JSON.stringify(sh).slice(0, 90)} | tooltip ${JSON.stringify(tp).slice(0, 60)}`);
    }
    check(`sheet: an infusion on a piece the game cannot infuse is an illegal build, by name (${failing.map(([what, hit]) => `${what}: ${hit?.[1].id}`).join('; ')})`,
      accepted.length === 0, accepted.join(' | '));
  }

  // --- tooltip/skill: every row, at the rank the page sends -----------------
  // One sweep - each skill row, no loadout, the blanket mastery rank 3 the
  // front-end attaches to every hover - and then what each sentence must say
  // given the row that authors it.
  {
    const rows = cdb.lines('skill');
    const tips = new Map();
    const failedRows = [];
    for (const row of rows) {
      const { status, data } = await api('/api/tooltip/skill', { skill: row.id, rank: 3 });
      if (status === 200) tips.set(row.id, data); else failedRows.push(`${row.id}: ${status}`);
    }
    check(`tooltip/skill: all ${rows.length} rows answer`, failedRows.length === 0,
      failedRows.slice(0, 3).join(' | '));

    // [template, printed] pairs: a row with a ladder answers one line per
    // template, a row without answers its one sentence.
    const pairs = (row, t) => [row.texts?.desc, ...(row.texts?.rankDescs ?? []).map((r) => r?.desc)]
      .map((tmpl, i) => [String(tmpl ?? ''), String(t.ranks?.[i]?.desc ?? '')]);
    const every = (fn) => { for (const row of rows) { const t = tips.get(row.id); if (t) fn(row, t); } };

    // A '?' is always accounted for - in a rank line or in the top sentence.
    const silent = [];
    every((row, t) => {
      const authored = pairs(row, t).some(([tmpl]) => tmpl.includes('?'));
      const printed = [t.desc, ...t.ranks.map((r) => r.desc)].some((x) => String(x ?? '').includes('?'));
      if (printed && !authored && !t.unresolved?.length) silent.push(row.id);
    });
    check('tooltip/skill: a "?" the template does not author is always listed in unresolved',
      silent.length === 0, silent.slice(0, 5).join(','));

    // ...and under its TRUE reason. ::sourceItemDesc:: is a whole-name special
    // the game fills from the item the live status came from; a status row
    // does not name that item, and that is what the refusal has to say - not
    // "no value named sourceItemDesc", which reads as a hole in the data.
    const itemDesc = [], wrongWhy = [];
    every((row, t) => {
      if (!pairs(row, t).some(([tmpl]) => tmpl.includes('::sourceItemDesc::'))) return;
      itemDesc.push(row.id);
      const u = (t.unresolved ?? []).find((x) => x.token === '::sourceItemDesc::');
      if (!u || /no value named/.test(u.why) || !/\bitem\b/.test(u.why)) wrongWhy.push(`${row.id}: ${JSON.stringify(u ?? null)}`);
    });
    check(`tooltip/skill: ::sourceItemDesc:: is refused for what it is - the live status's source item (${itemDesc.join(', ')})`,
      itemDesc.length > 0 && wrongWhy.length === 0, wrongWhy.join(' | '));

    // LINKS. The game resolves a [term] through its sheets in one order and
    // the letters after the bracket are part of the match (ui/api.mjs has the
    // read). What that has to print, row by row:
    const inSheet = (sheet, id) => cdb.byId(sheet).get(id);
    const before = (id, sheets) => sheets.some((s) => inSheet(s, id));
    const stats = { unit: 0, item: 0, gameBeat: 0, skillFirst: 0, plural: 0, dropped: 0, bare: 0 };
    const badLinks = [], keptLetters = [];
    every((row, t) => {
      for (const [tmpl, out] of pairs(row, t)) {
        for (const m of tmpl.matchAll(LINK)) {
          const id = m[1].replace(/[!;]/g, '');
          const post = m[4];
          const expect = (kind, text) => {
            stats[kind]++;
            if (!out.includes(text)) badLinks.push(`${row.id} [${id}]${post} (${kind}) wants "${text}" in "${out.slice(0, 70)}"`);
          };
          const term = inSheet('gameTerm', id);
          if (term) {
            // a declining sheet reads the letters as the form to print
            if (post === 's' && term.texts?.name?.plural) expect('plural', term.texts.name.plural);
            continue;
          }
          if (before(id, ['attribute', 'affinity'])) {
            // any other sheet returns its name and the letters are gone
            const name = inSheet('attribute', id)?.name;
            if (post && name) {
              stats.dropped++;
              if (out.includes(name + post)) keptLetters.push(`${row.id} [${id}]${post}: "${out.slice(0, 70)}"`);
            }
            continue;
          }
          const unit = inSheet('unit', id);
          if (unit) { if (unit.texts?.name) expect('unit', unit.texts.name); continue; }
          if (before(id, ['icon'])) continue;
          const item = inSheet('item', id);
          if (item) { if (item.texts?.name) expect('item', item.texts.name); continue; }
          if (before(id, ['rarity', 'itemType'])) continue;
          const skill = inSheet('skill', id);
          if (skill) {
            // skill is tried BEFORE statusType: "[Bleed]" is the skill row's name
            const st = inSheet('statusType', id)?.texts?.name?.v;
            if (typeof skill.texts?.name === 'string' && st && st !== skill.texts.name) expect('skillFirst', skill.texts.name);
            continue;
          }
          if (before(id, ['statusType'])) continue;
          const beat = inSheet('gameBeat', id);
          if (beat) { if (beat.texts?.name) expect('gameBeat', beat.texts.name); continue; }
        }
        // nothing that is a link in the game's grammar is left in the output
        stats.bare += [...out.matchAll(LINK)].length;
      }
    });
    check(`tooltip/skill: links print the row the game finds first (unit ${stats.unit}, item ${stats.item}, gameBeat ${stats.gameBeat}, skill-over-statusType ${stats.skillFirst}, plural ${stats.plural})`,
      badLinks.length === 0 && stats.unit > 0 && stats.item > 0 && stats.gameBeat > 0 && stats.skillFirst > 0 && stats.plural > 0,
      badLinks.slice(0, 3).join(' | '));
    check(`tooltip/skill: letters after a link that does not decline are consumed (${stats.dropped} such links), and no link is left unresolved`,
      stats.dropped > 0 && keptLetters.length === 0 && stats.bare === 0,
      keptLetters.length ? `kept: ${keptLetters.slice(0, 3).join(' | ')}` : `${stats.bare} bracket links left in the output`);

    // NUMBERS, for the row's own tokens (no refN_) on rows a rank cannot move:
    //   ::x%::      a stored fraction is x100 at two decimals - 0.025 is "2.5%"
    //   ::val1%::   on an affix whose row stacks Multiplicative or Min(base 1)
    //               prints |1 - val|: a 0.6 damage-taken multiplier is "40%"
    //   ::range::   is filled into text.rich_range_meters
    const metres = cdb.byId('text').get('rich_range_meters')?.value?.text;
    const n = { fraction: 0, takesOff: 0, range: 0 };
    const badNumbers = [];
    every((row, t) => {
      if ((row.props?.rankOverride ?? []).length) return;
      for (const [tmpl, out] of pairs(row, t)) {
        for (const m of tmpl.matchAll(TOKEN)) {
          const [whole, , ref, , key, digits, pct] = m;
          if (ref) continue;
          const v = row.vars?.[key + digits];
          if (pct && typeof v === 'number' && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
            n.fraction++;
            if (!out.includes(`${p2(Math.abs(v) * 100)}%`)) badNumbers.push(`${row.id} ${whole} = ${v} in "${out.slice(0, 70)}"`);
          }
          if (key === 'range' && !pct && typeof v === 'number' && metres) {
            n.range++;
            const want = metres.replace('::range::', String(v));
            if (!out.includes(want)) badNumbers.push(`${row.id} ${whole} wants "${want}" in "${out.slice(0, 70)}"`);
          }
          if (key === 'val' && (digits === '' || digits === '1') && pct
            && (row.affixes ?? []).length && (row.affixes ?? []).every((a) => !Object.keys(a.conds ?? {}).length)) {
            const a = row.affixes[0];
            const stack = cdb.byId('affix').get(a.ref)?.stack;
            const style = stack ? cdb.custom('AffixStacking', stack) : null;
            if (style?.case === 'Multiplicative' || (style?.case === 'Min' && style.args.base === 1)) {
              n.takesOff++;
              // printed unsigned unless the token asks for the sign, so a
              // 1.3 multiplier is "increased by 30%"
              const want = `${p2(Math.abs(1 - a.val) * 100)}%`;
              if (!out.includes(want)) badNumbers.push(`${row.id} ${whole} on ${a.ref} ${a.val} wants "${want}" in "${out.slice(0, 70)}"`);
            }
          }
        }
      }
    });
    check(`tooltip/skill: a fraction prints at two decimals (${n.fraction}), a multiplier as what it takes off (${n.takesOff}), a range in metres (${n.range})`,
      badNumbers.length === 0 && n.fraction > 0 && n.takesOff > 0 && n.range > 0,
      badNumbers.slice(0, 3).join(' | '));

    // texts.refs is three COLUMNS: a row that authors `ref2` answers ::ref2_..::
    // whether or not it authors `ref`.
    let ref2Tokens = 0;
    const lostRefs = [];
    every((row, t) => {
      if (!cdb.byId('skill').get(row.texts?.refs?.ref2)) return;
      const uses = pairs(row, t).some(([tmpl]) => /::-?ref2_/.test(tmpl));
      if (!uses) return;
      ref2Tokens++;
      if ((t.unresolved ?? []).some((u) => /^::-?ref2_/.test(u.token) && /status at that/.test(u.why))) lostRefs.push(row.id);
    });
    check(`tooltip/skill: a ::ref2_..:: token finds the row's ref2 (${ref2Tokens} rows use one)`,
      ref2Tokens > 0 && lostRefs.length === 0, lostRefs.join(','));

    // RANK. Four systems share the word. A Talent row counts points, and a
    // status a talent applies is read at ITS rank - so the blanket 3 this sweep
    // sent must have been clamped to the node's own maximum. Read literally it
    // dropped a one-point talent's `maxRank: 1` affixes and printed "by ?".
    const maxPoints = (id) => Math.max(1, cdb.byId('skill').get(id)?.props?.talent?.maxPoints ?? 1);
    const overRank = [];
    let talentRows = 0, borrowed = 0;
    every((row, t) => {
      if (t.rankKind !== 'talent') return;
      talentRows++;
      if (t.rankFrom) borrowed++;
      const owner = t.rankFrom ?? row.id;
      if (skillType(cdb.byId('skill').get(owner)) !== 'Talent' || !(t.rank >= 1 && t.rank <= maxPoints(owner))) {
        overRank.push(`${row.id}: rank ${t.rank} from ${owner} (max ${maxPoints(owner)})`);
      }
    });
    check(`tooltip/skill: a talent and the statuses it applies are read in talent points (${talentRows} rows, ${borrowed} of them statuses)`,
      talentRows > 0 && borrowed > 0 && overRank.length === 0, overRank.slice(0, 3).join(' | '));
    const lone = [];
    every((row, t) => {
      if ((row.texts?.rankDescs ?? []).length) return;
      if (!(t.ranks.length === 1 && t.ranks[0].desc === t.desc)) lone.push(row.id);
    });
    check('tooltip/skill: a row with no ladder answers one line, and it is the sentence itself',
      lone.length === 0, lone.slice(0, 5).join(','));

    // ...and with a build the rank is the build's: the points held in a node.
    const twoPoint = boot.talents.Rogue.nodes.filter((nd) => nd.maxPoints === 2).map((nd) => nd.id);
    const held = async (id, pts) => (await api('/api/tooltip/skill', {
      skill: id, rank: 3, loadout: bare('Rogue', {}, { talents: { [id]: pts } }), options: {},
    })).data;
    let differs = 0;
    const wrongPts = [];
    for (const id of twoPoint) {
      const [one, two] = [await held(id, 1), await held(id, 2)];
      if (one.rank !== 1 || two.rank !== 2 || one.rankKind !== 'talent') wrongPts.push(`${id}: ${one.rank}/${two.rank}`);
      if (one.desc !== two.desc) differs++;
    }
    check(`tooltip/skill: a two-point talent is described at the points the build holds (${twoPoint.length} Rogue nodes, ${differs} whose sentence moves)`,
      twoPoint.length > 0 && wrongPts.length === 0 && differs > 0, wrongPts.join(' | '));

    // UPGRADE PASSIVES, the fourth system. A weapon's stars unlock the skill
    // `<its type>_Upgrade` (st.item.Weapon.getWeaponUpgradeSkill resolves
    // exactly that id), and its rank is the index of the rarity the weapon
    // rolled - not the blanket mastery rank this sweep sends. The item tooltip
    // already prices the rider that way; the skill tooltip has to say the same
    // sentence at the same rank for every weapon type at every rarity, and has
    // to call a passive no star has unlocked what it is: not held.
    {
      const byType = new Map();
      for (const cls of boot.classes.map((c) => c.unit)) {
        const { data: c } = await api(`/api/catalog?class=${cls}&level=${MAX_LEVEL}`);
        for (const slot of ['Slot_Weapon1', 'Slot_Weapon2']) {
          for (const r of c.slots[slot] ?? []) {
            if (!cdb.byId('skill').get(`${r.type}_Upgrade`)) continue;
            const best = byType.get(r.type);
            if (!best || r.rarities.length > best[2].rarities.length) byType.set(r.type, [cls, slot, r]);
          }
        }
      }
      const upgradeRows = rows.filter((r) => /_Upgrade$/.test(r.id) && cdb.byId('itemType').get(r.id.replace(/_Upgrade$/, '')));
      const apart = [];
      let unlocked = 0, locked = 0, offMastery = 0;
      for (const [type, [cls, slot, r]] of byType) {
        for (const rar of r.rarities) {
          for (const stars of [rar.maxStars, 0]) {
            const { data: tip } = await api('/api/tooltip/item', {
              class: cls, charLevel: MAX_LEVEL, item: r.id, slot, rarity: rar.id, stars,
            });
            const { data: t } = await api('/api/tooltip/skill', {
              skill: `${type}_Upgrade`, rank: 3, options: {},
              loadout: bare(cls, { [slot]: { item: r.id, rarity: rar.id, stars } }),
            });
            const line = t.ranks?.[0];
            if (tip.upgrade) {
              unlocked++;
              if (tip.upgrade.rank !== 3) offMastery++;
              if (!(t.rankKind === 'upgrade' && t.rank === tip.upgrade.rank && t.desc === tip.upgrade.desc
                && line?.active === true && line.rank === t.rank)) {
                apart.push(`${r.id} ${rar.id} ${stars}*: item rank ${tip.upgrade.rank} "${tip.upgrade.desc}" vs skill ${t.rankKind} ${t.rank} "${t.desc}"`);
              }
            } else {
              locked++;
              if (!(t.rankKind === 'upgrade' && t.rank === 0 && line?.active === false)) {
                apart.push(`${r.id} ${rar.id} ${stars}*: no rider on the item, skill ${t.rankKind} rank ${t.rank} active ${line?.active}`);
              }
            }
          }
        }
      }
      check(`tooltip/skill: a weapon's upgrade passive is read at its weapon's rarity, in the item tooltip's own words (${byType.size} of ${upgradeRows.length} types; ${unlocked} unlocked, ${offMastery} of them not at the mastery rank; ${locked} locked)`,
        byType.size > 0 && unlocked > 0 && offMastery > 0 && locked > 0 && apart.length === 0,
        apart.slice(0, 3).join(' | '));
    }

    // INFUSIONS. An InfusionPassive row's ladder is its set bonuses as the
    // game's own panel prints them: line r is titled text.infusion_rank filled
    // with Item_InfusionCaps[r-1], and carries the row's sentence for that rank
    // plus each affix that STARTS there (conds.minRank == r; an affix with no
    // rank condition starts at 1). The affix line is the `affix` row's
    // template: TAttribute_Flat is "::s_atb_value:: [::target::]" - signed, and
    // a percentage when the target attribute is flagged Percent -
    // TAttribute_ARatio is "::s_percent_value:: [::target::]".
    const caps = cdb.constantFloats('Item_InfusionCaps');
    const title = cdb.byId('text').get('infusion_rank')?.value?.text;
    const signed = (v) => (v >= 0 ? '+' : '');
    const affixText = (a) => {
      const attr = cdb.byId('attribute').get(a.target?.attribute);
      const pct = cdb.flagNames('attribute', 'flags', attr?.flags).includes('Percent');
      if (a.ref === 'TAttribute_Flat') return `${signed(a.val)}${p2(a.val)}${pct ? '%' : ''} ${attrName(attr?.id)}`;
      if (a.ref === 'TAttribute_ARatio') return `${signed(a.val)}${p2(a.val * 100)}% ${attrName(attr?.id)}`;
      return null;
    };
    const infusions = rows.filter((r) => skillType(r) === 'InfusionPassive');
    const badSets = [];
    let affixLines = 0;
    for (const row of infusions) {
      const t = tips.get(row.id);
      if (!t) continue;
      const say = (why) => badSets.push(`${row.id}: ${why}`);
      if (t.rankKind !== 'infusion') say(`rankKind ${t.rankKind}`);
      if (JSON.stringify(t.ranks.map((r) => r.pieces)) !== JSON.stringify(caps)) say(`pieces ${t.ranks.map((r) => r.pieces)}`);
      t.ranks.forEach((r, i) => { if (r.title !== title?.replace('::rank::', String(caps[i]))) say(`title "${r.title}"`); });
      for (const a of row.affixes ?? []) {
        const want = affixText(a);
        if (!want) continue;
        const at = a.conds?.minRank ?? a.conds?.equalRank ?? 1;
        affixLines++;
        t.ranks.forEach((r, i) => {
          const has = String(r.desc).split('\n').includes(want);
          if (has !== (i + 1 === at)) say(`"${want}" ${has ? 'printed' : 'missing'} on set ${i + 1} (starts at ${at})`);
        });
      }
    }
    check(`tooltip/skill: an infusion's ladder is its ${caps.join('/')} set bonuses, each stat line on the set that starts it (${infusions.length} infusions, ${affixLines} stat lines)`,
      infusions.length > 0 && affixLines > 0 && !!title && badSets.length === 0, badSets.slice(0, 3).join(' | '));

    // A set line is never served hiddenWhenMerged. Some infusions author the
    // flag on their empty second SENTENCE, and the line served there is that
    // sentence plus the stat line that starts at the set - the only place the
    // bonus is stated - which the game's panel prints whatever the flag says.
    const flagged = infusions.filter((row) => (row.texts?.rankDescs ?? []).some((rd) => (rd?.flags ?? 0) & 1));
    const hiddenSets = infusions.flatMap((row) => (tips.get(row.id)?.ranks ?? [])
      .filter((r) => r.hiddenWhenMerged).map((r) => `${row.id} ${r.title}: "${r.desc}"`));
    check(`tooltip/skill: no set line of an infusion is marked hiddenWhenMerged (${flagged.length} infusions author the flag on a rank sentence)`,
      flagged.length > 0 && hiddenSets.length === 0, hiddenSets.slice(0, 3).join(' | '));

    // Its rank is the number of caps the worn pieces reach
    // ($HInfusion.getRankFromStacks), counted off gear[slot].infusion.
    if (infusions.length) {
      const { data: c } = await api(`/api/catalog?class=Mage&level=${MAX_LEVEL}`);
      const epic = boot.rarities.findIndex((r) => r.id === cdb.constant('Item_InfusionMinRarity')?.other?.rarity);
      const rank = new Map(boot.rarities.map((r, i) => [r.id, i]));
      const wearable = Object.entries(c.slots)
        .map(([slot, list]) => [slot, list.find((r) => r.faction && rank.get(r.rarities[0].id) >= epic && !r.skills.length)])
        .filter(([slot, r]) => r && /^Slot_(Head|Shoulders|Chest|Back|Hands|Waist|Legs|Feet)$/.test(slot));
      const id = infusions[0].id;
      const wrongRank = [];
      for (let pieces = 0; pieces <= Math.min(wearable.length, caps.at(-1)); pieces++) {
        const gear = Object.fromEntries(wearable.slice(0, pieces).map(([slot, r]) => [slot, { item: r.id, infusion: id }]));
        const { data: t } = await api('/api/tooltip/skill', { skill: id, rank: 3, loadout: bare('Mage', gear), options: {} });
        const want = caps.filter((cap) => cap <= pieces).length;
        const lit = (t.ranks ?? []).filter((r) => r.active).length;
        if (t.rank !== want || lit !== want) wrongRank.push(`${pieces} pieces -> rank ${t.rank}, ${lit} lit (want ${want})`);
      }
      check(`tooltip/skill: an infusion's rank is the caps its worn pieces reach (0..${Math.min(wearable.length, caps.at(-1))} pieces of ${id})`,
        wearable.length >= caps.at(-1) && epic >= 0 && wrongRank.length === 0, wrongRank.join(' | ') || `${wearable.length} infusable slots found`);

      // (That a piece the game cannot infuse is never counted is held in the
      // infusion block above: such a build is refused as illegal, by name,
      // before any rank is read.)
    }
  }

  // --- tooltip: Censer Rare 3* (the catalog.md worked example) --------------
  {
    const { data: t } = await api('/api/tooltip/item', {
      class: 'Mage', charLevel: 25, item: 'Staff_Censer',
      slot: 'Slot_Weapon1', rarity: 'Rare', stars: 3,
    });
    const want = {
      Intellect: 18, Faith: 15, Vitality: 40, CritChanceRating: 39, FervorRating: 39,
    };
    const got = Object.fromEntries((t.affixes ?? []).map((a) => [a.attr, a.value]));
    check('tooltip: Censer Rare 3* bake exact',
      JSON.stringify(Object.entries(want).sort()) === JSON.stringify(Object.entries(got).sort()),
      JSON.stringify(got));
    const disp = new Set((t.affixes ?? []).map((a) => a.display));
    check('tooltip: display lines use attribute names',
      ['+18 Intellect', '+15 Faith', '+40 Vitality', '+39 Critical', '+39 Fervor']
        .every((x) => disp.has(x)),
      [...disp].join(' | '));
    check('tooltip: iLevel 290 / stars 3 of 3',
      t.iLevel === 290 && t.stars === 3 && t.maxStars === 3,
      `iLevel ${t.iLevel}, ${t.stars}/${t.maxStars}`);
    // Both numbers are the WeaponPower rule as READ on build 25782799
    // (damage.mjs `weaponPowerFor` / `scalingValue`), not a measurement:
    //   flat  = 0.4 x mean(Wizard's Intellect curve 148.296, Cleric's Faith
    //           curve 123.580) = 54.375
    //   swing = 0.175 x (54.375 + 0.6 x mean budget 135.938) = 23.79, +-10%
    // The accepted 2026-08-11 build summed the two curves and added the mean
    // whole: 108.75 and '≈39–47 per swing'.
    check('tooltip: weaponPower ~54.38 (read from the bytecode, not measured)',
      Math.abs((t.weaponPower ?? 0) - 54.375) < 0.05, String(t.weaponPower));
    check('tooltip: damage line', t.damageLine === '≈21–26 per swing', t.damageLine);
  }

  // --- optimize: fast config, pinned mainhand, SSE, round-trip --------------
  {
    const loadout = {
      class: 'Mage', level: 25,
      gear: { Slot_Weapon1: { item: 'Staff_Censer', rarity: 'Legendary', stars: 5 } },
      augments: {}, skills: {}, runes: {}, talents: {},
    };
    const { data: startData } = await api('/api/optimize/start', {
      loadout,
      pins: { gear: ['Slot_Weapon1'], augments: [], skills: [], runes: [], talents: false },
      options: {
        goal: 'dps', target: 'boss', fight: 60, lookahead: 0, restarts: 1,
        rank: 3, mix: 0.5,
      },
    });
    check('optimize: job started', typeof startData.job === 'string', startData.job);

    const events = [];
    const t0 = Date.now();
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 120000);
    let done = null;
    try {
      const res = await fetch(`${base}/api/optimize/events?job=${startData.job}`, {
        signal: ctl.signal,
      });
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = /^event: (\S+)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (!ev) continue; // heartbeat comment
          events.push({ event: ev, data: data ? JSON.parse(data) : null });
          if (ev === 'done' || ev === 'error') { done = events.at(-1); ctl.abort(); }
        }
        if (done) break;
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
    clearTimeout(timeout);
    const elapsed = (Date.now() - t0) / 1000;

    const progress = events.filter((e) => e.event === 'progress');
    check('optimize: >=1 progress event', progress.length >= 1,
      `${progress.length} events, last evals=${progress.at(-1)?.data?.evals}`);
    check('optimize: done within 120s', done?.event === 'done',
      done ? `${done.event} after ${elapsed.toFixed(1)}s` : `no terminal event in ${elapsed.toFixed(1)}s`);

    if (done?.event === 'done') {
      const { envelope, view, score, search } = done.data;
      const gear = envelope?.build?.gear ?? {};
      const filled = Object.values(gear).filter((g) => g?.item).length;
      check('optimize: envelope gear filled', filled >= 12 && gear.Slot_Weapon1?.item === 'Staff_Censer',
        `${filled} slots, weapon1=${gear.Slot_Weapon1?.item}`);
      check('optimize: view damage rows', (view?.damage?.rows?.length ?? 0) > 0,
        `${view?.damage?.rows?.length} rows, dps ${view?.dps?.toFixed(1)}, score ${score?.toFixed(1)}`);

      mkdirSync(SCRATCH, { recursive: true });
      const envFile = join(SCRATCH, 'check-api-envelope.json');
      writeFileSync(envFile, JSON.stringify(envelope, null, 2));
      const rt = await new Promise((resolve) => {
        execFile(process.execPath, [join(ROOT, 'bin', 'bench.mjs'), 'sheet', '--build', envFile],
          { timeout: 120000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
          });
      });
      check('optimize: envelope round-trips through bench sheet --build',
        rt.code === 0, rt.code === 0 ? envFile : rt.stderr.trim().split('\n').pop());

      // WHAT THE SEARCH WAS ALLOWED TO DO comes back beside the build. This
      // request named no infusion option and sent no `pins.infusions`, so it
      // is the model's default on every count: every infusion the install
      // does not show to be unobtainable was offered, the others withheld with
      // the source reader's sentence, no bonus roll assumed, and each pinned
      // piece's infusion held as stated.
      const learnable = infusionDefs.filter((x) => x.obtainable).map((x) => x.id);
      const shut = infusionDefs.filter((x) => !x.obtainable);
      const s = search?.infusions;
      check(`optimize: the search says what it offered - ${learnable.length} of ${infusionDefs.length} infusions, the rest withheld with their reason`,
        JSON.stringify(s?.offered?.map((x) => x.id)) === JSON.stringify(learnable) && s.total === infusionDefs.length
        && JSON.stringify(s.withheld.map((w) => [w.id, w.why])) === JSON.stringify(shut.map((x) => [x.id, x.source.why]))
        && s.offered.every((x) => x.name === infusionDefs.find((b) => b.id === x.id).name)
        && s.statPolicy === 'none',
        JSON.stringify(s && { offered: s.offered.length, withheld: s.withheld.map((w) => w.name), stat: s.statPolicy }));
      check('optimize: a request that names no infusion pins holds every pinned piece\'s infusion as stated',
        JSON.stringify(s?.pinned) === JSON.stringify(['Slot_Weapon1']), JSON.stringify(s?.pinned));
      // ...and the envelope records the same, in the CLI's own fields.
      check('optimize: the envelope records the offered infusions, the roll policy and the infusion pins',
        JSON.stringify(envelope.infusionSearch) === JSON.stringify({ offered: learnable, stat: 'none' })
        && !!s && JSON.stringify(envelope.pinned.infusions) === JSON.stringify(s.pinned)
        && JSON.stringify(Object.keys(envelope.infusions ?? {})) === JSON.stringify(['sets', 'pieces']),
        JSON.stringify([envelope.infusionSearch, envelope.pinned]).slice(0, 160));

      // The search plans sets, on pieces that can carry them, from what it was
      // offered - and the view counts the build it was handed: each set's rank
      // is the caps its pieces reach.
      const caps = CAPS;
      const infused = Object.entries(gear).filter(([, g]) => g.infusion);
      const count = new Map();
      for (const [, g] of infused) count.set(g.infusion, (count.get(g.infusion) ?? 0) + 1);
      const offRank = (view.infusions?.sets ?? []).filter((x) => x.pieces !== count.get(x.id)
        || x.rank !== caps.filter((cap) => cap <= x.pieces).length);
      check(`optimize: the search infuses pieces that can be, with infusions it was offered, and the view's set ranks are the caps their pieces reach (${[...count].map(([id, n]) => `${n} x ${id}`).join(', ') || 'none'})`,
        infused.length > 0 && infused.every(([, g]) => gameInfusable(g.item) && learnable.includes(g.infusion))
        && view.infusions?.sets?.length === count.size && offRank.length === 0
        && view.infusions.sets.some((x) => x.rank >= 1),
        JSON.stringify(view.infusions?.sets?.map((x) => [x.id, x.pieces, x.rank])));

      // WITHHELD GEAR. The search lists from the same catalog the picker does:
      // it wears nothing the catalog withholds, and it says which rows it was
      // not offered - the same rows, with the same sentences, /api/catalog
      // withholds from this class at this level.
      const { data: cat25 } = await api(`/api/catalog?class=Mage&level=${MAX_LEVEL}`);
      const heldRows = new Map(Object.values(cat25.withheld ?? {}).flat().map((r) => [r.id, r.withheld.why]));
      const wornHeld = Object.values(gear).map((g) => g.item).filter((id) => heldRows.has(id));
      const said = new Map((search?.gear?.withheld ?? []).map((w) => [w.id, w.why]));
      check(`optimize: the build wears no row the catalog withholds, and the answer names the ${heldRows.size} it was not offered, each with the catalog's sentence`,
        heldRows.size > 0 && wornHeld.length === 0 && said.size === heldRows.size
        && [...heldRows].every(([id, why]) => said.get(id) === why) && search?.gear?.includeUnreleased === false,
        wornHeld.length ? `worn: ${wornHeld.join(',')}` : `${said.size} named of ${heldRows.size}`);

      // FIELD FOR FIELD THE CLI'S. The same envelope, fed back to the CLI's own
      // optimizer and written out again: the two files have the same fields in
      // the same order, and the CLI re-pinned and re-offered exactly what the
      // page's search held and offered.
      const outFile = join(SCRATCH, 'check-api-envelope-cli.json');
      const again = await new Promise((resolve) => {
        execFile(process.execPath, [join(ROOT, 'bin', 'bench.mjs'), 'optimize', '--build', envFile, '--json', outFile, '--restarts', '1'],
          { timeout: 240000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stderr }));
      });
      let cli = null;
      try { cli = JSON.parse(readFileSync(outFile, 'utf8')); } catch { /* reported below */ }
      check('optimize: bench optimize --build reads the envelope back and writes one with the same fields, pins and offered infusions',
        again.code === 0 && !!cli
        && JSON.stringify(Object.keys(cli)) === JSON.stringify(Object.keys(envelope))
        && JSON.stringify(cli.pinned) === JSON.stringify(envelope.pinned)
        && JSON.stringify(cli.infusionSearch) === JSON.stringify(envelope.infusionSearch),
        again.code !== 0 ? again.stderr.trim().split('\n').pop()
          : `ui only: ${Object.keys(envelope).filter((k) => !(k in (cli ?? {}))).join(',') || '-'}; cli only: ${Object.keys(cli ?? {}).filter((k) => !(k in envelope)).join(',') || '-'}`);
    }
  }

  // --- optimize: the infusion pins and options travel ------------------------
  // Three slots pinned three ways - "this infusion", "no infusion", and "this
  // piece, infuse it as you like" - and the search has to honour each. The
  // worker forwards a hand-written option list, so each of these was one
  // forgotten key away from the model's default.
  {
    const { data: c } = await api(`/api/catalog?class=Mage&level=${MAX_LEVEL}`);
    const pick = (slot) => c.slots[slot].find((r) => gameInfusable(r.id));
    const [chest, legs, head] = [pick('Slot_Chest'), pick('Slot_Legs'), pick('Slot_Head')];
    // an infusion a lone pinned piece gains nothing by: left free, the search
    // would move it into a set
    const kept = infusionDefs.find((x) => x.obtainable && x.faction !== originOf(chest.id));
    const stat = poolOf(chest.id)[0];
    const run = await runJob({
      loadout: bare('Mage', {
        Slot_Chest: { item: chest.id, infusion: kept.id, infusionStat: stat },
        Slot_Legs: { item: legs.id },
        Slot_Head: { item: head.id },
      }),
      pins: { gear: ['Slot_Chest', 'Slot_Legs', 'Slot_Head'], augments: [], skills: [], runes: [], talents: false,
        infusions: ['Slot_Chest', 'Slot_Legs'] },
      options: { goal: 'dps', target: 'boss', fight: 60, lookahead: 0, restarts: 1, rank: 3, mix: 0.5 },
    });
    const g = run.done?.data?.envelope?.build?.gear ?? {};
    const free = Object.entries(g).filter(([slot, e]) => e.infusion && !['Slot_Chest', 'Slot_Legs'].includes(slot));
    check(`optimize: a pinned infusion is kept (${kept.name} on the chest, with its roll), a pinned "none" stays none, and the rest is planned`,
      run.done?.event === 'done'
      && g.Slot_Chest?.item === chest.id && g.Slot_Chest.infusion === kept.id && g.Slot_Chest.infusionStat === stat
      && g.Slot_Legs?.item === legs.id && !g.Slot_Legs.infusion
      && g.Slot_Head?.item === head.id && free.length > 0,
      run.done ? `${run.done.event} after ${run.elapsed.toFixed(1)}s: chest ${g.Slot_Chest?.infusion}/${g.Slot_Chest?.infusionStat}, legs ${g.Slot_Legs?.infusion ?? 'none'}, ${free.length} other infused`
        : 'no terminal event');
    check('optimize: and the answer and the envelope name exactly the two slots whose infusion was pinned',
      JSON.stringify([...(run.done?.data?.search?.infusions?.pinned ?? [])].sort()) === JSON.stringify(['Slot_Chest', 'Slot_Legs'])
      && JSON.stringify([...(run.done?.data?.envelope?.pinned?.infusions ?? [])].sort()) === JSON.stringify(['Slot_Chest', 'Slot_Legs']),
      JSON.stringify(run.done?.data?.search?.infusions?.pinned));
  }
  {
    // `infusions: "none"` turns the plan off, and `includeUnreleased` re-admits
    // the rows nothing hands out. Proof of the second, as for `exclude` below:
    // shut every OFFERED row of a slot that has a withheld one, and the search
    // has to fill it from the withheld.
    const { data: c } = await api(`/api/catalog?class=Mage&level=${MAX_LEVEL}`);
    const [slot, rows] = Object.entries(c.withheld ?? {})
      .find(([, list]) => list.some((r) => r.withheld.kind === 'unreleased')) ?? [];
    const unreleased = (rows ?? []).filter((r) => r.withheld.kind === 'unreleased').map((r) => r.id);
    check('optimize: this class has a slot with a row nothing hands out', unreleased.length > 0, `${slot}: ${unreleased.join(', ')}`);
    if (unreleased.length) {
      const run = await runJob({
        loadout: bare('Mage'),
        pins: { gear: [], augments: [], skills: [], runes: [], talents: false, infusions: [] },
        options: {
          goal: 'dps', target: 'boss', fight: 60, lookahead: 0, restarts: 1, rank: 3, mix: 0.5,
          infusions: 'none', includeUnreleased: true,
          exclude: `^(${c.slots[slot].map((r) => r.id).join('|')})$`,
        },
      });
      const d = run.done?.data;
      const got = d?.envelope?.build?.gear?.[slot]?.item;
      check(`optimize: with includeUnreleased and every offered ${slot.replace('Slot_', '')} row shut, the search wears one of the withheld (${unreleased.join(', ')})`,
        run.done?.event === 'done' && unreleased.includes(got)
        && d.search?.gear?.includeUnreleased === true && !d.search.gear.withheld.some((w) => w.kind === 'unreleased'),
        run.done ? `${run.done.event} after ${run.elapsed.toFixed(1)}s: ${slot} = ${got ?? 'empty'}` : 'no terminal event');
      const anyInfused = Object.values(d?.envelope?.build?.gear ?? {}).filter((e) => e.infusion).length;
      check('optimize: and with infusions "none" nothing is infused and nothing is recorded as offered',
        run.done?.event === 'done' && anyInfused === 0
        && d.envelope.infusionSearch?.offered?.length === 0 && d.search?.infusions?.offered?.length === 0
        && d.view.infusions?.sets?.length === 0,
        `${anyInfused} pieces infused, ${d?.envelope?.infusionSearch?.offered?.length} offered`);
    }
  }

  // --- optimize: the search sees what the picker lists ----------------------
  // The worker used to hard-code `exclude: /^GM_/` and ignore the request's
  // own. The one item that pattern matches is a real weapon the catalog lists
  // (itemType GreatMace), so the user could equip it and the optimizer could
  // never suggest it. Proof that both halves are gone: exclude every OTHER
  // weapon a Warrior can hold, and the search has to hand back that one.
  {
    const { data: w } = await api(`/api/catalog?class=Warrior&level=${MAX_LEVEL}`);
    const weapons = [...new Set([...w.slots.Slot_Weapon1, ...w.slots.Slot_Weapon2,
      ...w.slots.Slot_OffhandWeapon].map((r) => r.id))];
    const hidden = w.slots.Slot_Weapon1.map((r) => r.id).filter((id) => /^GM_/.test(id));
    check('optimize: the catalog lists a mainhand the old hard-coded filter hid',
      hidden.length > 0, hidden.map((id) => `${id} "${cdb.byId('item').get(id)?.texts?.name}"`).join(', '));
    if (hidden.length) {
      const only = hidden[0];
      const run = await runJob({
        loadout: bare('Warrior'),
        pins: { gear: [], augments: [], skills: [], runes: [], talents: false },
        options: {
          goal: 'dps', target: 'boss', fight: 60, lookahead: 0, restarts: 1, rank: 3, mix: 0.5,
          exclude: `^(${weapons.filter((id) => id !== only).join('|')})$`,
        },
      });
      const got = run.done?.data?.envelope?.build?.gear?.Slot_Weapon1?.item;
      check(`optimize: with every other weapon excluded the search equips ${only}`,
        run.done?.event === 'done' && got === only,
        run.done ? `${run.done.event} after ${run.elapsed.toFixed(1)}s: main hand ${got ?? JSON.stringify(run.done.data).slice(0, 80)}`
          : `no terminal event (start: ${JSON.stringify(run.start).slice(0, 80)})`);
    }
  }
} finally {
  await close();
}

console.log(failed
  ? `${failed} check(s) FAILED${warned ? `, ${warned} warned` : ''}`
  : `all checks passed${warned ? ` (${warned} warned - icons.mjs pending)` : ''}`);
process.exit(failed ? 1 : 0);
