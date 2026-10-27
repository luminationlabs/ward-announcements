// Stripping identifying metadata from an image before it is stored (src/image-meta.ts).
//
// In process, with files assembled by hand (test/helpers/image-fixtures.js): the server never
// decodes an image, so what matters is the container walk — which segments and chunks survive,
// that the picture itself is untouched byte for byte, that the Orientation a phone wrote comes
// through, and that a file the walk does not understand is handed back as it was rather than
// mangled or refused. Node only. Run with: npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { crc32, stripImageMetadata } from '../dist/image-meta.js';
import {
  DATE_TIME, GIF_IMAGE, JPEG_ICC_SEGMENT, JPEG_TAIL, MAKE, PNG_SIGNATURE,
  ascii, be16, be32, concat, contains, gifWithMetadata, jpegSegment, jpegWithMetadata, le16, le32,
  pngChunk, pngWithMetadata, tiffWithMetadata, webpChunk, webpWithMetadata,
} from './helpers/image-fixtures.js';

/** "Exif\0\0" + the 26-byte TIFF the stripper writes for an orientation. */
const minimalExif = (orientation) =>
  concat(ascii('Exif\0\0'), ascii('II'), le16(42), le32(8), le16(1), le16(0x0112), le16(3), le32(1), [orientation, 0, 0, 0], le32(0));
const minimalTiff = (orientation) => minimalExif(orientation).subarray(6);

/** The JPEG's segments up to SOS, as [marker, payload] pairs, and the bytes from SOS on. */
function jpegSegments(bytes) {
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);
  const segments = [];
  let pos = 2;
  while (bytes[pos + 1] !== 0xda) {
    assert.equal(bytes[pos], 0xff, `a marker at ${pos}`);
    const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
    segments.push([bytes[pos + 1], bytes.subarray(pos + 4, pos + 2 + length)]);
    pos += 2 + length;
  }
  return { segments, fromSos: bytes.subarray(pos) };
}

const GPS_TAG = Uint8Array.from([0x25, 0x88]); // 0x8825 little-endian
const GPS_IDENTIFYING = ['Apple', '2024:06:09', GPS_TAG];

const assertNoIdentifyingBytes = (bytes) => {
  for (const needle of GPS_IDENTIFYING) assert.ok(!contains(bytes, needle), `no ${typeof needle === 'string' ? needle : 'GPS IFD tag'} left`);
};

describe('JPEG', () => {
  test('a phone photo keeps its orientation, its colour profile and its picture, and nothing else', () => {
    const input = jpegWithMetadata({ orientation: 6 });
    const out = stripImageMetadata(input, 'image/jpeg');
    assert.notEqual(out, input);
    assert.ok(out.length < input.length);
    const { segments, fromSos } = jpegSegments(out);
    const app1 = segments.filter(([m]) => m === 0xe1);
    assert.equal(app1.length, 1, 'exactly one APP1');
    assert.deepEqual(app1[0][1], minimalExif(6), 'and it is the minimal Exif: Orientation = 6 alone');
    assertNoIdentifyingBytes(out);
    assert.ok(!contains(out, 'xmpmeta'), 'XMP is gone');
    assert.ok(!contains(out, 'Photoshop'), 'APP13 is gone');
    assert.ok(!contains(out, 'shot by'), 'the comment is gone');
    assert.deepEqual(segments.map(([m]) => m), [0xe0, 0xe1, 0xe2, 0xdb, 0xc0, 0xc4], 'JFIF, Exif, ICC, then the frame');
    assert.ok(contains(out, JPEG_ICC_SEGMENT), 'the ICC segment is byte-identical');
    assert.deepEqual(fromSos, jpegSegments(input).fromSos, 'everything from SOS on is byte-identical');
  });

  for (const orientation of [2, 3, 4, 5, 7, 8]) {
    test(`orientation ${orientation} survives`, () => {
      const out = stripImageMetadata(jpegWithMetadata({ orientation }), 'image/jpeg');
      assert.deepEqual(jpegSegments(out).segments.find(([m]) => m === 0xe1)[1], minimalExif(orientation));
    });
  }

  test('orientation 1 (upright) leaves no APP1 at all', () => {
    const out = stripImageMetadata(jpegWithMetadata({ orientation: 1 }), 'image/jpeg');
    assert.equal(jpegSegments(out).segments.filter(([m]) => m === 0xe1).length, 0);
    assertNoIdentifyingBytes(out);
  });

  test('no orientation tag: no APP1 either', () => {
    const out = stripImageMetadata(jpegWithMetadata({ orientation: 0 }), 'image/jpeg');
    assert.equal(jpegSegments(out).segments.filter(([m]) => m === 0xe1).length, 0);
    assertNoIdentifyingBytes(out);
  });

  test('a big-endian (MM) Exif is read too', () => {
    const tiff = concat(ascii('MM'), be16(42), be32(8), be16(1), be16(0x0112), be16(3), be32(1), [0, 3, 0, 0], be32(0));
    const input = concat([0xff, 0xd8], jpegSegment(0xe1, concat(ascii('Exif\0\0'), tiff)), JPEG_TAIL);
    const out = stripImageMetadata(input, 'image/jpeg');
    assert.deepEqual(jpegSegments(out).segments[0][1], minimalExif(3));
  });

  test('a JPEG with nothing to strip comes back as the same reference', () => {
    const input = concat([0xff, 0xd8], jpegSegment(0xe0, ascii('JFIF\0')), JPEG_ICC_SEGMENT, JPEG_TAIL);
    assert.equal(stripImageMetadata(input, 'image/jpeg'), input);
  });

  test('a truncated or garbage file comes back as the same reference, never a throw', () => {
    const whole = jpegWithMetadata();
    for (const input of [
      whole.subarray(0, 40), // cut inside the Exif segment
      whole.subarray(0, whole.indexOf(0xda) - 1), // every segment, but no SOS
      Uint8Array.from([0xff, 0xd8, 0xff]),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), // a length past the end
      ascii('not a jpeg at all'),
      new Uint8Array(0),
    ]) {
      assert.equal(stripImageMetadata(input, 'image/jpeg'), input);
    }
  });

  test('restart markers and fill bytes before SOS are kept', () => {
    const input = concat([0xff, 0xd8, 0xff, 0xff], jpegSegment(0xdb, [0, 1]), [0xff, 0xd0], jpegSegment(0xfe, ascii('x')), JPEG_TAIL);
    const out = stripImageMetadata(input, 'image/jpeg');
    assert.deepEqual([...out.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xff]);
    assert.ok(contains(out, Uint8Array.from([0xff, 0xd0, 0xff, 0xdb])), 'RST0 kept, COM gone');
  });

  test('a 4 MB photo whose metadata is small is stripped in well under the Worker budget', () => {
    const input = concat(jpegWithMetadata(), new Uint8Array(4 * 1024 * 1024).fill(0x5a), [0xff, 0xd9]);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const out = stripImageMetadata(input, 'image/jpeg');
      best = Math.min(best, performance.now() - t0);
      assert.ok(out.length > 4 * 1024 * 1024);
    }
    console.log(`strip of a 4 MB JPEG: ${best.toFixed(2)} ms (best of 5)`);
    assert.ok(best < 5, `${best.toFixed(2)} ms is under 5 ms`);
  });
});

