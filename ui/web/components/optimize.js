// ---------------------------------------------------------------------------
// components/optimize.js - the optimize flow and the result pane.
//
// Owns #optimize-btn and #result-pane, nothing else. A click snapshots the
// current loadout + pins, POSTs /api/optimize/start and follows the job over
// SSE. While a job runs the button reads 'Cancel' and a progress card sits
// ABOVE whatever result is already showing, so a re-run never blanks the
// previous answer.
//
// On done the pane becomes a read-only MIRROR of the editor: a toolbar
// (apply / save / close), its own small tab strip (Profile / Talents / Runes)
// styled subordinate to the main .tabs, and the matching read-only render of
// the RESULT's own data - App.result.envelope.build + App.result.view, never
// App.state:
//   Profile  window.SheetView.renderBuild(host, {…, readOnly: true})
//   Talents  window.TalentsView.renderTree(host, {…, readOnly: true})
//   Runes    window.RunesView.renderRunes(host, {…, readOnly: true})
// Any of the three may be missing, throw, or render nothing; each then falls
// back to a plain readable listing so a tab is never empty or broken.
//
// The damage meter sits under the Profile tab only: it is about the build as a
// whole and belongs with the sheet, and the headline number stays on the
// ribbon on every tab, so nothing becomes unreachable.
//
// Read-only-ness comes from the renderers binding no mutation handlers; a
// capture-phase click swallow on the tab body backs that up. Hovers are
// deliberately untouched - every tooltip and the More-stats toggle must work -
// so nothing here may reintroduce pointer-events: none.
//
// Talks to the core only through the stable App surface documented at the top
// of app.js.
// ---------------------------------------------------------------------------

const App = window.App;

const btn = document.getElementById('optimize-btn');
const pane = document.getElementById('result-pane');

// Two fixed children: the progress host (transient, on top) and the result
// host (persists across runs). Keeping them separate is what lets a new run
// compute above the previous result instead of replacing it mid-flight.
const progressHost = document.createElement('div');
progressHost.className = 'opt-progress-host';
const resultHost = document.createElement('div');
resultHost.className = 'opt-result-host';
pane.append(progressHost, resultHost);

const ROW_CAP = 14;

const TABS = [['profile', 'Profile'], ['talents', 'Talents'], ['runes', 'Runes']];

// -------------------------------------------------------------- formatting

