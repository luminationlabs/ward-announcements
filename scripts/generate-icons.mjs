// Generates the PWA PNG icons with zero native dependencies (uses only Node's built-in zlib).
// Design: a building in white on a hymn-book green field, #ffffff on #24513f. The green is the
// icon's alone — the app's own chrome stays navy (see the note above GREEN below).
// Run: npm run icons  (also runs as part of `npm run build` and both Cloudflare scripts).
//
// The building is a mask: an 8-bit greyscale coverage map, cropped to the artwork's bounding box.
// By default it is art/chapel-mask.png, a generic meetinghouse drawn by scripts/chapel-mask.mjs. A
// ward can use its own building instead: put a mask of the same kind in art/ and select it with a
// git-ignored art/icon.local.json, { "mask": "my-building.png" } (see art/README.md). Nothing here
// reads an SVG: rasterizing one would mean a native dependency in the build, and the build runs on
// the deploy path. Everything below just scales and recolours the mask; the seal and the maskable
// fit are both measured from the mask itself, so they hold for any building.
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// --- tiny PNG encoder (RGBA, 8-bit) ---------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- the mask --------------------------------------------------------------
// Decodes an 8-bit greyscale mask PNG (scripts/chapel-mask.mjs writes one). All five PNG filter types are
// handled even though that script writes only filter 0, so re-exporting the mask from an image
// editor cannot silently break the build.
function decodeGreyPng(buf) {
  let p = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 0 || data[12] !== 0) {
        throw new Error('the icon mask must be 8-bit greyscale, non-interlaced');
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const line = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? out[y * width + x - 1] : 0;
      const b = y > 0 ? out[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? out[(y - 1) * width + x - 1] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p0 = a + b - c;
        const pa = Math.abs(p0 - a);
        const pb = Math.abs(p0 - b);
        const pc = Math.abs(p0 - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * width + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

const LOCAL = join(root, 'art', 'icon.local.json');
// ICON_MASK wins over the local file: the many-ward host may be built on the same machine as a single ward's
// own deployment, and every hosted ward must get the generic meetinghouse, not that ward's building
// (`npm run host:deploy` sets ICON_MASK=chapel-mask.png).
const MASK_FILE =
  process.env.ICON_MASK || (existsSync(LOCAL) && JSON.parse(readFileSync(LOCAL, 'utf8')).mask) || 'chapel-mask.png';
const MASK = decodeGreyPng(readFileSync(join(root, 'art', MASK_FILE)));
const ASPECT = MASK.width / MASK.height;

// The same building as a solid silhouette. Below about 32px the interior detail is all thinner than a
// pixel and averages into a grey haze that swallows the outline, so the favicon draws this instead.
// Two steps: a morphological close (dilate, then erode, by SEAL) seals the seams between the wing
// bays, which are only a few mask pixels wide and open to the sky, so nothing can be flooded through
// them; then flooding the field inward from the border marks the outside, and every pixel it cannot
// reach — building, window, sealed seam — becomes solid. The result is hard-edged rather than
// anti-aliased, which does not matter: it is only ever drawn at 48px or less, a 20x reduction the
// box filter smooths anyway.
const SEAL = 4; // mask pixels; the widest seam is ~3, the narrowest window 22

const SOLID = (() => {
  const { width, height, data } = MASK;
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = data[i] >= 128 ? 1 : 0;

  // Separable min/max filters over a (2*SEAL+1)-square: dilate = max, erode = min.
  const pass = (src, pick) => {
    const mid = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = src[y * width + x];
        for (let k = Math.max(0, x - SEAL); k <= Math.min(width - 1, x + SEAL); k++) {
          v = pick(v, src[y * width + k]);
        }
        mid[y * width + x] = v;
      }
    }
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = mid[y * width + x];
        for (let k = Math.max(0, y - SEAL); k <= Math.min(height - 1, y + SEAL); k++) {
          v = pick(v, mid[k * width + x]);
        }
        out[y * width + x] = v;
      }
    }
    return out;
  };
  // Both passes clamp at the canvas edge, which is exactly what the base slab needs: it sits flush
  // against three sides of the crop, and an erode that counted the space beyond them as field would
  // gnaw it away.
  const closed = pass(pass(ink, Math.max), Math.min);

  const outside = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const i = stack.pop();
    if (outside[i] || closed[i]) continue;
    outside[i] = 1;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    if (i >= width) stack.push(i - width);
    if (i < width * (height - 1)) stack.push(i + width);
  }
  const filled = Buffer.alloc(width * height);
  for (let i = 0; i < filled.length; i++) filled[i] = outside[i] ? 0 : 255;
  return { width, height, data: filled };
})();

