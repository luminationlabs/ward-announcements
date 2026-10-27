/**
 * The Content Security Policy, and the per-response nonce that lets the app's own inline scripts
 * run under it.
 *
 * Every page carries inline scripts, and the escaping in views.ts is what keeps anyone else's out.
 * The policy is the second line: `script-src 'self' 'nonce-…'` runs a script only if it is one of
 * our files or an inline block carrying this response's nonce, so a value that one day slipped
 * through unescaped — a ward name, a person's name, an announcement title — still could not run.
 * Inline event handlers (`onsubmit="…"`) are refused outright by that policy; the dashboard uses
 * `data-confirm` instead (views.ts), and test/hardening.test.js fails on any that come back.
 *
 * The nonce is fresh per response and held in `AsyncLocalStorage` for the request (Node, and
 * Workers under `nodejs_compat`, as tenant.ts does), so a template asks for it with `scriptTag()`
 * rather than having it threaded through every view's arguments. It is never computed from the
 * page: a policy built by hashing whatever scripts a response turned out to contain would approve
 * an injected one too. Content stored before the response — every announcement, every name — cannot
 * know a nonce made for it afterwards, which is what makes this work against stored injection.
 *
 * Styles are not restricted: the pages use inline `style` attributes freely, and a style cannot
 * run code.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';

const requestNonce = new AsyncLocalStorage<string>();

/** This response's nonce, or null outside a request (an in-process test rendering a view). */
export function cspNonce(): string | null {
  return requestNonce.getStore() ?? null;
}

/**
 * An inline script's opening tag. Outside a request there is no policy to satisfy, so the tag has
 * no nonce; inside one it always has this response's.
 */
export function scriptTag(): string {
  const nonce = cspNonce();
  return nonce ? `<script nonce="${nonce}">` : '<script>';
}

/** The policy for a response with this nonce. */
export function contentSecurityPolicy(nonce: string): string {
  return [
    `script-src 'self' 'nonce-${nonce}'`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    // Every form posts back to this origin, so a form whose `action` was somehow rewritten to
    // carry a session elsewhere is refused by the browser before it leaves.
    "form-action 'self'",
  ].join('; ');
}

/**
 * Mint the nonce, set the policy, and run the rest of the request inside it. Registered ahead of
 * every route by app.ts and operator.ts.
 */
export const withContentSecurityPolicy: MiddlewareHandler = async (c, next) => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  c.header('Content-Security-Policy', contentSecurityPolicy(nonce));
  await requestNonce.run(nonce, () => next());
};
