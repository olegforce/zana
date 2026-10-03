import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { WebSocket } from 'ws';
import { createDataFrameQueue, LIMITS } from './protocol.mjs';
import * as protocol from './protocol.mjs';
import { createRelay } from './server.mjs';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function socket() {
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN, bufferedAmount: 0,
    send: vi.fn(), terminate: vi.fn()
  });
  const frames: { id: number; data: string }[] = [];
  const callbacks: ((error?: Error) => void)[] = [];
  ws.send.mockImplementation((text: string, callback: (error?: Error) => void) => {
    frames.push(JSON.parse(text)); callbacks.push(callback);
  });
  return { ws, frames, flush: (error?: Error) => callbacks.shift()!(error) };
}

it('bounds retained bytes and interleaves producers one frame at a time', async () => {
  const env = socket(); const queue = createDataFrameQueue(env.ws);
  const first = queue.write('request-data', 1, Buffer.alloc(3 * LIMITS.chunk), () => true);
  const second = queue.write('request-data', 2, Buffer.alloc(2 * LIMITS.chunk), () => true);
  expect(await queue.write('request-data', 3, Buffer.alloc(LIMITS.buffer), () => true)).toBe(false);
  expect(queue.retainedBytes()).toBe(5 * LIMITS.chunk);
  for (let n = 0; n < 5; n++) env.flush();
  expect(env.frames.map(frame => frame.id)).toEqual([1, 2, 1, 2, 1]);
  expect(await first).toBe(true); expect(await second).toBe(true);
  expect(queue.retainedBytes()).toBe(0); expect(env.ws.terminate).not.toHaveBeenCalled();
  queue.close();
});

it('bounds queued job count as well as bytes while the peer is stalled', async () => {
  const env = socket(); env.ws.bufferedAmount = LIMITS.buffer;
  const queue = createDataFrameQueue(env.ws);
  const pending = Array.from({ length: LIMITS.streams }, (_, id) => queue.write('request-data', id, Buffer.alloc(1), () => true));
  expect(await queue.write('request-data', 100, Buffer.alloc(1), () => true)).toBe(false);
  expect(queue.retainedBytes()).toBe(LIMITS.streams);
  queue.close();
  expect(await Promise.all(pending)).toEqual(Array(LIMITS.streams).fill(false));
  expect(queue.retainedBytes()).toBe(0);
});

it('releases cancelled and failed uploads and closes without retaining a socket listener', async () => {
  const env = socket(); const queue = createDataFrameQueue(env.ws);
  const first = queue.write('request-data', 1, Buffer.alloc(LIMITS.chunk * 2), () => true);
  const second = queue.write('request-data', 2, Buffer.alloc(LIMITS.chunk), () => true);
  queue.cancel(2); expect(await second).toBe(false);
  env.flush(new Error('failed')); expect(await first).toBe(false);
  expect(queue.retainedBytes()).toBe(0);
  const pending = queue.write('request-data', 3, Buffer.alloc(LIMITS.chunk), () => true);
  env.ws.emit('close'); expect(await pending).toBe(false);
  env.flush();
  expect(await queue.write('request-data', 4, Buffer.alloc(1), () => true)).toBe(false);
  expect(env.ws.listenerCount('close')).toBe(0);
});

it('waits below the hard socket cap, handles inactive and empty producers, and clears retries', async () => {
  vi.useFakeTimers();
  const env = socket(); const queue = createDataFrameQueue(env.ws);
  expect(await queue.write('request-data', 1, Buffer.alloc(0), () => true)).toBe(true);
  expect(await queue.write('request-data', 1, Buffer.alloc(1), () => false)).toBe(false);
  env.ws.bufferedAmount = LIMITS.buffer;
  let active = true;
  const pending = queue.write('request-data', 1, Buffer.alloc(1), () => active);
  expect(env.frames).toHaveLength(0);
  active = false; vi.advanceTimersByTime(10); expect(await pending).toBe(false);
  const next = queue.write('request-data', 2, Buffer.alloc(1), () => true);
  env.ws.bufferedAmount = 0; vi.advanceTimersByTime(10); env.flush(); expect(await next).toBe(true);
  env.ws.bufferedAmount = LIMITS.buffer;
  const closing = queue.write('request-data', 3, Buffer.alloc(1), () => true);
  queue.close(); expect(await closing).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

it('forwards a 16 MiB upload through a paused real peer and keeps concurrent reads connected', async () => {
  const relay = createRelay({ token: 'x'.repeat(43), publicUrl: 'https://relay.test', requestTimeoutMs: 10_000 });
  const server = createServer(relay.handleHttp); server.on('upgrade', relay.handleUpgrade);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_relay/connect`, { headers: {
    host: 'relay.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${'x'.repeat(43)}`
  } });
  try {
    await once(ws, 'open');
    let received = 0, reads = 0;
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'request-data') received += Buffer.from(frame.data, 'base64').length;
      if (frame.type === 'request' && frame.method === 'GET') reads++;
      if (frame.type === 'request-end') {
        ws.send(JSON.stringify({ type: 'response', id: frame.id, status: 200, headers: {} }));
        ws.send(JSON.stringify({ type: 'response-end', id: frame.id }));
      }
    });
    const call = (method: string, body?: Buffer) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, method, path: '/upload', headers: {
        host: 'relay.test', 'x-forwarded-proto': 'https', ...(body ? { 'content-length': body.length } : {})
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end(body);
    });
    ws.pause();
    const upload = call('POST', Buffer.alloc(16 * 1024 * 1024, 42));
    const read = call('GET');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(relay.connected()).toBe(true);
    ws.resume();
    expect(await read).toBe(200); expect(await upload).toBe(200);
    expect(received).toBe(16 * 1024 * 1024); expect(reads).toBe(1);
    expect(relay.connected()).toBe(true);
  } finally {
    ws.terminate(); relay.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15_000);

it('fails queue admission only for the uploading stream and leaves reads usable', async () => {
  // Queue bounds are tested above; exercise the HTTP failure seam with a
  // deterministic admission rejection rather than relying on network timing.
  vi.spyOn(protocol, 'createDataFrameQueue').mockReturnValue({
    write: vi.fn().mockResolvedValue(false), cancel: vi.fn(), close: vi.fn(), retainedBytes: () => 0
  });
  const relay = createRelay({ token: 'x'.repeat(43), publicUrl: 'https://relay.test' });
  const server = createServer(relay.handleHttp); server.on('upgrade', relay.handleUpgrade);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_relay/connect`, { headers: {
    host: 'relay.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${'x'.repeat(43)}`
  } });
  try {
    await once(ws, 'open');
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'request-end') {
        ws.send(JSON.stringify({ type: 'response', id: frame.id, status: 200, headers: {} }));
        ws.send(JSON.stringify({ type: 'response-end', id: frame.id }));
      }
    });
    const call = (method: string, body?: string) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, method, path: '/upload', headers: {
        host: 'relay.test', 'x-forwarded-proto': 'https'
      } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end(body);
    });
    expect(await call('POST', 'reject this upload')).toBe(503);
    expect(relay.connected()).toBe(true);
    expect(await call('GET')).toBe(200);
  } finally {
    ws.terminate(); relay.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
