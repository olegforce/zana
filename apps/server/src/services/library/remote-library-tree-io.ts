import { posix } from 'node:path';
import { HostSnapshotPathResultSchema, type HostReadPathResult, type HostWriteFileResult, type HostRpcCommand } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import type { LibraryTreeIo } from './library-tree-transaction.js';

export function remoteLibraryTreeIo(ctx: ProductHttpContext, hostId: string, rootPath: string, prefix: string, deadline: number): LibraryTreeIo {
  const boundaryPath = posix.join(rootPath, prefix);
  const addressed = (relPath: string) => ({ rootPath, boundaryPath, path: posix.join(boundaryPath, relPath) });
  const call = <T>(command: HostRpcCommand): Promise<T> => {
    if (Date.now() >= deadline) throw new Error('Library tree operation timed out; pending work will be recovered on the next access');
    return ctx.hostHub.callHostOnlineRpc<T>({ hostId, command, timeoutMs: deadline - Date.now() });
  };
  return {
    snapshot: async path => HostSnapshotPathResultSchema.parse(await call({ type: 'host.snapshot_path', ...addressed(path) })).entries,
    read: path => call<HostReadPathResult>({ type: 'host.read_path', ...addressed(path) }),
    async create(path, body) {
      const result = await call<HostWriteFileResult>({ type: 'host.write_file', ...addressed(path), content: body.content, contentEncoding: body.contentEncoding, expectedSha256: null, createParents: true });
      if (result.outcome !== 'written') throw new Error('Library destination changed; existing bytes were preserved');
    },
    async mkdir(path) { await call({ type: 'host.mkdir', ...addressed(path), recursive: true }); },
    async remove(path, expectedSha256) { await call({ type: 'host.remove_path', ...addressed(path), recursive: false, expectedSha256 }); }
  };
}
