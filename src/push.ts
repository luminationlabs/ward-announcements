/**
 * Sending the push notifications.
 *
 * Two things about this file are load-bearing for Cloudflare Workers:
 *
 * - **The crypto is WebCrypto.** `@block65/webcrypto-web-push` builds an RFC 8291 payload and the
 *   RFC 8292 VAPID header and hands them back as `{method, headers, body}`; *we* do the `fetch`.
 *   A library that needs Node's crypto and its own HTTP stack would not run there. Keeping the
 *   `fetch` here (rather than letting a library own it) is also what keeps the response available
 *   for the 404/410 pruning below.
 * - **A send is a queue, not a loop.** A Workers invocation gets ~10 ms of CPU on the free plan and
 *   each encryption costs a fraction of a millisecond, so a send is enqueued once
 *   (`send_batches` + `send_queue`) and drained `config.pushChunkSize` subscribers at a time. Node
 *   drains in a loop until empty, so there `sendToAll` returns the finished totals.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { config } from './config.js';
import {
  claimSendChunk,
  commitSendChunk,
  dropQueueForSend,
  enqueueSend,
  exhaustedSubscriptions,
  finalizeSend,
  getSendBatch,
  pruneSubscriptions,
  sendMessage,
  sendQueueDepth,
  sendQueueDepthFor,
  setSetting,
  type SendQueueItem,
} from './db.js';
import { refreshLearnedOrigin, vapidSubject } from './identity.js';
import { logger, type Logger } from './log.js';
import { tenantLocal } from './tenant.js';

/**
 * Drop a subscription after this many consecutive non-410 failures. Guarded so we only prune when
 * a send had *some* successes — a systemic problem (bad VAPID, outage) must never wipe everyone.
 */
const MAX_FAILURES = 8;

/**
 * How many attempts one delivery gets before it counts as failed.
 *
 * An attempt is spent when a row is **claimed**, not when it is committed (see `claimSendChunk`),
 * which is why this bounds a crash as well as a flaky push service: an isolate killed mid-chunk has
 * still consumed the attempt, so the row cannot be re-delivered forever. Only *retryable* outcomes
 * come back for another one — a push service answering 400 or 403 is telling us something no retry
 * will fix, and that row is done on the spot.
 *
 * Eight, with the backoff `commitSendChunk` puts on a retried row (`RETRY_BACKOFF` in db.ts), is
 * about three hours of trying: 2 + 4 + 8 + 16 + 32 + 60 + 60 minutes. A few attempts with no wait
 * would be a few consecutive cron minutes on Workers — a push service that blinked for that long
 * would cost a subscriber the whole week's digest.
 */
const MAX_ATTEMPTS = 8;

/**
 * How many exhausted subscriptions one settle may prune.
 *
 * Unbounded, pruning is two subrequests per subscriber on Workers against a budget of fifty — a
 * send settling after a long outage could blow it. Whatever is
 * left over is still over the threshold next Sunday, so the following send's settle takes the next
 * batch; nothing is lost, it is just spread out.
 */
const MAX_PRUNE_PER_SETTLE = 8;

/**
 * The largest plaintext `buildPushPayload` will encrypt (RFC 8291's 4096-byte record minus the
 * padding and AEAD overhead). Checked once per send rather than discovered per subscriber: the
 * library throws, and the throw would land in the per-subscriber catch below, where it looks
 * exactly like bad key material and would quietly fail the whole ward one row at a time.
 */
const MAX_PAYLOAD_BYTES = 3993;

/** How long to wait on a push service before giving up and retrying later. */
const FETCH_TIMEOUT_MS = 10_000;

/** The push service holds an undelivered message for a day, then gives up: a weekly digest a day late is still useful. */
const TTL_SECONDS = 60 * 60 * 24;

/**
 * Where this module's diagnostics go. Defaults to the shared logger — both entries install the same
 * one — and is swappable so a test can capture what a send reported without a build-order dance.
 */
