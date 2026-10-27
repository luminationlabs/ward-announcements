/**
 * Tests for the send queue's failure handling: retries, the per-subscription failure counter, and
 * the pruning of a subscriber that has failed `MAX_FAILURES` sends in a row.
 *
 * Unlike the access-gate suite these run **in process**, importing the compiled modules and driving
 * `sendToAll` directly against a throwaway SQLite file. Two reasons:
 *
 * - The push service is a stub installed over `globalThis.fetch`. It has to be: the encryption
 *   library refuses any endpoint that is not `https:`, so a local HTTP server cannot stand in for a
 *   push service, and standing up TLS with a generated certificate would test openssl more than it
 *   tests this queue.
 * - What is under test spans several whole sends. Pruning is deliberately *not* something one send
 *   can do — the counter has to survive across sends — so the test needs to run eight of them and
 *   look at the rows in between.
 *
 * Everything else is real: the real schema on the real SQLite driver, the real RFC 8291 encryption
 * with a freshly generated VAPID pair, and the real drain loop.
 *
 * Node only, by construction (better-sqlite3, and `dist/`). Run with: npm test
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// `dist/`, not `src/`: same as the access-gate suite, these exercise the artefact that ships.
// `npm test` builds before running.
import { loadConfig } from '../dist/config.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import * as db from '../dist/db.js';
import { pruneSpentSkips } from '../dist/programs.js';
import { MIN_GAP_MS, SEND_LOG_RETENTION_DAYS, maybePurgeHistory, nextWake } from '../dist/tick.js';
import { saveMeetingTime } from '../dist/meeting.js';
import { runMinuteJob } from '../dist/schedule.js';
import {
  drainSendQueueUntilEmpty,
  initPush,
  queueSend,
  sendToAll,
  setPushLogger,
  settleSend,
} from '../dist/push.js';
import {
  getScheduleSettings,
  nextSendingSlotAfter,
  nextSlotAfter,
  onScheduleChanged,
  previousSlotAtOrBefore,
  queueWeeklySend,
  setAutoSendEnabled,
  setScheduleSettings,
  slotKey,
  uncoveredSlot,
} from '../dist/schedule-core.js';

/** Mirrors the constants in src/push.ts. Written out so a change there fails a test here. */
const MAX_FAILURES = 8;
const MAX_ATTEMPTS = 8;
/** Mirrors ORPHAN_CLAIM_COST in src/db.ts: what re-taking a row whose claim died costs. */
const ORPHAN_CLAIM_COST = 4;

/** The zone the suite's config is loaded with; the schedule tests pin instants against it. */
const TZ = 'America/Denver';

const OK = 'https://push.example.test/ok';
const BROKEN = 'https://push.example.test/broken';
const ALSO_BROKEN = 'https://push.example.test/also-broken';

let dataDir;
let realFetch;
/** Deliveries the stubbed push service has seen this send, per endpoint. */
let hits;
/**
 * A second connection to the same SQLite file, for the reach-in the lease tests need.
 *
 * A claim that never commits and a lease that has expired are, by definition, states no API can
 * produce on purpose — the only honest way to set one up is to write the row directly. The app's
 * own driver is a module singleton inside `db.js`, so this is a separate handle to the same file.
 */
let raw;
/** Everything `push.ts` logged, so a test can assert it complained *and* what about. */
let logLines;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wa-push-'));
  loadConfig({
    ADMIN_PASSWORD: 'test-admin-password',
    APP_NAME: 'Test Ward',
    APP_SHORT_NAME: 'Test',
    APP_DESCRIPTION: 'Test announcements',
    VAPID_SUBJECT: 'mailto:test@example.org',
    // A real pair, generated here: these tests actually encrypt, and a key that fails to import
    // would come back as a non-retryable failure — quietly passing some of the assertions below for
    // entirely the wrong reason.
    ...(await generateVapid()),
    NODE_ENV: 'development',
    TZ: 'America/Denver',
  });
  initPush();
  await db.initDb(createSqliteDriver(join(dataDir, 'push.db')));
  raw = createSqliteDriver(join(dataDir, 'push.db'));

  // Capture rather than print: a delivery failure logs a line, and these suites cause dozens on
  // purpose. Capturing keeps the output readable and lets the payload-guard test assert the
  // complaint actually happened.
  logLines = [];
  const capture = (a, b) => logLines.push({ fields: typeof a === 'string' ? {} : a, msg: typeof a === 'string' ? a : b });
  setPushLogger({ debug() {}, info() {}, warn: capture, error: capture });

  // The push service. 201 is what one returns for an accepted message; 500 is the retryable
  // failure (`deliver()` treats 5xx and 429 as retryable and 4xx as final).
  realFetch = globalThis.fetch;
  hits = new Map();
  globalThis.fetch = async (url) => {
    const endpoint = typeof url === 'string' ? url : url.url;
    hits.set(endpoint, (hits.get(endpoint) ?? 0) + 1);
    return endpoint === OK ? new Response(null, { status: 201 }) : new Response('nope', { status: 500 });
  };
});

after(() => {
  if (realFetch) globalThis.fetch = realFetch;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// --- helpers ----------------------------------------------------------------

/** A VAPID pair in the RFC 8292 §3.2 encoding, same as `npm run vapid` prints. */
async function generateVapid() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    VAPID_PUBLIC_KEY: Buffer.from(raw).toString('base64url'),
    VAPID_PRIVATE_KEY: jwk.d,
  };
}

/** Subscription key material a browser hands us: a P-256 ECDH point and a 16-byte auth secret. */
async function subscribe(endpoint) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  await db.upsertSubscription({
    endpoint,
    p256dh: Buffer.from(raw).toString('base64url'),
    auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    user_agent: 'test',
  });
}

/**
 * One whole send, carried through to the end.
 *
 * `sendToAll` attempts every subscriber once and returns; a delivery that came back retryable is
 * parked behind `not_before` for its backoff, which in production the per-minute tick waits out. A
 * test cannot wait hours, and the backoff is a timestamp comparison, so this clears the timestamp
 * and drains again until the queue is empty — the same experiment, compressed. The final totals are
 * read back from the batch; `immediate` is what the first drain alone reported.
 */
async function send(title) {
  hits.clear();
  const immediate = await sendToAll(
    { title, body: 'body', url: '/' },
    { type: 'manual', drain: 'until-empty' },
  );
  await fastForwardRetries();
  const log = await latestSend();
  const batch = await db.getSendBatch(log.id);
  return {
    total: batch.total,
    sent: batch.sent,
    failed: batch.failed,
    removed: batch.removed,
    pending: await db.sendQueueDepthFor(log.id),
    immediate,
  };
}

