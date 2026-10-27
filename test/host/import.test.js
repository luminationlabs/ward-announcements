/**
 * Import Backup on the many-ward host (`WardDO.importBackup` in src/host.ts, src/ward-import.ts,
 * src/restore.ts, and the operator's API and page in src/operator.ts). Local `wrangler dev` only,
 * with an R2 bucket bound so images land in the shared bucket under the ward's prefix; part of
 * `npm run test:host`.
 *
 * Ward A is `127.0.0.1` (the harness's "test"), ward B is `localhost`. Further wards live at names
 * that resolve nowhere, reached through the operator API, and the operator's page is
 * `ops.example.org`, reached with an explicit Host header (`wrangler dev` routes by it).
 *
 * The full backup is made by the dashboard's own code — `public/backup-zip.js` and `public/zip.js`
 * run in a `vm` against ward A — and unpacked with the same `zip.js` the operator page loads.
 *
 * The environment leaves VAPID keys unset, so each ward generates and stores its own pair, as a
 * production host does; that is what makes push keys something an import can carry or replace.
 * The host has a BACKUP_SEAL_KEY (the harness's TEST_SEAL_KEY), so a backup or export made here
 * carries its pair sealed, and an import here opens it (src/seal.ts).
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host-r2.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { default: http } = await import('node:http');
const { default: vm } = await import('node:vm');
const { readFileSync } = await import('node:fs');
const { webcrypto } = await import('node:crypto');
const { ADMIN_PASSWORD, ROOT, TEST_SEAL_KEY, addPersonWithPasskey, createClient, registerWard, startServer, testPort, unlockMember } =
  await import('../helpers/harness.js');
const { sealSecret, unsealSecret } = await import('../../src/seal.ts');

const OPS = 'ops.example.org';
/** The host's BACKUP_SEAL_KEY (made by the harness for this run), and a key of some other deployment. */
const SEAL_KEY = TEST_SEAL_KEY;
const OTHER_SEAL_KEY = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);

let server;
let port;
let a;
let b;
let zip; // the WardZip module, as the browser has it
let full; // { backup, images: Map<key, Buffer> } — ward A's full backup, unpacked
let memberCookie;

