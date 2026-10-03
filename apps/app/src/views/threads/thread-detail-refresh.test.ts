import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedRunner } from '../../lib/coalesced-runner.js';
import { createThreadRefreshScheduler, THREAD_REFRESH_MAX_WAIT_MS } from './thread-detail-refresh.js';

describe('thread detail refresh scheduling', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces a short burst into one refresh after the final event', async () => {
    const refresh = vi.fn();
    const scheduler = createThreadRefreshScheduler(refresh);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(THREAD_REFRESH_MAX_WAIT_MS);
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes throughout ten seconds of continuous events and after the last event', async () => {
    const refreshTimes: number[] = [];
    const scheduler = createThreadRefreshScheduler(() => { refreshTimes.push(Date.now()); });
    for (let elapsed = 0; elapsed < 10_000; elapsed += 25) {
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(25);
      expect(Date.now() - (refreshTimes.at(-1) ?? 0)).toBeLessThanOrEqual(THREAD_REFRESH_MAX_WAIT_MS);
    }
    expect(refreshTimes).toHaveLength(40);
    scheduler.schedule(); // A final event after the bounded flush must still be read.
    await vi.advanceTimersByTimeAsync(100);
    expect(refreshTimes.at(-1)).toBe(10_100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears both pending timers on disposal and ignores late events', async () => {
    const refresh = vi.fn();
    const scheduler = createThreadRefreshScheduler(refresh);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.dispose();
    scheduler.dispose();
    scheduler.schedule();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps slow metadata/timeline request pairs serialized and discards queued work on disposal', async () => {
    let activePairs = 0;
    let maxActivePairs = 0;
    const metadata = vi.fn(() => new Promise<void>(resolve => { setTimeout(resolve, 600); }));
    const timeline = vi.fn(() => new Promise<void>(resolve => { setTimeout(resolve, 750); }));
    const runner = createCoalescedRunner(async () => {
      activePairs++;
      maxActivePairs = Math.max(maxActivePairs, activePairs);
      await Promise.all([metadata(), timeline()]);
      activePairs--;
    });
    const scheduler = createThreadRefreshScheduler(runner.run);
    runner.run(); // The initial detail load remains immediate.
    for (let elapsed = 0; elapsed < 2000; elapsed += 25) {
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(metadata).toHaveBeenCalledTimes(3);
    expect(timeline).toHaveBeenCalledTimes(3);
    expect(maxActivePairs).toBe(1);
    scheduler.dispose();
    runner.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(metadata).toHaveBeenCalledTimes(3);
    expect(activePairs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
