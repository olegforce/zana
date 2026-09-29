// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const search = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/product-client.js', () => ({ product: { library: { search } } }));
import { useLibraryBodySearch } from './useLibraryBodySearch.js';
beforeEach(() => { vi.useFakeTimers(); search.mockReset(); search.mockResolvedValue({ hits: [], truncated: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(200); });
it('debounces edits and clears results and pending timers when the query is empty', async () => {
  const { result, rerender } = renderHook(({ query }) => useLibraryBodySearch(query), { initialProps: { query: '' } });
  expect(result.current.searching).toBe(false); await advance(); expect(search).not.toHaveBeenCalled();
  rerender({ query: 'old' }); rerender({ query: ' new ' });
  expect(result.current.searching).toBe(true); await advance(); expect(search).toHaveBeenCalledExactlyOnceWith('new');
  rerender({ query: 'pending' }); rerender({ query: '' }); await advance();
  expect(search).toHaveBeenCalledTimes(1); expect(result.current.hits.size).toBe(0); expect(result.current.warning).toBe('');
});
it('keys hits by identity, supports old replies, and distinguishes incomplete search from no matches', async () => {
  search.mockResolvedValueOnce({ hits: [{ docId: 'one', absPath: '/same' }, { absPath: '/legacy' }], truncated: true });
  const { result, rerender } = renderHook(({ query }) => useLibraryBodySearch(query), { initialProps: { query: 'needle' } });
  await advance(); expect([...result.current.hits]).toEqual(['one', '/legacy']); expect(result.current.searching).toBe(false); expect(result.current.warning).toContain('partial');
  rerender({ query: 'missing' }); await advance(); expect(result.current.hits.size).toBe(0); expect(result.current.warning).toBe('');
});
it('reports failures and ignores late success or failure after query changes and unmount', async () => {
  let finish!: (value: unknown) => void;
  search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender, unmount } = renderHook(({ query }) => useLibraryBodySearch(query), { initialProps: { query: 'old' } });
  await advance(); search.mockRejectedValueOnce(new Error('offline')); rerender({ query: 'new' }); await advance();
  expect(result.current.warning).toContain('unavailable'); expect(result.current.searching).toBe(false);
  await act(async () => finish({ hits: [{ docId: 'stale' }], truncated: false })); expect(result.current.hits.size).toBe(0); expect(result.current.warning).toContain('unavailable');
  let fail!: (error: Error) => void;
  search.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  rerender({ query: 'closing' }); await advance(); unmount(); await act(async () => fail(new Error('late')));
});
