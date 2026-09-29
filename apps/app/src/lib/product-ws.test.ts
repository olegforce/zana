// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  static failConstruct = false;
  readyState = 0;
  handlers = new Map<string, Array<(event?: any) => void>>();
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  constructor(readonly url: string) { if (Socket.failConstruct) throw new Error('unavailable'); Socket.instances.push(this); }
  addEventListener(type: string, callback: (event?: any) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), callback]); }
  emit(type: string, event?: unknown) { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  open() { this.readyState = 1; this.emit('open'); }
  message(value: unknown) { this.emit('message', { data: JSON.stringify(value) }); }
}
let stops: Array<() => void>;
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); Socket.instances = []; Socket.failConstruct = false; stops = []; });
afterEach(() => { stops.forEach(stop => stop()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('acknowledges renderer readiness only after the current product socket opens', async () => {
  const { subscribeProductWs, waitForProductWsOpen } = await import('./product-ws.js');
  stops.push(subscribeProductWs(() => {}));
  const ready = vi.fn();
  const waiting = waitForProductWsOpen().then(ready);
  await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  const old = Socket.instances[0]!;
  old.close(); await vi.advanceTimersByTimeAsync(1500);
  old.open(); await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  Socket.instances[1]!.open(); await waiting;
  expect(ready).toHaveBeenCalledOnce();
  await expect(waitForProductWsOpen()).resolves.toBeUndefined();
});
it('releases readiness waiters when the last product subscriber leaves', async () => {
  const { subscribeProductWs, waitForProductWsOpen } = await import('./product-ws.js');
  const stop = subscribeProductWs(() => {});
  const ready = vi.fn(); void waitForProductWsOpen().then(ready);
  stop();
  stops.push(subscribeProductWs(() => {}));
  Socket.instances[1]!.open(); await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
});
it('shares a socket, filters malformed frames and isolates subscriber failures', async () => {
  const { subscribeProductWs, subscribeProductEvent } = await import('./product-ws.js');
  const listener = vi.fn();
  stops.push(subscribeProductWs(() => { throw new Error('broken view'); }), subscribeProductEvent('changed', listener));
  expect(Socket.instances).toHaveLength(1);
  const socket = Socket.instances[0]!; socket.open();
  socket.emit('message', { data: 'bad' }); socket.message(null); socket.message({ type: 'pong' });
  socket.message({ type: 'changed', payload: 42 });
  expect(listener).toHaveBeenCalledExactlyOnceWith(42);
  stops.pop()!(); expect(socket.close).not.toHaveBeenCalled();
  stops.pop()!(); expect(socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('ignores late callbacks from an old socket and reloads only after reconnection', async () => {
  const { subscribeProductReconnect, subscribeProductEvent } = await import('./product-ws.js');
  const refresh = vi.fn(), update = vi.fn();
  stops.push(subscribeProductReconnect(refresh), subscribeProductEvent('changed', update));
  const old = Socket.instances[0]!; old.open(); expect(refresh).not.toHaveBeenCalled();
  old.close(); await vi.advanceTimersByTimeAsync(1500);
  const current = Socket.instances[1]!; current.open();
  expect(refresh).toHaveBeenCalledOnce();
  old.emit('close'); old.emit('error'); old.open(); old.message({ type: 'changed', payload: 'stale' });
  current.message({ type: 'changed', payload: 'fresh' });
  expect(update).toHaveBeenCalledExactlyOnceWith('fresh'); expect(current.close).not.toHaveBeenCalled();
});
it('detects a stalled open, missed heartbeat and send failures', async () => {
  const { subscribeProductWs } = await import('./product-ws.js');
  stops.push(subscribeProductWs(() => {}));
  await vi.advanceTimersByTimeAsync(16_500);
  expect(Socket.instances[0]!.close).toHaveBeenCalledOnce();
  const next = Socket.instances[1]!; next.open();
  await vi.advanceTimersByTimeAsync(25_000); expect(next.send).toHaveBeenCalledWith('{"type":"ping"}');
  next.message({ type: 'pong' });
  await vi.advanceTimersByTimeAsync(50_000); expect(next.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(26_500); expect(next.close).toHaveBeenCalledOnce();
  const last = Socket.instances[2]!; last.open(); last.send.mockImplementation(() => { throw new Error('offline'); });
  await vi.advanceTimersByTimeAsync(25_000); expect(last.close).toHaveBeenCalledOnce();
});
it('bounds reset reads to one active and one pending and cancels on disposal', async () => {
  const { subscribeProductReconnect } = await import('./product-ws.js');
  let complete!: () => void;
  const refresh = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const stop = subscribeProductReconnect(refresh); stops.push(stop);
  const socket = Socket.instances[0]!; socket.open();
  for (let i = 0; i < 30; i++) socket.message({ type: 'product:reset' });
  expect(refresh).toHaveBeenCalledOnce(); complete(); await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(2);
  socket.message({ type: 'product:reset' }); stop(); complete(); await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
it('retries constructor errors and contains read failures', async () => {
  const { subscribeProductReconnect } = await import('./product-ws.js');
  Socket.failConstruct = true;
  const refresh = vi.fn().mockRejectedValue(new Error('offline')); stops.push(subscribeProductReconnect(refresh));
  Socket.failConstruct = false; await vi.advanceTimersByTimeAsync(1500);
  const socket = Socket.instances[0]!; socket.open(); socket.message({ type: 'product:reset' });
  await Promise.resolve(); socket.message({ type: 'product:reset' }); await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(2);
});
