/**
 * The editor's on-device copy of unsaved work (editor/drafts.js), and when it is let go.
 *
 * It used to be deleted the moment the form was submitted. A save that then never arrived — the
 * connection dropped, the session had expired and the sign-in went to the dashboard, the body was
 * too large — took the only copy of a clerk's program with it. Now submitting marks the copy, and
 * it goes only when the page the save redirects to carries `?saved=<the form's action>`; until then
 * the next visit to the form offers it back (never applies it by itself).
 *
 * The draft module runs against a stub document, and the admin layout's real inline script (the
 * `data-confirm` listener and the `?saved=` cleanup) is lifted out of a rendered page and run in a
 * `vm` on the same stub, as confirm.test.js does. Submit events go through both the way a browser
 * dispatches them on the document: capture listeners first, then bubble.
 *
 * Node only, in process. Run with: npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadConfig } from '../dist/config.js';
import { loginPage } from '../dist/views.js';
import { protectDraft } from '../editor/drafts.js';

loadConfig({ APP_NAME: 'Test Ward', APP_SHORT_NAME: 'Test', APP_DESCRIPTION: 'Test', ADMIN_PASSWORD: 'a long test passphrase' });

const ACTION = '/admin/programs/7';
const KEY = `ward-draft:${ACTION}`;
const SAVED_BODY = 'Presiding ... Bishop Ramirez';
const TYPED_BODY = 'Presiding ... Bishop Ramirez\nConducting ... Brother Okafor';

// --- A browser, as much of one as the code touches ------------------------------

/** A Map-backed localStorage. */
function storage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    // `length` and `key(i)` are how a script walks a storage it does not know the keys of (the
    // layout's Log Out cleanup does).
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

function element(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    listeners: {},
    removed: false,
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    append(...kids) {
      this.children.push(...kids);
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    remove() {
      this.removed = true;
    },
  };
  return el;
}

let env;

/** A fresh page at `search` (e.g. `?saved=…`), with one stored localStorage carried over. */
function newPage(search = '', store = storage()) {
  const docListeners = [];
  const winListeners = {};
  env = {
    store,
    docListeners,
    winListeners,
    location: { pathname: '/admin/programs/7/edit', search, href: `https://ward.example/admin/programs/7/edit${search}` },
    document: {
      visibilityState: 'visible',
      addEventListener: (type, fn, capture) => docListeners.push({ type, fn, capture: !!capture }),
      createElement: element,
    },
    addEventListener: (type, fn) => (winListeners[type] ??= []).push(fn),
  };
  for (const name of ['localStorage', 'location', 'document', 'addEventListener']) {
    Object.defineProperty(globalThis, name, {
      value: name === 'localStorage' ? store : env[name],
      configurable: true,
      writable: true,
    });
  }
  return env;
}

/** The program edit form as the server rendered it. */
function form(body = SAVED_BODY, action = ACTION) {
  const f = element('form');
  f.attrs.action = action;
  f.getAttribute = (name) => f.attrs[name] ?? null;
  f.elements = [
    { name: 'program_date', type: 'date', value: '2026-11-01' },
    { name: 'body', type: 'textarea', value: body },
    { name: '_csrf', type: 'hidden', value: 'x' },
  ];
  f.inserted = [];
  f.firstChild = null;
  f.insertBefore = (node) => f.inserted.push(node);
  return f;
}

