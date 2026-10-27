#!/usr/bin/env node
/**
 * Regenerate the README's screenshots from the current code.
 *
 *   docs/images/announcements.png  the member page, Announcements tab (phone, 390×844 at 2×)
 *   docs/images/program.png        the member page, Program tab, inside its window (same)
 *   docs/images/dashboard.png      the dashboard's Content tab (1000×880 at 2×)
 *   docs/images/notification.png   the Sunday notification on a locked phone (same size as the
 *                                  member pages) — a mock-up drawn in HTML (`lockScreenHtml`), not
 *                                  a real lock screen, carrying the ward's icon and the exact
 *                                  title and body the weekly push sends (src/schedule-core.ts)
 *
 * Pictures taken by hand go stale the first time a label moves, and nobody remembers how the last
 * set was made. This makes them repeatable: it boots the Node server (`dist/server.js`) on a
 * throwaway database, seeds a fictional ward through the same HTTP routes the dashboard uses, and
 * photographs it with the locally installed Google Chrome, driven headless over the DevTools
 * Protocol with Node's own WebSocket and fetch — no browser package, nothing native, nothing new in
 * package.json.
 *
 * Usage:
 *   npm run screenshots                        (builds first, then runs this)
 *   node scripts/screenshots.mjs [--out DIR]   (after `npm run build`; default DIR: docs/images)
 *
 *   CHROME=/path/to/chrome   another Chrome or Chromium binary (default: the macOS app)
 *
 * The program is readable only on its date, inside its window (src/programs.ts), and a README
 * picture of a sacrament meeting program should be a Sunday's. So the server runs on a shifted
 * clock: a preload (`--import`) moves its `Date` forward to the coming Sunday at 10:15 in Denver,
 * the meeting is set for 10:00 (src/meeting.ts opens the window an hour before), and the program is
 * dated that Sunday. Only the throwaway server's clock moves; SQLite's own `datetime('now')` and
 * Chrome keep real time, which nothing in the pictures depends on.
 *
 * Everything it starts — the server, Chrome, the temp directory with the database, the uploads and
 * Chrome's profile — is taken down on the way out, error or not.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ADMIN_PASSWORD = `screenshots-${crypto.randomUUID()}`;
const WARD = 'Springfield 8th Ward';

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1000, height: 880, deviceScaleFactor: 2, mobile: false };

// --- sample content: fictional throughout -----------------------------------

const ANNOUNCEMENTS = [
  {
    title: 'Youth Service Project',
    body:
      'The youth are raking leaves for anyone who could use the help this Saturday morning.\n\n' +
      '- Sign up in the foyer\n- Bring gloves and a rake if you have them',
  },
  {
    title: 'Temple Night',
    body: 'Join us at the temple on **Thursday at 7:00 PM**. Carpools leave the church parking lot at 6:15.',
  },
  {
    title: 'Ward Christmas Party',
    body:
      '**Saturday, December 12, 6:00 PM** in the cultural hall.\n\n' +
      'Dinner, a visit from someone in a red suit, and a short nativity with the Primary children. ' +
      'Bring a side dish or dessert to share.',
    // A flyer drawn by this script (`flyerHtml`, photographed by Chrome before seeding): something
    // to show the image row, and nobody's photo.
    image: 'flyer',
  },
];

const PAGES = [
  {
    title: 'Meeting Times',
    body: '**Sacrament meeting:** Sundays at the time on the Program tab.\n\n**Second hour:** right after, in the classrooms.',
  },
  {
    title: 'Meeting With the Bishop',
    body: 'To meet with the bishop, speak to the executive secretary after sacrament meeting.',
  },
  {
    title: 'Building Cleaning',
    body: 'Each family takes a Saturday in turn. The sign-up sheet is on the board by the library.',
  },
];

/** Filled into the app's own example program, in order, wherever it says "(name)". */
const PROGRAM_NAMES = [
  'Bishop Alvarez',
  'Brother Okafor',
  'Sister Lindqvist',
  'Sister Moreau',
  'Sister Novak',
  'Brother Tanaka',
  'Sister Haddad',
  'Brother Kowalski',
  'Brother Mensah',
];

