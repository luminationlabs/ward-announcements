/**
 * The Cloudflare driver: D1.
 *
 * Not exercised yet — the Workers entry that binds a D1 database arrives in a later stage — so this
 * file is deliberately tiny and does nothing clever. It is pure JS with no Node built-ins, so it is
 * safe to bundle for `workerd`.
 *
 * ## Why the parameter is typed structurally
 *
 * `@cloudflare/workers-types` (a devDependency) publishes its types as *ambient globals*. Pulling
 * them into this project's tsconfig would redefine `Buffer`, `fetch`, `Request` and friends
 * project-wide and break every Node-side file, so the handful of D1 methods used here are declared
 * as a structural subset instead. Cloudflare's real `D1Database` satisfies `D1Like` — the later
 * Workers entry can pass its `env.DB` straight in, under a Workers-specific tsconfig that does
 * reference the official types.
 */
import type { RunResult, SqlDriver, SqlValue, SqlWrite } from './sqldriver.js';

/** The subset of Cloudflare's `D1PreparedStatement` this driver uses. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

/** The subset of Cloudflare's `D1Database` this driver uses. */
export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

export function createD1Driver(d1: D1Like): SqlDriver {
  /** Prepare, binding only when there are parameters — `bind()` with no values is pointless. */
  function bound(sql: string, params?: SqlValue[]): D1StatementLike {
    const stmt = d1.prepare(sql);
    return params && params.length > 0 ? stmt.bind(...params) : stmt;
  }

  return {
    async first<T>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
      // D1 says "no row" with null; the seam says undefined, matching better-sqlite3's `get()`.
      return (await bound(sql, params).first<T>()) ?? undefined;
    },
    async all<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
      const result = await bound(sql, params).all<T>();
      return result.results ?? [];
    },
    async run(sql: string, params?: SqlValue[]): Promise<RunResult> {
      const { meta } = await bound(sql, params).run();
      return { changes: meta?.changes ?? 0, lastRowId: Number(meta?.last_row_id ?? 0) };
    },
    async batch(writes: SqlWrite[]): Promise<void> {
      // D1's batch is the only transaction it has: the statements run in order, in one implicit
      // transaction, and a failure rolls the whole thing back.
      if (writes.length === 0) return;
      await d1.batch(writes.map((write) => bound(write.sql, write.params)));
    },
  };
}
