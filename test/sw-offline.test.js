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

/** A worker with one cache, keyed by pathname, and a network that `online` decides about. */
function worker() {
  const store = new Map();
  const cache = {
    put: async (request, response) => void store.set(new URL(request.url).pathname, response),
    match: async (request) => store.get(new URL(request.url).pathname)?.clone(),
    delete: async (request) => store.delete(new URL(request.url).pathname),
    keys: async () => [...store.keys()].map((path) => new Request(ORIGIN + path)),
  };
  const net = { online: true, reply: () => new Response('{}') };
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
      caches: { open: async () => cache, match: (request) => cache.match(request), keys: async () => [] },
      fetch: async (request) => {
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
  return { store, net, get };
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
