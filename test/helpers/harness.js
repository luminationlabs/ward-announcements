/**
 * Booting the server the end-to-end tests drive, on either runtime.
 *
 * The same suite runs twice:
 *   npm test          → the Node entry (`dist/server.js`) on a throwaway SQLite file
 *   npm run test:worker → the Workers entry (`src/worker.ts` under `wrangler dev`) on a throwaway D1
 *
 * Only this file knows which one is running. Everything a test sees — the base URL, the cookie jar,
 * the admin password — is identical on both, so a divergence between the runtimes (a cookie the
 * Workers path doesn't set, a route the assets binding swallows) surfaces as a failing assertion
 * rather than as a second, drifting copy of the tests.
 */
import { spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthenticator } from './webauthn.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Which runtime is under test. `TEST_TARGET=worker` selects `wrangler dev`; anything else is Node. */
export const TARGET = process.env.TEST_TARGET === 'worker' ? 'worker' : 'node';

export const ADMIN_PASSWORD = 'test-admin-password';

/**
 * Running against the many-ward host (`src/host.ts`, a `test/wrangler.host*.jsonc` config). There an
 * unregistered hostname has no ward, so `startServer` registers `127.0.0.1` as one before returning,
 * and every suite runs unchanged against that ward.
 */
export const HOST_MODE = /wrangler\.host[^/]*\.jsonc$/.test(process.env.TEST_WRANGLER_CONFIG ?? '');

/** Register a ward on the many-ward host through the operator API. Returns what the API answered. */
export async function registerWard(base, ward) {
  const res = await fetch(`${base}/__operator/wards`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_PASSWORD}`, 'content-type': 'application/json' },
    body: JSON.stringify(ward),
  });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`registering ward ${ward.id} failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}


/**
 * A throwaway VAPID pair, made fresh for each run rather than committed: a key-shaped string in a
 * public repository draws secret-scanner reports however plainly it is labelled a fixture. Each test
 * file runs in its own process, so its server and its assertions see the same pair.
 */
export const TEST_VAPID = await generateVapid();

/**
 * The many-ward host's BACKUP_SEAL_KEY for this run, given to the server in host mode only (the
 * single-ward suites run without one). Fresh per run, for the same reason as the VAPID pair.
 */
export const TEST_SEAL_KEY = randomBytes(32).toString('base64url');

async function generateVapid() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: Buffer.from(raw).toString('base64url'), privateKey: jwk.d };
}

/**
 * A port unlikely to collide with a dev server or a parallel run of the other target.
 *
 * `node --test` runs each file in its own child process, so the pid term separates *runs* while
 * `offset` separates the files inside one run. The offset is scaled by the full width of the pid
 * term on purpose: at +1 per file, two files whose pids happened to land in the opposite order
 * picked the same port (pid 103 + offset 0 == pid 102 + offset 1), and the loser died with
 * `Address already in use` several tests into an otherwise passing suite.
 */
const PORT_SPREAD = 200;

export function testPort(offset = 0) {
  return 4310 + (process.pid % PORT_SPREAD) + offset * PORT_SPREAD;
}

const BASE_ENV = {
  ADMIN_PASSWORD,
  APP_NAME: 'Test Ward',
  APP_SHORT_NAME: 'Test',
  APP_DESCRIPTION: 'Test announcements',
  VAPID_SUBJECT: 'mailto:test@example.org',
  VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
  VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
  // Development on purpose: production mode marks both cookies `Secure`, which a browser (and this
  // suite's cookie jar, faithfully) would refuse to send back over plain http to 127.0.0.1.
  NODE_ENV: 'development',
  // The Node server believes X-Forwarded-For only from a proxy it was told about; the suites choose
  // their rate-limit buckets with that header, as a proxy in front would set it.
  TRUST_PROXY: '1',
  TZ: 'America/Denver',
  ...(HOST_MODE ? { BACKUP_SEAL_KEY: TEST_SEAL_KEY } : {}),
};

/**
 * Start a server and wait until it answers `/healthz`. Returns its base URL and a `stop()` that
 * takes the process (and, on Workers, the workerd children it spawned) down with it.
 */
