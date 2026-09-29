import { PROJECT_CATALOG_KINDS, ProjectCatalogResultSchema, type ProjectCatalogRequest, type ProjectCatalogSource, type ProjectCatalogResult } from '@zana-ai/zcc-contracts/project-metadata-records';
import type { Project } from '@zana-ai/zcc-domain/product';

/** Bounded original-owner snapshots. Failed reads retain the acknowledged
 * catalogue; removed/reassigned projects immediately lose their cached records. */
export class ProjectCatalogs {
  private snapshots = new Map<string, { owner: string; result: ProjectCatalogResult; bytes: number }>();
  private inFlight = new Set<string>();
  private cursor = 0;
  private stopped = false;
  private pending = false;
  private notificationPending = false;
  private busy: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly deps: {
    projects(): Project[]; primaryHostId(): string | undefined;
    read(request: ProjectCatalogRequest): Promise<unknown>;
    changed(): void; log(projectId: string, error: unknown): void;
  }) {}
  private owner(project: Project): string { return JSON.stringify([project.hostId, project.path]); }
  private foreign(): Project[] {
    return this.deps.projects().filter(project => !project.remote && project.hostId && project.hostId !== this.deps.primaryHostId()).slice(0, 1000);
  }
  sources(kind: typeof PROJECT_CATALOG_KINDS[number]): ProjectCatalogSource[] {
    return this.foreign().flatMap(project => {
      const saved = this.snapshots.get(project.id);
      return saved?.owner === this.owner(project) ? [{ projectId: project.id, projectName: project.name, records: saved.result[kind] }] : [];
    });
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.refresh(); }, 15_000); this.timer.unref();
    void this.refresh();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.snapshots.clear(); this.notificationPending = false; }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending = true;
    return this.busy ??= (async () => {
      do {
        this.pending = false;
        try { await this.load(); } catch (error) { if (!this.stopped) this.deps.log('', error); }
        if (this.notificationPending && !this.stopped) {
          try { this.deps.changed(); this.notificationPending = false; }
          catch (error) { this.deps.log('', error); }
        }
      } while (this.pending && !this.stopped);
    })().finally(() => { this.busy = undefined; });
  }
  private async load(): Promise<void> {
    const projects = this.foreign(), current = new Map(projects.map(project => [project.id, this.owner(project)]));
    for (const [id, saved] of this.snapshots) if (current.get(id) !== saved.owner) { this.snapshots.delete(id); this.notificationPending = true; }
    const deadline = Date.now() + 15_000, start = projects.length ? this.cursor % projects.length : 0;
    const ordered = [...projects.slice(start), ...projects.slice(0, start)]; let cursor = 0;
    const read = async () => {
      while (!this.stopped && cursor < ordered.length && Date.now() < deadline) {
        if (this.inFlight.size >= 4) return;
        const project = ordered[cursor++]; this.cursor = (start + cursor) % projects.length;
        if (!this.foreign().some(row => row.id === project.id && this.owner(row) === this.owner(project))) continue;
        if (this.inFlight.has(project.id)) continue;
        this.inFlight.add(project.id);
        const request = Promise.resolve().then(() => this.deps.read({ projectId: project.id }));
        void request.then(() => this.inFlight.delete(project.id), () => this.inFlight.delete(project.id));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const raw = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Project catalogue refresh timed out')), Math.max(1, deadline - Date.now())); })]);
          const result = ProjectCatalogResultSchema.parse(raw), encoded = JSON.stringify(result), bytes = Buffer.byteLength(encoded);
          if (result.projectId !== project.id || result.hostId !== project.hostId) throw new Error('Project catalogue owner mismatch');
          const sizes = PROJECT_CATALOG_KINDS.flatMap(kind => result[kind].map(record => Buffer.byteLength(record)));
          if (sizes.some(size => size > 256 * 1024) || sizes.reduce((sum, size) => sum + size, 0) > 2 * 1024 * 1024) throw new Error('Project catalogue response is too large');
          if (this.stopped || !this.foreign().some(row => row.id === project.id && this.owner(row) === this.owner(project))) continue;
          const total = [...this.snapshots.entries()].reduce((sum, [id, saved]) => sum + (id === project.id ? 0 : saved.bytes), bytes);
          if (total > 16 * 1024 * 1024) throw new Error('Project catalogue cache capacity reached');
          const previous = this.snapshots.get(project.id);
          if (previous?.owner !== this.owner(project) || JSON.stringify(previous.result) !== encoded) {
            this.snapshots.set(project.id, { owner: this.owner(project), result, bytes }); this.notificationPending = true;
          }
        } catch (error) { if (!this.stopped) this.deps.log(project.id, error); }
        finally { if (timer) clearTimeout(timer); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ordered.length) }, read));
  }
}
