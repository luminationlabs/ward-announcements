/**
 * The parts of a deployment's identity the app can supply for itself.
 *
 * A Deploy-to-Cloudflare button can prompt for a password, but it cannot run `npm run vapid`, and
 * it cannot know the `*.workers.dev` address the Worker will be given until after it exists. So
 * when the environment leaves them unset:
 *
 * - **The VAPID keypair** is generated once and kept in `settings`. It is minted insert-if-absent
 *   and re-read, as one JSON value, so two isolates racing a first boot agree on one *pair* rather
 *   than each winning half. Keys set in the environment always win; an existing deployment's
 *   subscriptions are tied to those and must never be silently re-keyed.
 * - **The public origin** is learned from the first https request a signed-in **admin** makes (see
 *   the middleware in `app.ts`), and kept in `settings` the same way. Only an admin's request, and
 *   only the request URL's own origin with no forwarded headers: this value becomes the address in
 *   every notification and share link, so it must not be something a stranger's `Host` header can
 *   set. First one wins; a ward that later moves to a custom domain sets `PUBLIC_ORIGIN` to say so.
 *
 * Everything here mutates the live `config` object, so the rest of the app reads one place.
 */
import { config } from './config.js';
import { getSetting, getSettings, setSettingIfAbsent } from './db.js';
import { logger } from './log.js';

const VAPID_SETTING = 'vapid_keys';
const ORIGIN_SETTING = 'public_origin';

/**
 * The stored pair's shape. `subject` is optional and only ever written by the many-ward host's
 * Import Backup, which carries a moved ward's own contact address over with its keys.
 */
export interface StoredVapid {
  publicKey: string;
  privateKey: string;
  subject?: string;
}

/** The setting the pair is kept under (written by the host's Import Backup too). */
export const VAPID_KEYS_SETTING = VAPID_SETTING;

/** Fill whatever the environment left unset from `settings`, minting the keypair if needed. */
export async function loadStoredIdentity(): Promise<void> {
  const needKeys = !config.vapid.publicKey && !config.vapid.privateKey;
  const needOrigin = !config.publicOrigin;
  if (!needKeys && !needOrigin) return;

  const stored = await getSettings([VAPID_SETTING, ORIGIN_SETTING]);
  if (needOrigin) config.publicOrigin = stored.get(ORIGIN_SETTING) ?? '';
  if (needKeys) {
    let raw = stored.get(VAPID_SETTING) ?? null;
    if (!raw) {
      await setSettingIfAbsent(VAPID_SETTING, JSON.stringify(await generateVapidKeys()));
      raw = await getSetting(VAPID_SETTING);
      logger.info('generated a VAPID keypair and stored it in the database');
    }
    const pair = JSON.parse(raw ?? '{}') as Partial<StoredVapid>;
    config.vapid.publicKey = pair.publicKey ?? '';
    config.vapid.privateKey = pair.privateKey ?? '';
    // A stored subject goes with the stored pair, and like it yields to the environment.
    if (!config.vapid.subject && isVapidSubject(pair.subject ?? '')) config.vapid.subject = pair.subject!;
  }
}

/** What `VAPID_SUBJECT` may be (config.ts holds the environment to the same rule). */
export function isVapidSubject(subject: string): boolean {
  return subject.startsWith('mailto:') || subject.startsWith('https://');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return null;
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/**
 * Why a VAPID pair cannot be used, or null when it can: both halves well-formed (a 65-byte
 * uncompressed P-256 point, a 32-byte scalar, base64url as `npm run vapid` prints them) and the
 * private key the public one's own — checked by signing with one and verifying with the other,
 * because a mismatched pair is accepted by every push service at subscribe time and then fails every
 * delivery with a 403, which looks like a dead subscriber list rather than a typo.
 */
export async function checkVapidPair(publicKey: string, privateKey: string): Promise<string | null> {
  const pub = fromBase64url(publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4) {
    return 'The public key is not a VAPID public key (87 base64url characters, starting with B).';
  }
  const priv = fromBase64url(privateKey);
  if (!priv || priv.length !== 32) {
    return 'The private key is not a VAPID private key (43 base64url characters).';
  }
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  try {
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
    const signer = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: b64(pub.slice(1, 33)), y: b64(pub.slice(33, 65)), d: b64(priv), ext: true },
      algorithm,
      false,
      ['sign'],
    );
    const verifier = await crypto.subtle.importKey('raw', pub, algorithm, false, ['verify']);
    const message = new TextEncoder().encode('ward-announcements vapid pair check');
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, message);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature, message);
    return ok ? null : 'The private key does not belong to that public key.';
  } catch {
    return 'The private key does not belong to that public key.';
  }
}

/**
 * Re-read a learned origin this isolate booted without. For the send path: a Worker isolate woken by
 * the cron may have booted before the admin's first visit taught a *different* isolate the address.
 * One query, and only while the origin is still unknown.
 */
export async function refreshLearnedOrigin(): Promise<void> {
  if (config.publicOrigin) return;
  config.publicOrigin = (await getSetting(ORIGIN_SETTING)) ?? '';
}

/**
 * Adopt `origin` as the public origin if none is configured or learned yet. Called with the URL of a
 * signed-in admin's request; anything not https (local dev, a Node box behind a TLS proxy) is
 * ignored, which leaves Node deployments on `PUBLIC_ORIGIN` as before.
 */
export async function learnOrigin(origin: string): Promise<void> {
  if (config.publicOrigin || !origin.startsWith('https://')) return;
  await setSettingIfAbsent(ORIGIN_SETTING, origin);
  config.publicOrigin = (await getSetting(ORIGIN_SETTING)) ?? origin;
  logger.info({ origin: config.publicOrigin }, 'learned the public origin from an admin request');
}

/** The contact address push services require: `VAPID_SUBJECT`, else the site's own https origin. */
export function vapidSubject(): string {
  return config.vapid.subject || config.publicOrigin;
}

/** A fresh P-256 keypair in the base64url forms `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` take. */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    publicKey: Buffer.from(publicRaw).toString('base64url'),
    privateKey: privateJwk.d ?? '',
  };
}
