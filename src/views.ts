import type {
  AccessCodeRow,
  AdminPasskeyRow,
  AdminUserListRow,
  AdminUserRow,
  AnnouncementRow,
  PageRow,
  AttachmentRow,
  ProgramListRow,
  ProgramRow,
  SendHistoryRow,
  SendSkipRow,
  SubscriptionRow,
} from './db.js';
import { localToday } from './db.js';
import { config } from './config.js';
import { renderMarkdown } from './markdown.js';
import { automaticClosedMessage, type ProgramSettings } from './programs.js';
import { DEFAULT_WEEKLY_TITLE, clockLabel } from './schedule-core.js';
import {
  EARLIEST_MEETING,
  LATEST_MEETING,
  PROGRAM_LEAD_MINUTES,
  PROGRAM_TAIL_MINUTES,
  deriveTiming,
  timingSentence,
  type MeetingTime,
  type TimingStatus,
} from './meeting.js';
import { themeHeadScript } from './theme.js';
import { scriptTag } from './csp.js';
import { MAX_PDF_BYTES } from './filestore.js';
import type { Role, Who } from './auth.js';
import type { WARD_LIMITS, WardSettings } from './ward-settings.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/**
 * Open Graph / Twitter Card tags, for the preview bubble a chat app draws when a member pastes the
 * access link.
 *
 * Only ever rendered on the two *public* faces — the app shell and the gate page. The admin and
 * editor pages deliberately get none: those links go to one or two clerks, and a forwarded preview
 * announcing "… Admin" is an invitation, not a feature.
 *
 * Safe by construction: the credential in a shared link rides in the fragment (`#code=`), which a
 * browser never sends, so an unfurler's fetch arrives credential-less and is answered by the gate.
 * The preview can therefore never contain announcement text or a member's name — see the comment
 * above `POST /api/access` in app.ts.
 *
 * The description is APP_DESCRIPTION, *not* the gate message. They read to different people: the
 * gate message addresses someone who is stuck outside ("open the link you were given"), while this
 * is seen by someone holding a link that is about to work, and should say what the app is.
 *
 * `og:image` is emitted only when PUBLIC_ORIGIN is set, because the spec requires an absolute URL
 * and every major unfurler drops a relative one. Dev (where it is unset) simply gets no image
 * rather than a broken tag.
 */
export function socialMeta(): string {
  const origin = config.publicOrigin;
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(config.appName)}" />`,
    `<meta property="og:title" content="${escapeHtml(config.appName)}" />`,
    `<meta property="og:description" content="${escapeHtml(config.appDescription)}" />`,
  ];
  // The bare origin, never the requested URL: echoing the latter would put a `?code=` credential
  // into the preview markup, and from there into the chat transcript of everyone in the thread.
  if (origin) tags.push(`<meta property="og:url" content="${escapeHtml(origin)}/" />`);
  if (origin) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(origin)}/icons/og-card.png" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${escapeHtml(config.appName)}" />`,
    );
  }
  // summary_large_image only when there is an image to be large; otherwise the card renders as a
  // blank banner on the platforms that read this.
  tags.push(
    `<meta name="twitter:card" content="${origin ? 'summary_large_image' : 'summary'}" />`,
  );
  return tags.join('\n  ');
}


/**
 * The same favicon links `public/index.html` carries. The server-rendered pages (admin, editor,
 * the gate) are not that file, and without these a browser falls back to `/favicon.ico`, which
 * this app does not serve — so the tab showed a blank mark.
 */
const FAVICON_LINKS = `<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
  <link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48.png" />`;

function layout(
  title: string,
  body: string,
  opts: { showLogout?: boolean; head?: string; bodyEnd?: string; role?: Role | null; wide?: boolean } = {},
): string {
  // What this login is called, everywhere the page names itself. An editor's dashboard is missing
  // most of the settings, and saying so in the header is what turns "where did the backup button
  // go?" into "ah, I'm signed in as an editor".
  const area = opts.role === 'editor' ? 'Editor' : 'Admin';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)} · ${escapeHtml(config.appName)} ${area}</title>
  ${FAVICON_LINKS}
  <link rel="stylesheet" href="/styles.css" />
  ${opts.head ?? ''}
</head>
<body class="admin${opts.wide ? ' admin-wide' : ''}">
  <header class="site-header admin-bar">
    <a href="/admin" class="admin-home"><span class="admin-ward">${escapeHtml(config.appName)}</span><span
        class="admin-ward-short">${escapeHtml(config.appShortName)}</span>
      <span class="admin-area">${area}</span></a>
    ${
      opts.showLogout
        ? `<div class="admin-bar-actions"><a class="btn small" href="/admin/me">Account</a>
      <form method="post" action="/admin/logout"><button class="btn small">Log Out</button></form></div>`
        : ''
    }
  </header>
  <main>
${body}
  </main>
  ${scriptTag()}
    // "Are you sure?" for a form marked data-confirm="…": one listener for every such form, because
    // the Content Security Policy (src/csp.ts) refuses inline onsubmit handlers. The question is an
    // attribute the page escapes like any other, read as text — never a script, which is what the
    // inline handler this replaced made a person's name into (test/confirm.test.js).
    // Once a form is on its way, its submit buttons go dark: a second tap on a slow connection
    // used to post the form twice (two announcements, two notifications). Deferred past the
    // dispatch so a listener that takes the submit over (preventDefault) is honoured, and so a
    // disabled button is not dropped from what is sent. Back from the result (the bfcache) brings
    // the page back as it was left, buttons disabled, so pageshow switches them on again.
    function submitButtons(form) {
      return form && form.querySelectorAll ? form.querySelectorAll('button[type=submit],button:not([type])') : [];
    }
    document.addEventListener('submit', function (event) {
      var form = event.target;
      var question = form && form.getAttribute && form.getAttribute('data-confirm');
      if (question && !window.confirm(question)) {
        event.preventDefault();
        return;
      }
      setTimeout(function () {
        if (event.defaultPrevented) return;
        submitButtons(form).forEach(function (button) {
          button.disabled = true;
          button.setAttribute('data-submitting', '');
        });
      }, 0);
    }, true);
    window.addEventListener('pageshow', function () {
      document.querySelectorAll('button[data-submitting]').forEach(function (button) {
        button.disabled = false;
        button.removeAttribute('data-submitting');
      });
    });
    // The flash message is delivered via ?msg=... and rendered above. Strip it from the URL so a
    // refresh (or bookmark/back) doesn't re-show a stale message.
    // ?saved=<form action> rides along on a content save's redirect: the save landed, so the editor's
    // copy of it kept on this device (editor/drafts.js, keyed by that action) can go — but only one
    // marked submitted, never newer typing in another tab.
    // ?out=1 is where Log Out lands (the login page): every draft on this device goes, saved or
    // not — a program's names included — because the next person at this computer may not be an
    // admin at all. Only here, by that flag: a session that expired mid-edit redirects to the login
    // page *without* it, and keeps the draft to offer back after signing in.
    (function () {
      var u = new URL(window.location.href);
      var saved = u.searchParams.get('saved');
      if (saved) {
        try {
          var key = 'ward-draft:' + saved;
          var draft = JSON.parse(localStorage.getItem(key) || 'null');
          if (draft && draft.submittedAt) localStorage.removeItem(key);
        } catch (e) { /* no storage: nothing was kept */ }
      }
      if (u.searchParams.has('out')) {
        try {
          var gone = [];
          for (var i = 0; i < localStorage.length; i++) {
            var name = localStorage.key(i);
            if (name && name.indexOf('ward-draft:') === 0) gone.push(name);
          }
          gone.forEach(function (name) { localStorage.removeItem(name); });
        } catch (e) { /* no storage: nothing was kept */ }
      }
      if (u.searchParams.has('msg') || u.searchParams.has('saved') || u.searchParams.has('out')) {
        u.searchParams.delete('msg');
        u.searchParams.delete('saved');
        u.searchParams.delete('out');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    })();
  </script>
  ${opts.bodyEnd ?? ''}
</body>
</html>`;
}

/**
 * `next` is where to go once signed in — already checked by `adminReturnPath` (src/auth.ts), so it
 * is a dashboard path of this site; both ways of signing in carry it.
 */
export function loginPage(error?: string, ownerSignIn = true, next?: string): string {
  // Passkeys first: that is how everyone the owner has added signs in. The owner's password sits
  // folded underneath — it is the way in on a fresh deployment and the way back if every passkey is
  // lost, not something to hand around — and opens by itself after a wrong password.
  return layout(
    'Sign In',
    `    <section class="card">
      <h2>Sign In</h2>
      <p class="muted small">Use the passkey on this phone or computer — Face ID, a fingerprint or
      your screen lock. New here? Ask an administrator for an invite link.</p>
      <div class="actions">
        <button class="btn primary" type="button" id="passkey-signin">Sign In with a Passkey</button>
      </div>
      <p class="small" id="passkey-status" role="status" aria-live="polite"></p>
      ${
        // A ward with no owner password is run entirely by people with passkeys (see `hasOwner`).
        ownerSignIn
          ? `<details class="owner-login"${error ? ' open' : ''}>
        <summary>Owner Sign-In</summary>
        ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
        <form method="post" action="/admin/login" class="admin-form">
          ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}" />` : ''}
          <label for="password">Owner password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <div class="actions" style="margin-top:1rem">
            <button class="btn" type="submit">Sign In</button>
          </div>
        </form>
      </details>`
          : ''
      }
    </section>`,
    {
      // The sign-in and invite pages are the ones a stranger can reach, so they carry the
      // not-official line too (as body children, like the gate page's footer).
      bodyEnd: `${siteFooter()}
  <script src="/vendor/passkey.js"></script>
  ${scriptTag()}
    (function () {
      var button = document.getElementById('passkey-signin');
      var status = document.getElementById('passkey-status');
      if (typeof WardPasskey === 'undefined' || !WardPasskey.supported()) {
        button.disabled = true;
        status.textContent = 'This browser cannot use passkeys. Try Safari or Chrome on your phone.';
        return;
      }
      button.addEventListener('click', function () {
        button.disabled = true;
        status.textContent = '';
        fetch('/admin/passkey/login/options', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (options) { return WardPasskey.startAuthentication({ optionsJSON: options }); })
          .then(function (response) {
            return fetch('/admin/passkey/login/verify', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(response),
            }).then(function (r) { return r.json(); });
          })
          .then(function (result) {
            if (result.ok) location.href = ${JSON.stringify(next ?? '').replace(/</g, '\\u003c')} || result.redirect || '/admin';
            else throw new Error(result.error || 'Sign-in failed.');
          })
          .catch(function (err) {
            // Cancelling the system sheet is not an error worth shouting about.
            status.textContent = err && err.name === 'NotAllowedError'
              ? 'Sign-in was cancelled.'
              : (err && err.message) || 'Sign-in failed.';
            button.disabled = false;
          });
      });
    })();
  </script>`,
    },
  );
}

/** Where an invite link lands: create a passkey on this device, and be signed in. */
export function invitePage(): string {
  return layout(
    'Set Up Your Passkey',
    `    <section class="card">
      <h2>Welcome</h2>
      <p>You have been invited to help with <strong>${escapeHtml(config.appName)}</strong>.</p>
      <p class="muted small">Create a passkey on this phone or computer. It is how you will sign in
      from now on — with Face ID, a fingerprint or your screen lock, and no password to remember. On
      an iPhone it is kept in iCloud Keychain, so a new phone will have it too.</p>
      <div class="actions">
        <button class="btn primary" type="button" id="passkey-create">Create Passkey</button>
      </div>
      <p class="small" id="passkey-status" role="status" aria-live="polite"></p>
    </section>`,
    {
      head: '<meta name="referrer" content="no-referrer" />',
      bodyEnd: `${siteFooter()}
  <script src="/vendor/passkey.js"></script>
  ${scriptTag()}
    (function () {
      var button = document.getElementById('passkey-create');
      var status = document.getElementById('passkey-status');
      var token = new URLSearchParams(location.hash.slice(1)).get('t');
      if (!token) {
        button.disabled = true;
        status.textContent = 'This invite link is incomplete. Ask for the link again.';
        return;
      }
      if (typeof WardPasskey === 'undefined' || !WardPasskey.supported()) {
        button.disabled = true;
        status.textContent = 'This browser cannot create passkeys. Open the link in Safari or Chrome on your phone.';
        return;
      }
      function post(path, body) {
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json(); });
      }
      button.addEventListener('click', function () {
        button.disabled = true;
        status.textContent = '';
        post('/admin/passkey/register/options', { token: token })
          .then(function (options) {
            if (options.error) throw new Error(options.error);
            return WardPasskey.startRegistration({ optionsJSON: options });
          })
          .then(function (response) { return post('/admin/passkey/register/verify', { token: token, response: response }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.error || 'The passkey could not be saved.');
            // The token has been spent; keep it out of the history entry we leave behind.
            history.replaceState(null, '', location.pathname);
            location.href = result.redirect || '/admin';
          })
          .catch(function (err) {
            status.textContent = err && err.name === 'NotAllowedError'
              ? 'That was cancelled. Press the button to try again.'
              : err && err.name === 'InvalidStateError'
                ? 'This device already has a passkey for this site. Go to the sign-in page instead.'
                : (err && err.message) || 'Something went wrong.';
            button.disabled = false;
          });
      });
    })();
  </script>`,
    },
  );
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC, as SQLite stores it) rendered as a plain local-ish date. */
function shortDate(sqlTimestamp: string): string {
  return new Date(`${sqlTimestamp.replace(' ', 'T')}Z`).toLocaleDateString('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The same stamp with the clock time, for anything where *when* on the day matters — the send
 * history above all. SQLite writes `datetime('now')`, which is UTC, so printing the column raw
 * showed an admin in Denver a Sunday digest sent at "14:00" for an 08:00 send, six hours adrift and
 * unlabelled. Everything displayed goes through the ward's configured timezone instead.
 */
function stampLabel(sqlTimestamp: string): string {
  return new Date(`${sqlTimestamp.replace(' ', 'T')}Z`).toLocaleString('en-US', {
    timeZone: config.timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The General Handbook asks any calling-related site a member creates to say it is not an
 * official Church site, so that line is fixed rather than configurable — a deployment that leaves
 * `APP_FOOTER` blank still carries it. `APP_FOOTER` stays as an optional audience note above it.
 * The app shell, the gate, and the sign-in and invite pages use this, and so does the operator page
 * (operator.ts); the dashboard behind them is for clerks only.
 */
export const DISCLAIMER = 'Not an official service of The Church of Jesus Christ of Latter-day Saints.';

export function siteFooter(): string {
  const note = config.appFooter ? `<p class="muted">${escapeHtml(config.appFooter)}</p>` : '';
  return `<footer class="site-footer">${note}<p class="muted">${DISCLAIMER}</p></footer>`;
}

/** Soft gate shown to visitors without a valid access cookie/code. No announcement content. */
export function gatePage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(config.appName)}</title>
  <meta name="description" content="${escapeHtml(config.appDescription)}" />
  <!-- Follows the phone's light/dark setting, or the member's own choice, like the app shell
       (public/index.html). -->
  <meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="#1f3a5f" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#172c48" media="(prefers-color-scheme: dark)" />
  <!-- The member's Auto / Light / Dark choice, set on the app's page (src/theme.ts). -->
  ${themeHeadScript(scriptTag())}
  ${socialMeta()}
  ${FAVICON_LINKS}
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="site-header"><h1>${escapeHtml(config.appName)}</h1></header>
  <main>
    <section class="card">
      <p id="gate-msg">${escapeHtml(message)}</p>
      <!-- Deliberately does NOT suggest tapping a notification: push URLs carry no credential
           (see src/push.ts), so a visitor reading this — who by definition has no valid cookie —
           would land right back here. The home-screen tip usually works, since a cold launch
           replays the start_url device token — but not after an admin revoked all saved access, which
           deletes that token. The installed app then lands here with no address bar to open a
           link in, so it gets the paste field below instead (the script shows it). -->
      <p class="muted" id="gate-help">Open the link or scan the QR code you were given to view
      announcements. If you already added this app to your home screen, open it from there.</p>
      <!-- Shown only in an installed app (standalone). A home-screen app has no address bar, and
           opening a link from Messages or Mail opens Safari, whose cookies are not the app's — so
           pasting the link here is the one way to hand the app itself a new credential. -->
      <form id="gate-paste" class="gate-paste" hidden>
        <label for="gate-paste-input">Paste your ward link</label>
        <div class="gate-paste-row">
          <input id="gate-paste-input" type="text" inputmode="url" autocomplete="off"
                 autocapitalize="off" autocorrect="off" spellcheck="false"
                 placeholder="https://… or the code" />
          <button class="btn primary" type="submit">Open</button>
        </div>
      </form>
    </section>
  </main>
  ${siteFooter()}
  <!--
    Links issued by the app carry their credential in the URL *fragment* (#code= for the shared
    access code, #i= for a member-generated invite). The server never sees a fragment — that's the
    point, it keeps the credential out of proxy logs and out of link-unfurl fetches — so the
    exchange has to happen here: read it, post it to /api/access for a cookie, then reload clean.
  -->
  ${scriptTag()}
    (function () {
      var busy = false;
      var tried = null;
      var msg = document.getElementById('gate-msg');
      var help = document.getElementById('gate-help');
      var form = document.getElementById('gate-paste');
      var input = document.getElementById('gate-paste-input');
      // Launched from the home screen. \`window.navigator\` and a checked \`matchMedia\`, not bare
      // globals: a missing one must read as "not standalone", never throw.
      var standalone =
        !!(window.navigator && window.navigator.standalone) ||
        !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

      // A malformed percent-escape (#code=%zz) makes decodeURIComponent throw. Fall back to the
      // raw value: posting it gets the member the "that link is no longer valid" message, where a
      // thrown decode would strand the page on "Unlocking…" with busy stuck on — dead to every
      // later link in that tab, which is exactly the retry the hashchange listener provides.
      function decode(raw) {
        try {
          return decodeURIComponent(raw);
        } catch (e) {
          return raw;
        }
      }

      // Re-runnable, not a one-shot: a member already sitting on this page who then opens their
      // link in the same tab changes only the fragment, which is a same-document navigation — no
      // reload, no script re-run. Without the hashchange listener the code would land in the
      // address bar and nothing would happen.
      function unlock() {
        var match = /[#&](?:code|i)=([^&]+)/.exec(location.hash);
        if (!match || busy) return;
        // Decode *before* the busy flag is set (see decode()).
        var code = decode(match[1]);
        // Don't re-post a code that just failed: the retry at the end of .catch() re-reads the
        // fragment, and without this a single bad link would loop.
        if (code === tried) return;
        tried = code;
        exchange(code, true);
      }

      // The credential out of whatever the member pasted: a whole link (#code=, #i=, or the
      // ?code= an installed app's own start_url carries) or the bare code. A shared code is
      // printed lower-case in groups of four, so one typed in capitals is lowered; a token is
      // case-sensitive and is passed through as it is.
      function pastedCode(text) {
        var s = String(text || '').replace(/^\\s+|\\s+$/g, '');
        var match = /[#?&](?:code|i)=([^&#\\s]+)/.exec(s);
        if (match) return decode(match[1]);
        if (/^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i.test(s)) return s.toLowerCase();
        return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
      }

      // Where to go once unlocked: this path, minus any ?code=. One that reached this page is by
      // definition not a working credential — the server would have redeemed it and redirected —
      // so it is an installed app's dead start_url token, and carrying it forward is clutter.
      function cleanUrl() {
        var search = location.search.replace(/([?&])code=[^&]*(&|$)/, '$1').replace(/[?&]$/, '');
        // Leading slashes collapse to one, as samePathOnly does for the ?code= redirect: the gate
        // is served at any path, and //evil.example/x here would otherwise be a URL on another site.
        return '/' + location.pathname.replace(/^[\\/\\\\]+/, '') + search;
      }

      function exchange(code, fromFragment) {
        busy = true;
        msg.textContent = 'Unlocking\\u2026';
        help.hidden = true;
        fetch('/api/access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error(String(res.status));
            // Replace rather than reload: drops the credential from the address bar (and from the
            // back button) in the same navigation that loads the unlocked page.
            location.replace(cleanUrl());
          })
          .catch(function (err) {
            busy = false;
            if (err && err.message === '429') {
              // Rate-limited, not rejected: a room full of people unlocking through one network
              // address. The link is fine, so say so, forget that this code was "tried" and go
              // again shortly — with jitter, so the room does not retry in lockstep. A pasted code
              // is retried as itself: there is no fragment to re-read it from.
              if (fromFragment) tried = null;
              msg.textContent = 'Lots of people are joining right now. Trying again in a moment...';
              help.hidden = true;
              setTimeout(
                fromFragment
                  ? unlock
                  : function () {
                      if (!busy) exchange(code, false);
                    },
                5000 + Math.floor(Math.random() * 10000),
              );
              return;
            }
            msg.textContent = 'That link has expired or is no longer valid.';
            if (!fromFragment) {
              help.textContent =
                'Check that you copied the whole link, or ask for a new one \\u2014 anyone with ' +
                'the app can send one from it.';
            } else if (standalone) {
              // Launched from a home-screen icon, yet carrying a fragment: that icon is a Safari
              // *bookmark* of this very page (the gate has no manifest, so "Add to Home Screen"
              // from it saves the URL, fragment and all), not the installed app. It replays the
              // same dead code on every launch, and scanning the QR again in Safari never touches
              // it. Pasting a new link below gets the member in today; removing the icon is the
              // lasting fix, so say both.
              help.textContent =
                'This home-screen shortcut is out of date. Paste a new link below to get in now, ' +
                'or remove it, open the link or scan the QR code in Safari, then add the app to ' +
                'your home screen again from there.';
            } else {
              help.textContent =
                'Ask whoever shared it with you for a new link \\u2014 they can send one from the app.';
            }
            help.hidden = false;
            // A link that arrived while this request was in flight was turned away by the busy
            // flag, and nothing else is coming to consume it. Re-read the fragment now: a code
            // that changed meanwhile is exchanged, and the one that just failed is not (see
            // \`tried\`), so this cannot spin.
            unlock();
          });
      }

      // An installed app that lands here has lost its saved access — an admin issued a new code
      // signing out "everyone, including installed apps", so its start_url token no longer exists —
      // and nothing else on this page can help it:
      // there is no address bar, and a link tapped in Messages opens Safari, whose cookies are
      // not the app's. So it gets the paste field, which goes through the same exchange as a
      // fragment, and stays up after a failure for the next attempt.
      if (standalone && form && input) {
        help.textContent =
          'This app needs your ward link again. Copy the newest link you were sent (from a text ' +
          'or email) and paste it here. Or delete the app from your home screen and add it again ' +
          'from the link in Safari.';
        form.hidden = false;
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          if (busy) return;
          var code = pastedCode(input.value);
          if (!code) {
            msg.textContent = 'That doesn\\u2019t look like a ward link.';
            help.textContent = 'Paste the whole link you were sent \\u2014 it starts with https://.';
            help.hidden = false;
            return;
          }
          exchange(code, false);
        });
      }
      window.addEventListener('hashchange', unlock);
      unlock();
    })();
  </script>
</body>
</html>`;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * 'YYYY-MM-DD' as a readable date, without a timezone shifting it.
 *
 * `program_date` is a *calendar date*, not an instant: parsed as UTC and formatted as UTC, so the
 * 13th reads as the 13th no matter where the admin's browser or the server thinks it is.
 */
function programDateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "Nov 15": a program's date where the weekday and year go without saying (the copy button). */
function programDateShort(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The date as the public Program tab writes it above the program: `app.js`'s `formatProgramDate`
 * (weekday, month, day — no year), pinned to en-US here where the browser's locale is not known.
 */
function programDateHeading(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * A program as the public page will show it, for the dashboard's preview modal.
 *
 * Mirrors what `renderProgram()` in `public/app.js` builds from `/api/program` — the same class
 * names, so the public stylesheet lays it out identically — because this is the only look at a
 * program anyone gets before its window opens. `body` is already-rendered, sanitized program
 * Markdown. The thumbnails are plain links (the dashboard has no lightbox) that open the image in
 * a new tab.
 */
export function programPreviewHtml(p: {
  date: string;
  body: string;
  images: { url: string; pdf?: string }[];
}): string {
  const thumbs = p.images.length
    ? `<div class="thumbs">${p.images
        .map((i) =>
          i.pdf
            ? `<a class="thumb pdf-thumb" href="${escapeHtml(i.pdf)}" target="_blank" rel="noopener" aria-label="Open PDF"><img src="${escapeHtml(i.url)}" alt="" loading="lazy" /><span class="pdf-badge">PDF</span></a>`
            : `<a class="thumb" href="${escapeHtml(i.url)}" target="_blank" rel="noopener" aria-label="View image"><img src="${escapeHtml(i.url)}" alt="" loading="lazy" /></a>`,
        )
        .join('')}</div>`
    : '';
  return `<article class="program"><h2 class="program-date">${escapeHtml(programDateHeading(p.date))}</h2><div class="body">${p.body}</div>${thumbs}</article>`;
}

/**
 * The preview modal for a program and the script that fills it, shared by the dashboard (each
 * row's date opens it) and the edit page (a Preview button in the header). Anything with a
 * `data-program-preview="<id>"` attribute opens it; the markup is fetched fresh each time.
 */
function programPreviewModal(): string {
  return `    <div id="program-preview-modal" class="sheet-backdrop" hidden>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="program-preview-title">
        <div class="sheet-handle"></div>
        <button type="button" class="sheet-close" id="program-preview-close" aria-label="Close">×</button>
        <h2 id="program-preview-title">Program Preview</h2>
        <p class="muted small">The saved program as members will see it on the Program tab.</p>
        <div id="program-preview-body" class="program-stage sheet-body"><p class="muted">Loading…</p></div>
      </div>
    </div>
  ${scriptTag()}
    (function () {
      var modal = document.getElementById('program-preview-modal');
      var closeBtn = document.getElementById('program-preview-close');
      var body = document.getElementById('program-preview-body');
      if (!modal) return;
      var opened = 0;
      var last = null;
      function open(id, trigger) {
        var token = ++opened;
        // Opened from a row's ⋯ menu, the trigger is about to fold away with the menu, so focus
        // goes back to the menu's own button instead.
        var menu = trigger.closest('.row-menu');
        last = menu ? menu.querySelector('summary') : trigger;
        body.innerHTML = '<p class="muted">Loading…</p>';
        // A session that has expired is *redirected* to the login page with a 200, and that page
        // must not be poured into the modal as if it were the program.
        fetch('/admin/programs/' + encodeURIComponent(id) + '/preview/fragment', { headers: { accept: 'text/html' }, cache: 'no-store' })
          .then(function (r) { if (!r.ok || r.redirected) throw new Error(r.redirected ? 'signed out' : 'fetch failed'); return r.text(); })
          .then(function (markup) { if (token === opened) body.innerHTML = markup; })
          .catch(function (err) {
            if (token !== opened) return;
            body.innerHTML = '<p class="muted">' + (err && err.message === 'signed out' ? 'Your session has ended — reload the page and sign in again.' : 'Preview unavailable.') + '</p>';
          });
        modal.hidden = false;
        document.body.style.overflow = 'hidden';
        closeBtn.focus();
      }
      function close() {
        modal.hidden = true;
        document.body.style.overflow = '';
        if (last) last.focus();
      }
      document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-program-preview]');
        if (t) open(t.getAttribute('data-program-preview'), t);
      });
      closeBtn.addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) close(); });
    })();
  </script>
