// ---------------------------------------------------------------------------
// components/talents.js — the talent tree: editable here, read-only in the
// optimize result pane.
//
// Exposes (exact contract):
//   window.TalentsView = { renderTree(host, { loadout, view, boot, cls,
//                                             readOnly }) }
// where `view` is a /api/sheet-shaped response (or null while one computes).
// renderTree reads ONLY its arguments — never App.state — so the result pane
// can draw a foreign build; readOnly binds zero click/contextmenu handlers but
// still binds every tooltip (the result sheet must stay hoverable). The live
// tab is the same renderer fed App.state with readOnly false, so there is one
// implementation, exactly like sheet.js.
//
// Layout: row 0 the root diamond, row 1 the three branch heads, row 2 a
// pair-diamond cluster per branch (tier 2), row 3 a triangle cluster per
// branch (tier 3), row 4 a single diamond per branch (tier 4). Wires are an
// SVG overlay measured after layout against that host's own .ttree box (not
// the window), so a half-width pane measures right; they are redrawn on window
// resize AND from a ResizeObserver, because opening the result pane halves the
// editor without any window resize happening.
//
// Threshold model (contract/talents-runes.md): a tier-N node needs
// thresholds[N] points already spent at LOWER tiers of its branch, root
// included (the root counts toward every branch). Sigil-granted nodes cost
// nothing, count toward no threshold, and take no clicks. Right-click removes
// one rank and CASCADES — every node the removal strands drops too, so
// unlearning the root empties the tree. All rules are enforced locally before
// the mutation; the server stays the authority and any disagreement
// (sheet.talentState.illegal) is surfaced in a strip.
// ---------------------------------------------------------------------------
import App from '../app.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BRANCH_NAMES = ['Root', 'Left', 'Center', 'Right'];
const FALLBACK_THRESHOLDS = [0, 1, 2, 4, 8];
const FALLBACK_DISPLAY = [0, 0, 1, 3, 7];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

const branchName = (b) =>
  typeof b === 'number' ? (BRANCH_NAMES[b] ?? String(b)) : String(b);

// ----------------------------------------------------------------- model

// Everything the renderer needs, derived from the PASSED data only.
function model(opts, tree) {
  const granted = new Set(opts.view?.talentState?.granted ?? []);
  const ranks = opts.loadout?.talents ?? {};
  const thresholds = tree.thresholds ?? FALLBACK_THRESHOLDS;
  const displayCost = tree.displayCost ?? FALLBACK_DISPLAY;
  const unlockLevel = tree.unlockLevel ?? 10;
  const unlocked = (opts.loadout?.level ?? 0) >= unlockLevel;
  const budget = unlocked ? (opts.boot?.constants?.talentPointsAtCap ?? 16) : 0;
  const m = { tree, granted, ranks, thresholds, displayCost, unlockLevel,
              unlocked, budget, spent: 0, inter: !opts.readOnly };
  m.spent = spentIn(m, ranks);
  return m;
}

// Points the player actually paid for: sigil-granted nodes are free and keys
// the tree does not know (older save, other patch) do not count.
function spentIn(m, ranks) {
  let sum = 0;
  for (const n of m.tree.nodes) {
    if (m.granted.has(n.id)) continue;
    sum += ranks[n.id] || 0;
  }
  return sum;
}

// Points spent at lower tiers of `branch`, root included, granted excluded.
function pointsBelow(m, ranks, branch, tier) {
  let sum = 0;
  for (const n of m.tree.nodes) {
    if (m.granted.has(n.id)) continue;
    const r = ranks[n.id] || 0;
    if (!r) continue;
    if (n.tier === 0 || (branchName(n.branch) === branch && n.tier < tier)) {
      sum += r;
    }
  }
  return sum;
}

const curRank = (m, node) =>
  m.granted.has(node.id) ? Math.max(1, m.ranks[node.id] || 0)
                         : (m.ranks[node.id] || 0);

const lockedAt = (m, branch, tier) =>
  pointsBelow(m, m.ranks, branch, tier) < (m.thresholds[tier] ?? 0);

