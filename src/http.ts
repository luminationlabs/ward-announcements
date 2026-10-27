/**
 * Small response/request helpers shared by every route.
 *
 * They pin the wire format down exactly, since the clients (the PWA shell, the service worker, an
 * installed iOS app) are built against these responses and an installed app can run an older copy
 * of them. Hono's own `c.json()` omits the charset, so the JSON helper here spells it out.
 *
 * Runtime-agnostic on purpose: nothing in this file touches a Node built-in.
 */
import type { Context } from 'hono';

/** JSON response, content type `application/json; charset=utf-8`. */
export function json(c: Context, data: unknown, status = 200): Response {
  return c.body(JSON.stringify(data), status as 200, {
    'content-type': 'application/json; charset=utf-8',
  });
}

/** HTML response, content type `text/html` (no charset — the pages declare it). */
export function html(c: Context, markup: string, status = 200): Response {
  return c.body(markup, status as 200, { 'content-type': 'text/html' });
}

/**
 * Redirect response.
 *
 * The explicit `content-length: 0` is load-bearing, not noise. Hono's own `c.redirect()` leaves the
 * body null, which @hono/node-server then frames as `Transfer-Encoding: chunked` — chunked framing
 * for a response that by definition carries no body. Declaring the length instead gives the plain
 * `Content-Length: 0` a redirect should have. (An empty *string* body fixes the framing too, but the Fetch spec then stamps the
 * response `text/plain;charset=UTF-8`, which a redirect has no business claiming.)
 */
export function redirect(c: Context, location: string, status: 301 | 302 = 302): Response {
  return c.body(null, status, { location, 'content-length': '0' });
}

/**
 * Parse a request body (JSON, urlencoded or multipart form) into a plain object. Returns `{}` for a bodyless request (several admin buttons POST nothing at
 * all) so every call site can keep destructuring without a guard.
 */
export async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const parsed: unknown = await c.req.json();
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    }
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      return (await c.req.parseBody()) as Record<string, unknown>;
    }
  } catch {
    // A malformed body is "no body" rather than a 500 — every route already validates what it needs
    // out of the result.
    return {};
  }
  return {};
}

/** RFC 6265 cookie-octet: the characters that need no percent-encoding in a cookie value. */
const COOKIE_OCTET = /^[\u0021\u0023-\u002B\u002D-\u003A\u003C-\u005B\u005D-\u007E]*$/;

export interface CookieAttributes {
  maxAge: number;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Append a `Set-Cookie` header, bypassing Hono's `setCookie` helper.
 *
 * Needed for exactly one cookie: the member access cookie deliberately runs for five years (see
 * `MAX_AGE` in `access.ts` — Safari honours it, and iOS is most of the audience), and Hono's helper
 * *throws* on any `Max-Age` over the RFC 6265bis 400-day advisory cap. Refusing to send the cookie
 * would take the whole gate down, so the header is serialized here instead. Encoding follows the
 * cookie-octet rule rather than blanket `encodeURIComponent`, which keeps the emitted bytes stable —
 * cookies already in members' browsers must still parse.
 */
export function appendCookie(
  c: Context,
  name: string,
  value: string,
  attrs: CookieAttributes,
): void {
  const encoded = COOKIE_OCTET.test(value) ? value : encodeURIComponent(value);
  const parts = [`${name}=${encoded}`, `Max-Age=${Math.floor(attrs.maxAge)}`, `Path=${attrs.path}`];
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.secure) parts.push('Secure');
  if (attrs.sameSite) parts.push(`SameSite=${attrs.sameSite}`);
  c.header('set-cookie', parts.join('; '), { append: true });
}

/**
 * Where the client's address comes from, which depends on what is in front of the app:
 *
 * - `cloudflare` (the Workers entries): `cf-connecting-ip`, which Cloudflare sets on every request
 *   and a client cannot forge. Without it (only under local `wrangler dev`), the last
 *   `X-Forwarded-For` element.
 * - `proxy` (Node behind a TLS reverse proxy, `TRUST_PROXY=1`): the *last* `X-Forwarded-For`
 *   element — the one the proxy appended — then the socket.
 * - `socket` (Node with nothing in front): the socket address only; every header is the client's.
 *
 * The distinction is a security one. Trusting `cf-connecting-ip` on Node would let anyone send a new
 * one with each request — a generic reverse proxy passes it straight through — and so get a fresh
 * rate-limit budget per password guess. Likewise **never the first** `X-Forwarded-For` element: proxies *append*, so the
 * leftmost is whatever the client wrote.
 */
export type ClientIpSource = 'cloudflare' | 'proxy' | 'socket';

/**
 * Best-effort client address, used only as a rate-limit key. An IPv6 address is reduced to its /64,
 * since one connection usually controls a whole /64 and could otherwise rotate through it.
 */
export function clientIp(
  c: Context,
  source: ClientIpSource = 'cloudflare',
  fallback?: (c: Context) => string | undefined,
): string {
  const lastForwarded = () => {
    const parts = (c.req.header('x-forwarded-for') ?? '').split(',');
    return parts[parts.length - 1]?.trim() || undefined;
  };
  let ip: string | undefined;
  if (source === 'cloudflare') ip = c.req.header('cf-connecting-ip')?.trim() || lastForwarded();
  else if (source === 'proxy') ip = lastForwarded() ?? fallback?.(c);
  else ip = fallback?.(c);
  return ip ? ipv6Prefix(ip) : 'unknown';
}

/** An IPv6 address's first four groups (its /64); anything else unchanged. */
function ipv6Prefix(ip: string): string {
  if (!ip.includes(':') || ip.includes('.')) return ip; // IPv4, or IPv4-mapped (keep whole)
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Collapse a request path into one that can only ever mean "somewhere on this site".
 *
 * `Location: //evil.example.com/x` is a *protocol-relative URL*, not a path — a browser reads it as
 * a different origin. Any redirect that echoes the requested path back (the `?code=` strip in
 * `app.ts` does) is an open redirect without this, and one that a valid access code turns into a
 * credible-looking hop off the ward's own domain. Backslashes are folded too, since the URL parser
 * treats them as separators for http(s).
 */
export function samePathOnly(path: string): string {
  return '/' + path.replace(/^[/\\]+/u, '').replace(/\\/gu, '/');
}
