// Prints a fresh VAPID keypair, and a BACKUP_SEAL_KEY, to paste into .env (or into
// `wrangler secret put`). Run: npm run vapid
//
// The seal key is 32 random bytes, base64url (src/seal.ts): it seals the push keys inside the
// dashboard's backup and the operator's export, so a restore on the same deployment gets them back
// and the file alone cannot send. Printed here because it is wanted at the same moment as the
// pair, and set the same way.
//
// Written against WebCrypto rather than a library: the app sends push with
// @block65/webcrypto-web-push, which has no key generator, and pulling in another push library just
// for this script would put a second push stack in the dependency tree. The output format is the one every
// Web Push implementation uses — RFC 8292 §3.2 — so keys generated here work anywhere:
//   public:  the raw uncompressed P-256 point (65 bytes, 0x04-prefixed), base64url
//   private: the 32-byte private scalar, base64url (the JWK `d` value)
import { webcrypto } from 'node:crypto';

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', publicKey));
const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);

const publicKeyB64 = Buffer.from(raw).toString('base64url');

const sealKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url');

console.log('\nGenerated VAPID keys — paste these into your .env:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKeyB64}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
console.log('\nKeep the private key secret. Changing keys invalidates existing subscriptions (installed apps re-subscribe on their next launch).\n');
console.log('And a key that seals the push keys inside backups (optional; see docs/DEPLOYMENT.md § Backups):\n');
console.log(`BACKUP_SEAL_KEY=${sealKey}`);
console.log('\nKeep it with the other secrets: a backup\'s push keys open only where this key is set.\n');
