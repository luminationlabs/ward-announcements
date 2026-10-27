/**
 * The Node file store: one flat directory of image objects.
 *
 * The counterpart to `driver-sqlite.ts` — the local-deployment half of a seam whose other half is
 * R2. It sits beside the SQLite file by default (`<dir of DATABASE_PATH>/uploads`), so the one
 * persistent volume a Node deployment already needs covers the images too.
 *
 * There is no metadata sidecar: the content type is recovered from the key's extension, which the
 * upload route chose from the validated content type. That keeps a stored object a single file and
 * removes any chance of the two drifting apart.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentTypeForKey, isValidKey, type FileStore, type StoredFile } from './filestore.js';

export function createFsFileStore(baseDir: string): FileStore {
  /**
   * Key → path. The validation is load-bearing, not defensive noise: this is the one place a
   * caller-supplied string becomes a filesystem path, so a key that isn't strictly
   * `[0-9a-f]{32}.[ext]` never gets that far and `../` can't be spelled.
   */
  function pathFor(key: string): string {
    if (!isValidKey(key)) throw new Error(`Refusing to use a malformed storage key: ${key}`);
    return join(baseDir, key);
  }

  return {
    async put(key: string, data: Uint8Array): Promise<void> {
      const path = pathFor(key);
      // Recursive mkdir is idempotent and costs one syscall per upload — cheaper than caching a
      // promise that would have to be invalidated if the directory were removed underneath us.
      await mkdir(baseDir, { recursive: true });
      await writeFile(path, data);
    },

    async get(key: string): Promise<StoredFile | undefined> {
      if (!isValidKey(key)) return undefined;
      try {
        const buffer = await readFile(pathFor(key));
        return {
          // A plain Uint8Array over the same memory: the seam is deliberately Buffer-free, and
          // `Buffer` is a Uint8Array subclass, so this copies nothing.
          body: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
          contentType: contentTypeForKey(key) ?? 'application/octet-stream',
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await unlink(pathFor(key));
      } catch (err) {
        // Already gone is the desired end state, not a failure — and deletes run in fan-out loops
        // (removing an announcement) where one missing file must not abort the rest.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}
