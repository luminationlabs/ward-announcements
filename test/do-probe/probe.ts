/**
 * A test-only Durable Object that runs the parts of `driver-do.ts` the HTTP suites cannot reach,
 * against the real SQLite of a real (local, `wrangler dev`) Durable Object. Driven by
 * `test/host/do-driver.test.js`; never deployed.
 *
 * Each route runs in a Durable Object of its own (named by the path), so the checks start from
 * empty databases and cannot see each other.
 *
 * - `/batch`  — a batch whose last statement fails leaves nothing behind (the all-or-nothing
 *               `transactionSync` promise), and `changes`/`lastRowId` are right.
 * - `/claim`  — the send queue's lease: a claim takes rows, a second claim finds none.
 * - `/send`   — a whole send through the real queue, encryption and drain, against a stubbed push
 *               service: deliveries land, a 500 is parked behind its backoff, and a later drain
 *               finishes it. The same story `test/push-queue.test.js` tells on better-sqlite3.
 * - `/alarm`  — is `setAlarm` rolled back with the transaction
 *               it was called in? Reported, not asserted — the alarm design does not depend on it.
 */
import { loadConfig } from '../../src/config.js';
import * as db from '../../src/db.js';
import { createDurableObjectDriver, type DurableStorageLike } from '../../src/driver-do.js';
import { drainSendQueueUntilEmpty, initPush, queueSend, sendToAll, setPushLogger } from '../../src/push.js';

interface ProbeState {
  storage: DurableStorageLike & {
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    setAlarm(at: number): void | Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void | Promise<void>;
  };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapid() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: b64url(raw), VAPID_PRIVATE_KEY: jwk.d! };
}

async function subscribe(endpoint: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  await db.upsertSubscription({
    endpoint,
    p256dh: b64url(raw),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
    user_agent: 'probe',
  });
}

const OK = 'https://push.example.test/ok';
const BROKEN = 'https://push.example.test/broken';

export class ProbeDO {
  constructor(private readonly ctx: ProbeState) {}

  private async boot() {
    loadConfig({
      ADMIN_PASSWORD: 'probe-password',
      APP_NAME: 'Probe Ward',
      APP_SHORT_NAME: 'Probe',
      APP_DESCRIPTION: 'Probe',
      VAPID_SUBJECT: 'mailto:probe@example.org',
      NODE_ENV: 'development',
      TZ: 'America/Denver',
      ...(await vapid()),
    });
    initPush();
    await db.initDb(createDurableObjectDriver(this.ctx.storage));
  }

  private raw<T>(query: string): T[] {
    return this.ctx.storage.sql.exec<T>(query).toArray();
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/migrate-rollback') return Response.json(await this.migrateRollback());
    await this.boot();
    const result =
      path === '/batch'
        ? await this.batch()
        : path === '/claim'
          ? await this.claim()
          : path === '/send'
            ? await this.send()
            : path === '/alarm'
              ? await this.alarm()
              : path === '/async-txn'
                ? await this.asyncTransaction()
                : { error: 'unknown probe' };
    return Response.json(result);
  }

  private async batch() {
    const driver = createDurableObjectDriver(this.ctx.storage);
    let threw = false;
    try {
      await driver.batch([
        { sql: `INSERT INTO settings (key, value) VALUES ('probe_a', 'one')` },
        { sql: `INSERT INTO no_such_table (x) VALUES (1)` },
      ]);
    } catch {
      threw = true;
    }
    const leaked = await db.getSetting('probe_a');
    const first = await driver.run(`INSERT INTO settings (key, value) VALUES ('probe_b', 'x')`);
    const second = await driver.run(`INSERT INTO settings (key, value) VALUES ('probe_c', 'x')`);
    const updated = await driver.run(`UPDATE settings SET value = 'y' WHERE key IN ('probe_b', 'probe_c')`);
    const none = await driver.run(`UPDATE settings SET value = 'z' WHERE key = 'no-such-key'`);
    return {
      threw,
      leaked,
      rowIdsIncrease: second.lastRowId > first.lastRowId && first.lastRowId > 0,
      updatedChanges: updated.changes,
      noopChanges: none.changes,
    };
  }

