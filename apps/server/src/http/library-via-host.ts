import { collectLibrarySnapshot } from '../services/library/library-snapshot.js';
import { maintainLibraryTransfer } from '../services/library/library-transfer.js';
import { LibraryDocumentRequestSchema } from '@zana-ai/zcc-contracts/library-documents';
import { createHash } from 'node:crypto';
import { libraryRootIo } from '../services/library/library-root-io.js';
import { remoteLibraryIo } from '../services/library/remote-library-io.js';
import { recoverRemoteLibraryTransaction } from '../services/library/remote-library-transaction.js';
import { projectMetadataLocation } from '../services/projects/project-metadata.js';
import { listLibraryFiles } from '../services/library/list-library-files.js';
import { withProjectLibrary } from '../services/library/project-library-queue.js';
import { posix } from 'node:path';
import type { HostListFilesResult, HostReadFileResult, HostReadPathResult, HostWriteFileResult } from '@zana-ai/zcc-contracts/host-rpc';
import type { FsReadResult, LibraryDoc, LibraryDocKind, LibraryScope, QuickPrompt } from '@zana-ai/zcc-domain/product';
import { AmbiguousHostError, HostUnavailableError } from './host-hub.js';
import type { ProductHttpContext } from './product-context.js';
import { resolveProjectHost } from './project-host.js';

function kindFromExt(ext: string): LibraryDocKind {
  const lower = ext.toLowerCase();
  if (lower === '.md' || lower === '.markdown') return 'md';
  if (lower === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(lower)) return 'image';
  if ([
    '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
    '.sh', '.bash', '.zsh', '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.sql'
  ].includes(lower)) {
    return 'code';
  }
  return 'other';
}

