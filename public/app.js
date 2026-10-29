// Public page logic: render announcements, register the service worker, and manage the
// push-notification opt-in. Plain ES modules-free script so it runs everywhere.

const statusEl = document.getElementById('notify-status');
const notifyCard = document.getElementById('notify-card');
const enableBtn = document.getElementById('enable-btn');
const disableBtn = document.getElementById('disable-btn');
const dismissBtn = document.getElementById('dismiss-notify-btn');
const listEl = document.getElementById('announcement-list');
const installedBanner = document.getElementById('installed-banner');
const installedBannerText = document.getElementById('installed-banner-text');
const shareBtn = document.getElementById('share-btn');
// The button's text lives in its own span so status updates don't wipe out the icon beside it.
const shareLabel = document.getElementById('share-label');
const shareSheet = document.getElementById('share-sheet');
const shareQr = document.getElementById('share-qr');
const shareNote = document.getElementById('share-note');
const shareSend = document.getElementById('share-send');
const shareCopy = document.getElementById('share-copy');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const programContent = document.getElementById('program-content');
const resourcesList = document.getElementById('resources-list');
const resourcesTab = document.getElementById('tab-resources');

// If we got here with an unlock credential still in the fragment (#code= / #i=), the cookie was
// already valid so the gate page never ran to consume it. Scrub it now so it doesn't linger in
// the address bar, get bookmarked, or ride along when the member shares "the page I'm on".
if (/[#&](?:code|i)=/.test(location.hash)) {
  history.replaceState(null, '', location.pathname + location.search);
}

const isiOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const pushSupported =
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// A push call that never settles. The push APIs on iOS are brokered by a system daemon, and where
// that daemon is absent (the Simulator) or wedged, `getSubscription()` / `subscribe()` hang rather
// than reject — feature detection passes, so nothing else on this page would notice, and the card
// would sit on its placeholder text forever with no button. Bound the wait so the card always
// reaches a state with something to tap.
const PUSH_CALL_TIMEOUT_MS = 8000;
// The content fetches get the same treatment for a different hang: chapel wifi that associates but
// never routes. A request there neither resolves nor rejects for minutes, and standalone mode has no
// pull-to-refresh to escape with, so the panel sat on "Loading…" the whole time. An aborted fetch
// lands in the catch below like any other failure — and the service worker answers from its cache
// on the retry, if it has one. (`AbortSignal.timeout` is Safari 16+, which is older than push.)
const CONTENT_FETCH_TIMEOUT_MS = 15000;
function fetchTimeout() {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(CONTENT_FETCH_TIMEOUT_MS)
    : undefined;
}
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function setStatus(text) {
  statusEl.textContent = text;
}

function show(el) {
  el.hidden = false;
}
function hide(el) {
  el.hidden = true;
}

// --- Announcements ---------------------------------------------------------

// "New" tags: which announcements this phone has not shown before. Per device, in localStorage —
// nothing about what a member has read ever leaves their phone.
const SEEN_KEY = 'seen-announcements';
// Away at least this long, and coming back counts as a fresh visit: what was on screen last time
// stops being new. Shorter than that is the member glancing at another app mid-read, and their tags
// must still be there when they come back. (An installed iPhone app resumes rather than reloads, so
// without this a tag could outlive the week it belonged to.)
const NEW_TAG_VISIT_GAP_MS = 15 * 60 * 1000;

/**
 * Which announcements to tag "New", and what to remember as seen. Pure, so the vm test can drive it.
 *
 * `baseline` is the list of ids this phone had seen when the visit began — a page load, or a return
 * after a long absence — and stays fixed for the visit. Measuring every re-render against that one
 * baseline, rather than against what was saved a moment ago, is what keeps a tag from blinking off
 * when a resume or a refresh rebuilds the list while the member is still reading it; an
 * announcement published mid-visit still gets its tag. `null` is a phone with no record at all (its
 * first visit, or storage that was cleared or refused): nothing is tagged, since everything would
 * be.
 *
 * `seen` is simply the ids on screen now — which also prunes ids whose announcements have gone.
 */
function newAnnouncementTags(baseline, currentIds) {
  const current = currentIds.map(String);
  if (!Array.isArray(baseline)) return { fresh: [], seen: current };
  const known = new Set(baseline.map(String));
  return { fresh: current.filter((id) => !known.has(id)), seen: current };
}

/** The ids this phone has already shown, or null when it has no (readable) record. */
function readSeenAnnouncements() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null; // storage refused (private mode, blocked) or a corrupt value: treat as no record
  }
}

function writeSeenAnnouncements(ids) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable or full — tags just won't carry over to the next visit */
  }
}

// The visit's baseline: `undefined` until the first render of a visit reads it, then fixed. A phone
// with no record starts its baseline at what that first render showed, so nothing is new on a
// first visit, but something posted while it stays open still is.
let seenBaseline;
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
  } else if (hiddenAt && Date.now() - hiddenAt >= NEW_TAG_VISIT_GAP_MS) {
    seenBaseline = undefined; // a new visit; registered before the resume refresh below runs
  }
});

