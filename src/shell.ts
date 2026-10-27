/**
 * Templating the app shell and the service worker.
 *
 * Both entries do the same substitution, from different sources: Node reads `public/` off disk at
 * boot, Workers pulls the same files through its static-assets binding on first use. Only the
 * *reading* is runtime-specific, so it stays in the entry points and the transformation lives here.
 */
import { config } from './config.js';
import { THEME_HEAD_SCRIPT, themeHeadScript } from './theme.js';
import { escapeHtml, siteFooter, socialMeta } from './views.js';

/** The raw files this needs, in whatever way the runtime can get at them. */
export interface ShellSources {
  /** `public/index.html`, with its `{{APP_*}}` placeholders intact. */
  index: string;
  /** `public/sw.js`, with its `{{BUILD_ID}}` placeholder intact. */
  sw: string;
  /** `public/icons/ios-splash.html` — generated markup, injected verbatim. */
  iosSplash: string;
  /**
   * The client assets whose contents feed the cache-busting build id, in a fixed order:
   * app.js, install.js, styles.css.
   */
  assets: string[];
}

export interface Shell {
  /**
   * The page, its one inline script (the appearance script) opened with `nonceToken` in place of a
   * nonce. Serve it with `shellFor()`, which swaps in the response's.
   */
  indexHtml: string;
  /** Random per build: unknown to anything stored, so it can only ever name our own script tag. */
  nonceToken: string;
  swSource: string;
  buildId: string;
}

/** The member page for this response: the shell with its nonce token replaced by the nonce. */
export function shellFor(shell: Shell, nonce: string | null): string {
  return shell.indexHtml.replace(shell.nonceToken, nonce ?? '');
}

/**
 * Render the shell once, substituting the configured identity, and derive the build id that busts
 * the service worker's cache.
 *
 * The build id is a short content hash of everything the client caches. Because ANY change to a
 * shipped asset changes the hash, it changes sw.js's bytes — which is what makes the browser
 * install the new worker and the client silently reload (see public/app.js). That replaces the old
 * by-hand "bump CACHE" step with a correct-by-construction one: you can never ship a stale-serving
 * update by forgetting to bump a version.
 */
export async function buildShell(sources: ShellSources): Promise<Shell> {
  // Always a <footer>: the non-official-site disclaimer is fixed, APP_FOOTER an optional note above it.
  const footerHtml = siteFooter();
  // Optional link below the announcements — only when both the text and URL are configured.
  const announcementsLinkHtml =
    config.linkText && config.linkUrl
      ? `<p class="more-link"><a href="${escapeHtml(config.linkUrl)}" target="_blank" rel="noopener">${escapeHtml(
          config.linkText,
        )}</a></p>`
      : '';
  // iOS launch images: scripts/generate-icons.mjs (run by `npm run dev`/`build` before boot)
  // writes the <link rel="apple-touch-startup-image"> tags to public/icons/ios-splash.html.
  // Trusted generated markup — injected without escaping, unlike the APP_* values.
  // Every replacement is a *function*, never a string: in a string replacement `$'`, `$&` and `` $` ``
  // are patterns ("the text after the match"…), so a footer reading "Bring $'s" would paste the rest
  // of the page into the middle of it. These values come from the Ward settings card, so any admin
  // can type one; escapeHtml leaves `$` alone.
  //
  // Rendered twice. The page is cached and the nonce is per response, so the copy that is served
  // opens its appearance script with a random token that `shellFor` replaces; the build id is a hash
  // of a copy with a plain tag, or every isolate (each with its own token) would have a different id
  // and the silent update would reload every phone on every visit. The script goes in *before* the
  // ward's own values, so none of them can ever hold the token.
  const nonceToken = `nonce-${crypto.randomUUID()}`;
  const render = (themeScript: string) => sources.index
    .replace(/\{\{THEME_SCRIPT\}\}/g, () => themeScript)
    .replace(/\{\{APP_NAME\}\}/g, () => escapeHtml(config.appName))
    .replace(/\{\{APP_SHORT_NAME\}\}/g, () => escapeHtml(config.appShortName))
    .replace(/\{\{APP_DESCRIPTION\}\}/g, () => escapeHtml(config.appDescription))
    .replace(/\{\{ANNOUNCEMENTS_LINK\}\}/g, () => announcementsLinkHtml)
    .replace(/\{\{APP_FOOTER\}\}/g, () => footerHtml)
    .replace(/\{\{IOS_SPLASH\}\}/g, () => sources.iosSplash)
    // Trusted generated markup like IOS_SPLASH above: socialMeta() escapes the config values it
    // interpolates, so it must not be escaped again here.
    .replace(/\{\{SOCIAL_META\}\}/g, () => socialMeta());
  // The appearance script (src/theme.ts), shared with the gate page so the two can't drift.
  const indexHtml = render(THEME_HEAD_SCRIPT);
  const servedHtml = render(themeHeadScript(`<script nonce="${nonceToken}">`));

  // The fully-substituted shell is part of the hash, so an env-only identity change busts too.
  const buildId = await shortHash([...sources.assets, sources.sw, indexHtml].join('\0'));

  // Fail fast if the placeholder ever goes missing — otherwise we'd silently serve a service worker
  // with a fixed CACHE name that never changes, quietly breaking the silent-update mechanism.
  if (!sources.sw.includes('{{BUILD_ID}}')) {
    throw new Error('public/sw.js is missing the {{BUILD_ID}} placeholder in its CACHE name.');
  }

  // The page reads its own build id back on `controllerchange` (public/app.js) and reloads only if
  // the worker that just took over was built from different assets — a cold open already fetched
  // the current files from the network, so reloading there would be a second flash for nothing.
  if (!sources.index.includes('{{BUILD_ID}}')) {
    throw new Error('public/index.html is missing the {{BUILD_ID}} placeholder in its build-id meta tag.');
  }
  return {
    indexHtml: servedHtml.replaceAll('{{BUILD_ID}}', buildId),
    nonceToken,
    swSource: sources.sw.replaceAll('{{BUILD_ID}}', buildId),
    buildId,
  };
}

/** First 12 hex characters of a SHA-256 over the UTF-8 text. WebCrypto, so both runtimes have it. */
async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}
