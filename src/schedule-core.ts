/**
 * The weekly send, minus any opinion about what wakes it up.
 *
 * Node wakes it with croner (`schedule.ts`); Cloudflare Workers wakes it with a per-minute cron
 * trigger (`worker.ts`). Both need the same three things, and none of them may depend on croner:
 * the stored settings, the message, and — the part croner would otherwise own — the arithmetic
 * that says *when* the next occurrence is and whether one is due right now.
 *
 * Nothing here imports a Node built-in.
 */
import { config } from './config.js';
import { tenantLocal } from './tenant.js';
import {
  countPublicAnnouncements,
  getSendBatchBySlot,
  getSetting,
  getSettings,
  isAutoSendEnabled,
  recordSkippedSend,
  scheduledSendOnDate,
  setSetting,
  skipForDate,
} from './db.js';
import { queueSend } from './push.js';

/**
 * Where the weekly notification points.
 *
 * `#announcements`, not a bare `/`: the digest is *about* the announcements, and the Sunday 08:00
 * send lands squarely inside the default program window — a plain `/` would hand the member the
 * program tab under a body that says "tap to view the announcements". A scanned QR code still opens
 * on `/` and still gets the entry rule (public/app.js), which is the one place "open the program if
 * there is one" is the right answer.
 */
export const WEEKLY_URL = '/#announcements';

/**
 * The weekly notification's title when the admin hasn't written one.
 *
 * Deliberately **not** `config.appName`. Both iOS and Android already stamp the notification with
 * the installed app's own name, so setting the title to it too spends the one bold line the
 * notification has on saying the ward's name twice — and `APP_NAME` and `APP_SHORT_NAME` are
 * usually near-identical, which makes the repetition look like a bug rather than a choice. This
 * says what the notification is *about* instead, and it is install-independent for the same reason:
 * whatever the ward is called, the system has already put that on screen. An admin who wants
 * something else still sets it in the weekly message.
 */
export const DEFAULT_WEEKLY_TITLE = 'Ward Announcements';

export const DOW_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * 'HH:MM' (24-hour, as the schedule and the program window are stored and as the time input hands
 * it back) as a clock time a member of the bishopric would say out loud: "8:00 AM". Left alone if
 * it isn't a time — the settings are validated on the way in, but this is prose either way, not a
 * control. Here rather than in `views.ts` because the member-facing closed-program message
 * (`programs.ts`) says the same time the dashboard does, and must say it the same way.
 */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export interface ScheduleSettings {
  dow: number; // 0 = Sunday … 6 = Saturday
  time: string; // 'HH:MM' (24h), in config.timezone
}

/** Default weekly send when nothing has been set in the admin yet: Sundays at 08:00. */
export const DEFAULT_SCHEDULE: ScheduleSettings = { dow: 0, time: '08:00' };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getScheduleSettings(): Promise<ScheduleSettings> {
  // One query, not two: this runs on every Workers cron tick, where each read is a subrequest.
  const stored = await getSettings(['schedule_dow', 'schedule_time']);
  const dowRaw = stored.get('schedule_dow') ?? null;
  const time = stored.get('schedule_time') ?? null;
  const dow = dowRaw === null ? 0 : Number(dowRaw);
  return {
    dow: Number.isInteger(dow) && dow >= 0 && dow <= 6 ? dow : 0,
    time: time && TIME_RE.test(time) ? time : '08:00',
  };
}

/**
 * Something to run after the schedule changes. The Node entry registers a rebuild of its croner
 * job here; on Workers there is nothing to rebuild, because the cron trigger fires every minute
 * and the decision is made from the settings on each tick. Per ward (see tenant.ts), so a
 * multi-ward host can hang each ward's own reaction (re-deriving its alarm) here.
 */
const changeHook = tenantLocal(() => ({ fn: null as (() => Promise<void>) | null }));
export function onScheduleChanged(fn: (() => Promise<void>) | null): void {
  changeHook().fn = fn;
}