async function renderAnnouncements() {
  try {
    const res = await fetch('/api/announcements', { signal: fetchTimeout() });
    // Gated out mid-session — the cookie lapsed, or an admin signed everyone out. An
    // installed PWA resuming from frozen never navigates, so without this it would sit on "Could
    // not load announcements" forever. Reloading hands the visitor to the gate page, which is the
    // only thing that can actually unlock them. No loop risk: the gate page doesn't run this file.
    if (res.status === 401) {
      location.reload();
      return;
    }
    const { announcements } = await res.json();
    const ids = announcements.map((a) => String(a.id));
    if (seenBaseline === undefined) seenBaseline = readSeenAnnouncements() || ids;
    const tags = newAnnouncementTags(seenBaseline, ids);
    writeSeenAnnouncements(tags.seen);
    const fresh = new Set(tags.fresh);
    // Built detached and swapped in only if it differs from what is on screen: this runs on every
    // resume, and rebuilding identical content re-decoded every thumbnail and re-flowed the page —
    // a visible blink for nothing. The fetch itself is unconditional; only the paint is skipped.
    const next = document.createElement('div');
    if (!announcements.length) {
      next.innerHTML = '<p class="empty-note">No announcements this week.</p>';
      swapIfChanged(listEl, next);
      imagesListed.announcements = true;
      return;
    }
    for (const a of announcements) {
      const card = document.createElement('article');
      card.className = 'announcement';

      const h3 = document.createElement('h3');
      h3.textContent = a.title;
      if (fresh.has(String(a.id))) {
        const tag = document.createElement('span');
        tag.className = 'new-tag';
        tag.textContent = 'New';
        h3.append(' ', tag);
      }
      card.appendChild(h3);

      const body = document.createElement('div');
      body.className = 'body';
      // Server-rendered, sanitized Markdown HTML (markdown-it with html:false).
      body.innerHTML = a.html;
      card.appendChild(body);

      if (a.images && a.images.length) card.appendChild(thumbnailRow(a.images));

      next.appendChild(card);
    }
    swapIfChanged(listEl, next);
    imagesListed.announcements = true;
  } catch {
    imagesListed.announcements = false;
    listEl.innerHTML = '<p class="muted">Could not load announcements.</p>';
  }
}

/**
 * Replace `target`'s children with `next`'s, unless they already serialize identically.
 *
 * The comparison is on markup, which is what the member sees; listeners on the new nodes (thumbnail
 * taps) are only lost when the nodes are discarded as duplicates of ones that already carry their
 * own. Returns whether anything changed, for callers that care.
 *
 * An image that failed to load would be the exception, since its markup is identical to a working
 * one: a flyer whose fetch died once (see the image note in public/sw.js) stayed a broken box on
 * every later refresh, until the app was force-quit. `markFailedImages` makes it differ.
 */
function swapIfChanged(target, next) {
  if (target.innerHTML === next.innerHTML) return false;
  target.replaceChildren(...next.childNodes);
  return true;
}

/** How long to wait before each automatic reload of a failed image; one entry per attempt. */
const IMAGE_RETRY_DELAYS_MS = [2_000, 8_000];

/** Automatic reloads already spent on each image. A WeakMap, not an attribute: nothing in the markup. */
const imageRetries = new WeakMap();

/**
 * Recover images that fail to load in a swapped container.
 *
 * A failed image is tagged `data-failed`, so its container no longer matches a fresh render and the
 * next refresh swaps in new nodes, which fetch it again. Before that, it is reloaded in place after
 * IMAGE_RETRY_DELAYS_MS, so a member left looking at the page is not waiting on a resume. iOS freezes
 * timers with the app, so a load killed by a suspension is retried just after the app comes back.
 * A reload that succeeds drops the tag, and the markup matches again.
 *
 * Keyed to the `error` event rather than `complete`/`naturalWidth`: Chrome reports a lazy image not
 * yet scrolled to as complete with no width, which would read as broken. Capture phase, because
 * neither `error` nor `load` bubbles. Bounded: the retries per image are counted, and a node a
 * refresh has since replaced is left alone.
 */
function markFailedImages(container) {
  if (!container) return;
  container.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const src = img.getAttribute('src');
      if (!src) return; // no source, nothing to retry
      img.setAttribute('data-failed', '');
      const spent = imageRetries.get(img) || 0;
      if (spent >= IMAGE_RETRY_DELAYS_MS.length) return; // the next refresh is the last word
      imageRetries.set(img, spent + 1);
      setTimeout(() => {
        if (!img.isConnected || !img.hasAttribute('data-failed')) return;
        // Cleared and set again rather than re-assigned, so it is a fresh load (checked in Chrome and iOS Safari).
        img.removeAttribute('src');
        img.setAttribute('src', src);
      }, IMAGE_RETRY_DELAYS_MS[spent]);
    },
    true,
  );
  container.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement) e.target.removeAttribute('data-failed');
    },
    true,
  );
}
markFailedImages(listEl);
markFailedImages(programContent);
markFailedImages(resourcesList);

// --- Images offline ----------------------------------------------------------

/** Saved announcement and resource images. Must match IMAGE_CACHE in public/sw.js, which serves them. */
const IMAGE_CACHE = 'pushannounce-images';

/** Whether each section last rendered from a real reply: pruning must never run against an error. */
const imagesListed = { announcements: false, resources: false };

/**
 * Save an image that just loaded, so the service worker can answer it from now on — offline too.
 *
 * The page does this rather than the worker relaying the download, because a relayed download dies
 * with its worker: on iOS an updated worker taking over during a cold launch of the home-screen app
 * cancelled every image still in flight (see the fetch handler in public/sw.js). In Chrome the
 * browser's cache answers the save's fetch; in an iOS home-screen app it did not, even with
 * `force-cache`, so there each new image is downloaded twice, once. Program images are never saved
 * (they are `no-store`, and their container is not watched).
 */
