// A software passkey authenticator for the tests: what Face ID and the platform's keychain do when a
// page calls navigator.credentials.create() / .get(), done with WebCrypto so the server's real
// verification (SimpleWebAuthn) runs against real signatures, end to end, on both runtimes.
//
// It produces the JSON the browser half of SimpleWebAuthn posts (`RegistrationResponseJSON` /
// `AuthenticationResponseJSON`). Attestation is "none", as platform passkeys send by default.

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const sha256 = async (bytes) => new Uint8Array(await subtle.digest('SHA-256', bytes));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// --- Just enough CBOR (RFC 8949) for an attestation object and a COSE key ---------------------
function head(major, n) {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return concat(new Uint8Array([(major << 5) | 26]), u32(n));
}
function cbor(value) {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}

/** A raw (r || s) P-256 signature as the DER SEQUENCE WebAuthn carries. */
function derSignature(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/**
 * One authenticator holding passkeys, as a phone's keychain does. `create()` answers a registration
 * options object, `get()` an authentication one; each returns the browser's JSON response.
 */
export function createAuthenticator({ origin }) {
  const rpId = new URL(origin).hostname;
  const credentials = new Map(); // id (b64url) -> { keyPair, userHandle, counter }

  async function clientData(type, challenge) {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  return {
    credentials,

    /** navigator.credentials.create(), for SimpleWebAuthn's registration options JSON. */
    async create(options) {
      const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const jwk = await subtle.exportKey('jwk', keyPair.publicKey);
      const credentialId = webcrypto.getRandomValues(new Uint8Array(16));
      const coseKey = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]));
      const authData = concat(
        await sha256(new TextEncoder().encode(options.rp?.id ?? rpId)),
        new Uint8Array([0x45]), // user present, user verified, attested credential data
        u32(0),
        new Uint8Array(16), // AAGUID
        new Uint8Array([0, credentialId.length]),
        credentialId,
        coseKey,
      );
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      const id = b64url(credentialId);
      credentials.set(id, { keyPair, userHandle: options.user.id, counter: 0 });
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(await clientData('webauthn.create', options.challenge)),
          attestationObject: b64url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    /** navigator.credentials.get(), for SimpleWebAuthn's authentication options JSON. */
    async get(options, { credentialId, userVerified = true } = {}) {
      const allowed = (options.allowCredentials ?? []).map((c) => c.id);
      const id = credentialId ?? (allowed.find((a) => credentials.has(a)) || [...credentials.keys()][0]);
      const cred = credentials.get(id);
      if (!cred) throw new Error('authenticator: no passkey for this site');
      cred.counter += 1;
      const authData = concat(await sha256(new TextEncoder().encode(options.rpId ?? rpId)), new Uint8Array([userVerified ? 0x05 : 0x01]), u32(cred.counter)); // UP | UV, or a touch alone
      const cdj = await clientData('webauthn.get', options.challenge);
      const raw = new Uint8Array(
        await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.keyPair.privateKey, concat(authData, await sha256(cdj))),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(cdj),
          authenticatorData: b64url(authData),
          signature: b64url(derSignature(raw)),
          userHandle: cred.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
