/**
 * The operator's tools (`src/operator.ts`) in process, against a fake registry and fake wards — the
 * edges that need no Durable Object to show: what happens with no platform password, how requests
 * are authenticated, and that a failed create or move leaves nothing half-done. The same module
 * end to end, against real wards, is test/host/operator.test.js (`npm run test:host`).
 *
 * Node only (`dist/`). Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createOperatorApp } from '../dist/operator.js';
import { DISCLAIMER } from '../dist/views.js';

const PASSWORD = 'a-long-enough-platform-password';
const HOST = 'admin.example.org';
/** The host's random half of the session key (`sessionSecret` in the deps; the registry mints it). */
const SESSION_SECRET = randomBytes(32).toString('hex');

/**
 * A registry in memory, and wards that record what they were asked and can be told to fail. Like
 * the real one (host.ts), a fake ward destroyed once answers 404 to everything but `provision` and
 * `destroy`; `failRegistryRemove` makes the registry's delete throw that many times first.
 */
function fakes({ password = PASSWORD, failWard = null, failWardStatus = 500, wardDomain = '', failRegistryRemove = 0 } = {}) {
  const wards = new Map([['alpha', { id: 'alpha', hostname: 'alpha.example.org', status: 'active' }]]);
  const calls = [];
  const destroyed = new Set();
  const deps = {
    password,
    operatorHost: HOST,
    wardDomain,
    defaultTimezone: 'America/Denver',
    secure: true,
    sessionSecret: async () => SESSION_SECRET,
    registry: {
      list: async () => [...wards.values()],
      async create(w) {
        if ([...wards.values()].some((x) => x.id === w.id || x.hostname === w.hostname)) return { ok: false };
        wards.set(w.id, { ...w, status: 'active' });
        return { ok: true };
      },
      async update(id, patch) {
        Object.assign(wards.get(id), patch);
        return { ok: true };
      },
      async remove(id) {
        if (failRegistryRemove-- > 0) throw new Error('the registry is not answering');
        wards.delete(id);
      },
    },
    async ward(id, action, body) {
      calls.push([id, action, body]);
      if (failWard === action) return new Response('boom', { status: failWardStatus });
      if (destroyed.has(id) && action !== 'provision' && action !== 'destroy') {
        return new Response('There is no ward at this address.\n', { status: 404 });
      }
      if (action === 'destroy') destroyed.add(id);
      if (action === 'provision') destroyed.delete(id);
      return Response.json({ invite: null, ok: true });
    },
    forget() {},
  };
  return { app: createOperatorApp(deps), deps, wards, calls, destroyed };
}

