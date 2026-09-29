import { reloadThreadModelCatalog } from './thread-model-catalog.js';

type RefreshState = { running: boolean; ok: boolean | null; message: string | null };
const listeners = new Set<() => void>();
let state: RefreshState = { running: false, ok: null, message: null };
let pending: Promise<RefreshState> | null = null;

export const getModelRefreshState = () => state;
export function subscribeModelRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: RefreshState): RefreshState {
  state = next;
  for (const listener of listeners) listener();
  return state;
}

/** One recovery operation shared by Settings and the command palette. */
export function refreshModels(): Promise<RefreshState> {
  if (pending) return pending;
  publish({ running: true, ok: null, message: 'Recalculating models…' });
  pending = (async () => {
    try {
      const result = await reloadThreadModelCatalog();
      const ok = result.failedCatalogs === 0 && result.failedProviders.length === 0;
      const failures = result.failedProviders.length > 0
        ? ` Could not refresh: ${result.failedProviders.join(', ')}.` : '';
      return publish({ running: false, ok, message: ok
        ? 'Model lists refreshed.'
        : `Some model lists could not be refreshed.${failures} Check provider sign-in and machine connections, then retry.` });
    } catch {
      return publish({ running: false, ok: false,
        message: 'Could not refresh models. Check machine connections, then retry.' });
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export async function refreshModelsWithToast(pushToast: (message: string, kind?: 'info' | 'error') => void): Promise<void> {
  if (state.running) {
    pushToast('Model refresh is already running.', 'info');
    return;
  }
  pushToast('Recalculating models…', 'info');
  const result = await refreshModels();
  pushToast(result.message!, result.ok ? 'info' : 'error');
}
