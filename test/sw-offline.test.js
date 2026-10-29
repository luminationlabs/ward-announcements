/**
 * What the service worker hands out offline, and what it forgets.
 *
 * The worker keeps a copy of each `/api/*` reply so the app opens on a chapel's failing wifi. Two
 * of those copies are private in a way the cache must respect: the program names people and is for
 * its window only, and every copy is the ward's content, which must not outlive this device's
 * access. Found in an audit: offline on Wednesday, Sunday's cached program was served — names and
 * all — because the fallback never looked at what it was returning.
 *
 * `sw.js` is evaluated verbatim in a `vm` context, as in sw-notificationclick.test.js, with Cache
 * Storage and `fetch` replaced by small fakes. Node only. Run with: npm test
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

/** A cache keyed by pathname. */
function fakeCache(store = new Map()) {
  return {
    store,
    put: async (request, response) => void store.set(new URL(request.url ?? request, ORIGIN).pathname, response),
    match: async (request) => store.get(new URL(request.url ?? request, ORIGIN).pathname)?.clone(),
    delete: async (request) => store.delete(new URL(request.url ?? request, ORIGIN).pathname),
    keys: async () => [...store.keys()].map((path) => new Request(ORIGIN + path)),
  };
}

/**
 * A worker with a cache per name, and a network that `online` decides about. `store` is the
 * per-build cache; `saved` pre-fills the image cache the page saves into (`pushannounce-images`).
 */
function worker({ saved = [] } = {}) {
  const caches = new Map();
  const images = fakeCache();
  for (const path of saved) images.store.set(path, new Response('saved ' + path));
  caches.set('pushannounce-images', images);
  const named = (name) => {
    if (!caches.has(name)) caches.set(name, fakeCache());
    return caches.get(name);
  };
  const net = { online: true, reply: () => new Response('{}'), asked: [] };
  const listeners = {};
  vm.runInContext(
    SW_SOURCE,
    vm.createContext({
      self: {
        location: { origin: ORIGIN },
        addEventListener: (type, fn) => void (listeners[type] = fn),
        skipWaiting: () => {},
        clients: { claim: async () => {} },
      },
      caches: {
        open: async (name) => named(name),
        match: async (request) => {
          for (const cache of caches.values()) {
            const hit = await cache.match(request);
            if (hit) return hit;
          }
          return undefined;
        },
        keys: async () => [...caches.keys()],
        delete: async (name) => caches.delete(name),
      },
      fetch: async (request) => {
        net.asked.push(new URL(request.url).pathname);
        if (!net.online) throw new TypeError('Failed to fetch');
        return net.reply(request);
      },
      URL,
      Response,
      console,
    }),
  );
  const get = async (path) => {
    let reply;
    listeners.fetch({ request: new Request(ORIGIN + path), respondWith: (p) => void (reply = p) });
    return reply;
  };
  const navigate = async (path) => {
    let wait;
    listeners.fetch({
      // Node's Request refuses mode 'navigate' (only a browser makes one), so a request-shaped object.
      request: { url: ORIGIN + path, method: 'GET', mode: 'navigate', headers: new Headers() },
      respondWith: () => {},
      waitUntil: (p) => void (wait = p),
    });
    await wait;
  };
  const message = async (data) => {
    let wait;
    listeners.message({ data, waitUntil: (p) => void (wait = p) });
    await wait;
  };
  const activate = async () => {
    let wait;
    listeners.activate({ waitUntil: (p) => void (wait = p) });
    await wait;
  };
  // The worker reads the saved images when it starts; let that finish, as it would before a page
  // asked for anything.
  const ready = new Promise((resolve) => setTimeout(resolve, 0));
  return {
    get store() {
      return [...caches.entries()].find(([name]) => name !== 'pushannounce-images')?.[1].store ?? new Map();
    },
    ready,
    images,
    caches,
    net,
    get: async (path) => (await ready, get(path)),
    navigate: async (path) => (await ready, navigate(path)),
    getNow: (path) => {
      let reply;
      listeners.fetch({ request: new Request(ORIGIN + path), respondWith: (p) => void (reply = p) });
      return reply;
    },
    message: async (data) => (await ready, message(data)),
    activate,
  };
}

const json = (body, cacheControl = 'private, no-cache') =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl } });

