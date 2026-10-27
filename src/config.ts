/**
 * Configuration, as a pure function of an environment.
 *
 * Node reads `process.env` once at boot; Cloudflare Workers has no ambient environment at all — the
 * bindings and vars arrive as an `env` argument on every request — so nothing here may reach for
 * `process`. `loadConfig(env)` takes the environment as data, and installs the result in the `config`
 * live binding that the rest of the app reads.
 *
 * `config` is an ES module *live binding*: every module that does `import { config } from
 * './config.js'` sees whatever `loadConfig` last installed, without threading a parameter through
 * fifty call sites. That works because nothing reads `config` at import time — only inside request
 * handlers and other functions, all of which run after the entry point has loaded it.
 */
import { createHash } from 'node:crypto';
import { logger } from './log.js';
import { decodeSealKey, SEAL_KEY_BYTES } from './seal.js';
import { tenantLocal } from './tenant.js';

/** The environment as this module consumes it: a plain bag of strings, from anywhere. */
export type Env = Record<string, string | undefined>;

export interface AppConfig {
  port: number;
  databasePath: string;
  /** Node only: directory holding uploaded images. Workers stores them in R2 and ignores this. */
  uploadsPath: string;
  appName: string;
  appShortName: string;
  appDescription: string;
  appFooter: string;
  linkText: string;
  linkUrl: string;
  isProduction: boolean;
  publicOrigin: string;
  timezone: string;
  /** How many subscribers one drain of the send queue handles. See `pushChunkSize` below. */
  pushChunkSize: number;
  /** Most image storage a ward may use, in bytes (0 = no limit). See `imageQuotaBytes` below. */
  imageQuotaBytes: number;
  vapid: { publicKey: string; privateKey: string; subject: string };
  /** Seals the push keys inside backups and exports (`seal.ts`); '' = they are left out. */
  backupSealKey: string;
  adminPassword: string;
  sessionSecret: string;
  /**
   * Problems found while parsing numeric vars. Collected rather than thrown during `loadConfig`,
   * because a raw throw there would surface as an unreadable stack before anything else boots.
   * `assertConfig()` reports them alongside the missing-var errors instead.
   */
  envErrors: string[];
}

/**
 * Parse a whole-number var, falling back when it's absent or blank.
 *
 * The fallback path matters: an unset var and a var set to the empty string (easy to do by
 * accident in a hosting UI) must both mean "use the default", not "0". And a non-numeric value has
 * to fail loudly at boot — left unchecked it becomes NaN, which reaches `new Date(...)` and throws
 * `RangeError: Invalid time value` deep inside a request, 500-ing the manifest or an invite long
 * after anyone would connect it to a typo in the config.
 */
function intVar(
  env: Env,
  errors: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
    return fallback;
  }
  return n;
}

/**
 * `TZ`, or the default when it is unset or blank. Checked here because nothing downstream can
 * recover from a bad one: an empty `TZ=` (Docker's `-e TZ`, an empty `.env` line) is not nullish,
 * so it reached `Intl` as `''` and threw out of the boot-time purge — an unhandled rejection that
 * killed the Node process on every start, before anyone could reach the dashboard to pick a zone.
 */
function timeZoneVar(env: Env, errors: string[], fallback: string): string {
  const raw = env.TZ?.trim();
  if (!raw) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    errors.push(`TZ must be an IANA time zone such as America/Denver (got "${env.TZ}").`);
    return fallback;
  }
}

/**
 * `uploads/` beside the database file. Spelled with string surgery rather than `node:path` because
 * this module is loaded by the Workers entry too, where the value is never used and a Node built-in
 * would be dead weight in the bundle. A `DATABASE_PATH` with no directory part (`app.db`) yields
 * `./uploads`.
 */
