/**
 * Sealing the push keys inside a backup.
 *
 * The admin backup (`/admin/backup.json`) and the operator's export carry the VAPID pair — the
 * private key beside every subscriber's endpoint and encryption keys is everything needed to push
 * to every member's phone, and a push service ties a subscription to the key it was made with, so a
 * leaked pair has no quiet rotation. Leaving the pair out of the backup, as the app once did, cost
 * every member a re-subscribe on any restore to a fresh database. The middle way, here: the pair
 * travels in the file **sealed** under a secret only the deployment holds (`BACKUP_SEAL_KEY`), so a
 * restore or import on the same deployment opens it without anyone noticing, and the file on its
 * own is useless to whoever finds it in a shared folder years later.
 *
 * AES-256-GCM through WebCrypto, a random 96-bit IV per call, and the setting's name as the
 * additional authenticated data, so a blob lifted from one setting cannot be replayed into another.
 * The blob is JSON, versioned, in the `settings` row `vapid_keys_sealed` in place of `vapid_keys`.
 *
 * Pure and dependency-free on purpose, like `restore.ts`: `scripts/db-restore.mjs` imports this file
 * directly (Node strips the types), so there is no build step between an operator and a restore.
 * Only erasable TypeScript here, and nothing imported.
 */

/** The `settings` key the sealed pair travels under; `vapid_keys` (identity.ts) is the open one. */
export const VAPID_KEYS_SEALED_SETTING = 'vapid_keys_sealed';
const VAPID_KEYS_SETTING = 'vapid_keys';

/** What `BACKUP_SEAL_KEY` must decode to. */
export const SEAL_KEY_BYTES = 32;
const IV_BYTES = 12;
/** Binds a blob to the one setting it was sealed for (see the header). */
const AAD = 'vapid_keys';

export interface SealedBlob {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
}

/**
 * The key's bytes, or null when the value is not 32 bytes of base64url (standard base64 is taken
 * too, since every generator prints one or the other). Checked strictly: `Buffer` skips characters
 * it does not know, which would turn a typo into a different key that opens nothing.
 */
export function decodeSealKey(key: string): Uint8Array<ArrayBuffer> | null {
  const trimmed = key.trim().replace(/=+$/, '');
  if (!/^[A-Za-z0-9_+/-]+$/.test(trimmed)) return null;
  const bytes = new Uint8Array(Buffer.from(trimmed, 'base64url'));
  return bytes.length === SEAL_KEY_BYTES ? bytes : null;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, 'base64url'));

async function aesKey(key: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const bytes = decodeSealKey(key);
  if (!bytes) throw new Error(`BACKUP_SEAL_KEY must be ${SEAL_KEY_BYTES} random bytes, base64url-encoded.`);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [usage]);
}

/** Seal `plaintext` under `key` (a `BACKUP_SEAL_KEY` value). Throws only on a malformed key. */
export async function sealSecret(plaintext: string, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(AAD) },
    await aesKey(key, 'encrypt'),
    new TextEncoder().encode(plaintext),
  );
  const blob: SealedBlob = { v: 1, alg: 'A256GCM', iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
  return JSON.stringify(blob);
}

/**
 * Open a blob `sealSecret` made. Null — never a throw — on the wrong key, a malformed blob or a
 * tampered one: a caller holding a backup wants "locked", not a stack trace, and must not learn
 * which of the three it was.
 */
export async function unsealSecret(blob: string, key: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(blob) as Partial<SealedBlob>;
    if (!isSealed(parsed)) return null;
    const iv = fromB64url(parsed.iv);
    if (iv.length !== IV_BYTES) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(AAD) },
      await aesKey(key, 'decrypt'),
      fromB64url(parsed.ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Does this look like a blob `sealSecret` made (a parsed object, or its JSON text)? */
export function isSealed(value: unknown): value is SealedBlob {
  if (typeof value === 'string') {
    try {
      return isSealed(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && v.alg === 'A256GCM' && typeof v.iv === 'string' && typeof v.ct === 'string';
}

/**
 * A dump's `settings` rows as a backup or export carries them: the `vapid_keys` row replaced by a
 * `vapid_keys_sealed` row under `key`, or left out when there is no key. Never a plaintext pair.
 * Shared by `/admin/backup.json` (app.ts) and the operator's export (host.ts) so the two files
 * cannot disagree, and `unsealBackupTables` below is the inverse.
 */
export async function sealBackupSettings<R extends { key?: unknown; value?: unknown }>(
  rows: R[],
  key: string,
): Promise<(R | { key: string; value: string })[]> {
  const pair = rows.find((r) => r?.key === VAPID_KEYS_SETTING);
  const rest = rows.filter((r) => r?.key !== VAPID_KEYS_SETTING);
  if (!pair || !key || typeof pair.value !== 'string') return rest;
  return [...rest, { key: VAPID_KEYS_SEALED_SETTING, value: await sealSecret(pair.value, key) }];
}

export type SealedState = 'opened' | 'locked' | 'none';

/**
 * A dump's `settings` rows with the sealed pair opened — or dropped. Given a backup's `tables`:
 * a `vapid_keys_sealed` row that opens under `key` becomes a plain `vapid_keys` row, so the
 * planner (`restore.ts`) restores the pair like any setting; one that does not open (another
 * deployment's key, or none here) is dropped, so the planner's `KEPT_UNLESS_IN_BACKUP` keeps the
 * target's own pair, and `sealed` says which happened. A backup with no sealed row is left alone
 * (`'none'`), a plaintext `vapid_keys` row included: the operator's export from a host with no seal
 * key, or a backup from before sealing.
 *
 * The rows are copied, never edited in place: callers hold the parsed file and may plan it twice.
 */
export async function unsealBackupTables<T>(tables: T, key: string): Promise<{ tables: T; sealed: SealedState }> {
  if (!tables || typeof tables !== 'object') return { tables, sealed: 'none' };
  const settings = (tables as Record<string, unknown>).settings;
  if (!Array.isArray(settings)) return { tables, sealed: 'none' };
  const isRow = (r: unknown): r is { key?: unknown; value?: unknown } => !!r && typeof r === 'object';
  const sealedRow = settings.find((r) => isRow(r) && r.key === VAPID_KEYS_SEALED_SETTING);
  if (!sealedRow) return { tables, sealed: 'none' };
  const blob = isRow(sealedRow) && typeof sealedRow.value === 'string' ? sealedRow.value : '';
  const opened = key && decodeSealKey(key) ? await unsealSecret(blob, key) : null;
  // Opened, the pair replaces any plaintext row beside it (nothing writes both; a hand-made file
  // might); locked, a plaintext row is left to the planner as it is.
  const dropped = new Set(opened === null ? [VAPID_KEYS_SEALED_SETTING] : [VAPID_KEYS_SEALED_SETTING, VAPID_KEYS_SETTING]);
  const rest = settings.filter((r) => !(isRow(r) && typeof r.key === 'string' && dropped.has(r.key)));
  const rows = opened === null ? rest : [...rest, { key: VAPID_KEYS_SETTING, value: opened }];
  return { tables: { ...tables, settings: rows }, sealed: opened === null ? 'locked' : 'opened' };
}