const api = (app, path, { method = 'GET', body, auth = `Bearer ${PASSWORD}` } = {}) =>
  app.fetch(
    new Request(`https://${HOST}/__operator/${path}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

/** A session cookie signed under `key`, as `sign` in operator.ts does. */
const cookieUnder = (key) => {
  const issued = String(Math.floor(Date.now() / 1000));
  return `operator_session=${issued}.${createHmac('sha256', key).update(issued).digest('base64url')}`;
};

describe('the session cookie\'s key', () => {
  test('a cookie signed under the password alone is refused', async () => {
    // The key is the password *and* the host's secret (`sessionKey` in operator.ts). A cookie
    // under the password alone — what the key was before, and what a stolen cookie let someone
    // guess the password against — is just a wrong signature now.
    const { app, calls } = fakes();
    const passwordOnly = createHash('sha256').update(`operator-session::${PASSWORD}`).digest();
    const html = await (await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie: cookieUnder(passwordOnly) } }))).text();
    assert.match(html, /name="password"/, 'the sign-in form, not the dashboard');
    assert.doesNotMatch(html, /alpha\.example\.org/);
    const res = await app.fetch(
      new Request(`https://${HOST}/wards/alpha/suspend`, { method: 'POST', headers: { cookie: cookieUnder(passwordOnly) } }),
    );
    assert.equal(res.status, 303);
    assert.deepEqual(calls, [], 'no ward was asked for anything');
  });

  test('a cookie under the password and the secret, the real thing, is accepted', async () => {
    const { app } = fakes();
    const key = createHash('sha256').update(`operator-session::${PASSWORD}::${SESSION_SECRET}`).digest();
    const html = await (await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie: cookieUnder(key) } }))).text();
    assert.match(html, /alpha\.example\.org/, 'the dashboard');
  });

  test('a cookie minted by the sign-in form verifies under that key and no other', async () => {
    const { app } = fakes();
    const login = await app.fetch(
      new Request(`https://${HOST}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }),
      }),
    );
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const [issued, sig] = cookie.replace('operator_session=', '').split('.');
    const key = createHash('sha256').update(`operator-session::${PASSWORD}::${SESSION_SECRET}`).digest();
    assert.equal(sig, createHmac('sha256', key).update(issued).digest('base64url'));
    const passwordOnly = createHash('sha256').update(`operator-session::${PASSWORD}`).digest();
    assert.notEqual(sig, createHmac('sha256', passwordOnly).update(issued).digest('base64url'));
  });

  test('a secret the registry could not hand over is asked for again, not cached as a failure', async () => {
    const f = fakes();
    let calls = 0;
    const app = createOperatorApp({
      ...f.deps,
      async sessionSecret() {
        calls++;
        if (calls === 1) throw new Error('registry down');
        return SESSION_SECRET;
      },
    });
    const key = createHash('sha256').update(`operator-session::${PASSWORD}::${SESSION_SECRET}`).digest();
    const first = await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie: cookieUnder(key) } }));
    assert.equal(first.status, 500, 'no secret, no answer');
    const second = await (await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie: cookieUnder(key) } }))).text();
    assert.match(second, /alpha\.example\.org/);
    assert.equal(calls, 2);
  });
});

describe('with no platform password', () => {
  // The cookie key is derived from the password and the host's secret; with an empty password only
  // the secret stands between a forger and a session, so there are no sessions at all.
  const forged = () => cookieUnder(createHash('sha256').update(`operator-session::::${SESSION_SECRET}`).digest());

  test('a forged session gets nothing: the page does not exist', async () => {
    const { app, calls } = fakes({ password: '' });
    const page = await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie: forged() } }));
    assert.equal(page.status, 404);
    const invite = await app.fetch(
      new Request(`https://${HOST}/wards/alpha/invite`, {
        method: 'POST',
        headers: { cookie: forged(), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'admin=Mallory',
      }),
    );
    assert.equal(invite.status, 404);
    assert.deepEqual(calls, [], 'no ward was asked for anything');
  });

  test('the API refuses an empty bearer token', async () => {
    const { app } = fakes({ password: '' });
    assert.equal((await api(app, 'wards', { auth: 'Bearer ' })).status, 404);
  });
});

