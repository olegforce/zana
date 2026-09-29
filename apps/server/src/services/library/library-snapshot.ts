import type { LibraryDoc, LibraryRootAvailability, LibrarySnapshot } from '@zana-ai/zcc-domain/product';

export const LIBRARY_SNAPSHOT_ROOT_LIMIT = 1000;
export const LIBRARY_SNAPSHOT_DOC_LIMIT = 10_000;
type Root = Omit<LibraryRootAvailability, 'state'>;

/** Bounded parallel reads; one missing owner cannot hide unrelated documents.
 * Preserve registry order rather than host response order. Never cache or fabricate
 * stale files, and expose every failed root explicitly to snapshot consumers. */
export async function collectLibrarySnapshot<T extends Root>(
  roots: T[], read: (root: T) => Promise<LibraryDoc[]>, deadline: number, now = Date.now
): Promise<LibrarySnapshot> {
  if (roots.length > LIBRARY_SNAPSHOT_ROOT_LIMIT) throw new Error('Library exceeds its root limit');
  const docs: LibraryDoc[] = [];
  const availability: LibraryRootAvailability[] = [];
  // Release each batch before fetching the next: retained documents are bounded
  // by the total cap plus at most four per-root results, not roots × documents.
  for (let offset = 0; offset < roots.length; offset += 4) {
    const batch = roots.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (root): Promise<{ docs: LibraryDoc[]; state: LibraryRootAvailability['state'] }> => {
      if (docs.length >= LIBRARY_SNAPSHOT_DOC_LIMIT) return { docs: [], state: 'limit' };
      if (now() >= deadline) return { docs: [], state: 'unavailable' };
      try {
        const rows = await read(root);
        return rows.length > LIBRARY_SNAPSHOT_DOC_LIMIT ? { docs: [], state: 'limit' } : { docs: rows, state: 'ready' };
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        return { docs: [], state: code === 'host-unavailable' || code === 'host_unavailable' || code === 'host_disconnected' ? 'offline' : 'unavailable' };
      }
    }));
    batch.forEach((root, index) => {
      const result = results[index];
      if (docs.length + result.docs.length > LIBRARY_SNAPSHOT_DOC_LIMIT) result.state = 'limit';
      if (result.state === 'ready') docs.push(...result.docs);
      availability.push({ scope: root.scope, projectId: root.projectId, projectName: root.projectName, hostId: root.hostId, state: result.state });
    });
  }
  return { docs, roots: availability, complete: availability.every(root => root.state === 'ready') };
}
