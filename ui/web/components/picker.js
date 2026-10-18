// ---------------------------------------------------------------------------
// components/picker.js - the modal gear / augment picker.
//
//   window.Picker = { openGear(slotId), openAugment(socketKey) }
//
// Uses the .modal-veil/.picker classes from style.css (list rows and config
// column extras in css/sheet.css); the instance-level control and the edit
// note are the pieces with their own sheet, css/picker.css. Wires its own
// keyboard handling: Esc closes, typing anywhere filters the list. All
// mutations go through App.setGear / App.setAugment / App.clearSlot.
//
// openGear on a slot that already holds something opens ON that item, with the
// configuration the loadout holds - it is the edit path as well as the pick
// path, and there is no other way to restar an equipped weapon.
//
// Two things the catalog decides and this file only shows:
//   * the rows it WITHHOLDS (nothing in the install hands them out, or every
//     copy exists above the character's level) are listed apart, dimmed, each
//     with the source reader's sentence. They can still be picked - a person
//     may, a search never does - and the config column repeats the reason;
//   * whether a piece can carry an INFUSION, which ones light its bonus line,
//     and which infusions anything hands out. The three infusion fields of a
//     gear entry are written here and nowhere else in the page.
// ---------------------------------------------------------------------------

import {
  esc, itemTipHtml, augTipHtml, rarityColor, rarityName,
  authoredRarity, bestRarity,
} from './sheet.js';

const App = window.App;

const el = (cls, tag = 'div') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const snip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const fmtPct = (c) => {
  const p = c * 100;
  return (p > 0 && p < 1 ? p.toFixed(1) : Math.round(p)) + '%';
};

const num = (v) => (Number.isFinite(v) ? v : null);

// The level a list row prints under its name - see `itemRow` for what the
// label may and may not claim. `levelRange[0]` is the level the row's band
// starts at, which the server floors at the level every copy is made at.
const levelLabel = (it, charLevel = App.state?.level) => {
  const lo = num(it.levelRange?.[0]);
  if (it.level != null) return `lvl ${Math.max(it.level, lo ?? it.level)}`;
  return lo != null && num(charLevel) != null && lo !== charLevel ? `lvl ${lo}` : 'at your level';
};

// ------------------------------------------------------------------ search

// A row is matched on everything it shows, not on its name alone: the thing a
// player types is as often an effect or a drop source as a title.
//
// The data writes stats short and glued, so a substring is not enough - the
// Demon gifts read "-20 CritChanceRtg +20 FervorRtg", and "critical" is inside
// none of it. Splitting on the camelCase seams gives the words back ("crit",
// "chance", "rtg"), and a typed word also matches when a data word OPENS it,
// which is what carries "crit" -> "critical" and "pen" -> "penetration". The
// three-letter floor is there so a two-letter fragment cannot open everything.
// Multi-word queries are AND: every word has to land somewhere in the row.
const HEAD_MIN = 3;

const hayCache = new WeakMap();

const buildHay = (parts) => {
  const text = parts.filter(Boolean).map(String).join(' ');
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= HEAD_MIN);
  return { low: text.toLowerCase(), words: [...new Set(words)] };
};

// Keyed on the catalog/bootstrap row itself: those objects are replaced whole
// when class or level changes, so nothing here goes stale.
const hayOf = (row, ...parts) => {
  let h = hayCache.get(row);
  if (!h) hayCache.set(row, h = buildHay(parts));
  return h;
};

