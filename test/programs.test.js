// End-to-end tests for sacrament meeting programs.
//
// Driven over HTTP against a real server, so the suite runs unchanged on both runtimes:
//   npm test            (the Node entry, SQLite + images on disk)
//   npm run test:worker (`wrangler dev`, D1 + wrangler's local R2 simulation)
//
// The assertion that matters most is the one about the *window*: a program names the people
// conducting, speaking and praying, and the server has to refuse to render it outside its window
// even to a caller who holds the member cookie and asks the API directly. A test that only checked
// which tab the browser showed would pass on a build that shipped every name to every phone.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PASSWORD, createClient, startServer, testPort, unlockMember } from './helpers/harness.js';

let server;
let req;
/** The program dated today — what `/api/program` serves, and what most of these tests turn on. */
let todayProgramId;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// The harness pins the server to America/Denver, so "today" has to be asked of that zone rather
// than of whatever the machine running the tests is set to.
const TZ = 'America/Denver';
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
/** Day of week of the server's today, 0 = Sunday. */
const TODAY_DOW = new Date(`${TODAY}T00:00:00Z`).getUTCDay();

before(async () => {
  // Its own port: `node --test` runs the files in parallel, and two servers on one port fail as a
  // mystery timeout rather than as a conflict.
  server = await startServer({ port: testPort(2) });
  req = createClient(server.base);
});

after(() => server?.stop());

const login = () =>
  req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
const adminPost = (path, form) => req(path, { as: 'admin', method: 'POST', form });

/**
 * Force the window open or shut, by moving the *day* rather than the clock.
 *
 * Pinning the day to today (or to tomorrow) and leaving the times at their widest makes the state
 * deterministic without the test having to know what time it is — the alternative, moving the
 * start/end around the current minute, is a test that fails at midnight.
 */
const setWindow = (state, extra = {}) =>
  adminPost('/admin/programs/settings', {
    program_dow: String(state === 'open' ? TODAY_DOW : (TODAY_DOW + 1) % 7),
    program_start: '00:00',
    program_end: '23:59',
    program_closed_message: 'Not right now, friend.',
    program_retention_days: '90',
    ...extra,
  });

/** Create a program and return its id, read back from the redirect to its own edit page. */
async function newProgram(date, body) {
  const res = await adminPost('/admin/programs', { program_date: date, body });
  assert.equal(res.status, 302, await res.text());
  const id = /\/admin\/programs\/(\d+)\/edit/.exec(res.headers.get('location') ?? '')?.[1];
  assert.ok(id, 'creating a program redirects to its edit page');
  return Number(id);
}

