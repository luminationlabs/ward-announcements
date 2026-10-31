/**
 * Many wards on one deployment: the Workers entry for hosting.
 *
 * Deployed with `npm run host:deploy` (docs/DEPLOYMENT.md § 2b), and tested locally under
 * `wrangler dev` by `npm run test:host`. The single-ward `worker.ts` is a separate entry, unaffected.
 *
 * Three pieces:
 *
 * - **The front door** (this module's default export). Looks the hostname up in the registry,
 *   answers static files itself, and hands everything else to that ward's `WardDO`. Unknown
 *   hostnames get a 404 and wake nothing. Also the operator's API (`/__operator/…`, behind the
 *   platform password) and an hourly cron that pokes every ward.
 * - **`RegistryDO`**, one object: which wards exist and which hostname each answers on. A ward's
 *   Durable Object is named by its **id**, never its hostname, so a ward can change address
 *   without losing anything.
 * - **`WardDO`**, one per ward: the ordinary Hono app against the ward's own SQLite database
 *   (`driver-d1.ts`'s sibling, `driver-do.ts`), inside a `Tenant` of its own (`tenant.ts`). Its
 *   scheduled work runs from its own **alarm** rather than a per-minute cron — see `reschedule`.
 *
 * Durable Objects of one class can share an isolate, so this module switches the isolate to
 * multi-ward mode first: code that runs outside a ward then throws instead of reading one.
 *
 * The platform password is the `ADMIN_PASSWORD` var: the operator's API token, and the owner
 * sign-in on every ward's dashboard (each ward's owner cookie is keyed to that ward, so one ward's
 * cookie never opens another). Unset, there is no operator API and wards are run by their people.
 */
import { createHash } from 'node:crypto';
import { assertConfig, config, loadConfig, type Env as ConfigEnv } from './config.js';
import { createApp } from './app.js';
import { attachmentByKey, countSubscriptions, deleteSetting, dumpDatabase, getSendBatch, getSetting, getSettings, initDb, listAllAttachmentKeys, purgeExpiredAccessTokens, recentSends, restoreTarget, seedIfEmpty, sendQueueDepth, setAttachmentSize, setDriver, setSetting } from './db.js';
import { createDurableObjectDriver, type DurableStorageLike } from './driver-do.js';
import { isValidKey, withPrefix, type FileStore } from './filestore.js';
import { restoreWrites } from './restore.js';
import { sealBackupSettings } from './seal.js';
import type { SqlDriver } from './sqldriver.js';
import { checkImportedImage, importedTypeFor, prepareImport, RestoreError, type ImportReport } from './ward-import.js';
import { stripImageMetadata } from './image-meta.js';
import { VAPID_KEYS_SETTING } from './identity.js';
import { createR2FileStore, type R2BucketLike } from './filestore-r2.js';
import { createSqlFileStore } from './filestore-sql.js';
import { ensureAccessCode } from './access.js';
import { loadStoredIdentity } from './identity.js';
import { logger } from './log.js';
import { createOperatorActions, createOperatorApp, platformPassword, wardVars, type OperatorDeps, type WardRecord } from './operator.js';
import { invitePerson } from './passkeys.js';
import { initPush } from './push.js';
import { seedScheduleDefaults } from './schedule-core.js';
import { buildShell } from './shell.js';
import { Tenant, requireTenantContext, runInTenant } from './tenant.js';
import { MIN_GAP_MS, nextWake, runTick } from './tick.js';
import { currentWardSettings, loadWardSettings, saveWardSettings } from './ward-settings.js';
import { readShellSources, serveAsset, stringVars, type AssetsLike } from './worker-assets.js';

requireTenantContext();

// ---------------------------------------------------------------------------
// Bindings, structurally (see worker.ts on why there are no Workers types here)
// ---------------------------------------------------------------------------

interface StubLike {
  fetch(request: Request): Promise<Response>;
}
interface NamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): StubLike;
}

export interface HostEnv {
  WARD: NamespaceLike;
  REGISTRY: NamespaceLike;
  ASSETS: AssetsLike;
  /** Optional: images in R2, each ward under a prefix of its own. Without it, in each ward's SQLite. */
  IMAGES?: R2BucketLike & Partial<R2ListableLike>;
  [key: string]: unknown;
}

