// ---------------------------------------------------------------------------
// components/exchange.js - files into the page, and fights out of it.
//
// Owns #import-btn and #send-btn on the band, the hidden file input behind
// Import, the drop veil, the import report panel and the exchange modal -
// nothing else. Talks to the core only through the App surface documented at
// the top of app.js, plus the fields `/api/import`'s answer is applied to.
//
// IMPORT. A file - picked with the button, or dropped anywhere on the window -
// goes to POST /api/import as text, and the server reads it with the same
// reader `bench import` uses (src/charsheet.mjs): a character sheet, a build
// the bench saved, a bare loadout, or the modkit's inventory dump. What comes
// back is a build the page can install as it is, the pins the file RECORDED,
// and the report lines the CLI prints. Installing it sets class, level, name,
// loadout and pins together and then reloads the catalog - never through
// App.setClass / App.setLevel, which start from an empty loadout and would
// throw the imported one away. The report stays up in a strip under the band,
// above the sheet, until it is dismissed: what was dropped from a file, and
// what it left open to the search, is the one thing a person has to read
// after an import - beside the gear it describes, never over it.
//
// The modkit dump does not name the class. The server's refusal says so with
// the reader's facts - `needs: "class"`, the `character` it names and the
// `classes` its weapons fit - and the panel asks in its own words (the
// reader's sentence names the CLI's --class), offers the first of those
// classes, and sends the same file again. App.api keeps only the sentence of
// an error, so the import posts through its own `post`, which keeps the
// fields too.
//
// Two things an import changes are not on the sheet, so the panel says them:
// a file that names nobody leaves the band's name as it was (a saved build
// carries no name, and re-importing one should not rename the character), and
// the weapon-skill rank - which the page prices every build with and has no
// control for - becomes the file's, or the page's own starting rank when the
// file records none. That last half is what the report's gap line ("the
// bench's default rank applies") promises, and it keeps one import's rank
// from leaking into the next build.
//
// NOT WHILE OPTIMIZE RUNS. A search is about the build that was in the
// editor when it started; installing another under it would land its answer
// on a build it was not about, with "Apply to editor" one click away. So an
// import - picked, dropped, or answered after the class question - asks first
// and stops the search only when told to. The signal is optimize.js's own,
// documented at its top: #optimize-btn reads "Cancel" while a job runs.
//
// DROPPING A FILE. A browser - and Electron, which is one - answers a file
// dropped on a page that does not take it by NAVIGATING to the file: the
// sheet, with whatever the user had built, is replaced by a JSON viewer. So
// every drag is cancelled at the document, a file drop is taken as an
// import, and anything else dropped outside a text field is dropped on the
// floor. Text dragged into a text field still lands there. While a dialog is
// open (this file's modal, or the item picker) nothing is imported behind it:
// the modal's `onDrop` takes the files when it sets one, and otherwise the
// drag shows "no drop" and a drop that arrives anyway is refused with a
// sentence - an import would replace the build the dialog is about and put
// its report under the dialog's veil.
//
// SEND A FIGHT. #send-btn opens the exchange modal on a dialog that packs the
// build the player fought in (the editor's, or a sheet file) with the fight's
// combat log, shows what Send does with it, and only then offers Send,
// Save .zip and the GitHub form. The packing is the server's
// (POST /api/submit/*, src/submit.mjs - the module `bench submit` uses), so
// the page composes no sentence about privacy of its own beyond the route
// it lays out: the files are listed with the sizes the server gave, the
// manual route's title as the server wrote it, the report as `bench submit`
// prints it. Send uploads the zip to the project's folder on pCloud, where
// only the maintainer can read it, and makes nothing public. The files are
// uploaded once, to the preview; Save .zip and Send name the bundle the
// server kept by its previewId, so what is sent is what was shown. Send
// exists only when the server says this copy has an upload link
// (`upload`), only when the preview does not refuse it (`sendRefused`: the
// module's sentence for what `bench submit --send` refuses too - a sheet of
// another class than the log's, unless the class chosen beside a sheet file
// names the file's own), and only after the consent box is ticked. The caps
// a file is held to before it is read are the module's, served in bootstrap
// (`App.boot.submit`), and so are how long a send waits for pCloud and the
// sentence that switches the whole dialog off on a server bound beyond this
// machine.
//
// THE BUILD IN THE EDITOR goes with the page's pins, which are what the
// player stated, and the server writes it by the rule `bench submit` writes a
// build typed with flags by: what a pin holds is recorded - an empty slot
// pinned is "recorded empty" - and what no pin holds is "not recorded",
// whatever the editor shows there (what Apply to editor put in, which leaves
// the pins as they were; the preview says so). The weapon-skill rank, which
// the page has no control for, goes only when the last import recorded it
// and the editor is still that file's class at that rank. And a piece the
// editor still holds as the last import put it there goes with what that
// file stated of it (/api/import's `pieces`): the loadout fills in what a
// file left open - a row's rarity, 0 stars - and those are not the
// character's, so the same sheet sent as a file and sent from the editor
// says the same of each piece.
//
// ONE SEND IS ONE SUBMISSION, AND ITS RECEIPT IS NEVER DROPPED UNSAID. The
// receipt is the one thing that asks for a sent fight's deletion: an
// uploader can delete nothing in the project's folder, so Delete uploads a
// request beside the fight, which the maintainer carries out when they next
// read the folder. The server keeps the receipt on disk before a byte leaves
// and the dialog lists what it keeps at the bottom; the dialog itself holds
// it from the first answer that carries one (a failure that may still have
// arrived included) and asks before anything closes it unsaved - Esc, the
// ✕, the veil, Close. After a send that was not answered the dialog never
// makes a second bundle behind the player's back: Send again sends the same
// one, built again from its receipt as the same submission when the bench
// has let it go - if the first did arrive, the folder then holds two
// identical copies under one id, and the maintainer drops one - and Back
// asks for its deletion first, since a new bundle is a new id and the folder
// would hold the fight twice if the first one arrived. A send keeps the
// dialog open until pCloud answers: the answer completes the receipt. A
// send the bench itself stopped answering (its server stopped while it
// waited) is one that was not answered: the dialog holds the receipt the
// bench kept before it left - found by the preview's `id` among the kept
// ones once the bench answers again - and asks until then as well. Save
// .zip of a bundle the bench let go of builds it again from that receipt,
// as Send again does, and asking for a submission's deletion takes its
// bundle off the screen and is never asked while the dialog is busy.
//
// DROPS. The dialog sets `onDrop`. Files dropped on it go where they most
// likely belong - the fight's log files, or a lone .json while the dialog
// waits for a character sheet file - and it says where it put them, with
// the other place one click away. Once a send was tried, a drop is refused
// with a sentence: it would start another submission.
//
// ESC closes the topmost thing only: the picker's handler runs first (it is
// imported first) and marks the key it used with preventDefault, so this
// file's handler skips a key already spent.
// ---------------------------------------------------------------------------

const App = window.App;

const importBtn = document.getElementById('import-btn');
const sendBtn = document.getElementById('send-btn');
const optimizeBtn = document.getElementById('optimize-btn');

// The rank the page starts with, which is the one the sheet, the runes and
// the worker all fall back to (`?? 3`) and the bench's default. An import of
// a file that records no rank goes back to it.
const PAGE_RANK = App.state.options.rank;

// optimize.js's documented signal: while a job runs #optimize-btn reads
// "Cancel"; between the click and the job's start it is disabled.
const optimizing = () => !!optimizeBtn
  && (optimizeBtn.disabled || optimizeBtn.textContent.trim() === 'Cancel');

// A character sheet is a few kilobytes and a modkit dump twenty; the server
// takes a 40 MB body on this route. Past this the file is not read at all -
// File.text() of a stray video would hold the whole thing in the page first.
const MAX_FILE = 32 * 1024 * 1024;

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

const mb = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

// App.api, keeping what an error says beside its sentence (`needs`, a send's
// receipt - the whole answer as `data`) and the status: App.api turns every
// refusal into a bare Error(message).
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `bad response from ${path} (HTTP ${res.status})` }));
  if (!res.ok || data.error) {
    throw Object.assign(new Error(data.error || `${path}: HTTP ${res.status}`),
      { needs: data.needs ?? null, status: res.status, data });
  }
  return data;
}

// ------------------------------------------------------------ report panel

// One panel at a time, a strip in the page's own flow under the band, above
// the tabs: it pushes the sheet down rather than lying over it, so the build
// the import just changed and what was said about it are read together (a
// fixed panel on the right covered the Weapons card, and the Optimize result
// beside it). It scrolls on its own past a third of the window.
let panel = null;

function closePanel() {
  panel?.remove();
  panel = null;
}

function openPanel(title, kind = '') {
  closePanel();
  panel = el('div', `xpanel${kind ? ` ${kind}` : ''}`);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  const head = el('div', 'xhead');
  head.append(el('span', 'xtitle', title));
  const x = button('x', '✕', closePanel);
  x.title = 'Dismiss (Esc)';
  head.append(x);
  const body = el('div', 'xbody');
  panel.append(head, body);
  const tabs = document.getElementById('tabs');
  if (tabs?.parentNode) tabs.parentNode.insertBefore(panel, tabs);
  else document.body.append(panel);
  // An import from a page scrolled down to the gear: the strip is above it.
  const shown = panel;
  requestAnimationFrame(() => { if (panel === shown) shown.scrollIntoView({ block: 'nearest' }); });
  return body;
}

