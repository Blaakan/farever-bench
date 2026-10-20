// ---------------------------------------------------------------------------
// app.js - the shared core every view builds on.
//
// One store, one render cycle: views register with App.view(name, {mount,
// render}) and are re-rendered after every state change. The live sheet is
// recomputed server-side (debounced) after any loadout mutation; views read
// App.sheet rather than computing anything themselves.
//
// Interfaces the component files rely on (keep stable):
//   App.boot / App.catalog / App.state / App.sheet / App.result
//   App.icon(ref, px)              -> HTMLElement for any icon ref
//   App.iconUrl(ref, px)          -> css background spec (tiles) | url (dds)
//   App.bindTip(el, source)        -> game-style tooltip on hover
//   App.setGear / setAugment / setSkills / setRune / setTalent / setClass /
//   App.setLevel / clearSlot       -> loadout mutations (all mark pins)
//   App.setOption(key, value)      -> one of App.state.options
//   App.unpinSkills(poolKey)       -> hand a skill pool back to the optimizer
//   App.api(path, body?)           -> fetch JSON (POST when body given)
//   App.toast(msg, isError)
// ---------------------------------------------------------------------------

const App = window.App = {
  boot: null,
  catalog: null,
  sheet: null,          // latest /api/sheet response for the editable build
  result: null,         // {envelope, view, score} after an optimize run
  tab: 'profile',
  state: {
    cls: 'Mage',
    level: 25,
    name: 'Bencher',
    loadout: null,      // engine-shaped loadout JSON
    // `infusions` holds the slots whose INFUSION is the user's own statement
    // - "this one" or "none" - as `gear` holds the slots whose piece is. They
    // are two sets because they are two decisions: equipping a chest says
    // which chest, and the search may still be left to say what to infuse it
    // with (the CLI's rule for a pin without a `~` part).
    pins: { gear: new Set(), augments: new Set(), skills: new Set(),
            runes: new Set(), talents: false, infusions: new Set() },
    // targetHealth is the fraction of its health the target stands at, and it
    // rides every /api/sheet and /api/optimize call from here. There is no
    // control for it yet because there is no control for `target` or `targets`
    // either - most of this object is a fixed default the page never edits.
    // The field is wired end to end regardless, so the API can drive it.
    //
    // The two the page DOES edit are the infusion search's (the Infusions
    // block of the profile view): which infusions the optimizer may hand out
    // - "learnable" is every one the install does not show to be unobtainable,
    // or an explicit list of ids - and what the bonus roll of a piece nobody
    // owns is taken to be ("none" prices no bonus line at all). The sheet
    // ignores both; they ride its requests like the rest.
    options: { target: 'boss', targetLevel: null, fight: 200, targets: 1,
               targetHealth: 1, lookahead: 0, rank: 3, mix: 0.5, goal: 'dps',
               infusions: 'learnable', infusionStat: 'none' },
  },
  views: new Map(),
};

// ------------------------------------------------------------------ fetch

App.api = async (path, body) => {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `bad response from ${path}` }));
  if (!res.ok || data.error) throw new Error(data.error || `${path}: HTTP ${res.status}`);
  return data;
};

App.toast = (msg, isError = false) => {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
};

// ------------------------------------------------------------------ icons

// Icon refs from the API: {kind:'tile', file, px:[x,y,w,h]} or {kind:'dds', url}.
App.iconUrl = (ref) => ref?.kind === 'dds' ? ref.url : ref ? `/asset/${ref.file}` : null;

App.icon = (ref, px = 46) => {
  const el = document.createElement('div');
  el.className = 'ico';
  el.style.width = el.style.height = px + 'px';
  if (!ref) { el.classList.add('ico-none'); return el; }
  if (ref.kind === 'dds') {
    const img = document.createElement('img');
    img.src = ref.url;
    img.draggable = false;
    el.appendChild(img);
  } else if (ref.kind === 'tile') {
    const [x, y, w, h] = ref.px;
    const scale = px / w;
    el.style.backgroundImage = `url(/asset/${encodeURI(ref.file)})`;
    el.style.backgroundPosition = `${-x * scale}px ${-y * scale}px`;
    // background-size needs the full sheet dimensions scaled; the server
    // includes them on the ref as sheet:[W,H] so no image probing is needed.
    if (ref.sheet) {
      el.style.backgroundSize = `${ref.sheet[0] * scale}px ${ref.sheet[1] * scale}px`;
    }
  }
  return el;
};

// ---------------------------------------------------------------- tooltip

const tipHost = () => document.getElementById('tooltip-host');
let tipEl = null;

App.tip = {
  show(html, x, y) {
    this.hide();
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.innerHTML = html;
    tipHost().appendChild(tipEl);
    this.move(x, y);
  },
  move(x, y) {
    if (!tipEl) return;
    const r = tipEl.getBoundingClientRect();
    const px = Math.min(x + 18, innerWidth - r.width - 8);
    const py = Math.min(y + 12, innerHeight - r.height - 8);
    tipEl.style.left = Math.max(4, px) + 'px';
    tipEl.style.top = Math.max(4, py) + 'px';
  },
  hide() { tipEl?.remove(); tipEl = null; },
};

