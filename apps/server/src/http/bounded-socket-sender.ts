// Adapted from BB apps/server/src/ws/hub.ts (MIT); see docs/third-party/BB-LICENSE.
import type { WebSocket } from 'ws';

export interface SocketQueueBudget { bytes: number; limit: number }
const HIGH_WATER = 1024 * 1024;
const MAX_QUEUE = 8 * 1024 * 1024;
const MAX_MESSAGES = 2048;

/** Preserve ordering while a client drains; disconnect a stalled consumer. */
export function boundedSocketSender(socket: WebSocket, budget: SocketQueueBudget, dropped: () => void) {
  let queue: string[] = [], bytes = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer); timer = undefined;
    budget.bytes -= bytes; bytes = 0; queue = [];
  }
  function drop(reason: string) {
    dispose(); dropped();
    try { socket.close(1013, reason); } catch {}
  }
  function drain() {
    timer = undefined;
    if (disposed) return;
    if (socket.readyState !== socket.OPEN) { dispose(); dropped(); return; }
    while (queue.length && socket.bufferedAmount <= HIGH_WATER) {
      const payload = queue[0]!;
      try { socket.send(payload); } catch { drop('product-send-failed'); return; }
      queue.shift(); const size = Buffer.byteLength(payload); bytes -= size; budget.bytes -= size;
    }
    if (queue.length) timer = setTimeout(drain, 10);
  }
  return {
    dispose,
    send(payload: string) {
      if (disposed) return;
      if (socket.readyState !== socket.OPEN) { dispose(); dropped(); return; }
      const size = Buffer.byteLength(payload);
      if (size > MAX_QUEUE) { drop('product-message-too-large'); return; }
      if (!queue.length && socket.bufferedAmount <= HIGH_WATER) {
        try { socket.send(payload); } catch { drop('product-send-failed'); }
        return;
      }
      if (bytes + size > MAX_QUEUE || budget.bytes + size > budget.limit || queue.length >= MAX_MESSAGES) {
        drop('product-backpressure'); return;
      }
      queue.push(payload); bytes += size; budget.bytes += size;
      if (!timer) timer = setTimeout(drain, 10);
    }
  };
}
