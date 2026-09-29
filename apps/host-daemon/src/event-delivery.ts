import { HostEventAckMessageSchema } from '@zana-ai/zcc-contracts/host-rpc';

/** One batch in flight; close/timeout retains it in EventSink for reconnect. */
export function createEventDelivery(options: { onTimeout: () => void; timeoutMs?: number; onRejected?: (reasons: string[]) => void }) {
  let pending: { id: string; count: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  function cancel(reason = 'Host event connection closed') {
    if (!pending) return;
    const old = pending; pending = null; clearTimeout(old.timer); old.reject(new Error(reason));
  }
  return {
    cancel,
    send(id: string, count: number, send: () => void): Promise<void> {
      if (pending) return Promise.reject(new Error('Host event batch already pending'));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cancel('Host event acknowledgement timed out'); options.onTimeout(); }, options.timeoutMs ?? 30_000);
        pending = { id, count, resolve, reject, timer };
        try { send(); } catch (error) { cancel(error instanceof Error ? error.message : String(error)); }
      });
    },
    accept(raw: unknown): boolean {
      const parsed = HostEventAckMessageSchema.safeParse(raw);
      if (!parsed.success || !pending || parsed.data.batchId !== pending.id) return false;
      const ack = parsed.data;
      if (ack.accepted + ack.rejected.length !== pending.count || new Set(ack.rejected.map(row => row.index)).size !== ack.rejected.length || ack.rejected.some(row => row.index >= pending!.count)) return false;
      const completed = pending; pending = null; clearTimeout(completed.timer);
      if (ack.rejected.length) options.onRejected?.([...new Set(ack.rejected.map(row => row.reason))]);
      completed.resolve();
      return true;
    }
  };
}
