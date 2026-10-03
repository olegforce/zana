import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ProductHttpClient } from './http.js';
import { waitForThreadEvent, waitForThreadStatus } from './wait.js';

afterEach(() => vi.useRealTimers());
it.each(['fetch', 'body', 'interactions', 'diagnostics', 'resolve'] as const)('bounds a stalled %s by the whole wait deadline', async stage => {
  vi.useFakeTimers();
  const pending = () => new Promise<never>(() => {});
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    signals.push(init!.signal!);
    const path = new URL(String(url)).pathname;
    if (stage === 'fetch') return pending();
    if (stage === 'body') return { text: pending } as unknown as Response;
    if (path.endsWith('/events')) return pending();
    if (path.endsWith('/resolve')) return pending();
    if (path.endsWith('/interactions')) {
      if (stage === 'interactions') return pending();
      return Response.json([{ id: 'approval' }]);
    }
    return Response.json({ thread: { id: 't', status: stage === 'diagnostics' ? 'error' : 'waiting' } });
  }) as unknown as typeof fetch;
  const http = new ProductHttpClient('http://127.0.0.1', { fetchImpl });
  const waiting = waitForThreadStatus(http, 't', { until: 'idle', timeoutMs: 100, onInteraction: stage === 'resolve' ? 'deny' : 'fail' });
  const assertion = expect(waiting).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(100); await assertion;
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.at(-1)!.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a real HTTP response with headers delivered but an unfinished body', async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const http = new ProductHttpClient(`http://127.0.0.1:${port}`);
    await expect(waitForThreadStatus(http, 't', { until: 'idle', timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('supports an explicit HTTP deadline and an already aborted caller without starting fetch', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(() => new Promise<never>(() => {})) as unknown as typeof fetch;
  const http = new ProductHttpClient('http://127.0.0.1', { fetchImpl });
  const controller = new AbortController(); controller.abort();
  await expect(http.request('GET', '/slow', { signal: controller.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(fetchImpl).not.toHaveBeenCalled();
  const waiting = http.request('GET', '/slow', { timeoutMs: 25 });
  const assertion = expect(waiting).rejects.toMatchObject({ code: 'TIMEOUT' });
  await vi.advanceTimersByTimeAsync(25); await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it('does not apply a status-wait deadline to the separate long-poll event API', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ type: 'turn/completed' })), 2000))) as unknown as typeof fetch;
  const http = new ProductHttpClient('http://127.0.0.1', { fetchImpl });
  const waiting = waitForThreadEvent(http, 't', { type: 'turn/completed', waitMs: 5000 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await waiting).toEqual({ type: 'turn/completed' });
  expect(vi.getTimerCount()).toBe(0);
});