/** Wind every retry backoff to "now" and drain, until nothing is queued. Bounded, in case. */
async function fastForwardRetries() {
  for (let i = 0; i < MAX_ATTEMPTS + 2 && (await db.sendQueueDepth()) > 0; i++) {
    await raw.run('UPDATE send_queue SET not_before = NULL');
    await drainSendQueueUntilEmpty();
  }
}

const failureCount = async (endpoint) => (await db.getSubscriptionByEndpoint(endpoint))?.failure_count;
const latestSend = async () => (await db.recentSends(1))[0];

// ---------------------------------------------------------------------------

describe('the send queue: retries, failure counting and pruning', () => {
  before(async () => {
    await subscribe(OK);
    await subscribe(BROKEN);
  });

  test('a failing subscriber is retried, then counted as failed for this send', async () => {
    const result = await send('First');

    assert.equal(hits.get(OK), 1, 'a delivered message is posted exactly once');
    assert.equal(hits.get(BROKEN), MAX_ATTEMPTS, 'a 500 is retried until the attempt budget is spent');
    assert.equal(
      result.immediate.pending,
      1,
      'but not in a tight loop: the first drain returns with the failed row parked for its backoff',
    );
    assert.equal(result.immediate.sent, 1, 'and the delivered subscriber is not kept waiting on it');

    assert.deepEqual(
      { total: result.total, sent: result.sent, failed: result.failed, removed: result.removed },
      { total: 2, sent: 1, failed: 1, removed: 0 },
      'one delivered, one failed, nothing removed yet',
    );
    assert.equal(result.pending, 0, 'once the retries are spent nothing is left behind');
    assert.equal(await db.sendQueueDepth(), 0, 'and no queue rows survive the send');

    const log = await latestSend();
    assert.equal(log.recipient_count, 1, 'the history records deliveries, not attempts');
    assert.equal(log.type, 'manual');

    assert.equal(await failureCount(BROKEN), 1, 'one failed send is one failure, not three');
    assert.equal(await failureCount(OK), 0);
    assert.ok(
      (await db.getSubscriptionByEndpoint(OK)).last_success_at,
      'a delivery stamps last_success_at',
    );
  });

  test('failures accumulate across sends, and prune only at the threshold', async () => {
    // Sends 2..7: one short of the threshold, so the subscriber must survive all of them.
    for (let n = 2; n < MAX_FAILURES; n++) {
      const result = await send(`Send ${n}`);
      assert.equal(result.removed, 0, `send ${n} must not prune anyone yet`);
    }
    assert.equal(
      await failureCount(BROKEN),
      MAX_FAILURES - 1,
      'the counter tracks consecutive failed sends',
    );

    // The send that crosses the threshold. Pruning happens as the send settles, so it lands in this
    // send's own totals — the subscriber that just failed is reported as removed rather than failed.
    const result = await send('The last straw');
    assert.deepEqual(
      { total: result.total, sent: result.sent, failed: result.failed, removed: result.removed },
      { total: 2, sent: 1, failed: 0, removed: 1 },
      'the failure is re-counted as a removal, and the totals still add up to the total',
    );
    assert.equal(
      await db.getSubscriptionByEndpoint(BROKEN),
      undefined,
      'the exhausted subscriber is dropped',
    );
    assert.ok(await db.getSubscriptionByEndpoint(OK), 'the healthy subscriber is untouched');
    assert.equal(await db.sendQueueDepth(), 0, 'its queued rows go with it');
    assert.equal((await latestSend()).recipient_count, 1);
  });

  test('a send that reaches nobody prunes nobody, however often it fails', async () => {
    // The systemic-failure guard. Bad VAPID keys or a push-service outage fail *every* delivery,
    // and pruning on that would empty the ward's subscriber list in a single Sunday, unrecoverably
    // — every member would have to re-subscribe by hand. Only a send with at least one success may
    // prune.
    await db.deleteSubscription(OK);
    await subscribe(ALSO_BROKEN);

    for (let n = 0; n <= MAX_FAILURES; n++) {
      const result = await send(`Doomed ${n}`);
      assert.deepEqual(
        { total: result.total, sent: result.sent, failed: result.failed, removed: result.removed },
        { total: 1, sent: 0, failed: 1, removed: 0 },
        `send ${n} reached nobody, so it must remove nobody`,
      );
    }

    assert.ok(await db.getSubscriptionByEndpoint(ALSO_BROKEN), 'still subscribed');
    assert.ok(
      (await failureCount(ALSO_BROKEN)) > MAX_FAILURES,
      'even though the counter has climbed past the threshold',
    );
    assert.match(
      (await db.getSetting('send_alert')) ?? '',
      /reached 0 of 1/,
      'the dashboard health banner is raised instead',
    );
  });

  test('a delivery clears the counter, so a recovered subscriber is no longer a candidate', async () => {
    // What makes the threshold mean *consecutive*: without this reset, a phone that failed eight
    // sends over a year would be dropped on its next hiccup. The subscriber left over from the
    // previous test is well past the threshold, so a send that succeeds for someone else would
    // prune it — until it succeeds itself.
    await subscribe(OK);
    const beforeRecovery = await failureCount(ALSO_BROKEN);
    assert.ok(beforeRecovery > MAX_FAILURES);

    // It recovers: the same endpoint now answers 201.
    const stillBroken = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const endpoint = typeof url === 'string' ? url : url.url;
      hits.set(endpoint, (hits.get(endpoint) ?? 0) + 1);
      return new Response(null, { status: 201 });
    };
    try {
      const result = await send('All well');
      assert.deepEqual(
        { total: result.total, sent: result.sent, failed: result.failed, removed: result.removed },
        { total: 2, sent: 2, failed: 0, removed: 0 },
        'a recovered subscriber is delivered to, not pruned mid-send',
      );
    } finally {
      globalThis.fetch = stillBroken;
    }

    assert.equal(await failureCount(ALSO_BROKEN), 0, 'a success zeroes the counter');
    assert.equal(await db.getSetting('send_alert'), '', 'and clears the health banner');
  });

  test('a 410 drops the subscription without blocking it: the push service retired the endpoint, not the ward', async () => {
    // The block list (`blocked_subscriptions`) is for the dashboard's Remove, where re-adding the
    // device at its next launch would undo an admin's choice. A phone whose endpoint the push
    // service retired will mint a new one and must be able to register it.
    const GONE = 'https://push.example.test/gone';
    await subscribe(GONE);
    const stillBroken = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const endpoint = typeof url === 'string' ? url : url.url;
      hits.set(endpoint, (hits.get(endpoint) ?? 0) + 1);
      return new Response(null, { status: endpoint === GONE ? 410 : 201 });
    };
    try {
      const result = await send('Retired');
      assert.equal(result.removed, 1, 'the retired subscriber is counted as removed');
    } finally {
      globalThis.fetch = stillBroken;
    }
    assert.equal(await db.getSubscriptionByEndpoint(GONE), undefined, 'the row is gone');
    assert.equal(await db.isBlockedSubscription(GONE), false, 'and the endpoint is not blocked');
  });
});

