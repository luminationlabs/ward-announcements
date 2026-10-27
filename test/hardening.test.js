// End-to-end tests for the pre-launch hardening pass.
//
// Everything here is a property of the *composed* app — a header the middleware adds, a redirect
// target the gate builds, a credential shape a route never sees because something upstream rejected
// it — so it is driven over HTTP like the other end-to-end suites, and runs unchanged on both
// runtimes:
//   npm test            (the Node entry)
//   npm run test:worker (`wrangler dev`, i.e. the real Workers runtime)
//
// Several of these guard against holes that are real, not theoretical, against a running app: an
// open redirect, a 500 oracle on a non-string credential, and `/administrivia` sailing past the gate
// if the exemption were a `startsWith('/admin')`.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { ADMIN_PASSWORD, TARGET, unlockMember, createClient, startServer, testPort } from './helpers/harness.js';

let server;
let BASE;
let req;

/** A real 1x1 PNG, as in the attachment suite — the server stores bytes, so send real ones. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  // Its own port: `node --test` runs the files in parallel.
  server = await startServer({ port: testPort(3) });
  BASE = server.base;
  req = createClient(BASE);
});

after(() => server?.stop());

const login = () =>
  req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
const adminPost = (path, form) => req(path, { as: 'admin', method: 'POST', form });

async function activeCode() {
  const html = await (await req('/admin', { as: 'admin' })).text();
  return html.match(/#code=([a-z0-9-]+)/)?.[1] ?? null;
}
const unlock = (as, code) => req('/api/access', { as, method: 'POST', json: { code } });
const isGatePage = async (res) => (await res.text()).includes('id="gate-msg"');

/** A fresh access code from a known state, whatever the previous describe block left behind. */
async function freshCode() {
  await login();
  await adminPost('/admin/access/rotate', { grace: '0' });
}

/** Today's local date, the way the server computes it (the harness pins TZ=America/Denver). */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const TODAY_DOW = new Date(`${TODAY}T00:00:00Z`).getUTCDay();

// ---------------------------------------------------------------------------

