/**
 * The platform operator's tools for the many-ward host (`host.ts`; docs/DEPLOYMENT.md § 2b).
 *
 * Two doors to the same actions:
 * - **The API**, `/__operator/…` on any hostname, for scripts: `Authorization: Bearer <password>`.
 * - **A page**, at the root of `OPERATOR_HOST` (say `admin.example.org`), for a person: sign in with
 *   the same password and get a list of wards with their state and the actions below.
 *
 * Either way it is 404 to anyone without the password, and nothing at all when `ADMIN_PASSWORD` is
 * unset. The actions: create a ward (optionally with its first admin's invite link), list them,
 * suspend and resume, move to a new address, mint a fresh admin invite (the way back in for a ward
 * whose admins all lost their passkeys), export a ward (the page: the full ZIP backup, built in the
 * operator's browser; the API: its data as JSON), import a backup, delete a ward, and — for
 * tests and for "is it stuck?" — run, inspect or wake a ward's scheduled work.
 *
 * This module runs **outside any ward** (the host is in multi-ward mode), so it must not touch
 * `config`, `db.ts` or anything else that reads the current ward: it reaches a ward only through
 * `OperatorDeps.ward()`, the front door's private channel to that ward's Durable Object.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { scriptTag, withContentSecurityPolicy } from './csp.js';
import { getCookie } from 'hono/cookie';
import { appendCookie } from './http.js';
import { isValidKey } from './filestore.js';
import { logger } from './log.js';
import { failureLimit, rateLimit } from './ratelimit.js';
import { DISCLAIMER, timezoneSelect } from './views.js';
import { MAX_IMAGE_BATCH_BYTES, MAX_IMPORT_JSON_BYTES } from './ward-import.js';

export interface WardRecord {
  id: string;
  hostname: string;
  status: 'active' | 'suspended';
}

export interface OperatorDeps {
  /** The platform password (`ADMIN_PASSWORD`). Empty disables everything here. */
  password: string;
  /** Where the operator page is served (`OPERATOR_HOST`); empty means API only. */
  operatorHost: string;
  /**
   * The domain every ward is a subdomain of (`WARD_DOMAIN`, say `example.org`) — the one the host's
   * wildcard route covers. The page then asks only for the subdomain. Empty: it asks for the whole
   * hostname. The API always takes a whole hostname.
   */
  wardDomain: string;
  /** The timezone "Add a ward" starts on (the host's `TZ`). */
  defaultTimezone: string;
  /** Production: the session cookie is `Secure`. */
  secure: boolean;
  /**
   * A random secret the host keeps (the registry Durable Object, minted once), mixed into the
   * session cookie's key alongside the password — see `sessionKey`. Read once and cached by the app.
   */
  sessionSecret(): Promise<string>;
  registry: {
    list(): Promise<WardRecord[]>;
    create(ward: { id: string; hostname: string }): Promise<{ ok: boolean; error?: string }>;
    update(id: string, patch: Partial<Pick<WardRecord, 'status' | 'hostname'>>): Promise<{ ok: boolean; error?: string }>;
    remove(id: string): Promise<void>;
  };
  /** One call on a ward's private channel (see `WardDO.internal` in host.ts). */
  ward(id: string, action: string, body?: unknown): Promise<Response>;
  /** Drop a hostname from the front door's lookup cache after a change. */
  forget(hostname: string): void;
  /** A shipped static file (`public/`), for the page's own scripts: `/zip.js`, `/backup-zip.js`. */
  asset?(path: string): Promise<Response | undefined>;
}

/**
 * The platform password, if it is fit to be one. It is the operator's API token, the operator
 * page's sign-in **and** the owner sign-in on every ward of the host — and each ward's login has
 * its own rate limit, so a guesser gets a fresh budget per ward. A short one is therefore refused
 * outright (and said so in the log): no operator, no owner sign-in, the wards run by their people,
 * until a long passphrase is set. (Here rather than in host.ts because a Worker's entry module may
 * export only handlers and classes.)
 */
export const MIN_PLATFORM_PASSWORD = 16;
export function platformPassword(env: Record<string, unknown>): string {
  const password = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '';
  if (password && password.length < MIN_PLATFORM_PASSWORD) {
    logger.error(
      { length: password.length, required: MIN_PLATFORM_PASSWORD },
      'ADMIN_PASSWORD is too short for a many-ward host; the operator tools and owner sign-in are off',
    );
    return '';
  }
  return password;
}

/**
 * Vars that name one deployment's identity, which on a host every ward has of its own: its address
 * is its hostname (`WardDO.applyIdentity`), and its push keys are the pair stored in its own
 * database (identity.ts). Set host-wide they would apply to every ward at once — one `PUBLIC_ORIGIN`
 * for every ward's passkeys, notification links and share links, one VAPID pair signing every
 * ward's sends while each ward's stored pair (and Import Backup's "keys supplied" report) said
 * otherwise. So a ward is configured without them (`wardVars`); `VAPID_SUBJECT` stays host-wide,
 * since it is the operator's contact address and meant to be, and so does `BACKUP_SEAL_KEY`: one
 * key seals every ward's backup and export, which is what lets any of them import back here.
 *
 * One exception, in development only: under `wrangler dev` every ward answers on `127.0.0.1:<port>`,
 * which is no https address to derive an origin from, so a host-wide `PUBLIC_ORIGIN` is the only
 * way a local ward gets one — the suites (test/roles.test.js) rely on that.
 */
