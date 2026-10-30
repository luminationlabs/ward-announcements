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

/**
 * A cache keyed by pathname. With `holdKeys` set, each `keys()` takes its snapshot when called but
 * answers only when its entry in `heldKeys` is released, so a test can finish reads in any order.
 */
function fakeCache(store = new Map()) {
  const cache = {
    store,
    holdKeys: false,
    heldKeys: [],
    put: async (request, response) => void store.set(new URL(request.url ?? request, ORIGIN).pathname, response),
    match: async (request) => store.get(new URL(request.url ?? request, ORIGIN).pathname)?.clone(),
    delete: async (request) => store.delete(new URL(request.url ?? request, ORIGIN).pathname),
    keys: async () => {
      const snapshot = [...store.keys()].map((path) => new Request(ORIGIN + path));
      if (!cache.holdKeys) return snapshot;
      return new Promise((resolve) => cache.heldKeys.push(() => resolve(snapshot)));
    },
  };
  return cache;
}

/** This build's cache: sw.js is evaluated with its placeholder unsubstituted. */
const CURRENT = 'pushannounce-{{BUILD_ID}}';

/**
 * A worker with a cache per name, and a network that `online` decides about. `store` is this
 * build's cache; `saved` pre-fills the image cache the page saves into (`pushannounce-images`).
 * `instantTimers` makes the worker's timers fire at once (its install budget), and a path in
 * `net.hang` never answers until the fetch is aborted.
 */