/** Every chunk of a PNG as [type, data], checking each CRC on the way. */
function pngChunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let pos = 8; pos < bytes.length; ) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    assert.equal(view.getUint32(pos + 8 + length), crc32(bytes.subarray(pos + 4, pos + 8), data), `${type}: a valid CRC`);
    chunks.push([type, data]);
    pos += 12 + length;
  }
  return chunks;
}

describe('PNG', () => {
  test('crc32 is the one PNG uses', () => {
    assert.equal(crc32(ascii('IEND')), 0xae426082); // the constant every PNG ends with
    assert.equal(crc32(ascii('123456789')), 0xcbf43926);
  });

  test('text, time and EXIF chunks go; the picture, its colour chunks and the orientation stay', () => {
    const input = pngWithMetadata({ orientation: 8 });
    const out = stripImageMetadata(input, 'image/png');
    assert.notEqual(out, input);
    const chunks = pngChunks(out);
    assert.deepEqual(chunks.map(([t]) => t), ['IHDR', 'gAMA', 'iCCP', 'sRGB', 'eXIf', 'IDAT', 'IEND']);
    assert.deepEqual(chunks.find(([t]) => t === 'eXIf')[1], minimalTiff(8));
    for (const type of ['IHDR', 'iCCP', 'IDAT']) {
      assert.deepEqual(chunks.find(([t]) => t === type)[1], pngChunks(input).find(([t]) => t === type)[1], `${type} intact`);
    }
    assertNoIdentifyingBytes(out);
    assert.ok(!contains(out, 'A Person') && !contains(out, 'xmpmeta'));
  });

  test('an upright eXIf is dropped altogether', () => {
    const chunks = pngChunks(stripImageMetadata(pngWithMetadata({ orientation: 1 }), 'image/png'));
    assert.deepEqual(chunks.map(([t]) => t), ['IHDR', 'gAMA', 'iCCP', 'sRGB', 'IDAT', 'IEND']);
  });

  test('a PNG with nothing to strip is the same reference; a truncated one too', () => {
    const plain = concat(PNG_SIGNATURE, pngChunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0]), pngChunk('IDAT', [1]), pngChunk('IEND', []));
    assert.equal(stripImageMetadata(plain, 'image/png'), plain);
    const cut = pngWithMetadata().subarray(0, 60);
    assert.equal(stripImageMetadata(cut, 'image/png'), cut);
    const noEnd = concat(PNG_SIGNATURE, pngChunk('tEXt', ascii('a\0b')));
    assert.equal(stripImageMetadata(noEnd, 'image/png'), noEnd, 'no IEND: left alone');
  });
});