const queryTerms = (s) =>
  String(s ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

const hayMatch = (h, terms) => terms.every((t) =>
  h.low.includes(t) || h.words.some((w) => t.startsWith(w)));

// <datalist> ids have to be unique in the document; the control is rebuilt
// on every rarity/star change, so a counter is cheaper than bookkeeping.
let listSeq = 0;

// ------------------------------------------------------------ modal shell

let veil = null;
let searchEl = null;

const modalHost = () => document.getElementById('modal-host') || document.body;

function close() {
  veil?.remove();
  veil = null;
  searchEl = null;
  App.tip?.hide?.();
}

function openModal(title) {
  close();
  veil = el('modal-veil');
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  const box = el('picker');
  const head = el('phead');
  const ht = el('', 'span');
  ht.textContent = title;
  head.append(ht);
  const x = el('x', 'button');
  x.type = 'button';
  x.textContent = '✕';
  x.addEventListener('click', close);
  head.append(x);
  const body = el('pbody');
  box.append(head, body);
  veil.append(box);
  modalHost().append(veil);
  return body;
}

document.addEventListener('keydown', (e) => {
  if (!veil) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  // typing anywhere (outside another form control) filters the list
  const tag = e.target?.tagName;
  if (searchEl && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
      && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
    searchEl.focus();
  }
});

// A pinned-action row at the top of a list (empty / unpin / none).
function actionRow(sym, name, sub, fn) {
  const r = el('pitem action');
  const pi = el('pin-ico');
  pi.textContent = sym;
  r.append(pi);
  const mid = el('pmid');
  const nm = el('pname');
  nm.textContent = name;
  mid.append(nm);
  if (sub) {
    const sb = el('psub');
    sb.textContent = sub;
    mid.append(sb);
  }
  r.append(mid);
  r.addEventListener('click', fn);
  return r;
}

// -------------------------------------------------------------- gear picker

function openGear(slotId) {
  const slotDef = App.boot?.slots?.find((s) => s.id === slotId);
  const items = App.catalog?.slots?.[slotId] || [];
  // What the catalog does not offer for this slot, with why (see the header).
  const heldBack = App.catalog?.withheld?.[slotId] || [];
  const infusions = App.boot?.infusions || [];
  const infConsts = App.boot?.constants?.infusion || null;
  // Is infusion a thing for THIS slot at all - does any row of it carry one.
  // Only then does a piece that cannot be infused say why.
  const slotInfuses = [...items, ...heldBack].some((i) => i.infusable);

  // Editing beats re-picking: a filled slot opens on the item it holds, so
  // changing one star is a click and Equip rather than finding the row again.
  // The entry can name an item the catalog no longer lists (a level change
  // drops rows), and then there is nothing to edit and the picker opens blank.
  const equipped = App.state?.loadout?.gear?.[slotId] || null;
  const current = equipped
    ? (items.find((i) => i.id === equipped.item) || heldBack.find((i) => i.id === equipped.item) || null)
    : null;

  const body = openModal(current
    ? `${slotDef?.label || slotId} - editing ${snip(current.name, 30)}`
    : (slotDef?.label || slotId));
  const list = el('plist');
  const conf = el('pconf');
  body.append(list, conf);

  const search = el('searchbox', 'input');
  search.type = 'text';
  search.placeholder = 'search…';
  searchEl = search;
  list.append(search);
  const rows = el('prows');
  list.append(rows);

  let selected = null;
  let selRow = null;
  // replaced by configOf() the moment anything is selected; nothing reads it
  // before that, because renderConf() draws the empty hint instead.
  let cfg = { rarity: null, stars: 0, level: null, infusion: 'auto', infusionStat: null, prismatic: false };
  // Whether the infusion list also shows the ones nothing hands out.
  let showAllInfusions = false;
  let pvEl = null;
  let pvSeq = 0;
  let pvTimer = null;

  // ---- list -------------------------------------------------------------

  const itemRow = (it) => {
    const r = el('pitem');
    r.append(App.icon(it.icon, 44));
    const mid = el('pmid');
    const nm = el('pname');
    nm.textContent = it.name;
    const br = bestRarity(App.boot, it);
    if (br) nm.style.color = rarityColor(App.boot, br.id);
    mid.append(nm);
    // The AUTHORED level when the row has one - it is the greens' only
    // distinguishing number and their equip floor - and the truth when it has
    // none, which used to print as "lvl null": the piece is priced at YOUR
    // level. That is all this label may say. Most rows that author no level
    // are the faction sets and trinkets, but a crafted trinket and three rows
    // whose acquire line reads "Starting outfit" or "Base clothing" author
    // none either, and "drops at your level" printed on those was a claim
    // about how they are come by that the same row's acquire line
    // contradicted.
    //
    // ...and never a level below the one every copy of the row is made at
    // (the bottom of its range, which the server floors there): the Demon Epic
    // armour authors `level: 1` and exists only at the cap, and "lvl 1" on it
    // read as a piece a new character could wear. The same floor decides a
    // row that authors NO level: its range starts at the character's level
    // unless every copy is made higher up, and then "at your level" is false
    // - a level-24 Mage read it on three Epic pants whose reason, one line
    // below, says a copy only exists at 25, and whose tooltip prices item
    // level 300. So the bottom of the range is printed whenever it is not
    // the character's own level.
    const sub = el('psub');
    sub.textContent = [it.typeName || it.type, levelLabel(it), it.factionName || it.faction]
      .filter(Boolean).join(' · ');
    mid.append(sub);
    // A withheld row says why right under its name - the reason is the point
    // of listing it at all, so it is not left to a hover.
    if (it.withheld) {
      r.classList.add('held');
      const why = el('pnote');
      why.textContent = it.withheld.why;
      mid.append(why);
    }
    r.append(mid);
    const right = el('pright');
    if (it.gives) {
      const g = el('pgives');
      g.textContent = it.gives;
      right.append(g);
    }
    // Where it comes from: the atlas's line, else what the install itself
    // says hands the row out (the catalog's source reader - every Epic piece
    // has only that). A withheld row has already said.
    const from = it.acquire || (it.withheld ? null : it.source?.why);
    if (from) {
      const a = el('pacq');
      a.textContent = snip(from, 52);
      right.append(a);
    }
    r.append(right);
    // rebuild() throws the rows away on every keystroke, so the highlight is
    // re-applied from `selected` rather than kept on a node that is gone.
    if (selected && it.id === selected.id) {
      r.classList.add('sel');
      selRow = r;
    }
    App.bindTip(r, () => App.api('/api/tooltip/item', {
      class: App.state?.cls, charLevel: App.state?.level,
      item: it.id, slot: slotId,
    }).then((t) => itemTipHtml(App.boot, t)));
    r.addEventListener('click', () => select(it, r));
    return r;
  };

  const rebuild = () => {
    rows.replaceChildren();
    selRow = null;
    rows.append(actionRow('∅', 'Empty this slot',
      'pin the slot empty — the optimizer keeps it that way',
      () => { App.setGear(slotId, null); close(); }));
    rows.append(actionRow('⟲', 'Unpin',
      'let the optimizer fill this slot',
      () => { App.clearSlot(slotId); close(); }));
    const terms = queryTerms(search.value);
    const shown = (it) => !terms.length || hayMatch(
      hayOf(it, it.name, it.typeName || it.type, it.faction, it.factionName,
            it.gives, it.acquire, it.source?.why, it.flavor), terms);
    for (const it of items) if (shown(it)) rows.append(itemRow(it));
    // ...then what is NOT offered, apart and under its own heading.
    const held = heldBack.filter(shown);
    if (held.length) {
      const sep = el('psep');
      sep.textContent = `Not offered - ${held.length} ${held.length === 1 ? 'row' : 'rows'} `
        + 'the optimizer will not pick (each says why; you still can)';
      rows.append(sep);
      for (const it of held) rows.append(itemRow(it));
    }
    if (App.catalog?.withheldNote) {
      const n = el('psep');
      n.textContent = `Nothing is withheld: ${App.catalog.withheldNote}`;
      rows.append(n);
    }
  };

  // ---- config column ----------------------------------------------------

  const maxStarsFor = (it, rarityId) =>
    it?.rarities?.find((r) => r.id === rarityId)?.maxStars | 0;

  const maxStarsOf = () => maxStarsFor(selected, cfg.rarity);

  // Stars maxed by default: an upgraded weapon is what a player is comparing
  // against, and 0/4 is a number nobody keeps.
  // ...and its infusion left to the optimizer: "auto" pins the piece and not
  // what it is infused with (on the sheet that is a piece with no infusion).
  const defaultConfig = (it) => {
    const rarity = authoredRarity(it)?.id || null;
    return {
      rarity, stars: maxStarsFor(it, rarity), level: null,
      infusion: 'auto', infusionStat: null, prismatic: false,
    };
  };

  // What the loadout already says about this item. Missing stars mean zero -
  // Equip writes the field only when a star is lit - and a missing level means
  // "whatever it dropped at", which is the slider's unset state. Both the
  // rarity and the level are re-checked against this catalog row, because the
  // entry was written at some other character level.
  const equippedConfig = (it) => {
    const rarity = (it.rarities || []).some((r) => r.id === equipped.rarity)
      ? equipped.rarity
      : (authoredRarity(it)?.id || null);
    const b = levelBounds(it);
    const lvl = num(equipped.level);
    const stars = num(equipped.stars) ?? 0;
    return {
      rarity,
      stars: Math.max(0, Math.min(stars, maxStarsFor(it, rarity))),
      level: lvl == null ? null : Math.max(b.lo, Math.min(b.hi, lvl)),
      // The infusion the entry states; with none stated, whether that is the
      // user's "none" or simply undecided is what the pin says.
      infusion: !it.infusable ? 'auto'
        : (equipped.infusion || (App.state.pins.infusions.has(slotId) ? 'none' : 'auto')),
      infusionStat: it.infusable ? (equipped.infusionStat || null) : null,
      prismatic: it.infusable && !!equipped.prismatic,
    };
  };

  // The infusion the config holds, as an id - or null for "auto" and "none".
  const infusionOf = () => (cfg.infusion !== 'auto' && cfg.infusion !== 'none' ? cfg.infusion : null);

  const isEquipped = (it) => !!equipped && !!it && it.id === equipped.item;

  const configOf = (it) =>
    (isEquipped(it) ? equippedConfig(it) : defaultConfig(it));

  const select = (it, row) => {
    selected = it;
    selRow?.classList.remove('sel');
    selRow = row;
    row.classList.add('sel');
    cfg = configOf(it);
    renderConf();
  };

  const preview = () => {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      if (!selected || !pvEl) return;
      const seq = ++pvSeq;
      try {
        const bodyReq = {
          class: App.state?.cls, charLevel: App.state?.level,
          item: selected.id, slot: slotId,
          rarity: cfg.rarity, stars: cfg.stars,
        };
        if (cfg.level != null) bodyReq.level = cfg.level;
        if (infusionOf()) {
          bodyReq.infusion = infusionOf();
          if (cfg.infusionStat) bodyReq.infusionStat = cfg.infusionStat;
          if (cfg.prismatic) bodyReq.prismatic = true;
        }
        const t = await App.api('/api/tooltip/item', bodyReq);
        if (seq !== pvSeq || !veil || !pvEl) return;
        pvEl.innerHTML = `<div class="tooltip">${itemTipHtml(App.boot, t)}</div>`;
      } catch (err) {
        if (seq === pvSeq && pvEl) {
          pvEl.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
        }
      }
    }, 90);
  };

  // ---- instance level ---------------------------------------------------

  // The instance level is always a choice, because a drop takes the level of
  // whatever dropped it: the Necklace of Clarity's row says 15 and the copy a
  // level-17 boar drops is a level-17 item (+39 Magic Penetration, not +36).
  // `levelScales` only says whether the item tracks YOUR level as you level up
  // — it does not collapse the range — so the slider shows whenever the band
  // is wider than one level, and the label changes rather than disappearing.
  // An older server sends no range, and then "authored level … your level" is
  // the safe reading.
  const levelBounds = (it) => {
    const r = it.levelRange;
    const rng = Array.isArray(r) && num(r[0]) != null && num(r[1]) != null ? r : null;
    const lo = rng ? rng[0] : (num(it.level) ?? 1);
    const hi = Math.max(lo, rng ? rng[1] : (num(App.state?.level) ?? lo));
    return { scales: it.levelScales !== false, lo, hi, fixed: hi === lo ? lo : null };
  };

  const dimLevel = (text) => {
    const d = el('levelfix');
    d.textContent = text;
    return d;
  };

  const levelSlider = (lo, hi, scales = true) => {
    // Unset means different things per kind, and the wrong word here is what
    // sent a level-17 necklace into the sheet as a level-15 one.
    const unsetText = scales
      ? 'drop level — scales to you'
      : `drop level — defaults to ${lo}, set what yours dropped at`;
    const box = el('levelctl');

    const head = el('lvlhead');
    const val = el('lvlval', 'span');
    const auto = el('lvlauto', 'button');
    auto.type = 'button';
    auto.textContent = '⟲ auto';
    auto.title = 'back to the drop level — let the item scale with you';
    head.append(val, auto);

    const slide = el('lvlslide');
    const rg = el('lvlrange', 'input');
    rg.type = 'range';
    rg.min = lo;
    rg.max = hi;
    rg.step = 1;
    rg.setAttribute('aria-label', 'Instance level');
    const listId = `lvlticks-${++listSeq}`;
    rg.setAttribute('list', listId);
    slide.append(rg);

    // Chromium only draws the <datalist> notches on an UNSTYLED range, and
    // this one is styled — so the list stays (semantics, other engines) and
    // the visible notches are our own absolutely-positioned marks.
    const span = hi - lo;
    const every = span <= 26 ? 1 : Math.ceil(span / 24);
    const marks = new Set();
    for (let v = lo; v <= hi; v += every) marks.add(v);
    marks.add(hi);
    const ticks = el('lvlticks');
    const dl = el('', 'datalist');
    dl.id = listId;
    for (const v of marks) {
      const t = el(v % 5 === 0 || v === lo || v === hi ? 'maj' : '', 'span');
      t.style.left = `${((v - lo) / span) * 100}%`;
      ticks.append(t);
      const o = el('', 'option');
      o.value = String(v);
      dl.append(o);
    }
    slide.append(ticks);

    const ends = el('lvlends');
    const e0 = el('', 'span');
    e0.textContent = String(lo);
    e0.title = 'the level this item is authored at';
    const e1 = el('', 'span');
    e1.textContent = String(hi);
    e1.title = 'your character level';
    ends.append(e0, e1);

    box.append(head, slide, ends, dl);

    const sync = () => {
      const set = cfg.level != null;
      const v = set ? cfg.level : hi;
      rg.value = String(v);
      // the fill must stop under the thumb CENTRE, which travels inset by
      // half a thumb — picker.css does that arithmetic from --frac.
      rg.style.setProperty('--frac', String((v - lo) / span));
      box.classList.toggle('unset', !set);
      auto.hidden = !set;
      val.replaceChildren();
      if (set) {
        val.append(document.createTextNode('Instance level '));
        const b = el('', 'b');
        b.textContent = String(v);
        val.append(b);
      } else {
        val.textContent = unsetText;
      }
      rg.setAttribute('aria-valuetext',
        set ? `level ${v}` : unsetText);
    };

    rg.addEventListener('input', () => {
      const v = parseInt(rg.value, 10);
      cfg.level = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;
      sync();
      preview();   // debounced ~90ms, so a drag costs one request at the end
    });
    auto.addEventListener('click', () => {
      cfg.level = null;
      sync();
      preview();
    });

    sync();
    return box;
  };

  const levelControl = (it) => {
    const b = levelBounds(it);
    // Only a genuinely single-levelled row loses the control.
    if (b.hi <= b.lo) {
      cfg.level = null;
      return dimLevel(`level ${b.lo} — nothing to choose at your character level`);
    }
    return levelSlider(b.lo, b.hi, b.scales);
  };

  // ---- infusion -----------------------------------------------------------

  // Three controls, shown for a piece the game lets carry an infusion:
  //
  //   which one   "the optimizer's choice", "none", or an infusion. The list
  //               is the ones something hands out on this build (the
  //               catalog's source reader decides, and its sentence is printed
  //               under the choice); the rest appear only when asked for.
  //               Infusions of the piece's own faction come first: they are
  //               the ones that light its bonus line.
  //   bonus roll  the rating its bonus line rolled, from the ones the piece
  //               can roll - or not stated, and then no bonus is priced.
  //   prismatic   the item flag that lights the bonus whatever the faction.
  const infusionControl = (it) => {
    const box = el('infctl');
    const own = it.infusionFaction?.id;
    const chosen = infusionOf();
    const def = (id) => infusions.find((x) => x.id === id) || null;
    const listed = infusions.filter((x) => x.obtainable || showAllInfusions || x.id === chosen);
    const hidden = infusions.length - infusions.filter((x) => x.obtainable).length;

    const il = el('', 'label');
    il.textContent = 'Infusion';
    box.append(il);
    const sel = el('', 'select');
    const opt = (value, text, parent = sel) => {
      const o = el('', 'option');
      o.value = value;
      o.textContent = text;
      if (value === cfg.infusion) o.selected = true;
      parent.append(o);
    };
    opt('auto', 'the optimizer\'s choice');
    opt('none', 'none - keep it not infused');
    const group = (label, list) => {
      if (!list.length) return;
      const g = el('', 'optgroup');
      g.label = label;
      for (const x of list) opt(x.id, x.obtainable ? x.name : `${x.name} (nothing hands it out)`, g);
      sel.append(g);
    };
    group(`${it.infusionFaction?.name || own} - lights this piece's bonus`, listed.filter((x) => x.faction === own));
    group('other factions - the bonus stays dark unless Prismatic', listed.filter((x) => x.faction !== own));
    sel.addEventListener('change', () => {
      cfg.infusion = sel.value;
      if (!infusionOf()) { cfg.infusionStat = null; cfg.prismatic = false; }
      renderConf();
    });
    box.append(sel);

    const hint = el('hint');
    if (cfg.infusion === 'auto') {
      hint.textContent = 'not infused on this sheet; the optimizer may infuse it';
    } else if (cfg.infusion === 'none') {
      hint.textContent = 'pinned not infused - the optimizer keeps it that way';
    } else {
      const d = def(chosen);
      hint.textContent = d
        ? `${d.factionName} infusion · ${d.obtainable ? 'pattern: ' : 'nothing hands out its pattern on this build: '}${d.source?.why || ''}`
        : 'this infusion is not in this game version';
    }
    box.append(hint);

    if (hidden > 0) {
      const row = el('infall', 'label');
      const cb = el('', 'input');
      cb.type = 'checkbox';
      cb.checked = showAllInfusions;
      cb.addEventListener('change', () => { showAllInfusions = cb.checked; renderConf(); });
      row.append(cb, document.createTextNode(
        ` also list the ${hidden} nothing hands out on this build`));
      box.append(row);
    }

    if (chosen) {
      const sl = el('', 'label');
      sl.textContent = 'Bonus roll';
      box.append(sl);
      const ss = el('', 'select');
      const pool = (it.infusionPool || []).slice();
      // A stated roll outside the pool (a saved build can carry one) stays
      // selectable, so opening the picker does not silently change it.
      if (cfg.infusionStat && !pool.some((p) => p.stat === cfg.infusionStat)) {
        pool.push({ stat: cfg.infusionStat,
          name: `${App.boot?.attributes?.[cfg.infusionStat]?.name || cfg.infusionStat} (not a roll this piece is expected to have)` });
      }
      const so = (value, text) => {
        const o = el('', 'option');
        o.value = value;
        o.textContent = text;
        if (value === (cfg.infusionStat || '')) o.selected = true;
        ss.append(o);
      };
      so('', 'not stated - no bonus is priced');
      for (const p of pool) so(p.stat, p.name);
      ss.addEventListener('change', () => { cfg.infusionStat = ss.value || null; renderConf(); });
      box.append(ss);

      const pr = el('infall', 'label');
      const pc = el('', 'input');
      pc.type = 'checkbox';
      pc.checked = !!cfg.prismatic;
      pc.addEventListener('change', () => { cfg.prismatic = pc.checked; renderConf(); });
      pr.append(pc, document.createTextNode(
        ` ${infConsts?.texts?.prismatic || 'Prismatic'} - its bonus is lit whatever the infusion's faction`));
      box.append(pr);
    }
    return box;
  };

  const renderConf = () => {
    conf.replaceChildren();
    pvEl = null;
    if (!selected) {
      const h = el('hint');
      h.textContent = 'pick an item on the left to configure and equip it';
      conf.append(h);
      return;
    }
    const it = selected;
    const h4 = el('', 'h4');
    h4.textContent = it.name;
    h4.style.color = rarityColor(App.boot, cfg.rarity);
    conf.append(h4);

    // The pre-filled fields are the equipped ones, and the column has to say
    // so or they read as a fresh pick's defaults.
    if (isEquipped(it)) {
      const en = el('editnote');
      en.textContent = 'equipped - this is your current configuration; '
        + 'change what you need and press Equip';
      conf.append(en);
    }
    // A row the catalog withholds can be equipped, and is told what it is.
    if (it.withheld) {
      const hn = el('heldnote');
      hn.textContent = `Not offered: ${it.withheld.why}. `
        + 'You can still equip it; the optimizer will not pick it.';
      conf.append(hn);
    }

    // rarity --------------------------------------------------------------
    const rl = el('', 'label');
    rl.textContent = 'Rarity';
    conf.append(rl);
    const rs = el('', 'select');
    for (const r of it.rarities || []) {
      const o = el('', 'option');
      o.value = r.id;
      const pct = r.chance != null ? ` · ${fmtPct(r.chance)}` : '';
      o.textContent = `${rarityName(App.boot, r.id)}${pct}${r.authored ? ' (authored)' : ''}`;
      if (r.id === cfg.rarity) o.selected = true;
      rs.append(o);
    }
    rs.addEventListener('change', () => {
      // A rarity that rolls fewer stars must not leave a higher count behind,
      // and one that rolls more keeps a maxed pick maxed. Only a count the
      // user pulled down themselves stays where they put it.
      const wasMax = cfg.stars >= maxStarsOf();
      cfg.rarity = rs.value;
      const ms = maxStarsOf();
      cfg.stars = wasMax ? ms : Math.min(cfg.stars, ms);
      renderConf();
    });
    conf.append(rs);
    if ((it.rarities || []).length > 1) {
      const hint = el('hint');
      hint.textContent = 'weapons roll rarity on drop; chance shown at your level';
      conf.append(hint);
    }

    // stars (weapons only - hidden when the rarity rolls none) ------------
    const ms = maxStarsOf();
    if (ms > 0) {
      const sl = el('', 'label');
      sl.textContent = `Stars — ${cfg.stars}/${ms}`;
      conf.append(sl);
      const sp = el('starpick');
      for (let i = 1; i <= ms; i++) {
        const s = el(i <= cfg.stars ? 'on' : '', 'span');
        s.textContent = '★';
        // clicking the last lit star dims it back off
        s.addEventListener('click', () => {
          cfg.stars = cfg.stars === i ? i - 1 : i;
          renderConf();
        });
        sp.append(s);
      }
      conf.append(sp);
    }

    // instance level ------------------------------------------------------
    conf.append(levelControl(it));

    // infusion ------------------------------------------------------------
    if (it.infusable && infusions.length) conf.append(infusionControl(it));
    else if (slotInfuses && it.notInfusable) {
      conf.append(dimLevel(`cannot be infused - ${it.notInfusable}`));
    }

    // equip / cancel ------------------------------------------------------
    const br = el('btnrow');
    const eq = el('btn btn-red', 'button');
    eq.type = 'button';
    eq.textContent = 'Equip';
    eq.addEventListener('click', () => {
      // record what the user chose explicitly: rarity always, stars when
      // rolled, instance level only when set.
      const entry = { item: it.id, rarity: cfg.rarity };
      if (cfg.stars > 0) entry.stars = cfg.stars;
      if (cfg.level != null) entry.level = cfg.level;
      // ...and the infusion only when one is named. "none" writes nothing and
      // PINS that nothing; "auto" writes nothing and leaves it to the search.
      if (it.infusable && infusionOf()) {
        entry.infusion = infusionOf();
        if (cfg.infusionStat) entry.infusionStat = cfg.infusionStat;
        if (cfg.prismatic) entry.prismatic = true;
      }
      App.setGear(slotId, entry, { infusionPinned: it.infusable && cfg.infusion !== 'auto' });
      close();
    });
    const ca = el('btn btn-tan', 'button');
    ca.type = 'button';
    ca.textContent = 'Cancel';
    ca.addEventListener('click', close);
    br.append(eq, ca);
    conf.append(br);

    // live tooltip preview ------------------------------------------------
    pvEl = el('preview');
    conf.append(pvEl);
    preview();
  };

  search.addEventListener('input', rebuild);
  if (current) {
    selected = current;
    cfg = configOf(current);   // itemRow() lights the row while rebuilding
  }
  rebuild();
  renderConf();
  // Focus first, scroll second: the search box sits inside the list's own
  // scroller, so focusing after the scroll would drag the row back off screen.
  search.focus({ preventScroll: true });
  selRow?.scrollIntoView?.({ block: 'center' });
}

