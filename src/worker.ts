/**
 * Cloudflare Workers entry point.
 *
 * The counterpart to `server.ts`: same app, different runtime services. Three differences are
 * worth knowing before editing this file.
 *
 * 1. **There is no boot.** A Worker has no process that starts once and stays up; an isolate is
 *    created on demand and can be discarded at any time. So everything `server.ts` does at boot —
 *    read the config, install the storage driver, create the schema, template the shell — happens
 *    on first use here and is memoised in a module-level promise for the life of the isolate.
 * 2. **A send is drained by the cron trigger.** The free plan allows ~10 ms of CPU per invocation,
 *    which is nowhere near a whole ward's worth of push encryptions, so `scheduled()` runs every
 *    minute: it drains one chunk of the send queue if there is one, and otherwise asks whether the
 *    weekly digest is due. Node keeps croner (`schedule.ts`); both share the arithmetic in
 *    `schedule-core.ts`.
 * 3. **Rate limiting is per-isolate.** `ratelimit.ts` counts in memory, and Cloudflare may run many
 *    isolates at once, so a limit is enforced per instance rather than globally. Accepted for a
 *    ward-sized audience — the limits exist to blunt password guessing and junk subscriptions, not
 *    to meter an API. A genuinely global limit needs Durable Objects or Cloudflare's own rate
 *    limiting binding.
 *
 * Typing note: this file deliberately does **not** import `@cloudflare/workers-types`. Those types
 * are published as ambient globals and would redefine `Buffer`, `fetch` and friends across the
 * whole project, breaking every Node-side module (the same reason `driver-d1.ts` describes D1
 * structurally). The handful of bindings used here are declared structurally instead, so the one
 * `tsconfig.json` type-checks both runtimes and wrangler/esbuild does the bundling.
 */
import { ConfigError, assertConfig, loadConfig } from './config.js';
import { createApp } from './app.js';
import { createD1Driver, type D1Like } from './driver-d1.js';
import type { FileStore } from './filestore.js';
import { createR2FileStore, type R2BucketLike } from './filestore-r2.js';
import { createSqlFileStore } from './filestore-sql.js';
import { initDb, purgeExpiredAccessTokens, seedIfEmpty, setDriver } from './db.js';
import { loadStoredIdentity } from './identity.js';
import { ensureAccessCode } from './access.js';
import { logger } from './log.js';
import { initPush } from './push.js';
import { seedScheduleDefaults } from './schedule-core.js';
import { buildShell } from './shell.js';
import { runTick } from './tick.js';
import { loadWardSettings } from './ward-settings.js';
import { readShellSources, serveAsset, stringVars, type AssetsLike } from './worker-assets.js';

/**
 * Bindings and vars. Cloudflare hands both on one object; the string-valued entries are the vars
 * and secrets that become the config, and the rest are bindings.
 */
export interface WorkerEnv {
  DB: D1Like;
  ASSETS: AssetsLike;
  /** Optional R2 bucket for uploaded images; without one they are stored in D1 (`filestore-sql.ts`). */
  IMAGES?: R2BucketLike;
  [key: string]: unknown;
}

/**
 * Cloudflare's cron controller, structurally. (The `ExecutionContext` third argument is deliberately
 * not declared: `scheduled()` doesn't take it — the runtime keeps the invocation alive for the
 * promise the handler returns, so there is nothing to `waitUntil`.)
 */
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

// ---------------------------------------------------------------------------
// One-time (per isolate) setup
// ---------------------------------------------------------------------------

/**
 * Boot is in **two halves**, and the split is a subrequest budget, not tidiness.
 *
 * `core` is everything the cron tick needs: config, the D1 driver, the schema check, the seeds.
 * `app` is everything only a *request* needs — and that means the app shell, which is six
 * `ASSETS.fetch` calls (index.html, sw.js, the iOS splash, and three bundled assets). Each of those
 * is a subrequest, and a Workers invocation gets fifty, so a cold isolate woken by the cron trigger
 * would otherwise spend six of them templating a page nobody was going to look at. `scheduled()` awaits
 * `core` only.
 */
let core: Promise<void> | null = null;
let booted: Promise<App> | null = null;

/** The app this file builds, typed from `createApp` so its context variables come along. */
type App = ReturnType<typeof createApp>;

/**
 * The image store this isolate booted with.
 *
 * The cron tick needs it too — the program retention sweep deletes objects, not just rows — and
 * `scheduled()` gets no Hono context to pull it from, so `initCore()` parks it here.
 */
let fileStore: FileStore | null = null;


/**
 * Config, storage and schema. Everything both a request and a cron tick need, and nothing else.
 *
 * Five queries on a warm database: the `schema_version` check, the seed marker, the schedule seed's
 * pair, the expired-token purge and the ward settings — and a sixth when the vars leave the VAPID
 * keys or the origin to the database.
 */
