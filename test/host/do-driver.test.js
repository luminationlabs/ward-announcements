/**
 * The Durable Object SQL driver (`src/driver-do.ts`) against a real local Durable Object, through
 * the probe in `test/do-probe/` — the paths the HTTP suites never reach on the many-ward host:
 * batch rollback, the send queue's claim, a whole send with a retry, and whether an alarm is rolled
 * back with its transaction. Part of the many-ward host.
 *
 * Starts `wrangler dev` (no Cloudflare account needed, nothing deployed). Part of `npm run
 * test:host`, not `npm test`, which stays Node-only.
 */
// The harness picks its runtime from the environment at import time, so set it first.
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/do-probe/wrangler.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { startServer, testPort } = await import('../helpers/harness.js');

let server;
const probe = async (path) => (await fetch(server.base + path)).json();

before(async () => {
  server = await startServer({ port: testPort(6) });
});
after(() => server?.stop());

test('a failed batch leaves nothing behind, and changes/lastRowId are right', async () => {
  const r = await probe('/batch');
  assert.equal(r.threw, true, 'the batch should report its failure');
  assert.equal(r.leaked, null, 'the statement before the failure must be rolled back');
  assert.equal(r.rowIdsIncrease, true);
  assert.equal(r.updatedChanges, 2);
  assert.equal(r.noopChanges, 0);
});

test('a claim takes the queued rows, and a second claim finds none', async () => {
  const r = await probe('/claim');
  assert.deepEqual(r, { queued: 3, firstClaim: 3, secondClaim: 0 });
});

test('a whole send: deliveries land, a 500 waits out its backoff, a later drain finishes it', async () => {
  const r = await probe('/send');
  assert.equal(r.firstPass.total, 4);
  assert.equal(r.firstPass.sent, 3);
  assert.equal(r.firstPass.pending, 1);
  assert.equal(r.parked.length, 1);
  assert.equal(r.parked[0].attempts, 1);
  assert.ok(r.parked[0].not_before, 'the retry is parked behind a backoff');
  assert.deepEqual(r.final, { total: 4, sent: 4, failed: 0, queue: 0 });
});

test('alarm vs. transaction rollback (recorded, not required)', async (t) => {
  const r = await probe('/alarm');
  assert.equal(r.threw, true);
  assert.equal(typeof r.alarmSurvivedRollback, 'boolean');
  t.diagnostic(`setAlarm inside a rolled-back transactionSync ${r.alarmSurvivedRollback ? 'SURVIVED' : 'was rolled back'}`);
});

test('async work inside storage.transaction() is all-or-nothing (how migrations are made atomic)', async () => {
  const r = await probe('/async-txn');
  assert.equal(r.threw, true, r.error);
  assert.equal(r.leaked, null, `the write before the failure must be rolled back (${r.error})`);
});

test('a migration that fails part-way leaves no trace, and the next attempt succeeds', async () => {
  const r = await probe('/migrate-rollback');
  assert.equal(r.threw, true);
  assert.deepEqual(r.after, r.before, 'no table from the failed run survives');
  assert.ok(r.schemaVersion, 'a clean run afterwards creates the schema');
});
