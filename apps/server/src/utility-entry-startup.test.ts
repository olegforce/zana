import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ prepare: vi.fn(), context: vi.fn() }));
vi.mock('./services/threads/thread-reads.js', async original => ({ ...await original<typeof import('./services/threads/thread-reads.js')>(), prepareThreadReads: h.prepare }));
vi.mock('./http/product-context.js', async original => ({ ...await original<typeof import('./http/product-context.js')>(), createProductHttpContext: h.context }));
vi.mock('./runtime-request-boundary.js', () => ({ dispatchRuntimeMessage: async (data: unknown, _reply: unknown, handler: (data: unknown) => Promise<void>) => handler(data) }));
vi.mock('@zana-ai/zcc-process-utils', async original => ({ ...await original<typeof import('@zana-ai/zcc-process-utils')>(), installRuntimeLog() {} }));
it('prepares indexed read markers before creating the utility server context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'utility-marker-startup-'));
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
  Object.defineProperty(process, 'parentPort', { configurable: true, value: parent });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  try {
    const pending = Promise.withResolvers<void>(); h.prepare.mockReturnValueOnce(pending.promise);
    h.context.mockImplementation(() => { throw Error('context checkpoint'); });
    await import('./utility-entry.js');
    parent.emit('message', { data: { type: 'start', dataDir: root, rendererRoot: root } });
    expect(h.prepare).toHaveBeenCalledWith(root); expect(h.context).not.toHaveBeenCalled();
    pending.resolve(); await vi.waitFor(() => expect(h.context).toHaveBeenCalledWith(expect.objectContaining({ dataDir: root })));
    parent.emit('message', { data: { type: 'stop' } });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  } finally {
    exit.mockRestore();
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor); else Reflect.deleteProperty(process, 'parentPort');
    await rm(root, { recursive: true, force: true });
  }
});
