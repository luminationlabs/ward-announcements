/**
 * Sacrament meeting programs: when one is visible, and when an old one goes away.
 *
 * The sibling of `schedule-core.ts`, and runtime-free for the same reason — Node and Workers both
 * need these answers and neither may reach for croner or a Node built-in to get them. It borrows
 * that file's `wallClock`/`dayOfWeek` rather than re-deriving local time, because a second
 * implementation of "what day is it in America/Denver" is a second thing to get wrong twice a year.
 *
 * The visibility rule is a *time window*, not a column: a program is written for one local date and
 * shown only on that date, between two local times, on the configured day of the week. Nothing is
 * published or unpublished, so an admin can write next Sunday's program on Thursday without it
 * leaking. Enforcement lives on the server (`/api/program` in `app.ts`) — hiding a tab would leave
 * the names one `curl` away.
 */
import { config } from './config.js';
import {
  getSetting,
  getSettings,
  programsBefore,
  deleteProgram,
  pruneSkipsBefore,
  purgeExpiredAccessTokens,
  setSetting,
  type ProgramRow,
} from './db.js';
import { purgeAttachments, purgeStalePendingAttachments } from './attachments.js';
import { DOW_NAMES, clockLabel, dayOfWeek, instantAt, wallClock } from './schedule-core.js';
import type { FileStore } from './filestore.js';
import type { Logger } from './log.js';

/** The owner type programs use in the shared `attachments` table. */
export const PROGRAM_OWNER = 'program';

export interface ProgramSettings {
  /** 0 = Sunday … 6 = Saturday. The day a program is shown on. */
  dow: number;
  /** 'HH:MM' local, inclusive. */
  start: string;
  /** 'HH:MM' local, exclusive. */
  end: string;
  /**
   * The clerk's own wording for the Program tab when there is nothing to show, or '' for the
   * automatic one (`closedProgramMessage`), which names the day and time the window opens.
   */
  closedMessage: string;
  /** Programs older than this many days are purged, measured from `program_date`. */
  retentionDays: number;
}

export const DEFAULT_PROGRAM_SETTINGS: ProgramSettings = {
  dow: 0,
  start: '08:00',
  end: '14:00',
  closedMessage: '',
  retentionDays: 90,
};

/**
 * The fixed default this setting shipped with, before the automatic message existed. The settings
 * form was prefilled with it, so a ward that saved its hours without touching the message has it
 * stored verbatim — that is not a clerk's choice of words, and it said "Sundays" whatever day the
 * window was moved to. Read back as '' (automatic), so those wards get the right day for free.
 */
const LEGACY_DEFAULT_CLOSED_MESSAGE =
  'The sacrament meeting program is available on Sundays around meeting time. Check back then!';

/** Same shape `schedule-core` validates `schedule_time` against — one spelling of a time of day. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_CLOSED_MESSAGE = 300;
export const MAX_RETENTION_DAYS = 3650;

/**
 * Slack in the dashboard's program list, over and above one row per week of retention: for programs
 * prepared ahead of today, and for a week that ends up with a second row against it (a stake
 * conference Saturday, a funeral) — neither of which the retention arithmetic can see.
 */
const PROGRAM_LIST_HEADROOM = 8;

/**
 * Hard ceiling on the dashboard's program list.
 *
 * Sized to the longest retention the app will accept, so against a validated setting it **cannot**
 * bind — which is the point. A ceiling below that would strand the oldest programs, as any fixed
 * list length does, just further out and harder to notice. It stays as a guard on the
 * arithmetic rather than on the policy, and it moves by itself if `MAX_RETENTION_DAYS` ever does.
 */
export const MAX_DASHBOARD_PROGRAMS =
  Math.ceil(MAX_RETENTION_DAYS / 7) + PROGRAM_LIST_HEADROOM;