// source: string | () => string | Promise<string>. Result cached on the node.
App.bindTip = (el, source) => {
  let alive = false;
  el.addEventListener('mouseenter', async (e) => {
    alive = true;
    let html = typeof source === 'function' ? source() : source;
    if (html instanceof Promise) {
      html = await html.catch((err) => `<div class="ttype">${err.message}</div>`);
    }
    if (alive && html) App.tip.show(html, e.clientX, e.clientY);
  });
  el.addEventListener('mousemove', (e) => App.tip.move(e.clientX, e.clientY));
  el.addEventListener('mouseleave', () => { alive = false; App.tip.hide(); });
};

// ------------------------------------------------------------ state cycle

const emptyLoadout = () => ({
  class: App.state.cls, level: App.state.level,
  gear: {}, augments: {}, skills: {}, runes: {}, talents: {},
});

let sheetTimer = null;
let sheetSeq = 0;

App.refreshSheet = () => {
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(async () => {
    const seq = ++sheetSeq;
    try {
      const sheet = await App.api('/api/sheet', {
        loadout: App.state.loadout, options: App.state.options,
      });
      if (seq !== sheetSeq) return;          // a newer request superseded us
      App.sheet = sheet;
      App.render();
    } catch (e) {
      if (seq === sheetSeq) App.toast(e.message, true);
    }
  }, 120);
};

App.render = () => {
  for (const [name, v] of App.views) {
    const host = document.getElementById(`view-${name}`);
    if (host && !host.hidden) v.render(host);
  }
  document.dispatchEvent(new CustomEvent('app-render'));
};

App.view = (name, v) => {
  App.views.set(name, v);
  const host = document.getElementById(`view-${name}`);
  if (host && v.mount) v.mount(host);
};

const touch = () => { App.refreshSheet(); App.render(); };

// -------------------------------------------------------------- mutations

App.setClass = async (cls) => {
  App.state.cls = cls;
  App.state.loadout = emptyLoadout();
  App.state.pins = { gear: new Set(), augments: new Set(), skills: new Set(),
                     runes: new Set(), talents: false, infusions: new Set() };
  App.result = null;
  await App.loadCatalog();
  touch();
};

App.setLevel = async (level) => {
  App.state.level = level;
  App.state.loadout.level = level;
  await App.loadCatalog();
  touch();
};

// `infusionPinned`: the entry's infusion - or its having none - is the user's
// own choice and the optimizer keeps it. Left false, the piece is pinned and
// its infusion is the search's to decide.
App.setGear = (slotId, entry, { infusionPinned = false } = {}) => {
  const l = App.state.loadout;
  if (entry) l.gear[slotId] = entry; else delete l.gear[slotId];
  App.state.pins.gear.add(slotId);
  if (entry && infusionPinned) App.state.pins.infusions.add(slotId);
  else App.state.pins.infusions.delete(slotId);
  // dropping a mainhand that allowed an offhand invalidates the offhand
  if (slotId === 'Slot_Weapon1') {
    const mh = entry && App.findItem('Slot_Weapon1', entry.item);
    if (!mh || !mh.allowsOffhand) {
      delete l.gear.Slot_OffhandWeapon;
      App.state.pins.gear.delete('Slot_OffhandWeapon');
    }
  }
  // stale sockets/skills of the replaced item are pruned server-side; drop
  // local pins whose socket no longer exists after the sheet refresh.
  touch();
};

App.clearSlot = (slotId) => {           // unpin entirely (search may fill it)
  delete App.state.loadout.gear[slotId];
  App.state.pins.gear.delete(slotId);
  App.state.pins.infusions.delete(slotId);
  for (const k of Object.keys(App.state.loadout.augments)) {
    if (k.startsWith(slotId + '/')) {
      delete App.state.loadout.augments[k];
      App.state.pins.augments.delete(k);
    }
  }
  delete App.state.loadout.skills[slotId];
  App.state.pins.skills.delete(slotId);
  touch();
};

App.setAugment = (key, id) => {
  const l = App.state.loadout;
  if (id) l.augments[key] = id; else delete l.augments[key];
  App.state.pins.augments.add(key);
  touch();
};

// A pool is pinned by a selection that FILLS it - that is a choice the
// optimizer should keep. Any click used to pin, a deselect included: emptying
// a pool pinned it, the server refilled it with the defaults, and the search
// then handed back that default as "the user's selection" with nothing on the
// page to say a pin existed. So a partial selection leaves the pool to the
// search, and a pinned pool wears a pip that unpins it (sheet.js).
App.setSkills = (poolKey, ids, { full = true } = {}) => {
  App.state.loadout.skills[poolKey] = ids;
  if (full) App.state.pins.skills.add(poolKey);
  else App.state.pins.skills.delete(poolKey);
  touch();
};

