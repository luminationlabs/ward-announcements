import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.js';
import { getAdminUser, getSetting, setSetting, setSettingIfAbsent, spendChallenge } from './db.js';
import { appendCookie, redirect, samePathOnly } from './http.js';
import { tenantLocal } from './tenant.js';

/**
 * Who is signed in.
 *
 * `admin` can do everything, including the settings that decide when pushes go out, who can get in,
 * and what the backup contains. `editor` writes announcements, pages and programs and nothing else.
 * The split is enforced by `requireAdmin` on the routes, not by the dashboard hiding cards; hiding
 * is only so an editor isn't shown buttons that 403.
 *
 * Two ways in. The **owner** signs in with `ADMIN_PASSWORD` and is always an admin — the way in on a
 * fresh deployment and the way back in if every passkey is lost. Everyone else is a **person** with
 * their own passkeys (src/passkeys.ts) and a role the owner or another admin gave them. A person can
 * be removed, or signed out everywhere, without anyone else noticing; a shared password could not.
 */
export type Role = 'admin' | 'editor';

/** The signed-in identity a request carries, resolved once per admin request by `loadSession`. */
export interface Who {
  role: Role;
  /** The person's `admin_users.id`, or null for the owner. */
  userId: number | null;
  name: string;
}

/** Hono context variables this module reads and writes. `app.ts` includes them in its own. */
export type AuthVariables = { who?: Who | null };
type AuthContext = Context<{ Variables: AuthVariables }>;

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * The owner's cookie, signed in the `signValue` format with a key that mixes the password and a
 * database-held secret (`ownerKey`).
 */
const OWNER_COOKIE = 'pushannounce_session';
/** A person's session: `u.<id>.<session_version>.<issued>`, signed with a database-held secret. */
const USER_COOKIE = 'pushannounce_user';
/** The WebAuthn challenge between "options" and "verify" (src/passkeys.ts). Five minutes. */
const CHALLENGE_COOKIE = 'pushannounce_challenge';
const CHALLENGE_MAX_AGE = 5 * 60;