// ---------------------------------------------------------------------------

/** Start from a known state: no subscribers, no queue rows, no half-finished sends. */
async function resetWorld() {
  for (const sub of await db.listSubscriptions()) await db.deleteSubscription(sub.endpoint);
  await raw.run('DELETE FROM send_queue');
  await raw.run('DELETE FROM send_batches');
  await raw.run('DELETE FROM send_log');
  hits.clear();
  logLines.length = 0;
}

describe('the claim lease', () => {
  before(async () => {
    await resetWorld();
    await subscribe(OK);
    await subscribe(BROKEN);
  });

  test('a second drain cannot claim rows a first one is holding', async () => {
    // The double-delivery bug this exists to stop: a cron tick overlapping the previous one, or a
    // manual send racing the weekly digest. Before the lease both read the same oldest rows and
    // both POSTed them.
    await queueSend({ title: 'Leased', body: 'body', url: '/' }, { type: 'manual' });
    assert.equal(await db.sendQueueDepth(), 2);

    const firstClaim = await db.claimSendChunk(10);
    assert.equal(firstClaim.length, 2, 'the first drain takes everything it asked for');
    assert.deepEqual(
      firstClaim.map((i) => i.attempts),
      [1, 1],
      'and the claim itself spends an attempt — a drain that dies still consumed one',
    );

    const secondClaim = await db.claimSendChunk(10);
    assert.deepEqual(secondClaim, [], 'a concurrent drain sees nothing to do, rather than the same rows');

    // Releasing them (a retry outcome) hands the lease back — but behind a backoff, not at once.
    await db.commitSendChunk({
      sendLogId: firstClaim[0].send_log_id,
      sent: 0,
      failed: 0,
      removed: 0,
      done: [],
      retry: firstClaim.map((i) => i.queue_id),
    });
    assert.deepEqual(
      await db.claimSendChunk(10),
      [],
      'a released row is not reclaimable until its backoff has passed',
    );
    assert.equal(await db.sendQueueDepth(), 2, 'though it is still queued');
    assert.equal(await db.sendQueueReady(), 0, 'and the tick can see that nothing is claimable yet');

    await raw.run('UPDATE send_queue SET not_before = NULL');
    assert.equal(await db.sendQueueReady(), 2);
    const thirdClaim = await db.claimSendChunk(10);
    assert.equal(thirdClaim.length, 2, 'once the wait is over it is fair game');
    assert.deepEqual(
      thirdClaim.map((i) => i.attempts),
      [2, 2],
      'and the second claim spends the second attempt',
    );

    await raw.run('DELETE FROM send_queue');
    await raw.run('DELETE FROM send_batches');
  });

  test('the backoff doubles with each attempt and caps at an hour', async () => {
    // Three consecutive cron minutes would be shorter than a routine push-service blip, so retries
    // back off. The wait is computed in SQL from the row's own attempt count, so
    // set the counts directly and read back what a retry commit schedules.
    await queueSend({ title: 'Backoff', body: 'body', url: '/' }, { type: 'manual' });
    const rows = await raw.all('SELECT id FROM send_queue ORDER BY id');
    assert.equal(rows.length, 2);
    const [first, sixth] = rows.map((r) => r.id);
    await raw.run('UPDATE send_queue SET attempts = 1 WHERE id = ?', [first]);
    await raw.run('UPDATE send_queue SET attempts = 6 WHERE id = ?', [sixth]);
    const sendLogId = (await raw.first('SELECT send_log_id FROM send_queue LIMIT 1')).send_log_id;

    await db.commitSendChunk({ sendLogId, sent: 0, failed: 0, removed: 0, done: [], retry: [first, sixth] });

    const scheduled = await raw.all(
      `SELECT id,
              not_before > datetime('now', '+1 minute')   AS later_than_1,
              not_before <= datetime('now', '+2 minutes') AS within_2,
              not_before > datetime('now', '+59 minutes') AS later_than_59,
              not_before <= datetime('now', '+60 minutes') AS within_60
       FROM send_queue ORDER BY id`,
    );
    assert.deepEqual(
      scheduled.map((r) => [r.later_than_1, r.within_2]),
      [[1, 1], [1, 0]],
      'the first retry waits two minutes (the sixth is later than that too, but not within two)',
    );
    assert.deepEqual(
      scheduled.map((r) => [r.later_than_59, r.within_60]),
      [[0, 1], [1, 1]],
      'and by the sixth the wait has hit the one-hour cap (2^6 would be 64)',
    );

    await raw.run('DELETE FROM send_queue');
    await raw.run('DELETE FROM send_batches');
  });

  test('a row orphaned by a killed drain is reclaimed once its lease expires', async () => {
    await queueSend({ title: 'Orphan', body: 'body', url: '/' }, { type: 'manual' });
    const claimed = await db.claimSendChunk(10);
    assert.equal(claimed.length, 2);
    // …and now the isolate dies: the rows stay claimed, nothing is committed.
    assert.deepEqual(await db.claimSendChunk(10), [], 'still held while the lease is live');

    // Wind the lease back past its five minutes. (A test cannot wait five real minutes, and the
    // lease is a timestamp comparison, so moving the timestamp is the same experiment.)
    await raw.run(`UPDATE send_queue SET claimed_at = datetime('now', '-10 minutes')`);
    const reclaimed = await db.claimSendChunk(10);
    assert.equal(reclaimed.length, 2, 'an expired lease is fair game again');
    assert.deepEqual(
      reclaimed.map((i) => i.attempts),
      [1 + ORPHAN_CLAIM_COST, 1 + ORPHAN_CLAIM_COST],
      'the dead claim still counted, and the re-take costs more — this is what bounds a crash that repeats',
    );

    await raw.run('DELETE FROM send_queue');
    await raw.run('DELETE FROM send_batches');
  });

  test('a row whose attempts were spent by claims that never committed is given up on, not re-sent', async () => {
    // A deterministic mid-chunk killer — an isolate that dies at the same point every time — would
    // re-deliver the same row forever if attempts only rose on a commit that never happens. The
    // claim spends the attempt, so the row runs out and is counted as failed *without* another
    // delivery attempt.
    hits.clear();
    await queueSend({ title: 'Exhausted', body: 'body', url: '/' }, { type: 'manual' });
    // Every row has already been claimed MAX_ATTEMPTS times by drains that died.
    await raw.run(
      `UPDATE send_queue SET attempts = ?, claimed_at = datetime('now', '-10 minutes'), claim_token = 'dead'`,
      [MAX_ATTEMPTS],
    );

    await drainSendQueueUntilEmpty();

    assert.equal(hits.size, 0, 'nothing was POSTed: the attempts were already gone');
    assert.equal(await db.sendQueueDepth(), 0, 'and the rows are gone rather than looping');
    assert.ok(
      logLines.some((l) => /attempts were spent/.test(l.msg ?? '')),
      'and it said so',
    );
    const log = (await db.recentSends(1))[0];
    assert.equal(log.recipient_count, 0, 'the send is closed out, reaching nobody');
  });

  test('a chunk killed mid-delivery is sent at most once more, and nobody is blamed for it', async () => {
    // The chunk's bookkeeping commits after all its deliveries, so a drain killed partway may have
    // delivered rows it never recorded. Found in an audit: each re-take cost one attempt, so a
    // chunk that kept dying sent the same notification up to eight times, five minutes apart. Now
    // a re-take costs ORPHAN_CLAIM_COST: taken first (1), re-taken once after a kill (1 + 4 = 5)
    // and delivered again, and the next re-take (5 + 4 = 9) is past MAX_ATTEMPTS.
    hits.clear();
    await queueSend({ title: 'Twice at most', body: 'body', url: '/' }, { type: 'manual' });
    const failureCount = async () => (await raw.first(`SELECT failure_count FROM subscriptions WHERE endpoint = ?`, [OK])).failure_count;
    const before = await failureCount();
    // Already re-taken once, and that drain died too.
    await raw.run(`UPDATE send_queue SET attempts = ?, claimed_at = datetime('now', '-10 minutes'), claim_token = 'dead'`, [1 + ORPHAN_CLAIM_COST]);

    await drainSendQueueUntilEmpty();
    assert.equal(hits.get(OK) ?? 0, 0, 'no third copy');
    assert.equal(await db.sendQueueDepth(), 0, 'the row is given up on rather than looping');
    assert.equal(await failureCount(), before, 'and the subscriber is not counted as failing: it may have arrived');
  });

  test('a row orphaned once still gets its delivery', async () => {
    hits.clear();
    await queueSend({ title: 'Killed before sending', body: 'body', url: '/' }, { type: 'manual' });
    await raw.run(`UPDATE send_queue SET attempts = 1, claimed_at = datetime('now', '-10 minutes'), claim_token = 'dead'`);
    await drainSendQueueUntilEmpty();
    assert.equal(hits.get(OK), 1, 'the kill may have come before the send, so it is tried once more');
  });
});

