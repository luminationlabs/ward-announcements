/**
 * Every query the app makes, and nothing about *where* it runs.
 *
 * This module holds SQL strings and talks to whichever `SqlDriver` the entry point installed
 * (`setDriver`) — better-sqlite3 on Node, D1 on Cloudflare Workers. Two consequences of that seam
 * are visible throughout the file and are not stylistic:
 *
 * - Parameters are **positional** (`?`), never named, because D1 binds by position only.
 * - Atomic work goes through `driver.batch()`, which takes a finished list of writes. Nothing may
 *   read or branch mid-transaction; callers resolve everything in JS first.
 */
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { tablesOf, type SchemaTable } from './restore.js';
import type { SqlDriver, SqlValue, SqlWrite } from './sqldriver.js';
import { tenantLocal } from './tenant.js';

// ---------------------------------------------------------------------------
// The driver (one per ward — see tenant.ts)
// ---------------------------------------------------------------------------

const installed = tenantLocal<{ driver: SqlDriver | null }>(() => ({ driver: null }));

/**
 * Install the current ward's driver. The entry point does this at boot: `server.ts` builds a
 * better-sqlite3 driver from DATABASE_PATH; `worker.ts` builds a D1 one from its binding.
 */
export function setDriver(next: SqlDriver): void {
  installed().driver = next;
}

/** The installed driver, or a loud error — a missing driver is a boot-order bug, not a runtime one. */
function sql(): SqlDriver {
  const { driver } = installed();
  if (!driver) {
    throw new Error('No SQL driver installed — call setDriver() (and initDb()) before using db.ts.');
  }
  return driver;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * The schema, one statement per entry.
 *
 * Kept as separate statements rather than one blob because D1 cannot reliably `exec()` a
 * multi-statement script; each is run on its own, in this order. Every statement is
 * `IF NOT EXISTS`, so running the whole list is idempotent — but running it is not the
 * *normal* path: `initDb` reads a `schema_version` marker first and does nothing else when the
 * database is already current (see `initDb`). A column added to an existing table cannot be
 * expressed as `CREATE IF NOT EXISTS`, so it goes in `MIGRATIONS` below as well as here.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint        TEXT NOT NULL UNIQUE,
    p256dh          TEXT NOT NULL,
    auth            TEXT NOT NULL,
    user_agent      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_success_at TEXT,
    failure_count   INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS announcements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    published   INTEGER NOT NULL DEFAULT 1,
    expires_at  TEXT,                                  -- 'YYYY-MM-DD' or NULL
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sort_order  INTEGER NOT NULL DEFAULT 0             -- manual order (asc); lower = shown first
  )`,

  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS send_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
    title           TEXT NOT NULL,
    body            TEXT,
    recipient_count INTEGER NOT NULL,
    type            TEXT NOT NULL
  )`,

  // Shared member access codes, the credential printed on QR posters and share links. Exactly one
  // row is "active" (retired_at IS NULL) at a time; rotating mints a new active row and gives the
  // outgoing one a grace window so posters and links already in the wild keep working for a while.
  `CREATE TABLE IF NOT EXISTS access_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    retired_at TEXT,                                   -- NULL = this is the current code
    expires_at TEXT                                    -- NULL = never expires
  )`,

  // Non-shared, self-expiring access credentials. Three kinds:
  //   'invite' — minted by a member from the share sheet; short-lived, unlimited uses.
  //   'email'  — minted from the dashboard's Preview for the link in the weekly email / PDF;
  //              two weeks, unlimited uses, one per week rather than one per export.
  //   'device' — minted for one installed PWA and embedded in its manifest start_url; long-lived,
  //              so a rotated-away access code can expire without stranding installed devices.
  `CREATE TABLE IF NOT EXISTS access_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    device_id    TEXT,                                 -- kind='device': the cookie it's bound to
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    uses         INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_access_tokens_device ON access_tokens (kind, device_id)`,

  // One row per *send in progress*, alongside the `send_log` row it will finish into. A send is no
  // longer one burst of `fetch`es: it is enqueued, then drained a chunk at a time (see `push.ts`),
  // because a Cloudflare Worker gets ~10 ms of CPU per invocation and a push encryption costs a
  // fraction of a millisecond each. The running totals live here rather than on `send_log` so the
  // existing send-history columns keep their meaning — `send_log.recipient_count` is still written
  // exactly once, when the queue for that send empties.
  `CREATE TABLE IF NOT EXISTS send_batches (
    send_log_id INTEGER PRIMARY KEY,
    url         TEXT NOT NULL,
    slot        TEXT,                                  -- scheduled-slot key; NULL for a manual send
    total       INTEGER NOT NULL DEFAULT 0,            -- subscribers at enqueue time
    sent        INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'done'
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  )`,

  // The dedupe guard for scheduled sends. Cloudflare cron triggers have been observed to fire the
  // same minute twice, and the weekly digest must not go out twice; SQLite treats NULLs as distinct
  // in a UNIQUE index, so manual sends (slot NULL) are unconstrained.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_send_batches_slot ON send_batches (slot)`,

  // One row per (send, subscriber) still to deliver. Deleted as it is delivered, given up on, or
  // orphaned; when the last row for a send goes, that send's `send_log` row is finalised.
  //
  // `claimed_at`/`claim_token` are a **lease**, not decoration. Two drains that can't see each
  // other — a cron tick overlapping the previous one, a manual send racing the weekly digest —
  // would otherwise both read the same oldest rows and deliver them twice. A claim stamps the rows
  // it took with a token unique to that drain and reads them back by it; a row whose lease has gone
  // stale (`CLAIM_LEASE`) is reclaimable, which is what recovers rows orphaned by an isolate that
  // was killed mid-chunk. `attempts` is incremented **at claim time** for the same reason: a
  // process that dies before committing must still have spent an attempt, or a deterministic
  // mid-chunk crash would re-deliver the same row forever.
  `CREATE TABLE IF NOT EXISTS send_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    send_log_id     INTEGER NOT NULL,
    subscription_id INTEGER NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at      TEXT,                                -- NULL = nobody holds this row
    claim_token     TEXT,                                -- who holds it (one token per drain)
    not_before      TEXT                                 -- a retry waits until this (NULL = now)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_send_queue_log ON send_queue (send_log_id)`,

  // Sundays the weekly digest is deliberately not sent: General Conference, a stake conference, any
  // week the ward would rather stay quiet. Keyed by the **local date** rather than by a slot key
  // (`YYYY-MM-DDTHH:MM`) on purpose — an admin who later moves the send from 08:00 to 07:30 has not
  // changed their mind about Conference, and a slot-keyed row would silently stop matching.
  `CREATE TABLE IF NOT EXISTS send_skips (
    skip_date  TEXT PRIMARY KEY,                      -- 'YYYY-MM-DD', local (config.timezone)
    note       TEXT,                                  -- why, shown in the history when it fires
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // One sacrament meeting program per Sunday, authored in Markdown like an announcement. The date
  // is the key members and admins both think in ("the 12th's program"), so it is UNIQUE rather than
  // merely indexed: two rows for one Sunday would make "today's program" ambiguous, and the window
  // logic in `programs.ts` looks a program up by exactly this column.
  `CREATE TABLE IF NOT EXISTS programs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    program_date TEXT NOT NULL UNIQUE,               -- 'YYYY-MM-DD', local (config.timezone)
    body_md      TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Standing reference pages — the Resources tab. Shaped like an announcement minus the two
  // things that make an announcement an
  // announcement: no expiry (a page is current until someone edits it) and no place in the weekly
  // digest. `published` keeps a half-written page off the public tab.
  `CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    published   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sort_order  INTEGER NOT NULL DEFAULT 0             -- manual order (asc); lower = shown first
  )`,

  // Uploaded images, one row per stored object. The bytes live in the FileStore (a directory on
  // Node, an R2 bucket on Workers) and `key` is the name they live under there — unique, since it
  // is also the public URL at `/images/<key>`.
  //
  // `owner_type` is 'announcement', 'program' or 'page'; every function over this table takes the
  // owner type rather than assuming, which is what made attaching images to programs (and then
  // pages) a new value here rather than a migration.
  `CREATE TABLE IF NOT EXISTS attachments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type   TEXT NOT NULL,                      -- 'announcement' | 'program' | 'page'
    owner_id     INTEGER NOT NULL,
    key          TEXT NOT NULL UNIQUE,               -- storage key = the /images/ path segment
    filename     TEXT,                               -- what the admin's file was called, for alt text
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments (owner_type, owner_id)`,

  // Image bytes, for a deployment with no R2 bucket (see `filestore-sql.ts`). Base64 text split into
  // chunks, because a D1 row is capped at 2 MB and an upload may be 3. Left out of the JSON backup
  // (`dumpDatabase`) exactly as R2's objects are, and an older backup without it restores around it.
  `CREATE TABLE IF NOT EXISTS file_chunks (
    key          TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    data         TEXT NOT NULL,                        -- base64
    PRIMARY KEY (key, seq)
  )`,

  // The people who sign in to the dashboard, each with their own passkeys (src/passkeys.ts). The
  // owner is not here: they sign in with ADMIN_PASSWORD. `webauthn_id` is the random user handle a
  // passkey carries, so a sign-in can name its person without a username. `session_version` is
  // bumped to end every session a person holds ("sign out everywhere").
  `CREATE TABLE IF NOT EXISTS admin_users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL,                     -- 'admin' | 'editor'
    webauthn_id     TEXT NOT NULL UNIQUE,              -- base64url
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS admin_passkeys (
    id           TEXT PRIMARY KEY,                     -- credential id, base64url
    user_id      INTEGER NOT NULL,
    public_key   TEXT NOT NULL,                        -- COSE key, base64url
    counter      INTEGER NOT NULL DEFAULT 0,
    transports   TEXT,                                 -- JSON array, as the browser reported it
    label        TEXT,                                 -- where it was made: 'iPhone', 'Mac', …
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_passkeys_user ON admin_passkeys (user_id)`,

  // One-time links that let a person create a passkey: on first joining, or on a new phone.
  `CREATE TABLE IF NOT EXISTS admin_invites (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT
  )`,

  // WebAuthn challenges that have been answered (`takeChallenge` in auth.ts), by hash. The
  // challenge itself travels in a signed five-minute cookie, so without this a client that kept the
  // cookie could answer the same challenge again for the rest of those five minutes; the
  // authenticator's signature counter was the only other guard, and synced passkeys report 0.
  // Rows outlive their challenge by nothing: `expires_at` is the cookie's own deadline, and the
  // daily sweep (`maybePurgeHistory` in tick.ts) deletes what is past it.
  `CREATE TABLE IF NOT EXISTS spent_challenges (
    id         TEXT PRIMARY KEY,                       -- sha256 of the challenge, hex
    expires_at TEXT NOT NULL                           -- 'YYYY-MM-DD HH:MM:SS' UTC, as datetime('now')
  )`,
  // Devices an admin removed under Subscribers, by endpoint hash. Deleting the row alone never
  // stuck: the phone still holds its live PushSubscription and re-posts it on every launch
  // (`syncSubscription` in public/app.js), so the row was back the next time the member opened the
  // app. `/api/subscribe` refuses a blocked endpoint unless the member taps Enable Notifications
  // themselves (`deliberate: true`), which lifts the block. Only the hash is kept: the endpoint is
  // the subscription's credential, and a block list must not double as a list of things to push to.
  `CREATE TABLE IF NOT EXISTS blocked_subscriptions (
    endpoint_hash TEXT PRIMARY KEY,                    -- sha256 of the endpoint, hex
    blocked_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

/**
 * Bump whenever `SCHEMA` or `MIGRATIONS` changes. Stored in `settings.schema_version`.
 *
 * 1 — the original tables (never actually written; a database with no marker is treated as "old").
 * 2 — `send_queue.claimed_at` / `send_queue.claim_token` (the drain lease).
 * 3 — the `send_skips` table (Sundays the ward chooses not to send on).
 * 4 — `send_queue.not_before` (retry backoff).
 * 5 — the `pages` table (the Resources tab).
 * 6 — the `file_chunks` table (image bytes when no R2 bucket is bound).
 * 7 — `admin_users`, `admin_passkeys`, `admin_invites` (per-person passkey sign-in).
 * 8 — `admin_passkeys.label` (the device a passkey was made on).
 * 9 — the `spent_challenges` table (answered WebAuthn challenges, so one cannot be answered twice).
 * 10 — the `blocked_subscriptions` table (devices removed under Subscribers, so a launch cannot re-add them).
 */
const SCHEMA_VERSION = '10';

/**
 * Columns an already-created table needs. `CREATE TABLE IF NOT EXISTS` cannot express one, so the
 * `SCHEMA` entry above covers a *new* database and this covers the deployed one.
 *
 * Each is guarded twice, because `initDb` may run the list more than once (a version write that
 * didn't land, two isolates racing) and `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`:
 *
 * 1. `hasColumn` probes first, with a `SELECT` rather than a `PRAGMA` — the probe has to work
 *    identically on D1 and on better-sqlite3, and a plain select does.
 * 2. If the ALTER runs anyway and fails on "duplicate column", that is swallowed too. This is the
 *    narrow race between two isolates that both probed and both found it missing, and it is
 *    deliberately not the *only* guard: D1 wraps SQLite's errors in its own text, and a
 *    deployment's schema is not something to gate on a message format.
 */
const MIGRATIONS: { table: string; column: string; sql: string }[] = [
  {
    table: 'send_queue',
    column: 'claimed_at',
    sql: `ALTER TABLE send_queue ADD COLUMN claimed_at TEXT`,
  },
  {
    table: 'send_queue',
    column: 'claim_token',
    sql: `ALTER TABLE send_queue ADD COLUMN claim_token TEXT`,
  },
  {
    table: 'send_queue',
    column: 'not_before',
    sql: `ALTER TABLE send_queue ADD COLUMN not_before TEXT`,
  },
  {
    table: 'admin_passkeys',
    column: 'label',
    sql: `ALTER TABLE admin_passkeys ADD COLUMN label TEXT`,
  },
];

/** Does `table` already have `column`? Asked by selecting it; an error means no. */
async function hasColumn(table: string, column: string): Promise<boolean> {
  try {
    // Table and column are our own constants above, never input — safe to interpolate.
    await sql().first(`SELECT ${column} FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/** True for the one error a re-run `ADD COLUMN` is allowed to raise. */
function isDuplicateColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate column/i.test(message);
}

/**
 * Bring the database up to `SCHEMA_VERSION`. Passing a driver installs it first, which is the usual
 * call.
 *
 * **The common path is one query.** Node calls this once per boot, but a Worker isolate calls it
 * before its first query — and an isolate is created and discarded constantly — so running fourteen
 * DDL statements here spent fourteen of the fifty subrequests a Workers invocation is allowed,
 * every cold start, forever. Reading the version marker instead costs one, and finds nothing to do.
 *
 * Two isolates racing this is safe: every statement is idempotent (`IF NOT EXISTS`, or a swallowed
 * duplicate-column), and the version write happens last and writes the same value from both.
 */
export async function initDb(next?: SqlDriver): Promise<void> {
  if (next) setDriver(next);
  // On a brand-new database this throws (no `settings` table yet), which is itself the answer.
  const current = await getSetting('schema_version').catch(() => null);
  if (current === SCHEMA_VERSION) return;

  for (const statement of SCHEMA) {
    await sql().run(statement);
  }
  for (const migration of MIGRATIONS) {
    if (await hasColumn(migration.table, migration.column)) continue;
    try {
      await sql().run(migration.sql);
    } catch (err) {
      if (!isDuplicateColumn(err)) throw err;
    }
  }
  await setSetting('schema_version', SCHEMA_VERSION);
}

/**
 * This version's tables with their columns, and its schema version: what a restore maps a backup
 * onto (`restore.ts`). Read out of `SCHEMA` itself, so a column added there is restorable at once.
 */
export function restoreTarget(): { tables: SchemaTable[]; version: number } {
  return { tables: tablesOf(SCHEMA), version: Number(SCHEMA_VERSION) };
}

/** Every table in the schema, in creation order. Derived from `SCHEMA` so it can't go stale. */
export function schemaTables(): string[] {
  return SCHEMA.map((statement) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1]).filter(
    (name): name is string => !!name,
  );
}

/**
 * Every row of every table, for the admin backup download.
 *
 * A portable dump rather than a SQLite file image: the file image only exists on the Node driver,
 * and JSON restores anywhere. Table names come from `schemaTables()` — they are our own constants,
 * never user input, so interpolating them into the query is safe.
 */
export async function dumpDatabase(): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {};
  for (const table of schemaTables()) {
    // Image bytes stay out, as R2's do: megabytes of base64 would swamp a file meant to be read,
    // and building it could outrun a Worker's CPU allowance.
    if (table === 'file_chunks') continue;
    dump[table] = await sql().all<unknown>(`SELECT * FROM ${table}`);
  }
  return dump;
}

// ---------------------------------------------------------------------------
// Image bytes (the SQL file store)
// ---------------------------------------------------------------------------

/** Replace one stored file's chunks, atomically. */
export async function putFileChunks(key: string, contentType: string, chunks: string[]): Promise<void> {
  await sql().batch([
    { sql: `DELETE FROM file_chunks WHERE key = ?`, params: [key] },
    ...chunks.map((data, seq) => ({
      sql: `INSERT INTO file_chunks (key, seq, content_type, data) VALUES (?, ?, ?, ?)`,
      params: [key, seq, contentType, data],
    })),
  ]);
}

export async function getFileChunks(key: string): Promise<{ content_type: string; data: string }[]> {
  return sql().all(`SELECT content_type, data FROM file_chunks WHERE key = ? ORDER BY seq`, [key]);
}

export async function deleteFileChunks(key: string): Promise<void> {
  await sql().run(`DELETE FROM file_chunks WHERE key = ?`, [key]);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  failure_count: number;
}

const SUB = {
  upsert: `
    INSERT INTO subscriptions (endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      failure_count = 0
  `,
  getByEndpoint: `SELECT * FROM subscriptions WHERE endpoint = ?`,
  getById: `SELECT * FROM subscriptions WHERE id = ?`,
  deleteByEndpoint: `DELETE FROM subscriptions WHERE endpoint = ?`,
  deleteById: `DELETE FROM subscriptions WHERE id = ?`,
  all: `SELECT * FROM subscriptions`,
  allOrdered: `SELECT * FROM subscriptions ORDER BY created_at DESC, id DESC`,
  count: `SELECT COUNT(*) AS n FROM subscriptions`,
  markSuccess: `UPDATE subscriptions SET last_success_at = datetime('now'), failure_count = 0 WHERE endpoint = ?`,
  markFailure: `UPDATE subscriptions SET failure_count = failure_count + 1 WHERE endpoint = ? RETURNING failure_count`,
};

export async function upsertSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}): Promise<void> {
  await sql().run(SUB.upsert, [
    input.endpoint,
    input.p256dh,
    input.auth,
    input.user_agent,
  ]);
}

export async function getSubscriptionByEndpoint(
  endpoint: string,
): Promise<SubscriptionRow | undefined> {
  return sql().first<SubscriptionRow>(SUB.getByEndpoint, [endpoint]);
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  await sql().run(SUB.deleteByEndpoint, [endpoint]);
}

export async function deleteSubscriptionById(id: number): Promise<void> {
  await sql().run(SUB.deleteById, [id]);
}

export async function getSubscriptionById(id: number): Promise<SubscriptionRow | undefined> {
  return sql().first<SubscriptionRow>(SUB.getById, [id]);
}

// --- The block list (see `blocked_subscriptions` in SCHEMA) ---------------------------------------

const BLOCK = {
  insert: `INSERT OR IGNORE INTO blocked_subscriptions (endpoint_hash) VALUES (?)`,
  get: `SELECT endpoint_hash FROM blocked_subscriptions WHERE endpoint_hash = ?`,
  delete: `DELETE FROM blocked_subscriptions WHERE endpoint_hash = ?`,
};

/** The one way an endpoint is written to the block list: hashed, never in the clear. */
function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

const blockWrite = (endpoint: string): SqlWrite => ({ sql: BLOCK.insert, params: [endpointHash(endpoint)] });
const unblockWrite = (endpoint: string): SqlWrite => ({ sql: BLOCK.delete, params: [endpointHash(endpoint)] });

export async function blockSubscription(endpoint: string): Promise<void> {
  await sql().run(BLOCK.insert, [endpointHash(endpoint)]);
}

export async function unblockSubscription(endpoint: string): Promise<void> {
  await sql().run(BLOCK.delete, [endpointHash(endpoint)]);
}

/** A rotation of a blocked endpoint: the block follows the device to its new endpoint. */
export async function moveSubscriptionBlock(from: string, to: string): Promise<void> {
  await sql().batch([blockWrite(to), unblockWrite(from)]);
}

export async function isBlockedSubscription(endpoint: string): Promise<boolean> {
  return !!(await sql().first(BLOCK.get, [endpointHash(endpoint)]));
}

/**
 * An admin's Remove: the row and the block, as one write. Two separate ones could lose the block
 * to a crash between them, which is the old behaviour (the row comes back at the next launch).
 */