/** Constant-time, length-independent password comparison. */
function matches(candidate: unknown, expected: string): boolean {
  // A JSON login body can post `{"password": 12345}`; a non-string reaching `update()` throws a Node
  // type error out of the route. A wrong type is simply a wrong password.
  if (typeof candidate !== 'string' || !expected) return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether this ward has an owner, i.e. an `ADMIN_PASSWORD`. Every single-ward deployment does (boot
 * requires it); a ward hosted on a shared deployment does not, and is run entirely by people.
 */
export function hasOwner(): boolean {
  return !!config.adminPassword;
}

/** Whether the submitted password is the owner's. */
export function isOwnerPassword(candidate: unknown): boolean {
  return matches(candidate, config.adminPassword);
}

/**
 * Sign/verify a session cookie: `value.` followed by a base64 HMAC-SHA256 of the value with the
 * padding `=` stripped (the `cookie-signature` scheme).
 *
 * The format is a contract with cookies already sitting in browsers — changing it would sign
 * everyone out on deploy. Note this is *not* Hono's signed-cookie helper, which uses a different
 * (hex, and separately delimited) encoding.
 */
function signValue(value: string, secret: string): string {
  return (
    value + '.' + createHmac('sha256', secret).update(value).digest('base64').replace(/=/gu, '')
  );
}

/** Returns the signed value's payload when the signature checks out, else null. */
function unsignValue(signed: string, secret: string): string | null {
  const cut = signed.lastIndexOf('.');
  if (cut < 0) return null;
  const value = signed.slice(0, cut);
  const actual = Buffer.from(signed.slice(cut + 1), 'utf8');
  const expected = Buffer.from(
    createHmac('sha256', secret).update(value).digest('base64').replace(/=/gu, ''),
    'utf8',
  );
  // Length first: timingSafeEqual throws on a byte-length mismatch, and a tampered cookie must be
  // rejected, never turned into a 500.
  if (actual.length !== expected.length) return null;
  return timingSafeEqual(actual, expected) ? value : null;
}

/** Seconds since `issued`, if it is a plausible issue time inside MAX_AGE (a minute of skew allowed). */
function withinMaxAge(issued: string | undefined, maxAge = MAX_AGE): boolean {
  const at = Number(issued);
  if (!Number.isInteger(at) || at <= 0) return false;
  const age = Math.floor(Date.now() / 1000) - at;
  return age >= -60 && age <= maxAge;
}

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// The people's signing key
// ---------------------------------------------------------------------------

/**
 * Signs people's session cookies and the WebAuthn challenge. Kept in `settings`, minted once,
 * insert-if-absent and re-read so racing isolates agree (the member cookie secret in access.ts
 * does the same). Not derived from ADMIN_PASSWORD: changing the owner's password must not sign
 * every person out. Cached per isolate, per ward (see tenant.ts), for a minute.
 */
const peopleSecretCache = tenantLocal(() => ({ promise: null as Promise<string> | null, readAt: 0 }));

async function loadPeopleSecret(): Promise<string> {
  const stored = await getSetting('admin_people_secret');
  if (stored) return stored;
  await setSettingIfAbsent('admin_people_secret', randomBytes(32).toString('hex'));
  const landed = await getSetting('admin_people_secret');
  if (!landed) throw new Error('admin_people_secret could not be stored');
  return landed;
}

function peopleSecret(): Promise<string> {
  const cache = peopleSecretCache();
  if (!cache.promise || Date.now() - cache.readAt >= 60_000) {
    const pending = loadPeopleSecret();
    cache.promise = pending;
    cache.readAt = Date.now();
    pending.catch(() => {
      if (cache.promise === pending) cache.promise = null;
    });
  }
  return cache.promise;
}

// ---------------------------------------------------------------------------
// Starting and ending sessions
// ---------------------------------------------------------------------------

const cookieOptions = (maxAge: number, path = '/') => ({
  httpOnly: true,
  sameSite: 'Lax' as const,
  path,
  maxAge,
  secure: config.isProduction,
});

const clear = (c: Context, name: string, path = '/') =>
  // `expires` alongside Max-Age=0, so an ancient client that ignores Max-Age still drops the cookie.
  deleteCookie(c, name, { path, sameSite: 'Lax', expires: new Date(0) });

/**
 * The owner signed in with ADMIN_PASSWORD. Signing in ends any other session in this browser: the
 * ward's clerk's-office computer is shared, and a browser must never hold one person's session
 * while the next person types theirs.
 */
/**
 * The owner cookie's key: the password-derived secret *and* the database-held random one. From the
 * password alone, one stolen owner cookie — an HMAC of a known plaintext — would let anyone test
 * password guesses offline at full speed. Changing the password still ends every owner session.
 */
async function ownerKey(): Promise<string> {
  // The version is what lets the owner end every owner session without changing the password
  // (`endOwnerSessions`): a phone left signed in somewhere was otherwise good for thirty days.
  // Folded in only once it has been bumped, so the owner cookies that predate it keep working.
  const version = await getSetting(OWNER_SESSION_VERSION);
  const base = `${config.sessionSecret}::${await peopleSecret()}`;
  return createHash('sha256').update(version ? `${base}::${version}` : base).digest('hex');
}

const OWNER_SESSION_VERSION = 'owner_session_version';

/**
 * End every owner session, everywhere, and start a fresh one in this browser. The owner's
 * counterpart to a person's Sign Out Everywhere: the owner has no `admin_users` row to bump, so the
 * version lives in `settings` and is folded into the cookie key.
 */
export async function endOwnerSessions(c: Context): Promise<void> {
  const current = Number((await getSetting(OWNER_SESSION_VERSION)) ?? '0') || 0;
  await setSetting(OWNER_SESSION_VERSION, String(current + 1));
  await startOwnerSession(c);
}

export async function startOwnerSession(c: Context): Promise<void> {
  clear(c, USER_COOKIE);
  // `appendCookie` (not Hono's `setCookie`) so the emitted bytes stay stable: base64 `+` and `/` are
  // valid cookie octets and are not percent-encoded, and an owner session already in a browser has
  // to keep parsing.
  appendCookie(c, OWNER_COOKIE, signValue(`ok.${now()}`, await ownerKey()), cookieOptions(MAX_AGE));
}

/** A person signed in with a passkey. Ends any other session in this browser, as above. */
export async function startUserSession(c: Context, user: { id: number; session_version: number }): Promise<void> {
  clear(c, OWNER_COOKIE);
  const value = `u.${user.id}.${user.session_version}.${now()}`;
  appendCookie(c, USER_COOKIE, signValue(value, await peopleSecret()), cookieOptions(MAX_AGE));
}

/** Ends whichever session this browser holds — every kind, so "log out" cannot leave one behind. */
export function clearSession(c: Context): void {
  for (const name of [OWNER_COOKIE, USER_COOKIE]) clear(c, name);
}

// ---------------------------------------------------------------------------
// Reading the session
// ---------------------------------------------------------------------------

async function ownerSession(c: Context): Promise<boolean> {
  // A ward with no owner password (one hosted on a shared deployment, whose admins are all people
  // with passkeys) has no owner at all. Not merely a formality: the owner cookie's key is derived
  // from the password, and the key derived from an empty one is public — anyone could sign a cookie.
  if (!hasOwner()) return false;
  const raw = getCookie(c, OWNER_COOKIE);
  if (!raw) return false;
  const value = unsignValue(raw, await ownerKey());
  if (!value) return false;
  const [tag, issued] = value.split('.');
  // A cookie from before the issue time was signed in ('ok' with nothing after it) has no age to
  // check and is rejected.
  return tag === 'ok' && withinMaxAge(issued);
}

async function userSession(c: Context): Promise<Who | null> {
  const raw = getCookie(c, USER_COOKIE);
  if (!raw) return null;
  const value = unsignValue(raw, await peopleSecret());
  if (!value) return null;
  const [tag, id, version, issued] = value.split('.');
  if (tag !== 'u' || !withinMaxAge(issued)) return null;
  // The row is the authority, read on every admin request: a person who was removed, or signed out
  // everywhere, loses access on their very next click rather than when the cookie runs out.
  const user = await getAdminUser(Number(id));
  if (!user || String(user.session_version) !== version) return null;
  if (user.role !== 'admin' && user.role !== 'editor') return null;
  return { role: user.role, userId: user.id, name: user.name };
}

/**
 * Middleware for the admin area: works out who is signed in, once, and stores it for `roleOf` and
 * `whoOf`. The owner's cookie wins if a browser somehow holds both.
 */
export const loadSession: MiddlewareHandler = async (c, next) => {
  (c as AuthContext).set('who', await sessionOf(c));
  await next();
};

/**
 * Who this request is signed in as, read from its cookies. `loadSession` does this for `/admin`;
 * anything outside it that needs to know (a program's images) asks here.
 */
export async function sessionOf(c: Context): Promise<Who | null> {
  return (await ownerSession(c)) ? { role: 'admin', userId: null, name: 'Owner' } : await userSession(c);
}

/** Who is signed in, or null. Only meaningful under `loadSession` (every `/admin` route). */
export function whoOf(c: Context): Who | null {
  return (c as AuthContext).get('who') ?? null;
}

/** The role this request is signed in as. */
export function roleOf(c: Context): Role | null {
  return whoOf(c)?.role ?? null;
}

/** Signed in as *something*. Not a permission check on its own — see `requireAdmin`. */
export function isAuthenticated(c: Context): boolean {
  return roleOf(c) !== null;
}

export function isAdmin(c: Context): boolean {
  return roleOf(c) === 'admin';
}

/**
 * A `?next=` for the login page, or undefined: a dashboard path on this site and nothing else.
 *
 * Refused rather than repaired — `//evil.example`, `/\evil.example`, a full URL, a control
 * character (a header split) — so the only thing a crafted sign-in link can do is land someone on
 * a page of the ward's own dashboard. `samePathOnly` is the same guard the `?code=` redirect uses;
 * here anything it would have to change is not a path this app ever wrote. Never the login page
 * itself, which would only sign in again.
 */
export function adminReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('/')) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(raw) || samePathOnly(raw) !== raw) return undefined;
  if (!/^\/admin(?:[/?#]|$)/u.test(raw) || /^\/admin\/login(?:[/?#]|$)/u.test(raw)) return undefined;
  return raw;
}

/**
 * The login page, remembering where this request was going.
 *
 * A session that runs out while a clerk is writing a program is met at the *save*, a POST, which
 * cannot be replayed; the page to return to is the form it came from, which the browser names in
 * `Referer` (the app sends `strict-origin-when-cross-origin`, so a same-site form's full path). The
 * stored draft (editor/drafts.js) is offered back there. Only the path of the Referer is read, so a
 * foreign one can at worst name a dashboard page of this site.
 */
function loginRedirect(c: Context): string {
  let target: string | undefined;
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    // A page someone opened, not an image or a script's fetch (the QR, a preview fragment): signing
    // in and landing on a bare SVG would be no way back at all.
    if (!(c.req.header('accept') ?? '').includes('text/html')) return '/admin/login';
    const query = c.req.url.split('?')[1];
    target = query === undefined ? c.req.path : `${c.req.path}?${query}`;
  } else {
    try {
      const referer = new URL(c.req.header('referer') ?? '');
      target = referer.pathname + referer.search;
    } catch {
      /* none, or not a URL: back to the dashboard */
    }
  }
  const next = adminReturnPath(target);
  return next && next !== '/admin' ? `/admin/login?next=${encodeURIComponent(next)}` : '/admin/login';
}

/** Route middleware: any signed-in role, else the login page (and back here afterwards). */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthenticated(c)) return redirect(c, loginRedirect(c));
  await next();
};