// Pure: the legal allocation nearest `ranks`. A tier threshold is pass/fail,
// not proportional, so a node that no longer meets it loses ALL its ranks;
// that frees points only at its own tier, so the damage propagates strictly
// upward and iterating to a fixpoint is order-independent. Granted nodes hold
// no points and are never touched.
function legalize(m, ranks) {
  const out = { ...ranks };
  for (let pass = 0; pass <= m.tree.nodes.length; pass++) {
    let changed = false;
    for (const n of m.tree.nodes) {
      if (n.tier === 0 || m.granted.has(n.id)) continue;   // no prerequisite
      if (!(out[n.id] > 0)) continue;
      const need = m.thresholds[n.tier] ?? 0;
      if (pointsBelow(m, out, branchName(n.branch), n.tier) < need) {
        delete out[n.id];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

// ----------------------------------------------------------- interaction

function refuse(node, msg) {
  if (node) {
    node.classList.remove('shake');
    void node.offsetWidth;                           // restart the animation
    node.classList.add('shake');
  }
  App.toast(msg);
}

function tryAdd(m, node, dom) {
  if (!m.unlocked) {
    return refuse(dom, `talents unlock at level ${m.unlockLevel}`);
  }
  const cur = m.ranks[node.id] || 0;
  const max = node.maxPoints ?? 1;
  if (cur >= max) {
    return refuse(dom, `${node.name} is already at max rank (${cur}/${max})`);
  }
  if (m.spent >= m.budget) {
    return refuse(dom, `no talent points left (${m.spent}/${m.budget} spent)`);
  }
  const b = branchName(node.branch);
  const need = m.thresholds[node.tier] ?? 0;
  const have = pointsBelow(m, m.ranks, b, node.tier);
  if (have < need) {
    if (node.tier === 1 && !(m.ranks[m.tree.root] || 0)) {
      return refuse(dom, 'take the root talent first');
    }
    return refuse(dom, `needs ${need} points at lower tiers in ${b} ` +
                       `(root included) — only ${have} there`);
  }
  App.setTalent(node.id, cur + 1);
}

// Remove one rank and let everything it stranded fall with it. The cascade is
// one batched write (App.setTalent in a loop would fire a sheet request and a
// full render per dropped point), mirroring the Reset button.
function tryRemove(m, node) {
  const cur = m.ranks[node.id] || 0;
  if (cur <= 0) return;
  const next = { ...m.ranks };
  if (cur > 1) next[node.id] = cur - 1; else delete next[node.id];
  const legal = legalize(m, next);
  const left = spentIn(m, legal);
  const extra = m.spent - left - 1;             // dropped beyond the click

  App.state.loadout.talents = legal;
  // Same reading as Reset: an empty allocation is not a choice worth keeping,
  // so the optimizer is free to search talents again.
  App.state.pins.talents = left > 0;
  App.refreshSheet();
  App.render();

  if (extra > 0) {
    App.toast(`removed ${extra} further point${extra === 1 ? '' : 's'} ` +
              'that no longer had their prerequisites');
  }
}

// --------------------------------------------------------------- tooltip

function tipHtml(m, node) {
  const cur = curRank(m, node);
  const max = node.maxPoints ?? 1;
  const granted = m.granted.has(node.id);
  const parts = [
    `<div class="tname tgold">${esc(node.name)}</div>`,
    `<div class="ttype">Rank ${cur}/${max}` +
      (granted ? ' · granted by sigil (costs nothing)' : '') + '</div>',
  ];
  if (node.desc) parts.push(`<div class="tdesc">${esc(node.desc)}</div>`);
  if (node.readable && node.kind) {
    parts.push(`<div class="tmeta">model reads: ${esc(node.kind)}</div>`);
  } else {
    parts.push('<div class="tmeta"><span class="unmod-dot"></span> ' +
               'not modelled — desc only</div>');
  }
  parts.push(`<div class="tmeta">${node.tier === 0
    ? 'Root talent'
    : `Tier ${node.tier} · ${esc(branchName(node.branch))} branch`}</div>`);
  if (m.inter && !granted && cur > 0) {
    parts.push('<div class="tacquire">right-click removes a point — ' +
               'anything it strands goes with it</div>');
  }
  return parts.join('');
}

// ------------------------------------------------------------ node DOM

function decorate(dom, m, node) {
  const cur = curRank(m, node);
  const max = node.maxPoints ?? 1;
  const granted = m.granted.has(node.id);
  if (!cur) dom.classList.add('zero');
  if (cur > 0 && cur >= max) dom.classList.add('max');
  if (granted) dom.classList.add('sigil');

  const art = el('div', 'art');
  art.appendChild(App.icon(node.icon, 42));
  dom.appendChild(art);

  const rank = el('div', 'rank');
  if (granted) rank.innerHTML = '<span class="tsigil">SIGIL</span>';
  else rank.textContent = `${cur}/${max}`;
  dom.appendChild(rank);

  if (m.inter && granted) {
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  } else if (m.inter) {
    dom.addEventListener('click', () => tryAdd(m, node, dom));
    dom.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      tryRemove(m, node);
    });
  }
  App.bindTip(dom, () => tipHtml(m, node));
  return dom;
}

function makeTnode(m, node, locked) {
  const dom = el('div', 'tnode' + (locked ? ' lockedplate' : ''));
  dom.appendChild(el('div', 'plate'));
  return decorate(dom, m, node);
}

const makeTorb = (m, node) => decorate(el('div', 'torb'), m, node);

const tierLabel = (m, tier) => {
  const lab = el('div', 'tier-label');
  lab.innerHTML = `${m.displayCost[tier] ?? ''} <span class="star">✦</span>`;
  return lab;
};

// ----------------------------------------------------------------- wires

// One entry per rendered tree (the live tab and the result pane can both be
// on screen). Entries whose SVG left the document are dropped on the next
// draw, so nothing has to be unmounted explicitly.
const trees = new Set();

function drawWires(st) {
  const origin = st.ttree.getBoundingClientRect();
  if (!origin.width || !origin.height) return;        // hidden — skip
  st.svg.replaceChildren();
  const mid = (r) => [r.left + r.width / 2 - origin.left,
                      r.top + r.height / 2 - origin.top];
  for (const seg of st.segs) {
    const ra = seg.a.getBoundingClientRect();
    const rb = seg.b.getBoundingClientRect();
    if (!ra.width || !rb.width) continue;
    const [x1, y1] = mid(ra);
    const [x2, y2] = mid(rb);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    if (seg.on) line.setAttribute('class', 'on');
    st.svg.appendChild(line);
  }
}

function drawAll() {
  for (const st of trees) {
    if (!st.svg.isConnected) { trees.delete(st); ro?.unobserve(st.ttree); }
    else drawWires(st);
  }
}

window.addEventListener('resize', drawAll);
// The pane split resizes the tree without resizing the window; observing the
// box is the only thing that catches it. Drawing lines into an inset overlay
// changes no layout, so this cannot loop.
const ro = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => drawAll()) : null;

// ---------------------------------------------------------------- render

function skeleton(wrap) {
  for (let r = 0; r < 3; r++) {
    const row = el('div', 'trow tskel');
    for (let i = 0; i < 3; i++) row.appendChild(el('div', 'tskel-node'));
    wrap.appendChild(row);
  }
}

function renderTree(host, opts = {}) {
  if (!host) return;
  host.replaceChildren();                    // drops this host's old wires
  drawAll();                                 // …and prunes them from the set

  const sheet = el('div', 'sheet');
  const wrap = el('div', 'talents-wrap' + (opts.readOnly ? ' readonly' : ''));
  sheet.appendChild(wrap);
  host.appendChild(sheet);

  const boot = opts.boot ?? null;
  const cls = opts.cls ?? opts.loadout?.class ?? null;
  if (!boot || !opts.loadout) { skeleton(wrap); return; }

  const tree = boot.talents?.[cls];
  if (!tree || !Array.isArray(tree.nodes) || !tree.nodes.length) {
    const note = el('div', 'tnote');
    note.textContent = `no talent tree for ${cls ?? 'this class'}`;
    wrap.appendChild(note);
    return;
  }
  const m = model(opts, tree);

  const avail = m.budget - m.spent;
  const chip = el('div', 'tp-chip');
  chip.innerHTML = opts.readOnly
    ? `Talent Points spent: <b>${m.spent} ✦</b>`
    : `Talent Points available: <b>${avail} ✦</b>`;
  wrap.appendChild(chip);

  if (m.inter) {
    const reset = el('button', 'btn treset');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      App.state.loadout.talents = {};
      App.state.pins.talents = false;
      App.refreshSheet();
      App.render();
    });
    wrap.appendChild(reset);
  }

  const srvIllegal = opts.view?.talentState?.illegal;
  if (srvIllegal) {
    const warn = el('div', 'twarn');
    warn.textContent = `server: ${srvIllegal}`;
    wrap.appendChild(warn);
  }

  if (!m.unlocked) {
    wrap.classList.add('levellocked');
    const gate = el('div', 'tunlock-chip');
    gate.textContent = `Talents unlock at level ${m.unlockLevel}`;
    wrap.appendChild(gate);
  }

  // ---- group the 22 nodes: root + per-branch {head, pair[2], tri[3], t4}
  const nodes = tree.nodes;
  const root = nodes.find((n) => n.tier === 0) ??
               nodes.find((n) => n.id === tree.root);
  const branches = [];
  for (const n of nodes) {
    if (n.tier === 0) continue;
    const name = branchName(n.branch);
    let br = branches.find((x) => x.name === name);
    if (!br) {
      br = { name, order: BRANCH_NAMES.indexOf(name),
             head: null, pair: [], tri: [], t4: null };
      branches.push(br);
    }
    if (n.tier === 1) br.head = n;
    else if (n.tier === 2) br.pair.push(n);
    else if (n.tier === 3) br.tri.push(n);
    else if (n.tier === 4) br.t4 = n;
  }
  branches.sort((a, b) => a.order - b.order);         // Left, Center, Right

  const ttree = el('div', 'ttree');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'wires');
  ttree.appendChild(svg);
  wrap.appendChild(ttree);

  // row 0 — root
  const row0 = el('div', 'trow t0');
  let rootEl = null;
  if (root) row0.appendChild(rootEl = makeTnode(m, root, false));
  ttree.appendChild(row0);

  // row 1 — branch heads
  const row1 = el('div', 'trow t1');
  for (const br of branches) {
    if (!br.head) continue;
    br.headEl = makeTnode(m, br.head, lockedAt(m, br.name, 1));
    row1.appendChild(br.headEl);
  }
  ttree.appendChild(row1);

  // row 2 — pair clusters (tier 2)
  const row2 = el('div', 'trow t2');
  row2.appendChild(tierLabel(m, 2));
  for (const br of branches) {
    const cl = el('div', 'tcluster pair' +
                  (lockedAt(m, br.name, 2) ? ' locked' : ''));
    cl.appendChild(el('div', 'plate'));
    const orbs = el('div', 'orbs');
    for (const n of br.pair) orbs.appendChild(makeTorb(m, n));
    cl.appendChild(orbs);
    row2.appendChild(br.pairEl = cl);
  }
  ttree.appendChild(row2);

  // row 3 — triangle clusters (tier 3): two orbs on top, one below
  const row3 = el('div', 'trow t3');
  row3.appendChild(tierLabel(m, 3));
  for (const br of branches) {
    const cl = el('div', 'tcluster tri' +
                  (lockedAt(m, br.name, 3) ? ' locked' : ''));
    cl.appendChild(el('div', 'plate'));
    const orbs = el('div', 'orbs');
    for (const n of br.tri.slice(0, 2)) orbs.appendChild(makeTorb(m, n));
    cl.appendChild(orbs);
    if (br.tri[2]) {
      const second = el('div', 'second');
      second.appendChild(makeTorb(m, br.tri[2]));
      cl.appendChild(second);
    }
    row3.appendChild(br.triEl = cl);
  }
  ttree.appendChild(row3);

  // row 4 — tier-4 singles
  const row4 = el('div', 'trow t4');
  row4.appendChild(tierLabel(m, 4));
  for (const br of branches) {
    if (!br.t4) continue;
    br.t4El = makeTnode(m, br.t4, lockedAt(m, br.name, 4));
    row4.appendChild(br.t4El);
  }
  ttree.appendChild(row4);

  // ---- wires: root→head, head→pair, pair→tri, tri→t4 per branch.
  // A line is 'on' when its lower-tier end has any invested rank.
  const invested = (ns) => ns.some((n) => curRank(m, n) > 0);
  const segs = [];
  for (const br of branches) {
    if (rootEl && br.headEl) {
      segs.push({ a: rootEl, b: br.headEl, on: !!root && curRank(m, root) > 0 });
    }
    if (br.headEl && br.pairEl) {
      segs.push({ a: br.headEl, b: br.pairEl,
                  on: !!br.head && curRank(m, br.head) > 0 });
    }
    if (br.pairEl && br.triEl) {
      segs.push({ a: br.pairEl, b: br.triEl, on: invested(br.pair) });
    }
    if (br.triEl && br.t4El) {
      segs.push({ a: br.triEl, b: br.t4El, on: invested(br.tri) });
    }
  }
  const st = { ttree, svg, segs };
  trees.add(st);
  ro?.observe(ttree);                 // fires once immediately → first draw
  drawWires(st);
}

// --------------------------------------------------------- the live view

App.view('talents', {
  render(host) {
    renderTree(host, {
      loadout: App.state.loadout,
      view: App.sheet,
      boot: App.boot,
      cls: App.state.cls,
      readOnly: false,
    });
  },
});

window.TalentsView = { renderTree };
