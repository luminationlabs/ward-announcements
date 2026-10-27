/**
 * The SQL seam.
 *
 * `db.ts` speaks only this interface, so the same queries run on better-sqlite3 under Node
 * (`driver-sqlite.ts`, what the test suite exercises) and on D1 under Cloudflare Workers
 * (`driver-d1.ts`). Nothing driver-specific may appear in these types — no `Statement`, no
 * `D1Result`, no Node `Buffer` — otherwise one runtime's shape leaks into code the other runs.
 *
 * Two rules the callers have to respect, both forced by D1:
 *
 * - **Positional parameters only.** D1 binds `?` placeholders by position; it has no equivalent of
 *   SQLite's named `@param` binding, so every statement here takes an array.
 * - **No interactive transactions.** `batch()` is the only atomic primitive, and it takes a
 *   *finished* list of writes: nothing may read or branch once it has started. Callers therefore
 *   do all of their reads and decisions in JS first (see `db.ts`'s rotate/reorder).
 */

/** Everything a bound parameter is allowed to be. Deliberately narrow — both drivers accept these. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** What a write did. `lastRowId` is 0 when the statement inserted nothing. */
export interface RunResult {
  changes: number;
  lastRowId: number;
}

/** One statement in a `batch()`. */
export interface SqlWrite {
  sql: string;
  params?: SqlValue[];
}

export interface SqlDriver {
  /** First row, or undefined when the query matched nothing. */
  first<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  /** Every matching row. */
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** A write. */
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  /** Run the given writes atomically, in order. All land or none do. */
  batch(writes: SqlWrite[]): Promise<void>;
}
