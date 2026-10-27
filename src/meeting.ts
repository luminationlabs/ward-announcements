/**
 * When sacrament meeting starts — the one timing fact a clerk is asked for — and the two timings
 * that follow from it: the program's visibility window and the weekly notification.
 *
 * The meeting time is stored on its own (`meeting_time`, `{dow, time}` as JSON in `settings`), but
 * nothing reads it to decide anything. Saving it *writes* the derived window and schedule through
 * `setProgramSettings` and `setScheduleSettings`, so every consumer — `/api/program`, the cron tick,
 * a hosted ward's alarm, the closed-program message, the summary strip — keeps reading the settings
 * it always read. The stored meeting time is only for the dashboard: to show it, and to tell whether
 * the window or the schedule has since been changed by hand ("custom").
 *
 * Like the window and the schedule it is local wall-clock time in the ward's timezone, so changing
 * the timezone leaves all three where they are: the meeting is still at 10:30, now in the new zone.
 *
 * Runtime-free, like its two siblings.
 */
import { getSetting, setSetting } from './db.js';
import { getProgramSettings, setProgramSettings, type ProgramSettings } from './programs.js';
import {
  DOW_NAMES,
  clockLabel,
  getScheduleSettings,
  setScheduleSettings,
  type ScheduleSettings,
} from './schedule-core.js';

export interface MeetingTime {
  /** 0 = Sunday … 6 = Saturday. */
  dow: number;
  /** 'HH:MM' (24h), local to the ward. */
  time: string;
}

export interface DerivedTiming {
  window: { dow: number; start: string; end: string };
  schedule: ScheduleSettings;
}

export const MEETING_TIME_SETTING = 'meeting_time';

/** The program opens this long before the meeting starts, and the notification goes out then. */
export const PROGRAM_LEAD_MINUTES = 60;
/** ...and closes this long after it starts: a three-hour block with room to linger. */
export const PROGRAM_TAIL_MINUTES = 120;

/**
 * The meeting times the form accepts, inclusive. Wide enough for any real sacrament meeting (an
 * early ward, an evening branch), narrow enough that an AM/PM slip — 10:30 typed as 22:30, or 1:00
 * meaning afternoon typed as 01:00 — is refused rather than quietly hiding the program all day.
 */
export const EARLIEST_MEETING = '06:00';
export const LATEST_MEETING = '22:00';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The last minute a time input can name. The window's end is exclusive, so this is "until midnight". */
const LAST_MINUTE = 23 * 60 + 59;

const pad = (n: number) => String(n).padStart(2, '0');
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/**
 * The window and schedule a meeting time sets. Pure.
 *
 * Both are clamped to the meeting's own local day and never wrap past midnight: the window and the
 * schedule are each a single day of the week, so "an hour before a 00:30 meeting" cannot be
 * Saturday 23:30 — it is 00:00, and a window that would run past midnight stops at 23:59. The
 * validated range keeps the early clamp out of reach, but this answers for any time, including a
 * stored one edited by hand.
 */
export function deriveTiming(meeting: MeetingTime): DerivedTiming {
  const start = minutesOf(meeting.time);
  const open = Math.max(0, start - PROGRAM_LEAD_MINUTES);
  const close = Math.min(LAST_MINUTE, start + PROGRAM_TAIL_MINUTES);
  return {
    window: { dow: meeting.dow, start: hhmm(open), end: hhmm(close) },
    schedule: { dow: meeting.dow, time: hhmm(open) },
  };
}

/** Validate a meeting time from the form. Throws a message fit to show the admin. */
export function validMeetingTime(input: { dow: unknown; time: unknown }): MeetingTime {
  const dow = Number(input.dow);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new Error('Pick the day of the week.');
  const time = typeof input.time === 'string' ? input.time.trim() : '';
  if (!TIME_RE.test(time)) throw new Error('Enter the meeting time as HH:MM.');
  if (minutesOf(time) < minutesOf(EARLIEST_MEETING) || minutesOf(time) > minutesOf(LATEST_MEETING)) {
    throw new Error(
      `Sacrament meeting has to start between ${clockLabel(EARLIEST_MEETING)} and ${clockLabel(
        LATEST_MEETING,
      )}. Check AM and PM.`,
    );
  }
  return { dow, time };
}

