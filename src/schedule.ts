/**
 * The Node scheduler: croner.
 *
 * Node-only by construction — it holds a live timer in the process. Everything that both runtimes
 * need (the settings, the message, and the arithmetic for "when is the next occurrence") lives in
 * `schedule-core.ts`; Workers has no croner job at all, just a per-minute trigger asking that same
 * arithmetic whether anything is due (see `worker.ts`).
 */
import { Cron } from 'croner';
import type { Logger } from './log.js';
import { config } from './config.js';
import { getSetting, isAutoSendEnabled, sendQueueReady, stalePendingBatch } from './db.js';
import type { FileStore } from './filestore.js';
import { maybePurgeOldPrograms } from './programs.js';
import { drainInProgress, drainSendQueueUntilEmpty, settleSend } from './push.js';
import { maybePurgeHistory } from './tick.js';
import {
  CATCHUP_GRACE_MS,
  getScheduleSettings,
  onScheduleChanged,
  previousSlotAtOrBefore,
  queueWeeklySend,
  seedScheduleDefaults,
  slotKey,
  uncoveredSlot,
  type ScheduleSettings,
} from './schedule-core.js';

let job: Cron | null = null;
let purgeJob: Cron | null = null;
let retryJob: Cron | null = null;
let logger: Logger | null = null;

function buildCron({ dow, time }: ScheduleSettings): string {
  const [h, m] = time.split(':').map(Number);
  return `${m} ${h} * * ${dow}`;
}

// ---------------------------------------------------------------------------
// The weekly send
// ---------------------------------------------------------------------------

/**
 * Run the weekly send now (respects the auto-send toggle). Also the cron callback.
 *
 * Enqueue, then drain to empty: to the caller it is one burst, because nothing returns until the
 * last subscriber has been attempted.
 */
export async function runWeeklySend(log: Logger, at: Date = new Date()): Promise<void> {
  const outcome = await queueWeeklySend(slotKey(at, config.timezone));
  if (outcome.status === 'disabled') {
    log.info('weekly send skipped (auto-send disabled)');
    return;
  }
  if (outcome.status === 'duplicate') {
    log.warn({ slot: slotKey(at, config.timezone) }, 'weekly send already queued for this slot');
    return;
  }
  if (outcome.status === 'skipped') {
    log.info(
      { slot: slotKey(at, config.timezone), reason: outcome.reason },
      'weekly send skipped',
    );
    return;
  }
  await drainSendQueueUntilEmpty();
  log.info({ sendLogId: outcome.sendLogId, total: outcome.total }, 'weekly scheduled push sent');
}

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

/** (Re)build the cron job from the current settings. */
export async function applySchedule(): Promise<Cron> {
  const settings = await getScheduleSettings();
  const cron = buildCron(settings);
  job?.stop();
  job = new Cron(cron, { timezone: config.timezone }, () => {
    if (!logger) return;
    // Key the send off the *occurrence*, not off the moment the callback happened to run. croner
    // fires late whenever the event loop is busy, and a callback that landed at 08:00:30 — or, on a
    // loaded process, at 08:01 — and built its slot key from `new Date()` could mint a second key
    // for the same Sunday. Two keys means the `UNIQUE` index on `send_batches.slot` stops guarding
    // anything, and the ward gets the digest twice. `previousSlotAtOrBefore` names the occurrence
    // the callback is *for*, however late it is.
    const now = new Date();
    const at = previousSlotAtOrBefore(now, settings, config.timezone) ?? now;
    runWeeklySend(logger, at).catch((err) => logger?.error(err, 'weekly send failed'));
  });
  logger?.info(
    { cron, timezone: config.timezone, nextRun: job.nextRun()?.toISOString() },
    'weekly scheduler (re)started',
  );
  return job;
}

/** Most recent scheduled occurrence at or before `now`, per the live (timezone-aware) cron. */
function previousOccurrence(cron: Cron, now: Date): Date | null {
  // Weekly schedule: starting 8 days back guarantees at least one occurrence in range.
  let cursor = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  let last: Date | null = null;
  for (let i = 0; i < 10; i++) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > now.getTime()) break;
    last = next;
    cursor = next;
  }
  return last;
}

/**
 * Best-effort recovery for a send missed while the process was down (e.g. a deploy near send time).
 * On startup, if the most recent scheduled occurrence was missed, send it once. Guarded against
 * false positives:
 *  - skip if the occurrence is older than the grace window (stale),
 *  - skip if we already sent at/after it (`last_sent_at`),
 *  - skip if the schedule was changed *after* it (`schedule_set_at`) — so moving the slot to
 *    earlier today and then restarting won't trigger an unwanted resend.
 *
 * The send itself carries the missed occurrence's slot key, so a catch-up can never duplicate a
 * send that already went out for it.
 */