const PER_WARD_VARS = ['PUBLIC_ORIGIN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] as const;
export function wardVars<V extends Record<string, string | undefined>>(vars: V): { vars: V; ignored: string[] } {
  const production = vars.NODE_ENV === 'production';
  const ignored = PER_WARD_VARS.filter((key) => vars[key] && (production || key !== 'PUBLIC_ORIGIN'));
  const kept = { ...vars };
  for (const key of ignored) delete kept[key];
  return { vars: kept, ignored };
}

const WARD_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
/** One DNS label: what goes in front of WARD_DOMAIN. */
const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const SESSION_COOKIE = 'operator_session';
/** The Ward settings card's limit for the app name, and the People form's for a person's name. */
const NAME_MAX = 60;
const SHORT_NAME_MAX = 20;
const PERSON_MAX = 80;
const SESSION_SECONDS = 12 * 60 * 60;

class Refusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// The actions, shared by the API and the page
// ---------------------------------------------------------------------------

/** What the dashboard and the API's report show for one ward. */
export interface WardReport extends WardRecord {
  schemaVersion: string | null;
  subscribers: number | null;
  alarm: number | null;
  lastSend: { title: string; sent_at: string; type: string } | null;
  error?: string;
}

function actions(deps: OperatorDeps) {
  const find = async (id: string) => {
    const ward = (await deps.registry.list()).find((w) => w.id === id);
    if (!ward) throw new Refusal('No such ward.', 404);
    return ward;
  };
  const call = async (id: string, action: string, body?: unknown) => {
    const res = await deps.ward(id, action, body);
    if (!res.ok) throw new Refusal(`The ward answered ${res.status} to ${action}.`);
    return res.json() as Promise<Record<string, unknown>>;
  };

  return {
    find,
    call,

    async create(input: {
      id?: unknown;
      hostname?: unknown;
      name?: unknown;
      shortName?: unknown;
      timezone?: unknown;
      admin?: unknown;
    }) {
      const id = String(input.id ?? '').trim().toLowerCase();
      const hostname = String(input.hostname ?? '').trim().toLowerCase();
      if (!WARD_ID.test(id)) throw new Refusal('A ward id is 2–41 lowercase letters, digits and hyphens.');
      if (!HOSTNAME.test(hostname)) throw new Refusal('That is not a valid host name.');
      if (hostname === deps.operatorHost) throw new Refusal('That is the operator page’s own address.');
      // Everything provisioning could refuse is checked here, before anything is written.
      const name = String(input.name ?? '').trim();
      const admin = String(input.admin ?? '').trim();
      if (name.length > NAME_MAX) throw new Refusal(`A ward name is at most ${NAME_MAX} characters.`);
      if (admin.length > PERSON_MAX) throw new Refusal(`An admin's name is at most ${PERSON_MAX} characters.`);
      const shortName = String(input.shortName ?? '').trim();
      if (shortName.length > SHORT_NAME_MAX) {
        throw new Refusal(`A home-screen name is at most ${SHORT_NAME_MAX} characters (about 12 fit under the icon).`);
      }
      const timezone = String(input.timezone ?? '').trim();
      if (timezone && !isTimeZone(timezone)) throw new Refusal(`"${timezone}" is not a timezone this server knows.`);
      const created = await deps.registry.create({ id, hostname });
      if (!created.ok) throw new Refusal(created.error ?? 'That id or hostname is already registered.', 409);
      deps.forget(hostname);
      try {
        const provisioned = await call(id, 'provision', { id, hostname, name, shortName, timezone, admin });
        return { id, hostname, ...provisioned } as { id: string; hostname: string; invite: string | null };
      } catch (err) {
        // Undo, so the same create can simply be tried again rather than hitting "already registered".
        await call(id, 'destroy', {}).catch(() => undefined);
        await deps.registry.remove(id);
        deps.forget(hostname);
        throw err;
      }
    },

    async setStatus(id: string, status: WardRecord['status']) {
      const ward = await find(id);
      // The ward first: a suspended ward must stop *sending* (its alarm), not only stop answering.
      await call(id, 'status', { suspended: status === 'suspended' });
      await deps.registry.update(id, { status });
      deps.forget(ward.hostname);
    },

    async move(id: string, hostnameInput: unknown) {
      const ward = { ...(await find(id)) }; // a copy: the old address must survive the update below
      const hostname = String(hostnameInput ?? '').trim().toLowerCase();
      if (!HOSTNAME.test(hostname)) throw new Refusal('That is not a valid host name.');
      if (hostname === deps.operatorHost) throw new Refusal('That is the operator page’s own address.');
      const moved = await deps.registry.update(id, { hostname });
      if (!moved.ok) throw new Refusal(moved.error ?? 'That hostname is already registered.', 409);
      deps.forget(ward.hostname);
      deps.forget(hostname);
      try {
        await call(id, 'move', { hostname });
      } catch (err) {
        // The registry must not point at an address the ward does not know it has.
        await deps.registry.update(id, { hostname: ward.hostname });
        deps.forget(hostname);
        throw err;
      }
    },

    async invite(id: string, name: unknown) {
      await find(id);
      const admin = String(name ?? '').trim();
      if (!admin) throw new Refusal('Give the admin a name.');
      return (await call(id, 'invite', { admin })) as { invite: string };
    },

    /** The ward's data as JSON — every table, the same shape as its own `/admin/backup.json`. */
    async export(id: string) {
      await find(id);
      return call(id, 'export');
    },

    /**
     * One of the ward's images, read through the ward's own store (its R2 prefix or its
     * `file_chunks`), for the full backup the page builds. Here and not from the ward's own
     * `/images/<key>` because a cross-origin fetch of that has no CORS headers to read it by.
     */
    async image(id: string, key: string): Promise<Response> {
      await find(id);
      if (!isValidKey(key)) throw new Refusal('No such image.', 404);
      const res = await deps.ward(id, 'image', { key });
      if (res.status === 404) throw new Refusal('No such image.', 404);
      if (!res.ok) throw new Refusal(`The ward answered ${res.status} to image.`);
      return res;
    },

    /**
     * Replace everything in a ward with a backup (see `WardDO.importBackup` in host.ts). The
     * operator types the ward's address to confirm, as for a delete: this one cannot be undone
     * either. The ward's own refusal (a bad file, a newer schema, a mismatched key pair) comes back
     * as its message, not as a status code.
     */
    async importBackup(
      id: string,
      input: { backup?: unknown; confirm?: unknown; vapidPublicKey?: unknown; vapidPrivateKey?: unknown; vapidSubject?: unknown },
    ) {
      const ward = await find(id);
      if (String(input.confirm ?? '').trim().toLowerCase() !== ward.hostname) {
        throw new Refusal(`To import into this ward, type its address ("${ward.hostname}") to confirm.`);
      }
      if (!input.backup || typeof input.backup !== 'object') throw new Refusal('Choose a backup file to import.');
      const { vapidPublicKey, vapidPrivateKey, vapidSubject } = input;
      const res = await deps.ward(id, 'import', { backup: input.backup, options: { vapidPublicKey, vapidPrivateKey, vapidSubject } });
      const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Refusal(typeof answer.error === 'string' ? answer.error : `The ward answered ${res.status} to import.`);
      return answer;
    },

    /** Store a batch of an imported backup's images in the ward (keys checked against its rows). */
    async storeImages(id: string, images: unknown) {
      await find(id);
      if (!Array.isArray(images) || images.length === 0) throw new Refusal('No images in this batch.');
      return call(id, 'images', { images });
    },

    async remove(id: string, confirm: unknown) {
      const ward = await find(id);
      if (confirm !== id) throw new Refusal(`To delete a ward, type its id ("${id}") to confirm.`);
      // The ward's data first, the registry row last: if either half fails the ward is still
      // listed, so the delete can simply be tried again. For that retry to work, destroying a ward
      // already destroyed must count as done — the host answers `ok` to it (`destroy` in host.ts),
      // and a 404 is read the same way: a deleted object's answer to anything else, so the ward is
      // gone and only its row is left. Before this, a delete that failed between the two halves
      // (the registry briefly unreachable) left an id and hostname reserved for ever.
      const res = await deps.ward(id, 'destroy', {});
      if (!res.ok && res.status !== 404) throw new Refusal(`The ward answered ${res.status} to destroy.`);
      await deps.registry.remove(id);
      deps.forget(ward.hostname);
    },

    async report(): Promise<WardReport[]> {
      const wards = await deps.registry.list();
      return Promise.all(
        wards.map(async (ward) => {
          try {
            const state = await call(ward.id, 'state');
            const sends = (state.sends as WardReport['lastSend'][] | undefined) ?? [];
            return {
              ...ward,
              schemaVersion: (state.schemaVersion as string | null) ?? null,
              subscribers: (state.subscribers as number | null) ?? null,
              alarm: (state.alarm as number | null) ?? null,
              lastSend: sends[0] ?? null,
            };
          } catch (err) {
            return { ...ward, schemaVersion: null, subscribers: null, alarm: null, lastSend: null, error: String(err) };
          }
        }),
      );
    },

    /** Wake every active ward once: the hourly safety net under the alarms, and pending migrations. */
    async pokeAll() {
      const results: { id: string; ok: boolean; schemaVersion?: string | null }[] = [];
      for (const ward of await deps.registry.list()) {
        if (ward.status !== 'active') continue;
        try {
          const state = await call(ward.id, 'poke');
          results.push({ id: ward.id, ok: true, schemaVersion: (state.schemaVersion as string | null) ?? null });
        } catch {
          results.push({ id: ward.id, ok: false });
        }
      }
      return results;
    },
  };
}

export type OperatorActions = ReturnType<typeof actions>;

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function sameSecret(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Whether an Origin header names this request's own host. `null` (an opaque origin) and junk are not. */
function sameHost(origin: string, url: string): boolean {
  try {
    return new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}

/**
 * The session cookie's key: the password *and* a random secret the host holds (`sessionSecret` in
 * the deps; the registry Durable Object mints it once). The password alone made a stolen cookie —
 * an HMAC over a known plaintext — an offline oracle for guessing the password at full speed, with
 * no rate limit. With the secret folded in, the cookie reveals nothing about the password unless
 * the registry's storage is in hand too, and changing the password still signs the operator out.
 * The API's bearer token stays the password itself; that is a credential sent on purpose, not one
 * left in a browser.
 */
const sessionKey = (password: string, secret: string) =>
  createHash('sha256').update(`operator-session::${password}::${secret}`).digest();
const sign = (password: string, secret: string, value: string) =>
  createHmac('sha256', sessionKey(password, secret)).update(value).digest('base64url');

function hasSession(c: Context, password: string, secret: string): boolean {
  // No password, no sessions — not a formality: the cookie key is derived from the password, and
  // the key derived from an empty one is public, so anyone could sign a session (the same guard
  // auth.ts has for a ward with no owner). The secret is never empty (the registry mints it), but
  // an empty one would halve the key's secrecy, so it is refused the same way.
  if (!password || !secret) return false;
  const raw = getCookie(c, SESSION_COOKIE) ?? '';
  const [issued, sig] = raw.split('.');
  if (!issued || !sig) return false;
  const expected = sign(password, secret, issued);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = Date.now() / 1000 - Number(issued);
  return age >= -60 && age <= SESSION_SECONDS;
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/** A request-size cap that answers in the same JSON shape as every other refusal here. */
const limitBody = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: `That is more than ${Math.round(maxSize / (1024 * 1024))} MB in one request.` }, 413),
  });

