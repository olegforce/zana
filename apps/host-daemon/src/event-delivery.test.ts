import { afterEach, expect, it, vi } from 'vitest';
import { HOST_RPC_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/host-rpc';
import { createEventDelivery } from './event-delivery.js';
const id = '11111111-1111-4111-8111-111111111111';
const ack = (extra = {}) => ({ type: 'host.event-ack', protocolVersion: HOST_RPC_PROTOCOL_VERSION, batchId: id, accepted: 1, rejected: [], ...extra });
afterEach(() => vi.useRealTimers());
it('waits for a matching and complete acknowledgement', async () => {
  const delivery = createEventDelivery({ onTimeout: vi.fn() });
  const done = vi.fn(); const send = vi.fn();
  const pending = delivery.send(id, 1, send).then(done);
  await Promise.resolve(); expect(done).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  for (const invalid of [null, ack({ batchId: undefined }), ack({ accepted: 0 }), ack({ rejected: [{ index: 2, reason: 'invalid' }], accepted: 0 })]) expect(delivery.accept(invalid)).toBe(false);
  await expect(delivery.send(id, 1, send)).rejects.toThrow('already');
  expect(delivery.accept(ack())).toBe(true); await pending;
  expect(done).toHaveBeenCalledOnce(); expect(delivery.accept(ack())).toBe(false);
  delivery.cancel();
});
it('reports permanent server rejections and removes that batch', async () => {
  const onRejected = vi.fn(); const delivery = createEventDelivery({ onTimeout: vi.fn(), onRejected });
  const pending = delivery.send(id, 2, () => {});
  expect(delivery.accept(ack({ accepted: 0, rejected: [{ index: 0, reason: 'unknown_thread' }, { index: 0, reason: 'unknown_thread' }] }))).toBe(false);
  expect(delivery.accept(ack({ accepted: 0, rejected: [{ index: 0, reason: 'unknown_thread' }, { index: 1, reason: 'unknown_thread' }] }))).toBe(true);
  await pending; expect(onRejected).toHaveBeenCalledWith(['unknown_thread']);
});
it('cancels on timeout or disconnection and permits a later retry', async () => {
  vi.useFakeTimers(); const onTimeout = vi.fn(); const delivery = createEventDelivery({ onTimeout, timeoutMs: 10 });
  const timeout = expect(delivery.send(id, 1, () => {})).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(10); await timeout; expect(onTimeout).toHaveBeenCalledOnce();
  const closed = expect(delivery.send(id, 1, () => {})).rejects.toThrow('closed');
  delivery.cancel(); await closed; await vi.advanceTimersByTimeAsync(100); expect(onTimeout).toHaveBeenCalledOnce();
  await expect(delivery.send(id, 1, () => { throw new Error('send failed'); })).rejects.toThrow('send failed');
  await expect(delivery.send(id, 1, () => { throw 'bad'; })).rejects.toThrow('bad');
});
