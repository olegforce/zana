import { useEffect, useState } from 'react';
import type { InboxEntry } from '@zana-ai/zcc-domain/product';
import { resolveInboxThread, type InboxThread } from '../lib/inbox-thread.js';

/** Tiny insertion-ordered LRU for last-known-good Inbox results, so a remounted pane paints instantly. */
export function createResultCache<V>(max = 20) {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = map.get(key);
      if (value !== undefined) { map.delete(key); map.set(key, value); }
      return value;
    },
    set(key: string, value: V) {
      map.delete(key); map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
    clear() { map.clear(); }
  };
}

export const inboxThreadCache = createResultCache<InboxThread>(20);

export function useInboxThread(entry: InboxEntry, hasTerminal: boolean) {
  const threadId = entry.origin?.threadId;
  const sessionId = entry.sessionId;
  const projectId = entry.projectId;
  const shouldResolve = !!threadId || (!!sessionId && !hasTerminal);
  const cacheKey = `${entry.id}:${threadId ?? sessionId ?? ''}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ loading: boolean; thread: InboxThread | null; error: string | null }>(() => {
    const cached = shouldResolve ? inboxThreadCache.get(cacheKey) : undefined;
    return { loading: shouldResolve && !cached, thread: cached ?? null, error: null };
  });
  useEffect(() => {
    let cancelled = false;
    if (!shouldResolve) {
      setState({ loading: false, thread: null, error: null });
      return;
    }
    // Show the last good result immediately and revalidate in the background.
    const cached = inboxThreadCache.get(cacheKey);
    setState(cached ? { loading: false, thread: cached, error: null } : { loading: true, thread: null, error: null });
    void resolveInboxThread({ projectId, sessionId, origin: { threadId } }).then(
      (thread) => {
        if (thread) inboxThreadCache.set(cacheKey, thread);
        if (!cancelled) setState({ loading: false, thread, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        // A failed revalidation keeps the cached view; failures are never cached.
        if (cached) { setState({ loading: false, thread: cached, error: null }); return; }
        setState({ loading: false, thread: null, error: error instanceof Error ? error.message : 'Could not load the original conversation.' });
      }
    );
    return () => { cancelled = true; };
  }, [projectId, sessionId, threadId, shouldResolve, attempt, cacheKey]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
