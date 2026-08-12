// ---------------------------------------------------------------------------
// components/sheet.js - the Character Profile view + the reusable build
// renderer the optimize result pane borrows.
//
// Exposes (exact contract):
//   window.SheetView = { renderBuild(host, { loadout, view, boot, catalog,
//                                            title, readOnly }) }
// where `view` is a /api/sheet-shaped response (or null while computing).
// renderBuild never touches App.state; only interactive renders (readOnly
// false - i.e. the live profile view) wire handlers, and those mutate solely
// through App.setGear / setSkills / setAugment / clearSlot + window.Picker.
//
// An extra internal option `notice: {kind:'computing'|'illegal', text}` is
// used by the profile view itself for the status strip; external callers can
// ignore it (the documented contract is unchanged).
//
// This file also owns the chrome's accent colour: applyClassChrome() repaints
// the :root --teal* variables from the CURRENT class on every app-render, so
// the band, wedge, crest flag and tab accent follow the class. It lives here
// (not in app.js, which is frozen) and hangs off the same 'app-render' event
// app.js uses for the crest.
// ---------------------------------------------------------------------------

const App = window.App;

// ------------------------------------------------------------ tiny helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const el = (cls, tag = 'div') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

// Rarity helpers - index in the bootstrap ladder drives the r0..r4 classes.
export const rarityIndex = (boot, id) => {
  const i = boot?.rarities?.findIndex((r) => r.id === id) ?? -1;
  return i < 0 ? 0 : Math.min(i, 4);
};
export const rarityColor = (boot, id) =>
  boot?.rarities?.find((r) => r.id === id)?.color || '#e1e1e1';
export const rarityName = (boot, id) =>
  boot?.rarities?.find((r) => r.id === id)?.name || String(id ?? '');

export const authoredRarity = (item) =>
  item?.rarities?.find((r) => r.authored) || item?.rarities?.[0] || null;

export const bestRarity = (boot, item) => {
  let best = null;
  for (const r of item?.rarities || []) {
    if (!best || rarityIndex(boot, r.id) > rarityIndex(boot, best.id)) best = r;
  }
  return best;
};

const starsStr = (n) => '★'.repeat(Math.max(0, n | 0));

const findItem = (catalog, slotId, itemId) =>
  catalog?.slots?.[slotId]?.find((i) => i.id === itemId) || null;

// ------------------------------------------------------ colour derivation
// The API hands out exactly one '#rrggbb' per rarity and per class. Every
// tint the sheet paints is derived from that one number, so adding a rarity
// or a class needs no CSS at all - which is the whole point of doing this in
// JS instead of hardcoding five gradients.

const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const toHex = (rgb) => '#' + rgb
  .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
  .join('');

// Rec.601 luma, 0..1 - the weighting the eye actually uses to judge "is this
// dark enough to carry the band's near-white text".
const luma = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;

const mix = (rgb, target, k) => rgb.map((v, i) => v + (target[i] - v) * k);
const scale = (rgb, k) => rgb.map((v) => v * k);

// A rarity-tinted equipment tile: the hue is pulled a third of the way to its
// own grey (the game's tiles are tinted metal, not neon) and then shaded into
// a vertical gradient, a lighter inner border and a dark outer rim - all four
// from the same hue so the tile reads as one object.
export function tileTint(hex) {
  const rgb = hexRgb(hex);
  if (!rgb) return null;
  const g = luma(rgb) * 255;
  const base = mix(rgb, [g, g, g], 0.3);
  return {
    '--tile-a': toHex(scale(base, 0.46)),
    '--tile-b': toHex(scale(base, 0.27)),
    '--tile-edge': toHex(mix(base, [255, 255, 255], 0.3)),
    '--tile-rim': toHex(scale(base, 0.13)),
  };
}

// Chrome accent. The class colours are authored for icons, so a light one
// (Priest #cfb079) would drown the band's #f2ede2 text - cap the luma first,
// then derive every shade by multiplying it. --teal* keep their names because
// the other component stylesheets already read them; overriding the values on
// :root recolours picker headers and the rest for free.
const CHROME_KEYS = ['--teal', '--teal-dark', '--teal-band', '--teal-flag'];
const CHROME_MAX_LUMA = 0.52;

