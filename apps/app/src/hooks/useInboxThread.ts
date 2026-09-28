import { useEffect, useState } from 'react';
import type { InboxEntry } from '@zana-ai/zcc-domain/product';
import { resolveInboxThread, type InboxThread } from '../lib/inbox-thread.js';

export function useInboxThread(entry: InboxEntry, hasTerminal: boolean) {
  const threadId = entry.origin?.threadId;
  const sessionId = entry.sessionId;
  const projectId = entry.projectId;
  const shouldResolve = !!threadId || (!!sessionId && !hasTerminal);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ loading: boolean; thread: InboxThread | null; error: string | null }>({
    loading: shouldResolve, thread: null, error: null
  });
  useEffect(() => {
    let cancelled = false;
    if (!shouldResolve) {
      setState({ loading: false, thread: null, error: null });
      return;
    }
    setState({ loading: true, thread: null, error: null });
    void resolveInboxThread({ projectId, sessionId, origin: { threadId } }).then(
      (thread) => { if (!cancelled) setState({ loading: false, thread, error: null }); },
      (error: unknown) => {
        if (!cancelled) setState({ loading: false, thread: null, error: error instanceof Error ? error.message : 'Could not load the original conversation.' });
      }
    );
    return () => { cancelled = true; };
  }, [projectId, sessionId, threadId, shouldResolve, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}
