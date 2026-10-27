/**
 * The parts of sacrament meeting programs that are pure, or that no HTTP route exposes.
 *
 * Runs **in process** against the compiled modules rather than over HTTP, for two reasons the
 * end-to-end suite can't cover:
 *
 * - The dot-leader rule and the window arithmetic are functions of their inputs. Asserting them
 *   directly means a test can pin a specific instant — 07:59 on the day, an instant either side of
 *   a DST change — instead of hoping the clock cooperates while the suite runs.
 * - The retention purge has no route at all. It is driven by a cron tick on Workers and by boot on
 *   Node, so the only honest way to test it is to call it, over the real schema, with a `FileStore`
 *   that records what it was asked to delete.
 *
 * Node only, by construction (better-sqlite3, and `dist/`). Run with: npm test
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../dist/config.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import * as db from '../dist/db.js';
import { renderMarkdown, renderProgramMarkdown } from '../dist/markdown.js';
import {
  DEFAULT_PROGRAM_SETTINGS,
  automaticClosedMessage,
  closedProgramMessage,
  getProgramSettings,
  setProgramSettings,
  MAX_DASHBOARD_PROGRAMS,
  MAX_OBJECT_DELETES_PER_PURGE,
  MAX_PROGRAMS_PER_PURGE,
  MAX_RETENTION_DAYS,
  dashboardProgramLimit,
  localDate,
  maybePurgeOldPrograms,
  nextProgramDate,
  programWindowClosesAt,
  programWindowOpen,
  purgeOldPrograms,
} from '../dist/programs.js';
import {
  EARLIEST_MEETING,
  LATEST_MEETING,
  deriveTiming,
  getMeetingTime,
  saveMeetingTime,
  timingSentence,
  timingStatus,
  validMeetingTime,
} from '../dist/meeting.js';
import {
  DEFAULT_SCHEDULE,
  getScheduleSettings,
  instantAt,
  nextSendingSlotAfter,
  nextSlotAfter,
  setScheduleSettings,
  slotKey,
} from '../dist/schedule-core.js';

const TZ = 'America/Denver';

/** Silent, so a purge's log lines don't drown the test output. */
const log = { debug() {}, info() {}, warn() {}, error() {} };

let dataDir;
let driver;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wa-programs-'));
  loadConfig({
    ADMIN_PASSWORD: 'test-admin-password',
    APP_NAME: 'Test Ward',
    APP_SHORT_NAME: 'Test',
    APP_DESCRIPTION: 'Test announcements',
    VAPID_SUBJECT: 'mailto:test@example.org',
    VAPID_PUBLIC_KEY: 'x',
    VAPID_PRIVATE_KEY: 'y',
    NODE_ENV: 'development',
    TZ,
  });
  driver = createSqliteDriver(join(dataDir, 'programs.db'));
  await db.initDb(driver);
});