const SUBSCRIBERS = 143;

/** The ward's zone, and its meeting: Sunday at 10:00, photographed at 10:15. */
const ZONE = 'America/Denver';
const MEETING = { dow: 0, time: '10:00', at: '10:15' };

// --- main ---------------------------------------------------------------------

const outDir = resolve(argValue('--out') ?? join(ROOT, 'docs', 'images'));
const work = mkdtempSync(join(tmpdir(), 'wa-screenshots-'));
const cleanups = [];

try {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) throw new Error('dist/server.js is missing: run `npm run build` first.');
  // The weekly push's own words, so the mock notification cannot drift from what members get.
  const { DEFAULT_WEEKLY_TITLE, defaultWeeklyBody } = await import(pathToFileURL(join(ROOT, 'dist', 'schedule-core.js')).href);
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME to its binary).`);
  mkdirSync(outDir, { recursive: true });

  const clock = comingSunday(new Date());
  const server = await startServer(ZONE, clock.shiftMs);
  cleanups.push(server.stop);
  const chrome = await startChrome();
  cleanups.push(chrome.stop);

  // The Christmas party's picture: drawn as a page, photographed, and uploaded like any flyer.
  const flyerPage = join(work, 'flyer.html');
  writeFileSync(flyerPage, flyerHtml());
  const flyer = await shoot(chrome, server.base, {
    name: null,
    url: pathToFileURL(flyerPage).href,
    viewport: { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false },
    cookies: [],
    ready: 'true',
  });
  const { admin, member } = await seed(server.base, clock, { flyer });
  const cookies = [...admin, ...member];

  await shoot(chrome, server.base, {
    name: 'announcements.png',
    path: '/#announcements',
    viewport: PHONE,
    cookies: member,
    // The notification card already dismissed (the picture before this one is the notification
    // itself), so the announcements lead.
    storage: { 'dismissed-cards': JSON.stringify({ notify: true }) },
    ready: `document.querySelectorAll('#announcement-list .announcement').length === ${ANNOUNCEMENTS.length}`,
  });
  await shoot(chrome, server.base, {
    name: 'program.png',
    path: '/#program',
    viewport: PHONE,
    cookies: member,
    // A member who has already dismissed the card: the one-line stub, so the program leads.
    storage: { 'dismissed-cards': JSON.stringify({ notify: true }) },
    ready: `!!document.querySelector('#program-content .program .body')`,
  });
  // The notification itself cannot be photographed (a push lands on a phone, not in headless
  // Chrome), so this is a drawing of one: the lock-screen page below, written to the work dir and
  // opened from disk, with the icon fetched from the running server so it is the ward's real one.
  const lockScreen = join(work, 'lock-screen.html');
  writeFileSync(
    lockScreen,
    lockScreenHtml(server.base, {
      // The ward as a phone would label it; longer than the home-screen name on purpose, since a
      // notification has the room an icon label does not.
      app: 'Springfield 8th',
      title: DEFAULT_WEEKLY_TITLE,
      body: defaultWeeklyBody(ANNOUNCEMENTS.length),
      date: clock.date,
    }),
  );
  await shoot(chrome, server.base, {
    name: 'notification.png',
    url: pathToFileURL(lockScreen).href,
    viewport: PHONE,
    cookies: [],
    ready: 'true',
  });
  await shoot(chrome, server.base, {
    name: 'dashboard.png',
    path: '/admin',
    viewport: DESKTOP,
    cookies,
    ready: `document.querySelectorAll('.row-title[href^="/admin/programs/"]').length === 4`,
  });
  // Not photographed, only loaded: every other kind of dashboard page, so a script the policy
  // would block anywhere fails the run rather than a button somewhere quietly doing nothing.
  for (const path of ['/admin/announcements/new', '/admin/pages/new', '/admin/programs/new?example=1', '/admin/me', '/admin/subscribers']) {
    await shoot(chrome, server.base, { name: path, path, viewport: DESKTOP, cookies, ready: 'true', photograph: false });
  }
  await shoot(chrome, server.base, { name: '/admin/login', path: '/admin/login', viewport: PHONE, cookies: [], ready: 'true', photograph: false });
  console.log(`screenshots written to ${outDir} (meeting ${clock.date} ${clock.meeting} in ${ZONE})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  for (const stop of cleanups.reverse()) await stop().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}

