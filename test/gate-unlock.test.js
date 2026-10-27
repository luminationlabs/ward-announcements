/**
 * The gate page's credential exchange, and whether it survives a *same-document* arrival.
 *
 * Links issued by the app carry their credential in the fragment (`#code=` / `#i=`), which the
 * server never sees — so the exchange happens in an inline script on the gate page itself
 * (`gatePage()` in src/views.ts). A one-shot script would leave one real hole: a member already
 * sitting on the gate who then opens their link **in the same tab** changes only the fragment. That
 * is a same-document navigation — no reload, no script re-run — so the code would land in the
 * address bar and the gate would just sit there.
 *
 * The script is inline HTML, so it is extracted from the rendered page and evaluated in a `vm`
 * with the few globals it touches stubbed. The logic under test is the real one; only the
 * environment is fake.
 *
 * Node only, and deliberately in process. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { loadConfig } from '../dist/config.js';
import { gatePage } from '../dist/views.js';

// `gatePage()` reads the app name out of the shared config, which nothing else here needs.
loadConfig({
  ADMIN_PASSWORD: 'test-admin-password',
  APP_NAME: 'Test Ward',
  APP_SHORT_NAME: 'Test',
  APP_DESCRIPTION: 'Test announcements',
  VAPID_SUBJECT: 'mailto:test@example.org',
  VAPID_PUBLIC_KEY: 'x',
  VAPID_PRIVATE_KEY: 'y',
  NODE_ENV: 'development',
  TZ: 'America/Denver',
});

/** The inline unlock script, lifted out of the rendered gate page's body (the head carries the
 *  appearance script, tested in appearance.test.js). */
function unlockScript() {
  const html = gatePage('Enter the link you were given.');
  const match = /<script>([\s\S]*?)<\/script>/.exec(html.slice(html.indexOf('<body')));
  assert.ok(match, 'the gate page should carry an inline unlock script');
  return match[1];
}

/**
 * Run the gate's script against a fake page whose fragment can change afterwards.
 *
 * Returns the fragments it posted to /api/access, where it told the browser to go, and a `hash()`
 * to simulate the same-document arrival the fix is about.
 */