// The CLI's lines, each marked by what its reader says of it (`reportItems`
// - charsheet.mjs's for a sheet, submit.mjs's for a bundle, which nests the
// readers' own as 'sheet:<kind>' and 'log:<kind>'). Which lines are warned
// of is the readers' to say, as `warn: true` - the flag `bench` colours by -
// and never decided here, nor read off the words a line opens with. The page
// only picks the look of a warned line by what it is, so a drop reads as a
// drop at a glance (anything else warned is a warning), and sets a note soft.
// The words are printed as they are.
const WARN_LOOKS = { dropped: 'drop', gap: 'gap', unknown: 'unknown' };
const lineMark = ({ kind, warn }) => {
  const k = String(kind ?? '').replace(/^(sheet|log):/, '');
  if (warn === true) return WARN_LOOKS[k] ?? 'warn';
  return k === 'note' ? 'note' : '';
};
// An answer's report as items: `reportItems`, or - from a server that sends
// only the text - the lines unmarked.
const reportOf = (r) => (Array.isArray(r?.reportItems) ? r.reportItems
  : (r?.report ?? []).map((text) => ({ kind: '', text })));
const reportList = (r) => {
  const ul = el('ul', 'xlines');
  for (const item of reportOf(r)) {
    const mark = lineMark(item);
    ul.append(el('li', mark ? `xl-${mark}` : '', item.text));
  }
  return ul;
};

// `page` is what applyImport says it did beyond the file's own fields.
function showReport(fileName, r, page = {}) {
  const body = openPanel(`Imported ${fileName}`);
  const cls = App.boot?.classes?.find((c) => c.unit === r.unit);
  const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tally = [
    count(r.dropped?.length ?? 0, 'thing dropped', 'things dropped'),
    count(r.gaps?.length ?? 0, 'gap'),
    r.unknownKeys?.length ? count(r.unknownKeys.length, 'unknown key') : null,
  ].filter(Boolean).join(', ');
  body.append(el('div', 'xsummary',
    `${r.name ? `${r.name} - ` : ''}${cls?.name ?? r.unit}, level ${r.level}: ${tally}.`));
  body.append(el('p', 'xlead',
    'The editor now holds this build. What the file recorded is pinned; what it left out is open to Optimize.'));
  if (page.nameKept != null) {
    body.append(el('p', 'xpage', `The file names no character, so the band keeps the name "${page.nameKept}".`));
  }
  if (page.rankWas != null) {
    body.append(el('p', 'xpage', r.rank != null
      ? `The page now prices with weapon-skill rank ${r.rank}, as the file records (it was ${page.rankWas}). `
        + 'It has no control for the rank, so it stays until another import changes it.'
      : `The file records no weapon-skill rank, so the page is back to its own, rank ${PAGE_RANK} `
        + `(the file imported before this one had set ${page.rankWas}).`));
  }
  body.append(reportList(r));
  const row = el('div', 'xbtnrow');
  row.append(button('btn btn-tan', 'Close', closePanel));
  body.append(row);
}

function showError(fileName, message) {
  const body = openPanel(`Could not import ${fileName}`, 'xerr');
  body.append(el('p', 'xmsg', message));
  const row = el('div', 'xbtnrow');
  row.append(button('btn btn-tan', 'Close', closePanel));
  body.append(row);
}

// A class as a person reads it: the name bootstrap gives the unit id.
const className = (unit) => App.boot?.classes?.find((c) => c.unit === unit)?.name ?? unit;

// The reader's "which class?" in the page's words, from what the refusal
// carries as data: the `character` the file names, the `classes` its weapons
// fit and - in the Send dialog - the `logClass` the fight's log names its
// character. The reader's own sentence names the CLI's --class, so it is
// not the one shown.
function classQuestion(fileName, d) {
  const a = (u) => `a ${className(u)}`;
  const fits = Array.isArray(d?.classes) ? d.classes : null;
  const all = App.boot?.classes?.length ?? 0;
  let s = `${fileName} does not say which class ${d?.character ? `"${d.character}"` : 'its character'} is`;
  if (fits?.length === 1) s += ` - every weapon it lists fits ${a(fits[0])}`;
  else if (fits?.length > 1 && fits.length < all) s += ` - its weapons fit ${fits.map(a).join(' or ')}`;
  else if (fits && !fits.length) s += ' - and no one class can use every weapon it lists';
  s += '.';
  if (d?.logClass) s += ` The fight's log names its character ${a(d.logClass)}.`;
  return `${s} Choose the class (and the level, when it is not the one its highest item gives), and it is read again.`;
}

// The class the question offers first: the log's, when the file's weapons
// allow it; else the first they fit; else the editor's.
function firstClass(d) {
  const fits = Array.isArray(d?.classes) ? d.classes : [];
  if (d?.logClass && (!fits.length || fits.includes(d.logClass))) return d.logClass;
  return fits[0] ?? d?.logClass ?? App.state.cls;
}

// The modkit dump's question: which class, and - optionally - which level,
// since the dump does not carry it either and the reader otherwise takes the
// highest equipped item's. Asked again, with the reader's sentence, when the
// answer itself is refused (a level out of range), keeping what was chosen.
function askClass(src, message, { cls = App.state.cls, level = null, refused = false } = {}) {
  const body = openPanel(`Import ${src.name}`, refused ? 'xerr' : '');
  body.append(el('p', 'xmsg', message));
  const form = el('div', 'xform');
  const clsLabel = el('label', null, 'Class');
  const sel = el('select');
  for (const c of App.boot?.classes ?? []) {
    const o = el('option', null, c.name);
    o.value = c.unit;
    sel.append(o);
  }
  sel.value = cls;
  clsLabel.append(sel);
  const lvlLabel = el('label', null, 'Level');
  const lvl = el('input');
  lvl.type = 'number';
  lvl.min = '1';
  lvl.max = String(App.boot?.constants?.maxLevel ?? 25);
  lvl.placeholder = 'from the dump';
  if (level != null) lvl.value = String(level);
  lvlLabel.append(lvl);
  form.append(clsLabel, lvlLabel);
  body.append(form);
  const row = el('div', 'xbtnrow');
  const go = button('btn btn-tan xprimary', 'Import as this class', () => {
    const n = lvl.value.trim() === '' ? null : Number(lvl.value);
    runImport(src, { cls: sel.value, level: n });
  });
  row.append(go, button('btn btn-tan', 'Cancel', closePanel));
  body.append(row);
  sel.focus();
}

// ------------------------------------------------------------------ import

let busy = false;

// The weapon-skill rank the last import RECORDED, with the class it was
// recorded for - null when it recorded none. The page has no control for the
// rank, so this is the only way the editor's rank is ever a statement: the
// build in the editor is sent with it only while the editor is still that
// class at that rank (see the header).
let importedRank = null;

// What the last import's FILE stated of each piece (/api/import's `pieces`,
// src's charsheet.mjs recordedPieces), with the very entry it was about: the
// loadout an import installs fills in what the file left open (a weapon's
// row rarity, 0 stars), and the build in the editor is sent with what the
// file stated for each piece it still holds as imported - the same object,
// unchanged (App.setGear replaces a slot's entry, never edits it) - so an
// imported sheet sent from the editor states no more than the file did.
let importedPieces = null;

// The answer of /api/import, installed. Every field at once and the catalog
// before the first render, so no view draws the new loadout against the old
// class's catalog for longer than the one await.
async function applyImport(r) {
  const before = { name: App.state.name, rank: App.state.options.rank };
  App.state.cls = r.unit;
  App.state.level = r.level;
  const named = typeof r.name === 'string' && r.name !== '';
  if (named) App.state.name = r.name;
  App.state.loadout = deepCopy(r.loadout);
  const p = r.pins ?? {};
  App.state.pins = {
    gear: new Set(p.gear ?? []),
    augments: new Set(p.augments ?? []),
    skills: new Set(p.skills ?? []),
    runes: new Set(p.runes ?? []),
    talents: p.talents === true,
    infusions: new Set(p.infusions ?? []),
  };
  // The file's rank, or the page's starting one when it records none - never
  // a rank the file imported before this one left behind (see the header).
  App.state.options.rank = r.rank ?? PAGE_RANK;
  importedRank = Number.isInteger(r.rank) ? { rank: r.rank, cls: r.unit } : null;
  const gear = App.state.loadout?.gear ?? {};
  importedPieces = Object.fromEntries(Object.entries(r.pieces ?? {})
    .filter(([slot]) => gear[slot] && typeof gear[slot] === 'object')
    .map(([slot, stated]) => [slot, { entry: gear[slot], json: JSON.stringify(gear[slot]), stated }]));
  // An optimize result is about the build that was in the editor, not this one.
  App.result = null;
  await App.loadCatalog();
  App.refreshSheet();
  App.render();
  return {
    nameKept: named ? null : before.name,
    rankWas: App.state.options.rank !== before.rank ? before.rank : null,
  };
}

