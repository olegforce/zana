import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { apiJson } from './fetch-with-app-surface.js';
import { subscribeProductEvent } from './product-ws.js';

export async function readHttpLibrary(signal?: AbortSignal): Promise<LibraryDoc[]> {
  const body = await apiJson<{ docs: LibraryDoc[] }>('/library', { signal });
  if (!Array.isArray(body.docs)) throw new Error('Invalid library response');
  return body.docs;
}

/** HTTP library events invalidate the list; their payload is only { projectId }. */
export function subscribeHttpLibrary(onChanged: (docs: LibraryDoc[]) => void): () => void {
  const controller = new AbortController();
  let refreshing = false;
  let pending = false;
  async function refresh() {
    pending = true;
    if (refreshing) return;
    refreshing = true;
    try {
      do {
        pending = false;
        try {
          const docs = await readHttpLibrary(controller.signal);
          if (!controller.signal.aborted) onChanged(docs);
        } catch {
          // Keep the last readable list on a transient failure. A later event retries.
        }
      } while (pending && !controller.signal.aborted);
    } finally {
      refreshing = false;
    }
  }
  const unsubscribe = subscribeProductEvent('library:changed', () => { void refresh(); });
  return () => {
    unsubscribe();
    controller.abort();
  };
}