export async function removeSubscriptionById(id: number): Promise<void> {
  const row = await getSubscriptionById(id);
  if (!row) return;
  await sql().batch([{ sql: SUB.deleteById, params: [id] }, blockWrite(row.endpoint)]);
}

/**
 * `/api/subscribe`'s write: the upsert, the drop of the endpoint it rotated from (`rotatedFrom`)
 * and, for a member's own Enable tap, the lifting of any block on either — one batch, so a crash
 * cannot leave a subscription stored but still blocked, or unblocked but not stored.
 */
export async function upsertSubscriptionWith(
  input: { endpoint: string; p256dh: string; auth: string; user_agent: string | null },
  opts: { rotatedFrom: string | null; unblock: boolean },
): Promise<void> {
  const writes: SqlWrite[] = [
    { sql: SUB.upsert, params: [input.endpoint, input.p256dh, input.auth, input.user_agent] },
  ];
  if (opts.rotatedFrom !== null) writes.push({ sql: SUB.deleteByEndpoint, params: [opts.rotatedFrom] });
  if (opts.unblock) {
    writes.push(unblockWrite(input.endpoint));
    if (opts.rotatedFrom !== null) writes.push(unblockWrite(opts.rotatedFrom));
  }
  await sql().batch(writes);
}

export async function getAllSubscriptions(): Promise<SubscriptionRow[]> {
  return sql().all<SubscriptionRow>(SUB.all);
}

export async function listSubscriptions(): Promise<SubscriptionRow[]> {
  return sql().all<SubscriptionRow>(SUB.allOrdered);
}

export async function countSubscriptions(): Promise<number> {
  const row = await sql().first<{ n: number }>(SUB.count);
  return row?.n ?? 0;
}

export async function markSubscriptionSuccess(endpoint: string): Promise<void> {
  await sql().run(SUB.markSuccess, [endpoint]);
}

/** Increment the failure counter and return the new count (0 if the row no longer exists). */
export async function markSubscriptionFailure(endpoint: string): Promise<number> {
  const row = await sql().first<{ failure_count: number }>(SUB.markFailure, [endpoint]);
  return row ? row.failure_count : 0;
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  published: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  sort_order: number;
}

/**
 * Today's date as 'YYYY-MM-DD' in the configured timezone (not UTC). Used for expiry comparisons
 * so "Hide after <date>" tracks local calendar days — an announcement stays visible through the
 * end of its expiry day in America/Denver rather than hiding hours early at UTC midnight.
 */
export function localToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const ANN = {
  publicList: `
    SELECT * FROM announcements
    WHERE published = 1 AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY sort_order ASC, id DESC
  `,
  publicCount: `
    SELECT COUNT(*) AS n FROM announcements
    WHERE published = 1 AND (expires_at IS NULL OR expires_at >= ?)
  `,
  allList: `SELECT * FROM announcements ORDER BY sort_order ASC, id DESC`,
  byId: `SELECT * FROM announcements WHERE id = ?`,
  insert: `
    INSERT INTO announcements (title, body, published, expires_at, sort_order)
    VALUES (?, ?, ?, ?,
            (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM announcements))
  `,
  update: `
    UPDATE announcements
    SET title = ?, body = ?, published = ?, expires_at = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `,
  setPublished: `UPDATE announcements SET published = ?, updated_at = datetime('now') WHERE id = ?`,
  delete: `DELETE FROM announcements WHERE id = ?`,
  count: `SELECT COUNT(*) AS n FROM announcements`,
  reorder: `UPDATE announcements SET sort_order = ? WHERE id = ?`,
};

export interface AnnouncementInput {
  title: string;
  body: string;
  published: boolean;
  expires_at: string | null;
}

export async function listPublicAnnouncements(): Promise<AnnouncementRow[]> {
  return sql().all<AnnouncementRow>(ANN.publicList, [localToday()]);
}

export async function countPublicAnnouncements(): Promise<number> {
  const row = await sql().first<{ n: number }>(ANN.publicCount, [localToday()]);
  return row?.n ?? 0;
}

export async function listAllAnnouncements(): Promise<AnnouncementRow[]> {
  return sql().all<AnnouncementRow>(ANN.allList);
}

export async function getAnnouncement(id: number): Promise<AnnouncementRow | undefined> {
  return sql().first<AnnouncementRow>(ANN.byId, [id]);
}

export async function createAnnouncement(input: AnnouncementInput): Promise<number> {
  const info = await sql().run(ANN.insert, [
    input.title,
    input.body,
    input.published ? 1 : 0,
    input.expires_at,
  ]);
  return info.lastRowId;
}

export async function updateAnnouncement(id: number, input: AnnouncementInput): Promise<void> {
  await sql().run(ANN.update, [
    input.title,
    input.body,
    input.published ? 1 : 0,
    input.expires_at,
    id,
  ]);
}

export async function setAnnouncementPublished(id: number, published: boolean): Promise<void> {
  await sql().run(ANN.setPublished, [published ? 1 : 0, id]);
}

export async function deleteAnnouncement(id: number): Promise<void> {
  await sql().run(ANN.delete, [id]);
}

/** Persist a new manual order. Rewrites sort_order to 0..n in the given id sequence (ids not
 *  present are left untouched; unknown ids are no-ops).
 *
 *  The order is fully resolved in JS first, so the atomic part is a plain list of bound writes
 *  with nothing to read or decide inside it (see `SqlDriver.batch`). */
export async function reorderAnnouncements(orderedIds: number[]): Promise<void> {
  await sql().batch(
    orderedIds.map((id, order) => ({ sql: ANN.reorder, params: [order, id] as SqlValue[] })),
  );
}

// ---------------------------------------------------------------------------
// Resource pages
// ---------------------------------------------------------------------------
//
// The same shape as announcements without expiry: a title, a Markdown body, a publish flag and a
// manual order. Kept as its own table rather than a `kind` column on announcements so that nothing
// that iterates announcements — the weekly digest's "is there anything to send?", the email
// preview, the expiry badges — can ever pick a page up by accident.

export interface PageRow {
  id: number;
  title: string;
  body: string;
  published: number;
  created_at: string;
  updated_at: string;
  sort_order: number;
}

const PAGE = {
  publicList: `SELECT * FROM pages WHERE published = 1 ORDER BY sort_order ASC, id ASC`,
  allList: `SELECT * FROM pages ORDER BY sort_order ASC, id ASC`,
  byId: `SELECT * FROM pages WHERE id = ?`,
  // New pages go to the *bottom*, unlike announcements: a resources list is read top-down as a
  // table of contents, and the newest page is rarely the most important one.
  insert: `
    INSERT INTO pages (title, body, published, sort_order)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM pages))
  `,
  update: `
    UPDATE pages SET title = ?, body = ?, published = ?, updated_at = datetime('now') WHERE id = ?
  `,
  delete: `DELETE FROM pages WHERE id = ?`,
  reorder: `UPDATE pages SET sort_order = ? WHERE id = ?`,
};

export interface PageInput {
  title: string;
  body: string;
  published: boolean;
}

export async function listPublicPages(): Promise<PageRow[]> {
  return sql().all<PageRow>(PAGE.publicList);
}

export async function listAllPages(): Promise<PageRow[]> {
  return sql().all<PageRow>(PAGE.allList);
}

export async function getPage(id: number): Promise<PageRow | undefined> {
  return sql().first<PageRow>(PAGE.byId, [id]);
}

export async function createPage(input: PageInput): Promise<number> {
  const info = await sql().run(PAGE.insert, [input.title, input.body, input.published ? 1 : 0]);
  return info.lastRowId;
}

export async function updatePage(id: number, input: PageInput): Promise<void> {
  await sql().run(PAGE.update, [input.title, input.body, input.published ? 1 : 0, id]);
}

export async function deletePage(id: number): Promise<void> {
  await sql().run(PAGE.delete, [id]);
}

/** Same contract as `reorderAnnouncements`. */
export async function reorderPages(orderedIds: number[]): Promise<void> {
  await sql().batch(
    orderedIds.map((id, order) => ({ sql: PAGE.reorder, params: [order, id] as SqlValue[] })),
  );
}

// ---------------------------------------------------------------------------
// Sacrament meeting programs
// ---------------------------------------------------------------------------
//
// One row per Sunday, keyed by its local date. Unlike announcements there is no publish flag and no
// manual order: a program is either written for a date or it isn't, and *when* it is visible is
// decided by the time window in `programs.ts`, not by a column here.

export interface ProgramRow {
  id: number;
  program_date: string;
  body_md: string;
  created_at: string;
  updated_at: string;
}

/**
 * A program as the dashboard's list needs it: what to label the row, and what to address it by.
 *
 * Its own type because the list is the one place that reads *every* program rather than one. A
 * `SELECT *` there carries `body_md` — the whole program, every name in it — for as many rows as
 * the retention window holds, only for the card to render a date and two links.
 */
export interface ProgramListRow {
  id: number;
  program_date: string;
}

const PROGRAM = {
  byId: `SELECT * FROM programs WHERE id = ?`,
  byDate: `SELECT * FROM programs WHERE program_date = ?`,
  // Deliberately not `SELECT *` — see `ProgramListRow`.
  recent: `SELECT id, program_date FROM programs ORDER BY program_date DESC, id DESC LIMIT ?`,
  insert: `INSERT INTO programs (program_date, body_md) VALUES (?, ?)`,
  update: `
    UPDATE programs
    SET program_date = ?, body_md = ?, updated_at = datetime('now')
    WHERE id = ?
  `,
  delete: `DELETE FROM programs WHERE id = ?`,
  // Retention: the oldest expired programs first, capped by the caller. The cap is not cosmetic —
  // each program deleted costs one storage delete per image, and on Workers every one of those is a
  // subrequest against a per-invocation budget (see `purgeOldPrograms`).
  olderThan: `SELECT * FROM programs WHERE program_date < ? ORDER BY program_date ASC LIMIT ?`,
};

export async function getProgram(id: number): Promise<ProgramRow | undefined> {
  return sql().first<ProgramRow>(PROGRAM.byId, [id]);
}

/** The program written for a given local date, if there is one. */
export async function getProgramByDate(date: string): Promise<ProgramRow | undefined> {
  return sql().first<ProgramRow>(PROGRAM.byDate, [date]);
}

/** Most recent programs first — what the dashboard's Programs card lists, dates only. */
export async function listRecentPrograms(limit = 12): Promise<ProgramListRow[]> {
  return sql().all<ProgramListRow>(PROGRAM.recent, [limit]);
}

export async function createProgram(input: { date: string; body: string }): Promise<number> {
  const info = await sql().run(PROGRAM.insert, [input.date, input.body]);
  return info.lastRowId;
}

