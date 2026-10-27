// What a deployment may leave unset and have the app supply: the VAPID keypair, the public origin
// (and with it the VAPID subject), and an image store that needs no R2 bucket. These are what let a
// Deploy-to-Cloudflare button produce a working app from a password alone, so the suite checks the
// result actually *works* — a generated pair that signs a real push request, a learned origin that
// lands in the request a push service receives — not just that a row was written.
//
// In process, like the push-queue suite: one SQLite file, the compiled modules, a stubbed `fetch`.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertConfig, buildConfig, config, loadConfig } from '../dist/config.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import * as db from '../dist/db.js';
import { createSqlFileStore } from '../dist/filestore-sql.js';
import { learnOrigin, loadStoredIdentity } from '../dist/identity.js';
import { buildPushMessage, initPush, sendToAll, setPushLogger } from '../dist/push.js';
import { TEST_VAPID } from './helpers/harness.js';

const BASE = {
  ADMIN_PASSWORD: 'test-admin-password',
  APP_NAME: 'Test Ward',
  APP_SHORT_NAME: 'Test',
  APP_DESCRIPTION: 'Test announcements',
  NODE_ENV: 'production',
  TZ: 'America/Denver',
};
const ENDPOINT = 'https://push.example.test/ok';

let dataDir;
let realFetch;
/** The requests the stubbed push service received. */
let requests;

/** Point the app at a brand-new database: no keys, no origin — what a first deploy starts with. */
let dbCount = 0;
const freshDb = () => db.initDb(createSqliteDriver(join(dataDir, `identity-${dbCount++}.db`)));

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wa-identity-'));
  setPushLogger({ debug() {}, info() {}, warn() {}, error() {} });
  realFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: typeof url === 'string' ? url : url.url, headers: init?.headers ?? {} });
    return new Response(null, { status: 201 });
  };
});

after(() => {
  if (realFetch) globalThis.fetch = realFetch;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** A fresh config for the same database, as a new isolate or a restart would load one. */
async function boot(env = {}) {
  loadConfig({ ...BASE, ...env });
  assertConfig();
  await db.initDb();
  await loadStoredIdentity();
  initPush();
  return config;
}

async function subscribe() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  await db.upsertSubscription({
    endpoint: ENDPOINT,
    p256dh: Buffer.from(raw).toString('base64url'),
    auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    user_agent: 'test',
  });
}

/** The JWT claims and key in a VAPID `Authorization: vapid t=…, k=…` header. */
function vapidHeader(headers) {
  const value = headers.authorization ?? headers.Authorization;
  const [, token, key] = /t=([^,\s]+),\s*k=(\S+)/.exec(value) ?? [];
  return { claims: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()), key };
}

// ---------------------------------------------------------------------------

