/** Bound temporary discovery runtimes across all projects and windows. */
export class ModelDiscoveryLane {
  private active = 0;
  private closed = false;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly queue: Array<{ start: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly concurrency = 3, private readonly maxQueue = 16, private readonly queueTimeoutMs = 10_000) {}

  run<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Model discovery is shutting down'));
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueue) {
      return Promise.reject(new Error('Model discovery is busy; retry shortly'));
    }
    const request = new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        void Promise.resolve().then(load).then(resolve, reject).finally(() => {
          this.active -= 1;
          const next = this.queue.shift();
          if (next) { clearTimeout(next.timer); next.start(); }
        });
      };
      if (this.active < this.concurrency) start();
      else {
        const queued = { start, reject, timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(queued), 1);
          reject(new Error('Model discovery queue timed out'));
        }, this.queueTimeoutMs) };
        this.queue.push(queued);
      }
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }

  dispose(): void {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new Error('Model discovery is shutting down'));
    }
  }
}