function worker({ saved = [], instantTimers = false } = {}) {
  const caches = new Map();
  const images = fakeCache();
  for (const path of saved) images.store.set(path, new Response('saved ' + path));
  caches.set('pushannounce-images', images);
  const named = (name) => {
    if (!caches.has(name)) caches.set(name, fakeCache());
    return caches.get(name);
  };
  const net = { online: true, reply: () => new Response('{}'), asked: [], hang: new Set() };
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
      fetch: async (input, init = {}) => {
        // The worker fetches by Request (the fetch handler) or by path (saving the shell).
        const request = typeof input === 'string' ? new Request(ORIGIN + input) : input;
        const path = new URL(request.url).pathname;
        net.asked.push(path);
        if (!net.online) throw new TypeError('Failed to fetch');
        if (net.hang.has(path)) {
          return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        }
        return net.reply(request);
      },
      setTimeout: instantTimers ? (fn) => setTimeout(fn, 0) : setTimeout,
      clearTimeout,
      AbortController,
      DOMException,
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
  const install = async () => {
    let wait;
    listeners.install({ waitUntil: (p) => void (wait = p) });
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
      return named(CURRENT).store;
    },
    ready,
    images,
    caches,
    net,
    get: async (path) => (await ready, get(path)),
    navigate: async (path) => (await ready, navigate(path)),
    /** A fetch event now, without waiting for the startup read; a path, or a full URL. */
    getNow: (path) => {
      let reply;
      const url = path.startsWith('http') ? path : ORIGIN + path;
      listeners.fetch({ request: new Request(url), respondWith: (p) => void (reply = p), waitUntil: () => {} });
      return reply;
    },
    /** A page load, not waited on: its reread of the saved images is still under way. */
    navigateNow: (path) => {
      listeners.fetch({
        request: { url: ORIGIN + path, method: 'GET', mode: 'navigate', headers: new Headers() },
        respondWith: () => {},
        waitUntil: () => {},
      });
    },
    message: async (data) => (await ready, message(data)),
    install,
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

  test('an image asked for before the worker has read its list is left to the browser, never relayed', async () => {
    // A worker woken by this launch: waiting for its read would mean relaying any image that turned
    // out not to be saved, and every launch lost its images that way on iOS when an update took over.
    const sw = worker({ saved: [IMG] });
    assert.equal(sw.getNow(IMG), undefined, 'not intercepted');
    assert.ok(!sw.net.asked.includes(IMG), 'not downloaded by the worker');
  });

  test('offline, once the page reports the saved copy, its retry is answered from it', async () => {
    // The page's half: an image that failed and has a saved copy is reported (reportSavedImage).
    const sw = worker();
    await sw.ready;
    await sw.images.put(new Request(ORIGIN + IMG), new Response('saved')); // the list never heard
    sw.net.online = false;
    assert.equal(await sw.get(IMG), undefined, 'first try: left to the browser, which fails');
    await sw.message({ type: 'image-saved', path: IMG });
    assert.equal(await (await sw.get(IMG)).text(), 'saved', 'the retry');
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

  test('an unsaved image is never relayed while a page load rereads the list', async () => {
    // Waiting for the reread would promise an answer, and an image that is not saved would then be
    // relayed — cancelled on iOS when an update takes over (4 launches in 5 when this waited).
    const sw = worker();
    await sw.ready;
    sw.navigateNow('/');
    assert.equal(sw.getNow(IMG), undefined, 'left to the browser');
    assert.ok(!sw.net.asked.includes(IMG), 'and not downloaded by the worker');
  });

  test('a save reported while a reread is under way is not lost to its snapshot', async () => {
    const sw = worker();
    await sw.ready;
    sw.images.holdKeys = true;
    sw.navigateNow('/'); // a reread, whose snapshot is taken before the save below
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sw.images.heldKeys.length, 1, 'the reread has its snapshot');
    await sw.images.put(new Request(ORIGIN + IMG), new Response('just saved')); // the page saves,
    await sw.message({ type: 'image-saved', path: IMG }); // then says so
    sw.images.heldKeys[0](); // the reread finishes with its older snapshot
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(await (await sw.getNow(IMG)).text(), 'just saved');
  });

  test('another origin\'s /images/ path is not mistaken for a saved image', async () => {
    const sw = worker({ saved: [IMG] });
    await sw.ready;
    sw.net.reply = () => new Response('from elsewhere');
    assert.equal(await (await sw.getNow('https://elsewhere.example' + IMG)).text(), 'from elsewhere');
  });

  test('a saved copy that has gone since fails rather than being relayed, and leaves the list', async () => {
    // Pruned in a race with a save, or evicted: relaying it is the cancellation all of this avoids.
    const sw = worker({ saved: [IMG] });
    await sw.ready;
    await sw.images.delete(new Request(ORIGIN + IMG));
    const reply = await sw.get(IMG);
    assert.equal(reply.type, 'error');
    assert.ok(!sw.net.asked.includes(IMG), 'not downloaded by the worker');
    assert.equal(await sw.get(IMG), undefined, 'the retry is left to the browser');
  });

  test('an unreadable image cache fails the image rather than relaying it, and only once', async () => {
    const sw = worker({ saved: [IMG] });
    await sw.ready;
    sw.images.match = async () => {
      throw new Error('storage gone');
    };
    assert.equal((await sw.get(IMG)).type, 'error');
    assert.ok(!sw.net.asked.includes(IMG));
    assert.equal(await sw.get(IMG), undefined, 'the retry is left to the browser');
  });

  test('a read that finishes after a newer one does not undo it', async () => {
    // A page load's reread overtaken by a prune's: applied last, the older snapshot would put a
    // pruned image back on the list, and the worker would answer it from a copy that is gone.
    const sw = worker({ saved: [IMG] });
    await sw.ready;
    sw.images.holdKeys = true;
    sw.navigateNow('/'); // read A: its snapshot still has the image
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sw.images.delete(new Request(ORIGIN + IMG)); // pruned
    sw.message({ type: 'images-changed' }); // read B: without it
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sw.images.heldKeys.length, 2, 'both reads waiting');
    sw.images.heldKeys[1](); // B finishes first
    await new Promise((resolve) => setTimeout(resolve, 0));
    sw.images.heldKeys[0](); // then A
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sw.getNow(IMG), undefined, 'the prune stands');
  });

  test('an update keeps the saved images and drops the old build cache', async () => {
    const sw = worker({ saved: [IMG] });
    sw.caches.set('pushannounce-oldbuild', fakeCache());
    await sw.activate();
    assert.ok(!sw.caches.has('pushannounce-oldbuild'), 'old build cache deleted');
    assert.ok(sw.images.store.has(IMG), 'saved images kept');
  });
});