`;
}

/**
 * The dashboard's section pattern, shared by every tab: a Title Case heading *above* its card with
 * the section's actions on the right, an optional one-line help under the heading (the longer
 * explanation folded behind "More"), and the card itself. Before this each card carried its own
 * heading and a paragraph of muted help inside it, and nine of them stacked up read as one wall.
 *
 * The heading is a bare `<h2>` — the quiet note beside it ("drag to reorder") is a sibling, not a
 * child — so a test or a script can still find a section by its exact title.
 */
interface GroupOpts {
  title: string;
  /** An anchor for links that point at this section, e.g. from the Get Started banner. */
  id?: string;
  /** A quiet note beside the title. */
  sub?: string;
  /** Buttons or links on the right of the heading. */
  actions?: string;
  /** One line under the heading. */
  help?: string;
  /** The longer explanation, folded behind "More" at the end of the help line. */
  more?: string;
  body: string;
  /** Extra card classes: `pad` for free-form content, `danger` for the rare destructive actions. */
  card?: string;
  /** Anything that belongs under the card rather than inside it. */
  after?: string;
  /** Its place in the one-column phone layout, where `columns(…, { phoneOrder: true })` asks. */
  phoneOrder?: number;
  /**
   * A header button that unfolds a form in place under the heading ("Send One Now", "+ Add a
   * Person") — a `<details>`, the same as a settings row, so it needs no script.
   */
  reveal?: { label: string; body: string };
}

function group(o: GroupOpts): string {
  return `    <section class="dash-group"${o.id ? ` id="${o.id}"` : ''}${o.phoneOrder ? ` style="--phone-order:${o.phoneOrder}"` : ''}>
      <div class="group-head">
        <h2>${o.title}</h2>${o.sub ? `<span class="group-sub">${o.sub}</span>` : ''}${
          o.actions ? `\n        <div class="group-actions">${o.actions}</div>` : ''
        }${
          o.reveal
            ? `
        <details class="head-reveal">
          <summary class="btn small primary"><span class="when-closed">${o.reveal.label}</span><span class="when-open">Cancel</span></summary>
          <div class="group-card pad head-reveal-body">
      ${o.reveal.body}
          </div>
        </details>`
            : ''
        }
      </div>
      ${o.help ? helpLine(o.help, o.more) : ''}
      <div class="group-card${o.card ? ` ${o.card}` : ''}">
${o.body}
      </div>${o.after ? `\n${o.after}` : ''}
    </section>`;
}

/**
 * A help line, and when there is more to say, a disclosure whose summary *is* that line with a
 * "More" at its end — one tap target, no link nested inside a button.
 */
function helpLine(help: string, more?: string, label = 'More', cls = ''): string {
  if (!more) return `<p class="group-help${cls ? ` ${cls}` : ''}">${help}</p>`;
  return `<details class="group-help${cls ? ` ${cls}` : ''}">
        <summary>${help} <span class="more-label">${label}</span></summary>
        <div class="group-more">${more}</div>
      </details>`;
}

/**
 * One line in a list card: an optional drag handle, the title (a link to the edit page — tapping a
 * row is how you change it), a one-line sub-line, a status pill and the "⋯" menu. Preview and Delete
 * live in the menu rather than as a red button on every line.
 */
function listRow(o: {
  id?: number;
  drag?: boolean;
  href: string;
  title: string;
  sub: string;
  pill: string;
  menu?: string;
}): string {
  return `        <li class="row"${o.id !== undefined ? ` data-id="${o.id}"` : ''}>
          ${o.drag ? '<span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>' : ''}
          <div class="row-main">
            <a class="row-title" href="${o.href}">${o.title}</a>
            <span class="row-sub">${o.sub}</span>
          </div>
          ${o.pill}
          ${o.menu ?? ''}
        </li>`;
}

/**
 * The "⋯" menu: a `<details>`, so it opens by keyboard and touch with no script at all. The script
 * in `dashboardPage` only adds the niceties — one open at a time, closing on an outside click or
 * Escape, and folding away once an item is chosen. `label` is already escaped.
 */
function rowMenu(label: string, items: string[]): string {
  if (!items.length) return '';
  return `<details class="row-menu">
            <summary aria-label="More actions for ${label}" title="More actions"><span aria-hidden="true">⋯</span></summary>
            <div class="menu">
              ${items.join('\n              ')}
            </div>
          </details>`;
}

function deleteItem(action: string, question: string): string {
  return `<form method="post" action="${action}" data-confirm="${question}">
                <button class="menu-item danger" type="submit">Delete</button>
              </form>`;
}

/** A calendar date ('YYYY-MM-DD') as a UTC midnight, or null — see `programDateLabel`. */
function calendarDay(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from one calendar date to another (negative when `to` is earlier). */
function daysBetween(from: string, to: string): number | null {
  const a = calendarDay(from);
  const b = calendarDay(to);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : null;
}

function addDays(date: string, days: number): string {
  const d = calendarDay(date);
  if (!d) return date;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Sat, Oct 31" (or "Oct 31" without the weekday) — with the year only when it is not this one. */
function rowDate(date: string, today: string, weekday = true): string {
  const d = calendarDay(date);
  if (!d) return date;
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...(weekday ? { weekday: 'short' as const } : {}),
    month: 'short',
    day: 'numeric',
    ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  });
}

/** A SQLite UTC timestamp's calendar date in the ward's timezone ('YYYY-MM-DD'). */
function localDateOf(sqlTimestamp: string): string {
  return new Date(`${sqlTimestamp.replace(' ', 'T')}Z`).toLocaleDateString('en-CA', { timeZone: config.timezone });
}

function weekdayShort(date: string): string {
  const d = calendarDay(date);
  return d ? d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }) : date;
}

/** How long an announcement's end date is still ahead to earn an "Ends Sat" pill. */
const ENDS_SOON_DAYS = 6;

/**
 * An announcement's pill and sub-line. A draft is a draft first — what members can see is the
 * question this answers — then an end date already passed, then one coming up this week.
 * `expires_at` is the last day it shows ("Hide after" on the form), so "Ends Sat" means Saturday is
 * its last day.
 */
function announcementState(a: AnnouncementRow, today: string): { pill: string; sub: string } {
  const ends = a.expires_at;
  if (!a.published) {
    return {
      pill: '<span class="badge hidden">Draft</span>',
      sub: `Hidden from members${ends ? ` · ends ${escapeHtml(rowDate(ends, today))}` : ''}`,
    };
  }
  if (!ends) return { pill: '<span class="badge live">Live</span>', sub: 'No end date' };
  if (ends < today) {
    return {
      pill: '<span class="badge expired">Expired</span>',
      sub: `Ended ${escapeHtml(rowDate(ends, today))}`,
    };
  }
  const left = daysBetween(today, ends);
  const pill =
    left !== null && left <= ENDS_SOON_DAYS
      ? `<span class="badge soon">Ends ${left === 0 ? 'Today' : escapeHtml(weekdayShort(ends))}</span>`
      : '<span class="badge live">Live</span>';
  return { pill, sub: `Ends ${escapeHtml(rowDate(ends, today))}` };
}

function announcementsGroup(announcements: AnnouncementRow[], today: string): string {
  const rows =
    announcements
      .map((a) => {
        const { pill, sub } = announcementState(a, today);
        const title = escapeHtml(a.title);
        return listRow({
          id: a.id,
          drag: true,
          href: `/admin/announcements/${a.id}/edit`,
          title,
          sub,
          pill,
          menu: rowMenu(title, [
            `<button type="button" class="menu-item" data-preview="${a.id}" data-preview-title="${title}">Preview</button>`,
            deleteItem(`/admin/announcements/${a.id}/delete`, 'Delete this announcement?'),
          ]),
        });
      })
      .join('\n') || '        <li class="row row-empty">No announcements yet.</li>';
  return group({
    title: 'Announcements',
    id: 'announcements',
    phoneOrder: 1,
    sub: announcements.length > 1 ? 'drag to reorder' : undefined,
    actions: `<button type="button" class="btn small" id="preview-btn">Preview &amp; Email</button>
          <a class="btn small primary" href="/admin/announcements/new">+ New</a>`,
    body: `      <ul class="rows" id="ann-rows">
${rows}
      </ul>`,
  });
}

/**
 * The dashboard's Programs section: what has been written, and — in the help line under it — the
 * window that governs when any of it is visible.
 *
 * The hours are stated here because they are the *only* thing that decides whether a program is
 * readable — an admin looking at an empty Program tab needs them one tap from the program list. The
 * admin's "Change the Hours" jumps to Ward Settings → Sacrament Meeting, where the hours are set
 * from the meeting time (the detailed form is under Advanced Timing beside it). An editor gets the
 * line without the link: writing this Sunday's program is content, moving the hour every ward
 * member can read one is configuration.
 */
function programsGroup(data: {
  recent: ProgramListRow[];
  settings: ProgramSettings;
  today: string;
  windowOpenNow: boolean;
  maxRetentionDays: number;
  isAdmin: boolean;
}): string {
  const { inline, earlier } = splitPrograms(data.recent, data.today);
  const row = (p: ProgramListRow) => programRow(p, data);
  const rows =
    inline.map(row).join('\n') || '        <li class="row row-empty">No programs yet.</li>';
  const hours = `${escapeHtml(clockLabel(data.settings.start))}–${escapeHtml(clockLabel(data.settings.end))}`;
  const help = `Members see each program only on its date, ${hours}, so you can write it days ahead.`;
  return group({
    title: 'Programs',
    phoneOrder: 2,
    sub: 'sacrament meeting',
    actions: '<a class="btn small primary" href="/admin/programs/new">+ New</a>',
    body: `      <ul class="rows">
${rows}
      </ul>`,
    after: [
      earlier.length ? programArchive(earlier, row) : '',
      data.isAdmin
        ? `      <p class="group-help under">${help} <a class="more-label" href="#sacrament-meeting" data-section="sacrament-meeting">Change the Hours</a></p>`
        : `      <p class="group-help under">${help}</p>`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

/** How many *past* programs the card lists before the rest fold into the archive. */
const INLINE_PAST_PROGRAMS = 6;

/**
 * Which programs the card shows outright, and which fold away.
 *
 * Everything not yet past keeps its place — a program written three weeks ahead is exactly what
 * somebody is looking for — plus the last few Sundays, which covers the real errands: write this
 * week's, fix a typo in it, check what was on last week.
 *
 * Counts the past ones as it meets them rather than slicing at an index, so the split does not
 * quietly depend on the caller's `ORDER BY` still being `program_date DESC`.
 */
function splitPrograms(
  recent: ProgramListRow[],
  today: string,
): { inline: ProgramListRow[]; earlier: ProgramListRow[] } {
  const inline: ProgramListRow[] = [];
  const earlier: ProgramListRow[] = [];
  let past = 0;
  for (const p of recent) {
    if (p.program_date >= today) {
      inline.push(p);
    } else if (past < INLINE_PAST_PROGRAMS) {
      past += 1;
      inline.push(p);
    } else {
      earlier.push(p);
    }
  }
  return { inline, earlier };
}

/**
 * The older programs, collapsed — same rows, same menu, one fold away.
 *
 * The point is reachability rather than tidiness. A program the card does not render cannot be
 * edited or deleted from anywhere in the app, so a Sunday typed as 2019 by mistake would sit there
 * until the retention clock happened to catch it. Folding beats truncating for the same reason
 * the access code history folds: the answer to "is that old one still there?" has to exist somewhere.
 */
function programArchive(
  earlier: ProgramListRow[],
  row: (p: ProgramListRow) => string,
): string {
  return `      <details class="program-history">
        <summary>Earlier Programs <span class="muted small">— ${earlier.length}</span></summary>
        <div class="group-card">
          <ul class="rows">
