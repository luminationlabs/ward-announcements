/**
 * The dashboard's "Download Backup (ZIP)" (`public/backup-zip.js`): what goes in the file. The
 * script runs verbatim in a `vm` with `fetch` stubbed as the server would answer, and its entries are
 * written with the real `public/zip.js` and read back: backup.json byte for byte as the JSON
 * download, every image under its key, a manifest — and an image that fails to download listed
 * there rather than stopping the backup.
 *
 * Node only, in process. Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const load = () => {
  const window = {};
  const context = { window, TextEncoder, TextDecoder, DecompressionStream, Blob, Response, console };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../public/zip.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../public/backup-zip.js', import.meta.url), 'utf8'), context);
  return window;
};

const K1 = '0123456789abcdef0123456789abcdef.png';
const K2 = 'fedcba9876543210fedcba9876543210.jpg';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('the zip holds backup.json as downloaded, each image, and a manifest naming what is missing', async () => {
  const { BackupZip, WardZip } = load();
  const json = JSON.stringify(
    {
      app: 'Test Ward',
      exported_at: '2026-10-01T00:00:00.000Z',
      tables: {
        settings: [{ key: 'schema_version', value: '8' }],
        attachments: [
          { id: 1, key: K1, content_type: 'image/png', size: PNG.length },
          { id: 2, key: K2, content_type: 'image/jpeg', size: 1234 },
        ],
      },
    },
    null,
    2,
  );
  const asked = [];
  const progress = [];
  const fetch = async (url, init) => {
    asked.push([url, init?.credentials]);
    if (url === '/admin/backup.json') return new Response(json, { status: 200 });
    if (url === `/images/${K1}`) return new Response(PNG, { status: 200 });
    return new Response('Not found', { status: 404 });
  };
  const built = await BackupZip.buildBackup({
    fetch,
    hostname: 'ward.example.org',
    now: new Date('2026-10-27T15:00:00Z'),
    onProgress: (p) => progress.push(`${p.done}/${p.total}`),
  });
  assert.deepEqual(asked, [
    ['/admin/backup.json', 'same-origin'],
    [`/images/${K1}`, 'same-origin'],
    [`/images/${K2}`, 'same-origin'],
  ]);
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
  assert.equal(built.filename, 'ward-announcements-backup-2026-10-27.zip');

  const files = await WardZip.readZip(WardZip.createZip(built.entries));
  const byName = Object.fromEntries(files.map((f) => [f.name, Buffer.from(f.data)]));
  assert.deepEqual(Object.keys(byName), ['backup.json', `images/${K1}`, 'manifest.json']);
  assert.equal(byName['backup.json'].toString(), json, 'byte for byte the JSON download');
  assert.deepEqual(byName[`images/${K1}`], PNG);
  const manifest = JSON.parse(byName['manifest.json'].toString());
  assert.equal(manifest.format, 'ward-announcements-backup');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.schema_version, 8);
  assert.equal(manifest.hostname, 'ward.example.org');
  assert.deepEqual(manifest.images, { count: 1, bytes: PNG.length, expected: 2 });
  assert.deepEqual(manifest.missing, [{ key: K2, error: 'HTTP 404' }]);
});

test('a backup.json that cannot be fetched stops it with a reason', async () => {
  const { BackupZip } = load();
  await assert.rejects(
    BackupZip.buildBackup({ fetch: async () => new Response('', { status: 302 }) }),
    /could not be downloaded \(302\)/,
  );
});

test("the operator page's Export: the same file from other URLs, named after the ward", async () => {
  const { BackupZip } = load();
  const json = JSON.stringify({ tables: { attachments: [{ id: 1, key: K1, content_type: 'image/png', size: PNG.length }] } });
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (url === '/wards/ward-a/export') return new Response(json, { status: 200 });
    if (url === `/wards/ward-a/images/${K1}`) return new Response(PNG, { status: 200 });
    return new Response('Not found', { status: 404 });
  };
  const built = await BackupZip.buildBackup({
    fetch,
    name: 'ward-a',
    now: new Date('2026-10-27T15:00:00Z'),
    dataUrl: '/wards/ward-a/export',
    imageUrl: (key) => `/wards/ward-a/images/${key}`,
  });
  assert.deepEqual(asked, ['/wards/ward-a/export', `/wards/ward-a/images/${K1}`]);
  assert.equal(built.filename, 'ward-a-backup-2026-10-27.zip');
  assert.equal(built.manifest.missing.length, 0);
  assert.equal(built.entries[0].data, json);
});

test('a session that has ended (a redirect to its sign-in page) stops it with a reason', async () => {
  const { BackupZip } = load();
  const signIn = new Response('<html>sign in</html>', { status: 200 });
  Object.defineProperty(signIn, 'redirected', { value: true });
  await assert.rejects(BackupZip.buildBackup({ fetch: async () => signIn }), /signed out/);
});