export function applyClassChrome() {
  const root = document.documentElement;
  const cls = App.boot?.classes?.find((c) => c.unit === App.state?.cls);
  const rgb = hexRgb(cls?.color);
  if (!rgb) {                       // unknown class: fall back to the sheet
    for (const k of CHROME_KEYS) root.style.removeProperty(k);
    return;
  }
  const l = luma(rgb);
  const base = l > CHROME_MAX_LUMA ? scale(rgb, CHROME_MAX_LUMA / l) : rgb;
  const at = (k) => toHex(scale(base, k));
  root.style.setProperty('--teal', toHex(base));
  root.style.setProperty('--teal-dark', at(0.78));            // level wedge
  root.style.setProperty('--teal-band',
    `linear-gradient(180deg, ${at(1.14)}, ${at(0.93)})`);
  root.style.setProperty('--teal-flag',
    `linear-gradient(180deg, ${at(1.26)}, ${at(0.99)} 70%, ${at(0.86)})`);
}

// --------------------------------------------------------- tooltip builders

// Game-style item tooltip from a /api/tooltip/item response.
export function itemTipHtml(boot, t) {
  const ri = rarityIndex(boot, t.rarityId);
  let stars = '';
  if ((t.maxStars | 0) > 0) {
    const got = Math.max(0, t.stars | 0);
    stars = ' ' + '★'.repeat(got)
          + '☆'.repeat(Math.max(0, (t.maxStars | 0) - got));
  }
  let h = `<div class="tname r${ri}">${esc(t.name)}</div>`;
  const type = [
    [t.typeName, t.slotLabel].filter(Boolean).join(' — '),
    t.iLevel != null ? `iLvl ${t.iLevel}` : null,
    t.rarityName || null,
  ].filter(Boolean).join(' · ');
  if (type || stars) h += `<div class="ttype">${esc(type)}${esc(stars)}</div>`;
  if (t.damageLine) {
    h += `<div class="taffix">${esc(t.damageLine)}` + (t.weaponPower != null
      ? ` <span class="tmeta">WP ${esc((+t.weaponPower).toFixed(1))}</span>` : '') + `</div>`;
  }
  for (const a of t.affixes || []) h += `<div class="taffix">${esc(a.display)}</div>`;
  // The upgrade rider: a weapon at 3 stars or more earns a unique effect the
  // stat lines never mention (daggers hit harder from behind, and so on).
  if (t.upgrade) {
    h += `<hr><div class="tupgrade-h">${esc(t.upgrade.name || 'Weapon Upgraded')}`
       + `<span class="tmeta"> ${esc(t.upgrade.unlockedAt ?? 3)}★</span></div>`;
    if (t.upgrade.desc) h += `<div class="tupgrade">${esc(t.upgrade.desc)}</div>`;
    for (const a of t.upgrade.affixes || []) {
      h += `<div class="taffix">${esc(a.display)}</div>`;
    }
  }
  if (t.skills?.length) {
    h += `<div class="tmeta">Skills: ${t.skills.map((s) => esc(s.name)).join(' · ')}</div>`;
  }
  if (t.gives) h += `<div class="tmeta">gives ${esc(t.gives)}</div>`;
  if (t.flavor) h += `<hr><div class="tdesc">${esc(t.flavor)}</div>`;
  if (t.acquire) h += `<div class="tacquire">${esc(t.acquire)}</div>`;
  const pins = (t.track || [])
    .map((p) => `${esc(p.label || 'map pin')} (${esc(p.x)}, ${esc(p.y)})`)
    .join(' · ');
  if (pins) h += `<div class="tmeta">${pins}</div>`;
  if (t.faction) h += `<div class="tmeta">Faction: ${esc(t.faction)}</div>`;
  return h;
}

// Augment tooltip from a bootstrap.augments entry.
export function augTipHtml(boot, aug, note) {
  const ri = rarityIndex(boot, aug.rarity);
  let h = `<div class="tname r${ri}">${esc(aug.name)}</div>`;
  h += `<div class="ttype">${esc(rarityName(boot, aug.rarity))} augment</div>`;
  if (aug.effect) h += `<div class="taffix">${esc(aug.effect)}</div>`;
  if (note) h += `<div class="tacquire">${esc(note)}</div>`;
  if (aug.acquire) h += `<div class="tacquire">${esc(aug.acquire)}</div>`;
  return h;
}