describe('an update', () => {
  // Activation deletes the previous build's cache, which held the page a member had just opened and
  // the last replies; nothing saved them again until the next page load, so the app opened offline
  // in between to a blank page. The new build saves its own shell on install and carries the
  // replies over.
  // The manifest is not in it: it carries the device token and is served `no-store`.
  const SHELL = ['/', '/app.js', '/install.js', '/styles.css', '/img/install/close.svg'];
  const page = (path) => new Response('shell ' + path, { headers: { 'Cache-Control': 'no-cache' } });
  const IMAGE = '/images/0123456789abcdef0123456789abcdef.jpg';

  test('installing saves the shell into the new build cache', async () => {
    const sw = worker();
    sw.net.reply = (request) => page(new URL(request.url).pathname);
    await sw.install();
    assert.deepEqual([...sw.store.keys()].sort(), [...SHELL].sort());
  });

  test('never the gate page, a failure or a refusal, and the install still completes', async () => {
    const sw = worker();
    sw.net.reply = (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response('gate', { headers: { 'Cache-Control': 'no-store' } }); // cookie lapsed
      if (path === '/styles.css') throw new TypeError('Failed to fetch');
      if (path === '/install.js') return new Response('', { status: 500 });
      if (path === '/img/install/close.svg') {
        const moved = page(path);
        Object.defineProperty(moved, 'redirected', { value: true }); // followed a redirect somewhere
        return moved;
      }
      return page(path);
    };
    await sw.install();
    assert.deepEqual([...sw.store.keys()], ['/app.js']);
  });

  test('a fetch that never answers does not hold the install up past its budget', async () => {
    const sw = worker({ instantTimers: true });
    sw.net.hang.add('/');
    sw.net.reply = (request) => page(new URL(request.url).pathname);
    await sw.install(); // resolves: the budget aborted the hung fetch
    assert.ok(!sw.store.has('/'));
  });

  test('activating carries the previous build\'s replies over, not its shell, and drops it', async () => {
    const sw = worker();
    const old = fakeCache();
    old.store.set('/', page('/'));
    old.store.set('/api/announcements', json({ announcements: [{ title: 'Old copy' }] }));
    old.store.set('/api/pages', json({ pages: [] }));
    sw.caches.set('pushannounce-oldbuild', old);
    // This build already has a newer copy of one of them (an API fetch it relayed before the old
    // cache went, or an older cache recreated by a late write).
    sw.store.set('/api/announcements', json({ announcements: [{ title: 'Fetched by the new build' }] }));
    await sw.activate();
    assert.ok(!sw.caches.has('pushannounce-oldbuild'), 'old build cache deleted');
    assert.deepEqual([...sw.store.keys()].sort(), ['/api/announcements', '/api/pages']);
    sw.net.online = false;
    const kept = await (await sw.get('/api/announcements')).json();
    assert.equal(kept.announcements[0].title, 'Fetched by the new build', 'the newer copy is not overwritten');
  });

  test('images an older worker kept in its build cache move to the saved images', async () => {
    const sw = worker();
    const old = fakeCache();
    old.store.set(IMAGE, new Response('kept by the old worker'));
    sw.caches.set('pushannounce-oldbuild', old);
    await sw.activate();
    sw.net.online = false;
    assert.equal(await (await sw.get(IMAGE)).text(), 'kept by the old worker');
  });

  test('offline after an update, the app still opens with its last announcements', async () => {
    const sw = worker();
    const old = fakeCache();
    old.store.set('/api/announcements', json({ announcements: [{ title: 'Picnic' }] }));
    sw.caches.set('pushannounce-oldbuild', old);
    sw.net.reply = (request) => page(new URL(request.url).pathname);
    await sw.install();
    await sw.activate();
    sw.net.online = false;
    assert.equal(await (await sw.get('/')).text(), 'shell /');
    assert.equal((await (await sw.get('/api/announcements')).json()).announcements[0].title, 'Picnic');
  });
});