describe('settling a send that was killed before it could close itself out', () => {
  before(async () => {
    await resetWorld();
    await subscribe(OK);
  });

  test('a pending batch with an empty queue is swept up and finalised', async () => {
    const started = await queueSend({ title: 'Halfway', body: 'body', url: '/' }, { type: 'manual' });
    // Deliver everyone, but simulate the kill landing between the last commit and `settle()`: the
    // queue empties, the batch stays 'pending'. Left alone this shows in the send history forever
    // as a send that reached nobody.
    const claimed = await db.claimSendChunk(10);
    await db.commitSendChunk({
      sendLogId: started.sendLogId,
      sent: claimed.length,
      failed: 0,
      removed: 0,
      done: claimed.map((i) => i.queue_id),
      retry: [],
    });

    const stale = await db.stalePendingBatch();
    assert.equal(stale?.send_log_id, started.sendLogId, 'the sweep finds it');
    assert.equal(stale.status, 'pending');
    assert.equal((await db.recentSends(1))[0].recipient_count, 0, 'not yet written to the history');

    await settleSend(started.sendLogId);

    assert.equal((await db.getSendBatch(started.sendLogId)).status, 'done');
    assert.equal((await db.recentSends(1))[0].recipient_count, 1, 'the real count lands');
    assert.equal(await db.stalePendingBatch(), undefined, 'and there is nothing left to sweep');
  });

  test("on Node, the minute job settles a send another send's 410 emptied", async () => {
    // Send B: one delivered, one parked behind a retry backoff. Send A: that subscriber now answers
    // 410, which deletes its rows from *every* send — B's queue empties with no drain of B's to
    // settle it. Only the Workers tick swept for this, so on Node B said "Sending" forever.
    await db.setSetting('auto_send_enabled', '0'); // only the queue is under test
    const FLAKY = 'https://push.example.test/flaky';
    await subscribe(FLAKY);
    let flaky = 503;
    const stub = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const endpoint = typeof url === 'string' ? url : url.url;
      return endpoint === FLAKY ? new Response(null, { status: flaky }) : stub(url);
    };
    try {
      const b = await sendToAll({ title: 'B', body: 'b', url: '/' }, { type: 'manual', drain: 'until-empty' });
      assert.equal(b.pending, 1, 'the flaky delivery waits out its backoff');
      flaky = 410; // B's row is still behind its backoff, so A's drain never claims it
      await sendToAll({ title: 'A', body: 'a', url: '/' }, { type: 'manual', drain: 'until-empty' });
    } finally {
      globalThis.fetch = stub;
    }
    const stale = await db.stalePendingBatch();
    assert.ok(stale, 'B is pending with an empty queue');

    const quiet = { debug() {}, info() {}, warn() {}, error() {} };
    await runMinuteJob(quiet);

    assert.equal((await db.getSendBatch(stale.send_log_id)).status, 'done');
    assert.equal(await db.stalePendingBatch(), undefined);
    await db.setSetting('auto_send_enabled', '1');
  });
});

describe('an oversize payload', () => {
  before(async () => {
    await resetWorld();
    await subscribe(OK);
    await subscribe(BROKEN);
  });

  test('fails the whole send loudly, without blaming any subscriber', async () => {
    // The library refuses a plaintext over ~3993 bytes by throwing, and if the throw landed in the
    // per-subscriber catch it would be indistinguishable from bad key material: every subscriber
    // would take a failure_count for a mistake in the *message*, and eight such sends would prune
    // the entire ward.
    hits.clear();
    logLines.length = 0;
    const result = await sendToAll(
      { title: 'Far too much', body: 'x'.repeat(5000), url: '/' },
      { type: 'manual', drain: 'until-empty' },
    );

    assert.equal(hits.size, 0, 'nothing was encrypted or POSTed');
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 0, 'nobody is recorded as having failed — nobody was tried');
    assert.equal(await failureCount(OK), 0, 'and no subscriber takes a failure for it');
    assert.equal(await failureCount(BROKEN), 0);
    assert.equal(await db.sendQueueDepth(), 0, 'the send is abandoned rather than left queued');

    assert.match(
      (await db.getSetting('send_alert')) ?? '',
      /over the 3993-byte limit/,
      'the admin gets a banner naming the actual problem',
    );
    const complaint = logLines.find((l) => /payload is too large/.test(l.msg ?? ''));
    assert.ok(complaint, 'and it is logged');
    assert.ok(complaint.fields.bytes > 3993, 'with the size that broke it');
  });
});

