// Hand-built image files for the metadata-stripping tests (test/image-meta.test.js and the upload
// case in test/attachments.test.js). No image library: the server never decodes an image, so a
// fixture only has to be structurally right — real markers, real chunks, real CRCs — around a
// picture that is nonsense. Each carries the kind of metadata a phone photo does: GPS, a capture
// time, the device's make, and an Orientation.

import { crc32 } from '../../dist/image-meta.js';

export const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
export const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
export const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
export const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
export const be32 = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

export function concat(...parts) {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/** Whether `needle` occurs anywhere in `haystack`. */
export function contains(haystack, needle) {
  const n = needle instanceof Uint8Array ? needle : ascii(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

export const MAKE = 'Apple\0';
export const DATE_TIME = '2024:06:09 10:30:00\0';

/**
 * A little-endian TIFF with IFD0 = { Make, Orientation, DateTime, GPS IFD pointer }, a GPS IFD with a
 * latitude, and a next-IFD pointer to an IFD1 holding a JPEGInterchangeFormat tag (the thumbnail
 * pointer), which is what a camera writes. `orientation` 0 leaves the tag out.
 */
export function tiffWithMetadata(orientation = 6) {
  const entries = [];
  const entry = (tag, type, count, value) => entries.push([tag, type, count, value]);
  // Layout: header 8 | IFD0 (2 + 12n + 4) | Make 6 | DateTime 20 | GPS IFD (2 + 12 + 4) | lat 24 | IFD1 (2 + 12 + 4)
  const n = orientation ? 4 : 3;
  const ifd0 = 8;
  const makeAt = ifd0 + 2 + 12 * n + 4;
  const dateAt = makeAt + 6;
  const gpsAt = dateAt + 20;
  const latAt = gpsAt + 2 + 12 + 4;
  const ifd1At = latAt + 24;
  entry(0x010f, 2, 6, makeAt);
  if (orientation) entry(0x0112, 3, 1, orientation);
  entry(0x0132, 2, 20, dateAt);
  entry(0x8825, 4, 1, gpsAt);
  const ifd = (list, next) =>
    concat(le16(list.length), ...list.map(([tag, type, count, value]) => concat(le16(tag), le16(type), le32(count), type === 3 ? [...le16(value), 0, 0] : le32(value))), le32(next));
  return concat(
    ascii('II'), le16(42), le32(ifd0),
    ifd(entries, ifd1At),
    ascii(MAKE),
    ascii(DATE_TIME),
    ifd([[0x0002, 5, 3, latAt]], 0),
    le32(40), le32(1), le32(45), le32(1), le32(30), le32(1), // 40°45'30"
    ifd([[0x0201, 4, 1, 0]], 0),
  );
}

const ICC = concat(ascii('ICC_PROFILE\0'), [1, 1], ascii('fake-icc-profile-bytes'));

export const jpegSegment = (marker, payload) => concat([0xff, marker], be16(payload.length + 2), payload);

/** The structural tail of a JPEG: a tiny DQT, SOF0, DHT, SOS, some scan bytes, EOI. Never decoded. */
export const JPEG_TAIL = concat(
  jpegSegment(0xdb, concat([0], new Uint8Array(64).fill(1))),
  jpegSegment(0xc0, [8, ...be16(1), ...be16(1), 1, 1, 0x11, 0]),
  jpegSegment(0xc4, concat([0], new Uint8Array(16).fill(0), [0])),
  [0xff, 0xda], be16(8), [1, 1, 0, 0, 63, 0],
  [0x12, 0x34, 0x56, 0xff, 0x00, 0x78], // scan data, with an escaped FF
  [0xff, 0xd9],
);

/**
 * A JPEG the way a phone writes one: SOI, APP1 Exif (with GPS, the time, the make and the
 * orientation), APP1 XMP, APP2 ICC, APP13 Photoshop, COM, then the picture.
 */
export function jpegWithMetadata({ orientation = 6, exif = true } = {}) {
  return concat(
    [0xff, 0xd8],
    jpegSegment(0xe0, concat(ascii('JFIF\0'), [1, 2, 0, ...be16(72), ...be16(72), 0, 0])),
    exif ? jpegSegment(0xe1, concat(ascii('Exif\0\0'), tiffWithMetadata(orientation))) : [],
    jpegSegment(0xe1, concat(ascii('http://ns.adobe.com/xap/1.0/\0'), ascii('<x:xmpmeta>CreatorTool=iPhone</x:xmpmeta>'))),
    jpegSegment(0xe2, ICC),
    jpegSegment(0xed, concat(ascii('Photoshop 3.0\0'), ascii('8BIM'), [4, 4, 0, 0], be32(2), [0, 0])),
    jpegSegment(0xfe, ascii('shot by a real person')),
    JPEG_TAIL,
  );
}

export const JPEG_ICC_SEGMENT = jpegSegment(0xe2, ICC);

export function pngChunk(type, data) {
  const t = ascii(type);
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
  return concat(be32(d.length), t, d, be32(crc32(t, d)));
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG with every text chunk, a tIME, an eXIf, an iCCP and sRGB around a nonsense IDAT. */
export function pngWithMetadata({ orientation = 8 } = {}) {
  return concat(
    PNG_SIGNATURE,
    pngChunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0]),
    pngChunk('gAMA', be32(45455)),
    pngChunk('iCCP', concat(ascii('fake\0'), [0], ascii('zzzz'))),
    pngChunk('sRGB', [0]),
    pngChunk('tEXt', ascii('Author\0A Person')),
    pngChunk('zTXt', concat(ascii('Comment\0'), [0], ascii('xxxx'))),
    pngChunk('iTXt', concat(ascii('XML:com.adobe.xmp\0'), [0, 0], ascii('\0\0<x:xmpmeta/>'))),
    pngChunk('tIME', [...be16(2024), 6, 9, 10, 30, 0]),
    pngChunk('eXIf', tiffWithMetadata(orientation)),
    pngChunk('IDAT', [0x78, 0x9c, 1, 2, 3, 4, 5, 6]),
    pngChunk('IEND', []),
  );
}

export function webpChunk(type, data) {
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
  return concat(ascii(type), le32(d.length), d, d.length & 1 ? [0] : []);
}

/** A WebP (extended format) with ICCP, an odd-length VP8L, EXIF and XMP; VP8X flags say so. */
export function webpWithMetadata({ orientation = 6, exifPrefix = false } = {}) {
  const flags = 0x20 | 0x08 | 0x04; // ICC | EXIF | XMP (see VP8X in image-meta.ts)
  const body = concat(
    webpChunk('VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    webpChunk('ICCP', ascii('fake-icc')),
    webpChunk('VP8L', [0x2f, 1, 2, 3, 4]), // 5 bytes: padded
    webpChunk('EXIF', exifPrefix ? concat(ascii('Exif\0\0'), tiffWithMetadata(orientation)) : tiffWithMetadata(orientation)),
    webpChunk('XMP ', ascii('<x:xmpmeta>CreatorTool=Pixel</x:xmpmeta>')),
  );
  return concat(ascii('RIFF'), le32(4 + body.length), ascii('WEBP'), body);
}

const gifSubBlocks = (bytes) => {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.subarray(i, i + 255);
    out.push([slice.length], slice);
  }
  out.push([0]);
  return concat(...out);
};

export const GIF_IMAGE = concat(
  [0x2c, ...le16(0), ...le16(0), ...le16(1), ...le16(1), 0x80 | 0x00], // a local colour table of 2
  [9, 9, 9, 8, 8, 8],
  [2], gifSubBlocks(Uint8Array.from([0x44, 0x01])),
);

/** A GIF89a with a loop extension, a comment, an XMP application extension and one frame. */
export function gifWithMetadata() {
  return concat(
    ascii('GIF89a'), le16(1), le16(1), [0x80 | 0x00, 0, 0], [0, 0, 0, 255, 255, 255], // global table of 2
    [0x21, 0xff], gifSubBlocks(concat(ascii('NETSCAPE2.0'))).subarray(0, 12), [3, 1, 0, 0, 0],
    [0x21, 0xfe], gifSubBlocks(ascii('made on a phone')),
    [0x21, 0xff], gifSubBlocks(concat(ascii('XMP DataXMP'))).subarray(0, 12), gifSubBlocks(ascii('<x:xmpmeta/>')),
    [0x21, 0xf9], [4, 0, 0, 0, 0, 0],
    GIF_IMAGE,
    [0x3b],
  );
}