// Hand a pool back to the optimizer; the selection stays as it is on the sheet.
App.unpinSkills = (poolKey) => {
  App.state.pins.skills.delete(poolKey);
  touch();
};

App.setRune = (skillId, runeId) => {
  const l = App.state.loadout;
  if (runeId) l.runes[skillId] = runeId; else delete l.runes[skillId];
  App.state.pins.runes.add(skillId);
  touch();
};

App.setTalent = (nodeId, rank) => {
  const l = App.state.loadout;
  if (rank > 0) l.talents[nodeId] = rank; else delete l.talents[nodeId];
  App.state.pins.talents = Object.keys(l.talents).length > 0;
  touch();
};

// One of the options every request carries. The sheet is refreshed with it:
// most options move its numbers, and the two that do not (the infusion
// search's) cost one cheap request to keep this a single rule.
App.setOption = (key, value) => {
  App.state.options[key] = value;
  touch();
};

// ------------------------------------------------------------- catalog

App.loadCatalog = async () => {
  App.catalog = await App.api(
    `/api/catalog?class=${App.state.cls}&level=${App.state.level}`);
};

// A row the catalog WITHHOLDS is still a row: the picker lists it apart with
// the reason, and a build can wear one (a saved file, or the user's own
// pick). So a lookup reads both lists - looking only at the offered one drew
// such a piece as "not in this game version's catalog", which it is.
App.findItem = (slotId, itemId) =>
  App.catalog?.slots?.[slotId]?.find((i) => i.id === itemId)
  || App.catalog?.withheld?.[slotId]?.find((i) => i.id === itemId) || null;

// The 12 doll slots in the game's visual order.
App.dollSlots = () => {
  const bySide = { left: [], right: [] };
  for (const s of App.boot.slots) if (s.column) bySide[s.column].push(s);
  return bySide;
};

// -------------------------------------------------------------- tabs

const bindChrome = () => {
  const tabs = document.getElementById('tabs');
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    App.tab = b.dataset.tab;
    for (const t of tabs.querySelectorAll('.tab')) {
      t.classList.toggle('active', t === b);
    }
    for (const v of document.querySelectorAll('.tabview')) {
      v.hidden = v.id !== `view-${App.tab}`;
    }
    App.render();
  });

  const clsSel = document.getElementById('class-select');
  for (const c of App.boot.classes) {
    const o = document.createElement('option');
    o.value = c.unit;
    o.textContent = c.name;
    clsSel.appendChild(o);
  }
  clsSel.value = App.state.cls;
  clsSel.addEventListener('change', () => App.setClass(clsSel.value));

  const lvl = document.getElementById('level-input');
  lvl.value = App.state.level;
  lvl.addEventListener('change', () => {
    const n = Math.max(1, Math.min(App.boot.constants.maxLevel,
                                   parseInt(lvl.value, 10) || 1));
    lvl.value = n;
    App.setLevel(n);
  });

  const name = document.getElementById('char-name');
  name.addEventListener('input', () => {
    App.state.name = name.value;
    App.render();
  });

  // The band follows state, not the other way round: a class or level set in
  // code (applying an optimized build, importing a character) must move the
  // controls too, or the header lies about what is loaded.
  const crest = document.getElementById('class-crest');
  const syncChrome = () => {
    crest.replaceChildren();
    const c = App.boot.classes.find((x) => x.unit === App.state.cls);
    if (c?.icon) crest.appendChild(App.icon(c.icon, 56));
    if (clsSel.value !== App.state.cls) clsSel.value = App.state.cls;
    if (lvl.value !== String(App.state.level)) lvl.value = App.state.level;
    if (name.value !== App.state.name) name.value = App.state.name;
  };
  document.addEventListener('app-render', syncChrome);
  syncChrome();
};

// -------------------------------------------------- the build notice

// A number computed on a build the model was not accepted on says so, on every
// command, before the number - that is the CLI's rule, and a page of numbers is
// no different. The server sends the CLI's own sentence (`meta.notice`, null
// when this install IS the accepted build) and the strip stays up for the whole
// session: it is a fact about the install, not a toast about an action.
const showBuildNotice = () => {
  const host = document.getElementById('build-notice');
  const text = App.boot?.meta?.notice;
  if (!host) return;
  host.textContent = text ? `⚠ ${text}` : '';
  host.hidden = !text;
};

// -------------------------------------------------------------- boot

(async function main() {
  try {
    App.boot = await App.api('/api/bootstrap');
    showBuildNotice();
    App.state.loadout = emptyLoadout();
    await App.loadCatalog();
    bindChrome();

    // Views register themselves on import; order fixes vertical layout.
    await import('./components/sheet.js');
    await import('./components/talents.js');
    await import('./components/runes.js');
    await import('./components/picker.js');
    await import('./components/optimize.js');
    await import('./components/exchange.js');

    App.render();
    App.refreshSheet();
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend',
      `<div class="toast err">failed to start: ${e.message}</div>`);
    throw e;
  }
})();

export default App;