/**
 * Route middleware for everything an editor must not reach: settings, the member access controls,
 * the people list, the subscriber list, manual sends and the backup.
 *
 * A signed-in editor gets 403 rather than the login page — they are not un-authenticated, and
 * bouncing them to a form they can already satisfy would be a loop. In practice the dashboard never
 * renders these controls for an editor, so this is the guard for a stale tab, a bookmark, or a
 * hand-written request.
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const role = roleOf(c);
  if (role === null) return redirect(c, '/admin/login');
  if (role !== 'admin') {
    return c.body('Only an administrator can do that.', 403, {
      'content-type': 'text/plain; charset=utf-8',
    });
  }
  await next();
};

// ---------------------------------------------------------------------------
// The WebAuthn challenge
// ---------------------------------------------------------------------------

/**
 * Hold a WebAuthn challenge between the options request and the verify request, in a signed,
 * five-minute, HttpOnly cookie rather than server state — nothing for a second isolate to miss.
 * `purpose` keeps a sign-in challenge from being spent on a registration, and `bound` ties a
 * registration challenge to the invite it was issued for. The one piece of server state is the
 * `spent_challenges` row `takeChallenge` writes, so an answered challenge cannot be answered again.
 */
export async function setChallenge(c: Context, purpose: 'login' | 'register', challenge: string, bound = ''): Promise<void> {
  const value = `${purpose}.${challenge}.${now()}.${bound}`;
  appendCookie(c, CHALLENGE_COOKIE, signValue(value, await peopleSecret()), cookieOptions(CHALLENGE_MAX_AGE, '/admin'));
}