/** Upload one image against a program. */
async function upload(programId, name = 'insert.png') {
  const data = new FormData();
  data.append('owner_type', 'program');
  data.append('owner_id', String(programId));
  data.append('file', new Blob([PNG_1X1], { type: 'image/png' }), name);
  return req('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
}

const getProgram = (opts = {}) => req('/api/program', { as: 'reader', ...opts });

// ---------------------------------------------------------------------------

describe('authoring a program', () => {
  before(async () => {
    await login();
    // The gate is always on, so the program is read as a member: a plain reader, and the admin too
    // (a signed-in session is not a member — the public page is the same for everyone).
    await unlockMember(req, 'reader');
    await unlockMember(req, 'admin');
    await setWindow('open');
  });

  test('a stranger cannot reach the program admin at all', async () => {
    assert.equal((await req('/admin/programs/new')).status, 302, 'requireAuth redirects');
    assert.equal(
      (await req('/admin/programs', { method: 'POST', form: { program_date: TODAY, body: 'x' } }))
        .status,
      302,
    );
  });

  test('a program is created and listed on the dashboard', async () => {
    todayProgramId = await newProgram(TODAY, 'Presiding ... Bishop Smith');
    const dashboard = await (await req('/admin', { as: 'admin' })).text();
    assert.match(dashboard, new RegExp(`/admin/programs/${todayProgramId}/edit`));
  });

  test('the date has to be a real one, and the body cannot be empty', async () => {
    const noDate = await adminPost('/admin/programs', { program_date: '', body: 'Something' });
    assert.equal(noDate.status, 400);
    const badDate = await adminPost('/admin/programs', {
      program_date: '2026-02-31',
      body: 'Something',
    });
    assert.equal(badDate.status, 400, 'February 31st is not a day');
    const noBody = await adminPost('/admin/programs', { program_date: '2027-03-14', body: '  ' });
    assert.equal(noBody.status, 400);
  });

  test('two programs cannot claim the same date', async () => {
    const res = await adminPost('/admin/programs', {
      program_date: TODAY,
      body: 'A second one for the same Sunday',
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /already a program/i);
  });

  test('editing changes the body members will read', async () => {
    const id = await newProgram('2027-05-02', 'Draft');
    const res = await adminPost(`/admin/programs/${id}`, {
      program_date: '2027-05-02',
      body: 'Conducting ... Br. Jones',
    });
    assert.equal(res.status, 302);
    const form = await (await req(`/admin/programs/${id}/edit`, { as: 'admin' })).text();
    assert.match(form, /Conducting \.\.\. Br\. Jones/);
  });

  test('a new program can start as a copy of the latest one, text only', async () => {
    const latest = await newProgram('2027-06-06', 'Presiding ... Bishop Copy\n\n### Meeting Info');
    const blank = await (await req('/admin/programs/new', { as: 'admin' })).text();
    assert.match(blank, new RegExp(`/admin/programs/new\\?from=${latest}"`), 'the latest program is offered');
    assert.doesNotMatch(blank, /Bishop Copy/, 'but nothing is copied until asked');

    const copied = await (await req(`/admin/programs/new?from=${latest}`, { as: 'admin' })).text();
    assert.match(copied, /<textarea id="body" name="body"[^>]*>Presiding \.\.\. Bishop Copy\n\n### Meeting Info<\/textarea>/);
    assert.match(copied, /Copied from the program for/);
    assert.doesNotMatch(copied, /\?from=/, 'no second offer once copied');
    assert.match(copied, /action="\/admin\/programs"/, 'still a new program, not an edit of the old one');

    const unknown = await req('/admin/programs/new?from=999999', { as: 'admin' });
    assert.equal(unknown.status, 200);
    assert.doesNotMatch(await unknown.text(), /Copied from/);
  });
});

// The dashboard is the only place a program can be edited or deleted from, so anything it does not
// render is stranded until the retention clock happens to reach it. Past programs beyond the first
// few fold into a collapsed archive rather than falling off the end — which only counts if they
// keep their controls, so that is what is asserted.
describe('older programs stay reachable', () => {
  before(async () => {
    await login();
    // Well past today, so they sort below the inline six, and inside a retention window wide enough
    // that the daily purge cannot quietly remove them mid-test.
    await setWindow('open', { program_retention_days: '3650' });
  });

  test('past the inline cut, a program is folded away but still editable', async () => {
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      // 2024 Sundays, descending — the eighth is two past the cut of six.
      ids.push(await newProgram(`2024-0${1 + Math.floor(i / 4)}-0${(i % 4) + 1}`, `Program ${i}`));
    }
    const oldest = ids[0];

    const dashboard = await (await req('/admin', { as: 'admin' })).text();
    assert.match(dashboard, /Earlier Programs/u, 'the archive appears once there is a backlog');
    assert.match(
      dashboard,
      new RegExp(`/admin/programs/${oldest}/edit`),
      'the oldest program is still listed',
    );
    assert.match(
      dashboard,
      new RegExp(`/admin/programs/${oldest}/delete`),
      'and can still be deleted',
    );

    // Not merely listed — the route behind the link works, which is the whole point.
    assert.equal((await req(`/admin/programs/${oldest}/edit`, { as: 'admin' })).status, 200);
    assert.equal((await adminPost(`/admin/programs/${oldest}/delete`)).status, 302);

    for (const id of ids.slice(1)) await adminPost(`/admin/programs/${id}/delete`);
    await setWindow('open');
  });
});

describe('the visibility window', () => {
  before(async () => {
    await login();
    await setWindow('open');
  });

  test("inside the window, today's program is served", async () => {
    const body = await (await getProgram()).json();
    assert.equal(body.open, true);
    assert.equal(body.date, TODAY);
    assert.match(body.html, /Bishop Smith/);
  });

  test('outside the window the server sends the closed message and no program at all', async () => {
    await setWindow('closed');
    const res = await getProgram();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.open, false);
    assert.equal(body.message, 'Not right now, friend.');
    // The point of the whole feature: not merely hidden in the UI, but absent from the response.
    assert.equal(body.html, undefined);
    assert.equal(body.date, undefined);
    assert.doesNotMatch(JSON.stringify(body), /Bishop Smith/);
  });

  test('a signed-in session gets the closed message outside the window, like everyone else', async () => {
    // The public page shows an admin exactly what a member sees, with no bypass for a signed-in
    // session. Proofing happens on the dashboard (see below), not on the member page.
    const asAdmin = await (await getProgram({ as: 'admin' })).json();
    assert.equal(asAdmin.open, false, 'the admin cookie does not open the window');
    assert.equal(asAdmin.html, undefined);
    assert.equal(asAdmin.preview, undefined, 'and there is no preview flag to render a banner from');
    assert.doesNotMatch(JSON.stringify(asAdmin), /Bishop Smith/);
  });

  test('the dashboard preview renders the program the way the Program tab will, at any time', async () => {
    const id = todayProgramId;
    const res = await req(`/admin/programs/${id}/preview/fragment`, { as: 'admin' });
    assert.equal(res.status, 200);
    const markup = await res.text();
    // The same skeleton `renderProgram()` in app.js builds, so the public stylesheet lays it out
    // identically: the card, the date heading, the body with its dot-leader rows.
    assert.match(markup, /^<article class="program"><h2 class="program-date">/u);
    assert.match(markup, /class="leader"/u);
    assert.match(markup, /Bishop Smith/u);

    // Only for a session: outside the window the names are exactly what an outsider must not get.
    const anonymous = await req(`/admin/programs/${id}/preview/fragment`);
    assert.equal(anonymous.status, 302, 'sent to the login page');
    assert.doesNotMatch(await anonymous.text(), /Bishop Smith/u);
    assert.equal((await req('/admin/programs/999999/preview/fragment', { as: 'admin' })).status, 404);
  });

  test('inside the window the reply has no preview flag either', async () => {
    await setWindow('open');
    const body = await (await getProgram({ as: 'admin' })).json();
    assert.equal(body.open, true);
    assert.equal(body.preview, undefined);
  });

  test('an open window with nothing written reads exactly like a shut one', async () => {
    // Same shape, same message — so the response can never be used to probe whether a program
    // exists for a date, only to read one the ward is already meant to be reading.
    await setWindow('open');
    await adminPost(`/admin/programs/${todayProgramId}`, {
      program_date: '2027-01-03',
      body: 'Presiding ... Bishop Smith',
    });
    const body = await (await getProgram()).json();
    assert.deepEqual(body, { open: false, message: 'Not right now, friend.' });
    await adminPost(`/admin/programs/${todayProgramId}`, {
      program_date: TODAY,
      body: 'Presiding ... Bishop Smith',
    });
  });

  test('left blank, the closed message says when the program opens — the same with or without one', async () => {
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const expected = `The program will be here ${DOW[(TODAY_DOW + 1) % 7]} at 12:00 AM.`;
    await setWindow('closed', { program_closed_message: '' });

    // Today's program exists, but the window is shut.
    const withProgram = await (await getProgram()).text();
    assert.deepEqual(JSON.parse(withProgram), { open: false, message: expected });

    // Move it off today: nothing exists for today now. Same bytes exactly.
    await adminPost(`/admin/programs/${todayProgramId}`, {
      program_date: '2027-01-03',
      body: 'Presiding ... Bishop Smith',
    });
    const withoutProgram = await (await getProgram()).text();
    assert.equal(withoutProgram, withProgram, 'the reply cannot tell the two apart');

    // Inside the window with nothing written, it must not promise the program "will be here" on
    // the very day it was meant to be.
    await setWindow('open', { program_closed_message: '' });
    const inside = await (await getProgram()).json();
    assert.equal(inside.open, false);
    assert.doesNotMatch(inside.message, /will be here/u);
    assert.doesNotMatch(JSON.stringify(inside), /Bishop Smith/u);

    // And the dashboard tells the clerk what blank means, in the same words.
    const dashboard = await (await req('/admin', { as: 'admin' })).text();
    assert.ok(
      dashboard.includes(`The program will be here ${DOW[TODAY_DOW]} at 12:00 AM.`),
      'the settings form shows the automatic message for the saved day and time',
    );

    await adminPost(`/admin/programs/${todayProgramId}`, {
      program_date: TODAY,
      body: 'Presiding ... Bishop Smith',
    });
    await setWindow('open');
  });

  test('the window form rejects a range that ends before it starts', async () => {
    const res = await adminPost('/admin/programs/settings', {
      program_dow: '0',
      program_start: '14:00',
      program_end: '08:00',
      program_closed_message: 'x',
      program_retention_days: '90',
    });
    assert.equal(res.status, 302);
    assert.match(
      decodeURIComponent(res.headers.get('location') ?? ''),
      /end after it starts/i,
      'and says so rather than silently hiding every program',
    );
    await setWindow('open'); // the rejected save left the old settings; restore the known state
  });
});

describe('dot-leader rows', () => {
  before(async () => {
    await login();
    await setWindow('open');
  });

  test('a program line becomes a two-column row, and a name is still escaped', async () => {
    await adminPost(`/admin/programs/${todayProgramId}`, {
      program_date: TODAY,
      body: 'Opening Hymn ... #19\nSpeaker | <img src=x onerror=alert(1)>',
    });
    const body = await (await getProgram()).json();
    assert.equal(body.open, true);

    assert.match(body.html, /<span class="leader-left">Opening Hymn<\/span>/);
    assert.match(body.html, /<span class="leader-dots" aria-hidden="true"><\/span>/);
    // A hymn row's number links to the hymn (test/hymn-links.test.js), on this runtime too.
    assert.match(
      body.html,
      /<span class="leader-right"><a href="https:\/\/www\.churchofjesuschrist\.org\/study\/manual\/hymns\/we-thank-thee-o-god-for-a-prophet\?lang=eng" class="hymn-link"[^>]*>#19<\/a><\/span>/,
    );
    assert.match(body.html, /<span class="leader-left">Speaker<\/span>/, 'a pipe works too');

    // The whole reason this is a Markdown block rule and not a regex over rendered HTML.
    assert.doesNotMatch(body.html, /<img/, 'the tag never survives as markup');
    assert.match(body.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('the member gate', () => {
  before(async () => {
    await login();
    await setWindow('open');
  });

  test('the program endpoint is gated exactly like the announcements one', async () => {
    assert.equal((await req('/api/announcements')).status, 401, 'the gate really is on');
    assert.equal((await getProgram({ as: undefined })).status, 401, 'and it covers the program, to a stranger');
  });
});

describe('images and deleting', () => {
  let programId;
  let image;

  before(async () => {
    await login();
    await setWindow('open');
    programId = await newProgram('2027-07-04', 'Presiding ... Bishop Smith');
    image = await (await upload(programId)).json();
  });

  test('a program carries images, served to the dashboard and never cached', async () => {
    assert.match(image.url, /^\/images\/[0-9a-f]{32}\.png$/);
    const res = await req(image.url, { as: 'admin' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    // A stranger has the key and nothing else: a program's images are as private as the program
    // (test/hardening.test.js has the member's side, inside the window and out).
    assert.equal((await req(image.url)).status, 404);
  });

  test('an upload against a program that does not exist is refused', async () => {
    const res = await upload(999_999);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /program/i);
  });

  test('an unknown owner type is refused outright', async () => {
    const data = new FormData();
    data.append('owner_type', 'bulletin');
    data.append('owner_id', String(programId));
    data.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'x.png');
    const res = await req('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
    assert.equal(res.status, 400);
  });

  test("today's program hands its images to the page", async () => {
    const added = await (await upload(todayProgramId, 'today.png')).json();
    const body = await (await getProgram()).json();
    assert.equal(body.open, true);
    assert.deepEqual(
      body.images.map((i) => i.url),
      [added.url],
      'the images ride alongside the HTML, as data — the markup stays the sanitized Markdown',
    );
    assert.equal(
      body.images[0].alt,
      '',
      "the clerk's own filename is not published — it can name a person, a ward, or their desktop",
    );
    assert.equal(
      JSON.stringify(body).includes('today.png'),
      false,
      'and it appears nowhere else in the payload either',
    );
  });

  test("today's program PDF opens from its link alone, for that file and only inside the window", async () => {
    // An iPhone's home-screen app opens the PDF in a new window that may not carry the member
    // cookie, so the link carries a token (fileLinkToken in src/access.ts).
    const data = new FormData();
    data.append('owner_type', 'program');
    data.append('owner_id', String(todayProgramId));
    data.append('file', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'insert.pdf');
    data.append('thumb', new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])], { type: 'image/jpeg' }), 'thumb.jpg');
    const added = await (await req('/admin/attachments', { as: 'admin', method: 'POST', formData: data })).json();
    assert.ok(added.pdf, 'uploaded as a PDF');
    // The upload's own link carries the dashboard's token; members get one of their own.
    const pdfPath = added.pdf.split('?')[0];

    const body = await (await getProgram()).json();
    const listed = body.images.find((i) => i.pdf?.startsWith(pdfPath));
    assert.ok(listed, 'the program lists the PDF');
    assert.match(listed.pdf, new RegExp(`^${pdfPath}\\?t=\\d+\\.[\\w-]+$`), 'its link carries a token');
    const token = new URL(listed.pdf, 'http://x').searchParams.get('t');

    // No cookie at all: the token is the whole of the way in.
    const opened = await req(listed.pdf);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get('content-type'), 'application/pdf');
    assert.equal(opened.headers.get('cache-control'), 'private, no-store');
    assert.equal((await req(pdfPath)).status, 404, 'without it, a stranger gets nothing');
    assert.equal((await req(`${added.url}?t=${token}`)).status, 404, 'it opens that one file, not its thumbnail');
    assert.equal((await req(`${pdfPath}?t=${token.slice(0, -2)}xx`)).status, 404, 'a tampered token is no token');
    const [, sig] = token.split('.');
    assert.equal((await req(`${pdfPath}?t=99999999999.${sig}`)).status, 404, 'nor is one with its expiry moved');

    // Once the window shuts, the token opens nothing, whatever its own expiry says.
    await setWindow('closed');
    try {
      assert.equal((await req(listed.pdf)).status, 404);
    } finally {
      await setWindow('open');
    }
  });

  test('deleting a program takes its images with it', async () => {
    const res = await adminPost(`/admin/programs/${programId}/delete`);
    assert.equal(res.status, 302);
    assert.equal((await req(image.url)).status, 404, 'the object is gone, not just the row');
    assert.equal(
      (await req(`/admin/programs/${programId}/edit`, { as: 'admin' })).status,
      404,
      'and so is the program',
    );
  });
});