export async function updateProgram(
  id: number,
  input: { date: string; body: string },
): Promise<void> {
  await sql().run(PROGRAM.update, [input.date, input.body, id]);
}

export async function deleteProgram(id: number): Promise<void> {
  await sql().run(PROGRAM.delete, [id]);
}

/** Programs dated before `cutoff`, oldest first, at most `limit` of them. */
export async function programsBefore(cutoff: string, limit: number): Promise<ProgramRow[]> {
  return sql().all<ProgramRow>(PROGRAM.olderThan, [cutoff, limit]);
}

// ---------------------------------------------------------------------------
// Attachments (uploaded images)
// ---------------------------------------------------------------------------
//
// Rows only — the bytes are the FileStore's business (see `filestore.ts`). Every function here
// takes an owner *type* alongside the id rather than hard-coding 'announcement', so the next thing
// that wants images is a new value rather than a schema change. Deleting a row is never enough on
// its own: whoever deletes it must also delete the stored object, which is why the routes in
// `app.ts` own that pairing.

export interface AttachmentRow {
  id: number;
  owner_type: string;
  owner_id: number;
  key: string;
  filename: string | null;
  content_type: string;
  size: number;
  created_at: string;
}

const ATTACH = {
  forOwner: `
    SELECT * FROM attachments
    WHERE owner_type = ? AND owner_id = ?
    ORDER BY id ASC
  `,
  countForOwner: `SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ? AND owner_id = ?`,
  byId: `SELECT * FROM attachments WHERE id = ?`,
  byKey: `SELECT * FROM attachments WHERE key = ?`,
  insert: `
    INSERT INTO attachments (owner_type, owner_id, key, filename, content_type, size)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  delete: `DELETE FROM attachments WHERE id = ?`,
  deleteForOwner: `DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?`,
};

export async function listAttachments(
  ownerType: string,
  ownerId: number,
): Promise<AttachmentRow[]> {
  return sql().all<AttachmentRow>(ATTACH.forOwner, [ownerType, ownerId]);
}

/**
 * Every attachment for a set of owners, in one query.
 *
 * The public announcements list needs images for all of its rows at once, and a per-announcement
 * query would be a round trip each — cheap on a local SQLite file, not on D1 over the network.
 */
export async function listAttachmentsForOwners(
  ownerType: string,
  ownerIds: number[],
): Promise<AttachmentRow[]> {
  // In chunks: D1 and Durable Object SQLite both refuse a statement with more than 100 bound
  // parameters, and this list is every live announcement or page — uncapped. Node's limit is 32k,
  // so only the Workers suites would ever have noticed. Ids ascend across chunks, so the rows still
  // come back in owner order.
  const ids = [...ownerIds].sort((a, b) => a - b);
  const rows: AttachmentRow[] = [];
  for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
    const chunk = ids.slice(i, i + IN_LIST_CHUNK);
    rows.push(
      ...(await sql().all<AttachmentRow>(
        `SELECT * FROM attachments
         WHERE owner_type = ? AND owner_id IN (${placeholders(chunk.length)})
         ORDER BY owner_id ASC, id ASC`,
        [ownerType, ...chunk],
      )),
    );
  }
  return rows;
}

export async function countAttachments(ownerType: string, ownerId: number): Promise<number> {
  const row = await sql().first<{ n: number }>(ATTACH.countForOwner, [ownerType, ownerId]);
  return row?.n ?? 0;
}

/**
 * The owner type of an image uploaded on a *New* announcement, page or program — before there is a
 * row to attach it to. The form carries the ids; saving it claims them for the new row
 * (`claimPendingAttachments`). One that is never claimed (the clerk cancelled) is deleted by the
 * daily sweep after `PENDING_DAYS` (`stalePendingAttachments`).
 */
export const PENDING_OWNER = 'pending';

/** Pending images across the ward, to bound what an abandoned form can leave behind. */
export async function countPendingAttachments(): Promise<number> {
  const row = await sql().first<{ n: number }>(`SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ?`, [
    PENDING_OWNER,
  ]);
  return row?.n ?? 0;
}

/**
 * Attach pending images to the row just saved. Only rows still pending move, so an id that was
 * already claimed, swept or made up is simply ignored. In the order given, which is the order the
 * clerk added them.
 */
export async function claimPendingAttachments(ids: number[], ownerType: string, ownerId: number): Promise<void> {
  if (ids.length === 0) return;
  await sql().batch(
    ids.map((id) => ({
      sql: `UPDATE attachments SET owner_type = ?, owner_id = ? WHERE id = ? AND owner_type = ?`,
      params: [ownerType, ownerId, id, PENDING_OWNER],
    })),
  );
}

/** Pending images by id, in the order given: what a rejected New form shows again. */
export async function pendingAttachmentsByIds(ids: number[]): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const rows = await sql().all<AttachmentRow>(
    `SELECT * FROM attachments WHERE owner_type = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    [PENDING_OWNER, ...ids],
  );
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is AttachmentRow => !!r);
}

/** Pending images older than a day: uploaded to a form nobody saved. A bounded batch per sweep. */
export async function stalePendingAttachments(limit: number): Promise<AttachmentRow[]> {
  return sql().all<AttachmentRow>(
    `SELECT * FROM attachments WHERE owner_type = ? AND created_at < datetime('now', '-1 day') ORDER BY id LIMIT ?`,
    [PENDING_OWNER, limit],
  );
}

/** Every stored image's key, for deleting a whole ward's images (the many-ward host). */
export async function listAllAttachmentKeys(): Promise<string[]> {
  return (await sql().all<{ key: string }>(`SELECT key FROM attachments`)).map((row) => row.key);
}

/** Bytes of every image the ward has stored, for the per-ward quota (`IMAGE_QUOTA_MB`). */
export async function totalAttachmentBytes(): Promise<number> {
  const row = await sql().first<{ n: number }>(`SELECT COALESCE(SUM(size), 0) AS n FROM attachments`);
  return row?.n ?? 0;
}

export async function attachmentById(id: number): Promise<AttachmentRow | undefined> {
  return sql().first<AttachmentRow>(ATTACH.byId, [id]);
}

export async function attachmentByKey(key: string): Promise<AttachmentRow | undefined> {
  return sql().first<AttachmentRow>(ATTACH.byKey, [key]);
}

export async function createAttachment(input: {
  ownerType: string;
  ownerId: number;
  key: string;
  filename: string | null;
  contentType: string;
  size: number;
}): Promise<number> {
  const info = await sql().run(ATTACH.insert, [
    input.ownerType,
    input.ownerId,
    input.key,
    input.filename,
    input.contentType,
    input.size,
  ]);
  return info.lastRowId;
}

export async function deleteAttachment(id: number): Promise<void> {
  await sql().run(ATTACH.delete, [id]);
}

/**
 * Record the stored size of an imported image. A backup's row says how big the image was when it
 * was backed up; the import strips its metadata before storing it (`image-meta.ts`), and the quota
 * sums `size`, so the row follows the bytes.
 */
export async function setAttachmentSize(key: string, size: number): Promise<void> {
  await sql().run(`UPDATE attachments SET size = ? WHERE key = ?`, [size, key]);
}

/** Drop every attachment row for an owner. The caller deletes the stored objects. */
export async function deleteAttachmentsForOwner(
  ownerType: string,
  ownerId: number,
): Promise<void> {
  await sql().run(ATTACH.deleteForOwner, [ownerType, ownerId]);
}

// ---------------------------------------------------------------------------
// Settings (key/value)
// ---------------------------------------------------------------------------

