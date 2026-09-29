import { afterEach, expect, it, vi } from 'vitest';
import { product } from '../product-client.js';

afterEach(() => vi.unstubAllGlobals());
it.each([false, true])('uses the shared Library document endpoint in browser and desktop (desktop=%s)', async desktop => {
  const native = { library: { write: vi.fn(), read: vi.fn(), add: vi.fn() } };
  vi.stubGlobal('window', desktop ? { cc: native } : {});
  const fetch = vi.fn(async () => Response.json({ value: { ok: true, sha256: 'b'.repeat(64) } })); vi.stubGlobal('fetch', fetch);
  await product.library.write('project', 'note.md', 'updated', 'project-1', 'a'.repeat(64));
  const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body).toEqual({ action: 'write', scope: 'project', relPath: 'note.md', content: 'updated', projectId: 'project-1', expectedSha256: 'a'.repeat(64) });
  expect(native.library.write).not.toHaveBeenCalled();
  await product.library.add({ scope: 'global', relPath: 'new.md', title: 'New', content: 'text', source: { kind: 'agent', sessionId: 'forged' } });
  expect(JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ action: 'add', scope: 'global', relPath: 'new.md', title: 'New', content: 'text' });
  await product.library.update('doc', { title: 'Changed' }); await product.library.remove('doc');
  await product.library.createFolder('project', 'notes', 'project-1'); await product.library.search('needle');
  expect(JSON.parse((fetch.mock.calls[4] as unknown as [string, RequestInit])[1].body as string)).toEqual({ action: 'createFolder', scope: 'project', relPath: 'notes', projectId: 'project-1' });
  expect(JSON.parse((fetch.mock.calls[5] as unknown as [string, RequestInit])[1].body as string)).toEqual({ action: 'search', query: 'needle' });
  expect(fetch).toHaveBeenCalledTimes(6);
});
