/**
 * The silent update path, and why a member sees one flash on reopening the app rather than two.
 *
 * A deploy changes the shell's content hash, which renames the service worker's cache, which makes
 * the browser install the new worker; the page then reloads once so the new assets are running.
 * An unconditional reload would include a cold open that had *just* fetched the new shell from the
 * network, where it is a second flash for nothing. So the page carries its own build id, asks the worker that took over for its, and reloads only when they differ. The three
 * pieces are tested where they live: `buildShell` (both ids come from one hash), `sw.js` (the reply)
 * and the two `app.js` helpers (the decision, and the render swap that skips identical content).
 *
 * `app.js` cannot be evaluated whole here — it greets a dozen elements by id on line one — so the
 * two helpers are lifted out of the real source by name and run in a `vm` with the few globals they
 * touch stubbed. If either is renamed the test fails loudly rather than passing on nothing.
 *
 * Node only, in process. Run with: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { loadConfig } from '../dist/config.js';
import { buildShell } from '../dist/shell.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (name) => readFileSync(join(PUBLIC, name), 'utf8');
const APP_SOURCE = read('app.js');
const SW_SOURCE = read('sw.js');

before(() => {
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
});

/** Pull one top-level `function name(...) {...}` out of app.js by scanning braces. */
function liftFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js does not define ${name}()`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${name}`);
}

describe('the build id', () => {
  test('is stamped identically into the page and the worker', async () => {
    const sources = {
      index: read('index.html'),
      sw: SW_SOURCE,
      iosSplash: '',
      assets: ['app.js', 'install.js', 'styles.css'].map(read),
    };
    const shell = await buildShell(sources);
    assert.match(shell.buildId, /^[0-9a-f]{12}$/u);
    assert.ok(
      shell.indexHtml.includes(`<meta name="build-id" content="${shell.buildId}" />`),
      'index.html should carry the build id in a meta tag',
    );
    assert.ok(
      shell.swSource.includes(`const BUILD_ID = '${shell.buildId}';`),
      'sw.js should carry the same build id',
    );
    assert.ok(!shell.indexHtml.includes('{{BUILD_ID}}') && !shell.swSource.includes('{{BUILD_ID}}'));

    // The whole point: the id follows the assets. A one-byte change to a cached asset is a new id.
    const changed = await buildShell({ ...sources, assets: [...sources.assets.slice(0, 3), 'a{}'] });
    assert.notEqual(changed.buildId, shell.buildId);
  });
});

describe('sw.js answers "which build are you?"', () => {
  function loadWorker() {
    const listeners = {};
    const context = vm.createContext({
      self: {
        location: { origin: 'https://ward.example' },
        addEventListener: (type, fn) => {
          listeners[type] = fn;
        },
        skipWaiting: () => {},
        registration: {},
        clients: {},
      },
      importScripts: () => {},
      caches: {},
      URL,
      Response: class {},
      console,
    });
    vm.runInContext(SW_SOURCE.replaceAll('{{BUILD_ID}}', 'abc123def456'), context);
    assert.equal(typeof listeners.message, 'function', 'sw.js does not handle messages');
    return listeners.message;
  }

  test('on the port the page sent', () => {
    const onMessage = loadWorker();
    const replies = [];
    const sourceReplies = [];
    onMessage({
      data: { type: 'build-id' },
      ports: [{ postMessage: (m) => replies.push(m) }],
      source: { postMessage: (m) => sourceReplies.push(m) },
    });
    // JSON, not deepEqual: objects born in the vm context have a different Object prototype.
    assert.equal(JSON.stringify(replies), JSON.stringify([{ type: 'build-id', buildId: 'abc123def456' }]));
    assert.equal(sourceReplies.length, 0, 'with a port, the client itself is not messaged');
  });

  test('to the client when there is no port, and not at all to other messages', () => {
    const onMessage = loadWorker();
    const sourceReplies = [];
    const source = { postMessage: (m) => sourceReplies.push(m) };
    onMessage({ data: { type: 'build-id' }, ports: [], source });
    assert.equal(JSON.stringify(sourceReplies), JSON.stringify([{ type: 'build-id', buildId: 'abc123def456' }]));
    onMessage({ data: { type: 'refresh' }, ports: [], source });
    onMessage({ data: null, ports: [], source });
    assert.equal(sourceReplies.length, 1);
  });
});

