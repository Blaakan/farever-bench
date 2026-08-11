// ---------------------------------------------------------------------------
// drift.mjs - what changed under the model when the game updated.
//
// The model's whole trust story is that every number is read from the game's
// own data, so a patch is not a maintenance chore - it is an event this tool
// must detect, enumerate, and convert into a work list. Three artifacts:
//
//   FINGERPRINT   model/fingerprint.json, committed. One hash per row of every
//                 sheet the model consumes, one per skill script, the resolved
//                 name->findex table for every bytecode citation in src/, and
//                 the four class baselines. Small enough to diff in a PR.
//
//   DRIFT REPORT  the difference between the stored fingerprint and the
//                 install as it stands: rows added, removed and changed per
//                 sheet, scripts whose text moved, citations whose function
//                 moved or vanished.
//
//   WORK LIST     each change mapped to what it invalidates. A changed skill
//                 script needs its readers re-run AND a dummy session on
//                 whatever grants the skill - the reader can re-read text, but
//                 only a capture can confirm the model's reading of it. A
//                 changed constant or attribute row moves the sheet, which
//                 `bench verify`'s SHEET check can confirm from any existing
//                 snapshot. A moved citation is free to re-anchor (the name is
//                 the identity, the findex a cache); a VANISHED one means a
//                 formula's source no longer exists and the formula is
//                 unverified until someone re-reads the new code.
//
// The fingerprint only updates on --accept, so the drift report is stable and
// repeatable while the work it names is being done.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Every sheet the model reads anywhere. A sheet not listed here can change
// without the model noticing, so the list errs wide - unused columns hashing
// along costs a false positive at worst, never a false negative on a sheet
// that matters.
export const SHEETS = [
  'skill', 'item', 'itemType', 'attribute', 'affix', 'statusType', 'rarity',
  'constant', 'unit', 'slot', 'aptitude', 'affinity',
];

const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export function buildFingerprint(cdb, { code = null, srcDir = null, baselines = null } = {}) {
  const sheets = {};
  for (const name of SHEETS) {
    let lines;
    try { lines = cdb.lines(name); } catch { continue; }
    const rows = {};
    for (const r of lines) {
      if (r?.id == null) continue;
      rows[r.id] = h(JSON.stringify(r));
    }
    sheets[name] = rows;
  }
  // Script text hashed separately from the row: the readers execute the text,
  // so a script change is a different KIND of event than a stat nudge, and the
  // work list treats it as one.
  const scripts = {};
  for (const s of cdb.lines('skill')) {
    if (s?.script) scripts[s.id] = h(String(s.script));
  }
  const out = {
    at: new Date().toISOString(),
    cdbSha: cdb.meta.cdbSha,
    bootSha: cdb.meta.bootSha,
    sheets,
    scripts,
  };
  if (code && srcDir) out.citations = resolveCitations(code, srcDir).resolved;
  if (baselines) out.baselines = baselines;
  return out;
}

// Every name-at-findex citation in the model's source. The name is the
// identity - findexes drift every patch, names have survived every one so far
// - so each is resolved by name against the CURRENT bytecode and the stored
// findex is only a cache to compare against.
export function scanCitations(srcDir) {
  const found = new Map();   // name -> Set(findex as written)
  const CITE = /([A-Za-z_$][A-Za-z0-9_$.]*[A-Za-z0-9_$])@(\d{3,6})\b/g;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.mjs')) continue;
    const text = readFileSync(join(srcDir, f), 'utf8');
    CITE.lastIndex = 0;
    for (let m; (m = CITE.exec(text));) {
      // Most citations are bare method names - getStackFactor@20772 - and a
      // few are qualified. Both count; `fn@N` is anonymous and skipped here
      // (its findex IS its identity, nothing to resolve by name).
      if (m[1] === 'fn') continue;
      found.set(m[1], (found.get(m[1]) ?? new Set()).add(Number(m[2])));
    }
  }
  return found;
}

export function resolveCitations(code, srcDir) {
  const cited = scanCitations(srcDir);
  // Citations use the shortest unambiguous spelling - usually the bare method
  // name - and the bytecode names are fully qualified, so resolution is by
  // suffix: `getStackFactor` matches `$HSkill.getStackFactor`. A `$` in either
  // is namespace punctuation, not identity.
  const all = [];
  for (const [findex, name] of code.fnNames?.entries?.() ?? []) {
    all.push({ findex, name, norm: String(name).replace(/\$/g, '') });
  }
  const resolved = {};
  const report = [];
  for (const [name, findexes] of cited) {
    const norm = name.replace(/\$/g, '');
    const live = all.filter((x) => x.norm === norm
      || x.norm.endsWith(`.${norm}`));
    for (const cachedFindex of findexes) {
      if (!live.length) {
        report.push({ name, cached: cachedFindex, state: 'MISSING' });
      } else if (live.some((x) => x.findex === cachedFindex)) {
        report.push({ name, cached: cachedFindex, state: 'OK' });
        resolved[name] = cachedFindex;
      } else {
        report.push({ name, cached: cachedFindex, state: 'MOVED', now: live[0].findex });
        resolved[name] = live[0].findex;
      }
    }
  }
  return { resolved, report };
}