/** The listing half of an R2 bucket, for deleting a ward's whole prefix. */
interface R2ListableLike {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

/** A deleted ward's mark: one empty table, written after `deleteAll()`, cleared by provisioning. */
const TOMBSTONE = 'host_ward_deleted';
/** Set by the operator's suspend/resume, so the ward's own alarm knows. */
const SUSPENDED_SETTING = 'host_ward_suspended';

interface StateLike {
  id: { toString(): string };
  storage: DurableStorageLike & {
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void> | void;
    deleteAll(): Promise<void>;
    setAlarm(at: number): Promise<void> | void;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** Front door → object calls use paths a client can never reach (the front door refuses them). */
const INTERNAL = '/__ward/';
const internal = (path: string, body?: unknown) =>
  new Request(`https://ward.internal${INTERNAL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Which wards exist and where. One instance (`idFromName('registry')`); tiny, and read through a cache. */
export class RegistryDO {
  constructor(private readonly ctx: StateLike) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS wards (
      id         TEXT PRIMARY KEY,
      hostname   TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Host-wide values with nowhere else to live: a ward's `settings` belongs to that ward, and an
    // env var cannot be minted at runtime. One row so far, the operator session secret (`/secret`).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS host_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (url.pathname === '/lookup') {
      const [ward] = sql
        .exec<WardRecord>(`SELECT id, hostname, status FROM wards WHERE hostname = ?`, url.searchParams.get('host') ?? '')
        .toArray();
      return Response.json(ward ?? null);
    }
    if (url.pathname === '/list') {
      return Response.json(sql.exec<WardRecord>(`SELECT id, hostname, status FROM wards ORDER BY id`).toArray());
    }
    if (url.pathname === '/secret') {
      // The random half of the operator session key (`sessionKey` in operator.ts). Minted once,
      // insert-if-absent and read back, the way a ward mints `admin_people_secret`: the registry is
      // one object, so there is no race, but the shape is the same and costs nothing. Never
      // exported, never logged; it leaves this object only to the front door's operator app.
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
      sql.exec(`INSERT INTO host_settings (key, value) VALUES ('operator_session_secret', ?) ON CONFLICT(key) DO NOTHING`, hex);
      const [row] = sql.exec<{ value: string }>(`SELECT value FROM host_settings WHERE key = 'operator_session_secret'`).toArray();
      return Response.json({ value: row?.value ?? '' });
    }
    if (url.pathname === '/create' && request.method === 'POST') {
      const { id, hostname } = (await request.json()) as WardRecord;
      const taken = sql.exec(`SELECT 1 FROM wards WHERE id = ? OR hostname = ?`, id, hostname).toArray();
      if (taken.length) return Response.json({ error: 'That id or hostname is already registered.' }, { status: 409 });
      sql.exec(`INSERT INTO wards (id, hostname) VALUES (?, ?)`, id, hostname);
      return Response.json({ id, hostname, status: 'active' }, { status: 201 });
    }
    if (url.pathname === '/update' && request.method === 'POST') {
      const { id, status, hostname } = (await request.json()) as Partial<WardRecord>;
      if (hostname && sql.exec(`SELECT 1 FROM wards WHERE hostname = ? AND id != ?`, hostname, id).toArray().length) {
        return Response.json({ error: 'That hostname is already registered.' }, { status: 409 });
      }
      if (status) sql.exec(`UPDATE wards SET status = ? WHERE id = ?`, status, id);
      if (hostname) sql.exec(`UPDATE wards SET hostname = ? WHERE id = ?`, hostname, id);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/delete' && request.method === 'POST') {
      const { id } = (await request.json()) as { id: string };
      sql.exec(`DELETE FROM wards WHERE id = ?`, id);
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }
}

const registry = (env: HostEnv) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

/**
 * Hostname → ward, cached per isolate for a minute so an ordinary request costs no registry call.
 * Host-level, not ward data (it holds hostnames and ids), which is why it may live at module level —
 * see the reviewed list in test/tenant.test.js.
 */
const wardCache = new Map<string, { ward: WardRecord | null; at: number }>();
const WARD_CACHE_MS = 60_000;

async function lookupWard(env: HostEnv, host: string): Promise<WardRecord | null> {
  const hit = wardCache.get(host);
  if (hit && Date.now() - hit.at < WARD_CACHE_MS) return hit.ward;
  let ward: WardRecord | null;
  try {
    const res = await registry(env).fetch(new Request(`https://registry.internal/lookup?host=${encodeURIComponent(host)}`));
    if (!res.ok) throw new Error(`the registry answered ${res.status}`);
    ward = (await res.json()) as WardRecord | null;
  } catch (err) {
    // One registry serves every ward, so a moment when it is overloaded (a spray of made-up
    // hostnames, each one a lookup) must not take down a ward this isolate already knows: answer
    // from the expired entry and ask again next time. With nothing to fall back on, the caller says
    // so with a 503 rather than the runtime's bare 500.
    if (hit) return hit.ward;
    throw err;
  }
  // Re-inserted, not updated in place: a Map keeps a key where it was first set, so without the
  // delete a real ward refreshed every minute would stay at the front and be the first evicted.
  wardCache.delete(host);
  // Bounded: a spray of made-up hostnames on the wildcard route must not grow it forever — nor, by
  // clearing it, push every real ward's lookup back to the registry. Drop the oldest entries only.
  if (wardCache.size >= 1000) {
    for (const key of [...wardCache.keys()].slice(0, 100)) wardCache.delete(key);
  }
  wardCache.set(host, { ward, at: Date.now() });
  return ward;
}

const wardStub = (env: HostEnv, id: string) => env.WARD.get(env.WARD.idFromName(id));

// ---------------------------------------------------------------------------
// One ward
// ---------------------------------------------------------------------------

type App = ReturnType<typeof createApp>;

/** Where this ward lives, stored in its own database when it is provisioned. */
const IDENTITY_SETTING = 'host_ward_identity';

/**
 * One ward: its database, its state, its app, its alarm. Cloudflare runs at most one instance of a
 * given ward anywhere at a time, so two requests for the same ward never race across machines the
 * way two Workers isolates against one D1 database can.
 */
export class WardDO {
  /** Replaced (with empty per-ward caches) when the ward is deleted, so nothing outlives its data. */
  private tenant: Tenant;
  private app: App | null = null;
  private files: FileStore | null = null;
  /** The ward was deleted (see `TOMBSTONE`): answer nothing, wake for nothing, until re-provisioned. */
  private deleted = false;
  /** Suspended by the operator: it answers its own channel, but its alarm sends nothing. */
  private suspended = false;
  /** An import committed but the reboot after it failed: the next request boots again. */
  private restartAfterImport = false;

