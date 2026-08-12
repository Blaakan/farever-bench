// ---------------------------------------------------------------------------
// components/runes.js — the rune page: editable here, read-only in the
// optimize result pane.
//
// Exposes (exact contract):
//   window.RunesView = { renderRunes(host, { loadout, view, boot, readOnly }) }
// where `view` is a /api/sheet-shaped response (or null while one computes).
// renderRunes reads ONLY its arguments — never App.state — so the result pane
// can draw a foreign build; readOnly binds zero click/contextmenu handlers but
// still binds every tooltip (the result sheet must stay hoverable). The live
// tab is the same renderer fed App.state with readOnly false, so there is one
// implementation, exactly like sheet.js. (`rank` is accepted as an optional
// extra: it only picks which rank the server renders in a skill tooltip, and
// defaults to the editor's setting.)
//
// One .runerow per pool from view.runePools: skill icon + name at the left
// (server tooltip via /api/tooltip/skill), then the rune options as circular
// .skillorb tiles — the chosen one gets the gold .picked ring, clicking it
// again clears the slot (pinned-empty). Rune definitions come from
// boot.runes[skill].options; runes the bench cannot score wear the .unmod-dot
// marker, which is explained by the legend line, by its own tooltip, and again
// inside the rune tooltip — the same dot in all three places.
// ---------------------------------------------------------------------------
import App from '../app.js';
import { rankLadderHtml } from './sheet.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

// The one sentence that gives the dot its meaning; the legend, the dot's own
// tooltip and the rune tooltip all say it with the same words.
const UNMOD_WHY = 'the bench cannot score this rune — its effect is ' +
  'script-only, so it is shown but never chosen by the optimizer';

const UNMOD_TIP = '<div class="tname tgold">Not modelled</div>' +
  `<div class="tdesc">${UNMOD_WHY}</div>`;

// ------------------------------------------------------------- tooltips

const tipCache = new Map();          // 'skill|rank|rune|build' -> Promise<html>

// Cheap identity for a loadout: what a tooltip's numbers actually depend on.
const buildKey = (l) => !l ? '-' : [
  l.class, l.level,
  Object.entries(l.gear || {}).map(([k, v]) =>
    `${k}:${v?.item}@${v?.rarity ?? ''}*${v?.stars ?? 0}^${v?.level ?? ''}`).join(','),
  Object.entries(l.augments || {}).map(([k, v]) => `${k}=${v}`).join(','),
  Object.entries(l.talents || {}).map(([k, v]) => `${k}=${v}`).join(','),
].join('|');

