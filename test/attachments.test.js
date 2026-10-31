// End-to-end tests for announcement image attachments.
//
// Driven over HTTP against a real server, like the access-gate suite and for the same reason: what
// matters is the composition of three things that can only disagree at runtime — the storage seam
// (a directory on Node, R2 on Workers), the database rows, and the gate exemption that keeps
// `/images/` reachable to someone who has no access cookie at all.
//
// Every assertion over HTTP is runtime-agnostic, so that half runs unchanged on both targets (the
// in-process block at the end is Node only):
//   npm test            (the Node entry, images on disk under DATABASE_PATH's directory)
//   npm run test:worker (`wrangler dev`, images in wrangler's local R2 simulation)

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_PASSWORD, ROOT, TARGET, createClient, startServer, testPort, unlockMember } from './helpers/harness.js';
import { loadConfig } from '../dist/config.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import * as db from '../dist/db.js';
import { createApp } from '../dist/app.js';
import { createSqlFileStore } from '../dist/filestore-sql.js';
import { contains, jpegWithMetadata } from './helpers/image-fixtures.js';

let server;
let req;

// A real 1x1 PNG. The server does not decode uploads, but a genuine file keeps the test honest
// about what a browser would send.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  // A different offset from the access-gate suite: node --test runs the files in parallel, and two
  // servers on one port would fail as a mystery timeout.
  server = await startServer({ port: testPort(1) });
  req = createClient(server.base);
});

after(() => server?.stop());

const login = () =>
  req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
const adminPost = (path, form) => req(path, { as: 'admin', method: 'POST', form });

/** Create an announcement and return its id (new ones are inserted at the top of the list). */
async function newAnnouncement(title) {
  await adminPost('/admin/announcements', { title, body: 'Body.', published: '1' });
  const html = await (await req('/admin', { as: 'admin' })).text();
  const id = html.match(/<li class="row" data-id="(\d+)"/)?.[1];
  assert.ok(id, 'the dashboard lists the announcement it just created');
  return Number(id);
}

/** Upload one file as the admin. `bytes`/`type` default to a tiny PNG. */
async function upload(ownerId, { bytes = PNG_1X1, type = 'image/png', name = 'flyer.png' } = {}) {
  const data = new FormData();
  data.append('owner_type', 'announcement');
  data.append('owner_id', String(ownerId));
  data.append('file', new Blob([bytes], { type }), name);
  return req('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
}

// The server only checks a PDF's signature, but a real (if tiny) one keeps the test honest about
// what a browser sends. The thumbnail is the JPEG the dashboard draws of its first page.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const THUMB = jpegWithMetadata({ orientation: 1 });

function uploadPdf(ownerId, { bytes = PDF, thumb = THUMB, ownerType = 'announcement', type = 'application/pdf' } = {}) {
  const data = new FormData();
  data.append('owner_type', ownerType);
  data.append('owner_id', String(ownerId));
  data.append('file', new Blob([bytes], { type }), 'Stake Youth Conference.pdf');
  if (thumb) data.append('thumb', new Blob([thumb], { type: 'image/jpeg' }), 'thumb.jpg');
  return req('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
}

// ---------------------------------------------------------------------------

describe('uploading an image', () => {
  let announcementId;

  before(async () => {
    await login();
    await unlockMember(req, 'member'); // the gate is always on: the public API is read as a member
    announcementId = await newAnnouncement('Ward picnic');
  });

  test('an uploaded image is stored and served back', async () => {
    const res = await upload(announcementId);
    assert.equal(res.status, 201);
    const added = await res.json();
    assert.match(added.key, /^[0-9a-f]{32}\.png$/, 'the key is random hex plus an extension');
    assert.equal(added.url, `/images/${added.key}`);

    const image = await req(added.url);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(
      image.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
      'the key never changes, so the object never needs revalidating',
    );
    assert.deepEqual(
      new Uint8Array(await image.arrayBuffer()),
      new Uint8Array(PNG_1X1),
      'the bytes come back exactly as they went in',
    );
  });

  test('the announcements API hands the image out with its announcement', async () => {
    const { announcements } = await (await req('/api/announcements', { as: 'member' })).json();
    const mine = announcements.find((a) => a.id === announcementId);
    assert.ok(mine, 'the announcement is live');
    assert.ok(mine.images.length >= 1, 'its images come back with it');
    assert.match(mine.images[0].url, /^\/images\/[0-9a-f]{32}\.png$/);
  });

  test('an unknown key is a 404, and a traversal attempt is not special-cased', async () => {
    assert.equal((await req('/images/0123456789abcdef0123456789abcdef.png')).status, 404);
    assert.equal((await req('/images/..%2F..%2Fpackage.json')).status, 404);
  });
});

describe('metadata is stripped before an image is stored', () => {
  let announcementId;

  before(async () => {
    await login();
    announcementId = await newAnnouncement('Photo with GPS');
  });

  test('a phone photo comes back without its GPS, time or make, but still with its orientation', async () => {
    // The original bytes, as the editor sends them for an image it could not shrink: Exif with a
    // GPS IFD, a capture time, the make and Orientation = 6; XMP; an ICC profile; a comment.
    const photo = jpegWithMetadata({ orientation: 6 });
    const res = await upload(announcementId, { bytes: photo, type: 'image/jpeg', name: 'IMG_0001.jpg' });
    assert.equal(res.status, 201);
    const added = await res.json();
    const stored = new Uint8Array(await (await req(added.url)).arrayBuffer());
    assert.ok(stored.length < photo.length, 'smaller than what was sent');
    assert.ok(!contains(stored, 'Apple') && !contains(stored, '2024:06:09'), 'make and time are gone');
    assert.ok(!contains(stored, Uint8Array.from([0x25, 0x88])), 'the GPS IFD pointer (0x8825) is gone');
    assert.ok(!contains(stored, 'xmpmeta'), 'XMP is gone');
    // The Orientation entry, as the stripper writes it: tag 0x0112, SHORT, count 1, value 6.
    assert.ok(contains(stored, Uint8Array.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00])), 'Orientation = 6 is still there');
    assert.ok(contains(stored, 'ICC_PROFILE'), 'the colour profile is still there');

    // The row's size is the stored size, not the uploaded one: the quota sums it.
    const { tables } = await (await req('/admin/backup.json', { as: 'admin' })).json();
    const row = tables.attachments.find((a) => a.key === added.key);
    assert.ok(row, 'the backup lists the image');
    assert.equal(row.size, stored.length);
  });
});