describe('authentication', () => {
  test('wrong passwords are five a minute, and then even the right one waits', async () => {
    // The API answers on every ward's hostname with the platform password; at the old sixty a
    // minute it was a twelve-times faster oracle than the page's sign-in.
    const { app } = fakes();
    for (let i = 0; i < 5; i++) assert.equal((await api(app, 'wards', { auth: `Bearer guess-${i}` })).status, 404);
    const sixth = await api(app, 'wards', { auth: 'Bearer guess-5' });
    assert.equal(sixth.status, 429);
    assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    assert.equal((await api(app, 'wards')).status, 429, 'the right password too: otherwise a right guess would get through');
  });

  test("the operator's own scripts are never slowed by the guess limit", async () => {
    const { app } = fakes();
    for (let i = 0; i < 20; i++) assert.equal((await api(app, 'wards')).status, 200);
  });

  test('the password alone, without "Bearer", is not accepted', async () => {
    const { app } = fakes();
    assert.equal((await api(app, 'wards', { auth: PASSWORD })).status, 404);
    assert.equal((await api(app, 'wards')).status, 200);
  });

  test("the page's own forms carry a real Origin: its referrer policy is not no-referrer", async () => {
    // Under `no-referrer`, browsers post a page's forms with `Origin: null`, which the check below
    // refuses — every form on the page, sign-in included, answered "Forbidden" on the first deploy.
    const { app } = fakes();
    const res = await app.fetch(new Request(`https://${HOST}/`));
    const policy = res.headers.get('referrer-policy');
    assert.notEqual(policy, 'no-referrer');
    assert.equal(policy, 'same-origin');
  });

  test('the page carries the "not an official service" line, signed in or not', async () => {
    const { app } = fakes();
    const html = await (await app.fetch(new Request(`https://${HOST}/`))).text();
    assert.ok(html.includes(DISCLAIMER));
  });

  test('a form posted with a `null` Origin is refused, not an error', async () => {
    const { app } = fakes();
    const res = await app.fetch(
      new Request(`https://${HOST}/logout`, { method: 'POST', headers: { origin: 'null' } }),
    );
    assert.equal(res.status, 403);
  });

  test('a form posted from a ward is refused: a sibling subdomain is same-site, so the cookie would go', async () => {
    const { app } = fakes();
    for (const headers of [
      { 'sec-fetch-site': 'same-site', origin: 'https://beta.example.org' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://beta.example.org' },
    ]) {
      const res = await app.fetch(new Request(`https://${HOST}/logout`, { method: 'POST', headers }));
      assert.equal(res.status, 403, JSON.stringify(headers));
    }
    const own = await app.fetch(
      new Request(`https://${HOST}/logout`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', origin: `https://${HOST}` },
      }),
    );
    assert.notEqual(own.status, 403, 'the page’s own form still works');
  });
});

describe('nothing half-done', () => {
  test('a name provisioning would refuse is refused before anything is written', async () => {
    const { app, wards, calls } = fakes();
    const res = await api(app, 'wards', {
      method: 'POST',
      body: { id: 'beta', hostname: 'beta.example.org', name: 'x'.repeat(61) },
    });
    assert.equal(res.status, 400);
    assert.ok(!wards.has('beta'));
    assert.deepEqual(calls, []);
  });

  test("a ward can't take the operator page's own address", async () => {
    const { app, wards } = fakes();
    assert.equal((await api(app, 'wards', { method: 'POST', body: { id: 'beta', hostname: HOST } })).status, 400);
    assert.ok(!wards.has('beta'));
    assert.equal((await api(app, 'wards/alpha/move', { method: 'POST', body: { hostname: HOST } })).status, 400);
  });

  test('a failed provision is undone, so the same create can simply be tried again', async () => {
    const failing = fakes({ failWard: 'provision' });
    const res = await api(failing.app, 'wards', { method: 'POST', body: { id: 'beta', hostname: 'beta.example.org' } });
    assert.notEqual(res.status, 201);
    assert.ok(!failing.wards.has('beta'), 'the registry row is gone');
    assert.ok(failing.calls.some(([id, action]) => id === 'beta' && action === 'destroy'), 'and the ward was cleared');
  });

  test('a move the ward refuses leaves the registry on the old address', async () => {
    const { app, wards } = fakes({ failWard: 'move' });
    const res = await api(app, 'wards/alpha/move', { method: 'POST', body: { hostname: 'new.example.org' } });
    assert.notEqual(res.status, 200);
    assert.equal(wards.get('alpha').hostname, 'alpha.example.org');
  });

  test('a delete that failed at the registry can be finished by trying again', async () => {
    // The ward's data goes first and the registry row last, so a registry hiccup in between left a
    // ward that was gone but still listed — and the retry found a tombstoned object that answered
    // 404 to `destroy`, so the id and hostname stayed reserved for ever.
    const { app, wards, calls, destroyed } = fakes({ failRegistryRemove: 1 });
    const first = await api(app, 'wards/alpha/delete', { method: 'POST', body: { confirm: 'alpha' } });
    assert.equal(first.status, 500);
    assert.ok(destroyed.has('alpha'), 'the ward was destroyed');
    assert.ok(wards.has('alpha'), 'but its row is still there');
    const stranded = await api(app, 'wards/alpha/export');
    assert.match((await stranded.json()).error, /answered 404/, 'and the ward itself answers nothing');

    const again = await api(app, 'wards/alpha/delete', { method: 'POST', body: { confirm: 'alpha' } });
    assert.equal(again.status, 200);
    assert.ok(!wards.has('alpha'), 'the row is gone');
    assert.equal(calls.filter(([id, action]) => id === 'alpha' && action === 'destroy').length, 2, 'destroy was asked twice');
  });

  test('a ward that answers 404 to destroy is gone already: its row is removed; a 500 stops the delete', async () => {
    const gone = fakes({ failWard: 'destroy', failWardStatus: 404 });
    assert.equal((await api(gone.app, 'wards/alpha/delete', { method: 'POST', body: { confirm: 'alpha' } })).status, 200);
    assert.ok(!gone.wards.has('alpha'));
    // A 500 may mean the data is half there: the ward stays listed, for the delete to be tried again.
    const broken = fakes({ failWard: 'destroy' });
    assert.equal((await api(broken.app, 'wards/alpha/delete', { method: 'POST', body: { confirm: 'alpha' } })).status, 400);
    assert.ok(broken.wards.has('alpha'));
  });

  test('suspending tells the ward (so its alarm stops sending), then the registry', async () => {
    const { app, wards, calls } = fakes();
    assert.equal((await api(app, 'wards/alpha/suspend', { method: 'POST' })).status, 200);
    assert.deepEqual(calls.at(-1), ['alpha', 'status', { suspended: true }]);
    assert.equal(wards.get('alpha').status, 'suspended');
    assert.equal((await api(app, 'wards/alpha/resume', { method: 'POST' })).status, 200);
    assert.deepEqual(calls.at(-1), ['alpha', 'status', { suspended: false }]);
  });
});