async function saveImageForOffline(img) {
  const path = new URL(img.src, location.href).pathname;
  if (!path.startsWith('/images/') || !('caches' in window)) return;
  try {
    const cache = await caches.open(IMAGE_CACHE);
    if (!(await cache.match(path))) {
      const response = await fetch(path, { cache: 'force-cache' });
      if (!response.ok || /no-store/i.test(response.headers.get('Cache-Control') || '')) return;
      await cache.put(path, response);
    }
    // Told even when it was already saved: a worker that missed the first message (it went to the
    // one an update replaced) would otherwise keep sending this image to the network.
    navigator.serviceWorker?.controller?.postMessage({ type: 'image-saved', path });
  } catch {
    /* best effort: the next time it loads tries again */
  }
}

function saveLoadedImages(container) {
  if (!container) return;
  container.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement) saveImageForOffline(e.target);
    },
    true,
  );
}
saveLoadedImages(listEl);
saveLoadedImages(resourcesList);

/**
 * Forget saved images that no announcement or resource shows any more, so the cache does not grow
 * by every flyer the ward has ever posted. Only after both sections rendered from a real reply (a
 * cached one offline counts): an error message lists no images, and pruning against it would throw
 * away everything a member needs in a chapel with no signal.
 */
async function pruneSavedImages() {
  if (!imagesListed.announcements || !imagesListed.resources || !listEl || !resourcesList) return;
  if (!('caches' in window)) return;
  const shown = new Set(
    [...listEl.querySelectorAll('img'), ...resourcesList.querySelectorAll('img')]
      .filter((img) => img.getAttribute('src'))
      .map((img) => new URL(img.src, location.href).pathname),
  );
  try {
    const cache = await caches.open(IMAGE_CACHE);
    let removed = false;
    for (const request of await cache.keys()) {
      if (shown.has(new URL(request.url).pathname)) continue;
      await cache.delete(request);
      removed = true;
    }
    if (removed) navigator.serviceWorker?.controller?.postMessage({ type: 'images-changed' });
  } catch {
    /* best effort: the next refresh prunes again */
  }
}

// --- Tabs ------------------------------------------------------------------

// Three content sections, one shell. The tab is reflected in `location.hash` so the back button and
// a shared "#program" link both work, and so a reload lands where the member was rather than
// re-running the entry rule underneath them. Resources is only shown once there is a page to read
// (see renderResources), and is never the entry tab.
const TABS = ['program', 'announcements', 'resources'];

/** Set once /api/pages has answered with no published pages; cleared when one appears. */
let resourcesKnownEmpty = false;

/** The tabs a member can actually see — Resources is hidden until there is a page to show. */
function visibleTabs() {
  return TABS.filter((tab) => {
    const button = document.getElementById('tab-' + tab);
    return button && !button.hidden;
  });
}

