/**
 * In-memory fixed-window rate limiting for the handful of routes that opt in.
 *
 * Hand-rolled rather than pulled from a package: the response surface (the three `x-ratelimit-*`
 * headers on every reply, `retry-after` plus a `{statusCode,error,message}` body on a 429, the same
 * envelope as the app's other errors) is fixed, and getting it through a general-purpose
 * middleware's hooks would be more code than the twenty lines of counting it actually is. This
 * also stays dependency-free and runtime-agnostic.
 *
 * The window is per-key (client IP) and per-route, opened by the first request and reset when it
 * lapses: exactly `max` requests succeed before the (max + 1)th is rejected.
 *
 * Scope note: an in-process Map is per-isolate, so on Cloudflare Workers a limit is enforced per
 * instance rather than globally, and Cloudflare may run several at once. Accepted deliberately for
 * an audience of one ward — these limits exist to blunt admin-password guessing and junk
 * subscriptions, not to meter an API. A genuinely global limit needs Durable Objects or
 * Cloudflare's own rate-limiting binding, neither of which is worth the moving parts here.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { clientIp, type ClientIpSource } from './http.js';
import { logger } from './log.js';

interface Window {
  count: number;
  /** Epoch ms at which this window lapses and the count resets. */
  resetAt: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. The (max + 1)th within the window is rejected. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Supplies the socket address when there is no proxy header (Node entry only). */
  ipFallback?: (c: Context) => string | undefined;
  /** Which address to trust (`clientIp`); the Workers default unless the entry says otherwise. */
  ipSource?: ClientIpSource;
}

/**
 * Sweep threshold and hard cap on one limiter's store.
 *
 * A sweep only ever removes **lapsed** windows, so a spray of distinct keys inside one window (a
 * spoofed `X-Forwarded-For` makes that cheap; see `clientIp`) would grow the map without bound, and
 * a sweep run on every request past a size would pay a whole-map scan per request on the way. So
 * the scan is triggered by growth rather than by traffic, and a store that stays over the cap even
 * after sweeping is dropped wholesale.
 */
const SWEEP_THRESHOLD = 1000;
const MAX_ENTRIES = 5000;

/**
 * Build a limiter middleware. Each call owns its own store, so limits on different routes are
 * independent.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { max, windowMs } = options;
  const windows = new Map<string, Window>();
  // The size the map must reach before the next scan. Raised after each sweep so the cost is
  // amortised over the growth that follows, rather than paid per request. No timer: a timer would
  // keep a Workers isolate alive and has nothing to do in a quiet process.
  let sweepAt = SWEEP_THRESHOLD;
  const sweep = (now: number) => {
    if (windows.size < sweepAt) return;
    for (const [key, win] of windows) if (win.resetAt <= now) windows.delete(key);
    if (windows.size >= MAX_ENTRIES) {
      // Every remaining entry is inside a live window, so there is nothing left to expire and the
      // map is being used as unbounded storage. Dropping it forgives whatever counts were in
      // flight — the honest trade for a bounded process, and loud rather than silent.
      logger.warn(
        { entries: windows.size, max: MAX_ENTRIES },
        'rate-limit store hit its cap; clearing it',
      );
      windows.clear();
    }
    sweepAt = Math.min(Math.max(windows.size * 2, SWEEP_THRESHOLD), MAX_ENTRIES);
  };

  return async (c, next) => {
    const now = Date.now();
    sweep(now);
    const key = clientIp(c, options.ipSource, options.ipFallback);
    let win = windows.get(key);
    if (!win || win.resetAt <= now) {
      win = { count: 0, resetAt: now + windowMs };
      windows.set(key, win);
    }
    win.count += 1;

    const resetSeconds = Math.max(0, Math.ceil((win.resetAt - now) / 1000));
    c.header('x-ratelimit-limit', String(max));
    c.header('x-ratelimit-remaining', String(Math.max(0, max - win.count)));
    c.header('x-ratelimit-reset', String(resetSeconds));

    if (win.count > max) {
      c.header('retry-after', String(resetSeconds));
      return c.body(
        JSON.stringify({
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Rate limit exceeded, retry in ${describeWindow(windowMs)}`,
        }),
        429,
        { 'content-type': 'application/json; charset=utf-8' },
      );
    }
    await next();
  };
}

/** The window as the 429 message phrases it: "1 minute", "5 minutes", "30 seconds". */
function describeWindow(windowMs: number): string {
  const minutes = windowMs / 60_000;
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const seconds = Math.round(windowMs / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * A limit on *failed* attempts only, for a credential that scripts present on every request: the
 * operator API's bearer password. Counting every request would throttle the operator's own tooling;
 * counting nothing would leave the password a fast oracle on every hostname.
 *
 * The order is the whole point. `blocked` is asked **before** the credential is checked, and once
 * an address has spent its failures it is refused whatever it sends — the right password too —
 * until the window lapses. Checking first and refusing only wrong guesses would let the next guess
 * through whenever it happened to be right, which is no limit at all.
 */
export function failureLimit(options: RateLimitOptions): {
  /** Seconds until this address may try again, or null when it may try now. */
  blocked(c: Context): number | null;
  /** Count a failed attempt against this address. */
  fail(c: Context): void;
} {
  const { max, windowMs } = options;
  const windows = new Map<string, Window>();
  const live = (c: Context, now: number) => {
    const key = clientIp(c, options.ipSource, options.ipFallback);
    const win = windows.get(key);
    return { key, win: win && win.resetAt > now ? win : undefined };
  };
  return {
    blocked(c) {
      const now = Date.now();
      const { win } = live(c, now);
      return win && win.count >= max ? Math.max(1, Math.ceil((win.resetAt - now) / 1000)) : null;
    },
    fail(c) {
      const now = Date.now();
      // Bounded as `rateLimit`'s store is, more bluntly: past the cap, forget everyone.
      if (windows.size >= MAX_ENTRIES) {
        for (const [key, win] of windows) if (win.resetAt <= now) windows.delete(key);
        if (windows.size >= MAX_ENTRIES) windows.clear();
      }
      const { key, win } = live(c, now);
      if (win) win.count += 1;
      else windows.set(key, { count: 1, resetAt: now + windowMs });
    },
  };
}