describe('response headers on the public APIs', () => {
  before(async () => {
    await login();
    await unlockMember(req, 'visitor'); // read them as an ordinary member
  });

  for (const path of ['/api/announcements', '/api/program', '/api/pages']) {
    test(`${path} is nosniff and privately cached`, async () => {
      const res = await req(path, { as: 'visitor' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(
        res.headers.get('cache-control'),
        'private, no-cache',
        'a shared cache must not keep this: it varies by cookie, and the program varies by clock',
      );
    });
  }

  test('the cache directive is one the service worker will still store', async () => {
    // Deliberately `no-cache` and not `no-store`. public/sw.js refuses to cache a `no-store`
    // response (that is how the gate page is kept out of the cache), and the offline copy of the
    // announcements is a feature — the chapel's wifi is a rumour. If that check in sw.js ever
    // widens to cover `no-cache`, this pairing silently stops working, so assert the shape here.
    const res = await req('/api/announcements', { as: 'visitor' });
    assert.match(res.headers.get('cache-control'), /no-cache/);
    assert.doesNotMatch(res.headers.get('cache-control'), /no-store/);
  });
});

describe('admin content forms', () => {
  // No `login()` here: the block above already holds the admin session, and `/admin/login` allows
  // five attempts a minute per IP — the wrong-type block later in this file counts on the budget.

  test('admin pages are never cached — the service worker would keep the access code otherwise', async () => {
    // The SW controls /admin too and stores any OK response that is not no-store. The dashboard
    // body holds the live share code; the login page is checked as well so the rule is seen to be
    // the prefix, not one route.
    for (const [path, as] of [['/admin', 'admin'], ['/admin/announcements/new', 'admin'], ['/admin/login', 'nobody']]) {
      const res = await req(path, { as });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get('cache-control'), 'private, no-store', path);
    }
    const backup = await req('/admin/backup.json', { as: 'admin' });
    assert.equal(backup.headers.get('cache-control'), 'private, no-store', 'a route with its own directive keeps it');
  });

  test('a request too large for any form is refused before it is read', async () => {
    // On a connection of its own: the server answers before reading the body and then closes the
    // connection, which a browser expects and fetch's shared pool does not — the next test's request
    // would land on the closed socket.
    const post = (path, body, type) =>
      new Promise((resolve, reject) => {
        const r = httpRequest(
          `${server.base}${path}`,
          { method: 'POST', agent: false, headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) } },
          (res) => (res.resume(), resolve(res.statusCode)),
        );
        // A server that answers 413 and hangs up mid-upload can reset the socket before Node reads
        // the reply; that is the refusal too, not a crash (a crash fails the next test's request).
        r.on('error', (err) => (err.code === 'EPIPE' || err.code === 'ECONNRESET' ? resolve(413) : reject(err)));
        r.end(body);
      });
    // No session needed: the size is checked before anything else looks at the request.
    const form = new URLSearchParams({ title: 'Big', body: 'x'.repeat(1_100_000), published: '1' }).toString();
    assert.equal(await post('/admin/announcements', form, 'application/x-www-form-urlencoded'), 413);
    assert.equal(
      await post('/api/access', JSON.stringify({ code: 'x'.repeat(70_000) }), 'application/json'),
      413,
      'the public API takes small bodies only',
    );
  });

  test('a field that is not text is a blank field, not a 500', async () => {
    // A form sends strings; a JSON body can put a number or an object under the same name.
    const send = await req('/admin/send', { as: 'admin', method: 'POST', json: { title: 42, body: 'x' } });
    assert.equal(send.status, 302);
    assert.match(decodeURIComponent(send.headers.get('location') ?? ''), /Title is required/);
    const weekly = await req('/admin/weekly-message', { as: 'admin', method: 'POST', json: { weekly_title: { a: 1 }, weekly_body: 'x' } });
    assert.equal(weekly.status, 302);
    const announcement = await req('/admin/announcements', { as: 'admin', method: 'POST', json: { title: { a: 1 }, body: 'x', published: '1' } });
    assert.equal(announcement.status, 400);
    assert.match(await announcement.text(), /Title is required/);
  });

  test('a manual notification over the push caps is refused before it is queued', async () => {
    // The weekly message is saved under the same caps (80/300); past them the payload fails at
    // encryption, so an oversize send used to show "Sent to 0 of N" and count against the hour.
    // Before the cap test below, which spends the hour's budget.
    const res = await adminPost('/admin/send', { title: 'Oversize check', body: 'x'.repeat(301) });
    assert.equal(res.status, 302);
    assert.match(decodeURIComponent(res.headers.get('location') ?? ''), /Not sent: .*at most 300/);
    const long = await adminPost('/admin/send', { title: 'T'.repeat(81), body: 'x' });
    assert.match(decodeURIComponent(long.headers.get('location') ?? ''), /Not sent: .*at most 80/);
    const link = await adminPost('/admin/send', {
      title: 'Oversize check',
      body: 'x',
      link_target: 'custom',
      custom_url: `https://example.org/${'a'.repeat(2048)}`,
    });
    assert.match(decodeURIComponent(link.headers.get('location') ?? ''), /Enter a full web link/);
    const html = await (await req('/admin', { as: 'admin' })).text();
    assert.ok(!html.includes('Oversize check'), 'nothing reached the send history');
  });

  test('manual notifications are capped per hour, across devices', async () => {
    // Every send reaches every member's phone. Counted from the send log, so a second browser or a
    // second isolate is no way around it.
    const sends = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await adminPost('/admin/send', { title: `Cap test ${i}`, body: 'x' });
      sends.push(decodeURIComponent(res.headers.get('location') ?? ''));
    }
    assert.ok(sends.slice(0, 5).every((l) => !/Not sent/.test(l)), sends.join('\n'));
    assert.match(sends[5], /Not sent: 5 notifications have gone out in the last hour/);
  });

  test('a backup is no way into the dashboard', async () => {
    // With the people secret and the admin_users rows, anyone holding a leaked backup could sign an
    // admin session cookie of their own. Adding a person mints a live invite, so there is one to omit.
    await adminPost('/admin/people', { name: 'Backup Check', role: 'editor' });
    const { tables } = await (await req('/admin/backup.json', { as: 'admin' })).json();
    const keys = tables.settings.map((row) => row.key);
    assert.ok(keys.includes('schema_version'), 'settings are still backed up');
    assert.ok(!keys.includes('admin_people_secret'), 'but not the key that signs sessions');
    assert.deepEqual(tables.admin_invites, [], 'and no live dashboard invite links');
    assert.ok(tables.admin_users.some((u) => u.name === 'Backup Check'), 'people themselves are kept');
  });

  test('an expiry that is not a calendar date is refused, not stored and not echoed raw', async () => {
    // The public query compares expires_at to today as text, so a non-date never expires; and the
    // value is rendered back into the edit form's value attribute, which would make it a place
    // an editor could plant markup an admin's browser would run.
    const attack = '" autofocus onfocus="alert(1)';
    const res = await adminPost('/admin/announcements', {
      title: 'Bad expiry',
      body: 'x',
      expires_at: attack,
      published: '1',
    });
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.match(page, /real date/i);
    assert.doesNotMatch(page, /onfocus="alert/, 'the rejected value is escaped where it is echoed');
    assert.match(page, /value="Bad expiry"/, 'and the title typed is still in the form');
    const dashboard = await (await req('/admin', { as: 'admin' })).text();
    assert.doesNotMatch(dashboard, /Bad expiry/, 'nothing was created');

    const ok = await adminPost('/admin/announcements', {
      title: 'Good expiry',
      body: 'x',
      expires_at: '2099-12-31',
      published: '1',
    });
    assert.equal(ok.status, 302, 'a real date is still accepted');
  });

  test('a rejected save hands back what was typed, not what was stored', async () => {
    const created = await adminPost('/admin/announcements', { title: 'Draft test', body: 'stored body', published: '1' });
    assert.equal(created.status, 302);
    const dashboard = await (await req('/admin', { as: 'admin' })).text();
    const id = dashboard.match(/\/admin\/announcements\/(\d+)\/edit/)?.[1];
    assert.ok(id, 'the announcement is on the dashboard');

    const rejected = await adminPost(`/admin/announcements/${id}`, { title: '   ', body: 'ten minutes of retyping', published: '1' });
    assert.equal(rejected.status, 400);
    const page = await rejected.text();
    assert.match(page, /ten minutes of retyping/, 'the body the clerk typed survives the rejection');
    assert.doesNotMatch(page, /stored body/);
    await adminPost(`/admin/announcements/${id}/delete`);
  });

  test('a body too long to render cheaply is refused, on every kind of content', async () => {
    // Every member page load renders every body, so one enormous body is a cost every member pays —
    // and past 100 KB a backup of it no longer restores through `wrangler d1 execute`.
    const huge = 'x'.repeat(50_001);
    for (const [path, form] of [
      ['/admin/announcements', { title: 'Huge', body: huge, published: '1' }],
      ['/admin/pages', { title: 'Huge', body: huge, published: '1' }],
      ['/admin/programs', { program_date: '2099-01-04', body: huge }],
      ['/admin/announcements', { title: 'T'.repeat(201), body: 'x', published: '1' }],
    ]) {
      const res = await adminPost(path, form);
      assert.equal(res.status, 400, path);
      assert.match(await res.text(), /too long/, path);
    }
    const dashboard = await (await req('/admin', { as: 'admin' })).text();
    assert.doesNotMatch(dashboard, /Huge|TTTTT/, 'nothing was created');
  });
});

