/**
 * The scheduled work a deployment does on its own: the weekly digest, finishing sends, settling a
 * send left open, and the daily housekeeping. Shared by the two Workers entries — the single-ward
 * `worker.ts` runs it on a per-minute cron, and each ward on the many-ward `host.ts` runs it from
 * its own alarm, set by `nextWake()` to the next moment there is anything to do.
 *
 * The tick is **idempotent and catch-up based**, which is what makes both triggers safe: it asks
 * whether the last scheduled occurrence is still owed a send (`uncoveredSlot`) rather than whether
 * it is exactly 08:00, and a slot's `UNIQUE` key stops a second enqueue. So an early or extra run
 * does nothing, and a late one still sends — within the 12-hour catch-up grace.
 */
import { config } from './config.js';
import { getSetting, isAutoSendEnabled, nextClaimableAt, purgeSendHistoryBefore, purgeSpentChallenges, sendQueueReady, setSetting, stalePendingBatch } from './db.js';
import type { FileStore } from './filestore.js';
import type { Logger } from './log.js';
import { localDate, maybePurgeOldPrograms } from './programs.js';
import { drainSendQueue, drainSendQueueUntilEmpty, settleSend } from './push.js';
import { getScheduleSettings, nextSlotAfter, queueWeeklySend, uncoveredSlot } from './schedule-core.js';
import { refreshWardSettings } from './ward-settings.js';

/**
 * Longest a ward sleeps with nothing scheduled. Bounds how late the daily housekeeping can run, and
 * how long a slot left uncovered by some failure waits for its catch-up (well inside the 12 hours).
 */
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;

/** Shortest a ward sleeps between ticks, so something that stays due cannot spin. */
export const MIN_GAP_MS = 30 * 1000;

/**
 * One tick, in four steps, and the **order is what prevents starvation**.
 *
 * A tick that drained first and only asked about the weekly send when the queue was empty, using a
 * due-ness window of a few minutes, would let a busy queue at 08:00 — a big ward still draining, a
 * manual send, a few delayed ticks — run the window out and skip the whole Sunday, silently, until
 * the next week. So:
 *
 * 1. **Is the last scheduled occurrence covered?** Asked first, and asked *whatever* the queue is
 *    doing, because the answer is about a `send_batches` row rather than about this minute (see
 *    `uncoveredSlot`). Enqueueing is idempotent — the `UNIQUE` index on `slot` — so a second tick
 *    that gets the same answer costs a rejected insert and nothing else. A Sunday the ward chose to
 *    skip, or one with nothing to announce, is recorded as covered here and sends nothing.
 * 2. **Drain** if anything is *claimable* (including whatever step 1 just enqueued) — a queue made
 *    only of rows waiting out a retry backoff does not count, so it cannot hold the later steps
 *    hostage for the hour a backoff can last.
 * 3. **Settle a stale send**: a batch still 'pending' with an empty queue is what a kill between the
 *    last commit and `settle()` leaves behind, and it would otherwise sit in the send history
 *    forever claiming zero recipients.
 * 4. **Housekeep**: expire old programs, and drop year-old send history and stale spent challenges
 *    (`maybePurgeHistory`), each at most once a local day.
 *
 * `drain: 'chunk'` is the free-plan Worker: one chunk, and steps 2–4 are exclusive so one tick never
 * spends two budgets' worth of subrequests. `drain: 'all'` is a ward on the paid host: a Durable
 * Object's SQLite is local, so it does everything due in one run.
 */
