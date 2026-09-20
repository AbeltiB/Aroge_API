import { searchSyncQueue } from './queue.js'

/**
 * Fire this after any write that could change whether a listing shows up in
 * search (create, edit, status change, soft-delete/restore). The worker
 * re-fetches the listing fresh and decides upsert-vs-remove itself — this
 * just needs the id, not the specific field(s) that changed.
 */
export async function enqueueSearchSync(listingId: string): Promise<void> {
  await searchSyncQueue.add('sync-listing', { listingId })
}
