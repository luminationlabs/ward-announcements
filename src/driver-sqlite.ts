/**
 * The Node driver: better-sqlite3 against a file on disk.
 *
 * Node-only by construction (it opens a file and imports `node:fs`), so nothing that has to run on
 * Workers may import it — the Node entry (`server.ts`) builds one and hands it to `db.ts`.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunResult, SqlDriver, SqlValue, SqlWrite } from './sqldriver.js';

/**
 * Open (or create) the SQLite file at `path` and wrap it in the driver interface.
 *
 * The pragmas live here rather than in `db.ts` because they describe a SQLite *file* — WAL is
 * meaningless to D1, which rejects both of these outright.
 */
export function createSqliteDriver(path: string): SqlDriver {
  // Ensure the directory for the SQLite file exists (e.g. ./data or /data).
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Preparing is the expensive half of a better-sqlite3 query, and db.ts hands us SQL strings
  // rather than holding statements of its own — so cache them here, keyed by the SQL text. The set of
  // distinct statements is fixed by db.ts (plus one `SELECT * FROM <table>` per table for backups),
  // so this is a bounded cache, not a leak.
  const statements = new Map<string, Database.Statement>();
  function prepare(sql: string): Database.Statement {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  }

  function runOne(sql: string, params: SqlValue[] = []): RunResult {
    const info = prepare(sql).run(...params);
    return { changes: info.changes, lastRowId: Number(info.lastInsertRowid) };
  }

  // better-sqlite3's transaction() is what makes `batch` atomic here. It's synchronous, which is
  // fine: every write in a batch is already built before the batch starts (see sqldriver.ts).
  const runBatch = db.transaction((writes: SqlWrite[]) => {
    for (const write of writes) runOne(write.sql, write.params);
  });

  return {
    async first<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
      return prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      return prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
      return runOne(sql, params);
    },
    async batch(writes: SqlWrite[]): Promise<void> {
      if (writes.length === 0) return;
      runBatch(writes);
    },
  };
}