describe('coverage-based due-ness', () => {
  const settings = { dow: 0, time: '08:00' };
  // 2026-09-13 is a Sunday; 08:00 in Denver (MDT, UTC-6) is 14:00 UTC. Ten past, so a ten-minute
  // "is it due right now?" window would already have closed on this instant.
  const TEN_PAST = new Date('2026-09-13T14:10:00Z');

  before(async () => {
    await resetWorld();
    await subscribe(OK);
    await db.setSetting('auto_send_enabled', '1');
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
  });

  test('an uncovered slot is still due ten minutes after the hour, and later', async () => {
    const missed = await uncoveredSlot(TEN_PAST, settings, TZ);
    assert.ok(missed, 'ten minutes late is not a missed Sunday');
    assert.equal(missed.slot, slotKey(previousSlotAtOrBefore(TEN_PAST, settings, TZ), TZ));
    assert.equal(missed.slot, '2026-09-13T08:00');
  });

  test('a non-empty queue does not hide it', async () => {
    // A tick that drained first and only asked about the schedule when the queue was empty would
    // let a ward big enough to still be draining at 08:10, or a manual send fired at 08:05, run the
    // window out and skip the whole Sunday. Due-ness is a question about `send_batches`, not about what the
    // queue happens to be doing.
    await queueSend({ title: 'In flight', body: 'body', url: '/' }, { type: 'manual' });
    assert.ok((await db.sendQueueDepth()) > 0, 'something else is mid-send');

    const missed = await uncoveredSlot(TEN_PAST, settings, TZ);
    assert.equal(missed?.slot, '2026-09-13T08:00', 'the Sunday is still owed');
    await raw.run('DELETE FROM send_queue');
  });

  test('once the slot has a send against it, it is covered', async () => {
    const started = await queueSend(
      { title: 'The digest', body: 'body', url: '/' },
      { type: 'scheduled', slot: '2026-09-13T08:00' },
    );
    assert.ok(started, 'the enqueue happened');
    assert.equal(await uncoveredSlot(TEN_PAST, settings, TZ), null, 'and now nothing is due');

    // Enqueueing the same slot again is the double-fire guard, and it is a no-op rather than a
    // second digest.
    assert.equal(
      await queueSend({ title: 'Again', body: 'body', url: '/' }, { type: 'scheduled', slot: '2026-09-13T08:00' }),
      null,
    );
  });

  test('the twelve-hour grace, the auto-send toggle and a just-changed schedule each veto it', async () => {
    await raw.run('DELETE FROM send_batches WHERE slot = ?', ['2026-09-13T08:00']);
    const nextDay = new Date('2026-09-14T14:00:00Z'); // 24h after the occurrence
    assert.equal(await uncoveredSlot(nextDay, settings, TZ), null, 'too stale to send as "this week"');

    await db.setSetting('auto_send_enabled', '0');
    assert.equal(await uncoveredSlot(TEN_PAST, settings, TZ), null, 'auto-send off means nothing is due');
    await db.setSetting('auto_send_enabled', '1');

    // The admin moved the slot to earlier today: the occurrence only *looks* missed.
    await db.setSetting('schedule_set_at', '2026-09-13T14:05:00.000Z');
    assert.equal(await uncoveredSlot(TEN_PAST, settings, TZ), null, 'a schedule changed after it wins');
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');

    assert.ok(await uncoveredSlot(TEN_PAST, settings, TZ), 'and with every veto lifted it is due again');
  });
});

describe('one digest a day, whatever happens to the schedule', () => {
  // 2026-09-13 is a Sunday. The 08:00 digest went out; at 08:30 the clerk corrected the meeting
  // time, which moved the slot to 10:00. Slot keys include the time, so 10:00 is a slot nothing
  // covers — found in an audit, it sent everyone the digest a second time.
  const later = { dow: 0, time: '10:00' };
  const TEN_PAST_TEN = new Date('2026-09-13T16:10:00Z'); // 10:10 in Denver

  before(async () => {
    await resetWorld();
    await subscribe(OK);
    await db.setSetting('auto_send_enabled', '1');
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
  });

  test('a digest sent earlier the same day covers a slot moved later', async () => {
    assert.ok(await queueSend({ title: 'The digest', body: 'body', url: '/' }, { type: 'scheduled', slot: '2026-09-13T08:00' }));
    assert.equal(await uncoveredSlot(TEN_PAST_TEN, later, TZ), null, 'no tick sees the 10:00 slot as owed');
    assert.equal((await queueWeeklySend('2026-09-13T10:00')).status, 'duplicate', 'and Node’s croner firing it is a no-op');
    assert.ok(await uncoveredSlot(new Date('2026-09-20T16:10:00Z'), later, TZ), 'next Sunday is its own day');
  });

  test('a skip earlier in the day does not stop a later slot', async () => {
    // "No current announcements" at 08:00, then the clerk posts and moves the time: the later slot
    // has something to say, and nothing was sent.
    await raw.run('DELETE FROM send_batches');
    await db.recordSkippedSend({ slot: '2026-09-13T08:00', reason: 'No current announcements', url: '/' });
    assert.equal((await uncoveredSlot(TEN_PAST_TEN, later, TZ))?.slot, '2026-09-13T10:00');
  });

  test('switching auto-send back on does not send the morning’s digest in the afternoon', async () => {
    // Off for the weekend, on again at 15:00 Sunday: the 08:00 slot passed with nothing recorded,
    // and inside the twelve-hour grace the next tick would have sent it seven hours late.
    await raw.run('DELETE FROM send_batches');
    const morning = { dow: 0, time: '08:00' };
    const threePm = new Date('2026-09-13T21:00:00Z');
    await setAutoSendEnabled(false);
    assert.equal(await uncoveredSlot(threePm, morning, TZ), null, 'off: nothing is due');
    await setAutoSendEnabled(true);
    assert.equal(await uncoveredSlot(threePm, morning, TZ), null, 'on again: still nothing for this morning');

    // Saving the form with it already on must not move the floor: a send missed in an outage is
    // still owed.
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    await setAutoSendEnabled(true);
    assert.equal(await db.getSetting('schedule_set_at'), '2020-01-01T00:00:00.000Z');
    assert.ok(await uncoveredSlot(threePm, morning, TZ));
  });
});

