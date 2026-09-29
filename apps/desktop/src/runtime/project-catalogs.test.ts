import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '@zana-ai/zcc-domain/product';
import { ProjectCatalogs } from './project-catalogs.js';
const project = (id: string, patch = {}): Project => ({ id, name: id, path: `/${id}`, hostId: 'foreign', createdAt: 1, lastActiveAt: 1, ...patch });
const result = (projectId: string, patch = {}) => ({ projectId, hostId: 'foreign', personas: ['{"id":"p"}'], teams: [], templates: [], ...patch });
function fixture(initial = [project('one')]) {
  let projects = initial;
  const read = vi.fn(async ({ projectId }) => result(projectId)), changed = vi.fn(), log = vi.fn();
  const catalog = new ProjectCatalogs({ projects: () => projects, primaryHostId: () => 'primary', read, changed, log });
  return { catalog, read, changed, log, projects: (next: Project[]) => { projects = next; } };
}
afterEach(() => vi.useRealTimers());
it('keeps acknowledged data on failure, filters local/SSH records, and stamps current project names', async () => {
  const f = fixture([project('one'), project('local', { hostId: 'primary' }), project('legacy', { hostId: undefined }), project('ssh', { remote: {} })]);
  await f.catalog.refresh(); expect(f.read).toHaveBeenCalledExactlyOnceWith({ projectId: 'one' });
  expect(f.catalog.sources('personas')).toEqual([{ projectId: 'one', projectName: 'one', records: ['{"id":"p"}'] }]);
  await f.catalog.refresh(); expect(f.changed).toHaveBeenCalledOnce();
  f.read.mockRejectedValue(new Error('offline')); await f.catalog.refresh(); expect(f.catalog.sources('personas')).toHaveLength(1); expect(f.log).toHaveBeenCalledOnce();
  f.projects([project('one', { name: 'Renamed' })]); expect(f.catalog.sources('personas')[0].projectName).toBe('Renamed');
  f.projects([project('one', { path: '/replacement' })]); expect(f.catalog.sources('personas')).toEqual([]); await f.catalog.refresh(); expect(f.changed).toHaveBeenCalledTimes(2);
  f.projects([]); await f.catalog.refresh(); expect(f.catalog.sources('personas')).toEqual([]); f.catalog.stop();
});
it('rejects response identity, shape and byte substitutions without replacing the snapshot', async () => {
  const f = fixture(); await f.catalog.refresh();
  for (const value of [result('different'), result('one', { hostId: 'other' }), result('one', { extra: 'forged' }), result('one', { personas: ['é'.repeat(140_000)] }), result('one', { personas: Array(9).fill('x'.repeat(250_000)) })]) {
    f.read.mockResolvedValueOnce(value); await f.catalog.refresh(); expect(f.catalog.sources('personas')[0].records).toEqual(['{"id":"p"}']);
  }
  expect(f.log).toHaveBeenCalledTimes(5); f.catalog.stop();
});
it('bounds concurrent reads including expired requests and fences removed or stopped owners', async () => {
  vi.useFakeTimers(); const f = fixture(Array.from({ length: 8 }, (_, n) => project(String(n))));
  const done: Array<(value: ReturnType<typeof result>) => void> = [];
  f.read.mockImplementation(() => new Promise(resolve => done.push(resolve)));
  const pending = f.catalog.refresh(); expect(f.catalog.refresh()).toBe(pending); await Promise.resolve(); expect(done).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(15_001); await pending; await f.catalog.refresh(); expect(done).toHaveLength(4);
  done.forEach((resolve, n) => resolve(result(String(n)))); await Promise.resolve(); await Promise.resolve(); expect(f.catalog.sources('personas')).toEqual([]);
  const next = f.catalog.refresh(); await Promise.resolve(); expect(done).toHaveLength(8);
  f.projects([]); for (let n = 4; n < 8; n++) done[n](result(String(n))); await next; expect(f.catalog.sources('personas')).toEqual([]);
  f.projects([project('last')]); const late = f.catalog.refresh(); await Promise.resolve(); f.catalog.stop(); done.at(-1)!(result('last')); await late;
  expect(f.changed).not.toHaveBeenCalled(); await f.catalog.refresh();
});
it('polls once, releases timers and retains a bounded cache across many projects', async () => {
  vi.useFakeTimers(); const f = fixture(); f.catalog.start(); f.catalog.start(); await vi.advanceTimersByTimeAsync(1);
  expect(f.read).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(15_000); expect(f.read).toHaveBeenCalledTimes(2);
  f.catalog.stop(); f.catalog.start(); await vi.advanceTimersByTimeAsync(30_000); expect(f.read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  const large = fixture(Array.from({ length: 10 }, (_, n) => project(String(n))));
  large.read.mockImplementation(async ({ projectId }) => result(projectId, { personas: Array(8).fill('x'.repeat(250_000)) }));
  await large.catalog.refresh(); expect(large.catalog.sources('personas')).toHaveLength(8); expect(large.log).toHaveBeenCalledTimes(2); large.catalog.stop();
});
it('coalesces project additions during a read and recovers from a failed project inventory', async () => {
  const f = fixture(); let done!: (value: ReturnType<typeof result>) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  const pending = f.catalog.refresh(); await Promise.resolve();
  f.projects([project('one'), project('two')]); void f.catalog.refresh(); done(result('one')); await pending;
  expect(f.catalog.sources('personas').map(source => source.projectId)).toEqual(['one', 'two']); f.catalog.stop();
  const projects = vi.fn().mockImplementationOnce(() => { throw new Error('inventory unavailable'); }).mockReturnValue([]), log = vi.fn();
  const catalog = new ProjectCatalogs({ projects, primaryHostId: () => undefined, read: vi.fn(), changed: vi.fn(), log });
  await catalog.refresh(); expect(log).toHaveBeenCalledOnce(); await catalog.refresh(); catalog.stop();
});

it('retries a failed consumer invalidation even when the owner snapshot is unchanged', async () => {
  const f = fixture([project('one'), project('two')]);
  f.changed.mockImplementationOnce(() => { throw new Error('consumer temporarily unavailable'); });
  await f.catalog.refresh(); expect(f.changed).toHaveBeenCalledOnce(); expect(f.log).toHaveBeenCalledOnce();
  expect(f.catalog.sources('personas')).toHaveLength(2);
  await f.catalog.refresh(); expect(f.changed).toHaveBeenCalledTimes(2);
  await f.catalog.refresh(); expect(f.changed).toHaveBeenCalledTimes(2);
  f.catalog.stop();
});
