/** Share a small read budget across boot/reconnect/gap recovery. Cancellation
 * removes queued reads; hosted fetches receive the same abort signal. */
export function createTerminalReadQueue(limit = 4) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return function read<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let started = false, settled = false;
      const finish = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', cancel);
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        if (started) active--;
        if (error) reject(error); else resolve(value as T);
        while (active < limit && waiting.length) waiting.shift()!();
      };
      const cancel = () => finish(new Error('Terminal read cancelled'));
      const start = () => {
        if (settled) return;
        if (signal.aborted) { cancel(); return; }
        started = true; active++;
        try { void run().then(value => finish(null, value), error => finish(error)); }
        catch (error) { finish(error); }
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      else if (active < limit) start();
      else if (waiting.length < 512) waiting.push(start);
      else finish(new Error('Too many pending terminal reads'));
    });
  };
}
export const readTerminalSnapshot = createTerminalReadQueue();
