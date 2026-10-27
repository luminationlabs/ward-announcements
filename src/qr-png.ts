/**
 * A PNG encoder, just big enough for a QR code.
 *
 * `qrcode` can already write a PNG on Node — but only through `pngjs`, which needs `node:zlib` and
 * Node's `Buffer` streams, neither of which this app may depend on: `app.ts` and everything it
 * imports has to run unchanged on Cloudflare Workers (see the conventions in AGENTS.md). Hence this
 * file: the library's *matrix* is pure JS and works on both runtimes, so all a PNG needs is the
 * twenty lines that turn a grid of dark squares into image bytes.
 *
 * Two decisions keep it that small:
 *
 *  - **One bit per pixel** (PNG bit depth 1, greyscale). A QR code is two colours, so this is not a
 *    compromise — it is the format's own exact representation, and it makes the raster eight times
 *    smaller before anything is compressed at all.
 *  - **Stored deflate blocks.** A zlib stream is allowed to contain literal, uncompressed blocks,
 *    which is what lets this skip a compressor entirely. It costs 5 bytes per 64 KB and, with one
 *    bit per pixel, a ~1000px QR still lands around 130 KB — a rounding error against the photos
 *    the same dashboard uploads, and the alternative was either a Node-only dependency or a
 *    hand-written Huffman coder.
 */

/** The `modules` grid `QRCode.create()` returns: `data[row * size + col]`, non-zero meaning dark. */
export interface QrMatrix {
  size: number;
  data: Uint8Array | number[];
}

export interface QrPngOptions {
  /** Pixels per QR module. */
  scale: number;
  /** Quiet-zone width, in modules. Below 4 some scanners struggle; the SVG download uses 2. */
  margin: number;
}

/**
 * Render a QR matrix as PNG bytes.
 *
 * Every module becomes a `scale`×`scale` block of pixels, so the result is exact — no resampling,
 * no soft edges, and a scanner sees the same grid the matrix describes.
 */
export function qrPng(matrix: QrMatrix, options: QrPngOptions): Uint8Array {
  const scale = Math.max(1, Math.floor(options.scale));
  const margin = Math.max(0, Math.floor(options.margin));
  const modules = matrix.size + margin * 2;
  const width = modules * scale;
  const bytesPerRow = Math.ceil(width / 8);

  // Each scanline is a filter byte (0 — "none"; the rows are already as compact as they get) plus
  // the packed pixels, most significant bit leftmost. Bit set = white, clear = black.
  const raster = new Uint8Array((bytesPerRow + 1) * width);
  const row = new Uint8Array(bytesPerRow);
  let offset = 0;
  for (let moduleY = 0; moduleY < modules; moduleY++) {
    row.fill(0xff);
    const sourceY = moduleY - margin;
    if (sourceY >= 0 && sourceY < matrix.size) {
      for (let moduleX = 0; moduleX < modules; moduleX++) {
        const sourceX = moduleX - margin;
        if (sourceX < 0 || sourceX >= matrix.size) continue;
        if (!matrix.data[sourceY * matrix.size + sourceX]) continue;
        for (let x = moduleX * scale; x < (moduleX + 1) * scale; x++) {
          row[x >> 3] &= ~(0x80 >> (x & 7));
        }
      }
    }
    // The same packed bytes for every pixel row this module row covers — build once, copy `scale`
    // times. Trailing bits past `width` in the last byte stay white and are ignored by decoders.
    for (let repeat = 0; repeat < scale; repeat++) {
      raster[offset] = 0;
      raster.set(row, offset + 1);
      offset += bytesPerRow + 1;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, width); // square
  header[8] = 1; // bit depth
  header[9] = 0; // colour type: greyscale
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // no interlacing

  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // "\x89PNG\r\n\x1a\n"
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raster)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * A sensible pixel scale for a QR of `modules` across, aiming at roughly `target` pixels wide.
 *
 * Rounded to a whole number of pixels per module rather than fitted exactly to the target: a
 * fractional module would have to be resampled, which is how a QR ends up with grey edges that a
 * phone camera has to work harder to read.
 */
export function scaleFor(modules: number, target = 1024): number {
  return Math.max(1, Math.round(target / Math.max(1, modules)));
}

/** One PNG chunk: length, type, payload, CRC-32 of type+payload. */
function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/**
 * Wrap bytes in a zlib stream (RFC 1950) made entirely of stored deflate blocks (RFC 1951 §3.2.4).
 *
 * `0x78 0x01` is the standard header for a 32 KB window at the "fastest" compression level, and
 * (0x78 << 8 | 0x01) % 31 === 0, which is the check the format requires. Each block is then a
 * 1-byte header, a little-endian length, its one's complement, and the literal bytes.
 */
function zlibStored(data: Uint8Array): Uint8Array {
  const MAX_BLOCK = 0xffff;
  const blocks: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  for (let start = 0; start < data.length || start === 0; start += MAX_BLOCK) {
    const end = Math.min(start + MAX_BLOCK, data.length);
    const length = end - start;
    const final = end >= data.length ? 1 : 0;
    const block = new Uint8Array(5 + length);
    block[0] = final; // BFINAL in bit 0, BTYPE 00 (stored) in bits 1-2
    block[1] = length & 0xff;
    block[2] = (length >> 8) & 0xff;
    block[3] = ~length & 0xff;
    block[4] = (~length >> 8) & 0xff;
    block.set(data.subarray(start, end), 5);
    blocks.push(block);
    if (final) break;
  }
  const adler = adler32(data);
  blocks.push(Uint8Array.from([adler >>> 24, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff]));
  return concat(blocks);
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Adler-32, the zlib stream's own checksum. 65521 is the largest prime below 2^16.
 *
 * The two modulos are deferred rather than run per byte, which is zlib's own trick and halves the
 * cost of encoding a QR — run per byte, it is *half* the total, and the budget it is spent against is a
 * Cloudflare Worker's ~10 ms of CPU per invocation. 5552 is the standard bound: the largest run of
 * bytes for which neither accumulator can overflow 2^32 before being reduced.
 */
function adler32(data: Uint8Array): number {
  const NMAX = 5552;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + NMAX, data.length);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
