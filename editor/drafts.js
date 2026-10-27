// Unsaved work: a form's changes kept on this device until the server confirms it saved them.
//
// Its own module, apart from the editor, so test/editor-drafts.test.js can run it against a stub
// document in Node. It touches the page only through the browser globals (`document`,
// `localStorage`, `location`, `addEventListener`), read at call time.

export const DRAFT_PREFIX = 'ward-draft:';
const DRAFT_MAX_AGE = 14 * 24 * 60 * 60 * 1000;

/**
 * The query parameter a redirect-after-save carries: the action of the form that was saved, which
 * is the draft's key (src/app.ts, `savedParam`). The admin layout's script clears the draft on any
 * page the save lands on (the dashboard has no editor); `protectDraft` honours it too, because an
 * editor page that is itself the landing page runs before the layout's script does.
 */
export const SAVED_PARAM = 'saved';

/**
 * Keep a form's unsaved changes on this device until it is saved.
 *
 * Every change is written to localStorage (and flushed when the page is hidden, which is the moment
 * a phone may discard it), keyed by the form's action so a rejected save — re-rendered at the same
 * action — finds its own draft. On the next visit a draft that differs from what the server sent is
 * offered back. iOS Safari ignores `beforeunload`, so the stored draft is the protection that works
 * there; the leave-page prompt is a bonus on browsers that honour it.
 *
 * Submitting the form marks the draft submitted; it is not deleted until the page the save
 * redirects to says it landed (`?saved=`). It used to be deleted on submit, and a save that never
 * arrived — the connection dropped, the session had expired and the sign-in went to the dashboard,
 * the body was too large — took the clerk's only copy with it.
 */
export function protectDraft(form, before, restoreBody) {
  const action = form.getAttribute('action') || location.pathname;
  const key = DRAFT_PREFIX + action;
  const fields = () =>
    [...form.elements]
      .filter((el) => el.name && !['hidden', 'submit', 'button', 'file', 'password'].includes(el.type))
      .map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]);
  const snapshot = () => JSON.stringify(fields());
  const initial = snapshot();
  let submitting = false;
  let timer = null;

  const store = {
    get() {
      try {
        return JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage full or blocked: nothing more can be done here */
      }
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };

  function save() {
    clearTimeout(timer);
    timer = null;
    if (submitting) return;
    const now = snapshot();
    if (now === initial) store.clear();
    else store.set({ savedAt: Date.now(), base: initial, fields: JSON.parse(now) });
  }
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  addEventListener('pagehide', save);
  // Back from a failed submission (an offline error page, say) can restore this page from the
  // back-forward cache with `submitting` still set; the work on screen is unsaved again.
  addEventListener('pageshow', (e) => {
    if (e.persisted) submitting = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  // On the document, so the Delete button — which submits a *different* form — is not met with "you
  // have unsaved changes" on its way out either. Bubble phase, after the admin layout's capture-phase
  // `data-confirm` listener: a cancelled "Are you sure?" has prevented the submit by then, and must
  // leave the page protected as it was.
  document.addEventListener('submit', (e) => {
    if (e.defaultPrevented) return;
    submitting = true;
    clearTimeout(timer);
    if (e.target !== form) return;
    const now = snapshot();
    if (now === initial) store.clear();
    else store.set({ savedAt: Date.now(), submittedAt: Date.now(), base: initial, fields: JSON.parse(now) });
  });
  addEventListener('beforeunload', (e) => {
    if (submitting || snapshot() === initial) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // --- Offer back a draft left from last time ----------------------------------
  let draft = store.get();
  if (draft?.submittedAt && savedHere(action)) {
    store.clear();
    draft = null;
  }
  if (draft && Date.now() - draft.savedAt > DRAFT_MAX_AGE) store.clear();
  else if (draft && JSON.stringify(draft.fields) !== initial) {
    const banner = document.createElement('div');
    banner.className = 'draft-banner';
    banner.setAttribute('role', 'status');
    const when = new Date(draft.savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const text = document.createElement('span');
    text.textContent =
      (draft.submittedAt
        ? `Changes you tried to save ${when} may not have reached the server. They were kept on this device.`
        : `Unsaved changes from ${when} were kept on this device.`) +
      (draft.base !== initial ? ' The saved version has changed since then.' : '');
    const restore = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small primary', textContent: 'Restore' });
    const discard = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Discard' });
    restore.addEventListener('click', () => {
      const byName = new Map(draft.fields);
      for (const el of form.elements) {
        if (!byName.has(el.name) || el.name === 'body') continue;
        if (el.type === 'checkbox') el.checked = !!byName.get(el.name);
        else el.value = byName.get(el.name);
      }
      if (byName.has('body')) restoreBody(byName.get('body'));
      banner.remove();
      save();
    });
    discard.addEventListener('click', () => {
      store.clear();
      banner.remove();
    });
    banner.append(text, restore, discard);
    form.insertBefore(banner, form.firstChild);
  }

  return { changed };
}

/** This page is where a save of the form at `action` redirected to. */
function savedHere(action) {
  try {
    return new URLSearchParams(location.search).get(SAVED_PARAM) === action;
  } catch {
    return false;
  }
}