// /api/tooltip/item body for an equipped loadout entry.
const itemTipBody = (loadout, slotId, entry) => {
  const augments = [];
  for (const [k, v] of Object.entries(loadout?.augments || {})) {
    if (k.startsWith(slotId + '/') && v) augments.push(v);
  }
  const body = {
    class: loadout?.class, charLevel: loadout?.level,
    item: entry.item, slot: slotId, augments,
  };
  if (entry.rarity != null) body.rarity = entry.rarity;
  if (entry.stars != null) body.stars = entry.stars;
  if (entry.level != null) body.level = entry.level;
  return body;
};

// Lazy skill tooltip (fetched on hover, cached by bindTip's closure caller).
const skillTip = (loadout, skillId) => () =>
  App.api('/api/tooltip/skill', {
    skill: skillId,
    rank: App.state?.options?.rank ?? 3,
    runes: loadout?.runes?.[skillId] ? [loadout.runes[skillId]] : [],
    // Without the build the server can only quote the authored coefficient
    // ("120% Intellect"); with it, the same numbers the damage meter shows.
    loadout,
    options: App.state?.options,
  }).then((t) => {
    let h = `<div class="tname">${esc(t.name)}</div>`;
    const bits = [];
    if (t.nature) bits.push(esc(t.nature));
    if (t.cooldown) bits.push(`${esc(t.cooldown)}s cooldown`);
    if (t.charges) bits.push(`${esc(t.charges)} charges`);
    if (bits.length) h += `<div class="ttype">${bits.join(' · ')}</div>`;
    h += rankLadderHtml(t);
    return h;
  });

// A weapon skill is three skills: the base cast plus what ranks 2 and 3 add.
// The bench assumes all three (options.rank defaults to weaponSkillMaxRank),
// so the tooltip shows the whole ladder and marks which lines are live.
export function rankLadderHtml(t) {
  const rows = (t.ranks || []).filter((r) => r?.desc);
  if (!rows.length) return t.desc ? `<div class="tdesc">${esc(t.desc)}</div>` : '';
  let h = '';
  for (const r of rows) {
    const on = r.active !== false;
    h += `<div class="trank${on ? '' : ' off'}">`
       + `<span class="trank-n">${esc(r.rank)}</span>`
       + `<span class="trank-d">${esc(r.desc)}</span></div>`;
  }
  return h;
}

// The currently chosen ids of a pool: the loadout is the freshest truth
// (a click mutates it instantly, the sheet lags a debounce behind); when the
// loadout has no explicit entry, fall back to the server's chosen flags.
const chosenOf = (pool, loadout) => {
  const picked = loadout?.skills?.[pool.key];
  if (Array.isArray(picked)) return picked.slice();
  // Every option in the list is a pick that costs a slot - including a weapon
  // passive the arsenal offers. Dropping passives here silently rewrote the
  // server's own selection.
  return (pool.options || []).filter((o) => o.chosen).map((o) => o.id);
};

// ------------------------------------------------------------- renderBuild

const hostMore = new WeakMap();   // host -> 'More stats' toggle (view-local)
const hostOpts = new WeakMap();   // host -> last opts (for local re-render)

export function renderBuild(host, opts = {}) {
  if (!host) return;
  hostOpts.set(host, opts);
  const { loadout, view, title, readOnly, notice } = opts;
  const ctx = {
    host, loadout, view, title,
    boot: opts.boot || App.boot,
    catalog: opts.catalog || App.catalog,
    inter: !readOnly,             // every handler is gated on this
  };
  host.replaceChildren();
  const sheet = el('sheet');
  if (notice?.kind === 'computing') {
    const s = el('strip computing');
    s.textContent = 'computing…';
    sheet.append(s);
  } else if (notice?.kind === 'illegal' && notice.text) {
    const s = el('strip illegal');
    s.textContent = '⚠ ' + notice.text;
    sheet.append(s);
  }
  const cols = el('columns');
  cols.append(statsPanel(ctx), paperDoll(ctx), weaponsPanel(ctx));
  sheet.append(cols);
  host.append(sheet);
}