  constructor(
    private readonly ctx: StateLike,
    private readonly env: HostEnv,
  ) {
    this.tenant = new Tenant(ctx.id.toString());
    // Boot (schema migrations included) before any request or alarm is let in. If it throws, the
    // runtime resets the object and the next event tries again from the constructor. A deleted
    // ward does not boot at all: booting would mint a fresh database and an alarm for a ward that
    // no longer exists.
    void ctx.blockConcurrencyWhile(async () => {
      this.deleted = this.hasTombstone();
      if (!this.deleted) await this.inWard(() => this.boot());
    });
  }

  private inWard<T>(fn: () => Promise<T>): Promise<T> {
    return runInTenant(this.tenant, fn);
  }

  private hasTombstone(): boolean {
    return (
      this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${TOMBSTONE}'`).toArray()
        .length > 0
    );
  }

  /**
   * Bring the ward up in the current tenant. `restore`, when given, writes a backup's rows first,
   * inside the same transaction as the migrations and seeding below — so an import that fails at
   * any step, the backup's own migration included, leaves the database exactly as it was.
   * `progress.committed` says whether that transaction landed, for the caller to tell a rolled-back
   * import from one that only failed to restart.
   */
  private async boot(restore?: (driver: SqlDriver) => Promise<void>, progress?: { committed: boolean }): Promise<void> {
    const cfg = loadConfig(this.wardVars());
    // A hosted ward has **no owner sign-in** unless `WARD_OWNER_SIGNIN=on`: its sign-in page would
    // otherwise offer the platform password to anyone, on every ward, and "Owner" reads to a clerk
    // as if it meant them. The operator gets into a ward the honest way instead — an admin invite for
    // themselves from the operator page, which then shows in that ward's People list. The test
    // suites turn it on (they sign in as the owner); then the platform password is the owner's, when
    // it is strong enough to be (see `platformPassword`).
    cfg.adminPassword = this.env.WARD_OWNER_SIGNIN === 'on' ? platformPassword(this.env) : '';
    // Its cookie key must name the ward, or ward A's owner cookie would open ward B
    // (test/host/isolation.test.js).
    cfg.sessionSecret = createHash('sha256')
      .update(`pushannounce-session::${cfg.adminPassword}::ward::${this.tenant.id}`)
      .digest('hex');
    assertConfig(cfg, { requireOwner: false });
    // Schema migrations and first-run seeding as **one transaction**: a step that fails part-way
    // leaves the ward as it was (the rollback itself is demonstrated by the probe object in
    // test/host/do-driver.test.js), the boot throws, the object resets, and every request gets an
    // error until the cause is fixed — never a half-migrated ward.
    await this.ctx.storage.transaction(async () => {
      const driver = createDurableObjectDriver(this.ctx.storage);
      if (restore) {
        setDriver(driver);
        await restore(driver);
      }
      await initDb(driver); // after a restore: migrates the backup's rows from its schema version
      await seedIfEmpty();
      await ensureAccessCode();
      await seedScheduleDefaults();
      await purgeExpiredAccessTokens();
      await loadStoredIdentity(); // may store a newly generated VAPID pair
    });
    if (progress) progress.committed = true;
    await this.applyIdentity();
    await loadWardSettings();
    this.suspended = (await getSetting(SUSPENDED_SETTING)) === '1';
    initPush();
    // Images: under this ward's own prefix in the shared bucket, or in its own database.
    this.files = this.env.IMAGES
      ? withPrefix(createR2FileStore(this.env.IMAGES), this.imagePrefix())
      : createSqlFileStore();
    const shell = await readShellSources(this.env.ASSETS);
    await buildShell(shell); // fail the boot, not every page load, on a broken index.html or sw.js
    this.app = createApp({
      shell,
      log: logger,
      assets: (c) => serveAsset(this.env.ASSETS, c.req.raw),
      files: this.files,
      // The whole send inside the request: a hosted deployment is on Workers Paid (30 s of CPU per
      // request), and anything left waiting on a retry is picked up by the alarm.
      drainSends: 'inline',
    });
  }