${earlier.map(row).join('\n')}
          </ul>
        </div>
      </details>`;
}

/**
 * One program in either list: its date (tap it to edit), what members can see of it, and the menu —
 * Preview for both roles, Delete for an admin only (the route is `requireAdmin`; this just stops the
 * menu from promising something a 403 will refuse).
 */
function programRow(
  p: ProgramListRow,
  data: { today: string; windowOpenNow: boolean; settings: ProgramSettings; isAdmin: boolean },
): string {
  const { today, settings } = data;
  const hours = `${escapeHtml(clockLabel(settings.start))}–${escapeHtml(clockLabel(settings.end))}`;
  let pill: string;
  let sub: string;
  if (p.program_date === today) {
    pill = data.windowOpenNow
      ? '<span class="badge live">Showing Now</span>'
      : '<span class="badge hidden">Today</span>';
    sub = data.windowOpenNow
      ? `Members can see it until ${escapeHtml(clockLabel(settings.end))}`
      : `Today — outside the window (${hours})`;
  } else if (p.program_date > today) {
    pill = '<span class="badge hidden">Upcoming</span>';
    sub = `Members see it on the day, ${hours}`;
  } else {
    pill = '<span class="badge past">Past</span>';
    sub = `Deleted automatically after ${escapeHtml(rowDate(addDays(p.program_date, settings.retentionDays), today, false))}`;
  }
  const date = escapeHtml(rowDate(p.program_date, today));
  return listRow({
    href: `/admin/programs/${p.id}/edit`,
    title: date,
    sub,
    pill,
    menu: rowMenu(date, [
      `<button type="button" class="menu-item" data-program-preview="${p.id}">Preview</button>`,
      ...(data.isAdmin
        ? [deleteItem(`/admin/programs/${p.id}/delete`, 'Delete this program and its images?')]
        : []),
    ]),
  });
}

/**
 * The visibility window, closed-page wording and retention clock. Admin-only: part of Ward Settings
 * → Advanced Timing, for the ward whose hours are not simply "an hour either side of the meeting".
 */
function programWindowForm(data: { settings: ProgramSettings; maxRetentionDays: number }): string {
  const dayOptions = DOW.map(
    (name, i) =>
      `<option value="${i}" ${i === data.settings.dow ? 'selected' : ''}>${name}</option>`,
  ).join('');
  return `<form method="post" action="/admin/programs/settings" class="admin-form">
          <h3 class="set-heading">Program Hours</h3>
          <div class="inline-form">
            <label>Every
              <select name="program_dow">${dayOptions}</select>
            </label>
            <label>from
              <input type="time" name="program_start" value="${escapeHtml(
                data.settings.start,
              )}" required />
            </label>
            <label>to
              <input type="time" name="program_end" value="${escapeHtml(
                data.settings.end,
              )}" required />
            </label>
          </div>
          <p class="muted small">Times are ${escapeHtml(config.timezone)}. Outside this window the
          Program tab shows the message below instead — the program itself is never sent to a
          member's phone, so nobody can read ahead.</p>

          <label for="program_closed_message">Message when there's nothing to show</label>
          <input id="program_closed_message" name="program_closed_message" type="text" maxlength="300"
                 value="${escapeHtml(data.settings.closedMessage)}"
                 placeholder="${escapeHtml(automaticClosedMessage(data.settings, false))}" />
          <p class="muted small">Leave it blank to have it say when the program opens, from the day
          and time above: “${escapeHtml(automaticClosedMessage(data.settings, false))}” During the
          hours, if no program was written for the day, it says “${escapeHtml(
            automaticClosedMessage(data.settings, true),
          )}” Anything you type here is shown instead, at every hour.</p>

          <label for="program_retention_days">Delete programs after</label>
          <input id="program_retention_days" name="program_retention_days" type="number"
                 inputmode="numeric" min="1" max="${data.maxRetentionDays}"
                 value="${data.settings.retentionDays}" />
          <p class="muted small">Days after the meeting date, 1–${data.maxRetentionDays}. Old
          programs and their images are removed automatically — names don't need to sit on a server
          for years.</p>

          <div class="actions"><button class="btn small" type="submit">Save Program Settings</button></div>
        </form>`;
}

/**
 * The Resources tab's pages, as the dashboard lists them: the announcements' row pattern (a drag
 * handle, a title that opens the editor, a menu), minus the end date and the preview — a page is
 * standing reference, not something that goes out.
 */
function pagesGroup(pages: PageRow[], today: string): string {
  const rows =
    pages
      .map((p) => {
        const title = escapeHtml(p.title);
        return listRow({
          id: p.id,
          drag: true,
          href: `/admin/pages/${p.id}/edit`,
          title,
          sub: p.published
            ? `Updated ${escapeHtml(rowDate(localDateOf(p.updated_at), today, false))}`
            : 'Hidden from members',
          pill: p.published
            ? '<span class="badge live">Live</span>'
            : '<span class="badge hidden">Draft</span>',
          menu: rowMenu(title, [deleteItem(`/admin/pages/${p.id}/delete`, 'Delete this page and its images?')]),
        });
      })
      .join('\n') ||
    '        <li class="row row-empty">No pages yet. The Resources tab appears for members once there is one.</li>';
  return group({
    title: 'Resources',
    phoneOrder: 3,
    sub: 'the Resources tab',
    actions: '<a class="btn small" href="/admin/pages/new">+ New Page</a>',
    help: 'Standing reference pages that never expire.',
    more: `<p>They are not part of the weekly notification, and the content policy applies here too.
        Drag a page by its handle to reorder the tab.</p>`,
    body: `      <ul class="rows" id="page-rows">
${rows}
      </ul>`,
  });
}

/**
 * The standing content policy, on the Content tab for both roles.
 *
 * One row, folded — the people who read it are the ones who go looking, and an open wall of text
 * beside the announcement list would only train everyone to scroll past it. It is deliberately
 * *not* role-split: an editor writes the same announcements an admin does, so they need the same
 * rules. Kept in the view rather than in an editable setting on purpose — this is the ward's
 * standing policy, not a per-install preference, and a policy someone can quietly edit away from
 * the dashboard it governs is not much of a policy.
 */
function contentPolicyGroup(): string {
  return group({
    title: 'Content Policy',
    phoneOrder: 4,
    body: `      <details class="content-policy">
        <summary><span class="row-main">No contact details, nothing private, care with photos.</span>
          <span class="more-label">Read It</span></summary>
        <div class="policy-body">
        <p class="muted small">This app is for sharing ward announcements and general information.
        It is not a secure member directory, and not a place to keep confidential Church
        information.</p>
        <ul class="policy-list">
          <li><strong>Keep announcements general.</strong> Activities, meeting information,
          reminders, deadlines — things meant for the ward as a whole.</li>
          <li><strong>Leave out personal contact information.</strong> No phone numbers, email
          addresses, home addresses, birthdays, or the like. Point members to Member Tools when they
          need to reach someone.</li>
          <li><strong>Never post private or sensitive circumstances.</strong> Nothing about health,
          finances, welfare assistance, counseling, family difficulties, membership status,
          disciplinary matters, ministering needs, or anything else shared in confidence.</li>
          <li><strong>Use names only when reasonably necessary.</strong> A member's name is
          sometimes right for ordinary ward communication, but avoid building an unnecessary
          searchable or permanent record about an individual.</li>
          <li><strong>Be especially careful with children and youth.</strong> No contact
          information, ages, school information, schedules, or other identifying details about
          minors.</li>
          <li><strong>Photos take judgment and permission.</strong> Only appropriate photos meant
          for sharing with the ward, and extra caution with pictures of children or youth.</li>
          <li><strong>Don't copy the ward directory.</strong> Information available through Church
          systems should stay there rather than being duplicated here.</li>
          <li><strong>Assume access could be passed on.</strong> The access link keeps this page out
          of public view only while it stays off public websites and social media, and it is not the
          same as an authenticated Church account. Post only what
          would cause little or no harm if that link were shared by accident.</li>
          <li><strong>When unsure, leave the personal details out.</strong> An administrator or a
          member of the bishopric can look at an unusual case before it is published.</li>
          <li><strong>Remove outdated information.</strong> Set an expiry date so announcements come
          down when they stop being useful — especially the ones that name someone.</li>
        </ul>
        </div>
      </details>`,
  });
}

/**
 * When the weekly notification goes out. Shown to both roles — an editor cannot *change* it, but
 * they are the one publishing the announcements it carries, so "will this be out before Sunday?" is
 * their question to answer, not the administrator's to be asked.
 */
interface ScheduleData {
  dow: number;
  /** 'HH:MM', 24-hour, in `config.timezone`. */
  time: string;
  autoSend: boolean;
}

/** The admin-only half of the dashboard's data. See `dashboardPage`. */
interface AdminData {
  /** Everyone who signs in with a passkey (the People card). */
  people: AdminUserListRow[];
  weeklyTitle: string;
  weeklyBody: string;
  timezone: string;
  nextRunLabel: string;
  /** Occurrences stepped over to reach `nextRunLabel` because they are in the skip list. */
  nextRunSkipped: number;
  sendAlert?: string;
  /** Every code ever issued, for the rotation history. */
  codes: AccessCodeRow[];
  gateMessage: string;
  inviteTtlMaxDays: number;
}

interface AccessData {
  enabled: boolean;
  link: string | null;
  hasOrigin: boolean;
  qrSvg: string | null;
  liveInvites: number;
  inviteTtlDays: number;
}

/**
 * A settings list: one row per setting, its label on the left and its current value on the right,
 * and a chevron. Tapping a row unfolds that setting's own form in place — a `<details>`, so it works
 * without any script, and the form inside is the same POST form it always was. A row with no `body`
 * is information only (what an editor sees of the schedule, say), and has no chevron.
 *
 * `label` and `value` are already escaped; `sub` is a one-line consequence under the label, for the
 * danger rows.
 */
function settingRow(o: {
  label: string;
  value?: string;
  sub?: string;
  body?: string;
  cls?: string;
  /** For a section jump (`data-section`): the dashboard script opens the row it lands on. */
  id?: string;
}): string {
  const head = `<span class="set-text"><span class="set-label">${o.label}</span>${
    o.sub ? `<span class="set-sub">${o.sub}</span>` : ''
  }</span>${o.value !== undefined ? `<span class="set-value">${o.value}</span>` : ''}`;
  const attrs = `class="set-row${o.cls ? ` ${o.cls}` : ''}"${o.id ? ` id="${o.id}"` : ''}`;
  if (!o.body) return `        <li ${attrs}><div class="set-line">${head}</div></li>`;
  return `        <li ${attrs}><details>
          <summary class="set-line">${head}<span class="set-chev" aria-hidden="true"></span></summary>
          <div class="set-body">
          ${o.body}
          </div>
        </details></li>`;
}

function settingsList(rows: string[]): string {
  return `      <ul class="settings">
${rows.filter(Boolean).join('\n')}
      </ul>`;
}

/**
 * An on/off setting as a switch. It is a real checkbox in the setting's own POST form, sent as soon
 * as it changes (the dashboard script listens for `data-autosubmit`); without script the Save
 * button beside it does the same.
 */
function switchRow(o: { label: string; action: string; name: string; checked: boolean }): string {
  return `        <li class="set-row"><form method="post" action="${o.action}" class="set-line set-switch">
          <label class="set-label" for="switch-${o.name}">${o.label}</label>
          <input class="switch" type="checkbox" role="switch" id="switch-${o.name}" name="${o.name}" value="1"${
            o.checked ? ' checked' : ''
          } data-autosubmit />
          <noscript><button class="btn small" type="submit">Save</button></noscript>
        </form></li>`;
}

function plural(n: number, word: string): string {
  return `${word}${n === 1 ? '' : 's'}`;
}

/** "Mountain" for America/Denver — the plain word from the common list — or the zone's own name. */
function timezoneShort(tz: string): string {
  const common = COMMON_TIMEZONES.find(([id]) => id === tz);
  return common ? common[1].split(/ — |,/)[0]! : tz.replace(/_/g, ' ');
}

/**
 * Sundays the weekly notification is deliberately skipped — General Conference, a stake conference:
 * the body of the Skipped Sundays row.
 *
 * Shown to both roles (see `skips` on the dashboard data). Only upcoming dates are listed: one that
 * has passed has already done its job and is deleted on the daily housekeeping clock a couple of
 * days later, so there is never a spent entry to tidy up and never a reason to remove one by hand
 * except changing your mind.
 *
 * The date input is `min`-ed at today. That is a convenience, not the guard — the route validates
 * the same thing, because a disabled control is not a rule.
 */
function skipSettingBody(skips: SendSkipRow[], today: string, schedule: ScheduleData): string {
  const sendDay = DOW[schedule.dow] ?? 'Sunday';
  const rows =
    skips
      .map((s) => {
        // A skip only ever suppresses the occurrence that falls on it, so one dated any other
        // weekday cannot do anything at all. Said on the row rather than refused at the door: the
        // admin may be mid-way through moving the schedule, and a date that is wrong *today* is not
        // wrong in a way worth throwing their entry away over. But it must not look like it worked
        // — the failure is a notification going out on the very day they meant to silence.
        const dow = dayOfWeekFor(s.skip_date);
        const wrongDay =
          dow !== null && dow !== schedule.dow
            ? `<span class="err small">Not a ${escapeHtml(sendDay)} — nothing is sent on
              ${escapeHtml(DAY_NAMES[dow] ?? '')}s anyway, so this skip does nothing.</span>`
            : '';
        return `        <li>
          <span>${escapeHtml(programDateLabel(s.skip_date))}</span>
          ${s.note ? `<span class="muted small">${escapeHtml(s.note)}</span>` : ''}
          ${wrongDay}
          <form method="post" action="/admin/skips/delete" class="inline">
            <input type="hidden" name="skip_date" value="${escapeHtml(s.skip_date)}" />
            <button class="btn small" type="submit">Remove</button>
          </form>
        </li>`;
      })
      .join('\n') || '        <li class="muted">None — the notification goes out every week.</li>';

  // Said plainly because the consequence is silence, and silence is the one outcome nobody notices
  // is wrong until somebody asks why they were never told.
  const effect = schedule.autoSend
    ? `No notification goes out on these ${escapeHtml(sendDay)}s — for General Conference, a stake
       conference, any week the ward would rather stay quiet. Announcements and the program stay
       visible in the app as usual; only the notification is held back.`
    : 'Automatic sending is currently off, so nothing goes out on any day until it is switched back on.';
  return `<p class="muted small">${effect}</p>
          <ul class="skip-list">