  private async claim() {
    for (let i = 0; i < 3; i++) await subscribe(`${OK}/${i}`);
    const queued = await queueSend({ title: 'Claim', body: 'b', url: '/' }, { type: 'manual' });
    const first = await db.claimSendChunk(10);
    const second = await db.claimSendChunk(10);
    return { queued: queued?.total ?? 0, firstClaim: first.length, secondClaim: second.length };
  }

  private async send() {
    setPushLogger({ debug() {}, info() {}, warn() {}, error() {} });
    let brokenHealed = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const ok = url.startsWith(OK) || (url === BROKEN && brokenHealed);
      return new Response(ok ? null : 'nope', { status: ok ? 201 : 500 });
    }) as typeof fetch;

    for (let i = 0; i < 3; i++) await subscribe(`${OK}/${i}`);
    await subscribe(BROKEN);
    const firstPass = await sendToAll({ title: 'Probe', body: 'b', url: '/' }, { type: 'manual' });
    const parked = this.raw<{ attempts: number; not_before: string | null }>(
      `SELECT attempts, not_before FROM send_queue`,
    );

    // The backoff, compressed: wind it to "now", let the push service recover, drain again.
    this.raw(`UPDATE send_queue SET not_before = NULL`);
    brokenHealed = true;
    await drainSendQueueUntilEmpty();
    const [log] = this.raw<{ id: number }>(`SELECT id FROM send_log ORDER BY id DESC LIMIT 1`);
    const batch = await db.getSendBatch(log!.id);
    return {
      firstPass,
      parked,
      final: { total: batch?.total, sent: batch?.sent, failed: batch?.failed, queue: await db.sendQueueDepth() },
    };
  }

  /** Can async work (like `initDb`, which awaits each statement) be made all-or-nothing? */
  private async asyncTransaction() {
    const driver = createDurableObjectDriver(this.ctx.storage);
    let threw = false;
    let error = '';
    try {
      await this.ctx.storage.transaction(async () => {
        await driver.run(`INSERT INTO settings (key, value) VALUES ('async_a', 'one')`);
        await Promise.resolve();
        await driver.run(`INSERT INTO no_such_table (x) VALUES (1)`);
      });
    } catch (err) {
      threw = true;
      error = String(err);
    }
    return { threw, error, leaked: await db.getSetting('async_a') };
  }

  /**
   * A schema migration that fails part-way, on a fresh database, the way `host.ts` runs one: the
   * whole of `initDb` inside `storage.transaction()`. Nothing it created may survive.
   */
  private async migrateRollback() {
    loadConfig({ ADMIN_PASSWORD: 'p', APP_NAME: 'P', APP_SHORT_NAME: 'P', APP_DESCRIPTION: 'P' });
    const tables = () =>
      this.raw<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'`).map((t) => t.name);
    const before = tables();
    let threw = false;
    try {
      await this.ctx.storage.transaction(async () => {
        await db.initDb(createDurableObjectDriver(this.ctx.storage));
        throw new Error('a migration step failed');
      });
    } catch {
      threw = true;
    }
    const after = tables();
    // And a clean run afterwards still works.
    await this.ctx.storage.transaction(() => db.initDb(createDurableObjectDriver(this.ctx.storage)));
    return { threw, before, after, schemaVersion: await db.getSetting('schema_version') };
  }

  private async alarm() {
    await this.ctx.storage.deleteAlarm();
    const at = Date.now() + 60 * 60 * 1000;
    let threw = false;
    try {
      this.ctx.storage.transactionSync(() => {
        void this.ctx.storage.setAlarm(at);
        throw new Error('roll back');
      });
    } catch {
      threw = true;
    }
    const afterRollback = await this.ctx.storage.getAlarm();
    await this.ctx.storage.deleteAlarm();
    return { threw, alarmSurvivedRollback: afterRollback !== null };
  }
}

interface ProbeEnv {
  PROBE: { idFromName(name: string): unknown; get(id: unknown): { fetch(r: Request): Promise<Response> } };
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/healthz') return Response.json({ ok: true });
    return env.PROBE.get(env.PROBE.idFromName(path)).fetch(request);
  },
};
