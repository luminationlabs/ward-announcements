/**
 * Turning a backup (`/admin/backup.json`, or the `backup.json` inside a full-backup zip) back into
 * rows: validation, and the plan of what to write. Shared by the two things that restore one —
 * `scripts/db-restore.mjs`, which prints the plan as SQL for a single-ward deployment, and the
 * many-ward host's Import Backup (`host.ts`), which runs it inside the ward's Durable Object as one
 * transaction — so they cannot disagree about what a backup means.
 *
 * Pure and dependency-free on purpose: the script imports this file directly (Node strips the
 * types), with no build step between an operator and a restore. Only erasable TypeScript here.
 *
 * What a restore is:
 *
 * - **A replace, not a merge.** Every table the app has is emptied and refilled from the backup,
 *   ids kept — they are load-bearing (`attachments.owner_id` names an announcement, a program or a
 *   page; `admin_passkeys.user_id` a person). A table the backup does not have (it predates it) is
 *   left **empty**, so the result is what the backup's ward was, not a blend of two wards.
 * - **Except `file_chunks`**, the image bytes of a deployment with no R2 bucket. The JSON never
 *   carries them (`dumpDatabase` leaves them out, as R2's objects are left out), so emptying the
 *   table would delete every image of a ward being restored over itself. Images travel separately:
 *   the full-backup zip's `images/` folder.
 * - **And except the target's push keys, when the backup has none.** The VAPID pair travels in a
 *   backup sealed (`seal.ts`, `vapid_keys_sealed`), or not at all; a restorer opens it first
 *   (`unsealBackupTables`), and a pair that did not open never reaches the plan — the sealed row
 *   is dropped here — so a ward restored over itself keeps the pair its subscriptions were made
 *   with (`KEPT_UNLESS_IN_BACKUP`). A backup whose pair did open replaces it.
 * - **Only what this version knows.** A table this app does not have is refused (restoring it would
 *   lose it silently); a column it does not have is dropped and *reported* — `subscriptions.label`
 *   in a backup from before it was removed, say. A backup from a newer schema than this code is
 *   refused: it could hold anything.
 * - **Never trusted as SQL.** Table and column names are matched against the schema, never
 *   interpolated from the file; values are bound (the host) or quoted (the script).
 */

/** A value SQLite stores and the drivers bind. */
export type RestoreValue = string | number | null;

export interface SchemaTable {
  name: string;
  columns: string[];
}

/** One row as it will be written: the columns the target table has, and their values. */
export interface PlannedRow {
  columns: string[];
  values: RestoreValue[];
}

export interface PlannedTable {
  name: string;
  /** Was the table in the backup at all? (An older backup may predate it; it is then emptied.) */
  inBackup: boolean;
  rows: PlannedRow[];
}

export interface RestorePlan {
  /** Every table to replace, in schema order. */
  tables: PlannedTable[];
  /** Columns the backup has that this version's tables do not, per table: dropped, not written. */
  dropped: Record<string, string[]>;
  /** Tables in the backup that a restore never writes (`file_chunks`). */
  ignored: string[];
  /** The backup's `schema_version` setting, or null when it has none (a very old backup). */
  fromVersion: number | null;
  app: string | null;
  exportedAt: string | null;
}

/** A backup that cannot be restored, with a message for the person holding it. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** Tables a restore never touches; see the header. */
export const NEVER_RESTORED = ['file_chunks'];

/**
 * The sealed push pair (`seal.ts`'s `VAPID_KEYS_SEALED_SETTING`, spelled here because this file
 * imports nothing — see the header). A restorer opens it before planning; one that reaches the
 * planner did not open (or the restorer forgot), and a blob nobody here can read must never be
 * written into `settings` as if it were a setting — dropped, the target keeps its own pair.
 */
const SEALED_SETTING = 'vapid_keys_sealed';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONSTRAINT = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i;

/**
 * The column names of one `CREATE TABLE` statement, in order. Enough of a parser for this app's own
 * schema (one column per line, `--` comments, table constraints such as `PRIMARY KEY (key, seq)`),
 * which is all it is ever given; `test/restore.test.js` holds it to `db.ts`'s real tables.
 */
export function columnsOf(createTable: string): string[] {
  const open = createTable.indexOf('(');
  const close = createTable.lastIndexOf(')');
  if (open < 0 || close < open) return [];
  const body = createTable
    .slice(open + 1, close)
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .join(' ');
  // Split on top-level commas only: `DEFAULT (datetime('now'))` has none, but a constraint like
  // `PRIMARY KEY (key, seq)` does.
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter((part) => part && !CONSTRAINT.test(part))
    .map((part) => part.split(/\s+/)[0]!)
    .filter((name) => IDENTIFIER.test(name));
}