  /**
   * The host's vars as this ward sees them: without `PUBLIC_ORIGIN` and the VAPID pair, which are
   * one deployment's and never a host's (`wardVars` in operator.ts says why). Said in the log on
   * every boot they are found set — a boot is rare, and the operator cannot see a thrown one —
   * rather than refused: a host must not stop serving every ward over a var that is merely ignored.
   */
  private wardVars(): ConfigEnv {
    const { vars, ignored } = wardVars(stringVars(this.env));
    if (ignored.length) {
      logger.warn({ ignored }, 'host-wide vars ignored: each ward has an address and push keys of its own');
    }
    return vars;
  }

  private imagePrefix(): string {
    return `${this.ctx.id.toString()}/`;
  }

  /**
   * The ward's public address. In production it is simply `https://<hostname>` — a host-wide
   * `PUBLIC_ORIGIN` is never let through (`wardVars`). In development (`wrangler dev`, where every
   * ward is on `127.0.0.1:<port>`) there is no address to derive, so a `PUBLIC_ORIGIN` var, which
   * test/roles.test.js sets, or failing that the dashboard-learned origin, still apply.
   */
  private async applyIdentity(): Promise<void> {
    const raw = await getSetting(IDENTITY_SETTING);
    if (!raw) return;
    const { id, hostname } = JSON.parse(raw) as { id?: string; hostname: string };
    // Every log line from here on names the ward (log.ts).
    this.tenant.label = { ward: id, host: hostname };
    if (!config.publicOrigin && config.isProduction) config.publicOrigin = `https://${hostname}`;
  }

