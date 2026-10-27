// Bundles the admin pages' browser code into public/vendor/, one minified file each:
// - editor.js: the visual editor (editor/index.js: Tiptap, prosemirror-markdown and this app's own
//   markdown-it rules from src/markdown.ts), loaded by the three editor pages.
// - passkey.js: SimpleWebAuthn's browser helpers (client/passkey.js), for sign-in and invites.
// Generated and git-ignored, like the vendored pdfmake copy; run as part of `npm run assets`, so
// every build and deploy path makes them. Members never download either.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const [entry, name] of [
  [join(root, 'editor', 'index.js'), 'editor.js'],
  [join(root, 'client', 'passkey.js'), 'passkey.js'],
]) {
  const outfile = join(root, 'public', 'vendor', name);
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['safari16', 'chrome110', 'firefox110'],
    outfile,
    legalComments: 'eof',
    logLevel: 'warning',
  });
  console.log(`wrote ${outfile}`);
}
