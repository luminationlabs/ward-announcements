/**
 * Stripping identifying metadata out of an uploaded image, server-side.
 *
 * An announcement's or a page's image is public by unguessable URL (`/images/:key`, see the gate
 * exemption in `app.ts`), and a phone photo carries where it was taken (GPS), when, on which
 * device, and often a thumbnail of the unrotated, uncropped original. The editor re-encodes most
 * photos to JPEG in the browser, which drops all of that, but it uploads the *original* bytes for a
 * GIF, for an image the browser cannot decode (or has no `createImageBitmap` for), and for an image
 * already within 1600 px whose re-encode came out no smaller (the upload script in `imagesCard`,
 * `views.ts`). The server used to store what it was sent. Now every byte that enters the store —
 * an upload, the many-ward host's Import Backup, `scripts/db-restore.mjs` — goes through here first.
 *
 * What survives, and nothing else:
 *   - the EXIF **Orientation** tag, rewritten into a minimal Exif block of its own, because a phone
 *     photo stored sideways must still display the right way up (the owner's one hard requirement);
 *   - the **colour profile** (JPEG APP2 ICC_PROFILE, PNG iCCP/sRGB/gAMA/cHRM, WebP ICCP), which is
 *     not identifying and without which colours shift;
 *   - everything the decoder needs: the whole of a JPEG from SOS on, APP0/JFIF and APP14/Adobe,
 *     every PNG chunk the spec calls critical or colour-related, WebP's VP8/VP8L/VP8X/ALPH/ANIM/
 *     ANMF, a GIF's frames and its NETSCAPE2.0 loop extension.
 * Everything else — EXIF beyond Orientation (its thumbnail IFD1 included), XMP, IPTC/Photoshop,
 * comments, timestamps, text chunks — is dropped.
 *
 * Nothing here decodes pixels. A JPEG is walked marker by marker up to SOS and copied verbatim from
 * there; a PNG and a WebP are walked chunk by chunk, skipping image data by its length; a GIF by its
 * block structure, skipping LZW data by its sub-block lengths. On any structural surprise — a length
 * past the end, a missing SOS, a chunk that is not where it should be — the input is returned
 * **unchanged**: a corrupt-looking file is the upload validator's problem, not this module's, and a
 * stripper that threw would turn a bad photo into a 500. The same reference comes back when there
 * was nothing to remove, so a caller can tell at a glance whether anything changed.
 *
 * Pure and dependency-free on purpose, like `restore.ts` and `seal.ts`: `scripts/db-restore.mjs`
 * imports this file directly (Node strips the types), so there is no build step between an operator
 * and a restore. Only erasable TypeScript here, and nothing imported. Runtime-neutral too:
 * `Uint8Array` and `DataView` only.
 *
 * Budget: a free-plan Worker gets about 10 ms of CPU per invocation, and the upload route spends
 * some of it on the multipart parse. The walks touch only headers; the one big copy is the
 * entropy-coded body (a `set` of a subarray), and `test/image-meta.test.js` times a 4 MB JPEG.
 */

/** The EXIF Orientation tag (TIFF 6.0 / Exif 2.3, IFD0), a SHORT with a value of 1 to 8. */
const TAG_ORIENTATION = 0x0112;
const TIFF_SHORT = 3;

const ASCII = {
  exif: [0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
  icc: [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00], // "ICC_PROFILE\0"
};

function startsWith(bytes: Uint8Array, at: number, prefix: number[]): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The Orientation in a TIFF structure (`bytes[start, end)`): 2–8 when IFD0 carries one that means a
 * rotation or a flip, else 0 (absent, 1 = upright, or a TIFF that does not parse — a decoder would
 * not honour that one either, so there is nothing to keep).
 */
function orientationOf(bytes: Uint8Array, start: number, end: number): number {
  if (end - start < 8) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const le = view.getUint16(0) === 0x4949; // "II"; "MM" is big-endian
  if (!le && view.getUint16(0) !== 0x4d4d) return 0;
  if (view.getUint16(2, le) !== 42) return 0;
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > view.byteLength) return 0;
  const count = view.getUint16(ifd, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return 0;
    if (view.getUint16(entry, le) !== TAG_ORIENTATION) continue;
    if (view.getUint16(entry + 2, le) !== TIFF_SHORT || view.getUint32(entry + 4, le) !== 1) return 0;
    // A SHORT's value sits left-justified in the 4-byte value field, in the file's byte order.
    const value = view.getUint16(entry + 8, le);
    return value >= 2 && value <= 8 ? value : 0;
  }
  return 0;
}

