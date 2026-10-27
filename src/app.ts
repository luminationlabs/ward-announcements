/**
 * The HTTP application: every route, the security headers, and the member access gate.
 *
 * Deliberately runtime-agnostic — it takes the things a Node process happens to be good at
 * (reading and templating files off disk, serving them, knowing a socket's remote address) as
 * inputs rather than doing them itself, so the same app is mounted by the Node entry in
 * `server.ts` and by the Cloudflare Workers entry in `worker.ts`.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cspNonce, withContentSecurityPolicy } from './csp.js';
import QRCode from 'qrcode';
import { type AdminChange, wouldStrandAdmins } from './admin-guard.js';
import { config } from './config.js';
import {
  dumpDatabase,
  countRecentManualSends,
  attachmentByKey,
  upsertSubscriptionWith,
  isBlockedSubscription,
  moveSubscriptionBlock,
  removeSubscriptionById,
  getSubscriptionByEndpoint,
  deleteSubscription,
  listSubscriptions,
  countSubscriptions,
  listPublicAnnouncements,
  listAllAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  reorderAnnouncements,
  countPublicAnnouncements,
  listPublicPages,
  listAllPages,
  getPage,
  createPage,
  updatePage,
  deletePage,
  reorderPages,
  isAutoSendEnabled,
  setSetting,
  deleteSetting,
  getSetting,
  recentSendHistory,
  sendQueueDepth,
  listSkipsFrom,
  addSkip,
  removeSkip,
  activeAccessCode,
  listAccessCodes,
  rotateAccessCode,
  countLiveInvites,
  listAttachments,
  listAttachmentsForOwners,
  countAttachments,
  countPendingAttachments,
  claimPendingAttachments,
  pendingAttachmentsByIds,
  PENDING_OWNER,
  totalAttachmentBytes,
  deleteAllAccessTokens,
  attachmentById,
  createAttachment,
  deleteAttachment,
  getProgram,
  getProgramByDate,
  listRecentPrograms,
  createProgram,
  updateProgram,
  deleteProgram,
  type AttachmentRow,
  bumpAdminSessionVersion,
  createAdminInvite,
  currentAdminInvite,
  deleteAdminPasskey,
  deleteAdminUser,
  getAdminUser,
  listAdminPasskeys,
  listAdminUsers,
  SAMPLE_ANNOUNCEMENT_TITLE,
  updateAdminUser,
} from './db.js';
import {
  contentTypeForKey,
  extensionFor,
  isValidKey,
  newAttachmentKey,
  MAX_ATTACHMENTS_PER_OWNER,
  MAX_UPLOAD_BYTES,
  type FileStore,
} from './filestore.js';
import { renderMarkdown, renderProgramMarkdown } from './markdown.js';
import { qrPng, scaleFor } from './qr-png.js';
import { purgeAttachments } from './attachments.js';
import { stripImageMetadata } from './image-meta.js';
import { isPushEndpoint, sendToAll } from './push.js';

// Re-exported for the tests and for anything that reached it here before it moved to push.ts.
export { isPushEndpoint };
import {
  getScheduleSettings,
  setScheduleSettings,
  nextSendingSlotAfter,
  getWeeklyMessageSettings,
  setWeeklyMessageSettings,
  setAutoSendEnabled,
} from './schedule-core.js';
import { DEFAULT_SCHEDULE, type ScheduleSettings } from './schedule-core.js';
import { getMeetingTime, saveMeetingTime, timingSentence, timingStatus } from './meeting.js';
import {
  DEFAULT_PROGRAM_SETTINGS,
  EXAMPLE_PROGRAM,
  PROGRAM_OWNER,
  MAX_RETENTION_DAYS,
  dashboardProgramLimit,
  getProgramSettings,
  setProgramSettings,
  programWindowOpen,
  programWindowClosesAt,
  closedProgramMessage,
  localDate,
  nextProgramDate,
} from './programs.js';
import {
  hasOwner,
  isOwnerPassword,
  startOwnerSession,
  startUserSession,
  endOwnerSessions,
  sessionOf,
  clearSession,
  isAuthenticated,
  loadSession,
  adminReturnPath,
  requireAuth,
  requireAdmin,
  roleOf,
  whoOf,
  type AuthVariables,
} from './auth.js';
import {
  INVITE_DAYS,
  invitePerson,
  addOptions,
  addVerify,
  randomToken,
  registrationOptions,
  registrationVerify,
  signInOptions,
  signInVerify,
} from './passkeys.js';
import {
  loginPage,
  invitePage,
  personPage,
  accountPage,
  dashboardPage,
  type GettingStarted,
  richPreviewHtml,
  appLinkHtml,
  richPreviewPage,
  programPreviewHtml,
  announcementForm,
  pageForm,
  programForm,
  gatePage,
  subscribersPage,
  DAY_NAMES,
  dayOfWeekFor,
} from './views.js';
import {
  hasAccess,
  grantAccess,
  redeemCredential,
  newAccessCode,
  mintInvite,
  mintEmailLink,
  deviceTokenFor,
  getGateSettings,
  setGateSettings,
  resetAccessSecret,
  INVITE_TTL_MAX_DAYS,
} from './access.js';
import { json, html, readBody, redirect, samePathOnly, type ClientIpSource } from './http.js';
import { rateLimit } from './ratelimit.js';
import { learnOrigin } from './identity.js';
import { sealBackupSettings } from './seal.js';
import { buildShell, shellFor, type Shell, type ShellSources } from './shell.js';
import { WARD_LIMITS, currentWardSettings, refreshWardSettings, saveWardSettings } from './ward-settings.js';
import { redactUrl } from './log.js';
import type { Logger } from './log.js';

export interface AppOptions {
  /**
   * The raw shell files (`index.html`, `sw.js`, …), as each runtime reads them. Templated with the
   * ward's identity on first use and again whenever that identity changes (see `currentShell`).
   */
  shell: ShellSources;
  log: Logger;
  /** Socket address for rate-limit keying when no proxy header is present. Node entry only. */
  ipFallback?: (c: Context) => string | undefined;
  /**
   * Which client address to trust for rate limits, and whether forwarded host headers are believed
   * when building links (`clientIp` in http.ts). Workers: `cloudflare` (the default). Node: `proxy`
   * behind a TLS proxy (`TRUST_PROXY=1`), else `socket`.
   */
  ipSource?: ClientIpSource;
  /**
   * Static-asset fallback, tried after every route and before the 404. Workers passes its assets
   * binding here; the Node entry appends its own `serveStatic` middleware after `createApp`
   * returns, which lands in the same position. Return undefined for "no such asset".
   */
  assets?: (c: Context) => Promise<Response | undefined>;
  /**
   * Where uploaded images live. The Node entry passes a directory-backed store, the Workers entry
   * its R2 bucket — see `filestore.ts`.
   */
  files: FileStore;
  /**
   * How much of a manual send to deliver inside the request. `'inline'` (the default, and what Node
   * does) waits for every subscriber; `'background'` delivers the first chunk and leaves the rest
   * to the runtime's scheduled drain, because a Worker cannot spend a whole ward's worth of CPU on
   * one request.
   */
  drainSends?: 'inline' | 'background';
}

/** Plain-text response, with the exact content type the clients and tests expect. */
function text(c: Context, body: string, status = 200, charset = true): Response {
  return c.body(body, status as 200, {
    'content-type': charset ? 'text/plain; charset=utf-8' : 'text/plain',
  });
}

/** Whether an Origin header names the request's own host; false for another, null when unreadable. */
function sameHostAs(origin: string, url: string): boolean | null {
  try {
    return new URL(origin).host === new URL(url).host;
  } catch {
    return null;
  }
}

/** The most push subscriptions one ward keeps; far beyond any ward, well short of a flood. */
const MAX_SUBSCRIPTIONS = 5000;

/** Set when an admin dismisses the dashboard's first-run checklist. */
const GETTING_STARTED_DISMISSED = 'getting_started_dismissed';

/**
 * Whether this request may load an image that is not an announcement's or a page's: anyone signed in
 * to the dashboard may (they see the program any day, and the images on forms they have not saved);
 * a member only a program's, and only inside that program's window on its own date.
 */
async function mayViewPrivateImage(c: Context, row: AttachmentRow): Promise<boolean> {
  if (await sessionOf(c)) return true;
  if (row.owner_type !== PROGRAM_OWNER || !(await hasAccess(c))) return false;
  const now = new Date();
  if (!programWindowOpen(now, await getProgramSettings())) return false;
  return (await getProgram(row.owner_id))?.program_date === localDate(now);
}

/** Manual notifications one ward may send in an hour: room for a test and a correction or two. */
const MAX_MANUAL_SENDS_PER_HOUR = 5;

/** Unsaved images across a ward (see the pending branch of POST /admin/attachments). */
const MAX_PENDING_ATTACHMENTS = 30;

/**
 * The pending images a New form carries (`pending_images`, comma-separated ids, in the order they
 * were added) — at most what one row may hold.
 */
