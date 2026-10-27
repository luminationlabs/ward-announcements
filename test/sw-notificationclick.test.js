/**
 * Where a tapped notification actually lands.
 *
 * Push payloads name a tab (`/#announcements`, see `weeklyMessage()` in schedule-core.ts), because
 * the weekly digest is *about* the announcements and fires at 08:00 Sunday — inside the default
 * 08:00–14:00 program window. Naming the tab only works if the service worker honours it, and the
 * interesting cases are all about a window that is **already open**: a handler that matched a
 * client by pathname alone would leave a member parked on `/#program` with that window merely
 * focused, looking at the program under a notification about the announcements.
 *
 * `sw.js` cannot be imported — it is a service worker, and `npm test` has no such runtime — so it
 * is evaluated verbatim in a `vm` context with the handful of globals it touches stubbed out. The
 * logic under test is the real file, not a copy: only the environment is fake. The source is read
 * from `public/` rather than `dist/` because the worker is never compiled; `app.ts` serves it with
 * the `{{BUILD_ID}}` placeholder substituted, which does not affect anything asserted here.
 *
 * Node only, and deliberately in process. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ORIGIN = 'https://ward.example';
const SW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js'),
  'utf8',
);

/**
 * Evaluate sw.js in a stub worker global and fire one `notificationclick`.
 *
 * Returns the ordered list of things the handler did to the open windows, as
 * `['focus'|'navigate'|'postMessage'|'openWindow', clientUrl, detail?]`, so a test can assert on
 * the decision rather than on the handler's internals.
 */
async function clickNotification({
  openWindows = [],
  url,
  // Both return promises in the real API and both can reject: `focus()` when the browser won't
  // raise the window, `navigate()` when the client isn't controlled by this worker.
  focusRejects = false,
  navigateRejects = false,
}) {
  const actions = [];
  const clients = openWindows.map((clientUrl) => ({
    url: clientUrl,
    focus() {
      actions.push(['focus', clientUrl]);
      return focusRejects ? Promise.reject(new Error('focus refused')) : Promise.resolve(this);
    },
    navigate(to) {
      actions.push(['navigate', clientUrl, to]);
      return navigateRejects
        ? Promise.reject(new TypeError('client is not controlled'))
        : Promise.resolve(this);
    },
    postMessage(message) {
      actions.push(['postMessage', clientUrl, message.type]);
    },
  }));

  const listeners = {};
  const context = vm.createContext({
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      skipWaiting: () => {},
      registration: { showNotification: () => {} },
      clients: {
        matchAll: async () => clients,
        claim: async () => {},
        openWindow: async (target) => {
          actions.push(['openWindow', target]);
        },
      },
    },
    caches: {
      match: async () => undefined,
      open: async () => ({ put: async () => {} }),
      keys: async () => [],
    },
    fetch: async () => ({ ok: true, headers: { get: () => '' }, clone: () => ({}) }),
    URL,
    Response: class {},
    console,
  });
  vm.runInContext(SW_SOURCE, context);

  // Guard the harness itself: if the worker stops registering this event (a rename, a refactor),
  // every assertion below would vacuously pass on an empty action list.
  assert.equal(
    typeof listeners.notificationclick,
    'function',
    'sw.js does not register a notificationclick handler',
  );

  let closed = false;
  const pending = [];
  listeners.notificationclick({
    notification: {
      close() {
        closed = true;
      },
      data: url === undefined ? undefined : { url },
    },
    waitUntil: (p) => pending.push(p),
  });
  await Promise.all(pending);
  assert.ok(closed, 'the notification should be dismissed when it is tapped');
  return actions;
}

const TARGET = '/#announcements';