/** A request with any Host header, for hostnames that resolve nowhere. */
function hostRequest(host, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { host, ...(data ? { 'content-length': data.length } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${server.base}/__operator/${path}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${ADMIN_PASSWORD}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a 404 page */
  }
  return { status: res.status, body: json };
}

const exportOf = async (id) => (await api(`wards/${id}/export`)).body.tables;
/**
 * An export with its sealed pair opened, for comparing two exports: the seal uses a fresh IV each
 * time, so two exports of an unchanged ward differ in that one row and nowhere else.
 */
async function comparable(tables) {
  const settings = await Promise.all(
    tables.settings.map(async (r) => (r.key === 'vapid_keys_sealed' ? { key: 'vapid_keys', value: await unsealSecret(r.value, SEAL_KEY) } : r)),
  );
  return { ...tables, settings };
}
const stateOf = async (id) => (await api(`wards/${id}/state`)).body;
const importInto = (id, body) => api(`wards/${id}/import`, { method: 'POST', body });
const sendImages = (id, list) =>
  api(`wards/${id}/images`, { method: 'POST', body: { images: list.map(([key, data]) => ({ key, data: Buffer.from(data).toString('base64') })) } });

/**
 * Everything in a ward that an import must carry across unchanged. Not `admin_invites`: the
 * dashboard's backup leaves out pending invites (live sign-in links) and the people secret, so a
 * leaked backup is no way into the dashboard — see `/admin/backup.json` in app.ts.
 */
const CONTENT = ['announcements', 'pages', 'programs', 'attachments', 'subscriptions', 'access_codes', 'access_tokens', 'admin_users', 'admin_passkeys', 'send_log', 'send_skips'];
const settingsOf = (tables) => Object.fromEntries(tables.settings.map((r) => [r.key, r.value]));
/** A ward's stored pair, opened from the sealed row its export carries (never a plaintext one). */
async function pairOf(tables) {
  const s = settingsOf(tables);
  assert.equal(s.vapid_keys, undefined, 'an export never carries the pair in the clear');
  assert.ok(s.vapid_keys_sealed, 'the export carries it sealed');
  const opened = await unsealSecret(s.vapid_keys_sealed, SEAL_KEY);
  assert.ok(opened, "and the host's key opens it");
  return JSON.parse(opened);
}

before(async () => {
  server = await startServer({
    port: testPort(18),
    env: { OPERATOR_HOST: OPS, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
  });
  port = new URL(server.base).port;
  a = createClient(server.base);
  b = createClient(server.base.replace('127.0.0.1', 'localhost'));
  await registerWard(server.base, { id: 'ward-b', hostname: 'localhost' });
  for (const id of ['ward-c', 'ward-d']) await registerWard(server.base, { id, hostname: `${id}.example.org` });

  const context = { window: {}, TextEncoder, TextDecoder, DecompressionStream, Blob, Response, console };
  vm.createContext(context);
  vm.runInContext(readFileSync(`${ROOT}/public/zip.js`, 'utf8'), context);
  vm.runInContext(readFileSync(`${ROOT}/public/backup-zip.js`, 'utf8'), context);
  zip = context.window.WardZip;

  // Ward A, with something in every corner an import has to carry.
  await a('/admin/login', { as: 'owner', method: 'POST', form: { password: ADMIN_PASSWORD } });
  await a('/admin/announcements', { as: 'owner', method: 'POST', form: { title: 'Ward picnic', body: 'Saturday at *noon*', published: '1' } });
  const html = await (await a('/admin', { as: 'owner' })).text();
  const announcementId = html.match(/<li class="row" data-id="(\d+)"/)?.[1];
  for (const [bytes, type, name] of [[PNG, 'image/png', 'flyer.png'], [JPEG, 'image/jpeg', 'map.jpg']]) {
    const data = new FormData();
    data.append('owner_type', 'announcement');
    data.append('owner_id', announcementId);
    data.append('file', new Blob([bytes], { type }), name);
    assert.equal((await a('/admin/attachments', { as: 'owner', method: 'POST', formData: data })).status, 201);
  }
  await a('/admin/pages', { as: 'owner', method: 'POST', form: { title: 'Bishopric', body: 'Office hours', published: '1' } });
  const person = await addPersonWithPasskey(a, { as: 'clerk', origin: server.base, adminAs: 'owner', role: 'admin', name: 'Ward Clerk' });
  assert.equal(person.verify.status, 200);
  await unlockMember(a, 'member', { adminAs: 'owner' });
  const unlocked = await a('/api/announcements', { as: 'member' });
  assert.equal(unlocked.status, 200);
  // The member's cookie, to present to ward B by hand (it is host-only in a browser).
  memberCookie = (await a('/api/announcements', { as: 'member' })).headers.getSetCookie().find((l) => l.startsWith('pushannounce_access='))?.split(';')[0];
  assert.ok(memberCookie, 'a member cookie');

  // A's full backup, made by the dashboard's own Backup button code.
  const built = await context.window.BackupZip.buildBackup({
    fetch: (url) => a(url, { as: 'owner' }),
    hostname: '127.0.0.1',
  });
  assert.equal(built.manifest.images.count, 2);
  const files = await zip.readZip(zip.createZip(built.entries));
  full = { backup: null, images: new Map() };
  for (const f of files) {
    if (f.name === 'backup.json') full.backup = JSON.parse(Buffer.from(f.data).toString('utf8'));
    else if (f.name.startsWith('images/')) full.images.set(f.name.slice('images/'.length), Buffer.from(f.data));
  }
});
after(() => server?.stop());

/** The push key a ward hands its members (the route is behind the member gate). */
async function vapidKeyOf(client) {
  const res = await client('/api/vapid-public-key', { headers: { cookie: memberCookie } });
  assert.equal(res.status, 200);
  return (await res.json()).key;
}

/** A copy of A's backup to change. */
const backupCopy = () => structuredClone(full.backup);

/** The local (America/Denver) weekday and time `minutes` from now, as the schedule settings spell them. */
function localSlot(minutes) {
  const at = new Date(Date.now() + minutes * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dow: String(dow), time: `${parts.hour}:${parts.minute}` };
}

test("ward A's full backup, imported into ward B: the same ward, images and all", async () => {
  // Before: B is its own ward, and A's member cookie means nothing to it.
  assert.equal((await b('/api/announcements', { headers: { cookie: memberCookie } })).status, 401);
  const alarmBefore = (await stateOf('ward-b')).alarm;

  // The schedule moved to a few minutes from now, so the re-derived alarm is plain to see.
  const backup = backupCopy();
  const slot = localSlot(6);
  for (const [key, value] of Object.entries({ schedule_dow: slot.dow, schedule_time: slot.time, auto_send_enabled: '1' })) {
    const row = backup.tables.settings.find((r) => r.key === key);
    if (row) row.value = value;
    else backup.tables.settings.push({ key, value });
  }

  const res = await importInto('ward-b', { backup, confirm: 'localhost' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const report = res.body;
  assert.equal(report.fromVersion, report.toVersion);
  assert.deepEqual(report.dropped, {});
  assert.equal(report.push.source, 'backup', "the dashboard's backup carries A's pair sealed, and this host opens it");
  assert.equal(report.push.sealed, 'opened');
  assert.equal(report.images.count, 2);
  assert.equal(report.people, 1);
  assert.equal(report.passkeys, 1);
  // A hosted ward's backup names its address, which is not B's: passkeys will not carry over.
  assert.equal(report.origin.backup, 'https://127.0.0.1');
  assert.equal(report.origin.matches, false);
  assert.match(report.warnings.join(' '), /comes from https:\/\/127\.0\.0\.1, but this ward is https:\/\/localhost/);
  const announcements = report.tables.find((t) => t.name === 'announcements');
  assert.equal(announcements.rows, full.backup.tables.announcements.length);

  // The alarm was re-derived from the imported schedule.
  const alarm = (await stateOf('ward-b')).alarm;
  assert.notEqual(alarm, alarmBefore);
  assert.ok(alarm > Date.now() + 3 * 60_000 && alarm < Date.now() + 9 * 60_000, `alarm at ${new Date(alarm).toISOString()}`);

  // Images: restored, then (sent again) already there.
  const all = [...full.images];
  const first = await sendImages('ward-b', all);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.results.map((r) => r.status), ['restored', 'restored']);
  const again = await sendImages('ward-b', all);
  assert.deepEqual(again.body.results.map((r) => r.status), ['skipped', 'skipped']);
  for (const [key, bytes] of full.images) {
    const served = await b(`/images/${key}`);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes, 'served byte for byte');
  }

  // The content, ids and all.
  const tablesA = await exportOf('test');
  const tablesB = await exportOf('ward-b');
  for (const table of CONTENT) assert.deepEqual(tablesB[table], tablesA[table], table);
  const sA = settingsOf(tablesA);
  const sB = settingsOf(tablesB);
  for (const key of ['access_cookie_secret', 'ward_settings']) {
    assert.equal(sB[key], sA[key], key);
  }
  assert.deepEqual(await pairOf(tablesB), await pairOf(tablesA), "A's push keys came across, sealed in the backup and opened here");
  assert.deepEqual(tablesB.admin_invites, [], 'no dashboard invite came across');
  assert.notEqual(sB.admin_people_secret, sA.admin_people_secret, 'nor the key that signs dashboard sessions');
  assert.equal(JSON.parse(sB.host_ward_identity).hostname, 'localhost', 'B keeps its own place on the host');

  // A member of A is a member of B: the cookie key came across, so the same cookie opens it.
  const member = await b('/api/announcements', { headers: { cookie: memberCookie } });
  assert.equal(member.status, 200);
  assert.ok((await member.json()).announcements.some((x) => x.title === 'Ward picnic'));
  // And B now signs pushes with A's keys, so every subscription that came across keeps working:
  // the dashboard's backup is the one file an admin keeps for years, so the pair travels in it
  // sealed under the host's BACKUP_SEAL_KEY, which this import opened.
  const keyOfA = await vapidKeyOf(a);
  assert.match(keyOfA, /^B[\w-]{86}$/);
  assert.equal(await vapidKeyOf(b), keyOfA);
  assert.equal(await unsealSecret(settingsOf(full.backup.tables).vapid_keys_sealed, OTHER_SEAL_KEY), null, 'the file alone opens nothing');
});

test("a backup sealed under another deployment's key: the ward keeps its own pair, and the operator is told", async () => {
  const pair = { publicKey: 'B-elsewhere', privateKey: 'elsewhere' };
  const backup = backupCopy();
  backup.tables.settings = backup.tables.settings.filter((r) => r.key !== 'vapid_keys_sealed');
  backup.tables.settings.push({ key: 'vapid_keys_sealed', value: await sealSecret(JSON.stringify(pair), OTHER_SEAL_KEY) });
  const own = await pairOf(await exportOf('ward-c'));

  const res = await importInto('ward-c', { backup, confirm: 'ward-c.example.org' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.push.source, 'ward');
  assert.equal(res.body.push.sealed, 'locked');
  assert.equal(res.body.push.publicKey, own.publicKey);
  assert.match(res.body.warnings.join(' '), /sealed with another deployment's key \(or this host has no BACKUP_SEAL_KEY\); the ward keeps its own pair/);
  const after = await exportOf('ward-c');
  assert.deepEqual(await pairOf(after), own, 'C still signs with the pair it had');
  assert.ok(!JSON.stringify(after).includes('elsewhere'), 'and the locked blob was not written anywhere');
});

test('a backup from the old code: its extra column is dropped and reported', async () => {
  const backup = backupCopy();
  backup.tables.subscriptions = [
    { id: 41, endpoint: 'https://push.example/old', p256dh: 'p', auth: 'a', user_agent: 'iPhone', created_at: '2026-01-01 00:00:00', last_success_at: null, failure_count: 0, label: 'Mom' },
  ];
  backup.tables.settings.find((r) => r.key === 'schema_version').value = '5';
  delete backup.tables.admin_users;
  const res = await importInto('ward-c', { backup, confirm: 'ward-c.example.org' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.dropped, { subscriptions: ['label'] });
  assert.equal(res.body.fromVersion, 5);
  assert.ok(res.body.tables.find((t) => t.name === 'admin_users').inBackup === false);
  const tables = await exportOf('ward-c');
  assert.equal(tables.subscriptions[0].id, 41);
  assert.equal('label' in tables.subscriptions[0], false);
  assert.equal(tables.admin_users.length, 0, 'a table the backup predates is left empty');
  assert.equal(settingsOf(tables).schema_version, String(res.body.toVersion), 'migrated to this version');
});

test('a subscription that is not at a push service is left out, and the operator told', async () => {
  // Every subscription is a URL the host POSTs to on each send. /api/subscribe only stores real
  // push services, but a backup is a file — and one row naming an internal address would have every
  // Sunday's digest go there.
  const backup = backupCopy();
  const sub = (id, endpoint) => ({ id, endpoint, p256dh: 'p', auth: 'a', user_agent: 'iPhone', created_at: '2026-01-01 00:00:00', last_success_at: null, failure_count: 0 });
  backup.tables.subscriptions = [
    sub(51, 'https://push.example/fine'),
    sub(52, 'http://push.example/not-https'),
    sub(53, 'https://10.0.0.5/internal'),
    sub(54, 'https://localhost/x'),
    sub(55, 'not a url'),
  ];
  const res = await importInto('ward-c', { backup, confirm: 'ward-c.example.org' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.subscribers, 1);
  assert.ok(res.body.warnings.some((w) => /4 subscription\(s\) in the backup were not at a push service/.test(w)), res.body.warnings.join('\n'));
  assert.deepEqual((await exportOf('ward-c')).subscriptions.map((r) => r.id), [51]);
});

test('a bad file, a non-backup or a newer schema is refused, and the ward is unchanged', async () => {
  const before = await comparable(await exportOf('ward-d'));
  const refusals = [
    [{ backup: 'just text', confirm: 'ward-d.example.org' }, /Choose a backup file/],
    [{ backup: { hello: 'world' }, confirm: 'ward-d.example.org' }, /no "tables"/],
    [{ backup: { tables: { mystery: [] } }, confirm: 'ward-d.example.org' }, /this version does not: mystery/],
    [{ backup: { tables: { settings: [{ key: 'schema_version', value: '999' }] } }, confirm: 'ward-d.example.org' }, /newer version/],
  ];
  for (const [body, pattern] of refusals) {
    const res = await importInto('ward-d', body);
    assert.equal(res.status, 400);
    assert.match(res.body.error, pattern);
  }
  assert.deepEqual(await comparable(await exportOf('ward-d')), before);
});

test('an import that fails part-way through writing leaves the ward exactly as it was', async () => {
  const before = await comparable(await exportOf('ward-d'));
  const backup = backupCopy();
  // Two announcements with one id: the second insert fails, deep inside the transaction.
  backup.tables.announcements.push({ ...backup.tables.announcements[0], title: 'Duplicate' });
  const res = await importInto('ward-d', { backup, confirm: 'ward-d.example.org' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nothing was changed.*UNIQUE/);
  assert.deepEqual(await comparable(await exportOf('ward-d')), before);
  const state = await stateOf('ward-d');
  assert.ok(state.alarm > Date.now(), 'still running, alarm and all');
});

test('the confirmation must be the ward’s address', async () => {
  const res = await importInto('ward-d', { backup: backupCopy(), confirm: 'ward-d' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /type its address \("ward-d\.example\.org"\)/);
});

test('push keys given with the import are checked and stored; the ward then serves them', async () => {
  // That a stored pair is what a send signs with is shown in process (test/restore.test.js): the
  // push library posts only to https, which a local push-service stub cannot be here.
  const subtle = webcrypto.subtle;
  const b64 = (buf) => Buffer.from(buf).toString('base64url');
  const vapid = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64(await subtle.exportKey('raw', vapid.publicKey));
  const privateKey = (await subtle.exportKey('jwk', vapid.privateKey)).d;
  const other = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);

  const before = await comparable(await exportOf('ward-b'));
  const mismatched = await importInto('ward-b', {
    backup: backupCopy(),
    confirm: 'localhost',
    vapidPublicKey: publicKey,
    vapidPrivateKey: (await subtle.exportKey('jwk', other.privateKey)).d,
  });
  assert.equal(mismatched.status, 400);
  assert.match(mismatched.body.error, /does not belong/);
  assert.deepEqual(await comparable(await exportOf('ward-b')), before, 'refused before anything was written');

  // The operator's export carries A's pair (sealed, and opened here), so this is the case where
  // the keys given replace keys the file already had.
  const res = await importInto('ward-b', {
    backup: { ...backupCopy(), tables: await exportOf('test') },
    confirm: 'localhost',
    vapidPublicKey: publicKey,
    vapidPrivateKey: privateKey,
    vapidSubject: 'mailto:clerk@example.org',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.push.source, 'supplied');
  assert.equal(res.body.push.sealed, 'opened');
  assert.match(res.body.warnings.join(' '), /push keys of its own; the ones you gave replace them/);
  assert.deepEqual(await pairOf(await exportOf('ward-b')), {
    publicKey,
    privateKey,
    subject: 'mailto:clerk@example.org',
  });
  assert.equal(await vapidKeyOf(b), publicKey, 'members subscribe (and are signed for) with the old key');
});

test('images are taken only for keys the restored rows name, of their type, and really images', async () => {
  const [[pngKey], [jpgKey]] = [...full.images];
  const res = await sendImages('ward-c', [
    ['ffffffffffffffffffffffffffffffff.png', PNG], // no such row
    [jpgKey, PNG], // a JPEG row, PNG bytes
    ['../../escape.png', PNG],
    [pngKey, full.images.get(pngKey)],
  ]);
  assert.equal(res.status, 200);
  const [unknown, wrongType, traversal, good] = res.body.results;
  assert.match(unknown.error, /no image of that name/);
  assert.match(wrongType.error, /not a JPEG/);
  assert.match(traversal.error, /not an image name/);
  assert.equal(good.status, 'restored');
});

test('only the operator: no password, no session or another site is refused', async () => {
  assert.equal((await api('wards/ward-d/import', { method: 'POST', body: { backup: backupCopy(), confirm: 'ward-d.example.org' }, auth: false })).status, 404);
  assert.equal((await api('wards/ward-d/images', { method: 'POST', body: { images: [] }, auth: false })).status, 404);
  const json = { 'content-type': 'application/json' };
  const anon = await hostRequest(OPS, '/wards/ward-d/import', { method: 'POST', headers: json, body: '{}' });
  assert.equal(anon.status, 401);
  assert.equal((await hostRequest(OPS, '/zip.js')).status, 404, 'not even the zip reader without a session');

  const login = await hostRequest(OPS, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${OPS}` },
    body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
  });
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const crossSite = await hostRequest(OPS, '/wards/ward-d/import', { method: 'POST', headers: { ...json, cookie, origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossSite.status, 403);

  const page = await hostRequest(OPS, '/', { headers: { cookie } });
  assert.match(page.text, /data-import="ward-d" data-host="ward-d\.example\.org">Import Backup</);
  assert.match(page.text, /Keep members' notifications working \(optional\)/);
  const reader = await hostRequest(OPS, '/zip.js', { headers: { cookie } });
  assert.equal(reader.status, 200);
  assert.match(reader.text, /WardZip/);

  // The page's own calls: a refusal comes back as JSON with its message …
  const wrong = await hostRequest(OPS, '/wards/ward-d/import', {
    method: 'POST',
    headers: { ...json, cookie, origin: `http://${OPS}` },
    body: JSON.stringify({ backup: backupCopy(), confirm: 'nope' }),
  });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json().error, /type its address/);
  // … and an import goes through, images after it.
  const ok = await hostRequest(OPS, '/wards/ward-d/import', {
    method: 'POST',
    headers: { ...json, cookie, origin: `http://${OPS}` },
    body: JSON.stringify({ backup: backupCopy(), confirm: 'ward-d.example.org' }),
  });
  assert.equal(ok.status, 200, ok.text);
  const [key, bytes] = [...full.images][0];
  const images = await hostRequest(OPS, '/wards/ward-d/images', {
    method: 'POST',
    headers: { ...json, cookie, origin: `http://${OPS}` },
    body: JSON.stringify({ images: [{ key, data: bytes.toString('base64') }] }),
  });
  assert.equal(images.status, 200);
  assert.equal(images.json().results[0].status, 'restored');
  // Too big for one request: refused before it reaches the ward.
  const huge = await hostRequest(OPS, '/wards/ward-d/images', {
    method: 'POST',
    headers: { ...json, cookie, origin: `http://${OPS}` },
    body: JSON.stringify({ images: [{ key, data: 'A'.repeat(9 * 1024 * 1024) }] }),
  });
  assert.equal(huge.status, 413);
});