function pendingIds(body: Record<string, unknown>): number[] {
  return [...new Set(String(body.pending_images ?? '').split(',').map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, MAX_ATTACHMENTS_PER_OWNER);
}

/** Per-request state the middleware computes and later routes reuse. */
export interface AppVariables extends AuthVariables {}

export type AppEnv = { Variables: AppVariables };

/**
 * Paths that must stay reachable without the member access code: PWA/static assets, health,
 * the unlock endpoint itself, and the admin area (which has its own password login).
 */
/** The `attachments.owner_type` for a resource page's images (see `PROGRAM_OWNER`). */
export const PAGE_OWNER = 'page';

export function gateExempt(path: string): boolean {
  return (
    path === '/healthz' ||
    path === '/api/access' ||
    path === '/robots.txt' ||
    path === '/favicon.ico' ||
    path === '/manifest.webmanifest' ||
    path === '/sw.js' ||
    path === '/app.js' ||
    path === '/install.js' ||
    path === '/preview-pdf.js' ||
    path === '/flyer-pdf.js' ||
    path === '/zip.js' ||
    path === '/backup-zip.js' ||
    path === '/styles.css' ||
    path.startsWith('/icons/') ||
    path.startsWith('/img/') ||
    // Uploaded announcement images. Exempt on purpose: they are flyers for events the ward is
    // advertising, and their keys are 128 bits of randomness — unguessable, and only ever listed
    // to someone who already passed the gate, since the announcements API is what hands them out.
    // The announcement *text* stays gated either way, and keeping the images open means an <img>
    // never renders as a broken box because a cookie lapsed between page load and image fetch.
    // A program's images are the exception, checked by the route itself (`mayViewPrivateImage`).
    path.startsWith('/images/') ||
    path.startsWith('/vendor/') ||
    path.startsWith('/apple-touch-icon') ||
    // The admin area, and *only* the admin area. `startsWith('/admin')` would also exempt every
    // path that merely begins with those six characters — `/administrivia`, `/admin-notes` — so
    // anything the static handler or a future route answered under such a name would be served to
    // a stranger.
    path === '/admin' ||
    path.startsWith('/admin/')
  );
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { log, ipFallback, assets, files } = options;
  const ipSource = options.ipSource ?? 'cloudflare';
  // Forwarded host/proto headers are only worth believing from a proxy we were told is there.
  const originFor = (c: Context) => originFrom(c, ipSource === 'proxy');

  // The templated shell, rebuilt when what it bakes in changes: the ward settings an admin can
  // edit (`ward-settings.ts`), and the origin a deployment learns after boot (the social-card tags).
  // A new identity is a new build id, so installed apps pick a rename up through the usual silent
  // update. Held in this closure — one per app, so one per ward on a multi-ward host.
  let shellCache: { key: string; shell: Promise<Shell> } | null = null;
  const currentShell = (): Promise<Shell> => {
    const key = JSON.stringify([currentWardSettings(), config.publicOrigin]);
    if (!shellCache || shellCache.key !== key) {
      const shell = buildShell(options.shell);
      const entry = { key, shell };
      shellCache = entry;
      shell.catch(() => {
        if (shellCache === entry) shellCache = null; // don't keep a failure; the next request retries
      });
    }
    return shellCache.shell;
  };
  const drain = options.drainSends === 'background' ? 'first-chunk' : 'until-empty';
  const app = new Hono<AppEnv>();

  // Per-route limiters, each with its own budget. Registered as route middleware (not globally), so
  // they run *after* the gate below. That ordering matters: a stranger poking /api/invite is turned
  // away by the gate without ever consuming limiter budget.
  const limit = (max: number) => rateLimit({ max, windowMs: 60_000, ipFallback, ipSource });
  const adminNoStore: MiddlewareHandler = async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-store');
  };

  // --- Request logging -----------------------------------------------------
  //
  // A line as each request arrives and another as it completes, with the URL redacted: the member
  // access code can ride in `?code=`, and the shared gate secret must never reach a log line.
  // Registered first so it wraps every other handler, static files included.
  app.use('*', async (c, next) => {
    const started = Date.now();
    const req = { method: c.req.method, url: redactUrl(pathWithQuery(c)) };
    log.info({ req }, 'incoming request');
    await next();
    log.info({ req, res: { statusCode: c.res.status }, responseTime: Date.now() - started }, 'request completed');
  });

  // The ward's name, footer, link and timezone as an admin last saved them, possibly in another
  // isolate. A timestamp check on almost every request; a settings read at most once a minute.
  app.use('*', async (_c, next) => {
    await refreshWardSettings();
    await next();
  });

  // --- Admin pages are never cached -----------------------------------------
  //
  // The service worker registers at root scope, so it controls `/admin` too, and its fetch handler
  // stores any OK response that is not `no-store`. The dashboard carries the live access code, the
  // share link and QR, and the subscriber list carries every push endpoint — none of which belongs
  // at rest in Cache Storage on whatever device a clerk happened to use. Set after the route runs so
  // a handler that chose its own directive (the backup, the QR files) keeps it.
  app.use('/admin', adminNoStore);
  app.use('/admin/*', adminNoStore);
  // Who is signed in, resolved once per admin request (a database read for a person's session, so
  // removing someone takes effect on their next click). `roleOf` and the guards read the result.
  app.use('/admin', loadSession);
  app.use('/admin/*', loadSession);

  // --- Request size ---------------------------------------------------------
  //
  // Nothing an admin form sends comes near these: a body is at most 50,000 characters, an image
  // 3 MB. Without them a request is read whole into memory, however large, before any route decides
  // it was too big — and on the many-ward host, memory every ward shares. The public API's bodies
  // are a code or a push subscription.
  const ADMIN_BODY_MAX = 1024 * 1024;
  const UPLOAD_BODY_MAX = MAX_UPLOAD_BYTES + 1024 * 1024;
  const tooLarge = (c: Context) => text(c, 'That is too large to send in one request.', 413);
  const adminBody = bodyLimit({ maxSize: ADMIN_BODY_MAX, onError: tooLarge });
  const uploadBody = bodyLimit({ maxSize: UPLOAD_BODY_MAX, onError: tooLarge });
  app.use('/admin/*', (c, next) => (c.req.path === '/admin/attachments' ? uploadBody(c, next) : adminBody(c, next)));
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }));

  // --- Security headers + the member access gate ---------------------------
  //
  // Registered before every route and before the static
  // handler the Node entry appends, so it sees each request first — including ones that end in a
  // 404 or in a static file.
  // The Content Security Policy and this response's script nonce (src/csp.ts): first, so every
  // page rendered after it can stamp its inline scripts.
  app.use('*', withContentSecurityPolicy);
  app.use('*', async (c, next) => {
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Robots-Tag', 'noindex');
    // Content sniffing turns a response the app labelled `text/plain` into whatever the bytes look
    // like to a browser — the reason an uploaded file, an error body or a JSON payload can be
    // coaxed into executing as script. Every response here declares its own type accurately, so
    // this costs nothing and closes the class.
    c.header('X-Content-Type-Options', 'nosniff');
    // Never inside someone else's frame (a clickjacked "Send" or "Issue New Code"). Nothing in
    // the app frames itself.
    c.header('X-Frame-Options', 'DENY');

    // A form post or a delete from another site is refused. SameSite=Lax cookies already stop most
    // of that, but not between sibling subdomains — and on the many-ward host every ward is a
    // sibling of every other. Browsers say where a request came from (Sec-Fetch-Site, else Origin);
    // a request that says nothing (a script, the test suites) is let through, as before. `Origin:
    // null` is not nothing: it is what a sandboxed frame or a `data:` page sends, and neither is
    // this site (operator.ts draws the same line).
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      const crossSite =
        site === 'cross-site' ||
        site === 'same-site' ||
        (!site && !!origin && (origin === 'null' || sameHostAs(origin, c.req.url) === false));
      if (crossSite) return text(c, 'Forbidden', 403);
    }

    // Exemption first, gate query second: the exempt list is most of the traffic (every static
    // asset, the service worker, the manifest, the whole admin area), and none of it should pay a
    // database round trip to ask a question its own answer makes irrelevant.
    const path = c.req.path;
    if (gateExempt(path)) return next();

    // The gate is always on (there is no switch to make the page public), so there is no "is it
    // on?" query: every non-exempt request needs a member credential. Fails closed — a database that
    // somehow lost its active code still admits existing members by their cookie and turns strangers
    // away until the next boot mints a code (`ensureAccessCode`).
    const grant = await hasAccess(c);
    if (grant) {
      await grantAccess(c, grant); // sliding refresh, preserving the device id
      return next();
    }

    // `?code=` serves the one context that can't use a fragment: an installed app launching its
    // start_url. Every link meant for a human puts the credential in the fragment instead, which
    // never reaches a server log or a link-unfurling bot — those arrive here credential-less and are
    // unlocked by the gate page's script via POST /api/access.
    const code = c.req.query('code');
    const redeemed = code ? await redeemCredential(code) : null;
    if (redeemed) {
      // Adopt the identity the credential already carries, when it has one. An installed app cold-
      // launching this way keeps the device token it just presented instead of being issued a
      // replacement — otherwise every re-unlock left another five-year credential behind.
      await grantAccess(c, redeemed.deviceId ? { deviceId: redeemed.deviceId } : undefined);
      // Strip the code from the address bar on a normal page visit. `samePathOnly` is what keeps
      // this from being an open redirect: the target is the requested path echoed back, and a
      // request for `//evil.example.com/x?code=<valid>` would otherwise have 302'd off-site — a
      // phishing hop wearing the ward's own domain, reachable by anyone holding a code.
      if (c.req.method === 'GET' && !path.startsWith('/api/')) {
        return redirect(c, samePathOnly(path));
      }
      return next();
    }

    if (path.startsWith('/api/')) {
      return json(c, { error: 'Access code required' }, 401);
    }
    // no-store so the service worker (and HTTP cache) never persist the gate page in place of the
    // real app — otherwise a gated visitor's cached "/" would keep showing the gate offline.
    c.header('Cache-Control', 'no-store');
    return html(c, gatePage((await getGateSettings()).message), 200);
  });

  // --- Public API ----------------------------------------------------------

  app.get('/healthz', (c) => json(c, { ok: true }));

  // The app shell, with the configured identity baked in. Served here rather than by the static
  // handler for both "/" and "/index.html".
  const shell = async (c: Context) => {
    c.header('Cache-Control', 'no-cache');
    return html(c, shellFor(await currentShell(), cspNonce()));
  };
  app.get('/', shell);
  app.get('/index.html', shell);

  // Service worker, served dynamically so the build id can be substituted into its CACHE name. An
  // explicit route beats the static handler, same as /index.html. no-cache so the browser
  // revalidates the script on every update check (the byte comparison that gates SW updates); a
  // changed build id changes the bytes and triggers the install → skipWaiting → reload.
  app.get('/sw.js', async (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.body((await currentShell()).swSource, 200, { 'content-type': 'application/javascript' });
  });

  // Web app manifest, served dynamically. Embed a credential in start_url for *authenticated*
  // requests only — so an installed iOS PWA (which has its own cookie
  // store, separate from Safari) re-grants access on every cold launch — without exposing anything
  // to anonymous requests. Relies on `crossorigin="use-credentials"` on the manifest <link> so this
  // fetch carries the cookie. Served no-store since the body varies by cookie.
  //
  // The credential is a long-lived *per-device* token, not the shared access code. iOS freezes
  // start_url at install time and re-fetches the manifest unpredictably, so a shared code baked in
  // here would have to stay valid forever or installed devices would lose their cold-launch unlock
  // on rotation — which would defeat rotating at all. A device token sidesteps that entirely.
  app.get('/manifest.webmanifest', async (c) => {
    const grant = await hasAccess(c);
    const startUrl = grant
      ? `/?code=${encodeURIComponent(await deviceTokenFor(grant.deviceId))}`
      : '/';
    const manifest = {
      // Without an `id`, Chrome identifies the app by its start_url — which here carries a secret
      // that changes on every revoke, so the installed app would turn into a different app.
      id: '/',
      name: config.appName,
      short_name: config.appShortName,
      description: config.appDescription,
      start_url: startUrl,
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      // The two are deliberately different colours. `background_color` is the ground Android paints
      // behind the icon while the app opens, so it matches the icon's own field and the iOS launch
      // images (both hymn-book green, see scripts/generate-icons.mjs); `theme_color` tints the
      // system chrome around the running app, so it matches the app's navy header.
      background_color: '#24513f',
      theme_color: '#1f3a5f',
      // Two sets, not one icon claiming both purposes: a maskable icon may be cropped to any shape
      // containing the centred 80%-diameter circle, and the building only fits that circle at about
      // two-thirds the height it can have in the square. Declaring them separately lets the
      // home-screen icon use the whole tile and the launcher-masked one stay inside the safe zone.
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: '/icons/icon-192-maskable.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'maskable',
        },
        {
          src: '/icons/icon-512-maskable.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    };
    c.header('Cache-Control', 'no-store');
    return c.body(JSON.stringify(manifest), 200, {
      'content-type': 'application/manifest+json; charset=utf-8',
    });
  });

  app.get('/api/announcements', async (c) => {
    // Varies by cookie (the gate decides whether this is answered at all) and by expiry date, so no
    // shared cache may keep a copy and hand it to the next person. Deliberately `no-cache` and not
    // `no-store`: the service worker skips caching a `no-store` response (see public/sw.js), and the
    // offline copy in the chapel — where the building's wifi is a rumour — is the point of the PWA.
    // `no-cache` still means "revalidate before reuse", which is what a private store must do.
    c.header('Cache-Control', 'private, no-cache');
    const list = await listPublicAnnouncements();
    // One query for every announcement's images rather than one per announcement: this endpoint is
    // fetched on every page load and every app resume, and on Workers each query is a network round
    // trip to D1.
    const images = groupByOwner(await listAttachmentsForOwners('announcement', list.map((a) => a.id)));
    return json(c, {
      announcements: list.map((a) => ({
        id: a.id,
        title: a.title,
        html: renderMarkdown(a.body),
        // Rendered by the client as a thumbnail row under the body (see public/app.js). Sent as
        // data rather than folded into `html` so the markup stays the sanitized Markdown output
        // and nothing else.
        images: (images.get(a.id) ?? []).map((row) => ({
          url: `/images/${row.key}`,
          // Not the stored filename. What a clerk names a file on their own machine is theirs —
          // "bishop-storey-funeral-final2.jpg", a member's name, a path fragment — and in an `alt`
          // attribute it would go out to every reader as text nobody thought of as published. The
          // filename stays visible admin-side, where it is genuinely useful.
          alt: '',
        })),
      })),
    });
  });

  /**
   * The Resources tab: every published page, in order, with its images. Same headers and the same
   * one-query image lookup as `/api/announcements`, for the same reasons — it is fetched on every
   * load and resume, and it is behind the member gate. A page has no window and no expiry, so
   * there is nothing time-sensitive here; the tab just shows whatever is published.
   */
  app.get('/api/pages', async (c) => {
    c.header('Cache-Control', 'private, no-cache');
    const list = await listPublicPages();
    const images = groupByOwner(await listAttachmentsForOwners(PAGE_OWNER, list.map((p) => p.id)));
    return json(c, {
      pages: list.map((p) => ({
        id: p.id,
        title: p.title,
        html: renderMarkdown(p.body),
        // No filename, as on the announcements route.
        images: (images.get(p.id) ?? []).map((row) => ({ url: `/images/${row.key}`, alt: '' })),
      })),
    });
  });

  /**
   * Today's sacrament meeting program — or the closed message, which is all anyone ever gets.
   *
   * **The window is enforced here, not in the tab UI.** A program names the people conducting,
   * speaking and praying; hiding the tab client-side would leave every one of those names a `curl`
   * away for anyone holding the member cookie's URL, so the server refuses to render the body at all
   * outside the window. Outside it, "nobody wrote one" and "one is waiting" produce the identical
   * `{open:false}` response, so the reply can't even be used to probe whether a program exists. Only
   * inside the window does the wording differ from outside it — the automatic message stops saying
   * "will be here Sunday" on the Sunday — and there a program's existence is already public.
   *
   * A signed-in session gets no special treatment: the public page shows an admin exactly what a
   * member sees, so what they see is what the ward sees. Proofing a program before its Sunday is the
   * dashboard's job — `/admin/programs/:id/preview/fragment` renders it the way this page will.
   */
  app.get('/api/program', async (c) => {
    // The strongest reason of the two on this pair: this response varies by *wall clock*, not just
    // by cookie. A shared cache that kept Sunday's body and replayed it on Tuesday would hand out
    // exactly the list of names the window exists to withhold. `no-cache` (not `no-store`) so the
    // service worker may still keep the private copy that makes the program readable on a chapel
    // wifi that has given up — it revalidates before showing it.
    c.header('Cache-Control', 'private, no-cache');
    const settings = await getProgramSettings();
    const now = new Date();
    const windowOpen = programWindowOpen(now, settings);
    const program = windowOpen ? await getProgramByDate(localDate(now)) : undefined;
    // The message is chosen from the settings and the clock alone (see `closedProgramMessage`), so
    // outside the window this reply is the same bytes whether or not a program has been written.
    if (!program) {
      return json(c, { open: false, message: closedProgramMessage(settings, windowOpen) });
    }
    const images = await listAttachments(PROGRAM_OWNER, program.id);
    return json(c, {
      open: true,
      date: program.program_date,
      // When this copy stops being one to show: the service worker's offline copy is refused after it.
      closesAt: programWindowClosesAt(now, settings),
      html: renderProgramMarkdown(program.body_md),
      // No filename here either — see the announcements route.
      images: images.map((row) => ({ url: `/images/${row.key}`, alt: '' })),
    });
  });

  // An uploaded image. Ungated (see `gateExempt`) and served with a one-year immutable cache: the
  // key is a content-addressed-style random name that is never reused, so a stored object at a
  // given URL can never change and a phone that has seen it once never asks again.
  app.get('/images/:key', async (c) => {
    const key = c.req.param('key');
    // Validate before touching the store: on Node the key becomes a filesystem path, and this is
    // the check that makes traversal unspellable rather than merely unlikely.
    if (!isValidKey(key)) return text(c, 'Not found', 404);
    // A program's images are as private as the program: they are often a photo of the printed
    // one, names and all. Announcement and page images stay open (see `gateExempt`); a program's
    // load only for someone signed in to the dashboard, or for a member while that program's window
    // is open — the rule `/api/program` applies to the text — and are never cached, so they do not
    // outlive the window on a phone or in the service worker. Not found, never forbidden, so a key
    // cannot be tested. An image no row names (a delete that half-failed) is not served at all.
    const row = await attachmentByKey(key);
    if (!row) return text(c, 'Not found', 404);
    const open = row.owner_type === 'announcement' || row.owner_type === PAGE_OWNER;
    if (!open && !(await mayViewPrivateImage(c, row))) return text(c, 'Not found', 404);
    // Served as what the key's extension says, never as what the store holds: a tampered backup
    // restored into the store could otherwise make this origin serve HTML from a `.png` key, and a
    // key with an extension this app does not make is not served at all.
    const contentType = contentTypeForKey(key);
    if (!contentType) return text(c, 'Not found', 404);
    const file = await files.get(key);
    if (!file) return text(c, 'Not found', 404);
    c.header('Cache-Control', open ? 'public, max-age=31536000, immutable' : 'private, no-store');
    // `c.body` takes a stream (R2) or an ArrayBuffer (the filesystem store); a Uint8Array's own
    // buffer may be a slice of a larger allocation, so hand over exactly this view's bytes.
    const body: ArrayBuffer | ReadableStream =
      file.body instanceof Uint8Array
        ? (file.body.buffer.slice(
            file.body.byteOffset,
            file.body.byteOffset + file.body.byteLength,
          ) as ArrayBuffer)
        : file.body;
    return c.body(body, 200, { 'content-type': contentType });
  });

  app.get('/api/vapid-public-key', (c) => json(c, { key: config.vapid.publicKey }));

  // Unlock from a credential carried in the URL *fragment* (`#code=…` / `#i=…`). A fragment is never
  // sent to the server, so it stays out of proxy access logs and out of the fetches that chat apps
  // make to unfurl a pasted link — the reason newly-issued links prefer it over `?code=`. The gate
  // page's inline script reads the fragment and posts it here. Gate-exempt (it's how you get in) and
  // rate-limited, since this is the one endpoint where a credential can be guessed at.
  // The member-facing limits are sized for the launch ritual, not for one member: a chapel full of
  // people scanning the QR code at once shares a single NAT address, so a per-IP cap of twenty
  // told the twenty-first that their brand-new link had expired. The code has ~79 bits of entropy
  // (`newAccessCode`), so these are abuse brakes rather than a brute-force defence, and three
  // hundred a minute from one address is still five a second.
  app.post('/api/access', limit(300), async (c) => {
    // `unknown`, not `string`: this body is unauthenticated JSON, so `{"code": [1]}` is a shape a
    // stranger can pick. `redeemCredential` rejects a non-string as simply not a credential.
    const { code } = (await readBody(c)) as { code?: unknown };
    const redeemed = await redeemCredential(code);
    if (!redeemed) {
      return json(c, { error: 'Invalid or expired link' }, 401);
    }
    // An existing valid cookie wins: that identity already owns a device token. Otherwise adopt
    // whatever the redeemed credential carries, so a device token keeps its own id.
    const existing = await hasAccess(c);
    await grantAccess(c, existing ?? (redeemed.deviceId ? { deviceId: redeemed.deviceId } : undefined));
    return json(c, { ok: true });
  });

  // "Share With Someone": mint a self-expiring invite and render it as a link + QR for the member's
  // share sheet. Behind the gate (the middleware above 401s anyone without access), so only someone
  // who already has the app can create one. Deliberately *not* the shared access code — an invite
  // dies on its own schedule, so a screenshot of someone's share sheet doesn't outlive its use.
  app.post('/api/invite', limit(60), async (c) => {
    // Attribute the invite to the device that asked for it, so `mintInvite` can bound how many live
    // links one member's cookie can put into the world (see MAX_LIVE_INVITES_PER_DEVICE). At the
    // cap the newest existing link comes back instead of a sixth — the member gets a working link
    // either way, which is why the share sheet needs no new branch.
    const grant = await hasAccess(c);
    // The cookie, and only the cookie. The gate also lets a request through on a credential in
    // `?code=`, but that request has no device to count against — and was once an uncapped path:
    // one leaked invite, presented in `?code=` without a cookie, minted invites without end. The
    // share sheet only ever runs in a page that already holds the cookie, so it loses nothing.
    if (!grant) return json(c, { error: 'Open the app first, then share from there.' }, 401);
    const invite = await mintInvite(grant.deviceId);
    const url = `${originFor(c)}/#i=${invite.token}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240 });
    return json(c, { url, qrSvg, expiresInDays: invite.expiresInDays, reused: invite.reused });
  });

  // Rate-limited: a ward member only ever needs a couple of (re)subscriptions; cap junk flooding.
  app.post('/api/subscribe', limit(300), async (c) => {
    const sub = (await readBody(c)) as SubscribeBody;
    // Shape first, before anything is looked up or stored. Anyone with the shared code can reach
    // this route, and a 30 KB "endpoint" with a 20 KB "key" used to be accepted as-is: a few
    // thousand of those fill MAX_SUBSCRIPTIONS and lock real members out, and every weekly send
    // grinds through them. A non-string field used to reach `String()`/the driver and 500.
    const problem = subscriptionProblem(sub);
    if (problem) return json(c, { error: problem }, 400);
    const endpoint = sub.endpoint as string;
    const keys = sub.keys as { p256dh: string; auth: string };
    // Every send POSTs to every stored endpoint, so an endpoint is a URL this server will fetch: it
    // must be a real push service, never an internal address (a member could otherwise point the
    // server at anything it can reach) — see `isPushEndpoint`.
    if (!isPushEndpoint(endpoint, config.isProduction)) {
      return json(c, { error: 'That is not a push service this app sends to.' }, 400);
    }
    // And a ceiling, so a flood of made-up subscriptions cannot swamp the weekly send.
    if (!(await getSubscriptionByEndpoint(endpoint)) && (await countSubscriptions()) >= MAX_SUBSCRIPTIONS) {
      return json(c, { error: 'This ward has reached its limit of notification subscriptions.' }, 429);
    }
    // Subscription rotation: the push service issued a new endpoint, so the old one is dead.
    const rotatedFrom =
      typeof sub.oldEndpoint === 'string' && sub.oldEndpoint && sub.oldEndpoint !== endpoint ? sub.oldEndpoint : null;
    // An admin's Remove under Subscribers blocks the endpoint (`blocked_subscriptions` in db.ts),
    // because the phone still holds its subscription and re-posts it at every launch; without this
    // the row was back the next time the member opened the app. Only the member's own tap on
    // Enable Notifications carries `deliberate: true` and lifts the block — the launch re-sync and
    // the service worker's rotation paths never send it. A rotation of a blocked endpoint moves
    // the block to the new one: it was the device that was removed, not the endpoint.
    const blocked =
      (await isBlockedSubscription(endpoint)) || (rotatedFrom !== null && (await isBlockedSubscription(rotatedFrom)));
    if (blocked && sub.deliberate !== true) {
      if (rotatedFrom !== null) await moveSubscriptionBlock(rotatedFrom, endpoint);
      return json(c, { error: 'This device was removed from notifications by the ward.', blocked: true }, 409);
    }
    await upsertSubscriptionWith(
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: c.req.header('user-agent') ?? null,
      },
      { rotatedFrom, unblock: blocked },
    );
    return json(c, { ok: true }, 201);
  });

  app.post('/api/unsubscribe', limit(60), async (c) => {
    // `unknown`, for the same reason as subscribe: a JSON `{"endpoint": {}}` is a 400, not a 500.
    const { endpoint } = (await readBody(c)) as { endpoint?: unknown };
    if (typeof endpoint !== 'string' || !endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
      return json(c, { error: 'Missing endpoint' }, 400);
    }
    await deleteSubscription(endpoint);
    return json(c, { ok: true });
  });

  // --- Admin: auth ---------------------------------------------------------

  // `?next=` is where `requireAuth` was asked to go (usually the form a save came from, where the
  // unsaved draft is waiting), and is honoured only as a dashboard path — `adminReturnPath`.
  app.get('/admin/login', (c) => {
    const next = adminReturnPath(c.req.query('next'));
    if (isAuthenticated(c)) return redirect(c, next ?? '/admin');
    return html(c, loginPage(undefined, hasOwner(), next));
  });

  // The owner's password. Rate-limited to blunt brute-forcing: 5 attempts per minute per IP, then 429.
  // Everyone else signs in with a passkey (below).
  app.post('/admin/login', limit(5), async (c) => {
    // `unknown`: the login body is the most-poked unauthenticated surface there is, and a JSON
    // `{"password": 12345}` reaching `createHash().update()` would 500 with Node's own error text.
    // `isOwnerPassword` treats a non-string as a wrong password.
    const { password, next: rawNext } = (await readBody(c)) as { password?: unknown; next?: unknown };
    const next = adminReturnPath(rawNext);
    if (!isOwnerPassword(password)) {
      return html(c, loginPage('Incorrect password.', hasOwner(), next), 401);
    }
    await startOwnerSession(c);
    return redirect(c, next ?? '/admin');
  });

  // --- Passkeys (src/passkeys.ts) ---------------------------------------------
  //
  // Unauthenticated by nature — they are how a session starts — so each is rate-limited. The
  // options calls are cheap and a page may retry them; the verify calls are where a guess would go.
  const passkeyReply = (c: Context, outcome: Awaited<ReturnType<typeof signInOptions>>) =>
    outcome.ok ? json(c, outcome.json) : json(c, { error: outcome.error }, outcome.status);
  app.post('/admin/passkey/login/options', limit(30), async (c) => passkeyReply(c, await signInOptions(c)));
  app.post('/admin/passkey/login/verify', limit(10), async (c) => passkeyReply(c, await signInVerify(c, await readBody(c))));
  app.get('/admin/invite', (c) => html(c, invitePage()));
  app.post('/admin/passkey/register/options', limit(30), async (c) => {
    const { token } = (await readBody(c)) as { token?: unknown };
    return passkeyReply(c, await registrationOptions(c, token));
  });
  app.post('/admin/passkey/register/verify', limit(10), async (c) => {
    const { token, response } = (await readBody(c)) as { token?: unknown; response?: unknown };
    return passkeyReply(c, await registrationVerify(c, token, response));
  });

  // --- Your own account: passkeys on more devices --------------------------------
  //
  // Any signed-in person, either role. The owner has no row to hang a passkey on (they sign in with
  // the password); the page tells them to add themselves under People if they want one.

  app.get('/admin/me', requireAuth, async (c) => {
    const who = whoOf(c)!;
    return html(
      c,
      accountPage({
        who,
        passkeys: who.userId === null ? [] : await listAdminPasskeys(who.userId),
        flash: c.req.query('msg'),
      }),
    );
  });

  const personOnly = (c: Context) => whoOf(c)?.userId ?? null;
  // The owner's Sign Out Everywhere: every owner session ends, this browser gets a fresh one.
  app.post('/admin/me/signout-everywhere', requireAuth, async (c) => {
    if (personOnly(c) !== null) return redirect(c, '/admin/me');
    await endOwnerSessions(c);
    return redirect(c, `/admin/me?msg=${encodeURIComponent('Signed out on every other device.')}`);
  });
  app.post('/admin/passkey/add/options', requireAuth, limit(30), async (c) => {
    const userId = personOnly(c);
    if (userId === null) return json(c, { error: 'The owner signs in with the password. Add yourself under People to use a passkey.' }, 400);
    return passkeyReply(c, await addOptions(c, userId));
  });
  app.post('/admin/passkey/add/verify', requireAuth, limit(10), async (c) => {
    const userId = personOnly(c);
    if (userId === null) return json(c, { error: 'The owner signs in with the password.' }, 400);
    return passkeyReply(c, await addVerify(c, userId, await readBody(c)));
  });
  // Your own name, either role. Only the name: a role is an admin's decision, made under People.
  app.post('/admin/me/name', requireAuth, async (c) => {
    const userId = personOnly(c);
    if (userId === null) return redirect(c, '/admin/me');
    const body = (await readBody(c)) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const me = await getAdminUser(userId);
    if (!me) return redirect(c, '/admin/me');
    if (!name) return redirect(c, `/admin/me?msg=${encodeURIComponent('Your name cannot be empty.')}`);
    await updateAdminUser(userId, { name, role: me.role });
    return redirect(c, `/admin/me?msg=${encodeURIComponent('Name saved.')}`);
  });
  app.post('/admin/me/passkeys/:passkey/delete', requireAuth, async (c) => {
    const userId = personOnly(c);
    if (userId === null) return redirect(c, '/admin/me');
    if (await strandsAdmins(userId, 'passkey')) {
      return redirect(c, `/admin/me?msg=${encodeURIComponent(LAST_ADMIN)}`);
    }
    await deleteAdminPasskey(userId, c.req.param('passkey'));
    // That signed the person out everywhere (see `deleteAdminPasskey`); keep this browser, which is
    // the one that asked, signed in on the new version.
    const me = await getAdminUser(userId);
    if (me) await startUserSession(c, me);
    return redirect(c, `/admin/me?msg=${encodeURIComponent('Passkey removed. Any other device you were signed in on is signed out.')}`);
  });

  // --- People (admin only) -------------------------------------------------------

  const ROLES = ['admin', 'editor'] as const;
  const personInput = (body: Record<string, unknown>) => {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const role = ROLES.find((r) => r === body.role);
    return name && role ? { name, role } : null;
  };
  const strandsAdmins = async (id: number, change: AdminChange) =>
    wouldStrandAdmins(await listAdminUsers(), id, change, hasOwner());
  const LAST_ADMIN = 'This is the only admin who can sign in. Add another admin, and let them set up their passkey, first.';
  const personId = (c: Context) => {
    const id = Number(c.req.param('id'));
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  app.post('/admin/people', requireAdmin, async (c) => {
    const input = personInput((await readBody(c)) as Record<string, unknown>);
    if (!input) return redirect(c, dash('settings', 'A person needs a name and a role.'));
    const { id } = await invitePerson(input);
    return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent(`${input.name} added. Send them the invite link below.`)}`);
  });

  app.get('/admin/people/:id', requireAdmin, async (c) => {
    const id = personId(c);
    const person = id ? await getAdminUser(id) : undefined;
    if (!person) return text(c, 'Not found', 404);
    const invite = await currentAdminInvite(person.id);
    let inviteView: { link: string; qrSvg: string; expiresAt: string } | null = null;
    if (invite) {
      const link = `${originFor(c)}/admin/invite#t=${invite.token}`;
      inviteView = { link, qrSvg: await QRCode.toString(link, { type: 'svg', margin: 1, width: 208 }), expiresAt: invite.expires_at };
    }
    return html(
      c,
      personPage({
        person,
        passkeys: await listAdminPasskeys(person.id),
        invite: inviteView,
        isSelf: whoOf(c)?.userId === person.id,
        flash: c.req.query('msg'),
      }),
    );
  });

  app.post('/admin/people/:id', requireAdmin, async (c) => {
    const id = personId(c);
    const input = personInput((await readBody(c)) as Record<string, unknown>);
    if (!id || !(await getAdminUser(id))) return text(c, 'Not found', 404);
    if (!input) return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent('A person needs a name and a role.')}`);
    if (input.role !== 'admin' && (await strandsAdmins(id, 'demote'))) {
      return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent(LAST_ADMIN)}`);
    }
    await updateAdminUser(id, input);
    return redirect(c, `/admin/people/${id}?msg=Saved.`);
  });

  app.post('/admin/people/:id/invite', requireAdmin, async (c) => {
    const id = personId(c);
    if (!id || !(await getAdminUser(id))) return text(c, 'Not found', 404);
    await createAdminInvite(id, randomToken(), INVITE_DAYS);
    return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent('New invite link made. Any earlier one no longer works.')}`);
  });

  app.post('/admin/people/:id/signout', requireAdmin, async (c) => {
    const id = personId(c);
    if (!id || !(await getAdminUser(id))) return text(c, 'Not found', 404);
    await bumpAdminSessionVersion(id);
    return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent('Signed out on every device.')}`);
  });

  app.post('/admin/people/:id/passkeys/:passkey/delete', requireAdmin, async (c) => {
    const id = personId(c);
    if (!id || !(await getAdminUser(id))) return text(c, 'Not found', 404);
    if (await strandsAdmins(id, 'passkey')) return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent(LAST_ADMIN)}`);
    await deleteAdminPasskey(id, c.req.param('passkey'));
    // An admin removing one of their own from here keeps this browser, as on /admin/me.
    if (personOnly(c) === id) {
      const me = await getAdminUser(id);
      if (me) await startUserSession(c, me);
    }
    return redirect(c, `/admin/people/${id}?msg=${encodeURIComponent('Passkey removed, and signed out on every device.')}`);
  });

  app.post('/admin/people/:id/delete', requireAdmin, async (c) => {
    const id = personId(c);
    const person = id ? await getAdminUser(id) : undefined;
    if (!person) return text(c, 'Not found', 404);
    if (await strandsAdmins(person.id, 'remove')) return redirect(c, `/admin/people/${person.id}?msg=${encodeURIComponent(LAST_ADMIN)}`);
    await deleteAdminUser(person.id);
    return redirect(c, dash('settings', `${person.name} removed.`));
  });

  app.post('/admin/logout', (c) => {
    clearSession(c);
    // `?out=1` tells the login page's script to drop the editor's on-device drafts (`layout` in
    // views.ts): Log Out is the one moment a person means "nothing of mine stays on this computer",
    // which the shared clerk's-office machine needs. A session that merely expired must *not* do
    // this — the draft is what carries a save across that — so it is a flag the logout sets, not
    // something the login page does on sight.
    return redirect(c, '/admin/login?out=1');
  });

  // --- Admin: dashboard + CRUD (all behind requireAuth) --------------------

  app.get('/admin', requireAuth, async (c) => {
    // A deployment with no PUBLIC_ORIGIN learns it here, from the admin's own landing page — before
    // the dashboard renders, so the share link and QR below are already absolute. See `identity.ts`
    // for why only an admin's request, and only its own URL.
    if (!config.publicOrigin && roleOf(c) === 'admin') await learnOrigin(new URL(c.req.url).origin);
    const msg = c.req.query('msg');
    // An editor's dashboard omits the weekly message, the gate controls and the code history — so
    // it also skips the queries behind them, which on Workers are that many fewer round trips to
    // D1. `dashboardPage` takes them as one optional bag for exactly this reason: the role decides
    // once, here, and the view has nothing to render if it wasn't fetched.
    //
    // The *schedule* is the exception, read for both: an editor cannot change when the weekly
    // notification goes out, but they are the one publishing what it carries, so the dashboard
    // tells them when that is.
    const isAdminSession = roleOf(c) === 'admin';
    const gate = await getGateSettings();
    const schedule = await getScheduleSettings();
    const programSettings = await getProgramSettings();
    // The meeting time the window and schedule were derived from, if any — and whether either has
    // been changed by hand since (`meeting.ts`). Read for both roles: the editor's schedule line
    // says the same "from your meeting time" the admin's does.
    const meetingTime = await getMeetingTime();
    const timing = timingStatus(meetingTime, programSettings, schedule, {
      program: DEFAULT_PROGRAM_SETTINGS,
      schedule: DEFAULT_SCHEDULE,
    });
    const active = await activeAccessCode();
    // The share link puts the code in the fragment: a fragment never reaches the server, so it stays
    // out of the reverse proxy's access log and out of the fetch a chat app makes when it unfurls a pasted link.
    const accessLink = active
      ? `${config.publicOrigin}/#code=${encodeURIComponent(active.code)}`
      : null;
    // Render a QR of the share link (only meaningful when it's an absolute URL).
    let qrSvg: string | null = null;
    if (accessLink && config.publicOrigin) {
      qrSvg = await QRCode.toString(accessLink, { type: 'svg', margin: 1, width: 208 });
    }
    // Fetched once for both roles: the skip card lists them, and the admin's "Next send" line has
    // to step past them or it names a Sunday the card right below says is silent.
    const skips = await listSkipsFrom(localDate(new Date()));
    const announcements = await listAllAnnouncements();
    const subscribers = await countSubscriptions();
    // The first-run checklist: admins only, until dismissed or every step is done. Each step is
    // read off the ward's own data, so nobody has to tick anything. A dismissed list with steps
    // still open can be brought back from the Ward settings card.
    let gettingStarted: GettingStarted | undefined;
    let gettingStartedHidden = false;
    if (isAdminSession) {
      // Someone signed in with a passkey has already added themselves (on a hosted ward the
      // operator's invite does it), so for them the step is about the *others* and wants a second
      // person; the owner, on the password, still has to add anyone at all.
      const signedInAsPerson = whoOf(c)?.userId != null;
      const people = (await listAdminUsers()).length;
      const steps: GettingStarted = {
        wardNamed: (await getSetting('ward_settings')) !== null,
        meetingTimeSet: meetingTime !== null,
        signedInAsPerson,
        personAdded: people >= (signedInAsPerson ? 2 : 1),
        // The ward's own first announcement, and the sample gone: left in place it is live to members.
        announcementWritten:
          announcements.some((a) => a.title !== SAMPLE_ANNOUNCEMENT_TITLE) &&
          !announcements.some((a) => a.title === SAMPLE_ANNOUNCEMENT_TITLE),
        memberSubscribed: subscribers > 0,
      };
      const { signedInAsPerson: _, ...ticks } = steps;
      if (!Object.values(ticks).every(Boolean)) {
        if ((await getSetting(GETTING_STARTED_DISMISSED)) === '1') gettingStartedHidden = true;
        else gettingStarted = steps;
      }
    }
    return html(
      c,
      dashboardPage({
        role: isAdminSession ? 'admin' : 'editor',
        subscribers,
        publicCount: await countPublicAnnouncements(),
        announcements,
        pages: await listAllPages(),
        preview: await liveRichPreview(),
        sends: await recentSendHistory(10),
        // Marks "you" on the People list; null for the owner, who is not one of the people.
        selfId: whoOf(c)?.userId ?? null,
        queued: await sendQueueDepth(),
        programs: {
          recent: await listRecentPrograms(dashboardProgramLimit(programSettings.retentionDays)),
          settings: programSettings,
          today: localDate(new Date()),
          windowOpenNow: programWindowOpen(new Date(), programSettings),
          maxRetentionDays: MAX_RETENTION_DAYS,
        },
        access: {
          enabled: !!active,
          link: accessLink,
          hasOrigin: !!config.publicOrigin,
          qrSvg,
          liveInvites: await countLiveInvites(),
          inviteTtlDays: gate.inviteTtlDays,
        },
        schedule: { dow: schedule.dow, time: schedule.time, autoSend: await isAutoSendEnabled() },
        meeting: { time: meetingTime, timing },
        // For the summary strip, both roles: worked out from the schedule and skip list the page
        // already shows an editor, and from stored settings rather than a timer, as below.
        nextSendAt:
          nextSendingSlotAfter(new Date(), schedule, skips.map((s) => s.skip_date), config.timezone)?.at ?? null,
        skips,
        today: localDate(new Date()),
        flash: msg,
        admin: isAdminSession
          ? await adminDashboardData(gate.message, schedule, skips.map((s) => s.skip_date))
          : undefined,
        ward: isAdminSession ? { settings: currentWardSettings(), limits: WARD_LIMITS, gettingStartedHidden } : undefined,
        gettingStarted,
      }),
    );
  });

  /**
   * The announcements members can see right now, as rich text. The same query and the same image
   * lookup `/api/announcements` uses, so "what would a member see" and "what gets copied or saved
   * as a PDF" cannot disagree on which rows are live.
   */
  async function liveRichPreview(): Promise<string> {
    const list = await listPublicAnnouncements();
    const images = groupByOwner(await listAttachmentsForOwners('announcement', list.map((a) => a.id)));
    return richPreviewHtml(
      list.map((a) => ({ title: a.title, body: a.body, images: images.get(a.id) ?? [] })),
    );
  }

  // The same preview on its own page, for both roles: an editor writes the announcements and is as
  // likely as an admin to be the one sending them on.
  app.get('/admin/announcements/preview', requireAuth, async (c) =>
    html(c, richPreviewPage(await liveRichPreview(), roleOf(c) === 'admin' ? 'admin' : 'editor')),
  );

  // Just the preview markup, for the dashboard's modal to refetch each time it opens: the modal is
  // rendered into the page once, but a drag-to-reorder (or an edit in another tab) changes what is
  // live without reloading the dashboard.
  app.get('/admin/announcements/preview/fragment', requireAuth, async (c) => html(c, await liveRichPreview()));

  // "Include a link to the app": the block the Preview's checkbox puts below the announcements, so
  // the weekly email and its PDF can carry a way in. A POST because it can mint a credential — the
  // fragment above is refetched on every open of the modal and must never do that. Both roles, as an
  // editor already hands out the share link. Deliberately *not* the shared code: an email is
  // archived and forwarded, and a code sitting in every old one would make rotating it pointless.
  app.post('/admin/announcements/preview/link', requireAuth, async (c) => {
    const base = `${originFor(c)}/`;
    const link = await mintEmailLink();
    return json(c, {
      html: appLinkHtml({ url: `${base}#i=${link.token}`, through: lastFullDay(link.expiresAt) }),
    });
  });

  /** The half of the dashboard only an admin is shown — and only then is it queried for. */
  async function adminDashboardData(
    gateMessage: string,
    schedule: ScheduleSettings,
    skipDates: string[],
  ) {
    const weekly = await getWeeklyMessageSettings();
    // Computed from the stored settings, not from a live timer: the dashboard has to show the
    // same answer on Workers, where there is no croner job to ask.
    const next = nextSendingSlotAfter(new Date(), schedule, skipDates, config.timezone);
    return {
      people: await listAdminUsers(),
      weeklyTitle: weekly.title,
      weeklyBody: weekly.body,
      timezone: config.timezone,
      nextRunLabel: formatNextRun(next?.at ?? null),
      nextRunSkipped: next?.skipped ?? 0,
      sendAlert: (await getSetting('send_alert')) || undefined,
      codes: await listAccessCodes(),
      gateMessage,
      inviteTtlMaxDays: INVITE_TTL_MAX_DAYS,
    };
  }

  /**
   * The share-link QR as a file, in either format. Behind auth because the encoded link contains
   * the member access code.
   *
   * Both, because the two get used for different errands. **SVG** is the one to print — a poster on
   * the bulletin board, a slide, anything that will be scaled — since it stays sharp at any size.
   * **PNG** is the one everything else accepts: pasting into a flyer in Word or Canva, attaching to
   * a text, uploading to a site that rejects SVG for being a scriptable format.
   *
   * The SVG comes from `qrcode`'s own renderer. The PNG cannot — the library's PNG path needs
   * `node:zlib`, which the Workers runtime does not give us — so `qr-png.ts` encodes the same
   * library's module matrix directly. One QR, one code path up to the last step.
   */
  const QR_MARGIN = 2;
  const qrDownload = (format: 'svg' | 'png') => async (c: Context) => {
    const active = await activeAccessCode();
    if (!active || !config.publicOrigin) {
      return text(c, 'QR code is not available.', 404, false);
    }
    const accessLink = `${config.publicOrigin}/#code=${encodeURIComponent(active.code)}`;
    // Both formats *are* the member access code, drawn as squares. `.png` and `.svg` are exactly the
    // extensions a CDN is happiest caching on sight, so say no explicitly rather than rely on a
    // cache inferring privacy from a cookie it wasn't asked about. `no-store` and not `no-cache`:
    // there is no offline story here to protect, unlike the two public APIs.
    c.header('Cache-Control', 'private, no-store');
    if (format === 'png') {
      const matrix = QRCode.create(accessLink, {}).modules;
      // ~1024px, rounded to a whole number of pixels per module — see `scaleFor`.
      const png = qrPng(matrix, { scale: scaleFor(matrix.size + QR_MARGIN * 2), margin: QR_MARGIN });
      // Hand over exactly these bytes: a Uint8Array's own buffer may be a slice of a larger
      // allocation (the same reason `/images/:key` slices).
      const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      return c.body(body, 200, {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="announcements-qr.png"',
      });
    }
    // `width` is the SVG's viewport, which scales anyway.
    const svg = await QRCode.toString(accessLink, { type: 'svg', margin: QR_MARGIN, width: 1024 });
    return c.body(svg, 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-disposition': 'attachment; filename="announcements-qr.svg"',
    });
  };
  app.get('/admin/qr.svg', requireAuth, qrDownload('svg'));
  app.get('/admin/qr.png', requireAuth, qrDownload('png'));

  /**
   * What the printable "get the app" flyer (`public/flyer-pdf.js`) fills in: the ward's name, the
   * home-screen name, the share link and that link's QR module matrix. Fetched when the button is
   * pressed rather than written into the dashboard, so a dashboard load does not pay for a second
   * QR encoding (CPU a Worker counts) that hardly anyone uses.
   *
   * The matrix is sent rather than drawn in the browser because pdfmake's own `qr` node sizes its
   * modules in whole points, which would print the code anywhere from 15 to 32 mm depending on the
   * link's length. Quartile error correction (the downloads use the library's default, Medium):
   * the flyer is photocopied, and a copier eats module edges. Both roles, like the QR downloads;
   * `no-store` for the same reason — this *is* the access code.
   */
  app.get('/admin/flyer.json', requireAuth, async (c) => {
    const active = await activeAccessCode();
    if (!active || !config.publicOrigin) return json(c, { error: 'no share link' }, 404);
    const link = `${config.publicOrigin}/#code=${encodeURIComponent(active.code)}`;
    const qr = QRCode.create(link, { errorCorrectionLevel: 'Q' }).modules;
    const rows: string[] = [];
    for (let r = 0; r < qr.size; r++) {
      let row = '';
      for (let col = 0; col < qr.size; col++) row += qr.get(r, col) ? '1' : '0';
      rows.push(row);
    }
    c.header('Cache-Control', 'private, no-store');
    return json(c, { wardName: config.appName, shortName: config.appShortName, link, qr: rows });
  });

  // --- Admin: member access gate -------------------------------------------

  // Issue a New Code: mint a new active code and put the outgoing one on a grace clock. Members who
  // already unlocked keep their cookie by default — the grace window is for QR posters and links
  // still in circulation. The default is a week: long enough to reprint a poster, short enough that
  // a code rotated because it leaked actually dies (a year's grace, the old default, left two live
  // codes for a year, so rotating did almost nothing).
  //
  // The same form carries the evictions, because they only make sense *with* a rotation: `browsers`
  // rolls the member cookie key (a stranger or bot that opened the link in a browser is out, installed
  // apps re-unlock from their device token on next launch), and `all` also deletes every saved
  // credential — device tokens, invite links, email links — so nobody gets back in without the new
  // code. Either forces the grace to zero: a retired code still working would let the evicted party
  // straight back in. They used to be three separate buttons whose copy said "do the other one
  // first", which is the sequencing mistake this form removes.
  app.post('/admin/access/rotate', requireAdmin, async (c) => {
    const { grace, evict } = (await readBody(c)) as { grace?: string; evict?: string };
    const eviction = evict === 'browsers' || evict === 'all' ? evict : evict === undefined || evict === 'none' ? 'none' : null;
    if (eviction === null) return redirect(c, dash('settings', 'Pick who is signed out.'));
    // Whole digits only: `Number('')` is 0, which would read a select that lost its value as "stop
    // it immediately" instead of refusing.
    let graceDays = grace === 'never' ? null : typeof grace === 'string' && /^\d+$/u.test(grace) ? Number(grace) : NaN;
    if (
      grace !== 'never' &&
      (!Number.isInteger(graceDays) || (graceDays as number) < 0 || (graceDays as number) > 36500)
    ) {
      return redirect(c, dash('settings', 'Pick how long the old code lasts.'));
    }
    if (eviction !== 'none') graceDays = 0;
    await rotateAccessCode(newAccessCode(), graceDays);
    if (eviction === 'all') await deleteAllAccessTokens();
    if (eviction !== 'none') await resetAccessSecret();
    const graceNote =
      graceDays === null
        ? 'the old code keeps working indefinitely'
        : graceDays === 0
          ? 'the old code stopped working immediately'
          : `the old code works for another ${graceDays} days`;
    const evictNote =
      eviction === 'all'
        ? ' Everyone is signed out, installed apps included: send the new link by text or email so members can paste it into the box the app shows, or delete the app and add it again.'
        : eviction === 'browsers'
          ? ' Members on a phone browser are signed out and need the new link or QR code; installed apps sign back in on their own.'
          : '';
    return redirect(c, dash('settings', `New access code issued — ${graceNote}.${evictNote}`));
  });

  // Wording on the locked page + how long member invites last. Kept in the DB, like the rest of the
  // gate, so changing either is a dashboard edit rather than a redeploy.
  app.post('/admin/access/settings', requireAdmin, async (c) => {
    const { gate_message, invite_ttl_days } = (await readBody(c)) as {
      gate_message?: string;
      invite_ttl_days?: string;
    };
    const ttl = Number(invite_ttl_days);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > INVITE_TTL_MAX_DAYS) {
      return redirect(
        c,
        dash('settings', `Invite links must last between 1 and ${INVITE_TTL_MAX_DAYS} days.`),
      );
    }
    await setGateSettings({ message: gate_message ?? '', inviteTtlDays: ttl });
    return redirect(c, dash('settings', 'Access settings saved.'));
  });

  app.get('/admin/subscribers', requireAdmin, async (c) =>
    html(c, subscribersPage({
      subscribers: await listSubscriptions(),
      flash: c.req.query('msg'),
    })),
  );

  // Download every row of every table as JSON (announcements, subscriptions, settings, send log,
  // access codes and tokens — the table list comes from the schema, so it can't fall behind it).
  // Behind auth.
  //
  // A portable dump rather than a SQLite file image: `db.serialize()` only exists on the
  // better-sqlite3 driver, while this works the same on D1, and JSON restores into either. It is a
  // logical snapshot, not a point-in-time one — the tables are read one after another rather than
  // in a single transaction, which is fine for a ward-sized dataset that changes a few times a week
  // (see docs/DEPLOYMENT.md for the host-side backup that *is* consistent).
  app.get('/admin/backup.json', requireAdmin, async (c) => {
    // The single most sensitive response the app can produce — every subscription endpoint and
    // every access code in one file. Nothing between here and the admin's disk has any business
    // keeping a copy.
    c.header('Cache-Control', 'private, no-store');
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const tables = await dumpDatabase();
    // A backup outlives its download — it sits in a Drive folder or an email for years — so it must
    // not be a way into the dashboard. `admin_people_secret` signs people's sessions (and, mixed with
    // the password, the owner's): with it and the `admin_users` rows beside it, anyone holding the
    // file could mint an admin cookie. Pending dashboard invites are live sign-in links. Both are
    // left out; a restore mints a new secret, so everyone signs in again with their passkey, and an
    // invite is simply sent again. The operator's export (host.ts) keeps both: moving a ward
    // between hosts should not sign anyone out, and only the operator can take one.
    //
    // The VAPID private key (`vapid_keys`, when the app generated the pair) never goes out in the
    // clear. Beside the subscriber rows — every endpoint with its encryption keys — it is everything
    // needed to send a real, encrypted push to every member's phone, and there is no quiet way back:
    // a push service ties a subscription to the key it was made with, so a rotation means every
    // member re-subscribing. A file that sits in a Drive folder for years must not carry that. So
    // the pair travels sealed under this deployment's BACKUP_SEAL_KEY (seal.ts, `vapid_keys_sealed`)
    // — a restore here opens it and the ward sends as before; the file alone opens nothing — and
    // with no seal key set it is left out, the cost then honest and documented: restored onto a
    // fresh database, the ward sends with a new pair, and the installed apps re-subscribe against
    // it (public/sw.js) or members turn notifications on again. Restored over a database that still
    // has its pair, that pair is kept either way (restore.ts). The operator's export seals the same
    // way (host.ts).
    if (Array.isArray(tables.settings)) {
      const rows = tables.settings.filter((row) => !BACKUP_OMITS.includes(String((row as { key?: unknown }).key)));
      tables.settings = await sealBackupSettings(rows as { key?: unknown; value?: unknown }[], config.backupSealKey);
    }
    if (Array.isArray(tables.admin_invites)) tables.admin_invites = [];
    const dump = {
      app: config.appName,
      exported_at: new Date().toISOString(),
      tables,
    };
    return c.body(JSON.stringify(dump, null, 2), 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="ward-announcements-backup-${stamp}.json"`,
    });
  });

  // Deletes the row *and* blocks the endpoint, in one batch — see `/api/subscribe` above for why a
  // bare delete never lasted past the member's next launch.
  app.post('/admin/subscribers/:id/delete', requireAdmin, async (c) => {
    await removeSubscriptionById(Number(c.req.param('id')));
    return redirect(c, '/admin/subscribers?msg=' + encodeURIComponent('Subscriber removed.'));
  });

  app.post('/admin/schedule', requireAdmin, async (c) => {
    const { dow, time } = (await readBody(c)) as { dow?: string; time?: string };
    try {
      await setScheduleSettings({ dow: Number(dow), time: time ?? '' });
      return redirect(c, dash('settings', 'Schedule updated.'));
    } catch (err) {
      return redirect(c, dash('settings', (err as Error).message));
    }
  });

  // When sacrament meeting starts (`meeting.ts`): stores it, and writes the program window and the
  // weekly schedule it derives through their own setters. Admin only, like both of those. The flash
  // repeats what the form's live preview said, so the page says it with script off too.
  app.post('/admin/meeting-time', requireAdmin, async (c) => {
    const { meeting_dow, meeting_time } = (await readBody(c)) as {
      meeting_dow?: string;
      meeting_time?: string;
    };
    try {
      const derived = await saveMeetingTime({ dow: meeting_dow, time: meeting_time });
      return redirect(c, dash('settings', `Meeting time saved. This set ${timingSentence(derived)}.`));
    } catch (err) {
      return redirect(c, dash('settings', (err as Error).message));
    }
  });

  // Skipped Sundays are `requireAuth`, not `requireAdmin`, unlike the schedule beside them. An
  // editor can already cause a week to be skipped by publishing nothing — the digest suppresses
  // itself when there is nothing to carry — so gating the explicit control would protect nothing
  // and only oblige the person most likely to know Conference is coming to go and ask someone.
  app.post('/admin/skips', requireAuth, async (c) => {
    const { skip_date, note } = (await readBody(c)) as { skip_date?: string; note?: string };
    const date = typeof skip_date === 'string' ? skip_date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return redirect(c, dash('notifications', 'Pick a date to skip.'));
    }
    // The input carries `min`, but a disabled control is not a rule. Skipping a date that has
    // already passed cannot do anything except sit in the list until it is pruned.
    if (date < localDate(new Date())) {
      return redirect(
        c,
        dash('notifications', 'That date has already passed — pick a future Sunday.'),
      );
    }
    await addSkip(date, typeof note === 'string' && note.trim() ? note.trim().slice(0, 60) : null);
    return redirect(
      c,
      dash('notifications', `No notification will go out on ${date}.`),
    );
  });

  app.post('/admin/skips/delete', requireAuth, async (c) => {
    const { skip_date } = (await readBody(c)) as { skip_date?: string };
    if (typeof skip_date !== 'string' || !skip_date.trim()) {
      return redirect(c, dash('notifications', 'Nothing to remove.'));
    }
    await removeSkip(skip_date.trim());
    return redirect(c, dash('notifications', 'That Sunday is no longer skipped.'));
  });

  app.get('/admin/announcements/new', requireAuth, (c) =>
    html(c, announcementForm({ mode: 'new', role: roleOf(c) })),
  );

  app.post('/admin/announcements', requireAuth, async (c) => {
    const body = (await readBody(c)) as AnnouncementBody & Record<string, unknown>;
    const input = parseAnnouncementBody(body);
    const pendingImages = pendingIds(body);
    const problem = announcementProblem(input);
    if (problem) {
      return html(
        c,
        announcementForm({
          mode: 'new',
          draft: input,
          error: problem,
          role: roleOf(c),
          pendingAttachments: await pendingAttachmentsByIds(pendingImages),
        }),
        400,
      );
    }
    const id = await createAnnouncement(input);
    await claimPendingAttachments(pendingImages, 'announcement', id);
    return redirect(c, dash('content', 'Announcement created.', savedParam(c)));
  });

  // Persist a drag-to-reorder from the dashboard. Body: { ids: number[] } in the new display order.
  // (Registered before the `:id` route below so the static `reorder` segment wins.)
  app.post('/admin/announcements/reorder', requireAuth, async (c) => {
    const { ids } = (await readBody(c)) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'number' || !Number.isInteger(x))) {
      return json(c, { error: 'Invalid ids' }, 400);
    }
    await reorderAnnouncements(ids as number[]);
    return json(c, { ok: true });
  });

  app.get('/admin/announcements/:id/edit', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    const announcement = await getAnnouncement(id);
    if (!announcement) return text(c, 'Not found', 404);
    return html(
      c,
      announcementForm({
        mode: 'edit',
        role: roleOf(c),
        announcement,
        attachments: await listAttachments('announcement', id),
        maxAttachments: MAX_ATTACHMENTS_PER_OWNER,
      }),
    );
  });

  app.post('/admin/announcements/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    const announcement = await getAnnouncement(id);
    if (!announcement) return text(c, 'Not found', 404);
    const input = parseAnnouncementBody((await readBody(c)) as AnnouncementBody);
    const problem = announcementProblem(input);
    if (problem) {
      return html(
        c,
        announcementForm({
          mode: 'edit',
          announcement,
          draft: input,
          attachments: await listAttachments('announcement', id),
          maxAttachments: MAX_ATTACHMENTS_PER_OWNER,
          error: problem,
          role: roleOf(c),
        }),
        400,
      );
    }
    await updateAnnouncement(id, input);
    return redirect(c, dash('content', 'Announcement saved.', savedParam(c)));
  });

  app.post('/admin/announcements/:id/delete', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    // Take the images with it. This is the only path that removes an announcement — expiry hides
    // rows rather than deleting them — so it is also the only place stored objects could be
    // orphaned, and an orphan would sit in the bucket forever with no row left to name it.
    await purgeAttachments(files, log, 'announcement', id);
    await deleteAnnouncement(id);
    return redirect(c, dash('content', 'Announcement deleted.'));
  });

  // --- Admin: resource pages -----------------------------------------------
  //
  // The announcement routes with the expiry taken out. Both roles: a page is the same kind of
  // writing an announcement is, and the editor is usually the person keeping it current.

  app.get('/admin/pages/new', requireAuth, (c) => html(c, pageForm({ mode: 'new', role: roleOf(c) })));

  app.post('/admin/pages', requireAuth, async (c) => {
    const body = (await readBody(c)) as PageBody & Record<string, unknown>;
    const input = parsePageBody(body);
    const pendingImages = pendingIds(body);
    const problem = pageProblem(input);
    if (problem) {
      return html(
        c,
        pageForm({
          mode: 'new',
          draft: input,
          error: problem,
          role: roleOf(c),
          pendingAttachments: await pendingAttachmentsByIds(pendingImages),
        }),
        400,
      );
    }
    const id = await createPage(input);
    await claimPendingAttachments(pendingImages, PAGE_OWNER, id);
    // To the edit page rather than the dashboard, like a program: a resources page is the kind of
    // thing a clerk keeps working on.
    return redirect(c, `/admin/pages/${id}/edit?msg=${encodeURIComponent('Page created.')}&${savedParam(c)}`);
  });

  app.post('/admin/pages/reorder', requireAuth, async (c) => {
    const { ids } = (await readBody(c)) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'number' || !Number.isInteger(x))) {
      return json(c, { error: 'Invalid ids' }, 400);
    }
    await reorderPages(ids as number[]);
    return json(c, { ok: true });
  });

  app.get('/admin/pages/:id/edit', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    const page = await getPage(id);
    if (!page) return text(c, 'Not found', 404);
    return html(
      c,
      pageForm({
        mode: 'edit',
        role: roleOf(c),
        page,
        attachments: await listAttachments(PAGE_OWNER, id),
        maxAttachments: MAX_ATTACHMENTS_PER_OWNER,
        flash: c.req.query('msg') ?? undefined,
      }),
    );
  });

  app.post('/admin/pages/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    const page = await getPage(id);
    if (!page) return text(c, 'Not found', 404);
    const input = parsePageBody((await readBody(c)) as PageBody);
    const problem = pageProblem(input);
    if (problem) {
      return html(
        c,
        pageForm({
          mode: 'edit',
          page,
          draft: input,
          attachments: await listAttachments(PAGE_OWNER, id),
          maxAttachments: MAX_ATTACHMENTS_PER_OWNER,
          error: problem,
          role: roleOf(c),
        }),
        400,
      );
    }
    await updatePage(id, input);
    return redirect(c, dash('content', 'Page saved.', savedParam(c)));
  });

  app.post('/admin/pages/:id/delete', requireAuth, async (c) => {
    const id = Number(c.req.param('id'));
    // Images first, for the reason the announcement delete gives: this is the only path that
    // removes a page, so it is the only place its stored objects could be orphaned.
    await purgeAttachments(files, log, PAGE_OWNER, id);
    await deletePage(id);
    return redirect(c, dash('content', 'Page deleted.'));
  });

  // --- Admin: sacrament meeting programs -----------------------------------
  //
  // Deliberately thinner than announcements: no publish flag, no ordering, no expiry field. A
  // program is written for one date and is visible on that date inside the configured window (see
  // `programs.ts`), which is the only visibility rule there is.

  app.get('/admin/programs/new', requireAuth, async (c) => {
    const settings = await getProgramSettings();
    // Most of a program repeats week to week — the presiding and music lines, the section headings,
    // the whole meeting-info footer — so a new one can start as a copy of an earlier one. `?from=`
    // names it; without it the page offers the latest. Text only: images belong to their own week.
    const fromId = Number(c.req.query('from'));
    const copied = Number.isInteger(fromId) && fromId > 0 ? await getProgram(fromId) : undefined;
    // Or a sample program to edit, for a ward with no program of its own to copy yet.
    const fromExample = !copied && c.req.query('example') === '1';
    const [latest] = copied ? [] : await listRecentPrograms(1);
    return html(
      c,
      programForm({
        mode: 'new',
        role: roleOf(c),
        defaultDate: nextProgramDate(new Date(), settings),
        settings,
        draftBody: copied?.body_md ?? (fromExample ? EXAMPLE_PROGRAM : undefined),
        copiedFrom: copied?.program_date,
        fromExample,
        copyOffer: latest ? { id: latest.id, date: latest.program_date } : undefined,
      }),
    );
  });

  app.post('/admin/programs', requireAuth, async (c) => {
    const settings = await getProgramSettings();
    const body = (await readBody(c)) as ProgramBody & Record<string, unknown>;
    const input = parseProgramBody(body);
    const pendingImages = pendingIds(body);
    const pendingAttachments = await pendingAttachmentsByIds(pendingImages);
    const problem = programProblem(input);
    if (problem) {
      return html(
        c,
        programForm({
          mode: 'new',
          defaultDate: input.date,
          draftBody: input.body,
          settings,
          error: problem,
          role: roleOf(c),
          pendingAttachments,
        }),
        400,
      );
    }
    // One program per date is a UNIQUE column, so the check and the insert can still race. Checking
    // first is what produces a sentence an admin can act on; the catch is what keeps the race from
    // becoming a 500.
    if (await getProgramByDate(input.date)) {
      return html(
        c,
        programForm({
          mode: 'new',
          role: roleOf(c),
          defaultDate: input.date,
          draftBody: input.body,
          settings,
          error: `There is already a program for ${input.date}. Edit that one instead.`,
          pendingAttachments,
        }),
        400,
      );
    }
    let id: number;
    try {
      id = await createProgram(input);
    } catch {
      return html(
        c,
        programForm({
          mode: 'new',
          role: roleOf(c),
          defaultDate: input.date,
          draftBody: input.body,
          settings,
          error: `There is already a program for ${input.date}. Edit that one instead.`,
          pendingAttachments,
        }),
        400,
      );
    }
    await claimPendingAttachments(pendingImages, PROGRAM_OWNER, id);
    // Straight to the edit page rather than the dashboard, where the saved program can be proofed.
    return redirect(
      c,
      `/admin/programs/${id}/edit?msg=` +
        encodeURIComponent('Program created.' + dowNote(input.date, settings.dow)) +
        `&${savedParam(c)}`,
    );
  });

  // The visibility window, the closed-page wording, and how long old programs are kept.
  // (Registered before the `:id` routes below so the static `settings` segment wins.)
  app.post('/admin/programs/settings', requireAdmin, async (c) => {
    const body = (await readBody(c)) as {
      program_dow?: string;
      program_start?: string;
      program_end?: string;
      program_closed_message?: string;
      program_retention_days?: string;
    };
    try {
      await setProgramSettings({
        dow: Number(body.program_dow),
        start: body.program_start ?? '',
        end: body.program_end ?? '',
        closedMessage: body.program_closed_message ?? '',
        retentionDays: Number(body.program_retention_days),
      });
      // Back to Members: the form lives under Ward Settings → Advanced Timing now.
      return redirect(c, dash('settings', 'Program settings saved.'));
    } catch (err) {
      return redirect(c, dash('settings', (err as Error).message));
    }
  });

  app.get('/admin/programs/:id/edit', requireAuth, async (c) => {
    const program = await getProgram(Number(c.req.param('id')));
    if (!program) return text(c, 'Not found', 404);
    return html(
      c,
      programForm({
        mode: 'edit',
        role: roleOf(c),
        program,
        settings: await getProgramSettings(),
        attachments: await listAttachments(PROGRAM_OWNER, program.id),
        maxAttachments: MAX_ATTACHMENTS_PER_OWNER,
        flash: c.req.query('msg'),
      }),
    );
  });

  // A program as the Program tab will show it — the same renderer, the same markup the public page
  // builds, its images under it — for the dashboard's preview modal. This is the only way to see a
  // program before its window opens: `/api/program` does not bypass the window for a signed-in
  // session, so the public page shows an admin exactly what a member sees. Both roles: the editor is
  // usually the one who typed the names.
  app.get('/admin/programs/:id/preview/fragment', requireAuth, async (c) => {
    const program = await getProgram(Number(c.req.param('id')));
    if (!program) return text(c, 'Not found', 404);
    const images = await listAttachments(PROGRAM_OWNER, program.id);
    return html(
      c,
      programPreviewHtml({
        date: program.program_date,
        body: renderProgramMarkdown(program.body_md),
        images: images.map((row) => ({ url: `/images/${row.key}` })),
      }),
    );
  });

  app.post('/admin/programs/:id', requireAuth, async (c) => {
    const program = await getProgram(Number(c.req.param('id')));
    if (!program) return text(c, 'Not found', 404);
    const settings = await getProgramSettings();
    const input = parseProgramBody((await readBody(c)) as ProgramBody);
    const clash = await getProgramByDate(input.date);
    const problem =
      programProblem(input) ??
      (clash && clash.id !== program.id
        ? `There is already a program for ${input.date}.`
        : undefined);
    if (problem) {
      return html(
        c,
        programForm({
          mode: 'edit',
          role: roleOf(c),
          program,
          defaultDate: input.date,
          draftBody: input.body,
          settings,
          attachments: await listAttachments(PROGRAM_OWNER, program.id),
          maxAttachments: MAX_ATTACHMENTS_PER_OWNER,
          error: problem,
        }),
        400,
      );
    }
    await updateProgram(program.id, input);
    // Back to the edit page (not the dashboard) whenever the date can never be shown, so the
    // warning lands somewhere the clerk can act on it — the date field is right there.
    const note = dowNote(input.date, settings.dow);
    if (note) {
      return redirect(
        c,
        `/admin/programs/${program.id}/edit?msg=` + encodeURIComponent('Program saved.' + note) + `&${savedParam(c)}`,
      );
    }
    return redirect(c, dash('content', 'Program saved.', savedParam(c)));
  });

  // Admin-only, unlike an announcement's delete: a program is the record of a meeting — names,
  // hymns, who spoke — and once its Sunday has passed there is no reason for anyone to remove it
  // by hand before the retention clock does. An editor who typed the wrong date edits it.
  app.post('/admin/programs/:id/delete', requireAdmin, async (c) => {
    const id = Number(c.req.param('id'));
    // Same pairing the announcement delete uses, and for the same reason: this and the retention
    // purge are the only two paths that remove a program, so they are the only two places a stored
    // object could be orphaned.
    await purgeAttachments(files, log, PROGRAM_OWNER, id);
    await deleteProgram(id);
    return redirect(c, dash('content', 'Program deleted.'));
  });

  // --- Admin: image attachments --------------------------------------------

  /**
   * Upload one image for an announcement (multipart form).
   *
   * `c.req.parseBody()` hands back a `File` for the file field on both runtimes — Hono's own
   * abstraction over the two `FormData` implementations, which is the reason this route needs no
   * runtime branch at all.
   */
  app.post('/admin/attachments', requireAuth, async (c) => {
    const body = await c.req.parseBody();
    const ownerType = String(body['owner_type'] ?? '');
    // A whitelist, not a passthrough: `owner_type` reaches the database, and an unrecognised value
    // would create rows no delete path knows to clean up. Adding the next one stays a deliberate
    // edit here rather than an accident of whatever a form happened to post.
    if (ownerType !== 'announcement' && ownerType !== PROGRAM_OWNER && ownerType !== PAGE_OWNER) {
      return json(c, { error: 'Unknown attachment owner.' }, 400);
    }
    // No owner id: an image added on a New page, before there is a row. It is stored as pending,
    // and the form's save claims it (`claimPendingAttachments`); the daily sweep deletes one nobody
    // saved. Capped across the ward, so abandoned forms cannot pile up.
    const pending = String(body['owner_id'] ?? '').trim() === '';
    const ownerId = pending ? 0 : Number(body['owner_id']);
    const noun =
      ownerType === PROGRAM_OWNER ? 'program' : ownerType === PAGE_OWNER ? 'page' : 'announcement';
    if (pending) {
      if ((await countPendingAttachments()) >= MAX_PENDING_ATTACHMENTS) {
        return json(c, { error: 'Too many unsaved images. Save or cancel what you are working on first.' }, 409);
      }
    } else {
      const ownerExists =
        Number.isInteger(ownerId) &&
        (ownerType === PROGRAM_OWNER
          ? !!(await getProgram(ownerId))
          : ownerType === PAGE_OWNER
            ? !!(await getPage(ownerId))
            : !!(await getAnnouncement(ownerId)));
      if (!ownerExists) {
        return json(c, { error: `That ${noun} no longer exists.` }, 404);
      }
    }

    const file = asUploadedFile(body['file']);
    if (!file) return json(c, { error: 'No file was uploaded.' }, 400);

    const contentType = (file.type || '').split(';')[0].trim().toLowerCase();
    const extension = extensionFor(contentType);
    if (!extension) {
      return json(c, { error: 'Images must be JPEG, PNG, WebP or GIF.' }, 415);
    }

    const uploaded = new Uint8Array(await file.arrayBuffer());
    // Measured after reading, not from the declared `size`: the number a client sends is a claim,
    // and the byte count is the fact.
    if (uploaded.byteLength > MAX_UPLOAD_BYTES) {
      return json(
        c,
        { error: `Images must be under ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` },
        413,
      );
    }
    if (uploaded.byteLength === 0) return json(c, { error: 'That file was empty.' }, 400);
    // What is stored, and what `size` records, is the image with its metadata gone (GPS, capture
    // time, device, thumbnail — the Orientation tag and the colour profile stay, see image-meta.ts).
    // The editor re-encodes most photos in the browser, which drops all that, but it sends the
    // original bytes for a GIF, an image it could not decode, and one its re-encode made no smaller.
    // After the size checks, so a stripped file is never larger than the limit it just passed.
    const data = stripImageMetadata(uploaded, contentType);
    // Sum-then-insert, so two uploads racing can each pass and overshoot by one image. Accepted: the
    // quota keeps one ward from filling shared storage, not to the byte.
    if (config.imageQuotaBytes && (await totalAttachmentBytes()) + data.byteLength > config.imageQuotaBytes) {
      const mb = Math.round(config.imageQuotaBytes / (1024 * 1024));
      return json(
        c,
        { error: `This ward's image storage is full (${mb} MB). Delete images from old announcements to make room.` },
        413,
      );
    }

    // Checked here rather than only in the UI: the cap exists to bound the delete fan-out against
    // the Workers subrequest budget, so it has to hold for any client.
    // (A pending image's count is held by the form, which stops at the same limit; claiming takes no
    // more than MAX_ATTACHMENTS_PER_OWNER either.)
    if (!pending && (await countAttachments(ownerType, ownerId)) >= MAX_ATTACHMENTS_PER_OWNER) {
      const article = ownerType === 'announcement' ? 'An' : 'A';
      return json(
        c,
        { error: `${article} ${noun} can have at most ${MAX_ATTACHMENTS_PER_OWNER} images.` },
        409,
      );
    }

    const key = newAttachmentKey(extension);
    // Object first, row second: a row is what makes an image reachable, so if the write fails
    // there is nothing pointing at a key that was never stored.
    await files.put(key, data, contentType);
    const filename = typeof file.name === 'string' && file.name ? file.name.slice(0, 120) : null;
    const id = await createAttachment({
      ownerType: pending ? PENDING_OWNER : ownerType,
      ownerId,
      key,
      filename,
      contentType,
      size: data.byteLength,
    });
    return json(c, { id, key, url: `/images/${key}`, alt: filename ?? '' }, 201);
  });

  app.delete('/admin/attachments/:id', requireAuth, async (c) => {
    const row = await attachmentById(Number(c.req.param('id')));
    if (!row) return json(c, { error: 'Not found' }, 404);
    try {
      await files.delete(row.key);
    } catch (err) {
      log.error({ err, key: row.key }, 'could not delete a stored image');
    }
    await deleteAttachment(row.id);
    return json(c, { ok: true });
  });

  // --- Admin: settings + sending -------------------------------------------

  app.post('/admin/settings', requireAdmin, async (c) => {
    const { auto_send } = (await readBody(c)) as { auto_send?: string };
    await setAutoSendEnabled(auto_send === '1');
    return redirect(c, dash('notifications', 'Settings saved.'));
  });

  app.post('/admin/weekly-message', requireAdmin, async (c) => {
    const { weekly_title, weekly_body } = await readBody(c);
    await setWeeklyMessageSettings({ title: field(weekly_title), body: field(weekly_body) });
    return redirect(c, dash('notifications', 'Weekly message saved.'));
  });

  // Hide the first-run checklist for good. Admin only, like the card.
  app.post('/admin/getting-started/dismiss', requireAdmin, async (c) => {
    await setSetting(GETTING_STARTED_DISMISSED, '1');
    return redirect(c, '/admin');
  });

  // Bring a dismissed checklist back. Admin only, like the card.
  app.post('/admin/getting-started/show', requireAdmin, async (c) => {
    await deleteSetting(GETTING_STARTED_DISMISSED);
    return redirect(c, '/admin');
  });

  // The ward's name, footer, link and timezone (`ward-settings.ts`). Admin only, like the schedule:
  // the name is what installs to members' home screens and the timezone moves the weekly send.
  app.post('/admin/ward', requireAdmin, async (c) => {
    const body = (await readBody(c)) as Record<string, unknown>;
    try {
      await saveWardSettings({
        appName: body.app_name,
        appShortName: body.app_short_name,
        appDescription: body.app_description,
        appFooter: body.app_footer,
        linkText: body.link_text,
        linkUrl: body.link_url,
        timezone: body.timezone,
      });
      return redirect(c, dash('settings', 'Ward settings saved.'));
    } catch (err) {
      return redirect(c, dash('settings', (err as Error).message));
    }
  });

  // Server-rendered Markdown preview (the editor once drew its preview pane from this). Uses the same
  // markdown-it config + sanitization as the public page, so the preview matches members' view.
  // `kind` picks the renderer, so a program's preview shows the dot-leader rows the public page
  // will show and the announcement editor keeps rendering a pipe as a pipe.
  app.post('/admin/preview', requireAuth, async (c) => {
    const { body, kind } = (await readBody(c)) as { body?: string; kind?: string };
    const render = kind === PROGRAM_OWNER ? renderProgramMarkdown : renderMarkdown;
    // Cut to what could be saved, so a preview can't render more than a member page ever would.
    return json(c, { html: render(typeof body === 'string' ? body.slice(0, MAX_BODY_LENGTH) : '') });
  });

  app.post('/admin/send', requireAdmin, async (c) => {
    // Counted from the send log, so the cap is the ward's, not one isolate's or one address's: every
    // send reaches every member's phone, and on the many-ward host the operator pays for them.
    if ((await countRecentManualSends(60)) >= MAX_MANUAL_SENDS_PER_HOUR) {
      return redirect(
        c,
        dash('notifications', `Not sent: ${MAX_MANUAL_SENDS_PER_HOUR} notifications have gone out in the last hour. Try again later.`),
      );
    }
    const sent = await readBody(c);
    const title = field(sent.title).trim();
    const body = field(sent.body).trim();
    if (!title) {
      return redirect(c, dash('notifications', 'Title is required to send.'));
    }
    // The same caps the weekly message is saved under (schedule-core.ts). Past them the payload
    // would not fit a push at all: it was enqueued, failed at encryption, showed "Sent to 0 of N"
    // and still counted against the hourly cap.
    if (title.length > PUSH_TITLE_MAX || body.length > PUSH_BODY_MAX) {
      return redirect(
        c,
        dash(
          'notifications',
          `Not sent: the title can be at most ${PUSH_TITLE_MAX} characters and the message at most ${PUSH_BODY_MAX}.`,
        ),
      );
    }
    // Default: open the announcements tab by name rather than the bare root, so a send during the
    // program window can't land on the program instead (same reasoning as the weekly digest in
    // schedule-core.ts). Only use a custom link when the admin explicitly chose one — and require a
    // full http(s) address so we don't blast a broken link.
    let url = '/#announcements';
    if (sent.link_target === 'custom') {
      const custom = field(sent.custom_url).trim();
      if (!/^https?:\/\//i.test(custom) || custom.length > PUSH_URL_MAX) {
        return redirect(
          c,
          dash('notifications', 
              'Enter a full web link starting with https:// — or choose “The announcements page”.',
            ),
        );
      }
      url = custom;
    }
    // Enqueues and drains to empty, so this still returns the finished totals. The `send_log` row
    // is written by the enqueue (as "pending") and finalised when the queue for it empties.
    const result = await sendToAll({ title, body, url }, { type: 'manual', drain });
    // Record the send time so the startup catch-up (schedule.ts) won't re-send a just-covered
    // weekly slot after a restart within the grace window — same field the scheduled send sets.
    await setSetting('last_sent_at', new Date().toISOString());
    log.info(result, 'manual push sent');
    const flash = result.pending
      ? `Sending to ${result.total} subscriber(s) — ${result.sent} delivered so far, ` +
        `${result.pending} still going out. The send history updates when it finishes.`
      : `Sent to ${result.sent} of ${result.total} subscriber(s).` +
        (result.removed ? ` Removed ${result.removed} expired.` : '') +
        (result.failed ? ` ${result.failed} failed.` : '');
    return redirect(c, dash('notifications', flash));
  });

  // --- Static assets -------------------------------------------------------
  //
  // Registered after every route, so `/`, `/index.html`, `/sw.js` and `/manifest.webmanifest` are
  // still answered dynamically even though files of those names exist in `public/`.
  if (assets) {
    app.use('*', async (c, next) => {
      const res = await assets(c);
      if (res) return res;
      await next();
    });
  }

  // --- Fallbacks -----------------------------------------------------------
  //
  // JSON 404 and 500 envelopes (`statusCode`, `error`, `message`). The PWA shell and service worker
  // branch on the JSON body they get back from a failed fetch, so a bare "404 Not Found" string
  // (Hono's default) would break the client, not just look different.
  app.notFound((c) =>
    json(
      c,
      {
        message: `Route ${c.req.method}:${pathWithQuery(c)} not found`,
        error: 'Not Found',
        statusCode: 404,
      },
      404,
    ),
  );

  app.onError((err, c) => {
    // The detail goes to the log, where the operator is; the client gets the status and nothing
    // else. Echoing `err.message` would turn any unhandled throw into a free oracle for an
    // unauthenticated caller — a Node type error naming an internal function, a SQLite message
    // naming a column, a fetch error naming a push endpoint — all reachable by posting a body of
    // the wrong shape. The envelope keeps the 404's field names, which is what the client reads.
    log.error({ err, path: c.req.path, method: c.req.method }, 'request failed');
    return json(
      c,
      { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
      500,
    );
  });

  return app;
}