describe('the dashboard\'s "next send" steps past skipped Sundays', () => {
  // Pure arithmetic, no database: the skip dates are handed in.
  const settings = { dow: 0, time: '08:00' };
  const WEDNESDAY = new Date('2026-09-09T18:00:00Z'); // the week before Sun 2026-09-13

  test('with no skips it is the plain next occurrence', () => {
    const next = nextSendingSlotAfter(WEDNESDAY, settings, [], TZ);
    assert.deepEqual(next, { at: nextSlotAfter(WEDNESDAY, settings, TZ), skipped: 0 });
    assert.equal(slotKey(next.at, TZ), '2026-09-13T08:00');
  });

  test('two skipped Sundays in a row push it to the third, and say so', () => {
    const next = nextSendingSlotAfter(WEDNESDAY, settings, ['2026-09-13', '2026-09-20'], TZ);
    assert.equal(slotKey(next.at, TZ), '2026-09-27T08:00');
    assert.equal(next.skipped, 2);
  });

  test('a skip on a day nothing is sent on changes nothing', () => {
    const next = nextSendingSlotAfter(WEDNESDAY, settings, ['2026-09-14'], TZ);
    assert.equal(slotKey(next.at, TZ), '2026-09-13T08:00');
    assert.equal(next.skipped, 0);
  });

  test('a year of skips means nothing is scheduled rather than a runaway loop', () => {
    const dates = [];
    for (let d = new Date('2026-09-13T12:00:00Z'); dates.length < 60; d.setUTCDate(d.getUTCDate() + 7)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    assert.equal(nextSendingSlotAfter(WEDNESDAY, settings, dates, TZ), null);
  });
});

describe('a Sunday with nothing posted', () => {
  const settings = { dow: 0, time: '08:00' };
  const TEN_PAST = new Date('2026-09-13T14:10:00Z');
  const SLOT = '2026-09-13T08:00';

  before(async () => {
    await resetWorld();
    await raw.run('DELETE FROM announcements');
    await raw.run('DELETE FROM send_skips');
    await subscribe(OK);
    await db.setSetting('auto_send_enabled', '1');
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
  });

  test('the digest is not sent, and the history says why', async () => {
    assert.equal(await db.countPublicAnnouncements(), 0, 'the ward posted nothing this week');

    const outcome = await queueWeeklySend(SLOT);
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'No current announcements');
    assert.equal(await db.sendQueueDepth(), 0, 'nothing was queued for delivery');

    const [logged] = await db.recentSends(10);
    assert.equal(logged.type, 'skipped');
    assert.equal(logged.title, 'No current announcements');
    assert.equal(logged.recipient_count, 0);
  });

  test('the decision sticks, so a later publish cannot fire it off-schedule', async () => {
    // Without this the Workers tick would re-ask every minute for the twelve-hour catch-up grace,
    // and a clerk posting at 2pm would send the ward a "weekly" digest at 2pm. The skip's own
    // `send_batches` row is what holds the slot — the same row a real send would have left.
    const batch = await db.getSendBatchBySlot(SLOT);
    assert.equal(batch?.status, 'done', 'born finished, so no drain or sweep adopts it');
    assert.equal(batch?.total, 0);
    assert.equal(
      await uncoveredSlot(TEN_PAST, settings, TZ),
      null,
      'the slot is covered by the decision not to send',
    );

    await db.createAnnouncement({
      title: 'Posted later that afternoon',
      body: 'body',
      published: true,
      expires_at: null,
    });
    assert.equal(await db.countPublicAnnouncements(), 1);
    assert.equal(
      await uncoveredSlot(TEN_PAST, settings, TZ),
      null,
      'a late post does not reopen a slot that was already decided',
    );
  });

  test('repeated ticks never queue it, however long the catch-up grace runs', async () => {
    // The Workers cron fires *every minute* and the grace is twelve hours, so this slot gets looked
    // at ~720 times. Simulated here the way `worker.ts` does it: ask `uncoveredSlot()` first, and
    // only call `queueWeeklySend()` if it names a slot.
    let queueCalls = 0;
    for (const minute of [11, 12, 30, 90, 240, 600, 719]) {
      const now = new Date(TEN_PAST.getTime() + (minute - 10) * 60_000);
      const missed = await uncoveredSlot(now, settings, TZ);
      if (missed) {
        queueCalls++;
        await queueWeeklySend(missed.slot);
      }
    }
    assert.equal(queueCalls, 0, 'the tick should not even reconsider a slot already decided');
    assert.equal(await db.sendQueueDepth(), 0, 'nothing was ever queued for delivery');
    assert.equal(
      (await db.recentSends(10)).filter((s) => s.type !== 'skipped').length,
      0,
      'and no actual send exists in the history — only the one skip row',
    );
  });

  test('next week is unaffected — the skip is about one occurrence, not a mode', async () => {
    const nextSunday = new Date('2026-09-20T14:10:00Z');
    const missed = await uncoveredSlot(nextSunday, settings, TZ);
    assert.equal(missed?.slot, '2026-09-20T08:00', 'the following Sunday is due as normal');

    const outcome = await queueWeeklySend('2026-09-20T08:00');
    assert.equal(outcome.status, 'queued', 'and with an announcement up, it sends');
    assert.equal(outcome.total, 1);
  });
});

