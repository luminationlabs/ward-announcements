/**
 * Import Backup on the many-ward host: what is particular to loading a backup into a *hosted* ward,
 * on top of the restore every deployment shares (`restore.ts`).
 *
 * `host.ts` runs the result inside the ward's Durable Object, as one transaction with the ward's
 * reboot (see `WardDO.importBackup`); the operator's page drives it (src/operator.ts). This module
 * is pure apart from WebCrypto, so it is the same code under `wrangler dev` and in the Node tests.
 *
 * What a hosted ward keeps of its own, whatever the backup says:
 *
 * - **Its place on the host** — the `host_ward_*` settings (its id and hostname, whether it is
 *   suspended). A backup exported from another hosted ward carries *that* ward's, which would point
 *   this one at someone else's address.
 * - **Its address.** A learned `public_origin` from a different hostname is dropped (it would
 *   otherwise outrank the ward's own `https://<hostname>` and put the old address in every
 *   notification), and the difference is reported, because passkeys belong to the address.
 * - **Its name and timezone, and its push keys, when the backup has none.** A backup from before
 *   either was stored in the database (the original single-ward code read both from the
 *   environment) would otherwise leave the ward nameless and minting a fresh pair.
 *
 * And the push keys: a backup carries its pair sealed under the deployment's `BACKUP_SEAL_KEY`
 * (`seal.ts`), which this host opens with its own key — so an export of a hosted ward imports back
 * with every subscription intact, while a file from another deployment stays locked. An old
 * deployment that pinned `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` as Worker secrets has none in its
 * backup at all, yet every subscription in it was made against them. The operator may supply the
 * pair; it is checked (well-formed, and the private half belongs to the public one) and stored the
 * way `identity.ts` stores a generated pair, so the ward signs with the old keys.
 */
import { checkVapidPair, generateVapidKeys, isVapidSubject, VAPID_KEYS_SETTING, type StoredVapid } from './identity.js';
import { isPushEndpoint } from './push.js';
import { contentTypeForKey, extensionFor, isPdfBytes, isValidKey, maxBytesFor, PDF_TYPE } from './filestore.js';
import { unsealBackupTables, type SealedState } from './seal.js';
import {
  attachmentKeys,
  planRestore,
  RestoreError,
  rowsOf,
  withRows,
  type RestorePlan,
  type RestoreValue,
  type SchemaTable,
} from './restore.js';

/** The largest backup JSON the operator page will send (a ward's is typically well under 5 MB). */
export const MAX_IMPORT_JSON_BYTES = 12 * 1024 * 1024;
/** The largest batch of images (base64, in JSON) in one request; the page sends about 2 MB of images. */
export const MAX_IMAGE_BATCH_BYTES = 8 * 1024 * 1024;

const HOST_PREFIX = 'host_ward_';
const ORIGIN_SETTING = 'public_origin';
const WARD_SETTINGS = 'ward_settings';

export interface ImportOptions {
  vapidPublicKey?: unknown;
  vapidPrivateKey?: unknown;
  vapidSubject?: unknown;
}

/** What the importing ward already has that the import may keep. */
export interface ImportTarget {
  hostname: string;
  /** Its `host_ward_*` settings, always kept. */
  hostSettings: Record<string, string | null>;
  /** Its stored push keys and ward settings, kept when the backup has none. */
  vapidKeys: string | null;
  wardSettings: string | null;
  /**
   * Whether the host runs in production, where a subscription must be at a real push service.
   * Passed in rather than read from `config`: the import is prepared outside the ward's context,
   * where the per-ward config has nothing to answer with.
   */
  production: boolean;
  /**
   * The host's `BACKUP_SEAL_KEY` ('' when it has none), which opens a sealed pair in the backup.
   * Handed in for the same reason as `production`.
   */
  sealKey: string;
}

/** Where the ward's push keys came from after the import. */
export type PushKeySource = 'supplied' | 'backup' | 'ward' | 'new';

