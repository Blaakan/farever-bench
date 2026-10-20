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
//
// THE GUARD and IMPORT blocks hold the server's door and its one way in for a
// file. The guard's refusals are sent over node:http, not fetch, because they
// need what fetch will not send: a foreign Host, a text/plain body, a 41 MB
// upload that must come back as a 413 SENTENCE and not a connection reset.
// The guard also holds api.mjs to its own rule that a route is a ROUTES row
// AND a case, read off the source, so a forgotten row is named here rather
// than found as a route that answers 404. The import is held to the reader
// behind `bench import`: the documented examples read with nothing dropped,
// the build a search hands back reads back as the same build with every pin
// the run held - runes and talents included, which a saved build once lost -
// and the modkit dump asks for its class.
//
// THE SUBMIT block holds "Send a fight" (/api/submit/*) to src/submit.mjs and
// to its own promises: a preview of the documented examples names nobody in
// the manual route's title, the bundle is the fixed entries and its manifest
// carries the SHA-256 of the delete token, never the token, a send needs
// consent and a held preview, uploads the zip once - byte for byte, as
// <id>.zip, through pCloud's uploadtolink with the link's code, the uploader
// name farever-bench and nopartial=1, and no header of the bench's own - and
// hands back a receipt that asks for its deletion; and a send whose answer
// is lost hands the receipt back too and keeps the very same bundle for Send
// again, past any number of newer previews. The receipt is on disk before
// the zip leaves (the stand-in reads the bench's folder when the upload
// arrives), a folder it cannot be kept in stops the send, and a bundle built
// again from its receipt (`again`) is the same zip, byte for byte - other
// files under its id are refused. One built again from a receipt whose
// fight arrived, or one of another upload link, is not sent - the module's
// rules, which `bench submit --receipt <it> --send` asks too. A refusal
// pCloud answers (the folder full, its store down) hands back no receipt and
// takes nothing kept earlier away. Delete uploads <id>.withdraw.json, the
// receipt's id and token, whose SHA-256 is the manifest's, and a receipt of
// another link is refused before anything leaves, and so is a deletion asked
// while that submission is being sent. The submit routes keep the guard's
// door; the preview takes the file routes' 40 MB and the others 1 MB; and a
// server bound beyond this machine refuses every one of them - one started
// here configured so (host 0.0.0.0) while it listens on 127.0.0.1 alone,
// so no port opens to the network. Send refuses a sheet of another class
// than the log's by the module's rule, as `bench submit --send` does; it
// sends one a file that names its
// own class was vouched for by the class chosen beside it, never a modkit
// dump read as the class chosen for it; and Save .zip still saves either.
// Every report line a reader warns of carries the module's `warn`. The build
// in the editor goes as what its pins state, written by the module - an
// empty slot nobody pinned is not recorded - and the page is told when it
// wears nothing, none of the weapons the log's character fought with, or
// holds what no pin states. pCloud is a stand-in server on 127.0.0.1 started
// here (FAREVER_BENCH_UPLOAD_LINK), never the real one, and the receipts a
// run makes the bench keep go with it.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { tmpdir } from 'node:os';
import { existsSync, writeFileSync, mkdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadCdb } from '../../src/cdb.mjs';
import { header } from '../../src/format.mjs';
import { createEngine } from '../../src/engine.mjs';
import { readSheet, reportLines, reportItems as sheetReportItems } from '../../src/charsheet.mjs';
import { readZip, SHEET_MAX_BYTES, LOG_MAX_BYTES, NOTE_MAX, SEND_TIMEOUT_MS } from '../../src/submit.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRATCH = join(tmpdir(), 'farever-bench-checks');
// The server this boots decodes icons into a disk cache, and a self-test does
// not get to fill (or trust) the repo's own - it uses one beside its other
// scratch files unless the caller already named one.
process.env.FAREVER_BENCH_CACHE ??= join(SCRATCH, 'check-api-cache');
// A self-test never sends a fight anywhere real: no upload link at all,
// whatever src/submit.mjs's UPLOAD_LINK or the caller's environment say,
// until the SUBMIT block points the server at its own pCloud stand-in on
// 127.0.0.1.
process.env.FAREVER_BENCH_UPLOAD_LINK = 'none';

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

const { startServer, submitOffFor } = await import(pathToFileURL(join(ROOT, 'ui', 'server.mjs')).href);
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