describe('a Sunday the ward chose to skip', () => {
  const settings = { dow: 0, time: '08:00' };
  const TEN_PAST = new Date('2026-09-13T14:10:00Z');
  const SLOT = '2026-09-13T08:00';
  const DATE = '2026-09-13';

  before(async () => {
    await resetWorld();
    await raw.run('DELETE FROM announcements');
    await raw.run('DELETE FROM send_skips');
    await subscribe(OK);
    await db.setSetting('auto_send_enabled', '1');
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    // The difference from the empty-week case: there IS something to send.
    await db.createAnnouncement({
      title: 'Ward temple night',
      body: 'body',
      published: true,
      expires_at: null,
    });
  });

  test('a skipped date suppresses the send even with announcements up', async () => {
    await db.addSkip(DATE, 'General Conference');
    assert.equal(await db.countPublicAnnouncements(), 1, 'there is something it could have sent');

    const outcome = await queueWeeklySend(SLOT);
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.reason, 'General Conference', "the admin's own words, not a generic one");
    assert.equal(await db.sendQueueDepth(), 0, 'nobody was queued');

    const [logged] = await db.recentSends(10);
    assert.equal(logged.type, 'skipped');
    assert.equal(logged.title, 'General Conference');
  });

  test('the slot is covered, so no tick reconsiders it', async () => {
    assert.equal(await uncoveredSlot(TEN_PAST, settings, TZ), null);
  });

  test('removing the skip afterwards cannot resurrect the send', async () => {
    // The skip row is the admin's *intent*; the `send_batches` row is the record that the
    // occurrence was dealt with. Deleting the first must not reopen the second, or tidying up the
    // list on Sunday afternoon would deliver the digest Conference weekend was meant to avoid.
    await db.removeSkip(DATE);
    assert.equal(await db.skipForDate(DATE), undefined, 'the skip is gone');
    assert.equal(
      await uncoveredSlot(TEN_PAST, settings, TZ),
      null,
      'but the occurrence stays settled',
    );
  });

  test('a skip is only pruned once nothing can act on the occurrence again', async () => {
    await db.addSkip('2026-09-20', 'Stake conference');
    await db.addSkip('2026-09-27', null);

    // The morning of the 20th: its own skip must survive, or the send it suppresses goes out.
    await pruneSpentSkips(new Date('2026-09-20T14:00:00Z'), TZ);
    assert.ok(await db.skipForDate('2026-09-20'), 'a skip is never pruned on its own day');

    // Well past the twelve-hour catch-up grace, and past the retention margin.
    await pruneSpentSkips(new Date('2026-09-23T14:00:00Z'), TZ);
    assert.equal(await db.skipForDate('2026-09-20'), undefined, 'now it is spent and gone');
    assert.ok(await db.skipForDate('2026-09-27'), 'a future one is untouched');
  });

  test('only upcoming skips are listed, so a passed date never needs removing by hand', async () => {
    const upcoming = await db.listSkipsFrom('2026-09-21');
    assert.deepEqual(
      upcoming.map((s) => s.skip_date),
      ['2026-09-27'],
    );
  });
});

/**
 * What a ward on the many-ward host sets its alarm to (`nextWake` in src/tick.ts). The host's own
 * tests cannot reach a push service that fails *retryably*, so the queue's half of the rule is
 * pinned here, against the stubbed one.
 */
describe('the send history is kept a year', () => {
  const NOW = new Date('2026-10-28T12:00:00Z');
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  /** A finished send dated `daysAgo` days before NOW: a `send_log` row and its `send_batches` row. */
  async function finishedSend(title, daysAgo) {
    const at = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const { lastRowId: id } = await raw.run(
      `INSERT INTO send_log (sent_at, title, body, recipient_count, type) VALUES (?, ?, 'body', 1, 'manual')`,
      [at, title],
    );
    await raw.run(
      `INSERT INTO send_batches (send_log_id, url, slot, total, sent, status, finished_at) VALUES (?, '/', NULL, 1, 1, 'done', ?)`,
      [id, at],
    );
    return id;
  }
  const titles = async () => (await raw.all(`SELECT title FROM send_log ORDER BY id`)).map((r) => r.title);
  const batches = async () => (await raw.all(`SELECT send_log_id FROM send_batches ORDER BY send_log_id`)).map((r) => r.send_log_id);

  before(async () => {
    await resetWorld();
    await db.setSetting('history_purge_last_run', '');
  });

  test('rows older than the cutoff go, with their batch rows; newer ones and a send still queued stay', async () => {
    const ancient = await finishedSend('two years ago', 2 * 365);
    const justOver = await finishedSend('a year and a day ago', SEND_LOG_RETENTION_DAYS + 1);
    const justUnder = await finishedSend('a day short of a year', SEND_LOG_RETENTION_DAYS - 1);
    const recent = await finishedSend('last week', 7);
    // An old send whose queue never emptied (a subscriber stuck in retries): the drain and the
    // settle still need its rows, so age alone must not take them.
    const stuck = await finishedSend('old but still draining', 2 * 365);
    await raw.run(`INSERT INTO send_queue (send_log_id, subscription_id) VALUES (?, 1)`, [stuck]);
    await raw.run(`UPDATE send_batches SET status = 'pending', finished_at = NULL WHERE send_log_id = ?`, [stuck]);

    await maybePurgeHistory(quiet, NOW, TZ);
    assert.deepEqual(await titles(), ['a day short of a year', 'last week', 'old but still draining']);
    assert.deepEqual(await batches(), [justUnder, recent, stuck]);
    assert.equal((await raw.first(`SELECT COUNT(*) AS n FROM send_queue WHERE send_log_id = ?`, [stuck])).n, 1, 'its queue row is untouched');
    assert.ok(!(await batches()).includes(ancient) && !(await batches()).includes(justOver));
  });

  test('once a day: a second run the same local day does nothing, the next day sweeps again', async () => {
    await finishedSend('also ancient', 3 * 365);
    await maybePurgeHistory(quiet, NOW, TZ);
    assert.ok((await titles()).includes('also ancient'), 'the day\'s marker is set');
    await maybePurgeHistory(quiet, new Date(NOW.getTime() + 24 * 60 * 60 * 1000), TZ);
    assert.ok(!(await titles()).includes('also ancient'));
  });

  test('spent WebAuthn challenges past their five minutes go with the same sweep', async () => {
    await db.setSetting('history_purge_last_run', '');
    const spell = (ms) => new Date(NOW.getTime() + ms).toISOString().slice(0, 19).replace('T', ' ');
    assert.equal(await db.spendChallenge('old', spell(-60_000)), true);
    assert.equal(await db.spendChallenge('live', spell(4 * 60_000)), true);
    assert.equal(await db.spendChallenge('live', spell(4 * 60_000)), false, 'a second spend of the same challenge is refused');
    await maybePurgeHistory(quiet, NOW, TZ);
    assert.deepEqual((await raw.all(`SELECT id FROM spent_challenges ORDER BY id`)).map((r) => r.id), ['live']);
  });
});

