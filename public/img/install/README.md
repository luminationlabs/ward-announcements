# Install instruction images

All **original** SVGs drawn for this project — safe to ship, no third-party assets.

- `ios-share.svg`, `add-to-home-screen.svg`, `close.svg` — glyphs used in the install sheet.
- `ios-26-share-1..4.svg` — schematic illustrations of the iOS 26 Safari "Add to Home Screen" flow (bottom-bar ••• → Share → More → Add to Home Screen), with the real iOS menu labels.
- `ios-27-share-1.svg` — the iOS 27 replacement for step 1 only. iOS 27 made the bottom-right button open Tabs rather than the ••• menu, so Share is reached from the page menu at the left of the address bar. Steps 2–4 are the share sheet, unchanged, and both versions share the `-26-` files for those. **Drawn from published screenshots of iOS 27, not from a device we have run** — worth a check against real hardware.

These are simplified depictions, not pixel-perfect screenshots. If you'd rather show real screenshots, replace the `ios-2{6,7}-share-*.svg` files (and update the references in [`public/install.js`](../../install.js)). The address bar in step 1 shows a neutral `example.org` placeholder.