function defaultUploadsPath(databasePath: string): string {
  const cut = Math.max(databasePath.lastIndexOf('/'), databasePath.lastIndexOf('\\'));
  if (cut < 0) return './uploads';
  // Keep a leading slash when the database is at the filesystem root ('/app.db').
  const dir = cut === 0 ? '/' : databasePath.slice(0, cut);
  return dir === '/' ? '/uploads' : `${dir}/uploads`;
}

/** Build a config from an environment. Pure — it installs nothing. */
export function buildConfig(env: Env): AppConfig {
  const envErrors: string[] = [];
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const databasePath = env.DATABASE_PATH ?? './data/app.db';
  return {
    port: intVar(env, envErrors, 'PORT', 3000, 1, 65535),
    databasePath,
    /**
     * Where the Node deployment writes uploaded images. Defaults to an `uploads/` directory beside
     * the SQLite file, so the one persistent volume a Node deployment already needs covers the
     * images too — pointing it elsewhere means remembering to back up two places. Unused on
     * Workers, where the bytes go to the R2 bucket bound as `IMAGES`.
     */
    uploadsPath: env.UPLOADS_PATH?.trim() ? env.UPLOADS_PATH.trim() : defaultUploadsPath(databasePath),
    /**
     * App identity, shown to members and used for the PWA manifest. All three are required (no
     * default) so a deployment must declare its own name.
     * - appName: full title (manifest `name`, page title, header, install steps, push title).
     * - appShortName: home-screen label (manifest `short_name`, iOS apple-mobile-web-app-title).
     * - appDescription: one-line summary (manifest `description`, page meta description).
     */
    appName: env.APP_NAME ?? '',
    appShortName: env.APP_SHORT_NAME ?? '',
    appDescription: env.APP_DESCRIPTION ?? '',
    /** Optional footer line on the public page (e.g. an audience note / disclaimer). Blank = none. */
    appFooter: env.APP_FOOTER ?? '',
    /**
     * Optional link shown below the announcements on the public page (e.g. back to the ward's
     * Google Site). Both LINK_TEXT and LINK_URL must be set for it to appear — either alone shows
     * nothing.
     */
    linkText: env.LINK_TEXT ?? '',
    linkUrl: env.LINK_URL ?? '',
    isProduction: env.NODE_ENV === 'production',
    /** Absolute origin (https://host) for notification and share links. Blank = learned (identity.ts). */
    publicOrigin: (env.PUBLIC_ORIGIN ?? '').replace(/\/$/, ''),
    /** Timezone for the weekly schedule (the send day/time itself is set in the admin UI). */
    timezone: timeZoneVar(env, envErrors, 'America/Denver'),
    /**
     * Subscribers per drain of the send queue.
     *
     * Sized for the tightest runtime, the Cloudflare free plan's nominal 10 ms of CPU per
     * invocation. One send is a VAPID ECDSA signature plus an RFC 8291 encryption, measured at
     * ~0.25 ms on a dev machine and 0.6–1.1 ms on Workers in production — so twelve sits at or a
     * little over the nominal budget, which the free plan tolerates for occasional overruns (one
     * measured invocation ran 500 sends). A ward-sized list drains in a handful of cron ticks. Node
     * and the many-ward host (Workers Paid) ignore the ceiling — they drain until empty.
     */
    pushChunkSize: intVar(env, envErrors, 'PUSH_CHUNK_SIZE', 12, 1, 90), // 90: one chunk's ids go in one IN list (db.ts)
    /**
     * The most image storage one ward may use, in bytes; 0 = no limit (the default — a ward on its
     * own deployment is bounded by its own plan). Set on the many-ward host so one ward's flyers
     * cannot fill storage every ward pays for. From `IMAGE_QUOTA_MB`.
     */
    imageQuotaBytes: intVar(env, envErrors, 'IMAGE_QUOTA_MB', 0, 0, 100_000) * 1024 * 1024,
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY ?? '',
      privateKey: env.VAPID_PRIVATE_KEY ?? '',
      /** Contact address push services require, as `mailto:` or `https:`. Blank = the site's origin. */
      subject: env.VAPID_SUBJECT ?? '',
    },
    /**
     * The secret that seals the VAPID pair inside the admin backup and the operator's export, so a
     * restore on this deployment gets the keys back and a leaked file cannot send. Optional: unset,
     * the backup leaves the pair out and a restore to a fresh database re-keys the ward. One per
     * deployment, host-wide on the many-ward host (every ward's export opens with the same key),
     * which is why `operator.ts`'s `wardVars` does not strip it. `npm run vapid` prints one.
     */
    backupSealKey: (env.BACKUP_SEAL_KEY ?? '').trim(),
    adminPassword,
    /**
     * Secret for signing the **admin session** cookie, derived from the admin password on purpose:
     * changing the password should end open admin sessions, and there is only ever one admin, so a
     * separate rotation knob would go unused. Note this deliberately does *not* sign the member
     * access cookie — that has its own secret, generated once and kept in the `settings` table (see
     * src/access.ts), so changing the admin password never logs the whole ward out.
     */
    sessionSecret: createHash('sha256')
      .update(`pushannounce-session::${adminPassword}`)
      .digest('hex'),
    envErrors,
  };
}