export function createOperatorApp(deps: OperatorDeps): Hono {
  const act = actions(deps);
  const app = new Hono();
  const notFound = (c: Context) => c.text('Not found', 404);
  const onPage = (c: Context) => !!deps.operatorHost && new URL(c.req.url).hostname === deps.operatorHost;

  // The Content Security Policy and this response's script nonce (src/csp.ts), as the ward app does.
  app.use('*', withContentSecurityPolicy);
  app.use('*', async (c, next) => {
    await next();
    // `private` too: an exported ward's images and data pass through here, and no cache should keep them.
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Robots-Tag', 'noindex');
    c.header('X-Frame-Options', 'DENY');
    // `same-origin`, not `no-referrer`: under `no-referrer` a browser posts this page's own forms
    // with `Origin: null` (the Fetch spec ties the two), and the cross-site check below refuses that —
    // which is how sign-in was refused on the first deploy. Nothing is sent to other sites either way.
    c.header('Referrer-Policy', 'same-origin');
  });

  // --- The API ------------------------------------------------------------------

  const api = new Hono();
  api.use('*', rateLimit({ max: 60, windowMs: 60_000 }));
  // Wrong passwords: five a minute, as the page's sign-in allows. The API answers on every ward's
  // hostname and takes the same password, so at sixty it was a twelve-times faster oracle. Only
  // failures count, so the operator's scripts are not slowed (see `failureLimit`).
  const guesses = failureLimit({ max: 5, windowMs: 60_000 });
  api.use('*', async (c, next) => {
    const wait = guesses.blocked(c);
    if (wait !== null) {
      c.header('retry-after', String(wait));
      return c.json({ error: 'Too many wrong passwords. Try again in a minute.' }, 429);
    }
    const given = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    if (!sameSecret(given, deps.password)) {
      guesses.fail(c);
      return notFound(c);
    }
    await next();
  });
  api.onError((err, c) => {
    if (err instanceof Refusal) return c.json({ error: err.message }, err.status);
    // The answer is deliberately vague; the log is where the operator finds out what went wrong.
    logger.error(err, 'operator API call failed');
    return c.json({ error: 'Failed.' }, 500);
  });
  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  api.get('/wards', async (c) => c.json(await deps.registry.list()));
  api.post('/wards', async (c) => c.json(await act.create(await body(c)), 201));
  api.get('/report', async (c) => c.json(await act.report()));
  api.post('/poke', async (c) => c.json(await act.pokeAll()));
  api.post('/wards/:id/suspend', async (c) => (await act.setStatus(c.req.param('id'), 'suspended'), c.json({ ok: true })));
  api.post('/wards/:id/resume', async (c) => (await act.setStatus(c.req.param('id'), 'active'), c.json({ ok: true })));
  api.post('/wards/:id/move', async (c) => (await act.move(c.req.param('id'), (await body(c)).hostname), c.json({ ok: true })));
  api.post('/wards/:id/invite', async (c) => c.json(await act.invite(c.req.param('id'), (await body(c)).admin)));
  // Data only: the JSON every table, without images. The page's Export makes the full ZIP from
  // this and the images route below; a script can do the same.
  api.get('/wards/:id/export', async (c) => c.json(await act.export(c.req.param('id'))));
  api.get('/wards/:id/images/:key', async (c) => imageResponse(await act.image(c.req.param('id'), c.req.param('key'))));
  api.post('/wards/:id/delete', async (c) => (await act.remove(c.req.param('id'), (await body(c)).confirm), c.json({ ok: true })));
  api.post('/wards/:id/import', limitBody(MAX_IMPORT_JSON_BYTES), async (c) =>
    c.json(await act.importBackup(c.req.param('id'), await body(c))),
  );
  api.post('/wards/:id/images', limitBody(MAX_IMAGE_BATCH_BYTES), async (c) =>
    c.json(await act.storeImages(c.req.param('id'), (await body(c)).images)),
  );
  for (const action of ['tick', 'state', 'wake'] as const) {
    const handler = async (c: Context) => {
      const id = c.req.param('id')!;
      await act.find(id);
      return c.json(await act.call(id, action, action === 'tick' ? await body(c) : action === 'wake' ? {} : undefined));
    };
    api.get(`/wards/:id/${action}`, handler);
    api.post(`/wards/:id/${action}`, handler);
  }
  api.all('*', notFound);

  app.route('/__operator', api);

  // --- The page -------------------------------------------------------------------

  const page = new Hono();
  page.use('*', async (c, next) => {
    // Without a password there is no operator at all: the page does not exist.
    if (!onPage(c) || !deps.password) return notFound(c);
    // Every form posts to this same host. SameSite=Strict is no defence on its own here: every ward
    // is a sibling subdomain of this host, so same-site, and a form on a ward's page would carry the
    // cookie. So refuse what the browser says came from elsewhere (Sec-Fetch-Site, else an Origin
    // naming another host or `null`), the line app.ts draws for the wards themselves.
    if (c.req.method === 'POST') {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      if (site === 'cross-site' || site === 'same-site') return c.text('Forbidden', 403);
      if (origin && !sameHost(origin, c.req.url)) return c.text('Forbidden', 403);
    }
    await next();
  });
  // The host's session secret, read once per app (one app per isolate, see host.ts) and kept; a
  // read that failed is not kept, so the next request asks the registry again.
  let secretPromise: Promise<string> | null = null;
  const sessionSecret = () => {
    if (!secretPromise) {
      const pending = deps.sessionSecret();
      secretPromise = pending;
      pending.catch(() => {
        if (secretPromise === pending) secretPromise = null;
      });
    }
    return secretPromise;
  };
  const signedIn = async (c: Context) => hasSession(c, deps.password, await sessionSecret());
  const back = (c: Context, msg: string) => c.redirect(`/?msg=${encodeURIComponent(msg)}`, 303);
  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>;
  const guarded =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      if (!(await signedIn(c))) return c.redirect('/', 303);
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof Refusal) return back(c, err.message);
        // "Check the logs" has to be true: say what failed there, as `guardedJson` does.
        logger.error(err, 'operator page action failed');
        return back(c, 'That did not work. Check the logs.');
      }
    };

  page.get('/', async (c) => {
    if (!(await signedIn(c))) return c.html(loginHtml());
    return c.html(dashboardHtml(await act.report(), c.req.query('msg') ?? '', deps.wardDomain, deps.defaultTimezone));
  });
  page.post('/login', rateLimit({ max: 5, windowMs: 60_000 }), async (c) => {
    const { password } = await form(c);
    if (!sameSecret(String(password ?? ''), deps.password)) return c.html(loginHtml('That is not the password.'), 401);
    const issued = String(Math.floor(Date.now() / 1000));
    appendCookie(c, SESSION_COOKIE, `${issued}.${sign(deps.password, await sessionSecret(), issued)}`, {
      httpOnly: true,
      secure: deps.secure,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_SECONDS,
    });
    return c.redirect('/', 303);
  });
  page.post('/logout', (c) => {
    appendCookie(c, SESSION_COOKIE, '', { httpOnly: true, secure: deps.secure, sameSite: 'Strict', path: '/', maxAge: 0 });
    return c.redirect('/', 303);
  });
  /**
   * The hostname a page form names: `subdomain` + WARD_DOMAIN when there is one (a pasted full
   * hostname under that domain is accepted too), else the `hostname` field as typed.
   */
  const hostFromForm = (f: Record<string, string>): string => {
    if (!deps.wardDomain) return String(f.hostname ?? '');
    let label = String(f.subdomain ?? '').trim().toLowerCase();
    if (label.endsWith(`.${deps.wardDomain}`)) label = label.slice(0, -deps.wardDomain.length - 1);
    if (!SUBDOMAIN.test(label)) {
      throw new Refusal('A subdomain is letters, digits and hyphens — like example-2nd — with no dots.');
    }
    return `${label}.${deps.wardDomain}`;
  };

  page.post(
    '/wards',
    guarded(async (c) => {
      const f = await form(c);
      const hostname = hostFromForm(f);
      // The ward's id is fixed for good (its data lives under it); by default, its first subdomain.
      const id = String(f.id ?? '').trim() || hostname.split('.')[0]!;
      const ward = await act.create({ ...f, id, hostname });
      return c.html(resultHtml(`Ward "${ward.id}" created at ${ward.hostname}.`, ward.invite));
    }),
  );
  page.post('/wards/:id/suspend', guarded(async (c) => (await act.setStatus(c.req.param('id')!, 'suspended'), back(c, 'Suspended.'))));
  page.post('/wards/:id/resume', guarded(async (c) => (await act.setStatus(c.req.param('id')!, 'active'), back(c, 'Resumed.'))));
  page.post(
    '/wards/:id/move',
    guarded(async (c) => {
      const hostname = hostFromForm(await form(c));
      await act.move(c.req.param('id')!, hostname);
      return back(c, `Moved to ${hostname}. Re-invite its people: their passkeys belong to the old address.`);
    }),
  );
  page.post(
    '/wards/:id/invite',
    guarded(async (c) => {
      const { invite } = await act.invite(c.req.param('id')!, (await form(c)).admin);
      return c.html(resultHtml('A new admin invite link. It works once, for a week.', invite));
    }),
  );
  /**
   * The import dialog's calls, made with `fetch` by the page's own script (it unpacks the zip and
   * reports progress), so they answer JSON — refusals included — instead of redirecting. Same
   * session and Origin checks as every other form here.
   */
  const guardedJson =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      if (!(await signedIn(c))) return c.json({ error: 'Your operator session has ended. Sign in again.' }, 401);
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof Refusal) return c.json({ error: err.message }, err.status);
        logger.error(err, 'operator page call failed');
        return c.json({ error: 'That did not work. Check the logs.' }, 500);
      }
    };
  const jsonBody = async (c: Context) => {
    const parsed = (await c.req.json().catch(() => null)) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Refusal('That request was not JSON.');
    return parsed as Record<string, unknown>;
  };
  page.post(
    '/wards/:id/import',
    limitBody(MAX_IMPORT_JSON_BYTES),
    guardedJson(async (c) => c.json(await act.importBackup(c.req.param('id')!, await jsonBody(c)))),
  );
  page.post(
    '/wards/:id/images',
    limitBody(MAX_IMAGE_BATCH_BYTES),
    guardedJson(async (c) => c.json(await act.storeImages(c.req.param('id')!, (await jsonBody(c)).images))),
  );
  // The zip reader the import dialog uses — the same file the wards' Backup button writes with —
  // and that button's own code, which Export runs against the two routes below.
  page.get('/zip.js', async (c) => ((await signedIn(c)) && (await deps.asset?.('/zip.js'))) || notFound(c));
  page.get('/backup-zip.js', async (c) => ((await signedIn(c)) && (await deps.asset?.('/backup-zip.js'))) || notFound(c));
  // Export's images, one at a time. Fetched by the page's script, so a lapsed session is a 401
  // rather than a redirect to the sign-in page (which a fetch would follow and call a success).
  page.get(
    '/wards/:id/images/:key',
    guardedJson(async (c) => imageResponse(await act.image(c.req.param('id')!, c.req.param('key')!))),
  );
  page.post('/wards/:id/delete', guarded(async (c) => (await act.remove(c.req.param('id')!, (await form(c)).confirm), back(c, 'Deleted.'))));
  page.get(
    '/wards/:id/export',
    guarded(async (c) => {
      const id = c.req.param('id')!;
      const data = await act.export(id);
      c.header('Content-Disposition', `attachment; filename="${id}-backup-${new Date().toISOString().slice(0, 10)}.json"`);
      return c.json(data);
    }),
  );
  page.all('*', notFound);

  app.route('/', page);
  return app;
}

