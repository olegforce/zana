/** Short-lived successful inventories. Failures and empty lists remain retryable. */
export class ModelDiscoveryCache<T> {
  private readonly entries = new Map<string, { value: readonly T[]; expiresAt: number }>();
  private readonly pending = new Map<string, { generation: number; request: Promise<readonly T[]> }>();
  private generation = 0;

  constructor(private readonly ttlMs = 5 * 60_000, private readonly maxEntries = 64) {}

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    // Keep running requests coalesced and bounded. Their result cannot re-cache
    // after invalidation; a subsequent discovery will use the new configuration.
  }

  discover(key: string, load: () => Promise<readonly T[]>): Promise<readonly T[]> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    this.entries.delete(key);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.generation === this.generation) return existing.request;
      // Finish old work before starting another process, but never hand its
      // stale inventory to a caller that explicitly requested fresh discovery.
      return existing.request.catch(() => undefined).then(() => this.discover(key, load));
    }
    if (this.pending.size >= this.maxEntries) return Promise.reject(new Error('Model discovery is busy; retry shortly'));
    const generation = this.generation;
    const request = Promise.resolve().then(load).then((value) => {
      if (value.length && generation === this.generation) {
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, { generation, request });
    return request;
  }
}
