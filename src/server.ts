/**
 * Node entry point.
 *
 * Everything runtime-specific lives here — loading `.env`, reading the app shell and service worker
 * off disk, serving `public/`, binding a socket, and starting the cron job. The routes themselves
 * are in `app.ts`, which knows none of that; the Cloudflare Workers entry (`worker.ts`) replaces
 * this file rather than the app.
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, assertConfig } from './config.js';
import { initDb, seedIfEmpty } from './db.js';
import { ensureAccessCode } from './access.js';
import { createSqliteDriver } from './driver-sqlite.js';
import { createFsFileStore } from './filestore-fs.js';
import { createSqlFileStore } from './filestore-sql.js';
import { loadStoredIdentity } from './identity.js';
import { initPush } from './push.js';
import { startScheduler, startProgramPurge, drainPendingOnBoot } from './schedule.js';
import { maybePurgeOldPrograms } from './programs.js';
import { maybePurgeHistory } from './tick.js';
import { purgeExpiredAccessTokens } from './db.js';
import { buildShell } from './shell.js';
import { loadWardSettings } from './ward-settings.js';
import { createApp } from './app.js';
import { logger } from './log.js';

const config = loadConfig(process.env);
assertConfig(config, { requireOrigin: true });
// Pick the storage driver — the one thing about `db.ts` that is runtime-specific. The Workers entry
// installs a D1 driver instead; everything downstream is identical.
await initDb(createSqliteDriver(config.databasePath));
await seedIfEmpty();
await ensureAccessCode(); // the member gate is always on: a fresh database gets its first code
await purgeExpiredAccessTokens(); // drop long-dead invite/device rows on boot
await loadStoredIdentity(); // VAPID keys and origin the environment left unset
await loadWardSettings(); // name, footer, timezone… as last saved on the dashboard (env = defaults)
initPush(); // structural check on the VAPID pair, wherever it came from

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const readAsset = (...parts: string[]) => readFileSync(join(publicDir, ...parts), 'utf8');

// Read the shell's files once at boot (each deploy restarts the process); the app templates them
// with the ward's settings, and again whenever an admin changes those.
const shell = {
  index: readAsset('index.html'),
  sw: readAsset('sw.js'),
  iosSplash: readAsset('icons', 'ios-splash.html'),
  assets: ['app.js', 'install.js', 'styles.css'].map((name) => readAsset(name)),
};

/** Socket peer address, used only to key rate limits when no reverse proxy is in front. */
function socketIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

// Uploaded images live on disk beside the database (see `uploadsPath`); the Workers entry binds an
// R2 bucket in the same slot, or the database. `IMAGE_STORE=database` picks the latter here too, so
// the Node suite can exercise the store a bucket-less Worker uses. Held in a binding of its own
// because the program retention sweep below needs the same store the routes use.
const fileStore =
  process.env.IMAGE_STORE === 'database' ? createSqlFileStore() : createFsFileStore(config.uploadsPath);

// The app templates the shell on first use; do it once now as well, so a broken index.html or sw.js
// (a missing placeholder) fails the boot instead of every page load.
await buildShell(shell);

const app = createApp({
  shell,
  log: logger,
  ipFallback: socketIp,
  // Behind a TLS reverse proxy set TRUST_PROXY=1 so rate limits key on the client the proxy saw;
  // without it every header is the client's own, so only the socket address counts.
  ipSource: ['1', 'true', 'yes'].includes((process.env.TRUST_PROXY ?? '').toLowerCase()) ? 'proxy' : 'socket',
  files: fileStore,
});

// Static assets last, so the dynamic routes above (/, /index.html, /sw.js, /manifest.webmanifest)
// win over a file of the same name on disk. serveStatic resolves `root` against the process's working directory, so
// derive a relative path rather than assuming the app was started from the repo root.
const staticRoot = relative(process.cwd(), publicDir) || '.';
const files = serveStatic({
  root: staticRoot,
  onFound: (path, c) => {
    // Revalidate on every use, and say ranges are served — the same headers worker-assets.ts sets.
    c.header('Cache-Control', 'public, max-age=0');
    c.header('Accept-Ranges', 'bytes');
    // Hono's mime table says `text/javascript`. Both are valid, but the service worker and the app
    // shell are cached by clients keyed on what they were first served, so every runtime sends
    // `application/javascript` (see worker-assets.ts).
    if (path.endsWith('.js')) c.header('Content-Type', 'application/javascript; charset=utf-8');
  },
});
app.use('*', async (c, next) => {
  const res = await files(c, next);
  // serveStatic answers conditional requests with a full 200. `Cache-Control: public, max-age=0`
  // makes browsers revalidate every asset on every load, so without this each revalidation would
  // re-download the file — a real cost on the phones this app is built for.
  if (res && res.status === 200 && c.req.method === 'GET') {
    const lastModified = res.headers.get('last-modified');
    const since = c.req.header('if-modified-since');
    if (lastModified && since) {
      const lm = Date.parse(lastModified);
      const ims = Date.parse(since);
      if (!Number.isNaN(lm) && !Number.isNaN(ims) && lm <= ims) {
        await res.body?.cancel(); // release the file handle we opened but won't send
        c.header('Content-Length', undefined); // a 304 describes no body of its own
        return c.body(null, 304);
      }
    }
  }
  return res;
});

// Always bind every interface: in dev that's localhost, and in a container it has to be 0.0.0.0
// or a reverse proxy can't reach the app. There's no third deployment shape worth an env var.
serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: '0.0.0.0',
    // A long keep-alive window, not Node's 5s default. A reverse proxy pools upstream connections,
    // and a server that closes one sooner than the proxy expects turns an idle moment into a 502.
    serverOptions: { keepAliveTimeout: 72_000 },
  },
  (info) => {
    logger.info({ address: info.address, port: info.port }, `Server listening on port ${info.port}`);
  },
);

try {
  await startScheduler(logger);
} catch (err) {
  logger.error(err);
  process.exit(1);
}

// Anything left in the send queue from a previous run (a redeploy mid-send) goes out now. Not
// awaited: boot must not wait on a round of push deliveries.
void drainPendingOnBoot(logger);

// Expired sacrament meeting programs (and their images) go at most once a local day — the Node
// counterpart to the Workers cron tick's sweep. Two hooks, because either alone has a hole: boot
// covers a deployment that redeploys often, and the daily croner job covers the one that doesn't (a
// process up for six months would otherwise never purge at all). `maybePurgeOldPrograms`'s own
// once-a-day guard is what keeps them from double-sweeping, and what keeps a restart loop from
// re-running it. The boot call isn't awaited, for the same reason the send drain isn't — a storage
// round trip must not hold the port closed.
// `.catch` as well as the function's own try: an unhandled rejection here ends the Node process.
maybePurgeOldPrograms(fileStore, logger, undefined, undefined, { untilDone: true }).catch((err) =>
  logger.error(err, 'the boot-time purge failed'),
);
maybePurgeHistory(logger).catch((err) => logger.error(err, 'the boot-time history sweep failed'));
startProgramPurge(fileStore, logger);
