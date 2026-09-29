import { expect, it, vi } from 'vitest';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
import { collectLibrarySnapshot, LIBRARY_SNAPSHOT_DOC_LIMIT as LIMIT } from './library-snapshot.js';

const root = (projectId: string) => ({ scope: 'project' as const, projectId, projectName: projectId, hostId: projectId, privatePath: '/must-not-publish' });
const doc = (id: string) => ({ id } as LibraryDoc);
it('keeps accessible owners, exposes failures without private errors, and never substitutes another root', async () => {
  const read = vi.fn(async (value: ReturnType<typeof root>) => {
    if (value.projectId === 'b') throw Object.assign(new Error('secret path'), { code: 'host-unavailable' });
    if (value.projectId === 'c') throw new Error('conflicting journal');
    return [doc(value.projectId)];
  });
  const result = await collectLibrarySnapshot(['a', 'b', 'c', 'd'].map(root), read, Date.now() + 1000);
  expect(result).toMatchObject({ docs: [doc('a'), doc('d')], complete: false, roots: [
    { projectId: 'a', state: 'ready' }, { projectId: 'b', state: 'offline' }, { projectId: 'c', state: 'unavailable' }, { projectId: 'd', state: 'ready' }
  ] });
  expect(JSON.stringify(result)).not.toMatch(/privatePath|must-not-publish|secret|journal/);
  expect(read.mock.calls.map(([value]) => value.projectId)).toEqual(['a', 'b', 'c', 'd']);
});
it('bounds concurrency at four and preserves registry order despite reverse completion', async () => {
  const finish: Array<() => void> = [];
  const read = vi.fn((value: ReturnType<typeof root>) => new Promise<LibraryDoc[]>(resolve => finish.push(() => resolve([doc(value.projectId)]))));
  const task = collectLibrarySnapshot(['a', 'b', 'c', 'd', 'e'].map(root), read, Date.now() + 1000);
  expect(read).toHaveBeenCalledTimes(4);
  finish.slice().reverse().forEach(resolve => resolve());
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5)); finish[4]();
  expect((await task).docs.map(value => value.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
});
it('caps roots, per-root rows and aggregate rows without presenting omissions as complete', async () => {
  const read = vi.fn(async (value: ReturnType<typeof root>) => Array.from({ length: value.projectId === 'huge' ? LIMIT + 1 : value.projectId === 'half' ? LIMIT / 2 + 1 : LIMIT }, () => doc(value.projectId)));
  await expect(collectLibrarySnapshot(Array.from({ length: 1001 }, () => root('a')), read, Infinity)).rejects.toThrow('root limit');
  expect(read).not.toHaveBeenCalled();
  const result = await collectLibrarySnapshot(['huge', 'half', 'half', 'full', 'next'].map(root), read, Infinity);
  expect(result.docs).toHaveLength(LIMIT / 2 + 1); expect(result.complete).toBe(false);
  expect(result.roots.map(value => value.state)).toEqual(['limit', 'ready', 'limit', 'limit', 'limit']);
  read.mockClear();
  const full = await collectLibrarySnapshot(['full', 'full', 'full', 'full', 'next'].map(root), read, Infinity);
  expect(full.docs).toHaveLength(LIMIT); expect(read).toHaveBeenCalledTimes(4); expect(full.roots[4].state).toBe('limit');
});
it('does not dispatch after deadline and handles empty registries, empty roots and non-Error failures', async () => {
  const read = vi.fn(async () => []);
  expect(await collectLibrarySnapshot([], read, 0)).toEqual({ docs: [], roots: [], complete: true });
  expect((await collectLibrarySnapshot([root('a')], read, 1, () => 2)).roots[0].state).toBe('unavailable');
  expect(read).not.toHaveBeenCalled();
  expect((await collectLibrarySnapshot([root('a')], read, Infinity)).complete).toBe(true);
  for (const error of [null, 'failed', { code: 'host_disconnected' }, { code: 'host_unavailable' }]) {
    const result = await collectLibrarySnapshot([root('a')], async () => { throw error; }, Infinity);
    expect(result.roots[0].state).toBe(typeof error === 'object' && error !== null ? 'offline' : 'unavailable');
  }
});