/**
 * The smallest TIFF that says "Orientation = n": a little-endian header, IFD0 with that one entry,
 * and no next IFD (so no IFD1, which is where the thumbnail lived). 26 bytes.
 */
function minimalTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // "II", 42, IFD0 at offset 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation & 0xff, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // next IFD: none
  ]);
}

// --- JPEG -----------------------------------------------------------------

/**
 * Markers from SOI to SOS; the entropy-coded data from SOS on is copied as it is. Kept: anything
 * that is not an APPn or COM segment (SOF*, DHT, DQT, DRI, …), plus APP0 (JFIF), APP2 carrying an
 * ICC profile, APP14 (Adobe: a decoder needs its transform flag for CMYK/YCCK files), and APP1 Exif
 * reduced to its Orientation. Dropped: every other APPn (APP1 XMP, APP13 Photoshop/IPTC, the
 * vendors' own) and COM.
 */
function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let changed = false;
  let pos = 2;
  for (;;) {
    if (pos + 2 > bytes.length) return bytes; // no SOS: not a JPEG we understand
    if (bytes[pos] !== 0xff) return bytes;
    const marker = bytes[pos + 1];
    if (marker === 0xff) {
      // Fill bytes before a marker are legal; keep them, as they are harmless.
      parts.push(bytes.subarray(pos, pos + 1));
      pos += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) {
      // SOS (or a bare EOI): the rest is the picture. Never scanned.
      parts.push(bytes.subarray(pos));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      // Standalone markers carry no length.
      parts.push(bytes.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > bytes.length) return bytes;
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3]; // includes the two length bytes
    if (length < 2 || pos + 2 + length > bytes.length) return bytes;
    const segment = bytes.subarray(pos, pos + 2 + length);
    const payload = pos + 4;
    const end = pos + 2 + length;
    pos = end;

    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!isApp && marker !== 0xfe) {
      parts.push(segment);
      continue;
    }
    if (marker === 0xe0 || marker === 0xee) {
      parts.push(segment);
      continue;
    }
    if (marker === 0xe2 && startsWith(bytes, payload, ASCII.icc)) {
      parts.push(segment);
      continue;
    }
    changed = true;
    if (marker === 0xe1 && startsWith(bytes, payload, ASCII.exif)) {
      const orientation = orientationOf(bytes, payload + ASCII.exif.length, end);
      if (orientation) {
        const tiff = minimalTiff(orientation);
        const size = 2 + ASCII.exif.length + tiff.length;
        parts.push(new Uint8Array([0xff, 0xe1, size >> 8, size & 0xff, ...ASCII.exif]), tiff);
      }
    }
    // Anything else here is dropped.
  }
  return changed ? concat(parts) : bytes;
}

// --- PNG ------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Ancillary chunks that only ever carry text or a clock (PNG 1.2 §4.2.3, §4.2.4). */
const PNG_DROP = ['tEXt', 'zTXt', 'iTXt', 'tIME'];

/** CRC-32 as PNG defines it (ISO 3309 / ITU-T V.42: reflected, polynomial 0xEDB88320). A copy of
 * the one in `qr-png.ts`: this file imports nothing, so that `scripts/db-restore.mjs` can run it. */
let crcTable: Uint32Array | undefined;