const THIN = ' ';                       // the game's thousands separator
const fmt1 = (n) => Number.isFinite(Number(n)) ? Number(n).toFixed(1) : '?';
const fmtInt = (n) => Number.isFinite(Number(n))
  ? String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, THIN)
  : '?';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const deepCopy = (x) => (typeof structuredClone === 'function'
  ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const button = (cls, label, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

// --------------------------------------------------------------- run state

const run = {
  job: null,          // job id while a run is live
  es: null,           // its EventSource
  timer: null,        // local elapsed ticker
  startedAt: 0,
  request: null,      // last request body, kept for the retry button
};

// Result-pane-local view state. `tab` is deliberately NOT App.tab: the two
// panes are browsed independently. Both reset when a new result lands.
const ui = {
  tab: 'profile',
  more: false,        // the sheet's 'More stats' toggle, for THIS pane
  tabBtns: null,      // id -> button, for the active-class sync
  body: null,         // .opt-tabbody, refilled on every tab switch
  below: null,        // .opt-below (meter + unmodelled), Profile only
};

const collectRequest = () => ({
  loadout: App.state.loadout,
  pins: {
    gear: [...App.state.pins.gear],
    augments: [...App.state.pins.augments],
    skills: [...App.state.pins.skills],
    runes: [...App.state.pins.runes],
    talents: App.state.pins.talents,
  },
  options: { ...App.state.options, lookahead: 8, restarts: 3, allowEmpty: true },
});

async function start(request) {
  run.request = request;
  btn.disabled = true;
  let job;
  try {
    ({ job } = await App.api('/api/optimize/start', request));
  } catch (e) {
    btn.disabled = false;
    App.toast(e.message, true);
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Cancel';
  run.job = job;
  run.startedAt = performance.now();
  pane.hidden = false;
  renderProgressCard();
  run.timer = setInterval(tickElapsed, 250);
  subscribe(job);
}

function stopRun() {
  run.es?.close();
  run.es = null;
  clearInterval(run.timer);
  run.timer = null;
  run.job = null;
  btn.disabled = false;
  btn.textContent = 'Optimize';
}

async function cancel() {
  const job = run.job;
  stopRun();
  progressHost.replaceChildren();
  if (!App.result && !resultHost.childElementCount) pane.hidden = true;
  if (job) { try { await App.api('/api/optimize/cancel', { job }); } catch { /* worker already gone */ } }
  App.toast('optimize cancelled');
}

btn.addEventListener('click', () => {
  if (run.job) cancel();
  else start(collectRequest());
});

// The core nulls App.result on class change; mirror that into the DOM so a
// stale result sheet never outlives the state that produced it.
document.addEventListener('app-render', () => {
  if (!App.result && !run.job && resultHost.childElementCount) {
    resultHost.replaceChildren();
    if (!progressHost.childElementCount) pane.hidden = true;
  }
});

// -------------------------------------------------------------------- SSE

function subscribe(job) {
  const es = new EventSource(`/api/optimize/events?job=${encodeURIComponent(job)}`);
  run.es = es;

  es.addEventListener('progress', (e) => {
    if (es !== run.es) return;
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    const card = progressHost.querySelector('.progress-card');
    if (!card) return;
    const evals = card.querySelector('.opt-evals');
    if (evals) evals.textContent = fmtInt(d?.evals ?? 0);
    const log = card.querySelector('.plog');
    if (log) {
      log.appendChild(el('div', null,
        `${fmt1(d?.elapsed)}s · ${fmtInt(d?.evals ?? 0)} evaluations`));
      while (log.childElementCount > 60) log.firstElementChild.remove();
      log.scrollTop = log.scrollHeight;
    }
  });

  es.addEventListener('done', (e) => {
    if (es !== run.es) return;
    stopRun();
    progressHost.replaceChildren();
    let d = null;
    try { d = JSON.parse(e.data); } catch { /* fall through */ }
    if (!d || !d.envelope) {
      renderErrorCard('the optimizer sent an unreadable result');
      return;
    }
    App.result = { envelope: d.envelope, view: d.view, score: d.score };
    ui.tab = 'profile';           // a new answer always opens on the sheet
    ui.more = false;
    renderResult();
    App.toast(`optimize finished in ${fmt1(d.elapsed)}s`);
  });

  // One listener sees both kinds of 'error': the server's `event: error`
  // (a MessageEvent, e.data set) and transport failures (plain Event, no data).
  es.addEventListener('error', (e) => {
    if (es !== run.es) return;
    if (e.data !== undefined && e.data !== null) {
      let msg = 'optimize failed';
      try { msg = JSON.parse(e.data)?.error ?? msg; } catch { /* keep default */ }
      stopRun();
      renderErrorCard(msg);
    } else {
      stopRun();
      renderErrorCard('connection to the optimizer lost');
    }
  });
}

// ---------------------------------------------------------- progress cards

function renderProgressCard() {
  progressHost.replaceChildren();
  const card = el('div', 'progress-card opt-running');
  const top = el('div', 'opt-prog-top');
  top.appendChild(el('span', 'opt-spinner'));
  top.appendChild(el('span', 'opt-title', 'Optimizing…'));
  const stats = el('span', 'opt-stats');
  stats.appendChild(el('span', 'opt-elapsed', '0.0s'));
  stats.appendChild(document.createTextNode(' · '));
  stats.appendChild(el('span', 'opt-evals', '0'));
  stats.appendChild(document.createTextNode(' evaluations'));
  top.appendChild(stats);
  card.appendChild(top);
  const bar = el('div', 'opt-bar');
  bar.appendChild(el('div', 'opt-bar-fill'));
  card.appendChild(bar);
  card.appendChild(el('div', 'plog'));
  progressHost.appendChild(card);
}

function tickElapsed() {
  const t = progressHost.querySelector('.opt-elapsed');
  if (t) t.textContent = ((performance.now() - run.startedAt) / 1000).toFixed(1) + 's';
}

function renderErrorCard(msg) {
  progressHost.replaceChildren();
  const card = el('div', 'progress-card opt-error');
  card.appendChild(el('div', 'opt-error-msg', msg));
  const row = el('div', 'opt-btnrow');
  row.appendChild(button('btn btn-tan', 'Retry',
    () => start(run.request ?? collectRequest())));
  row.appendChild(button('btn btn-tan', 'Dismiss', () => {
    progressHost.replaceChildren();
    if (!resultHost.childElementCount) pane.hidden = true;
  }));
  card.appendChild(row);
  progressHost.appendChild(card);
  pane.hidden = false;
}

// ----------------------------------------------------------------- result

function renderResult() {
  const { envelope, score } = App.result ?? {};
  resultHost.replaceChildren();

  resultHost.appendChild(renderToolbar(envelope));
  resultHost.appendChild(renderTabStrip());

  // The ribboned wrapper frames every tab, so the 'Optimized — n dps' banner
  // (and the frozen-copy tint style.css puts on `.result-sheet .sheet`) reads
  // the same on the tree and the rune page as on the sheet.
  const wrap = el('div', 'result-sheet');
  const goal = App.state.options?.goal ?? 'dps';
  const metric = Number(envelope?.metrics?.[goal]);
  const shown = Number.isFinite(metric) ? metric : Number(score);
  wrap.appendChild(el('div', 'ribbon', `Optimized — ${fmt1(shown)} ${goal}`));
  ui.body = el('div', 'opt-tabbody');
  freeze(ui.body);
  wrap.appendChild(ui.body);
  resultHost.appendChild(wrap);

  ui.below = el('div', 'opt-below');
  resultHost.appendChild(ui.below);

  renderTabBody();
}

// Read-only that keeps hovers alive. A capture-phase listener on the tab body
// runs BEFORE any handler a renderer bound on a descendant, so swallowing the
// event there stops every click/right-click from reaching one - while
// mouseenter/mousemove/mouseleave (i.e. every tooltip) are untouched, which
// pointer-events: none would have killed. Controls that genuinely belong to
// this pane opt back in with .opt-allow.
function freeze(host) {
  for (const type of ['click', 'dblclick', 'contextmenu']) {
    host.addEventListener(type, (e) => {
      if (e.target?.closest?.('.opt-allow')) return;
      if (type === 'contextmenu') e.preventDefault();
      e.stopPropagation();
    }, true);
  }
}

function renderTabStrip() {
  const strip = el('div', 'opt-tabs');
  ui.tabBtns = new Map();
  for (const [id, label] of TABS) {
    const b = button('opt-tab', label, () => selectTab(id));
    ui.tabBtns.set(id, b);
    strip.appendChild(b);
  }
  const chip = el('span', 'opt-ro-chip', 'read-only');
  App.bindTip(chip, '<div class="tname">Frozen copy</div>' +
    '<div class="ttype">the optimizer\'s answer, not your editor</div>' +
    '<div class="tdesc">Hover anything here to inspect it. Nothing on this ' +
    'side can be edited - use Apply to editor to make it yours.</div>');
  strip.appendChild(chip);
  syncTabs();
  return strip;
}

const syncTabs = () => {
  for (const [id, b] of ui.tabBtns ?? []) b.classList.toggle('active', id === ui.tab);
};

function selectTab(id) {
  if (ui.tab === id) return;
  ui.tab = id;
  syncTabs();
  renderTabBody();
}

function renderTabBody() {
  const { envelope, view } = App.result ?? {};
  const loadout = envelope?.build ?? null;
  if (!ui.body) return;
  ui.body.replaceChildren();
  ui.body.className = `opt-tabbody tab-${ui.tab}`;
  ui.below.replaceChildren();
  // Profile-only: the meter scores the build as a whole, and the tree/rune
  // pages are detail views of it. The ribbon keeps the headline on every tab.
  ui.below.hidden = ui.tab !== 'profile';

  if (ui.tab === 'talents') { renderTalentsTab(ui.body, loadout, view); return; }
  if (ui.tab === 'runes') { renderRunesTab(ui.body, loadout, view); return; }

  renderProfileTab(ui.body, loadout, view);
  ui.below.appendChild(renderMeter(view, envelope, false));
  const un = renderUnmodelled(view);
  if (un) ui.below.appendChild(un);
}

// -------------------------------------------------------------- profile tab

function renderProfileTab(host, loadout, view) {
  if (typeof window.SheetView?.renderBuild !== 'function') {
    renderFallbackSheet(host, loadout, view, 'the sheet renderer is not loaded');
    return;
  }
  try {
    window.SheetView.renderBuild(host, {
      loadout, view: statView(view, ui.more), boot: App.boot,
      catalog: App.catalog, title: 'Optimized', readOnly: true,
    });
  } catch (e) {
    host.replaceChildren();
    renderFallbackSheet(host, loadout, view, e?.message || String(e));
    return;
  }
  if (!host.childElementCount) {
    renderFallbackSheet(host, loadout, view, 'the sheet renderer drew nothing');
    return;
  }
  wireMoreStats(host, view);
}

// renderBuild renders the `group === 'primary'` rows and owns its own
// More-stats flag, which it only wires up when interactive. Rather than reach
// into its state, hand it exactly the rows this pane wants shown and label
// them 'primary' so its filter is a no-op.
function statView(view, more) {
  if (!more || !view) return view;
  const rows = (view.attributes || []).filter((a) => a.group !== 'primary');
  if (!rows.length) return view;
  return { ...view, attributes: rows.map((a) => ({ ...a, group: 'primary' })) };
}

function wireMoreStats(host, view) {
  const old = host.querySelector('.morebtn-row .btn');
  if (!old) return;
  // A shallow clone carries the attributes but no listeners: whatever
  // renderBuild bound (nothing, in read-only) is gone, so the toggle can never
  // fire twice or flip a state this pane cannot see.
  const b = old.cloneNode(false);
  b.className = old.className + ' opt-allow';
  b.textContent = ui.more ? 'Basic stats' : 'More stats';
  old.replaceWith(b);
  b.addEventListener('click', () => { ui.more = !ui.more; renderTabBody(); });
  if (ui.more) restoreStatGaps(host, view);
}

// statView flattened the groups away, and with them the blank row renderBuild
// draws where one group ends and the next begins. Put those boundaries back.
function restoreStatGaps(host, view) {
  const rows = (view?.attributes || []).filter((a) => a.group !== 'primary');
  const doms = [...host.querySelectorAll('.panel .statrow')]
    .filter((d) => !d.classList.contains('gap'));
  if (doms.length !== rows.length) return;      // renderer changed shape - skip
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].group === rows[i - 1].group) continue;
    if (doms[i].previousElementSibling?.classList.contains('gap')) continue;
    doms[i].before(el('div', 'statrow gap'));
  }
}

