// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStats } from './AgentInsights';
const stats = vi.hoisted(() => vi.fn());
vi.mock('../lib/product-client.js', () => ({ product: { terminals: { sessionStats: stats } } }));
afterEach(() => { cleanup(); vi.useRealTimers(); stats.mockReset(); });
it('serializes reads, ignores stale sessions and stops on exit or unmount', async () => {
  vi.useFakeTimers(); const resolvers: ((value: any) => void)[] = []; stats.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
  const hook = renderHook(({ session, exited }) => useSessionStats(session, 'project', exited), { initialProps: { session: 'old', exited: false } });
  await act(async () => { await vi.advanceTimersByTimeAsync(12000); }); expect(stats).toHaveBeenCalledTimes(1);
  hook.rerender({ session: 'new', exited: true }); expect(stats).toHaveBeenCalledTimes(2);
  await act(async () => { resolvers[0]({ model: 'old' }); resolvers[1]({ model: 'new' }); }); expect(hook.result.current).toEqual({ model: 'new' });
  await act(async () => { await vi.advanceTimersByTimeAsync(12000); }); expect(stats).toHaveBeenCalledTimes(2);
  hook.unmount();
});
it('does not read disabled sessions and retries errors while mounted', async () => {
  vi.useFakeTimers(); stats.mockRejectedValue(new Error('offline')); const hook = renderHook(({ enabled }) => useSessionStats('s', 'p', false, enabled), { initialProps: { enabled: false } });
  expect(stats).not.toHaveBeenCalled(); hook.rerender({ enabled: true }); await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(stats).toHaveBeenCalledTimes(2); expect(hook.result.current).toBeNull(); hook.unmount();
});
