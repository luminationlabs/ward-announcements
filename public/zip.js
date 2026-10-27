/**
 * A minimal zip writer and reader, for the full backup (`backup.json` plus every image).
 *
 * Built in the browser rather than on the server because of CPU, not bytes: a free-plan Worker has
 * about 10 ms of CPU per request, and a CRC over tens of megabytes of images would blow through it
 * many times over. The admin's browser has CPU to spare, and it already has the images one URL away.
 *
 * Writing: **stored** entries only (no compression). The payload is JPEG/PNG/WebP/GIF, which do not
 * compress, plus one JSON file, so deflate would buy a few percent for a lot of code. Each entry
 * carries its CRC-32 and sizes in the local header (no data descriptors) and the UTF-8 name flag.
 * No zip64: a backup over 4 GB, or with 65,535 entries, is refused rather than written corrupt.
 *
 * Reading: stored entries, and deflated ones where the runtime has `DecompressionStream`
 * ('deflate-raw') — every current browser and Node 18+ — so a backup someone unzipped and zipped
 * again with their operating system's tool still loads. Every entry's CRC is checked.
 *
 * Used by three callers: the dashboard's Backup button (`public/backup-zip.js`), the operator's
 * Import Backup dialog (src/operator.ts), and `scripts/db-restore.mjs`, which runs this same file in
 * a `vm`. Dependency-free and DOM-free for that reason; test/zip.test.js runs it the same way.
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  /** CRC-32 (the zip/PNG polynomial) of a byte array. */
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  /** MS-DOS date and time fields, in local time as zip tools expect. Clamped to the format's 1980 floor. */
  function dosDateTime(date) {
    var d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
    var year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function header(size) {
    var bytes = new Uint8Array(size);
    return { bytes: bytes, view: new DataView(bytes.buffer) };
  }

  /**
   * The zip as a list of byte arrays, in file order — hand it to `new Blob(parts)` and the browser
   * never has to copy every image into one more buffer. `entries` is `[{ name, data, date? }]`, with
   * `data` a Uint8Array or a string (written as UTF-8).
   */
  function createZipParts(entries) {
    if (entries.length > 0xfffe) throw new Error('Too many files for one zip (' + entries.length + ').');
    var parts = [];
    var central = [];
    var offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var name = utf8(String(entry.name));
      var data = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
      // isView rather than instanceof: the bytes may come from another realm (a `vm` in the tests).
      if (!ArrayBuffer.isView(data)) throw new Error(entry.name + ': data must be bytes or text.');
      var crc = crc32(data);
      var when = dosDateTime(entry.date);

      var local = header(30 + name.length);
      local.view.setUint32(0, 0x04034b50, true); // local file header signature
      local.view.setUint16(4, 20, true); // version needed: 2.0
      local.view.setUint16(6, 0x0800, true); // flags: names are UTF-8
      local.view.setUint16(8, 0, true); // method: stored
      local.view.setUint16(10, when.time, true);
      local.view.setUint16(12, when.date, true);
      local.view.setUint32(14, crc, true);
      local.view.setUint32(18, data.length, true);
      local.view.setUint32(22, data.length, true);
      local.view.setUint16(26, name.length, true);
      local.view.setUint16(28, 0, true); // no extra field
      local.bytes.set(name, 30);

      var dir = header(46 + name.length);
      dir.view.setUint32(0, 0x02014b50, true); // central directory signature
      dir.view.setUint16(4, 20, true); // version made by
      dir.view.setUint16(6, 20, true); // version needed
      dir.view.setUint16(8, 0x0800, true);
      dir.view.setUint16(10, 0, true);
      dir.view.setUint16(12, when.time, true);
      dir.view.setUint16(14, when.date, true);
      dir.view.setUint32(16, crc, true);
      dir.view.setUint32(20, data.length, true);
      dir.view.setUint32(24, data.length, true);
      dir.view.setUint16(28, name.length, true);
      // 30 extra length, 32 comment length, 34 disk number, 36 internal attributes: all zero.
      dir.view.setUint32(38, 0, true); // external attributes
      dir.view.setUint32(42, offset, true); // where the local header starts
      dir.bytes.set(name, 46);

      parts.push(local.bytes, data);
      central.push(dir.bytes);
      offset += local.bytes.length + data.length;
      if (offset > 0xffffffff) throw new Error('The backup is too large for a zip without zip64 (over 4 GB).');
    }
    var dirSize = 0;
    for (var j = 0; j < central.length; j++) dirSize += central[j].length;
    var end = header(22);
    end.view.setUint32(0, 0x06054b50, true); // end of central directory
    end.view.setUint16(8, entries.length, true); // entries on this disk
    end.view.setUint16(10, entries.length, true); // entries in total
    end.view.setUint32(12, dirSize, true);
    end.view.setUint32(16, offset, true); // where the central directory starts
    return parts.concat(central, [end.bytes]);
  }

  function concat(parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], at);
      at += parts[j].length;
    }
    return out;
  }

  /** The zip as one Uint8Array. */
  function createZip(entries) {
    return concat(createZipParts(entries));
  }

  /** Is this the start of a zip file (a local file header, or an empty zip's end record)? */
  function isZip(bytes) {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
    );
  }

  function inflateRaw(data) {
    if (typeof DecompressionStream !== 'function') {
      return Promise.reject(
        new Error('This zip is compressed, and this browser cannot unpack it. Use the zip exactly as the Backup button made it.'),
      );
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  /**
   * Every file in a zip: `Promise<[{ name, data }]>`, in central-directory order. Rejects with a
   * message a person can act on for anything it cannot read faithfully: not a zip, zip64, an
   * encrypted entry, a compression method other than deflate, or a CRC that does not match.
   */
  function readZip(input) {
    return Promise.resolve().then(function () {
      var bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // The end record is the last 22 bytes plus a comment of up to 65,535.
      var eocd = -1;
      for (var p = bytes.length - 22; p >= 0 && p >= bytes.length - 22 - 0xffff; p--) {
        if (view.getUint32(p, true) === 0x06054b50) {
          eocd = p;
          break;
        }
      }
      if (eocd < 0) throw new Error('This is not a zip file (or it was cut short).');
      var count = view.getUint16(eocd + 10, true);
      var dirOffset = view.getUint32(eocd + 16, true);
      if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('This zip uses zip64, which is not supported.');

      var files = [];
      var at = dirOffset;
      for (var i = 0; i < count; i++) {
        if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
          throw new Error('This zip’s file list is damaged.');
        }
        var flags = view.getUint16(at + 8, true);
        var method = view.getUint16(at + 10, true);
        var crc = view.getUint32(at + 16, true);
        var packed = view.getUint32(at + 20, true);
        var size = view.getUint32(at + 24, true);
        var nameLen = view.getUint16(at + 28, true);
        var extraLen = view.getUint16(at + 30, true);
        var commentLen = view.getUint16(at + 32, true);
        var localAt = view.getUint32(at + 42, true);
        var name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
        at += 46 + nameLen + extraLen + commentLen;
        if (flags & 1) throw new Error(name + ' is encrypted, which is not supported.');
        if (packed === 0xffffffff || size === 0xffffffff || localAt === 0xffffffff) {
          throw new Error('This zip uses zip64, which is not supported.');
        }
        if (method !== 0 && method !== 8) {
          throw new Error(name + ' uses a compression method (' + method + ') that is not supported.');
        }
        if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) {
          throw new Error('This zip is damaged near ' + name + '.');
        }
        var start = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
        if (start + packed > bytes.length) throw new Error('This zip was cut short (' + name + ').');
        files.push({ name: name, method: method, crc: crc, size: size, raw: bytes.subarray(start, start + packed) });
      }
      // Directories carry no data; leave them out.
      files = files.filter(function (f) { return !/\/$/.test(f.name); });
      return Promise.all(
        files.map(function (f) {
          var data = f.method === 0 ? Promise.resolve(f.raw) : inflateRaw(f.raw);
          return data.then(function (d) {
            if (d.length !== f.size || crc32(d) !== f.crc) {
              throw new Error(f.name + ' is damaged (its checksum does not match).');
            }
            return { name: f.name, data: d };
          });
        }),
      );
    });
  }

  root.WardZip = {
    crc32: crc32,
    createZip: createZip,
    createZipParts: createZipParts,
    readZip: readZip,
    isZip: isZip,
  };
})(typeof window !== 'undefined' ? window : globalThis);