// Plain fallback when sheet.js is unavailable: the dps figure plus the gear
// list as text. Deliberately boring - it only has to not crash and still say
// what the optimizer found.
function renderFallbackSheet(host, loadout, view, note) {
  const box = el('div', 'sheet opt-fallback');
  const lines = [];
  lines.push(`Optimized build — ${fmt1(view?.dps)} dps`);
  if (note) lines.push(`(sheet renderer unavailable: ${note})`);
  lines.push('');
  const gear = loadout?.gear ?? {};
  const slots = Object.keys(gear);
  if (!slots.length) lines.push('(no gear)');
  for (const slot of slots) {
    const g = gear[slot] ?? {};
    let s = `${slot.replace(/^Slot_/, '')}: ${g.item ?? '(empty)'}`;
    if (g.rarity) s += `  [${g.rarity}${g.stars ? ` ${g.stars}★` : ''}]`;
    lines.push(s);
  }
  lines.push('');
  lines.push(`${Object.keys(loadout?.augments ?? {}).length} augments · ` +
    `${Object.keys(loadout?.skills ?? {}).length} skill pools · ` +
    `${Object.keys(loadout?.runes ?? {}).length} runes · ` +
    `${Object.values(loadout?.talents ?? {}).reduce((a, n) => a + (Number(n) || 0), 0)} talent points`);
  box.textContent = lines.join('\n');
  host.appendChild(box);
}

