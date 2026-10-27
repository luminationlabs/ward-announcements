// Draws art/chapel-mask.png, the generic icon artwork: a meetinghouse with a steeple, for any ward.
// NOT part of `npm run build` — run it by hand after changing the shapes below, then commit the
// mask:
//
//   node scripts/chapel-mask.mjs
//
// It writes an 8-bit greyscale coverage map, cropped to the artwork, 0 = field, 255 = building — the
// mask format scripts/generate-icons.mjs draws from (see art/README.md). It needs no tools: the
// building is a handful of polygons, rasterized here with 4x4 supersampling.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'art', 'chapel-mask.png');

// Drawn in a 1000-unit square, y down, rendered at one pixel per unit. Solids are unioned, then the
// holes (doors and windows) are cut out of them.
const SIZE = 1000;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// A semicircle-topped opening: x0..x1 wide, its arch springing from y0 + radius, bottom at y1.
const arch = (x0, x1, y0, y1, n = 16) => {
  const r = (x1 - x0) / 2;
  const cx = x0 + r;
  const cy = y0 + r;
  const top = Array.from({ length: n + 1 }, (_, i) => {
    const a = Math.PI + (Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return [...top, [x1, y1], [x0, y1]];
};
// Mirror a shape about the centre line x = 500.
const mirror = (poly) => poly.map(([x, y]) => [1000 - x, y]).reverse();

const SOLIDS = [
  [[500, 20], [467, 290], [533, 290]], // spire
  rect(456, 286, 544, 308), // spire collar
  rect(432, 308, 568, 330), // belfry cap cornice
  rect(444, 328, 556, 470), // belfry
  rect(428, 468, 572, 490), // belfry sill cornice
  rect(440, 488, 560, 566), // tower base, standing on the ridge
  [[40, 704], [370, 562], [630, 562], [960, 704]], // main hipped roof
  rect(40, 700, 960, 718), // roof fascia
  rect(90, 732, 910, 902), // wing walls
  [[306, 672], [500, 560], [694, 672]], // entry gable pediment
  rect(306, 670, 694, 688), // entry gable cornice
  rect(356, 686, 644, 902), // entry gable walls
  rect(60, 900, 940, 936), // step
];
const HOLES = [
  ...[[464, 489], [511, 536]].map(([a, b]) => arch(a, b, 348, 448)), // belfry louvres
  [[280, 670], [500, 538], [720, 670], [694, 670], [500, 560], [306, 670]], // shadow above the gable
  rect(90, 718, 342, 732), // shadow under the eaves
  rect(658, 718, 910, 732),
  rect(342, 688, 356, 902), // shadow beside the entry
  rect(644, 688, 658, 902),
  arch(448, 552, 712, 902), // arched entry
  ...[[140, 186], [246, 292]].flatMap(([a, b]) => [arch(a, b, 768, 868), mirror(arch(a, b, 768, 868))]), // wing windows
];

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const covered = (x, y) => SOLIDS.some((p) => inside(p, x, y)) && !HOLES.some((p) => inside(p, x, y));

const SS = 4;
const full = new Uint8Array(SIZE * SIZE);
let [x0, y0, x1, y1] = [SIZE, SIZE, 0, 0];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let n = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) n += covered(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
    }
    const v = Math.round((255 * n) / (SS * SS));
    full[y * SIZE + x] = v;
    if (v) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
}

// Crop to the ink, then encode as 8-bit greyscale with filter 0 on every row.
const w = x1 - x0 + 1;
const h = y1 - y0 + 1;
const raw = Buffer.alloc((w + 1) * h);
for (let y = 0; y < h; y++) {
  raw[y * (w + 1)] = 0;
  for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = full[(y + y0) * SIZE + x + x0];
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0);
ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // greyscale
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`wrote ${out} (${w}x${h})`);