// ------------------------------------------------------- left: stats panel

function statsPanel(ctx) {
  const p = el('panel');
  const np = el('nameplate');
  np.textContent = ctx.title || ctx.loadout?.class || '—';
  p.append(np);
  const head = el('ornhead');
  head.textContent = 'Attributes';
  p.append(head);

  const more = !!hostMore.get(ctx.host);
  const attrs = ctx.view?.attributes || [];
  const rows = more
    ? attrs.filter((a) => a.group !== 'primary')
    : attrs.filter((a) => a.group === 'primary');

  if (!rows.length) {
    // no sheet yet - placeholder bars (shimmer while the first sheet computes)
    for (let i = 0; i < 5; i++) {
      const r = el('statrow shimmer');
      r.append(el('lab'), el('val'));
      p.append(r);
    }
  } else {
    let prev = null;
    for (const a of rows) {
      // gap between stat groups, and between Armor and the health block,
      // matching the game's More-stats spacing.
      if (prev && (prev.group !== a.group || prev.id === 'Armor')) {
        p.append(el('statrow gap'));
      }
      p.append(statRow(ctx, a));
      prev = a;
    }
  }

  const btnRow = el('morebtn-row');
  const btn = el('btn btn-red', 'button');
  btn.type = 'button';
  btn.textContent = 'More stats';
  if (ctx.inter) {
    btn.addEventListener('click', () => {
      hostMore.set(ctx.host, !more);
      renderBuild(ctx.host, hostOpts.get(ctx.host));
    });
  }
  btnRow.append(btn);
  p.append(btnRow);
  return p;
}

function statRow(ctx, a) {
  const row = el('statrow');
  const lab = el('lab');
  lab.textContent = a.name;
  const val = el('val');
  val.append(document.createTextNode(a.display ?? String(a.value ?? '')));
  if (a.sub) {
    const s = el('sub', 'span');
    s.textContent = a.sub;
    val.append(s);
  }
  row.append(lab, val);
  const meta = ctx.boot?.attributes?.[a.id];
  App.bindTip(row, () => {
    let h = `<div class="tname">${esc(a.name)}</div>`;
    if (meta?.desc) h += `<div class="tdesc">${esc(meta.desc)}</div>`;
    const note = ctx.view?.ratingNotes?.[a.id];
    if (note) h += `<div class="tacquire">${esc(note)}</div>`;
    return h;
  });
  return row;
}

// ---------------------------------------------------- center: paper doll

// The game puts a 3D character between the two tile columns; we render none,
// so the columns sit side by side and the class crest is the only backdrop.
const WATERMARK_W = 210;

// App.icon() forces a square box, but the class crest is 76x103 - without the
// ref's own aspect the art gets cropped at the bottom.
function watermarkIcon(ref, w) {
  const ico = App.icon(ref, w);
  const [, , iw, ih] = ref?.px || [];
  if (iw > 0 && ih > 0) ico.style.height = Math.round((w * ih) / iw) + 'px';
  return ico;
}

function paperDoll(ctx) {
  const d = el('doll');
  const wm = el('watermark');
  const cls = ctx.boot?.classes?.find((c) => c.unit === ctx.loadout?.class);
  if (cls?.icon) wm.append(watermarkIcon(cls.icon, WATERMARK_W));
  d.append(wm);

  const bySide = { left: [], right: [] };
  for (const s of ctx.boot?.slots || []) {
    if (s.column === 'left' || s.column === 'right') bySide[s.column].push(s);
  }
  const left = el('slotcol');
  for (const s of bySide.left) left.append(slotTile(ctx, s));
  const right = el('slotcol');
  for (const s of bySide.right) right.append(slotTile(ctx, s));
  d.append(left, right);
  return d;
}

