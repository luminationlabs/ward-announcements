/**
 * What the two Workers entries share — the single-ward `worker.ts` and the many-ward `host.ts`:
 * reading `public/` through Cloudflare's static-assets binding, and turning the env into config vars.
 */
import type { Env as ConfigEnv } from './config.js';
import type { ShellSources } from './shell.js';
import { logger } from './log.js';

/**
 * Vars only. Cloudflare hands vars, secrets and bindings over on one object; the string-valued
 * entries are the vars and secrets that become the config, and the rest are bindings.
 */
export function stringVars(env: Record<string, unknown>): ConfigEnv {
  const vars: ConfigEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') vars[key] = value;
  }
  return vars;
}

/** The static-assets binding, as configured in wrangler (`assets.binding`). */
export interface AssetsLike {
  fetch(request: Request): Promise<Response>;
}

/** Read one file out of `public/` through the assets binding. */
async function readAsset(assets: AssetsLike, path: string): Promise<string> {
  const res = await assets.fetch(new Request(`https://assets.invalid${path}`));
  if (!res.ok) throw new Error(`Missing static asset ${path} (${res.status})`);
  return res.text();
}

/**
 * The same read, for a file the shell can do without.
 *
 * Exists for `public/icons/`, which is **generated** by `npm run icons` and git-ignored: `npm run
 * cf:deploy` builds it first, but a bare `wrangler deploy`, a CI job that skips the build, or a
 * dashboard rollback ships without it. Thrown out of boot, a missing splash file would 500
 * *every* route — the health check included — with no log line naming the file. A missing decoration is a warning; it is not an outage.
 */
async function optionalAsset(assets: AssetsLike, path: string): Promise<string> {
  try {
    return await readAsset(assets, path);
  } catch (err) {
    logger.warn({ err, path }, 'optional static asset is missing; continuing without it');
    return '';
  }
}

/** The raw shell files `createApp` templates: seven subrequests, so only for a booting app. */
export async function readShellSources(assets: AssetsLike): Promise<ShellSources> {
  return {
    index: await readAsset(assets, '/index.html'),
    sw: await readAsset(assets, '/sw.js'),
    // Optional: generated, git-ignored, and cosmetic (iOS launch images). See `optionalAsset`.
    iosSplash: await optionalAsset(assets, '/icons/ios-splash.html'),
    assets: await Promise.all(
      ['/app.js', '/install.js', '/styles.css'].map((name) => readAsset(assets, name)),
    ),
  };
}

/**
 * The static-asset fallback, reached only after every route has declined — which is why
 * `run_worker_first` is on in wrangler.jsonc: the member access gate has to see the request before
 * the assets binding answers it, and the shell, service worker and manifest are all served
 * dynamically from files of the same name in `public/`.
 */
export async function serveAsset(assets: AssetsLike, request: Request): Promise<Response | undefined> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
  const res = await assets.fetch(request);
  if (res.status === 404) return undefined; // let the app's own 404 payload answer
  if (res.status === 304) return res;

  // The same headers the Node deployment sends, so caches and installed clients see one behaviour
  // whatever the runtime: a `public, max-age=0` revalidation policy, and `application/javascript`
  // for scripts where Cloudflare would say `text/javascript`.
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'public, max-age=0');
  headers.set('Accept-Ranges', 'bytes');
  if (new URL(request.url).pathname.endsWith('.js')) {
    headers.set('Content-Type', 'application/javascript; charset=utf-8');
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