describe('the host refuses a short platform password', () => {
  test('the operator API is off — the password is too easy to guess across every ward', async () => {
    // Imported here, not at the top: loading host.js switches this process to multi-ward mode.
    const { default: host } = await import('../dist/host.js');
    const { MIN_PLATFORM_PASSWORD } = await import('../dist/operator.js');
    const short = 'x'.repeat(MIN_PLATFORM_PASSWORD - 1);
    const res = await host.fetch(
      new Request('https://admin.example.org/__operator/wards', { headers: { authorization: `Bearer ${short}` } }),
      { ADMIN_PASSWORD: short, OPERATOR_HOST: 'admin.example.org' },
    );
    assert.equal(res.status, 404);
  });
});

describe('a deleted ward (WardDO, in process on a fake storage)', () => {
  // The object as it is after a delete: a tombstone table and nothing else. Only the paths that
  // touch no database are run — enough for what the delete's retry needs of it.
  async function tombstoned() {
    const { WardDO } = await import('../dist/host.js');
    const log = [];
    const ctx = {
      id: { toString: () => 'ward-x' },
      storage: {
        sql: {
          exec(query) {
            log.push(query);
            return { toArray: () => (/sqlite_master/.test(query) ? [{ 1: 1 }] : []) };
          },
        },
        transaction: (fn) => fn(),
        getAlarm: async () => null,
        deleteAlarm: async () => log.push('deleteAlarm'),
        deleteAll: async () => log.push('deleteAll'),
        setAlarm: async () => log.push('setAlarm'),
      },
      blockConcurrencyWhile: (fn) => fn(),
    };
    const ward = new WardDO(ctx, { WARD: {}, REGISTRY: {}, ASSETS: {}, NODE_ENV: 'production' });
    const internal = (action) =>
      ward.fetch(
        new Request(`https://ward.internal/__ward/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      );
    return { internal, log };
  }

  test('answers 404 to the operator’s other calls, but `ok` to destroy, every time', async () => {
    const { internal, log } = await tombstoned();
    assert.equal((await internal('export')).status, 404);
    assert.equal((await internal('state')).status, 404);
    for (let i = 0; i < 2; i++) {
      const res = await internal('destroy');
      assert.equal(res.status, 200, 'a delete tried again after a registry failure must get through');
      assert.deepEqual(await res.json(), { ok: true, already: true });
    }
    assert.ok(!log.includes('deleteAll'), 'nothing was deleted again');
    assert.ok(!log.includes('setAlarm'), 'no new sweep alarm');
  });
});

describe('vars a host must not pass to its wards', () => {
  const vars = {
    NODE_ENV: 'production',
    PUBLIC_ORIGIN: 'https://one.example.org',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:ops@example.org',
    BACKUP_SEAL_KEY: 'seal',
    APP_NAME: 'Ward',
  };

  test('in production the address and the push pair are dropped and named; the subject and the seal key stay', async () => {
    // The seal key is host-wide by design: one key opens every ward's backup and export here.
    const { wardVars } = await import('../dist/operator.js');
    const out = wardVars(vars);
    assert.deepEqual(out.ignored, ['PUBLIC_ORIGIN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']);
    assert.deepEqual(out.vars, { NODE_ENV: 'production', VAPID_SUBJECT: 'mailto:ops@example.org', BACKUP_SEAL_KEY: 'seal', APP_NAME: 'Ward' });
    assert.equal(vars.PUBLIC_ORIGIN, 'https://one.example.org', 'the host’s own env is untouched');
  });

  test('in development PUBLIC_ORIGIN is let through (wrangler dev has no address to derive), the pair is not', async () => {
    const { wardVars } = await import('../dist/operator.js');
    const out = wardVars({ ...vars, NODE_ENV: 'development' });
    assert.deepEqual(out.ignored, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']);
    assert.equal(out.vars.PUBLIC_ORIGIN, 'https://one.example.org');
  });

  test('an unset or blank var is not reported as ignored', async () => {
    const { wardVars } = await import('../dist/operator.js');
    assert.deepEqual(wardVars({ NODE_ENV: 'production', VAPID_PUBLIC_KEY: '' }).ignored, []);
  });
});

test('the Workers entry modules export only what workerd accepts: handlers and classes', async () => {
  // workerd refuses to start a Worker whose entry module exports anything else (a constant, say) —
  // "Incorrect type for map entry" — and a dry-run bundle does not notice.
  for (const entry of ['../dist/host.js', '../dist/worker.js']) {
    const mod = await import(entry);
    for (const [name, value] of Object.entries(mod)) {
      const ok = name === 'default' ? typeof value === 'object' && typeof value.fetch === 'function' : typeof value === 'function';
      assert.ok(ok, `${entry} exports ${name}, which is not a handler or a class`);
    }
  }
});

describe('the page asks only for a subdomain when WARD_DOMAIN is set', () => {
  /** Sign in to the page and return a function that posts its forms with that session. */
  async function signedIn(app) {
    const login = await app.fetch(
      new Request(`https://${HOST}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }),
      }),
    );
    const cookie = login.headers.getSetCookie().find((l) => l.startsWith('operator_session='))?.split(';')[0];
    assert.ok(cookie);
    return (path, fields) =>
      app.fetch(
        new Request(`https://${HOST}${path}`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(fields),
        }),
      );
  }

  test('a new ward is created from its subdomain, which is also its id', async () => {
    const { app, wards } = fakes({ wardDomain: 'example.org' });
    const res = await (await signedIn(app))('/wards', { subdomain: 'Example-2nd', name: 'Example 2nd Ward' });
    assert.equal(res.status, 200);
    assert.deepEqual(
      { id: wards.get('example-2nd')?.id, hostname: wards.get('example-2nd')?.hostname },
      { id: 'example-2nd', hostname: 'example-2nd.example.org' },
    );
  });

  test('a pasted full address under the domain is accepted; anything with other dots is refused', async () => {
    const { app, wards } = fakes({ wardDomain: 'example.org' });
    const post = await signedIn(app);
    await post('/wards', { subdomain: 'oak-hills.example.org' });
    assert.equal(wards.get('oak-hills')?.hostname, 'oak-hills.example.org');
    const refused = await post('/wards', { subdomain: 'evil.example.com' });
    assert.equal(refused.status, 303);
    assert.match(decodeURIComponent(refused.headers.get('location')), /no dots/);
    assert.ok(![...wards.values()].some((w) => w.hostname.includes('example.com')));
  });

  test('moving takes a subdomain too', async () => {
    const { app, wards } = fakes({ wardDomain: 'example.org' });
    const res = await (await signedIn(app))('/wards/alpha/move', { subdomain: 'alpha-ward' });
    assert.equal(res.status, 303);
    assert.equal(wards.get('alpha').hostname, 'alpha-ward.example.org');
  });

  test('the page shows the domain beside the box, and no separate id field', async () => {
    const { app } = fakes({ wardDomain: 'example.org' });
    await signedIn(app);
    const login = await app.fetch(
      new Request(`https://${HOST}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }),
      }),
    );
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const html = await (await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie } }))).text();
    assert.match(html, /name="subdomain"/);
    assert.match(html, /\.example\.org</);
    assert.doesNotMatch(html, /name="id"/);
    assert.doesNotMatch(html, /name="hostname"/);
  });
});

describe('creating a ward with its home-screen name and timezone', () => {
  test('both are passed to the new ward', async () => {
    const { app, calls } = fakes();
    const res = await api(app, 'wards', {
      method: 'POST',
      body: { id: 'gamma', hostname: 'gamma.example.org', name: 'Gamma Ward', shortName: 'Gamma', timezone: 'America/Phoenix' },
    });
    assert.equal(res.status, 201);
    const [, , body] = calls.find(([id, action]) => id === 'gamma' && action === 'provision');
    assert.equal(body.shortName, 'Gamma');
    assert.equal(body.timezone, 'America/Phoenix');
  });

  test('an unknown timezone or an over-long home-screen name is refused before anything is written', async () => {
    const { app, wards, calls } = fakes();
    const zone = await api(app, 'wards', { method: 'POST', body: { id: 'delta', hostname: 'delta.example.org', timezone: 'Mars/Base' } });
    assert.equal(zone.status, 400);
    const long = await api(app, 'wards', {
      method: 'POST',
      body: { id: 'delta', hostname: 'delta.example.org', shortName: 'x'.repeat(21) },
    });
    assert.equal(long.status, 400);
    assert.ok(!wards.has('delta'));
    assert.deepEqual(calls, []);
  });

  test('the form offers both, the timezone as the same dropdown the ward has', async () => {
    const { app } = fakes();
    const login = await app.fetch(
      new Request(`https://${HOST}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }),
      }),
    );
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const html = await (await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie } }))).text();
    assert.match(html, /name="shortName"[^>]*maxlength="12"/);
    assert.match(html, /<select id="timezone" name="timezone"/);
    assert.match(html, /value="America\/Denver" selected/);
  });
});

