/**
 * The member side's Auto / Light / Dark choice, applied before the first paint.
 *
 * Both member-facing pages (the app shell, `public/index.html`, and the gate page in `views.ts`)
 * inline this in their `<head>`, after the `theme-color` metas it rewrites. It has to be inline and
 * run there: a stylesheet can only follow `prefers-color-scheme`, and a choice applied any later —
 * by app.js at the end of the body — would paint the page in the system's scheme first and then
 * flip it. Inline under the Content Security Policy too: `themeHeadScript()` opens it with the
 * response's nonce (src/csp.ts), on the gate page and in the member shell alike.
 *
 * It always writes the *resolved* scheme to `<html data-theme>`, `light` or `dark`, Auto included,
 * so styles.css carries one dark block keyed on `[data-theme=dark]` rather than a copy inside a
 * media query and another outside it. The choice itself lives in localStorage under
 * {@link APPEARANCE_KEY}, per device, absent meaning Auto. While on Auto it follows a live system
 * change; `window.wardAppearance` lets app.js's switch read and change the choice without a reload.
 *
 * The admin pages never include it, so they never get `data-theme` — and styles.css scopes the dark
 * block to `body:not(.admin)` besides.
 *
 * ES5 and defensive throughout: it runs on whatever Safari a member's phone has, before anything
 * else on the page, and a throw here must not cost them the page. Storage may be missing or throw
 * (a blocked site, an old private mode); a stored value it doesn't recognise counts as Auto.
 */
export const APPEARANCE_KEY = 'appearance';

/** The header's navy in each scheme — `--brand` in styles.css — for the browser's `theme-color`. */
const THEME_COLORS = { light: '#1f3a5f', dark: '#172c48' };

export const THEME_HEAD_SCRIPT = `<script>
(function () {
  var KEY = ${JSON.stringify(APPEARANCE_KEY)};
  var COLORS = ${JSON.stringify(THEME_COLORS)};
  var root = document.documentElement;
  var media = null;
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (e) {}
  function read() {
    try {
      var v = window.localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch (e) {
      return 'auto';
    }
  }
  // Held here as well as stored: when storage refuses the write, the choice still holds for this
  // page, and a system change while on it doesn't undo it.
  var choice = read();
  function apply() {
    var scheme = choice === 'auto' ? (media && media.matches ? 'dark' : 'light') : choice;
    root.setAttribute('data-theme', scheme);
    // The root's own scheme (canvas, scrollbars, form controls), which the color-scheme meta would
    // otherwise leave following the system.
    root.style.colorScheme = scheme;
    // A media-keyed theme-color can't follow a manual choice, so both metas take the chosen colour.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', COLORS[scheme]);
  }
  apply();
  if (media) {
    var follow = function () {
      if (choice === 'auto') apply();
    };
    if (media.addEventListener) media.addEventListener('change', follow);
    else if (media.addListener) media.addListener(follow);
  }
  window.wardAppearance = {
    get: function () {
      return choice;
    },
    set: function (next) {
      choice = next === 'light' || next === 'dark' ? next : 'auto';
      try {
        if (choice === 'auto') window.localStorage.removeItem(KEY);
        else window.localStorage.setItem(KEY, choice);
      } catch (e) {}
      apply();
    },
  };
})();
</script>`;

/**
 * The same script with the opening tag a page needs: `scriptTag()` (src/csp.ts) on a page rendered
 * per request, the shell's own nonce token in the cached member page (src/shell.ts).
 */
export function themeHeadScript(openTag: string): string {
  return openTag + THEME_HEAD_SCRIPT.slice('<script>'.length);
}