export async function startServer({ port = testPort(), env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-test-'));
  const base = `http://127.0.0.1:${port}`;
  const vars = { ...BASE_ENV, ...env };
  const logPath = join(dir, 'server.log');
  const out = openSync(logPath, 'a');

  const child =
    TARGET === 'worker' ? spawnWorker(dir, port, vars, out) : spawnNode(dir, port, vars, out);

  let exited = null;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.on('exit', (code, signal) => {
    exited = `exit code ${code}${signal ? ` (${signal})` : ''}`;
  });
  const stop = () => shutdown(child, done, dir);

  // wrangler takes ~10s to boot a fresh isolate and D1; Node is up in well under a second on a
  // laptop, but a shared CI runner has been seen to hold a fresh process for far longer than that.
  // The budget is generous either way — a slow box that times out here reads as a mystery failure.
  const started = Date.now();
  const deadline = started + (TARGET === 'worker' ? 120_000 : 60_000);
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${TARGET} server exited before serving: ${exited}\n${tail(logPath)}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) {
        await res.text();
        if (HOST_MODE) await registerWard(base, { id: 'test', hostname: '127.0.0.1' });
        return { base, dir, stop };
      }
      last = `/healthz answered ${res.status}`;
    } catch (err) {
      last = `/healthz: ${err?.cause?.code ?? err?.code ?? err?.message ?? err}`; // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // The log before `stop()`: that removes the temp directory, log included, and a timeout once
  // reported "(no output captured)" for a server that may well have said exactly what was wrong.
  const log = tail(logPath);
  const state = exited ?? `pid ${child.pid} still running`;
  await stop();
  throw new Error(
    `${TARGET} server did not start on ${base} within ${Math.round((Date.now() - started) / 1000)}s (${state}; last: ${last})\n${log}`,
  );
}

function spawnNode(dir, port, vars, out) {
  return spawn('node', [join(ROOT, 'dist', 'server.js')], {
    env: {
      ...process.env,
      ...vars,
      DATABASE_PATH: join(dir, 'test.db'),
      PORT: String(port),
      // server.ts loads `.env` through dotenv, which fills in anything the test did not set — so a
      // developer's own PUBLIC_ORIGIN (or anything else) leaked into every run. Point it at a file
      // that does not exist; the worker target already displaces `.dev.vars` the same way.
      DOTENV_CONFIG_PATH: join(dir, 'no.env'),
    },
    stdio: ['ignore', out, out],
    detached: true,
  });
}

function spawnWorker(dir, port, vars, out) {
  // Config comes in as a generated dotenv file rather than as `--var` pairs: a var's value can
  // contain a colon (VAPID_SUBJECT is a `mailto:` URL) and `--env-file` also displaces the
  // developer's own `.dev.vars`, so a test run never depends on what is in their working copy.
  const envFile = join(dir, 'dev.vars');
  writeFileSync(
    envFile,
    Object.entries(vars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  );
  return spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      // Every `wrangler dev` also opens a devtools inspector, and they all default to 9229 — so the
      // Nth instance dies with "Address already in use (127.0.0.1:9229)" and every test in that file
      // fails with `worker server exited before serving`. Nothing in the suite uses the inspector;
      // it just has to be a port of its own. Derived from the (already unique) HTTP port so it
      // cannot collide either, and far enough above it to stay clear of the next file's block.
      '--inspector-port',
      String(port + 10_000),
      // A fresh local D1 per run. The schema is created lazily by the Worker's first request
      // (`initDb`), so there is nothing to migrate — an empty directory is a clean ward.
      '--persist-to',
      join(dir, 'state'),
      '--env-file',
      envFile,
      // The template (`wrangler.jsonc`) by default, which binds no R2 bucket — so images go to D1.
      // `test:worker` reruns the attachment suite with an R2 bucket bound through this.
      ...(process.env.TEST_WRANGLER_CONFIG ? ['--config', process.env.TEST_WRANGLER_CONFIG] : []),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // wrangler writes a dev registry and a log file next to the system temp dir or into the
        // repo; both can be denied in a sandbox, and a failure there kills the whole dev session.
        WRANGLER_REGISTRY_PATH: join(dir, 'registry'),
        WRANGLER_LOG_PATH: join(dir, 'wrangler.log'),
        WRANGLER_SEND_METRICS: 'false',
        CI: '1',
      },
      stdio: ['ignore', out, out],
      detached: true,
    },
  );
}

/**
 * Take the server down. Signals go to the whole process group (`-pid`), because wrangler is a
 * supervisor and it is its workerd child that holds the port — and SIGTERM first, because only
 * wrangler's own handler reaps that child cleanly. SIGKILL is the backstop for a run that hangs.
 */
