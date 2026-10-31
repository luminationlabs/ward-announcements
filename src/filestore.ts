/**
 * The blob-storage seam.
 *
 * The sibling of `sqldriver.ts`: `app.ts` stores and serves announcement images through this
 * interface and knows nothing about where the bytes land — a directory on disk under Node
 * (`filestore-fs.ts`), an R2 bucket on Cloudflare Workers (`filestore-r2.ts`) or, with no bucket
 * bound, the database itself (`filestore-sql.ts`). Nothing
 * runtime-specific may appear in these types: no `Buffer`, no `R2Object`, no `fs.Stats`.
 *
 * `get()` returns either the whole body or a stream, because that is the honest difference between
 * the two backends — a file read hands back bytes, R2 hands back a stream it would be wasteful to
 * buffer. Callers pass whichever they get straight to a `Response`.
 */

/** One stored object: its bytes (or a stream of them) and the type to serve it as. */
export interface StoredFile {
  body: Uint8Array | ReadableStream;
  contentType: string;
}

export interface FileStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** The object, or undefined when the key is unknown. */
  get(key: string): Promise<StoredFile | undefined>;
  /** Remove the object. Deleting a key that isn't there is not an error. */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// What may be uploaded
// ---------------------------------------------------------------------------

/**
 * The types an admin may attach, and the extension each is stored under.
 *
 * Deliberately short: four image types, which are what phones produce and what every browser
 * renders, and PDF, which is how a stake flyer or a printed insert usually arrives. The extension is
 * part of the storage key, which is how the filesystem store recovers a content type without a
 * sidecar record (see `contentTypeForKey`).
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

/** Reverse of `EXTENSIONS`, including the `jpeg` spelling a browser may hand us. */
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};

/** The one attachment type that is not an image: it is opened, not shown, and has a thumbnail. */
export const PDF_TYPE = 'application/pdf';

/**
 * Ceiling on one upload. The admin editor downscales in the browser first (1600px, JPEG q0.85),
 * so a phone photo arrives well under this; the limit is the backstop for what the editor didn't
 * shrink — an animated GIF, or a hand-crafted request.
 */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/**
 * Ceiling on one PDF. A PDF cannot be downscaled in the browser the way a photo is, and a stake
 * flyer exported from a desktop publisher is often a few MB. Kept at 5 MB rather than more for two
 * reasons: storing one in D1 base64-encodes it inside a free-plan Worker's few milliseconds of CPU,
 * and the many-ward host's Import Backup sends each file inside an 8 MB JSON batch
 * (`MAX_IMAGE_BATCH_BYTES`), which a 5 MB file still fits once base64'd.
 */
export const MAX_PDF_BYTES = 5 * 1024 * 1024;

/**
 * Whether bytes are a PDF: every one opens `%PDF-`, though some writers put a little junk first and
 * readers look for it in the first 1 KB.
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const end = Math.min(bytes.length, 1024) - marker.length;
  for (let i = 0; i <= end; i++) if (marker.every((b, j) => bytes[i + j] === b)) return true;
  return false;
}

/** The ceiling for one stored object of `contentType`. */
export function maxBytesFor(contentType: string): number {
  return contentType === PDF_TYPE ? MAX_PDF_BYTES : MAX_UPLOAD_BYTES;
}

/**
 * Ceiling on attachments per owner, enforced server-side.
 *
 * Not an aesthetic limit: deleting an announcement deletes each of its objects, and on Workers
 * every one of those is a subrequest against the free plan's per-invocation budget of 50. Ten
 * leaves room for the D1 queries around them, and no ward flyer needs more.
 */
export const MAX_ATTACHMENTS_PER_OWNER = 10;

/**
 * The shape of every storage key: 32 hex characters plus a lower-case extension.
 *
 * Enforced on the way in *and* on the way out. The filesystem store turns a key into a path, so a
 * key containing `/` or `..` would be a traversal; validating against this pattern rather than
 * sanitising is what makes that impossible to get wrong.
 */
const KEY_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]+$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** The stored extension for an upload's content type, or undefined when the type isn't allowed. */
export function extensionFor(contentType: string): string | undefined {
  return EXTENSIONS[contentType.toLowerCase()];
}

/** The content type a stored key should be served as, derived from its extension. */
export function contentTypeForKey(key: string): string | undefined {
  return CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()];
}

/**
 * A fresh storage key: 128 bits of randomness plus the extension.
 *
 * Unguessable on purpose — `/images/:key` is served without the member access gate (they are
 * public flyers, and an installed app fetching one has no reason to be re-authenticated), so the
 * key itself is the only thing standing between the object and the open web.
 *
 * `crypto.getRandomValues` rather than `node:crypto`, since this module is imported by both
 * runtimes and the Web Crypto global exists on each.
 */
export function newAttachmentKey(extension: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex}.${extension}`;
}

/**
 * A store that keeps everything under `prefix` in another one — one ward's corner of the R2 bucket
 * every ward on the many-ward host shares (`host.ts`). Not decoration: `/images/:key` serves
 * whatever key it is given, so without a prefix of its own one ward would serve another's images.
 */
export function withPrefix(store: FileStore, prefix: string): FileStore {
  return {
    put: (key, data, contentType) => store.put(prefix + key, data, contentType),
    get: (key) => store.get(prefix + key),
    delete: (key) => store.delete(prefix + key),
  };
}
