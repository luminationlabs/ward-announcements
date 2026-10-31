// Copies pdf.js out of node_modules into public/vendor/pdfjs/, where it is loaded on demand twice
// over: by the dashboard, to draw an attached PDF's first page as its thumbnail (the image uploader
// in src/views.ts), and by the member app's PDF viewer (`openPdfViewer` in public/app.js). Copied at build time, like pdfmake, rather than committed: it is a few MB and an
// upgrade should be a version bump.
//
// The *legacy* build: the modern one calls `Promise.try`, `Map.prototype.getOrInsertComputed` and
// `Math.sumPrecise` unpolyfilled, which an iPhone on iOS 17 does not have, and a clerk there would
// only ever see "Could not read that PDF". Its two modules are renamed from `.mjs` to `.js` so every
// static server here (Node, Workers assets, the many-ward host) sends them as JavaScript, which a
// module import insists on. Beside them, what the worker fetches for some PDFs: the image decoders
// (`wasm/`, with plain-JS fallbacks for where WebAssembly is refused — a scanned flyer is usually
// JBIG2 or CCITT, and without these its thumbnail is blank white), the character maps (CJK text),
// the standard fonts (a PDF that does not embed Helvetica) and the colour profiles.
// Run: npm run assets  (also runs as part of `npm run build` and both Cloudflare scripts).
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'node_modules', 'pdfjs-dist');
const outDir = join(root, 'public', 'vendor', 'pdfjs');
mkdirSync(outDir, { recursive: true });
for (const name of ['pdf.min', 'pdf.worker.min']) {
  copyFileSync(join(dist, 'legacy', 'build', `${name}.mjs`), join(outDir, `${name}.js`));
}
for (const dir of ['wasm', 'cmaps', 'standard_fonts', 'iccs']) {
  // Not quickjs-eval: that is the sandbox for a PDF's own scripts, which drawing a thumbnail never runs.
  cpSync(join(dist, dir), join(outDir, dir), { recursive: true, filter: (path) => !/quickjs/.test(path) });
}
console.log(`vendored pdf.js → ${outDir}`);