export function crc32(...chunks: Uint8Array[]): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(typeBytes, data));
  return out;
}

/**
 * Chunks are `length | type | data | crc`. The text chunks, `tIME` and `eXIf` go (the last reduced
 * to its Orientation, with a fresh CRC); everything else is kept — IHDR, PLTE, tRNS, gAMA, cHRM,
 * sRGB, iCCP, IDAT, IEND and any chunk this never heard of. IDAT is skipped by its length, never
 * inflated.
 */
function stripPng(bytes: Uint8Array): Uint8Array {
  if (!startsWith(bytes, 0, PNG_SIGNATURE)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let changed = false;
  let pos = 8;
  for (;;) {
    if (pos + 12 > bytes.length) return bytes; // ran out before IEND
    const length = view.getUint32(pos);
    const start = pos;
    const payload = pos + 8;
    const end = pos + 12 + length;
    if (end > bytes.length) return bytes;
    const type = fourcc(bytes, pos + 4);
    pos = end;
    if (type === 'IEND') {
      parts.push(bytes.subarray(start)); // IEND and whatever trails it, verbatim
      break;
    }
    if (PNG_DROP.includes(type)) {
      changed = true;
      continue;
    }
    if (type === 'eXIf') {
      changed = true;
      // The payload is a raw TIFF (PNG eXIf, 2017); some writers prefix "Exif\0\0" anyway.
      const tiffAt = payload + (startsWith(bytes, payload, ASCII.exif) ? ASCII.exif.length : 0);
      const orientation = orientationOf(bytes, tiffAt, payload + length);
      if (orientation) parts.push(pngChunk('eXIf', minimalTiff(orientation)));
      continue;
    }
    parts.push(bytes.subarray(start, end));
  }
  return changed ? concat(parts) : bytes;
}

// --- WebP -----------------------------------------------------------------

/**
 * VP8X flags byte (WebP container spec, "Extended File Format"), MSB first:
 *   Rsv(2) | ICC profile | Alpha | EXIF metadata | XMP metadata | Animation | Rsv(1)
 * so ICC = 0x20, Alpha = 0x10, EXIF = 0x08, XMP = 0x04, Animation = 0x02.
 */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

/**
 * A RIFF container: `"RIFF" size "WEBP"` then chunks of `fourcc | size | payload`, each padded to
 * an even length. EXIF and XMP go (EXIF reduced to its Orientation — the chunk's payload is the raw
 * TIFF, per the spec, though some writers prefix "Exif\0\0"); VP8X's flags say what is present, so
 * a dropped chunk's bit is cleared; and the RIFF size is recomputed. The rest stays.
 */
function stripWebp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = Math.min(bytes.length, 8 + view.getUint32(4, true));
  const parts: Uint8Array[] = [];
  let vp8x: Uint8Array | undefined; // a private copy of the VP8X chunk, flags editable
  let clear = 0;
  let changed = false;
  let pos = 12;
  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) return bytes;
    const type = fourcc(bytes, pos);
    const length = view.getUint32(pos + 4, true);
    const padded = length + (length & 1);
    const end = pos + 8 + padded;
    if (pos + 8 + length > riffEnd) return bytes;
    const chunk = bytes.subarray(pos, Math.min(end, riffEnd));
    const payload = pos + 8;
    pos = end;
    if (type === 'VP8X') {
      if (length < 1) return bytes;
      vp8x = new Uint8Array(chunk);
      parts.push(vp8x);
      continue;
    }
    if (type === 'XMP ') {
      changed = true;
      clear |= VP8X_XMP;
      continue;
    }
    if (type === 'EXIF') {
      changed = true;
      const start = payload + (startsWith(bytes, payload, ASCII.exif) ? ASCII.exif.length : 0);
      const orientation = orientationOf(bytes, start, payload + length);
      if (orientation) {
        const tiff = minimalTiff(orientation);
        const header = new Uint8Array(8);
        header.set([0x45, 0x58, 0x49, 0x46]); // "EXIF"
        new DataView(header.buffer).setUint32(4, tiff.length, true);
        parts.push(header, tiff); // 26 bytes: already even, no pad
      } else {
        clear |= VP8X_EXIF;
      }
      continue;
    }
    parts.push(chunk);
  }
  if (!changed) return bytes;
  if (vp8x) vp8x[8] &= ~clear;
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return out;
}