// --- helpers ----------------------------------------------------------------

/**
 * Absolute origin for links we hand out — PUBLIC_ORIGIN when set, else the requested host.
 *
 * The forwarded headers are consulted first (when trusted): behind a reverse proxy that terminates
 * TLS, the socket's own scheme and host would hand members an `http://` link to an internal address.
 */
function originFrom(c: Context, trustForwarded: boolean): string {
  if (config.publicOrigin) return config.publicOrigin;
  const url = new URL(c.req.url);
  const forwarded = (name: string) => (trustForwarded ? c.req.header(name)?.split(',')[0]?.trim() : undefined);
  const proto = forwarded('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = forwarded('x-forwarded-host') || url.host;
  return `${proto}://${host}`;
}

/** Index a flat attachment list by owner id, preserving the query's order within each owner. */
function groupByOwner(rows: AttachmentRow[]): Map<number, AttachmentRow[]> {
  const byOwner = new Map<number, AttachmentRow[]>();
  for (const row of rows) {
    const list = byOwner.get(row.owner_id);
    if (list) list.push(row);
    else byOwner.set(row.owner_id, [row]);
  }
  return byOwner;
}

/** The parts of an uploaded `File` this app uses. */
interface UploadedFile {
  name?: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Narrow a parsed form field to an uploaded file.
 *
 * Structural rather than `instanceof File`: both runtimes have the global, but they are different
 * classes behind the same name, and a duck-typed check can't be wrong about which one Hono built.
 */
function asUploadedFile(value: unknown): UploadedFile | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<UploadedFile>;
  if (typeof candidate.arrayBuffer !== 'function' || typeof candidate.type !== 'string') {
    return null;
  }
  return candidate as UploadedFile;
}

/** The request target as it appeared on the wire: path plus query string, if any. */
function pathWithQuery(c: Context): string {
  const query = c.req.url.split('?')[1];
  return query === undefined ? c.req.path : `${c.req.path}?${query}`;
}

/**
 * Back to the dashboard with a flash message, on the tab the form came from.
 *
 * The dashboard is three tabs — content, notifications, members — selected by the hash, and every
 * admin form is a plain POST + redirect. Without the hash, saving the schedule would land the admin
 * on the announcements with their message about the schedule floating above the wrong tab.
 */
function dash(tab: 'content' | 'notifications' | 'settings', msg: string, saved?: string): string {
  return `/admin?msg=${encodeURIComponent(msg)}${saved ? `&${saved}` : ''}#${tab}`;
}

/**
 * `saved=<this form's action>` for a content save's redirect: the save landed, so the editor's copy
 * of it kept on the device can go (editor/drafts.js keys it by the action, which is this path).
 * Until a page carrying it loads, the copy stays — marked submitted, and offered back on the next
 * visit to the form — because a save that never arrived used to take the only copy with it.
 */
function savedParam(c: Context): string {
  return `saved=${encodeURIComponent(c.req.path)}`;
}

/**
 * The last whole local day a credential works, as "October 20" — the day *before* its expiry, since
 * it lapses partway through that one and a printed date has to be true all day.
 */
function lastFullDay(expiresAt: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    month: 'long',
    day: 'numeric',
  }).format(new Date(expiresAt.getTime() - 24 * 60 * 60 * 1000));
}

