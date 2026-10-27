// Service worker: handles push notifications and a minimal network-first cache so the app
// still opens offline.
//
// CACHE's build-id placeholder is substituted at serve time (src/shell.ts) with a content hash of
// the app-shell assets, so it changes whenever any asset changes — no manual version bump. That byte
// change is what makes the browser install this worker and the client silently reload to the new
// assets (see public/app.js). Served with no-cache so the browser actually re-checks it.
const BUILD_ID = '{{BUILD_ID}}';
const CACHE = 'pushannounce-' + BUILD_ID;

// The page asks which build this worker belongs to when a new worker takes control, and reloads
// only if its own `<meta name="build-id">` disagrees. Answered on the MessageChannel port the page
// sends (`event.ports[0]`), falling back to the client itself, so the reply cannot be mistaken for
// the `refresh` message below.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'build-id') return;
  const reply = { type: 'build-id', buildId: BUILD_ID };
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(reply);
  else if (event.source) event.source.postMessage(reply);
});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Network-first: always fresh when online, falls back to cache when offline.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    (async () => {
      // Uploaded images are the one exception: their URL contains a random key that is never
      // reused, so a cached copy can never be stale and re-fetching one costs a phone real data.
      // Cache-first, then fall through to the network on a miss.
      if (new URL(request.url).pathname.startsWith('/images/')) {
        const hit = await caches.match(request);
        if (hit) return hit;
      }
      const path = new URL(request.url).pathname;
      try {
        const response = await fetch(request);
        // A 401 from the API means this device's access has ended (signed out, revoked). The copies
        // kept for offline use are the ward's private content; they must not outlive the access.
        if (response.status === 401 && path.startsWith('/api/')) await dropPrivateCopies();
        // Cache successful responses, but never a no-store one (the access gate page is served
        // no-store) so we don't persist the gate in place of the real app.
        const noStore = /no-store/i.test(response.headers.get('Cache-Control') || '');
        if (response.ok && !noStore) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        // `ignoreSearch`: an installed app cold-launches on `/?code=<device token>`, whose first
        // online response is a redirect (never cached), so an exact-URL match would find nothing and a
        // chapel with dead wifi would get a blank page instead of the cached shell under `/`.
        const cached = await caches.match(request, { ignoreSearch: true });
        // The program names people and is for its window only. Offline on Wednesday, Sunday's copy
        // is thrown away rather than shown: the server would have said "closed", so this says it too.
        if (cached && path === '/api/program' && (await programHasClosed(cached))) {
          await (await caches.open(CACHE)).delete(request, { ignoreSearch: true });
          return new Response(JSON.stringify({ open: false, message: 'The program is not available right now.' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return cached || Response.error();
      }
    })(),
  );
});

// An open program past its `closesAt`. A copy without one (cached before the server sent it) is
// treated as closed too: showing nothing offline is the safe way to be wrong.
async function programHasClosed(response) {
  try {
    const data = await response.clone().json();
    return !!data.open && !(typeof data.closesAt === 'number' && Date.now() < data.closesAt);
  } catch {
    return false;
  }
}

async function dropPrivateCopies() {
  const cache = await caches.open(CACHE);
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname.startsWith('/api/')) await cache.delete(request);
  }
}

// Display a notification for each push. iOS requires every push to show one.
//
// Payloads use the Declarative Web Push shape ({ web_push, notification: {...} }). On Safari/iOS
// 18.4+ the browser renders that itself and this handler does NOT run. On every other browser we
// run here and read the same `notification` fields (with a fallback to a flat {title,body,url}).
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }
  const n = payload.notification || payload;
  // The server always sends a title; this generic fallback only guards a malformed payload, so it
  // stays app-name-agnostic (the SW can't read the configured name).
  const title = n.title || 'New announcement';
  const body = n.body || '';
  const url = n.navigate || n.url || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // The maskable variant: Android draws the notification icon inside a circle, which is the same
      // crop that icon is fitted for. The square `any` icon would lose the ends of the building.
      icon: '/icons/icon-192-maskable.png',
      tag: 'push-announcement',
      renotify: true,
      data: { url },
    }),
  );
});

// Subscription rotation: the push service can invalidate a subscription at any time, at which
// point the browser fires `pushsubscriptionchange` (often with no usable newSubscription). If we
// don't mint a fresh one and re-register it, the user silently stops receiving pushes.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// Whether a subscription was made with the server's current VAPID key — the same check as app.js's
// sameServerKey(), for the same reason: after the server's key changes, every push to a
// subscription made with the old one is refused, and re-registering it only hides that. A browser
// that doesn't report the key leaves nothing to compare, and is assumed current.
function sameServerKey(subscription, key) {
  const made = subscription.options && subscription.options.applicationServerKey;
  if (!made) return true;
  const a = new Uint8Array(made);
  const b = urlBase64ToUint8Array(key);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Return the active push subscription — `{ subscription, oldEndpoint }` — minting a fresh one
// (with our VAPID key) if there isn't one, or if the one there was made with a key the server no
// longer holds; `oldEndpoint` is then the replaced one, for the server to drop. Used both by
// `pushsubscriptionchange` and the Background Sync retry below, which already subscribe from here,
// so replacing a stale-key subscription needs nothing the worker wasn't already allowed. A browser
// will not hold two keys for one worker, so the old subscription goes first.
async function ensureSubscription(preferred) {
  const existing = preferred || (await self.registration.pushManager.getSubscription());
  const res = await fetch('/api/vapid-public-key');
  if (!res.ok) throw new Error('vapid key: ' + res.status);
  const { key } = await res.json();
  if (existing && sameServerKey(existing, key)) return { subscription: existing };
  let oldEndpoint;
  if (existing) {
    oldEndpoint = existing.endpoint;
    await existing.unsubscribe();
  }
  const subscription = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  return { subscription, oldEndpoint };
}

// POST a subscription to the server. Throws on any failure so a Background Sync retry can fire —
// except a 409 `blocked`, which is the ward having removed this device under Subscribers: no
// retry will change that, so the subscription is dropped (the next launch then shows the card
// off) and the member's own tap on Enable Notifications is what brings it back. Never sends
// `deliberate`, which is reserved for that tap (app.js).
async function registerSubscription(subscription, oldEndpoint) {
  const payload = subscription.toJSON();
  // Let the server drop the dead endpoint.
  if (oldEndpoint) payload.oldEndpoint = oldEndpoint;
  const res = await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) return;
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body && body.blocked) {
      await subscription.unsubscribe().catch(() => {});
      return;
    }
  }
  throw new Error('subscribe failed: ' + res.status);
}

