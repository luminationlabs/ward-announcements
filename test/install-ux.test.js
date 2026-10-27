/**
 * Where the home-screen install lives, per platform.
 *
 * On Android and desktop, push works in a normal tab, so installing is optional — not a whole second
 * card stacked above the notification card that actually matters. It is a secondary "Add to Home
 * Screen" button *inside* the notification card, which fires the native dialog when the browser
 * offered one (`beforeinstallprompt`) and otherwise opens the "use your browser's menu" sheet. That
 * fallback is the point: Chrome withholds the event after an uninstall and for months after a
 * dismissed dialog, and without it Android would have no install path at all in those states. iOS and in-app browsers, where installing (or escaping to a real browser) is
 * the *required* step, keep the install card.
 *
 * `public/install.js` runs verbatim in a `vm` against a stub DOM of the handful of elements and
 * globals it touches. The logic under test is the real one; only the environment is fake.
 *
 * Node only, and deliberately in process. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/install.js', import.meta.url), 'utf8');

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36',
  desktopChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  // iOS 26 froze the OS token at 18_6 to shrink the fingerprinting surface, so `Version/` is the
  // only token that still tracks the real release — which is the one install.js branches on.
  iosSafari26:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iosSafari27:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1',
};

const IDS = [
  'install-card',
  'install-btn',
  'install-heading',
  'install-sub',
  'install-sheet',
  'install-steps',
  'sheet-close',
  'installed-banner',
  'installed-dismiss',
  'install-secondary',
  'android-blocked-note',
  'add-home-btn',
  'notify-card',
  'enable-btn',
];

function element(id) {
  const listeners = {};
  return {
    id,
    // Everything starts hidden except the notification card, matching index.html.
    hidden: id !== 'notify-card' && id !== 'enable-btn',
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    async click() {
      for (const fn of listeners.click || []) await fn({ target: this });
    },
    querySelector: () => null,
    scrollIntoView() {},
    focus() {},
  };
}

/**
 * Run install.js in a stub environment. Returns the elements, plus `fire(type, event)` to raise
 * a window event (beforeinstallprompt / appinstalled) exactly as the browser would.
 */
function boot({
  ua,
  standalone = false,
  platform = 'Linux armv8l',
  maxTouchPoints = 5,
  fetch = async () => ({ ok: false, json: async () => ({}) }),
  clipboard,
}) {
  const els = Object.fromEntries(IDS.map((id) => [id, element(id)]));
  // The sheet's copy-a-link button is rendered into #install-steps as markup; hand install.js one
  // stub button for it while that markup is showing, the way a browser would find it.
  const copyBtn = element('copy-link');
  els['install-steps'].querySelector = (sel) =>
    sel === '[data-copy-link]' && els['install-steps'].innerHTML.includes('data-copy-link') ? copyBtn : null;
  els.copyBtn = copyBtn;
  const windowListeners = {};
  const storage = new Map();
  const window = {
    addEventListener(type, fn) {
      (windowListeners[type] ||= []).push(fn);
    },
    matchMedia: () => ({ matches: standalone }),
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => els[id] || null,
      documentElement: { dataset: {} },
      body: { style: {} },
      addEventListener() {},
    },
    navigator: { userAgent: ua, platform, maxTouchPoints, standalone: false, clipboard },
    fetch,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
    setTimeout,
  });
  vm.runInContext(source, context, { filename: 'install.js' });
  return {
    els,
    async fire(type, event = {}) {
      for (const fn of windowListeners[type] || []) await fn({ preventDefault() {}, ...event });
    },
  };
}

/** A `beforeinstallprompt` event whose dialog resolves to `outcome`. */
function nativePrompt(outcome) {
  const calls = { prompt: 0 };
  return {
    calls,
    event: {
      prompt() {
        calls.prompt++;
      },
      userChoice: Promise.resolve({ outcome }),
    },
  };
}

