import { posix } from 'node:path';
import type { FsReadDataUrlResult } from '@zana-ai/zcc-domain/product';
import type { HostReadPathResult } from '@zana-ai/zcc-contracts/host-rpc';
import { LibraryDocumentRequestSchema, type LibraryDocumentRequest } from '@zana-ai/zcc-contracts/library-documents';
import type { ProductHttpContext } from '../../http/product-context.js';
import { authorizedLibraryRoots } from '../../http/library-via-host.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { libraryRootIo } from './library-root-io.js';
import { recoverRemoteLibraryTransaction } from './remote-library-transaction.js';
import { withProjectLibrary } from './project-library-queue.js';

const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_BYTES = 25 * 1024 * 1024;

/** Scope-addressed binary previews never use a desktop file: URL or a path on
 * the selected execution host. Data URLs have an opaque origin in PDF frames. */
export async function readLibraryAsset(ctx: ProductHttpContext, input: Extract<LibraryDocumentRequest, { action: 'asset' }>, deadline = Date.now() + 15_000): Promise<FsReadDataUrlResult> {
  const request = LibraryDocumentRequestSchema.parse(input) as typeof input;
  const mime = MIME[posix.extname(request.relPath).toLowerCase()];
  if (!mime) return { ok: false, message: 'This Library file type cannot be previewed' };
  const root = authorizedLibraryRoots(ctx).find(root => root.scope === request.scope && (root.scope === 'global' || root.projectId === request.projectId));
  if (!root) return { ok: false, message: 'Library root is not authorized' };
  try {
    const hostId = resolveProjectHost(ctx, root.hostId);
    return await withProjectLibrary(`${ctx.dataDir}:${root.projectId ?? 'global'}`, async () => {
      if (await recoverRemoteLibraryTransaction(libraryRootIo(ctx, hostId, root, deadline))) ctx.hub.emit('library:changed', { projectId: root.projectId });
      if (Date.now() >= deadline) throw new Error('Library preview timed out');
      const result = await ctx.hostHub.callHostOnlineRpc<HostReadPathResult>({ hostId, timeoutMs: deadline - Date.now(), command: {
        type: 'host.read_path', rootPath: root.anchor, boundaryPath: root.root, path: posix.join(root.root, request.relPath)
      } });
      if (result.sizeBytes > MAX_BYTES || result.content.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Library preview exceeds its size limit');
      if (Buffer.byteLength(result.content, result.contentEncoding) > MAX_BYTES) throw new Error('Library preview exceeds its size limit');
      const bytes = Buffer.from(result.content, result.contentEncoding);
      if (bytes.length > MAX_BYTES || bytes.length !== result.sizeBytes) throw new Error('Invalid Library asset size');
      return { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length };
    });
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Library preview is unavailable' }; }
}
