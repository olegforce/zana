import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import server from '../server.mjs';
const state = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
afterEach(() => vi.resetModules());
it('requires an enrolled machine for every read and mutation', async () => {
  const methods = new Map<string, (args?: any) => Promise<any>>(), call = vi.fn().mockResolvedValue({ awake: true });
  server({ rpc: { method: (id: string, fn: any) => methods.set(id, fn) }, host: { experimental_client: () => ({ call }) }, sdk: { hosts: { list: async () => [{ id: 'b', name: 'Second' }] }, system: { defaultHost: async () => null } } });
  expect(await methods.get('machines')!()).toEqual({ machines: [{ id: 'b', name: 'Second' }], primaryId: null });
  await expect(methods.get('status')!({ hostId: 'unknown' })).rejects.toThrow('registered');
  await expect(methods.get('set')!({ hostId: 'b', enable: 1 })).rejects.toThrow('whether');
  await methods.get('status')!({ hostId: 'b' }); await methods.get('set')!({ hostId: 'b', enable: true }); await methods.get('set')!({ hostId: 'b', enable: false });
  expect(call.mock.calls).toEqual([['status', null, { hostId: 'b' }], ['enable', null, { hostId: 'b' }], ['disable', null, { hostId: 'b' }]]);
});
it('keeps a worker lease while awake, shares pending starts and cleans up on disable and unload', async () => {
  const host = (await import('../host.mjs')).default;
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() }); state.spawn.mockReturnValue(child);
  const methods = new Map<string, (...args: any[]) => Promise<any>>(); let dispose!: () => void;
  host({ methods: { register: (id: string, fn: any) => methods.set(id, fn) }, lifecycle: { onDispose: (fn: () => void) => { dispose = fn; } } });
  const lease = { dispose: vi.fn() }, context = { experimental_retainWorker: vi.fn(() => lease) };
  const first = methods.get('enable')!(null, context), overlap = methods.get('enable')!(null, context);
  child.emit('spawn'); expect(await first).toEqual({ ok: true, awake: true }); expect(await overlap).toEqual(await first);
  expect(await methods.get('enable')!()).toEqual({ ok: true, awake: true });
  expect(await methods.get('status')!()).toEqual({ awake: true });
  await methods.get('disable')!(); expect(child.kill).toHaveBeenCalledOnce(); expect(lease.dispose).toHaveBeenCalledOnce();
  const next = methods.get('enable')!(null, context); child.emit('spawn'); await next;
  dispose(); expect(child.kill).toHaveBeenCalledTimes(2); expect(lease.dispose).toHaveBeenCalledTimes(2);
});
it('reports unavailable tools and releases the awake lease on natural exit', async () => {
  const host = (await import('../host.mjs')).default;
  const methods = new Map<string, (...args: any[]) => Promise<any>>();
  host({ methods: { register: (id: string, fn: any) => methods.set(id, fn) } });
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() }); state.spawn.mockReturnValue(child);
  const failed = methods.get('enable')!(); child.emit('error', new Error('not installed'));
  await expect(failed).rejects.toThrow('not installed'); expect(await methods.get('status')!()).toEqual({ awake: false });
  const lease = { dispose: vi.fn() }; const next = methods.get('enable')!(null, { experimental_retainWorker: () => lease });
  child.emit('spawn'); await next; child.emit('exit'); expect(lease.dispose).toHaveBeenCalledOnce(); expect(await methods.get('status')!()).toEqual({ awake: false });
});