// -------------------------------------------------------------- talents tab

function renderTalentsTab(host, loadout, view) {
  let note = null;
  const draw = window.TalentsView?.renderTree;
  if (typeof draw === 'function') {
    try {
      draw(host, {
        loadout, view, boot: App.boot,
        cls: loadout?.class ?? App.state.cls, readOnly: true,
      });
      if (host.childElementCount) { scrubEditorControls(host); return; }
      note = 'the talent renderer drew nothing';
    } catch (e) {
      note = e?.message || String(e);
    }
  } else {
    note = 'the talent renderer is not loaded';
  }
  host.replaceChildren();
  fallbackTalents(host, loadout, view, note);
}

// A frozen copy has no Reset. If the tree renderer draws one anyway (its
// read-only flag is younger than this pane), it would reset the EDITOR's
// allocation from here - drop it rather than leave a live trap.
function scrubEditorControls(host) {
  for (const n of host.querySelectorAll('.treset')) n.remove();
}

function fallbackTalents(host, loadout, view, note) {
  const box = el('div', 'sheet opt-listing');
  box.appendChild(el('div', 'ornhead', 'Talents'));
  if (note) box.appendChild(el('div', 'opt-note', note));

  const cls = loadout?.class ?? App.state.cls;
  const nodes = App.boot?.talents?.[cls]?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const granted = new Set(view?.talentState?.granted ?? []);
  const ranks = loadout?.talents ?? {};
  const ids = Object.keys(ranks).filter((id) => (Number(ranks[id]) || 0) > 0);
  ids.sort((a, b) => {
    const x = byId.get(a) ?? {}, y = byId.get(b) ?? {};
    return (x.tier ?? 9) - (y.tier ?? 9)
      || (x.branchIndex ?? 9) - (y.branchIndex ?? 9)
      || String(x.name ?? a).localeCompare(String(y.name ?? b));
  });

  if (!ids.length) {
    box.appendChild(el('div', 'opt-note', 'no talent points allocated'));
  }
  for (const id of ids) {
    const n = byId.get(id);
    const rank = Number(ranks[id]) || 0;
    const max = n?.maxPoints ?? rank;
    const row = el('div', 'opt-lrow');
    row.appendChild(App.icon(n?.icon, 32));
    const mid = el('div', 'opt-lmid');
    mid.appendChild(el('div', 'opt-lname', n?.name ?? id));
    mid.appendChild(el('div', 'opt-lsub', n
      ? (n.tier === 0 ? 'Root talent' : `Tier ${n.tier} · ${n.branch} branch`)
      : 'not in this game version\'s tree'));
    row.appendChild(mid);
    row.appendChild(el('span', 'opt-lrank',
      granted.has(id) ? 'SIGIL' : `${rank}/${max}`));
    App.bindTip(row, () =>
      `<div class="tname">${esc(n?.name ?? id)}</div>` +
      `<div class="ttype">Rank ${rank}/${max}` +
      (granted.has(id) ? ' · granted by sigil' : '') + '</div>' +
      (n?.desc ? `<div class="tdesc">${esc(n.desc)}</div>` : ''));
    box.appendChild(row);
  }

  const st = view?.talentState;
  if (st) {
    box.appendChild(el('div', 'opt-note',
      `${st.spent ?? '?'} / ${st.budget ?? '?'} points spent` +
      (st.illegal ? ` — ${st.illegal}` : '')));
  }
  host.appendChild(box);
}

