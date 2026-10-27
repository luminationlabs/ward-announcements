/**
 * Passkey sign-in for the dashboard (WebAuthn, through SimpleWebAuthn).
 *
 * Each person the owner adds gets a one-time **invite link** (`/admin/invite#t=…`, the token in the
 * fragment so it stays out of logs, as the member links do). Opening it on their phone creates a
 * passkey — Face ID, a fingerprint or the device's screen lock — and signs them in. From then on
 * `/admin/login` is one tap. A lost phone is a new invite; a person who should no longer have access
 * is removed, and their session ends on their next click (see `userSession` in auth.ts).
 *
 * The passkey belongs to the **site**: its relying-party id is the hostname the dashboard is served
 * from (`PUBLIC_ORIGIN`, or the address the owner first opened it on). A ward that later moves from
 * `*.workers.dev` to its own domain has to invite everyone again; the owner password still works.
 *
 * Runtime-neutral: SimpleWebAuthn verifies with WebCrypto, which both runtimes have, and the
 * challenge travels in a signed cookie rather than server state (`setChallenge` in auth.ts).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Context } from 'hono';
import { config } from './config.js';
import {
  addAdminPasskey,
  createAdminInvite,
  createAdminUser,
  findUsableAdminInvite,
  getAdminPasskey,
  getAdminUser,
  listAdminPasskeys,
  redeemAdminInvite,
  touchAdminPasskey,
  type AdminUserRow,
} from './db.js';
import { setChallenge, startUserSession, takeChallenge } from './auth.js';
import { logger } from './log.js';

/** How long an invite link works. A week: long enough to reach someone, short enough to not linger. */
export const INVITE_DAYS = 7;

/** The origin a passkey is created and used on, and the relying-party id (its hostname). */
export function relyingParty(c: Context): { origin: string; rpID: string } {
  const origin = config.publicOrigin || new URL(c.req.url).origin;
  return { origin, rpID: new URL(origin).hostname };
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

/**
 * What to call the device a passkey was made on, from its browser's user agent: enough to tell a
 * person's phone from their computer when one needs removing, and no more. iPads that ask for the
 * desktop site report as a Mac, which is close enough.
 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux computer';
  return 'Device';
}

/** A fresh invite token or WebAuthn user handle: 32 random bytes, base64url. */
export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Add a person and issue their first invite. Returns the person's id and the invite's path
 * (`/admin/invite#t=…`, to put after the ward's origin). What Settings → People does, and how a
 * ward with no owner password gets its first admin: the operator of a shared deployment calls this.
 */
export async function invitePerson(input: { name: string; role: 'admin' | 'editor' }): Promise<{ id: number; path: string }> {
  const id = await createAdminUser({ ...input, webauthnId: randomToken() });
  const token = randomToken();
  await createAdminInvite(id, token, INVITE_DAYS);
  return { id, path: `/admin/invite#t=${token}` };
}

type Outcome = { ok: true; json: unknown } | { ok: false; status: 400 | 401; error: string };
const fail = (error: string, status: 400 | 401 = 400): Outcome => ({ ok: false, status, error });

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Options for `navigator.credentials.get()`. No `allowCredentials`: passkeys are discoverable, so
 * the phone offers whichever of its passkeys belong to this site and nobody types a username.
 */
export async function signInOptions(c: Context): Promise<Outcome> {
  const { rpID } = relyingParty(c);
  // Required, not preferred: a passkey is an admin credential, and the person — not just whoever
  // holds the device — has to unlock it. Phones and password managers always do (Face ID, a
  // fingerprint, the screen lock); only a hardware key with no PIN set would sign in on a touch, and
  // the browser asks for a PIN for one of those.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  await setChallenge(c, 'login', options.challenge);
  return { ok: true, json: options };
}

/** Check a signed challenge and start that person's session. */
export async function signInVerify(c: Context, response: unknown): Promise<Outcome> {
  const body = response as AuthenticationResponseJSON;
  if (!body || typeof body.id !== 'string') return fail('That sign-in did not arrive complete. Please try again.');
  const taken = await takeChallenge(c, 'login');
  // A challenge already answered is a replay, not a slow finger: refused as a sign-in, not a retry.
  if (!taken.ok) return taken.spent ? fail('That sign-in has already been used. Please try again.', 401) : fail('That sign-in took too long. Please try again.');
  const challenge = taken.challenge;
  const passkey = await getAdminPasskey(body.id);
  if (!passkey) {
    return fail('This device has a passkey for this site that is no longer in use. Ask an administrator for a new invite link.', 401);
  }
  const user = await getAdminUser(passkey.user_id);
  if (!user) return fail('That person no longer has access.', 401);
  const { origin, rpID } = relyingParty(c);
  let verified = false;
  let newCounter = passkey.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: fromB64url(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports ? (JSON.parse(passkey.transports) as AuthenticatorTransport[]) : undefined,
      },
      requireUserVerification: true,
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId: user.id }, 'passkey sign-in rejected');
    verified = false;
  }
  if (!verified) return fail('That passkey could not be verified.', 401);
  await touchAdminPasskey(passkey.id, newCounter);
  await startUserSession(c, user);
  return { ok: true, json: { ok: true, redirect: '/admin' } };
}