// ----------------------------------------------------------- augment picker

// Which talent this DemonSigil grants. The server says (`grants.id`, read off
// the item's own skill); guessing it from the names matched none of the
// twelve, because every sigil is called "Sigil of Bet'Hatesht".
function sigilTalent(aug) {
  const id = aug?.grants?.id;
  if (!id) return null;
  const nodes = App.boot?.talents?.[App.state?.cls]?.nodes || [];
  return nodes.find((n) => n.id === id) || null;
}

function openAugment(socketKey) {
  const [slotId, type] = String(socketKey).split('/');
  const slotDef = App.boot?.slots?.find((s) => s.id === slotId);
  const short = (type || '').replace(/^Augment/, '') || 'augment';
  const cls = App.state?.cls;
  const augs = (App.boot?.augments?.[type] || [])
    .filter((a) => !a.classGate || a.classGate === cls);
  const isSigil = type === 'AugmentDemonSigil';

  const body = openModal(`${slotDef?.label || slotId} — ${short} socket`);
  body.classList.add('single');
  const list = el('plist');
  body.append(list);

  const search = el('searchbox', 'input');
  search.type = 'text';
  search.placeholder = 'search…';
  searchEl = search;
  list.append(search);
  const rows = el('prows');
  list.append(rows);

  const augRow = (a) => {
    const r = el('pitem');
    r.append(App.icon(a.icon, 44));
    const mid = el('pmid');
    const nm = el('pname');
    nm.textContent = a.name;
    nm.style.color = rarityColor(App.boot, a.rarity);
    mid.append(nm);
    if (a.effect) {
      const sub = el('psub');
      sub.textContent = a.effect;
      mid.append(sub);
    }
    // The effect line already names the talent ("Grants the talent X."); what
    // the row can add is what that talent DOES, which is the reason to pick
    // one sigil over another.
    const talent = isSigil ? sigilTalent(a) : null;
    if (talent?.desc) {
      const note = el('pnote');
      note.textContent = snip(talent.desc, 110);
      mid.append(note);
    }
    r.append(mid);
    if (a.acquire) {
      const right = el('pright');
      const aq = el('pacq');
      aq.textContent = snip(a.acquire, 52);
      right.append(aq);
      r.append(right);
    }
    App.bindTip(r, augTipHtml(App.boot, a,
      talent?.desc ? `${talent.name}: ${talent.desc}` : null));
    r.addEventListener('click', () => {
      App.setAugment(socketKey, a.id);
      close();
    });
    return r;
  };

  const rebuild = () => {
    rows.replaceChildren();
    rows.append(actionRow('∅', 'None', 'pin the socket empty',
      () => { App.setAugment(socketKey, null); close(); }));
    const terms = queryTerms(search.value);
    for (const a of augs) {
      // Every Demon gift is named "Corrupted Gift"; the effect line is the
      // only thing that tells them apart, so it has to be searchable.
      if (terms.length && !hayMatch(
        hayOf(a, a.name, a.effect, a.acquire), terms)) continue;
      rows.append(augRow(a));
    }
  };

  search.addEventListener('input', rebuild);
  rebuild();
  search.focus();
}

// ------------------------------------------------------------------ export

window.Picker = { openGear, openAugment };
export { openGear, openAugment };