function openGate({ hash = '', ok = true, status, standalone, displayStandalone, pathname = '/', search = '' } = {}) {
  const posted = [];
  const replaced = [];
  const listeners = [];
  const timers = [];
  const formListeners = [];
  const elements = {
    'gate-msg': { textContent: '' },
    'gate-help': { textContent: '', hidden: false },
    'gate-paste': {
      hidden: true,
      addEventListener(type, fn) {
        if (type === 'submit') formListeners.push(fn);
      },
    },
    'gate-paste-input': { value: '' },
  };
  const location = {
    hash,
    pathname,
    search,
    replace(url) {
      replaced.push(url);
    },
  };
  let settle;
  const context = {
    location,
    document: { getElementById: (id) => elements[id] },
    fetch(url, init) {
      posted.push({ url, body: JSON.parse(init.body) });
      return new Promise((resolve) => {
        settle = () => resolve({ ok, status: status ?? (ok ? 200 : 401) });
      });
    },
    window: {
      // Only iOS Safari defines `navigator.standalone`; leave it off entirely unless a test asks,
      // the way every other browser does.
      ...(standalone === undefined ? {} : { navigator: { standalone } }),
      // Android and desktop report an installed app through the display-mode media query instead.
      ...(displayStandalone === undefined
        ? {}
        : { matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' && displayStandalone }) }),
      addEventListener(type, fn) {
        listeners.push({ type, fn });
      },
    },
    // Captured, not run: the 429 path schedules a retry, and a test fires it by hand.
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
  };
  vm.createContext(context);
  vm.runInContext(unlockScript(), context);

  return {
    posted,
    replaced,
    elements,
    /** Resolve the in-flight /api/access call, then let its `.then`/`.catch` run. */
    async answer() {
      settle?.();
      settle = undefined;
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** A same-document arrival: the fragment changes, nothing reloads. */
    hash(next) {
      location.hash = next;
      for (const { type, fn } of listeners) if (type === 'hashchange') fn();
    },
    timers,
    /** Type into the paste field and submit it, as a member in an installed app would. */
    paste(text) {
      elements['gate-paste-input'].value = text;
      let prevented = false;
      for (const fn of formListeners) fn({ preventDefault: () => (prevented = true) });
      return prevented;
    },
    /** Fire every timer the script has scheduled so far. */
    tick() {
      for (const t of timers.splice(0)) t.fn();
    },
  };
}

describe('the gate page unlocks from a fragment', () => {
  test('a code present at load is exchanged for a cookie', async () => {
    const gate = openGate({ hash: '#code=SUNBEAM' });
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['SUNBEAM'],
    );
    await gate.answer();
    assert.deepEqual(gate.replaced, ['/']);
  });

  test('unlocking at a path that begins with two slashes stays on this site', async () => {
    // The gate is served at any path. `location.replace('//evil.example.com/login')` is a URL on
    // another site, so a member could send a ward link that unlocks a stranger and then lands them
    // on a phishing page. The server-side `?code=` redirect already collapsed this (samePathOnly).
    for (const pathname of ['//evil.example.com/login', '/\\evil.example.com/login']) {
      const gate = openGate({ hash: '#code=SUNBEAM', pathname });
      await gate.answer();
      assert.equal(gate.replaced.length, 1);
      assert.equal(new URL(gate.replaced[0], 'https://ward.example').origin, 'https://ward.example', pathname);
    }
  });

  test('no code means no request', () => {
    assert.equal(openGate().posted.length, 0);
  });

  test('a code arriving after load — the same tab, same document — still unlocks', async () => {
    const gate = openGate();
    assert.equal(gate.posted.length, 0, 'nothing to exchange yet');
    gate.hash('#code=SUNBEAM');
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['SUNBEAM'],
      'the fragment that arrived without a reload is exchanged',
    );
    await gate.answer();
    assert.deepEqual(gate.replaced, ['/']);
  });

  test('an invite arriving after load unlocks the same way', () => {
    const gate = openGate();
    gate.hash('#i=INVITE-TOKEN');
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['INVITE-TOKEN'],
    );
  });

  test('the credential is URL-decoded on the way out', () => {
    const gate = openGate();
    gate.hash('#code=two%20words');
    assert.equal(gate.posted[0].body.code, 'two words');
  });

  test('a hash change while a request is in flight does not double-post', async () => {
    const gate = openGate({ hash: '#code=FIRST' });
    gate.hash('#code=SECOND');
    assert.equal(gate.posted.length, 1, 'the in-flight exchange owns the page');
    await gate.answer();
    assert.deepEqual(gate.replaced, ['/']);
  });

  test('a rejected code leaves the page able to try the next link', async () => {
    const gate = openGate({ hash: '#code=EXPIRED', ok: false });
    await gate.answer();
    assert.equal(gate.replaced.length, 0, 'a bad code does not navigate');
    assert.match(gate.elements['gate-msg'].textContent, /expired|no longer valid/i);
    gate.hash('#code=FRESH');
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['EXPIRED', 'FRESH'],
      'the failed attempt must not wedge the page shut',
    );
  });

  test('a rejected code launched from a home-screen icon blames the icon, not the link', async () => {
    // A member who added the *gate page* to their home screen got a Safari bookmark of the URL,
    // fragment included — not the installed app. It replays the same dead code on every launch,
    // and rescanning the QR in Safari does nothing for it, so the help has to say "remove it".
    const gate = openGate({ hash: '#code=EXPIRED', ok: false, standalone: true });
    await gate.answer();
    assert.match(gate.elements['gate-help'].textContent, /home-screen shortcut.*remove it/i);
    assert.equal(gate.elements['gate-help'].hidden, false);

    // In a browser tab (iOS with standalone false, or any browser that lacks the property) the
    // ordinary advice stands: the link is stale, ask for a new one.
    for (const standalone of [false, undefined]) {
      const tab = openGate({ hash: '#code=EXPIRED', ok: false, standalone });
      await tab.answer();
      assert.match(tab.elements['gate-help'].textContent, /ask whoever shared it/i);
      assert.doesNotMatch(tab.elements['gate-help'].textContent, /shortcut/i);
    }
  });

  test('a link that arrived mid-request is exchanged once the failure lands', async () => {
    const gate = openGate({ hash: '#code=EXPIRED', ok: false });
    // The member gives up on the stale link and opens the fresh one while the first POST is still
    // out. The busy flag turns it away — so the failure has to come back for it.
    gate.hash('#code=FRESH');
    assert.equal(gate.posted.length, 1, 'the in-flight exchange still owns the page');
    await gate.answer();
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['EXPIRED', 'FRESH'],
      'the credential that arrived mid-request must not be dropped on the floor',
    );
  });

  test('a failure with nothing new in the fragment does not re-post the same code', async () => {
    const gate = openGate({ hash: '#code=EXPIRED', ok: false });
    await gate.answer();
    await gate.answer();
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['EXPIRED'],
      'the retry must not spin on the code that just failed',
    );
  });

  test('a malformed escape is posted raw rather than wedging the page', async () => {
    // decodeURIComponent throws on this. Thrown before the fetch chain exists, no .catch would run,
    // the busy flag would stick on, and every later link in the tab would be ignored.
    const gate = openGate({ hash: '#code=%zz', ok: false });
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['%zz'],
      'an undecodable credential is still offered to the server, which rejects it',
    );
    await gate.answer();
    assert.match(gate.elements['gate-msg'].textContent, /expired|no longer valid/i);
    gate.hash('#code=FRESH');
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['%zz', 'FRESH'],
      'and the page still accepts the next link',
    );
  });

  test('a rate-limited exchange is retried, not reported as an expired link', async () => {
    // Launch Sunday: a chapel full of people unlocking through one wifi address. The limiter
    // answers 429, which must not read "That link has expired" — nor mark the code as tried, or
    // even a reload of the fragment would not re-post it.
    const gate = openGate({ hash: '#code=CROWDED', ok: false, status: 429 });
    await gate.answer();
    assert.equal(gate.replaced.length, 0);
    assert.doesNotMatch(gate.elements['gate-msg'].textContent, /expired|no longer valid/i);
    assert.match(gate.elements['gate-msg'].textContent, /try|again|moment/i);
    assert.equal(gate.timers.length, 1, 'a retry is scheduled');
    assert.ok(gate.timers[0].ms >= 5000 && gate.timers[0].ms < 15000, 'a few seconds out, with jitter');

    gate.tick();
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['CROWDED', 'CROWDED'],
      'the same code is posted again — it was never wrong',
    );
  });
});

