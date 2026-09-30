import { expect, it, vi } from 'vitest';
import { createModelDiscoveryQueue } from './model-discovery-queue.js';

function pending() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(done => { resolve = done; });
  return { promise, resolve };
}

it('leaves network capacity for interactive requests and drains discovery in order', async () => {
  const schedule = createModelDiscoveryQueue();
  const signal = new AbortController().signal;
  const first = pending(), second = pending();
  const third = vi.fn(async () => 'third');
  const fourth = vi.fn(async () => 'fourth');
  const jobs = [schedule(() => first.promise, signal), schedule(() => second.promise, signal),
    schedule(third, signal), schedule(fourth, signal)];
  expect(third).not.toHaveBeenCalled();
  expect(fourth).not.toHaveBeenCalled();
  first.resolve('first');
  await jobs[0];
  expect(third).toHaveBeenCalledOnce();
  second.resolve('second');
  expect(await Promise.all(jobs)).toEqual(['first', 'second', 'third', 'fourth']);
});

it('removes cancelled queued requests and never starts already-cancelled discovery', async () => {
  const schedule = createModelDiscoveryQueue();
  const signal = new AbortController().signal;
  const first = pending(), second = pending();
  const active = [schedule(() => first.promise, signal), schedule(() => second.promise, signal)];
  const controller = new AbortController();
  const run = vi.fn(async () => 'cancelled');
  const queued = schedule(run, controller.signal);
  const rejected = expect(queued).rejects.toThrow('cancelled');
  controller.abort();
  await rejected;
  await expect(schedule(run, controller.signal)).rejects.toThrow('cancelled');
  first.resolve('first'); second.resolve('second');
  await Promise.all(active);
  expect(run).not.toHaveBeenCalled();
  expect(await schedule(async () => 'fresh', signal)).toBe('fresh');
});

it('releases slots after rejected requests and synchronous transport errors', async () => {
  const schedule = createModelDiscoveryQueue();
  const signal = new AbortController().signal;
  await expect(schedule(() => { throw new Error('sync'); }, signal)).rejects.toThrow('sync');
  const first = schedule(async () => { throw new Error('offline'); }, signal);
  const second = schedule(async () => { throw new Error('timeout'); }, signal);
  const next = schedule(async () => 'reconnected', signal);
  await expect(first).rejects.toThrow('offline');
  await expect(second).rejects.toThrow('timeout');
  expect(await next).toBe('reconnected');
});
