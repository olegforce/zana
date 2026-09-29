import type { HostEventEnvelope } from '@zana-ai/zcc-contracts/host-rpc';
import { randomUUID } from 'node:crypto';

const DEFAULT_DEBOUNCE_MS = 100;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
export const MAX_HOST_EVENT_QUEUE_BYTES = 32 * 1024 * 1024;
export const MAX_HOST_EVENT_QUEUE_LENGTH = 16_384;
const IMMEDIATE_KINDS = new Set([
  'thread.started',
  'turn.completed',
  'turn.failed',
  'project.clone.progress',
  'terminal.output',
  'terminal.exited'
]);

export interface EventSink {
  emit(event: HostEventEnvelope): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export function createEventSink(options: {
  isSessionOpen: () => boolean;
  postEvents: (events: HostEventEnvelope[], batchId: string) => Promise<void>;
  debounceMs?: number;
  onOverflow?: (error: Error) => void;
  maxBytes?: number;
  maxEvents?: number;
}): EventSink {
  const queue: Array<{ event: HostEventEnvelope; bytes: number }> = [];
  let bytes = 0;
  let batch: { id: string; entries: typeof queue } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let disposed = false;
  let retryMs = 0;

  async function drain(): Promise<void> {
    if (flushing) {
      await flushing;
      return;
    }
    flushing = (async () => {
      while (queue.length > 0 && !disposed && options.isSessionOpen()) {
        // Keep the same identity and contents until the server acknowledges it.
        // Like BB, delivery success means a server response, not socket.send().
        batch ??= { id: randomUUID(), entries: queue.slice(0, 256) };
        const sending = batch;
        try {
          await options.postEvents(sending.entries.map(entry => entry.event), sending.id);
        } catch {
          retryMs = Math.min(RETRY_MAX_MS, retryMs ? retryMs * 2 : RETRY_BASE_MS);
          return;
        }
        if (disposed) return;
        queue.splice(0, sending.entries.length);
        bytes -= sending.entries.reduce((sum, entry) => sum + entry.bytes, 0);
        batch = null;
        retryMs = 0;
      }
    })().finally(() => {
      flushing = null;
      // An emit can arrive between the loop observing an empty queue and this
      // continuation. Also retry a lost acknowledgement without relying on a
      // later event: an exit can be the last event this machine ever sends.
      if (queue.length && !disposed && options.isSessionOpen()) schedule(retryMs);
    });
    await flushing;
  }

  function schedule(delay = options.debounceMs ?? DEFAULT_DEBOUNCE_MS): void {
    if (timer || flushing || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delay);
  }

  return {
    emit(event) {
      if (disposed) return;
      const json = JSON.stringify(event);
      const size = Buffer.byteLength(json, 'utf8');
      if (bytes + size > (options.maxBytes ?? MAX_HOST_EVENT_QUEUE_BYTES) || queue.length >= (options.maxEvents ?? MAX_HOST_EVENT_QUEUE_LENGTH)) {
        disposed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        queue.length = 0; bytes = 0; batch = null;
        options.onOverflow?.(new Error('Host event delivery exceeded its bounded queue; execution stopped to avoid losing authoritative history'));
        return;
      }
      // Own a snapshot: providers may mutate their event object after emitting.
      queue.push({ event: JSON.parse(json) as HostEventEnvelope, bytes: size });
      bytes += size;
      if (IMMEDIATE_KINDS.has(event.kind)) {
        // Incoming output must not defeat the backoff during an outage.
        if (timer && retryMs) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void drain();
        return;
      }
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await drain();
    },
    async dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await drain();
      queue.length = 0; bytes = 0; batch = null;
    }
  };
}