${rows}
          </ul>
          <form method="post" action="/admin/skips" class="skip-add">
            <label>Date
              <input type="date" name="skip_date" min="${escapeHtml(today)}" required />
            </label>
            <label>Why (optional)
              <input type="text" name="note" maxlength="60" placeholder="General Conference" />
            </label>
            <button class="btn" type="submit">Add</button>
          </form>`;
}

/**
 * What an editor is told about the weekly notification, under the schedule they cannot change.
 *
 * Plural day ("Sundays"), because it is a standing arrangement rather than one send, and the whole
 * point of the sentence is to answer "if I publish this now, when do people hear about it?".
 *
 * The off case is not a footnote: with auto-send disabled the first sentence would be a plain
 * untruth, and an editor who believes it publishes on Saturday night and assumes the ward has been
 * told. So the day and time still appear — they are what the notification *would* use, and the
 * administrator may well be sending it by hand at about that time — but the sentence says outright
 * that nothing goes automatically.
 */
function weeklySentence(schedule: ScheduleData): string {
  const when = `${escapeHtml(DOW[schedule.dow] ?? 'Sunday')}s at ${escapeHtml(
    clockLabel(schedule.time),
  )}`;
  return schedule.autoSend
    ? `      <p class="group-help under">Anything you publish here goes out with the weekly notification on
      ${when}.</p>`
    : `      <p class="group-help under">The weekly notification is set for ${when}, but automatic sending is
      currently switched off — nothing goes out until the administrator sends it.</p>`;
}

/**
 * One line of Recent Sends: when and what kind, what happened to it, and a pill.
 *
 * The tally comes from the send's `send_batches` row when it went through the queue: still
 * `pending` is SENDING; finished with nothing delivered and something failed is FAILED; anything
 * else finished is SENT. Older sends from before the queue have only `recipient_count`. A skipped
 * Sunday carries its reason in `title` and no count at all — there were no recipients, and "0 sent"
 * next to a deliberate silence reads like a failed send.
 */
function sendRow(s: SendHistoryRow): string {
  const when = new Date(`${s.sent_at.replace(' ', 'T')}Z`).toLocaleString('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const kind = s.type === 'skipped' ? 'skipped' : s.type === 'manual' ? 'manual' : 'weekly';
  let pill: string;
  let sub: string;
  if (s.type === 'skipped') {
    pill = '<span class="badge hidden">Skipped</span>';
    sub = escapeHtml(s.title);
  } else {
    const message = `“${escapeHtml(s.title)}”`;
    if (s.batch_status === 'pending') {
      pill = '<span class="badge soon">Sending</span>';
      sub = `${message} · ${s.batch_sent ?? 0} of ${s.batch_total ?? 0} delivered so far`;
    } else if (s.batch_status) {
      const sent = s.batch_sent ?? 0;
      const failed = s.batch_failed ?? 0;
      const removed = s.batch_removed ?? 0;
      pill =
        sent === 0 && failed > 0
          ? '<span class="badge expired">Failed</span>'
          : '<span class="badge live">Sent</span>';
      sub = `${message} · ${
        (s.batch_total ?? 0) === 0
          ? 'no subscribers'
          : `${sent} delivered${failed ? ` · ${failed} failed` : ''}${removed ? ` · ${removed} no longer subscribed` : ''}`
      }`;
    } else {
      pill = '<span class="badge live">Sent</span>';
      sub = `${message} · ${s.recipient_count} sent`;
    }
  }
  const body = s.body?.trim();
  return `        <li class="row">
          <div class="row-main">
            <span class="row-head">${escapeHtml(when)} · ${kind}</span>
            <span class="row-sub">${sub}</span>${
              body
                ? `
            <details class="send-msg"><summary>Message</summary><p class="send-body">${escapeHtml(body)}</p></details>`
                : ''
            }
          </div>
          ${pill}
        </li>`;
}

/**
 * The printable "get the app" flyer: iPhone steps on one side, Android on the other, with this
 * ward's name, home-screen name, QR code and domain. Built in the browser by `public/flyer-pdf.js`
 * (pdfmake, loaded on the first press) from `/admin/flyer.json`; shown wherever the QR is, since it
 * needs the same absolute share link. One button, opening the choice of two layouts.
 */
function flyerMenu(): string {
  return `<span class="flyer" data-flyer>
            <details class="row-menu flyer-menu">
              <summary class="btn small">Printable Flyer</summary>
              <div class="menu">
                <button type="button" class="menu-item" data-flyer-pdf="half">Half-Letter<span class="menu-note">Two 5½ × 8½ in pages</span></button>
                <button type="button" class="menu-item" data-flyer-pdf="two-up">Two per Sheet<span class="menu-note">Letter paper, cut in half</span></button>
              </div>
            </details>
            <span class="spinner" data-flyer-spinner hidden aria-hidden="true"></span>
            <span class="muted small" data-flyer-status hidden aria-live="polite"></span>
          </span>`;
}

/**
 * Share With Members: the link, its QR code and the flyer, for both roles.
 *
 * The Settings tab (Sharing, for an editor) is split by role, and the line is between *handing the app to someone* and
 * *changing who can get in*. An editor sees this card — giving a new family the link is the same
 * kind of errand as writing an announcement — and none of the controls that change the gate's
 * wording, retire a code or end every member's session (those are in Ward Settings and Access Code,
 * both admin-only).
 */
function shareGroup(access: AccessData): string {
  if (!access.enabled) {
    return group({
      title: 'Share With Members',
      id: 'share',
      card: 'pad',
      body: `      <p class="muted">No access code is in force yet. One is issued automatically when the app
      starts — reload this page in a moment.</p>`,
    });
  }
  const invites =
    access.liveInvites === 1
      ? ' 1 member invite is live right now.'
      : access.liveInvites
        ? ` ${access.liveInvites} member invites are live right now.`
        : '';
  return group({
    title: 'Share With Members',
    id: 'share',
    card: 'pad',
    body: `      <div class="share${access.qrSvg ? '' : ' no-qr'}">
        ${access.qrSvg ? `<div class="share-qr">${access.qrSvg}</div>` : ''}
        <div class="share-main">
          <code class="share-link" id="share-link">${escapeHtml(access.link ?? '')}</code>
          <div class="share-actions">
            <button type="button" class="btn small" data-copy-link="share-link">Copy Link</button>${
              access.qrSvg
                ? `
            <a class="btn small" href="/admin/qr.png" download="announcements-qr.png">QR (PNG)</a>
            <a class="btn small" href="/admin/qr.svg" download="announcements-qr.svg">QR (SVG)</a>
            ${flyerMenu()}`
                : ''
            }
            <span class="copy-status" data-copy-link-status role="status" aria-live="polite"></span>
          </div>
          <p class="share-warn">Hand it out person to person. Don't post it anywhere public.</p>
        </div>
      </div>${
        access.qrSvg
          ? ''
          : `
      <p class="muted small">The share link and QR code need the app's public address: set <code>PUBLIC_ORIGIN</code>, or open this dashboard over https and it is picked up automatically.</p>`
      }
      <details class="group-help share-more">
        <summary>What the link does, and other ways to share. <span class="more-label">More</span></summary>
        <div class="group-more">
          <p>Opening the link unlocks the app on that phone, and it keeps working there even after you
          issue a new code. A link anyone can follow is the same as having no access code at all: the
          gate is what keeps members' names and other information from circulating beyond the ward.</p>
          <p>The QR code says the same thing: PNG to drop into a flyer, a slide or a text message; SVG to
          print, as it stays sharp at any size. The printable flyer adds step-by-step install
          instructions, iPhone on one side and Android on the other.</p>
          <p>Members can also pass the app along from their own phone: the <strong>Share With
          Someone</strong> button on the announcements page hands out a link that stops working after
          ${access.inviteTtlDays} days. There's no limit on how many people use it in that window, and
          each of them keeps access afterwards.${invites}</p>
        </div>
      </details>`,
  });
}

/** The previously issued codes, newest first, and whether each still opens the app. */
function codeHistoryList(codes: AccessCodeRow[]): { count: number; html: string } {
  const retired = codes.filter((c) => c.retired_at);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const html = retired
    .map((c) => {
      const live = !c.expires_at || c.expires_at > now;
      const status = !c.expires_at
        ? '<span class="badge live">Still works — no expiry</span>'
        : live
          ? `<span class="badge live">Works until ${escapeHtml(shortDate(c.expires_at))}</span>`
          : `<span class="badge expired">Stopped ${escapeHtml(shortDate(c.expires_at))}</span>`;
      return `            <li><code>${escapeHtml(c.code)}</code> ${status}
              <span class="muted small">issued ${escapeHtml(shortDate(c.created_at))}</span></li>`;
    })
    .join('\n');
  return { count: retired.length, html: retired.length ? `<ul class="code-history">\n${html}\n          </ul>` : '' };
}

/**
 * Issuing a new code, and with it signing members out (browsers only, or installed apps too): rare,
 * consequential, and admin-only. A red-edged settings row at the foot of the Settings tab, opening
 * onto the one form and its confirm(), with the retired codes listed under it.
 */
function accessManagementGroup(access: AccessData, admin?: AdminData): string {
  if (!admin || !access.enabled) return '';
  const history = codeHistoryList(admin.codes);
  return group({
    title: 'Access Code',
    sub: 'rarely needed',
    card: 'danger',
    body: settingsList([
      settingRow({
        label: 'Issue a New Code',
        sub: 'Routine: every few months, or immediately if the link turns up somewhere public.',
        cls: 'danger-row',
        body: `<p class="muted small">Replaces the ward's link and QR code. On its own, <strong>nobody who
          already opened the app loses access</strong>: only copies of the old link out in the world stop
          working, once the grace period runs out — so reprint any posted QR codes within it. Doing this
          every few months keeps a link that was passed too far from staying good for years. An older code
          still working is never left good for longer than this one, so “Stop it immediately” stops them
          all. To also sign people out, choose who below.</p>
          <form method="post" action="/admin/access/rotate" class="admin-form"
                data-confirm="Issue a new access code? The current QR code and link will be replaced, and anyone you chose to sign out will need the new link.">
            <label for="grace">Keep the current code working for</label>
            <select id="grace" name="grace">
              <option value="365">Another year</option>
              <option value="180">Another 6 months</option>
              <option value="30">Another 30 days</option>
              <option value="7" selected>Another week</option>
              <option value="0">Stop it immediately</option>
              <option value="never">Indefinitely</option>
            </select>
            <fieldset class="link-choice">
              <legend>Who is signed out</legend>
              <label>
                <input type="radio" name="evict" value="none" checked />
                <span><strong>Nobody.</strong> <span class="muted">Routine. Members and installed apps notice nothing.</span></span>
              </label>
              <label>
                <input type="radio" name="evict" value="browsers" />
                <span><strong>Everyone who used a browser.</strong> <span class="muted">If you suspect a stranger or a bot
                  opened the link. Members on a phone browser need the new link again; installed apps let
                  themselves back in on their next launch.</span></span>
              </label>
              <label>
                <input type="radio" name="evict" value="all" />
                <span><strong>Everyone, including installed apps.</strong> <span class="muted">The last resort, if you
                  suspect unwanted people or bots have the app itself. Every member needs the new link, and an
                  installed app has to paste it into the box it shows (or be deleted and added again from
                  Safari), so send it by text or email and expect to explain it.</span></span>
              </label>
              <p class="muted small">Signing anyone out stops the old code immediately, whatever grace is chosen
                above — otherwise the same link would let them straight back in.</p>
            </fieldset>
            <div class="actions"><button class="btn small danger" type="submit">Issue New Code</button></div>
          </form>`,
      }),
      // Worth keeping in full — it is the only way to answer "is that QR code on the bulletin board
      // still good?".
      history.count
        ? settingRow({ label: 'Previous Codes', value: `${history.count} retired`, body: history.html })
        : '',
    ]),
  });
}

/** The manual push, behind Recent Sends' "Send One Now". Admin-only. */
function sendNowForm(subscribers: number): string {
  return `<p class="muted small">Goes to all ${subscribers} ${plural(subscribers, 'subscriber')}. Use it for
        a test or a time-sensitive announcement.</p>
      <form method="post" action="/admin/send" class="admin-form"
            data-confirm="Send this notification to all ${subscribers} ${plural(subscribers, 'subscriber')} now?">
        <label for="title">Title</label>
        <input id="title" name="title" type="text" maxlength="80" value="${escapeHtml(DEFAULT_WEEKLY_TITLE)}" required />
        <label for="body">Message</label>
        <textarea id="body" name="body" maxlength="300">New announcements are posted — tap to view.</textarea>

        <fieldset class="link-choice">
          <legend>When tapped, open</legend>
          <label>
            <input type="radio" name="link_target" value="announcements" checked />
            The announcements page
          </label>
          <label>
            <input type="radio" name="link_target" value="custom" />
            A specific web link
          </label>
          <input id="custom-url" class="custom-url" name="custom_url" type="url"
                 placeholder="https://example.com" />
          <p class="muted small custom-url-hint">Enter the full address, including https://</p>
        </fieldset>

        <div class="actions" style="margin-top:1rem">
          <button class="btn primary" type="submit">Send to All Subscribers</button>
        </div>
      </form>`;
}

/**
 * Everyone who can sign in besides the owner, a row each, and "+ Add a Person". Admin only: deciding
 * who gets in is as sensitive as the access controls beside it.
 */
function peopleGroup(people: AdminUserListRow[], selfId: number | null): string {
  const rows = people
    .map((p) => {
      const role = p.role === 'admin' ? 'Admin' : 'Editor';
      const status =
        p.passkeys > 0
          ? `${p.passkeys} ${plural(p.passkeys, 'passkey')}${
              p.id === selfId
                ? ' · you'
                : p.last_used_at
                  ? ` · last signed in ${escapeHtml(stampLabel(p.last_used_at))}`
                  : ''
            }`
          : p.open_invites > 0
            ? 'invite sent, not yet used'
            : 'no passkey, and the invite has expired';
      const pill =
        p.passkeys > 0
          ? ''
          : p.open_invites > 0
            ? '<span class="badge soon">Invited</span>'
            : '<span class="badge hidden">No Passkey</span>';
      return `        <li class="row">
          <div class="row-main">
            <a class="row-title" href="/admin/people/${p.id}">${escapeHtml(p.name)}</a>
            <span class="row-sub">${role} · ${status}</span>
          </div>
          ${pill}
          <span class="row-chev" aria-hidden="true"></span>
        </li>`;
    })
    .join('\n');
  return group({
    title: 'People',
    id: 'people',
    sub: 'who can sign in here',
    reveal: {
      label: '+ Add a Person',
      body: `<form method="post" action="/admin/people" class="admin-form people-add">
        <label for="person_name">Name</label>
        <input id="person_name" name="name" type="text" maxlength="80" required placeholder="e.g. Brother Okafor (clerk)" />
        <label for="person_new_role">Role</label>
        <div class="people-add-row">
          <select id="person_new_role" name="role">
            <option value="editor">Editor — content only</option>
            <option value="admin">Admin — everything</option>
          </select>
          <button class="btn small primary" type="submit">Add and Get Invite Link</button>
        </div>
      </form>`,
    },
    help: 'Each person signs in with a passkey on their own phone.',
    more: `<p>Adding someone gives you an invite link to send them. An <strong>editor</strong> writes
      announcements, pages and programs; an <strong>admin</strong> can also change settings, member
      access and this list.${
        // Only where there is an owner: a ward on the many-ward host has none (see `hasOwner`).
        config.adminPassword ? ' The owner password also always works.' : ''
      }</p>`,
    body: `      <ul class="rows">
${rows || '        <li class="row row-empty">Nobody has been added yet.</li>'}
      </ul>`,
  });
}

/**
 * Your own account: who you are signed in as, your passkeys, and a button that makes one on the
 * device in front of you — typically a computer, after signing in there with the phone's QR code, so
 * it signs in by itself next time.
 */
export function accountPage(opts: { who: Who; passkeys: AdminPasskeyRow[]; flash?: string }): string {
  const { who } = opts;
  const rows = opts.passkeys
    .map(
      (k) => `        <li>
          <span><strong>${escapeHtml(k.label ?? 'Device')}</strong> · added ${escapeHtml(shortDate(k.created_at))}${k.last_used_at ? `, last used ${escapeHtml(stampLabel(k.last_used_at))}` : ', not used yet'}</span>
          <form method="post" action="/admin/me/passkeys/${encodeURIComponent(k.id)}/delete"
                data-confirm="Remove this passkey? The device it is on will no longer sign in, and any other device you are signed in on is signed out.">
            <button class="btn small danger" type="submit">Remove</button>
          </form>
        </li>`,
    )
    .join('\n');
  const body =
    who.userId === null
      ? `    <section class="card">
      <h2>Your Account</h2>
      ${opts.flash ? `<p class="ok">${escapeHtml(opts.flash)}</p>` : ''}
      <p>You are signed in as the <strong>owner</strong>, with the owner password.</p>
      <p class="muted small">The owner password always works and has no passkeys of its own. To sign in
      with a passkey instead, add yourself under <a href="/admin#people">Settings → People</a> and open
      the invite link on your phone.</p>
      <div class="actions">
        <form method="post" action="/admin/me/signout-everywhere"
              data-confirm="Sign the owner out on every other device? This one stays signed in.">
          <button class="btn small" type="submit">Sign Out Everywhere</button>
        </form>
      </div>
      <p class="muted small">Ends the owner's sign-in on every other phone and computer, without changing
      the password.</p>
    </section>`
      : `    <section class="card">
      <h2>Your Account</h2>
      ${opts.flash ? `<p class="ok">${escapeHtml(opts.flash)}</p>` : ''}
      <p>Signed in as <strong>${escapeHtml(who.name)}</strong> (${who.role === 'admin' ? 'admin' : 'editor'}).</p>
      <form method="post" action="/admin/me/name" class="admin-form">
        <label for="me-name">Your Name</label>
        <input id="me-name" name="name" type="text" maxlength="80" required value="${escapeHtml(who.name)}" />
        <p class="muted small">How you appear in the dashboard's People list, e.g. "Brother Okafor (clerk)".</p>
        <div class="actions"><button class="btn small" type="submit">Save Name</button></div>
      </form>
    </section>

    <section class="card">
      <h3>Your Passkeys</h3>
      ${rows ? `<ul class="passkey-list">\n${rows}\n      </ul>` : '<p class="muted small">None.</p>'}
      <p class="muted small">Signed in here with your phone's QR code? Add a passkey on this device and
      it will sign in by itself next time — with Touch ID, Windows Hello or the screen lock. Not on a
      shared computer, like the clerk's office: there, keep using your phone.</p>
      <div class="actions">
        <button class="btn primary" type="button" id="passkey-add">Add a Passkey on This Device</button>
      </div>
      <p class="small" id="passkey-status" role="status" aria-live="polite"></p>
    </section>`;
  return layout('Your Account', body, {
    showLogout: true,
    role: who.role,
    bodyEnd:
      who.userId === null
        ? ''
        : `<script src="/vendor/passkey.js"></script>
  ${scriptTag()}
    (function () {
      var button = document.getElementById('passkey-add');
      var status = document.getElementById('passkey-status');
      if (typeof WardPasskey === 'undefined' || !WardPasskey.supported()) {
        button.disabled = true;
        status.textContent = 'This browser cannot create passkeys.';
        return;
      }
      function post(path, body) {
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) { return r.json(); });
      }
      button.addEventListener('click', function () {
        button.disabled = true;
        status.textContent = '';
        post('/admin/passkey/add/options')
          .then(function (options) {
            if (options.error) throw new Error(options.error);
            return WardPasskey.startRegistration({ optionsJSON: options });
          })
          .then(function (response) { return post('/admin/passkey/add/verify', response); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.error || 'The passkey could not be saved.');
            location.href = '/admin/me?msg=' + encodeURIComponent('Passkey added. This device will sign in by itself now.');
          })
          .catch(function (err) {
            status.textContent = err && err.name === 'InvalidStateError'
              ? 'This device already has one of your passkeys — it can sign in by itself already.'
              : err && err.name === 'NotAllowedError'
                ? 'That was cancelled.'
                : (err && err.message) || 'Something went wrong.';
            button.disabled = false;
          });
      });
    })();
  </script>`,
  });
}

/** One person: their invite link (as text and QR), their passkeys, and what can be done about them. */
export function personPage(opts: {
  person: AdminUserRow;
  passkeys: AdminPasskeyRow[];
  invite: { link: string; qrSvg: string; expiresAt: string } | null;
  isSelf: boolean;
  flash?: string;
}): string {
  const p = opts.person;
  const passkeyRows = opts.passkeys
    .map(
      (k) => `        <li>
          <span><strong>${escapeHtml(k.label ?? 'Device')}</strong> · added ${escapeHtml(shortDate(k.created_at))}${k.last_used_at ? `, last used ${escapeHtml(stampLabel(k.last_used_at))}` : ', not used yet'}</span>
          <form method="post" action="/admin/people/${p.id}/passkeys/${encodeURIComponent(k.id)}/delete"
                data-confirm="Remove this passkey? They will be signed out on every device, and that one will no longer sign in.">
            <button class="btn small danger" type="submit">Remove</button>
          </form>
        </li>`,
    )
    .join('\n');
  return layout(
    p.name,
    `    <section class="card">
      <div class="section-head">
        <h2>${escapeHtml(p.name)}</h2>
        <div class="section-actions"><a class="btn small" href="/admin#settings">Back</a></div>
      </div>
      ${opts.flash ? `<p class="ok">${escapeHtml(opts.flash)}</p>` : ''}
      <form method="post" action="/admin/people/${p.id}" class="admin-form">
        <label for="person_name">Name</label>
        <input id="person_name" name="name" type="text" maxlength="80" required value="${escapeHtml(p.name)}" />
        <label for="person_role">Role</label>
        <select id="person_role" name="role">
          <option value="editor"${p.role === 'editor' ? ' selected' : ''}>Editor — content only</option>
          <option value="admin"${p.role === 'admin' ? ' selected' : ''}>Admin — everything</option>
        </select>
        <div class="actions" style="margin-top:1rem"><button class="btn small primary" type="submit">Save</button></div>
      </form>
    </section>

    <section class="card">
      <h3>Invite Link</h3>
      ${
        opts.invite
          ? `<p class="muted small">Send this to ${escapeHtml(p.name)} — by text is easiest. Opening it on
      their phone creates their passkey and signs them in. It works once, until
      ${escapeHtml(stampLabel(opts.invite.expiresAt))}.</p>
      <p><code class="share-link">${escapeHtml(opts.invite.link)}</code></p>
      <div class="qr">${opts.invite.qrSvg}</div>
      <p class="muted small">Or have them scan this with their phone's camera. Making a new link
      stops this one working.</p>`
          : `<p class="muted small">${
              opts.passkeys.length
                ? 'They are set up. Make a new link if they need a passkey on another device, or have lost theirs.'
                : 'Their link has expired or been used. Make a new one to send.'
            }</p>`
      }
      <form method="post" action="/admin/people/${p.id}/invite">
        <button class="btn small" type="submit">${opts.invite ? 'Make a New Link' : 'Make an Invite Link'}</button>
      </form>
    </section>

    <section class="card">
      <h3>Passkeys</h3>
      ${passkeyRows ? `<ul class="passkey-list">\n${passkeyRows}\n      </ul>` : '<p class="muted small">None yet.</p>'}
      <div class="actions">
        <form method="post" action="/admin/people/${p.id}/signout"
              data-confirm="Sign ${escapeHtml(p.name)} out on every device?">
          <button class="btn small" type="submit">Sign Out Everywhere</button>
        </form>
        <form method="post" action="/admin/people/${p.id}/delete"
              data-confirm="Remove ${escapeHtml(p.name)}? They will lose access straight away.">
          <button class="btn small danger" type="submit">Remove ${opts.isSelf ? 'Yourself' : 'This Person'}</button>
        </form>
      </div>
    </section>`,
    { showLogout: true, role: 'admin' },
  );
}

/** What the first-run checklist ticks off, worked out from the ward's own data. */
export interface GettingStarted {
  wardNamed: boolean;
  /** A sacrament meeting time is stored (`meeting.ts`); until then the timing is the defaults. */
  meetingTimeSet: boolean;
  /** Signed in with a passkey rather than the owner password: they are already one of the people. */
  signedInAsPerson: boolean;
  personAdded: boolean;
  announcementWritten: boolean;
  memberSubscribed: boolean;
}

/**
 * A short checklist for whoever sets a new ward up: the five things that make it usable, each
 * ticked off from the data rather than by hand, each a link to where it is done. Shown to admins
 * until every step is done or someone dismisses it.
 *
 * A slim banner rather than a card: it sat above every tab, and a tall checklist there pushed the
 * actual work below the fold on a phone for as long as one step stayed open. The banner shows the
 * progress and the *next* step; "All Steps" unfolds the full list in place.
 */
function gettingStartedBanner(g: GettingStarted): string {
  const steps: {
    done: boolean;
    text: string;
    /** The step as the banner's "Next:" line puts it, and the Title Case button after it. */
    next: string;
    cta: string;
    href: string;
    /** The link at the end of the step's sentence in the full list. */
    link: string;
  }[] = [
    {
      done: g.wardNamed,
      text: "Give the app your ward's name and timezone.",
      next: "give the app your ward's name and timezone.",
      href: '#ward-settings',
      cta: 'Ward Settings',
      link: 'Ward Settings',
    },
    {
      done: g.meetingTimeSet,
      text: 'Set when sacrament meeting starts. The program hours and the weekly notification follow from it.',
      next: 'set your meeting time.',
      href: '#sacrament-meeting',
      cta: 'Sacrament Meeting',
      link: 'Sacrament Meeting',
    },
    {
      done: g.personAdded,
      text: g.signedInAsPerson
        ? 'Invite the others who will help, such as a clerk or a counselor, each with their own passkey.'
        : 'Add yourself and the others who will help, each with their own passkey.',
      next: g.signedInAsPerson ? "invite the others who'll help." : "add the people who'll help.",
      href: '#people',
      cta: 'People',
      link: 'People',
    },
    {
      done: g.announcementWritten,
      text: 'Write your first announcement and delete the sample.',
      next: 'write your first announcement and delete the sample.',
      href: '#announcements',
      cta: 'Announcements',
      link: 'Announcements',
    },
    {
      done: g.memberSubscribed,
      text: 'Share the member link or QR code. This is ticked once anyone turns on notifications, and your own phone counts.',
      next: 'share the member link or QR code.',
      href: '#share',
      cta: 'Share With Members',
      link: 'Share With Members',
    },
  ];
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done);
  const item = (s: (typeof steps)[number]) =>
    `<li class="${s.done ? 'done' : ''}"><span class="check" aria-hidden="true">${s.done ? '✓' : ''}</span>
          <span>${s.text} <a href="${s.href}" data-section="${s.href.slice(1)}">${s.link}</a>${s.done ? ' <span class="muted small">— done</span>' : ''}</span></li>`;
  return `    <section class="gs" aria-labelledby="gs-title">
      <div class="gs-row">
        <span class="gs-ring" style="--gs-p:${Math.round((done / steps.length) * 100)}%" role="img"
              aria-label="${done} of ${steps.length} steps done"><span>${done}/${steps.length}</span></span>
        <div class="gs-next">
          <h2 id="gs-title" class="gs-title">Get Started</h2>${
            next
              ? `<span class="gs-step">next, ${next.next}</span>
          <a class="gs-link" href="${next.href}" data-section="${next.href.slice(1)}">${next.cta}&nbsp;→</a>`
              : ''
          }
        </div>
        <button type="button" class="gs-toggle" aria-expanded="false" aria-controls="gs-steps">All Steps</button>
        <form method="post" action="/admin/getting-started/dismiss" class="gs-dismiss">
          <button class="gs-x" type="submit" aria-label="Dismiss Get Started" title="Dismiss">×</button>
        </form>
      </div>
      <div id="gs-steps" class="gs-steps" hidden>
        <ol class="getting-started-steps">
          ${steps.map(item).join('\n          ')}
        </ol>
        <p class="muted small">This list goes away once every step is done, or when you dismiss it.</p>
      </div>
      ${scriptTag()}
        (function () {
          var toggle = document.querySelector('.gs-toggle');
          var steps = document.getElementById('gs-steps');
          if (!toggle || !steps) return;
          toggle.addEventListener('click', function () {
            var open = steps.hidden;
            steps.hidden = !open;
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.textContent = open ? 'Hide Steps' : 'All Steps';
          });
        })();
      </script>
    </section>
