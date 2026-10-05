import { expect, it, vi } from 'vitest';
import { createStorageProxy } from '../storage-proxy';
it('awaits authenticated broker reads and committed writes without supplying an id', async () => {
  let complete!: () => void; const broker = vi.fn().mockResolvedValueOnce('value').mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const storage = createStorageProxy(broker); expect(await storage.get('key')).toBe('value'); let done = false; const write = storage.set('key', 'new').then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false); complete(); await write; expect(done).toBe(true);
  expect(broker.mock.calls).toEqual([['storage.get', ['key']], ['storage.set', ['key', 'new']]]);
});
it('propagates failed writes to the caller', async () => {
  const storage = createStorageProxy(vi.fn().mockRejectedValue(new Error('quota'))); await expect(storage.set('key', 'value')).rejects.toThrow('quota');
});