/** The current ward's config object (see `tenant.ts`); unset until `loadConfig` runs for it. */
const loaded = tenantLocal<{ value: AppConfig | null }>(() => ({ value: null }));

function current(): AppConfig {
  const value = loaded().value;
  // A boot-order bug, in the same family as `db.ts`'s missing driver.
  if (!value) throw new Error('No config loaded for this ward — call loadConfig() first.');
  return value;
}

/**
 * The config every other module reads: a view of the **current ward's** config, so the many
 * `config.x` reads (and the few writes, see `identity.ts`) need no ward argument. Unusable until an
 * entry point calls `loadConfig`, which both entries do before serving anything.
 */
export const config: AppConfig = new Proxy({} as AppConfig, {
  get: (_target, key) => Reflect.get(current(), key),
  set: (_target, key, value) => Reflect.set(current(), key, value),
  has: (_target, key) => Reflect.has(current(), key),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_target, key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
    // A proxy may only report a property as configurable when its target has it; ours is empty.
    return descriptor && { ...descriptor, configurable: true };
  },
});

/** Build a config from `env`, install it as the current ward's `config`, and return it. */
export function loadConfig(env: Env): AppConfig {
  const built = buildConfig(env);
  loaded().value = built;
  return built;
}

/**
 * Fail fast on boot if anything required to send push is missing.
 *
 * The VAPID keys and the public origin may be left unset: `identity.ts` supplies them from the
 * database, which is what lets a Deploy-to-Cloudflare button produce a working app from a password
 * alone. `requireOrigin` is for the Node entry, which sits behind a TLS-terminating proxy and so
 * never sees the https origin it would need to learn.
 */
