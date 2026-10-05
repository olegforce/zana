import { afterEach, expect, it, vi } from 'vitest';
import { createModelDiscoveryFetcher } from './model-discovery-fetcher.js';
import type { ThreadExecutionOptionsFetcher } from './thread-model-catalog.js';

const body = { providers: [], models: [], selectedOnlyModels: [], permissionCeiling: 'full' as const, modelLoadError: null };
const encode = (providerId: string) => new TextEncoder().encode(`${JSON.stringify({ providerId, options: body })}\n`);
afterEach(() => vi.unstubAllGlobals());

it('starts all seven providers over one connection and publishes results before the slowest completes', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ReadableStream({ start(c) { stream = c; } })));
  vi.stubGlobal('fetch', transport);
  const single = vi.fn<ThreadExecutionOptionsFetcher>();
  const fetcher = createModelDiscoveryFetcher(single);
  const ids = Array.from({ length: 7 }, (_, i) => `provider-${i}`);
  const pending = ids.map(providerId => fetcher({ providerId, hostId: 'local', projectId: 'project', refresh: true }));
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  const url = new URL(transport.mock.calls[0][0] as string, 'http://localhost');
  expect(url.searchParams.getAll('providerId')).toEqual(ids);
  expect(url.searchParams.get('projectId')).toBe('project');
  expect(url.searchParams.get('hostId')).toBe('local');
  expect(url.searchParams.get('refresh')).toBe('1');
  stream.enqueue(encode(ids[6]));
  expect(await pending[6]).toEqual(body);
  expect(single).not.toHaveBeenCalled();
  ids.slice(0, 6).forEach(id => stream.enqueue(encode(id)));
  stream.close();
  await Promise.all(pending);
});

it('keeps scope and refresh semantics separate and uses the existing transport for single requests', async () => {
  const single = vi.fn<ThreadExecutionOptionsFetcher>(async () => body);
  const fetcher = createModelDiscoveryFetcher(single);
  await Promise.all([fetcher(), fetcher({ providerId: 'one', projectId: 'a' }),
    fetcher({ providerId: 'two', projectId: 'b' }), fetcher({ providerId: 'three', projectId: 'a', refresh: true })]);
  expect(single).toHaveBeenCalledTimes(4);
  single.mockRejectedValueOnce(new Error('offline'));
  await expect(fetcher({ providerId: 'one' })).rejects.toThrow('offline');
});

it('removes cancelled work before sending and only aborts a stream when every consumer cancels', async () => {
  const single = vi.fn<ThreadExecutionOptionsFetcher>(async () => body);
  const fetcher = createModelDiscoveryFetcher(single);
  const before = new AbortController();
  before.abort();
  await expect(fetcher({ providerId: 'cancelled' }, { signal: before.signal })).rejects.toThrow('cancelled');
  expect(single).not.toHaveBeenCalled();
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }));
  const first = new AbortController(), second = new AbortController();
  const a = fetcher({ providerId: 'a' }, { signal: first.signal });
  const b = fetcher({ providerId: 'b' }, { signal: second.signal });
  const failedA = expect(a).rejects.toThrow('cancelled'), failedB = expect(b).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(signal).toBeDefined());
  first.abort();
  expect(signal.aborted).toBe(false);
  second.abort();
  expect(signal.aborted).toBe(true);
  await Promise.all([failedA, failedB]);
});

it.each([
  [() => new Response('', { status: 503 }), '503'],
  [() => new Response('malformed\n'), 'Unexpected token'],
  [() => new Response(new TextDecoder().decode(encode('a'))), 'ended before']
])('rejects unfinished providers on HTTP, parsing and truncated stream failures', async (response, message) => {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  const fetcher = createModelDiscoveryFetcher(vi.fn());
  const results = await Promise.allSettled([fetcher({ providerId: 'a' }), fetcher({ providerId: 'b' })]);
  expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining(message) }) });
});

it.each([
  [{ code: 'host-unavailable', message: 'Remote host is offline' }, 'host-unavailable', 'Remote host is offline'],
  [{ error: 'path-unavailable' }, 'path-unavailable', 'path-unavailable'],
  [{ message: 123, code: false }, undefined, 'Model discovery failed (503)'],
  [null, undefined, 'Model discovery failed (503)']
])('preserves structured HTTP diagnostics for every batched provider', async (body, code, message) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 503 })));
  const fetcher = createModelDiscoveryFetcher(vi.fn());
  const results = await Promise.allSettled([fetcher({ providerId: 'a' }), fetcher({ providerId: 'b' })]);
  for (const result of results) {
    expect(result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ status: 503, code, message }) });
  }
});

it('splits exceptionally large catalogues at the server batch bound', async () => {
  const transport = vi.fn(async (input: string) => {
    const ids = new URL(input, 'http://localhost').searchParams.getAll('providerId');
    return new Response(ids.map(id => new TextDecoder().decode(encode(id))).join(''));
  });
  vi.stubGlobal('fetch', transport);
  const fetcher = createModelDiscoveryFetcher(vi.fn());
  await Promise.all(Array.from({ length: 18 }, (_, i) => fetcher({ providerId: `p${i}` })));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(new URL(transport.mock.calls[0][0], 'http://localhost').searchParams.getAll('providerId')).toHaveLength(16);
});

it('bounds background catalogue streams without queuing providers within a stream, and cancels waiting scopes', async () => {
  const streams: Array<{ ids: string[]; stream: ReadableStreamDefaultController<Uint8Array> }> = [];
  const transport = vi.fn(async (input: string) => new Response(new ReadableStream({ start(stream) {
    streams.push({ ids: new URL(input, 'http://localhost').searchParams.getAll('providerId'), stream });
  } })));
  vi.stubGlobal('fetch', transport);
  const fetcher = createModelDiscoveryFetcher(vi.fn());
  const waiting = new AbortController();
  const scope = (projectId: string, signal?: AbortSignal) => ['a', 'b', 'c'].map(providerId =>
    fetcher({ providerId, projectId }, signal ? { signal } : undefined));
  const active = [...scope('first'), ...scope('second')];
  const queued = scope('third', waiting.signal);
  const rejected = Promise.all(queued.map(job => expect(job).rejects.toThrow('cancelled')));
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  expect(streams.map(item => item.ids)).toEqual([['a', 'b', 'c'], ['a', 'b', 'c']]);
  waiting.abort();
  await rejected;
  for (const { ids, stream } of streams) { ids.forEach(id => stream.enqueue(encode(id))); stream.close(); }
  await Promise.all(active);
  expect(transport).toHaveBeenCalledTimes(2);
});
