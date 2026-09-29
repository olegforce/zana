import { expect, it, vi } from 'vitest';
import type { LibrarySnapshot } from '@zana-ai/zcc-domain/product';
import { createLibraryState } from './library-state.js';
const snapshot = (projectId: string): LibrarySnapshot => ({ docs: [], roots: [{ scope: 'project', projectId, state: 'offline' }], complete: false });
it('retains only unavailable-owner display records, removing them when the owner returns or the project is removed', () => {
  const a = { id: 'a', relPath: 'a.md', scope: 'project', projectId: 'a' } as LibrarySnapshot['docs'][number];
  const b = { ...a, id: 'b', projectId: 'b' }, global = { ...a, id: 'global', scope: undefined, projectId: undefined };
  const state = createLibraryState(vi.fn());
  state.getState().receive({ docs: [a, b, global], roots: [], complete: true });
  state.getState().receive(snapshot('a'));
  expect(state.getState().docs).toEqual([a]);
  state.getState().receive({ docs: [a], roots: snapshot('a').roots, complete: false }); expect(state.getState().docs).toEqual([a]);
  state.getState().receive({ docs: [], roots: [{ scope: 'project', projectId: 'a', state: 'ready' }], complete: true }); expect(state.getState().docs).toEqual([]);
  state.getState().receive({ docs: [global], roots: [], complete: true });
  state.getState().receive({ docs: [], roots: [{ scope: 'global', state: 'offline' }], complete: false }); expect(state.getState().docs).toEqual([global]);
  state.getState().receive({ docs: Array.from({ length: 10_001 }, () => a), roots: snapshot('a').roots, complete: false }); expect(state.getState().docs).toHaveLength(10_000);
});
it('accepts explicit partial state and preserves it after transient request failure, clearing errors on retry', async () => {
  const read = vi.fn().mockResolvedValueOnce(snapshot('a')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(snapshot('b'));
  const state = createLibraryState(read);
  await state.getState().refresh(); expect(state.getState()).toMatchObject({ roots: snapshot('a').roots, loading: false });
  await state.getState().refresh(); expect(state.getState()).toMatchObject({ roots: snapshot('a').roots, error: expect.stringContaining('Reconnect') });
  await state.getState().refresh(); expect(state.getState()).toMatchObject({ roots: snapshot('b').roots, error: undefined });
});
it('fences both old success and old failure after a push or newer refresh', async () => {
  let resolve!: (value: LibrarySnapshot) => void, reject!: (error: Error) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise<LibrarySnapshot>(r => { resolve = r; }))
    .mockImplementationOnce(() => new Promise<LibrarySnapshot>((_r, e) => { reject = e; })).mockResolvedValue(snapshot('latest'));
  const state = createLibraryState(read);
  const first = state.getState().refresh(); state.getState().receive(snapshot('push')); resolve(snapshot('stale')); await first;
  expect(state.getState().roots).toEqual(snapshot('push').roots);
  const second = state.getState().refresh(); await state.getState().refresh(); reject(new Error('old failure')); await second;
  expect(state.getState()).toMatchObject({ roots: snapshot('latest').roots, error: undefined });
});
