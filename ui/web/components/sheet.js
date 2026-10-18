// ---------------------------------------------------------------------------
// components/sheet.js - the Character Profile view + the reusable build
// renderer the optimize result pane borrows.
//
// Exposes (exact contract):
//   window.SheetView = { renderBuild(host, { loadout, view, boot, catalog,
//                                            title, readOnly, search }) }
// where `view` is a /api/sheet-shaped response (or null while computing) and
// `search` - the optimize result's only - is what the search was allowed to do
// (which infusions it could hand out, and why the others were withheld).
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

// Offered rows first, then the ones the catalog withholds: a build can wear a
// withheld piece (a saved file, the user's own pick) and it is still a row.
const findItem = (catalog, slotId, itemId) =>
  catalog?.slots?.[slotId]?.find((i) => i.id === itemId)
  || catalog?.withheld?.[slotId]?.find((i) => i.id === itemId) || null;

const slotShort = (boot, slotId) =>
  boot?.slots?.find((s) => s.id === slotId)?.label || String(slotId).replace(/^Slot_/, '');

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
  // The infusion block, in the game's own order and words (the server fills
  // its text rows): the line naming the infusion, then - whenever a bonus roll
  // is stated - the bonus block under the PIECE's faction, shown dimmed while
  // the piece is not paid it, with the reason. The game shows a dark line too;
  // hiding it would hide the one thing there is to fix.
  if (t.infusion) {
    h += `<hr><div class="tinf">${esc(t.infusion.text || t.infusion.name)}</div>`;
    if (!t.infusion.obtainable) {
      h += `<div class="twarn">nothing hands out its pattern on this build: ${esc(t.infusion.source?.why)}</div>`;
    }
  }
  if (t.infusionBonus) {
    const b = t.infusionBonus;
    h += `${t.infusion ? '' : '<hr>'}<div class="tinfbonus${b.active ? '' : ' off'}">`
       + `<div class="tinf-h">${esc(b.title || 'Infusion bonus')}`
       + (b.prismatic ? ` <span class="tmeta">${esc(boot?.constants?.infusion?.texts?.prismatic || 'Prismatic')}</span>` : '')
       + `</div><div class="taffix">${esc(b.display)}</div></div>`;
    if (b.note) h += `<div class="tmeta">${esc(b.note)}</div>`;
  } else if (t.infusion && t.infusionPool?.length) {
    h += `<div class="tmeta">its bonus roll is not stated, so no bonus is priced - it is one of `
       + `${t.infusionPool.map((p) => `+${esc(p.value)} ${esc(p.name)}`).join(', ')}</div>`;
  }
  if (t.skills?.length) {
    h += `<div class="tmeta">Skills: ${t.skills.map((s) => esc(s.name)).join(' · ')}</div>`;
  }
  if (t.gives) h += `<div class="tmeta">gives ${esc(t.gives)}</div>`;
  if (t.flavor) h += `<hr><div class="tdesc">${esc(t.flavor)}</div>`;
  // Where it comes from: the atlas's line when it has one, else what the
  // install itself says hands the row out (the catalog's source reader). A
  // row NOTHING hands out has no source to print - its reader's sentence is
  // the reason it is not offered, and is said once, as that.
  if (t.acquire) h += `<div class="tacquire">${esc(t.acquire)}</div>`;
  else if (t.source?.why && t.source.state !== 'unreleased') {
    h += `<div class="tacquire">Source: ${esc(t.source.why)}</div>`;
  }
  if (t.withheld) h += `<div class="twarn">Not offered: ${esc(t.withheld.why)}</div>`;
  const pins = (t.track || [])
    .map((p) => `${esc(p.label || 'map pin')} (${esc(p.x)}, ${esc(p.y)})`)
    .join(' · ');
  if (pins) h += `<div class="tmeta">${pins}</div>`;
  if (t.faction) h += `<div class="tmeta">Faction: ${esc(t.factionName || t.faction)}</div>`;
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
  if (entry.infusion) body.infusion = entry.infusion;
  if (entry.infusionStat) body.infusionStat = entry.infusionStat;
  if (entry.prismatic) body.prismatic = true;
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
//
// The same shape carries the other two ladders the server knows. A talent, a
// status or a class skill comes back as ONE line at the rank it is worn at; an
// infusion comes back as its set bonuses, each with the game's own `title`
// ("(4) Set") where a mastery line has only a number, and a `desc` that can
// run over several lines (the sentence, then the stat line that set turns on).
export function rankLadderHtml(t) {
  const rows = (t.ranks || []).filter((r) => r?.desc);
  if (!rows.length) return t.desc ? `<div class="tdesc">${esc(t.desc)}</div>` : '';
  // One untitled line is not a ladder, and a number beside it would read as a
  // mastery rank the row does not have (Blink is not "rank 3" of anything).
  const lone = (t.ranks || []).length === 1 && !rows[0].title;
  let h = '';
  for (const r of rows) {
    const on = r.active !== false;
    h += `<div class="trank${on ? '' : ' off'}">`
       + (lone ? ''
         : r.title
           ? `<span class="trank-n trank-t">${esc(r.title)}</span>`
           : `<span class="trank-n">${esc(r.rank)}</span>`)
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
    search: opts.search || null,  // an optimize result's: what was searched
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
  const inf = infusionBlock(ctx);
  if (inf) sheet.append(inf);
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
    // The level the piece is PRICED at: the one the user set, else the
    // server's default for the row - the top of its range when it scales with
    // you, the bottom when it keeps its own. Reading `item.level` here badged
    // an equipped Demon piece (authored level 1, priced at yours) with a "1".
    const rng = Array.isArray(item?.levelRange) ? item.levelRange : null;
    const lv = entry.level
      ?? (rng ? rng[item.levelScales !== false ? 1 : 0] : item?.level);
    if (lv != null) {
      const b = el('lvl-badge');
      b.textContent = lv;
      t.append(b);
    }
    // The infusion the piece carries, as its own icon in the corner; ringed
    // when its bonus line is lit (the sheet says - a roll that is stated, on
    // a piece of the infusion's faction or a Prismatic one).
    if (entry.infusion) {
      const def = ctx.boot?.infusions?.find((x) => x.id === entry.infusion);
      const ib = el('inf-badge');
      ib.append(App.icon(def?.icon, 20));
      const piece = ctx.view?.infusions?.pieces?.find((p) => p.slot === slotId);
      if (piece?.lit) ib.classList.add('lit');
      t.append(ib);
    }
    // A piece the catalog withholds wears a mark, and its tooltip says why.
    if (item?.withheld) t.classList.add('held');
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
  const pip = poolPinPip(ctx, pool);
  if (pip) row.append(pip);
  return row;
}

// The mark a PINNED pool wears, and the way to take the pin off. A pin nobody
// can see is a search that hands your own selection back and does not say so;
// this is the rune page's pip, made a control. Editor only: the result pane
// shows the optimizer's answer, which has no pins.
function poolPinPip(ctx, pool) {
  if (!ctx.inter || !App.state?.pins?.skills?.has(pool.key)) return null;
  const pip = el('pinpip poolpin', 'span');
  App.bindTip(pip, '<div class="tname">Pinned</div>'
    + '<div class="tdesc">The optimizer keeps this selection. Click to unpin and let it choose.</div>');
  pip.addEventListener('click', (e) => {
    e.stopPropagation();
    App.unpinSkills(pool.key);
  });
  return pip;
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
  }).concat(poolPinPip(ctx, pool) || []);
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
  // Only a selection that fills the pool is a pin - see App.setSkills.
  App.setSkills(pool.key, chosen, { full: chosen.length >= (pool.slots | 0) });
}