/**
 * How many programs the dashboard asks for.
 *
 * Derived from the retention setting rather than fixed, because the two are otherwise in a quiet
 * race: a program the dashboard does not list cannot be edited or deleted from anywhere in the app,
 * and retention is a 1–3650 day number an admin can change from that same card. A fixed cap only
 * chooses which retention values lose — at the 90-day default the list would be one row short, and
 * at "keep a year for the ward history" it would hide forty.
 *
 * Asking for a whole decade of Sundays is affordable only because the query behind this is a
 * projection: `listRecentPrograms` selects the date and the id, never `body_md`, so a row costs
 * tens of bytes rather than a whole program's text (see `ProgramListRow`).
 */
export function dashboardProgramLimit(retentionDays: number): number {
  return Math.min(MAX_DASHBOARD_PROGRAMS, Math.ceil(retentionDays / 7) + PROGRAM_LIST_HEADROOM);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function validTime(value: string | null, fallback: string): string {
  return value && TIME_RE.test(value) ? value : fallback;
}

/**
 * The stored window, with every field falling back to its default.
 *
 * Read rather than seeded: an unset key means "the default", so a deployment that has never opened
 * the settings form behaves identically to one that saved the defaults explicitly. That also means
 * there is no first-run seed to get wrong, and no migration when a default changes.
 *
 * All five keys in **one** query. This is called on the public page's `/api/program` and again on
 * every Workers cron tick, and five sequential settings reads is five subrequests out of fifty for
 * something one `IN` clause answers.
 */
export async function getProgramSettings(): Promise<ProgramSettings> {
  const stored = await getSettings([
    'program_window_dow',
    'program_window_start',
    'program_window_end',
    'program_closed_message',
    'program_retention_days',
  ]);
  const read = (key: string) => stored.get(key) ?? null;

  const dowRaw = read('program_window_dow');
  const dow = dowRaw === null ? DEFAULT_PROGRAM_SETTINGS.dow : Number(dowRaw);
  const retentionRaw = read('program_retention_days');
  const retention =
    retentionRaw === null ? DEFAULT_PROGRAM_SETTINGS.retentionDays : Number(retentionRaw);
  const message = read('program_closed_message');
  return {
    dow: Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : DEFAULT_PROGRAM_SETTINGS.dow,
    start: validTime(read('program_window_start'), DEFAULT_PROGRAM_SETTINGS.start),
    end: validTime(read('program_window_end'), DEFAULT_PROGRAM_SETTINGS.end),
    // Unset, saved empty, or the old fixed default: all mean "the automatic message".
    closedMessage:
      message === null || message.trim() === LEGACY_DEFAULT_CLOSED_MESSAGE ? '' : message,
    retentionDays:
      Number.isInteger(retention) && retention >= 1 && retention <= MAX_RETENTION_DAYS
        ? retention
        : DEFAULT_PROGRAM_SETTINGS.retentionDays,
  };
}

/** Validate and persist the window. Throws a message fit to show the admin. */
export async function setProgramSettings(input: {
  dow: number;
  start: string;
  end: string;
  closedMessage: string;
  retentionDays: number;
}): Promise<ProgramSettings> {
  const dow = Number(input.dow);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new Error('Pick a day of the week.');
  if (!TIME_RE.test(input.start) || !TIME_RE.test(input.end)) {
    throw new Error('Enter the window times as HH:MM.');
  }
  // Equal or inverted would mean "never open", which is indistinguishable from a typo — and a typo
  // here silently hides every program.
  if (minutesOf(input.start) >= minutesOf(input.end)) {
    throw new Error('The window has to end after it starts.');
  }
  const retentionDays = Number(input.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
    throw new Error(`Keep programs for between 1 and ${MAX_RETENTION_DAYS} days.`);
  }
  const closedMessage = input.closedMessage.trim().slice(0, MAX_CLOSED_MESSAGE);
  await setSetting('program_window_dow', String(dow));
  await setSetting('program_window_start', input.start);
  await setSetting('program_window_end', input.end);
  await setSetting('program_closed_message', closedMessage);
  await setSetting('program_retention_days', String(retentionDays));
  return { dow, start: input.start, end: input.end, closedMessage, retentionDays };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/** 'HH:MM' as minutes past local midnight. */
function minutesOf(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar date of an instant, 'YYYY-MM-DD'. */
export function localDate(now: Date, tz: string = config.timezone): string {
  const w = wallClock(now, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/**
 * Is the program window open right now?
 *
 * Pure, and deliberately independent of whether a program actually exists for today — the caller
 * pairs the two, because "the window is shut" and "nobody wrote one" are the same thing to a member
 * (both show the closed message), and to everyone else too — the dashboard's preview is the
 * only early look.
 *
 * The end time is exclusive so that a window ending at 14:00 is shut at 14:00 exactly, which is
 * what "08:00 to 14:00" reads as.
 */
export function programWindowOpen(
  now: Date,
  settings: ProgramSettings,
  tz: string = config.timezone,
): boolean {
  const w = wallClock(now, tz);
  if (dayOfWeek(w.year, w.month, w.day) !== settings.dow) return false;
  const minutes = w.hour * 60 + w.minute;
  return minutes >= minutesOf(settings.start) && minutes < minutesOf(settings.end);
}

/**
 * When the window that is open at `now` closes, as epoch milliseconds; null when it is not open.
 *
 * For the service worker, which keeps a copy of the open program so it can be read on a chapel's
 * failing wifi: told when the window ends, it can refuse to hand out the names offline on Wednesday.
 * The end time on today's date, converted back to an instant — not wall-clock minutes counted
 * forward from now, which came out an hour wrong when the clocks changed inside the window (a
 * 00:00–14:00 window on a spring-forward Sunday closed at 15:00).
 */
export function programWindowClosesAt(
  now: Date,
  settings: ProgramSettings,
  tz: string = config.timezone,
): number | null {
  if (!programWindowOpen(now, settings, tz)) return null;
  const w = wallClock(now, tz);
  const [hour, minute] = settings.end.split(':').map(Number);
  return instantAt({ year: w.year, month: w.month, day: w.day, hour: hour!, minute: minute! }, tz).getTime();
}

/**
 * What the Program tab says when there is no program to show, unless the clerk wrote their own.
 *
 * Outside the window it says when the window next opens — "The program will be here Sunday at
 * 8:00 AM." — the day of week and the start time, no date (the owner's call: a date invites "which
 * Sunday?" arithmetic, and the next one is what everybody means). Inside the window that sentence
 * would be false on its face, so it says the plain fact instead.
 *
 * A function of the settings and of whether the window is open, and of **nothing else**: never of
 * whether a program exists. That is what keeps the closed replies outside the window byte-identical
 * with and without a program (see `/api/program`). Inside the window a program's existence is no
 * secret — it is on the screen of everybody in the chapel — so the second sentence gives nothing away.
 */
export function automaticClosedMessage(settings: ProgramSettings, windowOpen: boolean): string {
  if (windowOpen) return "Today's program hasn't been posted.";
  return `The program will be here ${DOW_NAMES[settings.dow] ?? 'Sunday'} at ${clockLabel(settings.start)}.`;
}

/** The clerk's message when they wrote one, else the automatic one. */
export function closedProgramMessage(settings: ProgramSettings, windowOpen: boolean): string {
  const custom = settings.closedMessage.trim();
  return custom || automaticClosedMessage(settings, windowOpen);
}

/**
 * The date a new program should default to: today if today is the program day, else the next one.
 *
 * "Today counts" is the case that matters — an admin fixing a typo at 09:00 on Sunday wants this
 * Sunday, not next.
 */
export function nextProgramDate(
  now: Date,
  settings: ProgramSettings,
  tz: string = config.timezone,
): string {
  const w = wallClock(now, tz);
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(w.year, w.month - 1, w.day + i));
    if (d.getUTCDay() === settings.dow) {
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
  }
  return localDate(now, tz);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * What one purge run may spend, as **two** caps.
 *
 * Programs accumulate at one a week, so the steady state is a single purge per week and neither cap
 * is reached. They exist for the other case — a deployment that sat idle, or a retention window an
 * admin just shortened — where deleting everything at once would blow the Workers per-invocation
 * budget of 50 subrequests. Which cap binds depends on the backlog, and capping *programs* alone is
 * not enough: an image-heavy backlog is a burst of storage deletes (one per image, up to ten per
 * program) that three programs alone does not bound, while a text-only backlog costs three queries
 * per program however few images there are.
 *
 * So: stop after `MAX_PROGRAMS_PER_PURGE` programs *or* once `MAX_OBJECT_DELETES_PER_PURGE` stored
 * objects have been deleted, whichever comes first. The object cap can only be checked *after* a
 * program is finished (stopping mid-program would leave a row whose images are already gone), so the
 * program cap has to be low enough that the last program's images still fit: three programs with an
 * image each (12) plus a fourth with the per-owner maximum of ten (13) is 25 subrequests, which
 * leaves the rest of the tick comfortable inside the fifty. The next run takes the next batch — a
 * year of backlog still clears in a fortnight of daily sweeps.
 */
export const MAX_PROGRAMS_PER_PURGE = 4;
export const MAX_OBJECT_DELETES_PER_PURGE = 10;

/** The oldest program date retention keeps (`YYYY-MM-DD`): anything dated before it has expired. */
async function retentionCutoff(now: Date, tz: string): Promise<string> {
  const settings = await getProgramSettings();
  const w = wallClock(now, tz);
  const cutoffDate = new Date(Date.UTC(w.year, w.month - 1, w.day - settings.retentionDays));
  return `${cutoffDate.getUTCFullYear()}-${pad(cutoffDate.getUTCMonth() + 1)}-${pad(cutoffDate.getUTCDate())}`;
}

/**
 * Delete programs whose date is older than the retention window, images and all.
 *
 * Measured from `program_date` rather than `created_at`: retention is about how long a *meeting*
 * stays readable, and a program written a week early would otherwise outlive its own Sunday by a
 * week. Returns the rows it removed, so a caller can log or test what happened.
 */
export async function purgeOldPrograms(
  files: FileStore,
  log: Logger,
  now: Date = new Date(),
  tz: string = config.timezone,
): Promise<ProgramRow[]> {
  const cutoff = await retentionCutoff(now, tz);
  const stale = await programsBefore(cutoff, MAX_PROGRAMS_PER_PURGE);
  const purged: ProgramRow[] = [];
  let objectDeletes = 0;
  for (const program of stale) {
    // Images first, for the same reason the admin delete route does it in this order: the row is
    // what makes an object reachable, so a failure part-way leaves a 404 rather than an orphan.
    objectDeletes += await purgeAttachments(files, log, PROGRAM_OWNER, program.id);
    await deleteProgram(program.id);
    purged.push(program);
    log.info({ programDate: program.program_date, cutoff }, 'purged an expired program');
    // Checked *after* finishing a program, never mid-way: a program whose images went but whose row
    // stayed would be re-listed next run and its (already deleted) images retried forever.
    if (objectDeletes >= MAX_OBJECT_DELETES_PER_PURGE) break;
  }
  return purged;
}

/**
 * The periodic hook: purge at most once per local day.
 *
 * Workers calls this from the per-minute cron tick, so the common path has to be cheap — it is one
 * settings read that finds today's date already recorded and returns. Node calls it at boot and
 * again from a daily croner job (`schedule.ts`), where the same guard keeps a restart loop from
 * re-running the sweep.
 *
 * The marker is written *before* the work, so a sweep in progress is never started a second time by
 * the next minute's tick — but it is **cleared again if the sweep throws**. Leaving it in place
 * might seem kinder to a failing storage delete, which shouldn't be retried every minute for a day,
 * but `purgeOldPrograms` already swallows per-object storage failures itself. A throw that reaches
 * here is a *database* failure, and leaving the marker would let one bad moment stall retention
 * until tomorrow. Retrying next tick is the honest behaviour, and the work
 * is capped either way.
 */
/**
 * How long a spent skip is kept before it is deleted.
 *
 * A skip must outlive the window in which its occurrence can still be reconsidered. Both runtimes
 * will pick up a missed send for `CATCHUP_GRACE_MS` — twelve hours — after it was due, so a skip
 * deleted the same day could let a restart that afternoon deliver the digest the skip existed to
 * suppress. Two days is that window with a day of margin, and it means an admin never has to know
 * any of this: a date that has passed leaves the dashboard list immediately (it only shows today
 * onward) and its row disappears on its own a couple of days later.
 */
const SKIP_RETENTION_DAYS = 2;

/** Delete skips whose Sunday is far enough past that nothing can act on them again. */
export async function pruneSpentSkips(
  now: Date = new Date(),
  tz: string = config.timezone,
): Promise<void> {
  const cutoff = new Date(now.getTime() - SKIP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await pruneSkipsBefore(localDate(cutoff, tz));
}

export async function maybePurgeOldPrograms(
  files: FileStore,
  log: Logger,
  now: Date = new Date(),
  tz: string = config.timezone,
  { untilDone = false }: { untilDone?: boolean } = {},
): Promise<void> {
  try {
    const today = localDate(now, tz);
    if ((await getSetting('program_purge_last_run')) === today) return;
    await setSetting('program_purge_last_run', today);
    await pruneSpentSkips(now, tz);
    // On the daily clock as well as at boot: a Node process that stays up for months never boots.
    await purgeExpiredAccessTokens();
    // The per-run caps are the free-plan Worker's subrequest budget (see MAX_PROGRAMS_PER_PURGE).
    // Where there is no such budget — Node, a ward on the host — keep going until nothing is left;
    // otherwise an admin shortening retention from years to 90 days left the expired programs,
    // names and all, readable in the dashboard and in backups for months at four a day. Where the
    // budget binds, a full batch clears the day's marker instead, so the next tick, a minute later,
    // takes the next batch.
    let backlog = false;
    for (let rounds = 0; ; rounds++) {
      const purged = await purgeOldPrograms(files, log, now, tz);
      if (purged.length === 0) break;
      // A batch that took everything is the usual case; only a cap leaves programs behind.
      if ((await programsBefore(await retentionCutoff(now, tz), 1)).length === 0) break;
      if (!untilDone || rounds >= 1000) {
        backlog = true;
        break;
      }
    }
    // Images uploaded to a New announcement, page or program that was never saved.
    await purgeStalePendingAttachments(files, log);
    if (backlog) await setSetting('program_purge_last_run', '');
  } catch (err) {
    log.error(err, 'purging expired programs failed — clearing the daily marker so it retries');
    // Best effort: if *this* write fails too the database is unreachable, and the next tick will
    // find that out for itself.
    await setSetting('program_purge_last_run', '').catch(() => {});
  }
}

/**
 * A complete sample program for "Start from an example" on the New program page: the usual order
 * of a sacrament meeting, in the shape the editor uses (rows, a
 * hymn's title as a note under it, centered section headings), with
 * "(name)" wherever a clerk fills something in. It opens in the visual editor and round-trips
 * through it byte for byte (test/editor-roundtrip.test.js).
 */
export const EXAMPLE_PROGRAM = `Presiding ... (name)
Conducting ... (name)
Organist ... (name)
Chorister ... (name)


## -> Welcome and Announcements <-


Opening Hymn ... #2
... "The Spirit of God"
Invocation ... (name)


## -> Ward and Stake Business <-


Sacrament Hymn ... #169
... "As Now We Take the Sacrament"


## -> Administration of the Sacrament <-


Speaker ... (name)
Speaker ... (name)
Intermediate Hymn ... #3
... "Now Let Us Rejoice"
Speaker ... (name)


Closing Hymn ... #85
... "How Firm a Foundation"
Benediction ... (name)`;