async function initCore(env: WorkerEnv): Promise<void> {
  loadConfig(stringVars(env));
  assertConfig();

  setDriver(createD1Driver(env.DB));
  // The only place the schema is ever created or migrated on this runtime: there is no deploy step
  // that could run a migration for us. Cheap when there is nothing to do — see `initDb`.
  await initDb();
  await seedIfEmpty();
  await ensureAccessCode(); // the member gate is always on: a fresh database gets its first code
  await seedScheduleDefaults();
  await purgeExpiredAccessTokens(); // drop long-dead invite/device rows; cheap, and rarely runs
  await loadStoredIdentity(); // VAPID keys and origin the vars left unset; no query when both are set
  await loadWardSettings(); // name, footer, timezone… as last saved on the dashboard (vars = defaults)
  initPush(); // structural check on the VAPID pair, wherever it came from

  // Images go to R2 when a bucket is bound, and otherwise into D1 itself (`filestore-sql.ts`): the
  // template config binds no bucket, because enabling R2 asks for a payment card even on its free
  // tier. Set here rather than with the app because the cron tick's retention sweep needs it and
  // never builds an app.
  fileStore = env.IMAGES ? createR2FileStore(env.IMAGES) : createSqlFileStore();
}

async function boot(env: WorkerEnv): Promise<App> {
  await coreFor(env);

  const shell = await readShellSources(env.ASSETS);
  await buildShell(shell); // fail the boot, not every page load, on a broken index.html or sw.js

  return createApp({
    shell, // templated by the app, and again whenever the ward's settings change
    log: logger,
    assets: (c) => serveAsset(env.ASSETS, c.req.raw),
    files: fileStore!,
    // A manual send delivers its first chunk in the request and leaves the rest to the cron tick:
    // an admin gets immediate feedback without the request having to spend the whole ward's CPU.
    drainSends: 'background',
  });
}

function coreFor(env: WorkerEnv): Promise<void> {
  if (!core) {
    core = initCore(env).catch((err) => {
      core = null; // don't cache a failed boot — the next invocation retries
      throw err;
    });
  }
  return core;
}

function appFor(env: WorkerEnv): Promise<App> {
  if (!booted) {
    booted = boot(env).catch((err) => {
      booted = null; // don't cache a failed boot — the next request retries
      throw err;
    });
  }
  return booted;
}

// ---------------------------------------------------------------------------
// The per-minute tick
// ---------------------------------------------------------------------------

/**
 * The health check, answered **before** anything is booted.
 *
 * Deliberately independent of the shell assets, the config and D1: this is the endpoint a deploy
 * check, an uptime monitor and the test harness use to ask "is this Worker running at all", and a
 * boot failure must not turn that answer into "500, and nothing in the log".
 * Byte-identical to the app's own `/healthz` so the Node entry and this one stay interchangeable.
 */
function healthz(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      // The plain probe deliberately answers before anything boots (see `healthz`), which means it
      // also answers 200 while every real route is on the 503 below. `?deep=1` is for the monitor
      // that wants to know the difference: it awaits config + driver + schema, and nothing more.
      if (url.searchParams.get('deep') !== '1') return healthz();
      try {
        await coreFor(env);
        return healthz();
      } catch (err) {
        logger.error(err, 'deep health check failed');
        return new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
    }
    let app: App;
    try {
      app = await appFor(env);
    } catch (err) {
      // Boot is the one failure the app's own `onError` can never see, because there is no app yet.
      // Left uncaught this surfaced as Cloudflare's opaque 1101 ("Worker threw an exception") on
      // every route with nothing written to the log to say which asset, binding or var was missing.
      // A logged 503 says "the deployment is broken, come back" — and, being a boot failure rather
      // than a request one, the next request retries from scratch (`appFor` clears its cache).
      logger.error(err, 'worker boot failed');
      // A configuration mistake says which setting to fix (it names settings, never values); anything
      // else stays a bare "unavailable".
      const detail = err instanceof ConfigError ? `\n\nSetup problem: ${err.message}\n` : '';
      return new Response(`This app is temporarily unavailable. Please try again shortly.\n${detail}`, {
        status: 503,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': '30',
        },
      });
    }
    // The app never reads `c.env` or `c.executionCtx` — every binding it needs was closed over at
    // boot — so the request is all it is handed.
    return app.fetch(request);
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    // No `ctx.waitUntil` here: the runtime already keeps a `scheduled()` invocation alive until the
    // promise it returns settles, and registering the same awaited promise twice bought nothing
    // except a second place for an unhandled rejection to surface. The try/catch is the point — a
    // throwing tick must be logged, not turned into a silent cron failure.
    try {
      await coreFor(env); // config + driver + schema, memoised; no app shell, no ASSETS reads
      await runTick(new Date(controller.scheduledTime), fileStore, logger, 'chunk');
    } catch (err) {
      logger.error(err, 'scheduled tick failed');
    }
  },
};