function isSafeRelPath(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  const parts = normalized.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export interface LibraryRoot {
  root: string;
  anchor: string;
  prefix: string;
  scope: LibraryScope;
  projectId?: string;
  projectName?: string;
  hostId?: string;
}

export function authorizedLibraryRoots(ctx: ProductHttpContext): LibraryRoot[] {
  const roots: LibraryRoot[] = [{ root: `${ctx.dataDir}/library`, anchor: ctx.dataDir, prefix: 'library', scope: 'global' }];
  for (const project of ctx.toProjects()) {
    if (project.remote) continue;
    const owner = projectMetadataLocation(project);
    roots.push({
      root: `${owner.path}/.zcc/library`,
      anchor: owner.path,
      prefix: '.zcc/library',
      scope: 'project',
      projectId: project.id,
      projectName: project.name,
      hostId: owner.hostId
    });
  }
  return roots;
}

export function authorizedQuickPromptRoot(ctx: ProductHttpContext): string {
  return `${ctx.dataDir}/quick-prompts`;
}

function mapHostError(error: unknown): never {
  if (error instanceof HostUnavailableError) {
    throw Object.assign(new Error(error.message), { status: 503, code: 'host-unavailable' });
  }
  if (error instanceof AmbiguousHostError) {
    throw Object.assign(new Error(error.message), { status: 409, code: 'ambiguous-host' });
  }
  throw error;
}

async function listLibraryRootDocs(ctx: ProductHttpContext, meta: LibraryRoot, deadline: number): Promise<LibraryDoc[]> {
  try {
    const resolved = resolveProjectHost(ctx, meta.hostId);
    return await withProjectLibrary(`${ctx.dataDir}:${meta.projectId ?? 'global'}`, async () => {
      const io = libraryRootIo(ctx, resolved, meta, deadline);
      if (await recoverRemoteLibraryTransaction(io)) ctx.hub.emit('library:changed', { projectId: meta.projectId });
      const raw = await io.read('.zcc/library/index.json');
      const index = raw === null ? { docs: [] } : JSON.parse(raw);
      if (!index || !Array.isArray(index.docs) || index.docs.length > 10_000
        || index.docs.some((doc: unknown) => !doc || typeof doc !== 'object' || typeof (doc as LibraryDoc).relPath !== 'string')) throw new Error('Invalid library manifest');
      const indexed = new Map<string, LibraryDoc>(index.docs.map((doc: LibraryDoc) => [doc.relPath, doc]));
      const paths = await listLibraryFiles(ctx, resolved, meta.anchor, meta.prefix, deadline);
      return paths.map(relPath => {
        const entry = indexed.get(relPath);
        return {
          ...entry,
          id: entry?.id ?? `${meta.scope}:${meta.projectId ?? 'global'}:${relPath}`,
          relPath, title: entry?.title ?? posix.basename(relPath), kind: entry?.kind ?? kindFromExt(posix.extname(relPath)),
          createdAt: entry?.createdAt ?? 0, updatedAt: entry?.updatedAt ?? 0, bytes: entry?.bytes ?? 0, scope: meta.scope,
          absPath: posix.join(meta.root, relPath), projectId: meta.projectId, projectName: meta.projectName
        } as LibraryDoc;
      });
    });
  } catch (error) { mapHostError(error); }
}

export async function listLibraryDocs(ctx: ProductHttpContext, _hostId?: string, deadline = Date.now() + 15_000): Promise<LibraryDoc[]> {
  const docs: LibraryDoc[] = [];
  for (const root of authorizedLibraryRoots(ctx)) {
    const rows = await listLibraryRootDocs(ctx, root, deadline);
    if (docs.length + rows.length > 10_000) throw new Error('Library listing exceeds its document limit');
    docs.push(...rows);
  }
  return docs;
}

export async function listLibrarySnapshot(ctx: ProductHttpContext, deadline = Date.now() + 15_000) {
  try { await maintainLibraryTransfer(ctx, Math.min(deadline, Date.now() + 1_000)); } catch { /* marked roots report their pending recovery below */ }
  return collectLibrarySnapshot(authorizedLibraryRoots(ctx), root => listLibraryRootDocs(ctx, root, deadline), deadline);
}

export async function readLibraryDoc(
  ctx: ProductHttpContext,
  scope: LibraryScope,
  relPath: string,
  projectId?: string,
  hostId?: string,
  deadline = Date.now() + 15_000
): Promise<FsReadResult> {
  if (!LibraryDocumentRequestSchema.safeParse({ action: 'read', scope, relPath, projectId }).success) {
    return { ok: false, message: 'path escapes library root' };
  }
  const roots = authorizedLibraryRoots(ctx);
  const root = roots.find((row) =>
    row.scope === scope && (scope === 'global' ? true : row.projectId === projectId)
  );
  if (!root) return { ok: false, message: 'library root is not authorized' };
  try {
    const resolved = resolveProjectHost(ctx, root.hostId);
    return await withProjectLibrary(`${ctx.dataDir}:${projectId ?? 'global'}`, async () => {
      if (await recoverRemoteLibraryTransaction(libraryRootIo(ctx, resolved, root, deadline))) ctx.hub.emit('library:changed', { projectId });
      if (Date.now() >= deadline) throw new Error('Library read timed out');
      const result = await ctx.hostHub.callHostOnlineRpc<HostReadPathResult>({
        hostId: resolved, timeoutMs: deadline - Date.now(),
        command: { type: 'host.read_path', rootPath: root.anchor, boundaryPath: root.root, path: posix.join(root.root, relPath) }
      });
      if (result.contentEncoding !== 'utf8') return { ok: false as const, binary: true, message: 'Library document is not text' };
      return { ok: true as const, content: result.content, sha256: createHash('sha256').update(result.content).digest('hex') };
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'path_not_found') {
      return { ok: false, message: 'file not found' };
    }
    mapHostError(error);
  }
}

export async function writeLibraryDoc(
  ctx: ProductHttpContext, scope: LibraryScope, relPath: string, content: string,
  projectId?: string, _hostId?: string, expectedSha256?: string
): Promise<{ ok: true; sha256?: string; bytes?: number } | { ok: false; message: string }> {
  const { libraryDocumentOperation } = await import('../services/library/library-documents.js');
  try {
    return await libraryDocumentOperation(ctx, { action: 'write', scope, relPath, content, projectId, expectedSha256 }) as { ok: true; sha256: string; bytes: number };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}

export async function listQuickPrompts(ctx: ProductHttpContext, hostId?: string): Promise<QuickPrompt[]> {
  const root = authorizedQuickPromptRoot(ctx);
  let listed: HostListFilesResult;
  try {
    const resolved = resolveProjectHost(ctx);
    listed = await ctx.hostHub.callHostOnlineRpc<HostListFilesResult>({
      hostId: resolved,
      command: { type: 'host.list_files', roots: [root] }
    });
  } catch (error) {
    mapHostError(error);
  }
  const prompts: QuickPrompt[] = [];
  for (const file of listed.files) {
    if (file.kind !== 'file' || !file.relPath.endsWith('.json')) continue;
    if (!isSafeRelPath(file.relPath)) continue;
    try {
      const resolved = resolveProjectHost(ctx);
      const body = await ctx.hostHub.callHostOnlineRpc<HostReadFileResult>({
        hostId: resolved,
        command: { type: 'host.read_file', root, relPath: file.relPath }
      });
      const parsed = JSON.parse(body.content) as Partial<QuickPrompt>;
      if (typeof parsed.id === 'string' && typeof parsed.label === 'string' && typeof parsed.prompt === 'string') {
        prompts.push({
          id: parsed.id,
          label: parsed.label,
          prompt: parsed.prompt,
          profile: parsed.profile,
          icon: parsed.icon,
          arguments: parsed.arguments,
          source: 'user'
        });
      }
    } catch {
      /* skip malformed prompt files */
    }
  }
  return prompts;
}

export { isSafeRelPath };
