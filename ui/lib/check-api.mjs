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
// ---------------------------------------------------------------------------

import { tmpdir } from 'node:os';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRATCH = join(tmpdir(), 'farever-bench-checks');

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

try {
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

  // --- sheet: naked Mage 25 (values from sheet-engine.md §9) ----------------
  {
    const naked = {
      class: 'Mage', level: 25, gear: {}, augments: {}, skills: {}, runes: {}, talents: {},
    };
    // the 8.04 smoke dps is the reference-target number; boss reads 7.61
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
    check('sheet naked: dps ~8.04', Math.abs((s.dps ?? 0) - 8.04) < 0.1,
      s.dps?.toFixed(3));
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
    check('tooltip: weaponPower ~108.75',
      Math.abs((t.weaponPower ?? 0) - 108.75) < 0.1, String(t.weaponPower));
    check('tooltip: damage line', t.damageLine === '≈39–47 per swing', t.damageLine);
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
      const { envelope, view, score } = done.data;
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
    }
  }
} finally {
  await close();
}

console.log(failed
  ? `${failed} check(s) FAILED${warned ? `, ${warned} warned` : ''}`
  : `all checks passed${warned ? ` (${warned} warned - icons.mjs pending)` : ''}`);
process.exit(failed ? 1 : 0);
