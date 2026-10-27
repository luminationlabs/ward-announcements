// End-to-end tests for the member access gate.
//
// These drive a real server over HTTP against a throwaway SQLite file rather than importing the
// modules directly, because what matters here is the *composed* behaviour: the gate middleware, the
// cookie, the credential kinds and the routes all have to agree. Several of the failures these
// guard against are only visible end to end — a credential that verifies fine in isolation but is
// accepted on the wrong route, or a member who keeps access everywhere except one reload path.
//
// Run with: npm test           (the Node entry; builds first — dist/ is the artefact that ships)
//        or: npm run test:worker (the same tests against `wrangler dev`, i.e. the real Workers
//                                 runtime on a throwaway local D1 — see test/helpers/harness.js)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, createClient, startServer, testPort } from './helpers/harness.js';

let server;
let BASE;
let req;

before(async () => {
  server = await startServer({ port: testPort() });
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
async function deviceTokenFor(as) {
  const manifest = await (await req('/manifest.webmanifest', { as })).json();
  return new URL(manifest.start_url, BASE).searchParams.get('code');
}
const unlock = (as, code) => req('/api/access', { as, method: 'POST', json: { code } });
const isGatePage = async (res) => (await res.text()).includes('id="gate-msg"');

// ---------------------------------------------------------------------------

describe('access gate', () => {
  before(async () => {
    await login();
  });

  test('a fresh deployment is gated from its first request, and cannot be made public', async () => {
    // No admin has done anything to this database: boot minted the first code.
    assert.ok(await activeCode(), 'a code is in force without anyone issuing one');
    assert.equal((await req('/api/announcements')).status, 401, 'closed to a stranger');
    // The Resources tab's pages are behind the same gate as the announcements.
    assert.equal((await req('/api/pages')).status, 401, 'pages are gated too');
    // The switch that made the page public is gone, route and button alike.
    assert.equal((await adminPost('/admin/access/disable')).status, 404);
    assert.doesNotMatch(await (await req('/admin', { as: 'admin' })).text(), /Turn (off|on) the access gate/);
    assert.equal((await req('/api/announcements')).status, 401, 'still closed');
  });

  test('a member unlocks with the shared code and stays in', async () => {
    const code = await activeCode();
    assert.equal((await unlock('member', code)).status, 200);
    assert.equal((await req('/api/announcements', { as: 'member' })).status, 200);
  });

  test('a wrong code is rejected', async () => {
    assert.equal((await unlock('nobody', 'not-a-real-code')).status, 401);
    assert.equal((await req('/api/announcements', { as: 'nobody' })).status, 401);
  });

  test('rotation retires the old code but never evicts a member', async () => {
    const old = await activeCode();
    await unlock('rotator', old);

    await adminPost('/admin/access/rotate', { grace: '0' });
    const fresh = await activeCode();
    assert.notEqual(fresh, old, 'a new code was issued');

    assert.equal(
      (await req('/api/announcements', { as: 'rotator' })).status,
      200,
      'members who already unlocked are unaffected by rotation',
    );
    assert.equal((await unlock('latecomer', old)).status, 401, 'the retired code stops working');
    assert.equal((await unlock('latecomer', fresh)).status, 200, 'the new code works');
  });

  test('a retired code keeps working through its grace window', async () => {
    const old = await activeCode();
    await adminPost('/admin/access/rotate', { grace: '30' });
    assert.equal((await unlock('grace', old)).status, 200, 'still usable inside the grace window');
  });

  test('a later rotation\'s grace is the ceiling for every older code, "indefinitely" included', async () => {
    // Retiring only ever touched the active code, so a code once kept "indefinitely" could never be
    // stopped from the dashboard: the next "Stop it immediately" left it open for good.
    const forever = await activeCode();
    await adminPost('/admin/access/rotate', { grace: 'never' });
    assert.equal((await unlock('kept', forever)).status, 200, 'kept indefinitely, for now');
    await adminPost('/admin/access/rotate', { grace: '0' });
    assert.equal((await unlock('late', forever)).status, 401, 'stopped with everything older');
    assert.equal((await unlock('late', await activeCode())).status, 200, 'the current code works');
  });

  test('the manifest names the app by a fixed id, not by its secret-bearing start_url', async () => {
    const manifest = await (await req('/manifest.webmanifest', { as: 'member' })).json();
    assert.equal(manifest.id, '/');
    assert.notEqual(manifest.start_url, '/', 'the installed app still launches with its device token');
  });
});

describe('installed apps', () => {
  before(async () => {
    await login();
    await adminPost('/admin/access/rotate', { grace: '0' }); // a fresh code, the old one dead
    await unlock('installed', await activeCode());
  });

  test('the manifest carries a device token only for members', async () => {
    const anon = await (await req('/manifest.webmanifest')).json();
    assert.equal(anon.start_url, '/', 'anonymous manifest leaks no credential');

    const token = await deviceTokenFor('installed');
    assert.ok(token, 'an authenticated manifest fetch embeds a device token');
  });

  test('the device token survives code rotation', async () => {
    const token = await deviceTokenFor('installed');
    await adminPost('/admin/access/rotate', { grace: '0' });
    const res = await req(`/?code=${encodeURIComponent(token)}`, { as: 'coldlaunch' });
    assert.equal(res.status, 302, 'cold launch still unlocks after the code rotated');
    assert.equal((await req('/api/announcements', { as: 'coldlaunch' })).status, 200);
  });

  test('a cold launch keeps its device token instead of orphaning it', async () => {
    // If redeeming a device token minted a *new* device id, the next manifest fetch would issue a
    // second token and the one that had just worked would stay valid-but-unused for five years: one
    // phone accumulating a live credential every time it re-unlocked.
    const token = await deviceTokenFor('installed');
    await req(`/?code=${encodeURIComponent(token)}`, { as: 'coldlaunch2' });
    assert.equal(
      await deviceTokenFor('coldlaunch2'),
      token,
      'the relaunched app is handed back the same token it presented',
    );
  });
});

describe('signing everyone out', () => {
  let deviceToken;
  let oldCode;

  before(async () => {
    await login();
    await adminPost('/admin/access/rotate', { grace: '0' }); // a fresh code, the old one dead
    oldCode = await activeCode();
    await unlock('victim', oldCode);
    deviceToken = await deviceTokenFor('victim');
    await adminPost('/admin/access/rotate', { grace: '7', evict: 'browsers' }); // a week asked for, zero given
  });

  test('every member cookie is invalidated', async () => {
    assert.equal((await req('/api/announcements', { as: 'victim' })).status, 401);
  });

  test('the code they came in with stopped at once, whatever grace was asked for', async () => {
    // Otherwise the stranger being evicted reopens the link they already have.
    assert.equal((await unlock('again', oldCode)).status, 401);
  });

  test('an empty grace is refused rather than read as "stop it immediately"', async () => {
    const before = await activeCode();
    const res = await adminPost('/admin/access/rotate', { grace: '' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /Pick\+how\+long|Pick%20how%20long/u);
    assert.equal(await activeCode(), before, 'no code was issued');
  });

  test('an eviction choice the form does not offer is refused', async () => {
    const res = await adminPost('/admin/access/rotate', { grace: '0', evict: 'everyone-please' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /Pick\+who\+is\+signed\+out|Pick%20who%20is%20signed%20out/u);
  });

  test('the admin session is not collateral damage', async () => {
    assert.equal((await req('/admin', { as: 'admin' })).status, 200);
  });

  test('the shared code still works, so members can get back in', async () => {
    assert.equal((await unlock('returning', await activeCode())).status, 200);
  });

  test('an installed app recovers on a cold launch', async () => {
    const res = await req(`/?code=${encodeURIComponent(deviceToken)}`, { as: 'relaunched' });
    assert.equal(res.status, 302);
    assert.equal((await req('/api/announcements', { as: 'relaunched' })).status, 200);
  });

  test('but an already-open app lands on the gate page until it is relaunched', async () => {
    // Documents a real limitation rather than asserting ideal behaviour: app.js reloads "/" on a
    // 401, and that request carries no credential. The admin copy and the gate page both say so.
    assert.equal(await isGatePage(await req('/', { as: 'victim' })), true);
  });
});

describe('member invites', () => {
  before(async () => {
    await login();
    await adminPost('/admin/access/rotate', { grace: '0' }); // a fresh code, the old one dead
    await unlock('host', await activeCode());
  });

  test('a member can mint an invite that unlocks someone else', async () => {
    const invite = await (await req('/api/invite', { as: 'host', method: 'POST' })).json();
    const token = new URL(invite.url).hash.replace('#i=', '');
    assert.equal((await unlock('guest', token)).status, 200);
    assert.equal(invite.expiresInDays, 30, 'reports the configured window');
  });

  test('invites are unlimited-use inside their window', async () => {
    const invite = await (await req('/api/invite', { as: 'host', method: 'POST' })).json();
    const token = new URL(invite.url).hash.replace('#i=', '');
    assert.equal((await unlock('guest-a', token)).status, 200);
    assert.equal((await unlock('guest-b', token)).status, 200);
  });

  test('a stranger cannot mint one', async () => {
    assert.equal((await req('/api/invite', { as: 'stranger', method: 'POST' })).status, 401);
  });

  test('the invite window is admin-settable and rejects nonsense', async () => {
    await adminPost('/admin/access/settings', { gate_message: 'Members only.', invite_ttl_days: '7' });
    const invite = await (await req('/api/invite', { as: 'host', method: 'POST' })).json();
    assert.equal(invite.expiresInDays, 7);

    await adminPost('/admin/access/settings', { gate_message: 'x', invite_ttl_days: '9999' });
    const after = await (await req('/api/invite', { as: 'host', method: 'POST' })).json();
    assert.equal(after.expiresInDays, 7, 'an out-of-range value is rejected, not stored');
  });

  test('the gate message is what the locked page shows', async () => {
    await adminPost('/admin/access/settings', {
      gate_message: 'Ask the clerk for a link.',
      invite_ttl_days: '30',
    });
    const body = await (await req('/')).text();
    assert.match(body, /Ask the clerk for a link\./);
  });
});

describe('revoking all saved access', () => {
  // "Sign everyone out" deliberately spares installed apps (their device token re-unlocks them). The
  // hard stop also cancels every device token, invite link and email link: only the current code
  // gets anyone back in. Before it existed, a leaked token kept working for its full five years.
  let deviceToken;
  let inviteToken;

  before(async () => {
    await login();
    await adminPost('/admin/access/rotate', { grace: '0' });
    await unlock('keeper', await activeCode());
    deviceToken = await deviceTokenFor('keeper');
    const invite = await (await req('/api/invite', { as: 'keeper', method: 'POST' })).json();
    inviteToken = new URL(invite.url).hash.replace('#i=', '');
    assert.ok(deviceToken && inviteToken);
    const res = await adminPost('/admin/access/rotate', { grace: '0', evict: 'all' });
    assert.equal(res.status, 302);
  });

  test('a member cookie stops working', async () => {
    assert.equal((await req('/api/announcements', { as: 'keeper' })).status, 401);
  });

  test("an installed app's device token no longer unlocks", async () => {
    assert.notEqual((await unlock('relaunch', deviceToken)).status, 200);
  });

  test('a member invite link no longer unlocks', async () => {
    assert.notEqual((await unlock('invited', inviteToken)).status, 200);
  });

  test('an installed app lands on a gate it can paste the new link into, and that gets it back', async () => {
    // The app's start_url (`/?code=<device token>`) is frozen at install, so after the hard stop it
    // shows the gate on every launch. The app has no address bar, and a link tapped elsewhere opens
    // Safari, whose cookies are not the app's — the gate's paste field is its one way back in.
    const launch = await req(`/?code=${encodeURIComponent(deviceToken)}`, { as: 'homescreen' });
    assert.equal(launch.status, 200);
    const nonce = /'nonce-([^']+)'/.exec(launch.headers.get('content-security-policy') ?? '')?.[1];
    const gate = await launch.text();
    assert.ok(gate.includes('id="gate-msg"'), 'the gate, not the app');
    assert.match(gate, /<form id="gate-paste"/);
    assert.match(gate, /<input id="gate-paste-input"/);
    assert.ok(nonce && gate.includes(`<script nonce="${nonce}">`), 'its script runs under the CSP');

    // What the field posts is the ordinary exchange; once it succeeds the same frozen start_url
    // opens the app, its dead token simply unused beside a good cookie.
    assert.equal((await unlock('homescreen', await activeCode())).status, 200);
    const relaunch = await req(`/?code=${encodeURIComponent(deviceToken)}`, { as: 'homescreen' });
    assert.equal(relaunch.status, 200);
    assert.equal(await isGatePage(relaunch), false);
  });

  test('the current code still does, and the admin is still signed in', async () => {
    assert.equal((await unlock('fresh', await activeCode())).status, 200);
    assert.equal((await req('/admin', { as: 'admin' })).status, 200);
  });
});

describe('the gate does not break the app shell', () => {
  before(async () => {
    await login();
    await adminPost('/admin/access/rotate', { grace: '0' }); // a fresh code, the old one dead
  });

  test('assets a locked visitor needs are still served', async () => {
    // The gate page and the unlock script are useless without these, and an installed app cold-
    // launching needs its manifest before it has any cookie at all.
    for (const path of ['/styles.css', '/app.js', '/sw.js', '/manifest.webmanifest', '/healthz']) {
      assert.equal((await req(path)).status, 200, `${path} must stay reachable`);
    }
  });

  test('both public pages say it is not an official Church site', async () => {
    // The General Handbook asks for this on any calling-related site, so it is fixed in the footer
    // rather than left to APP_FOOTER — a deployment that sets no footer must still show it.
    const disclaimer = 'Not an official service of The Church of Jesus Christ of Latter-day Saints';
    const gate = await (await req('/', { as: 'stranger' })).text();
    assert.ok(gate.includes('id="gate-msg"') && gate.includes(disclaimer), 'the gate page carries it');

    assert.equal((await unlock('reader', await activeCode())).status, 200);
    const shell = await (await req('/', { as: 'reader' })).text();
    assert.ok(!shell.includes('id="gate-msg"') && shell.includes(disclaimer), 'the app shell carries it');
  });

  test('the admin area is reachable past the member gate', async () => {
    assert.equal((await req('/admin/login')).status, 200);
  });

  test('a malformed cookie shows the gate rather than 500-ing', async () => {
    // A lockout-grade crash to guard against: a percent-decoded cookie whose character length
    // matches but whose byte length does not must not throw out of the gate middleware.
    const res = await fetch(`${BASE}/api/announcements`, {
      headers: { cookie: 'pushannounce_access=v1.abc.123.café' },
    });
    assert.equal(res.status, 401);
  });
});