// ---------------------------------------------------------------- runes tab

function renderRunesTab(host, loadout, view) {
  let note = null;
  const draw = window.RunesView?.renderRunes;
  if (typeof draw === 'function') {
    try {
      draw(host, { loadout, view, boot: App.boot, readOnly: true });
      if (host.childElementCount) return;
      note = 'the rune renderer drew nothing';
    } catch (e) {
      note = e?.message || String(e);
    }
  } else {
    note = 'the rune renderer is not loaded';
  }
  host.replaceChildren();
  fallbackRunes(host, loadout, view, note);
}

// The sheet's runePools is the richer source (icons, the option lists); the
// loadout alone still names every slotted rune, so fall back to it.
function runeRows(loadout, view) {
  const pools = Array.isArray(view?.runePools) ? view.runePools : null;
  if (pools?.length) {
    return pools.map((p) => ({
      skill: p.skill,
      name: p.name ?? App.boot?.runes?.[p.skill]?.skillName ?? p.skill,
      icon: p.icon ?? App.boot?.runes?.[p.skill]?.skillIcon ?? null,
      current: loadout?.runes?.[p.skill] ?? p.current ?? null,
    }));
  }
  return Object.entries(loadout?.runes ?? {}).map(([skill, current]) => ({
    skill,
    name: App.boot?.runes?.[skill]?.skillName ?? skill,
    icon: App.boot?.runes?.[skill]?.skillIcon ?? null,
    current,
  }));
}