function skillTip(pool, current, rank, loadout) {
  // The build is part of the key: the same skill prices differently once the
  // gear moves, so a cached tip from an older loadout would quote stale damage.
  const key = `${pool.skill}|${rank}|${current ?? ''}|${buildKey(loadout)}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const p = App.api('/api/tooltip/skill', {
    skill: pool.skill,
    rank,
    runes: current ? [current] : [],
    loadout,
    options: App.state?.options,
  }).then((t) => {
    const bits = [];
    if (t.nature) bits.push(String(t.nature).replace(/([a-z])([A-Z])/g, '$1 $2'));
    if (t.cooldown) bits.push(`${t.cooldown}s cooldown`);
    if (t.charges) bits.push(`${t.charges} charges`);
    return `<div class="tname tgold">${esc(t.name)}</div>` +
           (bits.length ? `<div class="ttype">${esc(bits.join(' · '))}</div>` : '') +
           rankLadderHtml(t);
  }).catch((e) => `<div class="ttype">${esc(e.message)}</div>`);
  tipCache.set(key, p);
  return p;
}

function runeTip(def, skillName) {
  return `<div class="tname tgold">${esc(def.name)}</div>` +
         `<div class="ttype">Rune · ${esc(skillName)}</div>` +
         (def.desc ? `<div class="tdesc">${esc(def.desc)}</div>` : '') +
         (def.readable === false
           ? `<div class="tmeta"><span class="unmod-dot"></span> ${UNMOD_WHY}</div>`
           : '');
}

// bindTip hides on the element's OWN mouseleave, and mouseleave fires
// innermost-first — so sliding off the dot back onto the orb would leave the
// row tipless until the pointer left the row entirely. Replay the enter the
// holder never gets. Leaving the holder outright still ends with the holder's
// own mouseleave, which hides, so this cannot strand a tooltip.
function nestedTip(holder, inner, html) {
  App.bindTip(inner, html);
  inner.addEventListener('mouseleave', (e) => {
    holder.dispatchEvent(new MouseEvent('mouseenter',
      { clientX: e.clientX, clientY: e.clientY }));
  });
}

// ---------------------------------------------------------------- render

function makeRow(ctx, pool) {
  const row = el('div', 'runerow');
  // The loadout is the freshest truth (a click mutates it instantly, the
  // sheet lags a debounce behind); fall back to what the server reported.
  const current = ctx.loadout?.runes
    ? (ctx.loadout.runes[pool.skill] ?? null)
    : (pool.current ?? null);

  const sk = el('div', 'skname');
  sk.appendChild(App.icon(pool.icon, 38));
  const nm = el('span');
  nm.textContent = pool.name ?? pool.skill;
  sk.appendChild(nm);
  if (ctx.inter && App.state.pins.runes.has(pool.skill)) {
    const pip = el('span', 'pinpip');
    pip.title = 'pinned — the optimizer keeps this rune choice';
    sk.appendChild(pip);
  }
  App.bindTip(sk, () => skillTip(pool, current, ctx.rank, ctx.loadout));
  row.appendChild(sk);

  const defs = new Map(
    (ctx.boot?.runes?.[pool.skill]?.options ?? []).map((o) => [o.id, o]));

  const choices = el('div', 'rchoices');
  for (const rid of pool.options ?? []) {
    const def = defs.get(rid) ??
      { id: rid, name: rid, desc: '', icon: null, readable: false };
    const chosen = current === rid;

    const holder = el('div', 'runechoice');
    const orb = el('div', 'skillorb ' + (chosen ? 'picked' : 'off'));
    orb.appendChild(App.icon(def.icon, 36));
    holder.appendChild(orb);
    App.bindTip(holder, runeTip(def, pool.name ?? pool.skill));
    if (def.readable === false) {
      const dot = el('span', 'unmod unmod-dot');
      holder.appendChild(dot);
      ctx.unmodShown = true;
      nestedTip(holder, dot, UNMOD_TIP);
    }

    if (ctx.inter) {
      holder.addEventListener('click', () =>
        App.setRune(pool.skill, chosen ? null : rid));
      holder.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (chosen) App.setRune(pool.skill, null);
      });
    }
    choices.appendChild(holder);
  }
  row.appendChild(choices);
  return row;
}

function legendLine() {
  const line = el('div', 'rune-legend');
  line.appendChild(el('span', 'unmod-dot'));
  const txt = el('span');
  txt.textContent = UNMOD_WHY;
  line.appendChild(txt);
  App.bindTip(line, UNMOD_TIP);
  return line;
}

function renderRunes(host, opts = {}) {
  if (!host) return;
  host.replaceChildren();
  const sheet = el('div', 'sheet');
  const wrap = el('div', 'runes-wrap' + (opts.readOnly ? ' readonly' : ''));
  sheet.appendChild(wrap);
  host.appendChild(sheet);

  const head = el('div', 'ornhead');
  head.textContent = 'Runes';
  wrap.appendChild(head);

  const ctx = {
    loadout: opts.loadout ?? null,
    boot: opts.boot ?? null,
    inter: !opts.readOnly,
    // Which rank the server renders in a skill tooltip — a display setting,
    // not part of the build, so the editor's value is a fine default.
    rank: opts.rank ?? App.state?.options?.rank ?? 3,
    unmodShown: false,
  };

  if (!opts.view || !ctx.boot) {                      // sheet still computing
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'runerow skeleton');
      row.appendChild(el('div', 'skel-ico'));
      row.appendChild(el('div', 'skel-bar'));
      wrap.appendChild(row);
    }
    return;
  }

  const pools = opts.view.runePools ?? [];
  if (!pools.length) {
    const note = el('div', 'runes-empty');
    note.innerHTML =
      '<b>No runes yet.</b><br>' +
      'Runes appear here for the class skills your character knows — they ' +
      'unlock with level, and equipped weapons add their own skills. Raise ' +
      'the level or equip a weapon and the rune-bearing skills will list ' +
      'themselves.';
    wrap.appendChild(note);
    return;
  }

  const rows = pools.map((pool) => makeRow(ctx, pool));
  // The legend earns its line only when a dot is actually on screen.
  if (ctx.unmodShown) wrap.appendChild(legendLine());
  for (const row of rows) wrap.appendChild(row);
}

// --------------------------------------------------------- the live view

App.view('runes', {
  render(host) {
    renderRunes(host, {
      loadout: App.state.loadout,
      view: App.sheet,
      boot: App.boot,
      readOnly: false,
    });
  },
});

window.RunesView = { renderRunes };
