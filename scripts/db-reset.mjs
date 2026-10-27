#!/usr/bin/env node
/**
 * Print the SQL that empties the database completely: one `DROP TABLE` per table in the schema.
 *
 * Prints rather than executes, deliberately. This is the one command in the repo that can throw a
 * ward's whole subscriber list away, and it is meant to be run against *production* — so the
 * destructive half is a separate step you type yourself, against a file you can read first. See
 * docs/DEPLOYMENT.md § Resetting the database for the two ways to apply it.
 *
 * Dropping rather than deleting rows: `initDb()` recreates the schema on the next request, so the
 * app heals itself and the AUTOINCREMENT counters start from 1 again, which `DELETE FROM` would
 * leave sitting where they were.
 *
 * The table list is read out of `src/db.ts` — the schema itself — so it cannot fall behind a table
 * added later, and this stays a plain script needing no build and no dependencies.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every table the app creates, in schema order. The same regex `schemaTables()` uses. */
export function tablesFromSchema() {
  const source = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf8');
  const names = [...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gu)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error('Found no CREATE TABLE statements in src/db.ts — has the schema moved?');
  }
  return names;
}

function main() {
  const tables = tablesFromSchema();
  // Reverse order, so a table is dropped before anything created earlier that it might reference.
  const sql = [...tables].reverse().map((table) => `DROP TABLE IF EXISTS ${table};`);
  process.stdout.write(`${sql.join('\n')}\n`);
  process.stderr.write(
    `\nWrote ${sql.length} DROP statements for: ${tables.join(', ')}\n` +
      `\nThis deletes EVERYTHING — announcements, programs, the subscriber list, the access\n` +
      `codes and every member's device token. Take a backup first (/admin/backup.json).\n` +
      `\nTo apply, redirect this into a file and then:\n` +
      `  Workers/D1: npx wrangler d1 execute <database_name> --remote --file=reset.sql\n` +
      `              (<database_name> is the database_name in your wrangler config)\n` +
      `  Node:       sqlite3 "$DATABASE_PATH" < reset.sql   (with the app stopped)\n` +
      `\nThe app recreates the empty schema on the next request it serves.\n`,
  );
}

/**
 * Run only when invoked directly, not when another script imports `tablesFromSchema` from here.
 *
 * `pathToFileURL`, not string concatenation: a path containing a space (or any character a URL
 * percent-encodes) does not compare equal to `file://` + itself, so the naive form would silently
 * decide this file is a library, print nothing, and exit 0 — a reset that looks like it worked and
 * leaves you applying an empty file. Every checkout under "My Documents" would hit it.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
