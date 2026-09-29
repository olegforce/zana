import { expect, it, vi } from 'vitest';
import type { Project } from '@zana-ai/zcc-domain/product';
import { ProjectFeedStore } from './project-feed-store.js';

const event = { id: 'one', projectId: 'p', kind: 'commit' as const, title: 'One', ts: 1, dedupeKey: 'commit:one' };
function fixture() {
  let projects = [{ id: 'p', path: '/owner', hostId: 'host' } as Project];
  const request = vi.fn(async () => ({ projectId: 'p', hostId: 'host', events: [event], added: 0 })), log = vi.fn();
  const store = new ProjectFeedStore({ projects: () => projects, primaryHostId: () => 'primary', request, log });
  const changed = vi.fn(); store.on('changed', changed);
  return { store, request, log, changed, projects: (rows: Project[]) => { projects = rows; } };
}
it('publishes acknowledged snapshots once, retains them offline and never acknowledges failed writes', async () => {
  const f = fixture();
  expect(await f.store.list('p')).toEqual([{ id: 'one', projectId: 'p', kind: 'commit', title: 'One', ts: 1 }]);
  await f.store.list('p'); expect(f.changed).toHaveBeenCalledOnce();
  f.request.mockRejectedValue(new Error('offline')); expect(await f.store.list('p')).toHaveLength(1);
  await expect(f.store.append(event)).rejects.toThrow('offline'); expect(f.changed).toHaveBeenCalledOnce();
  f.store.onProjectRemoved('p'); expect(await f.store.list('p')).toEqual([]); f.store.stop();
});
it('rejects substituted response identities, oversized replies, and changed owners without local fallback', async () => {
  const f = fixture();
  for (const value of [
    { projectId: 'other', hostId: 'host', events: [event], added: 0 },
    { projectId: 'p', hostId: 'other', events: [event], added: 0 },
    { projectId: 'p', hostId: 'host', events: [{ ...event, projectId: 'other' }], added: 0 },
    { projectId: 'p', hostId: 'host', events: Array(18).fill({ ...event, title: 'x'.repeat(250_000) }), added: 0 },
  ]) { f.request.mockResolvedValueOnce(value); await expect(f.store.append(event)).rejects.toThrow(); }
  await f.store.list('p'); f.projects([{ id: 'p', path: '/changed', hostId: 'host' } as Project]);
  f.request.mockRejectedValue(new Error('offline')); expect(await f.store.list('p')).toEqual([]);
  f.projects([]); expect(await f.store.list('p')).toEqual([]); f.store.stop();
});
it('serializes per-project requests, cancels late owner results and stops queued work on shutdown', async () => {
  const f = fixture(); let release!: (value: any) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = f.store.list('p'), second = f.store.list('p');
  await Promise.resolve(); await Promise.resolve(); expect(f.request).toHaveBeenCalledOnce();
  f.store.onProjectRemoved('p'); release({ projectId: 'p', hostId: 'host', events: [event], added: 1 });
  expect(await first).toEqual([]); expect(await second).toEqual([]); expect(f.changed).not.toHaveBeenCalled();
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const stopped = f.store.list('p'); await Promise.resolve(); await Promise.resolve(); f.store.stop();
  release({ projectId: 'p', hostId: 'host', events: [event], added: 1 }); expect(await stopped).toEqual([]);
  expect(await f.store.list('p')).toEqual([]);
});
it('bounds pending requests and cache entries and supports legacy primary project identity', async () => {
  const f = fixture(); let release!: (value: any) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = f.store.list('p'); await Promise.resolve(); await Promise.resolve();
  const queued = Array.from({ length: 99 }, () => f.store.list('p'));
  await expect(f.store.append(event)).rejects.toThrow('Too many');
  release({ projectId: 'p', hostId: 'host', events: [], added: 0 }); await Promise.all([first, ...queued]);
  const projects = Array.from({ length: 130 }, (_, n) => ({ id: String(n), path: `/${n}` }) as Project); f.projects(projects);
  f.request.mockImplementation(async (raw?: any) => ({ projectId: raw.projectId, hostId: 'primary', events: [{ ...event, projectId: raw.projectId }], added: 1 }));
  for (const project of projects) expect(await f.store.appendMany(project.id, [{ ...event, projectId: project.id }])).toBe(1);
  f.request.mockRejectedValue(new Error('offline')); expect(await f.store.list('0')).toEqual([]); expect(await f.store.list('129')).toHaveLength(1); f.store.stop();
});