function tabFromHash() {
  const name = location.hash.replace(/^#/, '');
  return TABS.indexOf(name) > -1 ? name : null;
}

function showTab(name, { updateHash = true, focus = false } = {}) {
  // A `#resources` link when the ward has no published pages: the tab is hidden, so its panel would
  // sit there with nothing selected. Only once the fetch has *said* there are none — before it
  // answers, the link is honoured and the panel shows "Loading…" like the others.
  if (name === 'resources' && resourcesKnownEmpty) name = 'announcements';
  for (const tab of TABS) {
    const button = document.getElementById('tab-' + tab);
    const panel = document.getElementById('panel-' + tab);
    if (!button || !panel) continue;
    const active = tab === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    // Roving tabindex: the tab list is one Tab stop, and the arrow keys move within it. A panel
    // carries `tabindex="0"` in the markup so the next Tab press lands on it, not past it.
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
    panel.hidden = !active;
  }
  if (updateHash && tabFromHash() !== name) {
    // replaceState, not a hash assignment: switching tabs is not a place in history worth a back
    // press, and an installed PWA has no address bar to show it off in anyway.
    history.replaceState(null, '', location.pathname + location.search + '#' + name);
  }
}

function initTabs() {
  for (const tab of TABS) {
    const button = document.getElementById('tab-' + tab);
    if (button) button.addEventListener('click', () => showTab(tab));
  }
  // The ARIA tab pattern's keyboard half: Left/Right (wrapping) and Home/End move both selection
  // and focus, so `role="tab"` promises nothing a keyboard cannot deliver.
  const tablist = document.querySelector('.tabs[role="tablist"]');
  if (tablist) {
    tablist.addEventListener('keydown', (event) => {
      const present = visibleTabs();
      const current = present.indexOf((event.target.id || '').replace(/^tab-/, ''));
      if (current < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % present.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + present.length) % present.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = present.length - 1;
      else return;
      event.preventDefault();
      showTab(present[next], { focus: true });
    });
  }
  // A hash typed, pasted, or arrived at with the back button — or, on iOS, a tapped notification:
  // Safari navigates Declarative Web Push itself and never runs the service worker's
  // `notificationclick`, so no `refresh` message arrives there, and `/` → `/#announcements` into an
  // already-open app is a same-document navigation that reloads nothing. Refetch on the way in.
  // Unforced, so it stays behind the throttle and a tab switch by hand costs nothing extra.
  // (Tab buttons use `replaceState`, which fires no `hashchange`, so they don't come through here.)
  window.addEventListener('hashchange', () => {
    // Same scrub as on the way in, for the same reason: a member already on the unlocked page who
    // opens their link again changes only the fragment, so the load-time scrub never re-runs.
    if (/[#&](?:code|i)=/.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    const name = tabFromHash();
    if (name) showTab(name, { updateHash: false });
    refreshOnResume();
  });
}

// --- The sacrament meeting program -----------------------------------------

// Whether the server says there is a program to read right now. The server decides this, not the
// client: /api/program returns the closed message and nothing else outside the window, so the names
// on a program are never delivered early even to someone reading the raw response.
let programOpen = false;

async function renderProgram() {
  if (!programContent) return;
  try {
    const res = await fetch('/api/program', { signal: fetchTimeout() });
    // Same reasoning as the announcements fetch: a lapsed cookie (or a gate an admin just switched
    // on) has to reload into the gate page, which is the only thing that can unlock us again.
    if (res.status === 401) {
      location.reload();
      return;
    }
    const data = await res.json();
    programOpen = !!data.open;
    const next = document.createElement('div'); // detached; see renderAnnouncements

    if (!data.open) {
      const closed = document.createElement('p');
      closed.className = 'program-closed';
      closed.textContent = data.message || 'The program is not available right now.';
      next.appendChild(closed);
      swapIfChanged(programContent, next);
      return;
    }

    const article = document.createElement('article');
    article.className = 'program';

    const heading = document.createElement('h2');
    heading.className = 'program-date';
    heading.textContent = formatProgramDate(data.date);
    article.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'body';
    // Server-rendered, sanitized Markdown HTML (markdown-it with html:false, plus the dot-leader
    // block rule — which emits its own markup and never interpolates the admin's text).
    body.innerHTML = data.html;
    article.appendChild(body);

    if (data.images && data.images.length) article.appendChild(thumbnailRow(data.images));

    next.appendChild(article);
    swapIfChanged(programContent, next);
  } catch {
    programOpen = false;
    programContent.textContent = '';
    const failed = document.createElement('p');
    failed.className = 'muted';
    failed.textContent = 'Could not load the program.';
    programContent.appendChild(failed);
  }
}

// 'YYYY-MM-DD' is a calendar date, so parse and format it as UTC — otherwise a phone west of the
// server would render Sunday's program as "Saturday".
function formatProgramDate(date) {
  const parts = String(date || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return String(date || '');
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

// --- Announcement images ---------------------------------------------------

// --- Resources -------------------------------------------------------------

/**
 * The Resources tab: standing reference pages, each a collapsible section under its title.
 *
 * Collapsed by default so one long page does not push the rest down; a single page
 * opens on its own, since a list of one is not a list. The open/closed state a member set is
 * carried onto the rebuilt nodes before the swap comparison, so a resume refresh that changed
 * nothing neither repaints nor folds the section they were reading.
 */
async function renderResources() {
  if (!resourcesList) return;
  try {
    const res = await fetch('/api/pages', { signal: fetchTimeout() });
    // Same reasoning as the announcements fetch: a lapsed cookie has to reload into the gate page.
    if (res.status === 401) {
      location.reload();
      return;
    }
    const { pages } = await res.json();
    const next = document.createElement('div'); // detached; see renderAnnouncements
    for (const p of pages) {
      const section = document.createElement('details');
      section.className = 'resource';
      section.dataset.id = String(p.id);
      const existing = resourcesList.querySelector('details[data-id="' + p.id + '"]');
      section.open = existing ? existing.open : pages.length === 1;

      const summary = document.createElement('summary');
      summary.textContent = p.title;
      section.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = p.html; // server-rendered, sanitized Markdown
      section.appendChild(body);

      if (p.images && p.images.length) section.appendChild(thumbnailRow(p.images));
      next.appendChild(section);
    }
    if (!pages.length) next.innerHTML = '<p class="muted">Nothing here yet.</p>';
    swapIfChanged(resourcesList, next);
    imagesListed.resources = true;
    resourcesKnownEmpty = pages.length === 0;
    setResourcesTabVisible(pages.length > 0);
  } catch {
    imagesListed.resources = false;
    resourcesList.innerHTML = '<p class="muted">Could not load the resources.</p>';
    // A cold load of `/#resources` that could not fetch: the tab was never revealed, so the member
    // would be reading an error on a panel with no tab selected. Fall back to the announcements. A
    // tab that was already showing is left alone — a transient failure should not hide it.
    if (resourcesTab && resourcesTab.hidden && resourcesTab.classList.contains('is-active')) {
      showTab('announcements');
    }
  }
}

/**
 * Show the Resources tab only while there is something behind it. If the tab was showing and the
 * last page just went unpublished, move the member to the announcements rather than leave them on
 * a tab that no longer exists.
 */
function setResourcesTabVisible(visible) {
  if (!resourcesTab) return;
  resourcesTab.hidden = !visible;
  if (!visible && resourcesTab.classList.contains('is-active')) showTab('announcements');
}

// A row of thumbnails under an announcement's text. Each is a <button>, not a bare <img>: it opens
// the full-size view, so it has to be reachable by keyboard and announce itself as something to
// press.
function thumbnailRow(images) {
  const row = document.createElement('div');
  row.className = 'thumbs';
  for (const image of images) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    button.setAttribute('aria-label', image.alt ? 'View ' + image.alt : 'View image');
    const img = document.createElement('img');
    img.src = image.url;
    img.alt = image.alt || '';
    img.loading = 'lazy';
    button.appendChild(img);
    button.addEventListener('click', () => openLightbox(image.url, image.alt || ''));
    row.appendChild(button);
  }
  return row;
}

function openLightbox(url, alt) {
  if (!lightbox) return;
  lightboxImg.src = url;
  lightboxImg.alt = alt;
  lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  if (!lightbox || lightbox.hidden) return;
  lightbox.hidden = true;
  document.body.style.overflow = '';
  // Drop the source so a large image isn't held decoded in memory behind a hidden element.
  lightboxImg.removeAttribute('src');
}

function initLightbox() {
  if (!lightbox) return;
  // Anywhere but the image itself is backdrop, which is the whole gesture on a phone.
  lightbox.addEventListener('click', (e) => {
    if (e.target !== lightboxImg) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
}

// --- Share With Someone ----------------------------------------------------

// The member's own address bar is useless as a share source: the credential was stripped the
// moment they unlocked, and the code it came from may have been rotated away since. So the app
// asks the server for a fresh invite instead — a link that unlocks the app for one newcomer and
// then expires on its own, independent of whatever the current shared code happens to be.
let invite = null; // cached for this page view, so re-opening the sheet doesn't mint another

function openShareSheet() {
  shareSheet.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeShareSheet() {
  shareSheet.hidden = true;
  document.body.style.overflow = '';
}

async function getInvite() {
  if (invite) return invite;
  const res = await fetch('/api/invite', { method: 'POST' });
  if (!res.ok) throw new Error('invite failed');
  invite = await res.json();
  return invite;
}

async function showInvite() {
  shareBtn.disabled = true;
  const label = shareLabel.textContent;
  shareLabel.textContent = 'Creating a link…';
  try {
    const data = await getInvite();
    shareQr.innerHTML = data.qrSvg;
    // Name what expires. "It stops working after 30 days" read as though the person you invited
    // would lose access — the opposite of what happens: opening the link grants the same
    // long-lived sliding cookie every other member holds, and only the link itself goes stale.
    const days = data.expiresInDays === 1 ? '1 day' : data.expiresInDays + ' days';
    shareNote.textContent =
      'Have them scan this, or send the link. Anyone who opens it keeps access, but the invite link expires ' +
      days +
      ' from now. Come back here for a new link any time.';
    shareCopy.textContent = 'Copy Link';
    if (navigator.share) show(shareSend);
    openShareSheet();
  } catch {
    shareLabel.textContent = "Couldn't create a link — try again";
    setTimeout(() => {
      shareLabel.textContent = label;
    }, 3000);
    return;
  } finally {
    shareBtn.disabled = false;
    if (shareLabel.textContent === 'Creating a link…') shareLabel.textContent = label;
  }
}

function initShare() {
  if (!shareBtn) return;
  shareBtn.addEventListener('click', showInvite);
  shareSheet.addEventListener('click', (e) => {
    if (e.target === shareSheet) closeShareSheet();
  });
  document.getElementById('share-sheet-close').addEventListener('click', closeShareSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !shareSheet.hidden) closeShareSheet();
  });
  shareSend.addEventListener('click', async () => {
    try {
      await navigator.share({ title: document.documentElement.dataset.appName, url: invite.url });
    } catch {
      /* the member dismissed the share sheet */
    }
  });
  shareCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(invite.url);
      shareCopy.textContent = 'Copied ✓';
    } catch {
      shareCopy.textContent = invite.url; // no clipboard access: show it to copy by hand
    }
  });
}

// --- Push subscription -----------------------------------------------------

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// The post-install welcome banner (shown once by install.js) must not tell an already-subscribed
// user to "Enable Notifications" — on Android you can subscribe in the browser, then install.
// Tailor it to the real subscription state whenever it's visible.
function updateInstalledBanner(state) {
  if (!installedBanner || installedBanner.hidden || !installedBannerText) return;
  if (state === 'subscribed') {
    installedBannerText.innerHTML = "✓ <strong>You're all set</strong> — notifications are on.";
  } else if (state === 'blocked') {
    installedBannerText.innerHTML =
      '✓ <strong>Added to Home Screen.</strong> Notifications are blocked — turn them on in your device settings to get weekly updates.';
  } else {
    installedBannerText.innerHTML =
      "✓ <strong>Added to Home Screen.</strong> Last step: tap <strong>Enable Notifications</strong> below.";
  }
}

async function refreshSubscriptionUI(registration) {
  if (Notification.permission === 'denied') {
    setStatus('Notifications are blocked. Enable them for this app in your device settings.');
    hide(enableBtn);
    hide(disableBtn);
    hide(dismissBtn);
    updateInstalledBanner('blocked');
    return;
  }
  let existing;
  try {
    existing = await withTimeout(
      registration.pushManager.getSubscription(),
      PUSH_CALL_TIMEOUT_MS,
      'Checking the subscription',
    );
  } catch {
    // Leave the Enable button in reach: on a real device a stalled push daemon can recover, and a
    // tap that also stalls gets its own message from subscribe() rather than a dead button.
    setStatus(
      "We couldn't check whether notifications are on. Try again, or close the app fully and reopen it.",
    );
    show(enableBtn);
    hide(disableBtn);
    hide(dismissBtn);
    updateInstalledBanner('unsubscribed');
    return;
  }
  if (existing) {
    setStatus("You're subscribed ✓  You'll get a notification when new announcements are posted.");
    hide(enableBtn);
    show(disableBtn);
    show(dismissBtn);
    updateInstalledBanner('subscribed');
  } else {
    // The optional home-screen install sits on this card as a second button (install.js decides
    // whether to reveal it). Where it shows, give it a sentence so it isn't an unexplained choice
    // beside Enable — one that names what it's *for* rather than calling it optional, which would
    // imply the notifications beside it are not. Where there is no button (iOS, where the install
    // card leads; desktop without a native dialog) the clause would be a loose end.
    const optionalInstall = document.getElementById('add-home-btn');
    setStatus(
      'Get a notification when new announcements are posted (about once a week).' +
        (optionalInstall && !optionalInstall.hidden
          ? ' Add the app to your home screen for quick access.'
          : ''),
    );
    show(enableBtn);
    hide(disableBtn);
    hide(dismissBtn);
    updateInstalledBanner('unsubscribed');
  }
}

async function subscribe() {
  enableBtn.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('Notifications were not enabled. You can try again any time.');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const res = await fetch('/api/vapid-public-key');
    const { key } = await res.json();
    const subscription = await withTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }),
      PUSH_CALL_TIMEOUT_MS,
      'Subscribing',
    );
    // `deliberate`: this is the member's own tap, the one thing that lifts an admin's Remove
    // (see syncSubscription). The launch re-sync and the service worker never send it.
    const res2 = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...subscription.toJSON(), deliberate: true }),
    });
    if (!res2.ok) {
      // The server rejected the subscription (e.g. access gate 401, or a 4xx/5xx). Roll back the
      // browser-side subscription so the UI's "browser subscription ⇔ server knows it" invariant
      // holds and refreshSubscriptionUI shows the Enable button again on the next visit.
      await subscription.unsubscribe();
      setStatus("Sorry, we couldn't turn on notifications just now. Please try again in a moment.");
      return;
    }
    await refreshSubscriptionUI(registration);
  } catch (err) {
    setStatus('Sorry, something went wrong enabling notifications: ' + err.message);
  } finally {
    enableBtn.disabled = false;
  }
}