`;
}

/** The zones most wards will want, in plain words, ahead of the full list. */
const COMMON_TIMEZONES: [string, string][] = [
  ['America/New_York', 'Eastern — New York'],
  ['America/Chicago', 'Central — Chicago'],
  ['America/Denver', 'Mountain — Denver'],
  ['America/Phoenix', 'Mountain, no daylight saving — Phoenix'],
  ['America/Boise', 'Mountain — Boise'],
  ['America/Los_Angeles', 'Pacific — Los Angeles'],
  ['America/Anchorage', 'Alaska — Anchorage'],
  ['Pacific/Honolulu', 'Hawaii — Honolulu'],
  ['America/Edmonton', 'Mountain — Edmonton'],
  ['America/Toronto', 'Eastern — Toronto'],
  ['America/Vancouver', 'Pacific — Vancouver'],
  ['America/Mexico_City', 'Central — Mexico City'],
];

/** Every zone the runtime knows (Node and workerd both have the full ICU list), or none if not. */
function allTimezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/**
 * A real dropdown, not a text box with suggestions: a suggestion list shows only entries matching
 * what is already typed, so with "America/Denver" filled in it offered Denver alone and looked
 * broken. The ward's saved zone is always an option — added at the top if it is on neither list —
 * so saving the card never quietly changes it.
 */
export function timezoneSelect(current: string): string {
  const option = (value: string, label: string) =>
    `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const common = new Set(COMMON_TIMEZONES.map(([tz]) => tz));
  const rest = allTimezones().filter((tz) => !common.has(tz));
  const known = common.has(current) || rest.includes(current);
  return `<select id="timezone" name="timezone" required>
            ${known ? '' : option(current, current)}
            <optgroup label="Common">${COMMON_TIMEZONES.map(([tz, label]) => option(tz, label)).join('')}</optgroup>
            ${rest.length ? `<optgroup label="All timezones">${rest.map((tz) => option(tz, tz.replace(/_/g, ' '))).join('')}</optgroup>` : ''}
          </select>`;
}

/**
 * Ward Settings → Sacrament Meeting: the one timing a clerk is asked for (`meeting.ts`). Saving it
 * sets the program hours and the weekly notification; the line under the inputs says exactly what
 * to, recomputed as the inputs change by a few lines of script that mirror `deriveTiming` — and
 * rendered by the server for the stored time, with the save's flash repeating it, so the page says
 * the same without script.
 */
function meetingRow(meeting: { time: MeetingTime | null; timing: TimingStatus }, timezone: string): string {
  const current = meeting.time;
  const dayOptions = DOW.map(
    (name, i) => `<option value="${i}"${i === (current?.dow ?? 0) ? ' selected' : ''}>${name}</option>`,
  ).join('');
  const empty = 'Enter when sacrament meeting starts to see the program hours and notification time.';
  const range = `Sacrament meeting has to start between ${clockLabel(EARLIEST_MEETING)} and ${clockLabel(LATEST_MEETING)}.`;
  const preview = current ? `Saving sets ${timingSentence(deriveTiming(current))}.` : empty;
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return settingRow({
    label: 'Sacrament Meeting',
    id: 'sacrament-meeting',
    value: current
      ? `${escapeHtml(DOW[current.dow] ?? 'Sunday')}s, ${escapeHtml(clockLabel(current.time))}`
      : '<span class="set-none">Not set</span>',
    body: `<form method="post" action="/admin/meeting-time" class="admin-form" data-meeting-form>
            <div class="inline-form">
              <label>Every
                <select name="meeting_dow">${dayOptions}</select>
              </label>
              <label>at
                <input type="time" name="meeting_time" value="${escapeHtml(current?.time ?? '')}"
                       min="${EARLIEST_MEETING}" max="${LATEST_MEETING}" required />
              </label>
            </div>
            <p class="meeting-preview" data-meeting-preview aria-live="polite">${escapeHtml(preview)}</p>${
              meeting.timing === 'custom'
                ? '\n            <p class="meeting-replaces">This replaces your custom times.</p>'
                : ''
            }
            <p class="muted small">When the meeting starts, in ${escapeHtml(timezoneShort(timezone))} time.
            Members can read the program from an hour before until two hours after, and the
            notification arrives as the program appears, before church rather than during meetings.</p>
            <div class="actions"><button class="btn small primary" type="submit">Save</button></div>
          </form>
          ${scriptTag()}
            (function () {
              var form = document.querySelector('[data-meeting-form]');
              if (!form) return;
              var day = form.elements.meeting_dow;
              var time = form.elements.meeting_time;
              var out = form.querySelector('[data-meeting-preview]');
              var DAYS = ${JSON.stringify(DOW)};
              var EARLIEST = ${minutes(EARLIEST_MEETING)}, LATEST = ${minutes(LATEST_MEETING)};
              function label(m) {
                var h = Math.floor(m / 60), mm = m % 60;
                return (h % 12 || 12) + ':' + (mm < 10 ? '0' : '') + mm + ' ' + (h < 12 ? 'AM' : 'PM');
              }
              // Mirrors deriveTiming() in meeting.ts: clamped to the meeting's own day.
              function update() {
                var t = /^(\\d\\d):(\\d\\d)/.exec(time.value || '');
                if (!t) { out.textContent = ${JSON.stringify(empty)}; return; }
                var m = Number(t[1]) * 60 + Number(t[2]);
                if (m < EARLIEST || m > LATEST) { out.textContent = ${JSON.stringify(range)}; return; }
                var open = Math.max(0, m - ${PROGRAM_LEAD_MINUTES}), close = Math.min(1439, m + ${PROGRAM_TAIL_MINUTES});
                out.textContent = 'Saving sets the program hours to ' + label(open) + '–' + label(close) +
                  ' and the weekly notification to ' + DAYS[Number(day.value)] + 's at ' + label(open) + '.';
              }
              day.addEventListener('change', update);
              time.addEventListener('input', update);
              update();
            })();
          </script>`,
  });
}

/**
 * Ward Settings → Advanced Timing: the detailed program-hours and weekly-schedule forms, for a ward
 * whose hours are not simply "around the meeting". Their routes and validation are unchanged; they
 * moved here from the Programs help line and the Notifications tab so all the timing is in one
 * place. "Custom" when either no longer matches what the meeting time sets.
 */
function advancedTimingRow(timing: {
  meeting: { time: MeetingTime | null; timing: TimingStatus };
  program: ProgramSettings;
  maxRetentionDays: number;
  schedule: ScheduleData;
}): string {
  const dayOptions = DOW.map(
    (name, i) => `<option value="${i}" ${i === timing.schedule.dow ? 'selected' : ''}>${name}</option>`,
  ).join('');
  const value =
    timing.meeting.timing === 'derived'
      ? 'From meeting time'
      : timing.meeting.timing === 'custom'
        ? 'Custom'
        : 'Default';
  return settingRow({
    label: 'Advanced Timing',
    id: 'advanced-timing',
    value,
    body: `<p class="muted small">Set the program hours and the notification separately. Saving the
          Sacrament Meeting time above resets both.</p>
          ${programWindowForm({ settings: timing.program, maxRetentionDays: timing.maxRetentionDays })}
          <form method="post" action="/admin/schedule" class="admin-form">
            <h3 class="set-heading">Weekly Notification</h3>
            <div class="inline-form">
              <label>Every
                <select name="dow">${dayOptions}</select>
              </label>
              <label>at
                <input type="time" name="time" value="${escapeHtml(timing.schedule.time)}" required />
              </label>
            </div>
            <p class="muted small">Times are ${escapeHtml(config.timezone)}.</p>
            <div class="actions"><button class="btn small" type="submit">Save Schedule</button></div>
          </form>`,
  });
}

/**
 * The ward's own settings (`ward-settings.ts`), and the locked page's wording, as a settings list.
 *
 * `/admin/ward` saves every ward field at once, so each row's form carries the fields it does not
 * show as hidden inputs holding their current values: a row changes only what it shows, and the
 * route's validation is the same as ever. The gate wording and invite length are their own form
 * (`/admin/access/settings`), moved here from the share card because they are settings, not sharing.
 */
function wardSettingsGroup(
  ward: WardSettings,
  limits: typeof WARD_LIMITS,
  admin: AdminData,
  access: AccessData,
  timing: {
    meeting: { time: MeetingTime | null; timing: TimingStatus };
    program: ProgramSettings;
    maxRetentionDays: number;
    schedule: ScheduleData;
    gettingStartedHidden?: boolean;
  },
): string {
  const gettingStartedHidden = timing.gettingStartedHidden ?? false;
  const values: Record<string, string> = {
    app_name: ward.appName,
    app_short_name: ward.appShortName,
    app_description: ward.appDescription,
    app_footer: ward.appFooter,
    link_text: ward.linkText,
    link_url: ward.linkUrl,
    timezone: ward.timezone,
  };
  const field = (id: string, label: string, max: number, extra = '') =>
    `<label for="${id}">${label}</label>
            <input id="${id}" name="${id}" type="text" maxlength="${max}" value="${escapeHtml(values[id] ?? '')}"${extra} />`;
  const form = (shown: string[], fields: string) =>
    `<form method="post" action="/admin/ward" class="admin-form">
            ${Object.keys(values)
              .filter((k) => !shown.includes(k))
              .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(values[k]!)}" />`)
              .join('\n            ')}
            ${fields}
            <div class="actions"><button class="btn small primary" type="submit">Save</button></div>
          </form>`;
  const quiet = (v: string) => (v ? escapeHtml(v) : '<span class="set-none">None</span>');
  const footerValue =
    [ward.appFooter, ward.linkText].filter(Boolean).map((v) => escapeHtml(v)).join(' · ') ||
    '<span class="set-none">None</span>';

  return group({
    title: 'Ward Settings',
    id: 'ward-settings',
    body: settingsList([
      settingRow({
        label: 'App Name',
        value: quiet(ward.appName),
        body: form(
          ['app_name'],
          `${field('app_name', 'App name', limits.appName, ' required')}
            <p class="muted small">The title members see at the top of the app and on notifications.</p>`,
        ),
      }),
      settingRow({
        label: 'Home-Screen Name',
        value: quiet(ward.appShortName),
        body: form(
          ['app_short_name'],
          `${field('app_short_name', 'Home-screen name', limits.appShortName, ' required')}
            <p class="muted small">The label under the icon. Keep it short — about 12 characters fit.
            Phones that already installed the app keep the old label until it is reinstalled.</p>`,
        ),
      }),
      settingRow({
        label: 'Description',
        value: quiet(ward.appDescription),
        body: form(
          ['app_description'],
          `${field('app_description', 'Description', limits.appDescription, ' required')}
            <p class="muted small">One line about the app, for the install prompt and link previews.</p>`,
        ),
      }),
      settingRow({
        label: 'Timezone',
        value: escapeHtml(timezoneShort(ward.timezone)),
        body: form(
          ['timezone'],
          `<label for="timezone">Timezone</label>
            ${timezoneSelect(ward.timezone)}
            <p class="muted small">Sacrament meeting, the program hours and the weekly notification
            are local times: fixing the timezone keeps them at the same time of day, now in the new zone.</p>`,
        ),
      }),
      meetingRow(timing.meeting, ward.timezone),
      advancedTimingRow(timing),
      settingRow({
        label: 'Footer and Link',
        value: footerValue,
        body: form(
          ['app_footer', 'link_text', 'link_url'],
          `${field('app_footer', 'Footer note (optional)', limits.appFooter)}
            ${field('link_text', 'Extra link text (optional)', limits.linkText)}
            ${field('link_url', 'Extra link address', limits.linkUrl, ' inputmode="url" placeholder="https://"')}
            <p class="muted small">The link is shown below the announcements when both are filled in.</p>`,
        ),
      }),
      settingRow({
        label: 'Gate Page Wording &amp; Invite Length',
        value: `${access.inviteTtlDays} ${plural(access.inviteTtlDays, 'day')}`,
        body: `<form method="post" action="/admin/access/settings" class="admin-form">
            <label for="gate_message">Message on the locked page</label>
            <input id="gate_message" name="gate_message" type="text" maxlength="200"
                   value="${escapeHtml(admin.gateMessage)}" />
            <p class="muted small">What someone sees if they reach the app without a link.</p>
            <label for="invite_ttl_days">Member invite links last</label>
            <input id="invite_ttl_days" name="invite_ttl_days" type="number" inputmode="numeric"
                   min="1" max="${admin.inviteTtlMaxDays}" value="${access.inviteTtlDays}" />
            <p class="muted small">Days, 1–${admin.inviteTtlMaxDays}. Applies to invites created
            from here on; links already handed out keep the length they were issued with.</p>
            <div class="actions"><button class="btn small primary" type="submit">Save</button></div>
          </form>`,
      }),
    ]),
    after: gettingStartedHidden
      ? `      <form method="post" action="/admin/getting-started/show" class="show-again">
        <p class="muted small">The Get Started list was dismissed, and some of its steps are still open.</p>
        <button class="btn small" type="submit">Show It Again</button>
      </form>`
      : undefined,
  });
}

function backupCard(): string {
  // Whether the push keys travel sealed or not at all is a deployment setting (BACKUP_SEAL_KEY);
  // the card says which, since it decides what a restore to a fresh database costs the members.
  const pushKeys = config.backupSealKey
    ? `It leaves out the dashboard sign-in key, so it is no way into the dashboard. Push keys are
          included, sealed with this deployment's BACKUP_SEAL_KEY: a restore here keeps every
          subscription, and the file alone cannot send notifications.`
    : `It leaves out the dashboard sign-in key and the push keys, so it is no way into the
          dashboard and cannot send notifications.`;
  // The help line is the one thing a clerk must read before the button; the rest folds behind
  // "More" so the settings page is not a wall of text (it was).
  return group({
    title: 'Backup',
    help: `Everything — every table and every image — as one ZIP. Keep it as private as the access
      code itself.`,
    more: `<p>It holds the access codes, every installed app's device token, the member sign-in key
          and every subscriber's push address, so never put it in a shared folder or an email.
          ${pushKeys}</p>
          <p>The deployment docs say how to restore it. If you only want the data, without the
          images: <a href="/admin/backup.json">Data only (JSON)</a>.</p>`,
    body: `      <ul class="rows">
        <li class="row row-action">
          <div class="row-main"><span class="row-sub">Download one before any big change, and now and
          then anyway.</span>
          <p class="muted small" data-backup-status hidden role="status"></p></div>
          <button class="btn small" type="button" data-backup-zip>Download Backup (ZIP)</button>
        </li>
      </ul>
      <script src="/backup-zip.js" defer></script>`,
  });
}

/** One live announcement with its images, as `/api/announcements` would return it right now. */
export interface RichPreviewItem {
  title: string;
  body: string;
  images: AttachmentRow[];
}

/**
 * The current announcements as a block of rich text — HTML fit for pasting into a mail client, a
 * document or a chat, and the markup `public/preview-pdf.js` walks for "Save as PDF".
 *
 * Styled *inline* rather than by class: a paste into Gmail, Outlook, Apple Mail or a word processor
 * carries the markup and drops the stylesheet, so anything that leans on `.centered` or `.leader`
 * arrives as a plain left-aligned paragraph. The body is markdown-it's sanitized output (html:false), so the
 * class-to-style rewrites below only ever touch markup the renderer emitted, never the author's
 * text. Dot leaders have no rich-text equivalent — there is no CSS to draw them — so a leader row
 * becomes "left … right", which reads the same aloud.
 *
 * Image links are absolute when `PUBLIC_ORIGIN` is set, because `/images/:key` is deliberately
 * ungated (see app.ts) and a mail client needs a full URL to fetch one.
 */
export function richPreviewHtml(items: RichPreviewItem[]): string {
  const font = 'font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;';
  if (!items.length) {
    return `<div style="${font}font-size:16px;line-height:1.5;color:#111"><p><em>No current announcements.</em></p></div>`;
  }
  const origin = config.publicOrigin;
  const blocks = items.map((item) => {
    const body = renderMarkdown(item.body)
      .replace(
        /<p class="leader"><span class="leader-left">([\s\S]*?)<\/span><span class="leader-dots" aria-hidden="true"><\/span><span class="leader-right">([\s\S]*?)<\/span><\/p>/g,
        '<p>$1 … $2</p>',
      )
      // Every class the renderer can put on a block — `centered` (on a paragraph *or* a heading),
      // `gap-1`..`gap-3` (extra blank lines), in any combination — becomes the inline style the
      // stylesheet would have applied. Matched as a whole attribute so `centered gap-2` is not
      // missed by a rule looking for `class="centered"` alone.
      .replace(/<(p|h[1-6]) class="([^"]*)">/g, (_m, tag: string, classes: string) => {
        const styles: string[] = [];
        if (/\bcentered\b/.test(classes)) styles.push('text-align:center');
        const gap = /\bgap-([1-3])\b/.exec(classes);
        if (gap) styles.push(`margin-top:${Number(gap[1]) * 0.9}em`);
        if (tag === 'p') styles.push('margin-bottom:0.6em');
        return `<${tag} style="${styles.join(';')}">`;
      })
      .replace(/<p>/g, '<p style="margin:0 0 0.6em">');
    const images = item.images.length
      ? `<p style="margin:0.4em 0 0.6em">${item.images
          .map((row) => {
            const url = `${origin}/images/${escapeHtml(row.key)}`;
            return `<a href="${url}"><img src="${url}" alt="" style="max-height:220px;max-width:100%;height:auto;border-radius:6px;margin:0 6px 6px 0;vertical-align:top"></a>`;
          })
          .join('')}</p>`
      : '';
    return `<h3 style="${font}font-size:17px;font-weight:600;margin:1.1em 0 0.3em;color:#1f3a5f">${escapeHtml(
      item.title,
    )}</h3>
${body}${images}`;
  });
  return `<div style="${font}font-size:16px;line-height:1.5;color:#111">
${blocks.join('\n')}
</div>`;
}

/**
 * The "get the app" line the Preview's checkbox adds below the announcements, under a rule: a link that lets the
 * reader in, and the day it stops working so an old email explains itself. Inline-styled for the
 * same reason as the rest of the preview. `data-app-link` is how the dashboard script finds it and
 * how `public/preview-pdf.js` knows to set it as the PDF's closing block, beside a QR of the same link.
 */
export function appLinkHtml(link: { url: string; through: string | null }): string {
  const until = link.through
    ? ` <span style="color:#666">This link works through ${escapeHtml(link.through)}.</span>`
    : '';
  return `<p data-app-link style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;margin:1.6em 0 0;padding:12px 0 0;border-top:1px solid #bbb"><a href="${escapeHtml(
    link.url,
  )}" style="color:#1f3a5f;font-weight:600">Get these announcements on your phone each week</a>.${until}</p>`;
}

/**
 * The preview's controls — copy, save as PDF, open as a page — and the script behind them. Shared
 * by the dashboard's modal and the standalone page so the two cannot drift. `bodyId` names the
 * element holding the preview markup.
 *
 * Copy writes both flavours — `text/html` so the paste keeps its headings and links, `text/plain`
 * for a client that takes only text — through the async Clipboard API, and falls back to selecting
 * the preview and `execCommand('copy')` where `ClipboardItem` is missing (Firefox behind a flag,
 * older WebViews). Save as PDF hands the same element to `public/preview-pdf.js`, which builds a
 * pdfmake document from it (pdfmake loads on first use). Either way the button says what happened.
 */