describe('what the server refuses', () => {
  let announcementId;

  before(async () => {
    await login();
    announcementId = await newAnnouncement('Rejections');
  });

  test('a non-image type is rejected', async () => {
    const res = await upload(announcementId, {
      bytes: Buffer.from('#!/bin/sh\necho hi\n'),
      type: 'application/x-sh',
      name: 'payload.sh',
    });
    assert.equal(res.status, 415);
  });

  test('an oversized image is rejected', async () => {
    const res = await upload(announcementId, {
      bytes: Buffer.alloc(3 * 1024 * 1024 + 1, 7),
      type: 'image/jpeg',
      name: 'huge.jpg',
    });
    assert.equal(res.status, 413);
  });

  test('an upload for an announcement that does not exist is rejected', async () => {
    assert.equal((await upload(999_999)).status, 404);
  });

  test('a stranger cannot upload', async () => {
    const data = new FormData();
    data.append('owner_type', 'announcement');
    data.append('owner_id', String(announcementId));
    data.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'flyer.png');
    const res = await req('/admin/attachments', { method: 'POST', formData: data });
    assert.equal(res.status, 302, 'requireAuth redirects to the login page');
  });

  test('the eleventh image is refused', async () => {
    const id = await newAnnouncement('Ten is the limit');
    for (let i = 0; i < 10; i++) {
      assert.equal((await upload(id)).status, 201, `image ${i + 1} of 10`);
    }
    const res = await upload(id);
    assert.equal(res.status, 409, 'the cap bounds the delete fan-out, so it holds server-side');
  });
});

describe('the member gate', () => {
  let imageUrl;

  before(async () => {
    await login();
    const id = await newAnnouncement('Gated');
    imageUrl = (await (await upload(id)).json()).url;
  });

  test('an image stays reachable to someone with no access cookie', async () => {
    // Public flyers behind unguessable keys, deliberately exempt: the announcement *text* is what
    // the gate protects, and a gated image renders as a broken box the moment a cookie lapses.
    assert.equal((await req('/api/announcements')).status, 401, 'the gate really is on');
    assert.equal((await req(imageUrl)).status, 200);
  });
});

