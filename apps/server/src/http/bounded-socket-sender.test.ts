import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { boundedSocketSender } from './bounded-socket-sender.js';
import { createProductHub } from './product-hub.js';
afterEach(() => vi.useRealTimers());
function socket() { return Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() }); }
it('sends in order after congestion clears and cleans timers and aggregate budget', async () => {
  vi.useFakeTimers(); const ws = socket(), budget = { bytes: 0, limit: 100 }, dropped = vi.fn();
  const sender = boundedSocketSender(ws as unknown as WebSocket, budget, dropped);
  sender.send('first'); ws.bufferedAmount = 2 * 1024 * 1024;
  sender.send('second'); sender.send('third'); expect(ws.send.mock.calls).toEqual([['first']]);
  expect(budget.bytes).toBe(11);
  await vi.advanceTimersByTimeAsync(10); expect(ws.send).toHaveBeenCalledTimes(1);
  ws.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(10);
  expect(ws.send.mock.calls).toEqual([['first'], ['second'], ['third']]);
  expect(budget.bytes).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(dropped).not.toHaveBeenCalled();
  sender.dispose(); sender.send('ignored'); expect(ws.send).toHaveBeenCalledTimes(3);
});
it('enforces aggregate memory and per-client byte/message limits', () => {
  vi.useFakeTimers();
  for (const kind of ['aggregate', 'bytes', 'messages', 'oversize']) {
    const ws = socket(); ws.bufferedAmount = 2 * 1024 * 1024;
    const budget = { bytes: 0, limit: kind === 'aggregate' ? 4 : 32 * 1024 * 1024 };
    const sender = boundedSocketSender(ws as unknown as WebSocket, budget, vi.fn());
    if (kind === 'aggregate') sender.send('large');
    if (kind === 'bytes') { sender.send('a'.repeat(5 * 1024 * 1024)); sender.send('b'.repeat(5 * 1024 * 1024)); }
    if (kind === 'messages') for (let i = 0; i < 2049; i++) sender.send('');
    if (kind === 'oversize') sender.send('a'.repeat(8 * 1024 * 1024 + 1));
    expect(ws.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(budget.bytes).toBe(0); expect(vi.getTimerCount()).toBe(0);
  }
});
it.each([false, true])('cleans up a send failure, queued=%s', async queued => {
  vi.useFakeTimers(); const ws = socket(), budget = { bytes: 0, limit: 100 }, dropped = vi.fn();
  const sender = boundedSocketSender(ws as unknown as WebSocket, budget, dropped);
  ws.send.mockImplementation(() => { throw new Error('closed'); });
  if (queued) ws.bufferedAmount = 2 * 1024 * 1024;
  sender.send('a'); ws.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(10);
  expect(dropped).toHaveBeenCalledOnce(); expect(ws.close).toHaveBeenCalledWith(1013, 'product-send-failed');
  expect(budget.bytes).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])('disposes a closed socket without further writes, queued=%s', async queued => {
  vi.useFakeTimers(); const ws = socket(), budget = { bytes: 0, limit: 100 }, dropped = vi.fn();
  const sender = boundedSocketSender(ws as unknown as WebSocket, budget, dropped);
  if (queued) { ws.bufferedAmount = 2 * 1024 * 1024; sender.send('a'); }
  ws.readyState = 3; sender.send('b'); await vi.advanceTimersByTimeAsync(20);
  expect(ws.send).not.toHaveBeenCalled(); expect(dropped).toHaveBeenCalledOnce(); expect(budget.bytes).toBe(0);
});
it('caps product clients, deduplicates registration, and frees closed queues', () => {
  vi.useFakeTimers(); const hub = createProductHub(), sockets = Array.from({ length: 129 }, socket);
  for (const ws of sockets) { ws.bufferedAmount = 2 * 1024 * 1024; hub.add(ws as unknown as WebSocket); }
  hub.add(sockets[0] as unknown as WebSocket);
  expect(hub.size()).toBe(128); expect(sockets[128]!.close).toHaveBeenCalledWith(1013, 'product-client-limit');
  hub.emit('config:changed', {}); expect(vi.getTimerCount()).toBe(128);
  for (const ws of sockets) ws.emit('close');
  expect(hub.size()).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