// Box-filter resample of a mask to w x h. Every use downscales — the mask is drawn at the largest
// size any icon needs — so an exact area average is both the right filter and cheap enough.
function resampleMask(mask, w, h) {
  const out = new Float64Array(w * h);
  const sx = mask.width / w;
  const sy = mask.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let sum = 0;
      let weight = 0;
      for (let my = Math.floor(y0); my < Math.ceil(y1); my++) {
        const wy = Math.min(y1, my + 1) - Math.max(y0, my);
        for (let mx = Math.floor(x0); mx < Math.ceil(x1); mx++) {
          const wx = Math.min(x1, mx + 1) - Math.max(x0, mx);
          const a = wx * wy;
          sum += mask.data[my * mask.width + mx] * a;
          weight += a;
        }
      }
      out[y * w + x] = sum / (weight * 255);
    }
  }
  return out;
}

// --- drawing ---------------------------------------------------------------
function fill(img, width, height, [r, g, b]) {
  for (let i = 0; i < width * height; i++) {
    img[i * 4] = r;
    img[i * 4 + 1] = g;
    img[i * 4 + 2] = b;
    img[i * 4 + 3] = 255;
  }
}

// The building, `h` pixels tall, its centre at (cx, cy) on a W x H canvas.
function drawBuilding(img, W, H, cx, cy, h, [r, g, b], mask = MASK) {
  const th = Math.max(1, Math.round(h));
  const tw = Math.max(1, Math.round(h * ASPECT));
  const cov = resampleMask(mask, tw, th);
  const ox = Math.round(cx - tw / 2);
  const oy = Math.round(cy - th / 2);
  for (let y = 0; y < th; y++) {
    const py = oy + y;
    if (py < 0 || py >= H) continue;
    for (let x = 0; x < tw; x++) {
      const px = ox + x;
      if (px < 0 || px >= W) continue;
      const t = cov[y * tw + x];
      if (t <= 0) continue;
      const i = (py * W + px) * 4;
      img[i] = Math.round(r * t + img[i] * (1 - t));
      img[i + 1] = Math.round(g * t + img[i + 1] * (1 - t));
      img[i + 2] = Math.round(b * t + img[i + 2] * (1 - t));
      // Never *lower* alpha: every caller draws onto an already-opaque field except the favicon,
      // whose rounded tile is laid down by roundTile() below and is opaque wherever the building lands.
      img[i + 3] = Math.max(img[i + 3], Math.round(255 * t));
    }
  }
}

// The favicon's rounded tile. This writes the colour at full strength and puts the anti-aliasing in
// the *alpha* channel, so the corners fade to transparent rather than blending toward the buffer's
// initial black and leaving a dark fringe.
function roundTile(img, S, radius, [r, g, b]) {
  const c = S / 2;
  const h = S / 2 - radius;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const qx = Math.abs(x + 0.5 - c) - h;
      const qy = Math.abs(y + 0.5 - c) - h;
      const d =
        Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
      let cov = 0.5 - d;
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      const i = (y * S + x) * 4;
      img[i] = r;
      img[i + 1] = g;
      img[i + 2] = b;
      img[i + 3] = Math.round(255 * cov);
    }
  }
}

// The icon field is hymn-book green, *not* the app's navy `--brand`. A white building on a deep blue
// tile is the Church's own Tools app, and two apps a ward member is told to install should not be
// telling each other apart by their shade of blue. The app itself — header, theme colour, the tint
// on every button — stays navy; this green is only ever the ground the building stands on, which is
// the icon, the launch image, and the manifest's `background_color` that Android paints behind the
// icon while the app opens.
const GREEN = [36, 81, 63]; // #24513f
const WHITE = [255, 255, 255]; // --brand-ink
// The favicon's lighter green (see renderFavicon). Chosen by taking GREEN's hue up to the relative
// luminance of a blue (#2563eb, L=0.153) known to clear Safari's dark-mode plating heuristic, so a
// colour of the same luminance clears it too.
const FAVICON_GREEN = [54, 121, 94]; // #36795e

// Square app icon (`purpose: any`, and the iOS home-screen icon): the building on a full green tile,
// clear of the corner rounding every platform applies.
const ICON_HEIGHT = 0.78;

// …and never wider than this. A tall building's height sets its size; a wide one drawn at the same
// height would fill 78% of the tile's width and crowd its sides, so the width is capped at 72.5%.
const ICON_MAX_WIDTH = 0.725;

// A mask may also set its own largest dimension in the app icons, for artwork that simply looks
// better with more room. The generic meetinghouse does: on a home screen it reads better at 67% of
// the tile (about 31px of margin at 180px). Absent here = the rules above.
const ICON_FIT = { 'chapel-mask.png': 0.67 }[MASK_FILE];

