/**
 * Two wards on the many-ward host (`src/host.ts`), told apart by hostname, must not be able to see
 * or open each other: their data, their member access, their admin sessions. Step 3 of
 * docs/DEPLOYMENT.md § 2b.
 *
 * Both wards are on the same local `wrangler dev`: ward A at `127.0.0.1`, ward B at `localhost` —
 * one server, two hostnames, which is all the front door looks at. (A custom `Host` header would
 * be neater, but Node's fetch does not pass one through.) Nothing is deployed. Part of
 * `npm run test:host`.
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ADMIN_PASSWORD, createClient, registerWard, startServer, testPort, unlockMember } = await import('../helpers/harness.js');

let server;
let req;
/** Requests to ward B: a client of its own, at the other hostname. */
let toB;

/** The `name=value` a response set for `name`. */
const issued = (res, name) => res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`))?.split(';')[0];

let ownerA;
before(async () => {
  server = await startServer({ port: testPort(8) });
  req = createClient(server.base);
  toB = createClient(server.base.replace('127.0.0.1', 'localhost'));
  const loginA = await req('/admin/login', { as: 'adminA', method: 'POST', form: { password: ADMIN_PASSWORD } });
  ownerA = issued(loginA, 'pushannounce_session');
  assert.ok(ownerA);
  // Before it is registered, ward B's hostname has no ward at all — and wakes nothing.
  const unknown = await toB('/');
  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), 'There is no ward at this address.\n');
  await registerWard(server.base, { id: 'ward-b', hostname: 'localhost' });
  const loginB = await toB('/admin/login', { as: 'adminB', method: 'POST', form: { password: ADMIN_PASSWORD } });
  assert.equal(loginB.status, 302);
});
after(() => server?.stop());

test('the two hostnames really are two wards', async () => {
  // Each ward mints its own first access code, so the dashboards must name different ones.
  const codeOf = async (html) => /#code=([a-z0-9-]+)/.exec(await html)?.[1];
  const a = await codeOf((await req('/admin', { as: 'adminA' })).text());
  const b = await codeOf((await toB('/admin', { as: 'adminB' })).text());
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test("ward A's announcement never appears in ward B", async () => {
  const made = await req('/admin/announcements', {
    as: 'adminA',
    method: 'POST',
    form: { title: 'Only in A', body: 'A ward A thing.', published: '1' },
  });
  assert.equal(made.status, 302);
  await unlockMember(req, 'memberA', { adminAs: 'adminA' });
  const inA = await (await req('/api/announcements', { as: 'memberA' })).json();
  assert.ok(JSON.stringify(inA).includes('Only in A'));

  const dashB = await (await toB('/admin', { as: 'adminB' })).text();
  assert.ok(!dashB.includes('Only in A'));
});

test("ward A's owner cookie does not open ward B's dashboard, even with a shared password", async () => {
  assert.equal((await req('/admin', { headers: { cookie: ownerA } })).status, 200, 'sanity: it opens A');
  const res = await toB('/admin', { headers: { cookie: ownerA } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
});

test("a member let into ward A is still a stranger to ward B", async () => {
  const html = await (await req('/admin', { as: 'adminA' })).text();
  const code = /#code=([a-z0-9-]+)/.exec(html)?.[1];
  const unlocked = await req('/api/access', { method: 'POST', json: { code } });
  assert.equal(unlocked.status, 200);
  const memberCookie = issued(unlocked, 'pushannounce_access');
  assert.ok(memberCookie);
  // Sanity: the cookie works where it was issued…
  assert.equal((await req('/api/announcements', { headers: { cookie: memberCookie } })).status, 200);
  // …and nowhere else.
  assert.notEqual((await toB('/api/announcements', { headers: { cookie: memberCookie } })).status, 200);
});

test('the operator API refuses a wrong password, and says nothing to a stranger', async () => {
  for (const authorization of [undefined, 'Bearer wrong-password']) {
    const res = await fetch(`${server.base}/__operator/wards`, { headers: authorization ? { authorization } : {} });
    assert.equal(res.status, 404);
  }
  // …and a ward's internal channel is never reachable from outside.
  assert.equal((await req('/__ward/state')).status, 404);
});

test("ward A's access code does not unlock ward B", async () => {
  const html = await (await req('/admin', { as: 'adminA' })).text();
  const code = /#code=([a-z0-9-]+)/.exec(html)?.[1];
  const res = await toB('/api/access', { as: 'stranger', method: 'POST', json: { code } });
  assert.notEqual(res.status, 200);
});

test('the hourly poke wakes every registered ward (what the cron trigger runs)', async () => {
  const res = await fetch(`${server.base}/__operator/poke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}` },
  });
  assert.equal(res.status, 200);
  const results = await res.json();
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['test', true], ['ward-b', true]]);
  // Waking runs pending migrations, so every ward reports the current schema.
  assert.ok(results.every((r) => /^\d+$/.test(String(r.schemaVersion))));
});