describe('what wakes a hosted ward', () => {
  const at = (sqlTime) => new Date(`${sqlTime.replace(' ', 'T')}Z`).getTime();

  test('an empty queue with auto-send off sleeps until the six-hour backstop', async () => {
    await fastForwardRetries();
    await db.setSetting('auto_send_enabled', '0');
    const now = new Date();
    assert.equal((await nextWake(now)).getTime(), now.getTime() + 6 * 60 * 60 * 1000);
  });

  test('a retry wakes the ward when its backoff ends', async () => {
    await db.setSetting('auto_send_enabled', '0'); // only the queue decides, in these
    await subscribe('https://push.example.test/wake-retry');
    await sendToAll({ title: 'Wake', body: 'b', url: '/' }, { type: 'manual', drain: 'until-empty' });
    const { nb } = await raw.first(`SELECT MIN(not_before) AS nb FROM send_queue`);
    assert.ok(nb, 'the failed delivery is parked behind a backoff');
    assert.equal((await nextWake(new Date())).getTime(), at(nb));
  });

  test("a delivery held by a drain that died wakes the ward when the lease runs out", async () => {
    await db.setSetting('auto_send_enabled', '0'); // only the queue decides, in these
    await raw.run(`UPDATE send_queue SET claimed_at = datetime('now'), not_before = NULL`);
    const { claimed } = await raw.first(`SELECT MIN(claimed_at) AS claimed FROM send_queue`);
    // One second past the lease: the claim's own test is strict (`claimed_at < now - 5 minutes`).
    assert.equal((await nextWake(new Date())).getTime(), at(claimed) + 5 * 60 * 1000 + 1000);
  });

  test('a slot that has just passed and is still owed its send is due now, not next week', async () => {
    // Sunday 08:00 in Denver; 08:00:10 on 8 November 2026. Before the fix, a write at this moment
    // re-derived the alarm from the next Sunday and the six-hour backstop, so the digest went out
    // around 14:00.
    await db.setSetting('auto_send_enabled', '1');
    await setScheduleSettings({ dow: 0, time: '08:00' });
    await db.setSetting('schedule_set_at', '2026-10-01T00:00:00.000Z');
    const now = new Date('2026-11-08T15:00:10Z');
    assert.equal((await nextWake(now)).getTime(), now.getTime() + MIN_GAP_MS);
    await db.setSetting('auto_send_enabled', '0');
  });

  test('something due now is retried shortly, never in a tight loop', async () => {
    await db.setSetting('auto_send_enabled', '0'); // only the queue decides, in these
    // A row of its own to be due: a failed delivery, then made claimable straight away.
    await subscribe('https://push.example.test/wake-now');
    await sendToAll({ title: 'Due now', body: 'b', url: '/' }, { type: 'manual', drain: 'until-empty' });
    assert.ok((await db.sendQueueDepth()) > 0);
    await raw.run(`UPDATE send_queue SET claimed_at = NULL, not_before = NULL`);
    const now = new Date();
    assert.equal((await nextWake(now)).getTime(), now.getTime() + MIN_GAP_MS);
    await fastForwardRetries(); // leave the queue as the other suites expect it
    await db.setSetting('auto_send_enabled', '1');
  });
});

describe('the meeting time moves the weekly slot the way the Day and Time form does', () => {
  // Saving a meeting time writes the schedule through `setScheduleSettings` — the form's own call —
  // so the "schedule moved" stamp and the runtime hook (Node's croner rebuild; a hosted ward
  // re-derives its alarm after every write) behave identically. The one difference is deliberate:
  // re-saving the meeting time that is already in force is not a move, so it neither stamps nor
  // vetoes a send still owed.
  let hookCalls = 0;

  before(async () => {
    await fastForwardRetries();
    await db.setSetting('auto_send_enabled', '1');
    await setScheduleSettings({ dow: 0, time: '08:00' });
    onScheduleChanged(async () => {
      hookCalls++;
    });
  });
  after(async () => {
    onScheduleChanged(null);
    await db.deleteSetting('meeting_time');
    await setScheduleSettings({ dow: 0, time: '08:00' });
    await db.setSetting('auto_send_enabled', '0');
  });

  test('a new meeting time is a schedule move: stamped, and the runtime told', async () => {
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    hookCalls = 0;
    await saveMeetingTime({ dow: '0', time: '10:30' });
    assert.deepEqual(await getScheduleSettings(), { dow: 0, time: '09:30' });
    assert.notEqual(await db.getSetting('schedule_set_at'), '2020-01-01T00:00:00.000Z', 'stamped as moved');
    assert.equal(hookCalls, 1, 'the runtime heard about it once');
    // The next send is the new slot: Sunday 13 September 2026, 09:30 in Denver (MDT) = 15:30 UTC.
    const wednesday = new Date('2026-09-09T18:00:00Z');
    assert.equal(nextSlotAfter(wednesday, await getScheduleSettings(), TZ)?.toISOString(), '2026-09-13T15:30:00.000Z');
  });

  test('moving the slot past one that already went out does not resend it — the stamp vetoes catch-up', async () => {
    // As with the form: a move stamped after the new slot's time today means that occurrence only
    // *looks* missed, so nothing fires for it.
    await db.setSetting('schedule_set_at', '2026-09-20T15:45:00.000Z'); // the move, at 09:45 Denver
    const after = new Date('2026-09-20T15:50:00Z');
    assert.equal(await uncoveredSlot(after, { dow: 0, time: '09:30' }, TZ), null);
  });

  test('re-saving the same meeting time is not a move: an owed send is still owed', async () => {
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    await raw.run('DELETE FROM send_batches WHERE slot = ?', ['2026-09-20T09:30']);
    const lateMorning = new Date('2026-09-20T15:40:00Z'); // 09:40 Denver, the 09:30 send not made
    assert.equal((await uncoveredSlot(lateMorning, await getScheduleSettings(), TZ))?.slot, '2026-09-20T09:30');
    hookCalls = 0;
    await saveMeetingTime({ dow: '0', time: '10:30' });
    assert.equal(await db.getSetting('schedule_set_at'), '2020-01-01T00:00:00.000Z', 'no stamp');
    assert.equal(hookCalls, 0, 'nothing for the runtime to rebuild');
    assert.equal((await uncoveredSlot(lateMorning, await getScheduleSettings(), TZ))?.slot, '2026-09-20T09:30');
  });

  test('re-saving the same Day and Time is not a move either: an owed send is still owed', async () => {
    // The Advanced Timing form posts the slot whether or not it changed. A Save clicked at 08:10
    // with the 08:00 digest still owed used to stamp the move and so cancel that Sunday.
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    hookCalls = 0;
    await setScheduleSettings(await getScheduleSettings());
    assert.equal(await db.getSetting('schedule_set_at'), '2020-01-01T00:00:00.000Z', 'no stamp');
    assert.equal(hookCalls, 0, 'nothing for the runtime to rebuild');
  });

  test('a hosted ward wakes for the derived slot', async () => {
    await fastForwardRetries();
    const saturday = new Date('2026-09-19T22:00:00Z'); // 16:00 Saturday in Denver
    await db.setSetting('schedule_set_at', '2020-01-01T00:00:00.000Z');
    assert.equal((await nextWake(saturday)).getTime(), saturday.getTime() + 6 * 60 * 60 * 1000, 'the backstop is sooner');
    const early = new Date('2026-09-20T13:00:00Z'); // 07:00 Sunday
    assert.equal((await nextWake(early)).toISOString(), '2026-09-20T15:30:00.000Z', '09:30, not the old 08:00');
  });
});
