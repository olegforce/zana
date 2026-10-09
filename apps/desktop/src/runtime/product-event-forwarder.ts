import { PRODUCT_EVENT_ARGS_MAX_CHARS, PRODUCT_EVENT_ARGS_MAX_COUNT } from '@zana-ai/zcc-contracts/runtime';

const isSnapshotChannel = (channel: string) =>
  !channel.startsWith('terminals:') && (channel.endsWith(':onChanged') || channel === 'scheduler:onTemplatesChanged');

/** Bound the main → product utility link before IPC serialization can accumulate.
 * A dropped notification is repaired by a snapshot read, never command replay. */
export function createProductEventForwarder(
  send: (channel: string, args: unknown[]) => Promise<unknown>,
  limits = { messages: 2048, bytes: 8 * 1024 * 1024 }
) {
  const queue: Array<{ channel: string; args: unknown[]; bytes: number; invalidation?: boolean }> = [];
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
      let size: number, argsLength: number;
      try { argsLength = JSON.stringify(args).length; size = Buffer.byteLength(JSON.stringify({ channel, args })); }
      catch { argsLength = 0; size = limits.bytes + 1; }
      // An event the utility's schema would refuse must not stall the link: send a channel-scoped
      // invalidation so readers re-fetch the snapshot. Streams cannot be re-read, so they still reset.
      const oversized = args.length > PRODUCT_EVENT_ARGS_MAX_COUNT || argsLength > PRODUCT_EVENT_ARGS_MAX_CHARS;
      const invalidation = oversized && isSnapshotChannel(channel);
      if (invalidation) { args = []; size = Buffer.byteLength(JSON.stringify({ channel, args })); }
      const coalesce = isSnapshotChannel(channel) ? queue.findIndex(entry => entry.channel === channel) : -1;
      const pending = queue.findIndex(entry => entry.channel === channel && entry.invalidation);
      if (reset) { /* a pending global reset supersedes everything */ }
      else if (invalidation && pending >= 0) { /* one invalidation per channel */ }
      else if (coalesce >= 0 && bytes - queue[coalesce]!.bytes + size <= limits.bytes) {
        bytes += size - queue[coalesce]!.bytes; queue[coalesce] = { channel, args, bytes: size, invalidation };
      } else if ((oversized && !invalidation) || size > limits.bytes || bytes + size > limits.bytes || queue.length >= limits.messages) {
        queue.length = 0; bytes = 0; reset = true;
      } else { queue.push({ channel, args, bytes: size, invalidation }); bytes += size; }
      void drain();
    },
    dispose() {
      stopped = true; queue.length = 0; bytes = 0; reset = false;
      if (retry) clearTimeout(retry);
      retry = undefined;
    }
  };
}