export function diffFingerprints(oldFp, newFp) {
  const sheets = {};
  for (const name of new Set([...Object.keys(oldFp.sheets ?? {}), ...Object.keys(newFp.sheets ?? {})])) {
    const a = oldFp.sheets?.[name] ?? {};
    const b = newFp.sheets?.[name] ?? {};
    const added = Object.keys(b).filter((id) => !(id in a));
    const removed = Object.keys(a).filter((id) => !(id in b));
    const changed = Object.keys(b).filter((id) => id in a && a[id] !== b[id]);
    if (added.length || removed.length || changed.length) sheets[name] = { added, removed, changed };
  }
  const a = oldFp.scripts ?? {};
  const b = newFp.scripts ?? {};
  const scripts = {
    added: Object.keys(b).filter((id) => !(id in a)),
    removed: Object.keys(a).filter((id) => !(id in b)),
    changed: Object.keys(b).filter((id) => id in a && a[id] !== b[id]),
  };
  return {
    same: oldFp.cdbSha === newFp.cdbSha && oldFp.bootSha === newFp.bootSha,
    cdbChanged: oldFp.cdbSha !== newFp.cdbSha,
    bootChanged: oldFp.bootSha !== newFp.bootSha,
    sheets,
    scripts,
  };
}

// The work list: every change, mapped to what it invalidates and how it gets
// re-validated. This is the honest half of the pipeline - the part that says
// which numbers cannot be trusted until a human logs in.
export function workList(diff, cdb) {
  const items = [];
  const skillHost = (skillId) => {
    // Who grants it - an item, a class, a talent tree - so the flag can say
    // WHERE to stand when validating.
    for (const it of cdb.lines('item')) {
      if ((it.skills ?? []).some((s) => (s.skill ?? s.ref ?? s) === skillId)) return `item ${it.id}`;
    }
    for (const u of cdb.lines('unit')) {
      if ((u.skills ?? []).some((s) => (s.skill ?? s.ref) === skillId)) return `class ${u.id}`;
      for (const tr of u.talentTrees ?? []) {
        if ((tr.talents ?? []).some((t) => t.skill === skillId)) return `${u.id} talent tree`;
      }
    }
    return null;
  };

  for (const id of diff.scripts.changed) {
    items.push({
      kind: 'script-changed', id,
      needs: 'in-game',
      why: `the script the readers execute changed - re-run the readers, then a dummy session on ${skillHost(id) ?? 'whatever grants it'} to confirm the new reading`,
    });
  }
  for (const id of diff.scripts.added) {
    items.push({ kind: 'script-added', id, needs: 'in-game', why: `a new script on ${skillHost(id) ?? 'an unknown host'} - nothing has ever validated it` });
  }
  const sheetNeeds = {
    constant: ['sheet', 'every formula consuming the constant moves - bench verify\'s SHEET check confirms from any existing snapshot; damage-side constants need a dummy session'],
    attribute: ['sheet', 'the attribute table drives the whole sheet - SHEET check on all four characters'],
    rarity: ['sheet', 'iLevel bonuses and star caps price every item - SHEET check plus one tooltip'],
    affix: ['sheet', 'affix kinds/composition rules moved - SHEET check'],
    statusType: ['model', 'the DoT/HoT flags decide which ticks crit - re-run the tick-crit table against a capture'],
    unit: ['in-game', 'target mitigation or class base stats moved - re-measure one boss and re-run SHEET'],
    item: ['sheet', 'item stats re-bake - SHEET check on an affected wearer, or the bakes log after one login'],
    itemType: ['model', 'slots/sockets/block grants moved - re-run verify on an affected build'],
    skill: ['model', 'steps/effects/vars moved - re-price, and a dummy session if the skill is damage-bearing'],
    slot: ['sheet', 'budget shares moved - SHEET check'],
    aptitude: ['sheet', 'class scaling moved - SHEET check'],
    affinity: ['model', 'mitigation routing moved - dummy vs boss comparison'],
  };
  for (const [sheet, d] of Object.entries(diff.sheets)) {
    const [needs, why] = sheetNeeds[sheet] ?? ['model', 'a sheet the model reads changed'];
    for (const id of d.changed) items.push({ kind: `${sheet}-changed`, id, needs, why });
    for (const id of d.added) items.push({ kind: `${sheet}-added`, id, needs, why: `new row - ${why}` });
    for (const id of d.removed) items.push({ kind: `${sheet}-removed`, id, needs: 'model', why: 'a row the model may cite no longer exists' });
  }
  return items;
}

export function fingerprintPath(repoRoot) {
  return join(repoRoot, 'model', 'fingerprint.json');
}

export function loadFingerprint(repoRoot) {
  const p = fingerprintPath(repoRoot);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
