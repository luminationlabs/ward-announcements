/**
 * Restoring a backup: the shared planner (`src/restore.ts`), the many-ward host's import rules on
 * top of it (`src/ward-import.ts`), the push-key check (`identity.ts`), and `scripts/db-restore.mjs`
 * end to end — a JSON backup and a full-backup zip, turned into SQL that is then applied to a real
 * SQLite database with the app's own schema, images included.
 *
 * Node only, in process. Run with: npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { attachmentKeys, columnsOf, planRestore, restoreWrites } from '../dist/restore.js';
import { ADMIN_PASSWORD, createClient, startServer, testPort, unlockMember } from './helpers/harness.js';
import { checkImportedImage, prepareImport } from '../dist/ward-import.js';
import { checkVapidPair, generateVapidKeys, loadStoredIdentity } from '../dist/identity.js';
import { sealSecret } from '../dist/seal.js';
import { initPush, sendToAll } from '../dist/push.js';
import * as db from '../dist/db.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import { createSqlFileStore } from '../dist/filestore-sql.js';
import { loadConfig } from '../dist/config.js';
import { contains, jpegWithMetadata } from './helpers/image-fixtures.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts', 'db-restore.mjs');
const target = db.restoreTarget();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const KEY = '0123456789abcdef0123456789abcdef.png';
/** Two deployments' BACKUP_SEAL_KEYs (32 random bytes, base64url): the one a backup was sealed on, and another. */
const SEAL_KEY = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const OTHER_SEAL_KEY = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

function zipModule() {
  const window = {};
  const context = { window, TextEncoder, TextDecoder, DecompressionStream, Blob, Response };
  vm.createContext(context);
  vm.runInContext(readFileSync(join(ROOT, 'public', 'zip.js'), 'utf8'), context);
  return window.WardZip;
}