/** The tables (with their columns) among a list of schema statements; indexes are skipped. */
export function tablesOf(statements: string[]): SchemaTable[] {
  const tables: SchemaTable[] = [];
  for (const statement of statements) {
    const name = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement)?.[1];
    if (name) tables.push({ name, columns: columnsOf(statement) });
  }
  return tables;
}

/** The backup's own schema version, from its `settings` rows; null when it has none. */
function backupVersion(tables: Record<string, unknown>): number | null {
  const settings = tables.settings;
  if (!Array.isArray(settings)) return null;
  const row = settings.find((r) => r && typeof r === 'object' && (r as Record<string, unknown>).key === 'schema_version') as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 1) {
    throw new RestoreError(`The backup's schema version ("${String(row.value)}") is not a number.`);
  }
  return version;
}

function storable(value: unknown, where: string): RestoreValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RestoreError(`${where}: ${value} is not a storable number.`);
    return value;
  }
  // SQLite has no boolean; the app stores 0/1, and JSON may have round-tripped either.
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value;
  throw new RestoreError(`${where}: cannot store a ${Array.isArray(value) ? 'list' : typeof value}.`);
}

/**
 * Check a parsed backup and plan its restore into `schema` (this version's tables), at most
 * `schemaVersion`. Throws `RestoreError` with a message for a person on anything it will not do.
 */
export function planRestore(backup: unknown, schema: SchemaTable[], schemaVersion: number): RestorePlan {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new RestoreError('This is not a backup: expected the JSON object the Backup button downloads.');
  }
  const top = backup as Record<string, unknown>;
  const tables = top.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    throw new RestoreError('This file has no "tables" — is it a backup from the dashboard’s Backup card?');
  }
  const given = tables as Record<string, unknown>;

  const known = new Map(schema.map((t) => [t.name, t]));
  const unknown = Object.keys(given).filter((name) => !known.has(name));
  if (unknown.length) {
    throw new RestoreError(
      `The backup has table(s) this version does not: ${unknown.join(', ')}. ` +
        'Restoring it here would lose them silently — update this deployment first.',
    );
  }

  const fromVersion = backupVersion(given);
  if (fromVersion !== null && fromVersion > schemaVersion) {
    throw new RestoreError(
      `The backup is from a newer version of the app (schema ${fromVersion}); this deployment is at schema ` +
        `${schemaVersion}. Update this deployment first.`,
    );
  }

  const dropped: Record<string, string[]> = {};
  const ignored: string[] = [];
  const planned: PlannedTable[] = [];
  for (const table of schema) {
    const raw = given[table.name];
    if (NEVER_RESTORED.includes(table.name)) {
      if (raw !== undefined) ignored.push(table.name);
      continue;
    }
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new RestoreError(`"${table.name}" in the backup is not a list of rows.`);
    }
    const target = new Set(table.columns);
    const rows: PlannedRow[] = [];
    const droppedHere = new Set<string>();
    for (const [index, row] of ((raw ?? []) as unknown[]).entries()) {
      const where = `${table.name}[${index}]`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new RestoreError(`${where} is not a row.`);
      if (table.name === 'settings' && (row as Record<string, unknown>).key === SEALED_SETTING) continue;
      const columns: string[] = [];
      const values: RestoreValue[] = [];
      for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
        if (!target.has(column)) {
          droppedHere.add(column);
          continue;
        }
        columns.push(column);
        values.push(storable(value, `${where}.${column}`));
      }
      // Skipping it would make the counts lie about what was written; stopping is better.
      if (columns.length === 0) throw new RestoreError(`${where} has no columns this version knows.`);
      rows.push({ columns, values });
    }
    if (droppedHere.size) dropped[table.name] = [...droppedHere].sort();
    planned.push({ name: table.name, inBackup: raw !== undefined, rows });
  }

  return {
    tables: settleSending(planned, new Date().toISOString()),
    dropped,
    ignored,
    fromVersion,
    app: typeof top.app === 'string' ? top.app : null,
    exportedAt: typeof top.exported_at === 'string' ? top.exported_at : null,
  };
}

