/**
 * A hosted ward as production runs it (`WARD_OWNER_SIGNIN` unset): no "Owner sign-in" on its
 * sign-in page, the platform password no use there, and the operator getting in the honest way —
 * an admin invite for themselves from the operator API, then a passkey. Every other host suite turns
 * owner sign-in on, because they sign in as the owner. Local `wrangler dev` only; part of
 * `npm run test:host`.
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ADMIN_PASSWORD, createClient, startServer, testPort } = await import('../helpers/harness.js');
const { createAuthenticator } = await import('../helpers/webauthn.js');

let server;
let req;

before(async () => {
  // The env file overrides the test config's `"WARD_OWNER_SIGNIN": "on"`.
  server = await startServer({ port: testPort(15), env: { WARD_OWNER_SIGNIN: 'off' } });
  req = createClient(server.base);
});
after(() => server?.stop());

test("a hosted ward's sign-in page offers passkeys only", async () => {
  const html = await (await req('/admin/login')).text();
  assert.match(html, /Sign In with a Passkey/);
  assert.doesNotMatch(html, /Owner Sign-In/);
});

test('the platform password is no way into a ward', async () => {
  const res = await req('/admin/login', { as: 'x', method: 'POST', form: { password: ADMIN_PASSWORD } });
  assert.equal(res.status, 401);
  assert.equal((await req('/admin', { as: 'x' })).status, 302);
});

test('the operator gets in with an admin invite for themselves, and is listed as a person', async () => {
  const minted = await fetch(`${server.base}/__operator/wards/test/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: JSON.stringify({ admin: 'Platform Operator' }),
  });
  assert.equal(minted.status, 200);
  const token = /#t=([A-Za-z0-9_-]+)/.exec((await minted.json()).invite)?.[1];
  assert.ok(token);

  const authenticator = createAuthenticator({ origin: server.base });
  const options = await (await req('/admin/passkey/register/options', { as: 'op', method: 'POST', json: { token } })).json();
  const verify = await req('/admin/passkey/register/verify', {
    as: 'op',
    method: 'POST',
    json: { token, response: await authenticator.create(options) },
  });
  assert.equal(verify.status, 200);

  const dash = await req('/admin', { as: 'op' });
  assert.equal(dash.status, 200);
  const html = await dash.text();
  assert.match(html, /action="\/admin\/ward"/, 'with the admin-only cards');
  assert.match(html, /Platform Operator/, "and visible in the ward's People list");
});

test("the People card doesn't promise an owner password the ward doesn't have", async () => {
  // Signed in as the admin made above.
  const html = await (await req('/admin', { as: 'op' })).text();
  assert.match(html, /<h2>People<\/h2>/);
  assert.doesNotMatch(html, /owner password/i);
});
