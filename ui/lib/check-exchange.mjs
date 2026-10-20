#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-exchange.mjs - self-test for the Send a fight dialog's own steps.
//
// ui/lib/check-api.mjs holds the server's /api/submit/* routes; what the
// dialog does with their answers is ui/web/components/exchange.js's, and
// several of its rules live in the page alone. This drives that file under a
// small stand-in DOM - elements, text, clicks, nothing laid out - with
// /api/submit/* answered by a stand-in in this process: no server, no game
// data, no network (fetch is the stand-in's). Each block is one rule the
// page keeps:
//
//   - asking, from the list at the bottom, for the deletion of the
//     submission whose bundle is on screen takes that bundle off it: no
//     Send puts a withdrawn id back in the folder;
//   - while a send is on its way the delete links are off;
//   - a send the bench itself stopped answering (its server stopped while
//     it waited) is one not answered: Back and Close ask, and once the bench
//     answers again the dialog holds the receipt it kept, by the preview's
//     id, and Send again builds the bundle again on a 404;
//   - Save .zip of a bundle the bench let go of after a send not answered
//     builds it again from its receipt, then saves it; and the status says
//     Send again sends it only of a rebuilt preview Send takes;
//   - a receipt saved while its send was not answered is not the completed
//     one: once the send is answered, Close asks to save that one.
//
// Runs standalone: node ui/lib/check-exchange.mjs [<exchange.js>]. The
// suite runs it too.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const target = process.argv[2] ?? join(ROOT, 'ui', 'web', 'components', 'exchange.js');
const source = readFileSync(target, 'utf8');
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  (${detail})`}`);
  if (!cond) failures++;
};

// --- the stand-in DOM ------------------------------------------------------
// An element as exchange.js uses one: children and text, attributes,
// listeners, and a click - none on a disabled button, as in a browser; an
// anchor's click is the download it starts (`saved`, by its file name).
let saved = [];
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parent = null; this.listeners = {}; this.attrs = {};
    this.hidden = false; this.disabled = false; this._text = ''; this.className = ''; this.id = '';
    this.value = ''; this.checked = false; this.files = null; this.style = {}; this.scrollTop = 0;
  }
  get textContent() { return this.tagName === '#TEXT' ? this._text : this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(t) { this._text = String(t); this.children = []; }
  append(...ns) {
    for (const n of ns) {
      const x = typeof n === 'string' ? doc.createTextNode(n) : n;
      x.remove();
      x.parent = this;
      this.children.push(x);
    }
  }
  replaceChildren(...ns) { for (const c of this.children) c.parent = null; this.children = []; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  insertBefore(n, ref) { n.remove(); n.parent = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener() {}
  dispatch(t, extra = {}) {
    const e = { type: t, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners[t] ?? []) fn(e);
    return e;
  }
  click() {
    if (this.disabled) return null;
    if (this.tagName === 'A' && this.download) saved.push(this.download);
    return this.dispatch('click');
  }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  querySelector() { return null; }
  scrollIntoView() {}
  focus() {}
  closest() { return null; }
}
// A document holding the band's three buttons, which exchange.js looks up
// when it loads.
let doc;
function freshDocument() {
  const fixed = {};
  doc = {
    body: new FakeNode('body'),
    activeElement: null,
    listeners: {},
    createElement: (t) => new FakeNode(t),
    createTextNode: (s) => { const n = new FakeNode('#text'); n._text = String(s); return n; },
    getElementById: (id) => fixed[id] ?? null,
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    querySelector: () => null,
  };
  for (const id of ['import-btn', 'send-btn', 'optimize-btn']) { fixed[id] = new FakeNode('button'); fixed[id].id = id; }
  fixed['optimize-btn'].textContent = 'Optimize';
  globalThis.document = doc;
  return fixed;
}
// What a player sees: a button by its label, an element by its id, the
// page's text.
const walk = (n, out = []) => { out.push(n); for (const c of n.children) walk(c, out); return out; };
const buttons = () => walk(doc.body).filter((n) => n.tagName === 'BUTTON');
const button = (label) => buttons().find((b) => b.textContent === label) ?? null;
const byId = (id) => walk(doc.body).find((n) => n.id === id) ?? null;
const shown = () => doc.body.textContent;
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2)); };

