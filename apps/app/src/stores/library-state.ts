import { create } from 'zustand';
import type { LibraryDoc, LibrarySnapshot } from '@zana-ai/zcc-domain/product';

/** Keep already displayed documents from unavailable roots so a disconnect does
 * not unmount an editor and discard its draft. Availability remains explicit;
 * these are display records, never authority to read or write a different host. */
function displayDocs(previous: LibraryDoc[], snapshot: LibrarySnapshot): LibraryDoc[] {
  const key = (value: { scope?: string; projectId?: string }) => `${value.scope ?? 'global'}:${value.projectId ?? ''}`;
  const unavailable = new Set(snapshot.roots.filter(root => root.state !== 'ready').map(key));
  const docs = snapshot.docs.slice(0, 10_000);
  const current = new Set(docs.map(doc => `${key(doc)}:${doc.relPath}`));
  for (const doc of previous) {
    if (docs.length >= 10_000) break;
    if (unavailable.has(key(doc)) && !current.has(`${key(doc)}:${doc.relPath}`)) docs.push(doc);
  }
  return docs;
}

export function createLibraryState(read: () => Promise<LibrarySnapshot>) {
  let generation = 0;
  return create<{
    docs: LibrarySnapshot['docs']; roots: LibrarySnapshot['roots']; loading: boolean; error?: string;
    receive(snapshot: LibrarySnapshot): void; refresh(): Promise<void>;
  }>(set => ({
    docs: [], roots: [], loading: true,
    receive(snapshot) { generation++; set(state => ({ docs: displayDocs(state.docs, snapshot), roots: snapshot.roots, loading: false, error: undefined })); },
    async refresh() {
      const current = ++generation;
      try {
        const snapshot = await read();
        if (generation === current) set(state => ({ docs: displayDocs(state.docs, snapshot), roots: snapshot.roots, loading: false, error: undefined }));
      } catch {
        if (generation === current) set({ loading: false, error: 'Library could not be refreshed. Reconnect and try again.' });
      }
    }
  }));
}