// Re-register the live subscription with the server. Idempotent (upsert by endpoint): a no-op
// when the server already knows it, a self-heal when a background rotation re-subscribed us but
// couldn't reach the server at the time. Resolves true when the server took it, false when it
// refused (the caller warns), and 'blocked' when the ward removed this device under Subscribers:
// the subscription is dropped here so the card honestly reads off, and only a tap on Enable
// Notifications (which posts `deliberate: true`) brings it back. A thrown fetch is offline.
async function syncSubscription(registration, subscription, oldEndpoint) {
  const payload = subscription.toJSON();
  // Let the server drop the endpoint this one replaces (see renewIfKeyChanged).
  if (oldEndpoint) payload.oldEndpoint = oldEndpoint;
  const res = await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) return true;
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    if (body && body.blocked) {
      try {
        await subscription.unsubscribe();
      } catch {
        /* the next launch tries again; the server refuses it either way */
      }
      await refreshSubscriptionUI(registration);
      setStatus(
        'The ward removed notifications for this device. Tap Enable Notifications if you want them again.',
      );
      return 'blocked';
    }
  }
  return false;
}

// Whether a subscription was made with the server's current VAPID public key. A subscription is
// bound to the key it was created with, so once the server's key changes (a restore that didn't
// carry the keys, a move to a new host) every push to it is refused — and nothing on the phone
// says so: the toggle stays on, each visit's re-sync resets the server's failure count, and the
// member simply stops hearing from the ward. A browser that doesn't report the key leaves nothing
// to compare, and is assumed current rather than churned on every launch.
function sameServerKey(subscription, key) {
  const made = subscription.options && subscription.options.applicationServerKey;
  if (!made) return true;
  const a = new Uint8Array(made);
  const b = urlBase64ToUint8Array(key);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Replace a subscription made with a key the server no longer holds. Resolves to what the server
// should be told — `{ subscription, oldEndpoint }`, with the same subscription back when the key
// still matches — or null when the subscription had to go and a new one couldn't be made here, in
// which case the card has already been redrawn to say so. A browser will not hold two keys for one
// worker, so the old subscription is dropped before the new one is asked for.
async function renewIfKeyChanged(registration, current) {
  const res = await fetch('/api/vapid-public-key');
  if (!res.ok) return { subscription: current };
  const { key } = await res.json();
  if (!key || sameServerKey(current, key)) return { subscription: current };
  const oldEndpoint = current.endpoint;
  try {
    await current.unsubscribe();
  } catch {
    setStatus(
      "We couldn't confirm your notifications with the server, so weekly updates may not arrive. Try turning notifications off and on again.",
    );
    return null;
  }
  try {
    const subscription = await withTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      }),
      PUSH_CALL_TIMEOUT_MS,
      'Subscribing',
    );
    return { subscription, oldEndpoint };
  } catch {
    // Some browsers only subscribe from a tap. The old subscription is already gone, so the card
    // now honestly reads "off": tell the server to forget it too, and ask for the tap.
    try {
      await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: oldEndpoint }),
      });
    } catch {
      /* offline; the dead endpoint is pruned by the sender in time */
    }
    await refreshSubscriptionUI(registration);
    setStatus(
      "The ward's notification settings changed, so notifications need turning on again. Tap Enable Notifications.",
    );
    return null;
  }
}

