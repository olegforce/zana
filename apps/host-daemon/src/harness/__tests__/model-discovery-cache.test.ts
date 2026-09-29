import { afterEach, expect, it, vi } from 'vitest';
import { ModelDiscoveryCache } from '../model-discovery-cache.js';

afterEach(() => vi.useRealTimers());

it('shares pending discovery, expires successes, and invalidates without re-caching old results', async () => {
  vi.useFakeTimers();
  const cache = new ModelDiscoveryCache<string>(100);
  let resolve!: (rows: string[]) => void;
  const load = vi.fn(() => new Promise<string[]>((done) => { resolve = done; }));
  const first = cache.discover('project', load);
  expect(cache.discover('project', load)).toBe(first);
  await Promise.resolve();
  resolve(['old']);
  await first;
  expect(await cache.discover('project', load)).toEqual(['old']);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  const stale = cache.discover('project', load);
  await Promise.resolve();
  cache.clear();
  resolve(['stale']);
  await stale;
  expect(await cache.discover('project', async () => ['new'])).toEqual(['new']);
  cache.clear();
  expect(await cache.discover('project', async () => ['latest'])).toEqual(['latest']);
});

it('does not cache empty, rejected, or synchronously thrown discoveries', async () => {
  const cache = new ModelDiscoveryCache<string>();
  expect(await cache.discover('p', async () => [])).toEqual([]);
  await expect(cache.discover('p', () => { throw new Error('auth'); })).rejects.toThrow('auth');
  expect(await cache.discover('p', async () => ['working'])).toEqual(['working']);
});

it('bounds completed entries and simultaneous requests without evicting running work', async () => {
  const cache = new ModelDiscoveryCache<string>(100, 1);
  await cache.discover('a', async () => ['a']);
  await cache.discover('b', async () => ['b']);
  expect(await cache.discover('a', async () => ['a2'])).toEqual(['a2']);
  let done!: (value: string[]) => void;
  const running = cache.discover('b', () => new Promise<string[]>((resolve) => { done = resolve; }));
  await expect(cache.discover('c', async () => ['c'])).rejects.toThrow('busy');
  done([]);
  await running;
  expect(await cache.discover('c', async () => ['c'])).toEqual(['c']);
});

it('waits for invalidated running discovery before fulfilling a new request with fresh results', async () => {
  const cache = new ModelDiscoveryCache<string>();
  let reject!: (error: Error) => void;
  const old = cache.discover('project', () => new Promise<string[]>((_, fail) => { reject = fail; }));
  const oldError = expect(old).rejects.toThrow('old credentials');
  await Promise.resolve();
  cache.clear();
  const freshLoad = vi.fn(async () => ['fresh']);
  const fresh = cache.discover('project', freshLoad);
  expect(freshLoad).not.toHaveBeenCalled();
  reject(new Error('old credentials'));
  await oldError;
  expect(await fresh).toEqual(['fresh']);
});
