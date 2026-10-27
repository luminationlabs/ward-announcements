// Passkey sign-in for the dashboard (src/passkeys.ts), end to end against a real server, with a
// software authenticator (helpers/webauthn.js) standing in for a phone. The verification is the real
// thing — SimpleWebAuthn checking real P-256 signatures — so a pass here means a passkey made by
// that code signs in, and a forged or replayed one does not.
//
// Runs on both runtimes, like the other end-to-end suites:
//   npm test            (the Node entry)
//   npm run test:worker (`wrangler dev`, i.e. the real Workers runtime)
//
// The verify endpoints allow ten attempts a minute per client, and this file shares one client, so
// it spends them deliberately: every registration and sign-in below is one the claim needs.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, addPersonWithPasskey, createClient, signInWithPasskey, startServer, testPort } from './helpers/harness.js';
import { createAuthenticator } from './helpers/webauthn.js';

let server;
let req;
let ORIGIN;

before(async () => {
  server = await startServer({ port: testPort(7) });
  ORIGIN = server.base;
  req = createClient(server.base);
  const owner = await req('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  assert.equal(owner.status, 302, 'the owner password still signs in');
});

after(() => server?.stop());

const status = async (path, as) => (await req(path, { as })).status;
const cookieSet = (res, name) => res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`));

// ---------------------------------------------------------------------------

describe('the owner', () => {
  test('sees the People card', async () => {
    assert.match(await (await req('/admin', { as: 'owner' })).text(), /<h2>People<\/h2>/);
  });
});

describe('an editor, from invite to sign-in', () => {
  let editor;

  before(async () => {
    editor = await addPersonWithPasskey(req, { as: 'editor', origin: ORIGIN, role: 'editor', name: 'Sister Moreau', adminAs: 'owner' });
  });

  test('the invite page is open to anyone holding the link, and never cached', async () => {
    const res = await req('/admin/invite');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });

  test('creating the passkey signs them in as an editor, and only as an editor', async () => {
    assert.equal(editor.verify.status, 200);
    assert.deepEqual(await editor.verify.json(), { ok: true, redirect: '/admin' });
    assert.ok(cookieSet(editor.verify, 'pushannounce_user'), 'a person session was started');
    assert.equal(await status('/admin', 'editor'), 200);
    assert.doesNotMatch(await (await req('/admin', { as: 'editor' })).text(), /<h2>People<\/h2>/, 'no People card for an editor');
    assert.equal(await status('/admin/backup.json', 'editor'), 403, 'admin-only routes refuse an editor');
    const add = await req('/admin/people', { as: 'editor', method: 'POST', form: { name: 'Intruder', role: 'admin' } });
    assert.equal(add.status, 403, 'an editor cannot add people');
  });

  test('an invite link works once', async () => {
    const again = await req('/admin/passkey/register/options', { as: 'someone-else', method: 'POST', json: { token: editor.token } });
    assert.equal(again.status, 401);
  });

  test('later, the passkey signs them in on its own — no password, no username', async () => {
    const res = await signInWithPasskey(req, editor.authenticator, { as: 'editor-later' });
    assert.equal(res.status, 200);
    assert.equal(await status('/admin', 'editor-later'), 200);
    assert.equal(await status('/admin/backup.json', 'editor-later'), 403);
  });

  test('signing in as a person ends an owner session in the same browser', async () => {
    const res = await signInWithPasskey(req, editor.authenticator, { as: 'shared-computer' });
    const cleared = cookieSet(res, 'pushannounce_session');
    assert.ok(cleared && /Max-Age=0/.test(cleared), 'the owner cookie is cleared, as on a shared clerk’s-office computer');
  });
});

describe('what does not sign in', () => {
  let person;

  before(async () => {
    person = await addPersonWithPasskey(req, { as: 'p2', origin: ORIGIN, name: 'Brother Tanaka', adminAs: 'owner' });
  });

  test('a tampered signature', async () => {
    const options = await (await req('/admin/passkey/login/options', { as: 'forger', method: 'POST' })).json();
    const response = await person.authenticator.get(options);
    response.response.signature = response.response.signature.slice(0, -6) + 'AAAAAA';
    const res = await req('/admin/passkey/login/verify', { as: 'forger', method: 'POST', json: response });
    assert.equal(res.status, 401);
    assert.equal(await status('/admin', 'forger'), 302);
  });

  test('an answer to a challenge this browser was never given, or one already spent', async () => {
    const issued = await req('/admin/passkey/login/options', { as: 'a', method: 'POST' });
    const options = await issued.json();
    const response = await person.authenticator.get(options);
    const elsewhere = await req('/admin/passkey/login/verify', { as: 'b', method: 'POST', json: response });
    assert.equal(elsewhere.status, 400, 'no challenge cookie in this browser');
    assert.equal((await req('/admin/passkey/login/verify', { as: 'a', method: 'POST', json: response })).status, 200);
    // The first verify answers with Max-Age=0, and a browser (or the harness's jar) forgets the
    // cookie — but a client that kept it still holds the challenge, signed and inside its five
    // minutes, and an authenticator that will sign it again. Only the server's own record of having
    // taken it (`spent_challenges`) refuses the second answer. Sent as that client would: the cookie
    // the options call set, with a fresh assertion over the same challenge, and no jar.
    const kept = cookieSet(issued, 'pushannounce_challenge').split(';')[0];
    assert.ok(kept.length > 'pushannounce_challenge='.length, 'the challenge was issued');
    const replay = await req('/admin/passkey/login/verify', {
      method: 'POST',
      json: await person.authenticator.get(options),
      headers: { cookie: kept },
    });
    assert.equal(replay.status, 401, 'the challenge was answered once already');
    assert.match((await replay.json()).error, /already been used/);
    assert.ok(!cookieSet(replay, 'pushannounce_user'), 'no session was started');
  });

  test('a passkey made for a different site', async () => {
    const phishing = createAuthenticator({ origin: 'https://ward-app.evil.example' });
    const created = await req('/admin/people', { as: 'owner', method: 'POST', form: { name: 'Phished', role: 'admin' } });
    const id = /\/admin\/people\/(\d+)/.exec(created.headers.get('location'))[1];
    const token = /#t=([A-Za-z0-9_-]+)/.exec(await (await req(`/admin/people/${id}`, { as: 'owner' })).text())[1];
    const options = await (await req('/admin/passkey/register/options', { as: 'ph', method: 'POST', json: { token } })).json();
    const res = await req('/admin/passkey/register/verify', { as: 'ph', method: 'POST', json: { token, response: await phishing.create(options) } });
    assert.equal(res.status, 400);
    assert.equal(await status('/admin', 'ph'), 302);
  });

  test('an earlier invite link, once a new one has been made', async () => {
    const created = await req('/admin/people', { as: 'owner', method: 'POST', form: { name: 'Re-invited', role: 'editor' } });
    const id = /\/admin\/people\/(\d+)/.exec(created.headers.get('location'))[1];
    const first = /#t=([A-Za-z0-9_-]+)/.exec(await (await req(`/admin/people/${id}`, { as: 'owner' })).text())[1];
    await req(`/admin/people/${id}/invite`, { as: 'owner', method: 'POST' });
    const second = /#t=([A-Za-z0-9_-]+)/.exec(await (await req(`/admin/people/${id}`, { as: 'owner' })).text())[1];
    assert.notEqual(first, second);
    assert.equal((await req('/admin/passkey/register/options', { as: 'r', method: 'POST', json: { token: first } })).status, 401);
    assert.equal((await req('/admin/passkey/register/options', { as: 'r', method: 'POST', json: { token: second } })).status, 200);
  });
});

describe('taking access away', () => {
  test('the owner can end every owner session without changing the password', async () => {
    // An owner session lasts thirty days, and before this only a new ADMIN_PASSWORD ended one.
    const phone = await req('/admin/login', { as: 'owner-phone', method: 'POST', form: { password: ADMIN_PASSWORD } });
    assert.equal(phone.status, 302);
    assert.equal(await status('/admin', 'owner-phone'), 200);
    const res = await req('/admin/me/signout-everywhere', { as: 'owner', method: 'POST' });
    assert.equal(res.status, 302);
    assert.equal(await status('/admin', 'owner-phone'), 302, 'the other device is signed out');
    assert.equal(await status('/admin', 'owner'), 200, 'the browser that asked keeps a fresh session');
    assert.equal((await req('/admin/me/signout-everywhere', { as: 'stranger', method: 'POST' })).status, 302, 'and nobody else can press it');
  });

  test('"sign out everywhere" ends every session the person holds, and the passkey still works after', async () => {
    const p = await addPersonWithPasskey(req, { as: 'so', origin: ORIGIN, name: 'Brother Silva', adminAs: 'owner' });
    assert.equal(await status('/admin', 'so'), 200);
    await req(`/admin/people/${p.id}/signout`, { as: 'owner', method: 'POST' });
    assert.equal(await status('/admin', 'so'), 302, 'the old session is over on its next request');
    assert.equal((await signInWithPasskey(req, p.authenticator, { as: 'so' })).status, 200);
    assert.equal(await status('/admin', 'so'), 200);

    // A lost phone: removing its passkey has to end the session on it too. Left signed in, it could
    // enrol a passkey of its own through /admin/passkey/add and keep its access for good.
    const passkey = [...p.authenticator.credentials.keys()][0];
    await req(`/admin/people/${p.id}/passkeys/${encodeURIComponent(passkey)}/delete`, { as: 'owner', method: 'POST' });
    assert.equal(await status('/admin', 'so'), 302, 'the device the passkey was on is signed out');
    assert.equal((await req('/admin/passkey/add/options', { as: 'so', method: 'POST' })).status, 302, 'and cannot add one');
  });

  test('removing a person ends their session at once, and their passkey no longer signs in', async () => {
    const p = await addPersonWithPasskey(req, { as: 'rm', origin: ORIGIN, role: 'admin', name: 'Brother Novak', adminAs: 'owner' });
    assert.equal(await status('/admin/backup.json', 'rm'), 200, 'an admin person reaches admin routes');
    await req(`/admin/people/${p.id}/delete`, { as: 'owner', method: 'POST' });
    assert.equal(await status('/admin', 'rm'), 302);
    assert.equal((await signInWithPasskey(req, p.authenticator, { as: 'rm2' })).status, 401);
  });
});

describe('a passkey on another device, added while signed in', () => {
  // Spends the last two of this file's ten sign-in verifications (see the note at the top).
  test('the person adds one on "this computer", and it then signs in by itself; removing it stops it', async () => {
    await addPersonWithPasskey(req, { as: 'dev', origin: ORIGIN, name: 'Sister Lindqvist', adminAs: 'owner' });
    const computer = createAuthenticator({ origin: ORIGIN });
    const options = await (await req('/admin/passkey/add/options', { as: 'dev', method: 'POST' })).json();
    assert.equal(options.excludeCredentials.length, 1, 'the phone’s passkey is excluded, so a device cannot hold two');
    const added = await req('/admin/passkey/add/verify', { as: 'dev', method: 'POST', json: await computer.create(options) });
    assert.equal(added.status, 200);
    assert.match(await (await req('/admin/me', { as: 'dev' })).text(), /Sister Lindqvist/);

    assert.equal((await signInWithPasskey(req, computer, { as: 'dev-computer' })).status, 200, 'the computer signs in by itself');

    const id = [...computer.credentials.keys()][0];
    await req(`/admin/me/passkeys/${encodeURIComponent(id)}/delete`, { as: 'dev', method: 'POST' });
    assert.equal((await signInWithPasskey(req, computer, { as: 'dev-computer-2' })).status, 401, 'a removed passkey no longer signs in');
    assert.equal(await status('/admin', 'dev-computer'), 302, 'the session it started is over too');
    assert.equal(await status('/admin', 'dev'), 200, 'the browser that removed it stays signed in');
  });

  test('the owner has no passkeys to add to, and a stranger cannot add one', async () => {
    assert.equal((await req('/admin/passkey/add/options', { as: 'owner', method: 'POST' })).status, 400);
    assert.match(await (await req('/admin/me', { as: 'owner' })).text(), /owner password/);
    assert.equal((await req('/admin/passkey/add/options', { as: 'stranger', method: 'POST' })).status, 302);
  });
});
