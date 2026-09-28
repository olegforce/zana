import type { InboxEntry } from '@zana-ai/zcc-domain/product';
import { product } from './product-client.js';

export interface InboxThread {
  id: string;
  title: string;
  archived: boolean;
}

type ThreadOriginEntry = Pick<InboxEntry, 'projectId' | 'sessionId' | 'origin'>;

/** Older thread reports stored only sessionId, including close-with-follow-up reports. */
export async function resolveInboxThread(entry: ThreadOriginEntry): Promise<InboxThread | null> {
  const id = entry.origin?.threadId ?? entry.sessionId;
  if (!id) return null;
  let thread: Record<string, unknown>;
  try {
    ({ thread } = await product.threads.get(id));
  } catch (error) {
    // Only a confirmed missing legacy id permits the CLI resume/fresh fallback.
    if (!entry.origin?.threadId && (error as { status?: number })?.status === 404) return null;
    throw error;
  }
  if (thread.id !== id || thread.projectId !== entry.projectId) {
    throw new Error('The original conversation does not belong to this project.');
  }
  return {
    id,
    title: typeof thread.title === 'string' && thread.title.trim() ? thread.title : 'Untitled agent',
    archived: thread.archivedAt != null
  };
}

/** Re-read at action time: the conversation may have been archived since rendering. */
export async function reopenInboxThread(entry: InboxEntry): Promise<InboxThread> {
  const thread = await resolveInboxThread(entry);
  if (!thread) throw new Error('The original conversation is no longer available.');
  if (thread.archived) await product.threads.unarchive(thread.id);
  return { ...thread, archived: false };
}

export async function sendInboxThreadReply(entry: InboxEntry, text: string): Promise<void> {
  const body = text.trim();
  if (!body) throw new Error('Enter a reply to continue.');
  const thread = await reopenInboxThread(entry);
  const result = await product.threads.send(thread.id, body, 'queue-if-active');
  if (!result.ok) throw new Error('Could not send your reply to the conversation.');
}
