/**
 * Deleting an owner's images — rows *and* bytes — in one place.
 *
 * The `attachments` table and the `FileStore` are two halves of one fact, and nothing in `db.ts`
 * can keep them in step: dropping a row leaves bytes nobody can name, and dropping the object
 * without the row leaves a URL that 404s. Both the admin delete routes (`app.ts`) and the program
 * retention purge (`programs.ts`) need exactly this pairing, so it lives here rather than as a
 * closure inside `createApp`.
 *
 * Runtime-agnostic: it takes the store and the logger as arguments and touches no Node built-in.
 */
import { deleteAttachment, deleteAttachmentsForOwner, listAttachments, stalePendingAttachments } from './db.js';
import type { FileStore } from './filestore.js';
import type { Logger } from './log.js';

/**
 * Delete every stored object for an owner, then its rows.
 *
 * Objects first: a failure there leaves rows pointing at bytes that are already gone, which the
 * `/images/:key` 404 handles and the next delete retries. The other order would leave bytes no row
 * names — invisible, and billable.
 *
 * One unreachable object never aborts the rest: the rows are going away regardless, and an admin
 * pressing Delete should not get a 500 because a bucket hiccuped. Returns how many objects were
 * attempted, which is what the retention purge budgets against.
 */
export async function purgeAttachments(
  files: FileStore,
  log: Logger,
  ownerType: string,
  ownerId: number,
): Promise<number> {
  const rows = await listAttachments(ownerType, ownerId);
  for (const row of rows) {
    try {
      await files.delete(row.key);
    } catch (err) {
      log.error({ err, key: row.key }, 'could not delete a stored image');
    }
  }
  await deleteAttachmentsForOwner(ownerType, ownerId);
  return rows.length;
}

/**
 * Delete images uploaded to a New form that was never saved, once they are a day old — objects
 * first, then rows, as above. A bounded batch per call (the daily sweep's), so a backlog is spread
 * over days rather than one tick's subrequest budget. Returns how many went.
 */
export async function purgeStalePendingAttachments(files: FileStore, log: Logger, limit = 20): Promise<number> {
  const rows = await stalePendingAttachments(limit);
  for (const row of rows) {
    try {
      await files.delete(row.key);
    } catch (err) {
      log.error({ err, key: row.key }, 'could not delete an unsaved image');
    }
    await deleteAttachment(row.id);
  }
  return rows.length;
}