// What the module asks of the window besides: the App surface (set per
// scenario), FileReader for a picked file's base64, open() for the form.
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.FileReader = class {
  readAsDataURL(f) { this.result = `data:application/octet-stream;base64,${Buffer.from(f.data).toString('base64')}`; setTimeout(() => this.onload?.(), 0); }
};
globalThis.open = () => null;
const fakeFile = (name, data) => ({ name, size: data.length, lastModified: 1792324809200, data, text: async () => data });

// --- the stand-in for the bench's /api/submit/* -------------------------------
const X = 'ab'.repeat(16);
const LINK = 'http://127.0.0.1:9/#/puplink?code=TestCode1234';
const receiptOf = (sentAt = null) => ({ id: X, deleteToken: 'cd'.repeat(16), link: LINK, sentAt, createdAt: '2026-10-20T10:00:00.000Z', zipSha256: 'f'.repeat(64) });
const fields = (r) => ({ receipt: r, receiptText: JSON.stringify(r), receiptName: `farever-bench-receipt-${X.slice(0, 8)}.json`, kept: `/cache/submit-receipts/farever-bench-receipt-${X}.json` });
let previewN = 0;
const previewOf = (extra = {}) => ({
  previewId: String(++previewN).padStart(32, '0'), id: X, expiresAt: '2026-10-20T11:00:00.000Z', upload: true, uploadProblem: null, sendRefused: null,
  logClass: 'Warrior', title: `Data submission: Warrior 25 vs Dummy, Normal (${X.slice(0, 8)})`, files: [{ name: 'manifest.json', bytes: 10 }],
  zipName: `farever-bench-submission-${X.slice(0, 8)}.zip`, zipBytes: 100, formUrl: 'https://github.com/Blaakan/farever-bench/issues/new',
  report: ['What Send does: ...'], reportItems: [{ kind: 'private', text: 'What Send does: ...' }], problems: [], ...extra,
});
// The routes the dialog calls, answered per scenario (`routes`): an answer
// is {status, data}, or 'down' - no answer at all, the fetch rejecting as a
// browser's does when the server stopped. `calls` is what was asked.
let routes = {};
const calls = [];
globalThis.fetch = async (path, opts) => {
  const body = opts?.body ? JSON.parse(opts.body) : null;
  calls.push({ path, body });
  const route = routes[path];
  if (!route) throw new Error(`no stand-in route for ${path}`);
  const a = await route(body);
  if (a === 'down') throw new TypeError('Failed to fetch');
  return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.data };
};
const ok200 = (data) => ({ status: 200, data });
const keptList = (...receipts) => ok200({ folder: '/cache/submit-receipts', receipts: receipts.map((r) => ({ file: `/cache/${r.id}.json`, ...fields(r) })), unreadable: [], problem: null, upload: true, uploadProblem: null });

// --- one scenario: a fresh document, a fresh copy of the module ----------------
let instance = 0;
async function openDialog() {
  const fixed = freshDocument();
  saved = [];
  calls.length = 0;
  previewN = 0;
  globalThis.App = {
    state: { cls: 'Warrior', level: 25, name: '', loadout: { gear: {} }, options: { rank: 3 },
      pins: { gear: new Set(), augments: new Set(), skills: new Set(), runes: new Set(), talents: false, infusions: new Set() } },
    boot: { submit: { sheetMaxBytes: 512 * 1024, logMaxBytes: 20 * 1024 * 1024, noteMax: 2000, sendTimeoutMs: 600000, off: null }, classes: [] },
    toast() {},
  };
  // A fresh copy of the module each time (its own dialog, its own listeners),
  // from its source: a data: URL, told apart by a comment.
  const copy = [source, `// scenario ${++instance}`, ''].join('\n');
  await import(`data:text/javascript;base64,${Buffer.from(copy).toString('base64')}`);
  fixed['send-btn'].click();
  await flush();
}
async function chooseLog() {
  const input = byId('send-log-files');
  input.files = [fakeFile('combat-log.jsonl', '{"format":"farever-combat-log"}\n')];
  input.dispatch('change');
  await flush();
}
async function previewIt() { button('Preview')?.click(); await flush(12); }
async function consent() { const cb = byId('send-consent'); if (cb) { cb.checked = true; cb.dispatch('change'); } await flush(1); }
const esc = async () => { for (const fn of doc.listeners.keydown ?? []) fn({ key: 'Escape', defaultPrevented: false, preventDefault() {} }); await flush(); };

