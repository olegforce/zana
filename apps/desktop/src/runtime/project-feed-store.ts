import { EventEmitter } from 'node:events';
import { PROJECT_FEED_MAX_BYTES, ProjectFeedResultSchema, type ProjectFeedRequest } from '@zana-ai/zcc-contracts/project-feed';
import type { FeedEvent, FeedEventInput, Project } from '@zana-ai/zcc-domain/product';

/** Desktop consumers keep only bounded acknowledged display snapshots. The
 * runtime owns every read/write, including metadata on the primary machine. */
export class ProjectFeedStore extends EventEmitter {
  private cache = new Map<string, { owner: string; events: FeedEvent[]; encoded: string; bytes: number }>();
  private tails = new Map<string, Promise<unknown>>();
  private pending = 0;
  private generation = 0;
  private stopped = false;
  constructor(private readonly deps: {
    projects(): Project[]; primaryHostId(): string | undefined;
    request(request: ProjectFeedRequest): Promise<unknown>;
    log(context: string, error: unknown): void;
  }) { super(); }
  private owner(id: string): string {
    const project = this.deps.projects().find(row => row.id === id);
    if (!project) throw new Error('Unknown activity feed project');
    return JSON.stringify([project.hostId ?? this.deps.primaryHostId(), project.path]);
  }
  private async execute(request: ProjectFeedRequest): Promise<{ events: FeedEvent[]; added: number }> {
    if (this.stopped) throw new Error('Activity feed stopped');
    if (this.pending >= 100) throw new Error('Too many pending activity feed requests');
    const generation = this.generation, owner = this.owner(request.projectId);
    this.pending++;
    const previous = this.tails.get(request.projectId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (this.stopped || generation !== this.generation || owner !== this.owner(request.projectId)) throw new Error('Activity feed owner changed');
      const result = ProjectFeedResultSchema.parse(await this.deps.request(request));
      if (this.stopped || generation !== this.generation || owner !== this.owner(request.projectId)) throw new Error('Activity feed owner changed');
      const expectedHost = JSON.parse(owner)[0];
      if (result.projectId !== request.projectId || result.hostId !== expectedHost || result.events.some(event => event.projectId !== request.projectId)) throw new Error('Activity feed response scope mismatch');
      const events = result.events.map(({ dedupeKey: _key, ...event }) => event);
      const encoded = JSON.stringify(events), bytes = Buffer.byteLength(encoded);
      if (bytes > PROJECT_FEED_MAX_BYTES) throw new Error('Activity feed snapshot is too large');
      const changed = this.cache.get(request.projectId)?.encoded !== encoded;
      this.cache.delete(request.projectId);
      this.cache.set(request.projectId, { owner, events, encoded, bytes });
      let total = [...this.cache.values()].reduce((sum, saved) => sum + saved.bytes, 0);
      while (this.cache.size > 128 || total > 32 * 1024 * 1024) {
        const oldest = this.cache.keys().next().value!;
        total -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
      }
      if (changed) this.emit('changed', request.projectId);
      return { events, added: result.added };
    });
    this.tails.set(request.projectId, task);
    try { return await task; } finally { this.pending--; if (this.tails.get(request.projectId) === task) this.tails.delete(request.projectId); }
  }
  async list(projectId: string): Promise<FeedEvent[]> {
    try { return (await this.execute({ action: 'list', projectId })).events; }
    catch (error) {
      this.deps.log('Activity feed read', error);
      const saved = this.cache.get(projectId);
      try { if (!this.stopped && saved?.owner === this.owner(projectId)) return saved.events; } catch { /* Removed owner has no display snapshot. */ }
      return [];
    }
  }
  async appendMany(projectId: string, events: FeedEventInput[]): Promise<number> {
    return (await this.execute({ action: 'append', projectId, events })).added;
  }
  async append(event: FeedEventInput): Promise<void> { await this.appendMany(event.projectId, [event]); }
  onProjectRemoved(projectId: string): void { this.generation++; this.cache.delete(projectId); }
  stop(): void { this.stopped = true; this.generation++; this.cache.clear(); this.removeAllListeners(); }
}