describe('VAPID keys', () => {
  before(freshDb);

  test('a deployment without keys generates a pair once and keeps it', async () => {
    const first = await boot();
    assert.equal(Buffer.from(first.vapid.publicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(first.vapid.privateKey, 'base64url').length, 32);
    const { publicKey, privateKey } = first.vapid;

    const again = await boot();
    assert.deepEqual(
      [again.vapid.publicKey, again.vapid.privateKey],
      [publicKey, privateKey],
      'a restart (or a second isolate) reads the same pair rather than minting another',
    );
  });

  test('keys set in the environment win, and none are generated for them', async () => {
    await freshDb();
    const pinned = { VAPID_PUBLIC_KEY: TEST_VAPID.publicKey, VAPID_PRIVATE_KEY: TEST_VAPID.privateKey };
    await boot(pinned);
    assert.equal(config.vapid.publicKey, pinned.VAPID_PUBLIC_KEY);
    assert.equal(config.vapid.privateKey, pinned.VAPID_PRIVATE_KEY);
    assert.equal(await db.getSetting('vapid_keys'), null, 'an existing deployment is never re-keyed');
  });

  test('half a pair in the environment is a boot error, not a generated other half', () => {
    assert.throws(() => assertConfig(buildConfig({ ...BASE, VAPID_PUBLIC_KEY: 'x' })), /VAPID_PRIVATE_KEY/);
    assert.throws(() => assertConfig(buildConfig({ ...BASE, VAPID_PRIVATE_KEY: 'x' })), /VAPID_PUBLIC_KEY/);
  });
});

describe('the public origin', () => {
  before(freshDb);

  test('is only ever learned from https, and the first one sticks', async () => {
    await boot();
    assert.equal(config.publicOrigin, '');
    await learnOrigin('http://127.0.0.1:8787');
    assert.equal(config.publicOrigin, '', 'plain http (local dev, a box behind a proxy) is ignored');
    await learnOrigin('https://ward-app.someone.workers.dev');
    await learnOrigin('https://elsewhere.example');
    assert.equal(config.publicOrigin, 'https://ward-app.someone.workers.dev');
    assert.equal((await boot()).publicOrigin, 'https://ward-app.someone.workers.dev', 'and survives a restart');
  });

  test('PUBLIC_ORIGIN in the environment is never replaced by a learned one', async () => {
    await freshDb();
    await boot({ PUBLIC_ORIGIN: 'https://ward.example.org' });
    await learnOrigin('https://ward-app.someone.workers.dev');
    assert.equal(config.publicOrigin, 'https://ward.example.org');
  });

  test('Node still requires it in production, since it cannot learn one', () => {
    assert.throws(() => assertConfig(buildConfig(BASE), { requireOrigin: true }), /PUBLIC_ORIGIN/);
    assert.doesNotThrow(() => assertConfig(buildConfig(BASE)));
  });
});

describe('a send with nothing but a password configured', () => {
  test('waits for an origin, then delivers with the generated pair and the origin as subject', async () => {
    // Fresh database: no keys, no origin, no VAPID_SUBJECT — exactly what the Deploy button makes.
    await freshDb();
    await boot();
    await subscribe();
    requests = [];

    const before = await sendToAll({ title: 't', body: 'b', url: '/#announcements' }, { type: 'manual', drain: 'until-empty' });
    assert.equal(requests.length, 0, 'nothing is sent with no contact address for the push service');
    assert.equal(before.pending, 1, 'and nothing is spent: the delivery is still queued');

    await learnOrigin('https://ward-app.someone.workers.dev'); // the admin opens the dashboard
    await sendToAll({ title: 't2', body: 'b', url: '/' }, { type: 'manual', drain: 'until-empty' });
    assert.equal(requests.length, 2, 'both queued deliveries go out');
    const { claims, key } = vapidHeader(requests[0].headers);
    assert.equal(claims.sub, 'https://ward-app.someone.workers.dev');
    assert.equal(key, config.vapid.publicKey, 'signed with the generated pair');
    assert.equal(
      JSON.parse(buildPushMessage({ title: 't', body: 'b', url: '/#announcements' })).notification.navigate,
      'https://ward-app.someone.workers.dev/#announcements',
      'iOS gets the absolute URL it needs',
    );
  });
});

describe('the database image store', () => {
  before(freshDb);

  test('round-trips an upload bigger than one D1 row, and deletes it', async () => {
    const store = createSqlFileStore();
    const bytes = webcrypto.getRandomValues(new Uint8Array(65536));
    const big = new Uint8Array(3 * 1024 * 1024); // MAX_UPLOAD_BYTES: four chunks
    for (let i = 0; i < big.length; i += bytes.length) big.set(bytes, i);
    await store.put('0123456789abcdef0123456789abcdef.jpg', big, 'image/jpeg');

    const got = await store.get('0123456789abcdef0123456789abcdef.jpg');
    assert.equal(got.contentType, 'image/jpeg');
    assert.ok(Buffer.from(got.body).equals(Buffer.from(big)), 'the bytes come back identical');
    const rows = await db.getFileChunks('0123456789abcdef0123456789abcdef.jpg');
    assert.ok(rows.length > 1 && rows.every((r) => r.data.length <= 1_000_000), 'split under the 2 MB row cap');

    await store.delete('0123456789abcdef0123456789abcdef.jpg');
    assert.equal(await store.get('0123456789abcdef0123456789abcdef.jpg'), undefined);
    await store.delete('0123456789abcdef0123456789abcdef.jpg'); // deleting a missing key is fine
  });

  test('images for more owners than one statement may bind come back whole, in order', async () => {
    // D1 and Durable Object SQLite refuse more than 100 bound parameters, and the member page asks
    // for every live announcement's images at once. 150 owners, one image on every tenth.
    const ids = Array.from({ length: 150 }, (_, i) => 10_000 + i);
    for (const id of ids.filter((_, i) => i % 10 === 0)) {
      await db.createAttachment({ ownerType: 'announcement', ownerId: id, key: `${id.toString(16).padStart(32, '0')}.png`, contentType: 'image/png', size: 3, filename: 'x.png' });
    }
    const rows = await db.listAttachmentsForOwners('announcement', [...ids].reverse());
    assert.equal(rows.length, 15);
    assert.deepEqual(rows.map((r) => r.owner_id), ids.filter((_, i) => i % 10 === 0), 'every one, in owner order');
  });

  test('image bytes stay out of the JSON backup', async () => {
    await createSqlFileStore().put('fedcba9876543210fedcba9876543210.png', new Uint8Array([1, 2, 3]), 'image/png');
    const dump = await db.dumpDatabase();
    assert.equal('file_chunks' in dump, false);
    assert.ok('attachments' in dump, 'the attachment rows themselves are still backed up');
  });
});