// Optimize is running on the build an import would replace: say so, and stop
// it only on the user's word. The button clicks #optimize-btn only while it
// still reads "Cancel" - on a run that finished meanwhile the same click
// would START one - and optimize.js's cancel drops the job's stream before it
// awaits anything, so no answer from it can land after this.
function askStopSearch(src, opts) {
  const body = openPanel(`Import ${src.name}`);
  body.append(el('p', 'xmsg', 'Optimize is still searching the build in the editor. Importing replaces that build, '
    + 'and the search\'s answer would then land on a build it was not about - so the search stops first, or the '
    + 'import waits.'));
  const row = el('div', 'xbtnrow');
  row.append(
    button('btn btn-tan xprimary', 'Stop the search and import', () => {
      if (optimizeBtn.textContent.trim() === 'Cancel' && !optimizeBtn.disabled) optimizeBtn.click();
      runImport(src, opts);
    }),
    button('btn btn-tan', 'Keep searching', closePanel),
  );
  body.append(row);
}

async function runImport(src, { cls = null, level = null } = {}) {
  if (busy) return;
  if (optimizing()) { askStopSearch(src, { cls, level }); return; }
  busy = true;
  importBtn.disabled = true;
  try {
    const body = { file: { name: src.name, text: src.text } };
    if (cls) body.class = cls;
    if (level != null) body.level = level;
    const r = await post('/api/import', body);
    // A search started while the file was on its way: the same question.
    if (optimizing()) { askStopSearch(src, { cls, level }); return; }
    const page = await applyImport(r);
    showReport(src.name, r, page);
  } catch (e) {
    // The reader's question, asked in the page's words, the first class the
    // dump's weapons fit offered first.
    if (e.needs === 'class') askClass(src, classQuestion(src.name, e.data), { cls: firstClass(e.data) });
    // A class was asked for and given, and the answer was refused: ask again.
    else if (cls) askClass(src, e.message, { cls, level, refused: true });
    else showError(src.name, e.message);
  } finally {
    busy = false;
    importBtn.disabled = false;
  }
}

async function importFile(file) {
  if (busy) return;
  if (file.size > MAX_FILE) {
    showError(file.name, `${file.name} is ${mb(file.size)}, and Import reads files up to ${mb(MAX_FILE)} - `
      + 'a character sheet is a few kilobytes, so this is likely not one');
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (e) {
    showError(file.name, `${file.name} could not be read: ${e.message}`);
    return;
  }
  await runImport({ name: file.name, text });
}

// The button's file picker. One input for the page's life; cleared before
// each pick so choosing the same file twice imports it twice.
const fileInput = el('input');
fileInput.type = 'file';
fileInput.accept = '.json,application/json';
fileInput.hidden = true;
fileInput.id = 'import-file';
document.body.append(fileInput);
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) importFile(f);
});
importBtn.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

// ------------------------------------------------------------ modal shell

// The exchange's own modal: the picker's veil and frame (style.css
// .modal-veil), with its own box. `onDrop`, when the opener sets it, takes
// the files dropped while the modal is up. `locked`, while the opener sets
// it, keeps the modal open - Esc, the ✕ and a click on the veil call
// `onLocked` instead (a send waiting for its answer). `beforeClose`, when
// the opener sets it, is asked before every close but a forced one and
// keeps the modal open by answering false (a receipt not saved yet).
let modal = null;

function closeModal({ force = false } = {}) {
  if (!modal) return;
  if (modal.locked) { modal.onLocked?.(); return; }
  if (force !== true && modal.beforeClose && modal.beforeClose() === false) return;
  modal.veil.remove();
  modal = null;
}

export function openModal(title, kind = '') {
  if (modal) closeModal();
  // It would not close (a send under way, a receipt not saved): it stays the one.
  if (modal) return modal;
  const veil = el('div', 'modal-veil xveil');
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) closeModal(); });
  const box = el('div', `xmodal${kind ? ` ${kind}` : ''}`);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', title);
  const head = el('div', 'xhead');
  head.append(el('span', 'xtitle', title));
  const x = button('x', '✕', () => closeModal());
  x.title = 'Close (Esc)';
  head.append(x);
  const body = el('div', 'xbody');
  box.append(head, body);
  veil.append(box);
  (document.getElementById('modal-host') || document.body).append(veil);
  modal = { veil, box, body, onDrop: null, locked: false, onLocked: null, beforeClose: null };
  return modal;
}

// ------------------------------------------------------------ send a fight

// The caps src/submit.mjs holds a bundle to, as bootstrap serves them -
// never copied here, where they would go on saying the old ones after the
// module moved one. Checked before a file is read at all: a sheet, each log
// (a gzip log that inflates past it is the server's to refuse), the note. A
// cap the server did not send is not checked here; the server still holds
// the file to it.
const caps = () => App.boot?.submit ?? {};
const capOf = (key) => (Number.isFinite(caps()[key]) && caps()[key] > 0 ? caps()[key] : null);

const bytesText = (n) => `${Number(n).toLocaleString('en-US')} bytes`;
const sizeText = (n) => (n < 1024 ? bytesText(n) : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : mb(n));
// A cap as a person reads it: whole KB or MB, as the module's sentences say them.
const capText = (n) => (n % (1024 * 1024) === 0 ? `${n / (1024 * 1024)} MB` : n % 1024 === 0 ? `${n / 1024} KB` : bytesText(n));
const short = (id) => String(id ?? '').slice(0, 8);

// The build in the editor as /api/submit/preview takes it: the loadout, the
// pins that say what the player stated (in /api/optimize/start's shape), the
// band's name, the rank only when an import recorded it, and what the
// import's file stated of each piece still held as imported (see the header).
function editorBuild() {
  const p = App.state.pins;
  const rank = importedRank && importedRank.cls === App.state.cls && importedRank.rank === App.state.options.rank
    ? importedRank.rank : null;
  const gear = App.state.loadout?.gear ?? {};
  const pieces = {};
  for (const [slot, was] of Object.entries(importedPieces ?? {})) {
    if (gear[slot] === was.entry && JSON.stringify(gear[slot]) === was.json) pieces[slot] = was.stated;
  }
  return {
    loadout: App.state.loadout,
    pins: {
      gear: [...p.gear], augments: [...p.augments], skills: [...p.skills],
      runes: [...p.runes], talents: p.talents === true, infusions: [...(p.infusions ?? [])],
    },
    name: App.state.name || null,
    rank,
    ...(Object.keys(pieces).length ? { pieces } : {}),
  };
}

// A receipt's time as a person reads it, in UTC, as the receipt writes it.
const whenText = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'at a time it does not say';
};

// How long a send waits for pCloud's answer, as bootstrap serves it (the
// module's SEND_TIMEOUT_MS), in words; null when the server sent none.
const waitText = () => {
  const ms = capOf('sendTimeoutMs');
  if (!ms) return null;
  if (ms < 60 * 1000) return `${Math.round(ms / 1000)} s`;
  const min = Math.round(ms / (60 * 1000));
  return `${min} minute${min === 1 ? '' : 's'}`;
};

// A sentence ends once: the server's carry their full stop, or do not.
const ended = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

// A file's bytes as base64 - a log may be gzip, and text would not survive
// the trip. FileReader's data: URL, cut after its comma.
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error ?? new Error('the file could not be read'));
    r.readAsDataURL(file);
  });
}

// A file handed to the user's own save dialog (the same anchor-and-Blob
// download "Save build" uses).
function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function base64Blob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// "Save receipt": the module's own file, under the name the server gave it.
const saveReceipt = (r) => saveBlob(r.receiptName, new Blob([r.receiptText], { type: 'application/json' }));

// Which picked file is the log and which its summary. Wink's DPS Meter saves
// a fight as <name>.json (the summary) and <name>.json.timeline (every
// event): picked together, the .timeline is the log and the other its
// summary. One file is the log, whatever it is - a farever-combat-log, a
// timeline alone, or a summary alone (totals only, which the report says).
function assignLogs(files) {
  if (!files.length) return { log: null, summary: null, error: null };
  if (files.length === 1) return { log: files[0], summary: null, error: null };
  const timelines = files.filter((f) => /\.timeline$/i.test(f.name));
  if (files.length === 2 && timelines.length === 1) {
    return { log: timelines[0], summary: files.find((f) => f !== timelines[0]), error: null };
  }
  return {
    log: null, summary: null,
    error: files.length > 2
      ? `${files.length} files were chosen - a fight is one combat log, or Wink's .json.timeline with its .json summary`
      : `${files[0].name} and ${files[1].name} do not go together - two files are one fight only as Wink's .json.timeline with its .json summary`,
  };
}

// What the dialog holds for one opening of it.
function freshSend() {
  return {
    // the choices; `askClass` is the class question's facts (the refusal's
    // `character`, `classes`, `logClass`) while the sheet file needs a class,
    // and `fileCls` the class chosen beside a sheet file otherwise (null: as
    // the file says) - what --class is beside --import
    sheetFrom: 'editor', sheetFile: null, cls: null, level: null, askClass: null, fileCls: null,
    logs: { log: null, summary: null, error: null },
    note: '', keepName: false,
    // where it is, and what it says
    page: 'compose', busy: false, error: null, status: null, drop: null,
    // a question shown in place of the buttons: { text, buttons: [[label, run, primary]] }
    ask: null,
    // the preview the server answered with, the body it was made from (to
    // build it again as itself), and the consent box
    preview: null, body: null, consent: false,
    // This dialog's submission once a send of it was tried: its receipt
    // { receipt, receiptText, receiptName, kept } and whether the player
    // saved it (`savedPending`: the copy saved was the pending one, and the
    // held one is completed since). `sent` is /send's { id, uploadedAs,
    // sentAt, zipSha256 } once pCloud confirmed the send. `lost`: a send
    // whose request got no answer at all - the bench itself stopped
    // answering while it waited - so it may have left, and its receipt,
    // kept on disk before it did, is held only once the bench answers again
    // (loadKept finds it by the preview's id).
    receipt: null, sent: null, lost: false,
    // A kept receipt the next preview is built again as ("Send again…" in
    // the list at the bottom): { receipt, receiptText }.
    again: null,
    // The bottom of the dialog: what /api/submit/receipts listed, a request
    // for a deletion being asked about, and what the last one said.
    kept: null, delAsk: null, delMsg: null,
  };
}