function previewControls(bodyId: string, opts: { pageLink?: boolean } = {}): string {
  return `<div class="preview-actions">
        <button type="button" class="btn small primary" data-copy-preview="${bodyId}">Copy</button>
        <button type="button" class="btn small" data-pdf-preview="${bodyId}" data-title="${escapeHtml(config.appName)}">Save as PDF</button>
        ${
          opts.pageLink
            ? `<a class="btn small" href="/admin/announcements/preview" target="_blank" rel="noopener">Open as a Page</a>`
            : ''
        }
        <label class="muted small"><input type="checkbox" data-app-link-toggle="${bodyId}"> Include a link to the app</label>
        <span class="spinner" data-pdf-spinner hidden aria-hidden="true"></span>
        <span class="muted small" data-copy-status hidden aria-live="polite"></span>
      </div>`;
}

const previewScript = (): string => `${scriptTag()}
    (function () {
      function selectAll(el) {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return sel;
      }
      // "sticky" keeps the message up (and the spinner turning) until the next say(); otherwise it
      // clears itself after a moment.
      function say(btn, text, sticky) {
        var bar = btn.closest('.preview-actions');
        var status = bar.querySelector('[data-copy-status]');
        var spinner = bar.querySelector('[data-pdf-spinner]');
        if (!status) return;
        status.textContent = text;
        status.hidden = false;
        if (spinner) spinner.hidden = !sticky;
        clearTimeout(status._t);
        if (!sticky) status._t = setTimeout(function () { status.hidden = true; }, 2500);
      }
      // "Include a link to the app" puts the line into the preview itself, so Copy and Save as PDF
      // carry it without knowing about it. Fetched when the box is ticked rather than when Copy is
      // pressed: Safari only lets a page write the clipboard inside the click, not after a fetch.
      document.addEventListener('change', function (e) {
        var box = e.target.closest('[data-app-link-toggle]');
        if (!box) return;
        var el = document.getElementById(box.getAttribute('data-app-link-toggle'));
        if (!el) return;
        var old = el.querySelector('[data-app-link]');
        if (old) old.parentNode.removeChild(old);
        if (!box.checked) return;
        box.disabled = true;
        fetch('/admin/announcements/preview/link', { method: 'POST', headers: { accept: 'application/json' } })
          .then(function (r) { if (!r.ok || r.redirected) throw new Error('fetch failed'); return r.json(); })
          .then(function (data) {
            var holder = document.createElement('div');
            holder.innerHTML = data.html;
            if (!holder.firstChild) throw new Error('empty');
            el.appendChild(holder.firstChild);
          })
          .catch(function () {
            box.checked = false;
            say(box, 'Could not make the link — reload the page and try again.');
          })
          .then(function () { box.disabled = false; });
      });
      document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-copy-preview]');
        if (!btn) return;
        var el = document.getElementById(btn.getAttribute('data-copy-preview'));
        if (!el) return;
        var html = el.innerHTML;
        var text = el.innerText;
        var rich = navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined';
        var done = function () { say(btn, 'Copied — paste into a message or document.'); };
        var fallback = function () {
          try {
            selectAll(el);
            var ok = document.execCommand('copy');
            window.getSelection().removeAllRanges();
            if (ok) return done();
          } catch (err) { /* fall through */ }
          selectAll(el);
          say(btn, 'Press ' + (navigator.platform.indexOf('Mac') === 0 ? '⌘C' : 'Ctrl+C') + ' to copy the selection.');
        };
        if (!rich) return fallback();
        navigator.clipboard
          .write([new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([text], { type: 'text/plain' }),
          })])
          .then(done, fallback);
      });
      document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-pdf-preview]');
        if (!btn) return;
        var el = document.getElementById(btn.getAttribute('data-pdf-preview'));
        if (!el) return;
        if (!window.PreviewPdf) return say(btn, 'Still loading — try again in a moment.');
        btn.disabled = true;
        window.PreviewPdf.download(el, {
          title: btn.getAttribute('data-title'),
          onStatus: function (text) { say(btn, text, true); },
        })
          .then(function (name) { say(btn, 'Saved ' + name + '.'); })
          .catch(function () { say(btn, 'Could not make the PDF — try the Copy button instead.'); })
          .then(function () { btn.disabled = false; });
      });
    })();
  </script>
  <script src="/preview-pdf.js" defer></script>`;

/**
 * The preview on its own page — the same markup as the dashboard's modal, for a mail client or
 * word processor where a select-all from a plain page pastes more faithfully than the clipboard
 * write does.
 */
export function richPreviewPage(preview: string, role: Role): string {
  return layout(
    'Preview',
    `    <section class="card">
      <div class="section-head">
        <h2>Preview</h2>
        <a class="btn small" href="/admin#content">← Dashboard</a>
      </div>
      <p class="muted small">The announcements members can see right now, as formatted text. Copy
        it into a message or document, or save it as a PDF.</p>
      ${previewControls('preview-page-body')}
      <div id="preview-page-body" class="rendered preview-block">${preview}</div>
    </section>`,
    { showLogout: true, role, bodyEnd: previewScript() },
  );
}

/**
 * Two columns on a wide screen, one on a phone (the breakpoint is in styles.css). Empty sections
 * are dropped, and a tab with nothing for the right-hand column — an editor's Sharing tab — stays
 * one column rather than leaving half the page blank.
 */
function columns(left: string[], right: string[], opts: { phoneOrder?: boolean } = {}): string {
  const l = left.filter(Boolean).join('\n');
  const r = right.filter(Boolean).join('\n');
  if (!r) return `    <div class="cols one">\n      <div class="col">\n${l}\n      </div>\n    </div>`;
  return `    <div class="cols${opts.phoneOrder ? ' phone-order' : ''}">
      <div class="col">
${l}
      </div>
      <div class="col">
${r}
      </div>
    </div>`;
}

/**
 * The strip above the tabs: is everything OK, at a glance? Live announcements, today's program,
 * subscribers and the next notification — each worked out from what the dashboard already has, so
 * it costs no query of its own. Every number here is one an editor is already shown elsewhere on
 * the page (the subscriber *count* is; the list behind it is not, so the tile does not link there).
 * On a phone only the first and last tiles show (styles.css).
 */
function summaryStrip(data: {
  publicCount: number;
  subscribers: number;
  announcements: AnnouncementRow[];
  programs: { recent: ProgramListRow[]; settings: ProgramSettings; today: string; windowOpenNow: boolean };
  schedule: ScheduleData;
  nextSendAt: Date | null;
}): string {
  const today = data.programs.today;
  const tile = (cls: string, label: string, value: string, note = '') =>
    `      <li class="tile ${cls}"><span class="tile-label">${label}</span>
        <span class="tile-value">${value}</span>${note ? ` <span class="tile-note">${note}</span>` : ''}</li>`;

  // Ending this week, among those members can see now.
  const endingSoon = data.announcements.filter((a) => {
    if (!a.published || !a.expires_at || a.expires_at < today) return false;
    const left = daysBetween(today, a.expires_at);
    return left !== null && left <= ENDS_SOON_DAYS;
  });
  const drafts = data.announcements.filter((a) => !a.published).length;
  const annNote =
    endingSoon.length === 1
      ? `1 ends ${
          endingSoon[0]!.expires_at === today ? 'today' : escapeHtml(weekdayShort(endingSoon[0]!.expires_at!))
        }`
      : endingSoon.length > 1
        ? `${endingSoon.length} end this week`
        : drafts
          ? `${drafts} draft${drafts === 1 ? '' : 's'}`
          : '';

  const { settings, windowOpenNow, recent } = data.programs;
  const todays = recent.some((p) => p.program_date === today);
  const upcoming = recent
    .filter((p) => p.program_date > today)
    .reduce<string | null>((soonest, p) => (soonest === null || p.program_date < soonest ? p.program_date : soonest), null);
  const program = todays
    ? windowOpenNow
      ? tile('t-program', "Today's Program", 'Showing now', `until ${escapeHtml(clockLabel(settings.end))}`)
      : tile(
          't-program',
          "Today's Program",
          'Today',
          `${escapeHtml(clockLabel(settings.start))}–${escapeHtml(clockLabel(settings.end))}`,
        )
    : upcoming
      ? tile('t-program', 'Next Program', escapeHtml(rowDate(upcoming, today)), 'ready')
      : tile('t-program', 'Next Program', 'None yet');

  let next: string;
  if (!data.schedule.autoSend) next = tile('t-next', 'Next Notification', 'Off', 'automatic sending');
  else if (!data.nextSendAt) next = tile('t-next', 'Next Notification', 'None scheduled');
  else {
    const at = data.nextSendAt;
    const tz = config.timezone;
    const day = at.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
    const time = at.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const date = at.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    next = tile('t-next', 'Next Notification', `${escapeHtml(day)} ${escapeHtml(time)}`, `${escapeHtml(date)} · automatic`);
  }

  return `    <ul class="strip" aria-label="At a glance">
${tile('t-ann', 'Announcements', `${data.publicCount} live`, annNote)}
${program}
${tile('t-subs', 'Subscribers', String(data.subscribers))}
${next}
    </ul>`;
}

/**
 * The one dashboard, rendered for whichever role asked for it.
 *
 * Not two pages: an editor's view is this page with the configuration cards left out, and keeping
 * them in one function is what stops the announcement list, the program list and the share link
 * from drifting into two versions. Everything an editor must not have hangs off `data.admin`, which
 * `app.ts` only builds — and only runs the queries for — when the session is an admin one. So the
 * type is also the list: if it's in there, an editor never sees it.
 */