// One request with exactly the headers given (fetch picks its own Host and
// refuses to send some), and what came back - or the socket error, which is
// the thing a 413 must NOT be.
const raw = (method, path, headers = {}, body = null) => new Promise((resolvePromise) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON: data stays null */ }
      resolvePromise({ status: res.statusCode, headers: res.headers, data, text });
    });
  });
  req.on('error', (e) => resolvePromise({ status: null, error: e.code ?? e.message }));
  if (body != null) req.write(body);
  req.end();
});

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
// The fields of a pin set, as /api/optimize/start takes them and /api/import
// gives them back.
const PIN_FIELDS = ['gear', 'augments', 'skills', 'runes', 'talents', 'infusions'];
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

  // --- the guard: who may call /api/ ----------------------------------------
  // Any page the user has open can aim a request at this port, and one on a
  // name that resolves to 127.0.0.1 is same-origin with it as far as the
  // browser knows. Each refusal comes before any route runs, and is a
  // sentence like every other error - a 413 included, which used to be a
  // reset socket because the server destroyed it mid-upload.
  {
    const JSON_TYPE = { 'content-type': 'application/json' };
    const minimal = readFileSync(join(ROOT, 'docs', 'examples', 'sheet-minimal.json'), 'utf8');
    const importBody = JSON.stringify({ file: { name: 'sheet-minimal.json', text: minimal } });
    const refused = async (what, [method, path, headers, body], status, about) => {
      const r = await raw(method, path, headers, body);
      check(`${status}: ${what}`, r.status === status && typeof r.data?.error === 'string' && about.test(r.data.error),
        r.status == null ? `no answer: ${r.error}` : `HTTP ${r.status} ${r.text.slice(0, 160)}`);
      return r;
    };
    const m = await refused('a POST route asked with GET', ['GET', '/api/sheet', {}], 405, /^\/api\/sheet takes POST, not GET$/);
    check('405: ...with an Allow header naming the one method it takes', m.headers?.allow === 'POST', m.headers?.allow);
    await refused('a CORS preflight, which this server never approves',
      ['OPTIONS', '/api/import', { origin: 'https://example.com', 'access-control-request-method': 'POST' }], 405, /^\/api\/import takes POST, not OPTIONS$/);
    await refused('a GET route asked with POST', ['POST', '/api/bootstrap', JSON_TYPE, '{}'], 405, /^\/api\/bootstrap takes GET, not POST$/);
    await refused('a POST to a static file', ['POST', '/index.html', JSON_TYPE, '{}'], 405, /takes GET, not POST/);
    await refused('an import from a foreign Origin', ['POST', '/api/import', { ...JSON_TYPE, origin: 'https://example.com' }, importBody],
      403, /^a page from https:\/\/example\.com may not call this server/);
    await refused('an import addressed to a foreign Host (DNS rebinding: Host and Origin agree, and both are not this server)',
      ['POST', '/api/import', { ...JSON_TYPE, host: `rebound.example:${port}`, origin: `http://rebound.example:${port}` }, importBody],
      403, new RegExp(`^this server answers requests addressed to 127\\.0\\.0\\.1:${port}, localhost:${port}, \\[::1\\]:${port} - not to "rebound\\.example:${port}"`));
    await refused('...and a GET as well, since bootstrap names the install folder', ['GET', '/api/bootstrap', { host: `rebound.example:${port}` }],
      403, /^this server answers requests addressed to/);
    await refused('an import sent as text/plain, the type a page can send with no preflight',
      ['POST', '/api/import', { 'content-type': 'text/plain' }, importBody], 415,
      /^\/api\/import takes a JSON body \(content-type: application\/json\), not "text\/plain"$/);
    await refused('an import with no content type', ['POST', '/api/import', {}, importBody], 415, /not a body with no content type$/);
    await refused('a 1.5 MB body on a loadout route: drained, then answered with the sentence',
      ['POST', '/api/sheet', JSON_TYPE, JSON.stringify({ pad: 'x'.repeat(1.5 * 1024 * 1024) })], 413,
      /^the request body is 1\.5 MB, and \/api\/sheet takes at most 1 MB - none of it was read$/);
    await refused('a 41 MB body on the import route: drained, then answered with the sentence',
      ['POST', '/api/import', JSON_TYPE, JSON.stringify({ pad: 'x'.repeat(41 * 1024 * 1024) })], 413,
      /^the request body is 41 MB, and \/api\/import takes at most 40 MB - none of it was read$/);
    // One byte over: both sizes round to "40 MB", and the sentence must not
    // say the body is the size it is allowed to be.
    await refused('a body one byte over the 40 MB cap says "more than", not "40 MB, and ... at most 40 MB"',
      ['POST', '/api/import', JSON_TYPE, `{"pad":"${'x'.repeat(40 * 1024 * 1024 + 1 - 10)}"}`], 413,
      /^the request body is more than 40 MB, and \/api\/import takes at most 40 MB - none of it was read$/);
    await refused('a static path with a malformed %-escape is the request\'s fault, not a 500',
      ['GET', '/%E0%A4%A', {}], 400, /^bad url: \/%E0%A4%A has a %-escape that is not one$/);
    // A route is a ROUTES row (the guard's method, Origin and type checks,
    // and whether a body is read) AND a case in handle. A case with no row
    // answers 404 rather than run unguarded; this names the forgotten half
    // before anyone calls it.
    {
      const src = readFileSync(join(ROOT, 'ui', 'api.mjs'), 'utf8');
      const rows = [...(/const ROUTES = new Map\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? '').matchAll(/\['(\/api\/[^']+)', '(?:GET|POST)'\]/g)]
        .map((x) => x[1]).sort();
      const cases = [...src.matchAll(/case '(\/api\/[^']+)':/g)].map((x) => x[1]).sort();
      check('routes: every case in api.mjs handle has its ROUTES row, and every row its case',
        rows.length > 0 && JSON.stringify(rows) === JSON.stringify(cases),
        `no row: ${cases.filter((c) => !rows.includes(c)).join(', ') || '-'}; no case: ${rows.filter((r) => !cases.includes(r)).join(', ') || '-'}`);
    }
    // The page itself gets in, under either loopback name, sending its own
    // Origin as a browser does.
    for (const name of ['127.0.0.1', 'localhost']) {
      const r = await raw('POST', '/api/import', { ...JSON_TYPE, host: `${name}:${port}`, origin: `http://${name}:${port}` }, importBody);
      check(`200: an import from the page's own origin, addressed as ${name}`, r.status === 200 && r.data?.unit === 'Warrior',
        `HTTP ${r.status} ${r.text?.slice(0, 120)}`);
    }
    const { status } = await api('/api/bootstrap');
    check('the server still answers after the over-cap bodies', status === 200, `HTTP ${status}`);
  }

  // --- import: a character file into the editor -----------------------------
  // POST /api/import is `bench import`'s reader behind a route: the answer
  // must be what readSheet makes of the same bytes (the witness engine reads
  // them here too), the documented examples must read with nothing dropped,
  // and a loadout it hands back must price as it is.
  {
    const imp = (body) => api('/api/import', body);
    const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
    for (const f of ['sheet-full.json', 'sheet-minimal.json']) {
      const text = readFileSync(join(ROOT, 'docs', 'examples', f), 'utf8');
      const { status, data: r } = await imp({ file: { name: f, text } });
      const w = readSheet(witness, text);
      check(`import: docs/examples/${f} reads with nothing dropped, nothing unknown, nothing unreadable`,
        status === 200 && r.format === 'farever-character-sheet' && r.dropped?.length === 0
        && r.unknownKeys?.length === 0 && r.unreadable?.length === 0,
        `HTTP ${status} ${JSON.stringify(r?.dropped ?? r).slice(0, 160)}`);
      check(`import: ...as the reader behind bench import reads it - loadout, pins, rank and the report lines`,
        status === 200 && canon(r.loadout) === canon(w.loadout) && canon(r.pins) === canon(w.pins)
        && r.rank === w.rank && r.unit === w.unit && r.level === w.level
        && JSON.stringify(r.report) === JSON.stringify(reportLines(w)),
        `${r?.report?.[0]} / ${r?.report?.length} lines`);
      check(`import: ...and the same lines as items, each with the reader's kind - what the page marks a line by`,
        status === 200 && JSON.stringify(r.reportItems) === JSON.stringify(sheetReportItems(w))
        && JSON.stringify(r.reportItems.map((i) => i.text)) === JSON.stringify(r.report),
        `${JSON.stringify(r?.reportItems?.slice(0, 2))}`);
      const s = await api('/api/sheet', { loadout: r.loadout, options: { rank: r.rank ?? 3 } });
      check(`import: ...and its loadout prices as it is - not illegal, a number`,
        s.status === 200 && !s.data.illegal && Number.isFinite(s.data.dps) && s.data.dps > 0,
        `HTTP ${s.status} ${s.data.illegal ?? s.data.dps}`);
    }
    const fullBytes = readFileSync(join(ROOT, 'docs', 'examples', 'sheet-full.json'));
    const asText = (await imp({ file: { name: 'sheet-full.json', text: fullBytes.toString('utf8') } })).data;
    const asBytes = await imp({ file: { name: 'sheet-full.json', base64: fullBytes.toString('base64') } });
    check('import: the same file sent as base64 reads the same as sent as text',
      asBytes.status === 200 && canon(asBytes.data.loadout) === canon(asText.loadout) && canon(asBytes.data.pins) === canon(asText.pins),
      `HTTP ${asBytes.status}`);
    check('import: a full sheet pins what it records - all 15 combat slots, the talents',
      asText.pins?.gear?.length === 15 && asText.pins.talents === true && asText.name === 'Example',
      JSON.stringify({ gear: asText.pins?.gear?.length, talents: asText.pins?.talents, name: asText.name }));

    const refusedImport = async (what, body, about) => {
      const { status, data } = await imp(body);
      check(`400: import ${what}`, status === 400 && typeof data.error === 'string' && about.test(data.error) && !('needs' in data),
        `HTTP ${status} ${JSON.stringify(data).slice(0, 140)}`);
    };
    await refusedImport('with no file', {}, /^body needs a file/);
    await refusedImport('of a file sent both as text and as base64', { file: { name: 'x.json', text: '{}', base64: 'e30=' } }, /both text and base64/);
    await refusedImport('of base64 that is not base64', { file: { name: 'x.json', base64: '#not base64#' } }, /^file\.base64 is not base64$/);
    await refusedImport('of a file that is not JSON', { file: { name: 'x.json', text: '{ nope' } }, /^not a character sheet: the file is not JSON/);
    await refusedImport('of a sheet newer than this bench reads', { file: { name: 'x.json', text: JSON.stringify({ format: 'farever-character-sheet', version: 2, character: { class: 'Warrior', level: 1 }, gear: {} }) } },
      /^this character sheet is version 2, and this bench reads version 1/);

    // The modkit dump never names the class: the refusal is a question the
    // page can act on. The dump is synthetic, built from a row the catalog
    // offers a Rogue.
    const { data: rogue } = await api(`/api/catalog?class=Rogue&level=${MAX_LEVEL}`);
    const blade = rogue.slots.Slot_Weapon1[0];
    const dump = JSON.stringify({ character: 'Tester', bankSlots: 0, bank: [], bags: [], equipped: [
      { kind: blade.id, level: MAX_LEVEL, upgrade: 0, rarity: -1, count: 1, class: 'st.item.Weapon',
        infusion: null, infusionStat: null, prismatic: false, flawless: false },
    ] });
    const asked = await imp({ file: { name: 'farever-inventory-Tester.json', text: dump } });
    // The sentence is the reader's to word; what the page acts on - and words
    // its own question from - is the reader's facts: `needs`, the `character`
    // the dump names, the `classes` its weapons fit.
    check('import: a modkit dump with no class is a 400 that asks for one (needs: "class", character, classes, the reader\'s sentence)',
      asked.status === 400 && asked.data.needs === 'class' && asked.data.character === 'Tester'
      && /^a modkit inventory dump does not say which class "Tester" is\b/.test(asked.data.error)
      && Array.isArray(asked.data.classes) && asked.data.classes.includes('Rogue'),
      `HTTP ${asked.status} ${JSON.stringify(asked.data).slice(0, 160)}`);
    const told = await imp({ file: { name: 'farever-inventory-Tester.json', text: dump }, class: 'rogue' });
    check('import: ...and sent again with the class, it reads as that class',
      told.status === 200 && told.data.format === 'modkit-inventory' && told.data.unit === 'Rogue'
      && told.data.loadout?.gear?.Slot_Weapon1?.item === blade.id && told.data.name === 'Tester',
      `HTTP ${told.status} ${JSON.stringify(told.data).slice(0, 160)}`);
    await refusedImport('of a modkit dump given a class that is none (a verdict, not a question)',
      { file: { name: 'farever-inventory-Tester.json', text: dump }, class: 'Paladin' }, /^unknown class "Paladin"/);
    const units = witness.cat.classes.map((c) => c.unit).join(', ');
    const aptitudes = witness.cat.classes.map((c) => c.aptitude).join(', ');
    await refusedImport('with a class that is not a string - the sentence names both kinds of id it takes',
      { file: { name: 'farever-inventory-Tester.json', text: dump }, class: 5 },
      new RegExp(`^class must be a class id - a unit id \\(${units}\\) or an aptitude id \\(${aptitudes}\\) - not 5$`));
    // A level the reader is handed but does not use (the sheet names its
    // own) would otherwise reach its note as "[object Object]".
    const minimalText = readFileSync(join(ROOT, 'docs', 'examples', 'sheet-minimal.json'), 'utf8');
    await refusedImport('with a level that is not a whole number',
      { file: { name: 'sheet-minimal.json', text: minimalText }, level: { a: 1 } },
      /^level must be a character level - a whole number, or left out - not \{"a":1\}$/);
    await refusedImport('with a level of 2.5', { file: { name: 'farever-inventory-Tester.json', text: dump }, class: 'Rogue', level: 2.5 },
      /^level must be a character level - a whole number, or left out - not 2\.5$/);
    const asDigits = await imp({ file: { name: 'farever-inventory-Tester.json', text: dump }, class: 'Rogue', level: ' 20 ' });
    check('import: a level sent as the digits a form field holds is a level',
      asDigits.status === 200 && asDigits.data.level === 20, `HTTP ${asDigits.status} ${asDigits.data.level ?? asDigits.data.error}`);

    // A SAVED BUILD KEEPS ITS PINS. The page sends its rune and talent pins
    // with every search (optimize.js collectRequest); "Save build" writes the
    // envelope that search returns, and importing that file back must pin
    // what the run held - every field, runes and talents included - or the
    // next Optimize quietly searches what the user had settled. The run is
    // the full example sheet's build with the sheet's own pins, which hold
    // runes and the talent tree.
    {
      const fullText = readFileSync(join(ROOT, 'docs', 'examples', 'sheet-full.json'), 'utf8');
      const first = (await imp({ file: { name: 'sheet-full.json', text: fullText } })).data;
      const pins = first.pins;
      const run = await runJob({
        loadout: first.loadout, pins,
        options: { goal: 'dps', target: 'boss', fight: 60, lookahead: 0, restarts: 1, rank: first.rank ?? 3, mix: 0.5, allowEmpty: true },
      });
      const env = run.done?.data?.envelope;
      const back = env ? await imp({ file: { name: 'farever-bench-Rogue-dps.json', text: JSON.stringify(env, null, 2) } }) : null;
      // What the run held: the request's pins, and the infusions the search
      // says it held (the request named them, so the same list).
      const held = { ...pins, infusions: run.done?.data?.search?.infusions?.pinned ?? pins.infusions };
      const got = back?.data?.pins ?? {};
      const field = (p, k) => JSON.stringify(k === 'talents' ? p[k] === true : [...(p[k] ?? [])].sort());
      const differ = PIN_FIELDS.filter((k) => field(held, k) !== field(got, k))
        .map((k) => `${k}: ran with ${field(held, k).slice(0, 60)}, imported back as ${field(got, k).slice(0, 60)}`);
      check(`import: a build the page saves imports back pinned as its run was - ${PIN_FIELDS.join(', ')} (${pins.runes.length} rune hosts, talents ${pins.talents})`,
        pins.runes.length > 0 && pins.talents === true && run.done?.event === 'done' && back?.status === 200
        && differ.length === 0,
        !run.done ? `no terminal event (start: ${JSON.stringify(run.start).slice(0, 100)})`
          : run.done.event !== 'done' ? `${run.done.event}: ${JSON.stringify(run.done.data).slice(0, 120)}`
            : back?.status !== 200 ? `HTTP ${back?.status} ${JSON.stringify(back?.data).slice(0, 120)}`
              : `${differ.join('; ') || 'same'} - the saved envelope's pinned records ${Object.keys(env.pinned ?? {}).join(', ')}`);
    }
  }

  // --- submit: "Send a fight" ----------------------------------------------
  // /api/submit/* is `bench submit` behind five routes: the files travel once,
  // to the preview, and the bundle the server keeps is what Save .zip saves
  // and Send sends. The fixtures are the documented examples (a Warrior's
  // sheet and the Warrior "Tester"'s log) and a synthetic modkit dump built
  // from a catalog row. Nothing reaches pCloud: FAREVER_BENCH_UPLOAD_LINK is
  // 'none', and then the stand-in below.
  {
    const sub = (route, body) => api(`/api/submit/${route}`, body);
    const logBytes = readFileSync(join(ROOT, 'docs', 'examples', 'combat-log.jsonl'));
    const minimalText = readFileSync(join(ROOT, 'docs', 'examples', 'sheet-minimal.json'), 'utf8');
    const fight = (extra = {}) => ({
      sheet: { file: { name: 'sheet-minimal.json', text: minimalText } },
      log: { name: 'combat-log.jsonl', base64: logBytes.toString('base64'), mtimeMs: 1792324809200 },
      ...extra,
    });
    // Every name the fixtures carry: the log's character, the full sheet's,
    // the page's default.
    const NAMES = ['Tester', 'Example', 'Bencher'];
    const named = (text) => NAMES.filter((n) => new RegExp(`\\b${n}\\b`).test(String(text ?? '')));
    const entriesOf = (b64) => {
      try { return Object.fromEntries(readZip(Buffer.from(b64 ?? '', 'base64')).map((e) => [e.name, e.data.toString('utf8')])); } catch { return null; }
    };
    const FORM = 'https://github.com/Blaakan/farever-bench/issues/new?template=data-submission.yml&title=';

    // NO UPLOAD LINK: the preview, the manual route, and a Send refused.
    process.env.FAREVER_BENCH_UPLOAD_LINK = 'none';
    const pv = await sub('preview', fight({ note: 'Battle Shout was up the whole time.' }));
    const p = pv.data;
    check('submit: a preview of docs/examples (minimal sheet, combat log, a note) is the manual route\'s title, the files with their sizes, and the report',
      pv.status === 200 && /^[0-9a-f]{32}$/.test(p.previewId) && /^Data submission: Warrior 25 vs Dummy, Normal \([0-9a-f]{8}\)$/.test(p.title)
      && !('body' in p)
      && JSON.stringify(p.files?.map((f) => f.name)) === '["manifest.json","sheet.json","combat-log.jsonl","note.txt"]'
      && p.files.every((f) => Number.isInteger(f.bytes) && f.bytes > 0) && p.report?.length > 10 && p.formUrl?.startsWith(FORM)
      && p.problems?.length === 0 && Date.parse(p.expiresAt) > Date.now(),
      `HTTP ${pv.status} ${JSON.stringify(p).slice(0, 200)}`);
    check('submit: ...its title names nobody and carries no note',
      named(p.title).length === 0 && !/Battle Shout/.test(p.title ?? ''), named(p.title).join(', '));
    check('submit: ...with no upload link it says upload: false, and the report opens on the manual route',
      p.upload === false && p.uploadProblem === null && /^Send is not available in this copy of the bench: no upload link is set\./.test(p.report?.[0] ?? ''),
      p.report?.[0]);
    check('submit: ...the report as items is the same lines, each with the module\'s kind (the readers\' own nested as sheet:/log:)',
      Array.isArray(p.reportItems) && JSON.stringify(p.reportItems.map((i) => i.text)) === JSON.stringify(p.report)
      && p.reportItems[0]?.kind === 'manual' && p.reportItems.some((i) => i.kind === 'names')
      && p.reportItems.some((i) => /^sheet:/.test(i.kind)) && p.reportItems.some((i) => /^log:/.test(i.kind)),
      JSON.stringify(p.reportItems?.map((i) => i.kind)).slice(0, 200));
    const offSend = await sub('send', { previewId: p.previewId, consent: true });
    check('submit: ...and Send is a 409 with the no-upload-link sentence, naming the form',
      offSend.status === 409
      && offSend.data.error === `Send is off in this copy of the bench (no upload link is set) - save the .zip and attach it to a new issue: ${p.formUrl}`,
      `HTTP ${offSend.status} ${offSend.data.error}`);

    // THE BUNDLE: the fixed entries, and a manifest that names the delete
    // token by its SHA-256 alone.
    const bz = await sub('bundle', { previewId: p.previewId });
    const zipBuf = Buffer.from(bz.data.base64 ?? '', 'base64');
    const ent = entriesOf(bz.data.base64);
    const manifest = ent ? JSON.parse(ent['manifest.json']) : null;
    check('submit: the bundle decodes to a zip of the fixed entries - manifest, sheet, log, note - named after the id, not the player',
      bz.status === 200 && ent && JSON.stringify(Object.keys(ent)) === '["manifest.json","sheet.json","combat-log.jsonl","note.txt"]'
      && bz.data.name === `farever-bench-submission-${manifest?.id?.slice(0, 8)}.zip` && bz.data.bytes === zipBuf.length && zipBuf.length === p.zipBytes
      && p.title.endsWith(`(${manifest?.id?.slice(0, 8)})`),
      `HTTP ${bz.status} ${bz.data.name} ${ent ? Object.keys(ent).join(',') : 'not a zip'}`);
    check('submit: ...the preview names the submission it is (`id`): the id its manifest - and the receipt of a send of it - names',
      /^[0-9a-f]{32}$/.test(p.id ?? '') && p.id === manifest?.id && p.id !== p.previewId, `${p.id} / ${manifest?.id}`);
    check('submit: ...its manifest names the delete token by its SHA-256 (deleteTokenSha256), and carries no token',
      /^[0-9a-f]{64}$/.test(manifest?.deleteTokenSha256 ?? '') && !('deleteToken' in (manifest ?? {})),
      JSON.stringify(manifest?.deleteTokenSha256 ?? null));
    check('submit: ...the files the preview listed, at the sizes it gave',
      ent && p.files.every((f) => Buffer.byteLength(ent[f.name] ?? '', 'utf8') === f.bytes), JSON.stringify(p.files));
    check('submit: ...the character is "Submitter" in the log, the note is the player\'s',
      ent && /"Submitter"/.test(ent['combat-log.jsonl']) && named(ent['combat-log.jsonl']).length === 0
      && ent['note.txt'] === 'Battle Shout was up the whole time.\n', ent ? named(ent['combat-log.jsonl']).join(', ') : '');
    const bz2 = await sub('bundle', { previewId: p.previewId });
    check('submit: the bundle is fetched again as the same bytes', bz2.status === 200 && bz2.data.base64 === bz.data.base64);

    // THE EDITOR'S BUILD, and keeping the name.
    const ed = await sub('preview', { sheet: { editor: { loadout: bare('Warrior'), name: 'Bencher', rank: 3 } }, log: fight().log });
    const edEnt = ed.status === 200 ? entriesOf((await sub('bundle', { previewId: ed.data.previewId })).data.base64) : null;
    const edSheet = JSON.parse(edEnt?.['sheet.json'] ?? 'null');
    check('submit: the build in the editor is a sheet like a file: a Warrior 25 whose name is "Submitter" in sheet.json and not in the form\'s title',
      ed.status === 200 && /^Data submission: Warrior 25 vs Dummy/.test(ed.data.title) && edSheet?.character?.name === 'Submitter'
      && edSheet?.character?.class === 'Warrior' && named(ed.data.title).length === 0,
      `HTTP ${ed.status} ${ed.data.error ?? JSON.stringify(edSheet?.character)}`);
    check('submit: ...written by the module from the editor input, so the manifest says it came from the editor (bench-editor)',
      JSON.parse(edEnt?.['manifest.json'] ?? '{}').sheet?.sourceFormat === 'bench-editor',
      JSON.stringify(JSON.parse(edEnt?.['manifest.json'] ?? '{}').sheet?.sourceFormat));
    const kept = await sub('preview', { sheet: { editor: { loadout: bare('Warrior'), name: 'Bencher', rank: 3 } }, log: fight().log, keepName: true });
    const keptEnt = kept.status === 200 ? entriesOf((await sub('bundle', { previewId: kept.data.previewId })).data.base64) : null;
    check('submit: keepName keeps the name in the zip\'s files only - sheet.json and the log\'s header, never the form\'s title',
      kept.status === 200 && JSON.parse(keptEnt?.['sheet.json'] ?? '{}').character?.name === 'Bencher' && /"Tester"/.test(keptEnt?.['combat-log.jsonl'] ?? '')
      && named(kept.data.title).length === 0 && kept.data.report.some((l) => /^Names: .*kept in sheet\.json and the log's header, as you asked\./.test(l)),
      `HTTP ${kept.status} ${kept.data.error ?? kept.data.report?.find((l) => l.startsWith('Names:'))}`);

    // THE EDITOR'S BUILD GOES AS WHAT ITS PINS STATE, written by the module
    // (charsheet.mjs pinnedSheet, the rule `bench submit` writes a typed
    // build by): a pinned slot is recorded - an empty one as empty - and a
    // slot nobody pinned is "not recorded", never "recorded empty", whatever
    // the editor holds there. And the page is told when the build wears
    // nothing, none of the weapons whose skills the log's character used, or
    // holds what no pin states. The log is the Warrior "Tester"'s, who fought
    // with GA_Craft (its skills are in the log); GA_Demon is another great axe.
    {
      const sheetOf = async (pv) => (pv.status === 200
        ? JSON.parse(entriesOf((await sub('bundle', { previewId: pv.data.previewId })).data.base64)?.['sheet.json'] ?? 'null') : null);
      const NO_PINS = { gear: [], augments: [], skills: [], runes: [], talents: false, infusions: [] };
      const editorFight = (loadout, pins) => ({ sheet: { editor: { loadout, pins, name: 'Bencher', rank: null } }, log: fight().log });
      const combat = witness.cat.combatSlots().length;

      const naked = await sub('preview', editorFight(bare('Warrior'), NO_PINS));
      const nakedSheet = await sheetOf(naked);
      check('submit: an empty editor build with no pins records no slot, no tree, no rune and no skill bar - each is a gap, not "recorded empty"',
        naked.status === 200 && nakedSheet && Object.keys(nakedSheet.gear ?? {}).length === 0
        && !('talents' in nakedSheet) && !('runes' in nakedSheet) && !('classSkills' in nakedSheet) && !('weaponSkillRanks' in nakedSheet)
        && naked.data.report.some((l) => l.includes(`Gap: ${combat} gear slots are not recorded`)),
        `HTTP ${naked.status} ${naked.data.error ?? JSON.stringify(nakedSheet).slice(0, 160)}`);
      check('submit: ...and the page is told it wears nothing, first among the problems and in the report',
        /^the build in the editor wears nothing - is it the build this fight was fought in\?/.test(naked.data.problems?.[0] ?? '')
        && naked.data.report.some((l) => l.startsWith('Problem: the build in the editor wears nothing')) && naked.data.sendRefused === null,
        JSON.stringify(naked.data.problems).slice(0, 200));

      const axe = witness.cat.itemById.get('GA_Craft');
      const sockets = axe ? witness.cat.socketsFor(axe) : [];
      const craft = await sub('preview', editorFight(bare('Warrior', { Slot_Weapon1: { item: 'GA_Craft', stars: 0 } }),
        { ...NO_PINS, gear: ['Slot_Weapon1', 'Slot_Head'], augments: sockets.length > 1 ? [`Slot_Weapon1/${sockets[0]}`] : [] }));
      const craftSheet = await sheetOf(craft);
      const own = (craft.data.problems ?? []).filter((x) => /the build in the editor|a sheet records/.test(x));
      check('submit: a worn piece is recorded, a slot pinned empty is null, and the slots nobody pinned are absent',
        craft.status === 200 && JSON.stringify(Object.keys(craftSheet?.gear ?? {}).sort()) === '["Slot_Head","Slot_Weapon1"]'
        && craftSheet.gear.Slot_Weapon1?.item === 'GA_Craft' && craftSheet.gear.Slot_Weapon1.upgrade === 0 && craftSheet.gear.Slot_Head === null
        && !('flawless' in craftSheet.gear.Slot_Weapon1) && !('infusion' in craftSheet.gear.Slot_Weapon1),
        `HTTP ${craft.status} ${craft.data.error ?? JSON.stringify(craftSheet?.gear).slice(0, 200)}`);
      check(`submit: ...a piece's sockets go whole once one is pinned - the ${sockets.length - 1} left open said (by the module) to be sent as empty - and GA_Craft is the log's weapon, so no other problem`,
        sockets.length > 1 && JSON.stringify(craftSheet?.gear?.Slot_Weapon1?.sockets) === '[]' && own.length === 1
        && own[0] === `Slot_Weapon1: a sheet records a piece's sockets whole, so ${sockets.slice(1).join(' and ')}, which no pin held, `
          + `${sockets.length === 2 ? 'is' : 'are'} sent as empty`,
        `${JSON.stringify(sockets)} ${JSON.stringify(own)}`);

      // Held and pinned by nothing - what Apply to editor leaves behind: not
      // recorded, and the page is told.
      const loose = await sub('preview', editorFight(bare('Warrior', { Slot_Weapon1: { item: 'GA_Craft', stars: 0 } }), NO_PINS));
      const looseSheet = await sheetOf(loose);
      check('submit: a piece the editor holds and no pin states goes as not recorded, and the page is told what no pin states',
        loose.status === 200 && looseSheet && !('Slot_Weapon1' in (looseSheet.gear ?? {}))
        && (loose.data.problems ?? []).some((x) => /^the build in the editor holds what no pin states - a piece \(Slot_Weapon1\) - and that goes as not recorded/.test(x)),
        `HTTP ${loose.status} ${loose.data.error ?? JSON.stringify(loose.data.problems).slice(0, 220)}`);

      const demon = await sub('preview', editorFight(bare('Warrior', { Slot_Weapon1: { item: 'GA_Demon', stars: 0 } }), { ...NO_PINS, gear: ['Slot_Weapon1'] }));
      check('submit: an editor build wearing none of the weapons whose skills the log\'s character used is told so, naming them',
        demon.status === 200 && /^the log's character used GA_Craft_\w+(, GA_Craft_\w+)* - skills of GA_Craft - and no weapon the build in the editor wears grants them: is it the build/
          .test(demon.data.problems?.[0] ?? ''), `HTTP ${demon.status} ${demon.data.error ?? demon.data.problems?.[0]}`);

      const { data: warCat } = await api(`/api/catalog?class=Warrior&level=${MAX_LEVEL}`);
      const hat = warCat.slots?.Slot_Head?.[0]?.id;
      const bareHead = await sub('preview', editorFight(bare('Warrior', { Slot_Head: { item: hat, stars: 0 } }), { ...NO_PINS, gear: ['Slot_Head'] }));
      check('submit: ...and one that wears no weapon at all is told that',
        !!hat && bareHead.status === 200 && /^the build in the editor wears no weapon - /.test(bareHead.data.problems?.[0] ?? ''),
        `${hat} HTTP ${bareHead.status} ${bareHead.data.error ?? bareHead.data.problems?.[0]}`);

      const badPins = await sub('preview', editorFight(bare('Warrior'), { ...NO_PINS, gear: 'Slot_Head' }));
      check('400: submit preview of the editor\'s build with pins that are not the pins\' shape',
        badPins.status === 400 && /^sheet\.editor\.pins\.gear must be a list of ids, not "Slot_Head"$/.test(badPins.data.error ?? ''),
        `HTTP ${badPins.status} ${badPins.data.error}`);

      // AN IMPORT SENT FROM THE EDITOR states what its FILE stated of each
      // piece (/api/import's `pieces`, charsheet.mjs recordedPieces), never
      // what the loadout filled in: the same sheet sent as a file and from
      // the editor packs the same pieces (review: the editor sent the row
      // rarity and the 0 stars sheet-minimal never recorded, and dropped the
      // Flawless flags sheet-full did). Item levels aside: they are what the
      // game showed beside the build, which a loadout has no place for.
      const noILevel = (gear) => JSON.stringify(Object.fromEntries(Object.entries(gear ?? {}).map(([s, e]) => [s, e && Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'iLevel'))])));
      for (const name of ['sheet-minimal.json', 'sheet-full.json']) {
        const text = readFileSync(join(ROOT, 'docs', 'examples', name), 'utf8');
        const imported = (await api('/api/import', { file: { name, text } })).data;
        const ip = imported.pins ?? {};
        const asFile = await sub('preview', fight({ sheet: { file: { name, text } }, ...(imported.unit !== 'Warrior' ? { sheetOptions: { class: imported.unit } } : {}) }));
        const asEditor = await sub('preview', {
          sheet: { editor: { loadout: imported.loadout, name: imported.name, rank: imported.rank, pieces: imported.pieces,
            pins: { gear: ip.gear, augments: ip.augments, skills: ip.skills, runes: ip.runes, talents: ip.talents === true, infusions: ip.infusions } } },
          log: fight().log,
        });
        const [fileSheet, edSheet] = [await sheetOf(asFile), await sheetOf(asEditor)];
        const gapsOf = (pv) => (pv.data.reportItems ?? []).filter((i) => i.kind === 'sheet:gap').map((i) => i.text).join('\n');
        check(`submit: ${name} imported and sent from the editor states the pieces the file did, and leaves open what it left open (/api/import's pieces)`,
          asFile.status === 200 && asEditor.status === 200 && imported.pieces && typeof imported.pieces === 'object'
          && noILevel(fileSheet?.gear) === noILevel(edSheet?.gear) && gapsOf(asFile) === gapsOf(asEditor),
          `file HTTP ${asFile.status} editor HTTP ${asEditor.status} ${asEditor.data.error ?? ''} ${noILevel(fileSheet?.gear).slice(0, 120)} | ${noILevel(edSheet?.gear).slice(0, 120)}`);
      }
      const badPieces = await sub('preview', { sheet: { editor: { loadout: bare('Warrior', { Slot_Weapon1: { item: 'GA_Craft' } }), pins: { ...NO_PINS, gear: ['Slot_Weapon1'] },
        pieces: { Slot_Weapon1: { rarity: 'yes' } } } }, log: fight().log });
      check('400: submit preview of the editor\'s build with pieces that are not /api/import\'s shape',
        badPieces.status === 400 && /^sheet\.editor\.pieces\.Slot_Weapon1 must be \{level, rarity, stars, flawless, prismatic, infusionStat\}, each true or false/.test(badPieces.data.error ?? ''),
        `HTTP ${badPieces.status} ${badPieces.data.error}`);
    }

    // THE CAPS the dialog holds a file to are the module's, served - and the
    // dialog is on, on a loopback bind.
    {
      const b = (await api('/api/bootstrap')).data;
      check('submit: bootstrap serves src/submit.mjs\'s caps and its send timeout, and no "off" sentence on a loopback bind',
        b.submit?.sheetMaxBytes === SHEET_MAX_BYTES && b.submit.logMaxBytes === LOG_MAX_BYTES && b.submit.noteMax === NOTE_MAX
        && b.submit.sendTimeoutMs === SEND_TIMEOUT_MS && b.submit.off === null,
        JSON.stringify(b.submit));
      const offs = ['0.0.0.0', '::', '192.168.1.20'].map(submitOffFor);
      check('submit: a bind beyond loopback has one sentence for switching every submit route off, and loopback none',
        offs.every((s) => /^Send a fight is off on this server: it listens on \S+, beyond this machine/.test(s ?? ''))
        && ['127.0.0.1', '127.0.0.2', '::1', '[::1]', 'localhost'].every((h) => submitOffFor(h) === null), JSON.stringify(offs).slice(0, 160));
      // ...and the routes are switched off: a second server, configured as
      // bound beyond this machine (host 0.0.0.0) while it listens on
      // 127.0.0.1 alone (`listen` - no port opens to the network), asked
      // every submit route as anything on that network would ask it: no
      // Origin, a JSON body, each route's own. Each is the 403 with the
      // sentence, before anything of it runs - and bootstrap hands the page
      // the same sentence.
      const offSaid = submitOffFor('0.0.0.0');
      const wide = await startServer({ benchRoot: ROOT, port: 0, host: '0.0.0.0', listen: '127.0.0.1' });
      try {
        const offBase = `http://127.0.0.1:${wide.port}`;
        const offBoot = await (await fetch(`${offBase}/api/bootstrap`)).json();
        const answers = [];
        for (const [route, body] of [['receipts', {}], ['send', { previewId: 'a'.repeat(32), consent: true }],
          ['delete', { receipt: '{}' }], ['preview', fight()], ['bundle', { previewId: 'a'.repeat(32) }]]) {
          const res = await fetch(`${offBase}/api/submit/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          answers.push([route, res.status, (await res.json().catch(() => ({}))).error ?? null]);
        }
        check('submit: a server bound beyond loopback refuses every submit route - receipts, send, delete, preview, bundle - 403 with that sentence, '
          + 'and bootstrap.submit.off is it',
          wide.submitOff === offSaid && offBoot.submit?.off === offSaid && answers.length === 5 && answers.every(([, s, e]) => s === 403 && e === offSaid),
          JSON.stringify(answers).slice(0, 300));
      } finally {
        await wide.close();
      }
      // (Asked with a port no socket takes: were the rule gone, the listen
      // itself would fail, and nothing would open beyond this machine.)
      let wider = null;
      try { await startServer({ benchRoot: ROOT, port: -1, listen: '0.0.0.0' }); } catch (e) { wider = e; }
      check('submit: ...and no server listens wider than the host it is configured for (`listen` takes loopback only)',
        /^startServer: listen is 0\.0\.0\.0 - a server listens on its own host, or on loopback alone, never wider$/.test(wider?.message ?? ''), String(wider?.message));
    }

    // REFUSALS: the route's own sentences, then the module's.
    const refusedSubmit = async (what, route, body, status, about, more = () => true) => {
      const { status: s, data } = await sub(route, body);
      check(`${status}: submit ${what}`, s === status && typeof data.error === 'string' && about.test(data.error) && more(data),
        `HTTP ${s} ${JSON.stringify(data).slice(0, 160)}`);
    };
    await refusedSubmit('preview with no sheet', 'preview', { log: fight().log }, 400, /^sheet needs one of two things: file .* or editor/);
    await refusedSubmit('preview with both a sheet file and the editor\'s build', 'preview',
      fight({ sheet: { file: { name: 'a.json', text: '{}' }, editor: { loadout: bare('Warrior') } } }), 400, /^sheet needs one of two things/);
    await refusedSubmit('preview with no combat log (the module\'s sentence)', 'preview', { sheet: fight().sheet }, 400, /^No combat log was given - a submission carries the fight/);
    await refusedSubmit('preview of a log whose base64 is not base64', 'preview', fight({ log: { name: 'x.jsonl', base64: '#not base64#' } }), 400, /^log\.base64 is not base64$/);
    await refusedSubmit('preview with keepName that is not a boolean', 'preview', fight({ keepName: 'yes' }), 400, /^keepName must be true or false, not "yes"$/);
    await refusedSubmit('preview with an mtimeMs that is not a time', 'preview', fight({ log: { ...fight().log, mtimeMs: 'yesterday' } }), 400, /^log\.mtimeMs must be/);
    await refusedSubmit('preview of a log that is not one (the reader\'s sentence, prefixed with which file)', 'preview',
      fight({ log: { name: 'notes.txt', text: 'hello' } }), 400, /^The combat log was not read: /);
    await refusedSubmit('preview with a note over 2000 characters', 'preview', fight({ note: 'x'.repeat(2001) }), 413,
      /^The note is 2,001 characters; a note may hold at most 2,000\.$/);
    const { data: rogueCat } = await api(`/api/catalog?class=Rogue&level=${MAX_LEVEL}`);
    const dump = JSON.stringify({ character: 'Tester', bankSlots: 0, bank: [], bags: [], equipped: [
      { kind: rogueCat.slots.Slot_Weapon1[0].id, level: MAX_LEVEL, upgrade: 0, rarity: -1, count: 1, class: 'st.item.Weapon',
        infusion: null, infusionStat: null, prismatic: false, flawless: false },
    ] });
    // ...with the reader's facts, and the class the fight's log names its
    // character (the example log's is a Warrior), which the dialog offers.
    await refusedSubmit('preview of a modkit dump with no class asks for one, as /api/import does - with the log\'s class', 'preview',
      fight({ sheet: { file: { name: 'farever-inventory-Tester.json', text: dump } } }), 400, /does not say which class "Tester" is/,
      (d) => d.needs === 'class' && d.character === 'Tester' && Array.isArray(d.classes) && d.classes.includes('Rogue') && d.logClass === 'Warrior');
    // ...and why the log's class was not taken for it: a class its weapons do
    // not fit (the module's sentence, which `bench submit` says too).
    const notTaken = await sub('preview', fight({ sheet: { file: { name: 'farever-inventory-Tester.json', text: dump } } }));
    check('submit: ...saying why the log\'s class was not taken for the dump: its weapons do not fit a Warrior',
      notTaken.status === 400 && /The fight's log names its character a Warrior, a class the dump's weapons do not fit, so the dump is not read as one\.$/.test(notTaken.data.error ?? ''),
      `HTTP ${notTaken.status} ${notTaken.data.error}`);
    // A DUMP OF THE LOG'S OWN CHARACTER IN A CLASS ITS WEAPONS FIT is read in
    // the log's class, and the report says so - the module's rule
    // (charsheet.mjs dumpClassFromLog), `bench submit`'s and `bench verify`'s.
    const { data: warriorCat } = await api(`/api/catalog?class=Warrior&level=${MAX_LEVEL}`);
    const warDump = JSON.stringify({ character: 'Tester', bankSlots: 0, bank: [], bags: [], equipped: [
      { kind: warriorCat.slots.Slot_Weapon1[0].id, level: MAX_LEVEL, upgrade: 0, rarity: -1, count: 1, class: 'st.item.Weapon',
        infusion: null, infusionStat: null, prismatic: false, flawless: false },
    ] });
    const fromLog = await sub('preview', fight({ sheet: { file: { name: 'farever-inventory-Tester.json', text: warDump } } }));
    check('submit: a modkit dump of the log\'s own character, in a class its weapons fit, is read in the log\'s class, and the report says so',
      fromLog.status === 200 && /^Data submission: Warrior 25 vs Dummy/.test(fromLog.data.title) && fromLog.data.sendRefused === null
      && (fromLog.data.problems ?? []).some((x) => /^a modkit dump names no class: it is read as a Warrior - the class the fight's log gives the dump's own character/.test(x))
      && fromLog.data.report.some((l) => /^Problem: a modkit dump names no class: it is read as a Warrior/.test(l)),
      `HTTP ${fromLog.status} ${fromLog.data.error ?? JSON.stringify(fromLog.data.problems).slice(0, 200)}`);
    const asClass = await sub('preview', fight({ sheet: { file: { name: 'farever-inventory-Tester.json', text: dump } }, sheetOptions: { class: 'Rogue', level: MAX_LEVEL } }));
    check('submit: ...and previewed again with sheetOptions.class, it packs - the dump\'s character name not in the form\'s title, the log\'s class said',
      asClass.status === 200 && /^Data submission: Rogue 25 vs Dummy/.test(asClass.data.title) && named(asClass.data.title).length === 0
      && asClass.data.logClass === 'Warrior',
      `HTTP ${asClass.status} ${asClass.data.error ?? asClass.data.title} ${asClass.data.logClass}`);
    await refusedSubmit('bundle of a previewId that is not one', 'bundle', { previewId: 'nope' }, 400, /^previewId must be the id \/api\/submit\/preview answered with/);
    await refusedSubmit('bundle of a preview nobody made - in the player\'s words, not the API\'s `again`', 'bundle', { previewId: 'a'.repeat(32) }, 404,
      /^No preview with that id is held: .* - the files are to be previewed again, and a bundle whose send was not answered is built again from its receipt as the same submission$/,
      (d) => !/`again`/.test(d.error));
    await refusedSubmit('delete of a receipt that is none', 'delete', { receipt: 'not json' }, 400, /^That is not a receipt of a sent fight: it is not JSON\.$/);
    await refusedSubmit('delete with no receipt', 'delete', {}, 400, /^receipt must be the receipt a send gave you/);

    // A LINK THAT IS NOT ONE switches Send off, and says why - it is never
    // tried: an address that is no http(s) one, one on another host than
    // pCloud's, and plain http to pCloud's (taken only on this machine).
    for (const [given, why] of [['ftp://example.invalid', 'it is not an http\\(s\\) address'],
      ['https://example.invalid/#/puplink?code=TestCode1234', 'it is not on pCloud \\(pcloud\\.com, pcloud\\.link\\)'],
      ['http://e.pcloud.com/#/puplink?code=TestCode1234', 'it is plain http, which is taken only on this machine \\(127\\.0\\.0\\.1, localhost, \\[::1\\]\\)']]) {
      process.env.FAREVER_BENCH_UPLOAD_LINK = given;
      const bad = (await sub('preview', fight())).data;
      const badSend = await sub('send', { previewId: bad.previewId, consent: true });
      const said = bad.uploadProblem ?? '';
      check(`submit: a FAREVER_BENCH_UPLOAD_LINK that is no upload link (${given}): upload false, the reason first in the report, and Send a 409 saying it`,
        bad.upload === false && new RegExp(`^FAREVER_BENCH_UPLOAD_LINK is "${given.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}": ${why} - give the upload link pCloud shows`).test(said)
        && bad.report?.[0] === `Problem: Send is off: ${/[.!?]$/.test(said) ? said : `${said}.`}` && badSend.status === 409 && badSend.data.error === `Send is off: ${said}`,
        `${said} / HTTP ${badSend.status} ${badSend.data.error}`);
      // ...and the report does not contradict itself: the manual route is the
      // way meanwhile, never "no upload link is set" (the module's line).
      check(`submit: ...the report then gives the manual route as the way meanwhile, and never says no upload link is set (${given})`,
        bad.reportItems?.[0]?.kind === 'problem' && bad.reportItems[0].warn === true
        && /^Send is off in this copy of the bench until that link is set right\. The route meanwhile is Save \.zip, then the GitHub form/.test(bad.report?.[1] ?? '')
        && !bad.report?.some((l) => /no upload link is set/.test(l)), bad.report?.slice(0, 2).join(' | '));
    }
    process.env.FAREVER_BENCH_UPLOAD_LINK = 'none';

    // AT MOST 8 HELD: a ninth preview drops the oldest.
    const ids = [];
    for (let i = 0; i < 9; i++) ids.push((await sub('preview', fight())).data.previewId);
    const oldest = await sub('bundle', { previewId: ids[0] });
    const newest = await sub('bundle', { previewId: ids[8] });
    check('submit: at most 8 previews are held - a ninth drops the oldest', ids.every(Boolean) && oldest.status === 404 && newest.status === 200,
      `oldest HTTP ${oldest.status}, newest HTTP ${newest.status}`);

    // THE GUARD on the submit routes: the door every route has, and the file
    // routes' 40 MB cap - a real Wink timeline runs to megabytes, and a
    // regression to the 1 MB cap would pass every fixture above.
    {
      const JSON_TYPE = { 'content-type': 'application/json' };
      const guarded = async (what, [method, path, headers, body], status, about) => {
        const r = await raw(method, path, headers, body);
        check(`${status}: submit ${what}`, r.status === status && typeof r.data?.error === 'string' && about.test(r.data.error),
          r.status == null ? `no answer: ${r.error}` : `HTTP ${r.status} ${r.text.slice(0, 160)}`);
      };
      const sendBody = JSON.stringify({ previewId: 'a'.repeat(32), consent: true });
      await guarded('send from a foreign Origin', ['POST', '/api/submit/send', { ...JSON_TYPE, origin: 'https://example.com' }, sendBody],
        403, /^a page from https:\/\/example\.com may not call this server/);
      await guarded('send as text/plain, the type a page can send with no preflight', ['POST', '/api/submit/send', { 'content-type': 'text/plain' }, sendBody],
        415, /^\/api\/submit\/send takes a JSON body \(content-type: application\/json\), not "text\/plain"$/);
      await guarded('preview asked with GET', ['GET', '/api/submit/preview', {}], 405, /^\/api\/submit\/preview takes POST, not GET$/);
      await guarded('a CORS preflight for delete', ['OPTIONS', '/api/submit/delete', { origin: 'https://example.com', 'access-control-request-method': 'POST' }],
        405, /^\/api\/submit\/delete takes POST, not OPTIONS$/);
      const big = await sub('preview', fight({ pad: 'x'.repeat(2 * 1024 * 1024) }));
      check('submit: a 2 MB preview body is read (the file routes\' 40 MB cap), not a 413', big.status === 200 && /^[0-9a-f]{32}$/.test(big.data.previewId ?? ''),
        `HTTP ${big.status} ${String(big.data.error ?? '').slice(0, 120)}`);
      // Every other submit route takes an id, a flag or a receipt: 1 MB.
      for (const route of ['send', 'bundle', 'delete', 'receipts']) {
        await guarded(`${route} with a 2 MB body: only the preview takes a file`,
          ['POST', `/api/submit/${route}`, JSON_TYPE, JSON.stringify({ previewId: 'a'.repeat(32), consent: true, pad: 'x'.repeat(2 * 1024 * 1024) })],
          413, new RegExp(`^the request body is 2 MB, and /api/submit/${route} takes at most 1 MB - none of it was read$`));
      }
    }

    // THE PCLOUD STAND-IN. It answers POST /uploadtolink as pCloud does -
    // HTTP 200 and {result: 0} when it keeps the file, a result other than 0
    // and an error sentence when it does not - or as `mode` says, and records
    // what reached it: the query, the headers, the multipart body's parts
    // (read with Response.formData(), as any multipart reader reads them),
    // and, for a zip, the receipt the bench kept for that id at the moment the
    // upload arrived, which is how "kept before a byte leaves" is seen from
    // here. Modes: ok; full (7008, the link's file limit reached); down (5000,
    // pCloud failing to store it); slow (answered after 600 ms); hold
    // (answered {result: 0} when the check calls `release`); garbled (an
    // HTML 502, not pCloud's API); drop (the socket destroyed once the body
    // is in, so the answer is lost).
    const keptFile = (id) => join(process.env.FAREVER_BENCH_CACHE, 'submit-receipts', `farever-bench-receipt-${id}.json`);
    const keptNow = (id) => { try { return JSON.parse(readFileSync(keptFile(id), 'utf8')); } catch { return null; } };
    const sha256 = (data) => createHash('sha256').update(data).digest('hex');
    const madeIds = new Set();
    const seen = [];
    let mode = 'ok';
    let release = null;
    const stub = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://127.0.0.1');
        const parts = [];
        try {
          const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
          for (const [field, value] of form.entries()) {
            parts.push(typeof value === 'string' ? { field, text: value }
              : { field, name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
          }
        } catch { /* not multipart: no parts */ }
        const file = parts.find((x) => x.bytes) ?? null;
        const id = /^([0-9a-f]{32})\./.exec(file?.name ?? '')?.[1] ?? null;
        if (id) madeIds.add(id);
        seen.push({
          method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), keys: [...url.searchParams.keys()],
          headers: req.headers, raw, parts, fileName: file?.name ?? null, fileType: file?.type ?? null, bytes: file?.bytes ?? null, id,
          kept: id && file.name.endsWith('.zip') ? keptNow(id) : null,
        });
        const answer = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (mode === 'drop') { req.socket.destroy(); return; }
        if (mode === 'garbled') { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html><body><h1>502 Bad Gateway</h1></body></html>'); return; }
        if (mode === 'full') { answer({ result: 7008, error: 'This link has reached its file limit.' }); return; }
        if (mode === 'down') { answer({ result: 5000, error: 'Internal error. Try again later.' }); return; }
        if (mode === 'slow') { setTimeout(() => answer({ result: 0 }), 600); return; }
        if (mode === 'hold') { release = () => { release = null; answer({ result: 0 }); }; return; }
        answer({ result: 0 });
      });
    });
    await new Promise((resolvePromise) => stub.listen(0, '127.0.0.1', resolvePromise));
    const stubLink = `http://127.0.0.1:${stub.address().port}/#/puplink?code=TestCode1234`;
    // Another upload link than this copy's, on pCloud's own host: never
    // reached - everything that names it is refused before a byte leaves.
    const OTHER = 'https://e.pcloud.com/#/puplink?code=OtherCode5678';
    const uploads = () => seen.filter((x) => x.method === 'POST');
    try {
      process.env.FAREVER_BENCH_UPLOAD_LINK = stubLink;
      const on = (await sub('preview', fight())).data;
      check('submit: with an upload link, upload: true and the report opens on what Send does - the project\'s folder on pCloud, nothing made public',
        on.upload === true && on.uploadProblem === null && !('body' in on)
        && /^What Send does: the zip \([\d,]+ bytes\) goes to the project's folder on pCloud \(pcloud\.com\), where only the project's maintainer can read it - nothing is made public -$/
          .test(on.report?.[0] ?? '')
        && on.reportItems?.[0]?.kind === 'private' && !on.reportItems.some((i) => ['public', 'title', 'row'].includes(i.kind)),
        on.report?.[0]);
      const onZip = (await sub('bundle', { previewId: on.previewId })).data.base64;
      await refusedSubmit('send without consent: nothing is sent', 'send', { previewId: on.previewId }, 400,
        /^Nothing was sent: a send needs consent: true, which the dialog sends once "I understand the zip goes to the project's folder on pCloud, where only the maintainer can read it" is ticked$/);
      await refusedSubmit('send with consent that is not the literal true', 'send', { previewId: on.previewId, consent: 'yes' }, 400, /^Nothing was sent/);
      check('submit: ...and the stand-in heard nothing of either', seen.length === 0, `${seen.length} request(s)`);

      const sent = await sub('send', { previewId: on.previewId, consent: true });
      const r = sent.data.receipt;
      const post = uploads()[0];
      check('submit: send uploads the previewed zip, byte for byte, as <id>.zip through uploadtolink - the link\'s code, names=farever-bench, nopartial=1, one part',
        sent.status === 200 && seen.length === 1 && post?.path === '/uploadtolink'
        && JSON.stringify([...(post.keys ?? [])].sort()) === '["code","names","nopartial"]'
        && post.query.code === 'TestCode1234' && post.query.names === 'farever-bench' && post.query.nopartial === '1'
        && post.parts?.length === 1 && post.fileName === `${r?.id}.zip` && post.fileType === 'application/zip'
        && post.bytes?.toString('base64') === onZip && on.title.endsWith(`(${r?.id?.slice(0, 8)})`),
        `HTTP ${sent.status} ${JSON.stringify(sent.data).slice(0, 160)}; ${post?.path} ${JSON.stringify(post?.query)} ${post?.fileName} ${post?.fileType}`);
      check('submit: ...with no header of the bench\'s own - no Authorization - and the delete token nowhere in the request',
        !!post && !('authorization' in post.headers) && !Object.keys(post.headers).some((h) => h.startsWith('x-'))
        && !post.raw.includes(Buffer.from(r?.deleteToken ?? '-')) && !JSON.stringify(post.query).includes(r?.deleteToken ?? '-'),
        JSON.stringify(Object.keys(post?.headers ?? {})));
      check('submit: ...and answers with what was sent - its id, the name it went under, when, its SHA-256 - and the receipt, its six fields',
        JSON.stringify(Object.keys(r ?? {})) === '["id","deleteToken","link","sentAt","createdAt","zipSha256"]'
        && r.link === stubLink && Number.isFinite(Date.parse(r.sentAt)) && r.zipSha256 === sha256(Buffer.from(onZip, 'base64'))
        && JSON.stringify(sent.data.sent) === JSON.stringify({ id: r.id, uploadedAs: `${r.id}.zip`, sentAt: r.sentAt, zipSha256: r.zipSha256 }),
        JSON.stringify({ sent: sent.data.sent, receipt: r }).slice(0, 240));
      const onEntries = entriesOf(onZip) ?? {};
      const onManifest = JSON.parse(onEntries['manifest.json'] ?? '{}');
      check('submit: ...the zip\'s manifest carries the SHA-256 of the receipt\'s delete token, and no file in the zip the token',
        onManifest.deleteTokenSha256 === sha256(r?.deleteToken ?? '') && Object.values(onEntries).every((t) => !t.includes(r?.deleteToken ?? '-')),
        `${onManifest.deleteTokenSha256} / ${sha256(r?.deleteToken ?? '')}`);
      const rt = sent.data.receiptText ? JSON.parse(sent.data.receiptText) : null;
      check('submit: ...the receipt to save is the module\'s file, named after the id',
        rt?.format === 'farever-bench-receipt' && rt.id === r?.id && rt.deleteToken === r?.deleteToken && rt.link === stubLink
        && sent.data.receiptName === `farever-bench-receipt-${r?.id?.slice(0, 8)}.json`, sent.data.receiptName);
      check('submit: the receipt is on disk before the zip leaves - kept for its id, sentAt null, when the upload arrived - and completed after',
        post?.kept?.id === r?.id && post.kept.sentAt === null && post.kept.deleteToken === r?.deleteToken
        && keptNow(r?.id)?.sentAt === r?.sentAt && sent.data.kept === keptFile(r?.id),
        `at the upload ${JSON.stringify(post?.kept ?? null).slice(0, 100)}; after ${JSON.stringify(keptNow(r?.id)?.sentAt ?? null)}; kept ${sent.data.kept}`);
      // It holds the delete token. Windows has no mode bits to hold it to.
      if (process.platform !== 'win32') {
        let fileMode = null;
        try { fileMode = statSync(keptFile(r?.id)).mode & 0o777; } catch { fileMode = null; }
        check('submit: ...and it is readable by this account alone (0600) - it holds the token that asks for the fight\'s deletion',
          fileMode === 0o600, fileMode === null ? 'no kept file' : fileMode.toString(8));
      }
      const listed = (await sub('receipts', {})).data;
      check('submit: /receipts lists the kept receipt and its file, and says this copy sends - never the link it sends through',
        listed.upload === true && listed.uploadProblem === null
        && JSON.stringify(Object.keys(listed).sort()) === '["folder","problem","receipts","unreadable","upload","uploadProblem"]'
        && listed.folder === dirname(keptFile(r?.id)) && listed.receipts?.some((x) => x.receipt.id === r?.id
          && x.receipt.sentAt === r?.sentAt && x.file === keptFile(r?.id) && JSON.parse(x.receiptText).deleteToken === r?.deleteToken),
        JSON.stringify(listed).slice(0, 200));
      await refusedSubmit('send twice with one previewId', 'send', { previewId: on.previewId, consent: true }, 409,
        /^This preview was sent already \(submission [0-9a-f]{8}\): a preview is sent once, and its bundle is in the project's folder now$/,
        (d) => d.receipt?.id === r?.id);
      await refusedSubmit('bundle of a preview that was sent', 'bundle', { previewId: on.previewId }, 409, /^This preview was sent already/);
      check('submit: ...the second send never reached the stand-in', uploads().length === 1);

      // ASKING FOR ITS DELETION uploads a request to the same folder, through
      // the same link: the receipt's id and token, as <id>.withdraw.json.
      const del = await sub('delete', { receipt: sent.data.receiptText });
      const dreq = uploads()[1];
      let asked = null;
      try { asked = JSON.parse(dreq?.bytes?.toString('utf8') ?? ''); } catch { asked = null; }
      check('submit: delete uploads <id>.withdraw.json through the same link - the receipt\'s id and token, whose SHA-256 is the manifest\'s',
        del.status === 200 && del.data.ok === true && del.data.requested === true && del.data.id === r?.id
        && dreq?.path === '/uploadtolink' && dreq.query.code === 'TestCode1234' && dreq.query.names === 'farever-bench' && dreq.query.nopartial === '1'
        && dreq.parts?.length === 1 && dreq.fileName === `${r?.id}.withdraw.json` && dreq.fileType === 'application/json'
        && !('authorization' in dreq.headers)
        && asked?.format === 'farever-bench-withdrawal' && asked.id === r?.id && asked.deleteToken === r?.deleteToken
        && sha256(asked.deleteToken ?? '') === onManifest.deleteTokenSha256 && asked.zipSha256 === r?.zipSha256,
        `HTTP ${del.status} ${JSON.stringify(del.data).slice(0, 120)}; ${dreq?.fileName} ${JSON.stringify(asked).slice(0, 120)}`);
      const relisted = (await sub('receipts', {})).data;
      check('submit: ...and the bench forgets its kept copy once the request is in the folder',
        del.data.forgotten === true && keptNow(r?.id) === null && !relisted.receipts?.some((x) => x.receipt.id === r?.id),
        `forgotten ${del.data.forgotten}, file ${keptNow(r?.id) ? 'still there' : 'gone'}`);
      // A RECEIPT OF ANOTHER LINK asks nothing through this one - the
      // module's rule, refused before anything leaves, with the way to ask
      // there - and one that names no link is no receipt.
      const heardOther = seen.length;
      await refusedSubmit('delete with a receipt of another upload link: refused, with how to ask there', 'delete',
        { receipt: { ...JSON.parse(sent.data.receiptText), link: OTHER } }, 400,
        /^This receipt is of submission [0-9a-f]{8}, sent to another upload link than this copy's: a deletion is asked only through this copy's own link\. If you sent that fight yourself through that link, FAREVER_BENCH_UPLOAD_LINK=https:\/\/e\.pcloud\.com\/#\/puplink\?code=OtherCode5678 asks there\.$/);
      await refusedSubmit('delete with a receipt that names no upload link', 'delete', { receipt: { ...JSON.parse(sent.data.receiptText), link: null } }, 400,
        /^That is not a receipt of a sent fight: it names no upload link\.$/);
      check('submit: ...and neither reached the stand-in', seen.length === heardOther, `${seen.length - heardOther} request(s)`);
      // With no upload link there is nothing to ask through.
      process.env.FAREVER_BENCH_UPLOAD_LINK = 'none';
      await refusedSubmit('delete with no upload link: Send is off, and so is asking', 'delete', { receipt: sent.data.receiptText }, 503,
        /^Send is off in this copy of the bench \(no upload link is set\), so no deletion can be asked from it/);
      process.env.FAREVER_BENCH_UPLOAD_LINK = stubLink;

      // A SEND WHOSE ANSWER IS LOST keeps the bundle, hands back the
      // receipt, and Send again sends the very same one.
      seen.length = 0;
      const again = (await sub('preview', fight())).data;
      mode = 'drop';
      const failed = await sub('send', { previewId: again.previewId, consent: true });
      check('submit: a connection lost before pCloud answers is a 502 with the module\'s sentence and the receipt (sentAt null) to keep',
        failed.status === 502
        && /^The upload to the project's pCloud folder could not be reached( \([^)]*\))? - the fight may or may not have arrived\. Keep this bundle's receipt: sending the same bundle again stores at most a duplicate the maintainer drops/
          .test(failed.data.error ?? '')
        && failed.data.receipt?.sentAt === null && /^[0-9a-f]{32}$/.test(failed.data.receipt?.deleteToken ?? '')
        && JSON.parse(failed.data.receiptText ?? '{}').sentAt === null && !('arrived' in failed.data),
        `HTTP ${failed.status} ${(failed.data.error ?? '').slice(0, 160)}`);
      check('submit: ...and the receipt it hands back is the one kept on disk, still pending',
        failed.data.kept === keptFile(failed.data.receipt?.id) && keptNow(failed.data.receipt?.id)?.sentAt === null,
        `kept ${failed.data.kept}`);
      // A REFUSAL PCLOUD ANSWERS (a result other than 0): with nopartial=1
      // nothing of THIS send was kept, so it hands back no receipt - and the
      // one kept from the lost answer before it, whose send may have arrived,
      // stays on disk.
      mode = 'full';
      const full = await sub('send', { previewId: again.previewId, consent: true });
      check('submit: a folder pCloud says is full is a 507 in the module\'s words, pCloud\'s own in brackets, arrived: false and no receipt',
        full.status === 507
        && full.data.error === 'The project\'s pCloud folder is full (pCloud: This link has reached its file limit.) - nothing was kept; try again '
          + `another day, or save the .zip and attach it to a new issue: ${again.formUrl}`
        && full.data.arrived === false && !('receipt' in full.data) && !('receiptText' in full.data),
        `HTTP ${full.status} ${JSON.stringify(full.data).slice(0, 200)}`);
      mode = 'down';
      const down = await sub('send', { previewId: again.previewId, consent: true });
      check('submit: ...pCloud failing to store it is a 502, arrived: false, no receipt',
        down.status === 502 && down.data.error === 'pCloud could not store the zip (pCloud: Internal error. Try again later.) - nothing was kept; send it again later.'
        && down.data.arrived === false && !('receipt' in down.data),
        `HTTP ${down.status} ${JSON.stringify(down.data).slice(0, 200)}`);
      check('submit: ...and the receipt kept from the lost answer stays on disk, still pending - that send may have arrived',
        keptNow(failed.data.receipt?.id)?.sentAt === null && keptNow(failed.data.receipt?.id)?.deleteToken === failed.data.receipt?.deleteToken,
        JSON.stringify(keptNow(failed.data.receipt?.id) ?? null).slice(0, 120));
      // An answer that is not pCloud's API (a proxy's page) says nothing of
      // whether the fight arrived: the receipt again.
      mode = 'garbled';
      const garbled = await sub('send', { previewId: again.previewId, consent: true });
      check('submit: an answer that is not pCloud\'s API (an HTML 502) is a 502 that says so, with the receipt to keep',
        garbled.status === 502
        && /^pCloud answered 502 but not as its API does - whether the fight arrived cannot be told from here\. Keep this bundle's receipt/.test(garbled.data.error ?? '')
        && garbled.data.receipt?.id === failed.data.receipt?.id && garbled.data.receipt?.sentAt === null && !('arrived' in garbled.data),
        `HTTP ${garbled.status} ${(garbled.data.error ?? '').slice(0, 140)}`);
      // A preview whose send may have arrived is not one of "the 8 latest":
      // nine newer previews leave it held for Send again.
      for (let i = 0; i < 9; i++) await sub('preview', fight());
      mode = 'ok';
      const retry = await sub('send', { previewId: again.previewId, consent: true });
      const tries = uploads().filter((x) => x.id === failed.data.receipt?.id);
      check('submit: ...and Send again, after nine newer previews, sends the same bundle - one id, one name, the same bytes - and is answered',
        retry.status === 200 && retry.data.receipt?.id === failed.data.receipt?.id && retry.data.receipt?.deleteToken === failed.data.receipt?.deleteToken
        && tries.length === 5 && new Set(tries.map((x) => x.bytes?.toString('base64'))).size === 1 && new Set(tries.map((x) => x.fileName)).size === 1,
        `HTTP ${retry.status} ${String(retry.data.error ?? '').slice(0, 80)}, ${tries.length} uploads`);

      // BUILT AGAIN FROM ITS RECEIPT: the same files with a receipt's id,
      // token and time are the same bundle, byte for byte - what the dialog
      // does when the bench has let go of a bundle whose send was not
      // answered.
      mode = 'drop';
      const lost = (await sub('preview', fight({ note: 'Built twice.' }))).data;
      const lostZip = (await sub('bundle', { previewId: lost.previewId })).data.base64;
      const lostSend = await sub('send', { previewId: lost.previewId, consent: true });
      const lostId = lostSend.data.receipt?.id;
      const rebuilt = await sub('preview', fight({ note: 'Built twice.', again: lostSend.data.receiptText }));
      const rebuiltZip = rebuilt.status === 200 ? (await sub('bundle', { previewId: rebuilt.data.previewId })).data.base64 : null;
      check('submit: a preview with `again` (a receipt) is that submission built again - the same title and zip, byte for byte',
        lostSend.status === 502 && rebuilt.status === 200 && rebuilt.data.previewId !== lost.previewId && rebuilt.data.title === lost.title
        && typeof rebuiltZip === 'string' && rebuiltZip === lostZip
        && lostSend.data.receipt?.zipSha256 === sha256(Buffer.from(lostZip, 'base64')),
        `HTTP ${rebuilt.status} ${rebuilt.data.error ?? rebuilt.data.title}`);
      // The receipt names its bundle: other files under its id would put a
      // second, different fight under it in the folder, so they are refused -
      // the module's sentence - and nothing is held.
      await refusedSubmit('preview with `again` and other files than the receipt\'s bundle (its zipSha256)', 'preview',
        fight({ note: 'Built twice, but not the same.', again: lostSend.data.receiptText }), 400,
        /^These files make another bundle than the one submission [0-9a-f]{8} was sent as \(SHA-256 /);
      mode = 'ok';
      const againSent = await sub('send', { previewId: rebuilt.data.previewId, consent: true });
      const lostUploads = uploads().filter((x) => x.id === lostId);
      check('submit: ...and sent, it is the first send again - one id, one name, the same bytes: at most an identical copy in the folder',
        againSent.status === 200 && againSent.data.receipt?.id === lostId && lostUploads.length === 2
        && new Set(lostUploads.map((x) => x.bytes?.toString('base64'))).size === 1 && new Set(lostUploads.map((x) => x.fileName)).size === 1,
        `HTTP ${againSent.status}, ${lostUploads.length} uploads`);
      // A RECEIPT WHOSE FIGHT ARRIVED (its sentAt set) is built again all the
      // same - Save .zip saves the same bytes, as `bench submit --receipt <it>
      // --zip` does - but not sent: a second copy would only be stored beside
      // the first. The module's rule (sendRefusal, the receipt's sentAt given
      // to buildSubmission), which `bench submit --receipt <it> --send` asks
      // too.
      const answered = await sub('preview', fight({ note: 'Built twice.', again: againSent.data.receiptText }));
      const heardAnswered = uploads().length;
      const answeredSend = answered.status === 200 ? await sub('send', { previewId: answered.data.previewId, consent: true }) : null;
      const answeredZip = answered.status === 200 ? (await sub('bundle', { previewId: answered.data.previewId })).data.base64 : null;
      const arrivedAt = String(againSent.data.receipt?.sentAt ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      check('submit: a preview with `again` whose fight arrived is built again (the same zip) but Send is refused - sendRefused says so first, '
        + 'send is a 409 with it, nothing is uploaded and the kept receipt stays the completed one',
        answered.status === 200
        && new RegExp(`^The receipt this bundle is built again from is of submission ${String(lostId).slice(0, 8)}, whose fight arrived \\(${arrivedAt}\\): `
          + 'sending it again would only store a second copy beside the first\\. A changed bundle goes as a new submission - preview it without '
          + 'the receipt - and Delete, with that receipt, asks for the first one\'s deletion\\.$').test(answered.data.sendRefused ?? '')
        && answered.data.reportItems?.[0]?.kind === 'refused' && answered.data.reportItems[0].warn === true
        && answeredSend?.status === 409 && answeredSend.data.error === answered.data.sendRefused
        && uploads().length === heardAnswered
        && answeredZip === lostZip && keptNow(lostId)?.sentAt === againSent.data.receipt?.sentAt,
        `preview HTTP ${answered.status} ${String(answered.data.sendRefused ?? answered.data.error ?? '').slice(0, 120)}; `
        + `send HTTP ${answeredSend?.status}; ${uploads().length - heardAnswered} heard; same zip ${answeredZip === lostZip}`);
      // ...and other files under that receipt are refused with what is true
      // of it: not "send the same files" - nothing more goes under its id.
      await refusedSubmit('preview with `again` whose fight arrived and other files: the module says that one arrived, and a new submission is the way', 'preview',
        fight({ note: 'Not the same any more.', again: againSent.data.receiptText }), 400,
        /^These files make another bundle than the one submission [0-9a-f]{8} was sent as \(SHA-256 .*That one arrived \([^)]+\), so nothing more goes under its id/);
      await refusedSubmit('preview with `again` that is not a receipt', 'preview', fight({ again: '{"id":"nope"}' }), 400,
        /^again: That is not a receipt of a sent fight: /);
      // ...the receipt's own refusals are the module's (buildSubmission's
      // `receipt`), named by the field they came in.
      await refusedSubmit('preview with `again` whose receipt does not say when its bundle was made (the module\'s sentence)', 'preview',
        fight({ again: { ...JSON.parse(lostSend.data.receiptText), createdAt: null } }), 400,
        /^again: The receipt of submission [0-9a-f]{8} does not say when its bundle was made \(createdAt\), so that bundle cannot be built again byte for byte/);
      // A RECEIPT OF ANOTHER UPLOAD LINK: built again all the same - Save .zip
      // saves it, as `bench submit --receipt <it> --zip` does - and not sent:
      // sent elsewhere, the fight would be kept twice. The module's rule
      // (sendRefusal, the receipt's link), which `bench submit --receipt <it>
      // --send` asks too.
      const elsewhere = await sub('preview', fight({ note: 'Built twice.', again: { ...JSON.parse(lostSend.data.receiptText), link: OTHER } }));
      const heardElsewhere = seen.length;
      const elsewhereSend = elsewhere.status === 200 ? await sub('send', { previewId: elsewhere.data.previewId, consent: true }) : null;
      const elsewhereZip = elsewhere.status === 200 ? (await sub('bundle', { previewId: elsewhere.data.previewId })).data.base64 : null;
      check('submit: a preview with `again` from another upload link is built again (Save .zip saves the same zip) and Send is refused - '
        + 'sendRefused says where it may already be, send is a 409 with it, and nothing is uploaded',
        elsewhere.status === 200
        && /^The receipt this bundle is built again from is of submission [0-9a-f]{8}, written for another upload link than this copy's: a bundle is sent again where it may already be, or not at all - .* The bench started with FAREVER_BENCH_UPLOAD_LINK=https:\/\/e\.pcloud\.com\/#\/puplink\?code=OtherCode5678 sends it there; Save \.zip keeps this copy of it meanwhile\.$/
          .test(elsewhere.data.sendRefused ?? '')
        && elsewhere.data.reportItems?.[0]?.kind === 'refused' && elsewhereSend?.status === 409 && elsewhereSend.data.error === elsewhere.data.sendRefused
        && seen.length === heardElsewhere && elsewhereZip === lostZip,
        `preview HTTP ${elsewhere.status} ${String(elsewhere.data.sendRefused ?? elsewhere.data.error ?? '').slice(0, 160)}; send HTTP ${elsewhereSend?.status}; same zip ${elsewhereZip === lostZip}`);

      // A REQUEST PCLOUD REFUSES asked nothing, and the kept copy stays for
      // the next try; asked again, the request of a send never answered is in
      // the folder like any other.
      mode = 'drop';
      const pend = (await sub('preview', fight())).data;
      const pendSend = await sub('send', { previewId: pend.previewId, consent: true });
      mode = 'full';
      const pendFull = await sub('delete', { receipt: pendSend.data.receiptText });
      check('submit: a request for a deletion pCloud refuses says nothing was asked (arrived: false), and the bench keeps its copy of the receipt',
        pendSend.status === 502 && pendFull.status === 507 && pendFull.data.arrived === false
        && pendFull.data.error === 'The project\'s pCloud folder is full (pCloud: This link has reached its file limit.) - nothing was asked; try again another day.'
        && keptNow(pendSend.data.receipt?.id)?.sentAt === null,
        `HTTP ${pendFull.status} ${JSON.stringify(pendFull.data).slice(0, 160)}`);
      mode = 'ok';
      const pendDel = await sub('delete', { receipt: pendSend.data.receiptText });
      check('submit: ...asked again, it is in the folder - the request of a send never answered like any other - and the bench forgets its copy',
        pendDel.status === 200 && pendDel.data.requested === true && pendDel.data.forgotten === true && keptNow(pendSend.data.receipt?.id) === null
        && uploads().at(-1)?.fileName === `${pendSend.data.receipt?.id}.withdraw.json`,
        `HTTP ${pendDel.status} ${JSON.stringify(pendDel.data).slice(0, 160)}`);

      // A FOLDER THE RECEIPT CANNOT BE KEPT IN: nothing is sent.
      const cacheWas = process.env.FAREVER_BENCH_CACHE;
      const blocker = join(SCRATCH, 'check-api-not-a-folder');
      mkdirSync(SCRATCH, { recursive: true });
      writeFileSync(blocker, 'a file where the cache folder would be\n');
      const unkept = (await sub('preview', fight())).data;
      const heardBefore = seen.length;
      let noFolder;
      process.env.FAREVER_BENCH_CACHE = blocker;
      try {
        noFolder = await sub('send', { previewId: unkept.previewId, consent: true });
      } finally {
        process.env.FAREVER_BENCH_CACHE = cacheWas;
      }
      check('submit: a receipt that cannot be kept stops the send - a 507 that says so, and the stand-in hears nothing',
        noFolder.status === 507 && /^Nothing was sent: the bench could not keep this send's receipt as /.test(noFolder.data.error ?? '')
        && seen.length === heardBefore, `HTTP ${noFolder.status} ${String(noFolder.data.error ?? '').slice(0, 140)}`);
      const unkeptSent = await sub('send', { previewId: unkept.previewId, consent: true });
      check('submit: ...and the same preview sends once it can be kept', unkeptSent.status === 200 && !!unkeptSent.data.kept, `HTTP ${unkeptSent.status}`);

      // TWO SENDS AT ONCE: the second is refused while the first is out.
      mode = 'slow';
      const twin = (await sub('preview', fight())).data;
      const [first, second] = await Promise.all([
        sub('send', { previewId: twin.previewId, consent: true }),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 150)).then(() => sub('send', { previewId: twin.previewId, consent: true })),
      ]);
      check('submit: a second send of a preview already on its way is a 409, and the first is answered',
        first.status === 200 && second.status === 409 && /^This preview is being sent already/.test(second.data.error ?? ''),
        `first HTTP ${first.status}, second HTTP ${second.status} ${second.data.error ?? ''}`);
      mode = 'ok';

      // ITS DELETION ASKED WHILE IT IS ON ITS WAY is refused (409), nothing
      // asked: the send's answer would write its receipt back as completed
      // after the request forgot it. The stand-in holds the zip's answer
      // until told; the kept receipt the request is made with is the pending
      // one, as the dialog's list shows it.
      mode = 'hold';
      const onWay = (await sub('preview', fight())).data;
      const onWaySend = sub('send', { previewId: onWay.previewId, consent: true });
      for (let i = 0; i < 250 && !release; i++) await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      const onWayReceipt = (await sub('receipts', {})).data.receipts?.find((x) => x.receipt.id === onWay.id);
      const heardOnWay = uploads().length;
      const onWayDelete = await sub('delete', { receipt: onWayReceipt?.receiptText ?? '' });
      release?.();
      mode = 'ok';
      const onWayDone = await onWaySend;
      check('409: submit delete of a submission being sent - nothing is asked, the send is answered, and its receipt is kept completed',
        !!onWayReceipt && onWayReceipt.receipt.sentAt === null && onWayDelete.status === 409
        && /^Submission [0-9a-f]{8} is being sent right now - nothing was asked: ask for its deletion once that send is answered, within 10 minutes$/
          .test(onWayDelete.data.error ?? '')
        && uploads().length === heardOnWay && onWayDone.status === 200 && keptNow(onWay.id)?.sentAt === onWayDone.data.receipt?.sentAt,
        `receipt ${onWayReceipt?.receipt?.sentAt}; delete HTTP ${onWayDelete.status} ${onWayDelete.data.error ?? ''}; send HTTP ${onWayDone.status}`);

      // A SHEET OF ANOTHER CLASS THAN THE LOG'S is not sent - the module's
      // sendRefusal, the rule `bench submit --send` asks, and `bench verify`
      // will not price the pair - but Save .zip still saves it. The full
      // example sheet is a Rogue's.
      const fullText = readFileSync(join(ROOT, 'docs', 'examples', 'sheet-full.json'), 'utf8');
      const heardBefore2 = seen.length;
      const rogue = (await sub('preview', fight({ sheet: { file: { name: 'sheet-full.json', text: fullText } } }))).data;
      check('submit: a Rogue\'s sheet with a Warrior\'s log - the preview says Send refuses it, in the module\'s words, first in the report, '
        + 'with the app\'s remedy: the class chosen beside the sheet file',
        rogue.upload === true && /^The sheet is a Rogue and the fight's log names its character a Warrior, so it is not sent: .*\.$/.test(rogue.sendRefused ?? '')
        && / If the log's header is the one that is wrong, choosing Rogue as the class beside the sheet file says so, and it is sent\.$/.test(rogue.sendRefused ?? '')
        && !/--class/.test(rogue.sendRefused ?? '')
        && rogue.report?.[0] === `Problem: ${rogue.sendRefused}` && rogue.reportItems?.[0]?.kind === 'refused' && rogue.logClass === 'Warrior',
        `${rogue.sendRefused} / ${rogue.report?.[0]} / ${rogue.reportItems?.[0]?.kind}`);
      // Every line a reader warns of carries the module's `warn`, the flag
      // the page marks by (and `bench` colours by): every problem, the
      // refusal, and nothing the report only states.
      const flagged = (rogue.reportItems ?? []).filter((i) => i.warn === true).map((i) => i.kind);
      check('submit: the preview\'s report flags what it warns of (`warn`, the module\'s) - the refusal and every problem - and not what Send does or the names line',
        flagged.includes('refused') && flagged.includes('problem')
        && (rogue.reportItems ?? []).filter((i) => i.kind === 'problem').every((i) => i.warn === true)
        && (rogue.reportItems ?? []).filter((i) => i.kind === 'names' || i.kind === 'private').every((i) => i.warn === undefined),
        JSON.stringify((rogue.reportItems ?? []).map((i) => [i.kind, i.warn ?? null])).slice(0, 300));
      const rogueSend = await sub('send', { previewId: rogue.previewId, consent: true });
      const rogueZip = await sub('bundle', { previewId: rogue.previewId });
      const rogueId = rogueZip.status === 200 ? JSON.parse(entriesOf(rogueZip.data.base64)?.['manifest.json'] ?? '{}').id : null;
      check('submit: ...Send is a 409 with that sentence: the stand-in hears nothing and no receipt is kept - and Save .zip still saves the bundle',
        rogueSend.status === 409 && rogueSend.data.error === rogue.sendRefused && seen.length === heardBefore2
        && rogueZip.status === 200 && /^[0-9a-f]{32}$/.test(rogueId ?? '') && keptNow(rogueId) === null,
        `send HTTP ${rogueSend.status} ${String(rogueSend.data.error ?? '').slice(0, 80)}; ${seen.length - heardBefore2} heard; bundle HTTP ${rogueZip.status}`);
      // As on the CLI, a class chosen beside a file that names its own class,
      // naming the same, says the log's header is the one that is wrong: the
      // module decides that when it builds the bundle, and the page passes
      // only what was chosen (sheetOptions).
      const vouched = (await sub('preview', fight({ sheet: { file: { name: 'sheet-full.json', text: fullText } }, sheetOptions: { class: 'Rogue' } }))).data;
      check('submit: ...unless the class chosen beside a file that names its own class names the same - then the mismatch is a problem that says it is sent, and Send takes it',
        vouched.sendRefused === null
        && vouched.problems?.some((x) => /^the sheet is a Rogue and the log's character a Warrior - the class given beside the sheet names the sheet's own, .*so the pair is sent all the same$/.test(x))
        && !vouched.problems?.some((x) => /is not sent/.test(x)),
        `${vouched.error ?? vouched.sendRefused} ${JSON.stringify(vouched.problems).slice(0, 160)}`);
      // ...and sent: the module asks its rule again before the request
      // leaves, from the bundle alone - nothing is passed beside it.
      const heardBefore3 = uploads().length;
      const vouchedSend = await sub('send', { previewId: vouched.previewId, consent: true });
      check('submit: ...and sent, it reaches the stand-in and is answered',
        vouchedSend.status === 200 && vouchedSend.data.sent?.uploadedAs === `${vouchedSend.data.receipt?.id}.zip` && uploads().length === heardBefore3 + 1,
        `HTTP ${vouchedSend.status} ${String(vouchedSend.data.error ?? '').slice(0, 140)}`);
      // A modkit dump names no class: the one chosen for it is the one it is
      // read as, its only word on it, and vouches for nothing - the class the
      // dialog's question starts on included.
      const dumpPair = (await sub('preview', fight({ sheet: { file: { name: 'farever-inventory-Tester.json', text: dump } }, sheetOptions: { class: 'Rogue' } }))).data;
      const heardBefore4 = uploads().length;
      const dumpSend = dumpPair.previewId ? await sub('send', { previewId: dumpPair.previewId, consent: true }) : null;
      check('submit: a modkit dump read as the Rogue chosen for it, with a Warrior\'s log, is refused: the class chosen for a dump vouches for nothing - '
        + 'Send is a 409 and the stand-in hears nothing',
        /^The sheet is a Rogue and the fight's log names its character a Warrior, so it is not sent: .*A modkit dump names no class, so the class chosen for it is the sheet's only word on it, and cannot say the log is the one that is wrong\.$/
          .test(dumpPair.sendRefused ?? '')
        && dumpSend?.status === 409 && dumpSend.data.error === dumpPair.sendRefused && uploads().length === heardBefore4,
        `${dumpPair.error ?? dumpPair.sendRefused}; send HTTP ${dumpSend?.status}`);
    } finally {
      mode = 'ok';
      release?.();
      process.env.FAREVER_BENCH_UPLOAD_LINK = 'none';
      // The receipts this run made the bench keep go with it - only those, by
      // id, whatever folder FAREVER_BENCH_CACHE names.
      for (const id of madeIds) { try { unlinkSync(keptFile(id)); } catch { /* deleted above, or never kept */ } }
      try { unlinkSync(join(SCRATCH, 'check-api-not-a-folder')); } catch { /* never made */ }
      // fetch keeps its connection to the stand-in alive; close() would wait it out.
      stub.closeAllConnections?.();
      await new Promise((resolvePromise) => stub.close(resolvePromise));
    }
  }

  // --- optimize: fast config, pinned mainhand, SSE, round-trip --------------
  {
    const loadout = {
      class: 'Mage', level: 25,
      gear: { Slot_Weapon1: { item: 'Staff_Censer', rarity: 'Legendary', stars: 5 } },
      augments: {}, skills: {}, runes: {}, talents: {},
    };
    const runPins = { gear: ['Slot_Weapon1'], augments: [], skills: [], runes: [], talents: false };
    const { data: startData } = await api('/api/optimize/start', {
      loadout,
      pins: runPins,
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

      // ...and through the page's own Import. "Save build (.json)" writes this
      // envelope verbatim, and importing that file must hand the editor the
      // same build. "Same" is the BUILD, not the bytes: the reader writes a
      // non-weapon's rarity as the row's own (only weapons roll one), drops
      // the envelope's `generic: null`, and leaves out a talent node a socketed
      // sigil grants (it costs no point; the sheet grants it from the sigil) -
      // so the two are compared field by field with those three read the
      // game's way, and then priced side by side.
      {
        const back = await api('/api/import', { file: { name: 'farever-bench-Mage-dps.json', text: JSON.stringify(envelope, null, 2) } });
        const b = back.data ?? {};
        const granted = new Set(view?.talentState?.granted ?? []);
        const piece = (g) => g && ({
          item: g.item, rarity: g.rarity ?? cdb.byId('item').get(g.item)?.rarity ?? null, stars: g.stars ?? 0,
          level: g.level ?? null, flawless: g.flawless === true, prismatic: g.prismatic === true,
          infusion: g.infusion ?? null, infusionStat: g.infusionStat ?? null,
        });
        const build = (l) => JSON.stringify({
          class: l?.class, level: l?.level,
          gear: Object.fromEntries(Object.keys(l?.gear ?? {}).sort().map((s) => [s, piece(l.gear[s])])),
          augments: Object.fromEntries(Object.entries(l?.augments ?? {}).filter(([, v]) => v).sort()),
          skills: Object.fromEntries(Object.entries(l?.skills ?? {}).sort()),
          runes: Object.fromEntries(Object.entries(l?.runes ?? {}).filter(([, v]) => v).sort()),
          talents: Object.fromEntries(Object.entries(l?.talents ?? {}).filter(([id]) => !granted.has(id)).sort()),
        });
        // The pins, every field: what the run held is the request's, with
        // the infusions the search says it held (this request named none).
        const held = { ...runPins, infusions: envelope.pinned?.infusions };
        const field = (p, k) => JSON.stringify(k === 'talents' ? p?.[k] === true : [...(p?.[k] ?? [])].sort());
        const pinDiff = PIN_FIELDS.filter((k) => field(held, k) !== field(b.pins, k))
          .map((k) => `${k} ${field(held, k)} -> ${field(b.pins, k)}`);
        check('import: the envelope the page saves imports back as the same build, nothing dropped, the run\'s rank and every pin field',
          back.status === 200 && b.format === 'bench-envelope' && b.dropped?.length === 0
          && build(b.loadout) === build(envelope.build) && b.rank === envelope.rank && pinDiff.length === 0,
          back.status !== 200 ? `HTTP ${back.status} ${JSON.stringify(b).slice(0, 160)}`
            : `${b.dropped?.length} dropped; ${build(b.loadout) === build(envelope.build) ? 'same build' : `${build(b.loadout).slice(0, 120)} vs ${build(envelope.build).slice(0, 120)}`}; pins ${pinDiff.join(', ') || 'as held'}`);
        const opts = { target: 'boss', rank: envelope.rank ?? 3, mix: 0.5, goal: 'dps' };
        const [mine, theirs] = [await api('/api/sheet', { loadout: b.loadout, options: opts }),
          await api('/api/sheet', { loadout: envelope.build, options: opts })];
        check('import: ...and it prices exactly as the saved build does',
          mine.status === 200 && theirs.status === 200 && mine.data.dps === theirs.data.dps
          && JSON.stringify(mine.data.attributes) === JSON.stringify(theirs.data.attributes),
          `dps ${mine.data.dps} vs ${theirs.data.dps}`);
      }

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
          : [
            `ui only: ${Object.keys(envelope).filter((k) => !(k in (cli ?? {}))).join(',') || '-'}`,
            `cli only: ${Object.keys(cli ?? {}).filter((k) => !(k in envelope)).join(',') || '-'}`,
            // The two `pinned` objects, key by key: a field one writes and
            // the other does not is the usual cause, and the key lists above
            // cannot show it.
            `pinned: ${[...new Set([...Object.keys(envelope.pinned ?? {}), ...Object.keys(cli?.pinned ?? {})])]
              .filter((k) => JSON.stringify(envelope.pinned?.[k]) !== JSON.stringify(cli?.pinned?.[k]))
              .map((k) => `${k} ui ${JSON.stringify(envelope.pinned?.[k]) ?? 'absent'} / cli ${JSON.stringify(cli?.pinned?.[k]) ?? 'absent'}`)
              .join(', ') || 'same'}`,
            `infusionSearch ${JSON.stringify(cli?.infusionSearch) === JSON.stringify(envelope.infusionSearch) ? 'same' : 'differs'}`,
          ].join('; '));
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