function openSendDialog() {
  if (modal) return;
  const m = openModal('Send a fight', 'xsend');
  const st = freshSend();
  const main = el('div', 'xsend-main');
  const foot = el('div', 'xfoot');
  m.body.append(main, foot);

  // The picker inputs live in the dialog and go with it.
  const sheetInput = el('input');
  sheetInput.type = 'file';
  sheetInput.accept = '.json,application/json';
  sheetInput.hidden = true;
  sheetInput.id = 'send-sheet-file';
  const logInput = el('input');
  logInput.type = 'file';
  logInput.multiple = true;
  logInput.accept = '.jsonl,.json,.timeline,.gz';
  logInput.hidden = true;
  logInput.id = 'send-log-files';
  const receiptInput = el('input');
  receiptInput.type = 'file';
  receiptInput.accept = '.json,application/json';
  receiptInput.hidden = true;
  receiptInput.id = 'send-receipt-file';
  m.body.append(sheetInput, logInput, receiptInput);

  const setSheet = (f) => {
    st.sheetFile = f;
    st.sheetFrom = 'file';
    st.askClass = null;
    st.fileCls = null;
    st.error = null;
  };
  sheetInput.addEventListener('change', () => {
    const f = sheetInput.files?.[0];
    if (!f) return;
    setSheet(f);
    st.drop = null;
    render();
  });
  logInput.addEventListener('change', () => {
    st.logs = assignLogs(Array.from(logInput.files ?? []));
    st.error = null;
    st.drop = null;
    render();
  });
  m.onDrop = takeDrop;
  m.onLocked = () => {
    const wait = waitText();
    st.status = `A send is on its way to the project's pCloud folder: the dialog stays open until pCloud answers${wait ? ` (${wait} at most)` : ''}, `
      + 'because the answer completes the receipt that asks for the fight\'s deletion.';
    render();
  };
  m.beforeClose = () => {
    // Esc on a question answers it "not now": the question goes, the dialog stays.
    if (st.ask) { st.ask = null; render(); return false; }
    if ((st.receipt && !st.receipt.saved) || (st.lost && !st.receipt)) { askUnsaved(); return false; }
    return true;
  };

  const render = () => {
    main.replaceChildren();
    if (st.page === 'compose') renderCompose();
    else renderReview();
    renderFoot();
  };

  // --- what every page shows the same way

  // Where dropped files went, with the other place one click away.
  function renderDrop() {
    if (!st.drop) return;
    const p = el('p', `xmsg xdropnote${st.drop.bad ? '' : ' xdropok'}`, st.drop.text);
    if (st.drop.swap) p.append(document.createTextNode(' '), button('xlink', st.drop.swap[0], st.drop.swap[1]));
    main.append(p);
  }

  // A question in place of the buttons, scrolled to where it is asked.
  function renderAsk() {
    const box = el('div', 'xask');
    box.append(el('p', 'xmsg', st.ask.text));
    const row = el('div', 'xbtnrow');
    for (const [label, run, primary] of st.ask.buttons) {
      const b = button(`btn btn-tan${primary ? ' xprimary' : ''}`, label, run);
      b.disabled = st.busy;
      row.append(b);
    }
    box.append(row);
    main.append(box);
    requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest' }));
  }

  // --- page 1: what to send
  function renderCompose() {
    main.append(el('p', 'xlead', 'Packs the build you fought in and the fight\'s combat log into one .zip, then shows what '
      + 'Send does with it. Nothing leaves this computer until you click Send.'));
    // A server bound beyond this machine refuses every submit route, and
    // bootstrap says why: said here, before anything is filled in.
    const off = caps().off;
    if (off) main.append(el('p', 'xmsg xerrline', `${off}.`));
    if (st.status) main.append(el('p', 'xmsg xstatus', st.status));

    // Building a kept submission again, or - when a send from this bench
    // was never answered - saying so before a new one is made.
    if (st.again) {
      const r = st.again.receipt;
      const box = el('div', 'xagain');
      box.append(el('p', 'xmsg', `Sending again: submission ${short(r.id)}, made ${whenText(r.createdAt)}, whose send was not answered. `
        + 'Choose the same build, combat log, note and name choice as the first time: the bench holds the bundle to the one the '
        + 'receipt names, byte for byte, and refuses any other - other files, or the same ones after an update of the game or of '
        + 'the bench. If the first send did arrive, the project\'s folder then holds two identical copies under one id, and the '
        + 'maintainer drops one.'));
      box.append(button('xlink', 'Make a new submission instead', () => { st.again = null; st.error = null; render(); }));
      main.append(box);
    } else {
      const pending = (st.kept?.receipts ?? []).filter((x) => !x.receipt.sentAt);
      if (pending.length) {
        const r = pending[0].receipt;
        const warn = el('div', 'xwarn');
        warn.append(el('p', 'xmsg', pending.length === 1
          ? `A send from this bench was not answered: submission ${short(r.id)}, made ${whenText(r.createdAt)}. It may have reached `
            + 'the project\'s folder, so send it again or ask for its deletion (both at the bottom of this dialog) before sending that '
            + 'fight anew: a new bundle is a new submission, and the folder would hold the fight twice if the first one arrived.'
          : `${pending.length} sends from this bench were not answered (listed at the bottom of this dialog). Each may have reached `
            + 'the project\'s folder, so send it again or ask for its deletion before sending that fight anew: a new bundle is a new '
            + 'submission, and the folder would hold the fight twice if the first one arrived.'));
        main.append(warn);
      }
    }

    const sheetSec = el('fieldset', 'xsec');
    sheetSec.append(el('legend', null, 'The build'));
    const cls = App.boot?.classes?.find((c) => c.unit === App.state.cls);
    const radio = (value, label, extra) => {
      const lab = el('label', 'xradio');
      const r = el('input');
      r.type = 'radio';
      r.name = 'xs-sheet';
      r.value = value;
      r.checked = st.sheetFrom === value;
      r.addEventListener('change', () => { st.sheetFrom = value; st.error = null; render(); });
      lab.append(r, document.createTextNode(` ${label}`));
      if (extra) lab.append(extra);
      return lab;
    };
    sheetSec.append(radio('editor', 'The build in the editor',
      el('span', 'xdim', ` - ${cls?.name ?? App.state.cls}, level ${App.state.level}${App.state.name ? `, "${App.state.name}"` : ''}`)));
    const fileRow = el('div', 'xrow');
    fileRow.append(radio('file', 'A character sheet file'),
      button('btn btn-tan xsmall', 'Choose file…', () => { sheetInput.value = ''; sheetInput.click(); }),
      el('span', st.sheetFile ? 'xfile' : 'xfile xdim', st.sheetFile ? `${st.sheetFile.name} (${sizeText(st.sheetFile.size)})` : 'none chosen'));
    sheetSec.append(fileRow);
    if (st.sheetFrom === 'file' && st.askClass) {
      sheetSec.append(el('p', 'xmsg', classQuestion(st.sheetFile?.name ?? 'The character sheet file', st.askClass)));
      const form = el('div', 'xform');
      const clsLabel = el('label', null, 'Class');
      const sel = el('select');
      for (const c of App.boot?.classes ?? []) {
        const o = el('option', null, c.name);
        o.value = c.unit;
        sel.append(o);
      }
      sel.value = st.cls ?? firstClass(st.askClass);
      st.cls = sel.value;
      sel.addEventListener('change', () => { st.cls = sel.value; });
      clsLabel.append(sel);
      const lvlLabel = el('label', null, 'Level');
      const lvl = el('input');
      lvl.type = 'number';
      lvl.min = '1';
      lvl.max = String(App.boot?.constants?.maxLevel ?? 25);
      lvl.placeholder = 'from the dump';
      if (st.level != null) lvl.value = String(st.level);
      lvl.addEventListener('input', () => { st.level = lvl.value.trim() === '' ? null : Number(lvl.value); });
      lvlLabel.append(lvl);
      form.append(clsLabel, lvlLabel);
      sheetSec.append(form);
    } else if (st.sheetFrom === 'file' && st.sheetFile) {
      // The class beside the file, as --class is beside --import: for a file
      // that names none, and - the module's rule, which its refusal names -
      // to say a file's own class is right where the fight's log names
      // another (the log's header is then the one that is wrong).
      const form = el('div', 'xform');
      const clsLabel = el('label', null, 'Its class');
      const sel = el('select');
      sel.id = 'send-sheet-class';
      const asFile = el('option', null, 'as the file says');
      asFile.value = '';
      sel.append(asFile);
      for (const c of App.boot?.classes ?? []) {
        const o = el('option', null, c.name);
        o.value = c.unit;
        sel.append(o);
      }
      sel.value = st.fileCls ?? '';
      sel.addEventListener('change', () => { st.fileCls = sel.value || null; st.error = null; });
      clsLabel.append(sel);
      form.append(clsLabel);
      sheetSec.append(form, el('p', 'xhint', 'Leave it as the file says - unless the file names no class, or the fight\'s log '
        + 'names another class than the file\'s and the log is the one that is wrong: choosing the file\'s own class then says so.'));
    }
    main.append(sheetSec);

    const logSec = el('fieldset', 'xsec');
    logSec.append(el('legend', null, 'The fight'));
    const logRow = el('div', 'xrow');
    logRow.append(button('btn btn-tan xsmall', 'Choose the combat log…', () => { logInput.value = ''; logInput.click(); }));
    logSec.append(logRow);
    if (st.logs.log) {
      const ul = el('ul', 'xpicked');
      ul.append(el('li', null, `Combat log: ${st.logs.log.name} (${sizeText(st.logs.log.size)})`));
      if (st.logs.summary) ul.append(el('li', null, `Its summary: ${st.logs.summary.name} (${sizeText(st.logs.summary.size)})`));
      logSec.append(ul);
    } else if (st.logs.error) {
      logSec.append(el('p', 'xmsg xerrline', st.logs.error));
    }
    logSec.append(el('p', 'xhint', 'A farever-combat-log file, or the two files Wink\'s DPS Meter saves for one fight - '
      + 'the .json.timeline and its .json - chosen together. You can also drop them on this dialog.'));
    main.append(logSec);

    const noteSec = el('fieldset', 'xsec');
    noteSec.append(el('legend', null, 'A note (optional)'));
    const ta = el('textarea', 'xnote');
    ta.rows = 3;
    const noteMax = capOf('noteMax');
    if (noteMax) ta.maxLength = noteMax;
    ta.placeholder = 'What the files cannot show - a buff you know was up, a talent you changed halfway.';
    ta.value = st.note;
    const counted = (n) => (noteMax ? `${n} / ${noteMax}` : `${n}`);
    const count = el('div', 'xcount', counted(st.note.length));
    ta.addEventListener('input', () => { st.note = ta.value; count.textContent = counted(ta.value.length); });
    noteSec.append(ta, count, el('p', 'xhint', 'It goes in the zip as note.txt: with Send only the maintainer can read it, on '
      + 'the GitHub form route it is public. Do not put other people\'s names in it.'));
    main.append(noteSec);

    const keep = el('label', 'xcheck');
    const kb = el('input');
    kb.type = 'checkbox';
    kb.checked = st.keepName;
    kb.addEventListener('change', () => { st.keepName = kb.checked; });
    keep.append(kb, document.createTextNode(' Keep my character\'s name'));
    main.append(keep, el('p', 'xhint', 'Off, your character is "Submitter" in every file. The GitHub form\'s title names nobody '
      + 'either way.'));

    renderDrop();
    if (st.error) main.append(el('p', 'xmsg xerrline', st.error));
    if (st.ask) { renderAsk(); return; }
    const row = el('div', 'xbtnrow');
    const go = button('btn btn-tan xprimary', st.busy ? 'Packing…' : 'Preview', runPreview);
    go.disabled = st.busy || !!off;
    go.id = 'send-preview';
    row.append(go, button('btn btn-tan', 'Close', () => closeModal()));
    main.append(row);
  }

  // --- page 2: what Send does with the bundle, and the three ways on
  function renderReview() {
    const p = st.preview;
    const sec = (title) => {
      const s = el('section', 'xsec');
      s.append(el('h4', null, title));
      main.append(s);
      return s;
    };
    const fileList = () => {
      const ul = el('ul', 'xfiles');
      for (const f of p.files) {
        const li = el('li');
        li.append(el('code', null, f.name), el('span', null, bytesText(f.bytes)));
        ul.append(li);
      }
      return ul;
    };
    // The manual route's issue title, as the server wrote it: the GitHub
    // form opens with it filled in.
    const formTitle = () => {
      const box = el('div', 'xissue');
      box.append(el('div', 'xissue-title', p.title));
      return box;
    };

    // What stops Send: what `bench submit --send` refuses too (the module's
    // rule and sentence, which names the way out). Said first, as what it
    // is - the reason this bundle is not offered to Send.
    if (p.sendRefused) {
      const stop = el('div', 'xstop');
      stop.id = 'send-refused';
      stop.append(el('p', 'xmsg', /[.!?]$/.test(p.sendRefused) ? p.sendRefused : `${p.sendRefused}.`),
        el('p', 'xhint', 'Send is off for this bundle. Back changes the build, the class beside its file, or the log; '
          + 'Save .zip still saves the bundle as it is.'));
      main.append(stop);
    }
    // What the bench found on the way. A problem does not stop the bundle;
    // it is the player's to weigh before the bundle goes anywhere.
    if (p.problems?.length) {
      const warn = el('div', 'xwarn');
      warn.append(el('p', 'xmsg', p.problems.length === 1
        ? 'The bench found one problem. The bundle is made all the same - weigh it before you send or save it:'
        : `The bench found ${p.problems.length} problems. The bundle is made all the same - weigh them before you send or save it:`));
      const ul = el('ul');
      for (const pr of p.problems) ul.append(el('li', null, pr));
      warn.append(ul);
      main.append(warn);
    }
    if (p.upload) {
      // Send makes nothing public: the zip goes to a folder only the
      // maintainer reads, and that is the whole of it.
      const what = sec('What Send does');
      what.append(el('p', 'xhint', `The zip - ${p.zipName}, ${bytesText(p.zipBytes)} - goes to the project's folder on pCloud, `
        + 'where only the project\'s maintainer can read it. Nothing is made public.'), fileList());
    } else {
      const off = sec('Send is not available in this copy of the bench');
      off.append(el('p', 'xhint', `${p.uploadProblem ? `${ended(p.uploadProblem)} ` : 'No upload link is set. '}The route is Save .zip, `
        + 'then the GitHub form, which opens with this title filled in:'), formTitle());
      const pub = sec('What becomes public on that route: every file in the zip');
      pub.append(el('p', 'xhint', `The zip - ${p.zipName}, ${bytesText(p.zipBytes)} - is attached to a public issue, so anyone can `
        + 'download it, your note and the fight\'s start time to the millisecond included:'), fileList());
    }

    renderDrop();
    if (st.ask) renderAsk();
    else if (st.sent) renderSent();
    else renderActions(p);

    // The report `bench submit` prints, line for line, last: the sections
    // above are its first lines, laid out. Each line is marked by its kind.
    const rep = el('details', 'xreport');
    rep.open = true;
    rep.append(el('summary', null, `The bench's report - what bench submit prints (${reportOf(p).length} lines)`));
    rep.append(reportList(p));
    main.append(rep);
  }

  // Consent, then Send (with an upload link, and a bundle Send takes),
  // Save .zip, the GitHub form.
  function renderActions(p) {
    let sendB = null;
    const r = st.receipt;
    const canSend = p.upload && !p.sendRefused;
    if (canSend) {
      const lab = el('label', 'xcheck xconsent');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = 'send-consent';
      cb.checked = st.consent;
      cb.disabled = st.busy;
      lab.append(cb, document.createTextNode(' I understand the zip goes to the project\'s folder on pCloud, where only the '
        + 'maintainer can read it'));
      main.append(lab);
      cb.addEventListener('change', () => { st.consent = cb.checked; if (sendB) sendB.disabled = st.busy || !st.consent; });
    }
    if (st.status) main.append(el('p', 'xmsg xstatus', st.status));
    if (st.error) main.append(el('p', 'xmsg xerrline', st.error));
    if (r) {
      main.append(el('p', 'xhint', r.kept
        ? `The bench kept this send's receipt as ${r.kept} before sending: with it you can ask for the fight's deletion if it did `
          + 'arrive. Save receipt keeps a copy of your own.'
        : 'Save receipt keeps this send\'s receipt: with it you can ask for the fight\'s deletion if it did arrive.'));
    }
    const row = el('div', 'xbtnrow');
    if (canSend) {
      sendB = button('btn btn-tan xprimary', st.busy ? 'Sending…' : r || st.again || st.lost ? 'Send again' : 'Send', runSend);
      sendB.id = 'send-send';
      sendB.disabled = st.busy || !st.consent;
      row.append(sendB);
    }
    if (r) {
      const save = button('btn btn-tan', 'Save receipt', () => { saveReceipt(r); r.saved = true; });
      save.id = 'send-save-receipt';
      row.append(save);
    }
    const zipB = button('btn btn-tan', 'Save .zip', saveZip);
    const formB = button('btn btn-tan', 'Open the GitHub form', () => window.open(p.formUrl, '_blank', 'noopener,noreferrer'));
    const back = button('btn btn-tan', 'Back', goBack);
    for (const b of [zipB, formB, back]) b.disabled = st.busy;
    row.append(zipB, formB, back);
    main.append(row);
    main.append(el('p', 'xhint xroute', p.sendRefused
      ? 'Save .zip saves this bundle as it is. Attached to the GitHub form instead, every file in it would be public - and what '
        + 'stops Send above holds for that route as well.'
      : p.upload
        ? 'Save .zip, then Open the GitHub form, is the other route: you drag the .zip into the form yourself. That route makes your '
          + 'files public - anyone can download what is attached to a public issue, your note and the fight\'s start time included. '
          + 'Send makes nothing public: only the maintainer can read the zip.'
        : 'Save the .zip first, then open the form and drag the .zip into its box (a GitHub account is needed). This route makes your '
          + 'files public - anyone can download what is attached to a public issue. Send, in a copy of the bench that has an upload '
          + 'link, makes nothing public: only the maintainer can read the zip.'));
  }

  // After a send pCloud confirmed: where it is, and the receipt to keep.
  function renderSent() {
    const s = st.sent;
    const r = st.receipt;
    const box = el('div', 'xsent');
    if (st.error) box.append(el('p', 'xmsg xerrline', st.error));
    box.append(el('p', 'xmsg', `Sent. Submission ${short(s.id)} is in the project's pCloud folder; only the maintainer can read it. `
      + 'Save the receipt: it is how you ask for this fight\'s deletion later ("Delete a submission I sent…" below, or bench submit '
      + '--delete). Anyone holding it can ask for that, and do nothing else with it.'));
    if (r?.kept) {
      box.append(el('p', 'xhint', `The bench keeps a copy as ${r.kept}, listed below - but in its cache folder, which is not a place `
        + 'to keep it.'));
    }
    const row = el('div', 'xbtnrow');
    const save = button('btn btn-tan xprimary', 'Save receipt', () => { saveReceipt(r); r.saved = true; });
    save.id = 'send-save-receipt';
    row.append(save, button('btn btn-tan', 'Close', () => closeModal()));
    box.append(row);
    main.append(box);
  }

  // --- leaving a submission: never without a word

  // Closing with a receipt not saved (beforeClose) - or with none held yet,
  // after a send the bench itself stopped answering (`lost`).
  function askUnsaved() {
    const r = st.receipt;
    if (!r) {
      st.ask = {
        text: `Submission ${short(st.preview?.id)} may have reached the project's folder: the bench stopped answering while it was being `
          + 'sent. It kept the receipt before sending, in its receipts folder, and lists it at the bottom of this dialog once it answers '
          + 'again - with Save, and Delete… to ask for the fight\'s deletion.',
        buttons: [
          ['Stay', () => { st.ask = null; render(); loadKept(); }, true],
          ['Close all the same', () => { st.ask = null; closeModal({ force: true }); }],
        ],
      };
      render();
      return;
    }
    const copy = r.kept ? ` The bench keeps a copy as ${r.kept}, listed at the bottom of this dialog - but that is its cache `
      + 'folder, not a place to keep it.' : '';
    st.ask = {
      text: (st.sent
        ? (r.savedPending
          ? `The receipt of submission ${short(st.sent.id)} you saved was written before pCloud answered, and says the send may not `
            + 'have arrived: sent again with it, the fight would be stored twice. Save this one, completed - it is how you ask for this '
            + 'fight\'s deletion later.'
          : `You have not saved the receipt of submission ${short(st.sent.id)}. It is how you ask for this fight's deletion later.`)
        : `Submission ${short(r.receipt.id)} may have reached the project's folder - its send was not answered - and you have not `
          + 'saved its receipt, with which you can ask for its deletion if it did arrive.') + copy,
      buttons: [
        ['Save receipt, then close', () => { saveReceipt(r); r.saved = true; st.ask = null; closeModal({ force: true }); }, true],
        ['Close without saving', () => { st.ask = null; closeModal({ force: true }); }],
      ],
    };
    render();
  }

  // Back to the choices. After a send that was not answered that is a new
  // submission, so the one sent has its deletion asked for first - and
  // after one the bench itself stopped answering, its receipt is found
  // first: it is what asks.
  function goBack() {
    const r = st.receipt;
    if (!r && st.lost && !st.sent) {
      st.ask = {
        text: `Submission ${short(st.preview?.id)} may have reached the project's folder: the bench stopped answering while it was being `
          + 'sent. A bundle made from here is a new submission, so if this one did arrive the folder would hold the fight twice. Its '
          + 'receipt, kept before sending, is held here once the bench answers again: then send this one again, or ask for its deletion '
          + 'first.',
        buttons: [
          ['Look for its receipt again', () => { st.ask = null; render(); loadKept(); }, true],
          ['Stay', () => { st.ask = null; render(); }],
        ],
      };
      render();
      return;
    }
    if (r && !st.sent) {
      st.ask = {
        text: `Submission ${short(r.receipt.id)} may have reached the project's folder: its send was not answered. A bundle made `
          + 'from here is a new submission, so if this one did arrive the folder would hold the fight twice. Send this one again - '
          + 'if the first did arrive, that stores at most a duplicate the maintainer drops - or ask for its deletion first: the '
          + 'request goes to the same folder, and the maintainer deletes the fight if it arrived.',
        buttons: [['Ask for its deletion, then go back', askDeletionThenBack, true], ['Stay', () => { st.ask = null; render(); }]],
      };
      render();
      return;
    }
    st.page = 'compose';
    st.error = null;
    st.status = null;
    st.drop = null;
    render();
  }

  // This dialog's submission is done with (its deletion asked for): nothing
  // is pending, and the next Preview makes a new one.
  function clearSubmission() {
    st.receipt = null;
    st.sent = null;
    st.lost = false;
    st.preview = null;
    st.consent = false;
    st.ask = null;
    st.again = null;
    st.error = null;
    st.page = 'compose';
  }

  async function askDeletionThenBack() {
    if (st.busy || !st.receipt) return;
    const r = st.receipt;
    st.busy = true;
    render();
    try {
      const d = await post('/api/submit/delete', { receipt: r.receiptText });
      clearSubmission();
      st.status = `Asked: the project's folder holds a request to delete submission ${short(d.id)}; the maintainer deletes the `
        + 'fight if it arrived. A new Preview makes a new submission.';
    } catch (e) {
      st.ask = null;
      st.error = e.message;
    } finally {
      st.busy = false;
      render();
      loadKept();
    }
  }

  // --- files dropped on the dialog (see the header)
  function takeDrop(files) {
    if (!files.length) return;
    const what = files.length === 1 ? files[0].name : `${files.length} files`;
    const were = files.length === 1 ? 'was' : 'were';
    const held = st.receipt?.receipt.id ?? (st.lost ? st.preview?.id : null);
    if (st.busy || held || st.sent) {
      st.drop = {
        bad: true,
        text: st.busy ? `${what} ${were} not taken: the dialog is busy - drop ${files.length === 1 ? 'it' : 'them'} again in a moment.`
          : st.sent ? `${what} ${were} not taken: this dialog's fight is sent. Close it and open Send a fight again for another one.`
            : `${what} ${were} not taken: this dialog holds submission ${short(held)}, whose send was not answered `
              + 'and may have arrived. Send it again, or ask for its deletion first (Back) to send other files.',
      };
      render();
      return;
    }
    const lone = files.length === 1 && /\.json$/i.test(files[0].name) ? files[0] : null;
    const before = { sheetFrom: st.sheetFrom, sheetFile: st.sheetFile, logs: st.logs };
    const asSheet = () => {
      st.logs = before.logs;
      setSheet(lone);
      st.drop = { text: `${lone.name} is the character sheet now.` };
      render();
    };
    const asLog = () => {
      st.sheetFrom = before.sheetFrom;
      st.sheetFile = before.sheetFile;
      st.logs = assignLogs(files);
      st.drop = { text: `${lone.name} is the fight's combat log now.` };
      render();
    };
    if (lone && st.sheetFrom === 'file' && !st.sheetFile) {
      setSheet(lone);
      st.drop = { text: `${lone.name} was taken as the character sheet.`, swap: ['It is the combat log', asLog] };
    } else {
      st.logs = assignLogs(files);
      st.drop = st.logs.error ? null : {
        text: `${what} ${were} taken as the fight's ${st.logs.summary ? 'combat log and its summary' : 'combat log'}.`,
        swap: lone ? ['It is the character sheet', asSheet] : null,
      };
    }
    st.page = 'compose';
    st.preview = null;
    st.error = null;
    render();
  }

  // --- the server

  async function runPreview() {
    if (st.busy || caps().off) return;
    st.error = null;
    if (st.sheetFrom === 'file' && !st.sheetFile) { st.error = 'Choose a character sheet file, or use the build in the editor.'; render(); return; }
    if (!st.logs.log) { st.error = st.logs.error ?? 'Choose the fight\'s combat log first.'; render(); return; }
    const sheetMax = capOf('sheetMaxBytes');
    if (st.sheetFrom === 'file' && sheetMax && st.sheetFile.size > sheetMax) {
      st.error = `${st.sheetFile.name} is ${sizeText(st.sheetFile.size)}, and a character sheet may be at most ${capText(sheetMax)} - this is likely not one.`;
      render();
      return;
    }
    const logMax = capOf('logMaxBytes');
    for (const f of [st.logs.log, st.logs.summary].filter(Boolean)) {
      if (logMax && f.size > logMax) {
        st.error = `${f.name} is ${mb(f.size)}, and a submission takes at most ${capText(logMax)} per log - send one fight per log.`;
        render();
        return;
      }
    }
    st.busy = true;
    render();
    try {
      const body = { keepName: st.keepName };
      if (st.sheetFrom === 'editor') {
        body.sheet = { editor: editorBuild() };
      } else {
        body.sheet = { file: { name: st.sheetFile.name, base64: await readBase64(st.sheetFile) } };
        if (st.askClass) body.sheetOptions = { class: st.cls, level: st.level };
        else if (st.fileCls) body.sheetOptions = { class: st.fileCls };
      }
      body.log = { name: st.logs.log.name, base64: await readBase64(st.logs.log), mtimeMs: st.logs.log.lastModified };
      if (st.logs.summary) body.summary = { name: st.logs.summary.name, base64: await readBase64(st.logs.summary) };
      if (st.note.trim()) body.note = st.note;
      if (st.again) body.again = st.again.receiptText;
      const p = await post('/api/submit/preview', body);
      st.preview = p;
      st.body = body;
      st.consent = false;
      st.status = null;
      st.drop = null;
      st.page = 'review';
    } catch (e) {
      // The reader's class question: asked on the first page, the log's class
      // (or the first the dump's weapons fit) chosen to start with.
      if (e.needs === 'class') {
        st.askClass = e.data ?? {};
        st.cls = firstClass(st.askClass);
      } else {
        st.error = e.message;
      }
    } finally {
      st.busy = false;
      render();
      m.body.scrollTop = 0;
    }
  }

  // Save .zip. After a send that was not answered, the bench may have let
  // go of the bundle (30 minutes after the last try, or a restart): it is
  // built again from its receipt as the same submission, as Send again does
  // (rebuild), and saved when it is the bundle shown - the manual route is a
  // way on from such a send too, and the review page has no Preview.
  async function saveZip() {
    if (st.busy) return;
    st.error = null;
    try {
      let z;
      try {
        z = await post('/api/submit/bundle', { previewId: st.preview.previewId });
      } catch (e) {
        if (e.status !== 404 || st.sent) throw e;
        st.busy = true;
        render();
        let same = false;
        try {
          if (!st.receipt && st.lost) await loadKept();
          if (!st.receipt || st.sent) throw e;
          same = await rebuild();
        } finally {
          st.busy = false;
        }
        render();
        // Not the bundle shown before (an older receipt, which names no
        // SHA-256): it is shown, and read, before it is saved.
        if (!same) return;
        z = await post('/api/submit/bundle', { previewId: st.preview.previewId });
      }
      saveBlob(z.name, base64Blob(z.base64, 'application/zip'));
    } catch (e) {
      st.error = e.message;
      render();
    }
  }

  // The receipt an answer carries becomes this dialog's; saved stays saved
  // while it is the same submission's (a receipt kept before the send still
  // asks for its deletion once it is answered) - unless the copy saved was
  // the pending one and this one is completed: that copy says the send may
  // not have arrived, and sent again with it (--receipt, Send again…) the
  // fight would be stored twice, so Close asks to save this one.
  function holdReceipt(d) {
    const was = st.receipt;
    const same = was?.receipt.id === d.receipt.id;
    const completed = same && !was.receipt.sentAt && !!d.receipt.sentAt;
    st.receipt = {
      receipt: d.receipt, receiptText: d.receiptText, receiptName: d.receiptName, kept: d.kept ?? null,
      saved: same && was.saved && !completed,
      savedPending: same && (completed ? was.saved : was.savedPending === true),
    };
    // A receipt held settles a send the bench stopped answering.
    st.lost = false;
  }

  // The bench let go of a bundle whose send was not answered (30 minutes
  // after the last try, or a restart): the same body again, with its
  // receipt as `again`, is the same submission - the same id, token and
  // time. The server holds it to the receipt's SHA-256; for an older receipt
  // that names none, the same title and size are what say it is the same,
  // which this answers. "Send again sends it" only of a bundle Send takes:
  // the bench may have come back with no upload link, or another one, and
  // the rebuilt preview then says Send is off for it, and why.
  async function rebuild() {
    const before = st.preview;
    const id = short(st.receipt.receipt.id);
    const p = await post('/api/submit/preview', { ...st.body, again: st.receipt.receiptText });
    st.preview = p;
    const same = p.title === before.title && p.zipBytes === before.zipBytes;
    if (!same) st.consent = false;
    const off = !p.upload || p.sendRefused
      ? `Send is off for it, though: ${p.sendRefused ? ended(p.sendRefused)
        : p.uploadProblem ? ended(p.uploadProblem) : 'this copy of the bench has no upload link now.'}`
      : null;
    st.status = same
      ? `The bench no longer held this bundle (it keeps one 30 minutes after a send that was not answered, and none across a `
        + `restart), so it built it again from the same files as the same submission ${id}: the same id, delete token and bytes. `
        + (off ?? 'Send again sends it.')
      : `The bench no longer held this bundle, so it built it again as the same submission ${id} - the same id and delete token - `
        + 'but it is not the bundle shown before: the files or the bench changed since. '
        + (off ? `Read it again. ${off}` : 'Read it again, and tick the box to send it.');
    return same;
  }

  async function runSend() {
    if (st.busy || !st.consent || !st.preview?.upload || st.preview?.sendRefused) return;
    st.busy = true;
    st.error = null;
    st.drop = null;
    const wait = waitText();
    st.status = `Sending to the project's pCloud folder - the dialog stays open until pCloud answers${wait ? ` (${wait} at most)` : ''}…`;
    m.locked = true;
    render();
    try {
      let r;
      try {
        r = await post('/api/submit/send', { previewId: st.preview.previewId, consent: true });
      } catch (e) {
        // The bench let go of the bundle (see rebuild): built again from its
        // receipt - found first among the kept ones after a send the bench
        // stopped answering, which may say it arrived after all.
        if (e.status === 404 && !st.sent) {
          if (!st.receipt && st.lost) await loadKept();
          if (st.sent) return;
          if (st.receipt) { await rebuild(); return; }
        }
        throw e;
      }
      holdReceipt(r);
      st.sent = { ...r.sent };
      st.status = null;
    } catch (e) {
      st.status = null;
      if (e.status === undefined) {
        // No answer at all: the request reached the bench, or did not, and
        // the bench stopped answering (stopped, or crashed, while it waited
        // for pCloud). It may have left; the bench keeps its receipt from
        // before it did, and the dialog holds it once the bench answers
        // again (loadKept) - until then Back and Close ask, as after a send
        // that was not answered.
        st.lost = !st.receipt;
        st.error = `The bench did not answer (${e.message}), so whether this send reached the project's folder is not known here. `
          + 'The bench kept its receipt before sending: the dialog holds it, and lists it at the bottom, once the bench answers '
          + 'again - then Send again sends the same bundle, or ask for its deletion.';
        return;
      }
      // A refusal pCloud sent (`arrived: false`: the link closed, the folder
      // full, this address turned away): nothing of this send was kept, it
      // needs no deletion, and a receipt held from an earlier send of the
      // bundle still stands.
      st.error = e.data?.arrived === false && !/nothing was (?:kept|sent)/i.test(e.message)
        ? `${e.message} Nothing of this send was kept.` : e.message;
      if (e.data?.receipt) {
        holdReceipt(e.data);
        // Sent already (an answer that was lost on its way here): the first
        // send's receipt came back with the refusal.
        if (e.status === 409 && e.data.receipt.sentAt) {
          const f = e.data.receipt;
          st.sent = { id: f.id, uploadedAs: `${f.id}.zip`, sentAt: f.sentAt, zipSha256: f.zipSha256 };
        }
      }
    } finally {
      st.busy = false;
      m.locked = false;
      render();
      loadKept();
    }
  }

  // --- the bottom: the receipts the bench keeps, and asking for a fight's deletion

  // The list, asked again until the bench answers while a send it stopped
  // answering is held (`lost`): that send's receipt is in it.
  let keptRetry = null;
  async function loadKept() {
    if (caps().off || modal !== m) return;
    clearTimeout(keptRetry);
    let answered = true;
    try {
      st.kept = await post('/api/submit/receipts', {});
    } catch (e) {
      st.kept = { receipts: [], problem: e.message };
      answered = e.status !== undefined;
    }
    if (modal !== m) return;
    let found = false;
    if (st.lost && !st.receipt) {
      if (answered && !st.kept.problem) { findLost(); found = true; } else if (!answered) keptRetry = setTimeout(loadKept, 5000);
    }
    // Not under the player's typing: the page itself is drawn again only
    // when nothing in it has the focus - or when what it shows changed.
    if (!found && main.contains(document.activeElement)) renderFoot();
    else render();
  }

  // A send the bench stopped answering, settled from the receipts it keeps
  // once it answers again: the one of this preview's id is held (as
  // completed, when pCloud's answer reached the bench and not the page), or
  // none is kept - the send never left, or pCloud turned it away, and
  // nothing of it was kept.
  function findLost() {
    const id = st.preview?.id;
    const x = id ? (st.kept?.receipts ?? []).find((k) => k.receipt.id === id) : null;
    st.lost = false;
    st.error = null;
    if (!x) {
      st.status = `The bench answers again, and keeps no receipt of submission ${short(id)}: its send never left, or pCloud turned it `
        + 'away - nothing of it was kept.';
      return;
    }
    holdReceipt(x);
    if (x.receipt.sentAt) {
      st.sent = { id: x.receipt.id, uploadedAs: `${x.receipt.id}.zip`, sentAt: x.receipt.sentAt, zipSha256: x.receipt.zipSha256 };
      st.status = null;
    } else {
      st.status = `The bench answers again, and keeps the receipt of submission ${short(id)} it saved before sending, with no answer from `
        + 'pCloud: the fight may or may not have arrived. Send again sends the same bundle; Back asks for its deletion first.';
    }
  }

  function renderFoot() {
    foot.replaceChildren();
    // Asking for a deletion is a submit route too, refused on such a bind (see renderCompose).
    if (caps().off) return;
    // While the dialog is busy - a send on its way above all - nothing here
    // asks for a deletion: asked for the very submission being sent, the
    // send's answer would bring its receipt back as sent (the server refuses
    // that too, 409).
    const del = button('xlink', 'Delete a submission I sent…', () => { receiptInput.value = ''; receiptInput.click(); });
    del.id = 'send-delete';
    del.disabled = st.busy;
    foot.append(del);
    const k = st.kept;
    if (k?.problem) foot.append(el('p', 'xfootmsg xerrline', `The receipts the bench keeps could not be listed: ${k.problem}.`));
    if (k?.receipts?.length) {
      const box = el('div', 'xkept');
      box.append(el('p', 'xhint', `Receipts this bench keeps, in ${k.folder} - its cache folder, so save your own as well:`));
      const ul = el('ul', 'xkeptlist');
      for (const x of k.receipts) {
        const r = x.receipt;
        const li = el('li');
        li.append(el('span', 'xkeptwhat', r.sentAt
          ? `Submission ${short(r.id)}, sent ${whenText(r.sentAt)}`
          : `Submission ${short(r.id)}, made ${whenText(r.createdAt)} - its send was not answered`));
        const acts = el('span', 'xkeptacts');
        acts.append(button('xlink', 'Save', () => {
          saveReceipt(x);
          // (A pending copy saved is not the completed receipt the dialog holds: see holdReceipt.)
          if (st.receipt?.receipt.id === r.id && (r.sentAt || !st.receipt.receipt.sentAt)) st.receipt.saved = true;
        }));
        if (!r.sentAt && st.page === 'compose' && !st.receipt && !st.sent && st.again?.receipt.id !== r.id) {
          acts.append(button('xlink', 'Send again…', () => {
            st.again = { receipt: r, receiptText: x.receiptText };
            st.error = null;
            render();
            m.body.scrollTop = 0;
          }));
        }
        const askB = button('xlink', 'Delete…', () => askDelete(r, x.receiptText));
        askB.disabled = st.busy;
        acts.append(askB);
        li.append(acts);
        ul.append(li);
      }
      box.append(ul);
      if (k.unreadable?.length) box.append(el('p', 'xhint', `Not read as receipts there: ${k.unreadable.join(', ')}.`));
      foot.append(box);
    }
    if (st.delAsk) {
      const q = el('div', 'xconfirm');
      q.append(el('p', 'xmsg', st.delAsk.text));
      const row = el('div', 'xbtnrow');
      const yes = button('btn btn-tan xprimary', st.delAsk.busy ? 'Asking…' : 'Ask for its deletion', runDelete);
      yes.id = 'send-delete-confirm';
      yes.disabled = !!st.delAsk.busy || st.busy;
      const no = button('btn btn-tan', 'Cancel', () => { st.delAsk = null; renderFoot(); });
      no.disabled = st.busy;
      row.append(yes, no);
      q.append(row);
      foot.append(q);
    }
    if (st.delMsg) foot.append(el('p', `xfootmsg ${st.delMsg.kind}`, st.delMsg.text));
  }

  // The question before a request for a deletion: what it is - an upload to
  // the project's folder, carried out by the maintainer later - and which
  // submission it names. Never an address: the server asks through this
  // copy's own link only, and refuses a receipt of another with its own
  // sentence, shown as it is. `r` is what the receipt says it is (from the
  // list, or a picked file read as JSON - the server judges it), and
  // `fileName` the picked file's name.
  function askDelete(r, text, fileName = null) {
    const id = typeof r?.id === 'string' ? short(r.id) : null;
    const lead = !fileName ? ''
      : id ? `${fileName} is the receipt of submission ${id}${r.sentAt ? `, sent ${whenText(r.sentAt)}` : ', whose send was not answered'}. `
        : `${fileName} does not read as a receipt here - asked with it, the bench says what is wrong with it. `;
    st.delAsk = {
      text: lead + (id
        ? `This uploads a request to delete submission ${id} to the project's pCloud folder; the maintainer deletes the fight and `
          + 'the request when they next read it.'
        : 'A receipt uploads a request to delete its submission to the project\'s pCloud folder; the maintainer deletes the fight '
          + 'and the request when they next read it.'),
      receiptText: text,
      busy: false,
    };
    st.delMsg = null;
    renderFoot();
  }

  async function runDelete() {
    const a = st.delAsk;
    if (!a || a.busy || st.busy) return;
    // The whole dialog waits with it: a send started meanwhile would race
    // the request for the very receipt it forgets.
    a.busy = true;
    st.busy = true;
    render();
    try {
      const d = await post('/api/submit/delete', { receipt: a.receiptText });
      st.delMsg = {
        kind: 'xokline',
        text: `Asked: the project's folder holds a request to delete submission ${short(d.id)}.`
          + `${d.forgotten ? ' The bench no longer keeps its receipt.' : ''}`,
      };
      deletionAsked(d.id);
    } catch (e) {
      st.delMsg = { kind: 'xerrline', text: e.message };
    } finally {
      st.delAsk = null;
      st.busy = false;
      render();
      loadKept();
    }
  }

  // A submission whose deletion was asked for from the list: when it is this
  // dialog's own, the one it was building again, or the one whose bundle is
  // on screen (a preview built again from its receipt, or one whose send the
  // bench stopped answering), nothing of it is pending any more - and that
  // preview goes, so no Send puts a withdrawn id back in the folder.
  function deletionAsked(id) {
    if (!id) return;
    if (st.receipt?.receipt.id === id || st.preview?.id === id) {
      clearSubmission();
      st.status = `Asked: the project's folder holds a request to delete submission ${short(id)}. A new Preview makes a new submission.`;
    }
    if (st.again?.receipt.id === id) st.again = null;
  }

  receiptInput.addEventListener('change', async () => {
    const f = receiptInput.files?.[0];
    if (!f) return;
    let text;
    try {
      text = await f.text();
    } catch (e) {
      st.delAsk = null;
      st.delMsg = { kind: 'xerrline', text: `${f.name} could not be read: ${e.message}` };
      renderFoot();
      return;
    }
    // What the file says it is, for the question - the server judges it.
    let r = null;
    try { r = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { r = null; }
    askDelete(r, text, f.name);
  });

  render();
  loadKept();
}

sendBtn.addEventListener('click', openSendDialog);

document.addEventListener('keydown', (e) => {
  // An Esc the picker already spent closing itself (its listener runs first
  // and calls preventDefault): the panel closes on the next one, not this.
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (modal) { e.preventDefault(); closeModal(); return; }
  if (panel && !document.querySelector('.modal-veil:not(.xveil)')) { e.preventDefault(); closePanel(); }
});

// ------------------------------------------------------------- drag & drop

let dragDepth = 0;
const dropVeil = el('div', 'xdrop');
dropVeil.hidden = true;
dropVeil.append(el('div', 'xdrop-msg', 'Drop a character sheet, a saved build or a modkit dump (.json) to import it'));
document.body.append(dropVeil);

const carriesFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
const inTextField = (t) => !!t?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]');

