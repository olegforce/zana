import { searchLibraryDocuments } from './library-search.js';
import { maintainLibraryTransfer } from './library-transfer.js';
import { readLibraryAsset } from './library-assets.js';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { LibraryDocumentRequestSchema, LIBRARY_IMPORT_MAX_BYTES } from '@zana-ai/zcc-contracts/library-documents';
import type { HostFileMetadataResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { LibraryDoc, LibraryManifest } from '@zana-ai/zcc-domain/product';
import type { ProductHttpContext } from '../../http/product-context.js';
import { authorizedLibraryRoots, listLibraryDocs, listLibrarySnapshot, readLibraryDoc } from '../../http/library-via-host.js';
import { resolveProjectHost } from '../../http/project-host.js';
import { kindFromExt } from '../threads/host-library-tools.js';
import { withProjectLibrary } from './project-library-queue.js';
import { commitLibraryImport, commitRemoteLibraryTransaction, recoverRemoteLibraryTransaction } from './remote-library-transaction.js';
import { libraryRootIo } from './library-root-io.js';
import { commitLibraryTreeTransaction } from './library-tree-transaction.js';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const conflict = () => new Error('Library document changed. Read it again before saving.');

/** User document operations from authenticated HTTP or private desktop IPC.
 * Scope/IDs resolve against the product registry; callers never choose a host,
 * root or authorship. Agent tools retain their separate provenance restriction.
 */
export async function libraryDocumentOperation(ctx: ProductHttpContext, raw: unknown, deadline = Date.now() + 15_000): Promise<unknown> {
  const request = LibraryDocumentRequestSchema.parse(raw);
  if (request.action === 'move' && (request.from.scope !== request.to.scope || request.from.projectId !== request.to.projectId)) return maintainLibraryTransfer(ctx, deadline, request);
  // Bounded best-effort recovery keeps unrelated roots usable while a machine
  // is offline. Marked roots reject writes until their transfer is complete.
  try { await maintainLibraryTransfer(ctx, Math.min(deadline, Date.now() + 1_000)); } catch { /* snapshot exposes affected roots as unavailable */ }
  if (request.action === 'search') return searchLibraryDocuments(ctx, request.query, deadline);
  if (request.action === 'list') return listLibraryDocs(ctx, undefined, deadline);
  if (request.action === 'snapshot') return listLibrarySnapshot(ctx, deadline);
  if (request.action === 'read') return readLibraryDoc(ctx, request.scope, request.relPath, request.projectId, undefined, deadline);
  if (request.action === 'asset') return readLibraryAsset(ctx, request, deadline);
  const selected = request.action === 'update' || request.action === 'remove'
    ? request.location ? [{ ...request.location, id: request.id }]
      : (await listLibraryDocs(ctx, undefined, deadline)).filter(doc => doc.id === request.id) : null;
  if (selected && selected.length > 1) throw new Error('Ambiguous library identity');
  if (selected && !selected.length) return request.action === 'remove' ? false : null;
  const addressed = selected ? selected[0] : request.action === 'move' ? request.from : request as Extract<typeof request, { scope: unknown }>;
  const scope = addressed.scope ?? 'global', projectId = addressed.projectId, relPath = addressed.relPath;
  const root = authorizedLibraryRoots(ctx).find(row => row.scope === scope && (scope === 'global' || row.projectId === projectId));
  if (!root) throw new Error('Library root is not authorized');
  const hostId = resolveProjectHost(ctx, root.hostId);
  const io = libraryRootIo(ctx, hostId, root, deadline);
  return withProjectLibrary(`${ctx.dataDir}:${projectId ?? 'global'}`, async () => {
    const changed = () => ctx.hub.emit('library:changed', { projectId });
    if (await recoverRemoteLibraryTransaction(io)) changed();
    if (request.action === 'move' || request.action === 'deleteEntry') {
      await commitLibraryTreeTransaction(io, relPath, request.action === 'move' ? request.to.relPath : null);
      changed(); return { ok: true, path: posix.join(root.root, request.action === 'move' ? request.to.relPath : relPath) };
    }
    if (request.action === 'createFolder') {
      const path = posix.join(root.root, relPath);
      const mkdir = async (path: string, recursive: boolean) => {
        if (Date.now() >= deadline) throw new Error('Library operation timed out');
        await ctx.hostHub.callHostOnlineRpc({ hostId, timeoutMs: deadline - Date.now(), command: { type: 'host.mkdir', rootPath: root.anchor, boundaryPath: root.root, path, recursive } });
      };
      await mkdir(posix.dirname(path), true);
      await mkdir(path, false);
      changed(); return { ok: true, path };
    }
    const beforeIndex = await io.read('.zcc/library/index.json');
    const manifest: LibraryManifest = beforeIndex === null ? { version: 1, docs: [] } : JSON.parse(beforeIndex);
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.docs) || manifest.docs.length > 10_000 || manifest.docs.some(doc => !doc || typeof doc.id !== 'string' || typeof doc.relPath !== 'string')) throw new Error('Invalid library manifest');
    const matching = manifest.docs.filter(doc => doc.relPath === relPath);
    if (matching.length > 1) throw new Error('Ambiguous library path');
    const existing = matching[0];
    if (selected && existing?.id !== selected[0].id) throw conflict();
    const project = (doc: LibraryDoc): LibraryDoc => ({ ...doc, scope, projectId, projectName: root.projectName, absPath: posix.join(root.root, relPath) });
    if (request.action === 'import') {
      if (existing) throw new Error('Library document already exists');
      if (manifest.docs.length >= 10_000) throw new Error('Library manifest exceeds its document limit');
      const bytes = Buffer.from(request.base64, 'base64');
      if (bytes.length > LIBRARY_IMPORT_MAX_BYTES || bytes.toString('base64') !== request.base64) throw new Error('Invalid or oversized Library upload');
      const entry: LibraryDoc = { id: randomUUID(), relPath, title: posix.basename(relPath), kind: kindFromExt(posix.extname(relPath)),
        source: { kind: 'user' }, createdAt: Date.now(), updatedAt: Date.now(), bytes: bytes.length };
      await commitLibraryImport(io, relPath, bytes, entry);
      changed(); return project(entry);
    }
    if (request.action === 'update' || request.action === 'remove') {
      // Metadata-only edits do not rewrite document bytes (including PDFs).
      manifest.docs = manifest.docs.filter(doc => doc.relPath !== relPath);
      const next = existing && { ...existing, ...('patch' in request ? request.patch : {}), updatedAt: Date.now() };
      if (request.action === 'update' && next) manifest.docs.push(next);
      await io.write('.zcc/library/index.json', JSON.stringify(manifest), beforeIndex);
      changed(); return request.action === 'remove' ? true : next ? project(next) : null;
    }
    if (request.action === 'add' && request.content === undefined) {
      if (existing) throw new Error('Library document already exists');
      if (Date.now() >= deadline) throw new Error('Library operation timed out');
      let info: HostFileMetadataResult;
      try { info = await ctx.hostHub.callHostOnlineRpc<HostFileMetadataResult>({ hostId, timeoutMs: deadline - Date.now(), command: {
        type: 'host.file_metadata', rootPath: root.anchor, boundaryPath: root.root, path: posix.join(root.root, relPath)
      } }); }
      catch (error) { if ((error as { code?: string }).code === 'path_not_found') throw new Error('Pass content to create a library document'); throw error; }
      // Register an existing document, including binary files, without rewriting
      // any bytes or sending its entire content across the machine connection.
      const next: LibraryDoc = { id: randomUUID(), relPath, title: request.title, summary: request.summary, tags: request.tags,
        kind: kindFromExt(posix.extname(relPath)), source: { kind: 'user' }, createdAt: Date.now(), updatedAt: Date.now(), bytes: info.sizeBytes };
      if (manifest.docs.length >= 10_000) throw new Error('Library manifest exceeds its document limit');
      manifest.docs.push(next);
      await io.write('.zcc/library/index.json', JSON.stringify(manifest), beforeIndex);
      changed(); return project(next);
    }
    const before = await io.read(`.zcc/library/${relPath}`);
    if (request.action === 'write' && (before === null || hash(before) !== request.expectedSha256)) throw conflict();
    if (request.action === 'add' && (existing || (before !== null && request.content !== undefined))) throw new Error('Library document already exists');
    const content = request.content ?? before;
    if (content === null) throw new Error('Pass content to create a library document');
    if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new Error('Library document is too large');
    const next: LibraryDoc = { ...existing, id: existing?.id ?? randomUUID(), relPath,
      title: request.action === 'add' ? request.title : existing?.title ?? posix.basename(relPath),
      summary: request.action === 'add' ? request.summary : existing?.summary,
      tags: request.action === 'add' ? request.tags : existing?.tags,
      kind: kindFromExt(posix.extname(relPath)), source: existing?.source ?? { kind: 'user' },
      createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(), bytes: Buffer.byteLength(content) };
    await commitRemoteLibraryTransaction(io, { relPath, before, after: content, beforeEntry: existing ?? null, afterEntry: next });
    changed();
    return request.action === 'add' ? project(next) : { ok: true, bytes: next.bytes, sha256: hash(content) };
  }, JSON.stringify(request).length * 2);
}
