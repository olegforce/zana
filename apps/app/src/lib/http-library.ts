import type { LibraryDoc, LibrarySnapshot, FsMutateResult, FsWriteResult } from '@zana-ai/zcc-domain/product';
import type { LibraryDocumentRequest } from '@zana-ai/zcc-contracts/library-documents';
import { apiJson } from './fetch-with-app-surface.js';
import { subscribeProductEvent, subscribeProductReconnect } from './product-ws.js';

/** Preserve the desktop mutation contract so a remote conflict/offline error is
 * displayed by the existing Library controls instead of becoming an unhandled rejection. */
export async function mutateHttpLibrary(request: Extract<LibraryDocumentRequest, { action: 'move' | 'deleteEntry' | 'createFolder' | 'write' }>): Promise<FsMutateResult & FsWriteResult> {
  try {
    const response = await apiJson<{ value: FsMutateResult & FsWriteResult }>('/library/documents', { method: 'POST', body: JSON.stringify(request) });
    if (typeof response.value?.ok !== 'boolean') throw new Error('Invalid library mutation response');
    return response.value;
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}

export async function readHttpLibrary(signal?: AbortSignal): Promise<LibraryDoc[]> {
  const body = await apiJson<{ docs: LibraryDoc[] }>('/library', { signal });
  if (!Array.isArray(body.docs)) throw new Error('Invalid library response');
  return body.docs;
}

/** HTTP library events invalidate the list; their payload is only { projectId }. */
export function subscribeHttpLibrary(onChanged: (docs: LibraryDoc[]) => void): () => void {
  return subscribeLibraryRead(readHttpLibrary, onChanged);
}

export async function readHttpLibrarySnapshot(signal?: AbortSignal): Promise<LibrarySnapshot> {
  const { value } = await apiJson<{ value: LibrarySnapshot }>('/library/documents', {
    method: 'POST', body: JSON.stringify({ action: 'snapshot' }), signal
  });
  if (!value || !Array.isArray(value.docs) || !Array.isArray(value.roots) || typeof value.complete !== 'boolean') throw new Error('Invalid library snapshot');
  return value;
}

export function subscribeHttpLibrarySnapshot(onChanged: (snapshot: LibrarySnapshot) => void): () => void {
  return subscribeLibraryRead(readHttpLibrarySnapshot, onChanged, true);
}

function subscribeLibraryRead<T>(read: (signal?: AbortSignal) => Promise<T>, onChanged: (value: T) => void, watchHosts = false): () => void {
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
          const docs = await read(controller.signal);
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
  const stopProjects = subscribeProductEvent('projects:changed', () => { void refresh(); });
  const stopHosts = watchHosts ? subscribeProductEvent('hosts:changed', () => { void refresh(); }) : undefined;
  const stopReconnect = subscribeProductReconnect(refresh);
  return () => {
    stopReconnect();
    stopHosts?.();
    stopProjects();
    unsubscribe();
    controller.abort();
  };
}