function poolRemove(ctx, pool, id) {
  const chosen = chosenOf(pool, ctx.loadout);
  const i = chosen.indexOf(id);
  if (i < 0) return;
  chosen.splice(i, 1);
  App.setSkills(pool.key, chosen, { full: chosen.length >= (pool.slots | 0) });
}

function classPoolRow(ctx, pool) {
  const row = el('cpool');
  const chosen = chosenOf(pool, ctx.loadout);
  const lab = el('plabel');
  lab.append(document.createTextNode(pool.label || pool.key));
  const cnt = el('pcount', 'span');
  cnt.textContent = `${Math.min(chosen.length, pool.slots | 0)}/${pool.slots | 0}`;
  lab.append(cnt);
  const pip = poolPinPip(ctx, pool);
  if (pip) lab.append(pip);
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

// ------------------------------------------------------ the infusion block

// Which infusions the search may hand out, as the list of ids the page's
// option stands for: "learnable" is every one the install does not show to be
// unobtainable (the model's own default), or the explicit list.
export const offeredInfusions = (boot, option) => {
  const all = boot?.infusions || [];
  if (Array.isArray(option)) return all.filter((x) => option.includes(x.id)).map((x) => x.id);
  if (option === 'all') return all.map((x) => x.id);
  if (option === 'none') return [];
  return all.filter((x) => x.obtainable).map((x) => x.id);
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The sets a build wears, what of each is IN the number and what is not, each
// infused piece's bonus line - and, in the editor, what the optimizer may hand
// out. Everything printed is the sheet's own (view.infusions is the engine's
// attach, named); nothing here decides a rank or a price. The block is absent
// on a build of the game with no infusions.
function infusionBlock(ctx) {
  const defs = ctx.boot?.infusions || [];
  if (!defs.length) return null;
  const consts = ctx.boot?.constants?.infusion || {};
  const caps = consts.caps || [];
  const box = el('infblock');
  const head = el('ornhead');
  head.textContent = consts.texts?.header || 'Infusions';
  box.append(head);

  const inf = ctx.view?.infusions;
  if (!inf) {
    const w = el('infnote');
    w.textContent = ctx.view ? '' : 'computing…';
    box.append(w);
  } else if (!inf.sets.length) {
    const n = el('infnote');
    const can = inf.infusable.length;
    n.textContent = can
      ? `no piece is infused - ${can} of the pieces worn can be; a set pays at ${caps.join(' / ')} pieces of one infusion`
      : `nothing worn can be infused - only ${rarityName(ctx.boot, consts.minRarity)} armour with a faction can`;
    box.append(n);
  } else {
    for (const s of inf.sets) box.append(infusionSetRow(ctx, s));
    const pl = infusionPieces(ctx, inf);
    if (pl) box.append(pl);
  }

  if (ctx.inter) box.append(infusionSearchControls(ctx, defs));
  else if (ctx.search?.infusions) box.append(infusionSearchSummary(ctx, ctx.search.infusions));
  return box;
}

function infusionSetRow(ctx, s) {
  const wrap = el('infset');
  const row = el('infset-row');
  row.append(App.icon(s.icon, 38));
  const mid = el('infset-mid');
  const nm = el('infset-name');
  nm.textContent = s.name;
  const sub = el('infset-sub');
  // The rank is the SET's - how many of the caps its piece count reaches -
  // and its title is the game's own ("(4) Set").
  sub.textContent = [s.factionName, plural(s.pieces, 'piece', 'pieces'),
    s.attached ? s.title : `below the first set bonus (${s.nextCap})`]
    .filter(Boolean).join(' · ');
  mid.append(nm, sub);
  row.append(mid);
  const sc = el('infset-scored');
  // "; " between entries: one can be a whole clause with commas of its own
  // (a set's part in the fight: "Wet on the foe: +2% ... a stack, up to 3,
  // one stack on ..."), which is also how the engine's own sentence joins them.
  sc.textContent = s.priced.length ? `scored: ${s.priced.join('; ')}`
    : (s.attached ? 'scored: nothing at this rank' : 'nothing attached');
  if (!s.priced.length) sc.classList.add('none');
  row.append(sc);
  App.bindTip(row, skillTip(ctx.loadout, s.id));
  wrap.append(row);

  if (s.note) {
    const n = el('infnote');
    n.textContent = s.note;
    wrap.append(n);
  }
  if (s.source?.state === 'unreleased') {
    const w = el('infwarn');
    w.textContent = `nothing hands out its pattern on this build - ${s.source.why}`;
    wrap.append(w);
  }
  if (s.unpriced.length) {
    // What the set does that the fight does not score, by name. Folded: the
    // list is the audit, the count is the headline.
    const det = el('inf-unscored', 'details');
    const sum = el('', 'summary');
    sum.textContent = `${plural(s.unpriced.length, 'thing', 'things')} this set does ${s.unpriced.length === 1 ? 'is' : 'are'} NOT scored`
      + (s.priced.length ? ' - what is listed above is what it is worth here' : ' - it is worth nothing here');
    det.append(sum);
    const ul = el('', 'ul');
    for (const u of s.unpriced) {
      const li = el('', 'li');
      li.textContent = u;
      ul.append(li);
    }
    det.append(ul);
    if (s.why) {
      const why = el('infnote');
      why.textContent = s.why;
      det.append(why);
    }
    // the fold is this block's own control in the read-only result pane too
    det.classList.add('opt-allow');
    wrap.append(det);
  }
  return wrap;
}

// One line per piece that carries an infusion or a stated roll, then the one
// sentence that adds them up - what is lit, what is dark, what nobody stated.
function infusionPieces(ctx, inf) {
  const rows = inf.pieces.filter((p) => p.infusion || p.stat);
  if (!rows.length) return null;
  const box = el('infpieces');
  for (const p of rows) {
    const r = el('infpiece');
    const where = el('infpiece-slot', 'span');
    where.textContent = slotShort(ctx.boot, p.slot);
    const what = el('infpiece-what', 'span');
    if (p.stat) {
      what.textContent = p.display || `+${p.wouldBe} ${p.statName}`;
      what.classList.add(p.lit ? 'lit' : 'dark');
      if (!p.lit) what.textContent += ' (dark - not paid)';
    } else {
      what.textContent = 'no bonus roll stated - priced at 0'
        + (p.ceiling > 0 ? ` (up to +${p.ceiling})` : '');
      what.classList.add('blind');
    }
    r.append(where, what);
    if (p.note) {
      App.bindTip(r, `<div class="tname">${esc(p.itemName)}</div>`
        + `<div class="ttype">${esc(p.infusionName || 'not infused')}${p.prismatic ? ' · Prismatic' : ''}</div>`
        + `<div class="tdesc">${esc(p.note)}</div>`);
    }
    box.append(r);
  }
  const lit = rows.filter((p) => p.lit && p.value);
  const dark = rows.filter((p) => p.infusion && p.stat && !p.lit);
  const blind = rows.filter((p) => p.infusion && !p.stat);
  const bits = [];
  if (lit.length) {
    bits.push(`${plural(lit.length, 'lit bonus line pays', 'lit bonus lines pay')} ${lit.reduce((n, p) => n + p.value, 0)} rating`);
  }
  if (dark.length) bits.push(`${dark.length} dark (the infusion is another faction's and the piece is not Prismatic)`);
  if (blind.length) {
    const low = blind.reduce((n, p) => n + p.ceiling, 0);
    bits.push(`${blind.length} with no roll stated, priced at 0`
      + (low > 0 ? ` (up to ${low} rating if the faction-matched ones are lit)` : ''));
  }
  if (bits.length) {
    const sum = el('infnote');
    sum.textContent = `bonus stat: ${bits.join('; ')}`;
    box.append(sum);
  }
  return box;
}

// The editor's two search controls: which infusions the optimizer may hand
// out, and what it takes an unowned piece's bonus roll to be. An orb is lit
// when the infusion is offered. The default offers every one the install does
// not show to be unobtainable; the others carry a mark and say why on hover,
// and can still be lit - a player may know better than a client build does.
function infusionSearchControls(ctx, defs) {
  const box = el('infsearch');
  const opt = App.state?.options || {};
  const offered = new Set(offeredInfusions(ctx.boot, opt.infusions));
  const lab = el('inflabel');
  lab.textContent = `The optimizer may hand out ${offered.size} of ${defs.length}`;
  box.append(lab);

  const orbs = el('inforbs');
  for (const d of defs) {
    const holder = el('inforb');
    const orb = el('skillorb ' + (offered.has(d.id) ? 'picked' : 'off'));
    orb.append(App.icon(d.icon, 32));
    holder.append(orb);
    if (!d.obtainable) holder.append(el('inf-nosrc', 'span'));
    App.bindTip(holder, () => skillTip(ctx.loadout, d.id)().then((h) => h
      + `<div class="tmeta">${esc(d.factionName)} infusion</div>`
      + `<div class="${d.obtainable ? 'tacquire' : 'twarn'}">`
      + `${d.obtainable ? 'Pattern: ' : 'nothing hands out its pattern on this build: '}${esc(d.source?.why)}</div>`));
    holder.addEventListener('click', () => {
      const next = new Set(offered);
      if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
      const ids = defs.filter((x) => next.has(x.id)).map((x) => x.id);
      // Back on exactly the learnable set is back on the default, by name.
      const learnable = defs.filter((x) => x.obtainable).map((x) => x.id);
      App.setOption('infusions',
        ids.length === learnable.length && ids.every((id, i) => id === learnable[i]) ? 'learnable' : ids);
    });
    orbs.append(holder);
  }
  box.append(orbs);

  const held = defs.filter((d) => !d.obtainable);
  if (held.length) {
    const n = el('infnote');
    const dot = el('inf-nosrc', 'span');
    n.append(dot, document.createTextNode(
      ` ${plural(held.length, 'infusion', 'infusions')} nothing hands out on this build - withheld unless you light ${held.length === 1 ? 'it' : 'them'} (hover says why)`));
    box.append(n);
  }

  const pol = el('infpolicy');
  const pl = el('', 'label');
  pl.textContent = 'An infused piece nobody owns is taken to have rolled';
  const sel = el('', 'select');
  const choices = [['none', 'nothing - no bonus line is priced'], ['best', 'its best rating'],
    ...(ctx.boot?.constants?.infusion?.stats || []).map((s) => [s.id, s.name])];
  for (const [value, text] of choices) {
    const o = el('', 'option');
    o.value = value;
    o.textContent = text;
    if (value === (opt.infusionStat || 'none')) o.selected = true;
    sel.append(o);
  }
  sel.addEventListener('change', () => App.setOption('infusionStat', sel.value));
  pol.append(pl, sel);
  box.append(pol);
  return box;
}

// The result pane's counterpart: what THIS search was allowed to do.
function infusionSearchSummary(ctx, s) {
  const box = el('infsearch');
  const line = el('infnote');
  line.textContent = `searched: ${s.offered.length} of ${s.total} infusions`
    + (s.statPolicy === 'none' ? '; an unowned piece\'s bonus roll is priced at 0'
      : `; an unowned faction-matched piece is taken to have rolled ${s.statPolicy === 'best' ? 'its best rating'
        : (ctx.boot?.attributes?.[s.statPolicy]?.name || s.statPolicy)}`);
  box.append(line);
  for (const w of s.withheld || []) {
    const l = el('infwarn');
    l.textContent = `withheld: ${w.name} - ${w.why}`;
    box.append(l);
  }
  if (!s.offered.length) {
    const l = el('infnote');
    l.textContent = 'no infusion was offered to the search';
    box.append(l);
  }
  return box;
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
