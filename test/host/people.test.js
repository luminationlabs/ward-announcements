/**
 * People across wards on the many-ward host: a person added to ward A — their session, their
 * invite link, their passkey — must be nothing at all to ward B. Completes the cross-ward set begun
 * in isolation.test.js (data, member cookies, access codes, owner cookies; images in
 * images.test.js). Part of the many-ward host. Local `wrangler dev` only; part of
 * `npm run test:host`.
 *
 * Ward A is `127.0.0.1` (registered by the harness), ward B is `localhost`. Passkeys are made with
 * the software authenticator the passkey suite uses, for each ward's own origin.
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ADMIN_PASSWORD, addPersonWithPasskey, createClient, registerWard, signInWithPasskey, startServer, testPort } =
  await import('../helpers/harness.js');

let server;
let a;
let b;
let baseB;
let editor;

/** The `name=value` a response set for `name`. */
const issued = (res, name) => res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`))?.split(';')[0];

before(async () => {
  server = await startServer({ port: testPort(14) });
  baseB = server.base.replace('127.0.0.1', 'localhost');
  a = createClient(server.base);
  b = createClient(baseB);
  await registerWard(server.base, { id: 'ward-b', hostname: 'localhost' });
  await a('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  await b('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  editor = await addPersonWithPasskey(a, { as: 'editor', origin: server.base, adminAs: 'owner', name: 'Ward A Editor' });
  assert.equal(editor.verify.status, 200, 'the editor is set up on ward A');
});
after(() => server?.stop());

test("a person's session from ward A does not open ward B", async () => {
  const cookie = issued(editor.verify, 'pushannounce_user');
  assert.ok(cookie);
  assert.equal((await a('/admin', { headers: { cookie } })).status, 200, 'sanity: it opens A');
  const res = await b('/admin', { headers: { cookie } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
});

test("an invite link from ward A cannot make a passkey on ward B", async () => {
  // A fresh, unused invite on A.
  const created = await a('/admin/people', { as: 'owner', method: 'POST', form: { name: 'Second', role: 'admin' } });
  const id = /\/admin\/people\/(\d+)/.exec(created.headers.get('location') ?? '')?.[1];
  const token = /#t=([A-Za-z0-9_-]+)/.exec(await (await a(`/admin/people/${id}`, { as: 'owner' })).text())?.[1];
  assert.ok(token);
  const onB = await b('/admin/passkey/register/options', { as: 'x', method: 'POST', json: { token } });
  assert.notEqual(onB.status, 200, 'ward B knows no such invite');
  // …and it still works on A, so the refusal above is about the ward, not a dead token.
  const onA = await a('/admin/passkey/register/options', { as: 'x', method: 'POST', json: { token } });
  assert.equal(onA.status, 200);
});

test("ward A's passkey does not sign anyone in to ward B", async () => {
  const res = await signInWithPasskey(b, editor.authenticator, { as: 'stolen' });
  assert.notEqual(res.status, 200);
  assert.ok(!issued(res, 'pushannounce_user'), 'no session is issued');
  assert.equal((await b('/admin', { as: 'stolen' })).status, 302);
  // Sanity: the same passkey still signs in on its own ward.
  const home = await signInWithPasskey(a, editor.authenticator, { as: 'again' });
  assert.equal(home.status, 200);
});