describe('the page reloads only for a different build', () => {
  /**
   * Run `controllerHasOtherBuild()` with a page build id and a controller that answers `reply`
   * (or never answers, when `reply` is undefined). Timers are real but short-circuited: the 2 s
   * fallback fires immediately here so a silent controller doesn't slow the suite.
   */
  async function decide({ mine, reply, throws = false }) {
    let port2;
    const context = vm.createContext({
      document: {
        querySelector: (sel) =>
          sel === 'meta[name="build-id"]' && mine !== undefined ? { content: mine } : null,
      },
      navigator: {
        serviceWorker: {
          controller: {
            postMessage(message, transfer) {
              if (throws) throw new Error('detached');
              assert.equal(message && message.type, 'build-id');
              port2 = transfer[0];
              if (reply !== undefined) port2.deliver({ data: reply });
            },
          },
        },
      },
      MessageChannel: class {
        constructor() {
          const self = this;
          this.port1 = { onmessage: null };
          this.port2 = {
            deliver(event) {
              // Asynchronous like a real port: the handler is assigned after postMessage returns.
              setTimeout(() => self.port1.onmessage && self.port1.onmessage(event), 0);
            },
          };
        }
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms >= 2000 ? 5 : ms),
      clearTimeout,
      Promise,
    });
    vm.runInContext(liftFunction(APP_SOURCE, 'controllerHasOtherBuild'), context);
    return vm.runInContext('controllerHasOtherBuild()', context);
  }

  test('the same build id means no reload — the cold-open case', async () => {
    assert.equal(await decide({ mine: 'aaa', reply: { type: 'build-id', buildId: 'aaa' } }), false);
  });
  test('a different build id means reload — the resumed-stale-page case', async () => {
    assert.equal(await decide({ mine: 'aaa', reply: { type: 'build-id', buildId: 'bbb' } }), true);
  });
  test('when it cannot tell, it reloads, as it always did', async () => {
    assert.equal(await decide({ mine: undefined, reply: { buildId: 'aaa' } }), true, 'no meta tag');
    assert.equal(await decide({ mine: 'aaa', reply: undefined }), true, 'no answer');
    assert.equal(await decide({ mine: 'aaa', reply: { type: 'build-id' } }), true, 'empty answer');
    assert.equal(await decide({ mine: 'aaa', throws: true }), true, 'postMessage threw');
  });
});

describe('a resume that fetched identical content repaints nothing', () => {
  /** A node with just enough of the DOM for swapIfChanged: innerHTML in, replaceChildren out. */
  function node(html) {
    return {
      innerHTML: html,
      childNodes: [html],
      replaced: 0,
      replaceChildren(...children) {
        this.replaced++;
        this.innerHTML = children.join('');
      },
    };
  }
  const context = vm.createContext({});
  vm.runInContext(liftFunction(APP_SOURCE, 'swapIfChanged'), context);
  const swap = (target, next) => vm.runInContext('swapIfChanged', context)(target, next);

  test('identical markup is left alone', () => {
    const target = node('<article>Same</article>');
    assert.equal(swap(target, node('<article>Same</article>')), false);
    assert.equal(target.replaced, 0);
  });
  test('changed markup is swapped in', () => {
    const target = node('<article>Old</article>');
    assert.equal(swap(target, node('<article>New</article>')), true);
    assert.equal(target.replaced, 1);
    assert.equal(target.innerHTML, '<article>New</article>');
  });
  test('the render paths all go through it', () => {
    // Four call sites: announcements (empty + list) and program (closed + open). The failure
    // messages still write to the containers directly — they replace content by definition.
    const calls = APP_SOURCE.match(/swapIfChanged\((listEl|programContent), next\)/gu) ?? [];
    assert.equal(calls.length, 4, 'expected each render outcome to swap through swapIfChanged');
  });
});