// --- the clock ------------------------------------------------------------------

/** Wall-clock parts of an instant in the ward's zone. */
function wallClock(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * How far to move the server's clock so it reads the coming Sunday (today, if it is Sunday and not
 * yet past the meeting) at MEETING.at in the ward's zone. Corrected against the zone afterwards,
 * so a DST change between now and then — the first Sunday of November — cannot leave it an hour out.
 */
function comingSunday(now) {
  const [h, m] = MEETING.at.split(':').map(Number);
  const here = wallClock(now);
  let days = (7 - here.dow) % 7;
  if (days === 0 && here.minutes > h * 60 + m) days = 7;
  let target = now.getTime() + days * 86_400_000 + (h * 60 + m - here.minutes) * 60_000;
  for (let i = 0; i < 3; i++) {
    const off = h * 60 + m - wallClock(new Date(target)).minutes;
    if (off === 0) break;
    target += off * 60_000;
  }
  const there = wallClock(new Date(target));
  if (there.dow !== MEETING.dow) throw new Error(`the shifted clock landed on ${there.date}, not a Sunday`);
  return { shiftMs: target - now.getTime(), date: there.date, dow: MEETING.dow, meeting: MEETING.time };
}

/** 'YYYY-MM-DD' shifted by whole days. */
/**
 * A locked phone with one notification on it, as HTML: the only way to picture a push without a
 * phone in the loop. Generic on purpose — a soft wallpaper, a clock, a card — so it is read as "a
 * notification", not as any one phone's lock screen. The icon is the ward's own, fetched from the
 * running server; the words are the weekly push's.
 */
