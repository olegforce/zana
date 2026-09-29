import { expect, it, vi } from 'vitest';
import type { ProductHttpContext } from './product-context.js';
import { mutateProjectFile } from './project-file-mutations.js';

function fixture() {
  const rpc = vi.fn(async () => ({ ok: true }));
  const ctx = { toProjects: () => [{ id: 'p', name: 'Shared', path: '/primary/repo', hostId: 'primary', sources: [{ id: 's', hostId: 'remote', path: '/remote/repo', createdAt: 1 }] }], hostHub: { resolveHostId: (id: string) => id, callHostOnlineRpc: rpc } } as unknown as ProductHttpContext;
  return { ctx, rpc, scope: { projectId: 'p', hostId: 'remote' } };
}
it('authorizes every operation on its selected source, never a renderer root', async () => {
  const { ctx, rpc, scope } = fixture(), path = '/remote/repo/a';
  for (const body of [
    { operation: 'write', content: 'updated', expectedSha256: 'a'.repeat(64) },
    { operation: 'create-file' }, { operation: 'create-dir' }, { operation: 'delete' },
    { operation: 'rename', destination: '/remote/repo/b' }
  ]) expect(await mutateProjectFile(ctx, { ...body, path, scope })).toMatchObject({ ok: true });
  expect(rpc.mock.calls.map(call => (call as any)[0])).toEqual([
    { hostId: 'remote', command: { type: 'host.write_file', path, rootPath: '/remote/repo', content: 'updated', contentEncoding: 'utf8', createParents: false, expectedSha256: 'a'.repeat(64) } },
    { hostId: 'remote', command: { type: 'host.write_file', path, rootPath: '/remote/repo', content: '', contentEncoding: 'utf8', createParents: false, expectedSha256: null } },
    { hostId: 'remote', command: { type: 'host.mkdir', path, rootPath: '/remote/repo', recursive: false } },
    { hostId: 'remote', command: { type: 'host.remove_path', path, rootPath: '/remote/repo', recursive: true } },
    { hostId: 'remote', command: { type: 'host.move_path', sourcePath: path, destinationPath: '/remote/repo/b', rootPath: '/remote/repo' } }
  ]);
});
it('rejects path escapes, root removal, wrong hosts, cross-source moves and unguarded writes before RPC', async () => {
  const { ctx, rpc, scope } = fixture();
  for (const input of [
    { operation: 'delete', path: '/remote/repo' }, { operation: 'delete', path: '/remote/repo/../other' },
    { operation: 'write', path: '/remote/repo/a', content: 'unguarded' },
    { operation: 'delete', path: '/primary/repo/a' },
    { operation: 'delete', path: '/remote/repo/a', rootPath: '/etc' },
    { operation: 'rename', path: '/remote/repo/a', destination: '/primary/repo/a' },
    { operation: 'rename', path: '/remote/repo/a', destination: '/remote/repo' },
    { operation: 'create-file', path: '/remote/repo/a\u0000' },
    { operation: 'delete', path: '/remote/repo/a', scope: { ...scope, hostId: 'unknown' } }
  ]) await expect(mutateProjectFile(ctx, { scope, ...input })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it('returns save conflicts without overwriting, and preserves explicit offline errors', async () => {
  const { ctx, rpc, scope } = fixture();
  const write = { operation: 'write', path: '/remote/repo/a', scope, content: 'new', expectedSha256: 'a'.repeat(64) };
  rpc.mockResolvedValueOnce({ outcome: 'conflict', currentSha256: 'b'.repeat(64) } as any);
  expect(await mutateProjectFile(ctx, write)).toMatchObject({ ok: false, message: expect.stringContaining('changed') });
  rpc.mockResolvedValueOnce({ outcome: 'conflict', currentSha256: 'b'.repeat(64) } as any);
  expect(await mutateProjectFile(ctx, { operation: 'create-file', path: write.path, scope })).toMatchObject({ ok: false, message: expect.stringContaining('already exists') });
  rpc.mockResolvedValueOnce({ outcome: 'written', sha256: 'c'.repeat(64), sizeBytes: 3 } as any);
  expect(await mutateProjectFile(ctx, write)).toMatchObject({ ok: true, sha256: 'c'.repeat(64) });
  rpc.mockRejectedValueOnce(new Error('Machine disconnected'));
  await expect(mutateProjectFile(ctx, write)).rejects.toThrow('Machine disconnected');
});
