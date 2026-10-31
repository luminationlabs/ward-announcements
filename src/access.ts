import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { config } from './config.js';
import { appendCookie } from './http.js';
import { tenantLocal } from './tenant.js';
import {
  activeAccessCode,
  createAccessToken,
  findAccessToken,
  findDeviceToken,
  getSetting,
  getSettings,
  insertAccessCodeIfNone,
  liveInvitesForDevice,
  newestLiveAccessToken,
  recordAccessTokenUse,
  setSetting,
  setSettingIfAbsent,
  usableAccessCodes,
} from './db.js';

const COOKIE = 'pushannounce_access';
/**
 * How long a member can go *without opening the app* before access lapses. Refreshed on every
 * gated request, so this is an idle timeout, not a cap on how long someone stays a member —
 * anyone who taps the weekly notification never approaches it.
 *
 * Matched to the installed-app device token so the two nets expire together rather than leaving a
 * window where one has lapsed and the other hasn't.
 *
 * Caveat worth knowing before tuning this: Chromium and Firefox clamp *any* cookie to 400 days
 * (RFC 6265bis), so only Safari honours the full length. That suits the audience — iOS is most of
 * it — and installed apps are covered either way, since their `start_url` device token re-unlocks
 * them silently even if this lapses.
 */
const MAX_AGE = 60 * 60 * 24 * 365 * 5;
/** Cookie payload format tag. Bump only if the payload shape changes. */
const VERSION = 'v1';

/**
 * Signing key for the member access cookie.
 *
 * Deliberately **not** `config.sessionSecret` — that one is derived from ADMIN_PASSWORD, so
 * sharing it would mean every admin password change silently logged the entire ward out. Instead
 * the key is generated once and kept in `settings`, where it survives redeploys and every env
 * change. There is no env override on purpose: the one thing an override would buy (forcing a
 * global re-unlock) is `resetAccessSecret()` below, which does it from the dashboard without
 * leaving a value that could be lost or mistyped into a ward-wide lockout.
 */
async function loadOrCreateSecret(): Promise<string> {
  const stored = await getSetting('access_cookie_secret');
  if (stored) return stored;
  // Mint, insert **only if absent**, then read back what actually landed. The read-back is the
  // whole point: on Workers two cold isolates can reach this line together, and the one that loses
  // the insert has to adopt the winner's secret. Minting into the row unconditionally (the old
  // `setSetting`) meant the loser signed cookies with a key it had just overwritten — members'
  // cookies verified for as long as that isolate lived and then stopped, at random.
  const minted = randomBytes(32).toString('hex');
  await setSettingIfAbsent('access_cookie_secret', minted);
  return (await getSetting('access_cookie_secret')) ?? minted;
}

/**
 * How long an isolate may keep using the secret it last read.
 *
 * Not a performance knob — a correctness one. A cache that lived forever would make
 * `resetAccessSecret()` (Issue a New Code's sign-out options) a *local* event: the isolate that handled the button
 * press would forget every cookie, and every other isolate would go on honouring them until
 * Cloudflare happened to recycle it. A minute of lag on a deliberately blunt instrument is fine; indefinite
 * lag is the button not working.
 *
 * The value semantics are unchanged — this is a read discipline, not a new key — so a member's
 * cookie stays valid across the re-read.
 */
const SECRET_TTL_MS = 60_000;

/**
 * The *promise* is cached, not the resolved string. Reading the secret is asynchronous, so caching
 * only the value would let two concurrent first requests both see "no secret yet" and both mint.
 * Caching the in-flight promise means every caller inside the TTL shares the one read. Per ward
 * (see tenant.ts): each ward's members carry cookies signed with that ward's own secret.
 */
const secretCache = tenantLocal(() => ({ promise: null as Promise<string> | null, readAt: 0 }));

