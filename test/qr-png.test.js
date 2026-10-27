// The hand-rolled PNG encoder behind the dashboard's "Download QR code · PNG".
//
// Node-only and in process, for the reason `programs-core.test.js` is: this is a pure function of
// its input, and the honest test is to decode what it produced rather than to drive it over HTTP.
// `node:zlib` is the point of the exercise — the encoder deliberately avoids it (Workers has no
// `node:zlib`, which is why the file exists at all), so inflating the stream *here* checks the
// hand-written stored-deflate blocks against a real implementation rather than against itself.
//
// The end-to-end half — that the route serves these bytes on both runtimes — is in
// `test/roles.test.js`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import QRCode from 'qrcode';
import { qrPng, scaleFor } from '../dist/qr-png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk the chunk list, checking every CRC on the way. Returns the chunks by type. */
function readPng(bytes) {
  const buf = Buffer.from(bytes);
  assert.ok(buf.subarray(0, 8).equals(SIGNATURE), 'PNG signature');
  const chunks = [];
  let at = 8;
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('ascii');
    const payload = buf.subarray(at + 8, at + 8 + length);
    const stated = buf.readUInt32BE(at + 8 + length);
    assert.equal(stated, crc32(buf.subarray(at + 4, at + 8 + length)), `CRC of ${type}`);
    chunks.push({ type, payload });
    at += 12 + length;
  }
  assert.equal(at, buf.length, 'no trailing bytes');
  return chunks;
}

/** An independent CRC-32, written the slow obvious way so it shares no code with the encoder. */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Decode to a `pixel(x, y) => 'dark' | 'light'` reader. */
function decode(bytes) {
  const chunks = readPng(bytes);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
  const ihdr = chunks[0].payload;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.equal(ihdr[8], 1, 'bit depth 1');
  assert.equal(ihdr[9], 0, 'greyscale');
  assert.equal(ihdr[10], 0, 'deflate');
  assert.equal(ihdr[11], 0, 'no filter method');
  assert.equal(ihdr[12], 0, 'not interlaced');

  const raster = inflateSync(chunks[1].payload);
  const bytesPerRow = Math.ceil(width / 8);
  assert.equal(raster.length, (bytesPerRow + 1) * height, 'one filter byte per scanline');
  for (let y = 0; y < height; y++) {
    assert.equal(raster[y * (bytesPerRow + 1)], 0, `row ${y} uses filter 0`);
  }
  return {
    width,
    height,
    pixel(x, y) {
      const byte = raster[y * (bytesPerRow + 1) + 1 + (x >> 3)];
      return byte & (0x80 >> (x & 7)) ? 'light' : 'dark';
    },
  };
}

const LINK = 'https://announcements.example.org/#code=a868-2sz7-kg2d-mne4';

describe('qrPng', () => {
  test('produces a decodable PNG whose pixels are the QR matrix', () => {
    const matrix = QRCode.create(LINK, {}).modules;
    const scale = 6;
    const margin = 2;
    const image = decode(qrPng(matrix, { scale, margin }));

    const expected = (matrix.size + margin * 2) * scale;
    assert.equal(image.width, expected);
    assert.equal(image.height, expected);

    // Every pixel, against the matrix it came from — the assertion that actually matters, since a
    // QR that is subtly wrong still looks exactly like a QR.
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const moduleX = Math.floor(x / scale) - margin;
        const moduleY = Math.floor(y / scale) - margin;
        const inside =
          moduleX >= 0 && moduleY >= 0 && moduleX < matrix.size && moduleY < matrix.size;
        const dark = inside && !!matrix.data[moduleY * matrix.size + moduleX];
        assert.equal(
          image.pixel(x, y),
          dark ? 'dark' : 'light',
          `pixel ${x},${y} (module ${moduleX},${moduleY})`,
        );
      }
    }
  });

  test('the quiet zone is white all the way round', () => {
    const matrix = QRCode.create(LINK, {}).modules;
    const image = decode(qrPng(matrix, { scale: 4, margin: 4 }));
    const last = image.width - 1;
    for (let i = 0; i < image.width; i++) {
      for (const [x, y] of [
        [i, 0],
        [i, last],
        [0, i],
        [last, i],
      ]) {
        assert.equal(image.pixel(x, y), 'light', `border pixel ${x},${y}`);
      }
    }
  });

  test('the top-left finder pattern is where a scanner expects it', () => {
    // A QR always opens with a 7x7 finder: dark ring, light ring, 3x3 dark core. Checking it pins
    // the orientation — a transposed raster would pass a "same number of dark pixels" test.
    const matrix = QRCode.create(LINK, {}).modules;
    const scale = 5;
    const margin = 0;
    const image = decode(qrPng(matrix, { scale, margin }));
    const at = (mx, my) => image.pixel(mx * scale + 2, my * scale + 2);
    assert.equal(at(0, 0), 'dark');
    assert.equal(at(6, 0), 'dark');
    assert.equal(at(1, 1), 'light');
    assert.equal(at(3, 3), 'dark'); // the core
    assert.equal(at(7, 0), 'light'); // the separator
  });

  test('spans more than one stored deflate block', () => {
    // A stored block holds at most 64 KB, so a full-size download is several. This is the case the
    // block loop gets wrong if it gets anything wrong, and a real QR download is on the far side of
    // that boundary — so assert it rather than only ever testing the small ones above.
    const matrix = QRCode.create(LINK, {}).modules;
    const modules = matrix.size + 4;
    const bytes = qrPng(matrix, { scale: scaleFor(modules), margin: 2 });
    const image = decode(bytes);
    assert.ok(image.width > 900 && image.width < 1150, `~1024px, got ${image.width}`);
    const raw = (Math.ceil(image.width / 8) + 1) * image.height;
    assert.ok(raw > 0xffff, 'the raster should exceed one stored block');
    assert.equal(image.pixel(0, 0), 'light', 'still starts with the quiet zone');
  });

  test('scaleFor rounds to whole pixels per module', () => {
    assert.equal(scaleFor(37), 28); // 1036px
    assert.equal(scaleFor(37, 208), 6);
    assert.equal(scaleFor(1000, 100), 1); // never zero
  });
});