describe('deleting', () => {
  let announcementId;
  let added;

  before(async () => {
    await login();
    announcementId = await newAnnouncement('Temporary');
    added = await (await upload(announcementId)).json();
  });

  test('removing one image leaves the announcement alone', async () => {
    const second = await (await upload(announcementId)).json();
    const res = await req(`/admin/attachments/${second.id}`, { as: 'admin', method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await req(second.url)).status, 404, 'the object is gone, not just the row');
    assert.equal((await req(added.url)).status, 200, 'the other image is untouched');
  });

  test('deleting the announcement takes its images with it', async () => {
    await adminPost(`/admin/announcements/${announcementId}/delete`);
    assert.equal((await req(added.url)).status, 404);
  });
});

describe('images added before the first save', () => {
  // On a New page there is no row yet: an upload without an owner id is stored as pending, the form
  // carries its id in `pending_images`, and the save attaches it.
  const uploadPending = (ownerType = 'announcement') => {
    const data = new FormData();
    data.append('owner_type', ownerType);
    data.append('owner_id', '');
    data.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'pending.png');
    return req('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
  };

  before(async () => {
    await login();
    await unlockMember(req, 'member');
  });

  test('a New page shows the Images card, ready to upload', async () => {
    const html = await (await req('/admin/announcements/new', { as: 'admin' })).text();
    assert.match(html, /id="attachment-list"[^>]*data-owner-id=""/);
    assert.match(html, /name="pending_images"[^>]*form="content-form"/);
    assert.match(html, /<form[^>]*id="content-form"/);
  });

  test('an image uploaded to a new announcement is attached when it is saved', async () => {
    const added = await (await uploadPending()).json();
    assert.ok(added.id);
    // Pending: served to the dashboard, which shows it on the form, and to nobody else yet.
    assert.equal((await req(added.url, { as: 'admin' })).status, 200);
    assert.equal((await req(added.url)).status, 404);
    const saved = await adminPost('/admin/announcements', {
      title: 'Flyer from the start',
      body: 'x',
      published: '1',
      pending_images: String(added.id),
    });
    assert.equal(saved.status, 302);
    const { announcements } = await (await req('/api/announcements', { as: 'member' })).json();
    const mine = announcements.find((a) => a.title === 'Flyer from the start');
    assert.deepEqual(mine.images.map((i) => i.url), [added.url]);
  });

  test('a rejected save keeps its pending images on the form', async () => {
    const added = await (await uploadPending()).json();
    const res = await adminPost('/admin/announcements', { title: '', body: 'x', pending_images: String(added.id) });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes(`data-attachment="${added.id}"`), 'the thumbnail is still there');
    assert.ok(html.includes(`value="${added.id}"`), 'and still in the form');
  });

  test('a pending image can be claimed only once', async () => {
    const added = await (await uploadPending()).json();
    await adminPost('/admin/announcements', { title: 'First claim', body: 'x', published: '1', pending_images: String(added.id) });
    await adminPost('/admin/announcements', { title: 'Second claim', body: 'x', published: '1', pending_images: String(added.id) });
    const { announcements } = await (await req('/api/announcements', { as: 'member' })).json();
    assert.equal(announcements.find((a) => a.title === 'First claim').images.length, 1);
    assert.equal(announcements.find((a) => a.title === 'Second claim').images.length, 0);
  });

  test('removing a pending image before saving deletes it', async () => {
    const added = await (await uploadPending()).json();
    assert.equal((await req(`/admin/attachments/${added.id}`, { as: 'admin', method: 'DELETE' })).status, 200);
    assert.equal((await req(added.url)).status, 404);
  });

  test('programs and pages take pending images the same way', async () => {
    const forProgram = await (await uploadPending('program')).json();
    const program = await adminPost('/admin/programs', {
      program_date: '2031-03-02',
      body: 'Speaker ... Test',
      pending_images: String(forProgram.id),
    });
    assert.equal(program.status, 302);
    const programPage = await (await req(program.headers.get('location'), { as: 'admin' })).text();
    assert.ok(programPage.includes(forProgram.url), 'the program has its image');

    const forPage = await (await uploadPending('page')).json();
    const page = await adminPost('/admin/pages', { title: 'Map', body: 'x', published: '1', pending_images: String(forPage.id) });
    assert.equal(page.status, 302);
    const pageEdit = await (await req(page.headers.get('location'), { as: 'admin' })).text();
    assert.ok(pageEdit.includes(forPage.url), 'the page has its image');
  });

  test('a PDF added before the first save survives a rejected save and is claimed by the real one', async () => {
    // Pending: no owner yet, so it is private to the dashboard and its link carries a token.
    const pending = await (await uploadPdf('')).json();
    const bare = pending.pdf.split('?')[0];
    assert.match(pending.pdf, /\?t=/, "an unsaved PDF's dashboard link carries a token");
    assert.equal((await req(bare)).status, 404, 'and without it nobody sees it');

    const rejected = await adminPost('/admin/announcements', { title: '', body: 'x', pending_images: String(pending.id) });
    assert.equal(rejected.status, 400);
    const form = await rejected.text();
    assert.ok(form.includes(`data-attachment="${pending.id}"`), 'the PDF is still on the form');
    assert.ok(form.includes(`href="${bare}?t=`), 'linked with a token, as the upload was');

    await adminPost('/admin/announcements', {
      title: 'Saved with a PDF',
      body: 'x',
      published: '1',
      pending_images: String(pending.id),
    });
    const { announcements } = await (await req('/api/announcements', { as: 'member' })).json();
    const saved = announcements.find((a) => a.title === 'Saved with a PDF');
    assert.deepEqual(saved?.images, [{ url: pending.url, alt: '', pdf: bare }], 'members get it like any PDF');
    assert.equal((await req(bare)).status, 200, "and an announcement's PDF is public once saved");
  });

  test('unsaved images are capped across the ward', async () => {
    let refused = null;
    for (let i = 0; i < 40 && !refused; i++) {
      const res = await uploadPending();
      if (res.status === 409) refused = await res.json();
      else assert.equal(res.status, 201);
    }
    assert.match(refused?.error ?? '', /Too many unsaved images/);
  });
});

