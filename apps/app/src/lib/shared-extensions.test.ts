import { expect, it, vi } from 'vitest';
import type { ExtensionEntry } from '@zana-ai/zcc-domain/product';
import { sharedExtensions } from './shared-extensions.js';
it('projects actual owner inventory without loading native code or prompting for unavailable consent', async () => {
  const rows = [{ id: 'legacy', enabled: true, loaded: true, mainActive: true, needsConsent: 'new' }] as ExtensionEntry[];
  let changed!: (rows: ExtensionEntry[]) => void;
  const off = vi.fn(), callback = vi.fn();
  const owner = { list: vi.fn(async () => rows), onChanged: vi.fn(cb => { changed = cb; return off; }) };
  const api = sharedExtensions(owner);
  const result = await api.list();
  expect(result).toEqual([{ ...rows[0], loaded: false, mainActive: false, needsConsent: null }]);
  expect(rows[0].loaded).toBe(true);
  const stop = api.onChanged(callback); changed(rows); expect(callback).toHaveBeenCalledWith(result);
  changed([]); expect(callback).toHaveBeenLastCalledWith([]); stop(); expect(off).toHaveBeenCalledOnce();
  owner.list.mockRejectedValueOnce(new Error('offline')); await expect(api.list()).rejects.toThrow('offline');
});