function lockScreenHtml(base, { app, title, body, date }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notification</title>
<style>
  html, body { margin: 0; height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #fff; -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(120% 70% at 20% 10%, #7c9ef2 0%, rgba(124,158,242,0) 60%),
      radial-gradient(90% 60% at 85% 95%, #c58bd9 0%, rgba(197,139,217,0) 60%),
      linear-gradient(170deg, #3a4f9a 0%, #5d6fc4 45%, #8d6fb8 100%);
    display: flex; flex-direction: column; align-items: center;
  }
  .lock { margin-top: 62px; width: 14px; height: 18px; position: relative; opacity: .9; }
  .lock::before { content: ""; position: absolute; left: 3px; top: 0; width: 8px; height: 9px;
    border: 2px solid #fff; border-bottom: 0; border-radius: 6px 6px 0 0; box-sizing: border-box; }
  .lock::after { content: ""; position: absolute; left: 0; top: 7px; width: 14px; height: 11px;
    background: #fff; border-radius: 3px; }
  .date { margin-top: 14px; font-size: 21px; font-weight: 500; letter-spacing: .2px; }
  .time { margin-top: -2px; font-size: 88px; font-weight: 300; letter-spacing: -2px; line-height: 1.05; }
  .card {
    margin-top: 44px; width: 358px; box-sizing: border-box; padding: 12px 14px 13px;
    border-radius: 22px; background: rgba(255,255,255,.78); color: #111;
    -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    display: grid; grid-template-columns: 40px 1fr auto; column-gap: 12px; align-items: start;
    box-shadow: 0 8px 30px rgba(0,0,0,.12);
  }
  .card img { width: 40px; height: 40px; border-radius: 9px; display: block; margin-top: 1px; }
  .card .app { font-size: 13px; font-weight: 600; letter-spacing: .1px; }
  .card .title { font-size: 15px; font-weight: 600; margin-top: 1px; }
  .card .body { font-size: 15px; line-height: 1.3; color: #222; margin-top: 1px; }
  .card .when { font-size: 13px; color: #555; margin-top: 1px; }
  .bar { position: absolute; bottom: 9px; left: 50%; transform: translateX(-50%); width: 134px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.9); }
</style></head>
<body>
  <div class="lock"></div>
  <div class="date">${esc(day)}</div>
  <div class="time">9:00</div>
  <div class="card">
    <img src="${esc(base)}/icons/apple-touch-icon.png" alt="">
    <div>
      <div class="app">${esc(app)}</div>
      <div class="title">${esc(title)}</div>
      <div class="body">${esc(body)}</div>
    </div>
    <div class="when">now</div>
  </div>
  <div class="bar"></div>
</body></html>`;
}

/**
 * The Christmas party flyer the seeded ward attaches to its announcement, as a page 1200×800:
 * a plain typographic card, drawn here so the README shows an image row without anyone's photo.
 */
function flyerHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Flyer</title>
<style>
  html, body { margin: 0; width: 1200px; height: 800px; overflow: hidden; }
  body {
    position: relative; color: #fff8ee; text-align: center; box-sizing: border-box; padding-top: 118px;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
    /* A warm red with soft lights in green, gold and white floating over it. */
    background:
      radial-gradient(14% 20% at 12% 24%, rgba(255,214,120,.55) 0%, rgba(255,214,120,0) 70%),
      radial-gradient(12% 18% at 88% 18%, rgba(118,196,140,.5) 0%, rgba(118,196,140,0) 70%),
      radial-gradient(10% 15% at 80% 82%, rgba(255,255,255,.45) 0%, rgba(255,255,255,0) 70%),
      radial-gradient(16% 24% at 20% 84%, rgba(118,196,140,.45) 0%, rgba(118,196,140,0) 70%),
      radial-gradient(9% 13% at 60% 90%, rgba(255,214,120,.45) 0%, rgba(255,214,120,0) 70%),
      radial-gradient(8% 12% at 40% 10%, rgba(255,255,255,.4) 0%, rgba(255,255,255,0) 70%),
      radial-gradient(70% 55% at 50% 45%, rgba(255,255,255,.1) 0%, rgba(255,255,255,0) 70%),
      linear-gradient(170deg, #c62f3a 0%, #a3202c 55%, #8e1a26 100%);
  }
  .dot { position: absolute; border-radius: 50%; background: rgba(255,255,255,.85); }
  .frame { position: absolute; inset: 28px; border: 2px solid rgba(255,221,140,.7); border-radius: 6px; }
  .frame::after { content: ""; position: absolute; inset: 8px; border: 1px solid rgba(255,221,140,.4); border-radius: 3px; }
  .ward { font-size: 22px; letter-spacing: 6px; text-transform: uppercase; color: #ffd98c; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 400; font-size: 118px; letter-spacing: 1px; margin: 22px 0 10px; line-height: 1; }
  .rule { width: 180px; height: 2px; margin: 26px auto 30px; background: #ffd98c; position: relative; }
  .rule::before, .rule::after { content: "\\2726"; position: absolute; top: -17px; color: #ffd98c; font-size: 22px; }
  .rule::before { left: -34px; } .rule::after { right: -34px; }
  .when { font-size: 40px; font-weight: 600; }
  .where { font-size: 30px; margin-top: 10px; color: #fff3e0; }
  .what { font-size: 25px; margin-top: 54px; color: #ffd98c; letter-spacing: 1px; }
  .star { position: absolute; color: rgba(246,239,224,.28); font-size: 26px; }
</style></head>
<body>
  <div class="frame"></div>
  <span class="dot" style="left:240px;top:120px;width:6px;height:6px"></span>
  <span class="dot" style="left:960px;top:140px;width:5px;height:5px"></span>
  <span class="dot" style="left:300px;top:690px;width:7px;height:7px"></span>
  <span class="dot" style="left:890px;top:560px;width:5px;height:5px"></span>
  <span class="dot" style="left:640px;top:660px;width:4px;height:4px"></span>
  <span class="dot" style="left:150px;top:420px;width:5px;height:5px"></span>
  <span class="dot" style="left:1040px;top:420px;width:6px;height:6px"></span>
  <span class="star" style="left:120px;top:140px">&#x2726;</span>
  <span class="star" style="left:1050px;top:190px;font-size:18px">&#x2726;</span>
  <span class="star" style="left:170px;top:600px;font-size:16px">&#x2726;</span>
  <span class="star" style="left:1010px;top:640px">&#x2726;</span>
  <div class="ward">Springfield 8th Ward</div>
  <h1>Christmas Party</h1>
  <div class="rule"></div>
  <div class="when">Saturday, December 12 &middot; 6:00 PM</div>
  <div class="where">Cultural Hall</div>
  <div class="what">Dinner &middot; A visit from the North Pole &middot; The Primary nativity</div>
</body></html>`;
}

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- the server -------------------------------------------------------------------

async function startServer(zone, shiftMs) {
  const port = await freePort();
  // The shifted clock (see the header). `new Date()` with no arguments and `Date.now()` are the only
  // ways the app reads the time; a Date built from a value is left alone.
  const preload = join(work, 'clock.mjs');
  writeFileSync(
    preload,
    `const Real = Date;
const shift = ${Math.round(shiftMs)};
globalThis.Date = class extends Real {
  constructor(...args) { if (args.length) super(...args); else super(Real.now() + shift); }
  static now() { return Real.now() + shift; }
};
`,
  );
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(ROOT, 'dist', 'server.js')], {
    cwd: ROOT, // serveStatic resolves public/ against the working directory
    env: {
      ...process.env,
      ADMIN_PASSWORD,
      APP_NAME: WARD,
      APP_SHORT_NAME: 'Springfield',
      APP_DESCRIPTION: `Announcements for the ${WARD}`,
      APP_FOOTER: `For members and friends of the ${WARD}.`,
      // Development: production marks the cookies Secure, and this is plain http to 127.0.0.1.
      NODE_ENV: 'development',
      TZ: zone,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(preload).href}`.trim(),
      PORT: String(port),
      DATABASE_PATH: join(work, 'ward.db'),
      UPLOADS_PATH: join(work, 'uploads'),
      // Keep a developer's own .env (a PUBLIC_ORIGIN, say) out of the pictures.
      DOTENV_CONFIG_PATH: join(work, 'no.env'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.once('exit', r));
  const stop = async () => {
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    child.kill('SIGKILL');
  };

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited before serving:\n${log}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, stop };
    } catch {
      /* not listening yet */
    }
    await delay(200);
  }
  await stop();
  throw new Error(`the server did not start on ${base}:\n${log}`);
}

function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
    probe.on('error', fail);
  });
}

// --- seeding, over HTTP as the dashboard does it ------------------------------------

/** A cookie jar of one: what the server set, sent back, and handed to Chrome at the end. */
function client(base) {
  const jar = new Map();
  const req = async (path, { method = 'GET', form, json, body } = {}) => {
    const headers = jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  };
  const cookies = () => [...jar].map(([name, value]) => ({ name, value, url: base }));
  return { req, cookies };
}

async function seed(base, clock, { flyer }) {
  const admin = client(base);
  await admin.req('/admin/login', { method: 'POST', form: { password: ADMIN_PASSWORD } });
  if (!admin.cookies().length) throw new Error('signing in as the owner set no cookie');

  // The meeting time sets both the program window and the weekly notification (src/meeting.ts).
  await admin.req('/admin/meeting-time', {
    method: 'POST',
    form: { meeting_dow: String(clock.dow), meeting_time: clock.meeting },
  });
  // The first-run checklist would sit above everything; a ward that has been going a while has
  // dismissed it.
  await admin.req('/admin/getting-started/dismiss', { method: 'POST' });

  // A new ward starts with one sample announcement; delete it, then add ours.
  for (const { id } of await announcementIds(admin)) {
    await admin.req(`/admin/announcements/${id}/delete`, { method: 'POST' });
  }
  for (const a of ANNOUNCEMENTS) {
    await admin.req('/admin/announcements', { method: 'POST', form: { title: a.title, body: a.body, published: '1' } });
  }
  // Then put them in this file's order, as a drag on the dashboard would.
  const rows = await announcementIds(admin);
  const order = ANNOUNCEMENTS.map((a) => rows.find((r) => r.title === a.title)?.id);
  if (order.includes(undefined)) throw new Error('an announcement did not appear on the dashboard');
  await admin.req('/admin/announcements/reorder', { method: 'POST', json: { ids: order } });
  for (const [i, a] of ANNOUNCEMENTS.entries()) {
    if (!a.image) continue;
    const form = new FormData();
    form.set('owner_type', 'announcement');
    form.set('owner_id', String(order[i]));
    const bytes = a.image === 'flyer' ? flyer : readFileSync(a.image);
    form.set('file', new Blob([bytes], { type: 'image/png' }), 'flyer.png');
    await admin.req('/admin/attachments', { method: 'POST', body: form });
  }

  for (const p of PAGES) {
    await admin.req('/admin/pages', { method: 'POST', form: { title: p.title, body: p.body, published: '1' } });
  }

  // The app's own "Start from an example" program, with names in it: today's, which is showing
  // now, plus next week's and two past ones for the dashboard's list.
  const example = await exampleProgram(admin);
  for (const offset of [-14, -7, 0, 7]) {
    await admin.req('/admin/programs', {
      method: 'POST',
      form: { program_date: addDays(clock.date, offset), body: example },
    });
  }

  // A member: the access code read off the dashboard, redeemed as the gate page would.
  const html = await (await admin.req('/admin')).text();
  const code = /#code=([a-z0-9-]+)/.exec(html)?.[1];
  if (!code) throw new Error('no access code on the dashboard');
  const member = client(base);
  await member.req('/api/access', { method: 'POST', json: { code } });

  // Subscribers, for the count on the dashboard. The `.invalid` TLD never resolves, so nothing
  // could ever be delivered to them even if a send ran while the pictures were taken. The keys
  // have to be the real shapes — a 65-byte P-256 point and a 16-byte secret — since `/api/subscribe`
  // refuses anything else (a flood of made-up rows once locked real members out of the limit).
  for (let i = 1; i <= SUBSCRIBERS; i++) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    await member.req('/api/subscribe', {
      method: 'POST',
      json: {
        endpoint: `https://push.example.invalid/subscription/${i}`,
        keys: { p256dh, auth },
      },
    });
  }
  return { admin: admin.cookies(), member: member.cookies() };
}

/** The announcements on the dashboard, as { id, title }, in the order it lists them. */
async function announcementIds(admin) {
  const html = await (await admin.req('/admin')).text();
  return [...html.matchAll(/class="row-title" href="\/admin\/announcements\/(\d+)\/edit">([^<]*)</g)].map((m) => ({
    id: Number(m[1]),
    title: unescapeHtml(m[2]),
  }));
}

/** The New Program page's example (`?example=1`), its "(name)" blanks filled in. */
async function exampleProgram(admin) {
  const html = await (await admin.req('/admin/programs/new?example=1')).text();
  const raw = /<textarea id="body" name="body"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];
  if (!raw) throw new Error('no example program on /admin/programs/new?example=1');
  let n = 0;
  return unescapeHtml(raw).replace(/\(name\)/g, () => PROGRAM_NAMES[n++ % PROGRAM_NAMES.length]);
}