/** A ward's image as the operator's routes send it: its bytes and type, kept out of every cache. */
function imageResponse(res: Response): Response {
  return new Response(res.body, {
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' },
  });
}

/** The front door's hourly job, without the HTTP: `createOperatorActions(deps).pokeAll()`. */
export const createOperatorActions = actions;

// ---------------------------------------------------------------------------
// HTML (deliberately plain: one person uses it, rarely)
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
*,*::before,*::after{box-sizing:border-box}
body{font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;background:#f4f5f7;color:#1c2330}
header{background:#1f3a5f;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center}
main{max-width:1100px;margin:0 auto;padding:16px}
section{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 2px #0001}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #e5e7eb;vertical-align:top}
input,select{font:inherit;padding:6px 8px;border:1px solid #c9ced6;border-radius:6px;max-width:100%;background:#fff;color:inherit}
button,a.button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #c9ced6;background:#fff;cursor:pointer}a.button{color:inherit;text-decoration:none;display:inline-block}
button.primary{background:#1f3a5f;color:#fff;border-color:#1f3a5f}button.danger{color:#b42318;border-color:#f3b4ae}
form.inline{display:inline-flex;gap:6px;flex-wrap:wrap;margin:2px 0}.muted{color:#5b6472;font-size:13px}
.flash{background:#e8f3ec;border:1px solid #b7dcc4;padding:8px 12px;border-radius:8px}
.err{color:#b42318}code{word-break:break-all}.wrap{overflow-x:auto}
.status-suspended{color:#b42318;font-weight:600}
.ward{border-top:1px solid #e5e7eb;padding:14px 0}.ward:first-of-type{border-top:0}
.ward-head{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:baseline}.ward-head h3{margin:0;font-size:17px}
.facts{display:flex;flex-wrap:wrap;gap:4px 18px;margin:6px 0 10px}.facts span{color:#5b6472;font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.actions form{margin:0}.actions a.muted{margin-left:4px}
dialog{border:0;border-radius:12px;padding:18px;max-width:440px;width:calc(100% - 32px);box-shadow:0 10px 40px #0004}
dialog::backdrop{background:#0006}dialog h3{margin:0 0 6px}dialog.wide{max-width:600px}
.warn{background:#fdf0ef;border:1px solid #f3b4ae;color:#7a1a12;padding:8px 12px;border-radius:8px;margin:8px 0}
.col{display:flex;flex-direction:column;gap:4px;margin:12px 0}.col label{font-weight:600;font-size:14px}.col input{width:100%}
details{margin:12px 0}details summary{cursor:pointer;font-weight:600;font-size:14px}details .col{margin:8px 0}
#imp-result h4{margin:14px 0 4px;font-size:14px}#imp-count{margin:4px 0}
.tablecols{columns:2;column-gap:24px;font-size:13px;list-style:none;padding:0;margin:4px 0}
.tablecols li{display:flex;justify-content:space-between;gap:8px;padding:2px 4px;border-bottom:1px solid #eef0f3;break-inside:avoid}
ul.notes{margin:8px 0;padding-left:20px}ul.notes li{margin:2px 0}progress{width:100%;height:10px}
.result-scroll{max-height:60vh;overflow:auto}dialog .field{display:flex;align-items:center;gap:4px;margin:12px 0}
dialog .field input{flex:1;min-width:0}dialog .field[hidden]{display:none}dialog menu{display:flex;justify-content:flex-end;gap:8px;margin:14px 0 0;padding:0}
.suffix{display:flex;align-items:center;gap:4px}.suffix input{flex:1;min-width:0}
form.add p{display:flex;flex-direction:column;gap:4px;margin:0 0 10px}form.add label{font-weight:600;font-size:14px}
</style></head><body><header><strong>Ward hosting</strong>${
    title === 'Sign in' ? '' : '<form method="post" action="/logout"><button>Sign out</button></form>'
  }</header><main>${body}</main>
<footer class="muted" style="text-align:center;padding:0 16px 24px">${esc(DISCLAIMER)}</footer>
${scriptTag()}
// The flash message arrives as ?msg=… and is rendered above. Strip it from the address bar so a
// refresh (or a bookmark, or Back) doesn't show it again — as the ward dashboard does (views.ts).
(function () {
  var u = new URL(location.href);
  if (u.searchParams.has('msg')) {
    u.searchParams.delete('msg');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
})();
</script></body></html>`;
}

function loginHtml(error = ''): string {
  return shell(
    'Sign in',
    `<section><h2>Operator sign-in</h2>${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/login"><p><input type="password" name="password" autocomplete="current-password" required autofocus></p>
<button class="primary">Sign in</button></form></section>`,
  );
}

function resultHtml(message: string, invite: string | null | undefined): string {
  return shell(
    'Done',
    `<section><p class="flash">${esc(message)}</p>${
      invite
        ? `<p>Send this invite link to the ward's first admin. It works once, for a week, and makes their passkey:</p><p><code>${esc(invite)}</code></p>`
        : ''
    }<p><a href="/">Back to the wards</a></p></section>`,
  );
}

/**
 * Import Backup: its own dialog, since it asks for a file and reports progress afterwards. The page
 * script unpacks a full-backup zip (with `/zip.js`, loaded when needed), posts the backup's JSON to
 * `/wards/:id/import`, shows what the ward reported, then sends the images in batches of about 2 MB
 * to `/wards/:id/images`, keeping a tally and offering a retry for any that failed. A plain
 * backup.json imports the data only.
 */
function importDialogHtml(): string {
  return `<dialog id="imp" class="wide"><form id="imp-form" novalidate>
<h3 id="imp-title"></h3>
<div id="imp-ask">
<p class="warn"><strong>This replaces everything in this ward</strong> — announcements, programs, pages, people and their
passkeys, subscribers, access codes and settings — with what is in the backup. It cannot be undone; export the ward first
if it holds anything you want to keep.</p>
<p class="col"><label for="imp-file">Backup file</label><input type="file" id="imp-file" accept=".zip,.json,application/zip,application/json">
<span class="muted">The ZIP from Export or a ward's own Backup button (data and images), or a backup.json (data only).</span></p>
<details id="imp-keys"><summary>Keep members' notifications working (optional)</summary>
<p class="muted">If the old site's push keys were set as secrets (VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY), or its backup seals them
under a BACKUP_SEAL_KEY this host does not have, paste them here, or every member must turn notifications on again. Leave
blank for a backup or export made on this host: its keys open by themselves.</p>
<p class="col"><label for="imp-pub">Public key</label><input id="imp-pub" autocomplete="off" spellcheck="false" placeholder="B…"></p>
<p class="col"><label for="imp-priv">Private key</label><input id="imp-priv" autocomplete="off" spellcheck="false"></p>
<p class="col"><label for="imp-subject">Contact <span class="muted">(optional; VAPID_SUBJECT)</span></label><input id="imp-subject" autocomplete="off" spellcheck="false" placeholder="mailto:you@example.org"></p>
</details>
<p class="col"><label for="imp-confirm">Type <code id="imp-host"></code> to confirm</label><input id="imp-confirm" autocomplete="off" autocapitalize="none" spellcheck="false"></p>
<p class="err" id="imp-error" hidden></p>
<menu><button type="button" id="imp-cancel">Cancel</button><button id="imp-go" class="danger">Replace everything</button></menu>
</div>
<div id="imp-result" hidden><div class="result-scroll">
<p class="flash" id="imp-status"></p>
<h4>Images</h4>
<progress id="imp-progress" max="1" value="0"></progress>
<p id="imp-count" class="muted"></p>
<ul class="notes err" id="imp-failed"></ul>
<ul class="notes err" id="imp-warnings"></ul>
<ul class="notes" id="imp-facts"></ul>
<h4>Rows per table</h4>
<ul class="tablecols" id="imp-tables"></ul></div>
<menu><button type="button" id="imp-retry" hidden>Retry failed images</button><button type="button" id="imp-done" class="primary">Done</button></menu>
</div>
</form></dialog>
${scriptTag()}
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var dialog = $('imp');
  var KEY = /(?:^|\\/)images\\/([0-9a-f]{32}\\.[a-z0-9]+)$/;
  var BATCH_BYTES = 2 * 1024 * 1024;
  var ward = null;   // { id, host }
  var images = null; // key -> bytes, from the zip (null for a plain backup.json)
  var missing = {};  // key -> why the zip has no bytes for it (its manifest says)
  var tally = null;

  function text(el, value) { el.textContent = value; return el; }
  function li(list, value) { var item = document.createElement('li'); item.textContent = value; list.appendChild(item); }
  function fail(message) { var e = $('imp-error'); text(e, message); e.hidden = false; $('imp-go').disabled = false; text($('imp-go'), 'Replace everything'); }

  function loadZip() {
    if (window.WardZip) return Promise.resolve(window.WardZip);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/zip.js';
      s.onload = function () { resolve(window.WardZip); };
      s.onerror = function () { reject(new Error('Could not load the zip reader.')); };
      document.head.appendChild(s);
    });
  }

  /** The backup's JSON, its images and its manifest, from a zip or a plain backup.json. */
  function readFile(file) {
    return file.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        try { return { backup: JSON.parse(new TextDecoder().decode(bytes)), images: null, manifest: null }; }
        catch (e) { throw new Error('That file is neither a backup ZIP nor a backup JSON file.'); }
      }
      return loadZip().then(function (Zip) { return Zip.readZip(bytes); }).then(function (entries) {
        var out = { backup: null, images: {}, manifest: null };
        entries.forEach(function (entry) {
          var name = entry.name;
          var match = KEY.exec(name);
          if (match) out.images[match[1]] = entry.data;
          else if (/(^|\\/)backup\\.json$/.test(name)) out.backup = JSON.parse(new TextDecoder().decode(entry.data));
          else if (/(^|\\/)manifest\\.json$/.test(name)) out.manifest = JSON.parse(new TextDecoder().decode(entry.data));
        });
        if (!out.backup) throw new Error('That ZIP has no backup.json in it.');
        return out;
      });
    });
  }

  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || ('The server answered ' + res.status + '.'));
          return data;
        });
      });
  }

  function base64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function showReport(r) {
    text($('imp-status'), 'Imported' + (r.app ? ' "' + r.app + '"' : '') + (r.exportedAt ? ', backed up ' + r.exportedAt.slice(0, 16).replace('T', ' ') + ' UTC' : '') + '.');
    var warnings = $('imp-warnings'); warnings.textContent = '';
    (r.warnings || []).forEach(function (w) { li(warnings, w); });
    var facts = $('imp-facts'); facts.textContent = '';
    li(facts, r.fromVersion === r.toVersion ? 'Schema ' + r.toVersion + ' (no migration needed).'
      : 'Migrated from schema ' + (r.fromVersion === null ? '(unrecorded — a very old backup)' : r.fromVersion) + ' to ' + r.toVersion + '.');
    // Where the keys came from, and — a sealed backup — whether this host's BACKUP_SEAL_KEY opened them.
    var hadNone = r.push.sealed === 'locked' ? ' (the backup\\u2019s sealed keys did not open here)' : ' (the backup had none)';
    var pushText = { supplied: 'the keys you gave', backup: r.push.sealed === 'opened' ? 'the backup\\u2019s own keys, unsealed' : 'the backup\\u2019s own keys', ward: 'this ward\\u2019s existing keys' + hadNone, 'new': 'new keys' + hadNone }[r.push.source];
    li(facts, 'Push keys: ' + pushText + ' — public key ' + r.push.publicKey.slice(0, 12) + '…' + (r.push.subject ? ', contact ' + r.push.subject : '') + '.');
    li(facts, r.subscribers + ' subscriber(s), ' + r.people + ' dashboard person(s) with ' + r.passkeys + ' passkey(s).');
    li(facts, r.origin.backup ? 'Backed up from ' + r.origin.backup + (r.origin.matches ? ' (this address).' : '.') : 'The backup does not record which address it came from.');
    Object.keys(r.dropped || {}).forEach(function (t) { li(facts, 'Dropped columns this version does not have: ' + t + '.' + r.dropped[t].join(', ' + t + '.') + '.'); });
    (r.ignored || []).forEach(function (t) { li(facts, 'Ignored "' + t + '" in the backup (images travel in the ZIP).'); });
    var rows = $('imp-tables'); rows.textContent = '';
    r.tables.forEach(function (t) {
      var item = document.createElement('li');
      var name = document.createElement('span'); name.textContent = t.name + (t.inBackup ? '' : ' (not in backup: emptied)');
      var n = document.createElement('span'); n.textContent = String(t.rows);
      item.appendChild(name); item.appendChild(n); rows.appendChild(item);
    });
  }

  function showImages() {
    var t = tally;
    var done = t.restored + t.skipped + Object.keys(t.failed).length;
    $('imp-progress').max = Math.max(1, t.total);
    $('imp-progress').value = done;
    var parts = [t.restored + ' restored', t.skipped + ' already there', Object.keys(t.failed).length + ' failed'];
    text($('imp-count'), t.total === 0 ? 'The backup has no images.'
      : done + ' of ' + t.total + (done < t.total ? ' — adding images…' : '') + ' (' + parts.join(', ') + ')');
    var list = $('imp-failed'); list.textContent = '';
    Object.keys(t.failed).forEach(function (key) { li(list, key + ': ' + t.failed[key]); });
    $('imp-retry').hidden = done < t.total || !Object.keys(t.failed).some(function (k) { return images && images[k]; });
  }

  /** Send the keys in batches of about BATCH_BYTES, one request at a time, tallying as they land. */
  function sendImages(keys) {
    var queue = [];
    keys.forEach(function (key) {
      if (images && images[key]) { delete tally.failed[key]; queue.push(key); }
      else tally.failed[key] = missing[key] ? 'not in the backup (' + missing[key] + ')' : images ? 'not in the backup file' : 'not in a data-only backup — import the ZIP to restore it';
    });
    showImages();
    function next() {
      if (!queue.length) { showImages(); return Promise.resolve(); }
      var batch = [], size = 0;
      while (queue.length && (batch.length === 0 || size + images[queue[0]].length <= BATCH_BYTES)) {
        var key = queue.shift();
        size += images[key].length;
        batch.push({ key: key, data: base64(images[key]) });
      }
      return post('/wards/' + encodeURIComponent(ward.id) + '/images', { images: batch })
        .then(function (res) {
          res.results.forEach(function (r) {
            if (r.status === 'restored') tally.restored++;
            else if (r.status === 'skipped') tally.skipped++;
            else tally.failed[r.key] = r.error || 'failed';
          });
        }, function (err) {
          batch.forEach(function (b) { tally.failed[b.key] = err.message; });
        })
        .then(function () { showImages(); return next(); });
    }
    return next();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-import]');
    if (!b) return;
    ward = { id: b.dataset.import, host: b.dataset.host };
    text($('imp-title'), 'Import a backup into ' + ward.host);
    text($('imp-host'), ward.host);
    $('imp-confirm').placeholder = ward.host;
    ['imp-file', 'imp-pub', 'imp-priv', 'imp-subject', 'imp-confirm'].forEach(function (id) { $(id).value = ''; });
    $('imp-keys').open = false;
    $('imp-error').hidden = true;
    $('imp-ask').hidden = false;
    $('imp-result').hidden = true;
    $('imp-go').disabled = false;
    text($('imp-go'), 'Replace everything');
    dialog.showModal();
  });
  $('imp-cancel').addEventListener('click', function () { dialog.close(); });
  $('imp-done').addEventListener('click', function () { location.href = '/?msg=' + encodeURIComponent('Imported a backup into ' + ward.host + '.'); });
  $('imp-retry').addEventListener('click', function () {
    $('imp-retry').hidden = true;
    sendImages(Object.keys(tally.failed));
  });
  $('imp-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('imp-error').hidden = true;
    var file = $('imp-file').files[0];
    if (!file) return fail('Choose a backup file.');
    if ($('imp-confirm').value.trim().toLowerCase() !== ward.host) return fail('Type ' + ward.host + ' to confirm.');
    $('imp-go').disabled = true;
    text($('imp-go'), 'Reading the file…');
    readFile(file)
      .then(function (read) {
        images = read.images;
        missing = {};
        ((read.manifest && read.manifest.missing) || []).forEach(function (m) { missing[m.key] = m.error || 'missing'; });
        text($('imp-go'), 'Importing…');
        return post('/wards/' + encodeURIComponent(ward.id) + '/import', {
          backup: read.backup,
          confirm: $('imp-confirm').value,
          vapidPublicKey: $('imp-pub').value,
          vapidPrivateKey: $('imp-priv').value,
          vapidSubject: $('imp-subject').value,
        });
      })
      .then(function (report) {
        $('imp-ask').hidden = true;
        $('imp-result').hidden = false;
        showReport(report);
        tally = { total: report.images.keys.length, restored: 0, skipped: 0, failed: {} };
        return sendImages(report.images.keys);
      })
      .catch(function (err) { fail(err.message || String(err)); });
  });
})();
</script>`;
}

function dashboardHtml(wards: WardReport[], msg: string, wardDomain: string, defaultTimezone: string): string {
  const when = (ms: number | null) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
  // Every action that needs an answer is a button that opens the one dialog below, which asks for
  // just that and posts the same form as before. No text boxes on the ward lines.
  const button = (act: string, w: WardReport, label: string, cls = '') =>
    `<button type="button"${cls ? ` class="${cls}"` : ''} data-act="${act}" data-ward="${esc(w.id)}" data-host="${esc(w.hostname)}">${label}</button>`;
  const cards = wards
    .map((w) => {
      const active = w.status === 'active';
      return `<div class="ward">
<div class="ward-head"><h3><a href="https://${esc(w.hostname)}/admin" target="_blank" rel="noopener">${esc(w.hostname)}</a></h3>
<span class="status-${esc(w.status)}">${active ? 'active' : 'suspended'}</span><span class="muted">id ${esc(w.id)}</span></div>
${w.error ? `<p class="err">${esc(w.error)}</p>` : ''}
<div class="facts"><span>${esc(w.subscribers ?? '?')} subscribers</span>
<span>last notification: ${w.lastSend ? `${esc(w.lastSend.title)} (${esc(w.lastSend.type)}, ${esc(w.lastSend.sent_at)} UTC)` : 'none yet'}</span>
<span>next alarm ${esc(when(w.alarm))}</span><span>schema ${esc(w.schemaVersion ?? '?')}</span></div>
<div class="actions">${button('invite', w, 'Invite admin')}
<button type="button" data-export="${esc(w.id)}" data-host="${esc(w.hostname)}">Export</button>
<button type="button" data-import="${esc(w.id)}" data-host="${esc(w.hostname)}">Import Backup</button>
${
  active
    ? button('suspend', w, 'Suspend')
    : `<form method="post" action="/wards/${esc(w.id)}/resume"><button>Resume</button></form>`
}
${button('move', w, 'Change address')}
${button('delete', w, 'Delete', 'danger')}</div>
<p class="muted" data-export-status="${esc(w.id)}" role="status" hidden></p></div>`;
    })
    .join('');
  const addressInput = (placeholder: string) =>
    wardDomain
      ? `<span class="suffix"><input name="subdomain" placeholder="${esc(placeholder)}" required autocapitalize="none" spellcheck="false"><span class="muted">.${esc(wardDomain)}</span></span>`
      : `<input name="hostname" placeholder="${esc(placeholder)}.example.org" required autocapitalize="none" spellcheck="false">`;
  return shell(
    'Wards',
    `${msg ? `<p class="flash">${esc(msg)}</p>` : ''}
<section><h2>Wards (${wards.length})</h2>${cards || '<p class="muted">No wards yet.</p>'}</section>
<section><h2>Add a ward</h2><form class="add" method="post" action="/wards">
<p><label>Address</label>${addressInput('example-2nd')}</p>
<p><label>App name <span class="muted">(optional — the ward can change it later)</span></label><input name="name" placeholder="Example 2nd Ward" maxlength="60"></p>
<p><label>Home-screen name <span class="muted">(the label under the icon — about 12 characters fit)</span></label><input name="shortName" placeholder="Example 2nd" maxlength="12"></p>
<p><label>Timezone</label>${timezoneSelect(defaultTimezone)}</p>
<p><label>First admin <span class="muted">(optional — you get an invite link to send them)</span></label><input name="admin" placeholder="Their name"></p>
<button class="primary">Create ward</button></form></section>
<dialog id="act"><form method="post" id="act-form">
<h3 id="act-title"></h3><p class="muted" id="act-text"></p>
<div class="field" id="act-field"><input id="act-input" autocapitalize="none" spellcheck="false"><span class="muted" id="act-suffix"></span></div>
<menu><button type="button" id="act-cancel">Cancel</button><button id="act-go" class="primary"></button></menu>
</form></dialog>
<dialog id="exp"><form method="dialog">
<h3 id="exp-title"></h3>
<p class="muted">The full backup is everything, images included, as one ZIP: what Import takes back, and the
file to keep for disaster recovery. Data only is the JSON without images, for a quick look or a script.</p>
<menu><button type="button" id="exp-cancel">Cancel</button><a class="button" id="exp-json" href="#" download>Data Only (JSON)</a><button type="button" id="exp-zip" class="primary">Full Backup (ZIP)</button></menu>
</form></dialog>
${scriptTag()}
(function () {
  var domain = ${JSON.stringify(wardDomain).replace(/</g, '\\u003c')};
  var dialog = document.getElementById('act');
  var form = document.getElementById('act-form');
  var input = document.getElementById('act-input');
  var go = document.getElementById('act-go');
  var ACTS = {
    invite: function (id, host) { return { title: 'Invite an admin to ' + host, go: 'Make invite link',
      text: 'A one-time link, good for a week, that makes their passkey. Also the way back in if every admin has lost theirs — including for you.',
      name: 'admin', placeholder: 'Their name' }; },
    suspend: function (id, host) { return { title: 'Suspend ' + host + '?', go: 'Suspend ward',
      text: 'Closes the ward to everyone and stops its notifications. Nothing is deleted; Resume opens it again.' }; },
    move: function (id, host) { return { title: 'Change the address of ' + host, go: 'Move',
      text: 'Everyone must be re-invited (passkeys belong to an address), and members reinstall the app from the new one.',
      name: domain ? 'subdomain' : 'hostname', placeholder: domain ? 'new-name' : 'new.example.org', suffix: domain ? '.' + domain : '' }; },
    delete: function (id, host) { return { title: 'Delete ' + host + '?', go: 'Delete for good', danger: true,
      text: 'Deletes everything in the ward, for good — export it first. Type ' + id + ' to confirm.',
      name: 'confirm', placeholder: id }; }
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act]');
    if (!b) return;
    var a = ACTS[b.dataset.act](b.dataset.ward, b.dataset.host);
    form.action = '/wards/' + encodeURIComponent(b.dataset.ward) + '/' + b.dataset.act;
    document.getElementById('act-title').textContent = a.title;
    document.getElementById('act-text').textContent = a.text;
    document.getElementById('act-suffix').textContent = a.suffix || '';
    document.getElementById('act-field').hidden = !a.name;
    input.value = '';
    input.name = a.name || '';
    input.required = !!a.name;
    input.disabled = !a.name;
    input.placeholder = a.placeholder || '';
    go.textContent = a.go;
    go.className = a.danger ? 'danger' : 'primary';
    dialog.showModal();
    if (a.name) input.focus();
  });
  document.getElementById('act-cancel').addEventListener('click', function () { dialog.close(); });

  // Export asks which: the ward's full backup — the same ZIP its own Backup button makes, by the same
  // code (/backup-zip.js), from this page's routes, which read the ward's data and its own image
  // store — or the data-only JSON, a plain download.
  var exp = document.getElementById('exp');
  var expJson = document.getElementById('exp-json');
  var pending = null;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-export]');
    if (!b) return;
    pending = b;
    document.getElementById('exp-title').textContent = 'Export ' + b.dataset.host;
    expJson.href = '/wards/' + encodeURIComponent(b.dataset.export) + '/export';
    exp.showModal();
    document.getElementById('exp-zip').focus();
  });
  document.getElementById('exp-cancel').addEventListener('click', function () { exp.close(); });
  expJson.addEventListener('click', function () { exp.close(); });
  document.getElementById('exp-zip').addEventListener('click', function () {
    exp.close();
    var b = pending;
    if (!b || !window.BackupZip) return;
    var id = b.dataset.export;
    var status = document.querySelector('[data-export-status="' + id + '"]');
    var base = '/wards/' + encodeURIComponent(id);
    b.disabled = true;
    window.BackupZip.download({
      hostname: b.dataset.host,
      name: id,
      dataUrl: base + '/export',
      imageUrl: function (key) { return base + '/images/' + encodeURIComponent(key); }
    }, function (text, isError) {
      status.hidden = false;
      status.textContent = text;
      status.classList.toggle('err', !!isError);
    }).then(function () { b.disabled = false; });
  });
})();
</script>
<script src="/backup-zip.js"></script>
${importDialogHtml()}`,
  );
}
