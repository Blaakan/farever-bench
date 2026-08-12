// ---------------------------------------------------------------------------
// components/picker.js - the modal gear / augment picker.
//
//   window.Picker = { openGear(slotId), openAugment(socketKey) }
//
// Uses the .modal-veil/.picker classes from style.css (list rows and config
// column extras in css/sheet.css); the instance-level control is the one
// piece with its own sheet, css/picker.css. Wires its own keyboard handling:
// Esc closes, typing anywhere filters the list. All mutations go through
// App.setGear / App.setAugment / App.clearSlot.
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
  const body = openModal(slotDef?.label || slotId);
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
  let cfg = { rarity: null, stars: 0, level: null };
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
    const sub = el('psub');
    sub.textContent = [it.typeName || it.type, `lvl ${it.level}`, it.faction]
      .filter(Boolean).join(' · ');
    mid.append(sub);
    r.append(mid);
    const right = el('pright');
    if (it.gives) {
      const g = el('pgives');
      g.textContent = it.gives;
      right.append(g);
    }
    if (it.acquire) {
      const a = el('pacq');
      a.textContent = snip(it.acquire, 52);
      right.append(a);
    }
    r.append(right);
    App.bindTip(r, () => App.api('/api/tooltip/item', {
      class: App.state?.cls, charLevel: App.state?.level,
      item: it.id, slot: slotId,
    }).then((t) => itemTipHtml(App.boot, t)));
    r.addEventListener('click', () => select(it, r));
    return r;
  };

  const rebuild = () => {
    rows.replaceChildren();
    rows.append(actionRow('∅', 'Empty this slot',
      'pin the slot empty — the optimizer keeps it that way',
      () => { App.setGear(slotId, null); close(); }));
    rows.append(actionRow('⟲', 'Unpin',
      'let the optimizer fill this slot',
      () => { App.clearSlot(slotId); close(); }));
    const q = search.value.trim().toLowerCase();
    for (const it of items) {
      if (q && !it.name.toLowerCase().includes(q)) continue;
      rows.append(itemRow(it));
    }
  };

  // ---- config column ----------------------------------------------------

  const maxStarsOf = () =>
    selected?.rarities?.find((r) => r.id === cfg.rarity)?.maxStars | 0;

  const select = (it, row) => {
    selected = it;
    selRow?.classList.remove('sel');
    selRow = row;
    row.classList.add('sel');
    const ar = authoredRarity(it);
    cfg = { rarity: ar?.id || null, stars: 0, level: null };
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
      cfg.rarity = rs.value;
      cfg.stars = Math.min(cfg.stars, maxStarsOf());
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
      App.setGear(slotId, entry);
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
  rebuild();
  renderConf();
  search.focus();
}

// ----------------------------------------------------------- augment picker

// Best-effort: which max-tier talent does this DemonSigil grant?
function sigilTalent(aug) {
  const tal = App.boot?.talents?.[App.state?.cls];
  const all = tal?.nodes || [];
  if (!all.length) return null;
  const maxTier = all.reduce((m, n) => Math.max(m, n.tier | 0), 0);
  const nodes = all.filter((n) => (n.tier | 0) === maxTier);
  const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return nodes.find((n) => n.name && flat(aug.effect).includes(flat(n.name)))
      || nodes.find((n) => flat(aug.id).includes(flat(n.id))
                        || flat(n.id).includes(flat(aug.id)))
      || nodes.find((n) => n.name && flat(aug.name).includes(flat(n.name)))
      || null;
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
    const talent = isSigil ? sigilTalent(a) : null;
    if (talent) {
      const note = el('pnote');
      note.textContent = `grants tier-4 talent “${talent.name}”`;
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
      talent ? `grants tier-4 talent “${talent.name}”` : null));
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
    const q = search.value.trim().toLowerCase();
    for (const a of augs) {
      if (q && !a.name.toLowerCase().includes(q)
            && !String(a.effect || '').toLowerCase().includes(q)) continue;
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