let log: Logger = logger;
export function setPushLogger(next: Logger): void {
  log = next;
}

/**
 * A push endpoint minus its per-subscriber path, which is the credential half of the URL. Enough to
 * tell Apple's push service from Google's in a log line, and nothing more.
 */
function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unknown';
  }
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where to navigate when the notification is tapped. Defaults to the app root. */
  url?: string;
}

export interface SendResult {
  total: number;
  sent: number;
  failed: number;
  /** Subscriptions removed because the push service reported them gone (404/410). */
  removed: number;
}

/**
 * Cheap structural check on the VAPID pair at boot.
 *
 * Nothing else validates the keys until the first encryption, which would be the first Sunday
 * digest. The
 * decoded sizes are fixed by P-256: a 65-byte uncompressed public point (leading 0x04) and a
 * 32-byte private scalar.
 */
export function initPush(): void {
  const problems: string[] = [];
  const publicKey = decodeBase64Url(config.vapid.publicKey);
  const privateKey = decodeBase64Url(config.vapid.privateKey);
  if (!publicKey || publicKey.length !== 65 || publicKey[0] !== 0x04) {
    problems.push('VAPID_PUBLIC_KEY must be a base64url P-256 public key (65 bytes, 0x04-prefixed)');
  }
  if (!privateKey || privateKey.length !== 32) {
    problems.push('VAPID_PRIVATE_KEY must be a base64url P-256 private key (32 bytes)');
  }
  // The decoder above tolerates standard base64 so the *size* check is meaningful either way, but
  // the library hands the private key straight to a JWK `d` field, which is base64url only: a key
  // with `+`, `/` or `=` in it boots clean and then fails every delivery as `encrypt: DataError` —
  // discovered on the first Sunday. Say so at boot instead. The private key only, deliberately:
  // the public key is decoded leniently and rebuilt from its bytes, so a padded one may well be
  // working today, and a boot check must never take down a deployment that delivers.
  if (config.vapid.privateKey && !/^[A-Za-z0-9_-]+$/.test(config.vapid.privateKey)) {
    problems.push("VAPID_PRIVATE_KEY must be base64url (no '+', '/' or '=') — this one is standard base64");
  }
  if (problems.length > 0) {
    throw new Error(`${problems.join('; ')}. Run \`npm run vapid\` for a fresh pair.`);
  }
}

/** base64url → bytes, or null when the input isn't valid base64. No Node built-ins. */
function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Build the push message body.
 *
 * Uses the **Declarative Web Push** format (`web_push: 8030` + `notification`). On Safari/iOS
 * 18.4+ the browser renders this natively without waking the service worker. On other browsers
 * the service worker's `push` handler reads the same `notification` fields and shows it (see
 * public/sw.js) — so a single payload is backward compatible.
 *
 * Returned as a JSON *string* on purpose: the encryption library stringifies an object but passes a
 * string through untouched, so the plaintext is exactly the string built here — the bytes `MAX_PAYLOAD_BYTES` is checked
 * against.
 */
export function buildPushMessage(payload: PushPayload): string {
  const url = payload.url || '/';
  const isExternal = /^https?:\/\//i.test(url);
  // No access credential is attached: every push recipient subscribed from an already-unlocked
  // page, so they hold an access cookie by definition. Baking the shared code into notification
  // URLs only put a second long-lived copy of it into transit for no benefit.
  // Declarative push wants an absolute `navigate` URL; fall back to a relative path if no
  // PUBLIC_ORIGIN is configured (the service-worker fallback handles relative URLs fine).
  let navigate: string;
  if (isExternal) {
    navigate = url;
  } else {
    navigate = config.publicOrigin ? new URL(url, config.publicOrigin).toString() : url;
  }
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: payload.title,
      body: payload.body,
      navigate,
      lang: 'en-US',
    },
  });
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export interface SendOptions {
  type: 'manual' | 'scheduled';
  /**
   * For a scheduled send, the occurrence it covers (`YYYY-MM-DDTHH:MM` local). Enqueueing is a
   * no-op when that slot already has a send — the guard against a cron trigger double-firing.
   */
  slot?: string | null;
  /**
   * How much of the queue to drain before returning.
   *
   * `'until-empty'` (the default) is the Node behaviour: the caller waits for every subscriber, as
   * it always did. `'first-chunk'` is for Workers, where finishing a whole ward inside one request
   * would blow the CPU budget — the rest is delivered by the per-minute cron trigger.
   */
  drain?: 'until-empty' | 'first-chunk';
}