function renderIcon(size) {
  const img = Buffer.alloc(size * size * 4);
  fill(img, size, size, GREEN);
  let height = Math.min(ICON_HEIGHT, ICON_MAX_WIDTH / ASPECT);
  if (ICON_FIT) height = Math.min(height, ICON_FIT, ICON_FIT / ASPECT);
  drawBuilding(img, size, size, size / 2, size / 2, size * height, WHITE);
  return encodePng(size, size, img);
}

// Square *maskable* icon (`purpose: maskable`). Android may crop this to any shape that contains the
// centred circle of 80% diameter, so the whole building has to fit inside that circle — a much tighter
// box than the square above, which is why this is a second file rather than one icon doing both.
// The fit is measured from the mask itself: for each row, the outermost inked pixel on each side,
// then the largest scale whose farthest such point still lands within the circle. Searching the
// vertical offset too matters — the building is widest at the bottom and narrowest at the spire, so it
// sits slightly high in the circle.
const MASKABLE = (() => {
  // Outermost ink per row, as offsets from the mask's centre, in units of mask height.
  const extremes = [];
  for (let y = 0; y < MASK.height; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < MASK.width; x++) {
      if (MASK.data[y * MASK.width + x] >= 128) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left < 0) continue;
    const dy = (y + 0.5 - MASK.height / 2) / MASK.height;
    const dx = Math.max(Math.abs(left - MASK.width / 2), Math.abs(right + 1 - MASK.width / 2));
    extremes.push([dx / MASK.height, dy]);
  }
  // Farthest point from the tile centre when the building is `h` tall and shifted `c` down, both as
  // fractions of the tile.
  const reach = (h, c) =>
    extremes.reduce((m, [dx, dy]) => Math.max(m, Math.hypot(dx * h, dy * h + c)), 0);
  let best = { height: 0, offset: 0 };
  for (let c = -0.15; c <= 0.15; c += 0.002) {
    let lo = 0;
    let hi = 1.5;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (reach(mid, c) <= 0.4) lo = mid;
      else hi = mid;
    }
    if (lo > best.height) best = { height: lo, offset: c };
  }
  return best;
})();

function renderMaskableIcon(size) {
  const img = Buffer.alloc(size * size * 4);
  fill(img, size, size, GREEN);
  drawBuilding(
    img,
    size,
    size,
    size / 2,
    size * (0.5 + MASKABLE.offset),
    size * MASKABLE.height,
    WHITE,
  );
  return encodePng(size, size, img);
}

// Rectangular iOS launch image: the same green field with the building centered, so tapping the icon
// opens onto the ground it was standing on. 0.42 of the short edge is the
// largest the mask can fill without being scaled *up* on the biggest iPad (2048px short edge against
// a 963px mask), and on a phone it reads as a deliberate mark rather than a stray logo.
function renderSplash(w, h) {
  const img = Buffer.alloc(w * h * 4);
  fill(img, w, h, GREEN);
  drawBuilding(img, w, h, w / 2, h / 2, Math.min(w, h) * 0.42, WHITE);
  return encodePng(w, h, img);
}

// --- social card -----------------------------------------------------------
// The 1200x630 image a chat app shows when someone pastes the member link (og:image). Same green
// field and white building as the launch screen, just at the 1.91:1 ratio every unfurler crops to —
// so a card built at any other aspect would get its edges cut off. Deliberately wordless: the app
// name is already in og:title right beside it, and drawing text here would mean a rasterizer and a
// font, which this generator exists to avoid (see the mask note at the top).
const OG = { w: 1200, h: 630 };

function renderOgCard() {
  const img = Buffer.alloc(OG.w * OG.h * 4);
  fill(img, OG.w, OG.h, GREEN);
  // 0.66 of the height, not renderSplash's 0.42 of the short side: a preview bubble is displayed a few hundred
  // pixels wide, so the mark needs to survive being shrunk to roughly thumbnail size.
  drawBuilding(img, OG.w, OG.h, OG.w / 2, OG.h / 2, OG.h * 0.66, WHITE);
  return encodePng(OG.w, OG.h, img);
}