function formatNextRun(d: Date | null): string {
  if (!d) return 'not scheduled';
  return d.toLocaleString('en-US', {
    timeZone: config.timezone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * `unknown` throughout: the body is whatever a member's browser — or anyone holding the shared
 * code — chose to POST, and `subscriptionProblem` is what turns it into strings.
 */
interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  /** Previous endpoint when the service worker re-subscribes after a `pushsubscriptionchange`. */
  oldEndpoint?: unknown;
  /** True only from the member's own tap on Enable Notifications: lifts an admin's block. */
  deliberate?: unknown;
}

/**
 * The longest endpoint a push service hands out. Measured: Apple's are about 100 characters past
 * the host, Mozilla's about 180, Google's FCM about 230 (the newer `/wp/` form), and Microsoft's
 * WNS — the longest, a `?token=` query of several hundred — about 500. A kilobyte is double the
 * biggest, so a legitimate service has room to grow, and a flood of junk cannot grow a row.
 */
const MAX_ENDPOINT_LENGTH = 1024;

/**
 * What the push-encryption side of a subscription must be (RFC 8291): `p256dh` an uncompressed
 * P-256 point, 65 bytes with a 0x04 lead, and `auth` a 16-byte secret, both base64url as the
 * browser's `PushSubscription.toJSON()` prints them (unpadded; padding is tolerated). Anything
 * else is stored for nothing — every send would fail to encrypt for it — so it is refused here.
 */
function base64urlBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return new Uint8Array(Buffer.from(value.replace(/=+$/, ''), 'base64url'));
  } catch {
    return null;
  }
}