// ---------------------------------------------------------------------------
// Creating a passkey from an invite
// ---------------------------------------------------------------------------

/**
 * Options for `navigator.credentials.create()` for one person. `bound` ties the challenge to how the
 * registration was authorised — the invite token, or the signed-in person's own session — so it can
 * only be answered the same way.
 */
async function optionsFor(c: Context, user: AdminUserRow, bound: string): Promise<Outcome> {
  const { rpID } = relyingParty(c);
  const existing = await listAdminPasskeys(user.id);
  const options = await generateRegistrationOptions({
    rpName: config.appName,
    rpID,
    userName: user.name,
    userDisplayName: user.name,
    userID: fromB64url(user.webauthn_id),
    attestationType: 'none',
    // Discoverable, so signing in needs no username; synced (iCloud Keychain, Google Password
    // Manager) wherever the platform does so, which is what makes a new phone just work.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, // see signInOptions
    // A device that already holds one of their passkeys is refused by the browser itself
    // (InvalidStateError), rather than ending up with two the phone's picker cannot tell apart.
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransport[]) : undefined,
    })),
  });
  await setChallenge(c, 'register', options.challenge, bound);
  return { ok: true, json: options };
}

/** Verify a new passkey answering a challenge issued under `bound`. Undefined when it does not check out. */
async function verifyNew(c: Context, user: AdminUserRow, bound: string, body: RegistrationResponseJSON) {
  const taken = await takeChallenge(c, 'register', bound);
  if (!taken.ok) return { error: taken.spent ? 'That has already been used. Please try again.' : 'That took too long. Please try again.' } as const;
  const challenge = taken.challenge;
  const { origin, rpID } = relyingParty(c);
  try {
    const result = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified) return { error: 'The new passkey could not be verified. Please try again.' } as const;
    const info = result.registrationInfo;
    if (await getAdminPasskey(info.credential.id)) return { error: 'That passkey is already set up.' } as const;
    return {
      passkey: {
        id: info.credential.id,
        userId: user.id,
        publicKey: b64url(info.credential.publicKey),
        counter: info.credential.counter,
        transports: info.credential.transports ?? body.response.transports,
        label: deviceLabel(c.req.header('user-agent')),
      },
    } as const;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), userId: user.id }, 'passkey registration rejected');
    return { error: 'The new passkey could not be verified. Please try again.' } as const;
  }
}

/** Options for `navigator.credentials.create()`, for the person an invite names. */
export async function registrationOptions(c: Context, token: unknown): Promise<Outcome> {
  if (typeof token !== 'string' || !token) return fail('This invite link is incomplete.');
  const invite = await findUsableAdminInvite(token);
  if (!invite) return fail('This invite link has expired or has already been used. Ask for a new one.', 401);
  const user = await getAdminUser(invite.user_id);
  if (!user) return fail('This invite is for someone who no longer has access.', 401);
  return optionsFor(c, user, `invite-${token}`);
}

/** Check the new passkey, store it against the invite's person, spend the invite, sign them in. */
export async function registrationVerify(c: Context, token: unknown, response: unknown): Promise<Outcome> {
  if (typeof token !== 'string' || !token) return fail('This invite link is incomplete.');
  const body = response as RegistrationResponseJSON;
  if (!body || typeof body.id !== 'string') return fail('The new passkey did not arrive complete. Please try again.');
  const invite = await findUsableAdminInvite(token);
  if (!invite) return fail('This invite link has expired or has already been used. Ask for a new one.', 401);
  const user = await getAdminUser(invite.user_id);
  if (!user) return fail('This invite is for someone who no longer has access.', 401);
  const checked = await verifyNew(c, user, `invite-${token}`, body);
  if (!checked.passkey) return fail(checked.error ?? 'The new passkey could not be verified. Please try again.');
  if (!(await redeemAdminInvite(token, checked.passkey))) {
    return fail('This invite link has expired or has already been used. Ask for a new one.', 401);
  }
  await startUserSession(c, user);
  return { ok: true, json: { ok: true, redirect: '/admin' } };
}

// ---------------------------------------------------------------------------
// Adding a passkey on another device, while signed in
// ---------------------------------------------------------------------------

/**
 * A signed-in person adds a passkey on the device in front of them — a computer, typically, after
 * signing in there with their phone's QR code — so next time it signs in by itself. Their session
 * is the authorisation; no invite needed.
 */
export async function addOptions(c: Context, userId: number): Promise<Outcome> {
  const user = await getAdminUser(userId);
  if (!user) return fail('Sign in again.', 401);
  return optionsFor(c, user, `self-${user.id}`);
}

export async function addVerify(c: Context, userId: number, response: unknown): Promise<Outcome> {
  const user = await getAdminUser(userId);
  if (!user) return fail('Sign in again.', 401);
  const body = response as RegistrationResponseJSON;
  if (!body || typeof body.id !== 'string') return fail('The new passkey did not arrive complete. Please try again.');
  const checked = await verifyNew(c, user, `self-${user.id}`, body);
  if (!checked.passkey) return fail(checked.error ?? 'The new passkey could not be verified. Please try again.');
  await addAdminPasskey(checked.passkey);
  return { ok: true, json: { ok: true } };
}
