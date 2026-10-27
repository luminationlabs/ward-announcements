/**
 * The Durable Object driver: a ward's own SQLite database, inside its Durable Object.
 *
 * For hosting many wards on one deployment, where each ward is one SQLite
 * Durable Object (`host.ts`). Pure JS with no Node built-ins, like the D1 driver.
 *
 * How this API differs from the other two, and what each difference costs here:
 *
 * - **Synchronous.** `sql.exec()` runs on the object's own thread and returns a cursor. The seam is
 *   async anyway (D1 needs it), so each method just returns a settled promise.
 * - **No `lastRowId` or `changes` on the cursor.** Read them back with SQLite's own `changes()` and
 *   `last_insert_rowid()` straight after the write. Exact, not racy: an object is single-threaded,
 *   and nothing else can run between two synchronous calls.
 * - **No `BEGIN`/`COMMIT` in SQL.** Atomicity is `storage.transactionSync()`, which rolls back if
 *   the callback throws — the same all-or-nothing `batch()` promises (see sqldriver.ts).
 * - **BLOBs are `ArrayBuffer`s** in both directions. `db.ts` stores none (image bytes are base64
 *   text, see filestore-sql.ts), but the seam allows `Uint8Array`, so convert both ways.
 *
 * Typed structurally, like `driver-d1.ts`, so no Workers type package reaches the Node build.
 */
import type { RunResult, SqlDriver, SqlValue, SqlWrite } from './sqldriver.js';

/** The subset of Cloudflare's `SqlStorageCursor` this driver uses. */
export interface SqlCursorLike<T> {
  toArray(): T[];
}

/** The subset of a Durable Object's `ctx.storage` this driver uses. */
export interface DurableStorageLike {
  sql: {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
  };
  transactionSync<T>(fn: () => T): T;
}

function bindable(value: SqlValue): unknown {
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function row<T>(raw: Record<string, unknown>): T {
  for (const key of Object.keys(raw)) {
    if (raw[key] instanceof ArrayBuffer) raw[key] = new Uint8Array(raw[key] as ArrayBuffer);
  }
  return raw as T;
}

export function createDurableObjectDriver(storage: DurableStorageLike): SqlDriver {
  const { sql } = storage;

  function rows<T>(query: string, params: SqlValue[] = []): T[] {
    return sql.exec<Record<string, unknown>>(query, ...params.map(bindable)).toArray().map(row<T>);
  }

  function runOne(query: string, params: SqlValue[] = []): RunResult {
    // `toArray()` drains the cursor, which is what makes sure the statement has finished.
    sql.exec(query, ...params.map(bindable)).toArray();
    const [meta] = sql
      .exec<{ changes: number; id: number }>('SELECT changes() AS changes, last_insert_rowid() AS id')
      .toArray();
    return { changes: Number(meta?.changes ?? 0), lastRowId: Number(meta?.id ?? 0) };
  }

  return {
    async first<T>(query: string, params?: SqlValue[]): Promise<T | undefined> {
      return rows<T>(query, params)[0];
    },
    async all<T>(query: string, params?: SqlValue[]): Promise<T[]> {
      return rows<T>(query, params);
    },
    async run(query: string, params?: SqlValue[]): Promise<RunResult> {
      return runOne(query, params);
    },
    async batch(writes: SqlWrite[]): Promise<void> {
      if (writes.length === 0) return;
      storage.transactionSync(() => {
        for (const write of writes) sql.exec(write.sql, ...(write.params ?? []).map(bindable)).toArray();
      });
    },
  };
}
