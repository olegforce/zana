// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePerformance } from './use-performance.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), desktop: vi.fn(), metrics: vi.fn() }));
vi.mock('../../lib/fetch-with-app-surface.js', () => ({ apiJson: mocks.api }));
vi.mock('../../lib/app-surface.js', () => ({ hasDesktopBridge: mocks.desktop }));
const snapshot = () => ({ hostId: 'a', sampledAt: Date.now(), processes: [] });
const summary = (hostId = 'a') => ({ hostId, sampledAt: Date.now(), connected: true, connectedAt: 1, lastHeartbeatAt: 1,
  workload: { activeThreads: 2, threadStates: { starting: 0, active: 1, waiting: 1, stopping: 0 }, terminals: 0, truncated: false }, threads: [], recentConnections: [] });
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(window, 'cc', { configurable: true, value: { app: { performance: mocks.metrics } } });
  mocks.desktop.mockReturnValue(true);
  mocks.metrics.mockImplementation(async () => snapshot());
  mocks.api.mockImplementation(async () => summary());
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('performance polling', () => {
  it('polls once per interval, coalesces in-flight requests and cleans up on unmount', async () => {
    const hook = renderHook(() => usePerformance('a'));
    await settle(); expect(hook.result.current.history).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.api).toHaveBeenCalledTimes(2); expect(hook.result.current.history).toHaveLength(2);
    expect(hook.result.current.workloadHistory).toHaveLength(2);
    let done!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    act(() => { hook.result.current.refresh(); hook.result.current.refresh(); });
    await settle(); expect(mocks.api).toHaveBeenCalledTimes(3);
    await act(async () => { done(summary()); });
    hook.unmount(); expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.api).toHaveBeenCalledTimes(3);
  });
  it('pauses hidden-page requests and immediately refreshes on return', async () => {
    const hook = renderHook(() => usePerformance('a')); await settle();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); }); await settle();
    expect(mocks.api).toHaveBeenCalledTimes(2); hook.unmount();
  });
  it('does not poll without a machine and ignores superseded machine results', async () => {
    const hook = renderHook(({ id }) => usePerformance(id), { initialProps: { id: null as string | null } });
    await settle(); expect(mocks.api).not.toHaveBeenCalled();
    let done!: (value: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    hook.rerender({ id: 'a' }); await settle();
    mocks.api.mockResolvedValue(summary('b'));
    hook.rerender({ id: 'b' }); await settle();
    await act(async () => { done({ hostId: 'a' }); });
    expect(hook.result.current.summary?.hostId).toBe('b');
    expect(hook.result.current.resources).toBeNull(); expect(hook.result.current.history).toEqual([]);
    expect(hook.result.current.workloadHistory).toEqual([expect.objectContaining({ hostId: 'b', count: 2 })]);
  });
  it('retains stale data after failures and recovers with Refresh', async () => {
    const hook = renderHook(() => usePerformance('a')); await settle();
    mocks.api.mockRejectedValueOnce(new Error('offline')); mocks.metrics.mockRejectedValueOnce(new Error('main unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(hook.result.current.error).toContain('stale'); expect(hook.result.current.resourceError).toContain('stale');
    expect(hook.result.current.summary?.sampledAt).toBe(100_000);
    expect(hook.result.current.resources?.sampledAt).toBe(100_000);
    expect(hook.result.current.workloadHistory).toHaveLength(1);
    act(() => hook.result.current.refresh()); await settle();
    expect(hook.result.current.error).toBeNull(); expect(hook.result.current.resourceError).toBeNull();
  });
  it('times out a stuck read and releases pending timers on cleanup', async () => {
    mocks.api.mockImplementation(() => new Promise(() => {})); mocks.metrics.mockImplementation(() => new Promise(() => {}));
    const hook = renderHook(() => usePerformance('a')); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(hook.result.current.refreshing).toBe(false); expect(hook.result.current.error).toContain('could not');
    hook.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('supports browsers and old preload bridges without claiming local measurements', async () => {
    mocks.desktop.mockReturnValue(false);
    const hook = renderHook(() => usePerformance('a')); await settle();
    expect(mocks.metrics).not.toHaveBeenCalled(); expect(hook.result.current.resources).toBeNull();
    expect(hook.result.current.workloadHistory).toHaveLength(1);
    mocks.desktop.mockReturnValue(true); window.cc.app.performance = undefined as never;
    act(() => hook.result.current.refresh()); await settle();
    expect(hook.result.current.resourceError).toBeNull();
    window.cc.app.performance = mocks.metrics; mocks.metrics.mockResolvedValue(null);
    act(() => hook.result.current.refresh()); await settle();
    expect(hook.result.current.resourceError).toContain('could not');
  });
});
