/**
 * The operator's tools on the many-ward host (`src/operator.ts`): the API and the page, and the
 * per-ward image quota a hosted deployment sets. Local `wrangler dev` only; part of
 * `npm run test:host`.
 *
 * Hostnames: `127.0.0.1` is the ward the harness registers ("test"); `localhost` is OPERATOR_HOST,
 * where the operator's page lives. Other wards are registered under names that resolve nowhere —
 * enough for the registry and the operator API, which reach a ward without its hostname.
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host.jsonc';

const { test, before, after, describe } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ADMIN_PASSWORD, TEST_SEAL_KEY, TEST_VAPID, createClient, startServer, testPort } = await import('../helpers/harness.js');

let server;
let ward;
let page;
let bigKey; // an image the quota test stores in ward "test"

before(async () => {
  server = await startServer({ port: testPort(12), env: { OPERATOR_HOST: 'localhost', IMAGE_QUOTA_MB: '1' } });
  ward = createClient(server.base);
  page = createClient(server.base.replace('127.0.0.1', 'localhost'));
});
after(() => server?.stop());

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${server.base}/__operator/${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('the operator API', () => {
  test('the report shows every ward with its schema version', async () => {
    const { status, body } = await api('report');
    assert.equal(status, 200);
    const test = body.find((w) => w.id === 'test');
    assert.equal(test.status, 'active');
    assert.equal(test.hostname, '127.0.0.1');
    assert.match(String(test.schemaVersion), /^\d+$/);
    assert.ok(test.alarm > Date.now());
  });

  test('a new ward can come with its first admin invite', async () => {
    const { status, body } = await api('wards', {
      method: 'POST',
      body: {
        id: 'example-2nd',
        hostname: 'example2nd.example.org',
        name: 'Example 2nd Ward',
        shortName: 'Example 2nd',
        timezone: 'America/Phoenix',
        admin: 'Sister Admin',
      },
    });
    assert.equal(status, 201);
    assert.match(body.invite, /^https:\/\/example2nd\.example\.org\/admin\/invite#t=[\w-]{20,}$/);
    // Its own data, and the name it was given.
    const exported = await api('wards/example-2nd/export');
    const people = exported.body.tables.admin_users;
    assert.equal(people.length, 1);
    assert.equal(people[0].role, 'admin');
    const wardSettings = exported.body.tables.settings.find((r) => r.key === 'ward_settings');
    const saved = JSON.parse(wardSettings.value);
    assert.equal(saved.appName, 'Example 2nd Ward');
    assert.equal(saved.appShortName, 'Example 2nd', 'the home-screen name the operator chose');
    assert.equal(saved.timezone, 'America/Phoenix');
  });

  test('a host-wide VAPID pair is ignored: every ward signs with a pair of its own', async () => {
    // The harness passes VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to every server it starts, this one
    // included. On the host they are one deployment's vars, not a ward's: with them let through,
    // every ward signed with one key while its own stored pair said otherwise.
    // The export carries each pair sealed under the host's BACKUP_SEAL_KEY (test/wrangler.host.jsonc).
    const { unsealSecret } = await import('../../src/seal.ts');
    const pairOf = async (id) => {
      const { tables } = (await api(`wards/${id}/export`)).body;
      assert.ok(!tables.settings.some((r) => r.key === 'vapid_keys'), 'never in the clear');
      return JSON.parse(await unsealSecret(tables.settings.find((r) => r.key === 'vapid_keys_sealed').value, TEST_SEAL_KEY));
    };
    const [a, b] = await Promise.all([pairOf('test'), pairOf('example-2nd')]);
    assert.ok(a.publicKey && b.publicKey, 'each ward stored a pair of its own');
    assert.notEqual(a.publicKey, TEST_VAPID.publicKey, "not the host's");
    assert.notEqual(a.publicKey, b.publicKey, 'and not each other\'s');
  });

  test('bad ids, bad hostnames and duplicates are refused', async () => {
    assert.equal((await api('wards', { method: 'POST', body: { id: 'X!', hostname: 'a.example' } })).status, 400);
    assert.equal((await api('wards', { method: 'POST', body: { id: 'ok-id', hostname: 'not a host' } })).status, 400);
    assert.equal((await api('wards', { method: 'POST', body: { id: 'example-2nd', hostname: 'other.example' } })).status, 409);
    assert.equal((await api('wards', { method: 'POST', body: { id: 'other', hostname: 'example2nd.example.org' } })).status, 409);
  });

  test('a suspended ward is closed to everyone, and opens again on resume', async () => {
    assert.equal((await ward('/')).status, 200);
    assert.equal((await api('wards/test/suspend', { method: 'POST' })).status, 200);
    assert.equal((await ward('/')).status, 503);
    assert.equal((await ward('/admin/login')).status, 503);
    // …and it stops *sending*: no alarm while suspended, so no Sunday digest to members it shut out.
    const suspended = (await api('wards/test/state')).body;
    assert.equal(suspended.suspended, true);
    assert.equal(suspended.alarm, null);
    assert.equal((await api('wards/test/resume', { method: 'POST' })).status, 200);
    assert.equal((await ward('/')).status, 200);
    assert.ok((await api('wards/test/state')).body.alarm > Date.now(), 'resumed with its alarm');
  });

  test('a moved ward answers on its new address only — and keeps its data', async () => {
    const before = (await api('wards/test/export')).body.tables.access_codes;
    assert.equal((await api('wards/test/move', { method: 'POST', body: { hostname: 'moved.example.org' } })).status, 200);
    assert.equal((await ward('/')).status, 404, 'the old address no longer has a ward');
    const invite = await api('wards/test/invite', { method: 'POST', body: { admin: 'Brother New' } });
    assert.match(invite.body.invite, /^https:\/\/moved\.example\.org\/admin\/invite#t=/);
    assert.equal((await api('wards/test/move', { method: 'POST', body: { hostname: '127.0.0.1' } })).status, 200);
    assert.equal((await ward('/')).status, 200);
    assert.deepEqual((await api('wards/test/export')).body.tables.access_codes, before);
  });

  test('a delete must be confirmed with the id; afterwards the id starts from nothing', async () => {
    await api('wards', { method: 'POST', body: { id: 'short-lived', hostname: 'short.example.org', admin: 'Temp' } });
    const firstCode = (await api('wards/short-lived/export')).body.tables.access_codes[0].code;

    assert.equal((await api('wards/short-lived/delete', { method: 'POST', body: { confirm: 'nope' } })).status, 400);
    assert.equal((await api('wards/short-lived/delete', { method: 'POST', body: { confirm: 'short-lived' } })).status, 200);
    assert.ok(!(await api('wards')).body.some((w) => w.id === 'short-lived'));
    assert.equal((await api('wards/short-lived/export')).status, 404);

    // Same id again: the same Durable Object, but nothing of the old ward survives in it.
    assert.equal((await api('wards', { method: 'POST', body: { id: 'short-lived', hostname: 'short.example.org' } })).status, 201);
    const again = (await api('wards/short-lived/export')).body.tables;
    assert.equal(again.admin_users.length, 0, 'the deleted ward\'s admin is gone');
    assert.notEqual(again.access_codes[0].code, firstCode, 'a fresh access code, not the old one');
  });

  test('without the password, every operator path is a plain 404', async () => {
    for (const path of ['wards', 'report', 'wards/test/export']) {
      const res = await fetch(`${server.base}/__operator/${path}`, { headers: { authorization: 'Bearer wrong' } });
      assert.equal(res.status, 404);
    }
  });
});

describe('the operator page', () => {
  test('is a sign-in form until the password is given', async () => {
    const res = await page('/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Operator sign-in/);
    assert.equal((await page('/login', { method: 'POST', form: { password: 'wrong' } })).status, 401);
    const ok = await page('/login', { as: 'op', method: 'POST', form: { password: ADMIN_PASSWORD } });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.getSetCookie().find((l) => l.startsWith('operator_session='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('lists the wards and their actions', async () => {
    const html = await (await page('/', { as: 'op' })).text();
    assert.match(html, /example-2nd/);
    assert.match(html, /example2nd\.example\.org/);
    // One button per action, each opening the page's dialog; no text boxes on the ward lines.
    for (const act of ['invite', 'suspend', 'move', 'delete']) {
      assert.match(html, new RegExp(`data-act="${act}" data-ward="example-2nd"`));
    }
    assert.match(html, /<dialog id="act">/);
    assert.match(html, /id="exp-zip"[^>]*>Full Backup \(ZIP\)</, 'Export asks: the full ZIP…');
    assert.match(html, /id="exp-json"[^>]*>Data Only \(JSON\)</, '…or the data-only JSON');
    assert.match(html, /data-export="example-2nd" data-host="example2nd\.example\.org">Export</);
  });

  test('mints an admin invite and shows the link', async () => {
    const res = await page('/wards/example-2nd/invite', { as: 'op', method: 'POST', form: { admin: 'Brother Clerk' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /https:\/\/example2nd\.example\.org\/admin\/invite#t=/);
  });

  test('refuses a form posted from another site', async () => {
    const res = await page('/wards/example-2nd/suspend', {
      as: 'op',
      method: 'POST',
      form: {},
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
  });

  test('without signing in, an action goes nowhere', async () => {
    const res = await page('/wards/example-2nd/suspend', { method: 'POST', form: {} });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    assert.equal((await api('report')).body.find((w) => w.id === 'example-2nd').status, 'active');
  });

  test('is only on the operator host — a ward hostname never serves it', async () => {
    // On a ward's hostname these paths belong to the ward (a stranger gets its member gate page),
    // never to the operator: no operator session is issued and no operator page is shown.
    const login = await ward('/login', { method: 'POST', form: { password: ADMIN_PASSWORD } });
    assert.ok(!login.headers.getSetCookie().some((l) => l.startsWith('operator_session=')));
    assert.doesNotMatch(await login.text(), /Ward hosting|Operator sign-in/);
    assert.doesNotMatch(await (await ward('/')).text(), /Ward hosting|Operator sign-in/);
  });
});

describe('the operator page and the script policy', () => {
  // As the ward pages (test/hardening.test.js): every inline script carries this response's nonce,
  // and no inline event handler is left, or a button on the page silently does nothing.
  test('the sign-in page and the dashboard both pass', async () => {
    // 'op' signed in above (the operator page's own tests): sign-ins are five a minute.
    for (const [path, as] of [['/', undefined], ['/', 'op']]) {
      const res = await page(path, { as });
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
      assert.ok(nonce, `${as ?? 'signed out'}: the policy names a nonce`);
      const html = await res.text();
      for (const [tag, attrs] of html.matchAll(/<script\b([^>]*)>/g)) {
        if (!/\bsrc=/.test(attrs)) assert.ok(attrs.includes(`nonce="${nonce}"`), tag);
      }
      assert.equal(/<[^>]+\son[a-z]+\s*=/i.exec(html), null, 'no inline event handler');
    }
  });
});

describe('the per-ward image quota', () => {
  test('an upload past IMAGE_QUOTA_MB is refused with a message', async () => {
    await ward('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
    await ward('/admin/announcements', { as: 'admin', method: 'POST', form: { title: 'Big flyers', body: 'x', published: '1' } });
    const id = (await (await ward('/admin', { as: 'admin' })).text()).match(/<li class="row" data-id="(\d+)"/)?.[1];
    const upload = () => {
      const data = new FormData();
      data.append('owner_type', 'announcement');
      data.append('owner_id', id);
      data.append('file', new Blob([new Uint8Array(700 * 1024)], { type: 'image/png' }), 'big.png');
      return ward('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
    };
    const first = await upload();
    assert.equal(first.status, 201, 'the first 700 KB fits in 1 MB');
    bigKey = (await first.json()).key;
    const second = await upload();
    assert.equal(second.status, 413);
    assert.match((await second.json()).error, /image storage is full \(1 MB\)/);
  });
});

describe("Export's images without R2", () => {
  test("the operator page reads a ward's image from its own file_chunks, byte for byte", async () => {
    assert.ok(bigKey, 'the quota test stored one');
    const res = await page(`/wards/test/images/${bigKey}`, { as: 'op' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.alloc(700 * 1024), 'every chunk, in order');
    assert.equal((await page(`/wards/example-2nd/images/${bigKey}`, { as: 'op' })).status, 404, 'not from another ward');
    assert.equal((await page(`/wards/test/images/${bigKey}`)).status, 401, 'not without a session');
  });
});

// Last in the file: it spends this address's sign-in budget for the next minute.
describe('guessing the operator password', () => {
  test('is cut off after a handful of attempts a minute — even the right password then waits', async () => {
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) {
      const res = await page('/login', { method: 'POST', form: { password: `guess-${i}` } });
      if (res.status === 429) limited = true;
      else assert.equal(res.status, 401);
    }
    assert.ok(limited, 'refused with 429 within eight attempts');
    const right = await page('/login', { method: 'POST', form: { password: ADMIN_PASSWORD } });
    assert.equal(right.status, 429, 'the limit is on attempts, not on wrong answers');
  });
});