/** Run the admin layout's inline script (confirm listener, flash and `?saved=` cleanup) on this page. */
function runLayoutScript(answer = true) {
  const script = [...loginPage().matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find((m) =>
    m[1].includes('data-confirm'),
  )?.[1];
  assert.ok(script, 'the layout carries the confirm listener');
  const context = {
    document: env.document,
    // The layout also listens for `pageshow` (its double-tap guard, test/confirm.test.js); that is
    // not what is under test here, so the window takes the listener and the guard's deferral runs
    // at once.
    window: { location: env.location, confirm: () => answer, addEventListener: env.addEventListener },
    history: { replaceState() {} },
    localStorage: env.store,
    setTimeout: (fn) => fn(),
    URL,
  };
  vm.createContext(context);
  vm.runInContext(script, context);
}

/** Dispatch a submit on the document the way a browser does: capture listeners, then bubble. */
function submit(target) {
  let prevented = false;
  const event = {
    target,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
  const submits = env.docListeners.filter((l) => l.type === 'submit');
  for (const l of submits.filter((l) => l.capture)) l.fn(event);
  for (const l of submits.filter((l) => !l.capture)) l.fn(event);
  return !prevented;
}

/** True when the leave-page prompt would be shown. */
function wouldPromptOnLeave() {
  let prompted = false;
  for (const fn of env.winListeners.beforeunload ?? []) fn({ preventDefault: () => (prompted = true) });
  return prompted;
}

const stored = () => JSON.parse(env.store.getItem(KEY) ?? 'null');
const type = (f, body) => (f.elements.find((el) => el.name === 'body').value = body);

beforeEach(() => newPage());

// ---------------------------------------------------------------------------

test('submitting keeps the draft, marked submitted, instead of deleting it', () => {
  const f = form();
  protectDraft(f, null, () => {});
  type(f, TYPED_BODY);
  assert.equal(submit(f), true);
  const draft = stored();
  assert.ok(draft, 'the draft must survive the submit');
  assert.equal(typeof draft.submittedAt, 'number');
  assert.deepEqual(new Map(draft.fields).get('body'), TYPED_BODY);
  // The submit ends the leave-page prompt, and later page-hide saves cannot overwrite the mark.
  assert.equal(wouldPromptOnLeave(), false);
  for (const fn of env.winListeners.pagehide) fn();
  assert.equal(typeof stored().submittedAt, 'number');
});

test('a submitted draft with no confirmation is offered back on the next visit, not applied', () => {
  const f = form();
  protectDraft(f, null, () => {});
  type(f, TYPED_BODY);
  submit(f);

  // The save never arrived (or the sign-in went elsewhere): the form is opened again, as saved.
  newPage('', env.store);
  const again = form();
  let restored = null;
  protectDraft(again, null, (body) => (restored = body));
  assert.equal(again.inserted.length, 1, 'the restore banner is shown');
  const banner = again.inserted[0];
  assert.match(banner.children[0].textContent, /may not have reached the server/u);
  assert.equal(again.elements.find((el) => el.name === 'body').value, SAVED_BODY, 'nothing applied by itself');
  assert.equal(restored, null);
  assert.ok(stored(), 'still kept');

  // Restore puts the typed text back.
  banner.children[1].listeners.click[0]();
  assert.equal(restored, TYPED_BODY);
});

test('the page a save redirects to clears the submitted draft (an editor page landing on itself)', () => {
  const f = form();
  protectDraft(f, null, () => {});
  type(f, TYPED_BODY);
  submit(f);

  newPage(`?msg=Program%20saved.&saved=${encodeURIComponent(ACTION)}`, env.store);
  const after = form(TYPED_BODY);
  protectDraft(after, null, () => {});
  assert.equal(after.inserted.length, 0);
  assert.equal(stored(), null, 'confirmed saved, so the copy goes');
});

test('the layout script clears a submitted draft on the dashboard the save landed on', () => {
  const f = form();
  protectDraft(f, null, () => {});
  type(f, TYPED_BODY);
  submit(f);

  newPage(`?msg=Program%20saved.&saved=${encodeURIComponent(ACTION)}`, env.store);
  runLayoutScript();
  assert.equal(stored(), null);
});

test('the layout script leaves a draft that was never submitted, and other forms’ drafts', () => {
  const store = storage();
  store.setItem(KEY, JSON.stringify({ savedAt: Date.now(), base: '[]', fields: [['body', TYPED_BODY]] }));
  store.setItem('ward-draft:/admin/pages/3', JSON.stringify({ savedAt: Date.now(), submittedAt: Date.now(), base: '[]', fields: [] }));
  newPage(`?saved=${encodeURIComponent(ACTION)}`, store);
  runLayoutScript();
  assert.ok(stored(), 'newer typing (another tab) is not a submitted draft');
  assert.ok(store.getItem('ward-draft:/admin/pages/3'), 'a different form’s draft is untouched');
});

test('the login page after Log Out (?out=1) drops every draft on the device, and only then', () => {
  // Log Out redirects to `/admin/login?out=1` (src/app.ts). The flag is what distinguishes it from
  // the login page a merely expired session lands on, which must keep the draft to offer it back.
  const store = storage();
  store.setItem(KEY, JSON.stringify({ savedAt: Date.now(), base: '[]', fields: [['body', TYPED_BODY]] }));
  store.setItem('ward-draft:/admin/pages/3', JSON.stringify({ savedAt: Date.now(), submittedAt: Date.now(), base: '[]', fields: [] }));
  store.setItem('ward-draft:/admin/announcements/new', JSON.stringify({ savedAt: Date.now(), base: '[]', fields: [] }));
  store.setItem('something-else', 'kept');
  newPage('?next=%2Fadmin%2Fprograms%2F7%2Fedit', store);
  runLayoutScript();
  assert.ok(stored(), 'the login page a session expiry lands on keeps the draft');
  assert.equal(store.map.size, 4);

  env.location = { pathname: '/admin/login', search: '?out=1', href: 'https://ward.example/admin/login?out=1' };
  runLayoutScript();
  assert.equal(stored(), null, 'the draft is gone');
  assert.equal(store.getItem('ward-draft:/admin/pages/3'), null, 'submitted or not');
  assert.equal(store.getItem('ward-draft:/admin/announcements/new'), null, 'every form\'s');
  assert.equal(store.getItem('something-else'), 'kept', 'nothing but drafts');
});

test('a cancelled "Are you sure?" leaves the page protected', () => {
  const f = form();
  protectDraft(f, null, () => {});
  runLayoutScript(false); // the person answers Cancel
  type(f, TYPED_BODY);

  const del = form('', '/admin/programs/7/delete');
  del.attrs['data-confirm'] = 'Delete this program?';
  assert.equal(submit(del), false, 'the confirm listener prevented the submit');

  assert.equal(wouldPromptOnLeave(), true, 'unsaved changes still prompt on leaving');
  for (const fn of env.winListeners.pagehide) fn();
  const draft = stored();
  assert.ok(draft, 'draft saving still runs');
  assert.equal(draft.submittedAt, undefined);
});

test('a confirmed Delete ends the protection without touching this form’s draft', () => {
  const f = form();
  protectDraft(f, null, () => {});
  runLayoutScript(true);
  type(f, TYPED_BODY);
  const del = form('', '/admin/programs/7/delete');
  del.attrs['data-confirm'] = 'Delete this program?';
  assert.equal(submit(del), true);
  assert.equal(wouldPromptOnLeave(), false);
  assert.equal(stored(), null, 'nothing was stored, and Delete does not mark this form');
});

test('back from a failed submission (back-forward cache) protects the page again', () => {
  const f = form();
  protectDraft(f, null, () => {});
  type(f, TYPED_BODY);
  submit(f);
  for (const fn of env.winListeners.pageshow) fn({ persisted: true });
  assert.equal(wouldPromptOnLeave(), true);
});
