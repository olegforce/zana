import { posix } from 'node:path';
import type { HostListDirResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';

/** Walk only the library, keeping the registered project as the confinement root. */
export async function listLibraryFiles(ctx: ProductHttpContext, hostId: string, root: string, prefix: string, deadline = Date.now() + 15_000): Promise<string[]> {
  const pending = [{ rel: prefix, depth: 0 }];
  const files: string[] = [];
  let directories = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++directories > 256 || current.depth > 32) throw new Error('Library listing exceeds its directory limit');
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Library listing timed out');
    let result: HostListDirResult;
    try {
      result = await ctx.hostHub.callHostOnlineRpc<HostListDirResult>({ hostId, timeoutMs, command: { type: 'host.list_dir', root, boundaryPath: posix.join(root, prefix), relPath: current.rel } });
    } catch (error) {
      if (directories === 1 && (error as { code?: string }).code === 'path_not_found') return [];
      throw error;
    }
    // Older daemons cap shallow listings at 2,000 without a continuation token.
    // Report an incomplete listing instead of silently returning partial state.
    if (result.entries.length >= 2000) throw new Error('Library directory is too large to list completely');
    for (const entry of result.entries) {
      if (!entry.name || /[/\\\x00-\x1f]/.test(entry.name) || entry.name === '.' || entry.name === '..') throw new Error('Invalid library entry');
      const rel = posix.join(current.rel, entry.name);
      if (entry.kind === 'dir') pending.push({ rel, depth: current.depth + 1 });
      else if (posix.relative(prefix, rel) !== 'index.json') files.push(posix.relative(prefix, rel));
      if (pending.length + files.length > 10_000) throw new Error('Library listing exceeds its entry limit');
    }
  }
  return files.sort();
}
