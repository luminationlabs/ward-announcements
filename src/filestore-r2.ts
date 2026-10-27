/**
 * The Cloudflare file store: R2.
 *
 * Pure JS with no Node built-ins, so it is safe to bundle for `workerd`.
 *
 * ## Why the bucket is typed structurally
 *
 * The same reason as `driver-d1.ts`: `@cloudflare/workers-types` publishes its types as *ambient
 * globals*, and pulling them into this project's tsconfig would redefine `Buffer`, `fetch`,
 * `Request` and friends project-wide, breaking every Node-side file. The three methods used here
 * are declared as a structural subset instead, and Cloudflare's real `R2Bucket` satisfies it — the
 * Workers entry passes `env.IMAGES` straight in.
 */
import { contentTypeForKey, type FileStore, type StoredFile } from './filestore.js';

/** The subset of Cloudflare's `R2Object` (with a body) this store reads. */
export interface R2ObjectLike {
  body: ReadableStream | null;
  httpMetadata?: { contentType?: string };
}

/** The subset of Cloudflare's `R2Bucket` this store uses. */
export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

export function createR2FileStore(bucket: R2BucketLike): FileStore {
  return {
    async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
      // R2 stores the content type as object metadata, so `get` can serve it back without the
      // extension lookup the filesystem store needs.
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },

    async get(key: string): Promise<StoredFile | undefined> {
      const object = await bucket.get(key);
      if (!object || !object.body) return undefined;
      return {
        // The stream is handed straight to a `Response`: buffering a whole image inside a Worker
        // would spend memory and CPU on bytes the runtime can pipe for free.
        body: object.body,
        contentType:
          object.httpMetadata?.contentType ?? contentTypeForKey(key) ?? 'application/octet-stream',
      };
    },

    async delete(key: string): Promise<void> {
      // R2 treats deleting a missing key as success, which is what the seam wants.
      await bucket.delete(key);
    },
  };
}
