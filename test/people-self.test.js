/**
 * What a person may do about themselves, and what nobody may do to the last admin.
 *
 * Anyone signed in with a passkey can change their own name on the Account page (never their role).
 * And no change may leave a ward with no admin who can sign in: where there is no owner password
 * (a hosted ward, usually), removing the only admin with a passkey, making them an editor, or
 * deleting their last passkey is refused until another admin has one. That rule is tested directly
 * on `wouldStrandAdmins`; this server has an owner password, which is never stranded.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, addPersonWithPasskey, createClient, startServer, testPort } from './helpers/harness.js';
import { wouldStrandAdmins } from '../dist/admin-guard.js';

let server;
let req;
let admin;
let editor;

before(async () => {
  server = await startServer({ port: testPort(16) });
  req = createClient(server.base);
  await req('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  admin = await addPersonWithPasskey(req, { as: 'admin', origin: server.base, role: 'admin', name: 'Bishop Example', adminAs: 'owner' });
  editor = await addPersonWithPasskey(req, { as: 'editor', origin: server.base, role: 'editor', name: 'Sister Moreau', adminAs: 'owner' });
});
after(() => server?.stop());

const page = async (path, as) => (await req(path, { as })).text();
const flashOf = (res) => decodeURIComponent(/msg=([^&#]*)/.exec(res.headers.get('location') ?? '')?.[1] ?? '');

test('an editor changes their own name, and only their name', async () => {
  const res = await req('/admin/me/name', { as: 'editor', method: 'POST', form: { name: '  Sister Moreau (pianist) ', role: 'admin' } });
  assert.equal(res.status, 302);
  assert.equal(flashOf(res), 'Name saved.');
  const me = await page('/admin/me', 'editor');
  assert.match(me, /Signed in as <strong>Sister Moreau \(pianist\)<\/strong> \(editor\)/, 'renamed, and still an editor');
});

test('an empty name is refused, and the owner has no name to change', async () => {
  const empty = await req('/admin/me/name', { as: 'editor', method: 'POST', form: { name: '   ' } });
  assert.equal(flashOf(empty), 'Your name cannot be empty.');
  assert.match(await page('/admin/me', 'editor'), /Sister Moreau \(pianist\)/);
  const owner = await req('/admin/me/name', { as: 'owner', method: 'POST', form: { name: 'Owner' } });
  assert.equal(owner.headers.get('location'), '/admin/me');
  assert.doesNotMatch(await page('/admin/me', 'owner'), /name="name"/, 'no name field for the owner');
});

test('with an owner password, the only admin person can still be removed: the owner can always sign in', async () => {
  const remove = await req(`/admin/people/${admin.id}/delete`, { as: 'owner', method: 'POST' });
  assert.match(flashOf(remove), /removed/);
  // An editor never was an admin to strand.
  const removeEditor = await req(`/admin/people/${editor.id}/delete`, { as: 'owner', method: 'POST' });
  assert.match(flashOf(removeEditor), /removed/);
});

describe('wouldStrandAdmins: no change may leave a ward without an admin who can sign in', () => {
  const people = [
    { id: 1, role: 'admin', passkeys: 1 },
    { id: 2, role: 'editor', passkeys: 2 },
    { id: 3, role: 'admin', passkeys: 0 }, // invited, not set up: cannot sign in yet
  ];
  test('with no owner sign-in, the only admin with a passkey is protected from every change', () => {
    for (const change of ['demote', 'remove', 'passkey']) assert.equal(wouldStrandAdmins(people, 1, change, false), true, change);
  });
  test('an owner password, an editor, or an admin who never set up a passkey is never stranding', () => {
    assert.equal(wouldStrandAdmins(people, 1, 'remove', true), false, 'the owner can sign in');
    assert.equal(wouldStrandAdmins(people, 2, 'remove', false), false, 'an editor');
    assert.equal(wouldStrandAdmins(people, 3, 'remove', false), false, 'an admin who cannot sign in anyway');
    assert.equal(wouldStrandAdmins(people, 99, 'remove', false), false, 'nobody by that id');
  });
  test('a second admin with a passkey frees the first, and one of several passkeys can go', () => {
    const two = [...people, { id: 4, role: 'admin', passkeys: '1' }];
    assert.equal(wouldStrandAdmins(two, 1, 'demote', false), false);
    assert.equal(wouldStrandAdmins([{ id: 1, role: 'admin', passkeys: 2 }], 1, 'passkey', false), false);
    assert.equal(wouldStrandAdmins([{ id: 1, role: 'admin', passkeys: 2 }], 1, 'remove', false), true);
  });
});
