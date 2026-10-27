/**
 * Which ward a piece of code is running for.
 *
 * Everything that would naturally be "one per deployment" — the config, the SQL driver, the cached cookie
 * secrets, the drain lock — is held per **tenant** (a ward) rather than in a module-level variable,
 * so that one process or isolate can serve several wards without one ward's state reaching
 * another's request. Cloudflare reuses isolates freely, and Durable Objects of one class can share
 * an isolate, so a single forgotten module-level variable would be a cross-ward leak; that is the
 * whole reason for this file. See docs/DEPLOYMENT.md § 2b.
 *
 * Modules declare their own state with `tenantLocal(init)` and read it through the accessor it
 * returns, so state stays next to the code that owns it. The current tenant travels with the
 * request in `AsyncLocalStorage` (Node, and Workers under `nodejs_compat`), set by `runInTenant`.
 *
 * Two modes:
 * - **Single-ward** (the default: Node, Docker, the Deploy button). Code outside any
 *   `runInTenant` uses one implicit default tenant, so those entries and the in-process tests need
 *   no changes at all.
 * - **Multi-ward.** A host serving several wards calls `requireTenantContext()` once at load.
 *   From then on there is no default: any code that runs outside `runInTenant` **throws** rather
 *   than quietly reading some ward's state. Failing closed is the point.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export class Tenant {
  /** Per-tenant values, keyed by the identity of the `tenantLocal` that declared them. */
  readonly slots = new Map<object, unknown>();
  /**
   * Who this ward is, for its log lines (log.ts): its id and address on the many-ward host, set by
   * host.ts once it knows them. Empty on a single-ward deployment, whose logs need no label.
   */
  label: { ward?: string; host?: string } = {};
  constructor(readonly id: string) {}
}

const storage = new AsyncLocalStorage<Tenant>();

/** The implicit tenant for a single-ward deployment; `null` once a host requires explicit context. */
let fallback: Tenant | null = new Tenant('default');

/** Switch this isolate to multi-ward mode: no implicit tenant from here on. Irreversible. */
export function requireTenantContext(): void {
  fallback = null;
}

/** Run `fn` (and everything it awaits) as `tenant`. */
export function runInTenant<T>(tenant: Tenant, fn: () => T): T {
  return storage.run(tenant, fn);
}

/** The tenant this code is running for, or a loud error in multi-ward mode when there is none. */
export function currentTenant(): Tenant {
  const tenant = storage.getStore() ?? fallback;
  if (!tenant) {
    throw new Error('No ward context: this code ran outside runInTenant() on a multi-ward host.');
  }
  return tenant;
}

/** The tenant this code is running for, or null: for the logger, which must never throw. */
export function tenantIfAny(): Tenant | null {
  return storage.getStore() ?? fallback;
}

/**
 * Declare a piece of per-tenant state. Returns an accessor that yields the current tenant's value,
 * created with `init()` the first time that tenant asks. Store mutable state in an object and
 * mutate its fields — the accessor returns the same object for the same tenant every time.
 */
export function tenantLocal<T>(init: () => T): () => T {
  const key = {};
  return () => {
    const { slots } = currentTenant();
    if (!slots.has(key)) slots.set(key, init());
    return slots.get(key) as T;
  };
}