describe('the ?code= redirect cannot leave the site', () => {
  before(freshCode);

  test('a protocol-relative path is collapsed to a path on this origin', async () => {
    // Verified during review: `//evil.example.com/x?code=<valid>` 302'd to another origin, because
    // the redirect echoed `c.req.path` and a browser reads `//host/x` as a URL, not a path.
    const code = await activeCode();
    const res = await req(`//evil.example.com/x?code=${encodeURIComponent(code)}`, { as: 'redir' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.equal(location, '/evil.example.com/x', 'exactly one leading slash, so it stays a path');
    assert.equal(
      new URL(location, BASE).origin,
      new URL(BASE).origin,
      'and it resolves to this origin however a browser reads it',
    );
  });

  test('an ordinary page visit still round-trips', async () => {
    const code = await activeCode();
    const res = await req(`/?code=${encodeURIComponent(code)}`, { as: 'ordinary' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/', 'the code is stripped from the address bar');
    assert.equal((await req('/api/announcements', { as: 'ordinary' })).status, 200);
  });
});

describe('credentials of the wrong type', () => {
  before(freshCode);

  test('a numeric password is a wrong password, not a 500', async () => {
    // `{"password": 12345}` reached createHash().update() and threw a Node type error, which the
    // error handler echoed back verbatim — a free oracle for an unauthenticated caller.
    const res = await req('/admin/login', { method: 'POST', json: { password: 12345 } });
    assert.equal(res.status, 401);
    const body = await res.text();
    assert.doesNotMatch(body, /Internal Server Error/i);
    assert.doesNotMatch(body, /argument|TypeError|ERR_INVALID_ARG/i, 'no Node internals leak out');
  });

  test('a non-string access code is an invalid code, not a 500', async () => {
    for (const code of [[1], { a: 1 }, 42, true]) {
      const res = await req('/api/access', { method: 'POST', json: { code } });
      assert.equal(res.status, 401, `code ${JSON.stringify(code)} must be rejected as invalid`);
      assert.equal((await res.json()).error, 'Invalid or expired link');
    }
  });

  test('a null body is handled the same way', async () => {
    assert.equal((await req('/api/access', { method: 'POST', json: { code: null } })).status, 401);
    assert.equal((await req('/admin/login', { method: 'POST', json: {} })).status, 401);
  });
});

describe('the gate exemption is the admin area, not a prefix of it', () => {
  before(freshCode);

  test('/administrivia is gated', async () => {
    // `startsWith('/admin')` exempted anything beginning with those six characters. Nothing serves
    // this path today, but the exemption is what decides whether a stranger reaches whatever does.
    const res = await req('/administrivia');
    assert.equal(res.status, 200);
    assert.equal(await isGatePage(res), true, 'a stranger gets the locked page, not the route');
  });

  test('/admin and everything under it stays reachable', async () => {
    assert.equal((await req('/admin/login')).status, 200);
    assert.equal((await req('/admin')).status, 302, 'requireAuth redirects rather than the gate');
  });
});

describe('invites are bounded per device', () => {
  before(async () => {
    await freshCode();
    await unlock('sharer', await activeCode());
  });

  test('a device cannot mint an unbounded supply of live links', async () => {
    // An invite is a real credential: unlimited uses, thirty days, and it survives both a code
    // rotation and a sign-everyone-out. A per-IP rate limit alone would not bound it: that is
    // per-isolate on Workers and trivially waited out.
    const urls = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await req('/api/invite', { as: 'sharer', method: 'POST' });
      assert.equal(res.status, 200, 'the member always gets a working link back');
      const body = await res.json();
      assert.ok(body.url, 'and a link is what they get');
      assert.ok(body.expiresInDays >= 1, 'that still says when it expires');
      urls.push(body.url);
    }
    assert.equal(new Set(urls).size, 5, 'at most five distinct live links from one device');
    assert.equal(
      urls[7],
      urls[4],
      'past the cap the newest existing link comes back rather than a sixth',
    );
  });

  test('the reused link still unlocks someone', async () => {
    const { url } = await (await req('/api/invite', { as: 'sharer', method: 'POST' })).json();
    const token = new URL(url).hash.replace('#i=', '');
    assert.equal((await unlock('invited-guest', token)).status, 200);
  });

  test('a credential in ?code= is no way around the cap', async () => {
    // Found in an audit: with no cookie, the invite was attributed to no device and so never
    // counted — one leaked invite, presented in `?code=`, minted invites without end.
    const code = await activeCode();
    const res = await req(`/api/invite?code=${encodeURIComponent(code)}`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  test('a different device gets its own budget', async () => {
    await unlock('sharer2', await activeCode());
    const res = await req('/api/invite', { as: 'sharer2', method: 'POST' });
    assert.equal(res.status, 200);
    const { url } = await res.json();
    assert.equal(url.includes('#i='), true);
  });
});

describe('the member cookie expires server-side', () => {
  let secret;
  let deviceId;

  before(async () => {
    await freshCode();
    await unlock('longtimer', await activeCode());
    // The signing key, read out of the admin backup — the only way to forge a *correctly signed*
    // cookie, which is the whole point: a tampered one is rejected by the signature and would prove
    // nothing about whether the age is checked.
    const dump = await (await req('/admin/backup.json', { as: 'admin' })).json();
    secret = dump.tables.settings.find((row) => row.key === 'access_cookie_secret')?.value;
    assert.ok(secret, 'the member cookie secret is stored in settings');
    deviceId = 'a'.repeat(32);
  });

  const cookieFor = (issuedAt) => {
    const payload = `v1.${deviceId}.${issuedAt}`;
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    return `pushannounce_access=${payload}.${sig}`;
  };
  const withCookie = (cookie) =>
    fetch(`${BASE}/api/announcements`, { headers: { cookie }, redirect: 'manual' });

  test('a freshly-issued cookie is honoured (the control)', async () => {
    const res = await withCookie(cookieFor(Math.floor(Date.now() / 1000)));
    assert.equal(res.status, 200, 'the forgery machinery itself is right');
  });

  test('an ancient issue time is rejected even though the signature is valid', async () => {
    // The issue time has been signed into the payload since v1 and nothing read it: Max-Age is a
    // request to the browser, not something the server enforces, so a cookie lifted off a device
    // was good forever.
    const sixYearsAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * 6;
    assert.equal((await withCookie(cookieFor(sixYearsAgo))).status, 401);
  });

  test('an issue time in the future is rejected too', async () => {
    const nextYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    assert.equal((await withCookie(cookieFor(nextYear))).status, 401);
  });

  test('a payload with no issue time at all is rejected', async () => {
    const payload = `v1.${deviceId}`;
    const sig = createHmac('sha256', secret).update(payload).digest('base64url');
    const res = await withCookie(`pushannounce_access=${payload}.${sig}`);
    assert.equal(res.status, 401);
  });
});

describe('a program outside its window leaks nothing, images included', () => {
  let imageUrl;
  let programId;

  before(async () => {
    await login();
    await unlockMember(req, 'visitor');
    await unlockMember(req, 'admin'); // the admin reads the public API below as well
    // Window open, so the program and its image can be created and confirmed visible first —
    // otherwise a passing test could just mean nothing was ever there.
    await adminPost('/admin/programs/settings', {
      program_dow: String(TODAY_DOW),
      program_start: '00:00',
      program_end: '23:59',
      program_closed_message: 'Not right now, friend.',
      program_retention_days: '90',
    });
    const created = await adminPost('/admin/programs', {
      program_date: TODAY,
      body: 'Presiding ... Bishop Smith\nSpeaker ... Sister Alvarez',
    });
    const id = /\/admin\/programs\/(\d+)\/edit/.exec(created.headers.get('location') ?? '')?.[1];
    assert.ok(id, 'the program was created');
    programId = Number(id);

    const data = new FormData();
    data.append('owner_type', 'program');
    data.append('owner_id', String(id));
    data.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'insert.png');
    const added = await (
      await req('/admin/attachments', { as: 'admin', method: 'POST', formData: data })
    ).json();
    imageUrl = added.url;

    const open = await (await req('/api/program', { as: 'visitor' })).json();
    assert.equal(open.open, true, 'visible while the window is open');
    assert.deepEqual(open.images.map((i) => i.url), [imageUrl]);
    const shown = await req(imageUrl, { as: 'visitor' });
    assert.equal(shown.status, 200, 'and its image loads for a member, inside the window');
    assert.equal(shown.headers.get('cache-control'), 'private, no-store', 'without being kept anywhere');

    // Now shut it, by moving the day rather than the clock — deterministic at any hour.
    await adminPost('/admin/programs/settings', {
      program_dow: String((TODAY_DOW + 1) % 7),
      program_start: '00:00',
      program_end: '23:59',
      program_closed_message: 'Not right now, friend.',
      program_retention_days: '90',
    });
  });

  test('the closed reply carries no body, no date and no image keys', async () => {
    const res = await req('/api/program', { as: 'visitor' });
    const body = await res.json();
    assert.equal(body.open, false);
    assert.deepEqual(Object.keys(body).sort(), ['message', 'open'], 'the closed reply is two fields');
    assert.equal(JSON.stringify(body).includes(imageUrl), false);
  });

  test('no response to a member or a stranger anywhere mentions the image key', async () => {
    // The coverage gap review flagged: `/images/:key` is deliberately ungated, so the only thing
    // keeping a program's insert private before its Sunday is that nothing hands the key out. An
    // image on a flyer is a poster; an image of a printed program is the same list of names the
    // window exists to withhold.
    const key = imageUrl.split('/').pop();
    for (const as of ['visitor', undefined]) {
      for (const path of ['/', '/api/program', '/api/announcements', '/api/pages', '/manifest.webmanifest']) {
        const text = await (await req(path, { as })).text();
        assert.equal(text.includes(key), false, `${path} must not name the program's image (${as ?? 'stranger'})`);
      }
    }
  });

  test('outside the window the image itself is not served, except to the dashboard', async () => {
    // Its key alone used to be enough: images were ungated and cached for a year, so a photo of a
    // printed program outlived its window for anyone who had the address.
    assert.equal((await req(imageUrl, { as: 'visitor' })).status, 404, 'a member, outside the window');
    assert.equal((await req(imageUrl)).status, 404, 'a stranger');
    assert.equal((await req(imageUrl, { as: 'admin' })).status, 200, 'the dashboard still sees it, any day');
  });

  test('the edit page warns that this date can never be shown', async () => {
    // The window now says a different day of the week, so this program will never appear to a
    // member — and that failure has no other symptom: it saves cleanly and lists normally. Warn,
    // never reject: the window is a setting an admin can move, and refusing the save would leave
    // the clerk with nowhere to put what they just typed.
    const dayName = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ][TODAY_DOW];
    const page = await (await req(`/admin/programs/${programId}/edit`, { as: 'admin' })).text();
    assert.match(page, new RegExp(`Dated a ${dayName}`), 'a standing warning, not just a flash');

    const saved = await adminPost(`/admin/programs/${programId}`, {
      program_date: TODAY,
      body: 'Presiding ... Bishop Smith',
    });
    assert.equal(saved.status, 302);
    const location = decodeURIComponent(saved.headers.get('location'));
    assert.match(location, new RegExp(`^/admin/programs/${programId}/edit`), 'back to the form');
    assert.match(location, /Heads up/, 'and the save says so too');
  });

  test('the dashboard preview still names it, which is what makes the check meaningful', async () => {
    // Not the public API — a signed-in session gets the same closed reply there as anyone — but the
    // fragment the dashboard's preview modal fetches, behind the login.
    const closed = await (await req('/api/program', { as: 'admin' })).json();
    assert.equal(closed.open, false);
    const preview = await req(`/admin/programs/${programId}/preview/fragment`, { as: 'admin' });
    assert.equal(preview.status, 200);
    assert.ok((await preview.text()).includes(imageUrl));
  });
});

describe('the script policy', () => {
  // `script-src 'self' 'nonce-…'` (src/csp.ts): an inline script runs only if it carries this
  // response's nonce, and inline event handlers never do. A page that forgets either has a button
  // that silently does nothing in a real browser while every HTTP test still passes — so every
  // page is checked here, for both.
  const pages = [
    ['/admin', 'admin'],
    ['/admin/me', 'admin'],
    ['/admin/announcements/new', 'admin'],
    ['/admin/pages/new', 'admin'],
    ['/admin/programs/new', 'admin'],
    ['/admin/programs/new?example=1', 'admin'],
    ['/admin/subscribers', 'admin'],
    ['/admin/login', undefined],
    ['/admin/invite', undefined],
    ['/', 'visitor'], // the member page (the cached shell)
    ['/', undefined], // the gate page
  ];

  test('every inline script carries the nonce in the policy, and no inline handler is left', async () => {
    for (const [path, as] of pages) {
      const res = await req(path, { as });
      assert.equal(res.status, 200, path);
      const policy = res.headers.get('content-security-policy') ?? '';
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(policy)?.[1];
      assert.ok(nonce, `${path}: the policy names a nonce (${policy})`);
      const html = await res.text();
      const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
      assert.ok(inline.length > 0, `${path}: has inline scripts to check`);
      for (const [tag, attrs] of inline) {
        assert.match(attrs, new RegExp(`\\bnonce="${nonce.replace(/[+/=]/g, (c) => `\\${c}`)}"`), `${path}: ${tag}`);
      }
      const handler = /<[^>]+\son[a-z]+\s*=/i.exec(html);
      assert.equal(handler, null, `${path}: an inline event handler (${handler?.[0].slice(0, 80)})`);
    }
  });

  test('the nonce is new on every response', async () => {
    const nonceOf = async () => /'nonce-([^']+)'/.exec((await req('/admin/login')).headers.get('content-security-policy'))?.[1];
    assert.notEqual(await nonceOf(), await nonceOf());
  });
});

describe('pre-publication hardening', () => {
  const post = (path, form, headers) => req(path, { as: 'admin', method: 'POST', form, headers });

  test('every response refuses to be framed', async () => {
    const res = await req('/');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(res.headers.get('content-security-policy') ?? '', /object-src 'none'; base-uri 'none'/);
    assert.match(res.headers.get('content-security-policy') ?? '', /form-action 'self'/);
  });

  test('a write from another site is refused; the same site is not', async () => {
    const form = { title: 'Cross-site', body: 'x', published: '1' };
    assert.equal((await post('/admin/announcements', form, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post('/admin/announcements', form, { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await post('/admin/announcements', form, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/admin/announcements', form, { 'sec-fetch-site': 'same-origin' })).status, 302);
  });

  test('an opaque origin (`Origin: null`) is another site, not no site', async () => {
    // A sandboxed frame or a data: page sends `Origin: null` and, in an older browser, no
    // Sec-Fetch-Site; the owner's cookie rides along, so it has to be refused by what it says.
    const res = await post('/admin/me/signout-everywhere', {}, { origin: 'null' });
    assert.equal(res.status, 403);
    assert.equal((await req('/admin', { as: 'admin' })).status, 200, 'the owner is still signed in');
  });

  test('a push subscription must be an https push service, never an internal address', async () => {
    await unlockMember(req, 'subscriber');
    const keys = { p256dh: 'BP' + 'a'.repeat(85), auth: 'b'.repeat(22) };
    for (const endpoint of ['http://push.example.test/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'not a url']) {
      const res = await req('/api/subscribe', { as: 'subscriber', method: 'POST', json: { endpoint, keys } });
      assert.equal(res.status, 400, endpoint);
    }
  });

  test('the Subscribers page names a device by its push host and the tail of its endpoint, never the whole of it', async () => {
    // The endpoint is a capability — whoever holds it can post to that phone — and the page is HTML
    // an admin may copy or screenshot, so the tooltip that tells two iPhones apart carries only the
    // service's host and the last ten characters.
    await unlockMember(req, 'subscriber');
    const endpoint = 'https://web.push.apple.com/QAbCdEfGhIjKlMnOpQrStUvWxYz0123456789secretTail';
    const keys = { p256dh: 'BP' + 'a'.repeat(85), auth: 'b'.repeat(22) };
    assert.equal((await req('/api/subscribe', { as: 'subscriber', method: 'POST', json: { endpoint, keys } })).status, 201);
    await login();
    const html = await (await req('/admin/subscribers', { as: 'admin' })).text();
    assert.ok(html.includes('title="web.push.apple.com …secretTail"'), 'the tooltip: host and the last ten characters');
    assert.ok(!html.includes('QAbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'the endpoint itself is not in the page');
  });

  test('an owner cookie keyed by the password alone is refused', async () => {
    const { createHash, createHmac } = await import('node:crypto');
    const secret = createHash('sha256').update(`pushannounce-session::${ADMIN_PASSWORD}`).digest('hex');
    const value = `ok.${Math.floor(Date.now() / 1000)}`;
    const sig = createHmac('sha256', secret).update(value).digest('base64').replace(/=/g, '');
    const res = await req('/admin', { headers: { cookie: `pushannounce_session=${value}.${sig}` } });
    assert.equal(res.status, 302, 'without the database-held half of the key, it is no key');
  });

  test('on Node, a client-supplied CF-Connecting-IP is no way around the login limit', { skip: TARGET === 'worker' }, async () => {
    // A generic reverse proxy passes CF-Connecting-IP straight through, so trusting it would let
    // every guess come from a "new" address. Only the address the proxy saw counts.
    let limited = false;
    for (let i = 0; i < 8 && !limited; i++) {
      const res = await req('/admin/login', {
        method: 'POST',
        form: { password: `guess-${i}` },
        headers: { 'cf-connecting-ip': `203.0.113.${i + 1}`, 'x-forwarded-for': '198.51.100.77' },
      });
      if (res.status === 429) limited = true;
    }
    assert.ok(limited, 'the sixth guess from one address is refused, whatever CF-Connecting-IP says');
  });
});

describe('client addresses and configuration (in process)', () => {
  test('rate limits key on the right address for what is in front of the app', async () => {
    const { clientIp } = await import('../dist/http.js');
    const ctx = (headers) => ({ req: { header: (n) => headers[n.toLowerCase()] } });
    const both = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1, 198.51.100.7' };
    assert.equal(clientIp(ctx(both), 'cloudflare'), '203.0.113.9');
    assert.equal(clientIp(ctx(both), 'proxy', () => '10.0.0.1'), '198.51.100.7', 'the last hop, never the first');
    assert.equal(clientIp(ctx(both), 'socket', () => '10.0.0.1'), '10.0.0.1', 'no headers trusted at all');
    assert.equal(clientIp(ctx({ 'cf-connecting-ip': '2001:db8:abcd:12::1' })), '2001:db8:abcd:12::/64');
    assert.equal(clientIp(ctx({ 'cf-connecting-ip': '2001:db8:abcd:12:ffff::9' })), '2001:db8:abcd:12::/64');
  });

  test('a well-known example password stops the boot, with a message saying what to fix', async () => {
    const { ConfigError, assertConfig, loadConfig } = await import('../dist/config.js');
    const base = { APP_NAME: 'W', APP_SHORT_NAME: 'W', APP_DESCRIPTION: 'W' };
    for (const password of ['changeme', 'Password', 'admin']) {
      const cfg = loadConfig({ ...base, ADMIN_PASSWORD: password });
      assert.throws(() => assertConfig(cfg), (err) => err instanceof ConfigError && /well-known example/.test(err.message));
    }
    assert.doesNotThrow(() => assertConfig(loadConfig({ ...base, ADMIN_PASSWORD: 'a long passphrase of my own' })));
  });

  test('a blank TZ is the default, and an unknown one stops the boot saying so', async () => {
    // Found in an audit: `TZ=` reached Intl as '' and threw out of the boot-time purge — an
    // unhandled rejection that ended the Node process on every start.
    const { ConfigError, assertConfig, loadConfig } = await import('../dist/config.js');
    const base = { APP_NAME: 'W', APP_SHORT_NAME: 'W', APP_DESCRIPTION: 'W', ADMIN_PASSWORD: 'a long passphrase of my own' };
    assert.equal(loadConfig({ ...base, TZ: '' }).timezone, 'America/Denver');
    assert.equal(loadConfig({ ...base, TZ: '  ' }).timezone, 'America/Denver');
    assert.equal(loadConfig({ ...base, TZ: 'Pacific/Auckland' }).timezone, 'Pacific/Auckland');
    const bad = loadConfig({ ...base, TZ: 'Mountain' });
    assert.throws(() => assertConfig(bad), (err) => err instanceof ConfigError && /TZ must be an IANA time zone/.test(err.message));
    loadConfig(base);
  });

  test('push endpoints: real push services in production, any https host only outside it', async () => {
    const { isPushEndpoint } = await import('../dist/app.js');
    for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) {
      assert.ok(isPushEndpoint(ok, true), ok);
    }
    assert.ok(!isPushEndpoint('https://push.example.test/x', true), 'not a push service');
    assert.ok(!isPushEndpoint('https://evil.push.apple.com.example/x', true), 'look-alike suffix');
    assert.ok(isPushEndpoint('https://push.example.test/x', false), 'tests may use any https host');
    assert.ok(!isPushEndpoint('https://10.0.0.5/x', false), 'never an IP literal');
  });
});

describe('the pages a stranger can reach say the app is not official', () => {
  // The General Handbook line (`DISCLAIMER` in src/views.ts) belongs on every page someone without
  // access can open, not only the member shell and the gate. Read from the source rather than the
  // build, so this file runs the same under test:worker, which compiles nothing.
  const DISCLAIMER = /export const DISCLAIMER = '([^']+)'/.exec(
    readFileSync(new URL('../src/views.ts', import.meta.url), 'utf8'),
  )[1];

  test('the sign-in page', async () => {
    const res = await req('/admin/login', { as: 'nobody' });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(DISCLAIMER));
  });

  test('the invite page', async () => {
    const res = await req('/admin/invite', { as: 'nobody' });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(DISCLAIMER));
  });
});
