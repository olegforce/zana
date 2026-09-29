/** Bound the main → product utility link before IPC serialization can accumulate.
 * A dropped notification is repaired by a snapshot read, never command replay. */
export function createProductEventForwarder(
  send: (channel: string, args: unknown[]) => Promise<unknown>,
  limits = { messages: 2048, bytes: 8 * 1024 * 1024 }
) {
  const queue: Array<{ channel: string; args: unknown[]; bytes: number }> = [];
  let bytes = 0, running = false, stopped = false, reset = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  async function drain() {
    if (running || stopped || retry) return;
    running = true;
    try {
      while (!stopped && (reset || queue.length)) {
        const entry = reset ? { channel: 'product:reset', args: [], bytes: 0 } : queue.shift()!;
        if (reset) reset = false;
        else bytes -= entry.bytes;
        try { await send(entry.channel, entry.args); }
        catch {
          queue.length = 0; bytes = 0; reset = true;
          if (!stopped) retry = setTimeout(() => { retry = undefined; void drain(); }, 1500);
          break;
        }
      }
    } finally { running = false; }
  }
  return {
    publish(channel: string, args: unknown[]) {
      if (stopped) return;
      let size: number;
      try { size = Buffer.byteLength(JSON.stringify({ channel, args })); }
      catch { size = limits.bytes + 1; }
      if (reset || size > limits.bytes || bytes + size > limits.bytes || queue.length >= limits.messages) {
        queue.length = 0; bytes = 0; reset = true;
      } else { queue.push({ channel, args, bytes: size }); bytes += size; }
      void drain();
    },
    dispose() {
      stopped = true; queue.length = 0; bytes = 0; reset = false;
      if (retry) clearTimeout(retry);
      retry = undefined;
    }
  };
}