/**
 * Record a send and fan it out to every subscriber. Nothing is delivered here; that is what
 * draining does. Returns null when the slot was already covered.
 */
export async function queueSend(
  payload: PushPayload,
  options: SendOptions,
): Promise<{ sendLogId: number; total: number } | null> {
  const started = await enqueueSend({
    title: payload.title,
    body: payload.body || null,
    url: payload.url || '/',
    type: options.type,
    slot: options.slot ?? null,
  });
  // Nobody is subscribed: there is no queue to drain, so close the send out now or its `send_log`
  // row would sit "pending" forever.
  if (started && started.total === 0) await settleSend(started.sendLogId);
  return started;
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

/**
 * Only one drain at a time within a process/isolate. Two overlapping drains (a manual send while
 * the weekly one is still going) would both claim the same rows and deliver twice. Across
 * *isolates* this guarantees nothing — on Workers a cron tick could overlap a previous one — but
 * the cost there is at worst a duplicate notification, never a corrupted count. Per ward (see
 * tenant.ts): one ward's send must never make another ward's drain wait or, worse, return its result.
 */
const drainLock = tenantLocal(() => ({ running: null as Promise<DrainResult> | null }));

export interface DrainResult {
  /** Deliveries attempted in this chunk. */
  processed: number;
  /** Rows still queued afterwards (across every send). */
  remaining: number;
}

/** Drain one chunk of the queue. Safe to call when the queue is empty. */
export function drainSendQueue(chunkSize = config.pushChunkSize): Promise<DrainResult> {
  const lock = drainLock();
  if (lock.running) return lock.running;
  const run = drainChunk(chunkSize).finally(() => {
    lock.running = null;
  });
  lock.running = run;
  return run;
}

/**
 * Whether a drain is running in this process/isolate. A drain settles each send it empties itself,
 * so a send left 'pending' with an empty queue while none is running is a stale one (`schedule.ts`).
 */
export function drainInProgress(): boolean {
  return drainLock().running !== null;
}

/**
 * Drain until nothing is left *to claim*. The Node path: one call attempts every subscriber once
 * and returns with the totals. A row that came back for a retry is sitting out its backoff and is
 * not claimable, so it is left for the per-minute retry job in `schedule.ts` — which is why
 * `sendToAll`'s `pending` can be non-zero on Node too.
 *
 * The iteration cap is a backstop against a row that can neither succeed nor be given up on; it
 * cannot be hit in normal operation, because every outcome either deletes the row, spends one of
 * its `MAX_ATTEMPTS`, or parks it behind `not_before`.
 */
export async function drainSendQueueUntilEmpty(chunkSize = config.pushChunkSize): Promise<void> {
  const maxIterations = 10_000;
  for (let i = 0; i < maxIterations; i++) {
    const { processed, remaining } = await drainSendQueue(chunkSize);
    if (processed === 0 || remaining === 0) return;
  }
}

async function drainChunk(chunkSize: number): Promise<DrainResult> {
  // A deployment that sets neither PUBLIC_ORIGIN nor VAPID_SUBJECT learns both from the admin's
  // first visit (`identity.ts`), possibly in another isolate. Until then there is no contact
  // address, which push services reject, so leave the queue unclaimed rather than spend attempts.
  await refreshLearnedOrigin();
  if (!vapidSubject()) {
    log.error('no VAPID_SUBJECT or public origin yet — sign in to the dashboard once over https, or set either var');
    return { processed: 0, remaining: await sendQueueDepth() };
  }
  const items = await claimSendChunk(chunkSize);
  if (items.length === 0) return { processed: 0, remaining: 0 };

  // A chunk normally belongs to one send; group anyway, so a manual send queued behind the weekly
  // one is handled correctly rather than delivered with the wrong message.
  const grouped = new Map<number, SendQueueItem[]>();
  for (const item of items) {
    const list = grouped.get(item.send_log_id);
    if (list) list.push(item);
    else grouped.set(item.send_log_id, [item]);
  }

  for (const [sendLogId, group] of grouped) {
    await deliverGroup(sendLogId, group);
  }

  return { processed: items.length, remaining: await sendQueueDepth() };
}

async function deliverGroup(sendLogId: number, group: SendQueueItem[]): Promise<void> {
  const message = await sendMessage(sendLogId);
  const done: number[] = [];
  const retry: number[] = [];
  // Per-subscriber bookkeeping is *accumulated*, not written as it is decided: it all goes into the
  // one atomic batch at the end of the chunk (see `commitSendChunk`). Two reasons, and both matter.
  // A crash cannot land between "counter bumped" and "row deleted"; and on Workers each of those
  // writes, made separately, would be a subrequest against an allowance of fifty, which a
  // twelve-subscriber chunk could exhaust on bookkeeping alone.
  const succeeded: string[] = [];
  const failures: string[] = [];
  const gone: { endpoint: string; id: number }[] = [];
  let sent = 0;
  let failed = 0;
  let removed = 0;

  if (!message) {
    // The send row is gone (a failed enqueue, or a hand-edited database). Drop the orphans.
    await commitSendChunk({ sendLogId, sent: 0, failed: 0, removed: 0, done: group.map((i) => i.queue_id), retry: [] });
    return;
  }

  const data = buildPushMessage({
    title: message.title,
    body: message.body ?? '',
    url: message.url,
  });

  // The payload is the same for every subscriber, so an oversize one fails every delivery — but it
  // fails inside `buildPushPayload`, which is indistinguishable from bad key material from the
  // outside. Check it once, up front, and abandon the send loudly: nobody's failure_count is
  // touched (nothing is wrong with anyone's subscription) and the admin gets a banner naming the
  // actual problem instead of a silent zero-recipient send.
  const bytes = new TextEncoder().encode(data).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    log.error(
      { sendLogId, bytes, max: MAX_PAYLOAD_BYTES, subscribers: group.length },
      'push payload is too large to encrypt — send abandoned',
    );
    await dropQueueForSend(sendLogId);
    await finalizeSend(sendLogId);
    await setSetting(
      'send_alert',
      `The last notification was not sent: its payload is ${bytes} bytes, over the ` +
        `${MAX_PAYLOAD_BYTES}-byte limit. Shorten the title or message and send again.`,
    );
    return;
  }

  for (const item of group) {
    if (!item.endpoint || !item.p256dh || !item.auth) {
      done.push(item.queue_id); // the subscription was deleted while this send was queued
      continue;
    }
    // `attempts` already counts this claim. Strictly greater than the budget means a *previous*
    // claim died before it could commit — the row has had its attempts and is not getting another
    // delivery, whatever this one would have returned. The crash-proof half of the bound.
    if (item.attempts > MAX_ATTEMPTS) {
      log.warn(
        { sendLogId, subscriptionId: item.subscription_id, attempts: item.attempts },
        'giving up on a queued delivery: its attempts were spent by claims that never committed',
      );
      // Counted against the send, not the subscriber: a claim that died may well have delivered it
      // (see ORPHAN_CLAIM_COST in db.ts), and blaming them would walk a working phone towards pruning.
      failed++;
      done.push(item.queue_id);
      continue;
    }

    const { outcome, reason } = await deliver(data, item.endpoint, item.p256dh, item.auth);
    // A retryable outcome that has run out of attempts is just a failure.
    const settled = outcome === 'retry' && item.attempts >= MAX_ATTEMPTS ? 'failed' : outcome;
    if (settled !== 'sent') {
      // Record *why* a push failed — otherwise a Sunday that reached nobody leaves no evidence
      // beyond the count. One line per non-delivery, with the endpoint's origin (never its
      // path, which is the subscription's credential).
      log.warn(
        {
          sendLogId,
          subscriptionId: item.subscription_id,
          origin: endpointOrigin(item.endpoint),
          attempts: item.attempts,
          outcome: settled,
          reason,
        },
        'push delivery did not succeed',
      );
    }
    switch (settled) {
      case 'sent':
        succeeded.push(item.endpoint);
        sent++;
        done.push(item.queue_id);
        break;
      case 'gone':
        gone.push({ endpoint: item.endpoint, id: item.subscription_id });
        removed++;
        done.push(item.queue_id);
        break;
      case 'failed':
        failures.push(item.endpoint);
        failed++;
        done.push(item.queue_id);
        break;
      case 'retry':
        retry.push(item.queue_id);
        break;
    }
  }

  await commitSendChunk({ sendLogId, sent, failed, removed, done, retry, succeeded, failures, gone });
  if ((await sendQueueDepthFor(sendLogId)) === 0) await settleSend(sendLogId);
}

