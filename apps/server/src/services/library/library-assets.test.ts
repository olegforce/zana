import { beforeEach, expect, it, vi } from 'vitest';
import type { ProductHttpContext } from '../../http/product-context.js';
const mocks = vi.hoisted(() => ({ roots: vi.fn(), recover: vi.fn(), resolve: vi.fn() }));
vi.mock('../../http/library-via-host.js', () => ({ authorizedLibraryRoots: mocks.roots }));
vi.mock('../../http/project-host.js', () => ({ resolveProjectHost: mocks.resolve }));
vi.mock('./remote-library-transaction.js', () => ({ recoverRemoteLibraryTransaction: mocks.recover }));
import { readLibraryAsset } from './library-assets.js';
const rpc = vi.fn(), emit = vi.fn();
const ctx = { dataDir: '/data', hostHub: { callHostOnlineRpc: rpc }, hub: { emit } } as unknown as ProductHttpContext;
const request = { action: 'asset' as const, scope: 'project' as const, projectId: 'p', relPath: 'image.png' };
beforeEach(() => {
  vi.resetAllMocks(); mocks.resolve.mockReturnValue('owner'); mocks.recover.mockResolvedValue(false);
  mocks.roots.mockReturnValue([{ scope: 'project', projectId: 'p', hostId: 'owner', anchor: '/original', root: '/original/.zcc/library', prefix: '.zcc/library' }, { scope: 'global', anchor: '/data', root: '/data/library', prefix: 'library' }]);
  rpc.mockResolvedValue({ content: 'AP8=', contentEncoding: 'base64', sizeBytes: 2 });
});
it('reads binary bytes on the fixed owner with the narrower Library boundary', async () => {
  expect(await readLibraryAsset(ctx, request)).toEqual({ ok: true, dataUrl: 'data:image/png;base64,AP8=', bytes: 2 });
  expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'owner', command: { type: 'host.read_path', rootPath: '/original', boundaryPath: '/original/.zcc/library', path: '/original/.zcc/library/image.png' } }));
  expect(mocks.resolve).toHaveBeenCalledWith(ctx, 'owner');
});
it.each([['a.PDF', 'application/pdf'], ['a.svg', 'image/svg+xml'], ['a.jpg', 'image/jpeg']])('encodes UTF-8 %s without corrupting its bytes', async (relPath, mime) => {
  const content = 'text ☀'; rpc.mockResolvedValue({ content, contentEncoding: 'utf8', sizeBytes: Buffer.byteLength(content) });
  mocks.recover.mockResolvedValue(true);
  expect(await readLibraryAsset(ctx, { action: 'asset', scope: 'global', relPath })).toEqual({ ok: true, dataUrl: `data:${mime};base64,${Buffer.from(content).toString('base64')}`, bytes: Buffer.byteLength(content) });
  expect(emit).toHaveBeenCalledWith('library:changed', { projectId: undefined });
});
it('rejects unauthorized scopes, traversal and executable types before IO', async () => {
  await expect(readLibraryAsset(ctx, { ...request, relPath: '../secret.png' })).rejects.toThrow();
  expect(await readLibraryAsset(ctx, { ...request, relPath: 'script.html' })).toMatchObject({ ok: false, message: expect.stringContaining('file type') });
  expect(await readLibraryAsset(ctx, { ...request, projectId: 'unregistered' })).toMatchObject({ ok: false, message: expect.stringContaining('not authorized') });
  expect(rpc).not.toHaveBeenCalled();
});
it('bounds encoded, declared and decoded bytes and checks the result size', async () => {
  for (const patch of [{ sizeBytes: 25 * 1024 * 1024 + 1 }, { content: 'a'.repeat(Math.ceil(25 * 1024 * 1024 / 3) * 4 + 1) }, { content: 'é'.repeat(13 * 1024 * 1024), contentEncoding: 'utf8' }]) {
    rpc.mockResolvedValue({ content: 'AP8=', contentEncoding: 'base64', sizeBytes: 2, ...patch });
    expect(await readLibraryAsset(ctx, request)).toMatchObject({ ok: false, message: expect.stringContaining('size limit') });
  }
  rpc.mockResolvedValue({ content: 'AP8=', contentEncoding: 'base64', sizeBytes: 9 });
  expect(await readLibraryAsset(ctx, request)).toMatchObject({ ok: false, message: 'Invalid Library asset size' });
});
it('returns displayable offline, conflict, unknown and deadline failures without local fallback', async () => {
  rpc.mockRejectedValue(new Error('Owner offline')); expect(await readLibraryAsset(ctx, request)).toEqual({ ok: false, message: 'Owner offline' });
  rpc.mockRejectedValue(null); expect(await readLibraryAsset(ctx, request)).toEqual({ ok: false, message: 'Library preview is unavailable' });
  rpc.mockClear(); expect(await readLibraryAsset(ctx, request, Date.now() - 1)).toEqual({ ok: false, message: 'Library preview timed out' }); expect(rpc).not.toHaveBeenCalled();
  mocks.recover.mockRejectedValue(new Error('conflicting journal')); expect(await readLibraryAsset(ctx, request)).toEqual({ ok: false, message: 'conflicting journal' });
});