// A subscription is bound to the VAPID key it was made with. After the server's key changes (a
// restore that didn't carry the keys, a move to a new host), every push to it is refused, while the
// page's re-sync on each visit kept the server's failure count at zero and the toggle on — a member
// who stopped hearing from the ward with nothing on the phone to say so. Both the page and the
// worker now compare the key and replace a stale subscription.
describe('a changed VAPID key is noticed and the subscription replaced', () => {
  const keyBytes = (fill) => {
    const bytes = new Uint8Array(65).fill(fill);
    bytes[0] = 4;
    return bytes;
  };
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
  const OLD = keyBytes(1);
  const NEW = keyBytes(2);

  /** A fake PushManager whose current subscription was made with `made`. */
  function pushManager({ made, subscribeThrows = false }) {
    const log = [];
    const sub = (endpoint, key) => ({
      endpoint,
      options: { applicationServerKey: key.buffer.slice(0) },
      async unsubscribe() {
        log.push(`unsubscribe ${endpoint}`);
        if (pm.current === this) pm.current = null;
        return true;
      },
      toJSON() {
        return { endpoint, keys: { p256dh: 'p', auth: 'a' } };
      },
    });
    const pm = {
      log,
      current: made ? sub('https://push.example/old', made) : null,
      async getSubscription() {
        return pm.current;
      },
      async subscribe(options) {
        if (subscribeThrows) throw new Error('NotAllowedError');
        // A browser refuses a second key while one subscription stands.
        if (pm.current) throw new Error('InvalidStateError');
        log.push(`subscribe ${b64url(new Uint8Array(options.applicationServerKey))}`);
        pm.current = sub('https://push.example/new', new Uint8Array(options.applicationServerKey));
        return pm.current;
      },
    };
    return pm;
  }

  /**
   * The server: the current key, and a record of what was posted where. `blocked` makes it answer
   * `/api/subscribe` as it does for a device an admin removed under Subscribers — 409, `blocked` —
   * unless the post carries `deliberate: true` (the Enable Notifications tap).
   */
  function server(key, { blocked = false } = {}) {
    const posts = [];
    return {
      posts,
      fetch: async (url, init) => {
        if (url === '/api/vapid-public-key') return { ok: true, json: async () => ({ key: b64url(key) }) };
        const body = JSON.parse(init.body);
        posts.push({ url, body });
        if (url === '/api/subscribe' && blocked && body.deliberate !== true) {
          return { ok: false, status: 409, json: async () => ({ error: 'removed', blocked: true }) };
        }
        return { ok: true, status: 201, json: async () => ({}) };
      },
    };
  }

  describe('in the page (app.js)', () => {
    function page({ pm, srv }) {
      const status = [];
      let redraws = 0;
      const registration = { pushManager: pm };
      const context = vm.createContext({
        fetch: srv.fetch,
        atob,
        PUSH_CALL_TIMEOUT_MS: 8000,
        setTimeout,
        clearTimeout,
        setStatus: (t) => status.push(t),
        refreshSubscriptionUI: async () => void redraws++,
        // What the Enable Notifications tap (`subscribe`) touches besides the push manager.
        enableBtn: { disabled: false },
        Notification: { requestPermission: async () => 'granted' },
        navigator: { serviceWorker: { ready: Promise.resolve(registration) } },
      });
      for (const name of ['urlBase64ToUint8Array', 'withTimeout', 'sameServerKey'])
        vm.runInContext(liftFunction(APP_SOURCE, name), context);
      for (const name of ['syncSubscription', 'renewIfKeyChanged', 'subscribe'])
        vm.runInContext('async ' + liftFunction(APP_SOURCE, name), context);
      // The launch path in main(): renew if the key changed, then re-sync, then warn on a refusal.
      const run = async () => {
        const renewed = await context.renewIfKeyChanged(registration, pm.current);
        if (renewed) {
          const synced = await context.syncSubscription(registration, renewed.subscription, renewed.oldEndpoint);
          if (synced === false) status.push("We couldn't confirm your notifications with the server");
          return synced;
        }
        return renewed;
      };
      const tapEnable = () => context.subscribe();
      return { run, tapEnable, status, redraws: () => redraws };
    }

    test('a matching key is left alone', async () => {
      const pm = pushManager({ made: OLD });
      const srv = server(OLD);
      await page({ pm, srv }).run();
      assert.deepEqual(pm.log, [], 'no unsubscribe, no subscribe');
      assert.deepEqual(srv.posts.map((p) => p.url), ['/api/subscribe']);
      assert.equal(srv.posts[0].body.oldEndpoint, undefined);
    });

    test('a different key: unsubscribe, subscribe with the new one, and the server drops the old', async () => {
      const pm = pushManager({ made: OLD });
      const srv = server(NEW);
      await page({ pm, srv }).run();
      assert.deepEqual(pm.log, ['unsubscribe https://push.example/old', `subscribe ${b64url(NEW)}`]);
      assert.equal(srv.posts.length, 1);
      assert.equal(srv.posts[0].url, '/api/subscribe');
      assert.equal(srv.posts[0].body.endpoint, 'https://push.example/new');
      assert.equal(srv.posts[0].body.oldEndpoint, 'https://push.example/old');
    });

    test('a browser that will not subscribe without a tap is told so, not left "on"', async () => {
      const pm = pushManager({ made: OLD, subscribeThrows: true });
      const srv = server(NEW);
      const p = page({ pm, srv });
      assert.equal(await p.run(), null);
      assert.equal(pm.current, null, 'the dead subscription is gone, so the card reads off');
      assert.equal(p.redraws(), 1);
      assert.match(p.status.at(-1), /turning on again/);
      assert.deepEqual(srv.posts.map((x) => `${x.url} ${x.body.endpoint}`), [
        '/api/unsubscribe https://push.example/old',
      ]);
    });

    test('the launch re-sync never claims to be deliberate', async () => {
      const pm = pushManager({ made: OLD });
      const srv = server(OLD);
      await page({ pm, srv }).run();
      assert.equal(srv.posts[0].body.deliberate, undefined);
    });

    test('a device the ward removed: the launch re-sync turns notifications off and says so, without the "couldn\'t confirm" warning', async () => {
      const pm = pushManager({ made: OLD });
      const srv = server(OLD, { blocked: true });
      const p = page({ pm, srv });
      assert.equal(await p.run(), 'blocked');
      assert.deepEqual(pm.log, ['unsubscribe https://push.example/old'], 'the subscription is dropped on the device');
      assert.equal(pm.current, null, 'so the card reads off');
      assert.equal(p.redraws(), 1);
      assert.match(p.status.at(-1), /The ward removed notifications for this device\. Tap Enable Notifications/);
      assert.ok(!p.status.some((t) => /couldn't confirm/.test(t)), 'a block is not a failure to confirm');
    });

    test('the Enable Notifications tap is deliberate, and lifts the block', async () => {
      const pm = pushManager({ made: null });
      const srv = server(OLD, { blocked: true });
      const p = page({ pm, srv });
      await p.tapEnable();
      const post = srv.posts.find((x) => x.url === '/api/subscribe');
      assert.equal(post.body.deliberate, true);
      assert.ok(pm.current, 'the subscription stands: the server took it');
      assert.ok(!p.status.some((t) => /couldn't turn on/.test(t)));
    });
  });

  describe('in the service worker (sw.js)', () => {
    function worker({ pm, srv }) {
      const listeners = {};
      vm.runInContext(
        SW_SOURCE,
        vm.createContext({
          self: {
            location: { origin: 'https://ward.example' },
            addEventListener: (type, fn) => void (listeners[type] = fn),
            skipWaiting: () => {},
            registration: { pushManager: pm },
            clients: {},
          },
          caches: {},
          fetch: srv.fetch,
          atob,
          URL,
          Response: class {},
          console,
        }),
      );
      return async (type, event) => {
        let done;
        listeners[type]({ ...event, waitUntil: (p) => void (done = p) });
        await done;
      };
    }

    test('a Background Sync re-sync replaces a stale-key subscription', async () => {
      const pm = pushManager({ made: OLD });
      const srv = server(NEW);
      await worker({ pm, srv })('sync', { tag: 'resync-subscription' });
      assert.deepEqual(pm.log, ['unsubscribe https://push.example/old', `subscribe ${b64url(NEW)}`]);
      assert.equal(srv.posts[0].body.endpoint, 'https://push.example/new');
      assert.equal(srv.posts[0].body.oldEndpoint, 'https://push.example/old');
    });

    test('and leaves a current one as it is', async () => {
      const pm = pushManager({ made: NEW });
      const srv = server(NEW);
      await worker({ pm, srv })('sync', { tag: 'resync-subscription' });
      assert.deepEqual(pm.log, []);
      assert.equal(srv.posts[0].body.endpoint, 'https://push.example/old');
      assert.equal(srv.posts[0].body.oldEndpoint, undefined);
    });

    test('pushsubscriptionchange: the server is told to drop the subscription it knew', async () => {
      // The browser's replacement was minted with the old key too; it never reached the server.
      const pm = pushManager({ made: OLD });
      const srv = server(NEW);
      const fresh = pm.current;
      await worker({ pm, srv })('pushsubscriptionchange', {
        oldSubscription: { endpoint: 'https://push.example/known' },
        newSubscription: fresh,
      });
      assert.deepEqual(pm.log, ['unsubscribe https://push.example/old', `subscribe ${b64url(NEW)}`]);
      assert.equal(srv.posts[0].body.oldEndpoint, 'https://push.example/known');
    });

    test('a device the ward removed: the re-sync drops the subscription instead of retrying, and never claims to be deliberate', async () => {
      const pm = pushManager({ made: NEW });
      const srv = server(NEW, { blocked: true });
      // Resolves rather than throws: a throw is what asks the browser to retry the sync, and no
      // retry changes an admin's decision.
      await worker({ pm, srv })('sync', { tag: 'resync-subscription' });
      assert.equal(srv.posts[0].body.deliberate, undefined);
      assert.deepEqual(pm.log, ['unsubscribe https://push.example/old']);
      assert.equal(pm.current, null, 'the next launch shows the card off');
    });
  });
});