/**
 * The push services browsers actually use: Apple (Safari, iOS), Google FCM (Chrome, Android, Edge on
 * Android, Samsung Internet, Opera, Brave), Mozilla (Firefox), Microsoft WNS (Edge on Windows).
 */
const PUSH_SERVICE_SUFFIXES = [
  'push.apple.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

/**
 * Whether a subscription endpoint is a URL this server may POST to on every send: https, a real
 * hostname (never an IP literal or localhost), and — in production — one of the push services above.
 * Outside production any https host passes, which is what lets the test suites use made-up ones.
 */
export function isPushEndpoint(endpoint: string, production: boolean): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) {
    return false;
  }
  if (!production) return host.includes('.');
  return PUSH_SERVICE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

type Outcome = 'sent' | 'gone' | 'failed' | 'retry';

/** What happened, and enough about why for a log line: a status code or an error class. */
interface Delivery {
  outcome: Outcome;
  reason: string;
}

/** Encrypt for one subscriber and POST it to their push service. */
async function deliver(
  data: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): Promise<Delivery> {
  let request: { method: string; headers: Record<string, string>; body: Uint8Array };
  try {
    const built = await buildPushPayload(
      { data, options: { ttl: TTL_SECONDS } },
      { endpoint, expirationTime: null, keys: { p256dh, auth } },
      { ...config.vapid, subject: vapidSubject() },
    );
    // `content-length` is a forbidden header for `fetch`, which frames the body itself. Passing the
    // library's value through is at best ignored and at worst a thrown TypeError.
    const { 'content-length': _ignored, ...headers } = built.headers;
    request = { method: built.method, headers, body: built.body };
  } catch (err) {
    // Bad key material for this one subscriber — no retry will fix it. (An oversize payload cannot
    // reach here: `deliverGroup` checks the plaintext once before the loop.)
    return { outcome: 'failed', reason: `encrypt: ${errorLabel(err)}` };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: request.method,
      headers: request.headers,
      // A Uint8Array view is a valid BodyInit; the cast keeps TS happy across lib versions.
      body: request.body as unknown as BodyInit,
      // Without this a push service that accepts the connection and then never answers holds the
      // whole drain open: on Workers that is the cron tick's entire minute for one subscriber, and
      // on Node it is an admin's "Send" request hanging until the OS gives up. A timeout aborts,
      // which lands in the catch below as a retry — exactly what a hung endpoint deserves.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout — the push service may well be there next minute.
    return { outcome: 'retry', reason: `fetch: ${errorLabel(err)}` };
  }
  // Consume the body so the connection is released (undici keeps it open otherwise).
  await response.text().catch(() => '');

  const reason = `http ${response.status}`;
  if (response.ok) return { outcome: 'sent', reason };
  if (response.status === 404 || response.status === 410) return { outcome: 'gone', reason };
  if (response.status === 429 || response.status >= 500) return { outcome: 'retry', reason };
  return { outcome: 'failed', reason };
}

