import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { HostReadPathResult, HostWriteFileResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import type { LibraryTransactionIo } from './remote-library-transaction.js';
import { remoteLibraryTreeIo } from './remote-library-tree-io.js';

export function remoteLibraryIo(ctx: ProductHttpContext, hostId: string, root: string, deadline = Date.now() + 15_000, prefix = '.zcc/library'): LibraryTransactionIo {
  const timeoutMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Library operation timed out');
    return remaining;
  };
  const boundary = (relPath: string) => {
    const prefix = relPath.startsWith('.zcc/library/') ? '.zcc/library' : relPath.startsWith('library/') ? 'library' : undefined;
    return prefix ? { boundaryPath: posix.join(root, prefix) } : {};
  };
  return {
    tree: remoteLibraryTreeIo(ctx, hostId, root, prefix, deadline),
    async documentHash(relPath) {
      try {
        const result = await ctx.hostHub.callHostOnlineRpc<HostReadPathResult>({ hostId, timeoutMs: timeoutMs(), command: {
          type: 'host.read_path', rootPath: root, ...boundary(relPath), path: posix.join(root, relPath)
        } });
        if (!/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error('Invalid Library document hash');
        return result.sha256;
      } catch (error) {
        if ((error as { code?: string }).code === 'path_not_found') return null;
        throw error;
      }
    },
    async read(relPath) {
      try {
        const result = await ctx.hostHub.callHostOnlineRpc<HostReadPathResult>({ hostId, timeoutMs: timeoutMs(), command: {
          type: 'host.read_path', rootPath: root, ...boundary(relPath), path: posix.join(root, relPath)
        } });
        if (result.contentEncoding !== 'utf8' || Buffer.byteLength(result.content) > 10 * 1024 * 1024) throw new Error('Library file is binary or too large');
        return result.content;
      } catch (error) {
        if ((error as { code?: string }).code === 'path_not_found') return null;
        throw error;
      }
    },
    async write(relPath, content, previous) {
      if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new Error('Library file exceeds the size limit');
      const result = await ctx.hostHub.callHostOnlineRpc<HostWriteFileResult>({ hostId, timeoutMs: timeoutMs(), command: {
        type: 'host.write_file', rootPath: root, ...boundary(relPath), path: posix.join(root, relPath), content,
        contentEncoding: 'utf8', createParents: true,
        expectedSha256: previous === null ? null : createHash('sha256').update(previous).digest('hex'),
        ...(['.zcc/library-transaction.json', 'library-transaction.json'].includes(relPath) ? { mode: 0o600 } : {})
      } });
      if (result.outcome !== 'written') throw Object.assign(new Error('Library changed concurrently. Read it again and retry.'), { code: 'library_conflict' });
    },
    async remove(relPath, previous) {
      await ctx.hostHub.callHostOnlineRpc({ hostId, timeoutMs: timeoutMs(), command: { type: 'host.remove_path', rootPath: root, ...boundary(relPath),
        path: posix.join(root, relPath), recursive: false, expectedSha256: createHash('sha256').update(previous).digest('hex') } });
    }
  };
}
