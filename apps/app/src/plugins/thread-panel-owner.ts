import { createContext, createElement, useContext, type ReactNode } from 'react';

const ThreadPanelOwnerContext = createContext<string | null>(null);

/**
 * The side panel is keyed by the conversation on screen (a thread, a split
 * pane, or an agent inspector), which is often not the id in the URL.
 */
export function ThreadPanelOwnerProvider({
  ownerId,
  children
}: {
  ownerId: string;
  children: ReactNode;
}) {
  return createElement(ThreadPanelOwnerContext.Provider, { value: ownerId }, children);
}

export function useThreadPanelOwnerId(): string | null {
  return useContext(ThreadPanelOwnerContext);
}

export function agentSessionPanelOwnerId(sessionId: string, modal: boolean): string {
  return modal ? `${sessionId}:modal` : sessionId;
}

/** First non-blank owner. Visible panel, then the caller's hint, then the URL. */
export function resolveThreadPanelOwnerId(
  candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
