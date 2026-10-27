// Copies pdfmake's browser build out of node_modules into public/vendor/pdfmake/, where the
// dashboard's "Save as PDF" loads it on demand (see public/preview-pdf.js). Copied at build time
// rather than committed like the other vendored assets because the two files are ~1.9 MB and
// pdfmake is an ordinary npm dependency, so an upgrade is a version bump, not a binary diff.
// Run: npm run assets  (also runs as part of `npm run build` and both Cloudflare scripts).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfmake', 'build');
const outDir = join(root, 'public', 'vendor', 'pdfmake');
mkdirSync(outDir, { recursive: true });
for (const name of ['pdfmake.min.js', 'vfs_fonts.js']) {
  copyFileSync(join(src, name), join(outDir, name));
}
console.log(`vendored pdfmake → ${outDir}`);