/**
 * Settings rows the admin backup leaves out: the people-session key. Why, at the
 * `/admin/backup.json` route. (The VAPID pair is `sealBackupSettings`'s business: sealed or out.)
 */
const BACKUP_OMITS = ['admin_people_secret'];

/** Why a subscribe body cannot be stored, or undefined when every part of it is well-formed. */
function subscriptionProblem(sub: SubscribeBody): string | undefined {
  if (typeof sub?.endpoint !== 'string' || !sub.endpoint || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
    return 'Invalid subscription';
  }
  if (sub.endpoint.length > MAX_ENDPOINT_LENGTH) return 'That is not a push service this app sends to.';
  const p256dh = base64urlBytes(sub.keys.p256dh);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return 'Invalid subscription: the p256dh key is not a P-256 public key.';
  const auth = base64urlBytes(sub.keys.auth);
  if (!auth || auth.length !== 16) return 'Invalid subscription: the auth secret is not 16 bytes.';
  return undefined;
}

interface AnnouncementBody {
  title?: string;
  body?: string;
  expires_at?: string;
  published?: string;
}

/**
 * A text field out of a request body. A form always sends strings, but a JSON body can carry a
 * number or an object under the same name, and `.trim()` on one of those was a 500. Anything
 * that is not text is treated as left blank.
 */
