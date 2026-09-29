import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { HOST_RPC_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/host-rpc';
import { enrollDaemonHost, HOST_ENROLL_TIMEOUT_MS } from './enroll.js';

afterEach(() => vi.useRealTimers());

const input = () => ({ serverUrl: 'https://shared.example/t/instance/', token: 'private-enrollment-token',
  hostName: 'My machine', hostId: randomUUID(), instanceId: randomUUID(), homeDir: '/private/checkout' });
const grant = (hostId: string) => ({ protocolVersion: HOST_RPC_PROTOCOL_VERSION, hostId, hostKey: 'k'.repeat(43) });

it('rejects a different machine identity before callers can persist its credentials', async () => {
  await expect(enrollDaemonHost({ ...input(), fetchFn: async () => Response.json(grant(randomUUID()), { status: 201 }) }))
    .rejects.toThrow('different machine');
});

it('does not follow enrollment redirects and bounds the whole request with a signal', async () => {
  const options = input();
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json(grant(options.hostId), { status: 201 }));
  await expect(enrollDaemonHost({ ...options, fetchFn })).resolves.toEqual(grant(options.hostId));
  expect(String(fetchFn.mock.calls[0]![0])).toBe('https://shared.example/t/instance/internal/hosts/enroll');
  expect(fetchFn.mock.calls[0]![1]).toMatchObject({
    redirect: 'error', signal: { aborted: false, addEventListener: expect.any(Function) },
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' }
  });
});

it.each([201, 503])('rejects oversized streamed enrollment responses (%s)', async status => {
  const options = input();
  const body = ' '.repeat(20 * 1024) + JSON.stringify(grant(options.hostId));
  const cancel = vi.fn();
  const stream = new ReadableStream({ start: controller => controller.enqueue(Buffer.from(body)), cancel });
  await expect(enrollDaemonHost({ ...options, fetchFn: async () => new Response(stream, { status }) })).rejects.toThrow('too large');
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['headers', 'body'])('aborts a stalled %s and releases the deadline timer', async phase => {
  vi.useFakeTimers();
  const options = input();
  const fetchFn: typeof fetch = async (_url, init) => {
    if (phase === 'headers') return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('{'));
      init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted body')), { once: true });
    } }), { status: 201 });
  };
  const result = expect(enrollDaemonHost({ ...options, fetchFn })).rejects.toThrow('Host enrollment timed out');
  await vi.advanceTimersByTimeAsync(HOST_ENROLL_TIMEOUT_MS);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['resolve', 'reject', 'stall'] as const)('cancels a body that ignores fetch abort even when source cancellation will %s', async outcome => {
  vi.useFakeTimers();
  const cancel = vi.fn(() => outcome === 'reject' ? Promise.reject(new Error('cancel failed')) :
    outcome === 'stall' ? new Promise<void>(() => {}) : Promise.resolve());
  const stream = new ReadableStream({ start: controller => controller.enqueue(Buffer.from('{')), cancel });
  const result = expect(enrollDaemonHost({ ...input(), fetchFn: async () => new Response(stream, { status: 201 }) }))
    .rejects.toThrow('Host enrollment timed out');
  await vi.advanceTimersByTimeAsync(HOST_ENROLL_TIMEOUT_MS);
  await result;
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a response delivered after the enrollment deadline', async () => {
  vi.useFakeTimers();
  let respond!: (response: Response) => void;
  const cancel = vi.fn();
  const stream = new ReadableStream({ cancel });
  const result = expect(enrollDaemonHost({ ...input(), fetchFn: () => new Promise(resolve => { respond = resolve; }) }))
    .rejects.toThrow('Host enrollment timed out');
  await vi.advanceTimersByTimeAsync(HOST_ENROLL_TIMEOUT_MS);
  respond(new Response(stream, { status: 201 }));
  await result;
  expect(cancel).toHaveBeenCalledOnce();
  expect(stream.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses the real HTTP client without following a same-origin enrollment redirect', async () => {
  const options = input(); let redirectedRequests = 0, redirect = true;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/redirected') redirectedRequests++;
    if (redirect && req.url !== '/redirected') res.writeHead(307, { location: '/redirected' }).end();
    else res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(grant(options.hostId)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(enrollDaemonHost({ ...options, serverUrl })).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
    redirect = false;
    await expect(enrollDaemonHost({ ...options, serverUrl })).resolves.toEqual(grant(options.hostId));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('does not expose credentials echoed in a remote error body', async () => {
  const options = input();
  const error = await enrollDaemonHost({ ...options, fetchFn: async () => new Response(`  denied\n ${options.token} ${'x'.repeat(500)}`, { status: 403 }) }).catch(error => error);
  expect(error.message).toBe('Failed to enroll daemon host: 403');
  expect(error.message).not.toContain(options.token);
  expect(error.message.length).toBeLessThan(250);
  await expect(enrollDaemonHost({ ...options, fetchFn: async () => new Response('', { status: 503 }) })).rejects.toThrow('Failed to enroll daemon host: 503');
});

it.each(['json', 'schema'])('does not expose response contents through a %s validation error', async mode => {
  const options = input();
  const body = mode === 'json' ? options.token : JSON.stringify({ ...grant(options.hostId), [options.token]: true });
  const error = await enrollDaemonHost({ ...options, fetchFn: async () => new Response(body, { status: 201 }) }).catch(error => error);
  expect(error.message).toBe('Invalid host enrollment response');
});

it.each([null, '', '{broken', JSON.stringify({ hostId: randomUUID() })])('rejects an invalid response body (%s)', async body => {
  await expect(enrollDaemonHost({ ...input(), fetchFn: async () => new Response(body, { status: 201 }) })).rejects.toThrow();
});

it('validates requests before fetching and clears timers after ordinary failures or success', async () => {
  vi.useFakeTimers();
  const options = input(), fetchFn = vi.fn<typeof fetch>();
  await expect(enrollDaemonHost({ ...options, hostId: 'not-a-uuid', fetchFn })).rejects.toThrow();
  expect(fetchFn).not.toHaveBeenCalled();
  fetchFn.mockRejectedValueOnce(new Error('network unavailable'));
  await expect(enrollDaemonHost({ ...options, fetchFn })).rejects.toThrow('network unavailable');
  const { hostId, homeDir: _homeDir, ...automatic } = options;
  fetchFn.mockResolvedValueOnce(Response.json(grant(hostId), { status: 201 }));
  await expect(enrollDaemonHost({ ...automatic, fetchFn })).resolves.toEqual(grant(hostId));
  expect(vi.getTimerCount()).toBe(0);
});