/** Validate and persist new schedule settings, then let the runtime react. */
export async function setScheduleSettings(input: {
  dow: number;
  time: string;
}): Promise<ScheduleSettings> {
  const dow = Number(input.dow);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new Error('Invalid day of week.');
  if (!TIME_RE.test(input.time)) throw new Error('Invalid time (use HH:MM).');
  // Re-saving the slot already in force is not a move: stamping it would veto the catch-up for a
  // send still owed (`uncoveredSlot`), so a Save clicked at 08:10 would cancel that Sunday's digest.
  const current = await getScheduleSettings();
  if (current.dow === dow && current.time === input.time) return current;
  await setSetting('schedule_dow', String(dow));
  await setSetting('schedule_time', input.time);
  await scheduleMoved();
  return { dow, time: input.time };
}

/**
 * The weekly slot has moved — a new day or time.
 * Records when, so a later restart's catch-up never fires for an occurrence that only looks
 * "missed" because the slot just moved to earlier today, then lets the runtime react.
 */
export async function scheduleMoved(): Promise<void> {
  await setSetting('schedule_set_at', new Date().toISOString());
  await changeHook().fn?.();
}

/**
 * Turn the automatic weekly send on or off.
 *
 * Switching it **on** also moves the catch-up floor (`schedule_set_at`) to now, as a schedule
 * change does. While it was off, a slot that passed was simply not sent — nothing recorded it — so
 * without this the next tick would see an uncovered slot inside the twelve-hour grace and send that
 * morning's digest in the afternoon: a ward that switched notifications off for Conference weekend
 * and back on at 15:00 would get the 08:00 digest at 15:00. Saving the form with it already on
 * leaves the floor alone, so a send genuinely missed (an outage) is still caught up.
 */
export async function setAutoSendEnabled(enabled: boolean): Promise<void> {
  const was = await isAutoSendEnabled();
  await setSetting('auto_send_enabled', enabled ? '1' : '0');
  if (enabled && !was) await setSetting('schedule_set_at', new Date().toISOString());
}

/**
 * The ward's timezone changed (`ward-settings.ts`): the slot keeps its local day and time, so only
 * the runtime needs telling (Node rebuilds its croner job in the new zone). Unlike `scheduleMoved`,
 * no `schedule_set_at` bump — see `saveWardSettings` for why that would lose a Sunday.
 */
export async function scheduleRezoned(): Promise<void> {
  await changeHook().fn?.();
}

/** Seed schedule settings on first run from the hardcoded default. */
export async function seedScheduleDefaults(): Promise<void> {
  // One query: this is on the Workers cold-start path, which every cron tick may pay.
  const stored = await getSettings(['schedule_dow', 'schedule_time']);
  if (stored.get('schedule_dow') != null && stored.get('schedule_time') != null) return;
  await setSetting('schedule_dow', String(DEFAULT_SCHEDULE.dow));
  await setSetting('schedule_time', DEFAULT_SCHEDULE.time);
  // Floor for the missed-send catch-up: nothing before the very first boot counts as "missed".
  await setSetting('schedule_set_at', new Date().toISOString());
}

/** Admin-customised weekly message overrides (empty strings when unset → defaults apply). */
export async function getWeeklyMessageSettings(): Promise<{ title: string; body: string }> {
  return {
    title: (await getSetting('weekly_title')) ?? '',
    body: (await getSetting('weekly_body')) ?? '',
  };
}

