// A passkey has to be unlocked by its person, not merely touched. Phones and password managers
// always verify (Face ID, a fingerprint, the screen lock); a hardware key with no PIN set does not,
// and used to sign in as an admin on a touch. Its own file, with its own server, because
// test/passkeys.test.js spends every one of its ten sign-in verifications a minute.
//
//   npm test            (the Node entry)
//   npm run test:worker (`wrangler dev`)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, addPersonWithPasskey, createClient, startServer, testPort } from './helpers/harness.js';

let server;
let req;

before(async () => {
  server = await startServer({ port: testPort(20) });
  req = createClient(server.base);
  await req('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
});

after(() => server?.stop());

test('sign-in asks for user verification, and refuses a passkey that only saw a touch', async () => {
  const person = await addPersonWithPasskey(req, { as: 'setup', origin: server.base, name: 'Brother Tanaka', adminAs: 'owner' });
  const sign = async (as, userVerified) => {
    const options = await (await req('/admin/passkey/login/options', { as, method: 'POST' })).json();
    assert.equal(options.userVerification, 'required', 'the browser is told to verify');
    const response = await person.authenticator.get(options, { userVerified });
    return req('/admin/passkey/login/verify', { as, method: 'POST', json: response });
  };
  assert.equal((await sign('touch-only', false)).status, 401, 'present but not verified');
  assert.equal((await req('/admin', { as: 'touch-only' })).status, 302, 'and no session came of it');
  assert.equal((await sign('verified', true)).status, 200, 'the same passkey, unlocked, signs in');
});
