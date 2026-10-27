/**
 * Remove under Subscribers means what it says.
 *
 * It used to delete the server's row only, and the member's app re-posted its live subscription at
 * its next launch (`syncSubscription` in public/app.js) — so the removal lasted until they next
 * opened the app. Now the endpoint is blocked as well (`blocked_subscriptions`, by hash): the
 * launch re-sync is answered 409 `blocked`, and only the member's own tap on Enable Notifications,
 * which posts `deliberate: true`, lifts it. These run over HTTP against the real server.
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
async function realSubscription(path) {
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

/** The subscriber ids the dashboard lists, in page order (newest first). */
async function listedIds() {
  const html = await (await req('/admin/subscribers', { as: 'admin' })).text();
  return [...html.matchAll(/\/admin\/subscribers\/(\d+)\/delete/g)].map((m) => Number(m[1]));
}

/** Remove, as the dashboard's form does. */
async function removeOnDashboard(id) {
  const res = await req(`/admin/subscribers/${id}/delete`, { as: 'admin', method: 'POST', form: {} });
  assert.equal(res.status, 302);
}

before(async () => {
  server = await startServer({ port: testPort(21) });
  req = createClient(server.base);
  await req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
  await unlockMember(req, 'member');
});

after(() => server?.stop());

describe('Remove under Subscribers', () => {
  test('the launch re-sync is refused afterwards, and the row stays gone', async () => {
    const sub = await realSubscription('removed');
    assert.equal((await subscribe(sub)).status, 201);
    const [id] = await listedIds();
    assert.ok(id, 'the subscriber is listed');
    await removeOnDashboard(id);
    assert.deepEqual(await listedIds(), [], 'the row is gone');

    // What the phone does at its next launch: the same subscription, re-posted with no `deliberate`.
    const res = await subscribe(sub);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.blocked, true);
    assert.match(body.error, /removed from notifications by the ward/);
    assert.deepEqual(await listedIds(), [], 'and the row is not re-created');
  });

  test('the member can turn notifications back on themselves: a deliberate subscribe lifts the block', async () => {
    const sub = await realSubscription('removed-then-enabled');
    assert.equal((await subscribe(sub)).status, 201);
    await removeOnDashboard((await listedIds())[0]);
    assert.equal((await subscribe(sub)).status, 409, 'blocked');

    // The Enable Notifications tap.
    assert.equal((await subscribe({ ...sub, deliberate: true })).status, 201);
    assert.equal((await listedIds()).length, 1, 'the row is back');
    // And the block is gone: a plain launch re-sync is accepted again.
    assert.equal((await subscribe(sub)).status, 201);
    await removeOnDashboard((await listedIds())[0]);
  });

  test('a rotation of a blocked endpoint carries the block to the new one', async () => {
    // The device was removed, not the endpoint: a push service re-issuing the endpoint (the
    // worker's `pushsubscriptionchange`) must not be a way back in.
    const old = await realSubscription('rotated-from');
    assert.equal((await subscribe(old)).status, 201);
    await removeOnDashboard((await listedIds())[0]);

    const fresh = await realSubscription('rotated-to');
    const res = await subscribe({ ...fresh, oldEndpoint: old.endpoint });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).blocked, true);
    assert.deepEqual(await listedIds(), [], 'nothing stored');

    // The new endpoint is blocked in its own right now.
    assert.equal((await subscribe(fresh)).status, 409, 'the new endpoint is blocked');
    // And the old one's block has moved rather than been copied: a deliberate subscribe to the new
    // endpoint lifts it, after which the old endpoint is not blocked either.
    assert.equal((await subscribe({ ...fresh, deliberate: true })).status, 201);
    assert.equal((await subscribe(fresh)).status, 201);
    assert.equal((await subscribe(old)).status, 201, 'the old endpoint was unblocked by the move');
  });

  test('a subscription that was never removed is unaffected by `deliberate`', async () => {
    const sub = await realSubscription('plain');
    assert.equal((await subscribe({ ...sub, deliberate: true })).status, 201);
    assert.equal((await subscribe(sub)).status, 201);
  });

  test('the member’s own Turn Off does not block: a later launch re-sync still registers', async () => {
    const sub = await realSubscription('turned-off');
    assert.equal((await subscribe(sub)).status, 201);
    const res = await req('/api/unsubscribe', { as: 'member', method: 'POST', json: { endpoint: sub.endpoint } });
    assert.equal(res.status, 200);
    assert.equal((await subscribe(sub)).status, 201);
  });
});
