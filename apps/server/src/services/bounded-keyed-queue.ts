/** Serialize each record owner while limiting total work across owners.
 * A busy project's successor joins the end of the ready queue, so it cannot
 * reserve all slots ahead of unrelated projects. Pending includes active work. */
export class BoundedKeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private pending = 0;
  private retainedBytes = 0;

  constructor(private readonly concurrency: number, private readonly capacity: number, private readonly fullMessage: string,
    private readonly byteCapacity = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(capacity) || capacity < concurrency
      || !Number.isSafeInteger(byteCapacity) || byteCapacity < 1)
      throw new Error('Invalid bounded queue limits');
  }

  async run<T>(key: string, operation: () => Promise<T>, retainedBytes = 0): Promise<T> {
    return this.runMany([key], operation, retainedBytes);
  }

  /** Reserve all owners together, without occupying a slot while waiting for
   * another owner. Nested single-key acquisition can deadlock at capacity. */
  async runMany<T>(keys: readonly string[], operation: () => Promise<T>, retainedBytes = 0): Promise<T> {
    const owners = [...new Set(keys)];
    if (!owners.length) throw new Error('At least one queue owner is required');
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) throw new Error('Invalid retained payload size');
    if (this.pending >= this.capacity || retainedBytes > this.byteCapacity - this.retainedBytes) throw new Error(this.fullMessage);
    this.pending++;
    this.retainedBytes += retainedBytes;
    const previous = Promise.all(owners.map(key => (this.tails.get(key) ?? Promise.resolve()).catch(() => {})));
    const task = previous.then(async () => {
      if (this.active < this.concurrency) this.active++;
      else await new Promise<void>(resolve => this.waiting.push(resolve));
      try { return await operation(); }
      finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
    });
    for (const key of owners) this.tails.set(key, task);
    try { return await task; }
    finally {
      this.pending--;
      this.retainedBytes -= retainedBytes;
      for (const key of owners) if (this.tails.get(key) === task) this.tails.delete(key);
    }
  }
}
