import { afterEach, expect, it, vi } from 'vitest';
import { ModelDiscoveryLane } from './model-discovery-lane.js';

afterEach(() => vi.useRealTimers());

it('coalesces identical scopes and serializes beyond the active limit', async () => {
  const lane = new ModelDiscoveryLane(1);
  let done!: (value: string) => void;
  const first = lane.run('p1', () => new Promise<string>((resolve) => { done = resolve; }));
  expect(lane.run('p1', async () => 'duplicate')).toBe(first);
  const nextLoad = vi.fn(async () => 'next');
  const next = lane.run('p2', nextLoad);
  await Promise.resolve();
  expect(nextLoad).not.toHaveBeenCalled();
  done('first');
  expect(await first).toBe('first');
  expect(await next).toBe('next');
  expect(await lane.run('p1', async () => 'fresh')).toBe('fresh');
  lane.dispose();
});

it('bounds the queue and wait time, then recovers from a failed active job', async () => {
  vi.useFakeTimers();
  const lane = new ModelDiscoveryLane(1, 1, 10);
  let reject!: (error: Error) => void;
  const first = lane.run('p1', () => new Promise<void>((_, fail) => { reject = fail; }));
  const firstError = expect(first).rejects.toThrow('auth');
  const queued = lane.run('p2', async () => 'unused');
  const timeout = expect(queued).rejects.toThrow('timed out');
  await expect(lane.run('p3', async () => 'unused')).rejects.toThrow('busy');
  await vi.advanceTimersByTimeAsync(10);
  await timeout;
  reject(new Error('auth'));
  await firstError;
  expect(await lane.run('p2', async () => 'fresh')).toBe('fresh');
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects queued and future jobs on shutdown and clears timers', async () => {
  vi.useFakeTimers();
  const lane = new ModelDiscoveryLane(1);
  let done!: () => void;
  const first = lane.run('p1', () => new Promise<void>((resolve) => { done = resolve; }));
  const queued = lane.run('p2', async () => 'unused');
  const rejection = expect(queued).rejects.toThrow('shutting down');
  await Promise.resolve();
  lane.dispose();
  await rejection;
  await expect(lane.run('p3', async () => 'unused')).rejects.toThrow('shutting down');
  expect(vi.getTimerCount()).toBe(0);
  done();
  await first;
});