describe("the page's half (public/app.js)", () => {
  // The page saves a loaded image, reports a saved copy when an image fails, and prunes copies no
  // longer shown; the worker only answers what the page has saved.
  const APP_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  /** One top-level function from app.js, `async` included, by scanning braces. */
  const lift = (name) => {
    const start = APP_SOURCE.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `app.js does not define ${name}()`);
    const prefix = APP_SOURCE.slice(start - 6, start) === 'async ' ? 'async ' : '';
    let depth = 0;
    for (let i = APP_SOURCE.indexOf('{', start); i < APP_SOURCE.length; i++) {
      if (APP_SOURCE[i] === '{') depth++;
      else if (APP_SOURCE[i] === '}' && --depth === 0) return prefix + APP_SOURCE.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces after ${name}`);
  };
  const IMG = '/images/0123456789abcdef0123456789abcdef.jpg';
  const OTHER = '/images/fedcba9876543210fedcba9876543210.jpg';
  const img = (path) => ({ src: ORIGIN + path, getAttribute: () => path });

  function page({ saved = [], shown = [], reply = () => new Response('img') } = {}) {
    const cache = fakeCache();
    for (const path of saved) cache.store.set(path, new Response('saved'));
    const posted = [];
    const fetched = [];
    const list = { querySelectorAll: () => shown.map(img) };
    const context = vm.createContext({
      window: { caches: true },
      caches: { open: async () => cache },
      location: { href: ORIGIN + '/' },
      // Copied out of the vm's realm, so deepEqual compares values rather than prototypes.
      navigator: { serviceWorker: { controller: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) } } },
      fetch: async (path) => (fetched.push(path), reply(path)),
      listEl: list,
      resourcesList: { querySelectorAll: () => [] },
      URL,
      Request,
      Response,
    });
    const constLine = (name) => APP_SOURCE.split('\n').find((l) => l.startsWith(`const ${name}`));
    vm.runInContext(
      [constLine('IMAGE_CACHE'), constLine('imagesListed').replace('const ', 'var '), lift('saveImageForOffline'), lift('reportSavedImage'), lift('pruneSavedImages')].join('\n'),
      context,
    );
    return { cache, posted, fetched, run: (code) => vm.runInContext(code, context), context };
  }

  test('a loaded image is saved once and the worker told; already saved, only told again', async () => {
    const p = page();
    await p.context.saveImageForOffline(img(IMG));
    assert.ok(p.cache.store.has(IMG));
    assert.deepEqual(p.posted, [{ type: 'image-saved', path: IMG }]);
    await p.context.saveImageForOffline(img(IMG));
    assert.equal(p.fetched.length, 1, 'not downloaded again');
    assert.equal(p.posted.length, 2, 'but the worker is reminded, in case it missed the first');
  });

  test('a no-store image (a program\'s) is never saved', async () => {
    const p = page({ reply: () => new Response('names', { headers: { 'Cache-Control': 'private, no-store' } }) });
    await p.context.saveImageForOffline(img(IMG));
    assert.equal(p.cache.store.size, 0);
    assert.deepEqual(p.posted, []);
  });

  test('a failed image is reported only if a copy is saved', async () => {
    const p = page({ saved: [IMG] });
    await p.context.reportSavedImage(img(OTHER));
    assert.deepEqual(p.posted, []);
    await p.context.reportSavedImage(img(IMG));
    assert.deepEqual(p.posted, [{ type: 'image-saved', path: IMG }]);
  });

  test('pruning keeps what is shown, only after both sections rendered from a real reply', async () => {
    const p = page({ saved: [IMG, OTHER], shown: [IMG] });
    await p.context.pruneSavedImages();
    assert.equal(p.cache.store.size, 2, 'not before the sections have rendered');
    p.run('imagesListed.announcements = true; imagesListed.resources = false');
    await p.context.pruneSavedImages();
    assert.equal(p.cache.store.size, 2, 'not while one shows an error');
    p.run('imagesListed.resources = true');
    await p.context.pruneSavedImages();
    assert.deepEqual([...p.cache.store.keys()], [IMG]);
    assert.deepEqual(p.posted, [{ type: 'images-changed' }]);
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

  test('and from an older build\'s cache too, so the next update cannot bring them back', async () => {
    // An API fetch finishing after an update recreates the old build's cache; the next update
    // carries replies over from it.
    const sw = worker();
    const stale = fakeCache();
    stale.store.set('/api/announcements', json({ announcements: [{ title: 'Picnic' }] }));
    sw.caches.set('pushannounce-oldbuild', stale);
    sw.net.reply = () => new Response('', { status: 401 });
    await sw.get('/api/announcements');
    assert.equal(stale.store.size, 0, 'the old cache is emptied of replies');
    await sw.activate();
    sw.net.online = false;
    assert.equal((await sw.get('/api/announcements')).type, 'error', 'nothing to show: the copy did not come back');
  });
});
