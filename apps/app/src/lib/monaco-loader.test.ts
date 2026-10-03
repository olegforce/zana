import { expect, it, vi } from 'vitest';

const moduleLoaded = vi.hoisted(() => vi.fn());
vi.mock('./monacoSetup.js', () => {
  moduleLoaded();
  return { monaco: { editor: { create: vi.fn() } } };
});

it('defers Monaco until requested and shares concurrent first loads with the plugin host', async () => {
  const { loadHostMonaco } = await import('./monaco-loader.js');
  expect(moduleLoaded).not.toHaveBeenCalled();
  const one = loadHostMonaco();
  const two = loadHostMonaco();
  expect(two).toBe(one);
  const monaco = await one;
  expect(monaco.editor.create).toBeTypeOf('function');
  expect(moduleLoaded).toHaveBeenCalledOnce();
  expect(await (globalThis as any).__ZCC_LOAD_MONACO__()).toBe(monaco);
});

it('clears a failed single-flight load so opening the editor again can retry', async () => {
  vi.resetModules();
  vi.doMock('./monacoSetup.js', () => { throw new Error('chunk unavailable'); });
  const { loadHostMonaco } = await import('./monaco-loader.js');
  const failed = loadHostMonaco();
  expect(loadHostMonaco()).toBe(failed);
  await expect(failed).rejects.toThrow();
  // Replace the failed network/module fixture with an available chunk.
  vi.doMock('./monacoSetup.js', () => ({ monaco:{ editor:{ create:vi.fn() } } }));
  vi.resetModules();
  const retry = loadHostMonaco();
  expect(retry).not.toBe(failed);
  expect((await retry).editor.create).toBeTypeOf('function');
});