function fallbackRunes(host, loadout, view, note) {
  const box = el('div', 'sheet opt-listing');
  box.appendChild(el('div', 'ornhead', 'Runes'));
  if (note) box.appendChild(el('div', 'opt-note', note));

  const rows = runeRows(loadout, view);
  if (!rows.length) box.appendChild(el('div', 'opt-note', 'no rune slots'));

  for (const r of rows) {
    const def = (App.boot?.runes?.[r.skill]?.options ?? [])
      .find((o) => o.id === r.current) ?? null;
    const row = el('div', 'opt-lrow');
    row.appendChild(App.icon(r.icon, 32));
    const mid = el('div', 'opt-lmid');
    mid.appendChild(el('div', 'opt-lname', r.name));
    mid.appendChild(el('div', 'opt-lsub' + (r.current ? '' : ' empty'),
      def?.name ?? (r.current ? String(r.current) : 'no rune')));
    row.appendChild(mid);
    if (def?.icon) row.appendChild(App.icon(def.icon, 28));
    App.bindTip(row, () =>
      `<div class="tname">${esc(def?.name ?? r.name)}</div>` +
      `<div class="ttype">${esc(r.current ? `Rune · ${r.name}` : 'no rune slotted')}</div>` +
      (def?.desc ? `<div class="tdesc">${esc(def.desc)}</div>` : ''));
    box.appendChild(row);
  }
  host.appendChild(box);
}

// ----------------------------------------------------------- damage meter

function renderMeter(view, envelope, expanded) {
  const meter = el('div', 'dmg-meter');
  const dmg = view?.damage;
  const rows = [...(dmg?.rows ?? [])].filter(Boolean)
    .sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0));

  const fight = Number(envelope?.fight) || Number(App.state.options?.fight) || 200;
  const head = el('div', 'dmg-head');
  head.appendChild(el('span', null, 'Damage'));
  head.appendChild(el('span', 'total',
    `${fmt1(dmg?.dps)} dps · ${fmtInt(dmg?.total)} total over ${fight}s`));
  meter.appendChild(head);

  const total = Number(dmg?.total) ||
    rows.reduce((a, r) => a + (Number(r.damage) || 0), 0);
  // Meter convention: the bar is share of the LARGEST row, not of the total.
  const maxDmg = rows.reduce((a, r) => Math.max(a, Number(r.damage) || 0), 0);

  for (const r of (expanded ? rows : rows.slice(0, ROW_CAP))) {
    meter.appendChild(renderRow(r, maxDmg, total));
  }

  if (rows.length > ROW_CAP) {
    meter.appendChild(button('opt-expander',
      expanded ? `show top ${ROW_CAP}` : `show all (${rows.length})`,
      () => meter.replaceWith(renderMeter(view, envelope, !expanded))));
  }
  return meter;
}