function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

// --- Chrome, over the DevTools Protocol ------------------------------------------------

async function startChrome() {
  const profile = join(work, 'chrome');
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--mute-audio',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let log = '';
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => child.once('exit', r));
  let cdp;
  const stop = async () => {
    cdp?.close();
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    child.kill('SIGKILL');
  };

  // Chrome writes the port it chose, and the browser target's path, to DevToolsActivePort.
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`Chrome did not start:\n${log.slice(-2000)}`);
    }
    await delay(100);
  }
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  cdp = await connect(`ws://127.0.0.1:${port}${path}`);
  return { cdp, stop };
}

/** A DevTools Protocol connection: `send(method, params, sessionId)` resolves with the result. */
function connect(url) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let next = 1;
    ws.onerror = () => fail(new Error(`could not connect to Chrome at ${url}`));
    const listeners = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) for (const listen of listeners) listen(msg);
      const waiter = msg.id && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.fail(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.ok(msg.result);
    };
    ws.onopen = () =>
      ok({
        send(method, params = {}, sessionId) {
          const id = next++;
          ws.send(JSON.stringify({ id, method, params, sessionId }));
          return new Promise((ok, fail) => pending.set(id, { ok, fail, method }));
        },
        /** Every protocol event (method, params, sessionId), for as long as the connection lives. */
        on: (listen) => listeners.push(listen),
        close: () => ws.close(),
      });
  });
}