/** The stored meeting time, or null when none has been saved (or the row is unreadable). */
export async function getMeetingTime(): Promise<MeetingTime | null> {
  const raw = await getSetting(MEETING_TIME_SETTING);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MeetingTime>;
    const dow = Number(parsed.dow);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    if (typeof parsed.time !== 'string' || !TIME_RE.test(parsed.time)) return null;
    return { dow, time: parsed.time };
  } catch {
    return null;
  }
}

/**
 * Where the window and schedule stand relative to the meeting time:
 * - `derived`: exactly what the stored meeting time sets;
 * - `default`: no meeting time yet, and both are still the shipped defaults;
 * - `custom`: anything else — changed under Advanced Timing, or set before there was a meeting time.
 *
 * Only the day and hours count: the closed-page wording and the retention clock are not timing,
 * and saving a meeting time leaves them alone.
 */
export type TimingStatus = 'derived' | 'default' | 'custom';

export function timingStatus(
  meeting: MeetingTime | null,
  program: Pick<ProgramSettings, 'dow' | 'start' | 'end'>,
  schedule: ScheduleSettings,
  defaults: { program: Pick<ProgramSettings, 'dow' | 'start' | 'end'>; schedule: ScheduleSettings },
): TimingStatus {
  const same = (
    w: Pick<ProgramSettings, 'dow' | 'start' | 'end'>,
    s: ScheduleSettings,
  ) =>
    program.dow === w.dow &&
    program.start === w.start &&
    program.end === w.end &&
    schedule.dow === s.dow &&
    schedule.time === s.time;
  if (meeting) {
    const d = deriveTiming(meeting);
    return same(d.window, d.schedule) ? 'derived' : 'custom';
  }
  return same(defaults.program, defaults.schedule) ? 'default' : 'custom';
}

/**
 * What saving sets, as the end of a sentence: "the program hours to 9:30 AM–12:30 PM and the weekly
 * notification to Sundays at 9:30 AM". The dashboard's live preview says the same words before the
 * save (its few lines of script mirror this), and the flash says them after — so the page reads
 * the same with script off.
 */
export function timingSentence(d: DerivedTiming): string {
  return `the program hours to ${clockLabel(d.window.start)}–${clockLabel(d.window.end)} and the weekly notification to ${
    DOW_NAMES[d.schedule.dow] ?? 'Sunday'
  }s at ${clockLabel(d.schedule.time)}`;
}

/**
 * Store the meeting time and write what it derives. Throws a message fit to show the admin.
 *
 * The window goes through `setProgramSettings`, keeping the clerk's closed-page wording and
 * retention. The schedule goes through `setScheduleSettings` — the very call the Day and Time form
 * makes, so `schedule_set_at` and the runtime hook (Node's croner rebuild) behave exactly as they do
 * there — but only when the day or time actually changes. Re-saving the same slot is not a move,
 * and stamping it as one would veto the catch-up for a send that is still owed (the same reason a
 * timezone fix is not a move; see `saveWardSettings`). A hosted ward's alarm needs nothing here: the
 * Durable Object re-derives it after every write request (`host.ts`).
 */
export async function saveMeetingTime(input: { dow: unknown; time: unknown }): Promise<DerivedTiming> {
  const meeting = validMeetingTime(input);
  const derived = deriveTiming(meeting);
  const program = await getProgramSettings();
  await setProgramSettings({
    ...derived.window,
    closedMessage: program.closedMessage,
    retentionDays: program.retentionDays,
  });
  const schedule = await getScheduleSettings();
  if (schedule.dow !== derived.schedule.dow || schedule.time !== derived.schedule.time) {
    await setScheduleSettings(derived.schedule);
  }
  await setSetting(MEETING_TIME_SETTING, JSON.stringify(meeting));
  return derived;
}
