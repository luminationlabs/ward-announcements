/**
 * The database file store: image bytes in the `file_chunks` table.
 *
 * For a Workers deployment with no R2 bucket bound. Enabling R2 asks for a payment card even on its
 * free tier, which is a wall for a ward clerk following a Deploy button, and a ward's few flyers a
 * week fit easily in D1's free 5 GB. A deployment that binds `IMAGES` keeps using R2 (see
 * `worker.ts`); this is the fallback, not a replacement.
 *
 * Written against `db.ts` rather than D1 directly, so it is the same code on both drivers and the
 * Node suite can exercise it (`IMAGE_STORE=database`).
 *
 * Base64 text rather than a BLOB: D1 hands a BLOB back as an array of numbers, one JSON element per
 * byte, where a string comes back as a string and `Buffer` decodes it natively. Chunked because a
 * D1 row is capped at 2 MB and `MAX_UPLOAD_BYTES` is 3 MB.
 */
import { deleteFileChunks, getFileChunks, putFileChunks } from './db.js';
import type { FileStore, StoredFile } from './filestore.js';

/** Base64 characters per row: a multiple of 4, so every chunk decodes on its own boundary. */
const CHUNK_CHARS = 1_000_000;

export function createSqlFileStore(): FileStore {
  return {
    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
      const encoded = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
      const chunks: string[] = [];
      for (let i = 0; i < encoded.length; i += CHUNK_CHARS) chunks.push(encoded.slice(i, i + CHUNK_CHARS));
      if (chunks.length === 0) chunks.push('');
      await putFileChunks(key, contentType, chunks);
    },

    async get(key: string): Promise<StoredFile | undefined> {
      const rows = await getFileChunks(key);
      if (rows.length === 0) return undefined;
      return {
        body: new Uint8Array(Buffer.from(rows.map((r) => r.data).join(''), 'base64')),
        contentType: rows[0]!.content_type,
      };
    },

    async delete(key: string): Promise<void> {
      await deleteFileChunks(key);
    },
  };
}
