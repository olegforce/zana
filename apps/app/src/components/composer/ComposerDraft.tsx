import { createContext, useContext, useRef, type ReactNode, type RefObject } from 'react';
import type { JSONContent } from '@tiptap/react';

const ComposerDraftContext = createContext<RefObject<JSONContent | undefined> | null>(null);

/** The launch surface owns the draft so replacing a mode's editor cannot lose it. */
export function ComposerDraftProvider({ children }: { children: ReactNode }) {
  const draft = useRef<JSONContent | undefined>(undefined);
  return <ComposerDraftContext.Provider value={draft}>{children}</ComposerDraftContext.Provider>;
}

export function useComposerDraft() {
  return useContext(ComposerDraftContext);
}