// THE BUNDLE ON SCREEN, its deletion asked from the list: it goes.
{
  routes = {
    '/api/submit/receipts': async () => keptList(receiptOf()),
    '/api/submit/preview': async () => ok200(previewOf()),
    '/api/submit/delete': async () => { routes['/api/submit/receipts'] = async () => keptList(); return ok200({ ok: true, requested: true, id: X, forgotten: true }); },
  };
  await openDialog();
  button('Send again…')?.click();
  await flush();
  await chooseLog();
  await previewIt();
  const onReview = !!button('Send again');
  button('Delete…')?.click();
  await flush();
  button('Ask for its deletion')?.click();
  await flush(12);
  check('dialog: the rebuilt bundle is on screen with Send again, then its deletion is asked from the list: the preview goes, no Send is offered',
    onReview && !button('Send') && !button('Send again') && !!button('Preview')
      && shown().includes(`Asked: the project's folder holds a request to delete submission ${X.slice(0, 8)}. A new Preview makes a new submission.`),
    `onReview ${onReview}; buttons ${buttons().map((b) => b.textContent).join('|')}`);
}

// A SEND ON ITS WAY: the delete links are off.
{
  let releaseSend = null;
  routes = {
    '/api/submit/receipts': async () => keptList(receiptOf()),
    '/api/submit/preview': async () => ok200(previewOf()),
    '/api/submit/send': () => new Promise((resolve) => { releaseSend = () => resolve(ok200({ sent: { id: X, uploadedAs: `${X}.zip`, sentAt: '2026-10-20T10:05:00.000Z', zipSha256: 'f'.repeat(64) }, ...fields(receiptOf('2026-10-20T10:05:00.000Z')) })); }),
    '/api/submit/delete': async () => ok200({ ok: true, requested: true, id: X, forgotten: true }),
  };
  await openDialog();
  button('Send again…')?.click();
  await flush();
  await chooseLog();
  await previewIt();
  await consent();
  button('Send again')?.click();
  await flush();
  const del = button('Delete…');
  const pick = byId('send-delete');
  del?.click();
  await flush();
  const asked = !!button('Ask for its deletion');
  check('dialog: while a send is on its way, Delete… and "Delete a submission I sent…" are off, and no request can be asked',
    !!del && del.disabled === true && pick?.disabled === true && !asked && !calls.some((c) => c.path === '/api/submit/delete'),
    `Delete… disabled ${del?.disabled}, pick disabled ${pick?.disabled}, asked ${asked}`);
  releaseSend?.();
  await flush(12);
  check('dialog: ...and back on once the send is answered', button('Delete…')?.disabled === false && byId('send-delete')?.disabled === false);
}

// NO ANSWER AT ALL: the bench stopped while the send waited.
{
  let server = 'up';
  routes = {
    '/api/submit/receipts': async () => (server === 'down' ? 'down' : keptList(...(server === 'restarted' ? [receiptOf()] : []))),
    '/api/submit/preview': async (b) => (server === 'down' ? 'down' : ok200(previewOf(b.again ? { title: previewOf().title } : {}))),
    '/api/submit/send': async () => {
      if (server === 'up') { server = 'down'; return 'down'; }
      return { status: 404, data: { error: 'No preview with that id is held: ...' } };
    },
  };
  await openDialog();
  await chooseLog();
  await previewIt();
  await consent();
  button('Send')?.click();
  await flush(12);
  const saidLost = shown().includes('The bench did not answer (Failed to fetch), so whether this send reached the project\'s folder is not known here.');
  const labelled = !!button('Send again');
  button('Back')?.click();
  await flush();
  const backAsks = shown().includes('the bench stopped answering while it was being sent. A bundle made from here is a new submission')
    && !!button('Look for its receipt again');
  button('Stay')?.click();
  await flush();
  await esc();
  const closeAsks = !!button('Close all the same') && !!button('Stay');
  check('dialog: no answer at all: said so, Send again offered, and Back and Close ask as after a send that was not answered',
    saidLost && labelled && backAsks && closeAsks, `said ${saidLost}, label ${labelled}, back ${backAsks}, close ${closeAsks}`);
  button('Stay')?.click();
  await flush();
  server = 'restarted';
  button('Back')?.click();
  await flush();
  button('Look for its receipt again')?.click();
  await flush(12);
  const held = !!button('Save receipt') && shown().includes(`The bench answers again, and keeps the receipt of submission ${X.slice(0, 8)} it saved before sending`);
  await consent();
  button('Send again')?.click();
  await flush(16);
  const rebuilt = calls.some((c) => c.path === '/api/submit/preview' && typeof c.body?.again === 'string' && c.body.again.includes(X))
    && shown().includes('so it built it again from the same files as the same submission') && shown().includes('Send again sends it.');
  check('dialog: ...once the bench answers again, the kept receipt of the preview\'s id is held, and Send again rebuilds on the 404',
    held && rebuilt, `held ${held}, rebuilt ${rebuilt}`);
}