test("the action dialog really hides its field when an action takes no answer (Suspend)", async () => {
  // The script sets `hidden` on the field; an explicit `display` in the page's CSS would override that,
  // which is how Suspend showed an empty text box.
  const { app } = fakes();
  const login = await app.fetch(
    new Request(`https://${HOST}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }),
    }),
  );
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const html = await (await app.fetch(new Request(`https://${HOST}/`, { headers: { cookie } }))).text();
  assert.match(html, /dialog \.field\{display:flex/);
  assert.match(html, /dialog \.field\[hidden\]\{display:none\}/);
});

/**
 * Run `fn` with the logger's error lines (console.error, see src/log.ts) captured, parsed. Only
 * the logger's JSON is kept: Node writes its own warnings through console.error too — on Node 22
 * `node:sqlite` is experimental and says so the first time a test imports it — and those lines
 * failed the whole test as "not valid JSON" in CI.
 */
async function loggedErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (text) => {
    if (typeof text === 'string' && text.startsWith('{')) lines.push(JSON.parse(text));
    else original(text);
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

describe('a failure the operator is told to look for in the logs is in the logs', () => {
  const failing = () => {
    const f = fakes();
    // A registry that has stopped answering: no Refusal, so the operator sees only a generic message.
    const app = createOperatorApp({
      ...f.deps,
      registry: { ...f.deps.registry, list: async () => { throw new Error('registry down'); } },
    });
    return app;
  };

  test('the API answers "Failed." and logs why', async () => {
    let res;
    const errors = await loggedErrors(async () => (res = await api(failing(), 'wards')));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Failed.' });
    assert.ok(errors.some((e) => e.err?.message === 'registry down'), JSON.stringify(errors));
  });

  test('the page says "Check the logs", and logs why', async () => {
    const app = failing();
    const login = await app.fetch(
      new Request(`https://${HOST}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD }),
      }),
    );
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    let res;
    const errors = await loggedErrors(
      async () => (res = await app.fetch(new Request(`https://${HOST}/wards/alpha/suspend`, { method: 'POST', headers: { cookie } }))),
    );
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get('location')), /Check the logs/);
    assert.ok(errors.some((e) => e.err?.message === 'registry down'), JSON.stringify(errors));
  });
});

test('the front door builds the operator deps once, not on every request (a short password is logged once)', async () => {
  // A fresh copy of the module (the query string), so an earlier test's cached operator app does not
  // hide a second build. `/__ward/` is refused straight after the operator-host check, so no ward is needed.
  const { default: host } = await import('../dist/host.js?deps-once');
  const { MIN_PLATFORM_PASSWORD } = await import('../dist/operator.js');
  const env = { ADMIN_PASSWORD: 'x'.repeat(MIN_PLATFORM_PASSWORD - 1), OPERATOR_HOST: HOST };
  const errors = await loggedErrors(async () => {
    for (let i = 0; i < 2; i++) {
      assert.equal((await host.fetch(new Request('https://alpha.example.org/__ward/state'), env)).status, 404);
    }
  });
  assert.equal(errors.filter((e) => /ADMIN_PASSWORD is too short/.test(e.msg)).length, 1);
});

test('a ward whose alarm cannot be set still answers the request it served, and logs the failure', async () => {
  // A real WardDO, booted on an in-memory SQLite standing in for its Durable Object storage. The
  // write has committed by the time the alarm is re-derived; that failing must not turn it into a 500.
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const { WardDO } = await import('../dist/host.js');
  const db = new DatabaseSync(':memory:');
  const savepoint = (name, fn) => {
    db.exec(`SAVEPOINT ${name}`);
    const done = (result) => (db.exec(`RELEASE ${name}`), result);
    const undo = (err) => {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    };
    try {
      const result = fn();
      return result instanceof Promise ? result.then(done, undo) : done(result);
    } catch (err) {
      undo(err);
    }
  };
  const ctx = {
    id: { toString: () => 'ward-alarm' },
    storage: {
      sql: {
        exec(query, ...bindings) {
          const statement = db.prepare(query);
          const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
          return { toArray: () => rows };
        },
      },
      transactionSync: (fn) => savepoint('sync', fn),
      transaction: (fn) => savepoint('async', fn),
      getAlarm: async () => null,
      setAlarm: async () => {
        throw new Error('setAlarm refused');
      },
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const assets = {
    async fetch(request) {
      try {
        return new Response(readFileSync(new URL(`../public${new URL(request.url).pathname}`, import.meta.url)));
      } catch {
        return new Response('', { status: 404 });
      }
    },
  };
  const env = { WARD: {}, REGISTRY: {}, ASSETS: assets, NODE_ENV: 'production', APP_NAME: 'Test Ward', APP_SHORT_NAME: 'Ward', APP_DESCRIPTION: 'A test.' };
  let ward;
  const bootErrors = await loggedErrors(async () => {
    ward = new WardDO(ctx, env);
    // The constructor's boot runs on its own; a read before it is up answers 503.
    for (let i = 0; i < 100 && (await ward.fetch(new Request('https://ward.example.org/healthz'))).status === 503; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  assert.ok(bootErrors.every((e) => e.msg === 'could not set the ward alarm after a request'), JSON.stringify(bootErrors));
  for (const method of ['GET', 'POST']) {
    let res;
    const errors = await loggedErrors(async () => (res = await ward.fetch(new Request('https://ward.example.org/healthz', { method }))));
    assert.notEqual(res.status, 500, `${method}: the ward's own answer, not the alarm's error`);
    assert.ok(errors.some((e) => e.err?.message === 'setAlarm refused'), `${method}: ${JSON.stringify(errors)}`);
  }
});
