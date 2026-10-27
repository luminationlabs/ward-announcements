// End-to-end tests for the two roles: admin, and the reduced "editor".
//
// The split is enforced on the *routes*, not by the dashboard omitting buttons, so that is what
// these assert first: an editor session posting straight at a settings route gets 403, whatever the
// page it came from happened to render. The dashboard assertions are the second half of the same
// claim — an editor should not be shown a control that would only 403 if they pressed it.
//
// The admin here is the owner (ADMIN_PASSWORD); the editor is a person the owner added, signed in
// with a passkey made by the software authenticator (helpers/webauthn.js).
// test/passkeys.test.js covers the passkey flow itself.
//
// Runs on both runtimes, like the other end-to-end suites:
//   npm test            (the Node entry)
//   npm run test:worker (`wrangler dev`, i.e. the real Workers runtime)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, addPersonWithPasskey, createClient, startServer, testPort, unlockMember } from './helpers/harness.js';

let server;
let req;
/** The owner's sign-in and the editor's passkey registration, kept for the cookie assertions. */
let adminLogin;
let editorLogin;
/** `name=value` for each session cookie, for the request that presents both at once. */
let adminCookie;
let editorCookie;

/** The `name=value` part of the Set-Cookie line for `name`, or undefined if it wasn't set. */
function issuedCookie(res, name) {
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`));
  const pair = line?.split(';')[0];
  return pair && pair !== `${name}=` ? pair : undefined;
}

const ORIGIN = 'https://ward.example.org';

before(async () => {
  // Its own port: `node --test` runs the files in parallel. PUBLIC_ORIGIN because without one the
  // dashboard renders no QR at all (there is no absolute link to encode), and whether an editor is
  // shown the QR is one of the things under test. It is also the site the editor's passkey is for.
  server = await startServer({
    port: testPort(4),
    env: { PUBLIC_ORIGIN: ORIGIN },
  });
  req = createClient(server.base);
  adminLogin = await req('/admin/login', {
    as: 'admin',
    method: 'POST',
    form: { password: ADMIN_PASSWORD },
  });
  ({ verify: editorLogin } = await addPersonWithPasskey(req, { as: 'editor', origin: ORIGIN, role: 'editor', name: 'Test Editor' }));
  adminCookie = issuedCookie(adminLogin, 'pushannounce_session');
  editorCookie = issuedCookie(editorLogin, 'pushannounce_user');
  assert.ok(adminCookie && editorCookie, 'both sign-ins should have issued their cookie');
  // The member gate is always on: the public pages are read as members — a plain one, and the
  // editor (signing in to the dashboard does not unlock the public page; it is the same for all).
  await unlockMember(req, 'member');
  await unlockMember(req, 'editor');
});

after(() => server?.stop());

const post = (as, path, form) => req(path, { as, method: 'POST', form });
const dashboard = (as) => req('/admin', { as }).then((res) => res.text());

/** Today's local date, the way the server computes it (the harness pins TZ=America/Denver). */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

// ---------------------------------------------------------------------------

describe('signing in', () => {
  test('an editor’s passkey opens a person session, and it is not the owner one', () => {
    assert.equal(editorLogin.status, 200);
    const cookies = editorLogin.headers.getSetCookie();
    const userCookie = cookies.find((line) => line.startsWith('pushannounce_user='));
    assert.ok(userCookie, 'a person session cookie should be set');
    assert.match(userCookie, /HttpOnly/iu);
    // The owner cookie is *cleared* here, never set — see the shared-computer test below.
    const owner = cookies.find((line) => line.startsWith('pushannounce_session='));
    assert.ok(owner, 'the owner cookie should be explicitly cleared');
    assert.match(owner, /Max-Age=0/u);
  });

  test('a wrong password opens nothing', async () => {
    const res = await req('/admin/login', {
      as: 'nobody',
      method: 'POST',
      form: { password: 'not-the-password' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.equal((await req('/admin', { as: 'nobody' })).status, 302);
  });

  test('an empty password is not a login', async () => {
    const res = await req('/admin/login', { as: 'nobody', method: 'POST', form: { password: '' } });
    assert.equal(res.status, 401);
  });
});

/**
 * The clerk's-office computer: one browser, one person after another. A browser holding both
 * cookies is the owner, and signing in as a person takes the owner cookie away.
 */
describe('signing in on a browser that already has a session', () => {
  test('holding both cookies means the owner — which is why the clearing matters', async () => {
    const both = `${adminCookie}; ${editorCookie}`;
    const res = await req('/admin/backup.json', { headers: { cookie: both } });
    assert.equal(res.status, 200, 'the owner cookie wins when both are present');
  });

  test('so signing in as a person clears the owner cookie', () => {
    // Without this, handing the computer over with "sign in with your passkey" left the next
    // person holding the full admin dashboard, backup button and all.
    const cleared = editorLogin.headers
      .getSetCookie()
      .find((line) => line.startsWith('pushannounce_session='));
    assert.ok(cleared, 'the passkey sign-in must send a Set-Cookie for the owner cookie');
    assert.match(cleared, /^pushannounce_session=;/u, 'with an empty value');
    assert.match(cleared, /Max-Age=0/u);
    assert.match(cleared, /Path=\/(;|$)/u, 'on the path it was set with, or it deletes nothing');
  });

  test('and the reverse, so the owner is never left holding a person’s cookie', () => {
    const cleared = adminLogin.headers
      .getSetCookie()
      .find((line) => line.startsWith('pushannounce_user='));
    assert.ok(cleared, 'the owner sign-in must clear the person cookie too');
    assert.match(cleared, /Max-Age=0/u);
  });
});

describe('what an editor can do', () => {
  test('reaches the dashboard, labelled as the editor', async () => {
    const html = await dashboard('editor');
    assert.match(html, /Test Ward Editor/u);
    assert.doesNotMatch(html, /Test Ward Admin/u);
  });

  test('creates, edits and deletes an announcement', async () => {
    const created = await post('editor', '/admin/announcements', {
      title: 'From the editor',
      body: 'Ward temple night on Thursday.',
      published: '1',
    });
    assert.equal(created.status, 302);

    const html = await dashboard('editor');
    assert.match(html, /From the editor/u);
    const id = Number(html.match(/\/admin\/announcements\/(\d+)\/edit/u)[1]);

    assert.equal((await req(`/admin/announcements/${id}/edit`, { as: 'editor' })).status, 200);
    const saved = await post('editor', `/admin/announcements/${id}`, {
      title: 'From the editor (updated)',
      body: 'Moved to Friday.',
      published: '1',
    });
    assert.equal(saved.status, 302);
    // Actually visible to members, which is the whole point of letting an editor write one.
    const list = await (await req('/api/announcements', { as: 'member' })).json();
    assert.ok(list.announcements.some((a) => a.title === 'From the editor (updated)'));

    assert.equal((await post('editor', `/admin/announcements/${id}/delete`)).status, 302);
  });

  test('writes a program and can preview it outside the visibility window', async () => {
    const created = await post('editor', '/admin/programs', {
      program_date: TODAY,
      body: 'Presiding ... Bishop Smith',
    });
    assert.equal(created.status, 302);

    // The window is a *server* rule with no bypass: the public page shows an editor what a member
    // sees. Proofing is the dashboard's preview — the editor is usually the person who typed the
    // names, so it has to reach them too. (Inside the window everyone sees the program, which is why
    // the public check is conditional: the suite may genuinely run on a Sunday morning.)
    const id = Number((await dashboard('editor')).match(/\/admin\/programs\/(\d+)\/edit/u)[1]);
    const preview = await req(`/admin/programs/${id}/preview/fragment`, { as: 'editor' });
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /Bishop Smith/u);
    const asEditor = await (await req('/api/program', { as: 'editor' })).json();
    const anonymous = await (await req('/api/program', { as: 'member' })).json();
    assert.equal(asEditor.open, anonymous.open, 'the editor cookie changes nothing on the public page');
    if (!anonymous.open) assert.equal(asEditor.html, undefined);
    // Both places the button lives, for both roles.
    for (const as of ['editor', 'admin']) {
      assert.match(await dashboard(as), new RegExp(`data-program-preview="${id}"`, 'u'), `${as} dashboard`);
      const editPage = await (await req(`/admin/programs/${id}/edit`, { as })).text();
      assert.match(editPage, new RegExp(`data-program-preview="${id}"`, 'u'), `${as} edit page`);
    }

    // Deleting a program is the one content action an editor does not get: the record of a meeting
    // is not theirs to remove, and a wrong date is fixed by editing. Refused at the route, and the
    // button is absent from both places it would otherwise appear.
    assert.equal((await post('editor', `/admin/programs/${id}/delete`)).status, 403);
    assert.doesNotMatch(await dashboard('editor'), /\/admin\/programs\/\d+\/delete/u);
    const editPage = await (await req(`/admin/programs/${id}/edit`, { as: 'editor' })).text();
    assert.doesNotMatch(editPage, /delete-program/u);
    // An admin still can, from both.
    assert.match(await dashboard('admin'), /\/admin\/programs\/\d+\/delete/u);
    const adminEdit = await (await req(`/admin/programs/${id}/edit`, { as: 'admin' })).text();
    assert.match(adminEdit, /delete-program/u);
    assert.equal((await post('admin', `/admin/programs/${id}/delete`)).status, 302);
  });

  test('renders a Markdown preview', async () => {
    const res = await req('/admin/preview', {
      as: 'editor',
      method: 'POST',
      json: { body: '**bold**', kind: 'announcement' },
    });
    assert.equal(res.status, 200);
    assert.match((await res.json()).html, /<strong>bold<\/strong>/u);
  });

  test('skips a Sunday, and removes the skip again', async () => {
    // Deliberately not `requireAdmin`, unlike the schedule beside it: an editor can already cause a
    // week to be skipped by publishing nothing, so gating this would protect nothing and only
    // oblige the person most likely to know Conference is coming to go and ask.
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    // Not the word "General Conference": that is the note field's own placeholder, so it is in the
    // page whether or not a skip exists, and asserting on it would pass no matter what.
    const note = 'Stake conference weekend';
    // The delete form's hidden input is the unambiguous marker that a *row* is rendered.
    const row = new RegExp(`name="skip_date" value="${future}"`, 'u');

    assert.equal((await post('editor', '/admin/skips', { skip_date: future, note })).status, 302);
    const listed = await dashboard('editor');
    assert.match(listed, row);
    assert.match(listed, /Stake conference weekend/u);

    assert.equal((await post('editor', '/admin/skips/delete', { skip_date: future })).status, 302);
    const after = await dashboard('editor');
    assert.doesNotMatch(after, row);
    assert.doesNotMatch(after, /Stake conference weekend/u);
  });

  test('a date in the past is refused rather than stored where it can do nothing', async () => {
    await post('editor', '/admin/skips', { skip_date: '2020-01-05', note: 'Too late' });
    assert.doesNotMatch(await dashboard('editor'), /name="skip_date" value="2020-01-05"/u);
  });
});

describe('resource pages', () => {
  // The Resources tab is standing reference, written by
  // the same people who write announcements, so an editor gets the whole lifecycle. What matters
  // beyond that is the two ways a page must *not* leak: an unpublished page stays off the public
  // API, and a deleted one is gone from it.
  let id;

  test('an editor creates a page, and it reaches the Resources tab', async () => {
    const created = await post('editor', '/admin/pages', {
      title: 'Building information',
      body: 'Reserve a room through the [building scheduler](https://example.org/schedule).',
      published: '1',
    });
    assert.equal(created.status, 302);
    // To the edit page, so images can be attached straight away.
    assert.match(created.headers.get('location'), /^\/admin\/pages\/(\d+)\/edit/u);
    id = Number(created.headers.get('location').match(/\/admin\/pages\/(\d+)\/edit/u)[1]);

    const html = await dashboard('editor');
    assert.match(html, /Building information/u);
    assert.match(html, new RegExp(`id="page-rows"[\\s\\S]*data-id="${id}"`, 'u'), 'listed in the Resources card');

    const { pages } = await (await req('/api/pages', { as: 'member' })).json();
    const page = pages.find((p) => p.id === id);
    assert.ok(page, 'published, so on the public tab');
    assert.match(page.html, /href="https:\/\/example\.org\/schedule"/u);
  });

  test('an unpublished page is on the dashboard but not on the tab', async () => {
    assert.equal((await req(`/admin/pages/${id}/edit`, { as: 'editor' })).status, 200);
    const saved = await post('editor', `/admin/pages/${id}`, {
      title: 'Building information (draft)',
      body: 'Being updated.',
      // no `published` field: unchecked
    });
    assert.equal(saved.status, 302);
    assert.match(await dashboard('admin'), /Building information \(draft\)/u);
    const { pages } = await (await req('/api/pages', { as: 'member' })).json();
    assert.equal(pages.some((p) => p.id === id), false, 'hidden pages stay off the public API');
  });

  test('a save without a title is refused and hands the text back', async () => {
    const res = await post('editor', `/admin/pages/${id}`, { title: '', body: 'Kept text.', published: '1' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Kept text\./u);
  });

  test('pages keep a manual order', async () => {
    const second = await post('admin', '/admin/pages', { title: 'Meetinghouse map', body: 'x', published: '1' });
    const secondId = Number(second.headers.get('location').match(/\/admin\/pages\/(\d+)\/edit/u)[1]);
    // Restore the first page to published so both are on the tab, then put the newer one first.
    await post('editor', `/admin/pages/${id}`, { title: 'Building information', body: 'x', published: '1' });
    const reorder = await req('/admin/pages/reorder', {
      as: 'editor',
      method: 'POST',
      json: { ids: [secondId, id] },
    });
    assert.equal(reorder.status, 200);
    const { pages } = await (await req('/api/pages', { as: 'member' })).json();
    assert.deepEqual(
      pages.map((p) => p.id).filter((x) => x === id || x === secondId),
      [secondId, id],
    );
    assert.equal((await post('admin', `/admin/pages/${secondId}/delete`)).status, 302);
  });

  test('an editor can delete a page, and it is gone from the tab', async () => {
    assert.equal((await post('editor', `/admin/pages/${id}/delete`)).status, 302);
    const { pages } = await (await req('/api/pages', { as: 'member' })).json();
    assert.equal(pages.some((p) => p.id === id), false);
    assert.equal((await req(`/admin/pages/${id}/edit`, { as: 'editor' })).status, 404);
  });
});

describe('the rich text preview', () => {
  // The dashboard's modal and the standalone page both show exactly what /api/announcements would
  // return right now: a hidden announcement and an expired one are on the dashboard's list but must
  // not be in a copy or a PDF a member is meant to recognise.
  test('lists live announcements only, for both roles, in the modal and on its page', async () => {
    const make = (form) => post('editor', '/admin/announcements', form);
    assert.equal(
      (await make({
        title: 'Email live one',
        // A centered heading, a centered line after a double blank (so it carries a gap class too),
        // and ordinary emphasis: every block class the renderer emits has to become inline style.
        body: '## -> Centered heading <-\n\n\n-> Centered line <-\n\nA **bold** word.',
        published: '1',
      })).status,
      302,
    );
    assert.equal((await make({ title: 'Email hidden one', body: 'draft' })).status, 302);
    assert.equal(
      (await make({ title: 'Email expired one', body: 'gone', published: '1', expires_at: '2020-01-05' })).status,
      302,
    );

    for (const as of ['editor', 'admin']) {
      const html = await dashboard(as);
      assert.match(html, /id="preview-btn"/u, `${as} gets the button`);
      const modal = html.match(/<div id="preview-modal-body"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/u);
      assert.ok(modal, `${as} dashboard should render the preview modal`);
      assert.match(modal[1], /Email live one/u);
      // Inline styles rather than classes, so the paste survives a mail client dropping the CSS.
      assert.match(modal[1], /<h2 style="text-align:center">Centered heading<\/h2>/u);
      assert.match(modal[1], /<p style="text-align:center;margin-top:[0-9.]+em;margin-bottom:0.6em">Centered line<\/p>/u);
      assert.match(modal[1], /<strong>bold<\/strong>/u);
      assert.doesNotMatch(modal[1], /Email hidden one|Email expired one/u);
      assert.doesNotMatch(modal[1], /class="/u, 'nothing in the preview block may depend on the stylesheet');
      assert.match(html, /data-pdf-preview="preview-modal-body"/u, `${as} gets Save as PDF in the modal`);
      assert.match(html, /data-pdf-spinner/u, 'with a spinner for the download');
      assert.doesNotMatch(html, /[Ee]mail preview|Copy for email/u, 'the preview does not call itself an email');

      const page = await req('/admin/announcements/preview', { as });
      assert.equal(page.status, 200);
      const text = await page.text();
      assert.match(text, /Email live one/u);
      assert.doesNotMatch(text, /Email hidden one|Email expired one/u);
      assert.match(text, /data-copy-preview="preview-page-body"/u);
      assert.match(text, /data-pdf-preview="preview-page-body"/u);
      assert.match(text, /<script src="\/preview-pdf.js" defer>/u, 'the page loads the PDF converter');
    }
    // Both the hidden and the expired one are still on the dashboard's own list.
    assert.match(await dashboard('editor'), /Email hidden one[\s\S]*Email expired one|Email expired one[\s\S]*Email hidden one/u);

    assert.equal((await req('/admin/announcements/preview')).status, 302, 'a stranger is sent to log in');
    assert.equal((await req('/admin/announcements/preview/fragment')).status, 302, 'and so is one asking for the fragment');
    for (const t of ['Email live one', 'Email hidden one', 'Email expired one']) {
      // The title link carries its own row's id, so this cannot pick up a neighbouring row.
      const id = Number((await dashboard('editor')).match(new RegExp(`href="/admin/announcements/(\\d+)/edit">${t}<`, 'u'))?.[1]);
      assert.ok(id, `${t} should still be listed for cleanup`);
      await post('editor', `/admin/announcements/${id}/delete`);
    }
  });
  // The modal's markup is rendered with the dashboard, but a drag-to-reorder only POSTs the new
  // order, so the modal refetches the fragment on open — and the fragment has to reflect a reorder
  // straight away.
  test('the fragment the modal refetches follows a drag-to-reorder', async () => {
    const make = (title) => post('editor', '/admin/announcements', { title, body: 'x', published: '1' });
    assert.equal((await make('Order first')).status, 302);
    assert.equal((await make('Order second')).status, 302);
    const html = await dashboard('editor');
    const idOf = (t) => Number(html.match(new RegExp(`href="/admin/announcements/(\\d+)/edit">${t}<`, 'u'))?.[1]);
    const first = idOf('Order first');
    const second = idOf('Order second');
    assert.ok(first && second);

    const order = async () => {
      const res = await req('/admin/announcements/preview/fragment', { as: 'editor' });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, /<!doctype|<html/iu, 'the fragment is bare markup, not a page');
      return [text.indexOf('Order first'), text.indexOf('Order second')];
    };
    let [a, b] = await order();
    assert.ok(a >= 0 && b >= 0);
    const flipped = a < b ? [second, first] : [first, second];
    const saved = await req('/admin/announcements/reorder', { as: 'editor', method: 'POST', json: { ids: flipped } });
    assert.equal(saved.status, 200);
    const [a2, b2] = await order();
    assert.equal(a2 < b2, !(a < b), 'the fragment shows the new order without a dashboard reload');

    for (const id of [first, second]) await post('editor', `/admin/announcements/${id}/delete`);
  });

  // An expired session answers a fetch with a redirect to the sign-in page, which `fetch` follows
  // to a 200 — so a drag-to-reorder reported "saved" and an upload showed a JSON parse error. The
  // scripts are only testable as source: each leaves the redirect unfollowed and says what happened.
  test('the reorder and upload scripts treat a sign-in redirect as being signed out', async () => {
    const html = await dashboard('editor');
    const reorder = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gu).find((s) => s.includes('/admin/announcements/reorder'));
    assert.ok(reorder);
    assert.match(reorder, /redirect: 'manual'/u);
    assert.match(reorder, /opaqueredirect/u);
    assert.match(reorder, /Signed out/u);
    const form = await (await req('/admin/announcements/new', { as: 'editor' })).text();
    const upload = form.match(/<script[^>]*>([\s\S]*?)<\/script>/gu).find((s) => s.includes("fetch('/admin/attachments'"));
    assert.ok(upload);
    assert.match(upload, /redirect: 'manual'/u);
    assert.match(upload, /Signed out/u);
  });
});

describe('the dashboard is three tabs, and every form comes back to its own', () => {
  test('both roles get the same tab bar', async () => {
    for (const as of ['admin', 'editor']) {
      const html = await dashboard(as);
      for (const tab of ['content', 'notifications', 'settings']) {
        assert.match(html, new RegExp(`id="tab-${tab}"[^>]*role="tab"`, 'u'), `${as}: ${tab} tab`);
        assert.match(html, new RegExp(`id="panel-${tab}"`, 'u'), `${as}: ${tab} panel`);
      }
      // Content is the one open on arrival; the other two ship `hidden` and only script reveals
      // them. Asserting the exact attribute, not just the ids, is what catches a panel that renders
      // visible under another (or a second `aria-selected="true"` that lies to a screen reader).
      assert.match(html, /id="panel-content"[^>]*role="tabpanel"(?![^>]*\bhidden\b)[^>]*>/u, `${as}: content open`);
      assert.match(html, /id="panel-notifications"[^>]*\bhidden\b[^>]*>/u, `${as}: notifications hidden`);
      assert.match(html, /id="panel-settings"[^>]*\bhidden\b[^>]*>/u, `${as}: settings hidden`);
      assert.equal(html.match(/aria-selected="true"/gu).length, 1, `${as}: one selected tab`);
      // Only the selected tab sits in the tab order; the rest are reached with the arrow keys.
      assert.match(html, /id="tab-content"[^>]*tabindex="0"/u, `${as}: content in tab order`);
      assert.match(html, /id="tab-notifications"[^>]*tabindex="-1"/u, `${as}: notifications out of tab order`);
      assert.match(html, /id="tab-settings"[^>]*tabindex="-1"/u, `${as}: settings out of tab order`);
    }
  });

  // A redirect to a bare `/admin` would open Content, with the message about the schedule floating
  // above the announcements. The hash is what puts the admin back where they were.
  test('a skip lands on Notifications, an access change on Members', async () => {
    // A future date, so this is the *success* redirect being asserted: a past date is refused on
    // its own branch, and that branch keeping its hash proves nothing about this one.
    const future = new Date(Date.now() + 37 * 86_400_000).toISOString().slice(0, 10);
    const skip = await post('editor', '/admin/skips', { skip_date: future });
    assert.equal(skip.status, 302);
    assert.match(skip.headers.get('location') ?? '', /^\/admin\?msg=.*#notifications$/u);
    const refused = await post('editor', '/admin/skips', { skip_date: '2020-01-05' });
    assert.match(refused.headers.get('location') ?? '', /^\/admin\?msg=.*#notifications$/u);
    const removed = await post('editor', '/admin/skips/delete', { skip_date: future });
    assert.match(removed.headers.get('location') ?? '', /^\/admin\?msg=.*#notifications$/u);

    const access = await post('admin', '/admin/access/settings', {
      gate_message: 'Members only',
      invite_ttl_days: '7',
    });
    assert.equal(access.status, 302);
    assert.match(access.headers.get('location') ?? '', /^\/admin\?msg=.*#settings$/u);
  });
});

describe('what an editor cannot do', () => {
  // Every route the reduced dashboard leaves out. A stale tab, a bookmark or a hand-written POST
  // all land here, and all of them must be refused rather than quietly obeyed.
  const forbidden = [
    ['GET', '/admin/backup.json'],
    ['GET', '/admin/subscribers'],
    ['POST', '/admin/subscribers/1/delete'],
    ['POST', '/admin/programs/1/delete'],
    ['POST', '/admin/settings', { auto_send: '1' }],
    ['POST', '/admin/schedule', { dow: '3', time: '19:00' }],
    ['POST', '/admin/meeting-time', { meeting_dow: '3', meeting_time: '19:00' }],
    ['POST', '/admin/weekly-message', { weekly_title: 'x', weekly_body: 'y' }],
    ['POST', '/admin/send', { title: 'x', body: 'y', link_target: 'announcements' }],
    [
      'POST',
      '/admin/programs/settings',
      {
        program_dow: '3',
        program_start: '00:00',
        program_end: '23:59',
        program_closed_message: 'x',
        program_retention_days: '30',
      },
    ],
    ['POST', '/admin/access/rotate', { grace: '0' }],
    ['POST', '/admin/access/rotate', { grace: '0', evict: 'browsers' }],
    ['POST', '/admin/access/rotate', { grace: '0', evict: 'all' }],
    ['POST', '/admin/access/settings', { gate_message: 'x', invite_ttl_days: '2' }],
    ['POST', '/admin/getting-started/dismiss'],
    ['POST', '/admin/getting-started/show'],
    [
      'POST',
      '/admin/ward',
      { app_name: 'x', app_short_name: 'x', app_description: 'x', timezone: 'America/Denver' },
    ],
  ];

  for (const [method, path, form] of forbidden) {
    test(`${method} ${path} is refused`, async () => {
      const res = await req(path, { as: 'editor', method, form });
      assert.equal(res.status, 403, `${method} ${path} should be admin-only`);
    });
  }

  test('an admin session still reaches those routes', async () => {
    // The other half of the assertion above: 403 has to mean "wrong role", not "route is broken".
    const backup = await req('/admin/backup.json', { as: 'admin' });
    assert.equal(backup.status, 200);
    // Every subscription endpoint and every access code in one response — nothing may keep a copy.
    assert.equal(backup.headers.get('cache-control'), 'private, no-store');
    assert.equal((await req('/admin/subscribers', { as: 'admin' })).status, 200);
    assert.equal((await post('admin', '/admin/settings', { auto_send: '0' })).status, 302);
  });

  test('none of what it hides is rendered for an editor', async () => {
    const html = await dashboard('editor');
    for (const action of [
      '/admin/backup.json',
      '/admin/subscribers',
      '/admin/settings',
      '/admin/schedule',
      '/admin/meeting-time',
      '/admin/weekly-message',
      '/admin/send',
      '/admin/programs/settings',
      '/admin/access/',
      '/admin/ward',
    ]) {
      assert.ok(!html.includes(action), `the editor dashboard should not offer ${action}`);
    }
  });

  test('the admin dashboard still has all of it', async () => {
    const html = await dashboard('admin');
    for (const action of [
      '/admin/backup.json',
      '/admin/subscribers',
      '/admin/schedule',
      '/admin/meeting-time',
      '/admin/weekly-message',
      '/admin/send',
      '/admin/programs/settings',
      '/admin/ward',
    ]) {
      assert.ok(html.includes(action), `the admin dashboard should still offer ${action}`);
    }
  });

  // The one thing the split does *not* touch: an editor writes the same announcements an admin
  // does, so the rules about what may go in one have to reach both, collapsed but present.
  test('both roles get the content policy', async () => {
    for (const as of ['admin', 'editor']) {
      const html = await dashboard(as);
      assert.match(html, /content policy/iu, `${as} should see the content policy`);
      assert.match(html, /Never post private or sensitive circumstances/u);
    }
  });

  // An editor gets the schedule as a sentence rather than as the form that changes it. Both halves
  // matter: with auto-send off the "goes out on …" wording would be a plain untruth, and an editor
  // who believes it thinks the ward has been told when it hasn't.
  test('an editor is told when the weekly notification goes out', async () => {
    await post('admin', '/admin/schedule', { dow: '0', time: '08:00' });
    await post('admin', '/admin/settings', { auto_send: '1' });

    const on = await dashboard('editor');
    assert.match(on, /goes out with the weekly notification on\s+Sundays at 8:00 AM/u);
    assert.ok(!on.includes('/admin/schedule'), 'and still cannot change it');

    await post('admin', '/admin/settings', { auto_send: '0' });
    const off = await dashboard('editor');
    assert.match(off, /set for Sundays at 8:00 AM/u);
    assert.match(off, /automatic sending is\s+currently switched off/u);
    assert.doesNotMatch(off, /goes out with the weekly notification on/u);
  });
});

describe('the member access card', () => {
  before(async () => {
    await post('admin', '/admin/access/rotate', { grace: '0' }); // a fresh code from a known state
  });

  test('an editor gets the share link and the QR, and none of the controls', async () => {
    const html = await dashboard('editor');
    assert.match(html, /#code=/u, 'the editor should be able to hand out the link');
    assert.ok(html.includes('/admin/qr.svg'));
    assert.ok(!html.includes('/admin/access/rotate'));
    assert.ok(!html.includes('name="evict"'));
  });

  test('the QR download itself is open to an editor, in both formats', async () => {
    const svg = await req('/admin/qr.svg', { as: 'editor' });
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') ?? '', /image\/svg\+xml/u);
    assert.match(await svg.text(), /<svg/u);
    // These files *are* the access code. `.svg` and `.png` are the extensions a CDN caches on
    // sight, and `c.body(..., headers)` could have dropped a header set with `c.header()`.
    assert.equal(svg.headers.get('cache-control'), 'private, no-store');

    // The PNG is encoded by hand (`src/qr-png.ts`) precisely because the library's own PNG path
    // needs `node:zlib`, which Workers does not have — so this assertion earns its keep on the
    // `test:worker` run, where it is the only thing that would catch that.
    const png = await req('/admin/qr.png', { as: 'editor' });
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('cache-control'), 'private, no-store');
    assert.match(png.headers.get('content-disposition') ?? '', /filename="announcements-qr\.png"/u);
    const bytes = new Uint8Array(await png.arrayBuffer());
    assert.deepEqual(
      [...bytes.slice(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'PNG signature',
    );
    // IHDR carries the dimensions; a QR of a share link lands near the 1024px target.
    const width = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16);
    assert.ok(width > 500, `expected a printable width, got ${width}`);
    assert.ok(bytes.length > 1000, 'more than a header');
  });

  // The weekly email (and its PDF) can carry a way in. It must be a credential of its own — never
  // the shared code, which would sit in every archived email — and pressing the box repeatedly must
  // not mint a pile of them.
  test('the preview hands either role a link to the app that expires on its own', async () => {
    const link = async (as) => {
      const res = await req('/admin/announcements/preview/link', { as, method: 'POST' });
      assert.equal(res.status, 200, `${as} may ask for the link`);
      return (await res.json()).html;
    };
    const html = await link('editor');
    assert.match(html, /^<p data-app-link style="/u, 'one inline-styled block the scripts can find');
    assert.doesNotMatch(html, /class="|#code=/u, 'no stylesheet, and never the shared code');
    assert.match(html, /This link works through [A-Z][a-z]+ \d{1,2}\./u, 'it says when it stops working');
    const url = html.match(/href="(https:\/\/ward\.example\.org\/#i=[A-Za-z0-9_-]{43})"/u)?.[1];
    assert.ok(url, 'an absolute link carrying a token in the fragment');
    assert.equal(await link('admin'), html, 'asking again the same week is the same link, whoever asks');

    const token = url.split('#i=')[1];
    const unlock = (code) => req('/api/access', { as: 'email-reader', method: 'POST', json: { code } });
    assert.equal((await unlock(`${token}x`)).status, 401);
    assert.equal((await unlock(token)).status, 200, 'the token lets a reader in');

    for (const as of ['editor', 'admin']) {
      const page = await dashboard(as);
      assert.match(page, /data-app-link-toggle="preview-modal-body"/u, `${as} gets the checkbox`);
    }
    const stranger = await req('/admin/announcements/preview/link', { as: 'nobody', method: 'POST' });
    assert.equal(stranger.status, 302, 'a stranger cannot mint one');
  });

  // The printable flyer sits beside the QR downloads for both roles, and its details come from one
  // authenticated JSON route: the ward's names, the share link and that link's QR module matrix.
  test('both roles get the printable flyer, with the ward details it fills in', async () => {
    for (const as of ['editor', 'admin']) {
      const page = await dashboard(as);
      const card = page.slice(page.indexOf('<h2>Share With Members</h2>'));
      assert.match(card, /data-flyer-pdf="half"/u, `${as} gets the half-letter flyer`);
      assert.match(card, /data-flyer-pdf="two-up"/u, `${as} gets the two-per-sheet flyer`);
      assert.match(page, /<script src="\/flyer-pdf.js" defer>/u, 'the dashboard loads the flyer script');

      const res = await req('/admin/flyer.json', { as });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'private, no-store', 'it carries the access code');
      const data = await res.json();
      assert.equal(data.wardName, 'Test Ward');
      assert.equal(data.shortName, 'Test');
      const link = /<code class="share-link"[^>]*>([^<]+)<\/code>/u.exec(page)?.[1];
      assert.equal(data.link, link, 'the same share link the card shows');
      assert.match(data.link, /^https:\/\/ward\.example\.org\/#code=/u);
      assert.ok(data.qr.length >= 21 && data.qr.every((row) => row.length === data.qr.length && /^[01]+$/u.test(row)), 'a square module matrix');
      assert.equal(data.qr[0].slice(0, 7), '1111111', 'starting with a finder pattern');
    }
    const stranger = await req('/admin/flyer.json', { as: 'nobody' });
    assert.equal(stranger.status, 302, 'the details are the access code: not for a stranger');

    // Served without a member cookie, like the preview's script: a clerk's own browser may never
    // have unlocked the members' page.
    const script = await req('/flyer-pdf.js', { as: 'nobody' });
    assert.equal(script.status, 200);
    assert.match(await script.text(), /window\.FlyerPdf/u);
  });

  test('neither format is served to a stranger', async () => {
    for (const path of ['/admin/qr.svg', '/admin/qr.png']) {
      const res = await req(path, { as: 'nobody' });
      assert.equal(res.status, 302, `${path} should require a login`);
      assert.equal(res.headers.get('location'), '/admin/login');
    }
  });
});

/**
 * A session that runs out mid-edit. The save meets the login page; afterwards the clerk must land
 * back on the form, where the editor offers the draft it kept on the device (editor/drafts.js) —
 * not on the dashboard, with no way back to it. The return path is a dashboard path of this site
 * and nothing else: a sign-in link must not become a hop to someone else's.
 */
describe('signing in again goes back to the form', () => {
  const FORM = '/admin/announcements/1/edit';
  // Its own rate-limit bucket: the file's own login budget is spent by the sign-ins above.
  const ownBucket = { 'x-forwarded-for': '203.0.113.71' };
  const asPage = { accept: 'text/html,application/xhtml+xml' };

  test('opening a form signed out asks for a sign-in that remembers it', async () => {
    const res = await req(FORM, { as: 'returner', headers: asPage });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/admin/login?next=${encodeURIComponent(FORM)}`);
    const page = await (await req(res.headers.get('location'), { as: 'returner' })).text();
    assert.match(page, new RegExp(`name="next" value="${FORM}"`, 'u'), 'the password form carries it');
    assert.ok(page.includes(`location.href = ${JSON.stringify(FORM)} ||`), 'and so does the passkey sign-in');
  });

  test('a save posted signed out returns to the form it came from', async () => {
    const res = await req('/admin/announcements/1', {
      as: 'returner',
      method: 'POST',
      form: { title: 'x', body: 'y' },
      headers: { referer: `${server.base}${FORM}` },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/admin/login?next=${encodeURIComponent(FORM)}`);
  });

  test('a foreign referer is not a return path', async () => {
    const res = await req('/admin/announcements/1', {
      as: 'returner',
      method: 'POST',
      form: { title: 'x' },
      headers: { referer: 'https://evil.example/phish' },
    });
    assert.equal(res.headers.get('location'), '/admin/login');
  });

  test('the password sign-in honours it', async () => {
    const res = await req('/admin/login', {
      as: 'returner',
      method: 'POST',
      form: { password: ADMIN_PASSWORD, next: FORM },
      headers: ownBucket,
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), FORM);
  });

  test('anything but a dashboard path is ignored', async () => {
    for (const next of [
      'https://evil.example/admin',
      '//evil.example/admin',
      '/\\evil.example/admin',
      '/admin\r\nSet-Cookie: x=1',
      '/elsewhere',
      '/admin/login',
    ]) {
      // `returner` is signed in now, so GET /admin/login answers with where it would send them.
      const res = await req(`/admin/login?next=${encodeURIComponent(next)}`, { as: 'returner' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/admin', JSON.stringify(next));
    }
    const res = await req('/admin/login', {
      as: 'nobody',
      method: 'POST',
      form: { password: ADMIN_PASSWORD, next: 'https://evil.example/' },
      headers: ownBucket,
    });
    assert.equal(res.headers.get('location'), '/admin');
    assert.equal((await req(`/admin/login?next=${encodeURIComponent(FORM)}`, { as: 'returner' })).headers.get('location'), FORM);
  });
});

// Last on purpose: it ends the editor session, and re-establishing one would spend a fourth
// login attempt against a five-per-minute limit.
describe('signing out', () => {
  test('logging out ends the editor session', async () => {
    await post('editor', '/admin/logout');
    const res = await req('/admin', { as: 'editor' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/login');
  });
});
