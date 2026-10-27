/**
 * Sealing the push keys inside a backup (`src/seal.ts`): a round trip, and that the wrong key, a
 * tampered ciphertext or a malformed blob all come back as null rather than a throw. In process,
 * against the TypeScript directly (as `scripts/db-restore.mjs` imports it). Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSealKey, isSealed, sealBackupSettings, sealSecret, unsealBackupTables, unsealSecret } from '../src/seal.ts';

const key = () => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const PAIR = '{"publicKey":"B-pair","privateKey":"private"}';

test('a sealed secret opens again under the same key, and the blob is the documented shape', async () => {
  const k = key();
  const blob = await sealSecret(PAIR, k);
  const parsed = JSON.parse(blob);
  assert.deepEqual(Object.keys(parsed).sort(), ['alg', 'ct', 'iv', 'v']);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.alg, 'A256GCM');
  assert.equal(Buffer.from(parsed.iv, 'base64url').length, 12);
  assert.equal(Buffer.from(parsed.ct, 'base64url').length, Buffer.byteLength(PAIR) + 16, 'the ciphertext plus the GCM tag');
  assert.ok(!blob.includes('private'), 'nothing of the plaintext shows');
  assert.equal(await unsealSecret(blob, k), PAIR);
  assert.ok(isSealed(blob));
  assert.ok(isSealed(parsed));
  assert.ok(!isSealed(PAIR));
});

test('a different IV every time, and the standard-base64 spelling of a key opens the same blob', async () => {
  const k = key();
  const a = JSON.parse(await sealSecret(PAIR, k));
  const b = JSON.parse(await sealSecret(PAIR, k));
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  const standard = Buffer.from(k, 'base64url').toString('base64');
  assert.notEqual(standard, k);
  assert.equal(await unsealSecret(JSON.stringify(a), standard), PAIR);
});

test('the wrong key, a tampered ciphertext or a malformed blob is null, never a throw', async () => {
  const k = key();
  const blob = await sealSecret(PAIR, k);
  assert.equal(await unsealSecret(blob, key()), null, 'another key');
  assert.equal(await unsealSecret(blob, 'not-a-key'), null, 'a key that is not 32 bytes');
  assert.equal(await unsealSecret(blob, ''), null, 'no key');
  const parsed = JSON.parse(blob);
  const ct = Buffer.from(parsed.ct, 'base64url');
  ct[0] ^= 0x01;
  assert.equal(await unsealSecret(JSON.stringify({ ...parsed, ct: ct.toString('base64url') }), k), null, 'a flipped bit');
  assert.equal(await unsealSecret(JSON.stringify({ ...parsed, iv: parsed.ct }), k), null, 'an IV of the wrong length');
  assert.equal(await unsealSecret(JSON.stringify({ ...parsed, v: 2 }), k), null, 'a version this code does not know');
  assert.equal(await unsealSecret(JSON.stringify({ ...parsed, alg: 'A128GCM' }), k), null);
  assert.equal(await unsealSecret('{"v":1}', k), null);
  assert.equal(await unsealSecret('not json', k), null);
  assert.equal(await unsealSecret(PAIR, k), null, 'a plaintext pair is not a blob');
});

test('a blob is bound to the vapid_keys setting: the same bytes under other data do not open', async () => {
  // The AAD is the setting's name, so a blob cannot be replayed into another setting; shown by
  // decrypting with the right key but the wrong additional data, outside the module.
  const k = key();
  const parsed = JSON.parse(await sealSecret(PAIR, k));
  const aes = await globalThis.crypto.subtle.importKey('raw', Buffer.from(k, 'base64url'), 'AES-GCM', false, ['decrypt']);
  const iv = Buffer.from(parsed.iv, 'base64url');
  const ct = Buffer.from(parsed.ct, 'base64url');
  await assert.rejects(globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('other') }, aes, ct));
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('vapid_keys') }, aes, ct);
  assert.equal(new TextDecoder().decode(plain), PAIR);
});

test('decodeSealKey: 32 bytes in either alphabet, and nothing else', () => {
  const k = key();
  assert.equal(decodeSealKey(k).length, 32);
  assert.equal(decodeSealKey(Buffer.from(k, 'base64url').toString('base64')).length, 32);
  assert.equal(decodeSealKey(`  ${k}  `).length, 32, 'whitespace around it is forgiven');
  assert.equal(decodeSealKey(''), null);
  assert.equal(decodeSealKey('short'), null);
  assert.equal(decodeSealKey(`${k}AA`), null, 'too long');
  assert.equal(decodeSealKey(k.replace(/^./, '!')), null, 'a character Buffer would skip is refused');
});

test('sealBackupSettings and unsealBackupTables are inverses; a locked blob is dropped, not kept', async () => {
  const k = key();
  const rows = [{ key: 'schema_version', value: '9' }, { key: 'vapid_keys', value: PAIR }];
  const sealed = await sealBackupSettings(rows, k);
  assert.deepEqual(sealed.map((r) => r.key), ['schema_version', 'vapid_keys_sealed']);
  assert.ok(isSealed(sealed[1].value));
  assert.deepEqual(await sealBackupSettings(rows, ''), [{ key: 'schema_version', value: '9' }], 'no key: the pair is left out');

  const opened = await unsealBackupTables({ settings: sealed, announcements: [] }, k);
  assert.equal(opened.sealed, 'opened');
  assert.deepEqual(opened.tables.settings, [{ key: 'schema_version', value: '9' }, { key: 'vapid_keys', value: PAIR }]);
  assert.deepEqual(opened.tables.announcements, []);

  const locked = await unsealBackupTables({ settings: sealed }, key());
  assert.equal(locked.sealed, 'locked');
  assert.deepEqual(locked.tables.settings, [{ key: 'schema_version', value: '9' }], 'neither the blob nor a pair reaches the planner');
  assert.equal((await unsealBackupTables({ settings: sealed }, '')).sealed, 'locked', 'no key here is locked too');

  const none = await unsealBackupTables({ settings: rows }, k);
  assert.equal(none.sealed, 'none');
  assert.equal(none.tables.settings, rows, 'a plaintext pair (an export from a host with no key) is left as it is');
  assert.equal((await unsealBackupTables({ settings: 'nonsense' }, k)).sealed, 'none', "and a file that is not a backup is the planner's to refuse");
  assert.equal((await unsealBackupTables(undefined, k)).sealed, 'none');
  assert.ok(sealed.every((r) => r.key !== 'vapid_keys'), 'the input rows were not edited in place');
});