function accessSecret(): Promise<string> {
  const cache = secretCache();
  const now = Date.now();
  if (!cache.promise || now - cache.readAt >= SECRET_TTL_MS) {
    const pending = loadOrCreateSecret();
    cache.promise = pending;
    cache.readAt = now;
    // Don't cache a failure at all — let the next caller retry rather than wait out the TTL. The
    // rejection is still delivered to the real caller through the returned promise.
    pending.catch(() => {
      if (cache.promise === pending) {
        cache.promise = null;
        cache.readAt = 0;
      }
    });
  }
  return cache.promise;
}

/**
 * Invalidate every member's access cookie at once by rolling the signing key.
 *
 * The blunt instrument for "the code got out and I want everyone to re-unlock". Rotating a code
 * deliberately leaves existing cookies alone (that's what keeps members from being re-onboarded
 * over routine hygiene), so this is the only way to actually evict anyone. Installed apps come
 * back on their own — their `start_url` device token re-unlocks them silently on next launch —
 * so in practice this mostly bites browser-only visitors.
 */
export async function resetAccessSecret(): Promise<void> {
  const secret = randomBytes(32).toString('hex');
  await setSetting('access_cookie_secret', secret);
  const cache = secretCache();
  cache.promise = Promise.resolve(secret);
  cache.readAt = Date.now();
  // Other isolates pick the new key up within SECRET_TTL_MS; this one is current immediately, so
  // the admin who pressed the button sees the effect on their very next request.
}

async function sign(payload: string): Promise<string> {
  return createHmac('sha256', await accessSecret()).update(payload).digest('base64url');
}

/**
 * Make sure there is an active access code: on a fresh database, the first one. Called at boot by
 * both entries, so a new deployment is gated from its very first request and the owner finds the
 * share link and QR waiting on the dashboard.
 */
export async function ensureAccessCode(): Promise<void> {
  await insertAccessCodeIfNone(newAccessCode());
}

// --- Gate settings (admin-editable, DB-held) --------------------------------

const DEFAULT_GATE_MESSAGE = 'This page is available to users with an access link.';
const DEFAULT_INVITE_TTL_DAYS = 30;
export const INVITE_TTL_MAX_DAYS = 365;

/**
 * How long the per-device token embedded in an installed PWA's `start_url` stays valid. Not
 * configurable, and long on purpose: it's the thing that lets a rotated-away access code expire
 * without stranding devices whose `start_url` iOS froze at install time. Shortening it would
 * quietly re-introduce that stranding, and lengthening it changes nothing anyone would notice, so
 * the only useful value is "longer than anyone will keep a phone".
 */
const DEVICE_TOKEN_TTL_DAYS = 365 * 5;

export interface GateSettings {
  /** Line shown on the locked page to a visitor with no credential. */
  message: string;
  /** How long a member-generated "Share With Someone" link stays usable. */
  inviteTtlDays: number;
}

export async function getGateSettings(): Promise<GateSettings> {
  // Both keys in one query. This runs on `/api/announcements`, which every page load and every app
  // resume hits, and on Workers each settings read is a round trip to D1.
  const stored = await getSettings(['gate_message', 'invite_ttl_days']);
  const message = stored.get('gate_message') ?? null;
  const ttl = Number(stored.get('invite_ttl_days') ?? null);
  return {
    message: message?.trim() ? message : DEFAULT_GATE_MESSAGE,
    // Guard the read, not just the write: the row predates this validation on any DB seeded by an
    // older build, and a NaN here would reach `new Date(...)` when minting an invite.
    inviteTtlDays:
      Number.isInteger(ttl) && ttl >= 1 && ttl <= INVITE_TTL_MAX_DAYS
        ? ttl
        : DEFAULT_INVITE_TTL_DAYS,
  };
}

/** Persist admin edits. Returns what was actually stored, after clamping/trimming. */
export async function setGateSettings(input: {
  message: string;
  inviteTtlDays: number;
}): Promise<GateSettings> {
  const message = input.message.trim().slice(0, 200);
  const ttl = Number.isInteger(input.inviteTtlDays)
    ? Math.min(Math.max(input.inviteTtlDays, 1), INVITE_TTL_MAX_DAYS)
    : DEFAULT_INVITE_TTL_DAYS;
  await setSetting('gate_message', message);
  await setSetting('invite_ttl_days', String(ttl));
  return getGateSettings();
}