// One equipment tile. opts: { small (64px weapon-card size), forbid (string:
// slot is disabled with this tooltip - used for the off hand under a 2H) }.
function slotTile(ctx, slotDef, o = {}) {
  const slotId = slotDef.id;
  const t = el('slot');
  if (o.small) t.classList.add('slot-sm');
  const entry = ctx.loadout?.gear?.[slotId];
  const item = entry ? findItem(ctx.catalog, slotId, entry.item) : null;

  if (entry && !item) {
    // an id the current catalog does not know (older save, other patch)
    t.classList.add('empty');
    const q = el('unknown-item');
    q.textContent = '?';
    t.append(q);
    App.bindTip(t, `<div class="tname">${esc(entry.item)}</div>` +
      `<div class="ttype">not in this game version's catalog</div>`);
  } else if (entry) {
    const rid = entry.rarity ?? authoredRarity(item)?.id;
    t.classList.add('r' + rarityIndex(ctx.boot, rid));   // DOM hook only
    // The whole tile - fill, inner edge, outer rim - is the rarity's own
    // colour, derived here so a new rarity needs no stylesheet edit.
    const tint = tileTint(rarityColor(ctx.boot, rid));
    if (tint) for (const [k, v] of Object.entries(tint)) t.style.setProperty(k, v);
    t.append(App.icon(item?.icon, o.small ? 54 : 64));
    if ((entry.stars | 0) > 0) {
      const st = el('stars');
      st.textContent = starsStr(entry.stars);
      t.append(st);
    }
    const lv = entry.level ?? item?.level;
    if (lv != null) {
      const b = el('lvl-badge');
      b.textContent = lv;
      t.append(b);
    }
    App.bindTip(t, () =>
      App.api('/api/tooltip/item', itemTipBody(ctx.loadout, slotId, entry))
        .then((r) => itemTipHtml(ctx.boot, r)));
  } else {
    t.classList.add('empty');
    const g = App.icon(slotDef.emptyIcon, o.small ? 40 : 46);
    g.classList.add('ghost');
    t.append(g);
    const label = esc(slotDef.label || slotDef.short || slotId);
    App.bindTip(t, o.forbid
      ? `<div class="tname">${label}</div><div class="ttype">${esc(o.forbid)}</div>`
      : `<div class="tname">${label}</div><div class="ttype">empty${ctx.inter ? ' — click to choose' : ''}</div>`);
  }

  if (ctx.inter && !o.forbid) {
    t.addEventListener('click', () => window.Picker?.openGear(slotId));
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      App.clearSlot(slotId);
    });
  } else if (o.forbid) {
    t.classList.add('forbid');
  }

  // Armour sockets (sigil, jeweller, blacksmith...) ride the tile's corner;
  // the weapon cards render their own socket row below the card instead.
  if (!/Weapon/.test(slotId) && entry) {
    const socks = socketRow(ctx, slotId);
    if (socks) {
      socks.classList.add('sock-overlay');
      socks.addEventListener('click', (e) => e.stopPropagation());
      socks.addEventListener('contextmenu', (e) => e.stopPropagation());
      t.append(socks);
    }
  }
  return t;
}

// ------------------------------------------------- right: weapons panel

function weaponsPanel(ctx) {
  const p = el('panel');
  const wh = el('ornhead');
  wh.textContent = 'Weapons';
  p.append(wh);

  // main hand ------------------------------------------------------------
  p.append(weaponCard(ctx, 'Slot_Weapon1', 'Main Hand'));

  // off hand - only usable when the equipped main hand allows it ---------
  const mhEntry = ctx.loadout?.gear?.Slot_Weapon1;
  const mhItem = mhEntry ? findItem(ctx.catalog, 'Slot_Weapon1', mhEntry.item) : null;
  const offAllowed = !!mhItem?.allowsOffhand;
  p.append(weaponCard(ctx, 'Slot_OffhandWeapon', 'Off Hand', {
    ghost: !offAllowed || !ctx.loadout?.gear?.Slot_OffhandWeapon,
    forbid: offAllowed ? null : 'requires a one-handed main hand',
  }));

  // arsenal --------------------------------------------------------------
  const ah = el('ornhead');
  ah.textContent = 'Arsenal';
  p.append(ah);
  p.append(weaponCard(ctx, 'Slot_Weapon2', null, { orbs: true }));

  // class-skill bar (class + mechanic pools) -----------------------------
  const cpools = (ctx.view?.pools || [])
    .filter((q) => q.kind === 'class' || q.kind === 'mechanic');
  if (cpools.length) {
    const sh = el('ornhead');
    sh.textContent = 'Skills';
    p.append(sh);
    const bar = el('classbar');
    for (const q of cpools) bar.append(classPoolRow(ctx, q));
    p.append(bar);
  }
  return p;
}