describe('a tapped notification reaches the tab it named', () => {
  test('a window sitting on the program tab is navigated, not just focused', async () => {
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/#program`],
      url: TARGET,
    });
    assert.deepEqual(actions, [
      ['navigate', `${ORIGIN}/#program`, TARGET],
      ['postMessage', `${ORIGIN}/#program`, 'refresh'],
      ['focus', `${ORIGIN}/#program`],
    ]);
  });

  test('a bare / is navigated too, because the entry rule may have opened it on the program', async () => {
    // The hash is absent, not wrong — `app.js` picks the tab without writing it into the URL — so
    // pathname-only matching would call this window "already there" and leave it on the program.
    const actions = await clickNotification({ openWindows: [`${ORIGIN}/`], url: TARGET });
    assert.deepEqual(actions, [
      ['navigate', `${ORIGIN}/`, TARGET],
      ['postMessage', `${ORIGIN}/`, 'refresh'],
      ['focus', `${ORIGIN}/`],
    ]);
  });

  test('a window already on the target is focused without a pointless navigation', async () => {
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/#announcements`],
      url: TARGET,
    });
    assert.deepEqual(actions, [
      ['postMessage', `${ORIGIN}/#announcements`, 'refresh'],
      ['focus', `${ORIGIN}/#announcements`],
    ]);
  });

  test('an admin tab is never hijacked mid-edit', async () => {
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/admin/announcements/3`],
      url: TARGET,
    });
    assert.deepEqual(actions, [['openWindow', TARGET]], 'the admin tab should be left alone');
  });

  test('an ordinary window is preferred over an admin one', async () => {
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/admin`, `${ORIGIN}/#program`],
      url: TARGET,
    });
    assert.deepEqual(actions, [
      ['navigate', `${ORIGIN}/#program`, TARGET],
      ['postMessage', `${ORIGIN}/#program`, 'refresh'],
      ['focus', `${ORIGIN}/#program`],
    ]);
  });

  test('with nothing open, a new window is opened on the target', async () => {
    const actions = await clickNotification({ openWindows: [], url: TARGET });
    assert.deepEqual(actions, [['openWindow', TARGET]]);
  });

  test('a payload with no url at all still opens the app', async () => {
    const actions = await clickNotification({ openWindows: [], url: undefined });
    assert.deepEqual(actions, [['openWindow', '/']]);
  });

  test('the absolute URL the server actually sends behaves like the relative one', async () => {
    // `buildPushMessage` resolves the payload against PUBLIC_ORIGIN, so what reaches this handler
    // in production is `https://…/#announcements`, not `/#announcements`. Every other case here
    // uses the relative form; this one pins that they agree.
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/#program`],
      url: `${ORIGIN}/#announcements`,
    });
    assert.deepEqual(actions, [
      ['navigate', `${ORIGIN}/#program`, `${ORIGIN}/#announcements`],
      ['postMessage', `${ORIGIN}/#program`, 'refresh'],
      ['focus', `${ORIGIN}/#program`],
    ]);
  });
});

describe('when the browser refuses the reuse', () => {
  test('a window this worker does not control is not focused on the wrong tab', async () => {
    // `matchAll` includes uncontrolled windows, and `navigate()` rejects for those. Focusing it
    // regardless would leave the member on the program under an announcements notification —
    // the exact bug the hash matching fixed — so the fallback is a fresh window on the target.
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/#program`],
      url: TARGET,
      navigateRejects: true,
    });
    assert.deepEqual(actions, [
      ['navigate', `${ORIGIN}/#program`, TARGET],
      ['openWindow', TARGET],
    ]);
  });

  for (const [label, openWindows] of [
    ['a window already on the target', [`${ORIGIN}/#announcements`]],
    ['a navigated window', [`${ORIGIN}/#program`]],
  ]) {
    test(`a rejected focus() on ${label} still opens the app`, async () => {
      const actions = await clickNotification({ openWindows, url: TARGET, focusRejects: true });
      assert.deepEqual(actions.at(-1), ['openWindow', TARGET]);
    });
  }
});

describe('a custom link to another site', () => {
  // The admin's "a specific web link" option. Reusing one of the app's own windows cannot serve it:
  // `navigate()` rejects cross-origin in practice, so the tap would fall through to a bare focus and
  // the link would never open at all.
  test('opens a window rather than hijacking the app', async () => {
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/#announcements`],
      url: 'https://example.org/notes',
    });
    assert.deepEqual(actions, [['openWindow', 'https://example.org/notes']]);
  });

  test("a link to another site's root is not mistaken for the app's own root", async () => {
    // A comparison that ignored origin would treat `https://example.org/` and an open window on
    // `https://ward.example/` as "the same spot" — both pathname `/`, both no hash — and a member
    // tapping a notification pointing at another site would get the app, focused.
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/`],
      url: 'https://example.org/',
    });
    assert.deepEqual(actions, [['openWindow', 'https://example.org/']]);
  });
});

describe('every reused window is told to refetch', () => {
  // The page may not reload on any of these paths: `/` → `/#announcements` is a same-document
  // fragment navigation, and a plain focus navigates nothing at all. Without the message, a member
  // can tap a push and read announcements that predate it.
  for (const [label, openWindows] of [
    ['a focused window', [`${ORIGIN}/#announcements`]],
    ['a navigated window', [`${ORIGIN}/#program`]],
    ['a window with no hash', [`${ORIGIN}/`]],
  ]) {
    test(`${label} gets a refresh message`, async () => {
      const actions = await clickNotification({ openWindows, url: TARGET });
      assert.ok(
        actions.some(([kind, , detail]) => kind === 'postMessage' && detail === 'refresh'),
        'expected a { type: "refresh" } postMessage',
      );
    });
  }

  test('the message is sent before focus, so it cannot wait on a page that is still hidden', async () => {
    // This ordering is why `refreshOnResume({ force: true })` skips the visibility guard as well as
    // the throttle (see public/app.js). If that guard is ever restored, this is the pairing that
    // explains why the forced refresh silently stops happening.
    const actions = await clickNotification({
      openWindows: [`${ORIGIN}/#announcements`],
      url: TARGET,
    });
    const message = actions.findIndex(([kind]) => kind === 'postMessage');
    const focus = actions.findIndex(([kind]) => kind === 'focus');
    assert.ok(message > -1 && focus > -1);
    assert.ok(message < focus, 'the refresh message should be posted before focus()');
  });
});
