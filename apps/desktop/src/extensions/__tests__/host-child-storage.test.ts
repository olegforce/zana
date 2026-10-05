import { EventEmitter } from 'node:events';
import module from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
// The real capability deprivation guard is verified in a child process. Never
// install it in the Vitest host; this test covers the bootstrap's storage wire.
vi.mock('../host-child-guard.js', () => ({ installChildBuiltinGuard() {}, denylistLoaderHookUrl: () => 'file:///unused' }));
it('waits for the authenticated storage acknowledgement before reporting the child ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-child-storage-'));
  const parent = new EventEmitter(), port = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn() });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const register = vi.spyOn(module, 'register').mockImplementation(() => undefined);
  Object.defineProperty(process, 'parentPort', { configurable: true, value: parent });
  try {
    const entry = join(root, 'main.mjs');
    await writeFile(entry, `export default { id: 'fixture', async setup(ctx) { await ctx.storage.set('key', 42); const value = await ctx.storage.get('key'); return { read: () => value }; } };`);
    await import('../host-child.js');
    parent.emit('message', { data: { type: 'zcc-port' }, ports: [port] });
    port.emit('message', { data: { type: 'init', moduleId: 'fixture', entryPath: entry } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'broker', method: 'storage.set', args: ['key', 42] })));
    expect(port.postMessage.mock.calls.some(([message]) => message.type === 'ready')).toBe(false);
    const set = port.postMessage.mock.calls.find(([message]) => message.method === 'storage.set')![0];
    port.emit('message', { data: { type: 'broker-result', reqId: set.reqId, ok: true } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'broker', method: 'storage.get' })));
    const get = port.postMessage.mock.calls.find(([message]) => message.method === 'storage.get')![0];
    port.emit('message', { data: { type: 'broker-result', reqId: get.reqId, ok: true, result: 42 } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready', moduleId: 'fixture', capabilities: ['read'] }));
    port.emit('message', { data: { type: 'call', callId: 1, capability: 'read', args: [] } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: 'result', callId: 1, ok: true, result: 42 }));
  } finally {
    register.mockRestore(); if (descriptor) Object.defineProperty(process, 'parentPort', descriptor); else Reflect.deleteProperty(process, 'parentPort');
    await rm(root, { recursive: true, force: true });
  }
});
