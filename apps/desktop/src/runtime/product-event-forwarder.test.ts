import { afterEach, expect, it, vi } from 'vitest';
import { createProductEventForwarder } from './product-event-forwarder.js';
afterEach(() => vi.useRealTimers());
it('keeps one IPC request in flight and preserves notification order', async () => {
  let resolve!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { resolve = r; })).mockResolvedValue(true);
  const forwarder = createProductEventForwarder(send);
  forwarder.publish('one', [1]); forwarder.publish('two', [2]); forwarder.publish('three', [3]);
  expect(send).toHaveBeenCalledOnce(); resolve();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(send.mock.calls).toEqual([['one', [1]], ['two', [2]], ['three', [3]]]); forwarder.dispose();
});
it.each([{ messages: 1, bytes: 1024 }, { messages: 100, bytes: 40 }])('replaces overflow with a bounded reset', async limits => {
  let resolve!: () => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { resolve = r; })).mockResolvedValue(true);
  const forwarder = createProductEventForwarder(send, limits);
  forwarder.publish('first', []);
  for (let i = 0; i < 100; i++) forwarder.publish('burst', [i]);
  resolve(); await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send).toHaveBeenLastCalledWith('product:reset', []);
  forwarder.publish('after', []); await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3)); forwarder.dispose();
});
it('recovers from failed IPC using only a reset and releases retries on shutdown', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(true);
  const forwarder = createProductEventForwarder(send);
  forwarder.publish('change', []); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1500);
  expect(send.mock.calls).toEqual([['change', []], ['product:reset', []]]);
  send.mockRejectedValue(new Error('down'));
  forwarder.publish('again', []); await Promise.resolve(); forwarder.dispose();
  forwarder.publish('late', []); await vi.advanceTimersByTimeAsync(3000);
  expect(send).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
});
it('handles unserializable payloads and disposal during a pending request', async () => {
  let resolve!: () => void;
  const send = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  const forwarder = createProductEventForwarder(send);
  forwarder.publish('bad', [1n]); expect(send).toHaveBeenCalledWith('product:reset', []);
  forwarder.publish('queued', []); forwarder.dispose(); resolve(); await Promise.resolve(); expect(send).toHaveBeenCalledOnce();
});