async function unsubscribe() {
  disableBtn.disabled = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    await refreshSubscriptionUI(registration);
  } finally {
    disableBtn.disabled = false;
  }
}

// --- Dismissible cards -----------------------------------------------------

// Let users collapse the install / notifications cards and bring them back later. The choice is
// stored in localStorage; a dismissed card shrinks to a one-line "show" stub (see styles.css).
function setupDismissibleCards() {
  const KEY = 'dismissed-cards';
  let state;
  try {
    state = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    state = {};
  }
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable (e.g. private mode) — dismissal just won't persist */
    }
  };
  const apply = (card, name) => card.classList.toggle('is-dismissed', !!state[name]);

  document.querySelectorAll('[data-dismiss]').forEach((btn) => {
    const name = btn.getAttribute('data-dismiss');
    const card = btn.closest('.card');
    if (!card) return;
    apply(card, name);
    btn.addEventListener('click', () => {
      state[name] = true;
      persist();
      apply(card, name);
    });
  });
  document.querySelectorAll('[data-restore]').forEach((btn) => {
    const name = btn.getAttribute('data-restore');
    const card = btn.closest('.card');
    if (!card) return;
    btn.addEventListener('click', () => {
      delete state[name];
      persist();
      apply(card, name);
    });
  });
}

// --- Appearance ------------------------------------------------------------