self.addEventListener('pushsubscriptionchange', (event) => {
  const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
  event.waitUntil(
    (async () => {
      try {
        const { subscription, oldEndpoint: replaced } = await ensureSubscription(event.newSubscription);
        // The event's old subscription is the one the server knows; a replaced newSubscription
        // never reached it.
        await registerSubscription(subscription, oldEndpoint || replaced);
      } catch {
        // Offline or server unreachable (we may not even have been able to mint a subscription).
        // Retry the whole flow once connectivity returns, even with no tab open.
        if ('sync' in self.registration) {
          try {
            await self.registration.sync.register('resync-subscription');
          } catch {
            /* Background Sync unavailable — a page visit will re-sync instead (see app.js). */
          }
        }
      }
    })(),
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag !== 'resync-subscription') return;
  // Throwing (via registerSubscription) makes the browser retry this sync later.
  event.waitUntil(
    (async () => {
      const { subscription, oldEndpoint } = await ensureSubscription(null);
      await registerSubscription(subscription, oldEndpoint);
    })(),
  );
});

/**
 * Ask an open page to refetch its content, bypassing its own resume throttle.
 *
 * Best-effort: postMessage to a client that is gone throws, and there is nothing useful to do
 * about it — the page is not there to be stale.
 */
function tellToRefresh(client) {
  try {
    client.postMessage({ type: 'refresh' });
  } catch {
    /* client went away between matchAll and here */
  }
}

// Focus an existing window or open the app when a notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const target = new URL(targetUrl, self.location.origin);

      // A custom link the admin typed ("a specific web link") points somewhere else entirely, and
      // none of the window reuse below can apply to it. Every client here is same-origin with this
      // worker, so "is one already there?" is always no — except it wasn't: the comparison ignored
      // origin, so a link to another site's *root* matched any open window on `/` and the tap did
      // nothing but focus the app. And `navigate()` rejects cross-origin in practice, which left
      // the other external links focusing the app too. Open a window instead; that is the one thing
      // that reliably works here, and it also stops a notification yanking the member's app away.
      if (target.origin !== self.location.origin) return self.clients.openWindow(targetUrl);

      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Prefer a window already showing the target. Taking the first window of any kind meant a
      // tapped notification could navigate an open /admin tab away mid-edit.
      //
      // The hash is part of "the target", not decoration: notification URLs name a tab
      // (`/#announcements`), so a window parked on `/#program` — or on a bare `/` the entry rule
      // put on the program — is NOT already there and has to be navigated, or the member taps a
      // notification about the announcements and keeps staring at the program.
      const sameSpot = (c) => {
        try {
          const u = new URL(c.url);
          return (
            u.origin === target.origin && u.pathname === target.pathname && u.hash === target.hash
          );
        } catch {
          return false;
        }
      };
      const alreadyThere = allClients.find(sameSpot);
      if (alreadyThere && 'focus' in alreadyThere) {
        // Focus alone re-runs nothing, and the page may have been sitting in the background since
        // before the push. Tell it to refetch: the notification is the strongest possible signal
        // that the content just changed.
        tellToRefresh(alreadyThere);
        // `focus()` can reject (no user-activation credit, a window the browser won't raise). Left
        // unhandled that rejection is the whole outcome of the tap — nothing opens, and the worker
        // may be torn down with an error — so fall back to a fresh window, which is what the tap
        // meant anyway.
        return alreadyThere.focus().catch(() => self.clients.openWindow(targetUrl));
      }

      // Otherwise reuse a window that isn't the admin area, so only ordinary app tabs get moved.
      const reusable = allClients.find((c) => {
        try {
          return !new URL(c.url).pathname.startsWith('/admin');
        } catch {
          return false;
        }
      });
      if (reusable && 'focus' in reusable) {
        if ('navigate' in reusable) {
          try {
            await reusable.navigate(targetUrl);
          } catch {
            // `navigate()` rejects for a window this worker does not control — `matchAll` above
            // asks for uncontrolled ones too, and a page loaded before the worker claimed it is
            // exactly that. Focusing it anyway would re-create the bug this handler exists to fix:
            // the member lands on whatever tab that window was on, under a notification about the
            // announcements. Open the target in a fresh window instead.
            return self.clients.openWindow(targetUrl);
          }
        }
        // Same-document on purpose most of the time: `/` → `/#announcements` is a fragment
        // navigation, so the page does not reload and the data on it stays as stale as it was.
        tellToRefresh(reusable);
        return reusable.focus().catch(() => self.clients.openWindow(targetUrl));
      }
      return self.clients.openWindow(targetUrl);
    })(),
  );
});
