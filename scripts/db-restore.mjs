#!/usr/bin/env node
/**
 * Turn a backup back into SQL — and, from a full-backup zip, back into image files.
 *
 * Takes either download from the dashboard's Backup card:
 *   - the ZIP ("Download Backup (ZIP)"): `backup.json` plus `images/<key>` for every image;
 *   - the JSON ("Data only (JSON)", `/admin/backup.json`): the data alone.
 *
 * The data is JSON precisely so that it restores anywhere — a SQLite file image is meaningless on
 * D1 — but that only helps if something turns it back into statements. This is that something, and
 * it emits plain SQL rather than talking to a database, so the same output restores a Node
 * deployment through `sqlite3` and a Workers one through `wrangler d1 execute`. From a zip it also
 * writes the images out to a folder, and prints the commands that put them back for each runtime.
 *
 * Usage:
 *   node scripts/db-restore.mjs <backup.zip | backup.json> [--images-dir DIR] [--d1-images] [--seal-key KEY] > restore.sql
 *
 *   --images-dir DIR  where a zip's images are written (default: <backup name>-images, here)
 *   --d1-images       also put the images into the SQL, as `file_chunks` rows — for a Workers
 *                     deployment with no R2 bucket, which keeps its images in D1
 *   --seal-key KEY    the deployment's BACKUP_SEAL_KEY, which opens the push keys sealed in the
 *                     backup (src/seal.ts); read from the BACKUP_SEAL_KEY environment variable
 *                     when not given (nothing here reads .env — export it, or pass the flag)
 *
 * What a restore means — a replace, ids kept, tables the backup predates left empty, `file_chunks`
 * never emptied, unknown columns dropped and reported, a newer schema refused — lives in
 * `src/restore.ts`, which the many-ward host's Import Backup uses too; this file imports it
 * directly (Node strips its types), so there is no build step between an operator and a restore.
 *
 * The schema must already exist. Nothing here creates tables: the app's own `initDb()` is the only
 * thing that should ever write the schema, and it runs on the first request after a reset. That
 * ordering is in docs/DEPLOYMENT.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { contentTypeForKey } from '../src/filestore.ts';
import { stripImageMetadata } from '../src/image-meta.ts';
import { emptyStatement, planRestore, tablesOf } from '../src/restore.ts';
import { unsealBackupTables } from '../src/seal.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The image key format (src/filestore.ts): nothing else is ever written as a file name. */
const KEY = /^[0-9a-f]{32}\.[a-z0-9]+$/u;

/**
 * Base64 characters per `file_chunks` row in the SQL. The app's own store uses 1 MB rows, but a SQL
 * *file* for `wrangler d1 execute` is limited to 100 KB per statement — the value is inside the
 * statement here, not bound — so the rows are smaller. A multiple of 4, like the app's.
 */
const SQL_CHUNK_CHARS = 90_000;

