/**
 * What `/api/subscribe` and `/api/unsubscribe` accept: the shape of a subscription, before the
 * push-service and ceiling checks ever run.
 *
 * Anyone holding the shared member code can reach these routes, and a subscription row is stored
 * exactly as posted — so the route used to take a 30 KB "endpoint" with a 20 KB "key" and answer
 * 201, and a non-string field reached the driver and answered 500. A few thousand such rows fill
 * `MAX_SUBSCRIPTIONS` (locking real members out) and every weekly send grinds through them. These
 * run over HTTP against the real server, as a member's browser would.
 *
 * Run with: npm test (Node) / npm run test:worker (Workers)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ADMIN_PASSWORD, createClient, startServer, testPort, unlockMember } from './helpers/harness.js';

let server;
let req;

/** A subscription as a browser's `PushSubscription.toJSON()` prints one: real keys, a test endpoint. */
async function realSubscription(path = 'ok') {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  return {
    endpoint: `https://push.example.test/${path}`,
    keys: {
      p256dh: Buffer.from(raw).toString('base64url'),
      auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    },
  };
}

const subscribe = (json) => req('/api/subscribe', { as: 'member', method: 'POST', json });

before(async () => {
  server = await startServer({ port: testPort(9) });
  req = createClient(server.base);
  await req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
  await unlockMember(req, 'member');
});

after(() => server?.stop());

describe('/api/subscribe', () => {
  test('a real subscription is stored', async () => {
    const res = await subscribe(await realSubscription());
    assert.equal(res.status, 201);
  });

  test('an endpoint longer than any push service issues is refused', async () => {
    const sub = await realSubscription();
    sub.endpoint = `https://push.example.test/${'a'.repeat(30_000)}`;
    const res = await subscribe(sub);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /push service/);
  });

  test('keys of the wrong length are refused: p256dh is 65 bytes with a 0x04 lead, auth is 16', async () => {
    const good = await realSubscription();
    const cases = [
      ['a 20 KB p256dh', { ...good, keys: { ...good.keys, p256dh: 'A'.repeat(20_000) } }],
      ['a 64-byte p256dh', { ...good, keys: { ...good.keys, p256dh: Buffer.alloc(64, 4).toString('base64url') } }],
      ['a 65-byte p256dh not starting 0x04', { ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 2).toString('base64url') } }],
      ['a 15-byte auth', { ...good, keys: { ...good.keys, auth: Buffer.alloc(15, 1).toString('base64url') } }],
      ['a 17-byte auth', { ...good, keys: { ...good.keys, auth: Buffer.alloc(17, 1).toString('base64url') } }],
      ['standard base64 with + and /', { ...good, keys: { ...good.keys, auth: 'ab+cd/ef+gh/ij+kl/mn==' } }],
      ['an empty auth', { ...good, keys: { ...good.keys, auth: '' } }],
    ];
    for (const [what, body] of cases) {
      const res = await subscribe(body);
      assert.equal(res.status, 400, what);
      assert.match((await res.json()).error, /Invalid subscription/, what);
    }
  });

  test('a field that is not a string is a 400, not a 500', async () => {
    const good = await realSubscription();
    const cases = [
      ['endpoint an object', { ...good, endpoint: { url: good.endpoint } }],
      ['endpoint a number', { ...good, endpoint: 12345 }],
      ['keys a string', { ...good, keys: 'BP...' }],
      ['p256dh an array', { ...good, keys: { ...good.keys, p256dh: [good.keys.p256dh] } }],
      ['auth an object', { ...good, keys: { ...good.keys, auth: { v: good.keys.auth } } }],
      ['nothing at all', {}],
    ];
    for (const [what, body] of cases) {
      const res = await subscribe(body);
      assert.equal(res.status, 400, what);
    }
  });

  test('a non-string oldEndpoint is ignored rather than looked up', async () => {
    const sub = await realSubscription('rotated');
    const res = await subscribe({ ...sub, oldEndpoint: { was: 'something' } });
    assert.equal(res.status, 201);
  });

  test('padded base64url, as some libraries print it, is still a subscription', async () => {
    const sub = await realSubscription('padded');
    sub.keys.p256dh = Buffer.from(sub.keys.p256dh, 'base64url').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    assert.match(sub.keys.p256dh, /=$/, 'the test key really is padded');
    const res = await subscribe(sub);
    assert.equal(res.status, 201);
  });
});

describe('/api/unsubscribe', () => {
  test('an endpoint that is not a string is a 400, not a 500', async () => {
    for (const endpoint of [{ url: 'x' }, 42, ['x'], null, 'h'.repeat(30_000)]) {
      const res = await req('/api/unsubscribe', { as: 'member', method: 'POST', json: { endpoint } });
      assert.equal(res.status, 400, JSON.stringify(endpoint).slice(0, 40));
    }
  });

  test('a real endpoint is removed', async () => {
    const sub = await realSubscription('leaving');
    assert.equal((await subscribe(sub)).status, 201);
    const res = await req('/api/unsubscribe', { as: 'member', method: 'POST', json: { endpoint: sub.endpoint } });
    assert.equal(res.status, 200);
  });
});
