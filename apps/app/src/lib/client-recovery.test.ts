import { beforeEach, expect, it, vi } from 'vitest';
import { subscribeClientRecovery } from './client-recovery.js';
const callbacks = vi.hoisted(() => ({ reconnect: async () => {}, event: (_event: any) => {}, stop: vi.fn() }));
vi.mock('./product-ws.js', () => ({
  subscribeProductReconnect: (cb: any) => { callbacks.reconnect = cb; return callbacks.stop; },
  subscribeProductWs: (cb: any) => { callbacks.event = cb; return callbacks.stop; }
}));
const api = {
  projects: { list: vi.fn() }, inbox: { history: vi.fn() }, suggestions: { list: vi.fn() },
  saved: { list: vi.fn() }, terminals: { list: vi.fn() }
};
const apply = { projects: vi.fn(), inbox: vi.fn(), suggestions: vi.fn(), saved: vi.fn(), terminals: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks(); api.projects.list.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
  api.inbox.history.mockResolvedValue({ entries: [] }); api.suggestions.list.mockResolvedValue({ entries: [] });
  api.saved.list.mockResolvedValue([]); api.terminals.list.mockResolvedValue([]);
});
it('rehydrates empty results and confines terminal/inbox reads without replaying any writes', async () => {
  const stop = subscribeClientRecovery(api as any, apply, 'p1');
  await callbacks.reconnect();
  expect(api.inbox.history).toHaveBeenCalledExactlyOnceWith({ limit: 100, projectId: 'p1' });
  expect(api.terminals.list).toHaveBeenCalledExactlyOnceWith('p1');
  expect(apply.terminals).toHaveBeenCalledWith('p1', []);
  expect(apply.inbox).toHaveBeenCalledWith({ entries: [] }); stop(); expect(callbacks.stop).toHaveBeenCalledTimes(2);
});
it('never applies a stale snapshot after a live update or disposal', async () => {
  let resolve!: (value: any) => void;
  api.inbox.history.mockImplementation(() => new Promise(r => { resolve = r; }));
  const stop = subscribeClientRecovery(api as any, apply);
  const pending = callbacks.reconnect();
  callbacks.event({ type: 'inbox:updated', payload: {} }); resolve({ entries: ['old'] }); await pending;
  expect(apply.inbox).not.toHaveBeenCalled(); expect(apply.projects).toHaveBeenCalledOnce();
  const again = callbacks.reconnect(); stop(); resolve({ entries: ['late'] }); await again;
  expect(apply.inbox).not.toHaveBeenCalled();
});
it('isolates failed reads and does not let terminal output starve roster recovery', async () => {
  api.saved.list.mockRejectedValue(new Error('offline'));
  api.terminals.list.mockImplementation(async () => {
    callbacks.event({ type: 'shared:changed', payload: { channel: 'terminals:onData' } }); return [];
  });
  const stop = subscribeClientRecovery(api as any, apply); await callbacks.reconnect();
  expect(apply.terminals).toHaveBeenCalledTimes(2); expect(apply.inbox).toHaveBeenCalledOnce(); expect(apply.saved).not.toHaveBeenCalled(); stop();
});
