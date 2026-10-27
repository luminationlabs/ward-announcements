// Install UX. Two shapes, by whether installing is the *required* step or an optional one:
//  - iOS and in-app browsers: push needs the home-screen app (iOS) or a real browser (in-app), so
//    the install card leads and a bottom-sheet gives platform-specific steps (iOS has no install
//    API).
//  - Android/desktop: push works in the tab, so there is no install card at all — just a secondary
//    "Add to Home Screen" button inside the notification card. It fires the native dialog when the
//    browser offered one (`beforeinstallprompt`), and otherwise opens the sheet with the "use your
//    browser's menu" steps, so the path exists even when Chrome withholds the event (it does after
//    an uninstall, and for months after a dismissed dialog).
// Self-contained; coordinates with app.js only through the DOM.
(function () {
  const card = document.getElementById('install-card');
  const homeBtn = document.getElementById('add-home-btn');
  const btn = document.getElementById('install-btn');
  const heading = document.getElementById('install-heading');
  const sub = document.getElementById('install-sub');
  const sheet = document.getElementById('install-sheet');
  const stepsEl = document.getElementById('install-steps');
  const closeBtn = document.getElementById('sheet-close');
  const banner = document.getElementById('installed-banner');
  const bannerDismiss = document.getElementById('installed-dismiss');
  const secondary = document.getElementById('install-secondary');
  const androidNote = document.getElementById('android-blocked-note');
  if (!card || !btn || !sheet) return;

  function safeGet(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function safeSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage may be unavailable (e.g. private mode) */
    }
  }

  const ua = navigator.userAgent;
  const isIOS =
    (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/i.test(ua);
  const isInstalled =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function browser() {
    if (/edg|edgios/i.test(ua)) return 'edge';
    if (/firefox|fxios/i.test(ua)) return 'firefox';
    if (/crios|chrome|chromium/i.test(ua)) return 'chrome';
    if (/safari/i.test(ua)) return 'safari';
    return 'unknown';
  }
  // Safari reports "Version/<major>" (≈ the iOS version); absent in iOS Chrome/Firefox.
  function safariMajor() {
    const m = ua.match(/Version\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // Detect an embedded in-app browser (Facebook, Instagram, etc.). Push — and, on iOS,
  // Add-to-Home-Screen — don't work inside these, so the user must escape to a real browser:
  // Safari on iOS, Chrome on Android. Three signals:
  //  1. Known in-app webview UA tokens (cross-platform).
  //  2. iOS: real Safari always carries a "Version/<n>" token, so an iOS UA that *claims* Safari
  //     (i.e. isn't a recognized third-party browser) yet omits Version/ is almost certainly a
  //     WKWebView — catches in-app browsers (e.g. the Google app) that append "Safari".
  //  3. Android: the "; wv)" UA token marks a System WebView, i.e. an embedded in-app browser.
  //     (Chrome Custom Tabs omit it and behave like real Chrome, so they're correctly excluded.)
  function isInAppBrowser() {
    if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|GSA\/|Twitter|TikTok|musical_ly|Snapchat|LinkedInApp|MicroMessenger|WhatsApp|Pinterest/i.test(ua))
      return true;
    if (isIOS && browser() === 'safari' && !/Version\//.test(ua)) return true;
    return isAndroid && /;\s*wv\s*[;)]/i.test(ua);
  }

  // Publish the in-app verdict for app.js to read (it tailors the notify-card message). DOM-only
  // coordination, per this file's contract. '' = not an in-app browser.
  document.documentElement.dataset.inApp = isInAppBrowser() ? (isIOS ? 'ios' : 'android') : '';

  // Configured app name, published by the server into <html data-app-name>. Escaped before it's
  // interpolated into install-step HTML below (it's deployer config, but escape defensively).
  const escHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const appName = escHtml(document.documentElement.dataset.appName || 'this app');
  // The home-screen icon is labelled with the *short* name (manifest short_name), so that is
  // the name to tell people to look for once it's installed.
  const appShortName = escHtml(document.documentElement.dataset.appShortName || appName);

  const img = (src, alt) => `<img src="/img/install/${src}" alt="${alt}" loading="lazy" />`;

  // iOS 26 and 27 both hide Add to Home Screen behind a Safari menu, and the share sheet that
  // follows is identical on the two — only the button that opens the menu differs, so the flow is
  // built from a per-version first step plus these shared ones.
  const menuFlow = (firstStep) => `
      <p class="muted">On iOS, <strong>Add to Home Screen</strong> can be found inside the Safari menu:</p>
      <ol class="shot-steps">
        ${firstStep}
        <li><span><strong>2.</strong> Tap <strong>Share</strong>.</span>
          <img class="shot" src="/img/install/ios-26-share-2.svg" alt="" loading="lazy" /></li>
        <li><span><strong>3.</strong> Tap <strong>View More</strong>.</span>
          <img class="shot" src="/img/install/ios-26-share-3.svg" alt="" loading="lazy" /></li>
        <li><span><strong>4.</strong> Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong> — then open the app and tap <strong>Enable Notifications</strong>.</span>
          <img class="shot" src="/img/install/ios-26-share-4.svg" alt="" loading="lazy" /></li>
      </ol>`;

  // Escaping to a real browser needs a link that still opens the app once it gets there. The
  // address bar can't supply one: the credential this page was unlocked with rode in the fragment
  // and was scrubbed on arrival (app.js), because a fragment left there leaks through every share
  // and bookmark — and the other browser keeps its own cookies. So "Open in Safari", from the
  // in-app browser's menu or anywhere else, used to land the member on the locked page, and on
  // iOS that page is the only road to notifications. The button below copies a fresh invite
  // instead, minted exactly as Share With Someone mints one. (iOS 17's `x-safari-https://` scheme
  // would open Safari directly, but it is undocumented and unconfirmed from inside in-app
  // browsers, so the member pastes the link themselves.)
  const copyLink = (where) => `
      <div class="actions"><button class="btn primary copy-link" type="button" data-copy-link>Copy Link for ${where}</button></div>`;

  const templates = {
    // Classic iOS Safari (≤ 18): Share → Add to Home Screen.
    iosSafari: `
      <p class="muted">On iPhone &amp; iPad, notifications work once the app is on your home screen.</p>
      <ol class="install-steps-list">
        <li>${img('ios-share.svg', 'Share')}<span><strong>1.</strong> Tap <strong>Share</strong> in Safari's toolbar.</span></li>
        <li>${img('add-to-home-screen.svg', 'Add to Home Screen')}<span><strong>2.</strong> Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</span></li>
        <li><span><strong>3.</strong> Open <strong>${appShortName}</strong> from your home screen, then tap <strong>Enable Notifications</strong>.</span></li>
      </ol>`,
    // iOS 26 Safari moved Add to Home Screen behind the ••• button at the bottom-right.
    ios26Safari: menuFlow(`
        <li><span><strong>1.</strong> Tap the <strong>•••</strong> (three dots) at the bottom-right.</span>
          <img class="shot" src="/img/install/ios-26-share-1.svg" alt="" loading="lazy" /></li>`),
    // iOS 27 Safari turned that bottom-right button into Tabs, so the menu holding Share is now
    // the page menu at the left end of the address bar (touch-and-hold the bar reaches it too).
    ios27Safari: menuFlow(`
        <li><span><strong>1.</strong> Tap the <strong>page menu</strong> — the small lines at the left of the address bar.</span>
          <img class="shot" src="/img/install/ios-27-share-1.svg" alt="" loading="lazy" /></li>`),
    // Any non-Safari browser on iOS: push needs a Safari install. "Open this page in Safari" is
    // not a step that works — see copyLink() — so the first step is the link that does.
    iosOther: `
      <p><strong>Open this page in Safari first.</strong> On iPhone &amp; iPad, notifications only
      work for apps installed from <strong>Safari</strong>.</p>
      ${copyLink('Safari')}
      <ol class="install-steps-list">
        <li><span><strong>1.</strong> Tap <strong>Copy Link for Safari</strong> above.</span></li>
        <li><span><strong>2.</strong> Open <strong>Safari</strong>, tap the address bar and paste the link.</span></li>
        <li>${img('ios-share.svg', 'Share')}<span><strong>3.</strong> Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</span></li>
      </ol>`,
    // Inside another app's in-app browser (Facebook, Instagram, …): you can't install here at
    // all. The app's own "Open in Safari" would hand Safari the bare address, which is locked
    // there, so the member carries a working link across instead.
    iosInApp: `
      <p><strong>Open this page in Safari first.</strong> You&rsquo;re viewing this inside another
      app&rsquo;s built-in browser, where notifications can&rsquo;t be turned on.</p>
      ${copyLink('Safari')}
      <ol class="install-steps-list">
        <li><span><strong>1.</strong> Tap <strong>Copy Link for Safari</strong> above.</span></li>
        <li><span><strong>2.</strong> Open <strong>Safari</strong>, tap the address bar and paste the link.</span></li>
        <li>${img('ios-share.svg', 'Share')}<span><strong>3.</strong> In Safari, tap <strong>Share</strong> &rarr; <strong>Add to Home Screen</strong>.</span></li>
      </ol>`,
    // Android in-app browser: push needs a real browser. No install required once in Chrome —
    // notifications work in a normal tab — so just get them out of the webview, with a link that
    // still opens the app once they're there.
    androidInApp: `
      <p><strong>Open this page in Chrome first.</strong> You&rsquo;re viewing this inside another
      app&rsquo;s built-in browser, where notifications can&rsquo;t be turned on.</p>
      ${copyLink('Chrome')}
      <ol class="install-steps-list">
        <li><span><strong>1.</strong> Tap <strong>Copy Link for Chrome</strong> above.</span></li>
        <li><span><strong>2.</strong> Open <strong>Chrome</strong>, tap the address bar and paste the link.</span></li>
        <li><span><strong>3.</strong> On the page that opens, tap <strong>Enable Notifications</strong>.</span></li>
      </ol>`,
    // Android Chrome/Samsung when the browser didn't offer a native dialog: the menu entry is
    // always there, whatever Chrome's install heuristics decided about this visit.
    android: `
      <p class="muted">Adds a home-screen icon for quick access. Notifications work without it.</p>
      <ol class="install-steps-list">
        <li><span><strong>1.</strong> Tap the <strong>⋮</strong> menu at the top-right of Chrome.</span></li>
        <li><span><strong>2.</strong> Choose <strong>Add to Home screen</strong> (or <strong>Install app</strong>), then <strong>Install</strong>.</span></li>
      </ol>`,
    generic: `
      <p class="muted">Open your browser's menu and choose <strong>Install app</strong> or
      <strong>Add to Home Screen</strong>.</p>`,
  };

  function pickTemplate() {
    if (isInAppBrowser()) return isIOS ? templates.iosInApp : templates.androidInApp;
    if (!isIOS) return isAndroid ? templates.android : templates.generic;
    if (browser() !== 'safari') return templates.iosOther;
    const major = safariMajor();
    if (major >= 27) return templates.ios27Safari;
    return major >= 26 ? templates.ios26Safari : templates.iosSafari;
  }

  // One invite per page view, however often the sheet is opened (as app.js's share sheet does). A
  // failed mint is forgotten, so the next tap tries again.
  let invite = null;
  function getInvite() {
    if (!invite) {
      invite = fetch('/api/invite', { method: 'POST' })
        .then((res) => {
          if (!res.ok) throw new Error('invite failed');
          return res.json();
        })
        .catch((err) => {
          invite = null;
          throw err;
        });
    }
    return invite;
  }

  function wireCopyLink() {
    const copyBtn = stepsEl.querySelector('[data-copy-link]');
    if (!copyBtn) return;
    // Mint as the sheet opens, not on the tap: Safari only lets a page write the clipboard close
    // to the tap that asked, and a network round trip in between can use that up.
    getInvite().catch(() => {});
    copyBtn.addEventListener('click', async () => {
      copyBtn.disabled = true;
      try {
        const { url } = await getInvite();
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = 'Copied ✓';
        } catch {
          copyBtn.textContent = url; // no clipboard access: show it to copy by hand
        }
      } catch {
        copyBtn.textContent = "Couldn't create a link — try again";
      } finally {
        copyBtn.disabled = false;
      }
    });
  }

  function openSheet() {
    stepsEl.innerHTML = pickTemplate();
    wireCopyLink();
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    safeSet('install-sheet-opened', '1');
  }
  function closeSheet() {
    sheet.hidden = true;
    document.body.style.overflow = '';
  }

  // Bring the notification opt-in into view and nudge its Enable button. Used for a #install
  // request on browsers where no home-screen install is needed (desktop, Android Chrome, macOS
  // Safari) — push works in the tab, so we send the user straight to subscribing instead of the
  // install instructions. app.js reveals the Enable button asynchronously, so focus it slightly
  // later, only if it's actually showing.
  function focusSubscribe() {
    const notify = document.getElementById('notify-card');
    if (!notify) return;
    notify.scrollIntoView({ behavior: 'smooth', block: 'center' });
    notify.classList.add('attention');
    setTimeout(() => notify.classList.remove('attention'), 2400);
    const enable = document.getElementById('enable-btn');
    setTimeout(() => {
      if (enable && !enable.hidden) enable.focus();
    }, 500);
  }

  closeBtn.addEventListener('click', closeSheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet();
  });
  if (bannerDismiss) {
    bannerDismiss.addEventListener('click', () => {
      banner.hidden = true;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  // Android / desktop: the optional install lives on the notification card as a secondary button.
  // Reveal it when the browser offers a native dialog, and on Android regardless (see below).
  let deferredPrompt = null;
  function showHomeButton() {
    if (!homeBtn || isInstalled) return;
    homeBtn.hidden = false;
    // Android (Chrome/Samsung) installs go through a Google-minted WebAPK, which can trip a
    // "Unsafe app blocked" Play Protect warning. Surface the reassurance note only there.
    if (androidNote && isAndroid) androidNote.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    // Where the install card leads (iOS, in-app browsers) its button must keep opening the
    // instructions sheet: those environments don't fire this, but if one ever did, a stored
    // prompt would silently replace the steps the card promises.
    if (isIOS || isInAppBrowser()) return;
    deferredPrompt = e;
    showHomeButton();
  });
  window.addEventListener('appinstalled', () => {
    card.hidden = true;
    if (homeBtn) homeBtn.hidden = true;
    if (androidNote) androidNote.hidden = true;
    deferredPrompt = null;
  });

  // One tap: the native dialog if the browser offered one, else the instructions sheet. A
  // deferred prompt can only be used once, so a dismissed dialog falls through to the sheet on
  // the next tap rather than to a dead button.
  async function install() {
    if (deferredPrompt) {
      const p = deferredPrompt;
      deferredPrompt = null;
      try {
        p.prompt();
        const choice = await p.userChoice;
        if (choice && choice.outcome === 'accepted' && homeBtn) homeBtn.hidden = true;
        return;
      } catch {
        // Chrome throws on a stale event (already prompted, or the user activation has lapsed).
        // Fall through in the same tap rather than spending one on nothing.
      }
    }
    openSheet();
  }
  btn.addEventListener('click', install);
  if (homeBtn) homeBtn.addEventListener('click', install);

  // An external entry point can request the install instructions by linking to the app with a
  // #install fragment. Strip the fragment so a refresh doesn't re-trigger; the
  // sheet (or subscribe focus) is opened once at the end. A plain direct visit never auto-opens
  // the sheet — only this explicit request and the install card's button do.
  const wantsInstall = location.hash === '#install';
  if (wantsInstall) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      /* history may be restricted; harmless */
    }
  }

  // Initial state.
  if (isInstalled) {
    card.hidden = true;
    // One-time welcome the first time the app is launched from the home screen.
    if (banner && !safeGet('installed-welcomed')) {
      safeSet('installed-welcomed', '1');
      banner.hidden = false;
    }
  } else if (isIOS) {
    if (isInAppBrowser()) {
      heading.textContent = '🔔 Open in Safari for Notifications';
      sub.textContent =
        "You're in another app's browser. Copy a link to open in Safari, where notifications work.";
      btn.textContent = 'How to Install';
    } else if (browser() === 'safari') {
      heading.textContent = '🔔 Get Weekly Notifications';
      sub.textContent = 'Add the app to your home screen to start receiving them.';
      btn.textContent = 'Show Me How';
      // Once they've opened the sheet at least once, surface the "already added it?" hint.
      // (We can't detect an existing install from Safari on iOS, so this is shown to everyone
      //  who's seen the steps — the conditional wording is correct either way.)
      if (secondary && safeGet('install-sheet-opened')) {
        secondary.hidden = false;
      }
    } else {
      heading.textContent = '🔔 Open in Safari for Notifications';
      sub.textContent = 'Notifications need the app installed from Safari.';
      btn.textContent = 'How to Install';
    }
    card.hidden = false;
  } else if (isInAppBrowser()) {
    // Android in-app browser (Facebook, Instagram, …): push needs a real browser, and
    // beforeinstallprompt won't fire here — so surface the "open in Chrome" steps ourselves.
    heading.textContent = '🔔 Open in Chrome for Notifications';
    sub.textContent =
      "You're in another app's browser. Copy a link to open in Chrome, where notifications work.";
    btn.textContent = 'How to Open in Chrome';
    card.hidden = false;
  } else if (isAndroid) {
    // Android in a real browser: the menu always has Add to Home screen, so offer the button now
    // rather than waiting on `beforeinstallprompt`, which Chrome withholds after an uninstall and
    // for months after a dismissed dialog. If the event does fire, the same button gains the
    // one-tap native dialog.
    showHomeButton();
  }
  // Desktop stays without a button until beforeinstallprompt fires (its menus vary too much for
  // generic steps to be worth a button); the install card never shows there.

  // Honor a #install request once platform state is set up. Home-screen install is only *required*
  // for notifications on iOS; escaping an in-app browser is required on any platform. Only those
  // cases get the instructions sheet — everywhere else push works in the current tab, so we send
  // the user straight to the subscribe card.
  if (wantsInstall) {
    const needsSheet = isIOS ? !isInstalled : isInAppBrowser();
    if (needsSheet) openSheet();
    else focusSubscribe();
  }
})();
