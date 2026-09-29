import { beforeEach, expect, it, vi } from 'vitest';
import type { ProductHttpContext } from '../../http/product-context.js';
import type { LibraryDoc } from '@zana-ai/zcc-domain/product';
const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), roots: vi.fn(), complete: vi.fn() }));
vi.mock('../../http/library-via-host.js', () => ({ listLibrarySnapshot: async (...args: unknown[]) => ({ docs: await mocks.list(...args), complete: mocks.complete() }), readLibraryDoc: mocks.read, authorizedLibraryRoots: mocks.roots }));
import { searchLibraryDocuments } from './library-search.js';
const rpc = vi.fn();
const ctx = { hostHub: { resolveHostId: (id: string) => id, callHostOnlineRpc: rpc } } as unknown as ProductHttpContext;
const doc = (id = 'one', patch: Partial<LibraryDoc> = {}): LibraryDoc => ({ id, relPath: `${id}.md`, absPath: `/owner/.zcc/library/${id}.md`, scope: 'project', projectId: 'p', title: id, kind: 'md', createdAt: 0, updatedAt: 0, ...patch });
beforeEach(() => {
  vi.resetAllMocks(); mocks.complete.mockReturnValue(true); mocks.list.mockResolvedValue([doc()]); mocks.read.mockResolvedValue({ ok: true, content: 'Body needle' });
  mocks.roots.mockReturnValue([{ scope: 'project', projectId: 'p', hostId: 'owner', root: '/owner/.zcc/library', anchor: '/owner' }]);
  rpc.mockResolvedValue({ sizeBytes: 11 });
});
it('returns stable identities, body line numbers and bounded snippets without reading metadata as content', async () => {
  mocks.list.mockResolvedValue([doc(), doc('code', { kind: 'code', absPath: '/owner/.zcc/library/one.md' })]);
  mocks.read.mockResolvedValueOnce({ ok: true, content: '---\ntitle: hidden\n---\nFirst\nneedle ' + 'x'.repeat(250) });
  const result = await searchLibraryDocuments(ctx, 'NeEdLe');
  expect(result.hits.map(hit => hit.docId)).toEqual(['one', 'code']);
  expect(result.hits[0]).toMatchObject({ line: 2, preview: expect.stringMatching(/…$/) }); expect(result.hits[0].preview).toHaveLength(201);
  expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'owner', command: { type: 'host.file_metadata', rootPath: '/owner', boundaryPath: '/owner/.zcc/library', path: '/owner/.zcc/library/one.md' } }));
  mocks.read.mockResolvedValue({ ok: true, content: '---\ntitle: hidden\n---\nBody' });
  mocks.list.mockResolvedValue([doc()]); expect((await searchLibraryDocuments(ctx, 'hidden')).hits).toEqual([]);
});
it('skips unsupported, missing, oversized and binary files, including files that grew during the read', async () => {
  mocks.list.mockResolvedValue([doc('pdf', { kind: 'pdf' }), doc('no-path', { absPath: undefined }), doc('no-root', { projectId: 'gone' }), doc('big'), doc('binary'), doc('growing'), doc('gone'), doc('match')]);
  rpc.mockResolvedValueOnce({ sizeBytes: 1024 * 1024 + 1 }).mockResolvedValueOnce({ sizeBytes: 10 }).mockResolvedValueOnce({ sizeBytes: 10 }).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'path_not_found' })).mockResolvedValue({ sizeBytes: 10 });
  mocks.read.mockResolvedValueOnce({ ok: false, binary: true }).mockResolvedValueOnce({ ok: true, content: 'x'.repeat(1024 * 1024 + 1) }).mockResolvedValue({ ok: true, content: 'needle' });
  expect((await searchLibraryDocuments(ctx, 'needle')).hits.map(hit => hit.docId)).toEqual(['match']);
});
it.each(['files', 'hits', 'bytes', 'time'])('bounds a search by %s and reports truncation', async kind => {
  mocks.list.mockResolvedValue(Array.from({ length: 1001 }, (_, index) => doc(String(index))));
  if (kind === 'files') mocks.read.mockResolvedValue({ ok: true, content: 'no match' });
  if (kind === 'bytes') mocks.read.mockResolvedValue({ ok: true, content: 'x'.repeat(1024 * 1024) });
  const result = await searchLibraryDocuments(ctx, 'needle', kind === 'time' ? Date.now() - 1 : Date.now() + 15_000);
  expect(result.truncated).toBe(true);
  expect(mocks.read).toHaveBeenCalledTimes(kind === 'files' ? 1000 : kind === 'hits' ? 500 : kind === 'bytes' ? 16 : 0);
});
it('handles empty queries without IO and identifies incomplete search results', async () => {
  expect(await searchLibraryDocuments(ctx, ' ')).toEqual({ hits: [], truncated: false }); expect(mocks.list).not.toHaveBeenCalled();
  rpc.mockRejectedValue(new Error('owner offline')); expect(await searchLibraryDocuments(ctx, 'needle')).toEqual({ hits: [], truncated: true });
  rpc.mockResolvedValue({ sizeBytes: 11 }); mocks.complete.mockReturnValue(false);
  expect(await searchLibraryDocuments(ctx, 'needle')).toMatchObject({ hits: [expect.objectContaining({ docId: 'one' })], truncated: true });
});