// Where dropped files go right now: to the open exchange modal that takes
// them ('modal'), to nobody while any other dialog is up ('shut' - see the
// header), or to Import.
function dropTarget() {
  if (modal) return modal.onDrop ? 'modal' : 'shut';
  if (document.querySelector('.modal-veil')) return 'shut';
  return 'import';
}

// A drop that reached a dialog that takes none. In this file's modal the
// sentence goes above its buttons (one at a time); over the picker, whose DOM
// is not this file's, it is a toast.
function refuseDrop(list) {
  const what = list.length === 1 ? list[0].name : `${list.length} files`;
  const text = `${what} was not imported: a dialog is open, and nothing is imported behind it - `
    + 'close it, then drop the file again';
  if (!modal) { App.toast(text, true); return; }
  modal.body.querySelector(':scope > .xdropnote')?.remove();
  const note = el('p', 'xmsg xdropnote', text);
  const row = modal.body.querySelector(':scope > .xbtnrow');
  modal.body.insertBefore(note, row);
}

document.addEventListener('dragenter', (e) => {
  if (!carriesFiles(e)) return;
  dragDepth++;
  if (dropTarget() === 'import') dropVeil.hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (!carriesFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropVeil.hidden = true;
});
// Cancelling every dragover is what keeps the drop from the browser: a drag
// whose dragover is not cancelled is the browser's, and for a file or a link
// that means navigating the window to it. A file is accepted as a copy when
// something will take it; anything else is refused (dropEffect none) unless
// it is text over a field.
document.addEventListener('dragover', (e) => {
  const files = carriesFiles(e);
  if (!files && inTextField(e.target)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = files && dropTarget() !== 'shut' ? 'copy' : 'none';
});
document.addEventListener('drop', (e) => {
  const files = carriesFiles(e);
  if (!files && inTextField(e.target)) return;
  e.preventDefault();
  dragDepth = 0;
  dropVeil.hidden = true;
  if (!files) return;
  const list = Array.from(e.dataTransfer.files ?? []);
  const to = dropTarget();
  if (to === 'modal') { modal.onDrop(list); return; }
  if (!list.length) return;
  if (to === 'shut') { refuseDrop(list); return; }
  if (list.length > 1) {
    showError(`${list.length} files`, `${list.length} files were dropped - Import reads one character file at a time`);
    return;
  }
  importFile(list[0]);
});
