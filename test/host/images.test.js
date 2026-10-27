/**
 * Images on the many-ward host with an R2 bucket bound (`test/wrangler.host-r2.jsonc`): every ward
 * shares the one bucket, each under a prefix of its own (`withPrefix` in src/filestore.ts). The
 * prefix is load-bearing — `/images/:key` serves whatever key it is given, so without it ward B
 * would serve ward A's flyer to anyone who had the link. Local `wrangler dev` only; part of
 * `npm run test:host`.
 */
process.env.TEST_TARGET = 'worker';
process.env.TEST_WRANGLER_CONFIG = 'test/wrangler.host-r2.jsonc';

const { test, before, after } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { ADMIN_PASSWORD, createClient, registerWard, startServer, testPort } = await import('../helpers/harness.js');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server;
let req;
let toB;

before(async () => {
  server = await startServer({ port: testPort(11) });
  req = createClient(server.base);
  toB = createClient(server.base.replace('127.0.0.1', 'localhost'));
  await registerWard(server.base, { id: 'ward-b', hostname: 'localhost' });
  await req('/admin/login', { as: 'admin', method: 'POST', form: { password: ADMIN_PASSWORD } });
});
after(() => server?.stop());

test("an image uploaded to ward A is served by A and not by B", async () => {
  await req('/admin/announcements', { as: 'admin', method: 'POST', form: { title: 'Flyer', body: 'x', published: '1' } });
  const html = await (await req('/admin', { as: 'admin' })).text();
  const id = html.match(/<li class="row" data-id="(\d+)"/)?.[1];
  assert.ok(id);
  const data = new FormData();
  data.append('owner_type', 'announcement');
  data.append('owner_id', id);
  data.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'flyer.png');
  const uploaded = await req('/admin/attachments', { as: 'admin', method: 'POST', formData: data });
  assert.equal(uploaded.status, 201);
  const { key } = await uploaded.json();

  const fromA = await req(`/images/${key}`);
  assert.equal(fromA.status, 200);
  assert.deepEqual(Buffer.from(await fromA.arrayBuffer()), PNG_1X1);
  assert.equal((await toB(`/images/${key}`)).status, 404);
});
