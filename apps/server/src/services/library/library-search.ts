import type { LibrarySearchResult } from '@zana-ai/zcc-domain/product';
import type { HostFileMetadataResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { ProductHttpContext } from '../../http/product-context.js';
import { authorizedLibraryRoots, listLibrarySnapshot, readLibraryDoc } from '../../http/library-via-host.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { parseFrontMatter } from '../threads/host-library-tools.js';

/** Bounded body search of the same canonical documents displayed by clients. */
export async function searchLibraryDocuments(ctx: ProductHttpContext, query: string, deadline = Date.now() + 15_000): Promise<LibrarySearchResult> {
  const needle = query.trim().toLowerCase();
  const result: LibrarySearchResult = { hits: [], truncated: false };
  if (!needle) return result;
  const { docs, complete } = await listLibrarySnapshot(ctx, deadline);
  result.truncated = !complete;
  const roots = authorizedLibraryRoots(ctx);
  let scanned = 0, bytes = 0;
  for (const doc of docs) {
    if (doc.kind !== 'md' && doc.kind !== 'code') continue;
    if (++scanned > 1_000 || bytes >= 16 * 1024 * 1024 || Date.now() >= deadline) { result.truncated = true; break; }
    const root = roots.find(root => root.scope === doc.scope && root.projectId === doc.projectId);
    if (!root || !doc.absPath) continue;
    try {
      const meta = await ctx.hostHub.callHostOnlineRpc<HostFileMetadataResult>({ hostId: resolveProjectHost(ctx, root.hostId), timeoutMs: deadline - Date.now(), command: {
        type: 'host.file_metadata', rootPath: root.anchor, boundaryPath: root.root, path: doc.absPath
      } });
      if (meta.sizeBytes > 1024 * 1024) continue;
      const read = await readLibraryDoc(ctx, root.scope, doc.relPath, root.projectId, undefined, deadline);
      if (!read.ok || typeof read.content !== 'string') continue;
      const size = Buffer.byteLength(read.content); bytes += size;
      if (size > 1024 * 1024) continue;
      const body = doc.kind === 'md' ? parseFrontMatter(read.content)?.body ?? read.content : read.content;
      const lines = body.split('\n'), index = lines.findIndex(line => line.toLowerCase().includes(needle));
      if (index < 0) continue;
      const preview = lines[index].trim();
      result.hits.push({ docId: doc.id, absPath: doc.absPath, scope: doc.scope, line: index + 1, preview: preview.slice(0, 200) + (preview.length > 200 ? '…' : '') });
      if (result.hits.length >= 500) { result.truncated = true; break; }
    } catch (error) {
      if ((error as { code?: string }).code === 'path_not_found') continue;
      result.truncated = true; // Other owners remain searchable; never claim a complete result.
    }
  }
  return result;
}