/** An error's class and message, short enough for a log field. */
function errorLabel(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Close out a finished send: prune chronically-failing subscriptions, write the delivered count
 * onto the `send_log` row, and set or clear the dashboard's health banner.
 *
 * Exported because it is also the repair for a send whose queue emptied but whose isolate died
 * before it could settle, or that another send's 404/410 or a prune emptied — the Workers tick and
 * Node's minute job sweep for one (see `stalePendingBatch`).
 */
export async function settleSend(sendLogId: number): Promise<void> {
  const batch = await getSendBatch(sendLogId);
  if (!batch || batch.status === 'done') return;

  // Prune chronically-failing subscriptions, but only when the send had successes — otherwise a
  // systemic problem (bad VAPID, outage) would wrongly delete every subscriber at once.
  if (batch.sent > 0) {
    // Capped: whatever this settle doesn't take is still over the threshold when the next send
    // settles, and two subrequests per pruned subscriber is not something to leave unbounded on a
    // runtime that allows fifty per invocation.
    const exhausted = await exhaustedSubscriptions(MAX_FAILURES, MAX_PRUNE_PER_SETTLE);
    if (exhausted.length > 0) {
      await pruneSubscriptions(exhausted.map((row) => row.id));
      // Move them from "failed" to "removed" in this send's totals, never below zero: the pruning
      // threshold counts failures across sends, so some of these may not have failed in this one.
      const shift = Math.min(exhausted.length, batch.failed);
      if (shift > 0) {
        await commitSendChunk({
          sendLogId,
          sent: 0,
          failed: -shift,
          removed: shift,
          done: [],
          retry: [],
        });
      }
    }
  }

  const final = await finalizeSend(sendLogId);
  if (!final) return;

  // Health signal for the admin dashboard: flag a *finished* send that reached nobody despite
  // having subscribers (almost always a VAPID/PUBLIC_ORIGIN misconfig); clear it on any success.
  // Evaluated once, here, so a chunk that has not delivered anyone yet never raises a false alarm.
  if (final.total > 0 && final.sent === 0) {
    await setSetting(
      'send_alert',
      `The last notification reached 0 of ${final.total} subscriber(s). ` +
        `Check VAPID keys and PUBLIC_ORIGIN, then send a test.`,
    );
  } else if (final.sent > 0 || final.total === 0) {
    // `total === 0` clears it too: with nobody subscribed there's nothing to diagnose, and leaving
    // the banner up would keep warning about a failure that no longer has any subscribers to fail.
    await setSetting('send_alert', '');
  }
}

/**
 * Send to every subscriber: enqueue, then drain (see `SendOptions.drain` for how far).
 *
 * `pending` is what is left for a later drain: the rest of the ward on Workers, and on either
 * runtime any delivery that is waiting out a retry backoff.
 */
export async function sendToAll(
  payload: PushPayload,
  options: SendOptions,
): Promise<SendResult & { pending: number }> {
  const started = await queueSend(payload, options);
  if (!started) return { total: 0, sent: 0, failed: 0, removed: 0, pending: 0 };
  if (options.drain === 'first-chunk') await drainSendQueue();
  else await drainSendQueueUntilEmpty();
  const batch = await getSendBatch(started.sendLogId);
  return {
    total: batch?.total ?? started.total,
    sent: batch?.sent ?? 0,
    failed: batch?.failed ?? 0,
    removed: batch?.removed ?? 0,
    pending: await sendQueueDepthFor(started.sendLogId),
  };
}