/** `takeChallenge`'s answer: the challenge, or why there is none. */
export type ChallengeTaken = { ok: true; challenge: string } | { ok: false; spent: boolean };

/**
 * The challenge this browser was issued for `purpose` (and `bound`), cleared as it is read — and
 * recorded as spent, which is the part a browser cannot skip. Clearing the cookie asks the client
 * to forget it; a client that kept it could otherwise answer the same challenge again for the rest
 * of its five minutes, and the authenticator's signature counter — the replay guard WebAuthn
 * itself offers — is off for synced passkeys, which report 0. The record is the challenge's hash,
 * kept until the cookie would have lapsed, and the insert's own conflict is the check.
 */
export async function takeChallenge(c: Context, purpose: 'login' | 'register', bound = ''): Promise<ChallengeTaken> {
  const raw = getCookie(c, CHALLENGE_COOKIE);
  clear(c, CHALLENGE_COOKIE, '/admin');
  const missing: ChallengeTaken = { ok: false, spent: false };
  if (!raw) return missing;
  const value = unsignValue(raw, await peopleSecret());
  if (!value) return missing;
  const [p, challenge, issued, b] = value.split('.');
  if (p !== purpose || (b ?? '') !== bound || !challenge || !withinMaxAge(issued, CHALLENGE_MAX_AGE)) return missing;
  // In SQLite's own `datetime('now')` spelling, so the daily sweep compares like with like.
  const expiresAt = new Date((Number(issued) + CHALLENGE_MAX_AGE) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const fresh = await spendChallenge(createHash('sha256').update(challenge).digest('hex'), expiresAt);
  return fresh ? { ok: true, challenge } : { ok: false, spent: true };
}