describe('the program offline', () => {
  const program = (closesAt) => ({ open: true, date: '2026-11-01', closesAt, html: '<p>Bishop Smith</p>' });

  test('inside its window, the cached copy is what a dead wifi gets', async () => {
    const sw = worker();
    sw.net.reply = () => json(program(Date.now() + 60 * 60_000));
    await sw.get('/api/program');
    sw.net.online = false;
    const offline = await (await sw.get('/api/program')).json();
    assert.equal(offline.open, true);
    assert.match(offline.html, /Bishop Smith/);
  });

  test('after it, the copy is refused and forgotten, not shown', async () => {
    const sw = worker();
    sw.net.reply = () => json(program(Date.now() - 1));
    await sw.get('/api/program');
    sw.net.online = false;
    const offline = await (await sw.get('/api/program')).json();
    assert.equal(offline.open, false);
    assert.doesNotMatch(JSON.stringify(offline), /Bishop Smith/);
    assert.equal(sw.store.has('/api/program'), false, 'the names are gone from the device');
  });

  test('a copy from before the server said when it closes counts as closed', async () => {
    const sw = worker();
    sw.net.reply = () => json(program(undefined));
    await sw.get('/api/program');
    sw.net.online = false;
    assert.equal((await (await sw.get('/api/program')).json()).open, false);
  });

  test('a closed reply is served from the cache as it was', async () => {
    const sw = worker();
    sw.net.reply = () => json({ open: false, message: 'The program will be here Sunday.' });
    await sw.get('/api/program');
    sw.net.online = false;
    assert.equal((await (await sw.get('/api/program')).json()).message, 'The program will be here Sunday.');
  });
});

describe('uploaded images', () => {
  // A download the worker relays dies with it: on iOS an updated worker taking over during a cold
  // launch of the home-screen app cancelled every image in flight, and flyers showed as broken
  // boxes. So the worker never relays a download: a new image goes to the browser, the page saves
  // a copy (public/app.js), and the worker answers that copy from then on.
  const IMG = '/images/0123456789abcdef0123456789abcdef.jpg';

  test('a new image is not intercepted, so the browser fetches it itself', async () => {
    const sw = worker();
    assert.equal(await sw.get(IMG), undefined, 'respondWith not called');
    assert.deepEqual(sw.net.asked, [], 'and the worker did not download it either');
    assert.ok(await sw.get('/api/announcements'), 'everything else still goes through it');
  });

  test('a saved image is answered from the saved copy, offline too, without the network', async () => {
    const sw = worker({ saved: [IMG] });
    sw.net.online = false;
    assert.equal(await (await sw.get(IMG)).text(), 'saved ' + IMG);
    assert.deepEqual(sw.net.asked, []);
  });

  test('an image asked for before the worker has read its saved list still gets the saved copy', async () => {
    const sw = worker({ saved: [IMG] });
    sw.net.online = false;
    const reply = sw.getNow(IMG); // no waiting for the startup read
    assert.ok(reply, 'answered, not left to the network');
    assert.equal(await (await reply).text(), 'saved ' + IMG);
  });

  test('the page saving or pruning an image is picked up without a restart', async () => {
    const sw = worker();
    await sw.images.put(new Request(ORIGIN + IMG), new Response('just saved'));
    await sw.message({ type: 'image-saved', path: IMG });
    assert.equal(await (await sw.get(IMG)).text(), 'just saved');

    await sw.images.delete(new Request(ORIGIN + IMG));
    await sw.message({ type: 'images-changed' });
    assert.equal(await sw.get(IMG), undefined, 'pruned: back to the browser');
  });

  test('a copy saved without the worker hearing of it is picked up on the next page load', async () => {
    const sw = worker();
    await sw.ready;
    await sw.images.put(new Request(ORIGIN + IMG), new Response('saved meanwhile')); // no message
    assert.equal(await sw.get(IMG), undefined, 'not known yet');
    await sw.navigate('/');
    assert.equal(await (await sw.get(IMG)).text(), 'saved meanwhile');
  });

  test('a saved copy that has gone since is fetched rather than failed', async () => {
    const sw = worker({ saved: [IMG] });
    await sw.ready; // the worker has read the cache, then the copy goes
    await sw.images.delete(new Request(ORIGIN + IMG));
    sw.net.reply = () => new Response('from the network');
    assert.equal(await (await sw.get(IMG)).text(), 'from the network');
  });

  test('an update keeps the saved images and drops the old build cache', async () => {
    const sw = worker({ saved: [IMG] });
    sw.caches.set('pushannounce-oldbuild', fakeCache());
    await sw.activate();
    assert.deepEqual([...sw.caches.keys()].sort(), ['pushannounce-images']);
  });
});

describe('losing access', () => {
  test('a 401 from the API drops every private copy, and leaves the app shell', async () => {
    const sw = worker();
    sw.net.reply = (request) =>
      new URL(request.url).pathname === '/' ? new Response('<html>') : json({ announcements: [{ title: 'Picnic' }] });
    for (const path of ['/', '/api/announcements', '/api/pages']) await sw.get(path);
    assert.equal(sw.store.size, 3);

    sw.net.reply = () => new Response('', { status: 401 });
    await sw.get('/api/announcements');
    assert.deepEqual([...sw.store.keys()], ['/'], 'only the shell is left');
  });
});