// SAVE .ZIP of a bundle the bench let go of after a send not answered,
// and a rebuilt preview Send does not take.
{
  routes = {
    '/api/submit/receipts': async () => keptList(),
    '/api/submit/preview': async (b) => ok200(previewOf(b.again ? { upload: false } : {})),
    '/api/submit/send': async () => ({ status: 502, data: { error: 'The upload to the project\'s pCloud folder could not be reached (ECONNRESET) - the fight may or may not have arrived.', ...fields(receiptOf()) } }),
    '/api/submit/bundle': async (b) => (b.previewId === '1'.padStart(32, '0')
      ? { status: 404, data: { error: 'No preview with that id is held: ...' } }
      : ok200({ name: `farever-bench-submission-${X.slice(0, 8)}.zip`, base64: Buffer.from('PK').toString('base64'), bytes: 2 })),
  };
  await openDialog();
  await chooseLog();
  await previewIt();
  await consent();
  button('Send')?.click();
  await flush(12);
  button('Save .zip')?.click();
  await flush(16);
  check('dialog: Save .zip after an unanswered send, the bundle let go of: built again from the receipt, then saved',
    calls.some((c) => c.path === '/api/submit/preview' && typeof c.body?.again === 'string') && saved.includes(`farever-bench-submission-${X.slice(0, 8)}.zip`)
      && !shown().includes('No preview with that id is held'), `saved ${saved.join()}; ${calls.map((c) => c.path).join(' ')}`);
  check('dialog: ...and the rebuilt preview has no upload link: the status says Send is off for it, not "Send again sends it"',
    shown().includes('Send is off for it, though: this copy of the bench has no upload link now.') && !shown().includes('Send again sends it.') && !button('Send again'),
    shown().slice(0, 600));
}

// A PENDING RECEIPT SAVED, then the send answered.
{
  let tries = 0;
  routes = {
    '/api/submit/receipts': async () => keptList(),
    '/api/submit/preview': async () => ok200(previewOf()),
    '/api/submit/send': async () => (++tries === 1
      ? { status: 502, data: { error: 'The upload ... - the fight may or may not have arrived.', ...fields(receiptOf()) } }
      : ok200({ sent: { id: X, uploadedAs: `${X}.zip`, sentAt: '2026-10-20T10:05:00.000Z', zipSha256: 'f'.repeat(64) }, ...fields(receiptOf('2026-10-20T10:05:00.000Z')) })),
  };
  await openDialog();
  await chooseLog();
  await previewIt();
  await consent();
  button('Send')?.click();
  await flush(12);
  button('Save receipt')?.click();
  await flush();
  await consent();
  button('Send again')?.click();
  await flush(12);
  const sent = shown().includes(`Sent. Submission ${X.slice(0, 8)} is in the project's pCloud folder`);
  await esc();
  check('dialog: the saved copy was the pending receipt: once the send is answered, Close asks to save the completed one',
    sent && shown().includes('you saved was written before pCloud answered') && !!button('Save receipt, then close'), `sent ${sent}`);
}

console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