  /**
   * Set the alarm to the next moment there is anything to do (`nextWake`). Derived from the
   * database every time, never stored, so nothing can leave it stale; and never allowed to fail
   * quietly — if working it out throws, try again in a minute rather than not at all.
   *
   * One exception to "derived": when the answer is only the `MIN_GAP_MS` floor (something is due
   * now) and an alarm is already set sooner, keep that one. Otherwise steady traffic — a write
   * every few seconds as members subscribe on Sunday morning — would keep pushing the floor ahead
   * of itself and the due work would wait for a quiet moment. An alarm that turns out to be early
   * costs one idempotent tick.
   */
  private async reschedule(): Promise<number | null> {
    if (this.deleted || this.suspended) {
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    const now = Date.now();
    let at: number;
    try {
      at = (await nextWake(new Date(now))).getTime();
    } catch (err) {
      logger.error(err, 'could not work out the next alarm; retrying in a minute');
      at = now + 60_000;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current > now && current < at && at <= now + MIN_GAP_MS) return current;
    if (current !== at) await this.ctx.storage.setAlarm(at);
    return at;
  }

  /** The scheduled work. Never throws: a failure is logged, and the alarm is always set again. */
  async alarm(): Promise<void> {
    if (this.deleted) {
      // The one alarm a delete leaves (see `destroy` in `internal`): sweep the ward's images once
      // more, for an upload that was already on its way to R2 when the delete ran, then stop.
      if (this.env.IMAGES?.list) await deletePrefix(this.env.IMAGES as R2ListableLike, this.imagePrefix());
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (!this.app && this.restartAfterImport) {
      // An import landed but the ward did not come back up (see `importBackup`). A request retries
      // this too (`fetch`), but a ward nobody visits would otherwise wait for one — or for the
      // hourly poke — with its Sunday notification due.
      this.restartAfterImport = false;
      await this.ctx.blockConcurrencyWhile(() => this.inWard(() => this.boot()));
    }
    // A suspended ward sends nothing; `reschedule` clears its alarm.
    if (this.suspended || !this.app) {
      if (!this.suspended) await this.inWard(async () => logger.warn('ward alarm before boot; retrying in a minute'));
      if (this.suspended) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    await this.inWard(async () => {
      try {
        await runTick(new Date(), this.files, logger, 'all');
      } catch (err) {
        logger.error(err, 'ward alarm failed');
      }
      await this.reschedule();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.startsWith(INTERNAL) ? url.pathname.slice(INTERNAL.length) : null;
    // Before every guard below: a delete must get through to a ward already deleted (it answers
    // `ok` again) and to one that did not boot, or a delete that failed half-way could never be
    // finished — see `destroy`.
    if (action === 'destroy') return this.destroy();
    if (this.deleted && action !== 'provision') {
      // Reached only through a stale front-door cache or a race with the delete: there is no ward.
      return new Response('There is no ward at this address.\n', { status: 404 });
    }
    if (this.suspended && action === null) {
      // The front door refuses a suspended ward too, but from a cache each isolate keeps for a
      // minute: without this, every other isolate would go on serving the ward until its entry ran
      // out. The operator's own calls (`action`) still reach it, so it can be resumed or exported.
      return new Response('This ward is not available right now.\n', { status: 503 });
    }
    if (this.deleted && action === 'provision') {
      // The same id, created again: start from nothing.
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${TOMBSTONE}`);
      this.deleted = false;
      this.tenant = new Tenant(this.ctx.id.toString());
      await this.ctx.blockConcurrencyWhile(() => this.inWard(() => this.boot()));
    }
    if (!this.app && !this.deleted && this.restartAfterImport) {
      // An import landed but the ward did not come back up (see `importBackup`): try again now.
      this.restartAfterImport = false;
      await this.ctx.blockConcurrencyWhile(() => this.inWard(() => this.boot()));
    }
    const app = this.app;
    if (!app) return new Response('This ward is starting up. Please try again.\n', { status: 503 });
    if (action === 'import') return this.importBackup(request);
    if (action !== null) return this.inWard(() => this.internal(request, action));
    return this.inWard(async () => {
      const res = await app.fetch(request);
      // Any write may have moved the next thing to do — a schedule saved, a Sunday skipped, a send
      // queued — so re-derive the alarm after every one. Reads only check one is set at all: the
      // safety net for an alarm lost some other way. Both are local SQLite reads, not round trips.
      // By now the ward's answer exists and any write in it has committed: an alarm that cannot be
      // set is logged (the next request or the hourly poke sets it again), never turned into an
      // error for a save that succeeded.
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') await this.reschedule();
        else if (!this.suspended && (await this.ctx.storage.getAlarm()) === null) await this.reschedule();
      } catch (err) {
        logger.error(err, 'could not set the ward alarm after a request');
      }
      return res;
    });
  }

  /**
   * Import Backup (operator.ts, ward-import.ts): replace everything in this ward with a backup.
   *
   * The ward is rebooted into a **fresh tenant** on the restored database rather than having its
   * caches patched one by one: the config (push keys, address), the ward settings, the member-cookie
   * and people secrets, the drain lock — every `tenantLocal()` slot starts empty, so nothing read
   * from the old rows can outlive them, including a slot added after this was written. The restore
   * runs inside that boot's transaction, ahead of the migrations, so a backup from an older schema
   * is migrated in the same all-or-nothing step; on any failure before the commit the old tenant,
   * app and database are exactly as they were. Nothing else runs meanwhile (blockConcurrencyWhile).
   */
  private async importBackup(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { backup?: unknown; options?: Record<string, unknown> };
    return this.ctx.blockConcurrencyWhile(async (): Promise<Response> => {
      const before = await this.inWard(async () => ({
        hostname: await this.identityHostname(),
        settings: await getSettings([IDENTITY_SETTING, SUSPENDED_SETTING, VAPID_KEYS_SETTING, 'ward_settings']),
        keys: await listAllAttachmentKeys(),
        production: config.isProduction,
        sealKey: config.backupSealKey,
      }));
      let prepared: Awaited<ReturnType<typeof prepareImport>>;
      try {
        prepared = await prepareImport(
          body.backup,
          body.options ?? {},
          {
            hostname: before.hostname,
            hostSettings: Object.fromEntries(
              [IDENTITY_SETTING, SUSPENDED_SETTING]
                .filter((key) => before.settings.has(key))
                .map((key) => [key, before.settings.get(key) ?? null]),
            ),
            vapidKeys: before.settings.get(VAPID_KEYS_SETTING) ?? null,
            wardSettings: before.settings.get('ward_settings') ?? null,
            production: before.production,
            sealKey: before.sealKey,
          },
          restoreTarget(),
        );
      } catch (err) {
        if (err instanceof RestoreError) return Response.json({ error: err.message }, { status: 400 });
        throw err;
      }
      const writes = restoreWrites(prepared.plan);

      const previous = { tenant: this.tenant, app: this.app, files: this.files, suspended: this.suspended };
      const progress = { committed: false };
      this.tenant = new Tenant(this.ctx.id.toString());
      this.app = null;
      this.files = null;
      try {
        await this.inWard(() => this.boot((driver) => driver.batch(writes), progress));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!progress.committed) {
          this.tenant = previous.tenant;
          this.app = previous.app;
          this.files = previous.files;
          this.suspended = previous.suspended;
          logger.warn({ err: message }, 'import rolled back; the ward is unchanged');
          return Response.json({ error: `The backup could not be imported, and nothing was changed: ${message}` }, { status: 400 });
        }
        logger.error(err, 'import committed, but the ward did not restart');
        this.restartAfterImport = true;
        return Response.json({ error: `The backup was imported, but the ward did not restart: ${message}` }, { status: 500 });
      }

      return this.inWard(async () => {
        // The old ward's images that the new one does not name: unreachable now, so tidy them away
        // (best effort — an orphaned object is invisible). Kept when the backup names them too, so
        // importing the same backup twice does not throw away images already restored.
        const keep = new Set(prepared.report.images.keys);
        for (const key of before.keys) {
          if (keep.has(key)) continue;
          await this.files?.delete(key).catch((err: unknown) => logger.warn({ err: String(err), key }, 'could not delete an old image'));
        }
        const alarm = await this.reschedule();
        logger.info({ tables: prepared.report.tables.length, from: prepared.report.fromVersion }, 'imported a backup');
        return Response.json({ ...prepared.report, alarm } satisfies ImportReport & { alarm: number | null });
      });
    });
  }

  /** Store a batch of a backup's images (base64), each checked against the restored rows. */
  private async storeImages(list: unknown): Promise<Response> {
    const results: { key: string; status: 'restored' | 'skipped' | 'failed'; error?: string }[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const { key: rawKey, data } = (item ?? {}) as { key?: unknown; data?: unknown };
      const key = typeof rawKey === 'string' ? rawKey : '';
      try {
        const bytes = typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'base64')) : new Uint8Array();
        const row = key ? await attachmentByKey(key) : undefined;
        const problem = checkImportedImage(key, bytes, row);
        if (problem) {
          results.push({ key, status: 'failed', error: problem });
          continue;
        }
        // Already there (an import run again, or retried): nothing to do.
        const existing = await this.files!.get(key);
        if (existing) {
          if (!(existing.body instanceof Uint8Array)) await existing.body.cancel();
          results.push({ key, status: 'skipped' });
          continue;
        }
        // A backup made before the app stripped metadata still carries it: strip on the way in, as
        // an upload does, and let the row's size follow the bytes (the quota sums it).
        const type = importedTypeFor(key, row!);
        const stripped = stripImageMetadata(bytes, type);
        await this.files!.put(key, stripped, type);
        if (stripped.byteLength !== bytes.byteLength) await setAttachmentSize(key, stripped.byteLength);
        results.push({ key, status: 'restored' });
      } catch (err) {
        logger.error(err, 'could not store an imported image');
        results.push({ key, status: 'failed', error: 'could not be stored' });
      }
    }
    return Response.json({ results });
  }

  private identityHostname = async (): Promise<string> => {
    const identity = JSON.parse((await getSetting(IDENTITY_SETTING)) ?? '{}') as { hostname?: string };
    if (!identity.hostname) throw new Error('this ward has no address yet (was it provisioned?)');
    return identity.hostname;
  };

  /** The front door's own calls (provisioning, the hourly poke, the operator's tools). */
  private async internal(request: Request, action: string): Promise<Response> {
    const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
    if (action === 'provision') {
      await setSetting(IDENTITY_SETTING, JSON.stringify({ id: body.id, hostname: body.hostname }));
      await this.applyIdentity();
      // What the operator filled in on "Add a ward" (checked in operator.ts); the ward can change any
      // of it later on its own Ward settings card.
      const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      const name = text(body.name);
      const shortName = text(body.shortName) || name.slice(0, 12);
      const timezone = text(body.timezone);
      if (name || shortName || timezone) {
        const current = currentWardSettings();
        await saveWardSettings({
          ...current,
          appName: name || current.appName,
          appShortName: shortName || current.appShortName,
          timezone: timezone || current.timezone,
        });
      }
      let invite: string | null = null;
      if (typeof body.admin === 'string' && body.admin.trim()) {
        const { path } = await invitePerson({ name: body.admin.trim(), role: 'admin' });
        invite = `https://${body.hostname as string}${path}`;
      }
      return Response.json({ invite, alarm: await this.reschedule() });
    }
    if (action === 'poke') {
      // Waking is the point: the constructor has just run any pending migrations.
      const alarm = this.suspended ? null : ((await this.ctx.storage.getAlarm()) ?? (await this.reschedule()));
      return Response.json({ alarm, schemaVersion: await getSetting('schema_version') });
    }
    if (action === 'status') {
      this.suspended = body.suspended === true;
      await setSetting(SUSPENDED_SETTING, this.suspended ? '1' : '0');
      return Response.json({ alarm: await this.reschedule() });
    }
    if (action === 'move') {
      // New address. Passkeys belong to the old one, so people need new invites — the operator
      // page says so. A learned origin would pin the old address, so it is forgotten too (but a
      // `PUBLIC_ORIGIN` var, in development where it is let through, still stands). With nothing
      // else let in meanwhile, as import does: a request mid-way would see the old origin with the
      // new identity.
      return this.ctx.blockConcurrencyWhile(async () => {
        const identity = JSON.parse((await getSetting(IDENTITY_SETTING)) ?? '{}') as Record<string, unknown>;
        await setSetting(IDENTITY_SETTING, JSON.stringify({ ...identity, hostname: body.hostname }));
        await deleteSetting('public_origin');
        config.publicOrigin = (wardVars(stringVars(this.env)).vars.PUBLIC_ORIGIN ?? '').replace(/\/$/, '');
        await this.applyIdentity();
        return Response.json({ ok: true });
      });
    }
    if (action === 'invite') {
      const hostname = await this.identityHostname();
      const { path } = await invitePerson({ name: String(body.admin), role: 'admin' });
      return Response.json({ invite: `https://${hostname}${path}` });
    }
    if (action === 'images') return this.storeImages(body.images);
    if (action === 'image') {
      // One stored image, for the operator's Export (a full backup made from the operator page): read
      // through this ward's own store — its R2 prefix, or its `file_chunks` — as `/images/:key` is.
      // The key is checked before the store sees it, for the same reason that route checks it.
      const key = typeof body.key === 'string' ? body.key : '';
      const file = isValidKey(key) ? await this.files?.get(key) : undefined;
      if (!file) return new Response('Not found', { status: 404 });
      // Exactly this view's bytes: a Uint8Array's buffer may be a slice of a larger allocation.
      const bytes =
        file.body instanceof Uint8Array
          ? (file.body.buffer.slice(file.body.byteOffset, file.body.byteOffset + file.body.byteLength) as ArrayBuffer)
          : file.body;
      return new Response(bytes, { headers: { 'content-type': file.contentType } });
    }
    if (action === 'export') {
      // The same shape as the dashboard's own backup download (/admin/backup.json), and the push
      // keys sealed the same way under the host's BACKUP_SEAL_KEY (seal.ts) — so an export imported
      // back into this host keeps every subscription, and an export file alone sends nothing. With
      // no seal key the pair goes in the clear: operator-only, as documented, and the one way to
      // carry a ward's keys off the host.
      const tables = await dumpDatabase();
      if (Array.isArray(tables.settings) && config.backupSealKey) {
        tables.settings = await sealBackupSettings(tables.settings as { key?: unknown; value?: unknown }[], config.backupSealKey);
      }
      return Response.json({ app: config.appName, exported_at: new Date().toISOString(), tables });
    }
    if (action === 'tick') {
      // The operator's (and the tests') way to run the scheduled work as of a chosen moment.
      const now = typeof body.now === 'string' ? new Date(body.now) : new Date();
      await runTick(now, this.files, logger, 'all');
      const next = (await nextWake(now)).getTime();
      return Response.json({ nextWake: new Date(next).toISOString(), alarm: await this.reschedule() });
    }
    if (action === 'wake') {
      // Run the ward's alarm as soon as possible — the real handler, not a stand-in.
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ alarm: await this.ctx.storage.getAlarm() });
    }
    if (action === 'state') {
      return Response.json({
        alarm: await this.ctx.storage.getAlarm(),
        suspended: this.suspended,
        queue: await sendQueueDepth(),
        // Each recent send with its delivery totals (sent, failed, removed of total).
        sends: await Promise.all(
          (await recentSends(10)).map(async (send) => ({ ...send, batch: (await getSendBatch(send.id)) ?? null })),
        ),
        subscribers: await countSubscriptions(),
        schemaVersion: await getSetting('schema_version'),
      });
    }
    return new Response('Not found', { status: 404 });
  }

  /**
   * The operator's delete (`remove` in operator.ts). Images first — in R2 everything under the
   * ward's prefix, so an object whose row was never written goes too; in the database they are
   * `file_chunks` rows and go with everything else — then every row and the alarm, then a tombstone
   * so nothing (a stale cache, the hourly poke, a late request) can boot the ward back into
   * existence.
   *
   * **Idempotent, and needing no booted app**: only this object's storage and the bucket prefix,
   * never the tenant, the database driver or `this.files`. The operator removes the registry row
   * only after this answers, so a delete that fails between the two is tried again — and that retry
   * reaches a ward already tombstoned, which must say `ok` again rather than 404 (as it once did:
   * the id and hostname then stayed reserved for ever), and may reach one whose boot after an import
   * failed (`restartAfterImport`), which `fetch` must not try to boot first. A ward whose
   * constructor boot throws never reaches `fetch` at all — the runtime fails the request and resets
   * the object — so that one needs its cause fixed first; nothing here can help it.
   *
   * With nothing else let in meanwhile, as import does, so no request or alarm interleaves with
   * it. That cannot recall an image upload a request had already sent to R2 before the delete
   * began, so one alarm a minute on (see `alarm`) sweeps the ward's prefix again.
   */
  private destroy(): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.deleted) return Response.json({ ok: true, already: true });
      if (this.env.IMAGES?.list) await deletePrefix(this.env.IMAGES as R2ListableLike, this.imagePrefix());
      await this.ctx.storage.deleteAll();
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${TOMBSTONE} (deleted_at TEXT)`);
      // After `deleteAll`, which on newer compatibility dates clears the alarm too.
      if (this.env.IMAGES?.list) await this.ctx.storage.setAlarm(Date.now() + 60_000);
      else await this.ctx.storage.deleteAlarm();
      this.deleted = true;
      this.suspended = false;
      this.restartAfterImport = false;
      this.app = null;
      this.files = null;
      this.tenant = new Tenant(this.ctx.id.toString());
      return Response.json({ ok: true });
    });
  }
}

/** Delete every object under `prefix` in the bucket, a page at a time. */
async function deletePrefix(bucket: R2ListableLike, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// ---------------------------------------------------------------------------
// The front door
// ---------------------------------------------------------------------------

/**
 * Files the front door answers itself, without waking a ward: exactly the shipped, ungated assets
 * that no app route shadows. (Everything else, gated or not, goes to the ward.)
 */
function isStaticAsset(path: string): boolean {
  return (
    ['/app.js', '/install.js', '/preview-pdf.js', '/zip.js', '/backup-zip.js', '/styles.css'].includes(path) ||
    ['/icons/', '/img/', '/vendor/', '/apple-touch-icon'].some((prefix) => path.startsWith(prefix))
  );
}

/** The headers the app adds to every response (its security middleware), for files served here. */
function withAppHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('X-Robots-Tag', 'noindex');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  return out;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const plain = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** What the operator's tools (operator.ts) need from the host: the registry and each ward's channel. */
function operatorDeps(env: HostEnv): OperatorDeps {
  const reg = (path: string, body?: unknown) =>
    registry(env).fetch(
      new Request(`https://registry.internal${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    );
  return {
    password: platformPassword(env),
    operatorHost: typeof env.OPERATOR_HOST === 'string' ? env.OPERATOR_HOST.trim().toLowerCase() : '',
    defaultTimezone: typeof env.TZ === 'string' && env.TZ ? env.TZ : 'America/Denver',
    wardDomain: typeof env.WARD_DOMAIN === 'string' ? env.WARD_DOMAIN.trim().toLowerCase().replace(/^\.+/, '') : '',
    secure: env.NODE_ENV === 'production',
    async sessionSecret() {
      const res = await reg('/secret');
      if (!res.ok) throw new Error(`the registry answered ${res.status} for the session secret`);
      const { value } = (await res.json()) as { value?: string };
      if (!value) throw new Error('the registry holds no operator session secret');
      return value;
    },
    registry: {
      list: async () => (await (await reg('/list')).json()) as WardRecord[],
      async create(ward) {
        const res = await reg('/create', ward);
        return res.status === 201 ? { ok: true } : { ok: false, error: ((await res.json()) as { error?: string }).error };
      },
      async update(id, patch) {
        const res = await reg('/update', { id, ...patch });
        return res.ok ? { ok: true } : { ok: false, error: ((await res.json()) as { error?: string }).error };
      },
      async remove(id) {
        await reg('/delete', { id });
      },
    },
    ward: (id, action, body) => wardStub(env, id).fetch(internal(action, body)),
    forget: (hostname) => wardCache.delete(hostname),
    async asset(path) {
      const res = await serveAsset(env.ASSETS, new Request(`https://assets.internal${path}`));
      return res ? new Response(res.body, res) : undefined; // a copy, so the operator app may add headers
    },
  };
}

/**
 * The operator app, one per isolate: its login rate limiter keeps its count in the app's closure,
 * so building a new app per request would reset it every time. Host-level, holds no ward data.
 * Its deps are kept with it: the front door reads `operatorHost` on every request, and building
 * them again each time would log a too-short password's error on every request to every ward.
 */
let operatorApp: { deps: OperatorDeps; app: ReturnType<typeof createOperatorApp> } | null = null;
function operatorFor(env: HostEnv) {
  if (!operatorApp) {
    const deps = operatorDeps(env);
    operatorApp = { deps, app: createOperatorApp(deps) };
  }
  return operatorApp;
}

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // Answered before anything else is touched: "is the deployment up at all".
    if (path === '/healthz') return json({ ok: true });
    // The operator's API on any hostname, and their page on OPERATOR_HOST (see operator.ts).
    if (path.startsWith('/__operator/')) return operatorFor(env).app.fetch(request);
    const host = url.hostname.toLowerCase();
    if (host && host === operatorFor(env).deps.operatorHost) return operatorFor(env).app.fetch(request);
    // The front door's private channel to a ward; never reachable from outside.
    if (path.startsWith(INTERNAL)) return plain('Not found', 404);

    let ward: WardRecord | null;
    try {
      ward = await lookupWard(env, host);
    } catch (err) {
      logger.error(err, 'ward lookup failed');
      return plain('This ward is not available right now. Please try again in a moment.\n', 503);
    }
    if (!ward) return plain('There is no ward at this address.\n', 404);
    if (ward.status !== 'active') return plain('This ward is not available right now.\n', 503);

    if ((request.method === 'GET' || request.method === 'HEAD') && isStaticAsset(path)) {
      const asset = await serveAsset(env.ASSETS, request);
      if (asset) return withAppHeaders(asset);
    }
    return wardStub(env, ward.id).fetch(request);
  },

  async scheduled(_controller: unknown, env: HostEnv): Promise<void> {
    try {
      const results = await createOperatorActions(operatorFor(env).deps).pokeAll();
      const failed = results.filter((r) => !r.ok).map((r) => r.id);
      if (failed.length) logger.error({ failed }, 'hourly poke: some wards did not answer');
    } catch (err) {
      logger.error(err, 'hourly poke failed');
    }
  },
};