/** This version's tables and schema version, read out of `src/db.ts` (as `db-reset.mjs` does). */
function schemaFromSource() {
  const source = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf8');
  const statements = [...source.matchAll(/`(CREATE TABLE IF NOT EXISTS[^`]*)`/gu)].map((m) => m[1]);
  const version = Number(/const SCHEMA_VERSION = '(\d+)'/u.exec(source)?.[1]);
  if (statements.length === 0 || !version) {
    throw new Error('Could not read the schema out of src/db.ts — has it moved?');
  }
  return { tables: tablesOf(statements), version };
}

/** The zip reader the dashboard writes with (`public/zip.js`), run as it is in a browser. */
function loadZip() {
  vm.runInThisContext(readFileSync(join(ROOT, 'public', 'zip.js'), 'utf8'), { filename: 'zip.js' });
  return globalThis.WardZip;
}

/** A SQL literal for one value (already checked by the plan: a string, a finite number or null). */
function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  // Doubling the quote is the whole of SQL string escaping. Newlines, semicolons and unicode all
  // ride inside the literal untouched.
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function parseArgs(argv) {
  const args = { file: null, imagesDir: null, d1Images: false, sealKey: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--d1-images') args.d1Images = true;
    else if (arg === '--images-dir') args.imagesDir = argv[++i] ?? null;
    else if (arg === '--seal-key') args.sealKey = argv[++i] ?? null;
    else if (arg.startsWith('--seal-key=')) args.sealKey = arg.slice('--seal-key='.length);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (!args.file) args.file = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  return args;
}

/** The backup's JSON and, from a zip, its images and manifest. */
async function readBackup(file) {
  const bytes = readFileSync(file);
  const Zip = loadZip();
  if (!Zip.isZip(bytes)) {
    return { backup: JSON.parse(bytes.toString('utf8')), images: null, manifest: null };
  }
  const entries = await Zip.readZip(bytes);
  const images = new Map();
  let backup = null;
  let manifest = null;
  for (const { name, data } of entries) {
    const image = /(?:^|\/)images\/([^/]+)$/u.exec(name);
    if (image) images.set(image[1], Buffer.from(data));
    else if (/(?:^|\/)backup\.json$/u.test(name)) backup = JSON.parse(Buffer.from(data).toString('utf8'));
    else if (/(?:^|\/)manifest\.json$/u.test(name)) manifest = JSON.parse(Buffer.from(data).toString('utf8'));
  }
  if (!backup) throw new Error(`${file} is a zip with no backup.json in it`);
  return { backup, images, manifest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    process.stderr.write(
      'Usage: node scripts/db-restore.mjs <backup.zip | backup.json> [--images-dir DIR] [--d1-images] [--seal-key KEY] > restore.sql\n' +
        '       (a file downloaded from the dashboard\'s Backup card)\n',
    );
    process.exit(2);
  }

  const { backup, images, manifest } = await readBackup(args.file);
  const schema = schemaFromSource();
  // The push keys travel sealed under the deployment's BACKUP_SEAL_KEY (src/seal.ts). Opened here,
  // they restore like any setting; locked (another deployment's key, or none given), the sealed row
  // is dropped and the planner keeps the pair already in the database.
  const sealKey = args.sealKey ?? process.env.BACKUP_SEAL_KEY ?? '';
  const unsealed = backup && typeof backup === 'object' ? await unsealBackupTables(backup.tables, sealKey) : { tables: undefined, sealed: 'none' };
  const plan = planRestore(unsealed.tables === undefined ? backup : { ...backup, tables: unsealed.tables }, schema.tables, schema.version);

  // Settings that belong to where the backup was made, not to this deployment. The many-ward
  // host's own rows (`host_ward_*`: the ward's place on it) mean nothing to a single ward, so they
  // are left out. The learned address (`public_origin`) is kept — restoring a ward over itself is
  // the common case, and without it pushes wait until an admin next visits — but named, with how to
  // clear it, because on another address the app never learns a new one while it is set
  // (identity.ts) and every notification would link to the old site.
  const settings = plan.tables.find((t) => t.name === 'settings');
  let learnedOrigin = null;
  let hasPushKeys = false;
  if (settings) {
    const key = (row) => String(row.values[row.columns.indexOf('key')]);
    settings.rows = settings.rows.filter((row) => !key(row).startsWith('host_ward_'));
    const origin = settings.rows.find((row) => key(row) === 'public_origin');
    if (origin) learnedOrigin = origin.values[origin.columns.indexOf('value')];
    hasPushKeys = settings.rows.some((row) => key(row) === 'vapid_keys');
  }

  // A backup made before the app stripped image metadata still carries it: strip on the way in,
  // as an upload does (src/image-meta.ts), before the rows are written, so each row's `size` is
  // the size of the bytes that are put back.
  if (images) {
    for (const row of plan.tables.find((t) => t.name === 'attachments')?.rows ?? []) {
      const key = String(row.values[row.columns.indexOf('key')]);
      const sizeAt = row.columns.indexOf('size');
      const data = images.get(key);
      if (!data || sizeAt < 0) continue;
      const stripped = stripImageMetadata(new Uint8Array(data), contentTypeForKey(key) ?? '');
      if (stripped.byteLength !== data.byteLength) {
        images.set(key, Buffer.from(stripped.buffer, stripped.byteOffset, stripped.byteLength));
        row.values[sizeAt] = stripped.byteLength;
      }
    }
  }

  const out = [];
  const counts = [];
  for (const table of plan.tables) {
    out.push(`-- ${table.name}: ${table.rows.length} row(s)${table.inBackup ? '' : ' (not in this backup: emptied)'}`);
    // The emptying statement is the planner's (it keeps the target's push keys when the backup has
    // none); its placeholders become literals here, since this is a file and nothing binds them.
    const empty = emptyStatement(table);
    out.push(`${empty.sql.replace(/\?/gu, () => literal(empty.params.shift()))};`);
    for (const row of table.rows) {
      out.push(`INSERT INTO ${table.name} (${row.columns.join(', ')}) VALUES (${row.values.map(literal).join(', ')});`);
    }
    out.push('');
    counts.push(`${table.name} ${table.rows.length}`);
  }

  // --- images ---
  const notes = [];
  // Each row under its file's key and, for a PDF, its thumbnail's: both are images/<key> in the ZIP.
  const attachments = new Map(
    (plan.tables.find((t) => t.name === 'attachments')?.rows ?? []).flatMap((row) => {
      const r = Object.fromEntries(row.columns.map((c, i) => [c, row.values[i]]));
      return r.thumb_key ? [[String(r.key), r], [String(r.thumb_key), r]] : [[String(r.key), r]];
    }),
  );
  let dir = null;
  const written = [];
  if (images) {
    dir = resolve(args.imagesDir ?? `${basename(args.file).replace(/\.zip$/iu, '')}-images`);
    mkdirSync(dir, { recursive: true });
    for (const [key, data] of images) {
      // Only names the restored rows use, in the one shape the app makes: never a path from the file.
      if (!KEY.test(key) || !attachments.has(key)) {
        notes.push(`skipped images/${key}: no restored image has that name`);
        continue;
      }
      // The rule the many-ward host's import applies (src/ward-import.ts): an extension this app
      // makes, and a row that says the same type. A backup is a file anyone could have edited, and
      // a `.html` entry stored as text/html would be served from the ward's own origin.
      // A PDF's thumbnail is a JPEG whatever the row's own type (importedTypeFor in ward-import.ts).
      const row = attachments.get(key);
      const type = row.thumb_key === key && row.key !== key ? 'image/jpeg' : String(row.content_type).toLowerCase();
      if (contentTypeForKey(key) !== type) {
        notes.push(`skipped images/${key}: not an allowed image type (${type})`);
        continue;
      }
      writeFileSync(join(dir, key), data);
      written.push(key);
      if (args.d1Images) {
        const encoded = data.toString('base64');
        out.push(`-- image ${key}`);
        out.push(`DELETE FROM file_chunks WHERE key = ${literal(key)};`);
        for (let seq = 0, at = 0; at < encoded.length || seq === 0; seq++, at += SQL_CHUNK_CHARS) {
          out.push(
            `INSERT INTO file_chunks (key, seq, content_type, data) VALUES (${literal(key)}, ${seq}, ${literal(type)}, ${literal(encoded.slice(at, at + SQL_CHUNK_CHARS))});`,
          );
        }
      }
    }
    for (const key of attachments.keys()) {
      if (!images.has(key)) {
        const why = manifest?.missing?.find?.((m) => m.key === key)?.error;
        notes.push(`missing images/${key}${why ? ` (the backup could not fetch it: ${why})` : ''}`);
      }
    }
  } else if (args.d1Images) {
    throw new Error('--d1-images needs the ZIP backup: a JSON backup has no images in it');
  }

  process.stdout.write(`${out.join('\n')}\n`);
  const lines = [
    '',
    `From ${plan.exportedAt ?? 'an undated backup'}${plan.app ? ` of ${plan.app}` : ''}` +
      `${plan.fromVersion ? `, schema ${plan.fromVersion}` : ''} (this version: ${schema.version})`,
    `Rows: ${counts.join(', ')}`,
  ];
  for (const [table, columns] of Object.entries(plan.dropped)) {
    lines.push(`Dropped (this version has no such column): ${columns.map((c) => `${table}.${c}`).join(', ')}`);
  }
  for (const table of plan.ignored) lines.push(`Ignored "${table}" in the backup: a restore never writes it.`);
  lines.push(
    '',
    'Every table above is emptied before it is refilled (image bytes in file_chunks excepted). The send',
    'queue is left empty and the weekly catch-up starts from now, so nothing the backup was mid-way',
    'through sending goes out again. To apply:',
    '  Workers/D1: npx wrangler d1 execute <database_name> --remote --file=restore.sql',
    '              (<database_name> is the database_name in your wrangler config)',
    '  Node:       (echo "BEGIN;"; cat restore.sql; echo "COMMIT;") | sqlite3 -bail "$DATABASE_PATH"',
    '              (with the app stopped; all or nothing — a plain `sqlite3 db < restore.sql` carries on',
    '              past an error and leaves the tables half-restored)',
    '',
    'The tables must exist first — see docs/DEPLOYMENT.md § Restoring a backup.',
  );
  if (unsealed.sealed === 'opened') {
    lines.push('', 'Push keys: the sealed pair in this backup opened with the BACKUP_SEAL_KEY given, and is restored.');
  } else if (unsealed.sealed === 'locked') {
    lines.push(
      '',
      sealKey
        ? 'Push keys: the sealed pair in this backup did not open with the BACKUP_SEAL_KEY given — it was'
        : 'Push keys: this backup carries the VAPID pair sealed, and no BACKUP_SEAL_KEY was given (the',
      sealKey
        ? "sealed on another deployment, or the key is wrong. The pair already in this database is kept, so"
        : "environment variable, or --seal-key). The pair already in this database is kept, so",
      'a ward restored over itself keeps sending to its subscribers. On a fresh database the pair is',
      'the one the app minted when you opened the site: installed apps re-subscribe against it on their',
      'next launch; anyone else turns notifications on again. Run this again with the right key to',
      'keep every subscription.',
    );
  } else if (!hasPushKeys) {
    lines.push(
      '',
      "This backup carries no push keys (made on a deployment with no BACKUP_SEAL_KEY, which leaves the",
      'VAPID pair out). The pair already in this database is kept, so a ward restored over itself keeps',
      'sending to its subscribers. On a fresh database the pair is the one the app minted when you',
      'opened the site: installed apps re-subscribe against it on their next launch; anyone else turns',
      'notifications on again.',
    );
  }
  if (learnedOrigin) {
    lines.push(
      '',
      `The backup's ward was at ${learnedOrigin}. If this deployment is somewhere else (and sets no`,
      'PUBLIC_ORIGIN), clear it after the restore, or every link the app sends points at the old site:',
      `  DELETE FROM settings WHERE key = 'public_origin';`,
    );
  }
  if (images) {
    lines.push(
      '',
      `Images: ${written.length} of ${attachments.size} written to ${dir}`,
      ...notes.map((n) => `  ${n}`),
      'Put them back the way the deployment stores images:',
      `  Workers + R2:   for f in "${dir}"/*; do npx wrangler r2 object put "<bucket>/$(basename "$f")" --file "$f" --remote; done`,
      args.d1Images
        ? '  Workers + D1:   already in restore.sql above (file_chunks rows)'
        : '  Workers + D1:   run this again with --d1-images; the images then go into restore.sql',
      `  Node / Docker:  cp "${dir}"/* "$UPLOADS_PATH"/   (default: uploads/ beside the database; /data/uploads in Docker)`,
    );
  } else if (attachments.size > 0) {
    lines.push('', `This JSON backup names ${attachments.size} image(s) but holds none: restore from the ZIP to get them back.`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

// A stack trace is the wrong output for a tool whose reader is an operator part-way through a
// restore. Say what is wrong with their file, and leave a non-zero status so `&&` chains stop.
try {
  await main();
} catch (err) {
  process.stderr.write(`\nCould not build the restore SQL: ${err.message}\n`);
  process.exit(1);
}
