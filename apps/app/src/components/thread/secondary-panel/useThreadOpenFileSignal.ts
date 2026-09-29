import { useEffect, useRef } from 'react';
import { product } from '../../../lib/product-client.js';
import type { ClosableSecondaryTab } from './threadSecondaryPanelState.js';

export type ThreadOpenFileIntent = {
  source: 'workspace' | 'thread-storage';
  path: string;
  lineNumber: number | null;
};

const pendingByThread = new Map<string, ThreadOpenFileIntent[]>();
export const MAX_PENDING_PREVIEW_THREADS = 64;
export const MAX_PENDING_PREVIEWS_PER_THREAD = 16;
const consumersByThread = new Map<string, Set<(file: ThreadOpenFileIntent) => void>>();
let collectorUsers = 0;
let stopCollector: (() => void) | undefined;

export function resetThreadOpenFileBuffer(): void {
  pendingByThread.clear();
}

export function bufferThreadOpenFile(threadId: string, file: ThreadOpenFileIntent): void {
  // Coalesce repeat requests, retaining their latest line and ordering.
  const queued = (pendingByThread.get(threadId) ?? []).filter(
    (pending) => pending.path !== file.path || pending.source !== file.source
  );
  queued.push(file);
  pendingByThread.delete(threadId);
  pendingByThread.set(threadId, queued.slice(-MAX_PENDING_PREVIEWS_PER_THREAD));
  while (pendingByThread.size > MAX_PENDING_PREVIEW_THREADS) {
    pendingByThread.delete(pendingByThread.keys().next().value!);
  }
}

export function consumePendingOpenFile(threadId: string): ThreadOpenFileIntent | null {
  const queued = pendingByThread.get(threadId);
  if (!queued || queued.length === 0) return null;
  const next = queued.shift() ?? null;
  if (!queued.length) pendingByThread.delete(threadId);
  return next;
}

function deliverThreadOpenFile(threadId: string, file: ThreadOpenFileIntent): void {
  const consumers = consumersByThread.get(threadId);
  if (!consumers?.size) {
    bufferThreadOpenFile(threadId, file);
    return;
  }
  // Each mounted view receives the same request once, including two views of
  // one thread. Views must not enqueue copies into a shared queue.
  for (const consume of consumers) consume(file);
}

/** Installed by App, so requests survive navigation away from agent views. */
export function installThreadOpenFileSignals(): () => void {
  if (collectorUsers++ === 0) {
    stopCollector = product.threads.onOpen((payload) => {
      const parsed = parseThreadOpenFilePayload(payload);
      if (parsed?.file) deliverThreadOpenFile(parsed.threadId, parsed.file);
    });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--collectorUsers === 0) {
      stopCollector?.();
      stopCollector = undefined;
    }
  };
}

export function dispatchThreadOpenFile(threadId: string, path: string, lineNumber: number | null = null): void {
  if (!threadId || !path) return;
  deliverThreadOpenFile(threadId, { source: 'workspace', path, lineNumber });
}
export function parseThreadOpenFilePayload(payload: unknown): {
  threadId: string;
  file: ThreadOpenFileIntent | null;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.threadId !== 'string' || row.threadId.length === 0) return null;
  if (row.file === null) return { threadId: row.threadId, file: null };
  if (!row.file || typeof row.file !== 'object') return { threadId: row.threadId, file: null };
  const file = row.file as Record<string, unknown>;
  if (file.source !== 'workspace' && file.source !== 'thread-storage') return { threadId: row.threadId, file: null };
  if (typeof file.path !== 'string' || file.path.length === 0) return { threadId: row.threadId, file: null };
  return {
    threadId: row.threadId,
    file: {
      source: file.source,
      path: file.path,
      lineNumber: typeof file.lineNumber === 'number' && file.lineNumber > 0 ? file.lineNumber : null
    }
  };
}

export function isOpenableWorkspaceRelPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (trimmed.split(/[/\\]/).some((part) => part === '..')) return false;
  return true;
}

export function openWorkspaceFileForThread(
  threadId: string | null | undefined,
  path: string,
  lineNumber: number | null = null
): boolean {
  if (!threadId || !isOpenableWorkspaceRelPath(path)) return false;
  dispatchThreadOpenFile(threadId, path.trim(), lineNumber);
  return true;
}

export function tabFromOpenFile(file: ThreadOpenFileIntent): Omit<ClosableSecondaryTab, 'id'> {
  const parts = file.path.split(/[/\\]/);
  const title = parts[parts.length - 1] || file.path;
  // A new whole-file request must clear an earlier line-focused preview.
  const lineNumber = file.lineNumber != null && file.lineNumber > 0 ? file.lineNumber : null;
  if (file.source === 'thread-storage') {
    return { kind: 'storage-preview', title, path: file.path, lineNumber };
  }
  return { kind: 'file-preview', title, path: file.path, lineNumber };
}

export function useThreadOpenFileSignal({
  threadId,
  environmentId,
  openTab
}: {
  threadId: string | null | undefined;
  environmentId: string | null | undefined;
  openTab: (tab: Omit<ClosableSecondaryTab, 'id'>) => void;
}): void {
  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;

  useEffect(() => {
    if (threadId == null || environmentId === undefined) return;
    const consume = (file: ThreadOpenFileIntent) => openTabRef.current(tabFromOpenFile(file));
    const consumers = consumersByThread.get(threadId) ?? new Set();
    consumers.add(consume);
    consumersByThread.set(threadId, consumers);
    let pending;
    while ((pending = consumePendingOpenFile(threadId))) consume(pending);
    return () => {
      consumers.delete(consume);
      if (!consumers.size) consumersByThread.delete(threadId);
    };
  }, [environmentId, threadId]);
}
