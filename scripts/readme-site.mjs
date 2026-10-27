#!/usr/bin/env node
/**
 * The README as a page of its own, for the one-page site (.github/workflows/pages.yml).
 *
 *   node scripts/readme-site.mjs BODY.html OUT.html
 *
 * BODY is the README already rendered by GitHub's Markdown API (`POST /markdown`, mode gfm), so
 * the page reads as the repository's front page does; this only wraps it in a document styled
 * with GitHub's own published stylesheet. The site carries the README and docs/images/ and
 * nothing else, so every other relative link (the deployment guide, the licence) is pointed at
 * the file on GitHub. The API leaves relative links as they are written, which is what makes
 * that rewrite safe. A bar above the README and a line below it link the repository itself, which
 * the README never names: on GitHub, it is the page around it.
 *
 * GITHUB_REPOSITORY (set in every Actions run) names the repository the links point at.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [bodyPath, outPath] = process.argv.slice(2);
if (!bodyPath || !outPath) {
  console.error('usage: node scripts/readme-site.mjs BODY.html OUT.html');
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY || 'luminationlabs/ward-announcements';
const home = `https://github.com/${repo}`;
const blob = `${home}/blob/main/`;

// Relative: no scheme, not an in-page anchor, not rooted at the site.
const relative = (url) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url);
const published = (url) => url.startsWith('docs/images/');

const body = readFileSync(bodyPath, 'utf8').replace(/\b(href|src)="([^"]*)"/g, (whole, attr, url) =>
  relative(url) && !published(url) ? `${attr}="${blob}${url}"` : whole,
);

// GitHub's mark (Octicons' mark-github, MIT), sized to the text.
const mark =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path></svg>';

// The README's first heading names the page.
const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
const title = h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : 'Ward Announcements';

writeFileSync(
  outPath,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="A private web app for a ward's announcements and sacrament meeting program, with a weekly notification.">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.8.1/github-markdown.min.css">
<style>
  /* The stylesheet colours .markdown-body for light and dark; the page around it follows. */
  :root { color-scheme: light dark; }
  body { margin: 0; background: #ffffff; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; } }
  .markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 45px; }
  .repo { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 16px 45px 0; text-align: right;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
  .repo a { color: #0969da; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
  .repo a:hover { text-decoration: underline; }
  .repo svg { fill: currentColor; }
  .repo-foot { text-align: center; padding-bottom: 32px; }
  @media (prefers-color-scheme: dark) { .repo a { color: #4493f8; } }
  @media (max-width: 767px) {
    .markdown-body { padding: 16px; }
    .repo { padding: 12px 16px 0; }
  }
</style>
</head>
<body>
<nav class="repo"><a href="${home}">${mark}Source code on GitHub</a></nav>
<main class="markdown-body">
${body}
</main>
<footer class="repo repo-foot"><a href="${home}">${mark}github.com/${repo}</a></footer>
</body>
</html>
`,
);
console.log(`wrote ${outPath}`);