const SETTING = {
  get: `SELECT value FROM settings WHERE key = ?`,
  set: `
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
  setIfAbsent: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
};

export async function getSetting(key: string): Promise<string | null> {
  const row = await sql().first<{ value: string | null }>(SETTING.get, [key]);
  return row ? row.value : null;
}

/**
 * Several settings in one query.
 *
 * A settings read is a subrequest on Workers, and the two callers that want a *group* of keys
 * (`getScheduleSettings`, `getProgramSettings`) run on the per-minute cron tick, where five
 * sequential reads is five of a fifty-subrequest budget for something one `IN` clause answers.
 * Keys absent from the table are absent from the map; callers apply their own defaults, which is
 * what lets an unset key keep meaning "the default".
 */
export async function getSettings(keys: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (keys.length === 0) return out;
  const rows = await sql().all<{ key: string; value: string | null }>(
    `SELECT key, value FROM settings WHERE key IN (${placeholders(keys.length)})`,
    keys,
  );
  for (const row of rows) out.set(row.key, row.value);
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sql().run(SETTING.set, [key, value]);
}

/**
 * Write a setting **only if the key is not already there** — the loser of a race keeps the winner's
 * value instead of overwriting it.
 *
 * Exists for one caller: minting the member cookie secret (`access.ts`). Two Workers isolates
 * starting together both read "no secret yet" and both mint one; with `setSetting` the second write
 * wins the row and every cookie the first isolate had already signed becomes unverifiable. With
 * this, the first write wins, and a re-read after the insert tells the loser what it must use.
 */
/** Remove a setting, so that it reads as never set (and an insert-if-absent can claim it again). */
export async function deleteSetting(key: string): Promise<void> {
  await sql().run(`DELETE FROM settings WHERE key = ?`, [key]);
}

export async function setSettingIfAbsent(key: string, value: string): Promise<void> {
  await sql().run(SETTING.setIfAbsent, [key, value]);
}

export async function isAutoSendEnabled(): Promise<boolean> {
  return (await getSetting('auto_send_enabled')) !== '0';
}

// ---------------------------------------------------------------------------
// Send log
// ---------------------------------------------------------------------------

export interface SendLogRow {
  id: number;
  sent_at: string;
  title: string;
  body: string | null;
  recipient_count: number;
  type: string;
}

const SEND_LOG = {
  insert: `
    INSERT INTO send_log (title, body, recipient_count, type)
    VALUES (?, ?, ?, ?)
  `,
  recent: `SELECT * FROM send_log ORDER BY sent_at DESC, id DESC LIMIT ?`,
  manualSince: `SELECT COUNT(*) AS n FROM send_log WHERE type = 'manual' AND sent_at > datetime('now', ?)`,
};

/** Manual sends in the last `minutes`, for the dashboard's send cap. */
export async function countRecentManualSends(minutes: number): Promise<number> {
  return (await sql().first<{ n: number }>(SEND_LOG.manualSince, [`-${minutes} minutes`]))?.n ?? 0;
}

export async function recentSends(limit = 10): Promise<SendLogRow[]> {
  return sql().all<SendLogRow>(SEND_LOG.recent, [limit]);
}

/** A send with its delivery tally, when it went through the queue (older sends have none). */
export interface SendHistoryRow extends SendLogRow {
  batch_total: number | null;
  batch_sent: number | null;
  batch_failed: number | null;
  batch_removed: number | null;
  batch_status: string | null;
}

/**
 * The dashboard's Recent Sends: `recentSends` plus each send's `send_batches` tally, in one query
 * rather than one per row — on D1 every query is a round trip.
 */
export async function recentSendHistory(limit = 10): Promise<SendHistoryRow[]> {
  return sql().all<SendHistoryRow>(
    `SELECT l.*, b.total AS batch_total, b.sent AS batch_sent, b.failed AS batch_failed,
            b.removed AS batch_removed, b.status AS batch_status
     FROM send_log l LEFT JOIN send_batches b ON b.send_log_id = l.id
     ORDER BY l.sent_at DESC, l.id DESC LIMIT ?`,
    [limit],
  );
}

// ---------------------------------------------------------------------------
// Skipped Sundays
// ---------------------------------------------------------------------------

export interface SendSkipRow {
  skip_date: string;
  note: string | null;
  created_at: string;
}

const SKIPS = {
  byDate: `SELECT * FROM send_skips WHERE skip_date = ?`,
  fromDate: `SELECT * FROM send_skips WHERE skip_date >= ? ORDER BY skip_date ASC`,
  insert: `INSERT OR REPLACE INTO send_skips (skip_date, note) VALUES (?, ?)`,
  remove: `DELETE FROM send_skips WHERE skip_date = ?`,
  prune: `DELETE FROM send_skips WHERE skip_date < ?`,
};

/** The skip covering a date, if the admin marked one. */
export async function skipForDate(date: string): Promise<SendSkipRow | undefined> {
  return sql().first<SendSkipRow>(SKIPS.byDate, [date]);
}

/** Skips from `date` onward, soonest first — what the dashboard lists. */
export async function listSkipsFrom(date: string): Promise<SendSkipRow[]> {
  return sql().all<SendSkipRow>(SKIPS.fromDate, [date]);
}

/** Add or re-note a skip. `INSERT OR REPLACE` so saving the same date twice is an edit, not an error. */
export async function addSkip(date: string, note: string | null): Promise<void> {
  await sql().run(SKIPS.insert, [date, note]);
}

export async function removeSkip(date: string): Promise<void> {
  await sql().run(SKIPS.remove, [date]);
}

/**
 * Drop skips that are safely in the past.
 *
 * Not for tidiness: a skip that has fired has already written its history row, and leaving it
 * would only grow the table by a handful of rows a year. It runs on the same daily clock as the
 * program purge, with a wide margin, because the one thing that must never happen is pruning a
 * skip *before* the occurrence it covers has been decided — a restart inside the twelve-hour
 * catch-up grace would then deliver the digest the skip existed to suppress.
 */
export async function pruneSkipsBefore(date: string): Promise<void> {
  await sql().run(SKIPS.prune, [date]);
}

// ---------------------------------------------------------------------------
// The send queue
// ---------------------------------------------------------------------------
//
// A send is enqueued once and drained in chunks (see `push.ts`). Everything in this section is
// deliberately plain SQL over the two tables above: no interactive transactions, because D1 has
// none, and no per-subscriber INSERT loop, because one `INSERT … SELECT` covers the whole fan-out.

export interface SendBatchRow {
  send_log_id: number;
  url: string;
  slot: string | null;
  total: number;
  sent: number;
  failed: number;
  removed: number;
  status: string;
  created_at: string;
  finished_at: string | null;
}

/** One outstanding delivery. `endpoint` is null when the subscription has since been deleted. */
export interface SendQueueItem {
  queue_id: number;
  send_log_id: number;
  subscription_id: number;
  /** Attempts *including* the claim that produced this item — see `claimSendChunk`. */
  attempts: number;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
}

/**
 * How long a claim holds a row before another drain may take it.
 *
 * Long enough that a drain in progress is never stolen from (a chunk is twelve deliveries with a
 * 10-second timeout each, worst case two minutes), short enough that rows orphaned by a killed
 * isolate are picked up on a following cron tick rather than sitting until someone notices.
 */
const CLAIM_LEASE = '-5 minutes';

/**
 * What re-taking a row whose last claim died costs, in attempts (the budget is MAX_ATTEMPTS, 8, in
 * push.ts). A chunk's bookkeeping commits only once all its deliveries are done, so a drain killed
 * mid-chunk — a free-plan Worker over its CPU allowance — may already have delivered some of its
 * rows. Re-taking them at one attempt each meant up to eight copies of the same notification, every
 * five minutes. At four, a row that keeps dying gets one more delivery (in case the kill came before
 * it was sent) and is then given up on: at most two copies, never eight.
 */
const ORPHAN_CLAIM_COST = 4;

/**
 * How long a retried row waits before it may be claimed again: `min(60, 2^attempts)` minutes,
 * computed in SQL from the row's own counter so it needs no round trip and no clock in JS.
 *
 * Without it a retry was reclaimable at once, and on Workers "at once" meant the next minute's
 * tick — so a push service that was down for three consecutive minutes spent every attempt a row
 * had and the week's digest was marked failed, even though the message's 24-hour TTL would have
 * carried it had the POST ever landed. Doubling from two minutes and capping at an hour, the eight
 * attempts in `push.ts` span about three hours: long enough to ride out a real outage, short enough
 * that a Sunday-morning notification still arrives on Sunday morning.
 *
 * `printf` rather than `format`: both are SQLite, but `printf` is the older name and the one every
 * D1 and better-sqlite3 build has.
 */
const RETRY_BACKOFF = `datetime('now', printf('+%d minutes', min(60, 1 << attempts)))`;

const QUEUE = {
  batchBySlot: `SELECT * FROM send_batches WHERE slot = ?`,
  // A scheduled digest that actually went out on a local date, at any time of day. Slots are
  // `YYYY-MM-DDTHH:MM`, so the date is a prefix; a skip (`send_log.type = 'skipped'`) doesn't count.
  sentOnDate: `
    SELECT b.* FROM send_batches b JOIN send_log l ON l.id = b.send_log_id
    WHERE b.slot LIKE ? AND l.type = 'scheduled'
    LIMIT 1
  `,
  batchById: `SELECT * FROM send_batches WHERE send_log_id = ?`,
  insertBatch: `INSERT INTO send_batches (send_log_id, url, slot, total) VALUES (?, ?, ?, ?)`,
  // A skip: no recipients, and born finished so no drain or sweep ever adopts it.
  insertSkippedBatch: `
    INSERT INTO send_batches (send_log_id, url, slot, total, status, finished_at)
    VALUES (?, ?, ?, 0, 'done', datetime('now'))
  `,
  fanOut: `INSERT INTO send_queue (send_log_id, subscription_id) SELECT ?, id FROM subscriptions`,
  deleteLog: `DELETE FROM send_log WHERE id = ?`,
  // Take the lease. One UPDATE, so two concurrent drains cannot both win the same rows: SQLite and
  // D1 both serialise the statement, and the loser's `WHERE claimed_at IS NULL` no longer matches.
  // `attempts` climbs here rather than at commit time — a drain that dies before committing has
  // still spent an attempt, which is what bounds a row against a crash that repeats. A row still
  // holding a claim is one whose lease ran out (a retry clears its claim at commit): that costs
  // ORPHAN_CLAIM_COST, because it may have been delivered already.
  claimTake: `
    UPDATE send_queue
    SET claimed_at = datetime('now'), claim_token = ?,
        attempts = attempts + CASE WHEN claimed_at IS NULL THEN 1 ELSE ${ORPHAN_CLAIM_COST} END
    WHERE id IN (
      SELECT id FROM send_queue
      WHERE (claimed_at IS NULL OR claimed_at < datetime('now', '${CLAIM_LEASE}'))
        AND (not_before IS NULL OR not_before <= datetime('now'))
      ORDER BY id
      LIMIT ?
    )
  `,
  // Read back exactly what this drain took. LEFT JOIN, not JOIN: a subscription pruned mid-send
  // would otherwise leave rows the query can never see, and a queue that never empties never
  // finalises its send.
  claimRead: `
    SELECT q.id AS queue_id, q.send_log_id, q.subscription_id, q.attempts,
           s.endpoint, s.p256dh, s.auth
    FROM send_queue q
    LEFT JOIN subscriptions s ON s.id = q.subscription_id
    WHERE q.claim_token = ?
    ORDER BY q.id
  `,
  depth: `SELECT COUNT(*) AS n FROM send_queue`,
  // Rows a claim could take right now: not leased, and not sitting out a retry backoff.
  ready: `
    SELECT COUNT(*) AS n FROM send_queue
    WHERE (claimed_at IS NULL OR claimed_at < datetime('now', '${CLAIM_LEASE}'))
      AND (not_before IS NULL OR not_before <= datetime('now'))
  `,
  // When the earliest row becomes claimable: now for one that already is, the end of its lease for
  // one a drain holds, the end of its backoff for one waiting to retry. UTC, SQLite's text format.
  // A lease ends one second after `claimed_at + CLAIM_LEASE`, because the claim's test is strict.
  nextClaimable: `
    SELECT MIN(CASE
      WHEN claimed_at IS NOT NULL AND claimed_at >= datetime('now', '${CLAIM_LEASE}')
        THEN datetime(claimed_at, '${CLAIM_LEASE.replace('-', '+')}', '+1 second')
      WHEN not_before IS NOT NULL AND not_before > datetime('now') THEN not_before
      ELSE datetime('now')
    END) AS at FROM send_queue
  `,
  depthForSend: `SELECT COUNT(*) AS n FROM send_queue WHERE send_log_id = ?`,
  addCounts: `
    UPDATE send_batches
    SET sent = sent + ?, failed = failed + ?, removed = removed + ?
    WHERE send_log_id = ?
  `,
  finalize: `
    UPDATE send_batches SET status = 'done', finished_at = datetime('now') WHERE send_log_id = ?
  `,
  setRecipients: `UPDATE send_log SET recipient_count = ? WHERE id = ?`,
  message: `
    SELECT l.title AS title, l.body AS body, b.url AS url
    FROM send_log l JOIN send_batches b ON b.send_log_id = l.id
    WHERE l.id = ?
  `,
  exhausted: `SELECT id, endpoint FROM subscriptions WHERE failure_count >= ? ORDER BY id LIMIT ?`,
  deleteForSubscription: `DELETE FROM send_queue WHERE subscription_id = ?`,
  deleteForSend: `DELETE FROM send_queue WHERE send_log_id = ?`,
  // A send whose queue has emptied but which never got settled — the hole a kill between the last
  // commit and `settle()` leaves. Left alone it shows "pending" forever with a recipient count of
  // zero, so the cron tick sweeps for one when it has nothing else to do.
  stalePending: `
    SELECT * FROM send_batches b
    WHERE b.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM send_queue q WHERE q.send_log_id = b.send_log_id)
    ORDER BY b.send_log_id
    LIMIT 1
  `,
};

/**
 * The most ids one `IN (…)` list may bind, leaving room for a statement's other parameters under
 * D1's and Durable Object SQLite's cap of 100. A longer list has to be split (see
 * `listAttachmentsForOwners`); `placeholders` refuses one, so the mistake shows on Node too.
 */
const IN_LIST_CHUNK = 90;

/** Placeholder list for an `IN (?, ?, …)` clause — D1 binds by position, so it has to be built. */
function placeholders(n: number): string {
  if (n > IN_LIST_CHUNK) throw new Error(`${n} bound values in one IN list; D1 allows 100 per statement`);
  return new Array(n).fill('?').join(', ');
}

/**
 * Create a send and fan it out to every current subscriber, as one unit of work.
 *
 * Returns null when `slot` names a scheduled occurrence that was already enqueued — the guard
 * against a cron trigger firing the same minute twice.
 *
 * Two steps rather than one batch because the fan-out needs the `send_log` id, and a batch cannot
 * read anything mid-flight (see `SqlDriver.batch`). If the second step fails, the orphaned log row
 * is removed so a half-created send never shows up in the history.
 */
export async function enqueueSend(input: {
  title: string;
  body: string | null;
  url: string;
  type: 'manual' | 'scheduled';
  slot?: string | null;
}): Promise<{ sendLogId: number; total: number } | null> {
  const slot = input.slot ?? null;
  if (slot && (await sql().first<SendBatchRow>(QUEUE.batchBySlot, [slot]))) return null;

  const total = await countSubscriptions();
  const info = await sql().run(SEND_LOG.insert, [input.title, input.body, 0, input.type]);
  const sendLogId = info.lastRowId;
  try {
    await sql().batch([
      { sql: QUEUE.insertBatch, params: [sendLogId, input.url, slot, total] },
      { sql: QUEUE.fanOut, params: [sendLogId] },
    ]);
  } catch (err) {
    await sql().run(QUEUE.deleteLog, [sendLogId]);
    // A duplicate slot means another tick won the race; that is the guard working, not a failure.
    if (slot && (await sql().first<SendBatchRow>(QUEUE.batchBySlot, [slot]))) return null;
    throw err;
  }
  return { sendLogId, total };
}

/**
 * Record a weekly send that deliberately did not happen.
 *
 * Written as a **real send** — a `send_log` row typed `skipped` and a `send_batches` row carrying
 * the slot — rather than as a flag somewhere, and that is the whole design. The history card renders
 * it with no special fetch, and the slot becomes covered by the same `UNIQUE` index that stops a
 * double-fired cron from sending twice, so every "has this occurrence been dealt with?" check
 * already in the codebase answers correctly with no new question to ask. A skip is a decision about
 * an occurrence, which is exactly what a `send_batches` row is.
 *
 * The batch is born `done` with no queue rows, so the drain never sees it and the stale-`pending`
 * sweep never adopts it.
 *
 * Returns null when the slot is already spoken for — the same "another tick won the race" answer
 * `enqueueSend` gives, and for the same reason.
 */
export async function recordSkippedSend(input: {
  slot: string;
  reason: string;
  url: string;
}): Promise<{ sendLogId: number } | null> {
  if (await sql().first<SendBatchRow>(QUEUE.batchBySlot, [input.slot])) return null;

  const info = await sql().run(SEND_LOG.insert, [input.reason, null, 0, 'skipped']);
  const sendLogId = info.lastRowId;
  try {
    await sql().run(QUEUE.insertSkippedBatch, [sendLogId, input.url, input.slot]);
  } catch (err) {
    await sql().run(QUEUE.deleteLog, [sendLogId]);
    if (await sql().first<SendBatchRow>(QUEUE.batchBySlot, [input.slot])) return null;
    throw err;
  }
  return { sendLogId };
}

/** The message an enqueued send is delivering (title/body from the log, url from the batch). */
export async function sendMessage(
  sendLogId: number,
): Promise<{ title: string; body: string | null; url: string } | undefined> {
  return sql().first<{ title: string; body: string | null; url: string }>(QUEUE.message, [
    sendLogId,
  ]);
}

/** A token unique to one drain. Hex, so it is safe in any log line and any column. */
function claimToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Take up to `limit` deliveries, oldest first, and return exactly the ones this call won.
 *
 * Two statements rather than a `RETURNING` clause, because the returned rows have to be joined
 * against `subscriptions` and D1's `RETURNING` support is not something to build a send on. The
 * UPDATE is the point of serialisation: whichever drain runs it first owns those rows for
 * `CLAIM_LEASE`, and the read is filtered by that drain's own token, so an overlapping tick can
 * neither see nor deliver them.
 *
 * Rows whose lease has expired are fair game again — that is the recovery path for a chunk whose
 * isolate was killed part way through. Their `attempts` has already been spent by the claim that
 * died, so such a row cannot cycle forever: see `MAX_ATTEMPTS` in `push.ts`.
 */
export async function claimSendChunk(limit: number): Promise<SendQueueItem[]> {
  const token = claimToken();
  const taken = await sql().run(QUEUE.claimTake, [token, limit]);
  if (taken.changes === 0) return [];
  return sql().all<SendQueueItem>(QUEUE.claimRead, [token]);
}

/** Rows still waiting, across every send. Cheap enough to call on every cron tick. */
export async function sendQueueDepth(): Promise<number> {
  const row = await sql().first<{ n: number }>(QUEUE.depth, []);
  return row?.n ?? 0;
}

/**
 * Rows a drain could claim this instant — the depth minus anything leased or backing off. What
 * the Node drain loop and the Workers tick ask before spending a claim, so a queue that is entirely
 * waiting out a retry neither spins nor crowds out the tick's other duties.
 */
export async function sendQueueReady(): Promise<number> {
  const row = await sql().first<{ n: number }>(QUEUE.ready, []);
  return row?.n ?? 0;
}

export async function sendQueueDepthFor(sendLogId: number): Promise<number> {
  const row = await sql().first<{ n: number }>(QUEUE.depthForSend, [sendLogId]);
  return row?.n ?? 0;
}

export async function getSendBatch(sendLogId: number): Promise<SendBatchRow | undefined> {
  return sql().first<SendBatchRow>(QUEUE.batchById, [sendLogId]);
}

/** The `send_batches` row covering a scheduled occurrence, if that slot has already been sent. */
export async function getSendBatchBySlot(slot: string): Promise<SendBatchRow | undefined> {
  return sql().first<SendBatchRow>(QUEUE.batchBySlot, [slot]);
}

/** The scheduled digest sent on a local date (`YYYY-MM-DD`), whatever its time, if there was one. */
export async function scheduledSendOnDate(date: string): Promise<SendBatchRow | undefined> {
  return sql().first<SendBatchRow>(QUEUE.sentOnDate, [`${date}T%`]);
}

/**
 * A send whose queue is empty but which was never settled, if there is one.
 *
 * Normally impossible — the drain settles a send the moment its last row goes — but a Worker
 * killed between the final `commitSendChunk` and `settle()` leaves exactly this. One per call, so
 * the sweep that uses it costs a bounded amount of a cron tick.
 */
export async function stalePendingBatch(): Promise<SendBatchRow | undefined> {
  return sql().first<SendBatchRow>(QUEUE.stalePending);
}

/**
 * When the send queue next has something a drain could take: now, the end of a lease, or the end of
 * a retry backoff — or null for an empty queue. What a ward's alarm is set from (`tick.ts`).
 */
export async function nextClaimableAt(): Promise<Date | null> {
  const row = await sql().first<{ at: string | null }>(QUEUE.nextClaimable);
  return row?.at ? new Date(`${row.at.replace(' ', 'T')}Z`) : null;
}

/** Abandon a send: drop every delivery still queued for it. */
export async function dropQueueForSend(sendLogId: number): Promise<void> {
  await sql().run(QUEUE.deleteForSend, [sendLogId]);
}

/**
 * Record what one chunk did: the running totals, the rows that are finished with (delivered, dead,
 * or given up on) and the rows to try again. One atomic batch, so a crash between the counter
 * update and the row deletion cannot double-count a delivery.
 *
 * A retried row has its lease released rather than its `attempts` bumped — the claim already spent
 * the attempt — and its `not_before` pushed out by `RETRY_BACKOFF`, so the next drain to see it is
 * the first one after that wait rather than the next one to run.
 */
export interface ChunkCommit {
  sendLogId: number;
  sent: number;
  failed: number;
  removed: number;
  /** Queue rows this chunk is finished with, whatever the outcome. */
  done: number[];
  /** Queue rows to hand back for another claim. */
  retry: number[];
  /** Endpoints delivered to: stamp `last_success_at` and zero the failure counter. */
  succeeded?: string[];
  /** Endpoints that failed in a way no retry fixes: bump the failure counter. */
  failures?: string[];
  /** Subscriptions the push service reported gone (404/410): delete them, queue rows and all. */
  gone?: { endpoint: string; id: number }[];
}

export async function commitSendChunk(input: ChunkCommit): Promise<void> {
  const writes: { sql: string; params?: SqlValue[] }[] = [];
  if (input.sent || input.failed || input.removed) {
    writes.push({
      sql: QUEUE.addCounts,
      params: [input.sent, input.failed, input.removed, input.sendLogId],
    });
  }
  // The per-subscriber bookkeeping rides along in this batch rather than costing a query each.
  // That is a correctness gain — a crash cannot leave a counter bumped for a row that was never
  // deleted — but the deciding reason is arithmetic: on Workers each separate query is a
  // subrequest, so a twelve-subscriber chunk would spend twelve to twenty-four of an allowance of
  // fifty. A D1 `batch()` is one, whatever it holds.
  const succeeded = input.succeeded ?? [];
  if (succeeded.length > 0) {
    writes.push({
      sql: `UPDATE subscriptions SET last_success_at = datetime('now'), failure_count = 0
            WHERE endpoint IN (${placeholders(succeeded.length)})`,
      params: succeeded,
    });
  }
  const failures = input.failures ?? [];
  if (failures.length > 0) {
    writes.push({
      sql: `UPDATE subscriptions SET failure_count = failure_count + 1
            WHERE endpoint IN (${placeholders(failures.length)})`,
      params: failures,
    });
  }
  const gone = input.gone ?? [];
  if (gone.length > 0) {
    writes.push({
      sql: `DELETE FROM subscriptions WHERE endpoint IN (${placeholders(gone.length)})`,
      params: gone.map((g) => g.endpoint),
    });
    // Not just this send's rows: a subscription the push service has retired is gone for every
    // send it is queued against, and a row pointing at a deleted subscription is what keeps a queue
    // from ever emptying.
    writes.push({
      sql: `DELETE FROM send_queue WHERE subscription_id IN (${placeholders(gone.length)})`,
      params: gone.map((g) => g.id),
    });
  }
  if (input.done.length > 0) {
    writes.push({
      sql: `DELETE FROM send_queue WHERE id IN (${placeholders(input.done.length)})`,
      params: input.done,
    });
  }
  if (input.retry.length > 0) {
    writes.push({
      sql: `UPDATE send_queue
            SET claimed_at = NULL, claim_token = NULL, not_before = ${RETRY_BACKOFF}
            WHERE id IN (${placeholders(input.retry.length)})`,
      params: input.retry,
    });
  }
  await sql().batch(writes);
}

/** Drop every outstanding delivery for a subscription that has just been deleted. */
export async function dropQueuedForSubscription(subscriptionId: number): Promise<void> {
  await sql().run(QUEUE.deleteForSubscription, [subscriptionId]);
}

/**
 * Subscriptions whose consecutive-failure count has crossed the pruning threshold, at most `limit`
 * of them. The cap is what keeps settling a send bounded: a deployment that came back from a long
 * outage could otherwise have hundreds to prune inside one invocation.
 */
export async function exhaustedSubscriptions(
  maxFailures: number,
  limit: number,
): Promise<{ id: number; endpoint: string }[]> {
  return sql().all<{ id: number; endpoint: string }>(QUEUE.exhausted, [maxFailures, limit]);
}

/**
 * Delete a set of subscriptions and everything still queued for them, as one atomic batch.
 *
 * Two statements whatever the count, rather than two per subscriber. Atomic because the halves are one fact: a deleted subscription with live queue rows is a
 * send that can never finish.
 */
export async function pruneSubscriptions(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const list = placeholders(ids.length);
  await sql().batch([
    { sql: `DELETE FROM send_queue WHERE subscription_id IN (${list})`, params: ids },
    { sql: `DELETE FROM subscriptions WHERE id IN (${list})`, params: ids },
  ]);
}

/**
 * Close a send out: write the delivered count onto its `send_log` row (the one and only time that
 * column is written, so the history reads exactly as it always has) and mark the batch done.
 */
export async function finalizeSend(sendLogId: number): Promise<SendBatchRow | undefined> {
  const batch = await getSendBatch(sendLogId);
  if (!batch || batch.status === 'done') return batch;
  await sql().batch([
    { sql: QUEUE.setRecipients, params: [batch.sent, sendLogId] },
    { sql: QUEUE.finalize, params: [sendLogId] },
  ]);
  return { ...batch, status: 'done' };
}

// ---------------------------------------------------------------------------
// Member access: shared codes + self-expiring tokens
// ---------------------------------------------------------------------------

export interface AccessCodeRow {
  id: number;
  code: string;
  created_at: string;
  retired_at: string | null;
  expires_at: string | null;
}

export type AccessTokenKind = 'invite' | 'device' | 'email';

export interface AccessTokenRow {
  id: number;
  token: string;
  kind: AccessTokenKind;
  device_id: string | null;
  created_at: string;
  expires_at: string;
  uses: number;
  last_used_at: string | null;
}

// "Usable" everywhere below means: not past its expiry. A retired code stays usable through its
// grace window; only `active` (retired_at IS NULL) is handed out in new links and QR codes.
const CODE = {
  active: `SELECT * FROM access_codes WHERE retired_at IS NULL LIMIT 1`,
  usable: `
    SELECT * FROM access_codes
    WHERE expires_at IS NULL OR expires_at > datetime('now')
    ORDER BY retired_at IS NULL DESC, created_at DESC
  `,
  all: `SELECT * FROM access_codes ORDER BY retired_at IS NULL DESC, created_at DESC`,
  insert: `INSERT INTO access_codes (code) VALUES (?)`,
  retire: `
    UPDATE access_codes
    SET retired_at = datetime('now'), expires_at = ?
    WHERE retired_at IS NULL
  `,
  // Every older retired code still in its grace window is brought down to the new grace too. Without
  // this an "Indefinitely" chosen once could never be undone from the dashboard: `retire` only ever
  // touches the active row, so a later "Stop it immediately" left the earlier code open for good.
  capRetired: `
    UPDATE access_codes
    SET expires_at = ?
    WHERE retired_at IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)
  `,
  // The first code, minted only if none is active: one statement, so two isolates booting a fresh
  // database together cannot both mint one.
  insertIfNone: `
    INSERT INTO access_codes (code)
    SELECT ? WHERE NOT EXISTS (SELECT 1 FROM access_codes WHERE retired_at IS NULL)
  `,
};

/** The code currently handed out in share links and QR codes (or null). */
export async function activeAccessCode(): Promise<AccessCodeRow | null> {
  return (await sql().first<AccessCodeRow>(CODE.active)) ?? null;
}

/** Every code that still unlocks the app — the active one plus any retired-but-in-grace ones. */
export async function usableAccessCodes(): Promise<AccessCodeRow[]> {
  return sql().all<AccessCodeRow>(CODE.usable);
}

/** Every code ever issued, current first. Used by the admin dashboard's rotation history. */
export async function listAccessCodes(): Promise<AccessCodeRow[]> {
  return sql().all<AccessCodeRow>(CODE.all);
}

/**
 * Retire the current code (giving it `graceDays` to keep working, or forever when null) and make
 * `code` the new active one. Both halves land atomically so a failure can't leave the gate with no
 * active code — which would lock the ward out.
 *
 * The grace window is resolved to a concrete timestamp *before* the batch opens, so the atomic
 * part is two ordered writes with no reads or branching (see `SqlDriver.batch`). Order is
 * load-bearing: `retire` targets whatever row currently has `retired_at IS NULL`, so it has to run
 * before the insert or it would immediately retire the code being issued.
 *
 * The grace is the ceiling for every retired code, not only this one (`capRetired`): a grace of
 * zero stops everything older at once, and a timed one never extends a code already closer to its
 * end. A grace of "forever" caps nothing — it is no ceiling.
 */
export async function rotateAccessCode(code: string, graceDays: number | null): Promise<void> {
  const expiresAt = graceDays === null ? null : isoDaysFromNow(graceDays);
  await sql().batch([
    { sql: CODE.retire, params: [expiresAt] },
    { sql: CODE.capRetired, params: [expiresAt, expiresAt] },
    { sql: CODE.insert, params: [code] },
  ]);
}

/** Make `code` the active one if there is no active code at all; otherwise do nothing. */
export async function insertAccessCodeIfNone(code: string): Promise<void> {
  await sql().run(CODE.insertIfNone, [code]);
}

const TOKEN = {
  insert: `
    INSERT INTO access_tokens (token, kind, device_id, expires_at)
    VALUES (?, ?, ?, ?)
  `,
  usable: `SELECT * FROM access_tokens WHERE token = ? AND expires_at > datetime('now')`,
  deviceFor: `
    SELECT * FROM access_tokens
    WHERE kind = 'device' AND device_id = ? AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `,
  recordUse: `UPDATE access_tokens SET uses = uses + 1, last_used_at = datetime('now') WHERE id = ?`,
  purge: `DELETE FROM access_tokens WHERE expires_at <= datetime('now', '-30 days')`,
  countInvites: `
    SELECT COUNT(*) AS n FROM access_tokens
    WHERE kind = 'invite' AND expires_at > datetime('now')
  `,
  newestOfKind: `
    SELECT * FROM access_tokens
    WHERE kind = ? AND expires_at > datetime('now')
    ORDER BY expires_at DESC, id DESC LIMIT 1
  `,
  invitesForDevice: `
    SELECT * FROM access_tokens
    WHERE kind = 'invite' AND device_id = ? AND expires_at > datetime('now')
    ORDER BY created_at DESC, id DESC
  `,
};

/**
 * `days` from now as a SQLite-comparable UTC timestamp ('YYYY-MM-DD HH:MM:SS').
 *
 * Clamped to a century: `Date` can only represent ±275,760 years, and `toISOString()` throws
 * `RangeError` past that. Nothing here should ever ask for more, but this is the one choke point
 * every expiry flows through, so it fails soft rather than 500-ing a request.
 */
const MAX_TTL_DAYS = 36500;

function isoDaysFromNow(days: number): string {
  const safe = Number.isFinite(days) ? Math.min(Math.max(days, 0), MAX_TTL_DAYS) : 0;
  const at = new Date(Date.now() + safe * 24 * 60 * 60 * 1000);
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

export async function createAccessToken(input: {
  token: string;
  kind: AccessTokenKind;
  deviceId?: string | null;
  ttlDays: number;
}): Promise<void> {
  await sql().run(TOKEN.insert, [
    input.token,
    input.kind,
    input.deviceId ?? null,
    isoDaysFromNow(input.ttlDays),
  ]);
}

/** Look up an unexpired token. Returns undefined for unknown *or* expired tokens alike. */
export async function findAccessToken(token: string): Promise<AccessTokenRow | undefined> {
  return sql().first<AccessTokenRow>(TOKEN.usable, [token]);
}

/** The live device token for an installed app, so repeat manifest fetches reuse one row. */
export async function findDeviceToken(deviceId: string): Promise<AccessTokenRow | undefined> {
  return sql().first<AccessTokenRow>(TOKEN.deviceFor, [deviceId]);
}

export async function recordAccessTokenUse(id: number): Promise<void> {
  await sql().run(TOKEN.recordUse, [id]);
}

/** Number of member invites currently outstanding (shown in the admin dashboard). */
export async function countLiveInvites(): Promise<number> {
  const row = await sql().first<{ n: number }>(TOKEN.countInvites);
  return row?.n ?? 0;
}

/**
 * The live invites one device has outstanding, newest first.
 *
 * Newest first because the cap in `access.ts` hands the newest one back rather than minting a sixth
 * — so a member who taps "share" again gets a working link instead of an error. Covered by
 * `idx_access_tokens_device`, and bounded by that same cap, so it is one cheap indexed read.
 */
export async function liveInvitesForDevice(deviceId: string): Promise<AccessTokenRow[]> {
  return sql().all<AccessTokenRow>(TOKEN.invitesForDevice, [deviceId]);
}

/** The live token of one kind with the most life left, if any. */
export async function newestLiveAccessToken(
  kind: AccessTokenKind,
): Promise<AccessTokenRow | undefined> {
  return sql().first<AccessTokenRow>(TOKEN.newestOfKind, [kind]);
}

/**
 * Delete every saved member credential — device tokens, invite links, email links — so the only way
 * back in is the current code. Issue a New Code's "Everyone, including installed apps".
 */
export async function deleteAllAccessTokens(): Promise<void> {
  await sql().run(`DELETE FROM access_tokens`);
}

/**
 * Housekeeping: drop tokens of every kind that expired over a month ago. An expired row already
 * unlocks nothing (`usable` filters on the expiry), so this is tidying, not enforcement. Called on
 * boot and from the once-a-day sweep (`maybePurgeOldPrograms`).
 */
export async function purgeExpiredAccessTokens(): Promise<void> {
  await sql().run(TOKEN.purge);
}

// ---------------------------------------------------------------------------
// Spent WebAuthn challenges
// ---------------------------------------------------------------------------

/**
 * Record a challenge as answered. False when it already was — the one insert is the whole check,
 * so two answers racing on two isolates cannot both pass: the conflict lands on exactly one of
 * them, and every driver reports the row count the insert made (D1's `meta.changes`, the Durable
 * Object's `changes()`, better-sqlite3's `info.changes`). `expiresAt` is when the challenge's
 * cookie would have lapsed anyway, so the sweep knows when the row is no longer guarding anything.
 */
export async function spendChallenge(id: string, expiresAt: string): Promise<boolean> {
  const result = await sql().run(`INSERT INTO spent_challenges (id, expires_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`, [id, expiresAt]);
  return result.changes === 1;
}

/** Drop spent-challenge rows whose challenge could no longer be answered anyway. */
export async function purgeSpentChallenges(before: string): Promise<void> {
  await sql().run(`DELETE FROM spent_challenges WHERE expires_at < ?`, [before]);
}

// ---------------------------------------------------------------------------
// Send-history retention
// ---------------------------------------------------------------------------

/**
 * Delete the send history older than `before` (`send_log.sent_at`, UTC 'YYYY-MM-DD HH:MM:SS' as
 * `datetime('now')` writes it): each `send_log` row and the `send_batches` row that belongs to it.
 * A send that still has `send_queue` rows is left alone whatever its age — the drain and
 * `settleSend` need both rows to close it out, and deleting them under a live queue would strand
 * the queue rows and lose the tally. One batch, so a log row and its batch row go together.
 */
export async function purgeSendHistoryBefore(before: string): Promise<void> {
  const old = `SELECT id FROM send_log WHERE sent_at < ? AND NOT EXISTS (SELECT 1 FROM send_queue q WHERE q.send_log_id = send_log.id)`;
  await sql().batch([
    { sql: `DELETE FROM send_batches WHERE send_log_id IN (${old})`, params: [before] },
    { sql: `DELETE FROM send_log WHERE id IN (${old})`, params: [before] },
  ]);
}

// ---------------------------------------------------------------------------
// First-run seed: a couple of sample announcements + default settings.
// ---------------------------------------------------------------------------

/**
 * Seeded exactly once, guarded by a marker rather than by the announcement count alone.
 *
 * The count was enough on Node, which seeds once at boot. On Workers every cold isolate runs this,
 * and two starting together would both read a count of zero and both insert the samples — so the
 * marker goes in *first*, narrowing the race to the width of a single write, and the common path is
 * one settings read that finds it and returns.
 */
/** The sample a new ward starts with; the dashboard's first-run checklist looks past it. */
export const SAMPLE_ANNOUNCEMENT_TITLE = 'Welcome 👋';

export async function seedIfEmpty(): Promise<void> {
  if ((await getSetting('seeded')) === '1') return;
  await setSetting('seeded', '1');
  if ((await getSetting('auto_send_enabled')) === null) {
    await setSetting('auto_send_enabled', '1');
  }
  const row = await sql().first<{ n: number }>(ANN.count);
  if ((row?.n ?? 0) > 0) return;
  // One sample, so a new ward's page is not empty on its first visit. Written for the clerk who
  // will delete it — what an announcement can hold, in the words of the editor's own toolbar.
  await createAnnouncement({
    title: SAMPLE_ANNOUNCEMENT_TITLE,
    body:
      'This is a sample announcement. To change it or add your own, sign in to the dashboard ' +
      '(add **/admin** to this page\'s address).\n\n' +
      'Announcements can have headings, **bold** text, lists, links and pictures, and everyone ' +
      'with the ward\'s link sees them here.',
    published: true,
    expires_at: null,
  });
}

// ---------------------------------------------------------------------------
// Dashboard people, passkeys and invites (src/passkeys.ts)
// ---------------------------------------------------------------------------

export interface AdminUserRow {
  id: number;
  name: string;
  role: 'admin' | 'editor';
  webauthn_id: string;
  session_version: number;
  created_at: string;
}

export interface AdminUserListRow extends AdminUserRow {
  passkeys: number;
  last_used_at: string | null;
  /** Invite links still usable (unexpired, unused): "invite sent, not yet used" on the People list. */
  open_invites: number;
}

export interface AdminPasskeyRow {
  id: string;
  user_id: number;
  public_key: string;
  counter: number;
  transports: string | null;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface AdminInviteRow {
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export async function createAdminUser(input: { name: string; role: 'admin' | 'editor'; webauthnId: string }): Promise<number> {
  const info = await sql().run(`INSERT INTO admin_users (name, role, webauthn_id) VALUES (?, ?, ?)`, [
    input.name,
    input.role,
    input.webauthnId,
  ]);
  return info.lastRowId;
}

export async function getAdminUser(id: number): Promise<AdminUserRow | undefined> {
  return sql().first<AdminUserRow>(`SELECT * FROM admin_users WHERE id = ?`, [id]);
}

/** Everyone, oldest first, with how many passkeys they hold, when one was last used, and open invites. */
export async function listAdminUsers(): Promise<AdminUserListRow[]> {
  return sql().all<AdminUserListRow>(`
    SELECT u.*, COUNT(p.id) AS passkeys, MAX(p.last_used_at) AS last_used_at,
      (SELECT COUNT(*) FROM admin_invites i
        WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > datetime('now')) AS open_invites
    FROM admin_users u LEFT JOIN admin_passkeys p ON p.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at ASC, u.id ASC
  `);
}

export async function updateAdminUser(id: number, input: { name: string; role: 'admin' | 'editor' }): Promise<void> {
  await sql().run(`UPDATE admin_users SET name = ?, role = ? WHERE id = ?`, [input.name, input.role, id]);
}

/** End every session the person holds: their cookies carry the old version. */
export async function bumpAdminSessionVersion(id: number): Promise<void> {
  await sql().run(`UPDATE admin_users SET session_version = session_version + 1 WHERE id = ?`, [id]);
}

/** Remove a person, their passkeys and their invites, in one step. */
export async function deleteAdminUser(id: number): Promise<void> {
  await sql().batch([
    { sql: `DELETE FROM admin_passkeys WHERE user_id = ?`, params: [id] },
    { sql: `DELETE FROM admin_invites WHERE user_id = ?`, params: [id] },
    { sql: `DELETE FROM admin_users WHERE id = ?`, params: [id] },
  ]);
}

export interface NewAdminPasskey {
  id: string;
  userId: number;
  publicKey: string;
  counter: number;
  transports: string[] | undefined;
  label: string;
}

const INSERT_PASSKEY = `INSERT INTO admin_passkeys (id, user_id, public_key, counter, transports, label, last_used_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;
const passkeyParams = (p: NewAdminPasskey, usedNow: boolean) => [
  p.id,
  p.userId,
  p.publicKey,
  p.counter,
  p.transports ? JSON.stringify(p.transports) : null,
  p.label,
  usedNow ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
];

/** A passkey added by a signed-in person on another device: made, not yet used to sign in. */
export async function addAdminPasskey(input: NewAdminPasskey): Promise<void> {
  await sql().run(INSERT_PASSKEY, passkeyParams(input, false));
}

export async function getAdminPasskey(id: string): Promise<AdminPasskeyRow | undefined> {
  return sql().first<AdminPasskeyRow>(`SELECT * FROM admin_passkeys WHERE id = ?`, [id]);
}

export async function listAdminPasskeys(userId: number): Promise<AdminPasskeyRow[]> {
  return sql().all<AdminPasskeyRow>(`SELECT * FROM admin_passkeys WHERE user_id = ? ORDER BY created_at ASC`, [userId]);
}

export async function touchAdminPasskey(id: string, counter: number): Promise<void> {
  await sql().run(`UPDATE admin_passkeys SET counter = ?, last_used_at = datetime('now') WHERE id = ?`, [counter, id]);
}

/**
 * Remove one passkey and end every session the person holds, in one step. A session does not record
 * which passkey began it, so this is the only way to be sure the device that passkey lived on — a
 * lost or stolen phone, usually — is signed out too. Left signed in, it could also enrol a passkey
 * of its own and keep its access for good.
 */
export async function deleteAdminPasskey(userId: number, id: string): Promise<void> {
  await sql().batch([
    { sql: `DELETE FROM admin_passkeys WHERE id = ? AND user_id = ?`, params: [id, userId] },
    { sql: `UPDATE admin_users SET session_version = session_version + 1 WHERE id = ?`, params: [userId] },
  ]);
}

/** A new invite for the person, replacing any they had: only the latest link works. */
export async function createAdminInvite(userId: number, token: string, days: number): Promise<void> {
  await sql().batch([
    { sql: `DELETE FROM admin_invites WHERE user_id = ?`, params: [userId] },
    {
      sql: `INSERT INTO admin_invites (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`,
      params: [token, userId, `+${days} days`],
    },
  ]);
}

/** The invite, if it exists, is unused and has not expired. */
export async function findUsableAdminInvite(token: string): Promise<AdminInviteRow | undefined> {
  return sql().first<AdminInviteRow>(
    `SELECT * FROM admin_invites WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    [token],
  );
}

/** The person's current invite, if one is still usable — what the person page shows. */
export async function currentAdminInvite(userId: number): Promise<AdminInviteRow | undefined> {
  return sql().first<AdminInviteRow>(
    `SELECT * FROM admin_invites WHERE user_id = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    [userId],
  );
}

/**
 * Spend an invite and store the passkey it produced, in one batch. Two registrations racing on the
 * same link in the same instant could both land; the worst that does is give the person a second
 * passkey, which is harmless, so it is not worth a stricter guard.
 */
export async function redeemAdminInvite(token: string, passkey: NewAdminPasskey): Promise<boolean> {
  const invite = await findUsableAdminInvite(token);
  if (!invite || invite.user_id !== passkey.userId) return false;
  await sql().batch([
    { sql: `UPDATE admin_invites SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL`, params: [token] },
    // Counted as a use: redeeming the invite signs them in with it.
    { sql: INSERT_PASSKEY, params: passkeyParams(passkey, true) },
  ]);
  return true;
}
