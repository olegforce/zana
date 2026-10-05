import { openAsyncJsonStore } from '../storage/async-json-store.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PromptInput, ThreadQueuedMessage } from '@zana-ai/zcc-domain/thread-runtime';
import { ThreadCreateError } from '../../http/thread-create.js';

interface QueuedStore {
  [threadId: string]: ThreadQueuedMessage[];
}

const writeChains = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  writeChains.set(key, run);
  const cleanup = () => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  };
  void run.then(cleanup, cleanup);
  return run;
}

function storePath(dataDir: string): string {
  return join(dataDir, 'thread-queued-messages.json');
}

const stores = new Map<string, ReturnType<typeof openAsyncJsonStore>>();
function queueStore(dataDir: string) {
  let store = stores.get(dataDir);
  if (!store) { store = openAsyncJsonStore(storePath(dataDir)); stores.set(dataDir, store); }
  return store;
}
export function closeQueuedMessages(dataDir: string): void {
  stores.get(dataDir)?.dispose(); stores.delete(dataDir);
}
async function readQueue(dataDir: string, threadId: string): Promise<ThreadQueuedMessage[]> {
  const value = await queueStore(dataDir).get<ThreadQueuedMessage[]>(threadId);
  return Array.isArray(value) ? value : [];
}
async function saveQueue(dataDir: string, threadId: string, list: ThreadQueuedMessage[]): Promise<void> {
  if (list.length > 100) throw new ThreadCreateError(413, 'queue-limit', 'A thread can queue at most 100 messages');
  try {
    if (list.length) await queueStore(dataDir).set(threadId, list);
    else await queueStore(dataDir).delete(threadId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|exceeds/i.test(message)) throw new ThreadCreateError(413, 'queue-limit', message);
    if (/busy|capacity|timed out/i.test(message)) throw new ThreadCreateError(503, 'queue-busy', message);
    throw error;
  }
}

function promptText(content: PromptInput[]): string {
  return content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
}

function toQueuedMessage(
  input: PromptInput[],
  extras?: Partial<Pick<ThreadQueuedMessage, 'model' | 'reasoningLevel' | 'permissionMode' | 'serviceTier' | 'senderThreadId'>>
): ThreadQueuedMessage {
  const now = Date.now();
  return {
    id: randomUUID(),
    content: input,
    model: extras?.model?.trim() || 'default',
    reasoningLevel: extras?.reasoningLevel ?? 'medium',
    permissionMode: extras?.permissionMode ?? 'accept-edits',
    serviceTier: extras?.serviceTier ?? 'default',
    groupWithNext: false,
    senderThreadId: extras?.senderThreadId ?? null,
    sendAt: null,
    waitingOn: null,
    failureReason: null,
    payload: { kind: 'inline' },
    editable: true,
    createdAt: now,
    updatedAt: now
  };
}

export function listQueuedMessages(dataDir: string, threadId: string): Promise<ThreadQueuedMessage[]> {
  return readQueue(dataDir, threadId);
}

export function createQueuedMessage(
  dataDir: string,
  threadId: string,
  input: PromptInput[],
  extras?: Partial<Pick<ThreadQueuedMessage, 'model' | 'reasoningLevel' | 'permissionMode' | 'serviceTier' | 'senderThreadId'>>
): Promise<ThreadQueuedMessage> {
  if (input.length === 0) {
    throw new ThreadCreateError(400, 'invalid-input', 'queued message input is required');
  }
  return withLock(dataDir, async () => {
    const message = toQueuedMessage(input, extras);
    await saveQueue(dataDir, threadId, [...await readQueue(dataDir, threadId), message]);
    return message;
  });
}

export function updateQueuedMessage(
  dataDir: string,
  threadId: string,
  queuedMessageId: string,
  input: PromptInput[],
  expectedUpdatedAt: number
): Promise<ThreadQueuedMessage> {
  return withLock(dataDir, async () => {
    const list = await readQueue(dataDir, threadId);
    const index = list.findIndex((row) => row.id === queuedMessageId);
    if (index < 0) throw new ThreadCreateError(404, 'unknown-queued-message', 'queued message not found');
    const current = list[index]!;
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new ThreadCreateError(409, 'queued-message-conflict', 'queued message changed');
    }
    const next: ThreadQueuedMessage = {
      ...current,
      content: input,
      updatedAt: Date.now()
    };
    const copy = [...list];
    copy[index] = next;
    await saveQueue(dataDir, threadId, copy);
    return next;
  });
}

export function deleteQueuedMessage(dataDir: string, threadId: string, queuedMessageId: string): Promise<void> {
  return withLock(dataDir, async () => {
    const list = await readQueue(dataDir, threadId);
    await saveQueue(dataDir, threadId, list.filter((row) => row.id !== queuedMessageId));
  });
}

export function reorderQueuedMessage(
  dataDir: string,
  threadId: string,
  queuedMessageId: string,
  previousQueuedMessageId: string | null
): Promise<ThreadQueuedMessage[]> {
  return withLock(dataDir, async () => {
    const list = [...await readQueue(dataDir, threadId)];
    const from = list.findIndex((row) => row.id === queuedMessageId);
    if (from < 0) throw new ThreadCreateError(404, 'unknown-queued-message', 'queued message not found');
    const [moved] = list.splice(from, 1);
    if (!moved) throw new ThreadCreateError(404, 'unknown-queued-message', 'queued message not found');
    const insertAt = previousQueuedMessageId
      ? list.findIndex((row) => row.id === previousQueuedMessageId) + 1
      : 0;
    list.splice(Math.max(0, insertAt), 0, moved);
    await saveQueue(dataDir, threadId, list);
    return list;
  });
}

export function queuedMessageText(message: ThreadQueuedMessage): string {
  return promptText(message.content);
}