// --- Credentials (shared codes + self-expiring tokens) ---------------------

// Unambiguous alphabet: no i/l/o/0/1, so a code stays readable if someone reads one aloud.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A fresh shared access code, grouped for legibility (~79 bits of entropy). */
export function newAccessCode(): string {
  const chars = Array.from(
    { length: 16 },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join('');
  return chars.replace(/(.{4})(?=.)/g, '$1-');
}

/** A fresh opaque token for an invite or a device. Never read by a human. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What a successful redemption tells the caller. */
export interface Redemption {
  /**
   * The device this credential is already bound to, for an installed app's `start_url` token —
   * null for a shared code or an invite, which belong to no particular device.
   */
  deviceId: string | null;
}

/**
 * Check a candidate credential and, if it's a tracked token, record the use. Returns null when the
 * credential is not valid.
 *
 * Shared codes are compared in constant time against *every* usable code — the active one plus
 * any retired code still inside its rotation grace window — without short-circuiting on the first
 * match, so the comparison leaks neither the code nor how many are in force.
 */
export async function redeemCredential(candidate: unknown): Promise<Redemption | null> {
  // `typeof` rather than a cast: a JSON body can carry `{"code": [1]}`, and a non-string reaching
  // `createHmac().update()` throws a Node type error out of the request — a 500 that told an
  // unauthenticated caller more about the server than a plain "no" does. A wrong *shape* is just a
  // wrong credential.
  if (typeof candidate !== 'string' || !candidate) return null;

  const secret = await accessSecret();
  const probe = createHmac('sha256', secret).update(candidate).digest();
  let matched = false;
  for (const row of await usableAccessCodes()) {
    const known = createHmac('sha256', secret).update(row.code).digest();
    if (timingSafeEqual(probe, known)) matched = true;
  }
  if (matched) return { deviceId: null };

  // Tokens are 256-bit random values, so an indexed lookup is safe — there's nothing to guess.
  const token = await findAccessToken(candidate);
  if (!token) return null;
  await recordAccessTokenUse(token.id);
  // Hand the device identity back so the caller can keep it. Minting a fresh id here instead would
  // orphan the very token that had just worked: the cookie would get a new device id, the next
  // manifest fetch would mint a second token for it, and the first would stay valid-but-unused for
  // its full five years — one live credential per re-unlock.
  return { deviceId: token.kind === 'device' ? token.device_id : null };
}

/**
 * How many live invites one device may have outstanding at a time.
 *
 * An invite is a real credential: unlimited uses, ~30 days, and it survives a code rotation and a
 * sign-out of browsers (neither touches `access_tokens`; only "everyone, including installed apps"
 * does). Without this cap the only limit on
 * minting them would be a per-IP rate limit, which is per-isolate on Workers and trivially spread
 * over time — one member's cookie could quietly turn into an unbounded supply of long-lived keys to the
 * ward's page. Five is well past what sharing actually takes: a member hands out a link, the person
 * opens it and gets their own cookie, and the link is done being useful.
 */
export const MAX_LIVE_INVITES_PER_DEVICE = 5;

export interface Invite {
  token: string;
  /** Whole days until this link stops working. */
  expiresInDays: number;
  /** True when the cap handed back an existing link instead of minting another. */
  reused: boolean;
}

/**
 * Mint a share-with-a-friend link credential. Unlimited uses, expires on its own.
 *
 * At the cap the newest live invite for this device is handed back rather than an error: the member
 * pressed "share", and a working link is the right answer to that — while the number of live
 * credentials one device can put into the world stays bounded, which is the actual point.
 *
 * Always for a device that holds the member cookie: `/api/invite` refuses a request without one,
 * because a credential in `?code=` has no device to count against and was once an uncapped path.
 */
export async function mintInvite(deviceId: string): Promise<Invite> {
  const { inviteTtlDays } = await getGateSettings();
  const live = await liveInvitesForDevice(deviceId);
  if (live.length >= MAX_LIVE_INVITES_PER_DEVICE) {
    const newest = live[0]!;
    return { token: newest.token, expiresInDays: daysUntil(newest.expires_at), reused: true };
  }
  const token = newToken();
  await createAccessToken({ token, kind: 'invite', deviceId, ttlDays: inviteTtlDays });
  return { token, expiresInDays: inviteTtlDays, reused: false };
}

/** How long the link in the weekly email / PDF works. */
export const EMAIL_LINK_TTL_DAYS = 14;

/**
 * How long after minting an email link the same one is handed back instead of a new one.
 *
 * Long enough that exporting on Thursday and again on Saturday — or ticking the box three times in
 * one sitting — is one credential, short enough that next week's email gets its own full fortnight
 * rather than the tail of this week's.
 */
const EMAIL_LINK_REUSE_DAYS = 3;

export interface EmailLink {
  token: string;
  /** When it stops working. */
  expiresAt: Date;
}

/**
 * The credential behind "Include a link to the app" in the dashboard's Preview.
 *
 * Its own kind rather than a member invite: an email sits in an archive and gets forwarded, so it
 * wants a fixed short life instead of the dashboard's invite setting, and it belongs to no device,
 * so the per-device cap has nothing to count. The reuse window is what bounds it instead — at most
 * one new row every `EMAIL_LINK_REUSE_DAYS`, whoever presses the button and however often.
 */
export async function mintEmailLink(): Promise<EmailLink> {
  const newest = await newestLiveAccessToken('email');
  if (newest) {
    const expiresAt = parseStoredTime(newest.expires_at);
    const freshUntil = Date.now() + (EMAIL_LINK_TTL_DAYS - EMAIL_LINK_REUSE_DAYS) * DAY_MS;
    if (expiresAt && expiresAt.getTime() >= freshUntil) return { token: newest.token, expiresAt };
  }
  const token = newToken();
  await createAccessToken({ token, kind: 'email', ttlDays: EMAIL_LINK_TTL_DAYS });
  return { token, expiresAt: new Date(Date.now() + EMAIL_LINK_TTL_DAYS * DAY_MS) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A stored expiry as a Date, or null if it does not parse.
 *
 * The column is SQLite's `datetime('now')` format — 'YYYY-MM-DD HH:MM:SS', UTC, with no zone
 * marker — so the 'Z' is added rather than left to `Date.parse` to guess (it would read the string
 * as *local* time, quietly shifting the answer by the UTC offset).
 */
function parseStoredTime(stored: string): Date | null {
  const at = Date.parse(`${stored.replace(' ', 'T')}Z`);
  return Number.isFinite(at) ? new Date(at) : null;
}

/** Whole days from now until a stored expiry, floored at 1. */
function daysUntil(expiresAt: string): number {
  const at = parseStoredTime(expiresAt);
  if (!at) return 1;
  return Math.max(1, Math.ceil((at.getTime() - Date.now()) / DAY_MS));
}

/**
 * The long-lived credential embedded in one installed app's manifest `start_url`. Reused across
 * manifest fetches from the same device so repeat installs don't pile up rows.
 */
export async function deviceTokenFor(deviceId: string): Promise<string> {
  const existing = await findDeviceToken(deviceId);
  if (existing) return existing.token;
  const token = newToken();
  await createAccessToken({ token, kind: 'device', deviceId, ttlDays: DEVICE_TOKEN_TTL_DAYS });
  return token;
}

// --- The access cookie ------------------------------------------------------

export interface AccessGrant {
  /** Stable per-browser id, minted at first unlock and preserved across sliding refreshes. */
  deviceId: string;
}

/** Verify the signed access cookie, returning its grant (or null if absent/tampered/stale). */
export async function hasAccess(c: Context): Promise<AccessGrant | null> {
  const raw = getCookie(c, COOKIE);
  if (!raw) return null;
  const cut = raw.lastIndexOf('.');
  if (cut < 0) return null;
  const payload = raw.slice(0, cut);
  // Compare as *bytes*, not characters. `timingSafeEqual` throws on a byte-length mismatch, and a
  // string length check doesn't imply one: cookie values are percent-decoded on the way in, so
  // `%C3%A9` arrives as a single character worth two UTF-8 bytes. Guarding on `.length` alone let
  // a malformed cookie throw out of this hook and turn every request into a 500 — locking that
  // browser out of the site entirely until its cookies were cleared.
  const given = Buffer.from(raw.slice(cut + 1), 'utf8');
  const expected = Buffer.from(await sign(payload), 'utf8');
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  const [version, deviceId, issued] = payload.split('.');
  if (version !== VERSION || !deviceId) return null;
  // The issue time is signed into the payload and checked here, because the cookie's `Max-Age` is a
  // request a browser makes, not one a server can enforce: a cookie lifted off a device (or
  // replayed by a client that ignores Max-Age) would otherwise be good forever. This makes it a real
  // server-side bound — the same five years the cookie claims.
  const at = Number(issued);
  if (!Number.isInteger(at) || at <= 0) return null;
  const age = Math.floor(Date.now() / 1000) - at;
  // A minute of slack for a clock that disagrees with the one that signed it; anything further into
  // the future is a value nobody legitimately issued.
  if (age < -60 || age > MAX_AGE) return null;
  return { deviceId };
}

/**
 * A token that opens one private file (a PDF) without a cookie, until `expires` (epoch ms). A PDF
 * link can be opened somewhere the cookie is not — the member viewer's "Open original" in another
 * tab, a dashboard link in a new window an iPhone home-screen app may not share its cookies with —
 * so the link carries its own way in. Scoped to the one key and signed with the
 * member cookie's secret (so "sign out everyone" kills outstanding links with the cookies).
 *
 * Two kinds, signed apart so one can never pass for the other: a `member` token stands in for the
 * member cookie and is checked *in addition to* the program's window, never instead of it; a
 * `dashboard` token stands in for a dashboard session, for the PDFs on the editor pages.
 */
export type FileLinkScope = 'member' | 'dashboard';

function fileLinkPayload(scope: FileLinkScope, key: string, exp: number): string {
  return `${scope === 'member' ? 'file' : 'dash-file'}.${key}.${exp}`;
}

export async function fileLinkToken(key: string, expires: number, scope: FileLinkScope = 'member'): Promise<string> {
  const exp = Math.floor(expires / 1000);
  return `${exp}.${await sign(fileLinkPayload(scope, key, exp))}`;
}

/** Whether `token` is a live `fileLinkToken` of that scope for `key`. Anything malformed is simply not one. */
export async function fileLinkValid(key: string, token: unknown, scope: FileLinkScope = 'member'): Promise<boolean> {
  if (typeof token !== 'string') return false;
  const match = /^(\d{1,12})\.([\w-]+)$/.exec(token);
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp * 1000 <= Date.now()) return false;
  const given = Buffer.from(match[2]!, 'utf8');
  const expected = Buffer.from(await sign(fileLinkPayload(scope, key, exp)), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Set (or slide) the access cookie. Pass an existing grant to keep its device id — that id is what
 * ties an installed app to its `start_url` device token, so losing it would orphan the token.
 */
export async function grantAccess(
  c: Context,
  existing?: AccessGrant | null,
): Promise<AccessGrant> {
  const deviceId = existing?.deviceId ?? randomBytes(16).toString('hex');
  const payload = `${VERSION}.${deviceId}.${Math.floor(Date.now() / 1000)}`;
  // `appendCookie` rather than Hono's `setCookie`: the helper throws on a Max-Age past 400 days,
  // and MAX_AGE above is deliberately five years. See src/http.ts.
  appendCookie(c, COOKIE, `${payload}.${await sign(payload)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE,
    secure: config.isProduction,
  });
  return { deviceId };
}