after(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('dot-leader rows', () => {
  const leftOf = (html) => /<span class="leader-left">(.*?)<\/span>/.exec(html)?.[1];
  const rightOf = (html) => /<span class="leader-right">(.*?)<\/span>/.exec(html)?.[1];

  test('a dotted line becomes two spans with a leader between them', () => {
    // Not a hymn row: those also link their number (test/hymn-links.test.js).
    const html = renderProgramMarkdown('Organist ... Sister Lee');
    assert.equal(
      html.trim(),
      '<p class="leader"><span class="leader-left">Organist</span>' +
        '<span class="leader-dots" aria-hidden="true"></span>' +
        '<span class="leader-right">Sister Lee</span></p>',
    );
  });

  test('a single bar is the same thing', () => {
    const html = renderProgramMarkdown('Presiding | Bishop Smith');
    assert.equal(leftOf(html), 'Presiding');
    assert.equal(rightOf(html), 'Bishop Smith');
  });

  test('a name is escaped, because the rule runs on the source and not on rendered HTML', () => {
    const html = renderProgramMarkdown('Speaker ... <script>alert(1)</script>');
    assert.doesNotMatch(html, /<script/, 'the tag never survives as markup');
    assert.equal(rightOf(html), '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('both halves are still Markdown', () => {
    const html = renderProgramMarkdown('**Speaker** ... *Sister* Lee');
    assert.equal(leftOf(html), '<strong>Speaker</strong>');
    assert.equal(rightOf(html), '<em>Sister</em> Lee');
  });

  test('consecutive lines each become their own row', () => {
    const html = renderProgramMarkdown('Presiding ... A\nConducting ... B\nOrganist ... C');
    assert.equal(html.match(/class="leader"/g)?.length, 3);
  });

  test('a row can interrupt a paragraph without a blank line', () => {
    const html = renderProgramMarkdown('Welcome.\nPresiding ... Bishop Smith');
    assert.match(html, /<p>Welcome\.<\/p>/);
    assert.equal(html.match(/class="leader"/g)?.length, 1);
  });

  test('the separator has to be surrounded by spaces', () => {
    // Otherwise every ratio and every mid-sentence ellipsis would silently become a row.
    assert.doesNotMatch(renderProgramMarkdown('Ratio 3|4 is fine'), /leader/);
    assert.doesNotMatch(renderProgramMarkdown('Wait...for it'), /leader/);
    assert.doesNotMatch(renderProgramMarkdown('Only two .. dots'), /leader/);
  });

  test('one side alone is not a row', () => {
    assert.doesNotMatch(renderProgramMarkdown('... trailing thought'), /leader/);
  });

  describe('the note line', () => {
    const noteOf = (html) => /<span class="leader-note">(.*?)<\/span>/.exec(html)?.[1];
    // A hymn row's number and note are also links (test/hymn-links.test.js); these tests are about
    // the row's shape, so they read the text inside.
    const unlinked = (s) => s?.replace(/<\/?a\b[^>]*>/g, '');

    test('a dotted line directly under a row is that row\'s note, inside the same row', () => {
      const html = renderProgramMarkdown('Opening Hymn ... #19\n... "We Thank Thee, O God, for a Prophet"');
      assert.equal(html.match(/class="leader"/g)?.length, 1, 'one row, not two blocks');
      assert.equal(unlinked(rightOf(html)), '#19');
      assert.equal(unlinked(noteOf(html)), '“We Thank Thee, O God, for a Prophet”');
      assert.doesNotMatch(html, /<p>/, 'nothing left over as a paragraph');
    });

    test('the note is Markdown and is escaped like the rest of the row', () => {
      const html = renderProgramMarkdown('Speaker ... Jane\n... *Farewell* <b>x</b>');
      assert.equal(noteOf(html), '<em>Farewell</em> &lt;b&gt;x&lt;/b&gt;');
    });

    test('a note takes one line only; the row after it is its own row', () => {
      const html = renderProgramMarkdown('Opening Hymn ... #19\n... "Title"\nInvocation ... TBD');
      assert.equal(html.match(/class="leader"/g)?.length, 2);
      assert.equal(html.match(/leader-note/g)?.length, 1);
    });

    test('a plain line under a row is still a paragraph — the dots are what opt in', () => {
      const html = renderProgramMarkdown('Opening Hymn ... #19\n"We Thank Thee"');
      assert.doesNotMatch(html, /leader-note/);
      assert.match(html, /<p>“We Thank Thee”<\/p>/);
    });

    test('a blank line between them ends the row, and the dotted line is then plain text', () => {
      const html = renderProgramMarkdown('Opening Hymn ... #19\n\n... "Title"');
      assert.doesNotMatch(html, /leader-note/);
      assert.match(html, /<p>… “Title”<\/p>/);
    });

    test('a bare run of dots under a row is not a note', () => {
      const html = renderProgramMarkdown('Opening Hymn ... #19\n...');
      assert.doesNotMatch(html, /leader-note/);
    });

    test('the row plus its note count as one block for the blank-line gap', () => {
      const html = renderProgramMarkdown('A\n\n\nHymn ... #1\n... "T"\n\n\nB');
      assert.match(html, /<p class="leader gap-1">/);
      assert.match(html, /<p class="gap-1">B<\/p>/);
    });
  });

  test('a real table is still a table, and indented code is still code', () => {
    assert.match(renderProgramMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |'), /<table>/);
    assert.match(renderProgramMarkdown('    Hymn ... #19'), /<pre><code>Hymn \.\.\. #19/);
  });

  test('announcements are left alone — a pipe there is just a pipe', () => {
    assert.doesNotMatch(renderMarkdown('Presiding | Bishop Smith'), /leader/);
    assert.match(renderMarkdown('Presiding | Bishop Smith'), /<p>Presiding \| Bishop Smith<\/p>/);
  });
});

describe('centered lines', () => {
  const rightOfLeader = (html) => /<span class="leader-right">(.*?)<\/span>/.exec(html)?.[1];

  test('a line wrapped in arrows becomes a centered paragraph', () => {
    assert.equal(
      renderProgramMarkdown('-> Sacrament Meeting <-').trim(),
      '<p class="centered">Sacrament Meeting</p>',
    );
  });

  test('announcements understand it too — unlike dot leaders, it is on both renderers', () => {
    assert.equal(
      renderMarkdown('-> Ward Conference <-').trim(),
      '<p class="centered">Ward Conference</p>',
    );
  });

  test('the arrows may hug the text or be padded out', () => {
    assert.match(renderProgramMarkdown('->Tight<-'), /<p class="centered">Tight<\/p>/);
    assert.match(renderProgramMarkdown('   ->   Loose   <-  '), /<p class="centered">Loose<\/p>/);
  });

  test('inline Markdown inside still renders', () => {
    assert.equal(
      renderProgramMarkdown('-> **Sacrament Meeting** <-').trim(),
      '<p class="centered"><strong>Sacrament Meeting</strong></p>',
    );
  });

  test('HTML in the text is escaped, because the rule runs on the source', () => {
    const html = renderProgramMarkdown('-> <img onerror=x> <-');
    assert.doesNotMatch(html, /<img/, 'the tag never survives as markup');
    assert.equal(html.trim(), '<p class="centered">&lt;img onerror=x&gt;</p>');
    assert.match(renderMarkdown('-> <img onerror=x> <-').trim(), /&lt;img onerror=x&gt;/);
  });

  test('a line that only contains an arrow is an ordinary paragraph', () => {
    for (const src of [
      'Head -> Toe',
      '-> missing the closer',
      'no opener <-',
      '<- backwards ->',
      '-> <-',
    ]) {
      assert.doesNotMatch(renderProgramMarkdown(src), /centered/, src);
      assert.doesNotMatch(renderMarkdown(src), /centered/, src);
    }
  });

  test('indented four spaces it is still a code block', () => {
    assert.match(renderProgramMarkdown('    -> Hymn <-'), /<pre><code>-&gt; Hymn &lt;-/);
  });

  test('a centered line and a leader row can sit next to each other', () => {
    const html = renderProgramMarkdown('-> Sacrament Meeting <-\nPresiding ... Bishop Smith');
    assert.match(html, /<p class="centered">Sacrament Meeting<\/p>/);
    assert.match(html, /<span class="leader-left">Presiding<\/span>/);
  });

  test('a centered line interrupts a paragraph without a blank line', () => {
    const html = renderProgramMarkdown('Welcome.\n-> Sacrament Meeting <-\nAnd then.');
    assert.match(html, /<p>Welcome\.<\/p>/);
    assert.match(html, /<p class="centered">Sacrament Meeting<\/p>/);
    assert.match(html, /<p>And then\.<\/p>/);
  });

  test('arrows outermost win a line that is also leader-shaped', () => {
    // Pathological input either way; the documented choice is that the outer markers decide, so the
    // dots stay literal text inside a centered paragraph rather than becoming a row.
    const html = renderProgramMarkdown('-> Speaker ... Jane Doe <-');
    assert.match(html, /<p class="centered">Speaker/);
    assert.doesNotMatch(html, /leader/);
  });

  test('a leader row whose value merely ends in an arrow is still a row', () => {
    const html = renderProgramMarkdown('Speaker ... Jane Doe <-');
    assert.doesNotMatch(html, /centered/);
    assert.equal(rightOfLeader(html), 'Jane Doe &lt;-');
  });

  test('a long line that never closes renders quickly', () => {
    // The regex these rules once used backtracked in cubic time here: `->` plus 3,000 spaces took
    // five seconds, and every member page load renders every body. Each input is one an editor can
    // save; the budget is generous so a slow machine never flakes, and the old code missed it by
    // orders of magnitude.
    const spaces = ' '.repeat(20_000);
    for (const src of [`->${spaces}x`, `# ->${spaces}x`, `a${spaces}b`, `a${spaces}.`]) {
      const started = performance.now();
      renderProgramMarkdown(src);
      renderMarkdown(src);
      const ms = performance.now() - started;
      assert.ok(ms < 500, `${JSON.stringify(src.slice(0, 6))}… took ${Math.round(ms)} ms`);
    }
  });
});

describe('centered headings', () => {
  test('a heading wrapped in arrows is classed centered, on both renderers', () => {
    assert.equal(
      renderProgramMarkdown('## -> Ward Business <-').trim(),
      '<h2 class="centered">Ward Business</h2>',
    );
    assert.equal(
      renderMarkdown('### -> Ward Conference <-').trim(),
      '<h3 class="centered">Ward Conference</h3>',
    );
  });

  test('a plain heading is untouched', () => {
    assert.equal(renderProgramMarkdown('## Ward Business').trim(), '<h2>Ward Business</h2>');
  });

  test('inline markdown inside still renders, and raw HTML still escapes', () => {
    assert.equal(
      renderProgramMarkdown('## -> **Ward** Business <-').trim(),
      '<h2 class="centered"><strong>Ward</strong> Business</h2>',
    );
    assert.equal(
      renderProgramMarkdown('## -> <img onerror=x> <-').trim(),
      '<h2 class="centered">&lt;img onerror=x&gt;</h2>',
    );
  });

  test('half a pair, or an empty pair, leaves the heading alone', () => {
    for (const src of ['## -> missing the closer', '## no opener <-', '## -> <-', '## Head -> Toe']) {
      assert.doesNotMatch(renderProgramMarkdown(src), /centered/, src);
    }
  });

  test('a heading is left-aligned even where it is leader-shaped', () => {
    // The heading rule owns the line before the leader rule sees it; the dots stay literal text.
    const html = renderProgramMarkdown('## Speaker ... Jane Doe');
    assert.doesNotMatch(html, /leader|centered/);
  });
});

describe('images from elsewhere', () => {
  // `![](https://…)` would have every member's phone fetch that address on every page load: a
  // tracking pixel an editor's account could plant. Only the ward's own uploads are drawn.
  test('a remote image becomes a link to it, and nothing is fetched', () => {
    for (const render of [renderMarkdown, renderProgramMarkdown]) {
      const html = render('![The flyer](https://tracker.example/p.png)');
      assert.doesNotMatch(html, /<img/);
      assert.match(html, /<a href="https:\/\/tracker\.example\/p\.png" target="_blank" rel="noopener noreferrer">The flyer<\/a>/);
    }
  });

  test("the ward's own uploads are still drawn", () => {
    assert.match(renderMarkdown('![](/images/0123456789abcdef0123456789abcdef.png)'), /<img src="\/images\/0123456789abcdef0123456789abcdef\.png"/);
  });

  test('anything else is its words alone, escaped', () => {
    assert.equal(renderMarkdown('![a "b" <c>](data:image/png;base64,AAAA)').trim(), '<p>a &quot;b&quot; &lt;c&gt;</p>');
    assert.doesNotMatch(renderMarkdown('![x](/images/../secret.png)'), /<img/, 'not a storage key');
  });
});

describe('blank-line gaps', () => {
  test('two blank lines open a gap above the next block; one does not', () => {
    assert.equal(renderProgramMarkdown('A\n\nB').trim(), '<p>A</p>\n<p>B</p>');
    assert.equal(renderProgramMarkdown('A\n\n\nB').trim(), '<p>A</p>\n<p class="gap-1">B</p>');
  });

  test('each blank line beyond the first adds a step, capped at three', () => {
    assert.match(renderProgramMarkdown('A\n\n\n\nB'), /<p class="gap-2">B/);
    assert.match(renderProgramMarkdown('A\n\n\n\n\nB'), /<p class="gap-3">B/);
    assert.match(renderProgramMarkdown('A\n\n\n\n\n\n\n\n\nB'), /<p class="gap-3">B/);
  });

  test('every block kind can carry the gap, on both renderers', () => {
    assert.match(renderProgramMarkdown('A\n\n\nSpeaker ... B'), /<p class="leader gap-1">/);
    assert.match(renderProgramMarkdown('A\n\n\n-> B <-'), /<p class="centered gap-1">B<\/p>/);
    assert.match(renderProgramMarkdown('A\n\n\n## B'), /<h2 class="gap-1">B<\/h2>/);
    assert.match(renderProgramMarkdown('A\n\n\n## -> B <-'), /<h2 class="centered gap-1">B<\/h2>/);
    assert.match(renderProgramMarkdown('A\n\n\n---'), /<hr class="gap-1">/);
    assert.match(renderMarkdown('A\n\n\n- B'), /<ul class="gap-1">/);
    assert.match(renderMarkdown('A\n\n\n-> B <-'), /<p class="centered gap-1">B<\/p>/);
  });

  test('the first block never gets a gap, however many blank lines precede it', () => {
    assert.equal(renderProgramMarkdown('\n\n\nA').trim(), '<p>A</p>');
  });

  test('a run of leader rows with no blank lines gets none', () => {
    const html = renderProgramMarkdown('Presiding ... A\nConducting ... B\n\nOrganist ... C');
    assert.doesNotMatch(html, /gap/);
  });

  test('blank lines inside a list are left to Markdown', () => {
    const html = renderMarkdown('- a\n\n\n- b');
    assert.doesNotMatch(html, /<li[^>]*gap|<p[^>]*gap/);
  });
});

describe('the visibility window', () => {
  const settings = { ...DEFAULT_PROGRAM_SETTINGS, dow: 0, start: '08:00', end: '14:00' };

  // 2026-09-13 is a Sunday. Denver is UTC-6 in September (MDT), so 14:00 UTC is 08:00 local.
  const denver = (iso) => new Date(iso);

  test('open between the two times on the configured day', () => {
    assert.equal(programWindowOpen(denver('2026-09-13T14:00:00Z'), settings, TZ), true, '08:00');
    assert.equal(programWindowOpen(denver('2026-09-13T17:30:00Z'), settings, TZ), true, '11:30');
  });

  test('it says when it closes, to the minute, in the ward\'s own time', () => {
    // What the service worker uses to refuse an offline copy after the window (public/sw.js).
    const closes = new Date('2026-09-13T20:00:00Z').getTime(); // 14:00 in Denver
    assert.equal(programWindowClosesAt(denver('2026-09-13T14:00:00Z'), settings, TZ), closes, '08:00');
    assert.equal(programWindowClosesAt(denver('2026-09-13T19:59:59.500Z'), settings, TZ), closes, '13:59:59');
    assert.equal(programWindowClosesAt(denver('2026-09-13T20:00:00Z'), settings, TZ), null, 'shut, so nothing');
    // Kolkata is UTC+5:30: the half hour has to come out of the wall clock, not be assumed away.
    const kolkata = 'Asia/Kolkata';
    assert.equal(
      programWindowClosesAt(new Date('2026-09-13T03:00:00Z'), settings, kolkata),
      new Date('2026-09-13T08:30:00Z').getTime(),
      '08:30 there closes at 14:00 there',
    );
  });

  test('it closes at 14:00 on the clock even when the clocks change inside the window', () => {
    // Counting wall-clock minutes forward from 00:30 came out an hour wrong on both Sundays.
    const allMorning = { ...settings, start: '00:00', end: '14:00' };
    // 2026-03-08, spring forward at 02:00: 00:30 MST is 07:30Z; 14:00 MDT is 20:00Z.
    assert.equal(
      programWindowClosesAt(new Date('2026-03-08T07:30:00Z'), allMorning, TZ),
      new Date('2026-03-08T20:00:00Z').getTime(),
      'spring forward',
    );
    // 2026-11-01, fall back at 02:00: 00:30 MDT is 06:30Z; 14:00 MST is 21:00Z.
    assert.equal(
      programWindowClosesAt(new Date('2026-11-01T06:30:00Z'), allMorning, TZ),
      new Date('2026-11-01T21:00:00Z').getTime(),
      'fall back',
    );
  });

  test('shut before it opens and at the moment it ends', () => {
    assert.equal(programWindowOpen(denver('2026-09-13T13:59:00Z'), settings, TZ), false, '07:59');
    // Exclusive end: "08:00 to 14:00" reads as shut at 14:00, not open through 14:00:59.
    assert.equal(programWindowOpen(denver('2026-09-13T20:00:00Z'), settings, TZ), false, '14:00');
  });

  test('shut on every other day, whatever the time', () => {
    assert.equal(programWindowOpen(denver('2026-09-14T17:00:00Z'), settings, TZ), false, 'Monday');
    assert.equal(programWindowOpen(denver('2026-09-12T17:00:00Z'), settings, TZ), false, 'Saturday');
  });

  test('the window follows local time across a DST change, not UTC', () => {
    // 2026-11-01 is the Sunday the US falls back: Denver goes UTC-6 → UTC-7 at 02:00 local.
    // 15:00 UTC is 08:00 MST that morning — inside the window — while the same UTC time a week
    // earlier is 09:00 MDT, also inside. The instant that must differ is 14:00 UTC: 08:00 MDT
    // (open) on Oct 25, and 07:00 MST (shut) on Nov 1.
    assert.equal(programWindowOpen(denver('2026-10-25T14:00:00Z'), settings, TZ), true, 'MDT 08:00');
    assert.equal(programWindowOpen(denver('2026-11-01T14:00:00Z'), settings, TZ), false, 'MST 07:00');
    assert.equal(programWindowOpen(denver('2026-11-01T15:00:00Z'), settings, TZ), true, 'MST 08:00');
  });

  test('a local date is the date it is *there*', () => {
    // 05:00 UTC on the 14th is still the evening of the 13th in Denver.
    assert.equal(localDate(denver('2026-09-14T05:00:00Z'), TZ), '2026-09-13');
    assert.equal(localDate(denver('2026-09-14T07:00:00Z'), TZ), '2026-09-14');
  });

  test('a new program defaults to today when today is the program day, else the next one', () => {
    assert.equal(nextProgramDate(denver('2026-09-13T17:00:00Z'), settings, TZ), '2026-09-13');
    assert.equal(nextProgramDate(denver('2026-09-14T17:00:00Z'), settings, TZ), '2026-09-20');
    assert.equal(nextProgramDate(denver('2026-09-19T17:00:00Z'), settings, TZ), '2026-09-20');
  });
});

describe('the closed message', () => {
  const sunday = { ...DEFAULT_PROGRAM_SETTINGS, dow: 0, start: '08:00', end: '14:00', closedMessage: '' };

  test('outside the window it names the day and the start time, and no date', () => {
    assert.equal(
      closedProgramMessage(sunday, false),
      'The program will be here Sunday at 8:00 AM.',
    );
    // A ward whose meeting is not on a Sunday is told its own day, in the dashboard's clock style.
    assert.equal(
      closedProgramMessage({ ...sunday, dow: 6, start: '13:30' }, false),
      'The program will be here Saturday at 1:30 PM.',
    );
    assert.equal(
      closedProgramMessage({ ...sunday, start: '00:00' }, false),
      'The program will be here Sunday at 12:00 AM.',
    );
  });

  test('inside the window it never claims the program "will be here" on the day itself', () => {
    const inside = closedProgramMessage(sunday, true);
    assert.doesNotMatch(inside, /will be here/u);
    assert.equal(inside, "Today's program hasn't been posted.");
  });

  test("a clerk's own wording wins, at every hour", () => {
    const custom = { ...sunday, closedMessage: 'Programs are on the bulletin board.' };
    assert.equal(closedProgramMessage(custom, false), 'Programs are on the bulletin board.');
    assert.equal(closedProgramMessage(custom, true), 'Programs are on the bulletin board.');
    // Whitespace alone is not wording.
    assert.equal(
      closedProgramMessage({ ...sunday, closedMessage: '   ' }, false),
      automaticClosedMessage(sunday, false),
    );
  });

  test('takes nothing but the settings and the window state', () => {
    // The byte-identical guarantee on /api/program rests on this: the message has no way to learn
    // whether a program exists, because it is never told.
    assert.equal(closedProgramMessage.length, 2);
    assert.equal(automaticClosedMessage.length, 2);
  });

  test('unset, blank and the old fixed default all read back as automatic; anything else is kept', async () => {
    const base = { dow: 0, start: '08:00', end: '14:00', retentionDays: 90 };
    await db.deleteSetting('program_closed_message');
    assert.equal((await getProgramSettings()).closedMessage, '', 'unset');

    await setProgramSettings({ ...base, closedMessage: '' });
    assert.equal((await getProgramSettings()).closedMessage, '', 'saved blank');

    // What the settings form was prefilled with before the automatic message: stored verbatim by
    // any ward that saved its hours, and never a clerk's own choice of words.
    await setProgramSettings({
      ...base,
      closedMessage:
        'The sacrament meeting program is available on Sundays around meeting time. Check back then!',
    });
    assert.equal((await getProgramSettings()).closedMessage, '', 'the old default');

    await setProgramSettings({ ...base, closedMessage: 'The program will be here on Sunday.' });
    assert.equal(
      (await getProgramSettings()).closedMessage,
      'The program will be here on Sunday.',
      'custom wording, even wording close to the automatic one, is the clerk\'s',
    );
    await setProgramSettings({ ...base, closedMessage: '' });
  });
});

// The dashboard is the only place a program can be edited or deleted from, so how many it asks for
// is a correctness property, not a tuning knob: a row the list never fetches is stranded until the
// purge reaches it. These pin the arithmetic that keeps the list ahead of the retention window.
describe('how many programs the dashboard asks for', () => {
  test('covers a program a week for the whole retention window, at every legal setting', () => {
    for (const days of [1, 7, 8, 90, 365, 366, 1000, MAX_RETENTION_DAYS]) {
      const limit = dashboardProgramLimit(days);
      // One program a week is the most a ward can produce over the window, so a limit at or above
      // that is a limit that can strand nothing.
      assert.ok(
        limit >= Math.ceil(days / 7),
        `${days} days of retention holds up to ${Math.ceil(days / 7)} programs, but the list asks for ${limit}`,
      );
    }
  });

  // The guard against the ceiling being tightened below the retention range later: that would
  // quietly reintroduce exactly the bug this arithmetic exists to prevent, at the far end where
  // nobody would notice for years.
  test('the ceiling cannot bind against a valid retention setting', () => {
    assert.equal(dashboardProgramLimit(MAX_RETENTION_DAYS), MAX_DASHBOARD_PROGRAMS);
    assert.ok(MAX_DASHBOARD_PROGRAMS >= Math.ceil(MAX_RETENTION_DAYS / 7));
  });

  test('an out-of-range number is still clamped to something a LIMIT accepts', () => {
    const absurd = dashboardProgramLimit(Number.MAX_SAFE_INTEGER);
    assert.equal(absurd, MAX_DASHBOARD_PROGRAMS);
    assert.ok(Number.isInteger(absurd));
  });
});

describe('retention', () => {
  /** A FileStore that only remembers what it holds — enough to prove the bytes went too. */
  function recordingStore() {
    const objects = new Set();
    return {
      objects,
      async put(key) {
        objects.add(key);
      },
      async get(key) {
        return objects.has(key) ? { body: new Uint8Array(), contentType: 'image/png' } : undefined;
      },
      async delete(key) {
        objects.delete(key);
      },
    };
  }

  /** A program with `images` attachments, in both the database and the store. */
  async function programWithImage(store, date, images = 1) {
    const id = await db.createProgram({ date, body: `Presiding ... on ${date}` });
    const keys = [];
    for (let i = 0; i < images; i++) {
      // The store's key format is 32 hex characters plus an extension; a date's digits are hex, so
      // padding one out (with the image's index) gives a valid, unique, readable key.
      const key = (date.replace(/-/g, '') + String(i) + '0'.repeat(24)).slice(0, 32) + '.png';
      await store.put(key, new Uint8Array([1]), 'image/png');
      await db.createAttachment({
        ownerType: 'program',
        ownerId: id,
        key,
        filename: 'insert.png',
        contentType: 'image/png',
        size: 1,
      });
      keys.push(key);
    }
    return { id, key: keys[0], keys };
  }

  // Noon in Denver on 2026-09-09. With a 30-day window the cutoff is 2026-08-10, so anything
  // dated strictly before that goes and 2026-08-10 itself stays.
  const NOW = new Date('2026-09-09T18:00:00Z');

  before(async () => {
    await db.setSetting('program_retention_days', '30');
  });

  test('an expired program goes, images and all; a recent one is untouched', async () => {
    const store = recordingStore();
    const old = await programWithImage(store, '2026-05-01');
    const recent = await programWithImage(store, '2026-09-06');

    const purged = await purgeOldPrograms(store, log, NOW, TZ);
    assert.deepEqual(
      purged.map((p) => p.program_date),
      ['2026-05-01'],
    );
    assert.equal(await db.getProgram(old.id), undefined, 'the row is gone');
    assert.equal(store.objects.has(old.key), false, 'and so are the bytes');
    assert.deepEqual(await db.listAttachments('program', old.id), [], 'and the attachment rows');

    assert.ok(await db.getProgram(recent.id), 'the recent program is left alone');
    assert.equal(store.objects.has(recent.key), true);
    await db.deleteProgram(recent.id);
  });

  test('the day on the cutoff itself is kept', async () => {
    const store = recordingStore();
    const edge = await programWithImage(store, '2026-08-10'); // exactly 30 days back
    assert.deepEqual(await purgeOldPrograms(store, log, NOW, TZ), []);
    assert.ok(await db.getProgram(edge.id));
    await db.deleteProgram(edge.id);
  });

  test('a text-heavy backlog is spread over runs by the program cap', async () => {
    // The caps exist for the Workers subrequest budget of fifty per invocation. A program with no
    // images still costs three queries (list its attachments, drop the rows, drop the program), so
    // the program count has to be capped even when no storage delete is involved.
    const store = recordingStore();
    const dates = [
      '2026-01-04',
      '2026-01-11',
      '2026-01-18',
      '2026-01-25',
      '2026-02-01',
      '2026-02-08',
      '2026-02-15',
    ];
    for (const date of dates) await db.createProgram({ date, body: 'no images here' });
    assert.ok(dates.length > MAX_PROGRAMS_PER_PURGE, 'the fixture has to exceed the cap to test it');

    const first = await purgeOldPrograms(store, log, NOW, TZ);
    assert.equal(first.length, MAX_PROGRAMS_PER_PURGE);
    assert.deepEqual(
      first.map((p) => p.program_date),
      dates.slice(0, MAX_PROGRAMS_PER_PURGE),
      'oldest first',
    );

    const second = await purgeOldPrograms(store, log, NOW, TZ);
    assert.deepEqual(
      second.map((p) => p.program_date),
      dates.slice(MAX_PROGRAMS_PER_PURGE),
    );
    assert.deepEqual(await purgeOldPrograms(store, log, NOW, TZ), [], 'and then nothing is left');
  });

  test('an image-heavy backlog is capped by storage deletes, not by program count', async () => {
    // The case a program cap alone misses: each image is one storage delete, and on Workers each
    // of those is a subrequest. Three programs at ten images each is thirty deletes in one
    // invocation — within a program-count cap. The run stops as soon as the object budget is
    // spent, at a program boundary so nothing is left half-deleted.
    const store = recordingStore();
    const perProgram = 5;
    const dates = ['2026-03-01', '2026-03-08', '2026-03-15'];
    for (const date of dates) await programWithImage(store, date, perProgram);
    assert.ok(
      dates.length <= MAX_PROGRAMS_PER_PURGE,
      'the fixture must be under the program cap, so only the object cap can stop the run',
    );
    assert.ok(dates.length * perProgram > MAX_OBJECT_DELETES_PER_PURGE, 'and over the object cap');

    const first = await purgeOldPrograms(store, log, NOW, TZ);
    assert.equal(
      first.length,
      Math.ceil(MAX_OBJECT_DELETES_PER_PURGE / perProgram),
      'it stops on the program that spends the object budget, having finished that program',
    );
    assert.equal(
      store.objects.size,
      (dates.length - first.length) * perProgram,
      'and every image of every purged program went, none of the rest',
    );

    const second = await purgeOldPrograms(store, log, NOW, TZ);
    assert.deepEqual(
      second.map((p) => p.program_date),
      dates.slice(first.length),
      'the next run takes the remainder',
    );
    assert.equal(store.objects.size, 0, 'every image went with its program');
  });

  test('the periodic hook runs at most once per local day', async () => {
    const store = recordingStore();
    const first = await programWithImage(store, '2026-02-01');
    await maybePurgeOldPrograms(store, log, NOW, TZ);
    assert.equal(await db.getProgram(first.id), undefined, 'the first call of the day sweeps');

    const second = await programWithImage(store, '2026-02-08');
    await maybePurgeOldPrograms(store, log, NOW, TZ);
    assert.ok(
      await db.getProgram(second.id),
      'a second call the same day is a settings read and nothing else',
    );

    // Tomorrow, it sweeps again — the marker is the local date, not a duration.
    await maybePurgeOldPrograms(store, log, new Date('2026-09-10T18:00:00Z'), TZ);
    assert.equal(await db.getProgram(second.id), undefined);
  });

  test('a backlog clears in one sweep where there is no budget, and a tick at a time where there is', async () => {
    // An admin shortens retention from years to 90 days with a year of programs on file. Found in
    // an audit: at four programs a day, expired programs — names and all — stayed in the
    // dashboard and in backups for months.
    const store = recordingStore();
    const year = [];
    for (let week = 0; week < 10; week++) year.push(await programWithImage(store, `2025-0${1 + Math.floor(week / 4)}-${String(1 + (week % 4) * 7).padStart(2, '0')}`));
    const left = async () => (await Promise.all(year.map((p) => db.getProgram(p.id)))).filter(Boolean).length;

    // The free-plan Worker: one bounded batch, and the day's marker cleared so the next tick goes on.
    await maybePurgeOldPrograms(store, log, new Date('2026-09-11T18:00:00Z'), TZ);
    assert.ok((await left()) > 0 && (await left()) < 10, 'one batch, not all ten');
    await maybePurgeOldPrograms(store, log, new Date('2026-09-11T18:01:00Z'), TZ);
    assert.ok((await left()) < 10 - MAX_PROGRAMS_PER_PURGE, 'the next tick that day takes the next batch');

    // Node or the host: the rest in one call.
    await maybePurgeOldPrograms(store, log, new Date('2026-09-11T18:02:00Z'), TZ, { untilDone: true });
    assert.equal(await left(), 0);
    assert.equal(store.objects.size, 0, 'images and all');
    assert.equal(await db.getSetting('program_purge_last_run'), '2026-09-11', 'and done for the day once it is clear');
  });

  // Images uploaded to a New form that was never saved are 'pending' (see POST /admin/attachments).
  // The daily sweep deletes them — rows and bytes — once they are a day old, and no sooner.
  test('the periodic hook deletes images from forms nobody saved, after a day', async () => {
    const store = recordingStore();
    const pending = async (key, age) => {
      await store.put(key, new Uint8Array([1]), 'image/png');
      const id = await db.createAttachment({
        ownerType: db.PENDING_OWNER,
        ownerId: 0,
        key,
        filename: 'pending.png',
        contentType: 'image/png',
        size: 1,
      });
      await driver.run(`UPDATE attachments SET created_at = datetime('now', ?) WHERE id = ?`, [age, id]);
      return id;
    };
    const stale = await pending('a'.repeat(32) + '.png', '-2 days');
    const fresh = await pending('b'.repeat(32) + '.png', '-2 hours');
    await maybePurgeOldPrograms(store, log, new Date('2026-09-21T18:00:00Z'), TZ);
    assert.equal(await db.attachmentById(stale), undefined, 'a two-day-old unsaved image is gone');
    assert.ok(!store.objects.has('a'.repeat(32) + '.png'), 'bytes and all');
    assert.ok(await db.attachmentById(fresh), 'one uploaded this morning stays: its form may still be open');
    assert.ok(store.objects.has('b'.repeat(32) + '.png'));
  });

  // Dropped only at boot, expired tokens would pile up in a Node process that stays up: every
  // member invite and every weekly email link it had ever minted. The daily sweep takes them too.
  test('the periodic hook drops long-expired access tokens of every kind', async () => {
    const rows = [
      ['old-invite', 'invite', '-40 days'],
      ['old-email', 'email', '-40 days'],
      ['old-device', 'device', '-40 days'],
      ['just-expired-email', 'email', '-2 days'],
      ['live-email', 'email', '+10 days'],
    ];
    for (const [token, kind, age] of rows) {
      await db.createAccessToken({ token, kind, ttlDays: 1 });
      await driver.run(`UPDATE access_tokens SET expires_at = datetime('now', ?) WHERE token = ?`, [age, token]);
    }
    await maybePurgeOldPrograms(recordingStore(), log, new Date('2026-09-20T18:00:00Z'), TZ);
    const left = await driver.all(`SELECT token FROM access_tokens ORDER BY token`);
    assert.deepEqual(
      left.map((r) => r.token),
      ['just-expired-email', 'live-email'],
      'a month past expiry goes, whatever the kind; a recent expiry and a live token stay',
    );
    assert.equal(await db.findAccessToken('just-expired-email'), undefined, 'kept is not the same as usable');
  });
});

// ---------------------------------------------------------------------------
// The meeting time (src/meeting.ts): the one timing a clerk sets, and what it derives.
// ---------------------------------------------------------------------------

describe('the meeting time sets the program hours and the weekly notification', () => {
  const sunday = (time) => deriveTiming({ dow: 0, time });

  test('an hour before to two hours after, and the notification as the program opens', () => {
    assert.deepEqual(sunday('10:30'), {
      window: { dow: 0, start: '09:30', end: '12:30' },
      schedule: { dow: 0, time: '09:30' },
    });
    // The day goes with it: a Saturday meeting is a Saturday window and a Saturday send.
    assert.deepEqual(deriveTiming({ dow: 6, time: '09:00' }), {
      window: { dow: 6, start: '08:00', end: '11:00' },
      schedule: { dow: 6, time: '08:00' },
    });
  });

  test('both are clamped to the meeting day and never wrap past midnight', () => {
    // Early: an hour before 00:30 would be Saturday night; it is 00:00 on the day instead, for the
    // window and the notification alike.
    assert.deepEqual(sunday('00:30'), {
      window: { dow: 0, start: '00:00', end: '02:30' },
      schedule: { dow: 0, time: '00:00' },
    });
    // Late: two hours after 22:00 would be Monday; the window stops at the day's last minute.
    assert.deepEqual(sunday('22:00').window, { dow: 0, start: '21:00', end: '23:59' });
    assert.deepEqual(sunday('23:30').window, { dow: 0, start: '22:30', end: '23:59' });
    assert.equal(sunday('21:59').window.end, '23:59', 'the last time that fits exactly');
  });

  test('the form takes 6:00 AM to 10:00 PM, and refuses the rest', () => {
    assert.deepEqual(validMeetingTime({ dow: '0', time: '06:00' }), { dow: 0, time: '06:00' });
    assert.deepEqual(validMeetingTime({ dow: '3', time: '22:00' }), { dow: 3, time: '22:00' });
    assert.equal(EARLIEST_MEETING, '06:00');
    assert.equal(LATEST_MEETING, '22:00');
    assert.throws(() => validMeetingTime({ dow: '0', time: '05:59' }), /between 6:00 AM and 10:00 PM/);
    assert.throws(() => validMeetingTime({ dow: '0', time: '22:01' }), /Check AM and PM/);
    assert.throws(() => validMeetingTime({ dow: '0', time: '10:30 AM' }), /HH:MM/);
    assert.throws(() => validMeetingTime({ dow: '0', time: '' }), /HH:MM/);
    assert.throws(() => validMeetingTime({ dow: '7', time: '10:30' }), /day of the week/);
    assert.throws(() => validMeetingTime({ dow: undefined, time: '10:30' }), /day of the week/);
  });

  test('the sentence the preview and the flash share', () => {
    assert.equal(
      timingSentence(sunday('10:30')),
      'the program hours to 9:30 AM–12:30 PM and the weekly notification to Sundays at 9:30 AM',
    );
  });

  const defaults = { program: DEFAULT_PROGRAM_SETTINGS, schedule: DEFAULT_SCHEDULE };
  const window = (start, end, dow = 0) => ({ dow, start, end });

  test('custom: anything the stored meeting time would not have set', () => {
    const meeting = { dow: 0, time: '10:30' };
    const sched = { dow: 0, time: '09:30' };
    assert.equal(timingStatus(meeting, window('09:30', '12:30'), sched, defaults), 'derived');
    assert.equal(timingStatus(meeting, window('09:00', '12:30'), sched, defaults), 'custom', 'the window moved');
    assert.equal(timingStatus(meeting, window('09:30', '12:30', 1), sched, defaults), 'custom', 'its day moved');
    assert.equal(timingStatus(meeting, window('09:30', '12:30'), { dow: 0, time: '08:00' }, defaults), 'custom', 'the send moved');
    // No meeting time yet: the shipped defaults are not "custom", anything else is.
    assert.equal(timingStatus(null, window('08:00', '14:00'), { dow: 0, time: '08:00' }, defaults), 'default');
    assert.equal(timingStatus(null, window('08:00', '13:00'), { dow: 0, time: '08:00' }, defaults), 'custom');
    assert.equal(timingStatus(null, window('08:00', '14:00'), { dow: 0, time: '07:00' }, defaults), 'custom');
  });

  test('saving writes the window and the schedule, keeps the wording and retention, and the closed message follows', async () => {
    await setProgramSettings({ ...DEFAULT_PROGRAM_SETTINGS, closedMessage: 'Ask a clerk', retentionDays: 30 });
    await saveMeetingTime({ dow: '0', time: '10:30' });
    const program = await getProgramSettings();
    assert.deepEqual(program, { dow: 0, start: '09:30', end: '12:30', closedMessage: 'Ask a clerk', retentionDays: 30 });
    assert.deepEqual(await getScheduleSettings(), { dow: 0, time: '09:30' });
    assert.deepEqual(await getMeetingTime(), { dow: 0, time: '10:30' });
    assert.equal(
      timingStatus(await getMeetingTime(), program, await getScheduleSettings(), defaults),
      'derived',
    );
    // The clerk's wording still wins; with it cleared, the automatic one names the new opening.
    assert.equal(closedProgramMessage(program, false), 'Ask a clerk');
    await setProgramSettings({ ...program, closedMessage: '' });
    assert.equal(
      closedProgramMessage(await getProgramSettings(), false),
      'The program will be here Sunday at 9:30 AM.',
    );
    // And the window checks themselves: 09:29 Denver shut, 09:30 open, 12:30 shut (MDT, UTC-6).
    const now = await getProgramSettings();
    assert.equal(programWindowOpen(new Date('2026-09-13T15:29:00Z'), now, TZ), false);
    assert.equal(programWindowOpen(new Date('2026-09-13T15:30:00Z'), now, TZ), true);
    assert.equal(programWindowOpen(new Date('2026-09-13T18:30:00Z'), now, TZ), false);
  });

  test('a refused time changes nothing', async () => {
    await assert.rejects(saveMeetingTime({ dow: '0', time: '23:00' }), /between/);
    assert.deepEqual(await getMeetingTime(), { dow: 0, time: '10:30' });
    assert.equal((await getProgramSettings()).start, '09:30');
  });

  test('an unreadable stored meeting time reads as none, not as a crash', async () => {
    await db.setSetting('meeting_time', 'not json');
    assert.equal(await getMeetingTime(), null);
    await db.setSetting('meeting_time', JSON.stringify({ dow: 9, time: '10:30' }));
    assert.equal(await getMeetingTime(), null);
    // Leave the window as the other suites expect it.
    await db.deleteSetting('meeting_time');
    await setProgramSettings(DEFAULT_PROGRAM_SETTINGS);
    await setScheduleSettings(DEFAULT_SCHEDULE);
  });
});

describe('a wall-clock time on a day the clocks change', () => {
  // Only a hand-set Advanced Timing time can fall in these hours; derived ones are 05:00 or later.
  const at = (date, time, tz) => {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return instantAt({ year, month, day, hour, minute }, tz).toISOString();
  };

  test('a time the clock skips lands the length of the gap later, as croner has it', () => {
    // Denver jumps 02:00 MST -> 03:00 MDT: 02:30 is read as MST, which is 03:30 MDT — not 01:30 MST.
    assert.equal(at('2026-03-08', '02:30', TZ), '2026-03-08T09:30:00.000Z');
    // East of Greenwich: 02:30 CET is 03:30 CEST.
    assert.equal(at('2026-03-29', '02:30', 'Europe/Berlin'), '2026-03-29T01:30:00.000Z');
  });

  test('a midnight jump keeps the slot on its own date, so a skipped Sunday stays skipped', () => {
    // Santiago jumps 00:00 -> 01:00 on Sunday 2026-09-06. 00:30 used to come out as 23:30 Saturday.
    const santiago = 'America/Santiago';
    const instant = instantAt({ year: 2026, month: 9, day: 6, hour: 0, minute: 30 }, santiago);
    assert.equal(instant.toISOString(), '2026-09-06T04:30:00.000Z', '01:30 -03');
    assert.equal(slotKey(instant, santiago), '2026-09-06T01:30', 'the skip list is keyed by its date');
    const saturday = new Date('2026-09-05T15:00:00Z');
    const sunday = { dow: 0, time: '00:30' };
    assert.equal(nextSlotAfter(saturday, sunday, santiago)?.toISOString(), '2026-09-06T04:30:00.000Z');
    // Skipping that Sunday steps to the next one — it used to send, the slot being dated the 5th.
    const next = nextSendingSlotAfter(saturday, sunday, ['2026-09-06'], santiago);
    assert.equal(next?.skipped, 1);
    assert.equal(slotKey(next.at, santiago), '2026-09-13T00:30');
  });

  test('a time the clock passes twice is the first pass, as croner has it', () => {
    // Denver falls back 02:00 MDT -> 01:00 MST: 01:30 MDT (07:30Z) comes before 01:30 MST (08:30Z).
    // The first is what croner on Node fires at, so both runtimes send at the same instant.
    assert.equal(at('2026-11-01', '01:30', TZ), '2026-11-01T07:30:00.000Z');
    assert.equal(at('2026-10-25', '02:30', 'Europe/Berlin'), '2026-10-25T00:30:00.000Z');
  });

  test('an ordinary day is unaffected', () => {
    assert.equal(at('2026-09-13', '08:00', TZ), '2026-09-13T14:00:00.000Z');
    assert.equal(at('2026-09-13', '08:00', 'Asia/Kolkata'), '2026-09-13T02:30:00.000Z');
  });
});