/**
 * A backup is a moment in the past, and the sending tables are the one place that shows: restored
 * as they were, they would act on it again.
 *
 * - **`send_queue` is emptied.** A backup taken mid-send holds the deliveries that were still owed
 *   *then*; most went out long ago, and restoring them sends every one a second time.
 * - **A send still `pending` is closed** (`done`), so no drain or sweep adopts it.
 * - **The catch-up floor (`schedule_set_at`) moves to the restore**, exactly as moving the schedule
 *   does. A backup older than this morning's digest has no record of it, so the next tick would
 *   find the slot uncovered inside its twelve-hour grace and send it again.
 */
function settleSending(tables: PlannedTable[], now: string): PlannedTable[] {
  const column = (row: PlannedRow, name: string) => row.columns.indexOf(name);
  return tables.map((table) => {
    if (table.name === 'send_queue') return { ...table, rows: [] };
    if (table.name === 'send_batches') {
      return {
        ...table,
        rows: table.rows.map((row) => {
          const at = column(row, 'status');
          if (at < 0 || row.values[at] === 'done') return row;
          const values = [...row.values];
          values[at] = 'done';
          return { columns: row.columns, values };
        }),
      };
    }
    if (table.name === 'settings') {
      const rows = table.rows.filter((row) => row.values[column(row, 'key')] !== 'schedule_set_at');
      return { ...table, rows: [...rows, { columns: ['key', 'value'], values: ['schedule_set_at', now] }] };
    }
    return table;
  });
}

/**
 * Settings the target keeps when the backup has none of its own. Only the VAPID pair: a backup
 * carries it sealed under the deployment's `BACKUP_SEAL_KEY` or not at all (`/admin/backup.json`
 * — in the clear, beside the subscriber rows, it would let the file's holder push to every
 * member), so a backup from elsewhere, or from a deployment with no seal key, plans with no pair.
 * Emptying `settings` as a whole would then throw away the pair the running deployment's
 * subscriptions are tied to, and the next boot would mint another — every member re-subscribing
 * for a restore that never meant to touch the keys. A backup whose pair opened (the same
 * deployment's, or the operator's export from a host without the key) replaces the target's.
 */
export const KEPT_UNLESS_IN_BACKUP: Record<string, string[]> = { settings: ['vapid_keys'] };

/**
 * The statement that empties one table before its rows go in — a plain `DELETE`, except where the
 * target keeps a row the backup lacks (see `KEPT_UNLESS_IN_BACKUP`), when that row is excluded.
 */
export function emptyStatement(table: PlannedTable): { sql: string; params: RestoreValue[] } {
  const kept = (KEPT_UNLESS_IN_BACKUP[table.name] ?? []).filter(
    (key) => !table.rows.some((row) => row.values[row.columns.indexOf('key')] === key),
  );
  if (kept.length === 0) return { sql: `DELETE FROM ${table.name}`, params: [] };
  return { sql: `DELETE FROM ${table.name} WHERE key NOT IN (${kept.map(() => '?').join(', ')})`, params: kept };
}

/** The plan as statements for a driver's `batch()`: each table emptied, then its rows inserted. */
export function restoreWrites(plan: RestorePlan): { sql: string; params: RestoreValue[] }[] {
  const writes: { sql: string; params: RestoreValue[] }[] = [];
  for (const table of plan.tables) {
    // Names here come from the schema (`tablesOf` over db.ts's own statements), never the file.
    writes.push(emptyStatement(table));
    for (const row of table.rows) {
      writes.push({
        sql: `INSERT INTO ${table.name} (${row.columns.join(', ')}) VALUES (${row.columns.map(() => '?').join(', ')})`,
        params: row.values,
      });
    }
  }
  return writes;
}

/** One table's rows as `{ column: value }` objects again (for reading settings out of a plan). */
export function rowsOf(plan: RestorePlan, name: string): Record<string, RestoreValue>[] {
  const table = plan.tables.find((t) => t.name === name);
  return (table?.rows ?? []).map((row) => Object.fromEntries(row.columns.map((c, i) => [c, row.values[i]!])));
}

/** Replace one table's rows in a plan (the host adjusts `settings` before writing). */
export function withRows(plan: RestorePlan, name: string, rows: Record<string, RestoreValue>[]): RestorePlan {
  return {
    ...plan,
    tables: plan.tables.map((t) =>
      t.name === name
        ? { ...t, rows: rows.map((r) => ({ columns: Object.keys(r), values: Object.values(r) })) }
        : t,
    ),
  };
}

/** Every image key the plan's `attachments` rows name. */
export function attachmentKeys(plan: RestorePlan): string[] {
  return rowsOf(plan, 'attachments')
    .map((r) => r.key)
    .filter((k): k is string => typeof k === 'string');
}
