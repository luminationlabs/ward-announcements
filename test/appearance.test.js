/**
 * The Auto / Light / Dark head script (src/theme.ts).
 *
 * It runs in the <head> of the app shell and the gate page before the first paint, so it is tested
 * as exactly that string: run in a `vm` against a fake `<html>`, a fake `matchMedia` and a
 * localStorage that works, is empty, or throws. It must always leave a resolved `data-theme` and
 * never throw. Both pages are checked to carry it.
 *
 * Node only, in process. Run with: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { APPEARANCE_KEY, THEME_HEAD_SCRIPT } from '../dist/theme.js';
import { loadConfig } from '../dist/config.js';
import { buildShell, shellFor } from '../dist/shell.js';
import { gatePage } from '../dist/views.js';

const SCRIPT = /^<script>([\s\S]*)<\/script>$/u.exec(THEME_HEAD_SCRIPT)?.[1];

/** A Map-backed localStorage. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** Storage that refuses everything, as a blocked site does. */
const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

/** A `prefers-color-scheme: dark` query whose answer the test can flip and announce. */
function fakeMedia(dark) {
  const listeners = [];
  return {
    matches: dark,
    addEventListener: (type, fn) => listeners.push(fn),
    flip(next) {
      this.matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
  };
}

/** Run the head script in a fresh fake page; returns what it touched. */
function run({ storage, systemDark = false, media = fakeMedia(systemDark), noMatchMedia = false }) {
  const attrs = {};
  const style = {};
  const metas = [{ content: '#1f3a5f' }, { content: '#172c48' }].map((m) => ({
    ...m,
    setAttribute(name, value) {
      this[name] = value;
    },
  }));
  const window = {};
  if (storage !== undefined) {
    // A getter, so "storage that throws on access" is expressible too.
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        if (storage === 'throws-on-access') throw new Error('SecurityError');
        return storage;
      },
    });
  }
  if (!noMatchMedia) window.matchMedia = () => media;
  const document = {
    documentElement: {
      setAttribute: (name, value) => (attrs[name] = value),
      style,
    },
    querySelectorAll: (sel) => (sel === 'meta[name="theme-color"]' ? metas : []),
  };
  window.document = document;
  vm.runInContext(SCRIPT, vm.createContext({ window, document }));
  return { attrs, style, metas, window, media };
}

describe('appearance head script', () => {
  test('is a single inline <script>', () => {
    assert.ok(SCRIPT, 'THEME_HEAD_SCRIPT should be one <script>…</script>');
    assert.equal(APPEARANCE_KEY, 'appearance');
  });

  for (const systemDark of [false, true]) {
    const system = systemDark ? 'dark' : 'light';
    describe(`system ${system}`, () => {
      const cases = [
        ['nothing stored', memoryStorage(), system],
        ['"auto" stored', memoryStorage({ [APPEARANCE_KEY]: 'auto' }), system],
        ['"light" stored', memoryStorage({ [APPEARANCE_KEY]: 'light' }), 'light'],
        ['"dark" stored', memoryStorage({ [APPEARANCE_KEY]: 'dark' }), 'dark'],
        ['an unknown value stored', memoryStorage({ [APPEARANCE_KEY]: 'sepia' }), system],
        ['storage whose reads throw', throwingStorage, system],
        ['localStorage that throws on access', 'throws-on-access', system],
        ['no localStorage at all', undefined, system],
      ];
      for (const [label, storage, want] of cases) {
        test(`${label} → ${want}`, () => {
          const { attrs, style, metas } = run({ storage, systemDark });
          assert.equal(attrs['data-theme'], want);
          assert.equal(style.colorScheme, want);
          const navy = want === 'dark' ? '#172c48' : '#1f3a5f';
          assert.deepEqual(
            metas.map((m) => m.content),
            [navy, navy],
          );
        });
      }
    });
  }

  test('no matchMedia: Auto falls back to light', () => {
    const { attrs } = run({ storage: memoryStorage(), noMatchMedia: true });
    assert.equal(attrs['data-theme'], 'light');
  });

  test('Auto follows a live system change; a manual choice does not', () => {
    const auto = run({ storage: memoryStorage(), systemDark: false });
    auto.media.flip(true);
    assert.equal(auto.attrs['data-theme'], 'dark');
    auto.media.flip(false);
    assert.equal(auto.attrs['data-theme'], 'light');

    const manual = run({ storage: memoryStorage({ [APPEARANCE_KEY]: 'light' }), systemDark: false });
    manual.media.flip(true);
    assert.equal(manual.attrs['data-theme'], 'light');
  });

  test('wardAppearance.set applies at once and stores the choice (Auto clears it)', () => {
    const storage = memoryStorage();
    const page = run({ storage, systemDark: false });
    const control = page.window.wardAppearance;
    assert.equal(control.get(), 'auto');

    control.set('dark');
    assert.equal(page.attrs['data-theme'], 'dark');
    assert.equal(storage.map.get(APPEARANCE_KEY), 'dark');
    assert.equal(control.get(), 'dark');

    control.set('auto');
    assert.equal(page.attrs['data-theme'], 'light');
    assert.equal(storage.map.has(APPEARANCE_KEY), false);
  });

  test('a choice made while storage refuses still holds for the page, through a system change', () => {
    const page = run({ storage: throwingStorage, systemDark: true });
    assert.equal(page.attrs['data-theme'], 'dark');
    page.window.wardAppearance.set('light');
    assert.equal(page.attrs['data-theme'], 'light');
    page.media.flip(false);
    page.media.flip(true);
    assert.equal(page.attrs['data-theme'], 'light');
  });
});

describe('both member-facing pages carry it in <head>, after the theme-color metas', () => {
  before(() => {
    loadConfig({
      ADMIN_PASSWORD: 'test-admin-password',
      APP_NAME: 'Test Ward',
      APP_SHORT_NAME: 'Test',
      APP_DESCRIPTION: 'Test announcements',
      VAPID_SUBJECT: 'mailto:test@example.org',
      VAPID_PUBLIC_KEY: 'x',
      VAPID_PRIVATE_KEY: 'y',
    });
  });

  function check(html) {
    const head = html.slice(0, html.indexOf('</head>'));
    // By its body: the opening tag carries the response's nonce (src/csp.ts).
    const at = head.indexOf(THEME_HEAD_SCRIPT.slice('<script>'.length));
    assert.notEqual(at, -1, 'the head script is missing from <head>');
    assert.ok(head.lastIndexOf('<meta name="theme-color"') < at, 'the script must follow the theme-color metas');
  }

  test('the app shell', async () => {
    const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
    const sources = { index: read('index.html'), sw: read('sw.js'), iosSplash: '', assets: [] };
    const shell = await buildShell(sources);
    check(shell.indexHtml);
    // Served with this response's nonce in place of the shell's token, and only there.
    const page = shellFor(shell, 'abc123');
    assert.match(page, /<script nonce="abc123">/);
    assert.equal(page.includes(shell.nonceToken), false);
    // Each build has its own token, but the build id must not: every isolate has to agree on it.
    const again = await buildShell(sources);
    assert.notEqual(again.nonceToken, shell.nonceToken);
    assert.equal(again.buildId, shell.buildId);
  });

  test('the gate page', () => {
    check(gatePage('Members only.'));
  });
});