export interface ImportReport {
  app: string | null;
  exportedAt: string | null;
  fromVersion: number | null;
  toVersion: number;
  tables: { name: string; rows: number; inBackup: boolean }[];
  dropped: Record<string, string[]>;
  ignored: string[];
  push: { source: PushKeySource; publicKey: string; subject: string | null; sealed: SealedState };
  images: { count: number; bytes: number; keys: string[] };
  origin: { backup: string | null; ward: string; matches: boolean | null };
  people: number;
  passkeys: number;
  subscribers: number;
  warnings: string[];
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The address a backup says it came from: a learned origin, or a hosted ward's own hostname. */
function backupOrigin(settings: Map<string, RestoreValue>): string | null {
  const learned = settings.get(ORIGIN_SETTING);
  if (typeof learned === 'string' && learned) return learned.replace(/\/$/, '');
  const identity = settings.get(`${HOST_PREFIX}identity`);
  if (typeof identity === 'string') {
    try {
      const hostname = (JSON.parse(identity) as { hostname?: unknown }).hostname;
      if (typeof hostname === 'string' && hostname) return `https://${hostname}`;
    } catch {
      /* not ours to fix; there is simply no address to compare */
    }
  }
  return null;
}

/**
 * Check a backup and the operator's options, and plan the restore into a hosted ward. Throws
 * `RestoreError` (a message for the operator) on anything it will not do; nothing is written here.
 */
export async function prepareImport(
  backup: unknown,
  options: ImportOptions,
  target: ImportTarget,
  schema: { tables: SchemaTable[]; version: number },
): Promise<{ plan: RestorePlan; report: ImportReport }> {
  const publicKey = text(options.vapidPublicKey);
  const privateKey = text(options.vapidPrivateKey);
  const subject = text(options.vapidSubject);
  if (!!publicKey !== !!privateKey) throw new RestoreError('Give both push keys (public and private), or neither.');
  if (publicKey) {
    const problem = await checkVapidPair(publicKey, privateKey);
    if (problem) throw new RestoreError(problem);
  }
  if (subject && !isVapidSubject(subject)) {
    throw new RestoreError('The push contact must be a mailto: or https:// address.');
  }

  // The sealed pair is opened (or dropped) before the planner sees the file: a locked blob must
  // never be written into `settings`, and the planner keeps the ward's own pair when none opened.
  const unsealed =
    backup && typeof backup === 'object' && !Array.isArray(backup)
      ? await unsealBackupTables((backup as { tables?: unknown }).tables, target.sealKey)
      : { tables: undefined, sealed: 'none' as SealedState };
  let plan = planRestore(
    unsealed.tables === undefined ? backup : { ...(backup as Record<string, unknown>), tables: unsealed.tables },
    schema.tables,
    schema.version,
  );
  const warnings: string[] = [];

  // --- subscriptions ---
  // Every one is a URL the host will POST to on each send. `/api/subscribe` only stores real push
  // services, but a backup is a file: hand-edited, corrupted, or from a deployment outside
  // production (which accepts any https host). Hold its rows to the same rule rather than have
  // every Sunday's digest go wherever a file said.
  const subscriptions = rowsOf(plan, 'subscriptions');
  const deliverable = subscriptions.filter((r) => isPushEndpoint(String(r.endpoint ?? ''), target.production));
  if (deliverable.length < subscriptions.length) {
    plan = withRows(plan, 'subscriptions', deliverable);
    warnings.push(
      `${subscriptions.length - deliverable.length} subscription(s) in the backup were not at a push service, ` +
        'and were left out.',
    );
  }

  // --- settings ---
  const given = new Map(rowsOf(plan, 'settings').map((r) => [String(r.key), r.value]));
  const origin = backupOrigin(given);
  const wardOrigin = `https://${target.hostname}`;
  const settings = new Map<string, RestoreValue>();
  for (const [key, value] of given) {
    if (key.startsWith(HOST_PREFIX)) continue; // another ward's place on the host, never this one's
    if (key === ORIGIN_SETTING && value !== wardOrigin) continue;
    settings.set(key, value);
  }
  for (const [key, value] of Object.entries(target.hostSettings)) settings.set(key, value);
  if (!settings.has(WARD_SETTINGS) && target.wardSettings) settings.set(WARD_SETTINGS, target.wardSettings);
  // The backup's own ward was seeded long ago; never put the sample announcement into it now.
  settings.set('seeded', '1');

  let source: PushKeySource;
  let pair: StoredVapid;
  const parsePair = (raw: RestoreValue | null): StoredVapid | null => {
    try {
      const p = JSON.parse(String(raw)) as Partial<StoredVapid>;
      return p.publicKey && p.privateKey ? (p as StoredVapid) : null;
    } catch {
      return null;
    }
  };
  const fromBackup = parsePair(given.get(VAPID_KEYS_SETTING) ?? null);
  const fromWard = parsePair(target.vapidKeys);
  if (publicKey) {
    source = 'supplied';
    pair = { publicKey, privateKey };
  } else if (fromBackup) {
    source = 'backup';
    pair = fromBackup;
  } else if (fromWard) {
    source = 'ward';
    pair = fromWard;
  } else {
    source = 'new';
    pair = await generateVapidKeys();
  }
  if (subject) pair = { ...pair, subject };
  settings.set(VAPID_KEYS_SETTING, JSON.stringify(pair));
  plan = withRows(
    plan,
    'settings',
    [...settings].map(([key, value]) => ({ key, value })),
  );

  // --- what to tell the operator ---
  const count = (name: string) => plan.tables.find((t) => t.name === name)?.rows.length ?? 0;
  const subscribers = count('subscriptions');
  const people = count('admin_users');
  const passkeys = count('admin_passkeys');
  const keys = attachmentKeys(plan);
  const bytes = rowsOf(plan, 'attachments').reduce((sum, r) => sum + (typeof r.size === 'number' ? r.size : 0), 0);
  const matches = origin === null ? null : origin === wardOrigin;

  if (publicKey && fromBackup && fromBackup.publicKey !== publicKey) {
    warnings.push('The backup had push keys of its own; the ones you gave replace them.');
  }
  if (unsealed.sealed === 'locked' && source !== 'supplied') {
    warnings.push(
      "The backup's push keys are sealed with another deployment's key (or this host has no BACKUP_SEAL_KEY); " +
        'the ward keeps its own pair. Import again with the keys to keep every subscription.',
    );
  } else if (subscribers > 0 && (source === 'ward' || source === 'new')) {
    warnings.push(
      `${subscribers} subscriber(s) in this backup signed up with push keys that are not in it. Import again ` +
        'with the old keys, or every member will have to turn notifications off and on again.',
    );
  }
  if (matches === false) {
    warnings.push(
      `The backup comes from ${origin}, but this ward is ${wardOrigin}. Passkeys only work on the address they ` +
        'were made on, so its people need new invites, and members need the new address.',
    );
  }
  const codes = plan.tables.find((t) => t.name === 'access_codes');
  if (codes?.inBackup && codes.rows.length === 0) {
    // The original code let a ward switch its member gate off; every deployment now has it on.
    warnings.push(
      'The backup has no access code (its member gate was off), so this ward makes a new one and nobody is ' +
        'signed in yet: share the new link from the ward’s dashboard.',
    );
  }
  if (people === 0) {
    warnings.push('The backup has no dashboard people (it may predate passkeys). Use Invite admin to get into the ward.');
  }

  return {
    plan,
    report: {
      app: plan.app,
      exportedAt: plan.exportedAt,
      fromVersion: plan.fromVersion,
      toVersion: schema.version,
      tables: plan.tables.map((t) => ({ name: t.name, rows: t.rows.length, inBackup: t.inBackup })),
      dropped: plan.dropped,
      ignored: plan.ignored,
      push: { source, publicKey: pair.publicKey, subject: pair.subject ?? null, sealed: unsealed.sealed },
      images: { count: keys.length, bytes, keys },
      origin: { backup: origin, ward: wardOrigin, matches },
      people,
      passkeys,
      subscribers,
      warnings,
    },
  };
}

/** The type a file's first bytes say it is, for the five types an upload may be. */
function sniff(bytes: Uint8Array): string | null {
  const at = (i: number, ...want: number[]) => want.every((b, j) => bytes[i + j] === b);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (isPdfBytes(bytes)) return PDF_TYPE;
  return null;
}

/**
 * The type the object stored under `key` should be, given the restored row that names it: the row's
 * own type for its file, JPEG for a PDF's thumbnail.
 */
export function importedTypeFor(key: string, row: { key?: unknown; content_type: string; thumb_key?: unknown }): string {
  return row.thumb_key === key && row.key !== key ? 'image/jpeg' : row.content_type.toLowerCase();
}

/**
 * Why one image from a backup may not be stored, or null when it may. `row` is the restored
 * attachment row with that key (as its file or its thumbnail): only images the restored ward
 * actually names are accepted, with the limits and types of an ordinary upload, and bytes that
 * really are that type.
 */
export function checkImportedImage(
  key: string,
  bytes: Uint8Array,
  row: { key?: unknown; content_type: string; thumb_key?: unknown } | undefined,
): string | null {
  if (!isValidKey(key)) return 'not an image name this app makes';
  if (!row) return 'no image of that name in the restored ward';
  const type = importedTypeFor(key, row);
  const extension = extensionFor(type);
  if (!extension || contentTypeForKey(key) !== type) return `not an allowed image type (${type})`;
  if (bytes.byteLength === 0) return 'empty';
  const max = maxBytesFor(type);
  if (bytes.byteLength > max) return `over ${Math.round(max / (1024 * 1024))} MB`;
  if (sniff(bytes) !== type) {
    return type === PDF_TYPE ? 'the file is not a PDF' : `the file is not a ${type.slice('image/'.length).toUpperCase()} image`;
  }
  return null;
}

export { RestoreError };