export function dashboardPage(data: {
  role: Role;
  subscribers: number;
  publicCount: number;
  announcements: AnnouncementRow[];
  /** The Resources tab's pages, every one, in display order. */
  pages: PageRow[];
  /** `richPreviewHtml()` of the announcements members can see right now — the modal's content. */
  preview: string;
  sends: SendHistoryRow[];
  /** The signed-in person's id, to mark "you" on the People list; null for the owner. */
  selfId: number | null;
  /** Deliveries still in the send queue (any send). Non-zero means a send is in progress or retrying. */
  queued: number;
  programs: {
    recent: ProgramListRow[];
    settings: ProgramSettings;
    /** Today's local date, so the list can mark the one members can see. */
    today: string;
    windowOpenNow: boolean;
    maxRetentionDays: number;
  };
  access: AccessData;
  /** When the weekly notification goes out. Both roles — see `ScheduleData`. */
  schedule: ScheduleData;
  /**
   * When sacrament meeting starts (null until one is saved), and whether the program hours and the
   * schedule still follow from it (`meeting.ts`). Both roles: the Day and Time row says which.
   */
  meeting: { time: MeetingTime | null; timing: TimingStatus };
  /**
   * The next weekly send, after any skipped Sundays — or null when there is none to come. Both
   * roles: an editor is already shown the schedule and the skip list it is worked out from.
   */
  nextSendAt: Date | null;
  /**
   * Sundays the weekly notification will not go out on, soonest first. Both roles, deliberately.
   *
   * An editor can already cause a week to be skipped — publish nothing and the digest suppresses
   * itself — so withholding the explicit control would protect nothing and only put the person most
   * likely to know Conference is coming (they are the one not writing a program for it) in the
   * position of having to ask.
   */
  skips: SendSkipRow[];
  /** Today's local date: the earliest Sunday that can still be skipped. */
  today: string;
  flash?: string;
  /** Admin-only cards and the settings behind them. Absent for an editor session. */
  admin?: AdminData;
  /** The ward's own settings (Settings → Ward Settings). Admin only, like `admin`. */
  ward?: { settings: WardSettings; limits: typeof WARD_LIMITS; gettingStartedHidden?: boolean };
  /** The first-run checklist (admins, until dismissed or done). Absent = not shown. */
  gettingStarted?: GettingStarted;
}): string {
  const admin = data.admin;

  // Three tabs, the same control the public page uses, because one long page had grown to nine
  // cards with no grouping. The split is by *errand*: what members read (Content), what goes out
  // and when (Notifications), who can get in and the ward's own settings (Settings, which an editor sees as Sharing: the share
  // link is all of it they can use). Content is the
  // default because it is where an editor lives and the first thing an admin usually came to do.
  // Every form redirects back to its own tab (`dash()` in app.ts), and the flash sits above the tab
  // bar so it is read whichever tab opens. Selection is client-side by hash, as on the public page,
  // so a bookmark or a back press lands on the tab it left.
  const tabBar = `    <nav class="tabs" role="tablist" aria-label="Dashboard sections">
      <button id="tab-content" class="tab is-active" type="button" role="tab"
              aria-controls="panel-content" aria-selected="true" tabindex="0">Content</button>
      <button id="tab-notifications" class="tab" type="button" role="tab"
              aria-controls="panel-notifications" aria-selected="false" tabindex="-1">Notifications</button>
      <button id="tab-settings" class="tab" type="button" role="tab"
              aria-controls="panel-settings" aria-selected="false" tabindex="-1">${data.role === 'editor' ? 'Sharing' : 'Settings'}</button>
    </nav>`;

  const sendDay = DOW[data.schedule.dow] ?? 'Sunday';
  const when = `${escapeHtml(sendDay)}s, ${escapeHtml(clockLabel(data.schedule.time))}`;
  // The day and time are set from the meeting time now (Ward Settings), so this row only reports
  // them, for both roles. The admin's says where to change them, with the same section jump Get
  // Started uses; an editor has no Ward Settings to jump to.
  const whenSource =
    data.meeting.timing === 'derived'
      ? 'From your meeting time'
      : data.meeting.timing === 'custom'
        ? 'Custom'
        : 'Default';
  const whenRow = settingRow({
    label: 'Day and Time',
    sub: admin
      ? `${whenSource} · <a href="#sacrament-meeting" data-section="sacrament-meeting">Change</a>`
      : whenSource,
    value: when,
  });
  const nextSkip = data.skips[0];
  const skipValue = nextSkip
    ? `${escapeHtml(rowDate(nextSkip.skip_date, data.today, false))}${
        nextSkip.note ? ` (${escapeHtml(nextSkip.note)})` : ''
      }${data.skips.length > 1 ? ` +${data.skips.length - 1} more` : ''}`
    : 'None';
  const skipRow = settingRow({
    label: `Skipped ${escapeHtml(sendDay)}s`,
    value: skipValue,
    body: skipSettingBody(data.skips, data.today, data.schedule),
  });

  // The subscriber count for both roles; the list behind it only for an admin — that page is every
  // member's device and a button that removes them.
  const counts = `${
    admin
      ? `<a href="/admin/subscribers"><strong>${data.subscribers}</strong> ${plural(data.subscribers, 'subscriber')}</a>`
      : `<strong>${data.subscribers}</strong> ${plural(data.subscribers, 'subscriber')}`
  } · <strong>${data.publicCount}</strong> live ${plural(data.publicCount, 'announcement')}`;

  const weekly = group({
    title: 'Weekly Notification',
    help: counts,
    body: settingsList(
      admin
        ? [
            switchRow({
              label: 'Send Automatically',
              action: '/admin/settings',
              name: 'auto_send',
              checked: data.schedule.autoSend,
            }),
            whenRow,
            settingRow({
              label: 'Message',
              value:
                admin.weeklyTitle || admin.weeklyBody
                  ? `“${escapeHtml(admin.weeklyTitle || admin.weeklyBody)}”`
                  : 'Using the default',
              body: `<form method="post" action="/admin/weekly-message" class="admin-form">
            <label for="weekly_title">Title</label>
            <input id="weekly_title" name="weekly_title" type="text" maxlength="80"
                   value="${escapeHtml(admin.weeklyTitle)}" placeholder="${escapeHtml(DEFAULT_WEEKLY_TITLE)}" />
            <label for="weekly_body">Message</label>
            <textarea id="weekly_body" name="weekly_body" maxlength="300"
                      placeholder="There are 3 current announcements — tap to view.">${escapeHtml(
                        admin.weeklyBody,
                      )}</textarea>
            <p class="muted small">Leave blank to use the automatic defaults. Use <code>{count}</code>
            for the current number of announcements.</p>
            <div class="actions"><button class="btn small primary" type="submit">Save Message</button></div>
          </form>`,
            }),
            skipRow,
          ]
        : // An editor sees when it goes out but cannot change it — except the skipped Sundays,
          // which are theirs as much as the admin's (see `skips` on the dashboard data).
          [
            settingRow({ label: 'Send Automatically', value: data.schedule.autoSend ? 'On' : 'Off' }),
            whenRow,
            skipRow,
          ],
    ),
    after: admin
      ? `      <p class="group-help under">Next: ${escapeHtml(admin.nextRunLabel)} (${escapeHtml(
          timezoneShort(admin.timezone),
        )})${
          admin.nextRunSkipped > 0
            ? ` · ${admin.nextRunSkipped} skipped ${escapeHtml(sendDay)}${
                admin.nextRunSkipped === 1 ? '' : 's'
              } before it`
            : ''
        }${data.schedule.autoSend ? '' : ' · auto-send is currently off'}</p>`
      : weeklySentence(data.schedule),
  });

  const recentSends = group({
    title: 'Recent Sends',
    // The manual push is admin-only: it is the one control that reaches every phone at once.
    reveal: admin ? { label: 'Send One Now', body: sendNowForm(data.subscribers) } : undefined,
    help:
      data.queued > 0
        ? `${data.queued} ${data.queued === 1 ? 'delivery is' : 'deliveries are'} still queued — a
          send is going out, or retrying a push service that answered slowly.`
        : undefined,
    body: `      <ul class="rows send-log">
${data.sends.map((s) => sendRow(s)).join('\n') || '        <li class="row row-empty">No sends yet.</li>'}
      </ul>`,
  });

  return layout(
    'Dashboard',
    `    ${admin?.sendAlert ? `<div class="card warn">⚠️ ${escapeHtml(admin.sendAlert)}</div>` : ''}
    ${data.flash ? `<div class="card flash">${escapeHtml(data.flash)}</div>` : ''}
${summaryStrip(data)}
${data.gettingStarted ? gettingStartedBanner(data.gettingStarted) : ''}
${tabBar}

    <section id="panel-content" class="panel" role="tabpanel" aria-labelledby="tab-content" tabindex="0">
${columns(
  [announcementsGroup(data.announcements, data.today), pagesGroup(data.pages, data.today)],
  [programsGroup({ ...data.programs, isAdmin: !!admin }), contentPolicyGroup()],
  // On a phone: announcements, then this Sunday's program, then the standing pages and the policy.
  { phoneOrder: true },
)}

    <div id="preview-modal" class="sheet-backdrop" hidden>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="preview-modal-title">
        <div class="sheet-handle"></div>
        <button type="button" class="sheet-close" id="preview-modal-close" aria-label="Close">×</button>
        <h2 id="preview-modal-title">Preview &amp; Email</h2>
        <p class="muted small">What members see right now, as formatted text. Copy it into a
          message or document, or save it as a PDF.</p>
        ${previewControls('preview-modal-body', { pageLink: true })}
        <div id="preview-modal-body" class="rendered preview-block sheet-body">${data.preview}</div>
      </div>
    </div>

    <div id="ann-previews" hidden>${data.announcements
      .map((a) => `<div data-preview-id="${a.id}">${renderMarkdown(a.body)}</div>`)
      .join('')}</div>

    <div id="ann-modal" class="sheet-backdrop" hidden>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ann-modal-title">
        <div class="sheet-handle"></div>
        <button type="button" class="sheet-close" id="ann-modal-close" aria-label="Close">×</button>
        <h2 id="ann-modal-title"></h2>
        <div id="ann-modal-body" class="rendered sheet-body"></div>
      </div>
    </div>
${programPreviewModal()}
    </section>

    <section id="panel-notifications" class="panel" role="tabpanel" aria-labelledby="tab-notifications" tabindex="0" hidden>
${columns([weekly], [recentSends])}
    </section>

    <section id="panel-settings" class="panel" role="tabpanel" aria-labelledby="tab-settings" tabindex="0" hidden>
${columns(
  [shareGroup(data.access), admin ? peopleGroup(admin.people, data.selfId) : ''],
  [
    data.ward && admin
      ? wardSettingsGroup(data.ward.settings, data.ward.limits, admin, data.access, {
          meeting: data.meeting,
          program: data.programs.settings,
          maxRetentionDays: data.programs.maxRetentionDays,
          schedule: data.schedule,
          gettingStartedHidden: data.ward.gettingStartedHidden,
        })
      : '',
    admin ? backupCard() : '',
    accessManagementGroup(data.access, admin),
  ],
)}
    </section>

    ${scriptTag()}
      // Tab selection, mirroring public/app.js: the hash names the tab, the buttons update it with
      // replaceState (switching tabs is not a history entry worth a back press), and an unknown or
      // missing hash means Content.
      (function () {
        var TABS = ['content', 'notifications', 'settings'];
        // A hash names a tab, or a section inside one (#people, #ward-settings): a section opens the
        // tab that holds it.
        function tabOf(name) {
          if (TABS.indexOf(name) > -1) return name;
          var el = name && document.getElementById(name);
          var panel = el && el.closest ? el.closest('[id^="panel-"]') : null;
          return panel ? panel.id.replace(/^panel-/, '') : 'content';
        }
        function fromHash() {
          return tabOf((location.hash || '').replace(/^#/, ''));
        }
        // Bring a section into view and mark it for a moment, so a link to a section on the tab
        // already showing still visibly does something.
        function reveal(name) {
          var el = TABS.indexOf(name) > -1 ? null : document.getElementById(name);
          if (!el) return;
          // A settings row (Sacrament Meeting) is a <details>: open it, as a link to it means "change this".
          var fold = el.classList.contains('set-row') ? el.querySelector('details') : null;
          if (fold) fold.open = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el.classList.remove('is-flashing');
          void el.offsetWidth;
          el.classList.add('is-flashing');
          setTimeout(function () { el.classList.remove('is-flashing'); }, 1600);
        }
        function go(name) {
          var tab = tabOf(name);
          show(tab, false);
          // A section's hash is a one-off jump: the address goes back to naming the tab, as
          // switching tabs leaves it.
          if (name && TABS.indexOf(name) < 0 && document.getElementById(name)) {
            history.replaceState(null, '', location.pathname + location.search + '#' + tab);
            reveal(name);
          }
        }
        document.addEventListener('click', function (event) {
          var link = event.target.closest && event.target.closest('a[data-section]');
          if (!link) return;
          event.preventDefault();
          go(link.getAttribute('data-section'));
        });
        function show(name, updateHash, focus) {
          for (var i = 0; i < TABS.length; i++) {
            var tab = TABS[i];
            var button = document.getElementById('tab-' + tab);
            var panel = document.getElementById('panel-' + tab);
            if (!button || !panel) continue;
            var active = tab === name;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
            // Roving tabindex: the tab list is one Tab stop and the arrow keys move within it; each
            // panel carries tabindex="0" in the markup so the next Tab press lands on it.
            button.tabIndex = active ? 0 : -1;
            if (active && focus) button.focus();
            panel.hidden = !active;
          }
          if (updateHash && fromHash() !== name) {
            history.replaceState(null, '', location.pathname + location.search + '#' + name);
          }
        }
        for (var i = 0; i < TABS.length; i++) {
          (function (tab) {
            var button = document.getElementById('tab-' + tab);
            if (button) button.addEventListener('click', function () { show(tab, true, false); });
          })(TABS[i]);
        }
        // Left/Right (wrapping) and Home/End move selection and focus together, as the ARIA tab
        // pattern promises once a button says role="tab".
        var tablist = document.querySelector('.tabs[role="tablist"]');
        if (tablist) {
          tablist.addEventListener('keydown', function (event) {
            var current = TABS.indexOf((event.target.id || '').replace(/^tab-/, ''));
            if (current < 0) return;
            var next;
            if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
            else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = TABS.length - 1;
            else return;
            event.preventDefault();
            show(TABS[next], true, true);
          });
        }
        window.addEventListener('hashchange', function () { go((location.hash || '').replace(/^#/, '')); });
        go((location.hash || '').replace(/^#/, ''));
      })();
    </script>

    ${scriptTag()}
      (function () {
        var input = document.getElementById('custom-url');
        if (!input) return;
        var radios = document.querySelectorAll('input[name="link_target"]');
        function sync(focusOnEnable) {
          var custom = document.querySelector('input[name="link_target"][value="custom"]');
          var on = custom && custom.checked;
          input.disabled = !on;
          if (on && focusOnEnable) input.focus();
        }
        for (var i = 0; i < radios.length; i++) {
          radios[i].addEventListener('change', function () { sync(true); });
        }
        sync(false);
      })();
    </script>`,
    {
      showLogout: true,
      role: data.role,
      wide: true,
      // Drag-to-reorder the announcements list (SortableJS, vendored). On drop, POST the new id
      // order to the server, which rewrites sort_order to 0..n.
      bodyEnd: `<script src="/vendor/sortable.min.js"></script>
  ${scriptTag()}
    (function () {
      if (typeof Sortable === 'undefined') return;
      // Two sortable lists, one recipe: the announcements and the resource pages each POST their
      // new id order to their own endpoint.
      [['ann-rows', '/admin/announcements/reorder'], ['page-rows', '/admin/pages/reorder']].forEach(function (pair) {
        var list = document.getElementById(pair[0]);
        if (!list || list.querySelectorAll('[data-id]').length < 2) return;
        Sortable.create(list, {
          handle: '.drag-handle',
          animation: 150,
          onEnd: function () {
            var ids = Array.prototype.map.call(list.querySelectorAll('[data-id]'), function (row) {
              return Number(row.getAttribute('data-id'));
            });
            // An expired session answers with a redirect to the sign-in page, which fetch would
            // follow to a 200 and report as saved; left unfollowed, it is the one thing to say.
            fetch(pair[1], {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: ids }),
              redirect: 'manual',
            })
              .then(function (r) {
                if (r.type === 'opaqueredirect' || r.redirected) throw new Error('signed out');
                if (!r.ok) throw new Error('save failed');
              })
              .catch(function (err) {
                alert(err.message === 'signed out'
                  ? 'Signed out — sign in again, then reload and try again.'
                  : 'Could not save the new order — please reload and try again.');
              });
          },
        });
      });
    })();
  </script>
  ${scriptTag()}
    (function () {
      var modal = document.getElementById('ann-modal');
      var titleEl = document.getElementById('ann-modal-title');
      var bodyEl = document.getElementById('ann-modal-body');
      var store = document.getElementById('ann-previews');
      var closeBtn = document.getElementById('ann-modal-close');
      if (!modal || !store) return;
      var last = null;
      function openModal(id, title, trigger) {
        var src = store.querySelector('[data-preview-id="' + id + '"]');
        titleEl.textContent = title;
        bodyEl.innerHTML = src && src.innerHTML.trim() ? src.innerHTML : '<p class="muted">No content.</p>';
        // The trigger is a ⋯ menu item that folds away with its menu: focus returns to the menu.
        var menu = trigger.closest('.row-menu');
        last = menu ? menu.querySelector('summary') : trigger;
        modal.hidden = false;
        document.body.style.overflow = 'hidden';
        closeBtn.focus();
      }
      function closeModal() {
        modal.hidden = true;
        document.body.style.overflow = '';
        if (last) last.focus();
      }
      document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-preview]');
        if (t) openModal(t.getAttribute('data-preview'), t.getAttribute('data-preview-title') || t.textContent, t);
      });
      closeBtn.addEventListener('click', closeModal);
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
    })();
  </script>
  ${scriptTag()}
    (function () {
      var modal = document.getElementById('preview-modal');
      var openBtn = document.getElementById('preview-btn');
      var closeBtn = document.getElementById('preview-modal-close');
      var body = document.getElementById('preview-modal-body');
      if (!modal || !openBtn) return;
      // The modal's markup was rendered with the page; a reorder or an edit since then has changed
      // what is live. Refetch on every open and swap the body in — the stale copy shows meanwhile,
      // and stays if the fetch fails.
      var opened = 0;
      function refresh() {
        var token = ++opened;
        fetch('/admin/announcements/preview/fragment', { headers: { accept: 'text/html' }, cache: 'no-store' })
          // An expired session is redirected to the login page with a 200 — keep the stale copy
          // rather than showing the login form inside the modal.
          .then(function (r) { if (!r.ok || r.redirected) throw new Error('fetch failed'); return r.text(); })
          .then(function (markup) {
            if (token !== opened || !body) return;
            // The app-link line is added by the checkbox, not by the server: carry it across.
            var link = body.querySelector('[data-app-link]');
            body.innerHTML = markup;
            if (link) body.appendChild(link);
          })
          .catch(function () {});
      }
      function open() {
        refresh();
        modal.hidden = false;
        document.body.style.overflow = 'hidden';
        closeBtn.focus();
      }
      function close() {
        modal.hidden = true;
        document.body.style.overflow = '';
        openBtn.focus();
      }
      openBtn.addEventListener('click', open);
      closeBtn.addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) close(); });
    })();
  </script>
  ${scriptTag()}
    // The rows' ⋯ menus. Each is a <details>, so it already opens by keyboard and touch; this adds
    // what a menu is expected to do besides: one open at a time, closed by a click elsewhere or by
    // Escape (focus back on its button), and folded away once an item is chosen.
    (function () {
      var menus = document.querySelectorAll('.row-menu');
      function closeAll(except) {
        for (var i = 0; i < menus.length; i++) if (menus[i] !== except) menus[i].open = false;
      }
      for (var i = 0; i < menus.length; i++) {
        menus[i].addEventListener('toggle', function (e) { if (e.target.open) closeAll(e.target); });
      }
      document.addEventListener('click', function (e) {
        var menu = e.target.closest('.row-menu');
        if (!menu) return closeAll(null);
        // A Preview item; Delete is left alone so its confirm() runs with the menu as it was.
        if (e.target.closest('button.menu-item[type="button"]')) menu.open = false;
      });
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var open = document.querySelector('.row-menu[open]');
        if (!open) return;
        open.open = false;
        open.querySelector('summary').focus();
      });
    })();
  </script>
  ${scriptTag()}
    // A settings switch saves as soon as it is flipped; without script its Save button does it.
    (function () {
      var switches = document.querySelectorAll('[data-autosubmit]');
      for (var i = 0; i < switches.length; i++) {
        switches[i].addEventListener('change', function (e) {
          var form = e.target.form;
          if (form.requestSubmit) form.requestSubmit(); else form.submit();
        });
      }
    })();
    // Copy Link: the Clipboard API where there is one, else the link is selected for a manual copy.
    (function () {
      document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-copy-link]');
        if (!btn) return;
        var el = document.getElementById(btn.getAttribute('data-copy-link'));
        var status = btn.parentNode.querySelector('[data-copy-link-status]');
        if (!el) return;
        function say(text) {
          if (!status) return;
          status.textContent = text;
          clearTimeout(status._t);
          status._t = setTimeout(function () { status.textContent = ''; }, 3000);
        }
        function select() {
          var range = document.createRange();
          range.selectNodeContents(el);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        function fallback() {
          select();
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
          if (ok) { window.getSelection().removeAllRanges(); say('Copied.'); }
          else say('Selected — press ' + (navigator.platform.indexOf('Mac') === 0 ? '⌘C' : 'Ctrl+C') + ' to copy.');
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(el.textContent.trim()).then(function () { say('Copied.'); }, fallback);
        } else fallback();
      });
    })();
  </script>
  ${previewScript()}
  <script src="/flyer-pdf.js" defer></script>`,
    },
  );
}

function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android';
  if (/macintosh|mac os x/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows';
  return 'Other';
}

/**
 * What tells two iPhones apart on the Subscribers page: the push service's host and the tail of
 * the endpoint ("web.push.apple.com …a1b2c3d4e5"), as a tooltip. The tail only — the full endpoint
 * is a capability (anyone holding it can post to that device), and the page is HTML an admin may
 * copy or screenshot. Ten characters are enough to see a re-subscribe land as a new row.
 */
function deviceHint(endpoint: string): string {
  let host = '';
  try {
    host = new URL(endpoint).host;
  } catch {
    host = 'unknown push service';
  }
  return `${host} …${endpoint.slice(-10)}`;
}

/** The subscriber list: one row per device that turned notifications on. */
export function subscribersPage(data: {
  subscribers: SubscriptionRow[];
  flash?: string;
}): string {
  const rows =
    data.subscribers
      .map(
        (s) => `      <tr>
        <td title="${escapeHtml(deviceHint(s.endpoint))}">${escapeHtml(deviceLabel(s.user_agent))}</td>
        <td class="muted small">${escapeHtml(shortDate(s.created_at))}</td>
        <td class="muted small">${
          s.last_success_at ? escapeHtml(shortDate(s.last_success_at)) : 'never'
        }</td>
        <td class="row-actions">
          <form method="post" action="/admin/subscribers/${s.id}/delete"
                data-confirm="Remove this subscriber? They stop getting notifications on that device; their app turns them off at its next launch, and they can turn them on again themselves.">
            <button class="btn small danger" type="submit">Remove</button>
          </form>
        </td>
      </tr>`,
      )
      .join('\n') || `      <tr><td colspan="4" class="muted">No subscribers yet.</td></tr>`;

  return layout(
    'Subscribers',
    `    <section class="card">
      <div class="section-head">
        <h2>Subscribers (${data.subscribers.length})</h2>
        <a class="btn small" href="/admin#notifications">Back</a>
      </div>
      ${data.flash ? `<p class="ok">${escapeHtml(data.flash)}</p>` : ''}
      <p class="muted small">Everyone who enabled notifications.
      Removing one stops their notifications on that device; their app turns them off at its next
      launch, and they can turn them on again themselves.</p>
      <table class="admin-table">
        <thead><tr><th>Device</th><th>Joined</th><th>Last Sent OK</th><th></th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </section>`,
    { showLogout: true },
  );
}

/** An attachment on an editor page; a PDF carries the link to open it (`dashboardPdfHref` in app.ts). */
export type EditorAttachment = AttachmentRow & { pdfHref?: string };

/**
 * One thumbnail in the editor's Images list. `data-attachment` carries the row id, which is what
 * the delete button and the upload script address rows by. A PDF shows its first page, badged, as a
 * link to the PDF itself.
 */
function attachmentThumb(row: EditorAttachment): string {
  const img = `<img src="/images/${escapeHtml(row.thumb_key ?? row.key)}" alt="${escapeHtml(row.filename ?? '')}" loading="lazy" />`;
  return `          <li class="attachment" data-attachment="${row.id}">
            ${
              row.thumb_key
                ? `<a class="pdf-thumb" href="${escapeHtml(row.pdfHref ?? `/images/${row.key}`)}" target="_blank" rel="noopener">${img}<span class="pdf-badge">PDF</span></a>`
                : img
            }
            <button type="button" class="btn small danger" data-delete-attachment="${row.id}">Remove</button>
          </li>`;
}

/**
 * The Images card, shared by the announcement and program editors.
 *
 * Images are uploaded on their own, outside the content form, as soon as they are chosen. On an
 * Edit page they attach to the row at once. On a New page there is no row yet, so they are stored
 * as *pending* and their ids ride in a hidden field of the content form, whose save claims them;
 * one never saved is swept after a day. Hence the `pending` wording there.
 *
 * `data-owner-type` is read back by the upload script, which is the whole reason one card serves
 * both editors: the owner type is data on the element rather than a constant in the script.
 */
function imagesCard(opts: {
  ownerType: string;
  ownerId?: number;
  attachments?: EditorAttachment[];
  maxAttachments: number;
  blurb: string;
  pending: string;
}): string {
  const attachments = opts.attachments ?? [];
  // On a New page the images are pending until the form is saved: their ids ride in a hidden field
  // that belongs to the content form (`form="content-form"`), and the save attaches them.
  const isNew = opts.ownerId === undefined;
  return `    <section class="card">
      <h3>Images and PDFs</h3>
      <p class="muted small">${opts.blurb} A PDF (up to ${Math.round(
        MAX_PDF_BYTES / (1024 * 1024),
      )} MB) shows its first page, and opens when tapped.${isNew ? ` ${opts.pending}` : ''}</p>
      ${
        isNew
          ? `<input type="hidden" name="pending_images" id="pending-images" form="content-form" value="${attachments
              .map((a) => a.id)
              .join(',')}" />`
          : ''
      }
      <ul class="attachment-grid" id="attachment-list" data-owner-type="${escapeHtml(
        opts.ownerType,
      )}" data-owner-id="${isNew ? '' : opts.ownerId}" data-max="${opts.maxAttachments}">