// --- favicon ---------------------------------------------------------------
// Deliberately a lighter green than the app tile. Safari runs a contrast heuristic on the favicon
// against its own chrome, and when the icon is too dark it composites the icon onto a white rounded
// plate — which reads as an ugly white border around the icon in the tab bar in dark mode. A navy
// tile, #1f3a5f, is dark enough to trip it every time, and #24513f is darker still. A mid-luminance
// accent blue, #2563eb, clears the heuristic on a dark tab bar without washing out on a light one;
// FAVICON_GREEN is that same luminance in the icon's own hue, so it should behave the same. Tested
// in Safari 26.4 (dark mode) with the blue, against the navy tile as a control: navy got the plate,
// the blue did not. **The green has not been re-verified on a
// device** — if a white plate shows up behind it in a dark tab bar, lighten FAVICON_GREEN. The
// home-screen icons above stay the dark green: they are composited on the user's wallpaper, never on
// browser chrome, so the heuristic never applies to them.
//
// It is also the filled silhouette (see SOLID) drawn larger than the app icon's building: at 16px the
// stepped outline is the only thing that survives, and it needs every pixel it can get.
function renderFavicon(size) {
  const img = Buffer.alloc(size * size * 4);
  roundTile(img, size, 0.22 * size, FAVICON_GREEN);
  drawBuilding(img, size, size, size / 2, size * 0.5, size * 0.86, WHITE, SOLID);
  return encodePng(size, size, img);
}

const targets = [
  ['icon-192.png', 192, renderIcon],
  ['icon-512.png', 512, renderIcon],
  ['icon-192-maskable.png', 192, renderMaskableIcon],
  ['icon-512-maskable.png', 512, renderMaskableIcon],
  ['apple-touch-icon.png', 180, renderIcon],
];

for (const [name, size, render] of targets) {
  writeFileSync(join(outDir, name), render(size));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}

writeFileSync(join(outDir, 'og-card.png'), renderOgCard());
console.log(`wrote public/icons/og-card.png (${OG.w}x${OG.h})`);

for (const size of [16, 32, 48]) {
  writeFileSync(join(outDir, `favicon-${size}.png`), renderFavicon(size));
  console.log(`wrote public/icons/favicon-${size}.png (${size}x${size})`);
}

// iOS launch images (apple-touch-startup-image). iOS shows one only when a tag's media query
// matches the device's exact CSS viewport + pixel-ratio + orientation, so this is one entry per
// unique iPhone/iPad *portrait* viewport (CSS points × DPR). Devices not listed get a blank launch
// screen — acceptable graceful fallback. Portrait only: a home-screen PWA launches in the current
// orientation and this app is a quick portrait check. Source: https://iosref.com/res
const SPLASH = [
  // iPhone
  { w: 375, h: 667, dpr: 2 }, // SE (2nd/3rd), 8, 7, 6s
  { w: 414, h: 736, dpr: 3 }, // 8/7/6s Plus
  { w: 375, h: 812, dpr: 3 }, // X, XS, 11 Pro
  { w: 414, h: 896, dpr: 2 }, // XR, 11
  { w: 390, h: 844, dpr: 3 }, // 12/12 Pro, 13/13 Pro, 14
  { w: 428, h: 926, dpr: 3 }, // 12/13 Pro Max, 14 Plus
  { w: 393, h: 852, dpr: 3 }, // 14 Pro, 15/15 Pro, 16
  { w: 430, h: 932, dpr: 3 }, // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  { w: 402, h: 874, dpr: 3 }, // 16 Pro
  { w: 440, h: 956, dpr: 3 }, // 16 Pro Max
  { w: 420, h: 912, dpr: 3 }, // iPhone Air
  // iPad
  { w: 768, h: 1024, dpr: 2 }, // iPad (≤6th), Air/Air 2, Pro 9.7"
  { w: 744, h: 1133, dpr: 2 }, // iPad mini (6th/7th)
  { w: 810, h: 1080, dpr: 2 }, // iPad (10th/11th), Air (4th/5th)
  { w: 834, h: 1112, dpr: 2 }, // iPad Pro 10.5", Air (3rd)
  { w: 834, h: 1194, dpr: 2 }, // iPad Pro 11"
  { w: 1024, h: 1366, dpr: 2 }, // iPad Pro 12.9", Air 13"
];

const splashDir = join(outDir, 'splash');
mkdirSync(splashDir, { recursive: true });
const links = [];
for (const { w, h, dpr } of SPLASH) {
  const file = `splash-${w}x${h}.png`;
  writeFileSync(join(splashDir, file), renderSplash(w * dpr, h * dpr));
  links.push(
    `<link rel="apple-touch-startup-image" ` +
      `media="screen and (device-width: ${w}px) and (device-height: ${h}px) ` +
      `and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" ` +
      `href="/icons/splash/${file}" />`,
  );
}
// The server injects this partial into index.html ({{IOS_SPLASH}}). Kept under public/icons/ so it
// shares the icons' gitignore + regeneration lifecycle.
writeFileSync(join(outDir, 'ios-splash.html'), links.join('\n') + '\n');
console.log(`wrote public/icons/splash/ (${SPLASH.length} launch images) + ios-splash.html`);
