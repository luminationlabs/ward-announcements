/**
 * Export on the many-ward host's operator page: the ward's full backup — the same ZIP its own Backup
 * button makes — built in the operator's browser by `public/backup-zip.js` from the page's
 * `/wards/:id/export` (the data) and `/wards/:id/images/:key` (each image, read through the ward's
 * own store), so Export and Import Backup take one file. Local `wrangler dev` only, with an R2
 * bucket bound so images live in the shared bucket under each ward's prefix; part of
 * `npm run test:host`. (`test/host/operator.test.js` reads an image without R2, from `file_chunks`.)
 *
 * Ward A is `127.0.0.1` (the harness's "test"), ward B is `localhost`, and the operator's page is
 * `ops.example.org`, reached with an explicit Host header (`wrangler dev` routes by it).
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host-r2.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { default: http } = await import('node:http');
const { default: vm } = await import('node:vm');
const { readFileSync } = await import('node:fs');
const { ADMIN_PASSWORD, ROOT, TEST_SEAL_KEY, createClient, registerWard, startServer, testPort } = await import('../helpers/harness.js');

const OPS = 'ops.example.org';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);
const JPEG_B = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 7), Buffer.from([0xff, 0xd9])]);
const UNKNOWN = '00000000000000000000000000000000.png';

let server;
let port;
let a;
let b;
let cookie; // the operator's session
let keysA; // key -> bytes, ward A's images
let keyB; // ward B's own image, before the import

/** A request with any Host header; the body comes back as bytes. */
function hostRequest(host, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { host, ...(data ? { 'content-length': data.length } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8')) });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const asOperator = (path, options = {}) =>
  hostRequest(OPS, path, { ...options, headers: { cookie, ...(options.method === 'POST' ? { 'content-type': 'application/json', origin: `http://${OPS}` } : {}), ...options.headers } });

/** The operator page's `fetch`, as the browser would make it: same origin, the session cookie. */
const pageFetch = async (url) => {
  const res = await asOperator(url);
  return new Response(res.status === 204 || res.status === 304 ? null : res.bytes, {
    status: res.status,
    headers: { 'content-type': res.headers['content-type'] ?? '' },
  });
};

async function upload(client, bytes, type, name) {
  await client('/admin/announcements', { as: 'owner', method: 'POST', form: { title: `With ${name}`, body: 'x', published: '1' } });
  const html = await (await client('/admin', { as: 'owner' })).text();
  const id = html.match(/<li class="row" data-id="(\d+)"/)?.[1];
  const data = new FormData();
  data.append('owner_type', 'announcement');
  data.append('owner_id', id);
  data.append('file', new Blob([bytes], { type }), name);
  const res = await client('/admin/attachments', { as: 'owner', method: 'POST', formData: data });
  assert.equal(res.status, 201);
  return (await res.json()).key;
}

const api = async (path) => {
  const res = await fetch(`${server.base}/__operator/${path}`, { headers: { authorization: `Bearer ${ADMIN_PASSWORD}` } });
  return res;
};

before(async () => {
  server = await startServer({ port: testPort(19), env: { OPERATOR_HOST: OPS } });
  port = new URL(server.base).port;
  a = createClient(server.base);
  b = createClient(server.base.replace('127.0.0.1', 'localhost'));
  await registerWard(server.base, { id: 'ward-b', hostname: 'localhost' });
  await a('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  await b('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  keysA = new Map([
    [await upload(a, PNG, 'image/png', 'flyer.png'), PNG],
    [await upload(a, JPEG, 'image/jpeg', 'map.jpg'), JPEG],
  ]);
  await a('/admin/pages', { as: 'owner', method: 'POST', form: { title: 'Bishopric', body: 'Office hours', published: '1' } });
  keyB = await upload(b, JPEG_B, 'image/jpeg', 'b.jpg');

  const login = await hostRequest(OPS, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${OPS}` },
    body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
  });
  assert.equal(login.status, 303);
  cookie = login.headers['set-cookie'][0].split(';')[0];
});
after(() => server?.stop());

test("the image route serves a ward's image from its own store, to the operator only", async () => {
  const [key, bytes] = [...keysA][0];
  const res = await asOperator(`/wards/test/images/${key}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.bytes, bytes, 'byte for byte');
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'private, no-store');

  // No session: refused, as JSON (the page's script reads it), not a redirect a fetch would follow.
  const anon = await hostRequest(OPS, `/wards/test/images/${key}`);
  assert.equal(anon.status, 401);
  assert.notDeepEqual(anon.bytes, bytes);
  const forged = await hostRequest(OPS, `/wards/test/images/${key}`, { headers: { cookie: 'operator_session=1.abc' } });
  assert.equal(forged.status, 401);
  // On a ward's own hostname the path is the ward's (its member gate), never the operator's route.
  const onWard = await a(`/wards/test/images/${key}`);
  assert.notDeepEqual(Buffer.from(await onWard.arrayBuffer()), bytes);

  // The API has it too, behind the bearer password.
  const viaApi = await api(`wards/test/images/${key}`);
  assert.equal(viaApi.status, 200);
  assert.deepEqual(Buffer.from(await viaApi.arrayBuffer()), bytes);
  assert.equal((await fetch(`${server.base}/__operator/wards/test/images/${key}`)).status, 404);
});

test("a ward's image route cannot reach another ward's images", async () => {
  const [keyA, bytesA] = [...keysA][0];
  assert.equal((await asOperator(`/wards/ward-b/images/${keyA}`)).status, 404, "B's route does not serve A's image");
  assert.equal((await asOperator(`/wards/test/images/${keyB}`)).status, 404, "A's route does not serve B's image");
  const own = await asOperator(`/wards/ward-b/images/${keyB}`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.bytes, JPEG_B);
  assert.equal((await asOperator(`/wards/test/images/${keyA}`)).bytes.equals(bytesA), true);
});

test('an unknown key, a key of the wrong shape or an unknown ward is a 404', async () => {
  assert.equal((await asOperator(`/wards/test/images/${UNKNOWN}`)).status, 404);
  for (const bad of ['flyer.png', '..%2F..%2Fsecret', `${'A'.repeat(32)}.png`, `${[...keysA][0][0]}x/`]) {
    assert.equal((await asOperator(`/wards/test/images/${bad}`)).status, 404, bad);
  }
  assert.equal((await asOperator(`/wards/no-such-ward/images/${[...keysA][0][0]}`)).status, 404);
  assert.equal((await api(`wards/test/images/${UNKNOWN}`)).status, 404);
});

test('the page offers Export (the ZIP) and the JSON, and serves the backup code', async () => {
  const page = await asOperator('/');
  assert.match(page.text, /data-export="test" data-host="127\.0\.0\.1">Export</);
  assert.match(page.text, /id="exp-json"[^>]*>Data Only \(JSON\)</, 'Export offers the data-only JSON too');
  assert.match(page.text, /<script src="\/backup-zip\.js"><\/script>/);
  const code = await asOperator('/backup-zip.js');
  assert.equal(code.status, 200);
  assert.match(code.text, /BackupZip/);
  assert.equal((await hostRequest(OPS, '/backup-zip.js')).status, 404, 'not without a session');
  const json = await asOperator('/wards/test/export');
  assert.equal(json.status, 200);
  assert.match(json.headers['content-disposition'], /filename="test-backup-\d{4}-\d{2}-\d{2}\.json"/);
  assert.ok(json.json().tables.attachments.length >= 2);
});

test("the export carries the ward's push keys sealed under the host's BACKUP_SEAL_KEY, never in the clear", async () => {
  // The host has a seal key (test/wrangler.host-r2.jsonc), so the one file that used to carry the
  // private key in plaintext now carries it sealed: an import back here opens it (import.test.js),
  // and the file alone cannot send.
  const { unsealSecret } = await import('../../src/seal.ts');
  const { tables } = (await api('wards/test/export').then((r) => r.json()));
  const settings = Object.fromEntries(tables.settings.map((r) => [r.key, r.value]));
  assert.equal(settings.vapid_keys, undefined);
  assert.ok(settings.vapid_keys_sealed);
  assert.equal(JSON.parse(settings.vapid_keys_sealed).alg, 'A256GCM');
  const opened = JSON.parse(await unsealSecret(settings.vapid_keys_sealed, TEST_SEAL_KEY));
  assert.match(opened.publicKey, /^B[\w-]{86}$/);
  assert.ok(opened.privateKey);
  assert.ok(!JSON.stringify(tables).includes(opened.privateKey), 'the private key appears nowhere in the file');
  assert.ok(settings.admin_people_secret, 'the people-session key still travels: the export is the operator\'s, as documented');
});

test("Export's ZIP of ward A, imported into ward B through Import Backup: the same content, image for image", async () => {
  // The page's own code, run as the browser runs it, against the page's routes.
  const context = { window: {}, TextEncoder, TextDecoder, DecompressionStream, Blob, Response, console };
  vm.createContext(context);
  vm.runInContext(readFileSync(`${ROOT}/public/zip.js`, 'utf8'), context);
  vm.runInContext(readFileSync(`${ROOT}/public/backup-zip.js`, 'utf8'), context);
  const { BackupZip, WardZip } = context.window;
  const progress = [];
  const now = new Date();
  const built = await BackupZip.buildBackup({
    fetch: pageFetch,
    hostname: '127.0.0.1',
    name: 'test',
    now,
    dataUrl: '/wards/test/export',
    imageUrl: (key) => `/wards/test/images/${encodeURIComponent(key)}`,
    onProgress: (p) => progress.push(`${p.done}/${p.total}`),
  });
  assert.equal(built.filename, `test-backup-${now.toISOString().slice(0, 10)}.zip`);
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
  assert.equal(built.manifest.missing.length, 0, JSON.stringify(built.manifest.missing)); // (an array of the vm's realm)
  assert.equal(built.manifest.images.count, 2);
  assert.equal(built.manifest.hostname, '127.0.0.1');
  assert.match(String(built.manifest.schema_version), /^\d+$/);

  // The file, written and read back as the import dialog reads it.
  const files = await WardZip.readZip(WardZip.createZip(built.entries));
  const names = [...files].map((f) => f.name); // out of the vm's realm, for deepEqual
  assert.deepEqual(names.filter((n) => n.startsWith('images/')).sort(), [...keysA.keys()].map((k) => `images/${k}`).sort());
  assert.equal(names.at(-1), 'manifest.json');
  const backup = JSON.parse(Buffer.from(files.find((f) => f.name === 'backup.json').data).toString('utf8'));
  const images = files.filter((f) => f.name.startsWith('images/')).map((f) => [f.name.slice('images/'.length), Buffer.from(f.data)]);
  for (const [key, bytes] of images) assert.deepEqual(bytes, keysA.get(key), key);

  // Into ward B, through the operator page's Import Backup routes.
  const imported = await asOperator('/wards/ward-b/import', { method: 'POST', body: JSON.stringify({ backup, confirm: 'localhost' }) });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.json().images.count, 2);
  const stored = await asOperator('/wards/ward-b/images', {
    method: 'POST',
    body: JSON.stringify({ images: images.map(([key, bytes]) => ({ key, data: bytes.toString('base64') })) }),
  });
  assert.equal(stored.status, 200, stored.text);
  assert.deepEqual(stored.json().results.map((r) => r.status), ['restored', 'restored']);

  // The same content, ids and all …
  const tablesA = (await (await api('wards/test/export')).json()).tables;
  const tablesB = (await (await api('wards/ward-b/export')).json()).tables;
  for (const table of ['announcements', 'pages', 'programs', 'attachments', 'admin_users', 'access_codes']) {
    assert.deepEqual(tablesB[table], tablesA[table], table);
  }
  // … and every image byte for byte: through B's operator route, and as B serves it to members.
  for (const [key, bytes] of keysA) {
    assert.deepEqual((await asOperator(`/wards/ward-b/images/${key}`)).bytes, bytes, key);
    const served = await b(`/images/${key}`);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes, key);
  }
  // B's own image, which the restored rows do not name, is gone.
  assert.equal((await asOperator(`/wards/ward-b/images/${keyB}`)).status, 404);
});