${attachments.map(attachmentThumb).join('\n')}
      </ul>
      <p class="muted small" id="attachment-empty"${attachments.length ? ' hidden' : ''}>No images or PDFs yet.</p>
      <div class="actions attachment-actions">
        <!-- The real file input, visually hidden but still focusable, under a label drawn as a
             button: the browser's own "Choose File / No file chosen" control matched nothing else
             on the page. Choosing a file uploads it — there is no second button to forget. -->
        <input id="image-input" class="file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" />
        <label for="image-input" class="btn small file-button">Add Image or PDF…</label>
      </div>
      <p class="muted small" id="image-status" aria-live="polite"></p>
    </section>`;
}

/** Nothing extra: the visual editor's styles are in /styles.css with the content they mirror. */
const EDITOR_HEAD = '';

/**
 * The editor scripts, shared by the three content forms: the visual editor over the Body textarea
 * (`editor/index.js`, bundled to /vendor/editor.js), and the out-of-band image uploader.
 *
 * `kind` picks the Markdown the editor reads and writes: a program has rows, an announcement or a
 * page does not — so a pipe in prose stays a pipe.
 */
function editorScripts(opts: { kind: 'announcement' | 'page' | 'program'; placeholder: string }): string {
  return `<script src="/vendor/editor.js"></script>
  ${scriptTag()}
    (function () {
      var el = document.getElementById('body');
      if (!el || typeof WardEditor === 'undefined') return; // the plain textarea still works
      WardEditor.mount(el, { kind: ${JSON.stringify(opts.kind)}, placeholder: ${JSON.stringify(opts.placeholder)} });
    })();
  </script>
  ${scriptTag()}
    // Image attachments. Uploads are their own request (POST /admin/attachments) rather than part
    // of the content form: they attach to a row that already exists, and they must not be lost if
    // the admin wanders off without pressing Save. The owner type comes off the list element, so
    // this one script serves announcements and programs alike.
    (function () {
      var list = document.getElementById('attachment-list');
      if (!list) return;
      var input = document.getElementById('image-input');
      var status = document.getElementById('image-status');
      var empty = document.getElementById('attachment-empty');
      var ownerType = list.getAttribute('data-owner-type');
      var ownerId = list.getAttribute('data-owner-id');
      var max = Number(list.getAttribute('data-max'));
      // A New page: uploads are pending, and their ids go in the content form for the save to claim.
      var pendingField = document.getElementById('pending-images');
      function pendingIds() {
        return pendingField && pendingField.value ? pendingField.value.split(',') : [];
      }
      function setPending(ids) {
        if (pendingField) pendingField.value = ids.join(',');
      }

      function count() {
        return list.querySelectorAll('[data-attachment]').length;
      }

      function sync() {
        var full = count() >= max;
        input.disabled = full;
        empty.hidden = count() > 0;
        if (full) status.textContent = 'That is the maximum of ' + max + ' images and PDFs.';
        else if (status.textContent.indexOf('maximum') > -1) status.textContent = '';
      }

      // Shrink in the browser before uploading. A current phone camera produces a 4000px, 3-8 MB
      // file — over the server's limit, and many times more than a phone-width page can show. The
      // exception is GIF: re-encoding one to JPEG would silently drop the animation, so those go
      // up as they are (and bounce off the size limit if they're enormous).
      function shrink(file) {
        if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') {
          return Promise.resolve(file);
        }
        return createImageBitmap(file)
          .then(function (bitmap) {
            var scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
            var w = Math.max(1, Math.round(bitmap.width * scale));
            var h = Math.max(1, Math.round(bitmap.height * scale));
            var canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
            if (bitmap.close) bitmap.close();
            return new Promise(function (resolve) {
              canvas.toBlob(
                function (blob) {
                  // Keep the original when re-encoding bought nothing and nothing was scaled —
                  // that's the small PNG (often with transparency) that JPEG would only make worse.
                  if (!blob || (scale === 1 && blob.size >= file.size)) return resolve(file);
                  var name = (file.name || 'image').replace(/\\.[^.]*$/, '') + '.jpg';
                  resolve(new File([blob], name, { type: 'image/jpeg' }));
                },
                'image/jpeg',
                0.85,
              );
            });
          })
          .catch(function () {
            return file; // an image this browser can't decode: let the server have its say
          });
      }

      // A PDF's thumbnail: its first page, drawn here with pdf.js (loaded only now, and only on the
      // dashboard) because the server has no CPU to spare for drawing one. 600px on the long side is
      // a member's 140px-high thumbnail at 3x and then some. White behind the page, since a PDF's
      // page is transparent where nothing is drawn and a JPEG would make that black.
      var PDF_MAX = ${MAX_PDF_BYTES};
      function isPdf(file) {
        return file.type === 'application/pdf' || /[.]pdf$/i.test(file.name || '');
      }
      function pdfThumb(file) {
        // The loading task, not the document, is what pdf.js 6 tears down (and its worker with it).
        var task;
        function done() {
          if (task) task.destroy().catch(function () {});
        }
        return import('/vendor/pdfjs/pdf.min.js')
          .then(function (pdfjs) {
            pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
            return file.arrayBuffer().then(function (buffer) {
              // Absolute, since the worker fetches them; see scripts/vendor-pdfjs.mjs for what each is.
              var base = location.origin + '/vendor/pdfjs/';
              task = pdfjs.getDocument({
                data: new Uint8Array(buffer),
                wasmUrl: base + 'wasm/',
                cMapUrl: base + 'cmaps/',
                cMapPacked: true,
                standardFontDataUrl: base + 'standard_fonts/',
                iccUrl: base + 'iccs/',
              });
              return task.promise;
            });
          })
          .then(function (doc) {
            return doc.getPage(1);
          })
          .then(function (page) {
            var base = page.getViewport({ scale: 1 });
            var viewport = page.getViewport({ scale: 600 / Math.max(base.width, base.height) });
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
              return new Promise(function (resolve, reject) {
                canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('no thumbnail')); }, 'image/jpeg', 0.85);
              });
            });
          })
          .then(
            function (blob) { done(); return blob; },
            function (err) { done(); throw err; },
          );
      }

      function addThumb(added) {
        var li = document.createElement('li');
        li.className = 'attachment';
        li.setAttribute('data-attachment', added.id);
        var img = document.createElement('img');
        img.src = added.url;
        img.alt = added.alt || '';
        img.loading = 'lazy';
        var shown = img;
        if (added.pdf) {
          shown = document.createElement('a');
          shown.className = 'pdf-thumb';
          shown.href = added.pdf;
          shown.target = '_blank';
          shown.rel = 'noopener';
          var badge = document.createElement('span');
          badge.className = 'pdf-badge';
          badge.textContent = 'PDF';
          shown.appendChild(img);
          shown.appendChild(badge);
        }
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn small danger';
        remove.setAttribute('data-delete-attachment', added.id);
        remove.textContent = 'Remove';
        li.appendChild(shown);
        li.appendChild(remove);
        list.appendChild(li);
      }

      function upload() {
        var file = input.files && input.files[0];
        if (!file) {
          status.textContent = 'Choose a file first.';
          return;
        }
        var pdf = isPdf(file);
        // Said here rather than after the upload: a PDF cannot be shrunk, and five megabytes is a
        // long wait on a phone for the server's 413.
        if (pdf && file.size > PDF_MAX) {
          status.textContent = 'PDFs must be under ' + Math.round(PDF_MAX / 1048576) + ' MB.';
          input.value = '';
          return;
        }
        input.disabled = true;
        status.textContent = pdf ? 'Preparing the PDF…' : 'Uploading…';
        var prepare = pdf
          ? pdfThumb(file).then(
              function (thumb) {
                status.textContent = 'Uploading…';
                return { file: file, thumb: thumb };
              },
              function (err) {
                console.error('PDF thumbnail failed', err); // the message below is for the clerk; this is for whoever debugs it
                if (err && err.name === 'PasswordException') {
                  throw new Error('That PDF is password-protected. Save a copy without the password, or attach a picture of it.');
                }
                throw new Error('Could not read that PDF. If it opens elsewhere, try another browser, or attach a picture of it.');
              },
            )
          : shrink(file).then(function (prepared) { return { file: prepared }; });
        prepare
          .then(function (prepared) {
            var data = new FormData();
            data.append('owner_type', ownerType);
            data.append('owner_id', ownerId); // empty on a New page: the upload is pending
            // A PDF goes up as one whatever the browser called it (some report no type at all).
            var upload = pdf ? new File([prepared.file], prepared.file.name || 'document.pdf', { type: 'application/pdf' }) : prepared.file;
            data.append('file', upload, upload.name || 'image.jpg');
            if (prepared.thumb) data.append('thumb', prepared.thumb, 'thumb.jpg');
            return fetch('/admin/attachments', { method: 'POST', body: data, redirect: 'manual' });
          })
          .then(function (res) {
            // An expired session is a redirect to the sign-in page, not JSON (see the reorder
            // script): say so, rather than showing the parse error.
            if (res.type === 'opaqueredirect' || res.redirected) throw new Error('Signed out — sign in again, then try the upload again.');
            return res.json().then(function (body) {
              if (!res.ok) throw new Error(body.error || 'Upload failed.');
              return body;
            });
          })
          .then(function (added) {
            addThumb(added);
            if (pendingField) setPending(pendingIds().concat(String(added.id)));
            input.value = '';
            status.textContent = '';
          })
          .catch(function (err) {
            status.textContent = err.message || 'Upload failed.';
          })
          .then(function () {
            // Cleared either way, so choosing the same file again after a failure still fires.
            input.value = '';
            input.disabled = false;
            sync();
          });
      }

      input.addEventListener('change', function () { if (input.files && input.files[0]) upload(); });
      list.addEventListener('click', function (e) {
        var target = e.target.closest('[data-delete-attachment]');
        if (!target) return;
        var item = target.closest('[data-attachment]');
        if (!confirm(item && item.querySelector('.pdf-thumb') ? 'Remove this PDF?' : 'Remove this image?')) return;
        target.disabled = true;
        fetch('/admin/attachments/' + target.getAttribute('data-delete-attachment'), {
          method: 'DELETE',
        })
          .then(function (res) {
            if (!res.ok) throw new Error('delete failed');
            var li = target.closest('[data-attachment]');
            if (li) li.remove();
            var removed = target.getAttribute('data-delete-attachment');
            setPending(pendingIds().filter(function (id) { return id !== removed; }));
            sync();
          })
          .catch(function () {
            target.disabled = false;
            status.textContent = 'Could not remove that — please try again.';
          });
      });
      sync();
    })();
  </script>`;
}

export function announcementForm(opts: {
  mode: 'new' | 'edit';
  announcement?: AnnouncementRow;
  attachments?: EditorAttachment[];
  /** A New form sent back after a rejected save: the images already uploaded to it, still pending. */
  pendingAttachments?: EditorAttachment[];
  maxAttachments?: number;
  error?: string;
  /**
   * What the clerk submitted, when a save was rejected. Rendered *over* the stored row so the page
   * comes back holding the text they typed rather than the last saved version of it — a rejected
   * save must not throw away ten minutes of retyping to say "Title is required".
   */
  draft?: Pick<AnnouncementRow, 'title' | 'body' | 'expires_at'> & { published: boolean | number };
  /** Only so the header names the right login — both roles may edit an announcement. */
  role?: Role | null;
}): string {
  const a =
    opts.announcement || opts.draft
      ? ({ ...(opts.announcement ?? {}), ...(opts.draft ?? {}) } as AnnouncementRow)
      : undefined;
  const maxAttachments = opts.maxAttachments ?? 10;
  const images = imagesCard({
    ownerType: 'announcement',
    ownerId: opts.mode === 'edit' && a ? a.id : undefined,
    attachments: opts.mode === 'new' ? opts.pendingAttachments : opts.attachments,
    maxAttachments,
    blurb: `Shown under this announcement on the public page — a flyer, a photo, a map. Tapping one
      opens it full-screen. Up to ${maxAttachments}; large photos are shrunk in your browser before
      they upload.`,
    pending: `They are attached to the announcement when you save it.`,
  });
  const action =
    opts.mode === 'new' ? '/admin/announcements' : `/admin/announcements/${a?.id}`;
  const title = opts.mode === 'new' ? 'New Announcement' : 'Edit Announcement';
  return layout(
    title,
    `    <section class="card">
      <div class="section-head">
        <h2>${title}</h2>
        <a class="btn small" href="/admin">Back</a>
      </div>
      ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
      <form method="post" action="${action}" id="content-form" class="admin-form announcement-editor">
        <label for="title">Title</label>
        <input id="title" name="title" type="text" maxlength="120" required
               value="${a ? escapeHtml(a.title) : ''}" />

        <label for="body">Body</label>
        <textarea id="body" name="body" rows="8">${a ? escapeHtml(a.body) : ''}</textarea>

        <label for="expires_at">Hide after <span class="muted small">(optional)</span></label>
        <input id="expires_at" name="expires_at" type="date" value="${a?.expires_at ? escapeHtml(a.expires_at) : ''}" />

        <label class="checkbox" style="margin-top:0.75rem">
          <input type="checkbox" name="published" value="1" ${!a || a.published ? 'checked' : ''} />
          Published (visible on the public page)
        </label>

        <div class="actions" style="margin-top:1rem">
          ${
            opts.mode === 'edit' && a
              ? `<button class="btn danger" type="submit" form="delete-announcement">Delete</button>
          <button class="btn primary" type="submit" style="margin-left:auto">Save</button>`
              : `<button class="btn primary" type="submit">Save</button>`
          }
        </div>
      </form>
      ${
        opts.mode === 'edit' && a
          ? `<form id="delete-announcement" method="post"
                action="/admin/announcements/${a.id}/delete"
                data-confirm="Delete this announcement and its images? This cannot be undone."></form>`
          : ''
      }
    </section>

${images}`,
    {
      showLogout: true,
      role: opts.role,
      head: EDITOR_HEAD,
      bodyEnd: editorScripts({ kind: 'announcement', placeholder: 'Write your announcement…' }),
    },
  );
}

/**
 * The resource page editor: the announcement form without the expiry field. A page is current until
 * someone edits it, so the only visibility control is the publish flag.
 */
export function pageForm(opts: {
  mode: 'new' | 'edit';
  page?: PageRow;
  attachments?: EditorAttachment[];
  /** A New form sent back after a rejected save: the images already uploaded to it, still pending. */
  pendingAttachments?: EditorAttachment[];
  maxAttachments?: number;
  error?: string;
  /** A message from the redirect that created this page (`?msg=`). */
  flash?: string;
  /** What was submitted when a save was rejected — see `announcementForm`. */
  draft?: Pick<PageRow, 'title' | 'body'> & { published: boolean | number };
  role?: Role | null;
}): string {
  const p =
    opts.page || opts.draft
      ? ({ ...(opts.page ?? {}), ...(opts.draft ?? {}) } as PageRow)
      : undefined;
  const maxAttachments = opts.maxAttachments ?? 10;
  const images = imagesCard({
    ownerType: 'page',
    ownerId: opts.mode === 'edit' && p ? p.id : undefined,
    attachments: opts.mode === 'new' ? opts.pendingAttachments : opts.attachments,
    maxAttachments,
    blurb: `Shown under this page on the Resources tab. Tapping one opens it full-screen. Up to
      ${maxAttachments}; large photos are shrunk in your browser before they upload. Images are
      served without the access code, so nothing personal belongs in one — put a list in the text,
      not in a picture of it.`,
    pending: `They are attached to the page when you save it.`,
  });
  const action = opts.mode === 'new' ? '/admin/pages' : `/admin/pages/${p?.id}`;
  const title = opts.mode === 'new' ? 'New Resource Page' : 'Edit Resource Page';
  return layout(
    title,
    `    <section class="card">
      <div class="section-head">
        <h2>${title}</h2>
        <a class="btn small" href="/admin">Back</a>
      </div>
      ${opts.flash ? `<p class="ok">${escapeHtml(opts.flash)}</p>` : ''}
      ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
      <form method="post" action="${action}" id="content-form" class="admin-form announcement-editor">
        <label for="title">Title</label>
        <input id="title" name="title" type="text" maxlength="120" required
               value="${p ? escapeHtml(p.title) : ''}" />

        <label for="body">Body</label>
        <textarea id="body" name="body" rows="12">${p ? escapeHtml(p.body) : ''}</textarea>

        <label class="checkbox" style="margin-top:0.75rem">
          <input type="checkbox" name="published" value="1" ${!p || p.published ? 'checked' : ''} />
          Published (visible on the Resources tab)
        </label>

        <div class="actions" style="margin-top:1rem">
          ${
            opts.mode === 'edit' && p
              ? `<button class="btn danger" type="submit" form="delete-page">Delete</button>
          <button class="btn primary" type="submit" style="margin-left:auto">Save</button>`
              : `<button class="btn primary" type="submit">Save</button>`
          }
        </div>
      </form>
      ${
        opts.mode === 'edit' && p
          ? `<form id="delete-page" method="post"
                action="/admin/pages/${p.id}/delete"
                data-confirm="Delete this page and its images? This cannot be undone."></form>`
          : ''
      }
    </section>

${images}`,
    {
      showLogout: true,
      role: opts.role,
      head: EDITOR_HEAD,
      bodyEnd: editorScripts({ kind: 'page', placeholder: 'Write the page…' }),
    },
  );
}

/**
 * The sacrament meeting program editor.
 *
 * Deliberately simpler than the announcement form: a date and a body, because a program has no
 * publish flag, no ordering and no expiry — *when* it is visible is the window in the dashboard's
 * Programs settings, not a field here. The dot-leader hint sits right above the editor because it
 * is the one bit of syntax that is not ordinary Markdown, and the person typing it is a clerk who
 * will never read the docs.
 */
/**
 * Day names, indexed the way `Date.getUTCDay()` and the program window setting both count.
 *
 * Here rather than in `programs.ts` because both users are presentation — this form's standing
 * warning and the flash `app.ts` appends after a save — and `app.ts` already imports this module,
 * so it costs no new edge in the import graph.
 */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Day of the week for a 'YYYY-MM-DD', read as a calendar date rather than as an instant — `Date`
 * parses a bare date string as UTC midnight, which is a different day west of Greenwich unless it
 * is asked for its UTC fields. Null for anything that is not a date.
 */
export function dayOfWeekFor(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

/**
 * A standing warning when a program is dated a day the visibility window can never open on.
 *
 * Rendered from the saved row, not from a flash, so it is still there the next time the page is
 * opened — the mistake it catches (a program that saves cleanly, lists normally, and is never shown
 * to anybody) has no other symptom at all.
 */
function dowWarning(date: string, windowDow: number): string {
  const dow = dayOfWeekFor(date);
  if (dow === null || dow === windowDow) return '';
  return `<p class="err">Dated a ${escapeHtml(DAY_NAMES[dow]!)} — members only see programs on
    ${escapeHtml(DAY_NAMES[windowDow] ?? '')}s, so nobody will see this one until the date or the
    window changes.</p>`;
}

export function programForm(opts: {
  mode: 'new' | 'edit';
  program?: ProgramRow;
  defaultDate?: string;
  settings: ProgramSettings;
  attachments?: EditorAttachment[];
  /** A New form sent back after a rejected save: the images already uploaded to it, still pending. */
  pendingAttachments?: EditorAttachment[];
  maxAttachments?: number;
  error?: string;
  flash?: string;
  /** The body as submitted, when a save was rejected — see `announcementForm`'s `draft`. */
  draftBody?: string;
  /** Only so the header names the right login — both roles may edit a program. */
  role?: Role | null;
  /** New page only: the date of the program this one was copied from (`?from=`). */
  copiedFrom?: string;
  /** New page only: the program to offer to copy — the most recent — when nothing was copied. */
  copyOffer?: { id: number; date: string };
  /** The editor holds `EXAMPLE_PROGRAM`, so say what to change. */
  fromExample?: boolean;
}): string {
  const p = opts.program;
  const maxAttachments = opts.maxAttachments ?? 10;
  // Deleting a program is admin-only (see the route); an editor's page simply has no button.
  const canDelete = opts.role === 'admin';
  const date = opts.defaultDate ?? p?.program_date ?? '';
  const bodyMd = opts.draftBody ?? p?.body_md ?? '';
  const images = imagesCard({
    ownerType: 'program',
    ownerId: opts.mode === 'edit' && p ? p.id : undefined,
    attachments: opts.mode === 'new' ? opts.pendingAttachments : opts.attachments,
    maxAttachments,
    blurb: `Shown under the program on the Program tab — a printed insert, a photo, a hymn sheet.
      Tapping one opens it full-screen. Up to ${maxAttachments}; large photos are shrunk in your
      browser before they upload.`,
    pending: `They are attached to the program when you save it.`,
  });
  const action = opts.mode === 'new' ? '/admin/programs' : `/admin/programs/${p?.id}`;
  const title = opts.mode === 'new' ? 'New Program' : 'Edit Program';
  return layout(
    title,
    `    <section class="card">
      <div class="section-head">
        <h2>${title}</h2>
        <div class="section-actions">
          ${
            opts.mode === 'edit' && p
              ? `<button type="button" class="btn small" data-program-preview="${p.id}">Preview</button>`
              : ''
          }
          <a class="btn small" href="/admin">Back</a>
        </div>
      </div>
      ${opts.flash ? `<p class="ok">${escapeHtml(opts.flash)}</p>` : ''}
      ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}
      ${dowWarning(date, opts.settings.dow)}
      ${
        opts.copiedFrom
          ? `<p class="ok">Copied from the program for ${escapeHtml(programDateLabel(opts.copiedFrom))}.
        Update the names, hymns and prayers before you save. Images are not copied.</p>`
          : ''
      }
      ${
        opts.fromExample
          ? `<p class="ok">This is an example program. Replace each <strong>(name)</strong>, change the
        hymns to this week's, and delete anything your ward doesn't do.</p>`
          : ''
      }
      ${
        opts.mode === 'new' && !opts.copiedFrom && !opts.fromExample && !opts.error
          ? `<p class="copy-offer">${
              opts.copyOffer
                ? `<a class="btn small" href="/admin/programs/new?from=${opts.copyOffer.id}">Copy
        Last Program (${escapeHtml(programDateShort(opts.copyOffer.date))})</a> `
                : ''
            }<a class="btn small" href="/admin/programs/new?example=1">Start from an Example</a></p>`
          : ''
      }
      <form method="post" action="${action}" id="content-form" class="admin-form program-editor">
        <label for="program_date">Meeting date</label>
        <input id="program_date" name="program_date" type="date" required
               value="${escapeHtml(date)}" />
        <p class="muted small">Members see this program on this date only, between
        ${escapeHtml(opts.settings.start)} and ${escapeHtml(opts.settings.end)}. Write it any day you
        like — it stays hidden until then.</p>

        <label for="body">Program</label>
        <p class="muted small leader-hint">Each line of the program is a <strong>row</strong>: the label
        on the left, the name or number on the right, and the dots drawn for you. Press <strong>+ Row</strong>,
        or just type the label followed by <code>...</code> and a space. <strong>Enter</strong> moves from
        the label to the name, then starts the next row; <strong>+ Note</strong> (or Shift+Enter) adds the quiet
        line under a row, like a hymn's title. Use <strong>Heading</strong> for each section and
        <strong>Center</strong> to center it, <strong>Line</strong> for the rule above the meeting info, and an
        empty line or two for extra space. Pasting a program written in Markdown works too.</p>
        <textarea id="body" name="body" rows="16">${escapeHtml(bodyMd)}</textarea>

        <div class="actions" style="margin-top:1rem">
          ${
            opts.mode === 'edit' && p && canDelete
              ? `<button class="btn danger" type="submit" form="delete-program">Delete</button>
          <button class="btn primary" type="submit" style="margin-left:auto">Save</button>`
              : `<button class="btn primary" type="submit">Save</button>`
          }
        </div>
      </form>
      ${
        opts.mode === 'edit' && p && canDelete
          ? `<form id="delete-program" method="post"
                action="/admin/programs/${p.id}/delete"
                data-confirm="Delete this program and its images? This cannot be undone."></form>`
          : ''
      }
    </section>

${images}
${opts.mode === 'edit' && p ? programPreviewModal() : ''}`,
    {
      showLogout: true,
      role: opts.role,
      head: EDITOR_HEAD,
      bodyEnd: editorScripts({ kind: 'program', placeholder: 'Start with + Row, or paste the program…' }),
    },
  );
}
