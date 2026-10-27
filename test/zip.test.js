/**
 * The zip writer and reader behind the full backup (`public/zip.js`). The script runs verbatim in a
 * `vm`, as in a browser; what it writes is checked by a separate, minimal reader here (and CRCs by
 * `node:zlib`), so the writer is not only agreeing with its own reader. The reader is then held to
 * a deflated zip made the way an operating system's "compress" would.
 *
 * Node only, in process. Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/zip.js', import.meta.url), 'utf8');

function load() {
  const window = {};
  const context = { window, TextEncoder, TextDecoder, DecompressionStream, Blob, Response };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'zip.js' });
  return window.WardZip;
}

/** An independent reader: the central directory, then each local header, stored entries only. */
function parse(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'an end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  assert.equal(at + buf.readUInt32LE(eocd + 12), eocd, 'the central directory ends where the end record starts');
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    assert.equal(buf.readUInt32LE(local + 14), crc, 'local and central CRCs agree');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.push({ name, flags, method, crc, data: buf.subarray(start, start + size) });
  }
  return files;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('crc32 matches zlib', () => {
  const Zip = load();
  for (const sample of [Buffer.alloc(0), Buffer.from('hello'), PNG, Buffer.alloc(70_000, 7)]) {
    assert.equal(Zip.crc32(new Uint8Array(sample)), zlib.crc32(sample));
  }
});

test('a written zip holds every entry stored, with the right CRCs and UTF-8 names', () => {
  const Zip = load();
  const big = Buffer.alloc(300_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const bytes = Buffer.from(
    Zip.createZip([
      { name: 'backup.json', data: '{"tables":{}}' },
      { name: 'images/0123456789abcdef0123456789abcdef.png', data: new Uint8Array(PNG) },
      { name: 'images/big.bin', data: new Uint8Array(big) },
      { name: 'notes/año ✓.txt', data: 'ünïcode' },
    ]),
  );
  const files = parse(bytes);
  assert.deepEqual(files.map((f) => f.name), [
    'backup.json',
    'images/0123456789abcdef0123456789abcdef.png',
    'images/big.bin',
    'notes/año ✓.txt',
  ]);
  for (const f of files) {
    assert.equal(f.method, 0, 'stored');
    assert.equal(f.flags & 0x0800, 0x0800, 'UTF-8 names');
    assert.equal(zlib.crc32(f.data), f.crc, `${f.name}'s CRC`);
  }
  assert.equal(files[0].data.toString(), '{"tables":{}}');
  assert.deepEqual(files[1].data, PNG);
  assert.deepEqual(files[2].data, big);
  assert.equal(files[3].data.toString(), 'ünïcode');
});

test('the operating system unzip tool accepts it', (t) => {
  let unzip = true;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    unzip = false;
  }
  if (!unzip) return t.skip('no unzip on this machine');
  const Zip = load();
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    const file = join(dir, 'b.zip');
    writeFileSync(file, Zip.createZip([{ name: 'backup.json', data: '{}' }, { name: 'images/a.png', data: new Uint8Array(PNG) }]));
    const listing = execFileSync('unzip', ['-t', file]).toString();
    assert.match(listing, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readZip reads back what createZip wrote', async () => {
  const Zip = load();
  const entries = [
    { name: 'backup.json', data: '{"a":1}' },
    { name: 'images/x.png', data: new Uint8Array(PNG) },
  ];
  const back = await Zip.readZip(Zip.createZip(entries));
  assert.deepEqual([...back.map((e) => e.name)], ['backup.json', 'images/x.png']);
  assert.equal(Buffer.from(back[0].data).toString(), '{"a":1}');
  assert.deepEqual(Buffer.from(back[1].data), PNG);
  assert.equal(Zip.isZip(Zip.createZip(entries)), true);
  assert.equal(Zip.isZip(new TextEncoder().encode('{"tables":{}}')), false);
});

/** A zip with one deflated entry and a directory entry, as a desktop "compress" makes. */
function deflatedZip(name, content) {
  const data = Buffer.from(content);
  const packed = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const dirName = Buffer.from('folder/');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zlib.crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const dirLocal = Buffer.alloc(30);
  dirLocal.writeUInt32LE(0x04034b50, 0);
  dirLocal.writeUInt16LE(dirName.length, 26);
  const fileAt = 0;
  const dirAt = 30 + nameBuf.length + packed.length;
  const central = (n, method, crc, csize, size, offset) => {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    return Buffer.concat([c, n]);
  };
  const dir = Buffer.concat([
    central(nameBuf, 8, zlib.crc32(data), packed.length, data.length, fileAt),
    central(dirName, 0, 0, 0, 0, dirAt),
  ]);
  const body = Buffer.concat([local, nameBuf, packed, dirLocal, dirName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}

test('readZip inflates a deflated entry and skips directories', async () => {
  const Zip = load();
  const text = JSON.stringify({ tables: { settings: [] }, pad: 'x'.repeat(5000) });
  const back = await Zip.readZip(deflatedZip('folder/backup.json', text));
  assert.deepEqual([...back.map((e) => e.name)], ['folder/backup.json']);
  assert.equal(Buffer.from(back[0].data).toString(), text);
});

test('readZip refuses what it cannot read faithfully', async () => {
  const Zip = load();
  await assert.rejects(Zip.readZip(new TextEncoder().encode('not a zip at all, just some text')), /not a zip/);
  const good = Buffer.from(Zip.createZip([{ name: 'a.txt', data: 'hello' }]));
  const damaged = Buffer.from(good);
  damaged[30 + 'a.txt'.length] ^= 0xff; // flip a byte of the data
  await assert.rejects(Zip.readZip(damaged), /damaged/);
  await assert.rejects(Zip.readZip(good.subarray(0, 20)), /not a zip|cut short/);
  // Without DecompressionStream, a deflated entry is refused with a message, not mangled.
  const window = {};
  const bare = { window, TextEncoder, TextDecoder, Blob, Response };
  vm.createContext(bare);
  vm.runInContext(source, bare);
  await assert.rejects(window.WardZip.readZip(deflatedZip('backup.json', 'x'.repeat(100))), /compressed/);
});