function field(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseAnnouncementBody(body: AnnouncementBody) {
  const expiresAt = field(body.expires_at).trim();
  return {
    title: field(body.title).trim(),
    body: field(body.body).trim(),
    expires_at: expiresAt ? expiresAt : null,
    published: body.published === '1',
  };
}

/**
 * Why an announcement cannot be saved, or undefined. The expiry check is not cosmetic: the public
 * query compares `expires_at` to today's date as *text*, so anything that is not `YYYY-MM-DD` sorts
 * above every real date and never expires — and the value is echoed into the edit form, so it has
 * to be a date and nothing else before it is stored.
 */
function announcementProblem(input: ReturnType<typeof parseAnnouncementBody>): string | undefined {
  if (!input.title) return 'Title is required.';
  const tooLong = lengthProblem(input);
  if (tooLong) return tooLong;
  if (input.expires_at && !isCalendarDate(input.expires_at)) {
    return 'The expiry must be a real date (YYYY-MM-DD).';
  }
  return undefined;
}

interface PageBody {
  title?: string;
  body?: string;
  published?: string;
}

function parsePageBody(body: PageBody) {
  return {
    title: field(body.title).trim(),
    body: field(body.body).trim(),
    published: body.published === '1',
  };
}

function pageProblem(input: ReturnType<typeof parsePageBody>): string | undefined {
  if (!input.title) return 'Title is required.';
  return lengthProblem(input);
}

/**
 * Generous for anything a ward writes — a long resource page is a few thousand characters — and
 * small enough that one body can't make every member page load slow to render, or outgrow the
 * 100 KB statement `wrangler d1 execute` takes when a backup is restored (scripts/db-restore.mjs).
 */
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000;

/**
 * A manual notification: the title and message caps `setWeeklyMessageSettings` (schedule-core.ts)
 * trims the weekly one to, and a link cap well inside what a push payload can carry.
 */
const PUSH_TITLE_MAX = 80;
const PUSH_BODY_MAX = 300;
const PUSH_URL_MAX = 2048;

function lengthProblem(input: { title?: string; body: string }): string | undefined {
  if (input.title !== undefined && input.title.length > MAX_TITLE_LENGTH) {
    return `The title is too long (at most ${MAX_TITLE_LENGTH} characters).`;
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    return `This is too long to save (at most ${MAX_BODY_LENGTH.toLocaleString('en-US')} characters).`;
  }
  return undefined;
}

interface ProgramBody {
  program_date?: string;
  body?: string;
}

function parseProgramBody(body: ProgramBody): { date: string; body: string } {
  return { date: (body.program_date ?? '').trim(), body: (body.body ?? '').trim() };
}

/** 'YYYY-MM-DD' that names a real calendar day (so 2026-02-31 is rejected, not silently shifted). */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day
  );
}

/**
 * A warning to append to the save confirmation when a program is dated a day the window can never
 * open on — or '' when it lines up.
 *
 * A warning and not a rejection, deliberately. The window is a setting an admin can move, a ward
 * genuinely might hold a meeting on some other day, and refusing the save would leave the clerk
 * with nowhere to put the text they had just typed. But the failure it catches is silent otherwise:
 * the program saves, looks perfect in the list, and simply never appears to anybody.
 */
function dowNote(date: string, windowDow: number): string {
  const dow = dayOfWeekFor(date);
  if (dow === null || dow === windowDow) return '';
  return (
    ` Heads up: ${date} is a ${DAY_NAMES[dow]}, and members only ever see programs on ` +
    `${DAY_NAMES[windowDow]}s — nobody will see this one until the date or the window changes.`
  );
}

/** What's wrong with a submitted program, phrased for the admin — or undefined when it's fine. */
function programProblem(input: { date: string; body: string }): string | undefined {
  if (!isCalendarDate(input.date)) return 'Pick the date this program is for.';
  if (!input.body) return 'A program needs some content.';
  return lengthProblem(input);
}