// The Auto / Light / Dark switch at the foot of the page. The choice itself — reading it, storing
// it, applying it to <html data-theme>, following the system while on Auto — belongs to the head
// script (src/theme.ts), which has to run before first paint; this only drives it.
function initAppearance() {
  const row = document.getElementById('appearance');
  const control = window.wardAppearance;
  if (!row || !control) return; // no head script, no switch: the page just follows the system
  const buttons = row.querySelectorAll('[data-appearance]');
  const mark = () => {
    const current = control.get();
    buttons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.appearance === current)));
  };
  buttons.forEach((btn) =>
    btn.addEventListener('click', () => {
      control.set(btn.dataset.appearance);
      mark();
    }),
  );
  mark();
  show(row);
}

// --- Refresh on resume -----------------------------------------------------

// Installed PWAs (especially iOS) resume a *frozen* webview instead of reloading, so the initial
// render can be hours or days stale — and standalone mode has no pull-to-refresh or refresh
// button. Re-fetch whenever the app returns to the foreground. The service worker is network-first,
// so this transparently gets fresh data when online and falls back to cache when offline.
let swRegistration = null;
let lastRefreshAt = Date.now();
const RESUME_REFRESH_MS = 30_000; // throttle: don't refetch on quick app-switches

/**
 * Refetch both sections when the app comes back to the foreground.
 *
 * `force` skips *both* guards. The throttle exists for app-switch chatter — a member flicking
 * between apps should not hammer two API calls per flick — but a tapped notification is a
 * deliberate "show me the new thing", and 30 seconds of stale is the wrong answer to it.
 *
 * The visibility guard has to go too, and that is not cosmetic: the service worker posts its
 * refresh message *before* calling `focus()`, so the page is very often still hidden when the
 * message lands. Keeping the guard would drop precisely the refresh that was asked for, and leave
 * the throttled `visibilitychange` that follows as the only chance of one. A forced refresh is
 * always a tap that is about to foreground this page, so running it a beat early is correct — and
 * it still stamps `lastRefreshAt`, so the `visibilitychange` right behind it is a no-op rather
 * than a second fetch.
 */
async function refreshOnResume({ force = false } = {}) {
  if (!force && document.visibilityState !== 'visible') return;
  if (!force && Date.now() - lastRefreshAt < RESUME_REFRESH_MS) return;
  lastRefreshAt = Date.now();
  // Both sections, because the program is the one whose content is *time*-sensitive: a phone left
  // open through 08:00 on Sunday has to pick the program up without a manual reload. The tab the
  // member is on is left alone — re-running the entry rule under them would be a section swapping
  // itself out mid-read.
  await Promise.all([renderAnnouncements(), renderProgram(), renderResources()]);
  pruneSavedImages();
  if (swRegistration) {
    // Force a service-worker update check. A frozen/resumed PWA never navigates, so without this
    // it would never notice a new deploy. If sw.js changed, the new worker installs and calls
    // skipWaiting(); the controllerchange handler in main() then reloads to pick up new assets.
    swRegistration.update().catch(() => {
      /* offline or check failed — retry on the next resume */
    });
    // Keep the subscribe button state honest too (cheap; only once push is wired up).
    try {
      await refreshSubscriptionUI(swRegistration);
    } catch {
      /* non-fatal — the next resume will retry */
    }
  }
}

// visibilitychange covers the common foreground/resume case; pageshow(persisted) covers a bfcache
// restore (some Android browser installs) where visibilitychange may not fire; `focus` covers the
// desktop case of a tab that was never hidden but was sitting behind another window. All three are
// wrapped rather than passed directly, so the event object can't be read as an options bag.
document.addEventListener('visibilitychange', () => refreshOnResume());
window.addEventListener('focus', () => refreshOnResume());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) refreshOnResume();
});

// The service worker asks for this when a notification is tapped into an already-open window: that
// path may not reload the page at all (`/` → `/#announcements` is a same-document fragment
// navigation), so without it the member can land on announcements that predate the push telling
// them to come look.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'refresh') refreshOnResume({ force: true });
  });
}