export async function runTick(
  now: Date,
  files: FileStore | null,
  log: Logger,
  drain: 'chunk' | 'all',
): Promise<void> {
  await refreshWardSettings(); // the timezone, if an admin changed it in another isolate
  const settings = await getScheduleSettings();
  const missed = await uncoveredSlot(now, settings, config.timezone);
  if (missed) {
    const outcome = await queueWeeklySend(missed.slot);
    if (outcome.status === 'queued') {
      log.info({ slot: missed.slot, total: outcome.total }, 'weekly send queued');
    } else {
      log.info({ slot: missed.slot, status: outcome.status }, 'weekly send not started');
    }
  }

  // *Ready*, not merely queued: a row waiting out a retry backoff is not claimable, and a queue
  // made only of those must not stop the tick from settling a stale send or doing its housekeeping
  // for the up-to-an-hour the wait can last.
  if ((await sendQueueReady()) > 0) {
    if (drain === 'all') {
      await drainSendQueueUntilEmpty();
      log.info('drained the send queue');
    } else {
      const result = await drainSendQueue();
      log.info({ processed: result.processed, remaining: result.remaining }, 'drained a send-queue chunk');
      return;
    }
  }

  // One per pass: a ward with several would be the trace of repeated crashes, not a backlog.
  const stale = await stalePendingBatch();
  if (stale) {
    log.warn({ sendLogId: stale.send_log_id }, 'settling a send whose queue emptied without it being closed out');
    await settleSend(stale.send_log_id);
    if (drain === 'chunk') return;
  }

  // Housekeeping runs regardless of the auto-send toggle — a ward that switched the weekly
  // notification off still wants old programs to expire. It costs one settings read on every tick
  // that finds today's date already recorded, and does real work on the one that doesn't. On the
  // free-plan Worker (`chunk`) each sweep is capped, so a backlog is spread over a run of ticks a
  // minute apart rather than blowing the per-invocation subrequest budget in one; a hosted ward
  // (`all`) clears it in one go.
  if (files) await maybePurgeOldPrograms(files, log, now, undefined, { untilDone: drain === 'all' });
  await maybePurgeHistory(log, now);
}

/** How long the send history (Recent Sends: every notification's title and text) is kept. */
export const SEND_LOG_RETENTION_DAYS = 365;

/** `datetime('now')`'s spelling of an instant — what `sent_at` and `expires_at` hold. */
const sqlDatetime = (at: Date) => at.toISOString().slice(0, 19).replace('T', ' ');

/**
 * The once-a-day sweep of rows that are only history: the send log past `SEND_LOG_RETENTION_DAYS`
 * (with each send's `send_batches` row, never one that still has queue rows — see
 * `purgeSendHistoryBefore`), and WebAuthn challenges whose five minutes are long over. The same
 * once-a-day marker as `maybePurgeOldPrograms`, and run by the same three clocks: the Worker's
 * cron tick, a hosted ward's alarm, and Node's 03:40 job and boot (`schedule.ts`, `server.ts`).
 * Everything here is a bounded `DELETE`, so no per-run cap is needed where the programs sweep has one.
 */
export async function maybePurgeHistory(log: Logger, now: Date = new Date(), tz: string = config.timezone): Promise<void> {
  try {
    const today = localDate(now, tz);
    if ((await getSetting('history_purge_last_run')) === today) return;
    await setSetting('history_purge_last_run', today);
    await purgeSendHistoryBefore(sqlDatetime(new Date(now.getTime() - SEND_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)));
    await purgeSpentChallenges(sqlDatetime(now));
  } catch (err) {
    log.error(err, 'purging old send history failed — clearing the daily marker so it retries');
    await setSetting('history_purge_last_run', '').catch(() => {});
  }
}

/**
 * When a ward next has something to do — what its alarm is set to. The earliest of:
 *
 * - while auto-send is on, the next scheduled occurrence — or now, if the last one is still owed
 *   its send (a Sunday the ward skips is still woken for: the tick is what records the skip);
 * - the moment the send queue next has a claimable row (now, the end of a lease, or the end of a
 *   retry backoff);
 * - now, for a send left pending with an empty queue;
 * - `MAX_SLEEP_MS` from now, for the daily housekeeping and as a backstop.
 *
 * **Derived, never stored**: it is recomputed from the database after every tick and every write,
 * so a changed schedule, a new skip or a manual send can never leave a stale alarm behind.
 */
export async function nextWake(now: Date): Promise<Date> {
  let at = now.getTime() + MAX_SLEEP_MS;
  const consider = (when: Date | null | undefined) => {
    if (when && when.getTime() < at) at = when.getTime();
  };
  if (await isAutoSendEnabled()) {
    const settings = await getScheduleSettings();
    // A slot that has already passed but is still owed its send is due *now*. Without this, a write
    // between 08:00 and the alarm firing re-derived the alarm from next week's slot, and the digest
    // waited for the six-hour backstop — out after church instead of before it.
    if (await uncoveredSlot(now, settings, config.timezone)) consider(now);
    consider(nextSlotAfter(now, settings, config.timezone));
  }
  consider(await nextClaimableAt());
  if (await stalePendingBatch()) consider(now);
  // Never sooner than MIN_GAP_MS. Whatever is due "now" was due during the tick that just ran, so if
  // it is still due the tick could not do it (no origin learned yet, say) — retry shortly rather than
  // wake the ward in a tight loop. A send due at 08:00 can start at most this late.
  return new Date(Math.max(at, now.getTime() + MIN_GAP_MS));
}