describe('PDF attachments', () => {
  let announcementId;
  let added;

  before(async () => {
    await login();
    await unlockMember(req, 'member');
    announcementId = await newAnnouncement('Youth conference');
    const res = await uploadPdf(announcementId);
    assert.equal(res.status, 201);
    added = await res.json();
  });

  test('a PDF is stored with its thumbnail, and each is served as what it is', async () => {
    assert.match(added.key, /^[0-9a-f]{32}\.pdf$/);
    assert.equal(added.pdf, `/images/${added.key}`);
    assert.match(added.url, /^\/images\/[0-9a-f]{32}\.jpg$/, 'the url to show is the thumbnail');

    const pdf = await req(added.pdf);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(new Uint8Array(await pdf.arrayBuffer()), new Uint8Array(PDF), 'the PDF comes back untouched');

    const thumb = await req(added.url);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    assert.ok(!contains(new Uint8Array(await thumb.arrayBuffer()), 'Apple'), 'the thumbnail is stripped like any image');
  });

  test('members get the thumbnail to show and the PDF to open, and no filename', async () => {
    const { announcements } = await (await req('/api/announcements', { as: 'member' })).json();
    const mine = announcements.find((a) => a.id === announcementId);
    assert.deepEqual(mine.images, [{ url: added.url, alt: '', pdf: added.pdf }]);
  });

  test('the copy and Save as PDF preview leave an attached PDF out', async () => {
    const html = await (await req('/admin/announcements/preview/fragment', { as: 'admin' })).text();
    assert.ok(html.includes('Youth conference'), 'the announcement is in the preview');
    assert.ok(!html.includes(added.key) && !html.includes(added.url.slice('/images/'.length)), 'its PDF is not');
  });

  test('the backup names the thumbnail beside the PDF', async () => {
    const { tables } = await (await req('/admin/backup.json', { as: 'admin' })).json();
    const row = tables.attachments.find((a) => a.key === added.key);
    assert.equal(row.content_type, 'application/pdf');
    assert.equal(row.thumb_key, added.url.slice('/images/'.length));
    assert.equal(row.size, PDF.length, 'the quota counts the PDF');
  });

  test('a PDF without a thumbnail, or with a thumbnail that is not a JPEG, is refused', async () => {
    assert.equal((await uploadPdf(announcementId, { thumb: null })).status, 400);
    assert.equal((await uploadPdf(announcementId, { thumb: PNG_1X1 })).status, 400);
  });

  test('a file that only claims to be a PDF is refused', async () => {
    const res = await uploadPdf(announcementId, { bytes: Buffer.from('<html><script>alert(1)</script></html>') });
    assert.equal(res.status, 415);
  });

  test('a PDF over 5 MB is refused, while one over the image limit is not', async () => {
    const big = (n) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n - 9, 0x20)]);
    assert.equal((await uploadPdf(announcementId, { bytes: big(5 * 1024 * 1024 + 1) })).status, 413);
    const fourMb = await uploadPdf(announcementId, { bytes: big(4 * 1024 * 1024) });
    assert.equal(fourMb.status, 201);
    const { id } = await fourMb.json();
    await req(`/admin/attachments/${id}`, { as: 'admin', method: 'DELETE' });
  });

  test("a program's PDF and its thumbnail are as private as the program", async () => {
    // A year out, so it is never today whatever day the suite runs.
    const created = await adminPost('/admin/programs', {
      program_date: `${new Date().getUTCFullYear() + 1}-04-06`,
      body: 'Speaker ... Test',
    });
    const programId = Number(created.headers.get('location')?.match(/\/programs\/(\d+)/)?.[1]);
    assert.ok(programId, 'the program was created');
    const pdf = await (await uploadPdf(programId, { ownerType: 'program' })).json();
    const bare = pdf.pdf.split('?')[0];
    for (const url of [bare, pdf.url]) {
      assert.equal((await req(url, { as: 'member' })).status, 404, `${url} is closed to a member out of its window`);
      const admin = await req(url, { as: 'admin' });
      assert.equal(admin.status, 200, `${url} is open to the dashboard`);
      assert.equal(admin.headers.get('cache-control'), 'private, no-store');
    }

    // The dashboard's own link carries a token, since an iPhone home-screen app's new window may
    // not carry the session: it opens the PDF with no cookie at all, any day, and nothing else.
    const token = new URL(pdf.pdf, 'http://x').searchParams.get('t');
    assert.ok(token, "a program PDF's dashboard link carries a token");
    assert.equal((await req(pdf.pdf)).status, 200);
    assert.equal((await req(`${pdf.url}?t=${token}`)).status, 404, 'not its thumbnail');
    assert.equal((await req(`${bare}?t=${token.slice(0, -2)}xx`)).status, 404, 'not tampered');
    const edit = await (await req(`/admin/programs/${programId}/edit`, { as: 'admin' })).text();
    assert.ok(edit.includes(`href="${bare}?t=`), 'the edit page links it the same way');
  });

  test("an announcement PDF's dashboard link needs no token", async () => {
    assert.equal(added.pdf, `/images/${added.key}`);
  });

  test('removing a PDF deletes its thumbnail too', async () => {
    const second = await (await uploadPdf(announcementId)).json();
    assert.equal((await req(`/admin/attachments/${second.id}`, { as: 'admin', method: 'DELETE' })).status, 200);
    assert.equal((await req(second.pdf)).status, 404);
    assert.equal((await req(second.url)).status, 404, 'the thumbnail went with it');
    assert.equal((await req(added.url)).status, 200, 'the other PDF is untouched');
  });

  test('deleting the announcement takes its PDFs and thumbnails with it', async () => {
    await adminPost(`/admin/announcements/${announcementId}/delete`);
    assert.equal((await req(added.pdf)).status, 404);
    assert.equal((await req(added.url)).status, 404);
  });
});

