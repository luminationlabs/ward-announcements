/**
 * A hosted ward's scheduled work runs from its own Durable Object alarm, not a per-minute cron
 * (`src/host.ts`, `src/tick.ts`). These pin the rules that make that safe:
 *
 * - the alarm is **derived** from the database after every write, so saving the schedule, turning
 *   auto-send off, or queueing a send moves it — nothing can leave it stale;
 * - a real alarm firing runs the real handler and sets the next one;
 * - and a stake-conference weekend: a Sunday with a skip row sends nothing even
 *   when its alarm fires, the Sunday after sends as usual, and a manual send on the Saturday goes
 *   out at once with any retry picked up by the alarm.
 *
 * The scheduled work is driven through the operator API's `tick` with a chosen "now", so a Sunday
 * in November can be tested in October. The one subscriber's push service is not reachable from a
 * test, so these assert that a send was made and attempted, not that it was accepted; the retry
 * path is pinned against a stubbed push service in test/push-queue.test.js. Local `wrangler dev`
 * only; nothing is deployed. Part of `npm run test:host`.
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { webcrypto } = await import('node:crypto');
const { ADMIN_PASSWORD, createClient, startServer, testPort, unlockMember } = await import('../helpers/harness.js');

let server;
let req;
const TZ = 'America/Denver';

const operator = async (path, body) => {
  const res = await fetch(`${server.base}/__operator/wards/test/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(res.status, 200, `operator ${path}`);
  return res.json();
};
const state = () => operator('state');
const tick = (now) => operator('tick', { now });
const post = (path, form) => req(path, { as: 'admin', method: 'POST', form });

/** The ward-local weekday (0 = Sunday) and HH:MM of an instant. */
function local(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dow, time: `${parts.hour}:${parts.minute}` };
}

before(async () => {
  server = await startServer({ port: testPort(10) });
  req = createClient(server.base);
  const login = await post('/admin/login', { password: ADMIN_PASSWORD });
  assert.equal(login.status, 302);

  // One member with notifications on. Real key material, so encryption succeeds and the delivery
  // really reaches `fetch`.
  await unlockMember(req, 'member');
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const subscribed = await req('/api/subscribe', {
    as: 'member',
    method: 'POST',
    json: {
      endpoint: 'https://push.invalid/ward-test',
      keys: {
        p256dh: Buffer.from(raw).toString('base64url'),
        auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
      },
    },
  });
  assert.ok(subscribed.ok, `subscribe: ${subscribed.status}`);
});

after(() => server?.stop());

test('a ward has an alarm from the moment it exists', async () => {
  const { alarm } = await state();
  assert.ok(alarm, 'provisioning sets the first alarm');
  assert.ok(alarm <= Date.now() + 6 * 60 * 60 * 1000 + 60_000, 'never more than the six-hour backstop away');
});

test('saving the schedule moves the alarm to the new time; turning auto-send off lets it go', async () => {
  // Two hours from now, in the ward's own time — whatever day that falls on.
  const slot = new Date(Math.ceil((Date.now() + 2 * 60 * 60 * 1000) / 60_000) * 60_000);
  const { dow, time } = local(slot);
  assert.equal((await post('/admin/settings', { auto_send: '1' })).status, 302);
  assert.equal((await post('/admin/schedule', { dow: String(dow), time })).status, 302);
  assert.equal((await state()).alarm, slot.getTime(), 'the alarm is the new slot, to the minute');

  assert.equal((await post('/admin/settings', { auto_send: '0' })).status, 302);
  assert.ok((await state()).alarm > slot.getTime(), 'with auto-send off the slot no longer wakes the ward');
  assert.equal((await post('/admin/settings', { auto_send: '1' })).status, 302);
  // Back to the ward's real schedule for the stake-conference tests.
  assert.equal((await post('/admin/schedule', { dow: '0', time: '08:00' })).status, 302);
});

