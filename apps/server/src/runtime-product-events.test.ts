import { expect, it, vi } from 'vitest';
import { forwardRuntimeProductEvent } from './runtime-product-events.js';
import { ServerRuntimeInboundSchema, SERVER_RUNTIME_PROTOCOL_VERSION } from '@zana-ai/zcc-contracts/runtime';
import { createProductEventForwarder } from '../../desktop/src/runtime/product-event-forwarder.js';
it('passes watcher and reset events through the actual private contract without blocking later settings notifications', async () => {
  const hub = { emit: vi.fn() };
  const send = vi.fn(async (channel: string, args: unknown[]) => {
    const message = ServerRuntimeInboundSchema.parse({ type: 'request', protocolVersion: SERVER_RUNTIME_PROTOCOL_VERSION,
      id: '00000000-0000-4000-8000-000000000001', deadlineAt: new Date(Date.now() + 20_000).toISOString(), operation: 'product-event', channel, args });
    if (message.type !== 'request' || message.operation !== 'product-event') throw new Error('Unexpected message');
    forwardRuntimeProductEvent(hub, message.channel, message.args);
  });
  const queue = createProductEventForwarder(send);
  try {
    queue.publish('library:changed', []); queue.publish('product:reset', []); queue.publish('config:onChanged', [{ theme: 'light' }]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(hub.emit.mock.calls).toEqual([['library:changed', {}], ['product:reset', {}], ['library:changed', {}], ['shared:changed', { channel: 'config:onChanged', args: [{ theme: 'light' }] }]]);
  } finally { queue.dispose(); }
});
it('invalidates every Library client from a watcher and from an event-queue reset', () => {
  const hub = { emit: vi.fn() };
  forwardRuntimeProductEvent(hub, 'library:changed', []);
  expect(hub.emit.mock.calls).toEqual([['library:changed', {}]]);
  hub.emit.mockClear(); forwardRuntimeProductEvent(hub, 'product:reset', []);
  expect(hub.emit.mock.calls).toEqual([['product:reset', {}], ['library:changed', {}]]);
  hub.emit.mockClear(); expect(() => forwardRuntimeProductEvent(hub, 'library:changed', [{ local: 'snapshot' }])).toThrow(); expect(hub.emit).not.toHaveBeenCalled();
});
it('preserves the other shared product events and their arguments', () => {
  const hub = { emit: vi.fn() };
  forwardRuntimeProductEvent(hub, 'goals:onChanged', [['shared-goal']]);
  expect(hub.emit).toHaveBeenCalledWith('shared:changed', { channel: 'goals:onChanged', args: [['shared-goal']] });
});