describe('install UX: Android and desktop (optional install)', () => {
  test('Android: the install card stays hidden and the notification card carries the button', async () => {
    const { els, fire } = boot({ ua: UA.androidChrome });
    const { event, calls } = nativePrompt('accepted');
    await fire('beforeinstallprompt', event);

    assert.equal(els['install-card'].hidden, true, 'no second card on Android');
    assert.equal(els['add-home-btn'].hidden, false, 'the button lives on the notification card');
    assert.equal(els['android-blocked-note'].hidden, false, 'Play Protect note travels with it');

    await els['add-home-btn'].click();
    assert.equal(calls.prompt, 1, 'the tap fires the native dialog');
    assert.equal(els['install-sheet'].hidden, true, 'and not the instructions sheet');
    assert.equal(els['add-home-btn'].hidden, true, 'an accepted install retires the button');
  });

  test('Android without beforeinstallprompt still offers install, via the menu steps', async () => {
    const { els } = boot({ ua: UA.androidChrome });
    assert.equal(els['add-home-btn'].hidden, false, 'button shown before/without the event');
    assert.equal(els['install-card'].hidden, true);

    await els['add-home-btn'].click();
    assert.equal(els['install-sheet'].hidden, false, 'falls back to the sheet');
    assert.match(els['install-steps'].innerHTML, /Add to Home screen/);
    assert.match(els['install-steps'].innerHTML, /⋮/, 'points at the Chrome menu');
  });

  test('a dismissed native dialog falls through to the sheet on the next tap', async () => {
    const { els, fire } = boot({ ua: UA.androidChrome });
    const { event, calls } = nativePrompt('dismissed');
    await fire('beforeinstallprompt', event);

    await els['add-home-btn'].click();
    assert.equal(calls.prompt, 1);
    assert.equal(els['add-home-btn'].hidden, false, 'the button survives a "not now"');

    await els['add-home-btn'].click();
    assert.equal(calls.prompt, 1, 'a deferred prompt is single-use, so it is not re-fired');
    assert.equal(els['install-sheet'].hidden, false, 'the menu steps take over');
  });

  test('a native dialog that refuses to open still gets the member the steps', async () => {
    // Chrome throws on a stale event — already prompted, or the user activation has lapsed. The
    // tap must not be spent on nothing.
    const { els, fire } = boot({ ua: UA.androidChrome });
    await fire('beforeinstallprompt', {
      prompt() {
        throw new Error('The prompt() method may only be called once.');
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });

    await els['add-home-btn'].click();
    assert.equal(els['install-sheet'].hidden, false, 'the same tap falls through to the sheet');
    assert.equal(els['add-home-btn'].hidden, false, 'and nothing was installed, so the button stays');
  });

  test('appinstalled (e.g. installed from the Chrome menu) retires the button and the note', async () => {
    const { els, fire } = boot({ ua: UA.androidChrome });
    assert.equal(els['add-home-btn'].hidden, false);
    await fire('appinstalled');
    assert.equal(els['add-home-btn'].hidden, true);
    assert.equal(els['android-blocked-note'].hidden, true);
  });

  test('already running standalone: no button even if the event fires', async () => {
    const { els, fire } = boot({ ua: UA.androidChrome, standalone: true });
    await fire('beforeinstallprompt', nativePrompt('accepted').event);
    assert.equal(els['add-home-btn'].hidden, true);
    assert.equal(els['install-card'].hidden, true);
    assert.equal(els['installed-banner'].hidden, false, 'first standalone launch gets the welcome');
  });

  test('desktop: the button appears only when the browser offers a native dialog', async () => {
    const { els, fire } = boot({ ua: UA.desktopChrome, platform: 'MacIntel', maxTouchPoints: 0 });
    assert.equal(els['add-home-btn'].hidden, true, 'no generic menu steps worth a button');
    assert.equal(els['install-card'].hidden, true);

    await fire('beforeinstallprompt', nativePrompt('accepted').event);
    assert.equal(els['add-home-btn'].hidden, false);
    assert.equal(els['android-blocked-note'].hidden, true, 'Play Protect note is Android-only');
    assert.equal(els['install-card'].hidden, true, 'still no second card');
  });
});

describe('install UX: where installing is the required step', () => {
  test('iOS Safari keeps the install card and never shows the optional button', async () => {
    const { els, fire } = boot({ ua: UA.iosSafari, platform: 'iPhone' });
    assert.equal(els['install-card'].hidden, false);
    assert.equal(els['add-home-btn'].hidden, true);
    assert.match(els['install-heading'].textContent, /Weekly Notifications/);

    // iOS never fires this, but a hypothetical one must not surface the Android affordance.
    await fire('beforeinstallprompt', nativePrompt('accepted').event);
    assert.equal(els['install-card'].hidden, false);

    await els['install-btn'].click();
    assert.equal(els['install-sheet'].hidden, false);
    assert.match(els['install-steps'].innerHTML, /Add to Home Screen/);
  });

  // Apple moves the button that opens the menu holding Share, and the steps have to follow: iOS 26
  // put it behind the ••• at the bottom-right, and iOS 27 turned that button into Tabs, leaving the
  // page menu in the address bar as the way in. Following the wrong step 1 strands a member on the
  // first tap, so each release gets its own first step and its own illustration.
  const step1For = async (ua) => {
    const { els } = boot({ ua, platform: 'iPhone' });
    await els['install-btn'].click();
    return els['install-steps'].innerHTML;
  };

  test('iOS Safari: the first step tracks where that release hides Share', async () => {
    const classic = await step1For(UA.iosSafari);
    assert.match(classic, /Tap <strong>Share<\/strong> in Safari's toolbar/);
    assert.doesNotMatch(classic, /share-1\.svg/, 'the ≤18 flow predates the screenshot steps');

    const ios26 = await step1For(UA.iosSafari26);
    assert.match(ios26, /three dots/);
    assert.match(ios26, /ios-26-share-1\.svg/);

    const ios27 = await step1For(UA.iosSafari27);
    assert.match(ios27, /page menu/);
    assert.match(ios27, /ios-27-share-1\.svg/);
    assert.doesNotMatch(ios27, /three dots/, 'the ••• is the Tabs button on 27');

    // The share sheet itself is unchanged between the two, so those steps stay shared.
    for (const html of [ios26, ios27]) {
      assert.match(html, /View More/);
      assert.match(html, /ios-26-share-4\.svg/);
    }
  });

  test('Android in-app webview keeps the "open in Chrome" card and hides the optional button', async () => {
    const { els } = boot({ ua: UA.androidWebView });
    assert.equal(els['install-card'].hidden, false);
    assert.match(els['install-heading'].textContent, /Open in Chrome/);
    assert.equal(els['add-home-btn'].hidden, true, 'installing is not the fix here');
  });
});

// Escaping an in-app browser (or a non-Safari iOS browser) used to mean "open this page in Safari"
// — which hands Safari the bare address, since the credential that unlocked this page was scrubbed
// from the fragment on arrival, and Safari has its own cookies. It showed the locked page, and on
// iOS that is the only road to notifications. The escape steps now carry a fresh invite across.
describe('install UX: escaping to a real browser carries a working link', () => {
  const INVITE = 'https://ward.example/#i=FRESH-INVITE';
  function inviteServer() {
    const calls = [];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, method: init && init.method });
        return { ok: true, json: async () => ({ url: INVITE, expiresInDays: 30 }) };
      },
    };
  }
  const IOS_IN_APP =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]';
  const IOS_CHROME =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1';

  for (const [name, ua, where, platform] of [
    ['iOS in-app browser', IOS_IN_APP, 'Safari', 'iPhone'],
    ['iOS Chrome', IOS_CHROME, 'Safari', 'iPhone'],
    ['Android in-app webview', UA.androidWebView, 'Chrome', undefined],
  ]) {
    test(`${name}: the steps copy a fresh invite rather than send "this page" over`, async () => {
      const server = inviteServer();
      const copied = [];
      const { els } = boot({
        ua,
        ...(platform ? { platform } : {}),
        fetch: server.fetch,
        clipboard: { writeText: async (t) => void copied.push(t) },
      });
      await els['install-btn'].click();
      const html = els['install-steps'].innerHTML;
      assert.match(html, new RegExp(`Copy Link for ${where}`));
      assert.match(html, /paste the link/);
      assert.doesNotMatch(html, /Open this page's link|Choose <strong>Open in/, 'the route that lands on the locked page is gone');

      await els.copyBtn.click();
      assert.deepEqual(copied, [INVITE], 'the invite, credential and all, is what goes on the clipboard');
      assert.match(els.copyBtn.textContent, /Copied/);
      assert.deepEqual(
        server.calls.map((c) => `${c.method} ${c.url}`),
        ['POST /api/invite'],
        'minted once, through the same endpoint Share With Someone uses',
      );

      // Re-opening the sheet in the same page view reuses the link rather than minting another.
      await els['install-btn'].click();
      await els.copyBtn.click();
      assert.equal(server.calls.length, 1);
    });
  }

  test('no clipboard: the link is shown to copy by hand', async () => {
    const { els } = boot({ ua: IOS_IN_APP, platform: 'iPhone', fetch: inviteServer().fetch });
    await els['install-btn'].click();
    await els.copyBtn.click();
    assert.equal(els.copyBtn.textContent, INVITE);
  });

  test('a failed mint says so, and the next tap tries again', async () => {
    let ok = false;
    const { els } = boot({
      ua: IOS_IN_APP,
      platform: 'iPhone',
      fetch: async () => ({ ok, json: async () => ({ url: INVITE }) }),
      clipboard: { writeText: async () => {} },
    });
    await els['install-btn'].click();
    await els.copyBtn.click();
    assert.match(els.copyBtn.textContent, /Couldn't create a link/);
    ok = true;
    await els.copyBtn.click();
    assert.match(els.copyBtn.textContent, /Copied/);
  });

  test('Safari itself needs no link: its steps mint nothing', async () => {
    const server = inviteServer();
    const { els } = boot({ ua: UA.iosSafari, platform: 'iPhone', fetch: server.fetch });
    await els['install-btn'].click();
    assert.doesNotMatch(els['install-steps'].innerHTML, /data-copy-link/);
    assert.equal(server.calls.length, 0);
  });
});