/**
 * One picture, in a fresh browser context (its own cookies and storage, so one shot's dismissed
 * card or seen-announcements list never leaks into the next).
 */
async function shoot({ cdp }, base, { name, path, url = base + path, viewport, cookies, storage, ready, photograph = true }) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    // Whatever the Content Security Policy refuses on this page (src/csp.ts). A script the policy
    // blocks leaves no trace in the HTML the tests read; the browser is the only witness.
    const blocked = [];
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId || msg.method !== 'Log.entryAdded') return;
      if (/Content Security Policy/i.test(msg.params.entry.text)) blocked.push(msg.params.entry.text);
    });

    await send('Page.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Network.setCookies', { cookies });
    // "Default" rather than denied, so the card shows what a member who has not decided yet sees.
    await cdp.send('Browser.setPermission', {
      permission: { name: 'notifications' },
      setting: 'prompt',
      origin: base,
      browserContextId,
    });
    await send('Emulation.setDeviceMetricsOverride', viewport);
    // Light, whatever the machine running this prefers: headless Chrome follows the system's
    // appearance, and the README's pictures should not depend on whose Mac took them.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    if (viewport.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    if (storage) {
      const sets = Object.entries(storage)
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join('');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { ${sets} } catch {}` });
    }

    await send('Page.navigate', { url });
    await waitFor(send, `document.readyState === 'complete' && (${ready})`, name);
    // Fonts and images settled, then two frames so the last layout is painted. Bounded: an image
    // whose decode never settles (or a page in a background state where frames never come) would
    // otherwise hang the run with nothing said; past ten seconds, take the picture anyway.
    await evaluate(
      send,
      `Promise.race([
        Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => {}))])
          .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))),
        new Promise((r) => setTimeout(r, 10000)),
      ])`,
    );
    await delay(300);
    const location = await evaluate(send, 'location.pathname');
    if (location !== new URL(url).pathname) throw new Error(`${name}: landed on ${location}, not ${new URL(url).pathname}`);
    if (blocked.length) throw new Error(`${name}: the Content Security Policy blocked something:\n${blocked.join('\n')}`);

    if (!photograph) {
      console.log(`checked ${path}: nothing blocked`);
      return;
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    // No name: the caller wants the bytes (an image to upload), not a file in docs/images.
    if (name === null) return Buffer.from(data, 'base64');
    writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
    console.log(`wrote ${join(outDir, name)}`);
  } finally {
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

async function evaluate(send, expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function waitFor(send, expression, what) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(send, expression)) return;
    } catch {
      /* mid-navigation: the context went away under us */
    }
    await delay(150);
  }
  const text = await evaluate(send, 'document.body ? document.body.innerText.slice(0, 400) : ""').catch(() => '');
  throw new Error(`${what}: the page never got ready. It shows:\n${text}`);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