// Does the worker now in control belong to a different build than this page?
//
// Answers `true` whenever it cannot tell — no meta tag, no controller, no reply within a couple of
// seconds — because reloading is the safe default: a needless reload is a flash,
// a skipped one is a member running stale code until their next visit.
function controllerHasOtherBuild() {
  const meta = document.querySelector('meta[name="build-id"]');
  const mine = meta && meta.content;
  const controller = navigator.serviceWorker.controller;
  if (!mine || !controller || typeof MessageChannel === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(true), 2000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const theirs = event.data && event.data.buildId;
      resolve(!theirs || theirs !== mine);
    };
    try {
      controller.postMessage({ type: 'build-id' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(true);
    }
  });
}

// --- Boot ------------------------------------------------------------------

async function main() {
  setupDismissibleCards();
  initLightbox(); // before the first render, so the earliest thumbnail tap already works
  initTabs();
  initShare(); // before the service-worker early-returns below: sharing works without push
  initAppearance();

  // The entry rule, decided once per cold load: a plain `/` (the QR code's URL) opens on the
  // program while there is one to read, and on the announcements the rest of the week. An explicit
  // `#program` / `#announcements` always wins — someone who followed a link asked for a section.
  const wanted = tabFromHash();
  if (wanted) showTab(wanted, { updateHash: false });
  Promise.all([renderAnnouncements(), renderProgram(), renderResources()]).then(() => {
    pruneSavedImages();
    // `updateHash: false` deliberately: the automatic choice must not be written into the URL, or a
    // member who opened on Sunday would carry `#program` into every later visit and land on the
    // closed message all week. Only a tap the member made is worth remembering.
    if (!tabFromHash()) showTab(programOpen ? 'program' : 'announcements', { updateHash: false });
  });

  if (!('serviceWorker' in navigator)) {
    setStatus("This browser doesn't support notifications.");
    return;
  }

  let registration;
  try {
    registration = await withTimeout(
      navigator.serviceWorker.register('/sw.js'),
      PUSH_CALL_TIMEOUT_MS,
      'Registering the service worker',
    );
    swRegistration = registration; // let refreshOnResume re-check the subscribe state + updates
  } catch {
    setStatus('Could not set up notifications in this browser.');
    return;
  }

  // Silent updates: when an updated service worker takes control (it calls skipWaiting() on
  // install), reload once to pick up the new index.html/app.js/styles.css. Guarded against reload
  // loops. Only wired when the page already had a controller — a first-ever install must not reload
  // on launch (there's no prior version to replace, and controllerchange fires on that first claim).
  //
  // But only when this page is actually stale. The worker is network-first, so a cold open fetches
  // the *current* shell from the server — and then the update check finds the new sw.js and
  // installs it, and reloading here would refresh a page that is already fresh: a second flash for
  // a member reopening the app after a deploy. The page carries its own build id (see
  // index.html); ask the new controller for its, and reload only if they differ. A resumed page
  // whose assets predate the deploy still reloads, which is the case this exists for.
  if (navigator.serviceWorker.controller) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (reloading) return;
      if (!(await controllerHasOtherBuild())) return;
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  // On iOS, push only works from the installed (standalone) home-screen app. Even if a future
  // Safari exposed the Push APIs in a regular tab, a subscription created there wouldn't stick —
  // so always route a non-standalone iOS visitor to "install first", independent of feature
  // detection. This keeps the Enable button hidden/unwired in a Safari tab (no dead-button tap).
  // The install card + bottom-sheet (install.js) shows how to add to the home screen.
  if (isiOS && !isStandalone) {
    // On iOS, notifications require the installed home-screen app, so the only actionable step
    // here is the "Add to Home Screen" card above. The notification opt-in would just repeat
    // "install first" — hide it. It reappears (with the Enable button) once the app is opened
    // from the home screen and runs standalone.
    hide(notifyCard);
    return;
  }

  if (!pushSupported) {
    // Android in-app webviews (flagged by install.js) can't subscribe — point them to Chrome,
    // matching the install card's guidance. (iOS in-app is already handled by the guard above.)
    if (document.documentElement.dataset.inApp === 'android') {
      setStatus('Open this page in Chrome to turn on notifications.');
    } else {
      setStatus("This browser doesn't support push notifications.");
    }
    return;
  }

  enableBtn.addEventListener('click', subscribe);
  disableBtn.addEventListener('click', unsubscribe);
  await refreshSubscriptionUI(registration);

  // If a background subscription rotation re-subscribed us but couldn't reach the server, the
  // browser holds a live subscription the server doesn't know about. Re-sync it now we're open.
  try {
    const current = await registration.pushManager.getSubscription();
    // Checked before the re-sync, which would otherwise keep a dead subscription looking healthy.
    const renewed = current && (await renewIfKeyChanged(registration, current));
    if (renewed) {
      const synced = await syncSubscription(registration, renewed.subscription, renewed.oldEndpoint);
      // A reachable server that rejected the POST (e.g. access gate 401) — the browser holds a
      // subscription the server won't record, so pushes won't arrive. Warn without changing the
      // button state. A thrown fetch (offline) never reaches here and stays silent below; a
      // 'blocked' reply has already turned the card off and said so.
      if (synced === false) {
        setStatus(
          "We couldn't confirm your notifications with the server, so weekly updates may not arrive. Try turning notifications off and on again.",
        );
      }
    }
  } catch {
    /* offline; a later visit (or Background Sync) will re-sync */
  }
}

main();