function renderRow(r, maxDmg, total) {
  const row = el('div', 'dmgrow');
  const fill = el('div', 'fill');
  const w = maxDmg > 0 ? ((Number(r.damage) || 0) / maxDmg) * 100 : 0;
  fill.style.width = Math.max(0, Math.min(100, w)) + '%';
  row.appendChild(fill);
  row.appendChild(App.icon(r.icon, 26));
  row.appendChild(el('span', 'dname', r.name ?? r.id ?? '?'));
  row.appendChild(el('span', 'dnum', fmt1(r.dps)));
  row.appendChild(el('span', 'dnum', fmtInt(r.damage)));
  const share = Number.isFinite(Number(r.share)) ? Number(r.share) * 100
    : (total > 0 ? ((Number(r.damage) || 0) / total) * 100 : 0);
  row.appendChild(el('span', 'dnum share', fmt1(share) + '%'));
  row.appendChild(el('span', 'dnum hits', fmtInt(r.hits)));
  App.bindTip(row, () => rowTip(r));
  return row;
}

function rowTip(r) {
  const hits = Number(r.hits) || 0;
  let html = `<div class="tname">${esc(r.name ?? r.id ?? '?')}</div>`;
  if (r.kind) html += `<div class="ttype">${esc(r.kind)}</div>`;
  if (hits > 0) {
    html += `<div>per hit ≈ ${fmtInt((Number(r.damage) || 0) / hits)}</div>`;
  }
  if (r.source) html += `<div class="tmeta">source: ${esc(r.source)}</div>`;
  return html;
}

function renderUnmodelled(view) {
  const list = Array.isArray(view?.unmodelled) ? view.unmodelled : [];
  if (!list.length) return null;
  const det = el('details', 'opt-unmodelled');
  det.appendChild(el('summary', null,
    `not modelled: ${list.length} ${list.length === 1 ? 'ability' : 'abilities'}`));
  const ul = el('ul');
  for (const u of list) {
    ul.appendChild(el('li', null,
      `${u?.name ?? '?'}${u?.why ? ` — ${u.why}` : ''}`));
  }
  det.appendChild(ul);
  return det;
}

// ---------------------------------------------------------------- toolbar

function renderToolbar(envelope) {
  const bar = el('div', 'opt-toolbar');

  bar.appendChild(button('btn btn-tan', 'Apply to editor', () => {
    const build = envelope?.build;
    if (!build) { App.toast('no build to apply', true); return; }
    App.state.loadout = deepCopy(build);      // deep copy; pins stay as-is
    App.refreshSheet();
    App.render();
    App.toast('optimized build applied to the editor');
  }));

  bar.appendChild(button('btn btn-tan', 'Save build (.json)', () => {
    const cls = envelope?.build?.class ?? App.state.cls ?? 'build';
    const goal = App.state.options?.goal ?? 'dps';
    // The envelope is saved verbatim: it round-trips through
    // `bench sheet --build <file>` and reproduces this sheet.
    const blob = new Blob([JSON.stringify(envelope ?? {}, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `farever-bench-${cls}-${goal}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));

  bar.appendChild(button('btn btn-tan opt-close', '✕ Close', () => {
    App.result = null;
    resultHost.replaceChildren();
    ui.body = ui.below = ui.tabBtns = null;
    // A run in flight keeps the pane open for its progress card.
    if (!run.job) {
      progressHost.replaceChildren();
      pane.hidden = true;
    }
  }));

  return bar;
}