// --- GIF ------------------------------------------------------------------

/** Application Extension identifiers (11 bytes) that are animation control, not metadata. */
const GIF_LOOP_APPS = ['NETSCAPE2.0', 'ANIMEXTS1.0'];

/** The byte after a run of data sub-blocks starting at `pos` (each `size | bytes`, ended by 0). */
function gifSkipSubBlocks(bytes: Uint8Array, pos: number): number {
  for (;;) {
    if (pos >= bytes.length) return -1;
    const size = bytes[pos];
    pos += 1 + size;
    if (size === 0) return pos;
  }
}

/**
 * Header, Logical Screen Descriptor (and its colour table), then blocks until the trailer: an Image
 * Descriptor (its colour table, the LZW minimum code size, and data sub-blocks skipped by their
 * lengths, never decoded), or an Extension (`0x21 label`, then sub-blocks — every extension kind,
 * the Graphic Control Extension's fixed block included, is shaped that way). Dropped: the Comment
 * Extension (0xFE) and every Application Extension (0xFF) other than the loop-count ones — XMP
 * ("XMP DataXMP") and an ICC profile ("ICCRGBG1012") ride in Application Extensions, and the latter
 * is vanishingly rare in a GIF, so the simple rule stands.
 */
function stripGif(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 13 || fourcc(bytes, 0) !== 'GIF8') return bytes;
  const colourTableBytes = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  let pos = 13 + colourTableBytes(bytes[10]);
  if (pos > bytes.length) return bytes;
  const parts: Uint8Array[] = [bytes.subarray(0, pos)];
  let changed = false;
  for (;;) {
    if (pos >= bytes.length) return bytes; // no trailer
    const introducer = bytes[pos];
    if (introducer === 0x3b) {
      parts.push(bytes.subarray(pos));
      break;
    }
    if (introducer === 0x2c) {
      if (pos + 10 > bytes.length) return bytes;
      const dataStart = pos + 10 + colourTableBytes(bytes[pos + 9]) + 1; // + LZW minimum code size
      const end = gifSkipSubBlocks(bytes, dataStart);
      if (end < 0) return bytes;
      parts.push(bytes.subarray(pos, end));
      pos = end;
      continue;
    }
    if (introducer !== 0x21 || pos + 2 > bytes.length) return bytes;
    const label = bytes[pos + 1];
    const end = gifSkipSubBlocks(bytes, pos + 2);
    if (end < 0) return bytes;
    const block = bytes.subarray(pos, end);
    pos = end;
    if (label === 0xfe) {
      changed = true;
      continue;
    }
    if (label === 0xff) {
      const id = block.length >= 14 && block[2] === 11 ? String.fromCharCode(...block.subarray(3, 14)) : '';
      if (!GIF_LOOP_APPS.includes(id)) {
        changed = true;
        continue;
      }
    }
    parts.push(block);
  }
  return changed ? concat(parts) : bytes;
}

// ---------------------------------------------------------------------------

/**
 * The bytes to store for an image of `contentType`: the input with its metadata gone, or the very
 * same reference when there was nothing to remove or the file did not parse (see the header).
 */
export function stripImageMetadata(bytes: Uint8Array, contentType: string): Uint8Array {
  try {
    switch (contentType) {
      case 'image/jpeg':
        return stripJpeg(bytes);
      case 'image/png':
        return stripPng(bytes);
      case 'image/webp':
        return stripWebp(bytes);
      case 'image/gif':
        return stripGif(bytes);
      default:
        return bytes;
    }
  } catch {
    return bytes;
  }
}