/** A WebP's chunks as [type, data], plus the RIFF size field. */
function webpChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'WEBP');
  const chunks = [];
  for (let pos = 12; pos < bytes.length; ) {
    const type = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const length = view.getUint32(pos + 4, true);
    chunks.push([type, bytes.subarray(pos + 8, pos + 8 + length)]);
    pos += 8 + length + (length & 1);
  }
  return { chunks, riffSize: view.getUint32(4, true) };
}

describe('WebP', () => {
  test('EXIF and XMP go, VP8X forgets them, the RIFF size is right, ICCP and the picture stay', () => {
    const input = webpWithMetadata({ orientation: 1 });
    const out = stripImageMetadata(input, 'image/webp');
    assert.notEqual(out, input);
    const { chunks, riffSize } = webpChunks(out);
    assert.deepEqual(chunks.map(([t]) => t), ['VP8X', 'ICCP', 'VP8L']);
    assert.equal(chunks[0][1][0], 0x20, 'flags: ICC only — the EXIF (0x08) and XMP (0x04) bits are cleared');
    assert.equal(riffSize, out.length - 8);
    assert.deepEqual(chunks[1][1], ascii('fake-icc'));
    assert.deepEqual(chunks[2][1], Uint8Array.from([0x2f, 1, 2, 3, 4]));
    assert.equal(out.length % 2, 0, 'chunks stay padded to even lengths');
    assertNoIdentifyingBytes(out);
    assert.ok(!contains(out, 'xmpmeta'));
  });

  for (const exifPrefix of [false, true]) {
    test(`an orientation is kept as a minimal raw-TIFF EXIF chunk (${exifPrefix ? 'with' : 'without'} an Exif\\0\\0 prefix in the input)`, () => {
      const { chunks } = webpChunks(stripImageMetadata(webpWithMetadata({ orientation: 6, exifPrefix }), 'image/webp'));
      assert.deepEqual(chunks.map(([t]) => t), ['VP8X', 'ICCP', 'VP8L', 'EXIF']);
      assert.equal(chunks[0][1][0], 0x20 | 0x08, 'the EXIF bit stays set, XMP cleared');
      assert.deepEqual(chunks[3][1], minimalTiff(6));
    });
  }

  test('a simple-format WebP (no VP8X, nothing to strip) is the same reference; so is a truncated one', () => {
    const body = webpChunk('VP8 ', [1, 2, 3, 4, 5, 6]);
    const plain = concat(ascii('RIFF'), le32(4 + body.length), ascii('WEBP'), body);
    assert.equal(stripImageMetadata(plain, 'image/webp'), plain);
    const cut = webpWithMetadata().subarray(0, 50);
    assert.equal(stripImageMetadata(cut, 'image/webp'), cut);
  });
});

describe('GIF', () => {
  test('the comment and the XMP application extension go; the loop extension and the frame stay', () => {
    const input = gifWithMetadata();
    const out = stripImageMetadata(input, 'image/gif');
    assert.notEqual(out, input);
    assert.ok(!contains(out, 'made on a phone'));
    assert.ok(!contains(out, 'XMP DataXMP') && !contains(out, 'xmpmeta'));
    assert.ok(contains(out, 'NETSCAPE2.0'), 'the animation loop count is kept');
    assert.ok(contains(out, concat([0x21, 0xf9, 4, 0, 0, 0, 0, 0], GIF_IMAGE, [0x3b])), 'the graphic control, the frame and the trailer are byte-identical');
    assert.deepEqual(out.subarray(0, 19), input.subarray(0, 19), 'header, screen descriptor and global colour table intact');
  });

  test('a GIF with nothing to strip is the same reference; a truncated one too', () => {
    const plain = concat(ascii('GIF89a'), le16(1), le16(1), [0, 0, 0], GIF_IMAGE, [0x3b]);
    assert.equal(stripImageMetadata(plain, 'image/gif'), plain);
    const cut = gifWithMetadata().subarray(0, 30);
    assert.equal(stripImageMetadata(cut, 'image/gif'), cut);
  });
});

test('an unknown type is passed through', () => {
  const input = ascii('whatever');
  assert.equal(stripImageMetadata(input, 'image/bmp'), input);
});

test('the fixtures really carry what the tests look for', () => {
  for (const [bytes, type] of [[jpegWithMetadata(), 'jpeg'], [pngWithMetadata(), 'png'], [webpWithMetadata(), 'webp']]) {
    assert.ok(contains(bytes, MAKE) && contains(bytes, DATE_TIME) && contains(bytes, GPS_TAG), type);
  }
  assert.equal(tiffWithMetadata(6).length, 8 + 54 + 6 + 20 + 18 + 24 + 18);
});