function weaponCard(ctx, slotId, label, o = {}) {
  const card = el('wcard');
  if (o.ghost) card.classList.add('ghost');
  const slotDef = ctx.boot?.slots?.find((s) => s.id === slotId)
    || { id: slotId, label: label || slotId };
  const wrow = el('wrow');
  wrow.append(slotTile(ctx, slotDef, { small: true, forbid: o.forbid }));
  const pool = (ctx.view?.pools || []).find((q) => q.key === slotId);
  if (o.orbs && pool) {
    // arsenal: the pick-2-of-3 orbs sit right next to the tile
    for (const orb of poolOrbs(ctx, pool)) wrow.append(orb);
  }
  if (label) {
    const wl = el('wlabel');
    wl.textContent = label;
    wrow.append(wl);
  }
  card.append(wrow);
  if (!o.orbs && pool) card.append(poolTileRow(ctx, pool));
  const socks = socketRow(ctx, slotId);
  if (socks) card.append(socks);
  return card;
}

// Square tiles: all options (chosen colored, others greyscale) + granted
// passives with a 'P' badge.
function poolTileRow(ctx, pool) {
  const row = el('skillrow');
  const chosen = chosenOf(pool, ctx.loadout);
  for (const opt of pool.options || []) row.append(skillTile(ctx, pool, opt, chosen));
  for (const g of pool.alsoGranted || []) row.append(passiveTile(ctx, g));
  return row;
}

// Selection has to be the loudest thing in the panel, so it gets three
// distinct states rather than a subtle outline: 'picked' is lit (full-colour
// art, gold ring, glow, corner pip), 'always' is lit but unringed (a weapon
// passive folded into the pool was never a choice), 'off' is dimmed hard.
// Both shapes share the classes; style.css draws them.
function markChoice(node, n) {
  if (n > 0) node.classList.add('picked');
  else node.classList.add('off');
}

// A passive that is one of the pool's picks still says so, because the cost is
// the surprising part: taking the arsenal's passive spends one of its two
// slots. `passiveTile` below is the other kind - granted, free, never a choice.
function passiveMark(node) {
  const b = el('badge pas');
  b.textContent = 'P';
  b.title = 'a passive — taking it uses one of this pool\'s slots';
  node.append(b);
}

function skillTile(ctx, pool, opt, chosen) {
  const t = el('skilltile');
  const n = chosen.filter((id) => id === opt.id).length;
  markChoice(t, n);
  t.append(App.icon(opt.icon, 42));
  if (n > 1) {
    const b = el('badge cnt');
    b.textContent = '×' + n;
    t.append(b);
  } else if (opt.passive) passiveMark(t);
  App.bindTip(t, skillTip(ctx.loadout, opt.id));
  if (ctx.inter) {
    t.addEventListener('click', () => poolClick(ctx, pool, opt.id));
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (pool.kind === 'mechanic') poolRemove(ctx, pool, opt.id);
    });
  }
  return t;
}

function passiveTile(ctx, granted) {
  const t = el('skilltile passive');
  t.append(App.icon(granted.icon, 42));
  const b = el('badge');
  b.textContent = 'P';
  t.append(b);
  App.bindTip(t, skillTip(ctx.loadout, granted.id));
  return t;
}

function poolOrbs(ctx, pool) {
  const chosen = chosenOf(pool, ctx.loadout);
  return (pool.options || []).map((opt) => {
    const t = el('skillorb');
    const n = chosen.filter((id) => id === opt.id).length;
    markChoice(t, n);
    t.append(App.icon(opt.icon, 36));
    if (opt.passive) passiveMark(t);
    App.bindTip(t, skillTip(ctx.loadout, opt.id));
    if (ctx.inter) {
      t.addEventListener('click', () => poolClick(ctx, pool, opt.id));
    }
    return t;
  });
}

