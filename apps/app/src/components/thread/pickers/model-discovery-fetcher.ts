import { fetchWithAppSurface } from '../../../lib/fetch-with-app-surface.js';
import { readNdjsonEvents } from '../../../lib/ndjson-events.js';
import { createModelDiscoveryQueue } from './model-discovery-queue.js';
import type { ThreadExecutionOptionsFetcher, ThreadExecutionOptionsQuery } from './thread-model-catalog.js';

type Options = Awaited<ReturnType<ThreadExecutionOptionsFetcher>>;
type Job = {
  query: ThreadExecutionOptionsQuery;
  signal?: AbortSignal;
  resolve: (options: Options) => void;
  reject: (error: unknown) => void;
};

/** Multiplex same-scope discoveries so HTTP/1.1 does not serialize providers. */
export function createModelDiscoveryFetcher(single: ThreadExecutionOptionsFetcher): ThreadExecutionOptionsFetcher {
  const groups = new Map<string, Job[]>();
  const scheduleBatch = createModelDiscoveryQueue();

  async function run(jobs: Job[]): Promise<void> {
    const active = jobs.filter((job) => {
      if (!job.signal?.aborted) return true;
      job.reject(new Error('Model discovery cancelled'));
      return false;
    });
    if (active.length === 0) return;
    if (active.length === 1) {
      const job = active[0];
      try { job.resolve(await single(job.query, job.signal ? { signal: job.signal } : undefined)); }
      catch (error) { job.reject(error); }
      return;
    }

    const controller = new AbortController();
    const pending = new Set(active);
    const cancellations = new Map<Job, () => void>();
    const finish = (job: Job, error?: unknown, options?: Options) => {
      if (!pending.delete(job)) return;
      job.signal?.removeEventListener('abort', cancellations.get(job)!);
      if (options) job.resolve(options);
      else job.reject(error);
    };
    for (const job of active) {
      const cancel = () => {
        finish(job, new Error('Model discovery cancelled'));
        if (pending.size === 0) controller.abort();
      };
      cancellations.set(job, cancel);
      job.signal?.addEventListener('abort', cancel, { once: true });
    }
    const { hostId, projectId, refresh } = active[0].query;
    const params = new URLSearchParams({ stream: '1' });
    if (hostId) params.set('hostId', hostId);
    if (projectId) params.set('projectId', projectId);
    if (refresh) params.set('refresh', '1');
    for (const id of new Set(active.map((job) => job.query.providerId!))) params.append('providerId', id);
    try {
      await scheduleBatch(async () => {
        const response = await fetchWithAppSurface(`/api/v1/system/execution-options?${params}`, { signal: controller.signal });
        if (!response.ok) {
          let detail = `Model discovery failed (${response.status})`;
          let code: string | undefined;
          try {
            const body = await response.json() as { message?: unknown; code?: unknown; error?: unknown };
            if (typeof body.message === 'string') detail = body.message;
            else if (typeof body.error === 'string') detail = body.error;
            if (typeof body.code === 'string') code = body.code;
            else if (typeof body.error === 'string') code = body.error;
          } catch { /* Keep the HTTP diagnostic for non-JSON errors. */ }
          throw Object.assign(new Error(detail), { status: response.status, code });
        }
        await readNdjsonEvents<{ providerId: string; options: Options }>(response, (event) => {
          for (const job of pending) {
            if (job.query.providerId === event.providerId && event.options) finish(job, undefined, event.options);
          }
          if (pending.size === 0) controller.abort();
        });
        for (const job of pending) finish(job, new Error('Model discovery stream ended before this provider returned'));
      }, controller.signal);
    } catch (error) {
      for (const job of pending) finish(job, error);
    } finally {
      // Release the body even after a malformed or truncated stream.
      controller.abort();
    }
  }

  return (query, options) => {
    if (!query?.providerId) return single(query, options);
    return new Promise<Options>((resolve, reject) => {
      const key = JSON.stringify([query.hostId, query.projectId, query.refresh]);
      let jobs = groups.get(key);
      if (!jobs) {
        jobs = [];
        groups.set(key, jobs);
        const batch = jobs;
        queueMicrotask(() => {
          if (groups.get(key) === batch) groups.delete(key);
          void run(batch);
        });
      }
      jobs.push({ query, signal: options?.signal, resolve, reject });
      // Match the server batch bound; exceptionally large catalogues split.
      if (jobs.length === 16) groups.delete(key);
    });
  };
}