// In process, Node only: what `/images/:key` serves is decided by the key, not by the store. A
// tampered backup restored into the store (text/html under a `.png` key, or a `.html` key outright)
// must not make the ward's own origin serve HTML. Needs a store that can be written past the
// upload route, which the HTTP half has no way to do.
describe('the image route serves the key\'s type, whatever the store holds', { skip: TARGET === 'worker' }, () => {
  let app;
  let dir;
  const PNG_KEY = 'cccccccccccccccccccccccccccccccc.png';
  const HTML_KEY = 'cccccccccccccccccccccccccccccccc.html';

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'image-type-'));
    loadConfig({ ADMIN_PASSWORD: 'in-process-password', APP_NAME: 'Env Ward', APP_SHORT_NAME: 'Env', APP_DESCRIPTION: 'x' });
    await db.initDb(createSqliteDriver(join(dir, 'ward.db')));
    const store = createSqlFileStore();
    const pub = (...p) => readFileSync(join(ROOT, 'public', ...p), 'utf8');
    app = createApp({
      shell: { index: pub('index.html'), sw: pub('sw.js'), iosSplash: '', assets: [] },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      files: store,
    });
    const html = new Uint8Array(Buffer.from('<script>alert(1)</script>'));
    for (const key of [PNG_KEY, HTML_KEY]) {
      await db.createAttachment({ ownerType: 'announcement', ownerId: 1, key, filename: null, contentType: 'text/html', size: html.length });
      await store.put(key, html, 'text/html');
    }
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a stored row with a bogus type is served as its key says', async () => {
    const res = await app.fetch(new Request(`http://ward.test/images/${PNG_KEY}`));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  test('a key with an extension this app never makes is not served at all', async () => {
    assert.equal((await app.fetch(new Request(`http://ward.test/images/${HTML_KEY}`))).status, 404);
  });
});
