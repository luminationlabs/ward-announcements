/**
 * The ward's own settings (Settings → Ward Settings, `src/ward-settings.ts`) and a ward with no owner
 * password — needed for hosting many wards from one deployment.
 *
 * Two halves:
 * - **Over HTTP**, against a real server on either runtime: an admin renames the ward and the
 *   public page, the manifest and the service worker follow; bad input is refused.
 * - **In process** (Node, `dist/`): what boot does with saved settings, what a timezone change does
 *   to the schedule, and a ward with no `ADMIN_PASSWORD` — whose owner cookie must be unforgeable,
 *   since the key it would be signed with is derived from the (empty, so public) password.
 *
 * Run with: npm test (and the HTTP half with npm run test:worker)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_PASSWORD, ROOT, TARGET, addPersonWithPasskey, createClient, startServer, testPort, unlockMember } from './helpers/harness.js';
import { assertConfig, config, loadConfig } from '../dist/config.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import * as db from '../dist/db.js';
import { loadWardSettings, refreshWardSettings, saveWardSettings } from '../dist/ward-settings.js';
import { DEFAULT_SCHEDULE, getScheduleSettings, nextSlotAfter, setScheduleSettings, uncoveredSlot } from '../dist/schedule-core.js';
import { createApp } from '../dist/app.js';
import { createSqlFileStore } from '../dist/filestore-sql.js';
import { invitePerson } from '../dist/passkeys.js';
import { getMeetingTime, saveMeetingTime, timingStatus } from '../dist/meeting.js';
import { DEFAULT_PROGRAM_SETTINGS, getProgramSettings } from '../dist/programs.js';

const WARD = {
  app_name: 'Example Ward',
  app_short_name: 'Example',
  app_description: 'News for Example Ward',
  app_footer: 'Visitors welcome',
  link_text: 'Ward calendar',
  link_url: 'https://example.org/calendar',
  timezone: 'America/Phoenix',
};

describe('ward settings over HTTP', () => {
  let server;
  let req;

  before(async () => {
    server = await startServer({ port: testPort(5) });
    req = createClient(server.base);
    const login = await req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
    assert.equal(login.status, 302);
    await unlockMember(req, 'member');
  });

  after(() => server?.stop());

  const save = async (form) => {
    const res = await req('/admin/ward', { as: 'admin', method: 'POST', form });
    assert.equal(res.status, 302);
    return decodeURIComponent(res.headers.get('location') ?? '');
  };
  const page = async () => (await req('/', { as: 'member' })).text();

  test('the card starts from the env values', async () => {
    const html = await (await req('/admin', { as: 'admin' })).text();
    assert.ok(html.includes('action="/admin/ward"'));
    assert.ok(html.includes('value="Test Ward"'));
    assert.ok(html.includes('value="America/Denver" selected'));
    assert.ok((await page()).includes('<title>Test Ward</title>'));
  });

  test('a save renames the app everywhere members see it', async () => {
    const swBefore = await (await req('/sw.js')).text();
    assert.match(await save(WARD), /Ward settings saved\./);

    const html = await page();
    assert.ok(html.includes('<title>Example Ward</title>'));
    assert.ok(html.includes('<h1>Example Ward</h1>'));
    assert.ok(html.includes('content="Example"'), 'the iOS home-screen title');
    assert.ok(html.includes('Visitors welcome'));
    assert.ok(html.includes('href="https://example.org/calendar"'));

    const manifest = await (await req('/manifest.webmanifest', { as: 'member' })).json();
    assert.equal(manifest.name, 'Example Ward');
    assert.equal(manifest.short_name, 'Example');

    // A new identity is a new build id, so installed apps update themselves to the new name.
    assert.notEqual(await (await req('/sw.js')).text(), swBefore);

    const dash = await (await req('/admin', { as: 'admin' })).text();
    assert.ok(dash.includes('Times are America/Phoenix'), 'the program window follows the timezone');
  });

  test('names are escaped, not rendered as markup', async () => {
    await save({ ...WARD, app_name: 'Example <b>Ward</b>' });
    const html = await page();
    assert.ok(html.includes('<title>Example &lt;b&gt;Ward&lt;/b&gt;</title>'));
    await save(WARD);
  });

  test("a value full of `$` patterns is shown as typed, and the page stays whole", async () => {
    // In a string replacement `$'` means "the rest of the page": once, this pasted the page into itself.
    const footer = "Bring $'s, $& and $` to the fundraiser";
    await save({ ...WARD, app_footer: footer, app_name: "Example $' Ward" });
    const html = await page();
    assert.ok(html.includes('Bring $&#39;s, $&amp; and $` to the fundraiser') || html.includes("Bring $'s, $&amp; and $` to the fundraiser"));
    assert.ok(html.includes('<title>Example $&#39; Ward</title>') || html.includes("<title>Example $' Ward</title>"));
    assert.equal(html.match(/<\/html>/g)?.length, 1, 'exactly one end of document');
    assert.equal(html.match(/<title>/g)?.length, 1);
    await save(WARD);
  });

  test('a timezone typed in lower case is stored with its proper name', async () => {
    await save({ ...WARD, timezone: 'america/phoenix' });
    const dash = await (await req('/admin', { as: 'admin' })).text();
    assert.ok(dash.includes('value="America/Phoenix" selected'));
    await save(WARD);
  });

  test('the timezone is a real dropdown: the common zones, then every zone this runtime knows', async () => {
    await save({ ...WARD, timezone: 'Asia/Tokyo' });
    const dash = await (await req('/admin', { as: 'admin' })).text();
    const select = dash.slice(dash.indexOf('<select id="timezone"'), dash.indexOf('</select>', dash.indexOf('<select id="timezone"')));
    assert.ok(select.includes('Mountain — Denver'), 'the common zones, in plain words');
    assert.ok(select.includes('value="Asia/Tokyo" selected'), 'a less common saved zone is found and kept');
    assert.ok((select.match(/<option /g) ?? []).length > 300, 'the full list (Node and workerd both carry it)');
    assert.ok(!dash.includes('<datalist'), 'no suggestion box: it offered only what was already typed');
    await save(WARD);
  });

  test("the Settings tab keeps code changes in their own card, apart from the share link", async () => {
    const html = await (await req('/admin', { as: 'admin' })).text();
    const share = html.indexOf('<h2>Share With Members</h2>');
    const ward = html.indexOf('<h2>Ward Settings</h2>');
    const management = html.indexOf('<h2>Access Code</h2>');
    assert.ok(share > 0 && ward > share && management > ward, 'all three cards, in that order');
    const end = (from) => html.indexOf('</section>', from);
    const shareCard = html.slice(share, end(share));
    const wardCard = html.slice(ward, end(ward));
    const managementCard = html.slice(management, end(management));
    for (const action of ['/admin/access/rotate']) {
      assert.ok(managementCard.includes(`action="${action}"`), `${action} is under the access code`);
      assert.ok(!shareCard.includes(`action="${action}"`), `${action} is not under the share link`);
    }
    // The locked page's wording and the invite length are settings, kept with the ward's own.
    assert.ok(wardCard.includes('action="/admin/access/settings"'), 'the wording is a ward setting');
    assert.ok(!shareCard.includes('action="/admin/access/settings"'), 'and not on the share card');
  });

  // This server has no PUBLIC_ORIGIN and is reached over plain http, so it never learns one: the
  // share link is not absolute, and a QR (or a flyer carrying one) would point nowhere.
  test('without a public address there is no flyer, as there is no QR', async () => {
    const html = await (await req('/admin', { as: 'admin' })).text();
    const start = html.indexOf('<h2>Share With Members</h2>');
    const card = html.slice(start, html.indexOf('</section>', start));
    assert.ok(card.includes('PUBLIC_ORIGIN'), "the card explains what's missing");
    assert.ok(!card.includes('/admin/qr.svg'));
    assert.ok(!card.includes('data-flyer-pdf'), 'no flyer buttons');
    assert.equal((await req('/admin/flyer.json', { as: 'admin' })).status, 404);
  });

  test('a new ward shows the Get started checklist, ticked from its own data, until dismissed', async () => {
    const html = await (await req('/admin', { as: 'admin' })).text();
    assert.match(html, /<h2 id="gs-title" class="gs-title">Get Started<\/h2>/);
    const stepFor = (link) => html.split('<li ').find((li) => li.includes(`>${link}</a>`)) ?? '';
    // The ward settings were saved above, and nobody has been added as a person yet.
    assert.match(stepFor('Ward Settings'), /^class="done"/);
    assert.match(stepFor('People'), /^class=""/);
    assert.match(stepFor('People'), /Add yourself and the others/, 'the owner, on the password, has to add themselves too');
    // The seeded sample is still there, and it is live to members until someone deletes it.
    assert.match(stepFor('Announcements'), /^class=""/);

    // An admin who signs in with a passkey has added themselves already, so for them the step is
    // about inviting a second person, and the owner's view now counts that first person.
    await addPersonWithPasskey(req, { as: 'person', origin: server.base, role: 'admin', name: 'First Admin' });
    const theirs = await (await req('/admin', { as: 'person' })).text();
    const theirStep = theirs.split('<li ').find((li) => li.includes('>People</a>')) ?? '';
    assert.match(theirStep, /^class=""/, 'one person is not yet "the others"');
    assert.match(theirStep, /Invite the others/);
    const owners = await (await req('/admin', { as: 'admin' })).text();
    assert.match(owners.split('<li ').find((li) => li.includes('>People</a>')) ?? '', /^class="done"/);
    assert.equal((await req('/admin/getting-started/dismiss', { as: 'admin', method: 'POST' })).status, 302);
    const dismissed = await (await req('/admin', { as: 'admin' })).text();
    assert.doesNotMatch(dismissed, /<h2 id="gs-title" class="gs-title">Get Started<\/h2>/);
    // Steps are still open, so Ward settings offers it back, and that brings it back.
    assert.match(dismissed, /action="\/admin\/getting-started\/show"/);
    assert.equal((await req('/admin/getting-started/show', { as: 'admin', method: 'POST' })).status, 302);
    const back = await (await req('/admin', { as: 'admin' })).text();
    assert.match(back, /<h2 id="gs-title" class="gs-title">Get Started<\/h2>/);
    assert.doesNotMatch(back, /action="\/admin\/getting-started\/show"/);
    assert.equal((await req('/admin/getting-started/dismiss', { as: 'admin', method: 'POST' })).status, 302);
  });

  // When sacrament meeting starts (src/meeting.ts): set once in Ward Settings, it sets the program
  // hours and the weekly notification, and says so before and after the save.
  test('the meeting time sets the program hours and the notification, and Get Started ticks it', async () => {
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    // A day that is not today in the ward's zone, so the program window is shut while this runs and
    // the closed message is the "will be here" one.
    const today = new Intl.DateTimeFormat('en-US', { timeZone: WARD.timezone, weekday: 'long' }).format(new Date());
    const dow = (DAYS.indexOf(today) + 3) % 7;
    const day = DAYS[dow];
    const meetingSave = async (form) => {
      const res = await req('/admin/meeting-time', { as: 'admin', method: 'POST', form });
      assert.equal(res.status, 302);
      return decodeURIComponent(res.headers.get('location') ?? '');
    };
    const rowOf = (html, id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</li>', html.indexOf(`id="${id}"`)));

    // Unset: the row says so, the step is open and links to the row, the timing is the default.
    assert.equal((await req('/admin/getting-started/show', { as: 'admin', method: 'POST' })).status, 302);
    let html = await (await req('/admin', { as: 'admin' })).text();
    const stepFor = (h) => h.split('<li ').find((li) => li.includes('>Sacrament Meeting</a>')) ?? '';
    assert.match(stepFor(html), /^class=""/);
    assert.match(stepFor(html), /data-section="sacrament-meeting"/);
    assert.match(html, /aria-label="\d of 5 steps done"><span>\d\/5<\/span>/, 'five steps now');
    assert.match(rowOf(html, 'sacrament-meeting'), /Not set/);
    assert.match(rowOf(html, 'advanced-timing'), /<span class="set-value">Default<\/span>/);
    assert.doesNotMatch(rowOf(html, 'sacrament-meeting'), /replaces your custom times/);

    // Saved: the flash says what the preview said, and everything follows.
    const flash = await meetingSave({ meeting_dow: String(dow), meeting_time: '10:30' });
    assert.match(flash, /^\/admin\?msg=.*#settings$/u);
    assert.ok(
      flash.includes(
        `Meeting time saved. This set the program hours to 9:30 AM–12:30 PM and the weekly notification to ${day}s at 9:30 AM.`,
      ),
      flash,
    );
    html = await (await req('/admin', { as: 'admin' })).text();
    assert.match(stepFor(html), /^class="done"/);
    assert.ok(rowOf(html, 'sacrament-meeting').includes(`${day}s, 10:30 AM`));
    assert.ok(
      rowOf(html, 'sacrament-meeting').includes(
        `Saving sets the program hours to 9:30 AM–12:30 PM and the weekly notification to ${day}s at 9:30 AM.`,
      ),
      'the preview, rendered by the server for the stored time',
    );
    assert.match(rowOf(html, 'advanced-timing'), /From meeting time/);
    assert.ok(html.includes(`${day}s, 9:30 AM`), 'the Notifications day and time');
    assert.match(html, /From your meeting time · <a href="#sacrament-meeting" data-section="sacrament-meeting">Change<\/a>/);
    assert.match(html, /9:30 AM–12:30 PM, so you can write it days ahead\. <a [^>]*data-section="sacrament-meeting">Change the Hours<\/a>/);
    const program = await (await req('/api/program', { as: 'member' })).json();
    assert.deepEqual(program, { open: false, message: `The program will be here ${day} at 9:30 AM.` });

    // A change under Advanced Timing makes it custom, and the meeting form warns before replacing it.
    assert.equal((await req('/admin/schedule', { as: 'admin', method: 'POST', form: { dow: String(dow), time: '07:00' } })).status, 302);
    html = await (await req('/admin', { as: 'admin' })).text();
    assert.match(rowOf(html, 'advanced-timing'), /<span class="set-value">Custom<\/span>/);
    assert.match(rowOf(html, 'sacrament-meeting'), /This replaces your custom times\./);
    assert.match(html, /Custom · <a href="#sacrament-meeting"/);
    await meetingSave({ meeting_dow: String(dow), meeting_time: '10:30' });
    html = await (await req('/admin', { as: 'admin' })).text();
    assert.match(rowOf(html, 'advanced-timing'), /From meeting time/, 'saving the meeting time resets it');

    // Out of range is refused with a reason, and nothing moves.
    assert.match(await meetingSave({ meeting_dow: '0', meeting_time: '23:30' }), /between 6:00 AM and 10:00 PM/);
    html = await (await req('/admin', { as: 'admin' })).text();
    assert.ok(rowOf(html, 'sacrament-meeting').includes(`${day}s, 10:30 AM`));

    assert.equal((await req('/admin/getting-started/dismiss', { as: 'admin', method: 'POST' })).status, 302);
  });

  const refusals = [
    ['a script link', { link_url: 'javascript:alert(1)' }, /must start with https/],
    ['an unknown timezone', { timezone: 'Mars/Olympus_Mons' }, /not a timezone/],
    ['an empty name', { app_name: '  ' }, /app name is required/],
    ['link text without an address', { link_url: '' }, /both the link text and its address/],
    ['an overlong home-screen name', { app_short_name: 'x'.repeat(21) }, /at most 20 characters/],
  ];
  for (const [what, change, message] of refusals) {
    test(`refuses ${what}, and keeps what was saved`, async () => {
      assert.match(await save({ ...WARD, ...change }), message);
      const html = await page();
      assert.ok(html.includes('<title>Example Ward</title>'));
      assert.ok(html.includes('href="https://example.org/calendar"'));
    });
  }
});

// Node modules from `dist/`, whichever server the HTTP half ran against: run once, under `npm test`.
describe('ward settings in process', { skip: TARGET === 'worker' }, () => {
  const ENV = {
    ADMIN_PASSWORD: 'in-process-password',
    APP_NAME: 'Env Ward',
    APP_SHORT_NAME: 'Env',
    APP_DESCRIPTION: 'From the environment',
    TZ: 'America/Denver',
  };
  let dir;
  let n = 0;
  /** A fresh database and a freshly booted config, as a process start would have it. */
  const boot = async (env = ENV, file = `ward-${++n}.db`) => {
    loadConfig(env);
    await db.initDb(createSqliteDriver(join(dir, file)));
    await loadWardSettings();
    return file;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ward-settings-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('the env values stand until the first save', async () => {
    await boot();
    assert.equal(config.appName, 'Env Ward');
    assert.equal(config.timezone, 'America/Denver');
  });

  test('saved settings outlive a restart, and win over the env', async () => {
    const file = await boot();
    await saveWardSettings({
      appName: 'Saved Ward',
      appShortName: 'Saved',
      appDescription: 'From the dashboard',
      appFooter: '',
      linkText: '',
      linkUrl: '',
      timezone: 'America/Chicago',
    });
    await boot(ENV, file); // same database, fresh process
    assert.equal(config.appName, 'Saved Ward');
    assert.equal(config.timezone, 'America/Chicago');
  });

  test('a stored blank or unknown value never replaces the env', async () => {
    await boot();
    await db.setSetting('ward_settings', JSON.stringify({ appName: '', timezone: 'Bad/Zone', appFooter: 'kept' }));
    await loadWardSettings();
    assert.equal(config.appName, 'Env Ward');
    assert.equal(config.timezone, 'America/Denver');
    assert.equal(config.appFooter, 'kept', 'an optional field may be anything, including set');
  });

  test('a timezone fix does not count as moving the schedule', async () => {
    // A "schedule moved" stamp would suppress the catch-up for a slot that has just passed in the
    // new zone — see the Sunday-morning test below for what that would cost.
    await boot();
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    const base = { appName: 'Env Ward', appShortName: 'Env', appDescription: 'From the environment' };
    await saveWardSettings({ ...base, timezone: 'America/New_York' });
    assert.equal(await db.getSetting('schedule_set_at'), '2020-01-01T00:00:00.000Z');
  });

  test('a timezone fixed on Sunday morning, before the send, still sends that week', async () => {
    // Denver ward, Sunday 08:00. At 06:30 Denver (08:30 New York) someone sets the zone to New
    // York: that zone's 08:00 has just passed and is uncovered. It must still go out — late, not
    // never. (Stamping the fix as a schedule move would suppress it and lose the week.)
    await boot();
    await db.setSetting('auto_send_enabled', '1');
    await setScheduleSettings({ dow: 0, time: '08:00' });
    await db.setSetting('schedule_set_at', '2026-10-25T00:00:00.000Z');
    const base = { appName: 'Env Ward', appShortName: 'Env', appDescription: 'From the environment' };
    await saveWardSettings({ ...base, timezone: 'America/New_York' });
    const now = new Date('2026-11-01T13:30:00Z'); // 08:30 in New York, 06:30 in Denver
    const owed = await uncoveredSlot(now, await getScheduleSettings(), config.timezone);
    assert.equal(owed?.slot, '2026-11-01T08:00');
  });

  test('a new timezone keeps the meeting, the program hours and the send at the same local time', async () => {
    await boot();
    await db.setSetting('auto_send_enabled', '1');
    await saveMeetingTime({ dow: '0', time: '10:30' });
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    const base = { appName: 'Env Ward', appShortName: 'Env', appDescription: 'From the environment' };
    await saveWardSettings({ ...base, timezone: 'America/New_York' });

    assert.deepEqual(await getMeetingTime(), { dow: 0, time: '10:30' }, 'still 10:30, now in New York');
    const program = await getProgramSettings();
    const schedule = await getScheduleSettings();
    assert.deepEqual([program.start, program.end], ['09:30', '12:30']);
    assert.deepEqual(schedule, { dow: 0, time: '09:30' });
    assert.equal(
      timingStatus(await getMeetingTime(), program, schedule, { program: DEFAULT_PROGRAM_SETTINGS, schedule: DEFAULT_SCHEDULE }),
      'derived',
      'not mistaken for a custom change',
    );
    assert.equal(await db.getSetting('schedule_set_at'), '2020-01-01T00:00:00.000Z', 'a rezone, not a move');
    // 09:30 Sunday in New York (EST after 1 November) is 14:30 UTC; in Denver it would be 16:30.
    const saturday = new Date('2026-11-07T18:00:00Z');
    assert.equal(nextSlotAfter(saturday, schedule, config.timezone)?.toISOString(), '2026-11-08T14:30:00.000Z');
  });

  test('a timezone is stored as the runtime spells it', async () => {
    await boot();
    const base = { appName: 'Env Ward', appShortName: 'Env', appDescription: 'From the environment' };
    const saved = await saveWardSettings({ ...base, timezone: 'america/phoenix' });
    assert.equal(saved.timezone, 'America/Phoenix');
    assert.equal(config.timezone, 'America/Phoenix');
  });

  test('a refresh that fails keeps the current settings instead of failing the request', async () => {
    const file = await boot();
    const base = { appName: 'Kept Ward', appShortName: 'Kept', appDescription: 'd', timezone: 'America/Denver' };
    await saveWardSettings(base);
    const real = createSqliteDriver(join(dir, file));
    const broken = { ...real, first: async () => { throw new Error('database unavailable'); } };
    db.setDriver(broken);
    try {
      // Force the refresh period to have run out, then refresh: it must not throw.
      await loadWardSettings({ throwOnError: false });
      await refreshWardSettings();
      assert.equal(config.appName, 'Kept Ward');
    } finally {
      db.setDriver(real);
    }
  });

  test('a refresh that was already reading cannot undo a save that lands first', async () => {
    const file = await boot();
    const base = { appName: 'Old Name', appShortName: 'Old', appDescription: 'd', timezone: 'America/Denver' };
    await saveWardSettings(base);
    const real = createSqliteDriver(join(dir, file));
    // The refresh's read is slow; the save completes while it waits.
    let release;
    const gate = new Promise((r) => (release = r));
    let slowed = false;
    const slow = {
      ...real,
      first: async (q, p) => {
        const row = await real.first(q, p);
        if (!slowed && p?.[0] === 'ward_settings') {
          slowed = true;
          await gate;
        }
        return row;
      },
    };
    db.setDriver(slow);
    try {
      const refreshing = loadWardSettings({ throwOnError: false }); // reads "Old Name", then waits
      await new Promise((r) => setTimeout(r, 5));
      await saveWardSettings({ ...base, appName: 'New Name' });
      release();
      await refreshing;
      assert.equal(config.appName, 'New Name', 'the stale read did not put the old name back');
    } finally {
      db.setDriver(real);
    }
  });

  test('fixing the timezone keeps the send at the same local time', async () => {
    // A ward sets Sunday 08:00, then notices the zone was wrong. They meant 08:00 where they are.
    await boot();
    await setScheduleSettings({ dow: 0, time: '08:00' });
    const base = { appName: 'Env Ward', appShortName: 'Env', appDescription: 'From the environment' };
    const after = new Date('2026-10-26T12:00:00Z'); // a Monday
    await saveWardSettings({ ...base, timezone: 'America/Phoenix' });
    assert.deepEqual(await getScheduleSettings(), { dow: 0, time: '08:00' });
    // Sunday 1 November 2026, 08:00 in Phoenix (UTC-7) — not 08:00 Denver carried over as 07:00.
    assert.equal(nextSlotAfter(after, await getScheduleSettings())?.toISOString(), '2026-11-01T15:00:00.000Z');
    await saveWardSettings({ ...base, timezone: 'America/New_York' });
    assert.equal(nextSlotAfter(after, await getScheduleSettings())?.toISOString(), '2026-11-01T13:00:00.000Z');
  });

  describe('a ward with no owner password', () => {
    const OWNERLESS = { ...ENV, ADMIN_PASSWORD: '' };
    let app;

    before(async () => {
      await boot(OWNERLESS);
      const pub = (...p) => readFileSync(join(ROOT, 'public', ...p), 'utf8');
      const silent = { debug() {}, info() {}, warn() {}, error() {} };
      app = createApp({
        shell: {
          index: pub('index.html'),
          sw: pub('sw.js'),
          iosSplash: '',
          assets: ['app.js', 'install.js', 'styles.css'].map((f) => pub(f)),
        },
        log: silent,
        files: createSqlFileStore(),
      });
    });

    const call = (path, init) => app.fetch(new Request(`http://ward.test${path}`, init));

    test('boot requires an owner unless told the ward has none', () => {
      assert.throws(() => assertConfig(config), /ADMIN_PASSWORD/);
      assert.doesNotThrow(() => assertConfig(config, { requireOwner: false }));
    });

    test('the sign-in page offers passkeys only', async () => {
      const html = await (await call('/admin/login')).text();
      assert.ok(html.includes('Sign In with a Passkey'));
      assert.ok(!html.includes('Owner Sign-In'));
    });

    test('an empty password is not a way in', async () => {
      const res = await call('/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=',
      });
      assert.equal(res.status, 401);
    });

    test('an owner cookie signed with the empty-password key is refused', async () => {
      // Exactly what config.ts derives from an empty password — anyone can compute it.
      const secret = createHash('sha256').update('pushannounce-session::').digest('hex');
      const value = `ok.${Math.floor(Date.now() / 1000)}`;
      const sig = createHmac('sha256', secret).update(value).digest('base64').replace(/=/g, '');
      const res = await call('/admin', { headers: { cookie: `pushannounce_session=${value}.${sig}` } });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/admin/login');
    });

    test('the first admin arrives by invite', async () => {
      const { id, path } = await invitePerson({ name: 'First Admin', role: 'admin' });
      const token = /#t=(.+)$/.exec(path)?.[1];
      assert.ok(token);
      const invite = await db.findUsableAdminInvite(token);
      assert.equal(invite?.user_id, id);
      assert.equal((await db.getAdminUser(id))?.role, 'admin');
    });
  });
});