// Issuing a new code with "everyone, including installed apps" deletes every device token, so an installed app's start_url
// (`/?code=<token>`, frozen at install) lands on this page on every launch from then on. A
// home-screen app has no address bar, and a link tapped in Messages opens Safari, whose cookies are
// not the app's — the app was bricked. The gate now offers it a field to paste the new link into.
describe('an installed app can paste its way back in', () => {
  test('the paste field is in the page, hidden until the script finds itself standalone', () => {
    const html = gatePage('Enter the link you were given.');
    assert.match(html, /<form id="gate-paste"[^>]*\bhidden\b/);
    assert.match(html, /<input id="gate-paste-input"/);
    assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handlers: the CSP refuses them');

    assert.equal(openGate().elements['gate-paste'].hidden, true, 'a browser tab has an address bar');
    assert.equal(openGate({ standalone: true }).elements['gate-paste'].hidden, false, 'iOS home-screen app');
    assert.equal(openGate({ displayStandalone: true }).elements['gate-paste'].hidden, false, 'installed elsewhere');
  });

  test('the help in an installed app says what will actually work', () => {
    const gate = openGate({ standalone: true, search: '?code=REVOKED-DEVICE-TOKEN' });
    assert.match(gate.elements['gate-help'].textContent, /paste/i);
    assert.equal(gate.posted.length, 0, 'the dead start_url token is not re-posted from the page');
  });

  for (const [what, text, code] of [
    ['a whole shared-code link', 'https://ward.example/#code=abcd-efgh-jkmn-pqrs', 'abcd-efgh-jkmn-pqrs'],
    ['an invite link', '  https://ward.example/#i=Inv1te_Tok-en  ', 'Inv1te_Tok-en'],
    ['a ?code= link', 'https://ward.example/?code=abcd-efgh-jkmn-pqrs', 'abcd-efgh-jkmn-pqrs'],
    ['a bare code, typed in capitals', 'ABCD-EFGH-JKMN-PQRS', 'abcd-efgh-jkmn-pqrs'],
    ['a bare token, case kept', 'Inv1te_Tok-en', 'Inv1te_Tok-en'],
    ['an escaped credential', 'https://ward.example/#code=two%20words', 'two words'],
  ]) {
    test(`pasting ${what} goes through the same exchange`, async () => {
      const gate = openGate({ standalone: true, search: '?code=REVOKED-DEVICE-TOKEN' });
      assert.equal(gate.paste(text), true, 'the form never submits itself');
      assert.deepEqual(
        gate.posted.map((p) => `${p.url} ${p.body.code}`),
        [`/api/access ${code}`],
      );
      await gate.answer();
      assert.deepEqual(gate.replaced, ['/'], 'the dead ?code= is not carried into the unlocked app');
    });
  }

  test('something that is not a link is refused without a request', () => {
    const gate = openGate({ standalone: true });
    gate.paste('see you sunday!');
    assert.equal(gate.posted.length, 0);
    assert.match(gate.elements['gate-msg'].textContent, /look like a ward link/);
  });

  test('a rejected paste leaves the field up for the next one', async () => {
    const gate = openGate({ standalone: true, ok: false });
    gate.paste('https://ward.example/#i=EXPIRED');
    await gate.answer();
    assert.match(gate.elements['gate-msg'].textContent, /expired|no longer valid/i);
    assert.match(gate.elements['gate-help'].textContent, /whole link|new one/i);
    assert.equal(gate.elements['gate-paste'].hidden, false);
    gate.paste('https://ward.example/#i=FRESH');
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['EXPIRED', 'FRESH'],
    );
  });

  test('a rate-limited paste is retried as itself', async () => {
    const gate = openGate({ standalone: true, ok: false, status: 429 });
    gate.paste('https://ward.example/#i=CROWDED');
    await gate.answer();
    assert.equal(gate.timers.length, 1);
    gate.tick();
    assert.deepEqual(
      gate.posted.map((p) => p.body.code),
      ['CROWDED', 'CROWDED'],
    );
  });

  test('other query parameters survive the clean-up', async () => {
    const gate = openGate({ standalone: true, search: '?a=1&code=DEAD&b=2' });
    gate.paste('ABCD-EFGH-JKMN-PQRS');
    await gate.answer();
    assert.deepEqual(gate.replaced, ['/?a=1&b=2']);
  });
});
