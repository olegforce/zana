// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), changed: vi.fn(), reconnect: vi.fn(), catalog: vi.fn(), stopChanged: vi.fn(), stopReconnect: vi.fn() }));
vi.mock('../lib/product-client.js', () => ({ product: { hosts: { list: mocks.list, onChanged: mocks.changed } } }));
vi.mock('../lib/product-ws.js', () => ({ subscribeProductReconnect: mocks.reconnect }));
vi.mock('../components/thread/pickers/thread-model-catalog.js', () => ({ updateModelCatalogHosts: mocks.catalog }));
import { resetHostsCache, useHosts } from './useHosts.js';

function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks(); resetHostsCache();
  mocks.changed.mockReturnValue(mocks.stopChanged); mocks.reconnect.mockReturnValue(mocks.stopReconnect);
});

it('hydrates the cache, subscribes once, and ignores acknowledgements after unmount', async () => {
  mocks.list.mockResolvedValue([{ id: 'primary' }]);
  const first = renderHook(useHosts);
  await waitFor(() => expect(first.result.current).toEqual([{ id: 'primary' }]));
  first.unmount(); expect(mocks.stopChanged).toHaveBeenCalledOnce(); expect(mocks.stopReconnect).toHaveBeenCalledOnce();
  const late = deferred(); mocks.list.mockReturnValue(late.promise);
  const second = renderHook(useHosts);
  expect(second.result.current).toEqual([{ id: 'primary' }]);
  const change = mocks.changed.mock.calls[1][0];
  second.unmount();
  await act(async () => { late.resolve([{ id: 'stale' }]); change([{ id: 'after-unmount' }]); });
  expect(mocks.catalog).toHaveBeenLastCalledWith([{ id: 'primary' }]);
  expect(mocks.changed).toHaveBeenCalledTimes(2);
});

it('fences a slow initial list when a newer roster arrives over the subscription', async () => {
  const initial = deferred(); mocks.list.mockReturnValue(initial.promise);
  const hook = renderHook(useHosts);
  act(() => mocks.changed.mock.calls[0][0]([{ id: 'secondary', status: 'connected' }]));
  await act(async () => initial.resolve([{ id: 'old-host' }]));
  expect(hook.result.current).toEqual([{ id: 'secondary', status: 'connected' }]);
  hook.unmount();
});

it('keeps the latest reconnect refresh when earlier requests resolve or fail later', async () => {
  const old = deferred(), newer = deferred(), latest = deferred();
  mocks.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(latest.promise);
  const hook = renderHook(useHosts);
  act(() => { void mocks.reconnect.mock.calls[0][0](); mocks.changed.mock.calls[0][0](); });
  await act(async () => latest.resolve([{ id: 'current' }]));
  await act(async () => { newer.resolve([{ id: 'stale' }]); old.reject(new Error('old connection failed')); });
  expect(hook.result.current).toEqual([{ id: 'current' }]);
  hook.unmount();
});

it('clears unavailable or malformed current rosters and does not update after unmount', async () => {
  mocks.list.mockResolvedValueOnce([{ id: 'primary' }]);
  const hook = renderHook(useHosts);
  await waitFor(() => expect(hook.result.current).toHaveLength(1));
  mocks.list.mockRejectedValueOnce(new Error('offline'));
  await act(async () => mocks.reconnect.mock.calls[0][0]());
  expect(hook.result.current).toEqual([]);
  mocks.list.mockResolvedValueOnce({ invalid: true });
  await act(async () => mocks.reconnect.mock.calls[0][0]());
  expect(hook.result.current).toEqual([]);
  const late = deferred(); mocks.list.mockReturnValueOnce(late.promise);
  act(() => { void mocks.reconnect.mock.calls[0][0](); });
  hook.unmount();
  await act(async () => late.reject(new Error('late offline')));
  expect(mocks.catalog).toHaveBeenLastCalledWith([]);
});