test('saving the meeting time moves the alarm to an hour before it, as the Day and Time form would', async (t) => {
  // The notification goes out an hour before the meeting. Find a slot one to five hours ahead whose
  // meeting (an hour later) is inside the form's 6:00 AM–10:00 PM; late at night there is none.
  let slot = null;
  for (let h = 1; h <= 5 && !slot; h++) {
    const candidate = new Date(Math.ceil((Date.now() + h * 60 * 60 * 1000) / 60_000) * 60_000);
    const meeting = local(new Date(candidate.getTime() + 60 * 60 * 1000));
    if (meeting.dow === local(candidate).dow && meeting.time >= '06:00' && meeting.time <= '22:00') slot = candidate;
  }
  if (!slot) return t.skip('no meeting time in range within five hours of now, in the ward zone');
  const meeting = local(new Date(slot.getTime() + 60 * 60 * 1000));
  assert.equal((await post('/admin/settings', { auto_send: '1' })).status, 302);
  const saved = await post('/admin/meeting-time', { meeting_dow: String(meeting.dow), meeting_time: meeting.time });
  assert.equal(saved.status, 302);
  assert.match(decodeURIComponent(saved.headers.get('location') ?? ''), /Meeting time saved/);
  assert.equal((await state()).alarm, slot.getTime(), 'the alarm is the derived slot, to the minute');
  // Back to the ward's real schedule for the stake-conference tests.
  assert.equal((await post('/admin/schedule', { dow: '0', time: '08:00' })).status, 302);
});

test('a real alarm fires, runs the handler, and sets the next one', async () => {
  const before = Date.now();
  const { alarm: woken } = await operator('wake', {});
  assert.ok(woken <= Date.now() + 1000, 'set to fire straight away');
  // Only the alarm handler re-derives the alarm on this path, so a later value means it ran.
  let alarm = woken;
  for (let i = 0; i < 50 && alarm === woken; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ({ alarm } = await state());
  }
  assert.notEqual(alarm, woken, 'the handler ran and rescheduled');
  assert.ok(alarm > before, 'into the future');
});

test('stake conference: a skipped Sunday sends nothing when its alarm fires', async () => {
  // Sunday 1 November 2026, 08:00 in Denver (clocks went back that night: 15:00 UTC).
  assert.equal((await post('/admin/skips', { skip_date: '2026-11-01', note: 'Stake conference' })).status, 302);
  await tick('2026-11-01T15:01:00Z');
  const { sends, queue } = await state();
  assert.equal(sends[0]?.type, 'skipped', 'the skip is recorded in the send history');
  assert.equal(queue, 0, 'and nothing was queued');

  // A second alarm on the same morning (a retry, a poke) must not change its mind.
  await tick('2026-11-01T15:30:00Z');
  assert.equal((await state()).sends.filter((s) => s.type !== 'manual').length, 1);
});

test('stake conference: the following Sunday sends as usual', async () => {
  await tick('2026-11-08T15:01:00Z');
  const { sends, queue } = await state();
  assert.equal(sends[0]?.type, 'scheduled');
  assert.equal(sends[0]?.batch.slot, '2026-11-08T08:00');
  assert.equal(sends[0]?.batch.total, 1, 'to the one subscriber');
  // Attempted in the same run. Whether it was accepted depends on the push service, which is not
  // reachable from here; what matters is that the ward sent.
  assert.equal(sends[0].batch.sent + sends[0].batch.failed + queue, 1);
});

test('stake conference: a manual send on Saturday goes out at once', async () => {
  // The Sunday send's retry is still parked, waiting out its backoff; count only what this send adds.
  const { queue: parked } = await state();
  const sent = await post('/admin/send', {
    title: 'Stake conference this weekend',
    body: 'Adult session tonight at 7.',
    link_target: 'announcements',
  });
  assert.equal(sent.status, 302);
  const { sends, queue, alarm } = await state();
  assert.equal(sends[0]?.type, 'manual');
  assert.equal(sends[0]?.title, 'Stake conference this weekend');
  assert.equal(sends[0]?.batch.total, 1);
  // Attempted inside the request, not left for a tick. (A retryable failure would be parked on the
  // queue and woken by the alarm — that rule is pinned against a stubbed push service in
  // test/push-queue.test.js, "a retry wakes the ward when its backoff ends".)
  assert.equal(sends[0].batch.sent + sends[0].batch.failed + (queue - parked), 1);
  assert.ok(alarm > Date.now(), 'and the ward still has its next alarm');
});