/** Persist the weekly message overrides (trimmed + length-capped; blank clears the override). */
export async function setWeeklyMessageSettings(input: {
  title: string;
  body: string;
}): Promise<void> {
  await setSetting('weekly_title', input.title.trim().slice(0, 80));
  await setSetting('weekly_body', input.body.trim().slice(0, 300));
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** Default count-based body used when the admin hasn't set a custom one. */
export function defaultWeeklyBody(n: number): string {
  return n > 0
    ? `There ${n === 1 ? 'is' : 'are'} ${n} current announcement${n === 1 ? '' : 's'} — tap to view.`
    : 'Tap to view the announcements.';
}

export async function weeklyMessage(): Promise<{
  title: string;
  body: string;
  url: string;
  /** Current public announcements. `queueWeeklySend` skips the send entirely when this is 0. */
  count: number;
}> {
  const n = await countPublicAnnouncements();
  const custom = await getWeeklyMessageSettings();
  // {count} → the live announcement count, so a custom message can stay dynamic.
  const fill = (s: string) => s.replace(/\{count\}/g, String(n));
  return {
    title: custom.title ? fill(custom.title) : DEFAULT_WEEKLY_TITLE,
    body: custom.body ? fill(custom.body) : defaultWeeklyBody(n),
    url: WEEKLY_URL,
    count: n,
  };
}

// ---------------------------------------------------------------------------
// When does it run? (pure, timezone-aware, croner-free)
// ---------------------------------------------------------------------------

export interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Wall-clock reading of an instant in `tz`. `h23` so midnight is 00, never 24.
 *
 * Exported because the sacrament-meeting program window (`programs.ts`) has to answer the same
 * question this file's cron arithmetic does — "what day and time is it *there* right now" — and a
 * second implementation of it is a second thing to get wrong at a DST boundary.
 */
export function wallClock(instant: Date, tz: string): Wall {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's offset from UTC at a given instant, in ms (positive east of Greenwich). */
function offsetMs(instant: Date, tz: string): number {
  const w = wallClock(instant, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - instant.getTime();
}

/**
 * The instant at which a wall-clock time occurs in `tz`.
 *
 * Tried with the zone's offset a day either side of it — a transition between them is the only
 * way the answer can be in doubt. When the clock skips the time (spring forward: 02:30 in Denver
 * on the second Sunday of March), it is read with the offset from before the jump, so it lands
 * the length of the gap later (03:30 MDT); when the clock passes it twice (fall back), the first
 * pass wins. That is croner's choice, and Temporal's "compatible", so a slot means the same instant
 * on Node (croner) as on Workers (this function).
 *
 * The rule replaced a two-step iteration that oscillated inside a gap and settled on the instant
 * *before* it: 01:30 MST for a 02:30 slot, an hour early and an hour off croner; and in Santiago,
 * whose clocks jump at midnight, 00:30 Sunday came out as 23:30 on the Saturday — so a Sunday the
 * ward had marked skipped was looked up under the wrong date and sent anyway. Only hand-set
 * Advanced Timing times reach a gap; derived ones are 05:00 or later.
 */
export function instantAt(w: Omit<Wall, 'second'>, tz: string): Date {
  const target = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const day = 24 * 60 * 60 * 1000;
  const before = target - offsetMs(new Date(target - day), tz);
  const after = target - offsetMs(new Date(target + day), tz);
  const lands = (ts: number) => {
    const c = wallClock(new Date(ts), tz);
    return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute) === target;
  };
  // Both land in a fall-back hour: the earlier instant is the first pass. Neither lands in a gap:
  // the pre-transition offset is `before`.
  if (lands(before) && lands(after)) return new Date(Math.min(before, after));
  if (lands(after)) return new Date(after);
  return new Date(before);
}

/** Day of week (0 = Sunday) of a *calendar date*, independent of any timezone. */
export function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The local calendar date `offset` days from the one containing `instant`. */
function shiftDate(instant: Date, tz: string, offset: number): { year: number; month: number; day: number } {
  const w = wallClock(instant, tz);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + offset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * The next occurrence strictly after `now`. Used rather than croner's `nextRun()` for the
 * dashboard, which has to show the same answer on a runtime that has no croner job at all.
 */
export function nextSlotAfter(
  now: Date,
  settings: ScheduleSettings,
  tz: string = config.timezone,
): Date | null {
  const [hour, minute] = settings.time.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const date = shiftDate(now, tz, i);
    if (dayOfWeek(date.year, date.month, date.day) !== settings.dow) continue;
    const at = instantAt({ ...date, hour: hour!, minute: minute! }, tz);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/**
 * The next occurrence after `now` that will actually send — `nextSlotAfter` stepped past every
 * date in `skipDates` (`YYYY-MM-DD`, local). For the dashboard's "Next send" line, which would
 * otherwise name a Sunday the card beneath it says is skipped.
 *
 * `skipped` is how many occurrences were stepped over, so the label can say so. Bounded at a year
 * of occurrences: a ward that has skipped every week for a year has not scheduled anything.
 */
export function nextSendingSlotAfter(
  now: Date,
  settings: ScheduleSettings,
  skipDates: Iterable<string>,
  tz: string = config.timezone,
): { at: Date; skipped: number } | null {
  const skips = new Set(skipDates);
  let cursor = now;
  for (let skipped = 0; skipped <= 53; skipped++) {
    const at = nextSlotAfter(cursor, settings, tz);
    if (!at) return null;
    if (!skips.has(dateOfSlot(slotKey(at, tz)))) return { at, skipped };
    cursor = at;
  }
  return null;
}

/** The most recent occurrence at or before `now`. */
export function previousSlotAtOrBefore(
  now: Date,
  settings: ScheduleSettings,
  tz: string = config.timezone,
): Date | null {
  const [hour, minute] = settings.time.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const date = shiftDate(now, tz, -i);
    if (dayOfWeek(date.year, date.month, date.day) !== settings.dow) continue;
    const at = instantAt({ ...date, hour: hour!, minute: minute! }, tz);
    if (at.getTime() <= now.getTime()) return at;
  }
  return null;
}

/**
 * A stable name for one occurrence — its local wall-clock time, `YYYY-MM-DDTHH:MM`. Stored on the
 * send so a second cron tick for the same minute can see the send already happened.
 */
export function slotKey(instant: Date, tz: string = config.timezone): string {
  const w = wallClock(instant, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * Beyond this, a missed weekly send is too stale to deliver as "this week's" digest.
 *
 * The same window Node's boot catch-up and the Workers tick use — see `uncoveredSlot` for why a
 * window of a few minutes is not enough.
 */
export const CATCHUP_GRACE_MS = 12 * 60 * 60 * 1000;

/**
 * The most recent scheduled occurrence that has **no send recorded against it**, or null.
 *
 * This, rather than "is an occurrence due right now?", is the Workers tick's question, and the
 * difference is the whole point. A check that is true only for the few minutes after an occurrence,
 * asked *after* short-circuiting on a non-empty queue, would skip the Sunday digest entirely,
 * silently, for a week on any of these:
 *
 * - a ward big enough that draining the previous send still has rows queued ten minutes later,
 * - a manual send an admin fired just after the hour,
 * - Cloudflare delaying or dropping the ticks that fall inside the window.
 *
 * Asking about *coverage* instead makes the check idempotent and time-tolerant: a slot stays
 * uncovered until a `send_batches` row names it, so any tick in the following twelve hours will
 * pick it up, and the `UNIQUE` index on `send_batches.slot` means enqueueing twice is harmless
 * even when two ticks overlap.
 *
 * The three guards match Node's `catchUpMissedSend` exactly, so both runtimes decide the same way:
 * auto-send has to be on, the occurrence has to be inside the catch-up grace, and the schedule must
 * not have been changed *after* the occurrence (moving the slot to earlier today and then restarting
 * must not fire an unwanted send).
 */
export async function uncoveredSlot(
  now: Date,
  settings: ScheduleSettings,
  tz: string = config.timezone,
): Promise<{ at: Date; slot: string } | null> {
  const previous = previousSlotAtOrBefore(now, settings, tz);
  if (!previous) return null;
  if (now.getTime() - previous.getTime() > CATCHUP_GRACE_MS) return null;
  if (!(await isAutoSendEnabled())) return null;

  const scheduleSetMs = Date.parse((await getSetting('schedule_set_at')) ?? '');
  if (!Number.isNaN(scheduleSetMs) && scheduleSetMs > previous.getTime()) return null;

  const slot = slotKey(previous, tz);
  // Covered by a send **or by a skip**: `recordSkippedSend` writes a `send_batches` row against the
  // slot precisely so this one check answers for both, and a deliberate silence is as settled a
  // decision as a delivery.
  if (await getSendBatchBySlot(slot)) return null;
  // Or by this week's digest having gone out already at another time (see `queueWeeklySend`).
  if (await scheduledSendOnDate(dateOfSlot(slot))) return null;
  return { at: previous, slot };
}

// ---------------------------------------------------------------------------
// Starting a weekly send
// ---------------------------------------------------------------------------

export type WeeklySendOutcome =
  | { status: 'disabled' }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }
  | { status: 'queued'; sendLogId: number; total: number };

/** The local date an occurrence falls on, from its slot key (`YYYY-MM-DDTHH:MM`). */
function dateOfSlot(slot: string): string {
  return slot.slice(0, 10);
}

/**
 * Queue the weekly digest (respecting the auto-send toggle). Nothing is delivered here — the caller
 * drains the queue, in a loop on Node and a chunk per cron tick on Workers.
 *
 * `slot` is the occurrence being covered; passing it makes the enqueue idempotent for that minute.
 */
export async function queueWeeklySend(slot: string | null): Promise<WeeklySendOutcome> {
  if (!(await isAutoSendEnabled())) return { status: 'disabled' };

  // Decided already — a send or a skip has this occurrence. Checked before anything else is read,
  // so a second cron tick costs one query and cannot reopen a settled question.
  if (slot && (await getSendBatchBySlot(slot))) return { status: 'duplicate' };
  // Sent already today, at another time. A slot key includes the time, so moving the schedule later
  // on the day — the 08:00 digest goes out, and at 08:30 the clerk corrects the meeting time, which
  // moves the slot to 10:00 — names a slot nothing covers, and everyone would get the digest twice.
  // One digest per local date, then. A skip earlier that day ("no current announcements") doesn't
  // count: a later slot that finds something to say should still say it.
  if (slot && (await scheduledSendOnDate(dateOfSlot(slot)))) return { status: 'duplicate' };

  // A Sunday the ward chose to stay quiet on: General Conference, a stake conference. Ahead of the
  // emptiness check because it outranks it — this one is a decision somebody made, and it should
  // read as their reason in the history rather than as "no current announcements".
  if (slot) {
    const skip = await skipForDate(dateOfSlot(slot));
    if (skip) {
      const reason = skip.note?.trim() || 'Skipped for this Sunday';
      await recordSkippedSend({ slot, reason, url: WEEKLY_URL });
      return { status: 'skipped', reason };
    }
  }

  const message = await weeklyMessage();
  // Nothing posted, nothing to say. A digest reading "Tap to view the announcements" that opens an
  // empty list is worse than silence — and it is the one push a member could reasonably call spam,
  // on an app whose whole pitch is roughly one notification a week.
  if (message.count === 0) {
    const reason = 'No current announcements';
    if (slot) await recordSkippedSend({ slot, reason, url: message.url });
    return { status: 'skipped', reason };
  }
  const started = await queueSend(message, { type: 'scheduled', slot });
  if (!started) return { status: 'duplicate' };
  // Same field the manual send writes: it is what stops the Node startup catch-up from re-sending
  // a slot that has just been covered.
  await setSetting('last_sent_at', new Date().toISOString());
  return { status: 'queued', ...started };
}
