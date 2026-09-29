import { apiJson } from './fetch-with-app-surface.js';

export const CONVERSATION_READ_TIMEOUT_MS = 15_000;
export const CONVERSATION_READ_TIMEOUT_MESSAGE = 'The server is taking too long to load this conversation. Please retry.';

/** Bound both headers and body reads, so a stalled request cannot lock out Retry. */
export async function readConversationJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error(CONVERSATION_READ_TIMEOUT_MESSAGE));
  }, CONVERSATION_READ_TIMEOUT_MS);
  try {
    return await apiJson<T>(path, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