async function shutdown(child, done, dir) {
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  // Clearing the timer matters: an abandoned 8s timeout keeps the test runner's event loop alive
  // long after the last assertion, turning a 300 ms suite into an 8 s one.
  let timer;
  await Promise.race([done, new Promise((resolve) => (timer = setTimeout(resolve, 8_000)))]);
  clearTimeout(timer);
  signal('SIGKILL');
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function tail(path, lines = 30) {
  try {
    const text = readFileSync(path, 'utf8');
    return text ? text.split('\n').slice(-lines).join('\n') : '(the server wrote nothing)';
  } catch {
    return '(no output captured)';
  }
}

// --- tiny HTTP client with per-identity cookie jars ---------------------------

/**
 * A client bound to one server. `as` names a cookie jar — a simulated browser, or a simulated
 * installed app, which is the distinction most of these tests turn on. Omit it for an anonymous
 * request.
 */
export function createClient(base) {
  const jars = new Map();
  const jarFor = (id) => {
    if (!jars.has(id)) jars.set(id, new Map());
    return jars.get(id);
  };
  const cookieHeader = (id) => {
    if (!id) return {};
    const jar = jarFor(id);
    if (jar.size === 0) return {};
    return { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
  };
  const absorb = (id, res) => {
    if (!id) return;
    const jar = jarFor(id);
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  };

  /**
   * `extraHeaders` exists for one thing: choosing the rate-limit bucket. The limiters key on
   * `clientIp`, which reads the *last* `X-Forwarded-For` element (what a proxy appends), so a test
   * that needs a login budget of its own can ask for one instead of borrowing from the file's.
   */
  return async function req(
    path,
    { as, method = 'GET', form, json, formData, headers: extraHeaders } = {},
  ) {
    const headers = { ...cookieHeader(as), ...extraHeaders };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    } else if (json) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (formData) {
      // No content-type of our own: fetch has to set it, because only fetch knows the multipart
      // boundary it generated. Setting one by hand yields a body the server cannot parse.
      body = formData;
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    absorb(as, res);
    return res;
  };
}

/**
 * Add a person as the owner (`adminAs`'s jar must hold an owner or admin session), then create their
 * passkey from the invite link with a software authenticator — what opening the link on a phone
 * does — leaving `as`'s jar signed in as them. `origin` is the site the passkey is for: the server's
 * PUBLIC_ORIGIN when the suite sets one, else the test server's own address.
 */
export async function addPersonWithPasskey(req, { as, origin, role = 'editor', name = 'Test Person', adminAs = 'admin' }) {
  const created = await req('/admin/people', { as: adminAs, method: 'POST', form: { name, role } });
  const id = Number(/\/admin\/people\/(\d+)/.exec(created.headers.get('location') ?? '')?.[1]);
  if (!id) throw new Error(`adding a person failed: ${created.status} ${created.headers.get('location')}`);
  const page = await (await req(`/admin/people/${id}`, { as: adminAs })).text();
  const token = /#t=([A-Za-z0-9_-]+)/.exec(page)?.[1];
  if (!token) throw new Error('no invite link on the person page');
  const authenticator = createAuthenticator({ origin });
  const options = await (await req('/admin/passkey/register/options', { as, method: 'POST', json: { token } })).json();
  const response = await authenticator.create(options);
  const verify = await req('/admin/passkey/register/verify', { as, method: 'POST', json: { token, response } });
  return { id, token, authenticator, verify };
}

/** Sign in with a passkey the authenticator already holds, into `as`'s jar. Returns the verify response. */
export async function signInWithPasskey(req, authenticator, { as }) {
  const options = await (await req('/admin/passkey/login/options', { as, method: 'POST' })).json();
  const response = await authenticator.get(options);
  return req('/admin/passkey/login/verify', { as, method: 'POST', json: response });
}

/**
 * Unlock `as`'s jar as a member with the current access code, read off the dashboard by `adminAs`.
 * The gate is always on — every fresh test server mints its first code at boot — so anything that
 * reads the public API (`/api/announcements`, `/api/program`, `/api/pages`) does it as a member.
 */
export async function unlockMember(req, as, { adminAs = 'admin' } = {}) {
  const html = await (await req('/admin', { as: adminAs })).text();
  const code = /#code=([a-z0-9-]+)/.exec(html)?.[1];
  if (!code) throw new Error('no access code on the dashboard — is adminAs signed in?');
  const res = await req('/api/access', { as, method: 'POST', json: { code } });
  if (res.status !== 200) throw new Error(`unlocking ${as} failed: ${res.status}`);
}