/** A backup as the original single-ward code (schema 5) wrote one: `subscriptions.label`, no people. */
function oldBackup() {
  return {
    app: 'Old Ward',
    exported_at: '2026-09-01T12:00:00.000Z',
    tables: {
      subscriptions: [
        { id: 7, endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a', user_agent: 'iPhone', created_at: '2026-01-01 00:00:00', last_success_at: null, failure_count: 0, label: 'Mom' },
      ],
      announcements: [
        { id: 3, title: 'Picnic', body: "Bring a *dish* — it's fun", published: 1, expires_at: null, created_at: '2026-08-01 00:00:00', updated_at: '2026-08-01 00:00:00', sort_order: 0 },
      ],
      settings: [
        { key: 'schema_version', value: '5' },
        { key: 'access_cookie_secret', value: 'secret-1' },
        { key: 'seeded', value: '1' },
      ],
      attachments: [
        { id: 4, owner_type: 'announcement', owner_id: 3, key: KEY, filename: 'flyer.png', content_type: 'image/png', size: PNG.length, created_at: '2026-08-01 00:00:00' },
      ],
      access_codes: [{ id: 1, code: 'abcd-efgh', created_at: '2026-01-01 00:00:00', retired_at: null, expires_at: null }],
    },
  };
}

describe('the planner', () => {
  test('a restore never re-sends what the backup was in the middle of sending', () => {
    // A backup taken mid-send holds the deliveries owed *then*; one older than this morning's
    // digest has no record of it. Restored as they were, both would go out again.
    const backup = oldBackup();
    backup.tables.send_queue = [{ id: 1, send_log_id: 9, subscription_id: 7, attempts: 0 }];
    backup.tables.send_batches = [
      { send_log_id: 9, url: '/', slot: '2026-09-01T08:00', total: 1, sent: 0, failed: 0, removed: 0, status: 'pending', created_at: '2026-09-01 14:00:00', finished_at: null },
    ];
    backup.tables.settings.push({ key: 'schedule_set_at', value: '2020-01-01T00:00:00.000Z' });
    const plan = planRestore(backup, target.tables, target.version);
    const rows = (name) => plan.tables.find((t) => t.name === name).rows.map((r) => Object.fromEntries(r.columns.map((c, i) => [c, r.values[i]])));

    assert.deepEqual(rows('send_queue'), [], 'nothing left to deliver');
    assert.equal(rows('send_batches')[0].status, 'done', 'and no send left open for a drain to adopt');
    const floors = rows('settings').filter((r) => r.key === 'schedule_set_at');
    assert.equal(floors.length, 1);
    assert.ok(Date.parse(floors[0].value) > Date.parse('2026-09-01T12:00:00.000Z'), 'the catch-up starts from the restore');
  });

  test('the target\'s push keys survive a backup that has none, and yield to one that has', () => {
    // The admin backup leaves `vapid_keys` out, so a ward restored over itself must keep the pair
    // its subscriptions were made with; an operator export carries one, and that one wins.
    const without = restoreWrites(planRestore(oldBackup(), target.tables, target.version));
    const emptied = without.find((w) => w.sql.startsWith('DELETE FROM settings'));
    assert.equal(emptied.sql, 'DELETE FROM settings WHERE key NOT IN (?)');
    assert.deepEqual(emptied.params, ['vapid_keys']);
    assert.ok(without.every((w) => !w.sql.startsWith('DELETE FROM subscriptions WHERE')), 'only settings is special');

    const backup = oldBackup();
    backup.tables.settings.push({ key: 'vapid_keys', value: '{"publicKey":"B...","privateKey":"x"}' });
    const withPair = restoreWrites(planRestore(backup, target.tables, target.version));
    assert.equal(withPair.find((w) => w.sql.startsWith('DELETE FROM settings')).sql, 'DELETE FROM settings');
  });

  test('a sealed pair that reaches the planner unopened is dropped, never written as a setting', async () => {
    // Every restorer opens the blob first (seal.ts); one that did not open must not land in
    // `settings` as if it were the pair, and its presence must not stop the target keeping its own.
    const backup = oldBackup();
    backup.tables.settings.push({ key: 'vapid_keys_sealed', value: await sealSecret('{"publicKey":"B","privateKey":"x"}', SEAL_KEY) });
    const writes = restoreWrites(planRestore(backup, target.tables, target.version));
    assert.ok(!writes.some((w) => w.params.includes('vapid_keys_sealed')), 'the blob is not inserted');
    assert.deepEqual(writes.find((w) => w.sql.startsWith('DELETE FROM settings')).params, ['vapid_keys'], "and the target's pair is kept");
  });

  test('reads each table\'s columns out of the schema itself', async () => {
    // Held to the real thing: the tables the app's own initDb creates.
    const dir = mkdtempSync(join(tmpdir(), 'restore-schema-'));
    try {
      loadConfig({ APP_NAME: 'x', APP_SHORT_NAME: 'x', APP_DESCRIPTION: 'x' });
      await db.initDb(createSqliteDriver(join(dir, 'a.db')));
      const real = new Database(join(dir, 'a.db'), { readonly: true });
      for (const table of target.tables) {
        const columns = real.prepare(`PRAGMA table_info(${table.name})`).all().map((c) => c.name);
        assert.deepEqual(table.columns, columns, table.name);
      }
      real.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('column parsing ignores comments, defaults and table constraints', () => {
    assert.deepEqual(
      columnsOf(`CREATE TABLE IF NOT EXISTS t (
        key   TEXT NOT NULL,             -- the key, (with a comma, inside)
        seq   INTEGER DEFAULT (datetime('now')),
        PRIMARY KEY (key, seq)
      )`),
      ['key', 'seq'],
    );
  });

  test('an old backup: unknown columns dropped and reported, absent tables emptied, ids kept', () => {
    const plan = planRestore(oldBackup(), target.tables, target.version);
    assert.equal(plan.fromVersion, 5);
    assert.deepEqual(plan.dropped, { subscriptions: ['label'] });
    const subs = plan.tables.find((t) => t.name === 'subscriptions');
    assert.ok(!subs.rows[0].columns.includes('label'));
    assert.equal(subs.rows[0].values[subs.rows[0].columns.indexOf('id')], 7);
    const people = plan.tables.find((t) => t.name === 'admin_users');
    assert.equal(people.inBackup, false);
    assert.equal(people.rows.length, 0);
    assert.ok(!plan.tables.some((t) => t.name === 'file_chunks'), 'file_chunks is never emptied');
    const writes = restoreWrites(plan);
    assert.ok(writes.some((w) => w.sql === 'DELETE FROM admin_users'));
    assert.ok(!writes.some((w) => /file_chunks/.test(w.sql)));
  });

  test('refuses what it must not restore', () => {
    const refuse = (backup, pattern) => assert.throws(() => planRestore(backup, target.tables, target.version), pattern);
    refuse(null, /not a backup/);
    refuse([], /not a backup/);
    refuse({ app: 'x' }, /no "tables"/);
    refuse({ tables: { nonsense: [] } }, /this version does not: nonsense/);
    refuse({ tables: { settings: [{ key: 'schema_version', value: String(target.version + 1) }] } }, /newer version/);
    refuse({ tables: { announcements: {} } }, /not a list of rows/);
    refuse({ tables: { announcements: [{ id: 1, title: { evil: true } }] } }, /cannot store/);
    refuse({ tables: { announcements: [{ nope: 1 }] } }, /no columns this version knows/);
  });

  test('a backup carrying file_chunks has them ignored, and says so', () => {
    const plan = planRestore({ tables: { file_chunks: [{ key: 'k', seq: 0, content_type: 'x', data: '' }] } }, target.tables, target.version);
    assert.deepEqual(plan.ignored, ['file_chunks']);
  });
});

describe('the host\'s import rules', () => {
  const ward = { hostname: 'ward.example.org', hostSettings: { host_ward_identity: '{"id":"w","hostname":"ward.example.org"}' }, vapidKeys: null, wardSettings: '{"appName":"Hosted"}', production: false, sealKey: SEAL_KEY };
  const settingsOf = (plan) =>
    Object.fromEntries(plan.tables.find((t) => t.name === 'settings').rows.map((r) => [r.values[r.columns.indexOf('key')], r.values[r.columns.indexOf('value')]]));

  test('keeps the ward\'s place, name and (with none in the backup) makes keys; warns about subscribers', async () => {
    const backup = oldBackup();
    backup.tables.settings.push({ key: 'host_ward_identity', value: '{"id":"other","hostname":"other.example.org"}' });
    const { plan, report } = await prepareImport(backup, {}, ward, target);
    const s = settingsOf(plan);
    assert.equal(s.host_ward_identity, ward.hostSettings.host_ward_identity, 'never another ward\'s place');
    assert.equal(s.ward_settings, ward.wardSettings, 'the ward keeps its name when the backup has none');
    assert.equal(s.seeded, '1');
    assert.equal(report.push.source, 'new');
    assert.equal(JSON.parse(s.vapid_keys).publicKey, report.push.publicKey);
    assert.match(report.warnings.join(' '), /1 subscriber\(s\).*push keys that are not in it/);
    assert.match(report.warnings.join(' '), /no dashboard people/);
    assert.equal(report.origin.matches, false, 'the other ward\'s address is reported');
    assert.deepEqual(report.images.keys, [KEY]);
  });

  test('supplied keys are checked, stored and reported; the backup\'s own are used otherwise', async () => {
    const pair = await generateVapidKeys();
    const { plan, report } = await prepareImport(oldBackup(), { vapidPublicKey: pair.publicKey, vapidPrivateKey: pair.privateKey, vapidSubject: 'mailto:clerk@example.org' }, ward, target);
    assert.equal(report.push.source, 'supplied');
    assert.deepEqual(JSON.parse(settingsOf(plan).vapid_keys), { ...pair, subject: 'mailto:clerk@example.org' });
    assert.ok(!report.warnings.some((w) => /push keys/.test(w)));

    const withOwn = oldBackup();
    withOwn.tables.settings.push({ key: 'vapid_keys', value: JSON.stringify(pair) });
    const own = (await prepareImport(withOwn, {}, ward, target)).report.push;
    assert.equal(own.source, 'backup');
    assert.equal(own.sealed, 'none');

    const other = await generateVapidKeys();
    await assert.rejects(prepareImport(oldBackup(), { vapidPublicKey: pair.publicKey, vapidPrivateKey: other.privateKey }, ward, target), /does not belong/);
    await assert.rejects(prepareImport(oldBackup(), { vapidPublicKey: pair.publicKey }, ward, target), /both push keys/);
    await assert.rejects(prepareImport(oldBackup(), { vapidSubject: 'you@example.org' }, ward, target), /mailto/);
  });

  test("a sealed pair opens under the host's key and is the ward's; under another it stays shut, and the operator is told", async () => {
    const pair = await generateVapidKeys();
    const sealed = oldBackup();
    sealed.tables.settings.push({ key: 'vapid_keys_sealed', value: await sealSecret(JSON.stringify(pair), SEAL_KEY) });

    const opened = await prepareImport(sealed, {}, ward, target);
    assert.equal(opened.report.push.source, 'backup');
    assert.equal(opened.report.push.sealed, 'opened');
    assert.equal(opened.report.push.publicKey, pair.publicKey);
    assert.deepEqual(JSON.parse(settingsOf(opened.plan).vapid_keys), pair);
    assert.equal(settingsOf(opened.plan).vapid_keys_sealed, undefined, 'the blob itself is not restored');
    assert.ok(!opened.report.warnings.some((w) => /push keys/.test(w)), opened.report.warnings.join('\n'));

    const existing = { ...ward, sealKey: OTHER_SEAL_KEY, vapidKeys: JSON.stringify(await generateVapidKeys()) };
    const locked = await prepareImport(sealed, {}, existing, target);
    assert.equal(locked.report.push.source, 'ward');
    assert.equal(locked.report.push.sealed, 'locked');
    assert.equal(settingsOf(locked.plan).vapid_keys, existing.vapidKeys, 'the ward keeps its own pair');
    assert.equal(settingsOf(locked.plan).vapid_keys_sealed, undefined);
    assert.match(locked.report.warnings.join(' '), /sealed with another deployment's key \(or this host has no BACKUP_SEAL_KEY\); the ward keeps its own pair/);
    assert.equal((await prepareImport(sealed, {}, { ...ward, sealKey: '' }, target)).report.push.sealed, 'locked', 'a host with no key cannot open it either');

    // Keys given by the operator win over a sealed pair, opened or not, with the usual warning.
    const given = await generateVapidKeys();
    const supplied = await prepareImport(sealed, { vapidPublicKey: given.publicKey, vapidPrivateKey: given.privateKey }, ward, target);
    assert.equal(supplied.report.push.source, 'supplied');
    assert.equal(supplied.report.push.sealed, 'opened');
    assert.match(supplied.report.warnings.join(' '), /push keys of its own; the ones you gave replace them/);
    const suppliedLocked = await prepareImport(sealed, { vapidPublicKey: given.publicKey, vapidPrivateKey: given.privateKey }, existing, target);
    assert.equal(suppliedLocked.report.push.source, 'supplied');
    assert.ok(!suppliedLocked.report.warnings.some((w) => /sealed with another/.test(w)), 'no complaint about a lock the operator just opened by hand');
  });

  test('a backup whose gate was off is imported with a warning that nobody is signed in', async () => {
    const backup = oldBackup();
    backup.tables.access_codes = [];
    const { report } = await prepareImport(backup, {}, ward, target);
    assert.match(report.warnings.join(' '), /no access code \(its member gate was off\)/);
    assert.ok(!(await prepareImport(oldBackup(), {}, ward, target)).report.warnings.some((w) => /gate was off/.test(w)));
  });

  test('a learned origin from another address is dropped; the same address is kept', async () => {
    const backup = oldBackup();
    backup.tables.settings.push({ key: 'public_origin', value: 'https://ward.example.org' });
    const same = await prepareImport(backup, {}, ward, target);
    assert.equal(settingsOf(same.plan).public_origin, 'https://ward.example.org');
    assert.equal(same.report.origin.matches, true);
    backup.tables.settings.at(-1).value = 'https://elsewhere.example.org';
    const moved = await prepareImport(backup, {}, ward, target);
    assert.equal(settingsOf(moved.plan).public_origin, undefined);
    assert.match(moved.report.warnings.join(' '), /comes from https:\/\/elsewhere/);
  });

  test('a supplied pair, stored as the import stores it, is what the next send signs with', async () => {
    // The host can't show this end to end — the push library will only post to https, and the
    // local runtime has no https push service to post to — so it is shown here, in process: the
    // import's settings row, loaded the way every ward boot loads it, then a real send.
    const subtle = globalThis.crypto.subtle;
    const pair = await generateVapidKeys();
    const { plan } = await prepareImport(oldBackup(), { vapidPublicKey: pair.publicKey, vapidPrivateKey: pair.privateKey }, ward, target);
    const stored = settingsOf(plan).vapid_keys;
    const dir = mkdtempSync(join(tmpdir(), 'restore-push-'));
    const realFetch = globalThis.fetch;
    try {
      loadConfig({ APP_NAME: 'x', APP_SHORT_NAME: 'x', APP_DESCRIPTION: 'x', VAPID_SUBJECT: 'mailto:test@example.org' });
      await db.initDb(createSqliteDriver(join(dir, 'p.db')));
      await db.setSetting('vapid_keys', stored);
      await loadStoredIdentity();
      initPush();
      const ecdh = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      await db.upsertSubscription({
        endpoint: 'https://push.example.test/member',
        p256dh: Buffer.from(await subtle.exportKey('raw', ecdh.publicKey)).toString('base64url'),
        auth: Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
        user_agent: null,
      });
      const seen = [];
      globalThis.fetch = async (url, init) => {
        seen.push(new Headers(init.headers).get('authorization'));
        return new Response(null, { status: 201 });
      };
      const result = await sendToAll({ title: 'T', body: 'B' }, { type: 'manual', drain: 'until-empty' });
      assert.equal(result.sent, 1);
      const [, jwt, k] = /^vapid t=([^,]+),\s*k=(\S+)$/.exec(seen[0]) ?? [];
      assert.equal(k, pair.publicKey);
      const [h, p, s] = jwt.split('.');
      const verifier = await subtle.importKey('raw', Buffer.from(pair.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${p}`)));
    } finally {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('checkVapidPair: well-formed and matching, or a reason', async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    assert.equal(await checkVapidPair(a.publicKey, a.privateKey), null);
    assert.match(await checkVapidPair(a.publicKey, b.privateKey), /does not belong/);
    assert.match(await checkVapidPair('nope', a.privateKey), /public key/);
    assert.match(await checkVapidPair(a.publicKey, 'short'), /private key/);
  });

  test('an imported image must be named by a row, of its type, and really that type', () => {
    const row = { content_type: 'image/png' };
    assert.equal(checkImportedImage(KEY, new Uint8Array(PNG), row), null);
    assert.match(checkImportedImage('../etc/passwd', new Uint8Array(PNG), row), /not an image name/);
    assert.match(checkImportedImage(KEY, new Uint8Array(PNG), undefined), /no image of that name/);
    assert.match(checkImportedImage(KEY, new Uint8Array(Buffer.from('<svg/>')), row), /not a PNG/);
    assert.match(checkImportedImage(KEY, new Uint8Array(0), row), /empty/);
    assert.match(checkImportedImage(KEY, new Uint8Array(3 * 1024 * 1024 + 1), row), /over 3 MB/);
    assert.match(checkImportedImage(KEY, new Uint8Array(PNG), { content_type: 'image/jpeg' }), /not an allowed image type/);
  });

  test("an imported PDF is checked as a PDF, and its thumbnail as the row's JPEG", () => {
    const pdfKey = 'dddddddddddddddddddddddddddddddd.pdf';
    const thumbKey = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.jpg';
    const row = { key: pdfKey, content_type: 'application/pdf', thumb_key: thumbKey };
    const pdf = new Uint8Array(Buffer.from('%PDF-1.7\n%%EOF\n'));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    assert.equal(checkImportedImage(pdfKey, pdf, row), null);
    assert.equal(checkImportedImage(thumbKey, jpeg, row), null, 'the thumbnail is a JPEG, whatever the row says');
    assert.match(checkImportedImage(thumbKey, pdf, row), /not a JPEG/);
    assert.match(checkImportedImage(pdfKey, new Uint8Array(Buffer.from('<html>')), row), /not a PDF/);
    assert.match(checkImportedImage(pdfKey, new Uint8Array(5 * 1024 * 1024 + 1), row), /over 5 MB/);
    const plan = { tables: [{ name: 'attachments', columns: [], inBackup: true, rows: [{ columns: Object.keys(row), values: Object.values(row) }] }] };
    assert.deepEqual(attachmentKeys(plan), [pdfKey, thumbKey], 'both are images the import asks for');
  });
});

describe('scripts/db-restore.mjs', () => {
  /** A fresh database with the app's schema, as a deployment has after "reset, then open the site". */
  async function freshDatabase(dir) {
    loadConfig({ APP_NAME: 'x', APP_SHORT_NAME: 'x', APP_DESCRIPTION: 'x' });
    const path = join(dir, 'app.db');
    await db.initDb(createSqliteDriver(path));
    return path;
  }

  function run(args, cwd) {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { status: res.status, sql: res.stdout, log: res.stderr };
  }

  test('a JSON backup becomes SQL that restores it, the dropped column reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-json-'));
    try {
      writeFileSync(join(dir, 'b.json'), JSON.stringify(oldBackup()));
      const { status, sql, log } = run(['b.json'], dir);
      assert.equal(status, 0, log);
      assert.match(log, /Dropped .*subscriptions\.label/);
      assert.match(log, /names 1 image\(s\) but holds none/);
      const path = await freshDatabase(dir);
      const sqlite = new Database(path);
      sqlite.exec(sql);
      assert.equal(sqlite.prepare('SELECT title FROM announcements WHERE id = 3').get().title, 'Picnic');
      assert.equal(sqlite.prepare('SELECT body FROM announcements WHERE id = 3').get().body, "Bring a *dish* — it's fun");
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 1);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('settings from where the backup was made are left out or named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-origin-'));
    try {
      const backup = oldBackup();
      backup.tables.settings.push(
        { key: 'host_ward_identity', value: '{"hostname":"elsewhere.example.org"}' },
        { key: 'public_origin', value: 'https://old.example.org' },
      );
      writeFileSync(join(dir, 'b.json'), JSON.stringify(backup));
      const { status, sql, log } = run(['b.json'], dir);
      assert.equal(status, 0, log);
      assert.doesNotMatch(sql, /host_ward_/, "the host's own rows mean nothing to a single ward");
      assert.match(sql, /public_origin/, 'the learned address is kept, for a ward restored over itself');
      assert.match(log, /was at https:\/\/old\.example\.org/, 'but named');
      assert.match(log, /DELETE FROM settings WHERE key = 'public_origin'/, 'with how to clear it');
      assert.match(log, /sqlite3 -bail/, 'and the Node command is all or nothing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a backup without push keys keeps the pair already in the database; one with them replaces it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-keys-'));
    try {
      const path = await freshDatabase(dir);
      const sqlite = new Database(path);
      // What "open the site once" leaves behind: the pair the running deployment's subscribers hold.
      const minted = '{"publicKey":"B-minted","privateKey":"minted"}';
      sqlite.prepare("INSERT INTO settings (key, value) VALUES ('vapid_keys', ?)").run(minted);
      const pair = () => sqlite.prepare("SELECT value FROM settings WHERE key = 'vapid_keys'").get()?.value;

      writeFileSync(join(dir, 'b.json'), JSON.stringify(oldBackup()));
      const without = run(['b.json'], dir);
      assert.equal(without.status, 0, without.log);
      assert.match(without.sql, /DELETE FROM settings WHERE key NOT IN \('vapid_keys'\);/);
      assert.match(without.log, /carries no push keys/, 'and the operator is told');
      sqlite.exec(without.sql);
      assert.equal(pair(), minted, 'the pair is kept');
      assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key = 'access_cookie_secret'").get().value, 'secret-1', 'everything else is replaced');

      const backup = oldBackup();
      backup.tables.settings.push({ key: 'vapid_keys', value: '{"publicKey":"B-exported","privateKey":"exported"}' });
      writeFileSync(join(dir, 'e.json'), JSON.stringify(backup));
      const withPair = run(['e.json'], dir);
      assert.equal(withPair.status, 0, withPair.log);
      assert.match(withPair.sql, /DELETE FROM settings;/);
      assert.doesNotMatch(withPair.log, /carries no push keys/);
      sqlite.exec(withPair.sql);
      assert.equal(pair(), '{"publicKey":"B-exported","privateKey":"exported"}', "the backup's pair wins");
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sealed pair restores with the deployment's BACKUP_SEAL_KEY, and stays out under another", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-sealed-'));
    try {
      const path = await freshDatabase(dir);
      const sqlite = new Database(path);
      const minted = '{"publicKey":"B-minted","privateKey":"minted"}';
      sqlite.prepare("INSERT INTO settings (key, value) VALUES ('vapid_keys', ?)").run(minted);
      const pair = () => sqlite.prepare("SELECT value FROM settings WHERE key = 'vapid_keys'").get()?.value;
      const sealedRows = () => sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'vapid_keys_sealed'").get().n;

      const backed = '{"publicKey":"B-backed-up","privateKey":"backed-up"}';
      const backup = oldBackup();
      backup.tables.settings.push({ key: 'vapid_keys_sealed', value: await sealSecret(backed, SEAL_KEY) });
      writeFileSync(join(dir, 's.json'), JSON.stringify(backup));

      // Another deployment's key: locked, the pair in the database kept, the operator told.
      const other = run(['s.json', '--seal-key', OTHER_SEAL_KEY], dir);
      assert.equal(other.status, 0, other.log);
      assert.match(other.sql, /DELETE FROM settings WHERE key NOT IN \('vapid_keys'\);/);
      assert.doesNotMatch(other.sql, /vapid_keys_sealed/, 'a blob nobody here can read is not written as a setting');
      assert.doesNotMatch(other.sql, /backed-up/);
      assert.match(other.log, /did not open with the BACKUP_SEAL_KEY given/);
      sqlite.exec(other.sql);
      assert.equal(pair(), minted);
      assert.equal(sealedRows(), 0);

      // No key at all: the same, with a note saying what to give.
      const none = run(['s.json'], dir);
      assert.equal(none.status, 0, none.log);
      assert.match(none.log, /sealed, and no BACKUP_SEAL_KEY was given/);
      assert.doesNotMatch(none.sql, /backed-up|vapid_keys_sealed/);

      // The deployment's own key, from the environment as the docs say: the pair is restored.
      const res = spawnSync(process.execPath, [SCRIPT, 's.json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, BACKUP_SEAL_KEY: SEAL_KEY } });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /DELETE FROM settings;/);
      assert.match(res.stderr, /sealed pair in this backup opened/);
      assert.doesNotMatch(res.stderr, /carries no push keys/);
      sqlite.exec(res.stdout);
      assert.equal(pair(), backed, "the backup's pair, opened, wins");
      assert.equal(sealedRows(), 0);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a zip: the SQL, the images written out, and with --d1-images the bytes in file_chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-zip-'));
    try {
      const Zip = zipModule();
      const stray = 'ffffffffffffffffffffffffffffffff.png';
      writeFileSync(
        join(dir, 'ward.zip'),
        Zip.createZip([
          { name: 'backup.json', data: JSON.stringify(oldBackup()) },
          { name: `images/${KEY}`, data: new Uint8Array(PNG) },
          { name: `images/${stray}`, data: new Uint8Array(PNG) },
          { name: 'images/../../escape.png', data: new Uint8Array(PNG) },
          { name: 'manifest.json', data: '{"missing":[]}' },
        ]),
      );
      const plain = run(['ward.zip'], dir);
      assert.equal(plain.status, 0, plain.log);
      assert.deepEqual(readdirSync(join(dir, 'ward-images')), [KEY], 'only images a restored row names');
      assert.deepEqual(readFileSync(join(dir, 'ward-images', KEY)), PNG);
      assert.ok(!existsSync(join(dir, 'escape.png')));
      assert.match(plain.log, /wrangler r2 object put "<bucket>\/\$\(basename "\$f"\)"/);
      assert.match(plain.log, /UPLOADS_PATH/);
      assert.match(plain.log, /run this again with --d1-images/);
      assert.ok(!/file_chunks/.test(plain.sql));

      const d1 = run(['ward.zip', '--d1-images', '--images-dir', 'out'], dir);
      assert.equal(d1.status, 0, d1.log);
      assert.ok(existsSync(join(dir, 'out', KEY)));
      const path = await freshDatabase(dir);
      const sqlite = new Database(path);
      sqlite.exec(d1.sql);
      sqlite.close();
      // Read back through the app's own database file store: the bytes the dashboard uploaded.
      const store = createSqlFileStore();
      const file = await store.get(KEY);
      assert.equal(file.contentType, 'image/png');
      assert.deepEqual(Buffer.from(file.body), PNG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an image from before the app stripped metadata is stripped on the way back, its row\'s size with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-strip-'));
    try {
      const Zip = zipModule();
      const photoKey = 'dddddddddddddddddddddddddddddddd.jpg';
      const photo = jpegWithMetadata({ orientation: 6 });
      const backup = oldBackup();
      backup.tables.attachments.push(
        { id: 5, owner_type: 'announcement', owner_id: 3, key: photoKey, filename: 'IMG_0001.jpg', content_type: 'image/jpeg', size: photo.length, created_at: '2026-08-01 00:00:00' },
      );
      writeFileSync(
        join(dir, 'ward.zip'),
        Zip.createZip([
          { name: 'backup.json', data: JSON.stringify(backup) },
          { name: `images/${KEY}`, data: new Uint8Array(PNG) },
          { name: `images/${photoKey}`, data: photo },
          { name: 'manifest.json', data: '{"missing":[]}' },
        ]),
      );
      const { status, sql, log } = run(['ward.zip', '--d1-images'], dir);
      assert.equal(status, 0, log);
      const written = readFileSync(join(dir, 'ward-images', photoKey));
      assert.ok(written.length < photo.length, 'smaller than the backup held');
      assert.ok(!contains(written, 'Apple') && !contains(written, Uint8Array.from([0x25, 0x88])), 'the make and the GPS IFD are gone');
      assert.ok(contains(written, Uint8Array.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06])), 'Orientation = 6 stays');
      assert.deepEqual(readFileSync(join(dir, 'ward-images', KEY)), PNG, 'a plain image is written as it was');
      const path = await freshDatabase(dir);
      const sqlite = new Database(path);
      sqlite.exec(sql);
      assert.equal(sqlite.prepare('SELECT size FROM attachments WHERE key = ?').get(photoKey).size, written.length, 'the row says the stored size');
      sqlite.close();
      const file = await createSqlFileStore().get(photoKey);
      assert.deepEqual(Buffer.from(file.body), written, 'and file_chunks holds the stripped bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an image whose name is not an image type this app makes is skipped, row or no row', async () => {
    // A backup is a file anyone could have edited: a `.html` entry with a row saying text/html
    // would, restored, be served from the ward's own origin. The host's import rule applies here.
    const dir = mkdtempSync(join(tmpdir(), 'restore-html-'));
    try {
      const Zip = zipModule();
      const page = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.html';
      const mislabelled = 'dddddddddddddddddddddddddddddddd.png';
      const backup = oldBackup();
      backup.tables.attachments.push(
        { id: 5, owner_type: 'announcement', owner_id: 3, key: page, filename: 'x.html', content_type: 'text/html', size: 6, created_at: '2026-08-01 00:00:00' },
        { id: 6, owner_type: 'announcement', owner_id: 3, key: mislabelled, filename: 'x.png', content_type: 'text/html', size: 6, created_at: '2026-08-01 00:00:00' },
      );
      writeFileSync(
        join(dir, 'ward.zip'),
        Zip.createZip([
          { name: 'backup.json', data: JSON.stringify(backup) },
          { name: `images/${KEY}`, data: new Uint8Array(PNG) },
          { name: `images/${page}`, data: new Uint8Array(Buffer.from('<html>')) },
          { name: `images/${mislabelled}`, data: new Uint8Array(Buffer.from('<html>')) },
        ]),
      );
      const { status, sql, log } = run(['ward.zip', '--d1-images'], dir);
      assert.equal(status, 0, log);
      assert.deepEqual(readdirSync(join(dir, 'ward-images')), [KEY], 'only the real image is written out');
      assert.match(log, new RegExp(`skipped images/${page}: not an allowed image type \\(text/html\\)`, 'u'));
      assert.match(log, new RegExp(`skipped images/${mislabelled}: not an allowed image type \\(text/html\\)`, 'u'));
      assert.ok(new RegExp(`INSERT INTO file_chunks[^\\n]*${KEY}`, 'u').test(sql), 'the real image is in file_chunks');
      assert.ok(!new RegExp(`INSERT INTO file_chunks[^\\n]*${page}`, 'u').test(sql), 'no html bytes in file_chunks');
      assert.ok(!new RegExp(`INSERT INTO file_chunks[^\\n]*${mislabelled}`, 'u').test(sql));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a refused backup prints a reason and exits non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-bad-'));
    try {
      writeFileSync(join(dir, 'new.json'), JSON.stringify({ tables: { settings: [{ key: 'schema_version', value: '999' }] } }));
      const res = run(['new.json'], dir);
      assert.equal(res.status, 1);
      assert.match(res.log, /newer version/);
      assert.equal(res.sql, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the admin backup download', () => {
  // Two real servers with no pinned keys, so each mints a pair into `settings` — the thing that
  // must never come back out in the clear: one with a BACKUP_SEAL_KEY, one without. Over HTTP, as
  // the Backup button fetches it.
  let sealed;
  let plain;
  before(async () => {
    const start = async (port, env) => {
      const server = await startServer({ port, env: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', ...env } });
      const req = createClient(server.base);
      await req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
      await unlockMember(req, 'member');
      const { key } = await (await req('/api/vapid-public-key', { as: 'member' })).json();
      assert.equal(key.length, 87, 'the server minted a pair of its own');
      return { server, req, key };
    };
    [sealed, plain] = await Promise.all([start(testPort(10), { BACKUP_SEAL_KEY: SEAL_KEY }), start(testPort(13), {})]);
  });
  after(() => Promise.all([sealed?.server.stop(), plain?.server.stop()]));

  test('with a seal key: the pair travels sealed, and opens again only with that key', async () => {
    const { tables } = await (await sealed.req('/admin/backup.json', { as: 'admin' })).json();
    const keys = tables.settings.map((row) => row.key);
    assert.ok(keys.includes('access_cookie_secret'), 'the member secrets are what the backup is for');
    assert.ok(keys.includes('vapid_keys_sealed'), 'the pair is in the file, sealed');
    assert.ok(!keys.includes('vapid_keys'), 'and never in the clear');
    assert.ok(!keys.includes('admin_people_secret'));
    assert.ok(!JSON.stringify(tables).includes(sealed.key), 'not even the public key shows anywhere');
    const blob = tables.settings.find((row) => row.key === 'vapid_keys_sealed').value;
    const { unsealSecret } = await import('../dist/seal.js');
    assert.equal(JSON.parse(await unsealSecret(blob, SEAL_KEY)).publicKey, sealed.key, 'the deployment can open it');
    assert.equal(await unsealSecret(blob, OTHER_SEAL_KEY), null, 'nobody else can');
    const page = await (await sealed.req('/admin', { as: 'admin' })).text();
    assert.match(page, /Push keys are\s+included, sealed with this deployment's BACKUP_SEAL_KEY/, 'and the Backup card says so');
  });

  test('without one: carries the subscribers and the access secrets, never the push keys', async () => {
    const { tables } = await (await plain.req('/admin/backup.json', { as: 'admin' })).json();
    const keys = tables.settings.map((row) => row.key);
    assert.ok(keys.includes('access_cookie_secret'));
    assert.ok(!keys.includes('vapid_keys'), 'the VAPID private key stays out of a file any admin can download');
    assert.ok(!keys.includes('vapid_keys_sealed'), 'nothing to seal it with, so it is left out');
    assert.ok(!keys.includes('admin_people_secret'));
    assert.ok(!JSON.stringify(tables).includes(plain.key), 'nor does the pair appear anywhere else');
    const page = await (await plain.req('/admin', { as: 'admin' })).text();
    assert.match(page, /leaves out the dashboard sign-in key and the push keys/);
  });
});