async function catchUpMissedSend(log: Logger): Promise<void> {
  if (!job || !(await isAutoSendEnabled())) return;
  const now = new Date();
  const prev = previousOccurrence(job, now);
  if (!prev) return;

  if (now.getTime() - prev.getTime() > CATCHUP_GRACE_MS) return;

  const lastSentMs = Date.parse((await getSetting('last_sent_at')) ?? '');
  if (!Number.isNaN(lastSentMs) && lastSentMs >= prev.getTime()) return;

  const scheduleSetMs = Date.parse((await getSetting('schedule_set_at')) ?? '');
  if (!Number.isNaN(scheduleSetMs) && scheduleSetMs > prev.getTime()) return;

  log.warn(
    { missedAt: prev.toISOString() },
    'missed weekly send detected on startup — sending catch-up',
  );
  runWeeklySend(log, prev).catch((err) => log.error(err, 'catch-up send failed'));
}

export async function startScheduler(log: Logger): Promise<Cron> {
  logger = log;
  await seedScheduleDefaults();
  // Rebuild the timer whenever the admin saves a new schedule.
  onScheduleChanged(async () => {
    await applySchedule();
  });
  const j = await applySchedule();
  startRetryDrain(log);
  // Deliberately not awaited beyond its own decision step: as before, a catch-up send runs in the
  // background so boot isn't held open by a round of push deliveries.
  catchUpMissedSend(log).catch((err) => log.error(err, 'catch-up check failed'));
  return j;
}

/**
 * The Node stand-in for the Workers minute tick (`tick.ts`), less its housekeeping, which Node runs
 * from `startProgramPurge`. Three steps:
 *
 * 1. **A weekly send still owed.** The croner job gets one try at its occurrence, and boot one more
 *    (`catchUpMissedSend`); a send that failed to enqueue at 08:00 (a locked database, a full disk)
 *    would otherwise be lost for the week. `uncoveredSlot` is the Workers tick's own question, so the
 *    12-hour grace and the vetoes are the same, and the slot's `UNIQUE` key stops a second enqueue.
 * 2. **Retries.** A delivery that came back retryable sits behind `send_queue.not_before` for its
 *    backoff, and the drain that put it there returns without it; this drains once one is claimable.
 * 3. **A send left open.** A drain settles each send it empties, but a send can also empty without
 *    its drain: a 404/410 in one send deletes that subscription's rows from every other send, as does
 *    pruning, and a crash between the last commit and `settle()` leaves one too. Without this it would
 *    show "Sending" in Recent Sends forever. Only while no drain is running, since a running drain
 *    may be about to settle that send itself.
 *
 * Thirty seconds past each minute, so it never races the croner job's on-time send at :00 (a race
 * the slot key would win, but with a "duplicate" warning in the log every week). Cheap when idle: a
 * few reads against tables that are empty all week.
 */
function startRetryDrain(log: Logger): Cron {
  retryJob?.stop();
  retryJob = new Cron('30 * * * * *', { protect: true }, () =>
    runMinuteJob(log).catch((err) => log.error(err, 'the minute job failed')),
  );
  return retryJob;
}

/** One pass of the minute job above. Exported for the tests, which cannot wait for croner. */
export async function runMinuteJob(log: Logger, now: Date = new Date()): Promise<void> {
  const missed = await uncoveredSlot(now, await getScheduleSettings(), config.timezone);
  if (missed) {
    log.warn({ slot: missed.slot }, 'weekly send still owed — catching up');
    await runWeeklySend(log, missed.at);
  }
  if ((await sendQueueReady()) > 0) await drainSendQueueUntilEmpty();
  const stale = await stalePendingBatch();
  if (stale && !drainInProgress()) {
    log.warn({ sendLogId: stale.send_log_id }, 'settling a send whose queue emptied without it being closed out');
    await settleSend(stale.send_log_id);
  }
}

/**
 * The daily retention sweep for sacrament meeting programs.
 *
 * Boot alone is not enough. Purging only at startup assumes a ward redeploys far more often than the
 * retention window — true of a ward that is actively being worked on, and false of the one this is
 * built for. A process that stays up for six months would never purge, so the names on six months
 * of programs would stay in the database and their images in the store, both well past the
 * retention the admin set.
 *
 * 03:40 local, on the same `maybePurgeOldPrograms` once-a-day guard the Workers tick uses, so boot
 * and this job can't double-sweep. The minute is arbitrary but off the hour on purpose: nothing else
 * this deployment does should share a wake-up with it.
 */
export function startProgramPurge(files: FileStore, log: Logger): Cron {
  purgeJob?.stop();
  purgeJob = new Cron('40 3 * * *', { timezone: config.timezone }, () => {
    maybePurgeOldPrograms(files, log, undefined, undefined, { untilDone: true }).catch((err) =>
      log.error(err, 'the daily program retention sweep failed'),
    );
    // The send history and spent challenges, on the same clock (tick.ts runs both on Workers).
    maybePurgeHistory(log).catch((err) => log.error(err, 'the daily history sweep failed'));
  });
  log.info(
    { timezone: config.timezone, nextRun: purgeJob.nextRun()?.toISOString() },
    'program retention sweep scheduled',
  );
  return purgeJob;
}

/**
 * Deliver anything still queued from a previous run.
 *
 * A crash or redeploy mid-send leaves the remainder in `send_queue`, so the process picks it up
 * on its next boot.
 */
export async function drainPendingOnBoot(log: Logger): Promise<void> {
  try {
    await drainSendQueueUntilEmpty();
  } catch (err) {
    log.error(err, 'draining the leftover send queue failed');
  }
}
