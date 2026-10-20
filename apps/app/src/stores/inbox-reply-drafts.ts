import { create } from 'zustand';
import { formatReplyQuote } from '../lib/inbox-reply-quote.js';

/** Retention cap: the least recently written draft is dropped past this. */
export const MAX_REPLY_DRAFTS = 50;

interface InboxReplyDraftsState {
  drafts: Record<string, string>;
  /** Entry ids, least recently written first. */
  order: string[];
  composeRequests: Record<string, number>;
  setDraft: (entryId: string, text: string) => void;
  clearDraft: (entryId: string) => void;
  requestCompose: (entryId: string) => void;
  appendQuote: (entryId: string, selection: string) => void;
}

export const useInboxReplyDrafts = create<InboxReplyDraftsState>()((set, get) => ({
  drafts: {},
  order: [],
  composeRequests: {},
  setDraft: (entryId, text) =>
    set((s) => {
      const order = s.order.filter((id) => id !== entryId);
      const drafts = { ...s.drafts };
      if (text.trim() === '') {
        delete drafts[entryId];
        return { drafts, order };
      }
      drafts[entryId] = text;
      order.push(entryId);
      while (order.length > MAX_REPLY_DRAFTS) {
        const oldest = order.shift() as string;
        delete drafts[oldest];
      }
      return { drafts, order };
    }),
  clearDraft: (entryId) =>
    set((s) => {
      if (!(entryId in s.drafts)) return s;
      const drafts = { ...s.drafts };
      delete drafts[entryId];
      return { drafts, order: s.order.filter((id) => id !== entryId) };
    }),
  requestCompose: (entryId) =>
    set((s) => ({
      composeRequests: { ...s.composeRequests, [entryId]: (s.composeRequests[entryId] ?? 0) + 1 },
    })),
  appendQuote: (entryId, selection) => {
    const current = get().drafts[entryId] ?? '';
    const next = formatReplyQuote(current, selection);
    if (next !== current) get().setDraft(entryId, next);
    get().requestCompose(entryId);
  },
}));