export function assertConfig(
  cfg: AppConfig = config,
  opts: { requireOrigin?: boolean; requireOwner?: boolean } = {},
): void {
  if (cfg.envErrors.length > 0) {
    throw new ConfigError(`Invalid env var(s):\n  - ${cfg.envErrors.join('\n  - ')}`);
  }
  const missing: string[] = [];
  // Both or neither: one half of a pair is a typo, and generating the other half would only
  // produce a pair that matches no existing subscription.
  if (!!cfg.vapid.publicKey !== !!cfg.vapid.privateKey) {
    missing.push(cfg.vapid.publicKey ? 'VAPID_PRIVATE_KEY' : 'VAPID_PUBLIC_KEY');
  }
  // A single-ward deployment must have an owner: the password is the way in on a fresh database and
  // the way back if every passkey is lost. A ward hosted on a shared deployment passes
  // `requireOwner: false` and is run by people alone; its operator mints the first admin's invite.
  if (opts.requireOwner !== false && !cfg.adminPassword) missing.push('ADMIN_PASSWORD');
  // A password anyone who has read this repository's examples could guess is no password: the
  // examples once shipped `changeme`, and a Deploy button can pre-fill what an example holds.
  if (cfg.adminPassword && KNOWN_EXAMPLE_PASSWORDS.includes(cfg.adminPassword.trim().toLowerCase())) {
    throw new ConfigError(
      'ADMIN_PASSWORD is a well-known example value. Set a long passphrase of your own (in Cloudflare: the Worker\'s Settings → Variables and Secrets; on Node: .env).',
    );
  }
  if (!cfg.appName) missing.push('APP_NAME');
  if (!cfg.appShortName) missing.push('APP_SHORT_NAME');
  if (!cfg.appDescription) missing.push('APP_DESCRIPTION');
  // Declarative Web Push (iOS 18.4+) renders natively and needs an absolute `navigate` URL.
  if (opts.requireOrigin && cfg.isProduction && !cfg.publicOrigin) missing.push('PUBLIC_ORIGIN');
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required env var(s): ${missing.join(', ')}. ` +
        `Copy .env.node.example to .env (or .dev.vars.example to .dev.vars). See docs/DEPLOYMENT.md.`,
    );
  }
  // Optional (it falls back to the site's https origin), but push services reject anything that
  // is not a mailto: or https: address, and only at send time — catch a bad one at boot instead.
  if (
    cfg.vapid.subject &&
    !cfg.vapid.subject.startsWith('mailto:') &&
    !cfg.vapid.subject.startsWith('https://')
  ) {
    throw new ConfigError(
      `VAPID_SUBJECT must be a mailto: or https:// address (got "${cfg.vapid.subject}").`,
    );
  }
  if (cfg.isProduction && cfg.publicOrigin && !cfg.publicOrigin.startsWith('https://')) {
    throw new ConfigError(
      `PUBLIC_ORIGIN must be an absolute https:// URL (got "${cfg.publicOrigin}"). ` +
        `Web Push and iOS notification navigation require HTTPS.`,
    );
  }
  // A seal key that is set but not a key would surface as a 500 on the Backup button, long after
  // the typo. Production refuses to boot over it (the value names a setting, never itself); in
  // development the backup goes out without the pair, as if the var were unset, and the log says so.
  if (cfg.backupSealKey && !decodeSealKey(cfg.backupSealKey)) {
    const message = `BACKUP_SEAL_KEY must be ${SEAL_KEY_BYTES} random bytes, base64url-encoded (npm run vapid prints one).`;
    if (cfg.isProduction) throw new ConfigError(message);
    logger.warn(`${message} Ignoring it: backups will leave the push keys out.`);
    cfg.backupSealKey = '';
  }
  // A warning, never a failure: an existing deployment must not stop booting because its password is
  // short, and locking the ward's only admin out of their own dashboard over a policy is worse than
  // the weak password. It is worth saying out loud though — `/admin/login` is rate-limited to five
  // attempts a minute per IP, which is a real brake on guessing but not on a short dictionary word,
  // and the admin password is also what derives the session-cookie signing key (see `sessionSecret`).
  if (cfg.adminPassword.length > 0 && cfg.adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    logger.warn(
      { length: cfg.adminPassword.length, recommended: MIN_ADMIN_PASSWORD_LENGTH },
      `ADMIN_PASSWORD is shorter than ${MIN_ADMIN_PASSWORD_LENGTH} characters — use a longer passphrase`,
    );
  }
}

/** Passwords refused outright: the examples' old value and the obvious guesses. */
const KNOWN_EXAMPLE_PASSWORDS = ['changeme', 'change-me', 'password', 'admin', 'administrator', '12345678', '123456789', 'letmein'];

/**
 * A configuration problem, with a message fit to show whoever deployed the app. The Workers entries
 * show it on the error page (it names a setting, never a value) instead of a bare "unavailable".
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Advisory floor for ADMIN_PASSWORD. Warned about at boot, never enforced. */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;
