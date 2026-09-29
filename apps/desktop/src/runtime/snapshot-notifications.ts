/** Coalesce authoritative snapshot invalidations into one active read and one
 * pending refresh. Preserve the last snapshot on failure; ignore shutdown results. */
export function createSnapshotNotifications<T>(read: () => Promise<T>, publish: (snapshot: T) => void) {
  let busy = false, pending = false, disposed = false;
  async function invalidate() {
    if (disposed) return;
    pending = true;
    if (busy) return;
    busy = true;
    try {
      do {
        pending = false;
        try { const docs = await read(); if (!disposed) publish(docs); }
        catch { /* An unavailable authority must not replace a readable snapshot with a local or empty list. */ }
      } while (pending && !disposed);
    } finally { busy = false; }
  }
  return { invalidate, dispose() { disposed = true; pending = false; } };
}