function poolClick(ctx, pool, id) {
  const chosen = chosenOf(pool, ctx.loadout);
  const i = chosen.indexOf(id);
  if (pool.kind === 'mechanic' && pool.repeats) {
    // A repeating pool (Mage conduits) may hold the same option in several
    // slots: click adds a copy, right-click removes one. Prayers do not
    // repeat, so they fall through to the plain one-of-each rule below.
    if (chosen.length < pool.slots) chosen.push(id);
    else if (i < 0) { chosen.shift(); chosen.push(id); }
    else { App.toast('all slots used — right-click removes one'); return; }
  } else if (i >= 0) {
    chosen.splice(i, 1);
  } else if (chosen.length < pool.slots) {
    chosen.push(id);
  } else {
    chosen.shift();                       // at capacity: swap out the oldest
    chosen.push(id);
  }
  App.setSkills(pool.key, chosen);
}

function poolRemove(ctx, pool, id) {
  const chosen = chosenOf(pool, ctx.loadout);
  const i = chosen.indexOf(id);
  if (i < 0) return;
  chosen.splice(i, 1);
  App.setSkills(pool.key, chosen);
}

function classPoolRow(ctx, pool) {
  const row = el('cpool');
  const chosen = chosenOf(pool, ctx.loadout);
  const lab = el('plabel');
  lab.append(document.createTextNode(pool.label || pool.key));
  const cnt = el('pcount', 'span');
  cnt.textContent = `${Math.min(chosen.length, pool.slots | 0)}/${pool.slots | 0}`;
  lab.append(cnt);
  row.append(lab);
  for (const opt of pool.options || []) row.append(skillTile(ctx, pool, opt, chosen));
  for (const g of pool.alsoGranted || []) row.append(passiveTile(ctx, g));
  return row;
}

// Augment sockets of one gear slot (from the sheet's socket list).
function socketRow(ctx, slotId) {
  const socks = (ctx.view?.sockets || [])
    .filter((s) => (s.slot || String(s.key || '').split('/')[0]) === slotId);
  if (!socks.length) return null;
  const row = el('sockrow');
  for (const s of socks) {
    const type = s.type || String(s.key || '').split('/')[1] || '';
    const short = type.replace(/^Augment/, '') || 'augment';
    // the loadout is fresher than the (debounced) sheet
    const cur = ctx.loadout?.augments?.[s.key] ?? s.current ?? null;
    const aug = cur
      ? (ctx.boot?.augments?.[type] || []).find((a) => a.id === cur) : null;
    const b = el('sockbtn');
    if (aug) {
      b.classList.add('filled');
      b.append(App.icon(aug.icon, 24));
    } else {
      const plus = el('plus', 'span');
      plus.textContent = cur ? '?' : '+';
      if (cur) b.classList.add('filled');
      b.append(plus);
    }
    App.bindTip(b, () => aug
      ? augTipHtml(ctx.boot, aug)
      : `<div class="tname">${esc(short)} socket</div>` +
        `<div class="ttype">${cur ? esc(cur) : 'empty' + (ctx.inter ? ' — click to socket' : '')}</div>`);
    if (ctx.inter) {
      b.addEventListener('click', () => window.Picker?.openAugment(s.key));
    }
    row.append(b);
  }
  return row;
}

// --------------------------------------------------------- the live view

let lastGood = null;   // last legal sheet, kept under an illegal edit

App.view('profile', {
  mount() {},
  render(host) {
    const live = App.sheet;
    if (live && !live.illegal) lastGood = live;
    const usable = live && !live.illegal ? live : lastGood;
    let notice = null;
    if (!live) notice = { kind: 'computing' };
    else if (live.illegal) notice = { kind: 'illegal', text: live.illegal };
    renderBuild(host, {
      loadout: App.state.loadout,
      view: usable,
      boot: App.boot,
      catalog: App.catalog,
      title: App.state.name,
      readOnly: false,
      notice,
    });
  },
});

// The chrome lives outside every view host, so it repaints on the same event
// app.js redraws the crest on rather than inside a view's render().
document.addEventListener('app-render', applyClassChrome);
applyClassChrome();

window.SheetView = { renderBuild };
